'use strict';

/**
 * test-route-resolve-contract.js — Pins the CURRENT (unenforced) behavior
 * for §17.1.1's "review must never resolve to the same agent identity as
 * draft" note (G4 finding, docs/notes/2026-09-06-s17-routing-gap-audit.md).
 *
 * scripts/lib/route-resolve.js documents this as an orchestration-layer,
 * caller-responsibility concern in its "OUT OF SCOPE" header comment — the
 * resolver has no artifact/agent-identity context to enforce it, and
 * nothing anywhere in this repo does. This test does NOT add enforcement
 * (that is a design decision for the owner, out of scope here). It pins
 * TODAY'S behavior — a 'review' role resolution MAY resolve to the same
 * model as a 'draft' role resolution, with no rejection or flag — so that
 * any future change to add enforcement requires a deliberate edit to this
 * test, never a silent regression in either direction.
 *
 * Self-contained scratch database, "_staging" suffix to satisfy migrate-01's
 * classifyTarget, unconditional finally-block cleanup — same conventions
 * as test-verify-17.js.
 *
 * Requires Postgres at PGHOST/PGUSER/PGPASSWORD (CI env) or
 * localhost/postgres.
 *
 * Usage: node test/migrations/test-route-resolve-contract.js
 * Exit 0 = pass; nonzero = any failure.
 */

const path = require('path');
const { spawnSync } = require('child_process');
const { createRequire } = require('module');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const MIGRATE_ONE_PATH = path.join(PROJECT_ROOT, 'scripts', 'migrations', 'migrate-01-canonical-db.js');
const ADDENDA_PATH = path.join(PROJECT_ROOT, 'scripts', 'migrations', 'migrate-schema-addenda.js');
const ROUTE_RESOLVE_PATH = path.join(PROJECT_ROOT, 'scripts', 'lib', 'route-resolve.js');

const { routeResolve } = require(ROUTE_RESOLVE_PATH);

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
const DB_NAME = `routecontract_${TS}_staging`;

// ── C1: review and draft MAY resolve to the SAME model today (unenforced) ──

async function testReviewDraftSameModelUnenforced(client) {
  const projectId = `contract-proj-${TS}`;
  const sessionId = `contract-sess-${TS}`;
  const sharedModel = `contract-shared-model-${TS}`;

  // Both roles are directed at the SAME model via a bare overrideModel — no
  // agent-identity/artifact context is passed anywhere, because routeResolve
  // has no such parameter. If review/draft agent-identity separation were
  // ever enforced here, one of these two calls would need to reject or flag
  // the second resolution; today, neither does.
  const draft = await routeResolve(client, {
    projectId, sessionId, turnIdx: 0, role: 'draft', overrideModel: sharedModel,
  });
  const review = await routeResolve(client, {
    projectId, sessionId, turnIdx: 1, role: 'review', overrideModel: sharedModel,
  });

  assertEq(draft.model, sharedModel, 'draft must resolve to the directed override model');
  assertEq(review.model, sharedModel, 'review must resolve to the directed override model');
  assertEq(
    draft.model,
    review.model,
    'PINNED CURRENT BEHAVIOR (G4): routeResolve has no agent-identity context and does ' +
    'not reject or flag a review resolution matching draft\'s model. If this assertion ' +
    'ever fails because enforcement was added, that is a deliberate, reviewed change to ' +
    'this test file, not a regression.'
  );
  assert(review.resolved_via === 'directive' && draft.resolved_via === 'directive',
    'both calls must resolve via the directive path (bare overrideModel) for this contract to be meaningful');
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  try {
    await setupFullSchema(DB_NAME);
    const client = await pgConnect(DB_NAME);
    try {
      await run(
        'C1',
        'routeResolve: review MAY resolve to the same model/identity as draft today — G4 is documented, not enforced (pinned contract)',
        () => testReviewDraftSameModelUnenforced(client)
      );
    } finally {
      await client.end();
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
