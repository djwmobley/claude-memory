---
name: handoff
description: Project memory dispatcher: with no argument, shows status and lists the sub-skills below; with an argument, defers to the matching handoff-* sub-skill. Never closes a session on its own.
---
<!-- managed-by: claude-memory handoff-skills v1 sha256:0953826390920ffc81653427228fa43524e2629480cc2869ed2a66ed0be66e54 -->
## Resolve projectRoot

Before calling any tool below, resolve `projectRoot`: starting at the current working directory and walking upward one directory at a time, find the first directory that contains either a `.memory-engine` marker file, a legacy `.claude-memory` marker file, or a `.git` directory. Use that directory as `projectRoot`. If none is found before reaching the filesystem root, use the current working directory as `projectRoot`.

## What this does

This is the dispatcher for project memory. Its behavior depends entirely on whether an argument follows the invocation:

- **No argument** (a bare invocation): call the `mcp__handoff__handoff_status` tool with `projectRoot` resolved as above, print its result, then print the list of sub-skills below, and do nothing else. Never call any write tool from this branch.
- **One argument matching a sub-skill name** (`status`, `resume`, `checkpoint`, `close`, `query`, `init`, `promote`): follow the instructions in that sub-skill (`handoff-<name>`) instead of this one.
- **An argument that matches none of the above**: print the list of sub-skill names below and stop. Do not guess which one was meant, and do not call any tool.

This dispatcher never calls a close or write tool itself under any argument — closing requires the `handoff-close` sub-skill, which only runs when the user has explicitly asked to end/close the session.

## Sub-skills

- `handoff-status` — read-only status (last close, counts, embedding readiness)
- `handoff-resume` — force-load prior-session context
- `handoff-checkpoint` — mid-session save, session stays open
- `handoff-close` — end-of-session extraction and close (only on explicit request)
- `handoff-query` — free-text search over project memory
- `handoff-init` — first-run provisioning
- `handoff-promote` — promote an assertion to durable facts
