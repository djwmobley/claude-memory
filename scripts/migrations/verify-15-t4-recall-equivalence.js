'use strict';

const AUTHORED_BY = 'sonnet-t-battery-author-2026-07-27';

/**
 * verify-15-t4-recall-equivalence.js — T4, recall-equivalence harness
 * (§15.2).
 *
 * A fixture corpus of representative queries (recall-equivalence-queries.json
 * — real file gitignored, see .example.json for shape) run against the OLD
 * store and the staging store; assert the same load-bearing facts surface
 * on both sides.
 *
 * Fixture coverage requirement (closes A-13, first half) — PRECONDITION,
 * enforced BEFORE any query runs: every migration_manifest (targetTable,
 * project_id_or_null) pair — excluding excluded_reason IS NOT NULL slices
 * (nothing to recall from a deliberately-excluded slice) and excluding
 * NULL-scoped (project_id_or_null IS NULL) rows (not a real project a
 * fixture query could target) — must have >=1 fixture query pointed at it.
 * Any manifest-covered pair with zero fixture coverage is a FATAL, loud
 * failure before a single query runs.
 *
 * Fact-matching key, pinned (closes A-13, second half): normalized
 * (lowercased, whitespace-collapsed) tuple over the fixture's declared
 * tuple_cols — EXACT match only, never fuzzy.
 *
 * Writes a containment_evidence row (check_id='T4') once the fixture-
 * coverage precondition passes (§15.2.1, closes V-4) — required by
 * --recorded-by (or RECORDED_BY env), which MUST differ from this script's
 * own AUTHORED_BY for T10's independence cross-check to accept it
 * (verify-15-acceptance.js enforces this mechanically).
 *
 * Usage:
 *   node scripts/migrations/verify-15-t4-recall-equivalence.js --db <target> --recorded-by <agent-id>
 * Exit codes: 0 = fixture coverage complete AND every fact matched AND
 * isolation holds, 1 = any failure.
 */

const fs = require('fs');
const path = require('path');
const shared = require('./lib/verify15-shared');

const FIXTURE_ENV_VAR = 'RECALL_EQUIVALENCE_QUERIES';
const FIXTURE_EXAMPLE_FILE = 'recall-equivalence-queries.example.json';

function resolveFixturePath() {
  return process.env[FIXTURE_ENV_VAR] || path.join(shared.MIGRATIONS_DIR, 'recall-equivalence-queries.json');
}

function loadFixtures() {
  const p = resolveFixturePath();
  if (!fs.existsSync(p)) {
    console.error(`FATAL: recall-equivalence fixture file not found at "${p}".`);
    console.error(`  Set ${FIXTURE_ENV_VAR} to point at the real fixtures, or create`);
    console.error(`  scripts/migrations/recall-equivalence-queries.json (gitignored, private).`);
    console.error(`  See scripts/migrations/${FIXTURE_EXAMPLE_FILE} for the required shape.`);
    process.exit(1);
  }
  const data = JSON.parse(fs.readFileSync(p, 'utf8'));
  if (!Array.isArray(data.projects)) {
    console.error(`FATAL: fixture file "${p}" must have a "projects" array.`);
    process.exit(1);
  }
  return data;
}

function normalizeTuple(cols, row) {
  return cols.map((c) => String(row[c] ?? '').toLowerCase().replace(/\s+/g, ' ').trim()).join('');
}

/**
 * Coverage precondition: every migration_manifest (targetTable,
 * project_id_or_null) pair (excluding excluded slices and NULL-scoped rows)
 * must have >=1 fixture query in `fixtures.projects[].queries[]` whose
 * `table` + the project's `project_id` matches it. Returns the list of
 * missing pairs (empty = precondition satisfied).
 */
function assertFixtureCoverageComplete(fixtures, manifestPairs) {
  const covered = new Set();
  for (const proj of fixtures.projects || []) {
    for (const q of proj.queries || []) {
      covered.add(`${q.table}::${proj.project_id}`);
    }
  }
  return manifestPairs.filter((pair) => !covered.has(`${pair.targetTable}::${pair.projectId}`));
}

async function getManifestPairs(client, roster) {
  const { rows } = await client.query(
    `SELECT DISTINCT source_table, project_id_or_null FROM migration_manifest WHERE excluded_reason IS NULL AND project_id_or_null IS NOT NULL`
  );
  const bySourceTable = new Map(roster.map((e) => [e.source_table, e.targetTable]));
  return rows
    .map((r) => ({ targetTable: bySourceTable.get(r.source_table), projectId: r.project_id_or_null }))
    .filter((p) => p.targetTable);
}

async function runFactQuery(srcClient, tgtClient, q) {
  const oldRes = await srcClient.query(q.old_store.sql, q.old_store.params || []);
  const newRes = await tgtClient.query(q.staging.sql, q.staging.params || []);
  const newTuples = new Set(newRes.rows.map((r) => normalizeTuple(q.tuple_cols, r)));
  const missing = oldRes.rows
    .map((r) => normalizeTuple(q.tuple_cols, r))
    .filter((t) => !newTuples.has(t));
  return { missing, oldCount: oldRes.rows.length, newCount: newRes.rows.length };
}

async function runIsolationCheck(tgtClient, iso) {
  const res = await tgtClient.query(iso.staging_sql, iso.params || []);
  const leaked = res.rows.filter((r) => r.project_id !== iso.project_a);
  return { leaked, total: res.rows.length };
}

function parseRecordedBy(argv) {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--recorded-by') return argv[i + 1];
    if (argv[i].startsWith('--recorded-by=')) return argv[i].slice('--recorded-by='.length);
  }
  return process.env.RECORDED_BY || null;
}

async function main() {
  const argv = process.argv.slice(2);
  const { name: target, source } = shared.resolveAndClassifyTargetDb(argv);
  const recordedBy = parseRecordedBy(argv);
  console.log(`verify-15-t4-recall-equivalence: target="${target}" (resolved from ${source})`);

  if (!recordedBy) {
    console.error('FATAL: --recorded-by <agent-id> (or RECORDED_BY env) is required — T4 writes a containment_evidence row and T10 cross-checks its recorded_by against harness-authorship.json.');
    process.exit(1);
  }

  const roster = shared.loadRoster();
  const fixtures = loadFixtures();

  const tgtClient = await shared.connect(target);
  let failed = false;
  try {
    await shared.applyDdl(tgtClient);

    const manifestPairs = await getManifestPairs(tgtClient, roster);
    const missingCoverage = assertFixtureCoverageComplete(fixtures, manifestPairs);
    if (missingCoverage.length > 0) {
      console.error(`[T4] FATAL: fixture coverage precondition FAILED — ${missingCoverage.length} migration_manifest (table, project) pair(s) have zero fixture queries:`);
      for (const p of missingCoverage) console.error(`  - ${p.targetTable} / ${p.projectId}`);
      process.exit(1);
    }
    console.log(`[T4] fixture coverage precondition OK: all ${manifestPairs.length} migration_manifest (table, project) pairs covered.`);

    await shared.writeContainmentEvidence(tgtClient, {
      checkId: 'T4',
      queryText: 'fixture-coverage precondition: every migration_manifest (targetTable, project_id_or_null) pair has >=1 fixture query',
      result: `PASS — ${manifestPairs.length} pairs covered, 0 missing`,
      recordedBy,
    });

    // Fact-equivalence queries.
    const sourceClients = new Map();
    for (const proj of fixtures.projects) {
      for (const q of proj.queries) {
        const srcDb = q.old_store.database;
        if (!sourceClients.has(srcDb)) sourceClients.set(srcDb, await shared.connect(srcDb));
        const srcClient = sourceClients.get(srcDb);
        try {
          const { missing, oldCount, newCount } = await runFactQuery(srcClient, tgtClient, q);
          if (missing.length > 0) {
            failed = true;
            console.error(`[T4] FAIL: project=${proj.project_id} table=${q.table}: ${missing.length}/${oldCount} old-store fact(s) missing from staging (staging had ${newCount} rows).`);
          } else {
            console.log(`[T4] OK: project=${proj.project_id} table=${q.table}: ${oldCount} old-store fact(s) all present in staging.`);
          }
        } catch (err) {
          failed = true;
          console.error(`[T4] FAIL: project=${proj.project_id} table=${q.table}: query error: ${err.message}`);
        }
      }
    }
    for (const c of sourceClients.values()) await c.end();

    // Cross-project isolation.
    for (const iso of fixtures.isolation || []) {
      try {
        const { leaked, total } = await runIsolationCheck(tgtClient, iso);
        if (leaked.length > 0) {
          failed = true;
          console.error(`[T4] FAIL: isolation query for project_a=${iso.project_a} leaked ${leaked.length}/${total} row(s) from another project.`);
        } else {
          console.log(`[T4] OK: isolation query for project_a=${iso.project_a} returned ${total} row(s), all scoped correctly.`);
        }
      } catch (err) {
        failed = true;
        console.error(`[T4] FAIL: isolation query error for project_a=${iso.project_a}: ${err.message}`);
      }
    }
  } finally {
    await tgtClient.end();
  }
  process.exit(failed ? 1 : 0);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err && err.stack ? err.stack : err);
    process.exit(1);
  });
}

module.exports = {
  AUTHORED_BY,
  normalizeTuple,
  assertFixtureCoverageComplete,
  getManifestPairs,
  loadFixtures,
  resolveFixturePath,
  FIXTURE_ENV_VAR,
};
