'use strict';

/**
 * test-session-identity.js — unit coverage for scripts/lib/session-identity.js
 * directly (no subprocess, no handoff.js indirection), mirroring the SID1-11
 * fixtures in scripts/test-loader-stop-gate.js (which cover the SAME function
 * re-exported through handoff.js after the lift into this shared module).
 * Kept in a separate file so the shared module has its own direct test, per
 * the fix/mcp-usage-codex-identity PR task — test-loader-stop-gate.js's
 * SID1-11 continue to cover the handoff.js re-export unchanged.
 *
 * CodeQL js/clear-text-logging (alerts #21, #22): the resolved session id
 * (`r` below) is derived from process.env.CLAUDE_CODE_SESSION_ID /
 * process.env.CODEX_THREAD_ID. No string built from `r` — by comparison,
 * length, type inspection, or any other operation — may ever reach a
 * logging sink. check() takes only a pre-computed boolean (the comparison
 * result itself) plus a fixed literal label; it never logs `r`, a
 * description of `r`, or any interpolation of either.
 *
 * Usage: node scripts/test-session-identity.js
 * Exit codes: 0 = all pass, 1 = any failure.
 */

const assert = require('node:assert');
const fs     = require('node:fs');
const os     = require('node:os');
const path   = require('node:path');
const {
  resolveSessionIdFromEnv,
  resolveSessionIdFromMarker,
  resolveUsageRecordMarkerDefault,
} = require('./lib/session-identity');
const pgHelpers = require('./lib/test-pg-helpers.js');

let passed = 0;
let failed = 0;

/** label must be a literal string; condition must be a boolean computed by comparison. */
function check(label, condition) {
  try {
    assert.ok(condition, label);
    console.log(`PASS  ${label}`);
    passed++;
  } catch {
    console.log(`FAIL  ${label}`);
    failed++;
  }
}

/** process.env.X = undefined coerces to the literal string "undefined" — always delete instead. */
function restoreEnvVar(key, savedValue) {
  if (savedValue === undefined) delete process.env[key];
  else process.env[key] = savedValue;
}

function withEnv(vars, fn) {
  const saved = {};
  for (const k of Object.keys(vars)) saved[k] = process.env[k];
  for (const k of Object.keys(vars)) {
    if (vars[k] === undefined) delete process.env[k];
    else process.env[k] = vars[k];
  }
  try { fn(); } finally { for (const k of Object.keys(vars)) restoreEnvVar(k, saved[k]); }
}

withEnv({ CLAUDE_CODE_SESSION_ID: undefined, CODEX_THREAD_ID: undefined }, () => {
  const r = resolveSessionIdFromEnv(null);
  check('SI1: neither CLAUDE_CODE_SESSION_ID nor CODEX_THREAD_ID set -> null', r === null);
});

withEnv({ CLAUDE_CODE_SESSION_ID: 'claude-sess-1', CODEX_THREAD_ID: undefined }, () => {
  const r = resolveSessionIdFromEnv(null);
  check('SI2: only CLAUDE_CODE_SESSION_ID set -> that value', r === 'claude-sess-1');
});

withEnv({ CLAUDE_CODE_SESSION_ID: undefined, CODEX_THREAD_ID: '01a0884c-306e-7182-851c-74d81482720b' }, () => {
  const r = resolveSessionIdFromEnv(null);
  check('SI3: only CODEX_THREAD_ID set -> that value', r === '01a0884c-306e-7182-851c-74d81482720b');
});

withEnv({ CLAUDE_CODE_SESSION_ID: 'same-id', CODEX_THREAD_ID: 'same-id' }, () => {
  const r = resolveSessionIdFromEnv('codex');
  check('SI4: both set and EQUAL -> that value, no ambiguity', r === 'same-id');
});

withEnv({ CLAUDE_CODE_SESSION_ID: 'claude-sess', CODEX_THREAD_ID: 'codex-thread' }, () => {
  const r = resolveSessionIdFromEnv('codex');
  check("SI5: both set, DIFFERENT, host='codex' -> CODEX_THREAD_ID", r === 'codex-thread');
});

withEnv({ CLAUDE_CODE_SESSION_ID: 'claude-sess', CODEX_THREAD_ID: 'codex-thread' }, () => {
  const r = resolveSessionIdFromEnv('claude');
  check("SI6: both set, DIFFERENT, host='claude' -> CLAUDE_CODE_SESSION_ID", r === 'claude-sess');
});

withEnv({ CLAUDE_CODE_SESSION_ID: 'claude-sess', CODEX_THREAD_ID: 'codex-thread' }, () => {
  const r = resolveSessionIdFromEnv(null);
  check('SI7: both set, DIFFERENT, host absent/null -> CLAUDE_CODE_SESSION_ID (default)', r === 'claude-sess');
});

withEnv({ CLAUDE_CODE_SESSION_ID: '   ', CODEX_THREAD_ID: 'codex-thread-2' }, () => {
  const r = resolveSessionIdFromEnv(null);
  check('SI8: a whitespace-only CLAUDE_CODE_SESSION_ID is trimmed to absent, falls through to CODEX_THREAD_ID', r === 'codex-thread-2');
});

withEnv({ CLAUDE_CODE_SESSION_ID: '  claude-sess-padded  ', CODEX_THREAD_ID: undefined }, () => {
  const r = resolveSessionIdFromEnv(null);
  check('SI9: a padded CLAUDE_CODE_SESSION_ID value is trimmed before being returned', r === 'claude-sess-padded');
});

/** Save/restore a set of env vars around an ASYNC fn (withEnv above is sync-only). */
async function withEnvAsync(vars, fn) {
  const saved = {};
  for (const k of Object.keys(vars)) saved[k] = process.env[k];
  for (const k of Object.keys(vars)) {
    if (vars[k] === undefined) delete process.env[k];
    else process.env[k] = vars[k];
  }
  try {
    await fn();
  } finally {
    for (const k of Object.keys(vars)) restoreEnvVar(k, saved[k]);
  }
}

/**
 * SIM1-4: resolveSessionIdFromMarker (fix/usage-record-marker-fallback)
 * against a real throwaway Postgres DB (name test_*, dropped in `finally`)
 * -- the marker read is a real project_settings row, not a FakeDb stub,
 * because this is the exact query both handoff.js's resolveSessionId and
 * scripts/handoff-mcp.mjs's usage_record default now share.
 *
 * SIM3/SIM4 exercise the SAME composed precedence order (explicit -> env ->
 * marker) both real call sites use -- resolveSessionIdFromMarker itself has
 * no opinion about explicit/env, so these two cases replicate the calling
 * convention inline rather than asserting on session-identity.js exports
 * that don't exist (there is no single "resolveSessionId" export here by
 * design -- see this module's header comment).
 *
 * CodeQL js/clear-text-logging: same discipline as SI1-9 above -- check()
 * takes only a pre-computed boolean; no marker/session id value, or any
 * string built from one, ever reaches console.log/console.error below.
 */
async function runMarkerFallbackTests() {
  const stamp = Date.now();
  const dbName = `test_session_identity_marker_${stamp}`;
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-identity-marker-'));
  let db = null;
  try {
    await pgHelpers.createTestDb(dbName, projectDir);
    const projectId = await pgHelpers.setupProject(dbName, projectDir);
    db = await pgHelpers.pgConnect(dbName);

    // (a) no env ids, one marker present -> resolves to its session_id.
    await pgHelpers.setSetting(
      db, projectId, 'session_in_progress',
      JSON.stringify([{ session_id: 'marker-sess-sim1', ts: new Date().toISOString() }])
    );
    {
      const r = await resolveSessionIdFromMarker(db, projectId);
      check('SIM1: no env ids, one project session marker present -> resolves to its session_id', r === 'marker-sess-sim1');
    }

    // (b) no env, no marker -> null. The real caller (handoff-mcp.mjs's
    // toolUsageRecord) turns this null into its actionable error, whose
    // literal text ("... and no project session marker (session_in_
    // progress) was found -- pass sessionId explicitly.") is pinned by
    // scripts/handoff-mcp-selftest.mjs's UT-G / this PR's own review, not
    // re-asserted here against a self-referential literal.
    await db.query(
      `DELETE FROM project_settings WHERE project_id = $1 AND key = 'session_in_progress'`,
      [projectId]
    );
    {
      const r = await resolveSessionIdFromMarker(db, projectId);
      check('SIM2: no env, no marker -> resolves to null (the caller turns this into its "no marker" error)', r === null);
    }

    // (c) env id present -> env wins over the marker, even though a marker
    // exists (composed precedence: explicit -> env -> marker).
    await pgHelpers.setSetting(
      db, projectId, 'session_in_progress',
      JSON.stringify([{ session_id: 'marker-sess-sim3', ts: new Date().toISOString() }])
    );
    await withEnvAsync({ CLAUDE_CODE_SESSION_ID: 'env-sess-sim3', CODEX_THREAD_ID: undefined }, async () => {
      const envId = resolveSessionIdFromEnv(null);
      const resolved = envId || await resolveSessionIdFromMarker(db, projectId);
      check('SIM3: env id present -> composed precedence resolves to the env id, never the marker', resolved === 'env-sess-sim3');
    });

    // (d) explicit sessionId wins over both env and marker.
    await withEnvAsync({ CLAUDE_CODE_SESSION_ID: 'env-sess-sim4', CODEX_THREAD_ID: undefined }, async () => {
      const explicitSessionId = 'explicit-sess-sim4';
      const resolved =
        explicitSessionId ||
        resolveSessionIdFromEnv(null) ||
        await resolveSessionIdFromMarker(db, projectId);
      check('SIM4: an explicit sessionId short-circuits before env or marker are ever consulted', resolved === 'explicit-sess-sim4');
    });

    // ── SIU1-5: resolveUsageRecordMarkerDefault (Codex review C1/C2,
    // fix/usage-record-marker-fallback follow-up) — the strict, usage_record-
    // ONLY marker default. Distinct function from resolveSessionIdFromMarker
    // above; these cases exercise exactly the total classification C1/C2
    // describe. Same CodeQL js/clear-text-logging discipline as SIM1-4 —
    // check() below takes only pre-computed booleans, never a marker/session
    // id value itself.

    // (SIU1) exactly one marker, no HANDOFF_HOST -> used verbatim, no error.
    await pgHelpers.setSetting(
      db, projectId, 'session_in_progress',
      JSON.stringify([{ session_id: 'marker-sess-siu1', ts: new Date().toISOString(), host: 'claude' }])
    );
    {
      const r = await resolveUsageRecordMarkerDefault(db, projectId, null);
      check('SIU1: exactly one marker, HANDOFF_HOST unset -> used, no error', r.error === null && r.sessionId === 'marker-sess-siu1');
    }

    // (SIU2) two markers for the same project (neither host matches, or
    // HANDOFF_HOST unset) -> ambiguous error, never a fabricated pick.
    await pgHelpers.setSetting(
      db, projectId, 'session_in_progress',
      JSON.stringify([
        { session_id: 'marker-sess-siu2a', ts: new Date().toISOString(), host: 'claude' },
        { session_id: 'marker-sess-siu2b', ts: new Date().toISOString(), host: 'codex' },
      ])
    );
    {
      const r = await resolveUsageRecordMarkerDefault(db, projectId, null);
      check(
        'SIU2: two markers, same project, HANDOFF_HOST unset -> ambiguous error, no sessionId',
        r.sessionId === null && typeof r.error === 'string' && r.error.includes('ambiguous session markers (2)')
      );
    }

    // (SIU3) a host-tagged marker that does NOT match HANDOFF_HOST=codex is
    // excluded from candidacy -> zero candidates -> the "no marker" error
    // (never silently accepted as a stale/cross-host marker — the C1 bug).
    await pgHelpers.setSetting(
      db, projectId, 'session_in_progress',
      JSON.stringify([{ session_id: 'marker-sess-siu3', ts: new Date().toISOString(), host: 'claude' }])
    );
    {
      const r = await resolveUsageRecordMarkerDefault(db, projectId, 'codex');
      check(
        'SIU3: host-tagged marker (host=claude) mismatches HANDOFF_HOST=codex -> excluded, "no marker" error',
        r.sessionId === null && typeof r.error === 'string' && r.error.includes('no project session marker')
      );
    }

    // (SIU4) malformed (non-JSON) raw marker value -> excluded by the strict
    // parser, never legacy-parsed as a bare-string marker (C2) -> zero
    // candidates -> the same "no marker" error as an absent marker.
    await pgHelpers.setSetting(db, projectId, 'session_in_progress', 'not-valid-json-{{{');
    {
      const r = await resolveUsageRecordMarkerDefault(db, projectId, null);
      check(
        'SIU4: malformed (non-JSON) marker value is excluded -> "no marker" error, never legacy-parsed',
        r.sessionId === null && typeof r.error === 'string' && r.error.includes('no project session marker')
      );
    }

    // (SIU5) exactly one candidate, but its session_id is whitespace-only ->
    // the marker-derived id fails the same trim/non-empty validation an
    // explicit sessionId would (C2) -> actionable error, never a blank id.
    await pgHelpers.setSetting(
      db, projectId, 'session_in_progress',
      JSON.stringify([{ session_id: '   ', ts: new Date().toISOString(), host: 'claude' }])
    );
    {
      const r = await resolveUsageRecordMarkerDefault(db, projectId, null);
      check(
        'SIU5: whitespace-only session_id marker (sole candidate) -> actionable error, never a blank sessionId',
        r.sessionId === null && typeof r.error === 'string' && r.error.length > 0
      );
    }

    // Clear the marker so it never leaks past this test file's own DB fixture.
    await db.query(
      `DELETE FROM project_settings WHERE project_id = $1 AND key = 'session_in_progress'`,
      [projectId]
    );
  } finally {
    if (db) {
      try { await db.end(); } catch (_) { /* best-effort */ }
    }
    await pgHelpers.dropTestDb(dbName, projectDir);
  }
}

runMarkerFallbackTests()
  .catch((err) => {
    check('SIM-setup: marker fallback DB fixture ran without throwing', false);
    console.error(`test-session-identity.js: marker fallback tests threw: ${err && err.message ? err.message : String(err)}`);
  })
  .then(() => {
    console.log('');
    console.log(`Results: ${passed} passed, ${failed} failed`);
    process.exit(failed > 0 ? 1 : 0);
  });
