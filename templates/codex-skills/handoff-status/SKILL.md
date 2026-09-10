---
name: handoff-status
description: Read-only project memory status: last close time, entity/assertion/edge counts, embedding readiness.
---
<!-- managed-by: claude-memory handoff-skills v1 sha256:333369b365d1cb26726df3777e04365d296735a6e050ce16cefd40d1c212436c -->
## Resolve projectRoot

Before calling any tool below, resolve `projectRoot`: starting at the current working directory and walking upward one directory at a time, find the first directory that contains either a `.memory-engine` marker file, a legacy `.claude-memory` marker file, or a `.git` directory. Use that directory as `projectRoot`. If none is found before reaching the filesystem root, use the current working directory as `projectRoot`.

## What this does

Read-only. Call the `mcp__handoff__handoff_status` tool with `projectRoot` resolved as above. This tool takes no other parameters and accepts no session id. Report the returned fields (project name/id, last close time and days since, live entity/assertion/edge counts, retrieval contracts, whether a session is in progress, and embedding readiness) to the user. Never write anything from this skill.
