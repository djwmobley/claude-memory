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

**Serve-time reality re-probe:** after building the assertion sections, resume re-runs
the L3 `mode:'verify'` probes against live ground truth for every assertion served.
Mismatched rows are annotated in the output with `[STALE: now "<liveValue>"]`; matching
rows get `[verified✓]`. The `reality_check` column is refreshed in the database (fail-soft
UPDATE — only `reality_check` is written; confidence, source, tier, object are never
changed). Feature-gated via `serve_time_reality_check` project setting (default `enabled`).
</details>

## Preferred path — MCP

`handoff-mcp`'s initial tool surface (ADO Task #4566: `handoff_status`, `handoff_checkpoint`, `handoff_close`, `handoff_init`, `persist_decisions`) does not include a `handoff_resume` tool — resume stays CLI-only for now; use the recipe below. This is a real gap, not an oversight left undocumented: a `handoff_resume` MCP tool (returning the same structured context-load result as `resume`) is a reasonable follow-up if manual CLI resume proves to be a frequent friction point. Flagged for the ticket verifier / a future task rather than silently working around it here.


## Arguments

None — this command takes no flags or positional arguments.

## How to invoke

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

# ── Project-root resolution ──────────────────────────────────────────────────
# Walk up from cwd for a .memory-engine marker (or the legacy .claude-memory
# name, still recognized as a read-fallback) first, then fall back to .git.
PROJECT_ROOT=$(pwd)
while [ ! -f "$PROJECT_ROOT/.memory-engine" ] && [ ! -f "$PROJECT_ROOT/.claude-memory" ] && [ ! -d "$PROJECT_ROOT/.git" ] && [ "$PROJECT_ROOT" != "/" ]; do
  PROJECT_ROOT=$(dirname "$PROJECT_ROOT")
done
if [ "$PROJECT_ROOT" = "/" ] && [ ! -f "$PROJECT_ROOT/.memory-engine" ] && [ ! -f "$PROJECT_ROOT/.claude-memory" ] && [ ! -d "$PROJECT_ROOT/.git" ]; then
  PROJECT_ROOT=$(pwd)
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

  tokens used: ~650 / 4000 (sections: ~320)

Done: handoff:resume — context loaded inline (Phase 3.6 will add hook-based auto-load)
```

> Done: handoff:resume — context loaded
