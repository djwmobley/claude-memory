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

- feature_usage (§18.3 / runbook amendment F) was ALREADY SHIPPED in PR #255 2126f6c 2026-09-06: `scripts/migrations/sql/migrate-12-feature-usage.sql`, `scripts/migrations/migrate-12-feature-usage.js`, `usage_query` granularity=feature. The prior "NOT SHIPPED" note in this block was wrong — it searched `scripts/sql` only.
- 2026-09-11: DDL applied to `memory_manager_staging` via `migrate-schema-addenda.js` (MIGRATION_RESULT: PASS); migrate-12 backfill `--write` COMPLETE: 7/7 rows from `pipeline_pipeline.feature_token_usage`, project_id `pipeline` (staging's existing slug convention for pipeline-origin rows), reconciled ids 1-7, spot checks exact, usageQuery feature-grain returns the aggregate.
- `cost_usd` is NULL for all 7 backfilled rows — the source table has no cost column.
- Backups + SHA-256 manifest: `C:\Users\djwmo\Downloads\pg-backups\` (pipeline_pipeline and memory_manager_staging pre-migrate-12 dumps). Run reports: `C:\Users\djwmo\Downloads\feature-usage-reports\`.
- Canon DB `memory_manager` does not exist yet — staging-first per runbook §15; feature_usage is not yet promoted to canon.
- Init-time Q&A (§17.1.2, V7/V8/V9): design spec handed to judge as `djwmobley/judge#20` (`docs/specs/init-routing-qa.md` + `init-routing-qa.adversary.md`, adversary round 1 G1-G10 resolved in text). Verified 2026-09-11: PR #20 state OPEN, no merge commit. V7-V9 remain owner-review points inside the spec §7.
- SessionEnd implicit close VERIFIED fired 2026-09-12T03:42Z UTC (session 028d4707), outcome `implicit_close_recorded` in `project_settings` key `last_loader_stop`.
- vLLM real-reboot test: owner confirmed working 2026-09-11; thread closed.
- Owner asked to coordinate the feature_usage work with Codex; no evidence found of Codex activity on migrate-12 (PR #255 authored by owner; Codex sessions 09-11 were in another project). Codex coordination questions pending owner answer.
- NEXT: (1) owner answers on Codex coordination for feature_usage; (2) promote feature_usage to canon `memory_manager` when §15 acceptance battery runs; (3) judge implements init Q&A per spec (judge session, not here); (4) implicit-close thread and vLLM thread are closed.
