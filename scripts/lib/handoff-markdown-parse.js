'use strict';

/**
 * handoff-markdown-parse.js — fenced-code/blockquote/HTML-comment-aware
 * line classifier + markdown-table cell parser for
 * scripts/migrations/migrate-08-handoff-markdown.js (CONSOLIDATION-
 * RUNBOOK.md §6.1(h) + its H-1..H-14 spec-adversary amendment,
 * memory-manager#11(h)).
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
 * TOTAL CLASSIFICATION (H-5): every real (non-fenced/blockquote/comment)
 * `##`-level heading in the document is classified into EXACTLY ONE of
 * four buckets — session-block / durable-section / next-session /
 * unknown-flagged — never a fifth "ignored" bucket. An unknown-flagged
 * heading still terminates the PRIOR section's body (it is a real section
 * boundary), it simply produces no assertion row of its own; it is always
 * reported, never silently dropped.
 *
 * NORMALIZATION (H-10): callers MUST run `normalizeMarkdown()` on raw file
 * content before any other function in this module sees it. BOM strip,
 * CRLF -> LF, per-line trailing-whitespace trim, and a dash-class scan
 * that FLAGS (never silently coerces) any Unicode dash character used
 * adjacent to what looks like a heading separator that is not one of the
 * three characters H-5's pinned regex already recognizes (em dash U+2014,
 * en dash U+2013, hyphen-minus U+002D) — those three need no coercion
 * since the regex already accepts all three as-is.
 */

const RECOGNIZED_DASHES = ['—', '–', '-']; // em, en, hyphen-minus
const DASH_CLASS = '[—–-]';

// H-5: PINNED regex, single dash-class character class. Group 1 = session
// number, group 2 = date (non-greedy, stops at the NEXT dash), group 3 =
// title (greedy — deliberately swallows any FURTHER embedded dashes; this
// is what makes a "4-way-split" heading like
// "## Session 3 — Part A — Fixed the bug — v2" parse DETERMINISTICALLY as
// date="Part A", title="Fixed the bug — v2", never ambiguous, never a
// guess).
const SESSION_HEADING_RE = /^##\s+Session\s+(\d+)\s+[—–-]\s+(.+?)\s+[—–-]\s+(.+)$/;

// Any Unicode dash-punctuation-class character NOT in RECOGNIZED_DASHES.
// Deliberately narrow (Pd-category dashes commonly confused with the
// recognized three) rather than the full Unicode Pd category, which also
// contains characters no realistic HANDOFF.md would use as a heading
// separator — narrowest set that resolves the actual observed confusable
// class (figure dash, horizontal bar, small em dash, two-em/three-em dash,
// swung dash, minus sign).
const UNRECOGNIZED_DASH_RE = /[‐‑‒―﹘﹣⸺⸻⁓−]/g;

const NEXT_SESSION_HEADING_RE = /^next\s+session$/i;

// ─── H-10: NORMALIZATION ────────────────────────────────────────────────

/**
 * normalizeMarkdown — BOM strip, CRLF -> LF, per-line trailing-whitespace
 * trim, unrecognized-dash flagging (never silent coercion). Must be run
 * BEFORE any other function in this module sees the file's raw content.
 *
 * @param {string} raw
 * @returns {{ text: string, bomStripped: boolean, flags: Array<{type:string, line:number, char:string}> }}
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
    let inHtmlCommentForThisLine = inComment;
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
    inHtmlCommentForThisLine = lineHasCommentContent;

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

// ─── H-5: HEADING TOTAL CLASSIFICATION ──────────────────────────────────

/**
 * classifyHeading — total classification of one real `##`-level heading's
 * text into exactly one bucket.
 *
 * @param {string} headingLine - the full line text, e.g. "## Run commands"
 * @param {Array<{canonical:string, predicate:string}>} durableHeadings
 * @returns {{type:'session', sessionNum:string, date:string, title:string}
 *         | {type:'durable', predicate:string, canonical:string}
 *         | {type:'next_session'}
 *         | {type:'unknown', headingText:string}
 *         | null} null iff headingLine is not a `##`-level heading at all
 *           (caller's job to only pass real `##` lines).
 */
function classifyHeading(headingLine, durableHeadings) {
  const m = /^##\s+(.*)$/.exec(headingLine.trim());
  if (!m) return null;
  const headingText = m[1].trim();

  const sessionMatch = SESSION_HEADING_RE.exec(headingLine.trim());
  if (sessionMatch) {
    return { type: 'session', sessionNum: sessionMatch[1], date: sessionMatch[2].trim(), title: sessionMatch[3].trim() };
  }

  if (NEXT_SESSION_HEADING_RE.test(headingText)) {
    return { type: 'next_session' };
  }

  const normalizedHeadingText = headingText.toLowerCase().trim();
  for (const entry of (durableHeadings || [])) {
    if (String(entry.canonical || '').toLowerCase().trim() === normalizedHeadingText) {
      return { type: 'durable', predicate: entry.predicate, canonical: entry.canonical };
    }
  }

  return { type: 'unknown', headingText };
}

/**
 * splitDocumentIntoSections — finds every real `##`-level heading (H-8-
 * aware) in document order, classifies each (H-5), and returns the
 * sections they bound. A `##`-level heading is a line matching
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
      type: classification ? classification.type : 'unknown',
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

// ─── H-9: MARKDOWN-TABLE CELL PARSING (inverse of renderCarryoverTable) ──

/**
 * splitOnUnescapedPipe — splits a raw table-row line on `|` characters
 * that are NOT escaped. `\|` and `\\` are treated as atomic two-character
 * tokens during the scan (never split inside them); any other lone `\`
 * is passed through literally (defensive: hand-typed tables may contain
 * stray backslashes with no escaping intent — H-9's "never index-shift"
 * requirement means we never guess at what a stray backslash meant, we
 * just don't treat it as a delimiter escape unless it precedes `|` or `\`).
 *
 * @param {string} line
 * @returns {string[]} raw (still-escaped) cell segments, INCLUDING any
 *   leading/trailing empty segment produced by bounding pipes — callers
 *   trim bounding empties explicitly (see parseTableRow).
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
 * parseTableRow — parse one raw table-row line into exactly N unescaped,
 * trimmed cells, OR a flagged failure. H-9: wrong cell count is ALWAYS a
 * flagged branch, never an index-shifted guess.
 *
 * @param {string} line
 * @param {number} expectedCellCount
 * @returns {{ok:true, cells:string[]}|{ok:false, reason:string, raw:string, actualCellCount:number}}
 */
function parseTableRow(line, expectedCellCount) {
  const raw = line;
  const trimmed = line.trim();
  let segments = splitOnUnescapedPipe(trimmed);
  // Drop a genuinely-empty leading/trailing segment produced by an
  // (optional, GFM-standard) bounding pipe — only the FIRST/LAST segment,
  // and only when it is empty after trim (see file header note on the
  // inherent ambiguity this shares with GFM itself for a truly blank edge
  // data cell with no bounding pipe).
  if (segments.length > 1 && segments[0].trim() === '') segments = segments.slice(1);
  if (segments.length > 1 && segments[segments.length - 1].trim() === '') segments = segments.slice(0, -1);

  if (segments.length !== expectedCellCount) {
    return { ok: false, reason: `expected ${expectedCellCount} cell(s), got ${segments.length}`, raw, actualCellCount: segments.length };
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

/**
 * findOpenCarryoverTables — scans a section's body text for every
 * `### Open carry-overs` sub-heading (H-8-aware within the body itself —
 * fenced/blockquoted/commented fake sub-headings are skipped the same
 * way top-level headings are) and parses the 2-column (Subject, Detail)
 * table that follows each one — or recognizes the renderer's own
 * `_(no open carry-overs)_` empty-state placeholder as zero rows, never a
 * parse error.
 *
 * HEADER DETECTION IS STRUCTURAL, NEVER POSITIONAL (independent-review
 * fix, PR #172 blocker 1): the first content line after the heading is a
 * HEADER only if the line immediately following it matches
 * `isTableSeparatorRow` (a `|---|---|`-shaped divider). If it does not,
 * the first content line is DATA — a hand-typed table with no
 * header/separator row is still parsed in full, never silently losing its
 * first row to a positional "line 1 is always the header" assumption.
 *
 * TOTALITY (H-9): every content line under the heading is placed into
 * exactly one of three buckets — a well-formed row (`rows`), a malformed
 * row (`flaggedRows`, e.g. wrong cell count, or a line with no `|` at
 * all), or a boundary (blank line / next heading / EOF, which ends the
 * table). No line is ever silently skipped. A header+separator pair
 * followed by ZERO data/flagged rows (a "header-only" table) is itself
 * flagged — distinct from the renderer's own explicit `_(none)_`
 * empty-state placeholder, and therefore a suspicious, hand-edited shape
 * that should never be silently indistinguishable from a genuinely empty
 * section.
 *
 * @param {string} bodyText
 * @param {number} bodyStartLineNo - 1-based line number bodyText's line 0 corresponds to, for report accuracy
 * @returns {Array<{
 *   headingLineNo: number,
 *   rows: Array<{subjectRaw:string, objectRaw:string, lineNo:number}>,
 *   flaggedRows: Array<{raw:string, reason:string, lineNo:number}>,
 * }>}
 */
function findOpenCarryoverTables(bodyText, bodyStartLineNo) {
  const lines = bodyText.split('\n');
  const ctx = classifyLineContexts(bodyText);
  const results = [];

  for (let i = 0; i < lines.length; i++) {
    if (!isRealContentLine(ctx[i])) continue;
    const trimmed = lines[i].trim();
    if (!/^###(?!#)\s+open\s+carry-?overs\s*$/i.test(trimmed)) continue;

    const headingLineNo = bodyStartLineNo + i;
    const rows = [];
    const flaggedRows = [];

    // Skip blank lines to find the first content line after the heading.
    let j = i + 1;
    while (j < lines.length && lines[j].trim() === '') j++;

    const isBoundary = (idx) => idx >= lines.length || lines[idx].trim() === '' || /^#{2,3}(?!#)\s+/.test(lines[idx].trim());

    if (isBoundary(j)) {
      // Nothing at all under this heading before the next boundary —
      // legitimately empty (the renderer's own convention is to always
      // emit the `_(none)_` placeholder for a truly empty table, so an
      // outright-blank section is not itself suspicious the way a
      // header-only table is).
      results.push({ headingLineNo, rows, flaggedRows });
      continue;
    }

    if (/^_\(.*\)_$/.test(lines[j].trim())) {
      // Empty-state placeholder — zero rows, not an error.
      results.push({ headingLineNo, rows, flaggedRows });
      continue;
    }

    // STRUCTURAL header detection: line j is a header iff line j+1 is a
    // separator row. Otherwise line j is DATA (headerless table).
    let k = j;
    const headerPresent = (j + 1 < lines.length) && isTableSeparatorRow(lines[j + 1]);
    if (headerPresent) {
      k = j + 2; // skip header row + separator row
    }

    for (; k < lines.length; k++) {
      const rowTrimmed = lines[k].trim();
      if (rowTrimmed === '') break;
      if (/^#{2,3}(?!#)\s+/.test(rowTrimmed)) break;
      const lineNo = bodyStartLineNo + k;
      if (!rowTrimmed.includes('|')) {
        // A non-blank, non-heading line under this heading that cannot be
        // placed as a table row at all (no pipe delimiter whatsoever) —
        // H-9 totality: flagged, never silently skipped or treated as an
        // implicit end-of-table boundary.
        flaggedRows.push({ raw: lines[k], reason: 'expected a pipe-delimited table row, blank line, or heading — found neither', lineNo });
        continue;
      }
      const parsed = parseTableRow(rowTrimmed, 2);
      if (parsed.ok) {
        rows.push({ subjectRaw: parsed.cells[0], objectRaw: parsed.cells[1], lineNo });
      } else {
        flaggedRows.push({ raw: lines[k], reason: parsed.reason, lineNo });
      }
    }

    if (headerPresent && rows.length === 0 && flaggedRows.length === 0) {
      flaggedRows.push({
        raw: lines[j],
        reason: 'header-only table: a header + separator row was present but zero data rows followed (use the renderer\'s "_(no open carry-overs)_" placeholder for a genuinely empty table, not a bare header)',
        lineNo: bodyStartLineNo + j,
      });
    }

    results.push({ headingLineNo, rows, flaggedRows });
  }

  return results;
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
 * computeBodyLengthDeltaFlags — H-12's per-block heuristic, this file's
 * own concrete design decision (the amendment specifies the >2x/<0.5x
 * threshold shape, not the baseline it is measured against — no prior art
 * exists in this repo to reuse, so this is a documented new decision, not
 * a restated one): for a FILE with 2+ detected session blocks, flag any
 * block whose rawLineSpan is more than 2x or less than 0.5x the MEDIAN
 * rawLineSpan across that file's own session blocks. A lone (0 or 1)
 * session block in a file cannot be compared to siblings and is never
 * flagged by this heuristic (documented blind spot: this is a
 * same-file-relative check, not an absolute ground-truth check — it
 * catches a merged-block anomaly relative to a project's OWN typical
 * session-entry size, not against any external baseline).
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
  SESSION_HEADING_RE,
  UNRECOGNIZED_DASH_RE,
  NEXT_SESSION_HEADING_RE,
  normalizeMarkdown,
  classifyLineContexts,
  isRealContentLine,
  classifyHeading,
  splitDocumentIntoSections,
  splitOnUnescapedPipe,
  unescapeTableCell,
  parseTableRow,
  isTableSeparatorRow,
  findOpenCarryoverTables,
  parseNextSessionItems,
  computeBodyLengthDeltaFlags,
};
