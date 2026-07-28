'use strict';

const AUTHORED_BY = 'sonnet-t-battery-author-2026-07-27';

/**
 * verify-15-t2-rowcount.js — T2, row-count reconciliation (§15.2).
 *
 * Per (source_db, source_table, project_id_or_null) slice: target rows ==
 * expected surviving rows. Exclusions are counted EXPLICITLY from
 * migration_manifest.row_count (the per-slice scalar T1 already captured),
 * NEVER from COUNT(*) over migration_manifest rows itself (closes A-7 — the
 * original bug counted MANIFEST rows, always 0 or 1 per slice, instead of
 * the DATA rows the slice represents, producing a spurious FAIL on every
 * correctly-excluded slice).
 *
 * roster.json supplies the source_table -> targetTable mapping (never a
 * second hand-maintained map). The live count uses the SAME NULL-scoped
 * branch as T9's negative-test loop ($1 IS NULL AND project_id IS NULL) OR
 * project_id = $1) rather than a bare `project_id = $1`, for the identical
 * reason T9 documents: project_id = NULL is unknown/false for every row and
 * would silently no-op the NULL-scoped slice's comparison.
 *
 * Final pre-promotion re-run requirement (§15.1): this SAME script, run a
 * SECOND time immediately before promotion, is how that re-run is
 * satisfied — nothing about this script's behavior changes between the
 * first and second invocation; only WHEN it is run (before vs. immediately
 * before promotion) differs, per the runbook's own framing.
 *
 * Usage: node scripts/migrations/verify-15-t2-rowcount.js [--db <target>]
 * Exit codes: 0 = every slice's target count matches expected, 1 = any
 * mismatch or refused target.
 */

const shared = require('./lib/verify15-shared');

function targetTableFor(roster, sourceTable) {
  const entry = roster.find((e) => e.source_table === sourceTable);
  return entry ? entry.targetTable : null;
}

async function reconcileRow(client, row, roster) {
  const targetTable = targetTableFor(roster, row.source_table);
  if (!targetTable) {
    return { ok: false, reason: `no roster entry maps source_table "${row.source_table}" to a targetTable` };
  }
  const expectedTargetRows = row.excluded_reason !== null ? 0 : Number(row.row_count);
  const { rows } = await client.query(
    `SELECT COUNT(*) AS n FROM ${targetTable} WHERE ($1::text IS NULL AND project_id IS NULL) OR project_id = $1`,
    [row.project_id_or_null]
  );
  const liveCount = Number(rows[0].n);
  return {
    ok: liveCount === expectedTargetRows,
    targetTable,
    expectedTargetRows,
    liveCount,
  };
}

async function main() {
  const argv = process.argv.slice(2);
  const { name: target, source } = shared.resolveAndClassifyTargetDb(argv);
  console.log(`verify-15-t2-rowcount: target="${target}" (resolved from ${source})`);

  const roster = shared.loadRoster();
  const client = await shared.connect(target);
  let failed = false;
  try {
    await shared.applyDdl(client);
    const { rows: manifestRows } = await client.query(
      `SELECT source_db, source_table, project_id_or_null, row_count, excluded_reason FROM migration_manifest ORDER BY source_db, source_table, project_id_or_null`
    );
    if (manifestRows.length === 0) {
      console.error('[T2] FAIL: migration_manifest is empty — run T0/T1 first.');
      process.exit(1);
    }
    for (const row of manifestRows) {
      const result = await reconcileRow(client, row, roster);
      const label = `${row.source_table} / project_id_or_null=${row.project_id_or_null ?? 'NULL'}`;
      if (!result.ok) {
        failed = true;
        if (result.reason) {
          console.error(`[T2] FAIL: ${label}: ${result.reason}`);
        } else {
          console.error(`[T2] FAIL: ${label} (-> ${result.targetTable}): expected ${result.expectedTargetRows}, found ${result.liveCount}`);
        }
      } else {
        console.log(`[T2] OK: ${label} (-> ${result.targetTable}): ${result.liveCount} rows`);
      }
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

module.exports = { AUTHORED_BY, targetTableFor, reconcileRow };
