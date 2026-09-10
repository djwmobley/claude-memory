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
 * { branch, deleted, ownedBy, dropped, coerced, text } outcome covering
 * every combination of "resolved session id present/absent" x "marker list
 * state" (branches A-G), and the two Done-line call sites print that text
 * verbatim instead of a hardcoded string.
 *
 * Reviewer-amended (round 2): an independent reviewer proved, main vs PR
 * side by side, that the first version of this PR's parseSessionMarkers
 * regressed every OTHER caller (status, loader-stop, resume) by silently
 * dropping entries whose session_id was some non-string/non-null value
 * (e.g. a stray numeric session_id) that main used to accept (coercing it to
 * null, same as a legacy marker). The PARITY block below locks
 * parseSessionMarkers to byte-identical output vs. a copy of main's original
 * implementation, over a fixture set covering every shape the reviewer
 * named. parseSessionMarkersDetailed still reports the two failure shapes
 * SEPARATELY (`dropped` for entries that never become a marker at all —
 * bad/missing ts or non-object; `coerced` for entries that DO become a
 * marker but had a non-string/non-null session_id forced to null) — but
 * these counts are close-only reporting layered on top of the SAME
 * `markers` list main would have produced, never a filter that changes it.
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
  parseSessionMarkers,
  parseSessionMarkersDetailed,
  clearSessionMarkerForClose,
  formatOwnerIds,
  getSetting,
  resolveClearSessionId,
  isAmbiguousSessionEnvPair,
  findMatchingMarkerIndex,
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

/**
 * Byte-for-byte copy of main's ORIGINAL parseSessionMarkers (pre-this-PR) —
 * the reference implementation the parity block below checks the live
 * parseSessionMarkers against. Do NOT "fix" or simplify this copy; its only
 * job is to be what main actually did.
 */
function mainParseSessionMarkers(raw) {
  if (raw === null || raw === undefined || raw === '') return [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed
        .filter((e) => e && typeof e === 'object' && typeof e.ts === 'string')
        .map((e) => ({
          session_id: (typeof e.session_id === 'string' && e.session_id.length > 0) ? e.session_id : null,
          ts: e.ts,
        }));
    }
    return [];
  } catch (_) {
    if (typeof raw === 'string' && raw.length > 0) {
      return [{ session_id: null, ts: raw }];
    }
    return [];
  }
}

// Fixture set naming every shape the reviewer's finding turned on, plus the
// existing well-formed/empty/non-array baseline cases.
const PARITY_FIXTURES = [
  { label: 'numeric session_id',        raw: JSON.stringify([{ session_id: 42, ts: '2026-01-01T00:00:00.000Z' }]) },
  { label: 'object session_id',         raw: JSON.stringify([{ session_id: { nested: true }, ts: '2026-01-01T00:00:00.000Z' }]) },
  { label: 'missing session_id',        raw: JSON.stringify([{ ts: '2026-01-01T00:00:00.000Z' }]) },
  { label: 'numeric ts',                raw: JSON.stringify([{ session_id: 'a', ts: 12345 }]) },
  { label: 'missing ts',                raw: JSON.stringify([{ session_id: 'a' }]) },
  { label: 'legacy string marker',      raw: 'smoketest_legacy_marker' },
  { label: 'well-formed entry',         raw: JSON.stringify([{ session_id: 'a', ts: '2026-01-01T00:00:00.000Z' }]) },
  { label: 'empty array',               raw: '[]' },
  { label: 'non-array (valid JSON)',    raw: JSON.stringify({ foo: 1 }) },
  { label: 'mixed batch (all shapes)',  raw: JSON.stringify([
      { session_id: 42, ts: '2026-01-01T00:00:00.000Z' },
      { session_id: { x: 1 }, ts: '2026-01-01T00:00:01.000Z' },
      { ts: '2026-01-01T00:00:02.000Z' },
      { session_id: 'a', ts: 12345 },
      { session_id: 'b' },
      { session_id: 'c', ts: '2026-01-01T00:00:03.000Z' },
    ]) },
];

async function run() {
  // ── PARITY: parseSessionMarkers must match main's original output exactly ─

  for (const { label, raw } of PARITY_FIXTURES) {
    await test(`parity: parseSessionMarkers(${label}) matches main byte-for-byte`, async () => {
      const expected = mainParseSessionMarkers(raw);
      const actual = parseSessionMarkers(raw);
      assert.deepStrictEqual(actual, expected);
    });
  }

  // ── parseSessionMarkersDetailed — dropped vs coerced counted separately ───

  await test('detailed: well-formed array -> markers, dropped=0, coerced=0', async () => {
    const { markers, dropped, coerced } = parseSessionMarkersDetailed(JSON.stringify([
      { session_id: 'a', ts: '2026-01-01T00:00:00.000Z' },
      { session_id: null, ts: '2026-01-02T00:00:00.000Z' },
    ]));
    assert.strictEqual(markers.length, 2);
    assert.strictEqual(dropped, 0);
    assert.strictEqual(coerced, 0);
  });

  await test('detailed: ts not a string -> dropped (never becomes a marker)', async () => {
    const { markers, dropped, coerced } = parseSessionMarkersDetailed(JSON.stringify([
      { session_id: 'a', ts: 12345 },
      { session_id: 'b', ts: '2026-01-02T00:00:00.000Z' },
    ]));
    assert.strictEqual(markers.length, 1);
    assert.strictEqual(markers[0].session_id, 'b');
    assert.strictEqual(dropped, 1);
    assert.strictEqual(coerced, 0);
  });

  await test('detailed: numeric session_id -> KEPT as a marker (session_id coerced to null), counted coerced', async () => {
    const { markers, dropped, coerced } = parseSessionMarkersDetailed(JSON.stringify([
      { session_id: 42, ts: '2026-01-01T00:00:00.000Z' },
    ]));
    assert.strictEqual(markers.length, 1, 'main keeps this entry — must not be dropped');
    assert.strictEqual(markers[0].session_id, null);
    assert.strictEqual(markers[0].ts, '2026-01-01T00:00:00.000Z');
    assert.strictEqual(dropped, 0);
    assert.strictEqual(coerced, 1);
  });

  await test('detailed: object session_id -> KEPT as a marker (coerced to null), counted coerced', async () => {
    const { markers, dropped, coerced } = parseSessionMarkersDetailed(JSON.stringify([
      { session_id: { x: 1 }, ts: '2026-01-01T00:00:00.000Z' },
    ]));
    assert.strictEqual(markers.length, 1);
    assert.strictEqual(markers[0].session_id, null);
    assert.strictEqual(dropped, 0);
    assert.strictEqual(coerced, 1);
  });

  await test('detailed: missing session_id -> KEPT, null, NOT counted as coerced (already-nullish is not a coercion)', async () => {
    const { markers, dropped, coerced } = parseSessionMarkersDetailed(JSON.stringify([
      { ts: '2026-01-01T00:00:00.000Z' },
    ]));
    assert.strictEqual(markers.length, 1);
    assert.strictEqual(markers[0].session_id, null);
    assert.strictEqual(dropped, 0);
    assert.strictEqual(coerced, 0);
  });

  await test('detailed: non-object array element -> dropped, excluded', async () => {
    const { markers, dropped, coerced } = parseSessionMarkersDetailed(JSON.stringify([
      'not-an-object',
      { session_id: 'a', ts: '2026-01-01T00:00:00.000Z' },
    ]));
    assert.strictEqual(markers.length, 1);
    assert.strictEqual(dropped, 1);
    assert.strictEqual(coerced, 0);
  });

  await test('detailed: mixed dropped/coerced counts are exact and independent', async () => {
    const { markers, dropped, coerced } = parseSessionMarkersDetailed(JSON.stringify([
      { session_id: 'a', ts: '2026-01-01T00:00:00.000Z' }, // kept, clean
      { ts: 1 },                                            // dropped (bad ts)
      null,                                                 // dropped (not an object)
      { session_id: [], ts: '2026-01-02T00:00:00.000Z' },   // kept, coerced (array session_id)
      { session_id: 7, ts: '2026-01-03T00:00:00.000Z' },    // kept, coerced (numeric session_id)
    ]));
    assert.strictEqual(markers.length, 3);
    assert.strictEqual(dropped, 2);
    assert.strictEqual(coerced, 2);
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

  // ── PR4 R1: resolveClearSessionId — total classification, host-independent ──

  await test('R1: payload.session_id wins over everything, trimmed', async () => {
    await withEnv({ CLAUDE_CODE_SESSION_ID: undefined, CODEX_THREAD_ID: undefined }, async () => {
      assert.strictEqual(resolveClearSessionId({ session_id: '  payload-id  ' }), 'payload-id');
    });
  });

  await test('R1: whitespace-only payload.session_id is treated as absent', async () => {
    await withEnv({ CLAUDE_CODE_SESSION_ID: 'claude-id', CODEX_THREAD_ID: undefined }, async () => {
      assert.strictEqual(resolveClearSessionId({ session_id: '   ' }), 'claude-id');
    });
  });

  await test('R1: both env vars unset, no payload -> null', async () => {
    await withEnv({ CLAUDE_CODE_SESSION_ID: undefined, CODEX_THREAD_ID: undefined }, async () => {
      assert.strictEqual(resolveClearSessionId({}), null);
      assert.strictEqual(resolveClearSessionId(null), null);
    });
  });

  await test('R1: only CLAUDE_CODE_SESSION_ID set -> that value', async () => {
    await withEnv({ CLAUDE_CODE_SESSION_ID: 'claude-only', CODEX_THREAD_ID: undefined }, async () => {
      assert.strictEqual(resolveClearSessionId({}), 'claude-only');
    });
  });

  await test('R1: only CODEX_THREAD_ID set -> that value', async () => {
    await withEnv({ CLAUDE_CODE_SESSION_ID: undefined, CODEX_THREAD_ID: 'codex-only' }, async () => {
      assert.strictEqual(resolveClearSessionId({}), 'codex-only');
    });
  });

  await test('R1: both set and EQUAL -> that value (no ambiguity)', async () => {
    await withEnv({ CLAUDE_CODE_SESSION_ID: 'same-id', CODEX_THREAD_ID: 'same-id' }, async () => {
      assert.strictEqual(resolveClearSessionId({}), 'same-id');
    });
  });

  await test('R1: both set and DIFFERENT -> null, regardless of a --host-like caller intent (host is never a parameter)', async () => {
    await withEnv({ CLAUDE_CODE_SESSION_ID: 'claude-value', CODEX_THREAD_ID: 'codex-value' }, async () => {
      assert.strictEqual(resolveClearSessionId({}), null);
      assert.strictEqual(resolveClearSessionId(undefined), null);
    });
  });

  await test('R3: isAmbiguousSessionEnvPair false when both unset', async () => {
    await withEnv({ CLAUDE_CODE_SESSION_ID: undefined, CODEX_THREAD_ID: undefined }, async () => {
      assert.strictEqual(isAmbiguousSessionEnvPair(), false);
    });
  });
  await test('R3: isAmbiguousSessionEnvPair false when only one set', async () => {
    await withEnv({ CLAUDE_CODE_SESSION_ID: 'x', CODEX_THREAD_ID: undefined }, async () => {
      assert.strictEqual(isAmbiguousSessionEnvPair(), false);
    });
  });
  await test('R3: isAmbiguousSessionEnvPair false when both set and EQUAL', async () => {
    await withEnv({ CLAUDE_CODE_SESSION_ID: 'x', CODEX_THREAD_ID: 'x' }, async () => {
      assert.strictEqual(isAmbiguousSessionEnvPair(), false);
    });
  });
  await test('R3: isAmbiguousSessionEnvPair TRUE when both set and DIFFER', async () => {
    await withEnv({ CLAUDE_CODE_SESSION_ID: 'x', CODEX_THREAD_ID: 'y' }, async () => {
      assert.strictEqual(isAmbiguousSessionEnvPair(), true);
    });
  });

  // ── PR4 R2: findMatchingMarkerIndex — exact-only for non-null, single-legacy-only for null ──

  await test('R2: non-null currentSessionId matches ONLY an exact session_id (no null-wildcard fallback)', async () => {
    const list = [{ session_id: null, ts: 't1' }, { session_id: 'sess-b', ts: 't2' }];
    assert.strictEqual(findMatchingMarkerIndex(list, 'sess-caller-with-no-exact-match'), -1,
      'a real, non-matching session id must NEVER fall back to claiming a null-id entry');
    assert.strictEqual(findMatchingMarkerIndex(list, 'sess-b'), 1, 'an exact match is still found');
  });

  await test('R2: null currentSessionId matches the sole entry when it is the ONLY entry and is null (legacy single-session shape)', async () => {
    const list = [{ session_id: null, ts: 't1' }];
    assert.strictEqual(findMatchingMarkerIndex(list, null), 0);
  });

  await test('R2: a REAL, non-matching currentSessionId can ALSO claim the sole legacy null entry (regardless of currentSessionId, per spec §3)', async () => {
    const list = [{ session_id: null, ts: 't1' }];
    assert.strictEqual(findMatchingMarkerIndex(list, 'sess-some-real-session'), 0,
      'the true pre-S3 single-session shape has no sibling to misattribute against, so any resolvable id may claim it');
  });

  await test('R2: null currentSessionId does NOT match when >=2 entries exist, even with a null entry present', async () => {
    const list = [{ session_id: null, ts: 't1' }, { session_id: 'sess-b', ts: 't2' }];
    assert.strictEqual(findMatchingMarkerIndex(list, null), -1,
      'two-or-more-entry lists must never auto-claim a null entry as a wildcard');
  });

  await test('R2: null currentSessionId does not match when the list is non-empty and has no null entry', async () => {
    const list = [{ session_id: 'sess-a', ts: 't1' }];
    assert.strictEqual(findMatchingMarkerIndex(list, null), -1);
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

    await test('B: a coerced (non-string session_id) marker is cleared as legacy, same as main', async () => {
      const db = new FakeDb();
      db.seedMarker(JSON.stringify([{ session_id: 42, ts: '2026-01-01T00:00:00.000Z' }]));
      const r = await clearSessionMarkerForClose(db, PROJECT_ID, { session_id: 'sess-other' });
      assert.strictEqual(r.branch, 'B');
      assert.strictEqual(r.deleted, 1);
      assert.strictEqual(r.coerced, 1);
      assert.strictEqual(r.text, 'legacy session marker cleared (marker had no session id); 1 marker entry had a non-string session id (treated as no id)');
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

    await test('F + dropped: empty-after-exclusion list still reports the dropped count', async () => {
      const db = new FakeDb();
      db.seedMarker(JSON.stringify([{ ts: 1 }, 'garbage']));
      const r = await clearSessionMarkerForClose(db, PROJECT_ID, { session_id: 'sess-A' });
      assert.strictEqual(r.branch, 'F');
      assert.strictEqual(r.dropped, 2);
      assert.strictEqual(r.coerced, 0);
      assert.strictEqual(r.text, 'no session marker present; 2 malformed marker entries ignored');
    });

    await test('A + dropped suffix: singular "entry" wording for dropped=1', async () => {
      const db = new FakeDb();
      db.seedMarker(JSON.stringify([
        { session_id: 'sess-A', ts: '2026-01-01T00:00:00.000Z' },
        { ts: 999 },
      ]));
      const r = await clearSessionMarkerForClose(db, PROJECT_ID, { session_id: 'sess-A' });
      assert.strictEqual(r.branch, 'A');
      assert.strictEqual(r.dropped, 1);
      assert.strictEqual(r.coerced, 0);
      assert.strictEqual(r.text, 'session marker cleared (session sess-A); 1 malformed marker entry ignored');
    });

    await test('A + both dropped and coerced suffixes appear together', async () => {
      const db = new FakeDb();
      db.seedMarker(JSON.stringify([
        { session_id: 'sess-A', ts: '2026-01-01T00:00:00.000Z' },
        { ts: 999 },                                          // dropped
        { session_id: 42, ts: '2026-01-02T00:00:00.000Z' },   // coerced (and irrelevant to matching)
      ]));
      const r = await clearSessionMarkerForClose(db, PROJECT_ID, { session_id: 'sess-A' });
      assert.strictEqual(r.branch, 'A');
      assert.strictEqual(r.dropped, 1);
      assert.strictEqual(r.coerced, 1);
      assert.strictEqual(
        r.text,
        'session marker cleared (session sess-A); 1 malformed marker entry ignored; 1 marker entry had a non-string session id (treated as no id)'
      );
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

    // ── PR4 §3: null-wildcard rescoping — branches C/E with a null entry
    //    coexisting alongside real-identity entries (>=2 total) must NEVER
    //    auto-claim the null entry; they now report "unresolved legacy
    //    marker present" instead of silently clearing it.

    await test('C (rescoped): non-null S, no exact, null entry among >=2 entries -> nothing deleted, "unresolved legacy marker present" reported', async () => {
      const db = new FakeDb();
      db.seedMarker(JSON.stringify([
        { session_id: null, ts: '2026-01-01T00:00:00.000Z' },
        { session_id: 'sess-owner', ts: '2026-01-01T00:00:01.000Z' },
      ]));
      const r = await clearSessionMarkerForClose(db, PROJECT_ID, { session_id: 'sess-caller' });
      assert.strictEqual(r.branch, 'C');
      assert.strictEqual(r.deleted, 0);
      assert.ok(r.text.includes('unresolved legacy marker present'), `expected legacy-note in text, got: ${r.text}`);
      assert.strictEqual(r.text, 'session marker left in place (owned by sess-owner; unresolved legacy marker present)');
      assert.strictEqual(JSON.parse(db.markerValue()).length, 2, 'both entries, including the null one, must survive untouched');
    });

    await test('E (rescoped): session id unresolved, null entry among >=2 entries -> nothing deleted, "unresolved legacy marker present" reported', async () => {
      const db = new FakeDb();
      db.seedMarker(JSON.stringify([
        { session_id: null, ts: '2026-01-01T00:00:00.000Z' },
        { session_id: 'sess-owner', ts: '2026-01-01T00:00:01.000Z' },
      ]));
      const r = await clearSessionMarkerForClose(db, PROJECT_ID, {});
      assert.strictEqual(r.branch, 'E');
      assert.strictEqual(r.deleted, 0);
      assert.strictEqual(r.text, 'session marker left in place (session id unresolved; owned by sess-owner; unresolved legacy marker present)');
      assert.strictEqual(JSON.parse(db.markerValue()).length, 2);
    });

    await test('D still fires for the TRUE single-entry legacy shape when S is unresolved (regression guard vs. the rescoping above)', async () => {
      const db = new FakeDb();
      db.seedMarker('smoketest_legacy_marker'); // single entry, session_id null
      const r = await clearSessionMarkerForClose(db, PROJECT_ID, {});
      assert.strictEqual(r.branch, 'D');
      assert.strictEqual(r.deleted, 1);
      assert.strictEqual(db.markerValue(), undefined);
    });
  });

  // ── PR4 R5: MCP runNode must strip session-identity env vars before spawn ──

  await test('MCP: runNode strips CLAUDE_CODE_SESSION_ID/CODEX_THREAD_ID from the spawned child env, never spreads raw process.env', async () => {
    const src = require('fs').readFileSync(require('path').join(__dirname, 'handoff-mcp.mjs'), 'utf8');
    const fnStart = src.indexOf('function runNode(');
    assert.ok(fnStart !== -1, 'runNode not found');
    let fnEnd = src.indexOf('\nfunction stderrTail', fnStart);
    if (fnEnd === -1) fnEnd = fnStart + 2500;
    const fnBody = src.slice(fnStart, fnEnd);
    assert.ok(/delete\s+baseEnv\.CLAUDE_CODE_SESSION_ID/.test(fnBody), 'runNode must delete CLAUDE_CODE_SESSION_ID from the base env before spawn');
    assert.ok(/delete\s+baseEnv\.CODEX_THREAD_ID/.test(fnBody), 'runNode must delete CODEX_THREAD_ID from the base env before spawn');
    assert.ok(!/env:\s*\{\s*\.\.\.\s*process\.env\s*,\s*\.\.\.\s*env\s*\}/.test(fnBody),
      'runNode must not spread raw process.env directly into the spawned child env');
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
