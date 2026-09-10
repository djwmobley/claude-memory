---
name: handoff-init
description: First-run provisioning for a project: schema, handoff file, and promotion file.
---
<!-- managed-by: claude-memory handoff-skills v1 sha256:b8281446cc4b35a3364b76fea3659597969f69f5ae2deeb917eff284593c0921 -->
## Resolve projectRoot

Before calling any tool below, resolve `projectRoot`: starting at the current working directory and walking upward one directory at a time, find the first directory that contains either a `.memory-engine` marker file, a legacy `.claude-memory` marker file, or a `.git` directory. Use that directory as `projectRoot`. If none is found before reaching the filesystem root, use the current working directory as `projectRoot`.

## What this does

Call the `mcp__handoff__handoff_init` tool with `projectRoot` resolved as above (optionally a human-readable `name`; it defaults to the directory basename). This tool takes no session id. It is safe to re-run — it is idempotent and only provisions what is missing (schema, the handoff file, the promotion file, and the project marker).
