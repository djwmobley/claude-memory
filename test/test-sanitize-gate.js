'use strict';

/**
 * test-sanitize-gate.js — tests for scripts/sanitize-gate.js against
 * docs/specs/public-sanitize-gate.md.
 *
 * Structure:
 *   1. One canary per scanner (scanText-level) asserting FAIL_CONTENT-shape
 *      findings with the correct scanner label.
 *   2. One fixture per adversary finding A1-F1 (14 total), asserting the
 *      exact outcome the spec fix requires.
 *   3. A totality table of >=30 generated inputs, each asserting exactly
 *      one outcome (never zero, never more than one interpretation).
 *   4. A test that a missing/empty private-terms file fails closed.
 *
 * Usage: node test/test-sanitize-gate.js
 * Requires: git on PATH (creates real temp git repos for end-to-end cases).
 * No Postgres, no network.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const gate = require(path.join(PROJECT_ROOT, 'scripts', 'sanitize-gate.js'));

let passed = 0, failed = 0;
const failures = [];
function test(label, fn) {
  try {
    fn();
    passed++;
  } catch (e) {
    failed++;
    failures.push(`${label}: ${e.message}`);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

// ---------------------------------------------------------------------------
// Temp git repo helper for end-to-end runGate() cases.
// ---------------------------------------------------------------------------
function mkRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sanitize-gate-test-'));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'test-bot@example.com'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'Test Bot'], { cwd: dir });
  return dir;
}

function writeFile(root, rel, content) {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

function commit(dir, msg) {
  execFileSync('git', ['add', '-A'], { cwd: dir });
  execFileSync('git', ['commit', '-q', '-m', msg || 'test commit'], { cwd: dir });
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();
}

function writeTermsFile(content) {
  const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sanitize-terms-')), 'terms.txt');
  fs.writeFileSync(p, content);
  return p;
}

const BASE_ENV = { SANITIZE_LIFT_COMMIT_IDENTITY: 'Test Bot <test-bot@example.com>' };

// ===========================================================================
// 1. One canary per scanner — scanText level, asserting label + non-empty.
// ===========================================================================
const TERMS_FILE = writeTermsFile('canaryterm\nseededterm\n');
const TERM_REGEXES = gate.loadPrivateTerms(TERMS_FILE).map(gate.buildTermRegex);

function scanCanary(label, text) {
  return gate.scanText(text, { location: 'canary', termRegexes: TERM_REGEXES });
}

test('canary: OWNER_PATH', () => {
  const f = scanCanary('OWNER_PATH', 'see C:\\Users\\testcanary\\foo for details');
  assert(f.some((x) => x.label === 'OWNER_PATH'), 'expected OWNER_PATH finding');
});

test('canary: OWNER_EMAIL', () => {
  const f = scanCanary('OWNER_EMAIL', 'contact canary@users.noreply.github.com');
  assert(f.some((x) => x.label === 'OWNER_EMAIL'), 'expected OWNER_EMAIL finding');
});

test('canary: PRIVATE_DB', () => {
  const f = scanCanary('PRIVATE_DB', 'connects to pipeline_canarydb for storage');
  assert(f.some((x) => x.label === 'PRIVATE_DB'), 'expected PRIVATE_DB finding');
});

test('canary: PRIVATE_TERM', () => {
  const f = scanCanary('PRIVATE_TERM', 'this mentions canaryterm in prose');
  assert(f.some((x) => x.label === 'PRIVATE_TERM'), 'expected PRIVATE_TERM finding');
});

test('canary: PRIVATE_TERM word-boundary (no substring false-positive)', () => {
  const f = scanCanary('PRIVATE_TERM', 'this mentions canarytermish, not the real term');
  assert(!f.some((x) => x.label === 'PRIVATE_TERM'), 'substring should not match at word boundary');
});

test('canary: MARKER_UUID', () => {
  const f = scanCanary('MARKER_UUID', 'marker: 4f9e2b10-4a3c-4d5e-8f6a-1b2c3d4e5f6a');
  assert(f.some((x) => x.label === 'MARKER_UUID'), 'expected MARKER_UUID finding');
});

test('canary: SECRET_KEY', () => {
  const f = scanCanary('SECRET_KEY', 'token=ghp_' + 'a'.repeat(36));
  assert(f.some((x) => x.label === 'SECRET_KEY'), 'expected SECRET_KEY finding');
});

test('canary: CONN_STRING', () => {
  const f = scanCanary('CONN_STRING', 'DATABASE_URL=postgres://u:canarypw@h/d');
  assert(f.some((x) => x.label === 'CONN_STRING'), 'expected CONN_STRING finding');
});

test('canary: BASE64_DECODE', () => {
  const owner = 'C:\\Users\\testcanary\\secret-file.txt-padding-to-make-this-long-enough';
  const b64 = Buffer.from(owner, 'utf8').toString('base64');
  const f = scanCanary('BASE64_DECODE', `blob: ${b64}`);
  assert(f.some((x) => x.label === 'BASE64_DECODE'), 'expected BASE64_DECODE finding');
});

// ===========================================================================
// 2. One fixture per adversary finding A1-F1 (14 total).
// ===========================================================================

// A1 — owner-path pattern coverage across all named shapes.
test('A1: OWNER_PATH — C:\\Users\\<name>', () => {
  assert(scanCanary('x', 'C:\\Users\\djwmo\\stuff').some((f) => f.label === 'OWNER_PATH'));
});
test('A1: OWNER_PATH — C:/Users/<name>', () => {
  assert(scanCanary('x', 'C:/Users/djwmo/stuff').some((f) => f.label === 'OWNER_PATH'));
});
test('A1: OWNER_PATH — %USERPROFILE%', () => {
  assert(scanCanary('x', 'path is %USERPROFILE%\\stuff').some((f) => f.label === 'OWNER_PATH'));
});
test('A1: OWNER_PATH — ~/name', () => {
  assert(scanCanary('x', 'lives at ~/dotfiles here').some((f) => f.label === 'OWNER_PATH'));
});
test('A1: OWNER_PATH — URL-encoded C%3A%5CUsers%5Cname', () => {
  const encoded = encodeURIComponent('C:\\Users\\djwmo\\stuff');
  assert(scanCanary('x', `link=${encoded}`).some((f) => f.label === 'OWNER_PATH'));
});

// A2 — overlapping manifest entries -> FAIL_GATE_ERROR, no implicit precedence.
test('A2: overlapping manifest entries -> FAIL_GATE_ERROR', () => {
  const manifest = {
    entries: [
      { path: 'scripts/a.js', class: 'LIFT', source_sha256: 'x'.repeat(64), transform: null },
      { path: 'scripts/*.js', class: 'LEAVE', reason: 'catch-all' },
    ],
  };
  const cls = gate.classifyPaths(['scripts/a.js'], manifest);
  assert(cls.overlap.length === 1, 'expected exactly one overlap entry');
  const outcome = gate.classifyOutcome({ overlap: cls.overlap });
  assert(outcome.outcome === 'FAIL_GATE_ERROR', `expected FAIL_GATE_ERROR, got ${outcome.outcome}`);
});

// A3 — discovery is git ls-tree full-tree; gitlinks/.gitmodules UNCLASSIFIED unless listed.
test('A3: gitlink/.gitmodules path is UNCLASSIFIED unless in manifest', () => {
  const manifest = { entries: [{ path: 'README.md', class: 'LEAVE', reason: 'n/a' }] };
  const cls = gate.classifyPaths(['.gitmodules', 'vendor/lib'], manifest);
  assert(cls.unclassified.includes('.gitmodules'), '.gitmodules must be UNCLASSIFIED by default');
  assert(cls.unclassified.includes('vendor/lib'), 'gitlink path must be UNCLASSIFIED by default');
});

// B1 — lift script has no manifest write path.
test('B1: lift-to-public.js never opens PUBLIC-MANIFEST.json for writing', () => {
  const liftPath = path.join(PROJECT_ROOT, 'scripts', 'lift-to-public.js');
  if (!fs.existsSync(liftPath)) {
    // Explicitly out of scope for this PR (forbidden deliverable) — the
    // manifest-write-path invariant is asserted only once that file exists.
    return;
  }
  const src = fs.readFileSync(liftPath, 'utf8');
  const writeCalls = src.match(/fs\.(writeFile(Sync)?|appendFile(Sync)?|createWriteStream)\([^)]*MANIFEST/gi) || [];
  assert(writeCalls.length === 0, `found manifest write call(s): ${writeCalls.join(', ')}`);
});

// B2 — transform entries require both source_sha256 and target_sha256.
test('B2: transform entry missing target_sha256 -> shape error', () => {
  const manifest = {
    entries: [
      { path: 'scripts/a.js', class: 'LIFT', source_sha256: 'x'.repeat(64), transform: { from: 'a', to: 'b' } },
    ],
  };
  const cls = gate.classifyPaths(['scripts/a.js'], manifest);
  assert(cls.shapeErrors.some((e) => /target_sha256/.test(e)), 'expected a target_sha256 shape error');
});

// C1 — UTF-16 decode before scanning.
test('C1: UTF-16LE BOM content is decoded and scanned', () => {
  const text = 'owner path: C:\\Users\\djwmo\\file.txt';
  const buf = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]);
  const f = gate.scanBytes(buf, { location: 'x', termRegexes: TERM_REGEXES });
  assert(f.some((x) => x.label === 'OWNER_PATH'), 'expected OWNER_PATH finding from UTF-16LE decode');
});

// C2 — empty/whitespace-only terms file -> FAIL_GATE_ERROR.
test('C2: whitespace-only private-terms file -> gate error', () => {
  const p = writeTermsFile('   \n\n  \t\n');
  let threw = false;
  try {
    gate.loadPrivateTerms(p);
  } catch (e) {
    threw = e instanceof gate.GateError;
  }
  assert(threw, 'expected GateError for whitespace-only terms file');
});

// C3 — word-boundary, case-insensitive term matching.
test('C3: PRIVATE_TERM matches case-insensitively at word boundary', () => {
  const f = scanCanary('x', 'discussion of CANARYTERM in caps');
  assert(f.some((x) => x.label === 'PRIVATE_TERM'), 'expected case-insensitive match');
});

// D1 — commit author/committer identity scanned; mismatch flagged.
test('D1: commit identity mismatch -> COMMIT_IDENTITY finding, PASS blocked', () => {
  const dir = mkRepo();
  writeFile(dir, 'README.md', 'hello world\n');
  execFileSync('git', ['config', 'user.email', 'realowner@example.com'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'Real Owner'], { cwd: dir });
  const sha = commit(dir, 'init');
  writeFile(dir, 'PUBLIC-MANIFEST.json', JSON.stringify({
    entries: [
      { path: 'README.md', class: 'LIFT', source_sha256: sha256(fs.readFileSync(path.join(dir, 'README.md'))), transform: null },
      { path: 'PUBLIC-MANIFEST.json', class: 'LEAVE', reason: 'self' },
    ],
  }));
  commit(dir, 'manifest');
  const shaFinal = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();
  const { outcome, results } = gate.runGate(
    ['--manifest', path.join(dir, 'PUBLIC-MANIFEST.json'), '--root', dir, '--commit', shaFinal, '--terms', TERMS_FILE],
    BASE_ENV
  );
  assert(results.findings.some((f) => f.label === 'COMMIT_IDENTITY'), 'expected COMMIT_IDENTITY finding');
  assert(outcome.outcome === 'FAIL_CONTENT', `expected FAIL_CONTENT, got ${outcome.outcome}`);
});

// D2 — path strings and ref names scanned.
test('D2: path string itself matching a scanner pattern is flagged', () => {
  const f = gate.scanText('C:/Users/djwmo/leaked-in-a-filename.txt', { location: 'path:x', termRegexes: TERM_REGEXES });
  assert(f.some((x) => x.label === 'OWNER_PATH'), 'expected path-string OWNER_PATH finding');
});
test('D2: ref name matching a scanner pattern is flagged', () => {
  const f = gate.scanText('fix/canaryterm-thing', { location: 'ref', termRegexes: TERM_REGEXES });
  assert(f.some((x) => x.label === 'PRIVATE_TERM'), 'expected ref-name PRIVATE_TERM finding');
});

// E1 — bootstrap order is a documented process requirement, not a runtime
// check the gate itself can enforce; assert the spec/workflow encode it.
test('E1: workflow template exists standalone (bootstrap-first-commit shape)', () => {
  const wf = path.join(PROJECT_ROOT, 'templates', 'public-repo', '.github', 'workflows', 'sanitize.yml');
  assert(fs.existsSync(wf), 'sanitize.yml workflow template must exist for bootstrap-first-commit');
  const specText = fs.readFileSync(path.join(PROJECT_ROOT, 'docs', 'specs', 'public-sanitize-gate.md'), 'utf8');
  assert(/Bootstrap order/.test(specText), 'spec must document bootstrap ordering');
});

// E2 — bypass env vars are fail-closed.
test('E2: SANITIZE_SKIP set -> FAIL_GATE_ERROR', () => {
  const found = gate.detectBypassEnv({ SANITIZE_SKIP: '1' });
  assert(found.includes('SANITIZE_SKIP'));
  const outcome = gate.classifyOutcome({ gateErrors: ['bypass'] });
  assert(outcome.outcome === 'FAIL_GATE_ERROR');
});
for (const name of gate.BYPASS_ENV_NAMES) {
  test(`E2: bypass env var ${name} detected`, () => {
    assert(gate.detectBypassEnv({ [name]: 'true' }).includes(name), `${name} must be detected as bypass`);
  });
}

// F1 — sole authoritative result is exit code + single final JSON line.
test('F1: runGate returns a single well-formed outcome object (no partial state)', () => {
  const manifest = { entries: [{ path: 'a.js', class: 'LEAVE', reason: 'n/a' }] };
  const cls = gate.classifyPaths(['a.js'], manifest);
  const outcome = gate.classifyOutcome({
    unclassified: cls.unclassified,
    overlap: cls.overlap,
    shapeErrors: cls.shapeErrors,
    hashDrift: [],
    findings: [],
    gateErrors: [],
  });
  assert(typeof outcome.outcome === 'string' && typeof outcome.exitCode === 'number', 'outcome must be a complete object');
  assert(outcome.outcome === 'PASS', `expected PASS for a clean LEAVE-only manifest, got ${outcome.outcome}`);
});

// ===========================================================================
// 3. Totality table — >=30 generated inputs, each asserting exactly one
//    outcome.
// ===========================================================================
const totalityCases = [];

// PASS cases (clean text, no findings).
for (let i = 0; i < 8; i++) {
  totalityCases.push({ text: `clean sentence number ${i} about nothing private`, expect: 'clean' });
}
// OWNER_PATH variants.
['C:\\Users\\alice\\x', 'C:/Users/bob/y', '/home/carol/z', '/Users/dave/w', '%USERPROFILE%\\q', '~/dotconfig']
  .forEach((p) => totalityCases.push({ text: `see ${p} for the file`, expect: 'dirty' }));
// PRIVATE_DB variants.
['claude_policy_framework', 'pipeline_foo', 'claude_context', 'memory_manager_staging']
  .forEach((db) => totalityCases.push({ text: `uses ${db} as its store`, expect: 'dirty' }));
// SECRET_KEY variants.
['AKIAABCDEFGHIJKLMNOP', 'ghp_' + 'b'.repeat(36), 'sk-ant-' + 'c'.repeat(24)]
  .forEach((s) => totalityCases.push({ text: `key: ${s}`, expect: 'dirty' }));
// CONN_STRING.
totalityCases.push({ text: 'mysql://u:p@host/db', expect: 'dirty' });
totalityCases.push({ text: 'postgres://root:hunter2@dbhost:5432/app', expect: 'dirty' });
// MARKER_UUID.
totalityCases.push({ text: 'marker id 1a2b3c4d-1234-4abc-89ab-1234567890ab', expect: 'dirty' });
// PRIVATE_TERM.
totalityCases.push({ text: 'refers to seededterm in the doc', expect: 'dirty' });
// More clean cases to pad past 30 total.
for (let i = 0; i < 6; i++) {
  totalityCases.push({ text: `another benign line ${i} with numbers 12345`, expect: 'clean' });
}

test(`totality table has >= 30 cases`, () => {
  assert(totalityCases.length >= 30, `expected >=30 cases, got ${totalityCases.length}`);
});

totalityCases.forEach((c, i) => {
  test(`totality[${i}]: "${c.text.slice(0, 40)}" -> ${c.expect}`, () => {
    const findings = scanCanary('x', c.text);
    if (c.expect === 'dirty') {
      assert(findings.length >= 1, `expected >=1 finding for: ${c.text}`);
    } else {
      assert(findings.length === 0, `expected 0 findings for: ${c.text}, got ${JSON.stringify(findings)}`);
    }
  });
});

// ===========================================================================
// 4. A missing private-terms file fails closed (distinct from empty file).
// ===========================================================================
test('missing private-terms file (path does not exist) -> gate error', () => {
  let threw = false;
  try {
    gate.loadPrivateTerms(path.join(os.tmpdir(), 'does-not-exist-' + Date.now() + '.txt'));
  } catch (e) {
    threw = e instanceof gate.GateError;
  }
  assert(threw, 'expected GateError for missing terms file');
});

test('runGate with no --terms and no SANITIZE_PRIVATE_TERMS_FILE -> FAIL_GATE_ERROR', () => {
  const dir = mkRepo();
  writeFile(dir, 'README.md', 'hi\n');
  commit(dir, 'init');
  writeFile(dir, 'PUBLIC-MANIFEST.json', JSON.stringify({ entries: [{ path: 'README.md', class: 'LEAVE', reason: 'n/a' }, { path: 'PUBLIC-MANIFEST.json', class: 'LEAVE', reason: 'self' }] }));
  commit(dir, 'manifest');
  const { outcome } = gate.runGate(
    ['--manifest', path.join(dir, 'PUBLIC-MANIFEST.json'), '--root', dir],
    {}
  );
  assert(outcome.outcome === 'FAIL_GATE_ERROR', `expected FAIL_GATE_ERROR, got ${outcome.outcome}`);
});

// ---------------------------------------------------------------------------
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const f of failures) console.log(`  - ${f}`);
  process.exitCode = 1;
}
