# /handoff:checkpoint — Mid-session save without ending the session

> Running: handoff:checkpoint

Mid-session save. Does the same extraction as `/handoff:close` — entities, assertions, edges, updated retrieval contract — but doesn't end the session. Useful when you've hit a natural decision point in a long session and want to make sure that progress is captured before continuing. The session stays open; run `/handoff:close` when you're actually done.

For a lightweight single-line capture without composing a full JSON payload, use `--note`:

```bash
PROJECT_ROOT="$PROJECT_ROOT" node "$HANDOFF_ENGINE" checkpoint --note "discovered session_id threading gap in L2 path"
```

This writes one `session_note` assertion (subject = project basename, confidence = 8, source = `user_stated`) and exits immediately. Multiple notes accumulate (1:N cardinality) — they are not superseded by subsequent notes.

## Arguments

| Flag / argument | Default | Description |
|---|---|---|
| `--json` | off | Read full extraction payload from stdin (JSON). Mutually exclusive with `--note`. |
| `--note "<text>"` | — | Write a single `session_note` assertion without requiring a JSON payload. Text is stored verbatim. |

## Extraction instructions for Claude

Before calling the helper, extract the following from this conversation:

1. **Entities** — named things mentioned (systems, people, concepts, files, decisions).
   Each needs: `name`, `entity_type` (person/system/concept/decision/file), `description`.

2. **Assertions** — facts stated or inferred.
   Each needs: `subject`, `predicate`, `object`, `confidence` (1–10), `source`
   (user_stated | model_extracted | doc_quoted | retrieved_from_prior).
   How sure are you? Score 9–10 for things the user said directly, 7–8 for
   strongly implied facts, 5–6 for reasonable inferences, 3–5 for tentative ones.

3. **Edges** — typed relationships between entities.
   Each needs: `from_entity`, `edge_type` (depends_on/implements/blocks/owns/etc.), `to_entity`.

4. **Contract** — JSONB queries array for next-session retrieval.
   Supported types: `entity`, `assertion`, `vector`, `recency`.
   Example: `{"queries": [{"type": "recency", "token_budget": 500}]}`

5. **TL;DR** — 3–5 sentences summarizing where things stand.

6. **Open threads** — list of pending decisions or tasks.

## Preferred path — MCP

If the `mcp__handoff__handoff_checkpoint` tool is available in this session, call it directly instead of the CLI recipe below — no tempfile, no shell engine-resolution dance, no manual JSON escaping. Tools are not hot-loadable mid-session; if it doesn't show up yet, it will after the server is registered and a new session starts (see the CLI fallback below in the meantime).

```
ToolSearch({ query: "select:mcp__handoff__handoff_checkpoint" })
```

Extract entities/assertions/edges/contract/tldr/open_threads per the instructions above, then:

```
mcp__handoff__handoff_checkpoint({
  projectRoot: "<absolute path to project root>",
  payload: {
    tldr: "3–5 sentences.",
    entities: [{ "name": "entity-name", "entity_type": "system", "description": "..." }],
    assertions: [{ "subject": "X", "predicate": "uses", "object": "Y", "confidence": 8, "source": "model_extracted" }],
    edges: [{ "from_entity": "X", "edge_type": "depends_on", "to_entity": "Y" }],
    contract: { "queries": [{ "type": "recency", "token_budget": 500 }] },
    open_threads: ["item 1", "item 2"]
  }
})
```

The tool validates `payload` is a plain object client-side; the engine enforces the full payload schema (string length caps, predicate vocabulary, enums) server-side — a schema violation comes back as a tool error with the engine's stderr tail, not a silent partial write. Returns `entitiesWritten`/`assertionsWritten`/`edgesWritten` and the engine's summary line.

**Checkpoint payloads MAY be partial.** Unlike `/handoff:close`, checkpoint has no single-pass
completeness requirement — it's fine to write a checkpoint with just a `tldr` and no
entities/assertions/edges yet, then checkpoint again later in the same session with more.
Close is the one that must carry the full extraction in one call; see
`commands/handoff/close.md`'s "MCP path (handoff_close tool)" section if you're closing,
not checkpointing.

The lightweight `--note` form has no dedicated MCP tool yet — use the CLI form below for that, or call `handoff_checkpoint` with a payload containing a single low-confidence `assertions` row.

If `mcp__handoff__handoff_checkpoint` is not available, fall back to the CLI recipe below.


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

# Lightweight single-line capture (new):
PROJECT_ROOT="$PROJECT_ROOT" node "$HANDOFF_ENGINE" checkpoint --note "re-grounding: L2 corroboration gate requires non-null session_id"

# Full extraction payload — preferred form (--json alone reads stdin):
echo '<JSON_PAYLOAD>' | PROJECT_ROOT="$PROJECT_ROOT" node "$HANDOFF_ENGINE" checkpoint --json

# Legacy form — --json - also works (backward compatible):
echo '<JSON_PAYLOAD>' | PROJECT_ROOT="$PROJECT_ROOT" node "$HANDOFF_ENGINE" checkpoint --json -
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

**With `--note`:**
```
Running: handoff:checkpoint

  note captured: re-grounding: L2 corroboration gate requires non-null session_id

Done: handoff:checkpoint --note — project=my-project marker=C--Users-username-dev-my-project — session_note written (session marker preserved)
```

**With `--json` (full payload):**
```
Running: handoff:checkpoint

  entities written:    3
  assertions written:  8
  edges written:       2

  Reranker gate: SKIPPED — corpus n=42 below threshold=1000

Done: handoff:checkpoint — project=my-project marker=C--Users-username-dev-my-project — 3e/8a/2ed written (session marker preserved for continued attribution)
```

The Done line names the project (`project=<name>`) and its marker uuid (`marker=<uuid>`) —
same rationale as `/handoff:close` (cm#232): a checkpoint summary read out of context
can't be misread as belonging to another project.

## Exit codes

| Code | Meaning |
|------|---------|
| 0 | Success |
| 1 | DB connection or write error |
| 2 | Bad usage (e.g. `--note` with no text) |

> Done: handoff:checkpoint — mid-session save complete
