---
title: Assertion Extraction Architecture — Controlled Predicate Vocabulary and Background Extraction
change_size: LARGE
---

# Assertion Extraction Architecture: Controlled Predicate Vocabulary and Background Structured-Output Extraction

**Date:** 2026-05-16
**Status:** Draft — for adversarial review

---

## 1. Problem Statement

### 1.1 Current extraction architecture

Assertion extraction is currently performed inline at session close. When the `/handoff:close` command executes (`cmdClose` at `scripts/handoff.js:1534`), it reads a JSON payload from stdin via `readStdin` (`scripts/handoff.js:148-263`). That payload contains an `assertions` array whose contents — subject, predicate, object, confidence, source — are produced by the active model or skill during the session-close pass, operating over a live conversation transcript or source document. The payload passes through `writeExtraction` (`scripts/handoff.js:1340-1397`), which writes each assertion via a plain `INSERT` in the loop at `scripts/handoff.js:1361-1372`.

The critical architectural fact: there is no JavaScript extraction helper in `scripts/handoff.js` that transforms source content into the assertion payload. The transformation from source document (conversation transcript, HANDOFF markdown file, or other source) to the structured `{assertions:[...]}` payload is performed entirely by the model/skill. The write path accepts what the model produces; it does not constrain what the model produces beyond the structural caps enforced by `readStdin` (array length `ARRAY_MAX=200`, per-record string length `RECORD_STR_MAX=1000`, top-level key allowlist).

### 1.2 The uncontrolled predicate vocabulary

Because the extraction pass is a model/skill operation, the predicates that appear in the `assertions` array are not drawn from a declared registry. There is no pre-enumerated set of allowed predicates against which the model's output is validated before write. The only canonical enumeration of predicates in the current system appears in the comment at `scripts/sql/handoff-core-schema.sql:71`:

```sql
predicate TEXT NOT NULL,   -- e.g. 'depends_on', 'is_status', 'prefers', 'chose'
```

This is a comment, not a constraint. The schema enforces no CHECK constraint on the `predicate` column. A model extraction pass can write any string as a predicate — `"uses"`, `"depends on"`, `"status"`, `"is_status"`, `"prefers"`, or any variant — and the write path will accept it without error. Over multiple sessions and multiple extraction passes, the live predicate vocabulary in the store drifts according to whatever strings the extraction model happened to produce. Predicate identity becomes fuzzy across sessions.

### 1.3 Why uncontrolled vocabulary makes cardinality unenforceable

The four canonical predicates enumerated at `scripts/sql/handoff-core-schema.sql:71` are not uniform cardinality:

| Predicate | Cardinality | Semantics |
|-----------|-------------|-----------|
| `is_status` | 1:1 | Exactly one live status per subject at a time |
| `prefers` | 1:1 | Exactly one live preference per subject per dimension |
| `chose` | 1:1 | Exactly one recorded choice per subject |
| `depends_on` | 1:N | A subject may legitimately depend on multiple objects simultaneously |

Enforcing per-predicate cardinality at write time requires knowing, for each predicate string that arrives in a payload, what cardinality rule applies to it. If the predicate vocabulary is open and uncontrolled, there is no reliable way to perform that lookup. A write path that intends to enforce "suppress prior rows for 1:1 predicates, allow parallel rows for 1:N predicates" cannot determine which rule to apply when it receives a predicate string that may or may not match a known predicate — especially across sessions where extraction has produced variant spellings or novel predicates the system has never seen.

The per-predicate cardinality model (1:1 vs 1:N) and the supersession key that flows from it (suppress on `(subject, predicate)` for 1:1; suppress on `(subject, predicate, object)` exact duplicate for 1:N) can only be enforced soundly if the predicate that arrives at the write path is drawn from a vocabulary that has a declared cardinality entry. Without that contract, the write path must choose between two unsound options: (a) treat all predicates as 1:1 — silently destructive for any 1:N predicate, or (b) treat all predicates as 1:N — fails to deduplicate status/preference/choice assertions and re-creates the same-subject collision problem. Neither is correct as a universal rule.

### 1.4 Relationship to the memory bootstrap same-subject collision fix

The memory bootstrap same-subject collision fix (hereafter the "collision fix") addresses the structural defect whereby the write path at `scripts/handoff.js:1361-1372` performs a plain `INSERT` with no supersession logic, accumulating multiple contradictory live rows per `(subject, predicate)` over time. Its recommended implementation (write-time two-step supersession) requires a per-predicate cardinality model to determine the correct supersession key — suppressing on `(subject, predicate)` for 1:1 predicates and on `(subject, predicate, object)` for 1:N predicates.

**Dependency direction:** The collision fix is not independently shippable. Its per-predicate cardinality model (1:1 for `is_status`, `prefers`, `chose`; 1:N for `depends_on`) is only sound if every predicate that reaches the write path is drawn from a vocabulary with a declared cardinality entry — exactly the controlled predicate-vocabulary contract specified in this document. Without that contract in place first, the collision fix's supersession step cannot reliably determine which key to apply to an incoming predicate (see §1.3), so it would have to fall back to one of the two unsound universal rules and would re-create the defect it set out to remove. The collision fix therefore declares a hard dependency on the controlled predicate-vocabulary contract delivered here. The dependency arrow points in one direction only: the collision fix depends on this contract; this document is the blocking prerequisite for the collision fix, not a later enhancement downstream of it.

---

## 2. Proposed Architecture

### 2.1 Controlled predicate vocabulary registry

A declared predicate registry is introduced as the authoritative source of truth for all predicates the system recognizes. The registry is a structured artifact (a JavaScript constant, a JSON file, or a small database table — mechanism choice is an open question; see §5) that enumerates every recognized predicate with the following fields per entry:

| Field | Type | Description |
|-------|------|-------------|
| `predicate` | string | The canonical predicate string (exact, case-sensitive) |
| `cardinality` | `"1:1"` or `"1:N"` | Whether at most one live object is allowed per (subject, predicate) |
| `description` | string | Human-readable semantics |
| `added_version` | string | Schema/registry version when added |

**Seed registry** (sourced from `scripts/sql/handoff-core-schema.sql:71` enumeration):

| `predicate` | `cardinality` | `description` |
|-------------|---------------|---------------|
| `is_status` | `1:1` | Current status of a project entity |
| `prefers` | `1:1` | Stated preference of a subject |
| `chose` | `1:1` | Recorded decision or choice made by a subject |
| `depends_on` | `1:N` | Subject depends on the named object; multiple objects are valid simultaneously |

The registry is the single source of truth consulted by: (a) the write path to determine the supersession key per predicate, (b) the extraction model to constrain what predicates it may emit, and (c) any validation layer that pre-screens a payload before write.

### 2.2 Background structured-output extraction

Assertion extraction is relocated off the session-close critical path. Under the proposed architecture:

1. **Extraction input:** A source document (session transcript, HANDOFF markdown file, or other source) is submitted to an extraction pass outside the synchronous `cmdClose` / `readStdin` flow.

2. **Structured output constraint:** The extraction pass uses a JSON schema constraint (structured output / constrained generation) that limits the `predicate` field of each extracted assertion to a string drawn from the declared predicate registry. The extraction model cannot produce a predicate that is not in the registry without either violating the schema constraint (which the structured-output mechanism enforces at generation time) or triggering a post-generation validation error.

3. **Off critical path:** The extraction pass runs as a background job — either triggered asynchronously after session close or as a separate scheduled pass over queued source documents. The synchronous `cmdClose` path at `scripts/handoff.js:1534` may optionally receive a pre-extracted payload (the current `--json -` mode via `readStdin`) or may enqueue the raw source for background processing and return immediately. The session-close latency is no longer gated on the extraction model's response time.

4. **Write path entry point unchanged:** The background extractor produces a JSON payload conforming to the existing `readStdin` schema (`scripts/handoff.js:148-263`): a plain object with an `assertions` array of `{subject, predicate, object, confidence, source}` records within the existing caps (`ARRAY_MAX=200`, `RECORD_STR_MAX=1000`). The payload is delivered to `writeExtraction` (`scripts/handoff.js:1340`) via the same stdin JSON path or an equivalent programmatic call. The write path does not change its interface; only the caller changes from an interactive model-at-close to a background extractor.

5. **Predicate validation at write:** The write path adds a validation step that checks each incoming `predicate` string against the declared registry before executing the supersession logic. An unrecognized predicate either (a) is rejected with an error (strict mode) or (b) is written with a fallback cardinality of `1:N` (permissive mode, safer default) and flagged for registry extension. Mechanism choice is an open question; see §5.

### 2.3 Migration and compatibility

The existing stdin JSON write path (`readStdin` → `writeExtraction`) is the migration-compatible entry point. Background extractors produce the same payload structure the write path already accepts. No change to the `readStdin` validation logic is required. The `readStdin` top-level key allowlist (`scripts/handoff.js:166-171`) may be extended to carry an optional `extraction_mode` flag identifying whether the payload was produced by an interactive or background pass; this is informational and non-breaking.

The bootstrap distillation migration script described in the memory bootstrap collision fix (which processes the existing HANDOFF corpus in chronological order to produce one live row per `(subject, predicate)`) operates by feeding model-extracted payloads through the write path. Because the collision fix depends on the controlled predicate-vocabulary contract specified here, those model extraction passes are constrained to the declared predicate vocabulary as a precondition of the collision fix functioning at all. Any predicate strings in the existing corpus that do not match the canonical set would need to be mapped to a canonical predicate or flagged for manual review. A one-time predicate normalization pass over existing `assertions` rows is therefore a precondition for enabling strict-mode predicate validation at write.

---

## 3. Architectural Invariants

| # | Invariant | Rationale |
|---|-----------|-----------|
| R-1 | Every predicate written to the `assertions` table is either in the declared registry or explicitly flagged as unrecognized. | Cardinality enforcement requires a complete registry. |
| R-2 | The cardinality of a predicate is determined by the registry, not by a per-call heuristic. | Heuristics drift; registry is stable. |
| R-3 | The write path's supersession key for a given predicate must match the registry cardinality: `(subject, predicate)` for 1:1, `(subject, predicate, object)` for 1:N. | Prevents silent destruction of valid 1:N parallel assertions (the root defect). |
| R-4 | The background extraction pass must produce a payload that passes `readStdin` validation unchanged. | Ensures no regression to the existing write path interface. |
| R-5 | Adding a new predicate to the registry is a versioned, recorded operation. | Vocabulary drift is auditable. |
| R-6 | The collision fix's write-time supersession consumes per-predicate cardinality exclusively from the declared registry specified here; it has no independent hardcoded cardinality source. | The collision fix is blocked on this contract; cardinality must have a single authoritative source. |

---

## 4. Risks

**R-A — Predicate registry coverage at extraction time.** If the registry is incomplete, valid assertions about genuinely novel relationships cannot be written without first extending the registry. This creates a workflow friction: the extraction pass must either be able to request a registry extension or fall back to permissive mode. The fallback cardinality must be conservative (1:N is safer than 1:1; silent destruction is worse than duplicate retention).

**R-B — Existing corpus normalization scope.** The live `assertions` table will contain predicate strings from prior extractions that may not match the canonical registry. A normalization pass is required before strict-mode validation can be enabled. The scope of that pass is unknown until the existing predicate distribution is queried. A reconnaissance query (`SELECT predicate, COUNT(*) FROM assertions WHERE project_id=$1 GROUP BY predicate ORDER BY COUNT(*) DESC`) should be run and reviewed before any normalization work is scoped.

**R-C — Background extraction latency and ordering.** Off-path extraction decouples session close from assertion availability. A session that closes without waiting for the background extractor will not have its assertions visible in the next session's retrieval until the background pass completes. If the next session begins before the extractor finishes, the retrieval contract will see a temporarily stale store. This is a latency tradeoff, not a correctness defect, provided the extractor completes before the session that depends on its output begins. Whether this latency window is acceptable depends on session frequency; it is unlikely to be a problem for single-user daily use.

**R-D — Structured-output schema stability.** The JSON schema constraint used by the background extractor must be kept in sync with the declared registry. If the registry is extended without updating the schema constraint, the extractor can produce predicates from the extended registry that the schema constraint rejects. The registry-to-schema-constraint generation step must be deterministic and automated, not manual.

---

## 5. Open Questions

**OQ-A — Registry storage mechanism.**
Options: (a) a JavaScript constant in the write path module (lowest friction, harder to extend at runtime), (b) a JSON file in the repository (version-controlled, readable by any consumer including the extraction schema generator), (c) a database table (`predicate_registry`) (queryable at write time without code change, extendable via INSERT, introduces a DB dependency for registry reads). Recommended lean: (b) a JSON file in the repository, checked in alongside the write path, loaded at startup by the write path module and by the schema constraint generator. A database table adds operational complexity for a registry that changes rarely. A JavaScript constant is the simplest but makes tooling harder. A JSON file balances these concerns.

**OQ-B — Unrecognized predicate behavior: strict vs. permissive.**
When the write path receives a predicate not in the registry, it can (a) reject the entire payload with an error (strict), or (b) write the assertion with cardinality defaulting to 1:N and emit a warning (permissive). Recommended lean: permissive during the transition period while the existing corpus is being normalized; strict after normalization is confirmed complete and the registry is stable. Provide a write-path flag to select the mode.

**OQ-C — Schema constraint mechanism for background extractor.**
The structured-output constraint that limits the extraction model to declared predicates can be implemented as (a) a JSON Schema `enum` on the `predicate` field, (b) a grammar constraint (if the model runtime supports it), or (c) a post-generation validation loop that retries on violation. Recommended lean: (a) JSON Schema enum, regenerated automatically from the registry JSON file whenever the registry changes. This is the most portable option and does not depend on grammar-constraint support in the model runtime.

**OQ-D — Sequencing of the registry contract relative to the collision fix.**
Because the collision fix depends on the declared registry for its per-predicate cardinality, the registry contract (the seed registry of §2.1 plus the write-path lookup that consults it) must land before, or atomically with, the collision fix's supersession logic. The collision fix cannot ship against a hardcoded private constant as an interim measure without re-creating the uncontrolled-vocabulary unsoundness described in §1.3. The open question is purely one of commit sequencing: whether the registry contract lands as a standalone prerequisite commit immediately preceding the collision fix, or whether the registry seed and the supersession logic land together in a single commit. Recommended lean: registry contract as a standalone prerequisite commit, so the cardinality source of truth is reviewable independently of the supersession behavior that consumes it.

---

*End of spec.*
