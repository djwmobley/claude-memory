'use strict';

/**
 * test-close-session-identity.js — cm#295 regression guard: "Explicit MCP
 * close leaves the SessionStart marker in place after /clear: session-id
 * split between hooks and the MCP server -> spurious implicit_close_recorded".
 *
 * Root cause (see cm#295): the MCP server is a long-lived process that
 * resolves CLAUDE_CODE_SESSION_ID/CODEX_THREAD_ID ONCE at spawn time. Every
 * `/clear` in an interactive host mints a fresh hook-side session id and a
 * fresh session_in_progress marker, but the MCP server's own env never
 * rotates to match — so an explicit close issued through the MCP server
 * after a `/clear` used to fail the exact-equality ownership check, leave
 * the marker in place, and let the next SessionEnd for the stale hook-side
 * id record a spurious implicit_close_recorded.
 *
 * FIX A (scripts/handoff-mcp.mjs toolHandoffClose/toolHandoffCheckpoint via
 * scripts/lib/session-identity.js resolveCloseSessionIdFromMarker): when the
 * MCP caller omits sessionId, resolve it from the project's live
 * session_in_progress marker (host-filtered, EXACTLY ONE candidate) —
 * NEVER from this server process's own env vars.
 *
 * FIX B (scripts/handoff.js clearSessionMarkerForClose): (B1) the
 * last_explicit_close breadcrumb write now shares the same critical section
 * / transaction as the marker delete; (B3) branch C (a resolved session id
 * matching no marker) reports a distinct outcome='no_matching_marker' with
 * the surviving marker count, never a silent deleted:0.
 *
 * Pinned identity semantics (adversary-hardened, memory
 * feedback_adversary_must_pin_identity_semantics.md):
 *   - session id: exact, case-sensitive string equality only.
 *   - host: advisory filter for candidate selection only, never clearing authority.
 *   - ts: Date.parse, NaN fails closed (never satisfies a freshness test).
 *
 * Mirrors test-loader-stop-sessionend.js's setup/teardown/marker-helper
 * conventions (fakeRoot + claude_memory_eval_test), deliberately using raw
 * SQL marker helpers (independent of handoff.js's own marker code) so this
 * suite exercises the ON-DISK CONTRACT, not the implementation against itself.
 *
 * Usage: node test/handoff/test-close-session-identity.js
 * Prerequisites: Postgres running with claude_memory_eval_test (same as
 * test-loader-stop-sessionend.js / test-handoff.js). CLAUDE_CODE_SESSION_ID
 * is stripped from every subprocess env below to avoid the env fallback
 * masking marker-based resolution.
 *
 * Exit codes: 0 all-pass, 1 any failure, 2 infrastructure error.
 */

const assert = require('assert');
const path   = require('path');
const fs     = require('fs');
const os     = require('os');
const { spawnSync } = require('child_process');
const { pathToFileURL } = require('url');

const { loadConfig }           = require('../../scripts/lib/shared');
const { writeMarker }          = require('../../scripts/lib/project-marker');
const { resolveHandoffMdPath } = require('../../scripts/lib/handoff-paths');
const { resolveCloseSessionIdFromMarker, parseSessionMarkersStrict } = require('../../scripts/lib/session-identity.js');
const handoffEngine = require('../../scripts/handoff.js');
const { clearSessionMarkerForClose, connectHandoff } = handoffEngine;
const { createRequire } = require('module');
const scriptsRequire = createRequire(require.resolve('../../scripts/package.json'));
const { Client } = scriptsRequire('pg');

// ─── CONFIG ───────────────────────────────────────────────────────────────

const TARGET_DB = 'claude_memory_eval_test';
const HELPER    = path.resolve(__dirname, '..', '..', 'scripts', 'handoff.js');
const MCP_PATH  = path.resolve(__dirname, '..', '..', 'scripts', 'handoff-mcp.mjs');

let passed = 0;
let failed = 0;

function test(label, fn) {
  return (async () => {
    try {
      await fn();
      console.log(`PASS  ${label}`);
      passed++;
    } catch (err) {
      console.error(`FAIL  ${label}`);
      console.error(`      ${err.message}`);
      failed++;
    }
  })();
}

async function connectDb() {
  const cfg = loadConfig();
  const client = new Client({ host: cfg.host, port: cfg.port, database: TARGET_DB, user: cfg.user });
  await client.connect();
  return client;
}

/** Run a handoff.js hook subcommand as a subprocess, feeding it a JSON stdin payload. */
function runHook(sub, stdinObj, opts = {}) {
  const fakeRoot = opts.fakeRoot || global.__fakeRoot;
  const env = { ...process.env, PROJECT_ROOT: fakeRoot, ...opts.env };
  delete env.CLAUDE_CODE_SESSION_ID;
  delete env.CODEX_THREAD_ID;
  const result = spawnSync(process.execPath, [HELPER, sub, ...(opts.args || [])], {
    cwd: fakeRoot, env, encoding: 'utf8', timeout: 15000,
    input: stdinObj === undefined ? undefined : JSON.stringify(stdinObj),
  });
  return { stdout: result.stdout || '', stderr: result.stderr || '', status: result.status };
}

function runHelper(sub, extraArgs = [], opts = {}) {
  const args = sub === 'init' && !extraArgs.includes('--no-embeddings') ? [...extraArgs, '--no-embeddings'] : extraArgs;
  const fakeRoot = opts.fakeRoot || global.__fakeRoot;
  const env = { ...process.env, PROJECT_ROOT: fakeRoot };
  return spawnSync(process.execPath, [HELPER, sub, ...args], { cwd: fakeRoot, env, encoding: 'utf8', timeout: 30000 }).stdout || '';
}

// ─── SETUP / TEARDOWN ───────────────────────────────────────────────────────

async function setup() {
  const fakeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'close-session-identity-test-'));
  global.__fakeRoot = fakeRoot;

  fs.mkdirSync(path.join(fakeRoot, '.git'));
  fs.mkdirSync(path.join(fakeRoot, '.claude'));
  fs.writeFileSync(
    path.join(fakeRoot, '.claude', 'pipeline.yml'),
    `\nproject:\n  name: close-session-identity-test\n\nknowledge:\n  tier: "postgres"\n  host: "localhost"\n  port: 5432\n  database: "${TARGET_DB}"\n  user: "postgres"\n`.trim(),
    'utf8'
  );

  const marker = writeMarker(fakeRoot);
  global.__projectId = marker.uuid;

  console.log(`\n  fake root:   ${fakeRoot}`);
  console.log(`  marker uuid: ${marker.uuid}`);

  runHelper('init', ['-y'], { fakeRoot });

  return fakeRoot;
}

async function teardown() {
  const fakeRoot  = global.__fakeRoot;
  const projectId = global.__projectId;
  try {
    const db = await connectDb();
    for (const tbl of ['edges', 'assertions', 'entities', 'retrieval_contract', 'project_settings']) {
      await db.query(`DELETE FROM ${tbl} WHERE project_id = $1`, [projectId]);
    }
    await db.end();
  } catch (_) { /* best-effort */ }
  try { fs.rmSync(fakeRoot, { recursive: true, force: true }); } catch (_) {}
  try {
    const dir = path.dirname(resolveHandoffMdPath(projectId));
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  } catch (_) {}
}

// ─── MARKER / SETTING HELPERS (raw SQL — independent of handoff.js's own) ──

async function setMarkerRaw(db, projectId, markers) {
  await db.query(
    `INSERT INTO project_settings (project_id, key, value) VALUES ($1, 'session_in_progress', $2)
     ON CONFLICT (project_id, key) DO UPDATE SET value = EXCLUDED.value`,
    [projectId, JSON.stringify(markers)]
  );
}
async function clearMarkerRaw(db, projectId) {
  await db.query(`DELETE FROM project_settings WHERE project_id = $1 AND key = 'session_in_progress'`, [projectId]);
}
async function getMarkerRaw(db, projectId) {
  const { rows } = await db.query(`SELECT value FROM project_settings WHERE project_id = $1 AND key = 'session_in_progress'`, [projectId]);
  return rows.length > 0 ? JSON.parse(rows[0].value) : null;
}
async function setSettingRaw(db, projectId, key, value) {
  await db.query(
    `INSERT INTO project_settings (project_id, key, value) VALUES ($1, $2, $3)
     ON CONFLICT (project_id, key) DO UPDATE SET value = EXCLUDED.value`,
    [projectId, key, value]
  );
}
async function getSettingRaw(db, projectId, key) {
  const { rows } = await db.query(`SELECT value FROM project_settings WHERE project_id = $1 AND key = $2`, [projectId, key]);
  return rows.length > 0 ? rows[0].value : null;
}
async function clearSettingRaw(db, projectId, key) {
  await db.query(`DELETE FROM project_settings WHERE project_id = $1 AND key = $2`, [projectId, key]);
}
async function getLastLoaderStop(db, projectId) {
  const raw = await getSettingRaw(db, projectId, 'last_loader_stop');
  return raw ? JSON.parse(raw) : null;
}

// ─── TESTS ──────────────────────────────────────────────────────────────────

async function runTests() {
  const fakeRoot   = await setup();
  const db         = await connectDb();
  const projectId  = global.__projectId;

  // clearSessionMarkerForClose needs a port-adapter db handle (it calls
  // db.acquireNamedXactLock, a db-seam.js PostgresAdapter method the raw
  // `pg` Client used for the marker/setting SQL helpers above does not
  // have) — connectHandoff() (handoff.js's own connection path) resolves
  // via process.env.PROJECT_ROOT, briefly set and restored here.
  const priorProjectRoot = process.env.PROJECT_ROOT;
  process.env.PROJECT_ROOT = fakeRoot;
  const engineDb = await connectHandoff();
  if (priorProjectRoot === undefined) delete process.env.PROJECT_ROOT; else process.env.PROJECT_ROOT = priorProjectRoot;

  // dynamic import: handoff-mcp.mjs is ESM; buildServer()'s auto-start is
  // gated on `process.argv[1]` so a plain import here never opens stdio.
  const mcp = await import(pathToFileURL(MCP_PATH).href);

  // Ensure the MCP-layer default resolution never picks up THIS test
  // process's own ambient session/host env — every call below sets
  // HANDOFF_HOST explicitly where relevant and none should ever consult
  // CLAUDE_CODE_SESSION_ID/CODEX_THREAD_ID (that is the whole point of FIX A).
  delete process.env.CLAUDE_CODE_SESSION_ID;
  delete process.env.CODEX_THREAD_ID;
  delete process.env.HANDOFF_HOST;

  // ── (a) marker under hook id X, MCP close with no sessionId, same host ──
  await test('(a) MCP close with no sessionId resolves the project\'s sole marker, clears it, stamps the breadcrumb, and a later SessionEnd for that id records NO implicit close', async () => {
    await clearSettingRaw(db, projectId, 'last_loader_stop');
    await clearSettingRaw(db, projectId, 'last_explicit_close');
    await clearMarkerRaw(db, projectId);
    const X = 'hook-session-X';
    await setMarkerRaw(db, projectId, [{ session_id: X, ts: new Date().toISOString() }]);

    const result = await mcp.toolHandoffClose({
      projectRoot: fakeRoot,
      payload: { tldr: 'cm#295 (a)', entities: [], assertions: [], edges: [] },
      // sessionId omitted deliberately.
    });
    assert.ok(!result.isError, `expected success, got error: ${JSON.stringify(result)}`);
    const parsed = JSON.parse(result.content[0].text);
    assert.strictEqual(parsed.session_id_source, 'marker', `expected marker-sourced id, got: ${JSON.stringify(parsed)}`);

    const markers = await getMarkerRaw(db, projectId);
    assert.ok(markers === null || markers.length === 0, `marker should be cleared, got: ${JSON.stringify(markers)}`);

    const breadcrumb = await getSettingRaw(db, projectId, 'last_explicit_close');
    assert.ok(breadcrumb, 'expected last_explicit_close breadcrumb to be stamped');
    assert.strictEqual(JSON.parse(breadcrumb).session_id, X);

    // The subsequent SessionEnd for X must see explicit_close_present, not
    // implicit_close_recorded — proving cm#295's spurious-implicit-close
    // symptom is closed.
    const r = runHook('loader-stop', { hook_event_name: 'SessionEnd', session_id: X }, { fakeRoot });
    assert.strictEqual(r.status, 0, `expected exit 0, got ${r.status}; stderr: ${r.stderr}`);
    const rec = await getLastLoaderStop(db, projectId);
    assert.strictEqual(rec.outcome, 'explicit_close_present', `got: ${JSON.stringify(rec)}`);
  });

  // ── (b) two host-filtered markers -> refused with count 2 ───────────────
  await test('(b) two host-filtered markers -> MCP close refused naming count 2', async () => {
    await clearMarkerRaw(db, projectId);
    process.env.HANDOFF_HOST = 'codex';
    try {
      await setMarkerRaw(db, projectId, [
        { session_id: 'sess-codex-1', ts: new Date().toISOString(), host: 'codex' },
        { session_id: 'sess-codex-2', ts: new Date().toISOString(), host: 'codex' },
      ]);
      const result = await mcp.toolHandoffClose({
        projectRoot: fakeRoot,
        payload: { tldr: 'cm#295 (b)', entities: [], assertions: [], edges: [] },
      });
      assert.ok(result.isError, 'expected a refusal');
      assert.ok(result.content[0].text.includes('ambiguous session markers (2)'), `expected count-2 message, got: ${result.content[0].text}`);
    } finally {
      delete process.env.HANDOFF_HOST;
    }
    const markers = await getMarkerRaw(db, projectId);
    assert.strictEqual((markers || []).length, 2, 'both markers must survive an unresolved default');
  });

  // ── (c) zero markers -> refused with count 0 ─────────────────────────────
  await test('(c) zero markers -> MCP close refused, candidateCount 0', async () => {
    await clearMarkerRaw(db, projectId);
    const direct = await resolveCloseSessionIdFromMarker(db, projectId, null, 'handoff_close');
    assert.strictEqual(direct.candidateCount, 0);
    assert.ok(direct.error && direct.error.includes('no project session marker'), `got: ${JSON.stringify(direct)}`);

    const result = await mcp.toolHandoffClose({
      projectRoot: fakeRoot,
      payload: { tldr: 'cm#295 (c)', entities: [], assertions: [], edges: [] },
    });
    assert.ok(result.isError, 'expected a refusal');
    assert.ok(result.content[0].text.includes('no project session marker'), `got: ${result.content[0].text}`);
  });

  // ── (d) explicit sessionId matching no marker -> no_matching_marker ─────
  await test('(d) explicit sessionId matching no marker -> outcome=no_matching_marker, marker untouched, no breadcrumb', async () => {
    await clearMarkerRaw(db, projectId);
    await clearSettingRaw(db, projectId, 'last_explicit_close');
    await setMarkerRaw(db, projectId, [{ session_id: 'sess-owner-real', ts: new Date().toISOString() }]);

    const outcome = await clearSessionMarkerForClose(engineDb, projectId, { session_id: 'sess-does-not-exist' });
    assert.strictEqual(outcome.branch, 'C');
    assert.strictEqual(outcome.outcome, 'no_matching_marker', `got: ${JSON.stringify(outcome)}`);
    assert.strictEqual(outcome.deleted, 0);
    assert.ok(outcome.text.includes('1 marker present'), `expected marker count in text, got: ${outcome.text}`);

    const markers = await getMarkerRaw(db, projectId);
    assert.strictEqual((markers || []).length, 1, 'the unrelated marker must survive untouched');
    assert.strictEqual(markers[0].session_id, 'sess-owner-real');

    const breadcrumb = await getSettingRaw(db, projectId, 'last_explicit_close');
    assert.strictEqual(breadcrumb, null, 'no breadcrumb should be stamped when nothing was cleared');
  });

  // ── (e) concurrency: markers A and B, explicit close of A -> only A cleared,
  //        B's later SessionEnd still writes B's implicit close ────────────
  await test('(e) explicit close of A clears only A; B\'s own SessionEnd still runs an implicit close', async () => {
    await clearMarkerRaw(db, projectId);
    await clearSettingRaw(db, projectId, 'last_loader_stop');
    await clearSettingRaw(db, projectId, 'last_explicit_close');
    const A = 'sess-concurrent-A';
    const B = 'sess-concurrent-B';
    await setMarkerRaw(db, projectId, [
      { session_id: A, ts: new Date().toISOString() },
      { session_id: B, ts: new Date().toISOString() },
    ]);

    const outcome = await clearSessionMarkerForClose(engineDb, projectId, { session_id: A });
    assert.strictEqual(outcome.branch, 'A');
    assert.strictEqual(outcome.outcome, 'cleared');
    assert.strictEqual(outcome.deleted, 1);

    const afterA = await getMarkerRaw(db, projectId);
    assert.strictEqual((afterA || []).length, 1, `expected only B to survive, got: ${JSON.stringify(afterA)}`);
    assert.strictEqual(afterA[0].session_id, B);

    const breadcrumb = JSON.parse(await getSettingRaw(db, projectId, 'last_explicit_close'));
    assert.strictEqual(breadcrumb.session_id, A);

    // B's own SessionEnd must still find and clear its OWN marker.
    const r = runHook('loader-stop', { hook_event_name: 'SessionEnd', session_id: B }, { fakeRoot });
    assert.strictEqual(r.status, 0, `expected exit 0, got ${r.status}; stderr: ${r.stderr}`);
    const rec = await getLastLoaderStop(db, projectId);
    assert.strictEqual(rec.outcome, 'implicit_close_recorded', `got: ${JSON.stringify(rec)}`);
    const afterB = await getMarkerRaw(db, projectId);
    assert.ok(afterB === null || afterB.length === 0, `B's marker should now be cleared too, got: ${JSON.stringify(afterB)}`);
  });

  // ── (f) legacy marker with unparseable ts -> never treated as fresh ─────
  await test('(f) legacy marker with an unparseable ts is swept as stale at SessionStart (never treated as fresh)', async () => {
    await clearMarkerRaw(db, projectId);
    await setMarkerRaw(db, projectId, [{ session_id: 'sess-legacy-badts', ts: 'not-a-real-timestamp' }]);

    const r = runHook('loader-hook', { hook_event_name: 'SessionStart', session_id: 'sess-current-f', source: 'startup' }, { fakeRoot });
    assert.strictEqual(r.status, 0, `expected exit 0, got ${r.status}; stderr: ${r.stderr}`);
    let parsed;
    try { parsed = JSON.parse(r.stdout.trim().split('\n').pop()); } catch (e) {
      throw new Error(`loader-hook stdout was not parseable JSON: ${e.message}; stdout: ${r.stdout}`);
    }
    const ctx = parsed.hookSpecificOutput && parsed.hookSpecificOutput.additionalContext || '';
    assert.ok(ctx.includes('DIVERGENCE: late implicit close for session sess-legacy-badts'),
      `an unparseable ts must fail closed (treated as stale, swept) — never survive as "fresh"; got: ${ctx.slice(0, 500)}`);
    const markers = await getMarkerRaw(db, projectId);
    assert.ok(!(markers || []).some((m) => m.session_id === 'sess-legacy-badts'), 'the bad-ts marker must be swept');

    // Direct unit confirmation of the strict-parser classification too: an
    // unparseable ts still SURVIVES parseSessionMarkersStrict as a candidate
    // (ts is a well-formed string; only freshness comparisons are NaN-gated)
    // -- this asserts that surviving is not the same as being treated fresh.
    const { markers: strictMarkers } = parseSessionMarkersStrict(JSON.stringify([{ session_id: null, ts: 'not-a-real-timestamp' }]));
    assert.strictEqual(strictMarkers.length, 1);
    assert.ok(Number.isNaN(Date.parse(strictMarkers[0].ts)), 'sanity: the fixture ts is genuinely unparseable');
  });

  // ── (g) checkpoint without sessionId resolves the same id as close ──────
  await test('(g) MCP checkpoint without sessionId resolves the SAME marker default as close', async () => {
    await clearMarkerRaw(db, projectId);
    const Y = 'hook-session-Y';
    await setMarkerRaw(db, projectId, [{ session_id: Y, ts: new Date().toISOString() }]);

    const result = await mcp.toolHandoffCheckpoint({
      projectRoot: fakeRoot,
      payload: { tldr: 'cm#295 (g)', entities: [], assertions: [], edges: [] },
    });
    assert.ok(!result.isError, `expected success, got error: ${JSON.stringify(result)}`);
    const parsed = JSON.parse(result.content[0].text);
    assert.strictEqual(parsed.session_id_source, 'marker');

    // checkpoint never clears the marker (only close does) -- confirm Y
    // survives, and that a direct call to the shared resolver agrees.
    const markers = await getMarkerRaw(db, projectId);
    assert.ok((markers || []).some((m) => m.session_id === Y), 'checkpoint must not clear the session marker');

    const direct = await resolveCloseSessionIdFromMarker(db, projectId, null, 'handoff_checkpoint');
    assert.strictEqual(direct.sessionId, Y, `expected the shared resolver to agree with checkpoint's own default, got: ${JSON.stringify(direct)}`);
  });

  // ── (h) BLOCKER A round-2 regression: a failing breadcrumb write must
  //        NOT abort the outer Postgres transaction / discard the marker
  //        delete it shares a lock with ────────────────────────────────────
  await test('(h) a failing last_explicit_close write does not abort the marker delete (real SAVEPOINT), reports breadcrumb_written:false', async () => {
    await clearMarkerRaw(db, projectId);
    await clearSettingRaw(db, projectId, 'last_explicit_close');
    const H = 'sess-breadcrumb-fail-h';
    await setMarkerRaw(db, projectId, [{ session_id: H, ts: new Date().toISOString() }]);

    // A thin proxy over the SAME production db-seam adapter connection:
    // query()/acquireNamedXactLock() (BEGIN, the advisory lock, the marker
    // delete, COMMIT -- everything withSessionMarkerLock and the marker
    // delete itself do) pass straight through to the real engineDb.
    // querySafe() -- the ONLY call the breadcrumb write makes -- is
    // redirected to a genuinely-invalid statement so the REAL
    // PostgresAdapter.querySafe SAVEPOINT/ROLLBACK-TO-SAVEPOINT machinery
    // fires a real Postgres error and swallows it, rather than a mocked
    // failure standing in for one.
    const failingDb = {
      query: (...a) => engineDb.query(...a),
      acquireNamedXactLock: (...a) => engineDb.acquireNamedXactLock(...a),
      querySafe: () => engineDb.querySafe('INSERT INTO cm295_round2_nonexistent_table (x) VALUES ($1)', ['x']),
    };

    const outcome = await clearSessionMarkerForClose(failingDb, projectId, { session_id: H });
    assert.strictEqual(outcome.branch, 'A', `got: ${JSON.stringify(outcome)}`);
    assert.strictEqual(outcome.outcome, 'cleared');
    assert.strictEqual(outcome.deleted, 1);
    assert.strictEqual(outcome.breadcrumb_written, false, 'breadcrumb write was forced to fail');

    // The crux of the regression: confirm via a SEPARATE, unrelated
    // connection that the marker delete genuinely committed. Under the old
    // bare try/catch, the failed breadcrumb write would have left Postgres'
    // transaction in the server-side ABORTED state, and the COMMIT issued
    // right after this function returns would have silently discarded the
    // delete along with the failed breadcrumb.
    const markers = await getMarkerRaw(db, projectId);
    assert.ok(markers === null || markers.length === 0,
      `marker delete must have committed despite the breadcrumb failure, got: ${JSON.stringify(markers)}`);

    const breadcrumb = await getSettingRaw(db, projectId, 'last_explicit_close');
    assert.strictEqual(breadcrumb, null, 'no breadcrumb should exist when the write failed');
  });

  // ── (i) happy-path companion to (h): breadcrumb_written:true when the
  //        write actually succeeds ───────────────────────────────────────
  await test('(i) a successful marker clear reports breadcrumb_written:true and stamps last_explicit_close', async () => {
    await clearMarkerRaw(db, projectId);
    await clearSettingRaw(db, projectId, 'last_explicit_close');
    const I = 'sess-breadcrumb-ok-i';
    await setMarkerRaw(db, projectId, [{ session_id: I, ts: new Date().toISOString() }]);

    const outcome = await clearSessionMarkerForClose(engineDb, projectId, { session_id: I });
    assert.strictEqual(outcome.branch, 'A');
    assert.strictEqual(outcome.deleted, 1);
    assert.strictEqual(outcome.breadcrumb_written, true, `got: ${JSON.stringify(outcome)}`);

    const breadcrumb = JSON.parse(await getSettingRaw(db, projectId, 'last_explicit_close'));
    assert.strictEqual(breadcrumb.session_id, I);
  });

  // ── (j) BLOCKER B round-2 regression: a marker with no session_id is
  //        malformed, never promoted to a session id via its ts ──────────
  await test('(j) a marker missing session_id is excluded as malformed; resolver picks the sole well-formed marker, never a ts', async () => {
    await clearMarkerRaw(db, projectId);
    const J = 'sess-wellformed-j';
    await setMarkerRaw(db, projectId, [
      { ts: '2026-09-13T00:00:00.000Z' }, // malformed: no session_id at all
      { session_id: J, ts: new Date().toISOString() },
    ]);

    const result = await resolveCloseSessionIdFromMarker(db, projectId, null, 'handoff_close');
    assert.strictEqual(result.error, null, `expected success, got: ${JSON.stringify(result)}`);
    assert.strictEqual(result.sessionId, J, 'must resolve the well-formed marker, never the malformed one\'s ts');
    assert.strictEqual(result.candidateCount, 1, 'the malformed marker must not count as a candidate');
    assert.strictEqual(result.malformedCount, 1, `got: ${JSON.stringify(result)}`);
    assert.notStrictEqual(result.sessionId, '2026-09-13T00:00:00.000Z', 'sanity: never the malformed ts value');
  });

  // ── (k) only malformed (no session_id) markers present -> refused,
  //        naming malformed_markers in the error text, never a ts fallback ──
  await test('(k) only malformed markers present -> refused, error names malformed_markers count, never falls back to ts', async () => {
    await clearMarkerRaw(db, projectId);
    await setMarkerRaw(db, projectId, [
      { ts: '2026-09-13T00:00:00.000Z' },
      { ts: '2026-09-13T00:01:00.000Z' },
    ]);

    const result = await resolveCloseSessionIdFromMarker(db, projectId, null, 'handoff_close');
    assert.ok(result.error, 'expected a refusal');
    assert.strictEqual(result.sessionId, null);
    assert.strictEqual(result.candidateCount, 0);
    assert.strictEqual(result.malformedCount, 2, `got: ${JSON.stringify(result)}`);
    assert.ok(result.error.includes('malformed_markers: 2'), `error text must name the malformed count, got: ${result.error}`);
  });

  await db.end();
  try { await engineDb.end(); } catch (_) { /* best-effort */ }

  console.log('');
  console.log(`Results: ${passed} passed, ${failed} failed`);
  await teardown();
  process.exit(failed > 0 ? 1 : 0);
}

runTests().catch((err) => {
  console.error('\nInfrastructure error:', err.message);
  console.error(err.stack);
  process.exit(2);
});
