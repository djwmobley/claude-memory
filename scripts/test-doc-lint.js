'use strict';

/**
 * test-doc-lint.js -- Static documentation lint: glossary cross-refs,
 * command references, suppression_kind enum sync, and MANIFEST index
 * integrity.
 *
 * Catches documentation drift before it reaches main. Four checks:
 *
 *   D1 -- Glossary cross-reference resolution: every bold term in a
 *        "See also:" line must resolve to a defined ### heading in
 *        docs/glossary.md (external cross-doc refs are explicitly
 *        skipped via the "in `...`" / "in docs/" suffix convention).
 *
 *   D2 -- Command-reference validity: /handoff:<name> slash-command
 *        references in docs must match commands/handoff/<name>.md;
 *        `node ... handoff.js <subcommand>` invocations in doc code spans
 *        must match the const subcommands = { ... } router in handoff.js.
 *
 *   D3 -- suppression_kind enum sync: the validKinds array in cmdPrune
 *        and the --suppression-kind enumeration bullet in the glossary
 *        must both equal the canonical set from the SQL schema CHECK
 *        constraint (currently: superseded, downvoted_terminal,
 *        downvoted_probation, retired, reality_reconciled).
 *
 *   D4 -- MANIFEST index integrity: every row inside the MANIFEST.md
 *        documentation-index table is exhaustively classified as exactly
 *        one of (1) the header row, (2) the separator row, or (3) a
 *        well-formed entry (first cell a single backtick-wrapped path) --
 *        any row that is none of those three FAILS the gate outright (c).
 *        This is a total invariant, not a heuristic: there is no allow-list
 *        of "path-like" extensions to fall through, so an unwrapped cell
 *        can never silently escape validation regardless of what it looks
 *        like. Well-formed entries are then checked so their path (a)
 *        exists on disk and (b) is not gitignored. MANIFEST.md is tracked
 *        and public; it documents shipped docs only, so a gitignored path
 *        in the index would advertise a file a cloner never receives.
 *
 * Usage:
 *   node scripts/test-doc-lint.js
 *
 * No Postgres, vLLM, or external deps required. Pure static analysis.
 * D4's gitignore check shells out to `git check-ignore`; every other
 * check is filesystem-only. Exit 0 = all checks pass. Exit 1 = any
 * check fails.
 */

const fs            = require('fs');
const path          = require('path');
const { spawnSync } = require('child_process');

// -- Constants -----------------------------------------------------------------

const PROJECT_ROOT = path.join(__dirname, '..');
const SCRIPTS_DIR  = path.join(PROJECT_ROOT, 'scripts');
const DOCS_DIR     = path.join(PROJECT_ROOT, 'docs');
const COMMANDS_DIR = path.join(PROJECT_ROOT, 'commands', 'handoff');

const GLOSSARY_MD  = path.join(DOCS_DIR, 'glossary.md');
const HANDOFF_JS   = path.join(SCRIPTS_DIR, 'handoff.js');
const SCHEMA_SQL   = path.join(SCRIPTS_DIR, 'sql', 'handoff-core-schema.sql');
const MANIFEST_MD  = path.join(PROJECT_ROOT, 'MANIFEST.md');

// -- Tracking ------------------------------------------------------------------

let passed  = 0;
let failed  = 0;
const failures = [];

function pass(label)         { console.log('PASS  ' + label); passed++; }
function fail(label, reason) { console.log('FAIL  ' + label + ': ' + reason); failures.push({ label, reason }); failed++; }

// -- File helpers --------------------------------------------------------------

function readFile(filePath) {
  return fs.readFileSync(filePath, 'utf8');
}

function collectMdFiles(dir) {
  const results = [];
  if (!fs.existsSync(dir)) return results;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue;
    if (entry.name.startsWith('.claude')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...collectMdFiles(full));
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      results.push(full);
    }
  }
  return results;
}

function collectAllDocFiles() {
  const seen = new Set();
  const result = [];
  function add(p) {
    if (!seen.has(p) && fs.existsSync(p)) { seen.add(p); result.push(p); }
  }
  for (const entry of fs.readdirSync(PROJECT_ROOT, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith('.md')) add(path.join(PROJECT_ROOT, entry.name));
  }
  for (const p of collectMdFiles(DOCS_DIR)) add(p);
  for (const p of collectMdFiles(COMMANDS_DIR)) add(p);
  return result;
}

// -- D1 -- Glossary cross-reference resolution ---------------------------------

function testD1() {
  const label = 'D1: glossary cross-refs -- every See-also bold term resolves to a defined ### heading';

  const src = readFile(GLOSSARY_MD);
  // Normalize line endings to LF so headings with CRLF are handled uniformly.
  const lines = src.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');

  // Build defined-terms set from all ### headings.
  // Use /^###\s+(.+)/ (no $ anchor) so trailing \r from CRLF files does not
  // prevent matching; trim() strips any remaining whitespace/CR.
  const definedTerms = new Set();
  for (const line of lines) {
    const m = line.match(/^###\s+(.+)/);
    if (m) definedTerms.add(m[1].trim().toLowerCase());
  }

  // Find every line containing "See also:" and extract bold spans.
  const boldRe = /\*\*(.+?)\*\*/g;
  const issues = [];

  for (const line of lines) {
    const seeAlsoIdx = line.indexOf('See also:');
    if (seeAlsoIdx === -1) continue;
    // Only scan bold spans that appear AFTER the "See also:" text, not in the
    // prose body that precedes it on the same line.
    const seeAlsoPart = line.slice(seeAlsoIdx + 'See also:'.length);
    let match;
    boldRe.lastIndex = 0;
    while ((match = boldRe.exec(seeAlsoPart)) !== null) {
      const term = match[1];
      const afterTerm = seeAlsoPart.slice(match.index + match[0].length).trimStart();
      // EXTERNAL-REF SKIP: if the text after the closing ** begins with
      // "in `" or "in docs/" it is an explicit cross-doc reference and is
      // not expected to resolve in the glossary.
      if (afterTerm.startsWith('in `') || afterTerm.startsWith('in docs/')) continue;
      const normalized = term.trim().toLowerCase();
      if (!definedTerms.has(normalized)) {
        issues.push("undefined glossary term reference: '" + term + "' (referenced in a See-also line, no matching ### heading)");
      }
    }
  }

  if (issues.length > 0) { fail(label, issues.join('\n  ')); return; }
  pass(label);
}

// -- D2 -- Command-reference validity ------------------------------------------

function testD2() {
  const label = 'D2: command-reference validity -- /handoff:<name> and handoff.js <sub> refs match real commands';

  // Build the slash-command set from commands/handoff/*.md (excluding README.md).
  const slashCommandSet = new Set();
  if (fs.existsSync(COMMANDS_DIR)) {
    for (const entry of fs.readdirSync(COMMANDS_DIR, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith('.md') && entry.name !== 'README.md') {
        slashCommandSet.add(path.basename(entry.name, '.md'));
      }
    }
  }

  // Build the engine-subcommand set from the `const subcommands = { ... }` object
  // in handoff.js.
  const engineSubcmdSet = new Set();
  const handoffSrc = readFile(HANDOFF_JS);
  const handoffLines = handoffSrc.split('\n');

  let subcmdStart = -1;
  for (let i = 0; i < handoffLines.length; i++) {
    if (/const\s+subcommands\s*=\s*\{/.test(handoffLines[i])) { subcmdStart = i; break; }
  }

  if (subcmdStart === -1) {
    fail(label, 'could not locate "const subcommands = {" in scripts/handoff.js');
    return;
  }

  let depth = 0;
  let foundOpen = false;
  for (let i = subcmdStart; i < handoffLines.length; i++) {
    const line = handoffLines[i];
    for (const ch of line) {
      if (ch === '{') { depth++; foundOpen = true; }
      else if (ch === '}') { depth--; }
    }
    if (foundOpen && depth === 0) break;
    if (i > subcmdStart) {
      const keyMatch = line.match(/^\s*'?([\w-]+)'?\s*:/);
      if (keyMatch) engineSubcmdSet.add(keyMatch[1]);
    }
  }

  const docFiles = collectAllDocFiles();
  const issues = [];

  // Scan all docs for /handoff:<name> references (full text scan).
  const slashRefRe = /\/handoff:([a-z-]+)/g;
  for (const filePath of docFiles) {
    const content = readFile(filePath);
    let m;
    slashRefRe.lastIndex = 0;
    while ((m = slashRefRe.exec(content)) !== null) {
      const name = m[1];
      if (!slashCommandSet.has(name)) {
        const rel = path.relative(PROJECT_ROOT, filePath);
        issues.push('doc references nonexistent slash command /handoff:' + name + ' in ' + rel + ' (no commands/handoff/' + name + '.md)');
      }
    }
  }

  // Scan all docs for `node ... handoff.js <subcommand>` invocations.
  // Require "node" to precede handoff.js so we only catch real CLI invocations
  // and avoid false positives from prose like "handoff.js not found" or
  // line-ref citations like "handoff.js:964".
  // Scope to inline-code spans and fenced code blocks to avoid prose matches.
  const engineSubcmdRefRe = /node\s+(?:\S+\/)?handoff\.js\s+([a-z-]+)/g;

  for (const filePath of docFiles) {
    const content = readFile(filePath);
    const codeSpans = [];

    // Fenced blocks first; strip them so the inline scan cannot mis-pair
    // backticks against the ``` fences.
    const fencedRe = /```[^\n]*\n([\s\S]*?)```/g;
    let fencedMatch;
    while ((fencedMatch = fencedRe.exec(content)) !== null) codeSpans.push(fencedMatch[1]);
    const withoutFences = content.replace(fencedRe, '\n');

    // [^`\n]+ stops a stray unbalanced backtick from swallowing across lines
    // (the over-span false-negative).
    const inlineRe = /`([^`\n]+)`/g;
    let inlineMatch;
    while ((inlineMatch = inlineRe.exec(withoutFences)) !== null) codeSpans.push(inlineMatch[1]);

    for (const span of codeSpans) {
      let m;
      engineSubcmdRefRe.lastIndex = 0;
      while ((m = engineSubcmdRefRe.exec(span)) !== null) {
        const name = m[1];
        if (!engineSubcmdSet.has(name)) {
          const rel = path.relative(PROJECT_ROOT, filePath);
          issues.push("doc references nonexistent engine subcommand 'node ... handoff.js " + name + "' in " + rel + " (not in handoff.js subcommands router)");
        }
      }
    }
  }

  if (issues.length > 0) { fail(label, '\n  ' + issues.join('\n  ')); return; }
  console.log('  [D2] Slash-command set: ' + [...slashCommandSet].sort().join(', '));
  console.log('  [D2] Engine-subcommand set: ' + [...engineSubcmdSet].sort().join(', '));
  pass(label);
}

// -- D3 -- suppression_kind enum sync ------------------------------------------

function testD3() {
  const labelA = 'D3a: suppression_kind enum sync -- handoff.js validKinds matches SQL schema CHECK';
  const labelB = 'D3b: suppression_kind enum sync -- glossary Prune bullet matches SQL schema CHECK';

  // Parse canonical set from SQL schema: find ALL suppression_kind IN (...) occurrences
  // and take the largest (widest/most-current) set.
  const schemaSrc = readFile(SCHEMA_SQL);
  const inConstraintRe = /suppression_kind\s+IN\s*\(([^)]*)\)/gi;
  let canonicalSet = new Set();
  let m;
  while ((m = inConstraintRe.exec(schemaSrc)) !== null) {
    const tokens = m[1].match(/'([^']+)'/g) || [];
    const vals = tokens.map(function(t) { return t.slice(1, -1); });
    if (vals.length > canonicalSet.size) canonicalSet = new Set(vals);
  }

  if (canonicalSet.size === 0) {
    fail(labelA, 'could not parse any suppression_kind IN (...) from scripts/sql/handoff-core-schema.sql');
    fail(labelB, 'canonical set empty -- cannot verify glossary');
    return;
  }

  console.log('  [D3] Canonical suppression_kind set: ' + [...canonicalSet].join(', '));

  // Sub-check D3a: parse validKinds from handoff.js cmdPrune.
  const handoffSrc = readFile(HANDOFF_JS);
  const validKindsMatch = handoffSrc.match(/const\s+validKinds\s*=\s*\[([^\]]*)\]/);
  if (!validKindsMatch) {
    fail(labelA, 'could not find "const validKinds = [...]" in scripts/handoff.js');
  } else {
    const kindTokens = validKindsMatch[1].match(/'([^']+)'/g) || [];
    const parsedKinds = new Set(kindTokens.map(function(t) { return t.slice(1, -1); }));
    const missingFromCode = [...canonicalSet].filter(function(v) { return !parsedKinds.has(v); });
    const extraInCode     = [...parsedKinds].filter(function(v) { return !canonicalSet.has(v); });
    if (missingFromCode.length > 0 || extraInCode.length > 0) {
      const parts = [];
      if (missingFromCode.length) parts.push('missing from validKinds: ' + missingFromCode.join(', '));
      if (extraInCode.length)     parts.push('extra in validKinds (not in schema): ' + extraInCode.join(', '));
      fail(labelA, parts.join('; '));
    } else {
      pass(labelA);
    }
  }

  // Sub-check D3b: locate the --suppression-kind enumeration bullet in glossary.md.
  // Robust anchor: find the line that contains both "--suppression-kind" (in a code
  // span) and "suppression_kind" (in a code span), which is the bullet that enumerates
  // the valid kind values.  Use substring check rather than exact backtick match to
  // tolerate variations in the flag presentation (e.g. `--suppression-kind <kind>`).
  const glossarySrc = readFile(GLOSSARY_MD);
  const glossaryLines = glossarySrc.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  let anchorLine = null;
  for (const line of glossaryLines) {
    if (line.includes('--suppression-kind') && line.includes('`suppression_kind`')) {
      anchorLine = line;
      break;
    }
  }

  if (!anchorLine) {
    fail(labelB, 'glossary suppression_kind enumeration anchor not found -- check cannot verify; the Prune entry bullet structure changed');
    return;
  }

  // Extract all backtick-quoted tokens on the anchor line that are members
  // of the canonical universe.
  const btRe = /`([^`]+)`/g;
  const glossaryKinds = new Set();
  let btMatch;
  while ((btMatch = btRe.exec(anchorLine)) !== null) {
    const tok = btMatch[1];
    if (canonicalSet.has(tok)) glossaryKinds.add(tok);
  }

  const missingFromGlossary = [...canonicalSet].filter(function(v) { return !glossaryKinds.has(v); });
  const extraInGlossary     = [...glossaryKinds].filter(function(v) { return !canonicalSet.has(v); });
  if (missingFromGlossary.length > 0 || extraInGlossary.length > 0) {
    const parts = [];
    if (missingFromGlossary.length) parts.push('missing from glossary bullet: ' + missingFromGlossary.join(', '));
    if (extraInGlossary.length)     parts.push('extra in glossary bullet (not in schema): ' + extraInGlossary.join(', '));
    fail(labelB, parts.join('; '));
  } else {
    pass(labelB);
  }
}

// -- D4 -- MANIFEST index integrity ---------------------------------------------

const DOC_INDEX_HEADING_RE = /^##\s+Documentation index\s*$/;
const EXAMPLE_ENTRY_ROW    = '| `docs/example.md` | What it covers | current |';

// A pipe-delimited line: starts and ends with "|" once trimmed. This is the
// only structural test used to find the table's extent -- content
// (header/separator/entry) is classified afterward, never used to decide
// where the table starts or ends.
function isPipeLine(line) {
  const t = line.trim();
  return t.startsWith('|') && t.endsWith('|');
}

// Locate the documentation-index table's line range (0-based, inclusive) by
// anchoring on the "## Documentation index" heading, skipping any narrative
// prose between the heading and the table (MANIFEST.md has an explanatory
// paragraph there), and then taking the maximal contiguous run of
// pipe-delimited lines up to (but not past) the next heading. MANIFEST.md
// currently contains exactly one markdown table in the whole file (the
// index itself); anchoring on the heading rather than a fixed line number
// means prose is never mistaken for a row, and if a second, unrelated table
// were ever added elsewhere in the file it would not be pulled into this
// scan -- only the block between this heading and the next one is in scope.
function findDocIndexTableRange(lines) {
  const headingIdx = lines.findIndex(function(l) { return DOC_INDEX_HEADING_RE.test(l.trim()); });
  if (headingIdx === -1) {
    throw new Error('could not locate the "## Documentation index" heading in MANIFEST.md -- table scan has no anchor');
  }

  let start = -1;
  for (let i = headingIdx + 1; i < lines.length; i++) {
    if (isPipeLine(lines[i])) { start = i; break; }
    if (/^#+\s/.test(lines[i].trim())) break; // hit the next heading before finding a table
  }
  if (start === -1) {
    throw new Error('found "## Documentation index" heading at line ' + (headingIdx + 1) + ' but no table appears before the next heading (or end of file)');
  }

  let end = start;
  for (let i = start; i < lines.length; i++) {
    if (!isPipeLine(lines[i])) break;
    end = i;
  }

  return { start: start, end: end };
}

// Classify every row inside the documentation-index table's line range.
// This is a total invariant: every row is EXACTLY one of --
//   1. the header row (first table line; first cell literally "Path"),
//   2. the separator row (second table line; every cell matches the
//      markdown separator pattern, e.g. "---" or ":---:"), or
//   3. a valid entry (first cell is a single backtick-wrapped path).
// Anything else -- prose, an unwrapped path, a malformed header/separator --
// is collected into `malformed` and fails the gate. There is no
// extension/shape allow-list; unlike a "does this look like a path"
// heuristic, this cannot leave a silent hole for an unanticipated cell
// shape, because every row must resolve to one of the three cases or it
// is a failure by construction.
function parseManifestRows() {
  const src = readFile(MANIFEST_MD);
  const lines = src.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');

  const { start, end } = findDocIndexTableRange(lines);

  const rows = [];
  const malformed = [];

  for (let idx = start; idx <= end; idx++) {
    const line = lines[idx];
    const trimmed = line.trim();
    const cells = trimmed.slice(1, -1).split('|');
    const firstCell = (cells[0] || '').trim();
    const lineNo = idx + 1;

    if (idx === start) {
      if (firstCell !== 'Path') {
        malformed.push({ lineNo: lineNo, rawLine: line, reason: 'expected the table header row (first cell "Path") but found first cell ' + JSON.stringify(firstCell) });
      }
      continue;
    }

    if (idx === start + 1) {
      const allCellsAreSeparators = cells.every(function(c) { return /^:?-+:?$/.test(c.trim()); });
      if (!allCellsAreSeparators) {
        malformed.push({ lineNo: lineNo, rawLine: line, reason: 'expected the markdown table separator row (each cell matching /^:?-+:?$/) but found ' + JSON.stringify(trimmed) });
      }
      continue;
    }

    const backtickMatch = firstCell.match(/^`([^`]+)`$/);
    if (!backtickMatch) {
      malformed.push({ lineNo: lineNo, rawLine: line, reason: 'first cell is not a single backtick-wrapped path: ' + JSON.stringify(firstCell) });
      continue;
    }

    rows.push({ relPath: backtickMatch[1].trim(), lineNo: lineNo, rawLine: line });
  }

  return { rows, malformed };
}

// Batch every MANIFEST path through `git check-ignore` in as few invocations
// as practical (well within Windows/POSIX argv limits for this repo's index
// size, so one call). `git check-ignore` prints exactly the subset of the
// given paths that ARE ignored, one per line, regardless of exit code --
// exit 1 ("no path is ignored") is the all-clear case here, not an error;
// only an exit >= 2 (malformed invocation) is a real error.
function gitCheckIgnore(relPaths) {
  if (relPaths.length === 0) return new Set();
  const result = spawnSync('git', ['check-ignore', '--'].concat(relPaths), {
    cwd: PROJECT_ROOT,
    encoding: 'utf8',
  });
  if (result.error) {
    throw new Error('failed to invoke `git check-ignore`: ' + result.error.message);
  }
  if (result.status !== 0 && result.status !== 1) {
    throw new Error('`git check-ignore` exited ' + result.status + ' (expected 0 or 1): ' + (result.stderr || '').trim());
  }
  const ignored = new Set(
    (result.stdout || '')
      .replace(/\r\n/g, '\n')
      .split('\n')
      .map(function(l) { return l.trim(); })
      .filter(Boolean)
  );
  return ignored;
}

function testD4() {
  const labelA = 'D4a: MANIFEST index integrity -- every indexed path exists on disk';
  const labelB = 'D4b: MANIFEST index integrity -- every indexed path is not gitignored (shipped docs only)';
  const labelC = 'D4c: MANIFEST index integrity -- every table row is the header, the separator, or a well-formed entry';

  let rows, malformed;
  try {
    ({ rows, malformed } = parseManifestRows());
  } catch (err) {
    fail(labelC, err.message);
    fail(labelA, 'skipped -- table could not be parsed: ' + err.message);
    fail(labelB, 'skipped -- table could not be parsed: ' + err.message);
    return;
  }

  // Sub-check D4c: every row inside the documentation-index table must be
  // the header, the separator, or a well-formed backtick-wrapped entry --
  // exhaustive classification, not a "does this look like a path" guess.
  // Run before the rows.length===0 early-return so a table that is entirely
  // malformed still reports the real per-row problems instead of a generic
  // "no rows parsed".
  if (malformed.length > 0) {
    const issues = malformed.map(function(m) {
      return 'MANIFEST.md:' + m.lineNo + ': ' + m.reason + ' (row: ' + m.rawLine.trim() + ') -- a correct entry row looks like: ' + EXAMPLE_ENTRY_ROW;
    });
    fail(labelC, '\n  ' + issues.join('\n  '));
  } else {
    pass(labelC);
  }

  if (rows.length === 0) {
    fail(labelA, 'no index rows parsed from MANIFEST.md -- table format may have changed');
    fail(labelB, 'no index rows parsed from MANIFEST.md -- table format may have changed');
    return;
  }

  console.log('  [D4] Parsed ' + rows.length + ' MANIFEST index rows');

  // Sub-check D4a: every path exists on disk.
  const missing = [];
  for (const row of rows) {
    const abs = path.join(PROJECT_ROOT, row.relPath);
    if (!fs.existsSync(abs)) {
      missing.push('MANIFEST.md:' + row.lineNo + " references '" + row.relPath + "' which does not exist on disk (row: " + row.rawLine.trim() + ')');
    }
  }
  if (missing.length > 0) {
    fail(labelA, '\n  ' + missing.join('\n  '));
  } else {
    pass(labelA);
  }

  // Sub-check D4b: no path is gitignored. Only meaningful for paths that
  // exist -- a missing path is already flagged by D4a and checking ignore
  // status for something that isn't there adds no signal.
  const existingRows = rows.filter(function(row) { return fs.existsSync(path.join(PROJECT_ROOT, row.relPath)); });
  let ignoredSet;
  try {
    ignoredSet = gitCheckIgnore(existingRows.map(function(row) { return row.relPath; }));
  } catch (err) {
    fail(labelB, err.message);
    return;
  }

  const ignoredViolations = [];
  for (const row of existingRows) {
    if (ignoredSet.has(row.relPath)) {
      ignoredViolations.push('MANIFEST.md:' + row.lineNo + " references '" + row.relPath + "' which is gitignored -- a cloner of this public repo will never receive this file (row: " + row.rawLine.trim() + ')');
    }
  }
  if (ignoredViolations.length > 0) {
    fail(labelB, '\n  ' + ignoredViolations.join('\n  '));
  } else {
    pass(labelB);
  }
}

// -- Main ----------------------------------------------------------------------

async function main() {
  console.log('Running: test-doc-lint\n');
  testD1();
  testD2();
  testD3();
  testD4();
  console.log('');
  console.log('Results: ' + passed + ' passed, ' + failed + ' failed');
  if (failures.length > 0) {
    console.log('\nFailures:');
    for (const f of failures) {
      console.log('  FAIL  ' + f.label + ': ' + f.reason);
    }
  }
  console.log('');
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(function(err) {
  console.error('Uncaught error:', err);
  process.exit(1);
});
