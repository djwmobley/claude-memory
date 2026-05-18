---
change_size: LARGE
title: Memory bootstrap same-subject collision — design spec (revised)
---

# Memory Bootstrap Same-Subject Collision

**Date:** 2026-05-16
**Status:** Draft — for adversarial review

**Hard dependency:** This spec is NOT independently shippable. It depends on the controlled
predicate-vocabulary contract (assertion extraction architecture) as a blocking prerequisite.
See §1.5 for the engineering rationale.

---

## 1. Problem Statement

### 1.1 Goal

Per-session context cost must be bounded and low. The project's design premise is that durable
knowledge lives in Postgres and is retrieved thin per session via a retrieval contract; markdown
files are thin pointers to Postgres queries, not growing narrative documents.

The maintainer's explicit anti-goals:
- Accumulating dated `HANDOFF-YYYY-MM-DD*.md` files that each assert the same subjects (bundle
  status, contract version, loop state) as state evolves.
- Appending to `MEMORY.md` / `CLAUDE.md` without replacing superseded content.
- Injecting TL;DR summaries that grow rather than replace.

### 1.2 The additive reflex and why it is a structural bug

Every `/handoff:close` call writes new rows via plain `INSERT` with no upsert or supersession
logic (`scripts/handoff.js:1361-1372`, FACT 1). Over time, for any subject that changes (e.g.
"Bundle A status"), the store accumulates multiple rows each asserting a different value at a
different point in time. The retrieval loader (`scripts/handoff.js:922-990`, FACT 3) has no
`GROUP BY`, no `DISTINCT ON (subject, predicate)`, no window function — it returns all
same-subject rows up to `LIMIT 30`. The context window receives contradictory assertions and
must resolve them heuristically; the session pays for every duplicate.

### 1.3 The bootstrap collision

When the existing history corpus is ingested (9 `HANDOFF-2026-05-1*.md` files,
`DEBATE-BUNDLE-A.md`, `AS-IS-INTERSESSION-MEMORY.md`), the problem is maximally exposed: each
file asserts the same subjects at different phases. The question "pick one, some, or all?" is
not decorative — it determines whether the session receives current project truth or a mix of
contradictory historical states. This defect was discovered directly while dogfooding the
bootstrap of this 9-file corpus.

### 1.4 Why confidence + staleness must be a deterministic resolution function

Confidence and decay already exist as columns (`scripts/sql/handoff-core-schema.sql:67-91`,
FACT 2) and as a formula in the retrieval WHERE clause (FACT 3). They are **not** currently
operationalized into a same-subject resolution function because:

1. The write path never marks a prior same-subject row as superseded (FACT 1/2 — no
   `superseded_by`, no `status` column).
2. The retrieval path never collapses same-subject rows; it returns all that pass the decay
   threshold up to `LIMIT 30` (FACT 3).
3. The reinforcement bump undermines staleness discrimination for rows returned by broad
   assertion queries (FACT 4 — discussed in §2).

The precise gap: confidence × staleness concepts exist but are not wired to the decision "which
of N same-subject rows is live truth." Until that wiring exists, the mechanism is decoration.

### 1.5 Hard dependency on the controlled predicate-vocabulary contract

This spec is NOT independently shippable. The per-predicate cardinality model required by §3
and §4A (1:1 for `is_status`, `prefers`, `chose`; 1:N for `depends_on`) can only be enforced
soundly at write time if every predicate that arrives at the write path is drawn from a
vocabulary with a declared cardinality entry.

The four predicates enumerated in the comment at `scripts/sql/handoff-core-schema.sql:71` are
only a comment, not a constraint. The `predicate` column is free `TEXT NOT NULL` with no
`CHECK` constraint. Session-close extraction is performed by the active model over an
uncontrolled predicate vocabulary (the write path entry point is `cmdClose` at
`scripts/handoff.js:1534`, which accepts any string the model produces as a predicate). A
hardcoded 4-predicate cardinality table therefore has two failure modes:

- For a predicate outside the declared 4 (any variant spelling, synonym, or novel predicate the
  model produces), the write path must choose between: (a) treating it as 1:1 — silently
  destroys valid parallel 1:N values, re-introducing the destructive-supersession defect; or (b) treating it as
  1:N — never supersedes, so the same-subject collision the fix exists to eliminate is
  reintroduced for status/preference/choice predicates.
- Neither universal fallback is correct. The cardinality model is only sound when the predicate
  vocabulary is declared and every incoming predicate is resolved against it.

Therefore, a sound per-predicate cardinality model genuinely requires the controlled
predicate-vocabulary contract (assertion extraction architecture) to exist first. The blocking
prerequisite must land before, or atomically with, the supersession logic in §4A. This is an
engineering dependency, not a process gate.

---

## 2. Why This Is Real, Not Hypothetical

Walk through the bootstrap scenario fact by fact.

### Step 1 — Ingestion produces N same-subject rows with no de-duplication

Each `/handoff:close` on a HANDOFF file runs the loop at `scripts/handoff.js:1361-1372`
(FACT 1). Comment at `scripts/handoff.js:1360`: `// Assertions — no unique constraint on
assertions table; plain INSERT.` There is no upsert on `(subject, predicate)`, no
`superseded_by` column, no `status` column (`scripts/sql/handoff-core-schema.sql:67-91`,
FACT 2). Ingesting 9 HANDOFF files that each include an assertion `Bundle A status is_status
<phase>` produces 9 rows in the `assertions` table with different `object` values and different
`created_at` / `last_reinforced` timestamps.

### Step 2 — Retrieval has no collapse mechanism

> **Note (Commit B shipped):** The `>= 1.0` decay cutoff shown in the SQL below was the
> pre-Commit-B behavior. Commit B removes this cutoff; decay is now a ranking-only signal and
> `LIMIT 30` is the guaranteed top-N floor. The collapse-mechanism defect analyzed in this
> section (no `GROUP BY` / `DISTINCT ON`) is a separate problem, not addressed by Commit B.

The assertion query (gate OFF, FACT 3, pre-Commit-B):

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

No `GROUP BY`, no `DISTINCT ON (subject, predicate)`, no window function. All 9 rows for
"Bundle A status" independently satisfy `suppressed = false` and pass the decay threshold
(see Step 3), rank in the result set, and are injected into the context window.

### Step 3 — The reinforcement bump undermines staleness discrimination for broadly-scoped queries

The loader has three query-kind branches. Only the `assertion`-kind branch executes a
reinforcement bump. Specifically, after any assertion-kind query that returns ≥1 row (guard at
`scripts/handoff.js:956`: `if (rows.length) {`), the loader executes
(`scripts/handoff.js:966-971`, FACT 4):

```sql
UPDATE assertions
SET last_reinforced = now(), last_retrieved = now()
WHERE project_id = $1
  AND ($2::text IS NULL OR subject = $2)
```

The `recency`-kind branch (`scripts/handoff.js:991-1001`) performs **no bump at all** — it
only pushes ids into `retrievedAssertionIds` for C1 attribution at `scripts/handoff.js:1000`.
The `vector`-kind branch (`scripts/handoff.js:1003-1006`) is a no-op stub.

The assertion-kind bump's subject filter is `($2::text IS NULL OR subject=$2)`, where `$2`
resolves to `q.filter?.subject || null` (`scripts/handoff.js:953`). When a contract query omits
`filter.subject` (i.e. carries no subject filter or carries `filter: {}`), the parameter is
`null` and the bump's `WHERE` clause becomes `project_id = $1` alone — every assertion row in
the project receives `last_reinforced = now()` on every load, regardless of which rows were
actually returned.

**Precision note:** The project-wide bump fires only when the assertion-kind query returns ≥1
row (guard at `scripts/handoff.js:956`). If the store is empty or all rows are suppressed, the
bump does not execute. Decay **can** still fire for rows not reached by any assertion query
since their last bump if sufficient inter-session time passes — the bump resets
`last_reinforced` only for rows within the project scope of a bumping query, not globally for
all time. The structural problem is that a broadly-scoped assertion query (no `filter.subject`)
resets `last_reinforced` for every row in the project on every load, which makes `last_reinforced
DESC` an unreliable tiebreaker for rows within that scope — all of them converge to approximately
the same timestamp after any load.

The decay formula is `confidence * exp(-0.05 * age_days)` where `age_days = (now() -
last_reinforced) / 86400` (FACT 5). After any broad-scope load, `age_days ≈ 0` for all rows in
scope, so `exp(-decay_rate * age_days) ≈ 1.0`. The WHERE threshold `>= 1.0` is satisfied by
any row with `confidence >= 1.0`, which is every row in the store (schema floor is 1.0, FACT
2). As a result, `last_reinforced DESC` effectively becomes a tie across all bumped rows,
leaving `LIMIT` sort-order as the residual discriminator — non-deterministic for same-timestamp
rows.

**Consequence for same-subject resolution:** FACT 4 defeats staleness as a same-subject
resolver for any session that executes a broad (no subject filter) assertion-kind query.
The fix (4C) is therefore a prerequisite for staleness to be a meaningful discriminator. The
conclusion and the 4C fix are unaffected by this precision; only the scope of the claim is
narrowed from "decay never fires" to "decay is defeated as a same-subject resolver for rows
reached by a broad assertion query."

**Subject-filter interaction (default contract):** The default retrieval contract is initialized
at `scripts/handoff.js:682` as `{ queries: [] }` — an empty queries array. At init time, no
assertion-kind query runs at all. Assertion-kind queries are added to the contract via
`payload.contract` in subsequent `/handoff:close` calls. When such a query is added without a
`filter.subject` field, the `q.filter?.subject || null` expression at `scripts/handoff.js:953`
resolves to null, and the bump at `scripts/handoff.js:966-971` is project-wide. A contract
query carrying an explicit `filter.subject` string restricts both the SELECT and the bump to
that subject. The original spec's claim that the default contract's assertion query carries
`subject = null` is structurally correct for any assertion-kind query that omits `filter.subject`
— the code that governs this is at `scripts/handoff.js:953` — but the claim cannot be tied to
a single static file/line showing the contract's stored content, because the contract is
dynamic DB-resident JSONB populated at close time.

### Step 4 — Duplicates consume the fixed 4000-token budget

The token budget is enforced at `scripts/handoff.js:904`: `if (tokensUsed >= tokenBudget)
break;`. The default `loader_token_budget` is `'4000'` at `scripts/handoff.js:645` (FACT 6).
Each assertion row is formatted as `- [source|conf=N] subject predicate object` and costs
`Math.ceil(text.length/4)` tokens (FACT 6). As an illustrative estimate, if 9 contradictory
"Bundle A status" rows each cost ~15 tokens, they consume ~135 tokens of the 4000-token budget
for one subject alone. Across all repeated subjects in a 9-file bootstrap, the budget is
substantially occupied by stale contradictory content before current truth can be injected.

### Step 5 — Net result

A session initialized after a 9-file bootstrap ingest receives: (a) all historical phase
assertions for tracked subjects, not just current state; (b) assertions in an indeterminate
order because the `last_reinforced DESC` tiebreaker is tied post-bump; (c) potentially zero
remaining budget for other sections if the LIMIT 30 is hit on the assertion block. The
`suppressed` flag is manual-only (`scripts/sql/handoff-core-schema.sql:89`); no automated
mechanism marks stale rows.

**Plain statement of the gap:** confidence and staleness exist as columns; they are not wired
to a same-subject resolution function. The gap is structural, not a configuration issue.

---

## 3. Design Goals / Invariants

Any solution must satisfy all of the following invariants. Solutions that violate one or more
are disqualified or must be scoped to a deferred phase explicitly.

| # | Invariant | Rationale |
|---|-----------|-----------|
| I-1 | At most one **live** assertion per `(subject, predicate)` for **1:1 predicates** (`is_status`, `prefers`, `chose`); for **1:N predicates** (`depends_on`), all live parallel objects coexist — only an exact `(subject, predicate, object)` duplicate is suppressed. | Core requirement: "current truth" is unambiguous for state/preference/choice predicates; legitimate multi-valued dependency relationships must not be destroyed. |
| I-2 | Default context cost is bounded and low; stale/superseded variants do NOT consume the token budget by default. | Maintainer's stated goal: minimize per-session context tax. |
| I-3 | Superseded variants are **recoverable** on explicit deeper query (e.g. history query with a subject filter and a `suppressed=true` flag). | History/audit access must remain possible. |
| I-4 | Tie-breaking is deterministic: given identical confidence, the rule "later `created_at` wins" (or equivalent) is documented and enforced, not left to sort order. | Determinism required for adversarial-reviewer trust. |
| I-5 | Ingestion order-independence OR order-defined: if the algorithm depends on chronological order, that order must be enforced by the write path, not assumed from row insertion sequence. | A batch-ingest of 9 files in arbitrary filesystem order must not produce a different result than sequential ingest. |
| I-6 | The C2 gate (feedback_loop_enabled) behavior is unaffected when `disabled`: gate-OFF SQL remains byte-identical to the pre-C2 query, as required by the `scripts/handoff.js:933` comment. | No regression to C2. |
| I-7 | The thin-pointer / replace-not-append principle is upheld: markdown files that have been fully ingested and whose assertions are live in the store are deletable without information loss. | Core project premise. |
| I-8 | The FACT 4 project-wide bump is addressed as part of or as a prerequisite to any staleness-based solution; a solution that leaves the bump in place and calls itself a staleness fix is incomplete. | The bump structurally defeats the mechanism for broadly-scoped queries. |

**I-1 clarification — per-predicate cardinality:**

The cardinality classification for the four canonical predicates enumerated in
`scripts/sql/handoff-core-schema.sql:71` is:

| Predicate | Cardinality | Supersession key |
|-----------|-------------|-----------------|
| `is_status` | 1:1 | `(project_id, subject, predicate)` WHERE `suppressed = false` |
| `prefers` | 1:1 | `(project_id, subject, predicate)` WHERE `suppressed = false` |
| `chose` | 1:1 | `(project_id, subject, predicate)` WHERE `suppressed = false` |
| `depends_on` | 1:N | `(project_id, subject, predicate, object)` exact duplicate only |

The cardinality source of truth is the declared predicate registry delivered by the
controlling predicate-vocabulary contract (assertion extraction architecture) — not a hardcoded
constant in this spec. This spec specifies the seed cardinalities for the four known predicates;
the registry contract is the authoritative source consulted at write time for all predicates
including any subsequently added ones.

---

## 4. Solution Space

Five candidate mechanisms (4A–4E) are described below, each mapped to the code they require
changing, with pros, cons, and interaction notes. They are not mutually exclusive; the
complement analysis is in §5.

### 4A — Write-time upsert / supersession on the per-predicate cardinality key

**Mechanism.** Change the write loop at `scripts/handoff.js:1366-1370` from plain `INSERT`
to a two-step cardinality-aware supersession:

For **1:1 predicates** (`is_status`, `prefers`, `chose`) — suppress on `(subject, predicate)`:
```sql
UPDATE assertions
  SET suppressed = true
  WHERE project_id = $1
    AND subject = $2
    AND predicate = $3
    AND suppressed = false;
-- then INSERT the new row
```

For **1:N predicates** (`depends_on`) — suppress only on exact `(subject, predicate, object)`
duplicate:
```sql
UPDATE assertions
  SET suppressed = true
  WHERE project_id = $1
    AND subject = $2
    AND predicate = $3
    AND object = $4
    AND suppressed = false;
-- then INSERT the new row
```

The two-step approach preserves the superseded trail (I-3) without requiring a unique constraint
(since schema has none, FACT 2). An upsert approach (INSERT ... ON CONFLICT DO UPDATE) would
collapse history entirely and is not recommended.

The write path must look up each incoming predicate's cardinality from the declared registry
(see §1.5) before executing the suppression step. An unrecognized predicate falls back to 1:N
(permissive default — safer than 1:1 since silent destruction of valid parallel assertions is
worse than allowing a duplicate status row, which is recoverable by subsequent correct ingest).

**Code changes required:**
- `scripts/handoff.js:1360-1372` — rewrite the INSERT loop to: (a) look up per-predicate
  cardinality from the declared registry, (b) execute the appropriate two-step suppression
  UPDATE, (c) then INSERT.
- `scripts/sql/handoff-core-schema.sql` — add two partial unique indexes, one per cardinality
  class, rather than a single universal index:
  - For 1:1 predicates: `CREATE UNIQUE INDEX IF NOT EXISTS assertions_1to1_unique ON assertions
    (project_id, subject, predicate) WHERE suppressed = false AND predicate IN ('is_status',
    'prefers', 'chose');`
  - For 1:N predicates: no partial unique index on `(project_id, subject, predicate)` alone;
    optionally a partial unique index on `(project_id, subject, predicate, object) WHERE
    suppressed = false` to prevent exact-duplicate 1:N rows.
  
  A single universal `UNIQUE(project_id, subject, predicate) WHERE suppressed = false` is
  **incorrect** — it would reject legitimate parallel 1:N rows.

**Invariant satisfaction:** I-1 (per-predicate: one live 1:1 row per `(subject, predicate)`;
parallel 1:N objects coexist), I-2 (no duplicates in retrieval), I-3 (two-step preserves
trail), I-4 (deterministic: later write supersedes earlier for 1:1; last exact duplicate wins
for 1:N), I-5 (if ingestion order is enforced — see OQ-1), I-7 (markdown deletable once live
row confirmed).

**Write atomicity requirement (I-A — new):** The suppress+INSERT pair at
`scripts/handoff.js:1360-1372` is a bare for-loop with no transaction boundary. Two concurrent
ingests on the same `(subject, predicate)` for a 1:1 predicate can both read `suppressed=false`,
both issue the suppression UPDATE, and produce double-suppression or a lost-update. The suppress
+INSERT pair must be made atomic. Two admissible mechanisms:

(a) Wrap each suppress+INSERT pair in an explicit transaction: `BEGIN` before the suppression
UPDATE; `COMMIT` after the INSERT. This is the recommended mechanism — it is implementation-
local, requires no schema change beyond what is already planned, and makes the atomicity
boundary visible in the code.

(b) Rely on a database-enforced cardinality-aware uniqueness constraint (the partial unique
indexes above) to cause one of two racing INSERTs to fail atomically, with the application
catching and retrying or surfacing the conflict. This is a valid alternative but requires the
partial unique indexes to be in place and the application to handle `UNIQUE VIOLATION` errors.

Mechanism (a) is recommended because it provides atomicity for the suppress step (which has no
DB-enforced uniqueness protection) as well as the INSERT step.

**I-5 interaction — ingestion order:** Batch ingest of 9 HANDOFF files in arbitrary filesystem
order would produce a different live 1:1 row depending on which file is processed last. The
ingestion script must sort files by the date in the filename (`HANDOFF-2026-05-1*.md`) ascending
so the latest value wins. This is an OPEN QUESTION (OQ-1).

**C2 gate (I-6):** Write-time change does not touch the retrieval SQL path; C2 gate behavior
is unaffected.

**FACT 4 interaction:** The bump at `scripts/handoff.js:966-971` is applied at retrieval time.
With only one live row per `(subject, predicate)` for 1:1 predicates, the bump touches only
that one live row per subject (assuming the query carries a subject filter). For 1:N predicates,
the bump touches all live parallel objects for that subject. The bump UPDATE does not filter on
`suppressed`, so suppressed rows also receive `last_reinforced = now()` on every load when the
bump is broad. For staleness-based retrieval of the superseded trail (I-3), this is cosmetically
wrong for suppressed rows but does not affect live-row correctness. The fix is tracked in OQ-2
(add `AND suppressed = false` to the bump UPDATE).

**Cost:** Low-to-medium. Core change is ~20 lines in `scripts/handoff.js`; two-step adds two
extra DB round-trips per assertion write (one registry lookup + one UPDATE).

**Risk:** Schema migration (adding partial unique indexes) requires care on existing DBs with
pre-existing duplicate rows (which the distillation migration at 4D must clean up first). The
cardinality lookup adds a runtime dependency on the declared predicate registry.

---

### 4B — Read-time same-subject collapse via `DISTINCT ON` or window function

**Mechanism.** Change the assertion SELECT at `scripts/handoff.js:947-952` (gate OFF) and
`scripts/handoff.js:938-943` (gate ON) to collapse same-subject rows to the best-ranked one
per `(subject, predicate)`:

Gate-OFF variant (illustrative; the `>= 1.0` cutoff is not present in the shipped loader
after Commit B — decay is ranking-only):
```sql
SELECT DISTINCT ON (subject, predicate)
  id, subject, predicate, object, confidence, source
FROM assertions
WHERE project_id = $1
  AND ($2::text IS NULL OR subject = $2)
  AND suppressed = false
ORDER BY subject, predicate,
         confidence * exp(-decay_rate * EXTRACT(EPOCH FROM (now() - last_reinforced)) / 86400) DESC,
         last_reinforced DESC
LIMIT 30
```

Window-function variant uses `ROW_NUMBER() OVER (PARTITION BY subject, predicate ORDER BY ...)`
in a subquery.

**Code changes required:**
- `scripts/handoff.js:938-953` — rewrite both gate-ON and gate-OFF SQL branches.
- The gate-OFF rewrite changes the SQL from byte-identical-to-pre-C2 (`scripts/handoff.js:933`
  comment) to a new query; this risks violating I-6 as written unless the comment is updated
  to reflect the new invariant.

**Invariant satisfaction:** I-1 (best-ranked row per subject is injected, noting the 1:N
cardinality issue — DISTINCT ON would collapse 1:N parallel objects incorrectly), I-2, I-3
(only if suppressed rows are accessible via a separate query kind), I-4 (deterministic — ordering
within `DISTINCT ON` is enforced by the `ORDER BY`), I-6 **RISKY** unless handled, I-8 **NOT
addressed** (bump still hits all rows; less harmful with collapse but not fixed). The 1:N
cardinality issue is a material defect in the DISTINCT ON approach: it would suppress all but
the highest-ranked `depends_on` object for any subject, losing valid parallel dependency
relationships.

**C2 gate (I-6):** Gate-OFF SQL is no longer byte-identical to pre-C2 if `DISTINCT ON` is
added. See OQ-3.

**FACT 4 interaction:** The bump must be changed to target only the returned `id`s if per-row
staleness is to be meaningful. Required by I-8.

**Cost:** Medium. Two SQL rewrites plus a bump fix if I-8 is in scope.

**Risk:** Read-time collapse without write-time cleanup means every query bears the cost of
scanning all duplicates before collapsing. The 1:N cardinality defect makes this approach
incorrect for `depends_on`-class predicates without additional cardinality-aware logic.

---

### 4C — Fix the FACT 4 project-wide bump so staleness is meaningful

**Mechanism.** Change the `UPDATE` at `scripts/handoff.js:966-971` to bump only the rows that
were actually returned by the SELECT (i.e., bump by `id IN (...)` rather than by `project_id`
+ optional `subject`). This makes `last_reinforced` reflect actual retrieval frequency per row
rather than a project-wide clock reset.

```sql
UPDATE assertions
SET last_reinforced = now(), last_retrieved = now()
WHERE id = ANY($1::int[])
```

where `$1` is the array of `id` values from the SELECT result.

**Code changes required:**
- `scripts/handoff.js:965-971` — change the UPDATE to target `id = ANY(...)` using the
  retrieved row IDs already collected at `scripts/handoff.js:964` (`retrievedAssertionIds.push(r.id)`).

This change's scope is **solely** the assertion-kind bump at `scripts/handoff.js:966-971`.
The recency-kind branch (`scripts/handoff.js:991-1001`) performs no bump whatsoever — it only
pushes ids into `retrievedAssertionIds` for C1 attribution at `scripts/handoff.js:1000`, so it
requires no change here. The vector-kind branch (`scripts/handoff.js:1003-1006`) is a no-op
stub and also requires no change.

**Invariant satisfaction:** Enables I-4 (last_reinforced becomes meaningful for tiebreaking),
I-8 (bump is fixed). Does NOT alone satisfy I-1 (same-subject collapse still required). Is a
prerequisite for 4A or 4B to be fully effective.

**Dedup/eviction orthogonality — explicitly stated:**

The confidence×staleness scoring used by the retrieval ORDER BY and the decay WHERE clause
serves two distinct functions that must not be conflated:

1. **Eviction ranking** (across distinct subjects): The `ORDER BY confidence DESC,
   last_reinforced DESC` at `scripts/handoff.js:952` ranks which subjects and assertions are
   admitted to the context window under the 4000-token clamp (`scripts/handoff.js:904`). This
   is an eviction ranker operating across all subjects — deciding which distinct pieces of
   knowledge make it into context. After 4A ensures one live row per 1:1 predicate, the eviction
   ranker operates on a clean input set where each subject/predicate pair is represented once.
   It is meaningful and correct for its purpose.

2. **Within-subject tiebreaking** (same subject, competing live rows): Before 4A, multiple live
   rows for the same `(subject, predicate)` create an ambiguity the eviction ranker cannot
   resolve correctly — it must choose one of N contradictory values with no semantic basis. 4A
   eliminates this ambiguity at write time, making the eviction ranker's input correct.

These two functions are **orthogonal**: 4A (write-time supersession) makes the eviction ranker
meaningful; it does not make the ranker vestigial. The eviction ranker continues to operate
across distinct subjects under the token clamp regardless of 4A.

**Consequence for 4C:** If the bump fix (4C) does not land, the eviction ranker operates on
stale `last_reinforced` timestamps — every row has been reset to approximately the same
timestamp by the project-wide bump. A recently-updated subject's assertions receive no recency
advantage over old assertions, because both were bumped identically. This is a **correctness
defect in the eviction ranker's input**, not a tiebreak edge case. 4C is a correctness
requirement for the eviction ranker to function as designed; it is not an optional enhancement.

**C2 gate (I-6):** No change to the SELECT SQL; gate behavior unaffected.

**Cost:** Very low. ~3 lines changed. High leverage.

**Risk:** Low. The `retrievedAssertionIds` array is already populated at
`scripts/handoff.js:964`; the fix is a direct use of that existing data.

---

### 4D — Ingestion-time chronological distillation (replay to produce one live + superseded
trail)

**Mechanism.** A new ingestion script replays the HANDOFF corpus in chronological order (sort
by filename timestamp or `created_at` header in the file), processing each file in sequence.
For each `(subject, predicate)` pair with 1:1 cardinality encountered, the previous row is
marked `suppressed=true` and a new row is inserted. For 1:N predicates, only exact
`(subject, predicate, object)` duplicates are suppressed. The result: one live 1:1 row per
`(subject, predicate)` for status/preference/choice predicates, plus preserved 1:N parallel
objects, plus a chain of suppressed historical rows.

This is operationally analogous to 4A (write-time supersession) but is a one-time migration
script for the existing corpus rather than a change to the ongoing write path. The ongoing write
path still needs 4A applied going forward.

**Code changes required:**
- A new standalone migration script. The `/handoff:close` command (`cmdClose` at
  `scripts/handoff.js:1534`) reads a JSON payload from stdin via `readStdin`
  (`scripts/handoff.js:148-263`); the transformation of conversation/markdown into that
  `{assertions:[...], entities:[...], edges:[...]}` payload is performed by the model/skill,
  not by any JavaScript function. For the distillation migration, each source file must be
  processed by a model pass that extracts assertions into the strict stdin JSON schema
  (subject/predicate/object/confidence/source per assertion, within `ARRAY_MAX` / `STRING_MAX`
  / `RECORD_STR_MAX` caps validated by `readStdin`), and that payload is piped to the write
  path with the 4A two-step cardinality-aware supersession applied.
- Note: `pipeline-memory-loader.js` is the vector/semantic store path and does not write to
  the `assertions` table; it is not applicable here.

**Invariant satisfaction:** I-1 (correct per-predicate cardinality after distillation), I-2,
I-3 (superseded trail preserved), I-4 (deterministic if sort order enforced), I-5 (depends on
sort implementation), I-7 (markdown deletable post-distillation), I-8 (not addressed — bump
fix is separate).

**Cost:** Medium. Requires a new migration script with per-file model-extraction passes;
moderate complexity.

**Risk:** One-time migration on existing corpus is distinct from ongoing prevention. Without 4A
applied to the write path, the next `/handoff:close` re-introduces duplicates.

---

### 4E — Hybrid: 4A (write-time supersession) + 4C (bump fix) + superseded trail queryable
via new query kind

**Mechanism.** Combine 4A and 4C, plus add a `history` query kind to the retrieval contract
that selects `suppressed=true` rows for a given subject. Default queries see only live rows;
explicit history queries recover the trail.

**Code changes required:**
- All changes from 4A and 4C.
- `scripts/handoff.js:906-972` — add a `history` branch in the query kind dispatcher.
- `retrieval_contract.queries` JSON extended with `kind: 'history'` and a `filter.subject`.

**Invariant satisfaction:** All invariants I-1 through I-8.

**Vector store:** The decisions/semantic store (`claude_memory_eval_test`, Bundle A Phase 0) is
a distinct surface. `pipeline-memory-loader.js` confirms it upserts idempotently into chunk
tables using content_hash deduplication. The semantic retrieval query kind is noted as "skipped
in loader (Phase 3.6 hook)" per FACT 8. Whether chunk-level content_hash deduplication is
sufficient to prevent semantic-level same-subject collisions (same subject, different text across
different source files) is explicitly out of scope for this spec. See OQ-4.

---

### Solution Space Summary Table

| Solution | I-1 (cardinality-aware) | I-2 | I-3 | I-6 | I-8 | Ongoing prevention | Migration needed |
|----------|:---:|:---:|:---:|:---:|:---:|:---:|:---:|
| 4A write-time (two-step, cardinality-aware) | Yes | Yes | Yes | Yes | Partial | Yes | Yes |
| 4B read-time DISTINCT ON | Partial (1:N defect) | Yes | Needs new kind | Risk | No | No | No |
| 4C bump fix only | No | No | — | Yes | Yes | N/A | No |
| 4D distillation script | Yes (post) | Yes (post) | Yes | Yes | No | No | Yes (one-time) |
| 4E hybrid (4A + 4C + history kind) | Yes | Yes | Yes | Yes | Yes | Yes | Yes |

---

## 5. Recommended Approach

**Recommendation: 4E — 4A (two-step cardinality-aware write-time supersession) + 4C (per-row
bump fix) + history query kind.**

Reasoning:

1. **4A two-step is the correct layer for the fix.** Collapsing at read time (4B) scans growing
   duplicates on every query, does not correctly handle 1:N predicates, and defers the cleanup
   debt indefinitely. Write-time supersession ensures the store stays normalized; the read path
   is unchanged except for relying on `suppressed=false` which is already in the WHERE clause
   (FACT 3). The cost is one extra UPDATE per assertion on write, which is negligible.

2. **4C is a prerequisite for the eviction ranker to function correctly.** Without fixing the
   project-wide bump (FACT 4), `last_reinforced` is a project-wide clock and the eviction
   ranker operates on stale timestamps. 4C is a ~3-line change with high leverage and no
   behavioral regression. It should be included regardless of which other solution is chosen.

3. **4B (read-time collapse) is complementary, not a replacement.** After 4A is in place, 4B is
   technically redundant for new writes. 4B may be worth adding as a safety net for any rows
   already in the store that predate the write-time fix, but it introduces the I-6 interpretation
   risk (OQ-3) and the 1:N cardinality defect for DISTINCT ON. Defer 4B to a follow-on unless
   the migration (4D) is not performed.

4. **4D (distillation migration) is required for the existing corpus.** 4A prevents future
   duplicates; 4D cleans up the existing 9-HANDOFF backlog. Without 4D, the existing stale rows
   remain live and the bootstrap collision persists for the current corpus. The migration must
   sort by filename timestamp ascending to enforce I-5.

5. **History query kind closes I-3.** A `kind: 'history'` retrieval query with a
   `filter.subject` parameter allows any explicit audit to recover the superseded trail. It does
   not require any schema change; it is a new SQL branch in the loader and a new query type in
   the contract JSON (FACT 7).

**Implementation order:**
1. 4C (bump fix) — prerequisite; lowest risk; enables correct eviction ranking going forward.
2. 4A (write-time two-step cardinality-aware supersession) — prevents future duplicates.
3. 4D (distillation migration script) — clean up existing corpus.
4. History query kind — recovers the trail for audit use.

**Note:** Steps 1 and 2 depend on the controlled predicate-vocabulary contract (§1.5). The
registry must be available before the supersession logic is activated; see §1.5 and OQ-D in
the blocking prerequisite spec.

---

## 6. Open Questions

Only genuine design forks with recommended leans are listed here.

**OQ-1 — Ingestion order enforcement for bootstrap distillation (I-5).**
If 4A (write-time supersession) is applied during batch ingest of the HANDOFF corpus, the file
processing order determines which row becomes live for 1:1 predicates. The recommended lean:
sort files by the date in the filename (`HANDOFF-2026-05-1*.md`) ascending before processing,
so the latest file's assertions become live. The ingestion script must enforce this sort
explicitly; filesystem enumeration order is not reliable.

**OQ-2 — Bump applying to suppressed rows.**
The bump UPDATE at `scripts/handoff.js:966-971` does not filter on `suppressed = false`.
Suppressed rows therefore receive `last_reinforced = now()` on every load, which is semantically
wrong (a suppressed row was not "reinforced" by retrieval). The recommended lean: add
`AND suppressed = false` to the bump UPDATE. This is a one-line fix and should be included
with 4C.

**OQ-3 — Interpretation of the byte-identical gate-OFF invariant (I-6).**
The comment at `scripts/handoff.js:933` states the gate-OFF SQL is "byte-identical to the
pre-C2 query (no outcome_bias term)." If 4B (DISTINCT ON) is added to the gate-OFF branch,
this invariant is violated by the plain text of the comment. The recommended lean: if 4B is
pursued, update the comment to narrow the invariant to "no outcome_bias term in gate-OFF," not
"byte-identical SQL." However, 4B is not recommended as a primary fix (see §5), so OQ-3 is
moot if 4E is adopted.

**OQ-4 — Idempotency of the vector store for the bootstrap collision problem.**
The decisions/semantic store is a distinct surface from the assertion store. Whether semantic
same-subject/different-text duplicates are deduplicated by content_hash is not determinable
from these facts and is out of scope for the current spec. This should be addressed before the
vector retrieval path is wired into the loader (currently skipped as "Phase 3.6 hook").

**OQ-5 — Supersession contract: shared contract and invariant test fixture, not shared
implementation.**
The write path (steady-state) and the distillation migration (4D) both apply per-predicate
supersession logic. The migration is bulk DML operating on a cold dataset; the write path is a
verified per-row loop (`scripts/handoff.js:1360-1372`) operating on a live stream. Coupling
them in a shared implementation entangles two different performance and error-handling regimes.

**Restated OQ-5:** Share the supersession **CONTRACT** — identical WHERE-key per predicate
cardinality (1:1: suppress on `(project_id, subject, predicate, suppressed=false)`;
1:N: suppress on `(project_id, subject, predicate, object, suppressed=false)`); identical
ordering rule for 1:N tie-resolution when two ingests of the same exact `(subject, predicate,
object)` arrive (later `created_at` wins) — plus a **shared invariant test fixture** that
both the migration and the steady-state write path must pass. Implementations may diverge; the
test fixture is the enforcement mechanism. The earlier framing that both paths should share a
common helper implementation is retracted; the concern that motivated it (preventing semantic
drift between paths) is addressed at the contract + test-fixture level.

**Test fixture requirement:** The invariant test fixture must verify at minimum:
- After ingesting two assertions with identical `(subject, predicate)` and different `object`
  values for a 1:1 predicate, exactly one live row exists per `(subject, predicate)` and the
  surviving object is from the later ingest.
- After ingesting two assertions with identical `(subject, predicate)` and different `object`
  values for a 1:N predicate, both live rows exist (no suppression of the earlier one).
- After ingesting two assertions with identical `(subject, predicate, object)` for a 1:N
  predicate, exactly one live row exists (exact-duplicate suppression).

This fixture must be runnable against both the migration code path and the steady-state write
path.

---

## 7. Bootstrap Plan — CLOSED (mechanisms shipped; corpus migration will not run)

**Mechanisms shipped.** The supersession mechanisms specified in this document — 4A two-step
cardinality-aware write-time supersession, 4C per-row bump fix, the `history` query kind,
`scripts/distill-corpus.js` distillation script, and the OQ-5 invariant fixture — shipped in
PR #35 (commit `6d9ca0a`) and are the steady-state write-path behavior going forward.

**Corpus migration: SKIP.** The one-time distillation migration over the existing
HANDOFF/markdown corpus will not be run — decided SKIP by the maintainer. The legacy corpus
is therefore NOT distilled, and those markdown files are NOT to be deleted on the basis of
this section.

**Steady state going forward.** New writes are governed by the shipped 4A/4C write path,
which enforces cardinality-aware supersession on every ingest. This is unaffected by the
un-run migration.

*End of spec.*
