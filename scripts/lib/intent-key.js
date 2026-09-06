'use strict';

/**
 * intent-key.js — cm#233: single subject-key derivation function for
 * text-derived intent subjects (currently `open_thread` — any future
 * predicate that keys a subject off freeform text should use this too),
 * replacing handoff.js's former `deriveIntentSubject` (colon-split-before-
 * char-60-else-truncate-to-80, no Unicode normalization, no whitespace
 * collapse — removed in the same change that added this file; see
 * scripts/migrations/migrate-17-intent-key.js's header for the one-time
 * re-key of already-live rows and CONSOLIDATION-RUNBOOK.md cm#233 for the
 * full spec/rationale).
 *
 * cm#233 FIX-ROUND AMENDMENT (post-review): the ORIGINAL cm#233 pass
 * dropped the colon-split convention entirely, treating the whole
 * whitespace-collapsed text as the key. That broke a DELIBERATE authoring
 * affordance test/north-star/test-provenance.js's P2/P3 pin: authoring a
 * thread as `KEY: description` and later restating `KEY: <different
 * description>` is how a session supersedes its own prior thread by KEY,
 * even when the description text changes completely (P2's own fixture:
 * `SHIP-DECISION: ship ... THIS cycle` superseded by
 * `SHIP-DECISION: DEFER ... to next cycle`). cm#233's actual complaint was
 * the 80-char truncation / no-Unicode-normalization behavior, never the
 * colon convention itself — this amendment restores the convention while
 * keeping the truncation/normalization fix.
 *
 * intentKey(text) — total function, never throws:
 *   1. Unicode NFC-normalize.
 *   2. Collapse every whitespace run (including newlines/tabs) to one
 *      space.
 *   3. Trim leading/trailing whitespace.
 *   4. If the result is empty, return '' (INVALID — callers reject/skip).
 *   5. KEY-SEPARATOR RULE: if the normalized text contains a `':'` at
 *      index >0 and <60, WITH A SPACE IMMEDIATELY AFTER IT (i.e. the
 *      pattern is `KEY: rest`, not `key:rest` and not `scheme://host` —
 *      see the URL note below), the key is the normalized text BEFORE
 *      that colon, trimmed. This intentionally preserves collisions
 *      between differently-worded restatements sharing the same KEY — a
 *      FEATURE (supersession-by-key), not a bug — so no byte-cap/hash
 *      disambiguation is ever applied to this branch (a <60-code-unit
 *      prefix cannot approach the 1000-byte cap regardless of script).
 *   6. Otherwise (no qualifying key separator), the key is the full
 *      normalized text, capped at 1000 UTF-8 bytes (see capWithHash below)
 *      so the stored subject stays safely under the
 *      (project_id, subject, predicate) btree index-entry size limit
 *      (handoff-core-schema.sql's `assertions_1to1_unique`).
 *
 *   URL NOTE (fix-round finding): requiring a space immediately after the
 *   colon is what stops `https://example.com/...` from being misread as a
 *   key-separator match on "https" — a bare `text.indexOf(':') < 60` rule
 *   (which is what the ORIGINAL pre-cm#233 deriveIntentSubject and cm#233's
 *   first colon-restoration draft both used) would collide EVERY thread
 *   that happens to start with a URL onto the single key "https",
 *   regardless of which URL or what the thread is actually about. Real
 *   `KEY: description` authoring always has a space after the colon (every
 *   existing example in this codebase's own docs/tests does); a URL's
 *   scheme colon never does. This is a real, live gap this fix-round
 *   closes rather than merely flags (only the FIRST colon is tested — a
 *   second, later colon that "would" qualify is never scanned for, matching
 *   the original single-colon-check design; this is an accepted scope
 *   limit, not a total classification failure, since it only affects
 *   which of two READING behaviors a rare compound string gets, never
 *   collides two unrelated threads).
 *
 *   Deliberately NOT done: trailing punctuation is never folded/stripped —
 *   only whitespace is touched, and only outside the KEY-separator branch.
 *   "Fix bug:" (no space after the colon, or colon at position 7 with no
 *   text after it) is NOT treated as a key-separator match and is not
 *   split.
 *
 * intentKeyEquals(a, b) — case-insensitive comparison of two already-
 * derived keys, matching the pre-cm#233 `LOWER(TRIM(subject)) =
 * LOWER(TRIM($2))` SQL comparison semantics used throughout handoff.js's
 * open_thread matchers (the STORED key preserves case; only the
 * *comparison* is case-insensitive). Trims defensively so it is also safe
 * to call on a raw, not-yet-keyed string.
 */

const crypto = require('crypto');

const MAX_KEY_BYTES = 1000;
const TRUNCATION_ELLIPSIS = ' …'; // ' …'
const KEY_SEPARATOR_MAX_INDEX = 60;

function normalizeText(text) {
  let s = String(text == null ? '' : text);
  s = s.normalize('NFC');
  s = s.replace(/\s+/g, ' ').trim();
  return s;
}

/**
 * Cap a (no-key-separator) normalized string at MAX_KEY_BYTES UTF-8 bytes.
 * On truncation, appends ` …#<8 hex chars of sha256(fullNormalizedText)>`
 * so that two different long strings sharing a long common prefix (cm#233
 * fix-round finding: a >=996-byte shared prefix silently collided under
 * the plain ellipsis suffix) truncate to DIFFERENT keys — the hash covers
 * the FULL untruncated text, so it differs whenever the tail differs, and
 * is identical (hence idempotent) for the identical input. The truncation
 * point is pulled in early enough to leave room for the hash suffix so
 * the total result never exceeds MAX_KEY_BYTES.
 */
function capWithHash(normalized) {
  if (Buffer.byteLength(normalized, 'utf8') <= MAX_KEY_BYTES) return normalized;

  const hashHex = crypto.createHash('sha256').update(normalized, 'utf8').digest('hex').slice(0, 8);
  const suffix = `${TRUNCATION_ELLIPSIS}#${hashHex}`;
  const suffixBytes = Buffer.byteLength(suffix, 'utf8');
  const budget = MAX_KEY_BYTES - suffixBytes;

  // Walk code points (never split a surrogate pair / multi-byte UTF-8
  // sequence) accumulating UTF-8 byte length until the next code point
  // would push the total past the budget.
  let byteLen = 0;
  let cutIndex = 0; // UTF-16 code-unit index into normalized
  for (const ch of normalized) {
    const chBytes = Buffer.byteLength(ch, 'utf8');
    if (byteLen + chBytes > budget) break;
    byteLen += chBytes;
    cutIndex += ch.length; // 1 for a BMP code point, 2 for a surrogate pair
  }

  let truncated = normalized.slice(0, cutIndex);
  const lastSpace = truncated.lastIndexOf(' ');
  if (lastSpace > 0) {
    truncated = truncated.slice(0, lastSpace);
  }
  truncated = truncated.replace(/\s+$/, '');
  return truncated + suffix;
}

function intentKey(text) {
  const normalized = normalizeText(text);
  if (normalized.length === 0) return '';

  const colonIdx = normalized.indexOf(':');
  const isKeySeparator =
    colonIdx > 0 &&
    colonIdx < KEY_SEPARATOR_MAX_INDEX &&
    normalized[colonIdx + 1] === ' '; // "KEY: rest" — a bare "scheme://host" never matches (no space after ':')

  if (isKeySeparator) {
    return normalized.slice(0, colonIdx).trim();
  }

  return capWithHash(normalized);
}

function intentKeyEquals(a, b) {
  const ka = String(a == null ? '' : a).trim().toLowerCase();
  const kb = String(b == null ? '' : b).trim().toLowerCase();
  return ka === kb;
}

module.exports = { intentKey, intentKeyEquals, MAX_KEY_BYTES, KEY_SEPARATOR_MAX_INDEX };
