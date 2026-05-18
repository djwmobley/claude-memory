'use strict';

/**
 * test-sqlite-seam.js — Unit and integration tests for the SQLite storage seam.
 *
 * Tests db-seam.js in isolation (no Postgres, no subprocess, no network).
 * All databases are in-memory (:memory:) or a temp file that is cleaned up.
 *
 * Requires Node >= 22 (for node:sqlite built-in). If run on Node < 22 the test
 * suite exits 0 with a SKIP notice so CI on Node 20 is not broken.
 *
 * Usage:
 *   node scripts/test-sqlite-seam.js
 *
 * Exit 0 = all pass (or Node < 22 skip); 1 = any failure.
 */

const os   = require('os');
const path = require('path');
const fs   = require('fs');

// ── Node version guard ────────────────────────────────────────────────────────
const [nodeMajor] = process.versions.node.split('.').map(Number);
if (nodeMajor < 22) {
  console.log(`[SKIP] test-sqlite-seam.js: Node ${process.versions.node} < 22; node:sqlite not available. CI uses Node 20 — Postgres-only path tested there.`);
  process.exit(0);
}

const {
  resolveDialect,
  createClient,
  rewriteForSQLite,
  buildInClause,
  buildSQLiteGraphCTE,
  resolveSQLiteDbPath,
  splitStatements,
  deserializeRow,
  serializeParams,
  SQLiteClient,
} = require('./lib/db-seam');

const SCHEMA_FILE = path.resolve(__dirname, 'sql', 'handoff-sqlite-schema.sql');

// ── Tracking ─────────────────────────────────────────────────────────────────
let passed  = 0;
let failed  = 0;
const failures = [];

function test(label, fn) {
  try {
    const r = fn();
    if (r && typeof r.then === 'function') {
      return r.then(() => {
        console.log(`PASS  ${label}`);
        passed++;
      }).catch((err) => {
        console.log(`FAIL  ${label}: ${err.message}`);
        failures.push({ label, err });
        failed++;
      });
    }
    console.log(`PASS  ${label}`);
    passed++;
  } catch (err) {
    console.log(`FAIL  ${label}: ${err.message}`);
    failures.push({ label, err });
    failed++;
  }
  return Promise.resolve();
}

function assertEqual(actual, expected, msg) {
  if (actual !== expected)
    throw new Error(`${msg || 'assertEqual'}: expected ${JSON.stringify(expected)} got ${JSON.stringify(actual)}`);
}

function assertDeepEqual(actual, expected, msg) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${msg || 'assertDeepEqual'}: expected ${b} got ${a}`);
}

function assertTrue(v, msg) {
  if (!v) throw new Error(msg || `expected truthy got ${JSON.stringify(v)}`);
}

// ── Helper: create an in-memory SQLiteClient ──────────────────────────────────
async function makeMemDb() {
  const c = new SQLiteClient(':memory:');
  await c.connect();
  return c;
}

// ── SECTION 1: resolveDialect ─────────────────────────────────────────────────
async function runSection1() {
  console.log('\n=== Section 1: resolveDialect ===');

  await test('env STORAGE_BACKEND=sqlite wins', () => {
    const saved = process.env.STORAGE_BACKEND;
    process.env.STORAGE_BACKEND = 'sqlite';
    try { assertEqual(resolveDialect({}), 'sqlite'); }
    finally { if (saved === undefined) delete process.env.STORAGE_BACKEND; else process.env.STORAGE_BACKEND = saved; }
  });

  await test('env STORAGE_BACKEND=postgres wins', () => {
    const saved = process.env.STORAGE_BACKEND;
    process.env.STORAGE_BACKEND = 'postgres';
    try { assertEqual(resolveDialect({ storage_backend: 'sqlite' }), 'postgres'); }
    finally { if (saved === undefined) delete process.env.STORAGE_BACKEND; else process.env.STORAGE_BACKEND = saved; }
  });

  await test('cfg.storage_backend=sqlite wins when env unset', () => {
    const saved = process.env.STORAGE_BACKEND;
    delete process.env.STORAGE_BACKEND;
    try { assertEqual(resolveDialect({ storage_backend: 'sqlite' }), 'sqlite'); }
    finally { if (saved === undefined) delete process.env.STORAGE_BACKEND; else process.env.STORAGE_BACKEND = saved; }
  });

  await test('defaults to postgres when nothing set', () => {
    const saved = process.env.STORAGE_BACKEND;
    delete process.env.STORAGE_BACKEND;
    try { assertEqual(resolveDialect({}), 'postgres'); }
    finally { if (saved === undefined) delete process.env.STORAGE_BACKEND; else process.env.STORAGE_BACKEND = saved; }
  });
}

// ── SECTION 2: rewriteForSQLite ───────────────────────────────────────────────
async function runSection2() {
  console.log('\n=== Section 2: rewriteForSQLite ===');

  await test('$N placeholders rewritten to ?', () => {
    const out = rewriteForSQLite('SELECT * FROM t WHERE id=$1 AND x=$2');
    assertEqual(out, 'SELECT * FROM t WHERE id=? AND x=?');
  });

  await test('EXTRACT(EPOCH FROM (now()-col))/86400 -> julianday', () => {
    const sql = 'ORDER BY EXTRACT(EPOCH FROM (now() - last_reinforced)) / 86400 ASC';
    const out = rewriteForSQLite(sql);
    assertTrue(out.includes("julianday('now') - julianday(last_reinforced)"),
      `Expected julianday rewrite, got: ${out}`);
    assertTrue(!out.includes('EXTRACT'), `Should not contain EXTRACT: ${out}`);
  });

  await test('now() -> datetime(\'now\')', () => {
    const out = rewriteForSQLite("INSERT INTO t VALUES (now())");
    assertTrue(out.includes("datetime('now')"), `Expected datetime rewrite: ${out}`);
  });

  await test('::int[] cast stripped', () => {
    const out = rewriteForSQLite("WHERE id = ANY($1::int[])");
    assertTrue(!out.includes('::int[]'), `Should strip ::int[]: ${out}`);
  });

  await test('TIMESTAMPTZ -> TEXT in DDL', () => {
    const out = rewriteForSQLite('created_at TIMESTAMPTZ NOT NULL');
    assertEqual(out, 'created_at TEXT NOT NULL');
  });

  await test('::jsonb cast stripped', () => {
    const out = rewriteForSQLite("$1::jsonb");
    assertTrue(!out.includes('::jsonb'), `Should strip ::jsonb: ${out}`);
  });
}

// ── SECTION 3: serializeParams / deserializeRow ───────────────────────────────
async function runSection3() {
  console.log('\n=== Section 3: param serialization ===');

  await test('serializeParams serializes objects to JSON strings', () => {
    const params = [1, { a: 1, b: [1, 2] }, 'hello'];
    const out = serializeParams(params);
    assertEqual(out[0], 1);
    assertEqual(typeof out[1], 'string');
    assertEqual(JSON.parse(out[1]).b[1], 2);
    assertEqual(out[2], 'hello');
  });

  await test('serializeParams handles null', () => {
    const out = serializeParams([null, 42]);
    assertEqual(out[0], null);
    assertEqual(out[1], 42);
  });

  await test('deserializeRow parses queries column JSON', () => {
    const row = { id: 1, queries: '{"type":"assertion"}', other: 'x' };
    const out = deserializeRow(row);
    assertEqual(typeof out.queries, 'object');
    assertEqual(out.queries.type, 'assertion');
    assertEqual(out.other, 'x');
    assertEqual(out.id, 1);
  });

  await test('deserializeRow handles non-JSON string gracefully', () => {
    const row = { queries: 'not-json' };
    // Should not throw; leaves as-is
    const out = deserializeRow(row);
    assertEqual(out.queries, 'not-json');
  });
}

// ── SECTION 4: buildInClause ──────────────────────────────────────────────────
async function runSection4() {
  console.log('\n=== Section 4: buildInClause ===');

  await test('builds IN clause for single value', () => {
    const { clause, params } = buildInClause('id', [42]);
    assertEqual(clause, 'id IN (?)');
    assertDeepEqual(params, [42]);
  });

  await test('builds IN clause for multiple values', () => {
    const { clause, params } = buildInClause('entity_name', ['A', 'B', 'C']);
    assertEqual(clause, 'entity_name IN (?, ?, ?)');
    assertDeepEqual(params, ['A', 'B', 'C']);
  });

  await test('empty values gives 1=0', () => {
    const { clause, params } = buildInClause('id', []);
    assertEqual(clause, '1=0');
    assertDeepEqual(params, []);
  });
}

// ── SECTION 5: splitStatements ────────────────────────────────────────────────
async function runSection5() {
  console.log('\n=== Section 5: splitStatements ===');

  await test('splits semicolons correctly', () => {
    const stmts = splitStatements('SELECT 1; SELECT 2; SELECT 3');
    assertEqual(stmts.length, 3);
  });

  await test('handles single-quoted strings with semicolons', () => {
    const stmts = splitStatements("SELECT ';' AS x; SELECT 1");
    assertEqual(stmts.length, 2);
  });

  await test('handles -- comments', () => {
    const stmts = splitStatements('-- comment\nSELECT 1; SELECT 2');
    assertEqual(stmts.length, 2);
  });
}

// ── SECTION 6: SQLiteClient — basic query ─────────────────────────────────────
async function runSection6() {
  console.log('\n=== Section 6: SQLiteClient basic queries ===');

  await test('SELECT 1 returns row', async () => {
    const db = await makeMemDb();
    try {
      const res = await db.query('SELECT 1 AS n');
      assertEqual(res.rows[0].n, 1);
    } finally { await db.end(); }
  });

  await test('CREATE TABLE and INSERT RETURNING id', async () => {
    const db = await makeMemDb();
    try {
      await db.query('CREATE TABLE foo (id INTEGER PRIMARY KEY, val TEXT)');
      const res = await db.query("INSERT INTO foo (val) VALUES (?) RETURNING id", ['hello']);
      assertTrue(res.rows[0].id != null, 'Should return id');
    } finally { await db.end(); }
  });

  await test('$1 placeholders rewritten in query()', async () => {
    const db = await makeMemDb();
    try {
      await db.query('CREATE TABLE bar (id INTEGER PRIMARY KEY, x INTEGER)');
      await db.query('INSERT INTO bar (x) VALUES ($1)', [42]);
      const res = await db.query('SELECT x FROM bar WHERE x = $1', [42]);
      assertEqual(res.rows[0].x, 42);
    } finally { await db.end(); }
  });

  await test('BEGIN / COMMIT / ROLLBACK transaction management', async () => {
    const db = await makeMemDb();
    try {
      await db.query('CREATE TABLE txtest (id INTEGER PRIMARY KEY, v INTEGER)');
      await db.query('BEGIN');
      await db.query('INSERT INTO txtest (v) VALUES ($1)', [99]);
      await db.query('COMMIT');
      const res = await db.query('SELECT v FROM txtest');
      assertEqual(res.rows[0].v, 99);
    } finally { await db.end(); }
  });

  await test('ROLLBACK discards changes', async () => {
    const db = await makeMemDb();
    try {
      await db.query('CREATE TABLE rolltest (id INTEGER PRIMARY KEY, v INTEGER)');
      await db.query('BEGIN');
      await db.query('INSERT INTO rolltest (v) VALUES ($1)', [7]);
      await db.query('ROLLBACK');
      const res = await db.query('SELECT COUNT(*) AS cnt FROM rolltest');
      assertEqual(Number(res.rows[0].cnt), 0);
    } finally { await db.end(); }
  });

  await test('dialect property is "sqlite"', async () => {
    const db = await makeMemDb();
    try { assertEqual(db.dialect, 'sqlite'); }
    finally { await db.end(); }
  });
}

// ── SECTION 7: SQLiteClient — schema application ─────────────────────────────
async function runSection7() {
  console.log('\n=== Section 7: Schema application (handoff-sqlite-schema.sql) ===');

  await test('handoff-sqlite-schema.sql file exists on disk', () => {
    assertTrue(fs.existsSync(SCHEMA_FILE), `Schema file not found: ${SCHEMA_FILE}`);
  });

  await test('runSchema() applies handoff core tables idempotently', async () => {
    const db = await makeMemDb();
    try {
      const sql = fs.readFileSync(SCHEMA_FILE, 'utf8');
      await db.runSchema(sql);
      // Apply twice to prove idempotency
      await db.runSchema(sql);
      const res = await db.query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name");
      const tables = res.rows.map((r) => r.name);
      for (const t of ['entities','assertions','edges','retrieval_contract',
                        'retrieval_events','retrieval_event_assertions','project_settings']) {
        assertTrue(tables.includes(t), `Table ${t} should exist after schema apply`);
      }
    } finally { await db.end(); }
  });

  await test('retrieval_events has no query_embedding column', async () => {
    const db = await makeMemDb();
    try {
      const sql = fs.readFileSync(SCHEMA_FILE, 'utf8');
      await db.runSchema(sql);
      const res = await db.query("PRAGMA table_info(retrieval_events)");
      const cols = res.rows.map((r) => r.name);
      assertTrue(!cols.includes('query_embedding'), 'query_embedding should not exist');
    } finally { await db.end(); }
  });

  await test('assertions table has promoted and promoted_at columns', async () => {
    const db = await makeMemDb();
    try {
      const sql = fs.readFileSync(SCHEMA_FILE, 'utf8');
      await db.runSchema(sql);
      const res = await db.query("PRAGMA table_info(assertions)");
      const cols = res.rows.map((r) => r.name);
      assertTrue(cols.includes('promoted'), 'promoted column should exist');
      assertTrue(cols.includes('promoted_at'), 'promoted_at column should exist');
    } finally { await db.end(); }
  });
}

// ── SECTION 8: JSONB/queries column round-trip ───────────────────────────────
async function runSection8() {
  console.log('\n=== Section 8: JSONB (TEXT + auto-parse) round-trip ===');

  await test('queries column stored as TEXT, deserialized to object on read', async () => {
    const db = await makeMemDb();
    try {
      const sql = fs.readFileSync(SCHEMA_FILE, 'utf8');
      await db.runSchema(sql);
      const queries = [{ kind: 'assertion', subject: 'X', limit: 5 }];
      await db.query(
        `INSERT INTO retrieval_contract (project_id, name, queries) VALUES ($1, $2, $3)`,
        ['proj1', 'test-contract', queries]
      );
      const res = await db.query(
        `SELECT queries FROM retrieval_contract WHERE project_id=$1 AND name=$2`,
        ['proj1', 'test-contract']
      );
      assertTrue(typeof res.rows[0].queries === 'object', 'queries should be deserialized to object');
      assertEqual(res.rows[0].queries[0].kind, 'assertion');
    } finally { await db.end(); }
  });
}

// ── SECTION 9: date arithmetic equivalence ───────────────────────────────────
async function runSection9() {
  console.log('\n=== Section 9: Date arithmetic (julianday equivalence) ===');

  await test('decay ORDER BY rewrite produces numeric result near 0 for fresh row', async () => {
    const db = await makeMemDb();
    try {
      await db.query('CREATE TABLE decay_test (id INTEGER PRIMARY KEY, last_reinforced TEXT DEFAULT (datetime(\'now\')))');
      await db.query('INSERT INTO decay_test (id) VALUES (1)');
      // Simulate the decay ORDER BY after rewrite: (julianday('now')-julianday(last_reinforced))
      const res = await db.query(
        `SELECT (julianday('now') - julianday(last_reinforced)) AS decay_days FROM decay_test WHERE id=1`
      );
      const days = Number(res.rows[0].decay_days);
      assertTrue(days >= 0 && days < 1, `Decay days should be near 0 for fresh row, got: ${days}`);
    } finally { await db.end(); }
  });
}

// ── SECTION 10: buildSQLiteGraphCTE ──────────────────────────────────────────
async function runSection10() {
  console.log('\n=== Section 10: buildSQLiteGraphCTE ===');

  await test('out direction generates valid SQL with correct params count', () => {
    const { sql, params } = buildSQLiteGraphCTE('out', ['A', 'B'], 3, 50, 'proj1');
    assertTrue(sql.includes('WITH RECURSIVE'), 'Should have recursive CTE');
    assertTrue(sql.includes("INSTR('|' || t.path || '|'"), 'Should have INSTR cycle prevention');
    assertTrue(Array.isArray(params), 'params should be array');
    assertTrue(params.includes('proj1'), 'params should include project_id');
  });

  await test('in direction generates valid SQL', () => {
    const { sql, params } = buildSQLiteGraphCTE('in', ['X'], 2, 20, 'p2');
    assertTrue(sql.includes('WITH RECURSIVE'), 'Should have recursive CTE');
    assertTrue(sql.includes('from_entity'), 'in direction should use from_entity');
  });

  await test('both direction generates dual CTEs', () => {
    const { sql } = buildSQLiteGraphCTE('both', ['A'], 3, 50, 'p3');
    assertTrue(sql.includes('gt_out'), 'both direction should have gt_out CTE');
    assertTrue(sql.includes('gt_in'),  'both direction should have gt_in CTE');
  });

  await test('graph CTE executes against SQLite schema and returns expected results', async () => {
    const db = await makeMemDb();
    try {
      const schemaSql = fs.readFileSync(SCHEMA_FILE, 'utf8');
      await db.runSchema(schemaSql);

      const projectId = 'graph-test-1';
      // Insert entities
      for (const name of ['A','B','C','D']) {
        await db.query(
          `INSERT INTO entities (project_id, name, entity_type) VALUES (?,?,?)`,
          [projectId, name, 'concept']
        );
      }
      // Insert edges: A->B, B->C, C->D
      await db.query(`INSERT INTO edges (project_id, from_entity, edge_type, to_entity, weight) VALUES (?,?,?,?,?)`,
        [projectId, 'A', 'relates_to', 'B', 1.0]);
      await db.query(`INSERT INTO edges (project_id, from_entity, edge_type, to_entity, weight) VALUES (?,?,?,?,?)`,
        [projectId, 'B', 'relates_to', 'C', 0.8]);
      await db.query(`INSERT INTO edges (project_id, from_entity, edge_type, to_entity, weight) VALUES (?,?,?,?,?)`,
        [projectId, 'C', 'relates_to', 'D', 0.6]);

      const { sql: cteSql, params: cteParams } =
        buildSQLiteGraphCTE('out', ['A'], 5, 100, projectId);
      const res = await db.query(cteSql, cteParams);
      const names = res.rows.map((r) => r.entity_name).sort();
      assertDeepEqual(names, ['B','C','D'], 'Should traverse A->B->C->D');
    } finally { await db.end(); }
  });

  await test('cycle prevention: A->B->A cycle does not infinite-loop', async () => {
    const db = await makeMemDb();
    try {
      const schemaSql = fs.readFileSync(SCHEMA_FILE, 'utf8');
      await db.runSchema(schemaSql);

      const projectId = 'cycle-test-1';
      for (const name of ['A','B']) {
        await db.query(`INSERT INTO entities (project_id, name, entity_type) VALUES (?,?,?)`,
          [projectId, name, 'concept']);
      }
      // Cycle: A->B, B->A
      await db.query(`INSERT INTO edges (project_id, from_entity, edge_type, to_entity, weight) VALUES (?,?,?,?,?)`,
        [projectId, 'A', 'relates_to', 'B', 1.0]);
      await db.query(`INSERT INTO edges (project_id, from_entity, edge_type, to_entity, weight) VALUES (?,?,?,?,?)`,
        [projectId, 'B', 'relates_to', 'A', 1.0]);

      const { sql: cteSql, params: cteParams } =
        buildSQLiteGraphCTE('out', ['A'], 5, 100, projectId);
      const res = await db.query(cteSql, cteParams);
      // Should only get B (cycle back to A is suppressed)
      assertEqual(res.rows.length, 1, `Expected 1 row, got ${res.rows.length}`);
      assertEqual(res.rows[0].entity_name, 'B');
    } finally { await db.end(); }
  });

  await test('depth clamp: maxDepth=2 stops at 2 hops', async () => {
    const db = await makeMemDb();
    try {
      const schemaSql = fs.readFileSync(SCHEMA_FILE, 'utf8');
      await db.runSchema(schemaSql);

      const projectId = 'depth-test-1';
      for (const name of ['A','B','C','D']) {
        await db.query(`INSERT INTO entities (project_id, name, entity_type) VALUES (?,?,?)`,
          [projectId, name, 'concept']);
      }
      await db.query(`INSERT INTO edges (project_id, from_entity, edge_type, to_entity, weight) VALUES (?,?,?,?,?)`,
        [projectId, 'A', 'r', 'B', 1.0]);
      await db.query(`INSERT INTO edges (project_id, from_entity, edge_type, to_entity, weight) VALUES (?,?,?,?,?)`,
        [projectId, 'B', 'r', 'C', 1.0]);
      await db.query(`INSERT INTO edges (project_id, from_entity, edge_type, to_entity, weight) VALUES (?,?,?,?,?)`,
        [projectId, 'C', 'r', 'D', 1.0]);

      const { sql: cteSql, params: cteParams } =
        buildSQLiteGraphCTE('out', ['A'], 2, 100, projectId);
      const res = await db.query(cteSql, cteParams);
      const names = res.rows.map((r) => r.entity_name).sort();
      // depth=2: should reach B (depth 1) and C (depth 2), not D (depth 3)
      assertDeepEqual(names, ['B','C'], `Depth clamp failed: got ${names}`);
    } finally { await db.end(); }
  });
}

// ── SECTION 11: resolveSQLiteDbPath ──────────────────────────────────────────
async function runSection11() {
  console.log('\n=== Section 11: resolveSQLiteDbPath ===');

  await test('default path is <root>/.claude/handoff.sqlite', () => {
    const saved = process.env.HANDOFF_SQLITE_PATH;
    delete process.env.HANDOFF_SQLITE_PATH;
    try {
      const p = resolveSQLiteDbPath('/some/project');
      assertEqual(p, path.join('/some/project', '.claude', 'handoff.sqlite'));
    } finally {
      if (saved !== undefined) process.env.HANDOFF_SQLITE_PATH = saved;
    }
  });

  await test('HANDOFF_SQLITE_PATH env var overrides default', () => {
    process.env.HANDOFF_SQLITE_PATH = '/tmp/custom.sqlite';
    try {
      const p = resolveSQLiteDbPath('/some/project');
      assertEqual(p, '/tmp/custom.sqlite');
    } finally { delete process.env.HANDOFF_SQLITE_PATH; }
  });
}

// ── SECTION 12: createClient factory — SQLite path ───────────────────────────
async function runSection12() {
  console.log('\n=== Section 12: createClient factory ===');

  await test('createClient(sqlite) returns connected SQLiteClient', async () => {
    const db = await createClient('sqlite', { dbPath: ':memory:' });
    try {
      assertEqual(db.dialect, 'sqlite');
      const res = await db.query('SELECT 42 AS n');
      assertEqual(res.rows[0].n, 42);
    } finally { await db.end(); }
  });
}

// ── Run all sections ──────────────────────────────────────────────────────────
(async () => {
  console.log(`\ntest-sqlite-seam.js (Node ${process.versions.node})\n`);

  await runSection1();
  await runSection2();
  await runSection3();
  await runSection4();
  await runSection5();
  await runSection6();
  await runSection7();
  await runSection8();
  await runSection9();
  await runSection10();
  await runSection11();
  await runSection12();

  console.log(`\n─── Results ──────────────────────────────────────`);
  console.log(`PASS ${passed}  FAIL ${failed}`);
  if (failures.length > 0) {
    console.log('\nFailed tests:');
    for (const { label, err } of failures) {
      console.log(`  - ${label}: ${err.message}`);
    }
  }
  process.exit(failed > 0 ? 1 : 0);
})();
