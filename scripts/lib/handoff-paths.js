'use strict';

/**
 * handoff-paths.js — single source of truth for two host-configurable paths:
 *
 *   - resolveHandoffMdPath(projectId)   — where handoff.md lives for a project.
 *   - resolvePromotionFilePath(root)    — the durable-facts promotion target file.
 *
 * Both were previously hardcoded (path.join(os.homedir(), '.claude', ...) and a
 * literal 'CLAUDE.md') at multiple call sites across handoff.js,
 * project-identity.js, and scripts/lib/test-pg-helpers.js (#135 — host-agnostic
 * naming). Centralizing them here means every caller sees identical env-var
 * validation and defaulting behavior; a hand-rolled parallel copy is exactly
 * the drift risk this module exists to remove — callers MUST import from here,
 * never restate the resolution logic locally.
 */

const fs   = require('fs');
const os   = require('os');
const path = require('path');

const { MARKER_FILENAME, LEGACY_MARKER_FILENAME } = require('./project-marker');

const DEFAULT_PROMOTION_FILENAME = 'CLAUDE.md';
const HANDOFF_MD_FILENAME        = 'handoff.md';

/**
 * Resolve the base directory that houses `projects/<id>/handoff.md`.
 *
 * Total classification of HANDOFF_BASE_DIR (every input maps to a branch;
 * unset/failure is always the safe default branch):
 *   - unset, or trims to empty        → default: path.join(os.homedir(), '.claude')
 *   - set (non-empty after trim), win32:
 *       must match /^[a-zA-Z]:[\\/]/ (drive-letter-rooted). path.isAbsolute()
 *       ALONE is insufficient: an MSYS/Git-Bash-style value like '/c/Users/x'
 *       passes path.isAbsolute() but is drive-RELATIVE to native Windows APIs
 *       (the MSYS trap) — rejected with a message showing the corrected form.
 *   - set (non-empty after trim), POSIX:
 *       must start with '/' — else HARD ERROR.
 *
 * The SAME trimmed string is used for both the validation check and the actual
 * path.join — never trim-for-check-but-raw-for-join (that divergence would let
 * a value that failed validation slip through untrimmed at the join site).
 *
 * @returns {string} absolute base directory
 * @throws {Error} if HANDOFF_BASE_DIR is set but not a valid absolute path for
 *                 the current platform.
 */
function resolveBaseDir() {
  const raw     = process.env.HANDOFF_BASE_DIR;
  const trimmed = typeof raw === 'string' ? raw.trim() : '';

  if (trimmed === '') {
    return path.join(os.homedir(), '.claude');
  }

  if (process.platform === 'win32') {
    if (!/^[a-zA-Z]:[\\/]/.test(trimmed)) {
      throw new Error(
        `HANDOFF_BASE_DIR is set to '${trimmed}', which is not a drive-letter-rooted Windows ` +
        `path. path.isAbsolute() alone is not sufficient here: MSYS/Git-Bash-style values such ` +
        `as '/c/Users/you/.claude' PASS path.isAbsolute() but resolve as drive-RELATIVE paths ` +
        `to native Windows APIs (the classic MSYS translation trap). Use a drive-letter-rooted ` +
        `form instead, e.g. 'C:\\Users\\you\\.claude'.`
      );
    }
  } else if (!trimmed.startsWith('/')) {
    throw new Error(
      `HANDOFF_BASE_DIR is set to '${trimmed}', which is not an absolute POSIX path. It must ` +
      `start with '/', e.g. '/home/you/.claude'.`
    );
  }

  return trimmed;
}

/**
 * Resolve the projects/<projectId>/handoff.md path (honors HANDOFF_BASE_DIR;
 * defaults to ~/.claude/projects/<projectId>/handoff.md).
 *
 * @param {string} projectId
 * @returns {string}
 */
function resolveHandoffMdPath(projectId) {
  return path.join(resolveBaseDir(), 'projects', projectId, HANDOFF_MD_FILENAME);
}

/**
 * Return true if `name` case-insensitively collides with a reserved root
 * filename (the project marker names, or handoff.md itself). This is a
 * deny-list of names that would corrupt project state if used as the
 * promotion target — NOT an allow-list; every other bare filename is accepted
 * (see resolvePromotionFilePath).
 *
 * @param {string} name
 * @returns {boolean}
 */
function _isReservedPromotionName(name) {
  const lower = name.toLowerCase();
  return [MARKER_FILENAME, LEGACY_MARKER_FILENAME, HANDOFF_MD_FILENAME].some(
    (reserved) => reserved.toLowerCase() === lower
  );
}

/**
 * If a case-insensitive match for `filename` already exists on disk at
 * `root`, reuse the ON-DISK casing instead of the raw requested name — this
 * prevents an NTFS-vs-ext4 split (two logically-identical files differing
 * only in case) when the same project is used from both a case-insensitive
 * and a case-sensitive filesystem across machines/clones.
 *
 * @param {string} root
 * @param {string} filename
 * @returns {string}
 */
function _reuseOnDiskCasing(root, filename) {
  let entries;
  try {
    entries = fs.readdirSync(root);
  } catch (_) {
    return filename; // root doesn't exist yet, or is unreadable -- nothing to reuse.
  }
  const lower = filename.toLowerCase();
  for (const entry of entries) {
    if (entry !== filename && entry.toLowerCase() === lower) {
      return entry;
    }
  }
  return filename;
}

/**
 * Resolve the durable-facts promotion target filename under `root`.
 *
 * Total classification of HANDOFF_PROMOTION_FILE (every input maps to a
 * branch; unset/failure is always the safe default or an explicit HARD ERROR
 * — there is no allow-list, only a small reserved-name deny-list):
 *   - trimmed-empty (unset, empty, or whitespace-only)  → default 'CLAUDE.md'
 *   - value !== value.trim()                            → HARD ERROR
 *       (Win32 silently strips trailing spaces from filenames; POSIX creates
 *        a DISTINCT file with the space intact — reject rather than pick a
 *        platform-dependent interpretation.)
 *   - contains '/' or '\\', a '..' segment, or is an absolute path
 *                                                         → HARD ERROR
 *       (the promotion target is always resolved relative to the project
 *        root; it is never a path.)
 *   - case-insensitively equals MARKER_FILENAME, LEGACY_MARKER_FILENAME, or
 *     'handoff.md'                                       → HARD ERROR
 *       (using one of these would corrupt the project marker or the session
 *        handoff file.)
 *   - anything else                                      → accepted filename,
 *       then case-collision handling: reuse the on-disk casing if a
 *       case-insensitive match already exists at root.
 *
 * @param {string} root - Project root directory.
 * @returns {string} absolute path to the promotion target file.
 * @throws {Error} on any of the HARD ERROR branches above.
 */
function resolvePromotionFilePath(root) {
  const raw     = process.env.HANDOFF_PROMOTION_FILE;
  const trimmed = typeof raw === 'string' ? raw.trim() : '';

  let filename;
  if (trimmed === '') {
    filename = DEFAULT_PROMOTION_FILENAME;
  } else if (raw !== trimmed) {
    throw new Error(
      `HANDOFF_PROMOTION_FILE is set to ${JSON.stringify(raw)}, which has leading or trailing ` +
      `whitespace. Win32 silently strips trailing spaces from filenames while POSIX creates a ` +
      `DISTINCT file with the space intact — rejecting rather than picking a platform-dependent ` +
      `interpretation. Remove the whitespace: '${trimmed}'.`
    );
  } else if (/[\\/]/.test(trimmed) || trimmed.split(/[\\/]/).some((seg) => seg === '..') || path.isAbsolute(trimmed)) {
    throw new Error(
      `HANDOFF_PROMOTION_FILE is set to '${trimmed}', which is not a bare filename. It must not ` +
      `contain '/' or '\\\\', a '..' segment, or be an absolute path — the promotion target is ` +
      `always resolved relative to the project root.`
    );
  } else if (_isReservedPromotionName(trimmed)) {
    throw new Error(
      `HANDOFF_PROMOTION_FILE is set to '${trimmed}', which collides (case-insensitively) with a ` +
      `reserved root filename (${MARKER_FILENAME}, ${LEGACY_MARKER_FILENAME}, or ${HANDOFF_MD_FILENAME}). ` +
      `Using one of these would corrupt the project marker or the session handoff file.`
    );
  } else {
    filename = trimmed;
  }

  filename = _reuseOnDiskCasing(root, filename);
  return path.join(root, filename);
}

module.exports = {
  resolveBaseDir,           // exported for tests
  resolveHandoffMdPath,
  resolvePromotionFilePath,
  DEFAULT_PROMOTION_FILENAME, // exported for tests
};
