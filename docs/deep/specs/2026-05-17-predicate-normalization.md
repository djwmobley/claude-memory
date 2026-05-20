> Archive — preserved for reference. For the current operator-facing docs, see [QUICKSTART.md](../../QUICKSTART.md) or [README.md](../../README.md).

---
title: Predicate Normalization Migration — Legacy→Canonical Rewrite Spec
change_size: MEDIUM
---

# Predicate Normalization Migration

This document is the authoritative specification for `scripts/normalize-predicates.js`. It covers the legacy→canonical predicate mapping table, per-mapping rationale, the exact SQL executed, the dry-run/`--apply` behavioral contract, and the post-condition self-check.

**Prerequisite:** This migration is a follow-on to the predicate-vocabulary registry expansion (registry version 1.1). All canonical predicates referenced here must exist in `scripts/lib/predicate-registry.json` before the migration is applied.

**Status:** Ready for execution. Not yet applied against the live store.

---

## 1. Purpose

The live assertions store accumulated predicate strings across multiple sessions without a controlled vocabulary. Several predicates are semantic duplicates or variant spellings of canonical registry entries. This migration rewrites those legacy predicates to their canonical forms, making the live store consistent with the registry and enabling sound per-predicate cardinality enforcement by the future write-time supersession path.

This migration is a prerequisite enabling step for the same-subject collision / supersession write path (see `docs/specs/2026-05-16-memory-bootstrap-collision.md`). The supersession logic requires that every predicate in the store map unambiguously to a registry entry with a declared cardinality. Without normalization, split vocabulary (e.g., `user_chose` and `chose` for the same semantic) would produce inconsistent cardinality classification and incorrect supersession behavior.

---

## 2. Dry-Run / `--apply` Contract

### Default behavior (dry run)

Running `node scripts/normalize-predicates.js` without flags performs a read-only pass:

1. Queries the live predicate counts for the current project.
2. For each entry in `NORMALIZATION_MAP`, prints the legacy predicate, canonical target, and the number of rows that would be updated.
3. Runs the post-condition self-check (registry coverage) against the current state.
4. Makes **no changes** to the database.

### `--apply` mode

Running `node scripts/normalize-predicates.js --apply` executes the rewrites:

1. Same pre-query as dry run.
2. For each entry in `NORMALIZATION_MAP`, executes the UPDATE (see §3 below).
3. Reports rows actually updated.
4. Runs the post-condition self-check against the post-update state.

### Idempotency

A second `--apply` run is always a no-op. After the first run, no rows match the legacy predicate strings, so every UPDATE affects 0 rows.

### Scope

The migration is scoped to `project_id` and never touches rows from other projects sharing the same database.

---

## 3. Normalization Mapping Table

| Legacy predicate | Canonical predicate | Cardinality | Rationale |
|---|---|---|---|
| `user_chose` | `chose` | 1:1 | `user_chose` is a prefixed variant of `chose`, both recording a user-stated choice. Merging under `chose` eliminates split supersession keys for 1:1 choice assertions. |
| `is_blocked_by` | `blocked_by` | 1:N | `is_blocked_by` is a passivized synonym for `blocked_by` produced by early extraction passes. The registry canonical form is `blocked_by`. |
| `now_uses` | `uses` | 1:N | `now_uses` was used to signal a transition to a new tool. The `now_` prefix is extraction noise; the semantic belongs under `uses` (1:N). Merging eliminates split cardinality tracking. |

### Retained legacy entries

The following predicates appear in the live store with at most 1 row each and are **not** remapped by this migration. They are registered with their own entries in registry version 1.1 and are kept as distinct canonical predicates:

- `is_blocked_by` — registered as 1:N, distinct from `blocked_by` in edge cases; normalization to `blocked_by` is performed.
- All other singleton predicates (e.g., `cmdDrop_refactor`, `README_roadmap_scope`) — domain-specific and not synonymous with any other registered predicate.

---

## 4. Exact SQL Executed

For each `(legacy, canonical)` pair in the normalization map, the script executes:

```sql
UPDATE assertions
   SET predicate = $1   -- canonical
 WHERE predicate = $2   -- legacy
   AND project_id = $3;
```

Parameters bound in order: `[canonical, legacy, projectId]`.

No `DELETE`, no `INSERT`, no schema changes. The migration rewrites the `predicate` column value only.

---

## 5. Post-Condition Self-Check

After the dry run or `--apply` pass, the script queries:

```sql
SELECT predicate
  FROM assertions
 WHERE project_id = $1
 GROUP BY predicate
 ORDER BY predicate;
```

Each distinct live predicate is tested against `recognizedPredicates()` from `scripts/lib/predicate-registry.js`. If any predicate is absent from the registry, it is printed as a warning. A clean pass prints:

```
PASS: all live predicates are in the registry.
```

After this migration is applied, the post-condition check is expected to pass for all predicates in the target project.

---

## 6. Execution Instructions

```sh
# Dry run (safe, read-only)
node scripts/normalize-predicates.js

# Apply rewrites
node scripts/normalize-predicates.js --apply

# Override project_id (for cross-project use)
node scripts/normalize-predicates.js --apply --project-id <encoded-cwd>
```

The script must be run from the repository root (or with `PROJECT_ROOT` set), so that `loadConfig()` resolves `.claude/pipeline.yml` correctly.

---

## 7. Registry Coverage After Migration

As of registry version 1.1, the following 84 predicates are registered. All live predicates in the `claude-memory` project are covered. Post-migration, the three legacy predicates (`user_chose`, `is_blocked_by`, `now_uses`) will no longer appear as distinct values; their rows will be rewritten to `chose`, `blocked_by`, and `uses` respectively, reducing the distinct live predicate count from 84 to 81.

Registered predicates (alphabetical): `README_roadmap_scope`, `accepted_grounds`, `activated_by`, `added_via`, `affirmed`, `applied_in`, `applies`, `are`, `are_safe_outside_claude-memory`, `behavior`, `blocked_by`, `captures`, `caught`, `chose`, `cmdDrop_refactor`, `converged`, `covers`, `created_by`, `currently_at`, `default`, `defaults_to`, `defined_as`, `delivered`, `depends_on`, `elevates_to`, `enforces`, `evaluates_at`, `false_positive`, `fires_on`, `fixed_in`, `found_bug`, `git_quirk`, `has`, `has_artifact`, `has_defect`, `in_file`, `includes`, `is`, `is_at_commit`, `is_authoritative_db`, `is_blocked_by`, `is_cleared_by`, `is_constraint`, `is_designed_for`, `is_direction`, `is_exactly`, `is_model`, `is_not_applied_by`, `is_over_tuned_for`, `is_set_by`, `is_status`, `is_value`, `listens_on`, `location`, `matching_algorithm`, `means`, `moved_to`, `must_do`, `must_mean`, `never_uses`, `no_longer_includes`, `now_include`, `now_uses`, `orchestrates_only`, `originate_from`, `phase_ordering`, `policy`, `prefers`, `reads`, `requires`, `returns`, `schema_migration_is`, `shipped_at`, `shipped_in`, `should`, `skip_for`, `skipped`, `takes_arg`, `trigger`, `usage`, `user_chose`, `user_directed`, `uses`, `uses_db`.