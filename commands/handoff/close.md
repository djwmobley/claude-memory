# /handoff:close — End-of-session extraction

> Running: handoff:close

Wrap up the session. Reads back over what happened — decisions you made, things you tried, things that broke — and writes them to the database so next session can find them. Also rewrites the `handoff.md` summary file, surfaces any facts that look ready to promote to `CLAUDE.md`, and clears the in-progress session marker.

Run this before you close the window. If you skip it, today's work won't be saved to memory.

When `extraction_async_enabled` is set to `'true'` in project settings, the write is
deferred: the payload is enqueued and written by the deterministic background worker
(`node scripts/handoff.js queue-drain`). Default behavior is synchronous.

## Extraction instructions for Claude

Read the conversation that just happened. Then extract:

### 1. Entities

Named things mentioned: systems, people, concepts, decisions, files.

For each entity:
- `name` — canonical name (use consistent casing)
- `entity_type` — one of: `person`, `system`, `concept`, `decision`, `file`
- `description` — one sentence

### 2. Assertions

Facts established in this session.

For each assertion:
- `subject` — entity name or topic string
- `predicate` — **MUST be one of the declared registry predicates** (see
  `scripts/lib/predicate-registry.json` for the authoritative vocabulary).
  Predicates are the verbs in facts. Use `is_status` for state ("status is active"),
  `prefers` for user preferences, `chose` for explicit decisions, `depends_on` for
  dependencies. Full list: [docs/glossary.md#predicate](../../docs/glossary.md#predicate).
  Unknown predicates are flagged (permissive mode: stderr warning, assertion kept)
  or rejected (strict mode: assertion skipped) by the deterministic write path.
  Do not invent new predicates; extend `predicate-registry.json` first.
- `object` — asserted value or referenced entity
- `confidence` — 1–10 integer. How sure are you this is true?
  - 9–10: the user said so directly ("the DB is on localhost")
  - 7–8: strongly implied by multiple things the user said
  - 5–6: reasonable inference from what was said, but not stated outright
  - 3–4: tentative — contradicting signals, or based on a single ambiguous remark
  - 1–2: speculation; no real evidence either way
- `source` — `user_stated` | `model_extracted` | `doc_quoted` | `retrieved_from_prior`

### 3. Edges

Typed relationships between entities.

For each edge:
- `from_entity` — source entity name
- `edge_type` — `depends_on` | `implements` | `blocks` | `owns` | `calls` | `produces`
- `to_entity` — target entity name

### 4. Retrieval contract

A JSONB queries array for the NEXT session. What will the user likely need to know
immediately when they resume? Supported query types:

```json
{"type": "entity",    "filter": {"name": "..."}, "token_budget": 300}
{"type": "assertion", "filter": {"subject": "..."}, "token_budget": 500}
{"type": "recency",   "token_budget": 500}
{"type": "vector",    "query": "<topic phrase>", "token_budget": 1000}
```

### 5. TL;DR

3–5 sentences: what happened, where things stand, what's next.

### 6. Open threads

Bullet list of pending decisions, blocked tasks, or deferred questions.

### 7. CLAUDE.md promotion

The helper will automatically identify assertions with `confidence >= 9` AND
`source = 'user_stated'` that have been reinforced across multiple sessions.
If any are found, they will be listed. You will be asked for confirmation before
any write to `CLAUDE.md`. To confirm, include `"confirm_claude_md_promotion": true`
in the JSON payload.

## How to invoke

Build a JSON payload and pipe it to the helper:

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

echo '<JSON_PAYLOAD>' | PROJECT_ROOT="$PROJECT_ROOT" node "$HANDOFF_ENGINE" close --json -
```

### JSON payload shape

```json
{
  "entities": [
    {"name": "entity-name", "entity_type": "system", "description": "..."}
  ],
  "assertions": [
    {"subject": "X", "predicate": "depends_on", "object": "Y", "confidence": 8, "source": "model_extracted"}
  ],
  "edges": [
    {"from_entity": "X", "edge_type": "depends_on", "to_entity": "Y"}
  ],
  "contract": {
    "queries": [
      {"type": "recency",   "token_budget": 500},
      {"type": "assertion", "filter": {"subject": "X"}, "token_budget": 400},
      {"type": "vector",    "query": "main project topic", "token_budget": 1000}
    ]
  },
  "tldr": "3–5 sentences summarizing session state.",
  "open_threads": ["pending decision 1", "blocked task 2"],
  "quick_references": "optional named handles",
  "session_id": "optional — engine resolves in order: (1) this value, (2) CLAUDE_CODE_SESSION_ID env var, (3) session_in_progress DB marker; omit unless you know the actual session id",
  "confirm_claude_md_promotion": false
}
```

## Payload staging (mandatory)

Any JSON payload written to a file MUST be written to the OS temp staging directory,
NOT anywhere under the repo working tree.  Use:

```
os.tmpdir()/claude-memory-handoff/handoff-close-payload.json
```

Concretely, on Linux/macOS:

```bash
PAYLOAD_FILE="$(node -e 'const os=require("os"),path=require("path"); \
  const d=path.join(os.tmpdir(),"claude-memory-handoff"); \
  require("fs").mkdirSync(d,{recursive:true}); \
  process.stdout.write(path.join(d,"handoff-close-payload.json"))')"
echo '<JSON_PAYLOAD>' > "$PAYLOAD_FILE"
cat "$PAYLOAD_FILE" | PROJECT_ROOT="$PROJECT_ROOT" node "$HANDOFF_ENGINE" close --json -
```

Or pipe directly without a file:

```bash
echo '<JSON_PAYLOAD>' | PROJECT_ROOT="$PROJECT_ROOT" node "$HANDOFF_ENGINE" close --json -
```

**Why this matters:** `handoff.js` runs `git status --porcelain` to determine whether the
working tree is clean. A payload file written inside the repo working tree would appear as
an untracked file and make the probe report `dirty`, recording a false
`has_unpackaged_state: dirty` assertion.

**`has_unpackaged_state` is now code-owned:** `handoff.js` computes and writes the
`has_unpackaged_state` assertion authoritatively using `detectUnpackagedState()` at close
time. The model MUST NOT include a `has_unpackaged_state` entry in the `assertions` array
of the JSON payload. If one is included, it is silently discarded and replaced by the
authoritative code-computed value.

**Pointer-staleness gate:** at close time, `handoff.js` also scans TL;DR, open threads,
and quick references for `file:line` code pointers and validates each against the live
file tree. Stale line numbers are auto-corrected in the written `handoff.md`; pointers
whose anchor (enclosing function/class name or content snippet) can no longer be located
in the file are flagged in the `## Reconciliation notice` section alongside any
contradiction findings. This gate is a peer to the contradiction gate — both feed the
same unified Reconciliation block — and is fully non-fatal (any gate error leaves the
close output unchanged).

Extended behaviors (PR #86):
- **P-4 prose-vs-content check:** Legacy pointers (no stored anchor) are validated by
  comparing identifier tokens in the prose window around the pointer against tokens in
  a ±3-line window at the cited location. Zero overlap emits a P-4 finding and skips
  anchor derivation — preventing stale pointers from silently locking in wrong anchors.
- **Bulk supersession pass:** At close time, assertion rows with `anchor IS NULL` and
  pointer-shaped objects are scanned via the same prose-vs-content check. Rows that fail
  overlap are set to `suppressed = true` (§7 no-backfill: subject/predicate/object/source
  are never changed). Rows that pass have an anchor derived and persisted.
- **Bare-filename path fallback:** Pointers like `handoff.js:1106` (no path prefix) now
  try `scripts/`, `src/`, `lib/`, `test/` subdirectories before emitting a P-1 stale
  finding. The served pointer string is never altered.

## Expected output

```
Running: handoff:close

  CLAUDE.md promotion candidates (confidence >= 9, user_stated, multi-session):
    [conf=9] vLLM embedding_model is Qwen3-Embedding-8B

  Reranker gate: SKIPPED — corpus n=42 below threshold=1000

  entities written:    5
  assertions written:  12
  edges written:       3
  contract:            updated

Done: handoff:close — 5e/12a/3ed written, session marker cleared
```

> Done: handoff:close — session closed and extracted
