# claude-memory

Standard memory schema for AI agents on Postgres + pgvector. Hybrid full-text
and vector search over a directory of atomic markdown files. Runs entirely on
infrastructure you already have — no SaaS dependency, no framework lock-in.

---

## What this is / what this is not

**What it is:** A Postgres schema and a set of Node scripts that turn a directory
of atomic markdown files into a hybrid-searchable memory store for AI agents. You
drop files in, run the loader, and agents can search by keyword or semantic
similarity. The scripts are plain Node — no build step, no framework.

**What it is not:** A framework, a hosted service, or a vector database product.
There is no LangChain dependency. No Pinecone account required. No vendor lock-in
beyond Postgres + pgvector + a local embedding server. If you already run Postgres,
the marginal cost to add this is a single `psql -f` command.

---

## Origin story

Forked from [pipeline](https://github.com/djwmobley/pipeline), a Claude Code plugin
where this memory infrastructure was first built and dogfooded as part of a 13-step
AI agent workflow engine. The `pipeline-*` filename prefixes in this repo are
intentional -- a spiritual callback to where the code was born. Pipeline still uses
this schema in-tree; a formal extraction to a shared package is on the backlog but
not yet done.

---

## What shipped in Bundle A

Bundle A is the substrate upgrade that brought the stack from a single-table
mxbai-only proof of concept to a production-grade retrieval system. Phases
shipped sequentially; all shipped via PRs to `main`.

| Phase | What it does |
|-------|-------------|
| **Phase 0** | Backfill: migrates the existing decisions corpus from `pipeline_pipeline.decisions` into `memory_entries` + `memory_entry_chunks` with `embedding = NULL`. |
| **Phase 1** | Embedder upgrade: replaces mxbai-embed-large (1024-dim) with Qwen/Qwen3-Embedding-8B via vLLM; stores embeddings as `halfvec(4000)` (Matryoshka truncation, HNSW-indexable at pgvector 0.8.1). Eval corpus expanded to 42 fixtures + 38 queries. |
| **Phase 2** | Schema expansion: adds `entities`, `assertions`, `edges`, `retrieval_contract`, `project_settings`, and `retrieval_events` tables for the knowledge graph and session-state layers. |
| **Phase 3a** | Cross-encoder reranker: opt-in `--rerank` flag for `eval-retrieval.js` backed by Qwen/Qwen3-Reranker-4B on vLLM. |
| **Phase 3b** | DB-persisted contextual blurbs: `memory_entry_chunks.blurb` column (qwen2.5:14b via Ollama); vLLM-native late chunking via `LATE_CHUNKING=1 EMBED_BACKEND=vllm`. |
| **Phase 3.5** | `/handoff` skill: seven Claude Code slash commands (`init`, `status`, `resume`, `close`, `checkpoint`, `drop`, `purge`) backed by `scripts/handoff.js` for cross-session memory continuity. |

For full design rationale, acceptance gates, and revision history see
[BUNDLE-A-SPEC.md](BUNDLE-A-SPEC.md).

---

## Roadmap

### Bundle A — Memory & Retrieval Foundation

| Phase | Title | Status |
|---|---|---|
| 0 | Decisions backfill | Shipped |
| 1 | Embedder upgrade + halfvec(4000) | Shipped |
| 2 | Knowledge graph schema | Shipped |
| 3a | Cross-encoder reranker | Shipped |
| 3b | Contextual blurbs + late chunking | Shipped |
| 3.5 | `/handoff` skill | Shipped |
| 3.6 | SessionStart loader hook | Shipped |
| 3.7 | Stop-hook safety net | Shipped |
| 3.8 | Schema portability + init hardening | In this PR |

### Beyond Bundle A (planned, undated)

- **Bundle B** — Outcome capture (writing `retrieval_events.outcome`), community detection (Leiden/Louvain over the entity graph), automated entity extraction over backfilled decisions, formal "writing down the bundle" methodology for `retrieval_contract` evolution.
- **Bundle E2** — Validator skill: 2% audit floor and validator subagent.
- **Bundle F** — Multi-workflow support: the current write path keeps one handoff summary and one active retrieval contract per project directory, so interleaving or shelving a second workflow silently displaces the first workflow's context (the stored facts remain but retrieval stops targeting them). Planned direction: per-workflow named handoff summaries and retrieval contracts, making the write path symmetric with the read path (which already resolves a contract by name). Dependency: same-subject supersession must carry workflow scope, or an unrelated task can supersede a shelved workflow's still-valid facts.

---

## Prerequisites

- **Postgres 14+** with pgvector **0.8.1 or later**
  (`CREATE EXTENSION vector;` in your target database).
  pgvector 0.8.1 is the minimum for `halfvec(4000)` HNSW indexes — earlier
  versions cannot index the 4000-dim column used in production.
- **Node 20+**
- **vLLM** (primary embedder path) — see [Native WSL install](#native-wsl-vllm-install--recommended-on-windows) in Gotchas for the
  step-by-step install on Windows 11 + WSL2. At minimum, launch the embedder:

  ```bash
  ~/.venv/vllm/bin/vllm serve Qwen/Qwen3-Embedding-8B \
    --runner pooling --port 8800 --gpu-memory-utilization 0.40
  ```

- **Ollama** (fallback embedder, required for blurb generation) with
  `qwen2.5:14b` pulled for blurbs (`ollama pull qwen2.5:14b`).
  mxbai-embed-large is the legacy fallback embedder; pull it only if you
  cannot run vLLM (`ollama pull mxbai-embed-large`).
- A database already created: `createdb your_db_name`

FTS still works if pgvector is absent. Vector columns and indexes are silently
skipped via DO blocks in `setup.sql`.

---

## Quickstart

```sh
# 1. Clone
git clone https://github.com/djwmobley/claude-memory.git
cd claude-memory

# 2. Install dependencies
cd scripts && pnpm install && cd ..

# 3. Apply base schema
psql -d your_db_name -f scripts/setup.sql

# 4. Apply handoff-core schema (portable — no extensions required)
node scripts/handoff.js init
# Apply app-specific schema (requires pgvector)
psql -d your_db_name -f scripts/sql/app-retrieval-events-schema.sql
psql -d your_db_name -f scripts/sql/phase3b-schema.sql

# 5. Configure (see Configuration section)
#    Create .claude/pipeline.yml in your project root.

# 6. Start vLLM embedder (WSL, separate terminal)
~/.venv/vllm/bin/vllm serve Qwen/Qwen3-Embedding-8B \
  --runner pooling --port 8800 --gpu-memory-utilization 0.40

# 7. Drop atomic markdown files into your memory directory
#    Each file needs YAML frontmatter (see Atomic file convention below).

# 8. Load, generate blurbs, and embed
node scripts/pipeline-memory-loader.js memory
node scripts/pipeline-embed.js blurbs
EMBED_BACKEND=vllm node scripts/pipeline-embed.js index

# 9. Search
node scripts/pipeline-embed.js hybrid "what is the routing rule for Opus?"
```

Example frontmatter for a memory file:

```yaml
---
name: routing-opus-rule
description: When Opus may and may not write directly to files
type: feedback
---

Opus orchestrates. Opus does not draft. If the task involves writing more
than one or two sentences of substantive content into a file or deliverable,
delegate to a Sonnet subagent. This rule has no exceptions for convenience
or time pressure.
```

---

## Configuration

Scripts read `.claude/pipeline.yml` from the project root. Production shape
after Bundle A Phase 1:

```yaml
project:
  name: your-project-name

knowledge:
  tier: postgres
  host: localhost
  port: 5432
  database: your_db_name
  user: your_pg_user
  embed_backend: vllm                          # vllm | ollama (default: ollama)
  vllm_embed_url: http://localhost:8800        # vLLM embedder endpoint
  embedding_model: Qwen/Qwen3-Embedding-8B    # model served by vLLM
```

To fall back to Ollama (mxbai-embed-large), omit `embed_backend` and
`vllm_embed_url`, and set `embedding_model: mxbai-embed-large`.

If you have no `pipeline.yml`, the standard `PG*` environment variables
(`PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER`, `PGPASSWORD`) are checked as a
fallback. See `scripts/lib/shared.js` for the exact fallback order.

**`HANDOFF_DB` env var:** `scripts/handoff.js` targets `claude_memory_eval_test` by default.
Set `HANDOFF_DB=your_db_name` to use a different database — useful when adopting the
`/handoff` skill in projects that already have a Postgres DB under a different name.
The env var is read at startup; it overrides the default and any `pipeline.yml` database
setting for handoff operations only.

**CRLF warning:** The YAML parser uses bare `\n`. On Windows, editors that
default to CRLF cause `loadConfig()` to silently fall back to defaults. Save
`pipeline.yml` with LF endings. See [Gotchas](#gotchas).

**handoff.md location and `.gitignore` recommendation.** The per-project
handoff state file lives outside the repository, under the user's Claude home
directory (`~/.claude/projects/<encoded-cwd>/handoff.md`), so it is not
committed by default. If you ever relocate handoff state into your repo tree,
add it to `.gitignore` — it can contain session summaries you may not want
in a public repository.

---

## Atomic file convention

Memory lives in a flat directory of `.md` files, each with YAML frontmatter:

```
memory/
  feedback_routing_rule.md
  project_auth_decision_2026-04-28.md
  user_hardware.md
  archive/
    old_feedback_v1.md    <-- soft-deleted; loader ignores this subdir
```

**Frontmatter fields:**

| Field | Required | Description |
|-------|----------|-------------|
| `name` | yes | Stable identifier used as the display label in search results |
| `description` | no | One-line summary; included in FTS |
| `type` | no | Category tag: `user`, `feedback`, `project`, `reference`, etc. |

**Naming convention:** `<type>_<slug>.md` or `<type>_<slug>_<date>.md` for
time-anchored memos. The loader does a flat `readdir` -- it does not recurse
into subdirectories. `archive/` is a natural soft-delete: move a file there to
hide it from the loader without deleting it.

---

## CLI reference

All commands run from the repo root with `node scripts/<script> <subcommand>`.

| Command | Description |
|---------|-------------|
| `node scripts/pipeline-memory-loader.js memory` | Load all files from the memory directory, compute content hashes, upsert rows, chunk text (1400-char ceiling) |
| `node scripts/pipeline-embed.js blurbs` | Generate contextual blurbs (qwen2.5:14b via Ollama) for chunks where `blurb IS NULL`. Idempotent. |
| `node scripts/pipeline-embed.js blurbs --all` | Regenerate blurbs for every chunk (overwrites existing). |
| `EMBED_BACKEND=vllm node scripts/pipeline-embed.js index` | Embed all unembedded chunks via vLLM. Reads blurb from DB and prepends before embedding. |
| `LATE_CHUNKING=1 EMBED_BACKEND=vllm node scripts/pipeline-embed.js index` | Same, but uses vLLM per-token pooling + client-side mean-pool for cross-chunk context (Phase 3b late chunking). |
| `node scripts/pipeline-embed.js index --all` | Force re-embed everything. |
| `node scripts/pipeline-embed.js hybrid "query"` | Hybrid search: FTS rank * 0.3 + cosine similarity * 0.7 |
| `node scripts/pipeline-embed.js search "query"` | Vector-only search (cosine similarity) |
| `node scripts/pipeline-embed.js stats` | Embedding coverage: how many chunks have embeddings vs. total |
| `PGUSER=postgres node test/eval/eval-retrieval.js` | Retrieval-quality regression (42 fixtures, 38 queries) |
| `PGUSER=postgres node test/eval/eval-retrieval.js --rerank` | Same with vLLM cross-encoder reranker (Phase 3a) |

**Standard operational sequence for a full corpus refresh:**

```sh
node scripts/pipeline-memory-loader.js memory   # load; blurbs and embeddings are NULL
node scripts/pipeline-embed.js blurbs           # fill NULL blurbs via qwen2.5:14b
EMBED_BACKEND=vllm node scripts/pipeline-embed.js index  # embed, reading blurbs from DB
```

See [/handoff skill install](#handoff-skill-install) for the handoff subcommands.

---

## Architecture

Eight tables and one view.

```
memory_entries          (one row per .md file)
  id, name, description, mem_type, body, source_file,
  content_hash, fts_vec tsvector

memory_entry_chunks     (one row per semantic chunk)
  id, entry_id -> memory_entries.id, chunk_idx, content,
  content_hash, embedding halfvec(4000), fts_vec tsvector,
  blurb TEXT (Phase 3b: qwen2.5:14b topic blurb; NULL until generated)

entities                (typed named entities; written at /handoff:close)
  id, project_id, name, entity_type, description, session_id

assertions              (S/P/O triples with 1-10 confidence + decay)
  id, project_id, subject, predicate, object, confidence,
  decay_rate, last_reinforced, source, session_id

edges                   (typed relationships between entities)
  id, project_id, from_entity, edge_type, to_entity, weight, session_id

retrieval_contract      (named retrieval plans for the SessionStart loader)
  id, project_id, name, queries JSONB

project_settings        (per-project key/value tunable config)
  project_id, key, value

retrieval_events        (log of every retrieval call; outcome written by Bundle B)
  id, project_id, query_text, query_embedding halfvec(4000),
  retrieved_at, outcome, session_id

v_memory_hits           (view: chunks joined with parent name)
  exposes: label (=name), snippet, content, embedding, fts_vec
```

Why a separate chunks table rather than chunking inline in `memory_entries`?
Long files must be split before embedding. The parent row stays intact for
display and sync; the chunk table holds the searchable units. CASCADE delete
keeps them in sync.

**Embedding column type:** `halfvec(4000)`. Qwen3-Embedding-8B outputs 4096
dims; the leading 4000 are stored (Matryoshka truncation). pgvector 0.8.1 caps
HNSW indexes at 4000 dims for `halfvec` and 2000 dims for `vector` — storing
4000 dims is what makes ANN indexing viable as the corpus grows. See
[Gotchas](#gotchas) for the `halfvec(4000)` migration pattern.

**Contextual blurbs (Phase 3b):** `memory_entry_chunks.blurb` is a ≤200-token
topic description generated by qwen2.5:14b. At embed time the blurb is
prepended to the chunk text before calling the embedder, giving the model
topic-anchored context that reduces cross-chunk co-reference loss. The blurb
is stored in the DB; the canonical chunk content is unchanged.

**Late chunking (Phase 3b):** When `LATE_CHUNKING=1 EMBED_BACKEND=vllm`, the
embedder requests per-token pooling over the full document text from vLLM,
then client-side mean-pools each chunk's token span. This preserves inter-chunk
context that is lost under standard pooled embedding.

**Hybrid scoring** (applied by `pipeline-embed.js`, not by Postgres):

```
score = ts_rank(fts_vec, query) * 0.3
      + (1 - embedding <=> query_vector) * 0.7
```

FTS catches exact keyword matches that vectors miss (proper nouns, version
strings, error codes). Vector search catches paraphrase and intent. The 70/30
split was tuned empirically on the project's memory store.

**Index choices:**

- HNSW (`halfvec_cosine_ops`) on `memory_entry_chunks.embedding`: O(log n)
  approximate nearest-neighbor. pgvector 0.8.1+ required for `halfvec` HNSW.
- GIN on `fts_vec` columns: standard for containment queries (`@@`).

---

## Limitations

- **Postgres only.** No SQLite backend, no Pinecone, no other vector DB.
- **vLLM is the production embedder.** Ollama + mxbai-embed-large is the
  fallback; it still works but produces 1024-dim embeddings in a `halfvec(4000)`
  schema column (the remaining 2976 dims will be zero-padded on insert, which
  degrades retrieval quality). Use vLLM for any new index build.
- **No tokenizer-aware chunking.** The chunker uses a 1400-character ceiling.
  It will not overrun the embedding model's context window, but chunks may be
  semantically awkward at boundaries. The `blurbs` step mitigates this for
  embedding quality; late chunking mitigates it further at the cost of a
  vLLM-native token-pooling call per entry.
- **No orphan pruning.** If you rename or delete a source file, the
  corresponding `memory_entries` row is not removed automatically.
- **No subdir recursion.** The loader does a flat `readdir`. Files nested inside
  subdirectories (other than the conventional `archive/`) are invisible to it.
- **No multi-database support.** One Postgres connection, one database.
- **Reranker precision gate is corpus-size-gated.** The `+5pp precision@5`
  acceptance gate for the Phase 3a reranker only fires when the corpus exceeds
  `project_settings.precision_at_5_gate_min_chunks` (default: 1000 chunks). On
  smaller corpora both vector-only and reranker modes saturate at 1.00 and the
  gate is recorded as SKIPPED.

---

## Gotchas

Environment issues discovered during Phase 1 bring-up on Windows 11
(WSL2 Ubuntu, RTX 3090).

**Docker Desktop pull pipeline on multi-GB images.** Docker Desktop 29.4.3 on
Windows 11 could not pull `vllm/vllm-openai` — three consecutive attempts
(latest tag and a pinned v0.20.2 tag) failed with
`httpReadSeeker: failed open ... EOF` on different blobs from
`production.cloudfront.docker.com`. Small images pulled fine. Workarounds: try
`regctl image copy` or `skopeo copy` (different HTTP client), pull from a
different network, or pivot to the native WSL install path (next item).

### Native WSL vLLM install — recommended on Windows

Instead of the Docker path, install vLLM directly inside WSL Ubuntu via uv:

```bash
# one-time inside WSL Ubuntu
curl -LsSf https://astral.sh/uv/install.sh | sh
~/.local/bin/uv venv --python 3.12 ~/.venv/vllm
source ~/.venv/vllm/bin/activate
uv pip install vllm
sudo apt-get install -y build-essential   # required for torch.compile JIT
```

Launch the embedder:

```bash
~/.venv/vllm/bin/vllm serve Qwen/Qwen3-Embedding-8B \
  --runner pooling --port 8800 --gpu-memory-utilization 0.40
```

Launch the reranker (separate terminal, Phase 3a):

```bash
~/.venv/vllm/bin/vllm serve Qwen/Qwen3-Reranker-4B \
  --runner pooling \
  --hf_overrides '{"architectures":["Qwen3ForSequenceClassification"],"classifier_from_token":["no","yes"],"is_original_qwen3_reranker":true}' \
  --chat-template scripts/qwen3_reranker.jinja \
  --port 8801 --gpu-memory-utilization 0.25
```

Notes:

- vLLM 0.20.x uses `--runner pooling`, not the older `--task embed`.
- `--convert embed` may be useful when converting a non-pooling base model.
- If `build-essential` is not installed, append `--enforce-eager` to bypass
  torch.compile (functional but slower).
- Ubuntu WSL ships Python 3.14 by default, which is too new for current vLLM
  wheels. uv handles this transparently by downloading CPython 3.12.
- **Reranker requires the `--hf_overrides` and `--chat-template` flags.** Without
  them vLLM loads it as a generic causal LM and rerank scores are near-uniform.

**Windows port preemption.** A pre-existing Windows-side Python process can
preempt a WSL port via WSL2's localhost forwarding, returning confusing 404s
even though vLLM is healthy inside WSL. Use non-default ports (`8800`, `18000`)
or check before starting:

```powershell
Get-NetTCPConnection -LocalPort 8800 -State Listen
```

**CRLF line endings break `loadConfig()`.** The YAML parser uses bare `\n`.
On Windows, `.claude/pipeline.yml` saved with CRLF causes `loadConfig` to
silently fall back to defaults (`database` resolves to `pipeline_<basename>`).
Fast fix: convert `pipeline.yml` to LF.

**NVIDIA Container Toolkit not enabled by default in Docker Desktop.** If you
use the Docker path, enable Docker Desktop → Settings → AI → "GPU-backed
inference". Without it, `docker run --gpus all` fails with
`nvidia-container-cli: libnvidia-ml.so.1: cannot open shared object file`.

**WSL GPU access can get stuck.** Symptom: `nvidia-smi` inside WSL returns
`Failed to initialize NVML: GPU access blocked by the operating system` while
the Windows host's `nvidia-smi` works. Fix: `wsl --shutdown` from PowerShell,
then re-enter WSL.

**pgvector HNSW dimension cap (4000 for halfvec, 2000 for vector).** pgvector
0.8.1 hard-caps HNSW indexes: `vector` accepts at most 2000 dims, `halfvec`
accepts at most 4000 dims. A `vector(4096)` column cannot have any HNSW index.
At small corpus sizes a sequential scan is acceptable, but ANN indexing is
required at scale.

The production fix is Matryoshka truncation: Qwen3-Embedding-8B is
Matryoshka-trained, so the first 4000 leading dims preserve semantic load. Store
as `halfvec(4000)`. Migration pattern for an existing `vector(4096)` column:

```sql
BEGIN;
DROP VIEW v_memory_hits;
ALTER TABLE memory_entry_chunks
  ALTER COLUMN embedding TYPE halfvec(4000)
  USING subvector(embedding, 1, 4000)::halfvec(4000);
CREATE INDEX mem_chunks_vec_idx
  ON memory_entry_chunks USING hnsw (embedding halfvec_cosine_ops);
\ir scripts/sql/v_memory_hits.sql
COMMIT;
```

At write time, slice before storing: `vec.slice(0, 4000)`, or set
`EMBED_DIMS=4000` and use the `vllmEmbed()` helper in `scripts/lib/shared.js`.

**Reranker precision@5 acceptance gate is corpus-size-gated.** See the
Limitations section. Configure the threshold:

```sql
INSERT INTO project_settings (project_id, key, value)
VALUES ('<encoded_cwd>', 'precision_at_5_gate_min_chunks', '1000')
ON CONFLICT (project_id, key) DO UPDATE SET value = EXCLUDED.value;
```

---

## `/handoff` skill install

The `/handoff` skill is a set of seven Claude Code slash commands that provide
cross-session memory continuity. The skill files live in `commands/handoff/` in
this repo. To install:

```bash
cp commands/handoff/*.md ~/.claude/commands/handoff/
```

After install, the following slash commands become available in any project that
has `scripts/handoff.js` on the walk-up path:

| Command | Description |
|---------|-------------|
| `/handoff:init` | First-run provisioning: schema, handoff.md, CLAUDE.md, default contract |
| `/handoff:status` | Read-only: counts, last close, contract names, session marker |
| `/handoff:resume` | Load prior session context regardless of staleness threshold |
| `/handoff:close` | End-of-session extraction: entities, assertions, edges, contract update |
| `/handoff:checkpoint` | Mid-session save without ending the session |
| `/handoff:drop` | Archive prior assertions (recoverable), start fresh handoff.md |
| `/handoff:purge` | Hard delete all project memory (confirmation required) |
| `/handoff:promote <id>` | Explicitly promote an assertion to CLAUDE.md durable facts |

The helper (`scripts/handoff.js`) does the heavy lifting. The Markdown command
files are thin recipes that announce `Running: handoff:<sub>` at start and
`Done: handoff:<sub> — <one-line>` at finish.

---

<a id="trust-model"></a>

### Trust model

> Full security policy, configuration-defaults exposure review, and payload
> validation details live in [SECURITY.md](SECURITY.md).

**Multi-author detection.** When `scripts/handoff.js init` or `scripts/handoff.js close`
is run, the helper runs `git log --format=%ae --since='1 year ago'` to count distinct commit
author emails over the last year of commits. If more than one author is detected, it writes a one-line notice to stderr:

```
[handoff] multi-author repo detected — see README#trust-model before relying on CLAUDE.md auto-promotion
```

This notice is advisory. No behavior changes today when it fires: context injection,
assertion storage, and CLAUDE.md promotion all work exactly as they do on single-author
repos. The flag (`multi_author_detected = true` in `project_settings`) is available for
future policy gates. The intent is to surface the condition once per invocation so you can
decide whether the auto-promotion path is appropriate for your threat model.

**Auto-promotion is off by default.** Promotion of high-confidence assertions (`confidence >= 9`,
`source = user_stated`, reinforced across multiple sessions) to the `## Durable facts`
section of `CLAUDE.md` happens **only** when the `/handoff:close` payload explicitly
sets `confirm_claude_md_promotion: true`. When that flag is absent or `false`, the tool
prints the candidate list to the console and writes nothing to disk. The `/handoff:close`
skill also instructs the assistant to ask the user for confirmation before any CLAUDE.md
write, and its example payload defaults the flag to `false`. The `/handoff:promote <assertion_id>`
command is the explicit single-assertion path for promoting individual assertions after manual
inspection. Every promotion — payload-flag or explicit — writes an HTML comment audit annotation
(`<!-- promoted: session=..., conf=..., date=..., source_assertion=... -->`) immediately before
the fact line, so the provenance of each entry in `## Durable facts` is traceable.
For the full exposure review, including the residual risk on a public multi-author repo,
see [SECURITY.md](SECURITY.md).

---

## Testing

Three harnesses cover different layers.

**`scripts/test-chunker.js`** — structural correctness. Six scenarios: chunk
boundary rules, idempotence via content_hash, partial-failure resilience, and
an end-to-end round-trip (loader → DB → embed → hybrid retrieval). Set
`OLLAMA_SKIP=1` to skip embed-dependent assertions.

```bash
PROJECT_ROOT=$(pwd) node scripts/test-chunker.js
```

**`test/handoff/test-handoff.js`** — golden-path tests for the `/handoff` skill
helper. Runs each subcommand against `claude_memory_eval_test` with a temporary
`project_id` and asserts row counts and file contents. Requires Phase 2 schema
applied first.

```bash
node test/handoff/test-handoff.js
```

**`test/eval/eval-retrieval.js`** — retrieval-quality regression. 42 synthetic
fixture markdown files in `test/eval/fixtures/`, 38 hand-labeled queries in
`test/eval/queries.json` with expected top-1 / top-3 hits and negative
constraints. Computes recall@1, recall@3 (relaxed), MRR, negative precision.
Asserts each metric stays within 5% of the committed baseline at
`test/eval/baseline.json`. Negative precision is strict (== 1.0).

One-time setup:

```bash
psql -U postgres -c "CREATE DATABASE claude_memory_eval_test"
psql -U postgres -d claude_memory_eval_test -f scripts/setup.sql
node scripts/handoff.js init                # applies handoff-core-schema.sql
psql -U postgres -d claude_memory_eval_test -f scripts/sql/app-retrieval-events-schema.sql
psql -U postgres -d claude_memory_eval_test -f scripts/sql/phase3b-schema.sql
```

Run:

```bash
PGUSER=postgres node test/eval/eval-retrieval.js
```

With Phase 3a reranker:

```bash
PGUSER=postgres node test/eval/eval-retrieval.js --rerank
```

To accept a real improvement as the new baseline:

```bash
PGUSER=postgres node test/eval/eval-retrieval.js --update-baseline
```

The harness writes `test/eval/last-run.json` (gitignored) with per-query
results for debugging. Adding a new query: append to `queries.json`, label
expected hits by reading the relevant fixture, then `--update-baseline`. Adding
a new fixture: drop a markdown file in `test/eval/fixtures/` with frontmatter
(`name`, `description`, `type`); the harness loads everything in that
directory.

CI runs the eval harness in `--ollama-skip` mode (smoke test for the SQL and
loader path; vector-quality regression detection requires running locally with
vLLM or Ollama).

> **CI footgun warning.** `.github/workflows/test.yml` runs on every PR with
> `OLLAMA_SKIP=1`. It exercises the SQL, loader, and schema paths, but **skips
> all vector-quality and embedding regression detection**. A green CI run does
> **not** mean retrieval quality is unregressed. Maintainers must run the full
> harness locally (with Ollama or vLLM available) to catch retrieval-quality
> regressions before relying on a change.

---

## Maintenance posture

This repo is shared in good faith but is not a maintained open-source product.
There are no SLAs on issue response, no roadmap commitment, and no guarantee of
backward-compatible schema migrations between versions. The author uses this code
daily in pipeline, so basic correctness is likely to stay current. Feature
requests are unlikely to be prioritized unless they align with pipeline's own
needs.

If you fork this and it works for you, great. If something breaks, you will need
to fix it yourself or wait. The schema is small enough to understand in an
afternoon.

---

## License

MIT. See [LICENSE](LICENSE).
