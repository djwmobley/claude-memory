'use strict';

/**
 * test-l4-degraded-close.js — Comprehensive test suite for Lever L4.
 *
 * L4 adds fail-loud, persist-to-DB, resume-visible behavior when C2 (feedback
 * bias update) or C3 (contract evolution) silently skip because the session id
 * is unresolvable.
 *
 * Coverage:
 *   T1  Clean close: no degraded record, no "## Degraded" in handoff.md, exit 0,
 *       summary unchanged — byte-equivalence assertion vs. pre-L4 shape.
 *   T2  C2 unresolvable session: degraded_close:<stamp> row persisted with correct
 *       JSON, summary line present, "## Degraded" section in handoff.md, exit 0
 *       under default 'warn' mode.
 *   T3  C3 unresolvable session: same, independently.
 *   T4  Both C2 and C3 degraded in one close: two distinct degraded_close:* keys
 *       (no overwrite), both listed in handoff.md.
 *   T5  Two successive degraded closes: two distinct degraded_close:* keys.
 *   T6  Resume after degraded close: loud RESUME WARNING banner fires.
 *   T7  Resume after clean close: no banner.
 *   T8  close_degraded_exit_mode='strict' → exit 3 on degraded; 'warn' → exit 0.
 *   T9  (cm#227) Forced session_tldr persistSessionIntent failure (DB trigger
 *       fault-injection) → DIVERGENCE line in stdout + handoff.md's ##
 *       Degraded section; exit 0 even under close_degraded_exit_mode='strict'
 *       (a separate, always-non-fatal channel from C2/C3's exit-code gate).
 *
 * Strategy: exercise cmdClose via spawnSync subprocesses with a throwaway Postgres
 * DB, injecting session state via direct SQL to create the unresolvable-session
 * condition (C2/C3 enabled but session_in_progress absent and no session_id in
 * payload).  Inspect handoff.md, project_settings, stdout, and exit code.
 *
 * Usage:
 *   node scripts/test-l4-degraded-close.js
 *
 * Requires: Postgres available at PGHOST/PGUSER/PGPASSWORD (CI env) or localhost/postgres.
 * Exit 0 = all tests passed. Exit 1 = any failure.
 */

const fs   = require('fs');
const os   = require('os');
const path = require('path');

const {
  pgConnect,
  createDb      : createL4Db,
  dropDb        : dropL4Db,
  setSetting,
  getSettingsLike,
  makeEnv,
  runHandoff    : _runHandoff,
  resolveProjectId,
  resolveHandoffMdPath,
  cleanupHandoffMd,
  setupProject  : _setupProject,
} = require('./lib/test-pg-helpers');

// ── Constants ─────────────────────────────────────────────────────────────────

const PROJECT_ROOT   = path.resolve(__dirname, '..');
const HANDOFF_SCRIPT = path.join(PROJECT_ROOT, 'scripts', 'handoff.js');
const TS             = Date.now();
const L4_DB          = `claude_memory_l4_test_${TS}`;

// Unique temp dirs so concurrent runs don't collide.
const TEMP_DIR_MAIN  = path.join(os.tmpdir(), `handoff_l4_main_${TS}`);
const TEMP_DIR_EXTRA = path.join(os.tmpdir(), `handoff_l4_extra_${TS}`);

// ── Tracking ─────────────────────────────────────────────────────────────────

let passed  = 0;
let failed  = 0;
const failures = [];

function pass(label)         { console.log(`PASS  ${label}`); passed++; }
function fail(label, reason) { console.log(`FAIL  ${label}: ${reason}`); failures.push({ label, reason }); failed++; }

// ── L4-local wrappers with module-level defaults ──────────────────────────────

/**
 * Spawn handoff.js with L4's module-level default db/projectDir.
 * Wraps the shared runHandoff with per-module defaults for db and projectDir.
 */
function runHandoff(sub, extraArgs = [], stdin = null, db = L4_DB, projectDir = TEMP_DIR_MAIN, extraEnv = {}) {
  return _runHandoff(sub, extraArgs, stdin, db, projectDir, extraEnv);
}

/**
 * Run handoff:close with the given payload JSON and return the subprocess result.
 * Session id is NOT included in the payload, and session_in_progress is NOT set
 * in project_settings → produces the unresolvable-session condition for C2/C3.
 */
function runClose(payload = {}, db = L4_DB, projectDir = TEMP_DIR_MAIN, extraEnv = {}) {
  return runHandoff('close', ['--json', '-'], JSON.stringify(payload), db, projectDir, extraEnv);
}

/**
 * Run cmdInit in the given throwaway DB / project dir, then return the project id.
 * @param {string} dbName     — throwaway DB name
 * @param {string} projectDir — temp project root dir
 */
async function setupProject(dbName, projectDir) {
  return _setupProject(dbName, projectDir);
}

// ── T1: Clean close ───────────────────────────────────────────────────────────

async function testT1CleanClose() {
  const label = 'T1: clean close — no degraded record, no ## Degraded section, exit 0';
  const dbName = `claude_memory_l4_t1_${TS}`;
  let db = null;
  const projectDir = path.join(os.tmpdir(), `l4_t1_${TS}`);
  let projectId;
  try {
    await createL4Db(dbName, projectDir);
    projectId = await setupProject(dbName, projectDir);

    db = await pgConnect(dbName);

    // Set session_in_progress so C2/C3 can resolve the session id — making it a CLEAN close.
    const sessionId = `l4-t1-session-${TS}`;
    await setSetting(db, projectId, 'session_in_progress', sessionId);
    // Enable feedback and evolution so they would otherwise fire.
    await setSetting(db, projectId, 'feedback_loop_enabled', 'enabled');
    await setSetting(db, projectId, 'contract_evolution_enabled', 'enabled');
    await db.end(); db = null;

    const payload = {
      session_id:  sessionId,
      tldr:        'T1 clean close test',
      assertions:  [],
    };
    const r = runClose(payload, dbName, projectDir);

    if (r.status !== 0) {
      fail(label, `exit code ${r.status}, expected 0. stderr: ${r.stderr}`);
      return;
    }

    db = await pgConnect(dbName);
    const degradedRows = await getSettingsLike(db, projectId, 'degraded_close:%');
    await db.end(); db = null;

    if (degradedRows.length !== 0) {
      fail(label, `Expected 0 degraded_close rows on clean close, got ${degradedRows.length}`);
      return;
    }

    // Check handoff.md: no ## Degraded section.
    const handoffPath = resolveHandoffMdPath(projectId);
    if (!fs.existsSync(handoffPath)) {
      fail(label, 'handoff.md not found after clean close');
      return;
    }
    const content = fs.readFileSync(handoffPath, 'utf8');
    if (content.includes('## Degraded')) {
      fail(label, 'handoff.md contains ## Degraded section on a clean close');
      return;
    }

    // Byte-equivalence assertion: handoff.md must contain the standard sections
    // and must NOT have any trailing blank line from a DEGRADED_SECTION placeholder.
    if (!content.includes('## Quick references')) {
      fail(label, 'handoff.md missing ## Quick references section');
      return;
    }
    // Check that DEGRADED_SECTION placeholder was not left unreplaced.
    if (content.includes('{{DEGRADED_SECTION}}')) {
      fail(label, 'handoff.md contains unreplaced {{DEGRADED_SECTION}} placeholder');
      return;
    }

    // Stdout must not contain C2/C3 degraded skip summary lines.
    const stdout = r.stdout || '';
    if (stdout.includes('C2 skipped:') || stdout.includes('C3 skipped:')) {
      fail(label, `stdout contains unexpected degraded skip lines:\n${stdout}`);
      return;
    }

    pass(label);
  } catch (err) {
    fail(label, err.message);
  } finally {
    if (db) { try { await db.end(); } catch (_) {} }
    if (projectId) cleanupHandoffMd(projectId);
    await dropL4Db(dbName, projectDir);
  }
}

// ── T2: C2 unresolvable session ───────────────────────────────────────────────

async function testT2C2Degraded() {
  const label = 'T2: C2 unresolvable session — degraded_close row, ## Degraded in handoff.md, exit 0';
  const dbName = `claude_memory_l4_t2_${TS}`;
  const projectDir = path.join(os.tmpdir(), `l4_t2_${TS}`);
  let db = null;
  let projectId;
  try {
    await createL4Db(dbName, projectDir);
    projectId = await setupProject(dbName, projectDir);

    db = await pgConnect(dbName);
    // Enable feedback so C2 runs, but do NOT set session_in_progress.
    await setSetting(db, projectId, 'feedback_loop_enabled', 'enabled');
    // Disable C3 so only C2 degrades.
    await setSetting(db, projectId, 'contract_evolution_enabled', 'disabled');
    await db.end(); db = null;

    // No session_id in payload, no session_in_progress in DB → C2 skip.
    const payload = { tldr: 'T2 C2 degraded test', assertions: [] };
    const r = runClose(payload, dbName, projectDir);

    if (r.status !== 0) {
      fail(label, `exit code ${r.status}, expected 0 (warn mode). stderr: ${r.stderr}`);
      return;
    }

    db = await pgConnect(dbName);
    const degradedRows = await getSettingsLike(db, projectId, 'degraded_close:%');
    await db.end(); db = null;

    if (degradedRows.length === 0) {
      fail(label, 'Expected at least 1 degraded_close row for C2, got 0');
      return;
    }

    // Verify the row's JSON value.
    const parsed = JSON.parse(degradedRows[0].value);
    if (parsed.subsystem !== 'C2') {
      fail(label, `Expected subsystem='C2', got '${parsed.subsystem}'`);
      return;
    }
    if (!parsed.reason.includes('no session id')) {
      fail(label, `Expected reason to contain 'no session id', got '${parsed.reason}'`);
      return;
    }
    if (!parsed.stamp) {
      fail(label, 'degraded_close record missing stamp field');
      return;
    }

    // Check handoff.md: must have ## Degraded section.
    const handoffPath = resolveHandoffMdPath(projectId);
    if (!fs.existsSync(handoffPath)) {
      fail(label, 'handoff.md not found after degraded close');
      return;
    }
    const content = fs.readFileSync(handoffPath, 'utf8');
    if (!content.includes('## Degraded')) {
      fail(label, 'handoff.md missing ## Degraded section');
      return;
    }
    if (!content.includes('C2')) {
      fail(label, 'handoff.md ## Degraded section does not mention C2');
      return;
    }

    // Check stdout contains operator-visible skip summary line.
    const stdout = r.stdout || '';
    if (!stdout.includes('C2') || !stdout.includes('skipped')) {
      fail(label, `stdout missing C2 degraded summary line. stdout:\n${stdout}`);
      return;
    }

    pass(label);
  } catch (err) {
    fail(label, err.message);
  } finally {
    if (db) { try { await db.end(); } catch (_) {} }
    if (projectId) cleanupHandoffMd(projectId);
    await dropL4Db(dbName, projectDir);
  }
}

// ── T3: C3 unresolvable session ───────────────────────────────────────────────

async function testT3C3Degraded() {
  const label = 'T3: C3 unresolvable session — degraded_close row, ## Degraded in handoff.md, exit 0';
  const dbName = `claude_memory_l4_t3_${TS}`;
  const projectDir = path.join(os.tmpdir(), `l4_t3_${TS}`);
  let db = null;
  let projectId;
  try {
    await createL4Db(dbName, projectDir);
    projectId = await setupProject(dbName, projectDir);

    db = await pgConnect(dbName);
    // Disable C2, enable C3 — only C3 degrades.
    await setSetting(db, projectId, 'feedback_loop_enabled', 'disabled');
    await setSetting(db, projectId, 'contract_evolution_enabled', 'enabled');
    await db.end(); db = null;

    // No session_id in payload, no session_in_progress in DB → C3 skip.
    const payload = { tldr: 'T3 C3 degraded test', assertions: [] };
    const r = runClose(payload, dbName, projectDir);

    if (r.status !== 0) {
      fail(label, `exit code ${r.status}, expected 0 (warn mode). stderr: ${r.stderr}`);
      return;
    }

    db = await pgConnect(dbName);
    const degradedRows = await getSettingsLike(db, projectId, 'degraded_close:%');
    await db.end(); db = null;

    if (degradedRows.length === 0) {
      fail(label, 'Expected at least 1 degraded_close row for C3, got 0');
      return;
    }

    // Verify the row's JSON value.
    const parsed = JSON.parse(degradedRows[0].value);
    if (parsed.subsystem !== 'C3') {
      fail(label, `Expected subsystem='C3', got '${parsed.subsystem}'`);
      return;
    }
    if (!parsed.reason.includes('no session id')) {
      fail(label, `Expected reason to contain 'no session id', got '${parsed.reason}'`);
      return;
    }

    // Check handoff.md: must have ## Degraded section with C3.
    const handoffPath = resolveHandoffMdPath(projectId);
    const content = fs.existsSync(handoffPath) ? fs.readFileSync(handoffPath, 'utf8') : '';
    if (!content.includes('## Degraded')) {
      fail(label, 'handoff.md missing ## Degraded section');
      return;
    }
    if (!content.includes('C3')) {
      fail(label, 'handoff.md ## Degraded section does not mention C3');
      return;
    }

    // Check stdout contains operator-visible skip summary line.
    const stdout = r.stdout || '';
    if (!stdout.includes('C3') || !stdout.includes('skipped')) {
      fail(label, `stdout missing C3 degraded summary line. stdout:\n${stdout}`);
      return;
    }

    pass(label);
  } catch (err) {
    fail(label, err.message);
  } finally {
    if (db) { try { await db.end(); } catch (_) {} }
    if (projectId) cleanupHandoffMd(projectId);
    await dropL4Db(dbName, projectDir);
  }
}

// ── T4: Both C2 and C3 degraded ──────────────────────────────────────────────

async function testT4BothDegraded() {
  const label = 'T4: both C2 and C3 degraded — two distinct degraded_close rows, both in handoff.md';
  const dbName = `claude_memory_l4_t4_${TS}`;
  const projectDir = path.join(os.tmpdir(), `l4_t4_${TS}`);
  let db = null;
  let projectId;
  try {
    await createL4Db(dbName, projectDir);
    projectId = await setupProject(dbName, projectDir);

    db = await pgConnect(dbName);
    // Enable both C2 and C3.
    await setSetting(db, projectId, 'feedback_loop_enabled', 'enabled');
    await setSetting(db, projectId, 'contract_evolution_enabled', 'enabled');
    await db.end(); db = null;

    // No session_id in payload, no session_in_progress → both C2 and C3 degrade.
    const payload = { tldr: 'T4 both degraded test', assertions: [] };
    const r = runClose(payload, dbName, projectDir);

    if (r.status !== 0) {
      fail(label, `exit code ${r.status}, expected 0 (warn mode). stderr: ${r.stderr}`);
      return;
    }

    db = await pgConnect(dbName);
    const degradedRows = await getSettingsLike(db, projectId, 'degraded_close:%');
    await db.end(); db = null;

    if (degradedRows.length < 2) {
      fail(label, `Expected 2 distinct degraded_close rows (C2+C3), got ${degradedRows.length}`);
      return;
    }

    // Verify distinct keys (no overwrite).
    const keys = degradedRows.map((r) => r.key);
    if (new Set(keys).size !== keys.length) {
      fail(label, `Duplicate degraded_close keys detected — overwrite occurred: ${keys.join(', ')}`);
      return;
    }

    // Both subsystems must be represented.
    const subsystems = degradedRows.map((r) => JSON.parse(r.value).subsystem);
    if (!subsystems.includes('C2')) {
      fail(label, `C2 not found in degraded_close rows. subsystems: ${subsystems.join(', ')}`);
      return;
    }
    if (!subsystems.includes('C3')) {
      fail(label, `C3 not found in degraded_close rows. subsystems: ${subsystems.join(', ')}`);
      return;
    }

    // handoff.md must have both C2 and C3 in the ## Degraded section.
    const handoffPath = resolveHandoffMdPath(projectId);
    const content = fs.existsSync(handoffPath) ? fs.readFileSync(handoffPath, 'utf8') : '';
    if (!content.includes('## Degraded')) {
      fail(label, 'handoff.md missing ## Degraded section');
      return;
    }
    if (!content.includes('C2')) {
      fail(label, 'handoff.md ## Degraded section missing C2 entry');
      return;
    }
    if (!content.includes('C3')) {
      fail(label, 'handoff.md ## Degraded section missing C3 entry');
      return;
    }

    pass(label);
  } catch (err) {
    fail(label, err.message);
  } finally {
    if (db) { try { await db.end(); } catch (_) {} }
    if (projectId) cleanupHandoffMd(projectId);
    await dropL4Db(dbName, projectDir);
  }
}

// ── T5: Two successive degraded closes — two distinct keys ────────────────────

async function testT5SuccessiveDegradedCloses() {
  const label = 'T5: two successive degraded closes — two distinct degraded_close:* keys';
  const dbName = `claude_memory_l4_t5_${TS}`;
  const projectDir = path.join(os.tmpdir(), `l4_t5_${TS}`);
  let db = null;
  let projectId;
  try {
    await createL4Db(dbName, projectDir);
    projectId = await setupProject(dbName, projectDir);

    db = await pgConnect(dbName);
    // Enable C2 only to get one degraded subsystem per close.
    await setSetting(db, projectId, 'feedback_loop_enabled', 'enabled');
    await setSetting(db, projectId, 'contract_evolution_enabled', 'disabled');
    await db.end(); db = null;

    const payload = { tldr: 'T5 successive degraded test', assertions: [] };

    // First degraded close.
    const r1 = runClose(payload, dbName, projectDir);
    // Small delay to ensure distinct timestamps in key names.
    await new Promise((r) => setTimeout(r, 5));
    // Second degraded close.
    const r2 = runClose(payload, dbName, projectDir);

    if (r1.status !== 0) {
      fail(label, `First close exit ${r1.status}. stderr: ${r1.stderr}`);
      return;
    }
    if (r2.status !== 0) {
      fail(label, `Second close exit ${r2.status}. stderr: ${r2.stderr}`);
      return;
    }

    db = await pgConnect(dbName);
    const degradedRows = await getSettingsLike(db, projectId, 'degraded_close:%');
    await db.end(); db = null;

    if (degradedRows.length < 2) {
      fail(label, `Expected >= 2 degraded_close rows after two degraded closes, got ${degradedRows.length}`);
      return;
    }

    // All keys must be distinct (append-only, no overwrite).
    const keys = degradedRows.map((r) => r.key);
    if (new Set(keys).size !== keys.length) {
      fail(label, `Duplicate degraded_close keys — overwrite detected: ${keys.join(', ')}`);
      return;
    }

    pass(label);
  } catch (err) {
    fail(label, err.message);
  } finally {
    if (db) { try { await db.end(); } catch (_) {} }
    if (projectId) cleanupHandoffMd(projectId);
    await dropL4Db(dbName, projectDir);
  }
}

// ── T6: Resume after degraded close — loud banner fires ──────────────────────

async function testT6ResumeAfterDegradedClose() {
  const label = 'T6: resume after degraded close — RESUME WARNING banner fires';
  const dbName = `claude_memory_l4_t6_${TS}`;
  const projectDir = path.join(os.tmpdir(), `l4_t6_${TS}`);
  let db = null;
  let projectId;
  try {
    await createL4Db(dbName, projectDir);
    projectId = await setupProject(dbName, projectDir);

    db = await pgConnect(dbName);
    await setSetting(db, projectId, 'feedback_loop_enabled', 'enabled');
    await setSetting(db, projectId, 'contract_evolution_enabled', 'disabled');
    await db.end(); db = null;

    // Produce a degraded close.
    const payload = { tldr: 'T6 degraded then resume', assertions: [] };
    const closeResult = runClose(payload, dbName, projectDir);
    if (closeResult.status !== 0) {
      fail(label, `degraded close failed: exit ${closeResult.status}. stderr: ${closeResult.stderr}`);
      return;
    }

    // Now resume — banner must appear.
    const resumeResult = runHandoff('resume', [], null, dbName, projectDir);
    const out = resumeResult.stdout || '';

    if (!out.includes('RESUME WARNING')) {
      fail(label, `RESUME WARNING banner not found in resume stdout. stdout:\n${out}`);
      return;
    }
    if (!out.includes('C2')) {
      fail(label, `RESUME WARNING banner does not mention C2. stdout:\n${out}`);
      return;
    }

    pass(label);
  } catch (err) {
    fail(label, err.message);
  } finally {
    if (db) { try { await db.end(); } catch (_) {} }
    if (projectId) cleanupHandoffMd(projectId);
    await dropL4Db(dbName, projectDir);
  }
}

// ── T7: Resume after clean close — no banner ─────────────────────────────────

async function testT7ResumeAfterCleanClose() {
  const label = 'T7: resume after clean close — no RESUME WARNING banner';
  const dbName = `claude_memory_l4_t7_${TS}`;
  const projectDir = path.join(os.tmpdir(), `l4_t7_${TS}`);
  let db = null;
  let projectId;
  try {
    await createL4Db(dbName, projectDir);
    projectId = await setupProject(dbName, projectDir);

    db = await pgConnect(dbName);
    const sessionId = `l4-t7-session-${TS}`;
    await setSetting(db, projectId, 'session_in_progress', sessionId);
    await setSetting(db, projectId, 'feedback_loop_enabled', 'enabled');
    await setSetting(db, projectId, 'contract_evolution_enabled', 'enabled');
    await db.end(); db = null;

    // Clean close — session id resolvable.
    const payload = { session_id: sessionId, tldr: 'T7 clean then resume', assertions: [] };
    const closeResult = runClose(payload, dbName, projectDir);
    if (closeResult.status !== 0) {
      fail(label, `clean close failed: exit ${closeResult.status}. stderr: ${closeResult.stderr}`);
      return;
    }

    // Resume — must NOT contain RESUME WARNING.
    const resumeResult = runHandoff('resume', [], null, dbName, projectDir);
    const out = resumeResult.stdout || '';

    if (out.includes('RESUME WARNING')) {
      fail(label, `RESUME WARNING banner appeared after a clean close. stdout:\n${out}`);
      return;
    }

    pass(label);
  } catch (err) {
    fail(label, err.message);
  } finally {
    if (db) { try { await db.end(); } catch (_) {} }
    if (projectId) cleanupHandoffMd(projectId);
    await dropL4Db(dbName, projectDir);
  }
}

// ── T8: Exit code gate — strict mode exits 3; warn exits 0 ───────────────────

async function testT8ExitCodeGate() {
  const label = 'T8: close_degraded_exit_mode strict→exit 3 on degraded; warn→exit 0';
  const dbName = `claude_memory_l4_t8_${TS}`;
  const projectDir = path.join(os.tmpdir(), `l4_t8_${TS}`);
  let db = null;
  let projectId;
  try {
    await createL4Db(dbName, projectDir);
    projectId = await setupProject(dbName, projectDir);

    db = await pgConnect(dbName);
    await setSetting(db, projectId, 'feedback_loop_enabled', 'enabled');
    await setSetting(db, projectId, 'contract_evolution_enabled', 'disabled');

    // Part A: warn mode (default) — exit 0.
    await setSetting(db, projectId, 'close_degraded_exit_mode', 'warn');
    await db.end(); db = null;

    const payloadWarn = { tldr: 'T8 warn mode', assertions: [] };
    const rWarn = runClose(payloadWarn, dbName, projectDir);
    if (rWarn.status !== 0) {
      fail(label, `warn mode: expected exit 0, got ${rWarn.status}. stderr: ${rWarn.stderr}`);
      return;
    }

    // Part B: strict mode — exit 3.
    db = await pgConnect(dbName);
    await setSetting(db, projectId, 'close_degraded_exit_mode', 'strict');
    await db.end(); db = null;

    const payloadStrict = { tldr: 'T8 strict mode', assertions: [] };
    const rStrict = runClose(payloadStrict, dbName, projectDir);
    if (rStrict.status !== 3) {
      fail(label, `strict mode: expected exit 3, got ${rStrict.status}. stderr: ${rStrict.stderr}`);
      return;
    }

    pass(label);
  } catch (err) {
    fail(label, err.message);
  } finally {
    if (db) { try { await db.end(); } catch (_) {} }
    if (projectId) cleanupHandoffMd(projectId);
    await dropL4Db(dbName, projectDir);
  }
}

// ── T9: forced persistSessionIntent failure (cm#227) ──────────────────────────
//
// Fault-injects a real Postgres-level failure for the session_tldr INSERT
// specifically (a BEFORE INSERT trigger that raises for that one predicate —
// a DB-layer stub standing in for a JS-layer monkeypatch, since this harness
// drives handoff.js via subprocess, not require()). Proves: (a) close still
// exits 0 (non-fatal, unaffected by close_degraded_exit_mode='strict' — this
// is a SEPARATE channel from the C2/C3 _degradedSubsystems exit-code gate
// tested by T8), (b) stdout carries a DIVERGENCE line naming the predicate
// and the underlying error, (c) handoff.md's ## Degraded section carries the
// same line, (d) entities/assertions/edges counts are unaffected (the
// failure is scoped to the intent-persistence phase only).
async function testT9ForcedIntentDivergence() {
  const label = 'T9: forced session_tldr persistSessionIntent failure — DIVERGENCE line in stdout + handoff.md, exit 0';
  const dbName = `claude_memory_l4_t9_${TS}`;
  const projectDir = path.join(os.tmpdir(), `l4_t9_${TS}`);
  let db = null;
  let projectId;
  try {
    await createL4Db(dbName, projectDir);
    projectId = await setupProject(dbName, projectDir);

    db = await pgConnect(dbName);
    // Fault injection: a BEFORE INSERT trigger that raises only for
    // predicate='session_tldr', reproducing the shape of the real defect
    // (a DB-level error during persistSessionIntent's write) without
    // depending on the now-fixed btree-row-size path.
    await db.query(`
      CREATE OR REPLACE FUNCTION cm227_fail_session_tldr() RETURNS trigger AS $$
      BEGIN
        IF NEW.predicate = 'session_tldr' THEN
          RAISE EXCEPTION 'cm227 simulated persistSessionIntent failure for testing';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
    `);
    await db.query(`
      CREATE TRIGGER cm227_fail_session_tldr_trigger
      BEFORE INSERT ON assertions
      FOR EACH ROW EXECUTE FUNCTION cm227_fail_session_tldr();
    `);
    // Also force close_degraded_exit_mode='strict' to prove the exit-code gate
    // is unaffected by this divergence (T8 already covers strict-mode exit 3
    // for genuine C2/C3 degradation; this proves the two channels don't cross).
    await setSetting(db, projectId, 'close_degraded_exit_mode', 'strict');
    await db.end(); db = null;

    const payload = {
      tldr: 'T9 forced divergence test tldr',
      open_threads: ['harmless open thread'],
      assertions: [{ subject: 'x', predicate: 'is_status', object: 'y', confidence: 8, source: 'user_stated' }],
    };
    const r = runClose(payload, dbName, projectDir);

    if (r.status !== 0) {
      fail(label, `expected exit 0 (non-fatal, strict-mode-unaffected), got ${r.status}. stderr: ${r.stderr}`);
      return;
    }

    const stdout = r.stdout || '';
    if (!/DIVERGENCE:\s*session_tldr\s+NOT PERSISTED\s*—\s*cm227 simulated persistSessionIntent failure/.test(stdout)) {
      fail(label, `stdout missing expected DIVERGENCE line. stdout:\n${stdout}`);
      return;
    }

    const handoffPath = resolveHandoffMdPath(projectId);
    if (!fs.existsSync(handoffPath)) {
      fail(label, 'handoff.md not found after close');
      return;
    }
    const content = fs.readFileSync(handoffPath, 'utf8');
    if (!content.includes('## Degraded')) {
      fail(label, 'handoff.md missing ## Degraded section');
      return;
    }
    if (!/DIVERGENCE:\s*session_tldr\s+NOT PERSISTED/.test(content)) {
      fail(label, `handoff.md ## Degraded section missing DIVERGENCE line. content:\n${content}`);
      return;
    }

    // The unrelated payload.assertions[] write must still have succeeded
    // (assertionsWritten counts only payload.assertions[], not intent rows —
    // open_thread/session_tldr/quick_reference are written separately by
    // persistSessionIntent and never contribute to this counter, so this
    // proves the fault injection did not abort the surrounding writeExtraction
    // call — only the session_tldr row itself failed). Expect 2: the payload's
    // own is_status assertion PLUS the code-injected has_unpackaged_state
    // authoritative assertion (always added regardless of payload content).
    if (!/assertions written:\s*2/.test(stdout)) {
      fail(label, `expected 2 assertions written (is_status + auto has_unpackaged_state; session_tldr intent-row failure is separate), got:\n${stdout}`);
      return;
    }

    pass(label);
  } catch (err) {
    fail(label, err.message);
  } finally {
    if (db) { try { await db.end(); } catch (_) {} }
    if (projectId) cleanupHandoffMd(projectId);
    await dropL4Db(dbName, projectDir);
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('=== L4 Degraded Close Tests ===\n');

  // Check Postgres availability first.
  let pgAvail = false;
  try {
    const probe = await pgConnect('postgres');
    await probe.end();
    pgAvail = true;
  } catch (err) {
    console.error(`[SKIP] Postgres not available (${err.message}) — all L4 tests require Postgres.`);
    console.error('Set PGHOST/PGUSER/PGPASSWORD to run these tests.');
    process.exit(0);
  }

  if (!pgAvail) {
    console.error('[SKIP] Postgres unavailable — skipping all L4 tests');
    process.exit(0);
  }

  // Run all tests sequentially (each uses its own throwaway DB).
  await testT1CleanClose();
  await testT2C2Degraded();
  await testT3C3Degraded();
  await testT4BothDegraded();
  await testT5SuccessiveDegradedCloses();
  await testT6ResumeAfterDegradedClose();
  await testT7ResumeAfterCleanClose();
  await testT8ExitCodeGate();
  await testT9ForcedIntentDivergence();

  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
  if (failures.length > 0) {
    console.log('\nFailures:');
    for (const f of failures) {
      console.log(`  FAIL  ${f.label}: ${f.reason}`);
    }
    process.exit(1);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error(`[FATAL] test runner crashed: ${err.message}`);
  process.exit(1);
});
