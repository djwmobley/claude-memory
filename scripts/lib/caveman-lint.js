'use strict';

/**
 * caveman-lint.js — shared token/fidelity primitives for the caveman-economy
 * gates (§3.1-§3.5 of CONSOLIDATION-RUNBOOK.md).
 *
 * Single source of truth for:
 *   - estimateTokens         — the ONE token-count convention (K-10; ceil(len/4),
 *                               decoupled from §18 usage-billing tokens).
 *   - assertSurfaced         — substring-presence assertion (moved, by reference,
 *                               from test/north-star/lib/ns-harness.js — that file
 *                               now imports it from here instead of defining it).
 *   - extractLoadBearingTokens — K-3: the generic, pattern-family load-bearing-
 *                               token extractor (SHA/hex, file paths, PR #N,
 *                               file:line, ISO dates, URLs, quoted error strings,
 *                               numbers, negation markers). Prior to this file the
 *                               only extraction mechanism anywhere in this repo was
 *                               a HAND-CURATED per-fixture LOAD_BEARING array
 *                               (test-caveman-economy.js) — no generic extractor
 *                               existed. This is new, structural, judgment-driven
 *                               pattern design (see AUTHORED_BY report's blind-spot
 *                               section for what it can and cannot catch).
 *   - detectTruncation        — K-7: a self-contained (no-baseline) heuristic that
 *                               flags text that looks CUT OFF mid-token. Used by
 *                               the store-wide gate for born-caveman rows, which
 *                               per K-5 must NOT be fidelity-checked against a
 *                               synthetic verbose baseline (circular, gameable) —
 *                               this checks the row's OWN content for mid-token
 *                               truncation instead of diffing against a baseline.
 *   - functionWordRatio       — ARM3-style compression-density metric, used by the
 *                               store-wide gate's economy check (K-5) for
 *                               born-caveman rows. A SEPARATE copy from
 *                               test-caveman-economy.js's private, differently-
 *                               calibrated FUNCTION_WORDS/functionWordRatio (that
 *                               file's copy is intentionally left untouched —
 *                               changing its calibrated stoplist/thresholds is out
 *                               of scope for this refactor and risks regressing an
 *                               existing green suite; see PR body).
 *
 * CommonJS, US English, no external deps (matches repo convention).
 */

const assert = require('assert');

// ─── TOKEN COUNT (K-10) ─────────────────────────────────────────────────────

/**
 * Token estimate convention used throughout handoff.js: Math.ceil(text.length/4)
 * (e.g. handoff.js:2711, bench-handoff.js:69). Pinned here as the ONE definition;
 * every caller (test-caveman-economy.js via ns-harness.js, the store-wide gate)
 * imports this, never reimplements it. Explicitly NOT the same "token" as §18's
 * usage-billing token count (that is a provider-reported API accounting figure;
 * this is a cheap local length-based estimate used only for the caveman-economy
 * invariant).
 *
 * @param {string} text
 * @returns {number}
 */
function estimateTokens(text) {
  return Math.ceil(String(text || '').length / 4);
}

// ─── SUBSTRING-PRESENCE ASSERTION ──────────────────────────────────────────

function asItemList(items) {
  if (items == null) return [];
  return (Array.isArray(items) ? items : [items])
    .map((s) => String(s))
    .filter((s) => s.length > 0);
}

/**
 * Assert that every item in `items` appears (substring) in servedText. Moved
 * verbatim (by reference — single definition) from ns-harness.js, which now
 * imports this instead of defining its own copy.
 *
 * @param {string} servedText
 * @param {string|string[]} items
 * @param {string} [msg]
 */
function assertSurfaced(servedText, items, msg) {
  const text = String(servedText || '');
  const missing = asItemList(items).filter((it) => !text.includes(it));
  assert.strictEqual(
    missing.length, 0,
    `${msg || 'assertSurfaced'}: expected to surface in served context but did NOT: ` +
    `${JSON.stringify(missing)} — north-star (1) lossless fidelity: session-driving ` +
    `intent must survive into the next session's served context.`
  );
}

// ─── K-3: GENERIC LOAD-BEARING-TOKEN EXTRACTOR ─────────────────────────────
//
// Pattern families, per §3.5 amendment K-3. Each family is a regex run with the
// GLOBAL flag; matches are collected in first-occurrence order and de-duplicated.
// This is a STRUCTURAL/heuristic extractor, not a semantic one — it recognizes
// SHAPES that are conventionally load-bearing in this codebase's prose (commit
// SHAs, file paths, PR references, etc.), not "meaning." See the blind-spot
// section of the authoring PR for named gaps (e.g. it cannot recognize a novel,
// unconventionally-shaped identifier as load-bearing).
//
// K-6: negation markers (not/no/never/n't) are carved OUT of any "strippable"
// treatment and INTO this extractor's output — a negation site is load-bearing,
// on par with a SHA or a PR number. This is what makes "component was not
// removed" and "component was removed" distinguishable to a fidelity check that
// only compares extracted-token sets.

const PATTERN_FAMILIES = [
  // SHA / hex — 7-40 lowercase-hex chars (git short/long SHA convention). Must be
  // a-f0-9 only, so ordinary lowercase words never qualify (no g-z).
  { name: 'sha_hex', re: /\b[0-9a-f]{7,40}\b/gi },

  // file:line — bare filename with an extension, immediately followed by a line
  // number (e.g. "handoff.js:3030"). Checked BEFORE the general path pattern so
  // its narrower shape isn't swallowed by the broader one when both would match.
  { name: 'file_line', re: /\b[\w.-]+\.[A-Za-z0-9]+:\d+\b/g },

  // file path — one or more path segments (POSIX or Windows separators) ending
  // in a dot-extension, optionally followed by :line (already covered above but
  // harmless to re-match as part of a longer path).
  { name: 'file_path', re: /(?:[A-Za-z]:[\\/])?(?:[\w.-]+[\\/])+[\w.-]+\.[A-Za-z0-9]+(?::\d+)?/g },

  // PR #N
  { name: 'pr_ref', re: /\bPR\s*#\d+\b/gi },

  // bare #N issue/PR reference (only when NOT already part of "PR #N" — the
  // pr_ref family above already captured that shape; this catches a bare
  // "#163"-style reference used without the "PR" prefix).
  { name: 'issue_ref', re: /(?<![\w])#\d+\b/g },

  // ISO date
  { name: 'iso_date', re: /\b\d{4}-\d{2}-\d{2}\b/g },

  // URL
  { name: 'url', re: /\bhttps?:\/\/[^\s)"'`]+/g },

  // quoted error string — text inside double/single/back quotes, length >= 2.
  { name: 'quoted', re: /"[^"\n]{2,}"|'[^'\n]{2,}'|`[^`\n]{2,}`/g },

  // numbers / enum-shaped tokens (versions, counts, dims like "4000" in
  // "halfvec(4000)"). Bare integers/decimals of any length.
  { name: 'number', re: /\b\d+(?:\.\d+)*\b/g },

  // negation markers (K-6) — MUST-PRESERVE, never strippable. Matches whole-word
  // not/no/never, plus the "n't" contraction tail (don't/can't/won't/...).
  { name: 'negation', re: /\b(?:not|no|never)\b|n't\b/gi },
];

/**
 * Extract every load-bearing token from `text`, across all K-3 pattern families
 * (SHA/hex, file paths, file:line, PR#/issue#, ISO dates, URLs, quoted strings,
 * numbers, negation markers). Returns a de-duplicated array in first-occurrence
 * order. Case is preserved as matched (callers doing presence checks should
 * decide their own case-sensitivity; this extractor does not normalize case,
 * matching assertSurfaced's existing case-sensitive substring convention).
 *
 * @param {string} text
 * @returns {string[]}
 */
function extractLoadBearingTokens(text) {
  const str = String(text || '');
  const found = []; // [{ token, index }]
  const seen = new Set();
  for (const { re } of PATTERN_FAMILIES) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(str)) !== null) {
      const token = m[0];
      if (token.length === 0) { re.lastIndex++; continue; }
      const key = token;
      if (!seen.has(key)) {
        seen.add(key);
        found.push({ token, index: m.index });
      }
      // Guard against zero-width-adjacent infinite loops on lookbehind patterns.
      if (re.lastIndex === m.index) re.lastIndex++;
    }
  }
  found.sort((a, b) => a.index - b.index);
  return found.map((f) => f.token);
}

// ─── K-7: FULL-CONTENT FIDELITY (no early-substring survival) ─────────────

/**
 * Assert that every load-bearing token extracted from `referenceText` (the
 * fuller/original text — e.g. a captured-prior-verbose baseline) is present,
 * INTACT, ANYWHERE in `candidateText` (the caveman/served text) — scanning the
 * FULL candidateText, never an early slice. This is the K-7 fix: a truncated
 * candidate that happens to share a long common PREFIX with the reference would
 * pass a naive "starts with" or bounded-length check; this does not, because it
 * scans the entire candidateText string for each token.
 *
 * Only meaningful when a reference/baseline text exists (grandfathered-verbose
 * rows, or paired fixtures). For born-caveman rows with NO baseline (K-5), use
 * detectTruncation() instead — never fabricate a synthetic baseline to diff
 * against (K-5: circular, gameable).
 *
 * @param {string} referenceText
 * @param {string} candidateText
 * @param {string} [msg]
 * @returns {{ ok: boolean, missing: string[] }}
 */
function assertFullFidelity(referenceText, candidateText, msg) {
  const tokens = extractLoadBearingTokens(referenceText);
  const candidate = String(candidateText || '');
  const missing = tokens.filter((t) => !candidate.includes(t));
  assert.strictEqual(
    missing.length, 0,
    `${msg || 'assertFullFidelity'}: load-bearing tokens dropped between reference and ` +
    `candidate (K-7 — full-content coverage, not early-substring survival): ${JSON.stringify(missing)}`
  );
  return { ok: missing.length === 0, missing };
}

// ─── K-7: NO-BASELINE TRUNCATION HEURISTIC ─────────────────────────────────
//
// For born-caveman rows there is no verbose baseline to diff against (K-5). This
// function instead inspects a SINGLE text for the concrete, common shapes of
// mid-token truncation this codebase's load-bearing patterns can produce when
// something upstream cuts a string at a fixed length (e.g. a column max-length,
// a naive substring(0,N) render step). It is a heuristic, not a general
// truncation detector — see the authoring PR's blind-spot section.

// A text that ends in ordinary sentence-terminal punctuation reads as a
// COMPLETE thought, not a cut-off one. Real migrated prose (see the K-7
// false-positive incident below) frequently contains characters that a naive
// parity/shape check misreads as "dangling" purely because they occur
// somewhere in a long paragraph — apostrophes in possessives/contractions,
// scare-quotes, a stray decade-notation quote, an "a/b"-style word pair with
// no path intent. The two BROAD heuristics below (dangling_quote,
// dangling_path) are gated on the text NOT ending in terminal punctuation, so
// they only fire on text that ALSO looks structurally incomplete — this was
// tightened after running the gate against real migrated `decisions` rows in
// memory_manager_staging surfaced exactly this false-positive shape (6 of 669
// real rows flagged, all long natural-language paragraphs ending in "." with
// an incidental odd apostrophe or a benign "word/word" pair mid-text or at a
// clean sentence boundary — not actual truncation). The narrower, keyword-
// anchored heuristics (PR#/URL/SHA/date) were NOT loosened — their false-
// positive risk is inherently lower because they require a specific preceding
// keyword/scheme immediately before the cutoff, not a whole-text shape.
const ENDS_IN_TERMINAL_PUNCTUATION = /[.!?)\]]\s*$/;

const TRUNCATION_SMELLS = [
  // Dangling unescaped double-quote or backtick — odd count means the text
  // ends mid quoted-error-string. Apostrophes (') are DELIBERATELY EXCLUDED
  // from this parity check — real English prose uses them for contractions,
  // possessives, and scare-quotes far too often to treat an odd apostrophe
  // count as a truncation signal (demonstrated false positives on real data).
  // Gated on NOT ending in terminal punctuation — a complete sentence with an
  // incidental unpaired quote character somewhere inside it is not a
  // truncated one.
  {
    name: 'dangling_quote',
    test: (s) => {
      if (ENDS_IN_TERMINAL_PUNCTUATION.test(s)) return false;
      for (const q of ['"', '`']) {
        const count = (s.match(new RegExp('\\' + q, 'g')) || []).length;
        if (count % 2 === 1) return true;
      }
      return false;
    },
  },
  // "PR #" with no digits following, at end of string.
  { name: 'dangling_pr_ref', test: (s) => /PR\s*#\s*$/i.test(s) },
  // Path fragment cut before its extension: ends in a path separator followed
  // by a bare segment with no '.' in it, AND the trailing run has >=2 path
  // separators (a real multi-segment path like "scripts/lib/reality-check"),
  // AND the text does not end in terminal punctuation, AND the text ELSEWHERE
  // already contains a COMPLETE file-path/file:line token (extension present)
  // — corroborating context that this text is genuinely path-heavy, not just
  // an ordinary slash-separated word enumeration. Requiring >=2 separators
  // alone was not enough: "selected projects/resources/views" (real migrated
  // `decisions` data) has two separators and no extension but is plain
  // English, not a truncated path — it never contains a complete,
  // extension-bearing path token anywhere else in the same text, so the
  // corroboration requirement correctly excludes it while still catching a
  // truncated path in context (e.g. "...touched scripts/lib/reality-
  // checks.js:3030 and also scripts/lib/reality-check").
  {
    name: 'dangling_path',
    test: (s) => {
      if (ENDS_IN_TERMINAL_PUNCTUATION.test(s)) return false;
      if (!/(?:[\\/][\w-]+){2,}$/.test(s)) return false;
      if (/[\\/][\w-]+\.[A-Za-z0-9]+$/.test(s)) return false; // already has an extension — not dangling
      const hasCorroboratingPath = PATTERN_FAMILIES
        .filter((f) => f.name === 'file_path' || f.name === 'file_line')
        .some((f) => { f.re.lastIndex = 0; return f.re.test(s); });
      return hasCorroboratingPath;
    },
  },
  // URL cut at or just after the scheme, or with no dot in the host fragment.
  { name: 'dangling_url', test: (s) => /https?:\/\/[\w-]*$/.test(s) },
  // "sha"/"commit" keyword immediately followed by a too-short hex run at end of
  // string (a real SHA is >=7 chars; 1-6 trailing hex chars after the keyword
  // reads as a cut-off SHA rather than a complete short token).
  { name: 'dangling_sha', test: (s) => /(?:sha|commit)[:\s]+[0-9a-f]{1,6}$/i.test(s) },
  // ISO date missing trailing digit groups.
  { name: 'dangling_date', test: (s) => /\b\d{4}-(?:\d{2})?-?$/.test(s) },
];

/**
 * Heuristically detect whether `text` looks like it was cut off mid-token.
 * Returns `{ truncated: boolean, smells: string[] }` — `smells` names every
 * matched heuristic (usually 0 or 1, but a badly-cut string could trip more
 * than one).
 *
 * @param {string} text
 * @returns {{ truncated: boolean, smells: string[] }}
 */
function detectTruncation(text) {
  const str = String(text || '');
  const smells = TRUNCATION_SMELLS.filter((s) => s.test(str)).map((s) => s.name);
  return { truncated: smells.length > 0, smells };
}

// ─── ECONOMY: FUNCTION-WORD DENSITY (ARM3-style, K-5) ──────────────────────
//
// A SEPARATE copy from test-caveman-economy.js's private FUNCTION_WORDS /
// functionWordRatio (that file's copy is intentionally left untouched — see
// module doc comment above). This copy backs the store-wide gate's per-row
// economy check for born-caveman rows: no synthetic-baseline comparison (K-5),
// just a density ceiling on the row's own content.

const FUNCTION_WORDS = new Set([
  'a', 'an', 'the',
  'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'of', 'to', 'in', 'for', 'and', 'or', 'but',
  'with', 'that', 'this', 'it', 'as', 'at', 'on', 'by',
  'we', 'he', 'she', 'they', 'i',
  'have', 'has', 'had', 'do', 'does', 'did',
  'if', 'so', 'its', 'our',
  'from', 'also', 'about', 'after', 'where', 'which', 'who',
  'there', 'when', 'than', 'into', 'up',
  // NOTE (K-6): 'not' / 'no' / 'never' are DELIBERATELY EXCLUDED from this
  // stoplist, unlike test-caveman-economy.js's copy — negation markers are
  // MUST-PRESERVE load-bearing tokens here, not strippable function words.
]);

function wordTokens(text) {
  return String(text || '')
    .toLowerCase()
    .split(/[^a-z0-9']+/)
    .filter((w) => w.length > 0);
}

/**
 * Function-word ratio: functionWords / totalWords. Returns 0 for empty text.
 *
 * @param {string} text
 * @returns {number}
 */
function functionWordRatio(text) {
  const words = wordTokens(text);
  if (words.length === 0) return 0;
  const fw = words.filter((w) => FUNCTION_WORDS.has(w)).length;
  return fw / words.length;
}

// Ceiling used by the store-wide gate's economy check for born-caveman rows
// (ARM3-style: telegraphic text runs ~15-25% FW ratio per test-caveman-economy.js's
// own documented calibration comment; a generous ceiling below ordinary
// full-sentence prose (~30-45%) catches rows that were never actually
// telegraphed, without being so tight it flags legitimately terse-but-
// grammatical short strings).
const CAVEMAN_FW_RATIO_CEILING = 0.30;

module.exports = {
  estimateTokens,
  assertSurfaced,
  extractLoadBearingTokens,
  assertFullFidelity,
  detectTruncation,
  functionWordRatio,
  wordTokens,
  FUNCTION_WORDS,
  CAVEMAN_FW_RATIO_CEILING,
  PATTERN_FAMILIES,
  TRUNCATION_SMELLS,
};
