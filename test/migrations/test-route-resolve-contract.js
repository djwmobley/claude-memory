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

const { routeResolve, RouteResolveError } = require(ROUTE_RESOLVE_PATH);

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

async function assertThrows(fn, matcher, msg) {
  let threw = null;
  try {
    await fn();
  } catch (err) {
    threw = err;
  }
  if (!threw) throw new Error(`${msg || 'expected a throw'} — but no error was thrown`);
  if (matcher && !matcher(threw)) {
    throw new Error(`${msg || 'error did not match'} — got: ${threw && threw.message}`);
  }
}

/** Direct SQL insert, bypassing routeResolve entirely — used to construct a
 * pre-existing (possibly identity-conflicting) turn_usage row for replay
 * tests, mirroring test-verify-17.js's B6 race-path convention of a raw
 * concurrent INSERT. */
async function insertRawTurnUsage(client, { projectId, sessionId, turnIdx, role, agentId, model }) {
  await client.query(
    `INSERT INTO turn_usage
       (project_id, session_id, turn_idx, agent_role, model_id, provider, resolved_via, recommended_model, cost_delta_usd, agent_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [projectId, sessionId, turnIdx, role, model || `raw-model-${TS}`, null, 'directive', null, null, agentId || null]
  );
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

  // Both roles are directed at the SAME model via a bare overrideModel and
  // NEITHER call passes the (now-existing, 2026-09-06) optional `agentId`
  // argument — this pins the behavior when identity enforcement is not
  // opted into at all, which stays unchanged after that fix. The opt-in
  // enforcement itself is exercised by the companion C2+ block below.
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

// ── C2+: §17.1.1 opt-in review-identity enforcement (2026-09-06) ───────────
//
// Every test below passes a DISTINCT (projectId, sessionId) pair so the
// companion block never contaminates C1's (unenforced, no-agentId) fixture
// or any other test's session-scoped state.

function isCollision(err) {
  return err instanceof RouteResolveError && err.code === 'REVIEW_IDENTITY_COLLISION';
}

async function testCaseFoldCollides(client) {
  const projectId = `c2-proj-${TS}`;
  const sessionId = `c2-sess-${TS}`;
  await routeResolve(client, { projectId, sessionId, turnIdx: 0, role: 'draft', overrideModel: `c2-model-${TS}`, agentId: 'Sonnet-A' });
  await assertThrows(
    () => routeResolve(client, { projectId, sessionId, turnIdx: 1, role: 'review', overrideModel: `c2-model-${TS}`, agentId: 'sonnet-a' }),
    isCollision,
    'Sonnet-A vs sonnet-a must collide (case-folded)'
  );
}

async function testWhitespaceVariantsCollide(client) {
  const projectId = `c3-proj-${TS}`;
  const sessionId = `c3-sess-${TS}`;
  await routeResolve(client, { projectId, sessionId, turnIdx: 0, role: 'draft', overrideModel: `c3-model-${TS}`, agentId: 'Agent  Nine' });
  await assertThrows(
    () => routeResolve(client, { projectId, sessionId, turnIdx: 1, role: 'review', overrideModel: `c3-model-${TS}`, agentId: '  Agent Nine  ' }),
    isCollision,
    'leading/trailing/internal whitespace variants must collide after normLabel collapse'
  );
}

async function testNfdNfcCollide(client) {
  const projectId = `c4-proj-${TS}`;
  const sessionId = `c4-sess-${TS}`;
  const nfc = `Agent-é-${TS}`; // é precomposed
  const nfd = `Agent-é-${TS}`; // e + combining acute
  await routeResolve(client, { projectId, sessionId, turnIdx: 0, role: 'draft', overrideModel: `c4-model-${TS}`, agentId: nfd });
  await assertThrows(
    () => routeResolve(client, { projectId, sessionId, turnIdx: 1, role: 'review', overrideModel: `c4-model-${TS}`, agentId: nfc }),
    isCollision,
    'NFD vs NFC of the same identity must collide (normLabel applies NFC)'
  );
}

async function testHyphenVariantDoesNotCollide(client) {
  const projectId = `c5-proj-${TS}`;
  const sessionId = `c5-sess-${TS}`;
  const hyphenMinus = `Agent-1-${TS}`; // U+002D
  const hyphenUnicode = `Agent‐1-${TS}`; // U+2010
  await routeResolve(client, { projectId, sessionId, turnIdx: 0, role: 'draft', overrideModel: `c5-model-${TS}`, agentId: hyphenMinus });
  // DOCUMENTED (not a bug): a hyphen-variant identity is a DIFFERENT folded
  // string and must NOT be unified — this is the accepted evasion vector.
  const review = await routeResolve(client, { projectId, sessionId, turnIdx: 1, role: 'review', overrideModel: `c5-model-${TS}`, agentId: hyphenUnicode });
  assertEq(review.identity_enforced, true, 'a check ran (prior identified turn existed) and found no collision');
  assertEq(review.model, `c5-model-${TS}`, 'review must resolve normally, not be rejected');
}

async function testEmptySetReason(client) {
  const projectId = `c6-proj-${TS}`;
  const sessionId = `c6-sess-${TS}`;
  // Prior turn exists but carries NO agent_id (agentId omitted) — the
  // fetchPriorAgentIds pool is empty even though the session is not empty.
  await routeResolve(client, { projectId, sessionId, turnIdx: 0, role: 'draft', overrideModel: `c6-model-${TS}` });
  const review = await routeResolve(client, { projectId, sessionId, turnIdx: 1, role: 'review', overrideModel: `c6-model-${TS}`, agentId: 'c6-reviewer' });
  assertEq(review.identity_enforced, false, 'no prior IDENTIFIED (agent_id NOT NULL) turn exists in this session');
  assertEq(review.identity_reason, 'no prior identified turns in session', 'must carry the empty-set reason, not the not-supplied reason');
}

async function testAbsentAgentIdEndToEnd(client) {
  const projectId = `c7-proj-${TS}`;
  const sessionId = `c7-sess-${TS}`;
  const r = await routeResolve(client, { projectId, sessionId, turnIdx: 0, role: 'draft', overrideModel: `c7-model-${TS}` });
  assertEq(r.identity_enforced, false, 'agentId omitted -> never enforced');
  assertEq(r.identity_reason, 'agentId not supplied', 'must carry the not-supplied reason verbatim');
  assert(!('identity_conflict' in r), 'a fresh (non-replay) resolution must never carry identity_conflict');
}

async function testDraftOnlyIdentity(client) {
  const projectId = `c8-proj-${TS}`;
  const sessionId = `c8-sess-${TS}`;
  await routeResolve(client, { projectId, sessionId, turnIdx: 0, role: 'draft', overrideModel: `c8-model-a-${TS}`, agentId: 'c8-drafter' });
  // Second draft, SAME identity, SAME role -> same-role repeats never collide.
  const r = await routeResolve(client, { projectId, sessionId, turnIdx: 1, role: 'draft', overrideModel: `c8-model-b-${TS}`, agentId: 'c8-drafter' });
  assertEq(r.identity_enforced, true, 'a non-empty prior-identity set was checked and passed (same-role repeat allowed)');
  assertEq(r.model, `c8-model-b-${TS}`, 'draft must resolve normally');
}

async function testTwoDraftsThenReviewCollidesOnSecond(client) {
  const projectId = `c9-proj-${TS}`;
  const sessionId = `c9-sess-${TS}`;
  await routeResolve(client, { projectId, sessionId, turnIdx: 0, role: 'draft', overrideModel: `c9-model-a-${TS}`, agentId: 'c9-drafter-one' });
  await routeResolve(client, { projectId, sessionId, turnIdx: 1, role: 'draft', overrideModel: `c9-model-b-${TS}`, agentId: 'c9-drafter-two' });
  // Review matches the SECOND drafter's identity only.
  await assertThrows(
    () => routeResolve(client, { projectId, sessionId, turnIdx: 2, role: 'review', overrideModel: `c9-model-c-${TS}`, agentId: 'c9-drafter-two' }),
    (err) => isCollision(err) && /turn_idx=1/.test(err.message) && /c9-drafter-two/.test(err.message),
    'review matching the SECOND draft\'s identity must collide, naming turn_idx=1'
  );
}

async function testReviewCollidesAgainstNonDraftRole(client) {
  const projectId = `c10-proj-${TS}`;
  const sessionId = `c10-sess-${TS}`;
  // A role that is neither 'draft' nor 'review' — proves the check is
  // "not review" (total classification), never a hardcoded 'draft' string.
  await routeResolve(client, { projectId, sessionId, turnIdx: 0, role: 'orchestrate', overrideModel: `c10-model-a-${TS}`, agentId: 'c10-orchestrator' });
  await assertThrows(
    () => routeResolve(client, { projectId, sessionId, turnIdx: 1, role: 'review', overrideModel: `c10-model-b-${TS}`, agentId: 'c10-orchestrator' }),
    isCollision,
    'review must collide against ANY non-review role sharing its identity, not just \'draft\''
  );
}

async function testReviewFirstThenDraftCollidesBidirectional(client) {
  const projectId = `c11-proj-${TS}`;
  const sessionId = `c11-sess-${TS}`;
  await routeResolve(client, { projectId, sessionId, turnIdx: 0, role: 'review', overrideModel: `c11-model-a-${TS}`, agentId: 'c11-shared' });
  await assertThrows(
    () => routeResolve(client, { projectId, sessionId, turnIdx: 1, role: 'draft', overrideModel: `c11-model-b-${TS}`, agentId: 'c11-shared' }),
    isCollision,
    'a draft turn must collide against a PRIOR review turn sharing its identity (bidirectional, insertion-order independent)'
  );
}

async function testReviewAfterReviewAllowed(client) {
  const projectId = `c12-proj-${TS}`;
  const sessionId = `c12-sess-${TS}`;
  await routeResolve(client, { projectId, sessionId, turnIdx: 0, role: 'review', overrideModel: `c12-model-a-${TS}`, agentId: 'c12-reviewer' });
  const r = await routeResolve(client, { projectId, sessionId, turnIdx: 1, role: 'review', overrideModel: `c12-model-b-${TS}`, agentId: 'c12-reviewer' });
  assertEq(r.identity_enforced, true, 'a non-empty prior-identity set was checked and passed');
  assertEq(r.model, `c12-model-b-${TS}`, 'review-after-review with the same identity must resolve normally, never collide');
}

async function testReplayAfterCollisionReportsConflict(client) {
  const projectId = `c13-proj-${TS}`;
  const sessionId = `c13-sess-${TS}`;
  // Two ALREADY-conflicting rows constructed directly via SQL (bypassing
  // routeResolve's own collision guard, which would otherwise refuse to
  // ever let both exist) — simulates a pre-existing conflicting state (e.g.
  // a row whose agent_id was set out-of-band via usage_record's
  // COALESCE-on-agent_id path) so the REPLAY branch's recomputation can be
  // exercised in isolation.
  await insertRawTurnUsage(client, { projectId, sessionId, turnIdx: 0, role: 'draft', agentId: 'c13-shared', model: `c13-model-a-${TS}` });
  await insertRawTurnUsage(client, { projectId, sessionId, turnIdx: 1, role: 'review', agentId: 'c13-shared', model: `c13-model-b-${TS}` });

  const beforeCount = (await client.query(
    `SELECT count(*)::int AS n FROM turn_usage WHERE project_id = $1 AND session_id = $2`,
    [projectId, sessionId]
  )).rows[0].n;

  const replay = await routeResolve(client, { projectId, sessionId, turnIdx: 1, role: 'review', agentId: 'c13-shared' });
  assertEq(replay.replayed, true, 'a row already exists for this exact key -> replay branch');
  assertEq(replay.identity_conflict, true, 'the recorded row\'s own stored agent_id collides with a prior non-review row -> identity_conflict:true');
  assertEq(replay.model, `c13-model-b-${TS}`, 'replay must return the RECORDED model unchanged');

  const afterCount = (await client.query(
    `SELECT count(*)::int AS n FROM turn_usage WHERE project_id = $1 AND session_id = $2`,
    [projectId, sessionId]
  )).rows[0].n;
  assertEq(afterCount, beforeCount, 'a replay must never INSERT — row count unchanged');
}

async function testAgentIdTooLong(client) {
  const projectId = `c14-proj-${TS}`;
  const sessionId = `c14-sess-${TS}`;
  const tooLong = 'x'.repeat(257);
  await assertThrows(
    () => routeResolve(client, { projectId, sessionId, turnIdx: 0, role: 'draft', overrideModel: `c14-model-${TS}`, agentId: tooLong }),
    (err) => err instanceof RouteResolveError && err.code === 'validation' && /256/.test(err.message),
    '257-char agentId (after normLabel) must be a hard error naming the 256-char cap'
  );
}

async function testAgentIdNulByte(client) {
  const projectId = `c15-proj-${TS}`;
  const sessionId = `c15-sess-${TS}`;
  await assertThrows(
    () => routeResolve(client, { projectId, sessionId, turnIdx: 0, role: 'draft', overrideModel: `c15-model-${TS}`, agentId: `bad\u0000id` }),
    (err) => err instanceof RouteResolveError && err.code === 'validation' && /U\+0000/.test(err.message),
    'an agentId containing U+0000 must be a hard error, never silently stripped'
  );
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
      await run('C2', 'agentId: case-fold collides (Sonnet-A vs sonnet-a)', () => testCaseFoldCollides(client));
      await run('C3', 'agentId: leading/trailing/internal whitespace variants collide', () => testWhitespaceVariantsCollide(client));
      await run('C4', 'agentId: NFD vs NFC collide', () => testNfdNfcCollide(client));
      await run('C5', 'agentId: U+2010 hyphen variant does NOT collide (documented evasion vector)', () => testHyphenVariantDoesNotCollide(client));
      await run('C6', 'agentId: review with all prior agent_id NULL -> identity_enforced:false, empty-set reason', () => testEmptySetReason(client));
      await run('C7', 'agentId: absent end-to-end -> identity_enforced:false, not-supplied reason', () => testAbsentAgentIdEndToEnd(client));
      await run('C8', 'agentId: draft-only identity, same-role repeat allowed', () => testDraftOnlyIdentity(client));
      await run('C9', 'agentId: two distinct drafts then review matching the SECOND collides', () => testTwoDraftsThenReviewCollidesOnSecond(client));
      await run('C10', 'agentId: review collides against a non-draft, non-review role', () => testReviewCollidesAgainstNonDraftRole(client));
      await run('C11', 'agentId: review recorded first, draft collides (bidirectional)', () => testReviewFirstThenDraftCollidesBidirectional(client));
      await run('C12', 'agentId: review after review, same identity allowed', () => testReviewAfterReviewAllowed(client));
      await run('C13', 'agentId: replay after collision returns identity_conflict:true and inserts nothing', () => testReplayAfterCollisionReportsConflict(client));
      await run('C14', 'agentId: 257 chars (after normLabel) is a hard error', () => testAgentIdTooLong(client));
      await run('C15', 'agentId: U+0000 is a hard error', () => testAgentIdNulByte(client));
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
