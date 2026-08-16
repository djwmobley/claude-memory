'use strict';

/**
 * test-source-file-normalize.js -- Tests scripts/lib/source-file-normalize.js
 * (CONSOLIDATION-RUNBOOK.md section 6.1(d) amendment D3-2/D3-10, memory-manager#11(d)).
 *
 * Pure unit tests for normalize() -- no DB required. An earlier revision
 * of this module also carried a sqlExpr() companion (a SQL-expression
 * rendering of the same transform) plus a live-Postgres cross-check test
 * for it; both were removed in post-review cleanup once it was confirmed
 * that the shipped migration never matches via a SQL predicate -- it
 * always pulls raw values into JS and calls THIS SAME normalize()
 * function on both the map-builder side and the per-database backfill
 * side. A sqlExpr() with nothing in the shipped code ever calling it
 * implied a dual-path parity that did not exist.
 *
 * Usage: node scripts/test-source-file-normalize.js
 * Exit 0 = all pass; nonzero = any failure.
 */

const { normalize } = require('./lib/source-file-normalize');

let passed = 0;
let failed = 0;

function pass(id, label) { console.log(`[${id}] ${label} ... PASS`); passed++; }
function fail(id, label, reason) { console.log(`[${id}] ${label} ... FAIL: ${reason}`); failed++; }
function assertEqual(actual, expected, msg) {
  if (actual !== expected) throw new Error(`${msg}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

function run(id, label, fn) {
  try {
    fn();
    pass(id, label);
  } catch (err) {
    fail(id, label, err && err.message ? err.message : String(err));
  }
}

function main() {
  run('T1', 'backslash separator normalizes to the same key as forward-slash (D3-2 regression)', () => {
    assertEqual(normalize('memory\\FOO.md'), normalize('memory/FOO.md'), 'backslash vs forward-slash');
    assertEqual(normalize('memory\\FOO.md'), 'foo.md', 'expected canonical form');
  });

  run('T2', 'optional memory/ prefix canonicalized (present vs absent fold to same key)', () => {
    assertEqual(normalize('memory/FOO.md'), normalize('FOO.md'), 'prefixed vs bare');
  });

  run('T3', 'case-fold', () => {
    assertEqual(normalize('MEMORY/Foo.MD'), normalize('memory/foo.md'), 'case-insensitive fold');
  });

  run('T4', 'Unicode NFC normalization', () => {
    // Built from explicit code points, deliberately never a source-literal
    // accented glyph (which a tool in this chain could silently
    // re-normalize on save and defeat the point of the fixture):
    // "e-acute" as a single precomposed codepoint (U+00E9) vs "e"
    // (U+0065) followed by a combining acute accent (U+0301) -- two
    // byte-distinct representations of the same visible glyph that must
    // fold to the identical normalized key.
    const precomposed = 'memory/caf' + String.fromCodePoint(0x00e9) + '.md';
    const decomposed = 'memory/caf' + String.fromCodePoint(0x0065, 0x0301) + '.md';
    if (precomposed === decomposed) throw new Error('test fixture bug: the two forms must be byte-distinct before normalization');
    assertEqual(normalize(precomposed), normalize(decomposed), 'NFC-equivalent forms fold to same key');
  });

  run('T5', 'leading slash stripped defensively', () => {
    assertEqual(normalize('/memory/foo.md'), normalize('memory/foo.md'), 'leading slash');
  });

  run('T6', 'duplicate slashes collapsed', () => {
    assertEqual(normalize('memory//foo.md'), normalize('memory/foo.md'), 'duplicate slash collapse');
  });

  run('T7', 'leading/trailing whitespace trimmed', () => {
    assertEqual(normalize('  memory/foo.md  '), normalize('memory/foo.md'), 'whitespace trim');
  });

  run('T8', 'null/undefined total-classified to null (never thrown)', () => {
    assertEqual(normalize(null), null, 'null input');
    assertEqual(normalize(undefined), null, 'undefined input');
  });

  run('T9', 'non-string input throws TypeError (caller bug surfaced loudly)', () => {
    let threw = false;
    try { normalize(42); } catch (err) { threw = err instanceof TypeError; }
    if (!threw) throw new Error('expected a TypeError for numeric input');
  });

  run('T10', 'a bare filename with no memory/ prefix and no path separators normalizes to itself, case-folded', () => {
    assertEqual(normalize('MEMORY.md'), 'memory.md', 'bare MEMORY.md');
  });

  run('T11', 'distinct files remain distinct after normalization (non-collapsing sanity check)', () => {
    const a = normalize('memory/alpha.md');
    const b = normalize('memory/beta.md');
    if (a === b) throw new Error('two genuinely different files must not normalize to the same key');
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exitCode = failed > 0 ? 1 : 0;
}

main();
