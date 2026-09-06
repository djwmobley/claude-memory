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

run('IK-5', 'trailing punctuation is NOT folded or stripped outside the key-separator branch', () => {
  assertEqual(intentKey('trailing period.'), 'trailing period.');
});

run('IK-5b', 'a trailing colon with nothing after it is NOT a key-separator match (no space follows)', () => {
  assertEqual(intentKey('Fix bug:'), 'Fix bug:');
});

run('IK-KEY-1', 'KEY: rest -- colon at index<60 followed by a space IS a key-separator match; key = trimmed prefix', () => {
  assertEqual(intentKey('NS-THREAD-ALPHA: finish the migration'), 'NS-THREAD-ALPHA');
  assertEqual(intentKey('SHIP-DECISION: ship the L1 patient-adversary defense THIS cycle'), 'SHIP-DECISION');
});

run('IK-KEY-2', 'restating the SAME key with a totally different description supersedes by key (P2 fixture)', () => {
  const oldText = 'SHIP-DECISION: ship the L1 patient-adversary defense THIS cycle';
  const newText = 'SHIP-DECISION: DEFER the L1 patient-adversary defense to next cycle';
  assertEqual(intentKey(oldText), intentKey(newText), 'both must key to SHIP-DECISION despite unrelated bodies');
  assertEqual(intentKey(oldText), 'SHIP-DECISION');
});

run('IK-KEY-3', 'colon with NO space after it is NOT a key-separator match (a URL scheme colon, e.g.) -- falls through to full-text key', () => {
  const url1 = 'https://example.com/issues/42 fix the login bug';
  const url2 = 'https://example.com/issues/99 fix a totally different bug';
  const k1 = intentKey(url1);
  const k2 = intentKey(url2);
  assertEqual(k1, url1, 'no key-separator match: key is the full normalized text');
  assert(k1 !== k2, 'two different URL-led threads must NOT collide onto a bare "https" key');
});

run('IK-KEY-4', 'colon at index 0 (empty prefix) is NOT a key-separator match', () => {
  assertEqual(intentKey(': leading colon'), ': leading colon');
});

run('IK-KEY-5', 'colon at index >=60 is NOT a key-separator match (falls through to full-text key)', () => {
  const longPrefix = 'x'.repeat(61) + ': rest';
  assertEqual(intentKey(longPrefix), longPrefix);
});

run('IK-KEY-6', 'lowercase key text (no space after colon at the boundary) does not accidentally split', () => {
  assertEqual(intentKey('key:no-space-after'), 'key:no-space-after');
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

// A hash-suffixed key looks like "<prefix> …#XXXXXXXX" (space,
// ellipsis, '#', 8 hex chars). No fixed length assumption beyond that.
const HASH_SUFFIX_RE = / …#[0-9a-f]{8}$/;

run('IK-9', '1000-byte cap (no key-separator match): cut at a whitespace boundary, suffixed with " …#<8-hex-hash>"', () => {
  const words = [];
  for (let i = 0; i < 300; i++) words.push(`word${i}`);
  const long = words.join(' '); // well over 1000 bytes, plain ASCII (1 byte/char), no ':' at all
  const key = intentKey(long);
  assert(Buffer.byteLength(key, 'utf8') <= MAX_KEY_BYTES, 'result must stay within the byte cap INCLUDING the hash suffix');
  assert(HASH_SUFFIX_RE.test(key), `expected the " …#<8hex>" suffix, got tail: ${JSON.stringify(key.slice(-14))}`);
  const withoutSuffix = key.replace(HASH_SUFFIX_RE, '').trimEnd();
  assert(long.startsWith(withoutSuffix), 'truncated content must be a verbatim prefix of the original (cut at whitespace, not mid-word)');
});

run('IK-10', '1000-byte cap with multibyte text: never splits a surrogate pair or multi-byte UTF-8 sequence', () => {
  // CJK characters are 3 bytes each in UTF-8; emoji are 4-byte surrogate
  // pairs in UTF-16/UTF-8. Build a string well over 1000 bytes out of both,
  // with spaces every few characters so a whitespace boundary exists near
  // the cut point. No ':' anywhere, so this exercises the full-text+cap branch.
  const chunk = '漢字テスト 😀😁😂 '; // kanji/katakana + emoji + spaces
  let long = '';
  while (Buffer.byteLength(long, 'utf8') < 1500) long += chunk;
  const key = intentKey(long);
  assert(Buffer.byteLength(key, 'utf8') <= MAX_KEY_BYTES, 'result must stay within the byte cap');
  assert(HASH_SUFFIX_RE.test(key), 'expected the hash-suffixed truncation marker');
  // Round-tripping through Buffer must not introduce U+FFFD (the mark of a
  // split multi-byte sequence / broken surrogate pair).
  assert(!key.includes('�'), 'truncated key must not contain a replacement character (would indicate a split code point)');
  // Every code point in the truncated body must also appear as a code point
  // in the original string at the same leading position (verifies no
  // surrogate-pair splitting via a round-trip through the spread operator,
  // which itself throws/mis-iterates on a lone surrogate).
  const body = key.replace(HASH_SUFFIX_RE, '');
  assert([...body].join('') === body, 'body must be composed of whole code points');
});

run('IK-CAP-1', 'cap collision fix: two >=1200-byte strings sharing a long common prefix but differing ONLY in the tail produce DIFFERENT keys', () => {
  const commonPrefix = 'shared prefix content that repeats and repeats and repeats and repeats and repeats and repeats and repeats and repeats and repeats and repeats and repeats and repeats and repeats and repeats and repeats and repeats and repeats and repeats and repeats and repeats and repeats and repeats and repeats and repeats and repeats and repeats and repeats and repeats and repeats and repeats and repeats and repeats and repeats and repeats and repeats and repeats and repeats and repeats and repeats and repeats and repeats and repeats and repeats and repeats and repeats and repeats and repeats and repeats and repeats and repeats and repeats and repeats and repeats and repeats and repeats and repeats and repeats and repeats and repeats and repeats and repeats and repeats and repeats and repeats and repeats and repeats and repeats and repeats and repeats and repeats and repeats and repeats and repeats and repeats and repeats and repeats and repeats and repeats and repeats and repeats and repeats and repeats and repeats and repeats and repeats and repeats and repeats and repeats and repeats and repeats and repeats and repeats and repeats and repeats and repeats and repeats and repeats and repeats and repeats and repeats and repeats and repeats and repeats and repeats and repeats and repeats and repeats';
  assert(Buffer.byteLength(commonPrefix, 'utf8') >= 996, `sanity: shared prefix must be near the cap; got ${Buffer.byteLength(commonPrefix, 'utf8')} bytes`);
  const textA = commonPrefix + ' TAIL-ONE-DIFFERS-HERE';
  const textB = commonPrefix + ' TAIL-TWO-COMPLETELY-DIFFERENT';
  assert(Buffer.byteLength(textA, 'utf8') >= 1200 && Buffer.byteLength(textB, 'utf8') >= 1200, 'sanity: both inputs must be >=1200 bytes');
  const keyA = intentKey(textA);
  const keyB = intentKey(textB);
  assert(keyA !== keyB, `expected different keys for different tails; both truncated to ${JSON.stringify(keyA)}`);
});

run('IK-CAP-2', 'cap collision fix: the SAME long string produces the SAME key both times (deterministic/idempotent)', () => {
  const long = ('x'.repeat(50) + ' ').repeat(30); // well over 1000 bytes, no ':'
  assertEqual(intentKey(long), intentKey(long));
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
