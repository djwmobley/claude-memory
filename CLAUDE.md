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
- Open PR #313 (public manifest + lift; base branch `main`, not GitHub-stacked on #306): leads — db-seam must LIFT, a manifest self-hash rule, ~140 LIFT files carrying live gate findings, a CLAUDE.md owner decision needed; tests fail only because scripts/sanitize-gate.js isn't on main yet — rebase/retest after #306 merges.
- Open PR #315 (feat/migrate-09-dry-run, 7704758): migrate-09 dry-run; write-gate escapes fixed (EXPLAIN ANALYZE <write>, double-quoted identifier apostrophe); MERGEABLE, CI green; round-3 owner ruling pending.
- Owner rulings 2026-09-13: Codex is directed, not consulted; scope fence holds; round cap is 2, then escalate to owner; no rearchitecting; stdio only; zip-only distribution with prereq check + assist; §15 stays a parallel track.
- Owner ruled 2026-09-13 to proceed on #305 (fix items a-d: ledger re-check total classification, anchored halt-clear marker, structured scope_request verdict field replacing widening regex, renames from `git diff --name-status -M`) and #306 (fix a-e + sanitize.yml `types:`; base-less mode becomes derive-or-BLOCK). #312 and #315 rulings still pending.
- Codex leak finding: the Codex desktop app-server spawns a full MCP fleet per thread and never reaps it (observed 7 fleets, 339 procs); `handoff` itself exits cleanly (see #307).
- CI note: a CONFLICTING PR may still display a `tests` run from before it became conflicting (#306 and #313 both do); trust a check only if its run SHA equals the current head and the merge ref exists; merge main first.
- `db-triage.json`: 81 DBs classified locally, 0 unclassified; 5 flagged for owner review (interview-coach, dentaltalentconnect, judge, ppp, spring).
- §15 forks pending owner decision: project_id namespace re-key, cm#212 grandfathering, Advisicon absorb.
- feature_usage: PR #255 shipped, migrate-12 backfill applied to `memory_manager_staging` (project_id `pipeline`, `cost_usd` NULL — source has no cost column); canon DB `memory_manager` not yet created, promotion gated on §15 acceptance.
- Init-time Q&A: judge PR #20 (`docs/specs/init-routing-qa.md`) was OPEN, blocked by judge main red on the session-end worktree guard test (judge-owned fix); author worktree kept — status not reverified this session, check judge repo before acting.
- Engine defect found: the long-lived handoff MCP server freezes SCHEMA_EPOCH at startup (handoff-mcp.mjs requires handoff.js once); its in-process DB tools fail "ahead" (stored 5 vs current 4) while `handoff_status` proxies the child's epoch and reports no drift; the withProjectDb remedy text is wrong (only an MCP reconnect fixes it). Fix queued: status reports `engine.server_loaded` epoch with a drift branch + remedy "reconnect the handoff MCP server"; withProjectDb's "ahead" remedy says the same.
- Engine defect found: close-time reality probes (scripts/lib/reality-checks.js) read the local checkout; when local main lags origin after squash merges, handoff.md's Degraded section carries false "not-merged"/"absent" rows (8 + 3 last close). Fix queued: fetch origin fail-soft before commit_merged/in_file probes and compare against origin/<default>.
- All 5 author worktrees are behind their origin branch heads; the duplicate feat/public-sanitize-gate worktree agent-aa71859297111a0b1 is dirty (docs/specs/public-sanitize-gate.md modified) — inspect its diff before pruning.
- NEXT: (1) #305/#306 round-3 fixes → independent review → merge; (2) #313 rebase + #312/#315 rulings; (3) MCP server in-process epoch fix; (4) reality-probe origin fetch fix; (5) memory-file migration (migrate-05/migrate-09); (6) §15 batch B.
