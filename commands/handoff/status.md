# /handoff:status — Read-only project memory status

> Running: handoff:status

This slash command shows the current state of the handoff memory for the project
in your working directory. It makes no writes.

## What this shows

- `last_close` timestamp from `handoff.md` frontmatter and days since close.
- `COUNT(*)` from `entities`, `assertions`, `edges` scoped to this project.
- Current retrieval contract names stored in `retrieval_contract`.
- Whether a `session_in_progress` marker is present in `project_settings`.

## How to invoke

```bash
# Detect project root
PROJECT_ROOT=$(pwd)
while [ ! -d "$PROJECT_ROOT/.git" ] && [ "$PROJECT_ROOT" != "/" ]; do
  PROJECT_ROOT=$(dirname "$PROJECT_ROOT")
done

if [ ! -f "$PROJECT_ROOT/scripts/handoff.js" ]; then
  echo "Error: scripts/handoff.js not found — is this a claude-memory project?"
  exit 1
fi

node "$PROJECT_ROOT/scripts/handoff.js" status
```

## Expected output

```
Running: handoff:status

  === handoff status ===
  project_id:       C--Users-djwmo-dev-claude-memory
  last_close:       2026-05-14T22:30:00Z (1 day(s) ago)
  handoff.md:       ~/.claude/projects/C--Users-djwmo-dev-claude-memory/handoff.md
  entities:         23
  assertions:       47
  edges:            12
  contracts:        default
  session_active:   no

Done: handoff:status — 23 entities, 47 assertions, 12 edges
```

> Done: handoff:status — status shown
