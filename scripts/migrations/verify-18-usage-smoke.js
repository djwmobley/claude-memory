'use strict';

/**
 * verify-18-usage-smoke.js
 *
 * Operator-run CLI, the §18 usage-telemetry smoke test. Exercises
 * scripts/lib/usage-telemetry.js's usageRecord/sessionUsageRollup/usageQuery
 * against a live target database, including composing with
 * scripts/lib/route-resolve.js's routeResolve (check 1 -- the §18-side proof
 * the two libs work together on the same turn_usage key).
 *
 * CLI CONVENTIONS -- identical to verify-17-routing-smoke.js: --db flag,
 * then MIGRATE_TARGET_DB env, then memory_manager_staging built-in default.
 * Reuses migrate-01-canonical-db.js's own resolveTargetDb / classifyTarget /
 * DB_NAME_RE / pgConfig by import (never forked). Refusal is a total
 * classification and runs BEFORE any database connection is opened. Never
 * reads HANDOFF_DB.
 *
 * PREREQUISITE CHECK (A-14): covers ALL tables this run transitively
 * touches, not only the two tables usage-telemetry.js itself writes --
 * turn_usage, session_usage, model_registry (usage-telemetry.js), PLUS
 * routing_profiles and routing_session_overrides (touched indirectly via
 * check 1's routeResolve call). A missing table is a loud FAIL naming
 * migrate-schema-addenda.js, exit 1, before any fixture work begins.
 *
 * TRANSACTION ISOLATION -- identical posture to verify-17-routing-smoke.js
 * (ADVERSARY-PASS AMENDMENT 4-1/4-2/4-3, and this issue's own A-15): the
 * entire fixture-and-check lifecycle runs inside ONE transaction on ONE
 * connection, via the shared harness in ./lib/smoke-harness.js -- BEGIN, an
 * in-transaction `DELETE FROM model_registry` (the only table ever wiped;
 * makes the least-cost recommendation pool deterministic for check 1's
 * routeResolve call), run-prefixed fixture inserts, all checks through that
 * same client, then ROLLBACK always -- success or failure. turn_usage and
 * session_usage are NEVER wiped, only prefix-residue-scanned post-rollback
 * (A-15) -- a live target's real telemetry rows are never touched.
 *
 * Every smoke project/session id, role, and model label carries the
 * `smoke18-<random-suffix>` prefix generated once per run (via the shared
 * harness's makeRunPrefix).
 *
 * Usage:
 *   node scripts/migrations/verify-18-usage-smoke.js [--db <name>]
 *
 * Exit codes: 0 = all checks PASS, 1 = refused / prerequisite missing / any
 * check FAIL, 2 = bad CLI usage.
 */

const { Client } = require('pg');

const migrateOne = require('./migrate-01-canonical-db');
const { routeResolve } = require('../lib/route-resolve');
const { usageRecord, sessionUsageRollup, usageQuery } = require('../lib/usage-telemetry');
const smokeHarness = require('./lib/smoke-harness');

// ─── Prerequisite tables (A-14) -- every table this run transitively
// touches, not only the two usage-telemetry.js itself writes. ────────────

const PREREQUISITE_TABLES = ['turn_usage', 'session_usage', 'model_registry', 'routing_profiles', 'routing_session_overrides'];

// Only model_registry is ever wiped (A-15).
const WIPE_TABLES = ['model_registry'];

// Post-rollback residue-scan specs (A-15) -- turn_usage/session_usage are
// scanned (never wiped); model_registry is scanned as well even though it
// is also wiped, as defense-in-depth against a check that inserted after
// the wipe and somehow survived the rollback.
const RESIDUE_SPECS = [
  { table: 'model_registry', where: 'label LIKE $1' },
  { table: 'turn_usage', where: 'project_id LIKE $1' },
  { table: 'session_usage', where: 'project_id LIKE $1' },
];

// ─── CLI ARGS ──────────────────────────────────────────────────────────────

class UsageError extends Error {}

function parseArgs(argv) {
  const parsed = { db: null, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--db') {
      parsed.db = argv[++i];
    } else if (a.startsWith('--db=')) {
      parsed.db = a.slice('--db='.length);
    } else if (a === '--help' || a === '-h') {
      parsed.help = true;
    } else {
      throw new UsageError(`Unknown argument: ${a}`);
    }
  }
  if (parsed.db === undefined || parsed.db === '') {
    throw new UsageError('--db requires a value');
  }
  return parsed;
}

function printUsage() {
  console.log([
    'Usage: node scripts/migrations/verify-18-usage-smoke.js [--db <name>]',
    '',
    '  --db <name>  Target database name (else MIGRATE_TARGET_DB env, else',
    '               memory_manager_staging). Never reads HANDOFF_DB. Runs',
    '               entirely inside one transaction that is always rolled',
    '               back -- safe to run against a live staging database.',
  ].join('\n'));
}

// ─── Fixture helpers ───────────────────────────────────────────────────────

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

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function assertEq(actual, expected, msg) {
  if (actual !== expected) {
    throw new Error(`${msg || 'assertion failed'} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
  }
}

/** Every observed non-NULL cost must be a finite JS number, never NaN/Infinity/string (A-7). */
function assertCostShape(value) {
  assert(value === null || (typeof value === 'number' && Number.isFinite(value)), `cost value must be null or a finite number, got ${JSON.stringify(value)}`);
}

/** A-7/A-13: round both sides to 6dp before comparing cost values. */
function round6(x) {
  return x === null || x === undefined ? null : Math.round(x * 1e6) / 1e6;
}

async function assertThrows(fn, msgRegex, label) {
  let threw = null;
  try {
    await fn();
  } catch (err) {
    threw = err;
  }
  assert(threw !== null, `${label || 'expected a throw'} -- nothing was thrown`);
  assert(msgRegex.test(threw.message), `${label || 'error message mismatch'}: "${threw.message}" did not match ${msgRegex}`);
}

/** SQL SUM semantics for hand-computing an expected aggregation from a fixture list -- NULL+NULL=NULL, otherwise NULLs ignored. */
function sumNullSafe(a, b) {
  if (a === null && (b === null || b === undefined)) return null;
  return (a || 0) + (b || 0);
}

/** Independently aggregate a fixture list by `keyFn`, mirroring usageQuery's SUM/COUNT semantics -- used so smoke assertions never re-run the same SQL the code under test runs. */
function aggregateFixtures(fixtures, keyFn) {
  const map = new Map();
  for (const f of fixtures) {
    const key = keyFn(f);
    const acc = map.get(key) || { tokens_in: null, tokens_out: null, cost_usd: null, turns: 0 };
    acc.tokens_in = sumNullSafe(acc.tokens_in, f.tokensIn);
    acc.tokens_out = sumNullSafe(acc.tokens_out, f.tokensOut);
    acc.cost_usd = sumNullSafe(acc.cost_usd, f.costUsd);
    acc.turns += 1;
    map.set(key, acc);
  }
  return map;
}

function assertAggregationMatches(actualRows, expectedMap, label) {
  const actualByKey = new Map(actualRows.map((r) => [r.key, r]));
  assertEq(actualByKey.size, expectedMap.size, `${label}: expected ${expectedMap.size} group(s), got ${actualByKey.size}`);
  for (const [key, expected] of expectedMap) {
    const actual = actualByKey.get(key);
    assert(actual, `${label}: expected a group for key ${JSON.stringify(key)}`);
    assertEq(actual.tokens_in, expected.tokens_in, `${label}: tokens_in mismatch for ${key}`);
    assertEq(actual.tokens_out, expected.tokens_out, `${label}: tokens_out mismatch for ${key}`);
    assertEq(round6(actual.cost_usd), round6(expected.cost_usd), `${label}: cost_usd mismatch for ${key}`);
    assertEq(actual.turns, expected.turns, `${label}: turns mismatch for ${key}`);
  }
}

// ─── The checks ──────────────────────────────────────────────────────────

// CHECK 1: RECORD-AFTER-RESOLVE -- routeResolve creates the row (also the
// §18-side proof the two libs compose); usageRecord then UPDATEs it with
// tokens. A-14: capabilityTier passed explicitly, bypassing profile lookup
// -- simplest fixture, no routing_profiles row needed.
async function checkRecordAfterResolve(client, PREFIX) {
  const projectId = `${PREFIX}-proj-c1`;
  const sessionId = `${PREFIX}-sess-c1`;
  const role = `${PREFIX}-role-c1`;
  const modelLabel = `${PREFIX}-model-c1`;

  await insertModel(client, { label: modelLabel, tier: 'low', costIn: 1, costOut: 1 });

  const resolved = await routeResolve(client, { projectId, sessionId, turnIdx: 0, role, capabilityTier: 'low' });
  assert(resolved.resolved_via === 'recommendation', `expected resolved_via='recommendation', got ${resolved.resolved_via}`);
  assert(resolved.model === modelLabel, `expected the recommendation to pick ${modelLabel}, got ${resolved.model}`);

  const recorded = await usageRecord(client, {
    projectId, sessionId, turnIdx: 0, agentRole: role,
    tokensIn: 100, tokensOut: 50, costUsd: 1.234567,
  });

  assert(recorded.created === false, `expected created:false on the update-after-resolve path, got ${recorded.created}`);
  assertEq(recorded.tokensIn, 100, 'tokensIn must land');
  assertEq(recorded.tokensOut, 50, 'tokensOut must land');
  assertEq(recorded.resolvedVia, 'recommendation', 'resolved_via must be untouched by usageRecord');
  assertEq(recorded.recommendedModel, modelLabel, 'recommended_model must be untouched by usageRecord');
  assertCostShape(recorded.costDeltaUsd);
  assertEq(recorded.costDeltaUsd, resolved.cost_delta_usd, 'cost_delta_usd must be untouched by usageRecord');

  const n = await countTurnUsage(client, projectId, sessionId, 0, role);
  assertEq(n, 1, 'exactly 1 row must exist for the key');
}

// CHECK 2: RECORD-WITHOUT-RESOLVE -- usageRecord on a fresh key -> created:true,
// resolved_via NULL, DDL-default outcome (A-4).
async function checkRecordWithoutResolve(client, PREFIX) {
  const projectId = `${PREFIX}-proj-c2`;
  const sessionId = `${PREFIX}-sess-c2`;
  const role = `${PREFIX}-role-c2`;

  const recorded = await usageRecord(client, {
    projectId, sessionId, turnIdx: 0, agentRole: role,
    tokensIn: 10, tokensOut: 5,
  });

  assert(recorded.created === true, `expected created:true on a fresh key, got ${recorded.created}`);
  assertEq(recorded.resolvedVia, null, 'resolved_via must be NULL for a resolve-less row');
  assertEq(recorded.outcome, 'unknown', 'DDL-default outcome must be "unknown" on an outcome-omitted fresh insert (A-4)');

  const n = await countTurnUsage(client, projectId, sessionId, 0, role);
  assertEq(n, 1);
}

// CHECK 3: SERVER-SIDE COST both ways -- registered model with rates -> cost
// equals a hand-computed value at a digit-count boundary (A-7/A-13);
// unregistered model -> cost_usd NULL, never 0, never NaN.
async function checkServerSideCost(client, PREFIX) {
  const projectId = `${PREFIX}-proj-c3`;
  const sessionId = `${PREFIX}-sess-c3`;
  const role = `${PREFIX}-role-c3`;
  const registeredModel = `${PREFIX}-model-c3-registered`;
  const unregisteredModel = `${PREFIX}-model-c3-unregistered`;

  await insertModel(client, { label: registeredModel, tier: 'low', costIn: 3.5, costOut: 7.25 });

  const tokensIn = 1000000;
  const tokensOut = 2000000;
  // (1,000,000*3.5 + 2,000,000*7.25) / 1e6 = 18.0 -- exact at NUMERIC(12,6).
  const expected = round6((tokensIn * 3.5 + tokensOut * 7.25) / 1e6);

  const recorded = await usageRecord(client, {
    projectId, sessionId, turnIdx: 0, agentRole: role,
    modelId: registeredModel, tokensIn, tokensOut,
  });
  assertCostShape(recorded.costUsd);
  assertEq(round6(recorded.costUsd), expected, `server-side cost mismatch: expected ${expected}, got ${recorded.costUsd}`);

  const recordedUnregistered = await usageRecord(client, {
    projectId, sessionId, turnIdx: 1, agentRole: role,
    modelId: unregisteredModel, tokensIn: 500, tokensOut: 500,
  });
  assertCostShape(recordedUnregistered.costUsd);
  assert(recordedUnregistered.costUsd === null, `expected NULL cost for an unregistered model, got ${recordedUnregistered.costUsd}`);
}

// CHECK 4: UPDATE-NOT-DUPLICATE -- second usageRecord on the same key updates
// in place; provided modelId overwrites, omitted tokensOut preserved.
async function checkUpdateNotDuplicate(client, PREFIX) {
  const projectId = `${PREFIX}-proj-c4`;
  const sessionId = `${PREFIX}-sess-c4`;
  const role = `${PREFIX}-role-c4`;
  const modelA = `${PREFIX}-model-c4-a`;
  const modelB = `${PREFIX}-model-c4-b`;

  const r1 = await usageRecord(client, { projectId, sessionId, turnIdx: 0, agentRole: role, modelId: modelA, tokensIn: 10, tokensOut: 10, costUsd: 1 });
  assert(r1.created === true, 'first call for a fresh key must be created:true');

  const r2 = await usageRecord(client, { projectId, sessionId, turnIdx: 0, agentRole: role, modelId: modelB, tokensIn: 20, costUsd: 2 });
  assert(r2.created === false, 'second call for the same key must be an update, not a fresh insert');
  assertEq(r2.modelId, modelB, 'provided modelId must overwrite');
  assertEq(r2.tokensIn, 20, 'provided tokensIn must overwrite');
  assertEq(r2.tokensOut, 10, 'omitted tokensOut must be preserved from the first call');

  const n = await countTurnUsage(client, projectId, sessionId, 0, role);
  assertEq(n, 1, 'exactly 1 row must exist after two calls to the same key');
}

// CHECK 5: SESSION-SCOPED QUERY -- >=2 models, >=2 roles, one NULL-model
// turn; usageQuery each dimension matches an independently hand-computed
// aggregation.
async function checkSessionScopedQuery(client, PREFIX) {
  const projectId = `${PREFIX}-proj-c5`;
  const sessionId = `${PREFIX}-sess-c5`;
  const roleA = `${PREFIX}-role-c5-a`;
  const roleB = `${PREFIX}-role-c5-b`;
  const modelA = `${PREFIX}-model-c5-a`;
  const modelB = `${PREFIX}-model-c5-b`;

  const fixtures = [
    { turnIdx: 0, agentRole: roleA, modelId: modelA, tokensIn: 100, tokensOut: 50, costUsd: 1.5 },
    { turnIdx: 1, agentRole: roleA, modelId: modelB, tokensIn: 200, tokensOut: 100, costUsd: 3.0 },
    { turnIdx: 2, agentRole: roleB, modelId: modelA, tokensIn: 50, tokensOut: 25, costUsd: 0.75 },
    { turnIdx: 3, agentRole: roleB, modelId: null, tokensIn: 10, tokensOut: 5, costUsd: null },
  ];

  for (const f of fixtures) {
    await usageRecord(client, { projectId, sessionId, agentRole: f.agentRole, turnIdx: f.turnIdx, modelId: f.modelId, tokensIn: f.tokensIn, tokensOut: f.tokensOut, costUsd: f.costUsd });
  }

  const byModel = aggregateFixtures(fixtures, (f) => (f.modelId === null ? '(none)' : f.modelId));
  const byRole = aggregateFixtures(fixtures, (f) => f.agentRole);

  const resultsByModel = await usageQuery(client, { projectId, sessionId, groupBy: 'model' });
  assertAggregationMatches(resultsByModel, byModel, 'groupBy=model');

  const resultsByRole = await usageQuery(client, { projectId, sessionId, groupBy: 'role' });
  assertAggregationMatches(resultsByRole, byRole, 'groupBy=role');

  // A-12: day is computed once, in SQL, in UTC, from row-creation time --
  // never re-derived driver-side. All fixtures were inserted "now", so a
  // correct implementation groups them into exactly one day-bucket whose
  // key is an ISO date string, with totals equal to the fixture set's own sum.
  const resultsByDay = await usageQuery(client, { projectId, sessionId, groupBy: 'day' });
  assertEq(resultsByDay.length, 1, `expected exactly 1 day-group for fixtures all inserted "now", got ${resultsByDay.length}`);
  assert(/^\d{4}-\d{2}-\d{2}$/.test(resultsByDay[0].key), `expected an ISO date string day key, got ${JSON.stringify(resultsByDay[0].key)}`);
  const totalTokensIn = fixtures.reduce((s, f) => s + f.tokensIn, 0);
  const totalTokensOut = fixtures.reduce((s, f) => s + f.tokensOut, 0);
  const totalCost = fixtures.reduce((s, f) => sumNullSafe(s, f.costUsd), null);
  assertEq(resultsByDay[0].tokens_in, totalTokensIn, 'day-group tokens_in must sum the whole fixture set');
  assertEq(resultsByDay[0].tokens_out, totalTokensOut, 'day-group tokens_out must sum the whole fixture set');
  assertEq(round6(resultsByDay[0].cost_usd), round6(totalCost), 'day-group cost_usd must sum the whole fixture set (NULL-preserving)');
  assertEq(resultsByDay[0].turns, fixtures.length, 'day-group turns must count the whole fixture set');
}

// CHECK 6: ROLLUP + PROJECT-SCOPED QUERY -- staleness before rollup; totals
// match after; model_breakdown shape; re-rollup updates not duplicates.
async function checkRollupAndProjectScopedQuery(client, PREFIX) {
  const projectId = `${PREFIX}-proj-c6`;
  const sessionId = `${PREFIX}-sess-c6`;
  const role = `${PREFIX}-role-c6`;
  const modelA = `${PREFIX}-model-c6-a`;
  const modelB = `${PREFIX}-model-c6-b`;

  await usageRecord(client, { projectId, sessionId, turnIdx: 0, agentRole: role, modelId: modelA, tokensIn: 100, tokensOut: 50, costUsd: 2 });
  await usageRecord(client, { projectId, sessionId, turnIdx: 1, agentRole: role, modelId: modelB, tokensIn: 200, tokensOut: 100, costUsd: 3 });

  // STALENESS (documented + smoke-asserted): before any rollup has run, the
  // project-scoped view must not see this session at all.
  const beforeRollup = await usageQuery(client, { projectId, groupBy: 'model' });
  assert(!beforeRollup.some((r) => r.key === modelA || r.key === modelB), 'project-scoped view must be invisible before sessionUsageRollup runs (staleness-by-design)');

  const rollup1 = await sessionUsageRollup(client, { projectId, sessionId });
  assertEq(rollup1.turnCount, 2, 'rollup turn_count must equal the number of turn_usage rows');
  assertEq(round6(rollup1.totalCostUsd), 5, 'rollup total_cost_usd must sum both turns');

  const sessionScoped = await usageQuery(client, { projectId, sessionId, groupBy: 'model' });
  const afterRollup = await usageQuery(client, { projectId, groupBy: 'model' });

  for (const row of sessionScoped) {
    const projRow = afterRollup.find((r) => r.key === row.key);
    assert(projRow, `expected project-scoped view to include model ${row.key} after rollup`);
    assertEq(round6(projRow.cost_usd), round6(row.cost_usd), `project-scoped cost must match session-scoped aggregation for ${row.key}`);
    assertEq(projRow.tokens_in, row.tokens_in, `project-scoped tokens_in must match session-scoped aggregation for ${row.key}`);
    assertEq(projRow.turns, row.turns, `project-scoped turns must match session-scoped aggregation for ${row.key}`);
  }

  const bdA = rollup1.modelBreakdown[modelA];
  assert(
    bdA && typeof bdA.tokens_in === 'number' && typeof bdA.tokens_out === 'number' && typeof bdA.cost_usd === 'number' && typeof bdA.turns === 'number',
    'model_breakdown entry must match the { tokens_in, tokens_out, cost_usd, turns } shape with real JS numbers'
  );

  await usageRecord(client, { projectId, sessionId, turnIdx: 2, agentRole: role, modelId: modelA, tokensIn: 10, tokensOut: 10, costUsd: 1 });
  const rollup2 = await sessionUsageRollup(client, { projectId, sessionId });
  assertEq(rollup2.turnCount, 3, 'rollup2 must reflect the third turn');

  const rowCount = await countSessionUsageRows(client, projectId, sessionId);
  assertEq(rowCount, 1, 'session_usage must be updated in place, never duplicated (UNIQUE on project_id, session_id)');
}

// CHECK 7: VALIDATION + TOTAL CLASSIFICATION -- bad outcome, bad groupBy,
// project-scope groupBy='role' (documented hard error), turnIdx=0 accepted,
// negative tokens rejected, reserved "(none)" modelId rejected (A-9).
async function checkValidationAndTotalClassification(client, PREFIX) {
  const projectId = `${PREFIX}-proj-c7`;
  const sessionId = `${PREFIX}-sess-c7`;
  const role = `${PREFIX}-role-c7`;

  await assertThrows(() => usageRecord(client, { projectId, sessionId, turnIdx: 0, agentRole: role, outcome: 'bogus' }), /outcome/, 'bad outcome value');
  await assertThrows(() => usageQuery(client, { projectId, sessionId, groupBy: 'bogus' }), /groupBy/, 'bad groupBy value');
  await assertThrows(() => usageQuery(client, { projectId, groupBy: 'role' }), /groupBy='model' only/, 'project-scope groupBy=role must hard-error naming the model-only restriction');
  await assertThrows(() => usageRecord(client, { projectId, sessionId, turnIdx: 0, agentRole: role, tokensIn: -1 }), /tokensIn/, 'negative tokens rejected');
  await assertThrows(() => usageRecord(client, { projectId, sessionId, turnIdx: 0, agentRole: role, modelId: '(none)' }), /\(none\)/, 'reserved "(none)" sentinel rejected as modelId (A-9)');

  const r = await usageRecord(client, { projectId, sessionId, turnIdx: 0, agentRole: role, tokensIn: 1, tokensOut: 1 });
  assertEq(r.turnIdx, 0, 'turnIdx=0 must be accepted, not mistaken for absent by a truthy check');
}

// CHECK 8: ALL-NULL-COST GROUP (A-10) -- a NAMED smoke check, not just a
// unit test: a fixture group whose every cost_usd is NULL must yield NULL
// aggregate cost -- never 0 -- in session-scoped query, rollup totals, AND
// the model_breakdown entry.
async function checkAllNullCostGroup(client, PREFIX) {
  const projectId = `${PREFIX}-proj-c8`;
  const sessionId = `${PREFIX}-sess-c8`;
  const role = `${PREFIX}-role-c8`;
  const modelLabel = `${PREFIX}-model-c8`;

  await usageRecord(client, { projectId, sessionId, turnIdx: 0, agentRole: role, modelId: modelLabel, tokensIn: 10, tokensOut: 10, costUsd: null });
  await usageRecord(client, { projectId, sessionId, turnIdx: 1, agentRole: role, modelId: modelLabel, tokensIn: 20, tokensOut: 20, costUsd: null });

  const sessionRows = await usageQuery(client, { projectId, sessionId, groupBy: 'model' });
  const group = sessionRows.find((r) => r.key === modelLabel);
  assert(group, 'expected a group for the all-NULL-cost model');
  assert(group.cost_usd === null, `expected NULL aggregate cost_usd for an all-NULL-cost group, got ${group.cost_usd}`);
  assertEq(group.tokens_in, 30, 'token sums must still aggregate normally even when cost is all-NULL');

  const rollup = await sessionUsageRollup(client, { projectId, sessionId });
  assert(rollup.totalCostUsd === null, `expected NULL total_cost_usd when every contributing cost is NULL, got ${rollup.totalCostUsd}`);
  const breakdownEntry = rollup.modelBreakdown[modelLabel];
  assert(breakdownEntry, 'expected a model_breakdown entry for the all-NULL-cost model');
  assert(breakdownEntry.cost_usd === null, `expected NULL cost_usd in the model_breakdown entry, got ${breakdownEntry.cost_usd}`);
}

// ─── Runner ────────────────────────────────────────────────────────────────

async function checkPrerequisites(client) {
  const { rows } = await client.query(
    `SELECT table_name FROM information_schema.tables
      WHERE table_schema = current_schema() AND table_type = 'BASE TABLE'`
  );
  const actual = new Set(rows.map((r) => r.table_name.toLowerCase()));
  const missing = PREREQUISITE_TABLES.filter((t) => !actual.has(t));
  return { ok: missing.length === 0, missing };
}

async function main() {
  let parsed;
  try {
    parsed = parseArgs(process.argv.slice(2));
  } catch (err) {
    if (err instanceof UsageError) {
      console.error(`Error: ${err.message}`);
      printUsage();
      process.exit(2);
    }
    throw err;
  }

  if (parsed.help) {
    printUsage();
    process.exit(0);
  }

  const { name: target, source } = migrateOne.resolveTargetDb(parsed);

  if (!migrateOne.DB_NAME_RE.test(target)) {
    console.error(`Invalid database name "${target}" (from ${source}) — must match /^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/.`);
    process.exit(1);
  }

  const classification = migrateOne.classifyTarget(target);
  if (!classification.allowed) {
    console.error(`Refused: ${classification.reason}`);
    console.error(`(resolved from ${source} — no database connection was opened.)`);
    process.exit(1);
  }

  console.log(`verify-18-usage-smoke: target="${target}" (resolved from ${source})`);

  const client = new Client(migrateOne.pgConfig(target));
  try {
    await client.connect();
  } catch (err) {
    console.error(`Could not connect to target database "${target}": ${err.message}`);
    process.exit(1);
  }

  const PREFIX = smokeHarness.makeRunPrefix('18');
  console.log(`  run prefix: ${PREFIX}`);

  try {
    const prereq = await checkPrerequisites(client);
    if (!prereq.ok) {
      console.error(`Refused: target "${target}" is missing prerequisite table(s): ${prereq.missing.join(', ')}.`);
      console.error('Run migrate-schema-addenda.js against this target first to stand up the routing/telemetry schema, then re-run this smoke test.');
      smokeHarness.printSummary('18', false);
      process.exitCode = 1;
      return;
    }

    let overallOk = await smokeHarness.withTransactionRollback(client, WIPE_TABLES, async () => {
      const results = [];
      results.push(await smokeHarness.runCheck('18', 1, 'RECORD-AFTER-RESOLVE', () => checkRecordAfterResolve(client, PREFIX)));
      results.push(await smokeHarness.runCheck('18', 2, 'RECORD-WITHOUT-RESOLVE', () => checkRecordWithoutResolve(client, PREFIX)));
      results.push(await smokeHarness.runCheck('18', 3, 'SERVER-SIDE COST', () => checkServerSideCost(client, PREFIX)));
      results.push(await smokeHarness.runCheck('18', 4, 'UPDATE-NOT-DUPLICATE', () => checkUpdateNotDuplicate(client, PREFIX)));
      results.push(await smokeHarness.runCheck('18', 5, 'SESSION-SCOPED QUERY', () => checkSessionScopedQuery(client, PREFIX)));
      results.push(await smokeHarness.runCheck('18', 6, 'ROLLUP + PROJECT-SCOPED QUERY', () => checkRollupAndProjectScopedQuery(client, PREFIX)));
      results.push(await smokeHarness.runCheck('18', 7, 'VALIDATION + TOTAL CLASSIFICATION', () => checkValidationAndTotalClassification(client, PREFIX)));
      results.push(await smokeHarness.runCheck('18', 8, 'ALL-NULL-COST GROUP', () => checkAllNullCostGroup(client, PREFIX)));
      return results.every(Boolean);
    });

    const residue = await smokeHarness.scanForResidue(client, PREFIX, RESIDUE_SPECS);
    if (residue.length > 0) {
      console.log(`[SMOKE-18][residue] FAIL post-rollback residue detected: ${residue.join('; ')}`);
      overallOk = false;
    } else {
      console.log('[SMOKE-18][residue] PASS zero residue post-rollback');
    }

    smokeHarness.printSummary('18', overallOk);
    process.exitCode = overallOk ? 0 : 1;
  } finally {
    await client.end();
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err && err.stack ? err.stack : err);
    smokeHarness.printSummary('18', false);
    process.exitCode = 1;
  });
}

module.exports = {
  parseArgs,
  UsageError,
  PREREQUISITE_TABLES,
  checkPrerequisites,
};
