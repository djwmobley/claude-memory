# /handoff:resume — Explicit context load for continued session

> Running: handoff:resume

Force-load context from the last session. Normally the session hook loads prior notes automatically — but if your last session was more than seven days ago, the auto-load is skipped to avoid flooding you with stale context. Run this command to override that and load anyway.

<details>
<summary>How this works internally</summary>

This command performs the loader's read-and-inject inline:
1. Reads the contract name from `handoff.md` (a thin pointer — metadata header only).
2. Executes the contract's query array against the DB.
3. Bumps `last_reinforced` on returned assertions.
4. Surfaces a `### Session intent` section by querying `assertions` rows with `predicate IN ('open_thread', 'session_tldr', 'quick_reference')`, ordered by decay-adjusted confidence. This section appears when the contract does not already include an `assertion` or `recency` query. Suppressed and invalidated rows are excluded.
5. Prints a compact context summary.

The session hook (Phase 3.6) will eventually handle automatic loading. This command stays as the manual override for staleness acknowledgment.

**Pointer-staleness gate:** at resume time, `handoff.js` scans the served `handoff.md`
body for `file:line` code pointers and rewrites stale line numbers in the output you
see — but does NOT persist corrections back to the database. Persistence happens only at
close time (close is the canonical mutation point). This means a resumed session always
sees the freshest pointer positions without risk of corrupting the DB mid-session.
</details>

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
(thin pointer — session content is in Postgres)

=== Retrieved context (contract: default) ===
### Session intent
- [user_stated|conf=8] claude-memory session_tldr <prior TL;DR>
- [user_stated|conf=8] <thread-key> open_thread <pending action>
...

### Recent assertions
- [conf=9] vLLM embedding_model is Qwen3-Embedding-8B
- [conf=8] DB database is claude_memory_eval_test
...

  tokens used: ~320 / 4000

Done: handoff:resume — context loaded inline (Phase 3.6 will add hook-based auto-load)
```

> Done: handoff:resume — context loaded
