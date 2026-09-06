'use strict';

const AUTHORED_BY = 'sonnet-t-battery-author-2026-07-27';

/**
 * verify-15-t3b-reverse-containment.js — T3b, reverse containment
 * (target ⊆ source) + total-rowcount reconciliation across ALL target
 * project_ids (§15.2, closes A-3).
 *
 * T3 proves every SOURCE row survived. It says nothing about the reverse: a
 * fabricated or duplicated TARGET row with no source counterpart —
 * especially one filed under a project_id that never appears in
 * migration_manifest at all — escapes T3 entirely. T3b closes both halves.
 *
 * Reverse containment reads the TWO PERSISTED hash tables
 * (migration_manifest_row_hashes.source_hash, written by T1 at snapshot
 * time; memory_manager_staging_row_hashes.target_hash, written by whatever
 * wrote the staging row) rather than live-querying source again — this is
 * the DATA-INTEGRITY direction T3's live-query reference implementation
 * does not cover (T3 proves source rows landed; T3b proves nothing EXTRA
 * landed). NOT EXISTS, never NOT IN, on both queries below — both hash
 * columns are also declared NOT NULL in the shared DDL, so this check is
 * covered by both belts against the V-2 NULL-poisoning trap.
 *
 * SOURCELESS (net-new:) ROSTER ENTRIES — total classification, not a
 * silent inclusion (fix for the PR #152 review finding, extended here from
 * T3 to T3b). §9/§17/§18's net-new tables (routing_profiles, turn_usage,
 * agent_exchange, …) have NO migration source: migration_manifest NEVER
 * gets a row for them (T1 never snapshots one), by design. Both of T3b's
 * checks would otherwise be PERMANENTLY, SPURIOUSLY broken by real
 * net-new-table data the instant it exists:
 *   - totalRowcountReconciliation's project_id-based anti-join: a real
 *     row in e.g. routing_profiles can never anti-join to a
 *     migration_manifest row for its project_id (none exists for a
 *     net-new table, by definition) — it would read as "unaccounted"
 *     forever, which is the WRONG classification for a row that was never
 *     supposed to have migration lineage in the first place. This is the
 *     SAME bug shape T2's A-7 finding closed one level down (conflating
 *     "correctly has no matching manifest slice" with "leaked/unaccounted
 *     data") — closed here by EXCLUDING sourceless targetTables from the
 *     UNION ALL entirely, with an explicit log line naming them.
 *   - reverseContainment's hash anti-join: nothing in THIS repo populates
 *     memory_manager_staging_row_hashes for net-new tables today (only
 *     the migrate-NN-*.js data-migration scripts, out of this task's
 *     scope, would call shared.hashAndStoreStagingRows on a SOURCED
 *     table's writes) — so this is currently a LATENT rather than active
 *     bug. Excluded here anyway, for the identical reason and by the same
 *     mechanism, so a future extension that hashes ALL target writes
 *     uniformly (not just migrated ones) does not silently re-introduce
 *     the T2/A-7 bug shape one layer up.
 *
 * TARGET-SIDE SURPLUS CLOSURE ARGUMENT (cm#198 fix, applies to BOTH T3's
 * branch (a) and branch (b) -- retrieval_event_assertions): T3b's job
 * (this script) is proving nothing EXTRA landed; T3's forward-containment
 * job (either branch) is proving every source row survived WITH ITS
 * CONTENT INTACT. Neither script alone closes the loop against a
 * same-COUNT content SWAP (a target row whose count matches but whose
 * content silently changed): T3b's total-rowcount reconciliation only
 * counts rows, so a swap is invisible to it; T3's forward-containment
 * (this run's mapped/hashed multiset, in either branch) is what catches a
 * swap, because the swapped row's hash no longer appears in the source
 * (or lineage-translated) multiset at the expected count. The two checks
 * are deliberately complementary, run together, never substitutes for one
 * another.
 *
 * Usage: node scripts/migrations/verify-15-t3b-reverse-containment.js [--db <target>]
 * Exit codes: 0 = zero unaccounted target rows in both directions, 1 =
 * any reverse-containment gap or unaccounted project_id found.
 */

const shared = require('./lib/verify15-shared');

/** Distinct targetTable names for SOURCELESS (net-new:) roster entries —
 * shared by both of T3b's checks below. */
function sourcelessTargetTables(roster) {
  const { sourceless } = shared.partitionRoster(roster);
  return [...new Set(sourceless.map((e) => e.targetTable))];
}

async function reverseContainment(client, roster) {
  const excludeTables = sourcelessTargetTables(roster);
  let sql = `
    SELECT target_hash, target_table, project_id
    FROM memory_manager_staging_row_hashes t
    WHERE NOT EXISTS (
      SELECT 1 FROM migration_manifest_row_hashes m
      WHERE m.source_hash = t.target_hash
    )`;
  const params = [];
  if (excludeTables.length > 0) {
    sql += ` AND NOT EXISTS (SELECT 1 FROM unnest($1::text[]) AS ex(tbl) WHERE ex.tbl = t.target_table)`;
    params.push(excludeTables);
  }
  const { rows } = await client.query(sql, params);
  return rows;
}

/**
 * Total-rowcount reconciliation across ALL target project_ids — UNION ALL
 * over every SOURCED roster targetTable (roster-driven, never a
 * hand-enumerated table list), anti-joined against migration_manifest.
 * SOURCELESS (net-new:) targetTables are excluded — see header comment.
 *
 * BF-R4 (cm#187 spec-adversary pass, 2026-08-18): `SELECT project_id FROM
 * ${t}` assumes every SOURCED targetTable carries a project_id column — the
 * same total-classification gap T2 had (BF-1). Sourced targetTables are now
 * partitioned via the SAME cached tableHasColumn check T2 uses
 * (`columnCache`, produced by shared.crossCheckProjectIdScope at the
 * caller's startup): has-column tables keep the UNION ALL anti-join
 * unchanged; no-column tables are excluded from it (loudly logged, never
 * silently dropped) and instead separately reconciled via
 * shared.reconcileNoColumnTable, per roster entry, so they stay VISIBLE to
 * T3b rather than falling out of scope entirely.
 */
async function totalRowcountReconciliation(client, roster, columnCache) {
  const { sourced } = shared.partitionRoster(roster);
  if (sourced.length === 0) return { unaccounted: [], noColumnResults: [], noColumnTables: [] };

  const hasColumnTables = [];
  const noColumnEntries = [];
  const seenHasColumnTargets = new Set();
  for (const entry of sourced) {
    const hasColumn = columnCache.has(entry.targetTable)
      ? columnCache.get(entry.targetTable)
      : await shared.tableHasColumn(client, entry.targetTable, 'project_id');
    columnCache.set(entry.targetTable, hasColumn);
    if (hasColumn) {
      if (!seenHasColumnTargets.has(entry.targetTable)) {
        hasColumnTables.push(entry.targetTable);
        seenHasColumnTargets.add(entry.targetTable);
      }
    } else {
      noColumnEntries.push(entry);
    }
  }

  let unaccounted = [];
  if (hasColumnTables.length > 0) {
    const unionSql = hasColumnTables
      .map((t) => `SELECT project_id FROM ${t}`)
      .join('\nUNION ALL\n');

    const { rows } = await client.query(`
      SELECT staging.project_id, COUNT(*) AS unaccounted_rows
      FROM (${unionSql}) staging
      WHERE NOT EXISTS (
        SELECT 1 FROM migration_manifest m
        WHERE m.project_id_or_null = staging.project_id
      )
      GROUP BY staging.project_id
    `);
    unaccounted = rows;
  }

  const noColumnResults = [];
  for (const entry of noColumnEntries) {
    const result = await shared.reconcileNoColumnTable(client, entry.targetTable, entry.source_db, entry.source_table);
    noColumnResults.push({ entry, result });
  }

  return {
    unaccounted,
    noColumnResults,
    noColumnTables: [...new Set(noColumnEntries.map((e) => e.targetTable))],
  };
}

async function main() {
  const argv = process.argv.slice(2);
  const { name: target, source } = await shared.resolveAndClassifyTargetDb(argv);
  console.log(`verify-15-t3b-reverse-containment: target="${target}" (resolved from ${source})`);

  const roster = shared.loadRoster();
  const excludeTables = sourcelessTargetTables(roster);
  if (excludeTables.length) {
    console.log(`[T3b] ${excludeTables.length} SOURCELESS (net-new:) targetTable(s) excluded from both checks below — no migration lineage exists or ever will for these: ${excludeTables.join(', ')}`);
  }

  const client = await shared.connect(target);
  let failed = false;
  try {
    await shared.applyDdl(client);

    // BF-R4/BF-5: same startup total-classification T2 runs -- loud FATAL
    // on any divergence between live schema and the roster's own
    // requires_project_id_scope flag, before either check below runs. The
    // resulting cache is reused by totalRowcountReconciliation's partition.
    const columnCache = await shared.crossCheckProjectIdScope(client, roster);

    const reverseGaps = await reverseContainment(client, roster);
    if (reverseGaps.length > 0) {
      failed = true;
      console.error(`[T3b] FAIL: ${reverseGaps.length} target row(s) with no source counterpart (reverse containment gap):`);
      for (const r of reverseGaps.slice(0, 20)) console.error(`  - ${r.target_table} project_id=${r.project_id} target_hash=${r.target_hash}`);
      if (reverseGaps.length > 20) console.error(`  ... and ${reverseGaps.length - 20} more`);
    } else {
      console.log('[T3b] OK: reverse containment holds — every target row has a matching source hash.');
    }

    const { unaccounted, noColumnResults, noColumnTables } = await totalRowcountReconciliation(client, roster, columnCache);
    if (noColumnTables.length) {
      console.log(`[T3b] ${noColumnTables.length} sourced targetTable(s) excluded from the project_id anti-join (no project_id column) — reconciled separately below: ${noColumnTables.join(', ')}`);
    }
    if (unaccounted.length > 0) {
      failed = true;
      console.error(`[T3b] FAIL: ${unaccounted.length} target project_id(s) with rows unaccounted for in migration_manifest:`);
      for (const r of unaccounted) console.error(`  - project_id=${r.project_id}: ${r.unaccounted_rows} unaccounted row(s)`);
    } else {
      console.log('[T3b] OK: every target project_id is accounted for in migration_manifest.');
    }

    for (const { entry, result } of noColumnResults) {
      if (result.fatal) {
        console.error(`[T3b] FATAL: ${result.reason}`);
        process.exit(1);
      }
      const label = `${entry.targetTable} (source_table="${entry.source_table}", no project_id column, ${result.manifestRowsConsidered} manifest row(s) summed)`;
      if (!result.ok) {
        failed = true;
        console.error(`[T3b] FAIL: ${label}: expected ${result.expected}, found ${result.liveCount}`);
      } else {
        console.log(`[T3b] OK: ${label}: ${result.liveCount} rows`);
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

module.exports = { AUTHORED_BY, reverseContainment, totalRowcountReconciliation, sourcelessTargetTables };
