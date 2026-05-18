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
| `assertion` | Subject/predicate/object triples from `assertions`, decay-ranked (top-N via LIMIT). |
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

## Automated / learnable contract evolution — Bundle C3

**Status: implemented and shipped.** The precondition described in the original note (W1 loop
closed, outcomes captured per session) was fulfilled by Bundles B W1 through C2. Bundle C3 adds
the rules engine that automatically adjusts query `token_budget` values based on observed outcome
patterns in `retrieval_events`. It is **fully gated** (default OFF) and **byte-identical when
disabled**.

---

### The closed feedback loop end-to-end

```
Session load (C1) → retrieval_events row + retrieval_event_assertions attribution
       ↓
Session close (W1 outcome capture) → outcome stamped on retrieval_events rows
       ↓
Session close (C2) → outcome_bias on assertions nudged ± per kind feedback
       ↓
Session close (C3) → contract token_budget evolved from per-kind outcome rates
       ↓
Next session load → new budgets drive retrieval; loop restarts
```

All three stages fire at `/handoff:close` in sequence. Each stage is independently gated.

---

### C3 gate setting

| Setting key                    | Default     | Description                                                    |
|-------------------------------|-------------|----------------------------------------------------------------|
| `contract_evolution_enabled`  | `'disabled'`| Master gate. `'enabled'` activates the rules engine at close. |
| `contract_evolution_window_days` | `'30'`  | Rolling window (days) for outcome aggregation.                 |
| `contract_evolution_min_events`  | `'10'`  | Min events per kind before any rule may fire (thin-data guard).|
| `contract_evolution_failure_threshold` | `'0.5'` | Failure+irrelevant rate that triggers budget reduction.   |
| `contract_evolution_budget_floor`   | `'200'` | Min `token_budget` for any kind. Never reduced below this.    |
| `contract_evolution_budget_step`    | `'200'` | Max budget change per evolution pass (gradual, bounded).       |

**Gate independence:** `contract_evolution_enabled` is completely independent of
`feedback_loop_enabled` (C2). You can enable either or both. When both are enabled, C2 bias
feedback and C3 budget evolution both fire at close. When C3 is `'disabled'`, **zero contract
mutation occurs** — `cmdClose` output is byte-identical to pre-C3.

Enable via project settings:

```bash
psql -d claude_memory_eval_test -c \
  "INSERT INTO project_settings (project_id, key, value)
   VALUES ('<your_project_id>', 'contract_evolution_enabled', 'enabled')
   ON CONFLICT (project_id, key) DO UPDATE SET value = 'enabled'"
```

---

### Evolution rule set (exact, deterministic)

Two rules fire per pass. Both are bounded; at most one budget reduction occurs per close.

**RULE 1 — Underperforming kind budget reduction:**

For each `kind` that appears in `retrieval_events.query_text` within the rolling window
(`kinds=<k1,k2,...>` field in the encoded query text):

- Compute `failure_rate = (failure_count + irrelevant_count) / total_count`.
- If `failure_rate > failure_threshold` AND `total_count >= min_events`:
  - Find the kind's `token_budget` in the live contract.
  - Compute `reduction = min(budget_step, max(0, current_budget - budget_floor))`.
  - If `reduction > 0`: apply the reduction to the worst-performing kind (highest failure rate).
  - **At most one kind is reduced per pass** (the single worst performer).

**RULE 2 — Reallocation to best performer:**

Simultaneously with Rule 1:

- If a reduction was applied and the best-performing kind (lowest failure rate, qualifying) is
  a different entry in the contract, add the `reduction` amount to the best performer's budget.
- This keeps the total budget envelope constant.

**Invariants enforced:**

- No kind is ever deleted (budget floor is > 0 by default).
- `token_budget` for the reduced kind is always `>= budget_floor`.
- Total budget across all kinds is unchanged (reallocation is exact).
- At most one reduction per close pass (gradual, recoverable).
- No evolution if the worst-failing kind is not present in the live contract queries.
- No evolution if any qualifying kind has fewer than `min_events` in the window.

---

### Idempotency

C3 uses the same marker pattern as C2. After a successful evolution pass, the key
`contract_evolved:<sessionId>` is written to `project_settings`. A re-run of `cmdClose` with
the same `session_id` detects the marker and skips the rules engine entirely — no second
contract change is written. The output will include `"C3 evolution: already applied for session
<id> — skipping (idempotent)"`.

---

### Non-fatal guarantees

The entire C3 block in `cmdClose` is wrapped in a `try/catch`. Any failure — DB error, missing
contract row, malformed query text, unexpected exception — logs to stderr and returns without
interrupting `cmdClose`. The session close always completes. The worst failure mode is a missed
evolution pass; it is logged and retried on the next close.

---

### Inspecting evolution history

Every evolution pass calls `recordContractChange()`, which writes a history row with a
structured `change_note`:

```
auto-evolve: reduced '<kind>' by <amount> → reallocated to '<best_kind>'
(failureRate=<x.xx>>threshold=<y>,  window=<d>d, n=<events>)
```

Inspect via the W4 CLI:

```bash
# List all versions and their change notes
node scripts/bundleb-w4-contract.js list

# Show the queries at a specific version
node scripts/bundleb-w4-contract.js show 3

# Compare two versions
node scripts/bundleb-w4-contract.js diff 2 3
```

---

### Rolling back an auto-evolved contract

Use the existing W4 rollback CLI. Rollback is non-destructive: it creates a new version entry
whose queries equal the target version's queries:

```bash
# Revert to version 2
node scripts/bundleb-w4-contract.js rollback 2
```

History is always preserved. After rollback, the next evolution pass (if gate is still enabled)
will start from the rolled-back queries. If you want to prevent re-evolution of the same
pattern, tune the threshold or disable the gate:

```bash
psql -d claude_memory_eval_test -c \
  "UPDATE project_settings SET value = 'disabled'
   WHERE project_id = '<your_project_id>'
     AND key = 'contract_evolution_enabled'"
```

---

### Gate interaction summary

| `feedback_loop_enabled` | `contract_evolution_enabled` | Behavior at close                                       |
|------------------------|-----------------------------|---------------------------------------------------------|
| `disabled`             | `disabled`                  | No feedback, no evolution. Byte-identical to pre-C2.    |
| `enabled`              | `disabled`                  | C2 bias feedback runs; no contract mutation.            |
| `disabled`             | `enabled`                   | C3 budget evolution runs using raw outcome counts only. |
| `enabled`              | `enabled`                   | Both C2 bias and C3 budget evolution run (full loop).   |
