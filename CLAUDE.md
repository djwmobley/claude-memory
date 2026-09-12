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

- feature_usage: code shipped PR #255 (2026-09-06); 2026-09-11 DDL applied to `memory_manager_staging` + migrate-12 backfill 7/7 rows, project_id `pipeline`.
- feature_usage `cost_usd` is NULL for all 7 rows (source table has no cost column); backups in `Downloads\pg-backups\`, run reports in `Downloads\feature-usage-reports\`.
- Canon DB `memory_manager` not created — staging-first per runbook §15; feature_usage not yet promoted.
- 2026-09-12 owner rule: "coordinate with Codex" means the feature must work with Codex as host AND Codex checks the work (`codex exec`, read-only sandbox; working binary under `AppData\Local\OpenAI\Codex\bin`; the `~/.codex/.sandbox-bin` copy lacks the code-mode host).
- Codex-host gap found: usage tools failed on every engine DB because telemetry DDL was missing from `scripts/sql/schema-manifest.json`.
- Fix PR #298 (91f58a2): DDL moved to `scripts/sql/usage-telemetry-schema.sql` + `feature-usage-schema.sql`, registered, schema_epoch 5, required_roster, manifest lint T11, fail-soft `model_registry` cost lookup.
- Fix PR #299 (a878554): MCP annotations on all 35 tools (readOnlyHint false everywhere — heal-on-touch may write), actionable 42P01 errors, `scripts/lib/session-identity.js`, `docs/hosts/codex.md` approval section.
- Fix PR #300 (44f7638): `usage_record` sessionId falls back to the project session marker (strict: host-filtered, exactly one); markers now record host and keep fields on rewrite.
- Codex config: `~/.codex/config.toml` now sets `approval_mode="approve"` for `usage_query`/`usage_record` (backup `config.toml.bak-2026-09-12-usage-approval`); `codex exec` rejects MCP calls without such entries.
- End-to-end verified 2026-09-12 via `codex exec` on main 44f7638: `handoff_status` shows host codex; `usage_query` by feature → empty; `usage_record` without sessionId → written with `session_id_source` marker; `usage_query` by role shows the row; empty sessionId rejected. Verdict: works; probe row deleted.
- Init-time Q&A: judge PR #20 (`docs/specs/init-routing-qa.md`) OPEN, blocked by judge main red on the session-end worktree guard test (judge-owned fix); author worktree kept.
- Engine defects filed: cm#295 (hook/MCP session-id split after `/clear` → spurious implicit close; marker left in place), cm#297 (close pointer gate suppresses session_tldr/open_thread citing cross-repo file:line; suppression_kind NULL).
- NEXT: (1) fix cm#295 and cm#297 (plan → adversary → author → Codex check → approve); (2) judge fixes its red test, merges PR #20, implements init Q&A; (3) promote feature_usage to canon when §15 acceptance runs.
- NEXT continued: (4) every feature: run through the Codex MCP path + `codex exec` check before done.
