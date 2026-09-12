'use strict';

/**
 * scratch-engine-root.js — categorical fix for cm#298 CI break: PR #298
 * (schema-manifest.json required_roster growth to include
 * usage-telemetry-schema.sql / feature-usage-schema.sql) broke
 * test/test-schema-heal.js's T9, which built a scratch `scripts/sql/`
 * directory by copying a HAND-TYPED basename list — the list silently
 * omitted both new required files and the run failed with "required
 * schema file missing from scripts/sql/: ...".
 *
 * copySchemaUnits() is the shared, general fix: any test that needs a
 * scratch engine root whose `scripts/sql/` directory classifySchemaFiles()
 * (or the real handoff.js init/ensureSchemaCurrent) will enumerate MUST
 * derive its file list from the real scripts/sql/schema-manifest.json's
 * required_roster, never from a hand-typed array — so the list can never
 * again go stale when required_roster grows. This is a total classification
 * (copy everything the manifest requires, minus an explicit opt-out list)
 * rather than an allow-list a future addition can silently miss.
 */

const fs = require('fs');
const path = require('path');

/**
 * Copy scripts/sql/schema-manifest.json plus every required_roster SQL unit
 * from srcRoot's scripts/sql directory into dstRoot's scripts/sql directory.
 *
 * @param {string} srcRoot - real repo root containing scripts/sql/*.
 * @param {string} dstRoot - scratch root; scripts/sql is created if absent.
 * @param {object} [opts]
 * @param {string[]} [opts.exclude] - required_roster basenames to skip
 *   copying verbatim. Use this ONLY when the caller intentionally applies
 *   its own (e.g. deliberately mutated) version of that file instead --
 *   never to work around a file the caller simply forgot to handle. Callers
 *   must comment why each excluded basename is omitted.
 * @returns {string[]} basenames actually copied, in schema-manifest.json's
 *   required_roster order (minus any excluded).
 */
function copySchemaUnits(srcRoot, dstRoot, opts = {}) {
  const exclude = new Set(opts.exclude || []);
  const srcSqlDir = path.join(srcRoot, 'scripts', 'sql');
  const dstSqlDir = path.join(dstRoot, 'scripts', 'sql');
  fs.mkdirSync(dstSqlDir, { recursive: true });

  const manifestBasename = 'schema-manifest.json';
  const manifestPath = path.join(srcSqlDir, manifestBasename);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (!Array.isArray(manifest.required_roster) || manifest.required_roster.length === 0) {
    throw new Error(`copySchemaUnits: ${manifestPath} required_roster is missing or empty`);
  }

  fs.copyFileSync(manifestPath, path.join(dstSqlDir, manifestBasename));

  const copied = [];
  for (const basename of manifest.required_roster) {
    if (exclude.has(basename)) continue;
    const srcFile = path.join(srcSqlDir, basename);
    if (!fs.existsSync(srcFile)) {
      throw new Error(`copySchemaUnits: required_roster file missing from ${srcSqlDir}: ${basename}`);
    }
    fs.copyFileSync(srcFile, path.join(dstSqlDir, basename));
    copied.push(basename);
  }
  return copied;
}

module.exports = { copySchemaUnits };
