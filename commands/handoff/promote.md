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
| `--regenerate` | (one form required) | Rewrite `CLAUDE.md`/`AGENTS.md` from its template — the lightweight alternative to `init --force-promotion` (which bundles ~9 unrelated DB/FS writes). Exclusive of every other promote flag/positional; the only other tokens accepted alongside it are `--dry-run` and `--project-name`. |
| `--dry-run` | optional | With `--regenerate` only: report what would change (target state, project name + resolution branch, backup y/n, would-be byte count, facts that would carry) without writing anything. |
| `--project-name <name>` | optional | With `--regenerate` only: explicit project display name override — wins over every other source (an existing file's heading, worktree detection, directory name). See "Project display name resolution" below. |

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

# Promote by id (original form):
PROJECT_ROOT="$PROJECT_ROOT" node "$HANDOFF_ENGINE" promote 42

# Promote by content — exactly one match required:
PROJECT_ROOT="$PROJECT_ROOT" node "$HANDOFF_ENGINE" promote --subject "vLLM" --predicate "is_model" --object "Qwen3-Embedding-8B"

# Promote by subject only (must match exactly one live assertion):
PROJECT_ROOT="$PROJECT_ROOT" node "$HANDOFF_ENGINE" promote --subject "vLLM" --predicate "is_model"

# Demote (reverse a prior promote):
PROJECT_ROOT="$PROJECT_ROOT" node "$HANDOFF_ENGINE" promote --demote 42

# Regenerate CLAUDE.md/AGENTS.md from the template (backs up the existing
# file first; carries forward any "## Durable facts" lines it can parse out
# of it):
PROJECT_ROOT="$PROJECT_ROOT" node "$HANDOFF_ENGINE" promote --regenerate

# Preview a regenerate without writing anything:
PROJECT_ROOT="$PROJECT_ROOT" node "$HANDOFF_ENGINE" promote --regenerate --dry-run

# Regenerate with an explicit project display name (skips H1/worktree/basename inference):
PROJECT_ROOT="$PROJECT_ROOT" node "$HANDOFF_ENGINE" promote --regenerate --project-name "My Project"
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

**Regenerate (target was a regular file, 2 facts carried):**
```
  path:          /repo/CLAUDE.md
  bytes:         1284
  backup:        /repo/CLAUDE.md.bak-1799999999999-123456789-4242
  facts carried: 2

Done: handoff:promote --regenerate — CLAUDE.md regenerated
```

**Regenerate — target had no parseable "## Durable facts" section:**
```
  [WARN]  existing CLAUDE.md had no parseable "## Durable facts" section — prior content was NOT carried forward; it is preserved in the backup: /repo/CLAUDE.md.bak-1799999999999-123456789-4242
  path:          /repo/CLAUDE.md
  bytes:         1194
  backup:        /repo/CLAUDE.md.bak-1799999999999-123456789-4242
  facts carried: 0

Done: handoff:promote --regenerate — CLAUDE.md regenerated
```

**Regenerate --dry-run:**
```
promote --regenerate (dry-run): would target /repo/CLAUDE.md
  target-state:      file
  project name:      my-project (branch N1)
  would back up:     yes
  would-be bytes:    1284
  facts that would carry: 2

Done: handoff:promote --regenerate (dry-run) — no changes written
```

## What gets written to CLAUDE.md

Each promoted fact is written as two lines under `## Durable facts`:
1. An HTML comment audit annotation: `<!-- promoted: session=..., conf=..., date=..., source_assertion=... -->`
2. The fact line: `- [conf=N] subject predicate object`

`--demote` removes both lines by matching the `source_assertion=<id>` annotation.

## `--regenerate` details

- **Preconditions** (checked before anything is touched): the project marker must be resolvable and the DB must be reachable. Either failing exits 1 with nothing written.
- **Target-state handling:** absent → write fresh, no backup. Regular file → back up, then write fresh. Directory, symlink, or anything else → exit 1, nothing written.
- **Carry-forward:** if the existing file has a parseable `## Durable facts` section, its fact lines (and their `<!-- promoted: ... -->` annotations) are re-inserted into the fresh render in place of the placeholder line. If the section isn't parseable, the file still regenerates (old content is fully recoverable from the backup) but a `[WARN]` line is printed.
- **Backup naming:** `<name>.bak-<Date.now()>-<process.hrtime.bigint()>-<pid>` — no `:` characters, so it's safe on Windows.
- **Line endings:** the regenerated file matches whichever EOL style (LF vs CRLF) dominated the file it replaced; a brand-new file uses whatever the template ships with.
- **`--dry-run`** performs reads only — no backup, no write, no DB mutation.
- `--regenerate` is mutually exclusive with every other promote form — no id, `--demote`, `--subject`/`--predicate`/`--object`, or unrecognized flag may appear alongside it (exit 2); `--dry-run` and `--project-name <name>` are the only exceptions.

### Project display name resolution

The rendered file's title (`# <name>`) is resolved by a single shared function (`resolveProjectDisplayName`), used by both `init` and `promote --regenerate`, via a total classification — first hit wins:

| Branch | Source |
|--------|--------|
| N0 | `--project-name <name>` (or, for `init`, its positional project-name argument), trimmed non-empty |
| N1 | The first `# ...` heading of an already-existing promotion file, after stripping inline markdown/HTML markup — rejected if empty, path-like, a placeholder (`project`, `CLAUDE.md`, `AGENTS.md`, `Handoff`), or itself worktree-shaped |
| N2 | If the project root is a git worktree checkout: the main checkout's directory name (resolved via `git rev-parse --git-common-dir`, never the worktree's own disposable directory name) |
| N3 | `path.basename(root)`, or the literal `project` when that's empty or a bare Windows drive letter |

This exists because a `promote --regenerate` run from a worktree checkout (e.g. `.claude/worktrees/agent-a0979417bd522838e`) used to write the worktree's own disposable directory name as the file's title — `--project-name` or a properly-titled existing file both take precedence over that.

## Exit codes

| Code | Meaning |
|------|---------|
| 0 | Success (promote, demote, or regenerate — including `--dry-run`), or idempotent (already promoted / not promoted) |
| 1 | DB connection error, CLAUDE.md not found, project marker not resolvable (`--regenerate`), or regenerate target is a directory/symlink/other non-file type |
| 2 | Bad usage (missing id, zero content matches, multiple content matches, `--regenerate` combined with any other argument, or an unrecognized flag) |

> Done: handoff:promote — assertion promoted to CLAUDE.md
