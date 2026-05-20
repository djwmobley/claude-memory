> Plain-English version: [docs/case-study.md](../../case-study.md). This is the dense original — preserved for the methodology and the numbers.

# Decay vs. Don't-Forget: Devalue, Invalidate, and On-Demand Resurrection

*A methodology and case study for the claude-memory OSS project. The design described here has shipped — all mechanism claims are anchored to production code on `main`. Conclusions are presented qualitatively; no synthetic corpus counts appear here as telemetry.*

---

## 1. The Problem: When Forgetting Is the Bug

claude-memory uses ranking-only decay to keep retrieval surfaces lean: older, unreinforced assertions score lower and yield to fresher, better-corroborated ones in the default bootstrap. Layered on top is a trust-tier model — assertions from unverified or probationary sources are soft-excluded from standard retrieval until positive feedback rehabilitates them. Both mechanisms are intentional and necessary.

The problem surfaces at their intersection. An assertion that (a) was written early in a project's life, (b) has not been recently reinforced, and (c) arrived from a source that has not yet accumulated corroboration is simultaneously penalized by decay and deprioritized by tier. Neither condition means the assertion is wrong. Together they can push a genuinely valuable piece of context below the retrieval horizon entirely — the system forgets something it should know.

This is the opposite of why semantic recall exists. The question is whether decay and don't-forget are genuine opposites, and if so, what the correct resolution is.

---

## 2. The Core Distinction: Devalue vs. Invalidate

**This is the spine of the study. Everything else is elaboration of this one distinction.**

A memory that has been **devalued** — down-ranked by decay, penalized by tier, or both — is still true. It exists in the store. The system has simply judged it unlikely to be immediately relevant given its age and provenance. That judgment is a retrieval heuristic, not a truth claim.

A memory that has been **invalidated** — marked `suppressed = true`, given an `invalid_at` timestamp, assigned a `suppression_kind` of `superseded` or `downvoted_terminal` — is no longer true relative to what the system currently believes. It has been bi-temporally retired. The system is asserting that this row should never be surfaced again as current fact.

These are different axes:

| Axis | What it governs | Reversible? | Should ever resurface? |
|------|----------------|-------------|----------------------|
| Decay / tier | Default ranked surface | Yes — rehabilitation by feedback | Yes, on demand |
| Bi-temporal invalidation | Truth | No (terminal) / conditional (probation) | Never (terminal), only after rehabilitation (probation) |

Conflating them is the core danger. If a recovery mechanism treats devalued and invalidated memories the same way — either suppressing both equally, or resurfacing both equally — it is wrong in both directions. Suppressing both equally causes the forgetting problem described above. Resurfacing both equally turns a recovery tool into an attack surface: an adversary who can influence query construction can retrieve invalidated (false) assertions under the guise of recovery.

The distinction is what makes on-demand resurrection safe. A recovery mechanism may override devaluation freely. It must never override invalidation.

The shipped code makes this invariant non-negotiable. The `resurrect` branch in `cmdLoaderLoad` (`scripts/handoff.js`) targets eligibility as `suppressed = true AND suppression_kind = 'downvoted_probation'` — only soft-suppressed, recoverable rows — and hard-excludes `downvoted_terminal`, `superseded`, and `retired` in every fetch path. Terminal is terminal; no query flag overrides it.

---

## 3. The Path We Took

The resolution was not obvious at the outset. The tension between "decay forgets valuable things" and "recovery must not resurface false things" was worked through in an isolated scratch environment run as a self-paced reflective loop. Every iteration ended with exactly two gating questions:

1. Have I asked all the questions of the work — is every implicit invariant tested, every failure mode explored?
2. Is this my best judgment, or could I do better with another pass?

Multiple independent rounds were run with configurations frozen between them — no mid-round artifact-fixing, no tuning toward a desired result. A deliberate repeatability challenge was added: the same scenarios replayed across independent configurations, with the safety invariant required to hold at zero failures in every single trial, not on average. Zero-tolerance safety invariants are binary properties. Reporting an average while individual trials fail is not an acceptable characterization of a safety property.

This discipline caught and corrected two overstatements before any conclusions were accepted:

- **Denominator conflation.** An early metric conflated "rows below the decay horizon" with "rows that would be meaningfully retrieved by resurrection." These are different populations. The corrected analysis separated them and produced a more conservative — and accurate — characterization of what resurrection actually recovers. The original framing overstated the forgetting problem.

- **Invalid proxy measurement.** An early trial used tier-exclusion rate as a proxy for "forgetting." This is wrong: a row can be tier-excluded and still appear in the default bootstrap via the top-N floor. The corrected measurement directly counted assertions that failed the top-N floor AND failed tier AND would pass the bitemporal guard — the actual target population for resurrection. The original proxy understated the relevance of tier rehabilitation.

With those overstatements corrected, three design forks were surfaced, each with a recommended lean. The critical structural finding was that the three mechanisms were not independently shippable: fuzzy resurrection without a trust gate is an adversary amplifier; the trust gate is only evaluable if L2-enforce is active; and operator-pin is what makes the seed-gate substrate trustworthy for the long-running project use case. The decision was made to ship all three as one mutually-dependent unit. That unit is now on `main` (squash commit `9085fe4`, PR #66).

---

## 4. The Shipped Resolution — Three Mechanisms, Proven Out

### (a) Devalue Over Delete

Decay and tier are rank-only mechanisms, not truth mechanisms. The shipped design enforces this at the retrieval layer: `resurrect` mode overrides decay and tier suppression freely for probationary rows, and is absolutely barred from doing so for terminal or superseded rows.

The bitemporal guard predicate in `cmdLoaderLoad` (`scripts/handoff.js`) targets eligibility as:

```
suppressed = true AND suppression_kind = 'downvoted_probation'
```

Every fetch in the resurrect branch carries this predicate. The hard-exclude of `downvoted_terminal`, `superseded`, and `retired` is not a flag or a setting — it is the absence of those kinds from the eligibility clause. There is no path through the resurrect branch that returns a terminal row.

Rehabilitation — transitioning a probationary row back to live status — is handled by the symmetrically paired mutation path: `db.buildProbationRehabUpdate` in `scripts/lib/db-seam.js` (line 939 / 1404). This is the only sanctioned mutation in the resurrect branch, and it is gated on an explicit `q.revive === true` opt-in. The default resurrect query is read-only.

**Why it is safe:** decay and tier never act as truth signals; they never cause a row to be removed or invalidated. A row surfaced by `resurrect` was always true by the system's current belief. The guard ensures that nothing the system has explicitly disbelieved is reintroduced.

### (b) Override for Past Projects — Operator-Pin

For long-running projects, there is a class of facts that should survive decay and tier permanently: foundational architectural decisions, confirmed constraints, user-stated invariants. These are facts the operator knows are true and wants the system to treat as trusted anchors unconditionally.

The shipped `scripts/operator-pin.js` is a standalone out-of-engine tool that inserts canon rows with `pinned = true`, `source = 'user_stated'`, `confidence = 10`, `tier = 'consolidated'`. It uses separate credentials from the main engine and is deliberately not wired into the `handoff.js` subcommand dispatch map — a model-invoked query cannot trigger it. Dry-run is the default; writes require explicit `--apply`. This is not an escape hatch from the trust model; it is a controlled extension of it.

Pinned rows serve two purposes. First, they survive all automatic suppression paths: the downvote logic in `handoff.js` explicitly exempts `pinned = true` rows from auto-suppression (line 3310). Second, they are trusted anchors for the M2 seed gate: the gate predicate `reality_check = 'verified' OR pinned = true` (line 1726) means a pinned subject is unconditionally eligible to seed a resurrection pass. Without operator-pin, the seed gate depends entirely on L2 corroboration accruing organically — which can be slow for assertions written before the trust substrate was in place. Operator-pin bridges that gap.

**Why it is safe:** the tool is non-model-invocable (absent from the dispatch map, separate creds), insert-only, idempotent on duplicate live pinned rows, and dry-run by default. The operator retains full audit visibility. The `test-operator-pin.js` harness validates these constraints as CI cases.

### (c) Fuzzy Resurrection

A user who wants to resurrect older context months later does not remember the exact predicate or subject terms from the original assertions. The shipped resurrect mode handles this via a two-level fallback:

1. **Semantic seed** — the query is embedded via vLLM (Qwen/Qwen3-Embedding-8B) and run as a cosine ANN search directly against `assertions.embedding` (halfvec 4000), scoped by `project_id`. This is the primary path; it is bypassed when `OLLAMA_SKIP=1` is set or the embedding backend is unreachable.
2. **pg_trgm fuzzy fallback** — when the semantic path is unavailable or returns no candidates, the resurrect branch calls `db.buildFuzzyMatch` (`scripts/lib/db-seam.js` line 957 / 1416) which issues a trigram similarity query (`similarity($2, subject || ' ' || predicate || ' ' || object)`) on Postgres, or an `instr()`/`LIKE` token-scan on SQLite. The pg_trgm extension is provisioned in `scripts/setup.sql` with a graceful degrade notice if absent.

Both paths route through the db-seam abstraction — there are no dialect conditionals in the engine itself. The seam handles the Postgres/SQLite split transparently.

From the seed candidates, the resurrect branch performs a depth-2 knowledge-graph fan-out via `db.buildGraphCTE('out', seeds, 2)` (`scripts/lib/db-seam.js` line 814 / 1276). This surfaces contextually linked entities that the text seed alone would miss — for example, a canonical decision about module X resurfaces alongside related assertions about modules Y and Z that reference X as a dependency.

**Why it is safe:** fuzzy search widens the candidate set before the M2 gate, not after. Every candidate that passes fuzzy matching still passes through the seed-gate trust filter (`reality_check = 'verified' OR pinned = true`) before any rows are fetched. A broad fuzzy match cannot bypass the trust requirement.

---

## 5. The Adversarial Finding: The Decay-Override Ring

A naive implementation of `resurrect` mode is an adversary amplifier. If override of decay and tier applies unconditionally to every seed — including seeds constructed or influenced by an untrusted source — then the recovery path becomes a mechanism for injecting previously suppressed content. The minimal sufficient mitigation is the M2 seed-gate.

The gate (`handoff.js` line 1726) requires that a subject have at least one live, trusted anchor — `reality_check = 'verified' OR pinned = true` — before any of its probationary rows are eligible for resurrection. This is the same quality-corroborator predicate used by L2 at the consolidation gate (line 2098–2099). An adversary-injected probationary row whose subject has no trusted anchor cannot self-resurrect; it is filtered at the gate before any rows are fetched.

But the gate is only evaluable if the trust substrate is populated. L2 corroboration (`consolidation_gate_mode = 'enforce'`, default as of `scripts/handoff.js` line 969) is what drives `reality_check = 'verified'` onto rows that have been positively corroborated across sessions. Operator-pin is what drives `pinned = true` onto foundational facts that have not yet had the opportunity to accrue cross-session corroboration. The gate requires both.

This is why the three mechanisms shipped as one mutually-dependent unit:

- **resurrect** without the M2 gate is an adversary amplifier.
- The **M2 gate** is only evaluable if L2-enforce is active and the trust substrate is populated.
- **Operator-pin** is what makes the substrate trustworthy for the pre-corroboration bootstrap case.

None of the three is independently safe to expose. All three on `main` together are.

The CI proof is in `scripts/test-resurrect.js` section R-2 ("M2 forge-gate"): a probationary row whose subject has no trusted anchor is confirmed blocked. The adversarial case is an explicit named test, not an incidental side-effect of a passing suite.

---

## 6. Methodology and Epistemic Discipline

The two overstatements corrected during development (denominator conflation and invalid proxy metric) are worth dwelling on. Both were caught not by a reviewer but by the two-question gate applied to the author's own work. The gate's value is precisely that it creates structured pressure to re-examine the work before conclusions are accepted.

The repeatability discipline — independent frozen-config rounds, safety invariant required at zero across every single trial — is the companion to the gate. Without the gate, the work could be declared done before the proxy measurement error was noticed. Without the repeatability requirement, the bitemporal guard could be characterized as "holds on average" — which, for a safety invariant, is meaningless. The two practices together are what make the qualitative framing ("false-resurrection held at zero across every replicated trial with the guard in place, and was substantial without it") trustworthy as a design conclusion.

Specific counts from a synthetic corpus would invite misreading as production telemetry. The design conclusion — not the count — is what transfers to any operator's deployment.

---

## 7. Summary

Decay and don't-forget are not opposites. They operate on different axes. Decay governs ranked relevance; bi-temporal invalidation governs truth. The shipped `resurrect` query mode overrides the former — fully, freely, for any probationary row — while absolutely respecting the latter. The M2 seed-gate that makes it safe, the L2-enforce mode that makes the gate evaluable, and the operator-pin tool that seeds the trust substrate for foundational facts are mutually dependent: all three shipped together (PR #66) because none is independently safe without the others. The CI harness (`test-resurrect.js`, `test-operator-pin.js`) proves the adversarial invariants explicitly, not incidentally.