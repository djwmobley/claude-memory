'use strict';

/**
 * test-loader-stop-sessionend.js — Regression guard for the "implicit close
 * fires at turn end, not session end" fix.
 *
 * loader-stop (the implicit-close hook) used to be wired under Claude Code's
 * Stop hook, which fires at EVERY turn end — the first turn's Stop event
 * clobbered the session TLDR before the session had done anything. This PR
 * moves the wiring to SessionEnd (fires once, at true session end) and makes
 * the session_in_progress marker per-session (a JSON array of
 * {session_id, ts} entries under one project_settings row) so concurrent
 * sibling sessions never step on each other's markers.
 *
 * scripts/test-loader-stop-gate.js covers S1 (the stdin total-classification
 * gate, zero I/O for non-SessionEnd events) with no DB required. This file
 * covers the DB-backed behavior: SessionEnd close-and-clear, SessionStart's
 * late-close sweep for a stale sibling marker, the source=clear/compact
 * skip, the implicit_close='disabled' no-op (S6), and the atomic
 * handoff.md write (S5).
 *
 * Mirrors test-handoff.js's setup/teardown conventions (fakeRoot + pre-minted
 * marker against claude_memory_eval_test).
 *
 * Usage:
 *   node test/handoff/test-loader-stop-sessionend.js
 *
 * Prerequisites: Postgres running with claude_memory_eval_test (same as
 * test-handoff.js). Run with CLAUDE_CODE_SESSION_ID unset to avoid the env
 * fallback masking marker-based resolution (see reference_local_test_
 * retrieval_events_gap in project memory).
 *
 * Exit codes: 0 all-pass, 1 any failure, 2 infrastructure error.
 */

const assert = require('assert');
const path   = require('path');
const fs     = require('fs');
const os     = require('os');
const { spawnSync } = require('child_process');

const { loadConfig }           = require('../../scripts/lib/shared');
const { writeMarker }          = require('../../scripts/lib/project-marker');
const { resolveHandoffMdPath } = require('../../scripts/lib/handoff-paths');
const { createRequire }        = require('module');
const scriptsRequire = createRequire(require.resolve('../../scripts/package.json'));
const { Client } = scriptsRequire('pg');

// ─── CONFIG ───────────────────────────────────────────────────────────────────

const TARGET_DB = 'claude_memory_eval_test';
const HELPER    = path.resolve(__dirname, '..', '..', 'scripts', 'handoff.js');

let passed = 0;
let failed = 0;

function test(label, fn) {
  try {
    const result = fn();
    if (result && typeof result.then === 'function') {
      return result.then(() => { console.log(`PASS  ${label}`); passed++; })
        .catch((err) => { console.error(`FAIL  ${label}`); console.error(`      ${err.message}`); failed++; });
    }
    console.log(`PASS  ${label}`);
    passed++;
  } catch (err) {
    console.error(`FAIL  ${label}`);
    console.error(`      ${err.message}`);
    failed++;
  }
  return Promise.resolve();
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
  const env = {
    ...process.env,
    PROJECT_ROOT: fakeRoot,
    ...opts.env,
  };
  delete env.CLAUDE_CODE_SESSION_ID; // never let the env fallback mask marker-based resolution
  const result = spawnSync(
    process.execPath,
    [HELPER, sub],
    {
      cwd: fakeRoot,
      env,
      encoding: 'utf8',
      timeout: 15000,
      input: stdinObj === undefined ? undefined : JSON.stringify(stdinObj),
    }
  );
  return { stdout: result.stdout || '', stderr: result.stderr || '', status: result.status };
}

/** Run a plain (non-hook) handoff.js subcommand, e.g. `init -y`. */
function runHelper(sub, extraArgs = [], opts = {}) {
  const fakeRoot = opts.fakeRoot || global.__fakeRoot;
  const env = { ...process.env, PROJECT_ROOT: fakeRoot };
  return spawnSync(
    process.execPath,
    [HELPER, sub, ...extraArgs],
    { cwd: fakeRoot, env, encoding: 'utf8', timeout: 30000 }
  ).stdout || '';
}

// ─── SETUP / TEARDOWN ─────────────────────────────────────────────────────────

async function setup() {
  const fakeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'loader-stop-sessionend-test-'));
  global.__fakeRoot = fakeRoot;

  fs.mkdirSync(path.join(fakeRoot, '.git'));
  fs.mkdirSync(path.join(fakeRoot, '.claude'));
  fs.writeFileSync(
    path.join(fakeRoot, '.claude', 'pipeline.yml'),
    `\nproject:\n  name: loader-stop-sessionend-test\n\nknowledge:\n  tier: "postgres"\n  host: "localhost"\n  port: 5432\n  database: "${TARGET_DB}"\n  user: "postgres"\n`.trim(),
    'utf8'
  );

  const marker = writeMarker(fakeRoot);
  global.__projectId = marker.uuid;

  console.log(`\n  fake root:   ${fakeRoot}`);
  console.log(`  marker uuid: ${marker.uuid}`);

  // Provision project_settings defaults + handoff.md via the real init path.
  runHelper('init', ['-y'], { fakeRoot });

  return fakeRoot;
}

async function teardown() {
  const fakeRoot   = global.__fakeRoot;
  const projectId  = global.__projectId;
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

// ─── MARKER HELPERS (raw SQL — deliberately independent of handoff.js's own
//     marker helpers, so this test exercises the ON-DISK CONTRACT rather than
//     re-testing the implementation against itself) ───────────────────────────

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
  const { rows } = await db.query(
    `SELECT value FROM project_settings WHERE project_id = $1 AND key = 'session_in_progress'`,
    [projectId]
  );
  return rows.length > 0 ? JSON.parse(rows[0].value) : null;
}

async function setSetting(db, projectId, key, value) {
  await db.query(
    `INSERT INTO project_settings (project_id, key, value) VALUES ($1, $2, $3)
     ON CONFLICT (project_id, key) DO UPDATE SET value = EXCLUDED.value`,
    [projectId, key, value]
  );
}

function tmpResidueFiles(handoffDir) {
  return fs.readdirSync(handoffDir).filter((f) => f.includes('.tmp-'));
}

/** Read the last_close: <iso> frontmatter value out of a handoff.md file. */
function readLastClose(handoffPath) {
  const content = fs.readFileSync(handoffPath, 'utf8');
  const m = content.match(/^last_close:\s*(.+)$/m);
  return m ? m[1].trim() : null;
}

// ─── TESTS ────────────────────────────────────────────────────────────────────

async function runTests() {
  const fakeRoot  = await setup();
  const db        = await connectDb();
  const projectId = global.__projectId;
  const handoffPath = resolveHandoffMdPath(projectId);
  const handoffDir  = path.dirname(handoffPath);

  const HOUR = 60 * 60 * 1000;

  // ── T1: SessionEnd + this session's own marker present -> close runs, marker cleared ──
  // Note: handoff.md's body is a fixed "See Postgres." thin pointer (templates/
  // handoff.md.tpl never interpolates {{TLDR}}/{{OPEN_THREADS}}/{{QUICK_REFERENCES}}
  // at all — pre-existing design, unrelated to this fix) — the only on-disk,
  // file-level proof that an implicit close ran is last_close advancing.
  await test('SessionEnd: own-session marker present -> implicit close runs (last_close advances) and marker is cleared', async () => {
    const before = readLastClose(handoffPath);
    await setMarkerRaw(db, projectId, [{ session_id: 'sess-me', ts: new Date().toISOString() }]);
    const r = runHook('loader-stop', { hook_event_name: 'SessionEnd', session_id: 'sess-me' }, { fakeRoot });
    assert.strictEqual(r.status, 0, `expected exit 0, got ${r.status}; stderr: ${r.stderr}`);

    const after = readLastClose(handoffPath);
    assert.ok(after && after !== before, `last_close should advance from an implicit close; before=${before} after=${after}`);
    assert.ok(!Number.isNaN(Date.parse(after)), `last_close should be a parseable timestamp, got: ${after}`);

    const markers = await getMarkerRaw(db, projectId);
    assert.ok(markers === null || markers.length === 0, `marker should be cleared, got: ${JSON.stringify(markers)}`);
  });

  // ── T2: SessionEnd + no marker -> no-op ──────────────────────────────────
  await test('SessionEnd: no marker present -> no-op (handoff.md untouched)', async () => {
    await clearMarkerRaw(db, projectId);
    const before = fs.readFileSync(handoffPath, 'utf8');
    const r = runHook('loader-stop', { hook_event_name: 'SessionEnd', session_id: 'sess-anything' }, { fakeRoot });
    assert.strictEqual(r.status, 0, `expected exit 0, got ${r.status}; stderr: ${r.stderr}`);
    const after = fs.readFileSync(handoffPath, 'utf8');
    assert.strictEqual(after, before, 'handoff.md must be byte-identical when there is no marker to act on');
  });

  // ── T3: SessionStart late-close sweep — stale foreign marker ─────────────
  await test('SessionStart: stale foreign marker (>24h) -> late implicit close + DIVERGENCE line + marker deleted', async () => {
    const before = readLastClose(handoffPath);
    const staleTs = new Date(Date.now() - 30 * HOUR).toISOString();
    await setMarkerRaw(db, projectId, [{ session_id: 'sess-stale-foreign', ts: staleTs }]);

    const r = runHook('loader-hook', { hook_event_name: 'SessionStart', session_id: 'sess-current', source: 'startup' }, { fakeRoot });
    assert.strictEqual(r.status, 0, `expected exit 0, got ${r.status}; stderr: ${r.stderr}`);

    let parsed;
    try { parsed = JSON.parse(r.stdout.trim().split('\n').pop()); } catch (e) {
      throw new Error(`loader-hook stdout was not parseable JSON: ${e.message}; stdout: ${r.stdout}`);
    }
    const ctx = parsed.hookSpecificOutput && parsed.hookSpecificOutput.additionalContext || '';
    assert.ok(ctx.includes('DIVERGENCE: late implicit close for session sess-stale-foreign'),
      `expected a DIVERGENCE line naming the stale session; got: ${ctx.slice(0, 500)}`);

    const after = readLastClose(handoffPath);
    assert.ok(after && after !== before, `late close should have advanced last_close; before=${before} after=${after}`);

    const markers = await getMarkerRaw(db, projectId);
    assert.ok(
      !(markers || []).some((m) => m.session_id === 'sess-stale-foreign'),
      'the stale foreign marker must be deleted after the late-close sweep'
    );
    // The fresh marker for THIS session (sess-current) should now be present.
    assert.ok(
      (markers || []).some((m) => m.session_id === 'sess-current'),
      'the current session should have a fresh marker written after loader-hook runs'
    );
  });

  // ── T4: SessionStart — fresh foreign marker is left untouched ────────────
  await test('SessionStart: fresh foreign marker (<24h) -> left untouched, no DIVERGENCE', async () => {
    await clearMarkerRaw(db, projectId);
    const freshTs = new Date(Date.now() - 1 * HOUR).toISOString();
    await setMarkerRaw(db, projectId, [{ session_id: 'sess-fresh-foreign', ts: freshTs }]);

    const r = runHook('loader-hook', { hook_event_name: 'SessionStart', session_id: 'sess-current-2', source: 'startup' }, { fakeRoot });
    assert.strictEqual(r.status, 0, `expected exit 0, got ${r.status}; stderr: ${r.stderr}`);

    let parsed;
    try { parsed = JSON.parse(r.stdout.trim().split('\n').pop()); } catch (e) {
      throw new Error(`loader-hook stdout was not parseable JSON: ${e.message}; stdout: ${r.stdout}`);
    }
    const ctx = parsed.hookSpecificOutput && parsed.hookSpecificOutput.additionalContext || '';
    assert.ok(!ctx.includes('DIVERGENCE'), `expected no DIVERGENCE line for a fresh foreign marker; got: ${ctx.slice(0, 500)}`);

    const markers = await getMarkerRaw(db, projectId);
    assert.ok(
      (markers || []).some((m) => m.session_id === 'sess-fresh-foreign' && m.ts === freshTs),
      'the fresh foreign marker must survive untouched'
    );
  });

  // ── T5: source=clear skips the late-close sweep entirely ─────────────────
  await test('SessionStart: source=clear skips the late-close sweep even with a stale foreign marker', async () => {
    await clearMarkerRaw(db, projectId);
    const staleTs = new Date(Date.now() - 48 * HOUR).toISOString();
    await setMarkerRaw(db, projectId, [{ session_id: 'sess-stale-foreign-2', ts: staleTs }]);

    const r = runHook('loader-hook', { hook_event_name: 'SessionStart', session_id: 'sess-current-3', source: 'clear' }, { fakeRoot });
    assert.strictEqual(r.status, 0, `expected exit 0, got ${r.status}; stderr: ${r.stderr}`);

    let parsed;
    try { parsed = JSON.parse(r.stdout.trim().split('\n').pop()); } catch (e) {
      throw new Error(`loader-hook stdout was not parseable JSON: ${e.message}; stdout: ${r.stdout}`);
    }
    const ctx = parsed.hookSpecificOutput && parsed.hookSpecificOutput.additionalContext || '';
    assert.ok(!ctx.includes('DIVERGENCE'), `source=clear must never trigger a late-close DIVERGENCE; got: ${ctx.slice(0, 500)}`);

    const markers = await getMarkerRaw(db, projectId);
    assert.ok(
      (markers || []).some((m) => m.session_id === 'sess-stale-foreign-2'),
      'the stale foreign marker must survive untouched on source=clear'
    );
  });

  // ── T6: atomic write — no .tmp- residue after a real implicit close ─────
  await test('writeHandoffMd atomicity: no .tmp- residue file left behind after an implicit close', async () => {
    await clearMarkerRaw(db, projectId);
    await setMarkerRaw(db, projectId, [{ session_id: 'sess-atomic', ts: new Date().toISOString() }]);
    const r = runHook('loader-stop', { hook_event_name: 'SessionEnd', session_id: 'sess-atomic' }, { fakeRoot });
    assert.strictEqual(r.status, 0, `expected exit 0, got ${r.status}; stderr: ${r.stderr}`);

    const residue = tmpResidueFiles(handoffDir);
    assert.strictEqual(residue.length, 0, `expected no .tmp- residue files, found: ${residue.join(', ')}`);
  });

  // ── T7 (S6): implicit_close=disabled -> SessionEnd is a full no-op ───────
  await test('S6: implicit_close=disabled -> SessionEnd never runs an implicit close, marker survives', async () => {
    await setSetting(db, projectId, 'implicit_close', 'disabled');
    await clearMarkerRaw(db, projectId);
    await setMarkerRaw(db, projectId, [{ session_id: 'sess-disabled', ts: new Date().toISOString() }]);
    const before = fs.readFileSync(handoffPath, 'utf8');

    const r = runHook('loader-stop', { hook_event_name: 'SessionEnd', session_id: 'sess-disabled' }, { fakeRoot });
    assert.strictEqual(r.status, 0, `expected exit 0, got ${r.status}; stderr: ${r.stderr}`);

    const after = fs.readFileSync(handoffPath, 'utf8');
    assert.strictEqual(after, before, 'handoff.md must be untouched when implicit_close=disabled');

    const markers = await getMarkerRaw(db, projectId);
    assert.ok(
      (markers || []).some((m) => m.session_id === 'sess-disabled'),
      'the marker must survive when implicit_close=disabled (nothing ran to clear it)'
    );
  });

  // ── T8 (S6): implicit_close=disabled -> SessionStart late-close sweep is also a no-op ──
  await test('S6: implicit_close=disabled -> SessionStart late-close sweep is also a no-op', async () => {
    await clearMarkerRaw(db, projectId);
    const staleTs = new Date(Date.now() - 72 * HOUR).toISOString();
    await setMarkerRaw(db, projectId, [{ session_id: 'sess-stale-disabled', ts: staleTs }]);

    const r = runHook('loader-hook', { hook_event_name: 'SessionStart', session_id: 'sess-current-4', source: 'startup' }, { fakeRoot });
    assert.strictEqual(r.status, 0, `expected exit 0, got ${r.status}; stderr: ${r.stderr}`);

    let parsed;
    try { parsed = JSON.parse(r.stdout.trim().split('\n').pop()); } catch (e) {
      throw new Error(`loader-hook stdout was not parseable JSON: ${e.message}; stdout: ${r.stdout}`);
    }
    const ctx = parsed.hookSpecificOutput && parsed.hookSpecificOutput.additionalContext || '';
    assert.ok(!ctx.includes('DIVERGENCE'), `implicit_close=disabled must suppress the late-close sweep entirely; got: ${ctx.slice(0, 500)}`);

    const markers = await getMarkerRaw(db, projectId);
    assert.ok(
      (markers || []).some((m) => m.session_id === 'sess-stale-disabled'),
      'the stale marker must survive when implicit_close=disabled'
    );

    // Restore for hygiene (not strictly required — teardown deletes the project's rows).
    await setSetting(db, projectId, 'implicit_close', 'enabled');
  });

  await db.end();

  // ─── SUMMARY ─────────────────────────────────────────────────────────────
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
