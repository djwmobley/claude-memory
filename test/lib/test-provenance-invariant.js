'use strict';

/**
 * test-provenance-invariant.js — cm#201/cm#202 pure-unit regression suite.
 *
 * Covers the parts of the provenance-stamping invariant ("every SQL
 * statement that assigns `embedding` — including assigning NULL — assigns
 * `embedded_by_provider_id` in the same statement") that are testable
 * WITHOUT a live database: memory-upsert.js's both-or-neither validation
 * (checked before any SQL is issued — proven here via a fake client whose
 * `.query` throws unconditionally, so a passing assertion here means the
 * validation short-circuited BEFORE reaching the DB), write-time-embed.js's
 * embedForWrite null-pairing invariant on every failure path, and
 * writeRowWithProvenanceRetry's FK-23503-retry/degrade orchestration (pure
 * logic — a fake writeFn simulates the FK failure/recovery sequence, an
 * injected embedder means zero real DB/network calls happen at all).
 *
 * DB-dependent coverage (both-or-neither exercised against a real INSERT,
 * upsertDecisionRow's actual null-out on a live UPDATE, the exchange-log
 * appendExchange both-or-neither pairing) lives in
 * scripts/migrations/verify-19-seams-smoke.js / verify-20-mcp-surface.js
 * (run via test/migrations/test-verify-19.js / test-verify-20.js) — this
 * file is the fast, DB-free complement, not a replacement.
 *
 * Usage: node test/lib/test-provenance-invariant.js
 * Exit 0 = all pass; nonzero = any failure.
 */

const path = require('path');
const PROJECT_ROOT = path.resolve(__dirname, '..', '..');

const memoryUpsert = require(path.join(PROJECT_ROOT, 'scripts', 'lib', 'memory-upsert.js'));
const { embedForWrite, writeRowWithProvenanceRetry } = require(path.join(PROJECT_ROOT, 'scripts', 'lib', 'write-time-embed.js'));

let passed = 0, failed = 0;
async function run(id, label, fn) {
  try {
    await fn();
    console.log(`  [PASS] ${id} ${label}`);
    passed++;
  } catch (err) {
    console.error(`  [FAIL] ${id} ${label}: ${err.message}`);
    failed++;
  }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }
async function assertThrows(fn, msgIncludes) {
  let threw = false;
  try { await fn(); } catch (err) {
    threw = true;
    if (msgIncludes) assert(err.message.includes(msgIncludes), `expected error to include "${msgIncludes}", got: ${err.message}`);
  }
  assert(threw, 'expected function to throw, but it did not');
}

/** A client whose .query throws unconditionally — proves a caller never reached SQL. */
function unreachableClient() {
  return { query: async () => { throw new Error('unreachableClient: .query was called — validation did not short-circuit before SQL'); } };
}

/** A client that records every SQL string passed to .query, returning a canned row. */
function recordingClient(returnRow) {
  const calls = [];
  return {
    calls,
    query: async (sql, params) => { calls.push({ sql, params }); return { rows: [returnRow] }; },
  };
}

async function main() {
  console.log('test-provenance-invariant: starting');

  // ── memory-upsert.js: writeMemoryRow both-or-neither ────────────────────
  await run('MU-1', 'writeMemoryRow: embeddingVectorLiteral WITHOUT embeddedByProviderId is a validation error, before any SQL', async () => {
    await assertThrows(
      () => memoryUpsert.writeMemoryRow(unreachableClient(), 'gotchas', { project_id: 'p', issue: 'i', rule: 'r' }, { embeddingVectorLiteral: '[0.1]' }),
      'must be supplied together'
    );
  });
  await run('MU-2', 'writeMemoryRow: embeddedByProviderId WITHOUT embeddingVectorLiteral is a validation error, before any SQL', async () => {
    await assertThrows(
      () => memoryUpsert.writeMemoryRow(unreachableClient(), 'gotchas', { project_id: 'p', issue: 'i', rule: 'r' }, { embeddedByProviderId: 1 }),
      'must be supplied together'
    );
  });
  await run('MU-3', 'writeMemoryRow: neither opt supplied is fine (embedding left NULL, no provenance error)', async () => {
    const client = recordingClient({ id: 1 });
    const row = await memoryUpsert.writeMemoryRow(client, 'gotchas', { project_id: 'p', issue: 'i', rule: 'r' });
    assert(row.id === 1, 'expected the row to be returned');
    assert(!client.calls[0].sql.includes('embedding'), 'expected no embedding/embedded_by_provider_id columns in the INSERT when neither opt is supplied');
  });
  await run('MU-4', 'writeMemoryRow: both opts supplied together writes both columns in the SAME INSERT statement', async () => {
    const client = recordingClient({ id: 2 });
    await memoryUpsert.writeMemoryRow(client, 'gotchas', { project_id: 'p', issue: 'i', rule: 'r' }, { embeddingVectorLiteral: '[0.1]', embeddedByProviderId: 7 });
    const sql = client.calls[0].sql;
    assert(sql.includes('"embedding"') && sql.includes('"embedded_by_provider_id"'), `expected both columns in the INSERT, got: ${sql}`);
    assert(client.calls[0].params.includes('[0.1]') && client.calls[0].params.includes(7), 'expected both values bound');
  });
  await run('MU-5', 'writeMemoryRow: embeddedByProviderId=0 is NOT misread as "absent" (null check via !== null && !== undefined, never truthiness)', async () => {
    const client = recordingClient({ id: 3 });
    await memoryUpsert.writeMemoryRow(client, 'gotchas', { project_id: 'p', issue: 'i', rule: 'r' }, { embeddingVectorLiteral: '[0.1]', embeddedByProviderId: 0 });
    assert(client.calls[0].sql.includes('"embedded_by_provider_id"'), 'expected embedded_by_provider_id=0 to be treated as PRESENT (a real id), not absent');
  });
  await run('MU-6', 'writeMemoryRow: embedded_by_provider_id cannot be smuggled in via `row` (unknownKey, TABLE_COLUMN_MAP never carries it)', async () => {
    try {
      await memoryUpsert.writeMemoryRow(unreachableClient(), 'gotchas', { project_id: 'p', issue: 'i', rule: 'r', embedded_by_provider_id: 99 });
      throw new Error('expected an unknownKey error');
    } catch (err) {
      assert(err.code === 'unknownKey', `expected code=unknownKey, got ${err.code} (message: ${err.message})`);
    }
  });

  // ── memory-upsert.js: upsertDecisionRow both-or-neither + null-degrade ──
  await run('MU-7', 'upsertDecisionRow: embeddingVectorLiteral WITHOUT embeddedByProviderId is a validation error, before any SQL', async () => {
    await assertThrows(
      () => memoryUpsert.upsertDecisionRow(unreachableClient(), { project_id: 'p', topic: 't', decision: 'd' }, { embeddingVectorLiteral: '[0.1]' }),
      'must be supplied together'
    );
  });
  await run('MU-8', 'upsertDecisionRow: embeddedByProviderId WITHOUT embeddingVectorLiteral is a validation error, before any SQL', async () => {
    await assertThrows(
      () => memoryUpsert.upsertDecisionRow(unreachableClient(), { project_id: 'p', topic: 't', decision: 'd' }, { embeddedByProviderId: 1 }),
      'must be supplied together'
    );
  });
  await run('MU-9', 'upsertDecisionRow: a topic-edit (decision supplied) with NO fresh vector explicitly NULLs BOTH embedding and embedded_by_provider_id in the UPDATE SET clause (degrade to backfillable-NULL, never a stale vector with clean-looking provenance)', async () => {
    const client = recordingClient({ id: 4, inserted: false });
    await memoryUpsert.upsertDecisionRow(client, { project_id: 'p', topic: 't', decision: 'edited-decision', reason: 'r' });
    const sql = client.calls[0].sql;
    assert(sql.includes('"embedding" = NULL') && sql.includes('"embedded_by_provider_id" = NULL'), `expected both columns explicitly NULLed in the UPDATE SET clause, got: ${sql}`);
  });
  await run('MU-10', 'upsertDecisionRow: a topic-edit WITH a fresh vector re-sets BOTH columns from EXCLUDED (never NULLed)', async () => {
    const client = recordingClient({ id: 5, inserted: false });
    await memoryUpsert.upsertDecisionRow(client, { project_id: 'p', topic: 't', decision: 'edited-decision', reason: 'r' }, { embeddingVectorLiteral: '[0.2]', embeddedByProviderId: 9 });
    const sql = client.calls[0].sql;
    assert(sql.includes('"embedding" = EXCLUDED."embedding"') && sql.includes('"embedded_by_provider_id" = EXCLUDED."embedded_by_provider_id"'), `expected both columns re-set from EXCLUDED, got: ${sql}`);
    assert(!sql.includes('"embedding" = NULL'), 'expected embedding NOT nulled when a fresh vector was supplied');
  });

  // ── write-time-embed.js: embedForWrite null-pairing invariant ───────────
  await run('WTE-1', 'embedForWrite: empty text -> both vectorLiteral and providerId null', async () => {
    const result = await embedForWrite(unreachableClient(), '   ');
    assert(result.vectorLiteral === null && result.providerId === null, `expected both null, got ${JSON.stringify(result)}`);
    assert(typeof result.warning === 'string' && result.warning.length > 0, 'expected a warning');
  });
  await run('WTE-2', 'embedForWrite: opts.embedder without opts.embedderProviderId fails soft -> both null (never throws out of embedForWrite itself)', async () => {
    const result = await embedForWrite({}, 'some text', { embedder: async () => [0.1, 0.2] });
    assert(result.vectorLiteral === null && result.providerId === null, `expected both null on a misused seam, got ${JSON.stringify(result)}`);
  });
  await run('WTE-3', 'embedForWrite: embed function throws -> both null (fail-soft, row-never-lost path)', async () => {
    const result = await embedForWrite({}, 'some text', { embedder: async () => { throw new Error('SIMULATED-EMBED-FAILURE'); }, embedderProviderId: 3 });
    assert(result.vectorLiteral === null && result.providerId === null, `expected both null on embed failure, got ${JSON.stringify(result)}`);
    assert(result.warning.includes('SIMULATED-EMBED-FAILURE'), 'expected the underlying failure message in the warning');
  });
  await run('WTE-4', 'embedForWrite: success -> both non-null together', async () => {
    const result = await embedForWrite({}, 'some text', { embedder: async () => [0.1, 0.2, 0.3], embedderProviderId: 11 });
    assert(result.vectorLiteral === '[0.1,0.2,0.3]' && result.providerId === 11, `expected a paired success, got ${JSON.stringify(result)}`);
    assert(result.warning === null, 'expected no warning on success');
  });

  // ── write-time-embed.js: writeRowWithProvenanceRetry FK-23503 orchestration ──
  const mockEmbedder = async () => [0.1, 0.2];
  await run('WRP-1', 'writeRowWithProvenanceRetry: FK 23503 on the first write -> re-resolve once -> retry succeeds', async () => {
    let calls = 0;
    const writeFn = async (opts) => {
      calls++;
      if (calls === 1) { const e = new Error('insert or update on table "decisions" violates foreign key constraint "decisions_embedded_by_provider_id_fkey"'); e.code = '23503'; throw e; }
      return { id: 1, embedding: opts.embeddingVectorLiteral, embedded_by_provider_id: opts.embeddedByProviderId };
    };
    const { written, warning } = await writeRowWithProvenanceRetry({}, 'text', writeFn, { embedder: mockEmbedder, embedderProviderId: 42 });
    assert(calls === 2, `expected exactly 2 writeFn calls (fail, then retry-succeed), got ${calls}`);
    assert(written.embedded_by_provider_id === 42, 'expected the retry to carry a real (non-null) provider id');
    assert(warning.includes('re-resolved embedding provider after FK 23503'), `expected a re-resolve warning, got: ${warning}`);
  });
  await run('WRP-2', 'writeRowWithProvenanceRetry: FK 23503 on BOTH the first write and the retry -> degrades to NEITHER column (row-never-lost)', async () => {
    let calls = 0;
    const writeFn = async (opts) => {
      calls++;
      if (calls <= 2) { const e = new Error('violates foreign key constraint "x_embedded_by_provider_id_fkey"'); e.code = '23503'; throw e; }
      assert(opts.embeddingVectorLiteral === null && opts.embeddedByProviderId === null, 'expected the 3rd (degrade) call to carry NEITHER column');
      return { id: 2, embedding: null, embedded_by_provider_id: null };
    };
    const { written, warning } = await writeRowWithProvenanceRetry({}, 'text', writeFn, { embedder: mockEmbedder, embedderProviderId: 42 });
    assert(calls === 3, `expected exactly 3 writeFn calls (fail, retry-fail, degrade-succeed), got ${calls}`);
    assert(written.embedding === null && written.embedded_by_provider_id === null, 'expected the row written with neither column');
    assert(warning.includes('persisted after one re-resolve+retry'), `expected a persisted-failure warning, got: ${warning}`);
  });
  await run('WRP-3', 'writeRowWithProvenanceRetry: a NON-23503 write error propagates immediately, never retried', async () => {
    let calls = 0;
    const writeFn = async () => { calls++; throw new Error('SIMULATED-UNRELATED-DB-ERROR'); };
    await assertThrows(() => writeRowWithProvenanceRetry({}, 'text', writeFn, { embedder: mockEmbedder, embedderProviderId: 42 }), 'SIMULATED-UNRELATED-DB-ERROR');
    assert(calls === 1, `expected exactly 1 writeFn call (no retry for a non-FK error), got ${calls}`);
  });
  await run('WRP-4', 'writeRowWithProvenanceRetry: a 23503 on an UNRELATED FK (not embedded_by_provider_id) propagates immediately, never retried', async () => {
    let calls = 0;
    const writeFn = async () => { calls++; const e = new Error('violates foreign key constraint "some_other_fkey"'); e.code = '23503'; throw e; };
    await assertThrows(() => writeRowWithProvenanceRetry({}, 'text', writeFn, { embedder: mockEmbedder, embedderProviderId: 42 }), 'some_other_fkey');
    assert(calls === 1, `expected exactly 1 writeFn call (a 23503 on a different FK is not this class), got ${calls}`);
  });

  console.log(`test-provenance-invariant: ${passed} passed, ${failed} failed`);
  process.exitCode = failed > 0 ? 1 : 0;
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exitCode = 1;
});
