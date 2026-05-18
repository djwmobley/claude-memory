# claude-memory

Memory and retrieval infrastructure project.

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

- Handoff file: `~/.claude/projects/<encoded-cwd>/handoff.md` (populated by `/handoff:init`)
- Helper script: `<repo-root>/scripts/handoff.js`

---

## Durable facts

- (No durable facts promoted yet — promoted by `/handoff:close` when confidence ≥ 9 and user_stated across multiple sessions)
