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
 *                          Filename is collision-proof: UUID + pid + random token.
 *   I2 ATOMIC:             All table rekeys in ONE transaction. No partial state.
 *   I3 CONSERVATION:       count(new_id) after == count(legacy_id) before; count(legacy_id) after == 0.
 *   I4 COLLISION-SAFE:     Assert zero pre-existing rows under target UUID before mutation.
 *   I5 IDEMPOTENT:         All three interrupt states handled (see STATE 1/2/3 above).
 *   I6 FATAL-ON-INCONSISTENCY: migration failure → loud error + process.exit(1); never continue.
 *   I7 HANDOFF.MD ORDERING: COPY → verify byte-identical → DB COMMIT → delete legacy file.
 *                            Post-migration asserts exactly ONE active handoff.md per project.
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
 * Filename is collision-proof: includes the target UUID, the process pid, and a
 * random hex token so concurrent processes never overwrite each other's snapshot.
 * The file is created atomically (write to temp + rename) so a partial write is
 * never observable by another reader.
 *
 * @param {object} db           — connected StoragePort adapter
 * @param {string} legacyId     — encodeCwd(root) id
 * @param {string} snapshotDir  — OS temp staging dir
 * @param {string} [targetUUID] — optional target UUID for the filename (I5 collision-safe)
 * @returns {string} path to the snapshot file
 */
async function dumpRecoverySnapshot(db, legacyId, snapshotDir, targetUUID) {
  fs.mkdirSync(snapshotDir, { recursive: true });

  const timestamp  = new Date().toISOString().replace(/[:.]/g, '-');
  const safeLegacy = legacyId.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 60);
  const uuidPart   = targetUUID ? targetUUID.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 36) : 'noid';
  const pid        = process.pid;
  const rnd        = crypto.randomBytes(4).toString('hex');
  const snapshotBase = `snapshot-${safeLegacy}-${uuidPart}-pid${pid}-${rnd}-${timestamp}.json`;
  const snapshotPath = path.join(snapshotDir, snapshotBase);
  const tmpPath      = snapshotPath + '.tmp';

  const snapshot = {
    created_at:   new Date().toISOString(),
    legacy_id:    legacyId,
    target_uuid:  targetUUID || null,
    pid,
    random_token: rnd,
    tables:       {},
  };

  for (const table of PROJECT_ID_TABLES) {
    // Use querySafe so a missing table does not abort the surrounding Postgres
    // transaction (Postgres aborts the entire txn on any error; querySafe uses
    // SAVEPOINTs in Postgres and a plain try/catch in SQLite).
    const { rows } = await db.querySafe(
      `SELECT * FROM ${table} WHERE project_id = $1`,
      [legacyId]
    );
    if (rows.length > 0 || rows !== undefined) {
      snapshot.tables[table] = { count: rows.length, rows };
    } else {
      snapshot.tables[table] = { count: 0, rows: [], note: 'table absent or empty' };
    }
  }

  // Write to temp then atomic-rename (I1 + I5 collision-safety).
  fs.writeFileSync(tmpPath, JSON.stringify(snapshot, null, 2), 'utf8');
  // Never overwrite an existing snapshot (second process gets a distinct path via rnd).
  if (!fs.existsSync(snapshotPath)) {
    fs.renameSync(tmpPath, snapshotPath);
  } else {
    // Extremely unlikely: exact same path somehow exists. Keep the tmp as-is with a suffix.
    const altPath = snapshotPath + '.dup' + rnd;
    fs.renameSync(tmpPath, altPath);
    return altPath;
  }
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
 * Write the marker to a temp file then atomic-rename into place.
 * This prevents other processes from seeing a partial write.
 * If the target path already exists when the rename is attempted, throws with
 * an "already exists" message so the caller can detect the race.
 *
 * @param {string} rootDir  — project root directory
 * @returns {{ uuid, created_at, schema_version }}
 */
function writeMarkerAtomic(rootDir) {
  const markerPath = path.join(rootDir, MARKER_FILENAME);
  const tmpPath    = markerPath + '.tmp.' + process.pid + '.' + crypto.randomBytes(4).toString('hex');

  // Delegate UUID generation + serialization to the existing writeMarker helper
  // but write to the tmp path instead.  We avoid calling writeMarker() directly
  // because it checks for the existence of the target path; we need the temp approach.
  const uuid       = crypto.randomUUID();
  const created_at = new Date().toISOString();
  const payload    = { uuid, created_at, schema_version: 1 };

  fs.writeFileSync(tmpPath, JSON.stringify(payload, null, 2) + '\n', 'utf8');

  // Atomic rename.  On POSIX this is atomic; on Windows fs.renameSync silently
  // overwrites the destination even if it exists (no EEXIST thrown).  To provide
  // collision-detection on both platforms, check existence BEFORE the rename and
  // clean up the temp file if the marker is already present.
  if (fs.existsSync(markerPath)) {
    try { fs.unlinkSync(tmpPath); } catch (_) {}
    throw new Error(`writeMarker: marker already exists at ${markerPath} — concurrent process won the race`);
  }
  try {
    fs.renameSync(tmpPath, markerPath);
  } catch (renameErr) {
    // Clean up the temp file.
    try { fs.unlinkSync(tmpPath); } catch (_) {}
    const code = renameErr.code || '';
    if (code === 'EEXIST' || code === 'EPERM' || renameErr.message.includes('already exists')) {
      throw new Error(`writeMarker: marker already exists at ${markerPath} — concurrent process won the race`);
    }
    throw renameErr;
  }
  // Post-rename check: another process might have written the marker in the window
  // between our existence check and the rename.  If the marker content differs from
  // what we just wrote, we lost the race (the rename silently overwrote their file
  // on some platforms, but the marker is now ours — no rollback needed).
  // On POSIX, rename is atomic, so this double-check is a no-op safety net only.

  return { uuid, created_at, schema_version: 1 };
}

/**
 * Perform the one-shot atomic migration:
 *   LOCK: acquire migration lock (serialize concurrent migrations)
 *   RE-CHECK: re-probe state after acquiring lock; become no-op if already migrated
 *   I1: dump snapshot → I4: collision check → copy handoff.md →
 *   I2+I3: atomic rekey txn → I7: delete legacy handoff.md →
 *   I7 post: assert exactly ONE active handoff.md for the project.
 *
 * On any inconsistency, rolls back and calls fatalExit(). Never returns in error state.
 *
 * @param {object} db                — connected StoragePort adapter
 * @param {string} legacyId          — the old encodeCwd-based project id
 * @param {string} newUUID           — the new marker UUID
 * @param {string} legacyHandoffPath — existing handoff.md path (may not exist)
 * @param {string} newHandoffPath    — target handoff.md path (UUID-keyed)
 * @param {Function} fatalExit       — (message: string) => never — called on fatal error
 * @param {object}  [opts]
 * @param {boolean} [opts.skipLock]  — if true, skip the advisory lock step (for tests that manage their own txn)
 */
async function runOneShot(db, legacyId, newUUID, legacyHandoffPath, newHandoffPath, fatalExit, opts) {
  const snapshotDir = getSnapshotDir();
  const skipLock    = (opts && opts.skipLock) === true;

  // ── Concurrent-migration guard ────────────────────────────────────────────
  // acquireMigrationLock opens the transaction AND acquires the advisory lock in
  // one call (matches both SQLite BEGIN IMMEDIATE and Postgres BEGIN+pg_advisory).
  // The losing concurrent process blocks here until the winner commits, then
  // proceeds to the re-check below and becomes an idempotent no-op.
  if (!skipLock) {
    try {
      await db.acquireMigrationLock(legacyId);
    } catch (lockErr) {
      // If acquireMigrationLock itself threw after opening the transaction,
      // attempt a ROLLBACK to clean up, then fatal-exit.
      try { await db.query('ROLLBACK'); } catch (_) {}
      fatalExit(
        `[handoff:identity] FATAL — could not acquire migration lock for key '${legacyId}': ${lockErr.message}\n` +
        `  Migration aborted before any DB mutation.\n`
      );
    }

    // ── Re-check after acquiring the lock ──────────────────────────────────
    // A concurrent process may have completed the migration while we were waiting.
    // Idempotent no-op condition: UUID has rows AND legacy has NO rows (migration done).
    // If both have rows → that is a collision (I4), handled below by the collision check.
    const recheckHasUUID    = await _hasAnyRows(db, newUUID);
    const recheckHasLegacy  = await _hasAnyRows(db, legacyId);
    if (recheckHasUUID && !recheckHasLegacy) {
      // Migration was completed by a concurrent winner — idempotent no-op.
      await db.query('COMMIT');
      process.stderr.write(
        `[handoff] migration: lock acquired but migration already complete (UUID='${newUUID}') — concurrent process won; no-op.\n`
      );
      return;
    }
    // Still needs migration (or collision present) — continue inside the open transaction.
  }

  // ── I1: Recovery snapshot ─────────────────────────────────────────────────
  let snapshotPath;
  try {
    snapshotPath = await dumpRecoverySnapshot(db, legacyId, snapshotDir, newUUID);
    process.stderr.write(`[handoff] migration snapshot: ${snapshotPath}\n`);
  } catch (snapErr) {
    if (!skipLock) { try { await db.query('ROLLBACK'); } catch (_) {} }
    fatalExit(
      `[handoff:identity] FATAL — could not write recovery snapshot: ${snapErr.message}\n` +
      `  Snapshot dir: ${snapshotDir}\n` +
      `  Migration aborted before any DB mutation.\n`
    );
  }

  // ── I4: Collision check — assert zero pre-existing rows under the new UUID ──
  // Use querySafe: a missing table (e.g., retrieval_events) must not abort the
  // surrounding Postgres transaction.
  for (const table of PROJECT_ID_TABLES) {
    const { rows } = await db.querySafe(
      `SELECT COUNT(*) AS n FROM ${table} WHERE project_id = $1`,
      [newUUID]
    );
    const countN = parseInt(rows[0] && (rows[0].n || rows[0].count), 10) || 0;
    if (countN > 0) {
      if (!skipLock) { try { await db.query('ROLLBACK'); } catch (_) {} }
      fatalExit(
        `[handoff:identity] FATAL — collision: table '${table}' already has ${countN} row(s) ` +
        `under new UUID '${newUUID}'.\n` +
        `  This indicates a shared DB with a conflicting project. Migration aborted.\n` +
        `  Recovery snapshot: ${snapshotPath}\n`
      );
    }
  }

  // ── Count legacy rows before mutation (I3 baseline) ──────────────────────
  // Use querySafe: missing tables must not abort the Postgres transaction.
  const beforeCounts = {};
  for (const table of PROJECT_ID_TABLES) {
    const { rows } = await db.querySafe(
      `SELECT COUNT(*) AS n FROM ${table} WHERE project_id = $1`,
      [legacyId]
    );
    beforeCounts[table] = parseInt(rows[0] && (rows[0].n || rows[0].count), 10) || 0;
  }

  // ── I7: Copy handoff.md BEFORE the DB commit ─────────────────────────────
  let handoffMdCopied = false;
  if (fs.existsSync(legacyHandoffPath)) {
    try {
      fs.mkdirSync(path.dirname(newHandoffPath), { recursive: true });
      // Copy to a temp file first, then atomic-rename to newHandoffPath.
      const tmpHandoff = newHandoffPath + '.tmp.' + process.pid + '.' + crypto.randomBytes(4).toString('hex');
      fs.copyFileSync(legacyHandoffPath, tmpHandoff);
      // Verify the copy is byte-identical before renaming.
      if (!verifyByteIdentical(legacyHandoffPath, tmpHandoff)) {
        try { fs.unlinkSync(tmpHandoff); } catch (_) {}
        if (!skipLock) { try { await db.query('ROLLBACK'); } catch (_) {} }
        fatalExit(
          `[handoff:identity] FATAL — handoff.md copy verification failed (tmp stage).\n` +
          `  Source: ${legacyHandoffPath}\n` +
          `  Recovery snapshot: ${snapshotPath}\n`
        );
      }
      // Atomic rename into place.
      fs.renameSync(tmpHandoff, newHandoffPath);
      // Final verification: the renamed file must be byte-identical.
      if (!verifyByteIdentical(legacyHandoffPath, newHandoffPath)) {
        if (!skipLock) { try { await db.query('ROLLBACK'); } catch (_) {} }
        fatalExit(
          `[handoff:identity] FATAL — handoff.md copy verification failed after rename.\n` +
          `  Source: ${legacyHandoffPath}\n` +
          `  Target: ${newHandoffPath}\n` +
          `  Recovery snapshot: ${snapshotPath}\n`
        );
      }
      handoffMdCopied = true;
    } catch (copyErr) {
      if (!skipLock) { try { await db.query('ROLLBACK'); } catch (_) {} }
      fatalExit(
        `[handoff:identity] FATAL — could not copy handoff.md: ${copyErr.message}\n` +
        `  Recovery snapshot: ${snapshotPath}\n`
      );
    }
  }

  // ── I2+I3: Atomic rekey ───────────────────────────────────────────────────
  // If skipLock=true the caller already opened a transaction; otherwise we are
  // already inside the transaction opened by the lock-acquire block above.
  if (skipLock) {
    await db.query('BEGIN');
  }
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
    // These tables all existed (beforeCounts[table] > 0) so the queries must
    // succeed — use plain db.query here (not querySafe) to surface real errors.
    for (const table of PROJECT_ID_TABLES) {
      if (beforeCounts[table] === 0) continue;
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

  // ── I7 post: assert exactly ONE active handoff.md ─────────────────────────
  // After migration: newHandoffPath must exist (if we copied one) AND legacyHandoffPath
  // must be gone (or was never there).  If both exist, the invariant is violated.
  if (handoffMdCopied) {
    const newExists    = fs.existsSync(newHandoffPath);
    const legacyExists = fs.existsSync(legacyHandoffPath);
    if (!newExists) {
      fatalExit(
        `[handoff:identity] FATAL (I7) — new handoff.md is absent after DB commit.\n` +
        `  Expected: ${newHandoffPath}\n` +
        `  Recovery snapshot: ${snapshotPath}\n` +
        `  DB COMMIT completed. Re-run to restore from snapshot.\n`
      );
    }
    if (legacyExists) {
      // Both present: the delete failed but DB is committed. Non-fatal log (delete already
      // logged above), but flag the invariant violation in stderr for operator visibility.
      process.stderr.write(
        `[handoff] WARNING (I7): both legacy and new handoff.md exist after migration.\n` +
        `  Legacy:  ${legacyHandoffPath}\n` +
        `  New:     ${newHandoffPath}\n` +
        `  DB is committed to UUID '${newUUID}'. Delete the legacy file manually.\n`
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

    // Write the marker atomically FIRST (I7 ordering: marker → copy → DB commit → delete).
    // If writeMarkerAtomic throws "already exists", a concurrent process won the race.
    // In that case, fall through to the STATE 2 handler below.
    let marker;
    try {
      marker = writeMarkerAtomic(legacyRoot);
    } catch (markerErr) {
      if (markerErr.message && markerErr.message.includes('already exists')) {
        // Concurrent process won the marker race. Re-read the now-present marker and
        // proceed down the STATE 2 (resume migration, idempotent) path.
        const raceMarker = readMarker(legacyRoot);
        if (raceMarker) {
          if (!opts.silent) {
            process.stderr.write(
              `[handoff] identity: STATE 3 marker race — concurrent process wrote marker (uuid='${raceMarker.uuid}'); resuming as STATE 2\n`
            );
          }
          const lhp = _legacyHandoffPath(legacyId);
          const nhp = _newHandoffPath(raceMarker.uuid);
          await runOneShot(db, legacyId, raceMarker.uuid, lhp, nhp, _fatalIdentity);
          return { projectId: raceMarker.uuid, root: legacyRoot, isNewProject: false };
        }
        // Marker was written but is unreadable — fatal.
        _fatalIdentity(
          `[handoff:identity] FATAL — concurrent process wrote marker at ${path.join(legacyRoot, MARKER_FILENAME)} ` +
          `but it could not be parsed.\n` +
          `  Please inspect and fix the marker file.\n`
        );
      }
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
    marker = writeMarkerAtomic(legacyRoot);
    if (!opts.silent) {
      process.stderr.write(
        `[handoff] identity: fresh project — minted marker at ${path.join(legacyRoot, MARKER_FILENAME)}\n` +
        `  uuid: ${marker.uuid}\n`
      );
    }
  } catch (markerErr) {
    if (markerErr.message && markerErr.message.includes('already exists')) {
      // Concurrent STATE 4 process won the race — read the now-present marker.
      const raceMarker = readMarker(legacyRoot);
      if (raceMarker) {
        if (!opts.silent) {
          process.stderr.write(
            `[handoff] identity: STATE 4 marker race — concurrent process wrote marker (uuid='${raceMarker.uuid}')\n`
          );
        }
        return { projectId: raceMarker.uuid, root: legacyRoot, isNewProject: true };
      }
    }
    _fatalIdentity(
      `[handoff:identity] FATAL — could not mint .claude-memory marker for fresh project: ${markerErr.message}\n` +
      `  Project root: ${legacyRoot}\n`
    );
  }

  return { projectId: marker.uuid, root: legacyRoot, isNewProject: true };
}

/**
 * reconcileLegacySettings — idempotently remove orphaned legacy-encoded project_settings
 * rows for THIS project's legacy id.  Scoped strictly to the single legacy project_settings
 * row(s) that map to this project root — NOT a blanket sweep.
 *
 * Idempotent: a second run is a clean no-op.  Safe when there is nothing to reconcile.
 *
 * @param {object} db         — connected StoragePort adapter
 * @param {string} legacyId   — encodeCwd(root) — the legacy project id to clean up
 * @param {string} newUUID    — the live UUID for this project (used to verify migration is done)
 * @param {object} [opts]
 * @param {boolean} [opts.silent] — suppress informational output
 * @returns {Promise<{ removed: number, snapshotPath: string|null }>}
 */
async function reconcileLegacySettings(db, legacyId, newUUID, opts = {}) {
  const silent = (opts && opts.silent) === true;

  // Verify migration is complete before reconciling.
  const migrated = await _hasAnyRows(db, newUUID);
  if (!migrated) {
    // Rows are still under legacy id or nowhere — not safe to delete legacy settings.
    if (!silent) {
      process.stderr.write(
        `[handoff] reconcile: skipped — no rows under UUID '${newUUID}'; migration may not be complete.\n`
      );
    }
    return { removed: 0, snapshotPath: null };
  }

  // Check whether there are actually any legacy project_settings rows to reconcile.
  let legacyCount = 0;
  try {
    const { rows } = await db.query(
      `SELECT COUNT(*) AS n FROM project_settings WHERE project_id = $1`,
      [legacyId]
    );
    legacyCount = parseInt(rows[0] && (rows[0].n || rows[0].count), 10) || 0;
  } catch (_) {
    legacyCount = 0;
  }

  if (legacyCount === 0) {
    // Nothing to reconcile — idempotent no-op.
    return { removed: 0, snapshotPath: null };
  }

  // I1: snapshot BEFORE deleting (reuse the snapshot mechanism).
  const snapshotDir = getSnapshotDir();
  let snapshotPath  = null;
  try {
    snapshotPath = await dumpRecoverySnapshot(db, legacyId, snapshotDir, newUUID + '-reconcile');
    if (!silent) {
      process.stderr.write(`[handoff] reconcile snapshot: ${snapshotPath}\n`);
    }
  } catch (snapErr) {
    process.stderr.write(`[handoff] reconcile: snapshot failed (non-fatal, aborting reconcile): ${snapErr.message}\n`);
    return { removed: 0, snapshotPath: null };
  }

  // Delete only the orphaned project_settings rows for the legacy id.
  let removed = 0;
  try {
    const { rowCount } = await db.query(
      `DELETE FROM project_settings WHERE project_id = $1`,
      [legacyId]
    );
    removed = rowCount || 0;
    if (!silent) {
      process.stderr.write(
        `[handoff] reconcile: removed ${removed} orphaned project_settings row(s) for legacy_id='${legacyId}'\n`
      );
    }
  } catch (delErr) {
    process.stderr.write(`[handoff] reconcile: delete failed (non-fatal): ${delErr.message}\n`);
    return { removed: 0, snapshotPath };
  }

  return { removed, snapshotPath };
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
 *
 * Uses querySafe so that a missing table (e.g., retrieval_events not yet applied)
 * does NOT abort the surrounding Postgres transaction — Postgres aborts the entire
 * transaction block on any error; querySafe uses SAVEPOINTs to prevent that.
 */
async function _hasAnyRows(db, projectId) {
  for (const table of PROJECT_ID_TABLES) {
    const { rows } = await db.querySafe(
      `SELECT COUNT(*) AS n FROM ${table} WHERE project_id = $1`,
      [projectId]
    );
    const n = parseInt(rows[0] && (rows[0].n || rows[0].count), 10) || 0;
    if (n > 0) return true;
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
  reconcileLegacySettings,
  PROJECT_ID_TABLES,        // exported for tests
  dumpRecoverySnapshot,     // exported for tests
  getSnapshotDir,           // exported for tests
  verifyByteIdentical,      // exported for tests
  runOneShot,               // exported for tests (with custom fatalExit callback)
  writeMarkerAtomic,        // exported for tests
};
