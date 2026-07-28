'use strict';

/**
 * test-init-confirm.js — Regression suite for the init DB-confirmation gate (#126).
 *
 * Before the fix, handoff init applied DDL to whichever database was resolved
 * (env / pipeline.yml / built-in default) without printing the resolution source
 * and without any confirmation.  A project whose .claude/pipeline.yml was written
 * for an unrelated tool could have had the handoff schema applied silently.
 *
 * After the fix:
 *   - init always prints: "Resolved target DB: <name>  (source: <source>)"
 *   - Without -y / --yes / --force in a non-TTY context, init safe-fails immediately
 *     with a clear refusal message (no readline hang).
 *   - With -y the gate is bypassed and init proceeds as before.
 *
 * Coverage:
 *   C1  Resolved DB + source printed: init -y on a temp project with a
 *       .claude/pipeline.yml that names a specific DB; assert output contains the
 *       DB name AND "source: .claude/pipeline.yml".
 *   C2  -y bypass proceeds: successful init -y completes and creates the marker
 *       (uses live test DB; cleans up).
 *   C3  Non-TTY safe-fail: invoke init WITHOUT -y as a subprocess with stdin
 *       NOT a TTY; assert exit non-zero, refusal message printed, no project marker
 *       created, and the process does NOT hang (5-second timeout enforced).
 *       This is the key non-vacuous test — it would NOT pass before this change.
 *
 * Usage:
 *   node scripts/test-init-confirm.js
 *
 * Requires: For C1/C2, Postgres at PGHOST/PGUSER/PGPASSWORD (CI env) or localhost/postgres.
 * C3 is a pure subprocess test and does not require live Postgres (it exits before preflight).
 * Exit 0 = all tests passed. Exit 1 = any failure.
 */

const { spawnSync } = require('child_process');
const fs            = require('fs');
const os            = require('os');
const path          = require('path');

const {
  pgConnect,
  createDb,
  dropDb,
  cleanupHandoffMd,
} = require('./lib/test-pg-helpers');

const {
  readMarker,
  MARKER_FILENAME,
} = require('./lib/project-marker');

// ── Constants ─────────────────────────────────────────────────────────────────

const PROJECT_ROOT   = path.resolve(__dirname, '..');
const HANDOFF_SCRIPT = path.join(PROJECT_ROOT, 'scripts', 'handoff.js');
const TS             = Date.now();

// ── Tracking ──────────────────────────────────────────────────────────────────

let passed   = 0;
let failed   = 0;
const failures = [];

function pass(label)         { console.log(`PASS  ${label}`); passed++; }
function fail(label, reason) { console.log(`FAIL  ${label}: ${reason}`); failures.push({ label, reason }); failed++; }

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Create an isolated temp project directory. */
function makeTempDir(tag) {
  const dir = path.join(os.tmpdir(), `handoff_confirm_${tag}_${TS}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Remove a temp directory. */
function rmTempDir(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
}

/**
 * Write a minimal .claude/pipeline.yml into projectDir pointing at dbName.
 * This exercises the .claude/pipeline.yml resolution tier.
 */
function writePipelineYml(projectDir, dbName) {
  const claudeDir = path.join(projectDir, '.claude');
  fs.mkdirSync(claudeDir, { recursive: true });
  fs.writeFileSync(
    path.join(claudeDir, 'pipeline.yml'),
    `database: ${dbName}\n`,
    'utf8'
  );
}

/** Spawn handoff.js init with specified args in the given projectDir. */
function runInit(dbName, projectDir, extraArgs = [], extraEnv = {}) {
  return spawnSync(
    process.execPath,
    [HANDOFF_SCRIPT, 'init', ...extraArgs],
    {
      cwd:      PROJECT_ROOT,
      env: {
        ...process.env,
        HANDOFF_DB:   dbName,
        PROJECT_ROOT: projectDir,
        ...extraEnv,
      },
      encoding: 'utf8',
      timeout:  30000,
    }
  );
}

/** Check Postgres availability (memoized). */
let _pgAvail = null;
async function isPgAvailable() {
  if (_pgAvail !== null) return _pgAvail;
  try {
    const c = await pgConnect('postgres');
    await c.end();
    _pgAvail = true;
  } catch (_) {
    _pgAvail = false;
    console.log('[INFO] Postgres unavailable — C1/C2 (DB-backed tests) will be SKIPPED.');
  }
  return _pgAvail;
}

// ── C1: Resolved DB + source printed ─────────────────────────────────────────
//
// Run init -y on a temp project whose .claude/pipeline.yml names a specific DB.
// Assert that the output contains both the DB name and "source: .claude/pipeline.yml".
// This confirms the resolution announcement works for the non-default tier.

async function testC1() {
  const label = 'C1: resolved DB name and source tier printed before DDL';
  const pgAvail = await isPgAvailable();
  if (!pgAvail) { console.log(`SKIP  ${label} (Postgres unavailable)`); return; }

  const dbName  = `handoff_confirm_c1_${TS}`;
  const tmpDir  = makeTempDir('c1');
  let   projId  = null;

  try {
    await createDb(dbName, tmpDir);

    // Write a pipeline.yml so the resolution tier is ".claude/pipeline.yml".
    writePipelineYml(tmpDir, dbName);

    // Run init -y (bypass gate) so we reach the DDL and check output.
    // We run WITHOUT HANDOFF_DB in the env so the pipeline.yml is the resolver.
    const r = spawnSync(
      process.execPath,
      [HANDOFF_SCRIPT, 'init', '-y'],
      {
        cwd:      PROJECT_ROOT,
        env: {
          ...process.env,
          PROJECT_ROOT: tmpDir,
          // Unset HANDOFF_DB so pipeline.yml wins. spawnSync env replaces the
          // whole env object, so we must manually exclude HANDOFF_DB if set.
          HANDOFF_DB:   undefined,
        },
        encoding: 'utf8',
        timeout:  30000,
      }
    );

    const combined = (r.stdout || '') + (r.stderr || '');

    if (!combined.includes(dbName)) {
      fail(label, `DB name "${dbName}" not found in output: ${combined.slice(0, 500)}`); return;
    }

    if (!combined.includes('source: .claude/pipeline.yml')) {
      fail(label, `"source: .claude/pipeline.yml" not found in output: ${combined.slice(0, 500)}`); return;
    }

    // Also confirm the announcement line itself is present.
    if (!combined.includes('Resolved target DB:')) {
      fail(label, `"Resolved target DB:" line not found in output: ${combined.slice(0, 500)}`); return;
    }

    const marker = readMarker(tmpDir);
    if (marker) projId = marker.uuid;

    pass(label);
  } catch (err) {
    fail(label, err.message);
  } finally {
    if (projId) cleanupHandoffMd(projId);
    await dropDb(dbName, tmpDir);
    rmTempDir(tmpDir);
  }
}

// ── C2: -y bypass proceeds to successful init ─────────────────────────────────
//
// Confirm that passing -y bypasses the gate and init completes normally.
// The project marker must be written on success.

async function testC2() {
  const label = 'C2: -y bypass proceeds — init completes and writes project marker';
  const pgAvail = await isPgAvailable();
  if (!pgAvail) { console.log(`SKIP  ${label} (Postgres unavailable)`); return; }

  const dbName  = `handoff_confirm_c2_${TS}`;
  const tmpDir  = makeTempDir('c2');
  let   projId  = null;

  try {
    await createDb(dbName, tmpDir);

    const r = runInit(dbName, tmpDir, ['-y']);

    if (r.status !== 0) {
      fail(label, `init exited ${r.status}: ${r.stderr || r.stdout}`); return;
    }

    const markerPath = path.join(tmpDir, MARKER_FILENAME);
    if (!fs.existsSync(markerPath)) {
      fail(label, 'marker missing after successful init -y'); return;
    }

    const marker = readMarker(tmpDir);
    if (!marker || !marker.uuid) {
      fail(label, `marker missing or has no uuid: ${JSON.stringify(marker)}`); return;
    }

    projId = marker.uuid;

    // The resolved-target-DB line must appear in the output.
    const combined = (r.stdout || '') + (r.stderr || '');
    if (!combined.includes('Resolved target DB:')) {
      fail(label, `"Resolved target DB:" line not found in output: ${combined.slice(0, 500)}`); return;
    }

    pass(label);
  } catch (err) {
    fail(label, err.message);
  } finally {
    if (projId) cleanupHandoffMd(projId);
    await dropDb(dbName, tmpDir);
    rmTempDir(tmpDir);
  }
}

// ── C3: Non-TTY safe-fail ─────────────────────────────────────────────────────
//
// Invoke init WITHOUT -y as a subprocess whose stdin is NOT a TTY (spawnSync
// with no input option — stdin inherits as a pipe, which is not a TTY).
// Assertions:
//   (a) exits non-zero
//   (b) prints the refusal message
//   (c) does NOT create a project marker in the temp dir
//   (d) does NOT hang (enforced by a 5-second timeout on the subprocess)
//
// This test does NOT require live Postgres: the gate fires before preflight.
// A HANDOFF_DB env is still provided so the resolved-target-DB announcement
// is deterministic; the refusal happens before any DB contact.

async function testC3() {
  const label = 'C3: non-TTY safe-fail — exits non-zero, prints refusal, no marker, no hang';

  const tmpDir = makeTempDir('c3');
  const dbName = `handoff_confirm_c3_${TS}`;  // never created — gate fires first

  try {
    // spawnSync with no 'input' key: stdin is inherited as a pipe (not a TTY).
    // The 5-second timeout is the hang-detection mechanism.
    const r = spawnSync(
      process.execPath,
      [HANDOFF_SCRIPT, 'init'],   // NO -y
      {
        cwd:      PROJECT_ROOT,
        env: {
          ...process.env,
          HANDOFF_DB:   dbName,
          PROJECT_ROOT: tmpDir,
        },
        encoding: 'utf8',
        timeout:  5000,   // hard cap — if this fires, the process hung
        // stdio: default 'pipe' — stdin is a pipe, not a TTY
      }
    );

    // (d) No hang: if timeout fires, r.signal === 'SIGTERM' and r.status is null.
    if (r.signal === 'SIGTERM' || r.status === null) {
      fail(label, 'process was killed by timeout — it hung waiting for input (gate did not fire)'); return;
    }

    // (a) Must exit non-zero.
    if (r.status === 0) {
      fail(label, 'init exited 0 — gate did not fire; DDL was applied without confirmation'); return;
    }

    const combined = (r.stdout || '') + (r.stderr || '');

    // (b) Refusal message must appear.
    if (!combined.includes('Refusing to apply DDL without confirmation')) {
      fail(label, `refusal message not found in output: ${combined.slice(0, 500)}`); return;
    }

    // (c) No project marker created.
    const markerPath = path.join(tmpDir, MARKER_FILENAME);
    if (fs.existsSync(markerPath)) {
      fail(label, 'marker was created despite safe-fail — gate did not prevent FS write'); return;
    }

    pass(label);
  } catch (err) {
    fail(label, err.message);
  } finally {
    rmTempDir(tmpDir);
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('Running: test-init-confirm.js\n');

  await testC1();
  await testC2();
  await testC3();

  console.log(`\n${'─'.repeat(60)}`);
  console.log(`Results: ${passed} passed, ${failed} failed`);
  if (failures.length > 0) {
    console.log('\nFailures:');
    for (const { label, reason } of failures) {
      console.log(`  FAIL  ${label}`);
      console.log(`        ${reason}`);
    }
  }
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('Unhandled error in test runner:', err);
  process.exit(1);
});
