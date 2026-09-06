'use strict';

/**
 * intent-key.js — cm#233: single subject-key derivation function for
 * text-derived intent subjects (currently `open_thread` — any future
 * predicate that keys a subject off freeform text should use this too),
 * replacing handoff.js's former `deriveIntentSubject` (colon-split-before-
 * char-60-else-truncate-to-80, no Unicode normalization, no whitespace
 * collapse — removed in the same change that added this file; see
 * scripts/migrations/migrate-13-intent-key.js's header for the one-time
 * re-key of already-live rows and CONSOLIDATION-RUNBOOK.md cm#233 for the
 * full spec/rationale).
 *
 * WHY a colon-split/truncate scheme was replaced: it silently produced
 * DIFFERENT subjects for near-duplicate thread text (a lone trailing
 * newline, a run of extra spaces, or a colon appearing at char 61 instead
 * of 59 all changed the derived subject), which meant the 1:1 matchers
 * throughout handoff.js (persistSessionIntent's re-author guard,
 * writeExtraction's resolved_threads auto-retire, the --dry-run preview,
 * and scripts/lib/carryover-render.js's own matcher) could silently miss a
 * match that a human would consider "obviously the same thread".
 *
 * intentKey(text) — total function, never throws:
 *   1. Unicode NFC-normalize (so a precomposed and a decomposed encoding of
 *      the same visible text produce the SAME key).
 *   2. Collapse every whitespace run — including newlines/tabs, not just
 *      interior spaces — to exactly one ASCII space.
 *   3. Trim leading/trailing whitespace.
 *   4. If the result is empty, return '' (INVALID — callers reject/skip;
 *      see handoff.js's classifyResolvedThreads/dedupOpenThreadIntents).
 *   5. If the result exceeds MAX_KEY_BYTES (1000) UTF-8 bytes, cut at the
 *      last whitespace boundary at or before the 1000-byte mark (falling
 *      back to a hard byte-boundary cut if no whitespace boundary exists
 *      in that span — e.g. one long unbroken token) and append ' …'. This
 *      keeps every stored subject safely under the
 *      (project_id, subject, predicate) btree index-entry size limit
 *      (handoff-core-schema.sql's `assertions_1to1_unique`) without ever
 *      splitting a surrogate pair or a multi-byte UTF-8 sequence.
 *
 *   Deliberately NOT done: trailing punctuation is never folded/stripped —
 *   only whitespace is touched. "Fix bug:" and "Fix bug" remain distinct
 *   keys (the old colon-split behavior that conflated "everything before a
 *   colon" with "the whole short thread" is gone, not replicated).
 *
 * intentKeyEquals(a, b) — case-insensitive comparison of two already-
 * derived keys, matching the pre-cm#233 `LOWER(TRIM(subject)) =
 * LOWER(TRIM($2))` SQL comparison semantics used throughout handoff.js's
 * open_thread matchers (the STORED key preserves case; only the
 * *comparison* is case-insensitive). Trims defensively so it is also safe
 * to call on a raw, not-yet-keyed string.
 */

const MAX_KEY_BYTES = 1000;
const TRUNCATION_SUFFIX = ' …';

function intentKey(text) {
  let s = String(text == null ? '' : text);
  s = s.normalize('NFC');
  s = s.replace(/\s+/g, ' ').trim();
  if (s.length === 0) return '';
  if (Buffer.byteLength(s, 'utf8') <= MAX_KEY_BYTES) return s;

  // Walk code points (never split a surrogate pair / multi-byte UTF-8
  // sequence) accumulating UTF-8 byte length until the next code point
  // would push the total past MAX_KEY_BYTES.
  let byteLen = 0;
  let cutIndex = 0; // UTF-16 code-unit index into s
  for (const ch of s) {
    const chBytes = Buffer.byteLength(ch, 'utf8');
    if (byteLen + chBytes > MAX_KEY_BYTES) break;
    byteLen += chBytes;
    cutIndex += ch.length; // 1 for a BMP code point, 2 for a surrogate pair
  }

  let truncated = s.slice(0, cutIndex);
  const lastSpace = truncated.lastIndexOf(' ');
  if (lastSpace > 0) {
    truncated = truncated.slice(0, lastSpace);
  }
  // Defensive: a trailing space right at the cut boundary (no interior
  // space found, or the boundary itself landed on a space) is dropped so
  // the suffix never reads "... …" with a doubled space.
  truncated = truncated.replace(/\s+$/, '');
  return truncated + TRUNCATION_SUFFIX;
}

function intentKeyEquals(a, b) {
  const ka = String(a == null ? '' : a).trim().toLowerCase();
  const kb = String(b == null ? '' : b).trim().toLowerCase();
  return ka === kb;
}

module.exports = { intentKey, intentKeyEquals, MAX_KEY_BYTES };
