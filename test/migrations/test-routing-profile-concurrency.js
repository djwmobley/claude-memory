'use strict';

/**
 * test-routing-profile-concurrency.js — G6 concurrency contract for
 * scripts/lib/routing-profile.js's routingProfileSet (docs/notes/
 * 2026-09-06-s17-routing-gap-audit.md's B3/G6 finding).
 *
 * The runbook's M-18 pseudocode reads "SELECT MAX(version) ... FOR UPDATE"
 * before deactivating the previous active row and inserting the new one.
 * routing-profile.js's own header comment documents why that pseudocode is
 * invalid Postgres (FOR UPDATE + an aggregate is rejected outright, error
 * 0A000) and, separately, would not serialize the FIRST-EVER
 * routing_profile_set call for a brand-new (project_id, role) pair anyway
 * (there is no existing row for a row-level lock to hold) — so the module
 * takes a `pg_advisory_xact_lock(hashtext(project_id||':'||role))`
 * transaction-scoped advisory lock before computing MAX(version)+1 instead.
 *
 * This test does not change that mechanism. It exercises the exact case
 * the runbook's literal pseudocode could not handle: two callers, on two
 * separate connections, both calling routing_profile_set for the SAME
 * brand-new (project_id, role) pair at the same time. Asserts:
 *   - both calls succeed (no unique-constraint violation on
 *     routing_profiles_project_id_role_version_key)
 *   - versions 1 and 2 are assigned, one to each caller (in either order)
 *   - exactly one row is left active=true afterward, and it is the
 *     highest version
 *
 * Self-contained scratch database, "_staging" suffix to satisfy migrate-01's
 * classifyTarget, unconditional finally-block cleanup — same conventions
 * as test-verify-17.js / test-route-resolve-contract.js.
 *
 * Requires Postgres at PGHOST/PGUSER/PGPASSWORD (CI env) or
 * localhost/postgres.
 *
 * Usage: node test/migrations/test-routing-profile-concurrency.js
 * Exit 0 = pass; nonzero = any failure.
 */

const path = require('path');
const { spawnSync } = require('child_process');
const { createRequire } = require('module');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const MIGRATE_ONE_PATH = path.join(PROJECT_ROOT, 'scripts', 'migrations', 'migrate-01-canonical-db.js');
const ADDENDA_PATH = path.join(PROJECT_ROOT, 'scripts', 'migrations', 'migrate-schema-addenda.js');
const ROUTING_PROFILE_PATH = path.join(PROJECT_ROOT, 'scripts', 'lib', 'routing-profile.js');

const { routingProfileSet } = require(ROUTING_PROFILE_PATH);

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

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function assertEq(actual, expected, msg) {
  if (actual !== expected) {
    throw new Error(`${msg || 'assertion failed'} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
  }
}

// ── PG helpers ──────────────────────────────────────────────────────────────

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

async function setupFullSchema(dbName) {
  const r1 = runMigrateOne(['--db', dbName]);
  if (r1.status !== 0) throw new Error(`migrate-01 fixture setup failed for ${dbName}: status=${r1.status} stderr=${r1.stderr}`);
  const r2 = runAddenda(['--db', dbName]);
  if (r2.status !== 0) throw new Error(`schema-addenda fixture setup failed for ${dbName}: status=${r2.status} stderr=${r2.stderr}`);
}

// Scratch DB name — satisfies classifyTarget's allowed pattern (ends in "_staging").
const DB_NAME = `routingprofile_concurrency_${TS}_staging`;

// ── G6-1: two concurrent first-ever sets for the same (project_id, role) ──

async function testConcurrentFirstEverSet(clientA, clientB, pool) {
  const projectId = `g6-proj-${TS}`;
  const role = `g6-role-${TS}`;

  const [resA, resB] = await Promise.all([
    routingProfileSet(clientA, { projectId, role, capabilityTier: 'mid', agentId: 'agent-a' }),
    routingProfileSet(clientB, { projectId, role, capabilityTier: 'mid', agentId: 'agent-b' }),
  ]);

  assert(Number.isInteger(resA.version) && Number.isInteger(resB.version),
    `both concurrent calls must return an integer version, got ${JSON.stringify(resA)} / ${JSON.stringify(resB)}`);
  assert(resA.version !== resB.version,
    `the two concurrent first-ever calls must not race onto the same version, got ${resA.version} and ${resB.version} for both`);

  const versions = [resA.version, resB.version].sort((a, b) => a - b);
  assertEq(versions[0], 1, `expected version 1 to be assigned to one of the two concurrent first-ever calls, got ${JSON.stringify(versions)}`);
  assertEq(versions[1], 2, `expected version 2 to be assigned to the other concurrent first-ever call, got ${JSON.stringify(versions)}`);

  const { rows } = await pool.query(
    `SELECT version, active FROM routing_profiles WHERE project_id = $1 AND role = $2 ORDER BY version`,
    [projectId, role]
  );
  assertEq(rows.length, 2, 'expected exactly 2 rows total after both concurrent sets (no lost insert, no duplicate, no unique-constraint violation surfaced)');

  const activeRows = rows.filter((r) => r.active === true);
  assertEq(activeRows.length, 1, `expected exactly one active=true row after both concurrent sets complete, got ${activeRows.length}`);
  assertEq(activeRows[0].version, 2, 'the highest version (2) must be the one left active — the advisory lock serializes deactivate-then-insert per call, so whichever call ran second deactivates the first\'s row');
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  let clientA;
  let clientB;
  let pool;
  try {
    await setupFullSchema(DB_NAME);
    clientA = await pgConnect(DB_NAME);
    clientB = await pgConnect(DB_NAME);
    pool = await pgConnect(DB_NAME);
    try {
      await run(
        'G6-1',
        'routingProfileSet: two concurrent first-ever calls for the same (project_id, role) get versions 1 and 2, no unique violation, exactly one active row afterward',
        () => testConcurrentFirstEverSet(clientA, clientB, pool)
      );
    } finally {
      if (clientA) await clientA.end();
      if (clientB) await clientB.end();
      if (pool) await pool.end();
    }
  } finally {
    await dropDb(DB_NAME);
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exitCode = 1;
});
