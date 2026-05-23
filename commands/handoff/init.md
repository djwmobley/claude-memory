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
| `-y` / `--yes` / `--force` | off | Bypass the confirmation prompt and auto-create the database if absent. Required for non-interactive / agent / CI use. |

## Confirmation gate

`init` always prints the resolved target DB and its source tier before touching any
schema. When running interactively (stdin is a TTY) without a bypass flag, it prompts:

```
  Apply handoff schema to database '<DB>' (source: <source>)? [y/N]:
```

Answering anything other than `y` / `yes` aborts with no changes.

When stdin is **not** a TTY (script, agent, CI pipeline) and no bypass flag is present,
`init` **safe-fails** immediately with a clear message — it never hangs waiting for input.
Pass `-y` (or `--yes` / `--force`) to bypass confirmation in those contexts.

## Expected output

```
Running: handoff:init

  [OK]    .claude-memory marker minted (deferred): uuid=<uuid>
          Path: <project_root>/.claude-memory (written last on success)
  Resolved target DB: claude_memory_eval_test  (source: built-in default)
  [OK]    Node version >= 18
  [OK]    Database 'claude_memory_eval_test' present
  [OK]    Schema file present: handoff-core-schema.sql
  [OK]    Schema applied: handoff-core-schema.sql
  [OK]    project_settings defaults ensured (27 keys, idempotent)
  [OK]    retrieval_contract 'default' row ensured
  [OK]    retrieval_contract_history baseline ensured (idempotent)
  [OK]    handoff.md created: ~/.claude/projects/<uuid>/handoff.md
  [OK]    CLAUDE.md created: <project_root>/CLAUDE.md
  [NOTE]  CLAUDE.md should be git-committed.
  [OK]    .claude-memory marker written: uuid=<uuid>

Done: handoff:init — project <uuid> provisioned
```

> Done: handoff:init — project initialized
