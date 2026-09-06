# MCP tool surface

`scripts/handoff-mcp.mjs` is the one MCP server this repo ships (stdio
transport, registered via `claude mcp add`). It started with 5 tools
(session-lifecycle + a decisions-persistence tool) and now exposes 31: the
original 5 plus `handoff_resume` (added later, same child-process transport
shape — see below) plus 25 new direct-Postgres tools that generalize the
store's write/read surface outside the checkpoint/close batch-payload flow.

Every table and tool named on this page exists on `main` as of this
writing; if you find a mismatch, the code is authoritative — start at
`scripts/handoff-mcp.mjs`'s `buildServer()` function, where every tool is
`server.registerTool(...)`'d with its zod input schema and description.

## Two transport shapes

The original 5 tools, plus `handoff_resume`, spawn `node scripts/handoff.js
<subcommand>` as a child process per call — the engine needs host
filesystem paths, real git checkouts, and localhost Postgres, all of which
a host-run child process gets for free by inheriting the parent's cwd/env.
`handoff_resume` runs `handoff.js resume`, which has no `--json` mode, so
the tool returns the child process's raw stdout verbatim as a `context`
string rather than a parsed object — the same "reads it as context" shape
the CLI form and the SessionStart loader-hook both already rely on.

The 25 new tools open a Postgres connection **in-process** instead
(`scripts/lib/mcp-db-connect.js`), because several of them need to run a
multi-statement transaction within one tool call (a supersede, a versioned
routing-profile write, a guarded state transition) — a round trip through a
child process per statement would not let the call own its own transaction
boundary. Every one of them resolves its target database the same way
`handoff.js` itself does (`HANDOFF_DB` env override, else
`.claude/pipeline.yml`'s `knowledge.database`, else a built-in default) —
`mcp-db-connect.js` re-derives that resolution parameterized by an explicit
`projectRoot`, since the server is a single long-lived process that may
serve tool calls for different projects across its lifetime and cannot
safely mutate `process.env.PROJECT_ROOT` per call the way a short-lived CLI
invocation can.

**One project-identity path.** Every new tool resolves `project_id` via
the SAME `ensureProjectIdentity()` function `handoff.js` itself calls
(`scripts/lib/project-identity.js`) — never a second implementation. This
function is migration-capable, not a pure lookup: a `projectRoot` that
still has legacy-encoded rows and no project marker yet will have the
one-shot identity migration run inline, on first use, exactly as it would
under `handoff.js status`.

**Schema bring-forward for MCP-only sessions.** `withProjectDb`
(`scripts/handoff-mcp.mjs`) also calls the SAME `ensureSchemaCurrent()`
function `handoff.js` itself calls from `cmdLoaderLoad`/`cmdClose` — again,
never a second implementation — immediately after `ensureProjectIdentity()`
resolves `project_id`. Before this, an MCP client that never ran `handoff.js
init`/`resume` against a given `projectRoot` could hit a §8 tool against a
project DB whose schema was stamped current at an older engine epoch (most
concretely: missing `decisions`/`audit_log`/`decisions_audit`, see above) —
every tool touching the missing object would fail with a raw Postgres error
(`42P01 relation does not exist`) and no actionable next step.
`ensureSchemaCurrent()` carries no interactive confirmation gate of its own
(the "apply DDL?" prompt is `cmdInit`'s DB-*creation* gate only — schema
bring-forward on an already-existing DB is always additive/idempotent DDL,
never a DB creation) and never throws by contract — every failure path
returns a `{applied, reason, detail}` status object instead. `withProjectDb`
treats this as total, three-way: `reason === 'current'` or `applied ===
true` means proceed silently (the overwhelming common case); `reason ===
'degraded'` (see "pgvector-gated columns" below) also proceeds, since the
rest of the schema is fine and most tools never touch a gated column;
anything else is a real degradation (a classification error, a lock that
could not be acquired, a failed post-apply verification, …) and
`withProjectDb` throws a hard tool error naming `handoff.js init`/`resume`
as the remedy, run directly against the project root in an interactive
terminal. This is a deliberate divergence from `cmdLoaderLoad`/`cmdClose`'s
own non-fatal, stderr-only handling of the same call: those run in a
human's terminal (stderr is visible, the CLI process itself is disposable);
an MCP tool call has no stderr channel an agent caller can read and no
interactive prompt to answer, so failing loud with an explicit remedy is
strictly better than deferring to a more confusing SQL-layer error inside
the tool's own write. Pre-existing constraint, unchanged by this fix: a
`projectRoot` whose DB has NEVER been `init`-ed at all (zero core tables)
was already out of scope for the whole §8 surface before this change —
`ensureProjectIdentity()` itself queries
core tables and requires them to exist.

**pgvector-gated columns — loud, not silent.** `assertions.embedding` and
`decisions.embedding` (and their HNSW indexes) are wrapped in `DO $$ ...
EXCEPTION WHEN OTHERS $$` blocks at schema-apply time so a target with no
`vector` extension degrades gracefully instead of aborting the whole apply
— but "gracefully" previously also meant *silently*: no `pg` `'notice'`
listener existed anywhere, the gated columns are deliberately excluded from
`schemaObjectsExist()`'s expected-objects probe (so post-apply verification
still passed), and `ensureSchemaCurrent()` reported `applied:true`/
`reason:'current'` regardless — a live write against the missing column
threw a bare `42703` with no signal anywhere that this was a known,
expected condition. `ensureSchemaCurrent()` now runs a declarative,
general check (`checkPgvectorGatedObjects`, driven by each manifest unit's
own `pgvector_gated` entry in `schema-manifest.json` — today: `handoff-
core-schema.sql`'s `assertions.embedding`, `decisions-base.sql`'s
`decisions.embedding`) on **every** call, including the `'current'` fast
path — a DB fingerprinted current before `vector` was ever installed keeps
reporting the gap on every subsequent touch, not just the one apply that
first skipped it. When anything is missing: a structured record is written
to `project_settings.schema_apply_degraded` (`reason:
'pgvector_gated_skip'`, listing every skipped `{unit, table, column}`, the
live `pg_extension` probe result, and a remedy string), the call returns
`reason:'degraded'`, and `handoff.js status` surfaces the same record (it
already reads this key generically). At the write layer,
`scripts/lib/write-time-embed.js`'s `classifyEmbeddingWriteError()` turns a
raw `42703` on the `embedding` column into a named `EmbeddingColumnAbsentError`
instead — `memory-upsert.js`'s `upsertDecisionRow`/`writeMemoryRow` both use
it, so `persist_decisions`/`memory_upsert` calls hitting this get an
actionable message (naming pgvector and `schema_apply_degraded`) instead of
a bare driver error; `withProjectDb` also attaches the full degraded record
from its own `ensureSchemaCurrent()` call onto that same error before it
reaches the MCP caller. `assertions.embedding` has no live write-time path
today (populated only by the offline `migrate-07-reembed-corpus.js`
backfill, which is already immune — it discovers embeddable tables via a
live `pg_catalog` scan, so it never attempts to write a column it did not
already find) — but `classifyEmbeddingWriteError()` is table-agnostic, so
any future live write path gets the same behavior for free. **Not
detected**: a target where the `vector` extension itself is present but an
old version lacks the `halfvec` type (or `hnsw`/`halfvec_cosine_ops`) — the
DO block's `EXCEPTION WHEN OTHERS` still degrades gracefully there, but
`checkPgvectorGatedObjects()`'s `pg_extension` probe only checks whether
`vector` is installed at all, not its version or which types it provides;
that specific case is reported as "column missing, extension present"
(`vectorExtensionPresent: true` alongside a non-empty `missing` list) —
still loud (a `schema_apply_degraded` row IS written), just without a
version-specific diagnosis.

## `memory_search` — hybrid vector+FTS, project-scoped

Runs the same `ts_rank * 0.3 + cosine * 0.7` scoring formula the engine's
`v_memory_hits`-style views use, generalized across a closed set of 15
tables: `assertions`, `agent_exchange`, and 13 of the absorbed seam tables
(`decisions`, `gotchas`, `findings`, `research`, `incidents`, `code_index`,
`tasks`, `checklist_items`, `corpus_files`, `workflow_discovery`,
`agent_rewrites`, `policy_sections`, `session_chunks`).

Only 4 of those 15 tables (`decisions`, `gotchas`, `findings`,
`code_index`) carry a full-text-search column — the rest (including
`assertions` and `agent_exchange`) contribute a structurally-zero FTS term
and are ranked on cosine similarity alone; this mirrors the shape, not a
compromise on scoring, since a table with no `fts_vec` column has no text
index to rank against in the first place.

`memory_entry_chunks` is deliberately **excluded** from the enum: its
embedding column is a different pgvector type and dimension
(`vector(1024)`, a legacy pre-Qwen3 provider) than every other table's
`embedding halfvec(4000)` column, and there is no valid way to compare a
query vector against both in one search without either a type error or a
meaningless similarity score.

The table enum is closed — an unrecognized table name is a tool error, not
a silent skip.

## `memory_upsert` / `memory_get` — typed writes and lookups

`memory_upsert` writes one row to any of the 9 seam tables that carry a
live write surface (`decisions`, `gotchas`, `findings`, `research`,
`incidents`, `code_index`, `tasks`, `checklist_items`, `corpus_files`).
Every table is INSERT-ONLY — a primary-key or unique collision is a loud
error — **except `decisions`**, which upserts by `(project_id, topic)`:
this is the one, explicitly named carve-out in the whole schema, backed by
`decisions_audit` (an `AFTER UPDATE OR DELETE` trigger) so the update is
non-destructive in the append-only audit ledger even though the row itself
changes in place. `decisions_audit`, its underlying `audit_log` table, and
the `decisions_project_topic_unique` arbiter index this carve-out's `ON
CONFLICT (project_id, topic)` requires are canonized into
`scripts/sql/decisions-base.sql` (applied to every live project DB by the
schema-drift sentinel — see "Schema bring-forward for MCP-only sessions"
below) — before that fix, this carve-out's claim only held on the staging
consolidation target, never on a live per-project DB, because `decisions`
did not exist there at all.

Every row written through `memory_upsert` (and through `persist_decisions`,
below) is embedded inline at write time, using the same default-provider
lookup `exchange_append` uses. This is fail-soft, not fail-loud: if the
embedding provider is unreachable, the row is still written with
`embedding = NULL` and the tool response carries a warning — a caveman-
authored fact is never lost because a model server happened to be down.

`memory_get` looks up rows by an explicit natural key
(`{decisions: {topic}}`, `{findings: {id}}`, and so on) — every table also
accepts `{id: <n>}` even where the column is a server-generated `SERIAL`,
not part of the caller-writable column set.

## `memory_lint` — read-only store health sweep

Wraps the four checks already documented for the underlying engine
(`orphan_entities`, `contradicting_assertions`, `stale_unreconciled`,
`unlinked_mentions`) as a single MCP tool, project-scoped, read-only.

## `memory_view_set` / `memory_view_run` — saved retrieval views

A view is a named, versioned set of structured query objects saved onto
the same `retrieval_contract` table next-session contracts use, tagged
`kind = 'view'` — so a saved view can never be silently confused with, or
overwrite, a project's next-session contract, and vice versa.

`memory_view_run` interprets **only** the structured query-type JSON
(`entity`, `assertion`, `recency`, `vector`) already used elsewhere in this
engine's contract shape — it never executes caller-supplied SQL. Any future
raw-SQL capability is a separate, explicitly-authorized design, not an
implicit extension of this tool.

## Entity / assertion / edge CRUD

Four tools each (`_create`, `_read`, `_update`, `_suppress`) for entities,
assertions, and edges — a granular write surface for callers (an A2A
message handler, a small script) that want to write one fact without
staging a full checkpoint/close payload.

**Entity creation runs near-match surfacing.** Before inserting, it checks
for an existing entity with the same name after normalization (case-fold,
whitespace-collapse, Unicode NFC-normalize) — always exact-first, plus a
trigram-similarity fuzzy pass for names of 4 or more normalized characters.
Matches are returned as warnings; they are **never** auto-merged — a false
merge is worse than a visible duplicate. If the exact match is a
*suppressed* row, creation instead revives it (un-suppresses and updates
it) rather than inserting a second row under the same name.

**Assertion updates are a supersede**, not an in-place edit: the old row is
suppressed and time-invalidated, a new row is inserted with the corrected
object, and both happen in one transaction guarded by an optimistic
row-count check — a stale or already-superseded target rolls the whole
call back rather than silently double-superseding. For a predicate whose
registry cardinality is not 1:1, the target row's id must be given
explicitly; there is no cardinality under which this tool will guess which
row you meant.

Entities and edges have no such bi-temporal design — their `_update` tools
are plain in-place updates, forensically visible via their own audit
triggers.

## `exchange_append` / `exchange_read` — the A2A bus

Wraps the append-only `agent_exchange` log described in
`docs/agent-interop.md`. `exchange_append` keeps the "model reasons, tool
ships it" split: the caller authors the full caveman body plus a short,
distinct summary, and the tool embeds the summary (not the full body) and
performs the insert, optionally alongside one guarded state transition in
the same transaction.

`exchange_read` polls via a compound watermark —
`(created_at, id) > (afterCreatedAt, afterId)` — never a status flag, since
this table has none. An omitted watermark means "everything," not "nothing"
(a bare `> NULL` comparison would silently match zero rows in SQL's
three-valued logic, which this tool refuses to reproduce). The watermark
comparison is truncated to millisecond precision on both sides, matching
what a caller can actually round-trip through JSON (which has no native
timestamp type) — a raw microsecond-precision comparison would otherwise
cause a poller's own just-read row to reappear on its very next poll.

## `route_resolve` / `routing_profile_set` / `routing_profile_get`

`route_resolve` is idempotent per `(project_id, session_id, turn_idx,
role)` — replaying the same call returns the recorded decision unchanged.
Replaying with a *different* `overrideModel` than what was recorded does
not silently ignore the new value nor error: the response carries
`override_ignored: true` and the ignored value, so a caller can tell its
new intent was seen but not applied.

`routing_profile_set` writes a new versioned, active row and deactivates
the previous one — never an in-place edit of an existing pin's tier or
model. Concurrent calls for the same `(project_id, role)` serialize on a
transaction-scoped advisory lock (not a row-level `FOR UPDATE`, which
cannot lock a row that does not exist yet for a brand-new role).

Every label/role/session_id/project_id these tools and `route_resolve`
touch is normalized through `scripts/lib/routing-identity.js`'s ONE engine
(trim + Unicode NFC + internal-whitespace-collapse for label/role; trim
only for session_id/project_id) — applied identically at write time (this
tool, `model_registry_set`, `routing_session_override_set`) and at every
`route-resolve.js` read site, so a value written with e.g. trailing
whitespace or a combining-character accent is never unfindable later.

### `route_resolve` §17.1.1 review-identity enforcement (2026-09-06)

An optional `agentId` argument identifies which agent is making a turn's
call. Enforcement is **session-scoped** (per `project_id` + `session_id`
only — never across sessions or projects) and **bidirectional**: a
`'review'` turn is rejected with a `REVIEW_IDENTITY_COLLISION` error if its
`agentId` already appears (case-folded) on a non-review turn recorded
earlier in the same session, and a non-review turn is equally rejected if
its `agentId` already appears on a recorded `'review'` turn — same-role
repeats (review-after-review, draft-after-draft, ...) never collide. The
check is fired after the idempotent-replay check and before the
`turn_usage` INSERT; a collision is a hard error, never a silent flag or
downgrade.

Comparison is **case-folded** (`foldForComparison` = `normLabel(s)
.toLowerCase()` — plain `toLowerCase`, never `toLocaleLowerCase`) but is
**not** homoglyph- or hyphen-variant-aware: an identity that differs only
by a Unicode confusable (e.g. `U+2010` HYPHEN vs `U+002D` HYPHEN-MINUS) is
treated as a DIFFERENT identity and will not collide. This is a documented
evasion vector, not a bug — it matches `normLabel`/`normRole`'s own
case-preserving, non-confusable-aware design. `agentId` is capped at 256
characters (measured after `normLabel`) and must not contain `U+0000`;
either is a hard, non-coercing error.

The response carries a three-state `identity_enforced` field:
`true` when a check ran against a non-empty set of prior identified turns
in the session and passed; `false` with `identity_reason: 'no prior
identified turns in session'` when that set was empty; `false` with
`identity_reason: 'agentId not supplied'` when `agentId` was omitted
entirely (the pre-2026-09-06 behavior — `agent_id` is stored `NULL`, no
enforcement runs). A replayed call never throws for identity reasons: it
re-runs the same bidirectional check against the RECORDED row's own stored
`agent_id` and annotates the response with `identity_conflict: true|false`
(mirroring `override_ignored`) rather than rejecting a call that already
succeeded once. Concurrency: when `agentId` is supplied, the prior-identity
read and the INSERT run inside one transaction guarded by a
`pg_advisory_xact_lock` keyed on `(project_id, session_id, foldedAgentId)`
— the same hashtext-keyed pattern `routing_profile_set`'s M-18 fix uses —
so this is scoped per identity per session and does not serialize across
different sessions or projects.

## `model_registry_set` / `routing_session_override_set` / `routing_session_override_get` / `routing_session_override_clear`

2026-09-06 (§17 B1): closes the two gaps the §17 routing gap-audit found —
there was no way to register a model or write a session override through
the MCP surface, so `route_resolve`'s directive-chain precedence step 2
(session override) was unreachable without hand-written SQL.

`model_registry_set` upserts on normalized `label`. Every other field is
optional and "sticky" per-field: omitted leaves the existing value
untouched (or the DB default on first insert), an explicit `null` clears
it, a real value sets it — never a whole-row overwrite. Re-pointing an
existing non-`NULL` `modelId` to a different value is rejected unless
`force:true` (the prior value is not preserved anywhere once overwritten —
any `turn_usage`/`routing_session_overrides` rows recorded under the OLD
`model_id` will read as if this label had always pointed at the new one).
A `modelId` already claimed by a different label is likewise rejected
unless `force:true` (`route_resolve` joins its recommendation pool on
`label` only, so two labels sharing one `model_id` can carry independent
cost/tier configuration). Cost fields reuse `usage-telemetry.js`'s
finite/non-negative validation shape plus this table's own tighter
`NUMERIC(10,4)` range (not `turn_usage`'s `NUMERIC(12,6)`). A row with
partial cost data is excluded from `route_resolve`'s least-cost pool but
remains directive-selectable via an override/pin/`overrideModel`.

`routing_session_override_set` upserts on `(project_id, session_id, role)`
— the table's UNIQUE key, and the only write path for it. `projectId`/
`sessionId` can never be `'*'` (reserved for `routing_profiles`' global-
default pin; a `'*'` session-override row would be permanently unreadable
by `route_resolve`, which scopes that lookup by the caller's real
project/session). `role` accepts any non-empty string — deliberately no
taxonomy or allow-list, matching `route-resolve.js`'s own documented
no-hardcoded-roles design. `label` must already be registered via
`model_registry_set`. This table has **no TTL and nothing reaps stale
rows** — clearing an override once a session ends is the caller's
responsibility.

`routing_session_override_get` lists active overrides for a session
without side effects (`role` omitted returns every role) — the only way to
introspect what is active short of calling `route_resolve` itself, which
has the side effect of finalizing that turn's resolution.

`routing_session_override_clear` deletes the `(project_id, session_id,
role)` row if present, returning `{cleared:true}` or `{cleared:false}` —
clearing an already-clear key is success, never an error. `role` is
required (unlike the getter): this always targets exactly one row, never a
whole-session wildcard delete.

## `usage_record` / `usage_query`

Records token/cost figures for a turn, matched on the same
`(project_id, session_id, turn_idx, agent_role)` key `route_resolve` uses —
the common case is resolve-first, measure-after, but usage can be recorded
for a turn that never went through `route_resolve` at all. Cost, when not
supplied, is computed server-side from the model registry's per-token
rates and fails soft to `NULL` (never a guessed price) when the model or
its rates are unregistered.

## `persist_decisions` — repointed

This tool predates the rest of this page: it used to write a completely
separate, single-tenant `claude_policy_framework` database via two child
processes. It now writes the SAME project-scoped `decisions` table
`memory_upsert` writes — same ON-CONFLICT-by-topic carve-out, same
inline-embed-at-write-time, same fail-soft posture. It gained a required
`projectRoot` parameter (the old flow had no notion of project scoping) and
its response shape changed accordingly; the topic-format contract (kebab
case, at least one hyphen) is unchanged.

cm#230: this is now one of TWO entry points onto the same write path
(`scripts/lib/decisions-writer.js`'s `persistDecisionRow`) — the other is
`payload.decisions[]` on a `handoff_close`/`handoff_checkpoint` call (or the
equivalent CLI `handoff.js close/checkpoint --json -`). Before cm#230,
`payload.decisions[]` was schema-validated but silently never written; a
caller had to call `persist_decisions` separately to actually persist a
decision. Both entry points now share one row-validation function
(`validateDecisionRows`) and one write function (`persistDecisionRow`) — see
`commands/handoff/close.md`'s "Decisions" section for the close/checkpoint
field contract and failure semantics (fail-soft embedding, per-row
DIVERGENCE surfacing on validation/write failure).
