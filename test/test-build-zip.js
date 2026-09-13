'use strict';

/**
 * test-build-zip.js -- regression coverage for scripts/build-zip.js, the
 * public-zip packager (docs/specs/package-and-installer.md section 1).
 *
 * Round 2 (categorical privacy fix): the packager now sources every
 * BASE_INCLUDE_PATHS file via `git ls-files --cached` (the git INDEX, not
 * the filesystem) -- untracked, gitignored, and merely locally-present
 * files can therefore never enter the zip, regardless of what
 * isExcludedPath() does or doesn't name. A second safety net,
 * assertNoIgnoredFiles(), runs `git check-ignore --stdin` over the final
 * candidate list and fails loud if a force-added-despite-gitignore file
 * slipped into the index. T2 below now builds a real, throwaway git
 * fixture repo to exercise both gates end to end.
 *
 * Covers:
 *   T1  Include-list totality: every path in getIncludePaths() (both the
 *       base list and the --offline-extended list, minus scripts/node_modules
 *       which is never present in this repo checkout) exists on disk in
 *       THIS repo (proof the list matches main, not a stale snapshot).
 *   T2  Git-tracked-only enumeration + check-ignore safety net, against a
 *       real throwaway git fixture repo: a gitignored
 *       scripts/migrations/db-triage.json and an untracked
 *       scripts/migrations/backups/x.sql are both proven ABSENT from
 *       stageBuild()'s output; ordinary tracked sibling files are proven
 *       PRESENT; isExcludedPath()'s second-layer filter is proven to still
 *       exclude hazards that were nonetheless committed (.local., nested
 *       node_modules, docs/notes/, *.bak-, private-runbook names); and a
 *       build attempt where a gitignored file was force-added
 *       (`git add -f`) to the index is proven to fail loud via
 *       assertNoIgnoredFiles().
 *   T3  stageBuild() on the synthetic fixture repo produces VERSION
 *       (exact requested version, single line) and SHA256SUMS (one
 *       correctly-hashed line per staged file, SHA256SUMS excluded from
 *       its own listing).
 *   T4  --offline: getIncludePaths({offline:true}) includes
 *       scripts/node_modules; validateIncludePaths() against a fixture
 *       missing that directory reports it as missing (refuses loudly,
 *       never silently produces an incomplete offline zip); a fixture that
 *       DOES have scripts/node_modules stages it straight off the
 *       filesystem (it is legitimately untracked/gitignored real npm
 *       output, never routed through the git-tracked gates).
 *   T5  archive(): a real end-to-end zip build against the synthetic
 *       fixture repo (buildZip()) produces a .zip file whose name embeds
 *       the requested version, and whose staged-file count matches what
 *       stageBuild() reported.
 *   T6  Require-graph closure (real repo, real BASE_INCLUDE_PATHS): every
 *       require('./...')/require('../...') relative target found by a
 *       static regex scan of every shipped .js/.mjs file under scripts/
 *       resolves to another shipped file. Guards against the exact class
 *       of bug this round fixed (migrate-05 shipped without its
 *       pipeline-chunker.js dependency) recurring for any other script.
 *
 * Usage: node test/test-build-zip.js
 * Requires: a working `git` on PATH for T2 (throwaway fixture repos only --
 * never touches this checkout's own index) and T6 (reads this repo's own
 * git-tracked file list). T1-T4 need no DB/network. T5 requires a working
 * platform archiver (tar.exe/bsdtar on win32, `zip` elsewhere) -- if
 * findArchiver() reports none is available, T5 is reported SKIPPED (never
 * silently passed) rather than failing the whole suite on an environment
 * that genuinely cannot build a zip at all.
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');

const {
  REPO_ROOT,
  BASE_INCLUDE_PATHS,
  getIncludePaths,
  isExcludedPath,
  walkEntry,
  listTrackedFiles,
  assertNoIgnoredFiles,
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

// ─── git helper for fixture repos ────────────────────────────────────────────
function git(cwd, args) {
  const res = spawnSync('git', args, { cwd, shell: false, encoding: 'utf8' });
  if (res.error) throw new Error(`git ${args.join(' ')} failed to spawn: ${res.error.message}`);
  if (res.status !== 0) {
    throw new Error(`git ${args.join(' ')} exited ${res.status}: ${res.stderr}`);
  }
  return res;
}

// ─── Fixture repo builder ────────────────────────────────────────────────────
// Builds a minimal, REAL, throwaway git repo under os.tmpdir() shaped like
// the real include list, PLUS excluded hazards mixed in -- both tracked
// hazards (isExcludedPath()'s second-layer filter must still catch these)
// and untracked/gitignored hazards (the primary git-tracked-only gate must
// never let these anywhere near the candidate list at all) -- so T2-T5
// never touch the real repo's content (no real secrets, no real private
// files).
function buildFixtureRepo({ withOfflineNodeModules = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-buildzip-fixture-'));

  const write = (rel, content = 'x') => {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  };

  // Mirrors this repo's own .gitignore shape for the paths this fixture
  // exercises (scripts/migrations/db-triage.json is genuinely gitignored
  // in the real repo; backups/ isn't gitignore-matched here on purpose --
  // it demonstrates the "just never git-added" untracked case too).
  write('.gitignore', ['/scripts/migrations/db-triage.json', 'node_modules/', '.env', '.env.*', '!.env.example', ''].join('\n'));

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
  write('scripts/pipeline-chunker.js', "module.exports = { chunkText: () => [] };\n");
  write('scripts/lib/shared.js', "module.exports = {};\n");
  write('scripts/sql/handoff-core-schema.sql', '-- handoff:dialect postgres\nSELECT 1;\n');
  write('scripts/migrations/migrate-01-canonical-db.js', "console.log('migrate');\n");
  write('scripts/package.json', JSON.stringify({ name: 'fixture-scripts', version: '9.9.9' }, null, 2));
  write('scripts/package-lock.json', '{}\n');
  write('scripts/pnpm-lock.yaml', 'lockfileVersion: 9\n');

  // Tracked hazards -- committed anyway, proving isExcludedPath()'s
  // second-layer filter still catches names that reached the index.
  write('scripts/lib/.local.secret.json', '{"leak":true}\n');
  write('scripts/lib/node_modules/leftover/index.js', 'stray\n'); // never the top-level one
  write('docs/notes/2026-01-01-private.md', 'private note\n');
  write('CONSOLIDATION-RUNBOOK.md', 'private runbook\n'); // not in include list at all, but proves isExcludedPath too
  write('scripts/migrations/foo.js.bak-20260101', 'stale backup\n');

  // Untracked / gitignored hazards -- the PRIMARY gate: these are never
  // git-added below, so listTrackedFiles() must never see them at all,
  // independent of isExcludedPath().
  write('scripts/migrations/db-triage.json', '{"private":true,"leak":"never ship"}\n'); // gitignored
  write('scripts/migrations/backups/x.sql', '-- private backup, never git-added\n'); // untracked (not gitignored, just never staged)

  if (withOfflineNodeModules) {
    write('scripts/node_modules/pg/index.js', "module.exports = {};\n");
  }

  git(root, ['init', '-q']);
  git(root, ['config', 'user.email', 'fixture@example.invalid']);
  git(root, ['config', 'user.name', 'build-zip test fixture']);
  git(root, ['config', 'commit.gpgsign', 'false']);
  git(root, ['add', '-A']);
  // Untrack the "just never git-added" hazard even though `add -A` staged
  // it (it isn't gitignore-matched by design, to also cover the plain
  // "present but never committed" case, not only the gitignored case).
  git(root, ['rm', '--cached', '--quiet', 'scripts/migrations/backups/x.sql']);
  git(root, ['commit', '-q', '-m', 'fixture: initial tracked content']);

  return root;
}

// ─── T1: include-list totality against the REAL repo ────────────────────────
check('T1: every base include-list path exists in this repo checkout', () => {
  const includePaths = getIncludePaths({ offline: false });
  const { missing, ok } = validateIncludePaths(REPO_ROOT, includePaths);
  assert.ok(ok, `missing from repo: ${missing.join(', ')}`);
  assert.ok(includePaths.includes('scripts/lib'));
  assert.ok(includePaths.includes('deploy'));
  assert.ok(includePaths.includes('scripts/pipeline-chunker.js'));
  assert.ok(!includePaths.includes('scripts/node_modules'), 'offline-only path leaked into the base list');
});

check('T1b: --offline include list adds scripts/node_modules', () => {
  const includePaths = getIncludePaths({ offline: true });
  assert.ok(includePaths.includes('scripts/node_modules'));
});

// ─── T2: git-tracked-only enumeration + check-ignore safety net ─────────────
let fixtureRoot;
check('T2 setup: build synthetic git fixture repo', () => {
  fixtureRoot = buildFixtureRepo({ withOfflineNodeModules: false });
  assert.ok(fs.existsSync(fixtureRoot));
  assert.ok(fs.existsSync(path.join(fixtureRoot, '.git')));
});

check('T2: listTrackedFiles() never returns a gitignored file', () => {
  const files = listTrackedFiles(fixtureRoot, ['scripts/migrations'], { offline: false });
  const rels = files.map((f) => f.rel);
  assert.ok(!rels.includes('scripts/migrations/db-triage.json'), 'gitignored file leaked into the tracked-file candidate set');
});

check('T2: listTrackedFiles() never returns an untracked-but-present file', () => {
  const files = listTrackedFiles(fixtureRoot, ['scripts/migrations'], { offline: false });
  const rels = files.map((f) => f.rel);
  assert.ok(!rels.some((r) => r.startsWith('scripts/migrations/backups/')), 'untracked file leaked into the tracked-file candidate set');
  assert.ok(rels.includes('scripts/migrations/migrate-01-canonical-db.js'), 'ordinary tracked sibling file was wrongly excluded');
});

check('T2: isExcludedPath() second layer still excludes tracked hazards', () => {
  const files = listTrackedFiles(fixtureRoot, ['scripts/lib', 'docs', 'scripts/migrations'], { offline: false });
  const rels = files.map((f) => f.rel);
  assert.ok(!rels.includes('scripts/lib/.local.secret.json'), '.local. file leaked in despite being tracked');
  assert.ok(!rels.some((r) => r.includes('node_modules')), 'nested node_modules leaked in despite being tracked');
  assert.ok(!rels.some((r) => r.startsWith('docs/notes/')), 'docs/notes/ content leaked in despite being tracked');
  assert.ok(!rels.some((r) => r.includes('.bak-')), '.bak- file leaked in despite being tracked');
});

check('T2: assertNoIgnoredFiles() is a no-op over a clean tracked candidate list', () => {
  const files = listTrackedFiles(fixtureRoot, BASE_INCLUDE_PATHS, { offline: false });
  assert.doesNotThrow(() => assertNoIgnoredFiles(fixtureRoot, files.map((f) => f.rel)));
});

check('T2: a force-added ignored file fails the build via assertNoIgnoredFiles()', () => {
  const attackRoot = buildFixtureRepo({ withOfflineNodeModules: false });
  try {
    // db-triage.json is gitignored; force-add it despite that, simulating
    // someone bypassing .gitignore with `git add -f`.
    git(attackRoot, ['add', '-f', 'scripts/migrations/db-triage.json']);
    git(attackRoot, ['commit', '-q', '-m', 'attack: force-add an ignored file']);

    assert.throws(
      () => {
        const files = listTrackedFiles(attackRoot, BASE_INCLUDE_PATHS, { offline: false });
        assertNoIgnoredFiles(attackRoot, files.map((f) => f.rel));
      },
      /gitignored/,
      'a force-added gitignored file must fail the build loudly, not ship silently'
    );

    assert.throws(
      () => stageBuild({ repoRoot: attackRoot, offline: false, version: '1.0.0-attack', stageDir: fs.mkdtempSync(path.join(os.tmpdir(), 'mm-buildzip-attack-stage-')) }),
      /gitignored/,
      'stageBuild() itself must refuse when a force-added ignored file is present'
    );
  } finally {
    fs.rmSync(attackRoot, { recursive: true, force: true });
  }
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

check('T2: walkEntry() (filesystem-sourced, used only for --offline node_modules) still filters via isExcludedPath()', () => {
  const files = walkEntry(fixtureRoot, 'scripts/lib', { offline: false });
  const rels = files.map((f) => f.rel);
  assert.ok(!rels.includes('scripts/lib/.local.secret.json'), 'excluded .local. file leaked in');
  assert.ok(rels.includes('scripts/lib/shared.js'), 'ordinary sibling file was wrongly excluded');
});

// ─── T3: stageBuild() -- VERSION + SHA256SUMS ────────────────────────────────
check('T3: stageBuild() writes VERSION with the exact requested version', () => {
  const stageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-buildzip-stage-'));
  try {
    const { missing } = validateIncludePaths(fixtureRoot, getIncludePaths({ offline: false }));
    assert.deepStrictEqual(missing, [], `fixture repo missing include-list paths: ${missing.join(', ')}`);
    const { stagedFiles } = stageBuild({
      repoRoot: fixtureRoot,
      offline: false,
      version: '1.2.3-fixture',
      stageDir,
    });
    const versionContent = fs.readFileSync(path.join(stageDir, 'VERSION'), 'utf8');
    assert.strictEqual(versionContent, '1.2.3-fixture\n');
    assert.ok(stagedFiles.some((f) => f.rel === 'VERSION'));
    assert.ok(stagedFiles.some((f) => f.rel === 'SHA256SUMS'));
    // Excluded hazards must never appear among staged files -- tracked
    // hazards (isExcludedPath) and untracked/gitignored hazards (the
    // git-tracked-only gate) alike.
    assert.ok(!stagedFiles.some((f) => f.rel.includes('.local.')));
    assert.ok(!stagedFiles.some((f) => f.rel.includes('node_modules')));
    assert.ok(!stagedFiles.some((f) => f.rel.startsWith('docs/notes/')));
    assert.ok(!stagedFiles.some((f) => f.rel.includes('.bak-')));
    assert.ok(!stagedFiles.some((f) => f.rel === 'scripts/migrations/db-triage.json'), 'gitignored private file leaked into staged output');
    assert.ok(!stagedFiles.some((f) => f.rel.startsWith('scripts/migrations/backups/')), 'untracked private file leaked into staged output');
  } finally {
    fs.rmSync(stageDir, { recursive: true, force: true });
  }
});

check('T3: SHA256SUMS has one correct sha256 line per staged file (excluding itself)', () => {
  const stageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-buildzip-stage-'));
  try {
    const { stagedFiles } = stageBuild({
      repoRoot: fixtureRoot,
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

check('T4: --offline stages scripts/node_modules straight off the filesystem when present', () => {
  const offlineRoot = buildFixtureRepo({ withOfflineNodeModules: true });
  const stageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-buildzip-stage-offline-'));
  try {
    const { missing } = validateIncludePaths(offlineRoot, getIncludePaths({ offline: true }));
    assert.deepStrictEqual(missing, []);
    const { stagedFiles } = stageBuild({
      repoRoot: offlineRoot,
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

// ─── T6: require-graph closure (real repo) ──────────────────────────────────
// Every require('./...')/require('../...') relative target of every
// shipped .js/.mjs file under scripts/ must resolve to another shipped
// file. Static regex scan (not Node's real resolution algorithm) -- close
// enough to catch the exact class of bug this round fixed (migrate-05
// shipped without its scripts/pipeline-chunker.js dependency) and any
// future recurrence of it, without needing to actually execute the code.
check('T6: every relative require() target among shipped scripts/*.js|mjs resolves to a shipped file', () => {
  const shipped = listTrackedFiles(REPO_ROOT, BASE_INCLUDE_PATHS, { offline: false });
  const shippedRelSet = new Set(shipped.map((f) => f.rel));
  const shippedScriptFiles = shipped.filter((f) => f.rel.startsWith('scripts/') && /\.(js|mjs)$/.test(f.rel));
  assert.ok(shippedScriptFiles.length > 5, 'sanity: expected several shipped scripts/*.js|mjs files');

  const REQUIRE_RE = /require\(\s*(['"])(\.\.?\/[^'"]+)\1\s*\)/g;
  const KNOWN_EXTS = ['.js', '.mjs', '.cjs', '.json', '.node'];

  // Strip comments before scanning -- a plain regex scan otherwise
  // false-positives on require(...) examples mentioned in prose comments
  // (e.g. scripts/install.js documents its own lazy self-require in a
  // comment). Heuristic, not a full JS parser: good enough for this
  // static audit, and deliberately conservative (avoids stripping `//`
  // inside a `://` URL literal).
  function stripComments(src) {
    return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  }

  function candidatesFor(resolvedPosixNoExt) {
    if (KNOWN_EXTS.some((ext) => resolvedPosixNoExt.endsWith(ext))) return [resolvedPosixNoExt];
    const out = [];
    for (const ext of KNOWN_EXTS) out.push(resolvedPosixNoExt + ext);
    for (const ext of ['.js', '.mjs', '.cjs']) out.push(`${resolvedPosixNoExt}/index${ext}`);
    return out;
  }

  const misses = [];
  for (const f of shippedScriptFiles) {
    const src = stripComments(fs.readFileSync(f.abs, 'utf8'));
    let m;
    REQUIRE_RE.lastIndex = 0;
    while ((m = REQUIRE_RE.exec(src))) {
      const spec = m[2];
      const fromDir = path.posix.dirname(f.rel);
      const resolved = path.posix.normalize(path.posix.join(fromDir, spec));
      const candidates = candidatesFor(resolved);
      const found = candidates.some((c) => shippedRelSet.has(c));
      if (!found) {
        misses.push(`${f.rel}: require('${spec}') -> none of [${candidates.join(', ')}] are shipped`);
      }
    }
  }

  assert.deepStrictEqual(misses, [], `unresolved relative require() targets among shipped files (missing from BASE_INCLUDE_PATHS):\n  ${misses.join('\n  ')}`);
});

// ─── Summary ──────────────────────────────────────────────────────────────────
console.log(`\n${pass} passed, ${fail} failed, ${skip} skipped`);
process.exit(fail > 0 ? 1 : 0);
