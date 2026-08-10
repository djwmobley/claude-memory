'use strict';

/**
 * verify-17-routing-smoke.js
 *
 * Operator-run CLI, the §17.4 5-point routing smoke test. Exercises
 * scripts/lib/route-resolve.js's routeResolve/recommendLeastCost/
 * resolveRequiredTier against a live target database.
 *
 * TARGET RESOLUTION — IDENTICAL to migrate-schema-addenda.js: --db flag,
 * then MIGRATE_TARGET_DB env, then memory_manager_staging built-in
 * default. Reuses migrate-01-canonical-db.js's own resolveTargetDb /
 * classifyTarget / DB_NAME_RE / pgConfig by import (never forked).
 * Refusal is a total classification and runs BEFORE any database
 * connection is opened. Never reads HANDOFF_DB.
 *
 * PREREQUISITE CHECK: the four routing/telemetry tables this resolver
 * touches (model_registry, routing_profiles, routing_session_overrides,
 * turn_usage) must already exist. A missing table is a loud FAIL naming
 * migrate-schema-addenda.js, exit 1, before any fixture work begins.
 * (session_usage is a §18 rollup this issue does not touch — not checked
 * here.)
 *
 * DESIGNED TO RUN AGAINST A LIVE STAGING DB NON-DESTRUCTIVELY (ADVERSARY-
 * PASS AMENDMENT 4-1/4-2/4-3 — supersedes any non-transactional cleanup
 * description elsewhere): the ENTIRE fixture-and-check lifecycle runs
 * inside ONE transaction on ONE connection — BEGIN, an in-transaction
 * `DELETE FROM model_registry` (makes the least-cost recommendation pool
 * deterministic regardless of what real operator-registered rows exist;
 * the table is small and the row locks last only for the smoke's
 * duration), run-prefixed fixture inserts, all 5 checks through that same
 * client, then ROLLBACK always — success or failure. Consequences this
 * implementation preserves:
 *   (a) zero residue by construction — Postgres rolls back on connection
 *       death, so crash/SIGKILL cleanup is guaranteed without a finally
 *       block of DELETE statements;
 *   (b) concurrent real resolvers never see the smoke's fixtures
 *       (uncommitted) — including the '*' sentinel fixture;
 *   (c) checks 3/4 are deterministic even on a staging DB where real
 *       models are registered.
 * Every smoke project/session id, role, and model label carries the
 * `smoke17-<random-suffix>` prefix generated once per run. The '*'
 * sentinel fixture uses a run-prefixed ROLE (never a bare, real role name)
 * so it can never collide with a real '*' row in either the directive
 * chain or resolveRequiredTier's lookup. Post-ROLLBACK, the script
 * verifies zero COMMITTED rows carry its prefix (defense-in-depth scan,
 * including `project_id='*' AND role LIKE 'smoke17-%'`).
 *
 * HARNESS EXTRACTION (runbook §18, ADVERSARY-PASS AMENDMENTS A-15/A-16):
 * the transaction+rollback / run-prefix / residue-scan machinery described
 * above now lives in scripts/migrations/lib/smoke-harness.js, shared with
 * verify-18-usage-smoke.js. This file's own behavior and stdout shape are
 * unchanged by that extraction -- see smoke-harness.js's header comment for
 * the byte-identical-output acceptance contract this refactor must meet.
 *
 * Usage:
 *   node scripts/migrations/verify-17-routing-smoke.js [--db <name>]
 *
 * Exit codes: 0 = all checks PASS, 1 = refused / prerequisite missing /
 * any check FAIL, 2 = bad CLI usage.
 */

const { Client } = require('pg');

const migrateOne = require('./migrate-01-canonical-db');
const {
  routeResolve,
  resolveRequiredTier,
} = require('../lib/route-resolve');
const smokeHarness = require('./lib/smoke-harness');

// ─── The four prerequisite tables this resolver touches ──────────────────

const PREREQUISITE_TABLES = ['model_registry', 'routing_profiles', 'routing_session_overrides', 'turn_usage'];

// Only model_registry is ever wiped (A-15) -- the global recommendation
// pool, made deterministic for the run's duration inside the
// always-rolled-back transaction.
const WIPE_TABLES = ['model_registry'];

// Post-rollback residue-scan specs (A-15) -- one entry per table this
// script's fixtures can touch. The routing_profiles clause additionally
// matches the '*' sentinel project_id fixture via its run-prefixed role.
const RESIDUE_SPECS = [
  { table: 'model_registry', where: 'label LIKE $1' },
  { table: 'routing_profiles', where: "project_id LIKE $1 OR (project_id = '*' AND role LIKE $1)" },
  { table: 'routing_session_overrides', where: 'project_id LIKE $1' },
  { table: 'turn_usage', where: 'project_id LIKE $1' },
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
    'Usage: node scripts/migrations/verify-17-routing-smoke.js [--db <name>]',
    '',
    '  --db <name>  Target database name (else MIGRATE_TARGET_DB env, else',
    '               memory_manager_staging). Never reads HANDOFF_DB. Runs',
    '               entirely inside one transaction that is always rolled',
    '               back — safe to run against a live staging database.',
  ].join('\n'));
}

// ─── Fixture helpers ───────────────────────────────────────────────────────

async function insertModels(client, rows) {
  for (const r of rows) {
    await client.query(
      `INSERT INTO model_registry (label, provider, capability_tier, cost_in_per_mtok, cost_out_per_mtok, available)
       VALUES ($1, $2, $3, $4, $5, true)`,
      [r.label, r.provider || null, r.tier, r.costIn, r.costOut]
    );
  }
}

async function deleteModels(client, labels) {
  if (labels.length === 0) return;
  await client.query(`DELETE FROM model_registry WHERE label = ANY($1::text[])`, [labels]);
}

async function insertProfile(client, { projectId, role, tier, preferredModel = null, preferredProvider = null, version = 1 }) {
  await client.query(
    `INSERT INTO routing_profiles (project_id, role, capability_tier, preferred_model, preferred_provider, version, active)
     VALUES ($1, $2, $3, $4, $5, $6, true)`,
    [projectId, role, tier, preferredModel, preferredProvider, version]
  );
}

async function turnUsageCount(client, projectId, sessionId, turnIdx, role) {
  const { rows } = await client.query(
    `SELECT COUNT(*)::int AS n FROM turn_usage
      WHERE project_id = $1 AND session_id = $2 AND turn_idx = $3 AND agent_role = $4`,
    [projectId, sessionId, turnIdx, role]
  );
  return rows[0].n;
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

// runCheck and scanForResidue now live in ./lib/smoke-harness.js (extracted,
// A-15/A-16) -- called via smokeHarness.runCheck / smokeHarness.scanForResidue
// below, using RESIDUE_SPECS declared above.

// ─── The 5 checks ────────────────────────────────────────────────────────

async function checkIdempotency(client, PREFIX) {
  const projectId = `${PREFIX}-proj-idem`;
  const sessionId = `${PREFIX}-sess-idem`;
  const role = `${PREFIX}-role-idem`;
  const overrideModel = `${PREFIX}-model-idem-override`;

  const r1 = await routeResolve(client, { projectId, sessionId, turnIdx: 0, role, overrideModel });
  assert(r1.replayed === false, `first call expected replayed:false, got ${r1.replayed}`);

  const r2 = await routeResolve(client, { projectId, sessionId, turnIdx: 0, role, overrideModel });
  assert(r2.replayed === true, `second call expected replayed:true, got ${r2.replayed}`);
  assert(r2.model === r1.model, `second call model diverged: ${r1.model} vs ${r2.model}`);
  assert(r2.provider === r1.provider, `second call provider diverged: ${r1.provider} vs ${r2.provider}`);

  const n = await turnUsageCount(client, projectId, sessionId, 0, role);
  assert(n === 1, `expected exactly 1 turn_usage row for the key, found ${n}`);
}

async function checkDirectiveAndRecommendationRecording(client, PREFIX) {
  const projectId = `${PREFIX}-proj-c2`;
  const sessionId = `${PREFIX}-sess-c2`;
  const role = `${PREFIX}-role-c2`;
  const cheapLabel = `${PREFIX}-model-c2-cheap`;
  const overrideLabel = `${PREFIX}-model-c2-override`;

  await insertProfile(client, { projectId, role, tier: 'low' }); // tier baseline, non-directive (preferredModel null)
  await insertModels(client, [
    { label: cheapLabel, tier: 'low', costIn: 1, costOut: 1 },
    { label: overrideLabel, tier: 'low', costIn: 3, costOut: 3 },
  ]);

  try {
    const r = await routeResolve(client, { projectId, sessionId, turnIdx: 0, role, overrideModel: overrideLabel });
    assert(r.model === overrideLabel, `expected model to equal the override verbatim, got ${r.model}`);
    assert(r.resolved_via === 'directive', `expected resolved_via='directive', got ${r.resolved_via}`);
    assert(r.recommended_model !== null, 'expected recommended_model to be non-NULL');
    assert(r.recommended_model === cheapLabel, `expected recommended_model=${cheapLabel}, got ${r.recommended_model}`);
    assert(r.cost_delta_usd !== null, 'expected cost_delta_usd to be non-NULL');
    assert(r.cost_delta_usd === 4, `expected cost_delta_usd=4 (6-2), got ${r.cost_delta_usd}`);
  } finally {
    await deleteModels(client, [cheapLabel, overrideLabel]);
  }
}

async function checkLeastCost(client, PREFIX) {
  const projectId = `${PREFIX}-proj-c3`;
  const sessionId = `${PREFIX}-sess-c3`;
  const role = `${PREFIX}-role-c3`;
  const cheapLabel = `${PREFIX}-model-c3-cheap`;
  const priceyLabel = `${PREFIX}-model-c3-pricey`;
  const higherTierCheaperLabel = `${PREFIX}-model-c3-midcheaper`;

  await insertProfile(client, { projectId, role, tier: 'low' });
  await insertModels(client, [
    { label: cheapLabel, tier: 'low', costIn: 1, costOut: 1 },       // sum=2, cheapest at required tier
    { label: priceyLabel, tier: 'low', costIn: 5, costOut: 5 },      // sum=10
    { label: higherTierCheaperLabel, tier: 'mid', costIn: 0.1, costOut: 0.1 }, // cheaper but HIGHER tier -- must not win
  ]);

  try {
    const r = await routeResolve(client, { projectId, sessionId, turnIdx: 0, role });
    assert(r.resolved_via === 'recommendation', `expected resolved_via='recommendation', got ${r.resolved_via}`);
    assert(r.model === cheapLabel, `expected cheapest sufficient-tier model ${cheapLabel} to win, got ${r.model}`);
    assert(r.model !== higherTierCheaperLabel, 'a cheaper higher-tier model must never win over a sufficient lower-tier one (tier-fit before cost)');
  } finally {
    await deleteModels(client, [cheapLabel, priceyLabel, higherTierCheaperLabel]);
  }
}

async function checkNoSilentDowngrade(client, PREFIX) {
  const projectId = `${PREFIX}-proj-c4`;
  const sessionId = `${PREFIX}-sess-c4`;
  const role = `${PREFIX}-role-c4`;

  // 'high' is never touched by any other check in this run, so at this
  // point the registry has ZERO high-tier rows -- the empty-pool branch.
  await insertProfile(client, { projectId, role, tier: 'high' });

  let emptyPoolError = null;
  try {
    await routeResolve(client, { projectId, sessionId, turnIdx: 0, role });
  } catch (err) {
    emptyPoolError = err;
  }
  assert(emptyPoolError !== null, 'expected routeResolve to throw when zero models exist at/above the required tier');
  assert(/no available model/i.test(emptyPoolError.message), `expected an empty-pool error, got: ${emptyPoolError.message}`);
  const nAfterEmpty = await turnUsageCount(client, projectId, sessionId, 0, role);
  assert(nAfterEmpty === 0, 'no turn_usage row must be written on the empty-pool error path');

  // Now register a cost-less high-tier model -- the DISTINCT cost-
  // unconfigured error must fire, never the empty-pool one.
  const costlessLabel = `${PREFIX}-model-c4-costless`;
  await insertModels(client, [{ label: costlessLabel, tier: 'high', costIn: null, costOut: null }]);

  let costUnconfiguredError = null;
  try {
    await routeResolve(client, { projectId, sessionId, turnIdx: 1, role });
  } catch (err) {
    costUnconfiguredError = err;
  }
  assert(costUnconfiguredError !== null, 'expected routeResolve to throw when all at-tier models lack cost figures');
  assert(/lack cost figures/i.test(costUnconfiguredError.message), `expected a cost-unconfigured error, got: ${costUnconfiguredError.message}`);
  assert(costUnconfiguredError.message !== emptyPoolError.message, 'the cost-unconfigured error must be DISTINCT from the empty-pool error');
  const nAfterCostless = await turnUsageCount(client, projectId, sessionId, 1, role);
  assert(nAfterCostless === 0, 'no turn_usage row must be written on the cost-unconfigured error path');

  await deleteModels(client, [costlessLabel]);
}

async function checkCrossProjectIsolation(client, PREFIX) {
  const role = `${PREFIX}-role-isolation`; // run-prefixed role, used for the '*' fixture too (never a bare real role name)
  const projectA = `${PREFIX}-proj-a`;
  const projectB = `${PREFIX}-proj-b`;
  const sessionId = `${PREFIX}-sess-isolation`;
  const pinA = `${PREFIX}-model-pin-a`;
  const globalPin = `${PREFIX}-model-global-pin`;

  // '*' tier-only baseline (no preferred_model -- NOT a directive yet).
  await insertProfile(client, { projectId: '*', role, tier: 'low', version: 1 });
  // Project A's own pin.
  await insertProfile(client, { projectId: projectA, role, tier: 'low', preferredModel: pinA, version: 1 });

  const resolvedA1 = await routeResolve(client, { projectId: projectA, sessionId, turnIdx: 0, role });
  assert(resolvedA1.resolved_via === 'directive', `project A expected resolved_via='directive', got ${resolvedA1.resolved_via}`);
  assert(resolvedA1.model === pinA, `project A expected its own pin ${pinA}, got ${resolvedA1.model}`);

  // Project B has no profile/pin of its own and the '*' row has no
  // preferred_model yet -- B must get a recommendation, never A's pin.
  const cheapLabel = `${PREFIX}-model-isolation-cheap`;
  await insertModels(client, [{ label: cheapLabel, tier: 'low', costIn: 1, costOut: 1 }]);
  try {
    const resolvedB1 = await routeResolve(client, { projectId: projectB, sessionId, turnIdx: 0, role });
    assert(resolvedB1.resolved_via === 'recommendation', `project B expected resolved_via='recommendation', got ${resolvedB1.resolved_via}`);
    assert(resolvedB1.model !== pinA, "project B's resolution must never be project A's pin");

    // Upgrade the '*' row to a genuine global default pin (new version).
    await insertProfile(client, { projectId: '*', role, tier: 'low', preferredModel: globalPin, version: 2 });

    const resolvedB2 = await routeResolve(client, { projectId: projectB, sessionId, turnIdx: 1, role });
    assert(resolvedB2.resolved_via === 'directive', `project B (after global pin) expected resolved_via='directive', got ${resolvedB2.resolved_via}`);
    assert(resolvedB2.model === globalPin, `project B expected the global default pin ${globalPin}, got ${resolvedB2.model}`);

    // Project A's OWN pin still beats the (now-present) global pin.
    const resolvedA2 = await routeResolve(client, { projectId: projectA, sessionId, turnIdx: 1, role });
    assert(resolvedA2.resolved_via === 'directive', `project A (2nd turn) expected resolved_via='directive', got ${resolvedA2.resolved_via}`);
    assert(resolvedA2.model === pinA, `project A's own pin must still beat the global default pin (got ${resolvedA2.model})`);
  } finally {
    await deleteModels(client, [cheapLabel]);
  }
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

  console.log(`verify-17-routing-smoke: target="${target}" (resolved from ${source})`);

  const client = new Client(migrateOne.pgConfig(target));
  try {
    await client.connect();
  } catch (err) {
    console.error(`Could not connect to target database "${target}": ${err.message}`);
    process.exit(1);
  }

  const PREFIX = smokeHarness.makeRunPrefix('17');
  console.log(`  run prefix: ${PREFIX}`);

  try {
    const prereq = await checkPrerequisites(client);
    if (!prereq.ok) {
      console.error(`Refused: target "${target}" is missing prerequisite table(s): ${prereq.missing.join(', ')}.`);
      console.error('Run migrate-schema-addenda.js against this target first to stand up the routing/telemetry schema, then re-run this smoke test.');
      smokeHarness.printSummary('17', false);
      process.exitCode = 1;
      return;
    }

    // In-transaction reset -- makes the recommendation pool deterministic
    // regardless of what real operator-registered rows exist. Rolled back
    // at the end (unconditionally -- success or failure), so nothing is
    // ever actually removed. This IS the entire cleanup mechanism
    // (ADVERSARY-PASS AMENDMENT 4-1/4-2/4-3): zero residue by construction,
    // safe even under crash/SIGKILL.
    let overallOk = await smokeHarness.withTransactionRollback(client, WIPE_TABLES, async () => {
      const results = [];
      results.push(await smokeHarness.runCheck('17', 1, 'IDEMPOTENCY', () => checkIdempotency(client, PREFIX)));
      results.push(await smokeHarness.runCheck('17', 2, 'DIRECTIVE + RECOMMENDATION RECORDING', () => checkDirectiveAndRecommendationRecording(client, PREFIX)));
      results.push(await smokeHarness.runCheck('17', 3, 'LEAST-COST', () => checkLeastCost(client, PREFIX)));
      results.push(await smokeHarness.runCheck('17', 4, 'NO SILENT DOWNGRADE', () => checkNoSilentDowngrade(client, PREFIX)));
      results.push(await smokeHarness.runCheck('17', 5, 'CROSS-PROJECT ISOLATION', () => checkCrossProjectIsolation(client, PREFIX)));
      return results.every(Boolean);
    });

    // Defense-in-depth: after the rollback, prove zero COMMITTED rows
    // carry this run's prefix.
    const residue = await smokeHarness.scanForResidue(client, PREFIX, RESIDUE_SPECS);
    if (residue.length > 0) {
      console.log(`[SMOKE-17][residue] FAIL post-rollback residue detected: ${residue.join('; ')}`);
      overallOk = false;
    } else {
      console.log('[SMOKE-17][residue] PASS zero residue post-rollback');
    }

    smokeHarness.printSummary('17', overallOk);
    process.exitCode = overallOk ? 0 : 1;
  } finally {
    await client.end();
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err && err.stack ? err.stack : err);
    smokeHarness.printSummary('17', false);
    process.exitCode = 1;
  });
}

module.exports = {
  parseArgs,
  UsageError,
  PREREQUISITE_TABLES,
  checkPrerequisites,
};
