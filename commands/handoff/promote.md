# /handoff:promote — Explicitly promote an assertion to CLAUDE.md durable facts

> Running: handoff:promote

Bump a fact to `CLAUDE.md`. Promoted facts are always loaded at session start — not just "when relevant," but every single time. Use this for things Claude should never work without knowing: "we use Python 3.12," "the repo lives at github.com/x/y," "never use SQLite in production." This is the manual alternative to the auto-promotion that happens during `/handoff:close`.

The command is idempotent: re-running on an already-promoted assertion prints a notice
and exits 0 without rewriting CLAUDE.md.

## Arguments

| Flag / argument | Required | Description |
|---|---|---|
| `<assertion_id>` | (one form required) | Integer primary key from the `assertions` table. Promotes that specific row. |
| `--subject <s>` | (one form required) | Promote by content: match live assertions by subject. Use with `--predicate` and `--object` to narrow the match. |
| `--predicate <p>` | optional | Narrow content-match by predicate. Required when multiple live assertions share the same subject. |
| `--object <o>` | optional | Narrow content-match by object value. |
| `--demote <id>` | (one form required) | Reverse a prior promote: clear the `promoted` flag and remove the corresponding line from `CLAUDE.md`. |

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

# Promote by id (original form):
PROJECT_ROOT="$PROJECT_ROOT" node "$HANDOFF_ENGINE" promote 42

# Promote by content — exactly one match required:
PROJECT_ROOT="$PROJECT_ROOT" node "$HANDOFF_ENGINE" promote --subject "vLLM" --predicate "is_model" --object "Qwen3-Embedding-8B"

# Promote by subject only (must match exactly one live assertion):
PROJECT_ROOT="$PROJECT_ROOT" node "$HANDOFF_ENGINE" promote --subject "vLLM" --predicate "is_model"

# Demote (reverse a prior promote):
PROJECT_ROOT="$PROJECT_ROOT" node "$HANDOFF_ENGINE" promote --demote 42
```

## Expected output

**Promote by id (success):**
```
promoted: <!-- promoted: session=explicit, conf=9, date=2026-05-15, source_assertion=42 -->
          - [conf=9] vLLM embedding_model is Qwen3-Embedding-8B

Done: handoff:promote — assertion id=42 promoted to CLAUDE.md
```

**Promote by content — already promoted:**
```
already promoted on 2026-05-15: [conf=9] vLLM embedding_model is Qwen3-Embedding-8B
```

**Promote by content — zero matches (exits non-zero):**
```
promote: no live assertion matches subject="vLLM" predicate="is_model"
  Hint: check spelling with /handoff:status or query the assertions table directly.
```

**Promote by content — multiple matches (exits non-zero):**
```
promote: 3 live assertions match — disambiguate by id:
  id=41  vLLM is_model Qwen3-Embedding-4B  [conf=7|model_extracted]
  id=42  vLLM is_model Qwen3-Embedding-8B  [conf=9|user_stated]
  id=43  vLLM is_model Qwen3-Reranker-4B   [conf=8|user_stated]
  Re-run: promote <id>   or add --predicate/--object to narrow the match.
```

**Demote:**
```
  removed CLAUDE.md entry for assertion id=42
demoted: - [conf=9] vLLM embedding_model is Qwen3-Embedding-8B

Done: handoff:promote --demote — assertion id=42 demotion complete
```

## What gets written to CLAUDE.md

Each promoted fact is written as two lines under `## Durable facts`:
1. An HTML comment audit annotation: `<!-- promoted: session=..., conf=..., date=..., source_assertion=... -->`
2. The fact line: `- [conf=N] subject predicate object`

`--demote` removes both lines by matching the `source_assertion=<id>` annotation.

## Exit codes

| Code | Meaning |
|------|---------|
| 0 | Success (promote or demote), or idempotent (already promoted / not promoted) |
| 1 | DB connection error or CLAUDE.md not found |
| 2 | Bad usage (missing id, zero content matches, multiple content matches) |

> Done: handoff:promote — assertion promoted to CLAUDE.md
