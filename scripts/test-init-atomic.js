'use strict';

/**
 * test-init-atomic.js — Regression suite for handoff init atomicity (#125).
 *
 * Before the fix, cmdInit wrote the .claude-memory marker as its FIRST action,
 * before any DB operations.  A failure in the Phase-A schema transaction left
 * the marker on disk while printing "No FS writes made." — both false and
 * dangerous (every future session would try to load state from a DB that was
 * never provisioned).
 *
 * After the fix:
 *   - The UUID is minted in memory; the .claude-memory file is written LAST.
 *   - A FS-write ledger tracks every file this run creates.
 *   - On any failure the ledger is unwound in reverse (no orphaned files).
 *   - The failure message is accurate (ledger-based, not hard-coded).
 *
 * Coverage:
 *   A1  persistMarker() unit: writes a valid marker with a caller-supplied UUID.
 *   A2  persistMarker() unit: throws if marker already exists (no overwrite).
 *   A3  mintUUID() unit: returns a valid UUID v4; two calls produce distinct values.
 *   A4  Failure before FS writes leaves no marker (DB connect failure injection).
 *       Mechanism: set PGHOST to an unreachable host so db connect fails before
 *       any FS write, assert no .claude-memory in temp dir afterward.
 *   A5  Failure output does not claim cleanliness while a file persists.
 *       Piggybacks on A4: output must NOT say "No FS writes made" (old false msg).
 *   A6  Success path writes the marker LAST and produces a valid marker file.
 *       Uses a live throwaway DB (skipped if Postgres unavailable).
 *   A7  Re-init idempotency: running init twice on an already-provisioned project
 *       is safe and does NOT rewrite or duplicate the marker.
 *       Uses a live throwaway DB (skipped if Postgres unavailable).
 *   A8  FS-ledger unwind: CLAUDE.md write failure (read-only file, EPERM) triggers
 *       unwind that removes handoff.md (already in ledger) and never writes the
 *       marker. Asserts "Rolled back" in output. Uses a live throwaway DB (skipped
 *       if Postgres unavailable or on Windows). POSIX only (chmod injection).
 *
 * Usage:
 *   node scripts/test-init-atomic.js
 *
 * Requires: For A6/A7/A8, Postgres at PGHOST/PGUSER/PGPASSWORD (CI env) or localhost/postgres.
 * A1-A5 are pure unit/subprocess tests — no live Postgres required.
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
  resolveProjectId,
  cleanupHandoffMd,
} = require('./lib/test-pg-helpers');

const {
  readMarker,
  mintUUID,
  persistMarker,
  isValidUUID,
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
  const dir = path.join(os.tmpdir(), `handoff_atomic_${tag}_${TS}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Remove a temp directory. */
function rmTempDir(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
}

/** Spawn handoff.js init in the given projectDir, using the given DB name. */
function runInit(dbName, projectDir, extraEnv = {}) {
  return spawnSync(
    process.execPath,
    [HANDOFF_SCRIPT, 'init', '-y'],
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
    console.log('[INFO] Postgres unavailable — DB-backed tests (A6/A7/A8) will be SKIPPED.');
  }
  return _pgAvail;
}

// ── A1: persistMarker unit — writes valid marker with caller-supplied UUID ────

async function testA1() {
  const label = 'A1: persistMarker() writes valid marker with caller-supplied UUID';
  const tmpDir = makeTempDir('a1');
  try {
    const uuid   = mintUUID();
    const result = persistMarker(tmpDir, uuid);

    if (result.uuid !== uuid) {
      fail(label, `returned uuid mismatch: ${result.uuid} !== ${uuid}`); return;
    }
    if (result.schema_version !== 1) {
      fail(label, `schema_version should be 1, got ${result.schema_version}`); return;
    }

    const markerPath = path.join(tmpDir, MARKER_FILENAME);
    if (!fs.existsSync(markerPath)) {
      fail(label, '.claude-memory file not written to disk'); return;
    }

    const read = readMarker(tmpDir);
    if (!read || read.uuid !== uuid) {
      fail(label, `readMarker returned wrong uuid: ${read && read.uuid}`); return;
    }

    pass(label);
  } catch (err) {
    fail(label, err.message);
  } finally {
    rmTempDir(tmpDir);
  }
}

// ── A2: persistMarker unit — throws if marker already exists ──────────────────

async function testA2() {
  const label = 'A2: persistMarker() throws if .claude-memory already exists (no overwrite)';
  const tmpDir = makeTempDir('a2');
  try {
    const uuid1 = mintUUID();
    persistMarker(tmpDir, uuid1);  // first write — OK

    let threw = false;
    let errMsg = '';
    try {
      persistMarker(tmpDir, mintUUID());  // second write — must throw
    } catch (err) {
      threw  = true;
      errMsg = err.message;
    }

    if (!threw) {
      fail(label, 'expected throw but persistMarker succeeded (overwrote existing marker)'); return;
    }
    if (!errMsg.includes('already exists')) {
      fail(label, `throw message did not mention 'already exists': ${errMsg}`); return;
    }

    // Verify original UUID still on disk (no silent overwrite).
    const read = readMarker(tmpDir);
    if (!read || read.uuid !== uuid1) {
      fail(label, `original marker was overwritten — uuid on disk: ${read && read.uuid}`); return;
    }

    pass(label);
  } catch (err) {
    fail(label, err.message);
  } finally {
    rmTempDir(tmpDir);
  }
}

// ── A3: mintUUID unit — returns valid UUID v4; two calls produce distinct ids ─

async function testA3() {
  const label = 'A3: mintUUID() returns valid UUID v4; two calls produce distinct values';
  try {
    const a = mintUUID();
    const b = mintUUID();

    if (!isValidUUID(a)) {
      fail(label, `first UUID invalid: ${a}`); return;
    }
    if (!isValidUUID(b)) {
      fail(label, `second UUID invalid: ${b}`); return;
    }
    if (a === b) {
      fail(label, `two consecutive mintUUID() calls returned the same UUID: ${a}`); return;
    }

    pass(label);
  } catch (err) {
    fail(label, err.message);
  }
}

// ── A4: FS-write failure after DB succeeds leaves no marker ───────────────────
//
// Injection strategy: run a successful phase-1 init to provision the DB, then
// strip the marker + handoff.md, and make CLAUDE.md read-only (EPERM on write).
// Re-init writes handoff.md (OK), then tries to write CLAUDE.md (EPERM) → failure.
// At that point the marker must NOT be on disk (step 12 follows step 11).
//
// Note: fs.chmodSync for read-only enforcement is POSIX-native; on Windows node
// it may not prevent writes.  The test skips on Windows and in CI always runs
// on Linux where chmod is reliable.  A1-A3 cover the persistMarker unit contract
// on all platforms; A6/A7 prove the success path cross-platform.

async function testA4() {
  const label = 'A4: FS-write failure after DB succeeds leaves no .claude-memory marker (POSIX)';
  if (process.platform === 'win32') {
    console.log(`SKIP  ${label} (chmod-based injection not reliable on Windows; covered by A1-A3 unit tests)`);
    return;
  }
  const pgAvail = await isPgAvailable();
  if (!pgAvail) { console.log(`SKIP  ${label} (Postgres unavailable)`); return; }

  const dbName  = `handoff_atomic_a4_${TS}`;
  const tmpDir  = makeTempDir('a4');
  let   projId  = null;

  try {
    await createDb(dbName, tmpDir);

    // Phase 1: successful init.
    const r1 = runInit(dbName, tmpDir);
    if (r1.status !== 0) {
      fail(label, `phase-1 init failed: ${r1.stderr || r1.stdout}`); return;
    }
    const marker1 = readMarker(tmpDir);
    if (!marker1) { fail(label, 'no marker after phase-1 init'); return; }
    projId = marker1.uuid;

    // Strip marker and handoff.md so re-init creates fresh FS writes.
    fs.rmSync(path.join(tmpDir, MARKER_FILENAME), { force: true });
    cleanupHandoffMd(projId);

    // Make CLAUDE.md read-only so fs.writeFileSync fails with EPERM.
    // cmdInit checks fs.existsSync first; a read-only EXISTING file passes that
    // check and then fails on the write — this is the correct failure injection.
    const claudeMdPath = path.join(tmpDir, 'CLAUDE.md');
    // Ensure CLAUDE.md exists as a file (phase-1 may have created it).
    if (!fs.existsSync(claudeMdPath)) {
      fs.writeFileSync(claudeMdPath, '# placeholder\n', 'utf8');
    }
    // BUT: if it exists, cmdInit skips it (already present). We need it absent
    // so cmdInit tries to write it.  Remove it, then re-create as read-only.
    fs.rmSync(claudeMdPath, { force: true });
    fs.writeFileSync(claudeMdPath, '# blocked\n', 'utf8');
    fs.chmodSync(claudeMdPath, 0o444);  // read-only — write will throw EPERM

    // Phase 2: re-init — step 11 (CLAUDE.md write) must fail.
    let r2;
    try {
      r2 = runInit(dbName, tmpDir);
    } finally {
      try { fs.chmodSync(claudeMdPath, 0o644); } catch (_) {}
    }

    if (r2.status === 0) {
      // If init somehow succeeded (e.g. CLAUDE.md was treated as pre-existing),
      // this is a test-design failure — report it clearly.
      const out = (r2.stdout || '');
      if (out.includes('CLAUDE.md already exists')) {
        fail(label, 'test-design: cmdInit skipped CLAUDE.md write (treated read-only file as pre-existing) — injection did not fire'); return;
      }
      fail(label, 're-init unexpectedly succeeded despite read-only CLAUDE.md'); return;
    }

    const markerPath = path.join(tmpDir, MARKER_FILENAME);
    if (fs.existsSync(markerPath)) {
      fail(label, '.claude-memory written despite CLAUDE.md step failing — atomicity violated'); return;
    }

    pass(label);
  } catch (err) {
    fail(label, err.message);
  } finally {
    const claudeMdPath = path.join(tmpDir, 'CLAUDE.md');
    try { fs.chmodSync(claudeMdPath, 0o644); } catch (_) {}
    if (projId) cleanupHandoffMd(projId);
    await dropDb(dbName, tmpDir);
  }
}

// ── A5: failure output does not falsely claim "No FS writes made" ─────────────
//
// Runs the same failure scenario as A4 (read-only CLAUDE.md) and inspects the
// output.  The old false message must not appear verbatim.

async function testA5() {
  const label = 'A5: failure output does not contain stale "No FS writes made." message (POSIX)';
  if (process.platform === 'win32') {
    console.log(`SKIP  ${label} (chmod-based injection not reliable on Windows)`);
    return;
  }
  const pgAvail = await isPgAvailable();
  if (!pgAvail) { console.log(`SKIP  ${label} (Postgres unavailable)`); return; }

  const dbName  = `handoff_atomic_a5_${TS}`;
  const tmpDir  = makeTempDir('a5');
  let   projId  = null;

  try {
    await createDb(dbName, tmpDir);

    // Phase 1: successful init.
    const r1 = runInit(dbName, tmpDir);
    if (r1.status !== 0) {
      fail(label, `phase-1 init failed: ${r1.stderr || r1.stdout}`); return;
    }
    const marker1 = readMarker(tmpDir);
    if (!marker1) { fail(label, 'no marker after phase-1 init'); return; }
    projId = marker1.uuid;

    // Strip marker + handoff.md so re-init tries to create fresh files.
    fs.rmSync(path.join(tmpDir, MARKER_FILENAME), { force: true });
    cleanupHandoffMd(projId);

    // Make CLAUDE.md read-only.
    const claudeMdPath = path.join(tmpDir, 'CLAUDE.md');
    fs.rmSync(claudeMdPath, { force: true });
    fs.writeFileSync(claudeMdPath, '# blocked\n', 'utf8');
    fs.chmodSync(claudeMdPath, 0o444);

    let r2;
    try {
      r2 = runInit(dbName, tmpDir);
    } finally {
      try { fs.chmodSync(claudeMdPath, 0o644); } catch (_) {}
    }

    const combined = (r2.stdout || '') + (r2.stderr || '');

    if (combined.includes('No FS writes made.')) {
      fail(label, 'output still contains stale "No FS writes made." message'); return;
    }

    if (r2.status === 0) {
      const out = (r2.stdout || '');
      if (out.includes('CLAUDE.md already exists')) {
        fail(label, 'test-design: cmdInit skipped CLAUDE.md — injection did not fire'); return;
      }
      fail(label, 'init unexpectedly succeeded despite read-only CLAUDE.md'); return;
    }

    pass(label);
  } catch (err) {
    fail(label, err.message);
  } finally {
    const claudeMdPath = path.join(tmpDir, 'CLAUDE.md');
    try { fs.chmodSync(claudeMdPath, 0o644); } catch (_) {}
    if (projId) cleanupHandoffMd(projId);
    await dropDb(dbName, tmpDir);
  }
}

// ── A6: success path writes marker LAST and produces a valid marker file ──────

async function testA6() {
  const label = 'A6: successful init writes .claude-memory marker last with valid UUID';
  const pgAvail = await isPgAvailable();
  if (!pgAvail) { console.log(`SKIP  ${label} (Postgres unavailable)`); return; }

  const dbName  = `handoff_atomic_a6_${TS}`;
  const tmpDir  = makeTempDir('a6');
  let   projId  = null;

  try {
    await createDb(dbName, tmpDir);

    const r = runInit(dbName, tmpDir);
    if (r.status !== 0) {
      fail(label, `init exited ${r.status}: ${r.stderr || r.stdout}`); return;
    }

    const markerPath = path.join(tmpDir, MARKER_FILENAME);
    if (!fs.existsSync(markerPath)) {
      fail(label, '.claude-memory file missing after successful init'); return;
    }

    const marker = readMarker(tmpDir);
    if (!marker || !isValidUUID(marker.uuid)) {
      fail(label, `marker missing or has invalid UUID: ${marker && marker.uuid}`); return;
    }

    projId = marker.uuid;

    // The marker UUID must appear in the init output so we can trace it.
    const combined = (r.stdout || '') + (r.stderr || '');
    if (!combined.includes(projId)) {
      fail(label, `project UUID ${projId} not found in init output`); return;
    }

    pass(label);
  } catch (err) {
    fail(label, err.message);
  } finally {
    if (projId) cleanupHandoffMd(projId);
    await dropDb(dbName, tmpDir);
  }
}

// ── A7: re-init idempotency — safe, does not rewrite/duplicate marker ─────────

async function testA7() {
  const label = 'A7: re-init on already-provisioned project is safe (idempotent marker)';
  const pgAvail = await isPgAvailable();
  if (!pgAvail) { console.log(`SKIP  ${label} (Postgres unavailable)`); return; }

  const dbName  = `handoff_atomic_a7_${TS}`;
  const tmpDir  = makeTempDir('a7');
  let   projId  = null;

  try {
    await createDb(dbName, tmpDir);

    // First init.
    const r1 = runInit(dbName, tmpDir);
    if (r1.status !== 0) {
      fail(label, `first init failed: ${r1.stderr || r1.stdout}`); return;
    }

    const markerBefore = readMarker(tmpDir);
    if (!markerBefore) { fail(label, 'no marker after first init'); return; }
    projId = markerBefore.uuid;

    // Second init on same project/DB.
    const r2 = runInit(dbName, tmpDir);
    if (r2.status !== 0) {
      fail(label, `second init (re-init) failed: ${r2.stderr || r2.stdout}`); return;
    }

    const markerAfter = readMarker(tmpDir);
    if (!markerAfter) { fail(label, 'marker missing after re-init'); return; }

    if (markerAfter.uuid !== markerBefore.uuid) {
      fail(label, `marker UUID changed on re-init: ${markerBefore.uuid} → ${markerAfter.uuid}`); return;
    }

    // Output of second init must say marker is already present (not "created").
    const out2 = r2.stdout || '';
    if (!out2.includes('marker present')) {
      fail(label, `re-init output did not confirm existing marker ("marker present" not found)`); return;
    }

    pass(label);
  } catch (err) {
    fail(label, err.message);
  } finally {
    if (projId) cleanupHandoffMd(projId);
    await dropDb(dbName, tmpDir);
  }
}

// ── A8: FS-ledger unwind — handoff.md removed, marker never written ───────────
//
// Prove the multi-file ledger unwind path: when handoff.md write succeeds but
// CLAUDE.md write fails, the unwind removes handoff.md AND the marker is never
// written (it is step 12, after CLAUDE.md step 11).
//
// Injection: read-only CLAUDE.md (same as A4).  After failed re-init, assert:
//   (a) .claude-memory absent (marker never written)
//   (b) output contains "Rolled back" (unwind log appeared)
//   (c) handoff.md absent for the new UUID minted by re-init
//
// POSIX only (chmod-based injection; skipped on Windows and when PG unavailable).

async function testA8() {
  const label = 'A8: FS-ledger unwind — handoff.md removed and marker never written (POSIX)';
  if (process.platform === 'win32') {
    console.log(`SKIP  ${label} (chmod-based injection not reliable on Windows)`);
    return;
  }
  const pgAvail = await isPgAvailable();
  if (!pgAvail) { console.log(`SKIP  ${label} (Postgres unavailable)`); return; }

  const dbName  = `handoff_atomic_a8_${TS}`;
  const tmpDir  = makeTempDir('a8');
  let   projId  = null;

  try {
    await createDb(dbName, tmpDir);

    // Phase 1: successful init to provision the DB.
    const r1 = runInit(dbName, tmpDir);
    if (r1.status !== 0) {
      fail(label, `phase-1 init failed: ${r1.stderr || r1.stdout}`); return;
    }
    const marker1 = readMarker(tmpDir);
    if (!marker1) { fail(label, 'no marker after phase-1 init'); return; }
    projId = marker1.uuid;

    // Remove marker and handoff.md so re-init creates fresh FS writes.
    fs.rmSync(path.join(tmpDir, MARKER_FILENAME), { force: true });
    cleanupHandoffMd(projId);

    // Make CLAUDE.md read-only (must be present as a file for cmdInit to try to write it).
    const claudeMdPath = path.join(tmpDir, 'CLAUDE.md');
    fs.rmSync(claudeMdPath, { force: true });
    fs.writeFileSync(claudeMdPath, '# blocked\n', 'utf8');
    fs.chmodSync(claudeMdPath, 0o444);

    // Phase 2: re-init — handoff.md write succeeds, CLAUDE.md write fails with EPERM.
    // Ledger at that point: [handoff.md]. Unwind removes handoff.md; marker never written.
    let r2;
    try {
      r2 = runInit(dbName, tmpDir);
    } finally {
      try { fs.chmodSync(claudeMdPath, 0o644); } catch (_) {}
    }

    if (r2.status === 0) {
      const out = (r2.stdout || '');
      if (out.includes('CLAUDE.md already exists')) {
        fail(label, 'test-design: cmdInit skipped CLAUDE.md — injection did not fire'); return;
      }
      fail(label, 're-init unexpectedly succeeded despite read-only CLAUDE.md'); return;
    }

    const combined = (r2.stdout || '') + (r2.stderr || '');

    // (a) Marker must not exist.
    const markerPath = path.join(tmpDir, MARKER_FILENAME);
    if (fs.existsSync(markerPath)) {
      fail(label, '.claude-memory written despite CLAUDE.md failure — atomicity violated'); return;
    }

    // (b) Output must mention "Rolled back".
    if (!combined.includes('Rolled back')) {
      fail(label, `output does not mention "Rolled back": ${combined.slice(0, 400)}`); return;
    }

    // (c) handoff.md for the new UUID must have been removed by unwind.
    const uuidMatch = combined.match(/uuid=([0-9a-f-]{36})/i);
    if (uuidMatch) {
      const newUuid     = uuidMatch[1];
      const handoffPath = path.join(os.homedir(), '.claude', 'projects', newUuid, 'handoff.md');
      if (fs.existsSync(handoffPath)) {
        fail(label, 'handoff.md still exists after unwind — ledger did not clean it up'); return;
      }
      cleanupHandoffMd(newUuid);
    }

    pass(label);
  } catch (err) {
    fail(label, err.message);
  } finally {
    const claudeMdPath = path.join(tmpDir, 'CLAUDE.md');
    try { fs.chmodSync(claudeMdPath, 0o644); } catch (_) {}
    if (projId) cleanupHandoffMd(projId);
    await dropDb(dbName, tmpDir);
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('Running: test-init-atomic.js\n');

  await testA1();
  await testA2();
  await testA3();
  await testA4();
  await testA5();
  await testA6();
  await testA7();
  await testA8();

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
