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
 * Usage: node scripts/migrations/verify-15-t3b-reverse-containment.js [--db <target>]
 * Exit codes: 0 = zero unaccounted target rows in both directions, 1 =
 * any reverse-containment gap or unaccounted project_id found.
 */

const shared = require('./lib/verify15-shared');

async function reverseContainment(client) {
  const { rows } = await client.query(`
    SELECT target_hash, target_table, project_id
    FROM memory_manager_staging_row_hashes t
    WHERE NOT EXISTS (
      SELECT 1 FROM migration_manifest_row_hashes m
      WHERE m.source_hash = t.target_hash
    )
  `);
  return rows;
}

/**
 * Total-rowcount reconciliation across ALL target project_ids — UNION ALL
 * over every roster targetTable (roster-driven, never a hand-enumerated
 * table list), anti-joined against migration_manifest.
 */
async function totalRowcountReconciliation(client, roster) {
  const targetTables = [...new Set(roster.map((e) => e.targetTable))];
  if (targetTables.length === 0) return [];

  const unionSql = targetTables
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
  return rows;
}

async function main() {
  const argv = process.argv.slice(2);
  const { name: target, source } = shared.resolveAndClassifyTargetDb(argv);
  console.log(`verify-15-t3b-reverse-containment: target="${target}" (resolved from ${source})`);

  const roster = shared.loadRoster();
  const client = await shared.connect(target);
  let failed = false;
  try {
    await shared.applyDdl(client);

    const reverseGaps = await reverseContainment(client);
    if (reverseGaps.length > 0) {
      failed = true;
      console.error(`[T3b] FAIL: ${reverseGaps.length} target row(s) with no source counterpart (reverse containment gap):`);
      for (const r of reverseGaps.slice(0, 20)) console.error(`  - ${r.target_table} project_id=${r.project_id} target_hash=${r.target_hash}`);
      if (reverseGaps.length > 20) console.error(`  ... and ${reverseGaps.length - 20} more`);
    } else {
      console.log('[T3b] OK: reverse containment holds — every target row has a matching source hash.');
    }

    const unaccounted = await totalRowcountReconciliation(client, roster);
    if (unaccounted.length > 0) {
      failed = true;
      console.error(`[T3b] FAIL: ${unaccounted.length} target project_id(s) with rows unaccounted for in migration_manifest:`);
      for (const r of unaccounted) console.error(`  - project_id=${r.project_id}: ${r.unaccounted_rows} unaccounted row(s)`);
    } else {
      console.log('[T3b] OK: every target project_id is accounted for in migration_manifest.');
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

module.exports = { AUTHORED_BY, reverseContainment, totalRowcountReconciliation };
