'use strict';

/**
 * source-file-normalize.js
 *
 * CONSOLIDATION-RUNBOOK.md §6.1(d), amendment D3-2/D3-10 (2026-08-16,
 * memory-manager#11(d)): ONE shared normalization module for
 * `memory_entries.source_file` / `memory_entry_chunks` values, used
 * IDENTICALLY by both:
 *
 *   - the map-builder (scripts/migrations/migrate-03-corpus-project-id.js's
 *     filesystem walk over ~/.claude/projects/<encoded-cwd>/memory/*.md,
 *     turning each listed filename into a normalized key), and
 *   - the per-database backfill's matching step (the same script reads
 *     each corpus database's own LIVE, raw `source_file` column values via
 *     a plain SELECT, then calls THIS SAME normalize() function on each one
 *     — in JS, not a hand-ported SQL twin — before looking the result up
 *     in the map).
 *
 * Both call sites invoke this ONE function. There is deliberately no
 * separate SQL-expression form of this transform: an earlier revision
 * carried a `sqlExpr()` companion for a SQL-predicate-based matching path,
 * but the shipped migration never matches via a SQL predicate — it always
 * pulls raw values into JS first and normalizes there on both sides. A
 * function that renders "the same transform in SQL" with nothing in the
 * shipped code ever calling it would imply a dual-path parity that does
 * not exist and cannot drift-guard anything real; it was removed rather
 * than kept as unexercised, misleading surface area. D3-2's underlying
 * concern — "verified live: stored source_file values use backslash; an
 * un-normalized join matches ZERO rows" — is closed by there being exactly
 * ONE normalization implementation that both sides import, not by having
 * two implementations (JS and SQL) that could silently drift apart.
 *
 * normalize() is a total function over any input: separators normalized
 * to posix ('/'), Unicode NFC-normalized, an optional leading "memory/"
 * path segment canonicalized away (so "memory/FOO.md" and "FOO.md" fold
 * to the same key), and case-folded (lower-cased). null/undefined input
 * normalizes to null (a NULL `source_file` column value is a legitimate,
 * total case — never an exception). Any other non-string input is a
 * TypeError: a caller passing a number/object/etc. has a bug worth
 * surfacing loudly, not silently coercing.
 */

const MEMORY_PREFIX = 'memory/';

/**
 * Normalize a source_file value into its canonical comparison key.
 *
 * Total classification of the input:
 *   - null or undefined                → null (a legitimate NULL source_file)
 *   - a string (including empty)       → normalized string (see steps below)
 *   - anything else (number/object/…)  → TypeError (caller bug, never coerced)
 *
 * Steps applied to a string input, IN ORDER (order matters — see the
 * header comment on why NFC precedes case-folding):
 *   1. Unicode NFC normalization (`.normalize('NFC')`).
 *   2. Backslash separators -> forward slash ('\\' -> '/').
 *   3. Trim leading/trailing whitespace.
 *   4. Strip any leading slash(es) (defensive: a value stored with a
 *      leading '/' before the "memory/" segment, e.g. "/memory/x.md",
 *      must fold onto the same key as "memory/x.md").
 *   5. Collapse runs of duplicate slashes to one.
 *   6. Case-fold (`.toLowerCase()`).
 *   7. Strip a single leading "memory/" path segment, if present — the
 *      optional-prefix canonicalization (D3-2): a value stored as
 *      "memory/FOO.md" and a value stored as bare "FOO.md" fold onto the
 *      identical key "foo.md".
 *
 * @param {string|null|undefined} sourceFile
 * @returns {string|null}
 */
function normalize(sourceFile) {
  if (sourceFile === null || typeof sourceFile === 'undefined') return null;
  if (typeof sourceFile !== 'string') {
    throw new TypeError(`source-file-normalize.normalize: expected a string or null/undefined, got ${typeof sourceFile}`);
  }
  let s = sourceFile.normalize('NFC');
  s = s.replace(/\\/g, '/');
  s = s.trim();
  s = s.replace(/^\/+/, '');
  s = s.replace(/\/+/g, '/');
  s = s.toLowerCase();
  if (s.startsWith(MEMORY_PREFIX)) {
    s = s.slice(MEMORY_PREFIX.length);
  }
  return s;
}

module.exports = {
  normalize,
  MEMORY_PREFIX,
};
