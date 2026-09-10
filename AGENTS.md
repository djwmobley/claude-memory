# agent-a0979417bd522838e

Memory and retrieval infrastructure project.

---

## Operating canon (non-negotiable)

These rules are canon. They override convenience, time pressure, and apparent context. Violating them is a workflow bug to be remediated, not a stylistic choice.

1. **Follow the user's directions and scope exactly.** When asked to do X, and X has an established definition (a backlog item, a prior handoff, a multi-part deliverable), deliver all of X. Do not silently narrow scope, reinterpret it, or substitute a smaller deliverable. If scope genuinely seems too large or ambiguous, say so and ask — do not shrink it unilaterally.
2. **Never autonomously defer authorized work to a subsequent session, bundle, or phase.** Deferring in-scope work without explicit user say-so is a bug. Surface genuine design forks as written open questions with a recommended lean; never use deferral or an invented "later phase" as a mechanism to offload work that is in scope now.

---

## MCP tools

The project-memory MCP server is registered as `handoff`; its tools surface with the `mcp__handoff__` prefix.

- `mcp__handoff__handoff_resume` — force-load prior-session context.
- `mcp__handoff__handoff_checkpoint` — mid-session save; session stays open.
- `mcp__handoff__handoff_close` — end-of-session extraction and close.
- `mcp__handoff__handoff_status` — read-only status (counts, last close, embedding readiness).
- `mcp__handoff__memory_search` — free-text search across project memory (only tables present in the project database are searched).
- `mcp__handoff__entity_read` — read stored entities.
- `mcp__handoff__assertion_read` — read stored assertions.
- `mcp__handoff__edge_read` — read stored relationships between entities.
- `mcp__handoff__persist_decisions` — record roadmap/design decisions.

---

## Key paths

<!-- memory-engine:key-paths v2 -->
- Handoff file: `~/.claude/projects/<project-id>/handoff.md` — `<project-id>` is the marker UUID in `.memory-engine` (or legacy `.claude-memory`) at the repo root, falling back to the encoded-cwd id for un-migrated projects. See `resolveHandoffMdPath` in `scripts/lib/handoff-paths.js` of the engine.
- Helper script: `<engine-root>/scripts/handoff.js` — the claude-memory checkout; standalone installs record it in `<base>/commands/handoff/.engine-path`. Never `<repo-root>` — the target project is not the engine.

---

## Durable facts

- (No durable facts promoted yet — promoted via the `handoff-promote` skill, or automatically on close when confidence >= 9 and user_stated across multiple sessions)
