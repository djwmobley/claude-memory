'use strict';

/**
 * test-verify-17.js — Test harness for scripts/lib/route-resolve.js and
 * scripts/migrations/verify-17-routing-smoke.js (the §17.4 5-point routing
 * smoke test).
 *
 * Mirrors test-migrate-schema-addenda.js's conventions: self-contained
 * scratch databases (all named to satisfy migrate-01's own classifyTarget —
 * reused by reference, never a second classifier), unconditional
 * finally-block cleanup, never touches claude_memory_eval_test, any
 * pipeline_-prefixed database, or memory_manager_staging beyond a
 * refusal-branch assertion that exits before any connection is opened.
 *
 * Two groups:
 *   A. Subprocess tests of verify-17-routing-smoke.js itself (fresh-apply
 *      PASS, prerequisite-missing FAIL naming the addenda runner, refused
 *      target names).
 *   B. Direct unit tests of scripts/lib/route-resolve.js against a live
 *      scratch database: precedence order, required-tier resolution order
 *      + unconfigured hard error, NULL-cost exclusion, deterministic
 *      tiebreak, the insert-race path (and its distinct rationale string),
 *      input validation, turnIdx=0, a directive-present + unconfigured-role
 *      case, a pin-tier-mismatch rationale case, and the string-vs-numeric
 *      cost boundary fixture (rate-sums 9 vs 10).
 *
 * Requires Postgres at PGHOST/PGUSER/PGPASSWORD (CI env) or
 * localhost/postgres, with pgvector available (migrate-01's schema files
 * depend on it).
 *
 * Usage: node test/migrations/test-verify-17.js
 * Exit 0 = all pass; nonzero = any failure.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { createRequire } = require('module');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const MIGRATE_ONE_PATH = path.join(PROJECT_ROOT, 'scripts', 'migrations', 'migrate-01-canonical-db.js');
const ADDENDA_PATH = path.join(PROJECT_ROOT, 'scripts', 'migrations', 'migrate-schema-addenda.js');
const SMOKE_PATH = path.join(PROJECT_ROOT, 'scripts', 'migrations', 'verify-17-routing-smoke.js');
const ROUTE_RESOLVE_PATH = path.join(PROJECT_ROOT, 'scripts', 'lib', 'route-resolve.js');

const routeResolveLib = require(ROUTE_RESOLVE_PATH);
const { routeResolve, recommendLeastCost, resolveRequiredTier } = routeResolveLib;
const routingWriteSurfaceLib = require(path.join(PROJECT_ROOT, 'scripts', 'lib', 'routing-write-surface.js'));
const {
  modelRegistrySet, routingSessionOverrideSet, routingSessionOverrideGet, routingSessionOverrideClear,
} = routingWriteSurfaceLib;
const routingIdentity = require(path.join(PROJECT_ROOT, 'scripts', 'lib', 'routing-identity.js'));

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

/** 3-1: every observed non-NULL cost_delta_usd must be a finite Number, never NaN/Infinity/string. */
function assertCostDeltaShape(value) {
  assert(value === null || (typeof value === 'number' && Number.isFinite(value)), `cost_delta_usd must be null or a finite number, got ${JSON.stringify(value)}`);
}

async function assertThrows(fn, msgRegex, label) {
  let threw = null;
  try {
    await fn();
  } catch (err) {
    threw = err;
  }
  assert(threw !== null, `${label || 'expected a throw'} — nothing was thrown`);
  assert(msgRegex.test(threw.message), `${label || 'error message mismatch'}: "${threw.message}" did not match ${msgRegex}`);
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

function runSmoke(args, extraEnv = {}, timeoutMs = 30000) {
  return spawnSync(process.execPath, [SMOKE_PATH, ...args], {
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

// Scratch DB names — all satisfy classifyTarget's allowed pattern (end in "_staging").
const DB_MAIN = `verify17_main_${TS}_staging`;
const DB_PERTURBED = `verify17_perturbed_${TS}_staging`;
const DB_UNIT = `verify17_unit_${TS}_staging`;
const CREATED_DBS = [DB_MAIN, DB_PERTURBED, DB_UNIT];

// ── Group A: verify-17-routing-smoke.js subprocess tests ─────────────────────

async function testSmokeFreshPass() {
  await setupFullSchema(DB_MAIN);
  const r = runSmoke(['--db', DB_MAIN]);
  assert(r.status === 0, `expected exit 0, got ${r.status}. stdout=${r.stdout} stderr=${r.stderr}`);
  assert(/SMOKE17_RESULT: PASS/.test(r.stdout), `expected the PASS summary line. stdout=${r.stdout}`);
  for (const n of [1, 2, 3, 4, 5]) {
    assert(new RegExp(`\\[SMOKE-17\\]\\[${n}\\] PASS`).test(r.stdout), `expected check ${n} to print a PASS line. stdout=${r.stdout}`);
  }
}

async function testSmokePrereqFail() {
  await setupFullSchema(DB_PERTURBED);
  const client = await pgConnect(DB_PERTURBED);
  try {
    await client.query('DROP TABLE IF EXISTS routing_profiles CASCADE');
  } finally {
    await client.end();
  }
  const r = runSmoke(['--db', DB_PERTURBED]);
  assert(r.status === 1, `expected exit 1, got ${r.status}. stdout=${r.stdout} stderr=${r.stderr}`);
  assert(/missing prerequisite table\(s\)/.test(r.stderr), `expected a prerequisite refusal. stderr=${r.stderr}`);
  assert(/routing_profiles/.test(r.stderr), `expected the missing table named. stderr=${r.stderr}`);
  assert(/migrate-schema-addenda\.js/.test(r.stderr), `expected the addenda runner named. stderr=${r.stderr}`);
  assert(/SMOKE17_RESULT: FAIL/.test(r.stdout), `expected the FAIL summary line. stdout=${r.stdout}`);
}

async function testSmokeRefusedNames() {
  const r1 = runSmoke(['--db', 'claude_memory_eval_test']);
  assert(r1.status === 1 && /claude_memory_eval_test/.test(r1.stderr) && /no database connection was opened/.test(r1.stderr),
    `expected refusal of claude_memory_eval_test before connecting. status=${r1.status} stderr=${r1.stderr}`);

  const r2 = runSmoke(['--db', 'pipeline_something']);
  assert(r2.status === 1 && /pipeline_/.test(r2.stderr),
    `expected refusal of pipeline_ names. status=${r2.status} stderr=${r2.stderr}`);

  const r3 = runSmoke(['--db', `verify17_unrecognized_${TS}_scratch`]);
  assert(r3.status === 1 && /not a recognized consolidation target/.test(r3.stderr),
    `expected refusal of an unrecognized name (total-classification default branch). status=${r3.status} stderr=${r3.stderr}`);
}

// ── Group B fixture helpers ───────────────────────────────────────────────

async function insertModel(client, { label, provider = null, tier, costIn = null, costOut = null, available = true }) {
  await client.query(
    `INSERT INTO model_registry (label, provider, capability_tier, cost_in_per_mtok, cost_out_per_mtok, available)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [label, provider, tier, costIn, costOut, available]
  );
}

async function deleteModels(client, labels) {
  if (labels.length === 0) return;
  await client.query(`DELETE FROM model_registry WHERE label = ANY($1::text[])`, [labels]);
}

async function insertProfile(client, { projectId, role, tier, preferredModel = null, preferredProvider = null, version = 1, active = true }) {
  await client.query(
    `INSERT INTO routing_profiles (project_id, role, capability_tier, preferred_model, preferred_provider, version, active)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [projectId, role, tier, preferredModel, preferredProvider, version, active]
  );
}

async function insertSessionOverride(client, { projectId, sessionId, role, modelId, provider = null }) {
  await client.query(
    `INSERT INTO routing_session_overrides (project_id, session_id, role, model_id, provider)
     VALUES ($1, $2, $3, $4, $5)`,
    [projectId, sessionId, role, modelId, provider]
  );
}

async function countTurnUsage(client, projectId, sessionId, turnIdx, role) {
  const { rows } = await client.query(
    `SELECT COUNT(*)::int AS n FROM turn_usage
      WHERE project_id = $1 AND session_id = $2 AND turn_idx = $3 AND agent_role = $4`,
    [projectId, sessionId, turnIdx, role]
  );
  return rows[0].n;
}

// ── B1: precedence order ──────────────────────────────────────────────────

async function testPrecedenceOrder(client) {
  const projectId = `b1-proj-${TS}`;
  const sessionId = `b1-sess-${TS}`;
  const role = `b1-role-${TS}`;
  const overrideModel = `b1-model-override-${TS}`;
  const sessionModel = `b1-model-session-${TS}`;
  const projectPinModel = `b1-model-projectpin-${TS}`;
  const globalPinModel = `b1-model-globalpin-${TS}`;
  const recModel = `b1-model-rec-${TS}`;

  try {
    await insertModel(client, { label: recModel, tier: 'low', costIn: 1, costOut: 1 });
    await insertProfile(client, { projectId, role, tier: 'low', version: 1 }); // tier baseline, non-directive
    await insertProfile(client, { projectId: '*', role, tier: 'low', preferredModel: globalPinModel, version: 1 });
    await insertProfile(client, { projectId, role, tier: 'low', preferredModel: projectPinModel, version: 2 });
    await insertSessionOverride(client, { projectId, sessionId, role, modelId: sessionModel });

    const r0 = await routeResolve(client, { projectId, sessionId, turnIdx: 0, role, overrideModel });
    assertEq(r0.model, overrideModel, 'overrideModel arg must win over everything');
    assertEq(r0.resolved_via, 'directive');

    const r1 = await routeResolve(client, { projectId, sessionId, turnIdx: 1, role });
    assertEq(r1.model, sessionModel, 'session override must win over project pin');

    await client.query(`DELETE FROM routing_session_overrides WHERE project_id=$1 AND session_id=$2 AND role=$3`, [projectId, sessionId, role]);
    const r2 = await routeResolve(client, { projectId, sessionId, turnIdx: 2, role });
    assertEq(r2.model, projectPinModel, 'project pin must win over global default pin');

    await client.query(`DELETE FROM routing_profiles WHERE project_id=$1 AND role=$2 AND version=2`, [projectId, role]);
    const r3 = await routeResolve(client, { projectId, sessionId, turnIdx: 3, role });
    assertEq(r3.model, globalPinModel, 'global default pin must win when no more-specific directive exists');

    await client.query(`DELETE FROM routing_profiles WHERE project_id='*' AND role=$1`, [role]);
    const r4 = await routeResolve(client, { projectId, sessionId, turnIdx: 4, role });
    assertEq(r4.resolved_via, 'recommendation', 'falls through to recommendation once no directive remains');
    assertEq(r4.model, recModel);
  } finally {
    await deleteModels(client, [overrideModel, sessionModel, projectPinModel, globalPinModel, recModel]);
  }
}

// ── B2a: source-wide "init Q&A" ban (G3) ────────────────────────────────

/**
 * route-resolve.js must name NO nonexistent "init Q&A" flow anywhere in
 * its source, not just at the one hard-error call site exercised above —
 * a source-level grep so any future re-introduction (e.g. a new error
 * message) fails this test rather than shipping silently.
 */
function testNoInitQaAnywhereInSource() {
  const src = fs.readFileSync(ROUTE_RESOLVE_PATH, 'utf8');
  const hits = src.split('\n').filter((line) => /init Q&A/.test(line));
  assert(hits.length === 0, `route-resolve.js must not name the nonexistent "init Q&A" flow anywhere; found ${hits.length} line(s): ${JSON.stringify(hits)}`);
}

// ── B2: resolveRequiredTier order + unconfigured hard error ──────────────

async function testRequiredTierOrder(client) {
  const projectId = `b2-proj-${TS}`;
  const role = `b2-role-${TS}`;

  const t1 = await resolveRequiredTier(client, { projectId, role, capabilityTier: 'high' });
  assertEq(t1, 'high', 'explicit capabilityTier arg must win outright');

  await assertThrows(
    () => resolveRequiredTier(client, { projectId, role }),
    new RegExp(`unconfigured routing for role '${role}'`),
    'unconfigured role must hard-error naming the role'
  );

  // B2b (G3): the hard-error hint must name only tools that exist today —
  // routing_profile_set — and must never point the operator at the
  // nonexistent "init Q&A" flow (docs/notes/2026-09-06-s17-routing-gap-audit.md).
  let hintErr = null;
  try {
    await resolveRequiredTier(client, { projectId, role });
  } catch (err) {
    hintErr = err;
  }
  assert(hintErr !== null, 'expected resolveRequiredTier to throw for an unconfigured role');
  assert(!/init Q&A/.test(hintErr.message), `unconfigured-role hint must not name the nonexistent "init Q&A" flow: "${hintErr.message}"`);
  assert(/routing_profile_set/.test(hintErr.message), `unconfigured-role hint must name the real routing_profile_set tool: "${hintErr.message}"`);
  // §17.1.2 (2026-09-06): the init-time routing Q&A now exists
  // (scripts/lib/routing-init-qa.js) — the hint must point operators at the
  // real, now-implemented `handoff init --routing` flow.
  assert(/handoff init --routing/.test(hintErr.message), `unconfigured-role hint must name the real "handoff init --routing" flow: "${hintErr.message}"`);

  await insertProfile(client, { projectId: '*', role, tier: 'low', version: 1 });
  await insertProfile(client, { projectId, role, tier: 'mid', version: 1 });
  const t2 = await resolveRequiredTier(client, { projectId, role });
  assertEq(t2, 'mid', 'project-specific tier must win over the global default tier');

  await client.query(`DELETE FROM routing_profiles WHERE project_id=$1 AND role=$2`, [projectId, role]);
  const t3 = await resolveRequiredTier(client, { projectId, role });
  assertEq(t3, 'low', 'falls through to the global default tier once no project-specific tier exists');
}

// ── B3: NULL-cost exclusion ────────────────────────────────────────────────

async function testNullCostExclusion(client) {
  const costlessLabel = `b3-model-costless-${TS}`;
  const costedLabel = `b3-model-costed-${TS}`;
  try {
    await insertModel(client, { label: costlessLabel, tier: 'low', costIn: null, costOut: null });
    await insertModel(client, { label: costedLabel, tier: 'low', costIn: 5, costOut: 5 });

    const rec = await recommendLeastCost(client, 'low');
    assertEq(rec.label, costedLabel, 'a NULL-cost model must be excluded from the recommendation pool even though it exists at the tier');
  } finally {
    await deleteModels(client, [costlessLabel, costedLabel]);
  }
}

// ── B4: deterministic tiebreak ─────────────────────────────────────────────

async function testDeterministicTiebreak(client) {
  const labelA = `b4-model-aaa-${TS}`;
  const labelB = `b4-model-bbb-${TS}`;
  try {
    await insertModel(client, { label: labelA, tier: 'low', costIn: 2, costOut: 2 });
    await insertModel(client, { label: labelB, tier: 'low', costIn: 2, costOut: 2 });

    const rec = await recommendLeastCost(client, 'low');
    assertEq(rec.label, labelA, 'equal-cost tie must break on label ascending');
  } finally {
    await deleteModels(client, [labelA, labelB]);
  }
}

// ── B5: empty-pool vs cost-unconfigured, distinct errors ──────────────────

async function testEmptyPoolVsCostUnconfigured(client) {
  let err1 = null;
  try {
    await recommendLeastCost(client, 'high');
  } catch (err) {
    err1 = err;
  }
  assert(err1 !== null && /no available model/i.test(err1.message), `expected the empty-pool error, got: ${err1 && err1.message}`);

  const costless = `b5-model-emptycost-${TS}`;
  try {
    await insertModel(client, { label: costless, tier: 'high', costIn: null, costOut: null });
    let err2 = null;
    try {
      await recommendLeastCost(client, 'high');
    } catch (err) {
      err2 = err;
    }
    assert(err2 !== null && /lack cost figures/i.test(err2.message), `expected the cost-unconfigured error, got: ${err2 && err2.message}`);
    assert(err2.message !== err1.message, 'the cost-unconfigured error must be DISTINCT from the empty-pool error');
    // G3: this hint must also name only real tools — no nonexistent "init Q&A" flow.
    assert(!/init Q&A/.test(err2.message), `cost-unconfigured hint must not name the nonexistent "init Q&A" flow: "${err2.message}"`);
    assert(/model_registry/.test(err2.message), `cost-unconfigured hint must name the real model_registry table: "${err2.message}"`);
  } finally {
    await deleteModels(client, [costless]);
  }
}

// ── B6: race path — a "concurrent" client wins the insert; the loser must
// return the winner's row with the distinct race-loser rationale ─────────

function makeRaceInjectingClient(realClient, injectFn) {
  let queryCount = 0;
  return {
    query: async (text, params) => {
      queryCount += 1;
      const result = await realClient.query(text, params);
      if (queryCount === 1) {
        // Right after routeResolve's very first query (the step-1 replay
        // SELECT, which finds nothing), a "concurrent" client wins the
        // race by inserting the row first — so routeResolve's own INSERT
        // (issued later in the same call) genuinely conflicts.
        await injectFn();
      }
      return result;
    },
  };
}

async function testRacePath(client, concurrentClient) {
  const projectId = `b6-proj-${TS}`;
  const sessionId = `b6-sess-${TS}`;
  const role = `b6-role-${TS}`;
  const winnerModel = `b6-model-winner-${TS}`;
  const loserModel = `b6-model-loser-${TS}`;

  const wrapped = makeRaceInjectingClient(client, async () => {
    await concurrentClient.query(
      `INSERT INTO turn_usage
         (project_id, session_id, turn_idx, agent_role, model_id, provider, resolved_via, recommended_model, cost_delta_usd)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [projectId, sessionId, 0, role, winnerModel, 'winner-provider', 'directive', null, null]
    );
  });

  const r = await routeResolve(wrapped, { projectId, sessionId, turnIdx: 0, role, overrideModel: loserModel });
  assertEq(r.model, winnerModel, "the race loser must return the winner's model, never its own");
  assertEq(r.replayed, true, 'the race loser must report replayed:true');
  assertEq(r.rationale, 'replay: lost insert race, returning winner', 'race-loser rationale must be distinct from the step-1 replay rationale');
  assertCostDeltaShape(r.cost_delta_usd);

  const n = await countTurnUsage(client, projectId, sessionId, 0, role);
  assertEq(n, 1, 'exactly one turn_usage row must exist for the key after the race');
}

// ── B7: input validation ───────────────────────────────────────────────────

async function testInputValidation(client) {
  const good = { projectId: 'x', sessionId: 'y', turnIdx: 0, role: 'z' };

  await assertThrows(() => routeResolve(client, { ...good, projectId: '' }), /projectId/, 'empty projectId');
  await assertThrows(() => routeResolve(client, { ...good, projectId: 123 }), /projectId/, 'numeric projectId');
  await assertThrows(() => routeResolve(client, { ...good, sessionId: '' }), /sessionId/, 'empty sessionId');
  await assertThrows(() => routeResolve(client, { ...good, role: '' }), /role/, 'empty role');
  await assertThrows(() => routeResolve(client, { ...good, turnIdx: -1 }), /turnIdx/, 'negative turnIdx');
  await assertThrows(() => routeResolve(client, { ...good, turnIdx: 1.5 }), /turnIdx/, 'non-integer turnIdx');
  await assertThrows(() => routeResolve(client, { ...good, turnIdx: '0' }), /turnIdx/, 'string turnIdx (never a truthy pass-through)');
  await assertThrows(() => routeResolve(client, { ...good, overrideModel: '' }), /overrideModel/, 'empty-string overrideModel');
  await assertThrows(() => routeResolve(client, { ...good, overrideModel: 42 }), /overrideModel/, 'numeric overrideModel');
  await assertThrows(() => routeResolve(client, { ...good, capabilityTier: 'ultra' }), /capabilityTier/, 'invalid capabilityTier');

  await assertThrows(() => resolveRequiredTier(client, { projectId: '', role: 'x' }), /projectId/, 'resolveRequiredTier empty projectId');
  await assertThrows(() => resolveRequiredTier(client, { projectId: 'x', role: '' }), /role/, 'resolveRequiredTier empty role');
  await assertThrows(() => resolveRequiredTier(client, { projectId: 'x', role: 'y', capabilityTier: 'nope' }), /capabilityTier/, 'resolveRequiredTier invalid capabilityTier');
  await assertThrows(() => recommendLeastCost(client, 'nope'), /valid tier/, 'recommendLeastCost invalid tier');
}

// ── B8: turnIdx=0 labeled case ─────────────────────────────────────────────

async function testTurnIdxZero(client) {
  const projectId = `b8-proj-${TS}`;
  const sessionId = `b8-sess-${TS}`;
  const role = `b8-role-${TS}`;
  const overrideModel = `b8-model-${TS}`;

  const r = await routeResolve(client, { projectId, sessionId, turnIdx: 0, role, overrideModel });
  assertEq(r.model, overrideModel);
  assertEq(r.replayed, false);

  const n = await countTurnUsage(client, projectId, sessionId, 0, role);
  assertEq(n, 1, 'turnIdx=0 must persist a real row, not be mistaken for "absent" by a truthy check');
}

// ── B9: directive present + totally unconfigured role (1-2 / 6-3) ─────────

async function testDirectivePresentUnconfiguredRole(client) {
  const projectId = `b9-proj-${TS}`;
  const sessionId = `b9-sess-${TS}`;
  const role = `b9-role-${TS}`; // no routing_profiles row anywhere for this role
  const overrideModel = `b9-model-${TS}`;

  const r = await routeResolve(client, { projectId, sessionId, turnIdx: 0, role, overrideModel });
  assertEq(r.resolved_via, 'directive');
  assertEq(r.model, overrideModel);
  assertEq(r.recommended_model, null, 'recommendation must degrade to NULL, not throw, when the role is entirely unconfigured');
  assertEq(r.cost_delta_usd, null);
}

// ── B10: pin-tier-mismatch rationale (1-3) ─────────────────────────────────

async function testPinTierMismatchRationale(client) {
  const projectId = `b10-proj-${TS}`;
  const sessionId = `b10-sess-${TS}`;
  const role = `b10-role-${TS}`;
  const pinLabel = `b10-model-pin-${TS}`;

  try {
    await insertProfile(client, { projectId, role, tier: 'high', preferredModel: pinLabel, version: 1 });
    await insertModel(client, { label: pinLabel, tier: 'low', costIn: 1, costOut: 1 }); // registered BELOW the required tier

    const r = await routeResolve(client, { projectId, sessionId, turnIdx: 0, role });
    assertEq(r.resolved_via, 'directive');
    assertEq(r.model, pinLabel);
    assert(/tier-mismatch: pin=low < required=high/.test(r.rationale), `expected the tier-mismatch flag in rationale, got: ${r.rationale}`);
  } finally {
    await deleteModels(client, [pinLabel]);
  }
}

// ── B11: string-vs-numeric cost boundary (3-1) ─────────────────────────────

async function testStringVsNumericBoundary(client) {
  const cheapLabel = `b11-model-sum9-${TS}`;    // rate-sum 9
  const pricierLabel = `b11-model-sum10-${TS}`; // rate-sum 10 -- lexicographic "10" < "9" as strings

  try {
    await insertModel(client, { label: cheapLabel, tier: 'low', costIn: 4, costOut: 5 });
    await insertModel(client, { label: pricierLabel, tier: 'low', costIn: 5, costOut: 5 });

    const rec = await recommendLeastCost(client, 'low');
    assertEq(rec.label, cheapLabel, 'numeric comparison must pick the rate-sum=9 model, not the rate-sum=10 model a naive string compare would favor');
    assert(Number.isFinite(rec.cost_in_per_mtok) && Number.isFinite(rec.cost_out_per_mtok), 'recommended cost figures must be finite JS numbers, not NUMERIC strings');
  } finally {
    await deleteModels(client, [cheapLabel, pricierLabel]);
  }
}

// ── B12: coerceCost pure unit cases (no DB) ────────────────────────────────

function testCoerceCostPure() {
  assertEq(routeResolveLib.coerceCost(null), null, 'null preserved as null');
  assertEq(routeResolveLib.coerceCost(undefined), null, 'undefined preserved as null');
  assertEq(routeResolveLib.coerceCost('9.5000'), 9.5, 'NUMERIC string coerced to a Number');
  assertEq(routeResolveLib.coerceCost('0'), 0, "'0' coerced to 0, not mistaken for null");
}

// ── Group C: §17 B1 routing write surface (model_registry_set,
// routing_session_override_set/get/clear) — CONSOLIDATION-RUNBOOK.md §17,
// 2026-09-06 spec-adversary + amended spec. ─────────────────────────────

async function assertRejects(fn, msgRegex, label) {
  let threw = null;
  try {
    await fn();
  } catch (err) {
    threw = err;
  }
  assert(threw !== null, `${label || 'expected a rejection'} — nothing was thrown`);
  assert(msgRegex.test(threw.message), `${label || 'error message mismatch'}: "${threw.message}" did not match ${msgRegex}`);
}

// ── C1: session override beats project pin ─────────────────────────────

async function testOverrideBeatsProjectPin(client) {
  const projectId = `c1-proj-${TS}`;
  const sessionId = `c1-sess-${TS}`;
  const role = `c1-role-${TS}`;
  const pinLabel = `c1-model-pin-${TS}`;
  const overrideLabel = `c1-model-override-${TS}`;

  try {
    await modelRegistrySet(client, { label: pinLabel, capabilityTier: 'low', costInPerMtok: 1, costOutPerMtok: 1 });
    await modelRegistrySet(client, { label: overrideLabel, capabilityTier: 'low', costInPerMtok: 2, costOutPerMtok: 2 });
    await insertProfile(client, { projectId, role, tier: 'low', preferredModel: pinLabel, version: 1 });

    await routingSessionOverrideSet(client, { projectId, sessionId, role, label: overrideLabel });

    const r = await routeResolve(client, { projectId, sessionId, turnIdx: 0, role });
    assertEq(r.resolved_via, 'directive');
    assertEq(r.model, overrideLabel, 'session override must win over the project pin');
    assert(/session override/.test(r.rationale), `expected rationale to name the session override, got: ${r.rationale}`);
  } finally {
    await deleteModels(client, [pinLabel, overrideLabel]);
  }
}

// ── C2: session override loses to the explicit overrideModel argument ───

async function testOverrideModelArgBeatsSessionOverride(client) {
  const projectId = `c2-proj-${TS}`;
  const sessionId = `c2-sess-${TS}`;
  const role = `c2-role-${TS}`;
  const sessionLabel = `c2-model-session-${TS}`;
  const argOverrideModel = `c2-model-argoverride-${TS}`;

  try {
    await modelRegistrySet(client, { label: sessionLabel, capabilityTier: 'low', costInPerMtok: 1, costOutPerMtok: 1 });
    await routingSessionOverrideSet(client, { projectId, sessionId, role, label: sessionLabel });

    // argOverrideModel is deliberately NOT registered — the per-turn
    // overrideModel argument wins outright regardless of registry state
    // (route-resolve.js's directive chain, step (a)).
    const r = await routeResolve(client, { projectId, sessionId, turnIdx: 0, role, overrideModel: argOverrideModel });
    assertEq(r.model, argOverrideModel, 'the per-turn overrideModel arg must win over a session override');
    assertEq(r.resolved_via, 'directive');
  } finally {
    await deleteModels(client, [sessionLabel]);
  }
}

// ── C3: cross-session isolation for session overrides ───────────────────

async function testSessionOverrideCrossSessionIsolation(client) {
  const projectId = `c3-proj-${TS}`;
  const role = `c3-role-${TS}`;
  const sessionA = `c3-sess-a-${TS}`;
  const sessionB = `c3-sess-b-${TS}`;
  const overrideLabel = `c3-model-override-${TS}`;
  const cheapLabel = `c3-model-cheap-${TS}`;

  try {
    await insertProfile(client, { projectId, role, tier: 'low' }); // tier baseline only, non-directive
    await modelRegistrySet(client, { label: overrideLabel, capabilityTier: 'low', costInPerMtok: 5, costOutPerMtok: 5 });
    await modelRegistrySet(client, { label: cheapLabel, capabilityTier: 'low', costInPerMtok: 1, costOutPerMtok: 1 });
    await routingSessionOverrideSet(client, { projectId, sessionId: sessionA, role, label: overrideLabel });

    const rA = await routeResolve(client, { projectId, sessionId: sessionA, turnIdx: 0, role });
    assertEq(rA.model, overrideLabel, 'session A must see its own override');

    const rB = await routeResolve(client, { projectId, sessionId: sessionB, turnIdx: 0, role });
    assert(rB.model !== overrideLabel, "session B must NEVER see session A's override");
    assertEq(rB.resolved_via, 'recommendation', 'session B has no override/pin of its own and must fall through to recommendation');
  } finally {
    await deleteModels(client, [overrideLabel, cheapLabel]);
  }
}

// ── C4: clear -> fallback ────────────────────────────────────────────────

async function testClearFallsBackToPin(client) {
  const projectId = `c4-proj-${TS}`;
  const sessionId = `c4-sess-${TS}`;
  const role = `c4-role-${TS}`;
  const pinLabel = `c4-model-pin-${TS}`;
  const overrideLabel = `c4-model-override-${TS}`;

  try {
    await modelRegistrySet(client, { label: pinLabel, capabilityTier: 'low', costInPerMtok: 1, costOutPerMtok: 1 });
    await modelRegistrySet(client, { label: overrideLabel, capabilityTier: 'low', costInPerMtok: 2, costOutPerMtok: 2 });
    await insertProfile(client, { projectId, role, tier: 'low', preferredModel: pinLabel, version: 1 });
    await routingSessionOverrideSet(client, { projectId, sessionId, role, label: overrideLabel });

    const r0 = await routeResolve(client, { projectId, sessionId, turnIdx: 0, role });
    assertEq(r0.model, overrideLabel);

    const clearResult = await routingSessionOverrideClear(client, { projectId, sessionId, role });
    assertEq(clearResult.cleared, true, 'clearing an existing override must report cleared:true');

    const r1 = await routeResolve(client, { projectId, sessionId, turnIdx: 1, role });
    assertEq(r1.model, pinLabel, 'after clear, resolution must fall back to the project pin');
    assertEq(r1.resolved_via, 'directive');
  } finally {
    await deleteModels(client, [pinLabel, overrideLabel]);
  }
}

// ── C5: clear on a nonexistent row -> {cleared:false}, not an error ─────

async function testClearOnMissingIsFalseNotError(client) {
  const projectId = `c5-proj-${TS}`;
  const sessionId = `c5-sess-${TS}`;
  const role = `c5-role-${TS}`;

  const result = await routingSessionOverrideClear(client, { projectId, sessionId, role });
  assertEq(result.cleared, false, 'clearing a key with no row must return cleared:false, never throw');
}

// ── C6: get lists without side effects ──────────────────────────────────

async function testGetListsWithoutSideEffects(client) {
  const projectId = `c6-proj-${TS}`;
  const sessionId = `c6-sess-${TS}`;
  const roleA = `c6-role-a-${TS}`;
  const roleB = `c6-role-b-${TS}`;
  const labelA = `c6-model-a-${TS}`;
  const labelB = `c6-model-b-${TS}`;

  try {
    await modelRegistrySet(client, { label: labelA, capabilityTier: 'low', costInPerMtok: 1, costOutPerMtok: 1 });
    await modelRegistrySet(client, { label: labelB, capabilityTier: 'low', costInPerMtok: 1, costOutPerMtok: 1 });
    await routingSessionOverrideSet(client, { projectId, sessionId, role: roleA, label: labelA });
    await routingSessionOverrideSet(client, { projectId, sessionId, role: roleB, label: labelB });

    const allRows = await routingSessionOverrideGet(client, { projectId, sessionId });
    assertEq(allRows.length, 2, 'role omitted must list every override for the session');

    const scopedRows = await routingSessionOverrideGet(client, { projectId, sessionId, role: roleA });
    assertEq(scopedRows.length, 1, 'role given must scope to exactly one row');
    assertEq(scopedRows[0].model_id, labelA);

    // Side-effect check: calling get again must return the SAME set —
    // never mutate set_at, never write turn_usage, never consume anything.
    const n = await countTurnUsage(client, projectId, sessionId, 0, roleA);
    assertEq(n, 0, 'routing_session_override_get must never write to turn_usage');
    const allRowsAgain = await routingSessionOverrideGet(client, { projectId, sessionId });
    assertEq(allRowsAgain.length, 2, 'a second get call must return the identical row count (no side effects)');
  } finally {
    await deleteModels(client, [labelA, labelB]);
  }
}

// ── C7: register -> route_resolve recommends the newly-registered model ─

async function testRegisterThenRecommend(client) {
  const projectId = `c7-proj-${TS}`;
  const sessionId = `c7-sess-${TS}`;
  const role = `c7-role-${TS}`;
  const label = `c7-model-new-${TS}`;

  try {
    await modelRegistrySet(client, { label, capabilityTier: 'low', costInPerMtok: 0.5, costOutPerMtok: 0.5 });
    await insertProfile(client, { projectId, role, tier: 'low' }); // tier baseline only, no pin

    const r = await routeResolve(client, { projectId, sessionId, turnIdx: 0, role });
    assertEq(r.resolved_via, 'recommendation');
    assertEq(r.model, label, 'the just-registered model must be recommended (sole low-tier candidate)');
  } finally {
    await deleteModels(client, [label]);
  }
}

// ── C8: partial-cost row excluded from the pool but directive-selectable ─

async function testPartialCostExcludedButDirectiveSelectable(client) {
  const projectId = `c8-proj-${TS}`;
  const sessionId = `c8-sess-${TS}`;
  const role = `c8-role-${TS}`;
  const partialLabel = `c8-model-partial-${TS}`;
  const fullLabel = `c8-model-full-${TS}`;

  try {
    // Only costInPerMtok set — costOutPerMtok stays NULL (never registered).
    await modelRegistrySet(client, { label: partialLabel, capabilityTier: 'low', costInPerMtok: 1 });
    await modelRegistrySet(client, { label: fullLabel, capabilityTier: 'low', costInPerMtok: 9, costOutPerMtok: 9 });

    const rec = await recommendLeastCost(client, 'low');
    assert(rec.label !== partialLabel, 'a partial-cost row must be excluded from the recommendation pool even though it is cheaper');
    assertEq(rec.label, fullLabel);

    // But directly overriding to the partial-cost model must still succeed —
    // directive selection performs NO cost/tier gate.
    await routingSessionOverrideSet(client, { projectId, sessionId, role, label: partialLabel });
    const r = await routeResolve(client, { projectId, sessionId, turnIdx: 0, role });
    assertEq(r.model, partialLabel, 'a partial-cost model must remain directive-selectable via a session override');
    assertEq(r.resolved_via, 'directive');
  } finally {
    await deleteModels(client, [partialLabel, fullLabel]);
  }
}

// ── C9: model_id re-point rejected without force ─────────────────────────

async function testModelIdRepointRejectedWithoutForce(client) {
  const label = `c9-model-${TS}`;
  try {
    await modelRegistrySet(client, { label, modelId: 'provider-model-v1' });

    await assertRejects(
      () => modelRegistrySet(client, { label, modelId: 'provider-model-v2' }),
      /already points to model_id/,
      'a re-point to a different modelId without force must reject'
    );

    // force:true must allow it, and record the new value.
    const forced = await modelRegistrySet(client, { label, modelId: 'provider-model-v2', force: true });
    assertEq(forced.model_id, 'provider-model-v2', 'force:true must actually apply the re-point');
  } finally {
    await deleteModels(client, [label]);
  }
}

// ── C10: duplicate model_id (two labels, same model_id) rejected ────────

async function testDuplicateModelIdRejectedWithoutForce(client) {
  const labelA = `c10-model-a-${TS}`;
  const labelB = `c10-model-b-${TS}`;
  try {
    await modelRegistrySet(client, { label: labelA, modelId: 'shared-provider-id' });

    await assertRejects(
      () => modelRegistrySet(client, { label: labelB, modelId: 'shared-provider-id' }),
      /already used by label/,
      'a second label claiming the same modelId without force must reject'
    );

    const forced = await modelRegistrySet(client, { label: labelB, modelId: 'shared-provider-id', force: true });
    assertEq(forced.model_id, 'shared-provider-id', 'force:true must allow the alias');
  } finally {
    await deleteModels(client, [labelA, labelB]);
  }
}

// ── C11: '*' rejected for session-override project/session ids ─────────

async function testStarRejectedForSessionOverrides(client) {
  const role = `c11-role-${TS}`;
  await assertRejects(
    () => routingSessionOverrideSet(client, { projectId: '*', sessionId: `c11-sess-${TS}`, role, label: `c11-model-${TS}` }),
    /projectId cannot be '\*'/,
    "projectId:'*' must reject on set"
  );
  await assertRejects(
    () => routingSessionOverrideSet(client, { projectId: `c11-proj-${TS}`, sessionId: '*', role, label: `c11-model-${TS}` }),
    /sessionId cannot be '\*'/,
    "sessionId:'*' must reject on set"
  );
  await assertRejects(
    () => routingSessionOverrideGet(client, { projectId: '*', sessionId: `c11-sess-${TS}` }),
    /projectId cannot be '\*'/,
    "projectId:'*' must reject on get"
  );
  await assertRejects(
    () => routingSessionOverrideClear(client, { projectId: '*', sessionId: `c11-sess-${TS}`, role }),
    /projectId cannot be '\*'/,
    "projectId:'*' must reject on clear"
  );
}

// ── C12: NFC/trailing-space label written then found by route_resolve ───

async function testNormalizedLabelWrittenThenFoundByRouteResolve(client) {
  const projectId = `c12-proj-${TS}`;
  const sessionId = `c12-sess-${TS}`;
  const role = `c12-role-${TS}`;
  const providerName = `c12-provider-${TS}`;

  // NFD form of "cafe" + a combining acute accent (U+0301) placed right
  // after the 'e' -- visually "café", byte-distinct from the NFC
  // precomposed form built below via String.fromCharCode. Written WITH
  // leading/trailing whitespace and an internal double space.
  const nfdWord = 'cafe' + String.fromCharCode(0x0301);
  const rawLabel = `  c12-${TS}  ${nfdWord}-model  `;

  // NFC precomposed form (byte-distinct from nfdWord above, same visual
  // string) built via String.fromCharCode(0x00e9), with no extra
  // whitespace -- what a route_resolve caller might reasonably type as an
  // overrideModel argument, unaware of exactly how the label was
  // originally registered.
  const nfcWord = 'caf' + String.fromCharCode(0x00e9);
  const lookupForm = `c12-${TS} ${nfcWord}-model`;

  const normalizedLabel = routingIdentity.normLabel(rawLabel);
  assertEq(normalizedLabel, routingIdentity.normLabel(lookupForm), 'the raw write form and the lookup form must normalize to the SAME canonical label (sanity check on the fixture itself)');

  try {
    const written = await modelRegistrySet(client, { label: rawLabel, provider: providerName, capabilityTier: 'low', costInPerMtok: 1, costOutPerMtok: 1 });
    assertEq(written.label, normalizedLabel, 'model_registry_set must store the NORMALIZED label, not the raw messy input');

    // route_resolve must find the registry row (and its provider) via a
    // directive using the DIFFERENT-but-equivalent lookup form -- proving
    // the write-time and read-time normalization agree.
    const r = await routeResolve(client, { projectId, sessionId, turnIdx: 0, role, overrideModel: lookupForm });
    assertEq(r.model, lookupForm, "the directive's model field echoes the caller's overrideModel verbatim (only the REGISTRY LOOKUP is normalized, not what's echoed back)");
    assertEq(r.provider, providerName, 'route_resolve must resolve the provider from model_registry despite the NFD/whitespace form the label was originally written with');
  } finally {
    await deleteModels(client, [normalizedLabel]);
  }
}

// ── Main ───────────────────────────────────────────────────────────────────

async function main() {
  try {
    await run('A1', 'verify-17-routing-smoke.js: fresh apply -> exit 0, SMOKE17_RESULT: PASS, all 5 checks PASS', testSmokeFreshPass);
    await run('A2', 'verify-17-routing-smoke.js: routing_profiles dropped -> prerequisite check FAILs loudly, names the addenda runner', testSmokePrereqFail);
    await run('A3', 'verify-17-routing-smoke.js: refused target names (total-classification default branch)', testSmokeRefusedNames);

    await setupFullSchema(DB_UNIT);
    const client = await pgConnect(DB_UNIT);
    const concurrentClient = await pgConnect(DB_UNIT);
    try {
      await run('B12', 'coerceCost: pure unit cases (NULL-preserving NUMERIC-string coercion)', async () => testCoerceCostPure());
      await run('B2a', 'route-resolve.js source: never names the nonexistent "init Q&A" flow anywhere (G3, source-wide grep)', async () => testNoInitQaAnywhereInSource());
      await run('B1', 'precedence order: override > session override > project pin > global pin > recommendation', () => testPrecedenceOrder(client));
      await run('B2', 'resolveRequiredTier: explicit arg > project tier > global tier; unconfigured -> hard error', () => testRequiredTierOrder(client));
      await run('B3', 'recommendLeastCost: NULL-cost models excluded from the recommendation pool', () => testNullCostExclusion(client));
      await run('B4', 'recommendLeastCost: equal-cost tiebreak resolves on label ascending', () => testDeterministicTiebreak(client));
      await run('B5', 'recommendLeastCost: empty-pool and cost-unconfigured are distinct errors', () => testEmptyPoolVsCostUnconfigured(client));
      await run('B6', 'routeResolve: insert-race loser returns the winner\'s row with the distinct race-loser rationale', () => testRacePath(client, concurrentClient));
      await run('B7', 'routeResolve: input validation errors (projectId/sessionId/role/turnIdx/overrideModel/capabilityTier)', () => testInputValidation(client));
      await run('B8', 'routeResolve: turnIdx=0 is a valid, persisted first-turn value (never a truthy-check miss)', () => testTurnIdxZero(client));
      await run('B9', 'routeResolve: directive present + totally unconfigured role -> succeeds, recommendation fields degrade to NULL', () => testDirectivePresentUnconfiguredRole(client));
      await run('B10', 'routeResolve: a registered pin below the required tier is flagged in rationale (tier-fit bypass is intentional)', () => testPinTierMismatchRationale(client));
      await run('B11', 'recommendLeastCost: string-vs-numeric cost boundary (rate-sums 9 vs 10) resolves numerically correct', () => testStringVsNumericBoundary(client));

      await run('C1', '§17 B1: session override beats project pin', () => testOverrideBeatsProjectPin(client));
      await run('C2', '§17 B1: the per-turn overrideModel argument beats a session override', () => testOverrideModelArgBeatsSessionOverride(client));
      await run('C3', '§17 B1: session overrides are isolated per session (never leak to a different session)', () => testSessionOverrideCrossSessionIsolation(client));
      await run('C4', '§17 B1: clearing a session override falls back to the project pin', () => testClearFallsBackToPin(client));
      await run('C5', '§17 B1: clearing a nonexistent override returns {cleared:false}, never throws', () => testClearOnMissingIsFalseNotError(client));
      await run('C6', '§17 B1: routing_session_override_get lists without side effects', () => testGetListsWithoutSideEffects(client));
      await run('C7', '§17 B1: a newly-registered model is recommended by route_resolve with no directive', () => testRegisterThenRecommend(client));
      await run('C8', '§17 B1: a partial-cost model is excluded from the recommendation pool but stays directive-selectable', () => testPartialCostExcludedButDirectiveSelectable(client));
      await run('C9', '§17 B1: re-pointing an existing non-NULL model_id is rejected without force:true', () => testModelIdRepointRejectedWithoutForce(client));
      await run('C10', '§17 B1: a duplicate model_id (two labels) is rejected without force:true', () => testDuplicateModelIdRejectedWithoutForce(client));
      await run('C11', "§17 B1: '*' is rejected for session-override project_id/session_id on set/get/clear", () => testStarRejectedForSessionOverrides(client));
      await run('C12', '§17 B1: an NFC/trailing-space-normalized label written via model_registry_set is found by route_resolve under a differently-formatted equivalent form', () => testNormalizedLabelWrittenThenFoundByRouteResolve(client));
    } finally {
      await client.end();
      await concurrentClient.end();
    }
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
