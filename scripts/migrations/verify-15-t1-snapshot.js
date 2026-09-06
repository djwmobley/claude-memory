'use strict';

const AUTHORED_BY = 'sonnet-t-battery-author-2026-07-27';

/**
 * verify-15-t1-snapshot.js — T1, per-source snapshot (§15.2).
 *
 * Before touching any source, captures authoritative row counts + a
 * content fingerprint per (source_db, source_table, project_id_or_null)
 * slice into migration_manifest, plus a per-row hash into
 * migration_manifest_row_hashes (the table T3/T3b's live comparisons and
 * T9's provenance check both read).
 *
 * Scope of this cut: SQL-shaped sources only (source_db is a real database
 * name). filesystem:-prefixed roster entries (markdown sources, §6.1(h)/(i))
 * are SKIPPED here with an explicit, non-silent WARN — migrate-08/09, the
 * scripts that would actually read those files, do not exist yet in this
 * repo (out of this task's scope). This is a documented, known gap, not a
 * silent omission — see this script's blind-spot note in the PR body.
 *
 * content_fingerprint is a T8-ONLY field (closes A-11, §15.2's own note).
 * Because it's an order-DEPENDENT aggregate over source row ids, it is
 * USELESS for any source-vs-target comparison (target ids are re-minted on
 * migration) — its only consumer is T8's idempotency check, where the SAME
 * staging database's ids are stable across a before/after re-run. It is
 * computed here as md5(concat(per-row rowHash ordered by source row id)),
 * using the SAME rowHash() algorithm (NULL sentinel, JSON.stringify of the
 * value array, no .trim()) as migration_manifest_row_hashes.source_hash and
 * T3's live comparison — a deliberate, documented implementation choice:
 * the spec's own SQL sketch (md5(string_agg(md5(coalesce(col,'')),'' ORDER
 * BY id))) is functionally equivalent for this field's ONLY real use
 * (same-DB before/after idempotency diff) as long as the SAME formula is
 * used both times, which it always is here.
 *
 * Usage:
 *   node scripts/migrations/verify-15-t1-snapshot.js --source-db <name> [--db <target>] [--excluded-reason <text>]
 * Exit codes: 0 = every matching roster entry snapshotted, 1 = refused /
 * error / no matching roster entries found for --source-db.
 */

const crypto = require('crypto');
const shared = require('./lib/verify15-shared');

function parseArgs(argv) {
  const parsed = { excludedReason: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--excluded-reason') parsed.excludedReason = argv[++i];
    else if (argv[i].startsWith('--excluded-reason=')) parsed.excludedReason = argv[i].slice('--excluded-reason='.length);
  }
  return parsed;
}

// tableHasColumn used to be defined locally here (this script introduced the
// pattern first, for the SOURCE side); it now lives in lib/verify15-shared.js
// so T2/T3/T3b/T6/T9 (the TARGET side, cm#187/cm#188) share the SAME
// implementation rather than each re-declaring it. Re-exported below for
// backward compatibility with any external caller that imported it from
// this module specifically.
const tableHasColumn = shared.tableHasColumn;

function computeContentFingerprint(rowsOrderedById, cols) {
  const concatenated = rowsOrderedById.map((r) => shared.rowHash(cols, r)).join('');
  return crypto.createHash('md5').update(concatenated).digest('hex');
}

/**
 * Snapshot one roster entry: fetch every row (id, project_id if present,
 * load-bearing cols) from the source table, group by project_id (or a
 * single NULL-scoped slice if the table has no project_id column), write one
 * migration_manifest row per slice plus one migration_manifest_row_hashes
 * row per source row.
 */
async function snapshotEntry(srcClient, tgtClient, entry, excludedReason) {
  const hasProjectId = await tableHasColumn(srcClient, entry.source_table, 'project_id');
  const cols = entry.loadBearingCols;
  const selectCols = ['id', ...(hasProjectId ? ['project_id'] : []), ...cols].filter((c, i, a) => a.indexOf(c) === i);
  const { rows } = await srcClient.query(`SELECT ${selectCols.map((c) => `"${c}"`).join(', ')} FROM ${entry.source_table} ORDER BY id`);

  const slices = new Map(); // project_id_or_null -> rows[]
  for (const r of rows) {
    const key = hasProjectId ? (r.project_id === null || r.project_id === undefined ? null : r.project_id) : null;
    if (!slices.has(key)) slices.set(key, []);
    slices.get(key).push(r);
  }
  if (slices.size === 0) slices.set(null, []); // empty table still gets ONE row_count=0 manifest row

  const results = [];
  for (const [projectIdOrNull, sliceRows] of slices) {
    const fingerprint = computeContentFingerprint(sliceRows, cols);
    const { rows: mRows } = await tgtClient.query(
      `INSERT INTO migration_manifest (source_db, source_table, project_id_or_null, row_count, content_fingerprint, excluded_reason)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [entry.source_db, entry.source_table, projectIdOrNull, sliceRows.length, fingerprint, excludedReason]
    );
    for (const r of sliceRows) {
      const h = shared.rowHash(cols, r);
      await tgtClient.query(
        `INSERT INTO migration_manifest_row_hashes (source_db, source_table, project_id_or_null, source_row_id, source_hash)
         VALUES ($1,$2,$3,$4,$5)`,
        [entry.source_db, entry.source_table, projectIdOrNull, String(r.id), h]
      );
    }
    results.push({ manifestId: mRows[0].id, projectIdOrNull, rowCount: sliceRows.length });
  }
  return results;
}

/** Peek at the raw --source-db / SOURCE_DB value BEFORE regex validation, so
 * a net-new:-prefixed value gets the specific "sourceless, nothing to
 * snapshot" message instead of falling through to
 * resolveAndClassifySourceDb's generic "invalid identifier" regex refusal
 * (a net-new: value contains a colon, which the DB-name regex would reject
 * anyway — but with a less specific, more confusing message than this
 * dedicated check gives).
 */
function peekRawSourceDb(argv) {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--source-db') return argv[i + 1];
    if (argv[i].startsWith('--source-db=')) return argv[i].slice('--source-db='.length);
  }
  return process.env.SOURCE_DB || null;
}

async function main() {
  const argv = process.argv.slice(2);
  const { excludedReason } = parseArgs(argv);
  const { name: target, source: targetSource } = await shared.resolveAndClassifyTargetDb(argv);

  const rawSourceDb = peekRawSourceDb(argv);
  if (rawSourceDb && rawSourceDb.startsWith(shared.NET_NEW_PREFIX)) {
    console.error(`FATAL: --source-db "${rawSourceDb}" is a SOURCELESS (net-new:) roster source — there is nothing to snapshot.`);
    console.error('  net-new: entries have no migration source by classification (see scripts/migrations/lib/verify15-shared.js');
    console.error('  classifyRosterSourceDb) — T1 never applies to them. See verify-15-t0-roster.js for how they are covered instead.');
    process.exit(1);
  }

  const sourceDb = shared.resolveAndClassifySourceDb(argv);

  if (!sourceDb) {
    console.error('Usage: node scripts/migrations/verify-15-t1-snapshot.js --source-db <name> [--db <target>] [--excluded-reason <text>]');
    console.error('  --source-db is required (or SOURCE_DB env var) — T1 snapshots exactly ONE source at a time.');
    process.exit(1);
  }

  const roster = shared.loadRoster();
  const sqlEntries = roster.filter((e) => e.source_db === sourceDb && !e.source_db.startsWith('filesystem:') && !e.manifest_label_duplicate_of);
  const skippedFilesystemEntries = roster.filter((e) => e.source_db === sourceDb && e.source_db.startsWith('filesystem:'));
  // cm#210 fix (A-1/A-3): a label-duplicate entry's source_table is a
  // manifest-bookkeeping LABEL, not a physical relation -- snapshotting it
  // here (interpolating the label as a table name) would either crash
  // ("relation does not exist," T1's own instance of A-1) or, worse, if a
  // decoy relation happens to exist under that name (A-4), write a SECOND,
  // duplicate migration_manifest row for the same underlying rows the
  // primary label already snapshots -- exactly the T2 phase-2 duplicate
  // FATAL this field exists to prevent. Skipped here with an explicit WARN,
  // counted as neither pass nor fail (spec 2.1.2).
  const skippedLabelDuplicateEntries = roster.filter((e) => e.source_db === sourceDb && !e.source_db.startsWith('filesystem:') && e.manifest_label_duplicate_of);

  if (sqlEntries.length === 0 && skippedFilesystemEntries.length === 0 && skippedLabelDuplicateEntries.length === 0) {
    console.error(`FATAL: no roster entries found with source_db="${sourceDb}".`);
    process.exit(1);
  }

  console.log(`verify-15-t1-snapshot: source_db="${sourceDb}", target="${target}" (resolved from ${targetSource})`);
  if (skippedFilesystemEntries.length) {
    console.log(`  [WARN] ${skippedFilesystemEntries.length} filesystem:-prefixed roster entr${skippedFilesystemEntries.length === 1 ? 'y' : 'ies'} skipped — markdown-source snapshotting (migrate-08/09) is out of this battery's cut. NOT counted as a pass.`);
  }
  if (skippedLabelDuplicateEntries.length) {
    console.log(`  [WARN] ${skippedLabelDuplicateEntries.length} label-duplicate roster entr${skippedLabelDuplicateEntries.length === 1 ? 'y' : 'ies'} skipped — label-duplicate entry — its physical table is snapshotted under the primary label; snapshotting here would double-write manifest rows. Counts as neither pass nor fail:`);
    for (const e of skippedLabelDuplicateEntries) {
      console.log(`    - ${e.source_table} (duplicates "${e.manifest_label_duplicate_of}")`);
    }
  }

  const srcClient = await shared.connect(sourceDb);
  const tgtClient = await shared.connect(target);
  let failed = false;
  try {
    await shared.applyDdl(tgtClient);
    for (const entry of sqlEntries) {
      try {
        const results = await snapshotEntry(srcClient, tgtClient, entry, excludedReason);
        for (const r of results) {
          console.log(`  [OK] ${entry.source_table} project_id_or_null=${r.projectIdOrNull ?? 'NULL'} row_count=${r.rowCount} manifest_id=${r.manifestId}`);
        }
      } catch (err) {
        failed = true;
        console.error(`  [FAIL] ${entry.source_table}: ${err.message}`);
      }
    }
  } finally {
    await srcClient.end();
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

module.exports = { AUTHORED_BY, snapshotEntry, computeContentFingerprint, tableHasColumn };
