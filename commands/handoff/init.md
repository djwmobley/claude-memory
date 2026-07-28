# /handoff:init — First-run provisioning

> Running: handoff:init

First-run setup. Creates the database tables, writes a project-level durable-facts promotion file (`CLAUDE.md` by default), and registers the default retrieval contract. Run once per project. Safe to re-run — it won't overwrite anything that already exists.

## What this does

1. Applies Phase 2 schema migrations to `claude_memory_eval_test` (idempotent DDL).
2. Inserts default `project_settings` rows (staleness_days, loader_token_budget, etc.) if absent.
3. Creates `~/.claude/projects/{project_id}/handoff.md` from the template if absent (base directory configurable via `HANDOFF_BASE_DIR`; default `~/.claude`).
4. Creates the durable-facts promotion file at the project root if absent (should be git-committed). Default filename `CLAUDE.md`; configurable via `HANDOFF_PROMOTION_FILE`.
5. Inserts a default `retrieval_contract` row for this project if absent.

## Preferred path — MCP

If the `mcp__handoff__handoff_init` tool is available in this session, call it directly:

```
ToolSearch({ query: "select:mcp__handoff__handoff_init" })
mcp__handoff__handoff_init({ projectRoot: "<absolute path to project root>" })
# or with an explicit name:
mcp__handoff__handoff_init({ projectRoot: "<absolute path to project root>", name: "my-project" })
```

It always runs non-interactively (equivalent to `-y`), matching the agent/CI usage pattern below — there is no interactive-confirmation mode over MCP. Returns the structured `[OK]`/`[NOTE]` provisioning report lines and the summary line. Safe to re-run — idempotent.

If `mcp__handoff__handoff_init` is not available, fall back to the CLI recipe below.


## How to invoke

Find the project root (walk up from `pwd` looking for a `.memory-engine` marker
first — or the legacy `.claude-memory` name, still recognized as a read-fallback —
then fall back to `.git`), then run:

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

# ── Project-root resolution (init provisions the cwd) ───────────────────────
# For init, the project root is always the cwd — we are provisioning it.
PROJECT_ROOT=$(pwd)

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

  [OK]    project marker minted (deferred): uuid=<uuid>
          Path: <project_root>/.memory-engine (written last on success)
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
  [OK]    project marker written: uuid=<uuid>

Done: handoff:init — project <uuid> provisioned
```

> Done: handoff:init — project initialized
