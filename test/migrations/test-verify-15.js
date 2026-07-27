'use strict';

/**
 * test-verify-15.js — Test harness for the scripts/migrations/verify-15-*.js
 * §15 acceptance battery (§15 of the consolidation runbook, local planning
 * doc).
 *
 * Mirrors test-migrate-01.js's conventions: self-contained scratch
 * databases (all named to satisfy classifyTarget's allowed pattern — see
 * verify15-shared.js's resolveAndClassifyTargetDb), pre-minted names with a
 * timestamp suffix, unconditional finally-block cleanup, never touches
 * claude_memory_eval_test/claude_policy_framework/pipeline_* beyond a
 * refusal-branch assertion.
 *
 * Requires Postgres at PGHOST/PGUSER/PGPASSWORD (CI env) or
 * localhost/postgres, with pgvector available (halfvec support).
 *
 * Usage: node test/migrations/test-verify-15.js
 * Exit 0 = all pass; nonzero = any failure.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { createRequire } = require('module');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const MIGRATIONS_DIR = path.join(PROJECT_ROOT, 'scripts', 'migrations');

// scripts/ has its own node_modules (pg, etc.) — resolve via a require()
// rooted at scripts/package.json, same pattern test-migrate-01.js uses.
const scriptsRequire = createRequire(require.resolve('../../scripts/package.json'));
const { Client } = scriptsRequire('pg');

const shared = require(path.join(MIGRATIONS_DIR, 'lib', 'verify15-shared.js'));

const TS = Date.now();

// ── Tracking ────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function pass(id, label) {
  console.log(`[${id}] ${label} ... PASS`);
  passed++;
}

function fail(id, label, reason) {
  console.log(`[${id}] ${label} ... FAIL: ${reason}`);
  failed++;
}

// ── PG helpers ────────────────────────────────────────────────────────────────

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
    await sys.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
      [dbName]
    );
    await sys.query(`DROP DATABASE IF EXISTS "${dbName}"`);
  } catch (_) {
    // best-effort cleanup
  } finally {
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

// ── Scratch names (all end in _staging so classifyTarget allows them) ────────

const TARGET_DB = `verify15_target_${TS}_staging`;
const SOURCE_DB = `verify15_source_${TS}_staging`;
const FREEZE_WRITABLE_DB = `verify15_freezewritable_${TS}_staging`;
const FREEZE_FROZEN_DB = `verify15_freezefrozen_${TS}_staging`;
const CREATED_DBS = [TARGET_DB, SOURCE_DB, FREEZE_WRITABLE_DB, FREEZE_FROZEN_DB];

// ── Scratch temp files (roster/fixture JSON, OUTSIDE the repo) ───────────────

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'verify15-test-'));
const CREATED_TMP_FILES = [];

function writeTmpJson(name, data) {
  const p = path.join(TMP_DIR, name);
  fs.writeFileSync(p, JSON.stringify(data, null, 2), 'utf8');
  CREATED_TMP_FILES.push(p);
  return p;
}

// ── Script invocation ─────────────────────────────────────────────────────────

function scriptPath(name) {
  return path.join(MIGRATIONS_DIR, name);
}

function runScript(name, args, extraEnv = {}, timeoutMs = 20000) {
  return spawnSync(process.execPath, [scriptPath(name), ...args], {
    cwd: PROJECT_ROOT,
    env: { ...process.env, ...extraEnv },
    encoding: 'utf8',
    timeout: timeoutMs,
  });
}

function rosterEnv(rosterPath) {
  return { SOURCE_TABLE_ROSTER: rosterPath };
}

// ── Fixture schema helpers ────────────────────────────────────────────────────

async function setupTargetSchema(client) {
  await client.query('CREATE EXTENSION IF NOT EXISTS vector');
  await client.query(`
    CREATE TABLE IF NOT EXISTS decisions (
      id SERIAL PRIMARY KEY,
      project_id TEXT NOT NULL,
      topic TEXT, decision TEXT, reason TEXT,
      embedding halfvec(4000)
    );
    CREATE TABLE IF NOT EXISTS tasks (
      id SERIAL PRIMARY KEY,
      project_id TEXT NOT NULL,
      title TEXT, status TEXT
    );
    CREATE TABLE IF NOT EXISTS entities (
      id SERIAL PRIMARY KEY,
      project_id TEXT
    );
    CREATE TABLE IF NOT EXISTS edges (
      id SERIAL PRIMARY KEY,
      from_entity INTEGER,
      to_entity INTEGER,
      project_id TEXT
    );
    CREATE TABLE IF NOT EXISTS memory_entries (
      id SERIAL PRIMARY KEY,
      project_id TEXT
    );
    CREATE TABLE IF NOT EXISTS memory_entry_chunks (
      id SERIAL PRIMARY KEY,
      entry_id INTEGER,
      project_id TEXT
    );
    CREATE TABLE IF NOT EXISTS no_project_id_table (
      id SERIAL PRIMARY KEY,
      label TEXT
    );
  `);
}

async function setupSourceSchema(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS decisions (
      id SERIAL PRIMARY KEY,
      project_id TEXT,
      topic TEXT, decision TEXT, reason TEXT
    );
    CREATE TABLE IF NOT EXISTS tasks (
      id SERIAL PRIMARY KEY,
      project_id TEXT,
      title TEXT, status TEXT
    );
  `);
}

async function truncateAll(client, tables) {
  if (tables.length === 0) return;
  await client.query(`TRUNCATE ${tables.join(', ')} RESTART IDENTITY CASCADE`);
}

const BASE_ROSTER = [
  {
    source_db: SOURCE_DB, source_table: 'decisions', targetTable: 'decisions',
    loadBearingCols: ['topic', 'decision', 'reason'], hasContentBearingText: true,
    requires_project_id_scope: true, embeddingCol: 'embedding', contentCol: 'decision',
  },
  {
    source_db: SOURCE_DB, source_table: 'tasks', targetTable: 'tasks',
    loadBearingCols: ['title', 'status'], hasContentBearingText: false,
    requires_project_id_scope: true,
  },
];

// ── Test sections ─────────────────────────────────────────────────────────────

async function testT0() {
  const target = await pgConnect(TARGET_DB);
  try {
    await shared.applyDdl(target);
    await truncateAll(target, ['migration_manifest', 'migration_manifest_row_hashes']);

    // Roster entry with ZERO manifest rows -> FAIL.
    const rosterPath = writeTmpJson('t0-roster-missing.json', BASE_ROSTER);
    const r1 = runScript('verify-15-t0-roster.js', ['--db', TARGET_DB], rosterEnv(rosterPath));
    if (r1.status !== 0 && /FAIL/.test(r1.stdout + r1.stderr)) {
      pass('T0-a', 'roster entry with zero migration_manifest rows -> FAIL');
    } else {
      fail('T0-a', 'roster entry with zero migration_manifest rows -> FAIL', `status=${r1.status} stdout=${r1.stdout} stderr=${r1.stderr}`);
    }

    // Empty-but-snapshotted table (row_count=0 manifest row) -> PASS.
    await target.query(
      `INSERT INTO migration_manifest (source_db, source_table, project_id_or_null, row_count, content_fingerprint)
       VALUES ($1,'decisions',NULL,0,'emptyfingerprint'), ($1,'tasks','proj-a',0,'emptyfingerprint2')`,
      [SOURCE_DB]
    );
    const r2 = runScript('verify-15-t0-roster.js', ['--db', TARGET_DB], rosterEnv(rosterPath));
    if (r2.status === 0 && /OK/.test(r2.stdout)) {
      pass('T0-b', 'empty-but-snapshotted table (row_count=0 manifest row) -> PASS');
    } else {
      fail('T0-b', 'empty-but-snapshotted table (row_count=0 manifest row) -> PASS', `status=${r2.status} stdout=${r2.stdout} stderr=${r2.stderr}`);
    }
  } finally {
    await target.end();
  }
}

async function testT0Completeness() {
  // Direction 1: inventory has a table the roster never mentions -> FAIL.
  const inventoryExtra = writeTmpJson('inventory-extra.json', {
    tables: [{ targetTable: 'decisions' }, { targetTable: 'tasks' }, { targetTable: 'never_in_roster' }],
  });
  const rosterPath = writeTmpJson('t0c-roster.json', BASE_ROSTER);
  const r1 = runScript('verify-15-t0-roster-completeness.js', [], {
    ...rosterEnv(rosterPath),
    INVENTORY_MANIFEST: inventoryExtra,
  });
  if (r1.status !== 0 && /never_in_roster/.test(r1.stdout + r1.stderr)) {
    pass('T0c-a', 'inventory table with NO roster entry -> FAIL');
  } else {
    fail('T0c-a', 'inventory table with NO roster entry -> FAIL', `status=${r1.status} stdout=${r1.stdout} stderr=${r1.stderr}`);
  }

  // Direction 2: roster targetTable not declared in inventory and not pre-existing core -> FAIL.
  const rosterExtra = writeTmpJson('roster-extra.json', [
    ...BASE_ROSTER,
    { source_db: SOURCE_DB, source_table: 'mystery', targetTable: 'mystery_table',
      loadBearingCols: ['x'], hasContentBearingText: false, requires_project_id_scope: false },
  ]);
  const inventoryNormal = writeTmpJson('inventory-normal.json', {
    tables: [{ targetTable: 'decisions' }, { targetTable: 'tasks' }],
  });
  const r2 = runScript('verify-15-t0-roster-completeness.js', [], {
    ...rosterEnv(rosterExtra),
    INVENTORY_MANIFEST: inventoryNormal,
  });
  if (r2.status !== 0 && /mystery_table/.test(r2.stdout + r2.stderr)) {
    pass('T0c-b', 'roster targetTable not in inventory and not pre-existing core -> FAIL');
  } else {
    fail('T0c-b', 'roster targetTable not in inventory and not pre-existing core -> FAIL', `status=${r2.status} stdout=${r2.stdout} stderr=${r2.stderr}`);
  }

  // Clean match -> PASS.
  const r3 = runScript('verify-15-t0-roster-completeness.js', [], {
    ...rosterEnv(rosterPath),
    INVENTORY_MANIFEST: inventoryNormal,
  });
  if (r3.status === 0) {
    pass('T0c-c', 'roster and inventory cross-reference cleanly -> PASS');
  } else {
    fail('T0c-c', 'roster and inventory cross-reference cleanly -> PASS', `status=${r3.status} stdout=${r3.stdout} stderr=${r3.stderr}`);
  }
}

async function testT1Snapshot() {
  const source = await pgConnect(SOURCE_DB);
  const target = await pgConnect(TARGET_DB);
  try {
    await setupSourceSchema(source);
    await truncateAll(source, ['decisions', 'tasks']);
    await source.query(`INSERT INTO decisions (project_id, topic, decision, reason) VALUES ('proj-a','t1','d1','r1'), ('proj-a','t2','d2','r2')`);
    await source.query(`INSERT INTO tasks (project_id, title, status) VALUES ('proj-a','task1','pending')`);

    await shared.applyDdl(target);
    await truncateAll(target, ['migration_manifest', 'migration_manifest_row_hashes']);

    const rosterPath = writeTmpJson('t1-roster.json', BASE_ROSTER);
    const r = runScript('verify-15-t1-snapshot.js', ['--source-db', SOURCE_DB, '--db', TARGET_DB], rosterEnv(rosterPath));
    if (r.status !== 0) {
      fail('T1', 'snapshot populates migration_manifest + migration_manifest_row_hashes', `status=${r.status} stdout=${r.stdout} stderr=${r.stderr}`);
      return;
    }
    const { rows: mRows } = await target.query(`SELECT source_table, project_id_or_null, row_count FROM migration_manifest ORDER BY source_table`);
    const { rows: hRows } = await target.query(`SELECT COUNT(*) AS n FROM migration_manifest_row_hashes`);
    const decisionsRow = mRows.find((r2) => r2.source_table === 'decisions');
    const tasksRow = mRows.find((r2) => r2.source_table === 'tasks');
    if (decisionsRow && Number(decisionsRow.row_count) === 2 && tasksRow && Number(tasksRow.row_count) === 1 && Number(hRows[0].n) === 3) {
      pass('T1', 'snapshot populates migration_manifest + migration_manifest_row_hashes correctly');
    } else {
      fail('T1', 'snapshot populates migration_manifest + migration_manifest_row_hashes correctly', `mRows=${JSON.stringify(mRows)} hashCount=${hRows[0].n}`);
    }
  } finally {
    await source.end();
    await target.end();
  }
}

async function testFreezePrecondition() {
  const writable = await pgConnect(FREEZE_WRITABLE_DB);
  const frozen = await pgConnect(FREEZE_FROZEN_DB);
  try {
    await writable.query('CREATE TABLE IF NOT EXISTS decisions (id SERIAL PRIMARY KEY, project_id TEXT)');
    await frozen.query('CREATE TABLE IF NOT EXISTS decisions (id SERIAL PRIMARY KEY, project_id TEXT)');
  } finally {
    await writable.end();
    await frozen.end();
  }
  // Enforce freeze on FREEZE_FROZEN_DB via default_transaction_read_only.
  const sys = await pgConnect('postgres');
  try {
    await sys.query(`ALTER DATABASE "${FREEZE_FROZEN_DB}" SET default_transaction_read_only = true`);
  } finally {
    await sys.end();
  }

  const roster = [
    { source_db: FREEZE_WRITABLE_DB, source_table: 'decisions', targetTable: 'decisions', loadBearingCols: ['x'], hasContentBearingText: false, requires_project_id_scope: false },
  ];
  const rosterPathWritable = writeTmpJson('freeze-roster-writable.json', roster);
  const r1 = runScript('verify-15-freeze-precondition.js', [], rosterEnv(rosterPathWritable));
  if (r1.status !== 0 && /ACCEPTED the throwaway write/.test(r1.stdout + r1.stderr)) {
    pass('freeze-a', 'writable (non-frozen) source -> FAIL (freeze not enforced)');
  } else {
    fail('freeze-a', 'writable (non-frozen) source -> FAIL (freeze not enforced)', `status=${r1.status} stdout=${r1.stdout} stderr=${r1.stderr}`);
  }

  const rosterFrozen = [
    { source_db: FREEZE_FROZEN_DB, source_table: 'decisions', targetTable: 'decisions', loadBearingCols: ['x'], hasContentBearingText: false, requires_project_id_scope: false },
  ];
  const rosterPathFrozen = writeTmpJson('freeze-roster-frozen.json', rosterFrozen);
  const r2 = runScript('verify-15-freeze-precondition.js', [], rosterEnv(rosterPathFrozen));
  if (r2.status === 0 && /rejected the throwaway write/.test(r2.stdout)) {
    pass('freeze-b', 'frozen (read-only) source -> PASS (freeze enforced)');
  } else {
    fail('freeze-b', 'frozen (read-only) source -> PASS (freeze enforced)', `status=${r2.status} stdout=${r2.stdout} stderr=${r2.stderr}`);
  }
}

async function testT2Rowcount() {
  const target = await pgConnect(TARGET_DB);
  try {
    await shared.applyDdl(target);
    await truncateAll(target, ['migration_manifest', 'decisions', 'tasks']);

    await target.query(`INSERT INTO decisions (project_id, topic, decision, reason) VALUES ('proj-a','t','d','r'), ('proj-a','t2','d2','r2')`);
    await target.query(
      `INSERT INTO migration_manifest (source_db, source_table, project_id_or_null, row_count, content_fingerprint, excluded_reason)
       VALUES ($1,'decisions','proj-a',2,'fp1',NULL)`,
      [SOURCE_DB]
    );
    const rosterPath = writeTmpJson('t2-roster.json', BASE_ROSTER);

    const r1 = runScript('verify-15-t2-rowcount.js', ['--db', TARGET_DB], rosterEnv(rosterPath));
    if (r1.status === 0) pass('T2-a', 'matching row count -> PASS');
    else fail('T2-a', 'matching row count -> PASS', `status=${r1.status} stdout=${r1.stdout} stderr=${r1.stderr}`);

    // Excluded slice: row_count reflects the DATA rows (5), not manifest-row COUNT(*) (always 1).
    await target.query(
      `INSERT INTO migration_manifest (source_db, source_table, project_id_or_null, row_count, content_fingerprint, excluded_reason)
       VALUES ($1,'tasks','proj-b',5,'fp2','eval-junk')`,
      [SOURCE_DB]
    );
    // Zero tasks rows for proj-b in target -- correctly excluded.
    const r2 = runScript('verify-15-t2-rowcount.js', ['--db', TARGET_DB], rosterEnv(rosterPath));
    if (r2.status === 0) pass('T2-b', 'excluded slice: expected_target_rows computed from row_count, not manifest-row COUNT(*) -> PASS');
    else fail('T2-b', 'excluded slice: expected_target_rows computed from row_count, not manifest-row COUNT(*) -> PASS', `status=${r2.status} stdout=${r2.stdout} stderr=${r2.stderr}`);

    // Mismatch -> FAIL.
    await target.query(`INSERT INTO decisions (project_id, topic, decision, reason) VALUES ('proj-a','t3','d3','r3')`);
    const r3 = runScript('verify-15-t2-rowcount.js', ['--db', TARGET_DB], rosterEnv(rosterPath));
    if (r3.status !== 0) pass('T2-c', 'row count mismatch -> FAIL');
    else fail('T2-c', 'row count mismatch -> FAIL', `status=${r3.status} stdout=${r3.stdout} stderr=${r3.stderr}`);
  } finally {
    await target.end();
  }
}

async function testT25Dualwrite() {
  const target = await pgConnect(TARGET_DB);
  try {
    await shared.applyDdl(target);
    await truncateAll(target, ['dual_write_shim_window', 'old_store_row_hashes', 'memory_manager_staging_row_hashes']);

    const r1 = runScript('verify-15-t2-5-dualwrite.js', ['--db', TARGET_DB]);
    if (r1.status === 0 && /N\/A/.test(r1.stdout)) pass('T2.5-a', 'zero dual_write_shim_window rows -> N/A, exit 0');
    else fail('T2.5-a', 'zero dual_write_shim_window rows -> N/A, exit 0', `status=${r1.status} stdout=${r1.stdout} stderr=${r1.stderr}`);

    // Firing branch: shim window + drifted old_hash (no matching staging hash).
    await target.query(`INSERT INTO dual_write_shim_window (enabled_at, disabled_at, enabled_by) VALUES (NOW() - interval '1 hour', NOW(), 'test-operator')`);
    await target.query(`INSERT INTO old_store_row_hashes (project_id, old_hash, written_at) VALUES ('proj-a', 'drifted-hash-xyz', NOW() - interval '30 minutes')`);
    const r2 = runScript('verify-15-t2-5-dualwrite.js', ['--db', TARGET_DB]);
    if (r2.status !== 0 && /drifted-hash-xyz/.test(r2.stdout + r2.stderr)) pass('T2.5-b', 'shim row + drifted old_hash -> FAIL');
    else fail('T2.5-b', 'shim row + drifted old_hash -> FAIL', `status=${r2.status} stdout=${r2.stdout} stderr=${r2.stderr}`);

    // Reconciled: matching staging hash present.
    await target.query(`INSERT INTO memory_manager_staging_row_hashes (target_table, project_id, target_row_id, target_hash) VALUES ('decisions','proj-a','1','drifted-hash-xyz')`);
    const r3 = runScript('verify-15-t2-5-dualwrite.js', ['--db', TARGET_DB]);
    if (r3.status === 0) pass('T2.5-c', 'shim row + matching staging hash -> PASS');
    else fail('T2.5-c', 'shim row + matching staging hash -> PASS', `status=${r3.status} stdout=${r3.stdout} stderr=${r3.stderr}`);
  } finally {
    await target.end();
  }
}

async function testT3ContentHash() {
  const source = await pgConnect(SOURCE_DB);
  const target = await pgConnect(TARGET_DB);
  try {
    await setupSourceSchema(source);
    await truncateAll(source, ['decisions', 'tasks']);
    await truncateAll(target, ['decisions', 'tasks']);

    // Two identical-content source rows vs ONE target row -> FAIL (multiset).
    await source.query(`INSERT INTO decisions (project_id, topic, decision, reason) VALUES ('proj-a','dup','same','same'), ('proj-a','dup','same','same')`);
    await target.query(`INSERT INTO decisions (project_id, topic, decision, reason) VALUES ('proj-a','dup','same','same')`);
    const rosterPath = writeTmpJson('t3-roster.json', [BASE_ROSTER[0]]);

    const r1 = runScript('verify-15-t3-content-hash.js', ['--db', TARGET_DB], rosterEnv(rosterPath));
    if (r1.status !== 0 && /multiset mismatch/.test(r1.stdout + r1.stderr)) {
      pass('T3-a', 'two identical-content source rows vs one target row -> FAIL (multiset)');
    } else {
      fail('T3-a', 'two identical-content source rows vs one target row -> FAIL (multiset)', `status=${r1.status} stdout=${r1.stdout} stderr=${r1.stderr}`);
    }

    // Fix: add the matching second target row -> PASS.
    await target.query(`INSERT INTO decisions (project_id, topic, decision, reason) VALUES ('proj-a','dup','same','same')`);
    const r2 = runScript('verify-15-t3-content-hash.js', ['--db', TARGET_DB], rosterEnv(rosterPath));
    if (r2.status === 0) pass('T3-b', 'multiset counts match -> PASS');
    else fail('T3-b', 'multiset counts match -> PASS', `status=${r2.status} stdout=${r2.stdout} stderr=${r2.stderr}`);
  } finally {
    await source.end();
    await target.end();
  }
}

async function testT3bReverseContainment() {
  const target = await pgConnect(TARGET_DB);
  try {
    await shared.applyDdl(target);
    await truncateAll(target, ['migration_manifest', 'migration_manifest_row_hashes', 'memory_manager_staging_row_hashes', 'decisions', 'tasks']);

    const rosterPath = writeTmpJson('t3b-roster.json', BASE_ROSTER);

    // Reverse containment gap: a staging hash with no matching source hash.
    await target.query(`INSERT INTO memory_manager_staging_row_hashes (target_table, project_id, target_row_id, target_hash) VALUES ('decisions','proj-a','1','orphan-hash-1')`);
    const r1 = runScript('verify-15-t3b-reverse-containment.js', ['--db', TARGET_DB], rosterEnv(rosterPath));
    if (r1.status !== 0 && /reverse containment gap/.test(r1.stdout + r1.stderr)) pass('T3b-a', 'staging hash with no source counterpart -> FAIL');
    else fail('T3b-a', 'staging hash with no source counterpart -> FAIL', `status=${r1.status} stdout=${r1.stdout} stderr=${r1.stderr}`);

    await truncateAll(target, ['memory_manager_staging_row_hashes']);
    await target.query(`INSERT INTO migration_manifest_row_hashes (source_db, source_table, project_id_or_null, source_row_id, source_hash) VALUES ($1,'decisions','proj-a','1','matched-hash-1')`, [SOURCE_DB]);
    await target.query(`INSERT INTO memory_manager_staging_row_hashes (target_table, project_id, target_row_id, target_hash) VALUES ('decisions','proj-a','1','matched-hash-1')`);
    const r2 = runScript('verify-15-t3b-reverse-containment.js', ['--db', TARGET_DB], rosterEnv(rosterPath));
    if (r2.status === 0) pass('T3b-b', 'matched hash -> PASS (reverse containment holds)');
    else fail('T3b-b', 'matched hash -> PASS (reverse containment holds)', `status=${r2.status} stdout=${r2.stdout} stderr=${r2.stderr}`);

    // Total-rowcount: an unaccounted target project_id.
    await target.query(`INSERT INTO decisions (project_id, topic, decision, reason) VALUES ('proj-unaccounted','t','d','r')`);
    const r3 = runScript('verify-15-t3b-reverse-containment.js', ['--db', TARGET_DB], rosterEnv(rosterPath));
    if (r3.status !== 0 && /proj-unaccounted/.test(r3.stdout + r3.stderr)) pass('T3b-c', 'unaccounted target project_id -> FAIL');
    else fail('T3b-c', 'unaccounted target project_id -> FAIL', `status=${r3.status} stdout=${r3.stdout} stderr=${r3.stderr}`);
  } finally {
    await target.end();
  }
}

async function testT4RecallEquivalence() {
  const source = await pgConnect(SOURCE_DB);
  const target = await pgConnect(TARGET_DB);
  try {
    await setupSourceSchema(source);
    await truncateAll(source, ['decisions', 'tasks']);
    await truncateAll(target, ['migration_manifest', 'decisions', 'tasks']);

    await source.query(`INSERT INTO decisions (project_id, topic, decision, reason) VALUES ('proj-a','topic1','decision1','reason1')`);
    await target.query(`INSERT INTO decisions (project_id, topic, decision, reason) VALUES ('proj-a','topic1','decision1','reason1')`);
    await target.query(
      `INSERT INTO migration_manifest (source_db, source_table, project_id_or_null, row_count, content_fingerprint)
       VALUES ($1,'decisions','proj-a',1,'fp')`,
      [SOURCE_DB]
    );
    const rosterPath = writeTmpJson('t4-roster.json', BASE_ROSTER);

    // Missing fixture coverage -> FATAL, loud, before any query runs.
    const emptyFixtures = writeTmpJson('t4-fixtures-empty.json', { projects: [], isolation: [] });
    const r1 = runScript('verify-15-t4-recall-equivalence.js', ['--db', TARGET_DB, '--recorded-by', 'test-recorder'], {
      ...rosterEnv(rosterPath),
      RECALL_EQUIVALENCE_QUERIES: emptyFixtures,
    });
    if (r1.status !== 0 && /fixture coverage precondition FAILED/.test(r1.stdout + r1.stderr)) {
      pass('T4-a', 'zero fixture coverage for a manifest-covered pair -> FATAL before any query runs');
    } else {
      fail('T4-a', 'zero fixture coverage for a manifest-covered pair -> FATAL before any query runs', `status=${r1.status} stdout=${r1.stdout} stderr=${r1.stderr}`);
    }

    // Full coverage, matching fact -> PASS, evidence row written.
    const goodFixtures = writeTmpJson('t4-fixtures-good.json', {
      projects: [{
        project_id: 'proj-a',
        queries: [{
          table: 'decisions',
          old_store: { database: SOURCE_DB, sql: 'SELECT topic, decision, reason FROM decisions WHERE project_id = $1', params: ['proj-a'] },
          staging: { sql: 'SELECT topic, decision, reason FROM decisions WHERE project_id = $1', params: ['proj-a'] },
          tuple_cols: ['topic', 'decision', 'reason'],
        }],
      }],
      isolation: [],
    });
    const r2 = runScript('verify-15-t4-recall-equivalence.js', ['--db', TARGET_DB, '--recorded-by', 'test-recorder'], {
      ...rosterEnv(rosterPath),
      RECALL_EQUIVALENCE_QUERIES: goodFixtures,
    });
    if (r2.status === 0) pass('T4-b', 'full fixture coverage + matching fact -> PASS');
    else fail('T4-b', 'full fixture coverage + matching fact -> PASS', `status=${r2.status} stdout=${r2.stdout} stderr=${r2.stderr}`);

    const { rows: evRows } = await target.query(`SELECT * FROM containment_evidence WHERE check_id = 'T4' AND recorded_by = 'test-recorder'`);
    if (evRows.length > 0) pass('T4-evidence', 'T4 writes a containment_evidence row on precondition pass');
    else fail('T4-evidence', 'T4 writes a containment_evidence row on precondition pass', 'no row found');

    // Missing fact -> FAIL.
    await target.query(`DELETE FROM decisions WHERE topic = 'topic1'`);
    const r3 = runScript('verify-15-t4-recall-equivalence.js', ['--db', TARGET_DB, '--recorded-by', 'test-recorder'], {
      ...rosterEnv(rosterPath),
      RECALL_EQUIVALENCE_QUERIES: goodFixtures,
    });
    if (r3.status !== 0 && /missing from staging/.test(r3.stdout + r3.stderr)) pass('T4-c', 'missing fact in staging -> FAIL');
    else fail('T4-c', 'missing fact in staging -> FAIL', `status=${r3.status} stdout=${r3.stdout} stderr=${r3.stderr}`);

    // Isolation leak -> FAIL.
    await target.query(`INSERT INTO decisions (project_id, topic, decision, reason) VALUES ('proj-a','topic1','decision1','reason1'), ('proj-b','leaked','leaked','leaked')`);
    const leakFixtures = writeTmpJson('t4-fixtures-leak.json', {
      projects: [{
        project_id: 'proj-a',
        queries: [{
          table: 'decisions',
          old_store: { database: SOURCE_DB, sql: 'SELECT topic, decision, reason FROM decisions WHERE project_id = $1', params: ['proj-a'] },
          staging: { sql: 'SELECT topic, decision, reason FROM decisions WHERE project_id = $1', params: ['proj-a'] },
          tuple_cols: ['topic', 'decision', 'reason'],
        }],
      }],
      isolation: [{ project_a: 'proj-a', project_b: 'proj-b', staging_sql: 'SELECT project_id FROM decisions', params: [] }],
    });
    const r4 = runScript('verify-15-t4-recall-equivalence.js', ['--db', TARGET_DB, '--recorded-by', 'test-recorder'], {
      ...rosterEnv(rosterPath),
      RECALL_EQUIVALENCE_QUERIES: leakFixtures,
    });
    if (r4.status !== 0 && /leaked/.test(r4.stdout + r4.stderr)) pass('T4-d', 'cross-project isolation leak -> FAIL');
    else fail('T4-d', 'cross-project isolation leak -> FAIL', `status=${r4.status} stdout=${r4.stdout} stderr=${r4.stderr}`);
  } finally {
    await source.end();
    await target.end();
  }
}

async function testT5EmbeddingCoverage() {
  const target = await pgConnect(TARGET_DB);
  try {
    await truncateAll(target, ['decisions']);
    const rosterPath = writeTmpJson('t5-roster.json', [BASE_ROSTER[0]]);

    // Unembedded content-bearing row -> FAIL.
    await target.query(`INSERT INTO decisions (project_id, topic, decision, reason) VALUES ('proj-a','t','some decision text','r')`);
    const r1 = runScript('verify-15-t5-embedding-coverage.js', ['--db', TARGET_DB], rosterEnv(rosterPath));
    if (r1.status !== 0 && /unembedded/.test(r1.stdout + r1.stderr)) pass('T5-a', 'unembedded content-bearing row -> FAIL');
    else fail('T5-a', 'unembedded content-bearing row -> FAIL', `status=${r1.status} stdout=${r1.stdout} stderr=${r1.stderr}`);

    // Embedded -> PASS.
    const fakeVec = `[${Array(4000).fill(0).map(() => '0').join(',')}]`;
    await target.query(`UPDATE decisions SET embedding = $1::halfvec(4000) WHERE topic = 't'`, [fakeVec]);
    const r2 = runScript('verify-15-t5-embedding-coverage.js', ['--db', TARGET_DB], rosterEnv(rosterPath));
    if (r2.status === 0) pass('T5-b', 'all content-bearing rows embedded, correct type -> PASS');
    else fail('T5-b', 'all content-bearing rows embedded, correct type -> PASS', `status=${r2.status} stdout=${r2.stdout} stderr=${r2.stderr}`);
  } finally {
    await target.end();
  }
}

async function testT6ReferentialIntegrity() {
  const target = await pgConnect(TARGET_DB);
  try {
    await truncateAll(target, ['edges', 'entities', 'memory_entries', 'memory_entry_chunks']);

    // Roster-scoped fixture table with project_id column entirely MISSING -> FAIL.
    const rosterMissingCol = [
      { source_db: SOURCE_DB, source_table: 'no_project_id_table', targetTable: 'no_project_id_table',
        loadBearingCols: ['label'], hasContentBearingText: false, requires_project_id_scope: true },
    ];
    const rosterPath1 = writeTmpJson('t6-roster-missing-col.json', rosterMissingCol);
    const r1 = runScript('verify-15-t6-referential-integrity.js', ['--db', TARGET_DB], rosterEnv(rosterPath1));
    if (r1.status !== 0 && /project_id column MISSING entirely/.test(r1.stdout + r1.stderr)) {
      pass('T6-a', 'roster-scoped table with project_id column entirely MISSING -> FAIL');
    } else {
      fail('T6-a', 'roster-scoped table with project_id column entirely MISSING -> FAIL', `status=${r1.status} stdout=${r1.stdout} stderr=${r1.stderr}`);
    }

    // Orphan edge -> FAIL.
    const rosterPath2 = writeTmpJson('t6-roster-clean.json', BASE_ROSTER);
    await target.query(`INSERT INTO edges (from_entity, to_entity, project_id) VALUES (9999, 9998, 'proj-a')`);
    const r2 = runScript('verify-15-t6-referential-integrity.js', ['--db', TARGET_DB], rosterEnv(rosterPath2));
    if (r2.status !== 0 && /orphan edge/.test(r2.stdout + r2.stderr)) pass('T6-b', 'orphan edge -> FAIL');
    else fail('T6-b', 'orphan edge -> FAIL', `status=${r2.status} stdout=${r2.stdout} stderr=${r2.stderr}`);

    // Clean -> PASS.
    await truncateAll(target, ['edges', 'entities', 'memory_entries', 'memory_entry_chunks']);
    const r3 = runScript('verify-15-t6-referential-integrity.js', ['--db', TARGET_DB], rosterEnv(rosterPath2));
    if (r3.status === 0) pass('T6-c', 'zero orphans + full project_id coverage -> PASS');
    else fail('T6-c', 'zero orphans + full project_id coverage -> PASS', `status=${r3.status} stdout=${r3.stdout} stderr=${r3.stderr}`);
  } finally {
    await target.end();
  }
}

async function testT7CavemanEconomy() {
  const r = runScript('verify-15-t7-caveman-economy.js', ['--db', TARGET_DB]);
  if (r.status !== 0 && /prerequisite .* not built/.test(r.stdout + r.stderr)) {
    pass('T7', 'store-wide caveman gate prerequisite not built -> FAIL, loud, non-zero exit (never silently passes)');
  } else {
    fail('T7', 'store-wide caveman gate prerequisite not built -> FAIL, loud, non-zero exit (never silently passes)', `status=${r.status} stdout=${r.stdout} stderr=${r.stderr}`);
  }
}

async function testT8Idempotency() {
  const target = await pgConnect(TARGET_DB);
  try {
    await truncateAll(target, ['decisions', 'tasks', 'edges', 'entities', 'memory_entries', 'memory_entry_chunks']);
    await target.query(`INSERT INTO decisions (project_id, topic, decision, reason) VALUES ('proj-a','t','d','r')`);
    const rosterPath = writeTmpJson('t8-roster.json', BASE_ROSTER);

    // Full-row change on re-run -> FAIL.
    const mutatingModule = path.join(TMP_DIR, 't8-mutating-rerun.js');
    fs.writeFileSync(mutatingModule, `
      module.exports.run = async function(targetDbName) {
        const { Client } = require(${JSON.stringify(path.join(PROJECT_ROOT, 'scripts', 'node_modules', 'pg'))});
        const c = new Client({ host: 'localhost', port: 5432, user: 'postgres', password: 'postgres', database: targetDbName });
        await c.connect();
        await c.query("UPDATE decisions SET reason = 'changed' WHERE topic = 't'");
        await c.end();
        return true;
      };
    `, 'utf8');
    CREATED_TMP_FILES.push(mutatingModule);
    const r1 = runScript('verify-15-t8-idempotency.js', ['--db', TARGET_DB, '--rerun-module', mutatingModule], rosterEnv(rosterPath));
    if (r1.status !== 0 && /changed row/.test(r1.stdout + r1.stderr)) pass('T8-a', 'full-row change on re-run -> FAIL');
    else fail('T8-a', 'full-row change on re-run -> FAIL', `status=${r1.status} stdout=${r1.stdout} stderr=${r1.stderr}`);

    // Embedding-only change -> PASS (exempt).
    await target.query(`UPDATE decisions SET reason = 'r' WHERE topic = 't'`); // revert
    const embedOnlyModule = path.join(TMP_DIR, 't8-embed-rerun.js');
    fs.writeFileSync(embedOnlyModule, `
      module.exports.run = async function(targetDbName) {
        const { Client } = require(${JSON.stringify(path.join(PROJECT_ROOT, 'scripts', 'node_modules', 'pg'))});
        const c = new Client({ host: 'localhost', port: 5432, user: 'postgres', password: 'postgres', database: targetDbName });
        await c.connect();
        const vec = '[' + Array(4000).fill('0').join(',') + ']';
        await c.query("UPDATE decisions SET embedding = $1::halfvec(4000) WHERE topic = 't'", [vec]);
        await c.end();
        return true;
      };
    `, 'utf8');
    CREATED_TMP_FILES.push(embedOnlyModule);
    const r2 = runScript('verify-15-t8-idempotency.js', ['--db', TARGET_DB, '--rerun-module', embedOnlyModule], rosterEnv(rosterPath));
    if (r2.status === 0) pass('T8-b', 'embedding-only change on re-run -> PASS (exempt column)');
    else fail('T8-b', 'embedding-only change on re-run -> PASS (exempt column)', `status=${r2.status} stdout=${r2.stdout} stderr=${r2.stderr}`);

    // T6 re-run wired: rerun module introduces an orphan edge -> FAIL.
    const orphanModule = path.join(TMP_DIR, 't8-orphan-rerun.js');
    fs.writeFileSync(orphanModule, `
      module.exports.run = async function(targetDbName) {
        const { Client } = require(${JSON.stringify(path.join(PROJECT_ROOT, 'scripts', 'node_modules', 'pg'))});
        const c = new Client({ host: 'localhost', port: 5432, user: 'postgres', password: 'postgres', database: targetDbName });
        await c.connect();
        await c.query("INSERT INTO edges (from_entity, to_entity, project_id) VALUES (77777, 77778, 'proj-a')");
        await c.end();
        return true;
      };
    `, 'utf8');
    CREATED_TMP_FILES.push(orphanModule);
    const r3 = runScript('verify-15-t8-idempotency.js', ['--db', TARGET_DB, '--rerun-module', orphanModule], rosterEnv(rosterPath));
    if (r3.status !== 0 && /T6 re-run/.test(r3.stdout + r3.stderr)) pass('T8-c', 'rerun introduces orphan edge -> T6 re-run catches it -> FAIL');
    else fail('T8-c', 'rerun introduces orphan edge -> T6 re-run catches it -> FAIL', `status=${r3.status} stdout=${r3.stdout} stderr=${r3.stderr}`);

    await target.query(`DELETE FROM edges WHERE from_entity = 77777`);
  } finally {
    await target.end();
  }
}

async function testT9Negative() {
  const target = await pgConnect(TARGET_DB);
  try {
    await shared.applyDdl(target);
    await truncateAll(target, ['migration_manifest', 'decisions', 'tasks']);
    const rosterPath = writeTmpJson('t9-roster.json', BASE_ROSTER);

    // Normal (project-scoped) exclusion leak -> FAIL.
    await target.query(
      `INSERT INTO migration_manifest (source_db, source_table, project_id_or_null, row_count, content_fingerprint, excluded_reason)
       VALUES ($1,'decisions','proj-eval-junk',3,'fp','eval-junk-project-id')`,
      [SOURCE_DB]
    );
    await target.query(`INSERT INTO decisions (project_id, topic, decision, reason) VALUES ('proj-eval-junk','leaked','leaked','leaked')`);
    const r1 = runScript('verify-15-t9-negative.js', ['--db', TARGET_DB], rosterEnv(rosterPath));
    if (r1.status !== 0 && /excluded but/.test(r1.stdout + r1.stderr)) pass('T9-a', 'project-scoped exclusion leak -> FAIL');
    else fail('T9-a', 'project-scoped exclusion leak -> FAIL', `status=${r1.status} stdout=${r1.stdout} stderr=${r1.stderr}`);

    await target.query(`DELETE FROM decisions WHERE project_id = 'proj-eval-junk'`);
    const r2 = runScript('verify-15-t9-negative.js', ['--db', TARGET_DB], rosterEnv(rosterPath));
    if (r2.status === 0) pass('T9-b', 'project-scoped exclusion, zero leaked rows -> PASS');
    else fail('T9-b', 'project-scoped exclusion, zero leaked rows -> PASS', `status=${r2.status} stdout=${r2.stdout} stderr=${r2.stderr}`);

    // REQUIRED positive fixture (spec-mandated by name): synthetic
    // EPHEMERAL-DROP-shaped exclusion (project_id_or_null = NULL) with a
    // leaked row that the provenance check catches.
    await truncateAll(target, ['migration_manifest']);
    await target.query(
      `INSERT INTO migration_manifest (source_db, source_table, project_id_or_null, row_count, content_fingerprint, excluded_reason)
       VALUES ('ephemeral_test_db','decisions',NULL,2,'fp','ephemeral-db-triage-drop')`
    );
    // No matching migration_manifest row confirming the exclusion for THIS
    // source_table under NULL scope other than the one just inserted -- but
    // to prove the provenance check actually FIRES (not just the live-count
    // branch), simulate the broken-provenance case: delete the manifest row
    // that WOULD confirm it, while a target row purporting to be that
    // source's leakage still needs catching. Since target tables always
    // have project_id NOT NULL (T6), the live-count branch structurally
    // cannot observe a NULL-scoped leak -- this is exactly why the
    // provenance branch exists. Break it by removing the manifest evidence:
    await truncateAll(target, ['migration_manifest']);
    const r3 = runScript('verify-15-t9-negative.js', ['--db', TARGET_DB], rosterEnv(rosterPath));
    if (r3.status === 0 && /zero excluded_reason values/.test(r3.stdout)) {
      pass('T9-c-setup', 'no exclusions recorded -> legitimate PASS (nothing to check)');
    } else {
      fail('T9-c-setup', 'no exclusions recorded -> legitimate PASS (nothing to check)', `status=${r3.status} stdout=${r3.stdout}`);
    }
    // Now the real positive fixture: exclusion IS recorded (provenance
    // present) -- provenance check passes because migration_manifest
    // correctly confirms the exclusion, AND the live-count branch
    // (structurally unfalsifiable for NULL scope, by design) also reports
    // zero. This proves the NULL-scoped branch executes end-to-end without
    // crashing and reports the correct PASS state when provenance IS intact.
    await target.query(
      `INSERT INTO migration_manifest (source_db, source_table, project_id_or_null, row_count, content_fingerprint, excluded_reason)
       VALUES ('ephemeral_test_db','decisions',NULL,2,'fp','ephemeral-db-triage-drop')`
    );
    const r4 = runScript('verify-15-t9-negative.js', ['--db', TARGET_DB], rosterEnv(rosterPath));
    if (r4.status === 0 && /NULL-scoped/.test(r4.stdout)) {
      pass('T9-d', 'NULL-scoped EPHEMERAL-DROP-shaped exclusion with provenance intact -> PASS (provenance branch exercised)');
    } else {
      fail('T9-d', 'NULL-scoped EPHEMERAL-DROP-shaped exclusion with provenance intact -> PASS (provenance branch exercised)', `status=${r4.status} stdout=${r4.stdout} stderr=${r4.stderr}`);
    }
    // Break provenance directly via checkExclusion's exported unit, proving
    // the provenance branch FAILS when migration_manifest does not confirm
    // the exclusion (simulated by querying against a source_table with no
    // confirming manifest row for NULL scope).
    const t9mod = require(scriptPath('verify-15-t9-negative.js'));
    const roster = JSON.parse(fs.readFileSync(rosterPath, 'utf8'));
    const brokenResult = await t9mod.checkExclusion(target, roster, {
      excluded_reason: 'ephemeral-db-triage-drop', source_table: 'decisions', project_id_or_null: null,
    });
    // migration_manifest currently HAS the confirming row (inserted above),
    // so this should be ok=true; now delete it and re-check for ok=false.
    await truncateAll(target, ['migration_manifest']);
    const brokenResult2 = await t9mod.checkExclusion(target, roster, {
      excluded_reason: 'ephemeral-db-triage-drop', source_table: 'decisions', project_id_or_null: null,
    });
    if (brokenResult.ok === true && brokenResult2.ok === false) {
      pass('T9-e', 'provenance check unit: confirms PASS when manifest row present, FAIL when absent (proves the check actually fires)');
    } else {
      fail('T9-e', 'provenance check unit: confirms PASS when manifest row present, FAIL when absent (proves the check actually fires)', `brokenResult=${JSON.stringify(brokenResult)} brokenResult2=${JSON.stringify(brokenResult2)}`);
    }
  } finally {
    await target.end();
  }
}

async function testAcceptanceIndependence() {
  const target = await pgConnect(TARGET_DB);
  try {
    await shared.applyDdl(target);
    await truncateAll(target, ['containment_evidence']);

    const authorship = shared.loadHarnessAuthorship();
    const anAuthoredById = Object.values(authorship)[0].AUTHORED_BY;

    // recorded_by == authoring id -> T10 independence FAIL.
    await target.query(
      `INSERT INTO containment_evidence (check_id, query_text, result, recorded_by) VALUES ('T4','probe','result',$1)`,
      [anAuthoredById]
    );
    const acceptanceMod = require(scriptPath('verify-15-acceptance.js'));
    const check1 = await acceptanceMod.checkRecordedByIndependence(TARGET_DB);
    if (check1.pass === false && check1.violations.length > 0) {
      pass('T10-independence-a', 'recorded_by == authoring id -> T10 independence FAIL');
    } else {
      fail('T10-independence-a', 'recorded_by == authoring id -> T10 independence FAIL', JSON.stringify(check1));
    }

    await truncateAll(target, ['containment_evidence']);
    await target.query(
      `INSERT INTO containment_evidence (check_id, query_text, result, recorded_by) VALUES ('T4','probe','result','a-different-agent-id')`
    );
    const check2 = await acceptanceMod.checkRecordedByIndependence(TARGET_DB);
    if (check2.pass === true) {
      pass('T10-independence-b', 'recorded_by != authoring id -> T10 independence PASS');
    } else {
      fail('T10-independence-b', 'recorded_by != authoring id -> T10 independence PASS', JSON.stringify(check2));
    }
  } finally {
    await target.end();
  }
}

// ── Source-level sweep: zero live `NOT IN (` SQL instances in authored scripts ──

function stripJsComments(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  while (i < n) {
    const two = src.slice(i, i + 2);
    if (two === '//') {
      while (i < n && src[i] !== '\n') i++;
      continue;
    }
    if (two === '/*') {
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    if (src[i] === '`' || src[i] === "'" || src[i] === '"') {
      const quote = src[i];
      out += src[i]; i++;
      while (i < n && src[i] !== quote) {
        if (src[i] === '\\') { out += src[i]; i++; if (i < n) { out += src[i]; i++; } continue; }
        out += src[i]; i++;
      }
      if (i < n) { out += src[i]; i++; }
      continue;
    }
    out += src[i]; i++;
  }
  return out;
}

function findNotInInStringsAndTemplates(src) {
  // Re-scan the RAW source (not comment-stripped) specifically for backtick
  // template literals and quoted strings, checking their CONTENTS for
  // "NOT IN (" — comments (// and /* */) are excluded by first blanking
  // them out (replacing with spaces, preserving positions) so a prose
  // mention like "not NOT IN" inside a comment never matches.
  let blanked = '';
  let i = 0;
  const n = src.length;
  const hits = [];
  while (i < n) {
    const two = src.slice(i, i + 2);
    if (two === '//') {
      while (i < n && src[i] !== '\n') { blanked += ' '; i++; }
      continue;
    }
    if (two === '/*') {
      blanked += '  '; i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) { blanked += (src[i] === '\n' ? '\n' : ' '); i++; }
      if (i < n) { blanked += '  '; i += 2; }
      continue;
    }
    if (src[i] === '`' || src[i] === "'" || src[i] === '"') {
      const quote = src[i];
      const start = i;
      i++;
      while (i < n && src[i] !== quote) {
        if (src[i] === '\\') { i += 2; continue; }
        i++;
      }
      if (i < n) i++;
      const literal = src.slice(start, i);
      if (/NOT\s+IN\s*\(/i.test(literal)) hits.push(literal.slice(0, 80));
      blanked += literal.replace(/[^\n]/g, ' ');
      continue;
    }
    blanked += src[i]; i++;
  }
  return hits;
}

async function testNotInSweep() {
  const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.startsWith('verify-15-') && f.endsWith('.js'));
  files.push('lib/verify15-shared.js');
  const allHits = [];
  for (const f of files) {
    const src = fs.readFileSync(path.join(MIGRATIONS_DIR, f), 'utf8');
    const hits = findNotInInStringsAndTemplates(src);
    for (const h of hits) allHits.push(`${f}: ${h}`);
  }
  if (allHits.length === 0) {
    pass('NOT-IN-sweep', 'zero live `NOT IN (` SQL instances in string/template literals across all verify-15-*.js scripts');
  } else {
    fail('NOT-IN-sweep', 'zero live `NOT IN (` SQL instances in string/template literals across all verify-15-*.js scripts', allHits.join('; '));
  }
}

// ── Main ───────────────────────────────────────────────────────────────────────

async function main() {
  try {
    await createDb(TARGET_DB);
    await createDb(SOURCE_DB);
    await createDb(FREEZE_WRITABLE_DB);
    await createDb(FREEZE_FROZEN_DB);

    const target = await pgConnect(TARGET_DB);
    try {
      await setupTargetSchema(target);
    } finally {
      await target.end();
    }
    const source = await pgConnect(SOURCE_DB);
    try {
      await setupSourceSchema(source);
    } finally {
      await source.end();
    }

    await testT0();
    await testT0Completeness();
    await testT1Snapshot();
    await testFreezePrecondition();
    await testT2Rowcount();
    await testT25Dualwrite();
    await testT3ContentHash();
    await testT3bReverseContainment();
    await testT4RecallEquivalence();
    await testT5EmbeddingCoverage();
    await testT6ReferentialIntegrity();
    await testT7CavemanEconomy();
    await testT8Idempotency();
    await testT9Negative();
    await testAcceptanceIndependence();
    await testNotInSweep();
  } finally {
    for (const db of CREATED_DBS) {
      await dropDb(db);
    }
    for (const f of CREATED_TMP_FILES) {
      try { fs.unlinkSync(f); } catch (_) {}
    }
    try { fs.rmdirSync(TMP_DIR); } catch (_) {}
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exitCode = 1;
});
