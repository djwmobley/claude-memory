# /handoff:drop — Archive prior session memory and start fresh

> Running: handoff:drop

Archive this project's notes and start fresh. All existing assertions are suppressed — they get a confidence score so low they'll never surface in retrieval — and the `handoff.md` summary is archived with a datestamp. The rows are still in the database, so a developer can recover them via SQL if needed. Nothing is permanently deleted.

Use this when a project phase is truly over and you want a clean slate. For a hard delete with no recovery path, use `/handoff:purge` instead.

## Arguments

None — this command takes no flags or positional arguments.

## What this does

1. `UPDATE assertions SET confidence = 1.0, decay_rate = 999.0 WHERE project_id = $1`
   (effective_confidence ≈ 0 — suppressed from retrieval, but rows survive)
2. Renames `handoff.md` to `handoff.{ISO-datestamp}.archived.md`.
3. Creates a new empty `handoff.md` from the template.

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

PROJECT_ROOT="$PROJECT_ROOT" node "$HANDOFF_ENGINE" drop
```

## Expected output

```
Running: handoff:drop

  assertions zeroed: 47
  archived: ~/.claude/projects/<encoded_cwd>/handoff.2026-05-14T22-30-00-000Z.archived.md
  new handoff.md: ~/.claude/projects/<encoded_cwd>/handoff.md

Done: handoff:drop — 47 assertions suppressed, handoff.md archived
```

> Done: handoff:drop — session memory archived
