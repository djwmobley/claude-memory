'use strict';

const AUTHORED_BY = 'sonnet-t-battery-author-2026-07-27';

/**
 * verify-15-t0-roster.js — T0, roster totality (§15.2, closes A-1).
 *
 * Independent source-of-truth check: every (source_db, source_table) pair in
 * scripts/migrations/source-table-roster.json MUST have at least one
 * migration_manifest row. A roster entry with ZERO manifest rows is a FAIL —
 * even a genuinely EMPTY source table still gets a migration_manifest row
 * with row_count = 0 once T1 snapshots it; only a table NEVER snapshotted at
 * all trips T0. This closes the self-referential-coverage hazard where
 * T1-T9 all key off migration_manifest's own contents: a table that never
 * gets a migrate-NN-*.js script pointed at it is invisible to every
 * downstream check unless something OUTSIDE migration_manifest itself names
 * it as in-scope.
 *
 * NOT EXISTS anti-join (never NOT IN — see this codebase's canon on the
 * NULL-poisoning trap; this particular query has no nullable column on
 * either side of the join, but the anti-join form is used uniformly across
 * this battery for consistency and to never establish a NOT IN precedent
 * a future edit could copy into a nullable context).
 *
 * Usage: node scripts/migrations/verify-15-t0-roster.js [--db <target>]
 * Exit codes: 0 = PASS, 1 = FAIL or refused target.
 */

const shared = require('./lib/verify15-shared');

async function main() {
  const argv = process.argv.slice(2);
  const { name: target, source } = shared.resolveAndClassifyTargetDb(argv);
  console.log(`verify-15-t0-roster: target="${target}" (resolved from ${source})`);

  const roster = shared.loadRoster();
  const client = await shared.connect(target);
  let failed = false;
  try {
    await shared.applyDdl(client);

    await client.query('BEGIN');
    await client.query('CREATE TEMP TABLE roster_t0 (source_db TEXT NOT NULL, source_table TEXT NOT NULL) ON COMMIT DROP');
    for (const entry of roster) {
      await client.query('INSERT INTO roster_t0 (source_db, source_table) VALUES ($1, $2)', [entry.source_db, entry.source_table]);
    }
    const { rows } = await client.query(`
      SELECT r.source_db, r.source_table
      FROM roster_t0 r
      WHERE NOT EXISTS (
        SELECT 1 FROM migration_manifest m
        WHERE m.source_db = r.source_db AND m.source_table = r.source_table
      )
      ORDER BY r.source_db, r.source_table
    `);
    await client.query('COMMIT');

    if (rows.length) {
      failed = true;
      console.error(`[T0] FAIL: ${rows.length} roster entr${rows.length === 1 ? 'y has' : 'ies have'} zero migration_manifest rows:`);
      for (const r of rows) console.error(`  - ${r.source_db} / ${r.source_table}`);
    } else {
      console.log(`[T0] OK: all ${roster.length} roster entries have >=1 migration_manifest row.`);
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

module.exports = { AUTHORED_BY };
