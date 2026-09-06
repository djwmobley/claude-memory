'use strict';

/**
 * test-handoff-markdown-parse.js — pure unit tests for
 * scripts/lib/handoff-markdown-parse.js (CONSOLIDATION-RUNBOOK.md
 * §6.1(h) H-1..H-14 amendment, memory-manager#11(h), + cm#222's 2026-09-06
 * hardening pass — true dry-run wiring lives in the migrate-08 DB-
 * integration test; this file covers the pure parsing/classification
 * logic only). No DB, no fixture files on disk — every fixture is an
 * inline SYNTHETIC string literal (invented project/session names/content
 * only, per H-13's public-repo sanitization rule — never real pwa-etl
 * text, even though the shapes below were reverse-engineered from it).
 *
 * Covers every adversary construction named in cm#222's authoring brief
 * (F-1..F-9 in the spec-adversary findings) plus the pre-existing H-1..H-14
 * suite:
 *   - cm#222 A2/F-2/F-3: session-heading total classification — the "--"
 *     two-hyphen separator token (not a single-char class), em/en-dash,
 *     the date-first "SESSION <date> [(paren)]" shape (with a numeric
 *     parenthetical, a letter parenthetical, and no parenthetical at all),
 *     session_shaped_unparsed as ITS OWN bucket (never merged into
 *     `other`), a session title that itself contains the word "next"
 *     (must not be misclassified as a NEXT-SESSION variant).
 *   - cm#222 A3/F-1/F-6/F-7/F-8: header-driven carry-over tables — cell
 *     count from the header, column-name synonym mapping (case/whitespace
 *     insensitive), reordered columns, an extra unrecognized column
 *     folded into notes, a missing status column, a table with no
 *     identifiable item column (whole table flagged), a headerless table
 *     (no structural header+separator), a blank-line-split table
 *     producing `orphanRows` (never silently dropped), the structural
 *     header check composing with (not replaced by) name-matching.
 *   - cm#222 A4/F-4: status-cell total classification — closed/open/
 *     unknown, dual-signal -> unknown, emoji mapping.
 *   - cm#222 A5/F-5: NEXT SESSION canonical (with optional parenthetical
 *     suffix) vs. variant vs. absent.
 *   - H-8: fake headings inside fenced code, blockquotes, and HTML
 *     comments (single-line and multi-line) — none become real sections.
 *   - H-9: pipes-in-cells (escaped), backslash escaping.
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
  // U+2012 FIGURE DASH — not one of the three recognized dashes.
  const r = mdParse.normalizeMarkdown('## Session 1 ‒ 2026-01-01 ‒ Title\n');
  assert(r.flags.length >= 1, 'unrecognized dash was not flagged');
  assertEq(r.flags[0].type, 'unrecognized-dash', 'wrong flag type');
});

// ─── cm#222 A2/F-2: session_numbered — the widened separator TOKEN ──────

run('A2-1', 'session_numbered matches the "--" two-hyphen token (F-2: was previously unmatchable)', () => {
  const line = '## Session 100 -- 2026-07-22 (evening) -- Widget parser refactor complete';
  const c = mdParse.classifyHeading(line, DURABLE);
  assertEq(c.type, 'session_numbered', 'wrong classification type');
  assertEq(c.sessionNum, '100', 'session number mismatch');
  assertEq(c.date, '2026-07-22 (evening)', 'date group mismatch (non-greedy up to the NEXT sep token)');
  assertEq(c.title, 'Widget parser refactor complete', 'title mismatch');
});

run('A2-2', 'session_numbered matches em-dash and en-dash separators', () => {
  for (const dash of ['—', '–']) {
    const line = `## Session 7 ${dash} 2026-02-01 ${dash} Fixed the widget`;
    const c = mdParse.classifyHeading(line, DURABLE);
    assertEq(c.type, 'session_numbered', `dash "${dash}" did not classify as session_numbered`);
    assertEq(c.sessionNum, '7', 'session number mismatch');
    assertEq(c.title, 'Fixed the widget', 'title mismatch');
  }
});

run('A2-3', '4-way-split title resolves deterministically (non-greedy date, greedy title)', () => {
  const line = '## Session 3 — Part A — Fixed the widget — v2';
  const c = mdParse.classifyHeading(line, DURABLE);
  assertEq(c.type, 'session_numbered', 'wrong classification type');
  assertEq(c.date, 'Part A', 'date group should be the minimal non-greedy match up to the NEXT sep token');
  assertEq(c.title, 'Fixed the widget — v2', 'title group should greedily swallow all remaining separators');
});

// ─── cm#222 A2/F-3: session_dated — the date-first shape ────────────────

run('A2-4', 'session_dated: date immediately after keyword, numeric "(session N)" parenthetical', () => {
  const line = '## SESSION 2026-06-16 (session 18) -- Offline build complete on a feature branch';
  const c = mdParse.classifyHeading(line, DURABLE);
  assertEq(c.type, 'session_dated', 'wrong classification type');
  assertEq(c.date, '2026-06-16', 'date mismatch');
  assertEq(c.parenthetical, 'session 18', 'parenthetical mismatch');
  assertEq(c.title, 'Offline build complete on a feature branch', 'title mismatch');
});

run('A2-5', 'session_dated: letter same-day-suffix parenthetical', () => {
  const line = '## SESSION 2026-06-13 (c) -- inline target-identity pull built and verified';
  const c = mdParse.classifyHeading(line, DURABLE);
  assertEq(c.type, 'session_dated', 'wrong classification type');
  assertEq(c.parenthetical, 'c', 'letter parenthetical mismatch');
});

run('A2-6', 'session_dated: no parenthetical at all', () => {
  const line = '## SESSION 2026-06-12 -- deep-capture resiliency and cold-start settle';
  const c = mdParse.classifyHeading(line, DURABLE);
  assertEq(c.type, 'session_dated', 'wrong classification type');
  assert(c.parenthetical === null, 'parenthetical should be null when absent, not an empty string or undefined-crash');
});

run('A2-7', 'a date-first heading using mixed-case "Session" (not all-caps) still classifies as session_dated, never session_numbered', () => {
  // Real-world regression check: a bare `\d+` in the numbered regex would
  // otherwise happily (and wrongly) consume a date's leading "2026" as if
  // it were a session number. The dated shape must win.
  const line = '## Session 2026-06-17 (session 23) -- clone flow persisted to repo';
  const c = mdParse.classifyHeading(line, DURABLE);
  assertEq(c.type, 'session_dated', 'date-first heading with mixed-case keyword was misclassified as session_numbered');
});

// ─── cm#222 F-3: session_shaped_unparsed — its own bucket, never merged ─

run('A2-8', 'a heading starting with "session" that matches neither shape is session_shaped_unparsed, not "other"', () => {
  const line = '## Session — no number, no date, just a title';
  const c = mdParse.classifyHeading(line, DURABLE);
  assertEq(c.type, 'session_shaped_unparsed', 'session-shaped-but-unparsed heading was not distinguished from a harmless stray heading');
});

run('A2-9', 'a heading that mentions "session" but does not start with it is also session_shaped_unparsed', () => {
  const line = '## Recap of last session';
  const c = mdParse.classifyHeading(line, DURABLE);
  assertEq(c.type, 'session_shaped_unparsed', 'heading containing the word "session" elsewhere was not flagged as session-shaped');
});

run('A2-10', 'a session heading whose TITLE happens to contain the word "next" is still session_numbered, never a NEXT-SESSION variant', () => {
  // Real-world regression: "...is next" inside a session title must not
  // be mistaken for a NEXT-SESSION heading just because both keywords
  // ("next" and "session") appear somewhere in the line.
  const line = '## Session 100 -- 2026-07-22 -- root cause found; the fix is next';
  const c = mdParse.classifyHeading(line, DURABLE);
  assertEq(c.type, 'session_numbered', 'a session title containing "next" was misclassified as a NEXT-SESSION variant');
});

run('A2-11', 'total classification: every ## heading lands in exactly one bucket, all real', () => {
  const doc = [
    '## NEXT SESSION',
    '', '1. item', '',
    '## Session 1 — 2026-01-01 — Title',
    '', 'body', '',
    '## SESSION 2026-01-02 (b) -- date-first',
    '', 'body', '',
    '## Session with no number or date',
    '', 'stray', '',
    '## Run commands',
    '', 'npm test', '',
    '## Something Totally Unexpected',
    '', 'mystery', '',
  ].join('\n');
  const sections = mdParse.splitDocumentIntoSections(doc, DURABLE);
  const types = sections.map((s) => s.type);
  assertEq(
    types.join(','),
    'next_session,session_numbered,session_dated,session_shaped_unparsed,durable,other',
    'total classification did not produce the expected bucket sequence'
  );
});

run('A2-12', 'unknown ("other") heading still bounds sections (does not swallow neighboring content)', () => {
  const doc = ['## Something Unexpected', '', 'mystery', '', '## NEXT SESSION', '', '1. item', ''].join('\n');
  const sections = mdParse.splitDocumentIntoSections(doc, DURABLE);
  assertEq(sections.length, 2, 'other heading failed to act as a section boundary');
  assertEq(sections[1].type, 'next_session', 'section after an "other" heading was mis-scoped');
});

run('A2-13', 'detectSessionHeadingLevel reports "##" for an ordinary document', () => {
  const doc = ['## Session 1 — 2026-01-01 — Title', '', 'body', ''].join('\n');
  assertEq(mdParse.detectSessionHeadingLevel(doc), '##', 'wrong detected level');
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

// ─── cm#222 A5/F-5: NEXT SESSION canonical / variant / absent ───────────

run('A5-1', 'canonical NEXT SESSION heading classifies as next_session', () => {
  const c = mdParse.classifyHeading('## NEXT SESSION', DURABLE);
  assertEq(c.type, 'next_session', 'canonical heading misclassified');
});

run('A5-2', 'canonical NEXT SESSION heading with a trailing parenthetical suffix still classifies as next_session', () => {
  const c = mdParse.classifyHeading('## Next Session (carry-over)', DURABLE);
  assertEq(c.type, 'next_session', 'parenthetical-suffixed canonical heading was not recognized');
});

run('A5-3', 'a heading containing both "next" and "session" but not the canonical form is next_session_variant', () => {
  const c = mdParse.classifyHeading('## Next up: session wrap notes', DURABLE);
  assertEq(c.type, 'next_session_variant', 'non-canonical next+session heading was not flagged as a variant');
});

run('A5-4', 'absent: a document with neither a canonical nor a variant NEXT SESSION heading', () => {
  const doc = ['## Session 1 — 2026-01-01 — Title', '', 'body', ''].join('\n');
  const sections = mdParse.splitDocumentIntoSections(doc, DURABLE);
  assert(!sections.some((s) => s.type === 'next_session' || s.type === 'next_session_variant'), 'a non-existent NEXT SESSION heading was somehow found');
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

run('H8-6', 'a fake "### Open carry-overs" heading inside a fence, in an otherwise real section, is not extracted', () => {
  const body = ['```', '### Open carry-overs', '| Item | Status | Notes |', '|---|---|---|', '| a | Open | b |', '```', ''].join('\n');
  const tables = mdParse.findOpenCarryoverTables(body, 1);
  assertEq(tables.length, 0, 'fenced fake Open carry-overs heading was incorrectly extracted');
});

// ─── H-9: raw cell parsing primitives ────────────────────────────────────

run('H9-1', 'splitOnUnescapedPipe: escaped pipe stays inside the cell, unescaped pipe delimits', () => {
  const cells = mdParse.splitOnUnescapedPipe('a\\|b|c');
  assertEq(cells.length, 2, 'escaped pipe was incorrectly treated as a delimiter');
  assertEq(cells[0], 'a\\|b', 'escaped-pipe segment corrupted');
  assertEq(cells[1], 'c', 'second segment corrupted');
});

run('H9-2', 'unescapeTableCell inverts renderCarryoverTable escaping exactly (backslash then pipe)', () => {
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

run('H9-5', 'parseTableRowCells: no count assertion, used for header-row parsing', () => {
  const { cells, count } = mdParse.parseTableRowCells('| Item | Status | Notes |');
  assertEq(count, 3, 'wrong cell count');
  assertEq(cells.join(','), ' Item , Status , Notes ', 'cells should be raw (untrimmed) segments');
});

// ─── cm#222 A3/F-1/F-7: header-driven column-role mapping ───────────────

run('A3-1', 'resolveColumnRole: exact synonym matches, case/whitespace-insensitive', () => {
  assertEq(mdParse.resolveColumnRole('Item'), 'item', 'Item not resolved');
  assertEq(mdParse.resolveColumnRole('  status '), 'status', 'status not resolved with irregular whitespace');
  assertEq(mdParse.resolveColumnRole('NOTES'), 'notes', 'NOTES not resolved (case-insensitive)');
  assertEq(mdParse.resolveColumnRole('Thread'), 'item', 'synonym "Thread" not mapped to item role');
  assertEq(mdParse.resolveColumnRole('State'), 'status', 'synonym "State" not mapped to status role');
  assertEq(mdParse.resolveColumnRole('Detail'), 'notes', 'synonym "Detail" not mapped to notes role');
  assertEq(mdParse.resolveColumnRole('Owner'), null, 'unrecognized column name should resolve to null (extra), not a guessed role');
});

run('A3-2', 'buildColumnMap: reordered columns are mapped by name, not position', () => {
  const columns = mdParse.buildColumnMap([' Status ', ' Item ', ' Notes ']);
  assertEq(columns.itemIdx, 1, 'item role should be at index 1 (reordered)');
  assertEq(columns.statusIdx, 0, 'status role should be at index 0 (reordered)');
  assertEq(columns.notesIdxs.join(','), '2', 'notes role should be at index 2');
});

// ─── cm#222 A3/F-1: real-shape 3-column header-driven table ─────────────

run('A3-3', 'F-1: a 3-column (Item/Status/Notes) table — the real-world shape — parses fully, none flagged', () => {
  const body = [
    '',
    '### Open carry-overs',
    '',
    '| Item | Status | Notes |',
    '|------|--------|-------|',
    '| Widget parser refactor | Open | needs a follow-up probe |',
    '| Doc update | DONE -- merged | shipped same day |',
    '',
  ].join('\n');
  const tables = mdParse.findOpenCarryoverTables(body, 1);
  assertEq(tables.length, 1, 'expected exactly one table');
  assertEq(tables[0].rows.length, 2, 'both 3-column rows should parse (this is the F-1 regression: a hardcoded 2-cell assumption failed on every real row)');
  assertEq(tables[0].flaggedRows.length, 0, 'well-formed 3-column rows should not be flagged');
  assertEq(tables[0].rows[0].itemRaw, 'Widget parser refactor', 'item cell mismatch');
  assertEq(tables[0].rows[0].statusClass, 'open', 'status classification mismatch for row 0');
  assertEq(tables[0].rows[1].statusClass, 'closed', 'status classification mismatch for row 1');
});

run('A3-4', 'F-7: extra unrecognized column is folded into notes as name=value, never dropped', () => {
  const body = [
    '',
    '### Open carry-overs',
    '',
    '| Item | Status | Notes | Owner |',
    '|---|---|---|---|',
    '| Widget parser | Open | needs review | Jordan |',
    '',
  ].join('\n');
  const tables = mdParse.findOpenCarryoverTables(body, 1);
  assertEq(tables[0].rows.length, 1, 'expected one row');
  assert(tables[0].rows[0].notesRaw.includes('needs review'), 'original notes text lost');
  assert(tables[0].rows[0].notesRaw.includes('Owner=Jordan'), 'extra column was not folded into notes as name=value');
});

run('A3-5', 'F-7: a missing status column yields status "unknown" for every row', () => {
  const body = [
    '',
    '### Open carry-overs',
    '',
    '| Item | Notes |',
    '|---|---|',
    '| Widget parser | needs review |',
    '',
  ].join('\n');
  const tables = mdParse.findOpenCarryoverTables(body, 1);
  assertEq(tables[0].rows[0].statusClass, 'unknown', 'missing status column should yield status=unknown, never a guess');
  assertEq(tables[0].rows[0].statusRaw, '', 'statusRaw should be empty when there is no status column at all');
});

run('A3-6', 'F-7: a header with no identifiable item column flags the WHOLE table, never guessed by position', () => {
  const body = [
    '',
    '### Open carry-overs',
    '',
    '| Status | Notes |',
    '|---|---|',
    '| Open | something |',
    '',
  ].join('\n');
  const tables = mdParse.findOpenCarryoverTables(body, 1);
  assertEq(tables[0].rows.length, 0, 'no rows should be parsed when the item column cannot be identified');
  assertEq(tables[0].flaggedRows.length, 1, 'the data row should be flagged, not silently dropped');
  assert(/no item\/subject column/i.test(tables[0].flaggedRows[0].reason), 'flag reason should name the missing item column');
});

run('A3-7', 'headerless table: column 0 is always item, status is unknown, other columns fold into notes (documented fallback, never a positional guess at status/notes)', () => {
  const body = [
    '',
    '### Open carry-overs',
    '',
    '| EXAMPLE-THREAD-ALPHA: something | do the alpha thing |',
    '| EXAMPLE-THREAD-BETA: other | do the beta thing |',
    '',
  ].join('\n');
  const tables = mdParse.findOpenCarryoverTables(body, 1);
  assertEq(tables[0].rows.length, 2, 'both headerless rows should parse');
  assertEq(tables[0].rows[0].itemRaw, 'EXAMPLE-THREAD-ALPHA: something', 'first row item mismatch');
  assertEq(tables[0].rows[0].statusClass, 'unknown', 'headerless table should never guess a status class');
  assert(tables[0].rows[0].notesRaw.includes('do the alpha thing'), 'headerless second column should fold into notes');
});

run('A3-8', 'F-8: structural header check composes with name-matching — a headerless table whose first row LOOKS like a header is still data', () => {
  const body = [
    '',
    '### Open carry-overs',
    '',
    '| Item | Status | Notes |',
    '| Widget parser | Open | first real row, no separator present |',
    '',
  ].join('\n');
  const tables = mdParse.findOpenCarryoverTables(body, 1);
  assertEq(tables[0].rows.length, 2, 'without a separator row, BOTH lines are data — the literal header-shaped line must not be consumed as a header');
  assertEq(tables[0].rows[0].itemRaw, 'Item', 'the header-shaped line should parse as ordinary (headerless) data, not be swallowed as a header');
});

run('A3-9', 'F-6: a table split by a stray blank line reports the trailing pipe-shaped lines as orphanRows, never silently drops them', () => {
  const body = [
    '',
    '### Open carry-overs',
    '',
    '| Item | Status | Notes |',
    '|---|---|---|',
    '| Widget parser | Open | first row |',
    '',
    '| Doc update | DONE | second row, orphaned by the stray blank line above |',
    '',
    '## Next heading',
  ].join('\n');
  const tables = mdParse.findOpenCarryoverTables(body, 1);
  assertEq(tables[0].rows.length, 1, 'only the row before the blank line should be a normal row');
  assertEq(tables[0].orphanRows.length, 1, 'the pipe-shaped line after the blank line should be reported as an orphan row, not silently dropped');
  assert(tables[0].orphanRows[0].raw.includes('Doc update'), 'orphan row content mismatch');
});

run('A3-10', 'multiple "### Open carry-overs" headings in one body are all parsed independently', () => {
  const body = [
    '### Open carry-overs',
    '',
    '| Item | Status | Notes |',
    '|---|---|---|',
    '| First table row | Open | a |',
    '',
    '### Something else',
    '',
    '### Open carry-overs',
    '',
    '| Item | Status | Notes |',
    '|---|---|---|',
    '| Second table row | Open | b |',
    '',
  ].join('\n');
  const tables = mdParse.findOpenCarryoverTables(body, 1);
  assertEq(tables.length, 2, 'expected two independently-parsed tables');
  assertEq(tables[0].rows[0].itemRaw, 'First table row', 'first table mismatch');
  assertEq(tables[1].rows[0].itemRaw, 'Second table row', 'second table mismatch');
});

run('A3-11', 'escaped pipe inside a cell does not split the row (F-9 carried forward into the header-driven rewrite)', () => {
  const body = [
    '',
    '### Open carry-overs',
    '',
    '| Item | Status | Notes |',
    '|---|---|---|',
    '| pipes\\|in\\|item | Open | pipes\\|in\\|notes |',
    '',
  ].join('\n');
  const tables = mdParse.findOpenCarryoverTables(body, 1);
  assertEq(tables[0].rows.length, 1, 'escaped-pipe row should parse as exactly one well-formed row');
  assertEq(tables[0].rows[0].itemRaw, 'pipes|in|item', 'escaped pipe in item cell did not round-trip');
});

run('A3-12', 'renderer empty-state placeholder is zero rows, not an error', () => {
  const body = ['', '### Open carry-overs', '', '_(no open carry-overs)_', ''].join('\n');
  const tables = mdParse.findOpenCarryoverTables(body, 1);
  assertEq(tables.length, 1, 'expected one table entry for the heading');
  assertEq(tables[0].rows.length, 0, 'empty-state placeholder should yield zero rows');
  assertEq(tables[0].flaggedRows.length, 0, 'empty-state placeholder should not be flagged');
});

run('A3-13', 'header-only table (header + separator, zero data rows) is flagged, never silently indistinguishable from empty', () => {
  const body = ['', '### Open carry-overs', '', '| Item | Status | Notes |', '|---|---|---|', ''].join('\n');
  const tables = mdParse.findOpenCarryoverTables(body, 1);
  assertEq(tables[0].rows.length, 0, 'header-only table should yield zero data rows');
  assertEq(tables[0].flaggedRows.length, 1, 'header-only table must be flagged');
  assert(/header-only/i.test(tables[0].flaggedRows[0].reason), 'flag reason should identify the header-only condition');
});

run('A3-14', 'a separator row whose cell count does not match the header is treated as NOT a valid separator (falls back to headerless: every line, including the mismatched separator-shaped line itself, becomes plain data)', () => {
  const body = [
    '',
    '### Open carry-overs',
    '',
    '| Item | Status | Notes |',
    '|---|---|',
    '| a | b | c |',
    '',
  ].join('\n');
  const tables = mdParse.findOpenCarryoverTables(body, 1);
  // Mismatched separator -> headerless path -> EVERY line from here is
  // ordinary data (never guessed to be a header or skipped), including
  // the separator-shaped line itself.
  assertEq(tables[0].rows.length, 3, 'all three lines should be treated as headerless data when the separator cell count does not match the header');
  assertEq(tables[0].rows[0].itemRaw, 'Item', 'the header-shaped line should parse as ordinary headerless data');
});

// ─── cm#222 A4/F-4: status-cell total classification ────────────────────

run('A4-1', 'classifyStatusCell: closed keywords', () => {
  for (const text of ['DONE', 'PR merged', 'shipped to prod', 'SOLVED + SHIPPED', 'issue RESOLVED', 'work complete', 'task completed', 'bug FIXED']) {
    const c = mdParse.classifyStatusCell(text);
    assertEq(c.class, 'closed', `expected closed for "${text}"`);
  }
});

run('A4-2', 'classifyStatusCell: open keywords', () => {
  for (const text of ['Open', 'Not run', 'Not built -- HIGH', 'Owner-gated, unexercised', 'Pending', 'Blocked', 'TODO', 'Deferred', 'still unproven']) {
    const c = mdParse.classifyStatusCell(text);
    assertEq(c.class, 'open', `expected open for "${text}"`);
  }
});

run('A4-3', 'classifyStatusCell: unknown for free-text narrative matching neither list', () => {
  for (const text of ['Adopted this session', 'Upstream refinement candidate', '', '   ']) {
    const c = mdParse.classifyStatusCell(text);
    assertEq(c.class, 'unknown', `expected unknown for "${JSON.stringify(text)}"`);
  }
});

run('A4-4', 'classifyStatusCell: dual-signal (both an open and a closed keyword) is unknown, never a tiebreak guess', () => {
  const c = mdParse.classifyStatusCell('PR merged (AD preflight); real-account probe still unproven');
  assertEq(c.class, 'unknown', 'dual-signal cell should classify as unknown');
  assert(c.dualSignal === true, 'dualSignal flag should be set');
  assert(c.matchedClosed.length > 0 && c.matchedOpen.length > 0, 'both matched-keyword lists should be non-empty');
});

run('A4-5', 'classifyStatusCell: word-boundary matching avoids false positives inside longer words', () => {
  // "undone" must not trip the "DONE" keyword; "reopened" must not trip "OPEN".
  const c1 = mdParse.classifyStatusCell('the fix is undone for now');
  assertEq(c1.class, 'unknown', '"undone" should not match the DONE keyword');
  const c2 = mdParse.classifyStatusCell('ticket reopened by QA');
  assertEq(c2.class, 'unknown', '"reopened" should not match the OPEN keyword');
});

run('A4-6', 'classifyStatusCell: emoji mapping (cm#222 own decision, documented)', () => {
  assertEq(mdParse.classifyStatusCell('✅ done deploying').class, 'closed', 'check-mark emoji should map to closed');
  assertEq(mdParse.classifyStatusCell('⏳ waiting on owner').class, 'open', 'hourglass emoji should map to open');
  assertEq(mdParse.classifyStatusCell('❌ blocked, no ETA').class, 'open', 'cross-mark emoji should map to open');
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
    { headingLineNo: 4, rawLineSpan: 60 },
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

// ─── canonicalizeWhitespace: the single normalization engine ────────────

run('NORM-1', 'canonicalizeWhitespace trims and collapses internal whitespace without altering case', () => {
  assertEq(mdParse.canonicalizeWhitespace('  Run   commands  '), 'Run commands', 'whitespace not collapsed/trimmed correctly');
});

run('NORM-2', 'durable-heading matching uses canonicalizeWhitespace, tolerating irregular internal whitespace', () => {
  const c = mdParse.classifyHeading('##   Run    commands  ', DURABLE);
  assertEq(c.type, 'durable', 'durable heading with irregular internal whitespace was not matched');
});

console.log(`\nResults: ${passed} passed, ${failed} failed`);
process.exitCode = failed > 0 ? 1 : 0;
