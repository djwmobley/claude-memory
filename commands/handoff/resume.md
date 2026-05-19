# /handoff:resume — Explicit context load for continued session

> Running: handoff:resume

This slash command force-runs the SessionStart loader regardless of staleness.
Use it when you want to load prior session context at the start of a new session,
or when the automatic load was skipped due to a staleness threshold.

## Phase 3.5 note

In Phase 3.5, this command performs the loader's read-and-inject inline:
1. Parses `handoff.md` for the active contract name.
2. Executes the contract's query array against the DB.
3. Bumps `last_reinforced` on returned assertions.
4. Prints a compact context summary.

In Phase 3.6, a Stop-hook will handle automatic loading. This command will
remain as the manual override for staleness acknowledgment.

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

PROJECT_ROOT="$PROJECT_ROOT" node "$HANDOFF_ENGINE" resume
```

## Expected output

```
Running: handoff:resume

=== Handoff context ===
# Handoff — claude-memory

## TL;DR
<prior session summary>
...

=== Retrieved context (contract: default) ===
### Recent assertions
- [conf=9] vLLM embedding_model is Qwen3-Embedding-8B
- [conf=8] DB database is claude_memory_eval_test
...

  tokens used: ~320 / 4000

Done: handoff:resume — context loaded inline (Phase 3.6 will add hook-based auto-load)
```

> Done: handoff:resume — context loaded
