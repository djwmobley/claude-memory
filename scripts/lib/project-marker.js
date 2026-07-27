'use strict';

/**
 * project-marker.js — Marker-borne stable project identity module.
 *
 * A project is identified by a `.memory-engine` marker file at the project root,
 * containing a generated stable UUID (v4) plus minimal metadata. Identity =
 * the UUID read from the marker, NOT derived from the filesystem path.
 *
 * This resolves the following problems with the legacy encodeCwd(root) scheme:
 *   - Non-git directories had no stable identity
 *   - Git worktrees (.git is a file) confused the upward walk
 *   - VCS type was consulted for identity (wrong abstraction)
 *   - Moved/renamed/symlinked checkouts produced different ids
 *   - Two clones of the same repo at different paths produced different ids
 *
 * HOST-AGNOSTIC NAMING (#135): the marker was originally named `.claude-memory`,
 * which embeds one specific client's name. It is now `.memory-engine`.
 * `LEGACY_MARKER_FILENAME` (`.claude-memory`) is kept as a permanent read-fallback
 * so existing projects that only have the old marker keep working with no
 * required migration step. Minting always writes the NEW name; the old name is
 * never written by this module again. See findProjectRootByMarker below for the
 * full same-directory dual-marker classification (total: every state maps to a
 * branch, and the two "both files present" failure states are a HARD ERROR
 * rather than a silent pick — see resolveMarkerAtDir).
 *
 * Exported API:
 *   findProjectRootByMarker(startDir) → string|null
 *     Walk up from startDir looking for a .memory-engine (or legacy .claude-memory)
 *     file. Returns the directory containing it, or null if not found. Throws if
 *     a directory has BOTH marker files with different uuids or with either file
 *     corrupt/unreadable — never silently picks one.
 *
 *   readMarker(rootDir) → { uuid, created_at, schema_version }|null
 *     Read and parse the marker at rootDir, applying the same dual-marker
 *     classification as findProjectRootByMarker. Returns null if neither marker
 *     is present. Throws on the same HARD ERROR states as findProjectRootByMarker.
 *
 *   writeMarker(rootDir) → { uuid, created_at, schema_version }
 *     Mint a new UUID and write the marker file (always under MARKER_FILENAME).
 *     Throws if write fails. Never overwrites an existing marker.
 *
 *   mintUUID() → string
 *     Mint a fresh UUID v4 without touching the filesystem. Use when a stable
 *     project id is needed before the caller is ready to persist the marker
 *     (e.g. deferred marker writes during handoff init for atomicity).
 *
 *   persistMarker(rootDir, uuid) → { uuid, created_at, schema_version }
 *     Write a marker file using a CALLER-SUPPLIED uuid. Throws if a marker
 *     already exists. Produces the same JSON shape as writeMarker (uuid,
 *     created_at, schema_version). Use together with mintUUID() when the UUID
 *     must be known before the marker is written to disk.
 *
 *   resolveMarkerUUID(rootDir) → string
 *     Read the UUID from an existing marker. Throws if not found or malformed.
 *     Use when the caller knows the marker must exist.
 *
 *   MARKER_FILENAME        — '.memory-engine' (exported constant for tests/callers)
 *   LEGACY_MARKER_FILENAME — '.claude-memory' (read-fallback only; never (re-)written)
 */

const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');

const MARKER_FILENAME        = '.memory-engine';
const LEGACY_MARKER_FILENAME = '.claude-memory';
const MARKER_SCHEMA_VER      = 1;

/**
 * Read and parse a marker file at an exact path. Returns the parsed
 * { uuid, created_at, schema_version } object, or null if the file is
 * missing, unreadable, or fails validation.
 *
 * @param {string} markerPath - Exact path to a marker file.
 * @returns {{ uuid: string, created_at: string, schema_version: number }|null}
 */
function _readMarkerFile(markerPath) {
  if (!fs.existsSync(markerPath)) return null;

  let text;
  try {
    text = fs.readFileSync(markerPath, 'utf8');
  } catch (_) {
    return null;
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (_) {
    return null;
  }

  if (typeof parsed !== 'object' || parsed === null) return null;
  if (typeof parsed.uuid !== 'string' || !isValidUUID(parsed.uuid)) return null;
  if (typeof parsed.schema_version !== 'number') return null;

  return {
    uuid:           parsed.uuid,
    created_at:     typeof parsed.created_at === 'string' ? parsed.created_at : new Date().toISOString(),
    schema_version: parsed.schema_version,
  };
}

/**
 * Total classification of the marker state at a single directory (C2: this
 * check is inline and MUST be consulted at every level of the walk-up — it is
 * never deferred to a later "pick whichever one" step). Every combination of
 * (new present/absent) x (old present/absent) x (parseable/corrupt) maps to
 * an explicit branch:
 *
 *   neither present               → null (not this directory)
 *   only new present              → use it (read-fallback n/a)
 *   only old present              → use it (read-fallback; no rewrite/auto-rename)
 *   both present, same uuid       → use the NEW file (never dual-write, never rewrite old)
 *   both present, different uuid  → HARD ERROR naming both absolute paths
 *   both present, either corrupt  → HARD ERROR naming both absolute paths
 *
 * @param {string} dir - Directory to classify.
 * @returns {{ filename: string, path: string, marker: object }|null}
 * @throws {Error} on the two dual-marker HARD ERROR states above.
 */
function resolveMarkerAtDir(dir) {
  const newPath = path.join(dir, MARKER_FILENAME);
  const oldPath = path.join(dir, LEGACY_MARKER_FILENAME);
  const newExists = fs.existsSync(newPath);
  const oldExists = fs.existsSync(oldPath);

  if (!newExists && !oldExists) return null;

  if (newExists && !oldExists) {
    return { filename: MARKER_FILENAME, path: newPath, marker: _readMarkerFile(newPath) };
  }

  if (!newExists && oldExists) {
    return { filename: LEGACY_MARKER_FILENAME, path: oldPath, marker: _readMarkerFile(oldPath) };
  }

  // Both present — dual-marker classification.
  const newMarker = _readMarkerFile(newPath);
  const oldMarker = _readMarkerFile(oldPath);

  if (!newMarker || !oldMarker) {
    throw new Error(
      `[handoff] FATAL — both a project marker and a legacy project marker exist at this ` +
      `directory, and at least one is corrupt/unreadable. Refusing to silently pick one.\n` +
      `  ${newPath} (${newMarker ? 'ok' : 'unreadable/corrupt'})\n` +
      `  ${oldPath} (${oldMarker ? 'ok' : 'unreadable/corrupt'})\n` +
      `  Inspect and resolve both files manually (delete the stale one, or fix the corrupt one).\n`
    );
  }

  if (newMarker.uuid !== oldMarker.uuid) {
    throw new Error(
      `[handoff] FATAL — both a project marker and a legacy project marker exist at this ` +
      `directory with DIFFERENT uuids. Refusing to silently pick one.\n` +
      `  ${newPath} (uuid=${newMarker.uuid})\n` +
      `  ${oldPath} (uuid=${oldMarker.uuid})\n` +
      `  Inspect and resolve manually: delete the stale marker, or confirm which uuid is correct.\n`
    );
  }

  // Same uuid — use the new-name file (canonical read target); the old file is
  // left in place untouched (no rewrite, no dual-write, no auto-delete).
  return { filename: MARKER_FILENAME, path: newPath, marker: newMarker };
}

/**
 * Walk up from startDir looking for a directory containing a .memory-engine
 * file (or, as a read-fallback, a legacy .claude-memory file). Stops at the
 * filesystem root. Returns the directory path or null if not found.
 *
 * The dual-marker check (resolveMarkerAtDir) is applied INLINE at every level
 * of the walk — a directory with both marker files present is resolved (or
 * throws a HARD ERROR) before either returning or ascending past it.
 *
 * @param {string} startDir - Absolute path to start from (typically cwd).
 * @returns {string|null}
 */
function findProjectRootByMarker(startDir) {
  let dir = path.resolve(startDir);
  while (true) {
    const hit = resolveMarkerAtDir(dir); // may throw (dual-marker HARD ERROR)
    if (hit) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break; // filesystem root
    dir = parent;
  }
  return null;
}

/**
 * Read and parse the marker at rootDir, applying the same dual-marker
 * classification as findProjectRootByMarker. Returns null if neither the new
 * nor the legacy marker file is present at rootDir, or the resolved file is
 * itself unparseable (single-marker corrupt case — callers such as
 * ensureProjectIdentity treat a null return as fatal).
 *
 * @param {string} rootDir - Project root directory.
 * @returns {{ uuid: string, created_at: string, schema_version: number }|null}
 * @throws {Error} on the dual-marker HARD ERROR states (see resolveMarkerAtDir).
 */
function readMarker(rootDir) {
  const hit = resolveMarkerAtDir(rootDir); // may throw (dual-marker HARD ERROR)
  if (!hit) return null;
  return hit.marker; // may be null if the single resolved file is corrupt
}

/**
 * Mint a new UUID and write the marker file at rootDir/.memory-engine.
 * NEVER overwrites an existing marker — throws if one already exists
 * (checking BOTH the new and legacy names, per C10).
 *
 * @param {string} rootDir - Project root directory.
 * @returns {{ uuid: string, created_at: string, schema_version: number }}
 */
function writeMarker(rootDir) {
  const uuid = mintUUID();
  return persistMarker(rootDir, uuid);
}

/**
 * Mint a fresh UUID v4 without touching the filesystem.
 *
 * Use when a stable project id is needed before the caller is ready to write
 * the marker file (e.g. cmdInit defers the marker write until after all DB
 * steps succeed, but needs the UUID for DB inserts beforehand).
 *
 * @returns {string} UUID v4 string.
 */
function mintUUID() {
  return crypto.randomUUID();
}

/**
 * Write a marker file using a CALLER-SUPPLIED uuid, always under the NEW
 * marker name (MARKER_FILENAME). NEVER overwrites an existing marker — throws
 * if either the new-name or the legacy-name marker already exists at rootDir
 * (a single-name existence check would be an allow-list of one; C10 requires
 * the total two-name check here).
 *
 * Produces the same JSON shape as writeMarker (uuid, created_at,
 * schema_version). Use together with mintUUID() when the UUID must be known
 * before the marker can be written to disk (deferred-write pattern for init
 * atomicity).
 *
 * @param {string} rootDir - Project root directory.
 * @param {string} uuid    - UUID v4 string minted by mintUUID().
 * @returns {{ uuid: string, created_at: string, schema_version: number }}
 */
function persistMarker(rootDir, uuid) {
  const markerPath       = path.join(rootDir, MARKER_FILENAME);
  const legacyMarkerPath = path.join(rootDir, LEGACY_MARKER_FILENAME);

  if (fs.existsSync(markerPath)) {
    throw new Error(`persistMarker: marker already exists at ${markerPath} — use readMarker() instead`);
  }
  if (fs.existsSync(legacyMarkerPath)) {
    throw new Error(`persistMarker: legacy marker already exists at ${legacyMarkerPath} — use readMarker() instead`);
  }

  if (!isValidUUID(uuid)) {
    throw new Error(`persistMarker: uuid argument is not a valid UUID v4: ${uuid}`);
  }

  const created_at = new Date().toISOString();
  const payload    = {
    uuid,
    created_at,
    schema_version: MARKER_SCHEMA_VER,
  };

  fs.writeFileSync(markerPath, JSON.stringify(payload, null, 2) + '\n', 'utf8');
  return { uuid, created_at, schema_version: MARKER_SCHEMA_VER };
}

/**
 * Read the UUID from an existing marker. Throws if not found or malformed.
 *
 * @param {string} rootDir - Project root directory.
 * @returns {string} UUID string.
 */
function resolveMarkerUUID(rootDir) {
  const marker = readMarker(rootDir);
  if (!marker) {
    throw new Error(
      `resolveMarkerUUID: no valid project marker found at ${path.join(rootDir, MARKER_FILENAME)} ` +
      `(also checked legacy name ${LEGACY_MARKER_FILENAME})`
    );
  }
  return marker.uuid;
}

/**
 * Validate that a string looks like a UUID v4.
 * @param {string} s
 * @returns {boolean}
 */
function isValidUUID(s) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(s);
}

module.exports = {
  MARKER_FILENAME,
  LEGACY_MARKER_FILENAME,
  findProjectRootByMarker,
  resolveMarkerAtDir,   // exported for tests
  readMarker,
  writeMarker,
  mintUUID,
  persistMarker,
  resolveMarkerUUID,
  isValidUUID,  // exported for tests
};
