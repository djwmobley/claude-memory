'use strict';

/**
 * test-session-marker-concurrency.js — concurrency contract for
 * scripts/handoff.js's session_in_progress marker read-modify-write
 * (withSessionMarkerLock / addSessionMarker), modeled on
 * test/migrations/test-routing-profile-concurrency.js.
 *
 * The marker row is a single project_settings value holding a JSON array of
 * {session_id, ts} entries. Every mutation site (addSessionMarker, the
 * SessionEnd clear in cmdLoaderStop, the SessionStart late-close sweep in
 * cmdLoaderHook, and the explicit-close clear) is read-modify-write against
 * that ONE row — without serialization, two concurrent callers reading the
 * same "before" array and each appending their own entry would both compute
 * an array missing the other's addition, and whichever COMMITs last wins,
 * silently losing the first caller's marker (a lost update).
 *
 * withSessionMarkerLock closes this by taking a
 * `pg_advisory_xact_lock(hashtext('session_in_progress:' || project_id))`
 * transaction-scoped advisory lock before the read — same style as
 * scripts/lib/routing-profile.js's routingProfileSet, which this test's
 * structure mirrors: two separate connections, both calling
 * addSessionMarker for the SAME project at the same time via Promise.all,
 * then asserting BOTH markers ended up present (no lost update).
 *
 * Self-contained: uses a throwaway fakeRoot + freshly-minted project marker
 * (same convention as test/handoff/test-handoff.js), provisioned via a real
 * `handoff.js init -y` so project_settings exists; drops all rows for this
 * project_id in a finally block.
 *
 * Requires Postgres at PGHOST/PGUSER/PGPASSWORD (CI env) or localhost/postgres.
 *
 * Usage: node test/handoff/test-session-marker-concurrency.js
 * Exit 0 = pass; nonzero = any failure.
 */

const fs   = require('fs');
const os   = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { createRequire } = require('module');

const REPO_ROOT       = path.resolve(__dirname, '..', '..');
const HANDOFF_SCRIPT  = path.join(REPO_ROOT, 'scripts', 'handoff.js');
const DB_SEAM_PATH    = path.join(REPO_ROOT, 'scripts', 'lib', 'db-seam.js');

const { PostgresAdapter } = require(DB_SEAM_PATH);
const { getSessionMarkers, addSessionMarker } = require(HANDOFF_SCRIPT);
const { writeMarker } = require(path.join(REPO_ROOT, 'scripts', 'lib', 'project-marker.js'));
const { resolveHandoffMdPath } = require(path.join(REPO_ROOT, 'scripts', 'lib', 'handoff-paths.js'));

// scripts/ has its own node_modules (pg) — this test lives under test/,
// outside that tree; resolve 'pg' the same way sibling harnesses do.
const scriptsRequire = createRequire(require.resolve(path.join(REPO_ROOT, 'scripts', 'package.json')));
const { Client } = scriptsRequire('pg');

const TARGET_DB = 'claude_memory_eval_test';

let passed = 0;
let failed = 0;

function pass(id, label)         { console.log(`[${id}] ${label} ... PASS`); passed++; }
function fail(id, label, reason) { console.log(`[${id}] ${label} ... FAIL: ${reason}`); failed++; }

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

async function pgConnectAdapter() {
  const client = new Client({ host: 'localhost', port: 5432, database: TARGET_DB, user: 'postgres' });
  await client.connect();
  return new PostgresAdapter(client);
}

// ── C1: two concurrent addSessionMarker calls for the SAME project, DIFFERENT sessions ──

async function testConcurrentAddDifferentSessions(dbA, dbB, projectId) {
  const sessionA = `concur-session-a-${Date.now()}`;
  const sessionB = `concur-session-b-${Date.now()}`;
  const tsA = new Date().toISOString();
  const tsB = new Date(Date.now() + 1).toISOString();

  await Promise.all([
    addSessionMarker(dbA, projectId, sessionA, tsA),
    addSessionMarker(dbB, projectId, sessionB, tsB),
  ]);

  const markers = await getSessionMarkers(dbA, projectId);
  const idsPresent = markers.map((m) => m.session_id);

  assert(idsPresent.includes(sessionA), `expected sessionA marker (${sessionA}) to be present after concurrent addSessionMarker calls — got ${JSON.stringify(idsPresent)} (a lost update means the advisory lock did not serialize the read-modify-write)`);
  assert(idsPresent.includes(sessionB), `expected sessionB marker (${sessionB}) to be present after concurrent addSessionMarker calls — got ${JSON.stringify(idsPresent)} (a lost update means the advisory lock did not serialize the read-modify-write)`);
  assertEq(markers.length, 2, `expected exactly 2 markers after two concurrent adds of two DIFFERENT sessions, got ${markers.length}: ${JSON.stringify(markers)}`);
}

// ── C2: two concurrent addSessionMarker calls for the SAME project, SAME session (dedupe) ──

async function testConcurrentAddSameSession(dbA, dbB, projectId) {
  const sessionId = `concur-session-same-${Date.now()}`;
  const tsA = new Date().toISOString();
  const tsB = new Date(Date.now() + 1).toISOString();

  await Promise.all([
    addSessionMarker(dbA, projectId, sessionId, tsA),
    addSessionMarker(dbB, projectId, sessionId, tsB),
  ]);

  const markers = await getSessionMarkers(dbA, projectId);
  const matching = markers.filter((m) => m.session_id === sessionId);
  assertEq(matching.length, 1, `expected exactly ONE marker for the same session_id after two concurrent same-session adds (dedupe-by-session_id, not accumulation), got ${matching.length}: ${JSON.stringify(matching)}`);
  assert(matching[0].ts === tsA || matching[0].ts === tsB, `expected the surviving marker's ts to be one of the two racing writes, got ${matching[0].ts}`);
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const fakeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'session-marker-concurrency-'));
  let projectId = null;
  let dbA = null;
  let dbB = null;

  try {
    fs.mkdirSync(path.join(fakeRoot, '.git'));
    fs.mkdirSync(path.join(fakeRoot, '.claude'));
    fs.writeFileSync(
      path.join(fakeRoot, '.claude', 'pipeline.yml'),
      `knowledge:\n  tier: "postgres"\n  host: "localhost"\n  port: 5432\n  database: "${TARGET_DB}"\n  user: "postgres"\n`,
      'utf8'
    );
    const marker = writeMarker(fakeRoot);
    projectId = marker.uuid;

    const initR = spawnSync(process.execPath, [HANDOFF_SCRIPT, 'init', '-y'], {
      cwd: fakeRoot,
      env: { ...process.env, PROJECT_ROOT: fakeRoot },
      encoding: 'utf8',
      timeout: 30000,
    });
    if (initR.status !== 0) {
      throw new Error(`handoff.js init -y failed: status=${initR.status} stderr=${initR.stderr}`);
    }

    dbA = await pgConnectAdapter();
    dbB = await pgConnectAdapter();

    await run(
      'C1',
      'addSessionMarker: two concurrent calls for the SAME project, DIFFERENT sessions — both markers present (no lost update)',
      () => testConcurrentAddDifferentSessions(dbA, dbB, projectId)
    );

    await run(
      'C2',
      'addSessionMarker: two concurrent calls for the SAME project, SAME session — dedupes to exactly one marker (not lost, not duplicated)',
      () => testConcurrentAddSameSession(dbA, dbB, projectId)
    );
  } finally {
    if (dbA) { try { await dbA.end(); } catch (_) {} }
    if (dbB) { try { await dbB.end(); } catch (_) {} }

    if (projectId) {
      try {
        const cleanup = new Client({ host: 'localhost', port: 5432, database: TARGET_DB, user: 'postgres' });
        await cleanup.connect();
        for (const tbl of ['edges', 'assertions', 'entities', 'retrieval_contract', 'project_settings']) {
          await cleanup.query(`DELETE FROM ${tbl} WHERE project_id = $1`, [projectId]);
        }
        await cleanup.end();
      } catch (_) { /* best-effort */ }

      try {
        const dir = path.dirname(resolveHandoffMdPath(projectId));
        if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
      } catch (_) {}
    }

    try { fs.rmSync(fakeRoot, { recursive: true, force: true }); } catch (_) {}
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exitCode = 1;
});
