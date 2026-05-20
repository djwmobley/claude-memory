# /handoff:purge — Hard delete all project memory (confirmation required)

> Running: handoff:purge

Permanently delete all notes for this project. There is no undo. Everything goes: entities, assertions, edges, retrieval contracts, project settings, and `handoff.md`. The command will ask you to confirm before running.

If you want to archive instead of delete — keeping rows in the database where a developer can recover them — use `/handoff:drop` instead.

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

# Only run with --yes after explicit user confirmation
PROJECT_ROOT="$PROJECT_ROOT" node "$HANDOFF_ENGINE" purge --yes
```

## Tables cleared

- `entities WHERE project_id = <current>`
- `assertions WHERE project_id = <current>`
- `edges WHERE project_id = <current>`
- `retrieval_contract WHERE project_id = <current>`
- `project_settings WHERE project_id = <current>`
- `handoff.md` deleted from `~/.claude/projects/<encoded_cwd>/handoff.md`

## Expected output

```
Running: handoff:purge

  All rows deleted for project_id="C--Users-username-dev-my-project".
  handoff.md removed.

Done: handoff:purge — all project memory permanently deleted
```

> Done: handoff:purge — all project memory permanently deleted
