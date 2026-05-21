**claude-memory is a session seam — a relay baton handed off between sessions, not a court stenographer.**

It persists durable session state as queryable Postgres rows at the session boundary, serves the minimum context needed to resume effectively, and makes dormant topics retrievable on demand. What it is not: a verbatim transcript, a running log, or always-on surveillance of every utterance.

---

## Documentation index

| Path | Purpose | Status |
|---|---|---|
| `README.md` | Project overview, install, quickstart pointer | current |
| `CLAUDE.md` | Project-level operating instructions for Claude Code | current |
| `MANIFEST.md` | This file — tracked index of all documentation | updated (serve-time staleness fix docs) |
| `QUICKSTART.md` | Step-by-step setup guide for new users | current |
| `PREREQS.md` | System prerequisites (Node, Postgres, pgvector, vLLM) | current |
| `CHANGELOG.md` | Version history and release notes | current |
| `CONTRIBUTING.md` | Contribution guidelines and workflow | current |
| `CODE_OF_CONDUCT.md` | Community standards | current |
| `SECURITY.md` | Security policy and disclosure process | current |
| `docs/how-memory-works.md` | Conceptual explanation of the system, session seam model, identity + limitations | updated (serve-time reality re-probe section added) |
| `docs/glossary.md` | Term definitions for all concepts used across the docs | updated (branch_exists, commit_merged, in_file, pr_state, reality_check, serve-time reality re-probe, [STALE:] annotation entries added) |
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
| `commands/handoff/README.md` | Overview of all `/handoff:*` slash commands | current |
| `commands/handoff/init.md` | `/handoff:init` — first-run provisioning command | current |
| `commands/handoff/status.md` | `/handoff:status` — read-only project memory status | current |
| `commands/handoff/close.md` | `/handoff:close` — end-of-session extraction and session-intent persistence | updated (caveman/telegraphic authoring guidance for tldr, open_threads, quick_references) |
| `commands/handoff/resume.md` | `/handoff:resume` — explicit context load; surfaces `### Session intent` section | updated (serve-time reality re-probe description added) |
| `commands/handoff/checkpoint.md` | `/handoff:checkpoint` — mid-session save without ending the session | current |
| `commands/handoff/promote.md` | `/handoff:promote` — promote an assertion to CLAUDE.md durable facts | current |
| `commands/handoff/drop.md` | `/handoff:drop` — archive prior session memory and start fresh | current |
| `commands/handoff/purge.md` | `/handoff:purge` — hard delete all project memory (confirmation required) | current |
| `commands/handoff/resurrect.md` | `/handoff:resurrect` — pull a decayed topic back into active context | current |
| `hooks/README.md` | SessionStart and Stop hook setup and behavior | current |
| `scripts/lib/predicate-audit.js` | Exports `findUnregisteredPredicates` (pure) and `auditAssertionPredicates` (DB query) — detects predicates used in the assertions table that are not in the declared registry vocabulary | added |
| `scripts/audit-predicates.js` | Ops CLI: connects to configured DB, runs `auditAssertionPredicates` across the live corpus (or a single project via `--project=<uuid>`), exits 0 (all registered), 2 (DB error), or 3 (drift found) | added |
| `test/handoff/test-predicate-vocabulary.js` | CI guard: T1 DB-drift detection (has_updated class), T2 clean corpus passes, T3 strict-mode vocabulary guard, T4 pure helper + locks has_updated/in_file registration | added |
| `test/north-star/test-caveman-economy.js` | North-star GREEN gate: dogfoods caveman/telegraphic authoring — proves leaner close payloads reduce bootstrap tokens with zero load-bearing loss (3 arms: economy, fidelity, function-word density) | added |
| `test/north-star/fixtures/caveman-payload.json` | Telegraphic close fixture — identical load-bearing tokens to verbose-payload.json, function words stripped | added |
| `test/north-star/fixtures/verbose-payload.json` | Full-prose close fixture — grammatical sentences, identical load-bearing tokens to caveman-payload.json | added |
