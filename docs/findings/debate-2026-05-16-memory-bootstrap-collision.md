# Debate Verdict — Memory Bootstrap Same-Subject Collision

**Spec:** docs/specs/2026-05-16-memory-bootstrap-collision.md
**Date:** 2026-05-16
**Panel:** Advocate, Skeptic, Domain Practitioner (all Opus, per session derivation)
**Change size:** LARGE

## Disposition
**proceed-with-constraints** — The core direction (4A write-time supersession + 4C bump fix) is unanimously endorsed and the §2 root-cause diagnosis (FACT 4 project-wide bump defeats staleness — staleness is "decoration" until fixed) is praised by all three panelists as forensic and correct. However, one P0 defect (the `(subject, predicate)` natural-key instability under model-driven extraction) was independently raised by all three panelists and must be resolved in the plan before any implementation proceeds, and several mechanism choices remain contested and require an explicit documented decision from the plan author.

## Points of Agreement (hard constraints for the plan)
- The FACT 4 keystone diagnosis is correct; any solution that does not fix the project-wide bump is incomplete (I-8 upheld by all three).
- 4C (bump fix, ~3 lines, reuse `retrievedAssertionIds` at handoff.js:964) is a prerequisite and must ship regardless of other choices.
- 4A write-time supersession is the correct PRIMARY layer; read-time collapse (4B) is rejected as primary and retained only as an optional contingency.
- The 4A `ON CONFLICT DO UPDATE` upsert variant must be cut from the solution space — it destroys history and violates I-3.
- OQ-4 (vector/semantic store collision) is correctly scoped out — that path is not wired into the loader (FACT 8).
- OQ-2 (add `AND suppressed = false` to the bump UPDATE) is endorsed and should ship with 4C.

## Contested Points (plan author must make an explicit choice and document reasoning)

1. **4D bootstrap mechanism.** Advocate: keep the bespoke per-file model-extraction migration; it is the honest hard part; OQ-5 shared-helper lean is right. Skeptic: CUT 4D-as-separate-script — drain the existing corpus by re-running `/handoff:close` over the 11 files (filename-timestamp order) through the already-4A-patched write path; this eliminates OQ-5 and the shared-helper mandate entirely. Practitioner: keep 4D but recognize it IS event-sourcing replay — promote OQ-5's shared reducer from "open question" to a hard requirement (one fold used by both write path and backfill), and predicate normalization is a gating precondition. Synthesized lean: converge Skeptic+Practitioner — there must be ONE supersession reducer; whether the backfill calls it via the write path or directly, it must not be a second implementation. Decide explicitly in the plan.

2. **History query kind (§7.3 / I-3).** Advocate: keep but it is the one piece with cut-room, sequenced last, deferrable if time-boxed. Skeptic: CUT — I-3 is satisfied by `suppressed=true` rows persisting; ad-hoc SQL recovers them; no FACT establishes audit need. Practitioner: DEFER to v2 — real but rarely exercised; ship the rows in-table, build the contract `kind:'history'` only when the audit need is felt. Synthesized lean: defer the history query kind out of v1; I-3 is met by retention alone; do not justify I-3 on compliance grounds.

3. **`suppressed` column overloading.** Skeptic + Practitioner: overloading the existing manual-suppression boolean to also mean "auto-superseded" is a known SCD2 anti-pattern — a future query cannot distinguish a deliberate mute from a supersession tombstone; real SCD2 uses a dedicated `superseded_by`/`is_current` column, and a partial unique index `(project_id, subject, predicate) WHERE is_current` makes I-1 engine-enforced rather than convention-enforced. Advocate: defended the two-step's no-schema-migration property as a deliberate strength. Synthesized lean: the schema-migration-avoidance benefit is real but the semantic-collision debt is also real; the plan must explicitly choose and document — recommended lean is a dedicated column + partial unique index (engine-enforced I-1) unless the migration cost is shown to be prohibitive.

4. **4C residual risk.** Skeptic + Practitioner: 4C is NOT "zero risk" as §4C/§5.2 imply — it activates a currently-dormant decay/suppression path; without backfilling existing `last_reinforced = now()` at apply time, live rows for rarely-retrieved subjects will silently decay below the `>= 1.0` threshold and vanish from default retrieval; `last_reinforced` (a reinforcement signal) should not be the version-ordering key — `created_at` should (I-4 already says this). Advocate did not address. Synthesized lean: 4C must include a one-time `last_reinforced = now()` backfill on apply, and the plan should confirm `created_at` (not `last_reinforced`) is the supersession/version key.

## Invalidated Assumptions (with evidence)

1. **`(subject, predicate)` is a stable natural key — FALSE (P0, all three).** Extraction is model-driven with no JS helper and no controlled vocabulary (§4D, §7.2); the same logical fact extracted from different files yields different subject/predicate strings, so 4A/4D/4B key on exact string equality and silently fail to collapse semantic duplicates — on the very 9-file corpus the spec exists to fix. §7.2 step 4 verification (`HAVING COUNT(*) > 1`) only detects exact-key dupes, giving false confidence. No normalization, alias map, or extraction schema constraint exists. This must be solved in the plan or the mechanism no-ops.

2. **Model extraction is non-deterministic across runs (Skeptic, Advocate).** The migration is not idempotent or diff-testable; re-running after a found error starts from a different state. I-4 governs within-run tiebreaking only; cross-run non-determinism is unaddressed.

3. **I-3 audit recoverability has no evidence base (Skeptic, Practitioner).** It is an invented invariant used to justify the history kind (and per Skeptic, 4D); it should be sized as a small debugging-gotchas concern, not a requirement, and never justified on compliance grounds.

4. **4C is not "zero/very-low risk" as stated (Skeptic, Practitioner).** It activates a dormant decay path; existing `last_reinforced` values require backfill or rarely-retrieved live rows decay out — a new failure mode the spec does not acknowledge.

5. **entities/edges excluded by omission (Practitioner).** Edges accumulate the same contradiction with no supersession story; this must be stated as an explicit, loud v1 boundary, not left implicit.

## Risk Register

| Risk | Raised by | Likelihood | Mitigation the plan must include |
|---|---|---|---|
| Predicate/subject key instability silently no-ops supersession | Advocate+Skeptic+Practitioner | HIGH | Introduce a controlled predicate vocabulary / alias-normalization step in the extraction schema before any migration; add a semantic (not just exact-key) verification step. |
| Non-deterministic model extraction → non-reproducible migration | Skeptic, Advocate | HIGH | Persist extracted JSON payloads as reviewable artifacts; make re-runs operate from the frozen payloads, not fresh extraction. |
| 4C activates dormant decay → durable rarely-retrieved facts vanish | Skeptic, Practitioner | MEDIUM | One-time `last_reinforced = now()` backfill on 4C apply; confirm `created_at` is the version key; consider a permanence exemption for durable facts. |
| 4A and 4D divergent supersession implementations | Skeptic, Practitioner (OQ-5) | MEDIUM | One shared supersession reducer used by both paths; a test asserting equivalence. |
| `suppressed` semantic overloading (mute vs tombstone) | Skeptic, Practitioner | MEDIUM | Dedicated `superseded_by`/`is_current` column; partial unique index for engine-enforced I-1. |
| OQ-1 same-day filename ordering ambiguity selects wrong live row | Advocate, Skeptic | MEDIUM | Explicit deterministic sort incl. alphabetic suffix; verification must check WHICH row is live, not only COUNT>1. |
| entities/edges contradiction unmanaged | Practitioner | LOW | Document explicit v1 boundary; note edges supersession as known follow-up. |

## Position Papers (verbatim)

### Advocate

# Position Paper — The Advocate

## Strengths

**1. The problem statement is forensic, not speculative (§2).** The spec does not assert "duplicates are bad"; it walks the failure fact-by-fact with line-number citations: plain INSERT at `handoff.js:1360-1372` (FACT 1), no `DISTINCT ON` in retrieval (FACT 3), and — the decisive insight — the project-wide bump at `handoff.js:966-971` with subject filter `($2 IS NULL OR subject=$2)` and a null default (FACT 4). The rejected alternative here is the lazy framing "just add dedup to the query." That rejection is sound because §2 Step 3 proves dedup-at-read alone leaves `last_reinforced` as a tied discriminator post-bump; the spec correctly identifies that the staleness machinery is *decoration* (§1.4) until the bump is fixed. Naming the bump as the keystone is the single highest-value observation in the document.

**2. Two-step supersession over `ON CONFLICT` upsert (4A).** The spec chooses the suppress-then-insert variant explicitly to preserve the superseded trail (I-3) and to avoid a unique-constraint schema migration on a live DB (4A "Risk"). The implicitly rejected alternative — `INSERT ... ON CONFLICT DO UPDATE` — is correctly rejected because it *discards history entirely* (§4A explicit note), which would violate I-3 and the audit/gotchas use case. On a single-maintainer DB with no migration tooling ceremony, avoiding the `UNIQUE(project_id,subject,predicate)` constraint is the prudent call: it sidesteps the risk of the constraint rejecting the very duplicate rows already in the store.

**3. Write-time over read-time as the primary fix (§5.1, §5.3).** The spec rejects 4B-as-primary because read-time collapse "scans growing duplicates on every query and defers the cleanup debt indefinitely." This is the correct architectural instinct: the handoff loader runs on *every session start* against a fixed 4000-token budget (FACT 6, `handoff.js:645`). Paying an O(duplicates) scan-and-collapse cost on the hot path forever, to avoid a one-time `UPDATE` on the cold write path, is the wrong trade. 4B is retained as an optional safety net, not discarded — appropriately nuanced.

**4. Invariant I-8 as a disqualifier.** Elevating "a solution that leaves the bump in place and calls itself a staleness fix is incomplete" to a hard invariant is excellent design discipline. It is precisely the trap a less rigorous spec would fall into (ship 4B, declare victory, ship a still-broken store).

## Scope Defense

The chosen scope is 4E = 4A + 4C + history kind, plus the 4D migration. Each piece is load-bearing:

- **Drop 4C and the design fails silently.** 4C is ~3 lines (§4C "Cost: Very low") and is a *prerequisite*, not an enhancement — without it, `last_reinforced` remains a project-wide clock and I-4 (deterministic tie-break) is unsatisfiable. There is no cheaper, higher-leverage change in the document. Cutting it is indefensible.
- **Drop 4A and you fix nothing going forward.** The next `/handoff:close` re-introduces duplicates (§4D "Risk"). 4A is the *only* ongoing-prevention mechanism in the table (§4 summary, "Ongoing prevention" column: only 4A and 4E say Yes).
- **Drop 4D and the actual bootstrap collision — the named reason this spec exists (§1.3) — is never cleaned up.** 4A is purely prospective; the 9 existing HANDOFF files stay live and contradictory. The scope without 4D does not solve the stated problem.
- **Drop the history kind and I-3 is violated.** Suppressed rows become unrecoverable, defeating the audit/gotchas requirement. But this is the one piece with genuine cut-room: it is opt-in, not in the default contract (§7.3), so it could ship as a fast-follow without regressing default behavior. The spec itself sequences it last (§5 implementation order step 4), which is the right call. I would accept deferring *only* the history kind if time-boxed — the other three are atomic.

"This could be simpler": the only real simplification is 4B-only, and §2 Step 3 already proves that ships a still-broken store. "Too ambitious": 4C is 3 lines, 4A is ~15 lines plus one UPDATE, 4D is a script. This is not an ambitious surface; it is a small surface with one genuinely hard sub-problem (4D's model-extraction passes).

## Implementation Feasibility

The change points are concretely located and sound. 4C reuses the *already-populated* `retrievedAssertionIds` array at `handoff.js:964` — the data needed for the fix already exists; the change is `WHERE id = ANY($1::int[])`. That is real, verified leverage, not aspiration. 4A's two-step is a documented SQL pair against an existing column (`handoff-core-schema.sql:89`), no migration. The history branch slots into the existing kind dispatcher (`handoff.js:906-972`) alongside `assertion`/`recency`/`vector`.

The spec is also honest about the hard part: §4D and §7.2 explicitly state there is **no JS extraction helper** — `cmdClose` reads model-produced JSON from STDIN (`readStdin`, `handoff.js:141-261`). The migration therefore needs a model-extraction pass per file. The spec does not hand-wave this; it names the stdin schema and the `ARRAY_MAX`/`STRING_MAX`/`RECORD_STR_MAX` caps. Realistic effort: 4C + 4A + OQ-2 in well under a day; the history kind a few hours; the 4D migration script is the multi-day item because per-file model extraction must be validated against the verification query (§7.2 step 4: `HAVING COUNT(*) > 1` must return zero).

OQ-5's recommended lean — migration executes the two-step SQL directly via a *shared helper* with the 4A write path — is the strongest design decision in the open questions. It makes the migration self-contained and order-independent (satisfying I-5) while preventing implementation divergence. That is exactly right.

## Compliance Strengths

This is a single-maintainer, local Postgres dev tool that is dogfooded, not distributed, not multi-tenant, and processes no third-party or personal data beyond the maintainer's own session notes. There are no GDPR, SOC 2, HIPAA, PCI, or data-residency obligations. Licensing is not implicated — no new dependencies are introduced (the changes are SQL and Node already in-tree). I checked; there is genuinely nothing to assert here beyond noting that the suppress-don't-delete design (I-3) happens to preserve an audit trail, which is good hygiene even absent any obligation.

## Risks Accepted

Even with perfect implementation:

1. **4D extraction fidelity is the real exposure.** The migration's correctness depends entirely on model-extraction passes producing consistent `(subject, predicate)` tuples across 11 files written at different times in different phrasings. If the same logical subject is extracted as "Bundle A status" in one file and "Bundle-A phase" in another, supersession never triggers and duplicates survive — the verification query at §7.2 step 4 only catches *exact* `(subject,predicate)` collisions, not semantic ones. The spec relies on extraction-prompt discipline it does not fully specify. This is the assumption most likely to invalidate the outcome.
2. **OQ-1 ingestion order is correctness-critical, not cosmetic.** If filename-date sorting is wrong (e.g., `HANDOFF-2026-05-14b` vs `14c` lexical ordering edge cases), the *wrong* assertion becomes live. I-5 is satisfied only if the sort is implemented exactly as specified.
3. **OQ-4 (vector store) is correctly scoped out but is a latent twin problem.** content_hash dedup (`pipeline-memory-loader.js:17`) is text-level, not subject-level; the same collision can recur in the semantic store once FACT 8's skipped vector path is wired in. The spec is right to defer this but right to flag it — it is not solved, only bounded.
4. **I-6 interpretation.** 4E avoids the I-6 risk by not touching gate-OFF SQL — but only because 4B is excluded. If 4B is later added as the §5.3 safety net, OQ-3's comment-narrowing argument will face adversarial challenge. Accepting 4E means accepting that the pre-write-fix legacy rows are cleaned by 4D alone, with no read-time backstop.

None of these are reasons to reject the design. They are the honest cost of a structural fix to a structural bug. The scope is correct, the change points are real, and the keystone insight — fix the bump or the staleness mechanism is decoration — is the kind of root-cause finding that justifies a LARGE change.

### Skeptic

### Scope Concerns

The core defect is narrow: same-subject rows accumulate because the write path (`handoff.js:1360-1372`, FACT 1) never supersedes and retrieval (FACT 3) never collapses. The minimal fix is **4A two-step supersession + 4C bump fix**. Everything else in the §5/§7 recommendation is scope inflation wearing requirement clothing.

- **4D distillation migration is a one-time concern conflated with the steady-state fix.** §4D itself admits 4D is "operationally identical to 4A" but as a migration script. Once 4A is on the write path, the existing 9-file backlog can be drained by simply re-running `/handoff:close` over the corpus through the *already-patched* path. A bespoke migration script is a second implementation of the same supersession logic — and OQ-5 then has to invent a "shared helper mandate" to stop the two implementations diverging. The spec manufactures a divergence risk (OQ-5) and then proposes a mandate to manage the risk it created. Cut 4D-as-separate-script.
- **The `history` query kind (§4E, §7.3) is v2.** I-3 ("superseded variants recoverable") is satisfied the moment rows are `suppressed=true` rather than deleted — they are recoverable by *any* ad hoc SQL query. A dedicated loader branch + contract JSON extension + `recordContractChange` versioning is net-new retrieval surface justified by a hypothetical "gotchas deliverable" and "any explicit audit" (§5.5). No FACT establishes that audit access is a live requirement. This is "nice to have" promoted to invariant I-3 and then to a code branch.
- **OQ-5's shared-helper mandate is scope creep born of a scope creep.** It only exists because 4D duplicates 4A.

Defensible v1: 4C + 4A two-step, drain the corpus through the patched write path. I-3 met by `suppressed=true` retention. That is ~80% of the value.

### Feasibility Attacks

- **§7.2 step 2 model-extraction determinism — DESIGN FLAW (severity: high).** The spec's own §4D/§7.2 concedes there is "no JavaScript extraction helper" — extraction of `{assertions, entities, edges}` from each of 9+ markdown files is "performed by the model/skill." A model pass over 9 files is **non-deterministic**: the same `HANDOFF-2026-05-14d-phase3a-merged.md` extracted twice can yield `subject="Bundle A"` vs `subject="Bundle A status"`, or `predicate="is_status"` vs `"status_is"`. This directly breaks the entire mechanism, because supersession keys on exact `(project_id, subject, predicate)` string equality (§4A SQL, §7.2 step 3). Two phrasings of the same subject across two files do **not** collide and do **not** supersede — you get two live rows and the bootstrap collision the spec exists to kill. The spec asserts I-1 is satisfied "post-distillation" and §7.2 step 4 adds a `HAVING COUNT(*) > 1` verification query, but that query only catches *exact* key dupes; it is blind to semantic dupes under divergent extracted keys. The verification gate gives false confidence.
- **The `(subject, predicate)` identity assumption — DESIGN FLAW.** The entire solution treats `(subject, predicate)` as a stable natural key. Nothing in the schema (FACT 2: no unique constraint, free-text columns) or the extraction process enforces canonical subjects/predicates. Across 9 files authored over weeks by model passes, "Bundle A status", "Bundle A", "bundle_a phase" are three keys for one fact. 4A/4D/4B all silently fail to merge them. This is the load-bearing assumption and it is unvalidated.
- **4C alone changes retrieval behavior — INTEGRATION RISK.** §4C scopes to `handoff.js:966-971`. But changing the bump from project-wide to `id = ANY(...)` means decay (FACT 5) now actually fires on un-retrieved rows. Today nothing decays out (FACT 4 keeps `age_days≈0` store-wide). Post-4C, a subject not retrieved for ~92 days at `confidence=1.0`, `decay=0.05` crosses the `>= 1.0` WHERE threshold and **silently vanishes from default retrieval** — including live rows for rarely-queried subjects. 4C is sold as "very low risk, ~3 lines" (§4C, §5.2) but it activates a dormant suppression path with no migration of existing `last_reinforced` values. Severity: integration risk, materially understated.
- **I-6 / OQ-3 interpretation gamble — INTEGRATION RISK.** §4B/OQ-3 reinterprets the `handoff.js:933` byte-identical comment as "no outcome_bias term only." The spec admits "adversarial reviewers are likely to challenge it." 4E sidesteps this by not using 4B, but §5.3 still floats 4B "as a safety net" — leaving the I-6 violation latent in the recommended path's hedge.

### Token / Cost Analysis

- **Bootstrap model passes:** 11 files (9 HANDOFF + 2 supporting), each a full model extraction pass into strict JSON under `readStdin` caps. That is 11 model invocations of nontrivial cost, plus re-runs every time a key-divergence bug forces re-extraction. Non-deterministic extraction means this is not a one-shot cost.
- **Ongoing per-close overhead:** 4A two-step adds one `UPDATE ... WHERE project_id AND subject AND predicate AND suppressed=false` per assertion per `/handoff:close`. Acceptable. But each close now writes a suppression tombstone, so the `assertions` table grows monotonically with suppressed rows — 4C's `id=ANY` bump and every read still scan them via the `suppressed=false` predicate. 4B's own §4B risk note (read-time scan of growing duplicates) applies to the table at large.
- **Debugging pain:** "Why did this assertion not supersede?" requires inspecting model-extracted key strings across files — opaque, non-reproducible.
- **Cheaper outcome:** see Simpler Alternative — skip per-file model passes entirely.

### Maintenance Burden

- **4A write-path SQL vs 4D migration SQL divergence** is a real, spec-acknowledged hazard (OQ-5). The proposed mitigation — a shared supersession helper — is itself net-new abstraction a future maintainer must discover and not break. Two call sites (`writeExtraction` loop + migration) of one helper, with the migration "executing the two-step SQL directly" per OQ-5's lean, i.e. *not* going through the patched write path — so the shared-helper mandate is the only thing preventing drift, and mandates are not enforced by code.
- A future maintainer must hold: the FACT 4 bump semantics, the decay formula, the `suppressed` column's now-overloaded meaning (manual suppression vs supersession tombstone — §2 step 5 notes `suppressed` was manual-only; 4A reuses it, conflating two semantics), the history query kind, and the contract versioning. Surface area expands well beyond the original defect.
- **`suppressed` overloading** is the worst of these: I-3 history recovery and operator manual-suppress now share one boolean. A future "show me everything I manually suppressed" query cannot distinguish a tombstone from an intentional mute. This needs a distinct `superseded_by`/`status` column (which §2 notes does not exist) — the spec chose column reuse to dodge a schema migration and bought a semantic-collision debt.

### Simpler Alternative

**~80% value, ~40% complexity:**

1. **4C bump fix** *with* explicit migration of existing `last_reinforced` to `now()` on apply (one `UPDATE` so no live row instantly decays out — closes the integration risk I raised). Keep.
2. **4A two-step supersession** on the write path. Keep. This is the actual fix.
3. **Drain the existing corpus through the patched write path**, not a bespoke 4D script — re-run `/handoff:close` extraction over the 11 files in filename-timestamp order (OQ-1 sort still required). Eliminates 4D, eliminates the OQ-5 divergence question and the shared-helper mandate entirely.
4. **Cut the `history` query kind.** I-3 is satisfied by `suppressed=true` rows persisting; recovery is ad hoc SQL when actually needed. Add the loader branch only when a concrete audit requirement exists.

**Cut:** 4D-as-script, OQ-5 shared-helper mandate, history query kind, contract extension/versioning.
**Keep:** 4C (+ backfill), 4A two-step, ordered corpus drain.
**Tradeoff accepted:** no turnkey audit query (acceptable — no FACT shows it is needed); the non-determinism of model extraction over markdown remains unsolved — **but it is unsolved in the full spec too**, so this is not a regression, it is honesty about the real residual risk: the `(subject, predicate)` natural-key assumption is the load-bearing failure point and no solution variant addresses it.

### Domain Practitioner

### Real-World Context

This is a textbook current-vs-history problem and the spec mostly reaches for the right tools. The "9 contradictory rows per `(subject,predicate)`" failure (§2 Steps 1–5, FACT 1/3) is exactly what **SCD Type 2** exists to solve: keep all versions, but mark exactly one row as current. The two-step suppress-then-insert in 4A is SCD2 with a boolean `is_current` flag — except the spec overloads the existing `suppressed` column to mean two different things ("manually muted" and "automatically superseded"). In production that conflation bites you: you can no longer distinguish "I deliberately silenced this" from "this aged out." Real SCD2 uses a dedicated `superseded_by`/`valid_to` column. The spec even acknowledges `superseded_by` does not exist (FACT 2) and then routes around it via `suppressed`. That is a known anti-pattern.

The deeper alignment issue: this is fundamentally an **append-only event log with a projection** (event-sourcing / CQRS). HANDOFF files *are* the event stream; the assertions table should be the materialized read-model. 4D's "replay in chronological order to produce one live row + trail" is literally event-sourcing replay. The spec stumbles into the right architecture (§7.2) without naming it, which is why OQ-5 exists — the migration and the write path disagree about who owns the projection logic. Name it: the write path is a fold over events; the migration is the same fold run as backfill. One shared reducer. OQ-5's recommended lean (shared helper, direct SQL) is correct and should be elevated from open question to requirement.

`last_reinforced DESC` as a tiebreaker (I-4, FACT 4/5) is **CRDT last-writer-wins on a wall clock** — and LWW on wall-clock timestamps is the single most notorious footgun in distributed data. The spec correctly identifies (Step 3) that the project-wide bump collapses all timestamps to a tie. The honest fix is not "make the timestamp accurate" (4C) but "stop using a reinforcement signal as a version-ordering key." `created_at` is the correct supersession key (I-4 already says this); `last_reinforced` should never be load-bearing for *which row is true*.

### Existing Alternatives

Buy-vs-build verdict: **build, but build less.** Postgres has first-class options the spec never weighs:

- **`INSERT ... ON CONFLICT ... DO UPDATE`** (4A upsert variant) is the standard vector-store/KV upsert idiom — `pgvector`, Pinecone, and every RAG pipeline use exactly this for "same key, new value." The spec rejects it because it "discards history." That is solvable with a one-line trigger or a partitioned history table, not a reason to hand-roll two-step DML.
- **Postgres range types + `tstzrange` + an exclusion constraint** gives you true bitemporal tables with a *database-enforced* "one current row" guarantee — exactly invariant I-1, enforced by the engine instead of by application discipline. The spec's 4A relies on the write path remembering to suppress first; a `GIST` exclusion constraint makes I-1 impossible to violate. For a single-maintainer tool, engine-enforced beats convention-enforced every time.
- **`temporal_tables` extension / `periods`** exists but is overkill here and adds an operational dependency a local dogfood tool should not take.

The gap this design genuinely fills that none of the above do: the *retrieval contract* coupling — collapsing must respect a token budget and a query-kind dispatcher (§7.3). That is bespoke and worth building. The supersession bookkeeping is not; it is a solved problem the spec is re-deriving.

The rejected "just move the markdown" option is correctly excluded — markdown is the event source, not the read model; relocating it does not give you a queryable current-truth projection.

### Compliance and Regulatory Reality

Checked explicitly. **None apply.** This is a single-maintainer, local-only Postgres instance ingesting the maintainer's own session handoffs. No third-party PII, no customer data, no external data subjects. Data-retention regimes (GDPR/CCPA) require a data subject other than the operator — absent here. The ingested content is the maintainer's own authored markdown; no third-party license is implicated. The only real "retention" concern is self-inflicted: I-3's recoverable trail is a *useful-history* requirement, not a *legal-hold* one. Do not let I-3 be justified on compliance grounds; justify it solely on "debugging gotchas," and size it accordingly (small).

### What Users Actually Need

Felt every session: **4C (bump fix)** and the **one-live-row guarantee**. The maintainer pays the contradiction tax (§2 Step 4: ~135 tokens for one subject, multiplied across every tracked subject) on *every single load*. 4C is ~3 lines, high leverage, zero regression. The single-live-row projection is the actual product.

Felt once: **4D distillation migration** and **history query kind**. 4D runs exactly once against the 9-file backlog. The history kind will be invoked approximately never in steady state — the maintainer wants *current truth cheaply*, not audit trails. Build history as the cheapest possible thing.

The spec's blind spot is **predicate identity**, and it is serious. I-1 keys on `(subject, predicate)`, but §4D/§7.2 admit `predicate` is populated by a *model extraction pass*, not a controlled vocabulary. If file 3 emits `Bundle A` / `is_status` / `merged` and file 7 emits `Bundle A status` / `was` / `merged`, these are different `(subject,predicate)` keys and **will not collapse** — the entire mechanism silently no-ops on the exact bootstrap corpus it was designed for. There is no `predicate` normalization, alias map, or extraction schema constraint anywhere in the spec. This is a P0 gap, not an open question.

Second miss: the spec scopes itself to `assertions` only and explicitly punts `entities`/`edges`. Edges (relationships) accumulate the same contradiction (`Bundle A` —`blocks`→ `X`, later untrue) and have *no* supersession story. State this as a known v1 boundary, loudly, not by omission.

### Practical Scope Recommendation

**In-scope (v1):**
- **4C bump fix + OQ-2 (`AND suppressed=false`).** ~3 lines, prerequisite for any staleness meaning, felt every session, zero risk.
- **4A write-time supersession — but as engine-enforced bitemporal**, not application-discipline two-step. Add a dedicated `superseded_by`/`is_current` column (do *not* overload `suppressed`) and a partial unique index `(project_id, subject, predicate) WHERE is_current`. This makes I-1 violable only by a DB error, not a code-path miss.
- **4D distillation, with predicate normalization mandatory.** Add a controlled predicate vocabulary / alias map to the extraction schema *before* running it, or the migration produces garbage. This is the gating dependency.
- **Shared supersession reducer** used by both write path and migration (OQ-5 promoted to requirement).

**Defer (v2+):**
- **History query kind (§7.3).** Real but rarely exercised. v1 ships the suppressed/superseded rows in the table, queryable by ad-hoc SQL when the maintainer actually needs a gotcha. A first-class contract `kind:'history'` is polish; defer until the audit need is felt twice.
- **4B read-time DISTINCT ON.** Redundant once 4A + 4D land; carries the I-6 interpretation risk (OQ-3). Keep only as a contingency if the migration is skipped — which it should not be.

**Cut entirely:**
- **4A upsert variant.** It discards history, conflicting with I-3, and the two-step/bitemporal path strictly dominates it. Remove it from the solution space to stop adversarial reviewers re-litigating it.
- **OQ-4 vector-store idempotency.** The semantic store is a different surface (FACT 8, currently skipped in loader). It is not a problem the maintainer has today. Cutting it from this spec's scope is correct; do not let it expand the change.

Net: the spec's 4E recommendation is directionally right but over-built and resting on an unexamined assumption. Ship 4C + bitemporal-4A + predicate-normalized-4D. Defer history-as-a-contract-kind. Cut the upsert variant and the vector-store question. The hard problem is not supersession DML — it is making `predicate` a stable key. Solve that first or none of this works.
