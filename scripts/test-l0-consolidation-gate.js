'use strict';

/**
 * test-l0-consolidation-gate.js — Comprehensive test suite for Lever L0.
 *
 * L0 severs the single-close consolidation forge (Attack 1): previously, a single
 * close could self-stamp source='user_stated', confidence=9 and produce a
 * tier='consolidated' row with zero independent or cross-session basis.
 *
 * L0 gates the FULL newTier consolidated-birth decision on genuine cross-session
 * corroboration when the consolidation_corroboration_gate setting is 'enforce'
 * (the default). Only persisted, distinct prior close rows from a different session_id
 * satisfy the gate — the closing model cannot fabricate those in a single close.
 *
 * Coverage:
 *   T1  Attack-1 closed: single self-stamped close (source='user_stated', conf=9,
 *       no prior corroboration) → row born probationary (NOT consolidated). Core
 *       security assertion.
 *   T2  Genuine corroboration consolidates (1:N): same (s,p,o) persisted across ≥2
 *       distinct prior close sessions → row IS born consolidated.
 *   T3  Genuine corroboration consolidates (1:1): same (s,p,o) persisted across ≥2
 *       distinct prior close sessions (1:1 predicate) → row IS born consolidated.
 *   T4  Payload-supplied session_id does NOT satisfy the gate: a single close that
 *       supplies a session_id duplicating a payload-only value cannot forge
 *       corroboration → still probationary.
 *   T5  Pinned operator override still works: pinned=true rows are exempt from
 *       auto-suppression — the suppression-exemption path is unaffected by L0.
 *   T6  disabled setting → byte-identical to pre-L0: a self-stamped conf=9 close
 *       under consolidation_corroboration_gate='disabled' produces consolidated,
 *       exactly matching pre-L0 behavior.
 *   T7  No UPDATE SET tier on pre-existing rows: static scan confirms L0 introduces
 *       no tier mutation of pre-existing rows; behavioral check confirms an existing
 *       consolidated row is not re-evaluated.
 *   T8  Non-isHighTrust consolidation path also gated (defense-in-depth): 1:N
 *       corroboration alone does not consolidate under enforce when corroboration is
 *       faked via a same-session re-assertion.
 *
 * Strategy: exercise cmdClose and direct DB writes with a throwaway Postgres DB.
 * Corroboration is produced by direct SQL INSERT of a prior close row (not via
 * payload session_id) to prove the gate reads genuinely persisted prior rows.
 *
 * Usage:
 *   node scripts/test-l0-consolidation-gate.js
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
  makeEnv,
  runHandoff,
  runClose,
  resolveProjectId,
  cleanupHandoffMd,
  setupProject,
} = require('./lib/test-pg-helpers');

// ── Constants ─────────────────────────────────────────────────────────────────

const PROJECT_ROOT   = path.resolve(__dirname, '..');
const HANDOFF_SCRIPT = path.join(PROJECT_ROOT, 'scripts', 'handoff.js');
const TS             = Date.now();

// ── Tracking ─────────────────────────────────────────────────────────────────

let passed   = 0;
let failed   = 0;
const failures = [];

function pass(label)         { console.log(`PASS  ${label}`); passed++; }
function fail(label, reason) { console.log(`FAIL  ${label}: ${reason}`); failures.push({ label, reason }); failed++; }

// ── T1: Attack-1 closed — single self-stamped close stays probationary ────────

async function testT1AttackOneClosed() {
  const label = 'T1: Attack-1 closed — single self-stamped close (source=user_stated, conf=9) → probationary (NOT consolidated)';
  const dbName     = `claude_memory_l0_t1_${TS}`;
  const projectDir = path.join(os.tmpdir(), `l0_t1_${TS}`);
  let db = null;
  let projectId;
  try {
    await createDb(dbName, projectDir);
    projectId = await setupProject(dbName, projectDir);

    db = await pgConnect(dbName);
    // Ensure enforce mode (it is the default, but set explicitly to be precise).
    await setSetting(db, projectId, 'consolidation_corroboration_gate', 'enforce');
    await db.end(); db = null;

    // Single close: model self-stamps source='user_stated', confidence=9.
    // No prior persisted rows for this (subject, predicate, object) in any session.
    const sessionId = `l0-t1-session-${TS}`;
    const payload = {
      session_id: sessionId,
      tldr: 'T1 single-session self-stamp test',
      assertions: [{
        subject:    'project',
        predicate:  'has_tag',
        object:     'l0-test-attack1',
        confidence: 9,
        source:     'user_stated',
      }],
    };
    const r = runClose(payload, dbName, projectDir);
    if (r.status !== 0) {
      fail(label, `close exited ${r.status}: ${r.stderr}`);
      return;
    }

    db = await pgConnect(dbName);
    const { rows } = await db.query(
      `SELECT tier, consolidated_at FROM assertions
       WHERE project_id = $1
         AND subject = 'project'
         AND predicate = 'has_tag'
         AND object = 'l0-test-attack1'
         AND suppressed = false`,
      [projectId]
    );
    await db.end(); db = null;

    if (rows.length === 0) {
      fail(label, 'Assertion not found after close');
      return;
    }
    const row = rows[0];
    if (row.tier !== 'probationary') {
      fail(label, `Expected tier='probationary', got '${row.tier}'. Attack-1 forge not severed.`);
      return;
    }
    if (row.consolidated_at !== null) {
      fail(label, `Expected consolidated_at=NULL on probationary row, got ${row.consolidated_at}`);
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

// ── T2: Genuine corroboration consolidates (1:N) ──────────────────────────────

async function testT2GenuineCorroborationN() {
  const label = 'T2: genuine 1:N corroboration — 2 distinct prior-session persisted rows → consolidated';
  const dbName     = `claude_memory_l0_t2_${TS}`;
  const projectDir = path.join(os.tmpdir(), `l0_t2_${TS}`);
  let db = null;
  let projectId;
  try {
    await createDb(dbName, projectDir);
    projectId = await setupProject(dbName, projectDir);

    db = await pgConnect(dbName);
    await setSetting(db, projectId, 'consolidation_corroboration_gate', 'enforce');
    // L2 quality-corroborator requirement: with consolidation_gate_mode='enforce' (now
    // the default), genuine cross-session corroboration ALSO requires the corroborating
    // prior row to be independently trustworthy (reality_check='verified' OR pinned=true).
    // This test sets reality_check='verified' on the prior row so the L2 arm(b)
    // quality-corroborator predicate passes. This is the correct post-L2 behavior:
    // genuine corroboration by a trusted source → consolidated; by an unverified
    // source → probationary (the L2 patient-adversary gate).
    // consolidation_gate_mode defaults to 'enforce' from cmdInit; no explicit set needed.

    // Inject a prior persisted row directly — simulates a prior close from a different session.
    // The predicate 'has_tag' is 1:N; we insert with a distinct session_id.
    // reality_check='verified' satisfies the L2 quality-corroborator gate (arm a/b).
    const priorSessionId = `l0-t2-prior-session-${TS}`;
    await db.query(
      `INSERT INTO assertions
         (project_id, subject, predicate, object, confidence, source, session_id,
          last_reinforced, valid_at, tier, consolidated_at, corroboration_count,
          reality_check)
       VALUES ($1, $2, $3, $4, $5, $6, $7, now(), now(), $8, NULL, 1, 'verified')`,
      [projectId, 'project', 'has_tag', 'l0-test-genuine-n',
       9, 'user_stated', priorSessionId, 'probationary']
    );
    await db.end(); db = null;

    // Now close from a DIFFERENT session — same (s,p,o).
    const newSessionId = `l0-t2-new-session-${TS}`;
    const payload = {
      session_id: newSessionId,
      tldr: 'T2 genuine 1:N corroboration',
      assertions: [{
        subject:    'project',
        predicate:  'has_tag',
        object:     'l0-test-genuine-n',
        confidence: 9,
        source:     'user_stated',
      }],
    };
    const r = runClose(payload, dbName, projectDir);
    if (r.status !== 0) {
      fail(label, `close exited ${r.status}: ${r.stderr}`);
      return;
    }

    db = await pgConnect(dbName);
    const { rows } = await db.query(
      `SELECT tier, consolidated_at FROM assertions
       WHERE project_id = $1
         AND subject = 'project'
         AND predicate = 'has_tag'
         AND object = 'l0-test-genuine-n'
         AND suppressed = false`,
      [projectId]
    );
    await db.end(); db = null;

    if (rows.length === 0) {
      fail(label, 'No live assertion row found after close');
      return;
    }
    const row = rows[0];
    if (row.tier !== 'consolidated') {
      fail(label, `Expected tier='consolidated' on genuinely corroborated row, got '${row.tier}'`);
      return;
    }
    if (!row.consolidated_at) {
      fail(label, 'Expected consolidated_at to be set, got NULL');
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

// ── T3: Genuine corroboration consolidates (1:1) ──────────────────────────────

async function testT3GenuineCorroboration1() {
  const label = 'T3: genuine 1:1 corroboration — 2 distinct prior-session rows → consolidated';
  const dbName     = `claude_memory_l0_t3_${TS}`;
  const projectDir = path.join(os.tmpdir(), `l0_t3_${TS}`);
  let db = null;
  let projectId;
  try {
    await createDb(dbName, projectDir);
    projectId = await setupProject(dbName, projectDir);

    db = await pgConnect(dbName);
    await setSetting(db, projectId, 'consolidation_corroboration_gate', 'enforce');
    // L2 quality-corroborator requirement: same as T2. The prior row must have
    // reality_check='verified' OR pinned=true to satisfy L2 arm(a/b) under the
    // new 'enforce' default. This mirrors the expected production path where a
    // verified prior row provides the trust anchor for consolidation.

    // Inject a prior persisted row for a 1:1 predicate ('is_at_commit' is 1:1).
    // Use a well-known 1:1 predicate from the registry.
    // reality_check='verified' satisfies the L2 quality-corroborator gate.
    const priorSessionId = `l0-t3-prior-session-${TS}`;
    await db.query(
      `INSERT INTO assertions
         (project_id, subject, predicate, object, confidence, source, session_id,
          last_reinforced, valid_at, tier, consolidated_at, corroboration_count,
          reality_check)
       VALUES ($1, $2, $3, $4, $5, $6, $7, now(), now(), $8, NULL, 1, 'verified')`,
      [projectId, 'project', 'is_at_commit', 'abc123corroboration',
       9, 'user_stated', priorSessionId, 'probationary']
    );
    await db.end(); db = null;

    // Close from a DIFFERENT session — same (s,p,o) for 1:1 predicate.
    const newSessionId = `l0-t3-new-session-${TS}`;
    const payload = {
      session_id: newSessionId,
      tldr: 'T3 genuine 1:1 corroboration',
      assertions: [{
        subject:    'project',
        predicate:  'is_at_commit',
        object:     'abc123corroboration',
        confidence: 9,
        source:     'user_stated',
      }],
    };
    const r = runClose(payload, dbName, projectDir);
    if (r.status !== 0) {
      fail(label, `close exited ${r.status}: ${r.stderr}`);
      return;
    }

    db = await pgConnect(dbName);
    const { rows } = await db.query(
      `SELECT tier, consolidated_at FROM assertions
       WHERE project_id = $1
         AND subject = 'project'
         AND predicate = 'is_at_commit'
         AND object = 'abc123corroboration'
         AND suppressed = false`,
      [projectId]
    );
    await db.end(); db = null;

    if (rows.length === 0) {
      fail(label, 'No live assertion row found after close');
      return;
    }
    const row = rows[0];
    if (row.tier !== 'consolidated') {
      fail(label, `Expected tier='consolidated' on genuinely 1:1-corroborated row, got '${row.tier}'`);
      return;
    }
    if (!row.consolidated_at) {
      fail(label, 'Expected consolidated_at to be set, got NULL');
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

// ── T4: Payload-supplied session_id does NOT satisfy the gate ─────────────────

async function testT4PayloadSessionIdNotSufficient() {
  const label = 'T4: payload-supplied session_id cannot forge corroboration — still probationary';
  const dbName     = `claude_memory_l0_t4_${TS}`;
  const projectDir = path.join(os.tmpdir(), `l0_t4_${TS}`);
  let db = null;
  let projectId;
  try {
    await createDb(dbName, projectDir);
    projectId = await setupProject(dbName, projectDir);

    db = await pgConnect(dbName);
    await setSetting(db, projectId, 'consolidation_corroboration_gate', 'enforce');
    await db.end(); db = null;

    // Single close — the model supplies a session_id in the payload, but there is
    // NO genuinely persisted prior row from a different session in the DB.
    // The gate checks persisted DB rows, NOT the payload-supplied session_id.
    const sessionId = `l0-t4-attacker-session-${TS}`;
    const payload = {
      session_id: sessionId,
      tldr: 'T4 payload-session-id forgery attempt',
      assertions: [{
        subject:    'project',
        predicate:  'has_tag',
        object:     'l0-test-forgery-attempt',
        confidence: 9,
        source:     'user_stated',
      }],
    };
    const r = runClose(payload, dbName, projectDir);
    if (r.status !== 0) {
      fail(label, `close exited ${r.status}: ${r.stderr}`);
      return;
    }

    db = await pgConnect(dbName);
    const { rows } = await db.query(
      `SELECT tier FROM assertions
       WHERE project_id = $1
         AND subject = 'project'
         AND predicate = 'has_tag'
         AND object = 'l0-test-forgery-attempt'
         AND suppressed = false`,
      [projectId]
    );
    await db.end(); db = null;

    if (rows.length === 0) {
      fail(label, 'No assertion row found after close');
      return;
    }
    if (rows[0].tier !== 'probationary') {
      fail(label, `Expected tier='probationary', got '${rows[0].tier}'. Payload session_id forged the gate.`);
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

// ── T5: Pinned operator override still works ──────────────────────────────────

async function testT5PinnedStillWorks() {
  const label = 'T5: pinned=true rows exempt from auto-suppression — pinned path unaffected by L0';
  const dbName     = `claude_memory_l0_t5_${TS}`;
  const projectDir = path.join(os.tmpdir(), `l0_t5_${TS}`);
  let db = null;
  let projectId;
  try {
    // Static check: db-seam.js buildSupersessionUpdate must contain the pinned guard
    // (the WHERE clause that skips pinned rows). This confirms L0 did not accidentally
    // remove or alter the pinned exemption in the suppression path.
    const seamsrc = fs.readFileSync(
      path.join(PROJECT_ROOT, 'scripts', 'lib', 'db-seam.js'), 'utf8'
    );
    if (!seamsrc.includes('pinned')) {
      fail(label, 'Static check: db-seam.js lost the pinned guard entirely');
      return;
    }
    // The pinned guard in buildSupersessionUpdate should exclude pinned rows from suppression.
    // Check for the pattern: AND (pinned = false OR pinned IS NULL) or AND pinned = 0
    if (!seamsrc.includes('pinned = 0') && !seamsrc.includes('pinned = false')) {
      fail(label, 'Static check: buildSupersessionUpdate pinned guard not found in db-seam.js');
      return;
    }

    // Behavioral check: a pinned row for one (s,p,o) is not suppressed by a close that writes
    // a DIFFERENT (s,p,o) for the same predicate.
    // Note: for 1:N, a new write with the SAME (s,p,o) as a pinned row would leave the pinned
    // row live (suppression skipped) but the INSERT would fail the unique-live-row constraint
    // (a system invariant — two live rows with the same key cannot coexist). The pinned
    // exemption protects the row from C2 auto-downvote and from being suppressed in the
    // supersession path; it is not a grant of a second live slot.
    // We test the meaningful protection: a pinned row is not suppressed by a close that
    // writes to a different object under the same predicate.
    await createDb(dbName, projectDir);
    projectId = await setupProject(dbName, projectDir);

    db = await pgConnect(dbName);
    await setSetting(db, projectId, 'consolidation_corroboration_gate', 'enforce');

    // Insert a pinned row for a 1:N predicate with a distinct object.
    const pinnedSessionId = `l0-t5-pinned-${TS}`;
    await db.query(
      `INSERT INTO assertions
         (project_id, subject, predicate, object, confidence, source, session_id,
          last_reinforced, valid_at, tier, consolidated_at, corroboration_count, pinned)
       VALUES ($1, $2, $3, $4, $5, $6, $7, now(), now(), $8, NULL, 1, true)`,
      [projectId, 'project', 'has_tag', 'l0-test-pinned-protected',
       9, 'user_stated', pinnedSessionId, 'probationary']
    );
    await db.end(); db = null;

    // Close with a DIFFERENT (s,p,o) — the pinned row must remain live and unsuppressed.
    const sessionId = `l0-t5-session-${TS}`;
    const payload = {
      session_id: sessionId,
      tldr: 'T5 pinned exemption test',
      assertions: [{
        subject:    'project',
        predicate:  'has_tag',
        object:     'l0-test-different-new-tag',
        confidence: 8,
        source:     'model_extracted',
      }],
    };
    const r = runClose(payload, dbName, projectDir);
    if (r.status !== 0) {
      fail(label, `close exited ${r.status}: ${r.stderr}`);
      return;
    }

    db = await pgConnect(dbName);
    // The pinned row must still be live (suppressed = false).
    const { rows: pinnedRows } = await db.query(
      `SELECT id, suppressed, pinned FROM assertions
       WHERE project_id = $1
         AND predicate = 'has_tag'
         AND object = 'l0-test-pinned-protected'
         AND pinned = true`,
      [projectId]
    );
    await db.end(); db = null;

    if (pinnedRows.length === 0) {
      fail(label, 'Pinned row not found in DB after close');
      return;
    }
    if (pinnedRows[0].suppressed !== false) {
      fail(label, `Pinned row was suppressed (suppressed=${pinnedRows[0].suppressed}) — pinned exemption broken`);
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

// ── T6: disabled setting → byte-identical to pre-L0 ─────────────────────────

async function testT6DisabledByteIdentical() {
  const label = 'T6: disabled setting → self-stamped conf=9 close produces consolidated (pre-L0 behavior)';
  const dbName     = `claude_memory_l0_t6_${TS}`;
  const projectDir = path.join(os.tmpdir(), `l0_t6_${TS}`);
  let db = null;
  let projectId;
  try {
    await createDb(dbName, projectDir);
    projectId = await setupProject(dbName, projectDir);

    db = await pgConnect(dbName);
    // Explicitly disable both the L0 gate and the L2 gate mode to get the full
    // pre-L0/pre-L2 behavior: a self-stamped conf=9 close produces consolidated.
    // As of the L2-enforce ring, consolidation_gate_mode defaults to 'enforce',
    // so T6 must also disable it to reproduce the pre-gate baseline.
    await setSetting(db, projectId, 'consolidation_corroboration_gate', 'disabled');
    await setSetting(db, projectId, 'consolidation_gate_mode', 'disabled');
    await db.end(); db = null;

    // Single close: source='user_stated', confidence=9, no prior corroboration.
    // Under disabled mode, this MUST produce tier='consolidated' (pre-L0 behavior).
    const sessionId = `l0-t6-session-${TS}`;
    const payload = {
      session_id: sessionId,
      tldr: 'T6 disabled byte-identical test',
      assertions: [{
        subject:    'project',
        predicate:  'has_tag',
        object:     'l0-test-disabled-mode',
        confidence: 9,
        source:     'user_stated',
      }],
    };
    const r = runClose(payload, dbName, projectDir);
    if (r.status !== 0) {
      fail(label, `close exited ${r.status}: ${r.stderr}`);
      return;
    }

    db = await pgConnect(dbName);
    const { rows } = await db.query(
      `SELECT tier, consolidated_at FROM assertions
       WHERE project_id = $1
         AND subject = 'project'
         AND predicate = 'has_tag'
         AND object = 'l0-test-disabled-mode'
         AND suppressed = false`,
      [projectId]
    );
    await db.end(); db = null;

    if (rows.length === 0) {
      fail(label, 'No assertion row found after close');
      return;
    }
    const row = rows[0];
    if (row.tier !== 'consolidated') {
      fail(label, `Expected tier='consolidated' under disabled mode (pre-L0 behavior), got '${row.tier}'`);
      return;
    }
    if (!row.consolidated_at) {
      fail(label, 'Expected consolidated_at to be set under disabled mode, got NULL');
      return;
    }

    // Golden equivalence: also verify that a conf=8 assertion is still probationary
    // under disabled mode (isHighTrust requires conf >= 9).
    db = await pgConnect(dbName);
    const sessionId2 = `l0-t6-session2-${TS}`;
    await db.end(); db = null;

    const payload2 = {
      session_id: sessionId2,
      tldr: 'T6 disabled conf=8 test',
      assertions: [{
        subject:    'project',
        predicate:  'has_tag',
        object:     'l0-test-disabled-conf8',
        confidence: 8,
        source:     'user_stated',
      }],
    };
    const r2 = runClose(payload2, dbName, projectDir);
    if (r2.status !== 0) {
      fail(label, `second close (conf=8) exited ${r2.status}: ${r2.stderr}`);
      return;
    }

    db = await pgConnect(dbName);
    const { rows: rows2 } = await db.query(
      `SELECT tier FROM assertions
       WHERE project_id = $1
         AND subject = 'project'
         AND predicate = 'has_tag'
         AND object = 'l0-test-disabled-conf8'
         AND suppressed = false`,
      [projectId]
    );
    await db.end(); db = null;

    if (rows2.length === 0) {
      fail(label, 'No assertion row found for conf=8 close');
      return;
    }
    if (rows2[0].tier !== 'probationary') {
      fail(label, `Expected tier='probationary' for conf=8 under disabled mode, got '${rows2[0].tier}'`);
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

// ── T7: No UPDATE SET tier on pre-existing rows ───────────────────────────────

async function testT7NoUpdateSetTierOnExisting() {
  const label = 'T7: no UPDATE SET tier on pre-existing rows — L0 only affects new row birth';
  const dbName     = `claude_memory_l0_t7_${TS}`;
  const projectDir = path.join(os.tmpdir(), `l0_t7_${TS}`);
  let db = null;
  let projectId;
  try {
    // Static scan: confirm handoff.js does not contain automatic UPDATE ... SET tier
    // mutations on pre-existing rows introduced by the L0 write path.
    //
    // Allowed: the existing /handoff:promote operator command (UPDATE ... SET promoted = true,
    //   promoted_at = now(), tier = 'consolidated') — this is an explicit, user-initiated
    //   operator action that pre-dates L0 and is not an automatic engine re-evaluation.
    // Allowed: the suppression UPDATEs (set suppressed/invalid_at/suppression_kind, not tier).
    // Violation: any NEW UPDATE ... SET tier= that is not the promote operator command.
    //
    // We verify that the ONLY UPDATE ... tier occurrence is the one containing 'promoted_at'
    // (the operator promote action). Any additional occurrence is a violation.
    const handoffSrc = fs.readFileSync(HANDOFF_SCRIPT, 'utf8');

    // Find all UPDATE assertions blocks that mention tier.
    // Use String.prototype.matchAll via [...] spread to avoid the exec() method.
    const updateAssertionsRe = /UPDATE\s+assertions[\s\S]{1,250}?tier\s*=/g;
    const allMatches = [...handoffSrc.matchAll(updateAssertionsRe)].map((arr) => arr[0]);

    // Filter: keep only matches that do NOT contain 'promoted_at' (i.e., not the operator promote command).
    const unexpectedMatches = allMatches.filter((block) => !block.includes('promoted_at'));
    if (unexpectedMatches.length > 0) {
      fail(label, `Static scan: found unexpected UPDATE assertions SET tier in handoff.js (not the promote operator command): ${unexpectedMatches.map((s) => s.replace(/\s+/g, ' ').slice(0, 120)).join(' | ')}`);
      return;
    }

    // Also confirm the expected promote command IS present (guards against a future
    // refactor that removes it and this test going vacuously green).
    if (!allMatches.some((b) => b.includes('promoted_at'))) {
      fail(label, 'Static scan: expected promote-operator UPDATE SET tier not found in handoff.js (test assumption broken)');
      return;
    }

    // Behavioral check: a pre-existing consolidated row must not be re-evaluated.
    await createDb(dbName, projectDir);
    projectId = await setupProject(dbName, projectDir);

    db = await pgConnect(dbName);
    await setSetting(db, projectId, 'consolidation_corroboration_gate', 'enforce');

    // Insert a pre-existing consolidated row (grandfathered — already consolidated).
    const priorSessionId = `l0-t7-prior-${TS}`;
    await db.query(
      `INSERT INTO assertions
         (project_id, subject, predicate, object, confidence, source, session_id,
          last_reinforced, valid_at, tier, consolidated_at, corroboration_count)
       VALUES ($1, $2, $3, $4, $5, $6, $7, now(), now(), 'consolidated', now(), 2)`,
      [projectId, 'project', 'has_tag', 'l0-test-preexisting-consolidated',
       9, 'user_stated', priorSessionId]
    );
    const { rows: preBefore } = await db.query(
      `SELECT id, tier FROM assertions
       WHERE project_id = $1 AND predicate = 'has_tag' AND object = 'l0-test-preexisting-consolidated'`,
      [projectId]
    );
    await db.end(); db = null;

    // Run a close with a DIFFERENT (s,p,o) so that the pre-existing row is not touched.
    const sessionId = `l0-t7-session-${TS}`;
    const payload = {
      session_id: sessionId,
      tldr: 'T7 pre-existing row protection',
      assertions: [{
        subject:    'project',
        predicate:  'has_tag',
        object:     'l0-test-different-object',
        confidence: 9,
        source:     'user_stated',
      }],
    };
    const r = runClose(payload, dbName, projectDir);
    if (r.status !== 0) {
      fail(label, `close exited ${r.status}: ${r.stderr}`);
      return;
    }

    db = await pgConnect(dbName);
    // Verify the pre-existing consolidated row is unchanged.
    const { rows: preAfter } = await db.query(
      `SELECT id, tier FROM assertions
       WHERE project_id = $1 AND predicate = 'has_tag' AND object = 'l0-test-preexisting-consolidated'`,
      [projectId]
    );
    await db.end(); db = null;

    if (preBefore.length === 0 || preAfter.length === 0) {
      fail(label, 'Pre-existing row not found (setup issue)');
      return;
    }
    if (preBefore[0].id !== preAfter[0].id) {
      fail(label, `Pre-existing row id changed (${preBefore[0].id} → ${preAfter[0].id})`);
      return;
    }
    if (preAfter[0].tier !== 'consolidated') {
      fail(label, `Pre-existing consolidated row had tier changed to '${preAfter[0].tier}'`);
      return;
    }

    // Also verify the new row was born probationary (no prior corroboration for the different object).
    db = await pgConnect(dbName);
    const { rows: newRows } = await db.query(
      `SELECT tier FROM assertions
       WHERE project_id = $1 AND predicate = 'has_tag' AND object = 'l0-test-different-object'
         AND suppressed = false`,
      [projectId]
    );
    await db.end(); db = null;

    if (newRows.length === 0) {
      fail(label, 'New assertion row not found');
      return;
    }
    if (newRows[0].tier !== 'probationary') {
      fail(label, `New row without corroboration should be probationary, got '${newRows[0].tier}'`);
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

// ── T8: Defense-in-depth — same-session re-assertion does NOT consolidate ─────

async function testT8SameSessionFakeCorroboration() {
  const label = 'T8: defense-in-depth — same-session re-assertion cannot forge corroboration (1:N)';
  const dbName     = `claude_memory_l0_t8_${TS}`;
  const projectDir = path.join(os.tmpdir(), `l0_t8_${TS}`);
  let db = null;
  let projectId;
  try {
    await createDb(dbName, projectDir);
    projectId = await setupProject(dbName, projectDir);

    db = await pgConnect(dbName);
    await setSetting(db, projectId, 'consolidation_corroboration_gate', 'enforce');

    // Inject a prior row with the SAME session_id as the upcoming close.
    // This simulates a model that plants a prior row using the same session to fake
    // cross-session corroboration. The gate must reject this.
    const sameSessionId = `l0-t8-same-session-${TS}`;
    await db.query(
      `INSERT INTO assertions
         (project_id, subject, predicate, object, confidence, source, session_id,
          last_reinforced, valid_at, tier, consolidated_at, corroboration_count)
       VALUES ($1, $2, $3, $4, $5, $6, $7, now(), now(), $8, NULL, 1)`,
      [projectId, 'project', 'has_tag', 'l0-test-same-session',
       9, 'user_stated', sameSessionId, 'probationary']
    );
    await db.end(); db = null;

    // Close with the SAME session_id — must not consolidate.
    const payload = {
      session_id: sameSessionId,
      tldr: 'T8 same-session fake corroboration',
      assertions: [{
        subject:    'project',
        predicate:  'has_tag',
        object:     'l0-test-same-session',
        confidence: 9,
        source:     'user_stated',
      }],
    };
    const r = runClose(payload, dbName, projectDir);
    if (r.status !== 0) {
      fail(label, `close exited ${r.status}: ${r.stderr}`);
      return;
    }

    db = await pgConnect(dbName);
    const { rows } = await db.query(
      `SELECT tier FROM assertions
       WHERE project_id = $1
         AND subject = 'project'
         AND predicate = 'has_tag'
         AND object = 'l0-test-same-session'
         AND suppressed = false`,
      [projectId]
    );
    await db.end(); db = null;

    if (rows.length === 0) {
      // Same-session exact repeat may result in touch-only (no new row). Check all rows.
      db = await pgConnect(dbName);
      const { rows: allRows } = await db.query(
        `SELECT tier, suppressed, session_id FROM assertions
         WHERE project_id = $1
           AND subject = 'project'
           AND predicate = 'has_tag'
           AND object = 'l0-test-same-session'`,
        [projectId]
      );
      await db.end(); db = null;

      // If touch-only: the original row should still be probationary.
      if (allRows.length === 0) {
        fail(label, 'No rows found at all');
        return;
      }
      for (const row of allRows) {
        if (row.tier !== 'probationary') {
          fail(label, `Row with same-session_id has tier='${row.tier}' (expected probationary). Same-session fake corroboration forged the gate.`);
          return;
        }
      }
    } else {
      if (rows[0].tier !== 'probationary') {
        fail(label, `Expected tier='probationary', got '${rows[0].tier}'. Same-session fake corroboration forged the gate.`);
        return;
      }
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
  console.log('=== L0 Consolidation Gate Tests ===\n');

  let pgAvail = false;
  try {
    const probe = await pgConnect('postgres');
    await probe.end();
    pgAvail = true;
  } catch (err) {
    console.error(`[SKIP] Postgres not available (${err.message}) — all L0 tests require Postgres.`);
    console.error('Set PGHOST/PGUSER/PGPASSWORD to run these tests.');
    process.exit(0);
  }

  if (!pgAvail) {
    console.error('[SKIP] Postgres unavailable — skipping all L0 tests');
    process.exit(0);
  }

  await testT1AttackOneClosed();
  await testT2GenuineCorroborationN();
  await testT3GenuineCorroboration1();
  await testT4PayloadSessionIdNotSufficient();
  await testT5PinnedStillWorks();
  await testT6DisabledByteIdentical();
  await testT7NoUpdateSetTierOnExisting();
  await testT8SameSessionFakeCorroboration();

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
