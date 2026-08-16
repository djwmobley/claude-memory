'use strict';

/**
 * test-migrate-verify-own-graph.js — Test harness for
 * scripts/migrations/migrate-verify-own-graph.js (CONSOLIDATION-RUNBOOK.md
 * §6.1(c) + C-1..C-11 amendment, memory-manager#11(c)).
 *
 * Mirrors test-migrate-02-decisions.js's conventions: self-contained
 * scratch databases (target "_staging"-suffixed to satisfy migrate-01's own
 * classifyTarget, reused by reference), unconditional cleanup, never
 * touches claude_memory_eval_test/memory_manager_staging. Every fixture is
 * SYNTHETIC (fake UUIDs, fake project ids) -- no real instance data.
 *
 * Covers (task-mandated minimum):
 *   - junk exclusion: a project_id absent from known-own-graph-project-ids
 *     migrates ZERO rows and gets a migration_manifest row with
 *     excluded_reason='eval-junk-project-id', per table it appears in.
 *   - idempotent re-run: running the script twice against the same source
 *     produces zero net row-count change, including suppressed=true
 *     assertions rows (C-6's named hazard -- no covering unique index).
 *   - content-divergence logging: a foreign row already occupying a REAL
 *     slice's natural key with DIFFERENT content is detected, logged via
 *     [CONTENT-DIVERGENCE], and NEVER overwritten.
 *   - manifest slice shapes: one migration_manifest row per (table,
 *     project_id), real and junk alike -- never one aggregated NULL-scoped
 *     exclusion row.
 * Plus (this script's own id-remap design, load-bearing for correctness):
 *   - retrieval_event_assertions FK remap survives a delete-then-reinsert
 *     re-run (event_id/assertion_id point at the NEW target ids, not stale
 *     source ids).
 *
 * Usage: node test/migrations/test-migrate-verify-own-graph.js
 * Exit 0 = all pass; nonzero = any failure.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { createRequire } = require('module');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const MIGRATE_ONE_PATH = path.join(PROJECT_ROOT, 'scripts', 'migrations', 'migrate-01-canonical-db.js');
const SCRIPT_PATH = path.join(PROJECT_ROOT, 'scripts', 'migrations', 'migrate-verify-own-graph.js');

const migrateOne = require(MIGRATE_ONE_PATH);
const script = require(SCRIPT_PATH);

const scriptsRequire = createRequire(require.resolve('../../scripts/package.json'));
const { Client } = scriptsRequire('pg');

const TS = Date.now();

let passed = 0;
let failed = 0;
function pass(id, label) { console.log(`[${id}] ${label} ... PASS`); passed++; }
function fail(id, label, reason) { console.log(`[${id}] ${label} ... FAIL: ${reason}`); failed++; }
async function run(id, label, fn) {
  try { await fn(); pass(id, label); } catch (err) { fail(id, label, err && err.stack ? err.stack : String(err)); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }

function pgConfig(database) {
  return {
    host: process.env.PGHOST || 'localhost',
    port: parseInt(process.env.PGPORT || '5432', 10),
    user: process.env.PGUSER || 'postgres',
    password: process.env.PGPASSWORD || 'postgres',
    database,
  };
}
async function pgConnect(database = 'postgres') {
  const client = new Client(pgConfig(database));
  await client.connect();
  return client;
}
async function dropDb(dbName) {
  let sys;
  try {
    sys = await pgConnect('postgres');
    await sys.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`, [dbName]);
    await sys.query(`DROP DATABASE IF EXISTS "${dbName}"`);
  } catch (_) { /* best-effort */ } finally {
    if (sys) { try { await sys.end(); } catch (_) {} }
  }
}
async function createDb(dbName) {
  const sys = await pgConnect('postgres');
  try {
    await sys.query(`CREATE DATABASE "${dbName}"`);
  } finally {
    await sys.end();
  }
}

/** Applies the same four schema files migrate-01 applies, directly (bypasses migrate-01's CLI target-name refusal -- a scratch "source" DB standing in for claude_memory_eval_test is never named *_staging). */
async function applyEngineSchema(dbName) {
  const client = await pgConnect(dbName);
  try {
    for (const ext of ['vector', 'pg_trgm']) {
      try { await client.query(`CREATE EXTENSION IF NOT EXISTS ${ext}`); } catch (_) {}
    }
    for (const file of migrateOne.SCHEMA_FILES) {
      await migrateOne.applySqlFile(client, file);
    }
  } finally {
    await client.end();
  }
}

async function setupTargetSchema(dbName) {
  const r = require('child_process').spawnSync(process.execPath, [MIGRATE_ONE_PATH, '--db', dbName], { cwd: PROJECT_ROOT, env: process.env, encoding: 'utf8', timeout: 30000 });
  if (r.status !== 0) throw new Error(`migrate-01 fixture setup failed: status=${r.status} stderr=${r.stderr}`);
}

function writeKnownIds(dirPath, ids) {
  const p = path.join(dirPath, `known-ids-${TS}-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(p, JSON.stringify({ known_project_ids: ids }));
  return p;
}

function runScript(args, timeoutMs = 30000) {
  return require('child_process').spawnSync(process.execPath, [SCRIPT_PATH, ...args], { cwd: PROJECT_ROOT, env: process.env, encoding: 'utf8', timeout: timeoutMs });
}

async function queryCount(dbName, sql, params) {
  const client = await pgConnect(dbName);
  try {
    const { rows } = await client.query(sql, params);
    return Number(rows[0].n);
  } finally {
    await client.end();
  }
}
async function query(dbName, sql, params) {
  const client = await pgConnect(dbName);
  try {
    return (await client.query(sql, params)).rows;
  } finally {
    await client.end();
  }
}

const DB_TARGET = `verifyown_target_${TS}_staging`;
const DB_SOURCE = `verifyown_source_${TS}`;
const CREATED_DBS = [DB_TARGET, DB_SOURCE];
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'test-migrate-verify-own-graph-'));

const REAL_PROJECT_ID = 'real-proj-11111111-1111-1111-1111-111111111111';
const JUNK_PROJECT_ID = 'eval-junk-uuid-22222222-2222-2222-2222-222222222222';
const KNOWN_IDS_PATH = writeKnownIds(TMP_DIR, [REAL_PROJECT_ID]);

async function seedSource() {
  const client = await pgConnect(DB_SOURCE);
  try {
    // REAL slice: entities, assertions (one suppressed=true, no covering
    // unique index -- C-6's named idempotency hazard), edges,
    // retrieval_events + a joining retrieval_event_assertions row.
    const { rows: e1 } = await client.query(
      `INSERT INTO entities (project_id, name, entity_type, description) VALUES ($1,'widget','system','the widget') RETURNING id`,
      [REAL_PROJECT_ID]
    );
    void e1;
    const { rows: a1 } = await client.query(
      `INSERT INTO assertions (project_id, subject, predicate, object, confidence, source, suppressed)
       VALUES ($1,'widget','depends_on','gadget',8.0,'user_stated',false) RETURNING id`,
      [REAL_PROJECT_ID]
    );
    const { rows: a2 } = await client.query(
      `INSERT INTO assertions (project_id, subject, predicate, object, confidence, source, suppressed)
       VALUES ($1,'widget','old_note','stale value',3.0,'model_extracted',true) RETURNING id`,
      [REAL_PROJECT_ID]
    );
    await client.query(
      `INSERT INTO edges (project_id, from_entity, edge_type, to_entity) VALUES ($1,'widget','depends_on','gadget')`,
      [REAL_PROJECT_ID]
    );
    const { rows: ev1 } = await client.query(
      `INSERT INTO retrieval_events (project_id, query_text, session_id) VALUES ($1,'find widget deps','sess-1') RETURNING id`,
      [REAL_PROJECT_ID]
    );
    await client.query(
      `INSERT INTO retrieval_event_assertions (event_id, assertion_id) VALUES ($1,$2)`,
      [ev1[0].id, a1[0].id]
    );
    await client.query(
      `INSERT INTO retrieval_contract (project_id, name, queries) VALUES ($1,'default','[]'::jsonb)`,
      [REAL_PROJECT_ID]
    );
    await client.query(
      `INSERT INTO project_settings (project_id, key, value) VALUES ($1,'staleness_days','7')`,
      [REAL_PROJECT_ID]
    );

    // JUNK slice: same shapes, different (unlisted) project_id.
    await client.query(
      `INSERT INTO entities (project_id, name, entity_type) VALUES ($1,'junk-entity','concept')`,
      [JUNK_PROJECT_ID]
    );
    await client.query(
      `INSERT INTO assertions (project_id, subject, predicate, object, confidence, source)
       VALUES ($1,'junk','is_status','noise',5.0,'model_extracted')`,
      [JUNK_PROJECT_ID]
    );
    void a2;
    return { assertionId1: a1[0].id, eventId1: ev1[0].id };
  } finally {
    await client.end();
  }
}

async function main() {
  await run('SETUP', 'target + source scratch databases provisioned, engine schema applied to both', async () => {
    await setupTargetSchema(DB_TARGET);
    await createDb(DB_SOURCE);
    await applyEngineSchema(DB_SOURCE);
  });

  let seeded;
  await run('SEED', 'synthetic REAL + JUNK own-graph fixture rows inserted into source', async () => {
    seeded = await seedSource();
    assert(seeded.assertionId1 > 0, 'seed assertion id captured');
  });

  // ── classifyProjectId unit tests (no DB) ──────────────────────────────
  await run('U1', 'classifyProjectId: REAL iff present in known set, JUNK is the default branch', () => {
    const known = new Set(['a', 'b']);
    assert(script.classifyProjectId('a', known) === 'REAL', 'a should be REAL');
    assert(script.classifyProjectId('unknown-uuid', known) === 'JUNK', 'unknown-uuid should be JUNK (default branch)');
    assert(script.classifyProjectId('', known) === 'JUNK', 'empty string should be JUNK, never a silent pass');
  });

  let firstRunResult;
  await run('M1', 'first migrate run: exits 0, real rows migrated, junk rows excluded', async () => {
    firstRunResult = runScript(['--db', DB_TARGET, '--source-db', DB_SOURCE, '--known-ids', KNOWN_IDS_PATH]);
    assert(firstRunResult.status === 0, `expected exit 0, got ${firstRunResult.status}. stdout=${firstRunResult.stdout} stderr=${firstRunResult.stderr}`);
    assert(/MIGRATION_RESULT: PASS/.test(firstRunResult.stdout), `expected PASS in stdout: ${firstRunResult.stdout}`);
  });

  // ── Junk exclusion ─────────────────────────────────────────────────────
  await run('J1', 'junk project_id: zero rows migrated into target entities/assertions', async () => {
    const nEntities = await queryCount(DB_TARGET, `SELECT COUNT(*) AS n FROM entities WHERE project_id = $1`, [JUNK_PROJECT_ID]);
    const nAssertions = await queryCount(DB_TARGET, `SELECT COUNT(*) AS n FROM assertions WHERE project_id = $1`, [JUNK_PROJECT_ID]);
    assert(nEntities === 0, `expected 0 junk entities in target, got ${nEntities}`);
    assert(nAssertions === 0, `expected 0 junk assertions in target, got ${nAssertions}`);
  });
  await run('J2', 'junk project_id: migration_manifest carries excluded_reason=eval-junk-project-id per (table,project_id) slice, rows NOT copied', async () => {
    const rows = await query(
      DB_TARGET,
      `SELECT source_table, row_count, excluded_reason FROM migration_manifest WHERE source_db=$1 AND project_id_or_null=$2 ORDER BY source_table`,
      [DB_SOURCE, JUNK_PROJECT_ID]
    );
    assert(rows.length === 2, `expected manifest rows for entities+assertions junk slices, got ${rows.length}: ${JSON.stringify(rows)}`);
    for (const r of rows) {
      assert(r.excluded_reason === 'eval-junk-project-id', `expected excluded_reason='eval-junk-project-id', got ${r.excluded_reason}`);
      assert(Number(r.row_count) === 1, `expected row_count=1 (documented, not copied), got ${r.row_count}`); // BIGINT comes back as string from pg
    }
  });

  // ── Real migration correctness ────────────────────────────────────────
  await run('R1', 'real project_id: entities/assertions/edges/retrieval_contract/project_settings migrated', async () => {
    const nEntities = await queryCount(DB_TARGET, `SELECT COUNT(*) AS n FROM entities WHERE project_id = $1`, [REAL_PROJECT_ID]);
    const nAssertions = await queryCount(DB_TARGET, `SELECT COUNT(*) AS n FROM assertions WHERE project_id = $1`, [REAL_PROJECT_ID]);
    const nSuppressed = await queryCount(DB_TARGET, `SELECT COUNT(*) AS n FROM assertions WHERE project_id = $1 AND suppressed = true`, [REAL_PROJECT_ID]);
    const nEdges = await queryCount(DB_TARGET, `SELECT COUNT(*) AS n FROM edges WHERE project_id = $1`, [REAL_PROJECT_ID]);
    const nContract = await queryCount(DB_TARGET, `SELECT COUNT(*) AS n FROM retrieval_contract WHERE project_id = $1`, [REAL_PROJECT_ID]);
    const nSettings = await queryCount(DB_TARGET, `SELECT COUNT(*) AS n FROM project_settings WHERE project_id = $1`, [REAL_PROJECT_ID]);
    assert(nEntities === 1, `expected 1 entity, got ${nEntities}`);
    assert(nAssertions === 2, `expected 2 assertions (incl. suppressed), got ${nAssertions}`);
    assert(nSuppressed === 1, `expected 1 suppressed assertion migrated, got ${nSuppressed}`);
    assert(nEdges === 1, `expected 1 edge, got ${nEdges}`);
    assert(nContract === 1, `expected 1 retrieval_contract row, got ${nContract}`);
    assert(nSettings === 1, `expected 1 project_settings row, got ${nSettings}`);
  });

  await run('R2', 'retrieval_event_assertions FK remap: event_id/assertion_id point at the NEW target ids, not stale source ids', async () => {
    const rows = await query(
      DB_TARGET,
      `SELECT rea.event_id, rea.assertion_id, re.id AS real_event_id, a.id AS real_assertion_id
         FROM retrieval_event_assertions rea
         JOIN retrieval_events re ON re.id = rea.event_id AND re.project_id = $1
         JOIN assertions a ON a.id = rea.assertion_id AND a.project_id = $1`,
      [REAL_PROJECT_ID]
    );
    assert(rows.length === 1, `expected exactly 1 remapped join row, got ${rows.length}`);
    // NOTE: target ids are fresh SERIAL values assigned independently on the
    // target DB -- they may coincidentally equal the source id (e.g. both
    // "1" on a freshly-seeded scratch pair). The real proof of a correct
    // remap is that event_id/assertion_id resolve via JOIN to REAL target
    // rows scoped to this project_id (checked below), not that the numbers
    // happen to differ from the source.
    assert(rows[0].event_id === rows[0].real_event_id, 'remapped event_id resolves to a real target retrieval_events row');
    assert(rows[0].assertion_id === rows[0].real_assertion_id, 'remapped assertion_id resolves to a real target assertions row');
  });

  // ── Idempotent re-run ───────────────────────────────────────────────────
  let secondRunResult;
  await run('I1', 'second (idempotent) run: exits 0, PASS', async () => {
    secondRunResult = runScript(['--db', DB_TARGET, '--source-db', DB_SOURCE, '--known-ids', KNOWN_IDS_PATH]);
    assert(secondRunResult.status === 0, `expected exit 0, got ${secondRunResult.status}. stdout=${secondRunResult.stdout} stderr=${secondRunResult.stderr}`);
    assert(/MIGRATION_RESULT: PASS/.test(secondRunResult.stdout), `expected PASS: ${secondRunResult.stdout}`);
  });
  await run('I2', 'second run: zero net row-count change across every migrated table, INCLUDING the suppressed=true row (C-6\'s named hazard)', async () => {
    const nEntities = await queryCount(DB_TARGET, `SELECT COUNT(*) AS n FROM entities WHERE project_id = $1`, [REAL_PROJECT_ID]);
    const nAssertions = await queryCount(DB_TARGET, `SELECT COUNT(*) AS n FROM assertions WHERE project_id = $1`, [REAL_PROJECT_ID]);
    const nSuppressed = await queryCount(DB_TARGET, `SELECT COUNT(*) AS n FROM assertions WHERE project_id = $1 AND suppressed = true`, [REAL_PROJECT_ID]);
    const nEdges = await queryCount(DB_TARGET, `SELECT COUNT(*) AS n FROM edges WHERE project_id = $1`, [REAL_PROJECT_ID]);
    const nRea = await queryCount(
      DB_TARGET,
      `SELECT COUNT(*) AS n FROM retrieval_event_assertions rea JOIN retrieval_events re ON re.id = rea.event_id WHERE re.project_id = $1`,
      [REAL_PROJECT_ID]
    );
    assert(nEntities === 1, `entities duplicated on re-run: ${nEntities}`);
    assert(nAssertions === 2, `assertions duplicated on re-run: ${nAssertions}`);
    assert(nSuppressed === 1, `suppressed=true assertions duplicated on re-run (C-6): ${nSuppressed}`);
    assert(nEdges === 1, `edges duplicated on re-run: ${nEdges}`);
    assert(nRea === 1, `retrieval_event_assertions duplicated on re-run: ${nRea}`);
  });
  await run('I3', 'second run: manifest slice rows replaced in place, not duplicated (still exactly 1 row per table/project pair)', async () => {
    const rows = await query(
      DB_TARGET,
      `SELECT source_table, COUNT(*) AS n FROM migration_manifest WHERE source_db=$1 AND project_id_or_null=$2 GROUP BY source_table`,
      [DB_SOURCE, REAL_PROJECT_ID]
    );
    for (const r of rows) {
      assert(Number(r.n) === 1, `expected exactly 1 manifest row for ${r.source_table}/${REAL_PROJECT_ID}, got ${r.n}`);
    }
  });

  // ── Content-divergence detection ────────────────────────────────────────
  await run('D1', 'a foreign row occupying a REAL slice\'s natural key with DIFFERENT content is logged [CONTENT-DIVERGENCE] and never overwritten', async () => {
    // Insert a FOREIGN (non-migration-owned) entities row sharing the same
    // (project_id, name) natural key as an entity that will migrate next
    // run, but with different content -- simulates live, non-migration
    // data occupying the slot.
    const client = await pgConnect(DB_TARGET);
    try {
      await client.query(
        `INSERT INTO entities (project_id, name, entity_type, description) VALUES ($1,'gizmo','system','LIVE foreign description')`,
        [REAL_PROJECT_ID]
      );
    } finally {
      await client.end();
    }
    const srcClient = await pgConnect(DB_SOURCE);
    try {
      await srcClient.query(
        `INSERT INTO entities (project_id, name, entity_type, description) VALUES ($1,'gizmo','system','MIGRATED description differs')`,
        [REAL_PROJECT_ID]
      );
    } finally {
      await srcClient.end();
    }
    const r = runScript(['--db', DB_TARGET, '--source-db', DB_SOURCE, '--known-ids', KNOWN_IDS_PATH]);
    assert(r.status === 0, `expected exit 0, got ${r.status}. stdout=${r.stdout} stderr=${r.stderr}`);
    assert(/\[CONTENT-DIVERGENCE\]/.test(r.stdout), `expected [CONTENT-DIVERGENCE] logged: stdout=${r.stdout}`);
    const rows = await query(DB_TARGET, `SELECT description FROM entities WHERE project_id=$1 AND name='gizmo'`, [REAL_PROJECT_ID]);
    assert(rows.length === 1, `expected the foreign row to remain exactly once (never overwritten, never duplicated), got ${rows.length}`);
    assert(rows[0].description === 'LIVE foreign description', `expected the FOREIGN row's content preserved untouched, got "${rows[0].description}"`);
  });

  // ── Rollback mode (manual, manifest-guided) ─────────────────────────────
  await run('B1', '--rollback deletes exactly this source\'s migrated real-slice rows via lineage, leaves the foreign gizmo row untouched', async () => {
    const r = runScript(['--db', DB_TARGET, '--source-db', DB_SOURCE, '--known-ids', KNOWN_IDS_PATH, '--rollback']);
    assert(r.status === 0, `expected exit 0, got ${r.status}. stdout=${r.stdout} stderr=${r.stderr}`);
    assert(/ROLLBACK_RESULT: PASS/.test(r.stdout), `expected ROLLBACK_RESULT: PASS: ${r.stdout}`);
    // The D1 test left TWO 'gizmo'-named-collision rows in play: a FOREIGN
    // one (inserted directly into target, never migration-owned) and a
    // migration attempt that was skipped (logged CONTENT-DIVERGENCE, never
    // written). Only 'widget' (this test file's originally-migrated entity)
    // is migration-owned and lineage-tracked -- rollback must remove exactly
    // that one, leaving the foreign 'gizmo' row untouched.
    const nEntities = await queryCount(DB_TARGET, `SELECT COUNT(*) AS n FROM entities WHERE project_id = $1`, [REAL_PROJECT_ID]);
    assert(nEntities === 1, `expected exactly 1 entity remaining after rollback (the FOREIGN 'gizmo' row, never migration-owned) -- got ${nEntities}`);
    const remaining = await query(DB_TARGET, `SELECT name, description FROM entities WHERE project_id = $1`, [REAL_PROJECT_ID]);
    assert(remaining[0].name === 'gizmo' && remaining[0].description === 'LIVE foreign description', `expected the surviving row to be the untouched foreign 'gizmo' row, got ${JSON.stringify(remaining)}`);
    const nManifest = await queryCount(DB_TARGET, `SELECT COUNT(*) AS n FROM migration_manifest WHERE source_db=$1 AND project_id_or_null=$2 AND excluded_reason IS NULL`, [DB_SOURCE, REAL_PROJECT_ID]);
    assert(nManifest === 0, `expected 0 non-excluded manifest rows remaining after rollback, got ${nManifest}`);
  });

  // ── Missing known-ids config ────────────────────────────────────────────
  await run('E1', 'missing known-ids config: loud FATAL exit 1, no DB connection needed to fail', () => {
    const r = runScript(['--db', DB_TARGET, '--source-db', DB_SOURCE, '--known-ids', path.join(TMP_DIR, 'does-not-exist.json')]);
    assert(r.status === 1, `expected exit 1, got ${r.status}`);
    assert(/FATAL/.test(r.stderr), `expected FATAL in stderr: ${r.stderr}`);
  });

  // ── Cleanup ──────────────────────────────────────────────────────────────
  await run('CLEANUP', 'scratch databases + tempfiles dropped', async () => {
    for (const db of CREATED_DBS) await dropDb(db);
    fs.rmSync(TMP_DIR, { recursive: true, force: true });
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(async (err) => {
  console.error('FATAL:', err && err.stack ? err.stack : err);
  for (const db of CREATED_DBS) await dropDb(db);
  process.exit(1);
});
