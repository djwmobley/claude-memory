'use strict';

/**
 * test-migrate-schema-addenda.js — Test harness for
 * scripts/migrations/migrate-schema-addenda.js, the schema-only-addenda
 * runner that applies six net-new SQL pieces (attribution columns,
 * carryover_status, model_registry, embedding_providers, the routing
 * harness tables, and the usage-telemetry tables) on top of a
 * migrate-01-canonical-db.js target.
 *
 * Mirrors test-migrate-01.js's conventions exactly: self-contained scratch
 * databases (all named to satisfy the runner's own classifyTarget — reused
 * by reference from migrate-01, never a second classifier — so no bypass or
 * classifier weakening is needed anywhere in this file), unconditional
 * finally-block cleanup, never touches claude_memory_eval_test beyond a
 * refusal-branch assertion that exits before any connection is opened.
 *
 * Requires Postgres at PGHOST/PGUSER/PGPASSWORD (CI env) or
 * localhost/postgres, with the pgvector extension available (migrate-01's
 * four schema files, applied here as a fixture step, depend on it).
 *
 * Usage: node test/migrations/test-migrate-schema-addenda.js
 * Exit 0 = all pass; nonzero = any failure.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { createRequire } = require('module');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const MIGRATE_ONE_PATH = path.join(PROJECT_ROOT, 'scripts', 'migrations', 'migrate-01-canonical-db.js');
const SCRIPT_PATH = path.join(PROJECT_ROOT, 'scripts', 'migrations', 'migrate-schema-addenda.js');

const migrateOne = require(MIGRATE_ONE_PATH);
const addenda = require(SCRIPT_PATH);

// scripts/ has its own node_modules (pg, etc.) — this test lives under
// test/, outside that tree, so resolve 'pg' the same way test-migrate-01.js
// does: via a require() rooted at scripts/package.json.
const scriptsRequire = createRequire(require.resolve('../../scripts/package.json'));
const { Client } = scriptsRequire('pg');

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

/** Run migrate-schema-addenda.js as a subprocess. */
function runAddenda(args, extraEnv = {}, timeoutMs = 20000) {
  return spawnSync(process.execPath, [SCRIPT_PATH, ...args], {
    cwd: PROJECT_ROOT,
    env: { ...process.env, ...extraEnv },
    encoding: 'utf8',
    timeout: timeoutMs,
  });
}

/** Run migrate-01-canonical-db.js as a subprocess (fixture setup only). */
function runMigrateOne(args, extraEnv = {}, timeoutMs = 30000) {
  return spawnSync(process.execPath, [MIGRATE_ONE_PATH, ...args], {
    cwd: PROJECT_ROOT,
    env: { ...process.env, ...extraEnv },
    encoding: 'utf8',
    timeout: timeoutMs,
  });
}

// Scratch DB names — all satisfy classifyTarget's allowed pattern (end in
// "_staging").
const DB_PREREQ_MISSING = `msa_prereq_${TS}_staging`;   // created, but migrate-01 never applied
const DB_NEVER_CREATED  = `msa_never_${TS}_staging`;     // never created at all
const DB_MAIN           = `msa_main_${TS}_staging`;      // migrate-01 applied; used for T2/T3
const DB_PROOF          = `msa_proof_${TS}_staging`;     // migrate-01 + addenda applied; used for T5
const DB_MIDSEQ         = `msa_midseq_${TS}_staging`;    // migrate-01 applied; used for T8

const CREATED_DBS = [DB_PREREQ_MISSING, DB_MAIN, DB_PROOF, DB_MIDSEQ];

// ── T1 / T1b: prerequisite refusal (two distinct code paths) ─────────────────

async function testPrereqTableMissing() {
  const sys = await pgConnect('postgres');
  try {
    await sys.query(`CREATE DATABASE "${DB_PREREQ_MISSING}"`);
  } finally {
    await sys.end();
  }

  const r = runAddenda(['--db', DB_PREREQ_MISSING]);
  const refused = r.status === 1 &&
    /missing prerequisite table\(s\)/.test(r.stderr) &&
    /entities/.test(r.stderr) && /assertions/.test(r.stderr) && /edges/.test(r.stderr) &&
    /migrate-01-canonical-db\.js/.test(r.stderr) &&
    /Nothing was applied/.test(r.stderr);
  if (!refused) {
    fail('T1', 'existing-but-empty DB without migrate-01 schema → prerequisite refusal, nothing applied', `status=${r.status} stderr=${r.stderr}`);
    return;
  }

  // Nothing was applied — no addendum table should exist.
  const client = await pgConnect(DB_PREREQ_MISSING);
  try {
    const { rows } = await client.query(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema() AND table_type='BASE TABLE'`
    );
    if (rows.length === 0) {
      pass('T1', 'existing-but-empty DB without migrate-01 schema → prerequisite refusal, nothing applied');
    } else {
      fail('T1', 'existing-but-empty DB without migrate-01 schema → prerequisite refusal, nothing applied', `unexpected tables present: ${rows.map((r2) => r2.table_name).join(', ')}`);
    }
  } finally {
    await client.end();
  }
}

async function testDbNeverCreated() {
  const r = runAddenda(['--db', DB_NEVER_CREATED]);
  if (r.status === 1 && /does not exist/.test(r.stderr) && /migrate-01-canonical-db\.js/.test(r.stderr)) {
    pass('T1b', 'target DB never created at all → exit 1, distinct pg_database-lookup code path');
  } else {
    fail('T1b', 'target DB never created at all → exit 1, distinct pg_database-lookup code path', `status=${r.status} stderr=${r.stderr}`);
  }
}

// ── T2: fresh apply against a migrate-01'd target ─────────────────────────────

async function testFreshApply() {
  const setup = runMigrateOne(['--db', DB_MAIN]);
  if (setup.status !== 0) {
    fail('T2', 'fresh apply against migrate-01\'d target → PASS, full derived set present', `migrate-01 fixture setup failed: status=${setup.status} stdout=${setup.stdout} stderr=${setup.stderr}`);
    return;
  }

  const r = runAddenda(['--db', DB_MAIN]);
  const cliPass = r.status === 0 && /MIGRATION_RESULT: PASS/.test(r.stdout);
  if (!cliPass) {
    fail('T2', 'fresh apply against migrate-01\'d target → PASS, full derived set present', `status=${r.status} stdout=${r.stdout} stderr=${r.stderr}`);
    return;
  }

  const client = await pgConnect(DB_MAIN);
  try {
    const v = await addenda.verifyAddenda(client, addenda.SQL_FILES);
    const ok = v.pass &&
      v.expectedTables.length === 6 &&
      v.missingColumns.length === 0 &&
      v.wrongTypeColumns.length === 0 &&
      v.missingChecks.length === 0 &&
      v.missingIndexes.length === 0 &&
      v.malformedIndexes.length === 0 &&
      v.missingUniques.length === 0 &&
      v.failedSeeds.length === 0 &&
      v.seedResults.length === 1 && v.seedResults[0].pass === true;
    if (ok) {
      pass('T2', 'fresh apply against migrate-01\'d target → PASS, full derived set present (tables/columns/types/CHECKs/indexes/UNIQUEs/seed row)');
    } else {
      fail('T2', 'fresh apply against migrate-01\'d target → PASS, full derived set present', JSON.stringify(v, null, 2));
    }
  } finally {
    await client.end();
  }
}

// ── T3: idempotency ────────────────────────────────────────────────────────

async function testIdempotentSecondRun() {
  const r = runAddenda(['--db', DB_MAIN]);
  if (!(r.status === 0 && /MIGRATION_RESULT: PASS/.test(r.stdout))) {
    fail('T3', 'idempotent second run → PASS, identical object set', `status=${r.status} stdout=${r.stdout} stderr=${r.stderr}`);
    return;
  }
  const client = await pgConnect(DB_MAIN);
  try {
    const v = await addenda.verifyAddenda(client, addenda.SQL_FILES);
    // Zero net change: no dupe UNIQUE/index rows, still exactly the derived set.
    const { rows: idxRows } = await client.query(
      `SELECT indexname FROM pg_indexes WHERE schemaname = current_schema() AND indexname = 'routing_profiles_project_idx'`
    );
    if (v.pass && idxRows.length === 1) {
      pass('T3', 'idempotent second run → PASS, identical object set (no duplicate index rows)');
    } else {
      fail('T3', 'idempotent second run → PASS, identical object set', `v.pass=${v.pass} idxRows=${idxRows.length}`);
    }
  } finally {
    await client.end();
  }
}

// ── T4: refused target names + reference-identity (A-14) ─────────────────────

async function testRefusedTargetNames() {
  const r1 = runAddenda(['--db', 'claude_memory_eval_test']);
  const ok1 = r1.status === 1 && /claude_memory_eval_test/.test(r1.stderr) && /no database connection was opened/.test(r1.stderr);
  if (!ok1) {
    fail('T4a', 'refuses claude_memory_eval_test before connecting', `status=${r1.status} stderr=${r1.stderr}`);
  } else {
    pass('T4a', 'refuses claude_memory_eval_test before connecting');
  }

  const r2 = runAddenda(['--db', 'pipeline_something']);
  const ok2 = r2.status === 1 && /pipeline_/.test(r2.stderr);
  if (!ok2) {
    fail('T4b', 'refuses names matching /^pipeline_/', `status=${r2.status} stderr=${r2.stderr}`);
  } else {
    pass('T4b', 'refuses names matching /^pipeline_/');
  }

  const r3 = runAddenda(['--db', `msa_unrecognized_${TS}_scratch`]);
  const ok3 = r3.status === 1 && /not a recognized consolidation target/.test(r3.stderr);
  if (!ok3) {
    fail('T4c', 'refuses an unrecognized/unlisted name (total-classification default branch)', `status=${r3.status} stderr=${r3.stderr}`);
  } else {
    pass('T4c', 'refuses an unrecognized/unlisted name (total-classification default branch)');
  }

  // A-14: the re-exported classifyTarget must be the SAME function
  // reference as migrate-01's own export — imported, not forked.
  if (addenda.classifyTarget === migrateOne.classifyTarget) {
    pass('T4d', 're-exported classifyTarget is === migrate-01\'s own export (import, not fork)');
  } else {
    fail('T4d', 're-exported classifyTarget is === migrate-01\'s own export (import, not fork)', 'function references differ');
  }
}

// ── T5: verification proof-of-firing (a)-(f) ──────────────────────────────────

async function testProofOfFiring() {
  const setup1 = runMigrateOne(['--db', DB_PROOF]);
  if (setup1.status !== 0) {
    fail('T5', 'proof-of-firing setup', `migrate-01 fixture setup failed: ${setup1.stderr}`);
    return;
  }
  const setup2 = runAddenda(['--db', DB_PROOF]);
  if (setup2.status !== 0) {
    fail('T5', 'proof-of-firing setup', `addenda fixture setup failed: ${setup2.stderr}`);
    return;
  }

  const client = await pgConnect(DB_PROOF);
  const sqlFiles = addenda.SQL_FILES;
  const findFile = (name) => sqlFiles.find((f) => f.endsWith(name));

  try {
    // (a) DROP one addendum table → verifyAddenda FAILs, names it.
    await client.query('DROP TABLE IF EXISTS routing_profiles CASCADE');
    let v = await addenda.verifyAddenda(client, sqlFiles);
    if (v.pass === false && v.missingTables.includes('routing_profiles')) {
      pass('T5a', 'proof-of-firing: DROP addendum table → verifyAddenda FAILs, names it');
    } else {
      fail('T5a', 'proof-of-firing: DROP addendum table → verifyAddenda FAILs, names it', JSON.stringify(v.missingTables));
    }
    await addenda.applySqlFile(client, findFile('migrate-10-routing-harness.sql')); // heal

    // (b) DROP one ALTER-added column → verifyAddenda FAILs, names it.
    await client.query('ALTER TABLE assertions DROP COLUMN IF EXISTS carryover_status');
    v = await addenda.verifyAddenda(client, sqlFiles);
    const missingCarryover = v.missingColumns.some((c) => c.table === 'assertions' && c.column === 'carryover_status');
    if (v.pass === false && missingCarryover) {
      pass('T5b', 'proof-of-firing: DROP ALTER-added column → verifyAddenda FAILs, names it');
    } else {
      fail('T5b', 'proof-of-firing: DROP ALTER-added column → verifyAddenda FAILs, names it', JSON.stringify(v.missingColumns));
    }
    await addenda.applySqlFile(client, findFile('migrate-06-carryover-status.sql')); // heal

    // (c) pre-create a stub table with missing columns → verifyAddenda FAILs
    // on missing columns (table itself is present, so NOT in missingTables).
    await client.query('DROP TABLE IF EXISTS session_usage CASCADE');
    await client.query('CREATE TABLE session_usage (id SERIAL PRIMARY KEY)');
    v = await addenda.verifyAddenda(client, sqlFiles);
    const sessionUsageMissingCols = v.missingColumns.filter((c) => c.table === 'session_usage').map((c) => c.column);
    const tableNotFlaggedMissing = !v.missingTables.includes('session_usage');
    if (v.pass === false && tableNotFlaggedMissing && sessionUsageMissingCols.includes('project_id') && sessionUsageMissingCols.includes('total_cost_usd')) {
      pass('T5c', 'proof-of-firing: pre-existing stub table with missing columns → verifyAddenda FAILs on missing columns, not missing table');
    } else {
      fail('T5c', 'proof-of-firing: pre-existing stub table with missing columns → verifyAddenda FAILs on missing columns, not missing table', `missingTables=${JSON.stringify(v.missingTables)} sessionUsageMissingCols=${JSON.stringify(sessionUsageMissingCols)}`);
    }
    await client.query('DROP TABLE IF EXISTS session_usage CASCADE');
    await addenda.applySqlFile(client, findFile('migrate-11-usage-telemetry.sql')); // heal (recreates turn_usage idempotently too)

    // (d) column present but its CHECK constraint absent → verifyAddenda
    // FAILs on the missing CHECK (column itself is NOT in missingColumns).
    await client.query('ALTER TABLE assertions DROP COLUMN IF EXISTS carryover_status');
    await client.query('ALTER TABLE assertions ADD COLUMN carryover_status TEXT'); // bare, no CHECK
    v = await addenda.verifyAddenda(client, sqlFiles);
    const carryoverColPresent = !v.missingColumns.some((c) => c.table === 'assertions' && c.column === 'carryover_status');
    const carryoverCheckMissing = v.missingChecks.some((c) => c.table === 'assertions' && c.column === 'carryover_status');
    if (v.pass === false && carryoverColPresent && carryoverCheckMissing) {
      pass('T5d', 'proof-of-firing: column present, CHECK absent → verifyAddenda FAILs on the missing CHECK, not the column');
    } else {
      fail('T5d', 'proof-of-firing: column present, CHECK absent → verifyAddenda FAILs on the missing CHECK, not the column', `missingColumns=${JSON.stringify(v.missingColumns)} missingChecks=${JSON.stringify(v.missingChecks)}`);
    }
    await client.query('ALTER TABLE assertions DROP COLUMN IF EXISTS carryover_status');
    await addenda.applySqlFile(client, findFile('migrate-06-carryover-status.sql')); // heal

    // (e) DELETE the vllm-local seed row → verifyAddenda FAILs, naming it.
    await client.query(`DELETE FROM embedding_providers WHERE name = 'vllm-local'`);
    v = await addenda.verifyAddenda(client, sqlFiles);
    const seedMissing = v.failedSeeds.some((s) => s.table === 'embedding_providers' && /missing/.test(s.reason || ''));
    if (v.pass === false && seedMissing) {
      pass('T5e', 'proof-of-firing: DELETE seed row → verifyAddenda FAILs, naming it');
    } else {
      fail('T5e', 'proof-of-firing: DELETE seed row → verifyAddenda FAILs, naming it', JSON.stringify(v.failedSeeds));
    }
    await addenda.applySqlFile(client, findFile('embedding-providers-base.sql')); // heal (re-INSERTs)

    // (f) UPDATE the seed row to divergent values → verifyAddenda FAILs.
    await client.query(`UPDATE embedding_providers SET native_dims = 9999 WHERE name = 'vllm-local'`);
    v = await addenda.verifyAddenda(client, sqlFiles);
    const seedDivergent = v.failedSeeds.some((s) => s.table === 'embedding_providers' && /divergent/.test(s.reason || ''));
    if (v.pass === false && seedDivergent) {
      pass('T5f', 'proof-of-firing: UPDATE seed row to divergent values → verifyAddenda FAILs (ON CONFLICT DO NOTHING never heals this)');
    } else {
      fail('T5f', 'proof-of-firing: UPDATE seed row to divergent values → verifyAddenda FAILs', JSON.stringify(v.failedSeeds));
    }
    await client.query(`UPDATE embedding_providers SET native_dims = 4096 WHERE name = 'vllm-local'`); // heal (manual — matches header note)

    // (h) [cm#208 S-5 T5h] DROP the standalone unique index and recreate it,
    // SAME NAME, as a PLAIN (non-unique) index -- a live proof that the
    // unique-flag symmetric check (S-4/F-4) actually fires end-to-end
    // against a real catalog, not just the T7 unit-level fixtures.
    // CREATE UNIQUE INDEX IF NOT EXISTS never fires this perturbation on its
    // own (F-6: IF NOT EXISTS keys on the NAME, not the definition) -- it
    // only reaches the live catalog via an explicit DROP first.
    await client.query('DROP INDEX IF EXISTS embedding_providers_is_default_unique_idx');
    await client.query('CREATE INDEX embedding_providers_is_default_unique_idx ON embedding_providers (is_default) WHERE is_default');
    v = await addenda.verifyAddenda(client, sqlFiles);
    const uniqueMismatch = v.malformedIndexes.find(
      (i) => i.name === 'embedding_providers_is_default_unique_idx' && /unique mismatch/i.test(i.reason || '')
    );
    if (v.pass === false && uniqueMismatch) {
      pass('T5h', 'proof-of-firing: standalone unique index recreated non-unique under the same name → verifyAddenda FAILs with a unique-mismatch malformedIndexes entry (cm#208 F-4/S-4)');
    } else {
      fail('T5h', 'proof-of-firing: standalone unique index recreated non-unique under the same name → verifyAddenda FAILs with a unique-mismatch malformedIndexes entry', JSON.stringify(v.malformedIndexes));
    }
    // Heal per F-6: re-applying embedding-providers-base.sql alone would be
    // a silent no-op against the same-named impostor (IF NOT EXISTS keys on
    // the name) -- an explicit DROP INDEX is required FIRST, then re-apply.
    await client.query('DROP INDEX IF EXISTS embedding_providers_is_default_unique_idx');
    await addenda.applySqlFile(client, findFile('embedding-providers-base.sql'));

    // Final sanity: fully healed state re-passes.
    v = await addenda.verifyAddenda(client, sqlFiles);
    if (v.pass) {
      pass('T5g', 'proof-of-firing: fully healed state re-verifies clean');
    } else {
      fail('T5g', 'proof-of-firing: fully healed state re-verifies clean', JSON.stringify(v));
    }
  } finally {
    await client.end();
  }
}

// ── T6: SQL-text invariants (no live DB needed) ───────────────────────────────

function testSqlTextInvariants() {
  const texts = addenda.SQL_FILES.map((f) => ({ file: f, clean: addenda.stripSqlNoise(fs.readFileSync(f, 'utf8')) }));
  const combined = texts.map((t) => t.clean).join('\n');

  // No INSERT INTO model_registry anywhere.
  if (!/INSERT\s+INTO\s+model_registry/i.test(combined)) {
    pass('T6a', 'no INSERT INTO model_registry in any of the six files (no-seed invariant)');
  } else {
    fail('T6a', 'no INSERT INTO model_registry in any of the six files (no-seed invariant)', 'found a match');
  }

  // The only INSERT anywhere is embedding_providers' seed.
  const insertMatches = combined.match(/INSERT\s+INTO\s+"?([a-zA-Z_][a-zA-Z0-9_]*)"?/gi) || [];
  const insertTables = insertMatches.map((m) => /INSERT\s+INTO\s+"?([a-zA-Z_][a-zA-Z0-9_]*)"?/i.exec(m)[1].toLowerCase());
  if (insertTables.length === 1 && insertTables[0] === 'embedding_providers') {
    pass('T6b', 'the only INSERT anywhere across the six files targets embedding_providers');
  } else {
    fail('T6b', 'the only INSERT anywhere across the six files targets embedding_providers', JSON.stringify(insertTables));
  }

  // Every CREATE TABLE uses IF NOT EXISTS.
  const bareCreateTable = /CREATE\s+TABLE\s+(?!IF\s+NOT\s+EXISTS\b)/i.test(combined);
  if (!bareCreateTable) {
    pass('T6c', 'every CREATE TABLE uses IF NOT EXISTS');
  } else {
    fail('T6c', 'every CREATE TABLE uses IF NOT EXISTS', 'found a CREATE TABLE without IF NOT EXISTS');
  }

  // Every ADD COLUMN uses IF NOT EXISTS.
  const bareAddColumn = /ADD\s+COLUMN\s+(?!IF\s+NOT\s+EXISTS\b)/i.test(combined);
  if (!bareAddColumn) {
    pass('T6d', 'every ADD COLUMN uses IF NOT EXISTS');
  } else {
    fail('T6d', 'every ADD COLUMN uses IF NOT EXISTS', 'found an ADD COLUMN without IF NOT EXISTS');
  }

  // No DROP statement appears in any of the six files.
  if (!/\bDROP\b/i.test(combined)) {
    pass('T6e', 'no DROP statement appears in any of the six files');
  } else {
    fail('T6e', 'no DROP statement appears in any of the six files', 'found a DROP token');
  }

  // No ALTER statement adds a CHECK to a pre-existing column — every
  // ADD ... CHECK is attached to a column the same ALTER statement creates
  // (A-10): i.e. every ALTER-TABLE statement containing CHECK also contains
  // ADD COLUMN IF NOT EXISTS.
  let a10Ok = true;
  const a10Violations = [];
  for (const { file, clean } of texts) {
    const statements = clean.split(';').map((s) => s.trim()).filter(Boolean);
    for (const stmt of statements) {
      if (/^ALTER\s+TABLE\b/i.test(stmt) && /CHECK/i.test(stmt)) {
        if (!/ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS/i.test(stmt)) {
          a10Ok = false;
          a10Violations.push({ file, stmt });
        }
      }
    }
  }
  if (a10Ok) {
    pass('T6f', 'every ALTER-statement CHECK is attached to a column the same statement creates (A-10)');
  } else {
    fail('T6f', 'every ALTER-statement CHECK is attached to a column the same statement creates (A-10)', JSON.stringify(a10Violations));
  }
}

// ── T7: derivation helper unit cases ──────────────────────────────────────────

function testDerivationUnitCases() {
  const tmpFile = path.join(os.tmpdir(), `msa-derive-unit-${TS}.sql`);
  const synthetic = `
-- a leading line comment, should be stripped
/* a block
   comment, should also be stripped */
CREATE TABLE IF NOT EXISTS "synth_table" (
  id SERIAL PRIMARY KEY,
  "quoted_col" TEXT NOT NULL UNIQUE,
  tier TEXT CHECK (tier IN ('a','b','c')),
  amount NUMERIC(8,2),
  flag BOOLEAN NOT NULL DEFAULT false,
  UNIQUE (id, tier)
);
CREATE INDEX IF NOT EXISTS synth_idx ON synth_table (tier) WHERE tier = 'a';
ALTER TABLE synth_table ADD COLUMN IF NOT EXISTS extra1 TEXT;
ALTER TABLE synth_table ADD COLUMN IF NOT EXISTS extra2 INTEGER CHECK (extra2 > 0);
	create\tUNIQUE   index  if  not  exists  synth_flag_unique_idx
  on synth_table
\t(flag) -- interleaved comment before a partial, bare-boolean WHERE
  WHERE flag;
CREATE INDEX IF NOT EXISTS synth_trgm_idx ON synth_table USING gin(tier gin_trgm_ops);
`;
  fs.writeFileSync(tmpFile, synthetic, 'utf8');

  try {
    const d = addenda.deriveSchemaAddenda([tmpFile]);

    // Multiple ALTERs for the same table + CREATE TABLE body extraction (A-1).
    const colNames = d.columns.filter((c) => c.table === 'synth_table').map((c) => c.column).sort();
    const expectedCols = ['amount', 'extra1', 'extra2', 'flag', 'id', 'quoted_col', 'tier'].sort();
    if (JSON.stringify(colNames) === JSON.stringify(expectedCols)) {
      pass('T7a', 'derivation: CREATE TABLE body + multiple ALTERs on the same table all captured (A-1)');
    } else {
      fail('T7a', 'derivation: CREATE TABLE body + multiple ALTERs on the same table all captured (A-1)', JSON.stringify(colNames));
    }

    // Quoted identifiers stripped to plain names.
    const quotedColEntry = d.columns.find((c) => c.table === 'synth_table' && c.column === 'quoted_col');
    if (quotedColEntry) {
      pass('T7b', 'derivation: quoted identifiers ("quoted_col") normalized to plain column names');
    } else {
      fail('T7b', 'derivation: quoted identifiers ("quoted_col") normalized to plain column names', 'quoted_col not found');
    }

    // Type-token capture (A-5), including a precision/scale type.
    const amountCol = d.columns.find((c) => c.table === 'synth_table' && c.column === 'amount');
    const idCol = d.columns.find((c) => c.table === 'synth_table' && c.column === 'id');
    if (amountCol && amountCol.typeToken === 'NUMERIC' && idCol && idCol.typeToken === 'SERIAL') {
      pass('T7c', 'derivation: type-token capture, including precision/scale types (A-5)');
    } else {
      fail('T7c', 'derivation: type-token capture, including precision/scale types (A-5)', JSON.stringify({ amountCol, idCol }));
    }

    // CHECK extraction from both forms (A-2): CREATE-TABLE-inline and ALTER.
    const tierCheck = d.checks.find((c) => c.table === 'synth_table' && c.column === 'tier');
    const extra2Check = d.checks.find((c) => c.table === 'synth_table' && c.column === 'extra2');
    if (tierCheck && JSON.stringify(tierCheck.literals) === JSON.stringify(['a', 'b', 'c']) && extra2Check) {
      pass('T7d', 'derivation: CHECK extraction from both CREATE-TABLE-inline and ALTER forms (A-2)');
    } else {
      fail('T7d', 'derivation: CHECK extraction from both CREATE-TABLE-inline and ALTER forms (A-2)', JSON.stringify({ tierCheck, extra2Check }));
    }

    // Index + UNIQUE extraction (A-3), including inline single-column UNIQUE
    // and a table-level multi-column UNIQUE, and a partial-index WHERE flag.
    const idx = d.indexes.find((i) => i.name === 'synth_idx');
    const inlineUnique = d.uniques.find((u) => u.table === 'synth_table' && JSON.stringify(u.columns) === JSON.stringify(['quoted_col']));
    const tableUnique = d.uniques.find((u) => u.table === 'synth_table' && JSON.stringify(u.columns) === JSON.stringify(['id', 'tier']));
    if (idx && idx.hasWhere === true && inlineUnique && tableUnique) {
      pass('T7e', 'derivation: index + UNIQUE extraction, inline-column and table-level forms, partial-index WHERE flag (A-3)');
    } else {
      fail('T7e', 'derivation: index + UNIQUE extraction, inline-column and table-level forms, partial-index WHERE flag (A-3)', JSON.stringify({ idx, inlineUnique, tableUnique }));
    }

    // Comment noise (reuse stripSqlNoise): the synthetic file's leading
    // line + block comments must not have leaked into any derived name.
    const anyLeakedCommentText = [...d.columns, ...d.checks, ...d.indexes, ...d.uniques]
      .some((o) => JSON.stringify(o).toLowerCase().includes('comment'));
    if (!anyLeakedCommentText) {
      pass('T7f', 'derivation: comment noise stripped before scanning (reuses migrate-01\'s stripSqlNoise)');
    } else {
      fail('T7f', 'derivation: comment noise stripped before scanning (reuses migrate-01\'s stripSqlNoise)', 'comment text leaked into a derived object');
    }

    // cm#208 S-5 positive fixtures: a standalone CREATE UNIQUE INDEX (mixed
    // keyword case, a literal tab, an interleaved -- comment, and a partial
    // bare-boolean WHERE) plus a USING gin index with no space before "(" and
    // an opclass. Assert both derived tuples exactly.
    const flagUniqueIdx = d.indexes.find((i) => i.name === 'synth_flag_unique_idx');
    const expectedFlagUniqueIdx = { name: 'synth_flag_unique_idx', table: 'synth_table', columns: ['flag'], method: 'btree', hasWhere: true, unique: true };
    if (flagUniqueIdx && JSON.stringify(flagUniqueIdx) === JSON.stringify(expectedFlagUniqueIdx)) {
      pass('T7h', 'derivation: standalone CREATE UNIQUE INDEX (mixed case, tab, interleaved comment, bare-boolean WHERE) derived exactly (cm#208 S-1/S-2)');
    } else {
      fail('T7h', 'derivation: standalone CREATE UNIQUE INDEX (mixed case, tab, interleaved comment, bare-boolean WHERE) derived exactly (cm#208 S-1/S-2)', JSON.stringify(flagUniqueIdx));
    }

    const trgmIdx = d.indexes.find((i) => i.name === 'synth_trgm_idx');
    const expectedTrgmIdx = { name: 'synth_trgm_idx', table: 'synth_table', columns: ['tier'], method: 'gin', hasWhere: false, unique: false };
    if (trgmIdx && JSON.stringify(trgmIdx) === JSON.stringify(expectedTrgmIdx)) {
      pass('T7i', 'derivation: USING gin(col opclass) with no space before "(" derived exactly, opclass remainder unverified (cm#208 F-1/F-9)');
    } else {
      fail('T7i', 'derivation: USING gin(col opclass) with no space before "(" derived exactly, opclass remainder unverified (cm#208 F-1/F-9)', JSON.stringify(trgmIdx));
    }
  } finally {
    fs.unlinkSync(tmpFile);
  }

  // cm#208 S-5 negative (loud) cases: each shape below is CREATE-INDEX-shaped
  // but NOT recognized by the grammar, so deriveSchemaAddenda must throw a
  // DerivationError naming the tempfile and the offending statement -- never
  // silently skip it (S-3's total-classification loud default branch).
  const negativeCases = [
    { id: 'T7j', label: 'no IF NOT EXISTS -> DerivationError, never silently skipped', sql: 'CREATE UNIQUE INDEX x ON t (a);' },
    { id: 'T7k', label: 'CONCURRENTLY -> DerivationError, never silently skipped', sql: 'CREATE INDEX CONCURRENTLY IF NOT EXISTS x ON t (a);' },
    { id: 'T7l', label: 'schema-qualified table name -> DerivationError, never silently skipped', sql: 'CREATE INDEX IF NOT EXISTS x ON public.t (a);' },
    { id: 'T7m', label: 'expression index (nested parens defeat [^()]*) -> DerivationError, never silently skipped', sql: 'CREATE INDEX IF NOT EXISTS x ON t ((lower(a)));' },
    { id: 'T7n', label: 'NULLS NOT DISTINCT trailer -> DerivationError, never silently skipped', sql: 'CREATE UNIQUE INDEX IF NOT EXISTS x ON t (a) NULLS NOT DISTINCT;' },
    { id: 'T7o', label: 'quoted identifier containing an uppercase letter -> DerivationError, never silently skipped (F-8)', sql: 'CREATE UNIQUE INDEX IF NOT EXISTS "MyIdx" ON t (a);' },
  ];
  for (const { id, label, sql } of negativeCases) {
    const negFile = path.join(os.tmpdir(), `msa-derive-neg-${id}-${TS}.sql`);
    fs.writeFileSync(negFile, sql, 'utf8');
    try {
      let threw = null;
      try {
        addenda.deriveSchemaAddenda([negFile]);
      } catch (err) {
        threw = err;
      }
      const ok = threw instanceof addenda.DerivationError &&
        threw.derivationErrors.some((e) => e.file === negFile && e.statement.includes(sql.replace(/;\s*$/, '')));
      if (ok) {
        pass(id, `derivation total classification: ${label}`);
      } else {
        fail(id, `derivation total classification: ${label}`, threw ? `wrong error: ${threw.name}: ${threw.message}` : 'did not throw');
      }
    } finally {
      fs.unlinkSync(negFile);
    }
  }

  // cm#208 F-3 non-firing case: a DO-block fragment that CONTAINS "CREATE
  // INDEX" but does not BEGIN with it (the fragment starts with "DO $$
  // BEGIN") must NOT throw and must NOT be derived -- DO-wrapped index DDL
  // stays out of derivation reach by documented design (same as migrate-14's
  // DO-block sidecar file).
  {
    const doFile = path.join(os.tmpdir(), `msa-derive-doblock-${TS}.sql`);
    fs.writeFileSync(doFile, 'DO $$ BEGIN CREATE INDEX IF NOT EXISTS d ON t (a); END $$;', 'utf8');
    try {
      const d2 = addenda.deriveSchemaAddenda([doFile]);
      if (d2.indexes.length === 0) {
        pass('T7p', 'derivation: DO-block fragment containing but not starting with CREATE INDEX does NOT throw and is NOT derived (cm#208 F-3)');
      } else {
        fail('T7p', 'derivation: DO-block fragment containing but not starting with CREATE INDEX does NOT throw and is NOT derived (cm#208 F-3)', JSON.stringify(d2.indexes));
      }
    } catch (err) {
      fail('T7p', 'derivation: DO-block fragment containing but not starting with CREATE INDEX does NOT throw and is NOT derived (cm#208 F-3)', `unexpectedly threw: ${err.message}`);
    } finally {
      fs.unlinkSync(doFile);
    }
  }

  // Exact expected sets for the shipped files (computed once, pinned here).
  const shipped = addenda.deriveSchemaAddenda(addenda.SQL_FILES);
  const shippedTables = [...migrateOne.deriveExpectedObjects(addenda.SQL_FILES).tables].sort();
  const expectedShippedTables = ['embedding_providers', 'model_registry', 'routing_profiles', 'routing_session_overrides', 'session_usage', 'turn_usage'];
  const tablesOk = JSON.stringify(shippedTables) === JSON.stringify(expectedShippedTables);
  const countsOk = shipped.columns.length === 82 &&
    shipped.checks.length === 5 &&
    shipped.indexes.length === 6 &&
    shipped.uniques.length === 6 &&
    shipped.seeds.length === 1;
  if (tablesOk && countsOk) {
    pass('T7g', 'derivation yields exactly the expected sets for the shipped six files (6 tables, 82 columns, 5 CHECKs, 6 indexes, 6 UNIQUEs, 1 seed)');
  } else {
    fail('T7g', 'derivation yields exactly the expected sets for the shipped six files', `tables=${JSON.stringify(shippedTables)} columns=${shipped.columns.length} checks=${shipped.checks.length} indexes=${shipped.indexes.length} uniques=${shipped.uniques.length} seeds=${shipped.seeds.length}`);
  }

  // cm#208 F-7 repin: the pinned COUNT alone is flag-blind (an author could
  // bump 5->6 while still recording unique:false and this count-only check
  // would still pass). Pin the exact derived tuple for the one shipped
  // standalone unique index AND that exactly one derived index has
  // unique===true AND that uniques.length (constraint-shaped, F-5) stays 6
  // unchanged -- a regression that misroutes the unique index into
  // `uniques` instead of `indexes` must fail this, not just T7g's count.
  const uniqueFlaggedIndexes = shipped.indexes.filter((i) => i.unique === true);
  const expectedProviderIdx = {
    name: 'embedding_providers_is_default_unique_idx',
    table: 'embedding_providers',
    columns: ['is_default'],
    method: 'btree',
    hasWhere: true,
    unique: true,
  };
  const providerIdxOk = uniqueFlaggedIndexes.length === 1 &&
    JSON.stringify(uniqueFlaggedIndexes[0]) === JSON.stringify(expectedProviderIdx) &&
    shipped.uniques.length === 6;
  if (providerIdxOk) {
    pass('T7q', 'cm#208 F-7 repin: exactly one derived index has unique===true, deep-equal to the exact embedding_providers_is_default_unique_idx tuple, uniques.length unchanged at 6 (F-5 misrouting guard)');
  } else {
    fail('T7q', 'cm#208 F-7 repin: exactly one derived index has unique===true, deep-equal to the exact embedding_providers_is_default_unique_idx tuple, uniques.length unchanged at 6 (F-5 misrouting guard)', `uniqueFlaggedIndexes=${JSON.stringify(uniqueFlaggedIndexes)} uniques.length=${shipped.uniques.length}`);
  }
}

// ── T8: mid-sequence failure + heal ────────────────────────────────────────────

async function testMidSequenceFailureAndHeal() {
  const setup = runMigrateOne(['--db', DB_MIDSEQ]);
  if (setup.status !== 0) {
    fail('T8', 'mid-sequence failure + heal', `migrate-01 fixture setup failed: ${setup.stderr}`);
    return;
  }

  const client = await pgConnect(DB_MIDSEQ);
  try {
    // Obstruction: a stub routing_profiles missing the columns migrate-10's
    // CREATE INDEX statement references. CREATE TABLE IF NOT EXISTS will
    // silently no-op against the stub, but the subsequent CREATE INDEX
    // IF NOT EXISTS routing_profiles_project_idx ON routing_profiles
    // (project_id, role) WHERE active = true genuinely errors (referenced
    // columns do not exist) — a real apply failure, not a silent no-op.
    await client.query('CREATE TABLE routing_profiles (id SERIAL PRIMARY KEY)');
  } finally {
    await client.end();
  }

  const r1 = runAddenda(['--db', DB_MIDSEQ]);
  const hasFailLine = /\[FAIL\]\s+migrations[\\/]sql[\\/]migrate-10-routing-harness\.sql/.test(r1.stdout);
  const overallFail = /MIGRATION_RESULT: FAIL/.test(r1.stdout);
  if (r1.status === 1 && hasFailLine && overallFail) {
    pass('T8a', 'mid-sequence failure: forced apply error on one file → per-file [FAIL] line + MIGRATION_RESULT: FAIL + exit 1');
  } else {
    fail('T8a', 'mid-sequence failure: forced apply error on one file → per-file [FAIL] line + MIGRATION_RESULT: FAIL + exit 1', `status=${r1.status} stdout=${r1.stdout}`);
    // Best-effort cleanup even on failure so later suites are not blocked.
  }

  // Remove the obstruction; re-run; assert PASS (idempotent heal).
  const client2 = await pgConnect(DB_MIDSEQ);
  try {
    await client2.query('DROP TABLE IF EXISTS routing_profiles CASCADE');
  } finally {
    await client2.end();
  }

  const r2 = runAddenda(['--db', DB_MIDSEQ]);
  if (r2.status === 0 && /MIGRATION_RESULT: PASS/.test(r2.stdout)) {
    pass('T8b', 'mid-sequence failure: removing the obstruction and re-running → PASS (idempotent heal)');
  } else {
    fail('T8b', 'mid-sequence failure: removing the obstruction and re-running → PASS (idempotent heal)', `status=${r2.status} stdout=${r2.stdout} stderr=${r2.stderr}`);
  }
}

// ── Main ───────────────────────────────────────────────────────────────────────

async function main() {
  try {
    await testPrereqTableMissing();
    await testDbNeverCreated();
    await testFreshApply();
    await testIdempotentSecondRun();
    await testRefusedTargetNames();
    await testProofOfFiring();
    testSqlTextInvariants();
    testDerivationUnitCases();
    await testMidSequenceFailureAndHeal();
  } finally {
    for (const db of CREATED_DBS) {
      await dropDb(db);
    }
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exitCode = 1;
});
