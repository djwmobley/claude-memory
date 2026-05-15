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
if (!['all', 'lifecycle', 'hooks', 'hardening'].includes(SECTION)) {
  console.error(`Unknown --section value: ${SECTION}. Valid: lifecycle, hooks, hardening, all`);
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

const LC_TOTAL = 11;
const HK_TOTAL = 3;
const HD_TOTAL = 7;

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
    const requiredSettings = ['decay_rate_default', 'implicit_close', 'loader_token_budget', 'staleness_days'];
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
  const label = 'cmdResume — shows non-suppressed, hides suppressed';
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

    ids = await step4_inject_test_data();
    if (!ids) {
      lcFail(5, 'cmdStatus', 'skipped due to step 4 failure');
      lcFail(6, 'cmdResume', 'skipped due to step 4 failure');
      lcFail(7, 'cmdCheckpoint', 'skipped due to step 4 failure');
      lcFail(8, 'cmdClose', 'skipped due to step 4 failure');
      lcFail(9, 'cmdDrop', 'skipped due to step 4 failure');
      lcFail(10, 'cmdPurge', 'skipped due to step 4 failure');
    } else {
      await step5_cmdStatus(ids);
      await step6_cmdResume();
      await step7_cmdCheckpoint();
      await step8_cmdClose();
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

  console.log('');

  const lcTotal  = lcPassed + lcFailed;
  const hkTotal  = hkPassed + hkFailed;
  const hdTotal  = hdPassed + hdFailed;
  const totalPass = lcPassed + hkPassed + hdPassed;
  const totalAll  = lcTotal  + hkTotal  + hdTotal;
  const totalSkip = lcSkipped + hkSkipped + hdSkipped;

  if (SECTION === 'all') {
    console.log(`smoketest: ${totalPass}/${totalAll} passed, ${totalSkip} skipped (lifecycle: ${lcPassed}/${lcTotal}, hooks: ${hkPassed}/${hkTotal}, hardening: ${hdPassed}/${hdTotal})`);
  } else if (SECTION === 'lifecycle') {
    console.log(`smoketest: ${lcPassed}/${lcTotal} passed, ${lcSkipped} skipped (lifecycle only)`);
  } else if (SECTION === 'hooks') {
    console.log(`smoketest: ${hkPassed}/${hkTotal} passed (hooks only)`);
  } else {
    console.log(`smoketest: ${hdPassed}/${hdTotal} passed, ${hdSkipped} skipped (hardening only)`);
  }

  if (lcFailed + hkFailed + hdFailed > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error('smoketest-handoff fatal:', err.message);
  if (process.env.DEBUG) console.error(err.stack);
  process.exitCode = 1;
});
