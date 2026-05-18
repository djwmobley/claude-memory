'use strict';

/**
 * project-marker.js — Marker-borne stable project identity module.
 *
 * A project is identified by a `.claude-memory` marker file at the project root,
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
 * Exported API:
 *   findProjectRootByMarker(startDir) → string|null
 *     Walk up from startDir looking for a .claude-memory file. Returns the
 *     directory containing it, or null if not found.
 *
 *   readMarker(rootDir) → { uuid, created_at, schema_version }|null
 *     Read and parse the marker file at rootDir/.claude-memory.
 *     Returns null if not found or malformed.
 *
 *   writeMarker(rootDir) → { uuid, created_at, schema_version }
 *     Mint a new UUID and write the marker file. Throws if write fails.
 *     Never overwrites an existing marker.
 *
 *   resolveMarkerUUID(rootDir) → string
 *     Read the UUID from an existing marker. Throws if not found or malformed.
 *     Use when the caller knows the marker must exist.
 *
 *   MARKER_FILENAME — '.claude-memory' (exported constant for tests/callers)
 */

const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');

const MARKER_FILENAME   = '.claude-memory';
const MARKER_SCHEMA_VER = 1;

/**
 * Walk up from startDir looking for a directory containing a .claude-memory file.
 * Stops at the filesystem root. Returns the directory path or null if not found.
 *
 * @param {string} startDir - Absolute path to start from (typically cwd).
 * @returns {string|null}
 */
function findProjectRootByMarker(startDir) {
  let dir = path.resolve(startDir);
  while (true) {
    if (fs.existsSync(path.join(dir, MARKER_FILENAME))) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break; // filesystem root
    dir = parent;
  }
  return null;
}

/**
 * Read and parse the marker file at rootDir/.claude-memory.
 * Returns { uuid, created_at, schema_version } or null if missing/malformed.
 *
 * @param {string} rootDir - Project root directory.
 * @returns {{ uuid: string, created_at: string, schema_version: number }|null}
 */
function readMarker(rootDir) {
  const markerPath = path.join(rootDir, MARKER_FILENAME);
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

  // Validate required fields.
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
 * Mint a new UUID and write the marker file at rootDir/.claude-memory.
 * NEVER overwrites an existing marker — throws if one already exists.
 *
 * @param {string} rootDir - Project root directory.
 * @returns {{ uuid: string, created_at: string, schema_version: number }}
 */
function writeMarker(rootDir) {
  const markerPath = path.join(rootDir, MARKER_FILENAME);

  if (fs.existsSync(markerPath)) {
    throw new Error(`writeMarker: marker already exists at ${markerPath} — use readMarker() instead`);
  }

  const uuid       = crypto.randomUUID();
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
      `resolveMarkerUUID: no valid .claude-memory marker found at ${path.join(rootDir, MARKER_FILENAME)}`
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
  findProjectRootByMarker,
  readMarker,
  writeMarker,
  resolveMarkerUUID,
  isValidUUID,  // exported for tests
};
