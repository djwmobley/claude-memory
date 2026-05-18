# /handoff:purge — Hard delete all project memory (confirmation required)

> Running: handoff:purge

This slash command permanently deletes all memory rows for the current project:
entities, assertions, edges, retrieval contracts, and project settings. It also
deletes `handoff.md`. **This is not reversible.**

Use `/handoff:drop` instead if you want a recoverable archive.

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
# Detect project root
PROJECT_ROOT=$(pwd)
while [ ! -d "$PROJECT_ROOT/.git" ] && [ "$PROJECT_ROOT" != "/" ]; do
  PROJECT_ROOT=$(dirname "$PROJECT_ROOT")
done

if [ ! -f "$PROJECT_ROOT/scripts/handoff.js" ]; then
  echo "Error: scripts/handoff.js not found — is this a claude-memory project?"
  exit 1
fi

# Only run with --yes after explicit user confirmation
node "$PROJECT_ROOT/scripts/handoff.js" purge --yes
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
