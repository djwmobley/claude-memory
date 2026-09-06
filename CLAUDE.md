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

- pwa-etl onboarding DONE 2026-09-05: per-project engine live, 583 decisions migrated; follow-ups done except seed 19-vs-20 lead, attributed to L3 has_unpackaged_state injection (static read).
- 2026-09-06 sweep merged 10 PRs (squash shas): #234 4ab0478 §17 gap-audit note; #235 8c0ac27 route_resolve hints+tests; #236 726b1e9 cm#231 MCP write-path unified; #237 51915cd Dependabot bumps; #238 9260b51 cm#232 live counts+naming (cm#233 NOT shipped).
- #239 9f48a74 cm#230 decisions[] persisted via shared writer; #240 b54877c cm#222 migrate-08 parser (dry-run, total-classification); #241 9a8dd61 §17 B1 model/routing overrides, roster 35, cm#167 closed; #242 b5bed21 implicit close gates on SessionEnd; #243 a12e8f9 decisions count on Done line.
- Verified CLOSED on GitHub: issues 222, 230, 231, 232, 167. cm#224 still OPEN despite PR #225 claiming the fix — recheck before assuming done. cm#233 OPEN by design (not shipped).
- NEXT: (1) verify SessionEnd hook — after real exit, session_in_progress marker cleared, implicit close recorded only if no explicit close ran; (2) private-runbook §17.5(i)-(iv) owner decisions pending; (3) cm#233 design call: cosmetic fix vs migrate subject+matcher together.
- (4) cm#224 state check — PR #225 claimed the fix but issue is still open; (5) pwa-etl HANDOFF-HISTORY.md migrate-08 write mode unblocked (H-13 passed) — owner go required before writing to pipeline_pwa_etl.
