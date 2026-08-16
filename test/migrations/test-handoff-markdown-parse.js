'use strict';

/**
 * test-handoff-markdown-parse.js — pure unit tests for
 * scripts/lib/handoff-markdown-parse.js (CONSOLIDATION-RUNBOOK.md
 * §6.1(h) H-1..H-14 amendment, memory-manager#11(h)). No DB, no fixture
 * files on disk — every fixture is an inline SYNTHETIC string literal
 * (invented project/session names/content only, per H-13's public-repo
 * sanitization rule).
 *
 * Covers every adversary construction named in the authoring brief:
 *   - H-5/H-6: dash variants (recognized vs unrecognized, flagged not
 *     coerced), 4-way-split titles (deterministic non-greedy/greedy
 *     capture), duplicate session N (both rows survive + flagged as a
 *     named collision event).
 *   - H-8: fake headings inside fenced code, blockquotes, and HTML
 *     comments (single-line and multi-line) — none become real sections.
 *   - H-9: pipes-in-cells (escaped), backslash escaping, and hand-typed
 *     variable-cell-count tables (flagged, never index-shifted).
 *   - H-10: BOM strip, CRLF -> LF, trailing-whitespace trim.
 *   - H-11: nested/multi-line/checkbox NEXT SESSION items.
 *   - H-12: merged-block detection via the body-length-delta heuristic.
 *
 * Usage: node test/migrations/test-handoff-markdown-parse.js
 * Exit 0 = all pass; nonzero = any failure.
 */

const path = require('path');
const mdParse = require(path.join('..', '..', 'scripts', 'lib', 'handoff-markdown-parse.js'));

let passed = 0;
let failed = 0;
function pass(id, label) { console.log(`[${id}] ${label} ... PASS`); passed++; }
function fail(id, label, reason) { console.log(`[${id}] ${label} ... FAIL: ${reason}`); failed++; }
function run(id, label, fn) {
  try { fn(); pass(id, label); } catch (err) { fail(id, label, err && err.message ? err.message : String(err)); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }
function assertEq(actual, expected, msg) {
  if (actual !== expected) throw new Error(`${msg}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

const DURABLE = [
  { canonical: 'Run commands', predicate: 'run_commands' },
  { canonical: 'Critical operational notes', predicate: 'critical_operational_notes' },
  { canonical: 'Key paths', predicate: 'key_paths' },
];

// ─── H-10: normalization ───────────────────────────────────────────────

run('H10-1', 'BOM is stripped and reported', () => {
  const r = mdParse.normalizeMarkdown('﻿## NEXT SESSION\n\n1. item\n');
  assert(r.bomStripped === true, 'bomStripped flag not set');
  assert(!r.text.startsWith('﻿'), 'BOM still present in output text');
});

run('H10-2', 'CRLF is normalized to LF', () => {
  const r = mdParse.normalizeMarkdown('## NEXT SESSION\r\n\r\n1. item\r\n');
  assert(!r.text.includes('\r'), 'CR survived normalization');
  assertEq(r.text.split('\n').length, 4, 'unexpected line count after CRLF normalization');
});

run('H10-3', 'trailing whitespace is trimmed per line', () => {
  const r = mdParse.normalizeMarkdown('## NEXT SESSION   \n\n1. item   \t\n');
  const lines = r.text.split('\n');
  assertEq(lines[0], '## NEXT SESSION', 'trailing spaces survived on heading line');
  assertEq(lines[2], '1. item', 'trailing whitespace survived on list line');
});

run('H10-4', 'recognized dashes (em/en/hyphen) never flagged', () => {
  const r = mdParse.normalizeMarkdown('## Session 1 — 2026-01-01 — T\n## Session 2 – 2026-01-02 – T\n## Session 3 - 2026-01-03 - T\n');
  assertEq(r.flags.length, 0, 'recognized dash characters were incorrectly flagged');
});

run('H10-5', 'unrecognized Unicode dash is flagged, never silently coerced', () => {
  // U+2012 FIGURE DASH — not one of the three H-5-recognized dashes.
  const r = mdParse.normalizeMarkdown('## Session 1 ‒ 2026-01-01 ‒ Title\n');
  assert(r.flags.length >= 1, 'unrecognized dash was not flagged');
  assertEq(r.flags[0].type, 'unrecognized-dash', 'wrong flag type');
  // And it must NOT silently match the session-heading shape (since the
  // pinned regex's dash class does not include it) — total classification
  // sends it to "unknown", not a mis-parsed "session".
  const sections = mdParse.splitDocumentIntoSections(r.text, DURABLE);
  assertEq(sections[0].type, 'unknown', 'unrecognized-dash heading was wrongly classified as a session block');
});

// ─── H-5: heading total classification ──────────────────────────────────

run('H5-1', 'session heading regex matches all three recognized dash classes', () => {
  for (const dash of mdParse.RECOGNIZED_DASHES) {
    const line = `## Session 7 ${dash} 2026-02-01 ${dash} Fixed the thing`;
    const m = mdParse.SESSION_HEADING_RE.exec(line);
    assert(m, `dash "${dash}" did not match SESSION_HEADING_RE`);
    assertEq(m[1], '7', 'session number mismatch');
    assertEq(m[2], '2026-02-01', 'date mismatch');
    assertEq(m[3], 'Fixed the thing', 'title mismatch');
  }
});

run('H5-2', '4-way-split title resolves deterministically (non-greedy date, greedy title)', () => {
  const line = '## Session 3 — Part A — Fixed the widget — v2';
  const m = mdParse.SESSION_HEADING_RE.exec(line);
  assert(m, 'regex failed to match a 4-way-split heading');
  assertEq(m[2], 'Part A', 'date group should be the minimal non-greedy match up to the NEXT dash');
  assertEq(m[3], 'Fixed the widget — v2', 'title group should greedily swallow all remaining dashes');
});

run('H5-3', 'total classification: every ## heading lands in exactly one of four buckets', () => {
  const doc = [
    '## NEXT SESSION',
    '', '1. item', '',
    '## Session 1 — 2026-01-01 — Title',
    '', 'body', '',
    '## Run commands',
    '', 'npm test', '',
    '## Something Totally Unexpected',
    '', 'mystery', '',
  ].join('\n');
  const sections = mdParse.splitDocumentIntoSections(doc, DURABLE);
  const types = sections.map((s) => s.type);
  assertEq(types.join(','), 'next_session,session,durable,unknown', 'total classification did not produce the expected 4-bucket sequence');
});

run('H5-4', 'unknown heading still bounds sections (does not swallow neighboring content)', () => {
  const doc = ['## Something Unexpected', '', 'mystery', '', '## NEXT SESSION', '', '1. item', ''].join('\n');
  const sections = mdParse.splitDocumentIntoSections(doc, DURABLE);
  assertEq(sections.length, 2, 'unknown heading failed to act as a section boundary');
  assertEq(sections[1].type, 'next_session', 'section after an unknown heading was mis-scoped');
});

// ─── H-6: duplicate session N / subject collisions ──────────────────────

run('H6-1', 'duplicate session heading: both blocks parsed, neither silently dropped', () => {
  const doc = [
    '## Session 1 — 2026-01-01 — First',
    'body a',
    '## Session 1 — 2026-01-01 — First',
    'body b',
  ].join('\n');
  const sections = mdParse.splitDocumentIntoSections(doc, DURABLE);
  assertEq(sections.length, 2, 'duplicate session heading did not produce two distinct sections');
  assertEq(sections[0].headingLine, sections[1].headingLine, 'sanity: headings should be textually identical for this fixture');
});

// ─── H-8: fenced-code / blockquote / HTML-comment awareness ─────────────

run('H8-1', 'fake heading inside a fenced code block is not a real section', () => {
  const doc = ['```', '## Session 99 — fake — fake', '```', '', '## NEXT SESSION', '', '1. real item', ''].join('\n');
  const sections = mdParse.splitDocumentIntoSections(doc, DURABLE);
  assertEq(sections.length, 1, 'fenced fake heading was incorrectly treated as a real section');
  assertEq(sections[0].type, 'next_session', 'the one real section was misclassified');
});

run('H8-2', 'fake heading inside a blockquote is not a real section', () => {
  const doc = ['> ## Session 98 — fake — fake', '', '## NEXT SESSION', '', '1. real item', ''].join('\n');
  const sections = mdParse.splitDocumentIntoSections(doc, DURABLE);
  assertEq(sections.length, 1, 'blockquoted fake heading was incorrectly treated as a real section');
});

run('H8-3', 'fake heading inside an HTML comment (single-line) is not a real section', () => {
  const doc = ['<!-- ## Session 97 — fake — fake -->', '', '## NEXT SESSION', '', '1. real item', ''].join('\n');
  const sections = mdParse.splitDocumentIntoSections(doc, DURABLE);
  assertEq(sections.length, 1, 'single-line HTML-commented fake heading was incorrectly treated as a real section');
});

run('H8-4', 'fake heading inside a MULTI-LINE HTML comment is not a real section', () => {
  const doc = ['<!--', '## Session 96 — fake — fake', 'more comment text', '-->', '', '## NEXT SESSION', '', '1. real item', ''].join('\n');
  const sections = mdParse.splitDocumentIntoSections(doc, DURABLE);
  assertEq(sections.length, 1, 'multi-line HTML-commented fake heading was incorrectly treated as a real section');
});

run('H8-5', 'a REAL heading immediately after a closed fence is still detected', () => {
  const doc = ['```', 'code', '```', '## NEXT SESSION', '', '1. item', ''].join('\n');
  const sections = mdParse.splitDocumentIntoSections(doc, DURABLE);
  assertEq(sections.length, 1, 'a real heading right after a closed fence was missed');
  assertEq(sections[0].type, 'next_session', 'misclassified');
});

// ─── H-9: markdown-table cell parsing (inverse of renderCarryoverTable) ─

run('H9-1', 'splitOnUnescapedPipe: escaped pipe stays inside the cell, unescaped pipe delimits', () => {
  const cells = mdParse.splitOnUnescapedPipe('a\\|b|c');
  assertEq(cells.length, 2, 'escaped pipe was incorrectly treated as a delimiter');
  assertEq(cells[0], 'a\\|b', 'escaped-pipe segment corrupted');
  assertEq(cells[1], 'c', 'second segment corrupted');
});

run('H9-2', 'unescapeTableCell inverts renderCarryoverTable escaping exactly (backslash then pipe)', () => {
  // Original raw content: a\b|c  (one backslash, one pipe).
  // escape() produces:    a\\b\|c  (backslash doubled first, then pipe escaped).
  const escaped = 'a\\\\b\\|c';
  assertEq(mdParse.unescapeTableCell(escaped), 'a\\b|c', 'round-trip through unescapeTableCell did not invert escape() exactly');
});

run('H9-3', 'parseTableRow: pipes-in-cells round-trip through a full table row', () => {
  const row = '| pipes\\|in\\|cells | value with \\\\ backslash |';
  const parsed = mdParse.parseTableRow(row, 2);
  assert(parsed.ok, 'well-formed escaped row was flagged as an error');
  assertEq(parsed.cells[0], 'pipes|in|cells', 'pipe-in-cell did not round-trip');
  assertEq(parsed.cells[1], 'value with \\ backslash', 'backslash-in-cell did not round-trip');
});

run('H9-4', 'parseTableRow: wrong cell count is a flagged branch, never an index-shifted guess', () => {
  const parsed = mdParse.parseTableRow('| only one cell |', 2);
  assertEq(parsed.ok, false, 'wrong-cell-count row was not flagged');
  assertEq(parsed.actualCellCount, 1, 'actual cell count reported incorrectly');
});

run('H9-5', 'parseTableRow: extra cells are also flagged, never truncated', () => {
  const parsed = mdParse.parseTableRow('| a | b | c |', 2);
  assertEq(parsed.ok, false, 'extra-cell row was not flagged');
  assertEq(parsed.actualCellCount, 3, 'actual cell count reported incorrectly');
});

run('H9-6', 'hand-typed table without bounding pipes still parses correctly', () => {
  const parsed = mdParse.parseTableRow('subject text | detail text', 2);
  assert(parsed.ok, 'unbounded hand-typed row failed to parse');
  assertEq(parsed.cells[0], 'subject text', 'cell 0 mismatch');
  assertEq(parsed.cells[1], 'detail text', 'cell 1 mismatch');
});

run('H9-7', 'findOpenCarryoverTables: full section round-trip, including the flagged branch', () => {
  const body = [
    '',
    '### Open carry-overs',
    '',
    '| Subject | Detail |',
    '|---|---|',
    '| ALPHA-THREAD: something | do the alpha thing |',
    '| broken row only one cell |',
    '',
  ].join('\n');
  const tables = mdParse.findOpenCarryoverTables(body, 1);
  assertEq(tables.length, 1, 'expected exactly one Open carry-overs table');
  assertEq(tables[0].rows.length, 1, 'expected exactly one well-formed row');
  assertEq(tables[0].rows[0].subjectRaw, 'ALPHA-THREAD: something', 'subject cell mismatch');
  assertEq(tables[0].flaggedRows.length, 1, 'expected exactly one flagged row');
});

run('H9-8', 'findOpenCarryoverTables: renderer empty-state placeholder is zero rows, not an error', () => {
  const body = ['', '### Open carry-overs', '', '_(no open carry-overs)_', ''].join('\n');
  const tables = mdParse.findOpenCarryoverTables(body, 1);
  assertEq(tables.length, 1, 'expected one table entry for the heading');
  assertEq(tables[0].rows.length, 0, 'empty-state placeholder should yield zero rows');
  assertEq(tables[0].flaggedRows.length, 0, 'empty-state placeholder should not be flagged');
});

run('H9-9', 'fake "### Open carry-overs" heading inside a fence is not extracted', () => {
  const body = ['```', '### Open carry-overs', '| a | b |', '```', ''].join('\n');
  const tables = mdParse.findOpenCarryoverTables(body, 1);
  assertEq(tables.length, 0, 'fenced fake Open carry-overs heading was incorrectly extracted');
});

// ── Independent-review fix (PR #172 blocker 1): header detection must be
// structural (line-1-followed-by-a-separator), never positional
// ("line 1 is always the header"). Reviewer-reproduced regression: a
// headerless 2-row table previously lost its first row silently.

run('H9-10', 'headerless 2-row table: BOTH rows parsed, none silently lost', () => {
  const body = [
    '',
    '### Open carry-overs',
    '',
    '| EXAMPLE-THREAD-ALPHA: something | do the alpha thing |',
    '| EXAMPLE-THREAD-BETA: other | do the beta thing |',
    '',
  ].join('\n');
  const tables = mdParse.findOpenCarryoverTables(body, 1);
  assertEq(tables.length, 1, 'expected exactly one Open carry-overs table');
  assertEq(tables[0].rows.length, 2, 'headerless table must parse BOTH data rows, not lose the first to an assumed header');
  assertEq(tables[0].rows[0].subjectRaw, 'EXAMPLE-THREAD-ALPHA: something', 'first row was incorrectly consumed as a header');
  assertEq(tables[0].rows[1].subjectRaw, 'EXAMPLE-THREAD-BETA: other', 'second row mismatch');
  assertEq(tables[0].flaggedRows.length, 0, 'no rows should be flagged for a well-formed headerless table');
});

run('H9-11', 'headered table (header + separator present): header row itself is skipped, only data rows parsed', () => {
  const body = [
    '',
    '### Open carry-overs',
    '',
    '| Subject | Detail |',
    '|---|---|',
    '| EXAMPLE-THREAD-ALPHA: something | do the alpha thing |',
    '',
  ].join('\n');
  const tables = mdParse.findOpenCarryoverTables(body, 1);
  assertEq(tables.length, 1, 'expected exactly one Open carry-overs table');
  assertEq(tables[0].rows.length, 1, 'expected exactly one data row (header row must not be parsed as data)');
  assertEq(tables[0].rows[0].subjectRaw, 'EXAMPLE-THREAD-ALPHA: something', 'data row mismatch');
  assert(!tables[0].rows.some((r) => r.subjectRaw === 'Subject'), 'the literal header row leaked through as a data row');
});

run('H9-12', 'header-only table (header + separator, zero data rows): zero rows, but flagged — never silently indistinguishable from a genuinely empty table', () => {
  const body = [
    '',
    '### Open carry-overs',
    '',
    '| Subject | Detail |',
    '|---|---|',
    '',
  ].join('\n');
  const tables = mdParse.findOpenCarryoverTables(body, 1);
  assertEq(tables.length, 1, 'expected exactly one Open carry-overs table');
  assertEq(tables[0].rows.length, 0, 'header-only table should yield zero data rows');
  assertEq(tables[0].flaggedRows.length, 1, 'header-only table must be flagged, not silently treated as a clean empty table');
  assert(/header-only/i.test(tables[0].flaggedRows[0].reason), 'flag reason should identify the header-only condition');
});

// ─── H-11: NEXT SESSION list-item parsing ────────────────────────────────

run('H11-1', 'numbered items with checkbox decoration stripped', () => {
  const body = ['1. [ ] Fix the widget parser', '2. [x] Ship the doc update', ''].join('\n');
  const items = mdParse.parseNextSessionItems(body);
  assertEq(items.length, 2, 'wrong item count');
  assertEq(items[0], 'Fix the widget parser', 'checkbox decoration was not stripped');
  assertEq(items[1], 'Ship the doc update', 'checkbox decoration was not stripped');
});

run('H11-2', 'continuation lines and nested sub-bullets fold into the parent item', () => {
  const body = [
    '1. Fix the widget parser',
    '   continuation detail about the widget',
    '   - nested sub bullet about widget',
    '2. Ship the doc update',
    '',
  ].join('\n');
  const items = mdParse.parseNextSessionItems(body);
  assertEq(items.length, 2, 'nested content was wrongly counted as its own item');
  assert(items[0].includes('continuation detail about the widget'), 'continuation line was dropped');
  assert(items[0].includes('nested sub bullet about widget'), 'nested sub-bullet was dropped');
  assertEq(items[1], 'Ship the doc update', 'second item corrupted by folding');
});

run('H11-3', 'bullet-marker items (-, *, +) all recognized as outermost items', () => {
  const body = ['- item one', '* item two', '+ item three', ''].join('\n');
  const items = mdParse.parseNextSessionItems(body);
  assertEq(items.length, 3, 'not all bullet marker styles were recognized');
});

run('H11-4', 'empty-state placeholder yields zero items', () => {
  const items = mdParse.parseNextSessionItems('_(no queued next steps)_\n');
  assertEq(items.length, 0, 'empty-state placeholder should yield zero items');
});

// ─── H-12: body-length-delta (merged-block) heuristic ────────────────────

run('H12-1', 'a single session block never triggers the heuristic (no siblings to compare)', () => {
  const flags = mdParse.computeBodyLengthDeltaFlags([{ headingLineNo: 1, rawLineSpan: 500 }]);
  assertEq(flags.length, 0, 'lone block should never be flagged (nothing to compare against)');
});

run('H12-2', 'an anomalously large block (simulated merge) is flagged relative to its siblings', () => {
  const blocks = [
    { headingLineNo: 1, rawLineSpan: 10 },
    { headingLineNo: 2, rawLineSpan: 12 },
    { headingLineNo: 3, rawLineSpan: 11 },
    { headingLineNo: 4, rawLineSpan: 60 }, // simulated: two blocks merged into one
  ];
  const flags = mdParse.computeBodyLengthDeltaFlags(blocks);
  assertEq(flags.length, 1, 'expected exactly one flagged (merged) block');
  assertEq(flags[0].headingLineNo, 4, 'wrong block flagged');
});

run('H12-3', 'an anomalously small block is also flagged (<0.5x median)', () => {
  const blocks = [
    { headingLineNo: 1, rawLineSpan: 40 },
    { headingLineNo: 2, rawLineSpan: 42 },
    { headingLineNo: 3, rawLineSpan: 38 },
    { headingLineNo: 4, rawLineSpan: 5 },
  ];
  const flags = mdParse.computeBodyLengthDeltaFlags(blocks);
  assertEq(flags.length, 1, 'expected exactly one flagged (anomalously small) block');
  assertEq(flags[0].headingLineNo, 4, 'wrong block flagged');
});

console.log(`\nResults: ${passed} passed, ${failed} failed`);
process.exitCode = failed > 0 ? 1 : 0;
