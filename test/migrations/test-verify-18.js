'use strict';

/**
 * test-verify-18.js — Test harness for scripts/lib/usage-telemetry.js and
 * scripts/migrations/verify-18-usage-smoke.js (the §18 usage-telemetry
 * smoke test).
 *
 * Mirrors test-verify-17.js's conventions: self-contained scratch databases
 * (all named to satisfy migrate-01's own classifyTarget — reused by
 * reference, never a second classifier), unconditional finally-block
 * cleanup, never touches claude_memory_eval_test, any pipeline_-prefixed
 * database, or memory_manager_staging beyond a refusal-branch assertion
 * that exits before any connection is opened.
 *
 * Two groups:
 *   A. Subprocess tests of verify-18-usage-smoke.js itself (fresh-apply
 *      PASS with all 9 checks, prerequisite-missing FAIL naming the addenda
 *      runner, refused target names).
 *   B. Direct unit tests of scripts/lib/usage-telemetry.js against a live
 *      scratch database, covering every ADVERSARY-PASS AMENDMENT semantic
 *      the smoke script doesn't already pin: the field-preservation matrix
 *      (A-1), the costUsd three-state machine (A-2/A-5), every cost
 *      fail-soft branch, the outcome DDL-default discipline across
 *      insert/update (A-4), a genuine concurrent-insert race (A-6), the
 *      token ceiling (A-18), the reserved "(none)" sentinel defense on both
 *      the record path and the rollup/query read paths (A-9), rollup
 *      NULL-SUM semantics on a non-cost fixture, the zero-turn rollup
 *      (A-17), "(none)" grouping keys, project-scope staleness, groupBy
 *      total classification, pure coerceNumeric/round6 cases, a genuine
 *      concurrent rollup (A-11), and the cost-range guard (post-review
 *      fix): cost_usd/total_cost_usd are NUMERIC(12,6) -- a caller-supplied
 *      or server-computed cost that is a real, finite number but exceeds
 *      999999.999999 now throws a named CostOutOfRangeError before any
 *      write, rather than either a silent NULL or a raw unhandled Postgres
 *      "numeric field overflow", covering the caller-supplied path, the
 *      server-computed path (the originally-reported repro: tokens near
 *      Number.MAX_SAFE_INTEGER against a priced model, both fresh-key and
 *      existing-row-left-unchanged cases), and the rollup aggregate path.
 *
 * Requires Postgres at PGHOST/PGUSER/PGPASSWORD (CI env) or
 * localhost/postgres, with pgvector available (migrate-01's schema files
 * depend on it).
 *
 * Usage: node test/migrations/test-verify-18.js
 * Exit 0 = all pass; nonzero = any failure.
 */

const path = require('path');
const { spawnSync } = require('child_process');
const { createRequire } = require('module');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const MIGRATE_ONE_PATH = path.join(PROJECT_ROOT, 'scripts', 'migrations', 'migrate-01-canonical-db.js');
const ADDENDA_PATH = path.join(PROJECT_ROOT, 'scripts', 'migrations', 'migrate-schema-addenda.js');
const SMOKE_PATH = path.join(PROJECT_ROOT, 'scripts', 'migrations', 'verify-18-usage-smoke.js');
const USAGE_TELEMETRY_PATH = path.join(PROJECT_ROOT, 'scripts', 'lib', 'usage-telemetry.js');

const usageTelemetryLib = require(USAGE_TELEMETRY_PATH);
const { usageRecord, sessionUsageRollup, usageQuery, coerceNumeric, round6, MAX_NUMERIC_12_6, CostOutOfRangeError } = usageTelemetryLib;

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
const DB_MAIN = `verify18_main_${TS}_staging`;
const DB_PERTURBED = `verify18_perturbed_${TS}_staging`;
const DB_UNIT = `verify18_unit_${TS}_staging`;
const CREATED_DBS = [DB_MAIN, DB_PERTURBED, DB_UNIT];

// ── Group A: verify-18-usage-smoke.js subprocess tests ───────────────────────

async function testSmokeFreshPass() {
  await setupFullSchema(DB_MAIN);
  const r = runSmoke(['--db', DB_MAIN]);
  assert(r.status === 0, `expected exit 0, got ${r.status}. stdout=${r.stdout} stderr=${r.stderr}`);
  assert(/SMOKE18_RESULT: PASS/.test(r.stdout), `expected the PASS summary line. stdout=${r.stdout}`);
  for (const n of [1, 2, 3, 4, 5, 6, 7, 8, 9]) {
    assert(new RegExp(`\\[SMOKE-18\\]\\[${n}\\] PASS`).test(r.stdout), `expected check ${n} to print a PASS line. stdout=${r.stdout}`);
  }
}

async function testSmokePrereqFail() {
  await setupFullSchema(DB_PERTURBED);
  const client = await pgConnect(DB_PERTURBED);
  try {
    await client.query('DROP TABLE IF EXISTS session_usage CASCADE');
  } finally {
    await client.end();
  }
  const r = runSmoke(['--db', DB_PERTURBED]);
  assert(r.status === 1, `expected exit 1, got ${r.status}. stdout=${r.stdout} stderr=${r.stderr}`);
  assert(/missing prerequisite table\(s\)/.test(r.stderr), `expected a prerequisite refusal. stderr=${r.stderr}`);
  assert(/session_usage/.test(r.stderr), `expected the missing table named. stderr=${r.stderr}`);
  assert(/migrate-schema-addenda\.js/.test(r.stderr), `expected the addenda runner named. stderr=${r.stderr}`);
  assert(/SMOKE18_RESULT: FAIL/.test(r.stdout), `expected the FAIL summary line. stdout=${r.stdout}`);
}

async function testSmokeRefusedNames() {
  const r1 = runSmoke(['--db', 'claude_memory_eval_test']);
  assert(r1.status === 1 && /claude_memory_eval_test/.test(r1.stderr) && /no database connection was opened/.test(r1.stderr),
    `expected refusal of claude_memory_eval_test before connecting. status=${r1.status} stderr=${r1.stderr}`);

  const r2 = runSmoke(['--db', 'pipeline_something']);
  assert(r2.status === 1 && /pipeline_/.test(r2.stderr),
    `expected refusal of pipeline_ names. status=${r2.status} stderr=${r2.stderr}`);

  // migration-target-per-project-marker (owner decision item G, 2026-09-06):
  // an unrecognized name now goes through migrate-01's marker probe; this
  // caller never passes --project-id, so the probe's "absent" precondition
  // is the reason that surfaces (still pre-connect).
  const r3 = runSmoke(['--db', `verify18_unrecognized_${TS}_scratch`]);
  assert(r3.status === 1 &&
    /no --project-id supplied; per-project engine targets require it/.test(r3.stderr) &&
    /no database connection was opened/.test(r3.stderr),
    `expected refusal of an unrecognized name (total-classification default branch). status=${r3.status} stderr=${r3.stderr}`);
}

// ── Group B fixture helpers ───────────────────────────────────────────────

async function insertModel(client, { label, provider = null, tier, costIn = null, costOut = null }) {
  await client.query(
    `INSERT INTO model_registry (label, provider, capability_tier, cost_in_per_mtok, cost_out_per_mtok, available)
     VALUES ($1, $2, $3, $4, $5, true)`,
    [label, provider, tier, costIn, costOut]
  );
}

async function countTurnUsage(client, projectId, sessionId, turnIdx, agentRole) {
  const { rows } = await client.query(
    `SELECT COUNT(*)::int AS n FROM turn_usage
      WHERE project_id = $1 AND session_id = $2 AND turn_idx = $3 AND agent_role = $4`,
    [projectId, sessionId, turnIdx, agentRole]
  );
  return rows[0].n;
}

async function countSessionUsageRows(client, projectId, sessionId) {
  const { rows } = await client.query(
    `SELECT COUNT(*)::int AS n FROM session_usage WHERE project_id = $1 AND session_id = $2`,
    [projectId, sessionId]
  );
  return rows[0].n;
}

// ── B1: field-preservation matrix (A-1) ────────────────────────────────────

async function testFieldPreservationMatrix(client) {
  const projectId = `b1-proj-${TS}`;
  const sessionId = `b1-sess-${TS}`;
  const modelX = `b1-model-x-${TS}`;
  const modelY = `b1-model-y-${TS}`;

  const baseline = {
    modelId: modelX, provider: 'prov-x', tokensIn: 10, tokensOut: 20,
    cacheReadTokens: 1, cacheWriteTokens: 2, costUsd: 5,
    outcome: 'success', sourceModel: 'src-x', agentId: 'agent-x',
  };
  const overrides = {
    modelId: modelY, provider: 'prov-y', tokensIn: 99, tokensOut: 88,
    cacheReadTokens: 7, cacheWriteTokens: 8, outcome: 'failure',
    sourceModel: 'src-y', agentId: 'agent-y',
  };
  const preservedFields = Object.keys(overrides); // costUsd has different semantics (A-2), covered in B2

  for (const field of preservedFields) {
    const role = `b1-role-${field}-${TS}`;
    await usageRecord(client, { projectId, sessionId, turnIdx: 0, agentRole: role, ...baseline });
    const updated = await usageRecord(client, { projectId, sessionId, turnIdx: 0, agentRole: role, costUsd: baseline.costUsd, [field]: overrides[field] });
    assertEq(updated[field], overrides[field], `${field}: a provided value must overwrite`);
    for (const other of preservedFields) {
      if (other === field) continue;
      assertEq(updated[other], baseline[other], `updating "${field}" must preserve baseline "${other}"`);
    }
  }
}

// ── B2: costUsd three-state machine (A-2/A-5) ──────────────────────────────

async function testCostThreeStateMachine(client) {
  const projectId = `b2-proj-${TS}`;
  const sessionId = `b2-sess-${TS}`;
  const role = `b2-role-${TS}`;
  const model = `b2-model-${TS}`;
  await insertModel(client, { label: model, tier: 'low', costIn: 1, costOut: 1 });

  const r1 = await usageRecord(client, { projectId, sessionId, turnIdx: 0, agentRole: role, modelId: model, tokensIn: 1000000, tokensOut: 1000000 });
  assertEq(round6(r1.costUsd), 2, 'omitted costUsd must compute server-side');

  const r2 = await usageRecord(client, { projectId, sessionId, turnIdx: 1, agentRole: role, modelId: model, tokensIn: 1000000, tokensOut: 1000000, costUsd: null });
  assertEq(r2.costUsd, null, 'explicit null costUsd must force NULL even when server-side computation would succeed');

  const r3 = await usageRecord(client, { projectId, sessionId, turnIdx: 2, agentRole: role, modelId: model, tokensIn: 1000000, tokensOut: 1000000, costUsd: 42 });
  assertEq(r3.costUsd, 42, 'explicit finite costUsd must be used verbatim, ignoring server-side computation');

  await assertThrows(() => usageRecord(client, { projectId, sessionId, turnIdx: 3, agentRole: role, costUsd: -1 }), /costUsd/, 'negative costUsd rejected');
  await assertThrows(() => usageRecord(client, { projectId, sessionId, turnIdx: 3, agentRole: role, costUsd: NaN }), /costUsd/, 'NaN costUsd rejected');
  await assertThrows(() => usageRecord(client, { projectId, sessionId, turnIdx: 3, agentRole: role, costUsd: Infinity }), /costUsd/, 'Infinity costUsd rejected');
  await assertThrows(() => usageRecord(client, { projectId, sessionId, turnIdx: 3, agentRole: role, costUsd: '5' }), /costUsd/, 'string costUsd rejected');
}

// ── B3: cost fail-soft branches ────────────────────────────────────────────

async function testCostFailSoftBranches(client) {
  const projectId = `b3-proj-${TS}`;
  const sessionId = `b3-sess-${TS}`;
  const role = `b3-role-${TS}`;

  const r1 = await usageRecord(client, { projectId, sessionId, turnIdx: 0, agentRole: role, tokensIn: 10, tokensOut: 10 });
  assertEq(r1.costUsd, null, 'no effective model -> NULL cost, never fabricated');

  const r2 = await usageRecord(client, { projectId, sessionId, turnIdx: 1, agentRole: role, modelId: `b3-unreg-${TS}`, tokensIn: 10, tokensOut: 10 });
  assertEq(r2.costUsd, null, 'unregistered model -> NULL cost');

  const costlessModel = `b3-costless-${TS}`;
  await insertModel(client, { label: costlessModel, tier: 'low', costIn: null, costOut: null });
  const r3 = await usageRecord(client, { projectId, sessionId, turnIdx: 2, agentRole: role, modelId: costlessModel, tokensIn: 10, tokensOut: 10 });
  assertEq(r3.costUsd, null, 'registered model with NULL rates -> NULL cost (V9 gap)');

  const registeredModel = `b3-registered-${TS}`;
  await insertModel(client, { label: registeredModel, tier: 'low', costIn: 1, costOut: 1 });
  const r4 = await usageRecord(client, { projectId, sessionId, turnIdx: 3, agentRole: role, modelId: registeredModel });
  assertEq(r4.costUsd, null, 'missing effective token counts -> NULL cost, never fabricated from a partial basis');

  await usageRecord(client, { projectId, sessionId, turnIdx: 4, agentRole: role, modelId: registeredModel, tokensIn: 100, tokensOut: 100, costUsd: 999 });
  const r5 = await usageRecord(client, { projectId, sessionId, turnIdx: 4, agentRole: role }); // costUsd omitted -> recompute from the pre-existing row's model/tokens
  assertEq(round6(r5.costUsd), round6((100 * 1 + 100 * 1) / 1e6), "server-side compute must use the pre-existing row's model/tokens when the call omits them");
}

// ── B4: outcome DDL-default discipline across insert/update (A-4) ─────────

async function testOutcomeDdlDefaultDiscipline(client) {
  const projectId = `b4-proj-${TS}`;
  const sessionId = `b4-sess-${TS}`;
  const role = `b4-role-${TS}`;

  const r1 = await usageRecord(client, { projectId, sessionId, turnIdx: 0, agentRole: role, tokensIn: 1, tokensOut: 1 });
  assertEq(r1.outcome, 'unknown', 'fresh insert with outcome omitted must take the DDL default');

  const r2 = await usageRecord(client, { projectId, sessionId, turnIdx: 0, agentRole: role, tokensIn: 2, tokensOut: 2 });
  assertEq(r2.outcome, 'unknown', 'update with outcome omitted must preserve the existing value, not re-null it');

  const r3 = await usageRecord(client, { projectId, sessionId, turnIdx: 0, agentRole: role, outcome: 'success' });
  assertEq(r3.outcome, 'success', 'explicit outcome must overwrite');

  const r4 = await usageRecord(client, { projectId, sessionId, turnIdx: 0, agentRole: role, tokensIn: 3 });
  assertEq(r4.outcome, 'success', 'a subsequent call that omits outcome must not null out the previously recorded outcome (A-1)');

  await assertThrows(() => usageRecord(client, { projectId, sessionId, turnIdx: 1, agentRole: role, outcome: 'bogus' }), /outcome/, 'invalid outcome value rejected');
}

// ── B5: concurrent-insert race (A-6) ───────────────────────────────────────

async function testConcurrentInsertRace(client, concurrentClient) {
  const projectId = `b5-proj-${TS}`;
  const sessionId = `b5-sess-${TS}`;
  const role = `b5-role-${TS}`;

  const [r1, r2] = await Promise.all([
    usageRecord(client, { projectId, sessionId, turnIdx: 0, agentRole: role, tokensIn: 10, tokensOut: 10, costUsd: 1 }),
    usageRecord(concurrentClient, { projectId, sessionId, turnIdx: 0, agentRole: role, tokensIn: 20, tokensOut: 20, costUsd: 2 }),
  ]);

  assert(!(r1.created && r2.created), 'at most one of two concurrent inserts for the same key can be the physical INSERT');
  assert(r1.created || r2.created, 'at least one of two concurrent inserts for the same key must be the physical INSERT');

  const n = await countTurnUsage(client, projectId, sessionId, 0, role);
  assertEq(n, 1, 'exactly one turn_usage row must exist for the key after the race');
}

// ── B6: token ceiling (A-18) ────────────────────────────────────────────────

async function testTokenCeiling(client) {
  const projectId = `b6-proj-${TS}`;
  const sessionId = `b6-sess-${TS}`;
  const role = `b6-role-${TS}`;

  const r = await usageRecord(client, { projectId, sessionId, turnIdx: 0, agentRole: role, tokensIn: Number.MAX_SAFE_INTEGER });
  assertEq(r.tokensIn, Number.MAX_SAFE_INTEGER, 'MAX_SAFE_INTEGER must be accepted (boundary)');

  await assertThrows(() => usageRecord(client, { projectId, sessionId, turnIdx: 1, agentRole: role, tokensIn: Number.MAX_SAFE_INTEGER + 2 }), /tokensIn/, 'above MAX_SAFE_INTEGER rejected');
  await assertThrows(() => usageRecord(client, { projectId, sessionId, turnIdx: 1, agentRole: role, tokensOut: -1 }), /tokensOut/, 'negative tokensOut rejected');
  await assertThrows(() => usageRecord(client, { projectId, sessionId, turnIdx: 1, agentRole: role, cacheReadTokens: 1.5 }), /cacheReadTokens/, 'non-integer cacheReadTokens rejected');
}

// ── B7: reserved "(none)" sentinel defense, both write and read paths (A-9) ─

async function testReservedNoneSentinelDefense(client) {
  const projectId = `b7-proj-${TS}`;
  const sessionId = `b7-sess-${TS}`;
  const role = `b7-role-${TS}`;

  await assertThrows(() => usageRecord(client, { projectId, sessionId, turnIdx: 0, agentRole: role, modelId: '(none)' }), /\(none\)/, 'modelId="(none)" rejected at record time (A-9)');

  // A genuinely NULL-model row is fine.
  await usageRecord(client, { projectId, sessionId, turnIdx: 0, agentRole: role, tokensIn: 1, tokensOut: 1 });

  // Bypass the API with a direct SQL insert to simulate an anomalous row.
  await client.query(
    `INSERT INTO turn_usage (project_id, session_id, turn_idx, agent_role, model_id, tokens_in, tokens_out)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [projectId, sessionId, 1, role, '(none)', 1, 1]
  );

  await assertThrows(() => sessionUsageRollup(client, { projectId, sessionId }), /reserved model_id sentinel/, 'rollup must error on a directly-inserted "(none)" row');
  await assertThrows(() => usageQuery(client, { projectId, sessionId, groupBy: 'model' }), /reserved model_id sentinel/, 'session-scoped query must error on a directly-inserted "(none)" row');
}

// ── B8: rollup NULL-SUM semantics (non-cost fixture) ────────────────────────

async function testRollupNullSumSemantics(client) {
  const projectId = `b8-proj-${TS}`;
  const sessionId = `b8-sess-${TS}`;
  const role = `b8-role-${TS}`;

  await usageRecord(client, { projectId, sessionId, turnIdx: 0, agentRole: role }); // no tokens, no cost at all
  await usageRecord(client, { projectId, sessionId, turnIdx: 1, agentRole: role, costUsd: null });

  const rollup = await sessionUsageRollup(client, { projectId, sessionId });
  assertEq(rollup.turnCount, 2, 'turn_count must count rows regardless of NULL measurements');
  assertEq(rollup.totalTokensIn, null, 'total_tokens_in must be NULL, not 0, when every contributing value is NULL');
  assertEq(rollup.totalTokensOut, null, 'total_tokens_out must be NULL, not 0, when every contributing value is NULL');
  assertEq(rollup.totalCostUsd, null, 'total_cost_usd must be NULL, not 0, when every contributing value is NULL');
}

// ── B9: zero-turn rollup (A-17) ──────────────────────────────────────────────

async function testZeroTurnRollup(client) {
  const projectId = `b9-proj-${TS}`;
  const sessionId = `b9-sess-${TS}`; // no turn_usage rows ever written for this key

  const rollup = await sessionUsageRollup(client, { projectId, sessionId });
  assertEq(rollup.turnCount, 0, 'zero-turn rollup must record turn_count=0, a visible row, never a silent no-op');
  assertEq(rollup.totalTokensIn, null);
  assertEq(rollup.totalTokensOut, null);
  assertEq(rollup.totalCostUsd, null);
  assertEq(Object.keys(rollup.modelBreakdown).length, 0, 'model_breakdown must be an empty object, not fabricated entries');

  const n = await countSessionUsageRows(client, projectId, sessionId);
  assertEq(n, 1, 'the zero-turn rollup must still UPSERT a real, visible session_usage row');
}

// ── B10: "(none)" grouping keys ──────────────────────────────────────────────

async function testNoneGroupingKeys(client) {
  const projectId = `b10-proj-${TS}`;
  const sessionId = `b10-sess-${TS}`;
  const role = `b10-role-${TS}`;

  await usageRecord(client, { projectId, sessionId, turnIdx: 0, agentRole: role, tokensIn: 5, tokensOut: 5, costUsd: 1 }); // modelId NULL, provider NULL

  const byModel = await usageQuery(client, { projectId, sessionId, groupBy: 'model' });
  assertEq(byModel.length, 1);
  assertEq(byModel[0].key, '(none)', 'NULL model_id must group under the literal "(none)" key');

  const byProvider = await usageQuery(client, { projectId, sessionId, groupBy: 'provider' });
  assertEq(byProvider.length, 1);
  assertEq(byProvider[0].key, '(none)', 'NULL provider must group under the literal "(none)" key');

  const rollup = await sessionUsageRollup(client, { projectId, sessionId });
  assert(Object.prototype.hasOwnProperty.call(rollup.modelBreakdown, '(none)'), 'rollup model_breakdown must key the NULL-model group as "(none)"');
}

// ── B11: staleness of project scope (dedicated unit) ───────────────────────

async function testProjectScopeStaleness(client) {
  const projectId = `b11-proj-${TS}`;
  const sessionId = `b11-sess-${TS}`;
  const role = `b11-role-${TS}`;
  const model = `b11-model-${TS}`;

  await usageRecord(client, { projectId, sessionId, turnIdx: 0, agentRole: role, modelId: model, tokensIn: 1, tokensOut: 1, costUsd: 1 });

  const before = await usageQuery(client, { projectId, groupBy: 'model' });
  assert(!before.some((r) => r.key === model), 'a session with no rollup yet must be invisible to the project-scoped view');

  await sessionUsageRollup(client, { projectId, sessionId });

  const after = await usageQuery(client, { projectId, groupBy: 'model' });
  assert(after.some((r) => r.key === model), 'the session must become visible once its rollup has run');
}

// ── B12: groupBy total classification ──────────────────────────────────────

async function testGroupByTotalClassification(client) {
  const projectId = `b12-proj-${TS}`;
  const sessionId = `b12-sess-${TS}`;
  const role = `b12-role-${TS}`;

  await usageRecord(client, { projectId, sessionId, turnIdx: 0, agentRole: role, tokensIn: 1, tokensOut: 1, costUsd: 1 });

  for (const gb of ['model', 'role', 'provider', 'day']) {
    const rows = await usageQuery(client, { projectId, sessionId, groupBy: gb });
    assert(Array.isArray(rows), `session-scoped groupBy=${gb} must return an array`);
  }

  await assertThrows(() => usageQuery(client, { projectId, sessionId, groupBy: 'bogus' }), /groupBy/, 'invalid groupBy hard-errors (total classification)');
  await assertThrows(() => usageQuery(client, { projectId, groupBy: 'provider' }), /groupBy='model' only/, 'project-scope groupBy=provider hard-errors');
  await assertThrows(() => usageQuery(client, { projectId, groupBy: 'day' }), /groupBy='model' only/, 'project-scope groupBy=day hard-errors');

  const defaulted = await usageQuery(client, { projectId, sessionId }); // groupBy omitted -> default 'model'
  assert(Array.isArray(defaulted), 'omitted groupBy must default to model, not error');
}

// ── B13: coerceNumeric / round6 pure unit cases (no DB) ────────────────────

function testCoerceNumericPure() {
  assertEq(coerceNumeric(null), null, 'null preserved as null');
  assertEq(coerceNumeric(undefined), null, 'undefined preserved as null');
  assertEq(coerceNumeric('9.500000'), 9.5, 'NUMERIC string coerced to a Number');
  assertEq(coerceNumeric('0'), 0, "'0' coerced to 0, not mistaken for null");
  assertEq(coerceNumeric('123456789012'), 123456789012, 'BIGINT string coerced to a Number');
  assertEq(coerceNumeric(7), 7, 'a plain JSONB-parsed number passes through unchanged');
  assertEq(round6(1.23456789), 1.234568, 'round6 rounds to 6dp');
  assertEq(round6(null), null, 'round6 preserves null');
}

// ── B14: concurrent rollup (A-11) ────────────────────────────────────────────

async function testConcurrentRollup(client, concurrentClient) {
  const projectId = `b14-proj-${TS}`;
  const sessionId = `b14-sess-${TS}`;
  const role = `b14-role-${TS}`;
  const model = `b14-model-${TS}`;

  await usageRecord(client, { projectId, sessionId, turnIdx: 0, agentRole: role, modelId: model, tokensIn: 10, tokensOut: 10, costUsd: 1 });
  await usageRecord(client, { projectId, sessionId, turnIdx: 1, agentRole: role, modelId: model, tokensIn: 20, tokensOut: 20, costUsd: 2 });

  const [r1, r2] = await Promise.all([
    sessionUsageRollup(client, { projectId, sessionId }),
    sessionUsageRollup(concurrentClient, { projectId, sessionId }),
  ]);
  assert(r1 && r2, 'two overlapping rollup calls must not error');

  const fresh = await sessionUsageRollup(client, { projectId, sessionId });
  const rowCount = await countSessionUsageRows(client, projectId, sessionId);
  assertEq(rowCount, 1, 'concurrent rollups must never duplicate the session_usage row');
  assertEq(fresh.turnCount, 2, 'the final row must equal a fresh single recompute');
  assertEq(round6(fresh.totalCostUsd), 3);
}

// ── B15: cost-range guard — caller-supplied costUsd (reviewer defect fix) ──
// cost_usd / total_cost_usd are NUMERIC(12,6): max magnitude 999999.999999.
// A value that IS a real, finite number but exceeds that bound must now be
// a named validation failure (CostOutOfRangeError), not a silent NULL and
// not a raw unhandled Postgres "numeric field overflow".

async function testCostRangeGuardCallerSupplied(client) {
  const projectId = `b15-proj-${TS}`;
  const sessionId = `b15-sess-${TS}`;
  const role = `b15-role-${TS}`;

  const r = await usageRecord(client, { projectId, sessionId, turnIdx: 0, agentRole: role, costUsd: MAX_NUMERIC_12_6 });
  assertEq(r.costUsd, MAX_NUMERIC_12_6, 'a cost value exactly at the NUMERIC(12,6) bound must succeed');

  let threw = null;
  try {
    await usageRecord(client, { projectId, sessionId, turnIdx: 1, agentRole: role, costUsd: MAX_NUMERIC_12_6 + 0.000001 });
  } catch (err) {
    threw = err;
  }
  assert(threw !== null, 'a caller-supplied cost just above the bound must throw');
  assert(threw instanceof CostOutOfRangeError, `expected a CostOutOfRangeError instance, got ${threw.constructor.name}`);
  assert(/out of range for NUMERIC\(12,6\)/.test(threw.message), `expected the named-error message shape, got: ${threw.message}`);
  const n = await countTurnUsage(client, projectId, sessionId, 1, role);
  assertEq(n, 0, 'no row may be written when the caller-supplied cost overflows -- validated before any SQL executes');

  await assertThrows(
    () => usageRecord(client, { projectId, sessionId, turnIdx: 2, agentRole: role, costUsd: 5000000 }),
    /out of range for NUMERIC\(12,6\)/,
    'a grossly out-of-range caller-supplied cost must also throw'
  );
}

// ── B16: cost-range guard — server-computed cost (the reviewer's exact
// repro: tokens near Number.MAX_SAFE_INTEGER x a priced model). Covers both
// a fresh key (no row at all afterward) and an existing row (the row's
// prior state must be completely UNCHANGED after the failed overflowing
// update, not partially applied). ─────────────────────────────────────────

async function testCostRangeGuardServerComputed(client) {
  const projectId = `b16-proj-${TS}`;
  const sessionId = `b16-sess-${TS}`;
  const role = `b16-role-${TS}`;
  const model = `b16-model-${TS}`;
  await insertModel(client, { label: model, tier: 'low', costIn: 1, costOut: 1 });

  // Fresh key: no row at all after the failed call.
  let threw1 = null;
  try {
    await usageRecord(client, { projectId, sessionId, turnIdx: 0, agentRole: role, modelId: model, tokensIn: Number.MAX_SAFE_INTEGER, tokensOut: Number.MAX_SAFE_INTEGER });
  } catch (err) {
    threw1 = err;
  }
  assert(threw1 !== null, 'reviewer scenario: near-MAX_SAFE_INTEGER tokens x priced model must throw');
  assert(threw1 instanceof CostOutOfRangeError, `expected a CostOutOfRangeError instance, got ${threw1.constructor.name}`);
  assert(/out of range for NUMERIC\(12,6\)/.test(threw1.message), `expected the named-error message shape, got: ${threw1.message}`);
  const n = await countTurnUsage(client, projectId, sessionId, 0, role);
  assertEq(n, 0, 'no row may be written for a fresh key when the computed cost overflows');

  // Existing row: a subsequent overflowing update must leave every field exactly as it was.
  const baseline = await usageRecord(client, { projectId, sessionId, turnIdx: 1, agentRole: role, modelId: model, tokensIn: 10, tokensOut: 10, costUsd: 5 });
  let threw2 = null;
  try {
    await usageRecord(client, { projectId, sessionId, turnIdx: 1, agentRole: role, tokensIn: Number.MAX_SAFE_INTEGER, tokensOut: Number.MAX_SAFE_INTEGER });
  } catch (err) {
    threw2 = err;
  }
  assert(threw2 !== null && threw2 instanceof CostOutOfRangeError, 'an overflowing update on an existing row must also throw CostOutOfRangeError');
  const { rows } = await client.query(
    `SELECT tokens_in, tokens_out, cost_usd, model_id FROM turn_usage WHERE project_id=$1 AND session_id=$2 AND turn_idx=1 AND agent_role=$3`,
    [projectId, sessionId, role]
  );
  assertEq(coerceNumeric(rows[0].tokens_in), baseline.tokensIn, "the row's tokens_in must be UNCHANGED after a failed overflowing update");
  assertEq(coerceNumeric(rows[0].tokens_out), baseline.tokensOut, "the row's tokens_out must be UNCHANGED after a failed overflowing update");
  assertEq(coerceNumeric(rows[0].cost_usd), baseline.costUsd, "the row's cost_usd must be UNCHANGED after a failed overflowing update");
  assertEq(rows[0].model_id, baseline.modelId, "the row's model_id must be UNCHANGED after a failed overflowing update");
}

// ── B17: cost-range guard — rollup path. Individually in-range costs whose
// SUM overflows total_cost_usd must surface CostOutOfRangeError (caught and
// rethrown from Postgres's own 22003), never a raw driver error, and never
// a partially-written session_usage row. ───────────────────────────────────

async function testCostRangeGuardRollupPath(client) {
  const projectId = `b17-proj-${TS}`;
  const sessionId = `b17-sess-${TS}`;
  const role = `b17-role-${TS}`;

  await usageRecord(client, { projectId, sessionId, turnIdx: 0, agentRole: role, costUsd: 700000 });
  await usageRecord(client, { projectId, sessionId, turnIdx: 1, agentRole: role, costUsd: 700000 });

  let threw = null;
  try {
    await sessionUsageRollup(client, { projectId, sessionId });
  } catch (err) {
    threw = err;
  }
  assert(threw !== null, 'expected the rollup to throw when the aggregate exceeds NUMERIC(12,6)');
  assert(threw instanceof CostOutOfRangeError, `expected a CostOutOfRangeError instance, got ${threw.constructor.name}`);
  assert(/out of range for NUMERIC\(12,6\)/.test(threw.message), `expected the named-error message shape, got: ${threw.message}`);

  const sessionUsageRowCount = await countSessionUsageRows(client, projectId, sessionId);
  assertEq(sessionUsageRowCount, 0, 'no session_usage row may exist when the rollup aggregate overflows');

  const turnRowCount = await countTurnUsage(client, projectId, sessionId, 0, role);
  assertEq(turnRowCount, 1, 'the individual turn_usage rows themselves are untouched by a failed rollup');
}

// ── Main ───────────────────────────────────────────────────────────────────

async function main() {
  try {
    await run('A1', 'verify-18-usage-smoke.js: fresh apply -> exit 0, SMOKE18_RESULT: PASS, all 9 checks PASS', testSmokeFreshPass);
    await run('A2', 'verify-18-usage-smoke.js: session_usage dropped -> prerequisite check FAILs loudly, names the addenda runner', testSmokePrereqFail);
    await run('A3', 'verify-18-usage-smoke.js: refused target names (total-classification default branch)', testSmokeRefusedNames);

    await setupFullSchema(DB_UNIT);
    const client = await pgConnect(DB_UNIT);
    const concurrentClient = await pgConnect(DB_UNIT);
    try {
      await run('B13', 'coerceNumeric/round6: pure unit cases', async () => testCoerceNumericPure());
      await run('B1', 'usageRecord: field-preservation matrix — every field individually overwrites when provided, preserves when omitted (A-1)', () => testFieldPreservationMatrix(client));
      await run('B2', 'usageRecord: costUsd three-state machine — compute/force-null/verbatim/hard-error (A-2/A-5)', () => testCostThreeStateMachine(client));
      await run('B3', 'usageRecord: server-side cost fail-soft branches — no model, unregistered, NULL rates, missing tokens, existing-row basis', () => testCostFailSoftBranches(client));
      await run('B4', 'usageRecord: outcome DDL-default discipline across insert/update, never re-nulled by omission (A-1/A-4)', () => testOutcomeDdlDefaultDiscipline(client));
      await run('B5', 'usageRecord: genuine concurrent-insert race for the same key — no throw, exactly one row, preservation rule holds (A-6)', () => testConcurrentInsertRace(client, concurrentClient));
      await run('B6', 'usageRecord: token ceiling — MAX_SAFE_INTEGER boundary accepted, above rejected, negative/non-integer rejected (A-18)', () => testTokenCeiling(client));
      await run('B7', 'usage-telemetry: reserved "(none)" sentinel rejected at record time; rollup/query error on a directly-inserted anomalous row (A-9)', () => testReservedNoneSentinelDefense(client));
      await run('B8', 'sessionUsageRollup: NULL-SUM semantics on a non-cost fixture — all totals NULL, never 0', () => testRollupNullSumSemantics(client));
      await run('B9', 'sessionUsageRollup: zero-turn rollup — visible row, turn_count=0, totals NULL, model_breakdown={} (A-17)', () => testZeroTurnRollup(client));
      await run('B10', 'usage-telemetry: NULL model_id/provider group under the literal "(none)" key in both query and rollup breakdown', () => testNoneGroupingKeys(client));
      await run('B11', 'usageQuery: project-scoped view is stale-by-design until sessionUsageRollup runs', () => testProjectScopeStaleness(client));
      await run('B12', 'usageQuery: groupBy total classification — 4 valid session-scoped values, invalid hard-errors, project-scope model-only restriction, default', () => testGroupByTotalClassification(client));
      await run('B14', 'sessionUsageRollup: genuine concurrent rollup calls — no throw, no duplicate row, final state equals a fresh recompute (A-11)', () => testConcurrentRollup(client, concurrentClient));
      await run('B15', 'usageRecord: cost-range guard — caller-supplied costUsd at/above NUMERIC(12,6) bound (named CostOutOfRangeError, no row written)', () => testCostRangeGuardCallerSupplied(client));
      await run('B16', 'usageRecord: cost-range guard — server-computed cost overflow (reviewer repro: near-MAX_SAFE_INTEGER tokens x priced model); fresh key and existing-row-unchanged cases', () => testCostRangeGuardServerComputed(client));
      await run('B17', 'sessionUsageRollup: cost-range guard — in-range costs whose SUM overflows total_cost_usd rethrows the same named error, no partial row', () => testCostRangeGuardRollupPath(client));
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
