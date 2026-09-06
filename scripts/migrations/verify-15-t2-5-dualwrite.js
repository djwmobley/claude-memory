'use strict';

const AUTHORED_BY = 'sonnet-t-battery-author-2026-07-27';

/**
 * verify-15-t2-5-dualwrite.js — T2.5, dual-write shim reconciliation
 * (§15.2, closes B2). Conditional-mandatory: this script EXISTS and RUNS
 * ALWAYS, regardless of whether the optional dual-write shim (§15.1) was
 * ever adopted. If dual_write_shim_window has zero rows, it prints an
 * explicit N/A line and exits 0 — never omitted, since an omitted line and
 * a forgotten one look identical on the page. If it has ANY row, this
 * becomes a MANDATORY hard blocker, equal in weight to T2/T3.
 *
 * NOT EXISTS, not NOT IN (closes the T2.5 residual of the V-2/T3b class): a
 * plain `old_hash NOT IN (SELECT target_hash FROM
 * memory_manager_staging_row_hashes)` is poisoned by the SAME
 * three-valued-logic trap if target_hash ever contained a single NULL —
 * covered by BOTH belts here: the anti-join form below, AND
 * memory_manager_staging_row_hashes.target_hash / old_store_row_hashes.old_hash
 * are both declared NOT NULL in the shared DDL (verify15-shared.js).
 *
 * Usage: node scripts/migrations/verify-15-t2-5-dualwrite.js [--db <target>]
 * Exit codes: 0 = N/A or zero-row reconciliation, 1 = shim-drift found or
 * refused target.
 */

const shared = require('./lib/verify15-shared');

async function main() {
  const argv = process.argv.slice(2);
  const { name: target, source } = await shared.resolveAndClassifyTargetDb(argv);
  console.log(`verify-15-t2-5-dualwrite: target="${target}" (resolved from ${source})`);

  const client = await shared.connect(target);
  let failed = false;
  try {
    await shared.applyDdl(client);

    const { rows: windowRows } = await client.query('SELECT COUNT(*) AS n FROM dual_write_shim_window');
    const windowCount = Number(windowRows[0].n);

    if (windowCount === 0) {
      console.log('[T2.5] N/A — dual_write_shim_window has zero rows (shim was never adopted for this run).');
      process.exit(0);
    }

    console.log(`[T2.5] MANDATORY — dual_write_shim_window has ${windowCount} row(s); shim was adopted, reconciliation is a hard blocker.`);

    const { rows: driftRows } = await client.query(`
      SELECT old_hash FROM old_store_row_hashes o
      WHERE EXISTS (
              SELECT 1 FROM dual_write_shim_window w
              WHERE o.written_at >= w.enabled_at AND o.written_at <= COALESCE(w.disabled_at, NOW())
            )
        AND NOT EXISTS (
              SELECT 1 FROM memory_manager_staging_row_hashes t
              WHERE t.target_hash = o.old_hash
            )
    `);

    if (driftRows.length > 0) {
      failed = true;
      console.error(`[T2.5] FAIL: ${driftRows.length} old-store row(s) written during a shim-active window have no matching staging-side hash (shim drift):`);
      for (const r of driftRows.slice(0, 20)) console.error(`  - old_hash=${r.old_hash}`);
      if (driftRows.length > 20) console.error(`  ... and ${driftRows.length - 20} more`);
    } else {
      console.log('[T2.5] OK: zero shim-drift rows found.');
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
