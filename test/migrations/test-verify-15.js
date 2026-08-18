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
const migrateOne = require(path.join(MIGRATIONS_DIR, 'migrate-01-canonical-db.js'));

const TS = Date.now();

/** Applies the REAL engine-core schema (migrate-01's own four SQL files) to
 * an already-connected client — used by T0's live-table classification test
 * to prove engine-core tables classify cleanly against the SAME derivation
 * shared.getEngineCoreObjects() uses at runtime, not a synthetic stand-in. */
async function applyRealEngineSchema(client) {
  await migrateOne.ensureExtensions(client);
  for (const file of migrateOne.SCHEMA_FILES) {
    await migrateOne.applySqlFile(client, file);
  }
}

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
const LIVE_TABLE_DB = `verify15_livetable_${TS}_staging`;
const CREATED_DBS = [TARGET_DB, SOURCE_DB, FREEZE_WRITABLE_DB, FREEZE_FROZEN_DB, LIVE_TABLE_DB];

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
      project_id TEXT NOT NULL,
      name TEXT NOT NULL,
      suppressed BOOLEAN NOT NULL DEFAULT false
    );
    CREATE TABLE IF NOT EXISTS edges (
      id SERIAL PRIMARY KEY,
      from_entity TEXT NOT NULL,
      to_entity TEXT NOT NULL,
      project_id TEXT NOT NULL,
      suppressed BOOLEAN NOT NULL DEFAULT false
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
    CREATE TABLE IF NOT EXISTS routing_profiles (
      id SERIAL PRIMARY KEY,
      project_id TEXT NOT NULL,
      role TEXT, preferred_model TEXT
    );
    -- cm#187/cm#188 (2026-08-18): a retrieval_event_assertions-shaped
    -- fixture -- NO id column, NO project_id column at all (a bare join
    -- table), mirroring the live schema evidence in cm#187's issue body.
    -- Used by T2/T3/T3b/T9's no-project_id-column fixtures (BF-R1/BF-R2/
    -- BF-R3/BF-R4).
    CREATE TABLE IF NOT EXISTS retrieval_event_assertions (
      event_id INTEGER,
      assertion_id INTEGER
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
    CREATE TABLE IF NOT EXISTS retrieval_event_assertions (
      event_id INTEGER,
      assertion_id INTEGER
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

// cm#187/cm#188 (2026-08-18 spec-adversary pass): a SOURCED roster entry
// whose targetTable has NO project_id column AND no id column at all --
// mirrors the live-schema evidence for retrieval_event_assertions cited in
// cm#187's issue body (event_id/assertion_id only). Reused across T2/T3/
// T3b/T9's no-project_id-column fixtures below (BF-R1/BF-R2/BF-R3/BF-R4).
const NO_COLUMN_ROSTER_ENTRY = {
  source_db: SOURCE_DB, source_table: 'retrieval_event_assertions', targetTable: 'retrieval_event_assertions',
  loadBearingCols: ['event_id', 'assertion_id'], hasContentBearingText: false,
  requires_project_id_scope: false,
};

// A SOURCELESS (net-new:) roster entry — a §17/§18-shaped table with no
// migration source. Reused across T0/T3/T3b's sourceless-classification
// tests below.
const SOURCELESS_ROSTER_ENTRY = {
  source_db: 'net-new:memory_manager', source_table: 'routing_profiles', targetTable: 'routing_profiles',
  loadBearingCols: ['role', 'preferred_model'], hasContentBearingText: false,
  requires_project_id_scope: true,
};

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

async function testT0SourcelessClassification() {
  // (i) A roster with ONLY a sourceless (net-new:) entry, zero
  // migration_manifest rows -> T0 PASS, with the explicit sourceless line
  // printed (never a silent skip).
  const target = await pgConnect(TARGET_DB);
  try {
    await shared.applyDdl(target);
    await truncateAll(target, ['migration_manifest']);

    const sourcelessOnlyRoster = writeTmpJson('t0-sourceless-only.json', [SOURCELESS_ROSTER_ENTRY]);
    const r1 = runScript('verify-15-t0-roster.js', ['--db', TARGET_DB], rosterEnv(sourcelessOnlyRoster));
    if (r1.status === 0 && /SOURCELESS/.test(r1.stdout) && /net-new:memory_manager -> routing_profiles/.test(r1.stdout)) {
      pass('T0-sourceless-i', 'net-new entry with zero manifest rows -> T0 PASS, explicit sourceless line printed');
    } else {
      fail('T0-sourceless-i', 'net-new entry with zero manifest rows -> T0 PASS, explicit sourceless line printed', `status=${r1.status} stdout=${r1.stdout} stderr=${r1.stderr}`);
    }

    // (ii) Mixed roster: sourced entry with zero manifest rows still FAILs,
    // even though the sourceless entry in the SAME roster is fine.
    const mixedRoster = writeTmpJson('t0-sourceless-mixed.json', [BASE_ROSTER[0], SOURCELESS_ROSTER_ENTRY]);
    const r2 = runScript('verify-15-t0-roster.js', ['--db', TARGET_DB], rosterEnv(mixedRoster));
    if (r2.status !== 0 && /SOURCED roster entr/.test(r2.stdout + r2.stderr) && /SOURCELESS/.test(r2.stdout)) {
      pass('T0-sourceless-ii', 'sourced entry with zero manifest rows still FAILs, even alongside a satisfied sourceless entry (sourceless line still printed)');
    } else {
      fail('T0-sourceless-ii', 'sourced entry with zero manifest rows still FAILs, even alongside a satisfied sourceless entry (sourceless line still printed)', `status=${r2.status} stdout=${r2.stdout} stderr=${r2.stderr}`);
    }

    // Same mixed roster, sourced entry NOW satisfied -> T0 PASS overall,
    // sourceless line still printed.
    await target.query(
      `INSERT INTO migration_manifest (source_db, source_table, project_id_or_null, row_count, content_fingerprint)
       VALUES ($1,'decisions','proj-a',1,'fp')`,
      [SOURCE_DB]
    );
    const r3 = runScript('verify-15-t0-roster.js', ['--db', TARGET_DB], rosterEnv(mixedRoster));
    if (r3.status === 0 && /SOURCELESS/.test(r3.stdout)) {
      pass('T0-sourceless-iii', 'mixed roster, sourced entry satisfied -> T0 PASS overall, sourceless entry still named explicitly');
    } else {
      fail('T0-sourceless-iii', 'mixed roster, sourced entry satisfied -> T0 PASS overall, sourceless entry still named explicitly', `status=${r3.status} stdout=${r3.stdout} stderr=${r3.stderr}`);
    }
  } finally {
    await target.end();
  }
}

async function testT0InverseDirection() {
  // Closes the open gap named in this PR's own blind-spot section: a
  // forgotten roster reclassification (a manifest source with no roster
  // entry) must now trip T0 loud, not stay invisible forever.
  const target = await pgConnect(TARGET_DB);
  try {
    await shared.applyDdl(target);
    await truncateAll(target, ['migration_manifest']);

    const rosterPath = writeTmpJson('t0-inverse-roster.json', BASE_ROSTER);

    // Satisfy the forward direction for both BASE_ROSTER entries first, so
    // any FAIL below is unambiguously the INVERSE direction firing.
    await target.query(
      `INSERT INTO migration_manifest (source_db, source_table, project_id_or_null, row_count, content_fingerprint, excluded_reason)
       VALUES ($1,'decisions','proj-a',1,'fp-decisions',NULL), ($1,'tasks','proj-a',1,'fp-tasks',NULL)`,
      [SOURCE_DB]
    );

    // (i) A non-excluded manifest pair with NO roster entry -> T0 FAILs,
    // listing it by name.
    await target.query(
      `INSERT INTO migration_manifest (source_db, source_table, project_id_or_null, row_count, content_fingerprint, excluded_reason)
       VALUES ($1,'gotchas','proj-a',3,'fp-gotchas',NULL)`,
      [SOURCE_DB]
    );
    const r1 = runScript('verify-15-t0-roster.js', ['--db', TARGET_DB], rosterEnv(rosterPath));
    const out1 = r1.stdout + r1.stderr;
    if (r1.status !== 0 && /FAIL \(inverse\)/.test(out1) && new RegExp(`${SOURCE_DB} / gotchas`).test(out1) && /unregistered source/.test(out1)) {
      pass('T0-inverse-i', 'non-excluded manifest pair with no roster entry -> T0 FAILs, listing it');
    } else {
      fail('T0-inverse-i', 'non-excluded manifest pair with no roster entry -> T0 FAILs, listing it', `status=${r1.status} stdout=${r1.stdout} stderr=${r1.stderr}`);
    }

    // (ii) Same shape, but EXCLUDED -> T0 still PASSes (no false positive).
    // Replace the non-excluded 'gotchas' leak with an excluded one under a
    // DIFFERENT never-rostered source_db (an EPHEMERAL-DROP-shaped case).
    await truncateAll(target, ['migration_manifest']);
    await target.query(
      `INSERT INTO migration_manifest (source_db, source_table, project_id_or_null, row_count, content_fingerprint, excluded_reason)
       VALUES ($1,'decisions','proj-a',1,'fp-decisions',NULL), ($1,'tasks','proj-a',1,'fp-tasks',NULL)`,
      [SOURCE_DB]
    );
    await target.query(
      `INSERT INTO migration_manifest (source_db, source_table, project_id_or_null, row_count, content_fingerprint, excluded_reason)
       VALUES ('ephemeral_never_rostered_db','whatever_table','proj-a',5,'fp-ephemeral','ephemeral-db-triage-drop')`
    );
    const r2 = runScript('verify-15-t0-roster.js', ['--db', TARGET_DB], rosterEnv(rosterPath));
    if (r2.status === 0 && /OK \(inverse\)/.test(r2.stdout)) {
      pass('T0-inverse-ii', 'excluded manifest pair with no roster entry -> T0 still PASSes (no false positive)');
    } else {
      fail('T0-inverse-ii', 'excluded manifest pair with no roster entry -> T0 still PASSes (no false positive)', `status=${r2.status} stdout=${r2.stdout} stderr=${r2.stderr}`);
    }
  } finally {
    await target.end();
  }
}

async function testT0LiveTableClassification() {
  // Final-review finding (PR #152): a table physically present in the
  // target but absent from BOTH the roster and inventory-manifest.json is
  // invisible to every check that existed before this section. Uses a
  // DEDICATED scratch DB (LIVE_TABLE_DB) so this test's schema state never
  // interferes with other test groups' fixture tables (or vice versa).
  const target = await pgConnect(LIVE_TABLE_DB);
  try {
    // A trivial single-entry roster: sourceless, so the forward direction
    // auto-passes (zero SOURCED entries) and the inverse direction
    // auto-passes (fresh DB, empty migration_manifest) -- isolating every
    // assertion below to the live-table classification section alone.
    const trivialRoster = writeTmpJson('t0-livetable-roster.json', [
      { source_db: 'net-new:test_store', source_table: 'placeholder', targetTable: 'placeholder_table',
        loadBearingCols: ['x'], hasContentBearingText: false, requires_project_id_scope: false },
    ]);

    // (i) An unclassified table planted in the scratch target -> T0 FAILs, naming it.
    await target.query('CREATE TABLE IF NOT EXISTS mystery_orphan_table (id SERIAL PRIMARY KEY)');
    const r1 = runScript('verify-15-t0-roster.js', ['--db', LIVE_TABLE_DB], rosterEnv(trivialRoster));
    const out1 = r1.stdout + r1.stderr;
    if (r1.status !== 0 && /FAIL \(live-table\)/.test(out1) && /mystery_orphan_table/.test(out1)) {
      pass('T0-livetable-i', 'unclassified table planted in scratch target -> T0 FAILs, naming it');
    } else {
      fail('T0-livetable-i', 'unclassified table planted in scratch target -> T0 FAILs, naming it', `status=${r1.status} stdout=${r1.stdout} stderr=${r1.stderr}`);
    }
    await target.query('DROP TABLE mystery_orphan_table');

    // (ii) Engine-core + battery-infra tables in a fresh target classify
    // cleanly -- no false positive. Applies the REAL migrate-01 schema
    // (the SAME four SQL files shared.getEngineCoreObjects() parses at
    // runtime) plus this battery's own DDL (applied automatically inside
    // T0's own main()).
    await applyRealEngineSchema(target);
    const r2 = runScript('verify-15-t0-roster.js', ['--db', LIVE_TABLE_DB], rosterEnv(trivialRoster));
    const out2 = r2.stdout + r2.stderr;
    if (r2.status === 0 && /engine-core=1[0-9]/.test(out2) && /battery-infra=[1-9]/.test(out2) && /unclassified=0/.test(out2)) {
      pass('T0-livetable-ii', 'real engine-core schema + battery-infra tables classify cleanly in a fresh target (no false positive)');
    } else {
      fail('T0-livetable-ii', 'real engine-core schema + battery-infra tables classify cleanly in a fresh target (no false positive)', `status=${r2.status} stdout=${r2.stdout} stderr=${r2.stderr}`);
    }

    // (iii) A roster-known targetTable present -> class (c), PASS.
    await target.query('CREATE TABLE IF NOT EXISTS decisions_livetable_marker (id SERIAL PRIMARY KEY)');
    const rosterWithMarker = writeTmpJson('t0-livetable-roster-marker.json', [
      { source_db: 'net-new:test_store', source_table: 'placeholder', targetTable: 'placeholder_table',
        loadBearingCols: ['x'], hasContentBearingText: false, requires_project_id_scope: false },
      { source_db: 'net-new:test_store2', source_table: 'marker_source', targetTable: 'decisions_livetable_marker',
        loadBearingCols: ['x'], hasContentBearingText: false, requires_project_id_scope: false },
    ]);
    const r3 = runScript('verify-15-t0-roster.js', ['--db', LIVE_TABLE_DB], rosterEnv(rosterWithMarker));
    const out3 = r3.stdout + r3.stderr;
    if (r3.status === 0 && /unclassified=0/.test(out3) && /roster\/inventory=[1-9]/.test(out3)) {
      pass('T0-livetable-iii', 'roster-known targetTable present -> classified via roster/inventory (class c), overall PASS');
    } else {
      fail('T0-livetable-iii', 'roster-known targetTable present -> classified via roster/inventory (class c), overall PASS', `status=${r3.status} stdout=${r3.stdout} stderr=${r3.stderr}`);
    }

    // (iv) A materialized view planted -> T0 FAILs, naming it. Closes the
    // review finding that information_schema.tables structurally excludes
    // matviews -- the enumeration was switched to a pg_class relkind query
    // specifically so this case is no longer a silent escape.
    await target.query('CREATE MATERIALIZED VIEW mystery_matview AS SELECT 1 AS id');
    const r4 = runScript('verify-15-t0-roster.js', ['--db', LIVE_TABLE_DB], rosterEnv(trivialRoster));
    const out4 = r4.stdout + r4.stderr;
    if (r4.status !== 0 && /FAIL \(live-table\)/.test(out4) && /mystery_matview/.test(out4) && /materialized view/.test(out4)) {
      pass('T0-livetable-iv', 'materialized view planted in scratch target -> T0 FAILs, naming it (relkind label included)');
    } else {
      fail('T0-livetable-iv', 'materialized view planted in scratch target -> T0 FAILs, naming it (relkind label included)', `status=${r4.status} stdout=${r4.stdout} stderr=${r4.stderr}`);
    }
    await target.query('DROP MATERIALIZED VIEW mystery_matview');
  } finally {
    await target.end();
  }
}

async function testMalformedNetNewFatal() {
  // (iii) Malformed net-new: (empty suffix) -> loader fatal.
  const malformedRoster = writeTmpJson('t0-malformed-netnew.json', [
    { ...SOURCELESS_ROSTER_ENTRY, source_db: 'net-new:' },
  ]);
  const r = runScript('verify-15-t0-roster.js', ['--db', TARGET_DB], rosterEnv(malformedRoster));
  if (r.status !== 0 && /malformed net-new source_db/.test(r.stdout + r.stderr)) {
    pass('malformed-netnew', 'empty net-new: suffix -> loader FATAL, loud, non-zero exit');
  } else {
    fail('malformed-netnew', 'empty net-new: suffix -> loader FATAL, loud, non-zero exit', `status=${r.status} stdout=${r.stdout} stderr=${r.stderr}`);
  }
}

async function testDisjointnessValidation() {
  // Final-review finding (PR #152): a targetTable claimed by BOTH a sourced
  // and a sourceless entry is a structurally impossible roster state --
  // loadRoster() must refuse it at load time, loud, before any check runs.
  const overlapRoster = writeTmpJson('t0-disjointness-overlap.json', [
    { ...SOURCELESS_ROSTER_ENTRY, targetTable: 'decisions' }, // sourceless claim on 'decisions'
    BASE_ROSTER[0], // sourced claim on the SAME 'decisions' targetTable
  ]);
  const r = runScript('verify-15-t0-roster.js', ['--db', TARGET_DB], rosterEnv(overlapRoster));
  const out = r.stdout + r.stderr;
  if (r.status !== 0 && /claimed by BOTH a sourced AND a sourceless entry/.test(out) && /targetTable="decisions"/.test(out)) {
    pass('disjointness', 'sourced/sourceless targetTable overlap -> loader FATAL, naming the table and both claiming entries');
  } else {
    fail('disjointness', 'sourced/sourceless targetTable overlap -> loader FATAL, naming the table and both claiming entries', `status=${r.status} stdout=${r.stdout} stderr=${r.stderr}`);
  }
}

async function testT3SourcelessSkip() {
  // (iv) T3 skips a sourceless entry with the explicit line, and still
  // hash-checks sourced tables in the same run.
  const source = await pgConnect(SOURCE_DB);
  const target = await pgConnect(TARGET_DB);
  try {
    await setupSourceSchema(source);
    await truncateAll(source, ['decisions']);
    await truncateAll(target, ['decisions', 'routing_profiles']);

    await source.query(`INSERT INTO decisions (project_id, topic, decision, reason) VALUES ('proj-a','t','d','r')`);
    await target.query(`INSERT INTO decisions (project_id, topic, decision, reason) VALUES ('proj-a','t','d','r')`);

    const rosterPath = writeTmpJson('t3-sourceless.json', [BASE_ROSTER[0], SOURCELESS_ROSTER_ENTRY]);
    const r = runScript('verify-15-t3-content-hash.js', ['--db', TARGET_DB], rosterEnv(rosterPath));
    const out = r.stdout + r.stderr;
    if (r.status === 0 && /\[SKIP\]/.test(out) && /net-new:memory_manager -> routing_profiles/.test(out) && /\[T3\] OK: decisions -> decisions/.test(out)) {
      pass('T3-sourceless', 'T3 SKIPs the sourceless entry with an explicit line, and still hash-checks the sourced table in the same run');
    } else {
      fail('T3-sourceless', 'T3 SKIPs the sourceless entry with an explicit line, and still hash-checks the sourced table in the same run', `status=${r.status} stdout=${r.stdout} stderr=${r.stderr}`);
    }
  } finally {
    await source.end();
    await target.end();
  }
}

async function testT3bSourceless() {
  // Bonus coverage for the T3b code change made as part of this same fix
  // (the finding named T3b's "project_id-based anti-join" explicitly):
  // a sourceless targetTable's rows must NEVER be flagged as "unaccounted"
  // by totalRowcountReconciliation, nor as a "reverse containment gap" by
  // reverseContainment — both would otherwise be permanently, spuriously
  // broken by real net-new-table data (routing_profiles, turn_usage, …).
  const target = await pgConnect(TARGET_DB);
  try {
    await shared.applyDdl(target);
    await truncateAll(target, ['migration_manifest', 'migration_manifest_row_hashes', 'memory_manager_staging_row_hashes', 'decisions', 'routing_profiles']);

    // A real routing_profiles row with NO migration_manifest coverage at
    // all for its project_id (exactly what live routing writes would look
    // like) -- must NOT be flagged by totalRowcountReconciliation.
    await target.query(`INSERT INTO routing_profiles (project_id, role, preferred_model) VALUES ('proj-live-routing','draft','some-model')`);
    // A staging_row_hashes entry for routing_profiles with no matching
    // migration_manifest_row_hashes source hash -- must NOT be flagged by
    // reverseContainment either.
    await target.query(`INSERT INTO memory_manager_staging_row_hashes (target_table, project_id, target_row_id, target_hash) VALUES ('routing_profiles','proj-live-routing','1','live-routing-hash-1')`);

    const rosterPath = writeTmpJson('t3b-sourceless.json', [BASE_ROSTER[0], SOURCELESS_ROSTER_ENTRY]);
    const r = runScript('verify-15-t3b-reverse-containment.js', ['--db', TARGET_DB], rosterEnv(rosterPath));
    const out = r.stdout + r.stderr;
    // status===0 proves NEITHER check flagged the routing_profiles rows
    // (either would have set failed=true -> non-zero exit otherwise); the
    // explicit exclusion log line proves it wasn't a coincidental pass from
    // an empty/no-op scan.
    if (r.status === 0 && /SOURCELESS.*targetTable\(s\) excluded/.test(out) && /routing_profiles/.test(out)) {
      pass('T3b-sourceless', 'sourceless targetTable rows are excluded from BOTH T3b checks (never flagged as unaccounted or as a reverse-containment gap)');
    } else {
      fail('T3b-sourceless', 'sourceless targetTable rows are excluded from BOTH T3b checks (never flagged as unaccounted or as a reverse-containment gap)', `status=${r.status} stdout=${r.stdout} stderr=${r.stderr}`);
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

async function testT2NoColumnReconciliation() {
  // BF-R1/BF-5 (cm#187 spec-adversary pass, 2026-08-18): T2 against a
  // targetTable with NO project_id column at all -- the original crash
  // shape (retrieval_event_assertions, live: manifest id=2548,
  // project_id='90394596-...', row_count=2930).
  const target = await pgConnect(TARGET_DB);
  try {
    await shared.applyDdl(target);
    await truncateAll(target, ['migration_manifest', 'retrieval_event_assertions']);
    const rosterPath = writeTmpJson('t2-nocolumn-roster.json', [NO_COLUMN_ROSTER_ENTRY]);

    // NULL-scoped no-column row matching COUNT(*) -> PASS (no crash).
    await target.query(`INSERT INTO retrieval_event_assertions (event_id, assertion_id) VALUES (1,10), (2,20)`);
    await target.query(
      `INSERT INTO migration_manifest (source_db, source_table, project_id_or_null, row_count, content_fingerprint)
       VALUES ($1,'retrieval_event_assertions',NULL,2,'fp')`,
      [SOURCE_DB]
    );
    const r1 = runScript('verify-15-t2-rowcount.js', ['--db', TARGET_DB], rosterEnv(rosterPath));
    if (r1.status === 0) pass('T2-nocolumn-a', 'NULL-scoped no-column row matching bare COUNT(*) -> PASS, no crash');
    else fail('T2-nocolumn-a', 'NULL-scoped no-column row matching bare COUNT(*) -> PASS, no crash', `status=${r1.status} stdout=${r1.stdout} stderr=${r1.stderr}`);

    // Mismatch -> FAIL.
    await target.query(`INSERT INTO retrieval_event_assertions (event_id, assertion_id) VALUES (3,30)`);
    const r2 = runScript('verify-15-t2-rowcount.js', ['--db', TARGET_DB], rosterEnv(rosterPath));
    if (r2.status !== 0) pass('T2-nocolumn-b', 'no-column row-count mismatch -> FAIL');
    else fail('T2-nocolumn-b', 'no-column row-count mismatch -> FAIL', `status=${r2.status} stdout=${r2.stdout} stderr=${r2.stderr}`);

    // MIXED NULL + project-scoped manifest rows whose SUM matches -> PASS
    // (proves the reconciliation sums ALL manifest rows for the pair, not
    // a single slice).
    await truncateAll(target, ['migration_manifest', 'retrieval_event_assertions']);
    await target.query(`INSERT INTO retrieval_event_assertions (event_id, assertion_id) VALUES (1,10), (2,20), (3,30)`);
    await target.query(
      `INSERT INTO migration_manifest (source_db, source_table, project_id_or_null, row_count, content_fingerprint)
       VALUES ($1,'retrieval_event_assertions',NULL,1,'fp1'), ($1,'retrieval_event_assertions','proj-x',2,'fp2')`,
      [SOURCE_DB]
    );
    const r3 = runScript('verify-15-t2-rowcount.js', ['--db', TARGET_DB], rosterEnv(rosterPath));
    if (r3.status === 0) pass('T2-nocolumn-c', 'MIXED NULL + project-scoped manifest rows whose SUM matches -> PASS (proves sum-not-single-slice)');
    else fail('T2-nocolumn-c', 'MIXED NULL + project-scoped manifest rows whose SUM matches -> PASS (proves sum-not-single-slice)', `status=${r3.status} stdout=${r3.stdout} stderr=${r3.stderr}`);

    // excluded_reason on a no-column table -> loud FATAL (never silently
    // ignored/mis-reconciled -- a bare COUNT(*) cannot subtract an
    // excluded project's rows).
    await truncateAll(target, ['migration_manifest']);
    await target.query(
      `INSERT INTO migration_manifest (source_db, source_table, project_id_or_null, row_count, content_fingerprint, excluded_reason)
       VALUES ($1,'retrieval_event_assertions','proj-y',5,'fp3','eval-junk')`,
      [SOURCE_DB]
    );
    const r4 = runScript('verify-15-t2-rowcount.js', ['--db', TARGET_DB], rosterEnv(rosterPath));
    if (r4.status !== 0 && /FATAL/.test(r4.stdout + r4.stderr) && /cannot subtract/.test(r4.stdout + r4.stderr)) {
      pass('T2-nocolumn-d', 'excluded_reason on a no-column table -> loud FATAL (bare COUNT(*) cannot subtract excluded rows)');
    } else {
      fail('T2-nocolumn-d', 'excluded_reason on a no-column table -> loud FATAL (bare COUNT(*) cannot subtract excluded rows)', `status=${r4.status} stdout=${r4.stdout} stderr=${r4.stderr}`);
    }

    // roster-flag/live-schema divergence -> loud FATAL, BEFORE any
    // reconciliation (BF-5).
    await truncateAll(target, ['migration_manifest']);
    const divergentRoster = writeTmpJson('t2-divergent-roster.json', [
      { ...NO_COLUMN_ROSTER_ENTRY, requires_project_id_scope: true }, // WRONG: live schema has no project_id column
    ]);
    await target.query(
      `INSERT INTO migration_manifest (source_db, source_table, project_id_or_null, row_count, content_fingerprint)
       VALUES ($1,'retrieval_event_assertions',NULL,0,'fp')`,
      [SOURCE_DB]
    );
    const r5 = runScript('verify-15-t2-rowcount.js', ['--db', TARGET_DB], rosterEnv(divergentRoster));
    if (r5.status !== 0 && /disagrees with live schema/.test(r5.stdout + r5.stderr)) {
      pass('T2-nocolumn-e', 'roster-flag/live-schema divergence -> loud FATAL before any reconciliation (BF-5)');
    } else {
      fail('T2-nocolumn-e', 'roster-flag/live-schema divergence -> loud FATAL before any reconciliation (BF-5)', `status=${r5.status} stdout=${r5.stdout} stderr=${r5.stderr}`);
    }
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

async function testT3NoColumnFixture() {
  // BF-R3 (cm#187 spec-adversary pass, 2026-08-18): T3 against a SOURCED
  // roster entry whose table has NEITHER an id NOR a project_id column
  // (retrieval_event_assertions-shaped) -- end to end, no crash.
  const source = await pgConnect(SOURCE_DB);
  const target = await pgConnect(TARGET_DB);
  try {
    await truncateAll(source, ['retrieval_event_assertions']);
    await truncateAll(target, ['retrieval_event_assertions']);
    await source.query(`INSERT INTO retrieval_event_assertions (event_id, assertion_id) VALUES (1,10), (2,20)`);
    await target.query(`INSERT INTO retrieval_event_assertions (event_id, assertion_id) VALUES (1,10), (2,20)`);

    const rosterPath = writeTmpJson('t3-nocolumn-roster.json', [NO_COLUMN_ROSTER_ENTRY]);
    const r1 = runScript('verify-15-t3-content-hash.js', ['--db', TARGET_DB], rosterEnv(rosterPath));
    if (r1.status === 0) pass('T3-nocolumn-a', 'no-id/no-project_id sourced table, matching content -> PASS, no crash');
    else fail('T3-nocolumn-a', 'no-id/no-project_id sourced table, matching content -> PASS, no crash', `status=${r1.status} stdout=${r1.stdout} stderr=${r1.stderr}`);

    // Mismatch -> FAIL, no crash.
    await truncateAll(target, ['retrieval_event_assertions']);
    await target.query(`INSERT INTO retrieval_event_assertions (event_id, assertion_id) VALUES (1,10)`); // missing (2,20)
    const r2 = runScript('verify-15-t3-content-hash.js', ['--db', TARGET_DB], rosterEnv(rosterPath));
    if (r2.status !== 0 && /multiset mismatch/.test(r2.stdout + r2.stderr)) {
      pass('T3-nocolumn-b', 'no-id/no-project_id sourced table, mismatched content -> FAIL, no crash');
    } else {
      fail('T3-nocolumn-b', 'no-id/no-project_id sourced table, mismatched content -> FAIL, no crash', `status=${r2.status} stdout=${r2.stdout} stderr=${r2.stderr}`);
    }
  } finally {
    await source.end();
    await target.end();
  }
}

async function testT3ExclusionAwareness() {
  // Regression coverage for the PR #152 review finding: T3 must consult
  // migration_manifest.excluded_reason and scope its source-side multiset
  // to NON-excluded slices only — otherwise it spuriously FAILs whenever a
  // source table has both an excluded slice and a legitimately-migrating
  // slice (exactly T9's exclusion scenario).
  const source = await pgConnect(SOURCE_DB);
  const target = await pgConnect(TARGET_DB);
  try {
    await shared.applyDdl(target);
    await setupSourceSchema(source);
    await truncateAll(source, ['decisions']);
    await truncateAll(target, ['migration_manifest', 'decisions']);

    // Migrating slice: proj-migrate, 2 rows, migrated verbatim.
    await source.query(`INSERT INTO decisions (project_id, topic, decision, reason) VALUES ('proj-migrate','t1','d1','r1'), ('proj-migrate','t2','d2','r2')`);
    await target.query(`INSERT INTO decisions (project_id, topic, decision, reason) VALUES ('proj-migrate','t1','d1','r1'), ('proj-migrate','t2','d2','r2')`);
    // Excluded slice: proj-excluded, 2 rows, correctly absent from target.
    await source.query(`INSERT INTO decisions (project_id, topic, decision, reason) VALUES ('proj-excluded','ex1','exd1','exr1'), ('proj-excluded','ex2','exd2','exr2')`);

    await target.query(
      `INSERT INTO migration_manifest (source_db, source_table, project_id_or_null, row_count, content_fingerprint, excluded_reason)
       VALUES ($1,'decisions','proj-migrate',2,'fp-migrate',NULL), ($1,'decisions','proj-excluded',2,'fp-excluded','eval-junk-project-id')`,
      [SOURCE_DB]
    );

    const rosterPath = writeTmpJson('t3-excl-roster.json', [BASE_ROSTER[0]]);

    // REGRESSION PROOF: the pre-fix behavior (hash the WHOLE source table,
    // unscoped by exclusion) would find the excluded slice's hashes with
    // zero match in target -- demonstrate that directly against the SAME
    // fixture using the still-exported, still-unscoped hashTableMultiset.
    const unscopedSrc = await shared.hashTableMultiset(source, 'decisions', BASE_ROSTER[0].loadBearingCols);
    const unscopedTgt = await shared.hashTableMultiset(target, 'decisions', BASE_ROSTER[0].loadBearingCols);
    let wouldHaveFailed = false;
    for (const [hash, { count: srcCount }] of unscopedSrc) {
      const tgtCount = (unscopedTgt.get(hash) || { count: 0 }).count;
      if (tgtCount < srcCount) wouldHaveFailed = true;
    }
    if (wouldHaveFailed) {
      pass('T3-excl-regression', 'unscoped whole-table hashing on this fixture DOES find a mismatch (proves the pre-fix bug shape is real on this fixture)');
    } else {
      fail('T3-excl-regression', 'unscoped whole-table hashing on this fixture DOES find a mismatch (proves the pre-fix bug shape is real on this fixture)', 'unscoped hashing unexpectedly found no mismatch -- fixture does not exercise the bug');
    }

    // THE FIX: the actual (current, exclusion-aware) script must PASS on
    // this exact fixture, and must log the per-slice exclusion line.
    const r1 = runScript('verify-15-t3-content-hash.js', ['--db', TARGET_DB], rosterEnv(rosterPath));
    if (r1.status === 0 && /excluding 2 row\(s\) for project_id=proj-excluded/.test(r1.stdout + r1.stderr)) {
      pass('T3-excl-a', 'mixed table (excluded slice + migrating slice, target holds only migrating rows) -> PASS with explicit exclusion log line');
    } else {
      fail('T3-excl-a', 'mixed table (excluded slice + migrating slice, target holds only migrating rows) -> PASS with explicit exclusion log line', `status=${r1.status} stdout=${r1.stdout} stderr=${r1.stderr}`);
    }

    // Forward containment must NOT be weakened: remove one migrating-slice
    // row from target -> T3 still FAILs.
    await target.query(`DELETE FROM decisions WHERE topic = 't2' AND project_id = 'proj-migrate'`);
    const r2 = runScript('verify-15-t3-content-hash.js', ['--db', TARGET_DB], rosterEnv(rosterPath));
    if (r2.status !== 0 && /multiset mismatch/.test(r2.stdout + r2.stderr)) {
      pass('T3-excl-b', 'migrating-slice row missing from target -> T3 still FAILs (fix does not weaken forward containment)');
    } else {
      fail('T3-excl-b', 'migrating-slice row missing from target -> T3 still FAILs (fix does not weaken forward containment)', `status=${r2.status} stdout=${r2.stdout} stderr=${r2.stderr}`);
    }
    // Restore for the next sub-test.
    await target.query(`INSERT INTO decisions (project_id, topic, decision, reason) VALUES ('proj-migrate','t2','d2','r2')`);

    // NULL-scoped whole-DB exclusion -> table explicitly skipped by T3.
    await truncateAll(target, ['migration_manifest']);
    await target.query(
      `INSERT INTO migration_manifest (source_db, source_table, project_id_or_null, row_count, content_fingerprint, excluded_reason)
       VALUES ($1,'decisions',NULL,4,'fp-nullscoped','ephemeral-db-triage-drop')`,
      [SOURCE_DB]
    );
    const r3 = runScript('verify-15-t3-content-hash.js', ['--db', TARGET_DB], rosterEnv(rosterPath));
    if (r3.status === 0 && /SKIP: .*whole-DB exclusion/.test(r3.stdout + r3.stderr)) {
      pass('T3-excl-c', 'NULL-scoped whole-DB exclusion -> table explicitly SKIPped by T3 (never silent), exit 0');
    } else {
      fail('T3-excl-c', 'NULL-scoped whole-DB exclusion -> table explicitly SKIPped by T3 (never silent), exit 0', `status=${r3.status} stdout=${r3.stdout} stderr=${r3.stderr}`);
    }

    // The existing T9 NULL-scoped provenance fixture is UNCHANGED by this
    // T3 fix -- re-confirm it still catches a leaked row under the SAME
    // NULL-scoped exclusion recorded above (T9 never consults T3's scope
    // decisions; it reads migration_manifest provenance directly).
    const t9mod = require(scriptPath('verify-15-t9-negative.js'));
    const roster = JSON.parse(fs.readFileSync(rosterPath, 'utf8'));
    const provenanceIntact = await t9mod.checkExclusion(target, roster, {
      excluded_reason: 'ephemeral-db-triage-drop', source_table: 'decisions', project_id_or_null: null,
    });
    await truncateAll(target, ['migration_manifest']); // simulate the leak: no confirming manifest row
    const provenanceBroken = await t9mod.checkExclusion(target, roster, {
      excluded_reason: 'ephemeral-db-triage-drop', source_table: 'decisions', project_id_or_null: null,
    });
    if (provenanceIntact.ok === true && provenanceBroken.ok === false) {
      pass('T3-excl-t9-unaffected', 'T9 NULL-scoped provenance check still catches a leaked row after the T3 exclusion-awareness fix (no interaction/regression)');
    } else {
      fail('T3-excl-t9-unaffected', 'T9 NULL-scoped provenance check still catches a leaked row after the T3 exclusion-awareness fix (no interaction/regression)', `provenanceIntact=${JSON.stringify(provenanceIntact)} provenanceBroken=${JSON.stringify(provenanceBroken)}`);
    }
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

async function testT3bNoColumnReconciliation() {
  // BF-R4 (cm#187 spec-adversary pass, 2026-08-18): a SOURCED targetTable
  // with no project_id column must be EXCLUDED from the project_id
  // anti-join (it has no project_id to anti-join on) but stays VISIBLE via
  // a separate summed-manifest-vs-bare-COUNT(*) reconciliation, never
  // silently dropped from T3b's scope entirely.
  const target = await pgConnect(TARGET_DB);
  try {
    await shared.applyDdl(target);
    await truncateAll(target, ['migration_manifest', 'migration_manifest_row_hashes', 'memory_manager_staging_row_hashes', 'retrieval_event_assertions', 'decisions', 'tasks']);

    await target.query(`INSERT INTO retrieval_event_assertions (event_id, assertion_id) VALUES (1,10), (2,20)`);
    await target.query(
      `INSERT INTO migration_manifest (source_db, source_table, project_id_or_null, row_count, content_fingerprint)
       VALUES ($1,'retrieval_event_assertions',NULL,2,'fp')`,
      [SOURCE_DB]
    );
    const rosterPath = writeTmpJson('t3b-nocolumn-roster.json', [NO_COLUMN_ROSTER_ENTRY]);

    const r1 = runScript('verify-15-t3b-reverse-containment.js', ['--db', TARGET_DB], rosterEnv(rosterPath));
    if (r1.status === 0 && /excluded from the project_id anti-join/.test(r1.stdout + r1.stderr)) {
      pass('T3b-nocolumn-a', 'no-project_id targetTable excluded from the anti-join but reconciled separately -> PASS, matching count');
    } else {
      fail('T3b-nocolumn-a', 'no-project_id targetTable excluded from the anti-join but reconciled separately -> PASS, matching count', `status=${r1.status} stdout=${r1.stdout} stderr=${r1.stderr}`);
    }

    // Mismatch -> FAIL (still visible, never silently skipped).
    await target.query(`INSERT INTO retrieval_event_assertions (event_id, assertion_id) VALUES (3,30)`);
    const r2 = runScript('verify-15-t3b-reverse-containment.js', ['--db', TARGET_DB], rosterEnv(rosterPath));
    if (r2.status !== 0 && /retrieval_event_assertions/.test(r2.stdout + r2.stderr)) {
      pass('T3b-nocolumn-b', 'no-project_id targetTable row-count mismatch -> FAIL, named explicitly');
    } else {
      fail('T3b-nocolumn-b', 'no-project_id targetTable row-count mismatch -> FAIL, named explicitly', `status=${r2.status} stdout=${r2.stdout} stderr=${r2.stderr}`);
    }
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

    // Roster-scoped fixture table EXISTS but is missing the project_id
    // column entirely -> FAIL. This is the SUBTLER case A-6 closed (a
    // table that HAS the column but is nullable is a different, simpler
    // bar this same check also enforces) -- the table is created LOCALLY,
    // scoped to this test, and dropped in a nested finally, so it never
    // leaks into T0's live-table classification tests (which run earlier
    // and share TARGET_DB) the way an earlier shared-setup version of this
    // fixture used to.
    const rosterMissingCol = [
      { source_db: SOURCE_DB, source_table: 'no_project_id_table', targetTable: 'no_project_id_table',
        loadBearingCols: ['label'], hasContentBearingText: false, requires_project_id_scope: true },
    ];
    const rosterPath1 = writeTmpJson('t6-roster-missing-col.json', rosterMissingCol);
    await target.query('CREATE TABLE no_project_id_table (id SERIAL PRIMARY KEY, label TEXT)');
    try {
      const r1 = runScript('verify-15-t6-referential-integrity.js', ['--db', TARGET_DB], rosterEnv(rosterPath1));
      if (r1.status !== 0 && /project_id column MISSING entirely/.test(r1.stdout + r1.stderr)) {
        pass('T6-a', 'roster-scoped table EXISTS but is missing the project_id column entirely -> FAIL');
      } else {
        fail('T6-a', 'roster-scoped table EXISTS but is missing the project_id column entirely -> FAIL', `status=${r1.status} stdout=${r1.stdout} stderr=${r1.stderr}`);
      }
    } finally {
      await target.query('DROP TABLE IF EXISTS no_project_id_table');
    }

    // Orphan edge -> FAIL.
    const rosterPath2 = writeTmpJson('t6-roster-clean.json', BASE_ROSTER);
    await target.query(`INSERT INTO edges (from_entity, to_entity, project_id) VALUES ('nonexistent-entity-a', 'nonexistent-entity-b', 'proj-a')`);
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

async function testT6JoinKeyFix() {
  // BF-R5 (cm#188 spec-adversary pass, 2026-08-18): edges.from_entity/
  // to_entity resolve to entities via (project_id, name), never
  // entities.id. These fixtures prove the fixed join is FALSIFIABLE in
  // both directions the pre-fix bug could never even reach (a type
  // mismatch crashed before any of these cases could be evaluated).
  const target = await pgConnect(TARGET_DB);
  try {
    await truncateAll(target, ['edges', 'entities', 'memory_entries', 'memory_entry_chunks']);
    const rosterPath = writeTmpJson('t6-joinkey-roster.json', BASE_ROSTER);

    // (i) Correct same-project match -> PASS, proving the join resolves a
    // real entity by (project_id, name), not entities.id (there is no
    // integer id anywhere in this fixture's edge/entity values).
    await target.query(`INSERT INTO entities (project_id, name) VALUES ('proj-a', 'Widget')`);
    await target.query(`INSERT INTO edges (project_id, from_entity, to_entity) VALUES ('proj-a', 'Widget', 'Widget')`);
    const r1 = runScript('verify-15-t6-referential-integrity.js', ['--db', TARGET_DB], rosterEnv(rosterPath));
    if (r1.status === 0) pass('T6-joinkey-a', 'edge resolves to entity via (project_id, name) -> PASS');
    else fail('T6-joinkey-a', 'edge resolves to entity via (project_id, name) -> PASS', `status=${r1.status} stdout=${r1.stdout} stderr=${r1.stderr}`);

    // (ii) A same-name entity in a DIFFERENT project coexists with the
    // CORRECT same-project entity -> overall PASS, proving the
    // different-project entity is correctly IGNORED (never wrongly
    // borrowed to resolve a same-name edge in another project) rather than
    // this being a coincidental pass.
    await truncateAll(target, ['edges', 'entities']);
    await target.query(`INSERT INTO entities (project_id, name) VALUES ('proj-other', 'Widget')`);
    await target.query(`INSERT INTO entities (project_id, name) VALUES ('proj-a', 'Widget')`);
    await target.query(`INSERT INTO edges (project_id, from_entity, to_entity) VALUES ('proj-a', 'Widget', 'Widget')`);
    const r2 = runScript('verify-15-t6-referential-integrity.js', ['--db', TARGET_DB], rosterEnv(rosterPath));
    if (r2.status === 0) pass('T6-joinkey-b', 'same-name entity in a DIFFERENT project coexists with the correct same-project entity -> PASS');
    else fail('T6-joinkey-b', 'same-name entity in a DIFFERENT project coexists with the correct same-project entity -> PASS', `status=${r2.status} stdout=${r2.stdout} stderr=${r2.stderr}`);

    // (iii) Falsifiability proof for (ii): remove the SAME-project entity,
    // leaving ONLY the different-project same-name entity -> the edge must
    // now be an orphan (FAIL). This proves (ii) passed because the join is
    // correctly project-scoped, not because of some other coincidence.
    await target.query(`DELETE FROM entities WHERE project_id = 'proj-a' AND name = 'Widget'`);
    const r3 = runScript('verify-15-t6-referential-integrity.js', ['--db', TARGET_DB], rosterEnv(rosterPath));
    if (r3.status !== 0 && /orphan edge/.test(r3.stdout + r3.stderr)) {
      pass('T6-joinkey-c', 'ONLY a different-project same-name entity remains -> edge is an orphan -> FAIL (proves the cross-project non-match in (ii) is real)');
    } else {
      fail('T6-joinkey-c', 'ONLY a different-project same-name entity remains -> edge is an orphan -> FAIL (proves the cross-project non-match in (ii) is real)', `status=${r3.status} stdout=${r3.stdout} stderr=${r3.stderr}`);
    }

    // (iv) Case-variant pair ("Foo" entity, "foo" edge reference) -> FAIL,
    // proving the exact-text-match pin (no case-folding) is enforced.
    await truncateAll(target, ['edges', 'entities']);
    await target.query(`INSERT INTO entities (project_id, name) VALUES ('proj-a', 'Foo')`);
    await target.query(`INSERT INTO edges (project_id, from_entity, to_entity) VALUES ('proj-a', 'foo', 'Foo')`);
    const r4 = runScript('verify-15-t6-referential-integrity.js', ['--db', TARGET_DB], rosterEnv(rosterPath));
    if (r4.status !== 0 && /orphan edge/.test(r4.stdout + r4.stderr)) {
      pass('T6-joinkey-d', 'case-variant pair ("Foo" entity, "foo" edge ref) -> FAIL (exact-match pin enforced, no case-folding)');
    } else {
      fail('T6-joinkey-d', 'case-variant pair ("Foo" entity, "foo" edge ref) -> FAIL (exact-match pin enforced, no case-folding)', `status=${r4.status} stdout=${r4.stdout} stderr=${r4.stderr}`);
    }

    await truncateAll(target, ['edges', 'entities']);
  } finally {
    await target.end();
  }
}

// T6-SUPPRESSION pass (2026-08-18, cm spec-adversary A-1/A-2/A-4/A-6,
// BINDING): the orphan-edge check scopes to LIVE (non-suppressed) edges
// only -- a suppressed edge is a tombstone whose referents may legitimately
// no longer exist. These fixtures prove each binding finding is
// FALSIFIABLE, not merely plausible:
//   (i)   a suppressed orphan edge, alone -> PASS (tombstone excluded).
//   (ii)  a LIVE orphan edge -> FAIL -- already covered by testT6ReferentialIntegrity's
//         T6-b (kept, not duplicated here).
//   (iii) A-6: one suppressed orphan edge + one live orphan edge -> FAIL
//         with the count EXACTLY 1 (regex on the numeral, not just
//         nonzero) -- the test that catches a scope bug where a suppressed
//         row leaks into the count.
//   (iv)  A-4: a live edge resolving to a SUPPRESSED entity -> PASS --
//         entity existence is pinned to "row exists", never gated on
//         entities.suppressed.
//   (v)   A-1: against a fixture edges table that LACKS the suppressed
//         column entirely (pre-migrate-15-mcp-addenda.sql shape), a live
//         orphan edge still FAILs and the unscoped-mode INFO log line
//         prints -- proves the column-absent branch runs (not silently
//         skips) and is never silent about which mode ran.
async function testT6SuppressionAware() {
  const target = await pgConnect(TARGET_DB);
  try {
    await truncateAll(target, ['edges', 'entities', 'memory_entries', 'memory_entry_chunks']);
    const rosterPath = writeTmpJson('t6-suppression-roster.json', BASE_ROSTER);

    // (i) Suppressed orphan edge alone -> PASS.
    await target.query(`INSERT INTO edges (project_id, from_entity, to_entity, suppressed) VALUES ('proj-a', 'ghost-a', 'ghost-b', true)`);
    const r1 = runScript('verify-15-t6-referential-integrity.js', ['--db', TARGET_DB], rosterEnv(rosterPath));
    if (r1.status === 0) pass('T6-supp-a', 'suppressed orphan edge, alone -> PASS (tombstone excluded from the orphan-edge check)');
    else fail('T6-supp-a', 'suppressed orphan edge, alone -> PASS (tombstone excluded from the orphan-edge check)', `status=${r1.status} stdout=${r1.stdout} stderr=${r1.stderr}`);

    // (iii) A-6: mixed -- one suppressed orphan edge + one live orphan edge
    // -> FAIL with the count EXACTLY 1 (the suppressed row must not leak
    // into the count).
    await truncateAll(target, ['edges', 'entities']);
    await target.query(`INSERT INTO edges (project_id, from_entity, to_entity, suppressed) VALUES ('proj-a', 'ghost-a', 'ghost-b', true)`);
    await target.query(`INSERT INTO edges (project_id, from_entity, to_entity, suppressed) VALUES ('proj-a', 'ghost-c', 'ghost-d', false)`);
    const r2 = runScript('verify-15-t6-referential-integrity.js', ['--db', TARGET_DB], rosterEnv(rosterPath));
    const countMatch = (r2.stdout + r2.stderr).match(/(\d+) orphan edge/);
    if (r2.status !== 0 && countMatch && countMatch[1] === '1') {
      pass('T6-supp-b', 'one suppressed orphan edge + one live orphan edge -> FAIL with exactly 1 orphan edge (A-6: suppressed row does not leak into the count)');
    } else {
      fail('T6-supp-b', 'one suppressed orphan edge + one live orphan edge -> FAIL with exactly 1 orphan edge (A-6: suppressed row does not leak into the count)', `status=${r2.status} countMatch=${countMatch ? countMatch[1] : 'none'} stdout=${r2.stdout} stderr=${r2.stderr}`);
    }

    // (iv) A-4: a live edge resolving to a SUPPRESSED entity -> PASS.
    // entity existence is "row exists", regardless of entities.suppressed.
    await truncateAll(target, ['edges', 'entities']);
    await target.query(`INSERT INTO entities (project_id, name, suppressed) VALUES ('proj-a', 'Widget', true)`);
    await target.query(`INSERT INTO edges (project_id, from_entity, to_entity, suppressed) VALUES ('proj-a', 'Widget', 'Widget', false)`);
    const r3 = runScript('verify-15-t6-referential-integrity.js', ['--db', TARGET_DB], rosterEnv(rosterPath));
    if (r3.status === 0) pass('T6-supp-c', 'live edge resolving to a SUPPRESSED entity -> PASS (a tombstone entity is still a valid referent)');
    else fail('T6-supp-c', 'live edge resolving to a SUPPRESSED entity -> PASS (a tombstone entity is still a valid referent)', `status=${r3.status} stdout=${r3.stdout} stderr=${r3.stderr}`);

    // (v) A-1: against a fixture edges table that LACKS the suppressed
    // column entirely (pre-migrate-15-mcp-addenda.sql shape), a live
    // orphan edge still FAILs and the unscoped-mode INFO log line prints.
    // Column is dropped and restored on THIS fixture's edges table only,
    // inside a nested finally, so it never leaks into any other test that
    // shares TARGET_DB.
    await truncateAll(target, ['edges', 'entities']);
    await target.query('ALTER TABLE edges DROP COLUMN suppressed');
    try {
      await target.query(`INSERT INTO edges (project_id, from_entity, to_entity) VALUES ('proj-a', 'ghost-e', 'ghost-f')`);
      const r4 = runScript('verify-15-t6-referential-integrity.js', ['--db', TARGET_DB], rosterEnv(rosterPath));
      const out4 = r4.stdout + r4.stderr;
      if (r4.status !== 0 && /orphan edge/.test(out4) && /suppressed column is ABSENT/.test(out4)) {
        pass('T6-supp-d', 'edges.suppressed column ABSENT -> live orphan edge still FAILs, unscoped-mode INFO log line prints (A-1)');
      } else {
        fail('T6-supp-d', 'edges.suppressed column ABSENT -> live orphan edge still FAILs, unscoped-mode INFO log line prints (A-1)', `status=${r4.status} stdout=${r4.stdout} stderr=${r4.stderr}`);
      }
    } finally {
      await target.query('ALTER TABLE edges ADD COLUMN suppressed BOOLEAN NOT NULL DEFAULT false');
    }

    await truncateAll(target, ['edges', 'entities']);
  } finally {
    await target.end();
  }
}

async function testT7CavemanEconomy() {
  // The store-wide gate (test/north-star/test-caveman-economy-store-wide.js)
  // now EXISTS (memory-manager#12, T7's former blocker) — this test's
  // original assertion ("prerequisite not built") is stale and can never
  // match again. Updated to reflect current reality rather than deleted,
  // because the underlying INTENT this test encodes — "T7 never silently
  // passes" — still holds, just via a different, now-accurate mechanism.
  //
  // TARGET_DB here is the SAME narrow 7-table fixture setupTargetSchema()
  // builds for every other T0-T8 test in this file (decisions/tasks/
  // entities/edges/memory_entries/memory_entry_chunks/routing_profiles) —
  // nowhere near the full 29-table §5 schema scripts/migrations/
  // caveman-columns.json is built against. Running the now-real gate
  // against this deliberately narrow fixture is EXPECTED to fail its own
  // K-8 completeness backstop — not because the gate is missing, but
  // because this fixture's schema doesn't match §5. That is a correct, loud
  // failure (never a silent pass), reproduced independently (drop one
  // manifest column from a disposable DB -> named in "stale manifest
  // entries"; add one unlisted live column -> named in
  // "unclassified-LOUD-FAIL") before this assertion was written.
  //
  // The gate's POSITIVE path (PASS against a fully §5-provisioned schema) is
  // already covered by its own test suite (test/migrations/
  // test-caveman-gate-store-wide.js's T5c/T6a, and
  // test/north-star/test-caveman-economy-store-wide.js's own CLI smoke run,
  // both of which also run against the REAL memory_manager_staging) —
  // building a second full §5 schema fixture inside THIS shared-fixture file
  // would duplicate that coverage and risk destabilizing the ~15 other tests
  // that depend on TARGET_DB's narrow, fast-to-provision shape.
  const r = runScript('verify-15-t7-caveman-economy.js', ['--db', TARGET_DB]);
  const combined = r.stdout + r.stderr;
  const loudFail =
    r.status !== 0 &&
    /completeness \(K-8\): FAIL/.test(combined) &&
    (/unclassified-LOUD-FAIL/.test(combined) || /stale manifest entries/.test(combined));
  if (loudFail) {
    pass('T7', 'store-wide gate: narrow 7-table TARGET_DB fixture fails loud via the K-8 completeness backstop (never silently passes)');
  } else {
    fail('T7', 'store-wide gate: narrow 7-table TARGET_DB fixture fails loud via the K-8 completeness backstop (never silently passes)', `status=${r.status} stdout=${r.stdout} stderr=${r.stderr}`);
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
        await c.query("INSERT INTO edges (from_entity, to_entity, project_id) VALUES ('orphan-77777', 'orphan-77778', 'proj-a')");
        await c.end();
        return true;
      };
    `, 'utf8');
    CREATED_TMP_FILES.push(orphanModule);
    const r3 = runScript('verify-15-t8-idempotency.js', ['--db', TARGET_DB, '--rerun-module', orphanModule], rosterEnv(rosterPath));
    if (r3.status !== 0 && /T6 re-run/.test(r3.stdout + r3.stderr)) pass('T8-c', 'rerun introduces orphan edge -> T6 re-run catches it -> FAIL');
    else fail('T8-c', 'rerun introduces orphan edge -> T6 re-run catches it -> FAIL', `status=${r3.status} stdout=${r3.stdout} stderr=${r3.stderr}`);

    await target.query(`DELETE FROM edges WHERE from_entity = 'orphan-77777'`);
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

    // C-7 regression (§6.1(c), memory-manager#11(c), 2026-08-16): TWO
    // different source_dbs both excluding a same-named source_table
    // ("decisions") at NULL scope under the SAME excluded_reason used to
    // collapse under the pre-fix unscoped provenance query -- confirming
    // source A's manifest row could wrongly "prove" source B's exclusion
    // was accounted for even with B's own confirming row absent. With
    // sourceDb supplied, each source is checked independently.
    await truncateAll(target, ['migration_manifest']);
    await target.query(
      `INSERT INTO migration_manifest (source_db, source_table, project_id_or_null, row_count, content_fingerprint, excluded_reason)
       VALUES ('ephemeral_source_a','decisions',NULL,1,'fp-a','ephemeral-db-triage-drop')`
    );
    // Deliberately NO confirming row for 'ephemeral_source_b' at all.
    const t9SourceDbMod = require(scriptPath('verify-15-t9-negative.js'));
    const scopedA = await t9SourceDbMod.checkExclusion(
      target, roster,
      { excluded_reason: 'ephemeral-db-triage-drop', source_table: 'decisions', project_id_or_null: null },
      'ephemeral_source_a'
    );
    const scopedB = await t9SourceDbMod.checkExclusion(
      target, roster,
      { excluded_reason: 'ephemeral-db-triage-drop', source_table: 'decisions', project_id_or_null: null },
      'ephemeral_source_b'
    );
    if (scopedA.ok === true && scopedB.ok === false) {
      pass('T9-f-source-db-scoping', 'C-7: source_db-scoped provenance distinguishes two sources sharing a source_table+excluded_reason -- A confirmed, B (no confirming row) FAILs, never silently borrows A\'s manifest row');
    } else {
      fail('T9-f-source-db-scoping', 'C-7: source_db-scoped provenance distinguishes two sources sharing a source_table+excluded_reason -- A confirmed, B (no confirming row) FAILs, never silently borrows A\'s manifest row', `scopedA=${JSON.stringify(scopedA)} scopedB=${JSON.stringify(scopedB)}`);
    }
    // Unscoped call (sourceDb omitted) is UNCHANGED behavior -- proves the
    // fix is additive, not a breaking change for pre-existing callers: the
    // unscoped query still finds source A's row regardless of which source
    // is actually being asked about (this is the EXACT pre-fix ambiguity,
    // preserved on purpose for the omitted-argument code path per C-7's
    // "behavior-preserving for existing callers" requirement).
    const unscoped = await t9SourceDbMod.checkExclusion(
      target, roster,
      { excluded_reason: 'ephemeral-db-triage-drop', source_table: 'decisions', project_id_or_null: null }
    );
    if (unscoped.ok === true) {
      pass('T9-g-unscoped-unchanged', 'C-7: omitting sourceDb keeps the ORIGINAL unscoped provenance behavior (backward-compatible for existing unit-test callers)');
    } else {
      fail('T9-g-unscoped-unchanged', 'C-7: omitting sourceDb keeps the ORIGINAL unscoped provenance behavior (backward-compatible for existing unit-test callers)', `unscoped=${JSON.stringify(unscoped)}`);
    }
  } finally {
    await target.end();
  }
}

async function testT9NoColumnProvenanceOnly() {
  // BF-R2 (cm#187/cm#188 spec-adversary pass, 2026-08-18): T9 against a
  // no-project_id-column table is PROVENANCE-ONLY -- no live-count query is
  // attempted at all (there is no project_id to filter/compare against).
  const target = await pgConnect(TARGET_DB);
  try {
    await shared.applyDdl(target);
    await truncateAll(target, ['migration_manifest', 'retrieval_event_assertions']);
    const rosterPath = writeTmpJson('t9-nocolumn-roster.json', [NO_COLUMN_ROSTER_ENTRY]);

    // Project-scoped exclusion on the no-column table, provenance intact
    // (the enumerated exclusion IS its own confirming manifest row) -> PASS,
    // provenance-only mode logged, no crash.
    await target.query(
      `INSERT INTO migration_manifest (source_db, source_table, project_id_or_null, row_count, content_fingerprint, excluded_reason)
       VALUES ($1,'retrieval_event_assertions','proj-noncol',3,'fp','eval-junk-project-id')`,
      [SOURCE_DB]
    );
    const r1 = runScript('verify-15-t9-negative.js', ['--db', TARGET_DB], rosterEnv(rosterPath));
    if (r1.status === 0 && /provenance-only/i.test(r1.stdout + r1.stderr)) {
      pass('T9-nocolumn-a', 'no-column table, project-scoped exclusion, provenance intact -> PASS, provenance-only mode logged, no crash');
    } else {
      fail('T9-nocolumn-a', 'no-column table, project-scoped exclusion, provenance intact -> PASS, provenance-only mode logged, no crash', `status=${r1.status} stdout=${r1.stdout} stderr=${r1.stderr}`);
    }

    // Break provenance directly via the exported unit (same convention as
    // the NULL-scoped T9-e test): confirms FAIL when migration_manifest no
    // longer records the exclusion, and confirms this never crashes.
    const t9mod = require(scriptPath('verify-15-t9-negative.js'));
    const roster = JSON.parse(fs.readFileSync(rosterPath, 'utf8'));
    const intact = await t9mod.checkExclusion(target, roster, {
      excluded_reason: 'eval-junk-project-id', source_table: 'retrieval_event_assertions', project_id_or_null: 'proj-noncol',
    }, SOURCE_DB);
    await truncateAll(target, ['migration_manifest']);
    const broken = await t9mod.checkExclusion(target, roster, {
      excluded_reason: 'eval-junk-project-id', source_table: 'retrieval_event_assertions', project_id_or_null: 'proj-noncol',
    }, SOURCE_DB);
    if (intact.ok === true && intact.provenanceOnly === true && broken.ok === false) {
      pass('T9-nocolumn-b', 'provenance-only unit: PASS when manifest row present, FAIL when absent, never a crash, always provenanceOnly=true for this table');
    } else {
      fail('T9-nocolumn-b', 'provenance-only unit: PASS when manifest row present, FAIL when absent, never a crash, always provenanceOnly=true for this table', `intact=${JSON.stringify(intact)} broken=${JSON.stringify(broken)}`);
    }

    // NULL-scoped exclusion on the SAME no-column table also runs
    // provenance-only (IS NOT DISTINCT FROM handles NULL and project-scoped
    // exclusions with the SAME query shape) -- provenance intact -> PASS.
    await truncateAll(target, ['migration_manifest']);
    await target.query(
      `INSERT INTO migration_manifest (source_db, source_table, project_id_or_null, row_count, content_fingerprint, excluded_reason)
       VALUES ($1,'retrieval_event_assertions',NULL,3,'fp','ephemeral-db-triage-drop')`,
      [SOURCE_DB]
    );
    const r2 = runScript('verify-15-t9-negative.js', ['--db', TARGET_DB], rosterEnv(rosterPath));
    if (r2.status === 0 && /provenance-only/i.test(r2.stdout + r2.stderr)) {
      pass('T9-nocolumn-c', 'no-column table, NULL-scoped exclusion -> also provenance-only, PASS, no crash');
    } else {
      fail('T9-nocolumn-c', 'no-column table, NULL-scoped exclusion -> also provenance-only, PASS, no crash', `status=${r2.status} stdout=${r2.stdout} stderr=${r2.stderr}`);
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
    await createDb(LIVE_TABLE_DB);

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
    await testT0SourcelessClassification();
    await testT0InverseDirection();
    await testT0LiveTableClassification();
    await testMalformedNetNewFatal();
    await testDisjointnessValidation();
    await testT0Completeness();
    await testT1Snapshot();
    await testFreezePrecondition();
    await testT2Rowcount();
    await testT2NoColumnReconciliation();
    await testT25Dualwrite();
    await testT3ContentHash();
    await testT3NoColumnFixture();
    await testT3ExclusionAwareness();
    await testT3SourcelessSkip();
    await testT3bReverseContainment();
    await testT3bNoColumnReconciliation();
    await testT3bSourceless();
    await testT4RecallEquivalence();
    await testT5EmbeddingCoverage();
    await testT6ReferentialIntegrity();
    await testT6JoinKeyFix();
    await testT6SuppressionAware();
    await testT7CavemanEconomy();
    await testT8Idempotency();
    await testT9Negative();
    await testT9NoColumnProvenanceOnly();
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
