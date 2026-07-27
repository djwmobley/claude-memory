'use strict';

/**
 * test-init-atomic.js — Regression suite for handoff init atomicity (#125).
 *
 * Before the fix, cmdInit wrote the project marker as its FIRST action,
 * before any DB operations.  A failure in the Phase-A schema transaction left
 * the marker on disk while printing "No FS writes made." — both false and
 * dangerous (every future session would try to load state from a DB that was
 * never provisioned).
 *
 * After the fix:
 *   - The UUID is minted in memory; the marker file is written LAST.
 *   - A FS-write ledger tracks every file this run creates.
 *   - On any failure the ledger is unwound in reverse (no orphaned files).
 *   - The failure message is accurate (ledger-based, not hard-coded).
 *
 * Coverage:
 *   A1  persistMarker() unit: writes a valid marker with a caller-supplied UUID.
 *   A2  persistMarker() unit: throws if marker already exists (no overwrite).
 *   A3  mintUUID() unit: returns a valid UUID v4; two calls produce distinct values.
 *   A4  Core atomicity: failure before FS writes leaves no project marker.
 *       Injection: subprocess points at an UNREACHABLE Postgres port (59999) via a
 *       minimal pipeline.yml in the temp project dir.  Preflight's Postgres-
 *       reachability check is fatal and exits before handoff.md or CLAUDE.md are
 *       written, so the ledger is empty and no marker can appear.
 *       PLATFORM-AGNOSTIC — no chmod required; runs on all platforms.
 *       NON-VACUOUS: the OLD code wrote the marker before any DB contact, so it
 *       WOULD leave a marker file here; the fixed code defers to last.
 *   A5  Failure message accuracy: output must NOT contain the stale pre-fix string
 *       "No FS writes made." when the ledger is empty.  Piggybacks on A4 setup.
 *       PLATFORM-AGNOSTIC.
 *   A6  Success path writes the marker LAST and produces a valid marker file.
 *       Uses a live throwaway DB (skipped if Postgres unavailable).
 *   A7  Re-init idempotency: running init twice on an already-provisioned project
 *       is safe and does NOT rewrite or duplicate the marker.
 *       Uses a live throwaway DB (skipped if Postgres unavailable).
 *   A8  FS-ledger unwind: handoff.md write succeeds, then CLAUDE.md write fails
 *       because the project ROOT DIRECTORY is non-writable (EACCES on new file
 *       creation).  Unwind removes handoff.md; marker is never written.
 *       Injection: fs.chmodSync(projectRoot, 0o555) — makes the directory itself
 *       read-only so creating a new file inside it fails with EACCES regardless
 *       of the target filename.  cmdInit checks fs.existsSync(claudeMdPath) first
 *       and only skips the write when the FILE already exists — a non-existent
 *       CLAUDE.md in a read-only directory is NOT skipped; the open()/write fails.
 *       POSIX only (chmod directory semantics; skipped on Windows).
 *       Asserts: "Rolled back" in output, no project marker, handoff.md removed.
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

/**
 * Probe whether the OS enforces read-only permission on directories.
 *
 * Creates a temporary probe directory, chmod 0o555 it, then attempts to write
 * a file inside it.  If the write SUCCEEDS the OS does not honour read-only
 * directory bits (no enforcement — e.g. Windows running as owner), so
 * chmod-based injection tests cannot be relied upon.  If the write THROWS
 * (EACCES / EPERM) the capability is present.
 *
 * The probe directory is always restored to 0o755 and removed in a finally
 * block so it cannot leak regardless of outcome.
 *
 * Returns true  → read-only-directory enforcement IS available (run A8).
 * Returns false → enforcement NOT available (skip A8).
 */
function chmodDirEnforced() {
  const probeDir = path.join(os.tmpdir(), `handoff_atomic_probe_${Date.now()}`);
  fs.mkdirSync(probeDir, { recursive: true });
  try {
    fs.chmodSync(probeDir, 0o555);
    try {
      fs.writeFileSync(path.join(probeDir, 'probe'), 'x', 'utf8');
      // Write succeeded — chmod not enforced on directories here.
      return false;
    } catch (_) {
      // Write threw (EACCES/EPERM) — enforcement is available.
      return true;
    }
  } finally {
    try { fs.chmodSync(probeDir, 0o755); } catch (_) {}
    try { fs.rmSync(probeDir, { recursive: true, force: true }); } catch (_) {}
  }
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

/**
 * Write a minimal pipeline.yml into <projectDir>/.claude/ so that loadConfig()
 * picks up a custom host/port instead of the ambient defaults.
 * Used by A4/A5 to point init at an unreachable Postgres port.
 */
function writePipelineYml(projectDir, host, port, dbName) {
  const claudeDir = path.join(projectDir, '.claude');
  fs.mkdirSync(claudeDir, { recursive: true });
  const yml = [
    'project:',
    `  name: atomic-test-${Date.now()}`,
    'knowledge:',
    `  host: ${host}`,
    `  port: ${port}`,
    `  database: ${dbName}`,
    '  user: postgres',
    '  tier: postgres',
  ].join('\n') + '\n';
  fs.writeFileSync(path.join(claudeDir, 'pipeline.yml'), yml, 'utf8');
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
      fail(label, 'marker file not written to disk'); return;
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
  const label = 'A2: persistMarker() throws if marker already exists (no overwrite)';
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

// ── A4: Core atomicity — DB-failure before FS writes leaves no marker ─────────
//
// Injection: write a minimal pipeline.yml inside the temp project dir that
// points to an UNREACHABLE Postgres port (59999).  loadConfig() picks this up
// because PROJECT_ROOT is set to the temp dir, so it finds .claude/pipeline.yml
// there.  runInitPreflight()'s "Postgres reachable" step (Step 3) fires first —
// it tries to open a TCP connection to port 59999 on localhost, which fails with
// ECONNREFUSED.  That step is fatal and cmdInit calls process.exit(1) before
// handoff.md or CLAUDE.md are written.  The FS ledger is therefore empty.
//
// PLATFORM-AGNOSTIC — no chmod, no admin rights required.
//
// NON-VACUOUS: the OLD code wrote the project marker as the very first
// action (before DB contact), so it WOULD leave the file behind here.  The fixed
// code defers the marker write to step 12 (last), so it is never reached when
// preflight fails at step 3.
//
// HANDOFF_DB is set to a throwaway name so that even if the port were somehow
// reachable the DB name is unknown and a second failure-gate exists.

async function testA4() {
  const label = 'A4: core atomicity — unreachable Postgres at preflight leaves no project marker';
  const tmpDir = makeTempDir('a4');
  try {
    // Point loadConfig() at a guaranteed-closed port via a local pipeline.yml.
    const throwawayDb = `handoff_atomic_a4_unreachable_${TS}`;
    writePipelineYml(tmpDir, 'localhost', 59999, throwawayDb);

    const r = runInit(throwawayDb, tmpDir);

    // Preflight must have failed (non-zero exit).
    if (r.status === 0) {
      fail(label, 'init unexpectedly succeeded with unreachable Postgres — injection did not fire'); return;
    }

    // Self-check: confirm the failure was Postgres-reachability, not something else.
    const combined = (r.stdout || '') + (r.stderr || '');
    if (!combined.includes('59999') && !combined.includes('reachable') && !combined.includes('connect')) {
      fail(label, `injection may not have fired — output does not mention port/reachable/connect: ${combined.slice(0, 400)}`); return;
    }

    // Core assertion: no project marker written.
    const markerPath = path.join(tmpDir, MARKER_FILENAME);
    if (fs.existsSync(markerPath)) {
      fail(label, 'marker written despite Postgres preflight failure — atomicity violated'); return;
    }

    pass(label);
  } catch (err) {
    fail(label, err.message);
  } finally {
    rmTempDir(tmpDir);
  }
}

// ── A5: failure message accuracy — stale pre-fix string must not appear ────────
//
// Piggybacks on the same unreachable-Postgres setup as A4.  The old code emitted
// the hardcoded string "No FS writes made." regardless of ledger state.  The new
// code derives the message from the ledger: empty ledger → "No filesystem changes
// were made." (accurate); non-empty ledger → "Rolled back filesystem writes..."
// (accurate).  Either is acceptable here (ledger IS empty for a preflight failure).
// What must NOT appear is the stale hardcoded pre-fix string.

async function testA5() {
  const label = 'A5: failure output does not contain stale "No FS writes made." message';
  const tmpDir = makeTempDir('a5');
  try {
    const throwawayDb = `handoff_atomic_a5_unreachable_${TS}`;
    writePipelineYml(tmpDir, 'localhost', 59999, throwawayDb);

    const r = runInit(throwawayDb, tmpDir);

    const combined = (r.stdout || '') + (r.stderr || '');

    // Core assertion: stale hardcoded pre-fix message must not appear.
    if (combined.includes('No FS writes made.')) {
      fail(label, 'output still contains stale "No FS writes made." message'); return;
    }

    // Sanity: init must have failed (preflight fatal).
    if (r.status === 0) {
      fail(label, 'init unexpectedly succeeded with unreachable Postgres — injection did not fire'); return;
    }

    pass(label);
  } catch (err) {
    fail(label, err.message);
  } finally {
    rmTempDir(tmpDir);
  }
}

// ── A6: success path writes marker LAST and produces a valid marker file ──────

async function testA6() {
  const label = 'A6: successful init writes project marker last with valid UUID';
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
      fail(label, 'marker file missing after successful init'); return;
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

// ── A8: FS-ledger unwind — read-only project root triggers CLAUDE.md failure ──
//
// Prove the multi-file ledger unwind path: when handoff.md write succeeds but
// CLAUDE.md write fails, the unwind removes handoff.md AND the marker is never
// written (step 12 follows step 11).
//
// Injection: fs.chmodSync(tmpDir, 0o555) — make the PROJECT ROOT DIRECTORY
// itself non-writable.  This is the correct injection because:
//
//   1. handoff.md is written to ~/.claude/projects/<uuid>/handoff.md — a
//      DIFFERENT directory that remains writable.  The write succeeds.
//   2. CLAUDE.md is written to <projectRoot>/CLAUDE.md.  cmdInit calls
//      fs.existsSync(claudeMdPath) first; since no CLAUDE.md exists in the
//      fresh tempDir, the existsSync check returns false and cmdInit does NOT
//      skip the write.  The subsequent fs.writeFileSync() call tries to create
//      a new file in a read-only directory, which fails with EACCES.
//   3. The ledger at that point contains [handoff.md].  unwindFsLedger() removes
//      it.  The marker (step 12) is never reached.
//
// Why a read-only FILE was wrong: cmdInit checks fs.existsSync(claudeMdPath)
// at step 11 and skips the write when the file already exists.  A pre-created
// read-only CLAUDE.md passes that check and the write is silently skipped —
// the injection never fires.  Making the DIRECTORY non-writable instead forces
// the open() syscall to fail on a file that does NOT exist yet.
//
// Assertions after failed re-init:
//   (a) marker absent (marker never written — step 12 never reached)
//   (b) output contains "Rolled back" (unwind log emitted by unwindFsLedger)
//   (c) handoff.md for the new UUID is absent (removed by unwind)
//   (d) output does NOT falsely say "No FS writes made" (ledger was non-empty)
//
// Requires read-only-directory enforcement (chmod 0o555 on a directory must
// prevent file creation inside it).  Skipped when that capability is absent —
// detected at runtime via a write probe, without referencing process.platform.
// Requires live Postgres (skipped if unavailable).

async function testA8() {
  const label = 'A8: FS-ledger unwind — read-only project root causes CLAUDE.md EACCES, handoff.md rolled back (POSIX)';
  if (!chmodDirEnforced()) {
    console.log(`SKIP  ${label} (read-only-directory enforcement not available on this platform)`);
    return;
  }
  const pgAvail = await isPgAvailable();
  if (!pgAvail) { console.log(`SKIP  ${label} (Postgres unavailable)`); return; }

  const dbName  = `handoff_atomic_a8_${TS}`;
  const tmpDir  = makeTempDir('a8');
  let   projId  = null;
  let   dirLocked = false;

  try {
    await createDb(dbName, tmpDir);

    // Phase 1: successful init to provision the DB schema.
    const r1 = runInit(dbName, tmpDir);
    if (r1.status !== 0) {
      fail(label, `phase-1 init failed: ${r1.stderr || r1.stdout}`); return;
    }
    const marker1 = readMarker(tmpDir);
    if (!marker1) { fail(label, 'no marker after phase-1 init'); return; }
    projId = marker1.uuid;

    // Remove marker and handoff.md so re-init goes through fresh FS writes.
    fs.rmSync(path.join(tmpDir, MARKER_FILENAME), { force: true });
    cleanupHandoffMd(projId);

    // Remove CLAUDE.md if phase-1 wrote it (it must be absent so cmdInit tries
    // to create a new one — which fails because the directory is read-only).
    const claudeMdPath = path.join(tmpDir, 'CLAUDE.md');
    fs.rmSync(claudeMdPath, { force: true });

    // Lock the project root directory.  Any attempt to create a new file inside
    // it (such as CLAUDE.md) will fail with EACCES.
    fs.chmodSync(tmpDir, 0o555);
    dirLocked = true;

    // Phase 2: re-init.
    //   - handoff.md write → ~/.claude/projects/<newUUID>/handoff.md → SUCCEEDS
    //   - CLAUDE.md write  → <tmpDir>/CLAUDE.md → EACCES (dir is read-only)
    //   - unwindFsLedger() → removes handoff.md
    //   - process.exit(1)
    const r2 = runInit(dbName, tmpDir);

    // Restore directory writability for cleanup (must happen before assertions
    // so rmTempDir() / dropDb() can proceed regardless of assertion outcome).
    fs.chmodSync(tmpDir, 0o755);
    dirLocked = false;

    // Self-check: injection must have fired (non-zero exit).
    if (r2.status === 0) {
      const out = (r2.stdout || '');
      if (out.includes('CLAUDE.md already exists')) {
        fail(label, 'test-design: cmdInit found CLAUDE.md already present and skipped the write — injection did not fire'); return;
      }
      fail(label, 're-init unexpectedly succeeded despite read-only project directory'); return;
    }

    const combined = (r2.stdout || '') + (r2.stderr || '');

    // (a) Marker must not exist.
    const markerPath = path.join(tmpDir, MARKER_FILENAME);
    if (fs.existsSync(markerPath)) {
      fail(label, 'marker written despite CLAUDE.md failure — atomicity violated'); return;
    }

    // (b) Output must mention "Rolled back" (unwind fired).
    if (!combined.includes('Rolled back')) {
      fail(label, `output does not mention "Rolled back" — unwind may not have fired: ${combined.slice(0, 400)}`); return;
    }

    // (c) handoff.md for the new UUID must be absent (removed by unwind).
    const uuidMatch = combined.match(/uuid=([0-9a-f-]{36})/i);
    if (uuidMatch) {
      const newUuid     = uuidMatch[1];
      const handoffPath = path.join(os.homedir(), '.claude', 'projects', newUuid, 'handoff.md');
      if (fs.existsSync(handoffPath)) {
        fail(label, 'handoff.md still exists after unwind — ledger did not clean it up'); return;
      }
      cleanupHandoffMd(newUuid);
    }

    // (d) Must NOT claim "No FS writes made" — the ledger had handoff.md in it.
    if (combined.includes('No filesystem changes were made.')) {
      fail(label, 'output falsely claims no FS changes while handoff.md was created and rolled back'); return;
    }

    pass(label);
  } catch (err) {
    fail(label, err.message);
  } finally {
    // Restore directory writability before cleanup, in case an early return left
    // it locked.
    if (dirLocked) {
      try { fs.chmodSync(tmpDir, 0o755); } catch (_) {}
    }
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
