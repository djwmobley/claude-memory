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
| `--routing` | off | Run ONLY the §17.1.2 routing configuration Q&A (see below) against an already-initialized project — skips schema apply and every other init step. Fails fast if the project has never run plain `init`. |
| `--routing-reconfigure` | off | Same as `--routing`, but also re-asks the capability tier for any role that already carries an active `routing_profiles` row (provenance-blind — it does not check who set the existing row or why). |

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

## Routing configuration Q&A (§17.1.2)

After the `retrieval_contract_history` baseline step, plain `init` runs an
OPTIONAL, interactive-only routing configuration Q&A (`scripts/lib/routing-init-qa.js`).
It never fails `init` as a whole — it only prints a `[NOTE]` and skips when it
cannot run, and any answered-so-far state is discarded (never partially
written) if the sequence is interrupted.

**Gate** — runs only when stdin is a TTY AND none of `-y` / `--yes` /
`--force` was passed. Otherwise:

```
[NOTE] routing Q&A skipped (non-interactive) — run: handoff init --routing
```

`--routing` does **not** re-enable prompting under `-y` — a non-interactive
`handoff init --routing -y` still prints the same skip note and writes
nothing.

**Precondition** — the `routing_profiles` / `model_registry` tables must
already be provisioned (via `scripts/migrations/migrate-schema-addenda.js`).
If either is missing:

```
[NOTE] routing tables not provisioned — run scripts/migrations/migrate-schema-addenda.js
```

**Flow**, when the gate and precondition both pass:

1. `Configure model routing now? [y/N]` — anything but `y`/`yes` skips
   quietly; the rest is never asked.
2. Roles to configure (comma-separated, case-sensitive — never folded).
   Pressing Enter with no input accepts the default set:
   `orchestrate,spec,draft,write,read,index,bookkeep,review`. A role that
   only differs in case from a default role name (e.g. `Draft`) is
   rejected with the canonical spelling named, and re-asked. Roles that
   already carry an active `routing_profiles` row are listed and skipped
   (not re-asked) unless `--routing-reconfigure` was passed.
3. For each remaining role: `Capability tier for '<role>' (high|mid|low)
   [suggested: <tier>]` — the suggestion is display-only, never applied;
   blank or any value outside `high|mid|low` re-asks.
4. A model-registration loop: label / provider / capability tier / cost-in
   per Mtok / cost-out per Mtok, then `Add another model? [y/N]`. Leaving
   the label blank at the start of a round ends the loop (zero or more
   models may be registered). Cost fields are parsed with `Number(...)` —
   a non-finite, negative, out-of-range, or more-than-4-fractional-digit
   value is rejected and re-asked (**never silently rounded**).

Every answer is buffered in memory; nothing is written to
`routing_profiles` / `model_registry` until the ENTIRE sequence completes.
If the input stream closes (Ctrl+D) at any point — including the very
first question — nothing is written:

```
[NOTE] routing configuration incomplete — no changes written
```

`init` still exits `0` in every one of the cases above; this step is
always optional. To run the Q&A later (or answer differently), use:

```bash
PROJECT_ROOT="$PROJECT_ROOT" node "$HANDOFF_ENGINE" init --routing
PROJECT_ROOT="$PROJECT_ROOT" node "$HANDOFF_ENGINE" init --routing-reconfigure
```

> Done: handoff:init — project initialized
