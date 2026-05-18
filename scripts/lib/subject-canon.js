'use strict';

/**
 * subject-canon.js — Prospective subject canonicalization (spine step 5, Option 2).
 *
 * Canonicalization pipeline (applied in order):
 *   1. trim()            — strip leading/trailing whitespace
 *   2. toLowerCase()     — case-fold to lowercase
 *   3. collapse internal whitespace to single spaces (\s+ → ' ')
 *   4. alias-map lookup  — if the normalized form has an entry in the alias map,
 *                          replace it with the mapped canonical value
 *
 * The alias map (scripts/lib/subject-alias-map.json) stores keys in already-normalized
 * form (trim + lowercase + collapsed).  Alias lookup is therefore a direct string
 * comparison on the already-normalized form — no second normalization pass needed.
 *
 * §7 constraint (absolute): this module NEVER rewrites existing stored subjects.
 * It is called only at the write path for NEW incoming subjects and at the
 * canonical-match step that identifies prior rows to supersede.  Existing rows
 * in the database are never touched.
 *
 * Idempotency invariant: canonicalize(canonicalize(x)) === canonicalize(x) for
 * all x.  The alias map values are themselves stored in normalized form so a
 * second pass over a value that was already mapped will resolve to the same
 * result.
 *
 * Exports:
 *   canonicalize(subject)   — string → canonical string
 *   loadAliasMap()          — returns the parsed alias map (cached after first load)
 */

const fs   = require('fs');
const path = require('path');

// ── Alias map ─────────────────────────────────────────────────────────────────

// Cached alias map.  Populated on first call to loadAliasMap().
let _aliasMapCache = null;

/**
 * Load and return the alias map.
 * Keys and values are both in normalized form (trim+lowercase+collapse).
 * Non-string/private/comment keys (those starting with '_') are excluded.
 */
function loadAliasMap() {
  if (_aliasMapCache !== null) return _aliasMapCache;

  const mapPath = path.resolve(__dirname, 'subject-alias-map.json');
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(mapPath, 'utf8'));
  } catch (_) {
    // If the file is missing or unparseable, return an empty map rather than
    // crashing — canonicalization degrades to normalize-only mode.
    _aliasMapCache = Object.create(null);
    return _aliasMapCache;
  }

  const map = Object.create(null);
  for (const [k, v] of Object.entries(raw)) {
    if (k.startsWith('_')) continue; // skip comment/metadata keys
    if (typeof v !== 'string') continue; // skip non-string values
    map[k] = v;
  }
  _aliasMapCache = map;
  return _aliasMapCache;
}

/**
 * Reset the alias map cache.  Used by tests that need to inject a custom map.
 */
function resetAliasMapCache() {
  _aliasMapCache = null;
}

// ── Core normalize helper ─────────────────────────────────────────────────────

/**
 * Normalize a subject string: trim + lowercase + collapse internal whitespace.
 * Does NOT apply alias-map lookup.  Used internally and exported so tests can
 * verify the normalize step independently from the alias step.
 *
 * @param {string} subject
 * @returns {string}
 */
function normalize(subject) {
  if (typeof subject !== 'string') return subject;
  return subject
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Canonicalize a subject string.
 *
 * Pipeline: normalize → alias-map lookup → return canonical form.
 *
 * @param {string} subject  — incoming subject (raw, from payload or stored row)
 * @returns {string}        — canonical subject
 */
function canonicalize(subject) {
  const normed = normalize(subject);
  const aliasMap = loadAliasMap();
  if (Object.prototype.hasOwnProperty.call(aliasMap, normed)) {
    return aliasMap[normed];
  }
  return normed;
}

// ── Exports ───────────────────────────────────────────────────────────────────

module.exports = { canonicalize, normalize, loadAliasMap, resetAliasMapCache };
