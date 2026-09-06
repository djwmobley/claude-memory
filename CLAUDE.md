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

- pwa-etl onboarding DONE 2026-09-05: per-project engine live — DB `pipeline_pwa_etl`, marker `ef808da0-f490-473d-9f08-28b6c8297e85`, 583 decisions migrated (original ids, vLLM Qwen3 embeddings, halfvec 4000), seed close written (4 entities/20 assertions/3 edges), resume served 5 open threads, three wiring files applied locally (untracked by design), rotate-handoff removed from `.mcp.json`. Operator follow-ups: relaunch pwa-etl to confirm SessionStart resolves the marker; two stale rotate-handoff permission entries in `.claude/settings.local.json` (lines 9, 14); seed had 19 assertions but close wrote 20 (lead, likely the tldr row). Runbook §16.4 has detail.
- §17 routing gap-audit is still the plan's next step (CONSOLIDATION-RUNBOOK.md §17) — read docs/notes/2026-09-02-s17-routing-harness-status.md. Gap-audit existing route_resolve / routing_profile_* / usage_* MCP tools against the §17 schema before any planning. Thread was mis-filed in DentalTalentConnect and re-parked here.
