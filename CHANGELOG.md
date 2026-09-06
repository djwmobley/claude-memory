# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Removed

- **Agent-interaction guard hooks moved to the public judge repo** —
  `hooks/agent-adversary-floor.js`/`.test.js` and
  `hooks/pr-independence.js`/`.test.js` are removed from claude-memory now
  that they ship from [djwmobley/judge](https://github.com/djwmobley/judge)
  (PR #1, `b8657b8`), installed there by that repo's install-guards script.
  claude-memory's `hooks/` now carries only the memory-contract `SessionStart`
  loader-hook wiring. `hooks/README.md`, `MANIFEST.md`, `CONTRIBUTING.md`, and
  `.github/workflows/test.yml` updated to drop references to the removed
  files; `scripts/test-host-agnostic-naming.js`'s S1 sweep exemption list
  entry for `agent-adversary-floor.js` removed as dead (the file no longer
  exists to sweep).

### Fixed

- **cm#233: `open_thread` subject derivation replaced (`intentKey`) + resolved_threads/open_threads matcher classification, migrated together** —
  `deriveIntentSubject` (colon-split-before-char-60-else-truncate-to-80, no
  Unicode normalization, no whitespace collapse) is REMOVED, not aliased,
  replaced everywhere by `intentKey` (`scripts/lib/intent-key.js`: NFC
  normalize, collapse every whitespace run to one space, cap at 1000 UTF-8
  bytes at a whitespace boundary). Every caller (`scripts/handoff.js`,
  `scripts/lib/carryover-render.js`, `scripts/migrations/migrate-08-handoff-markdown.js`,
  `scripts/migrations/verify-19-seams-smoke.js`) moved in this same change.
  `resolved_threads`/`open_threads` processing is now a total classification,
  never silent: MATCHED-AND-RESOLVED, UNMATCHED-REPORTED, INVALID-REJECTED
  (resolved_threads), and DUPLICATE-COLLAPSED (open_threads) — the SAME
  classification/print functions (`classifyResolvedThreads`,
  `dedupOpenThreadIntents`) drive both a real close and `--dry-run`, so the
  two paths can never disagree. `scripts/migrations/migrate-17-intent-key.js`
  (numbered 17, not 13 — `migrate-13-agent-exchange.js` already exists)
  re-keys every live `open_thread` row exactly once, with pre-existing-
  collision detection (latest `last_reinforced` wins, ties broken by
  highest id); `SCHEMA_EPOCH` bumped 3→4 so `ensureSchemaCurrent` runs it
  automatically on the next touch of every live project DB (cutover
  atomicity — no DB is left in a mixed old/new-subject state).
  **Fix-round (independent review REQUEST CHANGES, addressed same PR):**
  (1) the auto-run gate was printing migrate-17's full per-row plan to
  STDOUT on every touch, breaking `scripts/smoketest-handoff.js`'s C2/C5
  exact-output checks — the gate now always runs `silent`, and even
  non-silent CLI mode collapses a zero-change plan to one summary line.
  (2) `intentKey` had dropped the `KEY: description` colon-split
  convention entirely, breaking `test/north-star/test-provenance.js`'s
  P2/P3 pin (a session restating `KEY: <new text>` must supersede
  `KEY: <old text>` by key) — restored as a total rule: a colon at
  index <60 followed by a SPACE keys on the prefix (a URL's
  `https://...` scheme colon never matches, since nothing follows it
  with a space). (3) long strings sharing a >=996-byte common prefix
  collided onto the same truncated key — truncation now appends
  ` …#<8-hex sha256 of the full text>` so differing tails always produce
  different keys.

- **cm#222: migrate-08 handoff-markdown parser hardening** — a real-file
  dry run (H-13's own stated acceptance gate) against a live project's
  `HANDOFF.md`/`HANDOFF-HISTORY.md` surfaced 4 defects in the H-1..H-14
  parser: (1) `--dry-run` did not exist at all — every acceptance check
  required a live write; now a true dry-run parses + reports with zero
  DDL/INSERT/UPDATE/DELETE, and (with `--db`) runs only the two read-only
  schema-precondition SELECTs, reporting PASS/FAIL/not_checked rather than
  ever assuming a target is ready. (2) The session-heading separator was a
  single-dash character class, but the majority of real headings use a
  literal two-hyphen `--` token — widened to a token alternation
  (`--`/em-dash/en-dash/hyphen), each instance required to be flanked by
  actual whitespace so a `YYYY-MM-DD` date's own embedded hyphens are never
  mistaken for the separator. A second, structurally distinct real shape
  (`## SESSION <date> [(parenthetical)] -- <title>`, date-first) is now its
  own `session_dated` bucket alongside `session_numbered`; a heading that
  merely contains the word "session" but matches neither shape is its own
  `session_shaped_unparsed` bucket, always listed with a line number —
  never silently merged into the generic "other" bucket. (3) Carry-over
  tables were parsed with a hardcoded 2-cell assumption that failed on
  100% of real (3-column Item/Status/Notes) rows; parsing is now
  header-driven — cell count and column roles (item/status/notes, plus a
  synonym map) are derived from the header row itself, column order is
  irrelevant, an unrecognized column folds into notes as `name=value`, a
  missing status column yields `unknown` for every row, and a header with
  no identifiable item column flags the whole table rather than guessing
  by position. Status-cell text now gets its own total classification
  (closed/open/unknown, a cell matching both lists is `unknown`, never a
  tiebreak guess) surfaced in the report only (never written to the DB —
  `carryover_status` stays fixed `'open'`, unchanged, out of scope). A
  table split by a stray blank line now reports the orphaned trailing rows
  instead of silently dropping them. (4) A missing `## NEXT SESSION`
  heading previously collapsed to an ambiguous zero-item count; the report
  now carries an explicit per-file state (`absent` / `present_empty` /
  `present_with_items` / `present_variant`, the last for a heading
  containing both "next" and "session" without matching the canonical
  form). New/changed: `scripts/lib/handoff-markdown-parse.js`,
  `scripts/migrations/migrate-08-handoff-markdown.js`. Follow-up in the
  same PR: the `### Open carry-overs` sub-heading match was itself an
  exact anchor, not a total classification — a real heading variant
  (a trailing parenthetical, e.g. "(snapshot at S68 close ...)") matched
  nothing and its table was entirely un-extracted; now canonical (bare, or
  with a trailing parenthetical / `--`/em-dash-suffixed clause) is parsed,
  and anything else containing both "carry" and "over" is a
  `carryover_heading_variant`, reported with a line number, never guessed.
  A mid-document stray BOM (not the file's leading byte) is now flagged as
  `bom-midfile` with its line number instead of silently relying on
  `String.prototype.trim()` to absorb it during heading detection.

### Added

- **§18.3 `feature_usage` table + `migrate-12-feature-usage.js` backfill**
  (owner decision item F, 2026-09-06) — a per-feature/per-PR token+cost
  provenance table (`scripts/migrations/sql/migrate-12-feature-usage.sql`,
  applied by `migrate-schema-addenda.js`), distinct from `turn_usage`'s
  per-turn grain: one row per feature/PR-shaped unit of work, keyed by
  `(project_id, source_db, source_feature_token_usage_id)`, carrying a
  `model_breakdown` JSONB and a `session_ids` `TEXT[]`. The one-time data
  migration (`migrate-12-feature-usage.js`) backfills from
  `pipeline_pipeline.feature_token_usage`: defaults to a dry-run (nothing
  written unless `--write`), an optional `--project-map` file for
  longest-prefix branch-to-project routing (see
  `feature-usage-project-map.example.json`), a bidirectional column-shape
  precondition against the live source table, per-row verdicts
  (`insert`/`update-identical`/`refuse-conflict`/`unmapped-branch-<raw>`)
  never a whole-run failure on one row's conflict, `--allow-update-on-
  conflict`, and `--rollback <report.json>` scoped strictly to the pairs a
  prior run actually wrote (never by `project_id`). `usage_query`
  (`scripts/lib/usage-telemetry.js`, and the MCP tool of the same name)
  gains a `granularity` parameter (`turn` default / `feature`) reading this
  new table with its own `groupBy` total classification
  (`branch`/`pr`/`model`/`day`); `sessionId` given together with
  `granularity: "feature"` hard-errors before any query runs.
  `migrate-schema-addenda.js`'s `deriveSchemaAddenda` also gained two small
  fixes surfaced while authoring this: `INT` added to `TYPE_NORMALIZE`, and
  a `[]` array-type suffix (e.g. `TEXT[]`) is now recognized and checked
  against the live `information_schema.columns.data_type` sentinel
  `'ARRAY'` rather than the element type's own scalar name.

- **cm#185 schema bring-forward** — generalizes the handoff engine's schema
  auto-apply from a hardcoded two-file set to a total classification of every
  `scripts/sql/*.sql` file, driven by a tracked manifest
  (`scripts/sql/schema-manifest.json`) cross-checked against each file's own
  in-file header directive (`scripts/lib/schema-classify.js`). Fixes the
  observed defect that `app-retrieval-events-schema.sql` (`retrieval_events` +
  `retrieval_event_assertions`) was never applied by `/handoff:init` — it is
  now applied automatically, ordered after `handoff-core-schema.sql`.
  Excludes `phase3b-schema.sql` and `v_memory_hits.sql` (they target the
  separate canonical/pipeline database and depend on tables no per-project
  schema defines) with recorded reasons; deletes the stale, unparsable
  `phase3.5-defaults.sql` (superseded by the in-code defaults map). The
  fingerprint is now epoch-prefixed and EOL/BOM-normalized (fixes a real
  cross-platform drift bug: the stored fingerprint differed between a Windows
  CRLF checkout and Linux CI). Schema apply is now per-file-transaction,
  fail-fast, and runs under a session-scoped Postgres advisory lock; a
  post-apply catalog probe gates the fingerprint upsert so "the apply did not
  throw" is never treated as proof "the object is present" (closes a silent
  half-apply class of bug around the pgvector-gated DO blocks and the
  duplicate-column swallow). A failed integrity-index re-create (legacy-
  duplicate corpus) is now an atomic DROP+CREATE pair, so a previously-working
  index can never be left destroyed by a failed re-create. Persistent
  degradation is surfaced by `/handoff:status` and the resume banner.
- **§3.5 store-wide caveman-economy gate (T7 prerequisite, K-1..K-11 amendment,
  memory-manager#12)** — `test/north-star/test-caveman-economy-store-wide.js`
  generalizes the single-session `test-caveman-economy.js` gate to the ENTIRE
  target database: `scripts/lib/caveman-lint.js` (new shared lib) holds the
  single `estimateTokens`/`assertSurfaced` definitions (moved by reference out
  of `test/north-star/lib/ns-harness.js`, which now imports them), a generic
  K-3 load-bearing-token extractor (SHA/hex, file paths, `file:line`, PR/issue
  refs, ISO dates, URLs, quoted strings, numbers, and K-6 negation markers
  carved OUT of the strippable set into MUST-PRESERVE), a no-baseline K-7
  truncation heuristic (`detectTruncation` — tightened after running against
  real migrated `decisions` rows in `memory_manager_staging` surfaced false
  positives on ordinary apostrophes/possessives and benign slash-separated
  word pairs; now requires corroborating path context and excludes
  terminal-punctuation-complete sentences), and an ARM3-style function-word
  density ceiling for the K-5 no-synthetic-baseline economy check.
  `scripts/migrations/caveman-columns.json` is the K-9 total-classification
  manifest — every TEXT/VARCHAR column across all 29 §5 graph/corpus/seam/
  registry tables (checked-caveman / checked-verbose-exempt /
  mandatory-caveman-no-column / exempt-not-model-authored-with-reason), PLUS
  an `out_of_scope_tables` bucket total-classifying every other table/view in
  the live schema (§15/§17/§18 infrastructure, views) — together they cover
  the database's entire public schema, so the runtime K-8 completeness
  backstop (`checkCompleteness`) diffs the WHOLE live schema against the
  manifest, never a pre-filtered allow-list. `assertions.authoring_mode`
  ships as its own schema addendum (`migrate-16-caveman-addenda.js`/`.sql`),
  nullable with no DEFAULT (grandfather pattern, same as `tier`/
  `reality_check` — never silently backfills pre-existing rows to
  'caveman'). `test/migrations/test-caveman-gate-store-wide.js` covers the
  gate itself on a disposable scratch DB: passing caveman rows, grandfathered
  verbose/NULL rows (economy-exempt, fidelity still enforced), a truncated
  row (must fail), manifest drift in both directions (must fail loud), and a
  direct K-6 negation-regression proof via `assertFullFidelity`.
  `scripts/migrations/verify-15-t7-caveman-economy.js`'s previously-unmet
  prerequisite is now satisfied end to end.

- **§6.1(h) handoff-markdown migration** — `scripts/migrations/migrate-08-handoff-markdown.js` parses a project's `HANDOFF.md` (active fat card) and `.claude/HANDOFF-HISTORY.md` (archive) into `assertions` rows, PEER to the SQL-source migrations. New `scripts/lib/handoff-markdown-parse.js` (fenced-code/blockquote/HTML-comment-aware heading classifier + markdown-table cell parser, the exact inverse of `carryover-render.js`'s escaping) and `scripts/lib/fs-path-normalize.js` (shared `filesystem:<path>` manifest-key normalizer, reusable by future filesystem-sourced migrations). Archived session summaries land under the new `session_tldr_archived` predicate (1:N; registry-added) — deliberately never the live 1:1 `session_tldr` predicate, so migration-origin rows can never corrupt the "most recent session" picker. Carry-over rows always land `carryover_status='open'`; durable sections (`run_commands`/`critical_operational_notes`/`key_paths`) land pinned; NEXT SESSION items get a freshly-assigned `seq`. Re-run semantics: whole-project delete-and-reinsert of this migration's own `source_model='markdown-migration-h'` rows in one transaction. New `scripts/migrations/handoff-section-headings.json` config (extensible per-project durable-heading list).
- **§8 generalized MCP tool surface** — `scripts/handoff-mcp.mjs` grows from
  5 tools to 30: `memory_search` (hybrid vector+FTS across a closed
  15-table enum — `assertions`/`agent_exchange` plus 4 of the 13 seam
  tables carrying `fts_vec`, the other 9 seam tables scored on cosine
  alone; `memory_entry_chunks` deliberately excluded, its `embedding`
  column is `vector(1024)`, a different pgvector type/dimension than every
  other table's `halfvec(4000)`), `memory_upsert`/`memory_get` (typed
  per-table writes/lookups — `decisions` gains the ONE named ON-CONFLICT
  carve-out in the schema, `(project_id, topic)`, backed by
  `decisions_audit`; every seam-table write is embedded inline at write
  time, fail-soft to NULL + a warning when the provider is down),
  `memory_lint`, `memory_view_set`/`memory_view_run` (saved, versioned
  query sets on `retrieval_contract.kind='view'`, interpreting only the
  structured entity/assertion/recency/vector query-type JSON, never raw
  SQL), 4-tool CRUD each for entities/assertions/edges (entity creation
  runs exact + trigram-fuzzy near-match surfacing and revives a suppressed
  exact match instead of inserting a duplicate; assertion updates supersede
  — suppress-old + insert-new in one transaction with an optimistic guard,
  requiring an explicit target row id for any non-1:1 predicate),
  `exchange_append`/`exchange_read` (a millisecond-truncated, compound
  `(created_at, id)` watermark — closes a same-row re-delivery bug found
  during authoring: a caller's own JSON-round-tripped watermark otherwise
  undercuts a full-microsecond-precision comparison), `route_resolve`
  (replaying with a different `override_model` returns the recorded
  decision plus `override_ignored: true`, never silently and never an
  error) plus `routing_profile_set`/`get` (a new versioned row per set,
  concurrency-safe via a transaction-scoped advisory lock — not the literal
  `SELECT MAX(version) ... FOR UPDATE` sketch, which Postgres rejects
  outright on any query containing an aggregate), and `usage_record`/
  `usage_query`. `persist_decisions` is repointed from the old
  `claude_policy_framework` child-process flow onto the same project-scoped
  `decisions` table `memory_upsert` writes — a declared, backward-
  incompatible response-shape change, and a new required `projectRoot`
  parameter.

  Schema addenda: `scripts/migrations/sql/migrate-15-mcp-addenda.sql`
  (applied by `scripts/migrations/migrate-15-mcp-addenda.js`) adds
  `retrieval_contract.kind`, `entities.suppressed`/`edges.suppressed`, a
  `pg_trgm` index on `entities.name`, and
  `decisions_project_topic_unique`. `entities` joins the audit-trigger
  wired set (`migrate-13-agent-exchange.sql`/`.js`), growing it 16 -> 17.
  `scripts/lib/project-identity.js`'s `PROJECT_ID_TABLES` grows to include
  the 13 seam tables plus `agent_exchange`/`routing_profiles`/
  `turn_usage`/`session_usage`. `scripts/lib/normalize-text.js` NFC-
  normalizes before case-folding, closing an NFC/NFD visually-identical-
  pair escape. New smoke test `scripts/migrations/verify-20-mcp-surface.js`
  (27 checks + a real stdio MCP round-trip proving all 30 tools register
  and one is independently callable end-to-end) and its regression harness
  `test/migrations/test-verify-20.js`.

- **§6.1(b) decisions data migration** — new
  `scripts/migrations/migrate-02-decisions.js` migrates
  `claude_policy_framework.decisions` into the structured (not prose-blob)
  `decisions` seam table on a memory-manager consolidation target, keyed by
  a topic-prefix routing classifier
  (`scripts/migrations/topic-prefix-to-project.json`): an ordered
  LITERAL/WILDCARD rule list, first-match-wins, with a
  `unmatched-<first-dash-token>` fallback bucket for anything the routing
  table doesn't recognize (never guessed, never silently dropped). Loud
  preconditions before any write (every topic already
  `= lower(trim(topic))`; zero duplicate topics); bundles
  `CREATE UNIQUE INDEX IF NOT EXISTS decisions_project_topic_unique ON
  decisions(project_id, topic)`; writes one `migration_manifest` row (+ row
  hashes) per derived-project slice, in the same transaction as that
  slice's `decisions` upsert batch; supports `--rollback` (re-classifies
  the live source to recover exactly which rows it owns, deletes them plus
  their manifest rows in one transaction). Pre-migration rows are tagged
  `source_model='unknown-pre-migration'` / `authoring_mode='verbose'`
  (grandfather, insert-time only) with `source_project_hint` recording the
  matched prefix as an audit trail; `embedding`/`agent_id` are left `NULL`
  (backfill is a later phase). Takes a read-only source backup (timestamped
  JSON dump, gitignored) before touching anything. Two rounds of
  independent-review fixes landed on top before merge: round 1 closed a
  re-classification-drift bug (a topic's derived `project_id` changing
  between runs left a duplicate row + an orphaned `migration_manifest`
  slice behind, undetected); round 2 scoped the round-1 fix's
  reconciliation `DELETE` by `source_model` after an unscoped version was
  shown to be able to silently delete unrelated, non-migration `decisions`
  rows sharing a topic string.

- **§5.3 absorbed-seam tables + §5.9 fat-card view + §7 write/render/lint
  libraries** — new schema-setup-only migration
  `scripts/migrations/sql/migrate-14-seam-tables.sql` (applied by
  `scripts/migrations/migrate-14-seam-tables.js`) adds the 13 §5.3 seam
  tables (`decisions`, `gotchas`, `findings`, `research`, `incidents`,
  `code_index`, `tasks`, `checklist_items`, `corpus_files`,
  `workflow_discovery`, `agent_rewrites`, `policy_sections`,
  `session_chunks`) and `v_handoff_card_inputs` (the §5.9 fat-card render
  view). `code_index` gains a plain, non-primary-key `id SERIAL` column not
  present in the source schema so the shared `log_guarded_change()` audit
  trigger can wire onto it; `audit_log.row_id` is widened `BIGINT -> TEXT`
  (in both `migrate-13-agent-exchange.sql` and, redundantly,
  `migrate-14-seam-tables.sql`) so `findings`' caller-supplied TEXT id
  (e.g. `RT-INJ-001`) survives an `UPDATE`/`DELETE` through that same
  trigger. Re-applying `migrate-13-agent-exchange.js` after this migration
  auto-wires all 13 tables' audit triggers, landing at exactly 16 total
  (13 seam + `assertions` + `edges` + `agent_exchange`).

  On top of the schema, seven new library modules under `scripts/lib/`
  implement the write/render/lint seams: `carryover-render.js` (open-thread
  carry-over delta merge, reusing `handoff.js`'s `deriveIntentSubject` +
  pinned-row exclusion by reference), `memory-upsert.js` (a typed,
  INSERT-ONLY write path for the 9 seam tables with a live MCP surface —
  closed table enum, app-level per-column validation, PK/unique collision
  as a loud error, never a silent overwrite), `normalize-text.js` (the one
  shared case/whitespace/punctuation normalization helper used by the
  ingest-time contradiction check, the new `dangling_entity_reference`
  reality-check probe, and `memory_lint`'s checks), `render-handoff-card.js`
  (assembles the NEXT SESSION / Session N / Done / Ceiling / Open
  carry-overs card shape), `exchange-log.js` (the `agent_exchange`
  body/summary write split with an injectable embedder seam — unreachable
  default provider is a loud error, never a silent fallback — and one
  guarded, atomic optimistic-row-count state transition per write), and
  `memory-lint.js` (four read-only store-wide checks: `orphan_entities`,
  `contradicting_assertions` scoped to 1:1-registered predicates,
  `stale_unreconciled` excluding annotate-only reality-check predicates,
  and `unlinked_mentions`). `scripts/lib/reality-checks.js` gains a new
  standalone `probeDanglingEntityReferences` export. `next_step`
  (cardinality 1:N) is added to `predicate-registry.json`.

- **Agent-to-agent exchange schema + tamper-evidence infrastructure +
  interop contracts** — new schema-setup-only migration
  `scripts/migrations/sql/migrate-13-agent-exchange.sql` (applied by
  `scripts/migrations/migrate-13-agent-exchange.js`) adds `agent_exchange`,
  a project-scoped, append-only log for agent-to-agent communication:
  proposals, responses, threaded replies (`parent_id` self-FK), and
  broadcasts (`to_agent IS NULL`), attributed via the same
  `source_model`/`agent_id` columns every other table uses. There is no
  `status`/`read_at` column by design — acknowledgment is a NEW row
  (`kind='observation'`, `parent_id` set), never an UPDATE of the original;
  the documented polling contract is a compound `(created_at, id)` cursor,
  not `created_at` alone (every row inside one transaction shares one
  `transaction_timestamp()` value, so `id`'s strict SERIAL advance is what
  makes the cursor exercisable and immune to same-timestamp ties). The
  `embedding halfvec(4000)` column and its HNSW index are added via the
  same graceful-degradation `DO $$ ... EXCEPTION $$` pattern as
  `assertions.embedding`, so a pgvector-absent target still gets every
  other column — the whole file runs as one implicit transaction, so a
  hard failure on the vector column would otherwise abort unrelated
  statements too. `docket_id` conditionally FKs to a not-yet-shipped
  `tasks` table: absent → deferred; present with no orphans → added
  `NOT VALID` then `VALIDATE CONSTRAINT`s clean → validated; present with
  pre-existing orphan `docket_id` rows → added but left `NOT VALID`,
  orphans reported by id (capped at 20), never silently dropped; present
  with the constraint absent after apply → the one FAIL branch. A total,
  four-state classification, never a silent pass-through.

  The same migration adds generic, reusable tamper-evidence infrastructure:
  `audit_log` (`row_id BIGINT` — deliberately wider than the source
  design's INTEGER) plus a `log_guarded_change()` AFTER UPDATE OR DELETE
  trigger, wired via conditional per-table `DO` blocks onto every table
  that both exists and has an `id` column — unconditionally onto
  `assertions`/`edges`, and automatically (zero further schema changes)
  onto 13 not-yet-shipped seam tables the moment each one exists.
  `audit_log` itself is never self-wired. This is detection, not
  prevention: a shared, credential-diverse localhost Postgres instance has
  no per-agent role layer to `REVOKE` against, so a raw `UPDATE`/`DELETE`
  on a guarded table still succeeds — but it is now captured
  (`table_name`, `operation`, `row_id`, `db_user`, `old_row`, `new_row`,
  the `embedding` key stripped from both snapshots to keep audit rows
  bounded-size on the engine's most common write path). Sanctioned engine
  writes (e.g. `assertions` supersession) generate audit rows exactly like
  an unsanctioned mutation would, by design; `ON CONFLICT ... DO UPDATE`
  fires the same trigger as an explicit `UPDATE`.

  Two abstract contracts ship with zero concrete implementations by
  design: `scripts/lib/agent-provider.js`'s `AgentProvider` (`label()`,
  `async runHeadless(prompt, {cwd, env})`) and
  `scripts/lib/embedding-provider.js`'s `EmbeddingProvider` (`async
  embed(text)` → `{vector, dims, model}`, `storedDims()`), both throwing
  "not implemented" on the base class — operators supply concrete
  subclasses for their own headless-CLI and embedding backends.
  `AgentProvider.label()` is one identity string stamped into three
  consuming surfaces (attribution columns, `model_registry.label`,
  `turn_usage.model_id`); `EmbeddingProvider` concrete providers are
  registered by name as `embedding_providers` rows (data, not code) — this
  PR does not rewire the engine's existing embedding call path onto it.

  New operator-run CLI `scripts/migrations/verify-13-exchange-smoke.js` (7
  checks: post + broadcast + compound-cursor watermark poll, threaded
  reply reconstruction, a worked cross-agent example — adapted to write an
  attributed `assertions` row in place of the not-yet-shipped `findings`
  seam table — tamper-evidence UPDATE, tamper-evidence DELETE, a trigger-
  coverage report across the full checklist, and the append-only-
  convention sanity check) built on the shared
  `scripts/migrations/lib/smoke-harness.js`; nothing is wiped (no
  global-pool table is involved), only prefix-residue-scanned. New test
  suite `test/migrations/test-verify-13.js` (20 cases: subprocess coverage
  of both the migration runner and the smoke script, direct-client
  verification proof-of-firing for the trigger/function/HNSW-index/FK
  states, the conditional FK's three non-deferred-by-tasks-absence states,
  audit-trigger firing on an ordinary `assertions` UPDATE, a negative test
  that `audit_log` is never self-wired, and static SQL-text invariants
  including a privacy-scrub floor); wired into CI. New doc
  `docs/agent-interop.md`. Out of scope for this change: MCP
  `exchange_append`/`exchange_read` tools, concrete `AgentProvider`/
  `EmbeddingProvider` implementations, the not-yet-shipped seam tables
  themselves, and any `handoff.js` change.
  (`scripts/migrations/sql/migrate-13-agent-exchange.sql`,
  `scripts/migrations/migrate-13-agent-exchange.js`,
  `scripts/migrations/verify-13-exchange-smoke.js`,
  `scripts/lib/agent-provider.js`, `scripts/lib/embedding-provider.js`,
  `test/migrations/test-verify-13.js`, `docs/agent-interop.md`,
  `.github/workflows/test.yml`)

- **Usage-telemetry record/query library + operator smoke test** —
  `scripts/lib/usage-telemetry.js` exports `usageRecord`, `sessionUsageRollup`,
  and `usageQuery`: the measurement-side companion to
  `scripts/lib/route-resolve.js` (which decides a turn's model and records
  that decision). `usageRecord` measures what actually happened for a turn
  (tokens, cost, outcome) against the SAME `(project_id, session_id,
  turn_idx, agent_role)` key, whether or not `routeResolve` ever ran for it —
  a single race-safe `INSERT ... ON CONFLICT DO UPDATE` statement, matched
  on that key: UPDATEs an existing row or INSERTs a fresh one with
  `resolved_via` NULL. Every parameter except `costUsd` follows a universal
  preservation rule (omitted on the update path preserves the existing
  column value; only a provided value is written); `costUsd` is a
  three-state machine instead — omitted computes server-side cost from
  `model_registry` rates for the effective model and token counts, explicit
  `null` forces the column NULL, and a finite non-negative number is used
  verbatim. Server-side cost fails soft to NULL — never a guessed price,
  never 0 — when there is no effective model, the model is unregistered,
  either registered rate is NULL, or either effective token count is
  unavailable; cache tokens are never priced. A cost value that IS a real,
  finite number (caller-supplied or server-computed) but exceeds
  `cost_usd`/`total_cost_usd`'s NUMERIC(12,6) range (max magnitude
  999999.999999) is a distinct, DIFFERENT case from the fail-soft-NULL
  branches above — a computable anomaly, not an unknowable price — and now
  throws a named `CostOutOfRangeError` before any write, rather than
  either silently degrading to NULL or letting a raw unhandled Postgres
  "numeric field overflow" escape (the originally-reported defect: tokens
  near `Number.MAX_SAFE_INTEGER` against a priced model passed the
  `Number.isFinite` guard and then crashed raw at write time). The same
  bound is enforced on `sessionUsageRollup`'s aggregate write by catching
  Postgres's own 22003 and rethrowing it as the same named error class, so
  no raw driver error ever escapes this module either way. `resolved_via`,
  `recommended_model`, and `cost_delta_usd` are never touched by
  `usageRecord` — those remain exclusively `route-resolve.js`'s fields. A
  reserved `"(none)"` sentinel can never be written as a real `modelId`
  through this API, and both `sessionUsageRollup` and the session-scoped
  `usageQuery` path hard-error, naming the anomalous rows, if they encounter
  that value stored via some other path — never silently merging it with
  genuinely NULL-model rows. `sessionUsageRollup` recomputes and UPSERTs a
  session's `session_usage` row as one SQL statement (a single internally-
  consistent snapshot), aggregating `turn_usage` into a `model_breakdown`
  JSONB map (NULL-model rows keyed `"(none)"`) using SQL SUM's own
  NULL-preserving semantics — an all-NULL-cost group aggregates to NULL,
  never a fabricated 0; a session with zero `turn_usage` rows still gets a
  visible rollup row (`turn_count: 0`, every total NULL, `model_breakdown:
  {}`), never a silent no-op. `usageQuery` supports `groupBy` in
  `('model','role','provider','day')` (day computed once, in SQL, in UTC);
  session-scoped aggregates `turn_usage` directly, while project-scoped
  (no `sessionId`) reads `session_usage` rollups only — stale-by-design,
  never falling back to scanning `turn_usage` — and supports `groupBy:
  'model'` only, hard-erroring on any other dimension with an explanation
  that per-role/provider/day detail requires a `sessionId`. All returned
  numerics are JS numbers or null, never `pg` driver strings. New
  operator-run CLI `scripts/migrations/verify-18-usage-smoke.js` (9 checks:
  record-after-resolve — composing with `route-resolve.js`'s `routeResolve`
  on the same key — record-without-resolve, server-side cost both ways,
  update-not-duplicate, session-scoped query across model/role/day,
  rollup + project-scoped query including the staleness contract,
  input validation + total classification, a dedicated all-NULL-cost-
  group check, and the cost-range guard) — reuses
  `migrate-01-canonical-db.js`'s target resolution and refusal by import,
  and runs its entire fixture lifecycle inside one transaction that is
  always rolled back (safe against a live staging database);
  `turn_usage`/`session_usage` are never wiped, only prefix-residue-scanned.
  The transaction+rollback/run-prefix/residue-scan harness this shares
  with `verify-17-routing-smoke.js` is now extracted into
  `scripts/migrations/lib/smoke-harness.js` — `verify-17-routing-smoke.js`
  was refactored onto it with byte-identical output for a passing run, and
  its existing test suite (`test/migrations/test-verify-17.js`) passes
  unmodified. The harness's `runCheck` now isolates every check inside its
  own SAVEPOINT (unconditionally rolled back afterward), and exposes a
  `withSavepoint` primitive checks can use directly around a specific
  sub-operation expected to trigger a genuine Postgres-level error — a
  check that provokes a real database error (e.g. the cost-range guard's
  rollup-overflow case) no longer poisons the shared transaction for later
  checks, or for that same check's own post-failure assertions. New test
  suite `test/migrations/test-verify-18.js` (subprocess coverage of the
  smoke script plus direct unit tests: the field-preservation matrix, the
  `costUsd` state machine, every cost fail-soft branch, the outcome
  DDL-default discipline across insert/update, a genuine concurrent-insert
  race, the token ceiling, the reserved-sentinel defense on both write and
  read paths, rollup NULL-SUM semantics, the zero-turn rollup, `"(none)"`
  grouping keys, project-scope staleness, `groupBy` total classification,
  the cost-range guard across the caller-supplied, server-computed, and
  rollup-aggregate paths,
  and a genuine concurrent rollup); wired into CI. No MCP tool wiring
  (`usage_record`/`usage_query` tools), no `handoff.js` checkpoint/close
  wiring of the rollup, and no `feature_token_usage` backfill — out of
  scope for this change.
  (`scripts/lib/usage-telemetry.js`, `scripts/migrations/verify-18-usage-smoke.js`,
  `scripts/migrations/lib/smoke-harness.js`, `scripts/migrations/verify-17-routing-smoke.js`,
  `test/migrations/test-verify-18.js`, `.github/workflows/test.yml`)

- **Least-cost routing resolver + operator smoke test** —
  `scripts/lib/route-resolve.js` exports `routeResolve`,
  `recommendLeastCost`, and `resolveRequiredTier`: given a turn's identity
  (project, session, turn index, agent role), resolves which model/provider
  the turn should use and records the decision exactly once in
  `turn_usage` (idempotent replay on a repeat call for the same key; a
  losing concurrent insert re-selects and returns the winner's row rather
  than diverging from it). Resolution precedence, first hit wins: an
  idempotent replay, then a directive chain (per-turn override argument,
  `routing_session_overrides`, an active project-scoped `routing_profiles`
  pin, then an active `project_id='*'` global-default pin — matched only at
  this step, never as a wildcard elsewhere), then a least-cost
  recommendation. Required-tier resolution is a separate total
  classification (explicit argument, then project-scoped, then `'*'`-scoped
  `routing_profiles.capability_tier`); an unconfigured role is a hard error
  naming the role and pointing at the (not-yet-built) routing init Q&A —
  the role→tier suggestion table is deliberately never applied as a silent
  fallback anywhere in this file. Least-cost selection is tier-fit before
  cost (never reaches for a higher tier because it is cheaper), then
  ascending rate-sum, then label as the deterministic tiebreak; a directive
  bypasses the tier check outright (operator intent wins) but a registered
  pin below the required tier is flagged in the returned `rationale`. All
  NUMERIC cost columns (returned by `pg` as strings) are coerced through a
  NULL-preserving numeric coercion before any comparison, sum, or
  subtraction, and a non-finite `cost_delta_usd` is written as NULL, never
  as NaN. New operator-run CLI `scripts/migrations/verify-17-routing-smoke.js`
  (the runbook §17.4 5-point smoke test: idempotency, directive +
  recommendation recording, least-cost tier-fit-before-cost selection,
  no-silent-downgrade with two distinct empty-pool/cost-unconfigured
  errors, and cross-project pin isolation including the `'*'` global-pin
  contract) — reuses `migrate-01-canonical-db.js`'s target resolution and
  refusal by import, runs its entire fixture lifecycle inside one
  transaction that is always rolled back (safe against a live staging
  database; zero residue by construction, including under a crash), and
  refuses loudly, naming `migrate-schema-addenda.js`, when the
  routing/telemetry prerequisite tables are absent. New test suite
  `test/migrations/test-verify-17.js` (subprocess coverage of the smoke
  script plus direct unit tests of the resolver: precedence order,
  required-tier resolution order, NULL-cost exclusion, deterministic
  tiebreak, the insert-race loser path, input validation, and a
  string-vs-numeric cost-comparison boundary fixture); wired into CI. No
  MCP tool wiring, no `usage_record`/`usage_query`, and no
  `model_registry` auto-registration — out of scope for this change.
  (`scripts/lib/route-resolve.js`, `scripts/migrations/verify-17-routing-smoke.js`,
  `test/migrations/test-verify-17.js`, `.github/workflows/test.yml`)

- **Schema-setup-only addenda migration** — a second migrations runner,
  `scripts/migrations/migrate-schema-addenda.js`, applies six net-new,
  idempotent SQL pieces on top of a `migrate-01-canonical-db.js` target:
  `source_model`/`agent_id` attribution columns on `entities`/`assertions`/
  `edges`; an assertions `carryover_status` column (open/resolved
  carry-over tracking); a `model_registry` base table (lazily populated,
  no seed rows — model-agnostic, no named-model CHECK anywhere); an
  `embedding_providers` base table with one specified seed row
  (`vllm-local`); a routing-harness table group (`routing_profiles`,
  `routing_session_overrides`, plus routing columns added to
  `model_registry`); and a usage-telemetry table group (`turn_usage`,
  `session_usage`). No data migration of any kind — schema/DDL only. The
  runner reuses `migrate-01-canonical-db.js`'s target resolution,
  total-classification refusal, and SQL-apply helpers by import (never a
  fork), refuses a target that does not yet exist or is missing the
  engine-core tables this addendum alters, and derives its entire expected
  object set — tables, columns and their declared types, CHECK constraints,
  indexes (including partial-index `WHERE` clauses), UNIQUE constraints, and
  the embedding-providers seed row's values — from the six SQL files' own
  text at verify time, never from a hand-maintained list. New SQL files
  under `scripts/migrations/sql/`; new test suite
  `test/migrations/test-migrate-schema-addenda.js` (30 cases covering
  prerequisite refusal on both an empty-but-existing and a never-created
  target, fresh apply, idempotent re-run, refused target names, six
  proof-of-firing perturbations against the derived verification, static
  SQL-text invariant sweeps, derivation-helper unit cases, and a forced
  mid-sequence apply failure with idempotent heal); wired into CI alongside
  the existing migrations test steps. Also fixes
  `scripts/migrations/inventory-manifest.json`'s section attribution for
  `model_registry`/`embedding_providers` (their `CREATE TABLE` DDL
  originates one section earlier than previously recorded; the consuming
  completeness check keys only on table name, not on the section field, so
  this is a documentation-accuracy fix with no behavioral effect).
  (`scripts/migrations/sql/*.sql`, `scripts/migrations/migrate-schema-addenda.js`,
  `test/migrations/test-migrate-schema-addenda.js`, `.github/workflows/test.yml`,
  `scripts/migrations/inventory-manifest.json`)

- **Serve-time `open_thread` staleness gate** — `open_thread` rows are now
  reality-checked at serve time (resume / resurrect) against local git merge
  state. Any PR numbers cited in the thread text (e.g. `#106`) are checked
  against `git log --format=%s -n 2000`; if a cited PR was squash-merged
  (appears as `(#NNN)` in a commit subject), the served line is annotated
  `[STALE: now "merged: #NNN — verify thread is still open"]`. This is an
  informational nudge — a merged base PR does not imply the follow-up work is
  complete. The `open_thread` entry uses `annotateOnly: true` in the L3
  registry, which excludes it from both close-time passes (pre-write reconcile
  and post-write L3 verify), so `open_thread` rows are **never** suppressed,
  superseded, reconciled, or degraded-alarmed by this gate. Serve-time
  annotation only. New exported helpers: `getMergedPrSet(root)` (memoized git
  log parse), `probeOpenThread(root, object, subject)` (fail-soft probe).
  `annotateOnly` boolean added to the L3 registry entry-shape contract.
  (`scripts/lib/reality-checks.js`, `scripts/handoff.js`,
  `test/handoff/test-open-thread-verify.js`)

### Fixed

- **`scripts/handoff-mcp-selftest.mjs`: instance data out of public defaults**
  — `SERVER_PATH` was a hardcoded owner-machine absolute path; now resolved
  relative to the script's own location via `import.meta.url`. `PROJECT_ROOT`
  hardcoded a real private-repo path and name; now required from
  `HANDOFF_SELFTEST_PROJECT_ROOT`, with a loud FATAL + usage instructions and
  a non-zero exit when unset (no silent fallback). The `persist_decisions`
  fixture topic/decision text also carried a real project name and an
  internal ticket number; genericized to synthetic kebab-case values that
  still satisfy `TOPIC_RE`. Behavior otherwise unchanged.

- **`open_thread` serve-time staleness gate: qualified cross-repo refs no
  longer false-positive against local PR numbers (#150)** — `probeOpenThread`
  in `scripts/lib/reality-checks.js` extracted every `#N` token from an
  `open_thread` assertion's subject+object haystack and intersected it with
  the local merged-PR set, so a QUALIFIED cross-repo reference like
  `memory-manager#12` or `owner/repo#12` had its `#12` matched against LOCAL
  PR numbers, producing a false `[STALE: now "merged: #12 …"]` annotation.
  Fix: for every `#N` token, classify by the single character immediately
  preceding `#` (direct adjacency) — a total classification, no third
  "ambiguous" branch. `P` in `[A-Za-z0-9_.-]` (ASCII-only — GitHub owner/repo
  names are ASCII-only; deliberately not `\w`/`\p{L}`) → SUPPRESSED, never
  checked against the merged set. This one branch covers true qualified refs
  AND prose-glued local forms (`PR#152`, `commit#12`) alike — the classifier
  does not try to tell them apart; ambiguity always resolves to no-annotation
  (friction over a false positive). Otherwise (start of haystack, or `P` is
  whitespace/punctuation/a Unicode character) → LOCAL-CANDIDATE, checked
  exactly as before. **Accepted tradeoff**: glued local refs like `PR#152`
  lose their staleness signal — unavoidable, since they are textually
  identical to the cross-repo form that caused the bug; this repo's
  squash-merge convention always parenthesizes merged-PR anchors (`(#N)`),
  so close.md-authored anchors never take the lossy glued form in practice.
  `getMergedPrSet` is unchanged — its `\(#(\d+)\)` pattern requires `(`
  directly adjacent to `#`, which is structurally immune to qualified
  prefixes inside parens. The classification pattern is hoisted to the new
  exported `OPEN_THREAD_TOKEN_RE` constant (single source of truth, also used
  directly by a test-only start-of-string boundary check). Also added a
  docstring warning on `probeOpenThread`: a served `[STALE: ...]` annotation
  must never be copy-pasted verbatim into a new assertion object
  (self-amplification risk is behavioral, not code-reachable). 7 new tests
  in `test/handoff/test-open-thread-verify.js` (OT7-OT13) cover the
  regression, the named `PR#N` tradeoff, non-weakening of the existing
  `(#N)`/whitespace-preceded signal, start-of-string, chained `#12#13`, the
  `getMergedPrSet` parens-adjacency immunity against a qualified ref in the
  same commit subject, and Unicode-preceded tokens.
  (`scripts/lib/reality-checks.js`, `test/handoff/test-open-thread-verify.js`)

### Changed

- **Refactor: de-duplicate `scripts/test-both-backends.js` helpers** — hoisted
  6 inline-duplicated constructs to module scope: (1) `HANDOFF_SRC` — replaces
  16 per-test `fs.readFileSync(HANDOFF_JS)` calls; (2) `dialectHelpers(db)` —
  replaces 26 per-section `isPostgres`/`suppTrue`/`suppFalse`/`nowExpr` blocks;
  (3) `isSuppressed(row)` / `isActive(row)` — replaces 27 inline
  `.suppressed === 0/false/1/true` expressions; (4) `PAYLOAD_STAGING_RE` — removes
  4 identical inline regex declarations inside S12.b; (5) `totalCount(db, id)` —
  removes 3 identical inline `async function` bodies inside S13/S14/S15; (6)
  `freshPid(prefix)` — replaces 12 inline template-literal uniqueness expressions
  in S18/S19. `seedCorpus` copies (S13/S14/S15) and `withThrowawayPgDb` blocks
  (S14.3/S15a-pg) left inline — they differ in table coverage, predicates, or
  variable names. No assertions, expected values, test names, dialect behavior,
  or control flow changed. Net: -29 lines.

- **Refactor: hoist duplicated test helpers + remove dead code** — in
  `scripts/smoketest-handoff.js`: hoisted 4 identical `normalize` lambdas to
  module-level `normalizeTokenLine(s)` and extracted 2 identical trusted-canon
  ordering checks (W3/W4) into `assertCanonOrdering(out, label, fail)`; copies
  1 and 2 (LC and HD sections) differ in guard logic or failure message and
  remain inline. In `scripts/test-graph-traversal.js`: hoisted a module-level
  `extractGraphSection(stdout, sectionName)` replacing 6 inline ternary
  extractions in A-1 through A-8 plus D-2 (the A-12 local function is replaced
  by the module-level version; C-1 omits the includes-guard and is left inline);
  hoisted `normalizeTokenLine(s)` replacing 2 identical local `normalize`
  lambdas in B-5 and B-6. In `scripts/test-plugin-packaging.js`: removed dead
  `pass()`, `fail()`, `passCount`, and `failCount` that were never called (file
  uses `node:test` + `node:assert/strict` directly). No test assertions,
  expected values, test names, or control flow changed.

- **Refactor: extract `scripts/lib/test-pg-helpers.js`** — de-duplicates the PG
  test-harness helpers (`pgConnect`, `createDb`/`createTestDb`,
  `dropDb`/`dropTestDb`, `setSetting`, `getSettingsLike`, `setContract`,
  `makeEnv`, `runHandoff`, `runClose`, `applySchema`, `resolveProjectId`,
  `resolveHandoffMdPath`, `cleanupHandoffMd`, `setupProject`) that were
  copy-pasted across six test scripts; each file now imports the shared module
  and deletes its local definitions. No test assertions or behaviors changed.

### Added

- **Documentation lint CI gate** (`scripts/test-doc-lint.js`): pure-Node static
  linter wired into CI that enforces three invariants: (1) every bold term in a
  glossary "See also:" line resolves to a defined `### heading`; (2) every
  `/handoff:<name>` slash-command reference in docs matches a real
  `commands/handoff/<name>.md` file, and every `node … handoff.js <sub>`
  invocation in code spans matches the engine subcommands router; (3) the
  `validKinds` array in `cmdPrune` and the `--suppression-kind` enumeration
  bullet in the glossary both equal the canonical set from the SQL schema CHECK
  constraint. Would have caught the Prune fictional-command drift (#107/#108)
  and the validKinds/glossary desync before they reached main.
- **`/handoff:resurrect` command**: on-demand retrieval of decayed topics back
  into active context using semantic vector search against the full assertion
  corpus. The resurrect ring makes dormant knowledge addressable without
  requiring it to be included in every resume payload. (#66, #78, #83)
- **Serve-time reality re-probe**: volatile predicates (`branch_exists`,
  `commit_merged`, `pr_state`, `in_file`) are re-verified at resume time.
  Assertions whose real-world anchors no longer hold are surfaced with a
  `[STALE:]` annotation rather than silently served as current fact. (#93)
- **L3 reality-check registry**: a generalized registry of reality-binding
  probes that any predicate can register with, enabling systematic
  verification at both close and resume without hardcoding probe logic per
  predicate. (#61)
- **Session-intent persistence**: `/handoff:close` persists the session's
  intent as queryable Postgres rows (north-star inversion), so the next
  resume can surface what you were trying to accomplish rather than
  reconstructing it from prose. (#92)
- **Predicate vocabulary registry and audit tooling**: `predicate-registry.json`
  declares the authoritative predicate vocabulary; `scripts/audit-predicates.js`
  reports corpus drift; a CI vocabulary guard fails the build on unregistered
  predicates; the `has_updated` predicate is registered as a 1:N class. (#99)
- **`/handoff:close --dry-run`**: rehearses the close path (extraction,
  reconciliation, staleness probes) and reports what would be written without
  committing any changes to the database. (#103)
- **`/handoff:checkpoint --note`**: saves a named session note as a queryable
  `session_note` predicate row alongside the normal checkpoint state. (#103)
- **`/handoff:promote` content-addressed targeting**: `--subject`, `--predicate`,
  and `--object` flags let you promote or demote a specific assertion found by
  content match instead of requiring an assertion ID. `--demote` retracts a
  previously promoted durable fact. (#103)
- **Ergonomic read/inspect flags** across multiple commands: `status --json`,
  `status --breakdown`, `status --stale-pointers`, `resurrect --json`,
  `purge --dry-run`, `close --json` (metadata-only output), `checkpoint --json`
  (metadata-only output). (#102)
- **Adversarial staleness-permutation harness**: 29 parameterized test cases
  exercising every combination of stale-marker injection, probe outcome, and
  reconcile behavior; drove four engine fixes during development. (#94)
- **Caveman/telegraphic close authoring**: guidance for writing close payloads
  in a compact, function-word-stripped style that reduces bootstrap token cost
  without losing load-bearing identifiers. Validated by a three-arm north-star
  harness (economy, fidelity, function-word density). (#96)
- **Close-time reality reconciliation**: mismatched assertions discovered at
  close are reconciled (1:1 supersede, 1:N suppress) rather than accumulating
  as a persistent degraded-close alarm. (#106)
- **`pruneDegradedClose` retention policy**: the engine retains the most-recent
  100 degraded-close records and prunes older ones, preventing unbounded table
  growth. (#106)
- **File-pointer staleness gate**: detects `file:line` reference drift at both
  close and resume, flagging stale pointer assertions before they mislead the
  next session. (#85)
- **Prose-vs-content stale-entry gate**: bulk-supersedes prose assertions when
  a content-bearing version exists; includes a path fallback for partial matches.
  (#86)
- **Case study Chapter 2** (`docs/case-study.md`): narrative walkthrough of
  the north-star TDD methodology, RED-by-design test suites, serve-time
  staleness design, the adversarial permutation harness, and the caveman
  authoring dogfood harness. (#97)
- **`MANIFEST.md`**: tracked index of all documentation files with purpose and
  current status, updated with each change so readers can navigate the doc tree.
- **L5 operator-only directive retirement**: non-destructive retirement path for
  directives that only an operator (not a model) may retract. (#64)
- **`CLAUDE_CODE_SESSION_ID` fallback**: session ID resolution now accepts the
  `CLAUDE_CODE_SESSION_ID` environment variable as a fallback, improving
  compatibility in environments where the primary resolution path is unavailable.
  (#79)
- **Close-reconciliation gate**: a soft contradiction notice is injected into
  `handoff.md` when close-time reconciliation detects an assertion mismatch,
  giving the next session an immediate signal. (#80)

### Changed

- **`scripts/handoff.js` dead-code removal and simplification** (behavior-preserving):
  - Collapsed a dead `if/else` in the recency-query path whose two branches
    assigned byte-identical SQL; replaced with a single `const` assignment with a
    clarifying comment.
  - Extracted a `_badAssertionIndices(errors)` helper that was duplicated verbatim
    at three strict-mode assertion-filtering sites (checkpoint async, close async,
    queue-drain); all three sites now call the helper.
  - Hoisted three inline `require(...)` calls (`child_process`, `crypto`,
    `./lib/reality-checks`) that were re-evaluated on every function entry to the
    top-level require block, where Node.js caches them after the first load.
- **`scripts/lib/` dead-code removal and URL-parse dedup** (behavior-preserving):
  - Removed a dead `else` branch in `project-identity.js` snapshot capture whose
    condition (`rows.length > 0 || rows !== undefined`) is always true; replaced
    if/else with a single unconditional assignment.
  - Hoisted two inline `require('os')` / `require('path')` calls in
    `_legacyHandoffPath` and `_newHandoffPath` to the top-level bindings already
    present in the module.
  - Extracted a `_parseBaseUrl(baseUrl)` helper in `shared.js` consolidating the
    identical hostname/port/basePath parse block that was duplicated across
    `vllmEmbed`, `vllmTokenize`, and `vllmTokenEmbed`.
- **`OLLAMA_SKIP` / `--ollama-skip` renamed to `EMBED_SKIP` / `--embed-skip`**: the
  skip-live-embedding switch is not Ollama-specific; the real embedding backend is
  vLLM Qwen3-Embedding-8B. Renamed repo-wide to the backend-neutral form. No alias
  retained.
- **`/handoff:resume` output enriched**: the resume payload now includes a
  `### Session intent` section drawn from persisted intent rows, and
  `[STALE:]` annotations are applied inline to any assertions whose
  real-world anchors have changed since they were recorded.
- **Docs rewritten for clarity**: the README, QUICKSTART, and
  `docs/how-memory-works.md` were rewritten at a more accessible reading level;
  the glossary was expanded with entries for all serve-time staleness and
  resurrect concepts; command reference pages now carry full parameter tables
  and invocation examples. (#76, #77, #100, #101, #104)
- **Glossary expanded**: added `branch_exists`, `commit_merged`, `in_file`,
  `pr_state`, `reality_check`, serve-time re-probe, `[STALE:]` annotation,
  north-star, north-star inversion, and reality reconciliation entries; corrected
  the `Prune` and `commit_merged` definitions that had drifted from
  implementation. (#107)

### Fixed

- **`handoff_close` made single-pass — MCP descriptions now carry the full
  extraction contract; engine warns on an extraction-empty close**: a field
  incident showed an MCP-path close that wrote only intent rows (tldr/
  open_threads/quick_references), requiring a second supplementary close to
  backfill entities/assertions/edges — flagged as a tooling bug, not an
  acceptable pattern. Three fixes: (1) `scripts/handoff-mcp.mjs` — the
  `handoff_checkpoint`/`handoff_close` tool `description` strings now state
  the exact field types (`quick_references` is a single string, not an
  array — a prior field incident sent it as an array and hit
  `stdin JSON: "quick_references" must be a string`), the
  `predicate-registry.json` constraint, the caveman/telegraphic authoring
  mandate for `tldr`/`open_threads`/`quick_references`, the probe-able
  volatile predicates (`in_file`/`branch_exists`/`commit_merged`/`pr_state`),
  and — for `handoff_close` specifically — that close is single-pass and an
  intent-only payload is incomplete; `handoff_checkpoint`'s description notes
  checkpoint payloads MAY be partial, unlike close. A caller on the MCP path
  never reads `commands/handoff/close.md` by hand, so this contract now lives
  in the tool description itself. (2) `scripts/handoff.js` — `cmdClose` now
  detects a payload with zero entities, zero assertions, and zero edges
  (checked against the pre-injection snapshot, so the code-computed
  `has_unpackaged_state` assertion never masks a genuinely empty caller
  payload) and prints a non-fatal `WARNING: extraction-empty close` line in
  the close output (real close, `--dry-run`, and the async-queued path all
  covered); exit code and mutation behavior are unchanged. (3)
  `commands/handoff/close.md` gains an "MCP path (handoff_close tool)"
  section stating the MCP path is bound to the same contract and that a
  supplementary close to backfill a thin one is a process bug;
  `commands/handoff/checkpoint.md` gains a short note that checkpoint MAY be
  partial, contrasting with close. (`scripts/handoff-mcp.mjs`,
  `scripts/handoff.js`, `commands/handoff/close.md`,
  `commands/handoff/checkpoint.md`, `test/handoff/test-handoff.js`)
- **`cmdPrune --suppression-kind` full canonical set**: `validKinds` now
  includes `reality_reconciled` (previously missing, making `reality_reconciled`
  rows unprunable by kind); the requires-a-value error hint and the
  `--suppression-kind` doc-comment now list all five canonical values
  (`superseded`, `downvoted_terminal`, `downvoted_probation`, `retired`,
  `reality_reconciled`). Glossary Prune entry enumeration brought in sync.
  (#106 regression)
- **Resurrect semantic path embedding dimensions**: `lib/embed.js` now
  Matryoshka-truncates embeddings to `halfvec(4000)` to match the configured
  vector column schema, resolving a silent dim-mismatch that prevented semantic
  resurrect queries from returning results. (#88)
- **Doc-lint D2 inline-code scan no longer over-spans on unbalanced backticks**: fenced
  blocks are now stripped from the content before the inline-span scan, and the inline
  regex uses a single-line class (`[^`\n]+`) to prevent a stray unbalanced backtick
  in prose from pairing with a later backtick and swallowing the span in between -- a false
  negative where a fictional `node ... handoff.js <subcommand>` invocation in the swallowed
  region would go undetected.
- **`commit_merged` probe return value**: `probeCommitMerged` now echoes the
  result object on success, allowing the reality-check registry to treat the
  predicate as verified rather than always marking it unverifiable. (#95)
- **`test-handoff.js` suite repaired**: 12 previously silently-failing tests
  were fixed by pre-minting the project marker during test setup so all
  assertions resolve against the correct UUID; the suite was added to CI. (#89)
- **`session_in_progress` lifecycle**: `cmdResume` now seeds `session_in_progress`
  on entry and `cmdCheckpoint` no longer clears it, correcting a state machine
  bug where checkpoints would falsely signal session end. (#75)
- **`seedText` whitespace handling**: leading/trailing whitespace is trimmed
  before the content gate, closing a bypass path where a padded duplicate would
  pass the prose-vs-content check. (#73)
- **L4 session resolution**: the engine now fails loudly (C2/C3 error) when a
  session cannot be resolved, replacing a silent-success path that masked
  identity failures. (#60)
- **L2 corroboration quality**: fixed a candidate-query bug that prevented
  positive-evidence corroboration from accruing correctly. (#63)
- **L0 consolidation forge**: severed a single-close path that could forge a
  consolidation event without the required multi-session corroboration. (#62)
- **pnpm hoisted layout and portable Postgres test imports**: resolved
  dependency resolution failures in hoisted monorepo layouts and made Postgres
  client imports path-portable across environments. (#87)
- **Resurrect ring review findings**: resolved ten post-review issues including
  a silent-revive bug where a topic could be marked active without a confirming
  response. (#70)

## [1.0.0] - 2026-05-18

### Added

- Initial public release of the claude-memory handoff and retrieval
  infrastructure.
- Claude Code plugin packaging: the project is installable as a Claude Code
  plugin (manifest, marketplace metadata, hook wiring, and plugin-root asset
  resolution). The loader hook stays inert when no project marker is present
  and never silently falls back to SQLite.

### Changed

- Project identity is now resolved from a durable marker-borne UUID instead of
  a path-derived identifier, with re-entrant and concurrent migration guards
  and idempotent legacy reconciliation.
- Remaining raw-SQL paths moved behind storage-port methods so the
  Postgres/SQLite storage seam translates correctly, backed by adversarial
  both-backend test coverage.

### Fixed

- A same-session exact-repeat reinforcement now takes a touch-only path that
  does not reset the decay clock, correcting a supersession/decay edge case.
