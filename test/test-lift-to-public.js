'use strict';

/**
 * test-lift-to-public.js — tests for scripts/lift-to-public.js and
 * PUBLIC-MANIFEST.json, per docs/specs/public-sanitize-gate.md.
 *
 * STACKED ON PR #306 (feat/public-sanitize-gate): scripts/sanitize-gate.js
 * does not exist on this branch until #306 merges and this branch is
 * rebased onto it. The tests that exercise the real gate (the seeded
 * private-term fixture, and the happy-path end-to-end run) require that
 * file and FAIL LOUDLY with a clear message if it is missing, rather than
 * skip silently — see the `requireGate()` guard below. This is expected
 * and documented, not a bug in this test file: it is the visible signal
 * that this branch needs the rebase.
 *
 * Structure:
 *   1. Manifest totality against origin/main's real tree (every discovered
 *      path classified exactly once, no overlaps, zero UNCLASSIFIED).
 *   2. Every LIFT entry's source_sha256 (and target_sha256 where a
 *      transform is set) matches the live blob.
 *   3. A synthetic fixture source repo with a drifted file ->
 *      FAIL_HASH_DRIFT, nothing written.
 *   4. A synthetic fixture with a seeded private term -> gate FAIL -> no
 *      commit left standing as PASS (requires scripts/sanitize-gate.js).
 *   5. Happy-path synthetic fixture -> one commit, expected message +
 *      identity (requires scripts/sanitize-gate.js).
 *   6. --dry-run writes nothing to disk.
 *
 * Usage: node test/test-lift-to-public.js
 * Requires: git on PATH. No Postgres, no network.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const LIFT_SCRIPT = path.join(PROJECT_ROOT, 'scripts', 'lift-to-public.js');
const GATE_SCRIPT = path.join(PROJECT_ROOT, 'scripts', 'sanitize-gate.js');
const MANIFEST_PATH = path.join(PROJECT_ROOT, 'PUBLIC-MANIFEST.json');

const lift = require(LIFT_SCRIPT);

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

function requireGate() {
  if (!fs.existsSync(GATE_SCRIPT)) {
    throw new Error(
      'scripts/sanitize-gate.js not found — this branch is stacked on PR #306 ' +
      '(feat/public-sanitize-gate) and must be rebased onto main once that PR ' +
      'merges before this test can pass. See PR body "stacked on #306".'
    );
  }
}

// ---------------------------------------------------------------------------
// Fixture repo helper: a real throwaway git repo used as --source-root for
// the synthetic-manifest tests (drift, seeded term, happy path).
// ---------------------------------------------------------------------------
function mkSourceRepo(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lift-src-'));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'fixture@example.com'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'Fixture'], { cwd: dir });
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  execFileSync('git', ['add', '-A'], { cwd: dir });
  execFileSync('git', ['commit', '-q', '-m', 'fixture'], { cwd: dir });
  const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();
  return { dir, sha };
}

function writeManifest(entries, sourceSha) {
  const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lift-manifest-')), 'PUBLIC-MANIFEST.json');
  fs.writeFileSync(p, JSON.stringify({ generated_at: new Date().toISOString(), source_sha: sourceSha, entries }, null, 2));
  return p;
}

function injectedTemplateEntries() {
  // Mirrors PUBLIC-MANIFEST.json's own two entries for the bootstrap files
  // scripts/lift-to-public.js injects from templates/public-repo/** — see
  // lift-to-public.js's INJECTED_TARGET_PATHS. PUBLIC-MANIFEST.json itself
  // is deliberately NOT included here: its own content hash is
  // self-referential (adding an entry for it changes its bytes, which
  // changes the hash), a real, reported gap in the spec's total-
  // classification design for this one bootstrap file — see PR body
  // "leads". Every fixture below that runs the real gate therefore has
  // exactly one expected unclassified path: PUBLIC-MANIFEST.json.
  return [
    {
      path: '.github/workflows/sanitize.yml', class: 'LIFT',
      source_sha256: sha256(fs.readFileSync(path.join(PROJECT_ROOT, 'templates/public-repo/.github/workflows/sanitize.yml'))),
      transform: null,
    },
    {
      path: 'hooks/pre-push', class: 'LIFT',
      source_sha256: sha256(fs.readFileSync(path.join(PROJECT_ROOT, 'templates/public-repo/hooks/pre-push'))),
      transform: null,
    },
  ];
}

function copyPublicRepoTemplates(sourceRoot) {
  // The synthetic source repos below are not full claude-memory checkouts,
  // so lift-to-public.js's writeTemplates() step needs the two real
  // templates present at the expected relative path. Copy them in from the
  // real PROJECT_ROOT (read-only reuse of tracked files, not a modification
  // of anything sanitize-gate-owned).
  for (const rel of ['templates/public-repo/.github/workflows/sanitize.yml', 'templates/public-repo/hooks/pre-push']) {
    const src = path.join(PROJECT_ROOT, rel);
    const dest = path.join(sourceRoot, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
  }
}

function copyGate(sourceRoot) {
  requireGate();
  const dest = path.join(sourceRoot, 'scripts', 'sanitize-gate.js');
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(GATE_SCRIPT, dest);
}

function mkTermsFile(terms) {
  const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lift-terms-')), 'terms.txt');
  fs.writeFileSync(p, terms.join('\n') + '\n');
  return p;
}

// ===========================================================================
// 1. Manifest totality against the real repo tree.
// ===========================================================================
test('PUBLIC-MANIFEST.json classifies every path in its own source_sha tree exactly once', () => {
  const manifest = lift.readManifest(MANIFEST_PATH);
  assert(typeof manifest.source_sha === 'string' && manifest.source_sha.length > 0, 'manifest.source_sha missing');

  let treePaths;
  try {
    treePaths = execFileSync('git', ['ls-tree', '-r', '--name-only', manifest.source_sha], {
      cwd: PROJECT_ROOT,
      encoding: 'utf8',
    }).split(/\r?\n/).filter(Boolean);
  } catch (e) {
    throw new Error(`manifest.source_sha ${manifest.source_sha} not resolvable in this checkout (fetch it first): ${e.message}`);
  }

  const seen = new Map();
  for (const e of manifest.entries) {
    assert(e && typeof e.path === 'string' && e.path, `malformed entry: ${JSON.stringify(e)}`);
    assert(!seen.has(e.path), `duplicate manifest entry for ${e.path}`);
    seen.set(e.path, e);
    assert(e.class === 'LIFT' || e.class === 'LEAVE', `${e.path}: class must be LIFT or LEAVE`);
    if (e.class === 'LEAVE') assert(typeof e.reason === 'string' && e.reason.length > 0, `${e.path}: LEAVE missing reason`);
  }

  const missing = treePaths.filter((p) => !seen.has(p));
  assert(missing.length === 0, `UNCLASSIFIED paths (in tree, not in manifest): ${missing.slice(0, 10).join(', ')}${missing.length > 10 ? ` (+${missing.length - 10} more)` : ''}`);

  // lift-to-public.js's own INJECTED_TARGET_PATHS: bootstrap files it writes
  // into the target tree from templates/public-repo/** that do not exist at
  // that path in claude-memory's own source tree at manifest.source_sha —
  // their manifest entries exist so the gate's post-copy scan of the
  // TARGET tree classifies them, not to satisfy source-tree totality.
  const INJECTED = new Set(['.github/workflows/sanitize.yml', 'hooks/pre-push']);
  const extra = [...seen.keys()].filter((p) => !treePaths.includes(p) && !INJECTED.has(p));
  assert(extra.length === 0, `manifest entries for paths not in the tree and not a known injected bootstrap path: ${extra.slice(0, 10).join(', ')}`);
  for (const p of INJECTED) {
    assert(seen.has(p), `expected injected bootstrap entry ${p} in the manifest`);
  }
});

// ===========================================================================
// 2. Every LIFT sha256 matches the live blob.
// ===========================================================================
test('every LIFT entry source_sha256 (and target_sha256) matches the live blob', () => {
  const manifest = lift.readManifest(MANIFEST_PATH);
  const liftEntries = lift.verifyAndCollectLift(manifest, PROJECT_ROOT, manifest.source_sha);
  assert(liftEntries.length > 0, 'expected at least one LIFT entry');
  const liftCount = manifest.entries.filter((e) => e.class === 'LIFT').length;
  // verifyAndCollectLift() skips lift.INJECTED_TARGET_PATHS-shaped bootstrap
  // entries (no source-tree blob to verify them against — see that
  // function's own comment) but still hashes every real source-tree LIFT
  // path, which is what this test cares about.
  const injectedCount = manifest.entries.filter((e) => e.class === 'LIFT' && ['.github/workflows/sanitize.yml', 'hooks/pre-push'].includes(e.path)).length;
  assert(
    liftEntries.length === liftCount - injectedCount,
    `verifyAndCollectLift returned ${liftEntries.length}, manifest declares ${liftCount} LIFT entries (${injectedCount} injected, expected ${liftCount - injectedCount})`
  );
});

// ===========================================================================
// 3. Drifted file -> FAIL_HASH_DRIFT, nothing written.
// ===========================================================================
test('a source file whose live bytes differ from manifest source_sha256 aborts with FAIL_HASH_DRIFT', () => {
  const { dir, sha } = mkSourceRepo({ 'a.txt': 'original content\n' });
  const wrongSha = sha256(Buffer.from('NOT the real content\n'));
  const manifestPath = writeManifest([
    { path: 'a.txt', class: 'LIFT', source_sha256: wrongSha, transform: null },
  ], sha);
  const targetDir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lift-target-')), 'out');

  let threw = false;
  try {
    lift.run([
      '--manifest', manifestPath,
      '--source-root', dir,
      '--target-dir', targetDir,
      '--base-commit', sha,
      '--identity', 'Fixture Bot <fixture@example.com>',
    ]);
  } catch (e) {
    threw = true;
    assert(/FAIL_HASH_DRIFT/.test(e.message), `expected FAIL_HASH_DRIFT, got: ${e.message}`);
  }
  assert(threw, 'expected verifyAndCollectLift to throw on hash drift');
  assert(!fs.existsSync(targetDir), 'target-dir must not exist after a hash-drift abort');
});

// ===========================================================================
// 4. Seeded private term -> gate FAIL -> no PASS commit.
// ===========================================================================
test('a LIFT file carrying a seeded private term never results in a PASS outcome', () => {
  requireGate();
  const fileContent = 'const secretClient = "ACME-CANARY-TERM";\n';
  const { dir, sha } = mkSourceRepo({ 'lib/x.js': fileContent });
  copyPublicRepoTemplates(dir);
  copyGate(dir);
  const manifestPath = writeManifest([
    { path: 'lib/x.js', class: 'LIFT', source_sha256: sha256(Buffer.from(fileContent)), transform: null },
    ...injectedTemplateEntries(),
  ], sha);
  // Note: PUBLIC-MANIFEST.json itself is written into the target tree by
  // writeManifestCopy() unconditionally (a plain filesystem copy, outside
  // the entries[] verification loop) — it must NOT also appear as a LIFT
  // entry here, since there is no such file to verify against in this
  // synthetic --source-root's git history.
  const termsFile = mkTermsFile(['ACME-CANARY-TERM']);
  const targetDir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lift-target-')), 'out');
  const prevTerms = process.env.SANITIZE_PRIVATE_TERMS_FILE;
  process.env.SANITIZE_PRIVATE_TERMS_FILE = termsFile;
  let result;
  try {
    result = lift.run([
      '--manifest', manifestPath,
      '--source-root', dir,
      '--target-dir', targetDir,
      '--base-commit', sha,
      '--identity', 'Fixture Bot <fixture@example.com>',
    ]);
  } finally {
    if (prevTerms === undefined) delete process.env.SANITIZE_PRIVATE_TERMS_FILE;
    else process.env.SANITIZE_PRIVATE_TERMS_FILE = prevTerms;
  }
  assert(result.outcome !== 'PASS', `expected a non-PASS outcome, got ${result.outcome}`);
  assert(result.exitCode !== 0, 'expected a non-zero exit code on gate failure');
});

// ===========================================================================
// 5. Happy path -> one commit, expected message + identity.
// ===========================================================================
test('happy-path lift stages the expected commit; documents the PUBLIC-MANIFEST.json self-reference gap', () => {
  // KNOWN GAP (reported as a LEAD against PR #306, not fixed here — this
  // repo's contributor is forbidden from editing scripts/sanitize-gate.js
  // or its spec): PUBLIC-MANIFEST.json's own content hash is
  // self-referential — adding a manifest entry for the file changes its
  // bytes, which changes the hash the entry would need to declare. The
  // total-classification design (docs/specs/public-sanitize-gate.md
  // "Classification") has no bootstrap exemption for this one file, so an
  // otherwise-clean lift still reports FAIL_UNCLASSIFIED_PATH citing only
  // PUBLIC-MANIFEST.json. This test asserts that CURRENT, DOCUMENTED
  // behavior precisely (not a false PASS) so a future fix to the spec/gate
  // that resolves it will fail this assertion and prompt an update here.
  requireGate();
  const fileContent = 'module.exports = { ok: true };\n';
  const { dir, sha } = mkSourceRepo({ 'lib/clean.js': fileContent });
  copyPublicRepoTemplates(dir);
  copyGate(dir);
  const manifestPath = writeManifest([
    { path: 'lib/clean.js', class: 'LIFT', source_sha256: sha256(Buffer.from(fileContent)), transform: null },
    ...injectedTemplateEntries(),
  ], sha);

  const termsFile = mkTermsFile(['no-such-term-should-ever-match-xyz']);
  const targetDir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lift-target-')), 'out');
  const identity = 'Fixture Bot <fixture@example.com>';
  const prevTerms = process.env.SANITIZE_PRIVATE_TERMS_FILE;
  process.env.SANITIZE_PRIVATE_TERMS_FILE = termsFile;
  let result;
  try {
    result = lift.run([
      '--manifest', manifestPath,
      '--source-root', dir,
      '--target-dir', targetDir,
      '--base-commit', sha,
      '--identity', identity,
    ]);
  } finally {
    if (prevTerms === undefined) delete process.env.SANITIZE_PRIVATE_TERMS_FILE;
    else process.env.SANITIZE_PRIVATE_TERMS_FILE = prevTerms;
  }

  assert(
    result.outcome === 'FAIL_UNCLASSIFIED_PATH',
    `expected the documented FAIL_UNCLASSIFIED_PATH gap, got ${result.outcome}: ${JSON.stringify(result)}`
  );
  // Every OTHER path (the real LIFT file, both injected templates) must
  // classify cleanly — only PUBLIC-MANIFEST.json's self-reference should be
  // unclassified.
  const log = execFileSync('git', ['log', '--format=%H%x00%an%x00%ae%x00%s'], { cwd: targetDir, encoding: 'utf8' })
    .trim().split(/\r?\n/).filter(Boolean);
  assert(log.length === 1, `expected exactly 1 (local, unpushed) commit, got ${log.length}`);
  const [, authorName, authorEmail, subject] = log[0].split('\x00');
  assert(authorName === 'Fixture Bot', `expected author name "Fixture Bot", got ${authorName}`);
  assert(authorEmail === 'fixture@example.com', `expected author email fixture@example.com, got ${authorEmail}`);
  assert(subject === `Initial import (lifted from claude-memory @ ${sha})`, `unexpected commit subject: ${subject}`);
  assert(fs.existsSync(path.join(targetDir, 'lib/clean.js')), 'lib/clean.js not written into target-dir');
  assert(fs.existsSync(path.join(targetDir, '.github/workflows/sanitize.yml')), 'sanitize.yml template not written');
  assert(fs.existsSync(path.join(targetDir, 'hooks/pre-push')), 'pre-push template not written');
});

// ===========================================================================
// 6. --dry-run writes nothing to disk.
// ===========================================================================
test('--dry-run performs no filesystem or git writes', () => {
  const fileContent = 'x = 1;\n';
  const { dir, sha } = mkSourceRepo({ 'a.js': fileContent });
  const manifestPath = writeManifest([
    { path: 'a.js', class: 'LIFT', source_sha256: sha256(Buffer.from(fileContent)), transform: null },
  ], sha);
  const targetDir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lift-target-')), 'out');

  const result = lift.run([
    '--manifest', manifestPath,
    '--source-root', dir,
    '--target-dir', targetDir,
    '--base-commit', sha,
    '--identity', 'Fixture Bot <fixture@example.com>',
    '--dry-run',
  ]);
  assert(result.outcome === 'DRY_RUN_OK', `expected DRY_RUN_OK, got ${result.outcome}`);
  assert(!fs.existsSync(targetDir), '--dry-run must not create target-dir');
});

// ===========================================================================
// 7. Structural invariant: no write-mode fs call targets the manifest path.
// ===========================================================================
test('lift-to-public.js has no code path that writes to the manifest it reads', () => {
  const src = fs.readFileSync(LIFT_SCRIPT, 'utf8');
  assert(
    !/fs\.(writeFileSync|appendFileSync|createWriteStream)\(\s*(args\.manifest|manifestPath)\b/.test(src),
    'found a write-mode fs call targeting the manifest path variable'
  );
  assert(
    !/fs\.copyFileSync\(\s*[^,]+,\s*(args\.manifest|manifestPath)\b/.test(src),
    'found a copyFileSync call using the manifest path as its destination'
  );
});

// ---------------------------------------------------------------------------
process.stdout.write(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) {
  process.stdout.write(failures.map((f) => `  FAIL: ${f}`).join('\n') + '\n');
  process.exitCode = 1;
}
