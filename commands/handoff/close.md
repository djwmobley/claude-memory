# /handoff:close — End-of-session extraction

> Running: handoff:close

Wrap up the session. Reads back over what happened — decisions you made, things you tried, things that broke — and writes them to the database so next session can find them.

**Session intent persistence (north-star inversion).** At close time, the TL;DR, open threads, and quick references from the payload are persisted as queryable Postgres assertion rows using three 1:1 predicates: `session_tldr`, `open_thread`, and `quick_reference`. These rows are written through the same gated write path (`writeAssertionWithSupersession`) used by all other assertions — the L0/L2 consolidation gate applies; a cross-session restatement alone does not forge a `consolidated` tier. Any error during intent persistence is caught per-row and logged; the close operation still succeeds. The `handoff.md` file is rendered as a **thin pointer** (metadata header only; session content lives in Postgres), not a prose narrative of the session.

**Close-time reality reconciliation.** Before writing new assertions, close runs a pre-write verify pass that probes all live `mode:'verify'` assertions. Pre-existing rows with a definitive mismatch are **reconciled** automatically: 1:1 predicates (`branch_exists`, `commit_merged`, `pr_state`) get a reality-correct successor inserted via supersession; 1:N predicates (`in_file`) are suppressed with `suppression_kind='reality_reconciled'`. No `degraded_close` record is created for reconciled rows. The §7 no-backfill invariant holds: confidence, source, tier, and object of the stale row are never modified.

Close also surfaces any facts that look ready to promote to `CLAUDE.md`, and clears the in-progress session marker.

Run this before you close the window. If you skip it, today's work won't be saved to memory.

When `extraction_async_enabled` is set to `'true'` in project settings, the write is
deferred: the payload is enqueued and written by the deterministic background worker
(`node scripts/handoff.js queue-drain`). Default behavior is synchronous.

## Arguments

| Flag | Default | Description |
|---|---|---|
| `--json` | off | Read extraction payload from stdin (JSON). Accepts `--json` alone or the legacy `--json -` form. |
| `--dry-run` | off | Parse and validate the payload, run read-only validation/probe passes, print a summary of what WOULD be written, then exit without any DB mutations or handoff.md update. |

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

**Caveman/telegraphic authoring (mandatory).** Author `tldr` in telegraphic mode:
strip function words (articles, copulas, most prepositions/conjunctions — a/an/the,
is/are/was/were, of/to/in/for/and/or/but, with/that/this/it/as/at/on/by/be) while
keeping every load-bearing token verbatim: identifiers, file paths, line refs, PR
numbers, commit SHAs, names, numbers, decisions. Goal: minimum bootstrap tokens,
zero load-bearing loss. The engine stores prose verbatim (no engine-side compression
— leaner must come from the author, not the store). `test/north-star/test-caveman-economy.js`
enforces this invariant: caveman must be leaner than grammatical prose with no
fidelity regression.

Example — verbose (avoid): "In this session we completed the implementation of the
serve-time reality re-probe, which is a feature that annotates stale assertions."
Example — caveman (use): "Completed: serve-time reality re-probe — annotates stale
assertions at resume. Modified: scripts/lib/reality-checks.js + runVerifyDispatch."

### 6. Open threads

Bullet list of pending decisions, blocked tasks, or deferred questions.

**Caveman/telegraphic authoring (mandatory).** Author each open-thread string in
telegraphic mode: strip function words, keep every load-bearing token (identifiers,
paths, line refs, PR numbers, SHAs, names, numbers, decisions). Each thread is
stored verbatim as a queryable `open_thread` assertion row in Postgres — the engine
does not compress it. Shorter threads = fewer bootstrap tokens on the next resume.
`test/north-star/test-caveman-economy.js` enforces caveman compression with no
fidelity regression (leaner cannot be bought with lost load-bearing tokens).

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

# Preferred form — --json alone reads stdin:
echo '<JSON_PAYLOAD>' | PROJECT_ROOT="$PROJECT_ROOT" node "$HANDOFF_ENGINE" close --json

# Legacy form — --json - also works (backward compatible):
echo '<JSON_PAYLOAD>' | PROJECT_ROOT="$PROJECT_ROOT" node "$HANDOFF_ENGINE" close --json -

# Dry-run: validate + preview without writing anything:
echo '<JSON_PAYLOAD>' | PROJECT_ROOT="$PROJECT_ROOT" node "$HANDOFF_ENGINE" close --json --dry-run
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
  "quick_references": "telegraphic: named handles, file paths, line refs — function words stripped",
  "session_id": "optional — engine resolves in order: (1) this value, (2) CLAUDE_CODE_SESSION_ID env var, (3) session_in_progress DB marker; omit unless you know the actual session id",
  "confirm_claude_md_promotion": false
}
```

**Caveman authoring applies to `tldr`, `open_threads`, and `quick_references`.** All
three are persisted verbatim as queryable `session_tldr`, `open_thread`, and
`quick_reference` assertion rows in Postgres. Strip function words; keep every
load-bearing token (identifiers, paths, line refs, PR numbers, SHAs, names, numbers,
decisions). The engine stores what you write — leaner prose = fewer bootstrap tokens
on next resume. `test/north-star/test-caveman-economy.js` enforces this: caveman
tokens < verbose tokens, zero load-bearing loss.

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
cat "$PAYLOAD_FILE" | PROJECT_ROOT="$PROJECT_ROOT" node "$HANDOFF_ENGINE" close --json
```

Or pipe directly without a file:

```bash
echo '<JSON_PAYLOAD>' | PROJECT_ROOT="$PROJECT_ROOT" node "$HANDOFF_ENGINE" close --json
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

**Authoring volatile now-state facts as probe-able predicates (serve-time staleness fix):**
Some assertions record volatile now-state that will be re-verified at the next session's
resume. To get automatic [STALE:] annotation and `reality_check` refresh, author these
facts using a predicate that has a `mode:'verify'` entry in the L3 reality-check registry
(`scripts/lib/reality-checks.js`). Supported volatile predicates are:

| Predicate | Object format | What is probed |
|---|---|---|
| `in_file` | relative or absolute file path (e.g. `"scripts/handoff.js"`) | file exists on disk |
| `branch_exists` | subject = branch name; object = `"exists"` | git branch exists locally or on origin |
| `commit_merged` | `"<sha>"` or `"<sha> on <branch>"` (e.g. `"0ac852a on main"`) | commit is an ancestor of the ref |
| `pr_state` | `"open"` \| `"closed"` \| `"merged"` (subject must contain the PR number) | `gh pr view` live state |

**Authoring rule:** use these predicates for any assertion whose truth may change between
sessions. Do NOT use them for historical then-state (use `is_at_commit`, `shipped_at`, or
`is_status` for those). At the next resume, the serve-time reality re-probe will re-check
the live value and annotate any mismatched rows with `[STALE: now "<liveValue>"]` in the
served output.

**Examples:**
```json
{ "subject": "feat/serve-time-staleness-fix", "predicate": "branch_exists",
  "object": "exists", "confidence": 9, "source": "model_extracted" }

{ "subject": "PR #92", "predicate": "pr_state",
  "object": "open", "confidence": 9, "source": "model_extracted" }

{ "subject": "main-entry-point", "predicate": "in_file",
  "object": "scripts/handoff.js", "confidence": 9, "source": "model_extracted" }

{ "subject": "PR-92-squash", "predicate": "commit_merged",
  "object": "0ac852a on main", "confidence": 9, "source": "model_extracted" }
```

`pr_state` requires `gh` CLI authenticated and online at probe time; offline/CI
environments get `unverifiable` (fail-soft, never blocks serve).

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

**Normal close:**
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

**With `--dry-run`:**
```
Running: handoff:close

  -- DRY-RUN: nothing will be written --

  payload validation:
    OK — all predicates recognized

  rows that WOULD be written:
    entities:   2
    assertions: 5
    edges:      1
    contract:   yes

  session_tldr:       would write (subject=my-project)
  open_thread rows:   would write 2 row(s)

  CLAUDE.md promotion candidates (would be surfaced — NOT written in dry-run):
    [conf=9] vLLM embedding_model is Qwen3-Embedding-8B

  skipped in dry-run: writeExtraction, handoff.md render, session_in_progress clear, C2, C3, L4 degraded record

Done: handoff:close --dry-run — no mutations performed
```

The dry-run runs these passes (read-only): payload validation, L3 authoritative probes (compute only — no DB write), CLAUDE.md promotion candidate query, pointer-staleness gate (findings only — no row updates).

The dry-run skips: `writeExtraction` (all entity/assertion/edge inserts), `handoff.md` render, `session_in_progress` clear, C2 bias feedback, C3 contract evolution, L4 degraded-close record writes.

## Exit codes

| Code | Meaning |
|------|---------|
| 0 | Success (real close or dry-run) |
| 1 | DB connection error |
| 3 | Degraded close in `close_degraded_exit_mode=strict` (real close only) |

> Done: handoff:close — session closed and extracted
