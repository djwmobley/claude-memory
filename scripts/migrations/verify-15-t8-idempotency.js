'use strict';

const AUTHORED_BY = 'sonnet-t-battery-author-2026-07-27';

/**
 * verify-15-t8-idempotency.js — T8, idempotency (§15.2, closes A-12).
 *
 * Re-running a migrate-NN-*.js script a second time against
 * memory_manager_staging must produce zero net new/changed rows.
 *
 * Full-row hash, not load-bearing-columns-only (closes A-12): every column
 * is hashed EXCEPT an EXPLICIT, documented exemption list —
 * EXEMPT_COLUMNS below, containing EXACTLY 'embedding' (re-embedding
 * non-determinism across vLLM calls is an accepted design choice, stated
 * here rather than silently baked into a narrower column list; this
 * constant is never grown silently — any addition needs its own review).
 *
 * RE-RUNS T6 as its own last step (imports runReferentialIntegrity from
 * verify-15-t6-referential-integrity.js) — a cascade break (e.g. a script
 * that re-mints entities.id on a second run, orphaning edges) is a T8
 * failure even if every row's own hash is unchanged.
 *
 * NO child_process (this battery's subprocess usage is confined to
 * verify-15-acceptance.js only, per this repo's os-portability convention).
 * The "migrate-NN-*.js script under test" is supplied as a MODULE PATH
 * (--rerun-module <path>) exporting an async `run(targetDbName)` function,
 * which this script `require()`s and calls IN-PROCESS — the same pattern
 * migrate-01-canonical-db.js itself already uses (its logic is exported as
 * callable functions, not only a CLI entry point). Only
 * migrate-01-canonical-db.js (schema-only, no data rows) exists in this
 * repo as of this battery's authorship; the real data-migration scripts
 * (migrate-03 through migrate-13) are out of this task's scope and do not
 * yet export a `run()` shape to plug in here — see PR blind-spots.
 *
 * Usage:
 *   node scripts/migrations/verify-15-t8-idempotency.js --db <target> --rerun-module <path-to-js-module>
 * The module at <path> must export an async function `run(targetDbName)`.
 * Exit codes: 0 = zero net change AND T6 re-run clean AND run() resolved
 * truthy; 1 = any of those fail, or usage error.
 */

const crypto = require('crypto');
const path = require('path');
const shared = require('./lib/verify15-shared');
const { runReferentialIntegrity } = require('./verify-15-t6-referential-integrity');

// Never grown silently — see header comment.
const EXEMPT_COLUMNS = ['embedding'];

async function snapshotFullRowHashes(client, tables, exemptCols = EXEMPT_COLUMNS) {
  const snapshot = {};
  for (const table of tables) {
    const { rows: colRows } = await client.query(
      `SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = $1 ORDER BY ordinal_position`,
      [table]
    );
    const cols = colRows.map((r) => r.column_name).filter((c) => !exemptCols.includes(c));
    if (cols.length === 0) {
      snapshot[table] = { rowCount: 0, byId: {}, missingTable: true };
      continue;
    }
    const { rows } = await client.query(`SELECT ${cols.map((c) => `"${c}"`).join(', ')} FROM ${table}`);
    const byId = {};
    for (const r of rows) {
      const values = cols.map((c) => (r[c] === null || r[c] === undefined) ? shared.NULL_SENTINEL : r[c]);
      byId[r.id] = crypto.createHash('md5').update(JSON.stringify(values)).digest('hex');
    }
    snapshot[table] = { rowCount: rows.length, byId };
  }
  return snapshot;
}

function diffSnapshots(before, after) {
  const diffs = [];
  for (const table of Object.keys(before)) {
    const b = before[table];
    const a = after[table] || { rowCount: 0, byId: {} };
    if (b.rowCount !== a.rowCount) {
      diffs.push(`${table}: row_count changed ${b.rowCount} -> ${a.rowCount}`);
    }
    const idsB = Object.keys(b.byId);
    const idsA = Object.keys(a.byId);
    const newIds = idsA.filter((id) => !(id in b.byId));
    const missingIds = idsB.filter((id) => !(id in a.byId));
    const changedIds = idsB.filter((id) => (id in a.byId) && a.byId[id] !== b.byId[id]);
    if (newIds.length) diffs.push(`${table}: ${newIds.length} new row id(s) (${newIds.slice(0, 5).join(', ')})`);
    if (missingIds.length) diffs.push(`${table}: ${missingIds.length} missing row id(s) (${missingIds.slice(0, 5).join(', ')})`);
    if (changedIds.length) diffs.push(`${table}: ${changedIds.length} changed row(s) (${changedIds.slice(0, 5).join(', ')})`);
  }
  return diffs;
}

function parseRerunModule(argv) {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--rerun-module') return argv[i + 1];
    if (argv[i].startsWith('--rerun-module=')) return argv[i].slice('--rerun-module='.length);
  }
  return null;
}

async function main() {
  const argv = process.argv.slice(2);
  const rerunModulePath = parseRerunModule(argv);
  if (!rerunModulePath) {
    console.error('Usage: node scripts/migrations/verify-15-t8-idempotency.js --db <target> --rerun-module <path-to-js-module>');
    console.error('  The module must export an async run(targetDbName) function, called IN-PROCESS (no child_process).');
    process.exit(1);
  }

  const { name: target, source } = shared.resolveAndClassifyTargetDb(argv);
  console.log(`verify-15-t8-idempotency: target="${target}" (resolved from ${source})`);

  let rerunModule;
  try {
    rerunModule = require(path.resolve(rerunModulePath));
  } catch (err) {
    console.error(`FATAL: could not load --rerun-module "${rerunModulePath}": ${err.message}`);
    process.exit(1);
  }
  if (typeof rerunModule.run !== 'function') {
    console.error(`FATAL: --rerun-module "${rerunModulePath}" does not export a run(targetDbName) function.`);
    process.exit(1);
  }

  const roster = shared.loadRoster();
  const tables = [...new Set(roster.map((e) => e.targetTable))];

  const client = await shared.connect(target);
  let failed = false;
  try {
    await shared.applyDdl(client);

    const before = await snapshotFullRowHashes(client, tables);
    console.log(`[T8] before-snapshot: ${tables.length} table(s) hashed (exempt columns: ${EXEMPT_COLUMNS.join(', ')})`);

    let rerunOk = false;
    try {
      rerunOk = await rerunModule.run(target);
    } catch (err) {
      console.error(`[T8] FAIL: rerun-module run() threw: ${err.message}`);
    }
    if (!rerunOk) {
      failed = true;
      console.error('[T8] FAIL: rerun-module run() did not resolve truthy.');
    }

    const after = await snapshotFullRowHashes(client, tables);
    const diffs = diffSnapshots(before, after);
    if (diffs.length > 0) {
      failed = true;
      console.error(`[T8] FAIL: ${diffs.length} net-change diff(s) after re-run:`);
      for (const d of diffs) console.error(`  - ${d}`);
    } else {
      console.log('[T8] OK: zero net row change across all roster targetTables (full-row hash, exempting embedding).');
    }

    const t6Result = await runReferentialIntegrity(client, roster);
    if (!t6Result.pass) {
      failed = true;
      console.error(`[T8] FAIL: T6 re-run after idempotency check found issues: orphanEdges=${t6Result.orphanEdges}, orphanChunks=${t6Result.orphanChunks}, projectIdGaps=${t6Result.projectIdGaps.length}`);
    } else {
      console.log('[T8] OK: T6 re-run clean (zero orphans, full project_id coverage).');
    }
  } finally {
    await client.end();
  }
  process.exit(failed ? 1 : 0);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err && err.stack ? err.stack : err);
    process.exit(1);
  });
}

module.exports = { AUTHORED_BY, EXEMPT_COLUMNS, snapshotFullRowHashes, diffSnapshots, parseRerunModule };
