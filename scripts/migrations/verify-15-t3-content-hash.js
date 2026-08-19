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
 * EXCLUSION-AWARE SCOPING (fix for the PR #152 review finding — the
 * runbook's own §15.3 reference implementation had this same gap, amended
 * in parallel). T3's forward-containment proof is "every source row that
 * was SUPPOSED to migrate, survived" — it is NOT "every row that ever
 * existed in the source table, regardless of T9's deliberate exclusions,
 * survived." Before hashing a source table, this script loads that table's
 * recorded exclusions from migration_manifest (excluded_reason IS NOT
 * NULL, via shared.loadExclusionsFor):
 *   - a NULL-scoped (whole-DB) exclusion takes the ENTIRE (source_db,
 *     source_table) pair OUT of T3's forward scope entirely — an explicit
 *     SKIP log line is printed, never silent; leakage detection for that
 *     case remains T9's provenance check (§15.2's own structural note: a
 *     roster-scoped TARGET table can never hold project_id IS NULL, so a
 *     live source-vs-target hash comparison structurally cannot prove
 *     anything about a whole-DB exclusion either way — T9 already owns
 *     this proof via migration_manifest provenance, not T3);
 *   - project-scoped exclusions filter THOSE projects' rows out of the
 *     source-side multiset only (shared.hashTableMultisetExcludingProjects,
 *     NOT EXISTS against unnest($1::text[]) — never NOT IN), with an
 *     explicit per-slice log line naming the row count and excluded_reason.
 * T3b (reverse containment, target⊆source) is UNCHANGED by this fix —
 * excluded rows' hashes being present in migration_manifest_row_hashes
 * (T1 snapshots ALL rows, excluded or not) does not create any EXTRA
 * target-side row for T3b to flag; T3b only ever flags target rows with NO
 * matching source hash, and excluded rows never migrate, so they are
 * simply absent from the target-side multiset T3b scans. No change needed.
 *
 * LINEAGE-MAPPED COLUMNS -- BRANCH (b) (cm#198 fix). Branch (a) above hashes
 * RAW column values on both sides -- correct ONLY when a load-bearing
 * column's value is preserved byte-for-byte from source to target. Some
 * load-bearing columns are SURROGATE ids renumbered at migration time
 * (retrieval_event_assertions.event_id/assertion_id -- see
 * migrate-verify-own-graph.js's own_graph_migration_ids lineage table): the
 * source id space and target id space are structurally disjoint, so
 * hashing raw values produces a guaranteed 0-match total mismatch no matter
 * how healthy the migration is (cm#198's diagnosed root cause: source
 * assertions id 1 migrated to target id 1187; hashing "1" against "1187"
 * can never match). A roster entry OPTS IN to branch (b) by declaring BOTH
 * lineageMappedCols and lineageMembership (validated at roster-load time by
 * shared.validateLineageDeclarations -- see verify15-shared.js); an entry
 * with neither field takes branch (a), completely unchanged.
 *
 * Branch (b)'s five-way per-source-row classification (MAPPED /
 * lineage-inconsistency-FATAL / EXCLUDED-PARENT / LIVE-PARENT-DRIFT /
 * decode-failure-FATAL), the mapped-vs-manifest ANCHOR fatal check, and the
 * --allow-live-drift default-fail policy are implemented in
 * runLineageBranch() below -- see that function's own header comment for
 * the full algorithm. This is a STRUCTURAL split, not a strengthening of
 * branch (a): branch (a) is deliberately left ALONE (see the "branch
 * asymmetry" note further down) because giving raw-value hashing its own
 * drift-exclusion logic would silently defeat forward containment's whole
 * point for tables where the SOURCE VALUE really is supposed to survive
 * unchanged.
 *
 * BRANCH ASYMMETRY (disclosed, not a bug): after this fix,
 * retrieval_event_assertions (branch (b)) reports a correctly-classified
 * drift FAIL instead of a structurally-guaranteed 0-match FAIL. The OTHER
 * own-graph tables (assertions, retrieval_events, edges, entities, …) stay
 * on branch (a) and will STILL fail T3 on a staging DB with live-source
 * drift (the same live-source drift this issue diagnosed for
 * retrieval_event_assertions also exists for its sibling tables — they were
 * simply never checked, because T3 was 0/2930-failing loudly enough on this
 * table first). This is INTENTIONAL and CORRECT: branch (a)'s raw-value
 * hash is the right tool for tables whose load-bearing columns are content,
 * not surrogate ids, and MUST NOT gain drift-exclusion — doing so would
 * silently let a genuinely lost/never-migrated row escape forward
 * containment by reclassifying it as "excluded" or "drift" without the
 * translated-id proof branch (b) requires. Remaining reds on those tables
 * after this PR are genuine pending re-migration work, not a T3 defect.
 * T3b's own header comment carries the matching closure-argument note (T3b
 * count-anchor + T3 forward-content together close the loop; a same-count
 * content swap is caught by T3's mapped-tuple miss, not by T3b alone).
 *
 * SOURCELESS (net-new:) ROSTER ENTRIES have no source to hash at all — T3's
 * whole PREMISE (a source-side multiset compared to a target-side one)
 * does not apply. groupRosterBySourceDb partitions these out explicitly
 * (never lets one become a "source_db" T3 tries to connect() to, which
 * would just surface as a confusing connection-refused FAIL); this
 * script's main loop prints one SKIP line per sourceless entry, distinct
 * from the filesystem: skip line, then continues hashing every SOURCED
 * table in the same run.
 *
 * Usage: node scripts/migrations/verify-15-t3-content-hash.js [--db <target>]
 *   [--allow-live-drift]
 * --allow-live-drift acknowledges branch (b)'s LIVE-PARENT DRIFT classification
 * (live-source rows under a non-excluded parent project that have not yet
 * migrated) and lets the run PASS despite it. NEVER pass this by default --
 * T10 and any pre-promotion invocation must run without it, so drift is
 * always visible unless a human explicitly acknowledges it for one run.
 * Exit codes: 0 = every source hash found in target (multiset-complete),
 * 1 = any multiset mismatch, live-parent drift (without --allow-live-drift),
 * refused target, roster mapping gap, or lineage FATAL.
 */

const shared = require('./lib/verify15-shared');

// ─── BRANCH (b): LINEAGE-MAPPED COLUMNS (cm#198 fix) ─────────────────────────

/**
 * Load every live row from `sourceTable` on `srcClient`, projecting exactly
 * `cols`.
 */
async function loadLiveRows(client, table, cols) {
  const { rows } = await client.query(`SELECT ${cols.map((c) => `"${c}"`).join(', ')} FROM ${table}`);
  return rows;
}

/**
 * Runs branch (b)'s translated-id forward-containment proof for one
 * lineage-declared roster entry (cm#198 fix). Five-way per-source-row
 * classification, applied to every LIVE source row (never an enumeration of
 * lineage rows -- membership is a keyed LOOKUP per source row, so
 * duplicate source pairs each count separately, multiset-style):
 *
 *   1. MAPPED: this row's membership key is present in the entry's own
 *      lineage_table for (source_db, entry.source_table), AND every
 *      lineage-mapped column resolves via ITS OWN parent lineage row
 *      (source_db, parent_source_table, String(sourceValue)) ->
 *      target_row_id. The translated tuple (pg-native INTEGER target_row_id
 *      values, never strings) is hashed via the SAME rowHash() the target
 *      side uses, so a string-vs-int mismatch can never recreate cm#198's
 *      root cause.
 *   2. Membership present but a lineage-mapped column's parent resolution
 *      is MISSING -> FATAL "lineage inconsistency" (this is a lineage-table
 *      integrity break, never silently treated as ordinary drift).
 *   3. Membership absent AND the parent row's project is EXCLUDED (per the
 *      parent table's own migration_manifest exclusion slices) ->
 *      EXCLUDED-PARENT: counted + sampled, never blocks the run.
 *   4. Membership absent AND the parent row's project is live/unknown ->
 *      LIVE-PARENT DRIFT: counted + sampled (plus a named sub-count of rows
 *      whose OTHER mapped column is dangling in its own source table --
 *      structurally can never migrate regardless of project scope). FAILS
 *      the run unless --allow-live-drift is passed.
 *   5. Decode failure (the row's own values don't encode to a well-formed
 *      membership key under this entry's registered codec) -> FATAL, never
 *      silently reclassified as drift.
 *
 * MANDATORY ANCHOR: count of MAPPED rows must equal
 * sum(row_count) over migration_manifest slices for (source_db,
 * entry.source_table) with excluded_reason IS NULL. A mismatch is FATAL,
 * naming both numbers and both candidate causes -- this is what prevents a
 * "vacuous green" (an empty/short mappedRows set trivially passing the
 * forward-containment loop below, which iterates zero or few hashes, by
 * looking like nothing was wrong instead of like something was lost).
 *
 * Lineage rows with no corresponding live source row are reported
 * separately ("source deletions post-migration"), exit-neutral.
 */
async function runLineageBranch(srcClient, tgtClient, sourceDb, entry, cols, hashOpts, allowLiveDrift) {
  const codec = shared.getMembershipCodec(entry); // guaranteed non-null by roster-load validation
  const lineageTable = entry.lineageMembership.lineage_table;

  const { rows: srcCountRows } = await srcClient.query(`SELECT COUNT(*)::int AS n FROM ${entry.source_table}`);
  const sourceRowCount = srcCountRows[0].n;
  await shared.checkLineagePopulationOrFatal(tgtClient, lineageTable, sourceDb, entry.source_table, sourceRowCount, `${entry.targetTable} membership`);

  const parentTables = [...new Set(Object.values(entry.lineageMappedCols).map((m) => m.parent_source_table))];
  for (const pt of parentTables) {
    const { rows } = await srcClient.query(`SELECT COUNT(*)::int AS n FROM ${pt}`);
    await shared.checkLineagePopulationOrFatal(tgtClient, lineageTable, sourceDb, pt, rows[0].n, `${entry.targetTable}'s parent table "${pt}"`);
  }

  if (sourceRowCount === 0) {
    console.log(`[T3] OK: ${entry.source_table} -> ${entry.targetTable}: 0 live source rows (VACUOUS) -- nothing further to check.`);
    return { failed: false };
  }

  // Every lineage-table read below is scoped by BOTH source_db AND the
  // relevant source_table (spec item 2(h)) -- never a blanket scan.
  const membershipMap = await shared.loadLineageMap(tgtClient, lineageTable, sourceDb, entry.source_table);
  const parentMaps = new Map();
  for (const pt of parentTables) {
    parentMaps.set(pt, await shared.loadLineageMap(tgtClient, lineageTable, sourceDb, pt));
  }

  const sourceRows = await loadLiveRows(srcClient, entry.source_table, cols);

  // Parent-project classification (cases 3/4) needs the parent row's own
  // project_id -- resolved via the source-side parent table named by this
  // entry's own lineageMappedCols declaration (never a hardcoded table
  // name), and parent-table exclusions come from the SAME
  // migration_manifest mechanism T3's branch (a) already uses.
  const eventParentTable = entry.lineageMappedCols.event_id ? entry.lineageMappedCols.event_id.parent_source_table : parentTables[0];
  const { rows: parentProjectRows } = await srcClient.query(`SELECT id, project_id FROM ${eventParentTable}`);
  const parentProjectMap = new Map(parentProjectRows.map((r) => [r.id, r.project_id]));

  const exclusions = await shared.loadExclusionsFor(tgtClient, sourceDb, eventParentTable);
  const excludedProjectIds = new Set(exclusions.projectScoped.map((e) => e.project_id_or_null));
  const wholeParentExcluded = !!exclusions.nullScoped;

  // Dangling-assertion_id sub-count (item 2(b)(4)) -- assertion_id has NO
  // declared FK to assertions(id) (a real schema fact, see
  // migrate-verify-own-graph.js's header comment), so a dangling
  // assertion_id can exist independently of parent-project exclusion and
  // can never migrate under any circumstance.
  const assertionParentTable = entry.lineageMappedCols.assertion_id ? entry.lineageMappedCols.assertion_id.parent_source_table : null;
  let assertionIdSet = null;
  if (assertionParentTable) {
    const { rows } = await srcClient.query(`SELECT id FROM ${assertionParentTable}`);
    assertionIdSet = new Set(rows.map((r) => r.id));
  }

  const decodeFailures = [];
  const lineageInconsistencies = [];
  const mappedRows = [];
  let excludedParentCount = 0;
  let liveParentDriftCount = 0;
  let liveParentDanglingCount = 0;
  const excludedParentSample = [];
  const liveParentDriftSample = [];
  const liveSourceKeys = new Set();

  for (const row of sourceRows) {
    const key = codec.encode(row);
    if (key === null || codec.decode(key) === null) {
      decodeFailures.push(row);
      continue;
    }
    liveSourceKeys.add(key);

    if (membershipMap.has(key)) {
      const translated = {};
      let inconsistent = false;
      for (const [col, mapping] of Object.entries(entry.lineageMappedCols)) {
        const parentMap = parentMaps.get(mapping.parent_source_table);
        const sourceVal = String(row[col]);
        if (!parentMap.has(sourceVal)) { inconsistent = true; break; }
        translated[col] = parentMap.get(sourceVal);
      }
      if (inconsistent) {
        lineageInconsistencies.push(row);
        continue;
      }
      mappedRows.push(translated);
      continue;
    }

    const projectId = parentProjectMap.has(row.event_id) ? parentProjectMap.get(row.event_id) : undefined;
    const isExcluded = wholeParentExcluded || (projectId !== undefined && excludedProjectIds.has(projectId));
    if (isExcluded) {
      excludedParentCount++;
      if (excludedParentSample.length < 5) excludedParentSample.push(row);
    } else {
      liveParentDriftCount++;
      if (liveParentDriftSample.length < 5) liveParentDriftSample.push(row);
      if (assertionIdSet && !assertionIdSet.has(row.assertion_id)) liveParentDanglingCount++;
    }
  }

  if (decodeFailures.length > 0) {
    console.error(`[T3] FATAL: ${entry.source_table}: ${decodeFailures.length} row(s) failed membership-key decode (never silently reclassified as drift) -- sample: ${JSON.stringify(decodeFailures.slice(0, 3))}`);
    process.exit(1);
  }
  if (lineageInconsistencies.length > 0) {
    console.error(`[T3] FATAL: ${entry.source_table}: ${lineageInconsistencies.length} row(s) have membership in "${lineageTable}" but an unresolvable parent lineage mapping (lineage inconsistency, not ordinary drift) -- sample: ${JSON.stringify(lineageInconsistencies.slice(0, 3))}`);
    process.exit(1);
  }

  console.log(`[T3] ${entry.source_table} -> ${entry.targetTable}: classified ${mappedRows.length} MAPPED, ${excludedParentCount} EXCLUDED-PARENT, ${liveParentDriftCount} LIVE-PARENT DRIFT (of which ${liveParentDanglingCount} have a dangling ${assertionParentTable ? assertionParentTable.replace(/s$/, '') + '_id' : 'mapped-column'} -- can never migrate).`);
  if (excludedParentSample.length) console.log(`  EXCLUDED-PARENT sample: ${JSON.stringify(excludedParentSample)}`);
  if (liveParentDriftSample.length) console.log(`  LIVE-PARENT DRIFT sample: ${JSON.stringify(liveParentDriftSample)}`);

  const { rows: manifestRows } = await tgtClient.query(
    `SELECT COALESCE(SUM(row_count),0)::int AS n FROM migration_manifest WHERE source_db=$1 AND source_table=$2 AND excluded_reason IS NULL`,
    [sourceDb, entry.source_table]
  );
  const anchorExpected = manifestRows[0].n;
  if (mappedRows.length !== anchorExpected) {
    console.error(
      `[T3] FATAL: ${entry.source_table}: mapped-source-row count (${mappedRows.length}) != sum(row_count) over non-excluded migration_manifest slices for (source_db="${sourceDb}", source_table="${entry.source_table}") (${anchorExpected}). ` +
      `Candidate causes: (a) lineage rows were lost for some already-migrated source rows, or (b) migrate-verify-own-graph.js's writeManifestSlice recorded skipped rows in row_count too (a skipped join row -- parent not migrated this run -- counts toward the manifest total but never gets a lineage row).`
    );
    process.exit(1);
  }
  console.log(`[T3] OK: ${entry.source_table} anchor: ${mappedRows.length} mapped rows == ${anchorExpected} summed non-excluded manifest row_count.`);

  const mappedMultiset = new Map();
  for (const t of mappedRows) {
    const h = shared.rowHash(cols, t);
    const e = mappedMultiset.get(h) || { count: 0, sample: [] };
    e.count += 1;
    if (e.sample.length < 3) e.sample.push(t);
    mappedMultiset.set(h, e);
  }
  const targetMultiset = await shared.hashTableMultiset(tgtClient, entry.targetTable, cols, hashOpts);
  let tableOk = true;
  for (const [hash, { count: mappedCount, sample }] of mappedMultiset) {
    const targetCount = (targetMultiset.get(hash) || { count: 0 }).count;
    if (targetCount < mappedCount) {
      tableOk = false;
      console.error(`[T3] FAIL: ${entry.source_table} -> ${entry.targetTable}: lineage-tracked hash ${hash} has ${mappedCount} mapped source row(s) but only ${targetCount} target row(s) (lineage-tracked row missing from target)`, JSON.stringify(sample));
    }
  }
  if (tableOk) {
    console.log(`[T3] OK: ${entry.source_table} -> ${entry.targetTable}: all ${mappedRows.length} lineage-tracked (mapped) row(s) found in target (multiset).`);
  }

  const deletedLineageRows = [...membershipMap.keys()].filter((k) => !liveSourceKeys.has(k));
  if (deletedLineageRows.length > 0) {
    console.log(`[T3] source deletions post-migration: ${deletedLineageRows.length} (lineage row(s) in "${lineageTable}" with no corresponding live source row) -- sample: ${JSON.stringify(deletedLineageRows.slice(0, 5))}`);
  }

  const driftFails = liveParentDriftCount > 0 && !allowLiveDrift;
  if (driftFails) {
    console.error(
      `[T3] FAIL: ${entry.source_table} -> ${entry.targetTable}: ${liveParentDriftCount} live-source row(s) under a non-excluded parent project have NOT migrated (live-parent drift). ` +
      `Re-run migrate-verify-own-graph.js against this source, or pass --allow-live-drift to acknowledge and proceed for this run only (NEVER the default -- T10 and pre-promotion runs must never pass this flag).`
    );
  } else if (liveParentDriftCount > 0 && allowLiveDrift) {
    console.log(`[T3] --allow-live-drift: ${liveParentDriftCount} live-parent drift row(s) acknowledged for this run, not failing.`);
  }

  return { failed: !tableOk || driftFails };
}

/**
 * Group roster entries by source_db, dropping filesystem:-prefixed ones
 * (markdown, out of this battery's cut) and sourceless net-new: ones
 * (nothing to hash — see header comment) into their own labeled buckets.
 */
function groupRosterBySourceDb(roster) {
  const bySource = new Map();
  const skipped = [];
  const sourceless = [];
  for (const entry of roster) {
    if (entry.source_db.startsWith('filesystem:')) {
      skipped.push(entry);
      continue;
    }
    const { isSourceless } = shared.classifyRosterSourceDb(entry.source_db, `roster entry targetTable=${entry.targetTable}`);
    if (isSourceless) {
      sourceless.push(entry);
      continue;
    }
    if (!bySource.has(entry.source_db)) bySource.set(entry.source_db, []);
    bySource.get(entry.source_db).push(entry);
  }
  return { bySource, skipped, sourceless };
}

async function main() {
  const argv = process.argv.slice(2);
  const allowLiveDrift = argv.includes('--allow-live-drift');
  const { name: target, source } = shared.resolveAndClassifyTargetDb(argv);
  console.log(`verify-15-t3-content-hash: target="${target}" (resolved from ${source})${allowLiveDrift ? ' [--allow-live-drift ACKNOWLEDGED]' : ''}`);

  const roster = shared.loadRoster();
  shared.buildLoadBearingColsFromRoster(roster); // fatal-on-gap validation, result unused here (per-source below)

  const { bySource, skipped, sourceless } = groupRosterBySourceDb(roster);
  if (skipped.length) {
    console.log(`  [WARN] ${skipped.length} filesystem:-prefixed roster entr${skipped.length === 1 ? 'y' : 'ies'} skipped — markdown-source hashing (migrate-08/09) is out of this battery's cut.`);
  }
  if (sourceless.length) {
    console.log(`  [SKIP] ${sourceless.length} SOURCELESS (net-new:) roster entr${sourceless.length === 1 ? 'y' : 'ies'} excluded from T3's forward-containment scan — no source to hash:`);
    for (const e of sourceless) console.log(`    - ${e.source_db} -> ${e.targetTable}`);
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

          if (entry.lineageMappedCols) {
            // Branch (b): translated-id forward containment (cm#198 fix).
            // Completely separate from branch (a)'s exclusion-loading below
            // -- this entry's own migration_manifest slices are never
            // NULL/project-scope-excluded in practice (see the script
            // header's branch-asymmetry note), and exclusion for THIS
            // classification comes from the PARENT table's manifest slices,
            // handled inside runLineageBranch itself.
            const hashOpts = entry.idCol ? { idCol: entry.idCol } : {};
            let result;
            try {
              result = await runLineageBranch(srcClient, tgtClient, sourceDb, entry, cols, hashOpts, allowLiveDrift);
            } catch (err) {
              failed = true;
              console.error(`[T3] FAIL: ${sourceDb}.${entry.source_table}: branch (b) error: ${err.message}`);
              continue;
            }
            if (result.failed) failed = true;
            continue;
          }

          let exclusions;
          try {
            exclusions = await shared.loadExclusionsFor(tgtClient, sourceDb, entry.source_table);
          } catch (err) {
            failed = true;
            console.error(`[T3] FAIL: ${entry.source_table}: could not load exclusions from migration_manifest: ${err.message}`);
            continue;
          }

          if (exclusions.nullScoped) {
            console.log(`[T3] SKIP: ${sourceDb}.${entry.source_table}: whole-DB exclusion recorded (excluded_reason='${exclusions.nullScoped.excluded_reason}') — out of T3's forward scope; leakage detection is T9's provenance check, not T3.`);
            continue;
          }

          for (const ex of exclusions.projectScoped) {
            console.log(`[T3] ${entry.source_table}: excluding ${ex.row_count} row(s) for project_id=${ex.project_id_or_null} from T3 scope as '${ex.excluded_reason}'.`);
          }
          const excludedProjectIds = exclusions.projectScoped.map((ex) => ex.project_id_or_null);

          // BF-R3: idCol/projectCol are resolved per (table, connection) by
          // hashTableMultiset/hashTableMultisetExcludingProjects themselves
          // (shared.resolveHashCols via tableHasColumn) -- independently for
          // the source and target sides, since their column shapes can
          // diverge (retrieval_event_assertions: neither side has id or
          // project_id). entry.idCol is an OPTIONAL roster-level override
          // (mirrors the existing embeddingCol/contentCol convention), used
          // for sample-logging identification ONLY -- never the hash, which
          // is always computed over `cols` (loadBearingCols) alone.
          const hashOpts = entry.idCol ? { idCol: entry.idCol } : {};

          let srcCounts, tgtCounts;
          try {
            srcCounts = excludedProjectIds.length > 0
              ? await shared.hashTableMultisetExcludingProjects(srcClient, entry.source_table, cols, excludedProjectIds, hashOpts)
              : await shared.hashTableMultiset(srcClient, entry.source_table, cols, hashOpts);
          } catch (err) {
            failed = true;
            console.error(`[T3] FAIL: ${sourceDb}.${entry.source_table}: source query error: ${err.message}`);
            continue;
          }
          try {
            tgtCounts = await shared.hashTableMultiset(tgtClient, entry.targetTable, cols, hashOpts);
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

module.exports = { AUTHORED_BY, groupRosterBySourceDb, runLineageBranch, loadLiveRows };
