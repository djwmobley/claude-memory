# claude-memory

The standard memory schema for AI agents on Postgres + pgvector + Ollama.

Lightweight, no framework lock-in, no SaaS dependency. Hybrid full-text and
vector search over a directory of atomic markdown files. Runs entirely on
infrastructure you already have.

---

## What this is / what this is not

**What it is:** A Postgres schema and a set of Node scripts that turn a directory
of atomic markdown files into a hybrid-searchable memory store for AI agents. You
drop files in, run the loader, and agents can search by keyword or semantic
similarity. The schema is two tables and one view. The scripts are plain Node --
no build step, no framework.

**What it is not:** A framework, a hosted service, or a vector database product.
There is no LangChain dependency. No Pinecone account required. No vendor lock-in
beyond Postgres + pgvector + Ollama (or any embedder you wire in yourself). If you
already run Postgres, the marginal cost to add this is a single `psql -f` command.

---

## Origin story

Forked from [pipeline](https://github.com/djwmobley/pipeline), a Claude Code plugin
where this memory infrastructure was first built and dogfooded as part of a 13-step
AI agent workflow engine. The `pipeline-*` filename prefixes in this repo are
intentional -- a spiritual callback to where the code was born. Pipeline still uses
this schema in-tree; a formal extraction to a shared package is on the backlog but
not yet done.

---

## Prerequisites

- Postgres 14+ with the pgvector extension installed
  (`CREATE EXTENSION vector;` in your target database)
- Node 20+
- Ollama running locally with `mxbai-embed-large` pulled:
  `ollama pull mxbai-embed-large`
- A database already created: `createdb your_db_name`

The scripts degrade gracefully if pgvector is absent -- FTS still works, vector
columns and indexes are silently skipped.

---

## Quickstart

```sh
# 1. Clone
git clone https://github.com/djwmobley/claude-memory.git
cd claude-memory

# 2. Install dependencies (scripts/ has its own package.json)
cd scripts && pnpm install && cd ..

# 3. Create the schema
psql -d your_db_name -f scripts/setup.sql

# 4. Configure (see Configuration section)
#    Create .claude/pipeline.yml in your project root.

# 5. Drop atomic markdown files into your memory directory
#    Each file needs YAML frontmatter (see Atomic file convention below).

# 6. Load and embed
node scripts/pipeline-memory-loader.js memory

# 7. Search
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

Another example (a project note with a date suffix):

```yaml
---
name: auth-decision-2026-04-28
description: Decision to use JWT over session cookies for stateless agents
type: project
---

Chose JWT because agents are stateless and session state on the server adds
coordination overhead. Cookie-based sessions require sticky routing or a
shared session store -- neither is acceptable for the current architecture.
```

---

## Configuration

The loader and embed scripts inherit pipeline's config-loading convention. They
read a `pipeline.yml` file from the project root (or `.claude/pipeline.yml`).
Relevant section:

```yaml
knowledge:
  tier: postgres          # postgres | none
  host: localhost
  port: 5432
  database: your_db_name
  user: your_pg_user
  embedding_model: mxbai-embed-large   # Ollama model name
  num_ctx: 8192           # Ollama context window
```

If you are not running pipeline and do not have a `pipeline.yml`, you can set
the standard `PG*` environment variables (`PGHOST`, `PGPORT`, `PGDATABASE`,
`PGUSER`, `PGPASSWORD`) as a fallback -- check `scripts/lib/shared.js` for the
exact fallback order.

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
time-anchored memos. The loader does a flat `readdir` on the memory directory --
it does not recurse into subdirectories. This makes `archive/` a natural
soft-delete convention: move a file there to hide it from the loader without
deleting it.

---

## CLI reference

All commands run from the repo root with `node scripts/<script> <subcommand>`.

| Command | Description |
|---------|-------------|
| `node scripts/pipeline-memory-loader.js memory` | Load all files from the memory directory, compute content hashes, upsert rows, embed pending chunks |
| `node scripts/pipeline-embed.js index` | Backfill embeddings for any chunks that have no embedding yet |
| `node scripts/pipeline-embed.js hybrid "query"` | Hybrid search: FTS rank * 0.3 + cosine similarity * 0.7 |
| `node scripts/pipeline-embed.js search "query"` | Vector-only search (cosine similarity) |
| `node scripts/pipeline-embed.js stats` | Embedding coverage: how many chunks have embeddings vs. total |

---

## Architecture

Two tables, one view.

```
memory_entries          (one row per .md file)
  id, name, description, mem_type, body, source_file,
  content_hash, embedding vector(1024), fts_vec tsvector

memory_entry_chunks     (one row per semantic chunk of a memory file)
  id, entry_id -> memory_entries.id, chunk_idx, content,
  content_hash, embedding vector(1024), fts_vec tsvector

v_memory_hits           (view: chunks joined with parent name)
  projects memory_entry_chunks JOIN memory_entries
  exposes: label (=name), snippet, content, embedding, fts_vec
```

Why a separate chunks table rather than chunking inline in memory_entries?
Embedding models have fixed context windows (~512 tokens for mxbai-embed-large).
Long files must be split before embedding. The parent row stays intact for
display and sync; the chunk table holds the searchable units. CASCADE delete
keeps them in sync.

**Hybrid scoring** (applied by `pipeline-embed.js`, not by Postgres):

```
score = ts_rank(fts_vec, query) * 0.3
      + (1 - embedding <=> query_vector) * 0.7
```

FTS catches exact keyword matches that vectors miss (proper nouns, version strings,
error codes). Vector search catches paraphrase and intent. The 70/30 split was
tuned empirically on pipeline's memory store.

**Index choices:**

- HNSW (Hierarchical Navigable Small World) for vector columns: O(log n) approximate
  nearest-neighbor, preferred over IVFFlat for a read-heavy store. Falls back to
  IVFFlat on pgvector < 0.5.0.
- GIN for tsvector columns: standard for containment queries (`@@`), supports
  phrase search, faster than GiST for high-cardinality lexemes.

---

## Limitations / not yet supported

- **Postgres only.** No SQLite backend, no Pinecone, no other vector DB.
- **Ollama default.** Other embedders work but require code changes in
  `scripts/lib/shared.js`. Only `mxbai-embed-large` is tested.
- **No tokenizer-aware chunking.** The chunker uses a 1400-character ceiling, which
  can split mid-sentence on dense markdown. It will not overrun the embedding model's
  context window but the chunks may be semantically awkward at boundaries.
- **No orphan pruning.** If you rename or delete a source file, the corresponding
  `memory_entries` row is not removed automatically. You must delete it manually or
  write a cleanup script.
- **No subdir recursion.** The loader does a flat `readdir`. Files nested inside
  subdirectories (other than the conventional `archive/`) are invisible to it.
- **No multi-database support.** One Postgres connection, one database. Sharding or
  multi-tenant layouts are out of scope.

---

## Gotchas

Environment issues discovered during Phase 1 bring-up on Windows 11 (WSL2 Ubuntu, RTX 3090).

**Docker Desktop pull pipeline on multi-GB images.** Docker Desktop 29.4.3 on Windows 11
could not pull `vllm/vllm-openai` -- three consecutive attempts (latest tag and a pinned
v0.20.2 tag) failed with `httpReadSeeker: failed open ... EOF` on different blobs from
`production.cloudfront.docker.com`. Setting `"max-concurrent-downloads": 1` in Docker
Engine settings did not help. Small images (e.g. `nvidia/cuda:12.2.0-base-ubuntu22.04`,
341 MB) pulled fine. Workarounds: try `regctl image copy` or `skopeo copy` (different HTTP
client), pull from a different network, or pivot to the native WSL install path (next item).

**Native WSL vLLM install is the working path on this machine.** Instead of the
spec's docker-compose flow, vLLM is installed directly inside WSL Ubuntu via uv:

```bash
# one-time inside WSL Ubuntu
curl -LsSf https://astral.sh/uv/install.sh | sh
~/.local/bin/uv venv --python 3.12 ~/.venv/vllm
source ~/.venv/vllm/bin/activate
uv pip install vllm
sudo apt-get install -y build-essential   # required for torch.compile JIT (gcc/g++/make)
```

Launch (one model -- repeat with a different port and `--gpu-memory-utilization` for the
reranker):

```bash
~/.venv/vllm/bin/vllm serve <model> --runner pooling --port 8000 --gpu-memory-utilization 0.40
```

Notes:

- vLLM 0.20.x renamed the CLI: use `--runner pooling`, not the older `--task embed` in the
  spec. `--convert embed` may also be useful when converting a non-pooling base model. The
  spec lags behind the upstream CLI.
- If `build-essential` is not installed, append `--enforce-eager` to bypass torch.compile
  (functional but slower). Install build-essential and drop the flag for production.
- Ubuntu WSL ships Python 3.14 by default, which is too new for current vLLM wheels. uv
  handles this transparently by downloading its own CPython 3.12.

**Windows port 8000 may already be taken.** A pre-existing Windows-side Python process
can preempt `localhost:8000` from WSL via WSL2's localhost forwarding, returning a
confusing 404 to clients on the Windows side even though vLLM is healthy inside WSL. Pick
a non-default port (`8800`, `18000`) or reclaim 8000 by killing the existing listener:
`Get-NetTCPConnection -LocalPort 8000 -State Listen` shows what owns it.

**CRLF line endings break `scripts/lib/shared.js` config loading.** The YAML-parsing
regexes in `loadConfig()` use bare `\n` and do not tolerate `\r\n`. On Windows,
`.claude/pipeline.yml` saved by editors that default to CRLF causes `loadConfig` to
silently fall back to defaults -- `database` resolves to `pipeline_<basename>` instead of
whatever the YAML configured. Fast fix: convert `pipeline.yml` to LF. Proper fix: patch
the regexes to use `\r?\n` (tracked as a follow-up).

**NVIDIA Container Toolkit is not on by default in Docker Desktop.** If you use the Docker
path on Windows, enable Docker Desktop -> Settings -> AI -> "GPU-backed inference". That
toggle registers the `nvidia` OCI runtime and is what makes `docker run --gpus all` work.
Without it, container starts fail with
`nvidia-container-cli: ... libnvidia-ml.so.1: cannot open shared object file`.

**WSL GPU access can get stuck.** Symptom: `nvidia-smi` inside WSL returns
`Failed to initialize NVML: GPU access blocked by the operating system`, while the Windows
host's `nvidia-smi` works fine. Fix: `wsl --shutdown` from PowerShell, then re-enter WSL.
This re-initializes the `/dev/dxg` shim. Driver state on the host is fine; only the WSL
side is wedged.

---

## Testing

Two harnesses cover different layers:

**`scripts/test-chunker.js`** -- structural correctness. Six scenarios: chunk
boundary rules (markdown headings, code fences, sentences, hard-split with
overlap), idempotence via content_hash, partial-failure resilience under batched
embed, and an end-to-end round-trip (loader -> DB -> Ollama -> hybrid retrieval).
Set `OLLAMA_SKIP=1` to skip the embed-dependent assertions; structural tests
still run.

```bash
PROJECT_ROOT=$(pwd) node scripts/test-chunker.js
```

**`test/eval/eval-retrieval.js`** -- retrieval-quality regression. 22 synthetic
fixture markdown files in `test/eval/fixtures/`, 18 hand-labeled queries in
`test/eval/queries.json` with expected top-1 / top-3 hits and negative
constraints. Computes recall@1, recall@3 (relaxed), MRR, negative precision.
Asserts each metric stays within 5% of the committed baseline at
`test/eval/baseline.json`. Negative precision is strict (==1.0).

One-time setup:

```bash
psql -U postgres -c "CREATE DATABASE claude_memory_eval_test"
```

Run:

```bash
PGUSER=postgres node test/eval/eval-retrieval.js
```

To accept a real improvement as the new baseline (after a code change that
legitimately raises retrieval quality):

```bash
PGUSER=postgres node test/eval/eval-retrieval.js --update-baseline
```

The harness writes `test/eval/last-run.json` (gitignored) with per-query
results for debugging. Adding a new query: append to `queries.json`, label
expected hits by reading the relevant fixture, then `--update-baseline`. Adding
a new fixture: drop a markdown file in `test/eval/fixtures/` with frontmatter
(`name`, `description`, `type`); the harness loads everything in that
directory. Existing query labels may need updating if a new fixture is now the
better answer.

CI runs the eval harness in `--ollama-skip` mode (smoke test for the SQL /
loader path; vector-quality regression detection requires running locally with
Ollama).

---

## Maintenance posture

This repo is shared in good faith but is not a maintained open-source product. There
are no SLAs on issue response, no roadmap commitment, and no guarantee of
backward-compatible schema migrations between versions. The author uses this code
daily in pipeline, so basic correctness is likely to stay current. Feature requests
are unlikely to be prioritized unless they align with pipeline's own needs.

If you fork this and it works for you, great. If something breaks, you will need to
fix it yourself or wait. The schema is small enough to understand in an afternoon.

---

## License

MIT. See [LICENSE](LICENSE).
