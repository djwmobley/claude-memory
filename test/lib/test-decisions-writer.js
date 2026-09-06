'use strict';

/**
 * test-decisions-writer.js — cm#230 pure-unit regression suite.
 *
 * Covers scripts/lib/decisions-writer.js (validateDecisionRows,
 * persistDecisionRow) and scripts/handoff.js's formatIntentDivergenceLines
 * WITHOUT a live database or a live embedding provider — a fake pg client
 * (branches on SQL text) stands in for Postgres, so the embedding-provider-
 * down fail-soft path is exercised DETERMINISTICALLY regardless of whether
 * this machine happens to have a live vLLM default provider registered
 * (dev machines do; CI does not — this file's result must not depend on
 * either).
 *
 * DB-dependent coverage (a real `decisions` table, a real close/checkpoint
 * subprocess writing payload.decisions[], idempotent re-close upsert-not-
 * duplicate) lives in test/handoff/test-handoff.js's "close: decisions[]"
 * block — this file is the fast, DB-free complement, not a replacement,
 * mirroring test/lib/test-provenance-invariant.js's own stated split.
 *
 * Usage: node test/lib/test-decisions-writer.js
 * Exit 0 = all pass; nonzero = any failure.
 */

const path = require('path');
const PROJECT_ROOT = path.resolve(__dirname, '..', '..');

const decisionsWriter = require(path.join(PROJECT_ROOT, 'scripts', 'lib', 'decisions-writer.js'));
const handoffModule = require(path.join(PROJECT_ROOT, 'scripts', 'handoff.js'));

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

/**
 * A fake pg client for persistDecisionRow: branches purely on SQL text, no
 * real network/DB. `providerRows` controls resolveDefaultProvider's result
 * (empty -> "no default provider" -> embedForWrite fails soft); `insertRow`
 * is what the decisions INSERT ... RETURNING * returns.
 */
function fakeDb({ providerRows = [], insertRow } = {}) {
  return {
    query: async (sql) => {
      if (/embedding_providers/i.test(sql)) {
        return { rows: providerRows };
      }
      if (/INSERT INTO "decisions"/i.test(sql)) {
        return { rows: [insertRow] };
      }
      throw new Error(`fakeDb: unexpected query, not stubbed: ${sql.slice(0, 80)}`);
    },
  };
}

async function main() {
  console.log('test-decisions-writer: starting');

  // ── validateDecisionRows (moved verbatim from handoff-mcp.mjs, cm#230) ──
  await run('DW-1', 'validateDecisionRows: valid row -> no errors', async () => {
    const errors = decisionsWriter.validateDecisionRows([{ topic: 'my-topic', decision: 'd', reason: 'r' }]);
    assert(errors.length === 0, `expected no errors, got: ${JSON.stringify(errors)}`);
  });
  await run('DW-2', 'validateDecisionRows: topic without a hyphen is rejected (kebab-case-with->=1-hyphen contract)', async () => {
    const errors = decisionsWriter.validateDecisionRows([{ topic: 'nohyphen', decision: 'd', reason: 'r' }]);
    assert(errors.some((e) => e.includes('topic')), `expected a topic error, got: ${JSON.stringify(errors)}`);
  });
  await run('DW-3', 'validateDecisionRows: uppercase topic is rejected (case-variant adversarial input never silently accepted)', async () => {
    const errors = decisionsWriter.validateDecisionRows([{ topic: 'My-Topic', decision: 'd', reason: 'r' }]);
    assert(errors.some((e) => e.includes('topic')), `expected uppercase topic to be rejected, got: ${JSON.stringify(errors)}`);
  });
  await run('DW-4', 'validateDecisionRows: topic with embedded whitespace is rejected', async () => {
    const errors = decisionsWriter.validateDecisionRows([{ topic: 'my topic-x', decision: 'd', reason: 'r' }]);
    assert(errors.some((e) => e.includes('topic')), `expected whitespace-in-topic to be rejected, got: ${JSON.stringify(errors)}`);
  });
  await run('DW-5', 'validateDecisionRows: missing decision -> error', async () => {
    const errors = decisionsWriter.validateDecisionRows([{ topic: 'my-topic', reason: 'r' }]);
    assert(errors.some((e) => e.includes('decision')), `expected a decision error, got: ${JSON.stringify(errors)}`);
  });
  await run('DW-6', 'validateDecisionRows: missing reason -> error', async () => {
    const errors = decisionsWriter.validateDecisionRows([{ topic: 'my-topic', decision: 'd' }]);
    assert(errors.some((e) => e.includes('reason')), `expected a reason error, got: ${JSON.stringify(errors)}`);
  });
  await run('DW-7', 'validateDecisionRows: empty array -> error (not silently ok)', async () => {
    const errors = decisionsWriter.validateDecisionRows([]);
    assert(errors.length > 0, 'expected an error for an empty rows array');
  });

  // ── persistDecisionRow: embedding-provider-down fail-soft (cm#230's own scenario) ──
  await run('DW-8', 'persistDecisionRow: no default embedding_providers row -> row STILL written, embedding=NULL, non-null warning', async () => {
    const db = fakeDb({
      providerRows: [], // no default provider -> resolveDefaultProvider throws -> fail-soft
      insertRow: { id: 1, project_id: 'p', topic: 'vllm-embedding-default', decision: 'd', reason: 'r', inserted: true },
    });
    const { written, warning } = await decisionsWriter.persistDecisionRow(db, 'p', {
      topic: 'vllm-embedding-default', decision: 'd', reason: 'r',
    });
    assert(written.id === 1 && written.topic === 'vllm-embedding-default' && written.inserted === true,
      `expected the row to be written despite the embedding provider being down, got: ${JSON.stringify(written)}`);
    assert(typeof warning === 'string' && warning.length > 0, `expected a non-null fail-soft warning, got: ${JSON.stringify(warning)}`);
  });

  // ── persistDecisionRow: row-shape contract on the UPDATE (re-close/upsert) branch ──
  // Deliberately NOT exercising a real embed() network call anywhere in this
  // file (that requires a live provider row's endpoint/model — out of scope
  // for a DB-free unit test); DW-8 above already proves the fail-soft branch
  // that matters for cm#230 (embedding-provider-down is non-fatal). The
  // success branch (a real vector actually landing in the embedding column)
  // is covered by test-decisions-canon.js's T1(d) live-INSERT proof and by
  // this repo's existing write-time-embed provenance coverage
  // (test/lib/test-provenance-invariant.js's WTE-4/WRP-1) — not re-proven
  // here. This test only proves persistDecisionRow forwards `inserted` (the
  // xmax=0 idiom) through UNCHANGED on the ON-CONFLICT-DO-UPDATE path, i.e.
  // the shape a re-close's idempotent upsert relies on.
  await run('DW-9', 'persistDecisionRow: ON CONFLICT DO UPDATE branch (inserted:false) row shape is forwarded unchanged', async () => {
    const db = fakeDb({
      providerRows: [],
      insertRow: { id: 2, project_id: 'p', topic: 'other-topic', decision: 'd2', reason: 'r2', inserted: false },
    });
    const { written } = await decisionsWriter.persistDecisionRow(db, 'p', {
      topic: 'other-topic', decision: 'd2', reason: 'r2',
    });
    assert(written.id === 2 && written.inserted === false, `expected the UPDATE-branch row shape, got: ${JSON.stringify(written)}`);
  });

  // ── formatIntentDivergenceLines: cm#230's embed_degraded branch is a ──
  // ── STRICT SUPERSET of cm#227's existing NOT-PERSISTED rendering ──────
  await run('DW-10', 'formatIntentDivergenceLines: a divergence with NO kind (every pre-existing cm#227 caller) renders EXACTLY as before', async () => {
    const lines = handoffModule.formatIntentDivergenceLines([
      { predicate: 'session_tldr', subject: 'proj', message: 'boom\nsecond line ignored' },
    ]);
    assert(lines.length === 1, `expected 1 line, got ${lines.length}`);
    assert(lines[0] === 'DIVERGENCE: session_tldr NOT PERSISTED — boom', `unexpected line: ${lines[0]}`);
  });
  await run('DW-11', 'formatIntentDivergenceLines: kind="embed_degraded" renders a DISTINCT line — never confused with NOT PERSISTED', async () => {
    const lines = handoffModule.formatIntentDivergenceLines([
      { predicate: 'decision:vllm-embedding-default', subject: 'vllm-embedding-default', message: 'write-time-embed: embedding failed (fail-soft, row still written with embedding=NULL): boom', kind: 'embed_degraded' },
    ]);
    assert(lines.length === 1, `expected 1 line, got ${lines.length}`);
    assert(lines[0].startsWith('DIVERGENCE: decision:vllm-embedding-default EMBEDDING DEGRADED'), `unexpected line: ${lines[0]}`);
    assert(!lines[0].includes('NOT PERSISTED'), `embed_degraded line must never say NOT PERSISTED (row WAS persisted): ${lines[0]}`);
  });
  await run('DW-12', 'formatIntentDivergenceLines: kind="not_persisted" (decisions write failure) renders the standard NOT PERSISTED line with the topic-namespaced predicate intact', async () => {
    const lines = handoffModule.formatIntentDivergenceLines([
      { predicate: 'decision:bad-topic', subject: 'bad-topic', message: 'validation failed — rows[0].reason: required non-empty string.', kind: 'not_persisted' },
    ]);
    assert(lines[0] === 'DIVERGENCE: decision:bad-topic NOT PERSISTED — validation failed — rows[0].reason: required non-empty string.', `unexpected line: ${lines[0]}`);
  });

  console.log(`test-decisions-writer: ${passed} passed, ${failed} failed`);
  process.exitCode = failed > 0 ? 1 : 0;
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exitCode = 1;
});
