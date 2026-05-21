# /handoff:status — Read-only project memory status

> Running: handoff:status

Quick health check. Shows when the last session closed, how many entities, assertions, and edges are in the database, and warns you if the data is stale. It makes no writes — safe to run any time.

## What this shows

- `last_close` timestamp from `handoff.md` frontmatter and days since close.
- `COUNT(*)` from `entities`, `assertions`, `edges` scoped to this project.
- Current retrieval contract names stored in `retrieval_contract`.
- Whether a `session_in_progress` marker is present in `project_settings`.

## Arguments

| Flag | Default | Meaning |
|------|---------|---------|
| `--json` | off | Emit all computed fields as a single JSON object to stdout instead of prose. |
| `--breakdown` | off | Add per-tier (probationary / consolidated / grandfathered), suppressed-vs-live, and top-predicate counts under the prose output (or inside the JSON object when combined with `--json`). |
| `--stale-pointers` | off | Count assertions whose `file:line` code pointers no longer resolve against the working tree. Printed as a one-line count in prose mode; included as `stale_pointer_count` in the JSON object when combined with `--json`. |

Flags may be combined freely: `--json --breakdown --stale-pointers` emits a single JSON object that includes all three enhancements.

## How to invoke

```bash
# Resolve engine script and project root.
# Plugin mode: CLAUDE_PLUGIN_ROOT is set by the Claude Code runtime when loaded as a plugin.
# Standalone mode: walk up from cwd to find the project root containing scripts/handoff.js.
if [ -n "$CLAUDE_PLUGIN_ROOT" ]; then
  HANDOFF_ENGINE="$CLAUDE_PLUGIN_ROOT/scripts/handoff.js"
  PROJECT_ROOT=$(pwd)
  while [ ! -f "$PROJECT_ROOT/.claude-memory" ] && [ "$PROJECT_ROOT" != "/" ]; do
    PROJECT_ROOT=$(dirname "$PROJECT_ROOT")
  done
  if [ ! -f "$PROJECT_ROOT/.claude-memory" ]; then
    echo "Error: no .claude-memory marker found — run /handoff:init first."
    exit 1
  fi
else
  PROJECT_ROOT=$(pwd)
  while [ ! -f "$PROJECT_ROOT/.claude-memory" ] && [ ! -d "$PROJECT_ROOT/.git" ] && [ "$PROJECT_ROOT" != "/" ]; do
    PROJECT_ROOT=$(dirname "$PROJECT_ROOT")
  done
  if [ "$PROJECT_ROOT" = "/" ] && [ ! -f "$PROJECT_ROOT/.claude-memory" ] && [ ! -d "$PROJECT_ROOT/.git" ]; then
    PROJECT_ROOT=$(pwd)
  fi
  if [ ! -f "$PROJECT_ROOT/scripts/handoff.js" ]; then
    echo "Error: scripts/handoff.js not found — is this a claude-memory project?"
    exit 1
  fi
  HANDOFF_ENGINE="$PROJECT_ROOT/scripts/handoff.js"
fi

# Default prose output:
PROJECT_ROOT="$PROJECT_ROOT" node "$HANDOFF_ENGINE" status

# JSON output:
PROJECT_ROOT="$PROJECT_ROOT" node "$HANDOFF_ENGINE" status --json

# Prose with trust-tier and suppression breakdown:
PROJECT_ROOT="$PROJECT_ROOT" node "$HANDOFF_ENGINE" status --breakdown

# JSON with all three enhancements:
PROJECT_ROOT="$PROJECT_ROOT" node "$HANDOFF_ENGINE" status --json --breakdown --stale-pointers
```

## Expected output

**Default prose:**
```
Running: handoff:status

  === handoff status ===
  project_id:       C--Users-username-dev-my-project
  last_close:       2026-05-14T22:30:00Z (1 day(s) ago)
  handoff.md:       ~/.claude/projects/C--Users-username-dev-my-project/handoff.md
  entities:         23
  assertions:       47
  edges:            12
  contracts:        default
  session_active:   no

Done: handoff:status — 23 entities, 47 assertions, 12 edges
```

**With `--json`:**
```json
{
  "project_id": "C--Users-username-dev-my-project",
  "db": "connected",
  "handoff_md": "/home/username/.claude/projects/.../handoff.md",
  "last_close": "2026-05-14T22:30:00Z",
  "days_since": 1,
  "entities": 23,
  "assertions": 47,
  "edges": 12,
  "contracts": ["default"],
  "session_active": false,
  "session_id": null,
  "packaging": "clean"
}
```

**With `--breakdown` added to prose:**
```
  --- breakdown ---
  by tier:
    consolidated: 34
    grandfathered: 8
    probationary: 5
  by suppression:
    live: 41
    suppressed(downvoted_probation): 5
    suppressed(superseded): 1
  top predicates (live assertions):
    uses: 12
    status: 8
    depends_on: 7
    ...
```

**With `--stale-pointers` added:**
```
  stale pointers:   3
```

> Done: handoff:status — status shown
