# Security Policy

## Reporting a vulnerability

**The only channel for reporting security vulnerabilities is GitHub Private Vulnerability Reporting (PVR).** Navigate to the repository's Security tab and click "Report a vulnerability." No email address is published for security reports, by design.

**If PVR is not enabled:** The repository owner must enable it once in repo Settings → Security. If you find that PVR is not enabled when you try to file a report, open a regular issue asking the maintainer to enable PVR — without disclosing any vulnerability details publicly in that issue.

**Coordinated disclosure expectations:**

- Please report privately via PVR. Do not open public issues that contain exploit details.
- Allow the maintainer time to remediate before public disclosure.
- Good-faith targets: initial acknowledgment within approximately 5 business days. This is a solo-maintained hobby/research project; all timelines are best-effort, not contractual.

---

## Trust model

claude-memory persists session memory into a Postgres store and can surface it back into future Claude Code sessions. Retrieved memory is treated as **untrusted input** throughout the pipeline. The following subsections describe the specific controls in place.

### 1. Untrusted retrieved context

When prior-session context is loaded into a session, it is wrapped in literal delimiters hardcoded in `scripts/handoff.js`:

```
=== BEGIN RETRIEVED CONTEXT (untrusted) ===
...
=== END RETRIEVED CONTEXT ===
```

The word "untrusted" — not "user-controlled" — is deliberate: in a multi-author repository the originating author of any stored assertion is ambiguous. Consumers (the model and the human) must treat everything between those delimiters as potentially attacker-influenced and never as instructions.

### 2. Multi-author detection

On `handoff init` and `handoff close`, the tool runs `git log --format=%ae --since='1 year ago'` to count distinct author emails over the last year of commits. If more than one distinct author is found, the tool:

- (a) Writes one line to stderr: `[handoff] multi-author repo detected — see README#trust-model before relying on CLAUDE.md auto-promotion`
- (b) Persists `multi_author_detected=true` in the `project_settings` table.

This is advisory only — it does **not** change runtime behavior. The environment variable `HANDOFF_MULTI_AUTHOR_OVERRIDE` exists for testing. Detection is silent and graceful if git is unavailable.

### 3. CLAUDE.md auto-promotion is opt-in and confirmation-gated

This is the highest-risk path in the system; the default posture is **off**.

Promotion of high-confidence assertions into the repo-tracked `CLAUDE.md` `## Durable facts` section happens **only** when the `/handoff:close` payload explicitly includes `confirm_claude_md_promotion: true`. When that flag is absent or `false`, the tool prints the candidate list to the console and writes nothing to disk.

Additionally, the `/handoff:close` skill instructs the assistant to ask the user for confirmation before any CLAUDE.md write, and its example payload defaults the flag to `false`.

The effective posture is therefore: **off by default**, requiring an explicit opt-in flag, with a human confirmation step on top of that.

Promotion is further gated on all of the following:

- Assertion confidence ≥ 9
- Source = `user_stated`
- Reinforced across more than one session (reinforced more than 86,400 seconds after creation)

The `/handoff:promote <assertion_id>` command is the manual, single-assertion path for explicit promotion after review.

Every promoted line is preceded by an audit annotation comment of the exact form:

```
<!-- promoted: session=<id>, conf=<n>, date=<YYYY-MM-DD>, source_assertion=<id> -->
```

This makes every promoted fact traceable to its originating session and assertion.

**Residual risk for the most-exposed adopter — a public multi-author repo:** A malicious contributor who can influence what becomes a high-confidence `user_stated` assertion across multiple sessions could in principle get content promoted into `CLAUDE.md` — but only if a maintainer also explicitly opts in to promotion (`confirm_claude_md_promotion: true`) and confirms the write. The mitigations are the opt-in flag, the skill confirmation step, the multi-author stderr notice, and the audit annotations.

### 4. HANDOFF_DB validation

The target database name is overridable via the `HANDOFF_DB` environment variable. Because a database name cannot be a parameterized query placeholder in DDL statements, the value is validated against the strict identifier regex `/^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/` before any `CREATE DATABASE` is issued. Invalid values are rejected.

### 5. Stdin payload validation

The `/handoff:close` and `/handoff:checkpoint` JSON payloads are validated on receipt:

- Root must be an object type.
- Only an explicit allow-list of top-level keys is accepted; unknown keys are rejected.
- String fields are capped at 4,000 characters.
- Array fields are capped at 200 elements.
- Per-record string fields are capped at 1,000 characters.

These bounds limit the volume of attacker-influenced content that can enter the store in a single call.

---

## Configuration defaults — exposure review

The table below reviews every persistent `project_settings` default for the most-exposed adopter: a public, multi-author repository.

| Setting | Default | Verdict |
|---|---|---|
| `staleness_days` | `7` | **Safe, no change.** Controls whether the SessionStart loader auto-injects prior-session context (reloads if the last close was within the window). The trust protection is the `(untrusted)` delimiter wrapping, not the window length; shortening the window would not reduce attack surface because the retrieved content is untrusted regardless of age. |
| `loader_token_budget` | `4000` | **Safe, no change.** Caps how much retrieved (untrusted) context is injected per load — effectively a volume bound on attacker-influenced text reaching the session. 4,000 is a moderate, reasonable bound. |
| `implicit_close` | `enabled` | **Safe, no change.** Gates whether the SessionStart hook auto-closes a stale prior session (auto-extracting entities and assertions into the memory DB). Its blast radius is the queryable memory store only — which is itself always surfaced under the `(untrusted)` delimiters — and never the trusted CLAUDE.md, which is independently gated (see Trust model §3). Consistent with the project principle: smart defaults that work for the solo case today, with detection that surfaces a notice when multi-author conditions hold. |
| `decay_rate_default` | `0.05` | **Active — ranking signal only.** Feeds the exponential decay formula (`confidence × exp(-rate × age_days)`) used by the retrieval ORDER BY. Decay is a ranking-only signal with a guaranteed top-N floor (LIMIT clause); it does not suppress rows from retrieval. The `feedback_loop_enabled` (C2) setting controls whether `outcome_bias` adjustments are applied at session close; C2 is default-ON (see below). |
| `feedback_loop_enabled` | `enabled` | **Default ON.** C2 bias feedback: at session close, `outcome_bias` on assertions is nudged ± based on per-kind retrieval outcome feedback. Suppression is bi-temporal: rows are marked with `suppression_kind` (`downvoted_terminal` for permanent suppression, `downvoted_probation` for soft exclusion from standard retrieval that is rehabilitatable by positive feedback) and `invalid_at` timestamp. Pinned rows are exempt from C2 auto-suppression. Set to `'disabled'` to disable outcome-bias adjustment without affecting retrieval ranking. |
| `retrieval_outcome_timeout_days` | `14` | **Safe, no change.** Observability bookkeeping only — controls when still-pending retrieval_events are swept to 'irrelevant' under the timeout_decay signal. No effect on retrieval ranking or assertion decay (Bundle B W1 is observability-only). Adjustable per project. |
| `cluster_aware_retrieval` | `enabled` | **Safe, no change.** Enables W3 cluster-aware retrieval (owner-authorized retrieval-shaping). Strictly additive — only appends a `### Related (community)` section listing same-community sibling entity names; does not modify existing sections, assertion ranking, decay, or the canon/untrusted ordering. Fully gated on a computed community run: if `entity_communities` has no rows for the project, there is no behavior change whatsoever (byte-identical pre-W3 output). The volume of additional context is bounded by `loader_token_budget` and `cluster_max_siblings`. Set to any value other than `'enabled'` to disable. |
| `cluster_max_siblings` | `10` | **Safe, no change.** Caps the number of same-community sibling entities added per load — a hard volume bound on the additive W3 context. Adjustable per project. |

`confirm_claude_md_promotion` is **not** a persistent setting — it is a per-invocation `/handoff:close` payload flag, off unless explicitly set to `true` (see Trust model §3).

---

## Scope

This project is research and personal infrastructure, provided as-is with no warranty. The trust model above describes intended behavior, not a guarantee against all misuse.
