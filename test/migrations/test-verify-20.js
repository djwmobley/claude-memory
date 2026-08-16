'use strict';

/**
 * test-verify-20.js — Test harness for scripts/migrations/migrate-15-mcp-
 * addenda.js and scripts/migrations/verify-20-mcp-surface.js (the §8
 * generalized MCP tool surface — CONSOLIDATION-RUNBOOK.md §8, M-1..M-19,
 * memory-manager#18).
 *
 * Group A: subprocess tests of the full migration + smoke chain (migrate-01
 * -> addenda -> migrate-13 -> migrate-14 -> migrate-13 re-apply ->
 * migrate-15-mcp-addenda -> verify-20-mcp-surface), run with EMBED_SKIP=1
 * (no live vLLM in CI — verify-20-mcp-surface.js injects a deterministic
 * mock embedder under that env var, mirroring verify-19-seams-smoke.js's
 * own mockEmbedder() precedent): fresh full-stack apply -> exit 0 +
 * SMOKE20_RESULT: PASS with all 27 checks + the MCP-registration check
 * green; prerequisite-missing (migrate-15 not yet applied) -> FAIL naming
 * migrate-15-mcp-addenda.js.
 *
 * Group B: DB-free pure unit tests for the closed-enum/static pieces of
 * scripts/lib/memory-search.js and scripts/lib/memory-view.js — the
 * DB-dependent behavior of all of these is already exercised end-to-end by
 * verify-20-mcp-surface.js's checks (Group A proves that script itself
 * passes).
 *
 * Usage: node test/migrations/test-verify-20.js
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
const MIGRATE15_PATH = path.join(PROJECT_ROOT, 'scripts', 'migrations', 'migrate-15-mcp-addenda.js');
const SMOKE20_PATH = path.join(PROJECT_ROOT, 'scripts', 'migrations', 'verify-20-mcp-surface.js');

const memorySearchLib = require(path.join(PROJECT_ROOT, 'scripts', 'lib', 'memory-search.js'));
const memoryViewLib = require(path.join(PROJECT_ROOT, 'scripts', 'lib', 'memory-view.js'));
const memoryUpsertLib = require(path.join(PROJECT_ROOT, 'scripts', 'lib', 'memory-upsert.js'));
const routingProfileLib = require(path.join(PROJECT_ROOT, 'scripts', 'lib', 'routing-profile.js'));
const normalizeText = require(path.join(PROJECT_ROOT, 'scripts', 'lib', 'normalize-text.js'));

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
function assertEq(actual, expected, msg) {
  if (actual !== expected) throw new Error(`${msg} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
}

function pgConfig(database) {
  return {
    host: process.env.PGHOST || 'localhost', port: parseInt(process.env.PGPORT || '5432', 10),
    user: process.env.PGUSER || 'postgres', password: process.env.PGPASSWORD || 'postgres', database,
  };
}
async function pgConnect(database = 'postgres') { const c = new Client(pgConfig(database)); await c.connect(); return c; }
async function dropDb(dbName) {
  let sys;
  try {
    sys = await pgConnect('postgres');
    await sys.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`, [dbName]);
    await sys.query(`DROP DATABASE IF EXISTS "${dbName}"`);
  } catch (_) { /* best-effort */ } finally { if (sys) { try { await sys.end(); } catch (_) {} } }
}

function spawn(scriptPath, args, extraEnv = {}, timeoutMs = 60000) {
  return spawnSync(process.execPath, [scriptPath, ...args], {
    cwd: PROJECT_ROOT, env: { ...process.env, ...extraEnv }, encoding: 'utf8', timeout: timeoutMs,
  });
}

async function setupFullStackThroughMigrate14(dbName) {
  let r = spawn(MIGRATE_ONE_PATH, ['--db', dbName]);
  if (r.status !== 0) throw new Error(`migrate-01 failed: ${r.stderr}`);
  r = spawn(ADDENDA_PATH, ['--db', dbName]);
  if (r.status !== 0) throw new Error(`addenda failed: ${r.stderr}`);
  r = spawn(MIGRATE13_PATH, ['--db', dbName]);
  if (r.status !== 0) throw new Error(`migrate-13 (1st apply) failed: ${r.stdout} ${r.stderr}`);
  r = spawn(MIGRATE14_PATH, ['--db', dbName]);
  if (r.status !== 0) throw new Error(`migrate-14 failed: ${r.stdout} ${r.stderr}`);
  // Re-apply migrate-13 to wire seam-table + entities audit triggers. Its
  // own CLI exit code may be 1 here (see test-migrate-14-seam-tables.js's
  // testTriggerReapplyWires16 for the documented row_id-widening self-check
  // interaction) — irrelevant to what migrate-15/verify-20 depend on
  // (trigger wiring + the tables themselves), so the exit code is
  // deliberately NOT asserted here.
  spawn(MIGRATE13_PATH, ['--db', dbName]);
}

const DB_MAIN = `verify20_main_${TS}_staging`;
const DB_PREREQ = `verify20_prereq_${TS}_staging`;
const CREATED_DBS = [DB_MAIN, DB_PREREQ];

// ── Group A ──────────────────────────────────────────────────────────────

async function testFreshApplyAllGreen() {
  await setupFullStackThroughMigrate14(DB_MAIN);
  const r15 = spawn(MIGRATE15_PATH, ['--db', DB_MAIN]);
  assert(r15.status === 0, `migrate-15-mcp-addenda apply failed: status=${r15.status} stdout=${r15.stdout} stderr=${r15.stderr}`);
  assert(/MIGRATION_RESULT: PASS/.test(r15.stdout), `expected migrate-15 PASS. stdout=${r15.stdout}`);

  const r20 = spawn(SMOKE20_PATH, ['--db', DB_MAIN], { EMBED_SKIP: '1' }, 90000);
  assert(r20.status === 0, `expected exit 0, got ${r20.status}. stdout=${r20.stdout} stderr=${r20.stderr}`);
  assert(/SMOKE20_RESULT: PASS/.test(r20.stdout), `expected the PASS summary line. stdout=${r20.stdout}`);
  const failLines = (r20.stdout.match(/\[SMOKE-20\]\[[^\]]+\] FAIL.*/g) || []);
  assert(failLines.length === 0, `expected zero FAIL lines, got: ${failLines.join(' | ')}`);
  const passCount = (r20.stdout.match(/\[SMOKE-20\]\[\d+\] PASS/g) || []).length;
  assert(passCount === 27, `expected all 27 numbered checks to PASS, got ${passCount}`);
  assert(/mcp-registration\] PASS/.test(r20.stdout), 'expected the MCP-registration check to PASS');
  assert(/residue scan: clean \(0 rows\)/.test(r20.stdout), `expected a clean residue scan. stdout=${r20.stdout}`);
}

async function testPrereqMissing() {
  await setupFullStackThroughMigrate14(DB_PREREQ);
  // Deliberately do NOT run migrate-15-mcp-addenda.js — verify-20 must
  // refuse, naming it as the fix.
  const r20 = spawn(SMOKE20_PATH, ['--db', DB_PREREQ], { EMBED_SKIP: '1' }, 30000);
  assert(r20.status === 1, `expected exit 1, got ${r20.status}. stdout=${r20.stdout} stderr=${r20.stderr}`);
  assert(/missing prerequisite/.test(r20.stderr), `expected a prerequisite refusal. stderr=${r20.stderr}`);
  assert(/migrate-15-mcp-addenda\.js/.test(r20.stderr), `expected migrate-15 named as the fix. stderr=${r20.stderr}`);
}

async function testMigrate15IdempotentReapply() {
  // DB_MAIN already has migrate-15 applied (testFreshApplyAllGreen) — a
  // second apply must still PASS cleanly (idempotent).
  const r = spawn(MIGRATE15_PATH, ['--db', DB_MAIN]);
  assert(r.status === 0, `expected idempotent re-apply to exit 0, got ${r.status}. stdout=${r.stdout} stderr=${r.stderr}`);
  assert(/MIGRATION_RESULT: PASS/.test(r.stdout), `expected PASS on re-apply. stdout=${r.stdout}`);
}

// ── Group B: DB-free pure unit tests ────────────────────────────────────

function testMemorySearchClosedEnum() {
  assertEq(memorySearchLib.ALLOWED_TABLES.length, 15, 'exactly 15 tables in the M-14 closed enum (assertions + agent_exchange + 13 seam tables)');
  assert(!memorySearchLib.ALLOWED_TABLES.includes('memory_entry_chunks'), 'memory_entry_chunks excluded (vector(1024) vs halfvec(4000) dimension mismatch)');
  for (const t of ['assertions', 'agent_exchange', 'decisions', 'gotchas', 'findings', 'code_index']) {
    assert(memorySearchLib.ALLOWED_TABLES.includes(t), `${t} in the closed enum`);
  }
}

function testMemorySearchUnknownTableThrowsBeforeAnyDb() {
  // buildTableQuery is pure (no DB) — proves the SQL-shape/placeholder-count
  // logic for a table with fts_vec vs one without, without a connection.
  const withFts = memorySearchLib.buildTableQuery('decisions');
  assertEq(withFts.paramKeys.length, 4, 'a table WITH fts_vec has 4 placeholders (vector, query, projectId, limit)');
  const withoutFts = memorySearchLib.buildTableQuery('assertions');
  assertEq(withoutFts.paramKeys.length, 3, 'a table WITHOUT fts_vec has 3 placeholders (vector, projectId, limit) — the query-text param is never left unreferenced in the SQL text');
}

function testMemoryViewSupportedQueryTypes() {
  assertEq(memoryViewLib.SUPPORTED_QUERY_TYPES.length, 4, 'exactly 4 supported query types (M-16)');
  for (const t of ['entity', 'assertion', 'recency', 'vector']) {
    assert(memoryViewLib.SUPPORTED_QUERY_TYPES.includes(t), `${t} supported`);
  }
  try {
    memoryViewLib.validateQueries([{ type: 'raw_sql' }]);
    throw new Error('expected unsupportedQueryType error');
  } catch (err) {
    assertEq(err.code, 'unsupportedQueryType', 'M-16: raw SQL is never an accepted query type');
  }
}

function testMemoryUpsertEmbedTextBuilders() {
  // M-2's per-table embed-text builders are pure — proves the concatenation
  // shape without a DB connection.
  const text = memoryUpsertLib.buildEmbedText('decisions', { topic: 'a', decision: 'b', reason: 'c' });
  assertEq(text, 'a b c', 'decisions concatenates topic, decision, reason');
  const empty = memoryUpsertLib.buildEmbedText('decisions', {});
  assertEq(empty, '', 'missing columns produce an empty embed text, never a throw');
}

function testRoutingProfileValidTiers() {
  assertEq(routingProfileLib.VALID_TIERS.length, 3, 'exactly 3 capability tiers');
  for (const t of ['high', 'mid', 'low']) assert(routingProfileLib.VALID_TIERS.includes(t), `${t} is a valid tier`);
}

function testNormalizeTextNfcFirst() {
  // M-11: NFC applied FIRST, before case-folding — an NFC/NFD pair of the
  // SAME visual string normalizes identically.
  assertEq(normalizeText.normalizeForCompare('café'), normalizeText.normalizeForCompare('café'), 'precomposed vs combining-acute forms normalize identically');
}

// ── Main ─────────────────────────────────────────────────────────────────

async function main() {
  await run('A1', 'Fresh full-stack apply through migrate-15 -> verify-20-mcp-surface all-green (27 checks + MCP registration)', testFreshApplyAllGreen);
  await run('A2', 'verify-20-mcp-surface refuses when migrate-15-mcp-addenda has not been applied, naming it as the fix', testPrereqMissing);
  await run('A3', 'migrate-15-mcp-addenda.js is idempotent on re-apply', testMigrate15IdempotentReapply);

  await run('B1', 'memory-search.js: M-14 closed enum is exactly 15 tables, memory_entry_chunks excluded', () => testMemorySearchClosedEnum());
  await run('B2', 'memory-search.js: buildTableQuery placeholder count differs correctly for hasFts vs not', () => testMemorySearchUnknownTableThrowsBeforeAnyDb());
  await run('B3', 'memory-view.js: SUPPORTED_QUERY_TYPES is exactly the 4 M-16 types; unsupported type hard-errors', () => testMemoryViewSupportedQueryTypes());
  await run('B4', 'memory-upsert.js: per-table embed-text builders (M-2) are pure and total', () => testMemoryUpsertEmbedTextBuilders());
  await run('B5', 'routing-profile.js: VALID_TIERS is exactly high/mid/low', () => testRoutingProfileValidTiers());
  await run('B6', 'normalize-text.js: NFC applied first (M-11)', () => testNormalizeTextNfcFirst());

  for (const db of CREATED_DBS) {
    await dropDb(db);
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exitCode = failed > 0 ? 1 : 0;
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exitCode = 1;
});
