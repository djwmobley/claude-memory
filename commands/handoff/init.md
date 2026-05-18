# /handoff:init — First-run provisioning

> Running: handoff:init

This slash command provisions the handoff infrastructure for the current project.
It is idempotent: safe to run on a project that is already initialized.

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
# Detect project root — prefer .claude-memory marker, fall back to .git
PROJECT_ROOT=$(pwd)
while [ ! -f "$PROJECT_ROOT/.claude-memory" ] && [ ! -d "$PROJECT_ROOT/.git" ] && [ "$PROJECT_ROOT" != "/" ]; do
  PROJECT_ROOT=$(dirname "$PROJECT_ROOT")
done
# If we stopped at root without finding either, reset to cwd (engine handles provisioning)
if [ "$PROJECT_ROOT" = "/" ] && [ ! -f "$PROJECT_ROOT/.claude-memory" ] && [ ! -d "$PROJECT_ROOT/.git" ]; then
  PROJECT_ROOT=$(pwd)
fi

# Verify this is a claude-memory project
if [ ! -f "$PROJECT_ROOT/scripts/handoff.js" ]; then
  echo "Error: scripts/handoff.js not found — is this a claude-memory project?"
  exit 1
fi

node "$PROJECT_ROOT/scripts/handoff.js" init
```

Optional positional args passed through to the helper:
- `$1` — project name (defaults to directory name)
- `$2` — project description (defaults to generic placeholder)

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
