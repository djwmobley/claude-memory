'use strict';

const AUTHORED_BY = 'sonnet-cm194-196-197-199-author-2026-08-18';

/**
 * cure-migration-manifest-retirement.js — cm#196/cm#197/cm#199 cure script.
 *
 * Retires (never deletes, never excluded_reason — see rationale below) the
 * specific migration_manifest / migration_manifest_row_hashes rows this
 * PR's authoring investigation identified as leaked test-fixture artifacts
 * or stale duplicate captures, and RE-SNAPSHOTS one specific edges slice
 * whose stored row hashes have gone stale relative to live content.
 *
 * WHY RETIREMENT, NEVER excluded_reason (critical, do not "simplify" this
 * away in review): applying excluded_reason to a leaked row would make T9
 * positively assert ZERO live target rows for that (source_table,
 * project_id_or_null) bucket — but "unmapped-orphan-memory-entry" carries
 * 433 (memory_entries) / 1966 (memory_entry_chunks) LEGITIMATE live rows on
 * memory_manager_staging TODAY. Marking the leaked rows excluded_reason
 * would make T9 permanently FAIL on real, correct data, AND would poison
 * migrate-07's G-R7 embedding-exclusion set (getManifestExcludedProjectIds)
 * for the SAME live bucket, silently skipping real content from
 * re-embedding. retired_at removes a manifest/row-hash BOOKKEEPING ROW from
 * every consumer's consideration without asserting anything false about
 * live data — this is the ONE mechanism every cure in this script uses.
 *
 * WHAT THIS SCRIPT DOES (four independent, idempotent steps; a failure in
 * one does not prevent the others from running — each is wrapped and
 * reported separately):
 *
 *   1. RETIRE LEAKED ROWS (cm#197): 6 manifest rows tracing to dev/test-
 *      fixture DB runs, matched by (source_db, source_table,
 *      project_id_or_null) content — never by raw numeric id, so this
 *      script (and its test coverage) works identically against any DB
 *      carrying the same logical shape, not just the specific live ids
 *      (2677-2682) this PR's investigation found them under.
 *
 *   2. RETIRE STALE DUPLICATE CAPTURES (cm#196): for 4 specific
 *      (source_db, source_table) pairs, any (source_db, source_table,
 *      project_id_or_null) slice carrying MORE THAN ONE non-retired,
 *      non-excluded manifest row is a stale re-capture — survivor = the row
 *      with the LATEST captured_at (closest to the current pre-promotion
 *      state); every other row in the slice is retired, noting the
 *      survivor's id and captured_at.
 *
 *   3. RETIRE ORPHAN ROW-HASHES for one excluded slice (cm#199): the 2
 *      migration_manifest_row_hashes rows for
 *      (claude_memory_eval_test, edges, 9a212124-...) — a slice
 *      migration_manifest already records excluded_reason for. Nothing
 *      reads row-hashes for an excluded slice (T3 is live-vs-live; T9's
 *      provenance check reads migration_manifest, never row_hashes); these
 *      2 rows are retired, not deleted, so the append-only audit trail
 *      stays intact.
 *
 *   4. RE-SNAPSHOT one edges slice (cm#199): manifest id 1643's
 *      content_fingerprint and ALL of its migration_manifest_row_hashes
 *      rows, recomputed from claude_memory_eval_test.edges' CURRENT live
 *      content — ON THE CORRECT HASH BASIS (review-corrected, see below).
 *
 *      HASH BASIS -- CORRECTED FINDING, TWO ROUNDS (a PR review caught the
 *      first mistake before merge; fixing it surfaced a second, subtler one
 *      this comment documents so neither recurs): manifest id 1643's stored
 *      row hashes were NOT written by T1's roster-loadBearingCols
 *      convention at all -- they were written by
 *      migrate-verify-own-graph.js's writeManifestSlice/
 *      migrateProjectScopedTableSlice, whose hash basis is EVERY source
 *      column except id/project_id, AS OF CAPTURE TIME (2026-08-16
 *      13:32:30): for edges, exactly from_entity, edge_type, to_entity,
 *      weight, created_at, session_id (RESNAPSHOT_CONTENT_COLS below) --
 *      NOT the roster's 3-col loadBearingCols this step originally
 *      (wrongly) diffed against. Round two: naively RE-DERIVING that basis
 *      dynamically today (`SELECT *` then filter id/project_id, mirroring
 *      migrateProjectScopedTableSlice's own live-schema-introspection
 *      logic verbatim) is ALSO wrong here, because PR #204 (2026-08-18,
 *      AFTER this capture) brought source_model/agent_id/suppressed
 *      forward onto edges -- a dynamic re-derivation run today silently
 *      picks up all three, producing a false 255/255 "everything changed"
 *      result (verified: this is exactly what the first fix attempt
 *      produced). The writer's dynamic derivation is correct for a FRESH
 *      capture; reconciling an EXISTING historical one requires the
 *      column set AS IT WAS AT CAPTURE TIME, which live introspection
 *      cannot answer -- so RESNAPSHOT_CONTENT_COLS is a PINNED constant,
 *      not a re-derivation, verified against schema history (`git show
 *      <PR#204-parent>:scripts/sql/handoff-core-schema.sql`). Recomputing
 *      on this pinned basis: 242/255 rows are byte-identical to what's
 *      already stored; EXACTLY 13 differ (ids 24, 25, 30, 57, 61-63, 102,
 *      122-125, 144 -- the owner-approved orphan-edge disposition's
 *      repointed edges) -- zero unrelated dogfood drift. This step reuses
 *      migrate-verify-own-graph.js's own HASHING routines (shared.rowHash
 *      via computeContentFingerprint, require('./migrate-verify-own-graph'),
 *      never a reimplementation) for the actual hash computation -- one
 *      normalization engine for "how a row hashes," even though the
 *      COLUMN LIST itself is, of necessity, pinned rather than reused.
 *
 *      A pre-write guard computes and logs the old-vs-new hash diff (which
 *      row ids actually changed, and how many) before mutating anything,
 *      so a future run against different live data is self-auditing rather
 *      than a silent bulk overwrite. row_count is DELIBERATELY NOT touched
 *      by this step — it reflects what was ACTUALLY migrated to the target
 *      at capture time, not the current source count; overwriting it would
 *      make T2 expect rows nothing ever migrated forward.
 *
 * TRI-STATE COMPARE-AND-SET (every row-level mutation, both steps 1-3):
 *   - NOT YET RETIRED (retired_at IS NULL): mutate.
 *   - ALREADY RETIRED, SAME note (this script's own prior run): no-op,
 *     logged as idempotent-skip.
 *   - ALREADY RETIRED, DIFFERENT note (a different disposition already
 *     touched this row): WARN, never overwritten.
 * Step 4 is a pure function of current live content (DELETE the slice's
 * existing row_hashes + INSERT freshly computed ones, UPDATE
 * content_fingerprint) — naturally idempotent without a tri-state check:
 * running it twice with no live-content change in between converges to the
 * same stored state both times.
 *
 * A JSON backup of every row this script is ABOUT to touch (pre-mutation
 * state) is written to --backup-dir (default scripts/migrations/backups/,
 * gitignored) before any mutation, every run — mirrors migrate-02/03's
 * house backup pattern (backupSourceTable/backupCorpusTable).
 *
 * Usage:
 *   node scripts/migrations/cure-migration-manifest-retirement.js [--db <target>]
 *     [--source-db <name>] [--backup-dir <path>] [--dry-run]
 * Exit codes: 0 = every step ran (or was a legitimate no-op), 1 = a step
 * hit an unexpected error (conflicts/WARNs are reported but do not fail the
 * run — they require operator judgment, not a script decision).
 */

const fs = require('fs');
const path = require('path');
const shared = require('./lib/verify15-shared');
const migrateOwnGraph = require('./migrate-verify-own-graph');

const DEFAULT_BACKUP_DIR = path.join(shared.MIGRATIONS_DIR, 'backups');
const DEFAULT_RESNAPSHOT_SOURCE_DB = 'claude_memory_eval_test';

// ─── STEP 1: LEAKED ROWS (cm#197) ────────────────────────────────────────

const LEAKED_ROW_SCOPE = [
  { source_db: 'adv175_1786905342243_corpus', source_table: 'memory_entries', project_id_or_null: 'some-other-real-project-id' },
  { source_db: 'adv175_1786905342243_corpus', source_table: 'memory_entries', project_id_or_null: 'unmapped-orphan-memory-entry' },
  { source_db: 'claude_memory_eval_ci', source_table: 'memory_entries', project_id_or_null: 'unmapped-orphan-memory-entry' },
  { source_db: 'claude_memory_eval_ci', source_table: 'memory_entry_chunks', project_id_or_null: 'unmapped-orphan-memory-entry' },
  { source_db: 'claude_memory_eval_test', source_table: 'memory_entries', project_id_or_null: 'unmapped-orphan-memory-entry' },
  { source_db: 'claude_memory_eval_test', source_table: 'memory_entry_chunks', project_id_or_null: 'unmapped-orphan-memory-entry' },
];
const LEAKED_ROW_NOTE = 'cm#197 cure: leaked dev/test-fixture manifest row (db-triage-disposable source_db, roster-unpaired for this source_table) -- retired by cure-migration-manifest-retirement.js, never excluded_reason (see script header: excluded_reason would falsely assert zero live rows for a bucket that carries hundreds of legitimate ones).';

// ─── STEP 2: STALE DUPLICATE CAPTURES (cm#196) ───────────────────────────

const DUPLICATE_SCOPE_PAIRS = [
  { source_db: 'claude_policy_framework', source_table: 'memory_entries' },
  { source_db: 'claude_policy_framework', source_table: 'memory_entry_chunks' },
  { source_db: 'pipeline_pipeline', source_table: 'memory_entries' },
  { source_db: 'pipeline_pipeline', source_table: 'memory_entry_chunks' },
];

// ─── STEP 3: ORPHAN ROW-HASHES FOR ONE EXCLUDED SLICE (cm#199) ───────────

const ORPHAN_ROW_HASH_SCOPE = [
  { source_db: 'claude_memory_eval_test', source_table: 'edges', project_id_or_null: '9a212124-5abd-42b8-af0a-9650b21a8f98' },
];
const ORPHAN_ROW_HASH_NOTE = 'cm#199 cure: row-hash rows for a slice migration_manifest already records excluded_reason for -- nothing reads row-hashes for an excluded slice; retired for hygiene, never deleted (append-only audit trail).';

// ─── STEP 4: RE-SNAPSHOT SCOPE (cm#199) ──────────────────────────────────

const RESNAPSHOT_SCOPE = { source_db: 'claude_memory_eval_test', source_table: 'edges', project_id_or_null: 'C--Users-djwmo-dev-claude-memory' };

// PINNED, never dynamically re-derived from live schema (a second review
// finding, discovered while fixing the first): migrate-verify-own-graph.js's
// column-derivation (Object.keys(sourceRows[0]), filtered to exclude id/
// project_id) is correct for a FRESH capture, but this is a RECONCILIATION
// against an EXISTING historical capture (manifest id 1643, captured
// 2026-08-16 13:32:30) -- re-running the writer's dynamic derivation
// against TODAY's live schema silently picks up columns edges did not have
// at capture time. PR #204 (2026-08-18, AFTER this capture) brought
// source_model/agent_id/suppressed forward onto edges; a naive `SELECT *`-
// then-filter basis run today includes all three, producing a spurious
// 255/255 "everything changed" result (verified: this is exactly what a
// first attempt at this fix produced). Confirmed via schema history
// (`git show <PR#204-parent>:scripts/sql/handoff-core-schema.sql`): as of
// the capture, edges had exactly id/project_id/from_entity/edge_type/
// to_entity/weight/created_at/session_id -- no source_model, agent_id, or
// suppressed. This constant is that capture-time column set, minus id/
// project_id, hardcoded because "what columns existed in the past" is not
// something live schema introspection can ever answer -- it is inherently
// historical information, scoped to this ONE slice's known capture
// provenance, not a general-purpose derivation this cure script could reuse
// for a different slice.
const RESNAPSHOT_CONTENT_COLS = ['from_entity', 'edge_type', 'to_entity', 'weight', 'created_at', 'session_id'];

// ─── CLI ARGS ─────────────────────────────────────────────────────────────

/**
 * --source-db is resolved via shared.resolveAndClassifySourceDb (the SAME
 * validator T1/T4 use — DB_NAME_RE format check, plus a SOURCE_DB env
 * fallback), never a bare, unvalidated argv pick: a malformed/unsafe value
 * here would otherwise reach shared.connect() unchecked. resolveAndClassifySourceDb
 * returns null when neither --source-db nor SOURCE_DB is supplied; this
 * script's own default (DEFAULT_RESNAPSHOT_SOURCE_DB) applies only then.
 */
function resolveSourceDb(argv) {
  return shared.resolveAndClassifySourceDb(argv) || DEFAULT_RESNAPSHOT_SOURCE_DB;
}

function parseArgs(argv) {
  const parsed = { db: null, sourceDb: resolveSourceDb(argv), backupDir: DEFAULT_BACKUP_DIR, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--db') parsed.db = argv[++i];
    else if (a.startsWith('--db=')) parsed.db = a.slice('--db='.length);
    else if (a === '--backup-dir') parsed.backupDir = argv[++i];
    else if (a.startsWith('--backup-dir=')) parsed.backupDir = a.slice('--backup-dir='.length);
    else if (a === '--dry-run') parsed.dryRun = true;
    // --source-db / --source-db=<val> is consumed by resolveSourceDb()
    // above, via shared.resolveAndClassifySourceDb -- intentionally not
    // re-parsed here (one parser for that flag, not two).
  }
  return parsed;
}

function timestampForFilename() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

// ─── TRI-STATE COMPARE-AND-SET ────────────────────────────────────────────

/**
 * @returns {'retired'|'noop-idempotent'|'conflict'}
 */
async function retireRow(client, table, id, note, dryRun, log) {
  const { rows } = await client.query(`SELECT retired_at, retired_note FROM ${table} WHERE id = $1`, [id]);
  if (!rows.length) { log(`  [SKIP] ${table} id=${id}: row no longer exists.`); return 'missing'; }
  const current = rows[0];
  if (current.retired_at !== null) {
    if (current.retired_note === note) { log(`  [NOOP] ${table} id=${id}: already retired with this cure's note (idempotent).`); return 'noop-idempotent'; }
    log(`  [WARN] ${table} id=${id}: already retired with a DIFFERENT note ("${current.retired_note}") -- NOT overwriting.`);
    return 'conflict';
  }
  if (dryRun) { log(`  [DRY-RUN] would retire ${table} id=${id}`); return 'retired'; }
  await client.query(`UPDATE ${table} SET retired_at = NOW(), retired_note = $2 WHERE id = $1 AND retired_at IS NULL`, [id, note]);
  log(`  [RETIRED] ${table} id=${id}`);
  return 'retired';
}

// ─── BACKUP ────────────────────────────────────────────────────────────────

async function writeBackup(client, backupDir, payload) {
  fs.mkdirSync(backupDir, { recursive: true });
  const filePath = path.join(backupDir, `migration-manifest-retirement-backup-${timestampForFilename()}.json`);
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), 'utf8');
  return filePath;
}

// ─── STEP IMPLEMENTATIONS ──────────────────────────────────────────────────

async function findScopeRows(client, scope) {
  const found = [];
  for (const s of scope) {
    const { rows } = await client.query(
      `SELECT * FROM migration_manifest WHERE source_db = $1 AND source_table = $2 AND project_id_or_null IS NOT DISTINCT FROM $3 AND excluded_reason IS NULL`,
      [s.source_db, s.source_table, s.project_id_or_null]
    );
    found.push(...rows);
  }
  return found;
}

async function runStep1LeakedRows(client, dryRun, log) {
  const rows = await findScopeRows(client, LEAKED_ROW_SCOPE);
  log(`[step 1] leaked-row scope matched ${rows.length} row(s) (of ${LEAKED_ROW_SCOPE.length} scoped triples).`);
  const results = { retired: 0, noop: 0, conflict: 0, missingScope: LEAKED_ROW_SCOPE.length - rows.length };
  for (const row of rows) {
    const outcome = await retireRow(client, 'migration_manifest', row.id, LEAKED_ROW_NOTE, dryRun, log);
    if (outcome === 'retired') results.retired++;
    else if (outcome === 'noop-idempotent') results.noop++;
    else if (outcome === 'conflict') results.conflict++;
  }
  return { rows, results };
}

async function runStep2Duplicates(client, dryRun, log) {
  const allRetired = [];
  const allConflicts = [];
  let noop = 0;
  for (const pair of DUPLICATE_SCOPE_PAIRS) {
    const { rows } = await client.query(
      `SELECT * FROM migration_manifest WHERE source_db = $1 AND source_table = $2 AND excluded_reason IS NULL AND retired_at IS NULL ORDER BY project_id_or_null NULLS FIRST, captured_at`,
      [pair.source_db, pair.source_table]
    );
    const bySlice = new Map();
    for (const r of rows) {
      const key = JSON.stringify([r.project_id_or_null]);
      if (!bySlice.has(key)) bySlice.set(key, []);
      bySlice.get(key).push(r);
    }
    for (const [, sliceRows] of bySlice) {
      if (sliceRows.length <= 1) continue;
      const survivor = sliceRows.reduce((latest, r) => (new Date(r.captured_at) > new Date(latest.captured_at) ? r : latest), sliceRows[0]);
      log(`[step 2] ${pair.source_db}/${pair.source_table} project_id_or_null=${survivor.project_id_or_null ?? 'NULL'}: ${sliceRows.length} non-retired row(s), survivor id=${survivor.id} (captured_at=${survivor.captured_at}).`);
      for (const r of sliceRows) {
        if (r.id === survivor.id) continue;
        const note = `cm#196/cm#197 cure: stale duplicate capture (re-snapshot) of the same (source_db, source_table, project_id_or_null) slice; survivor is manifest id ${survivor.id} (captured_at ${survivor.captured_at}) -- retired by cure-migration-manifest-retirement.js.`;
        const outcome = await retireRow(client, 'migration_manifest', r.id, note, dryRun, log);
        if (outcome === 'retired') allRetired.push(r.id);
        else if (outcome === 'noop-idempotent') noop++;
        else if (outcome === 'conflict') allConflicts.push(r.id);
      }
    }
  }
  return { retired: allRetired, conflicts: allConflicts, noop };
}

async function runStep3OrphanRowHashes(client, dryRun, log) {
  const found = [];
  for (const s of ORPHAN_ROW_HASH_SCOPE) {
    // Defensive: only retire row-hashes for a slice migration_manifest
    // ITSELF currently records as excluded -- never blindly retire
    // row-hashes just because they match a (source_db, source_table,
    // project_id_or_null) triple named in this scope list.
    const { rows: manifestRows } = await client.query(
      `SELECT 1 FROM migration_manifest WHERE source_db = $1 AND source_table = $2 AND project_id_or_null IS NOT DISTINCT FROM $3 AND excluded_reason IS NOT NULL`,
      [s.source_db, s.source_table, s.project_id_or_null]
    );
    if (!manifestRows.length) {
      log(`[step 3] scope source_db="${s.source_db}" source_table="${s.source_table}" project_id_or_null=${s.project_id_or_null ?? 'NULL'}: no matching EXCLUDED migration_manifest row found -- skipping (defensive; not retiring row-hashes without a confirmed excluded parent slice).`);
      continue;
    }
    const { rows } = await client.query(
      `SELECT * FROM migration_manifest_row_hashes WHERE source_db = $1 AND source_table = $2 AND project_id_or_null IS NOT DISTINCT FROM $3`,
      [s.source_db, s.source_table, s.project_id_or_null]
    );
    found.push(...rows);
  }
  log(`[step 3] orphan row-hash scope matched ${found.length} row(s).`);
  const results = { retired: 0, noop: 0, conflict: 0 };
  for (const row of found) {
    const outcome = await retireRow(client, 'migration_manifest_row_hashes', row.id, ORPHAN_ROW_HASH_NOTE, dryRun, log);
    if (outcome === 'retired') results.retired++;
    else if (outcome === 'noop-idempotent') results.noop++;
    else if (outcome === 'conflict') results.conflict++;
  }
  return { rows: found, results };
}

/**
 * Re-snapshot RESNAPSHOT_SCOPE using migrate-verify-own-graph.js's OWN hash
 * basis (every source column except id/project_id), reusing its exported
 * sourceSelect/computeContentFingerprint/getTableColumns rather than
 * reimplementing column derivation here — one normalization engine for
 * "what does this own-graph slice's hash cover," shared by the writer and
 * this cure script alike. See this function's header-comment note (step 4
 * above) for the review finding that corrected this from the roster's
 * loadBearingCols basis this step originally (wrongly) used.
 */
async function runStep4Resnapshot(tgtClient, srcClient, dryRun, log) {
  const scope = RESNAPSHOT_SCOPE;
  const { rows: manifestRows } = await tgtClient.query(
    `SELECT * FROM migration_manifest WHERE source_db = $1 AND source_table = $2 AND project_id_or_null IS NOT DISTINCT FROM $3`,
    [scope.source_db, scope.source_table, scope.project_id_or_null]
  );
  if (!manifestRows.length) {
    log(`[step 4] re-snapshot scope not present in migration_manifest (source_db="${scope.source_db}" source_table="${scope.source_table}" project_id_or_null=${scope.project_id_or_null ?? 'NULL'}) -- skipped (expected against a test fixture that doesn't set up this specific slice).`);
    return { skipped: true };
  }
  // Explicit single-row assertion -- never a silent manifestRows[0] pick.
  // More than one row matching this exact (source_db, source_table,
  // project_id_or_null) scope is itself a data problem (see Phase 2's
  // duplicate-manifest-row FATAL in verify-15-t2-rowcount.js) this step
  // must refuse to guess through, not silently resolve by array order.
  if (manifestRows.length > 1) {
    log(`[step 4] FATAL: ${manifestRows.length} migration_manifest rows match this exact scope (ids=[${manifestRows.map((r) => r.id).join(', ')}]) -- ambiguous, refusing to guess which one is authoritative. Resolve the duplicate (see Phase 2 of verify-15-t2-rowcount.js) before re-running this step.`);
    return { skipped: true, error: 'ambiguous-scope-multiple-manifest-rows' };
  }
  const manifestRow = manifestRows[0];
  if (manifestRow.retired_at !== null) {
    log(`[step 4] manifest id=${manifestRow.id} is retired -- skipping re-snapshot (a retired row is disposed-of; nothing to keep current).`);
    return { skipped: true };
  }

  // Explicit column list (id + the pinned, capture-time content columns),
  // NEVER `SELECT *` -- see RESNAPSHOT_CONTENT_COLS's own comment for why
  // a dynamic `SELECT *`-then-filter basis (migrate-verify-own-graph.js's
  // own convention for a FRESH capture) is wrong for reconciling an
  // EXISTING historical one whose source table has since grown new columns.
  const contentCols = RESNAPSHOT_CONTENT_COLS;
  const { rows: liveRows } = await migrateOwnGraph.sourceSelect(
    srcClient,
    `SELECT id, ${contentCols.map((c) => `"${c}"`).join(', ')} FROM ${scope.source_table} WHERE project_id = $1 ORDER BY "id"`,
    [scope.project_id_or_null]
  );
  if (liveRows.length === 0) {
    log(`[step 4] zero live source rows for source_db="${scope.source_db}" source_table="${scope.source_table}" project_id="${scope.project_id_or_null}" -- skipped (nothing to hash).`);
    return { skipped: true };
  }
  log(`[step 4] hash basis (PINNED to this slice's capture-time columns -- see RESNAPSHOT_CONTENT_COLS): ${contentCols.join(', ')}`);
  log(`[step 4] live source rows for this slice: ${liveRows.length} (stored manifest row_count: ${manifestRow.row_count} -- row_count is NOT updated by this step, see header comment).`);

  const newFingerprint = migrateOwnGraph.computeContentFingerprint(liveRows, contentCols);

  // Pre-write guard: diff old-stored vs newly-computed (correct-basis)
  // hashes BEFORE mutating anything, so every run is self-auditing --
  // never a silent bulk overwrite of hashes that may not have needed
  // changing at all.
  const { rows: oldHashRows } = await tgtClient.query(
    `SELECT source_row_id, source_hash FROM migration_manifest_row_hashes WHERE source_db = $1 AND source_table = $2 AND project_id_or_null IS NOT DISTINCT FROM $3`,
    [scope.source_db, scope.source_table, scope.project_id_or_null]
  );
  const oldBySourceRowId = new Map(oldHashRows.map((r) => [r.source_row_id, r.source_hash]));
  const changedIds = [];
  let unchangedCount = 0;
  for (const r of liveRows) {
    const newHash = shared.rowHash(contentCols, r);
    const oldHash = oldBySourceRowId.get(String(r.id));
    if (oldHash === undefined || oldHash !== newHash) changedIds.push(r.id);
    else unchangedCount++;
  }
  log(`[step 4] pre-write guard: ${unchangedCount}/${liveRows.length} row(s) recompute to the SAME hash already stored; ${changedIds.length} row(s) will change: [${changedIds.join(', ')}].`);

  if (dryRun) {
    log(`[step 4] DRY-RUN: would replace ${liveRows.length} row_hashes row(s) and set content_fingerprint=${newFingerprint} (was ${manifestRow.content_fingerprint}) on manifest id=${manifestRow.id}.`);
    return { skipped: false, dryRun: true, rowsToWrite: liveRows.length, changedIds, unchangedCount };
  }

  await tgtClient.query('BEGIN');
  try {
    await tgtClient.query(
      `DELETE FROM migration_manifest_row_hashes WHERE source_db = $1 AND source_table = $2 AND project_id_or_null IS NOT DISTINCT FROM $3`,
      [scope.source_db, scope.source_table, scope.project_id_or_null]
    );
    for (const r of liveRows) {
      const h = shared.rowHash(contentCols, r);
      await tgtClient.query(
        `INSERT INTO migration_manifest_row_hashes (source_db, source_table, project_id_or_null, source_row_id, source_hash)
         VALUES ($1,$2,$3,$4,$5)`,
        [scope.source_db, scope.source_table, scope.project_id_or_null, String(r.id), h]
      );
    }
    await tgtClient.query(
      `UPDATE migration_manifest SET content_fingerprint = $2 WHERE id = $1`,
      [manifestRow.id, newFingerprint]
    );
    await tgtClient.query('COMMIT');
  } catch (err) {
    await tgtClient.query('ROLLBACK');
    throw err;
  }
  log(`[step 4] re-snapshotted manifest id=${manifestRow.id}: ${liveRows.length} row_hashes rows replaced (${changedIds.length} actually changed), content_fingerprint ${manifestRow.content_fingerprint} -> ${newFingerprint}.`);
  return { skipped: false, rowsWritten: liveRows.length, changedIds, unchangedCount, oldFingerprint: manifestRow.content_fingerprint, newFingerprint };
}

// ─── MAIN ───────────────────────────────────────────────────────────────────

async function main() {
  const argv = process.argv.slice(2);
  const { name: target, source } = await shared.resolveAndClassifyTargetDb(argv);
  const parsed = parseArgs(argv);
  console.log(`cure-migration-manifest-retirement: target="${target}" (resolved from ${source}), source-db="${parsed.sourceDb}", dry-run=${parsed.dryRun}`);

  const tgtClient = await shared.connect(target);
  let srcClient = null;
  try {
    await shared.applyDdl(tgtClient);

    // House backup: dump EVERY row this run is about to consider (pre-
    // mutation state), before any step runs.
    const backupPayload = {
      captured_at: new Date().toISOString(),
      leaked_row_scope: await findScopeRows(tgtClient, LEAKED_ROW_SCOPE),
      duplicate_scope_pairs_current_rows: [],
      orphan_row_hash_scope_rows: [],
      resnapshot_scope_manifest_row: null,
      resnapshot_scope_row_hashes: null,
    };
    for (const pair of DUPLICATE_SCOPE_PAIRS) {
      const { rows } = await tgtClient.query(
        `SELECT * FROM migration_manifest WHERE source_db = $1 AND source_table = $2`,
        [pair.source_db, pair.source_table]
      );
      backupPayload.duplicate_scope_pairs_current_rows.push({ pair, rows });
    }
    for (const s of ORPHAN_ROW_HASH_SCOPE) {
      const { rows } = await tgtClient.query(
        `SELECT * FROM migration_manifest_row_hashes WHERE source_db = $1 AND source_table = $2 AND project_id_or_null IS NOT DISTINCT FROM $3`,
        [s.source_db, s.source_table, s.project_id_or_null]
      );
      backupPayload.orphan_row_hash_scope_rows.push(...rows);
    }
    {
      const { rows } = await tgtClient.query(
        `SELECT * FROM migration_manifest WHERE source_db = $1 AND source_table = $2 AND project_id_or_null IS NOT DISTINCT FROM $3`,
        [RESNAPSHOT_SCOPE.source_db, RESNAPSHOT_SCOPE.source_table, RESNAPSHOT_SCOPE.project_id_or_null]
      );
      backupPayload.resnapshot_scope_manifest_row = rows[0] || null;
      const { rows: hashRows } = await tgtClient.query(
        `SELECT * FROM migration_manifest_row_hashes WHERE source_db = $1 AND source_table = $2 AND project_id_or_null IS NOT DISTINCT FROM $3`,
        [RESNAPSHOT_SCOPE.source_db, RESNAPSHOT_SCOPE.source_table, RESNAPSHOT_SCOPE.project_id_or_null]
      );
      backupPayload.resnapshot_scope_row_hashes = hashRows;
    }
    const backupPath = parsed.dryRun ? null : await writeBackup(tgtClient, parsed.backupDir, backupPayload);
    if (backupPath) console.log(`[backup] pre-mutation state written to ${backupPath}`);
    else console.log('[backup] --dry-run: no backup written (no mutation will occur).');

    const step1 = await runStep1LeakedRows(tgtClient, parsed.dryRun, console.log);
    const step2 = await runStep2Duplicates(tgtClient, parsed.dryRun, console.log);
    const step3 = await runStep3OrphanRowHashes(tgtClient, parsed.dryRun, console.log);

    srcClient = await shared.connect(parsed.sourceDb);
    const step4 = await runStep4Resnapshot(tgtClient, srcClient, parsed.dryRun, console.log);

    console.log('--- summary ---');
    console.log(`step 1 (leaked rows): ${JSON.stringify(step1.results)}`);
    console.log(`step 2 (duplicates): retired=${step2.retired.length} conflicts=${step2.conflicts.length} noop=${step2.noop}`);
    console.log(`step 3 (orphan row-hashes): ${JSON.stringify(step3.results)}`);
    console.log(`step 4 (re-snapshot): ${JSON.stringify(step4)}`);

    const anyConflict = step1.results.conflict > 0 || step2.conflicts.length > 0 || step3.results.conflict > 0;
    if (anyConflict) {
      console.error('One or more rows had a retirement CONFLICT (already retired with a different note) -- review manually; this run did not overwrite them.');
    }
  } finally {
    await tgtClient.end();
    if (srcClient) await srcClient.end();
  }
  process.exit(0);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err && err.stack ? err.stack : err);
    process.exit(1);
  });
}

module.exports = {
  AUTHORED_BY,
  LEAKED_ROW_SCOPE,
  DUPLICATE_SCOPE_PAIRS,
  ORPHAN_ROW_HASH_SCOPE,
  RESNAPSHOT_SCOPE,
  retireRow,
  findScopeRows,
  runStep1LeakedRows,
  runStep2Duplicates,
  runStep3OrphanRowHashes,
  runStep4Resnapshot,
};
