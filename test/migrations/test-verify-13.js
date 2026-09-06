'use strict';

/**
 * test-verify-13.js — Test harness for scripts/migrations/migrate-13-agent-
 * exchange.js (the agent_exchange + audit_log/log_guarded_change() schema
 * migration) and scripts/migrations/verify-13-exchange-smoke.js (its
 * 7-check operator smoke test).
 *
 * Mirrors test-verify-18.js's conventions: self-contained scratch databases
 * (all named to satisfy migrate-01's own classifyTarget — reused by
 * reference, never a second classifier), unconditional finally-block
 * cleanup, never touches claude_memory_eval_test / pipeline_-prefixed
 * databases / memory_manager_staging beyond a refusal-branch assertion that
 * exits before any connection is opened.
 *
 * Five groups:
 *   A. Subprocess tests of migrate-13-agent-exchange.js itself (fresh apply
 *      PASS, idempotent second run, prerequisite-missing refusal naming
 *      migrate-01-canonical-db.js, refused target names).
 *   B. Subprocess tests of verify-13-exchange-smoke.js (fresh-schema smoke
 *      run PASS with all 7 checks, prerequisite-missing refusal naming
 *      migrate-13-agent-exchange.js, refused target names).
 *   C. Verification proof-of-firing: direct calls to the exported
 *      verifyMigration13 against a deliberately-perturbed live client
 *      (drop trigger, drop function, stub function body, drop HNSW index
 *      on a pgvector-present target) — mirrors migrate-01's own
 *      testProofOfFiringMissingTable pattern (going through the CLI would
 *      silently heal the perturbation before verification ever saw it).
 *   D. Conditional FK (ADVERSARY-PASS C-1), all four reachable states:
 *      deferred (tasks absent), validated (tasks present, no orphans),
 *      added-not-validated (tasks present, orphan docket_id rows present).
 *   E. Direct-SQL invariants: audit-trigger firing on assertions (an
 *      ordinary UPDATE produces an audit_log row), the B-3 negative case
 *      (audit_log_audit must never exist), and static SQL/JS-text
 *      invariants — the privacy-scrub floor (E-2: case-insensitive
 *      substring scan for 'judge'/'claudecode'/'pipeline_architect' across
 *      every file this PR adds or modifies), no DROP TABLE anywhere in the
 *      shipped SQL, and CREATE TABLE ... IF NOT EXISTS discipline.
 *
 * Requires Postgres at PGHOST/PGUSER/PGPASSWORD (CI env) or
 * localhost/postgres, with pgvector available (migrate-01's schema files
 * depend on it; this suite's pgvector-present branch assumes it is
 * installed, matching every other migrations test in this repo).
 *
 * Usage: node test/migrations/test-verify-13.js
 * Exit 0 = all pass; nonzero = any failure.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { createRequire } = require('module');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const MIGRATE_ONE_PATH = path.join(PROJECT_ROOT, 'scripts', 'migrations', 'migrate-01-canonical-db.js');
const ADDENDA_PATH = path.join(PROJECT_ROOT, 'scripts', 'migrations', 'migrate-schema-addenda.js');
const MIGRATE13_PATH = path.join(PROJECT_ROOT, 'scripts', 'migrations', 'migrate-13-agent-exchange.js');
const SMOKE13_PATH = path.join(PROJECT_ROOT, 'scripts', 'migrations', 'verify-13-exchange-smoke.js');
const MIGRATE13_SQL_PATH = path.join(PROJECT_ROOT, 'scripts', 'migrations', 'sql', 'migrate-13-agent-exchange.sql');

const migrateOne = require(MIGRATE_ONE_PATH);
const migrate13 = require(MIGRATE13_PATH);

// scripts/ has its own node_modules (pg, etc.) — this test lives under
// test/, outside that tree, so resolve 'pg' the same way the sibling
// migrations test harnesses do: via a require() rooted at
// scripts/package.json.
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

async function run(id, label, fn) {
  try {
    await fn();
    pass(id, label);
  } catch (err) {
    fail(id, label, err && err.message ? err.message : String(err));
  }
}

// ── Assertion helpers ─────────────────────────────────────────────────────

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function assertEq(actual, expected, msg) {
  if (actual !== expected) {
    throw new Error(`${msg || 'assertion failed'} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
  }
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

function runMigrateOne(args, extraEnv = {}, timeoutMs = 30000) {
  return spawnSync(process.execPath, [MIGRATE_ONE_PATH, ...args], {
    cwd: PROJECT_ROOT,
    env: { ...process.env, ...extraEnv },
    encoding: 'utf8',
    timeout: timeoutMs,
  });
}

function runAddenda(args, extraEnv = {}, timeoutMs = 20000) {
  return spawnSync(process.execPath, [ADDENDA_PATH, ...args], {
    cwd: PROJECT_ROOT,
    env: { ...process.env, ...extraEnv },
    encoding: 'utf8',
    timeout: timeoutMs,
  });
}

function runMigrate13(args, extraEnv = {}, timeoutMs = 20000) {
  return spawnSync(process.execPath, [MIGRATE13_PATH, ...args], {
    cwd: PROJECT_ROOT,
    env: { ...process.env, ...extraEnv },
    encoding: 'utf8',
    timeout: timeoutMs,
  });
}

function runSmoke13(args, extraEnv = {}, timeoutMs = 30000) {
  return spawnSync(process.execPath, [SMOKE13_PATH, ...args], {
    cwd: PROJECT_ROOT,
    env: { ...process.env, ...extraEnv },
    encoding: 'utf8',
    timeout: timeoutMs,
  });
}

async function setupCoreSchema(dbName) {
  const r1 = runMigrateOne(['--db', dbName]);
  if (r1.status !== 0) throw new Error(`migrate-01 fixture setup failed for ${dbName}: status=${r1.status} stderr=${r1.stderr}`);
  const r2 = runAddenda(['--db', dbName]);
  if (r2.status !== 0) throw new Error(`schema-addenda fixture setup failed for ${dbName}: status=${r2.status} stderr=${r2.stderr}`);
}

async function setupFullSchema(dbName) {
  await setupCoreSchema(dbName);
  const r3 = runMigrate13(['--db', dbName]);
  if (r3.status !== 0) throw new Error(`migrate-13 fixture setup failed for ${dbName}: status=${r3.status} stdout=${r3.stdout} stderr=${r3.stderr}`);
}

// Scratch DB names — all satisfy classifyTarget's allowed pattern (end in "_staging").
const DB_MAIN = `verify13_main_${TS}_staging`;
const DB_PREREQ = `verify13_prereq_${TS}_staging`;
const DB_SMOKE_PREREQ = `verify13_smokeprereq_${TS}_staging`;
const DB_FK = `verify13_fk_${TS}_staging`;
const DB_ORPHAN = `verify13_orphan_${TS}_staging`;
const CREATED_DBS = [DB_MAIN, DB_PREREQ, DB_SMOKE_PREREQ, DB_FK, DB_ORPHAN];

// ── Group A: migrate-13-agent-exchange.js subprocess tests ──────────────────

async function testMigrate13FreshApply() {
  await setupCoreSchema(DB_MAIN);
  const r = runMigrate13(['--db', DB_MAIN]);
  assert(r.status === 0, `expected exit 0, got ${r.status}. stdout=${r.stdout} stderr=${r.stderr}`);
  assert(/MIGRATION_RESULT: PASS/.test(r.stdout), `expected the PASS summary line. stdout=${r.stdout}`);
  assert(/agent_exchange_docket_fk: deferred/.test(r.stdout), `expected the FK to report deferred (tasks absent). stdout=${r.stdout}`);
}

async function testMigrate13Idempotent() {
  const r = runMigrate13(['--db', DB_MAIN]);
  assert(r.status === 0, `expected exit 0 on second run, got ${r.status}. stdout=${r.stdout} stderr=${r.stderr}`);
  assert(/MIGRATION_RESULT: PASS/.test(r.stdout), `expected PASS on idempotent second run. stdout=${r.stdout}`);
}

async function testMigrate13PrereqFail() {
  await setupCoreSchema(DB_PREREQ);
  const client = await pgConnect(DB_PREREQ);
  try {
    await client.query('DROP TABLE IF EXISTS assertions CASCADE');
  } finally {
    await client.end();
  }
  const r = runMigrate13(['--db', DB_PREREQ]);
  assert(r.status === 1, `expected exit 1, got ${r.status}. stdout=${r.stdout} stderr=${r.stderr}`);
  assert(/missing prerequisite table\(s\)/.test(r.stderr), `expected a prerequisite refusal. stderr=${r.stderr}`);
  assert(/assertions/.test(r.stderr), `expected the missing table named. stderr=${r.stderr}`);
  assert(/migrate-01-canonical-db\.js/.test(r.stderr), `expected migrate-01 named as the fix. stderr=${r.stderr}`);
}

async function testRefusedTargetNames(runFn, label) {
  const r1 = runFn(['--db', 'claude_memory_eval_test']);
  assert(r1.status === 1 && /claude_memory_eval_test/.test(r1.stderr) && /no database connection was opened/.test(r1.stderr),
    `${label}: expected refusal of claude_memory_eval_test before connecting. status=${r1.status} stderr=${r1.stderr}`);

  const r2 = runFn(['--db', 'pipeline_something']);
  assert(r2.status === 1 && /pipeline_/.test(r2.stderr),
    `${label}: expected refusal of pipeline_ names. status=${r2.status} stderr=${r2.stderr}`);

  // migration-target-per-project-marker (owner decision item G, 2026-09-06):
  // an unrecognized name now goes through migrate-01's marker probe; neither
  // caller here ever passes --project-id, so the probe's "absent"
  // precondition is the reason that actually surfaces (still pre-connect).
  const r3 = runFn(['--db', `verify13_unrecognized_${TS}_scratch`]);
  assert(r3.status === 1 &&
    /no --project-id supplied; per-project engine targets require it/.test(r3.stderr) &&
    /no database connection was opened/.test(r3.stderr),
    `${label}: expected refusal of an unrecognized name (total-classification default branch). status=${r3.status} stderr=${r3.stderr}`);
}

// ── Group B: verify-13-exchange-smoke.js subprocess tests ───────────────────

async function testSmoke13FreshPass() {
  const r = runSmoke13(['--db', DB_MAIN]);
  assert(r.status === 0, `expected exit 0, got ${r.status}. stdout=${r.stdout} stderr=${r.stderr}`);
  assert(/SMOKE13_RESULT: PASS/.test(r.stdout), `expected the PASS summary line. stdout=${r.stdout}`);
  for (const n of [1, 2, 3, 4, 5, 6, 7]) {
    assert(new RegExp(`\\[SMOKE-13\\]\\[${n}\\] PASS`).test(r.stdout), `expected check ${n} to print a PASS line. stdout=${r.stdout}`);
  }
}

async function testSmoke13PrereqFail() {
  await setupFullSchema(DB_SMOKE_PREREQ);
  const client = await pgConnect(DB_SMOKE_PREREQ);
  try {
    await client.query('DROP TABLE IF EXISTS agent_exchange CASCADE');
  } finally {
    await client.end();
  }
  const r = runSmoke13(['--db', DB_SMOKE_PREREQ]);
  assert(r.status === 1, `expected exit 1, got ${r.status}. stdout=${r.stdout} stderr=${r.stderr}`);
  assert(/missing prerequisite table\(s\)/.test(r.stderr), `expected a prerequisite refusal. stderr=${r.stderr}`);
  assert(/agent_exchange/.test(r.stderr), `expected the missing table named. stderr=${r.stderr}`);
  assert(/migrate-13-agent-exchange\.js/.test(r.stderr), `expected the migrate-13 runner named. stderr=${r.stderr}`);
  assert(/SMOKE13_RESULT: FAIL/.test(r.stdout), `expected the FAIL summary line. stdout=${r.stdout}`);
}

// ── Group C: verification proof-of-firing (direct calls, never via the
// healing CLI apply step) ────────────────────────────────────────────────

async function testProofOfFiringTriggerDropped(client) {
  await client.query('DROP TRIGGER agent_exchange_audit ON agent_exchange');
  const v = await migrate13.verifyMigration13(client, true);
  assert(v.pass === false, `expected verifyMigration13 to FAIL after dropping the trigger, got pass=${v.pass}`);
  assert(v.agentExchangeTriggerOk === false, 'expected agentExchangeTriggerOk=false');
  assertEq(v.agentExchangeEvents.length, 0, 'expected zero trigger events after the drop');
  // Heal.
  await migrateOne.applySqlFile(client, MIGRATE13_SQL_PATH);
  const healed = await migrate13.verifyMigration13(client, true);
  assert(healed.pass === true, 'expected PASS after healing via re-apply');
}

async function testProofOfFiringFunctionDropped(client) {
  await client.query('DROP FUNCTION log_guarded_change() CASCADE');
  const v = await migrate13.verifyMigration13(client, true);
  assert(v.pass === false, `expected verifyMigration13 to FAIL after dropping the function, got pass=${v.pass}`);
  assert(v.guardFn.exists === false, 'expected guardFn.exists=false');
  // Heal.
  await migrateOne.applySqlFile(client, MIGRATE13_SQL_PATH);
  const healed = await migrate13.verifyMigration13(client, true);
  assert(healed.pass === true, 'expected PASS after healing via re-apply');
}

async function testProofOfFiringFunctionStubbed(client) {
  // D-2: a stub replacement (function still exists, body no longer contains
  // both INSERT INTO audit_log branches) must FAIL on body content, not
  // just pass on name-only existence.
  await client.query(`CREATE OR REPLACE FUNCTION log_guarded_change() RETURNS TRIGGER AS $trig$ BEGIN RETURN NULL; END; $trig$ LANGUAGE plpgsql`);
  const v = await migrate13.verifyMigration13(client, true);
  assert(v.pass === false, `expected verifyMigration13 to FAIL after stubbing the function body, got pass=${v.pass}`);
  assert(v.guardFn.exists === true, 'expected guardFn.exists=true (the function is still present, just stubbed)');
  assert(v.guardFn.bodyOk === false, 'expected guardFn.bodyOk=false for the stubbed body');
  // Heal.
  await migrateOne.applySqlFile(client, MIGRATE13_SQL_PATH);
  const healed = await migrate13.verifyMigration13(client, true);
  assert(healed.pass === true, 'expected PASS after healing via re-apply');
}

async function testProofOfFiringHnswDropped(client) {
  const pgvectorPresent = await migrate13.checkPgvectorPresent(client);
  assert(pgvectorPresent, 'this proof-of-firing case requires a pgvector-present scratch DB (same posture as every other migrations test in this repo)');

  await client.query('DROP INDEX agent_exchange_embedding_idx');
  const v = await migrate13.verifyMigration13(client, true);
  assert(v.pass === false, `expected verifyMigration13 to FAIL after dropping the HNSW index on a pgvector-present target, got pass=${v.pass}`);
  assertEq(v.hnsw.status, 'FAIL', 'expected hnsw.status=FAIL');
  // Heal.
  await migrateOne.applySqlFile(client, MIGRATE13_SQL_PATH);
  const healed = await migrate13.verifyMigration13(client, true);
  assert(healed.pass === true, 'expected PASS after healing via re-apply');
}

// ── Group D: conditional FK, all four reachable states (ADVERSARY-PASS C-1) ─

async function testFkDeferredWhenTasksAbsent(client) {
  const v = await migrate13.verifyMigration13(client, true);
  assertEq(v.fk.state, 'deferred', `expected fk.state='deferred' on a target with no tasks table, got ${JSON.stringify(v.fk)}`);
}

async function testFkValidatedAfterTasksCreated() {
  await setupFullSchema(DB_FK); // tasks absent at this point -> deferred (asserted implicitly by fresh-apply passing)
  const client = await pgConnect(DB_FK);
  try {
    await client.query('CREATE TABLE tasks (id SERIAL PRIMARY KEY, title TEXT)');
  } finally {
    await client.end();
  }
  const r = runMigrate13(['--db', DB_FK]);
  assert(r.status === 0, `expected exit 0 on re-apply after tasks exists, got ${r.status}. stdout=${r.stdout} stderr=${r.stderr}`);
  assert(/agent_exchange_docket_fk: validated/.test(r.stdout), `expected the FK to report validated. stdout=${r.stdout}`);

  const client2 = await pgConnect(DB_FK);
  try {
    const { rows } = await client2.query(
      `SELECT convalidated FROM pg_constraint WHERE conname = 'agent_exchange_docket_fk'`
    );
    assertEq(rows.length, 1, 'expected the FK constraint to exist');
    assertEq(rows[0].convalidated, true, 'expected convalidated=true');
  } finally {
    await client2.end();
  }
}

async function testFkAddedNotValidatedWithOrphans() {
  await setupFullSchema(DB_ORPHAN); // tasks absent -> deferred
  const client = await pgConnect(DB_ORPHAN);
  try {
    await client.query(
      `INSERT INTO agent_exchange (project_id, docket_id, agent_id, kind, body_caveman)
       VALUES ('verify13-orphan-proj', 999999, 'verify13-orphan-agent', 'proposal', 'orphan docket_id row')`
    );
    await client.query('CREATE TABLE tasks (id SERIAL PRIMARY KEY, title TEXT)');
  } finally {
    await client.end();
  }
  const r = runMigrate13(['--db', DB_ORPHAN]);
  // Per ADVERSARY-PASS C-1, 'added-not-validated' is a loud REPORT, not a
  // failure state -- only 'tasks present, constraint absent after apply' is
  // the FK's own FAIL branch. Orphans degrade to a report; the file (and
  // MIGRATION_RESULT) still PASS.
  assert(r.status === 0, `expected exit 0 (added-not-validated is a reported state, not a failure), got ${r.status}. stdout=${r.stdout}`);
  assert(/MIGRATION_RESULT: PASS/.test(r.stdout), `expected MIGRATION_RESULT: PASS despite the orphan. stdout=${r.stdout}`);
  assert(/agent_exchange_docket_fk: added-not-validated/.test(r.stdout), `expected the FK to report added-not-validated. stdout=${r.stdout}`);

  const client2 = await pgConnect(DB_ORPHAN);
  try {
    const { rows } = await client2.query(
      `SELECT convalidated FROM pg_constraint WHERE conname = 'agent_exchange_docket_fk'`
    );
    assertEq(rows.length, 1, 'expected the FK constraint to exist (NOT VALID)');
    assertEq(rows[0].convalidated, false, 'expected convalidated=false with an orphan row present');
  } finally {
    await client2.end();
  }
}

// ── Group E: direct-SQL invariants ───────────────────────────────────────

async function testAuditTriggerFiresOnAssertions(client) {
  const { rows: insertRows } = await client.query(
    `INSERT INTO assertions (project_id, subject, predicate, object, confidence, source)
     VALUES ('verify13-audit-proj', 'verify13-audit-subject', 'is_status', 'before', 5, 'model_extracted')
     RETURNING id`
  );
  const assertionId = insertRows[0].id;
  await client.query(`UPDATE assertions SET object = 'after' WHERE id = $1`, [assertionId]);

  const { rows: auditRows } = await client.query(
    `SELECT operation, old_row, new_row FROM audit_log
      WHERE table_name = 'assertions' AND operation = 'UPDATE' AND row_id = $1
      ORDER BY id DESC LIMIT 1`,
    [assertionId]
  );
  assertEq(auditRows.length, 1, 'expected exactly one audit_log row for the ordinary assertions UPDATE (sanctioned mutations are captured too, by design)');
  assertEq(auditRows[0].old_row.object, 'before', 'old_row must capture the pre-UPDATE value');
  assertEq(auditRows[0].new_row.object, 'after', 'new_row must capture the post-UPDATE value');
}

async function testAuditLogNeverSelfWired(client) {
  // B-3: a negative test guarding against a future derived-wiring refactor
  // self-wiring the audit table onto itself.
  const { rows } = await client.query(`SELECT 1 FROM pg_trigger WHERE tgname = 'audit_log_audit'`);
  assertEq(rows.length, 0, 'audit_log_audit trigger must never exist');
}

// Files this PR adds or modifies -- the privacy-scrub floor (E-2) scans
// every one of them. This list is deliberately explicit and repo-relative
// (not derived from `git diff`, which would make the test's own behavior
// depend on working-tree/branch state at run time). This test file itself
// (test/migrations/test-verify-13.js) is deliberately EXCLUDED: it must
// name the forbidden substrings literally to define FORBIDDEN_SUBSTRING_
// PATTERNS below, which would otherwise make the detector fail on its own
// definition -- a self-reference, not a leak. The human pre-commit diff
// scan (mandatory, not replaced by this automated floor -- see E-2) still
// covers this file for genuine provenance-framing leaks.
const PR_FILES = [
  'scripts/migrations/sql/migrate-13-agent-exchange.sql',
  'scripts/migrations/migrate-13-agent-exchange.js',
  'scripts/migrations/verify-13-exchange-smoke.js',
  'scripts/lib/agent-provider.js',
  'scripts/lib/embedding-provider.js',
  'docs/agent-interop.md',
];

const FORBIDDEN_SUBSTRING_PATTERNS = [/judge/i, /claudecode/i, /pipeline_architect/i];

function testPrivacyScrubFloor() {
  const offenders = [];
  for (const rel of PR_FILES) {
    const abs = path.join(PROJECT_ROOT, rel);
    if (!fs.existsSync(abs)) continue; // some files (e.g. docs) may not exist yet at author time; CI runs post-write
    const content = fs.readFileSync(abs, 'utf8');
    for (const re of FORBIDDEN_SUBSTRING_PATTERNS) {
      if (re.test(content)) offenders.push(`${rel}: matched ${re}`);
    }
  }
  assertEq(offenders.length, 0, `privacy-scrub floor violated: ${offenders.join('; ')}`);
}

function testNoDropTableInShippedSql() {
  const raw = fs.readFileSync(MIGRATE13_SQL_PATH, 'utf8');
  const clean = migrateOne.stripSqlNoise(raw);
  assert(!/\bDROP\s+TABLE\b/i.test(clean), 'migrate-13-agent-exchange.sql must never contain DROP TABLE');
}

function testCreateTableIfNotExistsDiscipline() {
  const raw = fs.readFileSync(MIGRATE13_SQL_PATH, 'utf8');
  const clean = migrateOne.stripSqlNoise(raw);
  const bareCreateTable = /CREATE\s+TABLE\s+(?!IF\s+NOT\s+EXISTS\b)/i;
  assert(!bareCreateTable.test(clean), 'every CREATE TABLE in migrate-13-agent-exchange.sql must use IF NOT EXISTS');
}

function testAgentExchangeNoStatusColumnStatic() {
  // Static companion to smoke check 7 -- guards the SQL source itself, not
  // just a live DB's information_schema, against a future column addition.
  const raw = fs.readFileSync(MIGRATE13_SQL_PATH, 'utf8');
  const clean = migrateOne.stripSqlNoise(raw);
  const tableMatch = /CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+agent_exchange\s*\(([\s\S]*?)\n\);/i.exec(clean);
  assert(tableMatch, 'could not locate the agent_exchange CREATE TABLE body for static inspection');
  assert(!/\bstatus\b/i.test(tableMatch[1]), 'agent_exchange CREATE TABLE body must never declare a status column');
  assert(!/\bread_at\b/i.test(tableMatch[1]), 'agent_exchange CREATE TABLE body must never declare a read_at column');
}

// ── Main ───────────────────────────────────────────────────────────────────

async function main() {
  try {
    await run('A1', 'migrate-13-agent-exchange.js: fresh apply -> exit 0, MIGRATION_RESULT: PASS, FK deferred', testMigrate13FreshApply);
    await run('A2', 'migrate-13-agent-exchange.js: idempotent second run -> PASS', testMigrate13Idempotent);
    await run('A3', 'migrate-13-agent-exchange.js: assertions dropped -> prerequisite refusal naming migrate-01-canonical-db.js', testMigrate13PrereqFail);
    await run('A4', 'migrate-13-agent-exchange.js: refused target names (total-classification default branch)', () => testRefusedTargetNames(runMigrate13, 'migrate-13'));

    await run('B1', 'verify-13-exchange-smoke.js: fresh schema -> exit 0, SMOKE13_RESULT: PASS, all 7 checks PASS', testSmoke13FreshPass);
    await run('B2', 'verify-13-exchange-smoke.js: agent_exchange dropped -> prerequisite refusal naming migrate-13-agent-exchange.js', testSmoke13PrereqFail);
    await run('B3', 'verify-13-exchange-smoke.js: refused target names (total-classification default branch)', () => testRefusedTargetNames(runSmoke13, 'verify-13-smoke'));

    const mainClient = await pgConnect(DB_MAIN);
    try {
      await run('E1', 'audit trigger fires on an ordinary assertions UPDATE (sanctioned mutations captured too, by design)', () => testAuditTriggerFiresOnAssertions(mainClient));
      await run('E2', 'B-3: audit_log_audit trigger must never exist', () => testAuditLogNeverSelfWired(mainClient));
      await run('D1', 'conditional FK: deferred when tasks is absent (direct verifyMigration13 call)', () => testFkDeferredWhenTasksAbsent(mainClient));

      // Proof-of-firing cases run LAST against DB_MAIN -- each perturbs a
      // live object then heals it via re-apply, so later tests in this
      // group (and the two above, which already ran) are unaffected by
      // ordering, but running these last keeps the healthy-DB tests above
      // free of any perturb/heal interaction risk.
      await run('C1', 'proof-of-firing: dropped trigger -> verifyMigration13 FAILs naming it; heals on re-apply', () => testProofOfFiringTriggerDropped(mainClient));
      await run('C2', 'proof-of-firing: dropped function -> verifyMigration13 FAILs; heals on re-apply', () => testProofOfFiringFunctionDropped(mainClient));
      await run('C3', 'proof-of-firing (D-2): stubbed function body -> verifyMigration13 FAILs on body content, not just name; heals on re-apply', () => testProofOfFiringFunctionStubbed(mainClient));
      await run('C4', 'proof-of-firing (D-3): dropped HNSW index on a pgvector-present target -> verifyMigration13 FAILs; heals on re-apply', () => testProofOfFiringHnswDropped(mainClient));
    } finally {
      await mainClient.end();
    }

    await run('D2', 'conditional FK: validated after tasks is created and migrate-13 is re-applied (no orphans)', testFkValidatedAfterTasksCreated);
    await run('D3', 'conditional FK: added-not-validated when tasks is created but an orphan docket_id row already exists', testFkAddedNotValidatedWithOrphans);

    await run('G1', 'privacy-scrub floor (E-2): no forbidden substring in any file this PR adds or modifies', () => testPrivacyScrubFloor());
    await run('G2', 'shipped SQL invariant: no DROP TABLE anywhere in migrate-13-agent-exchange.sql', () => testNoDropTableInShippedSql());
    await run('G3', 'shipped SQL invariant: CREATE TABLE ... IF NOT EXISTS discipline', () => testCreateTableIfNotExistsDiscipline());
    await run('G4', 'shipped SQL invariant (static): agent_exchange never declares status/read_at', () => testAgentExchangeNoStatusColumnStatic());
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
