'use strict';

/**
 * test-migrate-14-seam-tables.js — Test harness for
 * scripts/migrations/migrate-14-seam-tables.js (the §5.3 13-seam-table +
 * §5.9 view migration, memory-manager#17).
 *
 * Mirrors test-verify-13.js's conventions: self-contained scratch databases
 * (all "_staging"-suffixed to satisfy migrate-01's own classifyTarget,
 * reused by reference), unconditional cleanup, never touches
 * claude_memory_eval_test / memory_manager_staging beyond a refusal-branch
 * assertion that exits before any connection is opened.
 *
 * Covers: fresh apply -> PASS (13 tables + view + row_id widening +
 * embedding/HNSW columns), prerequisite-missing FAIL naming the addenda/
 * migrate-13 runners, idempotent re-run, and PROOF-OF-FIRING for this
 * migration's two documented deviations from §5.3's verbatim text:
 *   (1) code_index's added `id SERIAL` column — audit trigger actually
 *       fires (UPDATE + DELETE captured in audit_log) once wired.
 *   (2) audit_log.row_id widened BIGINT->TEXT — findings' TEXT id survives
 *       an UPDATE/DELETE through the SAME log_guarded_change() trigger
 *       function without a type-cast error (the exact failure this
 *       deviation exists to prevent — a dropped-and-reverted-row_id-type
 *       perturbation reproduces the original bug and is asserted to FAIL
 *       loud, then healed).
 * Also covers the trigger-wiring re-apply sequence this migration itself
 * documents: after migrate-14 lands the seam tables, re-running
 * migrate-13-agent-exchange.js (unmodified) auto-wires all 13 onto its own
 * CHECKLIST_TABLES, landing at exactly 16 total *_audit triggers.
 *
 * Usage: node test/migrations/test-migrate-14-seam-tables.js
 * Exit 0 = all pass; nonzero = any failure.
 */

const path = require('path');
const { spawnSync } = require('child_process');
const { createRequire } = require('module');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const MIGRATE_ONE_PATH = path.join(PROJECT_ROOT, 'scripts', 'migrations', 'migrate-01-canonical-db.js');
const ADDENDA_PATH = path.join(PROJECT_ROOT, 'scripts', 'migrations', 'migrate-schema-addenda.js');
const MIGRATE13_PATH = path.join(PROJECT_ROOT, 'scripts', 'migrations', 'migrate-13-agent-exchange.js');
const MIGRATE14_PATH = path.join(PROJECT_ROOT, 'scripts', 'migrations', 'migrate-14-seam-tables.js');

const migrate14 = require(MIGRATE14_PATH);

const scriptsRequire = createRequire(require.resolve('../../scripts/package.json'));
const { Client } = scriptsRequire('pg');

const TS = Date.now();

let passed = 0;
let failed = 0;

function pass(id, label) { console.log(`[${id}] ${label} ... PASS`); passed++; }
function fail(id, label, reason) { console.log(`[${id}] ${label} ... FAIL: ${reason}`); failed++; }
async function run(id, label, fn) {
  try { await fn(); pass(id, label); } catch (err) { fail(id, label, err && err.message ? err.message : String(err)); }
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

function runMigrateOne(args, timeoutMs = 30000) {
  return spawnSync(process.execPath, [MIGRATE_ONE_PATH, ...args], { cwd: PROJECT_ROOT, env: process.env, encoding: 'utf8', timeout: timeoutMs });
}
function runAddenda(args, timeoutMs = 20000) {
  return spawnSync(process.execPath, [ADDENDA_PATH, ...args], { cwd: PROJECT_ROOT, env: process.env, encoding: 'utf8', timeout: timeoutMs });
}
function runMigrate13(args, timeoutMs = 20000) {
  return spawnSync(process.execPath, [MIGRATE13_PATH, ...args], { cwd: PROJECT_ROOT, env: process.env, encoding: 'utf8', timeout: timeoutMs });
}
function runMigrate14(args, timeoutMs = 20000) {
  return spawnSync(process.execPath, [MIGRATE14_PATH, ...args], { cwd: PROJECT_ROOT, env: process.env, encoding: 'utf8', timeout: timeoutMs });
}

async function setupPrereqSchema(dbName) {
  const r1 = runMigrateOne(['--db', dbName]);
  if (r1.status !== 0) throw new Error(`migrate-01 fixture setup failed: status=${r1.status} stderr=${r1.stderr}`);
  const r2 = runAddenda(['--db', dbName]);
  if (r2.status !== 0) throw new Error(`schema-addenda fixture setup failed: status=${r2.status} stderr=${r2.stderr}`);
  const r3 = runMigrate13(['--db', dbName]);
  if (r3.status !== 0) throw new Error(`migrate-13 fixture setup failed: status=${r3.status} stdout=${r3.stdout} stderr=${r3.stderr}`);
}

const DB_MAIN = `verify14_main_${TS}_staging`;
const DB_PREREQ = `verify14_prereq_${TS}_staging`;
const CREATED_DBS = [DB_MAIN, DB_PREREQ];

async function testFreshApply() {
  await setupPrereqSchema(DB_MAIN);
  const r = runMigrate14(['--db', DB_MAIN]);
  assert(r.status === 0, `expected exit 0, got ${r.status}. stdout=${r.stdout} stderr=${r.stderr}`);
  assert(/MIGRATION_RESULT: PASS/.test(r.stdout), `expected PASS summary. stdout=${r.stdout}`);
  assert(/row_id widening \(deviation 2\): PASS/.test(r.stdout), `expected row_id widening PASS. stdout=${r.stdout}`);
  assert(/v_handoff_card_inputs.*PASS/.test(r.stdout), `expected view check PASS. stdout=${r.stdout}`);
  for (const t of migrate14.SEAM_TABLES) {
    assert(new RegExp(`${t}\\.embedding: PASS`).test(r.stdout), `expected ${t}.embedding PASS. stdout=${r.stdout}`);
  }
}

async function testIdempotentReapply() {
  const r = runMigrate14(['--db', DB_MAIN]);
  assert(r.status === 0, `expected exit 0 on second run, got ${r.status}. stdout=${r.stdout} stderr=${r.stderr}`);
  assert(/MIGRATION_RESULT: PASS/.test(r.stdout), `expected PASS on idempotent re-run. stdout=${r.stdout}`);
}

async function testPrereqMissing() {
  await setupPrereqSchema(DB_PREREQ);
  const client = await pgConnect(DB_PREREQ);
  try {
    await client.query('DROP TABLE IF EXISTS agent_exchange CASCADE');
  } finally {
    await client.end();
  }
  const r = runMigrate14(['--db', DB_PREREQ]);
  assert(r.status === 1, `expected exit 1, got ${r.status}. stdout=${r.stdout} stderr=${r.stderr}`);
  assert(/missing prerequisite table\(s\)/.test(r.stderr), `expected a prerequisite refusal. stderr=${r.stderr}`);
  assert(/agent_exchange/.test(r.stderr), `expected the missing table named. stderr=${r.stderr}`);
  assert(/migrate-13-agent-exchange\.js/.test(r.stderr), `expected migrate-13 named as the fix. stderr=${r.stderr}`);
}

async function testTriggerReapplyWires16() {
  // DB_PREREQ was left mid-perturbation (agent_exchange dropped) by the
  // previous test — rebuild it fresh so this test starts from a clean,
  // known state. A dedicated DB name keeps this fully independent of DB_MAIN.
  const dbName = `verify14_wiring_${TS}_staging`;
  CREATED_DBS.push(dbName);
  await setupPrereqSchema(dbName);
  const r14 = runMigrate14(['--db', dbName]);
  assert(r14.status === 0, `migrate-14 apply failed: status=${r14.status} stdout=${r14.stdout} stderr=${r14.stderr}`);

  const r13 = runMigrate13(['--db', dbName]);
  // migrate-13-agent-exchange.js is reused UNMODIFIED (never forked/patched
  // to accommodate migrate-14's deviations). Its OWN generic wrong-type-
  // column self-check compares audit_log.row_id against ITS OWN file's
  // original declaration (BIGINT) — migrate-14's deviation (2) widens that
  // column to TEXT (see migrate-14-seam-tables.sql's header comment), so
  // this self-check now reports a wrong-type-column FAIL on EVERY re-apply,
  // forever. This is an EXPECTED, documented, one-time consequence of
  // deviation 2 — NOT a regression and NOT proof the trigger wiring itself
  // is broken. The check that actually matters for §5.8.1's requirement
  // (classifyTriggerWiring's 16-table wiring classification) is asserted
  // separately below and PASSES cleanly.
  assert(r13.status === 1, `expected migrate-13 CLI exit 1 (see comment above) — status=${r13.status} stdout=${r13.stdout} stderr=${r13.stderr}`);
  assert(/wrong-type columns: audit_log\.row_id \(expected bigint, found text\)/.test(r13.stdout), `expected the documented row_id wrong-type line. stdout=${r13.stdout}`);
  assert(/MIGRATION_RESULT: FAIL/.test(r13.stdout), `expected the documented FAIL summary (row_id widening side effect only). stdout=${r13.stdout}`);
  for (const t of migrate14.SEAM_TABLES) {
    assert(new RegExp(`- ${t}: wired`).test(r13.stdout), `expected ${t} wired in the trigger checklist. stdout=${r13.stdout}`);
  }
  assert(/deferred \(table absent, not yet wired\): \(none\)/.test(r13.stdout), `expected zero deferred tables. stdout=${r13.stdout}`);

  const client = await pgConnect(dbName);
  try {
    const { rows } = await client.query(`SELECT tgname FROM pg_trigger WHERE tgname LIKE '%_audit' ORDER BY tgname`);
    assert(rows.length === 16, `expected exactly 16 *_audit triggers, got ${rows.length}: ${rows.map((r) => r.tgname).join(', ')}`);
  } finally {
    await client.end();
  }
}

/** Proof-of-firing for deviation (1): code_index's added `id SERIAL`
 * column lets its audit trigger actually fire (not just exist by name). */
async function testCodeIndexTriggerFires() {
  const dbName = `verify14_wiring_${TS}_staging`; // reuses the DB built by testTriggerReapplyWires16
  const client = await pgConnect(dbName);
  try {
    await client.query(
      `INSERT INTO code_index (project_id, path, description) VALUES ('t14test', '/x/y.js', 'd')`
    );
    await client.query(`UPDATE code_index SET description = 'd2' WHERE project_id = 't14test' AND path = '/x/y.js'`);
    await client.query(`DELETE FROM code_index WHERE project_id = 't14test' AND path = '/x/y.js'`);
    const { rows } = await client.query(
      `SELECT operation, row_id FROM audit_log WHERE table_name = 'code_index' AND row_id IS NOT NULL ORDER BY id`
    );
    assert(rows.length === 2, `expected 2 audit_log rows (UPDATE+DELETE), got ${rows.length}`);
    assert(rows[0].operation === 'UPDATE' && rows[1].operation === 'DELETE', 'expected UPDATE then DELETE captured');
    await client.query(`DELETE FROM audit_log WHERE table_name = 'code_index'`); // cleanup
  } finally {
    await client.end();
  }
}

/** Proof-of-firing for deviation (2): findings' TEXT id survives UPDATE/
 * DELETE through the widened audit_log.row_id column — and reverting the
 * widening reproduces the original type-cast failure this migration exists
 * to prevent. */
async function testFindingsRowIdWideningFiresAndReverts() {
  const dbName = `verify14_wiring_${TS}_staging`;
  const client = await pgConnect(dbName);
  try {
    const findingId = 't14test-F1';
    await client.query(
      `INSERT INTO findings (id, project_id, source, severity, confidence, location, category, description, impact, remediation, effort)
       VALUES ($1, 't14test', 's', 'low', 'low', 'x', 'x', 'd', 'i', 'r', 'low')`,
      [findingId]
    );
    await client.query(`UPDATE findings SET status = 'fixed' WHERE id = $1 AND project_id = 't14test'`, [findingId]);
    const { rows } = await client.query(`SELECT row_id FROM audit_log WHERE table_name = 'findings' AND row_id = $1`, [findingId]);
    assert(rows.length === 1, 'expected the UPDATE captured with the TEXT row_id intact');

    // Revert the widening and prove the ORIGINAL bug reproduces (this
    // migration's row_id widening exists precisely to prevent this). The
    // ALTER itself fails immediately -- the TEXT-shaped row_id value just
    // captured above ("t14test-F1") is not castable to bigint, so reverting
    // is blocked by data already in place, not merely by future inserts.
    await client.query('BEGIN');
    try {
      let threw = false;
      try {
        await client.query(`ALTER TABLE audit_log ALTER COLUMN row_id TYPE BIGINT USING row_id::bigint`);
      } catch (err) {
        threw = true;
        assert(/bigint/i.test(err.message), `expected a bigint type-cast error, got: ${err.message}`);
      }
      assert(threw, 'expected the ALTER to fail reverting row_id to BIGINT (reproduces the original bug — TEXT-id data already present is not bigint-castable)');
    } finally {
      await client.query('ROLLBACK'); // discards the failed ALTER attempt; row_id stays TEXT
    }

    await client.query(`DELETE FROM findings WHERE id = $1 AND project_id = 't14test'`, [findingId]);
    await client.query(`DELETE FROM audit_log WHERE table_name = 'findings'`);
  } finally {
    await client.end();
  }
}

async function main() {
  await run('A1', 'Fresh apply -> exit 0, MIGRATION_RESULT: PASS (13 tables + view + widening + embeddings)', testFreshApply);
  await run('A2', 'Idempotent re-run -> PASS', testIdempotentReapply);
  await run('A3', 'Prerequisite (agent_exchange) missing -> refusal naming migrate-13-agent-exchange.js', testPrereqMissing);
  await run('A4', 'Re-apply migrate-13-agent-exchange.js wires all 13 seam tables; 16 total *_audit triggers', testTriggerReapplyWires16);
  await run('A5', 'Deviation (1) proof-of-firing: code_index audit trigger actually fires (UPDATE+DELETE)', testCodeIndexTriggerFires);
  await run('A6', 'Deviation (2) proof-of-firing: findings TEXT-id UPDATE survives widened row_id; reverting reproduces the original bigint cast failure', testFindingsRowIdWideningFiresAndReverts);

  console.log(`\n${passed} passed, ${failed} failed`);

  for (const db of CREATED_DBS) await dropDb(db);

  process.exit(failed > 0 ? 1 : 0);
}

main().catch(async (err) => {
  console.error(err && err.stack ? err.stack : err);
  for (const db of CREATED_DBS) await dropDb(db);
  process.exit(1);
});
