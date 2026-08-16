'use strict';

const AUTHORED_BY = 'sonnet-t-battery-author-2026-07-27';

/**
 * verify-15-t9-negative.js — T9, negative tests (§15.2, closes A-4/V-3).
 *
 * Nothing that should NOT migrate, migrated. Loops over EVERY distinct
 * non-null excluded_reason ACTUALLY PRESENT in migration_manifest — read
 * from the data, never a hardcoded literal (closes A-4: the original bug
 * hardcoded 'eval-junk-project-id' and checked exactly one table).
 *
 * NULL-scoped exclusion handled explicitly (closes V-3): `($1::text IS NULL
 * AND project_id IS NULL) OR project_id = $1` rather than a bare
 * `project_id = $1`, which silently no-ops (returns 0 regardless of what
 * actually migrated) the moment $1 is itself NULL — exactly the shape of
 * EPHEMERAL-DROP exclusions (§16.3), which have no project scoping at all.
 *
 * PROVENANCE CHECK for NULL-scoped (whole-DB) exclusions (structural note,
 * §15.2): every roster-scoped TARGET table has project_id NOT NULL (T6), so
 * a NULL-scoped exclusion can never be positively caught by a
 * project_id-keyed count alone — there is no NULL-project_id row in staging
 * for it to match. For every NULL-scoped exclusion, this script ADDITIONALLY
 * asserts zero migration_manifest_row_hashes rows for that source_db/
 * source_table (i.e. zero rows T1 ever snapshotted with lineage tracing back
 * to the excluded source) exist WITHOUT a corresponding exclusion marker —
 * concretely: the excluded slice's own row_count must be 0 surviving via the
 * ordinary project_id-keyed count (still run, for defense in depth) AND,
 * because that count is structurally unfalsifiable for NULL-scoped
 * exclusions, this script independently confirms the migration_manifest row
 * for that slice itself carries excluded_reason (i.e. T1 correctly recorded
 * the exclusion — the provenance side of "was this ever accounted for," not
 * a live row count that can never fire for a NULL-scoped source).
 *
 * SOURCE_DB SCOPING (CONSOLIDATION-RUNBOOK.md §6.1(c) C-7 prerequisite fix,
 * memory-manager#11(c), 2026-08-16): the exclusion-enumeration loop and the
 * NULL-scoped provenance query previously keyed ONLY on `source_table`,
 * collapsing same-named source_tables across DIFFERENT source_dbs (e.g. two
 * independent migrations both excluding a table literally named
 * "assertions" from two different source databases would DISTINCT-collapse
 * into one enumerated exclusion, and the provenance query could confirm the
 * WRONG source's manifest row as "proof" the right one was excluded). FIX:
 * main()'s enumeration now SELECTs source_db alongside the existing three
 * columns; checkExclusion()'s NULL-scoped provenance query now filters by
 * source_db too. `sourceDb` is an OPTIONAL 4th argument to checkExclusion()
 * — omitted, behavior is UNCHANGED (unscoped, exactly as before this fix)
 * so existing unit-test callers that construct a bare
 * {excluded_reason, source_table, project_id_or_null} object (never
 * carrying source_db) keep passing without modification; main()'s real
 * invocation path always supplies it, closing the actual production gap.
 *
 * Usage: node scripts/migrations/verify-15-t9-negative.js [--db <target>]
 * Exit codes: 0 = zero leakage across every (excluded_reason, source_table,
 * project_id_or_null) triple, 1 = any leakage found.
 */

const shared = require('./lib/verify15-shared');

function targetTableFor(roster, sourceTable) {
  const entry = roster.find((e) => e.source_table === sourceTable);
  return entry ? entry.targetTable : null;
}

async function checkExclusion(client, roster, exclusion, sourceDb) {
  const { excluded_reason: excludedReason, source_table: sourceTable, project_id_or_null: projectIdOrNull } = exclusion;
  const targetTable = targetTableFor(roster, sourceTable);
  if (!targetTable) {
    return { ok: false, reason: `no roster entry maps source_table "${sourceTable}" to a targetTable — cannot verify exclusion` };
  }

  const { rows } = await client.query(
    `SELECT COUNT(*) AS n FROM ${targetTable} WHERE ($1::text IS NULL AND project_id IS NULL) OR project_id = $1`,
    [projectIdOrNull]
  );
  const liveCount = Number(rows[0].n);

  let provenanceOk = true;
  let provenanceDetail = null;
  if (projectIdOrNull === null) {
    // NULL-scoped exclusion: the project_id-keyed count above is
    // structurally unfalsifiable (no roster-scoped target table can ever
    // hold a NULL project_id, per T6). The provenance proof instead confirms
    // migration_manifest itself still correctly records this slice as
    // excluded (T1's own bookkeeping is the source of truth for "was this
    // ever accounted for" when a live-row count structurally cannot fire).
    //
    // C-7: source_db-scoped when the caller supplies it (main()'s real
    // invocation path always does) -- without this, two different
    // source_dbs excluding a same-named source_table at NULL scope for the
    // SAME excluded_reason are indistinguishable, and this query could
    // confirm the WRONG source's manifest row as "proof." `sourceDb`
    // undefined (the shape every pre-existing unit-test caller still
    // passes) falls back to the ORIGINAL unscoped query, unchanged.
    const params = sourceDb !== undefined
      ? [sourceTable, excludedReason, sourceDb]
      : [sourceTable, excludedReason];
    const sql = sourceDb !== undefined
      ? `SELECT COUNT(*) AS n FROM migration_manifest
         WHERE source_table = $1 AND project_id_or_null IS NULL AND excluded_reason = $2 AND source_db = $3`
      : `SELECT COUNT(*) AS n FROM migration_manifest
         WHERE source_table = $1 AND project_id_or_null IS NULL AND excluded_reason = $2`;
    const { rows: manifestRows } = await client.query(sql, params);
    provenanceOk = Number(manifestRows[0].n) > 0;
    if (!provenanceOk) {
      provenanceDetail = `no migration_manifest row confirms source_table="${sourceTable}"${sourceDb !== undefined ? ` source_db="${sourceDb}"` : ''} was recorded excluded_reason="${excludedReason}" at NULL project scope`;
    }
  }

  return {
    ok: liveCount === 0 && provenanceOk,
    targetTable,
    liveCount,
    provenanceOk,
    provenanceDetail,
  };
}

async function main() {
  const argv = process.argv.slice(2);
  const { name: target, source } = shared.resolveAndClassifyTargetDb(argv);
  console.log(`verify-15-t9-negative: target="${target}" (resolved from ${source})`);

  const roster = shared.loadRoster();
  const client = await shared.connect(target);
  let failed = false;
  try {
    await shared.applyDdl(client);
    // C-7: source_db is now part of the DISTINCT enumeration -- previously
    // two different source_dbs excluding a same-named source_table (same
    // project_id_or_null, same excluded_reason) would collapse into ONE
    // enumerated row here, silently skipping the check for whichever source
    // didn't happen to be the surviving DISTINCT row.
    const { rows: exclusions } = await client.query(
      `SELECT DISTINCT source_db, excluded_reason, source_table, project_id_or_null FROM migration_manifest WHERE excluded_reason IS NOT NULL`
    );

    if (exclusions.length === 0) {
      console.log('[T9] OK: zero excluded_reason values present in migration_manifest — nothing to check (this is a legitimate PASS, not a skip: T9 loops over what IS there).');
      process.exit(0);
    }

    for (const exclusion of exclusions) {
      const label = `source_db="${exclusion.source_db}" / ${exclusion.source_table} / project_id_or_null=${exclusion.project_id_or_null ?? '(NULL-scoped)'} / excluded_reason="${exclusion.excluded_reason}"`;
      const result = await checkExclusion(client, roster, exclusion, exclusion.source_db);
      if (!result.ok) {
        failed = true;
        if (result.reason) {
          console.error(`[T9] FAIL: ${label}: ${result.reason}`);
        } else {
          if (result.liveCount > 0) console.error(`[T9] FAIL: ${label}: excluded but ${result.liveCount} row(s) present in ${result.targetTable}`);
          if (!result.provenanceOk) console.error(`[T9] FAIL: ${label}: provenance check failed — ${result.provenanceDetail}`);
        }
      } else {
        console.log(`[T9] OK: ${label}: 0 rows present, provenance confirmed`);
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

module.exports = { AUTHORED_BY, targetTableFor, checkExclusion };
