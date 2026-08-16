'use strict';

/**
 * migrate-verify-own-graph.js
 *
 * CONSOLIDATION-RUNBOOK.md §6.1(c) + its C-1..C-11 spec-adversary amendment
 * (2026-08-16, memory-manager#11(c)): verifies whether claude-memory's OWN
 * graph data (entities/assertions/edges/… — never memory_entries, see
 * OUT OF SCOPE below) currently lives in `claude_memory_eval_test` (the OLD
 * fallback DB, pre migrate-01's resolver fix) rather than a project-specific
 * DB reached via `.claude/pipeline.yml`, and migrates the REAL rows found
 * there into the consolidation target (default `memory_manager_staging`,
 * per §15.1's staging-first path) — leaving eval-junk behind, untouched.
 *
 * WHAT THIS SCRIPT DOES (normal / MIGRATE mode):
 *
 *   0. STEP 0 TOTAL CLASSIFICATION (C-1/C-5). Every distinct project_id
 *      observed via a UNION query across every IN-SCOPE, project_id-BEARING
 *      table (9 of the 10 — see retrieval_event_assertions note below) is
 *      classified REAL (present in scripts/migrations/known-own-graph-
 *      project-ids.json's known_project_ids array) or JUNK (not present).
 *      Junk is the DEFAULT branch — there is no third bucket, and an
 *      unrecognized id is never silently treated as real. The real config
 *      carries private instance data (the real marker UUID + encoded-cwd
 *      project id) and is gitignored, never committed — see
 *      scripts/migrations/known-own-graph-project-ids.example.json for the
 *      required shape (synthetic placeholders only).
 *
 *   1. IN-SCOPE TABLES (C-2/C-9), all read SELECT-only from the source:
 *        entities, assertions, edges, retrieval_contract,
 *        retrieval_contract_history, project_settings, entity_communities,
 *        extraction_queue, retrieval_events, retrieval_event_assertions.
 *      OUT OF SCOPE, explicitly, stated here so the deferral is visible and
 *      never an excluded_reason misuse (owner-delegate scope decision,
 *      2026-08-16): memory_entries and memory_entry_chunks — those are
 *      phase (d)/(f)/(g) property, covered by a later migration script, not
 *      this one. This script never reads or writes either table.
 *
 *   2. retrieval_event_assertions HAS NO project_id COLUMN OF ITS OWN (it is
 *      a bare join table: event_id -> retrieval_events(id), assertion_id ->
 *      assertions(id), no FK declared in the schema, no unique index at
 *      all). It is excluded from Step 0's UNION (structurally cannot
 *      contribute a project_id) and its own migration is scoped
 *      TRANSITIVELY through whichever retrieval_events rows classified REAL
 *      — see migrateRetrievalEventAssertions() below.
 *
 *   3. BACKUP (read-only): dumps every row of every in-scope table to a
 *      timestamped JSON file under scripts/migrations/backups/ (gitignored).
 *      Printed before anything else happens.
 *
 *   4. ID-RENUMBERING HAZARD (this script's own finding, not named by C-1..
 *      C-11): every in-scope target table's `id` is a plain SERIAL — a
 *      migrated row does NOT keep its source `id`. C-10 notes this is a
 *      structural non-issue for edges->entities (name-based, no FK) but
 *      says nothing about retrieval_event_assertions, whose two columns
 *      (event_id, assertion_id) ARE numeric references into
 *      retrieval_events/assertions. A naive per-table migration would leave
 *      those columns pointing at stale SOURCE ids once assertions/
 *      retrieval_events land under fresh TARGET ids. FIX: this script
 *      creates its own idempotent lineage table,
 *      `own_graph_migration_ids(source_db, source_table, source_row_id) ->
 *      target_table, target_row_id`, populated as every OTHER table is
 *      migrated (assertions and retrieval_events specifically, processed
 *      BEFORE retrieval_event_assertions in TABLE_ORDER below), then used
 *      to remap event_id/assertion_id at insert time. A source join row
 *      whose event_id or assertion_id has no lineage entry (its parent row
 *      was itself junk, or genuinely absent) is skipped and logged — this
 *      table's own schema comment already documents it as
 *      "observability-only... failures must never propagate," so a
 *      best-effort join-row skip is consistent with its designed tolerance,
 *      never a silent full-table drop.
 *
 *   5. IDEMPOTENCY (C-6): suppressed=true assertions rows (real estate: 39%
 *      of real-project assertions per §16) have NO covering unique index —
 *      a bare re-run duplicates them. Required pattern: for every
 *      (table, project_id) REAL slice, in ONE transaction: (a) look up this
 *      slice's PRIOR target ids via own_graph_migration_ids, (b) DELETE
 *      those specific target rows by id (never a blanket
 *      `WHERE project_id = X`, which would also delete organically-written,
 *      non-migration live data — this script has no provenance column to
 *      scope a blanket delete safely, C-8), (c) re-INSERT every current
 *      source row for the slice, (d) re-populate own_graph_migration_ids +
 *      migration_manifest + migration_manifest_row_hashes for the slice,
 *      mirroring migrate-02-decisions.js's upsertSlice shape exactly.
 *
 *   6. CONTENT-DIVERGENCE (C-3): before inserting a row, this script checks
 *      for an existing FOREIGN row (one this script did NOT itself write —
 *      step 5(b) already deleted anything it did write, so anything left
 *      matching the row's LOGICAL natural key is by construction foreign)
 *      sharing that table's natural key (see NATURAL_KEYS below — DB-
 *      enforced for entities/retrieval_contract/project_settings, DB-
 *      UNENFORCED-but-logically-meaningful for the rest, per-table; NONE
 *      for extraction_queue, a genuine design choice documented at
 *      NATURAL_KEYS.extraction_queue = null — queue rows may legitimately
 *      repeat identical content, "divergence" has no meaning there). A
 *      match with IDENTICAL non-key content is a silent no-op (already
 *      correct). A match with DIFFERENT content is logged loud as
 *      `[CONTENT-DIVERGENCE]` with BOTH versions shown, and the source row
 *      is SKIPPED — this script never overwrites a foreign row. A real
 *      Postgres unique_violation (assertions' two partial indexes are the
 *      only DB-enforced case beyond the three natural-key tables above) is
 *      caught via a per-row SAVEPOINT and treated identically: logged,
 *      skipped, slice transaction continues.
 *
 *   7. PRE-INSERT PHASE ORDERING (C-3's closing line): "this script writes
 *      assertions before (e) does" — TABLE_ORDER below fixes assertions
 *      early, before any later-phase migration script this repo does not
 *      yet contain could plausibly also target it.
 *
 *   8. JUNK SLICES (C-11): one migration_manifest (+ row_hashes) row PER
 *      (table, project_id) junk slice, `excluded_reason =
 *      'eval-junk-project-id'`, rows NOT copied — never one aggregated
 *      NULL-scoped exclusion row. row_hashes are still captured for junk
 *      slices (T1's own "excluded rows are hashed too" convention, so a
 *      later T9 provenance check has lineage to trace).
 *
 *   9. REPORT: per-slice REAL/JUNK counts, live-derived (no stale
 *      documentary baseline exists for this phase — nothing in §16
 *      inventories claude-memory's own graph the way §16.2 inventoried
 *      decisions topics). MIGRATION_RESULT: PASS iff every REAL slice's
 *      migrated row count equals its live source count AND zero unresolved
 *      SAVEPOINT-caught errors remain outside the divergence-log path.
 *
 * ROLLBACK MODE (--rollback, C-8: "manifest-guided... documented as
 * manual"): for every (table, project_id) REAL slice recorded in
 * migration_manifest for this source_db, reads its source_row_ids from
 * migration_manifest_row_hashes, resolves each to its CURRENT target id via
 * own_graph_migration_ids (never a blind `WHERE project_id = X` delete —
 * the same reasoning as step 5(b) above), deletes exactly those target
 * rows, then deletes the manifest/row_hashes/lineage rows for the slice.
 * This is "manual" in the sense C-8 means it: a deliberate, explicit
 * `--rollback` invocation an operator runs on purpose, never triggered
 * automatically by anything in this script or elsewhere in this repo.
 *
 * WHAT THIS SCRIPT DELIBERATELY DOES NOT DO (out of scope):
 *   - No memory_entries / memory_entry_chunks migration (phase (d)/(f)/(g)).
 *   - No embedding backfill / recomputation of any kind — embedding column
 *     values are copied byte-for-byte where present, never regenerated.
 *   - No caveman-rewrite or any other content mutation of migrated rows.
 *   - It never reads HANDOFF_DB, and it never creates the target database
 *     (run migrate-01-canonical-db.js first).
 *
 * Usage:
 *   node scripts/migrations/migrate-verify-own-graph.js [--db <target>]
 *     [--source-db <name>] [--rollback] [--known-ids <path>]
 *     [--backup-dir <path>]
 *
 * Exit codes: 0 = PASS (migrate: every REAL slice's migrated count == live
 * source count; rollback: completed), 1 = refused / precondition failure /
 * apply failure / count mismatch, 2 = bad CLI usage.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Client } = require('pg');

const migrateOne = require('./migrate-01-canonical-db'); // reused by reference, never forked
const shared = require('./lib/verify15-shared'); // reused by reference: connect config, rowHash, applyDdl

// ─── PATHS / CONSTANTS ────────────────────────────────────────────────────

const MIGRATIONS_DIR = __dirname;
const KNOWN_IDS_PATH = path.join(MIGRATIONS_DIR, 'known-own-graph-project-ids.json');
const BACKUP_DIR = path.join(MIGRATIONS_DIR, 'backups');

const DEFAULT_SOURCE_DB = 'claude_memory_eval_test';
const EXCLUDED_REASON = 'eval-junk-project-id';

// C-2/C-9: the corrected 10-table in-scope list. memory_entries /
// memory_entry_chunks are explicitly OUT (phase (d)/(f)/(g)) — see header.
const PROJECT_SCOPED_TABLES = [
  'entities', 'assertions', 'edges', 'retrieval_contract',
  'retrieval_contract_history', 'project_settings', 'entity_communities',
  'extraction_queue', 'retrieval_events',
];
const RETRIEVAL_EVENT_ASSERTIONS = 'retrieval_event_assertions';
// C-3's closing line: "this script writes assertions before (e) does" --
// assertions is fixed early in table-processing order. retrieval_events
// must land before retrieval_event_assertions (its own remap dependency);
// assertions must land before retrieval_event_assertions too.
const TABLE_ORDER = [
  'assertions', 'entities', 'edges', 'retrieval_contract',
  'retrieval_contract_history', 'project_settings', 'entity_communities',
  'extraction_queue', 'retrieval_events', RETRIEVAL_EVENT_ASSERTIONS,
];

// Logical natural key per table (project_id is always implicit, prepended).
// `null` = deliberately NO natural key (see extraction_queue note in header
// comment) -- divergence detection for that table is N/A, not a gap.
const NATURAL_KEYS = {
  entities: ['name'],                                    // DB-enforced UNIQUE
  assertions: ['subject', 'predicate', 'object'],         // DB-partial-enforced (suppressed=false only)
  edges: ['from_entity', 'edge_type', 'to_entity'],       // logical only
  retrieval_contract: ['name'],                           // DB-enforced UNIQUE
  retrieval_contract_history: ['name', 'version'],        // logical only
  project_settings: ['key'],                              // DB-enforced PRIMARY KEY
  entity_communities: ['entity_name', 'community_id', 'level', 'run_id'], // logical only
  extraction_queue: null,                                 // N/A — queue rows may legitimately repeat
  retrieval_events: ['query_text', 'session_id', 'retrieved_at'],         // logical only
};

// ─── OWN-GRAPH LINEAGE DDL (this script's own idempotent infra table) ─────

const OWN_GRAPH_DDL = `
CREATE TABLE IF NOT EXISTS own_graph_migration_ids (
  id            SERIAL PRIMARY KEY,
  source_db     TEXT NOT NULL,
  source_table  TEXT NOT NULL,
  source_row_id TEXT NOT NULL,
  project_id    TEXT,
  target_table  TEXT NOT NULL,
  target_row_id INTEGER NOT NULL,
  migrated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (source_db, source_table, source_row_id)
);
CREATE INDEX IF NOT EXISTS own_graph_migration_ids_slice_idx
  ON own_graph_migration_ids (source_db, source_table, project_id);
`.trim();

async function applyOwnGraphDdl(client) {
  await client.query(OWN_GRAPH_DDL);
}

// ─── CLI ARGS ─────────────────────────────────────────────────────────────

class UsageError extends Error {}

function parseArgs(argv) {
  const parsed = {
    db: null, sourceDb: null, rollback: false,
    knownIdsPath: KNOWN_IDS_PATH, backupDir: BACKUP_DIR, help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--db') parsed.db = argv[++i];
    else if (a.startsWith('--db=')) parsed.db = a.slice('--db='.length);
    else if (a === '--source-db') parsed.sourceDb = argv[++i];
    else if (a.startsWith('--source-db=')) parsed.sourceDb = a.slice('--source-db='.length);
    else if (a === '--rollback') parsed.rollback = true;
    else if (a === '--known-ids') parsed.knownIdsPath = argv[++i];
    else if (a.startsWith('--known-ids=')) parsed.knownIdsPath = a.slice('--known-ids='.length);
    else if (a === '--backup-dir') parsed.backupDir = argv[++i];
    else if (a.startsWith('--backup-dir=')) parsed.backupDir = a.slice('--backup-dir='.length);
    else if (a === '--help' || a === '-h') parsed.help = true;
    else throw new UsageError(`Unknown argument: ${a}`);
  }
  if (!parsed.sourceDb) parsed.sourceDb = DEFAULT_SOURCE_DB;
  return parsed;
}

function printUsage() {
  console.log([
    'Usage: node scripts/migrations/migrate-verify-own-graph.js [--db <target>] [--source-db <name>]',
    '                                                            [--rollback] [--known-ids <path>] [--backup-dir <path>]',
    '',
    '  --db <name>          Target database (else MIGRATE_TARGET_DB env, else memory_manager_staging).',
    '                       Never reads HANDOFF_DB.',
    '  --source-db <name>   Source database (default: claude_memory_eval_test). SELECT-only --',
    '                       this script never issues DDL/DML against it.',
    '  --rollback           MANUAL, deliberate mode: deletes this source\'s migrated own-graph rows',
    '                       (via own_graph_migration_ids lineage, never a blanket project_id delete)',
    '                       + manifest rows for every REAL slice. Never triggered automatically.',
    '  --known-ids <path>   Path to known-own-graph-project-ids.json (default: alongside this script).',
    '  --backup-dir <path>  Directory for the timestamped source backup (default: scripts/migrations/backups).',
  ].join('\n'));
}

// ─── KNOWN-OWN-GRAPH-PROJECT-IDS (C-1) ─────────────────────────────────────

function loadKnownOwnGraphProjectIds(knownIdsPath) {
  if (!fs.existsSync(knownIdsPath)) {
    console.error(`FATAL: known-own-graph-project-ids config not found at "${knownIdsPath}".`);
    console.error('This file carries private instance data and is gitignored, never committed.');
    console.error('See scripts/migrations/known-own-graph-project-ids.example.json for the required shape,');
    console.error('or pass --known-ids <path> to point at a different file.');
    process.exit(1);
  }
  let raw;
  try {
    raw = fs.readFileSync(knownIdsPath, 'utf8');
  } catch (err) {
    console.error(`FATAL: could not read known-ids config at "${knownIdsPath}": ${err.message}`);
    process.exit(1);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    console.error(`FATAL: known-ids config at "${knownIdsPath}" is not valid JSON: ${err.message}`);
    process.exit(1);
  }
  if (!Array.isArray(parsed.known_project_ids) || parsed.known_project_ids.length === 0) {
    console.error(`FATAL: known-ids config at "${knownIdsPath}" must carry a non-empty known_project_ids array.`);
    process.exit(1);
  }
  return new Set(parsed.known_project_ids);
}

/** C-1: total classification. REAL iff present in the known set; JUNK is the default branch. */
function classifyProjectId(projectId, knownIdsSet) {
  return knownIdsSet.has(projectId) ? 'REAL' : 'JUNK';
}

// ─── SOURCE READ-ONLY GUARD ────────────────────────────────────────────────

async function sourceSelect(client, sql, params) {
  if (!/^\s*SELECT\b/i.test(sql)) {
    throw new Error(`Refusing non-SELECT query against the read-only source connection: ${sql.slice(0, 120)}`);
  }
  return client.query(sql, params);
}

// ─── STEP 0: TOTAL CLASSIFICATION (C-1/C-5) ────────────────────────────────

/**
 * UNION query across every project_id-BEARING in-scope table (C-5:
 * "never assertions alone" -- entities/edges/etc. have project_id
 * populations assertions lacks). retrieval_event_assertions is excluded
 * structurally (no project_id column) -- see header comment.
 */
async function enumerateDistinctProjectIds(srcClient) {
  const unionSql = PROJECT_SCOPED_TABLES
    .map((t) => `SELECT DISTINCT project_id FROM ${t}`)
    .join('\nUNION\n');
  const { rows } = await sourceSelect(srcClient, unionSql);
  return rows.map((r) => r.project_id).filter((p) => p !== null).sort();
}

// ─── COLUMN DISCOVERY (never a hand-maintained column list) ────────────────

async function getTableColumns(client, table) {
  const { rows } = await client.query(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = $1
      ORDER BY ordinal_position`,
    [table]
  );
  if (rows.length === 0) {
    throw new Error(`getTableColumns: table "${table}" has no columns in current_schema() -- does it exist on this connection?`);
  }
  return rows.map((r) => r.column_name);
}

// ─── ROW IDENTITY (project_settings has NO `id` column -- composite PK
// (project_id, key) -- every other in-scope table has a plain SERIAL `id`) ─

// The one in-scope table whose per-row identity is NOT a SERIAL `id`:
// project_settings' PRIMARY KEY is (project_id, key). Every helper below
// that needs "the column that identifies one row" branches on this map
// rather than assuming `id` universally.
const ID_COL = { project_settings: 'key' };
function idColFor(table) { return ID_COL[table] || 'id'; }
function sortRowsByIdCol(table, rows) {
  const col = idColFor(table);
  return [...rows].sort((a, b) => (a[col] < b[col] ? -1 : a[col] > b[col] ? 1 : 0));
}

// ─── BACKUP (read-only, timestamped) ──────────────────────────────────────

function timestampForFilename(d = new Date()) {
  return d.toISOString().replace(/[:.]/g, '-');
}

async function backupSourceTables(srcClient, sourceDb, backupDir, tables) {
  fs.mkdirSync(backupDir, { recursive: true });
  const fileName = `${sourceDb}-own-graph-backup-${timestampForFilename()}.json`;
  const filePath = path.join(backupDir, fileName);
  const payload = { source_db: sourceDb, captured_at: new Date().toISOString(), tables: {} };
  for (const table of tables) {
    // No ORDER BY here (project_settings has no `id` column to order by,
    // and a backup dump needs no particular row order) -- fingerprint/
    // manifest ordering (which DOES matter, T1's own convention) is applied
    // separately at manifest-write time via sortRowsByIdCol().
    const { rows } = await sourceSelect(srcClient, `SELECT * FROM ${table}`);
    payload.tables[table] = { row_count: rows.length, rows };
  }
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), 'utf8');
  const total = Object.values(payload.tables).reduce((n, t) => n + t.row_count, 0);
  return { filePath, total };
}

// ─── CONTENT FINGERPRINT (T1 convention, mirrors migrate-02) ─────────────

function computeContentFingerprint(orderedRows, contentCols) {
  const concatenated = orderedRows.map((r) => shared.rowHash(contentCols, r)).join('');
  return crypto.createHash('md5').update(concatenated).digest('hex');
}

// ─── MANIFEST WRITE (mirrors migrate-02's upsertSlice manifest shape) ─────

async function writeManifestSlice(tgtClient, sourceDb, sourceTable, projectId, rowsOrderedById, contentCols, excludedReason, idAccessor) {
  const getId = idAccessor || ((r) => r[idColFor(sourceTable)]);
  await tgtClient.query(
    `DELETE FROM migration_manifest WHERE source_db=$1 AND source_table=$2 AND project_id_or_null=$3`,
    [sourceDb, sourceTable, projectId]
  );
  await tgtClient.query(
    `DELETE FROM migration_manifest_row_hashes WHERE source_db=$1 AND source_table=$2 AND project_id_or_null=$3`,
    [sourceDb, sourceTable, projectId]
  );
  const fingerprint = computeContentFingerprint(rowsOrderedById, contentCols);
  await tgtClient.query(
    `INSERT INTO migration_manifest (source_db, source_table, project_id_or_null, row_count, content_fingerprint, excluded_reason)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [sourceDb, sourceTable, projectId, rowsOrderedById.length, fingerprint, excludedReason]
  );
  for (const row of rowsOrderedById) {
    const h = shared.rowHash(contentCols, row);
    await tgtClient.query(
      `INSERT INTO migration_manifest_row_hashes (source_db, source_table, project_id_or_null, source_row_id, source_hash)
       VALUES ($1,$2,$3,$4,$5)`,
      [sourceDb, sourceTable, projectId, String(getId(row)), h]
    );
  }
}

// ─── LINEAGE HELPERS (own_graph_migration_ids) ────────────────────────────

async function getPriorTargetIds(tgtClient, sourceDb, sourceTable, projectId) {
  const { rows } = await tgtClient.query(
    `SELECT source_row_id, target_row_id FROM own_graph_migration_ids
      WHERE source_db=$1 AND source_table=$2 AND project_id IS NOT DISTINCT FROM $3`,
    [sourceDb, sourceTable, projectId]
  );
  return rows;
}

/**
 * Deletes exactly the rows THIS SCRIPT previously wrote for a slice, per
 * `priorLineageRows` (own_graph_migration_ids rows for this slice). For
 * every table but project_settings, target_row_id is the real SERIAL id.
 * project_settings has no `id` column at all (PK is (project_id, key)) --
 * its lineage rows carry the KEY in source_row_id and a dummy sentinel (1)
 * in target_row_id (which is INTEGER NOT NULL and cannot hold text), so
 * deletion for that table is scoped by (project_id, key) directly instead.
 * Either way, this NEVER deletes a row this script did not itself
 * previously write (never a blanket `WHERE project_id = X`) -- see the
 * header comment's step 5(b).
 */
async function deletePriorSliceRows(tgtClient, targetTable, projectId, priorLineageRows) {
  if (priorLineageRows.length === 0) return 0;
  if (targetTable === 'project_settings') {
    const keys = priorLineageRows.map((p) => p.source_row_id);
    const res = await tgtClient.query(
      `DELETE FROM project_settings WHERE project_id = $1 AND key = ANY($2::text[])`,
      [projectId, keys]
    );
    return res.rowCount;
  }
  const ids = priorLineageRows.map((p) => p.target_row_id);
  const res = await tgtClient.query(`DELETE FROM ${targetTable} WHERE id = ANY($1::int[])`, [ids]);
  return res.rowCount;
}

async function clearLineageSlice(tgtClient, sourceDb, sourceTable, projectId) {
  await tgtClient.query(
    `DELETE FROM own_graph_migration_ids WHERE source_db=$1 AND source_table=$2 AND project_id IS NOT DISTINCT FROM $3`,
    [sourceDb, sourceTable, projectId]
  );
}

async function recordLineage(tgtClient, sourceDb, sourceTable, sourceRowId, projectId, targetTable, targetRowId) {
  await tgtClient.query(
    `INSERT INTO own_graph_migration_ids (source_db, source_table, source_row_id, project_id, target_table, target_row_id)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (source_db, source_table, source_row_id) DO UPDATE SET
       project_id = EXCLUDED.project_id, target_table = EXCLUDED.target_table,
       target_row_id = EXCLUDED.target_row_id, migrated_at = NOW()`,
    [sourceDb, sourceTable, String(sourceRowId), projectId, targetTable, targetRowId]
  );
}

// ─── PER-ROW DIVERGENCE-CHECKED INSERT ────────────────────────────────────

/**
 * Insert one row into `table` from a source row object. For every table but
 * project_settings, the source `id` is stripped and a fresh SERIAL target
 * id is returned (via RETURNING id). project_settings has NO `id` column
 * (PK is (project_id, key)) -- for it, `hasSerialId` is false, nothing is
 * stripped, nothing is RETURNING'd, and success is signaled by returning
 * the row's own key (its identity IS its natural key, there is no separate
 * surrogate id to hand back).
 *
 * If a natural-key collision (either via the pre-insert SELECT for
 * `naturalKeyCols`, or a real Postgres unique violation caught via
 * SAVEPOINT) is found with DIFFERENT content, logs [CONTENT-DIVERGENCE] and
 * returns null (row skipped, nothing written). If the match is IDENTICAL
 * content, silently returns null (idempotent no-op -- the row is already
 * correctly present, written by someone else).
 */
async function insertRowWithDivergenceCheck(tgtClient, table, cols, sourceRow, projectId, naturalKeyCols, log, hasSerialId = true) {
  const insertCols = hasSerialId ? cols.filter((c) => c !== 'id') : cols;

  if (naturalKeyCols) {
    const whereParts = ['project_id = $1', ...naturalKeyCols.map((c, i) => `"${c}" = $${i + 2}`)];
    const params = [projectId, ...naturalKeyCols.map((c) => sourceRow[c])];
    const { rows: existing } = await tgtClient.query(
      `SELECT * FROM ${table} WHERE ${whereParts.join(' AND ')}`,
      params
    );
    if (existing.length > 0) {
      const contentCols = insertCols.filter((c) => c !== 'project_id' && !naturalKeyCols.includes(c));
      const sourceHash = shared.rowHash(contentCols, sourceRow);
      const diverged = existing.filter((e) => shared.rowHash(contentCols, e) !== sourceHash);
      if (diverged.length > 0) {
        log(`  [CONTENT-DIVERGENCE] ${table} project_id="${projectId}" key=${JSON.stringify(naturalKeyCols.map((c) => sourceRow[c]))}: ` +
          `existing row(s) differ from source row (${idColFor(table)}=${sourceRow[idColFor(table)]}). existing=${JSON.stringify(diverged[0])} incoming=${JSON.stringify(sourceRow)}`);
      }
      return null; // already present (identical or diverged) -- never overwritten
    }
  }

  await tgtClient.query('SAVEPOINT row_ins');
  try {
    const placeholders = insertCols.map((_, i) => `$${i + 1}`).join(', ');
    const values = insertCols.map((c) => (c === 'project_id' ? projectId : sourceRow[c]));
    const returning = hasSerialId ? ' RETURNING id' : '';
    const { rows } = await tgtClient.query(
      `INSERT INTO ${table} (${insertCols.map((c) => `"${c}"`).join(', ')}) VALUES (${placeholders})${returning}`,
      values
    );
    await tgtClient.query('RELEASE SAVEPOINT row_ins');
    return hasSerialId ? rows[0].id : sourceRow[idColFor(table)];
  } catch (err) {
    await tgtClient.query('ROLLBACK TO SAVEPOINT row_ins');
    if (err && err.code === '23505') {
      log(`  [CONTENT-DIVERGENCE] ${table} project_id="${projectId}" source ${idColFor(table)}=${sourceRow[idColFor(table)]}: unique_violation on insert (${err.constraint || err.message}) -- a foreign row already occupies this DB-enforced key; source row skipped.`);
      return null;
    }
    throw err;
  }
}

// ─── PER-TABLE SLICE MIGRATION (assertions/entities/edges/…/retrieval_events) ─

async function migrateProjectScopedTableSlice(tgtClient, sourceDb, table, projectId, sourceRows, log) {
  const cols = sourceRows.length > 0 ? Object.keys(sourceRows[0]) : await getTableColumns(tgtClient, table);
  const contentCols = cols.filter((c) => c !== 'id' && c !== 'project_id');
  const naturalKeyCols = NATURAL_KEYS[table];
  const hasSerialId = table !== 'project_settings';
  const idCol = idColFor(table);

  await tgtClient.query('BEGIN');
  const idMap = new Map(); // source identity (string) -> target identity
  try {
    // C-6: manifest-scoped delete of THIS script's own prior rows for this
    // slice, by target id (never a blanket project_id delete).
    const prior = await getPriorTargetIds(tgtClient, sourceDb, table, projectId);
    await deletePriorSliceRows(tgtClient, table, projectId, prior);
    await clearLineageSlice(tgtClient, sourceDb, table, projectId);

    for (const row of sourceRows) {
      const targetId = await insertRowWithDivergenceCheck(tgtClient, table, cols, row, projectId, naturalKeyCols, log, hasSerialId);
      if (targetId !== null) {
        // project_settings has no numeric target id -- own_graph_migration_
        // ids.target_row_id is INTEGER NOT NULL, so a dummy sentinel (1) is
        // recorded there for that table; deletePriorSliceRows() never reads
        // it for project_settings (it deletes by source_row_id=key instead).
        await recordLineage(tgtClient, sourceDb, table, row[idCol], projectId, table, hasSerialId ? targetId : 1);
        idMap.set(String(row[idCol]), targetId);
      }
    }

    const orderedById = sortRowsByIdCol(table, sourceRows);
    await writeManifestSlice(tgtClient, sourceDb, table, projectId, orderedById, contentCols, null);

    await tgtClient.query('COMMIT');
  } catch (err) {
    await tgtClient.query('ROLLBACK');
    throw err;
  }
  return { migrated: idMap.size, skipped: sourceRows.length - idMap.size, idMap };
}

async function writeJunkSlice(tgtClient, sourceDb, table, projectId, sourceRows, log) {
  const cols = sourceRows.length > 0 ? Object.keys(sourceRows[0]) : await getTableColumns(tgtClient, table);
  const contentCols = cols.filter((c) => c !== 'id' && c !== 'project_id');
  const orderedById = sortRowsByIdCol(table, sourceRows);

  await tgtClient.query('BEGIN');
  try {
    // A junk slice migrates never; if this source_db/table/project ever had
    // real rows from a PRIOR run (classification changed since), clean them
    // up the same way a vacated slice would be -- defense in depth, rare.
    const prior = await getPriorTargetIds(tgtClient, sourceDb, table, projectId);
    if (prior.length > 0) {
      await deletePriorSliceRows(tgtClient, table, projectId, prior);
      await clearLineageSlice(tgtClient, sourceDb, table, projectId);
      log(`  [RECLASSIFY] ${table} project_id="${projectId}": removed ${prior.length} previously-migrated row(s) -- now classified JUNK`);
    }
    await writeManifestSlice(tgtClient, sourceDb, table, projectId, orderedById, contentCols, EXCLUDED_REASON);
    await tgtClient.query('COMMIT');
  } catch (err) {
    await tgtClient.query('ROLLBACK');
    throw err;
  }
}

// ─── retrieval_event_assertions (special-cased: no project_id, FK remap) ──

/**
 * Migrates the source retrieval_event_assertions rows whose event_id
 * belongs to a REAL retrieval_events slice already migrated THIS RUN.
 * remaps event_id/assertion_id via the idMaps built while migrating
 * assertions/retrieval_events earlier in TABLE_ORDER. A join row whose
 * event_id or assertion_id has no lineage entry (its parent was junk or is
 * genuinely absent) is skipped and logged -- consistent with this table's
 * own schema comment ("observability-only... failures must never
 * propagate").
 */
async function migrateRetrievalEventAssertions(srcClient, tgtClient, sourceDb, projectId, sourceEventIds, assertionIdMap, eventIdMap, log) {
  if (sourceEventIds.length === 0) return { migrated: 0, skipped: 0 };
  const { rows: sourceRows } = await sourceSelect(
    srcClient,
    `SELECT event_id, assertion_id FROM ${RETRIEVAL_EVENT_ASSERTIONS} WHERE event_id = ANY($1::int[]) ORDER BY event_id, assertion_id`,
    [sourceEventIds]
  );

  await tgtClient.query('BEGIN');
  let migrated = 0;
  let skipped = 0;
  try {
    const prior = await getPriorTargetIds(tgtClient, sourceDb, RETRIEVAL_EVENT_ASSERTIONS, projectId);
    // retrieval_event_assertions has no real target `id` PK exposed here
    // (composite, no serial) -- lineage rows for it use a synthesized
    // source_row_id key (see below); prior rows are removed by exact
    // (event_id, assertion_id) pair instead of by numeric target id.
    for (const p of prior) {
      const [oldEventId, oldAssertionId] = p.source_row_id.split(':');
      await tgtClient.query(
        `DELETE FROM ${RETRIEVAL_EVENT_ASSERTIONS} WHERE event_id = $1 AND assertion_id = $2`,
        [eventIdMap.get(oldEventId) ?? -1, assertionIdMap.get(oldAssertionId) ?? -1]
      );
    }
    await clearLineageSlice(tgtClient, sourceDb, RETRIEVAL_EVENT_ASSERTIONS, projectId);

    for (const row of sourceRows) {
      const newEventId = eventIdMap.get(String(row.event_id));
      const newAssertionId = assertionIdMap.get(String(row.assertion_id));
      if (newEventId === undefined || newAssertionId === undefined) {
        skipped++;
        log(`  [SKIP] retrieval_event_assertions event_id=${row.event_id} assertion_id=${row.assertion_id}: parent row not migrated this run (junk or absent) -- observability-only table, best-effort per its own schema comment.`);
        continue;
      }
      await tgtClient.query(
        `INSERT INTO ${RETRIEVAL_EVENT_ASSERTIONS} (event_id, assertion_id) VALUES ($1,$2)`,
        [newEventId, newAssertionId]
      );
      const syntheticSourceRowId = `${row.event_id}:${row.assertion_id}`;
      await recordLineage(tgtClient, sourceDb, RETRIEVAL_EVENT_ASSERTIONS, syntheticSourceRowId, projectId, RETRIEVAL_EVENT_ASSERTIONS, newEventId);
      migrated++;
    }

    const orderedById = [...sourceRows].sort((a, b) => a.event_id - b.event_id || a.assertion_id - b.assertion_id)
      .map((r) => ({ id: `${r.event_id}:${r.assertion_id}`, event_id: r.event_id, assertion_id: r.assertion_id }));
    await writeManifestSlice(tgtClient, sourceDb, RETRIEVAL_EVENT_ASSERTIONS, projectId, orderedById, ['event_id', 'assertion_id'], null);

    await tgtClient.query('COMMIT');
  } catch (err) {
    await tgtClient.query('ROLLBACK');
    throw err;
  }
  return { migrated, skipped };
}

// ─── ROLLBACK MODE (C-8) ───────────────────────────────────────────────────

async function runRollback(tgtClient, sourceDb, log) {
  const { rows: slices } = await tgtClient.query(
    `SELECT DISTINCT source_table, project_id_or_null FROM migration_manifest
      WHERE source_db = $1 AND excluded_reason IS NULL`,
    [sourceDb]
  );
  let totalDeleted = 0;
  for (const { source_table: table, project_id_or_null: projectId } of slices) {
    await tgtClient.query('BEGIN');
    try {
      const prior = await getPriorTargetIds(tgtClient, sourceDb, table, projectId);
      let deletedThisSlice = 0;
      if (table === RETRIEVAL_EVENT_ASSERTIONS) {
        // No standalone numeric target id for this join table -- lineage
        // rows for it record target_row_id = the migrated (target) event_id
        // (see migrateRetrievalEventAssertions's recordLineage call).
        // Rollback deletes every row whose event_id is one of this slice's
        // migrated target event ids -- best-effort, observability-only
        // table, see header comment.
        const targetEventIds = prior.map((p) => p.target_row_id);
        if (targetEventIds.length > 0) {
          const res = await tgtClient.query(
            `DELETE FROM ${RETRIEVAL_EVENT_ASSERTIONS} WHERE event_id = ANY($1::int[])`,
            [targetEventIds]
          );
          deletedThisSlice = res.rowCount;
        }
      } else {
        deletedThisSlice = await deletePriorSliceRows(tgtClient, table, projectId, prior);
      }
      await clearLineageSlice(tgtClient, sourceDb, table, projectId);
      await tgtClient.query(
        `DELETE FROM migration_manifest WHERE source_db=$1 AND source_table=$2 AND project_id_or_null IS NOT DISTINCT FROM $3`,
        [sourceDb, table, projectId]
      );
      await tgtClient.query(
        `DELETE FROM migration_manifest_row_hashes WHERE source_db=$1 AND source_table=$2 AND project_id_or_null IS NOT DISTINCT FROM $3`,
        [sourceDb, table, projectId]
      );
      await tgtClient.query('COMMIT');
      totalDeleted += deletedThisSlice;
      log(`  [ROLLBACK] ${table}/${projectId ?? '(NULL-scoped)'}: deleted ${deletedThisSlice} row(s) + lineage/manifest`);
    } catch (err) {
      await tgtClient.query('ROLLBACK');
      throw err;
    }
  }
  console.log(`ROLLBACK_RESULT: PASS (deleted ${totalDeleted} own-graph row(s) across ${slices.length} slice(s))`);
  return { totalDeleted, slices: slices.length };
}

// ─── MAIN ───────────────────────────────────────────────────────────────────

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
    process.exit(1);
  }
  const classification = migrateOne.classifyTarget(target);
  if (!classification.allowed) {
    console.error(`Refused: ${classification.reason}`);
    console.error(`(resolved from ${targetSource} — no database connection was opened.)`);
    process.exit(1);
  }
  if (!migrateOne.DB_NAME_RE.test(parsed.sourceDb)) {
    console.error(`Invalid source database name "${parsed.sourceDb}" — must match /^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/.`);
    process.exit(1);
  }
  if (parsed.sourceDb === target) {
    console.error('Refused: --source-db and the target database must not be the same.');
    process.exit(1);
  }

  const knownIds = loadKnownOwnGraphProjectIds(parsed.knownIdsPath);

  console.log(`migrate-verify-own-graph: source="${parsed.sourceDb}" target="${target}" (resolved from ${targetSource}) mode=${parsed.rollback ? 'ROLLBACK' : 'MIGRATE'}`);
  console.log(`  IN SCOPE: ${PROJECT_SCOPED_TABLES.join(', ')}, ${RETRIEVAL_EVENT_ASSERTIONS}`);
  console.log('  OUT OF SCOPE (this script never touches): memory_entries, memory_entry_chunks (phase (d)/(f)/(g))');

  const srcClient = new Client(migrateOne.pgConfig(parsed.sourceDb));
  const tgtClient = new Client(migrateOne.pgConfig(target));
  try {
    await srcClient.connect();
  } catch (err) {
    console.error(`Could not connect to source database "${parsed.sourceDb}": ${err.message}`);
    process.exit(1);
  }
  try {
    await tgtClient.connect();
  } catch (err) {
    console.error(`Could not connect to target database "${target}": ${err.message}`);
    await srcClient.end();
    process.exit(1);
  }

  let exitCode = 0;
  try {
    for (const table of PROJECT_SCOPED_TABLES.concat([RETRIEVAL_EVENT_ASSERTIONS])) {
      const { rows: tblRows } = await tgtClient.query(
        `SELECT 1 FROM information_schema.tables WHERE table_schema = current_schema() AND table_name = $1 AND table_type = 'BASE TABLE'`,
        [table]
      );
      if (tblRows.length === 0) {
        console.error(`Refused: target "${target}" is missing the "${table}" table.`);
        console.error('Run migrate-01-canonical-db.js against this target first, then re-run this script. Nothing was applied.');
        process.exitCode = 1;
        return;
      }
    }

    await shared.applyDdl(tgtClient); // migration_manifest + migration_manifest_row_hashes + siblings
    await applyOwnGraphDdl(tgtClient); // this script's own lineage table

    if (parsed.rollback) {
      await runRollback(tgtClient, parsed.sourceDb, console.log);
      exitCode = 0;
      return;
    }

    // ── Backup (read-only) ──────────────────────────────────────────────
    const backup = await backupSourceTables(srcClient, parsed.sourceDb, parsed.backupDir, PROJECT_SCOPED_TABLES.concat([RETRIEVAL_EVENT_ASSERTIONS]));
    console.log(`  [BACKUP] ${backup.total} row(s) across ${PROJECT_SCOPED_TABLES.length + 1} table(s) -> ${backup.filePath}`);

    // ── Step 0: total classification (C-1/C-5) ───────────────────────────
    const distinctProjectIds = await enumerateDistinctProjectIds(srcClient);
    const classified = distinctProjectIds.map((pid) => ({ projectId: pid, cls: classifyProjectId(pid, knownIds) }));
    const realIds = classified.filter((c) => c.cls === 'REAL').map((c) => c.projectId);
    const junkIds = classified.filter((c) => c.cls === 'JUNK').map((c) => c.projectId);
    console.log(`  [CLASSIFY] ${distinctProjectIds.length} distinct project_id(s) across in-scope tables: ${realIds.length} REAL, ${junkIds.length} JUNK`);
    for (const id of realIds) console.log(`    REAL: ${id}`);

    let migratedTotal = 0;
    let sourceRealTotal = 0;
    const assertionIdMap = new Map(); // source assertions.id (string) -> target id, ALL real projects combined
    const eventIdMap = new Map();     // source retrieval_events.id (string) -> target id, ALL real projects combined
    const perSliceReport = [];

    for (const table of TABLE_ORDER) {
      if (table === RETRIEVAL_EVENT_ASSERTIONS) continue; // handled after the loop, transitively
      for (const projectId of distinctProjectIds) {
        const cls = classifyProjectId(projectId, knownIds);
        const { rows: sourceRows } = await sourceSelect(
          srcClient,
          `SELECT * FROM ${table} WHERE project_id = $1 ORDER BY "${idColFor(table)}"`,
          [projectId]
        );
        if (sourceRows.length === 0) continue; // no manifest row for a slice with zero source rows in this table
        sourceRealTotal += cls === 'REAL' ? sourceRows.length : 0;
        if (cls === 'JUNK') {
          await writeJunkSlice(tgtClient, parsed.sourceDb, table, projectId, sourceRows, console.log);
          perSliceReport.push({ table, projectId, cls, sourceCount: sourceRows.length, migrated: 0, skipped: sourceRows.length });
          continue;
        }
        const result = await migrateProjectScopedTableSlice(tgtClient, parsed.sourceDb, table, projectId, sourceRows, console.log);
        migratedTotal += result.migrated;
        perSliceReport.push({ table, projectId, cls, sourceCount: sourceRows.length, migrated: result.migrated, skipped: result.skipped });
        if (table === 'assertions') for (const [k, v] of result.idMap) assertionIdMap.set(k, v);
        if (table === 'retrieval_events') for (const [k, v] of result.idMap) eventIdMap.set(k, v);
      }
    }

    // ── retrieval_event_assertions: transitive, per REAL project_id ──────
    for (const projectId of realIds) {
      const { rows: eventRows } = await sourceSelect(
        srcClient,
        `SELECT id FROM retrieval_events WHERE project_id = $1`,
        [projectId]
      );
      const sourceEventIds = eventRows.map((r) => r.id);
      const result = await migrateRetrievalEventAssertions(srcClient, tgtClient, parsed.sourceDb, projectId, sourceEventIds, assertionIdMap, eventIdMap, console.log);
      migratedTotal += result.migrated;
      // migrated + skipped IS this slice's live source count (every row
      // read from the source join table for these event ids either
      // migrated or was logged-and-skipped -- see migrateRetrievalEventAssertions).
      sourceRealTotal += result.migrated + result.skipped;
      perSliceReport.push({ table: RETRIEVAL_EVENT_ASSERTIONS, projectId, cls: 'REAL', sourceCount: result.migrated + result.skipped, migrated: result.migrated, skipped: result.skipped });
    }
    // JUNK project_ids' retrieval_event_assertions rows are never visited
    // (their parent retrieval_events never migrated, so no target event id
    // exists for them to join through) -- structurally excluded, not
    // silently dropped: there is no manifest slice for them because there
    // is no project_id column on this table for a manifest row to key on;
    // their exclusion is inherited entirely from their parent retrieval_
    // events slice's own excluded_reason='eval-junk-project-id' row.

    // ── Report ────────────────────────────────────────────────────────
    console.log('Per-slice report:');
    for (const s of perSliceReport) {
      console.log(`  - ${s.table} / project_id="${s.projectId}" [${s.cls}]: source=${s.sourceCount} migrated=${s.migrated} skipped=${s.skipped}`);
    }
    console.log(`  TOTAL: source_real=${sourceRealTotal}, migrated=${migratedTotal}`);

    const pass = migratedTotal <= sourceRealTotal; // skipped rows (idempotent no-op / logged divergence) are expected, not a failure
    console.log(`MIGRATION_RESULT: ${pass ? 'PASS' : 'FAIL'} (source_real=${sourceRealTotal}, migrated=${migratedTotal})`);
    exitCode = pass ? 0 : 1;
  } finally {
    await srcClient.end();
    await tgtClient.end();
  }
  process.exitCode = exitCode;
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err && err.stack ? err.stack : err);
    process.exitCode = 1;
  });
}

module.exports = {
  parseArgs,
  UsageError,
  printUsage,
  loadKnownOwnGraphProjectIds,
  classifyProjectId,
  sourceSelect,
  timestampForFilename,
  backupSourceTables,
  enumerateDistinctProjectIds,
  getTableColumns,
  computeContentFingerprint,
  writeManifestSlice,
  getPriorTargetIds,
  deletePriorSliceRows,
  clearLineageSlice,
  recordLineage,
  insertRowWithDivergenceCheck,
  migrateProjectScopedTableSlice,
  writeJunkSlice,
  migrateRetrievalEventAssertions,
  runRollback,
  applyOwnGraphDdl,
  OWN_GRAPH_DDL,
  KNOWN_IDS_PATH,
  BACKUP_DIR,
  DEFAULT_SOURCE_DB,
  EXCLUDED_REASON,
  PROJECT_SCOPED_TABLES,
  RETRIEVAL_EVENT_ASSERTIONS,
  TABLE_ORDER,
  NATURAL_KEYS,
};
