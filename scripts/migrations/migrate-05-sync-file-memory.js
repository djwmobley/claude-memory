'use strict';

/**
 * migrate-05-sync-file-memory.js
 *
 * CONSOLIDATION-RUNBOOK.md §6.1(f) + its F5-1..F5-12 spec-adversary
 * amendment (2026-08-16, memory-manager#11(f)). Two source kinds, three
 * steps, run in this fixed order:
 *
 *   STEP A (F5-1) -- DB-ABSORB: migrates the DB-resident `memory_entries`/
 *     `memory_entry_chunks` slices from `claude_policy_framework` and
 *     `pipeline_pipeline` (READ-ONLY on sources) into staging, lineage-keyed
 *     via `pipeline_migration_row_ids` (the E-6 general mechanism migrate-04
 *     built -- reused BY REFERENCE here, never re-forked). Runs FIRST so
 *     Step C's divergence diffing has both sides to compare.
 *   STEP B (F5-11) -- EXCLUSIONS: writes per-slice `excluded_reason`
 *     manifest rows for the leaked/eval-fixture DBs
 *     (`adv175_1786905342243_corpus`, `claude_memory_eval_test`,
 *     `claude_memory_eval_ci`) so their real-shaped-but-junk memory_entries/
 *     memory_entry_chunks data is PROVEN excluded (row_count = live source
 *     count), never a silent T0/T2/T3 coverage gap.
 *   STEP C -- FILESYSTEM SYNC: total-classifies every memory/-bearing
 *     project dir via the SHARED file-memory-project-enrollment.json
 *     (migrate-09's config and classifier, reused BY REFERENCE -- one
 *     config, never a fork), walks each ENROLLED dir's `*.md` topic files
 *     (I-9/I-7, migrate-09's own listTopicFiles reused verbatim), and
 *     hash-gate-upserts each into memory_entries/memory_entry_chunks.
 *
 * ══════════════════════════════════════════════════════════════════════
 * DESIGN DECISIONS BEYOND THE LITERAL AMENDMENT TEXT (this script's own
 * pre-authoring findings -- adversary-before-author pass, 2026-08-16)
 * ══════════════════════════════════════════════════════════════════════
 *
 *   1. MANIFEST-LABEL COLLISION WITH migrate-03 (field-found pre-staging).
 *      migrate-03-corpus-project-id.js ALREADY writes `migration_manifest`
 *      rows keyed `(source_db=<the same DB names Step A/B touch>,
 *      source_table='memory_entries'|'memory_entry_chunks',
 *      project_id_or_null)` -- it snapshots the SOURCE table's backfilled
 *      state as a D3-11 bookkeeping side-effect of its in-place project_id
 *      ALTER, using `loadBearingCols = ['name','description','mem_type',
 *      'body','source_file']` (no content_hash). If this script wrote its
 *      OWN manifest rows under the SAME bare `(source_db, 'memory_entries')`
 *      key, whichever script ran last would silently clobber the other's
 *      row_count/content_fingerprint -- a genuine cross-script manifest
 *      collision, the same defect CLASS migrate-04's header comment warned
 *      about for rollback-query scoping, just on the WRITE side instead.
 *      FIXED: every manifest/roster row this script writes for Step A/B
 *      uses a DISTINCT `source_table` label (`memory_entries_db_absorb` /
 *      `memory_entry_chunks_db_absorb`, ABSORB_MANIFEST_LABELS below) --
 *      never the bare table name migrate-03 already owns. Step C already
 *      had this instinct baked into its own spec (F5-7's
 *      `file_memory_raw_entries`/`file_memory_raw_chunks` labels); Step A/B
 *      needed the same treatment and didn't have it written down anywhere,
 *      so this PR adds it. Lineage rows (`pipeline_migration_row_ids`) keep
 *      the REAL table name (`memory_entries`/`memory_entry_chunks`) in
 *      their own `source_table` column throughout -- lineage identity and
 *      manifest-bookkeeping identity are two independent concerns and are
 *      allowed to use different labels.
 *
 *   2. LINEAGE AS STEP C'S PRIMARY IDENTITY MECHANISM. F5-2 states the sync
 *      identity is `(project_id, source_file)` at the "application layer" --
 *      this script implements that AS a lineage lookup
 *      (`pipeline_migration_row_ids`, source_table='file_memory_raw_entries',
 *      source_row_id=filename) rather than a raw SELECT-by-(project_id,
 *      source_file), because lineage is already the general E-6 mechanism
 *      this whole migration wave reuses, and because it makes the F5-9
 *      re-run total classification (live-matched / file-gone / new /
 *      renamed-candidate) a direct, cheap query against one table instead
 *      of a second hand-rolled identity path. A file's row is genuinely
 *      identified by (project_id, canonical source_file) either way -- the
 *      lineage row's own (source_db, source_table, source_row_id) triple
 *      collapses to exactly that identity, one dir at a time.
 *
 *   3. ABSORB-ADOPTION (F5-8/C-3). Before inserting a brand-new row for a
 *      topic file, this script checks whether a Step-A absorbed row shares
 *      this file's (project_id, comparison-normalized source_file) key
 *      (`scripts/lib/source-file-normalize.js`'s shared normalizer -- the
 *      SAME folding logic migrate-03 already established for exactly this
 *      class of legacy-path collision, reused BY REFERENCE). If a candidate
 *      shares this file's content_hash byte-for-byte, the absorbed row is
 *      ADOPTED: its `source_file` is renamed to the canonical
 *      `memory/<filename>` form and a `file_memory_raw_entries` lineage row
 *      is recorded pointing at it -- no duplicate row, lineage from BOTH
 *      steps now points at the same target id. If content_hash differs,
 *      nothing is touched: both hashes are logged loud
 *      (`[ABSORB-DIVERGENCE]`) and the file syncs to its OWN new row --
 *      the two rows coexist, exactly as F5-8 specifies. A (project_id,
 *      normalized-key) bucket can hold MORE THAN ONE absorbed candidate
 *      (the live `memory.md` + `memory\MEMORY.md` collision F5-2 names
 *      explicitly) -- every candidate is checked, and an adopted candidate
 *      is removed from the in-memory pool so it can never be double-adopted
 *      by a second file in the same run.
 *
 *   4. CHUNK LINEAGE IS NOT TRACKED SEPARATELY IN STEP C. Chunks are
 *      deterministic re-derivations of a tracked parent's body
 *      (`chunkText`, pure function) and `memory_entry_chunks.entry_id`
 *      carries `ON DELETE CASCADE` back to `memory_entries` (scripts/
 *      setup.sql) -- deleting a Step-C-tracked parent on rollback already
 *      removes its chunks, so a second per-chunk lineage row would be pure
 *      bookkeeping overhead with no identity question left to answer.
 *      Step A's chunks DO get their own lineage rows (`memory_entry_chunks`
 *      source_table) because Step A is copying pre-existing, independently-
 *      identified source rows one-for-one, not re-deriving them from a
 *      parent's body.
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHAT THIS SCRIPT DELIBERATELY DOES NOT DO
 * ══════════════════════════════════════════════════════════════════════
 *   - No embedding writes, ever (F5-4) -- `embedding` stays NULL/untouched
 *     on every INSERT/UPDATE this script performs, including the NULL reset
 *     on a changed chunk (mirrors the loader's own re-embed-trigger
 *     convention, reused by reference, never fired here).
 *   - No rewrite of a live-matched row's `source_file` string (only the
 *     one-time absorb-adoption rename touches an existing `source_file`).
 *   - No reclassification-drift reconciliation if the enrollment config or
 *     db-triage.json is edited BETWEEN two runs (same stated limitation
 *     migrate-04's header comment already carries for its own routing
 *     maps).
 *   - It never reads HANDOFF_DB, and it never creates the target database.
 *
 * Usage:
 *   node scripts/migrations/migrate-05-sync-file-memory.js [--db <target>]
 *     [--db-triage <path>] [--enrollment-config <path>]
 *     [--projects-root <path>] [--rollback] [--dry-run]
 *
 * Exit codes: 0 = PASS, 1 = refused / precondition failure / apply failure /
 * verification mismatch, 2 = bad CLI usage.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Client } = require('pg');

const migrateOne = require('./migrate-01-canonical-db');                 // reused by reference
const shared = require('./lib/verify15-shared');                          // reused by reference
const migrate03 = require('./migrate-03-corpus-project-id');              // reused by reference: ORPHAN_PROJECT_ID, the ONE canonical orphan-project-id sentinel
const migrate04 = require('./migrate-04-absorb-pipeline-tables');         // reused by reference: lineage helpers, db-triage, manifest writer
const migrate09 = require('./migrate-09-file-memory-markdown');           // reused by reference: enrollment config, classifier, file walk, frontmatter/type parsing
const { chunkText } = require('../pipeline-chunker');                     // reused by reference
const { filesystemSourceDb } = require('../lib/fs-path-normalize');       // reused by reference (H-14/I-14 shared normalizer)
const sourceFileNormalize = require('../lib/source-file-normalize');      // reused by reference (D3-2 comparison normalizer)
const { hasProvenanceColumn } = require('../lib/shared');                 // reused by reference (cm#201 completeness item #10)

// ─── PATHS / CONSTANTS ──────────────────────────────────────────────────────

const MIGRATIONS_DIR = __dirname;
const SQL_FILE = path.join(MIGRATIONS_DIR, 'sql', 'migrate-05-ddl-addenda.sql');
const DB_TRIAGE_PATH = migrate04.DB_TRIAGE_PATH;
const ENROLLMENT_CONFIG_PATH = migrate09.ENROLLMENT_CONFIG_PATH; // SHARED, never a second config file

const PREREQUISITE_TABLES = ['memory_entries', 'memory_entry_chunks'];
const PREREQUISITE_COLUMNS = [
  { table: 'memory_entries', column: 'project_id' },
  { table: 'memory_entry_chunks', column: 'project_id' },
];

// ── Step A: DB-absorb ───────────────────────────────────────────────────
const ABSORB_SOURCE_DBS = ['claude_policy_framework', 'pipeline_pipeline'];
const ABSORB_TABLES = ['memory_entries', 'memory_entry_chunks']; // parent before child (entry_id remap dependency)
// FIELD-FOUND DEFECT (staging run, 2026-08-16): live-verified against BOTH
// real absorb sources that neither claude_policy_framework.memory_entries
// NOR pipeline_pipeline.memory_entries carries a content_hash column at all
// (only their memory_entry_chunks siblings do) -- content_hash is COMPUTED
// at absorb time (sha256(body), see insertAbsorbedEntryRow) rather than
// copied, so it is deliberately absent from this map. claude_policy_
// framework additionally carries a `last_modified TIMESTAMPTZ` column with
// no pipeline_pipeline counterpart -- a genuine lossless-fidelity additive
// column (the same class migrate-04's own header comment documents),
// declared here universally; buildAbsorbEntryValues coalesces the missing
// key to NULL for pipeline_pipeline rows rather than passing `undefined`
// to pg (which node-postgres rejects outright).
const ABSORB_COLUMN_MAPS = {
  memory_entries: { name: 'name', description: 'description', mem_type: 'mem_type', body: 'body', source_file: 'source_file', last_modified: 'last_modified' },
  memory_entry_chunks: { chunk_idx: 'chunk_idx', content: 'content', content_hash: 'content_hash' },
};
// Distinct manifest/roster labels -- see header comment point 1 (never the
// bare table name; migrate-03-corpus-project-id.js already owns that key).
const ABSORB_MANIFEST_LABELS = {
  memory_entries: 'memory_entries_db_absorb',
  memory_entry_chunks: 'memory_entry_chunks_db_absorb',
};
// NON-BLOCKING REVIEW NOTE ADDRESSED (PR #190, independent review,
// 2026-08-17): this NULL-project_id defensive fallback is unreachable
// under the declared a -> d -> f run order -- phase (d) backfills every
// row's project_id to a non-NULL value, INCLUDING minting this exact
// sentinel string for its own unmapped rows, before (f) ever runs. If this
// branch ever does fire (a mis-sequenced run), it now lands under the SAME
// canonical orphan bucket migrate-03 already uses (migrate03.
// ORPHAN_PROJECT_ID), not a second, distinct sentinel literal -- closing
// the "two different orphan-sentinel strings for the same condition" risk
// the review flagged, by reusing the exported constant instead of
// duplicating its value.
const ORPHAN_NULL_PROJECT_BUCKET = migrate03.ORPHAN_PROJECT_ID;

// ── Step B: exclusions (F5-11) ──────────────────────────────────────────
const EXCLUDED_SOURCE_DBS = {
  adv175_1786905342243_corpus: 'test-artifact-db',
  claude_memory_eval_test: 'eval-fixture-corpus',
  claude_memory_eval_ci: 'eval-fixture-corpus',
};

// ── Step C: filesystem sync ─────────────────────────────────────────────
const SOURCE_TABLE_RAW_ENTRIES = 'file_memory_raw_entries';
const SOURCE_TABLE_RAW_CHUNKS = 'file_memory_raw_chunks';
const CHUNK_CEILING = 1400; // CONST_PROSE_CEILING, pipeline-memory-loader.js's own constant, reused by value

// ─── CLI ARGS ─────────────────────────────────────────────────────────────

class UsageError extends Error {}

function parseArgs(argv) {
  const parsed = {
    db: null,
    dbTriagePath: DB_TRIAGE_PATH,
    enrollmentConfigPath: ENROLLMENT_CONFIG_PATH,
    projectsRoot: migrate09.DEFAULT_PROJECTS_ROOT,
    rollback: false,
    dryRun: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--db') parsed.db = argv[++i];
    else if (a.startsWith('--db=')) parsed.db = a.slice('--db='.length);
    else if (a === '--db-triage') parsed.dbTriagePath = argv[++i];
    else if (a.startsWith('--db-triage=')) parsed.dbTriagePath = a.slice('--db-triage='.length);
    else if (a === '--enrollment-config') parsed.enrollmentConfigPath = argv[++i];
    else if (a.startsWith('--enrollment-config=')) parsed.enrollmentConfigPath = a.slice('--enrollment-config='.length);
    else if (a === '--projects-root') parsed.projectsRoot = argv[++i];
    else if (a.startsWith('--projects-root=')) parsed.projectsRoot = a.slice('--projects-root='.length);
    else if (a === '--rollback') parsed.rollback = true;
    else if (a === '--dry-run') parsed.dryRun = true;
    else if (a === '--help' || a === '-h') parsed.help = true;
    else throw new UsageError(`Unknown argument: ${a}`);
  }
  return parsed;
}

function printUsage() {
  console.log([
    'Usage: node scripts/migrations/migrate-05-sync-file-memory.js [--db <target>]',
    '         [--db-triage <path>] [--enrollment-config <path>]',
    '         [--projects-root <path>] [--rollback] [--dry-run]',
    '',
    '  --db <name>                Target database (else MIGRATE_TARGET_DB env, else',
    '                             memory_manager_staging). Never reads HANDOFF_DB.',
    '  --db-triage <path>         Path to db-triage.json (default: alongside migrate-04).',
    '  --enrollment-config <path> Path to file-memory-project-enrollment.json (SHARED with',
    '                             migrate-09; default: alongside that script).',
    '  --projects-root <path>     Directory to enumerate for memory/-bearing project dirs.',
    '  --rollback                 Delete this script\'s own-tagged rows (Step A + Step C)',
    '                             via lineage/slice scoping, plus own manifest slices.',
    '  --dry-run                  Read + classify only; no DB writes.',
  ].join('\n'));
}

// ─── SHA256 HELPER ──────────────────────────────────────────────────────────

function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

// ─── STEP A/B COLUMN-SHAPE PRECONDITION ────────────────────────────────────

function checkAbsorbColumnShape(liveCols, columnMap, extraIgnored) {
  const ignored = new Set([...migrate04.GENERIC_IGNORED_SOURCE_COLS, 'project_id', ...(extraIgnored || [])]);
  const declared = new Set(Object.keys(columnMap));
  return liveCols.filter((c) => !ignored.has(c) && !declared.has(c));
}

// ─── STEP A: DB-ABSORB ──────────────────────────────────────────────────────

async function insertAbsorbedEntryRow(tgtClient, sourceDb, sourceRow, projectId, log) {
  const prior = await migrate04.getLineageEntry(tgtClient, sourceDb, 'memory_entries', sourceRow.id);
  if (prior) return { result: 'already-migrated', targetId: prior.target_row_id };
  // content_hash never exists on the source (see ABSORB_COLUMN_MAPS comment)
  // -- computed here, once, at absorb time. last_modified is genuinely
  // absent on pipeline_pipeline rows (undefined) -- coalesced to NULL
  // rather than passed through raw (node-postgres rejects `undefined`).
  const lastModified = sourceRow.last_modified === undefined ? null : sourceRow.last_modified;
  const contentHash = sha256(sourceRow.body || '');
  const { rows } = await tgtClient.query(
    `INSERT INTO memory_entries (project_id, name, description, mem_type, body, source_file, content_hash, last_modified)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
    [projectId, sourceRow.name, sourceRow.description, sourceRow.mem_type, sourceRow.body, sourceRow.source_file, contentHash, lastModified]
  );
  await migrate04.recordLineage(tgtClient, sourceDb, 'memory_entries', sourceRow.id, projectId, 'memory_entries', rows[0].id);
  return { result: 'migrated', targetId: rows[0].id };
}

async function insertAbsorbedChunkRow(tgtClient, sourceDb, sourceRow, projectId, entryIdMap, log) {
  const prior = await migrate04.getLineageEntry(tgtClient, sourceDb, 'memory_entry_chunks', sourceRow.id);
  if (prior) return { result: 'already-migrated' };
  const targetEntryId = entryIdMap.get(String(sourceRow.entry_id));
  if (targetEntryId === undefined) {
    log(`  [ORPHAN-CHUNK] memory_entry_chunks source_db="${sourceDb}" id=${sourceRow.id}: entry_id=${sourceRow.entry_id} has no migrated parent memory_entries row this run -- skipped, NOT counted as migrated.`);
    return { result: 'orphan-parent' };
  }
  const { rows } = await tgtClient.query(
    `INSERT INTO memory_entry_chunks (project_id, entry_id, chunk_idx, content, content_hash)
     VALUES ($1,$2,$3,$4,$5) RETURNING id`,
    [projectId, targetEntryId, sourceRow.chunk_idx, sourceRow.content, sourceRow.content_hash]
  );
  await migrate04.recordLineage(tgtClient, sourceDb, 'memory_entry_chunks', sourceRow.id, projectId, 'memory_entry_chunks', rows[0].id);
  return { result: 'migrated' };
}

/** Group rows by their (already-backfilled, per phase (d)) project_id column. NULL is its own lossless bucket. */
function groupByProjectId(rows, table, sourceDb, log) {
  const slices = new Map();
  for (const row of rows) {
    let pid = row.project_id;
    if (pid === null || pid === undefined) {
      pid = ORPHAN_NULL_PROJECT_BUCKET;
      log(`  [ORPHAN-NULL-PROJECT-ID] ${table} source_db="${sourceDb}" id=${row.id}: project_id is NULL post-backfill -- migrated under bucket "${ORPHAN_NULL_PROJECT_BUCKET}", lossless, never dropped.`);
    }
    if (!slices.has(pid)) slices.set(pid, []);
    slices.get(pid).push(row);
  }
  return slices;
}

async function absorbTable(tgtClient, srcClient, sourceDb, table, entryIdMap, dryRun, log) {
  const columnMap = ABSORB_COLUMN_MAPS[table];
  const { rows: existsRows } = await migrate04.sourceSelect(
    srcClient,
    `SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name=$1`,
    [table]
  );
  if (existsRows.length === 0) return { perSlice: [], precheckFailure: null, skippedNoTable: true };

  const liveCols = await migrate04.getLiveSourceColumns(srcClient, table);
  const extraIgnored = table === 'memory_entry_chunks' ? ['entry_id'] : [];
  const unmapped = checkAbsorbColumnShape(liveCols, columnMap, extraIgnored);
  if (unmapped.length > 0) {
    return { perSlice: [], precheckFailure: `(${sourceDb}, ${table}): ${unmapped.length} live column(s) have no ABSORB_COLUMN_MAPS entry: ${unmapped.join(', ')}` };
  }

  const { rows: countRows } = await migrate04.sourceSelect(srcClient, `SELECT COUNT(*)::int AS n FROM ${table}`);
  if (countRows[0].n === 0) return { perSlice: [] };

  const { rows: sourceRows } = await migrate04.sourceSelect(srcClient, `SELECT * FROM ${table} ORDER BY id`);
  const slices = groupByProjectId(sourceRows, table, sourceDb, log);

  const perSlice = [];
  for (const [projectId, rows] of slices) {
    if (dryRun) {
      log(`  [DRY-RUN] would absorb ${rows.length} row(s) ${table} source_db="${sourceDb}" project_id="${projectId}"`);
      perSlice.push({ sourceDb, table, projectId, source: rows.length, migrated: 0, alreadyMigrated: 0, dryRun: true });
      continue;
    }
    await tgtClient.query('BEGIN');
    let migrated = 0, alreadyMigrated = 0, orphanParents = 0;
    try {
      for (const row of rows) {
        let r;
        if (table === 'memory_entries') r = await insertAbsorbedEntryRow(tgtClient, sourceDb, row, projectId, log);
        else r = await insertAbsorbedChunkRow(tgtClient, sourceDb, row, projectId, entryIdMap, log);
        if (r.result === 'migrated') migrated++;
        else if (r.result === 'already-migrated') alreadyMigrated++;
        else orphanParents++;
      }
      const ordered = [...rows].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      await migrate04.writeManifestSlice(tgtClient, sourceDb, ABSORB_MANIFEST_LABELS[table], projectId, ordered, Object.keys(columnMap), null, 'id');
      await tgtClient.query('COMMIT');
    } catch (err) {
      await tgtClient.query('ROLLBACK');
      throw err;
    }
    perSlice.push({ sourceDb, table, projectId, source: rows.length, migrated, alreadyMigrated, orphanParents });
  }
  return { perSlice };
}

/**
 * FIELD-FOUND FIX (independent review, PR #190, 2026-08-17): this function
 * is reachable from `run(targetDbName)`, which `verify-15-t8-idempotency.js`
 * calls IN-PROCESS (no child_process, per that script's own documented
 * contract). A `process.exit(1)` here previously killed the ENTIRE T8
 * harness process on a classification refusal -- skipping T8's own before/
 * after diff, its T6 re-run, and its `finally { await client.end(); }`
 * cleanup -- instead of surfacing as a normal, catchable T8 FAIL. Refusal
 * is now a returned `{ refused: true, ... }` result; the CLI-only caller
 * (main(), itself only ever process.exit()-ing from the `require.main ===
 * module` guard at the bottom of this file) is the one place that turns a
 * refusal into an exit code. runStepA itself never touches process exit
 * state, exactly like every other exported helper in this file.
 */
async function runStepA(tgtClient, dbTriage, dryRun, log, absorbSourceDbs = ABSORB_SOURCE_DBS) {
  const misclassified = absorbSourceDbs
    .map((db) => ({ db, cls: migrate04.classifyDb(db, dbTriage) }))
    .filter((x) => x.cls !== 'REAL-MIGRATE');
  if (misclassified.length > 0) {
    console.error(`Refused (Step A total classification): ${misclassified.length} absorb-source DB(s) are not classified REAL-MIGRATE in db-triage.json:`);
    for (const m of misclassified) console.error(`  - "${m.db}": classified "${m.cls}"`);
    console.error('Step A never connects to a source it has not confirmed REAL-MIGRATE. Nothing was touched.');
    return { refused: true, misclassified, perSlice: [], precheckFailures: [] };
  }

  const perSliceAll = [];
  const precheckFailures = [];
  for (const sourceDb of absorbSourceDbs) {
    const srcClient = new Client(migrateOne.pgConfig(sourceDb));
    await srcClient.connect();
    try {
      const entriesResult = await absorbTable(tgtClient, srcClient, sourceDb, 'memory_entries', null, dryRun, log);
      if (entriesResult.precheckFailure) precheckFailures.push(entriesResult.precheckFailure);
      perSliceAll.push(...entriesResult.perSlice);

      let entryIdMap = new Map();
      if (!dryRun) {
        const { rows: lineageRows } = await tgtClient.query(
          `SELECT source_row_id, target_row_id FROM pipeline_migration_row_ids WHERE source_db=$1 AND source_table='memory_entries'`,
          [sourceDb]
        );
        entryIdMap = new Map(lineageRows.map((r) => [r.source_row_id, r.target_row_id]));
      }

      const chunksResult = await absorbTable(tgtClient, srcClient, sourceDb, 'memory_entry_chunks', entryIdMap, dryRun, log);
      if (chunksResult.precheckFailure) precheckFailures.push(chunksResult.precheckFailure);
      perSliceAll.push(...chunksResult.perSlice);
    } finally {
      await srcClient.end();
    }
  }
  return { refused: false, perSlice: perSliceAll, precheckFailures };
}

// ─── STEP B: EXCLUSIONS (F5-11) ─────────────────────────────────────────────

async function runStepB(tgtClient, dryRun, log, excludedSourceDbs = EXCLUDED_SOURCE_DBS) {
  const exclusions = [];
  for (const [sourceDb, reason] of Object.entries(excludedSourceDbs)) {
    let srcClient;
    try {
      srcClient = new Client(migrateOne.pgConfig(sourceDb));
      await srcClient.connect();
    } catch (err) {
      log(`  [EXCLUDED-SKIP] could not connect to "${sourceDb}" (${err.message}) -- treated as absent, no exclusion manifest row written this run.`);
      continue;
    }
    try {
      for (const table of ABSORB_TABLES) {
        const { rows: existsRows } = await migrate04.sourceSelect(
          srcClient,
          `SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name=$1`,
          [table]
        );
        if (existsRows.length === 0) continue;
        const { rows: sourceRows } = await migrate04.sourceSelect(srcClient, `SELECT * FROM ${table} ORDER BY id`);
        if (sourceRows.length === 0) continue;

        if (dryRun) {
          log(`  [DRY-RUN] would write exclusion slice ${table} source_db="${sourceDb}" excluded_reason="${reason}" (${sourceRows.length} row(s))`);
          exclusions.push({ sourceDb, table, reason, source: sourceRows.length, dryRun: true });
          continue;
        }
        await migrate04.writeExcludedSlice(tgtClient, sourceDb, ABSORB_MANIFEST_LABELS[table], null, sourceRows, ABSORB_COLUMN_MAPS[table], reason, log);
        exclusions.push({ sourceDb, table, reason, source: sourceRows.length });
      }
    } finally {
      await srcClient.end();
    }
  }
  return exclusions;
}

// ─── DIVERGENCE MAP (F5-8/C-3) ──────────────────────────────────────────────

/** Every Step-A-absorbed memory_entries row, bucketed by (project_id, comparison-normalized source_file). */
async function buildDivergenceMap(tgtClient) {
  const { rows } = await tgtClient.query(
    `SELECT me.id, me.project_id, me.source_file, me.content_hash
       FROM memory_entries me
       JOIN pipeline_migration_row_ids p
         ON p.target_table = 'memory_entries' AND p.target_row_id = me.id
      WHERE p.source_table = 'memory_entries'`
  );
  const map = new Map();
  for (const r of rows) {
    const key = `${r.project_id}::${sourceFileNormalize.normalize(r.source_file)}`;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push({ id: r.id, contentHash: r.content_hash, sourceFile: r.source_file });
  }
  return map;
}

// ─── STEP C: FILESYSTEM SYNC ─────────────────────────────────────────────────

/** description = first "# " heading line in the BODY, AFTER any frontmatter block (fixes the loader's own first-line-of-raw-text defect, F5-3). */
function extractDescription(body) {
  for (const line of body.split(/\r?\n/)) {
    const t = line.trim();
    if (t.startsWith('# ')) return t.slice(2).trim();
  }
  return null;
}

async function processTopicFile(tgtClient, projectId, dirFsDb, fileName, memoryDirPath, divergenceMap, dryRun, log) {
  const stem = path.basename(fileName, path.extname(fileName));
  const filePath = path.join(memoryDirPath, fileName);
  const text = fs.readFileSync(filePath, 'utf8');
  const { frontmatter, body } = migrate09.parseFrontmatterAndBody(text);
  const resolved = migrate09.resolveEntityType(frontmatter, stem); // reused by reference: I-3/I-8, 4-value enum + filename-prefix fallback
  const memType = resolved.entityType;
  const description = extractDescription(body);
  const contentHash = sha256(body);
  const canonicalSourceFile = `memory/${fileName}`;
  const compKey = `${projectId}::${sourceFileNormalize.normalize(canonicalSourceFile)}`;

  const events = [];
  if (resolved.method === 'filename-prefix-fallback') {
    events.push({ kind: 'filename-prefix-fallback', stem, memType });
  } else if (resolved.method === 'invalid-enum-value') {
    events.push({ kind: 'unmatched-type', stem, reason: 'invalid-enum-value', invalidValue: resolved.invalidValue, invalidSource: resolved.invalidSource });
  } else if (resolved.method === 'unmatched-type') {
    events.push({ kind: 'unmatched-type', stem, reason: 'no-frontmatter-type-no-prefix-match' });
  }

  // ── absorb-adoption check (design decision 3) ─────────────────────────
  const candidates = divergenceMap.get(compKey) || [];
  let entryId = null;
  let lifecycle = null;
  const match = candidates.find((c) => c.contentHash === contentHash);
  if (match) {
    entryId = match.id;
    lifecycle = 'adopted';
    candidates.splice(candidates.indexOf(match), 1); // never double-adopt
    events.push({ kind: 'absorbed-row-adopted', stem, absorbedSourceFile: match.sourceFile, targetId: match.id });
  } else if (candidates.length > 0) {
    for (const c of candidates) {
      events.push({ kind: 'absorb-divergence', stem, projectId, canonicalSourceFile, liveHash: contentHash, absorbedSourceFile: c.sourceFile, absorbedHash: c.contentHash, absorbedTargetId: c.id });
    }
  }

  // ── own lineage: live-matched? ─────────────────────────────────────────
  if (entryId === null) {
    const prior = await migrate04.getLineageEntry(tgtClient, dirFsDb, SOURCE_TABLE_RAW_ENTRIES, fileName);
    if (prior) {
      entryId = prior.target_row_id;
      lifecycle = 'live-matched';
    }
  }

  // ── renamed-candidate diagnostic (F5-9; never auto-merged) ────────────
  if (entryId === null) {
    const { rows: renameRows } = await tgtClient.query(
      `SELECT p.source_row_id AS old_filename
         FROM pipeline_migration_row_ids p
         JOIN memory_entries me ON me.id = p.target_row_id
        WHERE p.source_db = $1 AND p.source_table = $2 AND me.content_hash = $3 AND p.source_row_id <> $4`,
      [dirFsDb, SOURCE_TABLE_RAW_ENTRIES, contentHash, fileName]
    );
    for (const r of renameRows) {
      events.push({ kind: 'renamed-candidate', stem, fileName, oldFileName: r.old_filename, reason: 'same-content-hash-different-name' });
    }
  }

  if (dryRun) {
    log(`  [DRY-RUN] would sync "${fileName}" project_id="${projectId}" lifecycle=${lifecycle || 'new'}`);
    return { events, lifecycle: lifecycle || 'new', chunkWrites: 0 };
  }

  await tgtClient.query('BEGIN');
  let chunkWrites = 0;
  try {
    if (entryId === null) {
      const { rows } = await tgtClient.query(
        `INSERT INTO memory_entries (project_id, name, description, mem_type, body, source_file, content_hash)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
        [projectId, stem, description, memType, body, canonicalSourceFile, contentHash]
      );
      entryId = rows[0].id;
      lifecycle = 'new';
      await migrate04.recordLineage(tgtClient, dirFsDb, SOURCE_TABLE_RAW_ENTRIES, fileName, projectId, 'memory_entries', entryId);
    } else if (lifecycle === 'adopted') {
      // One-time identity merge: rename + refresh metadata; body/content_hash
      // already match by construction (that's the adoption condition) so
      // the stored bytes are never rewritten here.
      await tgtClient.query(
        `UPDATE memory_entries SET source_file=$1, name=$2, description=$3, mem_type=$4, updated_at=NOW() WHERE id=$5`,
        [canonicalSourceFile, stem, description, memType, entryId]
      );
      await migrate04.recordLineage(tgtClient, dirFsDb, SOURCE_TABLE_RAW_ENTRIES, fileName, projectId, 'memory_entries', entryId);
    } else {
      // live-matched: hash-gated. Skip = no write at all, updated_at untouched.
      const { rows: existingRows } = await tgtClient.query(`SELECT content_hash FROM memory_entries WHERE id=$1`, [entryId]);
      const existingHash = existingRows[0] ? existingRows[0].content_hash : null;
      if (existingHash === contentHash) {
        await tgtClient.query('COMMIT');
        return { events, lifecycle: 'live-matched-unchanged', chunkWrites: 0 };
      }
      await tgtClient.query(
        `UPDATE memory_entries SET name=$1, description=$2, mem_type=$3, body=$4, content_hash=$5, updated_at=NOW() WHERE id=$6`,
        [stem, description, memType, body, contentHash, entryId]
      );
      lifecycle = 'live-matched-changed';
    }

    // ── chunk sync: reuse-by-reference chunkText + chunk-hash gating pattern ──
    const chunks = chunkText(body, CHUNK_CEILING, 'prose');
    const { rows: existingChunks } = await tgtClient.query(
      `SELECT chunk_idx, content_hash FROM memory_entry_chunks WHERE entry_id=$1`,
      [entryId]
    );
    const existingChunkHashes = new Map(existingChunks.map((r) => [r.chunk_idx, r.content_hash]));
    // cm#201 completeness item #10 (inverse violator): classified ONCE per
    // call (this function runs per topic file, not per chunk) -- when
    // memory_entry_chunks has adopted embedded_by_provider_id, the stale
    // provenance id must be NULLed alongside embedding in the SAME
    // statement, never left standing on a row whose embedding was just
    // cleared.
    const chunksHaveProvenanceCol = await hasProvenanceColumn(tgtClient, 'memory_entry_chunks');
    for (const chunk of chunks) {
      const h = sha256(chunk.content);
      if (existingChunkHashes.get(chunk.chunkIdx) === h) continue; // skip = no write at all
      const chunkSql = chunksHaveProvenanceCol
        ? `INSERT INTO memory_entry_chunks (project_id, entry_id, chunk_idx, content, content_hash, embedding, embedded_by_provider_id)
           VALUES ($1,$2,$3,$4,$5,NULL,NULL)
           ON CONFLICT (entry_id, chunk_idx) DO UPDATE
             SET content=EXCLUDED.content, content_hash=EXCLUDED.content_hash, embedding=NULL, embedded_by_provider_id=NULL, project_id=EXCLUDED.project_id`
        : `INSERT INTO memory_entry_chunks (project_id, entry_id, chunk_idx, content, content_hash, embedding)
           VALUES ($1,$2,$3,$4,$5,NULL)
           ON CONFLICT (entry_id, chunk_idx) DO UPDATE
             SET content=EXCLUDED.content, content_hash=EXCLUDED.content_hash, embedding=NULL, project_id=EXCLUDED.project_id`;
      await tgtClient.query(chunkSql, [projectId, entryId, chunk.chunkIdx, chunk.content, h]);
      chunkWrites++;
    }
    // F5-3: the one intended destructive branch -- delete stale higher-idx
    // chunks of a live re-synced file, in the SAME transaction.
    await tgtClient.query(`DELETE FROM memory_entry_chunks WHERE entry_id=$1 AND chunk_idx >= $2`, [entryId, chunks.length]);

    await tgtClient.query('COMMIT');
  } catch (err) {
    await tgtClient.query('ROLLBACK');
    throw err;
  }
  return { events, lifecycle, chunkWrites, entryId };
}

async function findFileGoneRows(tgtClient, dirFsDb, currentFileNames) {
  const { rows } = await tgtClient.query(
    `SELECT source_row_id FROM pipeline_migration_row_ids WHERE source_db=$1 AND source_table=$2`,
    [dirFsDb, SOURCE_TABLE_RAW_ENTRIES]
  );
  return rows.map((r) => r.source_row_id).filter((fn) => !currentFileNames.has(fn));
}

async function writeDirManifestSlices(tgtClient, dirFsDb, projectId, dryRun, log) {
  if (dryRun) {
    log(`  [DRY-RUN] would write manifest slices for source_db="${dirFsDb}"`);
    return;
  }
  const { rows: entryRows } = await tgtClient.query(
    `SELECT p.source_row_id, me.source_file, me.content_hash
       FROM pipeline_migration_row_ids p JOIN memory_entries me ON me.id = p.target_row_id
      WHERE p.source_db=$1 AND p.source_table=$2 ORDER BY p.source_row_id`,
    [dirFsDb, SOURCE_TABLE_RAW_ENTRIES]
  );
  const { rows: chunkRowsRaw } = await tgtClient.query(
    `SELECT p.source_row_id AS parent_file, mc.chunk_idx, mc.content_hash
       FROM pipeline_migration_row_ids p
       JOIN memory_entries me ON me.id = p.target_row_id
       JOIN memory_entry_chunks mc ON mc.entry_id = me.id
      WHERE p.source_db=$1 AND p.source_table=$2
      ORDER BY p.source_row_id, mc.chunk_idx`,
    [dirFsDb, SOURCE_TABLE_RAW_ENTRIES]
  );
  const chunkRows = chunkRowsRaw.map((r) => ({ source_row_id: `${r.parent_file}::${r.chunk_idx}`, content_hash: r.content_hash }));

  await tgtClient.query('BEGIN');
  try {
    await migrate04.writeManifestSlice(tgtClient, dirFsDb, SOURCE_TABLE_RAW_ENTRIES, projectId, entryRows, ['source_file', 'content_hash'], null, 'source_row_id');
    await migrate04.writeManifestSlice(tgtClient, dirFsDb, SOURCE_TABLE_RAW_CHUNKS, projectId, chunkRows, ['content_hash'], null, 'source_row_id');
    await tgtClient.query('COMMIT');
  } catch (err) {
    await tgtClient.query('ROLLBACK');
    throw err;
  }
}

async function processEnrolledDir(tgtClient, projectId, dirName, memoryDirPath, divergenceMap, dryRun, log) {
  const dirFsDb = filesystemSourceDb(memoryDirPath);
  const fileNames = migrate09.listTopicFiles(memoryDirPath); // reused by reference: I-9/I-7
  const currentFileNames = new Set(fileNames);

  const counts = { total: fileNames.length, new: 0, adopted: 0, liveMatchedChanged: 0, liveMatchedUnchanged: 0, fileGone: 0 };
  const allEvents = [];

  for (const fileName of fileNames) {
    const r = await processTopicFile(tgtClient, projectId, dirFsDb, fileName, memoryDirPath, divergenceMap, dryRun, log);
    allEvents.push(...r.events);
    if (r.lifecycle === 'new') counts.new++;
    else if (r.lifecycle === 'adopted') counts.adopted++;
    else if (r.lifecycle === 'live-matched-changed') counts.liveMatchedChanged++;
    else if (r.lifecycle === 'live-matched-unchanged') counts.liveMatchedUnchanged++;
  }

  if (!dryRun) {
    const goneFiles = await findFileGoneRows(tgtClient, dirFsDb, currentFileNames);
    counts.fileGone = goneFiles.length;
    for (const fn of goneFiles) {
      log(`  [FILE-GONE] project_id="${projectId}" dir="${dirName}" file="${fn}": no longer present on disk -- target row KEPT (lossless canon), never deleted.`);
    }
    await writeDirManifestSlices(tgtClient, dirFsDb, projectId, dryRun, log);
  }

  for (const ev of allEvents) {
    if (ev.kind === 'filename-prefix-fallback') log(`  [FALLBACK] project_id="${projectId}" stem="${ev.stem}": no frontmatter type; filename-prefix inference -> mem_type="${ev.memType}"`);
    else if (ev.kind === 'unmatched-type' && ev.reason === 'invalid-enum-value') log(`  [UNMATCHED-TYPE] project_id="${projectId}" stem="${ev.stem}": ${ev.invalidSource}="${ev.invalidValue}" is not one of the 4 valid mem_types; mem_type written NULL`);
    else if (ev.kind === 'unmatched-type') log(`  [UNMATCHED-TYPE] project_id="${projectId}" stem="${ev.stem}": no frontmatter type and no recognized filename prefix; mem_type written NULL`);
    else if (ev.kind === 'absorbed-row-adopted') log(`  [ABSORB-ADOPTED] project_id="${projectId}" stem="${ev.stem}": absorbed row (source_file="${ev.absorbedSourceFile}", id=${ev.targetId}) matches this file's content_hash -- adopted as the live row, renamed to canonical form.`);
    else if (ev.kind === 'absorb-divergence') log(`  [ABSORB-DIVERGENCE] project_id="${projectId}" stem="${ev.stem}": live file hash=${ev.liveHash} differs from absorbed row (source_file="${ev.absorbedSourceFile}", id=${ev.absorbedTargetId}) hash=${ev.absorbedHash} -- both rows kept, NEVER overwritten.`);
    else if (ev.kind === 'renamed-candidate') log(`  [RENAMED-CANDIDATE] project_id="${projectId}" file="${ev.fileName}": same content_hash as previously-tracked "${ev.oldFileName}" -- reported, never auto-merged.`);
  }

  return { counts, events: allEvents };
}

// ─── ROLLBACK ────────────────────────────────────────────────────────────────

async function rollbackDir(tgtClient, dirFsDb, log) {
  await tgtClient.query('BEGIN');
  let deletedEntries = 0;
  try {
    const { rows: lineageRows } = await tgtClient.query(
      `SELECT target_row_id FROM pipeline_migration_row_ids WHERE source_db=$1 AND source_table=$2`,
      [dirFsDb, SOURCE_TABLE_RAW_ENTRIES]
    );
    const ids = lineageRows.map((r) => r.target_row_id);
    if (ids.length > 0) {
      const res = await tgtClient.query(`DELETE FROM memory_entries WHERE id = ANY($1::int[])`, [ids]); // cascades chunks
      deletedEntries = res.rowCount;
    }
    await tgtClient.query(`DELETE FROM pipeline_migration_row_ids WHERE source_db=$1 AND source_table=$2`, [dirFsDb, SOURCE_TABLE_RAW_ENTRIES]);
    await tgtClient.query(`DELETE FROM migration_manifest WHERE source_db=$1 AND source_table IN ($2,$3)`, [dirFsDb, SOURCE_TABLE_RAW_ENTRIES, SOURCE_TABLE_RAW_CHUNKS]);
    await tgtClient.query(`DELETE FROM migration_manifest_row_hashes WHERE source_db=$1 AND source_table IN ($2,$3)`, [dirFsDb, SOURCE_TABLE_RAW_ENTRIES, SOURCE_TABLE_RAW_CHUNKS]);
    await tgtClient.query('COMMIT');
  } catch (err) {
    await tgtClient.query('ROLLBACK');
    throw err;
  }
  log(`  [ROLLBACK] source_db="${dirFsDb}": deleted ${deletedEntries} memory_entries row(s) (cascades chunks) + lineage/manifest`);
  return { deletedEntries };
}

async function rollbackAbsorb(tgtClient, log, absorbSourceDbs = ABSORB_SOURCE_DBS) {
  let totalDeleted = 0;
  for (const sourceDb of absorbSourceDbs) {
    for (const realTable of ABSORB_TABLES) {
      const { rows: lineageRows } = await tgtClient.query(
        `SELECT target_row_id FROM pipeline_migration_row_ids WHERE source_db=$1 AND source_table=$2`,
        [sourceDb, realTable]
      );
      await tgtClient.query('BEGIN');
      try {
        const ids = lineageRows.map((r) => r.target_row_id);
        let deleted = 0;
        if (ids.length > 0) {
          const res = await tgtClient.query(`DELETE FROM ${realTable} WHERE id = ANY($1::int[])`, [ids]);
          deleted = res.rowCount;
        }
        await tgtClient.query(`DELETE FROM pipeline_migration_row_ids WHERE source_db=$1 AND source_table=$2`, [sourceDb, realTable]);
        const label = ABSORB_MANIFEST_LABELS[realTable];
        await tgtClient.query(`DELETE FROM migration_manifest WHERE source_db=$1 AND source_table=$2`, [sourceDb, label]);
        await tgtClient.query(`DELETE FROM migration_manifest_row_hashes WHERE source_db=$1 AND source_table=$2`, [sourceDb, label]);
        await tgtClient.query('COMMIT');
        totalDeleted += deleted;
        log(`  [ROLLBACK] ${realTable}/${sourceDb}: deleted ${deleted} row(s) + lineage/manifest (label=${label})`);
      } catch (err) {
        await tgtClient.query('ROLLBACK');
        throw err;
      }
    }
  }
  return { totalDeleted };
}

async function rollbackExclusions(tgtClient, log, excludedSourceDbs = EXCLUDED_SOURCE_DBS) {
  for (const sourceDb of Object.keys(excludedSourceDbs)) {
    for (const realTable of ABSORB_TABLES) {
      const label = ABSORB_MANIFEST_LABELS[realTable];
      await tgtClient.query(`DELETE FROM migration_manifest_row_hashes WHERE source_db=$1 AND source_table=$2`, [sourceDb, label]);
      const del = await tgtClient.query(`DELETE FROM migration_manifest WHERE source_db=$1 AND source_table=$2`, [sourceDb, label]);
      if (del.rowCount) log(`  [ROLLBACK] excluded slice ${sourceDb}/${label}: cleared ${del.rowCount} manifest row(s)`);
    }
  }
}

// ─── MAIN ───────────────────────────────────────────────────────────────────

/**
 * FIELD-FOUND FIX (independent review, PR #190, 2026-08-17): main() is
 * reachable IN-PROCESS via run(targetDbName) (verify-15-t8-idempotency.js's
 * documented --rerun-module contract, no child_process). Every refusal path
 * that IS reachable via run() now RETURNS `true`/`false` (pass/fail)
 * instead of calling `process.exit()` -- a `process.exit()` here would kill
 * the entire calling harness process (e.g. T8's own diff/T6-recheck/
 * cleanup), not just this script's own run. Only `process.exit(2)` (bad
 * CLI usage) and `process.exit(0)` (--help) remain, because run() always
 * constructs a well-formed `--db <name>` argv itself and can never reach
 * either of those two branches -- they are exclusively reachable from the
 * `require.main === module` CLI entry point at the bottom of this file,
 * which is the ONE place in this script allowed to touch process exit
 * state at all (mirrors the "CLI path keeps its exit-code behavior, run()
 * never touches process exit state" shape used elsewhere in this repo).
 *
 * @returns {Promise<boolean>} true = PASS, false = refused/FAIL.
 */

/**
 * FIELD-FOUND FIX (CI run on PR #190's own fix commit, 2026-08-17): a fresh
 * checkout has NO `file-memory-project-enrollment.json` (gitignored, never
 * committed) -- exactly the environment this PR's own RUN-1/RUN-2 tests
 * (and, in production, a fresh CI/CD box actually plugging run() into
 * verify-15-t8-idempotency.js) run in. `migrate04.loadDbTriage` and
 * `migrate09.loadEnrollmentConfig` -- unlike everything else in THIS file
 * -- still call `process.exit(1)` on a missing/malformed config file (their
 * own FATAL-message pattern, shared with their own scripts' CLI entry
 * points). Both are called unconditionally, early in main(), reachable via
 * run() for exactly the same reason the three cited process.exit(1) calls
 * were. Rewriting loadDbTriage/loadEnrollmentConfig themselves is out of
 * this PR's scope (different files, their OWN callers/tests depend on the
 * current CLI exit-on-missing-file behavior) -- this wrapper is main()'s
 * OWN defense so THIS script's run() contract holds regardless of what its
 * dependencies do. Both loaders are synchronous (fs.readFileSync, never an
 * await) so there is no window for a concurrent async caller to observe
 * the temporarily-swapped process.exit.
 */
class ConfigLoadExitAttempted extends Error {
  constructor(code) {
    super(`process.exit(${code}) attempted inside a config loader`);
    this.code = code;
  }
}
function loadConfigWithoutExit(fn) {
  const originalExit = process.exit;
  process.exit = (code) => { throw new ConfigLoadExitAttempted(code); };
  try {
    return { ok: true, value: fn() };
  } catch (err) {
    if (err instanceof ConfigLoadExitAttempted) return { ok: false };
    throw err;
  } finally {
    process.exit = originalExit;
  }
}

async function main() {
  let parsed;
  try {
    parsed = parseArgs(process.argv.slice(2));
  } catch (err) {
    if (err instanceof UsageError) {
      console.error(`Error: ${err.message}`);
      printUsage();
      process.exit(2);
    }
    throw err;
  }
  if (parsed.help) {
    printUsage();
    process.exit(0);
  }

  const { name: target, source: targetSource } = migrateOne.resolveTargetDb({ db: parsed.db });
  if (!migrateOne.DB_NAME_RE.test(target)) {
    console.error(`Invalid database name "${target}" (from ${targetSource}) — must match /^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/.`);
    return false;
  }
  const classification = await migrateOne.classifyTarget({ dbName: target });
  if (!classification.allowed) {
    console.error(`Refused: ${classification.reason}`);
    console.error(`(resolved from ${targetSource} — no database connection was opened.)`);
    return false;
  }

  const dbTriageResult = loadConfigWithoutExit(() => migrate04.loadDbTriage(parsed.dbTriagePath));
  if (!dbTriageResult.ok) return false; // FATAL diagnostic already printed by loadDbTriage itself
  const dbTriage = dbTriageResult.value;

  const enrollmentResult = loadConfigWithoutExit(() => migrate09.loadEnrollmentConfig(parsed.enrollmentConfigPath));
  if (!enrollmentResult.ok) return false; // FATAL diagnostic already printed by loadEnrollmentConfig itself
  const enrollmentConfig = enrollmentResult.value;

  console.log(`migrate-05-sync-file-memory: target="${target}" (resolved from ${targetSource}) mode=${parsed.rollback ? 'ROLLBACK' : parsed.dryRun ? 'DRY-RUN' : 'MIGRATE'}`);

  const tgtClient = new Client(migrateOne.pgConfig(target));
  await tgtClient.connect();

  const report = { target, mode: parsed.rollback ? 'rollback' : parsed.dryRun ? 'dry-run' : 'migrate' };

  try {
    const { rows: tblRows } = await tgtClient.query(
      `SELECT table_name FROM information_schema.tables WHERE table_schema=current_schema() AND table_name = ANY($1::text[]) AND table_type='BASE TABLE'`,
      [PREREQUISITE_TABLES]
    );
    const found = new Set(tblRows.map((r) => r.table_name));
    const missingTables = PREREQUISITE_TABLES.filter((t) => !found.has(t));
    if (missingTables.length) {
      console.error(`Refused: target "${target}" is missing table(s): ${missingTables.join(', ')}. Run migrate-01-canonical-db.js first.`);
      return false;
    }
    const { rows: colRows } = await tgtClient.query(`SELECT table_name, column_name FROM information_schema.columns WHERE table_schema=current_schema()`);
    const colSet = new Set(colRows.map((r) => `${r.table_name}.${r.column_name}`));
    const missingCols = PREREQUISITE_COLUMNS.filter((c) => !colSet.has(`${c.table}.${c.column}`));
    if (missingCols.length) {
      console.error(`Refused: target "${target}" is missing column(s): ${missingCols.map((c) => `${c.table}.${c.column}`).join(', ')}. Run migrate-03-corpus-project-id.js first.`);
      return false;
    }

    await shared.applyDdl(tgtClient); // migration_manifest + pipeline_migration_row_ids + siblings
    await migrateOne.applySqlFile(tgtClient, SQL_FILE); // drop UNIQUE(source_file), plain indexes

    // ── enumerate + classify memory/-bearing dirs (used by MIGRATE and ROLLBACK alike) ──
    const memoryBearingDirs = migrate09.enumerateMemoryBearingDirs(parsed.projectsRoot);
    const enrolledProjects = [];
    let testArtifactCount = 0, unmatchedCount = 0;
    for (const dir of memoryBearingDirs) {
      const cls = migrate09.classifyProjectDir(dir.dirName, enrollmentConfig);
      if (cls.bucket === 'enrolled') {
        enrolledProjects.push({ projectId: cls.projectId, dirName: dir.dirName, memoryDirPath: dir.memoryDirPath });
      } else if (cls.bucket === 'test-artifact-excluded') {
        testArtifactCount++;
        console.log(`  [TEST-ARTIFACT-EXCLUDED] dir_name="${dir.dirName}" (matched pattern /${cls.matchedPattern}/) — never enrolled`);
      } else {
        unmatchedCount++;
        console.log(`  [UNMATCHED-FLAGGED] dir_name="${dir.dirName}" — memory/-bearing but not enrolled and not a recognized test artifact; owner-review line-item.`);
      }
    }
    console.log(`Enumeration: ${memoryBearingDirs.length} memory/-bearing dir(s) -> ${enrolledProjects.length} enrolled, ${testArtifactCount} test-artifact-excluded, ${unmatchedCount} unmatched-flagged`);
    report.enumeration = { total: memoryBearingDirs.length, enrolled: enrolledProjects.length, testArtifactExcluded: testArtifactCount, unmatchedFlagged: unmatchedCount };

    if (parsed.rollback) {
      let totalEntriesDeleted = 0;
      for (const proj of enrolledProjects) {
        const fsDb = filesystemSourceDb(proj.memoryDirPath);
        const r = await rollbackDir(tgtClient, fsDb, console.log);
        totalEntriesDeleted += r.deletedEntries;
      }
      const absorbResult = await rollbackAbsorb(tgtClient, console.log);
      await rollbackExclusions(tgtClient, console.log);
      console.log(`ROLLBACK_RESULT: PASS (step_c_entries_deleted=${totalEntriesDeleted}, step_a_rows_deleted=${absorbResult.totalDeleted})`);
      return true;
    }

    // ── STEP A ──────────────────────────────────────────────────────────
    const stepA = await runStepA(tgtClient, dbTriage, parsed.dryRun, console.log);
    if (stepA.refused) {
      report.stepA = { refused: true, misclassified: stepA.misclassified };
      console.log(JSON.stringify(report, null, 2));
      console.log('MIGRATION_RESULT: FAIL (Step A refused -- see db-triage classification errors above)');
      return false;
    }
    report.stepA = { perSlice: stepA.perSlice, precheckFailures: stepA.precheckFailures };
    console.log('Step A (DB-absorb) per-slice report:');
    let stepAReconciliationFailures = 0;
    for (const s of stepA.perSlice) {
      const ok = s.dryRun || (s.migrated + s.alreadyMigrated + (s.orphanParents || 0) === s.source);
      if (!ok) stepAReconciliationFailures++;
      console.log(`  - ${s.sourceDb}.${s.table} / project_id="${s.projectId}": source=${s.source} migrated=${s.migrated} already-migrated=${s.alreadyMigrated} ${ok ? 'RECONCILED' : '[RECONCILIATION-FAIL]'}`);
    }
    if (stepA.precheckFailures.length > 0) {
      console.error(`Step A precondition failures (${stepA.precheckFailures.length}):`);
      for (const f of stepA.precheckFailures) console.error(`  - ${f}`);
    }

    // ── STEP B ──────────────────────────────────────────────────────────
    const stepB = await runStepB(tgtClient, parsed.dryRun, console.log);
    report.stepB = { exclusions: stepB };
    console.log('Step B (exclusions) per-slice report:');
    for (const e of stepB) console.log(`  - [EXCLUDED] ${e.table} source_db="${e.sourceDb}": ${e.source} row(s) excluded_reason="${e.reason}"`);

    // ── STEP C ──────────────────────────────────────────────────────────
    const divergenceMap = parsed.dryRun ? new Map() : await buildDivergenceMap(tgtClient);
    const perDir = [];
    for (const proj of enrolledProjects) {
      const r = await processEnrolledDir(tgtClient, proj.projectId, proj.dirName, proj.memoryDirPath, divergenceMap, parsed.dryRun, console.log);
      perDir.push({ projectId: proj.projectId, dirName: proj.dirName, ...r.counts });
      console.log(`  [OK] project_id="${proj.projectId}" dir="${proj.dirName}": ${r.counts.total} file(s) -> new=${r.counts.new} adopted=${r.counts.adopted} live-matched-changed=${r.counts.liveMatchedChanged} live-matched-unchanged=${r.counts.liveMatchedUnchanged} file-gone=${r.counts.fileGone}`);
    }
    report.stepC = { perDir };

    const pass = stepA.precheckFailures.length === 0 && stepAReconciliationFailures === 0;
    report.result = pass ? 'PASS' : 'FAIL';
    console.log(JSON.stringify(report, null, 2));
    console.log(`MIGRATION_RESULT: ${pass ? 'PASS' : 'FAIL'} (step_a_precheck_failures=${stepA.precheckFailures.length}, step_a_reconciliation_failures=${stepAReconciliationFailures})`);
    return pass;
  } finally {
    await tgtClient.end();
  }
}

if (require.main === module) {
  main()
    .then((ok) => { process.exitCode = ok ? 0 : 1; })
    .catch((err) => {
      console.error(err && err.stack ? err.stack : err);
      process.exitCode = 1;
    });
}

/**
 * T8-idempotency-compatible entry point (verify-15-t8-idempotency.js's
 * `--rerun-module` contract: an async `run(targetDbName)` function, called
 * IN-PROCESS). Reuses the exact same db-triage/enrollment-config resolution
 * main() itself uses (env vars / default paths), just with the target name
 * pinned. This is the first migrate-NN-*.js script in this repo to export
 * this shape -- verify-15-t8-idempotency.js's own header comment names the
 * absence of any pluggable script as a stated blind spot; this closes it
 * for phase (f) specifically.
 *
 * FIELD-FOUND FIX (independent review, PR #190, 2026-08-17): run() now
 * returns main()'s own boolean result directly and never reads or writes
 * `process.exitCode` -- the prior `process.exitCode === 0 || undefined`
 * read was itself fragile (a global, process-wide flag that could already
 * be non-zero for a reason unrelated to this call, or left stale by a
 * concurrent caller), on top of the process.exit() crash this same review
 * found. run() is now a pure in-process call: it can only resolve `true`/
 * `false` or reject with whatever main() itself throws -- never terminate
 * the host process.
 */
async function run(targetDbName) {
  const argv = ['--db', targetDbName];
  process.argv = [process.argv[0], process.argv[1] || __filename, ...argv];
  return main();
}

module.exports = {
  parseArgs,
  UsageError,
  printUsage,
  main,
  run,
  sha256,
  checkAbsorbColumnShape,
  insertAbsorbedEntryRow,
  insertAbsorbedChunkRow,
  groupByProjectId,
  absorbTable,
  runStepA,
  runStepB,
  buildDivergenceMap,
  extractDescription,
  processTopicFile,
  findFileGoneRows,
  writeDirManifestSlices,
  processEnrolledDir,
  rollbackDir,
  rollbackAbsorb,
  rollbackExclusions,
  ABSORB_SOURCE_DBS,
  ABSORB_TABLES,
  ABSORB_COLUMN_MAPS,
  ABSORB_MANIFEST_LABELS,
  ORPHAN_NULL_PROJECT_BUCKET,
  EXCLUDED_SOURCE_DBS,
  SOURCE_TABLE_RAW_ENTRIES,
  SOURCE_TABLE_RAW_CHUNKS,
  CHUNK_CEILING,
  SQL_FILE,
  DB_TRIAGE_PATH,
  ENROLLMENT_CONFIG_PATH,
  PREREQUISITE_TABLES,
  PREREQUISITE_COLUMNS,
};
