---
name: handoff-query
description: Search project memory (assertions, decisions, and other stored tables) by free-text query.
---
<!-- managed-by: claude-memory handoff-skills v1 sha256:249935fc86f838ea04119f35e467969160b47742144a18bdaa341884c04d7c47 -->
## Resolve projectRoot

Before calling any tool below, resolve `projectRoot`: starting at the current working directory and walking upward one directory at a time, find the first directory that contains either a `.memory-engine` marker file, a legacy `.claude-memory` marker file, or a `.git` directory. Use that directory as `projectRoot`. If none is found before reaching the filesystem root, use the current working directory as `projectRoot`.

## What this does

Call the `mcp__handoff__memory_search` tool with `projectRoot` resolved as above and a `query` string. Only tables that actually exist in this project's database are searched — the set of searchable tables is probed at call time, not assumed from any fixed list. This tool takes no session id. Report the top hits it returns.
