'use strict';

/**
 * project-identity.js — Marker-borne project identity resolution + one-shot migration.
 *
 * This module implements the FIRST internal-check step (ensureProjectIdentity), which
 * MUST run before ensureSchemaCurrent in both cmdLoaderLoad and cmdClose call sites.
 *
 * Resolution logic (four-state):
 *   STATE 1 — MIGRATED (steady state):
 *     Marker present AND rows already under marker UUID → no-op.
 *     Added cost: one upward marker probe + one small file read. No DB write.
 *
 *   STATE 2 — MARKER PRESENT, ROWS STILL LEGACY:
 *     Marker present (UUID readable) AND zero rows under UUID AND rows under legacy id.
 *     Resume + complete the one-shot migration (idempotent via I5).
 *
 *   STATE 3 — LEGACY ROWS, NO MARKER (standard migration trigger):
 *     No marker at/above cwd BUT rows exist under legacy encodeCwd(root) id.
 *     Run the full one-shot migration: write marker → copy handoff.md → rekey DB.
 *
 *   STATE 4 — GENUINELY FRESH:
 *     No marker AND no legacy rows → mint marker + UUID, continue normal provisioning.
 *     Does NOT run the migration. Returns the new UUID.
 *
 * Returns { projectId, root, isNewProject } where projectId is the UUID to use for all
 * subsequent DB and handoff.md operations.
 *
 * ────────────────────────────────────────────────────────────────────────
 * INVARIANTS (I1–I7) — see PR-3a spec for the full invariant list:
 *
 *   I1 RECOVERY SNAPSHOT:  Before any DB mutation, dump legacy rows to OS temp staging.
 *   I2 ATOMIC:             All table rekeys in ONE transaction. No partial state.
 *   I3 CONSERVATION:       count(new_id) after == count(legacy_id) before; count(legacy_id) after == 0.
 *   I4 COLLISION-SAFE:     Assert zero pre-existing rows under target UUID before mutation.
 *   I5 IDEMPOTENT:         All three interrupt states handled (see STATE 1/2/3 above).
 *   I6 FATAL-ON-INCONSISTENCY: migration failure → loud error + process.exit(1); never continue.
 *   I7 HANDOFF.MD ORDERING: COPY → verify byte-identical → DB COMMIT → delete legacy file.
 *
 * Tables rekeyed (from schema audit — see handoff-core-schema.sql and handoff-sqlite-schema.sql):
 *   assertions, entities, edges, retrieval_contract, retrieval_contract_history,
 *   project_settings, extraction_queue, retrieval_events, entity_communities
 * Note: retrieval_event_assertions is keyed by event_id (no project_id column) — not rekeyed.
 *
 * ────────────────────────────────────────────────────────────────────────
 */

const fs     = require('fs');
const path   = require('path');
const os     = require('os');
const crypto = require('crypto');

const { encodeCwd }               = require('./encoded-cwd');
const {
  MARKER_FILENAME,
  findProjectRootByMarker,
  readMarker,
  writeMarker,
} = require('./project-marker');

/**
 * Walk upward from `startDir` looking for a `.git` directory — the legacy
 * project-root anchor. Mirrors findProjectRoot() from shared.js but accepts
 * an explicit starting directory so tests can pass a tmpDir as `cwd` and
 * avoid the process.cwd() side-effect.
 *
 * @param {string} startDir
 * @returns {string} directory containing `.git`, or startDir if not found
 */
function _findLegacyRoot(startDir) {
  if (process.env.PROJECT_ROOT) return process.env.PROJECT_ROOT;
  let dir = startDir;
  while (dir !== path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, '.git'))) return dir;
    dir = path.dirname(dir);
  }
  return startDir;
}

// Ordered list of ALL tables with a project_id column (derived from schema audit).
// IMPORTANT: any new table with a project_id column must be added here.
const PROJECT_ID_TABLES = [
  'assertions',
  'entities',
  'edges',
  'retrieval_contract',
  'retrieval_contract_history',
  'project_settings',
  'extraction_queue',
  'retrieval_events',
  'entity_communities',
];

// Staging dir for recovery snapshots (I1). Under OS temp, NEVER inside the repo.
function getSnapshotDir() {
  return path.join(os.tmpdir(), 'claude-memory-migration-snapshots');
}

/**
 * Dump legacy-keyed rows to a recovery snapshot file (I1).
 *
 * @param {object} db           — connected StoragePort adapter
 * @param {string} legacyId     — encodeCwd(root) id
 * @param {string} snapshotDir  — OS temp staging dir
 * @returns {string} path to the snapshot file
 */
async function dumpRecoverySnapshot(db, legacyId, snapshotDir) {
  fs.mkdirSync(snapshotDir, { recursive: true });

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const safeLegacy = legacyId.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 60);
  const snapshotPath = path.join(snapshotDir, `snapshot-${safeLegacy}-${timestamp}.json`);

  const snapshot = {
    created_at: new Date().toISOString(),
    legacy_id:  legacyId,
    tables:     {},
  };

  for (const table of PROJECT_ID_TABLES) {
    try {
      const { rows } = await db.query(
        `SELECT * FROM ${table} WHERE project_id = $1`,
        [legacyId]
      );
      snapshot.tables[table] = { count: rows.length, rows };
    } catch (_) {
      // Table might not exist yet (e.g., entity_communities on a bare schema).
      snapshot.tables[table] = { count: 0, rows: [], note: 'table absent or empty' };
    }
  }

  fs.writeFileSync(snapshotPath, JSON.stringify(snapshot, null, 2), 'utf8');
  return snapshotPath;
}

/**
 * Verify that a file exists at newPath and is byte-identical to the file at srcPath.
 * Returns true if identical, false otherwise.
 *
 * @param {string} srcPath
 * @param {string} newPath
 * @returns {boolean}
 */
function verifyByteIdentical(srcPath, newPath) {
  try {
    const src = fs.readFileSync(srcPath);
    const dst = fs.readFileSync(newPath);
    return src.equals(dst);
  } catch (_) {
    return false;
  }
}

/**
 * Perform the one-shot atomic migration:
 *   I1: dump snapshot → I4: collision check → copy handoff.md →
 *   I2+I3: atomic rekey txn → I7: delete legacy handoff.md.
 *
 * On any inconsistency, rolls back and calls fatalExit(). Never returns in error state.
 *
 * @param {object} db                — connected StoragePort adapter
 * @param {string} legacyId          — the old encodeCwd-based project id
 * @param {string} newUUID           — the new marker UUID
 * @param {string} legacyHandoffPath — existing handoff.md path (may not exist)
 * @param {string} newHandoffPath    — target handoff.md path (UUID-keyed)
 * @param {Function} fatalExit       — (message: string) => never — called on fatal error
 */
async function runOneShot(db, legacyId, newUUID, legacyHandoffPath, newHandoffPath, fatalExit) {
  const snapshotDir = getSnapshotDir();

  // ── I1: Recovery snapshot ─────────────────────────────────────────────────
  let snapshotPath;
  try {
    snapshotPath = await dumpRecoverySnapshot(db, legacyId, snapshotDir);
    process.stderr.write(`[handoff] migration snapshot: ${snapshotPath}\n`);
  } catch (snapErr) {
    fatalExit(
      `[handoff:identity] FATAL — could not write recovery snapshot: ${snapErr.message}\n` +
      `  Snapshot dir: ${snapshotDir}\n` +
      `  Migration aborted before any DB mutation.\n`
    );
  }

  // ── I4: Collision check — assert zero pre-existing rows under the new UUID ──
  for (const table of PROJECT_ID_TABLES) {
    let queryOk = false;
    let countN = 0;
    try {
      const { rows } = await db.query(
        `SELECT COUNT(*) AS n FROM ${table} WHERE project_id = $1`,
        [newUUID]
      );
      queryOk = true;
      countN = parseInt(rows[0] && (rows[0].n || rows[0].count), 10) || 0;
    } catch (_tblErr) {
      // Table absent or unavailable — not an error (e.g., entity_communities may be absent).
      queryOk = false;
    }
    if (queryOk && countN > 0) {
      fatalExit(
        `[handoff:identity] FATAL — collision: table '${table}' already has ${countN} row(s) ` +
        `under new UUID '${newUUID}'.\n` +
        `  This indicates a shared DB with a conflicting project. Migration aborted.\n` +
        `  Recovery snapshot: ${snapshotPath}\n`
      );
    }
  }

  // ── Count legacy rows before mutation (I3 baseline) ──────────────────────
  const beforeCounts = {};
  for (const table of PROJECT_ID_TABLES) {
    try {
      const { rows } = await db.query(
        `SELECT COUNT(*) AS n FROM ${table} WHERE project_id = $1`,
        [legacyId]
      );
      beforeCounts[table] = parseInt(rows[0] && (rows[0].n || rows[0].count), 10) || 0;
    } catch (_) {
      beforeCounts[table] = 0;
    }
  }

  // ── I7: Copy handoff.md BEFORE the DB transaction ─────────────────────────
  let handoffMdCopied = false;
  if (fs.existsSync(legacyHandoffPath)) {
    try {
      fs.mkdirSync(path.dirname(newHandoffPath), { recursive: true });
      // Copy (not move) — the legacy file remains until after DB commit.
      fs.copyFileSync(legacyHandoffPath, newHandoffPath);
      // Verify byte-identical.
      if (!verifyByteIdentical(legacyHandoffPath, newHandoffPath)) {
        fatalExit(
          `[handoff:identity] FATAL — handoff.md copy verification failed.\n` +
          `  Source: ${legacyHandoffPath}\n` +
          `  Target: ${newHandoffPath}\n` +
          `  Recovery snapshot: ${snapshotPath}\n`
        );
      }
      handoffMdCopied = true;
    } catch (copyErr) {
      fatalExit(
        `[handoff:identity] FATAL — could not copy handoff.md: ${copyErr.message}\n` +
        `  Recovery snapshot: ${snapshotPath}\n`
      );
    }
  }

  // ── I2+I3: Atomic rekey transaction ──────────────────────────────────────
  await db.query('BEGIN');
  try {
    for (const table of PROJECT_ID_TABLES) {
      if (beforeCounts[table] === 0) continue; // nothing to rekey
      // UPDATE project_id from legacy to new UUID.
      await db.query(
        `UPDATE ${table} SET project_id = $1 WHERE project_id = $2`,
        [newUUID, legacyId]
      );
    }

    // I3: in-transaction conservation check.
    for (const table of PROJECT_ID_TABLES) {
      if (beforeCounts[table] === 0) continue;
      try {
        const { rows: newRows } = await db.query(
          `SELECT COUNT(*) AS n FROM ${table} WHERE project_id = $1`,
          [newUUID]
        );
        const newCount = parseInt(newRows[0] && (newRows[0].n || newRows[0].count), 10) || 0;

        const { rows: legRows } = await db.query(
          `SELECT COUNT(*) AS n FROM ${table} WHERE project_id = $1`,
          [legacyId]
        );
        const legCount = parseInt(legRows[0] && (legRows[0].n || legRows[0].count), 10) || 0;

        if (newCount !== beforeCounts[table]) {
          throw new Error(
            `Conservation VIOLATED in table '${table}': ` +
            `expected new_count=${beforeCounts[table]}, got ${newCount}`
          );
        }
        if (legCount !== 0) {
          throw new Error(
            `Conservation VIOLATED in table '${table}': ` +
            `legacy rows remain after rekey: count=${legCount}`
          );
        }
      } catch (checkErr) {
        throw checkErr; // will trigger rollback + fatalExit below
      }
    }

    await db.query('COMMIT');
  } catch (txErr) {
    try { await db.query('ROLLBACK'); } catch (_) {}
    // Delete the new handoff.md copy (we rolled back — legacy file is still intact).
    if (handoffMdCopied && fs.existsSync(newHandoffPath)) {
      try { fs.unlinkSync(newHandoffPath); } catch (_) {}
    }
    fatalExit(
      `[handoff:identity] FATAL — DB rekey transaction failed and was rolled back.\n` +
      `  Error: ${txErr.message}\n` +
      `  Legacy data is intact. Recovery snapshot: ${snapshotPath}\n`
    );
  }

  // ── I7 (continued): Delete legacy handoff.md AFTER DB commit ─────────────
  if (handoffMdCopied && fs.existsSync(legacyHandoffPath)) {
    try {
      fs.unlinkSync(legacyHandoffPath);
    } catch (delErr) {
      // Non-fatal: the DB is committed and the new file exists. A dangling legacy
      // file is harmless (I5 idempotency handles it on re-run: marker present +
      // rows already under UUID = no-op). Log but continue.
      process.stderr.write(
        `[handoff] migration: could not delete legacy handoff.md (non-fatal): ${delErr.message}\n` +
        `  The DB was committed. The legacy file may be cleaned up manually.\n`
      );
    }
  }

  process.stderr.write(
    `[handoff] migration complete: legacy_id='${legacyId}' → uuid='${newUUID}'\n` +
    `  Tables rekeyed: ${Object.entries(beforeCounts).filter(([, n]) => n > 0).map(([t, n]) => `${t}(${n})`).join(', ') || 'none'}\n` +
    `  Recovery snapshot: ${snapshotPath}\n`
  );
}

/**
 * ensureProjectIdentity — the FIRST internal-check step for cmdLoaderLoad and cmdClose.
 *
 * Must be called BEFORE ensureSchemaCurrent. Cannot do anything keyed by project_id
 * (including the schema fingerprint check) until identity is resolved.
 *
 * @param {object} db   — connected StoragePort adapter
 * @param {object} opts
 * @param {string} [opts.cwd]         — override cwd (defaults to process.cwd())
 * @param {boolean} [opts.silent]     — suppress informational stderr output
 * @param {boolean} [opts.allowFresh] — if true, mint a marker for a fresh project (default: true)
 * @returns {Promise<{ projectId: string, root: string, isNewProject: boolean }>}
 *          projectId = the UUID to use for all subsequent DB operations
 *          root      = project root directory
 *          isNewProject = true if a fresh marker was just minted (no prior rows)
 */
async function ensureProjectIdentity(db, opts = {}) {
  // Honor PROJECT_ROOT env var (used by smoketest and cmdInit subprocess calls) as the
  // canonical starting point for root detection, matching the behavior of findProjectRoot()
  // in shared.js. Explicit opts.cwd overrides both.
  const cwd = opts.cwd || process.env.PROJECT_ROOT || process.cwd();

  // ── Step 1: Try to locate the project root via the .claude-memory marker ──
  const markerRoot = findProjectRootByMarker(cwd);

  if (markerRoot) {
    const marker = readMarker(markerRoot);
    if (!marker) {
      // Marker file exists but is malformed — fatal.
      _fatalIdentity(
        `[handoff:identity] FATAL — .claude-memory marker exists at ${path.join(markerRoot, MARKER_FILENAME)} ` +
        `but could not be parsed. The file may be corrupt.\n` +
        `  Please delete it and re-run to mint a fresh marker, OR restore from backup.\n`
      );
    }

    const uuid = marker.uuid;
    // Steady-state hot path: check if rows already exist under the UUID.
    const { hasUUIDRows, hasLegacyRows, legacyId, legacyHandoffPath, newHandoffPath } =
      await _probeState(db, markerRoot, uuid);

    if (hasUUIDRows) {
      // STATE 1: Already migrated — no-op. UUID is the projectId.
      if (!opts.silent) {
        // Hot-path: no logging to avoid per-invocation noise.
      }
      return { projectId: uuid, root: markerRoot, isNewProject: false };
    }

    if (hasLegacyRows) {
      // STATE 2: Marker written, rows still under legacy id — resume migration.
      if (!opts.silent) {
        process.stderr.write(
          `[handoff] identity: marker present, rows still legacy — resuming migration ` +
          `(legacy='${legacyId}', uuid='${uuid}')\n`
        );
      }
      await runOneShot(db, legacyId, uuid, legacyHandoffPath, newHandoffPath, _fatalIdentity);
      return { projectId: uuid, root: markerRoot, isNewProject: false };
    }

    // STATE 1 variant: marker present, no rows anywhere → fresh project with marker already written.
    return { projectId: uuid, root: markerRoot, isNewProject: true };
  }

  // ── Step 2: No marker found. Check for legacy rows. ──────────────────────
  // _findLegacyRoot() uses the .git walk starting from opts.cwd — still used
  // here for legacy-row lookup ONLY, never for identity.
  const legacyRoot   = _findLegacyRoot(cwd);
  const legacyId     = encodeCwd(legacyRoot);
  const hasLegacyRows = await _hasAnyRows(db, legacyId);

  if (hasLegacyRows) {
    // STATE 3: Legacy rows exist, no marker → full one-shot migration.
    if (!opts.silent) {
      process.stderr.write(
        `[handoff] identity: no marker found, legacy rows present — running one-shot migration\n` +
        `  project root (for marker): ${legacyRoot}\n` +
        `  legacy_id: ${legacyId}\n`
      );
    }

    // Write the marker FIRST (I7 ordering: marker → copy → DB commit → delete).
    let marker;
    try {
      marker = writeMarker(legacyRoot);
    } catch (markerErr) {
      _fatalIdentity(
        `[handoff:identity] FATAL — could not write .claude-memory marker: ${markerErr.message}\n` +
        `  Project root: ${legacyRoot}\n` +
        `  Migration aborted.\n`
      );
    }

    const uuid             = marker.uuid;
    const legacyHandoffPath = _legacyHandoffPath(legacyId);
    const newHandoffPath    = _newHandoffPath(uuid);

    await runOneShot(db, legacyId, uuid, legacyHandoffPath, newHandoffPath, _fatalIdentity);
    return { projectId: uuid, root: legacyRoot, isNewProject: false };
  }

  // STATE 4: No marker, no legacy rows → fresh project.
  // Mint a marker at the project root (using legacyRoot as fallback location,
  // since there is no better root without a marker or VCS anchor).
  let marker;
  try {
    marker = writeMarker(legacyRoot);
    if (!opts.silent) {
      process.stderr.write(
        `[handoff] identity: fresh project — minted marker at ${path.join(legacyRoot, MARKER_FILENAME)}\n` +
        `  uuid: ${marker.uuid}\n`
      );
    }
  } catch (markerErr) {
    _fatalIdentity(
      `[handoff:identity] FATAL — could not mint .claude-memory marker for fresh project: ${markerErr.message}\n` +
      `  Project root: ${legacyRoot}\n`
    );
  }

  return { projectId: marker.uuid, root: legacyRoot, isNewProject: true };
}

// ── Internal helpers ──────────────────────────────────────────────────────────

/**
 * Probe whether rows exist under the UUID and/or the legacy id.
 * Returns all components needed for the migration decision.
 */
async function _probeState(db, markerRoot, uuid) {
  const legacyId       = encodeCwd(markerRoot);
  const legacyHandoffPath = _legacyHandoffPath(legacyId);
  const newHandoffPath    = _newHandoffPath(uuid);

  const hasUUIDRows    = await _hasAnyRows(db, uuid);
  const hasLegacyRows  = await _hasAnyRows(db, legacyId);

  return { hasUUIDRows, hasLegacyRows, legacyId, legacyHandoffPath, newHandoffPath };
}

/**
 * Return true if ANY of the PROJECT_ID_TABLES has rows for the given id.
 */
async function _hasAnyRows(db, projectId) {
  for (const table of PROJECT_ID_TABLES) {
    try {
      const { rows } = await db.query(
        `SELECT COUNT(*) AS n FROM ${table} WHERE project_id = $1`,
        [projectId]
      );
      const n = parseInt(rows[0] && (rows[0].n || rows[0].count), 10) || 0;
      if (n > 0) return true;
    } catch (_) {
      // Table absent — skip.
    }
  }
  return false;
}

function _legacyHandoffPath(legacyId) {
  const os = require('os');
  return require('path').join(os.homedir(), '.claude', 'projects', legacyId, 'handoff.md');
}

function _newHandoffPath(uuid) {
  const os = require('os');
  return require('path').join(os.homedir(), '.claude', 'projects', uuid, 'handoff.md');
}

/**
 * Fatal error handler for identity failures.
 * Per I6: MUST NOT be swallowed. Process exits non-zero.
 *
 * @param {string} message
 * @returns {never}
 */
function _fatalIdentity(message) {
  process.stderr.write(message + '\n');
  process.exit(1);
}

module.exports = {
  ensureProjectIdentity,
  PROJECT_ID_TABLES,      // exported for tests
  dumpRecoverySnapshot,   // exported for tests
  getSnapshotDir,         // exported for tests
  verifyByteIdentical,    // exported for tests
  runOneShot,             // exported for tests (with custom fatalExit callback)
};
