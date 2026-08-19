'use strict';

const AUTHORED_BY = 'sonnet-cm194-196-197-199-author-2026-08-18';

/**
 * verify-15-t2-rowcount.js — T2, row-count reconciliation (§15.2, S2'+S3'
 * rewrite, cm#196+cm#197).
 *
 * REWRITE RATIONALE:
 *   - cm#196: Branch A compared each manifest row INDIVIDUALLY against a
 *     POOLED live count for its (targetTable, project_id_or_null) slice —
 *     when a slice is legitimately fed by multiple manifest rows (different
 *     source_dbs contributing to the same live bucket, e.g.
 *     "unmapped-orphan-memory-entry"), every contributing row failed except
 *     (at most) one, even though the rows sum EXACTLY to the live count.
 *   - cm#197: T2 audited every migration_manifest row unconditionally, with
 *     no reference to db-triage.json at all — a row from a disposable
 *     EPHEMERAL-DROP/ENGINE-INFRA-classified source_db (test-fixture
 *     leakage, verified live: claude_memory_eval_ci/test, adv175_*_corpus)
 *     FAILs T2 forever with no loud, correctable distinction between "real
 *     data problem" and "known-disposable bookkeeping."
 *   - Both rewrites share ONE fix underneath: `targetTableFor` used to
 *     resolve via `roster.find(e => e.source_table === sourceTable)` —
 *     SOURCE_TABLE ALONE, ignoring source_db. Two different source_dbs
 *     legitimately reusing the same source_table name is exactly the shape
 *     this battery's own multi-source evidence demonstrates is real; this
 *     rewrite resolves targetTable via shared.buildTargetTableByPairMap,
 *     keyed on the full (source_db, source_table) pair, loud FATAL at
 *     load-time on any pair mapping to conflicting targetTable values.
 *
 * FIVE PHASES (this file's own top-to-bottom structure mirrors these):
 *   Phase 1 — per-row total classification via shared.classifyManifestRow
 *     (the ONE shared helper also consumed by T0/T4/T9 — never a T2-local
 *     copy). retired_at IS NOT NULL rows skip first (one aggregate INFO
 *     line); net-new:/filesystem: source_db shapes are FATAL/roster-paired-
 *     RETAIN as classifyManifestRow defines; plain-db-name shapes reach
 *     db-triage.json (via --triage/env override,
 *     default scripts/migrations/db-triage.json — mirrors migrate-04/05's
 *     E-1/E-8 pattern, but NON-FATAL on a missing file: absence is its own
 *     total-classification outcome, UNTRIAGED, so T2's own CI fixtures
 *     (roster-paired, no triage file) still run green).
 *   Phase 2 — duplicate FATAL: two RETAINED, non-retired rows sharing the
 *     exact (source_db, source_table, project_id_or_null) triple is a data
 *     hygiene bug (a stale re-capture), never silently tolerated.
 *   Phase 3 — Branch A (project_id-scoped) / Branch B (no-column) row-count
 *     reconciliation, now summed per SLICE (Branch A: per
 *     (targetTable, project_id_or_null), across every contributing,
 *     RETAINED, non-excluded manifest row — cm#196's fix) and per TABLE
 *     (Branch B: shared.reconcileNoColumnTable's original per-
 *     (source_db,source_table)-pair shape, unchanged, but fed from the
 *     Phase-1-filtered retained set rather than a fresh unconditional
 *     query, so an EXCLUDE-BY-TRIAGE row can never silently re-enter a
 *     Branch B sum). Branch A additionally partitions each slice's
 *     contributing rows by source_table LABEL and recognizes the roster's
 *     new `manifest_label_duplicate_of` field: a label declaring itself a
 *     duplicate of another label within the SAME slice does not contribute
 *     to the slice's expected total (it would double-count real target
 *     rows already counted under the label it duplicates) but its own sum
 *     is cross-checked against that primary label's sum.
 *   Phase 5 — retirement is NOT re-implemented here (see
 *     cure-migration-manifest-retirement.js, run separately/out-of-band);
 *     this script only CONSUMES retired_at (Phase 1's first branch).
 *
 * Usage: node scripts/migrations/verify-15-t2-rowcount.js [--db <target>]
 *          [--triage <path>]
 * Exit codes: 0 = every slice's target count matches expected AND every
 * manifest row classifies without a phase-1 FAIL AND no phase-2 duplicate
 * triples, 1 = otherwise. A phase-1 FAIL on one row does not stop this
 * script from finishing every other check (see shared.classifyManifestRow's
 * FAIL-never-FATAL distinction); a phase-2 duplicate DOES stop the run
 * immediately (a genuine FATAL — the working set itself is untrustworthy
 * until resolved).
 */

const shared = require('./lib/verify15-shared');

function contributes(row) {
  return row.excludedReason !== null ? 0 : Number(row.rowCount);
}

/**
 * Phase 1: classify every raw migration_manifest row, log per this script's
 * own conventions, and return the RETAINED working set (every field
 * normalized to camelCase for the rest of this file). Every phase-1 FAIL
 * (never a script-halting FATAL — see shared.classifyManifestRow's own
 * header comment on that distinction) is fully enumerated, and the
 * offending row is excluded from `retained`, but classification of every
 * OTHER row still runs — this script only stops at the very end, after
 * every phase, if anything anywhere failed.
 */
function runPhase1(rawRows, ctx) {
  const retained = [];
  let retiredCount = 0;
  let failCount = 0;

  for (const row of rawRows) {
    const result = shared.classifyManifestRow(row, ctx);
    if (result.branch === 'RETIRED-SKIP') {
      retiredCount++;
      continue;
    }
    if (result.fail) {
      failCount++;
      console.error(`[T2] FAIL (phase 1, ${result.branch}): ${result.reason}`);
      continue;
    }
    if (result.warn) console.error(`[T2] WARN (phase 1, ${result.branch}): ${result.reason}`);
    if (result.info) console.log(`[T2] INFO (phase 1, ${result.branch}): ${result.reason}`);
    if (result.retain) {
      retained.push({
        id: row.id,
        sourceDb: row.source_db,
        sourceTable: row.source_table,
        projectIdOrNull: row.project_id_or_null,
        rowCount: row.row_count,
        excludedReason: row.excluded_reason,
      });
    }
  }
  if (retiredCount > 0) console.log(`[T2] INFO (phase 1): ${retiredCount} manifest row(s) retired -- skipped.`);
  return { retained, failCount };
}

/**
 * Phase 2: duplicate FATAL. Two retained, non-retired rows sharing the
 * exact (source_db, source_table, project_id_or_null) triple. Returns the
 * count of duplicate GROUPS found (0 = clean); every group is fully named.
 */
function runPhase2(retained) {
  const bySig = new Map();
  for (const row of retained) {
    const sig = JSON.stringify([row.sourceDb, row.sourceTable, row.projectIdOrNull]);
    if (!bySig.has(sig)) bySig.set(sig, []);
    bySig.get(sig).push(row);
  }
  let dupGroups = 0;
  for (const [sig, rows] of bySig) {
    if (rows.length > 1) {
      dupGroups++;
      const [sourceDb, sourceTable, projectIdOrNull] = JSON.parse(sig);
      console.error(`[T2] FATAL (phase 2): duplicate manifest rows for source_db="${sourceDb}" source_table="${sourceTable}" project_id_or_null=${projectIdOrNull ?? 'NULL'}: ids=[${rows.map((r) => r.id).join(', ')}] -- retire all but one via cure-migration-manifest-retirement.js before re-running T2.`);
    }
  }
  return dupGroups;
}

/** Branch B (no-column tables): sum every retained row for the pair, from the ALREADY-FILTERED in-memory set (never a fresh unconditional query). */
function reconcileNoColumnFromRetained(retained, sourceDb, sourceTable) {
  const rows = retained.filter((r) => r.sourceDb === sourceDb && r.sourceTable === sourceTable);
  const expected = rows.reduce((sum, r) => sum + contributes(r), 0);
  return { expected, manifestRowsConsidered: rows.length };
}

/**
 * Branch A (project_id-scoped): group retained rows by
 * (targetTable, project_id_or_null), partition each group by source_table
 * LABEL, recognize manifest_label_duplicate_of, compute one expected total
 * per group (additive families only), and cross-check every duplicate
 * family's own sum against its declared primary's sum.
 */
function computeBranchAGroups(retained, pairMap, roster, targetTablesWithProjectId) {
  // manifest_label_duplicate_of is a property of the SOURCE_TABLE LABEL
  // itself (e.g. "memory_entries_db_absorb" always duplicates
  // "memory_entries", regardless of which source_db captured it) -- keyed
  // by source_table ALONE, across every roster entry carrying that label
  // from any source_db. Entries agreeing (including entries that simply
  // don't set the field, defaulting to null/"not a duplicate") is fine;
  // disagreeing is a FATAL -- never silently pick one.
  const dupOfByLabel = new Map(); // source_table -> Set<string|null>
  for (const entry of roster) {
    const val = entry.manifest_label_duplicate_of ?? null;
    if (!dupOfByLabel.has(entry.source_table)) dupOfByLabel.set(entry.source_table, new Set());
    dupOfByLabel.get(entry.source_table).add(val);
  }
  const dupOfConflicts = [];
  const dupOfResolved = new Map(); // source_table -> value
  for (const [label, vals] of dupOfByLabel) {
    if (vals.size > 1) dupOfConflicts.push({ key: label, vals: [...vals] });
    else dupOfResolved.set(label, [...vals][0]);
  }

  const groups = new Map(); // JSON.stringify([targetTable, projectIdOrNull]) -> rows[]
  for (const row of retained) {
    const targetTable = shared.resolveTargetTableForPair(pairMap, row.sourceDb, row.sourceTable);
    if (!targetTable || !targetTablesWithProjectId.has(targetTable)) continue; // handled elsewhere (no-roster-entry FAIL, or Branch B)
    const key = JSON.stringify([targetTable, row.projectIdOrNull]);
    if (!groups.has(key)) groups.set(key, { targetTable, projectIdOrNull: row.projectIdOrNull, rows: [] });
    groups.get(key).rows.push(row);
  }

  return { groups: [...groups.values()], dupOfResolved, dupOfConflicts };
}

async function reconcileBranchAGroup(client, group, dupOfResolved) {
  const families = new Map(); // sourceTable label -> rows[]
  for (const row of group.rows) {
    if (!families.has(row.sourceTable)) families.set(row.sourceTable, []);
    families.get(row.sourceTable).push(row);
  }

  const errors = [];
  const warnings = [];
  let additiveSum = 0;

  for (const [label, rows] of families) {
    const dupOf = dupOfResolved.get(label) ?? null;
    if (dupOf === null) {
      additiveSum += rows.reduce((sum, r) => sum + contributes(r), 0);
    }
    const hasExcluded = rows.some((r) => r.excludedReason !== null);
    const hasNonExcluded = rows.some((r) => r.excludedReason === null);
    if (hasExcluded && hasNonExcluded) {
      warnings.push(`label="${label}": mixed excluded/non-excluded contributors within the same slice (ids=[${rows.map((r) => r.id).join(', ')}]) -- T9 contradiction: an exclusion should apply wholesale to a label, not partially.`);
    }
  }

  for (const [label, rows] of families) {
    const dupOf = dupOfResolved.get(label) ?? null;
    if (dupOf === null) continue;
    const dupSum = rows.reduce((sum, r) => sum + contributes(r), 0);
    const primaryRows = families.get(dupOf);
    if (!primaryRows) {
      errors.push(`label="${label}" declares manifest_label_duplicate_of="${dupOf}", but no "${dupOf}"-labeled row is present in this slice (targetTable="${group.targetTable}" project_id_or_null=${group.projectIdOrNull ?? 'NULL'}) to cross-check against.`);
      continue;
    }
    const primarySum = primaryRows.reduce((sum, r) => sum + contributes(r), 0);
    if (dupSum !== primarySum) {
      errors.push(`label="${label}" (duplicate of "${dupOf}"): sum=${dupSum} does not match primary label "${dupOf}" sum=${primarySum} (targetTable="${group.targetTable}" project_id_or_null=${group.projectIdOrNull ?? 'NULL'}).`);
    }
  }

  shared.assertSafeIdentifier(group.targetTable, 'Branch A targetTable');
  const { rows: liveRows } = await client.query(
    `SELECT COUNT(*) AS n FROM ${group.targetTable} WHERE ($1::text IS NULL AND project_id IS NULL) OR project_id = $1`,
    [group.projectIdOrNull]
  );
  const liveCount = Number(liveRows[0].n);

  return { ok: errors.length === 0 && liveCount === additiveSum, liveCount, expected: additiveSum, errors, warnings };
}

async function main() {
  const argv = process.argv.slice(2);
  const { name: target, source } = shared.resolveAndClassifyTargetDb(argv);
  console.log(`verify-15-t2-rowcount: target="${target}" (resolved from ${source})`);

  const roster = shared.loadRoster();
  const rosterPath = shared.resolveRosterPath();
  const { path: triagePath, databases: dbTriage } = shared.loadDbTriageForAudit(argv);
  console.log(`[T2] db-triage: ${dbTriage ? `loaded from "${triagePath}" (${dbTriage.size} classified db(s))` : `absent at "${triagePath}" -- every plain-db-name manifest row classifies UNTRIAGED`}`);

  const pairMap = shared.buildTargetTableByPairMap(roster, rosterPath);
  const rosterPairSet = shared.buildRosterPairSet(roster);

  const client = await shared.connect(target);
  let failed = false;
  try {
    await shared.applyDdl(client);

    const columnCache = await shared.crossCheckProjectIdScope(client, roster);
    const targetTablesWithProjectId = new Set([...columnCache.entries()].filter(([, has]) => has).map(([t]) => t));

    const { rows: manifestRows } = await client.query(
      `SELECT id, source_db, source_table, project_id_or_null, row_count, excluded_reason, retired_at FROM migration_manifest ORDER BY source_db, source_table, project_id_or_null, id`
    );
    if (manifestRows.length === 0) {
      console.error('[T2] FAIL: migration_manifest is empty — run T0/T1 first.');
      process.exit(1);
    }

    const { retained, failCount } = runPhase1(manifestRows, { dbTriage, rosterPairSet });
    if (failCount > 0) {
      failed = true;
      console.error(`[T2] ${failCount} manifest row(s) failed phase-1 classification (see FAIL lines above) -- excluded from reconciliation; every OTHER row still runs through phases 2+.`);
    }

    const dupGroups = runPhase2(retained);
    if (dupGroups > 0) {
      console.error(`[T2] FATAL: ${dupGroups} duplicate manifest group(s) found -- refusing to reconcile (see FATAL lines above).`);
      process.exit(1);
    }

    // No-roster-entry rows: reported once, up front, and excluded from
    // Branch A/B accounting below (nothing to reconcile against).
    const unresolved = retained.filter((r) => !shared.resolveTargetTableForPair(pairMap, r.sourceDb, r.sourceTable));
    for (const r of unresolved) {
      failed = true;
      console.error(`[T2] FAIL: source_db="${r.sourceDb}" source_table="${r.sourceTable}" project_id_or_null=${r.projectIdOrNull ?? 'NULL'}: no roster entry maps this (source_db, source_table) pair to a targetTable.`);
    }
    const resolvable = retained.filter((r) => shared.resolveTargetTableForPair(pairMap, r.sourceDb, r.sourceTable));

    // ── Branch B: no-project-id-column targets, one reconciliation per
    // (source_db, source_table) pair, summed over the retained set. ──
    const noColumnPairs = new Map(); // "source_db source_table" -> {sourceDb, sourceTable, targetTable}
    for (const r of resolvable) {
      const targetTable = shared.resolveTargetTableForPair(pairMap, r.sourceDb, r.sourceTable);
      if (targetTablesWithProjectId.has(targetTable)) continue;
      const key = JSON.stringify([r.sourceDb, r.sourceTable]);
      if (!noColumnPairs.has(key)) noColumnPairs.set(key, { sourceDb: r.sourceDb, sourceTable: r.sourceTable, targetTable });
    }
    for (const { sourceDb, sourceTable, targetTable } of noColumnPairs.values()) {
      const rowsForPair = resolvable.filter((r) => r.sourceDb === sourceDb && r.sourceTable === sourceTable);
      const excludedRows = rowsForPair.filter((r) => r.excludedReason !== null);
      if (excludedRows.length > 0) {
        console.error(`[T2] FATAL: targetTable="${targetTable}" (source_db="${sourceDb}" source_table="${sourceTable}") has no project_id column, but ${excludedRows.length} retained migration_manifest row(s) carry excluded_reason. A bare COUNT(*) over this table cannot subtract an excluded project's rows.`);
        process.exit(1);
      }
      const { expected, manifestRowsConsidered } = reconcileNoColumnFromRetained(resolvable, sourceDb, sourceTable);
      shared.assertSafeIdentifier(targetTable, 'Branch B targetTable');
      const { rows: cntRows } = await client.query(`SELECT COUNT(*) AS n FROM ${targetTable}`);
      const liveCount = Number(cntRows[0].n);
      const label = `${sourceTable} (-> ${targetTable}, no project_id column, ${manifestRowsConsidered} manifest row(s) summed)`;
      if (liveCount !== expected) {
        failed = true;
        console.error(`[T2] FAIL: ${label}: expected ${expected}, found ${liveCount}`);
      } else {
        console.log(`[T2] OK: ${label}: ${liveCount} rows`);
      }
    }

    // ── Branch A: project_id-scoped targets, one reconciliation per
    // (targetTable, project_id_or_null) slice, additive-family-summed. ──
    const { groups, dupOfResolved, dupOfConflicts } = computeBranchAGroups(resolvable, pairMap, roster, targetTablesWithProjectId);
    if (dupOfConflicts.length) {
      for (const c of dupOfConflicts) {
        console.error(`[T2] FATAL: roster has conflicting manifest_label_duplicate_of values for "${c.key}": ${c.vals.map((v) => JSON.stringify(v)).join(', ')}`);
      }
      process.exit(1);
    }
    for (const group of groups) {
      const result = await reconcileBranchAGroup(client, group, dupOfResolved);
      const label = `${group.targetTable} / project_id_or_null=${group.projectIdOrNull ?? 'NULL'}`;
      for (const w of result.warnings) console.error(`[T2] WARN: ${label}: ${w}`);
      if (result.errors.length) {
        failed = true;
        for (const e of result.errors) console.error(`[T2] FAIL: ${label}: ${e}`);
      }
      if (!result.ok && result.errors.length === 0) {
        failed = true;
        console.error(`[T2] FAIL: ${label}: expected ${result.expected}, found ${result.liveCount}`);
      } else if (result.errors.length === 0) {
        console.log(`[T2] OK: ${label}: ${result.liveCount} rows`);
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

module.exports = {
  AUTHORED_BY,
  contributes,
  runPhase1,
  runPhase2,
  reconcileNoColumnFromRetained,
  computeBranchAGroups,
  reconcileBranchAGroup,
};
