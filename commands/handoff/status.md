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

## Preferred path — MCP

If the `mcp__handoff__handoff_status` tool is available in this session, call it directly — it returns the same structured fields as `status --json` (project_id, entity/assertion/edge counts, handoff.md path, last_close/days_since, contracts, session_active, session_id, packaging) without a shell round-trip. Read-only — makes no writes.

```
ToolSearch({ query: "select:mcp__handoff__handoff_status" })
mcp__handoff__handoff_status({ projectRoot: "<absolute path to project root>" })
```

`--breakdown` and `--stale-pointers` are not currently exposed as MCP tool parameters — use the CLI form below if you need those.

If `mcp__handoff__handoff_status` is not available, fall back to the CLI recipe below.


## How to invoke

```bash
# ── Engine resolution (4-tier; independent of project-root resolution) ──────
# Tier 1: explicit override via HANDOFF_ENGINE env var
if [ -n "$HANDOFF_ENGINE" ] && [ -f "$HANDOFF_ENGINE" ]; then
  : # use as-is
# Tier 2: plugin mode (CLAUDE_PLUGIN_ROOT set by Claude Code runtime)
elif [ -n "$CLAUDE_PLUGIN_ROOT" ]; then
  HANDOFF_ENGINE="$CLAUDE_PLUGIN_ROOT/scripts/handoff.js"
# Tier 3: clone mode — walk up from cwd for scripts/handoff.js
else
  _CLONE_ROOT=$(pwd)
  while [ ! -f "$_CLONE_ROOT/scripts/handoff.js" ] && [ "$_CLONE_ROOT" != "/" ]; do
    _CLONE_ROOT=$(dirname "$_CLONE_ROOT")
  done
  if [ -f "$_CLONE_ROOT/scripts/handoff.js" ]; then
    HANDOFF_ENGINE="$_CLONE_ROOT/scripts/handoff.js"
  # Tier 4: standalone install — read engine path recorded by install.js
  elif [ -f "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/commands/handoff/.engine-path" ]; then
    HANDOFF_ENGINE=$(cat "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/commands/handoff/.engine-path" | tr -d '[:space:]')
  else
    echo "Error: handoff engine not found. This looks like a standalone install with no recorded engine path."
    echo "  Fix option A: set HANDOFF_ENGINE=/abs/path/to/scripts/handoff.js"
    echo "  Fix option B: re-run node /path/to/claude-memory/scripts/install.js to record .engine-path"
    exit 1
  fi
fi
if [ ! -f "$HANDOFF_ENGINE" ]; then
  echo "Error: resolved engine path does not exist: $HANDOFF_ENGINE"
  exit 1
fi

# ── Project-root resolution ──────────────────────────────────────────────────
# Walk up from cwd for a .memory-engine marker (or the legacy .claude-memory
# name, still recognized as a read-fallback) first, then fall back to .git.
PROJECT_ROOT=$(pwd)
while [ ! -f "$PROJECT_ROOT/.memory-engine" ] && [ ! -f "$PROJECT_ROOT/.claude-memory" ] && [ ! -d "$PROJECT_ROOT/.git" ] && [ "$PROJECT_ROOT" != "/" ]; do
  PROJECT_ROOT=$(dirname "$PROJECT_ROOT")
done
if [ "$PROJECT_ROOT" = "/" ] && [ ! -f "$PROJECT_ROOT/.memory-engine" ] && [ ! -f "$PROJECT_ROOT/.claude-memory" ] && [ ! -d "$PROJECT_ROOT/.git" ]; then
  PROJECT_ROOT=$(pwd)
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
