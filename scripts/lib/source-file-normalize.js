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
 *   - the SQL-side matching (the same script's per-database backfill,
 *     which reads each corpus database's own LIVE `source_file` column
 *     values and must fold them onto the SAME normalized key space before
 *     looking them up in the map).
 *
 * D3-2 is explicit about why this has to be a SINGLE shared function
 * rather than two independently-hand-written implementations (one JS, one
 * SQL): "Verified live: stored source_file values use backslash; an
 * un-normalized join matches ZERO rows." A drift between two
 * hand-maintained normalizers (one in JS, one restated in SQL) is exactly
 * the kind of silent-divergence bug that produced that zero-row join in
 * the first place. This module is imported directly by both call sites —
 * never re-implemented inline at either one.
 *
 * normalize() is a total function over any input: separators normalized
 * to posix ('/'), Unicode NFC-normalized, an optional leading "memory/"
 * path segment canonicalized away (so "memory/FOO.md" and "FOO.md" fold
 * to the same key), and case-folded (lower-cased). null/undefined input
 * normalizes to null (a NULL `source_file` column value is a legitimate,
 * total case — never an exception). Any other non-string input is a
 * TypeError: a caller passing a number/object/etc. has a bug worth
 * surfacing loudly, not silently coercing.
 *
 * sqlExpr() renders the SAME transform as a Postgres SQL expression
 * string over an arbitrary column/parameter reference, for callers that
 * need to express the identical normalization inside a SQL predicate
 * (rather than pulling rows into JS first). It is verified against
 * normalize() by test/lib/test-source-file-normalize.js's cross-check
 * suite (round-tripping backslash/forward-slash/prefixed/unprefixed/
 * mixed-case fixtures through a live Postgres connection and asserting
 * byte-for-byte equality with the JS output) — this is what makes "used
 * identically" a verified property rather than an assertion.
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

/**
 * Render the SAME normalization as a Postgres SQL expression over an
 * arbitrary SQL text fragment (a quoted column reference, a parameter
 * placeholder like "$1", or a literal). The caller is responsible for
 * ensuring `colExpr` is safe to splice into SQL text (a column reference
 * or a parameter placeholder — never untrusted user input).
 *
 * Mirrors normalize()'s seven steps in SQL:
 *   1. normalize(<expr>, NFC)               -- Unicode NFC (Postgres 13+)
 *   2. replace(..., '\', '/')                -- backslash -> forward slash
 *   3. trim(...)                             -- leading/trailing whitespace
 *   4. regexp_replace(..., '^/+', '')        -- strip leading slash(es)
 *   5. regexp_replace(..., '/+', '/', 'g')   -- collapse duplicate slashes
 *   6. lower(...)                            -- case-fold
 *   7. regexp_replace(..., '^memory/', '')   -- strip optional prefix
 *      (safe post-lower(): the literal is already lower-case, so this is
 *      a plain, non-'i'-flagged match — kept deliberately simple rather
 *      than matching case-insensitively on already-lower-cased text.)
 *
 * @param {string} colExpr - SQL text for the column/parameter to normalize.
 * @returns {string} A SQL expression string producing the normalized value.
 */
function sqlExpr(colExpr) {
  if (typeof colExpr !== 'string' || !colExpr.trim()) {
    throw new TypeError('source-file-normalize.sqlExpr: colExpr must be a non-empty SQL text fragment');
  }
  return (
    `regexp_replace(` +
      `lower(` +
        `regexp_replace(` +
          `regexp_replace(` +
            `trim(replace(normalize(${colExpr}, NFC), '\\', '/'))` +
          `, '^/+', '')` +
        `, '/+', '/', 'g')` +
      `)` +
    `, '^memory/', '')`
  );
}

module.exports = {
  normalize,
  sqlExpr,
  MEMORY_PREFIX,
};
