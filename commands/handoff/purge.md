# /handoff:purge — Hard delete all project memory (confirmation required)

> Running: handoff:purge

Permanently delete all notes for this project. There is no undo. Everything goes: entities, assertions, edges, retrieval contracts, project settings, and `handoff.md`. The command will ask you to confirm before running.

If you want to archive instead of delete — keeping rows in the database where a developer can recover them — use `/handoff:drop` instead.

## Arguments

| Flag | Default | Meaning |
|------|---------|---------|
| `--yes` | off | Skip the interactive confirmation prompt and execute immediately. |
| `--dry-run` | off | Print the per-table row counts that WOULD be deleted, then exit without deleting anything. Overrides `--yes` and bypasses all prompts. Safe to run any time. |

## Confirmation requirement

This command REQUIRES an explicit "yes" confirmation before executing.
Do not proceed without confirmation from the user.

Ask the user:

> "This will permanently delete ALL memory rows for this project, including all
> entities, assertions, edges, retrieval contracts, project settings, and handoff.md.
> This cannot be undone. Type 'yes' to confirm, or anything else to cancel."

If the user confirms with "yes", run with `--yes` to bypass the interactive prompt.
If the user does not confirm, do not run the command.

## How to invoke (after confirmation)

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

# Only run with --yes after explicit user confirmation
PROJECT_ROOT="$PROJECT_ROOT" node "$HANDOFF_ENGINE" purge --yes

# Dry-run: see what would be deleted without deleting anything
PROJECT_ROOT="$PROJECT_ROOT" node "$HANDOFF_ENGINE" purge --dry-run
```

## Tables cleared

- `entities WHERE project_id = <current>`
- `assertions WHERE project_id = <current>`
- `edges WHERE project_id = <current>`
- `retrieval_contract WHERE project_id = <current>`
- `project_settings WHERE project_id = <current>`
- `handoff.md` deleted from `~/.claude/projects/<encoded_cwd>/handoff.md`

## Expected output

**After `--yes` confirmation:**
```
Running: handoff:purge

  All rows deleted for project_id="C--Users-username-dev-my-project".
  handoff.md removed.

Done: handoff:purge — all project memory permanently deleted
```

**With `--dry-run` (nothing deleted):**
```
Running: handoff:purge

  Dry-run — rows that WOULD be deleted for project_id="C--Users-username-dev-my-project":
    edges: 12
    assertions: 47
    entities: 23
    retrieval_contract: 1
    project_settings: 8
    handoff.md: exists (would be deleted)

  (Dry-run — no rows deleted, no files removed.)

Done: handoff:purge — dry-run complete (no changes made)
```

> Done: handoff:purge — all project memory permanently deleted
