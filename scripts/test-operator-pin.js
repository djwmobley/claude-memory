'use strict';

/**
 * test-operator-pin.js — Test harness for operator-pin.js standalone script.
 *
 * Architecture mirrors test-graph-traversal.js:
 *   - Throwaway DB: claude_memory_pintest_<timestamp>
 *   - Unique temp project dir -> unique project_id via encodeCwd
 *   - Subprocess calls to operator-pin.js
 *   - Applies handoff-core-schema.sql
 *   - UNCONDITIONAL finally-block teardown (drop DB + temp dirs)
 *
 * Coverage:
 *   P-1  Dry-run writes nothing: no rows inserted; exit 0
 *   P-2  --apply inserts canon rows: pinned=true, source=user_stated,
 *        confidence=10, tier=consolidated
 *   P-3  Idempotent re-run: second --apply is a no-op (no duplicate rows)
 *   P-4  operator-pin is NOT in the handoff.js dispatch map
 *   P-5  Invalid facts (missing required fields) are skipped without crash
 *
 * Usage:
 *   node scripts/test-operator-pin.js
 *
 * Exit 0 = all pass; nonzero = any failure.
 */

const { spawnSync } = require('child_process');
const fs            = require('fs');
const os            = require('os');
const path          = require('path');
const { Client }    = require('pg');
const { readMarker } = require('./lib/project-marker');

// ── Constants ─────────────────────────────────────────────────────────────────

const PROJECT_ROOT   = path.resolve(__dirname, '..');
const HANDOFF_SCRIPT = path.join(PROJECT_ROOT, 'scripts', 'handoff.js');
const OP_PIN_SCRIPT  = path.join(PROJECT_ROOT, 'scripts', 'operator-pin.js');
const SCHEMA_FILE    = path.join(PROJECT_ROOT, 'scripts', 'sql', 'handoff-core-schema.sql');
const TS             = Date.now();
const DB_NAME        = `claude_memory_pintest_${TS}`;

// ── Tracking ──────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function pass(step, label) {
  console.log(`[${step}] ${label} ... PASS`);
  passed++;
}

function fail(step, label, reason) {
  console.log(`[${step}] ${label} ... FAIL: ${reason}`);
  failed++;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function encodeCwd(p) {
  return p.replace(/[/\\]+$/, '').replace(/[^A-Za-z0-9-]/g, '-');
}

function markerUUIDOrFallback(dir) {
  const m = readMarker(dir);
  return (m && m.uuid) ? m.uuid : encodeCwd(dir);
}

async function pgConnect(database = 'postgres') {
  const cfg = {
    host:     process.env.PGHOST     || 'localhost',
    port:     parseInt(process.env.PGPORT || '5432', 10),
    user:     process.env.PGUSER     || 'postgres',
    password: process.env.PGPASSWORD || 'postgres',
    database,
  };
  const client = new Client(cfg);
  await client.connect();
  return client;
}

async function createTestDb(dbName, projectDir) {
  const sysDb = await pgConnect('postgres');
  const exists = await sysDb.query('SELECT 1 FROM pg_database WHERE datname = $1', [dbName]);
  if (exists.rows.length > 0) {
    await sysDb.end();
    throw new Error(`DB ${dbName} already exists — naming collision`);
  }
  await sysDb.query(`CREATE DATABASE "${dbName}"`);
  await sysDb.end();
  fs.mkdirSync(projectDir, { recursive: true });
}

async function dropTestDb(dbName, projectDir) {
  try {
    if (fs.existsSync(projectDir)) fs.rmSync(projectDir, { recursive: true, force: true });
  } catch (_) {}
  let sysDb;
  try {
    sysDb = await pgConnect('postgres');
    await sysDb.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
       WHERE datname = $1 AND pid <> pg_backend_pid()`,
      [dbName]
    );
    await sysDb.query(`DROP DATABASE IF EXISTS "${dbName}"`);
    await sysDb.end();
    console.log(`[TEARDOWN] Dropped DB: ${DB_NAME}`);
  } catch (err) {
    if (sysDb) { try { await sysDb.end(); } catch (_) {} }
    console.error(`[TEARDOWN] WARNING: cleanup failed — ${err.message}`);
  }
}

async function applySchema(dbName) {
  const sql = fs.readFileSync(SCHEMA_FILE, 'utf8');
  const db  = await pgConnect(dbName);
  await db.query('BEGIN');
  await db.query(sql);
  await db.query('COMMIT');
  await db.end();
}

function runHandoff(sub, extraArgs = [], stdin = null, dbName, projectDir) {
  const env = {
    ...process.env,
    HANDOFF_DB:   dbName,
    PROJECT_ROOT: projectDir,
  };
  const opts = {
    cwd:      PROJECT_ROOT,
    env,
    encoding: 'utf8',
    timeout:  30000,
  };
  if (stdin !== null) opts.input = stdin;
  return spawnSync(process.execPath, [HANDOFF_SCRIPT, sub, ...extraArgs], opts);
}

function runOpPin(args, projectDir) {
  const env = {
    ...process.env,
    PROJECT_ROOT: projectDir,
    PGHOST:       process.env.PGHOST     || 'localhost',
    PGUSER:       process.env.PGUSER     || 'postgres',
    PGPASSWORD:   process.env.PGPASSWORD || 'postgres',
    PGDATABASE:   DB_NAME,
  };
  return spawnSync(process.execPath, [OP_PIN_SCRIPT, ...args], {
    cwd:      PROJECT_ROOT,
    env,
    encoding: 'utf8',
    timeout:  30000,
  });
}

async function bootstrapDb(dbName, projectDir) {
  await createTestDb(dbName, projectDir);
  fs.writeFileSync(
    path.join(projectDir, 'CLAUDE.md'),
    '# pin-test\n\n## Durable facts\n- (none)\n',
    'utf8'
  );
  const initR = runHandoff('init', ['-y'], null, dbName, projectDir);
  if (initR.status !== 0) {
    throw new Error(`init failed: ${(initR.stderr || initR.stdout || '').slice(0, 400)}`);
  }
}

/** Write a temporary JSON facts file; return its path. */
function writeFacts(tmpDir, filename, facts) {
  const p = path.join(tmpDir, filename);
  fs.writeFileSync(p, JSON.stringify(facts, null, 2), 'utf8');
  return p;
}

// ── SECTION P-1: Dry-run writes nothing ──────────────────────────────────────

async function sectionP1(dbName, projectDir, projectId, tmpDir) {
  console.log('\n--- P-1: Dry-run writes nothing ---');

  const factsFile = writeFacts(tmpDir, 'p1-facts.json', [
    { subject: 'TestSubject', predicate: 'is_canonical', object: 'true' },
  ]);

  const r = runOpPin(['--facts', factsFile, '--project-id', projectId], projectDir);

  // P-1a: exit 0.
  if (r.status === 0) {
    pass('P-1a', 'operator-pin dry-run exits 0');
  } else {
    fail('P-1a', 'operator-pin dry-run exits 0',
      `exited ${r.status}: ${(r.stderr || r.stdout || '').slice(0, 200)}`);
    return;
  }

  // P-1b: output says dry-run / would insert.
  const out = r.stdout || '';
  if (out.includes('dry') || out.includes('would insert') || out.includes('[dry]')) {
    pass('P-1b', 'dry-run output indicates no writes');
  } else {
    fail('P-1b', 'dry-run output indicates no writes',
      `unexpected output: ${out.slice(0, 200)}`);
  }

  // P-1c: no row inserted.
  const db = await pgConnect(dbName);
  try {
    const { rows } = await db.query(
      `SELECT COUNT(*) AS n FROM assertions
       WHERE project_id = $1 AND subject = 'TestSubject' AND pinned = true`,
      [projectId]
    );
    if (parseInt(rows[0].n, 10) === 0) {
      pass('P-1c', 'dry-run inserts zero rows');
    } else {
      fail('P-1c', 'dry-run inserts zero rows',
        `found ${rows[0].n} pinned rows — dry-run wrote to DB`);
    }
  } finally {
    await db.end();
  }
}

// ── SECTION P-2: --apply inserts canon rows ───────────────────────────────────

async function sectionP2(dbName, projectDir, projectId, tmpDir) {
  console.log('\n--- P-2: --apply inserts canon rows ---');

  const factsFile = writeFacts(tmpDir, 'p2-facts.json', [
    { subject: 'CanonSubject', predicate: 'is_canonical', object: 'prod-value' },
    { subject: 'CanonSubject', predicate: 'uses',         object: 'canon-tool' },
  ]);

  const r = runOpPin(['--facts', factsFile, '--project-id', projectId, '--apply'], projectDir);

  // P-2a: exit 0.
  if (r.status === 0) {
    pass('P-2a', 'operator-pin --apply exits 0');
  } else {
    fail('P-2a', 'operator-pin --apply exits 0',
      `exited ${r.status}: stdout=${(r.stdout || '').slice(0, 200)} stderr=${(r.stderr || '').slice(0, 200)}`);
    return;
  }

  // P-2b: rows inserted with correct attributes.
  const db = await pgConnect(dbName);
  try {
    const { rows } = await db.query(
      `SELECT subject, predicate, object, confidence, source, pinned, tier,
              suppressed, invalid_at, session_id
       FROM assertions
       WHERE project_id = $1
         AND subject = 'CanonSubject'
         AND pinned = true
       ORDER BY predicate`,
      [projectId]
    );

    if (rows.length === 2) {
      pass('P-2b', '--apply inserts 2 rows for CanonSubject');
    } else {
      fail('P-2b', '--apply inserts 2 rows for CanonSubject',
        `found ${rows.length} rows`);
      return;
    }

    // Verify attributes on both rows.
    let attrOk = true;
    for (const row of rows) {
      if (parseFloat(row.confidence) !== 10) {
        fail('P-2c', `pinned row has confidence=10 (subject=${row.subject}, pred=${row.predicate})`,
          `confidence=${row.confidence}`);
        attrOk = false;
      }
      if (row.source !== 'user_stated') {
        fail('P-2d', `pinned row has source='user_stated'`,
          `source=${row.source}`);
        attrOk = false;
      }
      if (row.pinned !== true) {
        fail('P-2e', `pinned row has pinned=true`,
          `pinned=${row.pinned}`);
        attrOk = false;
      }
      if (row.tier !== 'consolidated') {
        fail('P-2f', `pinned row has tier='consolidated'`,
          `tier=${row.tier}`);
        attrOk = false;
      }
      if (row.suppressed !== false) {
        fail('P-2g', `pinned row has suppressed=false`,
          `suppressed=${row.suppressed}`);
        attrOk = false;
      }
      if (row.invalid_at !== null) {
        fail('P-2h', `pinned row has invalid_at=NULL`,
          `invalid_at=${row.invalid_at}`);
        attrOk = false;
      }
      if (row.session_id !== null) {
        fail('P-2i', `pinned row has session_id=NULL`,
          `session_id=${row.session_id}`);
        attrOk = false;
      }
    }
    if (attrOk) {
      pass('P-2c-i', 'all inserted rows have correct attributes (conf=10, source=user_stated, pinned=true, tier=consolidated, suppressed=false, invalid_at=NULL, session_id=NULL)');
    }
  } finally {
    await db.end();
  }
}

// ── SECTION P-3: Idempotent re-run ────────────────────────────────────────────

async function sectionP3(dbName, projectDir, projectId, tmpDir) {
  console.log('\n--- P-3: Idempotent re-run ---');

  const factsFile = writeFacts(tmpDir, 'p3-facts.json', [
    { subject: 'CanonSubject', predicate: 'is_canonical', object: 'prod-value' },
    { subject: 'CanonSubject', predicate: 'uses',         object: 'canon-tool' },
  ]);

  // Run --apply a second time (rows already exist from P-2).
  const r = runOpPin(['--facts', factsFile, '--project-id', projectId, '--apply'], projectDir);

  if (r.status === 0) {
    pass('P-3a', 'second --apply run exits 0 (idempotent)');
  } else {
    fail('P-3a', 'second --apply run exits 0 (idempotent)',
      `exited ${r.status}: ${(r.stdout || r.stderr || '').slice(0, 200)}`);
    return;
  }

  // Exactly 2 rows still (no duplicates).
  const db = await pgConnect(dbName);
  try {
    const { rows } = await db.query(
      `SELECT COUNT(*) AS n FROM assertions
       WHERE project_id = $1
         AND subject = 'CanonSubject'
         AND pinned = true
         AND suppressed = false`,
      [projectId]
    );
    const n = parseInt(rows[0].n, 10);
    if (n === 2) {
      pass('P-3b', 'idempotent re-run produces no duplicate rows (still exactly 2)');
    } else {
      fail('P-3b', 'idempotent re-run produces no duplicate rows',
        `found ${n} rows — expected 2`);
    }
  } finally {
    await db.end();
  }

  // Output should mention "skip" or "already exists".
  const out = r.stdout || '';
  if (out.includes('[skip]') || out.includes('already') || out.includes('Skipped')) {
    pass('P-3c', 'idempotent run reports skipped rows');
  } else {
    fail('P-3c', 'idempotent run reports skipped rows',
      `no skip indicator in output: ${out.slice(0, 200)}`);
  }
}

// ── SECTION P-4: Not in dispatch map ──────────────────────────────────────────

function sectionP4() {
  console.log('\n--- P-4: operator-pin NOT in handoff.js dispatch map ---');

  const handoffSource = fs.readFileSync(HANDOFF_SCRIPT, 'utf8');
  // The subcommands map block.
  const mapMatch = handoffSource.match(/const subcommands\s*=\s*\{[^}]+\}/s);
  if (!mapMatch) {
    fail('P-4', 'operator-pin not in dispatch map (static check)',
      'could not locate subcommands map in handoff.js');
    return;
  }
  const mapText = mapMatch[0];
  if (!mapText.includes('operator-pin') && !mapText.includes('operatorPin')) {
    pass('P-4', 'operator-pin is NOT wired into handoff.js subcommand dispatch map');
  } else {
    fail('P-4', 'operator-pin is NOT wired into handoff.js subcommand dispatch map',
      'operator-pin found in subcommands map — must be standalone only');
  }
}

// ── SECTION P-5: Invalid facts skipped without crash ──────────────────────────

async function sectionP5(dbName, projectDir, projectId, tmpDir) {
  console.log('\n--- P-5: Invalid facts skipped without crash ---');

  const factsFile = writeFacts(tmpDir, 'p5-facts.json', [
    { subject: '', predicate: 'uses', object: 'val' },         // missing subject
    { predicate: 'uses', object: 'val' },                      // missing subject key
    { subject: 'Foo', predicate: '', object: 'val' },          // empty predicate
    { subject: 'Foo', predicate: 'uses' },                     // missing object
    { subject: 'GoodFact', predicate: 'is_canonical', object: 'good-value' }, // valid
  ]);

  // Trusted anchor so M2 gate is not the bottleneck here.
  const db = await pgConnect(dbName);
  try {
    await db.query(
      `INSERT INTO assertions
         (project_id, subject, predicate, object, confidence, source,
          pinned, suppressed, decay_rate, valid_at)
       VALUES ($1, 'GoodFact', 'status', 'anchor', 9.0, 'user_stated',
               true, false, 0.05, now())`,
      [projectId]
    );
  } finally {
    await db.end();
  }

  const r = runOpPin(['--facts', factsFile, '--project-id', projectId, '--apply'], projectDir);

  // P-5a: does not crash (exit 0).
  if (r.status === 0) {
    pass('P-5a', 'invalid facts in array do not crash operator-pin');
  } else {
    fail('P-5a', 'invalid facts in array do not crash operator-pin',
      `exited ${r.status}: ${(r.stdout || r.stderr || '').slice(0, 200)}`);
    return;
  }

  // P-5b: only the valid fact is inserted.
  const db2 = await pgConnect(dbName);
  try {
    const { rows } = await db2.query(
      `SELECT COUNT(*) AS n FROM assertions
       WHERE project_id = $1
         AND subject = 'GoodFact'
         AND predicate = 'is_canonical'
         AND object = 'good-value'
         AND pinned = true`,
      [projectId]
    );
    if (parseInt(rows[0].n, 10) >= 1) {
      pass('P-5b', 'valid fact inserted correctly despite invalid siblings');
    } else {
      fail('P-5b', 'valid fact inserted correctly despite invalid siblings',
        'GoodFact/is_canonical/good-value not found');
    }
  } finally {
    await db2.end();
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`test-operator-pin: DB=${DB_NAME}`);
  console.log('');

  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pin-test-'));
  const tmpDir     = fs.mkdtempSync(path.join(os.tmpdir(), 'pin-facts-'));

  try {
    await bootstrapDb(DB_NAME, projectDir);
    const projectId = markerUUIDOrFallback(projectDir);
    console.log(`project_id: ${projectId}`);

    await sectionP1(DB_NAME, projectDir, projectId, tmpDir);
    await sectionP2(DB_NAME, projectDir, projectId, tmpDir);
    await sectionP3(DB_NAME, projectDir, projectId, tmpDir);
    sectionP4();
    await sectionP5(DB_NAME, projectDir, projectId, tmpDir);
  } finally {
    await dropTestDb(DB_NAME, projectDir);
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  }

  console.log('');
  console.log(`test-operator-pin: ${passed}/${passed + failed} passed`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error('test-operator-pin fatal:', err.message);
  if (process.env.DEBUG) console.error(err.stack);
  process.exitCode = 1;
});
