# Contributing to claude-memory

Thank you for your interest in contributing. This document describes the prerequisites,
how to run the test suite, branch and commit conventions, and the review/merge norm.

---

## Prerequisites

**Postgres is required.** This project uses PostgreSQL as its production storage
backend. There is no SQLite fallback for development or production use — SQLite exists
solely as the db-seam validation arm (CI built-in `node:sqlite`), exercised by the
seam and both-backend test steps below. Do not frame development setup around SQLite
as the primary path.

- **PostgreSQL 13+** — no extensions required for the handoff layer (the optional
  full-text + vector layer requires pgvector 0.8.1+, but it is separate)
- **Node 22+** — required for the `node:sqlite` built-in used by the seam and
  both-backends test steps; CI runs Node 22
- **pnpm 9+** — package manager for the `scripts/` workspace

---

## Running the full test suite

Mirror the steps in `.github/workflows/test.yml` in order. Set the following
environment variables before running Postgres-backed steps:

```
PGHOST=localhost
PGUSER=postgres
PGPASSWORD=postgres
```

### Step 1 — Install dependencies

```sh
cd scripts && pnpm install --frozen-lockfile
```

### Step 2 — Apply base schema

```sh
PGPASSWORD=postgres psql -h localhost -U postgres -f scripts/setup.sql
```

### Step 3 — Chunker tests

```sh
DATABASE_URL=postgres://postgres:postgres@localhost/postgres EMBED_SKIP=1 node scripts/test-chunker.js
```

`EMBED_SKIP=1` skips embedding assertions (no live embedding backend required in CI or local runs).

### Step 4 — Retrieval eval (FTS-only smoke test)

```sh
PGHOST=localhost PGUSER=postgres PGPASSWORD=postgres \
  EMBED_SKIP=1 \
  node test/eval/eval-retrieval.js --embed-skip
```

No manual database setup required. The harness generates a unique throwaway
database, creates it at startup, and drops it when finished (even on failure).

This exercises the SQL/loader/schema path. Vector-quality regression detection
requires a local vLLM instance and is skipped in CI.

### Step 6 — Graph edge-traversal tests

```sh
PGHOST=localhost PGUSER=postgres PGPASSWORD=postgres node scripts/test-graph-traversal.js
```

Creates and drops throwaway databases against the local Postgres instance.

### Step 7 — Full smoketest suite

```sh
PGHOST=localhost PGUSER=postgres PGPASSWORD=postgres node scripts/smoketest-handoff.js
```

Runs all sections including supersession invariant and predicate-registry drift detection.

### Step 8 — SQLite seam tests (Node 22 required)

```sh
node scripts/test-sqlite-seam.js
```

Pure Node — no Postgres required. Guards the storage-abstraction seam: dialect rewrite,
schema application, JSONB round-trip, graph CTE, abstraction invariant, bi-temporal
columns, canonicalization, and manual prune.

### Step 9 — Both-backend adversarial-invariant sweep (Node 22 required)

```sh
PGHOST=localhost PGUSER=postgres PGPASSWORD=postgres node scripts/test-both-backends.js
```

Runs 10 adversarial invariants against both Postgres and SQLite backends. The SQLite half
requires Node 22 (built-in `node:sqlite`). Both halves gate in CI.

### Step 11 — Plugin packaging tests

```sh
node scripts/test-plugin-packaging.js
```

Pure Node — no Postgres or Ollama required. Validates the Claude Code plugin manifest,
`CLAUDE_PLUGIN_ROOT` asset resolution, loader-hook inertness, and the no-silent-SQLite-fallback
guard.

---

## Branch conventions

- Base all work on `main`.
- Use short, descriptive branch names (e.g., `fix/seam-dialect-rewrite`, `feat/prune-dry-run`).

## Commit conventions

Use [Conventional Commits](https://www.conventionalcommits.org/):

```
<type>(<scope>): <subject>
```

Types used in this repo: `feat`, `fix`, `docs`, `test`, `ci`, `refactor`, `chore`.
Scope is optional but encouraged (e.g., `seam`, `plugin`, `hooks`, `schema`).

Examples from recent history:

```
feat(plugin): PR-3b Claude Code plugin packaging
fix(seam): close SQL translation holes A+B via port methods
feat(hardening): PR-3a concurrent-safe identity + robust migration guards
docs: public-readiness close + scrub + comparison study
```

---

## Review and merge norm

Every PR is reviewed and merged by someone other than its author; GitHub CI must be fully
green before merge. The author opens the PR; a separate reviewer approves and merges.

---

## Language

US English spelling in all code, comments, strings, documentation, and prose.
Examples: "center" not "centre", "realize" not "realise", "color" not "colour".
