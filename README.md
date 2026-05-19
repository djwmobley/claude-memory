# claude-memory

A self-hosted, zero-per-write-token-cost, Claude Code-native cross-session memory
layer for AI agents. Runs on stock PostgreSQL or on an embedded zero-server SQLite
backend (Node 22 `node:sqlite`). No pgvector, no extensions, no sidecar daemon.

---

## What this is

A knowledge-graph persistence layer purpose-built for Claude Code workflows.
At its core it is a Node script (`scripts/handoff.js`) backed by a schema-validated
storage abstraction, wired into the Claude Code session lifecycle via
`SessionStart`/`Stop` hooks and a set of eight slash-command recipes in
`commands/handoff/`.

Key properties:

- **Zero per-write token cost.** Extraction is the Claude Code conversation itself
  via slash-command recipes. The script does schema-validated writes only — no LLM
  API call is made per write. Contrast with mem0, Graphiti/Zep, and Cognee which all
  require one or more LLM calls per knowledge write.
- **Dual backend — Postgres or embedded SQLite.** Set `STORAGE_BACKEND=sqlite` to
  use Node 22's built-in `node:sqlite` at `<project_root>/.claude/handoff.sqlite`
  (zero-server, no installation). Leave it unset for stock Postgres. The engine is
  backend-agnostic; the single composition root in `scripts/lib/db-seam.js` is the
  only place dialect is selected.
- **No pgvector, no extensions.** The handoff/knowledge-graph layer uses only stock
  SQL features (recursive CTEs, partial unique indexes, JSONB on Postgres; plain
  SQLite equivalents on the embedded path). The optional full-text and vector search
  layer (`scripts/pipeline-embed.js`) does use pgvector if available, but it is
  separate from the session-memory subsystem.
- **Dormancy-resilient decay.** Scoring uses ranking-only decay — a project that has
  been dormant for weeks does not return an empty retrieval set. A guaranteed top-N
  floor ensures continuity regardless of how long a project has been idle.
- **Deterministic cardinality-aware supersession.** A per-predicate registry
  (`scripts/lib/predicate-registry.json`) declares whether a predicate is 1:1 or
  1:N. On a 1:1 predicate the prior live assertion is atomically suppressed when a
  new value arrives. No LLM needed for conflict resolution.
- **Bi-temporal model with recoverable probation.** Every assertion carries
  `valid_at`/`invalid_at` and a `suppression_kind` field with three states:
  `superseded` (deterministic replacement), `downvoted_terminal` (not auto-revived),
  and `downvoted_probation` (soft-excluded from standard retrieval but rehabilitatable
  by positive feedback).
- **Pinned exemption.** Assertions marked `pinned = true` are never auto-suppressed
  by the C2 feedback loop. Explicit cardinality supersession (via the predicate
  registry) may still replace a pinned row.
- **C2 feedback loop.** Outcome signals written at close influence bias-ranking for
  the next retrieval. Default on.
- **Operator manual prune.** The `prune` subcommand lets an operator hard-delete
  selected assertion rows. Dry-run by default; pass `--apply` to execute. Pinned
  rows are excluded unless `--include-pinned` is specified. Project-scoped; at least
  one criterion required.
- **Claude Code session-lifecycle binding.** A `loader-hook` subcommand is the
  `SessionStart` hook entry point; it injects prior-session context automatically
  when the project is fresh enough (configurable `staleness_days` threshold). A
  `loader-stop` subcommand is the `Stop` hook entry point; it writes an implicit
  close record if the session ended without an explicit `/handoff:close`.

---

## How this compares

A code-grounded comparison against agentmemory, mem0, Letta/MemGPT, Graphiti/Zep,
and Cognee is in [`docs/studies/2026-05-memory-systems-comparison.md`](docs/studies/2026-05-memory-systems-comparison.md).

Short version:

| System | Zero per-write token cost | Decay / dormancy-resilient | Claude Code lifecycle binding | Storage |
|--------|--------------------------|---------------------------|-------------------------------|---------|
| **claude-memory** | Yes | Yes — ranking-only + top-N floor | Yes — hooks + staleness gate | Stock PG or embedded SQLite |
| agentmemory | Yes (heuristic) | No | Yes (purpose-built) | Proprietary non-swappable sidecar |
| mem0 | No (LLM per add) | No | No (requires separate server) | Pluggable (pgvector / FAISS / Qdrant) |
| Graphiti/Zep | No (3–5 LLM calls/episode) | No | No | Kuzu embedded |
| Cognee | No (LLM per cognify) | No | No | Kuzu + LanceDB + SQLite |
| Letta/MemGPT | No (agent self-insert) | No | No (requires always-running server) | Bundled |

The two features with no equivalent in any surveyed system: ranking-only decay with a
guaranteed top-N floor, and deterministic predicate-registry cardinality supersession.

---

## Prerequisites

**For the embedded SQLite path (zero-server, low friction):**

- Node 22+ (`node:sqlite` is a built-in available from Node 22)
- No database installation required

**For the Postgres path (durable, recommended for teams):**

- PostgreSQL 13+ (no extensions required for the handoff layer)
- Node 20+

**For the optional full-text + vector search layer** (`scripts/pipeline-embed.js`,
`scripts/pipeline-memory-loader.js`):

- PostgreSQL 14+ with pgvector 0.8.1+ (`CREATE EXTENSION vector;`)
  — required only for the vector search path; FTS works without pgvector
- An embedding server (vLLM or Ollama) — see the [Embedder setup](#embedder-setup)
  section

---

## Quickstart

### Embedded SQLite (zero-server)

```sh
# 1. Clone
git clone https://github.com/djwmobley/claude-memory.git
cd claude-memory

# 2. Install dependencies
cd scripts && pnpm install && cd ..

# 3. Provision a project
STORAGE_BACKEND=sqlite node scripts/handoff.js init

# 4. Install the slash commands
cp commands/handoff/*.md ~/.claude/commands/handoff/

# 5. Wire the session-lifecycle hooks in your project's .claude/settings.json:
#    See "Session-lifecycle hooks" below.
```

The SQLite database is created at `<project_root>/.claude/handoff.sqlite`.
Override the path with `HANDOFF_SQLITE_PATH=/path/to/file.sqlite`.

### Postgres

```sh
# 1. Clone and install
git clone https://github.com/djwmobley/claude-memory.git
cd claude-memory
cd scripts && pnpm install && cd ..

# 2. Create target database
createdb your_db_name

# 3. Apply base schema (optional — handoff init does this too)
psql -d your_db_name -f scripts/setup.sql

# 4. Provision a project
HANDOFF_DB=your_db_name node scripts/handoff.js init

# 5. Install slash commands and wire hooks (same as above)
cp commands/handoff/*.md ~/.claude/commands/handoff/
```

---

## Configuration

Scripts read `.claude/pipeline.yml` from the project root:

```yaml
project:
  name: your-project-name

knowledge:
  tier: postgres
  host: localhost
  port: 5432
  database: your_db_name
  user: your_pg_user
```

For SQLite, set `STORAGE_BACKEND=sqlite` (environment variable or
`storage_backend: sqlite` under `knowledge:` in `pipeline.yml`). No host/port
configuration is needed.

If no `pipeline.yml` exists, standard `PG*` environment variables (`PGHOST`,
`PGPORT`, `PGDATABASE`, `PGUSER`, `PGPASSWORD`) are used as a fallback.

**`HANDOFF_DB` env var:** `scripts/handoff.js` defaults to the database named
`claude_memory_eval_test`. Set `HANDOFF_DB=your_db_name` to use a different
Postgres database. This overrides the default and any `pipeline.yml` setting
for handoff operations only.

**CRLF warning (Windows):** The YAML parser uses bare `\n`. On Windows, editors
that default to CRLF cause `loadConfig()` to silently fall back to defaults. Save
`pipeline.yml` with LF line endings.

**handoff.md location.** Per-project handoff state lives at
`~/.claude/projects/<encoded-cwd>/handoff.md`, outside the repository tree.
This file contains session summaries; add it to `.gitignore` if you ever
relocate it into a repo you plan to publish.

---

## Session-lifecycle hooks

Wire the `loader-hook` (SessionStart) and `loader-stop` (Stop) subcommands into
your project's `.claude/settings.json` to enable automatic context injection and
implicit close:

```json
{
  "hooks": {
    "SessionStart": [
      {
        "command": "node /path/to/claude-memory/scripts/handoff.js loader-hook"
      }
    ],
    "Stop": [
      {
        "command": "node /path/to/claude-memory/scripts/handoff.js loader-stop"
      }
    ]
  }
}
```

Both hooks are defensive: they always exit 0 and log errors to stderr without
breaking session start or teardown. The `loader-hook` skips context injection if
the last close was more than `staleness_days` (default 7, configurable per-project
in `project_settings`) days ago; it emits a stale warning instead.

---

## `/handoff` slash commands

Eight commands back the session-memory lifecycle:

| Command | Description |
|---------|-------------|
| `/handoff:init` | First-run provisioning: schema, `handoff.md`, `CLAUDE.md`, default contract. Idempotent. |
| `/handoff:status` | Read-only: entity/assertion counts, last close, contract names, session marker. |
| `/handoff:resume` | Force-load prior session context regardless of staleness threshold. |
| `/handoff:close` | End-of-session extraction: entities, assertions, edges, contract update, clears `session_in_progress`. |
| `/handoff:checkpoint` | Mid-session save without ending the session. |
| `/handoff:drop` | Archive prior assertions (recoverable), start fresh `handoff.md`. |
| `/handoff:purge` | Hard-delete all project memory. Requires confirmation. |
| `/handoff:promote <id>` | Explicitly promote an assertion to the `## Durable facts` section of `CLAUDE.md`. |

The command files in `commands/handoff/` are thin recipes. `scripts/handoff.js`
does the heavy lifting: schema-validated DB writes, contract evaluation, JSON
payload parsing, and file I/O.

---

## Knowledge-graph schema

The handoff layer uses six tables:

```
entities          — typed named entities (person, system, concept, decision, file)
assertions        — S/P/O triples: subject, predicate, object, confidence 1–10,
                    decay_rate, last_reinforced, suppressed, invalid_at,
                    suppression_kind, pinned, source
edges             — typed relationships between entities (depends_on, implements,
                    blocks, owns, calls, produces)
retrieval_contract — named retrieval plans (JSONB queries array)
project_settings  — per-project key/value config (staleness_days, implicit_close, …)
retrieval_events  — log of retrieval calls; outcome written at close
```

**Bi-temporal model.** Each assertion row has `valid_at` (write time) and
`invalid_at` (suppression time). `suppression_kind` ∈ `{superseded,
downvoted_terminal, downvoted_probation}`. Probation rows are excluded from
standard retrieval but preserved in history and rehabilitatable by positive
feedback. Terminal and superseded rows are not auto-revived.

**Cardinality-aware supersession.** The predicate registry
(`scripts/lib/predicate-registry.json`) declares 1:1 or 1:N cardinality per
predicate. On a 1:1 predicate, all live non-pinned rows for
`(project_id, subject, predicate)` are atomically marked `suppressed = true`,
`invalid_at = now()`, `suppression_kind = 'superseded'` when a new object value
arrives. On a 1:N predicate, only exact `(subject, predicate, object)` duplicates
are suppressed. No LLM is involved in conflict resolution.

**Retrieval contract.** A named JSONB queries array stored per project. Supported
query types: `entity`, `assertion`, `recency`, `vector`, `graph`. The contract
drives what context is injected at `SessionStart`; it is updated at
`/handoff:close`.

---

## Optional: full-text and vector search layer

If you also want hybrid full-text + vector retrieval over a corpus of Markdown
memory files, the repo includes `scripts/pipeline-memory-loader.js` and
`scripts/pipeline-embed.js`. This layer requires PostgreSQL with pgvector 0.8.1+.

```
memory_entries        — one row per .md file
memory_entry_chunks   — one row per semantic chunk, with embedding halfvec(4000)
v_memory_hits         — view: chunks joined with parent name
```

Hybrid scoring (applied in Node, not in Postgres):

```
score = ts_rank(fts_vec, query) * 0.3
      + (1 - embedding <=> query_vector) * 0.7
```

**Embedding column type:** `halfvec(4000)`. Qwen3-Embedding-8B outputs 4096 dims;
the leading 4000 are stored (Matryoshka truncation). pgvector 0.8.1 caps HNSW
indexes at 4000 dims for `halfvec` — this is what makes ANN indexing viable as
corpus size grows.

The handoff/knowledge-graph layer works independently of this layer. You can use
the slash-command memory system alone without ever running the embedder pipeline.

### Embedder setup

The embedder pipeline supports two backends:

- **vLLM** (primary): `Qwen/Qwen3-Embedding-8B` via vLLM, produces `halfvec(4000)`.
  Recommended for retrieval quality.
- **Ollama** (fallback): `mxbai-embed-large` (1024 dims). Works but produces
  1024-dim embeddings in a `halfvec(4000)` column — the remaining 2976 dims are
  zero-padded on insert, which degrades retrieval quality relative to vLLM.

vLLM launch command:

```bash
~/.venv/vllm/bin/vllm serve Qwen/Qwen3-Embedding-8B \
  --runner pooling --port 8800 --gpu-memory-utilization 0.40
```

Configure in `.claude/pipeline.yml`:

```yaml
knowledge:
  embed_backend: vllm
  vllm_embed_url: http://localhost:8800
  embedding_model: Qwen/Qwen3-Embedding-8B
```

### Full corpus pipeline

```sh
node scripts/pipeline-memory-loader.js memory      # load .md files, chunk, hash
node scripts/pipeline-embed.js blurbs              # generate contextual blurbs (Ollama qwen2.5:14b)
EMBED_BACKEND=vllm node scripts/pipeline-embed.js index  # embed via vLLM
```

Search:

```sh
node scripts/pipeline-embed.js hybrid "your query"  # FTS * 0.3 + cosine * 0.7
node scripts/pipeline-embed.js search "your query"  # vector-only
```

---

## Trust model and CLAUDE.md promotion

> Full security policy and payload-validation details: [SECURITY.md](SECURITY.md)

**Auto-promotion is off by default.** Assertions with `confidence >= 9`,
`source = user_stated`, and reinforcement across multiple sessions are surfaced
as candidates at `/handoff:close`. They are written to the `## Durable facts`
section of `CLAUDE.md` only when the close payload explicitly sets
`confirm_claude_md_promotion: true`. The `/handoff:promote <id>` command is the
explicit single-assertion path.

Every promotion writes an HTML comment annotation immediately before the fact line,
recording session, confidence, date, and source assertion ID.

**Multi-author detection.** When `handoff init` or `handoff close` runs,
`git log` is checked for distinct author emails over the last year. If more than
one author is detected, a notice is written to stderr. No behavior changes; the
`multi_author_detected` flag in `project_settings` is available for future policy
gates. The intent is to surface the condition so you can decide whether
auto-promotion is appropriate for your threat model.

---

## Testing

CI runs on every pull request (Node 22, Postgres 16 via `pgvector/pgvector:pg16`
image). Test steps:

| Step | What it covers |
|------|----------------|
| `test-chunker.js` | Structural correctness: chunk boundaries, content-hash idempotence, loader–DB–embed round-trip |
| `eval-retrieval.js --ollama-skip` | SQL/loader/schema path smoke test (vector-quality detection requires local embedder) |
| `test-graph-traversal.js` | Exhaustive tests for `kind:'graph'` recursive-CTE retrieval on Postgres |
| `smoketest-handoff.js` | Full smoketest suite — all 13 sections, including supersession invariant and predicate-registry drift |
| `test-sqlite-seam.js` | SQLite adapter unit and integration tests: dialect rewrite, schema application, JSONB round-trip, graph CTE, abstraction invariant, bi-temporal columns, canonicalization, manual prune |
| `test-both-backends.js` | Adversarial-invariant sweep on both Postgres and SQLite (10 invariants: bi-temporal, probation lifecycle, terminal-is-terminal, pinned exemption, canonicalization × supersession, prune × bi-temporal, C2 gate, abstraction invariant, constants, no-backfill guarantee) |

Run locally:

```sh
# Chunker tests (OLLAMA_SKIP=1 skips embed assertions)
OLLAMA_SKIP=1 node scripts/test-chunker.js

# Full smoketest
node scripts/smoketest-handoff.js

# SQLite seam tests (Node 22+)
node scripts/test-sqlite-seam.js

# Both-backend adversarial sweep
node scripts/test-both-backends.js

# Retrieval quality regression (requires Ollama or vLLM locally)
PGUSER=postgres node test/eval/eval-retrieval.js
```

**CI caveat.** CI runs `eval-retrieval.js` in `--ollama-skip` mode. This exercises
the SQL and loader paths but skips vector-quality regression detection. A green CI
run does not mean retrieval quality is unregressed. Run the full harness locally
with Ollama or vLLM to catch retrieval-quality regressions before relying on a
change.

---

## Studies

Design notes and methodology write-ups for the project:

- [**Decay vs. Don't-Forget: Devalue, Invalidate, and On-Demand Resurrection**](docs/studies/decay-vs-dont-forget-and-resurrection.md)
  — Designed and shipped case study tracing the full journey from problem to production: how decay and trust-tiering compound to sink valuable older context; the devalue-vs-invalidate spine that makes recovery safe; and three proven mechanisms shipped as one mutually-dependent ring — (1) devalue-over-delete with a bitemporal guard that hard-excludes terminal/superseded rows, (2) operator-pin for foundational facts that must survive decay permanently via a non-model-invocable standalone tool, and (3) fuzzy resurrection combining semantic seed, pg_trgm trigram fallback, and depth-2 graph fan-out. Includes the adversarial finding (why all three had to ship together), and the two-question replication discipline that caught and corrected two author overstatements before conclusions were accepted.

- [**claude-memory vs. Alternatives: Was the Build Justified?**](docs/studies/2026-05-memory-systems-comparison.md)
  — Code-grounded comparison against agentmemory, mem0, Letta/MemGPT, Graphiti/Zep, and Cognee.

---

## Maintenance posture

This repo is shared in good faith but is not a maintained open-source product.
There are no SLAs on issue response, no roadmap commitment, and no guarantee of
backward-compatible schema migrations between versions. The schema is small enough
to understand in an afternoon.

If you fork this and it works for you, great. If something breaks, you will need to
fix it yourself or wait.

---

## License

MIT. See [LICENSE](LICENSE).
