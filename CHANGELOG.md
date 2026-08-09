# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

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
