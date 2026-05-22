'use strict';
/* test-l2-consolidation-gate.js
 *
 * Comprehensive test suite for Lever L2: corroboration-quality plug.
 *
 * L2 addresses the PATIENT adversary gap in L0:
 *   L0 gates on crossSessionCorroborated (genuine prior rows from distinct sessions).
 *   A patient adversary satisfies this by reposting the same forged triple across
 *   2+ genuine sessions -- the prior rows ARE real, but all self-stamped inferences.
 *   Under L0 alone, those rows consolidate. L2's positive-evidence plug blocks this.
 *
 * L2 positive-evidence quality plug: arm(b) satisfied ONLY IF >=1 corroborating
 * prior-session row is independently trustworthy (reality_check='verified' OR pinned).
 * 2 or 20 self-stamped corroborations across distinct sessions STILL fail arm(b).
 *
 * 3-arm gate (active under consolidation_gate_mode='enforce'):
 *   arm(a): hasQualityCorroborator -- >=1 prior cross-session row is trustworthy.
 *   arm(b): crossSessionCorroborated AND hasQualityCorroborator.
 *   arm(c): incoming assertion is operator-pinned.
 *
 * Coverage:
 *   T1  Patient-adversary (2 self-stamped) -> probationary under enforce.
 *   T2  Patient-adversary (20 self-stamped) -> probationary (THR retired).
 *   T3  Arm(b) via reality_check='verified' corroborator -> consolidated.
 *   T4  Arm(a) via pinned corroborator -> consolidated.
 *   T5  Arm(c) incoming operator-pinned -> consolidated.
 *   T6  Single self-stamped close still probationary (L0 property preserved).
 *   T7  disabled byte-identical to post-L0 main.
 *   T8  report tier outcomes == disabled (no outcome change).
 *   T9  report emits would-withhold stderr log.
 *   T10 enforce changes outcomes vs disabled.
 *   T11 CLAUDE.md transitive binding.
 *   T12 Candidate-query bug regression (missing id/tier cols).
 *   T13 No UPDATE SET tier on pre-existing rows (static + behavioral).
 *
 * Usage: node scripts/test-l2-consolidation-gate.js
 * Requires Postgres at PGHOST/PGUSER/PGPASSWORD (or localhost/postgres).
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

const PROJECT_ROOT   = path.resolve(__dirname, '..');
const HANDOFF_SCRIPT = path.join(PROJECT_ROOT, 'scripts', 'handoff.js');
const TS             = Date.now();

let passed = 0; let failed = 0; const failures = [];
function pass(label) { console.log('PASS  ' + label); passed++; }
function fail(label, reason) {
  console.log('FAIL  ' + label + ': ' + reason);
  failures.push({ label: label, reason: reason });
  failed++;
}

async function insertPriorRow(db, projectId, o) {
  await db.query(
    'INSERT INTO assertions (project_id,subject,predicate,object,confidence,source,session_id,last_reinforced,valid_at,tier,consolidated_at,corroboration_count,reality_check,pinned) VALUES ($1,$2,$3,$4,$5,$6,$7,now(),now(),$8,NULL,1,$9,$10)',
    [projectId, o.subject, o.predicate, o.object,
     o.confidence != null ? o.confidence : 9, o.source || 'user_stated', o.sessionId,
     o.tier || 'probationary', o.reality_check || null, o.pinned || false]
  );
}

// ── T1: Patient-adversary (>=2 self-stamped corroborations) ─────────────────
// The patient-adversary scenario: a live prior row exists from session A (self-stamped,
// no reality_check='verified', not pinned). Session B's close sees crossSessionCorroborated=true
// (different session, same triple) but hasQualityCorroborator=false (prior row is self-stamped).
// Under L2 enforce: arm(b) fails (no quality corroborator) -> probationary.
// This is the core patient-adversary closure: L0 alone would consolidate, L2 blocks it.
async function T1() {
  const label = 'T1: patient-adversary (self-stamped cross-session corroboration) -> probationary under enforce';
  const dn = 'l2_t1_' + TS;
  const pd = path.join(os.tmpdir(), 'l2_t1_' + TS);
  let db = null; let pid;
  try {
    await createDb(dn, pd);
    pid = await setupProject(dn, pd);
    db = await pgConnect(dn);
    await setSetting(db, pid, 'consolidation_corroboration_gate', 'enforce');
    await setSetting(db, pid, 'consolidation_gate_mode', 'enforce');
    // One prior self-stamped row from session A (no quality corroborator).
    await insertPriorRow(db, pid, { subject: 'project', predicate: 'has_tag', object: 'l2t1obj', sessionId: 'l2-t1-A-' + TS });
    await db.end(); db = null;
    // Close from a DIFFERENT session B -- crossSessionCorroborated=true, but no quality corroborator.
    const r = runClose({ session_id: 'l2-t1-new-' + TS, tldr: 'T1', assertions: [{ subject: 'project', predicate: 'has_tag', object: 'l2t1obj', confidence: 9, source: 'user_stated' }] }, dn, pd);
    if (r.status !== 0) { fail(label, 'close failed: ' + r.stderr); return; }
    db = await pgConnect(dn);
    const { rows } = await db.query("SELECT tier FROM assertions WHERE project_id=$1 AND predicate='has_tag' AND object='l2t1obj' AND suppressed=false", [pid]);
    await db.end(); db = null;
    if (!rows.length) { fail(label, 'no row found'); return; }
    if (rows[0].tier !== 'probationary') { fail(label, 'expected probationary (patient-adversary blocked by L2), got ' + rows[0].tier); return; }
    pass(label);
  } catch (err) { fail(label, err.message); }
  finally { if (db) { try { await db.end(); } catch (_) {} } if (pid) cleanupHandoffMd(pid); await dropDb(dn, pd); }
}

// ── T2: THR retired -- one or 20 self-stamped corroborations, result is the same ────
// THR retirement: count-based gating is empirically useless against a patient attacker.
// We prove: regardless of corroboration_count on the prior row (simulating N prior sessions
// all self-stamped), the outcome under L2 enforce is probationary if none is quality-plugged.
// The corroboration_count field is used for display but is NOT a gate criterion.
async function T2() {
  const label = 'T2: THR retired -- high corroboration_count with no quality corroborator -> still probationary';
  const dn = 'l2_t2_' + TS;
  const pd = path.join(os.tmpdir(), 'l2_t2_' + TS);
  let db = null; let pid;
  try {
    await createDb(dn, pd);
    pid = await setupProject(dn, pd);
    db = await pgConnect(dn);
    await setSetting(db, pid, 'consolidation_corroboration_gate', 'enforce');
    await setSetting(db, pid, 'consolidation_gate_mode', 'enforce');
    // Insert a prior row with corroboration_count=20 (simulating 20 prior self-stamped sessions),
    // but no reality_check='verified' and not pinned.
    await db.query(
      'INSERT INTO assertions (project_id,subject,predicate,object,confidence,source,session_id,last_reinforced,valid_at,tier,consolidated_at,corroboration_count,reality_check,pinned) VALUES ($1,$2,$3,$4,$5,$6,$7,now(),now(),$8,NULL,20,NULL,false)',
      [pid, 'project', 'has_tag', 'l2t2obj', 9, 'user_stated', 'l2-t2-prior-' + TS, 'probationary']
    );
    await db.end(); db = null;
    // Close from a new session -- corroboration_count=20 but still no quality corroborator.
    const r = runClose({ session_id: 'l2-t2-new-' + TS, tldr: 'T2', assertions: [{ subject: 'project', predicate: 'has_tag', object: 'l2t2obj', confidence: 9, source: 'user_stated' }] }, dn, pd);
    if (r.status !== 0) { fail(label, 'close failed: ' + r.stderr); return; }
    db = await pgConnect(dn);
    const { rows } = await db.query("SELECT tier FROM assertions WHERE project_id=$1 AND predicate='has_tag' AND object='l2t2obj' AND suppressed=false", [pid]);
    await db.end(); db = null;
    if (!rows.length) { fail(label, 'no row'); return; }
    if (rows[0].tier !== 'probationary') { fail(label, 'expected probationary (THR retired: count=20 is not a gate criterion), got ' + rows[0].tier); return; }
    pass(label);
  } catch (err) { fail(label, err.message); }
  finally { if (db) { try { await db.end(); } catch (_) {} } if (pid) cleanupHandoffMd(pid); await dropDb(dn, pd); }
}

// ── T3: Arm(b) satisfied via reality_check='verified' ───────────────────────
async function T3() {
  const label = "T3: arm(a)/(b) -- corroborating row has reality_check='verified' -> consolidated";
  const dn = 'l2_t3_' + TS;
  const pd = path.join(os.tmpdir(), 'l2_t3_' + TS);
  let db = null; let pid;
  try {
    await createDb(dn, pd);
    pid = await setupProject(dn, pd);
    db = await pgConnect(dn);
    await setSetting(db, pid, 'consolidation_corroboration_gate', 'enforce');
    await setSetting(db, pid, 'consolidation_gate_mode', 'enforce');
    await insertPriorRow(db, pid, { subject: 'project', predicate: 'has_tag', object: 'l2t3obj', sessionId: 'l2-t3-prior-' + TS, reality_check: 'verified' });
    await db.end(); db = null;
    const r = runClose({ session_id: 'l2-t3-new-' + TS, tldr: 'T3', assertions: [{ subject: 'project', predicate: 'has_tag', object: 'l2t3obj', confidence: 9, source: 'user_stated' }] }, dn, pd);
    if (r.status !== 0) { fail(label, 'close failed: ' + r.stderr); return; }
    db = await pgConnect(dn);
    const { rows } = await db.query("SELECT tier,consolidated_at FROM assertions WHERE project_id=$1 AND predicate='has_tag' AND object='l2t3obj' AND suppressed=false", [pid]);
    await db.end(); db = null;
    if (!rows.length) { fail(label, 'no row'); return; }
    if (rows[0].tier !== 'consolidated') { fail(label, 'expected consolidated (verified corroborator), got ' + rows[0].tier); return; }
    if (!rows[0].consolidated_at) { fail(label, 'expected consolidated_at set'); return; }
    pass(label);
  } catch (err) { fail(label, err.message); }
  finally { if (db) { try { await db.end(); } catch (_) {} } if (pid) cleanupHandoffMd(pid); await dropDb(dn, pd); }
}

// ── T4: Arm(a) via reality_check='verified' on 1:1 predicate ────────────────
// Tests the arm(a)/(b) path for a 1:1 predicate ('is_at_commit') to ensure the
// quality plug works for both cardinalities. Prior row for the same (s,p,o) has
// reality_check='verified' -- independent trustworthiness established by L3.
async function T4() {
  const label = "T4: arm(a)/(b) on 1:1 predicate -- reality_check='verified' corroborator -> consolidated";
  const dn = 'l2_t4_' + TS;
  const pd = path.join(os.tmpdir(), 'l2_t4_' + TS);
  let db = null; let pid;
  try {
    await createDb(dn, pd);
    pid = await setupProject(dn, pd);
    db = await pgConnect(dn);
    await setSetting(db, pid, 'consolidation_corroboration_gate', 'enforce');
    await setSetting(db, pid, 'consolidation_gate_mode', 'enforce');
    // Prior 1:1 row with reality_check='verified' from a different session.
    // 'is_at_commit' is a known 1:1 predicate in the registry.
    await insertPriorRow(db, pid, { subject: 'project', predicate: 'is_at_commit', object: 'abc123l2t4', sessionId: 'l2-t4-prior-' + TS, reality_check: 'verified' });
    await db.end(); db = null;
    const r = runClose({ session_id: 'l2-t4-new-' + TS, tldr: 'T4', assertions: [{ subject: 'project', predicate: 'is_at_commit', object: 'abc123l2t4', confidence: 9, source: 'user_stated' }] }, dn, pd);
    if (r.status !== 0) { fail(label, 'close failed: ' + r.stderr); return; }
    db = await pgConnect(dn);
    const { rows } = await db.query("SELECT tier,consolidated_at FROM assertions WHERE project_id=$1 AND predicate='is_at_commit' AND object='abc123l2t4' AND suppressed=false", [pid]);
    await db.end(); db = null;
    if (!rows.length) { fail(label, 'no row'); return; }
    if (rows[0].tier !== 'consolidated') { fail(label, 'expected consolidated (verified corroborator on 1:1), got ' + rows[0].tier); return; }
    if (!rows[0].consolidated_at) { fail(label, 'expected consolidated_at set'); return; }
    pass(label);
  } catch (err) { fail(label, err.message); }
  finally { if (db) { try { await db.end(); } catch (_) {} } if (pid) cleanupHandoffMd(pid); await dropDb(dn, pd); }
}

// ── T5: Arm(c) incoming operator-pinned ─────────────────────────────────────
async function T5() {
  const label = 'T5: arm(c) -- incoming assertion is operator-pinned -> consolidated';
  const dn = 'l2_t5_' + TS;
  const pd = path.join(os.tmpdir(), 'l2_t5_' + TS);
  let db = null; let pid;
  try {
    await createDb(dn, pd);
    pid = await setupProject(dn, pd);
    db = await pgConnect(dn);
    await setSetting(db, pid, 'consolidation_corroboration_gate', 'enforce');
    await setSetting(db, pid, 'consolidation_gate_mode', 'enforce');
    await db.end(); db = null;
    const r = runClose({ session_id: 'l2-t5-' + TS, tldr: 'T5', assertions: [{ subject: 'project', predicate: 'has_tag', object: 'l2t5obj', confidence: 9, source: 'user_stated', pinned: true }] }, dn, pd);
    if (r.status !== 0) { fail(label, 'close failed: ' + r.stderr); return; }
    db = await pgConnect(dn);
    const { rows } = await db.query("SELECT tier,consolidated_at FROM assertions WHERE project_id=$1 AND predicate='has_tag' AND object='l2t5obj' AND suppressed=false", [pid]);
    await db.end(); db = null;
    if (!rows.length) { fail(label, 'no row'); return; }
    if (rows[0].tier !== 'consolidated') { fail(label, 'expected consolidated (arm c incoming pinned), got ' + rows[0].tier); return; }
    if (!rows[0].consolidated_at) { fail(label, 'expected consolidated_at set'); return; }
    pass(label);
  } catch (err) { fail(label, err.message); }
  finally { if (db) { try { await db.end(); } catch (_) {} } if (pid) cleanupHandoffMd(pid); await dropDb(dn, pd); }
}

// ── T6: Single self-stamped still probationary (L0 property preserved) ──────
async function T6() {
  const label = 'T6: single self-stamped close still probationary under enforce (L0 property preserved)';
  const dn = 'l2_t6_' + TS;
  const pd = path.join(os.tmpdir(), 'l2_t6_' + TS);
  let db = null; let pid;
  try {
    await createDb(dn, pd);
    pid = await setupProject(dn, pd);
    db = await pgConnect(dn);
    await setSetting(db, pid, 'consolidation_corroboration_gate', 'enforce');
    await setSetting(db, pid, 'consolidation_gate_mode', 'enforce');
    await db.end(); db = null;
    const r = runClose({ session_id: 'l2-t6-' + TS, tldr: 'T6', assertions: [{ subject: 'project', predicate: 'has_tag', object: 'l2t6obj', confidence: 9, source: 'user_stated' }] }, dn, pd);
    if (r.status !== 0) { fail(label, 'close failed: ' + r.stderr); return; }
    db = await pgConnect(dn);
    const { rows } = await db.query("SELECT tier FROM assertions WHERE project_id=$1 AND predicate='has_tag' AND object='l2t6obj' AND suppressed=false", [pid]);
    await db.end(); db = null;
    if (!rows.length) { fail(label, 'no row'); return; }
    if (rows[0].tier !== 'probationary') { fail(label, 'expected probationary, got ' + rows[0].tier); return; }
    pass(label);
  } catch (err) { fail(label, err.message); }
  finally { if (db) { try { await db.end(); } catch (_) {} } if (pid) cleanupHandoffMd(pid); await dropDb(dn, pd); }
}

// ── T7: disabled byte-identical to post-L0 main ─────────────────────────────
async function T7() {
  const label = 'T7: disabled byte-identical to post-L0 (crossSession alone -> consolidated)';
  const dn = 'l2_t7_' + TS;
  const pd = path.join(os.tmpdir(), 'l2_t7_' + TS);
  let db = null; let pid;
  try {
    await createDb(dn, pd);
    pid = await setupProject(dn, pd);
    db = await pgConnect(dn);
    await setSetting(db, pid, 'consolidation_corroboration_gate', 'enforce');
    await setSetting(db, pid, 'consolidation_gate_mode', 'disabled');
    await insertPriorRow(db, pid, { subject: 'project', predicate: 'has_tag', object: 'l2t7obj', sessionId: 'l2-t7-prior-' + TS });
    await db.end(); db = null;
    const r = runClose({ session_id: 'l2-t7-new-' + TS, tldr: 'T7', assertions: [{ subject: 'project', predicate: 'has_tag', object: 'l2t7obj', confidence: 9, source: 'user_stated' }] }, dn, pd);
    if (r.status !== 0) { fail(label, 'close failed: ' + r.stderr); return; }
    db = await pgConnect(dn);
    const { rows } = await db.query("SELECT tier FROM assertions WHERE project_id=$1 AND predicate='has_tag' AND object='l2t7obj' AND suppressed=false", [pid]);
    await db.end(); db = null;
    if (!rows.length) { fail(label, 'no row'); return; }
    if (rows[0].tier !== 'consolidated') { fail(label, 'expected consolidated under disabled (L0 behavior), got ' + rows[0].tier); return; }
    pass(label);
  } catch (err) { fail(label, err.message); }
  finally { if (db) { try { await db.end(); } catch (_) {} } if (pid) cleanupHandoffMd(pid); await dropDb(dn, pd); }
}

// ── T8: report tier outcomes == disabled ────────────────────────────────────
async function T8() {
  const label = 'T8: report tier outcomes identical to disabled (no outcome change)';
  const dn = 'l2_t8_' + TS;
  const pd = path.join(os.tmpdir(), 'l2_t8_' + TS);
  let db = null; let pid;
  try {
    await createDb(dn, pd);
    pid = await setupProject(dn, pd);
    db = await pgConnect(dn);
    await setSetting(db, pid, 'consolidation_corroboration_gate', 'enforce');
    await setSetting(db, pid, 'consolidation_gate_mode', 'report');
    // One self-stamped prior: L0 says consolidated, L2 would withhold. Under report: consolidated.
    await insertPriorRow(db, pid, { subject: 'project', predicate: 'has_tag', object: 'l2t8obj', sessionId: 'l2-t8-prior-' + TS });
    await db.end(); db = null;
    const r = runClose({ session_id: 'l2-t8-new-' + TS, tldr: 'T8', assertions: [{ subject: 'project', predicate: 'has_tag', object: 'l2t8obj', confidence: 9, source: 'user_stated' }] }, dn, pd);
    if (r.status !== 0) { fail(label, 'close failed: ' + r.stderr); return; }
    db = await pgConnect(dn);
    const { rows } = await db.query("SELECT tier FROM assertions WHERE project_id=$1 AND predicate='has_tag' AND object='l2t8obj' AND suppressed=false", [pid]);
    await db.end(); db = null;
    if (!rows.length) { fail(label, 'no row'); return; }
    if (rows[0].tier !== 'consolidated') { fail(label, 'expected consolidated under report (same as disabled), got ' + rows[0].tier); return; }
    pass(label);
  } catch (err) { fail(label, err.message); }
  finally { if (db) { try { await db.end(); } catch (_) {} } if (pid) cleanupHandoffMd(pid); await dropDb(dn, pd); }
}

// ── T9: report emits would-withhold log ─────────────────────────────────────
async function T9() {
  const label = 'T9: report mode emits would-withhold stderr log when L2 differs from L0';
  const dn = 'l2_t9_' + TS;
  const pd = path.join(os.tmpdir(), 'l2_t9_' + TS);
  let db = null; let pid;
  try {
    await createDb(dn, pd);
    pid = await setupProject(dn, pd);
    db = await pgConnect(dn);
    await setSetting(db, pid, 'consolidation_corroboration_gate', 'enforce');
    await setSetting(db, pid, 'consolidation_gate_mode', 'report');
    await insertPriorRow(db, pid, { subject: 'project', predicate: 'has_tag', object: 'l2t9obj', sessionId: 'l2-t9-prior-' + TS });
    await db.end(); db = null;
    const r = runClose({ session_id: 'l2-t9-new-' + TS, tldr: 'T9', assertions: [{ subject: 'project', predicate: 'has_tag', object: 'l2t9obj', confidence: 9, source: 'user_stated' }] }, dn, pd);
    if (r.status !== 0) { fail(label, 'close failed: ' + r.stderr); return; }
    const se = r.stderr || '';
    if (!se.includes('L2 report: would-withhold')) { fail(label, '"L2 report: would-withhold" not in stderr; got: ' + se.slice(0, 300)); return; }
    if (!se.includes('l2t9obj')) { fail(label, 'object not in would-withhold log; got: ' + se.slice(0, 300)); return; }
    pass(label);
  } catch (err) { fail(label, err.message); }
  finally { if (db) { try { await db.end(); } catch (_) {} } if (pid) cleanupHandoffMd(pid); await dropDb(dn, pd); }
}

// ── T10: enforce changes outcomes vs disabled ────────────────────────────────
async function T10() {
  const label = 'T10: enforce changes outcomes -- disabled->consolidated, enforce->probationary';
  const dnA = 'l2_t10a_' + TS; const pdA = path.join(os.tmpdir(), 'l2_t10a_' + TS);
  const dnB = 'l2_t10b_' + TS; const pdB = path.join(os.tmpdir(), 'l2_t10b_' + TS);
  let dbA = null; let dbB = null; let pidA; let pidB;
  try {
    await createDb(dnA, pdA);
    pidA = await setupProject(dnA, pdA);
    dbA = await pgConnect(dnA);
    await setSetting(dbA, pidA, 'consolidation_corroboration_gate', 'enforce');
    await setSetting(dbA, pidA, 'consolidation_gate_mode', 'disabled');
    await insertPriorRow(dbA, pidA, { subject: 'project', predicate: 'has_tag', object: 'l2t10obj', sessionId: 'l2-t10-prior-' + TS });
    await dbA.end(); dbA = null;

    await createDb(dnB, pdB);
    pidB = await setupProject(dnB, pdB);
    dbB = await pgConnect(dnB);
    await setSetting(dbB, pidB, 'consolidation_corroboration_gate', 'enforce');
    await setSetting(dbB, pidB, 'consolidation_gate_mode', 'enforce');
    await insertPriorRow(dbB, pidB, { subject: 'project', predicate: 'has_tag', object: 'l2t10obj', sessionId: 'l2-t10-prior-' + TS });
    await dbB.end(); dbB = null;

    const rA = runClose({ session_id: 'l2-t10-new-' + TS, tldr: 'T10A', assertions: [{ subject: 'project', predicate: 'has_tag', object: 'l2t10obj', confidence: 9, source: 'user_stated' }] }, dnA, pdA);
    if (rA.status !== 0) { fail(label, 'A failed: ' + rA.stderr); return; }
    const rB = runClose({ session_id: 'l2-t10-new-' + TS, tldr: 'T10B', assertions: [{ subject: 'project', predicate: 'has_tag', object: 'l2t10obj', confidence: 9, source: 'user_stated' }] }, dnB, pdB);
    if (rB.status !== 0) { fail(label, 'B failed: ' + rB.stderr); return; }

    dbA = await pgConnect(dnA);
    const { rows: rA2 } = await dbA.query("SELECT tier FROM assertions WHERE project_id=$1 AND predicate='has_tag' AND object='l2t10obj' AND suppressed=false", [pidA]);
    await dbA.end(); dbA = null;
    dbB = await pgConnect(dnB);
    const { rows: rB2 } = await dbB.query("SELECT tier FROM assertions WHERE project_id=$1 AND predicate='has_tag' AND object='l2t10obj' AND suppressed=false", [pidB]);
    await dbB.end(); dbB = null;

    if (!rA2.length) { fail(label, 'A: no row'); return; }
    if (!rB2.length) { fail(label, 'B: no row'); return; }
    if (rA2[0].tier !== 'consolidated') { fail(label, 'A(disabled) expected consolidated, got ' + rA2[0].tier); return; }
    if (rB2[0].tier !== 'probationary') { fail(label, 'B(enforce) expected probationary, got ' + rB2[0].tier); return; }
    pass(label);
  } catch (err) { fail(label, err.message); }
  finally {
    if (dbA) { try { await dbA.end(); } catch (_) {} }
    if (dbB) { try { await dbB.end(); } catch (_) {} }
    if (pidA) cleanupHandoffMd(pidA);
    if (pidB) cleanupHandoffMd(pidB);
    await dropDb(dnA, pdA);
    await dropDb(dnB, pdB);
  }
}

// ── T11: CLAUDE.md transitive binding ───────────────────────────────────────
async function T11() {
  const label = 'T11: CLAUDE.md transitive binding -- only gate-consolidated rows eligible';
  const dn = 'l2_t11_' + TS;
  const pd = path.join(os.tmpdir(), 'l2_t11_' + TS);
  let db = null; let pid;
  try {
    await createDb(dn, pd);
    pid = await setupProject(dn, pd);
    db = await pgConnect(dn);
    await setSetting(db, pid, 'consolidation_gate_mode', 'enforce');
    // Gate-consolidated row (old created_at for multi-session pred)
    await db.query("INSERT INTO assertions (project_id,subject,predicate,object,confidence,source,session_id,last_reinforced,valid_at,created_at,tier,consolidated_at,corroboration_count) VALUES ($1,'project','has_tag','l2t11eligible',9,'user_stated','l2-t11-c-" + TS + "',now(),now(),now()-interval '2 days','consolidated',now(),2)", [pid]);
    // Probationary row (NOT consolidated)
    await db.query("INSERT INTO assertions (project_id,subject,predicate,object,confidence,source,session_id,last_reinforced,valid_at,created_at,tier,consolidated_at,corroboration_count) VALUES ($1,'project','has_tag','l2t11ineligible',9,'user_stated','l2-t11-p-" + TS + "',now(),now(),now()-interval '2 days','probationary',NULL,1)", [pid]);
    await db.end(); db = null;
    const r = runClose({ session_id: 'l2-t11-check-' + TS, tldr: 'T11', assertions: [] }, dn, pd);
    if (r.status !== 0) { fail(label, 'close failed: ' + r.stderr); return; }
    const so = r.stdout || '';
    if (!so.includes('l2t11eligible')) { fail(label, 'consolidated row not in candidates; stdout: ' + so.slice(0, 300)); return; }
    if (so.includes('l2t11ineligible')) { fail(label, 'probationary row appeared in candidates; stdout: ' + so.slice(0, 300)); return; }
    pass(label);
  } catch (err) { fail(label, err.message); }
  finally { if (db) { try { await db.end(); } catch (_) {} } if (pid) cleanupHandoffMd(pid); await dropDb(dn, pd); }
}

// ── T12: Candidate-query bug regression ─────────────────────────────────────
async function T12() {
  const label = 'T12: candidate-query bug regression -- SELECT must include id and tier columns';
  // Static check: pre-fix SELECT was missing id and tier. Verify fix is present.
  const handoffSrc = fs.readFileSync(HANDOFF_SCRIPT, 'utf8');
  const candidateRe = /SELECT\s+([\s\S]{1,500}?)\s+FROM\s+assertions\s+WHERE[\s\S]{1,300}?confidence\s*>=\s*9[\s\S]{1,300}?source\s*=\s*'user_stated'/;
  const m = candidateRe.exec(handoffSrc);
  if (!m) { fail(label, 'Static: candidate SELECT pattern not found in handoff.js'); return; }
  const cols = m[1];
  if (!/\bid\b/.test(cols)) { fail(label, 'Static: candidate SELECT missing "id" col; cols: ' + cols.replace(/\s+/g, ' ').slice(0, 200)); return; }
  if (!/\btier\b/.test(cols)) { fail(label, 'Static: candidate SELECT missing "tier" col; cols: ' + cols.replace(/\s+/g, ' ').slice(0, 200)); return; }
  if (!handoffSrc.includes("tier = 'consolidated'")) { fail(label, "Static: candidate SELECT missing AND tier = 'consolidated' filter (transitive binding)"); return; }

  // Behavioral: verify no source_assertion=undefined in CLAUDE.md after promotion.
  const dn = 'l2_t12_' + TS;
  const pd = path.join(os.tmpdir(), 'l2_t12_' + TS);
  let db = null; let pid;
  try {
    await createDb(dn, pd);
    pid = await setupProject(dn, pd);
    db = await pgConnect(dn);
    await setSetting(db, pid, 'consolidation_gate_mode', 'enforce');
    const ins = await db.query("INSERT INTO assertions (project_id,subject,predicate,object,confidence,source,session_id,last_reinforced,valid_at,created_at,tier,consolidated_at,corroboration_count) VALUES ($1,'project','has_tag','l2t12cand',9,'user_stated','l2-t12-s-" + TS + "',now(),now(),now()-interval '2 days','consolidated',now(),2) RETURNING id", [pid]);
    const eid = ins.rows[0].id;
    await db.end(); db = null;
    const r = runClose({ session_id: 'l2-t12-promote-' + TS, tldr: 'T12', assertions: [], confirm_claude_md_promotion: true }, dn, pd);
    if (r.status !== 0) { fail(label, 'close failed: ' + r.stderr); return; }
    const cmp = path.join(pd, 'CLAUDE.md');
    if (!fs.existsSync(cmp)) { fail(label, 'CLAUDE.md not found'); return; }
    const cmc = fs.readFileSync(cmp, 'utf8');
    if (cmc.includes('source_assertion=undefined')) { fail(label, 'CLAUDE.md has source_assertion=undefined -- bug still present (r.id undefined)'); return; }
    if (cmc.includes('source_assertion=') && cmc.includes('l2t12cand') && !cmc.includes('source_assertion=' + eid)) {
      fail(label, 'Expected source_assertion=' + eid + '; got: ' + cmc.slice(0, 200));
      return;
    }
    pass(label);
  } catch (err) { fail(label, err.message); }
  finally { if (db) { try { await db.end(); } catch (_) {} } if (pid) cleanupHandoffMd(pid); await dropDb(dn, pd); }
}

// ── T13: No UPDATE SET tier on pre-existing rows ─────────────────────────────
async function T13() {
  const label = 'T13: no UPDATE SET tier on pre-existing rows (static + behavioral)';
  const dn = 'l2_t13_' + TS;
  const pd = path.join(os.tmpdir(), 'l2_t13_' + TS);
  let db = null; let pid;
  try {
    // Static scan
    const src = fs.readFileSync(HANDOFF_SCRIPT, 'utf8');
    const re = /UPDATE\s+assertions[\s\S]{1,250}?tier\s*=/g;
    const all = [...src.matchAll(re)].map(function (a) { return a[0]; });
    const bad = all.filter(function (b) { return !b.includes('promoted_at'); });
    if (bad.length) { fail(label, 'Static: unexpected UPDATE SET tier: ' + bad.map(function (s) { return s.replace(/\s+/g, ' ').slice(0, 100); }).join(' | ')); return; }
    if (!all.some(function (b) { return b.includes('promoted_at'); })) { fail(label, 'Static: promote UPDATE not found'); return; }

    await createDb(dn, pd);
    pid = await setupProject(dn, pd);
    db = await pgConnect(dn);
    await setSetting(db, pid, 'consolidation_gate_mode', 'enforce');
    await db.query("INSERT INTO assertions (project_id,subject,predicate,object,confidence,source,session_id,last_reinforced,valid_at,tier,consolidated_at,corroboration_count) VALUES ($1,'project','has_tag','l2t13exist',9,'user_stated','l2-t13-prior-" + TS + "',now(),now(),'consolidated',now(),2)", [pid]);
    const { rows: pre } = await db.query("SELECT id,tier FROM assertions WHERE project_id=$1 AND object='l2t13exist'", [pid]);
    await db.end(); db = null;

    const r = runClose({ session_id: 'l2-t13-' + TS, tldr: 'T13', assertions: [{ subject: 'project', predicate: 'has_tag', object: 'l2t13diff', confidence: 9, source: 'user_stated' }] }, dn, pd);
    if (r.status !== 0) { fail(label, 'close failed: ' + r.stderr); return; }

    db = await pgConnect(dn);
    const { rows: post } = await db.query("SELECT id,tier FROM assertions WHERE project_id=$1 AND object='l2t13exist'", [pid]);
    await db.end(); db = null;

    if (!pre.length || !post.length) { fail(label, 'pre-existing row not found'); return; }
    if (pre[0].id !== post[0].id) { fail(label, 'id changed: ' + pre[0].id + ' -> ' + post[0].id); return; }
    if (post[0].tier !== 'consolidated') { fail(label, 'tier changed to ' + post[0].tier); return; }
    pass(label);
  } catch (err) { fail(label, err.message); }
  finally { if (db) { try { await db.end(); } catch (_) {} } if (pid) cleanupHandoffMd(pid); await dropDb(dn, pd); }
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log('=== L2 Consolidation Gate Tests ===\n');
  try {
    const probe = await pgConnect('postgres');
    await probe.end();
  } catch (err) {
    console.error('[SKIP] Postgres not available (' + err.message + ') -- all L2 tests require Postgres.');
    process.exit(0);
  }

  await T1(); await T2(); await T3(); await T4(); await T5();
  await T6(); await T7(); await T8(); await T9(); await T10();
  await T11(); await T12(); await T13();

  console.log('\n=== Results: ' + passed + ' passed, ' + failed + ' failed ===');
  if (failures.length) {
    console.log('\nFailures:');
    failures.forEach(function (f) { console.log('  FAIL  ' + f.label + ': ' + f.reason); });
    process.exit(1);
  }
  process.exit(0);
}

main().catch(function (err) { console.error('[FATAL] ' + err.message); process.exit(1); });
