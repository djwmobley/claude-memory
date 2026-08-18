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
 * BF-1/BF-R1 (cm#187, 2026-08-18 spec-adversary pass): the above holds only
 * for a target table that ACTUALLY carries a project_id column. Live proof
 * a manifest row's project_id_or_null nullness is NOT a proxy for that
 * (migrate-verify-own-graph.js's migrateRetrievalEventAssertions writes a
 * NON-NULL project-scoped manifest row for retrieval_event_assertions, a
 * table with NO project_id column at all) — this script now total-classifies
 * every roster targetTable's shape via shared.crossCheckProjectIdScope
 * BEFORE any reconciliation begins (loud FATAL on any divergence between
 * that live-schema check and the roster's own requires_project_id_scope
 * flag — closes BF-5), then branches:
 *   - Branch A (target HAS project_id): today's per-slice scoped query,
 *     unchanged.
 *   - Branch B (target has NO project_id): reconciled ONCE per
 *     (source_db, source_table) pair — shared.reconcileNoColumnTable sums
 *     row_count over EVERY non-excluded manifest row for that pair
 *     (irrespective of project_id_or_null, since a no-column table has no
 *     notion of "slice") against ONE bare COUNT(*). A manifest row for a
 *     no-column table carrying excluded_reason IS NOT NULL is a loud FATAL
 *     (a bare COUNT(*) cannot subtract an excluded project's rows) — never
 *     silently ignored.
 * Manifest rows are grouped by (source_db, source_table) up front so a
 * no-column table's reconciliation runs exactly once per pair, never once
 * per manifest slice row (that repetition was the shape of the original
 * crash: the SAME unconditional project_id-referencing query, issued once
 * per manifest row, for a table that has no such column at all).
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

/**
 * Branch A: reconcile ONE manifest slice row against a target table KNOWN
 * (via the caller's crossCheckProjectIdScope classification) to carry a
 * project_id column. Behavior is BYTE-IDENTICAL to the pre-fix script for
 * every table that actually has the column.
 */
async function reconcileScopedRow(client, targetTable, row) {
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

    // BF-R1/BF-5: total-classify every roster targetTable's project_id
    // presence up front — loud FATAL on any divergence from the roster's
    // own requires_project_id_scope flag, BEFORE any reconciliation begins.
    const columnCache = await shared.crossCheckProjectIdScope(client, roster);

    const { rows: manifestRows } = await client.query(
      `SELECT source_db, source_table, project_id_or_null, row_count, excluded_reason FROM migration_manifest ORDER BY source_db, source_table, project_id_or_null`
    );
    if (manifestRows.length === 0) {
      console.error('[T2] FAIL: migration_manifest is empty — run T0/T1 first.');
      process.exit(1);
    }

    // Group by (source_db, source_table) — BF-R1: a no-column target table
    // is reconciled ONCE per pair, never once per manifest slice row.
    const groups = new Map();
    for (const row of manifestRows) {
      const key = JSON.stringify([row.source_db, row.source_table]);
      if (!groups.has(key)) groups.set(key, { sourceDb: row.source_db, sourceTable: row.source_table, rows: [] });
      groups.get(key).rows.push(row);
    }

    for (const { sourceDb, sourceTable, rows } of groups.values()) {
      const targetTable = targetTableFor(roster, sourceTable);
      if (!targetTable) {
        failed = true;
        for (const row of rows) {
          console.error(`[T2] FAIL: ${sourceTable} / project_id_or_null=${row.project_id_or_null ?? 'NULL'}: no roster entry maps source_table "${sourceTable}" to a targetTable`);
        }
        continue;
      }

      const hasProjectId = columnCache.has(targetTable)
        ? columnCache.get(targetTable)
        : await shared.tableHasColumn(client, targetTable, 'project_id');

      if (!hasProjectId) {
        // Branch B: reconcile the whole table ONCE.
        const result = await shared.reconcileNoColumnTable(client, targetTable, sourceDb, sourceTable);
        if (result.fatal) {
          console.error(`[T2] FATAL: ${result.reason}`);
          process.exit(1);
        }
        const label = `${sourceTable} (-> ${targetTable}, no project_id column, ${result.manifestRowsConsidered} manifest row(s) summed)`;
        if (!result.ok) {
          failed = true;
          console.error(`[T2] FAIL: ${label}: expected ${result.expected}, found ${result.liveCount}`);
        } else {
          console.log(`[T2] OK: ${label}: ${result.liveCount} rows`);
        }
        continue;
      }

      // Branch A: unchanged, per-slice scoped reconciliation.
      for (const row of rows) {
        const result = await reconcileScopedRow(client, targetTable, row);
        const label = `${sourceTable} / project_id_or_null=${row.project_id_or_null ?? 'NULL'}`;
        if (!result.ok) {
          failed = true;
          console.error(`[T2] FAIL: ${label} (-> ${result.targetTable}): expected ${result.expectedTargetRows}, found ${result.liveCount}`);
        } else {
          console.log(`[T2] OK: ${label} (-> ${result.targetTable}): ${result.liveCount} rows`);
        }
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

module.exports = { AUTHORED_BY, targetTableFor, reconcileScopedRow };
