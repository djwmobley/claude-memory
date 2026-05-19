'use strict';

/**
 * test-l5-directive-retirement.js — Comprehensive test suite for Lever L5.
 *
 * L5 adds a non-destructive, operator-only retirement path for 1:N directive
 * predicates whose OBJECT has changed (rule revised) but which were never
 * suppressed by the existing supersession path (exact-duplicate only).
 *
 * Coverage:
 *   T1  Registry: directive flag loads for all 7 marked predicates.
 *   T2  Registry: isDirective() true for all 7 marked predicates.
 *   T3  Registry: isDirective() false for non-directive predicates and unknowns.
 *   T4  Registry: invalid "directive" value (non-boolean) rejected by loadRegistry.
 *   T5  cmdRetire dry-run: no mutation (matched rows untouched).
 *   T6  cmdRetire --apply --object: retires exactly the one matched row; others untouched.
 *   T7  cmdRetire --apply without --object on directive predicate: retires ALL live rows.
 *   T8  cmdRetire without --object on non-directive predicate: refused (exit 2).
 *   T9  Retired row excluded from live retrieval query; still in table (recoverable).
 *   T10 --replace-with flag is NOT recognized (exit 2).
 *   T11 cmdPrune --suppression-kind retired: accepted as valid kind (dry-run no-op).
 *   T12 buildRetirementUpdate (SQLite): with-object SQL shape correct.
 *   T13 buildRetirementUpdate (SQLite): without-object SQL shape correct.
 *   T14 buildRetirementUpdate (Postgres): with-object SQL shape correct.
 *   T15 buildRetirementUpdate (Postgres): without-object SQL shape correct.
 *   T16 Steady-state write path unchanged (static scan).
 *   T17 No UPDATE SET tier in cmdRetire (static scan).
 *   T18 cmdRetire not wired into cmdClose or automated paths (static scan).
 *
 * Usage:
 *   node scripts/test-l5-directive-retirement.js
 *
 * Requires: Postgres available at PGHOST/PGUSER/PGPASSWORD (CI env) or localhost/postgres.
 * Exit 0 = all tests passed. Exit 1 = any failure.
 */

const { spawnSync } = require('child_process');
const fs   = require('fs');
const os   = require('os');
const path = require('path');
const { Client } = require('pg');

// ── Constants ─────────────────────────────────────────────────────────────────

const PROJECT_ROOT   = path.resolve(__dirname, '..');
const HANDOFF_SCRIPT = path.join(PROJECT_ROOT, 'scripts', 'handoff.js');
const TS             = Date.now();
const L5_DB          = `claude_memory_l5_test_${TS}`;

const TEMP_DIR = path.join(os.tmpdir(), `handoff_l5_${TS}`);

// ── Tracking ──────────────────────────────────────────────────────────────────

let passed  = 0;
let failed  = 0;
const failures = [];

function pass(label)         { console.log(`PASS  ${label}`); passed++; }
function fail(label, reason) { console.log(`FAIL  ${label}: ${reason}`); failures.push({ label, reason }); failed++; }

// ── Assertion helpers ─────────────────────────────────────────────────────────

function assertEqual(actual, expected, msg) {
  if (actual !== expected)
    throw new Error(`${msg || 'assertEqual'}: expected ${JSON.stringify(expected)} got ${JSON.stringify(actual)}`);
}

function assertTrue(v, msg) {
  if (!v) throw new Error(msg || `expected truthy, got ${JSON.stringify(v)}`);
}

function assertFalse(v, msg) {
  if (v) throw new Error(msg || `expected falsy, got ${JSON.stringify(v)}`);
}

// ── PG helpers ────────────────────────────────────────────────────────────────

async function pgConnect(dbName) {
  const cfg = {
    host:     process.env.PGHOST     || 'localhost',
    port:     parseInt(process.env.PGPORT || '5432', 10),
    user:     process.env.PGUSER     || 'postgres',
    password: process.env.PGPASSWORD || 'postgres',
    database: dbName,
  };
  const client = new Client(cfg);
  await client.connect();
  return client;
}

let _pgAvail = null;
async function isPgAvailable() {
  if (_pgAvail !== null) return _pgAvail;
  try {
    const c = await pgConnect('postgres');
    await c.end();
    _pgAvail = true;
  } catch (_) {
    _pgAvail = false;
    console.log('[INFO] Postgres unavailable — subprocess tests will be SKIPPED.');
  }
  return _pgAvail;
}

/** Encode a filesystem path into a project_id the same way handoff.js does. */
function encodeCwdLocal(p) {
  return p.replace(/[/\\]+$/, '').replace(/[^A-Za-z0-9-]/g, '-');
}

/** Spawn a handoff.js subcommand with the throwaway DB and the TEMP_DIR as PROJECT_ROOT. */
function runHandoff(args) {
  return spawnSync(
    process.execPath,
    [HANDOFF_SCRIPT, ...args],
    {
      cwd:      PROJECT_ROOT,
      env:      {
        ...process.env,
        PGHOST:       process.env.PGHOST     || 'localhost',
        PGUSER:       process.env.PGUSER     || 'postgres',
        PGPASSWORD:   process.env.PGPASSWORD || 'postgres',
        HANDOFF_DB:   L5_DB,
        PROJECT_ROOT: TEMP_DIR,
      },
      encoding: 'utf8',
      timeout:  30000,
    }
  );
}

/** Insert a live assertion row directly into the test DB. */
async function insertAssertion(db, projectId, subject, predicate, object, source) {
  const r = await db.query(
    `INSERT INTO assertions (project_id, subject, predicate, object, confidence, source)
     VALUES ($1, $2, $3, $4, 7, $5)
     RETURNING id`,
    [projectId, subject, predicate, object, source || 'user_stated']
  );
  return r.rows[0].id;
}

// ── Section 1: Registry directive flag ────────────────────────────────────────

async function runSection1() {
  console.log('\n=== Section 1: Registry directive flag ===');

  // We must clear the module cache because the registry module caches on first load.
  function freshRegistry() {
    // Clear all related cache entries.
    for (const key of Object.keys(require.cache)) {
      if (key.includes('predicate-registry')) delete require.cache[key];
    }
    return require('./lib/predicate-registry');
  }

  // T1: Registry loads with directive=true for all 7 marked predicates.
  try {
    const { loadRegistry } = freshRegistry();
    const { byPredicate } = loadRegistry();
    const directivePredicates = ['depends_on', 'must_do', 'never_uses', 'should', 'policy', 'enforces', 'is_constraint'];
    let ok = true;
    for (const p of directivePredicates) {
      const entry = byPredicate.get(p);
      if (!entry) {
        fail(`T1 registry: ${p} entry not found`, ''); ok = false;
      } else if (entry.directive !== true) {
        fail(`T1 registry: ${p} directive`, `directive=${entry.directive}, expected true`); ok = false;
      }
    }
    if (ok) pass('T1 registry: all 7 directive predicates have directive=true');
  } catch (err) {
    fail('T1 registry load', err.message);
  }

  // T2: isDirective() returns true for all 7 directive predicates.
  try {
    const { isDirective } = freshRegistry();
    const directivePredicates = ['depends_on', 'must_do', 'never_uses', 'should', 'policy', 'enforces', 'is_constraint'];
    let ok = true;
    for (const p of directivePredicates) {
      if (!isDirective(p)) { fail(`T2 isDirective(${p})`, `returned false, expected true`); ok = false; }
    }
    if (ok) pass('T2 isDirective() returns true for all 7 directive predicates');
  } catch (err) {
    fail('T2 isDirective', err.message);
  }

  // T3: isDirective() returns false for non-directive predicates and unrecognized.
  try {
    const { isDirective } = freshRegistry();
    const nonDirective = ['uses', 'covers', 'is', 'has', 'prefers', 'is_status', '_no_such_predicate_'];
    let ok = true;
    for (const p of nonDirective) {
      if (isDirective(p)) { fail(`T3 isDirective(${p})`, `returned true, expected false`); ok = false; }
    }
    if (ok) pass('T3 isDirective() returns false for non-directive predicates and unknowns');
  } catch (err) {
    fail('T3 isDirective non-directive', err.message);
  }

  // T4: invalid "directive" value (non-boolean) is rejected by loadRegistry.
  try {
    const regPath = path.join(__dirname, 'lib', 'predicate-registry.json');
    const original = fs.readFileSync(regPath, 'utf8');
    const parsed = JSON.parse(original);
    // Inject a bad entry with directive="yes" (string, not boolean).
    const badEntry = {
      predicate:    '_test_bad_directive_l5',
      cardinality:  '1:N',
      description:  'Test entry with invalid directive type',
      added_version: '1.1',
      directive:    'yes',  // invalid: not a boolean
    };
    parsed.entries.push(badEntry);
    fs.writeFileSync(regPath, JSON.stringify(parsed, null, 2));

    let threw = false;
    try {
      const { loadRegistry } = freshRegistry();
      loadRegistry();
    } catch (e) {
      threw = true;
      assertTrue(
        e.message.includes('_test_bad_directive_l5') || e.message.includes('directive'),
        `Error should mention the bad predicate or "directive": ${e.message}`
      );
    }
    // Restore the original registry BEFORE reporting.
    fs.writeFileSync(regPath, original);
    freshRegistry(); // clear cache

    if (threw) {
      pass('T4 loadRegistry rejects invalid directive value (non-boolean string)');
    } else {
      fail('T4 loadRegistry invalid directive', 'Expected an error for directive="yes" but none thrown');
    }
  } catch (err) {
    // Restore in any case.
    try {
      const regPath = path.join(__dirname, 'lib', 'predicate-registry.json');
      // Only restore if the file has been written (contains the bad entry).
      const contents = fs.readFileSync(regPath, 'utf8');
      if (contents.includes('_test_bad_directive_l5')) {
        // We lost the original — fail gracefully.
        fail('T4 registry restore', `Could not restore registry: ${err.message}`);
      }
    } catch (_) {}
    fail('T4 loadRegistry invalid directive', err.message);
  }
}

// ── Section 2: buildRetirementUpdate port methods (static shape) ──────────────

async function runSection2() {
  console.log('\n=== Section 2: buildRetirementUpdate port methods (static shape) ===');

  const { SQLiteAdapter, PostgresAdapter } = require('./lib/db-seam');

  // T12: SQLiteAdapter.buildRetirementUpdate with-object.
  try {
    const db = new SQLiteAdapter(':memory:');
    const stmt = db.buildRetirementUpdate('proj', 'subj', 'must_do', 'rule-A', true);
    assertTrue(stmt.sql.includes("suppressed = 1"), 'SQLite: set suppressed = 1');
    assertTrue(stmt.sql.includes("datetime('now')"), 'SQLite: set invalid_at = datetime(now)');
    assertTrue(stmt.sql.includes("suppression_kind = 'retired'"), 'SQLite: set suppression_kind=retired');
    assertTrue(stmt.sql.includes("object     = ?"), 'SQLite with-object: filter on object');
    assertTrue(stmt.sql.includes("suppressed = 0"), 'SQLite: guard suppressed = 0');
    assertTrue(stmt.sql.includes("invalid_at IS NULL"), 'SQLite: guard invalid_at IS NULL');
    assertEqual(stmt.params.length, 4, 'SQLite with-object: 4 params');
    pass('T12 SQLiteAdapter.buildRetirementUpdate with-object SQL shape correct');
  } catch (err) {
    fail('T12', err.message);
  }

  // T13: SQLiteAdapter.buildRetirementUpdate without-object.
  try {
    const db = new SQLiteAdapter(':memory:');
    const stmt = db.buildRetirementUpdate('proj', 'subj', 'must_do', undefined, false);
    assertTrue(stmt.sql.includes("suppressed = 1"), 'SQLite: set suppressed = 1');
    assertTrue(stmt.sql.includes("datetime('now')"), 'SQLite: set invalid_at');
    assertTrue(stmt.sql.includes("suppression_kind = 'retired'"), 'SQLite: set retired');
    assertFalse(/\bobject\b/.test(stmt.sql), 'SQLite without-object: must NOT filter on object');
    assertEqual(stmt.params.length, 3, 'SQLite without-object: 3 params');
    pass('T13 SQLiteAdapter.buildRetirementUpdate without-object SQL shape correct');
  } catch (err) {
    fail('T13', err.message);
  }

  // T14: PostgresAdapter.buildRetirementUpdate with-object.
  try {
    const db = new PostgresAdapter(null);
    const stmt = db.buildRetirementUpdate('proj', 'subj', 'must_do', 'rule-A', true);
    assertTrue(stmt.sql.includes("suppressed = true"), 'Postgres: set suppressed = true');
    assertTrue(stmt.sql.includes("invalid_at = now()"), 'Postgres: set invalid_at = now()');
    assertTrue(stmt.sql.includes("suppression_kind = 'retired'"), 'Postgres: set suppression_kind=retired');
    assertTrue(stmt.sql.includes("object     = $4"), 'Postgres with-object: filter on object at $4');
    assertTrue(stmt.sql.includes("suppressed = false"), 'Postgres: guard suppressed = false');
    assertTrue(stmt.sql.includes("invalid_at IS NULL"), 'Postgres: guard invalid_at IS NULL');
    assertEqual(stmt.params.length, 4, 'Postgres with-object: 4 params');
    pass('T14 PostgresAdapter.buildRetirementUpdate with-object SQL shape correct');
  } catch (err) {
    fail('T14', err.message);
  }

  // T15: PostgresAdapter.buildRetirementUpdate without-object.
  try {
    const db = new PostgresAdapter(null);
    const stmt = db.buildRetirementUpdate('proj', 'subj', 'must_do', undefined, false);
    assertTrue(stmt.sql.includes("suppressed = true"), 'Postgres: set suppressed = true');
    assertTrue(stmt.sql.includes("invalid_at = now()"), 'Postgres: set invalid_at');
    assertTrue(stmt.sql.includes("suppression_kind = 'retired'"), 'Postgres: set retired');
    assertFalse(/\bobject\b/.test(stmt.sql), 'Postgres without-object: must NOT filter on object');
    assertEqual(stmt.params.length, 3, 'Postgres without-object: 3 params');
    pass('T15 PostgresAdapter.buildRetirementUpdate without-object SQL shape correct');
  } catch (err) {
    fail('T15', err.message);
  }
}

// ── Section 3: Static code scans ─────────────────────────────────────────────

async function runSection3() {
  console.log('\n=== Section 3: Static code scans ===');

  const handoffSrc = fs.readFileSync(HANDOFF_SCRIPT, 'utf8');

  // T16: Steady-state write path unchanged — buildRetirementUpdate confined to cmdRetire.
  try {
    // Identify the line range of cmdRetire.
    const retireStart = handoffSrc.indexOf('async function cmdRetire(');
    const retireEnd   = handoffSrc.indexOf('\nasync function ', retireStart + 1);
    const lines = handoffSrc.split('\n');
    // Convert char offsets to line numbers.
    let charIdx = 0;
    const lineStarts = [];
    for (const line of lines) { lineStarts.push(charIdx); charIdx += line.length + 1; }
    const retireStartLine = lineStarts.findIndex((s) => s >= retireStart);
    const retireEndLine   = retireEnd !== -1 ? lineStarts.findIndex((s) => s >= retireEnd) : lines.length;

    let writePathViolation = null;
    for (let i = 0; i < lines.length; i++) {
      if (i >= retireStartLine && i < retireEndLine) continue; // inside cmdRetire — OK
      const line = lines[i];
      const trimmed = line.trim();
      if (trimmed.startsWith('//') || trimmed.startsWith('*')) continue; // comment lines
      if (/buildRetirementUpdate/.test(line)) {
        writePathViolation = `line ${i + 1}: ${line.trim()}`;
      }
    }
    if (writePathViolation) {
      fail('T16 steady-state write path', `buildRetirementUpdate found outside cmdRetire: ${writePathViolation}`);
    } else {
      pass('T16 buildRetirementUpdate confined to cmdRetire — write path unchanged');
    }
  } catch (err) {
    fail('T16 static scan', err.message);
  }

  // T17: No UPDATE SET tier in cmdRetire.
  try {
    const retireStart = handoffSrc.indexOf('async function cmdRetire(');
    const retireEnd   = handoffSrc.indexOf('\nasync function ', retireStart + 1);
    const retireBody  = retireEnd !== -1
      ? handoffSrc.slice(retireStart, retireEnd)
      : handoffSrc.slice(retireStart);
    if (/SET\s+tier\b/.test(retireBody)) {
      fail('T17 no UPDATE SET tier', 'Found SET tier in cmdRetire body');
    } else {
      pass('T17 no UPDATE SET tier anywhere in cmdRetire body');
    }
  } catch (err) {
    fail('T17 static scan', err.message);
  }

  // T18: cmdRetire not wired into cmdClose or automated paths.
  try {
    const automatedFns = ['cmdClose', 'cmdCheckpoint', 'cmdDrop', 'cmdQueueDrain'];
    let violation = null;
    for (const fnName of automatedFns) {
      const fnStart = handoffSrc.indexOf(`async function ${fnName}(`);
      if (fnStart === -1) continue;
      const fnEnd  = handoffSrc.indexOf('\nasync function ', fnStart + 1);
      const fnBody = fnEnd !== -1 ? handoffSrc.slice(fnStart, fnEnd) : handoffSrc.slice(fnStart);
      if (/cmdRetire\b/.test(fnBody)) {
        violation = `${fnName} calls cmdRetire`; break;
      }
    }
    if (violation) {
      fail('T18 cmdRetire not in automated paths', violation);
    } else {
      pass('T18 cmdRetire is NOT wired into cmdClose or any automated path');
    }
  } catch (err) {
    fail('T18 static scan', err.message);
  }
}

// ── Section 4: Subprocess integration tests (Postgres) ───────────────────────

async function runSection4() {
  console.log('\n=== Section 4: Subprocess integration tests ===');

  const pgAvail = await isPgAvailable();
  if (!pgAvail) {
    console.log('[SKIP] Section 4: Postgres unavailable — subprocess tests skipped.');
    return;
  }

  // Create throwaway DB.
  let sys = await pgConnect('postgres');
  await sys.query(`CREATE DATABASE "${L5_DB}"`);
  await sys.end();

  // Apply the handoff schema.
  let db = await pgConnect(L5_DB);
  const schemaSql = fs.readFileSync(
    path.join(PROJECT_ROOT, 'scripts', 'sql', 'handoff-core-schema.sql'), 'utf8'
  );
  await db.query(schemaSql);

  // Project ID derived from TEMP_DIR (the way handoff.js resolveProjectId() does it).
  fs.mkdirSync(TEMP_DIR, { recursive: true });
  const projectId = encodeCwdLocal(TEMP_DIR);

  // ── T5: dry-run mutates nothing ──────────────────────────────────────────────
  try {
    const id1 = await insertAssertion(db, projectId, 'rule-engine', 'must_do', 'validate-input');
    const id2 = await insertAssertion(db, projectId, 'rule-engine', 'must_do', 'log-errors');

    const result = runHandoff(['retire', '--subject', 'rule-engine', '--predicate', 'must_do']);
    if (result.status !== 0) {
      fail('T5 dry-run exits 0', `exit ${result.status}\nstderr: ${result.stderr}\nstdout: ${result.stdout}`);
    } else {
      const { rows } = await db.query(
        `SELECT suppressed, suppression_kind FROM assertions WHERE project_id=$1 AND predicate='must_do'`,
        [projectId]
      );
      const allLive = rows.every((r) => r.suppressed === false && r.suppression_kind === null);
      if (allLive) {
        pass('T5 cmdRetire dry-run: no mutation; rows remain live');
      } else {
        fail('T5 dry-run mutates nothing', `Rows were mutated: ${JSON.stringify(rows)}`);
      }
    }
    await db.query(`DELETE FROM assertions WHERE project_id=$1`, [projectId]);
  } catch (err) {
    fail('T5 dry-run', err.message);
  }

  // ── T6: --apply --object retires exactly the one matched row ────────────────
  try {
    await insertAssertion(db, projectId, 'system', 'must_do', 'check-A');
    await insertAssertion(db, projectId, 'system', 'must_do', 'check-B');
    await insertAssertion(db, projectId, 'system', 'policy',  'rule-X');

    const result = runHandoff([
      'retire', '--subject', 'system', '--predicate', 'must_do', '--object', 'check-A', '--apply',
    ]);
    if (result.status !== 0) {
      fail('T6 --apply --object exits 0', `exit ${result.status}\nstderr: ${result.stderr}`);
    } else {
      const { rows } = await db.query(
        `SELECT object, suppressed, suppression_kind, invalid_at FROM assertions
         WHERE project_id=$1 ORDER BY object`,
        [projectId]
      );
      const checkA = rows.find((r) => r.object === 'check-A');
      const checkB = rows.find((r) => r.object === 'check-B');
      const ruleX  = rows.find((r) => r.object === 'rule-X');

      let ok = true;
      if (!checkA || checkA.suppressed !== true)            { fail('T6 check-A suppressed', JSON.stringify(checkA)); ok = false; }
      if (!checkA || checkA.suppression_kind !== 'retired') { fail('T6 check-A kind=retired', JSON.stringify(checkA)); ok = false; }
      if (!checkA || !checkA.invalid_at)                    { fail('T6 check-A invalid_at set', JSON.stringify(checkA)); ok = false; }
      if (!checkB || checkB.suppressed !== false)            { fail('T6 check-B untouched', JSON.stringify(checkB)); ok = false; }
      if (!ruleX  || ruleX.suppressed !== false)             { fail('T6 rule-X untouched', JSON.stringify(ruleX)); ok = false; }
      if (ok) pass('T6 --apply --object: retires exactly the one row; others untouched');
    }
    await db.query(`DELETE FROM assertions WHERE project_id=$1`, [projectId]);
  } catch (err) {
    fail('T6 --apply --object', err.message);
  }

  // ── T7: --apply without --object retires all live rows for (subject, predicate) ──
  try {
    await insertAssertion(db, projectId, 'agent', 'never_uses', 'tool-A');
    await insertAssertion(db, projectId, 'agent', 'never_uses', 'tool-B');
    await insertAssertion(db, projectId, 'agent', 'must_do',    'check-C');
    await insertAssertion(db, projectId, 'other-agent', 'never_uses', 'tool-A');

    const result = runHandoff([
      'retire', '--subject', 'agent', '--predicate', 'never_uses', '--apply',
    ]);
    if (result.status !== 0) {
      fail('T7 without --object exits 0', `exit ${result.status}\nstderr: ${result.stderr}`);
    } else {
      const { rows } = await db.query(
        `SELECT subject, predicate, object, suppressed, suppression_kind
         FROM assertions WHERE project_id=$1 ORDER BY subject, predicate, object`,
        [projectId]
      );
      const toolA  = rows.find((r) => r.subject === 'agent' && r.predicate === 'never_uses' && r.object === 'tool-A');
      const toolB  = rows.find((r) => r.subject === 'agent' && r.predicate === 'never_uses' && r.object === 'tool-B');
      const checkC = rows.find((r) => r.subject === 'agent' && r.predicate === 'must_do');
      const otherA = rows.find((r) => r.subject === 'other-agent');

      let ok = true;
      if (!toolA  || toolA.suppressed !== true  || toolA.suppression_kind !== 'retired')  { fail('T7 tool-A retired', JSON.stringify(toolA)); ok = false; }
      if (!toolB  || toolB.suppressed !== true  || toolB.suppression_kind !== 'retired')  { fail('T7 tool-B retired', JSON.stringify(toolB)); ok = false; }
      if (!checkC || checkC.suppressed !== false)  { fail('T7 check-C (different predicate) untouched', JSON.stringify(checkC)); ok = false; }
      if (!otherA || otherA.suppressed !== false)  { fail('T7 other-agent untouched', JSON.stringify(otherA)); ok = false; }
      if (ok) pass('T7 --apply without --object: retires ALL live rows for (subject, predicate) only');
    }
    await db.query(`DELETE FROM assertions WHERE project_id=$1`, [projectId]);
  } catch (err) {
    fail('T7 without-object apply', err.message);
  }

  // ── T8: without --object on non-directive predicate refused (exit 2) ─────────
  try {
    const result = runHandoff([
      'retire', '--subject', 'some-subject', '--predicate', 'uses',
    ]);
    if (result.status === 2) {
      assertTrue(
        result.stderr.includes('--object') || result.stderr.includes('directive'),
        `stderr should mention --object or directive: ${result.stderr}`
      );
      pass('T8 non-directive without --object: refused with exit 2');
    } else {
      fail('T8', `Expected exit 2, got ${result.status}. stderr: ${result.stderr}`);
    }
  } catch (err) {
    fail('T8 non-directive without --object', err.message);
  }

  // ── T9: retired row excluded from live retrieval; still in table (recoverable) ──
  try {
    const id1 = await insertAssertion(db, projectId, 'config-service', 'policy', 'no-debug-in-prod');

    const retireResult = runHandoff([
      'retire', '--subject', 'config-service', '--predicate', 'policy',
      '--object', 'no-debug-in-prod', '--apply',
    ]);
    if (retireResult.status !== 0) {
      fail('T9 setup retire', `exit ${retireResult.status}: ${retireResult.stderr}`);
    } else {
      // Row still exists in the table.
      const { rows: allRows } = await db.query(
        `SELECT id, suppressed, suppression_kind, invalid_at FROM assertions
         WHERE project_id=$1 AND id=$2`,
        [projectId, id1]
      );
      assertEqual(allRows.length, 1, 'T9: retired row must still be in table');
      assertEqual(allRows[0].suppression_kind, 'retired', 'T9: suppression_kind=retired');
      assertTrue(allRows[0].suppressed === true, 'T9: suppressed=true');
      assertTrue(allRows[0].invalid_at !== null, 'T9: invalid_at set');

      // Excluded from live retrieval (suppressed=false AND invalid_at IS NULL).
      const { rows: liveRows } = await db.query(
        `SELECT id FROM assertions
         WHERE project_id=$1 AND id=$2 AND suppressed=false AND invalid_at IS NULL`,
        [projectId, id1]
      );
      assertEqual(liveRows.length, 0, 'T9: retired row must not appear in live retrieval query');

      pass('T9 retired row: excluded from retrieval but still in table (recoverable)');
    }
    await db.query(`DELETE FROM assertions WHERE project_id=$1`, [projectId]);
  } catch (err) {
    fail('T9 retrieval exclusion', err.message);
  }

  // ── T10: --replace-with flag NOT recognized (exit 2) ─────────────────────────
  try {
    const result = runHandoff([
      'retire', '--subject', 'x', '--predicate', 'must_do',
      '--object', 'old-rule', '--replace-with', 'new-rule',
    ]);
    if (result.status === 2) {
      assertTrue(
        result.stderr.includes('--replace-with') || result.stderr.includes('replace'),
        `stderr should mention --replace-with: ${result.stderr}`
      );
      pass('T10 --replace-with not recognized: exits 2 with clear error');
    } else {
      fail('T10 --replace-with', `Expected exit 2, got ${result.status}. stderr: ${result.stderr}`);
    }
  } catch (err) {
    fail('T10 --replace-with', err.message);
  }

  // ── T11: prune --suppression-kind retired accepted (dry-run no-op) ─────────────
  try {
    const result = runHandoff(['prune', '--suppression-kind', 'retired']);
    if (result.status !== 0) {
      fail('T11 prune --suppression-kind retired', `exit ${result.status}: ${result.stderr}`);
    } else {
      assertFalse(
        result.stderr.includes('invalid'),
        `prune should not reject 'retired' as invalid: ${result.stderr}`
      );
      pass("T11 prune --suppression-kind retired: accepted as valid kind (dry-run no-op)");
    }
  } catch (err) {
    fail('T11 prune --suppression-kind retired', err.message);
  }

  // ── Cleanup ──────────────────────────────────────────────────────────────────
  try { await db.end(); } catch (_) {}

  let dropClient = null;
  try {
    dropClient = await pgConnect('postgres');
    await dropClient.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()`,
      [L5_DB]
    );
    await dropClient.query(`DROP DATABASE IF EXISTS "${L5_DB}"`);
  } catch (_) {} finally {
    if (dropClient) { try { await dropClient.end(); } catch (_) {} }
  }
  try { fs.rmSync(TEMP_DIR, { recursive: true, force: true }); } catch (_) {}
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('=== test-l5-directive-retirement.js ===');
  console.log(`Node: ${process.versions.node}`);

  await runSection1();
  await runSection2();
  await runSection3();
  await runSection4();

  console.log('');
  console.log(`Results: ${passed} passed, ${failed} failed`);
  if (failures.length > 0) {
    console.log('\nFailures:');
    for (const f of failures) {
      console.log(`  FAIL  ${f.label}: ${f.reason}`);
    }
    process.exit(1);
  }
  console.log('\nAll tests passed.');
  process.exit(0);
}

main().catch((err) => {
  console.error('Unexpected error:', err);
  process.exit(1);
});
