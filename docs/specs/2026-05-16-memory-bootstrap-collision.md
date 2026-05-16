---
change_size: LARGE
title: Memory bootstrap same-subject collision — design spec
---

# Memory Bootstrap Same-Subject Collision

**Date:** 2026-05-16
**Status:** Draft — for adversarial review

---

## 1. Problem Statement

### 1.1 Goal

Per-session context cost must be bounded and low. The project's design premise is that durable knowledge lives in Postgres and is retrieved thin per session via a retrieval contract; markdown files are thin pointers to Postgres queries, not growing narrative documents.

The maintainer's explicit anti-goals:
- Accumulating dated `HANDOFF-YYYY-MM-DD*.md` files that each assert the same subjects (bundle status, contract version, loop state) as state evolves.
- Appending to `MEMORY.md` / `CLAUDE.md` without replacing superseded content.
- Injecting TL;DR summaries that grow rather than replace.

### 1.2 The additive reflex and why it is a structural bug

Every `/handoff:close` call writes new rows via plain `INSERT` with no upsert or supersession logic (`handoff.js:1360-1372`, FACT 1). Over time, for any subject that changes (e.g. "Bundle A status"), the store accumulates multiple rows each asserting a different value at a different point in time. The retrieval loader (`handoff.js:922-990`, FACT 3) has no `GROUP BY`, no `DISTINCT ON (subject, predicate)`, no window function — it returns all same-subject rows up to `LIMIT 30`. The context window receives contradictory assertions and must resolve them heuristically; the session pays for every duplicate.

### 1.3 The bootstrap collision

When the existing history corpus is ingested (9 `HANDOFF-2026-05-1*.md` files, `DEBATE-BUNDLE-A.md`, `AS-IS-INTERSESSION-MEMORY.md`), the problem is maximally exposed: each file asserts the same subjects at different phases. The question "pick one, some, or all?" is not decorative — it determines whether the session receives current project truth or a mix of contradictory historical states.

### 1.4 Why confidence + staleness must be a deterministic resolution function

Confidence and decay already exist as columns (`handoff-core-schema.sql:67-91`, FACT 2) and as a formula in the retrieval WHERE clause (FACT 3). They are **not** currently operationalized into a same-subject resolution function because:

1. The write path never marks a prior same-subject row as superseded (FACT 1/2 — no `superseded_by`, no `status` column).
2. The retrieval path never collapses same-subject rows; it returns all that pass the decay threshold up to `LIMIT 30` (FACT 3).
3. The reinforcement bump defeats staleness discrimination entirely (FACT 4 — discussed in §2).

The precise gap: confidence × staleness concepts exist but are not wired to the decision "which of N same-subject rows is live truth." Until that wiring exists, the mechanism is decoration.

---

## 2. Why This Is Real, Not Hypothetical

Walk through the bootstrap scenario fact by fact.

### Step 1 — Ingestion produces N same-subject rows with no de-duplication

Each `/handoff:close` on a HANDOFF file runs the loop at `handoff.js:1361-1372` (FACT 1). Comment at line 1360: `// Assertions — no unique constraint on assertions table; plain INSERT.` There is no upsert on `(subject, predicate)`, no `superseded_by` column, no `status` column (`handoff-core-schema.sql:67-91`, FACT 2). Ingesting 9 HANDOFF files that each include an assertion `Bundle A status is_status <phase>` produces 9 rows in the `assertions` table with different `object` values and different `created_at` / `last_reinforced` timestamps.

### Step 2 — Retrieval has no collapse mechanism

The assertion query at `handoff.js:947-952` (gate OFF, FACT 3):

```sql
SELECT id, subject, predicate, object, confidence, source
FROM assertions
WHERE project_id = $1
  AND ($2::text IS NULL OR subject = $2)
  AND suppressed = false
  AND confidence * exp(-decay_rate * EXTRACT(EPOCH FROM (now() - last_reinforced)) / 86400) >= 1.0
ORDER BY confidence DESC, last_reinforced DESC
LIMIT 30
```

No `GROUP BY`, no `DISTINCT ON (subject, predicate)`, no window function. All 9 rows for "Bundle A status" independently satisfy `suppressed = false` and pass the decay threshold (see Step 3), rank in the result set, and are injected into the context window.

### Step 3 — The reinforcement bump defeats decay-based staleness discrimination

The loader has three query-kind branches. Only the `assertion`-kind branch executes a project-wide bump. Specifically, after any assertion-kind query that returns ≥1 row, the loader executes (`handoff.js:966-971`, FACT 4):

```sql
UPDATE assertions
SET last_reinforced = now(), last_retrieved = now()
WHERE project_id = $1
  AND ($2::text IS NULL OR subject = $2)
```

The `recency`-kind branch (`handoff.js:991-1001`) performs **no bump at all** — it only pushes ids into `retrievedAssertionIds` for C1 attribution at `handoff.js:1000`. The `vector`-kind branch (`handoff.js:1003-1006`) is a no-op stub that pushes the string `"skipped in loader (Phase 3.6 hook)"` and does not execute any UPDATE.

However, the assertion-kind bump's subject filter is `($2::text IS NULL OR subject=$2)`, and the default contract passes `subject = null` (no filter). Therefore, whenever the contract contains an assertion-kind query and that query returns ≥1 row, **every assertion row in the project gets `last_reinforced = now()`** on every load, regardless of which subjects or rows were actually retrieved.

The decay formula is `confidence * exp(-0.05 * age_days)` where `age_days = (now() - last_reinforced) / 86400` (FACT 5). After any load, `age_days ≈ 0` for all rows, so `exp(-decay_rate * age_days) ≈ 1.0` for all rows. The WHERE threshold `>= 1.0` is satisfied by any row with `confidence >= 1.0`, which is every row in the store (schema floor is 1.0, FACT 2).

Consequence: the two mechanisms that nominally handle staleness — decay suppression in the WHERE clause, and `last_reinforced DESC` as a tiebreaker — are both defeated. Decay suppression never fires during normal loader operation. The `last_reinforced` tiebreaker resolves to "whichever row was last bumped," which after a project-wide bump is effectively a tie for all rows, leaving the secondary sort (none exists beyond `LIMIT`) as the residual discriminator.

### Step 4 — Duplicates consume the fixed 4000-token budget

The token budget is enforced at `handoff.js:904`: `if (tokensUsed >= tokenBudget) break;`. The default `loader_token_budget` is 4000 tokens (`handoff.js:645`, FACT 6). Each assertion row is formatted as `- [source|conf=N] subject predicate object` and costs `Math.ceil(text.length/4)` tokens (FACT 6). As an illustrative estimate, if 9 contradictory "Bundle A status" rows each cost ~15 tokens, they consume ~135 tokens of the 4000-token budget for one subject alone. Across all repeated subjects in a 9-file bootstrap, the budget is substantially occupied by stale contradictory content before current truth can be injected.

### Step 5 — Net result

A session initialized after a 9-file bootstrap ingest receives: (a) all historical phase assertions for tracked subjects, not just current state; (b) assertions in an indeterminate order because the `last_reinforced DESC` tiebreaker is tied post-bump; (c) potentially zero remaining budget for other sections if the LIMIT 30 is hit on the assertion block. The `suppressed` flag is manual-only (`handoff-core-schema.sql:89`); no automated mechanism marks stale rows.

**Plain statement of the gap:** confidence and staleness exist as columns; they are not wired to a same-subject resolution function. The gap is structural, not a configuration issue.

---

## 3. Design Goals / Invariants

Any solution must satisfy all of the following invariants. Solutions that violate one or more are disqualified or must be scoped to a deferred phase explicitly.

| # | Invariant | Rationale |
|---|-----------|-----------|
| I-1 | At most one **live** assertion per `(subject, predicate)` injected by default retrieval. | Core requirement: "current truth" is unambiguous. |
| I-2 | Default context cost is bounded and low; stale/superseded variants do NOT consume the token budget by default. | Maintainer's stated goal: minimize per-session context tax. |
| I-3 | Superseded variants are **recoverable** on explicit deeper query (e.g. history query with a subject filter and a `superseded=true` flag). | History/audit access must remain possible. |
| I-4 | Tie-breaking is deterministic: given identical confidence, the rule "later `created_at` wins" (or equivalent) is documented and enforced, not left to sort order. | Determinism required for adversarial-reviewer trust. |
| I-5 | Ingestion order-independence OR order-defined: if the algorithm depends on chronological order, that order must be enforced by the write path, not assumed from row insertion sequence. | A batch-ingest of 9 files in arbitrary filesystem order must not produce a different result than sequential ingest. |
| I-6 | The C2 gate (feedback_loop_enabled) behavior is unaffected when `disabled`: gate-OFF SQL remains byte-identical to the pre-C2 query, as required by the `handoff.js:933` comment. | No regression to C2. |
| I-7 | The thin-pointer / replace-not-append principle is upheld: markdown files that have been fully ingested and whose assertions are live in the store are deletable without information loss. | Core project premise. |
| I-8 | The FACT 4 project-wide bump is addressed as part of or as a prerequisite to any staleness-based solution; a solution that leaves the bump in place and calls itself a staleness fix is incomplete. | The bump structurally defeats the mechanism. |

---

## 4. Solution Space

Five candidate mechanisms (4A–4E) are described below, each mapped to the code they require changing, with pros, cons, and interaction notes. They are not mutually exclusive; the complement analysis is in §5.

### 4A — Write-time upsert / supersession on `(subject, predicate)`

**Mechanism.** Change the write loop at `handoff.js:1366-1370` from plain `INSERT` to either:
- An `INSERT ... ON CONFLICT (subject, predicate, project_id) DO UPDATE SET object=$4, confidence=$5, last_reinforced=now(), session_id=$7` (requires adding a unique constraint), OR
- A two-step: `UPDATE assertions SET suppressed=true WHERE project_id=$1 AND subject=$2 AND predicate=$3 AND suppressed=false`; then `INSERT` the new row.

The two-step approach preserves the superseded trail (I-3) without requiring a unique constraint (since schema has none, FACT 2); the upsert approach collapses history entirely.

**Code changes required:**
- `handoff.js:1360-1372` — rewrite the INSERT loop.
- `handoff-core-schema.sql` — either add `UNIQUE(project_id, subject, predicate)` for the upsert variant, or no schema change for the two-step suppress variant.
- The two-step variant can use the existing `suppressed` column (`handoff-core-schema.sql:89`, FACT 2); the upsert variant discards history.

**Invariant satisfaction:** I-1 (one live row per `(subject, predicate)`), I-2 (no duplicates in retrieval), I-3 (only if two-step, not upsert), I-4 (deterministic: later write supersedes earlier), I-5 (if ingestion order is enforced by `created_at` sort — see below), I-7 (markdown deletable once live row confirmed).

**I-5 interaction — ingestion order:** Batch ingest of 9 HANDOFF files in arbitrary filesystem order would produce a different live row depending on which file is processed last. The ingestion loop must sort files by `created_at` / filename timestamp ascending so the latest value wins. This is an OPEN QUESTION (OQ-1).

**C2 gate (I-6):** Write-time change does not touch the retrieval SQL path; C2 gate behavior is unaffected.

**FACT 4 interaction:** The bump at `handoff.js:966-971` is applied at retrieval time. With only one live row per `(subject, predicate)`, the bump touches only one row per subject. The bump UPDATE does not filter on `suppressed`, so suppressed rows also receive `last_reinforced = now()` on every load. For the purposes of staleness-based retrieval of the superseded trail (I-3), this is cosmetically wrong for the superseded rows but does not affect live-row correctness. The fix is the small design choice tracked in OQ-2 (add `AND suppressed = false` to the bump UPDATE).

**Cost:** Low-to-medium. Core change is ~15 lines in `handoff.js`; two-step adds one extra `UPDATE` per assertion write.

**Risk:** Schema migration (adding unique constraint) requires care on existing DBs. Two-step avoids schema migration.

---

### 4B — Read-time same-subject collapse via `DISTINCT ON` or window function

**Mechanism.** Change the assertion SELECT at `handoff.js:947-952` (gate OFF) and `handoff.js:938-943` (gate ON) to collapse same-subject rows to the best-ranked one per `(subject, predicate)`:

Gate-OFF variant:
```sql
SELECT DISTINCT ON (subject, predicate)
  id, subject, predicate, object, confidence, source
FROM assertions
WHERE project_id = $1
  AND ($2::text IS NULL OR subject = $2)
  AND suppressed = false
  AND confidence * exp(-decay_rate * EXTRACT(EPOCH FROM (now() - last_reinforced)) / 86400) >= 1.0
ORDER BY subject, predicate, confidence DESC, last_reinforced DESC
LIMIT 30
```

Window-function variant uses `ROW_NUMBER() OVER (PARTITION BY subject, predicate ORDER BY ...)` in a subquery.

**Code changes required:**
- `handoff.js:938-953` — rewrite both gate-ON and gate-OFF SQL branches.
- The gate-OFF rewrite technically changes the SQL from byte-identical-to-pre-C2 (`handoff.js:933` comment) to a new query; this violates I-6 as written unless the comment is updated to reflect the new invariant. This is the primary risk of this approach.

**Invariant satisfaction:** I-1, I-2 (best-ranked row per subject is injected), I-3 (only if suppressed rows are excluded from default but accessible via a separate query kind), I-4 (deterministic — ordering within `DISTINCT ON` is enforced by the `ORDER BY`), I-6 **VIOLATED** unless handled (see above), I-8 **NOT addressed** (bump still hits all rows; less harmful with collapse but not fixed).

**C2 gate (I-6):** Gate-OFF SQL is no longer byte-identical to pre-C2 if `DISTINCT ON` is added. The comment at `handoff.js:933` (`// When gate is OFF: SQL is byte-identical to the pre-C2 query (no outcome_bias term).`) refers specifically to the absence of the `outcome_bias` term, not to the full SQL text. A careful reading is that the invariant is about the `outcome_bias` term, not about preventing any other change to the query. This is an interpretation question; adversarial reviewers are likely to challenge it. See OQ-3.

**FACT 4 interaction:** The bump at `handoff.js:966-971` is applied after retrieval and still bumps all matching rows (not just the DISTINCT-selected one). The bump must be changed to target only the returned `id`s if per-row staleness is to be meaningful. This is also required by I-8.

**Cost:** Medium. Two SQL rewrites plus a bump fix if I-8 is in scope.

**Risk:** Read-time collapse without write-time cleanup means every query bears the cost of scanning all duplicates before collapsing. As the store grows, this becomes a performance concern. Index `assertions_subject_idx (project_id, subject)` (FACT 2) partially mitigates.

---

### 4C — Fix the FACT 4 project-wide bump so staleness is meaningful

**Mechanism.** Change the `UPDATE` at `handoff.js:966-971` to bump only the rows that were actually returned by the SELECT (i.e., bump by `id IN (...)` rather than by `project_id` + optional `subject`). This makes `last_reinforced` reflect actual retrieval frequency per row rather than a project-wide clock reset.

```sql
UPDATE assertions
SET last_reinforced = now(), last_retrieved = now()
WHERE id = ANY($1::int[])
```

where `$1` is the array of `id` values from the SELECT result.

**Code changes required:**
- `handoff.js:965-971` — change the UPDATE to target `id = ANY(...)` using the retrieved row IDs already collected at line 964 (`retrievedAssertionIds.push(r.id)`).

This change's scope is **solely the assertion-kind bump at `handoff.js:966-971`**. The recency-kind branch (`handoff.js:991-1001`) performs no bump whatsoever — it only pushes ids into `retrievedAssertionIds` for C1 attribution at `handoff.js:1000`, so it requires no change here. The vector-kind branch (`handoff.js:1003-1006`) is a no-op stub and also requires no change.

**Invariant satisfaction:** Enables I-4 (last_reinforced becomes meaningful for tiebreaking), I-8 (bump is fixed). Does NOT alone satisfy I-1 (same-subject collapse still required). Is a prerequisite for 4A or 4B to be fully effective.

**C2 gate (I-6):** No change to the SELECT SQL; gate behavior unaffected.

**Cost:** Very low. ~3 lines changed. High leverage.

**Risk:** Low. The `retrievedAssertionIds` array is already populated at `handoff.js:964`; the fix is a direct use of that existing data.

---

### 4D — Ingestion-time chronological distillation (replay to produce one live + superseded trail)

**Mechanism.** A new ingestion script replays the HANDOFF corpus in chronological order (sort by filename timestamp or `created_at` header in the file), processing each file in sequence. For each `(subject, predicate)` encountered, the previous row is marked `suppressed=true` and a new row is inserted. The result: one live row per `(subject, predicate)` representing the last-stated value, plus a chain of suppressed historical rows.

This is operationally identical to 4A (write-time supersession) but is a one-time migration script for the existing corpus rather than a change to the ongoing write path. The ongoing write path would still need 4A applied going forward.

**Code changes required:**
- A new standalone migration script. There is no reusable JS extraction helper in `handoff.js` to call. The `/handoff:close` command (`cmdClose` at `handoff.js:1534`) reads a JSON payload from STDIN via `readStdin` (`handoff.js:141-261`); the transformation of conversation/markdown into that `{assertions:[...], entities:[...], edges:[...]}` payload is performed by the model/skill, not by any JavaScript function. For the distillation migration, each source file must be processed by a model pass that extracts assertions into the strict stdin JSON schema (subject/predicate/object/confidence/source per assertion, within `ARRAY_MAX`/`STRING_MAX`/`RECORD_STR_MAX` caps validated by `readStdin`), and that payload is piped to the `cmdClose`/`writeExtraction` write path (`handoff.js:1340`, assertion loop `handoff.js:1361-1372`) with the 4A two-step supersession applied. This is a determinate architectural constraint: the write path entry point is `cmdClose` via stdin JSON; there is no JS extraction helper to shortcut it.
- Note: `pipeline-memory-loader.js` (header `pipeline-memory-loader.js:6-7`: "reads filesystem sources, chunks via pipeline-chunker, embeds via ollamaEmbed (BATCH=8), and upserts idempotently into the three chunk tables") is the **vector/semantic store** path with chunk-level content_hash deduplication (`pipeline-memory-loader.js:17`: `--force  Bypass content_hash skip; re-embed all chunks`). It does not write to the `assertions` table and is not applicable here.

**Invariant satisfaction:** I-1 (one live row per subject after distillation), I-2 (no duplicate injections post-distillation), I-3 (superseded trail preserved), I-4 (deterministic if sort order is enforced), I-5 (depends on sort implementation), I-7 (markdown deletable post-distillation), I-8 (not addressed — bump fix is separate).

**Cost:** Medium. Requires a new migration script with per-file model-extraction passes; moderate complexity.

**Risk:** One-time migration on existing corpus is distinct from ongoing prevention. Without 4A applied to the write path, the next `/handoff:close` re-introduces duplicates.

---

### 4E — Hybrid: 4A (write-time supersession) + 4C (bump fix) + superseded trail queryable via new query kind

**Mechanism.** Combine 4A and 4C, plus add a `history` query kind to the retrieval contract that selects `suppressed=true` rows for a given subject. Default queries see only live rows; explicit history queries recover the trail.

**Code changes required:**
- All changes from 4A and 4C.
- `handoff.js:906-972` — add a `history` branch in the query kind dispatcher.
- `retrieval_contract.queries` JSON extended with `kind: 'history'` and a `filter.subject`.

**Invariant satisfaction:** All invariants I-1 through I-8.

**Vector store:** The decisions/semantic store (`claude_memory_eval_test`, Bundle A Phase 0) is a distinct surface. `pipeline-memory-loader.js:6-7` confirms it upserts idempotently into chunk tables using content_hash deduplication (`pipeline-memory-loader.js:17`). The semantic retrieval query kind is noted as "skipped in loader (Phase 3.6 hook)" per FACT 8. Whether chunk-level content_hash deduplication is sufficient to prevent semantic-level same-subject collisions (same subject, different text across different source files) is explicitly out of scope for this spec. See OQ-4.

---

### Solution Space Summary Table

| Solution | Satisfies I-1 | I-2 | I-3 | I-6 | I-8 | Addresses FACT 4 | Ongoing prevention | Migration needed |
|----------|:---:|:---:|:---:|:---:|:---:|:---:|:---:|:---:|
| 4A write-time supersession (two-step) | Yes | Yes | Yes | Yes | Partial | No | Yes | Yes |
| 4B read-time DISTINCT ON | Yes | Yes | Needs new query kind | Risk | No | No | No | No |
| 4C bump fix only | No | No | — | Yes | Yes | Yes | N/A | No |
| 4D distillation script (migration) | Yes (post) | Yes (post) | Yes | Yes | No | No | No | Yes (one-time) |
| 4E hybrid (4A + 4C + history kind) | Yes | Yes | Yes | Yes | Yes | Yes | Yes | Yes |

---

## 5. Recommended Approach

**Recommendation: 4E — 4A (two-step write-time supersession) + 4C (per-row bump fix) + history query kind.**

Reasoning:

1. **4A two-step is the correct layer for the fix.** Collapsing at read time (4B) scans growing duplicates on every query and defers the cleanup debt indefinitely. Write-time supersession ensures the store stays normalized; the read path is unchanged except for relying on `suppressed=false` which is already in the WHERE clause (FACT 3). The cost is one extra `UPDATE` per assertion on write, which is negligible.

2. **4C is a prerequisite for staleness to mean anything.** Without fixing the project-wide bump (FACT 4), `last_reinforced` is a project-wide clock and decay discrimination is structurally defeated. 4C is a ~3-line change with high leverage and no behavioral regression. It should be included regardless of which other solution is chosen.

3. **4B (read-time collapse) is complementary, not a replacement.** After 4A is in place, 4B is technically redundant for new writes. 4B may be worth adding as a safety net for any rows already in the store that predate the write-time fix, but it introduces the I-6 interpretation risk (OQ-3) and the bump-target issue. Defer 4B to a follow-on unless the migration (4D) is not performed.

4. **4D (distillation migration) is required for the existing corpus.** 4A prevents future duplicates; 4D cleans up the existing 9-HANDOFF backlog. Without 4D, the existing stale rows remain live and the bootstrap collision persists for the current corpus. The migration must sort by filename timestamp ascending to enforce I-5.

5. **History query kind closes I-3.** A `kind: 'history'` retrieval query with a `filter.subject` parameter allows the "gotchas" deliverable and any explicit audit to recover the superseded trail. It does not require any schema change; it is a new SQL branch in the loader and a new query type in the contract JSON (FACT 7).

**Implementation order:**
1. 4C (bump fix) — prerequisite; lowest risk; enables meaningful staleness going forward.
2. 4A (write-time two-step supersession) — prevents future duplicates.
3. 4D (distillation migration script) — clean up existing corpus.
4. History query kind — recovers the trail for audit/gotchas use.

---

## 6. Open Questions

Only genuine design forks with recommended leans are listed here. No manufactured questions.

**OQ-1 — Ingestion order enforcement for bootstrap distillation (I-5).**
If 4A (write-time supersession) is applied during batch ingest of the HANDOFF corpus, the file processing order determines which row becomes live. The recommended lean: sort files by the date in the filename (`HANDOFF-2026-05-1*.md`) ascending before processing, so the latest file's assertions become live. The ingestion script must enforce this sort explicitly; filesystem enumeration order is not reliable.

**OQ-2 — Bump applying to suppressed rows.**
The bump UPDATE at `handoff.js:966-971` does not filter on `suppressed = false`. Suppressed rows therefore receive `last_reinforced = now()` on every load, which is semantically wrong (a suppressed row was not "reinforced" by retrieval). The recommended lean: add `AND suppressed = false` to the bump UPDATE. This is a one-line fix and should be included with 4C.

**OQ-3 — Interpretation of the byte-identical gate-OFF invariant (I-6).**
The comment at `handoff.js:933` states the gate-OFF SQL is "byte-identical to the pre-C2 query (no outcome_bias term)." If 4B (DISTINCT ON) is added to the gate-OFF branch, this invariant is violated by the plain text of the comment, even though the `outcome_bias` term is still absent. The recommended lean: if 4B is pursued, update the comment to narrow the invariant to "no outcome_bias term in gate-OFF," not "byte-identical SQL." This is a documentation fix, not a behavioral regression. However, 4B is not recommended as a primary fix (see §5), so OQ-3 is moot if 4E is adopted.

**OQ-4 — Idempotency of the vector store for the bootstrap collision problem.**
The decisions/semantic store (`claude_memory_eval_test`, Bundle A Phase 0) is a distinct surface from the assertion store. `pipeline-memory-loader.js:6-7` confirms chunk-level content_hash deduplication as the idempotency mechanism; `pipeline-memory-loader.js:17` shows the `--force` flag bypasses it. Whether semantic same-subject/different-text duplicates (same subject asserted in different source files with different phrasing) are deduplicated by content_hash is not determinable from these facts and is out of scope for the current spec. This should be addressed before the vector retrieval path is wired into the loader (FACT 8 — currently skipped).

**OQ-5 — Whether the bootstrap distillation migration delegates supersession to the 4A-patched write path or executes the two-step supersession SQL directly.**
The §7.2 migration plan currently feeds each file's extracted payload through the write path (`cmdClose`/`writeExtraction`), which only performs two-step supersession if 4A has already been applied to `handoff.js`. If the migration is run against an un-patched write path, it silently re-creates duplicates — the dependency is stated as a §7.1 precondition but not enforced by the migration itself. The alternative is for the migration script to execute the two-step supersession SQL directly and not depend on the write-path patch ordering. Recommended lean: the migration script executes the two-step supersession SQL directly (self-contained and order-independent — a one-time migration should not depend on steady-state write-path patches having landed first), AND the 4A write-path change and the migration must use the identical two-step SQL (ideally a single shared helper) to prevent divergence. Document that 4A and the migration share one supersession implementation.

---

## 7. Bootstrap Plan (Concrete)

This section describes how to ingest the existing history corpus under the 4E recommendation so the store ends with one live assertion per `(subject, predicate)` plus a recoverable superseded trail, and the loose markdown files become deletable.

### 7.1 Preconditions

1. **Apply 4C (bump fix) first** — change `handoff.js:966-971` to `UPDATE assertions SET last_reinforced=now(), last_retrieved=now() WHERE id = ANY($1::int[])` using the `retrievedAssertionIds` array collected at line 964. Also add `AND suppressed = false` per OQ-2.
2. **Apply 4A (write-time two-step supersession)** — rewrite `handoff.js:1360-1372` to: (a) `UPDATE assertions SET suppressed=true WHERE project_id=$1 AND subject=$2 AND predicate=$3 AND suppressed=false` before each INSERT, (b) then `INSERT` the new row as before. No schema migration required; uses existing `suppressed` column (`handoff-core-schema.sql:89`).

### 7.2 Distillation migration script

A standalone script (new file) processes each source file as follows:

1. **Enumerate source files** — collect: `HANDOFF-2026-05-1*.md` (9 files), `DEBATE-BUNDLE-A.md`, `AS-IS-INTERSESSION-MEMORY.md`. Sort ascending by the date in the filename or, for files without a date in the name, by filesystem `mtime`. This enforces I-5 (OQ-1).
2. **For each file in order — model extraction pass** — a model pass reads the file and extracts assertions into the strict stdin JSON schema: `{assertions:[...], entities:[...], edges:[...]}` where each assertion object carries `subject`, `predicate`, `object`, `confidence`, and `source` string fields. The payload must satisfy the caps enforced by `readStdin` at `handoff.js:141-261`: top-level keys are whitelisted; `assertions` must be an array of plain objects; per-record string length is capped at `RECORD_STR_MAX`; array length is capped at `ARRAY_MAX`; string fields are capped at `STRING_MAX`. This transformation is performed by the model/skill — there is no JavaScript extraction helper in `handoff.js` that can be called programmatically. The resulting JSON is piped to the write path (`cmdClose` / `writeExtraction` at `handoff.js:1340`, assertion loop `handoff.js:1361-1372`) with the 4A two-step supersession applied. Because files are processed in ascending chronological order, the last file's assertions become the live rows.
3. **For each extracted assertion** — the write path applies the two-step supersession: suppress prior live rows for the same `(project_id, subject, predicate)`, then INSERT the new row. Whether this step delegates to the 4A-patched write path or executes the two-step supersession SQL directly is governed by OQ-5; the recommended lean is direct SQL execution via a shared helper so the migration is self-contained and order-independent of write-path patch sequencing.
4. **After migration** — run a verification query: `SELECT subject, predicate, COUNT(*) as live_count FROM assertions WHERE project_id=$1 AND suppressed=false GROUP BY subject, predicate HAVING COUNT(*) > 1;` — this must return zero rows (I-1 invariant).
5. **Mark source files as ingested** — write a `.ingested` marker file alongside each source file (or log a migration manifest). Do NOT delete the markdown files until the verification query passes and the maintainer confirms.

### 7.3 Contract extension for history retrieval

Add a `kind: 'history'` query branch in the `handoff.js` loader dispatcher (after the existing `assertion` and `recency` branches at `handoff.js:922-990`). The query:

```sql
SELECT id, subject, predicate, object, confidence, source, created_at
FROM assertions
WHERE project_id = $1
  AND ($2::text IS NULL OR subject = $2)
  AND suppressed = true
ORDER BY subject, predicate, created_at DESC
LIMIT 20
```

This query does NOT bump `last_reinforced` (history retrieval should not reinforce suppressed rows). The history kind is opt-in via the retrieval contract; the default contract does not include it, so the default per-session context cost is unaffected (I-2).

Add `kind: 'history'` with `filter.subject` to `retrieval_contract.queries` when historical audit is needed. Version the contract change via `recordContractChange` (`handoff.js:327`, FACT 7).

### 7.4 Post-bootstrap steady state

After the migration:
- Default retrieval sees one live assertion per `(subject, predicate)` per LIMIT-30 across all subjects.
- Stale contradictory variants are suppressed and invisible to default injection.
- History is recoverable via explicit `kind: 'history'` queries.
- The 9 HANDOFF files and supporting markdown can be archived or deleted once the maintainer confirms the verification query at 7.2 step 4 passes.
- The thin-pointer / replace-not-append invariant (I-7) is structurally enforced by the write path going forward.

---

*End of spec.*
