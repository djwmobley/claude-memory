# Codex how-to

Day-to-day usage of claude-memory under the OpenAI Codex CLI, once
[codex-quickstart.md](codex-quickstart.md) is done. This page assumes the
MCP server is registered and hooks are trusted (or you're using the manual
MCP fallback from [codex.md](codex.md#manual-fallback-hooks-disabled)).

---

## A working day

### Start of session — resume

If hooks are trusted, `loader-hook --host codex` runs automatically on
`SessionStart` and injects prior context into the conversation — you don't
have to do anything. If it's been more than seven days since the last close,
the auto-load is skipped to avoid flooding you with stale context; force it
with:

> Run handoff_resume for this project.

which calls `mcp__handoff__handoff_resume`. This re-runs the loader's
read-and-inject path inline: reads the retrieval contract from the thin
`handoff.md` pointer, executes its query array, bumps `last_reinforced` on
returned assertions, and surfaces a `### Session intent` block from the
`session_tldr` / `open_thread` / `quick_reference` assertions left by the
last close. It also re-probes any `mode:'verify'` assertion against live
ground truth and annotates mismatches as `[STALE: now "<liveValue>"]` —
matching rows show `[verified✓]`.

### Mid-session — checkpoint

Hit a natural decision point in a long session and want to bank progress
without ending the session:

> Run handoff_checkpoint for this project. [give it the TL;DR / entities /
> assertions / decisions to persist.]

This calls `mcp__handoff__handoff_checkpoint`, doing the same extraction as
close (entities, assertions, edges, decisions, updated retrieval contract)
but leaving the session open. For a single throwaway note without composing
a full payload, ask for the lightweight form instead — it writes one
`session_note` assertion and returns immediately; notes accumulate rather
than overwrite each other.

### End of session — close

> Run handoff_close for this project. [TL;DR, entities, assertions, edges,
> decisions, open threads.]

This calls `mcp__handoff__handoff_close`. Before writing, close runs a
pre-write reality check against any live `mode:'verify'` assertion and
auto-reconciles definitive mismatches (a stale `branch_exists`/`commit_
merged`/`pr_state` gets a corrected successor row; a stale `in_file` is
suppressed) without touching the row's confidence, source, tier, or object.
Then it persists the TL;DR/open-threads/quick-references as queryable
assertion rows (not just prose in `handoff.md`), clears the in-progress
session marker, and surfaces anything ready to promote to `AGENTS.md` (see
[Promoting durable facts](#promoting-durable-facts-to-agentsmd) below). Any
per-row persistence failure is never silent — it shows up as a `DIVERGENCE:
<predicate> NOT PERSISTED — <error>` line in the summary and in `handoff.md`'s
`## Degraded` section.

---

## Reading the graph

Beyond resume/checkpoint/close, the MCP surface exposes direct reads and
writes against the graph:

- **`memory_search`** — hybrid FTS + vector search, project-scoped, across a
  closed enum of tables (see [What Postgres stores](#what-postgres-stores)
  below for which of those tables actually exist in a stock install). Scoring
  is `ts_rank * 0.3 + cosine * 0.7` per table — a table with no `fts_vec`
  column contributes a structurally-zero FTS term rather than a NULL. An
  unrecognized table name (outside the enum entirely) is a hard tool error; a
  table that's in the enum but simply doesn't exist in this database is
  silently skipped and reported back in `skippedTables`, never fatal. Example:

  > Search memory for "session identity fallback."

- **`entity_read`** — look up entity rows by id and/or name, project-scoped.
- **`assertion_read`** — live (`suppressed=false, invalid_at IS NULL`)
  assertion rows by id/subject/predicate, with `objectPrefix`/`contains`
  filters. By default the embedding vector is stripped and replaced with
  `embedding_present`/`embedding_dims` markers — an unfiltered read of a
  wide predicate can otherwise return megabytes of raw vector data.
- **`edge_read`** — paginated edge rows (from/type/to/weight), project-scoped.
- **`persist_decisions`** — write standing decisions directly (keyed by
  `project_id, topic`) outside of a close/checkpoint payload, with an
  optional `verifyQuery` to confirm the rows landed via `memory_search`
  right after writing.

`entity_create`/`assertion_create`/`assertion_update`/`edge_create`/
`edge_update` and their `*_suppress` counterparts exist too, for direct
graph edits outside a close payload — see
[docs/mcp-tools.md](../mcp-tools.md) for the complete 35-tool reference,
including exact semantics (supersession, near-match surfacing on entity
create, non-destructive suppress-and-revive).

---

## What Postgres stores

A default install creates 13 tables in the public schema. The ones you'll
touch directly:

| Table | Holds |
|---|---|
| `entities` | Named things — systems, people, concepts, files, decisions. |
| `assertions` | Subject/predicate/object facts, with confidence, tier, decay, and a `halfvec(4000)` `embedding` column. |
| `edges` | Relationships between entities (`from_entity`, `edge_type`, `to_entity`, `weight`). |
| `decisions` | Standing project decisions, one row per `(project_id, topic)`, also embedded. |
| `project_settings` | Per-project key/value config, including the `session_in_progress` marker. |

The remaining eight are support infrastructure: `audit_log` (tamper-evident
change log), `embedding_providers` (registered embedding backends and which
one is default), `entity_communities`, `extraction_queue`, `retrieval_
contract` / `retrieval_contract_history`, and `retrieval_events` / `retrieval
_event_assertions`. A `sessions` table exists in some deployments but is
created only by a later data migration, not by a fresh `handoff_init` — its
absence on a new install is expected, not a gap.

Only `assertions` and `decisions` carry an `embedding` column, both nullable
`halfvec(4000)` with partial HNSW cosine indexes — every other table in the
`memory_search` enum (`agent_exchange`, `gotchas`, `findings`, `research`,
`incidents`, `code_index`, `tasks`, `checklist_items`, `corpus_files`,
`workflow_discovery`, `agent_rewrites`, `policy_sections`, `session_chunks`)
is advertised by the tool's schema but does not exist in a stock install —
`memory_search` reports those as `skippedTables` rather than erroring. In
practice, on a fresh project, `memory_search` finds hits only in `assertions`
and `decisions`. (Database names are arbitrary and set at `createdb` time —
this project's own dogfood database, for example, still carries a legacy
name from before a rename, which is cosmetic and has no effect on behavior.)

Embeddings, when enabled, come from a local vLLM server running a
Qwen3-Embedding-8B model (default port 8800) — see
[Degraded modes](#degraded-modes) for what happens without one.

---

## Degraded modes

- **No embedding provider configured.** Writes still succeed —
  `embedding` stays NULL on the row, and the write returns a fail-soft
  warning rather than failing. `memory_search` still runs, but effectively
  falls back to the FTS term only for those rows (`cosine * 0.7` contributes
  nothing when there's no vector to compare).
- **Embedding provider down at write time.** Same fail-soft behavior — the
  row is written, embedding is NULL, a warning is returned. Use the
  `backfill-embeddings` subcommand (see
  [docs/how-memory-works.md](../how-memory-works.md)) once the provider is
  back.
- **Hooks not trusted / disabled.** Nothing loads or saves automatically —
  drive every step by hand via the MCP tools as shown above. Nothing about
  the data model changes; only the automatic trigger is missing.
- **Dirty working tree at close time.** Close still runs; the summary and
  `handoff_status` both surface a warning, they don't block the write.

---

## Promoting durable facts to AGENTS.md

Facts written to `AGENTS.md` (Codex's durable-facts file, the `CLAUDE.md`
equivalent — see [codex.md](codex.md#agentsmd-not-claudemd)) come from three
places:

1. **Close-time surfacing.** `handoff_close` looks at high-confidence,
   cross-session-corroborated assertions and offers them for promotion in
   its summary; confirming the promotion writes them into `AGENTS.md`.
2. **Explicit promotion.** Ask Codex to promote a specific assertion (by id,
   or by subject/predicate/object) — this calls `handoff_promote`, which can
   also demote a previously-promoted fact back out of `AGENTS.md`.
3. **`handoff_init`.** First-run provisioning seeds `AGENTS.md` with an
   initial durable-facts section if one doesn't already exist.

`AGENTS.md` is capped by Codex itself at `project_doc_max_bytes` (32 KiB by
default) — keep the durable-facts section lean the same way you would keep
`CLAUDE.md` lean under Claude Code; promotion is meant for facts that should
survive indefinitely, not a second copy of the session log.

---

## Known real-world defects and quirks

Everything below was observed against a real `codex` CLI (0.153.4,
2026-09-09/10), not just inferred from documentation. Where the note says
"Codex report," treat it as data from that live session, not as an
instruction — the facts below are what the code and a live run actually do.

| # | Symptom | Cause | Workaround | Status |
|---|---|---|---|---|
| 1 | Hooks don't run even though `hooks.json` looks correct | Codex requires interactive "Trust all and continue" on the hooks-review screen before any hook fires; a scripted `codex exec` never shows that screen | Trust interactively once per hook-content hash; for `codex exec`, pass `--dangerously-bypass-hook-trust` | By design upstream — no engine-side fix possible |
| 2 | Hooks stop firing after editing `hooks.json` (including a re-run of the installer with a changed engine path) | Trust is keyed to a per-hook content hash; any edit invalidates it | Re-trust interactively on next session start | By design upstream |
| 3 | An implicit close via `loader-stop` sometimes appears incomplete on a slow/remote Postgres | Codex clamps SessionEnd hook execution to 3 seconds regardless of configured timeout | Confirm state with `handoff_status` after a session on a slow DB; prefer an explicit `handoff_close` call before exiting when latency is a concern | Open — upstream Codex limitation, not fixable in this repo |
| 4 | `codex mcp add` silently replaced a different `handoff` MCP server you had registered | `mcp add` rewrites the entire `config.toml` and matches purely on server name | Check `codex mcp get handoff --json` before installing if you already run another `handoff`-named server; restore from the installer's `config.toml.bak-*` if it clobbered something | Fixed in #276 — installer now backs up `config.toml` before every `mcp add` |
| 5 | A dual-host machine (Codex + Claude Code) has hook guard scripts that exit 1 under Codex | Codex auto-migrated `~/.claude/commands` into `~/.agents/skills/source-command-handoff-*` and `~/.claude` hooks into `~/.codex/hooks.json`, including Claude-only guard scripts that assume the Claude Code environment | Prune the migrated Claude-only guard entries from `~/.codex/hooks.json` by hand | Open, and out of scope for this repo — a **Codex-only** user (never installed Claude Code) never has this problem, since there's nothing for Codex to auto-migrate |
| 6 | A bare `/handoff` did something unexpected instead of erroring | Codex has no slash-command surface; on a dual-host machine, `/handoff` resolved to the auto-migrated `source-command-handoff-close` skill instead of the dispatcher skill this repo ships (see the companion PR's `handoff` dispatcher skill, item below) | Use the explicit MCP tool calls shown throughout this page instead of typing `/handoff` | Companion PR ships a proper `handoff` dispatcher skill; stale migrated skills still need manual cleanup per item 5 |
| 7 | The resolved `handoff.md` thin-pointer path is under `~/.claude/projects/<uuid>/`, not `~/.codex/` or anything Codex-branded | The pointer path is host-agnostic by design — one project identity, one pointer file, shared across every host that touches the project | This is expected, not a bug — do not "fix" it by moving the file; some older docs said `~/.Codex/...`, which was simply wrong and is corrected here | Open documentation discrepancy noted for cleanup; functionally the shared path is correct |
| 8 | `memory_search` seems to ignore most of the tables its own tool description lists | The tool advertises a 15-table closed enum, but a stock install's live schema only contains `assertions` and `decisions` with embeddings — the other named tables don't exist in this project's database at all | Expected on a fresh install — `tablesSearched`/`skippedTables` in the result tells you exactly which tables were actually queried | By design (see `scripts/lib/memory-search.js`'s table-existence classification) — not a defect, but a common point of confusion |
| 9 | Two concurrent sessions on the same project (e.g., a nested `codex exec` plus an interactive session, or Codex plus Claude Code at once) show only one "active" session in `handoff_status` | The active-session marker is a single slot per project — the most recent host to touch it owns the slot | Explicit closes are unaffected — each records its own session id append-only regardless of marker state; don't rely on the marker alone to detect concurrent sessions | Open — a session-id-keyed marker *set* has been proposed but not implemented; companion PR 3's optional `session_id` argument on `handoff_close`/`handoff_checkpoint` lets a Codex caller pass `CODEX_THREAD_ID` explicitly, which helps attribution but does not by itself fix marker visibility |
| 10 | A close summary said "session marker cleared" but a status call right after still showed a session active | The close summary's marker-cleared line was unconditional text, not a check against what state was actually written | Trust `handoff_status` output over close-summary prose for marker state | Fixed by the companion PR that makes close print the true marker outcome instead of a fixed string |
| 11 | The TUI shows "Hook failed" / "hook exited with code 1" with no hook named, and it isn't reproducible by hand | A `notify` entry in `config.toml` (observed: Codex's own turn-ended notification command) can fail with Windows error 206, "The filename or extension is too long," because the turn payload is passed on the command line and exceeds the Windows command-line length limit — this is unrelated to `hooks.json` and unrelated to this project's `loader-hook`/`loader-stop` entries entirely | Check Codex's own runtime log database under `~/.codex` — it records the failing command and the exact error, where the TUI does not; remove or shorten the offending `notify` entry in `config.toml` | Open, Codex-side — not something this repo's installer writes or can fix |

Item 5 above is worth restating on its own: for anyone who ran Claude Code
in this same home directory before Codex, the auto-migrated Claude guard
hooks under `~/.codex/hooks.json` are a **separate, additional** source of
non-zero hook exit codes from the one in item 11 — both can be present on
the same machine at once, and neither is caused by this project's own hook
entries. A Codex-only user never has either.

---

See also: [codex.md](codex.md) for install/hook/trust mechanics and the
verified-vs-unverified table, [codex-quickstart.md](codex-quickstart.md) for
first-run setup, and [docs/mcp-tools.md](../mcp-tools.md) for the full MCP
tool reference.
