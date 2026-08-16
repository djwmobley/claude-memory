'use strict';

/**
 * fs-source-path.js
 *
 * One shared path normalizer for `source_db='filesystem:<path>'`
 * migration_manifest keys (CONSOLIDATION-RUNBOOK.md §6.1(h)'s H-14
 * amendment: "One shared path normalizer for `source_db='filesystem:<path>'`
 * manifest keys: forward slashes, uppercase drive letter — same function
 * authors roster entries").
 *
 * §6.1(h)'s own migrate-08-handoff-markdown.js has not shipped in this repo
 * as of this PR (§6.1(i) is being authored first — there is nothing to
 * import). This module is created here, generically (no dependency on
 * migrate-09-specific code), so that whichever of (h)/(i) lands second can
 * import it BY REFERENCE rather than forking a second copy. If (h) ships
 * its own equivalent module first in a sibling PR, that PR's author (or an
 * independent reviewer) reconciles the duplicate — this module's shape is
 * intentionally small and dependency-free to make that reconciliation
 * cheap either direction.
 */

const path = require('path');

/**
 * Normalize an absolute filesystem path for use inside a
 * `source_db='filesystem:<path>'` manifest key: resolved to absolute,
 * backslashes converted to forward slashes, and a leading Windows drive
 * letter (if present) uppercased. POSIX paths (no drive letter) pass
 * through the drive-letter step unchanged.
 *
 * @param {string} absPath
 * @returns {string}
 */
function normalizeFsSourcePath(absPath) {
  let p = path.resolve(absPath).replace(/\\/g, '/');
  p = p.replace(/^([a-zA-Z]):/, (_, drive) => `${drive.toUpperCase()}:`);
  return p;
}

/**
 * Build the full `source_db` value migration_manifest/
 * migration_manifest_row_hashes rows use for a filesystem-sourced slice:
 * `filesystem:<normalized absolute path>`.
 *
 * @param {string} absPath
 * @returns {string}
 */
function fsSourceDb(absPath) {
  return `filesystem:${normalizeFsSourcePath(absPath)}`;
}

module.exports = { normalizeFsSourcePath, fsSourceDb };
