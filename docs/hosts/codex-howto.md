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

## Session identity

The engine needs a session id to attribute writes and to resolve the
`session_in_progress` marker. It resolves one, in order: an explicit
argument passed by the caller, then the `CLAUDE_CODE_SESSION_ID` environment
variable, then `CODEX_THREAD_ID` (PR #276) — each candidate is trimmed, and
an empty or whitespace-only value is treated as absent, not as a valid id.

Codex sets `CODEX_THREAD_ID` for the life of a session, and every hook
payload (`SessionStart`/`SessionEnd`) also carries its own `session_id`
field — under Codex, `CLAUDE_CODE_SESSION_ID` is never set, so
`CODEX_THREAD_ID` is what the fallback chain actually resolves to.

`handoff_close` and `handoff_checkpoint` accept an optional `sessionId`
argument that overrides the fallback chain entirely; a Codex caller should
pass `CODEX_THREAD_ID` explicitly rather than relying on environment
resolution alone. *(shipping in the companion PR, #278 — not yet merged.)*

**Marker caveat.** The active-session marker
(`project_settings.session_in_progress`) is stored as a JSON **array** of
per-session marker objects — `{session_id, ts}`, with a `host` field
(`"claude"`/`"codex"`) also stamped by the `SessionStart` loader hook as of
this PR — not a single slot. A session's own loader-hook/`resume` write
upserts (dedupes by `session_id`, refreshing `ts`) its own entry into that
array; it does not overwrite a sibling session's entry. `handoff_status`
displays every live entry. This does not affect explicit closes: each one
records its own session id append-only regardless of what the marker array
currently holds. Today, close's summary can claim the marker was cleared
even when a later status check shows it still set (see item 10 in
[Known real-world defects and quirks](#known-real-world-defects-and-quirks));
close reporting the true marker outcome ships in the companion PR referenced
there.

---

## Usage telemetry under Codex

Two more MCP tools exist: `usage_record` (per-turn tokens/cost, writes only)
and `usage_query` (roll-ups by model, role, provider, day, branch, or PR).
`usage_query` reads telemetry tables; like every tool on this MCP server it
still enters the project DB heal-on-touch path (`withProjectDb` ->
`ensureSchemaCurrent`/`ensureProjectIdentity`), which may write schema
repairs even though the tool's own query is read-only — see this project's
`readOnlyHint:false` annotation on `usage_query` in `scripts/handoff-mcp.mjs`
(Codex review F1). Only `usage_record` defaults its session identity at
all — `usage_query` does not resolve session identity from env or marker;
see below.

- `usage_record`'s `sessionId` argument is optional. Omitted (the property
  genuinely absent from the call — an explicit `""` or whitespace-only
  string is NOT "omitted" and is a hard error instead), it resolves through
  the engine's precedence, in order: (1) an explicit `sessionId`
  argument, checked first, always wins; (2) this MCP server process's own
  environment, using the exact same `CLAUDE_CODE_SESSION_ID` →
  `CODEX_THREAD_ID` precedence described in [Session
  identity](#session-identity) above; (3) if neither env var resolves, a
  **strict, `usage_record`-only** marker default —
  `resolveUsageRecordMarkerDefault` in `scripts/lib/session-identity.js`, a
  rule distinct from (and stricter than) `resolveSessionIdFromMarker`, the
  helper `handoff.js`'s own `resolveSessionId` (used by
  `handoff_close`/`handoff_checkpoint`) and `handoff_status` share
  unchanged. This step parses the `session_in_progress` marker array
  strictly (malformed JSON is excluded, never legacy-parsed as a
  bare-string marker), filters it to markers whose `host` matches this
  server's own `HANDOFF_HOST` env var when at least one marker in the array
  carries a `host` field, and requires **exactly one** surviving candidate:
  zero is the same hard error described below, and more than one is a
  distinct `"ambiguous session markers (N)"` hard error naming only the
  count and each candidate's host (never a session id). Omitting
  `sessionId` with none of the three available is a hard error, never a
  fabricated id. The returned row always carries `session_id_source`
  (`"explicit"|"env"|"marker"`) and, only when it is `"marker"`,
  `marker_ts` — provenance for the id actually used.

  **Under Codex, step (2) fires only if the MCP server process has those
  env vars; Codex does not set them, so step (3) is the path that serves
  Codex.** A real Codex CLI end-to-end run (2026-09-12) confirmed Codex does
  NOT put `CODEX_THREAD_ID` into this MCP server process's own environment:
  `config.toml`'s `env` table for this server carries only `HANDOFF_HOST`
  and `HANDOFF_PROMOTION_FILE`. Before the original fix, an omitted
  `sessionId` under Codex failed outright with "no default could be
  resolved from ... CLAUDE_CODE_SESSION_ID or CODEX_THREAD_ID env vars" in
  the SAME run where `handoff_status` reported a `session_id` — because
  `handoff_status` reads the project's marker array, which the
  `SessionStart` loader hook (`--host codex`) writes with the Codex thread
  id (and, as of this PR, `host: "codex"`), and `usage_record` did not
  previously consult it. Pass `sessionId` explicitly (e.g. the value from
  `handoff_status`, or the hook's own `session_id`) to bypass the fallback
  chain entirely — doing so is also the only way to disambiguate when two
  or more sessions have live markers for the same project.
  `usage_record` writes to `turn_usage` ONLY — it never writes
  `session_usage` or `feature_usage`.
- `usage_query` does NOT resolve session identity from env — it has no
  `CLAUDE_CODE_SESSION_ID`/`CODEX_THREAD_ID` fallback of any kind. It is
  project-scoped unless `sessionId` is passed explicitly: "omitted" already
  means something specific here (a project-wide rollup for
  `granularity="turn"`, or a required-absent case for `granularity="feature"`)
  and auto-filling it from the calling session's own id would silently
  defeat both. `sessionId` is always exactly what the caller passed, never a
  resolved default. `usage_query` reads across `turn_usage` (session-scoped,
  `granularity="turn"` with `sessionId` given), `session_usage` (project-wide
  rollup, `granularity="turn"` with `sessionId` omitted), and `feature_usage`
  (`granularity="feature"`) depending on the arguments given — it writes to
  none of them.
- Engine schema epoch 5 or later creates `turn_usage`/`session_usage`/
  `feature_usage` at init/heal (`handoff.js init`, or an equivalent schema
  heal reached via `ensureSchemaCurrent`) — never auto-created by
  usage_record/usage_query themselves. On an engine older than epoch 5 the
  tools return the actionable error below instead. As of this writing this
  checkout's `scripts/sql/schema-manifest.json` is `schema_epoch: 5` and
  includes these tables (PR #298); a project database whose stored
  `schema_fingerprint` still carries an epoch older than 5 re-applies once
  via `ensureSchemaCurrent`'s heal-on-touch path to pick them up. Calling either
  tool against a project database whose schema predates the table it needs
  returns an actionable error naming the missing relation, not a raw
  Postgres stack trace, e.g.:

  > `turn_usage is missing in <database>: the engine schema for this project
  > is behind (ensureSchemaCurrent reason=<reason>); run "node
  > scripts/handoff.js init" against this project root, or upgrade the
  > engine so the schema manifest includes usage telemetry`

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

Embeddings, when enabled, come from a local vLLM server running an
embedding model of the operator's choice (default port 8800) — see
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
| 6 | A bare `/handoff` did something unexpected instead of erroring | Codex has no slash-command surface; on a dual-host machine, `/handoff` resolved to the auto-migrated `source-command-handoff-close` skill instead of the `handoff` dispatcher skill this installer ships (see [codex.md § Skills](codex.md#skills)) | Say "handoff" (or use the explicit MCP tool calls shown throughout this page) instead of typing `/handoff`; delete the stale migrated skill per item 5 if it keeps winning | Fixed for a fresh install — the shipped `handoff` dispatcher skill takes the name; a pre-existing stale migrated skill still needs manual cleanup per item 5 |
| 7 | The resolved `handoff.md` thin-pointer path is under `~/.claude/projects/<uuid>/`, not `~/.codex/` or anything Codex-branded | The pointer path is host-agnostic by design — one project identity, one pointer file, shared across every host that touches the project | This is expected, not a bug — do not "fix" it by moving the file; some older docs said `~/.Codex/...`, which was simply wrong and is corrected here | Open documentation discrepancy noted for cleanup; functionally the shared path is correct |
| 8 | `memory_search` seems to ignore most of the tables its own tool description lists | The tool advertises a 15-table closed enum, but a stock install's live schema only contains `assertions` and `decisions` with embeddings — the other named tables don't exist in this project's database at all | Expected on a fresh install — `tablesSearched`/`skippedTables` in the result tells you exactly which tables were actually queried | By design (see `scripts/lib/memory-search.js`'s table-existence classification) — not a defect, but a common point of confusion |
| 9 | Two concurrent sessions on the same project (e.g., a nested `codex exec` plus an interactive session, or Codex plus Claude Code at once) each get their own marker, but `handoff_status`'s one-line summary only names the most-recently-written one | `session_in_progress` is a JSON array of per-session markers (S3), each stamped with the writing host (`'claude'`/`'codex'`) by the loader-hook — not a single slot; `handoff_status` shows a count (`"N markers — latest <id> at <ts>"`) rather than every marker's id | Read the count in `handoff_status`'s summary to see how many sessions are live; `usage_record`'s own sessionId default (`resolveUsageRecordMarkerDefault`) filters candidates by `HANDOFF_HOST` and returns an explicit "ambiguous session markers" error instead of guessing when more than one host-matching marker remains — never pass `session_id` blind when that error appears | Fixed — the array + host-tag marker model shipped in `fix/usage-record-marker-fallback`; a session-id-keyed marker set (once "proposed but not implemented") is now the live implementation, not a proposal |
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
