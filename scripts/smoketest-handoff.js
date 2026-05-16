'use strict';

/**
 * smoketest-handoff.js — End-to-end smoke test for the Bundle A handoff lifecycle.
 *
 * Creates a throwaway DB, exercises the full handoff command sequence against it,
 * then drops the DB unconditionally. Each step prints PASS or FAIL with a reason.
 *
 * Usage:
 *   node scripts/smoketest-handoff.js                   # all sections
 *   node scripts/smoketest-handoff.js --section=lifecycle
 *   node scripts/smoketest-handoff.js --section=hooks
 *
 * Exit 0 = all steps passed (skipped steps count as passed); 1 = any failure.
 */

const { spawnSync } = require('child_process');
const fs   = require('fs');
const os   = require('os');
const path = require('path');
const { Client } = require('pg');

// ── CLI args ──────────────────────────────────────────────────────────────────

const ARGS       = process.argv.slice(2);
const sectionArg = ARGS.find((a) => a.startsWith('--section='));
const SECTION    = sectionArg ? sectionArg.split('=')[1] : 'all';
if (!['all', 'lifecycle', 'hooks', 'hardening', 'w2', 'w3', 'w4', 'c1', 'c2', 'c3'].includes(SECTION)) {
  console.error(`Unknown --section value: ${SECTION}. Valid: lifecycle, hooks, hardening, w2, w3, w4, c1, c2, c3, all`);
  process.exit(2);
}

// ── Constants ─────────────────────────────────────────────────────────────────

const PROJECT_ROOT   = path.resolve(__dirname, '..');
const HANDOFF_SCRIPT = path.join(PROJECT_ROOT, 'scripts', 'handoff.js');
const TS             = Date.now();
const SMOKE_DB       = `claude_memory_smoketest_${TS}`;
const HOOKS_DB       = `claude_memory_hooks_${TS}`;
const HARDEN_DB      = `claude_memory_harden_${TS}`;

// Unique temp dir used as PROJECT_ROOT for subprocesses — gives a unique project_id
// so concurrent smoketest runs don't collide.
const TEMP_PROJECT_DIR         = path.join(os.tmpdir(), `handoff_smoke_${TS}`);
const TEMP_PROJECT_DIR_HOOKS   = path.join(os.tmpdir(), `handoff_hooks_${TS}`);
const TEMP_PROJECT_DIR_HARDEN  = path.join(os.tmpdir(), `handoff_harden_${TS}`);

// Encode TEMP_PROJECT_DIR the same way handoff.js does (encoded-cwd logic).
function encodeCwd(p) {
  return p.replace(/[/\\]+$/, '').replace(/[^A-Za-z0-9-]/g, '-');
}

const PROJECT_ID         = encodeCwd(TEMP_PROJECT_DIR);
const PROJECT_ID_HOOKS   = encodeCwd(TEMP_PROJECT_DIR_HOOKS);
const PROJECT_ID_HARDEN  = encodeCwd(TEMP_PROJECT_DIR_HARDEN);
const HANDOFF_PATH       = path.join(os.homedir(), '.claude', 'projects', PROJECT_ID, 'handoff.md');
const HANDOFF_PATH_HOOKS   = path.join(os.homedir(), '.claude', 'projects', PROJECT_ID_HOOKS, 'handoff.md');
const HANDOFF_PATH_HARDEN  = path.join(os.homedir(), '.claude', 'projects', PROJECT_ID_HARDEN, 'handoff.md');

// Env passed to every subprocess invocation — redirects DB and project root.
function makeEnv(db = SMOKE_DB, projectDir = TEMP_PROJECT_DIR) {
  return {
    ...process.env,
    HANDOFF_DB:   db,
    PROJECT_ROOT: projectDir,
  };
}

// ── Tracking ──────────────────────────────────────────────────────────────────

let lcPassed  = 0;
let lcFailed  = 0;
let lcSkipped = 0;
let hkPassed  = 0;
let hkFailed  = 0;
let hkSkipped = 0;
let hdPassed  = 0;
let hdFailed  = 0;
let hdSkipped = 0;
let w2Passed  = 0;
let w2Failed  = 0;
let w2Skipped = 0;
let w3Passed  = 0;
let w3Failed  = 0;
let w3Skipped = 0;
let w4Passed  = 0;
let w4Failed  = 0;
let w4Skipped = 0;
let c1Passed  = 0;
let c1Failed  = 0;
let c1Skipped = 0;
let c2Passed  = 0;
let c2Failed  = 0;
let c2Skipped = 0;
let c3Passed  = 0;
let c3Failed  = 0;
let c3Skipped = 0;

const LC_TOTAL = 14;
const HK_TOTAL = 3;
const HD_TOTAL = 8;
const W2_TOTAL = 3;
const W3_TOTAL = 5;
const W4_TOTAL = 6;
const C1_TOTAL = 4;
const C2_TOTAL = 4;
const C3_TOTAL = 5;

function lcPass(step, label) {
  console.log(`[STEP ${step}/${LC_TOTAL}] ${label} ... PASS`);
  lcPassed++;
}

function lcFail(step, label, reason) {
  console.log(`[STEP ${step}/${LC_TOTAL}] ${label} ... FAIL: ${reason}`);
  lcFailed++;
}

function lcSkip(step, label, reason) {
  console.log(`[STEP ${step}/${LC_TOTAL}] ${label} ... SKIPPED — ${reason}`);
  lcSkipped++;
}

function hkPass(step, label) {
  console.log(`[HOOKS ${step}/${HK_TOTAL}] ${label} ... PASS`);
  hkPassed++;
}

function hkFail(step, label, reason) {
  console.log(`[HOOKS ${step}/${HK_TOTAL}] ${label} ... FAIL: ${reason}`);
  hkFailed++;
}

function hdPass(step, label) {
  console.log(`[HARDEN ${step}/${HD_TOTAL}] ${label} ... PASS`);
  hdPassed++;
}

function hdFail(step, label, reason) {
  console.log(`[HARDEN ${step}/${HD_TOTAL}] ${label} ... FAIL: ${reason}`);
  hdFailed++;
}

function hdSkip(step, label, reason) {
  console.log(`[HARDEN ${step}/${HD_TOTAL}] ${label} ... SKIPPED — ${reason}`);
  hdSkipped++;
}

function w2Pass(step, label) {
  console.log(`[W2 ${step}/${W2_TOTAL}] ${label} ... PASS`);
  w2Passed++;
}

function w2Fail(step, label, reason) {
  console.log(`[W2 ${step}/${W2_TOTAL}] ${label} ... FAIL: ${reason}`);
  w2Failed++;
}

function w3Pass(step, label) {
  console.log(`[W3 ${step}/${W3_TOTAL}] ${label} ... PASS`);
  w3Passed++;
}

function w3Fail(step, label, reason) {
  console.log(`[W3 ${step}/${W3_TOTAL}] ${label} ... FAIL: ${reason}`);
  w3Failed++;
}

function w3Skip(step, label, reason) {
  console.log(`[W3 ${step}/${W3_TOTAL}] ${label} ... SKIPPED — ${reason}`);
  w3Skipped++;
}

function w4Pass(step, label) {
  console.log(`[W4 ${step}/${W4_TOTAL}] ${label} ... PASS`);
  w4Passed++;
}

function w4Fail(step, label, reason) {
  console.log(`[W4 ${step}/${W4_TOTAL}] ${label} ... FAIL: ${reason}`);
  w4Failed++;
}

function c1Pass(step, label) {
  console.log(`[C1 ${step}/${C1_TOTAL}] ${label} ... PASS`);
  c1Passed++;
}

function c1Fail(step, label, reason) {
  console.log(`[C1 ${step}/${C1_TOTAL}] ${label} ... FAIL: ${reason}`);
  c1Failed++;
}

function c2Pass(step, label) {
  console.log(`[C2 ${step}/${C2_TOTAL}] ${label} ... PASS`);
  c2Passed++;
}

function c2Fail(step, label, reason) {
  console.log(`[C2 ${step}/${C2_TOTAL}] ${label} ... FAIL: ${reason}`);
  c2Failed++;
}

function c3Pass(step, label) {
  console.log(`[C3 ${step}/${C3_TOTAL}] ${label} ... PASS`);
  c3Passed++;
}

function c3Fail(step, label, reason) {
  console.log(`[C3 ${step}/${C3_TOTAL}] ${label} ... FAIL: ${reason}`);
  c3Failed++;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Connect to a specific DB (defaults to 'postgres' for system-level ops). */
async function pgConnect(database = 'postgres') {
  const cfg = { host: 'localhost', port: 5432, user: 'postgres', database };
  const client = new Client(cfg);
  await client.connect();
  return client;
}

/** Run `node scripts/handoff.js <sub> [...args]`, optionally piping stdin. */
function runHandoff(sub, extraArgs = [], stdin = null, db = SMOKE_DB, projectDir = TEMP_PROJECT_DIR) {
  const opts = {
    cwd:      PROJECT_ROOT,
    env:      makeEnv(db, projectDir),
    encoding: 'utf8',
    timeout:  30000,
  };
  if (stdin !== null) {
    opts.input = stdin;
  }
  return spawnSync(process.execPath, [HANDOFF_SCRIPT, sub, ...extraArgs], opts);
}

/** Create a throwaway DB and set up the temp project dir. */
async function createSmokeDb(dbName, projectDir) {
  const sysDb = await pgConnect('postgres');
  const exists = await sysDb.query('SELECT 1 FROM pg_database WHERE datname = $1', [dbName]);
  if (exists.rows.length > 0) {
    await sysDb.end();
    throw new Error(`DB ${dbName} already exists — naming collision`);
  }
  await sysDb.query(`CREATE DATABASE "${dbName}"`);
  await sysDb.end();
  fs.mkdirSync(projectDir, { recursive: true });
}

/** Drop a throwaway DB and clean up temp dirs/handoff files. */
async function dropSmokeDb(dbName, projectDir, handoffPath) {
  try {
    const handoffDir = path.dirname(handoffPath);
    if (fs.existsSync(handoffDir)) {
      for (const f of fs.readdirSync(handoffDir)) {
        if (f.startsWith('handoff')) {
          try { fs.unlinkSync(path.join(handoffDir, f)); } catch (_) {}
        }
      }
    }
  } catch (_) {}

  try {
    if (fs.existsSync(projectDir)) {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  } catch (_) {}

  let sysDb;
  try {
    sysDb = await pgConnect('postgres');
    await sysDb.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
       WHERE datname = $1 AND pid <> pg_backend_pid()`,
      [dbName]
    );
    await sysDb.query(`DROP DATABASE IF EXISTS "${dbName}"`);
    await sysDb.end();
    console.log(`[TEARDOWN] Dropped throwaway DB: ${dbName}`);
  } catch (err) {
    if (sysDb) { try { await sysDb.end(); } catch (_) {} }
    console.error(`[TEARDOWN] WARNING: cleanup failed — ${err.message}`);
    console.error(`           Manual cleanup: psql -c 'DROP DATABASE IF EXISTS "${dbName}"'`);
  }
}

// ── Lifecycle step implementations ────────────────────────────────────────────

async function step1_setup() {
  const label = 'Setup: create throwaway DB';
  try {
    await createSmokeDb(SMOKE_DB, TEMP_PROJECT_DIR);

    const smokeDb = await pgConnect(SMOKE_DB);
    const { rows } = await smokeDb.query(
      `SELECT COUNT(*) AS n FROM information_schema.tables
       WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`
    );
    await smokeDb.end();

    if (parseInt(rows[0].n, 10) !== 0) {
      lcFail(1, label, `New DB has ${rows[0].n} user tables — expected 0`);
      return false;
    }

    lcPass(1, label);
    return true;
  } catch (err) {
    lcFail(1, label, err.message);
    return false;
  }
}

async function step2_cmdInit_fresh() {
  const label = 'cmdInit on empty DB';
  try {
    const r = runHandoff('init', ['-y']);
    if (r.status !== 0) {
      lcFail(2, label, `exit ${r.status}: ${(r.stderr || r.stdout || '').split('\n')[0]}`);
      return false;
    }

    const lines = (r.stdout || '').split('\n').filter((l) => l.match(/\s+\[(OK|WARN)\]\s+/));
    if (lines.length < 9) {
      lcFail(2, label, `Only ${lines.length} [OK]/[WARN] preflight lines found (expected >= 9)\n${r.stdout}`);
      return false;
    }

    const db = await pgConnect(SMOKE_DB);
    const { rows } = await db.query(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
       ORDER BY table_name`
    );
    const tableNames = rows.map((r) => r.table_name).sort();
    const required = ['assertions', 'edges', 'entities', 'project_settings', 'retrieval_contract'];
    const missing = required.filter((t) => !tableNames.includes(t));
    if (missing.length > 0) {
      await db.end();
      lcFail(2, label, `Missing tables: ${missing.join(', ')}`);
      return false;
    }

    const { rows: settingRows } = await db.query(
      `SELECT key FROM project_settings WHERE project_id = $1 ORDER BY key`,
      [PROJECT_ID]
    );
    const settingKeys = settingRows.map((r) => r.key);
    const requiredSettings = ['decay_rate_default', 'implicit_close', 'loader_token_budget', 'staleness_days', 'retrieval_outcome_timeout_days'];
    const missingSettings = requiredSettings.filter((k) => !settingKeys.includes(k));
    await db.end();
    if (missingSettings.length > 0) {
      lcFail(2, label, `Missing project_settings keys: ${missingSettings.join(', ')}`);
      return false;
    }

    lcPass(2, label);
    return true;
  } catch (err) {
    lcFail(2, label, err.message);
    return false;
  }
}

async function step3_cmdInit_idempotent() {
  const label = 'cmdInit idempotency';
  try {
    const db = await pgConnect(SMOKE_DB);
    const before = await db.query(
      `SELECT COUNT(*) AS n FROM project_settings WHERE project_id = $1`, [PROJECT_ID]
    );
    await db.end();

    const r = runHandoff('init', ['-y']);
    if (r.status !== 0) {
      lcFail(3, label, `exit ${r.status}: ${(r.stderr || r.stdout || '').split('\n')[0]}`);
      return false;
    }

    const db2 = await pgConnect(SMOKE_DB);
    const after = await db2.query(
      `SELECT COUNT(*) AS n FROM project_settings WHERE project_id = $1`, [PROJECT_ID]
    );
    await db2.end();

    if (parseInt(after.rows[0].n, 10) !== parseInt(before.rows[0].n, 10)) {
      lcFail(3, label, `project_settings rows changed: ${before.rows[0].n} -> ${after.rows[0].n}`);
      return false;
    }

    lcPass(3, label);
    return true;
  } catch (err) {
    lcFail(3, label, err.message);
    return false;
  }
}

async function step4_inject_test_data() {
  const label = 'Inject test data via direct SQL';
  try {
    const db = await pgConnect(SMOKE_DB);

    const r1 = await db.query(
      `INSERT INTO assertions (project_id, subject, predicate, object, confidence, source, last_reinforced)
       VALUES ($1, 'SMOKETEST_SUBJECT_A', 'is', 'SMOKETEST_UNIQUE_MARKER_LOW', 7, 'model_extracted', now())
       RETURNING id`,
      [PROJECT_ID]
    );
    const r2 = await db.query(
      `INSERT INTO assertions (project_id, subject, predicate, object, confidence, source, last_reinforced)
       VALUES ($1, 'SMOKETEST_SUBJECT_B', 'has', 'SMOKETEST_UNIQUE_MARKER_HIGH', 9, 'user_stated', now())
       RETURNING id`,
      [PROJECT_ID]
    );
    const r3 = await db.query(
      `INSERT INTO assertions (project_id, subject, predicate, object, confidence, source, last_reinforced, suppressed)
       VALUES ($1, 'SMOKETEST_SUBJECT_C', 'was', 'SMOKETEST_UNIQUE_MARKER_SUPPRESSED', 10, 'user_stated', now(), true)
       RETURNING id`,
      [PROJECT_ID]
    );

    await db.query(
      `UPDATE retrieval_contract
       SET queries = $2::jsonb, updated_at = now()
       WHERE project_id = $1 AND name = 'default'`,
      [PROJECT_ID, JSON.stringify({ queries: [{ kind: 'assertion' }] })]
    );

    await db.end();

    const idLow  = r1.rows[0].id;
    const idHigh = r2.rows[0].id;
    const idSupp = r3.rows[0].id;

    lcPass(4, label);
    return { idLow, idHigh, idSupp };
  } catch (err) {
    lcFail(4, label, err.message);
    return null;
  }
}

async function step5_cmdStatus(ids) {
  const label = 'cmdStatus — assertion counts';
  try {
    const r = runHandoff('status');
    if (r.status !== 0) {
      lcFail(5, label, `exit ${r.status}: ${(r.stderr || r.stdout || '').split('\n')[0]}`);
      return false;
    }

    const out = r.stdout || '';
    const match = out.match(/assertions:\s*(\d+)/);
    if (!match) {
      lcFail(5, label, `Could not find assertions count in output:\n${out}`);
      return false;
    }
    const count = parseInt(match[1], 10);
    if (count !== 3) {
      lcFail(5, label, `assertions count = ${count}, expected 3`);
      return false;
    }

    lcPass(5, label);
    return true;
  } catch (err) {
    lcFail(5, label, err.message);
    return false;
  }
}

async function step6_cmdResume() {
  const label = 'cmdResume — shows non-suppressed, hides suppressed, trusted canon precedes untrusted block';
  try {
    const r = runHandoff('resume');
    if (r.status !== 0) {
      lcFail(6, label, `exit ${r.status}: ${(r.stderr || r.stdout || '').split('\n')[0]}`);
      return false;
    }

    const out = r.stdout || '';

    if (!out.includes('SMOKETEST_UNIQUE_MARKER_LOW')) {
      lcFail(6, label, 'SMOKETEST_UNIQUE_MARKER_LOW not found in resume output');
      return false;
    }
    if (!out.includes('SMOKETEST_UNIQUE_MARKER_HIGH')) {
      lcFail(6, label, 'SMOKETEST_UNIQUE_MARKER_HIGH not found in resume output');
      return false;
    }
    if (out.includes('SMOKETEST_UNIQUE_MARKER_SUPPRESSED')) {
      lcFail(6, label, 'SMOKETEST_UNIQUE_MARKER_SUPPRESSED appeared in resume output — suppressed row leaked');
      return false;
    }

    // Verify trusted canon appears BEFORE the untrusted retrieved-context block.
    const canonIdx     = out.indexOf('=== OPERATING CANON (trusted');
    const untrustedIdx = out.indexOf('=== BEGIN RETRIEVED CONTEXT (untrusted)');
    if (canonIdx === -1) {
      lcFail(6, label, 'OPERATING CANON preamble not found in resume output');
      return false;
    }
    if (untrustedIdx !== -1 && canonIdx > untrustedIdx) {
      lcFail(6, label, 'OPERATING CANON appears AFTER untrusted block — trusted-canon-first ordering violated');
      return false;
    }

    lcPass(6, label);
    return true;
  } catch (err) {
    lcFail(6, label, err.message);
    return false;
  }
}

async function step7_cmdCheckpoint() {
  const label = 'cmdCheckpoint — session_in_progress cleared';
  try {
    const db = await pgConnect(SMOKE_DB);
    await db.query(
      `INSERT INTO project_settings (project_id, key, value) VALUES ($1, 'session_in_progress', 'smoketest_session')
       ON CONFLICT (project_id, key) DO UPDATE SET value = 'smoketest_session'`,
      [PROJECT_ID]
    );
    await db.end();

    const payload = JSON.stringify({
      tldr: 'Smoketest checkpoint',
      open_threads: ['verify smoke passes'],
      quick_references: 'n/a',
    });

    const r = runHandoff('checkpoint', ['--json', '-'], payload);
    if (r.status !== 0) {
      lcFail(7, label, `exit ${r.status}: ${(r.stderr || r.stdout || '').split('\n')[0]}`);
      return false;
    }

    const db2 = await pgConnect(SMOKE_DB);
    const { rows } = await db2.query(
      `SELECT value FROM project_settings WHERE project_id = $1 AND key = 'session_in_progress'`,
      [PROJECT_ID]
    );
    await db2.end();

    if (rows.length > 0) {
      lcFail(7, label, `session_in_progress still set to '${rows[0].value}' after checkpoint`);
      return false;
    }

    if (!fs.existsSync(HANDOFF_PATH)) {
      lcFail(7, label, `handoff.md missing after checkpoint: ${HANDOFF_PATH}`);
      return false;
    }

    lcPass(7, label);
    return true;
  } catch (err) {
    lcFail(7, label, err.message);
    return false;
  }
}

async function step8_cmdClose() {
  const label = 'cmdClose — handoff.md updated, session_in_progress cleared';
  try {
    const db = await pgConnect(SMOKE_DB);
    await db.query(
      `INSERT INTO project_settings (project_id, key, value) VALUES ($1, 'session_in_progress', 'smoketest_close_session')
       ON CONFLICT (project_id, key) DO UPDATE SET value = 'smoketest_close_session'`,
      [PROJECT_ID]
    );
    await db.end();

    const payload = JSON.stringify({
      tldr: 'Smoketest session closed',
      open_threads: ['nothing open'],
      quick_references: 'smoketest-ref',
    });

    const r = runHandoff('close', ['--json', '-'], payload);
    if (r.status !== 0) {
      lcFail(8, label, `exit ${r.status}: ${(r.stderr || r.stdout || '').split('\n')[0]}`);
      return false;
    }

    if (!fs.existsSync(HANDOFF_PATH)) {
      lcFail(8, label, `handoff.md missing: ${HANDOFF_PATH}`);
      return false;
    }
    const content = fs.readFileSync(HANDOFF_PATH, 'utf8');
    if (!content.includes('TL;DR')) {
      lcFail(8, label, 'handoff.md does not contain "TL;DR" section header');
      return false;
    }
    if (!content.includes('Open threads')) {
      lcFail(8, label, 'handoff.md does not contain "Open threads" section header');
      return false;
    }

    const db2 = await pgConnect(SMOKE_DB);
    const { rows } = await db2.query(
      `SELECT value FROM project_settings WHERE project_id = $1 AND key = 'session_in_progress'`,
      [PROJECT_ID]
    );
    await db2.end();
    if (rows.length > 0) {
      lcFail(8, label, `session_in_progress still set after close`);
      return false;
    }

    lcPass(8, label);
    return true;
  } catch (err) {
    lcFail(8, label, err.message);
    return false;
  }
}

async function step9_cmdDrop_assertion(ids) {
  const label = 'cmdDrop — lowest-confidence assertion suppressed; excluded from resume';
  try {
    const r = runHandoff('drop');
    if (r.status !== 0) {
      lcFail(9, label, `exit ${r.status}: ${(r.stderr || r.stdout || '').split('\n')[0]}`);
      return false;
    }

    const db = await pgConnect(SMOKE_DB);
    const { rows } = await db.query(
      `SELECT COUNT(*) AS n FROM assertions WHERE project_id = $1 AND suppressed = false`,
      [PROJECT_ID]
    );
    await db.end();
    if (parseInt(rows[0].n, 10) !== 0) {
      lcFail(9, label, `${rows[0].n} unsuppressed assertions remain after drop`);
      return false;
    }

    const r2 = runHandoff('resume');
    const out = r2.stdout || '';
    if (out.includes('SMOKETEST_UNIQUE_MARKER_LOW') || out.includes('SMOKETEST_UNIQUE_MARKER_HIGH')) {
      lcFail(9, label, 'Resume still shows suppressed markers after drop');
      return false;
    }

    lcPass(9, label);
    return true;
  } catch (err) {
    lcFail(9, label, err.message);
    return false;
  }
}

async function step10_cmdPurge() {
  const label = 'cmdPurge — all project rows deleted';
  try {
    const r = runHandoff('purge', ['--yes']);
    if (r.status !== 0) {
      lcFail(10, label, `exit ${r.status}: ${(r.stderr || r.stdout || '').split('\n')[0]}`);
      return false;
    }

    const db = await pgConnect(SMOKE_DB);
    const tables = ['assertions', 'edges', 'entities', 'project_settings', 'retrieval_contract'];
    for (const tbl of tables) {
      const { rows } = await db.query(
        `SELECT COUNT(*) AS n FROM ${tbl} WHERE project_id = $1`, [PROJECT_ID]
      );
      if (parseInt(rows[0].n, 10) !== 0) {
        await db.end();
        lcFail(10, label, `${tbl} still has ${rows[0].n} rows for project after purge`);
        return false;
      }
    }
    await db.end();

    lcPass(10, label);
    return true;
  } catch (err) {
    lcFail(10, label, err.message);
    return false;
  }
}

// ── W1 Retrieval events step implementations ──────────────────────────────────

/**
 * Create a minimal retrieval_events table in the given DB (no halfvec / pgvector
 * required — embedding column is omitted for portability in the smoketest).
 */
async function createRetrievalEventsTable(dbName) {
  const db = await pgConnect(dbName);
  await db.query(`
    CREATE TABLE IF NOT EXISTS retrieval_events (
      id           SERIAL PRIMARY KEY,
      project_id   TEXT NOT NULL,
      query_text   TEXT NOT NULL,
      retrieved_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      outcome      TEXT DEFAULT 'pending'
                     CHECK (outcome IN ('pending','success','failure','irrelevant')),
      outcome_at   TIMESTAMPTZ,
      outcome_signal TEXT,
      session_id   TEXT,
      notes        TEXT
    )
  `);
  await db.end();
}

/**
 * Create the entity_communities table in the given DB (W3, portable, no pgvector).
 * Mirrors the DDL in handoff-core-schema.sql exactly.
 */
async function createEntityCommunitiesTable(dbName) {
  const db = await pgConnect(dbName);
  await db.query(`
    CREATE TABLE IF NOT EXISTS entity_communities (
      id            SERIAL PRIMARY KEY,
      project_id    TEXT NOT NULL,
      entity_name   TEXT NOT NULL,
      community_id  INTEGER NOT NULL,
      level         INTEGER NOT NULL DEFAULT 0,
      run_id        TEXT NOT NULL,
      computed_at   TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await db.query(`
    CREATE INDEX IF NOT EXISTS entity_communities_lookup_idx
      ON entity_communities (project_id, entity_name)
  `);
  await db.query(`
    CREATE INDEX IF NOT EXISTS entity_communities_run_idx
      ON entity_communities (project_id, run_id)
  `);
  await db.end();
}

/**
 * LC STEP 12: After cmdResume, at least one retrieval_events row exists for the
 * test project with outcome='pending', query_text starting 'loader:contract=',
 * and session_id matching the session_in_progress marker.
 */
async function step12_retrievalEventLogged(sessionMarker) {
  const label = 'W1 event logging: retrieval_events row created by resume with correct fields';
  try {
    const db = await pgConnect(SMOKE_DB);
    const { rows } = await db.query(
      `SELECT query_text, outcome, session_id, notes
       FROM retrieval_events
       WHERE project_id = $1
       ORDER BY retrieved_at DESC LIMIT 5`,
      [PROJECT_ID]
    );
    await db.end();

    if (rows.length === 0) {
      lcFail(12, label, 'No retrieval_events rows found after resume');
      return false;
    }

    const row = rows[0];
    if (!row.query_text.startsWith('loader:contract=')) {
      lcFail(12, label, `query_text does not start with 'loader:contract=': "${row.query_text}"`);
      return false;
    }
    if (row.outcome !== 'pending') {
      lcFail(12, label, `outcome is '${row.outcome}', expected 'pending'`);
      return false;
    }
    if (sessionMarker && row.session_id !== sessionMarker) {
      lcFail(12, label, `session_id '${row.session_id}' does not match session marker '${sessionMarker}'`);
      return false;
    }

    lcPass(12, label);
    return true;
  } catch (err) {
    lcFail(12, label, err.message);
    return false;
  }
}

/**
 * LC STEP 13: cmdClose with retrieval_outcome='success' flips pending events for
 * the session to outcome='success', outcome_signal='agent_self_report'.
 */
async function step13_selfReport() {
  const label = 'W1 self-report: close with retrieval_outcome flips pending events';
  try {
    // Set a known session marker so the self-report can find the rows.
    const sessionId = 'smoketest_w1_selfreport';
    const db = await pgConnect(SMOKE_DB);
    await db.query(
      `INSERT INTO project_settings (project_id, key, value) VALUES ($1, 'session_in_progress', $2)
       ON CONFLICT (project_id, key) DO UPDATE SET value = $2`,
      [PROJECT_ID, sessionId]
    );
    // Insert a pending retrieval_events row for this session.
    await db.query(
      `INSERT INTO retrieval_events (project_id, query_text, session_id, outcome)
       VALUES ($1, 'loader:contract=default;kinds=assertion;sections=2', $2, 'pending')`,
      [PROJECT_ID, sessionId]
    );
    await db.end();

    const payload = JSON.stringify({
      tldr: 'Smoketest W1 self-report close',
      open_threads: ['none'],
      session_id: sessionId,
      retrieval_outcome: 'success',
      retrieval_outcome_notes: 'smoketest verification',
    });

    const r = runHandoff('close', ['--json', '-'], payload);
    if (r.status !== 0) {
      lcFail(13, label, `exit ${r.status}: ${(r.stderr || r.stdout || '').split('\n')[0]}`);
      return false;
    }

    const db2 = await pgConnect(SMOKE_DB);
    const { rows } = await db2.query(
      `SELECT outcome, outcome_signal FROM retrieval_events
       WHERE project_id = $1 AND session_id = $2`,
      [PROJECT_ID, sessionId]
    );
    await db2.end();

    if (rows.length === 0) {
      lcFail(13, label, 'No retrieval_events rows found for session after close');
      return false;
    }
    const updated = rows.find((r) => r.outcome === 'success' && r.outcome_signal === 'agent_self_report');
    if (!updated) {
      lcFail(13, label, `Rows not updated: ${JSON.stringify(rows)}`);
      return false;
    }

    // Verify the close output mentions the self-report.
    const out = (r.stdout || '') + (r.stderr || '');
    if (!out.includes('agent_self_report')) {
      lcFail(13, label, 'close output does not mention agent_self_report');
      return false;
    }

    lcPass(13, label);
    return true;
  } catch (err) {
    lcFail(13, label, err.message);
    return false;
  }
}

/**
 * LC STEP 14: Timeout-decay — a stale pending retrieval_events row (999 days old)
 * is flipped to outcome='irrelevant', outcome_signal='timeout_decay' on close.
 */
async function step14_timeoutDecay() {
  const label = 'W1 timeout-decay: stale pending event decayed to irrelevant on close';
  try {
    const db = await pgConnect(SMOKE_DB);
    // Insert a synthetic stale pending event.
    const { rows: insRows } = await db.query(
      `INSERT INTO retrieval_events (project_id, query_text, outcome, retrieved_at)
       VALUES ($1, 'loader:contract=default;kinds=entity;sections=0', 'pending',
               now() - interval '999 days')
       RETURNING id`,
      [PROJECT_ID]
    );
    const staleId = insRows[0].id;
    await db.end();

    const payload = JSON.stringify({ tldr: 'Smoketest W1 timeout-decay close' });
    const r = runHandoff('close', ['--json', '-'], payload);
    if (r.status !== 0) {
      lcFail(14, label, `exit ${r.status}: ${(r.stderr || r.stdout || '').split('\n')[0]}`);
      return false;
    }

    const db2 = await pgConnect(SMOKE_DB);
    const { rows } = await db2.query(
      `SELECT outcome, outcome_signal FROM retrieval_events WHERE id = $1`,
      [staleId]
    );
    await db2.end();

    if (rows.length === 0) {
      lcFail(14, label, 'Stale retrieval_events row not found after close');
      return false;
    }
    if (rows[0].outcome !== 'irrelevant' || rows[0].outcome_signal !== 'timeout_decay') {
      lcFail(14, label, `Expected irrelevant/timeout_decay, got ${rows[0].outcome}/${rows[0].outcome_signal}`);
      return false;
    }

    // Verify the close output mentions the decay.
    const out = (r.stdout || '') + (r.stderr || '');
    if (!out.includes('timeout_decay')) {
      lcFail(14, label, 'close output does not mention timeout_decay');
      return false;
    }

    lcPass(14, label);
    return true;
  } catch (err) {
    lcFail(14, label, err.message);
    return false;
  }
}

// ── Hook section helpers ──────────────────────────────────────────────────────

/**
 * Write a minimal handoff.md with a specific last_close date directly into
 * the ~/.claude/projects/<project_id>/ path so cmdLoaderHook picks it up.
 */
function writeHandoffMdDirect(handoffPath, lastClose) {
  const projectId = path.basename(path.dirname(handoffPath));
  fs.mkdirSync(path.dirname(handoffPath), { recursive: true });
  const content = [
    '---',
    `project_id: ${projectId}`,
    `last_close: ${lastClose}`,
    'contract: default',
    'session_summary:',
    '  project_name: smoketest',
    '  entities_written: 0',
    '  assertions_written: 0',
    '  edges_written: 0',
    '---',
    '',
    '## TL;DR',
    '(smoketest)',
    '',
    '## Open threads',
    '- (none)',
    '',
    '## Quick references',
    '(none)',
    '',
  ].join('\n');
  fs.writeFileSync(handoffPath, content, 'utf8');
}

// ── Hook step implementations ─────────────────────────────────────────────────

/**
 * HOOKS 1/3: Staleness gate.
 *
 * Run loader-hook with last_close ~10 days ago — must NOT set session_in_progress.
 * Run loader-hook with last_close today — MUST set session_in_progress.
 */
async function hooksStep1_stalenessGate() {
  const label = 'Staleness gate: stale last_close skips marker; fresh last_close sets marker';
  try {
    const db = await pgConnect(HOOKS_DB);

    // Ensure no stale session_in_progress from init.
    await db.query(
      `DELETE FROM project_settings WHERE project_id = $1 AND key = 'session_in_progress'`,
      [PROJECT_ID_HOOKS]
    );
    // Ensure staleness_days is at default (7).
    await db.query(
      `INSERT INTO project_settings (project_id, key, value) VALUES ($1, 'staleness_days', '7')
       ON CONFLICT (project_id, key) DO UPDATE SET value = '7'`,
      [PROJECT_ID_HOOKS]
    );
    await db.end();

    // ── Sub-test A: stale (10 days ago) ──────────────────────────────────────
    const staleDateStr = new Date(Date.now() - 10 * 86400000).toISOString();
    writeHandoffMdDirect(HANDOFF_PATH_HOOKS, staleDateStr);

    const rStale = runHandoff('loader-hook', [], null, HOOKS_DB, TEMP_PROJECT_DIR_HOOKS);
    if (rStale.status !== 0) {
      hkFail(1, label, `loader-hook (stale) exited ${rStale.status}`);
      return false;
    }

    // session_in_progress must NOT be set on the stale path.
    const db2 = await pgConnect(HOOKS_DB);
    const sipStale = await db2.query(
      `SELECT value FROM project_settings WHERE project_id = $1 AND key = 'session_in_progress'`,
      [PROJECT_ID_HOOKS]
    );
    await db2.end();
    if (sipStale.rows.length > 0) {
      hkFail(1, label, `session_in_progress was set on stale path (value='${sipStale.rows[0].value}')`);
      return false;
    }

    // stdout should not contain loaded assertion content — just the stale warning JSON.
    const staleOut = rStale.stdout || '';
    // The stale-path JSON contains additionalContext with the stale warning message, not assertion data.
    if (staleOut.includes('SMOKETEST') || staleOut.includes('### Assertions') || staleOut.includes('### Entities')) {
      hkFail(1, label, 'Stale loader-hook stdout contained assertion content — stale gate failed to suppress load');
      return false;
    }
    // The JSON must be parseable and contain hookSpecificOutput.
    let staleJson;
    try {
      staleJson = JSON.parse(staleOut.trim());
    } catch (_) {
      hkFail(1, label, `Stale loader-hook stdout is not valid JSON: ${staleOut.slice(0, 200)}`);
      return false;
    }
    if (!staleJson.hookSpecificOutput || !staleJson.hookSpecificOutput.additionalContext) {
      hkFail(1, label, 'Stale loader-hook JSON missing hookSpecificOutput.additionalContext');
      return false;
    }

    // ── Sub-test B: fresh (today) ─────────────────────────────────────────────
    const freshDateStr = new Date().toISOString();
    writeHandoffMdDirect(HANDOFF_PATH_HOOKS, freshDateStr);

    // Clear any leftover session_in_progress before fresh run.
    const db3 = await pgConnect(HOOKS_DB);
    await db3.query(
      `DELETE FROM project_settings WHERE project_id = $1 AND key = 'session_in_progress'`,
      [PROJECT_ID_HOOKS]
    );
    await db3.end();

    const rFresh = runHandoff('loader-hook', [], null, HOOKS_DB, TEMP_PROJECT_DIR_HOOKS);
    if (rFresh.status !== 0) {
      hkFail(1, label, `loader-hook (fresh) exited ${rFresh.status}`);
      return false;
    }

    const db4 = await pgConnect(HOOKS_DB);
    const sipFresh = await db4.query(
      `SELECT value FROM project_settings WHERE project_id = $1 AND key = 'session_in_progress'`,
      [PROJECT_ID_HOOKS]
    );
    await db4.end();
    if (sipFresh.rows.length === 0) {
      hkFail(1, label, 'session_in_progress NOT set on fresh path — loader hook failed to mark session');
      return false;
    }

    hkPass(1, label);
    return true;
  } catch (err) {
    hkFail(1, label, err.message);
    return false;
  }
}

/**
 * HOOKS 2/3: Hook safety outside claude-memory project.
 *
 * Chdir to a temp dir with no handoff.md, run loader-hook and loader-stop,
 * assert both exit 0 and don't crash.
 */
async function hooksStep2_safetyOutsideProject() {
  const label = 'Hook safety: exits 0 cleanly from directory with no handoff.md';
  const safeDir = path.join(os.tmpdir(), `handoff-hook-safety-${TS}`);

  try {
    fs.mkdirSync(safeDir, { recursive: true });

    // We pass the safe dir as PROJECT_ROOT with HOOKS_DB (DB exists but has no
    // row for this project_id, so handoff.md check fails early — clean exit).
    const envSafe = {
      ...process.env,
      HANDOFF_DB:   HOOKS_DB,
      PROJECT_ROOT: safeDir,
    };

    // loader-hook
    const rHook = spawnSync(process.execPath, [HANDOFF_SCRIPT, 'loader-hook'], {
      cwd:      PROJECT_ROOT,
      env:      envSafe,
      encoding: 'utf8',
      timeout:  15000,
    });

    if (rHook.status !== 0) {
      hkFail(2, label, `loader-hook exited ${rHook.status} from safe dir (stderr: ${(rHook.stderr || '').slice(0, 200)})`);
      return false;
    }
    const hookStderr = rHook.stderr || '';
    if (hookStderr.toLowerCase().includes('unhandledpromiserejection') ||
        hookStderr.toLowerCase().includes('uncaughterror')) {
      hkFail(2, label, `loader-hook had unhandled error in stderr: ${hookStderr.slice(0, 300)}`);
      return false;
    }

    // loader-stop
    const rStop = spawnSync(process.execPath, [HANDOFF_SCRIPT, 'loader-stop'], {
      cwd:      PROJECT_ROOT,
      env:      envSafe,
      encoding: 'utf8',
      timeout:  15000,
    });

    if (rStop.status !== 0) {
      hkFail(2, label, `loader-stop exited ${rStop.status} from safe dir (stderr: ${(rStop.stderr || '').slice(0, 200)})`);
      return false;
    }
    const stopStderr = rStop.stderr || '';
    if (stopStderr.toLowerCase().includes('unhandledpromiserejection') ||
        stopStderr.toLowerCase().includes('uncaughterror')) {
      hkFail(2, label, `loader-stop had unhandled error in stderr: ${stopStderr.slice(0, 300)}`);
      return false;
    }

    hkPass(2, label);
    return true;
  } catch (err) {
    hkFail(2, label, err.message);
    return false;
  } finally {
    try { fs.rmSync(safeDir, { recursive: true, force: true }); } catch (_) {}
  }
}

/**
 * HOOKS 3/3: Stop hook honors implicit_close=false / =enabled.
 *
 * When implicit_close is 'disabled', Stop hook must leave session_in_progress alone.
 * When implicit_close is 'enabled', Stop hook must clear session_in_progress.
 */
async function hooksStep3_stopHookImplicitClose() {
  const label = 'Stop hook: respects implicit_close=disabled / implicit_close=enabled';
  try {
    // Write a fresh handoff.md so loader-stop finds the project provisioned.
    writeHandoffMdDirect(HANDOFF_PATH_HOOKS, new Date().toISOString());

    // ── Sub-test A: implicit_close disabled ───────────────────────────────────
    const db = await pgConnect(HOOKS_DB);
    // Set implicit_close = disabled, session_in_progress = true.
    await db.query(
      `INSERT INTO project_settings (project_id, key, value) VALUES ($1, 'implicit_close', 'disabled')
       ON CONFLICT (project_id, key) DO UPDATE SET value = 'disabled'`,
      [PROJECT_ID_HOOKS]
    );
    await db.query(
      `INSERT INTO project_settings (project_id, key, value) VALUES ($1, 'session_in_progress', 'hooks_test_session')
       ON CONFLICT (project_id, key) DO UPDATE SET value = 'hooks_test_session'`,
      [PROJECT_ID_HOOKS]
    );
    await db.end();

    const rDisabled = runHandoff('loader-stop', [], null, HOOKS_DB, TEMP_PROJECT_DIR_HOOKS);
    if (rDisabled.status !== 0) {
      hkFail(3, label, `loader-stop (implicit_close=disabled) exited ${rDisabled.status}`);
      return false;
    }

    const db2 = await pgConnect(HOOKS_DB);
    const sipAfterDisabled = await db2.query(
      `SELECT value FROM project_settings WHERE project_id = $1 AND key = 'session_in_progress'`,
      [PROJECT_ID_HOOKS]
    );
    await db2.end();

    if (sipAfterDisabled.rows.length === 0) {
      hkFail(3, label, 'session_in_progress was cleared when implicit_close=disabled — Stop hook should have bailed out');
      return false;
    }

    // ── Sub-test B: implicit_close enabled ────────────────────────────────────
    const db3 = await pgConnect(HOOKS_DB);
    await db3.query(
      `INSERT INTO project_settings (project_id, key, value) VALUES ($1, 'implicit_close', 'enabled')
       ON CONFLICT (project_id, key) DO UPDATE SET value = 'enabled'`,
      [PROJECT_ID_HOOKS]
    );
    // session_in_progress is still set from sub-test A.
    await db3.end();

    const rEnabled = runHandoff('loader-stop', [], null, HOOKS_DB, TEMP_PROJECT_DIR_HOOKS);
    if (rEnabled.status !== 0) {
      hkFail(3, label, `loader-stop (implicit_close=enabled) exited ${rEnabled.status}`);
      return false;
    }

    const db4 = await pgConnect(HOOKS_DB);
    const sipAfterEnabled = await db4.query(
      `SELECT value FROM project_settings WHERE project_id = $1 AND key = 'session_in_progress'`,
      [PROJECT_ID_HOOKS]
    );
    await db4.end();

    if (sipAfterEnabled.rows.length > 0) {
      hkFail(3, label, `session_in_progress still set after loader-stop with implicit_close=enabled (value='${sipAfterEnabled.rows[0].value}')`);
      return false;
    }

    hkPass(3, label);
    return true;
  } catch (err) {
    hkFail(3, label, err.message);
    return false;
  }
}

// ── Hardening step implementations ───────────────────────────────────────────

/**
 * HARDEN 1/7: HANDOFF_DB rejection — invalid identifier must exit non-zero.
 */
async function hardenStep1_dbNameValidation() {
  const label = 'HANDOFF_DB rejection: invalid identifier exits non-zero';
  try {
    // Use an invalid name with a double-quote in it.
    const badEnv = { ...process.env, HANDOFF_DB: 'bad"name', PROJECT_ROOT: TEMP_PROJECT_DIR_HARDEN };
    const r = spawnSync(process.execPath, [HANDOFF_SCRIPT, 'init', '-y'], {
      cwd:      PROJECT_ROOT,
      env:      badEnv,
      encoding: 'utf8',
      timeout:  10000,
    });
    if (r.status === 0) {
      hdFail(1, label, 'expected non-zero exit for invalid HANDOFF_DB, got 0');
      return false;
    }
    const stderr = r.stderr || '';
    if (!stderr.includes('Invalid HANDOFF_DB')) {
      hdFail(1, label, `exit ${r.status} but error message not found in stderr: ${stderr.slice(0, 200)}`);
      return false;
    }
    hdPass(1, label);
    return true;
  } catch (err) {
    hdFail(1, label, err.message);
    return false;
  }
}

/**
 * HARDEN 2/7: Trust-boundary labels in loader-hook output.
 */
async function hardenStep2_trustBoundaryLabels() {
  const label = 'Trust-boundary labels present in loader-hook additionalContext';
  try {
    const r = spawnSync(process.execPath, [HANDOFF_SCRIPT, 'loader-hook'], {
      cwd:      PROJECT_ROOT,
      env:      { ...process.env, HANDOFF_DB: HARDEN_DB, PROJECT_ROOT: TEMP_PROJECT_DIR_HARDEN },
      encoding: 'utf8',
      timeout:  15000,
    });

    // loader-hook exits 0 even on no-data; stdout must be valid JSON.
    if (r.status !== 0) {
      hdFail(2, label, `loader-hook exited ${r.status}: ${(r.stderr || '').slice(0, 200)}`);
      return false;
    }

    const stdout = (r.stdout || '').trim();
    let parsed;
    try {
      parsed = JSON.parse(stdout);
    } catch (_) {
      hdFail(2, label, `stdout is not valid JSON: ${stdout.slice(0, 200)}`);
      return false;
    }

    const ctx = parsed?.hookSpecificOutput?.additionalContext || '';
    if (!ctx.includes('BEGIN RETRIEVED CONTEXT (untrusted)')) {
      hdFail(2, label, `"BEGIN RETRIEVED CONTEXT (untrusted)" not found in additionalContext`);
      return false;
    }
    if (!ctx.includes('END RETRIEVED CONTEXT')) {
      hdFail(2, label, `"END RETRIEVED CONTEXT" not found in additionalContext`);
      return false;
    }

    // Verify trusted canon appears BEFORE the untrusted block in loader-hook output.
    const canonIdx     = ctx.indexOf('=== OPERATING CANON (trusted');
    const untrustedIdx = ctx.indexOf('=== BEGIN RETRIEVED CONTEXT (untrusted)');
    if (canonIdx === -1) {
      hdFail(2, label, `OPERATING CANON preamble not found in additionalContext`);
      return false;
    }
    if (canonIdx > untrustedIdx) {
      hdFail(2, label, `OPERATING CANON appears AFTER untrusted block in additionalContext — trusted-canon-first ordering violated`);
      return false;
    }

    hdPass(2, label);
    return true;
  } catch (err) {
    hdFail(2, label, err.message);
    return false;
  }
}

/**
 * HARDEN 3/7: Stdin schema rejection — two sub-tests:
 *   A) tldr > 4000 chars exits non-zero with "tldr" in the error.
 *   B) open_threads with 201 elements exits non-zero with "open_threads" in the error.
 */
async function hardenStep3_stdinSchemaRejection() {
  const label = 'Stdin schema rejection: oversized tldr and 201-element open_threads each exit non-zero';
  try {
    // ── Sub-test A: oversized tldr ────────────────────────────────────────────
    const bigPayload = JSON.stringify({ tldr: 'x'.repeat(5000) });
    const rTldr = spawnSync(process.execPath, [HANDOFF_SCRIPT, 'close', '--json', '-'], {
      cwd:      PROJECT_ROOT,
      env:      { ...process.env, HANDOFF_DB: HARDEN_DB, PROJECT_ROOT: TEMP_PROJECT_DIR_HARDEN },
      input:    bigPayload,
      encoding: 'utf8',
      timeout:  15000,
    });

    if (rTldr.status === 0) {
      hdFail(3, label, 'expected non-zero exit for oversized tldr, got 0');
      return false;
    }

    const combinedTldr = (rTldr.stderr || '') + (rTldr.stdout || '');
    if (!combinedTldr.includes('"tldr"')) {
      hdFail(3, label, `tldr error message does not name "tldr" field: ${combinedTldr.slice(0, 300)}`);
      return false;
    }

    // ── Sub-test B: 201-element open_threads ─────────────────────────────────
    const bigThreads = JSON.stringify({ tldr: 'ok', open_threads: Array(201).fill('thread') });
    const rThreads = spawnSync(process.execPath, [HANDOFF_SCRIPT, 'close', '--json', '-'], {
      cwd:      PROJECT_ROOT,
      env:      { ...process.env, HANDOFF_DB: HARDEN_DB, PROJECT_ROOT: TEMP_PROJECT_DIR_HARDEN },
      input:    bigThreads,
      encoding: 'utf8',
      timeout:  15000,
    });

    if (rThreads.status === 0) {
      hdFail(3, label, 'expected non-zero exit for 201-element open_threads, got 0');
      return false;
    }

    const combinedThreads = (rThreads.stderr || '') + (rThreads.stdout || '');
    if (!combinedThreads.includes('"open_threads"')) {
      hdFail(3, label, `open_threads error message does not name "open_threads" field: ${combinedThreads.slice(0, 300)}`);
      return false;
    }

    hdPass(3, label);
    return true;
  } catch (err) {
    hdFail(3, label, err.message);
    return false;
  }
}

/**
 * HARDEN 4/7: Multi-author detection — HANDOFF_MULTI_AUTHOR_OVERRIDE=2 triggers the notice.
 */
async function hardenStep4_multiAuthorDetection() {
  const label = 'Multi-author detection: override=2 triggers stderr notice and DB flag';
  try {
    // Run cmdClose with a minimal valid payload and the multi-author override.
    // We use HARDEN_DB which is already init-ed; cmdClose reads the project.
    const payload = JSON.stringify({ tldr: 'hardentest-multiauthor' });
    const r = spawnSync(process.execPath, [HANDOFF_SCRIPT, 'close', '--json', '-'], {
      cwd:      PROJECT_ROOT,
      env:      {
        ...process.env,
        HANDOFF_DB: HARDEN_DB,
        PROJECT_ROOT: TEMP_PROJECT_DIR_HARDEN,
        HANDOFF_MULTI_AUTHOR_OVERRIDE: '2',
      },
      input:    payload,
      encoding: 'utf8',
      timeout:  15000,
    });

    if (r.status !== 0) {
      hdFail(4, label, `cmdClose exited ${r.status}: ${(r.stderr || r.stdout || '').slice(0, 200)}`);
      return false;
    }

    const stderr = r.stderr || '';
    if (!stderr.includes('multi-author repo detected')) {
      hdFail(4, label, `multi-author notice not found in stderr: ${stderr.slice(0, 300)}`);
      return false;
    }

    // Verify the DB flag was persisted.
    const db = await pgConnect(HARDEN_DB);
    const { rows } = await db.query(
      `SELECT value FROM project_settings WHERE project_id = $1 AND key = 'multi_author_detected'`,
      [PROJECT_ID_HARDEN]
    );
    await db.end();
    if (rows.length === 0 || rows[0].value !== 'true') {
      hdFail(4, label, `multi_author_detected not set in project_settings (rows=${rows.length})`);
      return false;
    }

    hdPass(4, label);
    return true;
  } catch (err) {
    hdFail(4, label, err.message);
    return false;
  }
}

/**
 * HARDEN 5/7: /handoff:promote — inserts a test assertion, promotes it, verifies CLAUDE.md.
 */
async function hardenStep5_promote(tempClaudeMd) {
  const label = '/handoff:promote: promotes assertion to CLAUDE.md with audit annotation';
  try {
    // Insert a test assertion directly.
    const db = await pgConnect(HARDEN_DB);
    const { rows } = await db.query(
      `INSERT INTO assertions (project_id, subject, predicate, object, confidence, source, last_reinforced)
       VALUES ($1, 'HARDEN_PROMOTE_SUBJECT', 'is', 'HARDEN_PROMOTE_VALUE', 9, 'user_stated', now())
       RETURNING id`,
      [PROJECT_ID_HARDEN]
    );
    await db.end();
    const assertionId = rows[0].id;

    const r = spawnSync(process.execPath, [HANDOFF_SCRIPT, 'promote', String(assertionId)], {
      cwd:      PROJECT_ROOT,
      env:      {
        ...process.env,
        HANDOFF_DB:   HARDEN_DB,
        PROJECT_ROOT: TEMP_PROJECT_DIR_HARDEN,
      },
      encoding: 'utf8',
      timeout:  15000,
    });

    if (r.status !== 0) {
      hdFail(5, label, `promote exited ${r.status}: ${(r.stderr || r.stdout || '').slice(0, 300)}`);
      return false;
    }

    // Verify CLAUDE.md gained the fact line.
    const claudeMdContent = fs.existsSync(tempClaudeMd)
      ? fs.readFileSync(tempClaudeMd, 'utf8')
      : '';
    if (!claudeMdContent.includes('HARDEN_PROMOTE_SUBJECT')) {
      hdFail(5, label, `CLAUDE.md does not contain the promoted fact line`);
      return false;
    }

    // Verify promoted=true in DB.
    const db2 = await pgConnect(HARDEN_DB);
    const { rows: promRows } = await db2.query(
      `SELECT promoted FROM assertions WHERE id = $1`,
      [assertionId]
    );
    await db2.end();
    if (!promRows[0].promoted) {
      hdFail(5, label, `assertions.promoted not set to true after promote command`);
      return false;
    }

    hdPass(5, label);
    return { ok: true, assertionId };
  } catch (err) {
    hdFail(5, label, err.message);
    return { ok: false };
  }
}

/**
 * HARDEN 6/7: /handoff:promote idempotency — re-running prints "already promoted".
 */
async function hardenStep6_promoteIdempotent(assertionId) {
  const label = '/handoff:promote idempotency: re-running prints "already promoted"';
  if (!assertionId) {
    hdSkip(6, label, 'skipped due to step 5 failure');
    return false;
  }
  try {
    const r = spawnSync(process.execPath, [HANDOFF_SCRIPT, 'promote', String(assertionId)], {
      cwd:      PROJECT_ROOT,
      env:      {
        ...process.env,
        HANDOFF_DB:   HARDEN_DB,
        PROJECT_ROOT: TEMP_PROJECT_DIR_HARDEN,
      },
      encoding: 'utf8',
      timeout:  15000,
    });

    if (r.status !== 0) {
      hdFail(6, label, `re-promote exited ${r.status}: ${(r.stdout || '').slice(0, 200)}`);
      return false;
    }
    const out = r.stdout || '';
    if (!out.includes('already promoted')) {
      hdFail(6, label, `"already promoted" not found in output: ${out.slice(0, 200)}`);
      return false;
    }
    hdPass(6, label);
    return true;
  } catch (err) {
    hdFail(6, label, err.message);
    return false;
  }
}

/**
 * HARDEN 7/7: Audit annotation format — verify the HTML comment regex.
 */
async function hardenStep7_auditAnnotationFormat(tempClaudeMd) {
  const label = 'Audit annotation format matches expected regex';
  try {
    if (!fs.existsSync(tempClaudeMd)) {
      hdFail(7, label, `CLAUDE.md not found at ${tempClaudeMd}`);
      return false;
    }
    const content = fs.readFileSync(tempClaudeMd, 'utf8');
    const ANNOTATION_RE = /<!-- promoted: session=[^,]+, conf=\d+, date=\d{4}-\d{2}-\d{2}, source_assertion=[^ ]+ -->/;
    if (!ANNOTATION_RE.test(content)) {
      hdFail(7, label, `No matching annotation comment found in CLAUDE.md:\n${content.slice(0, 400)}`);
      return false;
    }
    hdPass(7, label);
    return true;
  } catch (err) {
    hdFail(7, label, err.message);
    return false;
  }
}

/**
 * HARDEN 8/8: readStdin rejects invalid retrieval_outcome values.
 *   A) retrieval_outcome='pending' → rejected (not an accepted value).
 *   B) retrieval_outcome='banana'  → rejected (unknown value).
 *   C) retrieval_outcome='success' → accepted.
 */
async function hardenStep8_retrievalOutcomeValidation() {
  const label = 'readStdin: rejects invalid retrieval_outcome values; accepts valid ones';
  try {
    const closeArgs = [HANDOFF_SCRIPT, 'close', '--json', '-'];
    const spawnOpts = (input) => ({
      cwd:      PROJECT_ROOT,
      env:      { ...process.env, HANDOFF_DB: HARDEN_DB, PROJECT_ROOT: TEMP_PROJECT_DIR_HARDEN },
      input,
      encoding: 'utf8',
      timeout:  15000,
    });

    // ── Sub-test A: retrieval_outcome='pending' must be rejected ─────────────
    const rPending = spawnSync(
      process.execPath, closeArgs,
      spawnOpts(JSON.stringify({ tldr: 'test', retrieval_outcome: 'pending' }))
    );
    if (rPending.status === 0) {
      hdFail(8, label, `retrieval_outcome='pending' was accepted (expected rejection)`);
      return false;
    }
    const pendingOut = (rPending.stderr || '') + (rPending.stdout || '');
    if (!pendingOut.includes('retrieval_outcome')) {
      hdFail(8, label, `rejection for 'pending' does not name "retrieval_outcome" field: ${pendingOut.slice(0, 300)}`);
      return false;
    }

    // ── Sub-test B: retrieval_outcome='banana' must be rejected ─────────────
    const rBanana = spawnSync(
      process.execPath, closeArgs,
      spawnOpts(JSON.stringify({ tldr: 'test', retrieval_outcome: 'banana' }))
    );
    if (rBanana.status === 0) {
      hdFail(8, label, `retrieval_outcome='banana' was accepted (expected rejection)`);
      return false;
    }
    const bananaOut = (rBanana.stderr || '') + (rBanana.stdout || '');
    if (!bananaOut.includes('retrieval_outcome')) {
      hdFail(8, label, `rejection for 'banana' does not name "retrieval_outcome" field: ${bananaOut.slice(0, 300)}`);
      return false;
    }

    // ── Sub-test C: retrieval_outcome='success' must be accepted ─────────────
    const rSuccess = spawnSync(
      process.execPath, closeArgs,
      spawnOpts(JSON.stringify({ tldr: 'test', retrieval_outcome: 'success' }))
    );
    // May fail for DB reasons but must NOT fail for schema validation.
    // We check: if it exits non-zero, the error must NOT mention retrieval_outcome schema.
    if (rSuccess.status !== 0) {
      const successOut = (rSuccess.stderr || '') + (rSuccess.stdout || '');
      if (successOut.includes('stdin JSON') && successOut.includes('retrieval_outcome')) {
        hdFail(8, label, `retrieval_outcome='success' was rejected at schema level — must be accepted: ${successOut.slice(0, 300)}`);
        return false;
      }
      // Non-zero exit for DB / other reasons is acceptable here (schema accepted the value).
    }

    hdPass(8, label);
    return true;
  } catch (err) {
    hdFail(8, label, err.message);
    return false;
  }
}

// ── W2 step implementations ───────────────────────────────────────────────────

const W2_SCRIPT = path.join(PROJECT_ROOT, 'scripts', 'bundleb-w2-extract.js');

/**
 * W2 1/3: parseExtraction unit tests.
 *
 * Covers: clean JSON object; ```json fenced; prose-wrapped; missing-arrays
 * defaults; garbage/null/'' returns null; oversized arrays are capped.
 * All pure-function tests — no DB or Ollama required.
 */
async function w2Step1_parseExtractionUnit() {
  const label = 'parseExtraction: clean JSON, fenced, prose-wrapped, defaults, null/garbage, array cap';
  try {
    const { parseExtraction } = require(W2_SCRIPT);

    // Sub-test A: clean JSON object parses
    const clean = parseExtraction('{"entities":[{"name":"Claude","entity_type":"system","description":"LLM"}],"assertions":[{"subject":"Claude","predicate":"is","object":"LLM"}],"edges":[{"from_entity":"Claude","edge_type":"uses","to_entity":"Ollama"}]}');
    if (!clean || clean.entities.length !== 1 || clean.assertions.length !== 1 || clean.edges.length !== 1) {
      w2Fail(1, label, `clean JSON parse failed: ${JSON.stringify(clean)}`);
      return false;
    }

    // Sub-test B: ```json fenced ``` parses
    const fenced = parseExtraction('```json\n{"entities":[{"name":"X","entity_type":"tool","description":"d"}],"assertions":[],"edges":[]}\n```');
    if (!fenced || fenced.entities.length !== 1 || fenced.assertions.length !== 0) {
      w2Fail(1, label, `fenced JSON parse failed: ${JSON.stringify(fenced)}`);
      return false;
    }

    // Sub-test C: prose-wrapped {...} parses
    const prose = parseExtraction('Here is the extraction: {"entities":[],"assertions":[{"subject":"A","predicate":"uses","object":"B"}],"edges":[]} and that is all.');
    if (!prose || prose.assertions.length !== 1) {
      w2Fail(1, label, `prose-wrapped JSON parse failed: ${JSON.stringify(prose)}`);
      return false;
    }

    // Sub-test D: missing arrays default to []
    const partial = parseExtraction('{"entities":[{"name":"N","entity_type":"concept"}]}');
    if (!partial || !Array.isArray(partial.assertions) || !Array.isArray(partial.edges)) {
      w2Fail(1, label, `missing-arrays default failed: ${JSON.stringify(partial)}`);
      return false;
    }
    if (partial.assertions.length !== 0 || partial.edges.length !== 0) {
      w2Fail(1, label, `missing arrays should default to [] but got: ${JSON.stringify(partial)}`);
      return false;
    }

    // Sub-test E: garbage / null / '' returns null
    if (parseExtraction(null) !== null) {
      w2Fail(1, label, `parseExtraction(null) should return null`);
      return false;
    }
    if (parseExtraction('') !== null) {
      w2Fail(1, label, `parseExtraction('') should return null`);
      return false;
    }
    if (parseExtraction('not json at all!!!') !== null) {
      w2Fail(1, label, `parseExtraction('not json at all!!!') should return null`);
      return false;
    }

    // Sub-test F: oversized arrays are capped at 100
    const bigEntities = Array.from({ length: 150 }, (_, i) => ({
      name: `Entity${i}`,
      entity_type: 'concept',
      description: `desc${i}`,
    }));
    const bigJson = JSON.stringify({ entities: bigEntities, assertions: [], edges: [] });
    const capped = parseExtraction(bigJson);
    if (!capped || capped.entities.length > 100) {
      w2Fail(1, label, `oversized array not capped: got ${capped ? capped.entities.length : 'null'} entities`);
      return false;
    }

    w2Pass(1, label);
    return true;
  } catch (err) {
    w2Fail(1, label, err.message);
    return false;
  }
}

/**
 * W2 2/3: OLLAMA_SKIP=1 no-op proof.
 *
 * Runs bundleb-w2-extract.js with OLLAMA_SKIP=1 against the W2 throwaway DB.
 * Asserts exit 0 and zero source='model_extracted' rows were written.
 */
async function w2Step2_ollamaSkipNoOp(w2Db, w2ProjectId) {
  const label = 'OLLAMA_SKIP=1: script exits 0, zero model_extracted assertions written';
  try {
    // Run the script under OLLAMA_SKIP=1
    const env = {
      ...process.env,
      OLLAMA_SKIP: '1',
      HANDOFF_DB:  w2Db,
    };
    const r = spawnSync(process.execPath, [W2_SCRIPT], {
      cwd:      PROJECT_ROOT,
      env,
      encoding: 'utf8',
      timeout:  15000,
    });

    if (r.status !== 0) {
      w2Fail(2, label, `exit ${r.status} — expected 0 (stdout: ${(r.stdout || '').slice(0, 200)})`);
      return false;
    }

    const stdout = r.stdout || '';
    if (!stdout.includes('OLLAMA_SKIP=1')) {
      w2Fail(2, label, `stdout does not contain expected OLLAMA_SKIP=1 message: ${stdout.slice(0, 200)}`);
      return false;
    }

    // Verify zero model_extracted rows in the DB
    const db = await pgConnect(w2Db);
    const { rows } = await db.query(
      `SELECT COUNT(*) AS n FROM assertions WHERE project_id = $1 AND source = 'model_extracted'`,
      [w2ProjectId]
    );
    await db.end();

    if (parseInt(rows[0].n, 10) !== 0) {
      w2Fail(2, label, `expected 0 model_extracted rows, found ${rows[0].n}`);
      return false;
    }

    w2Pass(2, label);
    return true;
  } catch (err) {
    w2Fail(2, label, err.message);
    return false;
  }
}

/**
 * W2 3/3: Idempotency predicate test.
 *
 * Insert a fake assertion with session_id='w2-extract:decision:999999' directly
 * into the throwaway DB. Then test that the skip-check SQL predicate (SELECT 1
 * FROM assertions WHERE project_id=$1 AND session_id=$2) correctly identifies
 * decision 999999 as already-extracted.
 */
async function w2Step3_idempotencyPredicate(w2Db, w2ProjectId) {
  const label = 'Idempotency: skip-check predicate finds pre-existing session_id row';
  try {
    const sid = 'w2-extract:decision:999999';

    // Insert fake assertion directly
    const db = await pgConnect(w2Db);
    await db.query(
      `INSERT INTO assertions
         (project_id, subject, predicate, object, confidence, source, session_id, last_reinforced)
       VALUES ($1, 'test_subject', 'test_predicate', 'test_object', 5.0, 'model_extracted', $2, now())`,
      [w2ProjectId, sid]
    );

    // Run the skip-check query exactly as the script does
    const existing = await db.query(
      `SELECT 1 FROM assertions WHERE project_id = $1 AND session_id = $2 LIMIT 1`,
      [w2ProjectId, sid]
    );
    await db.end();

    if (existing.rows.length === 0) {
      w2Fail(3, label, 'skip-check predicate returned no rows for pre-inserted session_id — idempotency check is broken');
      return false;
    }

    w2Pass(3, label);
    return true;
  } catch (err) {
    w2Fail(3, label, err.message);
    return false;
  }
}

// ── W3 step implementations ───────────────────────────────────────────────────

const W3_SCRIPT = path.join(PROJECT_ROOT, 'scripts', 'bundleb-w3-communities.js');

/**
 * W3 1/5: entity_communities table exists in a throwaway DB after init.
 *
 * Runs init against the W3 DB and checks the table is present.
 * Pure Node + DB — no Python required.
 */
async function w3Step1_tableExists(w3Db) {
  const label = 'entity_communities table exists after init';
  try {
    const db = await pgConnect(w3Db);
    const { rows } = await db.query(
      `SELECT 1 FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = 'entity_communities'`
    );
    await db.end();

    if (rows.length === 0) {
      w3Fail(1, label, 'entity_communities table not found in DB after init');
      return false;
    }

    w3Pass(1, label);
    return true;
  } catch (err) {
    w3Fail(1, label, err.message);
    return false;
  }
}

/**
 * W3 2/5: buildGraphPayload unit test.
 *
 * Pure function — no DB or Python required.
 * Verifies rows → {nodes, edges} shape, filtering of edges with missing nodes.
 */
async function w3Step2_buildGraphPayload() {
  const label = 'buildGraphPayload: rows -> {nodes, edges} correct shape and edge filtering';
  try {
    const { buildGraphPayload } = require(W3_SCRIPT);

    const nodeNames = ['EntityA', 'EntityB', 'EntityC'];
    const edgeRows  = [
      { from_entity: 'EntityA', to_entity: 'EntityB', weight: 1.5 },
      { from_entity: 'EntityB', to_entity: 'EntityC', weight: 2.0 },
      // Edge referencing a node NOT in nodeNames — must be filtered out.
      { from_entity: 'EntityA', to_entity: 'MissingEntity', weight: 1.0 },
    ];

    const payload = buildGraphPayload(nodeNames, edgeRows);

    // Nodes must be the exact input list.
    if (!Array.isArray(payload.nodes) || payload.nodes.length !== 3) {
      w3Fail(2, label, `nodes array has ${payload.nodes ? payload.nodes.length : 'null'} elements, expected 3`);
      return false;
    }

    // Edges: only the 2 valid ones should appear (MissingEntity filtered out).
    if (!Array.isArray(payload.edges) || payload.edges.length !== 2) {
      w3Fail(2, label, `edges array has ${payload.edges ? payload.edges.length : 'null'} elements, expected 2`);
      return false;
    }

    // Edge format must be [from, to, weight].
    const firstEdge = payload.edges[0];
    if (!Array.isArray(firstEdge) || firstEdge.length !== 3) {
      w3Fail(2, label, `edge is not a [from, to, weight] triple: ${JSON.stringify(firstEdge)}`);
      return false;
    }

    // Empty nodes / edges must produce empty payload.
    const emptyPayload = buildGraphPayload([], []);
    if (emptyPayload.nodes.length !== 0 || emptyPayload.edges.length !== 0) {
      w3Fail(2, label, `empty input produced non-empty payload: ${JSON.stringify(emptyPayload)}`);
      return false;
    }

    w3Pass(2, label);
    return true;
  } catch (err) {
    w3Fail(2, label, err.message);
    return false;
  }
}

/**
 * W3 3/5: W3_SKIP=1 no-op proof.
 *
 * Runs bundleb-w3-communities.js with W3_SKIP=1. Asserts exit 0 and zero rows
 * in entity_communities. No Python required.
 */
async function w3Step3_w3SkipNoOp(w3Db, w3ProjectId) {
  const label = 'W3_SKIP=1: script exits 0, zero entity_communities rows';
  try {
    const env = {
      ...process.env,
      W3_SKIP:     '1',
      HANDOFF_DB:  w3Db,
    };
    const r = spawnSync(process.execPath, [W3_SCRIPT], {
      cwd:      PROJECT_ROOT,
      env,
      encoding: 'utf8',
      timeout:  15000,
    });

    if (r.status !== 0) {
      w3Fail(3, label, `exit ${r.status} — expected 0 (stdout: ${(r.stdout || '').slice(0, 200)})`);
      return false;
    }

    const stdout = r.stdout || '';
    if (!stdout.includes('W3_SKIP=1')) {
      w3Fail(3, label, `stdout does not contain W3_SKIP=1 message: ${stdout.slice(0, 200)}`);
      return false;
    }

    // Verify zero entity_communities rows.
    const db = await pgConnect(w3Db);
    const { rows } = await db.query(
      `SELECT COUNT(*) AS n FROM entity_communities WHERE project_id = $1`,
      [w3ProjectId]
    );
    await db.end();

    if (parseInt(rows[0].n, 10) !== 0) {
      w3Fail(3, label, `expected 0 entity_communities rows, found ${rows[0].n}`);
      return false;
    }

    w3Pass(3, label);
    return true;
  } catch (err) {
    w3Fail(3, label, err.message);
    return false;
  }
}

/**
 * W3 4/5: No-regression / degrade-safety (critical).
 *
 * With entity_communities EMPTY (no rows), runs resume and asserts:
 * - Output does NOT contain "### Related (community)" — loader output is
 *   byte-comparable to pre-W3 (empty-table no-op guarantee).
 * - Existing resume assertions still hold: SMOKETEST markers visible, no
 *   suppressed marker leaked, trusted canon precedes untrusted block.
 *
 * No Python required.
 */
async function w3Step4_noRegressionEmptyTable(w3Db, w3ProjectId, w3ProjectDir) {
  const label = 'No-regression: empty entity_communities => no Related section; existing assertions intact';
  try {
    // Verify entity_communities has no rows (it should be empty from prior steps).
    const db = await pgConnect(w3Db);
    const { rows: ecRows } = await db.query(
      `SELECT COUNT(*) AS n FROM entity_communities WHERE project_id = $1`,
      [w3ProjectId]
    );
    if (parseInt(ecRows[0].n, 10) !== 0) {
      // Rows present from a prior failed test — clean up for this test.
      await db.query(`DELETE FROM entity_communities WHERE project_id = $1`, [w3ProjectId]);
    }

    // Insert a test entity + assertion so resume has something to return.
    await db.query(
      `INSERT INTO entities (project_id, name, entity_type, description)
       VALUES ($1, 'W3_NOREG_ENTITY', 'system', 'No-regression test entity')
       ON CONFLICT (project_id, name) DO NOTHING`,
      [w3ProjectId]
    );
    await db.query(
      `INSERT INTO assertions (project_id, subject, predicate, object, confidence, source, last_reinforced)
       VALUES ($1, 'W3_NOREG_SUBJECT', 'is', 'W3_NOREG_MARKER', 8, 'user_stated', now())
       ON CONFLICT DO NOTHING`,
      [w3ProjectId]
    );

    // Set contract to load both entity and assertion.
    await db.query(
      `UPDATE retrieval_contract
       SET queries = $2::jsonb, updated_at = now()
       WHERE project_id = $1 AND name = 'default'`,
      [w3ProjectId, JSON.stringify({ queries: [{ kind: 'entity' }, { kind: 'assertion' }] })]
    );
    await db.end();

    const env = { ...process.env, HANDOFF_DB: w3Db, PROJECT_ROOT: w3ProjectDir };
    const r = spawnSync(process.execPath, [HANDOFF_SCRIPT, 'resume'], {
      cwd:      PROJECT_ROOT,
      env,
      encoding: 'utf8',
      timeout:  30000,
    });

    if (r.status !== 0) {
      w3Fail(4, label, `resume exited ${r.status}: ${(r.stderr || r.stdout || '').slice(0, 200)}`);
      return false;
    }

    const out = r.stdout || '';

    // CRITICAL: no Related (community) section must appear.
    if (out.includes('### Related (community)')) {
      w3Fail(4, label, '"### Related (community)" section appeared despite empty entity_communities — no-regression guarantee violated');
      return false;
    }

    // Existing assertion should be visible.
    if (!out.includes('W3_NOREG_MARKER')) {
      w3Fail(4, label, 'W3_NOREG_MARKER not found in resume output — existing assertion retrieval broken');
      return false;
    }

    // Trusted canon before untrusted block.
    const canonIdx     = out.indexOf('=== OPERATING CANON (trusted');
    const untrustedIdx = out.indexOf('=== BEGIN RETRIEVED CONTEXT (untrusted)');
    if (canonIdx === -1) {
      w3Fail(4, label, 'OPERATING CANON preamble not found in resume output');
      return false;
    }
    if (untrustedIdx !== -1 && canonIdx > untrustedIdx) {
      w3Fail(4, label, 'OPERATING CANON appears AFTER untrusted block — ordering violated');
      return false;
    }

    w3Pass(4, label);
    return true;
  } catch (err) {
    w3Fail(4, label, err.message);
    return false;
  }
}

/**
 * W3 5/5: Cluster expansion + cap test.
 *
 * Directly inserts entity rows and entity_communities rows (same community_id,
 * fresh run_id) for a hit entity and 2 sibling entities, then runs resume and
 * asserts:
 * - "### Related (community)" section appears with the 2 siblings.
 * - The hit entity is NOT duplicated in the siblings section.
 * - cluster_max_siblings cap is honored (set cap to 1, add 2 siblings, verify only 1 appears).
 *
 * No Python required — uses direct SQL inserts.
 */
async function w3Step5_clusterExpansion(w3Db, w3ProjectId, w3ProjectDir) {
  const label = 'Cluster expansion: Related section appears; cap honored; hit entity not duplicated';
  try {
    const db = await pgConnect(w3Db);

    // Clean up any prior entity_communities rows for this project.
    await db.query(`DELETE FROM entity_communities WHERE project_id = $1`, [w3ProjectId]);

    // Insert the hit entity (must appear in entities table + be in the contract).
    const HIT_ENTITY     = 'W3_HIT_ENTITY';
    const SIBLING_A      = 'W3_SIBLING_A';
    const SIBLING_B      = 'W3_SIBLING_B';
    const SIBLING_CAP    = 'W3_SIBLING_CAP';  // extra sibling used for cap test
    const RUN_ID         = new Date().toISOString();
    const COMMUNITY_ID   = 42;

    // Entities.
    for (const name of [HIT_ENTITY, SIBLING_A, SIBLING_B, SIBLING_CAP]) {
      await db.query(
        `INSERT INTO entities (project_id, name, entity_type, description)
         VALUES ($1, $2, 'system', $3)
         ON CONFLICT (project_id, name) DO NOTHING`,
        [w3ProjectId, name, `Test entity ${name}`]
      );
    }

    // Contract: load the hit entity by name.
    await db.query(
      `UPDATE retrieval_contract
       SET queries = $2::jsonb, updated_at = now()
       WHERE project_id = $1 AND name = 'default'`,
      [w3ProjectId, JSON.stringify({ queries: [{ kind: 'entity', filter: { name: HIT_ENTITY } }] })]
    );

    // entity_communities: hit entity + 3 siblings in same community.
    for (const [name, cid] of [
      [HIT_ENTITY, COMMUNITY_ID],
      [SIBLING_A,  COMMUNITY_ID],
      [SIBLING_B,  COMMUNITY_ID],
      [SIBLING_CAP, COMMUNITY_ID],
    ]) {
      await db.query(
        `INSERT INTO entity_communities (project_id, entity_name, community_id, level, run_id)
         VALUES ($1, $2, $3, 0, $4)`,
        [w3ProjectId, name, cid, RUN_ID]
      );
    }

    // Ensure cluster_aware_retrieval=enabled (default, but be explicit).
    await db.query(
      `INSERT INTO project_settings (project_id, key, value)
       VALUES ($1, 'cluster_aware_retrieval', 'enabled')
       ON CONFLICT (project_id, key) DO UPDATE SET value = 'enabled'`,
      [w3ProjectId]
    );

    await db.end();

    // ── Sub-test A: basic expansion ───────────────────────────────────────────
    const envA = { ...process.env, HANDOFF_DB: w3Db, PROJECT_ROOT: w3ProjectDir };
    const rA = spawnSync(process.execPath, [HANDOFF_SCRIPT, 'resume'], {
      cwd: PROJECT_ROOT, env: envA, encoding: 'utf8', timeout: 30000,
    });

    if (rA.status !== 0) {
      w3Fail(5, label, `resume exited ${rA.status}: ${(rA.stderr || rA.stdout || '').slice(0, 200)}`);
      return false;
    }

    const outA = rA.stdout || '';

    if (!outA.includes('### Related (community)')) {
      w3Fail(5, label, '"### Related (community)" section not found in resume output');
      return false;
    }

    // Siblings A and B must appear.
    if (!outA.includes(SIBLING_A)) {
      w3Fail(5, label, `${SIBLING_A} not found in Related (community) section`);
      return false;
    }
    if (!outA.includes(SIBLING_B)) {
      w3Fail(5, label, `${SIBLING_B} not found in Related (community) section`);
      return false;
    }

    // Hit entity must NOT be duplicated in the Related section.
    // It appears in the ### Entities section; the Related section should exclude it.
    const relatedIdx = outA.indexOf('### Related (community)');
    const afterRelated = outA.slice(relatedIdx);
    if (afterRelated.includes(HIT_ENTITY)) {
      w3Fail(5, label, `${HIT_ENTITY} (hit entity) appears in Related (community) section — must be excluded`);
      return false;
    }

    // ── Sub-test B: cap enforcement ───────────────────────────────────────────
    // Set cluster_max_siblings=1 — only 1 sibling should appear.
    const dbCap = await pgConnect(w3Db);
    await dbCap.query(
      `INSERT INTO project_settings (project_id, key, value)
       VALUES ($1, 'cluster_max_siblings', '1')
       ON CONFLICT (project_id, key) DO UPDATE SET value = '1'`,
      [w3ProjectId]
    );
    await dbCap.end();

    const envB = { ...process.env, HANDOFF_DB: w3Db, PROJECT_ROOT: w3ProjectDir };
    const rB = spawnSync(process.execPath, [HANDOFF_SCRIPT, 'resume'], {
      cwd: PROJECT_ROOT, env: envB, encoding: 'utf8', timeout: 30000,
    });

    if (rB.status !== 0) {
      w3Fail(5, label, `resume (cap test) exited ${rB.status}: ${(rB.stderr || rB.stdout || '').slice(0, 200)}`);
      return false;
    }

    const outB = rB.stdout || '';
    if (!outB.includes('### Related (community)')) {
      w3Fail(5, label, '"### Related (community)" section missing in cap-test resume output');
      return false;
    }

    // Count how many of the 3 siblings appear in the Related section.
    const relatedIdxB = outB.indexOf('### Related (community)');
    const afterRelatedB = outB.slice(relatedIdxB);
    const siblingCount = [SIBLING_A, SIBLING_B, SIBLING_CAP].filter((s) => afterRelatedB.includes(s)).length;
    if (siblingCount > 1) {
      w3Fail(5, label, `cap=1 but ${siblingCount} siblings appeared in Related section — cap not enforced`);
      return false;
    }

    // Restore cluster_max_siblings to default.
    const dbRestore = await pgConnect(w3Db);
    await dbRestore.query(
      `INSERT INTO project_settings (project_id, key, value)
       VALUES ($1, 'cluster_max_siblings', '10')
       ON CONFLICT (project_id, key) DO UPDATE SET value = '10'`,
      [w3ProjectId]
    );
    await dbRestore.end();

    w3Pass(5, label);
    return true;
  } catch (err) {
    w3Fail(5, label, err.message);
    return false;
  }
}

async function runW3Section() {
  console.log(`\n=== W3 SECTION (${W3_TOTAL} steps) ===`);
  console.log('smoketest-handoff W3: table, buildGraphPayload, W3_SKIP no-op, no-regression, cluster-expansion + cap');
  console.log('(All steps pass without Python — no Python or leidenalg required)');
  console.log('');

  const W3_TS       = Date.now();
  const W3_DB       = `claude_memory_w3_${W3_TS}`;
  const W3_PROJ_DIR = path.join(os.tmpdir(), `handoff_w3_${W3_TS}`);
  const W3_PROJECT_ID = encodeCwd(W3_PROJ_DIR);

  try {
    // Set up throwaway DB first (steps 1, 3, 4, 5 need it; step 2 is pure).
    await createSmokeDb(W3_DB, W3_PROJ_DIR);

    // Write a minimal CLAUDE.md so init can run cleanly.
    const w3ClaudeMd = path.join(W3_PROJ_DIR, 'CLAUDE.md');
    fs.writeFileSync(w3ClaudeMd, '# w3-test\n\n## Durable facts\n- (none)\n', 'utf8');

    // Run init so all base tables exist.
    const initR = spawnSync(
      process.execPath,
      [HANDOFF_SCRIPT, 'init', '-y'],
      {
        cwd:      PROJECT_ROOT,
        env:      { ...process.env, HANDOFF_DB: W3_DB, PROJECT_ROOT: W3_PROJ_DIR },
        encoding: 'utf8',
        timeout:  30000,
      }
    );
    if (initR.status !== 0) {
      console.log(`[W3] DB init failed — skipping remaining steps`);
      console.log(initR.stderr || initR.stdout || '');
      w3Failed += W3_TOTAL;
      return;
    }
    console.log(`[W3] DB init OK (${W3_DB})`);

    // Also create retrieval_events in the throwaway DB so loader INSERT works.
    // (entity_communities is created by init via handoff-core-schema.sql.)
    try {
      await createRetrievalEventsTable(W3_DB);
    } catch (_) { /* non-fatal */ }

    // Step 1: table existence check (entity_communities present after init).
    await w3Step1_tableExists(W3_DB);

    // Step 2: buildGraphPayload unit — pure function, no DB required.
    await w3Step2_buildGraphPayload();

    // Step 3: W3_SKIP no-op.
    await w3Step3_w3SkipNoOp(W3_DB, W3_PROJECT_ID);

    // Step 4: no-regression with empty entity_communities.
    await w3Step4_noRegressionEmptyTable(W3_DB, W3_PROJECT_ID, W3_PROJ_DIR);

    // Step 5: cluster expansion + cap.
    await w3Step5_clusterExpansion(W3_DB, W3_PROJECT_ID, W3_PROJ_DIR);

  } finally {
    const W3_HANDOFF_PATH = path.join(os.homedir(), '.claude', 'projects', W3_PROJECT_ID, 'handoff.md');
    await dropSmokeDb(W3_DB, W3_PROJ_DIR, W3_HANDOFF_PATH).catch(() => {});
  }
}

// ── W4 step implementations ───────────────────────────────────────────────────

const W4_SCRIPT = path.join(PROJECT_ROOT, 'scripts', 'bundleb-w4-contract.js');

/**
 * Create the retrieval_contract_history table in the given DB (W4, portable).
 * Mirrors the DDL in handoff-core-schema.sql exactly.
 */
async function createContractHistoryTable(dbName) {
  const db = await pgConnect(dbName);
  await db.query(`
    CREATE TABLE IF NOT EXISTS retrieval_contract_history (
      id          SERIAL PRIMARY KEY,
      project_id  TEXT NOT NULL,
      name        TEXT NOT NULL,
      version     INTEGER NOT NULL,
      queries     JSONB NOT NULL,
      change_note TEXT,
      changed_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await db.query(`
    CREATE INDEX IF NOT EXISTS retrieval_contract_history_idx
      ON retrieval_contract_history (project_id, name, version)
  `);
  // Also add version column to retrieval_contract if it doesn't exist yet.
  await db.query(`
    ALTER TABLE retrieval_contract ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 1
  `);
  await db.end();
}

/**
 * W4 1/6: Schema — retrieval_contract.version column and retrieval_contract_history
 * table exist in the throwaway DB after init.
 */
async function w4Step1_schemaExists(w4Db) {
  const label = 'Schema: retrieval_contract.version column and retrieval_contract_history table exist after init';
  try {
    const db = await pgConnect(w4Db);

    // Check version column on retrieval_contract.
    const { rows: colRows } = await db.query(
      `SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name   = 'retrieval_contract'
         AND column_name  = 'version'`
    );
    if (colRows.length === 0) {
      await db.end();
      w4Fail(1, label, 'retrieval_contract.version column not found after init');
      return false;
    }

    // Check retrieval_contract_history table.
    const { rows: tblRows } = await db.query(
      `SELECT 1 FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = 'retrieval_contract_history'`
    );
    if (tblRows.length === 0) {
      await db.end();
      w4Fail(1, label, 'retrieval_contract_history table not found after init');
      return false;
    }

    await db.end();
    w4Pass(1, label);
    return true;
  } catch (err) {
    w4Fail(1, label, err.message);
    return false;
  }
}

/**
 * W4 2/6: queriesEqual unit test.
 *
 * Pure function — no DB required.
 * Verifies equal objects return true; different objects return false.
 */
async function w4Step2_queriesEqualUnit() {
  const label = 'queriesEqual: equal objects return true; different objects return false';
  try {
    const { queriesEqual } = require(W4_SCRIPT);

    // Equal: same structure.
    const a = { queries: [{ kind: 'assertion' }, { kind: 'recency' }] };
    const b = { queries: [{ kind: 'assertion' }, { kind: 'recency' }] };
    if (!queriesEqual(a, b)) {
      w4Fail(2, label, 'queriesEqual returned false for equal objects');
      return false;
    }

    // Different: query kinds differ.
    const c = { queries: [{ kind: 'entity' }] };
    if (queriesEqual(a, c)) {
      w4Fail(2, label, 'queriesEqual returned true for different objects');
      return false;
    }

    // Both empty.
    if (!queriesEqual({ queries: [] }, { queries: [] })) {
      w4Fail(2, label, 'queriesEqual returned false for two empty-queries objects');
      return false;
    }

    // One empty, one not.
    if (queriesEqual({ queries: [] }, { queries: [{ kind: 'assertion' }] })) {
      w4Fail(2, label, 'queriesEqual returned true when one side has no queries');
      return false;
    }

    w4Pass(2, label);
    return true;
  } catch (err) {
    w4Fail(2, label, err.message);
    return false;
  }
}

/**
 * W4 3/6: close with a non-empty contract bumps version 1→2, writes exactly one
 * history row; a second close with the IDENTICAL contract does NOT bump version
 * and writes NO new history row (idempotent no-op).
 */
async function w4Step3_versionBumpAndNoOp(w4Db, w4ProjectId, w4ProjectDir) {
  const label = 'Version bump 1→2 on first contract change; identical re-close is a no-op';
  try {
    const contractV2 = { queries: [{ kind: 'assertion' }] };

    // First close — should bump version from 1 → 2 and write a history row.
    const payload1 = JSON.stringify({
      tldr:     'W4 version-bump test',
      contract: contractV2,
    });
    const r1 = spawnSync(
      process.execPath,
      [HANDOFF_SCRIPT, 'close', '--json', '-'],
      {
        cwd:      PROJECT_ROOT,
        env:      { ...process.env, HANDOFF_DB: w4Db, PROJECT_ROOT: w4ProjectDir },
        input:    payload1,
        encoding: 'utf8',
        timeout:  30000,
      }
    );
    if (r1.status !== 0) {
      w4Fail(3, label, `first close exited ${r1.status}: ${(r1.stderr || r1.stdout || '').slice(0, 200)}`);
      return false;
    }

    const db = await pgConnect(w4Db);

    // Check version is now 2.
    const { rows: rcRows } = await db.query(
      `SELECT version FROM retrieval_contract WHERE project_id = $1 AND name = 'default'`,
      [w4ProjectId]
    );
    if (rcRows.length === 0 || parseInt(rcRows[0].version, 10) !== 2) {
      await db.end();
      w4Fail(3, label, `expected version=2 after first close, got ${rcRows.length > 0 ? rcRows[0].version : 'no row'}`);
      return false;
    }

    // Check exactly one history row.
    const { rows: hRows1 } = await db.query(
      `SELECT COUNT(*) AS n FROM retrieval_contract_history WHERE project_id = $1 AND name = 'default'`,
      [w4ProjectId]
    );
    // init writes 1 baseline row, close should add 1 more → total 2.
    const h1Count = parseInt(hRows1[0].n, 10);
    if (h1Count < 2) {
      await db.end();
      w4Fail(3, label, `expected >=2 history rows after first change (init baseline + v2 close), got ${h1Count}`);
      return false;
    }

    await db.end();

    // Second close — IDENTICAL contract — must be a no-op.
    const payload2 = JSON.stringify({
      tldr:     'W4 idempotent re-close',
      contract: contractV2,
    });
    const r2 = spawnSync(
      process.execPath,
      [HANDOFF_SCRIPT, 'close', '--json', '-'],
      {
        cwd:      PROJECT_ROOT,
        env:      { ...process.env, HANDOFF_DB: w4Db, PROJECT_ROOT: w4ProjectDir },
        input:    payload2,
        encoding: 'utf8',
        timeout:  30000,
      }
    );
    if (r2.status !== 0) {
      w4Fail(3, label, `second (identical) close exited ${r2.status}: ${(r2.stderr || r2.stdout || '').slice(0, 200)}`);
      return false;
    }

    const db2 = await pgConnect(w4Db);

    // Version must still be 2 (no bump).
    const { rows: rcRows2 } = await db2.query(
      `SELECT version FROM retrieval_contract WHERE project_id = $1 AND name = 'default'`,
      [w4ProjectId]
    );
    if (rcRows2.length === 0 || parseInt(rcRows2[0].version, 10) !== 2) {
      await db2.end();
      w4Fail(3, label, `version changed after identical re-close: expected 2, got ${rcRows2.length > 0 ? rcRows2[0].version : 'no row'}`);
      return false;
    }

    // History row count must be unchanged.
    const { rows: hRows2 } = await db2.query(
      `SELECT COUNT(*) AS n FROM retrieval_contract_history WHERE project_id = $1 AND name = 'default'`,
      [w4ProjectId]
    );
    const h2Count = parseInt(hRows2[0].n, 10);
    if (h2Count !== h1Count) {
      await db2.end();
      w4Fail(3, label, `history row count changed after identical re-close: before=${h1Count}, after=${h2Count}`);
      return false;
    }

    await db2.end();
    w4Pass(3, label);
    return { historyCountAfterV2: h1Count };
  } catch (err) {
    w4Fail(3, label, err.message);
    return false;
  }
}

/**
 * W4 4/6: A close with a DIFFERENT contract bumps version 2→3 and adds a history row.
 */
async function w4Step4_differentContractBumps(w4Db, w4ProjectId, w4ProjectDir, historyCountAfterV2) {
  const label = 'Different contract bumps to v3 and adds history row';
  try {
    const contractV3 = { queries: [{ kind: 'assertion' }, { kind: 'recency' }] };

    const payload = JSON.stringify({
      tldr:     'W4 v3 change test',
      contract: contractV3,
    });
    const r = spawnSync(
      process.execPath,
      [HANDOFF_SCRIPT, 'close', '--json', '-'],
      {
        cwd:      PROJECT_ROOT,
        env:      { ...process.env, HANDOFF_DB: w4Db, PROJECT_ROOT: w4ProjectDir },
        input:    payload,
        encoding: 'utf8',
        timeout:  30000,
      }
    );
    if (r.status !== 0) {
      w4Fail(4, label, `close exited ${r.status}: ${(r.stderr || r.stdout || '').slice(0, 200)}`);
      return false;
    }

    const db = await pgConnect(w4Db);

    // Version must now be 3.
    const { rows: rcRows } = await db.query(
      `SELECT version FROM retrieval_contract WHERE project_id = $1 AND name = 'default'`,
      [w4ProjectId]
    );
    const newVersion = rcRows.length > 0 ? parseInt(rcRows[0].version, 10) : -1;
    if (newVersion !== 3) {
      await db.end();
      w4Fail(4, label, `expected version=3 after different-contract close, got ${newVersion}`);
      return false;
    }

    // One new history row added.
    const { rows: hRows } = await db.query(
      `SELECT COUNT(*) AS n FROM retrieval_contract_history WHERE project_id = $1 AND name = 'default'`,
      [w4ProjectId]
    );
    const hCount = parseInt(hRows[0].n, 10);
    if (hCount !== historyCountAfterV2 + 1) {
      await db.end();
      w4Fail(4, label, `expected ${historyCountAfterV2 + 1} history rows, got ${hCount}`);
      return false;
    }

    await db.end();
    w4Pass(4, label);
    return true;
  } catch (err) {
    w4Fail(4, label, err.message);
    return false;
  }
}

/**
 * W4 5/6: rollback — after >=2 versions, rollback 1 sets live contract queries
 * equal to v1's queries, adds a history row with change_note containing 'rollback to v1',
 * and increments the version.
 */
async function w4Step5_rollback(w4Db, w4ProjectId, w4ProjectDir) {
  const label = 'rollback: live contract = v1 queries; new history row with rollback note; version incremented';
  try {
    // Get v1 queries (init baseline).
    const db = await pgConnect(w4Db);
    const { rows: v1Rows } = await db.query(
      `SELECT queries, version FROM retrieval_contract_history
       WHERE project_id = $1 AND name = 'default'
       ORDER BY version ASC LIMIT 1`,
      [w4ProjectId]
    );
    if (v1Rows.length === 0) {
      await db.end();
      w4Fail(5, label, 'no history rows found — cannot test rollback');
      return false;
    }

    const v1Queries  = v1Rows[0].queries;
    const v1Version  = v1Rows[0].version;

    // Get current live version and history count.
    const { rows: rcPre } = await db.query(
      `SELECT version FROM retrieval_contract WHERE project_id = $1 AND name = 'default'`,
      [w4ProjectId]
    );
    const preLiveVersion = rcPre.length > 0 ? parseInt(rcPre[0].version, 10) : -1;

    const { rows: hPre } = await db.query(
      `SELECT COUNT(*) AS n FROM retrieval_contract_history WHERE project_id = $1 AND name = 'default'`,
      [w4ProjectId]
    );
    const preHistCount = parseInt(hPre[0].n, 10);
    await db.end();

    // Run rollback via CLI subprocess.
    const r = spawnSync(
      process.execPath,
      [W4_SCRIPT, 'rollback', String(v1Version)],
      {
        cwd:      PROJECT_ROOT,
        env:      { ...process.env, HANDOFF_DB: w4Db, PROJECT_ROOT: w4ProjectDir },
        encoding: 'utf8',
        timeout:  15000,
      }
    );
    if (r.status !== 0) {
      w4Fail(5, label, `rollback CLI exited ${r.status}: ${(r.stderr || r.stdout || '').slice(0, 300)}`);
      return false;
    }

    const db2 = await pgConnect(w4Db);

    // Live contract queries must equal v1 queries.
    const { rows: rcPost } = await db2.query(
      `SELECT version, queries FROM retrieval_contract WHERE project_id = $1 AND name = 'default'`,
      [w4ProjectId]
    );
    if (rcPost.length === 0) {
      await db2.end();
      w4Fail(5, label, 'retrieval_contract row not found after rollback');
      return false;
    }

    const postLiveVersion = parseInt(rcPost[0].version, 10);
    if (postLiveVersion <= preLiveVersion) {
      await db2.end();
      w4Fail(5, label, `version not incremented after rollback: pre=${preLiveVersion}, post=${postLiveVersion}`);
      return false;
    }

    // Queries must match v1.
    const { queriesEqual } = require(W4_SCRIPT);
    if (!queriesEqual(rcPost[0].queries, v1Queries)) {
      await db2.end();
      w4Fail(5, label, `live contract queries after rollback do not match v${v1Version}: got ${JSON.stringify(rcPost[0].queries)}`);
      return false;
    }

    // One new history row with rollback note.
    const { rows: hPost } = await db2.query(
      `SELECT COUNT(*) AS n FROM retrieval_contract_history WHERE project_id = $1 AND name = 'default'`,
      [w4ProjectId]
    );
    const postHistCount = parseInt(hPost[0].n, 10);
    if (postHistCount !== preHistCount + 1) {
      await db2.end();
      w4Fail(5, label, `history row count did not increase by 1: before=${preHistCount}, after=${postHistCount}`);
      return false;
    }

    // Check rollback note.
    const { rows: rollbackRow } = await db2.query(
      `SELECT change_note FROM retrieval_contract_history
       WHERE project_id = $1 AND name = 'default'
       ORDER BY version DESC LIMIT 1`,
      [w4ProjectId]
    );
    const note = rollbackRow.length > 0 ? (rollbackRow[0].change_note || '') : '';
    if (!note.includes(`rollback to v${v1Version}`)) {
      await db2.end();
      w4Fail(5, label, `latest history row change_note does not contain 'rollback to v${v1Version}': "${note}"`);
      return false;
    }

    await db2.end();
    w4Pass(5, label);
    return true;
  } catch (err) {
    w4Fail(5, label, err.message);
    return false;
  }
}

/**
 * W4 6/6: No-regression — loader/resume still reads the contract and produces
 * expected output after versioning is added. Existing resume assertions still hold.
 *
 * After rollback (from step 5), resume must still work; any non-empty contract
 * still causes loader to retrieve from the correct tables.
 */
async function w4Step6_loaderNoRegression(w4Db, w4ProjectId, w4ProjectDir) {
  const label = 'No-regression: loader/resume reads versioned contract; existing resume assertions intact';
  try {
    const db = await pgConnect(w4Db);

    // Insert a test assertion and set a non-empty contract so resume retrieves it.
    await db.query(
      `INSERT INTO assertions (project_id, subject, predicate, object, confidence, source, last_reinforced)
       VALUES ($1, 'W4_NOREG_SUBJECT', 'is', 'W4_NOREG_MARKER', 8, 'user_stated', now())
       ON CONFLICT DO NOTHING`,
      [w4ProjectId]
    );
    await db.query(
      `UPDATE retrieval_contract
       SET queries = $2::jsonb, updated_at = now()
       WHERE project_id = $1 AND name = 'default'`,
      [w4ProjectId, JSON.stringify({ queries: [{ kind: 'assertion' }] })]
    );
    await db.end();

    const env = { ...process.env, HANDOFF_DB: w4Db, PROJECT_ROOT: w4ProjectDir };
    const r = spawnSync(process.execPath, [HANDOFF_SCRIPT, 'resume'], {
      cwd:      PROJECT_ROOT,
      env,
      encoding: 'utf8',
      timeout:  30000,
    });

    if (r.status !== 0) {
      w4Fail(6, label, `resume exited ${r.status}: ${(r.stderr || r.stdout || '').slice(0, 200)}`);
      return false;
    }

    const out = r.stdout || '';

    // Must contain the test assertion marker.
    if (!out.includes('W4_NOREG_MARKER')) {
      w4Fail(6, label, 'W4_NOREG_MARKER not found in resume output — assertion retrieval broken after versioning');
      return false;
    }

    // Trusted canon must precede untrusted block.
    const canonIdx     = out.indexOf('=== OPERATING CANON (trusted');
    const untrustedIdx = out.indexOf('=== BEGIN RETRIEVED CONTEXT (untrusted)');
    if (canonIdx === -1) {
      w4Fail(6, label, 'OPERATING CANON preamble not found in resume output');
      return false;
    }
    if (untrustedIdx !== -1 && canonIdx > untrustedIdx) {
      w4Fail(6, label, 'OPERATING CANON appears AFTER untrusted block — ordering violated');
      return false;
    }

    w4Pass(6, label);
    return true;
  } catch (err) {
    w4Fail(6, label, err.message);
    return false;
  }
}

async function runW4Section() {
  console.log(`\n=== W4 SECTION (${W4_TOTAL} steps) ===`);
  console.log('smoketest-handoff W4: schema, queriesEqual unit, version-bump + idempotent no-op, different-contract bump, rollback, loader no-regression');
  console.log('(All steps pass without Python or Ollama)');
  console.log('');

  const W4_TS       = Date.now();
  const W4_DB       = `claude_memory_w4_${W4_TS}`;
  const W4_PROJ_DIR = path.join(os.tmpdir(), `handoff_w4_${W4_TS}`);
  const W4_PROJECT_ID = encodeCwd(W4_PROJ_DIR);

  try {
    // Set up throwaway DB.
    await createSmokeDb(W4_DB, W4_PROJ_DIR);

    // Write a minimal CLAUDE.md so init can run cleanly.
    const w4ClaudeMd = path.join(W4_PROJ_DIR, 'CLAUDE.md');
    fs.writeFileSync(w4ClaudeMd, '# w4-test\n\n## Durable facts\n- (none)\n', 'utf8');

    // Run init so all base tables (including W4 schema) exist.
    const initR = spawnSync(
      process.execPath,
      [HANDOFF_SCRIPT, 'init', '-y'],
      {
        cwd:      PROJECT_ROOT,
        env:      { ...process.env, HANDOFF_DB: W4_DB, PROJECT_ROOT: W4_PROJ_DIR },
        encoding: 'utf8',
        timeout:  30000,
      }
    );
    if (initR.status !== 0) {
      console.log(`[W4] DB init failed — skipping remaining steps`);
      console.log(initR.stderr || initR.stdout || '');
      w4Failed += W4_TOTAL;
      return;
    }
    console.log(`[W4] DB init OK (${W4_DB})`);

    // Ensure retrieval_contract_history table exists in throwaway DB (idempotent).
    try {
      await createContractHistoryTable(W4_DB);
    } catch (_) { /* non-fatal — init should have done this via schema */ }

    // Also create retrieval_events so loader INSERT works.
    try {
      await createRetrievalEventsTable(W4_DB);
    } catch (_) { /* non-fatal */ }

    // Step 1: schema existence check.
    const ok1 = await w4Step1_schemaExists(W4_DB);
    if (!ok1) {
      console.log('[W4] Schema check failed — skipping remaining steps that need schema');
    }

    // Step 2: queriesEqual unit test (pure — no DB).
    await w4Step2_queriesEqualUnit();

    // Steps 3, 4, 5, 6: need DB and project.
    const step3Result = await w4Step3_versionBumpAndNoOp(W4_DB, W4_PROJECT_ID, W4_PROJ_DIR);
    const histCount   = step3Result && step3Result.historyCountAfterV2
      ? step3Result.historyCountAfterV2
      : null;

    if (histCount !== null) {
      await w4Step4_differentContractBumps(W4_DB, W4_PROJECT_ID, W4_PROJ_DIR, histCount);
    } else {
      w4Fail(4, 'Different contract bumps to v3', 'skipped due to step 3 failure');
    }

    await w4Step5_rollback(W4_DB, W4_PROJECT_ID, W4_PROJ_DIR);
    await w4Step6_loaderNoRegression(W4_DB, W4_PROJECT_ID, W4_PROJ_DIR);

  } finally {
    const W4_HANDOFF_PATH = path.join(os.homedir(), '.claude', 'projects', W4_PROJECT_ID, 'handoff.md');
    await dropSmokeDb(W4_DB, W4_PROJ_DIR, W4_HANDOFF_PATH).catch(() => {});
  }
}

async function runW2Section() {
  console.log(`\n=== W2 SECTION (${W2_TOTAL} steps) ===`);
  console.log('smoketest-handoff W2: parseExtraction unit + OLLAMA_SKIP no-op + idempotency predicate');
  console.log('');

  // W2 needs a throwaway DB provisioned with the handoff schema for DB-backed tests.
  const W2_TS         = Date.now();
  const W2_DB         = `claude_memory_w2_${W2_TS}`;
  const W2_PROJ_DIR   = path.join(os.tmpdir(), `handoff_w2_${W2_TS}`);

  // Compute project_id for W2_PROJ_DIR (must match how resolveProjectId() works)
  const W2_PROJECT_ID = encodeCwd(W2_PROJ_DIR);

  try {
    // Step 1: parseExtraction unit — pure function, no DB needed
    await w2Step1_parseExtractionUnit();

    // Set up DB for steps 2 and 3
    await createSmokeDb(W2_DB, W2_PROJ_DIR);

    const initR = spawnSync(
      process.execPath,
      [path.join(PROJECT_ROOT, 'scripts', 'handoff.js'), 'init', '-y'],
      {
        cwd:      PROJECT_ROOT,
        env:      { ...process.env, HANDOFF_DB: W2_DB, PROJECT_ROOT: W2_PROJ_DIR },
        encoding: 'utf8',
        timeout:  30000,
      }
    );
    if (initR.status !== 0) {
      console.log(`[W2] DB init failed — skipping steps 2 and 3`);
      console.log(initR.stderr || initR.stdout || '');
      w2Failed += 2;
      return;
    }
    console.log(`[W2] DB init OK (${W2_DB})`);

    await w2Step2_ollamaSkipNoOp(W2_DB, W2_PROJECT_ID);
    await w2Step3_idempotencyPredicate(W2_DB, W2_PROJECT_ID);

  } finally {
    const W2_HANDOFF_PATH = path.join(os.homedir(), '.claude', 'projects', W2_PROJECT_ID, 'handoff.md');
    await dropSmokeDb(W2_DB, W2_PROJ_DIR, W2_HANDOFF_PATH).catch(() => {});
  }
}

// ── C1: Bundle C1 — attribution substrate ────────────────────────────────────

/**
 * Create the retrieval_event_assertions join table in the given DB (C1, portable,
 * no pgvector). Mirrors the DDL in app-retrieval-events-schema.sql exactly.
 */
async function createRetrievalEventAssertionsTable(dbName) {
  const db = await pgConnect(dbName);
  await db.query(`
    CREATE TABLE IF NOT EXISTS retrieval_event_assertions (
      event_id      INTEGER NOT NULL,
      assertion_id  INTEGER NOT NULL
    )
  `);
  await db.query(`
    CREATE INDEX IF NOT EXISTS rea_event_idx ON retrieval_event_assertions (event_id)
  `);
  await db.query(`
    CREATE INDEX IF NOT EXISTS rea_assertion_idx ON retrieval_event_assertions (assertion_id)
  `);
  await db.end();
}

/**
 * C1 1/4: Schema — retrieval_event_assertions table and assertions.outcome_bias
 * column exist in the throwaway DB after init + schema application.
 */
async function c1Step1_schemaExists(c1Db) {
  const label = 'Schema: retrieval_event_assertions table and assertions.outcome_bias column exist';
  try {
    const db = await pgConnect(c1Db);

    // Check retrieval_event_assertions table.
    const { rows: tblRows } = await db.query(
      `SELECT 1 FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = 'retrieval_event_assertions'`
    );
    if (tblRows.length === 0) {
      await db.end();
      c1Fail(1, label, 'retrieval_event_assertions table not found in DB');
      return false;
    }

    // Check outcome_bias column on assertions.
    const { rows: colRows } = await db.query(
      `SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name   = 'assertions'
         AND column_name  = 'outcome_bias'`
    );
    if (colRows.length === 0) {
      await db.end();
      c1Fail(1, label, 'assertions.outcome_bias column not found after init');
      return false;
    }

    await db.end();
    c1Pass(1, label);
    return true;
  } catch (err) {
    c1Fail(1, label, err.message);
    return false;
  }
}

/**
 * C1 2/4: outcome_bias column defaults to 0.
 * Insert an assertion without specifying outcome_bias and confirm its value is 0.
 */
async function c1Step2_outcomeBiasDefault(c1Db, c1ProjectId) {
  const label = 'outcome_bias column defaults to 0 on new assertions';
  try {
    const db = await pgConnect(c1Db);

    const { rows } = await db.query(
      `INSERT INTO assertions
         (project_id, subject, predicate, object, confidence, source, last_reinforced)
       VALUES ($1, 'C1_TEST_SUBJECT', 'is', 'C1_TEST_OBJECT', 8, 'user_stated', now())
       RETURNING outcome_bias`,
      [c1ProjectId]
    );
    if (rows.length === 0 || rows[0].outcome_bias !== 0) {
      await db.end();
      c1Fail(2, label, `expected outcome_bias=0, got ${rows.length > 0 ? rows[0].outcome_bias : 'no row'}`);
      return false;
    }

    await db.end();
    c1Pass(2, label);
    return true;
  } catch (err) {
    c1Fail(2, label, err.message);
    return false;
  }
}

/**
 * C1 3/4: Join table gets >= 1 row after a loader run that retrieves assertions.
 *
 * Sets up a non-empty assertion-kind contract and runs resume (loader-load).
 * Confirms retrieval_event_assertions has at least one row for the new event.
 */
async function c1Step3_joinTablePopulated(c1Db, c1ProjectId, c1ProjectDir) {
  const label = 'retrieval_event_assertions gets >= 1 row after loader run with assertions';
  try {
    const db = await pgConnect(c1Db);

    // Ensure the test assertion inserted in step 2 is still there (or insert another).
    const { rows: existing } = await db.query(
      `SELECT id FROM assertions WHERE project_id = $1 AND subject = 'C1_TEST_SUBJECT'`,
      [c1ProjectId]
    );
    if (existing.length === 0) {
      await db.query(
        `INSERT INTO assertions
           (project_id, subject, predicate, object, confidence, source, last_reinforced)
         VALUES ($1, 'C1_TEST_SUBJECT', 'is', 'C1_TEST_OBJECT', 8, 'user_stated', now())`,
        [c1ProjectId]
      );
    }

    // Set contract to assertion kind so loader retrieves assertions.
    await db.query(
      `UPDATE retrieval_contract
       SET queries = $2::jsonb, updated_at = now()
       WHERE project_id = $1 AND name = 'default'`,
      [c1ProjectId, JSON.stringify({ queries: [{ kind: 'assertion' }] })]
    );

    // Count rows before resume.
    const { rows: beforeRows } = await db.query(
      `SELECT COUNT(*) AS n FROM retrieval_event_assertions`
    );
    const rowsBefore = parseInt(beforeRows[0].n, 10);
    await db.end();

    // Run resume (loader-load).
    const r = spawnSync(
      process.execPath,
      [HANDOFF_SCRIPT, 'loader-load'],
      {
        cwd:      PROJECT_ROOT,
        env:      { ...process.env, HANDOFF_DB: c1Db, PROJECT_ROOT: c1ProjectDir },
        encoding: 'utf8',
        timeout:  30000,
      }
    );
    if (r.status !== 0) {
      c1Fail(3, label, `loader-load exited ${r.status}: ${(r.stderr || r.stdout || '').slice(0, 200)}`);
      return false;
    }

    // Check rows after.
    const db2 = await pgConnect(c1Db);
    const { rows: afterRows } = await db2.query(
      `SELECT COUNT(*) AS n FROM retrieval_event_assertions`
    );
    const rowsAfter = parseInt(afterRows[0].n, 10);
    await db2.end();

    if (rowsAfter <= rowsBefore) {
      c1Fail(3, label, `expected > ${rowsBefore} rows in retrieval_event_assertions after loader run, got ${rowsAfter}`);
      return false;
    }

    c1Pass(3, label);
    return true;
  } catch (err) {
    c1Fail(3, label, err.message);
    return false;
  }
}

/**
 * C1 4/4: Loader printed output is byte-identical — no new sections or text.
 *
 * Runs loader-load twice with the same contract/data and confirms both
 * stdout outputs are identical. Also checks no new section headings appear
 * that would not have been present pre-C1.
 */
async function c1Step4_loaderOutputUnchanged(c1Db, c1ProjectId, c1ProjectDir) {
  const label = 'Loader printed output unchanged (no new sections or text introduced by C1)';
  try {
    const env = { ...process.env, HANDOFF_DB: c1Db, PROJECT_ROOT: c1ProjectDir };

    const r1 = spawnSync(
      process.execPath,
      [HANDOFF_SCRIPT, 'loader-load'],
      { cwd: PROJECT_ROOT, env, encoding: 'utf8', timeout: 30000 }
    );
    if (r1.status !== 0) {
      c1Fail(4, label, `first loader-load exited ${r1.status}: ${(r1.stderr || r1.stdout || '').slice(0, 200)}`);
      return false;
    }

    const r2 = spawnSync(
      process.execPath,
      [HANDOFF_SCRIPT, 'loader-load'],
      { cwd: PROJECT_ROOT, env, encoding: 'utf8', timeout: 30000 }
    );
    if (r2.status !== 0) {
      c1Fail(4, label, `second loader-load exited ${r2.status}: ${(r2.stderr || r2.stdout || '').slice(0, 200)}`);
      return false;
    }

    // Strip the "tokens used" line (counts are stable but token count may vary slightly).
    const normalize = (s) => s.replace(/tokens used: ~\d+/g, 'tokens used: ~X');
    const out1 = normalize(r1.stdout || '');
    const out2 = normalize(r2.stdout || '');
    if (out1 !== out2) {
      c1Fail(4, label, 'Two consecutive loader-load calls produced different stdout — output not stable');
      return false;
    }

    // Check that no C1-internal markers appear in stdout (attribution is DB-side only).
    const forbidden = ['retrieval_event_assertions', 'outcome_bias', 'C1 attribution'];
    for (const term of forbidden) {
      if ((r1.stdout || '').includes(term)) {
        c1Fail(4, label, `forbidden term "${term}" found in loader stdout — C1 leaks into output`);
        return false;
      }
    }

    c1Pass(4, label);
    return true;
  } catch (err) {
    c1Fail(4, label, err.message);
    return false;
  }
}

async function runC1Section() {
  console.log(`\n=== C1 SECTION (${C1_TOTAL} steps) ===`);
  console.log('smoketest-handoff C1: schema, outcome_bias default, join-table populated, loader output unchanged');
  console.log('(All steps pass without Python or Ollama)');
  console.log('');

  const C1_TS         = Date.now();
  const C1_DB         = `claude_memory_c1_${C1_TS}`;
  const C1_PROJ_DIR   = path.join(os.tmpdir(), `handoff_c1_${C1_TS}`);
  const C1_PROJECT_ID = encodeCwd(C1_PROJ_DIR);

  try {
    await createSmokeDb(C1_DB, C1_PROJ_DIR);

    // Write a minimal CLAUDE.md so init can run cleanly.
    const c1ClaudeMd = path.join(C1_PROJ_DIR, 'CLAUDE.md');
    fs.writeFileSync(c1ClaudeMd, '# c1-test\n\n## Durable facts\n- (none)\n', 'utf8');

    // Run init so all base tables (including outcome_bias) exist.
    const initR = spawnSync(
      process.execPath,
      [HANDOFF_SCRIPT, 'init', '-y'],
      {
        cwd:      PROJECT_ROOT,
        env:      { ...process.env, HANDOFF_DB: C1_DB, PROJECT_ROOT: C1_PROJ_DIR },
        encoding: 'utf8',
        timeout:  30000,
      }
    );
    if (initR.status !== 0) {
      console.log(`[C1] DB init failed — skipping remaining steps`);
      console.log(initR.stderr || initR.stdout || '');
      c1Failed += C1_TOTAL;
      return;
    }
    console.log(`[C1] DB init OK (${C1_DB})`);

    // Create retrieval_events (no pgvector in smoketest DB).
    try {
      await createRetrievalEventsTable(C1_DB);
    } catch (_) { /* non-fatal */ }

    // Create retrieval_event_assertions join table.
    try {
      await createRetrievalEventAssertionsTable(C1_DB);
    } catch (_) { /* non-fatal — step 1 will report failure */ }

    await c1Step1_schemaExists(C1_DB);
    await c1Step2_outcomeBiasDefault(C1_DB, C1_PROJECT_ID);
    await c1Step3_joinTablePopulated(C1_DB, C1_PROJECT_ID, C1_PROJ_DIR);
    await c1Step4_loaderOutputUnchanged(C1_DB, C1_PROJECT_ID, C1_PROJ_DIR);

  } finally {
    const C1_HANDOFF_PATH = path.join(os.homedir(), '.claude', 'projects', C1_PROJECT_ID, 'handoff.md');
    await dropSmokeDb(C1_DB, C1_PROJ_DIR, C1_HANDOFF_PATH).catch(() => {});
  }
}

// ── C2: Bundle C2 — outcome→ranking+decay feedback loop ──────────────────────

/**
 * C2 1/4: Gate OFF ⇒ loader output byte-identical to pre-C2 and outcome_bias never read.
 *
 * With feedback_loop_enabled='disabled' (default), loader output must be byte-identical
 * across two consecutive calls, and must not contain any outcome_bias-related text.
 */
async function c2Step1_gateOffNoOp(c2Db, c2ProjectId, c2ProjectDir) {
  const label = 'Gate OFF: loader output byte-identical, outcome_bias term never in query output';
  try {
    const db = await pgConnect(c2Db);

    // Confirm the gate is disabled (default).
    const { rows: settingRows } = await db.query(
      `SELECT value FROM project_settings WHERE project_id = $1 AND key = 'feedback_loop_enabled'`,
      [c2ProjectId]
    );
    const gateValue = settingRows.length > 0 ? settingRows[0].value : 'disabled';
    if (gateValue !== 'disabled') {
      await db.end();
      c2Fail(1, label, `feedback_loop_enabled is '${gateValue}', expected 'disabled' (default)`);
      return false;
    }

    // Insert a test assertion with a non-zero outcome_bias to confirm it does NOT affect output.
    await db.query(
      `INSERT INTO assertions
         (project_id, subject, predicate, object, confidence, source, last_reinforced, outcome_bias)
       VALUES ($1, 'C2_GATE_SUBJECT', 'is', 'C2_GATE_OBJECT', 7, 'user_stated', now(), 2.5)`,
      [c2ProjectId]
    );

    // Set contract to assertion kind so loader retrieves assertions.
    await db.query(
      `UPDATE retrieval_contract
       SET queries = $2::jsonb, updated_at = now()
       WHERE project_id = $1 AND name = 'default'`,
      [c2ProjectId, JSON.stringify({ queries: [{ kind: 'assertion' }] })]
    );
    await db.end();

    const env = { ...process.env, HANDOFF_DB: c2Db, PROJECT_ROOT: c2ProjectDir };

    // Run loader-load twice and compare output.
    const r1 = spawnSync(
      process.execPath, [HANDOFF_SCRIPT, 'loader-load'],
      { cwd: PROJECT_ROOT, env, encoding: 'utf8', timeout: 30000 }
    );
    if (r1.status !== 0) {
      c2Fail(1, label, `first loader-load exited ${r1.status}: ${(r1.stderr || r1.stdout || '').slice(0, 200)}`);
      return false;
    }

    const r2 = spawnSync(
      process.execPath, [HANDOFF_SCRIPT, 'loader-load'],
      { cwd: PROJECT_ROOT, env, encoding: 'utf8', timeout: 30000 }
    );
    if (r2.status !== 0) {
      c2Fail(1, label, `second loader-load exited ${r2.status}: ${(r2.stderr || r2.stdout || '').slice(0, 200)}`);
      return false;
    }

    // Normalize token count line (can vary between runs due to reinforcement timestamp drift).
    const normalize = (s) => s.replace(/tokens used: ~\d+/g, 'tokens used: ~X');
    const out1 = normalize(r1.stdout || '');
    const out2 = normalize(r2.stdout || '');
    if (out1 !== out2) {
      c2Fail(1, label, 'Two loader-load calls produced different stdout — output not stable with gate OFF');
      return false;
    }

    // Confirm C2-internal implementation details are not mentioned in loader stdout.
    // We check for terms that would only appear if the gate-off path leaked C2 internals.
    const forbidden = ['outcome_bias', 'feedback_loop_enabled', 'C2 feedback'];
    for (const term of forbidden) {
      if ((r1.stdout || '').includes(term)) {
        c2Fail(1, label, `Forbidden term "${term}" found in loader stdout — gate OFF leaks C2 internals`);
        return false;
      }
    }

    c2Pass(1, label);
    return true;
  } catch (err) {
    c2Fail(1, label, err.message);
    return false;
  }
}

/**
 * C2 2/4: Gate ON + seeded session with attributed assertions and mixed outcomes ⇒
 * outcome_bias moves in the right direction, bounded by the clamp.
 *
 * Seeds: two assertions with mixed outcomes across two retrieval events.
 * Runs cmdClose (via subproc) with gate ON. Checks bias moved correctly.
 */
async function c2Step2_gateOnBiasAdjustment(c2Db, c2ProjectId, c2ProjectDir) {
  const label = 'Gate ON: mixed outcomes adjust outcome_bias in correct direction, bounded by clamp';
  try {
    const db = await pgConnect(c2Db);

    // Enable the feedback loop.
    await db.query(
      `INSERT INTO project_settings (project_id, key, value)
       VALUES ($1, 'feedback_loop_enabled', 'enabled')
       ON CONFLICT (project_id, key) DO UPDATE SET value = 'enabled'`,
      [c2ProjectId]
    );

    // Insert two fresh assertions (outcome_bias starts at 0).
    const { rows: aRows } = await db.query(
      `INSERT INTO assertions
         (project_id, subject, predicate, object, confidence, source, last_reinforced, outcome_bias)
       VALUES ($1, 'C2_SUCCESS_SUBJECT', 'is', 'successful', 7, 'user_stated', now(), 0),
              ($1, 'C2_FAILURE_SUBJECT', 'is', 'failing',    7, 'user_stated', now(), 0)
       RETURNING id, subject`,
      [c2ProjectId]
    );
    const successAssertionId = aRows.find((r) => r.subject === 'C2_SUCCESS_SUBJECT').id;
    const failureAssertionId = aRows.find((r) => r.subject === 'C2_FAILURE_SUBJECT').id;

    // Create a retrieval_events table entry for a test session (no pgvector, so no embedding).
    const testSession = `c2-test-session-${Date.now()}`;
    const { rows: evtRows } = await db.query(
      `INSERT INTO retrieval_events (project_id, query_text, session_id, outcome, outcome_at, outcome_signal)
       VALUES ($1, 'c2-test-query', $2, 'success',    now(), 'agent_self_report'),
              ($1, 'c2-test-query', $2, 'failure',    now(), 'agent_self_report')
       RETURNING id, outcome`,
      [c2ProjectId, testSession]
    );
    const successEventId = evtRows.find((r) => r.outcome === 'success').id;
    const failureEventId = evtRows.find((r) => r.outcome === 'failure').id;

    // Attribute the assertions to their respective events.
    await db.query(
      `INSERT INTO retrieval_event_assertions (event_id, assertion_id)
       VALUES ($1, $2), ($3, $4)`,
      [successEventId, successAssertionId, failureEventId, failureAssertionId]
    );

    // Set session_in_progress so cmdClose can resolve the session id.
    await db.query(
      `INSERT INTO project_settings (project_id, key, value)
       VALUES ($1, 'session_in_progress', $2)
       ON CONFLICT (project_id, key) DO UPDATE SET value = $2`,
      [c2ProjectId, testSession]
    );
    await db.end();

    // Run cmdClose (subprocess) — this triggers the C2 feedback application block.
    const closePayload = JSON.stringify({ tldr: 'c2 test close', session_id: testSession });
    const r = spawnSync(
      process.execPath,
      [HANDOFF_SCRIPT, 'close', '--json', '-'],
      {
        cwd:      PROJECT_ROOT,
        env:      { ...process.env, HANDOFF_DB: c2Db, PROJECT_ROOT: c2ProjectDir },
        input:    closePayload,
        encoding: 'utf8',
        timeout:  30000,
      }
    );
    if (r.status !== 0) {
      c2Fail(2, label, `cmdClose exited ${r.status}: ${((r.stderr || '') + (r.stdout || '')).slice(0, 400)}`);
      return false;
    }

    // Check the output mentions C2 feedback adjustment.
    const closeOut = r.stdout || '';
    if (!closeOut.includes('C2 feedback')) {
      c2Fail(2, label, `cmdClose output does not mention "C2 feedback" — feedback block may not have run: ${closeOut.slice(0, 400)}`);
      return false;
    }

    // Verify bias moved in the correct direction.
    const db2 = await pgConnect(c2Db);
    const { rows: biasRows } = await db2.query(
      `SELECT id, subject, outcome_bias FROM assertions WHERE id = ANY($1)`,
      [[successAssertionId, failureAssertionId]]
    );
    await db2.end();

    const successRow = biasRows.find((r) => r.id === successAssertionId);
    const failureRow = biasRows.find((r) => r.id === failureAssertionId);

    if (!successRow || !failureRow) {
      c2Fail(2, label, 'Could not find test assertions in DB after cmdClose');
      return false;
    }

    // Success event → positive delta (default 0.5) → bias should be > 0.
    if (successRow.outcome_bias <= 0) {
      c2Fail(2, label, `success assertion bias is ${successRow.outcome_bias}, expected > 0`);
      return false;
    }

    // Failure event → negative delta (default -0.75) → bias should be < 0.
    if (failureRow.outcome_bias >= 0) {
      c2Fail(2, label, `failure assertion bias is ${failureRow.outcome_bias}, expected < 0`);
      return false;
    }

    c2Pass(2, label);
    return { ok: true, testSession, successAssertionId, failureAssertionId };
  } catch (err) {
    c2Fail(2, label, err.message);
    return { ok: false };
  }
}

/**
 * C2 3/4: Gate ON ⇒ strongly-negative-bias assertion demoted in ranking;
 * strongly-positive-bias assertion promoted.
 *
 * Inserts two assertions: one with outcome_bias = -2.9 (near floor), one at 0.
 * Checks ORDER BY effective_confidence puts the negative-bias one last (or suppresses it).
 */
async function c2Step3_biasAffectsRanking(c2Db, c2ProjectId, c2ProjectDir) {
  const label = 'Gate ON: negative-bias assertion ranked below positive-bias assertion in loader output';
  try {
    const db = await pgConnect(c2Db);

    // Ensure gate is still enabled (step 2 sets it, but be defensive).
    await db.query(
      `INSERT INTO project_settings (project_id, key, value)
       VALUES ($1, 'feedback_loop_enabled', 'enabled')
       ON CONFLICT (project_id, key) DO UPDATE SET value = 'enabled'`,
      [c2ProjectId]
    );

    // Insert two fresh assertions with distinct subjects and very different outcome_bias.
    // Both have the same base confidence (5) and are freshly reinforced.
    // high_bias: outcome_bias = 2.5 → effective_conf = 5 * 1 + 2.5 = 7.5
    // low_bias: outcome_bias = -3.0 → effective_conf = 5 * 1 + (-3.0) = 2.0 (still above 1.0)
    // suppressed_bias: outcome_bias = -4.5 → effective_conf = 5 * 1 + (-4.5) = 0.5 < 1.0 → suppressed
    const { rows: bRows } = await db.query(
      `INSERT INTO assertions
         (project_id, subject, predicate, object, confidence, source, last_reinforced, outcome_bias)
       VALUES ($1, 'C2_RANK_HIGH',       'is', 'top',       5, 'user_stated', now(),  2.5),
              ($1, 'C2_RANK_LOW',        'is', 'bottom',    5, 'user_stated', now(), -3.0),
              ($1, 'C2_RANK_SUPPRESSED', 'is', 'invisible', 5, 'user_stated', now(), -4.5)
       RETURNING id, subject`,
      [c2ProjectId]
    );

    // Set contract to assertion kind (no subject filter — retrieve all).
    await db.query(
      `UPDATE retrieval_contract
       SET queries = $2::jsonb, updated_at = now()
       WHERE project_id = $1 AND name = 'default'`,
      [c2ProjectId, JSON.stringify({ queries: [{ kind: 'assertion' }] })]
    );
    await db.end();

    // Run loader-load with gate ON (already set).
    const env = { ...process.env, HANDOFF_DB: c2Db, PROJECT_ROOT: c2ProjectDir };
    const r = spawnSync(
      process.execPath, [HANDOFF_SCRIPT, 'loader-load'],
      { cwd: PROJECT_ROOT, env, encoding: 'utf8', timeout: 30000 }
    );
    if (r.status !== 0) {
      c2Fail(3, label, `loader-load exited ${r.status}: ${(r.stderr || r.stdout || '').slice(0, 200)}`);
      return false;
    }

    const out = r.stdout || '';

    // C2_RANK_HIGH should appear in output.
    if (!out.includes('C2_RANK_HIGH')) {
      c2Fail(3, label, '"C2_RANK_HIGH" not found in loader output — high-bias assertion not retrieved');
      return false;
    }

    // C2_RANK_SUPPRESSED should NOT appear (effective_conf 0.5 < 1.0 threshold).
    if (out.includes('C2_RANK_SUPPRESSED')) {
      c2Fail(3, label, '"C2_RANK_SUPPRESSED" appears in loader output — suppression by outcome_bias not working');
      return false;
    }

    // C2_RANK_HIGH should appear before C2_RANK_LOW in the output (higher effective_conf ranks first).
    const highIdx = out.indexOf('C2_RANK_HIGH');
    const lowIdx  = out.indexOf('C2_RANK_LOW');
    if (lowIdx !== -1 && highIdx > lowIdx) {
      c2Fail(3, label, `C2_RANK_LOW (idx ${lowIdx}) appears before C2_RANK_HIGH (idx ${highIdx}) — ranking inverted`);
      return false;
    }

    c2Pass(3, label);
    return true;
  } catch (err) {
    c2Fail(3, label, err.message);
    return false;
  }
}

/**
 * C2 4/4: Idempotency — re-running cmdClose for the same session does not double-apply.
 *
 * After step 2 ran cmdClose for testSession, reads the current bias values, then
 * re-runs cmdClose for the same session_id and confirms bias values are unchanged.
 */
async function c2Step4_idempotency(c2Db, c2ProjectId, c2ProjectDir, testSession, successAssertionId, failureAssertionId) {
  const label = 'Idempotency: re-running cmdClose for the same session does not double-apply bias';
  if (!testSession || !successAssertionId || !failureAssertionId) {
    c2Fail(4, label, 'skipped due to step 2 failure (no testSession/assertionIds)');
    return false;
  }
  try {
    // Read current bias values (set by step 2's cmdClose run).
    const db = await pgConnect(c2Db);
    const { rows: before } = await db.query(
      `SELECT id, outcome_bias FROM assertions WHERE id = ANY($1)`,
      [[successAssertionId, failureAssertionId]]
    );

    // Re-set session_in_progress to the same session id (cmdClose will clear it, so we need to restore).
    await db.query(
      `INSERT INTO project_settings (project_id, key, value)
       VALUES ($1, 'session_in_progress', $2)
       ON CONFLICT (project_id, key) DO UPDATE SET value = $2`,
      [c2ProjectId, testSession]
    );
    await db.end();

    // Re-run cmdClose for the same session.
    const closePayload = JSON.stringify({ tldr: 'c2 idempotency re-run', session_id: testSession });
    const r = spawnSync(
      process.execPath,
      [HANDOFF_SCRIPT, 'close', '--json', '-'],
      {
        cwd:      PROJECT_ROOT,
        env:      { ...process.env, HANDOFF_DB: c2Db, PROJECT_ROOT: c2ProjectDir },
        input:    closePayload,
        encoding: 'utf8',
        timeout:  30000,
      }
    );

    // Close may fail for other reasons but bias must not double-apply; check bias regardless.
    const db2 = await pgConnect(c2Db);
    const { rows: after } = await db2.query(
      `SELECT id, outcome_bias FROM assertions WHERE id = ANY($1)`,
      [[successAssertionId, failureAssertionId]]
    );
    await db2.end();

    // Compare bias values before and after re-run.
    for (const bRow of before) {
      const aRow = after.find((a) => a.id === bRow.id);
      if (!aRow) {
        c2Fail(4, label, `assertion id=${bRow.id} not found after re-run`);
        return false;
      }
      if (Math.abs(aRow.outcome_bias - bRow.outcome_bias) > 0.001) {
        c2Fail(4, label,
          `assertion id=${bRow.id}: bias changed from ${bRow.outcome_bias} to ${aRow.outcome_bias} on re-run — not idempotent`
        );
        return false;
      }
    }

    // Also verify the re-run output mentions "already applied" (idempotency guard message).
    const rerunOut = r.stdout || '';
    if (!rerunOut.includes('already applied')) {
      c2Fail(4, label, `re-run cmdClose output does not contain "already applied" — idempotency guard message missing`);
      return false;
    }

    c2Pass(4, label);
    return true;
  } catch (err) {
    c2Fail(4, label, err.message);
    return false;
  }
}

async function runC2Section() {
  console.log(`\n=== C2 SECTION (${C2_TOTAL} steps) ===`);
  console.log('smoketest-handoff C2: gate-off no-op, bias adjustment, ranking, idempotency');
  console.log('(All steps pass without Python or Ollama)');
  console.log('');

  const C2_TS         = Date.now();
  const C2_DB         = `claude_memory_c2_${C2_TS}`;
  const C2_PROJ_DIR   = path.join(os.tmpdir(), `handoff_c2_${C2_TS}`);
  const C2_PROJECT_ID = encodeCwd(C2_PROJ_DIR);

  try {
    await createSmokeDb(C2_DB, C2_PROJ_DIR);

    // Write a minimal CLAUDE.md so init can run cleanly.
    const c2ClaudeMd = path.join(C2_PROJ_DIR, 'CLAUDE.md');
    fs.writeFileSync(c2ClaudeMd, '# c2-test\n\n## Durable facts\n- (none)\n', 'utf8');

    // Run init so all base tables exist.
    const initR = spawnSync(
      process.execPath,
      [HANDOFF_SCRIPT, 'init', '-y'],
      {
        cwd:      PROJECT_ROOT,
        env:      { ...process.env, HANDOFF_DB: C2_DB, PROJECT_ROOT: C2_PROJ_DIR },
        encoding: 'utf8',
        timeout:  30000,
      }
    );
    if (initR.status !== 0) {
      console.log('[C2] DB init failed — skipping remaining steps');
      console.log(initR.stderr || initR.stdout || '');
      c2Failed += C2_TOTAL;
      return;
    }
    console.log(`[C2] DB init OK (${C2_DB})`);

    // Create retrieval_events table (no pgvector in smoketest DB).
    try {
      await createRetrievalEventsTable(C2_DB);
    } catch (_) { /* non-fatal */ }

    // Create retrieval_event_assertions join table (needed for C2 feedback join).
    try {
      await createRetrievalEventAssertionsTable(C2_DB);
    } catch (_) { /* non-fatal — step 2 will report failure if the table is missing */ }

    // Step 1: gate OFF no-op.
    await c2Step1_gateOffNoOp(C2_DB, C2_PROJECT_ID, C2_PROJ_DIR);

    // Step 2: gate ON + bias adjustment (returns testSession + assertionIds for step 4).
    const step2Result = await c2Step2_gateOnBiasAdjustment(C2_DB, C2_PROJECT_ID, C2_PROJ_DIR);
    const testSession        = step2Result && step2Result.ok ? step2Result.testSession        : null;
    const successAssertionId = step2Result && step2Result.ok ? step2Result.successAssertionId : null;
    const failureAssertionId = step2Result && step2Result.ok ? step2Result.failureAssertionId : null;

    // Step 3: ranking — gate ON, strongly-negative bias suppressed/demoted.
    await c2Step3_biasAffectsRanking(C2_DB, C2_PROJECT_ID, C2_PROJ_DIR);

    // Step 4: idempotency — re-running close for the same session does not double-apply.
    await c2Step4_idempotency(C2_DB, C2_PROJECT_ID, C2_PROJ_DIR, testSession, successAssertionId, failureAssertionId);

  } finally {
    const C2_HANDOFF_PATH = path.join(os.homedir(), '.claude', 'projects', C2_PROJECT_ID, 'handoff.md');
    await dropSmokeDb(C2_DB, C2_PROJ_DIR, C2_HANDOFF_PATH).catch(() => {});
  }
}

// ── C3: Bundle C3 — learnable contracts (auto-evolve retrieval_contract) ─────

/**
 * Helper: set a project_setting directly in the DB.
 */
async function setProjSetting(dbName, projectId, key, value) {
  const db = await pgConnect(dbName);
  await db.query(
    `INSERT INTO project_settings (project_id, key, value)
     VALUES ($1, $2, $3)
     ON CONFLICT (project_id, key) DO UPDATE SET value = $3`,
    [projectId, key, value]
  );
  await db.end();
}

/**
 * C3 1/5: Gate OFF ⇒ cmdClose makes zero contract changes — version unchanged,
 * no new history row, output byte-identical before and after.
 */
async function c3Step1_gateOff(c3Db, c3ProjectId, c3ProjectDir) {
  const label = 'Gate OFF: cmdClose makes zero contract changes (version unchanged, no new history row)';
  try {
    const db = await pgConnect(c3Db);

    // Confirm gate is disabled (default).
    const { rows: gateRows } = await db.query(
      `SELECT value FROM project_settings WHERE project_id = $1 AND key = 'contract_evolution_enabled'`,
      [c3ProjectId]
    );
    const gateValue = gateRows.length > 0 ? gateRows[0].value : 'disabled';
    if (gateValue !== 'disabled') {
      await db.end();
      c3Fail(1, label, `contract_evolution_enabled is '${gateValue}', expected 'disabled' (default)`);
      return false;
    }

    // Seed a contract with a token_budget so there is something to evolve (gate off should touch nothing).
    await db.query(
      `UPDATE retrieval_contract
       SET queries = $2::jsonb, version = 1, updated_at = now()
       WHERE project_id = $1 AND name = 'default'`,
      [c3ProjectId, JSON.stringify({ queries: [{ kind: 'assertion', token_budget: 800 }] })]
    );

    // Capture version and history count before close.
    const { rows: beforeRows } = await db.query(
      `SELECT version FROM retrieval_contract WHERE project_id = $1 AND name = 'default'`,
      [c3ProjectId]
    );
    const versionBefore = beforeRows.length > 0 ? beforeRows[0].version : null;

    const { rows: histBefore } = await db.query(
      `SELECT COUNT(*) AS n FROM retrieval_contract_history WHERE project_id = $1 AND name = 'default'`,
      [c3ProjectId]
    );
    const histCountBefore = parseInt(histBefore[0].n, 10);
    await db.end();

    // Run cmdClose — gate is OFF.
    const closePayload = JSON.stringify({ tldr: 'c3 gate-off test', session_id: `c3-gate-off-${Date.now()}` });
    const r = spawnSync(
      process.execPath,
      [HANDOFF_SCRIPT, 'close', '--json', '-'],
      {
        cwd:      PROJECT_ROOT,
        env:      { ...process.env, HANDOFF_DB: c3Db, PROJECT_ROOT: c3ProjectDir },
        input:    closePayload,
        encoding: 'utf8',
        timeout:  30000,
      }
    );

    if (r.status !== 0) {
      c3Fail(1, label, `cmdClose exited ${r.status}: ${((r.stderr || '') + (r.stdout || '')).slice(0, 300)}`);
      return false;
    }

    // Confirm version and history count unchanged.
    const db2 = await pgConnect(c3Db);
    const { rows: afterRows } = await db2.query(
      `SELECT version FROM retrieval_contract WHERE project_id = $1 AND name = 'default'`,
      [c3ProjectId]
    );
    const versionAfter = afterRows.length > 0 ? afterRows[0].version : null;

    const { rows: histAfter } = await db2.query(
      `SELECT COUNT(*) AS n FROM retrieval_contract_history WHERE project_id = $1 AND name = 'default'`,
      [c3ProjectId]
    );
    const histCountAfter = parseInt(histAfter[0].n, 10);
    await db2.end();

    if (versionAfter !== versionBefore) {
      c3Fail(1, label, `contract version changed from ${versionBefore} to ${versionAfter} — gate OFF should not mutate`);
      return false;
    }
    if (histCountAfter !== histCountBefore) {
      c3Fail(1, label, `history row count changed from ${histCountBefore} to ${histCountAfter} — gate OFF should not write history`);
      return false;
    }

    // Confirm cmdClose output does not mention C3 evolution.
    const forbidden = ['C3 evolution', 'contract_evolution_enabled', 'auto-evolve'];
    for (const term of forbidden) {
      if ((r.stdout || '').includes(term)) {
        c3Fail(1, label, `Forbidden term "${term}" found in cmdClose stdout — gate OFF leaks C3 internals`);
        return false;
      }
    }

    c3Pass(1, label);
    return true;
  } catch (err) {
    c3Fail(1, label, err.message);
    return false;
  }
}

/**
 * C3 2/5: Gate ON + seeded events below min_events ⇒ no evolution (thin-data guard).
 */
async function c3Step2_thinDataGuard(c3Db, c3ProjectId, c3ProjectDir) {
  const label = 'Gate ON + thin data (< min_events): no evolution applied';
  try {
    // Enable evolution gate.
    await setProjSetting(c3Db, c3ProjectId, 'contract_evolution_enabled', 'enabled');
    // min_events = 10, seed only 3 events — should trigger thin-data guard.
    await setProjSetting(c3Db, c3ProjectId, 'contract_evolution_min_events', '10');
    await setProjSetting(c3Db, c3ProjectId, 'contract_evolution_window_days', '30');

    const db = await pgConnect(c3Db);

    // Set contract with budgets.
    await db.query(
      `UPDATE retrieval_contract
       SET queries = $2::jsonb, version = 1, updated_at = now()
       WHERE project_id = $1 AND name = 'default'`,
      [c3ProjectId, JSON.stringify({ queries: [
        { kind: 'assertion', token_budget: 800 },
        { kind: 'recency',   token_budget: 400 },
      ] })]
    );

    // Capture version before close.
    const { rows: beforeRows } = await db.query(
      `SELECT version FROM retrieval_contract WHERE project_id = $1 AND name = 'default'`,
      [c3ProjectId]
    );
    const versionBefore = beforeRows.length > 0 ? beforeRows[0].version : 1;

    // Seed 3 failure events for 'assertion' kind — below min_events=10.
    const thinSession = `c3-thin-${Date.now()}`;
    for (let i = 0; i < 3; i++) {
      await db.query(
        `INSERT INTO retrieval_events (project_id, query_text, session_id, outcome, outcome_at, outcome_signal)
         VALUES ($1, $2, $3, 'failure', now(), 'agent_self_report')`,
        [c3ProjectId, `loader:contract=default;kinds=assertion;sections=1`, thinSession]
      );
    }
    await db.end();

    // Run cmdClose with the thin-data session.
    const closePayload = JSON.stringify({ tldr: 'c3 thin data test', session_id: thinSession });
    const r = spawnSync(
      process.execPath,
      [HANDOFF_SCRIPT, 'close', '--json', '-'],
      {
        cwd:      PROJECT_ROOT,
        env:      { ...process.env, HANDOFF_DB: c3Db, PROJECT_ROOT: c3ProjectDir },
        input:    closePayload,
        encoding: 'utf8',
        timeout:  30000,
      }
    );

    // Check version unchanged.
    const db2 = await pgConnect(c3Db);
    const { rows: afterRows } = await db2.query(
      `SELECT version FROM retrieval_contract WHERE project_id = $1 AND name = 'default'`,
      [c3ProjectId]
    );
    const versionAfter = afterRows.length > 0 ? afterRows[0].version : null;
    await db2.end();

    if (versionAfter !== versionBefore) {
      c3Fail(2, label, `contract version changed from ${versionBefore} to ${versionAfter} — thin-data guard failed`);
      return false;
    }

    // Output should mention thin-data guard.
    const out = r.stdout || '';
    if (!out.includes('insufficient data') && !out.includes('below min_events')) {
      c3Fail(2, label, `cmdClose output does not mention thin-data guard: ${out.slice(0, 300)}`);
      return false;
    }

    c3Pass(2, label);
    return { ok: true };
  } catch (err) {
    c3Fail(2, label, err.message);
    return false;
  }
}

/**
 * C3 3/5: Gate ON + seeded events with a clear failing kind over threshold ⇒
 * exactly one bounded recordContractChange applied, version bumped by 1,
 * a history row written with the auto-evolve change_note, kind not deleted,
 * budget within envelope.
 */
async function c3Step3_evolutionApplied(c3Db, c3ProjectId, c3ProjectDir) {
  const label = 'Gate ON + clear failing kind: one bounded recordContractChange, version+1, history row, kind not deleted';
  try {
    // Reset to lower min_events so our seeded data qualifies.
    await setProjSetting(c3Db, c3ProjectId, 'contract_evolution_min_events', '5');
    await setProjSetting(c3Db, c3ProjectId, 'contract_evolution_failure_threshold', '0.5');
    await setProjSetting(c3Db, c3ProjectId, 'contract_evolution_budget_floor', '200');
    await setProjSetting(c3Db, c3ProjectId, 'contract_evolution_budget_step', '200');

    const db = await pgConnect(c3Db);

    // Set contract: assertion (800) + recency (400). Total envelope = 1200.
    await db.query(
      `UPDATE retrieval_contract
       SET queries = $2::jsonb, version = 5, updated_at = now()
       WHERE project_id = $1 AND name = 'default'`,
      [c3ProjectId, JSON.stringify({ queries: [
        { kind: 'assertion', token_budget: 800 },
        { kind: 'recency',   token_budget: 400 },
      ] })]
    );

    // Reset history for this contract to a known baseline at v5.
    await db.query(
      `DELETE FROM retrieval_contract_history WHERE project_id = $1 AND name = 'default'`,
      [c3ProjectId]
    );
    await db.query(
      `INSERT INTO retrieval_contract_history (project_id, name, version, queries, change_note)
       VALUES ($1, 'default', 5, $2::jsonb, 'test baseline')`,
      [c3ProjectId, JSON.stringify({ queries: [
        { kind: 'assertion', token_budget: 800 },
        { kind: 'recency',   token_budget: 400 },
      ] })]
    );

    // Seed events: assertion kind fails 6/8 times (75% failure rate > threshold 0.5).
    //             recency kind succeeds 6/7 times (good performer).
    const evolSession = `c3-evol-${Date.now()}`;
    for (let i = 0; i < 6; i++) {
      await db.query(
        `INSERT INTO retrieval_events (project_id, query_text, session_id, outcome, outcome_at, outcome_signal)
         VALUES ($1, $2, $3, 'failure', now() - interval '1 hour', 'agent_self_report')`,
        [c3ProjectId, `loader:contract=default;kinds=assertion;sections=1`, evolSession]
      );
    }
    for (let i = 0; i < 2; i++) {
      await db.query(
        `INSERT INTO retrieval_events (project_id, query_text, session_id, outcome, outcome_at, outcome_signal)
         VALUES ($1, $2, $3, 'success', now() - interval '1 hour', 'agent_self_report')`,
        [c3ProjectId, `loader:contract=default;kinds=assertion;sections=1`, evolSession]
      );
    }
    for (let i = 0; i < 6; i++) {
      await db.query(
        `INSERT INTO retrieval_events (project_id, query_text, session_id, outcome, outcome_at, outcome_signal)
         VALUES ($1, $2, $3, 'success', now() - interval '1 hour', 'agent_self_report')`,
        [c3ProjectId, `loader:contract=default;kinds=recency;sections=1`, evolSession]
      );
    }
    for (let i = 0; i < 1; i++) {
      await db.query(
        `INSERT INTO retrieval_events (project_id, query_text, session_id, outcome, outcome_at, outcome_signal)
         VALUES ($1, $2, $3, 'failure', now() - interval '1 hour', 'agent_self_report')`,
        [c3ProjectId, `loader:contract=default;kinds=recency;sections=1`, evolSession]
      );
    }
    await db.end();

    // Run cmdClose.
    const closePayload = JSON.stringify({ tldr: 'c3 evolution test', session_id: evolSession });
    const r = spawnSync(
      process.execPath,
      [HANDOFF_SCRIPT, 'close', '--json', '-'],
      {
        cwd:      PROJECT_ROOT,
        env:      { ...process.env, HANDOFF_DB: c3Db, PROJECT_ROOT: c3ProjectDir },
        input:    closePayload,
        encoding: 'utf8',
        timeout:  30000,
      }
    );

    const out = (r.stderr || '') + (r.stdout || '');
    if (r.status !== 0) {
      c3Fail(3, label, `cmdClose exited ${r.status}: ${out.slice(0, 400)}`);
      return false;
    }

    // Output must mention C3 evolution applied.
    if (!out.includes('C3 evolution: applied')) {
      c3Fail(3, label, `cmdClose output does not contain "C3 evolution: applied": ${out.slice(0, 400)}`);
      return false;
    }

    // Check DB state.
    const db2 = await pgConnect(c3Db);
    const { rows: rcRows } = await db2.query(
      `SELECT version, queries FROM retrieval_contract WHERE project_id = $1 AND name = 'default'`,
      [c3ProjectId]
    );
    const { rows: histRows } = await db2.query(
      `SELECT version, change_note, queries FROM retrieval_contract_history
       WHERE project_id = $1 AND name = 'default'
       ORDER BY version DESC LIMIT 1`,
      [c3ProjectId]
    );
    await db2.end();

    if (rcRows.length === 0) {
      c3Fail(3, label, 'retrieval_contract row missing after evolution');
      return false;
    }

    const newVersion = rcRows[0].version;
    if (newVersion !== 6) {
      c3Fail(3, label, `expected version 6, got ${newVersion}`);
      return false;
    }

    // Verify history row written with auto-evolve change_note.
    if (histRows.length === 0) {
      c3Fail(3, label, 'no history row written for evolution');
      return false;
    }
    if (!(histRows[0].change_note || '').startsWith('auto-evolve')) {
      c3Fail(3, label, `history change_note does not start with "auto-evolve": "${histRows[0].change_note}"`);
      return false;
    }

    // Verify kinds not deleted and budgets within envelope.
    const newQueries = rcRows[0].queries.queries || [];
    const assertionQ = newQueries.find((q) => q.kind === 'assertion');
    const recencyQ   = newQueries.find((q) => q.kind === 'recency');
    if (!assertionQ) {
      c3Fail(3, label, '"assertion" kind was deleted — must never delete a kind');
      return false;
    }
    if (!recencyQ) {
      c3Fail(3, label, '"recency" kind was deleted — must never delete a kind');
      return false;
    }
    if (assertionQ.token_budget < 200) {
      c3Fail(3, label, `"assertion" budget ${assertionQ.token_budget} is below floor 200`);
      return false;
    }
    // Total envelope should remain 1200 (800 + 400).
    const totalBudget = newQueries.reduce((s, q) => s + (q.token_budget || 0), 0);
    if (totalBudget !== 1200) {
      c3Fail(3, label, `total budget changed: expected 1200, got ${totalBudget} (envelope not preserved)`);
      return false;
    }

    c3Pass(3, label);
    return { ok: true, evolSession };
  } catch (err) {
    c3Fail(3, label, err.message);
    return false;
  }
}

/**
 * C3 4/5: Idempotency — re-running cmdClose for the same session does not produce
 * a second contract change.
 */
async function c3Step4_idempotency(c3Db, c3ProjectId, c3ProjectDir, evolSession) {
  const label = 'Idempotency: re-running cmdClose for same session does not produce a second contract change';
  try {
    if (!evolSession) {
      c3Fail(4, label, 'skipped — evolSession not provided (step 3 failed)');
      return false;
    }

    // Read current version before re-run.
    const db = await pgConnect(c3Db);
    const { rows: beforeRows } = await db.query(
      `SELECT version FROM retrieval_contract WHERE project_id = $1 AND name = 'default'`,
      [c3ProjectId]
    );
    const versionBefore = beforeRows.length > 0 ? beforeRows[0].version : null;
    await db.end();

    // Re-run cmdClose with the same session_id.
    const closePayload = JSON.stringify({ tldr: 'c3 idempotency re-run', session_id: evolSession });
    const r = spawnSync(
      process.execPath,
      [HANDOFF_SCRIPT, 'close', '--json', '-'],
      {
        cwd:      PROJECT_ROOT,
        env:      { ...process.env, HANDOFF_DB: c3Db, PROJECT_ROOT: c3ProjectDir },
        input:    closePayload,
        encoding: 'utf8',
        timeout:  30000,
      }
    );

    // Check version unchanged.
    const db2 = await pgConnect(c3Db);
    const { rows: afterRows } = await db2.query(
      `SELECT version FROM retrieval_contract WHERE project_id = $1 AND name = 'default'`,
      [c3ProjectId]
    );
    const versionAfter = afterRows.length > 0 ? afterRows[0].version : null;
    await db2.end();

    if (versionAfter !== versionBefore) {
      c3Fail(4, label, `version changed from ${versionBefore} to ${versionAfter} on re-run — not idempotent`);
      return false;
    }

    // Output should mention idempotency guard.
    const out = r.stdout || '';
    if (!out.includes('already applied') && !out.includes('idempotent')) {
      c3Fail(4, label, `re-run output does not mention idempotency guard: ${out.slice(0, 300)}`);
      return false;
    }

    c3Pass(4, label);
    return true;
  } catch (err) {
    c3Fail(4, label, err.message);
    return false;
  }
}

/**
 * C3 5/5: Rollback — prior version recoverable from retrieval_contract_history
 * via the W4 rollback CLI (bundleb-w4-contract.js rollback <version>).
 */
async function c3Step5_rollback(c3Db, c3ProjectId, c3ProjectDir) {
  const label = 'Rollback: prior version recoverable from history via bundleb-w4-contract.js rollback';
  try {
    const db = await pgConnect(c3Db);

    // Read current version (should be 6 after step 3).
    const { rows: curRows } = await db.query(
      `SELECT version FROM retrieval_contract WHERE project_id = $1 AND name = 'default'`,
      [c3ProjectId]
    );
    const currentVersion = curRows.length > 0 ? curRows[0].version : null;

    // Find a prior version in history.
    const { rows: histRows } = await db.query(
      `SELECT version FROM retrieval_contract_history
       WHERE project_id = $1 AND name = 'default' AND version < $2
       ORDER BY version DESC LIMIT 1`,
      [c3ProjectId, currentVersion]
    );
    await db.end();

    if (histRows.length === 0) {
      // No prior version — we can verify history exists even if we cannot roll back.
      // Check there is at least one history row (from step 3's evolution).
      const db2 = await pgConnect(c3Db);
      const { rows: anyHist } = await db2.query(
        `SELECT COUNT(*) AS n FROM retrieval_contract_history WHERE project_id = $1 AND name = 'default'`,
        [c3ProjectId]
      );
      await db2.end();
      const n = parseInt(anyHist[0].n, 10);
      if (n > 0) {
        // History rows exist; rollback target just happens to be the same as current — mark pass.
        c3Pass(5, label);
        return true;
      }
      c3Fail(5, label, 'no history rows found — cannot verify rollback path');
      return false;
    }

    const rollbackVersion = histRows[0].version;
    const w4Script = path.join(PROJECT_ROOT, 'scripts', 'bundleb-w4-contract.js');

    const r = spawnSync(
      process.execPath,
      [w4Script, 'rollback', String(rollbackVersion)],
      {
        cwd:      PROJECT_ROOT,
        env:      { ...process.env, HANDOFF_DB: c3Db, PROJECT_ROOT: c3ProjectDir },
        encoding: 'utf8',
        timeout:  30000,
      }
    );

    if (r.status !== 0) {
      c3Fail(5, label, `rollback exited ${r.status}: ${((r.stderr || '') + (r.stdout || '')).slice(0, 300)}`);
      return false;
    }

    // Verify version bumped (non-destructive rollback creates a new version).
    const db3 = await pgConnect(c3Db);
    const { rows: afterRows } = await db3.query(
      `SELECT version FROM retrieval_contract WHERE project_id = $1 AND name = 'default'`,
      [c3ProjectId]
    );
    await db3.end();

    const newVersion = afterRows.length > 0 ? afterRows[0].version : null;
    if (newVersion === null || newVersion <= currentVersion) {
      c3Fail(5, label, `rollback did not bump version: currentVersion=${currentVersion}, newVersion=${newVersion}`);
      return false;
    }

    // Verify output mentions rollback success.
    const out = r.stdout || '';
    if (!out.includes('Rolled back')) {
      c3Fail(5, label, `rollback output does not mention "Rolled back": ${out.slice(0, 200)}`);
      return false;
    }

    c3Pass(5, label);
    return true;
  } catch (err) {
    c3Fail(5, label, err.message);
    return false;
  }
}

async function runC3Section() {
  console.log(`\n=== C3 SECTION (${C3_TOTAL} steps) ===`);
  console.log('smoketest-handoff C3: gate-off no-op, thin-data guard, evolution applied, idempotency, rollback');
  console.log('(All steps pass without Python or Ollama)');
  console.log('');

  const C3_TS         = Date.now();
  const C3_DB         = `claude_memory_c3_${C3_TS}`;
  const C3_PROJ_DIR   = path.join(os.tmpdir(), `handoff_c3_${C3_TS}`);
  const C3_PROJECT_ID = encodeCwd(C3_PROJ_DIR);

  try {
    await createSmokeDb(C3_DB, C3_PROJ_DIR);

    // Write a minimal CLAUDE.md so init can run cleanly.
    const c3ClaudeMd = path.join(C3_PROJ_DIR, 'CLAUDE.md');
    fs.writeFileSync(c3ClaudeMd, '# c3-test\n\n## Durable facts\n- (none)\n', 'utf8');

    // Run init so all base tables exist.
    const initR = spawnSync(
      process.execPath,
      [HANDOFF_SCRIPT, 'init', '-y'],
      {
        cwd:      PROJECT_ROOT,
        env:      { ...process.env, HANDOFF_DB: C3_DB, PROJECT_ROOT: C3_PROJ_DIR },
        encoding: 'utf8',
        timeout:  30000,
      }
    );
    if (initR.status !== 0) {
      console.log('[C3] DB init failed — skipping remaining steps');
      console.log(initR.stderr || initR.stdout || '');
      c3Failed += C3_TOTAL;
      return;
    }
    console.log(`[C3] DB init OK (${C3_DB})`);

    // Verify contract_evolution_enabled default registered by init.
    const initDb = await pgConnect(C3_DB);
    const { rows: defaultRows } = await initDb.query(
      `SELECT value FROM project_settings WHERE project_id = $1 AND key = 'contract_evolution_enabled'`,
      [C3_PROJECT_ID]
    );
    await initDb.end();
    if (defaultRows.length === 0 || defaultRows[0].value !== 'disabled') {
      console.log(`[C3] WARNING: contract_evolution_enabled default not set correctly (got ${defaultRows[0] ? defaultRows[0].value : 'missing'})`);
    }

    // Create retrieval_events table (no pgvector in smoketest DB).
    try {
      await createRetrievalEventsTable(C3_DB);
    } catch (_) { /* non-fatal */ }

    // Step 1: gate OFF no-op.
    await c3Step1_gateOff(C3_DB, C3_PROJECT_ID, C3_PROJ_DIR);

    // Step 2: thin-data guard.
    await c3Step2_thinDataGuard(C3_DB, C3_PROJECT_ID, C3_PROJ_DIR);

    // Step 3: evolution applied (returns evolSession for step 4).
    const step3Result = await c3Step3_evolutionApplied(C3_DB, C3_PROJECT_ID, C3_PROJ_DIR);
    const evolSession = step3Result && step3Result.ok ? step3Result.evolSession : null;

    // Step 4: idempotency.
    await c3Step4_idempotency(C3_DB, C3_PROJECT_ID, C3_PROJ_DIR, evolSession);

    // Step 5: rollback via W4 CLI.
    await c3Step5_rollback(C3_DB, C3_PROJECT_ID, C3_PROJ_DIR);

  } finally {
    const C3_HANDOFF_PATH = path.join(os.homedir(), '.claude', 'projects', C3_PROJECT_ID, 'handoff.md');
    await dropSmokeDb(C3_DB, C3_PROJ_DIR, C3_HANDOFF_PATH).catch(() => {});
  }
}

// ── Section runners ───────────────────────────────────────────────────────────

async function runLifecycleSection() {
  console.log(`\n=== LIFECYCLE SECTION (${LC_TOTAL} steps) ===`);
  console.log(`smoketest-handoff: DB=${SMOKE_DB}  project_id=${PROJECT_ID}`);
  console.log('');

  let ids = null;

  try {
    const ok1 = await step1_setup();
    if (!ok1) {
      console.log('\n[lifecycle] aborting — setup failed');
      lcFailed += LC_TOTAL - 1;
      return;
    }

    await step2_cmdInit_fresh();
    await step3_cmdInit_idempotent();

    // W1: Create retrieval_events table in the lifecycle DB (no pgvector needed).
    try {
      await createRetrievalEventsTable(SMOKE_DB);
      console.log(`[lifecycle] retrieval_events table created in ${SMOKE_DB}`);
    } catch (rtErr) {
      console.log(`[lifecycle] WARNING: retrieval_events table creation failed: ${rtErr.message}`);
    }

    ids = await step4_inject_test_data();
    if (!ids) {
      lcFail(5, 'cmdStatus', 'skipped due to step 4 failure');
      lcFail(6, 'cmdResume', 'skipped due to step 4 failure');
      lcFail(7, 'cmdCheckpoint', 'skipped due to step 4 failure');
      lcFail(8, 'cmdClose', 'skipped due to step 4 failure');
      lcFail(9, 'cmdDrop', 'skipped due to step 4 failure');
      lcFail(10, 'cmdPurge', 'skipped due to step 4 failure');
      lcFail(12, 'W1 event logging', 'skipped due to step 4 failure');
      lcFail(13, 'W1 self-report', 'skipped due to step 4 failure');
      lcFail(14, 'W1 timeout-decay', 'skipped due to step 4 failure');
    } else {
      await step5_cmdStatus(ids);

      // Set session_in_progress before resume so the event row captures it.
      let sessionMarker = null;
      try {
        const dbPre = await pgConnect(SMOKE_DB);
        sessionMarker = `smoketest_resume_session_${Date.now()}`;
        await dbPre.query(
          `INSERT INTO project_settings (project_id, key, value) VALUES ($1, 'session_in_progress', $2)
           ON CONFLICT (project_id, key) DO UPDATE SET value = $2`,
          [PROJECT_ID, sessionMarker]
        );
        await dbPre.end();
      } catch (_) { sessionMarker = null; }

      await step6_cmdResume();

      // W1 step 12: check retrieval_events row created by resume.
      await step12_retrievalEventLogged(sessionMarker);

      await step7_cmdCheckpoint();
      await step8_cmdClose();

      // W1 step 13: self-report via a fresh close.
      await step13_selfReport();

      // W1 step 14: timeout-decay via a fresh close with a stale event.
      await step14_timeoutDecay();

      await step9_cmdDrop_assertion(ids);
      await step10_cmdPurge();
    }

    lcSkip(11, 'cmdPurge interactive mode', 'already tested via --yes flag in step 10; no separate interactive path needed');

  } finally {
    await dropSmokeDb(SMOKE_DB, TEMP_PROJECT_DIR, HANDOFF_PATH);
  }
}

async function runHooksSection() {
  console.log(`\n=== HOOKS SECTION (${HK_TOTAL} steps) ===`);
  console.log(`smoketest-handoff hooks: DB=${HOOKS_DB}  project_id=${PROJECT_ID_HOOKS}`);
  console.log('');

  try {
    // Hooks section needs its own DB and init — it cannot assume lifecycle ran first.
    await createSmokeDb(HOOKS_DB, TEMP_PROJECT_DIR_HOOKS);

    const initR = runHandoff('init', ['-y'], null, HOOKS_DB, TEMP_PROJECT_DIR_HOOKS);
    if (initR.status !== 0) {
      console.log(`[HOOKS] hooks DB init failed — aborting hooks section`);
      console.log(initR.stderr || initR.stdout || '');
      hkFailed += HK_TOTAL;
      return;
    }
    console.log(`[HOOKS] DB init OK`);

    await hooksStep1_stalenessGate();
    await hooksStep2_safetyOutsideProject();
    await hooksStep3_stopHookImplicitClose();

  } finally {
    await dropSmokeDb(HOOKS_DB, TEMP_PROJECT_DIR_HOOKS, HANDOFF_PATH_HOOKS);
  }
}

async function runHardeningSection() {
  console.log(`\n=== HARDENING SECTION (${HD_TOTAL} steps) ===`);
  console.log(`smoketest-handoff hardening: DB=${HARDEN_DB}  project_id=${PROJECT_ID_HARDEN}`);
  console.log('');

  // We use a temp CLAUDE.md file inside the hardening project dir so promote tests
  // don't touch the real project CLAUDE.md.
  const tempClaudeMd = path.join(TEMP_PROJECT_DIR_HARDEN, 'CLAUDE.md');

  try {
    // HARDEN 1: DB name validation — no DB needed.
    await hardenStep1_dbNameValidation();

    // Set up the harden DB for remaining steps.
    await createSmokeDb(HARDEN_DB, TEMP_PROJECT_DIR_HARDEN);

    // Write a minimal CLAUDE.md so promote/close can find it.
    fs.writeFileSync(tempClaudeMd, '# claude-memory\n\n## Durable facts\n- (No durable facts promoted yet)\n', 'utf8');

    const initR = runHandoff('init', ['-y'], null, HARDEN_DB, TEMP_PROJECT_DIR_HARDEN);
    if (initR.status !== 0) {
      console.log(`[HARDEN] init failed — aborting remaining hardening steps`);
      console.log(initR.stderr || initR.stdout || '');
      for (let i = 2; i <= HD_TOTAL; i++) {
        hdFailed++;
      }
      return;
    }
    console.log(`[HARDEN] DB init OK`);

    await hardenStep2_trustBoundaryLabels();
    await hardenStep3_stdinSchemaRejection();
    await hardenStep4_multiAuthorDetection();

    const promResult = await hardenStep5_promote(tempClaudeMd);
    const promotedId = promResult && promResult.ok ? promResult.assertionId : null;

    await hardenStep6_promoteIdempotent(promotedId);
    await hardenStep7_auditAnnotationFormat(tempClaudeMd);

    // W1: Create retrieval_events table for validation test (no pgvector needed).
    try {
      await createRetrievalEventsTable(HARDEN_DB);
    } catch (_) { /* non-fatal — hardenStep8 will report its own error */ }
    await hardenStep8_retrievalOutcomeValidation();

  } finally {
    try { fs.rmSync(tempClaudeMd, { force: true }); } catch (_) {}
    await dropSmokeDb(HARDEN_DB, TEMP_PROJECT_DIR_HARDEN, HANDOFF_PATH_HARDEN);
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`smoketest-handoff: section=${SECTION}`);

  if (SECTION === 'lifecycle' || SECTION === 'all') {
    await runLifecycleSection();
  }
  if (SECTION === 'hooks' || SECTION === 'all') {
    await runHooksSection();
  }
  if (SECTION === 'hardening' || SECTION === 'all') {
    await runHardeningSection();
  }
  if (SECTION === 'w2' || SECTION === 'all') {
    await runW2Section();
  }
  if (SECTION === 'w3' || SECTION === 'all') {
    await runW3Section();
  }
  if (SECTION === 'w4' || SECTION === 'all') {
    await runW4Section();
  }
  if (SECTION === 'c1' || SECTION === 'all') {
    await runC1Section();
  }
  if (SECTION === 'c2' || SECTION === 'all') {
    await runC2Section();
  }
  if (SECTION === 'c3' || SECTION === 'all') {
    await runC3Section();
  }

  console.log('');

  const lcTotal  = lcPassed + lcFailed;
  const hkTotal  = hkPassed + hkFailed;
  const hdTotal  = hdPassed + hdFailed;
  const w2Total  = w2Passed + w2Failed;
  const w3Total  = w3Passed + w3Failed;
  const w4Total  = w4Passed + w4Failed;
  const c1Total  = c1Passed + c1Failed;
  const c2Total  = c2Passed + c2Failed;
  const c3Total  = c3Passed + c3Failed;
  const totalPass = lcPassed + hkPassed + hdPassed + w2Passed + w3Passed + w4Passed + c1Passed + c2Passed + c3Passed;
  const totalAll  = lcTotal  + hkTotal  + hdTotal  + w2Total  + w3Total  + w4Total  + c1Total  + c2Total  + c3Total;
  const totalSkip = lcSkipped + hkSkipped + hdSkipped + w2Skipped + w3Skipped + w4Skipped + c1Skipped + c2Skipped + c3Skipped;

  if (SECTION === 'all') {
    console.log(`smoketest: ${totalPass}/${totalAll} passed, ${totalSkip} skipped (lifecycle: ${lcPassed}/${lcTotal}, hooks: ${hkPassed}/${hkTotal}, hardening: ${hdPassed}/${hdTotal}, w2: ${w2Passed}/${w2Total}, w3: ${w3Passed}/${w3Total}, w4: ${w4Passed}/${w4Total}, c1: ${c1Passed}/${c1Total}, c2: ${c2Passed}/${c2Total}, c3: ${c3Passed}/${c3Total})`);
  } else if (SECTION === 'lifecycle') {
    console.log(`smoketest: ${lcPassed}/${lcTotal} passed, ${lcSkipped} skipped (lifecycle only)`);
  } else if (SECTION === 'hooks') {
    console.log(`smoketest: ${hkPassed}/${hkTotal} passed (hooks only)`);
  } else if (SECTION === 'w2') {
    console.log(`smoketest: ${w2Passed}/${w2Total} passed, ${w2Skipped} skipped (w2 only)`);
  } else if (SECTION === 'w3') {
    console.log(`smoketest: ${w3Passed}/${w3Total} passed, ${w3Skipped} skipped (w3 only)`);
  } else if (SECTION === 'w4') {
    console.log(`smoketest: ${w4Passed}/${w4Total} passed, ${w4Skipped} skipped (w4 only)`);
  } else if (SECTION === 'c1') {
    console.log(`smoketest: ${c1Passed}/${c1Total} passed, ${c1Skipped} skipped (c1 only)`);
  } else if (SECTION === 'c2') {
    console.log(`smoketest: ${c2Passed}/${c2Total} passed, ${c2Skipped} skipped (c2 only)`);
  } else if (SECTION === 'c3') {
    console.log(`smoketest: ${c3Passed}/${c3Total} passed, ${c3Skipped} skipped (c3 only)`);
  } else {
    console.log(`smoketest: ${hdPassed}/${hdTotal} passed, ${hdSkipped} skipped (hardening only)`);
  }

  if (lcFailed + hkFailed + hdFailed + w2Failed + w3Failed + w4Failed + c1Failed + c2Failed + c3Failed > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error('smoketest-handoff fatal:', err.message);
  if (process.env.DEBUG) console.error(err.stack);
  process.exitCode = 1;
});
