'use strict';

/**
 * test-routing-init-qa.js — §17.1.2 init-time routing configuration Q&A
 * (CONSOLIDATION-RUNBOOK.md §17.1.2, owner decision 2026-09-06).
 *
 * Two groups:
 *   V. Pure validator unit tests (no DB) — totality for every re-ask case:
 *      role-list defaulting/whitespace/duplicate/case-near-match, tier
 *      exact-match, cost parsing (scientific notation, NaN, negative,
 *      too-many-fractional-digits, locale-comma, boundary value), and
 *      label blank/whitespace/case-near-match/exact-match.
 *   I. Integration tests of `runRoutingInitQA` against a live scratch
 *      database, driven entirely through the injectable `ask` seam (no
 *      readline, no real stdin): the non-interactive gate, the
 *      tables-absent precondition, EOF at the very first question and
 *      EOF mid-sequence (both proving zero rows written — the
 *      all-or-nothing buffering contract), a quiet decline, the full
 *      happy path (role tiers + one model, verified end to end against
 *      the DB), the idempotency skip of an already-configured role, and
 *      `--routing-reconfigure` re-asking that same role plus a Q3
 *      label near-case-duplicate rejection-then-retry (which also
 *      exercises the custom-role fallback suggested-tier prompt text).
 *
 * Self-contained scratch database ("_staging" suffix — migrate-01's own
 * classifyTarget), unconditional finally-block cleanup — same conventions
 * as test-verify-17.js / test-routing-profile-concurrency.js. A second,
 * base-schema-only scratch DB (no schema-addenda applied) exercises the
 * tables-absent precondition.
 *
 * Requires Postgres at PGHOST/PGUSER/PGPASSWORD (CI env) or
 * localhost/postgres.
 *
 * Usage: node test/migrations/test-routing-init-qa.js
 * Exit 0 = pass; nonzero = any failure.
 */

const path = require('path');
const { spawnSync } = require('child_process');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const MIGRATE_ONE_PATH = path.join(PROJECT_ROOT, 'scripts', 'migrations', 'migrate-01-canonical-db.js');
const ADDENDA_PATH = path.join(PROJECT_ROOT, 'scripts', 'migrations', 'migrate-schema-addenda.js');
const DB_SEAM_PATH = path.join(PROJECT_ROOT, 'scripts', 'lib', 'db-seam.js');
const ROUTING_PROFILE_PATH = path.join(PROJECT_ROOT, 'scripts', 'lib', 'routing-profile.js');
const ROUTING_INIT_QA_PATH = path.join(PROJECT_ROOT, 'scripts', 'lib', 'routing-init-qa.js');

const { createAdapter } = require(DB_SEAM_PATH);
const routingProfileLib = require(ROUTING_PROFILE_PATH);
const qa = require(ROUTING_INIT_QA_PATH);
const {
  runRoutingInitQA,
  DEFAULT_ROLES,
  SUGGESTED_TIER_BY_ROLE,
  FALLBACK_SUGGESTED_TIER,
  validateRolesAnswer,
  validateTierAnswer,
  validateCostAnswer,
  validateLabelAnswer,
  buildLabelIndex,
  promptQ2,
} = qa;

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
    fail(id, label, err && err.stack ? err.stack : String(err));
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

function assertDeepEq(actual, expected, msg) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    throw new Error(`${msg || 'assertion failed'} (expected ${e}, got ${a})`);
  }
}

// ── PG / schema helpers ─────────────────────────────────────────────────────

function pgConfig(database) {
  return {
    host: process.env.PGHOST || 'localhost',
    port: parseInt(process.env.PGPORT || '5432', 10),
    user: process.env.PGUSER || 'postgres',
    database,
  };
}

async function connectAdapter(database) {
  return createAdapter('postgres', pgConfig(database));
}

// scripts/ has its own node_modules (pg) for the raw sysadmin connection
// used only to create/drop scratch databases.
const { createRequire } = require('module');
const scriptsRequire = createRequire(require.resolve('../../scripts/package.json'));
const { Client: RawPgClient } = scriptsRequire('pg');

async function sysConnect() {
  const client = new RawPgClient({
    host: process.env.PGHOST || 'localhost',
    port: parseInt(process.env.PGPORT || '5432', 10),
    user: process.env.PGUSER || 'postgres',
    password: process.env.PGPASSWORD || 'postgres',
    database: 'postgres',
  });
  await client.connect();
  return client;
}

async function dropDb(dbName) {
  let sys;
  try {
    sys = await sysConnect();
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

function runMigrateOne(dbName, timeoutMs = 30000) {
  return spawnSync(process.execPath, [MIGRATE_ONE_PATH, '--db', dbName], {
    cwd: PROJECT_ROOT,
    env: { ...process.env },
    encoding: 'utf8',
    timeout: timeoutMs,
  });
}

function runAddenda(dbName, timeoutMs = 20000) {
  return spawnSync(process.execPath, [ADDENDA_PATH, '--db', dbName], {
    cwd: PROJECT_ROOT,
    env: { ...process.env },
    encoding: 'utf8',
    timeout: timeoutMs,
  });
}

async function setupFullSchema(dbName) {
  const r1 = runMigrateOne(dbName);
  if (r1.status !== 0) throw new Error(`migrate-01 fixture setup failed for ${dbName}: status=${r1.status} stderr=${r1.stderr}`);
  const r2 = runAddenda(dbName);
  if (r2.status !== 0) throw new Error(`schema-addenda fixture setup failed for ${dbName}: status=${r2.status} stderr=${r2.stderr}`);
}

async function setupBaseSchemaOnly(dbName) {
  const r1 = runMigrateOne(dbName);
  if (r1.status !== 0) throw new Error(`migrate-01 fixture setup failed for ${dbName}: status=${r1.status} stderr=${r1.stderr}`);
  // Deliberately NOT running schema-addenda — routing_profiles/model_registry
  // must NOT exist in this database (I2's tables-absent precondition fixture).
}

// ── Scripted `ask` seam ──────────────────────────────────────────────────────

/**
 * Returns an injectable `ask` function that pops answers off `answers` in
 * order, one per call, recording every prompt text it was asked (via
 * `.promptsSeen`). `null` entries in `answers` simulate EOF/stream-close at
 * exactly that point in the sequence. Running out of scripted answers
 * (a test-authoring bug, not a driver behavior) throws loudly rather than
 * silently returning undefined.
 */
function makeScriptedAsk(answers) {
  const queue = [...answers];
  const promptsSeen = [];
  const askFn = async (promptText) => {
    promptsSeen.push(promptText);
    if (queue.length === 0) {
      throw new Error(`makeScriptedAsk: exhausted scripted answers; unexpected prompt: "${promptText}"`);
    }
    return queue.shift();
  };
  askFn.promptsSeen = promptsSeen;
  return askFn;
}

function neverAsk() {
  return async (promptText) => {
    throw new Error(`ask() must never be called on this path — got prompt: "${promptText}"`);
  };
}

async function deleteModelLabels(db, labels) {
  for (const label of labels) {
    try { await db.query('DELETE FROM model_registry WHERE label = $1', [label]); } catch (_) { /* best-effort */ }
  }
}

// ── V: pure validator totality tests (no DB) ────────────────────────────────

function testV_rolesDefaultOnRawEmpty() {
  const res = validateRolesAnswer('', DEFAULT_ROLES);
  assert(res.ok, 'raw empty string must be accepted as the default-set sentinel');
  assertDeepEq(res.value, DEFAULT_ROLES, 'raw Enter must yield exactly the default role set');
}

function testV_rolesWhitespaceOnlyRejected() {
  const res = validateRolesAnswer('   ', DEFAULT_ROLES);
  assert(!res.ok, 'whitespace-only (non-empty raw) must be rejected, not silently treated as default');
  assert(/empty entry/.test(res.reason), `reason must name the empty-entry cause: "${res.reason}"`);
}

function testV_rolesTrailingCommaRejected() {
  const res = validateRolesAnswer('draft,', DEFAULT_ROLES);
  assert(!res.ok, 'a trailing comma must produce a rejected empty token, not be silently dropped');
}

function testV_rolesDuplicateRejected() {
  const res = validateRolesAnswer('draft,write,draft', DEFAULT_ROLES);
  assert(!res.ok, 'an exact duplicate role (post-normalization) must be rejected');
  assert(/duplicate/.test(res.reason), `reason must name the duplicate cause: "${res.reason}"`);
}

function testV_rolesCaseNearMatchRejected() {
  const res = validateRolesAnswer('Draft', DEFAULT_ROLES);
  assert(!res.ok, '"Draft" (case-near-match to default role "draft") must be rejected, never silently folded');
  assert(/"draft"/.test(res.reason), `reason must name the canonical default spelling: "${res.reason}"`);
}

function testV_rolesCustomAccepted() {
  const res = validateRolesAnswer('custom-a,custom-b', DEFAULT_ROLES);
  assert(res.ok, 'two distinct custom (non-default) roles must be accepted');
  assertDeepEq(res.value, ['custom-a', 'custom-b']);
}

function testV_tierExactMembers() {
  for (const t of ['high', 'mid', 'low']) {
    const res = validateTierAnswer(t);
    assert(res.ok && res.value === t, `"${t}" must be accepted exactly`);
  }
}

function testV_tierCaseRejected() {
  const res = validateTierAnswer('HIGH');
  assert(!res.ok, '"HIGH" must be rejected — tiers are never case-folded');
}

function testV_tierBlankRejected() {
  const res = validateTierAnswer('');
  assert(!res.ok, 'blank tier answer must re-ask, never default to a suggestion');
}

function testV_tierNonMemberRejected() {
  const res = validateTierAnswer('extra-high');
  assert(!res.ok, 'a non-member tier string must be rejected');
}

function testV_costScientificNotationAccepted() {
  const res = validateCostAnswer('1e3');
  assert(res.ok, '"1e3" is a finite, non-negative, in-range number and must be accepted');
  assertEq(res.value, 1000, '"1e3" must parse to 1000');
}

function testV_costNaNRejected() {
  const res = validateCostAnswer('NaN');
  assert(!res.ok, 'the literal string "NaN" must be rejected as non-finite');
}

function testV_costNegativeRejected() {
  const res = validateCostAnswer('-1');
  assert(!res.ok, 'a negative cost must be rejected');
}

function testV_costTooManyFractionalDigitsRejected() {
  const res = validateCostAnswer('0.00001');
  assert(!res.ok, '5 fractional digits must be rejected — NUMERIC(10,4) would otherwise silently round');
  assert(/fractional digits/.test(res.reason), `reason must name the fractional-digit cause: "${res.reason}"`);
}

function testV_costLocaleCommaRejected() {
  const res = validateCostAnswer('1,000');
  assert(!res.ok, '"1,000" must be rejected (Number("1,000") is NaN) — never silently misparsed as 1');
}

function testV_costOrdinaryValueAccepted() {
  const res = validateCostAnswer('3.50');
  assert(res.ok && res.value === 3.5, '"3.50" must be accepted as 3.5');
}

function testV_costBoundaryMaxAccepted() {
  const res = validateCostAnswer('999999.9999');
  assert(res.ok && res.value === 999999.9999, 'the exact NUMERIC(10,4) boundary value must be accepted');
}

function testV_costOverMaxRejected() {
  const res = validateCostAnswer('1000000');
  assert(!res.ok, 'a value exceeding the NUMERIC(10,4) max must be rejected');
}

function testV_costEmptyRejected() {
  const res = validateCostAnswer('');
  assert(!res.ok, 'an empty cost answer must be rejected (cost is required)');
}

function testV_labelBlankIsDoneSentinel() {
  const res = validateLabelAnswer('', buildLabelIndex([]));
  assert(res.ok && res.blank === true, 'blank label must be the distinct "done adding models" sentinel');
}

function testV_labelWhitespaceOnlyRejected() {
  const res = validateLabelAnswer('   ', buildLabelIndex([]));
  assert(!res.ok, 'a whitespace-only (non-empty raw) label must be rejected, never treated as the blank sentinel');
}

function testV_labelCaseNearMatchRejected() {
  const idx = buildLabelIndex(['Claude-Sonnet']);
  const res = validateLabelAnswer('claude-sonnet', idx);
  assert(!res.ok, 'a label differing only in case from an existing one must be rejected');
  assert(/"Claude-Sonnet"/.test(res.reason), `reason must name the canonical existing spelling: "${res.reason}"`);
}

function testV_labelExactMatchAccepted() {
  const idx = buildLabelIndex(['Claude-Sonnet']);
  const res = validateLabelAnswer('Claude-Sonnet', idx);
  assert(res.ok && res.value === 'Claude-Sonnet', 'an EXACT match to an existing label must be accepted (a legitimate update)');
}

function testV_labelBrandNewAccepted() {
  const idx = buildLabelIndex(['Claude-Sonnet']);
  const res = validateLabelAnswer('gpt-brand-new', idx);
  assert(res.ok && res.value === 'gpt-brand-new', 'a brand-new, non-colliding label must be accepted');
}

// ── I: integration tests against a live scratch DB ──────────────────────────

async function testI_nonInteractiveWritesZeroRows(db) {
  const projectId = `qa-noninteractive-${TS}`;
  const result = await runRoutingInitQA(db, { projectId, interactive: false, ask: neverAsk() });
  assert(result.skipped === true && result.reason === 'non-interactive', `expected non-interactive skip, got ${JSON.stringify(result)}`);
  const rows = await routingProfileLib.routingProfileGet(db, { projectId });
  assertEq(rows.length, 0, 'non-interactive gate must write zero routing_profiles rows');
}

async function testI_tablesAbsentSkip(dbNoTables) {
  const projectId = `qa-notables-${TS}`;
  const result = await runRoutingInitQA(dbNoTables, { projectId, interactive: true, ask: neverAsk() });
  assert(result.skipped === true && result.reason === 'tables-absent', `expected tables-absent skip, got ${JSON.stringify(result)}`);
}

async function testI_eofAtFirstQuestion(db) {
  const projectId = `qa-eof-q0-${TS}`;
  const ask = makeScriptedAsk([null]);
  const result = await runRoutingInitQA(db, { projectId, interactive: true, ask });
  assert(result.skipped === true && result.reason === 'incomplete', `expected incomplete on EOF at Q0, got ${JSON.stringify(result)}`);
  const rows = await routingProfileLib.routingProfileGet(db, { projectId });
  assertEq(rows.length, 0, 'EOF at the very first question must write zero rows');
}

async function testI_eofMidSequenceWritesZeroRows(db) {
  const projectId = `qa-eof-mid-${TS}`;
  const label = `qa-eof-mid-model-${TS}`;
  // Fully answers Q0 + Q1 (default roles) + all 8 Q2 tiers, THEN closes
  // mid-Q3 (after label/provider/tier/cost-in, EOF at cost-out) — proves
  // the all-or-nothing buffer: everything answered so far is discarded.
  const answers = [
    'y', '',
    ...DEFAULT_ROLES.map((r) => SUGGESTED_TIER_BY_ROLE[r]),
    label, 'test-provider', 'mid', '2.5',
    null,
  ];
  const ask = makeScriptedAsk(answers);
  const result = await runRoutingInitQA(db, { projectId, interactive: true, ask });
  assert(result.skipped === true && result.reason === 'incomplete', `expected incomplete on mid-sequence EOF, got ${JSON.stringify(result)}`);
  const rows = await routingProfileLib.routingProfileGet(db, { projectId });
  assertEq(rows.length, 0, 'EOF mid-sequence must write zero routing_profiles rows even though all 8 tiers were fully answered');
  const { rows: modelRows } = await db.query('SELECT label FROM model_registry WHERE label = $1', [label]);
  assertEq(modelRows.length, 0, 'EOF mid-sequence must write zero model_registry rows even though label/provider/tier/cost-in were fully answered');
}

async function testI_declinedWritesZeroRows(db) {
  const projectId = `qa-declined-${TS}`;
  const ask = makeScriptedAsk(['n']);
  const result = await runRoutingInitQA(db, { projectId, interactive: true, ask });
  assert(result.skipped === true && result.reason === 'declined', `expected declined, got ${JSON.stringify(result)}`);
  const rows = await routingProfileLib.routingProfileGet(db, { projectId });
  assertEq(rows.length, 0, 'declining Q0 must write zero rows');
}

async function testI_happyPathFullSequence(db) {
  const projectId = `qa-happy-${TS}`;
  const label = `qa-happy-model-${TS}`;
  const tiers = DEFAULT_ROLES.map((r) => SUGGESTED_TIER_BY_ROLE[r]);
  const answers = [
    'y', '',
    ...tiers,
    label, 'test-provider', 'mid', '2.50', '5.00',
    'n', // no more models
  ];
  const ask = makeScriptedAsk(answers);
  try {
    const result = await runRoutingInitQA(db, { projectId, interactive: true, ask });
    assert(result.skipped === false, `expected a completed (non-skipped) run, got ${JSON.stringify(result)}`);
    assertEq(result.rolesWritten.length, DEFAULT_ROLES.length, 'all 8 default roles must be written');
    assertDeepEq(result.modelsWritten, [label], 'exactly one model must be written');

    const rows = await routingProfileLib.routingProfileGet(db, { projectId });
    assertEq(rows.length, DEFAULT_ROLES.length, `expected ${DEFAULT_ROLES.length} active routing_profiles rows`);
    const byRole = Object.fromEntries(rows.map((r) => [r.role, r.capability_tier]));
    for (let i = 0; i < DEFAULT_ROLES.length; i++) {
      assertEq(byRole[DEFAULT_ROLES[i]], tiers[i], `role "${DEFAULT_ROLES[i]}" must carry tier "${tiers[i]}"`);
    }

    const { rows: modelRows } = await db.query(
      'SELECT provider, capability_tier, cost_in_per_mtok, cost_out_per_mtok, configured_by FROM model_registry WHERE label = $1',
      [label]
    );
    assertEq(modelRows.length, 1, 'expected exactly one model_registry row for the registered label');
    assertEq(modelRows[0].provider, 'test-provider');
    assertEq(modelRows[0].capability_tier, 'mid');
    assertEq(Number(modelRows[0].cost_in_per_mtok), 2.5);
    assertEq(Number(modelRows[0].cost_out_per_mtok), 5.0);
    assertEq(modelRows[0].configured_by, 'handoff-init');
  } finally {
    await deleteModelLabels(db, [label]);
  }
}

async function testI_reInitSkipsActiveRoles(db) {
  const projectId = `qa-idempotent-${TS}`;
  // Pre-seed 'draft' with an active profile BEFORE the Q&A runs.
  await routingProfileLib.routingProfileSet(db, { projectId, role: 'draft', capabilityTier: 'low' });

  const rolesToAskInOrder = DEFAULT_ROLES.filter((r) => r !== 'draft');
  const tiers = rolesToAskInOrder.map((r) => SUGGESTED_TIER_BY_ROLE[r]);
  const answers = ['y', '', ...tiers, '']; // '' at the end = skip adding models
  const ask = makeScriptedAsk(answers);

  const result = await runRoutingInitQA(db, { projectId, interactive: true, reconfigure: false, ask });
  assert(result.skipped === false, `expected a completed run, got ${JSON.stringify(result)}`);
  assertDeepEq(result.rolesSkipped, ['draft'], 'the pre-configured "draft" role must be reported as skipped');
  assertEq(result.rolesWritten.length, rolesToAskInOrder.length, 'the other 7 default roles must be written');

  assert(
    !ask.promptsSeen.some((p) => p.includes(`for 'draft'`)),
    `the tier prompt for the already-configured "draft" role must NEVER be asked; prompts seen: ${JSON.stringify(ask.promptsSeen)}`
  );

  const { rows: draftRows } = await db.query(
    `SELECT version, active, capability_tier FROM routing_profiles WHERE project_id = $1 AND role = 'draft' ORDER BY version`,
    [projectId]
  );
  assertEq(draftRows.length, 1, 'the pre-existing "draft" row must remain the ONLY row — no new version inserted');
  assertEq(draftRows[0].active, true);
  assertEq(draftRows[0].capability_tier, 'low', 'the pre-existing "draft" tier must be untouched');
}

async function testI_reconfigureReAsksActiveRoles(db) {
  const projectId = `qa-reconfigure-${TS}`;
  await routingProfileLib.routingProfileSet(db, { projectId, role: 'draft', capabilityTier: 'low' });

  const tiers = DEFAULT_ROLES.map((r) => (r === 'draft' ? 'high' : SUGGESTED_TIER_BY_ROLE[r]));
  const answers = ['y', '', ...tiers, ''];
  const ask = makeScriptedAsk(answers);

  const result = await runRoutingInitQA(db, { projectId, interactive: true, reconfigure: true, ask });
  assert(result.skipped === false, `expected a completed run, got ${JSON.stringify(result)}`);
  assertDeepEq(result.rolesSkipped, [], '--routing-reconfigure must skip NO roles');
  assertEq(result.rolesWritten.length, DEFAULT_ROLES.length, 'all 8 roles (including "draft") must be re-asked and written');

  assert(
    ask.promptsSeen.some((p) => p.includes(`for 'draft'`)),
    `--routing-reconfigure must re-ask the tier prompt for the already-configured "draft" role; prompts seen: ${JSON.stringify(ask.promptsSeen)}`
  );

  const { rows: draftRows } = await db.query(
    `SELECT version, active, capability_tier FROM routing_profiles WHERE project_id = $1 AND role = 'draft' ORDER BY version`,
    [projectId]
  );
  assertEq(draftRows.length, 2, 'reconfigure must insert a NEW version, never mutate the old row in place');
  assertEq(draftRows[0].active, false, 'the original version must now be inactive');
  assertEq(draftRows[0].capability_tier, 'low');
  assertEq(draftRows[1].active, true, 'the new version must be the active one');
  assertEq(draftRows[1].capability_tier, 'high');
}

async function testI_labelNearMatchRejectThenRetryAndCustomRoleSuggestion(db) {
  const projectId = `qa-labeldup-${TS}`;
  const customRole = `qa-custom-role-${TS}`;
  const label1 = `QA-Label-${TS}`;
  const nearMatchAttempt = label1.toLowerCase(); // differs from label1 only in case
  const label2 = `qa-label2-${TS}`;

  const answers = [
    'y',
    customRole,             // Q1: one custom (non-default) role
    'mid',                  // Q2: tier for the custom role
    // Q3, model 1:
    label1, 'p1', 'mid', '1', '1',
    'y',                    // add another model
    // Q3, model 2: first a REJECTED case-near-match, then a valid distinct label
    nearMatchAttempt, label2, 'p2', 'low', '0.5', '0.75',
    'n',                    // stop
  ];
  const ask = makeScriptedAsk(answers);

  try {
    const result = await runRoutingInitQA(db, { projectId, interactive: true, ask });
    assert(result.skipped === false, `expected a completed run, got ${JSON.stringify(result)}`);
    assertDeepEq(result.modelsWritten, [label1, label2], 'both distinct labels must be written, the near-match rejected attempt must not appear');

    const expectedSuggestionPrompt = promptQ2(customRole, FALLBACK_SUGGESTED_TIER);
    assert(
      ask.promptsSeen.includes(expectedSuggestionPrompt),
      `a custom (non-default) role must show the fallback suggested tier "${FALLBACK_SUGGESTED_TIER}" in its Q2 prompt; prompts seen: ${JSON.stringify(ask.promptsSeen)}`
    );

    const { rows: allRows } = await db.query(
      'SELECT label, provider FROM model_registry WHERE label = ANY($1::text[])',
      [[label1, label2, nearMatchAttempt]]
    );
    const byLabel = Object.fromEntries(allRows.map((r) => [r.label, r.provider]));
    assertEq(byLabel[label1], 'p1');
    assertEq(byLabel[label2], 'p2');
    assert(!(nearMatchAttempt in byLabel), 'the rejected near-match label must never have been written to model_registry');
    assertEq(allRows.length, 2, 'exactly two model_registry rows must exist for these three candidate labels (the near-match must never have been inserted)');
  } finally {
    await deleteModelLabels(db, [label1, label2, nearMatchAttempt]);
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────

const DB_NAME = `routinginitqa_${TS}_staging`;
const DB_NAME_NOTABLES = `routinginitqa_notables_${TS}_staging`;

async function main() {
  // ── V: pure validator tests — no DB required ──────────────────────────────
  const pureTests = [
    ['V1', 'validateRolesAnswer: raw empty string -> default role set', testV_rolesDefaultOnRawEmpty],
    ['V2', 'validateRolesAnswer: whitespace-only raw -> rejected (empty entry)', testV_rolesWhitespaceOnlyRejected],
    ['V3', 'validateRolesAnswer: trailing comma -> rejected (empty entry)', testV_rolesTrailingCommaRejected],
    ['V4', 'validateRolesAnswer: exact duplicate -> rejected', testV_rolesDuplicateRejected],
    ['V5', 'validateRolesAnswer: case-near-match to a default role -> rejected naming canonical', testV_rolesCaseNearMatchRejected],
    ['V6', 'validateRolesAnswer: two distinct custom roles -> accepted', testV_rolesCustomAccepted],
    ['V7', 'validateTierAnswer: exact members high/mid/low -> accepted', testV_tierExactMembers],
    ['V8', 'validateTierAnswer: "HIGH" -> rejected (never case-folded)', testV_tierCaseRejected],
    ['V9', 'validateTierAnswer: blank -> rejected (never defaults to suggestion)', testV_tierBlankRejected],
    ['V10', 'validateTierAnswer: non-member string -> rejected', testV_tierNonMemberRejected],
    ['V11', 'validateCostAnswer: "1e3" -> accepted as 1000', testV_costScientificNotationAccepted],
    ['V12', 'validateCostAnswer: "NaN" -> rejected (non-finite)', testV_costNaNRejected],
    ['V13', 'validateCostAnswer: "-1" -> rejected (negative)', testV_costNegativeRejected],
    ['V14', 'validateCostAnswer: "0.00001" -> rejected (5 fractional digits)', testV_costTooManyFractionalDigitsRejected],
    ['V15', 'validateCostAnswer: "1,000" -> rejected (locale comma, non-finite)', testV_costLocaleCommaRejected],
    ['V16', 'validateCostAnswer: "3.50" -> accepted as 3.5', testV_costOrdinaryValueAccepted],
    ['V17', 'validateCostAnswer: "999999.9999" -> accepted at the exact NUMERIC(10,4) boundary', testV_costBoundaryMaxAccepted],
    ['V18', 'validateCostAnswer: "1000000" -> rejected (exceeds max)', testV_costOverMaxRejected],
    ['V19', 'validateCostAnswer: "" -> rejected (required)', testV_costEmptyRejected],
    ['V20', 'validateLabelAnswer: "" -> blank "done" sentinel', testV_labelBlankIsDoneSentinel],
    ['V21', 'validateLabelAnswer: whitespace-only -> rejected, not the blank sentinel', testV_labelWhitespaceOnlyRejected],
    ['V22', 'validateLabelAnswer: case-near-match to an existing label -> rejected naming canonical', testV_labelCaseNearMatchRejected],
    ['V23', 'validateLabelAnswer: exact match to an existing label -> accepted (update)', testV_labelExactMatchAccepted],
    ['V24', 'validateLabelAnswer: brand-new label -> accepted', testV_labelBrandNewAccepted],
  ];
  for (const [id, label, fn] of pureTests) {
    await run(id, label, async () => fn());
  }

  // ── I: integration tests against live scratch databases ──────────────────
  let db;
  let dbNoTables;
  try {
    await setupFullSchema(DB_NAME);
    await setupBaseSchemaOnly(DB_NAME_NOTABLES);
    db = await connectAdapter(DB_NAME);
    dbNoTables = await connectAdapter(DB_NAME_NOTABLES);

    await run('I1', 'runRoutingInitQA: interactive:false -> NOTE + zero rows, ask never called', () => testI_nonInteractiveWritesZeroRows(db));
    await run('I2', 'runRoutingInitQA: routing tables absent -> NOTE + zero rows, ask never called, never fatal', () => testI_tablesAbsentSkip(dbNoTables));
    await run('I3', 'runRoutingInitQA: EOF at the very first question (Q0) -> incomplete, zero rows', () => testI_eofAtFirstQuestion(db));
    await run('I4', 'runRoutingInitQA: EOF mid-Q3 after Q0/Q1/all-8-Q2 answered -> incomplete, ZERO rows (all-or-nothing)', () => testI_eofMidSequenceWritesZeroRows(db));
    await run('I5', 'runRoutingInitQA: Q0 declined -> zero rows', () => testI_declinedWritesZeroRows(db));
    await run('I6', 'runRoutingInitQA: full happy path — 8 default roles + 1 model, verified end to end', () => testI_happyPathFullSequence(db));
    await run('I7', 'runRoutingInitQA: re-init skips a role with an existing active profile (never asked, unchanged)', () => testI_reInitSkipsActiveRoles(db));
    await run('I8', 'runRoutingInitQA: --routing-reconfigure re-asks an already-configured role, versions correctly', () => testI_reconfigureReAsksActiveRoles(db));
    await run('I9', 'runRoutingInitQA: Q3 label case-near-match rejected then retried; custom-role fallback suggestion shown', () => testI_labelNearMatchRejectThenRetryAndCustomRoleSuggestion(db));
  } finally {
    if (db) { try { await db.end(); } catch (_) {} }
    if (dbNoTables) { try { await dbNoTables.end(); } catch (_) {} }
    await dropDb(DB_NAME);
    await dropDb(DB_NAME_NOTABLES);
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exitCode = 1;
});
