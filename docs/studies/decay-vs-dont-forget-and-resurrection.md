# Decay vs. Don't-Forget: Devalue, Invalidate, and On-Demand Resurrection

*A methodology and design study for the claude-memory OSS project. All claims are qualitative design conclusions validated through iterative testing on a realistic synthetic corpus in an isolated scratch database. No production telemetry, live-instance data, or instance-specific identifiers appear here.*

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

Conflating them is the core danger. If a recovery mechanism treats devalued and invalidated memories the same way — either suppressing both equally, or resurfacing both equally — it is wrong in both directions. Suppressing both equally causes the forgetting problem described above. Resurfacing both equally turns a recovery tool into an attack surface: an adversary can engineer a query that retrieves invalidated (false) assertions under the guise of recovery.

The distinction is what makes on-demand resurrection safe. A recovery mechanism may override devaluation freely. It must never override invalidation.

---

## 3. The Resolution: An Opt-In `resurrect` Retrieval Mode

The correct architecture is a two-tier retrieval model:

**Default bootstrap** — lean and token-minimal. Standard decay scoring, tier gates active, top-N floor as the only dormancy safeguard. This is what every session receives without asking. Keeps context injection fast and predictable.

**`resurrect` mode** — explicit and opt-in. Triggered per-query when the operator or agent determines that the lean default has likely missed relevant older context. The mechanism:

1. **Semantic seed.** The query is embedded and run against the full assertion store without decay or tier filtering applied to the ranking pass.
2. **Knowledge-graph fan-out.** The seed results drive a bounded traversal of the entity graph — related subjects, predicates, and objects within a configurable hop limit — to surface contextually linked points that the seed alone might miss.
3. **Bitemporal guard.** Before any row is returned, it passes through a hard filter: `suppressed = false` AND `invalid_at IS NULL` AND `suppression_kind NOT IN ('superseded', 'downvoted_terminal')`. Probation rows (soft-excluded from default retrieval but not permanently invalidated) may be included with an explicit flag; terminal rows are never included under any flag.
4. **Bounded additive token budget.** The resurrection results are injected as a separate budget from the default bootstrap. The lean default is not inflated; the resurrection block is clearly marked and bounded so the caller can reason about cost.

This design means: decay stays rank-only, never a hard filter, never a truth signal. Tier gates are overridden by explicit intent. Invalidation is absolute and non-negotiable regardless of how the query was constructed.

---

## 4. The Adversarial Finding: The Decay-Override Ring

A naive implementation of `resurrect` mode is an adversary amplifier. If override of decay and tier applies unconditionally to every seed — including seeds constructed by an untrusted source — then the recovery path becomes a mechanism for injecting previously suppressed content. An adversary who can influence query construction can attempt to retrieve assertions that the trust model excluded for safety reasons, not merely for relevance.

The minimal sufficient mitigation is a **seed-step trust gate**: before the fan-out step, the seed query itself is evaluated against the trust substrate. Only seeds that pass a provenance check (verified or pinned source, or operator-issued query) are permitted to invoke the full decay-override. Seeds from unverified or low-tier sources are allowed to retrieve only within their own trust band — the override does not apply.

This gate only works if a trust substrate exists. You cannot evaluate seed provenance if you have not tracked provenance. The strict tier model and the resurrection mode are therefore **mutually dependent**: the tier model is what makes the gate evaluable, and the gate is what makes the resurrection mode safe to expose.

The implication for implementors: you cannot add a recovery mechanism to a system that lacks rigorous provenance tracking and expect it to be safe. The two features must ship together. The tier model is not bureaucratic overhead relative to recovery; it is the precondition for recovery.

---

## 5. Methodology and Epistemic Discipline

The conclusions above were reached iteratively. The process is worth describing as practice, not just as provenance.

**Initial development.** A realistic synthetic corpus was loaded into an isolated scratch database. A candidate resurrection algorithm was run across multiple independent random seeds with the configuration frozen (no mid-run artifact fixing). Each round ended with a two-question gate: (1) does the bitemporal guard hold on every trial, or only on average? (2) what is the worst-case false-resurrection rate without the guard?

This gate corrected two overstatements before the conclusions were accepted:

- **Denominator conflation.** An early metric conflated "rows below the decay horizon" with "rows that would be meaningfully retrieved by resurrection." These are different populations. The corrected analysis separated them and produced a more conservative — and accurate — characterization of what resurrection actually recovers.
- **Invalid proxy measurement.** An early trial used tier-exclusion rate as a proxy for "forgetting." This is wrong: a row can be tier-excluded and still appear in the default bootstrap via the top-N floor. The corrected measurement directly counted assertions that failed the top-N floor AND failed tier AND would pass the bitemporal guard — the actual target population for resurrection.

**Repeatability discipline.** A deliberate repeatability challenge was run: many independent random seeds, frozen configuration, no artifact-fixing between runs. The bitemporal guard was required to hold at zero false-resurrections on every single trial — not on average. Zero-tolerance safety invariants are binary properties, not statistical ones. Reporting an average while individual trials fail is not an acceptable characterization of a safety property.

**Qualitative presentation.** This study presents conclusions qualitatively: "false-resurrection held at zero across every replicated trial with the guard in place, and was substantial without it." Specific counts from a synthetic corpus would invite misreading as production telemetry. They are not; they are illustrative signals from controlled conditions. The design conclusion — not the number — is what transfers.

---

## 6. Summary

Decay and don't-forget are not opposites. They operate on different axes. Decay governs ranked relevance; bi-temporal invalidation governs truth. An on-demand resurrection mode that overrides the former while absolutely respecting the latter is safe, replicable, and consistent with the existing system design. The adversarial guard that makes it safe is not optional — it is the feature that makes resurrection trustworthy, and it requires the trust substrate (tier model, provenance tracking) to be in place first. Both must ship together or neither is safe to expose.
