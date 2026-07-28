'use strict';

const AUTHORED_BY = 'sonnet-t-battery-author-2026-07-27';

/**
 * verify-15-t5-embedding-coverage.js — T5, embedding coverage +
 * dimensionality (§15.2).
 *
 * Every row with content-bearing text has a non-null vector of the correct
 * type (halfvec). Zero rows left at legacy vector(1024).
 *
 * Table list is ROSTER-GENERATED (closes A-5): filtered to entries where
 * hasContentBearingText === true, using each entry's embeddingCol (default
 * 'embedding') and contentCol — never a hand-maintained table list that can
 * silently drift from the roster.
 *
 * Usage: node scripts/migrations/verify-15-t5-embedding-coverage.js [--db <target>]
 * Exit codes: 0 = every content-bearing table has zero unembedded rows and
 * zero legacy-typed rows, 1 = any gap or refused target.
 */

const shared = require('./lib/verify15-shared');

async function checkTable(client, { targetTable, embeddingCol = 'embedding', contentCol }) {
  if (!contentCol) {
    return { ok: false, reason: `roster entry for "${targetTable}" has hasContentBearingText=true but no contentCol declared` };
  }
  const { rows: unembeddedRows } = await client.query(
    `SELECT COUNT(*) AS n FROM ${targetTable}
     WHERE ${embeddingCol} IS NULL AND length(trim(coalesce(${contentCol}, ''))) > 0`
  );
  const unembedded = Number(unembeddedRows[0].n);

  const { rows: typeRows } = await client.query(
    `SELECT format_type(a.atttypid, a.atttypmod) AS coltype
       FROM pg_attribute a
       JOIN pg_class c ON a.attrelid = c.oid
       JOIN pg_namespace n ON c.relnamespace = n.oid
      WHERE n.nspname = current_schema() AND c.relname = $1 AND a.attname = $2
        AND a.attnum > 0 AND NOT a.attisdropped`,
    [targetTable, embeddingCol]
  );
  const colType = typeRows.length ? typeRows[0].coltype : null;
  const isHalfvec = colType !== null && colType.startsWith('halfvec');

  let legacyCount = 0;
  if (colType !== null) {
    const { rows: legacyRows } = await client.query(
      `SELECT COUNT(*) AS n FROM ${targetTable}
       WHERE ${embeddingCol} IS NOT NULL AND pg_typeof(${embeddingCol})::text <> 'halfvec'`
    );
    legacyCount = Number(legacyRows[0].n);
  }

  return {
    ok: unembedded === 0 && isHalfvec && legacyCount === 0,
    unembedded,
    colType,
    isHalfvec,
    legacyCount,
  };
}

async function main() {
  const argv = process.argv.slice(2);
  const { name: target, source } = shared.resolveAndClassifyTargetDb(argv);
  console.log(`verify-15-t5-embedding-coverage: target="${target}" (resolved from ${source})`);

  const roster = shared.loadRoster();
  const contentBearing = roster.filter((e) => e.hasContentBearingText === true);
  if (contentBearing.length === 0) {
    console.error('[T5] FATAL: roster has zero entries with hasContentBearingText=true — nothing to check.');
    process.exit(1);
  }

  const client = await shared.connect(target);
  let failed = false;
  try {
    const seen = new Set();
    for (const entry of contentBearing) {
      const key = entry.targetTable;
      if (seen.has(key)) continue; // roster may list the same targetTable via multiple source_tables
      seen.add(key);
      let result;
      try {
        result = await checkTable(client, entry);
      } catch (err) {
        failed = true;
        console.error(`[T5] FAIL: ${entry.targetTable}: query error: ${err.message}`);
        continue;
      }
      if (result.reason) {
        failed = true;
        console.error(`[T5] FAIL: ${entry.targetTable}: ${result.reason}`);
        continue;
      }
      if (!result.ok) {
        failed = true;
        console.error(`[T5] FAIL: ${entry.targetTable}: unembedded=${result.unembedded}, embeddingCol type=${result.colType ?? 'ABSENT'}, legacy vector(1024) rows=${result.legacyCount}`);
      } else {
        console.log(`[T5] OK: ${entry.targetTable}: 0 unembedded, type=${result.colType}, 0 legacy rows`);
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

module.exports = { AUTHORED_BY, checkTable };
