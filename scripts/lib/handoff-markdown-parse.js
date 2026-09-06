'use strict';

/**
 * handoff-markdown-parse.js — fenced-code/blockquote/HTML-comment-aware
 * line classifier + markdown-table cell parser for
 * scripts/migrations/migrate-08-handoff-markdown.js (CONSOLIDATION-
 * RUNBOOK.md §6.1(h) + its H-1..H-14 spec-adversary amendment,
 * memory-manager#11(h)) — and cm#222's further hardening pass (2026-09-06):
 * true --dry-run, total-classification session headings, header-driven
 * carry-over tables, explicit NEXT SESSION states.
 *
 * cm#222 GROUND TRUTH: this rewrite was verified against the two real
 * target files (read-only, never quoted at length here or in fixtures —
 * anonymized synthetic content only per H-13/owner instruction):
 *   - HANDOFF.md: 1 numbered session heading, 3 durable-section headings,
 *     no "## NEXT SESSION" heading (uses a different "LEAD:" convention),
 *     one 3-column "### Open carry-overs" table (Item/Status/Notes).
 *   - HANDOFF-HISTORY.md: 118 session headings — 85 "## Session N <sep>
 *     date <sep> title" (session_numbered) and 33 "## SESSION <date>
 *     [(parenthetical)] <sep> title" (session_dated, e.g. "(session 18)",
 *     "(c)", or no parenthetical at all); zero fell into
 *     session_shaped_unparsed or produced orphan_rows once the fixes below
 *     were applied. See this PR's H-13 acceptance section for exact counts.
 *
 * SUPERSESSION NOTE (H-3/H-8/H-9): the base §6.1(h) text said to reuse
 * `extractCarryoverTable`/`applyDeltasToRows`. Those functions do not
 * exist anywhere in this tree — scripts/lib/carryover-render.js is a
 * SQL-side port (live `open_thread` rows <-> delta objects), not a
 * markdown-table parser. This file is the NEW component the amendment
 * requires. The only thing reused BY REFERENCE from the live path is
 * carryover-render.js's `renderCarryoverTable` escaping convention — this
 * file's `unescapeTableCell`/`splitOnUnescapedPipe` implement its EXACT
 * INVERSE (backslash-doubling then pipe-escaping on write; pipe-first
 * then backslash on read, since read must undo write in reverse order).
 * `deriveIntentSubject`/`PINNED_EXCLUSION_SQL` are NOT re-implemented here
 * either — migrate-08-handoff-markdown.js imports `deriveIntentSubject`
 * directly from scripts/handoff.js for subject derivation (H-7/H-11); this
 * file only produces raw text for the caller to run through it.
 *
 * TOTAL CLASSIFICATION (H-5, widened by cm#222 A2): every real
 * (non-fenced/blockquoted/commented) `##`-level heading in the document is
 * classified into EXACTLY ONE of these buckets — never a silent drop:
 *   - session_numbered   `## Session N <sep> date <sep> title`
 *   - session_dated       `## SESSION <date> [(paren)] <sep> title`
 *   - session_shaped_unparsed  heading contains the word "session" (case-
 *     insensitive) but matches neither session shape above — ALWAYS listed
 *     individually with its line number (never merged into the generic
 *     `other` bucket — cm#222 F-3).
 *   - durable             matches a configured durable-heading canonical
 *     name (Run commands / Critical operational notes / Key paths / ...).
 *   - next_session        canonical "## NEXT SESSION" (optionally with a
 *     trailing parenthetical), case-insensitive.
 *   - next_session_variant  heading contains both "next" and "session"
 *     (case-insensitive) but is not the canonical form — reported with its
 *     line number (cm#222 F-5/A5).
 *   - other               everything else — a real section boundary that
 *     produces no assertion row of its own, but is still reported.
 *
 * ONE NORMALIZATION ENGINE (cm#222 adversary pin): every heading-text
 * comparison in this file goes through `canonicalizeWhitespace()` (trim +
 * collapse internal whitespace) before an optional case-fold — captured/
 * display text (titles, dates, notes) is NEVER case-folded or otherwise
 * altered; only a throwaway comparison copy is.
 *
 * NORMALIZATION (H-10): callers MUST run `normalizeMarkdown()` on raw file
 * content before any other function in this module sees it. BOM strip,
 * CRLF -> LF, per-line trailing-whitespace trim, and a dash-class scan
 * that FLAGS (never silently coerces) any Unicode dash character used
 * adjacent to what looks like a heading separator that is not one of the
 * three characters the session-heading regexes already recognize (em dash
 * U+2014, en dash U+2013, hyphen-minus U+002D) or the "--" two-hyphen
 * token (cm#222 F-2) — those need no coercion since the separator-token
 * alternation already accepts them as-is.
 */

const RECOGNIZED_DASHES = ['—', '–', '-']; // em, en, hyphen-minus

// cm#222 F-2 (CRITICAL): the separator between a session heading's parts is
// a TOKEN, not a single character class member. 107/118 of the real
// pwa-etl HANDOFF-HISTORY.md headings use a literal two-hyphen "--" run as
// their separator — no single-character class, however wide, can ever
// match a two-character run. The alternation tries the two-hyphen token
// FIRST so it is never partially consumed by the single-dash-class branch.
const SEP_TOKEN_SRC = '(?:--|[—–-])';

// cm#222 F-3 (CRITICAL): TWO structurally distinct real session-heading
// shapes exist. Order matters at the call site (classifyHeading) — the
// DATED shape is tried first because it is the more specific pattern (an
// exact YYYY-MM-DD immediately after the keyword); the NUMBERED shape's
// `\d+` would otherwise happily (and wrongly) consume a date's leading
// "2026" as if it were a session number.
//
// cm#222 own finding (beyond F-2 as literally stated): the separator MUST
// be flanked by actual whitespace (`\s+`, not `\s*`) on both sides, never
// merely optional whitespace. A YYYY-MM-DD date's own hyphens ("2026-07-
// 22") are never surrounded by whitespace, while every real structural
// separator IS (" -- ", " — "). Without this, the single-hyphen member of
// SEP_TOKEN_SRC's alternation would let the non-greedy date-capture group
// below stop at the date's own FIRST embedded hyphen instead of the real
// separator — verified empirically against this file's own test suite
// before being caught (see A2-1/A2-2 in test-handoff-markdown-parse.js).
const FLANKED_SEP_RE_SRC = `\\s+${SEP_TOKEN_SRC}\\s+`;

// session_numbered: "## Session <N> <sep> <date-ish> <sep> <title>" — date
// group is non-greedy (stops at the NEXT separator token); title group is
// greedy (deliberately swallows any further embedded separators, so a
// "4-way-split" heading parses deterministically, never ambiguously).
const SESSION_NUMBERED_RE = new RegExp(
  `^##\\s+session\\s+(\\d+)${FLANKED_SEP_RE_SRC}(.+?)${FLANKED_SEP_RE_SRC}(.+)$`,
  'i'
);

// session_dated: "## SESSION <YYYY-MM-DD> [(parenthetical)] <sep> <title>"
// — the parenthetical is genuinely optional content (a session number like
// "(session 18)", a same-day letter suffix like "(c)", or absent
// entirely); real pwa-etl data exercises all three sub-shapes. No
// non-greedy ambiguity here: the date is a fixed-width literal pattern
// (its own hyphens are never separator candidates), so a single
// flanked-separator match is unambiguous.
const SESSION_DATED_RE = new RegExp(
  `^##\\s+session\\s+(\\d{4}-\\d{2}-\\d{2})\\s*(?:\\(([^)]*)\\))?${FLANKED_SEP_RE_SRC}(.+)$`,
  'i'
);

// A heading "starts with" the session keyword (first word) vs merely
// "contains" it elsewhere — both are session-shaped for F-3's purposes,
// but only the starts-with form is even attempted against the two shape
// regexes above (their own anchors already require the keyword first).
const SESSION_STARTS_RE = /^##\s+session\b/i;
const SESSION_WORD_RE = /\bsession\b/i;

// Any Unicode dash-punctuation-class character NOT one of the three
// RECOGNIZED_DASHES. Deliberately narrow (Pd-category dashes commonly
// confused with the recognized three) rather than the full Unicode Pd
// category, which also contains characters no realistic HANDOFF.md would
// use as a heading separator — narrowest set that resolves the actual
// observed confusable class (figure dash, horizontal bar, small em dash,
// two-em/three-em dash, swung dash, minus sign).
const UNRECOGNIZED_DASH_RE = /[‐‑‒―﹘﹣⸺⸻⁓−]/g;

// cm#222 A5: canonical NEXT SESSION heading, optionally with a trailing
// parenthetical suffix ("## Next Session (carry-over)" still counts as
// canonical/present — pinned explicitly, not left implicit per the
// adversary's identity table).
const NEXT_SESSION_CANONICAL_RE = /^next\s+session(?:\s*\([^)]*\))?$/i;
const NEXT_WORD_RE = /\bnext\b/i;

// cm#222 follow-up (coordinator-directed, same PR): the `### Open
// carry-overs` sub-heading match was an exact anchor, not a total
// classification — a real heading variant
// ("### Open carry-overs (snapshot at S68 close; ...)") matched neither
// the old exact regex nor anything else, so its table was silently
// un-extracted entirely (an H-13 real-file acceptance failure, not a
// synthetic edge case). Canonical: "Open carry-overs" optionally followed
// by a parenthetical OR a "--"/em-dash/en-dash-suffixed clause. Anything
// else containing both "carry" and "over" (case-insensitive substrings —
// covers "carryovers", "carry-overs", "carry over") is a
// `carryover_heading_variant` — reported with its line number, its table
// NEVER guessed/parsed. A `###` heading matching neither (e.g. "### Done")
// is simply not carryover-shaped at all and is ignored by this
// classifier (it is not this classifier's total-classification domain).
const CARRYOVER_CANONICAL_RE = /^open\s+carry-?overs(?:\s*(?:\([^)]*\)|(?:--|[—–-])\s*.+))?$/i;
const CARRYOVER_WORD_RE_1 = /carry/i;
const CARRYOVER_WORD_RE_2 = /over/i;

// ─── ONE NORMALIZATION ENGINE ────────────────────────────────────────────

/**
 * canonicalizeWhitespace — trim + collapse internal whitespace. This is
 * the SOLE normalization primitive every heading-text comparison in this
 * file goes through (durable-heading matching, NEXT-SESSION canonical
 * matching, session/next-session-variant keyword scans). Never mutates
 * captured/display text — callers apply this to a COMPARISON COPY only.
 *
 * @param {string} s
 * @returns {string}
 */
function canonicalizeWhitespace(s) {
  return String(s == null ? '' : s).trim().replace(/\s+/g, ' ');
}

// ─── H-10: NORMALIZATION ────────────────────────────────────────────────

/**
 * normalizeMarkdown — BOM strip (file-leading occurrence ONLY), CRLF -> LF,
 * per-line trailing-whitespace trim, unrecognized-dash flagging, and
 * cm#222 mid-document BOM flagging (never silent coercion). Must be run
 * BEFORE any other function in this module sees the file's raw content.
 *
 * cm#222 follow-up (coordinator-directed, same PR): a real file was found
 * to carry a STRAY U+FEFF mid-document (not at byte 0) — e.g. immediately
 * before a `##` heading, hundreds of lines in, almost certainly a paste/
 * concatenation artifact. The file-leading BOM is still stripped once,
 * here, as before. A mid-document BOM is deliberately NOT stripped by
 * this function — it is left in place and reported as a `bom-midfile`
 * flag with its line number, so its effect (previously an invisible
 * accident of JS's `String.prototype.trim()` also treating U+FEFF as
 * whitespace, which is what let a BOM-prefixed heading still parse) is
 * now visible in the report rather than a silent, undocumented behavior.
 *
 * @param {string} raw
 * @returns {{ text: string, bomStripped: boolean, flags: Array<{type:string, line:number, char?:string}> }}
 */
function normalizeMarkdown(raw) {
  let s = String(raw == null ? '' : raw);
  let bomStripped = false;
  if (s.charCodeAt(0) === 0xFEFF) {
    s = s.slice(1);
    bomStripped = true;
  }
  s = s.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const rawLines = s.split('\n');
  const flags = [];
  const outLines = rawLines.map((line, idx) => {
    const trimmed = line.replace(/[ \t]+$/, '');
    let m;
    UNRECOGNIZED_DASH_RE.lastIndex = 0;
    while ((m = UNRECOGNIZED_DASH_RE.exec(trimmed))) {
      flags.push({ type: 'unrecognized-dash', line: idx + 1, char: m[0] });
    }
    // cm#222: every U+FEFF found HERE is by construction not the file's
    // leading byte (that one was already sliced off above) — a genuine
    // mid-document stray BOM. Flagged, never silently relied upon.
    let bomIdx = -1;
    while ((bomIdx = trimmed.indexOf('﻿', bomIdx + 1)) !== -1) {
      flags.push({ type: 'bom-midfile', line: idx + 1 });
    }
    return trimmed;
  });
  return { text: outLines.join('\n'), bomStripped, flags };
}

// ─── H-8: FENCE / BLOCKQUOTE / HTML-COMMENT CONTEXT ─────────────────────

/**
 * classifyLineContexts — per-line context flags so heading detection can
 * skip fake headings inside fenced code, blockquotes, and HTML comments.
 *
 * Fence: toggled by a line whose trimmed content starts with ``` or ~~~
 * (3+ of the same character); the fence delimiter line itself is marked
 * `isFenceDelimiter` and is NEVER treated as heading content regardless of
 * its own text.
 *
 * Blockquote: PER-LINE only (a line is "in a blockquote" iff that line's
 * own trimmed content starts with `>`) — deliberately not CommonMark's
 * lazy-continuation semantics, which would require full paragraph-context
 * tracking for a benefit no adversary construction in scope here needs;
 * documented as a blind spot.
 *
 * HTML comment: `<!--` opens, `-->` closes, can span multiple lines;
 * same-line open+close handled.
 *
 * @param {string} text - already normalizeMarkdown()-ed
 * @returns {Array<{lineNo:number, raw:string, inFence:boolean, isFenceDelimiter:boolean, inBlockquote:boolean, inHtmlComment:boolean}>}
 */
function classifyLineContexts(text) {
  const lines = text.split('\n');
  const out = [];
  let fenceChar = null; // '`' | '~' | null
  let inComment = false;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const trimmed = raw.trim();
    let isFenceDelimiter = false;
    const wasInFence = fenceChar !== null;

    const fenceMatch = /^(`{3,}|~{3,})/.exec(trimmed);
    if (fenceMatch) {
      const ch = fenceMatch[1][0];
      if (fenceChar === null) {
        fenceChar = ch;
        isFenceDelimiter = true;
      } else if (fenceChar === ch) {
        fenceChar = null;
        isFenceDelimiter = true;
      }
      // A fence of the OTHER character type while already inside a fence
      // is plain content of the current fence (e.g. ``` text containing a
      // literal ~~~ line) — not a delimiter.
    }

    const inFence = isFenceDelimiter ? wasInFence : fenceChar !== null;

    const inBlockquote = /^>/.test(trimmed);

    // HTML comment: handle same-line open/close and multi-line spans.
    let scanPos = 0;
    let lineHasCommentContent = inComment;
    while (true) {
      if (!inComment) {
        const openIdx = raw.indexOf('<!--', scanPos);
        if (openIdx === -1) break;
        inComment = true;
        lineHasCommentContent = true;
        scanPos = openIdx + 4;
      } else {
        const closeIdx = raw.indexOf('-->', scanPos);
        if (closeIdx === -1) break;
        inComment = false;
        scanPos = closeIdx + 3;
      }
    }
    // A line is "in an HTML comment" for heading-detection purposes if ANY
    // part of it was inside a comment span (opened before this line, or
    // opened partway through this line) — conservative: a heading-shaped
    // fragment anywhere near comment markers on this line is suppressed.
    const inHtmlCommentForThisLine = lineHasCommentContent;

    out.push({
      lineNo: i + 1,
      raw,
      inFence,
      isFenceDelimiter,
      inBlockquote,
      inHtmlComment: inHtmlCommentForThisLine,
    });
  }
  return out;
}

/** A line is a candidate for real heading-shaped content iff none of the three suppressing contexts apply. */
function isRealContentLine(ctxLine) {
  return !ctxLine.inFence && !ctxLine.isFenceDelimiter && !ctxLine.inBlockquote && !ctxLine.inHtmlComment;
}

// ─── H-5 / cm#222 A2: HEADING TOTAL CLASSIFICATION ──────────────────────

/**
 * classifyHeading — total classification of one real `##`-level heading's
 * text into exactly one bucket. See file header for the full bucket list.
 *
 * @param {string} headingLine - the full line text, e.g. "## Run commands"
 * @param {Array<{canonical:string, predicate:string}>} durableHeadings
 * @returns {object|null} null iff headingLine is not a `##`-level heading
 *   at all (caller's job to only pass real `##` lines).
 */
function classifyHeading(headingLine, durableHeadings) {
  const trimmedLine = headingLine.trim();
  const m = /^##\s+(.*)$/.exec(trimmedLine);
  if (!m) return null;
  const headingText = m[1].trim();
  const canon = canonicalizeWhitespace(headingText);

  // 1) Durable-section exact match (configured, deterministic — checked
  //    first since it is an explicit mapping, never shadowed by a
  //    heuristic bucket).
  for (const entry of (durableHeadings || [])) {
    if (canonicalizeWhitespace(entry.canonical).toLowerCase() === canon.toLowerCase()) {
      return { type: 'durable', predicate: entry.predicate, canonical: entry.canonical };
    }
  }

  // 2) Session family, WHEN THE HEADING STARTS WITH THE KEYWORD (cm#222
  //    A2/F-2/F-3) — checked before the NEXT-SESSION heuristic below,
  //    because a session heading's own TITLE text can innocuously contain
  //    the word "next" (e.g. "...reload-as-AD-linked is next", a real
  //    pwa-etl example) without being a NEXT-SESSION heading at all.
  //    Dated shape is tried BEFORE numbered (see SESSION_DATED_RE's header
  //    comment: a date's leading digit run would otherwise falsely satisfy
  //    the numbered shape).
  if (SESSION_STARTS_RE.test(trimmedLine)) {
    const datedMatch = SESSION_DATED_RE.exec(trimmedLine);
    if (datedMatch) {
      return {
        type: 'session_dated',
        date: datedMatch[1],
        parenthetical: datedMatch[2] != null ? datedMatch[2].trim() : null,
        title: datedMatch[3].trim(),
      };
    }
    const numberedMatch = SESSION_NUMBERED_RE.exec(trimmedLine);
    if (numberedMatch) {
      return {
        type: 'session_numbered',
        sessionNum: numberedMatch[1],
        date: numberedMatch[2].trim(),
        title: numberedMatch[3].trim(),
      };
    }
    // cm#222 F-3: session-SHAPED (starts with the keyword) but matches
    // neither concrete shape — its own bucket, NEVER merged into the
    // generic `other` list (an operator must be able to tell "N lost
    // session summaries" from "N harmless stray headings").
    return { type: 'session_shaped_unparsed', headingText };
  }

  // 3) NEXT SESSION family (cm#222 A5) — only reachable once the heading
  //    is known NOT to start with "session" itself.
  if (NEXT_SESSION_CANONICAL_RE.test(canon)) {
    return { type: 'next_session' };
  }
  if (NEXT_WORD_RE.test(canon) && SESSION_WORD_RE.test(canon)) {
    return { type: 'next_session_variant', headingText };
  }

  // 4) A heading that mentions "session" SOMEWHERE but not at the start
  //    (and isn't a NEXT-SESSION variant) is still session-shaped for
  //    F-3's purposes — e.g. "## Recap of last session".
  if (SESSION_WORD_RE.test(canon)) {
    return { type: 'session_shaped_unparsed', headingText };
  }

  // 5) Total classification default branch.
  return { type: 'other', headingText };
}

/**
 * detectSessionHeadingLevel — cm#222 A2: "Level: `##` only, unless the
 * file uses `###` for sessions consistently — detect and report the level
 * used." Scoping decision (documented, not silent — see this file's PR
 * blind spots): this DETECTS and REPORTS which level carries session-
 * shaped headings; it does NOT re-architect section-boundary splitting to
 * use `###` as the boundary level even when detected, since no real
 * pwa-etl content exercises an all-`###`-sessions document and doing so
 * would require treating `###` as a top-level boundary throughout (a
 * structural change beyond this fix's scope). `splitDocumentIntoSections`
 * always splits on `##`; this function's result is carried in the report
 * for operator visibility only.
 *
 * @param {string} normalizedText
 * @returns {'##'|'###'}
 */
function detectSessionHeadingLevel(normalizedText) {
  const lines = normalizedText.split('\n');
  const ctx = classifyLineContexts(normalizedText);
  let hasLevel2 = false;
  let hasLevel3 = false;
  for (let i = 0; i < lines.length; i++) {
    if (!isRealContentLine(ctx[i])) continue;
    const trimmed = lines[i].trim();
    const m2 = /^##(?!#)\s+(.*)$/.exec(trimmed);
    if (m2 && SESSION_WORD_RE.test(canonicalizeWhitespace(m2[1]))) hasLevel2 = true;
    const m3 = /^###(?!#)\s+(.*)$/.exec(trimmed);
    if (m3 && SESSION_WORD_RE.test(canonicalizeWhitespace(m3[1]))) hasLevel3 = true;
  }
  if (!hasLevel2 && hasLevel3) return '###';
  return '##';
}

/**
 * splitDocumentIntoSections — finds every real `##`-level heading (H-8-
 * aware) in document order, classifies each (H-5/cm#222 A2), and returns
 * the sections they bound. A `##`-level heading is a line matching
 * `^##\s+\S` at zero indentation with EXACTLY two leading `#` (a `###+`
 * heading is a nested sub-heading, never a top-level boundary here).
 *
 * @param {string} normalizedText
 * @param {Array<{canonical:string, predicate:string}>} durableHeadings
 * @returns {Array<{
 *   type: string, headingLineNo: number, headingLine: string,
 *   classification: object, bodyStartLine: number, bodyEndLine: number,
 *   bodyText: string, rawLineSpan: number,
 * }>}
 */
function splitDocumentIntoSections(normalizedText, durableHeadings) {
  const lines = normalizedText.split('\n');
  const ctx = classifyLineContexts(normalizedText);

  const headingIdxs = [];
  for (let i = 0; i < lines.length; i++) {
    if (!isRealContentLine(ctx[i])) continue;
    const trimmed = lines[i].trim();
    if (/^##(?!#)\s+\S/.test(trimmed)) {
      headingIdxs.push(i); // 0-based line index
    }
  }

  const sections = [];
  for (let h = 0; h < headingIdxs.length; h++) {
    const startIdx = headingIdxs[h];
    const endIdx = (h + 1 < headingIdxs.length) ? headingIdxs[h + 1] : lines.length;
    const bodyStartIdx = startIdx + 1;
    const bodyLines = lines.slice(bodyStartIdx, endIdx);
    const classification = classifyHeading(lines[startIdx], durableHeadings);
    sections.push({
      type: classification ? classification.type : 'other',
      headingLineNo: startIdx + 1,
      headingLine: lines[startIdx],
      classification,
      bodyStartLine: bodyStartIdx + 1,
      bodyEndLine: endIdx, // exclusive upper bound, 1-based (last body line = bodyEndLine)
      bodyText: bodyLines.join('\n'),
      rawLineSpan: bodyLines.length,
    });
  }
  return sections;
}

// ─── H-9 / cm#222 A3: MARKDOWN-TABLE CELL PARSING ───────────────────────

/**
 * splitOnUnescapedPipe — splits a raw table-row line on `|` characters
 * that are NOT escaped. `\|` and `\\` are treated as atomic two-character
 * tokens during the scan (never split inside them); any other lone `\`
 * is passed through literally (defensive: hand-typed tables may contain
 * stray backslashes with no escaping intent — never guess at what a
 * stray backslash meant, just don't treat it as a delimiter escape unless
 * it precedes `|` or `\`).
 *
 * @param {string} line
 * @returns {string[]} raw (still-escaped) cell segments, INCLUDING any
 *   leading/trailing empty segment produced by bounding pipes — callers
 *   trim bounding empties explicitly (see parseTableRowCells).
 */
function splitOnUnescapedPipe(line) {
  const cells = [];
  let cur = '';
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '\\' && i + 1 < line.length && (line[i + 1] === '|' || line[i + 1] === '\\')) {
      cur += ch + line[i + 1];
      i++;
      continue;
    }
    if (ch === '|') {
      cells.push(cur);
      cur = '';
      continue;
    }
    cur += ch;
  }
  cells.push(cur);
  return cells;
}

/**
 * unescapeTableCell — exact inverse of carryover-render.js's `escape()`.
 * escape() order was: backslash-double FIRST, then pipe-escape. Undo in
 * reverse: pipe-unescape FIRST, then backslash-undouble — a single
 * left-to-right scan handles both without a two-pass re-corruption risk
 * (`\|` -> `|`, `\\` -> `\`; any other `\X` sequence is passed through
 * unchanged, defensive against hand-typed content that never went through
 * escape() in the first place).
 *
 * @param {string} raw
 * @returns {string}
 */
function unescapeTableCell(raw) {
  return String(raw).replace(/\\(.)/g, (m, c) => ((c === '|' || c === '\\') ? c : m));
}

const TABLE_SEPARATOR_RE = /^\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?$/;

/**
 * parseTableRowCells — cm#222 A3: split one raw table-row line into its
 * (still-escaped-content-unescaped) cells WITHOUT asserting a cell count.
 * The base for both `parseTableRow` (fixed-count assertion, kept for
 * back-compat / unit tests) and the header-driven row parser below (count
 * derived from the header row itself, per column-name mapping, never a
 * hardcoded literal).
 *
 * @param {string} line
 * @returns {{cells:string[], count:number}} raw (still-escaped) cells,
 *   with a genuinely-empty bounding leading/trailing segment dropped (see
 *   file header note on the inherent ambiguity this shares with GFM
 *   itself for a truly blank edge data cell with no bounding pipe).
 */
function parseTableRowCells(line) {
  const trimmed = line.trim();
  let segments = splitOnUnescapedPipe(trimmed);
  if (segments.length > 1 && segments[0].trim() === '') segments = segments.slice(1);
  if (segments.length > 1 && segments[segments.length - 1].trim() === '') segments = segments.slice(0, -1);
  return { cells: segments, count: segments.length };
}

/**
 * parseTableRow — parse one raw table-row line into exactly N unescaped,
 * trimmed cells, OR a flagged failure. H-9: wrong cell count is ALWAYS a
 * flagged branch, never an index-shifted guess.
 *
 * @param {string} line
 * @param {number} expectedCellCount
 * @returns {{ok:true, cells:string[]}|{ok:false, reason:string, raw:string, actualCellCount:number}}
 */
function parseTableRow(line, expectedCellCount) {
  const { cells: segments } = parseTableRowCells(line);
  if (segments.length !== expectedCellCount) {
    return { ok: false, reason: `expected ${expectedCellCount} cell(s), got ${segments.length}`, raw: line, actualCellCount: segments.length };
  }
  const cells = segments.map((s) => unescapeTableCell(s.trim()));
  return { ok: true, cells };
}

/**
 * isTableSeparatorRow — the `|---|---|` divider row markdown tables carry
 * between header and body.
 */
function isTableSeparatorRow(line) {
  return TABLE_SEPARATOR_RE.test(line.trim());
}

// cm#222 A3: column-name synonym map. Case-insensitive + whitespace-
// canonicalized (via canonicalizeWhitespace + toLowerCase — the SAME
// normalization engine used for headings), applied once. An unrecognized
// header cell name is never coerced to a guessed role — it becomes an
// "extra" column, folded verbatim into notes as `name=value` (never
// silently dropped, never silently misassigned to item/status/notes).
const COLUMN_ROLE_SYNONYMS = {
  item: ['item', 'thread', 'topic', 'task', 'carry-over', 'carryover'],
  status: ['status', 'state'],
  notes: ['notes', 'note', 'detail', 'details', 'comment'],
};

function normalizeColumnName(name) {
  return canonicalizeWhitespace(name).toLowerCase();
}

function resolveColumnRole(name) {
  const norm = normalizeColumnName(name);
  for (const role of Object.keys(COLUMN_ROLE_SYNONYMS)) {
    if (COLUMN_ROLE_SYNONYMS[role].includes(norm)) return role;
  }
  return null;
}

/**
 * buildColumnMap — cm#222 F-7: pins the column-name-to-role mapping.
 * `itemIdx`/`statusIdx` are the FIRST header cell matching that role
 * (documented decision: a second same-role column, e.g. two "Notes"
 * columns, is treated as an extra column rather than silently merged —
 * see this file's PR blind spots); `notesIdxs` collects every notes-role
 * column in header order; `extraIdxs` collects every unrecognized column.
 *
 * @param {string[]} headerCells - raw (untrimmed-not-yet) header cell text
 * @returns {{count:number, names:string[], roles:Array<string|null>, itemIdx:number, statusIdx:number, notesIdxs:number[], extraIdxs:number[]}}
 */
function buildColumnMap(headerCells) {
  const names = headerCells.map((c) => c.trim());
  const roles = names.map((name) => resolveColumnRole(name));
  const itemIdx = roles.indexOf('item');
  const statusIdx = roles.indexOf('status');
  const notesIdxs = [];
  const extraIdxs = [];
  roles.forEach((role, idx) => {
    if (role === 'notes') {
      if (!notesIdxs.length) notesIdxs.push(idx);
      else extraIdxs.push(idx); // cm#222: 2nd+ notes-role column -> extra, documented above
    } else if (role === null) {
      extraIdxs.push(idx);
    }
  });
  return { count: names.length, names, roles, itemIdx, statusIdx, notesIdxs, extraIdxs };
}

// ─── cm#222 A4: STATUS CELL TOTAL CLASSIFICATION ────────────────────────

// Keyword lists pinned by the cm#222 spec-adversary's total-classification
// table (section 3 of the adversary findings). Word-boundary, case-
// insensitive substring scan over the WHOLE cell text — never an exact-
// match enum, since real Status cells are free-text narrative (F-4).
const CLOSED_KEYWORDS = ['DONE', 'MERGED', 'SHIPPED', 'SOLVED', 'RESOLVED', 'COMPLETE', 'COMPLETED', 'FIXED'];
const OPEN_KEYWORDS = ['OPEN', 'NOT RUN', 'NOT BUILT', 'UNEXERCISED', 'PENDING', 'BLOCKED', 'TODO', 'DEFERRED', 'OWNER-GATED', 'UNPROVEN'];

// cm#222 own decision (the adversary's A4 line references "the adversary
// table" for an emoji map, but no such table is present in the findings
// file this PR was authored against — see this PR's blind spots): a
// narrow, defensible 3-emoji mapping, additive to the keyword scan and
// subject to the SAME dual-signal-wins-unknown rule.
const CLOSED_EMOJI = ['✅'];
const OPEN_EMOJI = ['❌', '⏳'];

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function keywordHits(text, keywords) {
  return keywords.filter((kw) => new RegExp(`\\b${escapeRegExp(kw)}\\b`, 'i').test(text));
}

/**
 * classifyStatusCell — cm#222 A4: total classification of one Status cell
 * into exactly one of `closed` / `open` / `unknown`. `unknown` is the
 * default branch — empty cell, a cell matching neither list, AND a cell
 * matching BOTH lists (dual signal) all land here, by design: a dual-
 * signal cell is never resolved by a "last keyword wins" or "closed wins"
 * tiebreak invented ad hoc (cm#222 F-4).
 *
 * @param {string} raw
 * @returns {{class:'closed'|'open'|'unknown', dualSignal:boolean, matchedClosed:string[], matchedOpen:string[]}}
 */
function classifyStatusCell(raw) {
  const text = String(raw == null ? '' : raw).trim();
  if (text === '') return { class: 'unknown', dualSignal: false, matchedClosed: [], matchedOpen: [] };
  const matchedClosed = keywordHits(text, CLOSED_KEYWORDS);
  const matchedOpen = keywordHits(text, OPEN_KEYWORDS);
  const closedHit = matchedClosed.length > 0 || CLOSED_EMOJI.some((e) => text.includes(e));
  const openHit = matchedOpen.length > 0 || OPEN_EMOJI.some((e) => text.includes(e));
  if (closedHit && openHit) return { class: 'unknown', dualSignal: true, matchedClosed, matchedOpen };
  if (closedHit) return { class: 'closed', dualSignal: false, matchedClosed, matchedOpen };
  if (openHit) return { class: 'open', dualSignal: false, matchedClosed, matchedOpen };
  return { class: 'unknown', dualSignal: false, matchedClosed, matchedOpen };
}

/**
 * classifyCarryoverHeading — total classification of one `###`-level
 * heading's text against the carry-over-table convention. Returns
 * `'canonical'` (parse its table), `'variant'` (carry-over-shaped but not
 * the canonical form — report with a line number, table never guessed/
 * parsed), or `null` (not carry-over-shaped at all, e.g. "### Done" —
 * outside this classifier's domain, ignored).
 *
 * @param {string} headingText - text AFTER the leading `### `
 * @returns {'canonical'|'variant'|null}
 */
function classifyCarryoverHeading(headingText) {
  const canon = canonicalizeWhitespace(headingText);
  if (CARRYOVER_CANONICAL_RE.test(canon)) return 'canonical';
  if (CARRYOVER_WORD_RE_1.test(canon) && CARRYOVER_WORD_RE_2.test(canon)) return 'variant';
  return null;
}

/**
 * findOpenCarryoverTables — cm#222 A3 rewrite: scans a section's body text
 * for every `### Open carry-overs` sub-heading (H-8-aware, same as
 * top-level headings) and parses the HEADER-DRIVEN table that follows —
 * cell count and column roles derived from the header row itself (cm#222
 * F-1: the old hardcoded 2-cell assumption failed on 100% of real
 * pwa-etl rows, which are 3-column) — or recognizes the renderer's own
 * `_(no open carry-overs)_` empty-state placeholder as zero rows, never a
 * parse error.
 *
 * HEADER DETECTION IS STRUCTURAL, NEVER POSITIONAL (independent-review
 * fix, PR #172 blocker 1; reaffirmed cm#222 F-8): the first content line
 * after the heading is a HEADER only if the line immediately following it
 * is a valid separator row. The two checks COMPOSE (structural separator
 * check AND name-matching) — name-matching never replaces the structural
 * check, so a headerless table whose first row happens to literally read
 * `| Item | Status | Notes |` as DATA is never misclassified as a header.
 *
 * A table with NO header row at all cannot have its columns named — cm#222
 * decision (undictated by the spec/adversary, documented here): column 0
 * is always the item/subject; every other column is an unnamed "extra"
 * column folded into notes; status is always `unknown` for every row
 * (consistent with, and a strict generalization of, A3's own "missing
 * status column -> unknown for every row" rule).
 *
 * A header row present but carrying NO recognizable item-role column
 * (cm#222 F-7) flags the WHOLE table — never guessed by position, even
 * when the cell count happens to match.
 *
 * TOTALITY (H-9, extended cm#222 A3): every content line under the
 * heading is placed into exactly one of: a well-formed row (`rows`), a
 * malformed row (`flaggedRows`), or a boundary (blank line / next heading
 * / EOF). A blank line ends the table; any further pipe-shaped, non-blank
 * line found BEFORE the next heading is an `orphanRows` entry (cm#222
 * F-6) — never silently dropped. Multiple `### Open carry-overs` headings
 * in one section body are all parsed independently.
 *
 * cm#222 follow-up: the heading match itself is now a total classification
 * (`classifyCarryoverHeading`) rather than an exact anchor — a variant
 * heading (contains "carry" and "over" but isn't the canonical form) is
 * reported in `carryoverHeadingVariants`, never silently un-extracted.
 *
 * @param {string} bodyText
 * @param {number} bodyStartLineNo - 1-based line number bodyText's line 0 corresponds to, for report accuracy
 * @returns {{
 *   tables: Array<{
 *     headingLineNo: number,
 *     columns: string[]|null,
 *     rows: Array<{itemRaw:string, statusRaw:string, statusClass:string, statusDualSignal:boolean, notesRaw:string, lineNo:number, subjectRaw:string, objectRaw:string}>,
 *     flaggedRows: Array<{raw:string, reason:string, lineNo:number}>,
 *     orphanRows: Array<{raw:string, lineNo:number}>,
 *   }>,
 *   carryoverHeadingVariants: Array<{headingLine:string, headingLineNo:number}>,
 * }}
 */
function findOpenCarryoverTables(bodyText, bodyStartLineNo) {
  const lines = bodyText.split('\n');
  const ctx = classifyLineContexts(bodyText);
  const results = [];
  const carryoverHeadingVariants = [];

  const isHeadingBoundary = (idx) => idx >= lines.length || /^#{2,3}(?!#)\s+/.test(lines[idx].trim());

  for (let i = 0; i < lines.length; i++) {
    if (!isRealContentLine(ctx[i])) continue;
    const trimmed = lines[i].trim();
    const headingMatch = /^###(?!#)\s+(.*)$/.exec(trimmed);
    if (!headingMatch) continue;
    const carryoverKind = classifyCarryoverHeading(headingMatch[1]);
    if (carryoverKind === null) continue; // not carry-over-shaped at all — outside this classifier's domain
    if (carryoverKind === 'variant') {
      carryoverHeadingVariants.push({ headingLine: lines[i], headingLineNo: bodyStartLineNo + i });
      continue; // reported, never guessed/parsed as a table
    }

    const headingLineNo = bodyStartLineNo + i;
    const rows = [];
    const flaggedRows = [];
    const orphanRows = [];

    let j = i + 1;
    while (j < lines.length && lines[j].trim() === '') j++;

    if (isHeadingBoundary(j)) {
      results.push({ headingLineNo, columns: null, rows, flaggedRows, orphanRows });
      continue;
    }

    if (/^_\(.*\)_$/.test(lines[j].trim())) {
      results.push({ headingLineNo, columns: null, rows, flaggedRows, orphanRows });
      continue;
    }

    // STRUCTURAL header detection, validated against the header's OWN
    // cell count (cm#222 A3: "separator row must exist and be validated").
    let k = j;
    let columns = null;
    let wholeTableFlagged = false;
    const headerCellsAttempt = parseTableRowCells(lines[j]);
    const separatorLooksValid = (j + 1 < lines.length)
      && isTableSeparatorRow(lines[j + 1])
      && parseTableRowCells(lines[j + 1]).count === headerCellsAttempt.count;
    const headerPresent = separatorLooksValid;

    if (headerPresent) {
      columns = buildColumnMap(headerCellsAttempt.cells);
      k = j + 2;
      if (columns.itemIdx === -1) wholeTableFlagged = true;
    }

    for (; k < lines.length; k++) {
      const rowTrimmed = lines[k].trim();
      if (rowTrimmed === '') break;
      if (/^#{2,3}(?!#)\s+/.test(rowTrimmed)) break;
      const lineNo = bodyStartLineNo + k;
      if (!rowTrimmed.includes('|')) {
        flaggedRows.push({ raw: lines[k], reason: 'expected a pipe-delimited table row, blank line, or heading — found neither', lineNo });
        continue;
      }
      const { cells } = parseTableRowCells(rowTrimmed);

      if (headerPresent) {
        if (wholeTableFlagged) {
          flaggedRows.push({ raw: lines[k], reason: 'no item/subject column identified in the header — whole table flagged, never guessed by position', lineNo });
          continue;
        }
        if (cells.length !== columns.count) {
          flaggedRows.push({ raw: lines[k], reason: `expected ${columns.count} cell(s) (from header), got ${cells.length}`, lineNo });
          continue;
        }
        rows.push(buildRowFromColumns(cells, columns, lineNo));
      } else {
        rows.push(buildHeaderlessRow(cells, lineNo));
      }
    }

    if (headerPresent && !wholeTableFlagged && rows.length === 0 && flaggedRows.length === 0) {
      flaggedRows.push({
        raw: lines[j],
        reason: 'header-only table: a header + separator row was present but zero data rows followed (use the renderer\'s "_(no open carry-overs)_" placeholder for a genuinely empty table, not a bare header)',
        lineNo: bodyStartLineNo + j,
      });
    }

    // cm#222 F-6: a table ended by a blank line — scan forward (before the
    // next heading) for any stray pipe-shaped line and report it as an
    // orphan row, never silently drop it.
    if (k < lines.length && lines[k].trim() === '') {
      let m = k + 1;
      while (m < lines.length && !/^#{2,3}(?!#)\s+/.test(lines[m].trim())) {
        const t = lines[m].trim();
        if (t !== '' && t.includes('|')) {
          orphanRows.push({ raw: lines[m], lineNo: bodyStartLineNo + m });
        }
        m++;
      }
    }

    results.push({ headingLineNo, columns: columns ? columns.names : null, rows, flaggedRows, orphanRows });
  }

  return { tables: results, carryoverHeadingVariants };
}

function buildRowFromColumns(cells, columns, lineNo) {
  const itemRaw = unescapeTableCell(cells[columns.itemIdx].trim());
  const hasStatus = columns.statusIdx !== -1;
  const statusRaw = hasStatus ? unescapeTableCell(cells[columns.statusIdx].trim()) : '';
  const statusClassification = hasStatus ? classifyStatusCell(statusRaw) : { class: 'unknown', dualSignal: false };
  const notesParts = columns.notesIdxs
    .map((idx) => unescapeTableCell(cells[idx].trim()))
    .filter((s) => s !== '');
  const extraParts = columns.extraIdxs.map((idx) => {
    const colName = canonicalizeWhitespace(columns.names[idx]);
    const val = unescapeTableCell(cells[idx].trim());
    return `${colName}=${val}`;
  });
  const notesRaw = [...notesParts, ...extraParts].join('; ');
  return {
    itemRaw,
    statusRaw,
    statusClass: statusClassification.class,
    statusDualSignal: !!statusClassification.dualSignal,
    notesRaw,
    lineNo,
    // Back-compat field names for existing callers (migrate-08's
    // parseFileIntoRows) that read subjectRaw/objectRaw.
    subjectRaw: itemRaw,
    objectRaw: notesRaw,
  };
}

function buildHeaderlessRow(cells, lineNo) {
  const itemRaw = unescapeTableCell((cells[0] || '').trim());
  const extraParts = [];
  for (let idx = 1; idx < cells.length; idx++) {
    extraParts.push(`col${idx + 1}=${unescapeTableCell(cells[idx].trim())}`);
  }
  const notesRaw = extraParts.join('; ');
  return {
    itemRaw,
    statusRaw: '',
    statusClass: 'unknown',
    statusDualSignal: false,
    notesRaw,
    lineNo,
    subjectRaw: itemRaw,
    objectRaw: notesRaw,
  };
}

// ─── H-11: NEXT SESSION LIST-ITEM PARSING ────────────────────────────────

const OUTERMOST_LIST_ITEM_RE = /^(?:\d+[.)]|[-*+])\s+(?:\[[ xX]\]\s+)?(.*)$/;
const EMPTY_PLACEHOLDER_RE = /^_\(.*\)_$/;

/**
 * parseNextSessionItems — H-11: one item = one outermost-indent
 * (zero-leading-whitespace) list line; any indented continuation line or
 * nested sub-bullet folds into the PARENT item's text (joined with a
 * space); checkbox decoration (`[ ]`/`[x]`/`[X]`) is stripped from the
 * item's own leading marker.
 *
 * @param {string} bodyText
 * @returns {string[]} raw item text, one per outermost list line, in
 *   document order (caller assigns seq).
 */
function parseNextSessionItems(bodyText) {
  const lines = bodyText.split('\n');
  const items = [];
  let current = null;

  for (const line of lines) {
    if (line.trim() === '') continue;
    if (EMPTY_PLACEHOLDER_RE.test(line.trim())) continue;

    const hasLeadingWhitespace = /^[ \t]/.test(line);
    if (!hasLeadingWhitespace) {
      const m = OUTERMOST_LIST_ITEM_RE.exec(line.trim());
      if (m) {
        if (current !== null) items.push(current);
        current = m[1].trim();
        continue;
      }
      // A non-indented, non-list-marker line while a heading's body is
      // otherwise expected to be a NEXT SESSION list: treat as its own
      // top-level continuation-less stray line, folded nowhere — flagged
      // implicitly by simply not becoming an item (fail-soft; the
      // per-project report's raw-line/parsed-row tally surfaces the drop).
      continue;
    }
    // Indented: continuation or nested sub-bullet, folds into current.
    if (current !== null) {
      const stripped = line.trim().replace(/^(?:\[[ xX]\]\s+)?(?:[-*+]\s+)?/, '');
      current = `${current} ${stripped}`.trim();
    }
  }
  if (current !== null) items.push(current);
  return items;
}

// ─── H-12: BODY-LENGTH-DELTA HEURISTIC ──────────────────────────────────

/**
 * computeBodyLengthDeltaFlags — H-12's per-block heuristic: for a FILE
 * with 2+ detected session blocks, flag any block whose rawLineSpan is
 * more than 2x or less than 0.5x the MEDIAN rawLineSpan across that
 * file's own session blocks. A lone (0 or 1) session block in a file
 * cannot be compared to siblings and is never flagged by this heuristic
 * (documented blind spot: this is a same-file-relative check, not an
 * absolute ground-truth check).
 *
 * @param {Array<{headingLineNo:number, rawLineSpan:number}>} sessionSections
 * @returns {Array<{headingLineNo:number, rawLineSpan:number, medianSpan:number, ratio:number}>}
 */
function computeBodyLengthDeltaFlags(sessionSections) {
  if (!sessionSections || sessionSections.length < 2) return [];
  const spans = sessionSections.map((s) => s.rawLineSpan).slice().sort((a, b) => a - b);
  const mid = Math.floor(spans.length / 2);
  const median = spans.length % 2 === 0 ? (spans[mid - 1] + spans[mid]) / 2 : spans[mid];
  if (median <= 0) return [];
  const flags = [];
  for (const s of sessionSections) {
    const ratio = s.rawLineSpan / median;
    if (ratio > 2 || ratio < 0.5) {
      flags.push({ headingLineNo: s.headingLineNo, rawLineSpan: s.rawLineSpan, medianSpan: median, ratio });
    }
  }
  return flags;
}

module.exports = {
  RECOGNIZED_DASHES,
  SEP_TOKEN_SRC,
  SESSION_NUMBERED_RE,
  SESSION_DATED_RE,
  UNRECOGNIZED_DASH_RE,
  NEXT_SESSION_CANONICAL_RE,
  canonicalizeWhitespace,
  normalizeMarkdown,
  classifyLineContexts,
  isRealContentLine,
  classifyHeading,
  detectSessionHeadingLevel,
  splitDocumentIntoSections,
  splitOnUnescapedPipe,
  unescapeTableCell,
  parseTableRowCells,
  parseTableRow,
  isTableSeparatorRow,
  buildColumnMap,
  resolveColumnRole,
  classifyStatusCell,
  CARRYOVER_CANONICAL_RE,
  classifyCarryoverHeading,
  findOpenCarryoverTables,
  parseNextSessionItems,
  computeBodyLengthDeltaFlags,
  CLOSED_KEYWORDS,
  OPEN_KEYWORDS,
  CLOSED_EMOJI,
  OPEN_EMOJI,
};
