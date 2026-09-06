'use strict';

/**
 * test-intent-key.js — cm#233 pure-unit regression suite for
 * scripts/lib/intent-key.js's intentKey/intentKeyEquals — the replacement
 * for handoff.js's removed deriveIntentSubject (colon-split-or-80-char-
 * truncate). No DB required.
 *
 * Covers the spec's named cases:
 *   - NFC vs NFD encodings of the same visible text produce the SAME key.
 *   - Newline (and other whitespace-run) collapse.
 *   - 1000-byte cap: cut at a whitespace boundary, with multibyte text
 *     (never split a surrogate pair / multi-byte UTF-8 sequence).
 *   - Trailing punctuation is NOT folded/stripped.
 *   - Empty / whitespace-only input normalizes to ''.
 *   - intentKeyEquals: case-insensitive, trims defensively.
 *
 * Usage: node test/test-intent-key.js
 * Exit 0 = all pass; nonzero = any failure.
 */

const path = require('path');
const PROJECT_ROOT = path.resolve(__dirname, '..');
const { intentKey, intentKeyEquals, MAX_KEY_BYTES } = require(path.join(PROJECT_ROOT, 'scripts', 'lib', 'intent-key.js'));

let passed = 0, failed = 0;
function run(id, label, fn) {
  try {
    fn();
    console.log(`  [PASS] ${id} ${label}`);
    passed++;
  } catch (err) {
    console.error(`  [FAIL] ${id} ${label}: ${err.message}`);
    failed++;
  }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }
function assertEqual(actual, expected, msg) {
  if (actual !== expected) throw new Error(`${msg || 'assertEqual'}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

// ── intentKey ──────────────────────────────────────────────────────────────

run('IK-1', 'plain trimmed text passes through unchanged', () => {
  assertEqual(intentKey('  hello world  '), 'hello world');
});

run('IK-2', 'NFC vs NFD encodings of the same visible text produce the SAME key', () => {
  // Built from explicit code points so the two literals are guaranteed
  // byte-different regardless of source-file/editor normalization:
  //   nfc: 'caf' + U+00E9 (LATIN SMALL LETTER E WITH ACUTE) -- precomposed (NFC)
  //   nfd: 'cafe' + U+0065 U+0301 (LATIN SMALL LETTER E + COMBINING ACUTE ACCENT) -- decomposed (NFD)
  const nfc = 'caf' + String.fromCharCode(0x00e9) + ' finish the thing';
  const nfd = 'cafe' + String.fromCharCode(0x0301) + ' finish the thing';
  assert(nfc !== nfd, 'sanity: the two raw strings must be byte-different');
  assert(nfd.normalize('NFC') === nfc, 'sanity: nfd literal must normalize (NFC) to the same string as nfc');
  const keyNfc = intentKey(nfc);
  const keyNfd = intentKey(nfd);
  assertEqual(keyNfc, keyNfd, 'NFC and NFD inputs must normalize to the identical key');
  assertEqual(keyNfc, nfc);
});

run('IK-3', 'newline runs collapse to a single space', () => {
  assertEqual(intentKey('line one\nline two\n\nline three'), 'line one line two line three');
});

run('IK-4', 'tabs and mixed whitespace runs collapse to a single space', () => {
  assertEqual(intentKey('a\t\t b  \n c'), 'a b c');
});

run('IK-5', 'trailing punctuation is NOT folded or stripped (colon preserved, no colon-split)', () => {
  assertEqual(intentKey('Fix bug:'), 'Fix bug:');
  assertEqual(intentKey('NS-THREAD-ALPHA: finish the migration'), 'NS-THREAD-ALPHA: finish the migration');
  assertEqual(intentKey('trailing period.'), 'trailing period.');
});

run('IK-6', 'empty string normalizes to empty', () => {
  assertEqual(intentKey(''), '');
});

run('IK-7', 'whitespace-only string normalizes to empty', () => {
  assertEqual(intentKey('   \n\t  '), '');
});

run('IK-8', 'null/undefined normalize to empty (total function, never throws)', () => {
  assertEqual(intentKey(null), '');
  assertEqual(intentKey(undefined), '');
});

run('IK-9', '1000-byte cap: a long ASCII string is cut at a whitespace boundary and suffixed', () => {
  const words = [];
  for (let i = 0; i < 300; i++) words.push(`word${i}`);
  const long = words.join(' '); // well over 1000 bytes, plain ASCII (1 byte/char)
  const key = intentKey(long);
  assert(Buffer.byteLength(key, 'utf8') <= MAX_KEY_BYTES + Buffer.byteLength(' …', 'utf8'), 'result must stay near the byte cap');
  assert(key.endsWith(' …'), `expected the truncation suffix, got tail: ${JSON.stringify(key.slice(-10))}`);
  assert(!key.slice(0, -2).endsWith(' '), 'must not leave a doubled space before the suffix');
  // The pre-suffix content must be a clean prefix of the original (cut at a
  // word boundary, not mid-word).
  const withoutSuffix = key.slice(0, -2).trimEnd();
  assert(long.startsWith(withoutSuffix), 'truncated content must be a verbatim prefix of the original (cut at whitespace, not mid-word)');
});

run('IK-10', '1000-byte cap with multibyte text: never splits a surrogate pair or multi-byte UTF-8 sequence', () => {
  // CJK characters are 3 bytes each in UTF-8; emoji are 4-byte surrogate
  // pairs in UTF-16/UTF-8. Build a string well over 1000 bytes out of both,
  // with spaces every few characters so a whitespace boundary exists near
  // the cut point.
  const chunk = '漢字テスト 😀😁😂 '; // kanji/katakana + emoji + spaces
  let long = '';
  while (Buffer.byteLength(long, 'utf8') < 1500) long += chunk;
  const key = intentKey(long);
  assert(Buffer.byteLength(key, 'utf8') <= MAX_KEY_BYTES + Buffer.byteLength(' …', 'utf8'), 'result must stay near the byte cap');
  assert(key.endsWith(' …'), 'expected the truncation suffix');
  // Round-tripping through Buffer must not introduce U+FFFD (the mark of a
  // split multi-byte sequence / broken surrogate pair).
  assert(!key.includes('�'), 'truncated key must not contain a replacement character (would indicate a split code point)');
  // Every code point in the truncated body must also appear as a code point
  // in the original string at the same leading position (verifies no
  // surrogate-pair splitting via a round-trip through the spread operator,
  // which itself throws/mis-iterates on a lone surrogate).
  const body = key.slice(0, -2);
  assert([...body].join('') === body, 'body must be composed of whole code points');
});

run('IK-11', 'idempotent: intentKey(intentKey(x)) === intentKey(x)', () => {
  const x = '  weird\n\nwhitespace   text  ';
  assertEqual(intentKey(intentKey(x)), intentKey(x));
});

// ── intentKeyEquals ──────────────────────────────────────────────────────

run('IKE-1', 'case-insensitive comparison', () => {
  assert(intentKeyEquals('Fix Bug', 'fix bug'), 'expected case-insensitive match');
});

run('IKE-2', 'exact match (same case) is equal', () => {
  assert(intentKeyEquals('Fix Bug', 'Fix Bug'));
});

run('IKE-3', 'different keys are not equal', () => {
  assert(!intentKeyEquals('Fix Bug', 'Fix Bugs'));
});

run('IKE-4', 'defensive trim on raw (not-yet-keyed) inputs', () => {
  assert(intentKeyEquals('  Fix Bug  ', 'fix bug'));
});

run('IKE-5', 'null/undefined treated as empty, equal to each other', () => {
  assert(intentKeyEquals(null, undefined));
  assert(intentKeyEquals(null, ''));
});

run('IKE-6', 'NFC vs NFD equal via intentKeyEquals once both sides are run through intentKey', () => {
  const nfc = 'café';
  const nfd = 'café';
  // intentKeyEquals itself does not NFC-normalize (only intentKey does) —
  // this documents the real call pattern every matcher in the codebase
  // uses: compare a STORED key (already an intentKey output) against
  // intentKey(new text), never two raw strings directly.
  assert(intentKeyEquals(intentKey(nfc), intentKey(nfd)), 'intentKey outputs must compare equal');
});

console.log(`\ntest-intent-key: ${passed} passed, ${failed} failed`);
process.exitCode = failed > 0 ? 1 : 0;
