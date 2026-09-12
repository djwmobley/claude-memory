# claude-memory

Memory and retrieval infrastructure project.

**If `START-HERE-CONSOLIDATION.md` and `CONSOLIDATION-RUNBOOK.md` are present in your working tree, read them before touching schema/scripts here — navigate the runbook via `RUNBOOK-INDEX.md`, not top to bottom.** These are local planning documents that reference private infrastructure and are not distributed with this public repo.

---

## Operating canon (non-negotiable)

These rules are canon. They override convenience, time pressure, and apparent context. Violating them is a workflow bug to be remediated, not a stylistic choice.

1. **Follow the user's directions and scope exactly.** When asked to do X, and X has an established definition (a backlog item, a prior handoff, a multi-part deliverable), deliver all of X. Do not silently narrow scope, reinterpret it, or substitute a smaller deliverable. If scope genuinely seems too large or ambiguous, say so and ask — do not shrink it unilaterally.
2. **Never autonomously defer authorized work to a subsequent session, bundle, or phase.** Deferring in-scope work without explicit user say-so is a bug. Surface genuine design forks as written open questions with a recommended lean; never use deferral or an invented "later phase" as a mechanism to offload work that is in scope now.

---

## Skill invocation hints

- `/handoff:status` — show last close, days since close, entity/assertion counts
- `/handoff:resume` — load context from prior session regardless of staleness
- `/handoff:close` — end-of-session extraction: entities, assertions, edges, contract update
- `/handoff:checkpoint` — mid-session save without ending the session
- `/handoff:drop` — archive prior session memory and start fresh
- `/handoff:purge` — hard delete all project memory (confirmation required)

---

## Key paths

- Handoff file: `~/.claude/projects/<project-id>/handoff.md`, where `<project-id>` is the marker UUID read from `.memory-engine` (or legacy `.claude-memory`) at the repo root — falling back to the encoded-cwd id only for un-migrated projects with no marker file. See `scripts/lib/handoff-paths.js` (`resolveHandoffMdPath`) for the resolution logic.
- Helper script: `<repo-root>/scripts/handoff.js`

---

## Durable facts

- (No durable facts promoted yet — promoted by `/handoff:close` when confidence ≥ 9 and user_stated across multiple sessions)

---

## Next session — read first

- Codex onboarding COMPLETE 2026-09-11: hooks phase 2 written (`--host codex` on loader-hook/loader-stop) + owner re-trusted via CLI /hooks; 8 adapter skills installed to ~/.agents/skills; MCP env verified via new `status` host/promotion_file fields (PR #292 f3bab5b).
- Verified 2026-09-11: CodeQL alerts 2,3 FIXED 09-10; ci-watch-foreground-guard fires live (63 tests); vLLM autostart task + systemd service OK, real reboot untested; SessionEnd implicit-close path verified by reading (handoff.js ~10137-10199), no fire evidence yet (last loader-stop outcome no_marker).
- Stale leads retired: cm#224 CLOSED (PR #225); cm#233 CLOSED (PR #252 intentKey); runbook §17.5 items 1-4 all DECIDED 2026-09-06 (1 and 4 amended in §17.7.E/F); pwa-etl migrate-08 written 09-06.
- NOT SHIPPED from §17.5 decisions: feature_usage table (§17.7.F; DDL unread) and init-time Q&A (item 2, V7/V8/V9 owner-review points). routing-identity.js SHIPPED.
- Root tree clean 2026-09-11 (12 untracked artifacts deleted; snapshot in Downloads).
- NEXT: (1) feature_usage table DDL + migration — owner go required; (2) init-time Q&A design per V7-V9; (3) real-reboot vLLM test when convenient.
