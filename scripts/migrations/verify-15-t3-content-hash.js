'use strict';

const AUTHORED_BY = 'sonnet-t-battery-author-2026-07-27';

/**
 * verify-15-t3-content-hash.js — T3, content-hash reconciliation (§15.2,
 * §15.3's reference implementation). The core "nothing lost" proof: row
 * counts can match while content differs; this hashes every source row's
 * load-bearing fields and confirms EVERY source hash is present in the
 * target, as a MULTISET (two identical-content source rows migrating to
 * only one target row is a FAIL, not a silent collapse — closes A-8).
 *
 * LOAD_BEARING_COLS is DERIVED from the roster at runtime (never a
 * hand-enumerated map — closes A-2): a roster entry with no loadBearingCols
 * mapping is a LOUD FAIL before any hashing starts (buildLoadBearingColsFromRoster,
 * shared lib).
 *
 * Hashing: NULL sentinel (never coalesce NULL/'' to the same string), no
 * .trim() (whitespace is not documented anywhere as never-load-bearing),
 * JSON.stringify of the column-VALUE ARRAY (not a delimiter-joined string,
 * so no value's own content can forge a tuple-boundary collision) — closes
 * A-9/A-10. Same rowHash()/hashTableMultiset() implementation shared with
 * T1 (source snapshot) and T3b (reverse containment).
 *
 * This script connects LIVE to each distinct SQL-shaped source_db present
 * in the roster and to the target, computing multisets fresh each run —
 * deliberately, not by reading the persisted migration_manifest_row_hashes
 * snapshot, so the SAME script satisfies both the initial T3 pass (§15.2)
 * AND §15.1's "final pre-promotion re-run against a FRESH live-source
 * snapshot" requirement without any special flag: run it once before
 * migration, run it again immediately before promotion, both are "T3."
 *
 * filesystem:-prefixed roster entries are skipped with an explicit WARN,
 * same documented scope boundary as T1 (migrate-08/09 don't exist yet in
 * this repo).
 *
 * Usage: node scripts/migrations/verify-15-t3-content-hash.js [--db <target>]
 * Exit codes: 0 = every source hash found in target (multiset-complete),
 * 1 = any multiset mismatch, refused target, or roster mapping gap.
 */

const shared = require('./lib/verify15-shared');

/** Group roster entries by source_db, dropping filesystem:-prefixed ones. */
function groupRosterBySourceDb(roster) {
  const bySource = new Map();
  const skipped = [];
  for (const entry of roster) {
    if (entry.source_db.startsWith('filesystem:')) {
      skipped.push(entry);
      continue;
    }
    if (!bySource.has(entry.source_db)) bySource.set(entry.source_db, []);
    bySource.get(entry.source_db).push(entry);
  }
  return { bySource, skipped };
}

async function main() {
  const argv = process.argv.slice(2);
  const { name: target, source } = shared.resolveAndClassifyTargetDb(argv);
  console.log(`verify-15-t3-content-hash: target="${target}" (resolved from ${source})`);

  const roster = shared.loadRoster();
  shared.buildLoadBearingColsFromRoster(roster); // fatal-on-gap validation, result unused here (per-source below)

  const { bySource, skipped } = groupRosterBySourceDb(roster);
  if (skipped.length) {
    console.log(`  [WARN] ${skipped.length} filesystem:-prefixed roster entr${skipped.length === 1 ? 'y' : 'ies'} skipped — markdown-source hashing (migrate-08/09) is out of this battery's cut.`);
  }
  if (bySource.size === 0) {
    console.error('[T3] FATAL: no SQL-shaped source_db entries found in the roster.');
    process.exit(1);
  }

  const tgtClient = await shared.connect(target);
  let failed = false;
  try {
    for (const [sourceDb, entries] of bySource) {
      let srcClient;
      try {
        srcClient = await shared.connect(sourceDb);
      } catch (err) {
        failed = true;
        console.error(`[T3] FAIL: could not connect to source_db "${sourceDb}": ${err.message}`);
        continue;
      }
      try {
        for (const entry of entries) {
          const cols = entry.loadBearingCols;
          let srcCounts, tgtCounts;
          try {
            srcCounts = await shared.hashTableMultiset(srcClient, entry.source_table, cols);
          } catch (err) {
            failed = true;
            console.error(`[T3] FAIL: ${sourceDb}.${entry.source_table}: source query error: ${err.message}`);
            continue;
          }
          try {
            tgtCounts = await shared.hashTableMultiset(tgtClient, entry.targetTable, cols);
          } catch (err) {
            failed = true;
            console.error(`[T3] FAIL: ${entry.targetTable}: target query error: ${err.message}`);
            continue;
          }

          let tableOk = true;
          for (const [hash, { count: srcCount, sample }] of srcCounts) {
            const tgtCount = (tgtCounts.get(hash) || { count: 0 }).count;
            if (tgtCount < srcCount) {
              failed = true;
              tableOk = false;
              console.error(`[T3] FAIL: ${entry.source_table} -> ${entry.targetTable}: hash ${hash} has ${srcCount} source rows but only ${tgtCount} target rows (multiset mismatch)`, JSON.stringify(sample));
            }
          }
          if (tableOk) {
            const total = [...srcCounts.values()].reduce((a, e) => a + e.count, 0);
            console.log(`[T3] OK: ${entry.source_table} -> ${entry.targetTable}: ${total} rows all matched (multiset)`);
          }
        }
      } finally {
        await srcClient.end();
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

module.exports = { AUTHORED_BY, groupRosterBySourceDb };
