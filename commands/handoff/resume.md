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
# Detect project root — prefer .claude-memory marker, fall back to .git
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

node "$PROJECT_ROOT/scripts/handoff.js" resume
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
