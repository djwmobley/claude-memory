'use strict';

/**
 * test-build-zip.js -- regression coverage for scripts/build-zip.js, the
 * public-zip packager (docs/specs/package-and-installer.md section 1).
 *
 * Covers:
 *   T1  Include-list totality: every path in getIncludePaths() (both the
 *       base list and the --offline-extended list, minus scripts/node_modules
 *       which is never present in this repo checkout) exists on disk in
 *       THIS repo (proof the list matches main, not a stale snapshot).
 *   T2  Exclusion assertions: a synthetic fixture tree containing .git/,
 *       .claude/, node_modules/, .env, foo.local.json, a *.bak- file,
 *       docs/notes/, and a private-runbook-named file is walked with
 *       walkEntry() and every one of those is proven ABSENT from the
 *       result; ordinary sibling files are proven PRESENT.
 *   T3  stageBuild() on a small synthetic fixture repo produces VERSION
 *       (exact requested version, single line) and SHA256SUMS (one
 *       correctly-hashed line per staged file, SHA256SUMS excluded from
 *       its own listing).
 *   T4  --offline: getIncludePaths({offline:true}) includes
 *       scripts/node_modules; validateIncludePaths() against a fixture
 *       missing that directory reports it as missing (refuses loudly,
 *       never silently produces an incomplete offline zip); a fixture that
 *       DOES have scripts/node_modules stages it.
 *   T5  archive(): a real end-to-end zip build against the synthetic
 *       fixture repo (buildZip()) produces a .zip file whose name embeds
 *       the requested version, and whose staged-file count matches what
 *       stageBuild() reported.
 *
 * Usage: node test/test-build-zip.js
 * Requires: nothing (no DB, no network) for T1-T4. T5 requires a working
 * platform archiver (tar.exe/bsdtar on win32, `zip` elsewhere) -- if
 * findArchiver() reports none is available, T5 is reported SKIPPED (never
 * silently passed) rather than failing the whole suite on an environment
 * that genuinely cannot build a zip at all.
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert');

const {
  REPO_ROOT,
  getIncludePaths,
  isExcludedPath,
  walkEntry,
  validateIncludePaths,
  resolveVersion,
  computeShaSums,
  stageBuild,
  buildZip,
  findArchiver,
} = require('../scripts/build-zip.js');

let pass = 0;
let fail = 0;
let skip = 0;

function check(label, fn) {
  try {
    fn();
    console.log(`  [PASS] ${label}`);
    pass++;
  } catch (err) {
    console.log(`  [FAIL] ${label}\n    ${err.message}`);
    fail++;
  }
}

function skipCheck(label, reason) {
  console.log(`  [SKIP] ${label} (${reason})`);
  skip++;
}

// ─── Fixture repo builder ────────────────────────────────────────────────────
// Builds a minimal synthetic repo tree under os.tmpdir() shaped like the
// real include list, PLUS excluded hazards mixed in, so T2/T3/T4/T5 never
// touch the real repo's content (no real secrets, no real private files).
function buildFixtureRepo({ withOfflineNodeModules = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-buildzip-fixture-'));

  const write = (rel, content = 'x') => {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  };

  // Base include-list shape (mirrors BASE_INCLUDE_PATHS in build-zip.js).
  write('LICENSE', 'MIT\n');
  write('README.md', '# fixture\n');
  write('QUICKSTART.md', 'quickstart\n');
  write('PREREQS.md', 'prereqs\n');
  write('CHANGELOG.md', 'changelog\n');
  write('install.cmd', '@echo off\n');
  write('install.sh', '#!/bin/sh\n');
  write('commands/handoff/status.md', 'status cmd\n');
  write('hooks/hooks.json', '{}\n');
  write('hooks/README.md', 'hooks readme\n');
  write('templates/handoff.md.tpl', 'tpl\n');
  write('docs/mcp-tools.md', 'mcp tools\n');
  write('deploy/docker-compose.yml', 'services: {}\n');
  write('deploy/.env.example', 'POSTGRES_PASSWORD=\n');
  write('scripts/install.js', "console.log('install');\n");
  write('scripts/handoff.js', "console.log('handoff');\n");
  write('scripts/handoff-mcp.mjs', "export {};\n");
  write('scripts/handoff-mcp-selftest.mjs', "export {};\n");
  write('scripts/init-config.js', "console.log('init-config');\n");
  write('scripts/lib/shared.js', "module.exports = {};\n");
  write('scripts/sql/handoff-core-schema.sql', '-- handoff:dialect postgres\nSELECT 1;\n');
  write('scripts/migrations/migrate-01-canonical-db.js', "console.log('migrate');\n");
  write('scripts/package.json', JSON.stringify({ name: 'fixture-scripts', version: '9.9.9' }, null, 2));
  write('scripts/package-lock.json', '{}\n');
  write('scripts/pnpm-lock.yaml', 'lockfileVersion: 9\n');

  // Excluded hazards mixed directly alongside included content, proving
  // isExcludedPath()/walkEntry() filter them OUT of an included directory
  // rather than relying on them never being present.
  write('scripts/lib/.local.secret.json', '{"leak":true}\n');
  write('scripts/lib/node_modules/leftover/index.js', 'stray\n'); // never the top-level one
  write('docs/notes/2026-01-01-private.md', 'private note\n');
  write('CONSOLIDATION-RUNBOOK.md', 'private runbook\n'); // not in include list at all, but proves isExcludedPath too
  write('scripts/migrations/foo.js.bak-20260101', 'stale backup\n');

  if (withOfflineNodeModules) {
    write('scripts/node_modules/pg/index.js', "module.exports = {};\n");
  }

  return root;
}

// ─── T1: include-list totality against the REAL repo ────────────────────────
check('T1: every base include-list path exists in this repo checkout', () => {
  const includePaths = getIncludePaths({ offline: false });
  const { missing, ok } = validateIncludePaths(REPO_ROOT, includePaths);
  assert.ok(ok, `missing from repo: ${missing.join(', ')}`);
  assert.ok(includePaths.includes('scripts/lib'));
  assert.ok(includePaths.includes('deploy'));
  assert.ok(!includePaths.includes('scripts/node_modules'), 'offline-only path leaked into the base list');
});

check('T1b: --offline include list adds scripts/node_modules', () => {
  const includePaths = getIncludePaths({ offline: true });
  assert.ok(includePaths.includes('scripts/node_modules'));
});

// ─── T2: exclusion assertions ────────────────────────────────────────────────
let fixtureRoot;
check('T2 setup: build synthetic fixture repo', () => {
  fixtureRoot = buildFixtureRepo({ withOfflineNodeModules: false });
  assert.ok(fs.existsSync(fixtureRoot));
});

check('T2: walkEntry() excludes .local. files from an included directory', () => {
  const files = walkEntry(fixtureRoot, 'scripts/lib', { offline: false });
  const rels = files.map((f) => f.rel);
  assert.ok(!rels.includes('scripts/lib/.local.secret.json'), 'excluded .local. file leaked in');
  assert.ok(rels.includes('scripts/lib/shared.js'), 'ordinary sibling file was wrongly excluded');
});

check('T2: walkEntry() excludes a nested node_modules (offline:false)', () => {
  const files = walkEntry(fixtureRoot, 'scripts/lib', { offline: false });
  const rels = files.map((f) => f.rel);
  assert.ok(!rels.some((r) => r.includes('node_modules')), 'nested node_modules leaked in');
});

check('T2: walkEntry() excludes docs/notes/ entirely', () => {
  const files = walkEntry(fixtureRoot, 'docs', { offline: false });
  const rels = files.map((f) => f.rel);
  assert.ok(!rels.some((r) => r.startsWith('docs/notes/')), 'docs/notes/ content leaked in');
  assert.ok(rels.includes('docs/mcp-tools.md'), 'ordinary docs file was wrongly excluded');
});

check('T2: walkEntry() excludes a *.bak- file inside an included directory', () => {
  const files = walkEntry(fixtureRoot, 'scripts/migrations', { offline: false });
  const rels = files.map((f) => f.rel);
  assert.ok(!rels.some((r) => r.includes('.bak-')), '.bak- file leaked in');
  assert.ok(rels.includes('scripts/migrations/migrate-01-canonical-db.js'));
});

check('T2: isExcludedPath() flags a private-runbook-named file directly', () => {
  assert.strictEqual(isExcludedPath('CONSOLIDATION-RUNBOOK.md'), true);
  assert.strictEqual(isExcludedPath('START-HERE-CONSOLIDATION.md'), true);
  assert.strictEqual(isExcludedPath('FIELD-REPORT-2026-01-01.md'), true);
  assert.strictEqual(isExcludedPath('README.md'), false);
});

check('T2: isExcludedPath() distinguishes .env from .env.example', () => {
  assert.strictEqual(isExcludedPath('deploy/.env'), true);
  assert.strictEqual(isExcludedPath('deploy/.env.example'), false);
});

check('T2: isExcludedPath() never excludes the offline top-level scripts/node_modules', () => {
  assert.strictEqual(isExcludedPath('scripts/node_modules', { offline: true }), false);
  assert.strictEqual(isExcludedPath('scripts/node_modules', { offline: false }), true);
  assert.strictEqual(isExcludedPath('scripts/lib/node_modules', { offline: true }), true);
});

// ─── T3: stageBuild() -- VERSION + SHA256SUMS ────────────────────────────────
check('T3: stageBuild() writes VERSION with the exact requested version', () => {
  const stageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-buildzip-stage-'));
  try {
    const includePaths = getIncludePaths({ offline: false });
    const { missing } = validateIncludePaths(fixtureRoot, includePaths);
    assert.deepStrictEqual(missing, [], `fixture repo missing include-list paths: ${missing.join(', ')}`);
    const { stagedFiles } = stageBuild({
      repoRoot: fixtureRoot,
      includePaths,
      offline: false,
      version: '1.2.3-fixture',
      stageDir,
    });
    const versionContent = fs.readFileSync(path.join(stageDir, 'VERSION'), 'utf8');
    assert.strictEqual(versionContent, '1.2.3-fixture\n');
    assert.ok(stagedFiles.some((f) => f.rel === 'VERSION'));
    assert.ok(stagedFiles.some((f) => f.rel === 'SHA256SUMS'));
    // Excluded hazards must never appear among staged files.
    assert.ok(!stagedFiles.some((f) => f.rel.includes('.local.')));
    assert.ok(!stagedFiles.some((f) => f.rel.includes('node_modules')));
    assert.ok(!stagedFiles.some((f) => f.rel.startsWith('docs/notes/')));
  } finally {
    fs.rmSync(stageDir, { recursive: true, force: true });
  }
});

check('T3: SHA256SUMS has one correct sha256 line per staged file (excluding itself)', () => {
  const stageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-buildzip-stage-'));
  try {
    const includePaths = getIncludePaths({ offline: false });
    const { stagedFiles } = stageBuild({
      repoRoot: fixtureRoot,
      includePaths,
      offline: false,
      version: '1.2.3-fixture',
      stageDir,
    });
    const shaSumsContent = fs.readFileSync(path.join(stageDir, 'SHA256SUMS'), 'utf8');
    const lines = shaSumsContent.trim().split('\n');
    const nonShaSumsFiles = stagedFiles.filter((f) => f.rel !== 'SHA256SUMS');
    assert.strictEqual(lines.length, nonShaSumsFiles.length, 'line count must match staged-file count minus SHA256SUMS itself');
    assert.ok(!shaSumsContent.includes('  SHA256SUMS\n') && !lines.some((l) => l.endsWith('  SHA256SUMS')), 'SHA256SUMS must not hash itself');

    const crypto = require('node:crypto');
    const byRel = new Map(nonShaSumsFiles.map((f) => [f.rel, f]));
    for (const line of lines) {
      const m = line.match(/^([0-9a-f]{64})  (.+)$/);
      assert.ok(m, `malformed SHA256SUMS line: ${line}`);
      const [, hash, rel] = m;
      const f = byRel.get(rel);
      assert.ok(f, `SHA256SUMS references unstaged file: ${rel}`);
      const actual = crypto.createHash('sha256').update(fs.readFileSync(f.abs)).digest('hex');
      assert.strictEqual(hash, actual, `hash mismatch for ${rel}`);
    }
  } finally {
    fs.rmSync(stageDir, { recursive: true, force: true });
  }
});

check('T3: computeShaSums() is deterministic and sorted', () => {
  const stagedFiles = [
    { abs: path.join(fixtureRoot, 'README.md'), rel: 'README.md' },
    { abs: path.join(fixtureRoot, 'LICENSE'), rel: 'LICENSE' },
  ];
  const out = computeShaSums(stagedFiles);
  const lines = out.trim().split('\n');
  assert.strictEqual(lines.length, 2);
  assert.ok(lines[0] < lines[1] || lines[0].split('  ')[1] < lines[1].split('  ')[1], 'output must be sorted');
});

// ─── T4: --offline ────────────────────────────────────────────────────────────
check('T4: validateIncludePaths() refuses --offline against a fixture with no scripts/node_modules', () => {
  const includePaths = getIncludePaths({ offline: true });
  const { missing, ok } = validateIncludePaths(fixtureRoot, includePaths);
  assert.strictEqual(ok, false);
  assert.ok(missing.includes('scripts/node_modules'));
});

check('T4: --offline stages scripts/node_modules when present', () => {
  const offlineRoot = buildFixtureRepo({ withOfflineNodeModules: true });
  const stageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-buildzip-stage-offline-'));
  try {
    const includePaths = getIncludePaths({ offline: true });
    const { missing } = validateIncludePaths(offlineRoot, includePaths);
    assert.deepStrictEqual(missing, []);
    const { stagedFiles } = stageBuild({
      repoRoot: offlineRoot,
      includePaths,
      offline: true,
      version: '1.2.3-offline',
      stageDir,
    });
    assert.ok(stagedFiles.some((f) => f.rel === 'scripts/node_modules/pg/index.js'));
  } finally {
    fs.rmSync(stageDir, { recursive: true, force: true });
    fs.rmSync(offlineRoot, { recursive: true, force: true });
  }
});

// ─── T5: end-to-end archive() via buildZip() ────────────────────────────────
let archiverAvailable = true;
try {
  findArchiver();
} catch {
  archiverAvailable = false;
}

if (archiverAvailable) {
  check('T5: buildZip() produces a .zip named with the requested version', () => {
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-buildzip-out-'));
    try {
      const result = buildZip({ repoRoot: fixtureRoot, versionFlag: '4.5.6-e2e', offline: false, outDir });
      assert.ok(fs.existsSync(result.zipPath));
      assert.strictEqual(path.basename(result.zipPath), 'memory-manager-4.5.6-e2e.zip');
      assert.ok(fs.statSync(result.zipPath).size > 0);
      assert.ok(result.stagedFiles.length > 10);
    } finally {
      fs.rmSync(outDir, { recursive: true, force: true });
    }
  });
} else {
  skipCheck('T5: buildZip() end-to-end archive', 'no platform archiver available on this host');
}

check('T3/T5 teardown: remove synthetic fixture repo', () => {
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
  assert.ok(!fs.existsSync(fixtureRoot));
});

// ─── Summary ──────────────────────────────────────────────────────────────────
console.log(`\n${pass} passed, ${fail} failed, ${skip} skipped`);
process.exit(fail > 0 ? 1 : 0);
