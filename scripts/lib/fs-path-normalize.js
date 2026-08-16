'use strict';

/**
 * fs-path-normalize.js — the ONE shared filesystem-path normalizer for
 * `source_db='filesystem:<path>'` migration_manifest / source-table-roster
 * keys (CONSOLIDATION-RUNBOOK.md §6.1(h)'s H-14 amendment,
 * memory-manager#11(h)).
 *
 * H-14: "One shared path normalizer for source_db='filesystem:<path>'
 * manifest keys: forward slashes, uppercase drive letter — same function
 * authors roster entries." Deliberately placed in scripts/lib/ (not inside
 * migrate-08-handoff-markdown.js) so §6.1(i)'s author (phase (i),
 * migrate-09-file-memory-markdown.js — also a filesystem-sourced markdown
 * migration) can import the SAME function rather than hand-rolling a
 * second path normalizer that could silently drift from this one (the
 * exact "second hand-maintained classifier" hazard this codebase's canon
 * forbids elsewhere — see verify15-shared.js's classifyRosterSourceDb
 * header comment for the sibling precedent).
 *
 * Design (this file's own decision, since no prior art in this repo
 * normalizes filesystem paths for a manifest key):
 *   - backslash -> forward slash (Windows path separator normalized to the
 *     POSIX form migration_manifest.source_db already uses for its other
 *     `filesystem:` example, scripts/migrations/source-table-roster.
 *     example.json's `filesystem:/path/to/HANDOFF.md` entry).
 *   - a leading drive-letter prefix (`c:`, `C:`) is upper-cased (`C:`) —
 *     Windows drive letters are case-insensitive at the OS level but a
 *     manifest key comparison is a plain string equality; without this,
 *     `c:/Users/...` and `C:/Users/...` would silently be treated as two
 *     DIFFERENT sources by every downstream `source_db` string match
 *     (migration_manifest lookups, T1/T3 reconciliation, roster matching).
 *   - no other case-folding: the rest of the path is left exactly as
 *     given (Windows paths are case-insensitive on the filesystem but NOT
 *     necessarily on every consumer of this string, and over-folding risks
 *     masking a genuinely different path on case-sensitive filesystems —
 *     narrowest normalization that resolves the actual observed collision
 *     class, not a blanket case-fold).
 *   - relative paths are resolved to absolute via `path.resolve()` BEFORE
 *     slash/drive normalization, so two different working directories
 *     naming the "same" relative path never collide under different keys,
 *     and so the manifest key is stable regardless of where the migration
 *     script happens to be invoked from.
 */

const path = require('path');

const DRIVE_LETTER_RE = /^([a-zA-Z]):/;

/**
 * normalizeFsPath — resolve to absolute, forward-slash the separators,
 * upper-case a leading drive letter. Pure, total (never throws on a
 * string input; non-string input is coerced via String()).
 *
 * @param {string} p
 * @returns {string}
 */
function normalizeFsPath(p) {
  const raw = String(p == null ? '' : p);
  const absolute = path.resolve(raw);
  let normalized = absolute.replace(/\\/g, '/');
  normalized = normalized.replace(DRIVE_LETTER_RE, (_m, letter) => `${letter.toUpperCase()}:`);
  return normalized;
}

/**
 * filesystemSourceDb — builds the exact `source_db` string convention this
 * migration (and any sibling filesystem-sourced migration, e.g. phase (i))
 * uses for migration_manifest / source-table-roster.json rows.
 *
 * @param {string} p
 * @returns {string} e.g. "filesystem:C:/Users/example/project/HANDOFF.md"
 */
function filesystemSourceDb(p) {
  return `filesystem:${normalizeFsPath(p)}`;
}

module.exports = {
  normalizeFsPath,
  filesystemSourceDb,
};
