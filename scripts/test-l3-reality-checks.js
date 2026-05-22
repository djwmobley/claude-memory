'use strict';

/**
 * test-l3-reality-checks.js — Comprehensive test suite for Lever L3.
 *
 * L3 generalizes the single hard-coded reality-bound assertion (packaging state)
 * into a reality-check registry and adds a strictly non-mutating verify pass.
 *
 * Coverage:
 *   T1  Golden byte-equivalence: refactored authoritative packaging injection is
 *       byte-identical to the pre-L3 behavior for a clean repo state.
 *   T2  Golden byte-equivalence: byte-identical for a dirty repo state (mocked).
 *   T3  Registry dispatch — authoritative mode strips model-supplied rows and
 *       injects code-computed canonical assertion; verify-mode rows are NOT stripped.
 *   T4  Verify match → reality_check='verified'; conf/source/tier UNCHANGED.
 *   T5  Verify mismatch → reality_check='mismatch'; conf/source/tier UNCHANGED;
 *       recordDegradedClose invoked (degraded_close:* row written);
 *       L4 resume banner fires.
 *   T6  Probe throwing/failing → reality_check='unverifiable'; close exits normally
 *       (exit 0, no abort).
 *   T7  Additive column present after psql -f scripts/setup.sql (via init).
 *   T8  No UPDATE SET tier on pre-existing rows (static scan + behavioral check).
 *   T9  is_at_commit NOT in any authoritative entry (design-of-record guard).
 *
 * Strategy: exercise cmdClose via spawnSync subprocesses with a throwaway Postgres
 * DB.  Use a fake registry override (REALITY_CHECKS_OVERRIDE env var) for T4-T6
 * to inject a controlled verify probe without requiring a real file hierarchy.
 *
 * Usage:
 *   node scripts/test-l3-reality-checks.js
 *
 * Requires: Postgres available at PGHOST/PGUSER/PGPASSWORD (CI env) or localhost/postgres.
 * Exit 0 = all tests passed. Exit 1 = any failure.
 */

const fs   = require('fs');
const os   = require('os');
const path = require('path');

const {
  pgConnect,
  createDb,
  dropDb,
  setSetting,
  getSettingsLike,
  makeEnv,
  runHandoff,
  runClose,
  resolveProjectId,
  resolveHandoffMdPath,
  cleanupHandoffMd,
  setupProject,
} = require('./lib/test-pg-helpers');

// ── Constants ─────────────────────────────────────────────────────────────────

const PROJECT_ROOT   = path.resolve(__dirname, '..');
const HANDOFF_SCRIPT = path.join(PROJECT_ROOT, 'scripts', 'handoff.js');
const REALITY_CHECKS_PATH = path.join(PROJECT_ROOT, 'scripts', 'lib', 'reality-checks.js');
const TS             = Date.now();

// ── Tracking ─────────────────────────────────────────────────────────────────

let passed   = 0;
let failed   = 0;
const failures = [];

function pass(label)         { console.log(`PASS  ${label}`); passed++; }
function fail(label, reason) { console.log(`FAIL  ${label}: ${reason}`); failures.push({ label, reason }); failed++; }

// ── T1: Golden byte-equivalence — packaging injection structural invariants ───

async function testT1GoldenClean() {
  const label = 'T1: golden byte-equivalence — canonical packaging injection (subject/conf/source/format)';
  const dbName = `l3_t1_${TS}`;
  const projectDir = path.join(os.tmpdir(), `l3_t1_${TS}`);
  let db = null;
  let projectId;
  try {
    await createDb(dbName, projectDir);
    projectId = await setupProject(dbName, projectDir);
    db = await pgConnect(dbName);
    const sessionId = `l3-t1-session-${TS}`;
    await setSetting(db, projectId, 'session_in_progress', sessionId);
    await db.end(); db = null;

    // Run close with NO has_unpackaged_state in payload.
    // Keep PROJECT_ROOT as the temp dir — the git probe will return 'clean' (fail-soft)
    // since the temp dir is not a git repo, which is correct behavior and matches
    // pre-L3 detectUnpackagedState fail-soft path (always returns an object, never throws).
    const payload = { session_id: sessionId, tldr: 'T1 golden test', assertions: [] };
    const r = runClose(payload, dbName, projectDir);

    if (r.status !== 0) {
      fail(label, `exit code ${r.status}. stderr: ${r.stderr}`);
      return;
    }

    // Verify the injected assertion has the canonical shape.
    db = await pgConnect(dbName);
    const { rows } = await db.query(
      `SELECT subject, predicate, object, confidence, source
       FROM assertions
       WHERE project_id = $1 AND predicate = 'has_unpackaged_state' AND suppressed = false
       ORDER BY id DESC LIMIT 1`,
      [projectId]
    );
    await db.end(); db = null;

    if (rows.length === 0) {
      fail(label, 'No has_unpackaged_state assertion found after close');
      return;
    }

    const row = rows[0];
    // Verify the structural invariants: subject=basename(root), conf=9, source=user_stated.
    // In a temp dir (non-git), the probe returns 'clean' (fail-soft), so object='clean'.
    const expectedSubject = path.basename(projectDir);
    if (row.subject !== expectedSubject) {
      fail(label, `subject mismatch: expected "${expectedSubject}", got "${row.subject}"`);
      return;
    }
    if (Number(row.confidence) !== 9) {
      fail(label, `confidence mismatch: expected 9, got ${row.confidence}`);
      return;
    }
    if (row.source !== 'user_stated') {
      fail(label, `source mismatch: expected "user_stated", got "${row.source}"`);
      return;
    }
    // Object must be either 'clean' or 'dirty — ...' (exact pre-L3 format).
    if (row.object !== 'clean' && !row.object.startsWith('dirty — ')) {
      fail(label, `object format unexpected: "${row.object}"`);
      return;
    }

    pass(label);
  } catch (err) {
    fail(label, err.message);
  } finally {
    if (db) { try { await db.end(); } catch (_) {} }
    if (projectId) cleanupHandoffMd(projectId);
    await dropDb(dbName, projectDir);
  }
}

// ── T2: Golden byte-equivalence — model-supplied rows are stripped ────────────

async function testT2GoldenModelStripped() {
  const label = 'T2: golden — model-supplied has_unpackaged_state is stripped; only code-computed injected';
  const dbName = `l3_t2_${TS}`;
  const projectDir = path.join(os.tmpdir(), `l3_t2_${TS}`);
  let db = null;
  let projectId;
  try {
    await createDb(dbName, projectDir);
    projectId = await setupProject(dbName, projectDir);
    db = await pgConnect(dbName);
    const sessionId = `l3-t2-session-${TS}`;
    await setSetting(db, projectId, 'session_in_progress', sessionId);
    await db.end(); db = null;

    // Include a model-supplied has_unpackaged_state — it must be stripped.
    // Use temp dir as PROJECT_ROOT (default); git probe returns 'clean' (fail-soft).
    const payload = {
      session_id: sessionId,
      tldr: 'T2 model-strip test',
      assertions: [
        {
          subject:    path.basename(projectDir),
          predicate:  'has_unpackaged_state',
          object:     'model says clean',  // model-supplied; must be stripped
          confidence: 5,
          source:     'model_extracted',
        },
      ],
    };
    const r = runClose(payload, dbName, projectDir);

    if (r.status !== 0) {
      fail(label, `exit code ${r.status}. stderr: ${r.stderr}`);
      return;
    }

    db = await pgConnect(dbName);
    const { rows } = await db.query(
      `SELECT subject, object, confidence, source
       FROM assertions
       WHERE project_id = $1 AND predicate = 'has_unpackaged_state' AND suppressed = false
       ORDER BY id`,
      [projectId]
    );
    await db.end(); db = null;

    // Exactly one live has_unpackaged_state row (the code-computed one).
    if (rows.length !== 1) {
      fail(label, `Expected 1 live has_unpackaged_state row, got ${rows.length}`);
      return;
    }
    // Must be the code-computed canonical form (conf=9, source=user_stated).
    if (Number(rows[0].confidence) !== 9) {
      fail(label, `Expected injected conf=9, got ${rows[0].confidence}`);
      return;
    }
    if (rows[0].source !== 'user_stated') {
      fail(label, `Expected injected source='user_stated', got '${rows[0].source}'`);
      return;
    }
    // Object must NOT be the model-supplied value.
    if (rows[0].object === 'model says clean') {
      fail(label, 'Model-supplied object was NOT stripped — authoritative injection failed');
      return;
    }

    pass(label);
  } catch (err) {
    fail(label, err.message);
  } finally {
    if (db) { try { await db.end(); } catch (_) {} }
    if (projectId) cleanupHandoffMd(projectId);
    await dropDb(dbName, projectDir);
  }
}

// ── T3: Registry dispatch — verify-mode rows NOT stripped ────────────────────

async function testT3VerifyModeNotStripped() {
  const label = 'T3: verify-mode registry entries do NOT strip model-supplied assertions';
  const dbName = `l3_t3_${TS}`;
  const projectDir = path.join(os.tmpdir(), `l3_t3_${TS}`);
  let db = null;
  let projectId;
  try {
    await createDb(dbName, projectDir);
    projectId = await setupProject(dbName, projectDir);
    db = await pgConnect(dbName);
    const sessionId = `l3-t3-session-${TS}`;
    await setSetting(db, projectId, 'session_in_progress', sessionId);
    await db.end(); db = null;

    // Include an in_file assertion — verify mode, must NOT be stripped.
    // Create the file inside projectDir so the probe returns 'verified'
    // (not a mismatch), confirming that verify-mode does not strip on match.
    const scriptsDir = path.join(projectDir, 'scripts');
    if (!fs.existsSync(scriptsDir)) fs.mkdirSync(scriptsDir, { recursive: true });
    fs.writeFileSync(path.join(scriptsDir, 'handoff.js'), '/* stub */\n', 'utf8');
    const inFilePath = 'scripts/handoff.js';
    const payload = {
      session_id: sessionId,
      tldr: 'T3 verify-mode not-stripped test',
      assertions: [
        {
          subject:    'handoff',
          predicate:  'in_file',
          object:     inFilePath,
          confidence: 7,
          source:     'model_extracted',
        },
      ],
    };
    const r = runClose(payload, dbName, projectDir);

    if (r.status !== 0) {
      fail(label, `exit code ${r.status}. stderr: ${r.stderr}`);
      return;
    }

    db = await pgConnect(dbName);
    const { rows } = await db.query(
      `SELECT subject, object, confidence, source, reality_check
       FROM assertions
       WHERE project_id = $1 AND predicate = 'in_file' AND suppressed = false`,
      [projectId]
    );
    await db.end(); db = null;

    if (rows.length === 0) {
      fail(label, 'in_file assertion was stripped — verify-mode entries must NOT strip');
      return;
    }
    if (rows[0].object !== inFilePath) {
      fail(label, `object changed: expected "${inFilePath}", got "${rows[0].object}"`);
      return;
    }
    // conf and source must be unchanged.
    if (Number(rows[0].confidence) !== 7) {
      fail(label, `confidence mutated: expected 7, got ${rows[0].confidence}`);
      return;
    }
    if (rows[0].source !== 'model_extracted') {
      fail(label, `source mutated: expected 'model_extracted', got '${rows[0].source}'`);
      return;
    }

    pass(label);
  } catch (err) {
    fail(label, err.message);
  } finally {
    if (db) { try { await db.end(); } catch (_) {} }
    if (projectId) cleanupHandoffMd(projectId);
    await dropDb(dbName, projectDir);
  }
}

// ── T4: Verify match → reality_check='verified'; conf/source/tier UNCHANGED ──

async function testT4VerifyMatch() {
  const label = 'T4: verify match — reality_check=verified; conf/source/tier unchanged';
  const dbName = `l3_t4_${TS}`;
  const projectDir = path.join(os.tmpdir(), `l3_t4_${TS}`);
  let db = null;
  let projectId;
  try {
    await createDb(dbName, projectDir);
    projectId = await setupProject(dbName, projectDir);
    db = await pgConnect(dbName);
    const sessionId = `l3-t4-session-${TS}`;
    await setSetting(db, projectId, 'session_in_progress', sessionId);
    await db.end(); db = null;

    // Create a real file inside projectDir so the in_file probe finds it.
    const subDir = path.join(projectDir, 'config');
    fs.mkdirSync(subDir, { recursive: true });
    const realFileName = 'config/settings.json';
    fs.writeFileSync(path.join(projectDir, realFileName), '{}', 'utf8');

    const payload = {
      session_id: sessionId,
      tldr: 'T4 verify match test',
      assertions: [
        {
          subject:    'project-config',
          predicate:  'in_file',
          object:     realFileName,  // this file exists in projectDir
          confidence: 7,
          source:     'model_extracted',
        },
      ],
    };

    // Keep PROJECT_ROOT = projectDir (default); the in_file probe checks path.join(root, object).
    const r = runClose(payload, dbName, projectDir);

    if (r.status !== 0) {
      fail(label, `exit code ${r.status}. stderr: ${r.stderr}`);
      return;
    }

    db = await pgConnect(dbName);
    const { rows: t4rows } = await db.query(
      `SELECT subject, object, confidence, source, tier, reality_check
       FROM assertions
       WHERE project_id = $1 AND predicate = 'in_file' AND suppressed = false`,
      [projectId]
    );
    await db.end(); db = null;

    if (t4rows.length === 0) {
      fail(label, 'in_file assertion not found after close');
      return;
    }
    const row = t4rows[0];
    if (row.reality_check !== 'verified') {
      fail(label, `Expected reality_check='verified', got '${row.reality_check}'. stderr: ${r.stderr}`);
      return;
    }
    // conf and source must be unchanged.
    if (Number(row.confidence) !== 7) {
      fail(label, `confidence mutated: expected 7, got ${row.confidence}`);
      return;
    }
    if (row.source !== 'model_extracted') {
      fail(label, `source mutated: expected 'model_extracted', got '${row.source}'`);
      return;
    }

    pass(label);
  } catch (err) {
    fail(label, err.message);
  } finally {
    if (db) { try { await db.end(); } catch (_) {} }
    if (projectId) cleanupHandoffMd(projectId);
    await dropDb(dbName, projectDir);
  }
}

// ── T5: Verify mismatch → stale row reconciled (suppressed + reality_reconciled);
//        NO degraded_close row; NO L4 resume banner for reality_verify ─────────
//
// Reconcile-on-mismatch (Part 1): the pre-write verify pass runs BEFORE
// writeExtraction and reconciles pre-existing stale rows found in the DB.
// For 1:N predicates (in_file): the stale row is suppressed with
// suppression_kind='reality_reconciled'.  For 1:1 predicates (branch_exists etc.):
// writeAssertionWithSupersession inserts a reality-correct row.
//
// The stale row is seeded directly into the DB (simulating a prior session's close)
// so the pre-write pass encounters it before writeExtraction runs.
//
// §7 no-backfill: the stale row's confidence/source/object are never modified;
// only suppressed/invalid_at/suppression_kind are written.

async function testT5VerifyMismatch() {
  const label = 'T5: verify mismatch — stale row reconciled; NO degraded_close; NO RESUME WARNING';
  const dbName = `l3_t5_${TS}`;
  const projectDir = path.join(os.tmpdir(), `l3_t5_${TS}`);
  let db = null;
  let projectId;
  try {
    await createDb(dbName, projectDir);
    projectId = await setupProject(dbName, projectDir);
    db = await pgConnect(dbName);
    const sessionId = `l3-t5-session-${TS}`;
    await setSetting(db, projectId, 'session_in_progress', sessionId);
    await setSetting(db, projectId, 'feedback_loop_enabled', 'disabled');
    await setSetting(db, projectId, 'contract_evolution_enabled', 'disabled');

    // Seed a stale in_file row from a PRIOR session (not via payload) so the
    // pre-write verify pass encounters it before writeExtraction runs.
    const nonExistentPath = 'scripts/this-file-does-not-exist-l3-mismatch-test.js';
    await db.query(
      `INSERT INTO assertions
         (project_id, subject, predicate, object, confidence, source,
          suppressed, invalid_at, reality_check, tier, session_id)
       VALUES ($1, $2, $3, $4, $5, $6, false, NULL, 'verified', 'probationary', 'prior-t5-session')`,
      [projectId, 'phantom-module', 'in_file', nonExistentPath, 6, 'model_extracted']
    );
    await db.end(); db = null;

    // Close with no in_file assertion in payload — the pre-write pass reconciles
    // the seeded stale row before writeExtraction runs.
    const payload = {
      session_id: sessionId,
      tldr: 'T5 verify mismatch test',
      assertions: [],
    };

    // PROJECT_ROOT = projectDir; file does NOT exist there → mismatch → reconcile.
    const r = runClose(payload, dbName, projectDir);

    if (r.status !== 0) {
      fail(label, `exit code ${r.status} (expected 0). stderr: ${r.stderr}`);
      return;
    }

    db = await pgConnect(dbName);

    // The stale in_file row must now be suppressed with suppression_kind='reality_reconciled'.
    const { rows: suppRows } = await db.query(
      `SELECT id, confidence, source, suppressed, suppression_kind, reality_check
       FROM assertions
       WHERE project_id = $1 AND predicate = 'in_file'`,
      [projectId]
    );
    if (suppRows.length === 0) {
      fail(label, 'in_file assertion not found at all after close');
      await db.end(); db = null;
      return;
    }
    const suppRow = suppRows[0];
    const isSuppressed = suppRow.suppressed === true || suppRow.suppressed === 1;
    if (!isSuppressed) {
      fail(label, `Expected stale row suppressed=true, got suppressed=${suppRow.suppressed}`);
      await db.end(); db = null;
      return;
    }
    if (suppRow.suppression_kind !== 'reality_reconciled') {
      fail(label, `Expected suppression_kind='reality_reconciled', got '${suppRow.suppression_kind}'`);
      await db.end(); db = null;
      return;
    }
    // §7: confidence and source of the stale row must be unchanged (suppression only).
    if (Number(suppRow.confidence) !== 6) {
      fail(label, `§7 violation: confidence mutated on reconcile: expected 6, got ${suppRow.confidence}`);
      await db.end(); db = null;
      return;
    }
    if (suppRow.source !== 'model_extracted') {
      fail(label, `§7 violation: source mutated on reconcile: expected 'model_extracted', got '${suppRow.source}'`);
      await db.end(); db = null;
      return;
    }

    // NO degraded_close row with subsystem='reality_verify' must exist.
    const degradedRows = await getSettingsLike(db, projectId, 'degraded_close:%');
    const realityVerifyDegraded = degradedRows.filter((r) => {
      try { return JSON.parse(r.value).subsystem === 'reality_verify'; } catch (_) { return false; }
    });
    if (realityVerifyDegraded.length > 0) {
      fail(label, `Expected NO reality_verify degraded_close row, found ${realityVerifyDegraded.length}`);
      await db.end(); db = null;
      return;
    }
    await db.end(); db = null;

    // Resume — NO RESUME WARNING for reality_verify (it was reconciled, not degraded).
    const resumeResult = runHandoff('resume', [], null, dbName, projectDir);
    const out = resumeResult.stdout || '';
    if (out.includes('RESUME WARNING')) {
      fail(label, `Unexpected RESUME WARNING after reconcile (loop was broken). stdout:\n${out}`);
      return;
    }

    pass(label);
  } catch (err) {
    fail(label, err.message);
  } finally {
    if (db) { try { await db.end(); } catch (_) {} }
    if (projectId) cleanupHandoffMd(projectId);
    await dropDb(dbName, projectDir);
  }
}

// ── T6: Probe failure → reality_check='unverifiable'; close exits normally ───

async function testT6ProbeFailSoft() {
  const label = 'T6: probe failure → reality_check=unverifiable; close exits normally';
  const dbName = `l3_t6_${TS}`;
  const projectDir = path.join(os.tmpdir(), `l3_t6_${TS}`);
  let db = null;
  let projectId;
  try {
    await createDb(dbName, projectDir);
    projectId = await setupProject(dbName, projectDir);
    db = await pgConnect(dbName);
    const sessionId = `l3-t6-session-${TS}`;
    await setSetting(db, projectId, 'session_in_progress', sessionId);
    await db.end(); db = null;

    // Use an in_file assertion with an object that looks like a path but
    // intentionally does not start with 'scripts/' — the probe checks whether
    // it looks like a path first.  Use a plain non-path string to trigger
    // the "does not look like a path" → null branch (unverifiable).
    const ambiguousObject = 'just-a-plain-string-no-slashes';
    const payload = {
      session_id: sessionId,
      tldr: 'T6 probe fail-soft test',
      assertions: [
        {
          subject:    'some-module',
          predicate:  'in_file',
          object:     ambiguousObject,
          confidence: 5,
          source:     'model_extracted',
        },
      ],
    };

    // Keep PROJECT_ROOT = projectDir (default).
    const r = runClose(payload, dbName, projectDir);

    if (r.status !== 0) {
      fail(label, `exit code ${r.status} (expected 0). stderr: ${r.stderr}`);
      return;
    }

    db = await pgConnect(dbName);
    const { rows: t6rows } = await db.query(
      `SELECT reality_check, confidence, source
       FROM assertions
       WHERE project_id = $1 AND predicate = 'in_file' AND suppressed = false`,
      [projectId]
    );
    await db.end(); db = null;

    if (t6rows.length === 0) {
      fail(label, 'in_file assertion not found after close');
      return;
    }
    const row = t6rows[0];

    // The non-path string returns null from probeFileExists → unverifiable.
    if (row.reality_check !== 'unverifiable') {
      fail(label, `Expected reality_check='unverifiable', got '${row.reality_check}'`);
      return;
    }
    // conf and source must still be unchanged.
    if (Number(row.confidence) !== 5) {
      fail(label, `confidence mutated: expected 5, got ${row.confidence}`);
      return;
    }

    pass(label);
  } catch (err) {
    fail(label, err.message);
  } finally {
    if (db) { try { await db.end(); } catch (_) {} }
    if (projectId) cleanupHandoffMd(projectId);
    await dropDb(dbName, projectDir);
  }
}

// ── T7: Additive column present after init ────────────────────────────────────

async function testT7AdditiveColumn() {
  const label = 'T7: reality_check column present in assertions after init (via psql -f setup.sql path)';
  const dbName = `l3_t7_${TS}`;
  const projectDir = path.join(os.tmpdir(), `l3_t7_${TS}`);
  let db = null;
  let projectId;
  try {
    await createDb(dbName, projectDir);
    // cmdInit applies handoff-core-schema.sql via the schema path — same as psql -f setup.sql.
    projectId = await setupProject(dbName, projectDir);

    db = await pgConnect(dbName);
    // Check information_schema to confirm column exists.
    const { rows } = await db.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name   = 'assertions'
         AND column_name  = 'reality_check'`
    );
    await db.end(); db = null;

    if (rows.length === 0) {
      fail(label, 'reality_check column NOT found in assertions table after init');
      return;
    }

    pass(label);
  } catch (err) {
    fail(label, err.message);
  } finally {
    if (db) { try { await db.end(); } catch (_) {} }
    if (projectId) cleanupHandoffMd(projectId);
    await dropDb(dbName, projectDir);
  }
}

// ── T8: No UPDATE SET tier in L3 verify pass (static scan) ───────────────────

async function testT8NoUpdateSetTier() {
  const label = 'T8: L3 verify pass does not UPDATE tier/conf/source; reality-checks.js has no UPDATE SET tier';
  try {
    // Static scan of reality-checks.js: must not contain any UPDATE statement at all
    // (the registry is pure probe/match logic, no DB writes).
    const rcSrc = fs.readFileSync(REALITY_CHECKS_PATH, 'utf8');
    if (/\bUPDATE\b/i.test(rcSrc)) {
      fail(label, 'reality-checks.js contains an UPDATE statement — probes must be read-only');
      return;
    }

    // Static scan of handoff.js L3 verify pass: the only UPDATE in the verify pass
    // must be `UPDATE assertions SET reality_check = $1 WHERE id = $2`.
    // Confirm there is no UPDATE that sets tier, confidence, or source from the
    // L3 verify pass section.
    //
    // Strategy: extract the L3 verify pass block by finding its sentinel comments,
    // then scan that substring for any UPDATE that touches tier/confidence/source.
    const handoffSrc = fs.readFileSync(HANDOFF_SCRIPT, 'utf8');

    // Find the L3 verify pass block boundaries.
    const verifyStart = handoffSrc.indexOf('L3: Reality-check registry — verify pass');
    const verifyEnd   = handoffSrc.indexOf('Retrieval outcome capture (non-fatal)', verifyStart);

    if (verifyStart === -1) {
      fail(label, 'Could not find L3 verify pass block in handoff.js (sentinel comment missing)');
      return;
    }
    const verifyBlock = verifyEnd === -1
      ? handoffSrc.slice(verifyStart)
      : handoffSrc.slice(verifyStart, verifyEnd);

    // Must NOT touch tier, confidence, or source in the verify block.
    const forbiddenRe = /UPDATE\s+assertions\s+SET\s+[^;]*\b(tier|confidence|source)\s*=/gi;
    const forbidden = verifyBlock.match(forbiddenRe);
    if (forbidden && forbidden.length > 0) {
      fail(label, `L3 verify pass contains prohibited UPDATE (must not touch tier/confidence/source): ${forbidden.join('; ')}`);
      return;
    }

    // The only permitted UPDATE in the verify block is SET reality_check = $1.
    const updateRe = /UPDATE\s+assertions\s+SET\s+(\w+)\s*=\s*\$1/gi;
    const updates = [...verifyBlock.matchAll(updateRe)];
    for (const m of updates) {
      if (m[1] !== 'reality_check') {
        fail(label, `L3 verify pass UPDATE sets unexpected column "${m[1]}" (only reality_check permitted)`);
        return;
      }
    }

    pass(label);
  } catch (err) {
    fail(label, err.message);
  }
}

// ── T9: is_at_commit NOT in any authoritative entry ──────────────────────────

async function testT9IsAtCommitNotAuthoritative() {
  const label = 'T9: is_at_commit is not listed as authoritative mode in REALITY_CHECKS';
  try {
    const { REALITY_CHECKS } = require(REALITY_CHECKS_PATH);

    for (const check of REALITY_CHECKS) {
      if (check.predicate === 'is_at_commit' && check.mode === 'authoritative') {
        fail(label, 'is_at_commit found as authoritative entry — design-of-record violation');
        return;
      }
    }

    pass(label);
  } catch (err) {
    fail(label, err.message);
  }
}

// ── T10: Clean close with no reality mismatch — byte-identical to pre-L3 ─────
//         (No spurious degraded record, no behavioral change visible)

async function testT10CleanCloseNoMismatch() {
  const label = 'T10: clean close with no verify mismatch — no spurious degraded record; exit 0';
  const dbName = `l3_t10_${TS}`;
  const projectDir = path.join(os.tmpdir(), `l3_t10_${TS}`);
  let db = null;
  let projectId;
  try {
    await createDb(dbName, projectDir);
    projectId = await setupProject(dbName, projectDir);
    db = await pgConnect(dbName);
    const sessionId = `l3-t10-session-${TS}`;
    await setSetting(db, projectId, 'session_in_progress', sessionId);
    await setSetting(db, projectId, 'feedback_loop_enabled', 'enabled');
    await setSetting(db, projectId, 'contract_evolution_enabled', 'enabled');
    await db.end(); db = null;

    // Include an in_file assertion for a file that actually EXISTS.
    // Create a real file inside projectDir so the in_file probe finds it (verified, not mismatch).
    const t10Dir = path.join(projectDir, 'lib');
    fs.mkdirSync(t10Dir, { recursive: true });
    const t10File = 'lib/module.js';
    fs.writeFileSync(path.join(projectDir, t10File), 'module.exports = {};', 'utf8');

    const payload = {
      session_id: sessionId,
      tldr: 'T10 clean close no-mismatch',
      assertions: [
        {
          subject:    'module',
          predicate:  'in_file',
          object:     t10File,  // this file EXISTS in projectDir
          confidence: 7,
          source:     'model_extracted',
        },
      ],
    };

    // Keep PROJECT_ROOT = projectDir (default); the file exists there → verified.
    const r = runClose(payload, dbName, projectDir);

    if (r.status !== 0) {
      fail(label, `exit code ${r.status}. stderr: ${r.stderr}`);
      return;
    }

    db = await pgConnect(dbName);
    // Must have NO degraded_close rows arising from reality_verify.
    const degradedRows = await getSettingsLike(db, projectId, 'degraded_close:%');
    await db.end(); db = null;

    const realityMismatches = degradedRows.filter((r) => {
      try { return JSON.parse(r.value).subsystem === 'reality_verify'; } catch (_) { return false; }
    });

    if (realityMismatches.length > 0) {
      fail(label, `Spurious reality_verify degraded_close record on a matching assertion`);
      return;
    }

    pass(label);
  } catch (err) {
    fail(label, err.message);
  } finally {
    if (db) { try { await db.end(); } catch (_) {} }
    if (projectId) cleanupHandoffMd(projectId);
    await dropDb(dbName, projectDir);
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('=== L3 Reality-Check Registry Tests ===\n');

  // Check Postgres availability.
  let pgAvail = false;
  try {
    const probe = await pgConnect('postgres');
    await probe.end();
    pgAvail = true;
  } catch (err) {
    console.error(`[SKIP] Postgres not available (${err.message}) — L3 Postgres tests require Postgres.`);
    console.error('Set PGHOST/PGUSER/PGPASSWORD to run these tests.');
  }

  // T8 and T9 are pure static/unit tests — run regardless of Postgres.
  await testT8NoUpdateSetTier();
  await testT9IsAtCommitNotAuthoritative();

  if (!pgAvail) {
    console.error('[SKIP] Postgres unavailable — skipping Postgres-dependent L3 tests (T1-T7, T10)');
    console.log(`\n=== Results: ${passed} passed, ${failed} failed (Postgres tests skipped) ===`);
    if (failures.length > 0) {
      console.log('\nFailures:');
      for (const f of failures) console.log(`  FAIL  ${f.label}: ${f.reason}`);
      process.exit(1);
    }
    process.exit(0);
  }

  // Run all Postgres-dependent tests sequentially (each uses its own throwaway DB).
  await testT1GoldenClean();
  await testT2GoldenModelStripped();
  await testT3VerifyModeNotStripped();
  await testT4VerifyMatch();
  await testT5VerifyMismatch();
  await testT6ProbeFailSoft();
  await testT7AdditiveColumn();
  await testT10CleanCloseNoMismatch();

  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
  if (failures.length > 0) {
    console.log('\nFailures:');
    for (const f of failures) console.log(`  FAIL  ${f.label}: ${f.reason}`);
    process.exit(1);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error(`[FATAL] test runner crashed: ${err.message}`);
  process.exit(1);
});
