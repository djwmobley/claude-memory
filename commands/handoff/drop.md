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
# Walk up from cwd for .claude-memory marker first, then fall back to .git.
PROJECT_ROOT=$(pwd)
while [ ! -f "$PROJECT_ROOT/.claude-memory" ] && [ ! -d "$PROJECT_ROOT/.git" ] && [ "$PROJECT_ROOT" != "/" ]; do
  PROJECT_ROOT=$(dirname "$PROJECT_ROOT")
done
if [ "$PROJECT_ROOT" = "/" ] && [ ! -f "$PROJECT_ROOT/.claude-memory" ] && [ ! -d "$PROJECT_ROOT/.git" ]; then
  PROJECT_ROOT=$(pwd)
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
