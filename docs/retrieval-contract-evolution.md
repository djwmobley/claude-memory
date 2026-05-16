# Retrieval Contract Evolution

Methodology for safely changing the retrieval contract in the `/handoff` skill.

---

## The contract model

The **retrieval contract** (`retrieval_contract` table, one row per `(project_id, name)` pair)
is a JSONB document that tells the SessionStart loader what to retrieve and how. The canonical
contract name is `default`.

### Queries array

The contract's `queries` field is a JSON array of query objects. The loader walks the array in
order, executes each query against the appropriate table, and accumulates the results until the
`loader_token_budget` (project setting, default 4000 tokens) is reached.

Each query object has this shape:

```json
{
  "kind":         "entity" | "assertion" | "vector" | "recency",
  "filter":       { "<kind-specific filter fields>" },
  "token_budget": <integer>
}
```

**Query kinds:**

| Kind        | What it retrieves                                                      |
|-------------|------------------------------------------------------------------------|
| `entity`    | Named entities from the `entities` table (optionally filtered by name).|
| `assertion` | Subject/predicate/object triples from `assertions`, decay-filtered.    |
| `vector`    | Semantic nearest-neighbor search (requires Ollama/vLLM embedding).     |
| `recency`   | Most-recently-reinforced assertions (recency window, no filter).       |

The loader executes queries **in order**; a query that exceeds the remaining token budget is
skipped. Queries are passed through unchanged — the loader does not sort, deduplicate, or
reweight them.

---

## Versioning and history

### Schema additions (W4)

Two additions to the `handoff-core` schema:

1. **`retrieval_contract.version`** — integer column (default 1). Incremented by
   `recordContractChange()` every time the queries content changes. The loader ignores this column.

2. **`retrieval_contract_history`** — audit table with one row per version bump:

   | Column       | Type        | Notes                                           |
   |--------------|-------------|-------------------------------------------------|
   | `id`         | SERIAL      | Primary key.                                    |
   | `project_id` | TEXT        | Encoded project root path.                      |
   | `name`       | TEXT        | Contract name (e.g. `default`).                 |
   | `version`    | INTEGER     | The version number of this snapshot.            |
   | `queries`    | JSONB       | Full contract document at this version.         |
   | `change_note`| TEXT        | Human-readable note (source of the change).     |
   | `changed_at` | TIMESTAMPTZ | Timestamp of the version bump.                  |

Both additions are idempotent (`ADD COLUMN IF NOT EXISTS`, `CREATE TABLE IF NOT EXISTS`) and
portable (no pgvector, no halfvec — pure stock Postgres).

### Change semantics

`recordContractChange(db, projectId, name, newQueriesObj, changeNote)`:

- If the new queries **deep-equal** the current queries → **no-op** (no version bump, no history
  row). This prevents history spam on identical re-closes.
- Otherwise → bump version, upsert the live contract row, insert a history row. The whole
  operation runs in a transaction.

This logic is non-fatal at call sites: a history-capture failure never aborts a session close.

### Init baseline

`/handoff:init` inserts the default `{queries:[]}` contract row (idempotent `DO NOTHING`), then
checks whether a history row exists. If not, it inserts a `change_note='init baseline'` row at
the contract's current version. Re-running init does not create duplicate history rows.

---

## The safe evolution procedure

Use this procedure to change the retrieval contract without losing history or breaking sessions.

### Step 1 — Design the new contract

Decide which queries to add, remove, or reorder. Review the current contract:

```bash
node scripts/bundleb-w4-contract.js list
node scripts/bundleb-w4-contract.js show <current_version>
```

### Step 2 — Apply via `/handoff:close` or direct CLI

**Preferred — via close payload:**

Include the new contract object in the `/handoff:close` JSON payload:

```json
{
  "tldr": "...",
  "contract": { "queries": [ { "kind": "assertion" }, { "kind": "recency" } ] }
}
```

`recordContractChange()` is called automatically, the version is bumped, and a history row is
written with a `close session=<session_id>` note.

**Alternative — direct rollback CLI:**

Use `rollback` to revert to a prior version:

```bash
node scripts/bundleb-w4-contract.js rollback <version>
```

This is non-destructive: it creates a new version whose queries equal the target version's
queries, with a `rollback to v<version>` change note.

### Step 3 — Validate

Start a new session. The loader reads the live contract and injects context. Verify:

- The expected sections appear in the `/handoff:resume` output.
- No unexpected data is retrieved or omitted.

```bash
node scripts/handoff.js resume
```

### Step 4 — Roll back if regression

If the new contract produces worse retrieval (missed context, token budget blown, wrong order):

```bash
node scripts/bundleb-w4-contract.js rollback <prior_version>
```

History is always preserved; rollback just adds another version entry.

### Useful CLI commands

```bash
# Show all versions
node scripts/bundleb-w4-contract.js list

# Show a specific version's queries
node scripts/bundleb-w4-contract.js show 2

# Compare two versions
node scripts/bundleb-w4-contract.js diff 1 3

# Roll back to version 1
node scripts/bundleb-w4-contract.js rollback 1
```

---

## Automated / learnable contract evolution — out of scope (precondition)

Learning the optimal contract from retrieval outcomes — automatically adjusting query order,
token budgets, or query kinds based on whether retrievals led to useful session context — requires
the **W1 outcome→ranking feedback loop to be closed**.

This means: (a) retrieval outcomes (`success`/`failure`/`irrelevant`) must be reliably captured
per session, (b) a signal-processing layer must correlate outcomes with specific query
configurations, and (c) a controller must translate that correlation into contract updates.

**W1 is currently observability-only** by owner-confirmed decision: the retrieval event logger
and outcome capture ship in W1, but the ranking/adaptation loop does not. This is not a
technical limitation — it is a deliberate scope boundary set by the project owner. The W1
outcome data is captured and available in `retrieval_events`, but no automated controller reads
it to evolve the contract.

**This is a recorded precondition, not a silent deferral.** Automated contract evolution is
explicitly gated on the owner deciding to close the W1 loop. If and when that decision is made,
the implementation path is:

1. Build an aggregation layer over `retrieval_events` that computes per-query outcome statistics.
2. Build a controller that proposes contract mutations based on those statistics.
3. Wire the controller into `/handoff:close` (or a scheduled job) so mutations are applied
   automatically with full history recording via `recordContractChange()`.

Until then, the contract evolves **manually** using the procedure above.
