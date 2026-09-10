---
name: handoff-checkpoint
description: Mid-session save of an extraction payload without ending the session.
---
<!-- managed-by: claude-memory handoff-skills v1 sha256:d50c92f384609319427cef98222f43919d8234ae8813186d0132d7b432127d55 -->
## Resolve projectRoot

Before calling any tool below, resolve `projectRoot`: starting at the current working directory and walking upward one directory at a time, find the first directory that contains either a `.memory-engine` marker file, a legacy `.claude-memory` marker file, or a `.git` directory. Use that directory as `projectRoot`. If none is found before reaching the filesystem root, use the current working directory as `projectRoot`.

## What this does

Call the `mcp__handoff__handoff_checkpoint` tool with `projectRoot` resolved as above and a `payload` object describing what happened so far in the session (entities, assertions, edges — a partial extraction is fine, checkpoints have no completeness requirement). If the `CODEX_THREAD_ID` environment variable is set to a non-empty value, include it as the `session_id` field inside `payload` (this tool accepts `session_id` as one of the allowed payload keys). This does not end the session — the working session stays open after the call.
