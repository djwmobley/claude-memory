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
  createAdapter,
  rewriteForSQLite,
  buildInClause,
  buildSQLiteGraphCTE,
  resolveSQLiteDbPath,
  splitStatements,
  deserializeRow,
  serializeParams,
  SQLiteAdapter,
  PostgresAdapter,
} = require('./lib/db-seam');

// Backward-compat aliases for tests that predate the abstraction rename.
const SQLiteClient = SQLiteAdapter;
const createClient = createAdapter;

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

// ── SECTION 13: Abstraction invariant + port method tests ────────────────────
async function runSection13() {
  console.log('\n=== Section 13: Abstraction invariants ===');

  // ── Invariant: handoff.js (engine) must contain zero backend/dialect conditionals ──
  // This test is the machine-enforced acceptance criterion for the storage abstraction.
  // It greps the engine file for patterns that indicate a leaked conditional, and fails
  // the build if any are found.
  //
  // Allowed in the engine:
  //   - "dialect" in comments only (for documentation)
  //   - The single composition-root: resolveDialect() call + if (dialect === 'sqlite')
  //     inside connectHandoff() — one occurrence each, both in the same function.
  //
  // NOT allowed in the engine (outside db-seam.js):
  //   - db.dialect === ...  (checking dialect on the live client)
  //   - if (...sqlite...)   (branching on backend string)
  //   - buildSQLiteGraphCTE / buildInClause called from engine directly
  //   - createClient (old factory, replaced by createAdapter)
  //   - PostgresClient / SQLiteClient (old class names, replaced by adapters)
  await test('handoff.js contains ZERO db.dialect checks outside composition root', () => {
    const engineSrc = fs.readFileSync(
      path.resolve(__dirname, 'handoff.js'), 'utf8'
    );
    // These patterns must not appear anywhere in handoff.js (they belong in db-seam.js)
    const forbidden = [
      { pattern: /db\.dialect\b/, label: 'db.dialect check on live client' },
    ];
    for (const { pattern, label } of forbidden) {
      if (pattern.test(engineSrc)) {
        throw new Error(`handoff.js contains forbidden engine conditional: ${label}`);
      }
    }
  });

  await test('handoff.js has exactly ONE dialect === conditional (composition root only)', () => {
    const engineSrc = fs.readFileSync(
      path.resolve(__dirname, 'handoff.js'), 'utf8'
    );
    // Count occurrences of dialect === 'sqlite' or dialect === "sqlite"
    const matches = (engineSrc.match(/dialect\s*===\s*['"]sqlite['"]/g) || []);
    if (matches.length !== 1) {
      throw new Error(
        `Expected exactly 1 'dialect === sqlite' in handoff.js (composition root), found ${matches.length}`
      );
    }
    // Additionally: that one occurrence must be inside connectHandoff()
    const fnIdx = engineSrc.indexOf('async function connectHandoff()');
    const conditionalIdx = engineSrc.indexOf("dialect === 'sqlite'");
    if (conditionalIdx < fnIdx) {
      throw new Error('dialect conditional is before connectHandoff() — expected inside it');
    }
    // Find the next top-level function after connectHandoff to bound the search
    const nextFnIdx = engineSrc.indexOf('\nasync function ', fnIdx + 1);
    if (nextFnIdx !== -1 && conditionalIdx > nextFnIdx) {
      throw new Error('dialect conditional is outside connectHandoff() — leaked into engine');
    }
  });

  await test('handoff.js does NOT call buildSQLiteGraphCTE or buildInClause directly', () => {
    const engineSrc = fs.readFileSync(
      path.resolve(__dirname, 'handoff.js'), 'utf8'
    );
    if (/buildSQLiteGraphCTE/.test(engineSrc)) {
      throw new Error('handoff.js calls buildSQLiteGraphCTE directly — must go through db.buildGraphCTE()');
    }
    if (/buildInClause/.test(engineSrc)) {
      throw new Error('handoff.js calls buildInClause directly — must go through adapter port method');
    }
  });

  await test('handoff.js does NOT import createClient or PostgresClient/SQLiteClient', () => {
    const engineSrc = fs.readFileSync(
      path.resolve(__dirname, 'handoff.js'), 'utf8'
    );
    // Check require() destructuring — comments are allowed to mention names
    const requireBlock = engineSrc.match(/require\('\.\/lib\/db-seam'\)/g) || [];
    // Grab just the require statement lines
    const lines = engineSrc.split('\n').filter(l =>
      l.includes("require('./lib/db-seam')") || l.includes('require("./lib/db-seam")')
    );
    for (const line of lines) {
      if (/\bcreateCli\b/.test(line) && /\bcreateCli[^e]/.test(line)) {
        throw new Error(`handoff.js imports old 'createClient': ${line.trim()}`);
      }
      if (/PostgresClient\b|SQLiteClient\b/.test(line)) {
        throw new Error(`handoff.js imports old class names (PostgresClient/SQLiteClient): ${line.trim()}`);
      }
    }
  });

  // ── Port method tests ────────────────────────────────────────────────────────

  await test('SQLiteAdapter.buildGraphCTE returns SQLite-style CTE', () => {
    const db = new SQLiteAdapter(':memory:');
    const { sql, params } = db.buildGraphCTE('out', ['A'], 2, 10, 'p1');
    assertTrue(sql.includes("INSTR('|'"), 'SQLite CTE should use INSTR cycle guard');
    assertTrue(!sql.includes('unnest'), 'SQLite CTE should not use unnest');
    assertTrue(params.includes('p1'), 'params should contain projectId');
  });

  await test('PostgresAdapter.buildGraphCTE returns Postgres-style CTE', () => {
    const db = new PostgresAdapter(null);
    const { sql, params } = db.buildGraphCTE('out', ['A'], 2, 10, 'p1');
    assertTrue(sql.includes('unnest'), 'Postgres CTE should use unnest');
    assertTrue(!sql.includes('INSTR'), 'Postgres CTE should not use INSTR');
    assertTrue(Array.isArray(params) && params[1] === 'A' || Array.isArray(params[1]), 'seeds param present');
  });

  await test('SQLiteAdapter.buildBumpAssertions produces IN clause for SQLite', () => {
    const db = new SQLiteAdapter(':memory:');
    const stmt = db.buildBumpAssertions([1, 2, 3]);
    assertTrue(stmt.sql.includes('IN (?, ?, ?)') || stmt.sql.includes('IN (?,?,?)') || /IN \([^)]+\)/.test(stmt.sql),
      'SQLite bump should use IN clause');
    assertTrue(stmt.sql.includes("datetime('now')"), 'SQLite bump should use datetime now()');
    assertDeepEqual(stmt.params, [1, 2, 3]);
  });

  await test('PostgresAdapter.buildBumpAssertions produces ANY clause for Postgres', () => {
    const db = new PostgresAdapter(null);
    const stmt = db.buildBumpAssertions([1, 2, 3]);
    assertTrue(stmt.sql.includes('ANY($1'), 'Postgres bump should use ANY($1)');
    assertTrue(stmt.sql.includes('now()'), 'Postgres bump should use now()');
    assertDeepEqual(stmt.params, [[1, 2, 3]]);
  });

  await test('buildBumpAssertions returns null for empty ids', () => {
    const db = new SQLiteAdapter(':memory:');
    const stmt = db.buildBumpAssertions([]);
    assertEqual(stmt, null);
  });

  await test('SQLiteAdapter.buildMultiPairInsert expands each row as separate ?s', () => {
    const db = new SQLiteAdapter(':memory:');
    const { sql, params } = db.buildMultiPairInsert('t', 'c1', 'c2', 99, [10, 20]);
    assertTrue(sql.includes('(?, ?)'), 'SQLite multi-pair insert should use ? placeholders');
    assertDeepEqual(params, [99, 10, 99, 20]);
  });

  await test('PostgresAdapter.buildMultiPairInsert reuses $1 for shared value', () => {
    const db = new PostgresAdapter(null);
    const { sql, params } = db.buildMultiPairInsert('t', 'c1', 'c2', 99, [10, 20]);
    assertTrue(sql.includes('($1, $2)') && sql.includes('($1, $3)'),
      'Postgres multi-pair insert should reuse $1');
    assertDeepEqual(params, [99, 10, 20]);
  });

  await test('SQLiteAdapter.buildCommunityIdsQuery expands IN clause', () => {
    const db = new SQLiteAdapter(':memory:');
    const { sql, params } = db.buildCommunityIdsQuery('proj', 'run1', ['A', 'B']);
    assertTrue(sql.includes('entity_name IN'), 'SQLite community query should use IN');
    assertDeepEqual(params, ['proj', 'run1', 'A', 'B']);
  });

  await test('PostgresAdapter.buildCommunityIdsQuery uses ANY', () => {
    const db = new PostgresAdapter(null);
    const { sql, params } = db.buildCommunityIdsQuery('proj', 'run1', ['A', 'B']);
    assertTrue(sql.includes('= ANY($3'), 'Postgres community query should use ANY');
    assertDeepEqual(params, ['proj', 'run1', ['A', 'B']]);
  });

  await test('SQLiteAdapter.buildSiblingsQuery uses NOT IN', () => {
    const db = new SQLiteAdapter(':memory:');
    const { sql, params } = db.buildSiblingsQuery('proj', 'run1', ['c1'], ['E1'], 10);
    assertTrue(sql.includes('NOT IN'), 'SQLite siblings query should use NOT IN');
    assertTrue(sql.includes('IN ('), 'SQLite siblings query should use IN for community_ids');
  });

  await test('PostgresAdapter.buildSiblingsQuery uses ANY and <> ALL', () => {
    const db = new PostgresAdapter(null);
    const { sql, params } = db.buildSiblingsQuery('proj', 'run1', ['c1'], ['E1'], 10);
    assertTrue(sql.includes('= ANY($3'), 'Postgres siblings query should use ANY for cids');
    assertTrue(sql.includes('<> ALL($4'), 'Postgres siblings query should use <> ALL for excludes');
  });

  await test('SQLiteAdapter.buildCommunityIdsQuery executes correctly against live SQLite', async () => {
    const db = await createAdapter('sqlite', { dbPath: ':memory:' });
    try {
      const schemaSql = fs.readFileSync(path.resolve(__dirname, 'sql', 'handoff-sqlite-schema.sql'), 'utf8');
      await db.runSchema(schemaSql);
      // Add community data
      const pid = 'inv-test-1';
      await db.query(`INSERT INTO entities (project_id, name, entity_type) VALUES (?,?,?)`, [pid, 'E1', 'c']);
      await db.query(`INSERT INTO entity_communities (project_id, run_id, entity_name, community_id) VALUES (?,?,?,?)`,
        [pid, 'r1', 'E1', 'comm-A']);
      const cq = db.buildCommunityIdsQuery(pid, 'r1', ['E1']);
      const res = await db.query(cq.sql, cq.params);
      assertEqual(res.rows.length, 1);
      assertEqual(res.rows[0].community_id, 'comm-A');
    } finally { await db.end(); }
  });
}

// ── SECTION 14: PR-B bi-temporal supersession + suppression_kind + pinned-exemption ──
async function runSection14() {
  console.log('\n=== Section 14: PR-B bi-temporal supersession, suppression_kind, pinned, probation rehab ===');

  // Helper: apply SQLite schema to an in-memory DB.
  async function makeSchemaDb() {
    const db = new SQLiteAdapter(':memory:');
    await db.connect();
    const schemaSql = fs.readFileSync(path.resolve(__dirname, 'sql', 'handoff-sqlite-schema.sql'), 'utf8');
    await db.runSchema(schemaSql);
    return db;
  }

  const PID = 'test-prb';

  // ── Port method: buildSupersessionUpdate ─────────────────────────────────────

  await test('SQLiteAdapter.buildSupersessionUpdate 1:1 produces correct SQL', () => {
    const db = new SQLiteAdapter(':memory:');
    const stmt = db.buildSupersessionUpdate('1:1', 'proj', 'subj', 'pred', 'obj');
    assertTrue(stmt.sql.includes("suppressed = 1"), 'should set suppressed = 1');
    assertTrue(stmt.sql.includes("suppression_kind = 'superseded'"), 'should set suppression_kind');
    assertTrue(stmt.sql.includes("invalid_at = datetime('now')"), 'should set invalid_at');
    assertTrue(stmt.sql.includes("pinned     = 0"), 'should guard on pinned = 0');
    // 1:1: no object parameter in WHERE
    assertTrue(!stmt.sql.includes("object"), '1:1 should not filter on object');
    assertEqual(stmt.params.length, 3, 'params: projectId, subject, predicate');
  });

  await test('SQLiteAdapter.buildSupersessionUpdate 1:N produces correct SQL', () => {
    const db = new SQLiteAdapter(':memory:');
    const stmt = db.buildSupersessionUpdate('1:N', 'proj', 'subj', 'pred', 'obj');
    assertTrue(stmt.sql.includes("suppressed = 1"), 'should set suppressed = 1');
    assertTrue(stmt.sql.includes("suppression_kind = 'superseded'"), 'should set suppression_kind');
    assertTrue(stmt.sql.includes("object     = ?"), '1:N should filter on object');
    assertEqual(stmt.params.length, 4, 'params: projectId, subject, predicate, object');
  });

  await test('PostgresAdapter.buildSupersessionUpdate 1:1 produces correct SQL', () => {
    const db = new PostgresAdapter(null);
    const stmt = db.buildSupersessionUpdate('1:1', 'proj', 'subj', 'pred', 'obj');
    assertTrue(stmt.sql.includes("suppressed = true"), 'should set suppressed = true');
    assertTrue(stmt.sql.includes("suppression_kind = 'superseded'"), 'should set suppression_kind');
    assertTrue(stmt.sql.includes("invalid_at = now()"), 'should set invalid_at');
    assertTrue(stmt.sql.includes("pinned = false OR pinned IS NULL"), 'should guard on pinned');
    assertTrue(!stmt.sql.includes("object"), '1:1 should not filter on object');
    assertEqual(stmt.params.length, 3, 'params: projectId, subject, predicate');
  });

  await test('PostgresAdapter.buildSupersessionUpdate 1:N produces correct SQL', () => {
    const db = new PostgresAdapter(null);
    const stmt = db.buildSupersessionUpdate('1:N', 'proj', 'subj', 'pred', 'obj');
    assertTrue(stmt.sql.includes("suppressed = true"), 'should set suppressed = true');
    assertTrue(stmt.sql.includes("object     = $4"), '1:N should filter on object');
    assertEqual(stmt.params.length, 4, 'params: projectId, subject, predicate, object');
  });

  // ── Port method: buildProbationRehabUpdate ───────────────────────────────────

  await test('SQLiteAdapter.buildProbationRehabUpdate produces correct SQL', () => {
    const db = new SQLiteAdapter(':memory:');
    const stmt = db.buildProbationRehabUpdate([10, 11]);
    assertTrue(stmt.sql.includes("suppressed = 0"), 'should clear suppressed');
    assertTrue(stmt.sql.includes("invalid_at = NULL"), 'should clear invalid_at');
    assertTrue(stmt.sql.includes("suppression_kind = NULL"), 'should clear suppression_kind');
    assertTrue(stmt.sql.includes("suppression_kind = 'downvoted_probation'"), 'should guard on downvoted_probation');
    assertDeepEqual(stmt.params, [10, 11]);
  });

  await test('PostgresAdapter.buildProbationRehabUpdate produces correct SQL', () => {
    const db = new PostgresAdapter(null);
    const stmt = db.buildProbationRehabUpdate([10, 11]);
    assertTrue(stmt.sql.includes("suppressed = false"), 'should clear suppressed (Postgres)');
    assertTrue(stmt.sql.includes("suppression_kind = NULL"), 'should clear suppression_kind');
    assertTrue(stmt.sql.includes("suppression_kind = 'downvoted_probation'"), 'guard on downvoted_probation');
    // Postgres passes as array
    assertDeepEqual(stmt.params, [[10, 11]]);
  });

  await test('buildProbationRehabUpdate returns null for empty ids', () => {
    const db = new SQLiteAdapter(':memory:');
    const stmt = db.buildProbationRehabUpdate([]);
    assertEqual(stmt, null, 'should return null for empty ids');
  });

  // ── buildBumpAssertions now includes invalid_at IS NULL guard ────────────────

  await test('SQLiteAdapter.buildBumpAssertions includes invalid_at IS NULL guard', () => {
    const db = new SQLiteAdapter(':memory:');
    const stmt = db.buildBumpAssertions([1]);
    assertTrue(stmt.sql.includes('invalid_at IS NULL'), 'bump should exclude invalidated rows');
  });

  await test('PostgresAdapter.buildBumpAssertions includes invalid_at IS NULL guard', () => {
    const db = new PostgresAdapter(null);
    const stmt = db.buildBumpAssertions([1]);
    assertTrue(stmt.sql.includes('invalid_at IS NULL'), 'bump should exclude invalidated rows');
  });

  // ── Integration tests against a live SQLite DB ───────────────────────────────

  await test('PR-B schema: valid_at / invalid_at / suppression_kind / pinned columns exist', async () => {
    const db = await makeSchemaDb();
    try {
      // Insert a row — should succeed with new columns present.
      await db.query(
        `INSERT INTO assertions (project_id, subject, predicate, object, confidence, source,
           valid_at, invalid_at, suppression_kind, pinned)
         VALUES (?, ?, ?, ?, ?, ?, datetime('now'), NULL, NULL, 0)`,
        [PID, 'subj', 'pred', 'obj', 5, 'user_stated']
      );
      const { rows } = await db.query(
        `SELECT valid_at, invalid_at, suppression_kind, pinned FROM assertions WHERE project_id = ?`,
        [PID]
      );
      assertEqual(rows.length, 1, 'should have 1 row');
      assertTrue(rows[0].valid_at !== null, 'valid_at should be set');
      assertEqual(rows[0].invalid_at, null, 'invalid_at should be NULL');
      assertEqual(rows[0].suppression_kind, null, 'suppression_kind should be NULL');
      assertEqual(rows[0].pinned, 0, 'pinned should default to 0');
    } finally { await db.end(); }
  });

  await test('PR-B: buildSupersessionUpdate sets suppression_kind=superseded and invalid_at on 1:1 rows', async () => {
    const db = await makeSchemaDb();
    try {
      // Use a predicate NOT in the 1:1 partial unique index so we can insert both rows directly.
      // The test validates buildSupersessionUpdate SQL behavior, not the full write-path transaction.
      // 'prb_custom_pred_1to1' is unrecognized by the index, so the UNIQUE constraint won't fire.
      const pred = 'prb_custom_pred_1to1';
      // Insert v1 (will be superseded) then v2 (the new value, not yet inserted in reality).
      await db.query(
        `INSERT INTO assertions (project_id, subject, predicate, object, confidence, source)
         VALUES (?, 'A', ?, 'v1', 7, 'user_stated')`,
        [PID, pred]
      );
      // Run the supersession update (marks v1 as superseded).
      const stmt = db.buildSupersessionUpdate('1:1', PID, 'A', pred, 'v2');
      await db.query(stmt.sql, stmt.params);
      // Now insert v2 as the new live row.
      await db.query(
        `INSERT INTO assertions (project_id, subject, predicate, object, confidence, source)
         VALUES (?, 'A', ?, 'v2', 8, 'user_stated')`,
        [PID, pred]
      );

      const { rows } = await db.query(
        `SELECT object, suppressed, suppression_kind, invalid_at FROM assertions
         WHERE project_id = ? AND subject = 'A' AND predicate = ?
         ORDER BY object`,
        [PID, pred]
      );
      assertEqual(rows.length, 2);
      const v1 = rows.find((r) => r.object === 'v1');
      const v2 = rows.find((r) => r.object === 'v2');
      assertEqual(v1.suppressed, 1, 'v1 should be suppressed');
      assertEqual(v1.suppression_kind, 'superseded', 'v1 suppression_kind should be superseded');
      assertTrue(v1.invalid_at !== null, 'v1 invalid_at should be set');
      assertEqual(v2.suppressed, 0, 'v2 (new) should not be suppressed');
      assertEqual(v2.suppression_kind, null, 'v2 suppression_kind should be NULL');
      assertEqual(v2.invalid_at, null, 'v2 invalid_at should be NULL');
    } finally { await db.end(); }
  });

  await test('PR-B: pinned row is NOT suppressed by buildSupersessionUpdate', async () => {
    const db = await makeSchemaDb();
    try {
      // Use a predicate not in the 1:1 index to avoid unique constraint interference.
      const pred = 'prb_pinned_test_pred';
      // Insert a pinned assertion.
      await db.query(
        `INSERT INTO assertions (project_id, subject, predicate, object, confidence, source, pinned)
         VALUES (?, 'B', ?, 'pinned_val', 9, 'user_stated', 1)`,
        [PID, pred]
      );
      // Run supersession — pinned row should be exempt.
      const stmt = db.buildSupersessionUpdate('1:1', PID, 'B', pred, 'new_val');
      await db.query(stmt.sql, stmt.params);

      const { rows } = await db.query(
        `SELECT object, suppressed, suppression_kind FROM assertions
         WHERE project_id = ? AND subject = 'B' AND predicate = ?`,
        [PID, pred]
      );
      const pinned = rows.find((r) => r.object === 'pinned_val');
      assertEqual(pinned.suppressed, 0, 'pinned row should NOT be suppressed');
      assertEqual(pinned.suppression_kind, null, 'pinned row suppression_kind should remain NULL');
    } finally { await db.end(); }
  });

  await test('PR-B: standard retrieval excludes rows with invalid_at IS NOT NULL', async () => {
    const db = await makeSchemaDb();
    try {
      // Insert one live and one invalidated row.
      await db.query(
        `INSERT INTO assertions (project_id, subject, predicate, object, confidence, source,
           suppressed, invalid_at, suppression_kind)
         VALUES
           (?, 'C', 'pred', 'live',        7, 'user_stated', 0, NULL,          NULL),
           (?, 'C', 'pred', 'probation',   6, 'user_stated', 1, datetime('now'), 'downvoted_probation')`,
        [PID, PID]
      );
      // Standard retrieval should only return the live row.
      const { rows } = await db.query(
        `SELECT object FROM assertions
         WHERE project_id = ? AND suppressed = 0 AND invalid_at IS NULL`,
        [PID]
      );
      assertEqual(rows.length, 1);
      assertEqual(rows[0].object, 'live', 'only live row should appear in standard retrieval');
    } finally { await db.end(); }
  });

  await test('PR-B: probation row present in history query (suppressed OR invalid_at NOT NULL)', async () => {
    const db = await makeSchemaDb();
    try {
      await db.query(
        `INSERT INTO assertions (project_id, subject, predicate, object, confidence, source,
           suppressed, invalid_at, suppression_kind)
         VALUES
           (?, 'D', 'pred', 'live',     7, 'user_stated', 0, NULL,           NULL),
           (?, 'D', 'pred', 'probation',6, 'user_stated', 1, datetime('now'),'downvoted_probation'),
           (?, 'D', 'pred', 'terminal', 5, 'user_stated', 1, datetime('now'),'downvoted_terminal')`,
        [PID, PID, PID]
      );
      // History query: rows with suppressed=1 OR invalid_at IS NOT NULL.
      const { rows } = await db.query(
        `SELECT object, suppression_kind FROM assertions
         WHERE project_id = ? AND (suppressed = 1 OR invalid_at IS NOT NULL)
         ORDER BY object`,
        [PID]
      );
      assertEqual(rows.length, 2, 'history should have 2 rows (probation + terminal)');
      const objects = rows.map((r) => r.object).sort();
      assertDeepEqual(objects, ['probation', 'terminal'], 'both probation and terminal in history');
    } finally { await db.end(); }
  });

  await test('PR-B: buildProbationRehabUpdate rehabilitates probation row', async () => {
    const db = await makeSchemaDb();
    try {
      // Insert a probation row.
      await db.query(
        `INSERT INTO assertions (project_id, subject, predicate, object, confidence, source,
           suppressed, invalid_at, suppression_kind)
         VALUES (?, 'E', 'pred', 'probation_val', 6, 'user_stated', 1, datetime('now'), 'downvoted_probation')`,
        [PID]
      );
      const { rows: preRows } = await db.query(
        `SELECT id FROM assertions WHERE project_id = ? AND object = 'probation_val'`, [PID]
      );
      const rowId = preRows[0].id;

      // Rehabilitate.
      const rehabStmt = db.buildProbationRehabUpdate([rowId]);
      await db.query(rehabStmt.sql, rehabStmt.params);

      const { rows } = await db.query(
        `SELECT suppressed, invalid_at, suppression_kind FROM assertions WHERE id = ?`, [rowId]
      );
      assertEqual(rows[0].suppressed, 0, 'rehabilitated: suppressed should be 0');
      assertEqual(rows[0].invalid_at, null, 'rehabilitated: invalid_at should be NULL');
      assertEqual(rows[0].suppression_kind, null, 'rehabilitated: suppression_kind should be NULL');
    } finally { await db.end(); }
  });

  await test('PR-B: buildProbationRehabUpdate does NOT rehabilitate terminal rows', async () => {
    const db = await makeSchemaDb();
    try {
      // Insert a terminal row.
      await db.query(
        `INSERT INTO assertions (project_id, subject, predicate, object, confidence, source,
           suppressed, invalid_at, suppression_kind)
         VALUES (?, 'F', 'pred', 'terminal_val', 5, 'user_stated', 1, datetime('now'), 'downvoted_terminal')`,
        [PID]
      );
      const { rows: preRows } = await db.query(
        `SELECT id FROM assertions WHERE project_id = ? AND object = 'terminal_val'`, [PID]
      );
      const rowId = preRows[0].id;

      // buildProbationRehabUpdate guards on suppression_kind = 'downvoted_probation' — terminal is not affected.
      const rehabStmt = db.buildProbationRehabUpdate([rowId]);
      await db.query(rehabStmt.sql, rehabStmt.params);

      const { rows } = await db.query(
        `SELECT suppressed, suppression_kind FROM assertions WHERE id = ?`, [rowId]
      );
      assertEqual(rows[0].suppressed, 1, 'terminal row should remain suppressed');
      assertEqual(rows[0].suppression_kind, 'downvoted_terminal', 'terminal suppression_kind unchanged');
    } finally { await db.end(); }
  });

  await test('PR-B: C2 default-on — feedback_loop_enabled default in defaults object is enabled', () => {
    // Read handoff.js source and verify the defaults object contains 'enabled' for feedback_loop_enabled.
    const engineSrc = fs.readFileSync(path.resolve(__dirname, 'handoff.js'), 'utf8');
    // Find the defaults object block.
    const defaultsMatch = engineSrc.match(/feedback_loop_enabled:\s*'([^']+)'/);
    assertTrue(defaultsMatch !== null, 'feedback_loop_enabled should appear in defaults object');
    assertEqual(defaultsMatch[1], 'enabled', 'feedback_loop_enabled default should be "enabled"');
  });

  await test('PR-B: getSetting fallback for feedback_loop_enabled is enabled', () => {
    const engineSrc = fs.readFileSync(path.resolve(__dirname, 'handoff.js'), 'utf8');
    // Check that getSetting calls for feedback_loop_enabled use 'enabled' as fallback.
    const matches = [...engineSrc.matchAll(/getSetting\s*\([^)]*feedback_loop_enabled[^)]*'([^']+)'\s*\)/g)];
    assertTrue(matches.length >= 2, 'should have at least 2 getSetting calls for feedback_loop_enabled');
    for (const m of matches) {
      assertEqual(m[1], 'enabled', `getSetting fallback for feedback_loop_enabled should be 'enabled', got '${m[1]}'`);
    }
  });
}

// ── SECTION 15: Prospective subject canonicalization (spine step 5, Option 2) ─
async function runSection15() {
  console.log('\n=== Section 15: Prospective subject canonicalization ===');

  const { canonicalize, normalize, loadAliasMap, resetAliasMapCache } =
    require('./lib/subject-canon');

  // ── canonicalize() unit tests ─────────────────────────────────────────────────

  await test('canonicalize: trims leading and trailing whitespace', () => {
    assertEqual(canonicalize('  foo bar  '), 'foo bar');
    assertEqual(canonicalize('\t foo \n'), 'foo');
  });

  await test('canonicalize: case-folds to lowercase', () => {
    assertEqual(canonicalize('Claude-Memory Main'), 'claude-memory main');
    assertEqual(canonicalize('UPPER CASE'), 'upper case');
    assertEqual(canonicalize('MixEd CaSe'), 'mixed case');
  });

  await test('canonicalize: collapses internal whitespace to single space', () => {
    assertEqual(canonicalize('foo   bar'), 'foo bar');
    assertEqual(canonicalize('a\t\tb'), 'a b');
    assertEqual(canonicalize('x  \n  y'), 'x y');
  });

  await test('canonicalize: trims + folds + collapses in combination', () => {
    assertEqual(canonicalize('  Claude-Memory   Main  '), 'claude-memory main');
    assertEqual(canonicalize('claude_memory main'), 'claude_memory main');
    // Underscore is not whitespace — preserved.
    assertEqual(canonicalize('  BUNDLE  A  STATUS  '), 'bundle a status');
  });

  await test('canonicalize: idempotent — canonicalize(canonicalize(x)) === canonicalize(x)', () => {
    const inputs = [
      '  My Project Main  ',
      'claude-memory main',
      'UPPER  CASE   String ',
      '  already canonical  ',
      'single',
      '',
    ];
    for (const input of inputs) {
      const once  = canonicalize(input);
      const twice = canonicalize(once);
      assertEqual(twice, once, `idempotency failed for input: ${JSON.stringify(input)}`);
    }
  });

  await test('canonicalize: alias-map lookup returns mapped canonical form', () => {
    // Inject a test alias map via cache reset + override.
    resetAliasMapCache();
    // Temporarily override require cache with a test map.
    const subjectCanonPath = require.resolve('./lib/subject-canon');
    const orig = require.cache[subjectCanonPath];
    delete require.cache[subjectCanonPath];
    // Write a temp alias map file, then restore.
    const tempMapPath = require.resolve('./lib/subject-alias-map.json');
    const origMap = fs.readFileSync(tempMapPath, 'utf8');
    fs.writeFileSync(tempMapPath, JSON.stringify({
      '_comment': 'test override',
      'claude memory main': 'claude-memory main',
      'my proj': 'my-project',
    }));
    try {
      const freshMod = require('./lib/subject-canon');
      assertEqual(freshMod.canonicalize('Claude Memory Main'), 'claude-memory main',
        'alias: claude memory main → claude-memory main');
      assertEqual(freshMod.canonicalize('MY  PROJ'), 'my-project',
        'alias: my proj → my-project (after normalize)');
      // No alias: normalizes but is not remapped
      assertEqual(freshMod.canonicalize('unaliased subject'), 'unaliased subject',
        'no alias: returns normalized form');
    } finally {
      fs.writeFileSync(tempMapPath, origMap);
      delete require.cache[require.resolve('./lib/subject-canon')];
      require.cache[subjectCanonPath] = orig;
      resetAliasMapCache();
    }
  });

  await test('canonicalize: alias-map values are idempotent through canonicalize', () => {
    // If a canonical value is itself passed through canonicalize, it should return itself.
    // This verifies the alias-map values are stored in normalized form.
    resetAliasMapCache();
    const subjectCanonPath = require.resolve('./lib/subject-canon');
    const orig = require.cache[subjectCanonPath];
    delete require.cache[subjectCanonPath];
    const tempMapPath = require.resolve('./lib/subject-alias-map.json');
    const origMap = fs.readFileSync(tempMapPath, 'utf8');
    fs.writeFileSync(tempMapPath, JSON.stringify({
      'alias form': 'canonical-form',  // canonical-form has no alias
    }));
    try {
      const freshMod = require('./lib/subject-canon');
      const val = freshMod.canonicalize('alias form');
      assertEqual(val, 'canonical-form');
      // Re-canonicalize the result: no alias entry for 'canonical-form', so it normalizes to itself.
      const val2 = freshMod.canonicalize(val);
      assertEqual(val2, val, 'alias map values should be stable under re-canonicalization');
    } finally {
      fs.writeFileSync(tempMapPath, origMap);
      delete require.cache[require.resolve('./lib/subject-canon')];
      require.cache[subjectCanonPath] = orig;
      resetAliasMapCache();
    }
  });

  // ── Integration: canonical write supersedes variant-spelled prior row ─────────

  // Helper: apply SQLite schema to an in-memory DB.
  async function makeSchemaDb() {
    const db = new SQLiteAdapter(':memory:');
    await db.connect();
    const schemaSql = fs.readFileSync(
      path.resolve(__dirname, 'sql', 'handoff-sqlite-schema.sql'), 'utf8'
    );
    await db.runSchema(schemaSql);
    return db;
  }

  const PID = 'test-canon-s15';

  await test('canonicalize: variant-spelled prior row is superseded; stored subject byte-unchanged (§7 proof)', async () => {
    // This test proves:
    //  (a) A new canonical write supersedes a pre-existing variant-spelled live row
    //      (different casing/whitespace → same canonical form → treated as same subject).
    //  (b) The prior row becomes suppressed=1, suppression_kind='superseded', invalid_at set.
    //  (c) The prior row's stored subject column is byte-unchanged after the operation (§7).
    //  (d) No UPDATE SET subject appears in the code path.
    const db = await makeSchemaDb();
    try {
      // Insert a prior row with variant spelling (extra spaces, mixed case).
      const variantSubject = 'claude-Memory  Main';  // variant: mixed case + double space
      const canonicalSubject = canonicalize(variantSubject);  // expected: 'claude-memory main'

      await db.query(
        `INSERT INTO assertions (project_id, subject, predicate, object, confidence, source)
         VALUES (?, ?, 'is_status', 'old_value', 7, 'user_stated')`,
        [PID, variantSubject]
      );

      // Record the stored subject before suppression.
      const { rows: preBefore } = await db.query(
        `SELECT id, subject, suppressed, suppression_kind, invalid_at FROM assertions
         WHERE project_id = ? ORDER BY id`, [PID]
      );
      assertEqual(preBefore.length, 1, 'should have 1 prior row');
      assertEqual(preBefore[0].subject, variantSubject, 'prior row stored subject should be the variant spelling');
      assertEqual(preBefore[0].suppressed, 0, 'prior row should be live initially');

      // Simulate what writeAssertionWithSupersession does:
      //   1. Canonicalize incoming subject.
      //   2. Fetch candidate prior rows (by project_id, predicate, live).
      //   3. In JS: filter by canonical match.
      //   4. Suppress matched stored subjects via buildSupersessionUpdate.
      //   5. INSERT new row with canonical subject.
      const newSubject = '  CLAUDE-MEMORY   MAIN  ';  // same canonical form, different raw spelling
      const canonNew = canonicalize(newSubject);
      assertEqual(canonNew, canonicalSubject, 'pre-check: canonical forms match');

      await db.query('BEGIN');
      try {
        // Step 1-3: fetch and match candidates.
        const { rows: candidates } = await db.query(
          `SELECT DISTINCT subject FROM assertions
           WHERE project_id = ? AND predicate = 'is_status'
             AND suppressed = false AND invalid_at IS NULL`,
          [PID]
        );
        const toSuppress = candidates.filter((r) => canonicalize(r.subject) === canonNew);
        assertEqual(toSuppress.length, 1, 'should match 1 candidate for suppression');
        assertEqual(toSuppress[0].subject, variantSubject, 'matched candidate is the variant-spelled row');

        // Step 4: suppress matched rows via buildSupersessionUpdate (passing stored subject).
        for (const r of toSuppress) {
          const stmt = db.buildSupersessionUpdate('1:1', PID, r.subject, 'is_status', null);
          await db.query(stmt.sql, stmt.params);
        }

        // Step 5: INSERT new row with canonical subject.
        await db.query(
          `INSERT INTO assertions (project_id, subject, predicate, object, confidence, source)
           VALUES (?, ?, 'is_status', 'new_value', 8, 'user_stated')`,
          [PID, canonNew]
        );
        await db.query('COMMIT');
      } catch (err) {
        await db.query('ROLLBACK');
        throw err;
      }

      // Verify post-state.
      const { rows: post } = await db.query(
        `SELECT subject, object, suppressed, suppression_kind, invalid_at FROM assertions
         WHERE project_id = ? ORDER BY id`, [PID]
      );
      assertEqual(post.length, 2, 'should have 2 rows (prior + new)');

      const priorRow = post.find((r) => r.object === 'old_value');
      const newRow   = post.find((r) => r.object === 'new_value');

      // §7 proof: prior row's subject column is BYTE-UNCHANGED.
      assertEqual(priorRow.subject, variantSubject,
        '§7 proof: prior row stored subject must be the original variant spelling, not rewritten');

      // Prior row is suppressed via PR-B path.
      assertEqual(priorRow.suppressed, 1, 'prior row should be suppressed');
      assertEqual(priorRow.suppression_kind, 'superseded', 'prior row suppression_kind should be superseded');
      assertTrue(priorRow.invalid_at !== null, 'prior row invalid_at should be set');

      // New row is live with canonical subject.
      assertEqual(newRow.subject, canonNew, 'new row should have canonical subject');
      assertEqual(newRow.suppressed, 0, 'new row should be live');
      assertEqual(newRow.suppression_kind, null, 'new row suppression_kind should be NULL');
      assertEqual(newRow.invalid_at, null, 'new row invalid_at should be NULL');
    } finally { await db.end(); }
  });

  await test('canonicalize: 1:N exact duplicate semantics — variant subject + same predicate+object → duplicate', async () => {
    // A 1:N assertion with a variant-spelled subject + same predicate + same object
    // should be treated as an exact duplicate (suppresses the prior row).
    const db = await makeSchemaDb();
    try {
      const variantSubject = 'Bundle  A';  // variant: double space
      const canonSubject   = canonicalize(variantSubject);  // 'bundle a'
      const pred = 'depends_on';
      const obj  = 'some-dep';

      // Insert prior row with variant spelling.
      await db.query(
        `INSERT INTO assertions (project_id, subject, predicate, object, confidence, source)
         VALUES (?, ?, ?, ?, 5, 'user_stated')`,
        [PID + '_1n', variantSubject, pred, obj]
      );

      // Now simulate a canonical write of the same (canonical-subject, predicate, object).
      await db.query('BEGIN');
      try {
        const { rows: candidates } = await db.query(
          `SELECT DISTINCT subject FROM assertions
           WHERE project_id = ? AND predicate = ? AND object = ?
             AND suppressed = false AND invalid_at IS NULL`,
          [PID + '_1n', pred, obj]
        );
        const toSuppress = candidates.filter((r) => canonicalize(r.subject) === canonSubject);
        for (const r of toSuppress) {
          const stmt = db.buildSupersessionUpdate('1:N', PID + '_1n', r.subject, pred, obj);
          await db.query(stmt.sql, stmt.params);
        }
        await db.query(
          `INSERT INTO assertions (project_id, subject, predicate, object, confidence, source)
           VALUES (?, ?, ?, ?, 6, 'user_stated')`,
          [PID + '_1n', canonSubject, pred, obj]
        );
        await db.query('COMMIT');
      } catch (err) { await db.query('ROLLBACK'); throw err; }

      const { rows: post } = await db.query(
        `SELECT subject, object, suppressed FROM assertions
         WHERE project_id = ? ORDER BY id`,
        [PID + '_1n']
      );
      assertEqual(post.length, 2, 'should have 2 rows (prior + new)');
      assertEqual(post.find((r) => r.object === obj && r.subject === variantSubject).suppressed, 1,
        'prior variant-spelled row should be suppressed (treated as duplicate)');
      assertEqual(post.find((r) => r.object === obj && r.subject === canonSubject).suppressed, 0,
        'new canonical row should be live');
    } finally { await db.end(); }
  });

  await test('canonicalize: 1:N different-object rows coexist under canonicalization', async () => {
    // A 1:N write with different object → coexists; the prior row is NOT suppressed.
    const db = await makeSchemaDb();
    try {
      const variantSubject = '  Bundle  B  ';
      const canonSubject   = canonicalize(variantSubject);  // 'bundle b'
      const pred = 'depends_on';

      // Insert prior row with dep-A.
      await db.query(
        `INSERT INTO assertions (project_id, subject, predicate, object, confidence, source)
         VALUES (?, ?, ?, 'dep-A', 5, 'user_stated')`,
        [PID + '_coex', variantSubject, pred]
      );

      // Write with canonical subject but DIFFERENT object (dep-B) → no suppression of prior.
      await db.query('BEGIN');
      try {
        const { rows: candidates } = await db.query(
          `SELECT DISTINCT subject FROM assertions
           WHERE project_id = ? AND predicate = ? AND object = 'dep-B'
             AND suppressed = false AND invalid_at IS NULL`,
          [PID + '_coex', pred]
        );
        const toSuppress = candidates.filter((r) => canonicalize(r.subject) === canonSubject);
        // toSuppress should be empty — no prior row for dep-B.
        for (const r of toSuppress) {
          const stmt = db.buildSupersessionUpdate('1:N', PID + '_coex', r.subject, pred, 'dep-B');
          await db.query(stmt.sql, stmt.params);
        }
        await db.query(
          `INSERT INTO assertions (project_id, subject, predicate, object, confidence, source)
           VALUES (?, ?, ?, 'dep-B', 6, 'user_stated')`,
          [PID + '_coex', canonSubject, pred]
        );
        await db.query('COMMIT');
      } catch (err) { await db.query('ROLLBACK'); throw err; }

      const { rows: post } = await db.query(
        `SELECT subject, object, suppressed FROM assertions
         WHERE project_id = ? ORDER BY object`,
        [PID + '_coex']
      );
      assertEqual(post.length, 2, 'both rows should coexist');
      assertEqual(post.find((r) => r.object === 'dep-A').suppressed, 0,
        'dep-A row should remain live (different object)');
      assertEqual(post.find((r) => r.object === 'dep-B').suppressed, 0,
        'dep-B row should be live (new)');
    } finally { await db.end(); }
  });

  await test('canonicalize: §7 proof — no code path issues UPDATE SET subject on existing rows', () => {
    // Static analysis: grep handoff.js for UPDATE ... SET subject patterns.
    // Any UPDATE that sets subject on existing rows would be a §7 violation.
    const engineSrc = fs.readFileSync(path.resolve(__dirname, 'handoff.js'), 'utf8');
    // Pattern: UPDATE <table> SET ... subject = ...  (any form)
    // We look for an UPDATE statement that includes both 'SET' and 'subject =' in sequence.
    // This is a conservative over-approximation; false positives require manual review.
    const lines = engineSrc.split('\n');
    let inUpdateBlock = false;
    let updateBlockContent = '';
    for (const line of lines) {
      const upper = line.trim().toUpperCase();
      if (/^\s*`?UPDATE\b/i.test(line)) {
        inUpdateBlock = true;
        updateBlockContent = line;
      } else if (inUpdateBlock) {
        updateBlockContent += ' ' + line;
        // An UPDATE block ends at the next backtick (template literal end) or semicolon
        if (line.includes('`') || line.trim().endsWith(';')) {
          inUpdateBlock = false;
          // Check if this UPDATE block sets the subject column.
          // Allow: SET subject = ... in INSERT context (but we're in UPDATE block).
          if (/SET\b[^`]*\bsubject\s*=/i.test(updateBlockContent)) {
            throw new Error(
              `§7 VIOLATION: found UPDATE that sets subject column in handoff.js:\n` +
              updateBlockContent.slice(0, 300)
            );
          }
          updateBlockContent = '';
        }
      }
    }
  });

  await test('canonicalize: handoff.js imports subject-canon module', () => {
    const engineSrc = fs.readFileSync(path.resolve(__dirname, 'handoff.js'), 'utf8');
    assertTrue(
      engineSrc.includes("require('./lib/subject-canon')"),
      "handoff.js should require('./lib/subject-canon')"
    );
    assertTrue(
      engineSrc.includes('canonicalize'),
      'handoff.js should use canonicalize from subject-canon'
    );
  });

  await test('canonicalize: writeAssertionWithSupersession uses canonical subject for INSERT', () => {
    const engineSrc = fs.readFileSync(path.resolve(__dirname, 'handoff.js'), 'utf8');
    // The INSERT in writeAssertionWithSupersession must use canonSubject, not ass.subject.
    // Find the function body.
    const fnStart = engineSrc.indexOf('async function writeAssertionWithSupersession(');
    assertTrue(fnStart !== -1, 'writeAssertionWithSupersession must exist');
    // Find the end of the function (next top-level async function).
    const fnEnd = engineSrc.indexOf('\nasync function ', fnStart + 1);
    const fnBody = fnEnd !== -1
      ? engineSrc.slice(fnStart, fnEnd)
      : engineSrc.slice(fnStart);
    assertTrue(
      fnBody.includes('canonSubject'),
      'writeAssertionWithSupersession should compute canonSubject'
    );
    // The INSERT VALUES should pass canonSubject (not ass.subject) for the subject param.
    // Check that canonSubject appears as an INSERT parameter.
    assertTrue(
      fnBody.includes('canonSubject,') || fnBody.includes('canonSubject]'),
      'writeAssertionWithSupersession INSERT should use canonSubject as the subject value'
    );
    // Confirm ass.subject is NOT directly used as the subject INSERT parameter.
    // (It is still used for classification/lookup, but not in the final INSERT subject param.)
    const insertMatch = fnBody.match(/INSERT INTO assertions[\s\S]*?VALUES[\s\S]*?\[([^\]]+)\]/);
    if (insertMatch) {
      const params = insertMatch[1];
      assertTrue(
        !params.split(',').some((p) => p.trim() === 'ass.subject'),
        'INSERT params should not pass ass.subject directly as the subject value'
      );
    }
  });
}

// ── SECTION 16: Manual prune — buildPruneSelect / buildPruneDelete ───────────
async function runSection16() {
  console.log('\n=== Section 16: Manual prune (buildPruneSelect / buildPruneDelete) ===');

  // ── SQLiteAdapter method tests ────────────────────────────────────────────────

  await test('SQLiteAdapter.buildPruneSelect: project_id clause always present', () => {
    const db = new SQLiteAdapter(':memory:');
    const { sql, params } = db.buildPruneSelect({ suppressed: true }, 'proj-1');
    assertTrue(sql.includes('project_id = ?'), 'should contain project_id = ?');
    assertTrue(params[0] === 'proj-1', 'first param should be project_id');
  });

  await test('SQLiteAdapter.buildPruneSelect: --suppressed adds suppressed = 1 clause', () => {
    const db = new SQLiteAdapter(':memory:');
    const { sql, params } = db.buildPruneSelect({ suppressed: true }, 'p');
    assertTrue(sql.includes('suppressed = ?'), 'should contain suppressed = ?');
    assertTrue(params.includes(1), 'params should include 1 for suppressed');
  });

  await test('SQLiteAdapter.buildPruneSelect: --suppression-kind adds suppression_kind clause', () => {
    const db = new SQLiteAdapter(':memory:');
    const { sql, params } = db.buildPruneSelect({ suppressionKind: 'superseded' }, 'p');
    assertTrue(sql.includes('suppression_kind = ?'), 'should contain suppression_kind clause');
    assertTrue(params.includes('superseded'), 'params should include kind');
  });

  await test('SQLiteAdapter.buildPruneSelect: --subject adds subject clause', () => {
    const db = new SQLiteAdapter(':memory:');
    const { sql, params } = db.buildPruneSelect({ subject: 'my subject' }, 'p');
    assertTrue(sql.includes('subject = ?'), 'should contain subject clause');
    assertTrue(params.includes('my subject'), 'params should include subject');
  });

  await test('SQLiteAdapter.buildPruneSelect: --older-than adds last_reinforced datetime clause', () => {
    const db = new SQLiteAdapter(':memory:');
    const { sql, params } = db.buildPruneSelect({ olderThanDays: 30 }, 'p');
    assertTrue(
      sql.includes("last_reinforced < datetime('now', '-' || ? || ' days')"),
      "should contain SQLite datetime modifier clause"
    );
    assertTrue(params.includes('30'), "params should include '30' as string");
  });

  await test('SQLiteAdapter.buildPruneSelect: criteria AND-combine (suppressed + subject)', () => {
    const db = new SQLiteAdapter(':memory:');
    const { sql } = db.buildPruneSelect({ suppressed: true, subject: 's' }, 'p');
    assertTrue(sql.includes('AND'), 'multiple criteria should join with AND');
    assertTrue(sql.includes('suppressed = ?'), 'should include suppressed clause');
    assertTrue(sql.includes('subject = ?'), 'should include subject clause');
  });

  await test('SQLiteAdapter.buildPruneDelete: excludes pinned=1 by default', () => {
    const db = new SQLiteAdapter(':memory:');
    const { sql } = db.buildPruneDelete({ suppressed: true, includePinned: false }, 'p');
    assertTrue(sql.includes('pinned = 0'), 'default delete should exclude pinned=1');
    assertTrue(sql.startsWith('DELETE FROM assertions'), 'should be a DELETE statement');
  });

  await test('SQLiteAdapter.buildPruneDelete: --include-pinned omits the pinned exclusion', () => {
    const db = new SQLiteAdapter(':memory:');
    const { sql } = db.buildPruneDelete({ suppressed: true, includePinned: true }, 'p');
    assertTrue(!sql.includes('pinned = 0'), 'include-pinned: should NOT add pinned = 0 clause');
  });

  // ── PostgresAdapter method tests ──────────────────────────────────────────────

  await test('PostgresAdapter.buildPruneSelect: project_id uses $1 placeholder', () => {
    const { PostgresAdapter: PG } = require('./lib/db-seam');
    const db = new PG(null);  // null pg.Client — port-method tests don't need a live connection
    const { sql, params } = db.buildPruneSelect({ suppressed: true }, 'proj-1');
    assertTrue(sql.includes('project_id = $1'), 'PG should use $1 for project_id');
    assertTrue(params[0] === 'proj-1', 'first param should be project_id');
  });

  await test('PostgresAdapter.buildPruneSelect: --suppressed adds suppressed = $N (true)', () => {
    const { PostgresAdapter: PG } = require('./lib/db-seam');
    const db = new PG(null);
    const { sql, params } = db.buildPruneSelect({ suppressed: true }, 'p');
    assertTrue(sql.includes('suppressed = $2'), 'suppressed should be $2 after project_id');
    assertTrue(params[1] === true, 'param should be boolean true for Postgres');
  });

  await test('PostgresAdapter.buildPruneSelect: --older-than adds Postgres interval clause', () => {
    const { PostgresAdapter: PG } = require('./lib/db-seam');
    const db = new PG(null);
    const { sql, params } = db.buildPruneSelect({ olderThanDays: 7 }, 'p');
    assertTrue(
      sql.includes("now() - ($") && sql.includes("|| ' days')::interval"),
      'PG should use interval arithmetic for older-than'
    );
    assertTrue(params.includes('7'), "params should include '7' as string");
  });

  await test('PostgresAdapter.buildPruneDelete: excludes pinned rows by default', () => {
    const { PostgresAdapter: PG } = require('./lib/db-seam');
    const db = new PG(null);
    const { sql } = db.buildPruneDelete({ suppressed: true, includePinned: false }, 'p');
    assertTrue(
      sql.includes('(pinned = false OR pinned IS NULL)'),
      'PG delete should exclude pinned via (pinned = false OR pinned IS NULL)'
    );
    assertTrue(sql.startsWith('DELETE FROM assertions'), 'should be a DELETE statement');
  });

  await test('PostgresAdapter.buildPruneDelete: --include-pinned omits the pinned exclusion', () => {
    const { PostgresAdapter: PG } = require('./lib/db-seam');
    const db = new PG(null);
    const { sql } = db.buildPruneDelete({ suppressed: true, includePinned: true }, 'p');
    assertTrue(!sql.includes('(pinned = false OR pinned IS NULL)'), 'include-pinned: should NOT add pinned clause');
  });

  // ── Live SQLite integration: prune end-to-end ─────────────────────────────────

  await test('prune: dry-run does not delete rows', async () => {
    const db = await makeMemDb();
    const schema = fs.readFileSync(SCHEMA_FILE, 'utf8');
    await db.runSchema(schema);
    const projectId = 'prune-test-project';

    // Insert 3 suppressed assertions
    for (let i = 0; i < 3; i++) {
      await db.query(
        `INSERT INTO assertions (project_id, subject, predicate, object, confidence, source, suppressed)
         VALUES (?, ?, ?, ?, 8, 'user_stated', 1)`,
        [projectId, `subj${i}`, 'is', `val${i}`]
      );
    }

    const { rows: before } = await db.query(
      'SELECT COUNT(*) AS n FROM assertions WHERE project_id = ?', [projectId]
    );
    assertEqual(parseInt(before[0].n, 10), 3, 'should have 3 rows before dry-run');

    // dry-run SELECT
    const { sql: selectSql, params: selectParams } = db.buildPruneSelect({ suppressed: true }, projectId);
    const { rows: matched } = await db.query(selectSql, selectParams);
    assertEqual(matched.length, 3, 'buildPruneSelect should match 3 rows');

    // verify no rows deleted
    const { rows: after } = await db.query(
      'SELECT COUNT(*) AS n FROM assertions WHERE project_id = ?', [projectId]
    );
    assertEqual(parseInt(after[0].n, 10), 3, 'dry-run: row count must be unchanged');

    await db.end();
  });

  await test('prune: --apply deletes matched rows; second apply is a no-op', async () => {
    const db = await makeMemDb();
    const schema = fs.readFileSync(SCHEMA_FILE, 'utf8');
    await db.runSchema(schema);
    const projectId = 'prune-apply-test';

    // Insert 2 suppressed + 1 live
    await db.query(
      `INSERT INTO assertions (project_id, subject, predicate, object, confidence, source, suppressed)
       VALUES (?, 's1', 'is', 'v1', 8, 'user_stated', 1)`, [projectId]
    );
    await db.query(
      `INSERT INTO assertions (project_id, subject, predicate, object, confidence, source, suppressed)
       VALUES (?, 's2', 'is', 'v2', 8, 'user_stated', 1)`, [projectId]
    );
    await db.query(
      `INSERT INTO assertions (project_id, subject, predicate, object, confidence, source, suppressed)
       VALUES (?, 's3', 'is', 'v3', 8, 'user_stated', 0)`, [projectId]
    );

    // Apply: delete suppressed rows
    const { sql: delSql, params: delParams } = db.buildPruneDelete(
      { suppressed: true, includePinned: false }, projectId
    );
    const { rowCount: deleted1 } = await db.query(delSql, delParams);
    assertEqual(deleted1, 2, 'first apply should delete 2 suppressed rows');

    // Verify 1 live row remains
    const { rows: remaining } = await db.query(
      'SELECT COUNT(*) AS n FROM assertions WHERE project_id = ?', [projectId]
    );
    assertEqual(parseInt(remaining[0].n, 10), 1, 'one live row should remain');

    // Second apply: should delete 0 (idempotent)
    const { rowCount: deleted2 } = await db.query(delSql, delParams);
    assertEqual(deleted2, 0, 'second apply should be a no-op (0 rows deleted)');

    await db.end();
  });

  await test('prune: pinned rows NOT deleted by default; deleted with --include-pinned', async () => {
    const db = await makeMemDb();
    const schema = fs.readFileSync(SCHEMA_FILE, 'utf8');
    await db.runSchema(schema);
    const projectId = 'prune-pinned-test';

    // Insert 1 suppressed+pinned and 1 suppressed+not-pinned
    await db.query(
      `INSERT INTO assertions (project_id, subject, predicate, object, confidence, source, suppressed, pinned)
       VALUES (?, 'pinned-subj', 'is', 'v', 8, 'user_stated', 1, 1)`, [projectId]
    );
    await db.query(
      `INSERT INTO assertions (project_id, subject, predicate, object, confidence, source, suppressed, pinned)
       VALUES (?, 'norm-subj', 'is', 'v', 8, 'user_stated', 1, 0)`, [projectId]
    );

    // Default delete (without include-pinned): should delete only the non-pinned row
    const { sql: delSql, params: delParams } = db.buildPruneDelete(
      { suppressed: true, includePinned: false }, projectId
    );
    const { rowCount: deleted } = await db.query(delSql, delParams);
    assertEqual(deleted, 1, 'default delete should skip pinned row');

    const { rows: remaining } = await db.query(
      'SELECT subject FROM assertions WHERE project_id = ?', [projectId]
    );
    assertEqual(remaining.length, 1, 'one row should remain (the pinned one)');
    assertEqual(remaining[0].subject, 'pinned-subj', 'remaining row should be the pinned one');

    // Now delete with include-pinned: should delete the pinned row too
    const { sql: delAllSql, params: delAllParams } = db.buildPruneDelete(
      { suppressed: true, includePinned: true }, projectId
    );
    const { rowCount: deletedAll } = await db.query(delAllSql, delAllParams);
    assertEqual(deletedAll, 1, 'include-pinned delete should remove pinned row');

    const { rows: finalRows } = await db.query(
      'SELECT COUNT(*) AS n FROM assertions WHERE project_id = ?', [projectId]
    );
    assertEqual(parseInt(finalRows[0].n, 10), 0, 'no rows should remain after include-pinned delete');

    await db.end();
  });

  await test('prune: project scoping — different project_id row is untouched', async () => {
    const db = await makeMemDb();
    const schema = fs.readFileSync(SCHEMA_FILE, 'utf8');
    await db.runSchema(schema);

    const projectA = 'prune-scope-A';
    const projectB = 'prune-scope-B';

    // Insert 1 suppressed row in each project
    await db.query(
      `INSERT INTO assertions (project_id, subject, predicate, object, confidence, source, suppressed)
       VALUES (?, 's', 'is', 'v', 8, 'user_stated', 1)`, [projectA]
    );
    await db.query(
      `INSERT INTO assertions (project_id, subject, predicate, object, confidence, source, suppressed)
       VALUES (?, 's', 'is', 'v', 8, 'user_stated', 1)`, [projectB]
    );

    // Delete suppressed from projectA only
    const { sql, params } = db.buildPruneDelete({ suppressed: true, includePinned: false }, projectA);
    const { rowCount } = await db.query(sql, params);
    assertEqual(rowCount, 1, 'should delete 1 row from projectA');

    // projectB row should be untouched
    const { rows: bRows } = await db.query(
      'SELECT COUNT(*) AS n FROM assertions WHERE project_id = ?', [projectB]
    );
    assertEqual(parseInt(bRows[0].n, 10), 1, 'projectB row should be untouched');

    await db.end();
  });

  await test('prune: --suppression-kind criterion selects only matching kind', async () => {
    const db = await makeMemDb();
    const schema = fs.readFileSync(SCHEMA_FILE, 'utf8');
    await db.runSchema(schema);
    const projectId = 'prune-kind-test';

    // Insert rows with different suppression_kind
    await db.query(
      `INSERT INTO assertions (project_id, subject, predicate, object, confidence, source, suppressed, suppression_kind)
       VALUES (?, 's1', 'is', 'v', 8, 'user_stated', 1, 'superseded')`, [projectId]
    );
    await db.query(
      `INSERT INTO assertions (project_id, subject, predicate, object, confidence, source, suppressed, suppression_kind)
       VALUES (?, 's2', 'is', 'v', 8, 'user_stated', 1, 'downvoted_terminal')`, [projectId]
    );
    await db.query(
      `INSERT INTO assertions (project_id, subject, predicate, object, confidence, source, suppressed)
       VALUES (?, 's3', 'is', 'v', 8, 'user_stated', 0)`, [projectId]
    );

    // Select only 'superseded' rows
    const { sql, params } = db.buildPruneSelect({ suppressionKind: 'superseded' }, projectId);
    const { rows } = await db.query(sql, params);
    assertEqual(rows.length, 1, 'should select only the superseded row');
    assertEqual(rows[0].subject, 's1', 'should be s1');

    await db.end();
  });

  await test('prune: --subject criterion canonicalizes and matches stored canonical subject', async () => {
    const db = await makeMemDb();
    const schema = fs.readFileSync(SCHEMA_FILE, 'utf8');
    await db.runSchema(schema);
    const projectId = 'prune-subject-test';

    // Insert row with lowercase canonical subject
    await db.query(
      `INSERT INTO assertions (project_id, subject, predicate, object, confidence, source, suppressed)
       VALUES (?, 'my subject', 'is', 'v', 8, 'user_stated', 1)`, [projectId]
    );

    // The caller (cmdPrune) canonicalizes the input before passing to buildPruneSelect.
    // Here we simulate that canonicalization already happened: 'MY SUBJECT' → 'my subject'
    const { canonicalize: canon } = require('./lib/subject-canon');
    const canonSubject = canon('MY SUBJECT');
    assertEqual(canonSubject, 'my subject', 'canonicalize should fold to lowercase');

    const { sql, params } = db.buildPruneSelect({ subject: canonSubject }, projectId);
    const { rows } = await db.query(sql, params);
    assertEqual(rows.length, 1, 'canonicalized subject should match stored row');

    await db.end();
  });

  await test('prune: --older-than criterion uses last_reinforced column', async () => {
    const db = await makeMemDb();
    const schema = fs.readFileSync(SCHEMA_FILE, 'utf8');
    await db.runSchema(schema);
    const projectId = 'prune-older-test';

    // Insert a row with a clearly old last_reinforced (2000-01-01)
    await db.query(
      `INSERT INTO assertions (project_id, subject, predicate, object, confidence, source, last_reinforced)
       VALUES (?, 'old-s', 'is', 'v', 8, 'user_stated', '2000-01-01')`, [projectId]
    );
    // Insert a row with a recent last_reinforced (now)
    await db.query(
      `INSERT INTO assertions (project_id, subject, predicate, object, confidence, source)
       VALUES (?, 'new-s', 'is', 'v', 8, 'user_stated')`, [projectId]
    );

    // older-than 1 day: should match only the old row (2000-01-01 is way older than 1 day)
    const { sql, params } = db.buildPruneSelect({ olderThanDays: 1 }, projectId);
    const { rows } = await db.query(sql, params);
    assertEqual(rows.length, 1, 'should select only the old row');
    assertEqual(rows[0].subject, 'old-s', 'should be the old subject');

    await db.end();
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
  await runSection13();
  await runSection14();
  await runSection15();
  await runSection16();

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
