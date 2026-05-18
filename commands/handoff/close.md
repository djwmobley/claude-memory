# /handoff:close — End-of-session extraction

> Running: handoff:close

This slash command ends the session: extracts entities, assertions, edges, and an
updated retrieval contract from the conversation, writes them to Postgres, rewrites
`handoff.md`, surfaces CLAUDE.md promotion candidates, runs the reranker precision@5
gate, and clears the `session_in_progress` marker.

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
  Current recognized predicates: `chose`, `depends_on`, `is_status`, `prefers`.
  Unknown predicates are flagged (permissive mode: stderr warning, assertion kept)
  or rejected (strict mode: assertion skipped) by the deterministic write path.
  Do not invent new predicates; extend `predicate-registry.json` first.
- `object` — asserted value or referenced entity
- `confidence` — 1–10 integer:
  - 9–10: user-stated durable facts ("the DB is on localhost")
  - 7–8: strongly inferred from multiple user statements
  - 5–6: model-extracted with moderate support
  - 3–4: tentative; contradicting signals
  - 1–2: speculative
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
# Detect project root
PROJECT_ROOT=$(pwd)
while [ ! -d "$PROJECT_ROOT/.git" ] && [ "$PROJECT_ROOT" != "/" ]; do
  PROJECT_ROOT=$(dirname "$PROJECT_ROOT")
done

if [ ! -f "$PROJECT_ROOT/scripts/handoff.js" ]; then
  echo "Error: scripts/handoff.js not found — is this a claude-memory project?"
  exit 1
fi

echo '<JSON_PAYLOAD>' | node "$PROJECT_ROOT/scripts/handoff.js" close --json -
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
  "session_id": "optional-session-id",
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
cat "$PAYLOAD_FILE" | node "$PROJECT_ROOT/scripts/handoff.js" close --json -
```

Or pipe directly without a file:

```bash
echo '<JSON_PAYLOAD>' | node "$PROJECT_ROOT/scripts/handoff.js" close --json -
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
