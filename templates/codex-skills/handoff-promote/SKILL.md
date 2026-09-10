---
name: handoff-promote
description: Promote a specific stored assertion to the durable-facts section of the project promotion file.
---
<!-- managed-by: claude-memory handoff-skills v1 sha256:114497da47bba4fd03bcbd3d98e2527281f7ef0cdefc6dcd3f30f95cd4db14e3 -->
## Resolve projectRoot

Before calling any tool below, resolve `projectRoot`: starting at the current working directory and walking upward one directory at a time, find the first directory that contains either a `.memory-engine` marker file, a legacy `.claude-memory` marker file, or a `.git` directory. Use that directory as `projectRoot`. If none is found before reaching the filesystem root, use the current working directory as `projectRoot`.

## What this does

There is currently no dedicated MCP tool for promoting a single assertion to the durable-facts section of the project promotion file — say so plainly if asked. As a fallback, this can be done from a shell by running the project's `handoff.js promote` subcommand directly (by id, or by `--subject`/`--predicate`/`--object` content match) against `projectRoot` resolved as above; consult that script's own `promote` help output for exact usage, since this skill deliberately does not restate CLI flags that could drift out of sync with the script.
