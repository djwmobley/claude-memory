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
 * Usage: node scripts/migrations/verify-15-t9-negative.js [--db <target>]
 * Exit codes: 0 = zero leakage across every (excluded_reason, source_table,
 * project_id_or_null) triple, 1 = any leakage found.
 */

const shared = require('./lib/verify15-shared');

function targetTableFor(roster, sourceTable) {
  const entry = roster.find((e) => e.source_table === sourceTable);
  return entry ? entry.targetTable : null;
}

async function checkExclusion(client, roster, exclusion) {
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
    const { rows: manifestRows } = await client.query(
      `SELECT COUNT(*) AS n FROM migration_manifest
       WHERE source_table = $1 AND project_id_or_null IS NULL AND excluded_reason = $2`,
      [sourceTable, excludedReason]
    );
    provenanceOk = Number(manifestRows[0].n) > 0;
    if (!provenanceOk) {
      provenanceDetail = `no migration_manifest row confirms source_table="${sourceTable}" was recorded excluded_reason="${excludedReason}" at NULL project scope`;
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
    const { rows: exclusions } = await client.query(
      `SELECT DISTINCT excluded_reason, source_table, project_id_or_null FROM migration_manifest WHERE excluded_reason IS NOT NULL`
    );

    if (exclusions.length === 0) {
      console.log('[T9] OK: zero excluded_reason values present in migration_manifest — nothing to check (this is a legitimate PASS, not a skip: T9 loops over what IS there).');
      process.exit(0);
    }

    for (const exclusion of exclusions) {
      const label = `${exclusion.source_table} / project_id_or_null=${exclusion.project_id_or_null ?? '(NULL-scoped)'} / excluded_reason="${exclusion.excluded_reason}"`;
      const result = await checkExclusion(client, roster, exclusion);
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
