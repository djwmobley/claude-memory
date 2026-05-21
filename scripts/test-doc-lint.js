'use strict';

/**
 * test-doc-lint.js -- Static documentation lint: glossary cross-refs,
 * command references, and suppression_kind enum sync.
 *
 * Catches documentation drift before it reaches main. Three checks:
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
 * Usage:
 *   node scripts/test-doc-lint.js
 *
 * No Postgres, vLLM, or external deps required. Pure static analysis.
 * Exit 0 = all checks pass. Exit 1 = any check fails.
 */

const fs   = require('fs');
const path = require('path');

// -- Constants -----------------------------------------------------------------

const PROJECT_ROOT = path.join(__dirname, '..');
const SCRIPTS_DIR  = path.join(PROJECT_ROOT, 'scripts');
const DOCS_DIR     = path.join(PROJECT_ROOT, 'docs');
const COMMANDS_DIR = path.join(PROJECT_ROOT, 'commands', 'handoff');

const GLOSSARY_MD  = path.join(DOCS_DIR, 'glossary.md');
const HANDOFF_JS   = path.join(SCRIPTS_DIR, 'handoff.js');
const SCHEMA_SQL   = path.join(SCRIPTS_DIR, 'sql', 'handoff-core-schema.sql');

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

// -- Main ----------------------------------------------------------------------

async function main() {
  console.log('Running: test-doc-lint\n');
  testD1();
  testD2();
  testD3();
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
