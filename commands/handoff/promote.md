# /handoff:promote — Explicitly promote an assertion to CLAUDE.md durable facts

> Running: handoff:promote

This slash command explicitly promotes a single assertion (by its integer ID) to the
`## Durable facts` section of `CLAUDE.md`. It is the manual alternative to the
auto-promotion path in `/handoff:close`, for users who prefer explicit control over
what enters the privileged CLAUDE.md channel.

The command is idempotent: re-running on an already-promoted assertion prints a notice
and exits 0 without rewriting CLAUDE.md.

## Signature

```
/handoff:promote <assertion_id>
```

Where `assertion_id` is the integer primary key from the `assertions` table. Use
`/handoff:status` or a direct DB query to find candidate assertion IDs.

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

PROJECT_ROOT="$PROJECT_ROOT" node "$HANDOFF_ENGINE" promote <assertion_id>
```

## Expected output

On success:
```
promoted: <!-- promoted: session=explicit, conf=9, date=2026-05-15, source_assertion=42 -->
          - [conf=9] vLLM embedding_model is Qwen3-Embedding-8B

Done: handoff:promote — assertion id=42 promoted to CLAUDE.md
```

On already-promoted:
```
already promoted on 2026-05-15: [conf=9] vLLM embedding_model is Qwen3-Embedding-8B
```

## What gets written to CLAUDE.md

Each promoted fact is written as two lines under `## Durable facts`:
1. An HTML comment audit annotation: `<!-- promoted: session=..., conf=..., date=..., source_assertion=... -->`
2. The fact line: `- [conf=N] subject predicate object`

> Done: handoff:promote — assertion promoted to CLAUDE.md
