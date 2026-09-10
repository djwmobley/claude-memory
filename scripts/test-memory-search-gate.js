'use strict';

/**
 * test-memory-search-gate.js — regression coverage for the memory-search.js
 * per-table availability gate (S1-S5 of the 2026-09-09 adversary-amended
 * spec: "memory_search claims present->queried, absent->skipped, never
 * fatal, but the existence probe was table-level only").
 *
 * Two layers:
 *   (A) Static — no DB. Every TABLE_DESCRIPTORS entry's declared
 *       `requiredColumns` must be a SUPERSET of every identifier its own
 *       idExpr/labelExpr/snippetExpr/whereExtra actually references (drift
 *       test — finding #7). Runs unconditionally.
 *   (B) Mocked-client unit tests — no DB. Exercises the S3/S4/S5 branches
 *       (tables: [], column_missing, query_error incl. extension_absent,
 *       connection-class escalation, identical-SQLSTATE-recurrence
 *       escalation, allSkipped) against a fake client object, so these are
 *       deterministic and fast regardless of local Postgres availability.
 *   (C) Live-Postgres integration — SKIPPED (with a clear console note,
 *       exit code unaffected) if no local Postgres is reachable. Recreates
 *       the ACTUAL bug this PR fixes against a real connection: a
 *       `handoff-core-schema.sql` DB with pgvector NOT installed leaves
 *       `assertions` present with its `embedding` column absent (the
 *       schema file's own pgvector-gated ALTER TABLE, guarded to skip
 *       silently) — exactly cm#224/#225's degraded-schema shape. Also
 *       covers the "ok" path with pgvector installed for contrast.
 *
 * The exhaustive real-SQL smoke across all 15 tables (S6-ii) lives in
 * scripts/migrations/verify-20-mcp-surface.js (check 9 extended by this
 * same PR) — that script requires a fully-migrated target DB (all seam
 * tables + migrate-13/14/15), which this lightweight test does not set up.
 *
 * Usage: node scripts/test-memory-search-gate.js
 * Exit codes: 0 = all ran checks passed, 1 = any failure.
 */

const memorySearchLib = require('./lib/memory-search.js');
const { TABLE_DESCRIPTORS, ALLOWED_TABLES, MemorySearchError, probeTableAvailability, memorySearch } = memorySearchLib;

let failures = 0;
let passed = 0;

function check(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { passed++; console.log(`[PASS] ${name}`); })
    .catch((err) => { failures++; console.error(`[FAIL] ${name}\n       ${err && err.stack ? err.stack : err}`); });
}

function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }
function assertEq(actual, expected, msg) {
  if (actual !== expected) throw new Error(`${msg || 'mismatch'} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
}

// ── (A) Static drift test (finding #7) ──────────────────────────────────

// Deliberately dumb/conservative identifier extraction — this is a TEST-ONLY
// parse of the expression strings; runtime code never re-derives columns
// this way (the declared requiredColumns list is authoritative at runtime).
// Pulls bare identifiers and strips SQL keywords/function names/literals.
const SQL_KEYWORDS = new Set([
  'coalesce', 'substring', 'true', 'false', 'null', 'and', 'or', 'not',
  'is', 'as', 'select', 'from', 'where',
]);
function extractIdentifiers(expr) {
  const idents = new Set();
  // Strip single-quoted SQL string literals FIRST — e.g. coalesce(chunk_kind,
  // 'chunk') must not extract "chunk" as a column reference just because it
  // appears inside a literal.
  const withoutLiterals = expr.replace(/'(?:[^']|'')*'/g, ' ');
  const re = /[A-Za-z_][A-Za-z0-9_]*/g;
  let m;
  while ((m = re.exec(withoutLiterals))) {
    const word = m[0].toLowerCase();
    if (SQL_KEYWORDS.has(word)) continue;
    // Skip a bare numeric-looking trailing token (e.g. "300" in substring(...,1,300))
    // — extractIdentifiers's regex only ever matches identifier-shaped tokens
    // to begin with, so no numeric filtering is actually needed; kept as a
    // no-op guard for clarity.
    idents.add(word);
  }
  return idents;
}

async function runStaticDriftTest() {
  for (const [table, d] of Object.entries(TABLE_DESCRIPTORS)) {
    const referenced = new Set();
    for (const expr of [d.idExpr, d.labelExpr, d.snippetExpr, d.whereExtra || '']) {
      for (const ident of extractIdentifiers(expr)) referenced.add(ident);
    }
    const declared = new Set(d.requiredColumns.map((c) => c.toLowerCase()));
    const undeclared = [...referenced].filter((r) => !declared.has(r));
    assert(undeclared.length === 0, `${table}: expression(s) reference undeclared column(s) [${undeclared.join(', ')}] — add to requiredColumns`);
    // Every table's SELECT also unconditionally references project_id and
    // embedding (WHERE clause / score expression) regardless of what the
    // per-table expression strings mention.
    assert(declared.has('project_id'), `${table}: requiredColumns missing project_id`);
    assert(declared.has('embedding'), `${table}: requiredColumns missing embedding`);
    if (d.hasFts) assert(declared.has('fts_vec'), `${table}: hasFts but requiredColumns missing fts_vec`);
  }
}

// ── (B) Mocked-client unit tests ────────────────────────────────────────

function makeMockClient({ missingTables = [], missingColumns = [], shapes = {}, queryImpl } = {}) {
  return {
    async schemaObjectsExist({ tables, columns }) {
      const missing = [];
      for (const t of tables) if (missingTables.includes(t)) missing.push({ type: 'table', table: t });
      for (const c of columns) {
        if (missingTables.includes(c.table)) continue; // already reported as table-missing
        if (missingColumns.some((mc) => mc.table === c.table && mc.column === c.column)) {
          missing.push({ type: 'column', table: c.table, column: c.column });
        }
      }
      return { ok: missing.length === 0, missing };
    },
    async checkColumnShape(table, column) {
      const key = `${table}.${column}`;
      return Object.prototype.hasOwnProperty.call(shapes, key) ? shapes[key] : { type: column === 'fts_vec' ? 'tsvector' : 'halfvec', dims: column === 'fts_vec' ? null : 4000 };
    },
    async query(sql, values) {
      return queryImpl(sql, values);
    },
  };
}

async function runMockedUnitTests() {
  await check('tables: [] returns zero candidates immediately, allSkipped:false', async () => {
    const client = makeMockClient({ queryImpl: () => { throw new Error('should never be queried'); } });
    const result = await memorySearch(client, { projectId: 'p1', query: 'x', tables: [] });
    assertEq(result.hits.length, 0, 'no hits');
    assertEq(result.tablesSearched.length, 0, 'nothing searched');
    assertEq(result.skippedTables.length, 0, 'nothing skipped');
    assertEq(result.allSkipped, false, 'explicit empty tables is not allSkipped');
  });

  await check('column_missing: degraded table (embedding absent) is skipped, others still queried', async () => {
    const client = makeMockClient({
      missingColumns: [{ table: 'tasks', column: 'embedding' }],
      queryImpl: (sql) => ({ rows: [{ source_table: 'research', id: '1', label: 'l', snippet: 's', score: 0.5 }] }),
    });
    const result = await memorySearch(client, { projectId: 'p1', query: 'x', tables: ['tasks', 'research'], embedder: async () => [0.1] });
    assertEq(result.skippedTables.length, 1, 'exactly one skip');
    assertEq(result.skippedTables[0].table, 'tasks', 'tasks skipped');
    assertEq(result.skippedTables[0].reason, 'column_missing', 'reason is column_missing');
    assert(result.skippedTables[0].detail.columns.includes('embedding'), 'embedding named in detail.columns');
    assertEq(result.tablesSearched.length, 1, 'research still queried');
    assertEq(result.tablesSearched[0], 'research');
    assertEq(result.allSkipped, false, 'not allSkipped — research succeeded');
  });

  await check('table_missing: absent table is skipped with reason table_missing', async () => {
    const client = makeMockClient({
      missingTables: ['incidents'],
      queryImpl: () => ({ rows: [] }),
    });
    const result = await memorySearch(client, { projectId: 'p1', query: 'x', tables: ['incidents'], embedder: async () => [0.1] });
    assertEq(result.skippedTables.length, 1);
    assertEq(result.skippedTables[0].reason, 'table_missing');
    assertEq(result.allSkipped, true, 'sole candidate skipped -> allSkipped true');
    assertEq(result.tablesSearched.length, 0);
  });

  await check('column_missing (type_mismatch): checkColumnShape mismatch is a shape-based skip', async () => {
    const client = makeMockClient({
      shapes: { 'gotchas.embedding': { type: 'vector', dims: 1024 } }, // legacy provider shape, not halfvec(4000)
      queryImpl: () => ({ rows: [] }),
    });
    const result = await memorySearch(client, { projectId: 'p1', query: 'x', tables: ['gotchas'], embedder: async () => [0.1] });
    assertEq(result.skippedTables.length, 1);
    assertEq(result.skippedTables[0].reason, 'column_missing');
    assertEq(result.skippedTables[0].detail.subReason, 'type_mismatch');
    assert(result.skippedTables[0].detail.columns.includes('embedding'));
  });

  await check('query_error: an ordinary per-table SQL error is a skip, not fatal to the call', async () => {
    const client = makeMockClient({
      queryImpl: (sql) => {
        const err = new Error('column "bogus" does not exist');
        err.code = '42703';
        throw err;
      },
    });
    const result = await memorySearch(client, { projectId: 'p1', query: 'x', tables: ['tasks'], embedder: async () => [0.1] });
    assertEq(result.skippedTables.length, 1);
    assertEq(result.skippedTables[0].reason, 'query_error');
    assertEq(result.skippedTables[0].detail.sqlstate, '42703');
    assertEq(result.allSkipped, true);
  });

  await check('query_error sub-case: extension_absent tagged for 42883/42704', async () => {
    const client = makeMockClient({
      queryImpl: () => {
        const err = new Error('operator does not exist: halfvec <=> unknown');
        err.code = '42883';
        throw err;
      },
    });
    const result = await memorySearch(client, { projectId: 'p1', query: 'x', tables: ['tasks'], embedder: async () => [0.1] });
    assertEq(result.skippedTables[0].reason, 'query_error');
    assertEq(result.skippedTables[0].detail.subReason, 'extension_absent');
  });

  await check('connection-class error (SQLSTATE 08xxx) escalates to a thrown call-level error, never a per-table skip', async () => {
    const client = makeMockClient({
      queryImpl: () => {
        const err = new Error('connection terminated unexpectedly');
        err.code = '08006';
        throw err;
      },
    });
    let threw = null;
    try {
      await memorySearch(client, { projectId: 'p1', query: 'x', tables: ['tasks', 'research'], embedder: async () => [0.1] });
    } catch (err) { threw = err; }
    assert(threw instanceof MemorySearchError, 'threw a MemorySearchError');
    assertEq(threw.code, 'connectionError', 'error code is connectionError');
  });

  await check('identical SQLSTATE recurring on >=2 tables escalates to a call-level throw (never 15 fanned-out skips)', async () => {
    const client = makeMockClient({
      queryImpl: () => {
        const err = new Error('function halfvec_cosine_ops does not exist');
        err.code = '42704'; // undefined_object, non-connection-class
        throw err;
      },
    });
    let threw = null;
    try {
      await memorySearch(client, { projectId: 'p1', query: 'x', tables: ['tasks', 'research', 'incidents'], embedder: async () => [0.1] });
    } catch (err) { threw = err; }
    assert(threw instanceof MemorySearchError, 'threw on the 2nd recurrence rather than continuing to a 3rd table');
    assertEq(threw.code, 'connectionError');
    assertEq(threw.details.occurrences, 2, 'escalated exactly at the 2nd occurrence');
  });

  await check('probe-level failure (schemaObjectsExist reports a synthetic error entry) escalates, not fanned out', async () => {
    const client = {
      async schemaObjectsExist() { return { ok: false, missing: [{ type: 'error', message: 'connection terminated' }] }; },
      async query() { throw new Error('should never be reached'); },
    };
    let threw = null;
    try {
      await memorySearch(client, { projectId: 'p1', query: 'x', tables: ['tasks', 'research'] });
    } catch (err) { threw = err; }
    assert(threw instanceof MemorySearchError);
    assertEq(threw.code, 'connectionError');
  });

  await check('allSkipped is false when at least one table is actually queried', async () => {
    const client = makeMockClient({ queryImpl: () => ({ rows: [] }) });
    const result = await memorySearch(client, { projectId: 'p1', query: 'x', tables: ['tasks'], embedder: async () => [0.1] });
    assertEq(result.allSkipped, false);
    assertEq(result.tablesSearched.length, 1);
  });

  await check('no schemaObjectsExist method (bare client) degrades to "assume present" — unchanged legacy behavior', async () => {
    const client = { async query() { return { rows: [] }; } };
    const result = await memorySearch(client, { projectId: 'p1', query: 'x', tables: ['tasks'], embedder: async () => [0.1] });
    assertEq(result.skippedTables.length, 0);
    assertEq(result.tablesSearched.length, 1);
  });

  await check('unknown table name is still a hard tool error (unchanged)', async () => {
    const client = makeMockClient({ queryImpl: () => ({ rows: [] }) });
    let threw = null;
    try {
      await memorySearch(client, { projectId: 'p1', query: 'x', tables: ['not_a_real_table'] });
    } catch (err) { threw = err; }
    assert(threw instanceof MemorySearchError);
    assertEq(threw.code, 'unknownTable');
  });

  await check('duplicate table names collapse to one query and one set of hits, first-occurrence order preserved', async () => {
    const queriedTables = [];
    const client = makeMockClient({
      queryImpl: (sql) => {
        // buildTableQuery embeds the table name in the generated SQL text,
        // so recover which table this call was for from the query count
        // rather than parsing sql — order of invocation is what matters.
        queriedTables.push(sql);
        return { rows: [{ source_table: 'tasks', id: '1', label: 'l', snippet: 's', score: 0.5 }] };
      },
    });
    const result = await memorySearch(client, {
      projectId: 'p1',
      query: 'x',
      tables: ['tasks', 'research', 'tasks', 'research', 'tasks'],
      embedder: async () => [0.1],
    });
    assertEq(queriedTables.length, 2, 'each distinct table queried exactly once, duplicates dropped');
    assertEq(result.tablesSearched.length, 2, 'tablesSearched has one entry per distinct table');
    assertEq(result.tablesSearched[0], 'tasks', 'first-occurrence order preserved (tasks before research)');
    assertEq(result.tablesSearched[1], 'research', 'first-occurrence order preserved (tasks before research)');
    // One row per distinct table queried (the mock returns one row per call)
    // — a duplicate must not double the hit count for the same table.
    assertEq(result.hits.length, 2, 'duplicates do not double-count hits');
  });
}

// ── (C) Live-Postgres integration (best-effort; skips cleanly if no local PG) ──

async function runLiveIntegrationTests() {
  let helpers;
  try {
    helpers = require('./lib/test-pg-helpers.js');
  } catch (err) {
    console.log('[SKIP] live-Postgres integration tests — test-pg-helpers.js not loadable:', err.message);
    return;
  }
  const { Client } = require('pg');
  const { PostgresAdapter } = require('./lib/db-seam.js');

  let probe;
  try {
    probe = await helpers.pgConnect('postgres');
    await probe.end();
  } catch (err) {
    console.log('[SKIP] live-Postgres integration tests — no reachable local Postgres:', err.message);
    return;
  }

  const ts = Date.now();
  const degradedDb = `cm_msearch_gate_degraded_${ts}`;
  const okDb = `cm_msearch_gate_ok_${ts}`;

  // Degraded: schema applied WITHOUT CREATE EXTENSION vector — reproduces
  // cm#224/#225's exact real-world shape (assertions present, embedding
  // column silently skipped by the schema file's own guarded ALTER TABLE).
  await check('LIVE: degraded schema (assertions present, embedding column absent) is a clean column_missing skip, never a thrown 42703', async () => {
    const sys = await helpers.pgConnect('postgres');
    await sys.query(`CREATE DATABASE "${degradedDb}"`);
    await sys.end();
    try {
      await helpers.applySchema(degradedDb);
      const client = await helpers.pgConnect(degradedDb);
      try {
        const adapter = new PostgresAdapter(client);
        const result = await memorySearch(adapter, { projectId: 'live-p1', query: 'x', tables: ['assertions'] });
        assertEq(result.tablesSearched.length, 0, 'assertions not queried');
        assertEq(result.skippedTables.length, 1, 'exactly one skip');
        assertEq(result.skippedTables[0].table, 'assertions');
        assertEq(result.skippedTables[0].reason, 'column_missing');
        assert(result.skippedTables[0].detail.columns.includes('embedding'), 'embedding named');
        assertEq(result.allSkipped, true);
      } finally {
        await client.end();
      }
    } finally {
      const sys2 = await helpers.pgConnect('postgres');
      await sys2.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()`, [degradedDb]);
      await sys2.query(`DROP DATABASE IF EXISTS "${degradedDb}"`);
      await sys2.end();
    }
  });

  // OK path: pgvector installed -> assertions.embedding present as
  // halfvec(4000) -> the table is queried, not skipped (no rows -> empty
  // hits, but tablesSearched proves the SQL actually executed).
  await check('LIVE: pgvector-enabled schema queries assertions cleanly (no rows, but no skip and no throw)', async () => {
    const sys = await helpers.pgConnect('postgres');
    await sys.query(`CREATE DATABASE "${okDb}"`);
    await sys.end();
    try {
      let vectorAvailable = true;
      try { await helpers.ensureVectorExtension(okDb); } catch (_) { vectorAvailable = false; }
      await helpers.applySchema(okDb);
      const client = await helpers.pgConnect(okDb);
      try {
        const adapter = new PostgresAdapter(client);
        const shape = await adapter.checkColumnShape('assertions', 'embedding');
        if (!shape) {
          console.log('[SKIP-INNER] pgvector not actually installed on this Postgres — cannot exercise the "ok" branch here (degraded-branch check above already covers this Postgres).');
          return;
        }
        const result = await memorySearch(adapter, {
          projectId: 'live-p2', query: 'x', tables: ['assertions'], embedder: async () => new Array(4000).fill(0.01),
        });
        assertEq(result.skippedTables.length, 0, 'no skip');
        assertEq(result.tablesSearched.length, 1, 'assertions queried');
        assertEq(result.allSkipped, false);
      } finally {
        await client.end();
      }
    } finally {
      const sys2 = await helpers.pgConnect('postgres');
      await sys2.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()`, [okDb]);
      await sys2.query(`DROP DATABASE IF EXISTS "${okDb}"`);
      await sys2.end();
    }
  });
}

async function main() {
  await runStaticDriftTest().then(() => { passed++; console.log('[PASS] static drift test — requiredColumns declared lists cover every referenced identifier'); }).catch((err) => { failures++; console.error(`[FAIL] static drift test\n       ${err.stack || err}`); });
  await runMockedUnitTests();
  await runLiveIntegrationTests();

  console.log(`\n${passed} passed, ${failures} failed.`);
  process.exit(failures > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('FATAL:', err.stack || err);
  process.exit(1);
});
