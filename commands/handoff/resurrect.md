# /handoff:resurrect — Manually resurrect dormant notes by topic

> Running: handoff:resurrect

Use this when you are coming back to a project after a gap and want to pull
specific topic-relevant dormant notes back to the surface — for example,
"resurrect notes about the auth bug" or "bring back everything related to
the DB migration." The engine finds probationary (decay-suppressed) rows
whose subjects match the seed topic and, optionally, un-suppresses them so
they flow back into normal retrieval.

By default the command is a **dry-run**: it shows you what would be brought
back without mutating anything. Pass `--revive` to actually clear the
suppression and return the rows to live status.

<details>
<summary>How this works internally</summary>

1. Resolves candidate subjects via semantic embedding (vLLM/Qwen3-Embedding-8B
   cosine search on `assertions.embedding`) when the backend is reachable, then
   falls back to pg_trgm / LIKE fuzzy matching when embedding is unavailable.
2. Expands via depth-2 graph fan-out from the seed subjects.
3. Applies the M2 trusted-anchor gate: only subjects that have at least one
   `reality_check='verified'` or `pinned=true` live assertion are eligible
   (prevents forged probationary rows from self-resurrecting).
4. Fetches up to 5 rows per subject, 50 total, from
   `suppression_kind='downvoted_probation'` rows.
5. Dry-run: prints a `### Resurrected (preview)` section.
6. With `--revive`: calls `buildProbationRehabUpdate()` to clear `suppressed`
   and `suppression_kind` on the matched rows, then prints
   `### Resurrected (revived)`.

The default retrieval contract is **not** modified by this command (the I-2
invariant is preserved). Rows with `suppression_kind='downvoted_terminal'`,
`'superseded'`, or `'retired'` are never touched — terminal is terminal.
</details>

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

# Dry-run (default — no rows modified):
PROJECT_ROOT="$PROJECT_ROOT" node "$HANDOFF_ENGINE" resurrect "auth bug"

# Actually un-suppress the matched rows:
PROJECT_ROOT="$PROJECT_ROOT" node "$HANDOFF_ENGINE" resurrect "auth bug" --revive

# Cap candidate subject set to 30 (default 20):
PROJECT_ROOT="$PROJECT_ROOT" node "$HANDOFF_ENGINE" resurrect "auth bug" --revive --limit=30

# Emit JSON instead of prose (dry-run):
PROJECT_ROOT="$PROJECT_ROOT" node "$HANDOFF_ENGINE" resurrect "auth bug" --json

# Emit JSON and actually revive:
PROJECT_ROOT="$PROJECT_ROOT" node "$HANDOFF_ENGINE" resurrect "auth bug" --json --revive
```

## Expected output

**Dry-run (default):**
```
Running: handoff:resurrect

### Resurrected (preview — dry-run)
- [model_extracted|conf=7|downvoted_probation|2026-04-10T14:23:11.000Z] auth-service token_expiry is 24h
- [user_stated|conf=8|downvoted_probation|2026-04-09T09:11:05.000Z] auth-service session_store is Redis

  (Dry-run — no rows modified. Pass --revive to un-suppress.)

Done: handoff:resurrect — dry-run (no changes)
```

**With `--revive`:**
```
Running: handoff:resurrect

### Resurrected (revived)
- [model_extracted|conf=7|downvoted_probation|2026-04-10T14:23:11.000Z] auth-service token_expiry is 24h
- [user_stated|conf=8|downvoted_probation|2026-04-09T09:11:05.000Z] auth-service session_store is Redis

  Revived: 2 row(s) un-suppressed (suppressed cleared, suppression_kind cleared).

Done: handoff:resurrect — 2 row(s) revived
```

**No matches:**
```
Running: handoff:resurrect

No matching probationary rows found for seed: "auth bug"

Done: handoff:resurrect — no matches
```

**With `--json` (dry-run):**
```json
{
  "seed": "auth bug",
  "mode": "dry-run",
  "candidate_count": 1,
  "candidates": [
    {
      "meta": "model_extracted|conf=7|downvoted_probation|2026-04-10T14:23:11.000Z",
      "source": "model_extracted",
      "confidence": 7,
      "suppression_kind": "downvoted_probation",
      "created_at": "2026-04-10T14:23:11.000Z",
      "text": "auth-service token_expiry is 24h"
    }
  ],
  "revived_count": 0,
  "revived_ids": []
}
```

**With `--json --revive`:** same shape, `"mode": "revived"`, `revived_count` and `revived_ids` are populated.

## Flags

| Flag | Default | Description |
|------|---------|-------------|
| `--revive`, `-r` | off (dry-run) | Actually un-suppress matched rows |
| `--limit=N` | 20 | Cap candidate subject set size |
| `--json` | off | Emit structured JSON instead of prose (see JSON output below) |
| `--help`, `-h` | — | Show usage and exit 0 |

## Exit codes

| Code | Meaning |
|------|---------|
| 0 | Success (matches or no matches) |
| 1 | DB connection or query error |
| 2 | Bad usage (missing seed text) |

## See also

- `docs/how-memory-works.md` — resurrect concept and decay model overview
- `docs/glossary.md` — glossary entry for "resurrect" and "downvoted_probation"

> Done: handoff:resurrect — dormant notes surfaced by topic
