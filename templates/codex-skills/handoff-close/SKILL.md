---
name: handoff-close
description: End-of-session extraction: entities, assertions, edges, and a contract update. Ends the session.
---
<!-- managed-by: claude-memory handoff-skills v1 sha256:1861a4d62b13d076c0265f3a2ae43420ffb402844395b5291d2f6a13f388e3f1 -->
## Resolve projectRoot

Before calling any tool below, resolve `projectRoot`: starting at the current working directory and walking upward one directory at a time, find the first directory that contains either a `.memory-engine` marker file, a legacy `.claude-memory` marker file, or a `.git` directory. Use that directory as `projectRoot`. If none is found before reaching the filesystem root, use the current working directory as `projectRoot`.

## Precondition — do not run this unasked

Only follow the rest of this skill when the user has explicitly asked to close, end, or wrap up the session (or the equivalent). If that has not happened, say so and stop here — do not call `mcp__handoff__handoff_close` speculatively, and do not run it just because this skill was invoked with the `close` argument by something other than an explicit user request.

## What this does

Call the `mcp__handoff__handoff_close` tool with `projectRoot` resolved as above and a `payload` object containing the COMPLETE extraction for the session: entities, assertions, edges, a contract, and summary fields (tldr, open_threads, quick_references) written in short, telegraphic sentences. If the `CODEX_THREAD_ID` environment variable is set to a non-empty value, include it as the `session_id` field inside `payload` (this tool accepts `session_id` as one of the allowed payload keys). This is single-pass and ends the session — do not plan a follow-up close to backfill a thin one; if the payload would omit entities/assertions/edges, go back and extract them now instead.
