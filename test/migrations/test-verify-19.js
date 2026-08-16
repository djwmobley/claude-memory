'use strict';

/**
 * test-verify-19.js — Test harness for
 * scripts/migrations/verify-19-seams-smoke.js and direct pure-unit
 * coverage of the §7 seam libraries it exercises (CONSOLIDATION-
 * RUNBOOK.md §7.1-§7.8, memory-manager#17).
 *
 * Group A: subprocess tests of verify-19-seams-smoke.js itself (fresh
 * full-stack apply -> exit 0 + SMOKE19_RESULT: PASS with all 26 checks
 * green; prerequisite-missing FAIL naming migrate-14-seam-tables.js).
 *
 * Group B: direct, DB-free unit tests for the pure/static pieces of
 * scripts/lib/normalize-text.js, scripts/lib/memory-upsert.js,
 * scripts/lib/reality-checks.js's isEntityShaped, and
 * scripts/lib/carryover-render.js's renderCarryoverTable — the
 * DB-dependent behavior of all of these is already exercised end-to-end by
 * verify-19-seams-smoke.js's 26 checks (Group A proves that script itself
 * passes); Group B adds fast, standalone regression coverage for the
 * adversarial fixtures that do NOT need a live database.
 *
 * Usage: node test/migrations/test-verify-19.js
 * Exit 0 = all pass; nonzero = any failure.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { createRequire } = require('module');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const MIGRATE_ONE_PATH = path.join(PROJECT_ROOT, 'scripts', 'migrations', 'migrate-01-canonical-db.js');
const ADDENDA_PATH = path.join(PROJECT_ROOT, 'scripts', 'migrations', 'migrate-schema-addenda.js');
const MIGRATE13_PATH = path.join(PROJECT_ROOT, 'scripts', 'migrations', 'migrate-13-agent-exchange.js');
const MIGRATE14_PATH = path.join(PROJECT_ROOT, 'scripts', 'migrations', 'migrate-14-seam-tables.js');
const SMOKE19_PATH = path.join(PROJECT_ROOT, 'scripts', 'migrations', 'verify-19-seams-smoke.js');

const normalizeText = require(path.join(PROJECT_ROOT, 'scripts', 'lib', 'normalize-text.js'));
const memoryUpsert = require(path.join(PROJECT_ROOT, 'scripts', 'lib', 'memory-upsert.js'));
const realityChecks = require(path.join(PROJECT_ROOT, 'scripts', 'lib', 'reality-checks.js'));
const carryoverRender = require(path.join(PROJECT_ROOT, 'scripts', 'lib', 'carryover-render.js'));

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

function spawn(scriptPath, args, timeoutMs = 30000) {
  return spawnSync(process.execPath, [scriptPath, ...args], { cwd: PROJECT_ROOT, env: process.env, encoding: 'utf8', timeout: timeoutMs });
}

async function setupFullSeamStack(dbName) {
  let r = spawn(MIGRATE_ONE_PATH, ['--db', dbName]);
  if (r.status !== 0) throw new Error(`migrate-01 failed: ${r.stderr}`);
  r = spawn(ADDENDA_PATH, ['--db', dbName]);
  if (r.status !== 0) throw new Error(`addenda failed: ${r.stderr}`);
  r = spawn(MIGRATE13_PATH, ['--db', dbName]);
  if (r.status !== 0) throw new Error(`migrate-13 (1st apply) failed: ${r.stdout} ${r.stderr}`);
  r = spawn(MIGRATE14_PATH, ['--db', dbName]);
  if (r.status !== 0) throw new Error(`migrate-14 failed: ${r.stdout} ${r.stderr}`);
  r = spawn(MIGRATE13_PATH, ['--db', dbName]); // re-apply to wire seam-table triggers
  // (this re-apply's own CLI exit code is EXPECTED to be 1 post-migrate-14,
  // per migrate-14-seam-tables.sql's documented row_id-widening side effect
  // on migrate-13's own generic self-check — see test-migrate-14-seam-
  // tables.js's testTriggerReapplyWires16 for the full explanation. Its
  // trigger-wiring classification, which is what verify-19 actually
  // depends on, is unaffected.)
}

const DB_MAIN = `verify19_main_${TS}_staging`;
const DB_PREREQ = `verify19_prereq_${TS}_staging`;
const CREATED_DBS = [DB_MAIN, DB_PREREQ];

// ── Group A ──────────────────────────────────────────────────────────────

async function testFreshApplyAllGreen() {
  await setupFullSeamStack(DB_MAIN);
  const r = spawn(SMOKE19_PATH, ['--db', DB_MAIN], 60000);
  assert(r.status === 0, `expected exit 0, got ${r.status}. stdout=${r.stdout} stderr=${r.stderr}`);
  assert(/SMOKE19_RESULT: PASS/.test(r.stdout), `expected the PASS summary line. stdout=${r.stdout}`);
  const failLines = (r.stdout.match(/\[SMOKE-19\]\[\d+\] FAIL.*/g) || []);
  assert(failLines.length === 0, `expected zero FAIL lines, got: ${failLines.join(' | ')}`);
  const passCount = (r.stdout.match(/\[SMOKE-19\]\[\d+\] PASS/g) || []).length;
  assert(passCount === 26, `expected all 26 checks to PASS, got ${passCount}`);
  assert(/residue scan: clean \(0 rows\)/.test(r.stdout), `expected a clean residue scan. stdout=${r.stdout}`);
}

async function testPrereqMissing() {
  await setupFullSeamStack(DB_PREREQ);
  const client = await pgConnect(DB_PREREQ);
  try {
    await client.query('DROP TABLE IF EXISTS decisions CASCADE');
  } finally {
    await client.end();
  }
  const r = spawn(SMOKE19_PATH, ['--db', DB_PREREQ], 30000);
  assert(r.status === 1, `expected exit 1, got ${r.status}. stdout=${r.stdout} stderr=${r.stderr}`);
  assert(/missing prerequisite table\(s\)/.test(r.stderr), `expected a prerequisite refusal. stderr=${r.stderr}`);
  assert(/decisions/.test(r.stderr), `expected the missing table named. stderr=${r.stderr}`);
  assert(/migrate-14-seam-tables\.js/.test(r.stderr), `expected migrate-14 named as the fix. stderr=${r.stderr}`);
}

// ── Group B: DB-free pure unit tests ────────────────────────────────────

function testNormalizeTextCaseWhitespacePunctuation() {
  assertEq(normalizeText.normalizeForCompare('  Uses   Postgres.  '), 'uses postgres', 'normalizes case/whitespace/trailing punctuation');
  assert(!normalizeText.materiallyDifferent('Fixed in PR #92!', 'fixed in pr #92'), 'punctuation-only diff is not material');
  assert(normalizeText.materiallyDifferent('a', 'b'), 'genuinely different content is material');
  assert(!normalizeText.materiallyDifferent(null, ''), 'null/empty normalize identically');
}

function testMemoryUpsertClosedEnum() {
  assertEq(memoryUpsert.ALLOWED_TABLES.length, 9, 'exactly 9 tables in the closed enum (S-1)');
  const expected = ['decisions', 'gotchas', 'findings', 'research', 'incidents', 'code_index', 'tasks', 'checklist_items', 'corpus_files'];
  for (const t of expected) assert(memoryUpsert.ALLOWED_TABLES.includes(t), `${t} in closed enum`);
  // The other 4 §5.3 seam tables have NO live write surface in Phase 7.
  for (const t of ['workflow_discovery', 'agent_rewrites', 'policy_sections', 'session_chunks']) {
    assert(!memoryUpsert.ALLOWED_TABLES.includes(t), `${t} correctly excluded from the write surface`);
  }
}

function testMemoryUpsertValidateRowPure() {
  // S-3: integer columns require an actual JS integer, no string coercion —
  // exercised here without a DB connection (validateRow runs entirely
  // before any SQL is issued).
  try {
    memoryUpsert.validateRow('tasks', memoryUpsert.TABLE_COLUMN_MAP.tasks.columns, {
      project_id: 'p', title: 't', github_issue: '42',
    });
    throw new Error('expected validation error');
  } catch (err) {
    assertEq(err.code, 'validation', 'string-for-int rejected');
  }
  // Float given for an INTEGER column is also rejected (not an integer).
  try {
    memoryUpsert.validateRow('tasks', memoryUpsert.TABLE_COLUMN_MAP.tasks.columns, {
      project_id: 'p', title: 't', github_issue: 42.5,
    });
    throw new Error('expected validation error');
  } catch (err) {
    assertEq(err.code, 'validation', 'non-integer float rejected');
  }
  // Valid row passes validation cleanly (no throw).
  memoryUpsert.validateRow('tasks', memoryUpsert.TABLE_COLUMN_MAP.tasks.columns, {
    project_id: 'p', title: 't', github_issue: 42,
  });
}

function testRealityChecksIsEntityShaped() {
  assert(realityChecks.isEntityShaped('main'), '4-char single token is entity-shaped');
  assert(realityChecks.isEntityShaped('scripts/handoff.js'), 'path-shaped single token is entity-shaped');
  assert(!realityChecks.isEntityShaped('this is a full sentence.'), 'sentence with terminal punctuation is not entity-shaped');
  assert(!realityChecks.isEntityShaped('one two three four five'), '>4 tokens is not entity-shaped');
  assert(!realityChecks.isEntityShaped('42'), 'purely numeric is not entity-shaped');
  assert(!realityChecks.isEntityShaped(''), 'blank is not entity-shaped');
}

function testCarryoverRenderMarkdownPure() {
  const md = carryoverRender.renderCarryoverTable([{ subject: 'S | pipe', object: 'O\nline2' }]);
  assert(md.includes('S \\| pipe'), 'pipe characters escaped');
  assert(!md.includes('\n\n'), 'embedded newline collapsed to a single line');
  assertEq(carryoverRender.renderCarryoverTable(null), '_(no open carry-overs)_', 'null input renders the explicit sentinel');

  // Regression guard: backslash must be escaped FIRST, before pipe-escaping
  // introduces its own backslashes — otherwise a literal (unescaped)
  // backslash immediately preceding the escaped pipe would make the pipe
  // read as UN-escaped to a markdown renderer (a backslash "eats" the
  // escape marker meant for the pipe), corrupting the table's column
  // structure (CodeQL "incomplete string escaping" finding, fixed).
  const md2 = carryoverRender.renderCarryoverTable([{ subject: 'C:\\path | tail', object: 'x' }]);
  assert(md2.includes('C:\\\\path'), 'literal backslashes are themselves escaped (doubled)');
  assert(md2.includes('\\\\path \\| tail'), 'the pipe escape marker is NOT preceded by an unescaped backslash — renders as \\\\path \\| tail, not \\\\| (which a markdown renderer would read as an un-escaped pipe)');
}

// ── Group C: §7.5 promotion-path confirmation ───────────────────────────
//
// §7.5's claim: the promotion mechanism (assertions.promoted/promoted_at,
// /handoff:promote) needs NO code change — it "simply has a larger
// candidate pool since decisions/gotchas/findings are reachable as
// first-class rows." This static check proves the code-level half of that
// claim: cmdPromote's function body (scripts/handoff.js) references ONLY
// the `assertions` table — never any of the 13 §5.3 seam tables, which
// have no `promoted`/`promoted_at` column at all and are structurally
// unreachable from cmdPromote's SQL. (The BEHAVIORAL half — that a
// decisions/gotchas/etc. row cannot itself be promoted, only an assertion
// CAN — follows directly from this: cmdPromote's `FROM assertions WHERE
// id = $1` and `--subject/--predicate/--object` lookups never touch any
// other table, so a seam-table row's own numeric id can never collide with
// or be mistaken for an assertions.id by this code path.)
function testPromotionPathConfinedToAssertions() {
  const handoffSrc = fs.readFileSync(path.join(PROJECT_ROOT, 'scripts', 'handoff.js'), 'utf8');
  const startMatch = handoffSrc.indexOf('async function cmdPromote(args) {');
  assert(startMatch !== -1, 'cmdPromote function found');
  const endMatch = handoffSrc.indexOf('\nasync function cmdResurrect(args) {', startMatch);
  assert(endMatch !== -1, 'cmdResurrect (next function, end boundary) found');
  const body = handoffSrc.slice(startMatch, endMatch);

  const seamTables = [
    'decisions', 'gotchas', 'findings', 'research', 'incidents', 'code_index',
    'tasks', 'checklist_items', 'corpus_files', 'workflow_discovery',
    'agent_rewrites', 'policy_sections', 'session_chunks',
  ];
  for (const t of seamTables) {
    assert(!new RegExp(`\\bFROM\\s+${t}\\b|\\bUPDATE\\s+${t}\\b|\\bINTO\\s+${t}\\b`, 'i').test(body),
      `cmdPromote must never reference table "${t}" (confirms §7.5's no-code-change claim)`);
  }
  assert(/FROM assertions/.test(body), 'cmdPromote reads from assertions');
  assert(/UPDATE assertions/.test(body), 'cmdPromote writes to assertions');
}

async function main() {
  await run('A1', 'Fresh full-stack apply -> exit 0, SMOKE19_RESULT: PASS, all 26 checks green, clean residue scan', testFreshApplyAllGreen);
  await run('A2', 'decisions table missing -> refusal naming migrate-14-seam-tables.js', testPrereqMissing);

  await run('B1', 'normalize-text: case/whitespace/punctuation normalization + materiallyDifferent', () => testNormalizeTextCaseWhitespacePunctuation());
  await run('B2', 'memory-upsert: closed 9-table enum (S-1), 4 excluded tables verified', () => testMemoryUpsertClosedEnum());
  await run('B3', 'memory-upsert: validateRow pure integer-coercion rejection (S-3)', () => testMemoryUpsertValidateRowPure());
  await run('B4', 'reality-checks: isEntityShaped total classification (S-7 shape test)', () => testRealityChecksIsEntityShaped());
  await run('B5', 'carryover-render: renderCarryoverTable pure escaping + sentinel', () => testCarryoverRenderMarkdownPure());

  await run('C1', '§7.5: cmdPromote is confined to `assertions` — never references any of the 13 seam tables', () => testPromotionPathConfinedToAssertions());

  console.log(`\n${passed} passed, ${failed} failed`);
  for (const db of CREATED_DBS) await dropDb(db);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(async (err) => {
  console.error(err && err.stack ? err.stack : err);
  for (const db of CREATED_DBS) await dropDb(db);
  process.exit(1);
});
