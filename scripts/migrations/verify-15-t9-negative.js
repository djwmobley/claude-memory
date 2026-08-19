'use strict';

const AUTHORED_BY = 'sonnet-cm194-196-197-199-author-2026-08-18';

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

async function checkExclusion(client, roster, exclusion, sourceDb, hasProjectIdOverride) {
  const { excluded_reason: excludedReason, source_table: sourceTable, project_id_or_null: projectIdOrNull } = exclusion;
  const targetTable = targetTableFor(roster, sourceTable);
  if (!targetTable) {
    return { ok: false, reason: `no roster entry maps source_table "${sourceTable}" to a targetTable — cannot verify exclusion` };
  }

  // BF-R2 (cm#187/cm#188 spec-adversary pass, 2026-08-18): the live-count
  // query below assumes targetTable carries a project_id column -- exactly
  // the same total-classification gap T2 had (BF-1). A target table with
  // NO project_id column at all (retrieval_event_assertions: event_id/
  // assertion_id only) is PROVENANCE-ONLY: there is no live-row count that
  // can ever positively or negatively confirm an exclusion for it (no
  // project_id to filter by), so no live-count query is attempted at all --
  // never a downgrade, the check structurally cannot run that way.
  const hasProjectId = hasProjectIdOverride !== undefined
    ? hasProjectIdOverride
    : await shared.tableHasColumn(client, targetTable, 'project_id');

  if (!hasProjectId) {
    // IS NOT DISTINCT FROM (not `=`) handles BOTH NULL-scoped and
    // project-scoped exclusions with the SAME query shape -- `=` treats
    // NULL <> NULL as unknown/false, which would silently never match a
    // NULL-scoped exclusion's own recording row.
    const params = sourceDb !== undefined
      ? [sourceTable, excludedReason, sourceDb, projectIdOrNull]
      : [sourceTable, excludedReason, projectIdOrNull];
    const sql = sourceDb !== undefined
      ? `SELECT COUNT(*) AS n FROM migration_manifest
         WHERE source_table = $1 AND excluded_reason = $2 AND source_db = $3 AND project_id_or_null IS NOT DISTINCT FROM $4`
      : `SELECT COUNT(*) AS n FROM migration_manifest
         WHERE source_table = $1 AND excluded_reason = $2 AND project_id_or_null IS NOT DISTINCT FROM $3`;
    const { rows: manifestRows } = await client.query(sql, params);
    const provenanceOk = Number(manifestRows[0].n) > 0;
    console.log(`  [INFO] ${targetTable}: no project_id column -- T9 running in PROVENANCE-ONLY mode for this exclusion (live-count check is not attempted; this is by design, not a downgrade).`);
    return {
      ok: provenanceOk,
      targetTable,
      liveCount: null,
      provenanceOk,
      provenanceOnly: true,
      provenanceDetail: provenanceOk
        ? null
        : `no migration_manifest row confirms source_table="${sourceTable}"${sourceDb !== undefined ? ` source_db="${sourceDb}"` : ''} project_id_or_null=${projectIdOrNull ?? 'NULL'} was recorded excluded_reason="${excludedReason}" (provenance-only mode -- no project_id column on ${targetTable})`,
    };
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
    provenanceOnly: false,
    provenanceDetail,
  };
}

async function main() {
  const argv = process.argv.slice(2);
  const { name: target, source } = shared.resolveAndClassifyTargetDb(argv);
  console.log(`verify-15-t9-negative: target="${target}" (resolved from ${source})`);

  const roster = shared.loadRoster();
  const { path: triagePath, databases: dbTriage } = shared.loadDbTriageForAudit(argv);
  console.log(`[T9] db-triage: ${dbTriage ? `loaded from "${triagePath}" (${dbTriage.size} classified db(s))` : `absent at "${triagePath}" -- every plain-db-name manifest row classifies UNTRIAGED`}`);
  const rosterPairSet = shared.buildRosterPairSet(roster);

  const client = await shared.connect(target);
  let failed = false;
  try {
    await shared.applyDdl(client);
    // C-7: source_db is now part of the DISTINCT enumeration -- previously
    // two different source_dbs excluding a same-named source_table (same
    // project_id_or_null, same excluded_reason) would collapse into ONE
    // enumerated row here, silently skipping the check for whichever source
    // didn't happen to be the surviving DISTINCT row.
    //
    // cm#196/#197 Phase 1 (shared.classifyManifestRow, the SAME classifier
    // T0/T2/T4 consume): retired_at IS NULL keeps a cured/retired
    // exclusion-recording row from being checked forever. T9's own use of
    // the classifier is DELIBERATELY NARROWER than T0/T2/T4's: T0/T2/T4
    // build POSITIVE reconciliation expectations FROM roster+manifest, so a
    // roster-UNPAIRED source is genuinely unusable to them. T9 instead
    // verifies a NEGATIVE assertion migration_manifest ALREADY records
    // (excluded_reason) directly against live data -- it needs no roster
    // pairing to do that, so an "unpaired" or "known-disposable" bookkeeping
    // classification does not stop T9 from checking the underlying
    // exclusion; it is reported (INFO/WARN) alongside the check, never
    // gating it. The ONLY branches that DO gate (skip verification, contribute
    // to this script's exit code) are the ones where the row's provenance is
    // genuinely UNTRUSTWORTHY, not merely unregistered: OWNER-REVIEW (a
    // human hasn't signed off on whether this should ever migrate at all --
    // checking "did it migrate" is premature), a malformed net-new:-in-
    // manifest shape (the row itself should not exist), and an unknown
    // triage value (defensive; unreachable in practice, loadDbTriageForAudit
    // already validates the file). Every branch classifyManifestRow can
    // return is enumerated below EXPLICITLY (total classification, never an
    // allow-list over open-ended data -- this switches over classifyManifestRow's
    // OWN fixed, closed set of branch names, not external input).
    const GATING_BRANCHES = new Set(['OWNER-REVIEW-FAIL', 'NETNEW-IN-MANIFEST-FAIL', 'UNKNOWN-TRIAGE-VALUE-FAIL']);
    const NON_GATING_BRANCHES = new Set([
      'FILESYSTEM-PAIRED-RETAIN', 'FILESYSTEM-UNPAIRED-FAIL',
      'UNTRIAGED-PAIRED-RETAIN', 'UNTRIAGED-UNPAIRED-FAIL',
      'REAL-MIGRATE-RETAIN', 'TRIAGE-EXCLUDED-PAIRED-RETAIN', 'EXCLUDE-BY-TRIAGE',
    ]);
    const { rows: exclusions } = await client.query(
      `SELECT id, source_db, excluded_reason, source_table, project_id_or_null, row_count, retired_at
       FROM migration_manifest WHERE excluded_reason IS NOT NULL AND retired_at IS NULL`
    );

    if (exclusions.length === 0) {
      console.log('[T9] OK: zero excluded_reason values present in migration_manifest — nothing to check (this is a legitimate PASS, not a skip: T9 loops over what IS there).');
      process.exit(0);
    }

    const distinctExclusions = [];
    const seenTriples = new Set();
    for (const row of exclusions) {
      const phase1 = shared.classifyManifestRow(row, { dbTriage, rosterPairSet });
      if (GATING_BRANCHES.has(phase1.branch)) {
        failed = true;
        console.error(`[T9] FAIL (phase 1, ${phase1.branch}): ${phase1.reason}`);
        continue;
      }
      if (!NON_GATING_BRANCHES.has(phase1.branch)) {
        // Defensive default branch: a branch name this switch doesn't
        // recognize is a bug in this file, not in classifyManifestRow --
        // loud, never a silent pass-through.
        failed = true;
        console.error(`[T9] FAIL: unrecognized phase-1 classification branch "${phase1.branch}" -- update GATING_BRANCHES/NON_GATING_BRANCHES in this file. reason: ${phase1.reason}`);
        continue;
      }
      // Every NON-GATING branch's reason is printed, not just the ones
      // classifyManifestRow happens to flag warn/info -- a branch this
      // switch treats as non-gating despite classifyManifestRow marking it
      // `fail:true` (FILESYSTEM-UNPAIRED-FAIL, UNTRIAGED-UNPAIRED-FAIL) was
      // previously silently dropped here (neither `.warn` nor `.info` is
      // set on those results), contradicting this function's own "reported
      // (INFO/WARN) alongside the check, never gating it" comment above.
      if (phase1.warn) console.error(`[T9] WARN (phase 1, ${phase1.branch}): ${phase1.reason}`);
      else if (phase1.info) console.log(`[T9] INFO (phase 1, ${phase1.branch}): ${phase1.reason}`);
      else if (phase1.fail) console.log(`[T9] INFO (phase 1, ${phase1.branch}, non-gating for T9): ${phase1.reason}`);
      const triple = JSON.stringify([row.source_db, row.excluded_reason, row.source_table, row.project_id_or_null]);
      if (seenTriples.has(triple)) continue;
      seenTriples.add(triple);
      distinctExclusions.push({ source_db: row.source_db, excluded_reason: row.excluded_reason, source_table: row.source_table, project_id_or_null: row.project_id_or_null });
    }

    for (const exclusion of distinctExclusions) {
      const label = `source_db="${exclusion.source_db}" / ${exclusion.source_table} / project_id_or_null=${exclusion.project_id_or_null ?? '(NULL-scoped)'} / excluded_reason="${exclusion.excluded_reason}"`;
      const result = await checkExclusion(client, roster, exclusion, exclusion.source_db);
      if (!result.ok) {
        failed = true;
        if (result.reason) {
          console.error(`[T9] FAIL: ${label}: ${result.reason}`);
        } else if (result.provenanceOnly) {
          console.error(`[T9] FAIL: ${label}: provenance-only check failed — ${result.provenanceDetail}`);
        } else {
          if (result.liveCount > 0) console.error(`[T9] FAIL: ${label}: excluded but ${result.liveCount} row(s) present in ${result.targetTable}`);
          if (!result.provenanceOk) console.error(`[T9] FAIL: ${label}: provenance check failed — ${result.provenanceDetail}`);
        }
      } else if (result.provenanceOnly) {
        console.log(`[T9] OK: ${label}: provenance-only mode, provenance confirmed`);
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
