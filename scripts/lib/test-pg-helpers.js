'use strict';

/**
 * test-pg-helpers.js — Shared PG test-harness helpers for claude-memory test scripts.
 *
 * Provides connection/setup/teardown/CLI-spawn helpers that were previously
 * copy-pasted across test-l0-consolidation-gate.js, test-l2-consolidation-gate.js,
 * test-l3-reality-checks.js, test-l4-degraded-close.js, test-resurrect.js, and
 * test-operator-pin.js.
 *
 * All helpers are extracted verbatim (or trivially reconciled via optional
 * parameters with matching defaults) from the originals — no behavioral changes.
 */

const { spawnSync } = require('child_process');
const fs            = require('fs');
const path          = require('path');
const { Client }    = require('pg');
const { encodeCwd } = require('./encoded-cwd');
const { findProjectRootByMarker, readMarker } = require('./project-marker');
const { resolveHandoffMdPath }                = require('./handoff-paths');

const PROJECT_ROOT   = path.resolve(__dirname, '..', '..');
const HANDOFF_SCRIPT = path.join(PROJECT_ROOT, 'scripts', 'handoff.js');

// ── DB connection ──────────────────────────────────────────────────────────────

/**
 * Open a Postgres client connection.
 * @param {string} [database='postgres'] — target database name
 * @returns {Promise<Client>}
 */
async function pgConnect(database = 'postgres') {
  const cfg = {
    host:     process.env.PGHOST     || 'localhost',
    port:     parseInt(process.env.PGPORT || '5432', 10),
    user:     process.env.PGUSER     || 'postgres',
    password: process.env.PGPASSWORD || 'postgres',
    database,
  };
  const client = new Client(cfg);
  await client.connect();
  return client;
}

/**
 * cm#224 follow-up (PR #225 CI-red finding, bisected to 6e76e11): every
 * scratch DB this shared helper creates goes through this ONE call so
 * ensureSchemaCurrent's pgvector-gated-column check (assertions.embedding,
 * decisions.embedding — see scripts/handoff.js's checkPgvectorGatedObjects)
 * sees a genuinely non-degraded fixture on any Postgres that actually HAS
 * pgvector available (every CI runner uses the pgvector/pgvector:pg16
 * image, which provides the extension but does not auto-install it into
 * every fresh database — each DB still needs its own CREATE EXTENSION).
 * Guarded: a Postgres with no pgvector at all logs ONE line and continues
 * — that DB is then a genuine pgvector-absent fixture, and the
 * gated-column check legitimately reports 'degraded' for it (this is the
 * correct, intended behavior for that case, not a bug to work around).
 *
 * @param {string} dbName — target database (already created, may not exist
 *   yet on a caller error — connection failure propagates, not swallowed)
 */
async function ensureVectorExtension(dbName) {
  const db = await pgConnect(dbName);
  try {
    await db.query('CREATE EXTENSION IF NOT EXISTS vector');
  } catch (err) {
    console.log(`[test-pg-helpers] CREATE EXTENSION vector skipped on "${dbName}" -- pgvector not installed on this Postgres (${err.message}); any pgvector-gated column check against this DB will legitimately report degraded.`);
  } finally {
    await db.end();
  }
}

// ── DB lifecycle — quiet (L0/L2/L3/L4 style) ─────────────────────────────────

/**
 * Create a throwaway DB and project directory (quiet — allows pre-existing DB).
 * Used by test-l0, test-l2, test-l3, test-l4.
 */
async function createDb(dbName, projectDir) {
  const sysDb = await pgConnect('postgres');
  const exists = await sysDb.query('SELECT 1 FROM pg_database WHERE datname = $1', [dbName]);
  if (exists.rows.length === 0) {
    await sysDb.query(`CREATE DATABASE "${dbName}"`);
  }
  await sysDb.end();
  await ensureVectorExtension(dbName);
  fs.mkdirSync(projectDir, { recursive: true });
}

/**
 * Drop a throwaway DB and remove the project directory (quiet — swallows errors).
 * Used by test-l0, test-l2, test-l3, test-l4.
 */
async function dropDb(dbName, projectDir) {
  if (fs.existsSync(projectDir)) {
    try { fs.rmSync(projectDir, { recursive: true, force: true }); } catch (_) {}
  }
  let sysDb = null;
  try {
    sysDb = await pgConnect('postgres');
    await sysDb.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()`,
      [dbName]
    );
    await sysDb.query(`DROP DATABASE IF EXISTS "${dbName}"`);
  } catch (_) {
  } finally {
    if (sysDb) { try { await sysDb.end(); } catch (_) {} }
  }
}

// ── DB lifecycle — strict (resurrect / operator-pin style) ────────────────────

/**
 * Create a throwaway DB and project directory (strict — throws on naming collision).
 * Used by test-resurrect, test-operator-pin.
 */
async function createTestDb(dbName, projectDir) {
  const sysDb = await pgConnect('postgres');
  const exists = await sysDb.query('SELECT 1 FROM pg_database WHERE datname = $1', [dbName]);
  if (exists.rows.length > 0) {
    await sysDb.end();
    throw new Error(`DB ${dbName} already exists — naming collision`);
  }
  await sysDb.query(`CREATE DATABASE "${dbName}"`);
  await sysDb.end();
  await ensureVectorExtension(dbName);
  fs.mkdirSync(projectDir, { recursive: true });
}

/**
 * Drop a throwaway DB and remove the project directory (with teardown log line).
 * Used by test-resurrect, test-operator-pin.
 */
async function dropTestDb(dbName, projectDir) {
  try {
    if (fs.existsSync(projectDir)) fs.rmSync(projectDir, { recursive: true, force: true });
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
    console.log(`[TEARDOWN] Dropped DB: ${dbName}`);
  } catch (err) {
    if (sysDb) { try { await sysDb.end(); } catch (_) {} }
    console.error(`[TEARDOWN] WARNING: cleanup failed — ${err.message}`);
  }
}

// ── Schema application ────────────────────────────────────────────────────────

/**
 * Apply handoff-core-schema.sql to a freshly created DB.
 * Used by test-resurrect, test-operator-pin.
 */
async function applySchema(dbName) {
  const schemaFile = path.join(PROJECT_ROOT, 'scripts', 'sql', 'handoff-core-schema.sql');
  const sql = fs.readFileSync(schemaFile, 'utf8');
  const db  = await pgConnect(dbName);
  await db.query('BEGIN');
  await db.query(sql);
  await db.query('COMMIT');
  await db.end();
}

// ── Settings helpers ──────────────────────────────────────────────────────────

/**
 * Upsert a project_settings key/value pair.
 */
async function setSetting(db, projectId, key, value) {
  await db.query(
    `INSERT INTO project_settings (project_id, key, value) VALUES ($1, $2, $3)
     ON CONFLICT (project_id, key) DO UPDATE SET value = EXCLUDED.value`,
    [projectId, key, String(value)]
  );
}

/**
 * Query all project_settings rows where key LIKE pattern.
 * @returns {Promise<Array<{key: string, value: string}>>}
 */
async function getSettingsLike(db, projectId, pattern) {
  const { rows } = await db.query(
    `SELECT key, value FROM project_settings WHERE project_id = $1 AND key LIKE $2 ORDER BY key`,
    [projectId, pattern]
  );
  return rows;
}

/**
 * Upsert the default retrieval_contract queries.
 * Used by test-resurrect.
 */
async function setContract(db, projectId, queries) {
  await db.query(
    `UPDATE retrieval_contract SET queries = $2::jsonb, updated_at = now()
     WHERE project_id = $1 AND name = 'default'`,
    [projectId, JSON.stringify({ queries })]
  );
}

// ── Subprocess helpers ────────────────────────────────────────────────────────

/**
 * Build the env object for handoff.js subprocesses.
 */
function makeEnv(db, projectDir, extraEnv = {}) {
  return {
    ...process.env,
    HANDOFF_DB:   db,
    PROJECT_ROOT: projectDir,
    ...extraEnv,
  };
}

/**
 * Spawn a handoff.js subcommand.
 * Signature matches L0/L2/L3 usage (no module-level defaults for db/projectDir).
 */
function runHandoff(sub, extraArgs = [], stdin = null, db, projectDir, extraEnv = {}) {
  const opts = {
    cwd:      PROJECT_ROOT,
    env:      makeEnv(db, projectDir, extraEnv),
    encoding: 'utf8',
    timeout:  30000,
  };
  if (stdin !== null) {
    opts.input = stdin;
  }
  return spawnSync(process.execPath, [HANDOFF_SCRIPT, sub, ...extraArgs], opts);
}

/**
 * Spawn handoff.js close with a JSON payload on stdin.
 * Signature matches L0/L2/L3 usage.
 */
function runClose(payload, db, projectDir, extraEnv = {}) {
  return runHandoff('close', ['--json', '-'], JSON.stringify(payload), db, projectDir, extraEnv);
}

/**
 * Spawn handoff.js close accepting a payload with a longer timeout (60 s).
 * Used by test-resurrect which uses EMBED_SKIP and a longer timeout.
 */
function runHandoffLong(sub, extraArgs = [], stdin = null, dbName, projectDir, extraEnv = {}) {
  const env = {
    ...process.env,
    HANDOFF_DB:   dbName,
    PROJECT_ROOT: projectDir,
    EMBED_SKIP:   process.env.EMBED_SKIP || '1',
    ...extraEnv,
  };
  const opts = {
    cwd:      PROJECT_ROOT,
    env,
    encoding: 'utf8',
    timeout:  60000,
  };
  if (stdin !== null) opts.input = stdin;
  return spawnSync(process.execPath, [HANDOFF_SCRIPT, sub, ...extraArgs], opts);
}

// ── Project ID helpers ────────────────────────────────────────────────────────
//
// resolveProjectId and resolveHandoffMdPath MUST import the real implementations
// (project-marker.js / handoff-paths.js) rather than restate them — a hand-rolled
// duplicate here is exactly the drift risk #135 removed (it hardcoded the legacy
// '.claude-memory' marker name only, with no dual-marker/HANDOFF_BASE_DIR support).

/**
 * Read the project_id from the project marker (new name, or legacy
 * .claude-memory), or fall back to encodeCwd.
 */
function resolveProjectId(projectDir) {
  const markerRoot = findProjectRootByMarker(projectDir);
  if (markerRoot) {
    const marker = readMarker(markerRoot);
    if (marker) return marker.uuid;
  }
  return encodeCwd(projectDir);
}

/**
 * Remove the handoff.md directory for a project (cleanup helper).
 */
function cleanupHandoffMd(projectId) {
  const handoffDir = path.dirname(resolveHandoffMdPath(projectId));
  if (fs.existsSync(handoffDir)) {
    try { fs.rmSync(handoffDir, { recursive: true, force: true }); } catch (_) {}
  }
}

// ── Project bootstrap ─────────────────────────────────────────────────────────

/**
 * Run handoff init in a throwaway DB / project dir, return the resolved project ID.
 * Used by test-l0, test-l2, test-l3, test-l4.
 */
async function setupProject(dbName, projectDir) {
  const r = runHandoff('init', ['-y'], null, dbName, projectDir);
  if (r.status !== 0) {
    throw new Error(`cmdInit failed: ${r.stderr || r.stdout}`);
  }
  return resolveProjectId(projectDir);
}

module.exports = {
  // Canonical encodeCwd (re-exported from ./encoded-cwd for convenience)
  encodeCwd,
  // DB connection
  pgConnect,
  // DB lifecycle — quiet (L0/L2/L3/L4)
  createDb,
  dropDb,
  // pgvector — cm#224 follow-up: available for any test that creates its own
  // scratch DB by a mechanism OTHER than createDb/createTestDb above.
  ensureVectorExtension,
  // DB lifecycle — strict with teardown log (resurrect/operator-pin)
  createTestDb,
  dropTestDb,
  // Schema
  applySchema,
  // Settings
  setSetting,
  getSettingsLike,
  setContract,
  // Subprocess
  makeEnv,
  runHandoff,
  runClose,
  runHandoffLong,
  // Project ID
  resolveProjectId,
  resolveHandoffMdPath,
  cleanupHandoffMd,
  setupProject,
};
