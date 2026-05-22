**claude-memory is a session seam — a relay baton handed off between sessions, not a court stenographer.**

It persists durable session state as queryable Postgres rows at the session boundary, serves the minimum context needed to resume effectively, and makes dormant topics retrievable on demand. What it is not: a verbatim transcript, a running log, or always-on surveillance of every utterance.

---

## Documentation index

| Path | Purpose | Status |
|---|---|---|
| `README.md` | Project overview, install, quickstart pointer | updated (added parameter column to command table) |
| `CLAUDE.md` | Project-level operating instructions for Claude Code | current |
| `MANIFEST.md` | This file — tracked index of all documentation | updated (command-parameter build: docs + test files tracked) |
| `QUICKSTART.md` | Step-by-step setup guide for new users | updated (added /handoff:resurrect) |
| `PREREQS.md` | System prerequisites (Node, Postgres, pgvector, vLLM) | current |
| `CHANGELOG.md` | Version history and release notes | updated (Unreleased section backfilled with post-1.0.0 changes from PRs #59–#113; chore: handoff.js dead-code + helper dedup + require hoisting; refactor: lib/ dead-code removal + URL-parse dedup; refactor: hoist duplicated test helpers + remove dead code in smoketest, graph-traversal, plugin-packaging; refactor: de-duplicate test-both-backends.js helpers) |
| `CONTRIBUTING.md` | Contribution guidelines and workflow | current |
| `CODE_OF_CONDUCT.md` | Community standards | current |
| `SECURITY.md` | Security policy and disclosure process | current |
| `docs/how-memory-works.md` | Conceptual explanation of the system, session seam model, identity + limitations | updated (staleness refresh: added /handoff:resurrect, de-jargoned north-star-inversion phrasing, removed duplicated north-star tenets, pointer to case-study.md) + coherence pass (Fix 1: resurrect auto/manual link; Fix 2: session-intent de-jargon; Fix 3: what-it-isn't statement) + param-docs pass (slash-commands section: inline parameter forms added for all commands that take params) + reconcile pass (close-time reconciliation paragraph added to serve-time section) |
| `docs/glossary.md` | Term definitions for all concepts used across the docs | updated (branch_exists, commit_merged, in_file, pr_state, reality_check, serve-time reality re-probe, [STALE:] annotation entries added; /handoff:resurrect count updated to nine) + reconcile pass (commit_merged object description corrected; branch_exists/reality_check/serve-time entries updated; reality reconciliation term added) + north-star pass (North star + North-star inversion entries added; Prune fictional-command claim removed and rewritten accurately; commit_merged verified-form corrected to echoed-object form) + correction pass (Prune entry rewritten to accurately document the real operator `node scripts/handoff.js prune` subcommand: dry-run default, --apply for hard DELETE, criteria flags, assertions-only scope, not a slash command) |
| `docs/case-study.md` | Narrative walkthrough of two design problems: Ch.1 decay/operator-pin/resurrection; Ch.2 north-star TDD harness, RED-by-design test methodology, serve-time staleness, adversarial permutation harness, caveman dogfooding | updated (Chapter 2 added) |
| `docs/troubleshooting.md` | Diagnosis guide for common setup and runtime problems | current |
| `docs/deep/retrieval-contract-evolution.md` | How the retrieval contract schema has evolved over time | current |
| `docs/deep/findings/debate-2026-05-16-memory-bootstrap-collision.md` | Design finding: memory bootstrap collision analysis | current |
| `docs/deep/specs/2026-05-14-bundle-a-substrate.md` | Design spec: Bundle A substrate decisions | current |
| `docs/deep/specs/2026-05-16-assertion-extraction-architecture.md` | Design spec: assertion extraction pipeline architecture | current |
| `docs/deep/specs/2026-05-16-memory-bootstrap-collision.md` | Design spec: memory bootstrap collision resolution | current |
| `docs/deep/specs/2026-05-17-predicate-normalization.md` | Design spec: predicate normalization rules | current |
| `docs/deep/studies/2026-05-memory-systems-comparison.md` | Comparative analysis: claude-memory vs. mem0, Graphiti/Zep, Letta, others | current |
| `docs/deep/studies/decay-vs-dont-forget-and-resurrection.md` | Study: decay, devalue-vs-invalidate, and the resurrect ring design | current |
| `commands/handoff/README.md` | Overview of all `/handoff:*` slash commands | updated (added /handoff:resurrect) |
| `commands/handoff/init.md` | `/handoff:init` — first-run provisioning command | updated (removed phantom $2 description positional; added Arguments table + invocation examples for <name> and -y) |
| `commands/handoff/status.md` | `/handoff:status` — read-only project memory status | updated (added --json, --breakdown, --stale-pointers flags with Arguments table + examples) |
| `commands/handoff/close.md` | `/handoff:close` — end-of-session extraction and session-intent persistence | updated (--dry-run flag added: Arguments table + expected output + what is/is not rehearsed; --json alone still works) + reconcile pass (close-time reality reconciliation note added) |
| `commands/handoff/resume.md` | `/handoff:resume` — explicit context load; surfaces `### Session intent` section | updated (serve-time reality re-probe description added; added "Arguments: none" section) |
| `commands/handoff/checkpoint.md` | `/handoff:checkpoint` — mid-session save without ending the session | updated (--note flag added: Arguments table + expected output; --json alone still works) |
| `commands/handoff/promote.md` | `/handoff:promote` — promote an assertion to CLAUDE.md durable facts | updated (--subject/--predicate/--object promote-by-content + --demote added; Arguments table + full expected-output examples + exit codes) |
| `commands/handoff/drop.md` | `/handoff:drop` — archive prior session memory and start fresh | updated (added "Arguments: none" section) |
| `commands/handoff/purge.md` | `/handoff:purge` — hard delete all project memory (confirmation required) | updated (added --dry-run flag with Arguments table + expected output) |
| `commands/handoff/resurrect.md` | `/handoff:resurrect` — pull a decayed topic back into active context | updated (added --json flag to Flags table + JSON output example + invocation examples) |
| `hooks/README.md` | SessionStart and Stop hook setup and behavior | current |
| `scripts/lib/test-pg-helpers.js` | Shared PG test-harness helpers (pgConnect, createDb/createTestDb, dropDb/dropTestDb, setSetting, getSettingsLike, setContract, makeEnv, runHandoff, runClose, applySchema, resolveProjectId, resolveHandoffMdPath, cleanupHandoffMd, setupProject) extracted from six test scripts | added |
| `scripts/lib/predicate-audit.js` | Exports `findUnregisteredPredicates` (pure) and `auditAssertionPredicates` (DB query) — detects predicates used in the assertions table that are not in the declared registry vocabulary | added |
| `scripts/audit-predicates.js` | Ops CLI: connects to configured DB, runs `auditAssertionPredicates` across the live corpus (or a single project via `--project=<uuid>`), exits 0 (all registered), 2 (DB error), or 3 (drift found) | added |
| `test/handoff/test-predicate-vocabulary.js` | CI guard: T1 DB-drift detection (has_updated class), T2 clean corpus passes, T3 strict-mode vocabulary guard, T4 pure helper + locks has_updated/in_file registration | added |
| `test/handoff/test-cmd-params.js` | Focused tests for new command-parameter flags: status --json/--breakdown/--stale-pointers, purge --dry-run, close/checkpoint --json-alone, resurrect --json | added |
| `test/handoff/test-write-path-params.js` | Tests for write-path command parameters: checkpoint --note writes session_note row; promote by content (single/zero/multi match); promote --demote; close --dry-run performs no writes | added |
| `scripts/lib/predicate-registry.json` | Authoritative predicate vocabulary registry | updated (session_note predicate added as 1:N, added_version 1.3) |
| `test/north-star/test-caveman-economy.js` | North-star GREEN gate: dogfoods caveman/telegraphic authoring — proves leaner close payloads reduce bootstrap tokens with zero load-bearing loss (3 arms: economy, fidelity, function-word density) | added |
| `test/north-star/fixtures/caveman-payload.json` | Telegraphic close fixture — identical load-bearing tokens to verbose-payload.json, function words stripped | added |
| `test/north-star/fixtures/verbose-payload.json` | Full-prose close fixture — grammatical sentences, identical load-bearing tokens to caveman-payload.json | added |
| `test/handoff/test-reality-reconcile.js` | Tests for reality-mismatch reconcile (Part 1 + Part 2): R1 branch_exists 1:1 reconcile, R2 idempotency, R3 in_file 1:N reconcile + §7 no-backfill, R4 degraded_close retention prune (keep-most-recent-100 policy) | updated (R4 rewritten for keep-100 policy) |
| `test/handoff/test-degraded-close-retention.js` | Focused unit tests for pruneDegradedClose() in isolation — seeds 110/2/8 records, asserts keep-most-recent-100 invariants, runs on both Postgres and SQLite | added |
| `scripts/test-doc-lint.js` | CI gate enforcing glossary See-also cross-reference resolution, doc-to-real-command validity (/handoff: slash commands + handoff.js engine subcommands), and suppression_kind enum sync across SQL schema, cmdPrune validKinds, and the glossary Prune bullet | added |
| `scripts/test-both-backends.js` | Dual-backend (Postgres + SQLite) integration test harness — S1–S19 covering schema, prune, seam, project-identity, migration, suppression, and both-backend parity | updated (refactor: hoisted HANDOFF_SRC, dialectHelpers, isSuppressed/isActive, PAYLOAD_STAGING_RE, totalCount, freshPid to module scope; -29 net lines) |
