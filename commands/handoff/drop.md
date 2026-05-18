# /handoff:drop — Archive prior session memory and start fresh

> Running: handoff:drop

This slash command suppresses all current assertions for this project by setting
their effective confidence to near-zero (via decay_rate=999), then archives
`handoff.md` and creates a fresh one. Rows are kept — this is recoverable via SQL.

Use this when you want a clean slate but do not want to lose the rows entirely
(use `/handoff:purge` for a hard delete).

## What this does

1. `UPDATE assertions SET confidence = 1.0, decay_rate = 999.0 WHERE project_id = $1`
   (effective_confidence ≈ 0 — suppressed from retrieval, but rows survive)
2. Renames `handoff.md` to `handoff.{ISO-datestamp}.archived.md`.
3. Creates a new empty `handoff.md` from the template.

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

node "$PROJECT_ROOT/scripts/handoff.js" drop
```

## Expected output

```
Running: handoff:drop

  assertions zeroed: 47
  archived: ~/.claude/projects/<encoded_cwd>/handoff.2026-05-14T22-30-00-000Z.archived.md
  new handoff.md: ~/.claude/projects/<encoded_cwd>/handoff.md

Done: handoff:drop — 47 assertions suppressed, handoff.md archived
```

> Done: handoff:drop — session memory archived
