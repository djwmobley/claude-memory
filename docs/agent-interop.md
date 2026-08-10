# Agent-to-agent interop

This page describes the multi-agent interop surface added on top of the
engine's Postgres schema: a shared-access contract for multiple agents
working against the same project, an append-only exchange log for
agent-to-agent (A2A) communication, generic tamper-evidence infrastructure,
and two abstract contracts (`AgentProvider`, `EmbeddingProvider`) that
operators implement to wire in their own headless-CLI and embedding
backends. None of this is engine-specific — it works the same way whether
the agents involved are the same product, different products, or a mix.

Every table and column named on this page exists on `main` as of this
writing; if you find a mismatch, the code is authoritative.

## The Postgres shared-access contract

The minimum viable form of multi-agent interop this repo ships is
deliberately small: **a shared Postgres instance, project-scoped
credentials, and a documented schema.** There is no message broker, no RPC
layer, and no agent-discovery service. Any process that can open a
Postgres connection with the right credentials and knows the schema below
can participate — a second instance of this engine, a different agent
product entirely, or a hand-written script.

Attribution travels through the schema, not through a side channel: every
write-capable table in this interop surface (and, as of PR-B, every
engine-core table) carries `source_model` and `agent_id` columns —
free-text, no enum, no CHECK against a named model list. An agent writing a
row stamps its own identity into those two columns; a reader can always
answer "who wrote this" from the row itself.

This is a **logical, not physical**, isolation model. `project_id` is the
only isolation grain — see `docs/how-memory-works.md`'s "Project isolation
and shared databases" section for the fuller limitations discussion
(cross-developer visibility on a shared Postgres instance, no per-agent
Postgres role layer). Nothing on this page changes that posture; the
tamper-evidence infrastructure below is a response to it, not a fix for it.

## The append-only exchange log: `agent_exchange`

`agent_exchange` is a project-scoped, append-only log of messages between
agents: proposals, responses, threaded replies, and broadcasts.

Columns worth knowing:

| Column | Meaning |
|---|---|
| `project_id` | The isolation grain — same convention as every other table. |
| `docket_id` | Optional link to a work-item table (`tasks`) once that table exists in the target. See "The conditional FK" below. |
| `parent_id` | Self-referencing FK — thread linkage. A reply sets this to the message it replies to. |
| `agent_id` / `source_model` | Attribution — the writer's own free-text identity. |
| `to_agent` | `NULL` means broadcast to any listener scoped to `project_id`. This is an addressing field, **not a status flag** — it says who the message is *for*, not whether anyone has *seen* it. |
| `kind` | An extensible speech-act hint: `'proposal'`, `'response'`, `'opinion'`, `'ruling'`, `'observation'`, `'research'`, `'handoff'`. Free text — extend by convention, not by adding a CHECK. |
| `body_caveman` | The message body, telegraphic/caveman-English by convention. There is no `authoring_mode` escape hatch on this table — every row is caveman. |
| `embedding` | `halfvec(4000)`, added via a graceful-degradation step so a pgvector-absent target still gets every other column. |

### Append-only means acknowledgment is a new row

There is deliberately **no `status` or `read_at` column** on this table (a
migration test statically guards against one ever being added). "I saw
this" is expressed as a *new* row — `kind='observation'`, `parent_id` set
to the message being acknowledged — never as an `UPDATE` of the original.
If you find yourself wanting to mark a row read, write a row instead.

### Watermark polling: the compound cursor

Because acknowledgment is append-only, "what's new since I last checked" is
a **watermark poll**, not a status filter. The contract is a compound
cursor over `(created_at, id)`:

```sql
SELECT * FROM agent_exchange
 WHERE project_id = $1
   AND (to_agent = $2 OR to_agent IS NULL)
   AND (created_at, id) > ($3, $4)
 ORDER BY created_at, id;
```

`created_at` alone is not enough: `NOW()` in Postgres is
`transaction_timestamp()`, so every row written inside one transaction
shares exactly one `created_at` value. `id` is a `SERIAL` column that
strictly advances even within a single transaction, so the *pair*
`(created_at, id)` is always a total order, immune to same-timestamp ties —
including the case where two writers genuinely land in the same
millisecond in production. Always compare the pair, never `created_at` by
itself.

### Threaded replies

`parent_id` self-references `agent_exchange(id)`. A reply chain is
reconstructed by walking `parent_id` back to a row where it is `NULL` (the
thread root). There is no depth limit enforced by the schema; walk until
you hit a `NULL`.

### The conditional FK on `docket_id`

`docket_id` is meant to eventually reference a `tasks` table that has not
shipped yet (it belongs to a later migration wave). Rather than block on
that dependency, the FK is added *conditionally* and reported, never
silently:

- **`tasks` absent** → the FK is **deferred**. `docket_id` is a plain
  `INTEGER` with no referential constraint until `tasks` exists.
- **`tasks` present, no orphan rows** → the FK is added `NOT VALID` and
  then `VALIDATE CONSTRAINT`s cleanly → **validated**.
- **`tasks` present, orphan `docket_id` values exist** (rows written while
  the FK was deferred, pointing at ids that never landed in `tasks`) → the
  FK is added `NOT VALID` but validation fails → **added-not-validated**.
  The orphan rows are reported by id (capped at 20), never silently
  dropped or nulled.
- **`tasks` present but the constraint is somehow absent after apply** →
  **FAIL**. This is the only one of the four states that fails the
  migration.

This is a total classification, not an allow-list: every reachable state
is named and reported, and only the last one is treated as a defect.

## Tamper-evidence: `audit_log` and `log_guarded_change()`

`audit_log` plus the `log_guarded_change()` trigger function is generic,
reusable infrastructure — it isn't specific to `agent_exchange`. Any table
with an `id` column can be wired to it, and several already are.

**This is detection, not prevention.** A shared, credential-diverse
localhost Postgres instance with no per-agent role layer cannot stop a
misbehaving writer from mutating a row it shouldn't — there is no `REVOKE`
available to enforce that here (see the shared-access contract note
above). What this infrastructure guarantees instead is that every `UPDATE`
or `DELETE` on a guarded table is captured: `table_name`, `operation`
(`'UPDATE'` or `'DELETE'`), `row_id`, `db_user`, `old_row`, `new_row`
(`NULL` for a `DELETE`). Both `old_row` and `new_row` strip the
`embedding` key before serialization — embeddings are large, derived,
re-computable data with negligible forensic value, and serializing one
into every audited `UPDATE` (including the engine's own frequent
supersession writes on `assertions`) would be an unbounded storage cost.
The trade-off is explicit: embedding *tampering itself* is not visible in
the audit diff for any table that carries an embedding column.

### Sanctioned mutations are captured too

The engine's own legitimate writes — most notably, supersession setting
`assertions.invalid_at` — are ordinary `UPDATE`s from the trigger's point
of view, so they generate `audit_log` rows exactly like an unsanctioned
mutation would. This is deliberate: the audit trail is a record of *every*
mutation, sanctioned ones included, not a filtered "suspicious activity"
log. Don't "fix" this by trying to exclude the engine's own writes.

### Upserts count as updates

`INSERT ... ON CONFLICT ... DO UPDATE` fires the `UPDATE` trigger the same
as an explicit `UPDATE` statement. An upsert onto a guarded table carries
the same audit behavior — and the same cost — as a hand-written `UPDATE`.

### Which tables are wired

`assertions` and `edges` are wired unconditionally (they exist on any
standard target). A further set of seam tables that belong to a later
migration wave (`decisions`, `gotchas`, `findings`, `research`,
`incidents`, `code_index`, `tasks`, `checklist_items`, `corpus_files`,
`workflow_discovery`, `agent_rewrites`, `policy_sections`,
`session_chunks`) are wired automatically the moment they exist, with zero
further schema changes required — the wiring step re-runs against
"present + has an `id` column" every time the migration is applied.
`audit_log` itself is never wired to its own trigger.

## Provider contracts: one identity, three surfaces

Two abstract classes describe integration points this repo does **not**
ship a concrete implementation for by design:

- **`AgentProvider`** (`scripts/lib/agent-provider.js`) — `label()` (a
  free-text self-identification string) and `async runHeadless(prompt,
  {cwd, env})`, both throwing "not implemented" on the base class.
- **`EmbeddingProvider`** (`scripts/lib/embedding-provider.js`) —
  `async embed(text)` resolving to `{vector, dims, model}`, and
  `storedDims()`, both throwing "not implemented" on the base class.
  Concrete providers are registered by **name**, as rows in
  `embedding_providers` — data, not code. Default resolution reads the row
  with `is_default = true`.

The load-bearing rule for `AgentProvider.label()` is **one identity string,
three consuming surfaces**: whatever string a concrete provider's
`label()` returns is the same string an integration stamps into
attribution columns (`source_model` / `agent_id` on every guarded table),
the model registry (`model_registry.label`, the join key
`route-resolve.js` and `usage-telemetry.js` key their lookups on), and
telemetry (`turn_usage.model_id`, matched against `model_registry.label`
by convention). If `label()` returns a different string on different
calls, or two distinct agents' providers happen to return colliding
strings, every join keyed on that identity silently conflates them — this
contract cannot detect or prevent that; it is an integration
responsibility.

Both classes ship **zero concrete providers**. Wiring a real headless-CLI
adapter or a real embedding backend onto these contracts, and rewiring the
engine's existing embedding call path (`scripts/lib/embed.js`) onto
`EmbeddingProvider`, are both out of scope for this PR — later,
human-reviewed work.

## Worked example

Two synthetic agents, `agent-a` and `agent-b`, sharing one project:

1. **`agent-a` posts a proposal** — a broadcast row (`to_agent = NULL`,
   `kind = 'proposal'`) in `agent_exchange`, stamped with its own
   `agent_id`/`source_model`.
2. **`agent-b` polls** — a watermark query using the compound cursor above,
   scoped to its own `to_agent` value plus broadcasts, picks up the
   proposal.
3. **`agent-b` acts** — it writes an attributed row reflecting what it
   found. (The origin design for this example used a dedicated `findings`
   seam table; that table doesn't exist yet on `main`; the adapted worked
   example — and the shipped smoke test — writes an attributed `assertions`
   row instead, with `source_model`/`agent_id` set to `agent-b`'s own
   label.)
4. **`agent-b` replies** — a threaded response row
   (`parent_id` = the proposal's id, `to_agent` = `agent-a`), closing the
   loop.

Every step above is exercised end-to-end by
`scripts/migrations/verify-13-exchange-smoke.js`.

## See also

- `docs/how-memory-works.md` — the broader session-seam model this interop
  surface sits on top of, including the project-isolation limitations
  section referenced above.
- `docs/glossary.md` — term definitions.
- `scripts/migrations/sql/migrate-13-agent-exchange.sql` — the DDL.
- `scripts/migrations/migrate-13-agent-exchange.js` — the migration runner.
