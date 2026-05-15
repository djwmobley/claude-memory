# /handoff:checkpoint — Mid-session save without ending the session

> Running: handoff:checkpoint

This slash command extracts entities, assertions, edges, and an updated retrieval
contract from the current conversation state — the same extraction as `/handoff:close`
— but does NOT clear the `session_in_progress` marker. Use it for long sessions
where you want to persist progress without formally ending the session.

## Extraction instructions for Claude

Before calling the helper, extract the following from this conversation:

1. **Entities** — named things mentioned (systems, people, concepts, files, decisions).
   Each needs: `name`, `entity_type` (person/system/concept/decision/file), `description`.

2. **Assertions** — facts stated or inferred.
   Each needs: `subject`, `predicate`, `object`, `confidence` (1–10), `source`
   (user_stated | model_extracted | doc_quoted | retrieved_from_prior).
   Score user-stated durable facts 8–10; tentative model inferences 3–5.

3. **Edges** — typed relationships between entities.
   Each needs: `from_entity`, `edge_type` (depends_on/implements/blocks/owns/etc.), `to_entity`.

4. **Contract** — JSONB queries array for next-session retrieval.
   Supported types: `entity`, `assertion`, `vector`, `recency`.
   Example: `{"queries": [{"type": "recency", "token_budget": 500}]}`

5. **TL;DR** — 3–5 sentences summarizing where things stand.

6. **Open threads** — list of pending decisions or tasks.

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

echo '<JSON_PAYLOAD>' | node "$PROJECT_ROOT/scripts/handoff.js" checkpoint --json -
```

### JSON payload shape

```json
{
  "entities": [
    {"name": "entity-name", "entity_type": "system", "description": "..."}
  ],
  "assertions": [
    {"subject": "X", "predicate": "uses", "object": "Y", "confidence": 8, "source": "model_extracted"}
  ],
  "edges": [
    {"from_entity": "X", "edge_type": "depends_on", "to_entity": "Y"}
  ],
  "contract": {"queries": [{"type": "recency", "token_budget": 500}]},
  "tldr": "3–5 sentences.",
  "open_threads": ["item 1", "item 2"],
  "quick_references": "optional named handles",
  "session_id": "optional-session-id"
}
```

## Expected output

```
Running: handoff:checkpoint

  entities written:    3
  assertions written:  8
  edges written:       2

  Reranker gate: SKIPPED — corpus n=42 below threshold=1000

Done: handoff:checkpoint — 3e/8a/2ed written (session marker retained)
```

> Done: handoff:checkpoint — mid-session save complete
