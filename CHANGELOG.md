# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

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

- **Resurrect semantic path embedding dimensions**: `lib/embed.js` now
  Matryoshka-truncates embeddings to `halfvec(4000)` to match the configured
  vector column schema, resolving a silent dim-mismatch that prevented semantic
  resurrect queries from returning results. (#88)
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
  positive-evidence corroboration from accruing correctly. (#62 area)
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
