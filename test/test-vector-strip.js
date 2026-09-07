'use strict';

/**
 * test-vector-strip.js — cm MCP-payload fix: assertion_read (and every
 * other read/write §8 CRUD tool that echoes a row) was returning the full
 * pgvector embedding column inline. Observed live 2026-09-07:
 * mcp__handoff__assertion_read with predicate=open_thread on claude-memory
 * returned ~2.5MB across ~1,500 lines (every row carrying its full 4000-dim
 * embedding), making the tool unusable for its actual purpose (finding
 * rows by subject/predicate to update/suppress). A same-day follow-up
 * observed the same shape on WRITE-tool responses (assertion_suppress
 * alone echoed ~52KB per call via RETURNING *).
 *
 * Fix: scripts/lib/vector-strip.js derives the vector-column set per table
 * from schema-manifest.json's pgvector_gated entries (total classification
 * — never a hard-coded name list) and strips them from every row
 * entity-graph-crud.js/memory-upsert.js's memoryGet return, replacing each
 * with <col>_present/<col>_dims markers. includeEmbeddings:true opts back
 * into the raw vector.
 *
 * This file exercises entity-graph-crud.js's CRUD functions against a
 * MINIMAL FAKE pg client (no real Postgres, no project DB touched at all —
 * every "row" here is a hand-built JS object handed back by the fake
 * client.query stub) PLUS vector-strip.js's pure functions directly.
 *
 * Usage: node test/test-vector-strip.js
 * Requires: nothing (no DB, no network). Exit 0 = all pass; nonzero = any
 * failure.
 */

const path = require('path');
const PROJECT_ROOT = path.resolve(__dirname, '..');

const vectorStrip = require(path.join(PROJECT_ROOT, 'scripts', 'lib', 'vector-strip.js'));
const entityCrud = require(path.join(PROJECT_ROOT, 'scripts', 'lib', 'entity-graph-crud.js'));

let passed = 0, failed = 0;
const failures = [];
async function test(label, fn) {
  try {
    await fn();
    console.log(`  [PASS] ${label}`);
    passed++;
  } catch (err) {
    console.error(`  [FAIL] ${label}: ${err.message}`);
    failures.push({ label, err });
    failed++;
  }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }
function assertEqual(a, b, msg) {
  if (a !== b) throw new Error(`${msg || 'assertEqual'} — expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}

// ── Fake pg client: records the last SQL/params, returns a canned rows
// array regardless of the query text (each test supplies its own canned
// rows — this is a pure unit-level double, not a query interpreter). ──────
function makeFakeClient(cannedRows) {
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      calls.push({ sql, params });
      return { rows: cannedRows, rowCount: cannedRows.length };
    },
  };
}

const FAKE_EMBEDDING = Array.from({ length: 4000 }, (_, i) => (i % 10) / 10);

(async () => {
  // ── vector-strip.js pure-function tests ──────────────────────────────

  await test('T1 default stripRow: no embedding key, has embedding_present/embedding_dims', () => {
    const row = { id: 1, subject: 's', predicate: 'p', embedding: FAKE_EMBEDDING };
    const stripped = vectorStrip.stripRow(row, 'assertions');
    assert(!('embedding' in stripped), 'raw embedding column must be gone by default');
    assertEqual(stripped.embedding_present, true, 'embedding_present marker');
    assertEqual(stripped.embedding_dims, 4000, 'embedding_dims marker (from manifest, not row length)');
    assertEqual(stripped.id, 1, 'non-vector columns pass through unchanged');
  });

  await test('T2 includeEmbeddings:true returns the raw vector, no markers added', () => {
    const row = { id: 1, embedding: FAKE_EMBEDDING };
    const stripped = vectorStrip.stripRow(row, 'assertions', { includeEmbeddings: true });
    assert(Array.isArray(stripped.embedding) && stripped.embedding.length === 4000, 'raw vector returned');
    assert(!('embedding_present' in stripped), 'no marker fields when includeEmbeddings:true');
  });

  await test('T3 NULL embedding -> embedding_present:false, no _dims field', () => {
    const stripped = vectorStrip.stripRow({ id: 1, embedding: null }, 'assertions');
    assertEqual(stripped.embedding_present, false, 'NULL embedding is present:false');
    assert(!('embedding_dims' in stripped), 'no dims marker when not present');
  });

  await test('T4 table with no vector column (entities) is unchanged', () => {
    const row = { id: 1, name: 'e', entity_type: 't' };
    const stripped = vectorStrip.stripRow(row, 'entities');
    assertEqual(JSON.stringify(stripped), JSON.stringify(row), 'entities has no pgvector_gated manifest entry -> passthrough');
  });

  await test('T5 decisions table also strips (memory_get path)', () => {
    const stripped = vectorStrip.stripRow({ id: 1, topic: 't', embedding: FAKE_EMBEDDING }, 'decisions');
    assert(!('embedding' in stripped), 'decisions.embedding stripped too — same manifest-driven helper as assertions');
    assertEqual(stripped.embedding_dims, 4000);
  });

  await test('T6 stripRows over an array; non-array passthrough', () => {
    const rows = [{ id: 1, embedding: FAKE_EMBEDDING }, { id: 2, embedding: null }];
    const out = vectorStrip.stripRows(rows, 'assertions');
    assertEqual(out.length, 2);
    assertEqual(out[0].embedding_present, true);
    assertEqual(out[1].embedding_present, false);
    assertEqual(vectorStrip.stripRows(null, 'assertions'), null, 'non-array input passes through');
  });

  // ── entity-graph-crud.js integration (fake client, no DB) ────────────

  await test('T7 assertionRead: default response has no embedding, applies default limit=200', async () => {
    const client = makeFakeClient([{ id: 1, subject: 's', predicate: 'open_thread', object: 'o', embedding: FAKE_EMBEDDING }]);
    const rows = await entityCrud.assertionRead(client, { projectId: 'p1', predicate: 'open_thread' });
    assertEqual(rows.length, 1);
    assert(!('embedding' in rows[0]), 'assertionRead strips embedding by default');
    assertEqual(rows[0].embedding_present, true);
    const { sql, params } = client.calls[0];
    assert(/LIMIT/i.test(sql), 'assertionRead SQL carries a LIMIT clause');
    assertEqual(params[params.length - 2], 200, 'default limit param is 200 (R3)');
    assertEqual(params[params.length - 1], 0, 'default offset param is 0 (R3)');
  });

  await test('T8 assertionRead: includeEmbeddings:true returns the raw vector', async () => {
    const client = makeFakeClient([{ id: 1, subject: 's', predicate: 'p', object: 'o', embedding: FAKE_EMBEDDING }]);
    const rows = await entityCrud.assertionRead(client, { projectId: 'p1', includeEmbeddings: true });
    assert(Array.isArray(rows[0].embedding), 'raw vector returned when includeEmbeddings:true');
  });

  await test('T9 assertionRead: explicit limit is passed through to the query params', async () => {
    const client = makeFakeClient([]);
    await entityCrud.assertionRead(client, { projectId: 'p1', limit: 5, offset: 10 });
    const { params } = client.calls[0];
    assertEqual(params[params.length - 2], 5, 'explicit limit honored');
    assertEqual(params[params.length - 1], 10, 'explicit offset honored');
  });

  await test('T10 entityRead: a table with no vector column is unchanged end-to-end', async () => {
    const client = makeFakeClient([{ id: 1, name: 'e', entity_type: 't' }]);
    const rows = await entityCrud.entityRead(client, { projectId: 'p1', id: 1 });
    assertEqual(JSON.stringify(rows[0]), JSON.stringify({ id: 1, name: 'e', entity_type: 't' }), 'entities row passes through unchanged (no manifest vector column)');
  });

  // ── Scope addition (coordinator, same session): write-tool responses ──
  // (RETURNING * on entity/assertion/edge create/update/suppress) must be
  // stripped the same way — assertion_suppress alone was ~52KB/call.

  await test('T11 assertionSuppress: RETURNING * response has no embedding by default', async () => {
    const client = makeFakeClient([{
      id: 7, subject: 's', predicate: 'p', object: 'o', suppressed: true,
      suppression_kind: 'retired', embedding: FAKE_EMBEDDING,
    }]);
    const row = await entityCrud.assertionSuppress(client, { projectId: 'p1', id: 7 });
    assert(!('embedding' in row), 'assertionSuppress strips embedding by default');
    assertEqual(row.embedding_present, true);
    assertEqual(row.embedding_dims, 4000);
    assertEqual(row.suppressed, true, 'non-vector columns still returned');
  });

  await test('T12 assertionSuppress: includeEmbeddings:true opts back into the raw vector', async () => {
    const client = makeFakeClient([{ id: 7, embedding: FAKE_EMBEDDING }]);
    const row = await entityCrud.assertionSuppress(client, { projectId: 'p1', id: 7, includeEmbeddings: true });
    assert(Array.isArray(row.embedding), 'raw vector returned on write-tool response when opted in');
  });

  console.log(`\n─── Results ──────────────────────────────────────`);
  console.log(`PASS ${passed}  FAIL ${failed}`);
  if (failures.length > 0) {
    console.log('\nFailures:');
    for (const { label, err } of failures) console.log(`  - ${label}\n    ${err.stack || err.message}`);
  }
  process.exit(failed > 0 ? 1 : 0);
})().catch((err) => {
  console.error('FATAL:', err.stack || err.message);
  process.exit(1);
});
