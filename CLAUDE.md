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

- 2026-09-13 merges: #302 embed URL/model resolved from projectRoot not server cwd; #303 schema-epoch drift gets a four-branch total-classification remedy, not a blanket init/resume; #307 MCP server exits cleanly on host disconnect + parent-liveness watchdog (selftest no longer orphans its child); #308 docker-compose + zip packager + install docs shipped; #309 installer prerequisite checker is a total classification; #310 `handoff_status` reports engine revision + schema epoch (loaded/disk/db/drift) — `handoff-mcp.mjs` needed no code change, it proxies `status --json` verbatim; #311 close/checkpoint sessionId resolves from the live session marker, never this server's own stale env (closes cm#295).
- Repos: private backlog renamed `memory-manager-backlog`; public `memory-manager` repo created empty.
- Open PR #305 (Codex review wrapper): round-2 cap hit, 4 in-fence items pending owner round-3 ruling.
- Open PR #306 (sanitize gate): round-2 cap hit, 5 items pending owner ruling.
- Open PR #312 (cm#297 pointer gate): round-2 cap hit, 1 item open — drive-relative `C:foo\bar` paths.
- Open PR #313 (public manifest + lift, stacked on #306): leads — db-seam must LIFT, a manifest self-hash rule, ~140 LIFT files carrying live gate findings, a CLAUDE.md owner decision needed.
- Owner rulings 2026-09-13: Codex is directed, not consulted; scope fence holds; round cap is 2, then escalate to owner; no rearchitecting; stdio only; zip-only distribution with prereq check + assist; §15 stays a parallel track.
- Codex leak finding: the Codex desktop app-server spawns a full MCP fleet per thread and never reaps it (observed 7 fleets, 339 procs); `handoff` itself exits cleanly (see #307).
- CI note: a CONFLICTING PR gets no `tests` check run at all (no merge ref) — missing tests ≠ passing; merge main first before trusting a green/absent check.
- `db-triage.json`: 81 DBs classified locally, 0 unclassified; 5 flagged for owner review (interview-coach, dentaltalentconnect, judge, ppp, spring).
- §15 forks pending owner decision: project_id namespace re-key, cm#212 grandfathering, Advisicon absorb.
- feature_usage: PR #255 shipped, migrate-12 backfill applied to `memory_manager_staging` (project_id `pipeline`, `cost_usd` NULL — source has no cost column); canon DB `memory_manager` not yet created, promotion gated on §15 acceptance.
- Init-time Q&A: judge PR #20 (`docs/specs/init-routing-qa.md`) was OPEN, blocked by judge main red on the session-end worktree guard test (judge-owned fix); author worktree kept — status not reverified this session, check judge repo before acting.
- NEXT: (1) owner rulings on #305/#306/#312 round-3 items; (2) round-3 fixes on those PRs; (3) #313 lift work; (4) memory-file migration (migrate-05/migrate-09); (5) §15 batch B.
