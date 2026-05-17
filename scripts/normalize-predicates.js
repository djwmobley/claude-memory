'use strict';

/**
 * normalize-predicates.js — Deterministic predicate normalization migration.
 *
 * Rewrites legacy raw predicate strings in the assertions table to their
 * canonical registry equivalents. Pure-deterministic: no model or LLM calls.
 * All rewrite rules are declared in the NORMALIZATION_MAP table below.
 *
 * Usage:
 *   node scripts/normalize-predicates.js               # dry run (default, no DB writes)
 *   node scripts/normalize-predicates.js --apply       # write rewrites to the DB
 *   node scripts/normalize-predicates.js --project-id <id>   # override project_id
 *
 * Contract:
 *   - Dry-run mode (default): prints each legacy→canonical rewrite with affected
 *     row counts and the post-condition check; makes no DB changes.
 *   - --apply mode: executes UPDATE assertions SET predicate=$canonical WHERE
 *     predicate=$legacy AND project_id=$1 for each entry in NORMALIZATION_MAP.
 *     Idempotent: a second --apply run finds zero rows to update and is a no-op.
 *   - Predicate rewrites only: never DELETEs, suppresses, or INSERTs rows.
 *   - Post-condition: prints all distinct live predicates after the run; any
 *     predicate not in the registry is flagged as still-unregistered.
 *
 * See also: docs/specs/2026-05-17-predicate-normalization.md
 */

const path = require('path');

// Resolve PROJECT_ROOT before requiring shared modules so findProjectRoot()
// picks up the repo root rather than the scripts/ subdirectory.
if (!process.env.PROJECT_ROOT) {
  process.env.PROJECT_ROOT = path.resolve(__dirname, '..');
}

const { loadConfig } = require('./lib/shared');
const { encodeCwd }   = require('./lib/encoded-cwd');
const { recognizedPredicates } = require('./lib/predicate-registry');
const { Client } = require('pg');

// ─── NORMALIZATION MAP ────────────────────────────────────────────────────────
//
// Each entry: { legacy, canonical }
//
//   legacy     — the raw predicate string currently in the DB.
//   canonical  — the registry-declared predicate it should be rewritten to.
//
// Entries are applied in order; each UPDATE is scoped to project_id so it does
// not touch other projects sharing the same DB.
//
// Rationale for each mapping is documented in:
//   docs/specs/2026-05-17-predicate-normalization.md
//
const NORMALIZATION_MAP = [
  // user_chose → chose
  // user_chose is a redundant prefixed variant of chose. Both record a
  // user-stated choice. Merging them under chose makes cardinality enforcement
  // for 1:1 choices unambiguous.
  { legacy: 'user_chose', canonical: 'chose' },

  // is_blocked_by → blocked_by
  // is_blocked_by is a synonym for blocked_by produced by early extraction
  // passes. The registry carries blocked_by as the canonical form; is_blocked_by
  // is retained as a registered predicate but is flagged for normalization.
  { legacy: 'is_blocked_by', canonical: 'blocked_by' },

  // now_uses → uses
  // now_uses was used to signal a transition to a new tool or mechanism.
  // The "now_" prefix is extraction noise; the semantic payload belongs under
  // uses (1:N). Merging eliminates split cardinality tracking across the two forms.
  { legacy: 'now_uses', canonical: 'uses' },
];

// ─── MAIN ────────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const applyMode = args.includes('--apply');

  // Allow explicit project_id override for cross-project use.
  const pidFlagIdx = args.indexOf('--project-id');
  let projectId;
  if (pidFlagIdx !== -1 && args[pidFlagIdx + 1]) {
    projectId = args[pidFlagIdx + 1];
  } else {
    projectId = encodeCwd(process.env.PROJECT_ROOT);
  }

  const cfg = loadConfig();
  const client = new Client({
    host:     cfg.host,
    port:     cfg.port,
    database: 'claude_memory_eval_test',
    user:     cfg.user,
  });
  await client.connect();

  console.log('');
  console.log('=== normalize-predicates ===');
  console.log(`mode      : ${applyMode ? '--apply (WRITES ENABLED)' : 'dry-run (read-only, default)'}`);
  console.log(`project_id: ${projectId}`);
  console.log(`database  : claude_memory_eval_test`);
  console.log('');

  // ── Step 1: Enumerate current predicate counts ──────────────────────────────
  const { rows: currentCounts } = await client.query(
    `SELECT predicate, count(*) AS n
       FROM assertions
      WHERE project_id = $1
      GROUP BY predicate
      ORDER BY n DESC`,
    [projectId]
  );

  const countByPredicate = new Map(currentCounts.map(r => [r.predicate, parseInt(r.n, 10)]));

  console.log('--- Current live predicates ---');
  for (const row of currentCounts) {
    console.log(`  ${row.predicate.padEnd(40)} ${row.n}`);
  }
  console.log('');

  // ── Step 2: Apply (or preview) each normalization rule ──────────────────────
  console.log('--- Normalization rewrites ---');
  let totalRewrites = 0;

  for (const { legacy, canonical } of NORMALIZATION_MAP) {
    const affectedCount = countByPredicate.get(legacy) || 0;

    if (affectedCount === 0) {
      console.log(`  [skip]  ${legacy.padEnd(30)} -> ${canonical.padEnd(30)} (0 rows — already normalized or absent)`);
      continue;
    }

    if (applyMode) {
      const result = await client.query(
        `UPDATE assertions
            SET predicate = $1
          WHERE predicate = $2
            AND project_id = $3`,
        [canonical, legacy, projectId]
      );
      const updated = result.rowCount;
      console.log(`  [apply] ${legacy.padEnd(30)} -> ${canonical.padEnd(30)} (${updated} row(s) updated)`);
      totalRewrites += updated;
    } else {
      console.log(`  [dry]   ${legacy.padEnd(30)} -> ${canonical.padEnd(30)} (${affectedCount} row(s) would be updated)`);
      totalRewrites += affectedCount;
    }
  }

  console.log('');
  if (applyMode) {
    console.log(`Total rows rewritten: ${totalRewrites}`);
  } else {
    console.log(`Total rows that would be rewritten: ${totalRewrites}`);
    console.log('(run with --apply to execute)');
  }
  console.log('');

  // ── Step 3: Post-condition self-check ────────────────────────────────────────
  // Re-query the live predicates (after apply, or against current state in dry mode).
  const { rows: postCounts } = await client.query(
    `SELECT predicate
       FROM assertions
      WHERE project_id = $1
      GROUP BY predicate
      ORDER BY predicate`,
    [projectId]
  );

  const registeredSet = new Set(recognizedPredicates());
  const unregistered = postCounts.map(r => r.predicate).filter(p => !registeredSet.has(p));

  console.log('--- Post-condition: predicate registry coverage ---');
  if (unregistered.length === 0) {
    console.log('  PASS: all live predicates are in the registry.');
  } else {
    console.log(`  WARN: ${unregistered.length} live predicate(s) not yet in the registry:`);
    for (const p of unregistered) {
      console.log(`    - ${p}`);
    }
    console.log('  These predicates exist in the live store but have no registry entry.');
    console.log('  Add them to scripts/lib/predicate-registry.json before enforcing strict mode.');
  }
  console.log('');

  await client.end();
}

main().catch(err => {
  console.error('normalize-predicates: fatal error:', err.message);
  process.exit(1);
});
