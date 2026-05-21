# /handoff:init — First-run provisioning

> Running: handoff:init

First-run setup. Creates the database tables, writes a project-level `CLAUDE.md`, and registers the default retrieval contract. Run once per project. Safe to re-run — it won't overwrite anything that already exists.

## What this does

1. Applies Phase 2 schema migrations to `claude_memory_eval_test` (idempotent DDL).
2. Inserts default `project_settings` rows (staleness_days, loader_token_budget, etc.) if absent.
3. Creates `~/.claude/projects/{encoded_cwd}/handoff.md` from the template if absent.
4. Creates `CLAUDE.md` at the project root if absent (should be git-committed).
5. Inserts a default `retrieval_contract` row for this project if absent.

## How to invoke

Find the project root (walk up from `pwd` looking for `.claude-memory` marker first,
then fall back to `.git`), then run:

```bash
# Resolve engine script and project root.
# Plugin mode: CLAUDE_PLUGIN_ROOT is set by the Claude Code runtime when loaded as a plugin.
# Standalone mode: walk up from cwd to find the project root containing scripts/handoff.js.
if [ -n "$CLAUDE_PLUGIN_ROOT" ]; then
  HANDOFF_ENGINE="$CLAUDE_PLUGIN_ROOT/scripts/handoff.js"
  # For init, the project root is the cwd (we are provisioning it).
  PROJECT_ROOT=$(pwd)
else
  PROJECT_ROOT=$(pwd)
  while [ ! -f "$PROJECT_ROOT/.claude-memory" ] && [ ! -d "$PROJECT_ROOT/.git" ] && [ "$PROJECT_ROOT" != "/" ]; do
    PROJECT_ROOT=$(dirname "$PROJECT_ROOT")
  done
  # If we stopped at root without finding either, reset to cwd (engine handles provisioning)
  if [ "$PROJECT_ROOT" = "/" ] && [ ! -f "$PROJECT_ROOT/.claude-memory" ] && [ ! -d "$PROJECT_ROOT/.git" ]; then
    PROJECT_ROOT=$(pwd)
  fi
  if [ ! -f "$PROJECT_ROOT/scripts/handoff.js" ]; then
    echo "Error: scripts/handoff.js not found — is this a claude-memory project?"
    exit 1
  fi
  HANDOFF_ENGINE="$PROJECT_ROOT/scripts/handoff.js"
fi

PROJECT_ROOT="$PROJECT_ROOT" node "$HANDOFF_ENGINE" init

# Specify a project name:
PROJECT_ROOT="$PROJECT_ROOT" node "$HANDOFF_ENGINE" init "my-project"

# Auto-create the database without prompting:
PROJECT_ROOT="$PROJECT_ROOT" node "$HANDOFF_ENGINE" init -y

# Both together:
PROJECT_ROOT="$PROJECT_ROOT" node "$HANDOFF_ENGINE" init "my-project" -y
```

## Arguments

| Argument / flag | Default | Description |
|---|---|---|
| `<name>` | directory basename | Optional project name positional. Sets the human-readable project label written to `project_settings`. |
| `-y` | off | Skip the interactive DB-creation prompt and auto-create the database if absent. |

## Expected output

```
Running: handoff:init

  init complete:
  OK    schema migration: phase2-schema.sql
  OK    schema migration: phase3b-schema.sql
  OK    project_settings defaults inserted (5 keys, idempotent)
  OK    created handoff.md: ~/.claude/projects/<encoded_cwd>/handoff.md
  OK    created CLAUDE.md: <project_root>/CLAUDE.md
  NOTE  CLAUDE.md should be git-committed.
  OK    retrieval_contract 'default' row ensured

Done: handoff:init — project <encoded_cwd> provisioned
```

> Done: handoff:init — project initialized
