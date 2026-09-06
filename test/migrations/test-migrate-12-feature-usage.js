'use strict';

/**
 * test-migrate-12-feature-usage.js — Test harness for
 * scripts/migrations/migrate-12-feature-usage.js (§18.3 owner decision item
 * F, 2026-09-06): the one-time data migration from
 * pipeline_pipeline.feature_token_usage into the consolidation target's
 * feature_usage table.
 *
 * Mirrors test-migrate-schema-addenda.js's conventions: self-contained
 * scratch databases (target names end in "_staging" to satisfy
 * classifyTarget, reused by reference from migrate-01, never forked or
 * bypassed), unconditional finally-block cleanup, never touches
 * claude_memory_eval_test.
 *
 * Requires Postgres at PGHOST/PGUSER/PGPASSWORD (CI env) or
 * localhost/postgres.
 *
 * Usage: node test/migrations/test-migrate-12-feature-usage.js
 * Exit 0 = all pass; nonzero = any failure.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { createRequire } = require('module');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const MIGRATE_ONE_PATH = path.join(PROJECT_ROOT, 'scripts', 'migrations', 'migrate-01-canonical-db.js');
const ADDENDA_PATH = path.join(PROJECT_ROOT, 'scripts', 'migrations', 'migrate-schema-addenda.js');
const SCRIPT_PATH = path.join(PROJECT_ROOT, 'scripts', 'migrations', 'migrate-12-feature-usage.js');

const m12 = require(SCRIPT_PATH);

const scriptsRequire = createRequire(require.resolve('../../scripts/package.json'));
const { Client } = scriptsRequire('pg');

const TS = Date.now();

let passed = 0;
let failed = 0;
function pass(id, label) { console.log(`[${id}] ${label} ... PASS`); passed++; }
function fail(id, label, reason) { console.log(`[${id}] ${label} ... FAIL: ${reason}`); failed++; }

// ── PG helpers ───────────────────────────────────────────────────────────

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

async function createDb(dbName) {
  const sys = await pgConnect('postgres');
  try { await sys.query(`CREATE DATABASE "${dbName}"`); } finally { await sys.end(); }
}

async function dropDb(dbName) {
  let sys;
  try {
    sys = await pgConnect('postgres');
    await sys.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`, [dbName]);
    await sys.query(`DROP DATABASE IF EXISTS "${dbName}"`);
  } catch (_) { /* best-effort */ } finally {
    if (sys) { try { await sys.end(); } catch (_) {} }
  }
}

function runMigrateOne(args) {
  return spawnSync(process.execPath, [MIGRATE_ONE_PATH, ...args], { cwd: PROJECT_ROOT, encoding: 'utf8', timeout: 30000 });
}
function runAddenda(args) {
  return spawnSync(process.execPath, [ADDENDA_PATH, ...args], { cwd: PROJECT_ROOT, encoding: 'utf8', timeout: 30000 });
}
function runM12(args) {
  return spawnSync(process.execPath, [SCRIPT_PATH, ...args], { cwd: PROJECT_ROOT, encoding: 'utf8', timeout: 30000 });
}

const SOURCE_TABLE_DDL = `
  CREATE TABLE feature_token_usage (
    id SERIAL PRIMARY KEY,
    branch TEXT,
    pr_number INTEGER,
    github_issue INTEGER,
    started_at TIMESTAMPTZ NOT NULL,
    completed_at TIMESTAMPTZ,
    model TEXT,
    assistant_msgs INTEGER,
    input_tokens BIGINT,
    output_tokens BIGINT,
    cache_creation_5m_tokens BIGINT,
    cache_creation_1h_tokens BIGINT,
    cache_read_tokens BIGINT,
    cache_hit_pct NUMERIC(5,2),
    tool_calls JSONB,
    session_ids TEXT[],
    notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )
`;

const REPORT_DIR = path.join(os.tmpdir(), `m12-test-reports-${TS}`);

const CREATED_DBS = [];

// ── T1: pure unit — resolveProjectId (longest-prefix, ties, default, unmapped, trim-hint) ──

function testResolveProjectId() {
  const map = {
    branch_prefixes: [
      { prefix: 'feat/', project_id: 'p-feat' },
      { prefix: 'feat/s18-', project_id: 'p-s18' },
    ],
  };
  const longest = m12.resolveProjectId('feat/s18-thing', map, 'cli-default');
  if (longest.projectId === 'p-s18') pass('T1a', 'longest-prefix wins over a shorter also-matching prefix');
  else fail('T1a', 'longest-prefix wins over a shorter also-matching prefix', JSON.stringify(longest));

  const tieMap = { branch_prefixes: [{ prefix: 'x', project_id: 'first' }, { prefix: 'x', project_id: 'second' }] };
  const tie = m12.resolveProjectId('xyz', tieMap, 'cli');
  if (tie.projectId === 'first') pass('T1b', 'tie (identical-length prefixes) -> first in array wins');
  else fail('T1b', 'tie (identical-length prefixes) -> first in array wins', JSON.stringify(tie));

  const mapWithDefault = { branch_prefixes: [{ prefix: 'feat/', project_id: 'p-feat' }], default: 'p-default' };
  const viaDefault = m12.resolveProjectId('bugfix/x', mapWithDefault, 'cli');
  if (viaDefault.projectId === 'p-default') pass('T1c', 'zero prefix matches + map default -> default applies');
  else fail('T1c', 'zero prefix matches + map default -> default applies', JSON.stringify(viaDefault));

  const viaPrefixNotDefault = m12.resolveProjectId('feat/x', mapWithDefault, 'cli');
  if (viaPrefixNotDefault.projectId === 'p-feat') pass('T1d', 'a matching prefix wins over the map default (default only when ZERO prefixes match)');
  else fail('T1d', 'a matching prefix wins over the map default', JSON.stringify(viaPrefixNotDefault));

  const unmapped = m12.resolveProjectId('totally-unrelated', map, 'cli');
  if (unmapped.projectId === null && unmapped.verdict === 'unmapped-branch-totally-unrelated' && !unmapped.hint) {
    pass('T1e', 'zero prefix matches + no default -> unmapped-branch-<raw>, no hint');
  } else {
    fail('T1e', 'zero prefix matches + no default -> unmapped-branch-<raw>, no hint', JSON.stringify(unmapped));
  }

  const trimmed = m12.resolveProjectId('  feat/x', map, 'cli');
  if (trimmed.projectId === null && trimmed.verdict === 'unmapped-branch-  feat/x' && trimmed.hint === 'possible-trim-collision') {
    pass('T1f', 'raw untrimmed branch does not match (leading whitespace); hint=possible-trim-collision when trimming WOULD have matched');
  } else {
    fail('T1f', 'raw untrimmed branch mismatch + trim-collision hint', JSON.stringify(trimmed));
  }

  const noMap = m12.resolveProjectId('anything', null, 'cli-only-project');
  if (noMap.projectId === 'cli-only-project') pass('T1g', 'no --project-map -> every row maps to --project-id');
  else fail('T1g', 'no --project-map -> every row maps to --project-id', JSON.stringify(noMap));
}

// ── T2: pure unit — loadProjectMap (duplicate-prefix refusal, shape validation) ──

function testLoadProjectMap() {
  const dupPath = path.join(os.tmpdir(), `m12-dupmap-${TS}.json`);
  fs.writeFileSync(dupPath, JSON.stringify({ branch_prefixes: [{ prefix: 'x', project_id: 'a' }, { prefix: 'x', project_id: 'b' }] }));
  try {
    let threw = null;
    try { m12.loadProjectMap(dupPath); } catch (e) { threw = e; }
    if (threw instanceof m12.UsageError && /duplicate prefix/.test(threw.message)) pass('T2a', 'duplicate prefix in branch_prefixes refuses loud (UsageError)');
    else fail('T2a', 'duplicate prefix refusal', threw ? threw.message : 'did not throw');
  } finally { fs.unlinkSync(dupPath); }

  const malformedPath = path.join(os.tmpdir(), `m12-malformed-${TS}.json`);
  fs.writeFileSync(malformedPath, JSON.stringify({ branch_prefixes: [{ prefix: '', project_id: 'a' }] }));
  try {
    let threw = null;
    try { m12.loadProjectMap(malformedPath); } catch (e) { threw = e; }
    if (threw instanceof m12.UsageError) pass('T2b', 'empty prefix string refused at load time');
    else fail('T2b', 'empty prefix string refused at load time', threw ? threw.message : 'did not throw');
  } finally { fs.unlinkSync(malformedPath); }
}

// ── T3/T4/T5: pure unit — comparison helpers ────────────────────────────────

function testComparisonHelpers() {
  const arr = m12.arraysEqualOrdered;
  const ok3 = arr(null, null) === true && arr(null, []) === false && arr([], null) === false &&
    arr([], []) === true && arr(['a', 'b'], ['b', 'a']) === false && arr(['a', 'a'], ['a', 'a']) === true;
  if (ok3) pass('T3', 'arraysEqualOrdered: NULL vs [] distinct, order-sensitive, duplicates preserved');
  else fail('T3', 'arraysEqualOrdered', 'one or more cases failed');

  const jd = m12.deepEqualJsonb;
  const ok4 = jd({ a: 1, b: 2 }, { b: 2, a: 1 }) === true &&
    jd([1, 2], [2, 1]) === false &&
    jd(null, null) === true &&
    jd(null, {}) === false &&
    jd([{ x: 1 }], [{ x: 1 }]) === true;
  if (ok4) pass('T4', 'deepEqualJsonb: object key order insensitive, array order sensitive, NULL distinct from {}');
  else fail('T4', 'deepEqualJsonb', 'one or more cases failed');

  const mb = m12.modelBreakdownMatches;
  const ok5 = mb(null, null, null, null, null) === true &&
    mb({ gpt: { tokens_in: 100, tokens_out: 50, turns: 3 } }, 'gpt', '100', '50', 3) === true &&
    mb({ gpt: { tokens_in: 100, tokens_out: 50, turns: 3 } }, 'gpt', '101', '50', 3) === false &&
    mb({ other: { tokens_in: 100, tokens_out: 50, turns: 3 } }, 'gpt', '100', '50', 3) === false;
  if (ok5) pass('T5', 'modelBreakdownMatches: NULL-model case, matching case, token/model-key mismatches');
  else fail('T5', 'modelBreakdownMatches', 'one or more cases failed');
}

// ── T6: pure unit — compareRow (notes-only diff, NULL/0/'{}' distinctness) ──

function baseSrcRow(overrides = {}) {
  return {
    branch: 'feat/x', pr_number: 1, github_issue: null,
    started_at_txt: 'T1', completed_at_txt: null, model: 'm1', assistant_msgs: 2,
    input_tokens_txt: '100', output_tokens_txt: '50',
    cache_creation_5m_tokens_txt: null, cache_creation_1h_tokens_txt: null, cache_read_tokens_txt: '0',
    cache_hit_pct_txt: null, notes: 'hello', session_ids: null, tool_calls: null,
    ...overrides,
  };
}
function baseExistingRow(overrides = {}) {
  return {
    branch: 'feat/x', pr_number: 1, github_issue: null,
    started_at_txt: 'T1', completed_at_txt: null, model_id: 'm1', assistant_msgs: 2,
    tokens_in_txt: '100', tokens_out_txt: '50',
    cache_creation_5m_tokens_txt: null, cache_creation_1h_tokens_txt: null, cache_read_tokens_txt: '0',
    cache_hit_pct_txt: null, cost_usd_txt: null, notes: 'hello', session_ids: null, tool_calls: null,
    model_breakdown: { m1: { tokens_in: 100, tokens_out: 50, turns: 2 } },
    ...overrides,
  };
}

function testCompareRow() {
  const identical = m12.compareRow(baseSrcRow(), baseExistingRow());
  if (identical.identical) pass('T6a', 'compareRow: identical rows -> identical:true');
  else fail('T6a', 'compareRow: identical rows -> identical:true', JSON.stringify(identical.diffs));

  const notesOnly = m12.compareRow(baseSrcRow(), baseExistingRow({ notes: 'DIFFERENT' }));
  if (!notesOnly.identical && notesOnly.diffs.some((d) => d.column === 'notes')) {
    pass('T6b', 'compareRow: notes-only difference -> NOT identical (notes IS a compared column)');
  } else {
    fail('T6b', 'compareRow: notes-only difference -> NOT identical', JSON.stringify(notesOnly));
  }

  const nullVsEmptyArray = m12.compareRow(baseSrcRow({ session_ids: null }), baseExistingRow({ session_ids: [] }));
  if (!nullVsEmptyArray.identical) pass('T6c', 'compareRow: session_ids NULL vs [] are distinct -> conflict');
  else fail('T6c', 'compareRow: session_ids NULL vs [] are distinct', 'reported identical');

  const zeroVsNull = m12.compareRow(baseSrcRow({ cache_read_tokens_txt: '0' }), baseExistingRow({ cache_read_tokens_txt: null }));
  if (!zeroVsNull.identical) pass('T6d', 'compareRow: 0 vs NULL on a BIGINT column are distinct -> conflict');
  else fail('T6d', 'compareRow: 0 vs NULL on a BIGINT column are distinct', 'reported identical');

  const toolCallsKeyOrder = m12.compareRow(
    baseSrcRow({ tool_calls: { a: 1, b: 2 } }),
    baseExistingRow({ tool_calls: { b: 2, a: 1 } })
  );
  if (toolCallsKeyOrder.identical) pass('T6e', 'compareRow: tool_calls JSONB key-order-insensitive -> identical');
  else fail('T6e', 'compareRow: tool_calls JSONB key-order-insensitive', JSON.stringify(toolCallsKeyOrder.diffs));
}

// ── T7-T13: DB-backed end-to-end ────────────────────────────────────────────

async function buildTarget(dbName) {
  CREATED_DBS.push(dbName);
  const r1 = runMigrateOne(['--db', dbName]);
  if (r1.status !== 0) throw new Error(`migrate-01 fixture setup failed: ${r1.stdout}\n${r1.stderr}`);
  const r2 = runAddenda(['--db', dbName]);
  if (r2.status !== 0) throw new Error(`migrate-schema-addenda fixture setup failed: ${r2.stdout}\n${r2.stderr}`);
}

async function buildSource(dbName, rowsSql) {
  CREATED_DBS.push(dbName);
  await createDb(dbName);
  const client = await pgConnect(dbName);
  try {
    await client.query(SOURCE_TABLE_DDL);
    if (rowsSql) await client.query(rowsSql);
  } finally {
    await client.end();
  }
}

async function testFreshMigrationAndBigint() {
  const target = `m12_fresh_${TS}_staging`;
  const source = `m12_fresh_src_${TS}`;
  await buildTarget(target);
  await buildSource(source, `
    INSERT INTO feature_token_usage (branch, pr_number, started_at, model, assistant_msgs, input_tokens, output_tokens, tool_calls, session_ids, notes)
    VALUES ('feat/big', 7, '2026-03-01T00:00:00.654321Z', 'sonnet', 5, 9007199254740993, 42, '[{"name":"Read"}]'::jsonb, ARRAY['s1','s2'], 'n1')
  `);

  const r = runM12(['--db', target, '--source-db', source, '--project-id', 'proj-a', '--report-dir', REPORT_DIR, '--write']);
  if (r.status !== 0) { fail('T7', '1:1 fresh migration', `exit ${r.status}: ${r.stdout}\n${r.stderr}`); return; }

  const client = await pgConnect(target);
  try {
    const { rows } = await client.query('SELECT * FROM feature_usage');
    const row = rows[0];
    const ok = rows.length === 1 &&
      row.project_id === 'proj-a' &&
      row.tokens_in === '9007199254740993' && // BIGINT above 2^53, compared/stored as exact string, never Number()
      row.source_feature_token_usage_id === 1 &&
      row.source_db === source &&
      JSON.stringify(row.session_ids) === JSON.stringify(['s1', 's2']) &&
      row.cost_usd === null;
    if (ok) pass('T7', '1:1 fresh migration: exact row count, project mapping, BIGINT>2^53 exact as string, session_ids verbatim, cost_usd NULL');
    else fail('T7', '1:1 fresh migration', JSON.stringify(row));
  } finally {
    await client.end();
  }
}

async function testIdempotentReRun() {
  const target = `m12_idem_${TS}_staging`;
  const source = `m12_idem_src_${TS}`;
  await buildTarget(target);
  await buildSource(source, `
    INSERT INTO feature_token_usage (branch, started_at, assistant_msgs, notes)
    VALUES ('feat/idem', '2026-03-02T00:00:00.111111Z', 1, 'stable notes')
  `);

  const r1 = runM12(['--db', target, '--source-db', source, '--project-id', 'proj-b', '--report-dir', REPORT_DIR, '--write']);
  if (r1.status !== 0) { fail('T8', 'idempotent re-run', `first run failed: ${r1.stdout}\n${r1.stderr}`); return; }
  const r2 = runM12(['--db', target, '--source-db', source, '--project-id', 'proj-b', '--report-dir', REPORT_DIR, '--write']);
  if (r2.status !== 0) { fail('T8', 'idempotent re-run', `second run failed: ${r2.stdout}\n${r2.stderr}`); return; }

  const client = await pgConnect(target);
  try {
    const { rows } = await client.query('SELECT count(*) AS n FROM feature_usage WHERE project_id = $1', ['proj-b']);
    const ok = /update-identical=1/.test(r2.stdout) && Number(rows[0].n) === 1;
    if (ok) pass('T8', 'idempotent re-run: verdict=update-identical, zero duplication');
    else fail('T8', 'idempotent re-run', `stdout=${r2.stdout} count=${rows[0].n}`);
  } finally {
    await client.end();
  }
}

async function testDryRunZeroWrites() {
  const target = `m12_dry_${TS}_staging`;
  const source = `m12_dry_src_${TS}`;
  await buildTarget(target);
  await buildSource(source, `INSERT INTO feature_token_usage (branch, started_at, assistant_msgs) VALUES ('feat/dry', '2026-03-03T00:00:00Z', 1)`);

  const r = runM12(['--db', target, '--source-db', source, '--project-id', 'proj-c', '--report-dir', REPORT_DIR]);
  const client = await pgConnect(target);
  try {
    const { rows } = await client.query('SELECT count(*) AS n FROM feature_usage');
    const ok = r.status === 0 && /DRY-RUN-COMPLETE/.test(r.stdout) && Number(rows[0].n) === 0;
    if (ok) pass('T9', 'default (no --write) dry-run: zero rows written');
    else fail('T9', 'default dry-run zero writes', `status=${r.status} stdout=${r.stdout} count=${rows[0].n}`);
  } finally {
    await client.end();
  }

  // --dry-run + --write mutually exclusive
  const r2 = runM12(['--db', target, '--source-db', source, '--project-id', 'proj-c', '--dry-run', '--write']);
  if (r2.status === 2) pass('T9b', '--dry-run and --write are mutually exclusive (exit 2)');
  else fail('T9b', '--dry-run and --write mutually exclusive', `status=${r2.status}`);
}

async function testConflictAndAllowUpdate() {
  const target = `m12_conflict_${TS}_staging`;
  const source = `m12_conflict_src_${TS}`;
  await buildTarget(target);
  await buildSource(source, `INSERT INTO feature_token_usage (branch, started_at, assistant_msgs, notes) VALUES ('feat/c', '2026-03-04T00:00:00Z', 1, 'original')`);

  const r1 = runM12(['--db', target, '--source-db', source, '--project-id', 'proj-d', '--report-dir', REPORT_DIR, '--write']);
  if (r1.status !== 0) { fail('T10', 'refuse-conflict + allow-update-on-conflict', `initial write failed: ${r1.stdout}`); return; }

  const client = await pgConnect(target);
  await client.query(`UPDATE feature_usage SET notes = 'mutated' WHERE project_id = 'proj-d'`);

  const r2 = runM12(['--db', target, '--source-db', source, '--project-id', 'proj-d', '--report-dir', REPORT_DIR, '--write']);
  const conflictOk = r2.status === 0 && /refuse-conflict=1/.test(r2.stdout);
  const { rows: afterRefuse } = await client.query(`SELECT notes FROM feature_usage WHERE project_id = 'proj-d'`);
  const notMutated = afterRefuse[0].notes === 'mutated'; // refused -> unchanged
  if (conflictOk && notMutated) pass('T10a', 'refuse-conflict: diverging row refused, target row left untouched');
  else fail('T10a', 'refuse-conflict', `stdout=${r2.stdout} notes=${afterRefuse[0].notes}`);

  const r3 = runM12(['--db', target, '--source-db', source, '--project-id', 'proj-d', '--report-dir', REPORT_DIR, '--write', '--allow-update-on-conflict']);
  const { rows: afterAllow } = await client.query(`SELECT notes FROM feature_usage WHERE project_id = 'proj-d'`);
  await client.end();
  const allowOk = r3.status === 0 && /update=1/.test(r3.stdout) && afterAllow[0].notes === 'original';
  if (allowOk) pass('T10b', '--allow-update-on-conflict: diverging row UPDATEd back to the source value');
  else fail('T10b', '--allow-update-on-conflict', `stdout=${r3.stdout} notes=${afterAllow[0].notes}`);
}

async function testUnmappedBucket() {
  const target = `m12_unmapped_${TS}_staging`;
  const source = `m12_unmapped_src_${TS}`;
  await buildTarget(target);
  await buildSource(source, `INSERT INTO feature_token_usage (branch, started_at, assistant_msgs) VALUES ('totally-unrelated', '2026-03-05T00:00:00Z', 1)`);

  const mapPath = path.join(os.tmpdir(), `m12-nodefault-map-${TS}.json`);
  fs.writeFileSync(mapPath, JSON.stringify({ branch_prefixes: [{ prefix: 'feat/', project_id: 'proj-feat' }] }));

  const r = runM12(['--db', target, '--source-db', source, '--project-id', 'proj-fallback', '--project-map', mapPath, '--report-dir', REPORT_DIR, '--write']);
  const client = await pgConnect(target);
  try {
    const { rows } = await client.query('SELECT count(*) AS n FROM feature_usage');
    const ok = r.status === 0 && /unmapped=1/.test(r.stdout) && Number(rows[0].n) === 0;
    if (ok) pass('T11', 'unmapped bucket: zero prefixes match + no map default -> unmapped, nothing written');
    else fail('T11', 'unmapped bucket', `stdout=${r.stdout} count=${rows[0].n}`);
  } finally {
    await client.end();
  }
}

async function testPreconditionRefusals() {
  const target = `m12_precond_${TS}_staging`;
  const sourceMissingCol = `m12_precond_missing_${TS}`;
  const sourceUnknownCol = `m12_precond_unknown_${TS}`;
  const sourceTypeMismatch = `m12_precond_type_${TS}`;
  const targetNoTable = `m12_precond_notable_${TS}_staging`;

  await buildTarget(target);

  await buildSource(sourceMissingCol, null);
  const c1 = await pgConnect(sourceMissingCol);
  await c1.query('ALTER TABLE feature_token_usage DROP COLUMN notes');
  await c1.end();
  const r1 = runM12(['--db', target, '--source-db', sourceMissingCol, '--project-id', 'p', '--report-dir', REPORT_DIR]);
  if (r1.status !== 0 && /missing expected column/.test(r1.stdout + r1.stderr)) pass('T12a', 'precondition: missing expected source column refuses the whole run');
  else fail('T12a', 'precondition: missing column', `status=${r1.status} stdout=${r1.stdout} stderr=${r1.stderr}`);

  await buildSource(sourceUnknownCol, null);
  const c2 = await pgConnect(sourceUnknownCol);
  await c2.query('ALTER TABLE feature_token_usage ADD COLUMN some_new_column TEXT');
  await c2.end();
  const r2 = runM12(['--db', target, '--source-db', sourceUnknownCol, '--project-id', 'p', '--report-dir', REPORT_DIR]);
  if (r2.status !== 0 && /unknown live column/.test(r2.stdout + r2.stderr)) pass('T12b', 'precondition: unknown live source column refuses the whole run (schema drift)');
  else fail('T12b', 'precondition: unknown column', `status=${r2.status} stdout=${r2.stdout} stderr=${r2.stderr}`);

  await buildSource(sourceTypeMismatch, null);
  const c3 = await pgConnect(sourceTypeMismatch);
  await c3.query('ALTER TABLE feature_token_usage ALTER COLUMN assistant_msgs TYPE TEXT USING assistant_msgs::text');
  await c3.end();
  const r3 = runM12(['--db', target, '--source-db', sourceTypeMismatch, '--project-id', 'p', '--report-dir', REPORT_DIR]);
  if (r3.status !== 0 && /type mismatch/.test(r3.stdout + r3.stderr)) pass('T12c', 'precondition: declared-type mismatch on a source column refuses the whole run');
  else fail('T12c', 'precondition: type mismatch', `status=${r3.status} stdout=${r3.stdout} stderr=${r3.stderr}`);

  CREATED_DBS.push(targetNoTable);
  const r4a = runMigrateOne(['--db', targetNoTable]);
  if (r4a.status !== 0) { fail('T12d', 'precondition: target table missing', 'migrate-01 fixture setup failed'); return; }
  await buildSource(`m12_precond_src4_${TS}`, null);
  const r4 = runM12(['--db', targetNoTable, '--source-db', `m12_precond_src4_${TS}`, '--project-id', 'p', '--report-dir', REPORT_DIR]);
  if (r4.status !== 0 && /missing the feature_usage table/.test(r4.stdout + r4.stderr)) pass('T12d', 'precondition: target feature_usage table absent refuses (never auto-creates)');
  else fail('T12d', 'precondition: target table missing', `status=${r4.status} stdout=${r4.stdout} stderr=${r4.stderr}`);
}

async function testRollbackByPairsNeverByProjectId() {
  const target = `m12_rollback_${TS}_staging`;
  const sourceA = `m12_rollback_srca_${TS}`;
  const sourceB = `m12_rollback_srcb_${TS}`;
  await buildTarget(target);
  // Two DIFFERENT source databases each with their own row id=1 -- proves
  // rollback scopes by (source_db, source_id) pairs, and that the two
  // source DBs' colliding ids coexist as two distinct target rows (spec:
  // "two source DBs colliding ids").
  await buildSource(sourceA, `INSERT INTO feature_token_usage (branch, started_at, assistant_msgs) VALUES ('feat/a', '2026-03-06T00:00:00Z', 1)`);
  await buildSource(sourceB, `INSERT INTO feature_token_usage (branch, started_at, assistant_msgs) VALUES ('feat/b', '2026-03-06T00:00:00Z', 1)`);

  const rA = runM12(['--db', target, '--source-db', sourceA, '--project-id', 'proj-same', '--report-dir', REPORT_DIR, '--write']);
  const rB = runM12(['--db', target, '--source-db', sourceB, '--project-id', 'proj-same', '--report-dir', REPORT_DIR, '--write']);
  if (rA.status !== 0 || rB.status !== 0) { fail('T13', 'rollback by pairs + colliding source ids', `writes failed: ${rA.stdout} / ${rB.stdout}`); return; }

  const client = await pgConnect(target);
  const { rows: bothRows } = await client.query(`SELECT source_db, source_feature_token_usage_id FROM feature_usage WHERE project_id = 'proj-same' ORDER BY source_db`);
  const collidingIdsCoexist = bothRows.length === 2 && bothRows.every((r) => r.source_feature_token_usage_id === 1) && bothRows[0].source_db !== bothRows[1].source_db;
  if (collidingIdsCoexist) pass('T13a', 'two source DBs with colliding source ids (both id=1) coexist as two distinct target rows');
  else fail('T13a', 'colliding source ids coexist', JSON.stringify(bothRows));

  // Roll back ONLY sourceA's report -- sourceB's row (same project_id) must survive.
  const reportPathA = /report: (.*\.json)/.exec(rA.stdout)[1].trim();
  const rollback = runM12(['--db', target, '--rollback', reportPathA]);
  const { rows: afterRollback } = await client.query(`SELECT source_db FROM feature_usage WHERE project_id = 'proj-same'`);
  await client.end();

  const rollbackOk = rollback.status === 0 && /deleted 1 row/.test(rollback.stdout) &&
    afterRollback.length === 1 && afterRollback[0].source_db === sourceB;
  if (rollbackOk) pass('T13b', 'rollback deletes ONLY the given report\'s (source_db, source_id) pairs -- never by project_id (sourceB row survives)');
  else fail('T13b', 'rollback scoped by pairs, not project_id', `stdout=${rollback.stdout} rows=${JSON.stringify(afterRollback)}`);
}

// ── Main ─────────────────────────────────────────────────────────────────

async function main() {
  try {
    testResolveProjectId();
    testLoadProjectMap();
    testComparisonHelpers();
    testCompareRow();

    await testFreshMigrationAndBigint();
    await testIdempotentReRun();
    await testDryRunZeroWrites();
    await testConflictAndAllowUpdate();
    await testUnmappedBucket();
    await testPreconditionRefusals();
    await testRollbackByPairsNeverByProjectId();
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
