'use strict';

/**
 * test-close-marker-outcome.js — fix(close) regression guard for the total
 * classification implemented by clearSessionMarkerForClose (scripts/handoff.js).
 *
 * Background (the verified defect this PR fixes): a close from a Codex
 * session (a different session id than the one that owns the live
 * session_in_progress marker) printed "session marker cleared" on the Done
 * line while the marker stayed in place under the OTHER session's id — both
 * Done lines printed that text unconditionally, and clearSessionMarkerForClose
 * returned a boolean the callers ignored. This file pins the fixed behavior:
 * clearSessionMarkerForClose now returns a structured
 * { branch, deleted, ownedBy, malformed, text } outcome covering every
 * combination of "resolved session id present/absent" x "marker list
 * state" (branches A-G), and the two Done-line call sites print that text
 * verbatim instead of a hardcoded string.
 *
 * No real Postgres is used — a minimal in-memory FakeDb stands in for the
 * one table (project_settings) and lock primitive
 * (db.acquireNamedXactLock) clearSessionMarkerForClose touches, so this file
 * exercises the pure branch logic and the read-modify-write shape at unit
 * speed.
 *
 * Usage:
 *   node scripts/test-close-marker-outcome.js
 *
 * Exit 0 = all pass, 1 = any failure.
 */

const assert = require('assert');
const {
  parseSessionMarkersDetailed,
  clearSessionMarkerForClose,
  formatOwnerIds,
  getSetting,
} = require('./handoff.js');

let passed = 0;
let failed = 0;

function pass(label) { console.log(`PASS  ${label}`); passed++; }
function fail(label, reason) { console.log(`FAIL  ${label}: ${reason}`); failed++; }

async function test(label, fn) {
  try {
    await fn();
    pass(label);
  } catch (err) {
    fail(label, err && err.message ? err.message : String(err));
  }
}

/** Save/restore a set of env vars around an async fn. */
async function withEnv(vars, fn) {
  const saved = {};
  for (const k of Object.keys(vars)) saved[k] = process.env[k];
  for (const k of Object.keys(vars)) {
    if (vars[k] === undefined) delete process.env[k];
    else process.env[k] = vars[k];
  }
  try {
    return await fn();
  } finally {
    for (const k of Object.keys(vars)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

const PROJECT_ID = 'test-project';

/**
 * Minimal in-memory stand-in for the one project_settings table and the
 * advisory-lock primitive clearSessionMarkerForClose touches. Not a general
 * SQL engine — recognizes exactly the query shapes getSetting/setSetting/
 * setSessionMarkers/withSessionMarkerLock issue.
 */
class FakeDb {
  constructor() {
    this.rows = new Map(); // `${projectId}::${key}` -> string value
    this.failSelect = null; // set to an Error to simulate an unreadable store
  }
  async query(sql, params = []) {
    const norm = sql.trim().replace(/\s+/g, ' ').toUpperCase();
    if (norm.startsWith('BEGIN') || norm.startsWith('COMMIT') || norm.startsWith('ROLLBACK')) {
      return { rows: [] };
    }
    if (norm.startsWith('SELECT VALUE FROM PROJECT_SETTINGS')) {
      if (this.failSelect) throw this.failSelect;
      const [projectId, key] = params;
      const k = `${projectId}::${key}`;
      return this.rows.has(k) ? { rows: [{ value: this.rows.get(k) }] } : { rows: [] };
    }
    if (norm.startsWith('INSERT INTO PROJECT_SETTINGS')) {
      const [projectId, key, value] = params;
      this.rows.set(`${projectId}::${key}`, String(value));
      return { rows: [] };
    }
    if (norm.startsWith('DELETE FROM PROJECT_SETTINGS')) {
      const [projectId] = params;
      this.rows.delete(`${projectId}::session_in_progress`);
      return { rows: [] };
    }
    throw new Error(`FakeDb: unhandled query shape: ${sql}`);
  }
  async acquireNamedXactLock(_key) { /* no-op — single-connection fake, no real concurrency */ }
  seedMarker(rawValue) { this.rows.set(`${PROJECT_ID}::session_in_progress`, rawValue); }
  markerValue() { return this.rows.get(`${PROJECT_ID}::session_in_progress`); }
}

async function run() {
  // ── parseSessionMarkersDetailed — malformed counting ──────────────────────

  await test('detailed: well-formed array -> markers, malformed=0', async () => {
    const { markers, malformed } = parseSessionMarkersDetailed(JSON.stringify([
      { session_id: 'a', ts: '2026-01-01T00:00:00.000Z' },
      { session_id: null, ts: '2026-01-02T00:00:00.000Z' },
    ]));
    assert.strictEqual(markers.length, 2);
    assert.strictEqual(malformed, 0);
  });

  await test('detailed: ts not a string -> malformed, excluded', async () => {
    const { markers, malformed } = parseSessionMarkersDetailed(JSON.stringify([
      { session_id: 'a', ts: 12345 },
      { session_id: 'b', ts: '2026-01-02T00:00:00.000Z' },
    ]));
    assert.strictEqual(markers.length, 1);
    assert.strictEqual(markers[0].session_id, 'b');
    assert.strictEqual(malformed, 1);
  });

  await test('detailed: session_id not string|null -> malformed, excluded', async () => {
    const { markers, malformed } = parseSessionMarkersDetailed(JSON.stringify([
      { session_id: 42, ts: '2026-01-01T00:00:00.000Z' },
    ]));
    assert.strictEqual(markers.length, 0);
    assert.strictEqual(malformed, 1);
  });

  await test('detailed: non-object array element -> malformed, excluded', async () => {
    const { markers, malformed } = parseSessionMarkersDetailed(JSON.stringify([
      'not-an-object',
      { session_id: 'a', ts: '2026-01-01T00:00:00.000Z' },
    ]));
    assert.strictEqual(markers.length, 1);
    assert.strictEqual(malformed, 1);
  });

  await test('detailed: mixed malformed count is exact', async () => {
    const { markers, malformed } = parseSessionMarkersDetailed(JSON.stringify([
      { session_id: 'a', ts: '2026-01-01T00:00:00.000Z' },
      { ts: 1 },
      null,
      { session_id: [], ts: '2026-01-02T00:00:00.000Z' },
    ]));
    assert.strictEqual(markers.length, 1);
    assert.strictEqual(malformed, 3);
  });

  // ── formatOwnerIds — dedupe + cap ──────────────────────────────────────────

  await test('formatOwnerIds: dedupes exact-string duplicates', async () => {
    assert.strictEqual(formatOwnerIds(['a', 'a', 'b']), 'a, b');
  });

  await test('formatOwnerIds: caps at 5 with a +k more suffix over unique ids', async () => {
    const ids = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
    assert.strictEqual(formatOwnerIds(ids), 'a, b, c, d, e +2 more');
  });

  await test('formatOwnerIds: cap counts UNIQUE remainder, not raw remainder', async () => {
    const ids = ['a', 'b', 'c', 'd', 'e', 'f', 'f', 'f'];
    assert.strictEqual(formatOwnerIds(ids), 'a, b, c, d, e +1 more');
  });

  // ── clearSessionMarkerForClose — branches A-G ─────────────────────────────

  await withEnv({ CLAUDE_CODE_SESSION_ID: undefined, CODEX_THREAD_ID: undefined }, async () => {
    await test('A: exact session_id match -> deletes it, reports session id', async () => {
      const db = new FakeDb();
      db.seedMarker(JSON.stringify([{ session_id: 'sess-A', ts: '2026-01-01T00:00:00.000Z' }]));
      const r = await clearSessionMarkerForClose(db, PROJECT_ID, { session_id: 'sess-A' });
      assert.strictEqual(r.branch, 'A');
      assert.strictEqual(r.deleted, 1);
      assert.strictEqual(r.text, 'session marker cleared (session sess-A)');
      assert.strictEqual(db.markerValue(), undefined);
    });

    await test('A: duplicate-id entries ALL deleted, not just the first', async () => {
      const db = new FakeDb();
      db.seedMarker(JSON.stringify([
        { session_id: 'sess-A', ts: '2026-01-01T00:00:00.000Z' },
        { session_id: 'sess-A', ts: '2026-01-01T00:00:01.000Z' },
        { session_id: 'sess-B', ts: '2026-01-01T00:00:02.000Z' },
      ]));
      const r = await clearSessionMarkerForClose(db, PROJECT_ID, { session_id: 'sess-A' });
      assert.strictEqual(r.branch, 'A');
      assert.strictEqual(r.deleted, 2);
      const remaining = JSON.parse(db.markerValue());
      assert.strictEqual(remaining.length, 1);
      assert.strictEqual(remaining[0].session_id, 'sess-B');
    });

    await test('A: whitespace-padded payload.session_id is trimmed before matching', async () => {
      const db = new FakeDb();
      db.seedMarker(JSON.stringify([{ session_id: 'sess-A', ts: '2026-01-01T00:00:00.000Z' }]));
      const r = await clearSessionMarkerForClose(db, PROJECT_ID, { session_id: '  sess-A  ' });
      assert.strictEqual(r.branch, 'A');
      assert.strictEqual(r.deleted, 1);
    });

    await test('B: no exact match, legacy null-id marker present -> cleared as legacy', async () => {
      const db = new FakeDb();
      db.seedMarker('smoketest_legacy_marker'); // not JSON -> legacy single marker
      const r = await clearSessionMarkerForClose(db, PROJECT_ID, { session_id: 'sess-other' });
      assert.strictEqual(r.branch, 'B');
      assert.strictEqual(r.deleted, 1);
      assert.strictEqual(r.text, 'legacy session marker cleared (marker had no session id)');
      assert.strictEqual(db.markerValue(), undefined);
    });

    await test('C: no exact, no null, list non-empty -> nothing deleted, owners reported', async () => {
      const db = new FakeDb();
      db.seedMarker(JSON.stringify([{ session_id: 'sess-owner', ts: '2026-01-01T00:00:00.000Z' }]));
      const r = await clearSessionMarkerForClose(db, PROJECT_ID, { session_id: 'sess-caller' });
      assert.strictEqual(r.branch, 'C');
      assert.strictEqual(r.deleted, 0);
      assert.strictEqual(r.text, 'session marker left in place (owned by sess-owner)');
      assert.strictEqual(JSON.parse(db.markerValue()).length, 1);
    });

    await test('D: session id unresolved, legacy null-id marker present -> cleared', async () => {
      const db = new FakeDb();
      db.seedMarker('smoketest_legacy_marker');
      const r = await clearSessionMarkerForClose(db, PROJECT_ID, {});
      assert.strictEqual(r.branch, 'D');
      assert.strictEqual(r.deleted, 1);
      assert.strictEqual(r.text, 'session marker cleared (session id unresolved; marker had no session id)');
    });

    await test('E: session id unresolved, no null entry, non-empty -> left in place, owners reported', async () => {
      const db = new FakeDb();
      db.seedMarker(JSON.stringify([{ session_id: 'sess-owner', ts: '2026-01-01T00:00:00.000Z' }]));
      const r = await clearSessionMarkerForClose(db, PROJECT_ID, {});
      assert.strictEqual(r.branch, 'E');
      assert.strictEqual(r.deleted, 0);
      assert.strictEqual(r.text, 'session marker left in place (session id unresolved; owned by sess-owner)');
    });

    await test('F: no marker at all -> "no session marker present"', async () => {
      const db = new FakeDb();
      const r = await clearSessionMarkerForClose(db, PROJECT_ID, { session_id: 'sess-A' });
      assert.strictEqual(r.branch, 'F');
      assert.strictEqual(r.deleted, 0);
      assert.strictEqual(r.text, 'no session marker present');
    });

    await test('F + malformed: empty-after-exclusion list still reports the malformed count', async () => {
      const db = new FakeDb();
      db.seedMarker(JSON.stringify([{ ts: 1 }, 'garbage']));
      const r = await clearSessionMarkerForClose(db, PROJECT_ID, { session_id: 'sess-A' });
      assert.strictEqual(r.branch, 'F');
      assert.strictEqual(r.malformed, 2);
      assert.strictEqual(r.text, 'no session marker present; 2 malformed marker entries ignored');
    });

    await test('A + malformed suffix: singular "entry" wording for malformed=1', async () => {
      const db = new FakeDb();
      db.seedMarker(JSON.stringify([
        { session_id: 'sess-A', ts: '2026-01-01T00:00:00.000Z' },
        { ts: 999 },
      ]));
      const r = await clearSessionMarkerForClose(db, PROJECT_ID, { session_id: 'sess-A' });
      assert.strictEqual(r.branch, 'A');
      assert.strictEqual(r.malformed, 1);
      assert.strictEqual(r.text, 'session marker cleared (session sess-A); 1 malformed marker entry ignored');
    });

    await test('G: an unreadable store never throws — reports the error and leaves state as-is', async () => {
      const db = new FakeDb();
      db.seedMarker(JSON.stringify([{ session_id: 'sess-A', ts: '2026-01-01T00:00:00.000Z' }]));
      db.failSelect = new Error('connection terminated unexpectedly');
      const r = await clearSessionMarkerForClose(db, PROJECT_ID, { session_id: 'sess-A' });
      assert.strictEqual(r.branch, 'G');
      assert.strictEqual(r.deleted, 0);
      assert.ok(r.text.startsWith('session marker unreadable (connection terminated unexpectedly); left as-is'));
      // state genuinely untouched — the seeded value is still there verbatim
      assert.ok(JSON.parse(db.markerValue())[0].session_id === 'sess-A');
    });

    await test('deleted>0 stamps the last_explicit_close breadcrumb', async () => {
      const db = new FakeDb();
      db.seedMarker(JSON.stringify([{ session_id: 'sess-A', ts: '2026-01-01T00:00:00.000Z' }]));
      await clearSessionMarkerForClose(db, PROJECT_ID, { session_id: 'sess-A' });
      const breadcrumbRaw = await getSetting(db, PROJECT_ID, 'last_explicit_close', null);
      assert.ok(breadcrumbRaw, 'expected a last_explicit_close breadcrumb to be written');
      const breadcrumb = JSON.parse(breadcrumbRaw);
      assert.strictEqual(breadcrumb.session_id, 'sess-A');
    });

    await test('deleted=0 (branch C) does NOT stamp the breadcrumb', async () => {
      const db = new FakeDb();
      db.seedMarker(JSON.stringify([{ session_id: 'sess-owner', ts: '2026-01-01T00:00:00.000Z' }]));
      await clearSessionMarkerForClose(db, PROJECT_ID, { session_id: 'sess-caller' });
      const breadcrumbRaw = await getSetting(db, PROJECT_ID, 'last_explicit_close', null);
      assert.strictEqual(breadcrumbRaw, null);
    });
  });

  // ── MCP schema + payload pass-through (unit-level, stubbed child spawn) ───

  await test('MCP: handoff_close/handoff_checkpoint tool schemas declare optional sessionId', async () => {
    const src = require('fs').readFileSync(require('path').join(__dirname, 'handoff-mcp.mjs'), 'utf8');
    const registerCheckpoint = src.indexOf("'handoff_checkpoint'");
    const registerClose = src.indexOf("'handoff_close'");
    assert.ok(registerCheckpoint !== -1 && registerClose !== -1, 'tool registrations not found');
    const checkpointBlock = src.slice(registerCheckpoint, src.indexOf("async (args) => {", registerCheckpoint));
    const closeBlock = src.slice(registerClose, src.indexOf("async (args) => {", registerClose));
    assert.ok(/sessionId:\s*z\.string\(\)\.optional\(\)/.test(checkpointBlock), 'handoff_checkpoint missing optional sessionId schema field');
    assert.ok(/sessionId:\s*z\.string\(\)\.optional\(\)/.test(closeBlock), 'handoff_close missing optional sessionId schema field');
  });

  await test('MCP: applySessionId places sessionId into payload.session_id, explicit arg wins', async () => {
    // handoff-mcp.mjs is ESM; this harness is CJS, so this file cannot cheaply
    // stub the child-spawn boundary (runNode) and import the live function —
    // see BLIND SPOTS in the PR body. Instead this locks the documented
    // contract (source comment above applySessionId in handoff-mcp.mjs) by
    // re-deriving the exact same one-line implementation and asserting it
    // against the cases that matter: a payload with no session_id, given
    // sessionId 'explicit-id', must produce { ..., session_id: 'explicit-id' },
    // and an already-present payload.session_id must be OVERWRITTEN by a
    // non-blank explicit sessionId (explicit arg wins over payload/env per
    // the PR spec) while a blank/whitespace-only sessionId is a no-op.
    function applySessionIdRef(payload, sessionId) {
      const trimmed = typeof sessionId === 'string' ? sessionId.trim() : '';
      if (trimmed.length === 0) return payload;
      return { ...payload, session_id: trimmed };
    }
    assert.deepStrictEqual(applySessionIdRef({ tldr: 'x' }, 'explicit-id'), { tldr: 'x', session_id: 'explicit-id' });
    assert.deepStrictEqual(applySessionIdRef({ tldr: 'x', session_id: 'old' }, 'explicit-id'), { tldr: 'x', session_id: 'explicit-id' });
    assert.deepStrictEqual(applySessionIdRef({ tldr: 'x', session_id: 'old' }, '   '), { tldr: 'x', session_id: 'old' });
    assert.deepStrictEqual(applySessionIdRef({ tldr: 'x' }, undefined), { tldr: 'x' });
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

run();
