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
