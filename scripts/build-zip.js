'use strict';

/**
 * scripts/build-zip.js -- build the distributable
 * dist/memory-manager-<version>.zip from an explicit, hand-maintained
 * include list (never a directory glob of the whole repo). See
 * docs/specs/package-and-installer.md section 1 for the DRAFT contents
 * spec this list is derived from (one deliberate deviation: docker-
 * compose.yml/.env.example ship nested under deploy/, matching this
 * repo's actual deploy/ directory, not flattened to the zip root as that
 * DRAFT text shows).
 *
 * CommonJS, Node >=18, zero new dependencies. Archiving shells out to a
 * platform archiver detected at runtime: `tar -a -c -f` on win32 (bsdtar
 * ships with Windows 10+ as C:\Windows\System32\tar.exe and auto-detects
 * zip format from the .zip extension via -a) and `zip -r` elsewhere. A
 * missing archiver is a clear, named error -- never a silent no-op.
 *
 * Usage:
 *   node scripts/build-zip.js [--version <v>] [--offline] [--out-dir <dir>]
 *
 * Flags:
 *   --version   Version string to stamp into VERSION and the zip filename.
 *               Defaults to scripts/package.json's "version" field.
 *   --offline   Also stage scripts/node_modules into the zip (for the
 *               offline-install variant). Refuses loudly if
 *               scripts/node_modules does not exist -- this flag never
 *               silently produces an offline zip missing its dependencies.
 *   --out-dir   Directory the zip is written to. Defaults to <repo>/dist.
 *
 * Testability: getIncludePaths(), isExcludedPath(), validateIncludePaths(),
 * resolveVersion(), stageBuild(), and computeShaSums() are pure/side-
 * effect-scoped functions exported below for unit testing (see
 * test/test-build-zip.js) against synthetic fixture trees -- requiring
 * this module never touches argv/cwd/process.exit; main() only runs when
 * this file is executed directly.
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '..');

// ─── Explicit include list ──────────────────────────────────────────────────
// Every entry is a path relative to the repo root. A directory entry means
// "include this directory recursively, filtered by isExcludedPath()".
// Adding a new top-level shippable path requires a deliberate edit here --
// that is the entire point of an explicit list over a glob: nothing new
// ships silently just because someone added a file next to an existing one.
const BASE_INCLUDE_PATHS = [
  'LICENSE',
  'README.md',
  'QUICKSTART.md',
  'PREREQS.md',
  'CHANGELOG.md',
  'install.cmd',
  'install.sh',
  'commands',
  'hooks',
  'templates',
  'docs',
  'deploy',
  'scripts/install.js',
  'scripts/handoff.js',
  'scripts/handoff-mcp.mjs',
  'scripts/handoff-mcp-selftest.mjs',
  'scripts/init-config.js',
  'scripts/lib',
  'scripts/sql',
  'scripts/migrations',
  'scripts/package.json',
  'scripts/package-lock.json',
  'scripts/pnpm-lock.yaml',
];

const OFFLINE_EXTRA_PATHS = ['scripts/node_modules'];

function getIncludePaths({ offline = false } = {}) {
  return offline ? [...BASE_INCLUDE_PATHS, ...OFFLINE_EXTRA_PATHS] : [...BASE_INCLUDE_PATHS];
}

// ─── Exclusion rules (total classification within an included directory) ───
// Anything NOT matched here is included by default -- that default branch
// is intentional (this is a curated allow-list of top-level paths already;
// within an included directory we exclude the specific, named hazards
// rather than re-deriving an inner allow-list). Checked against the
// path's basename and its full repo-relative path (forward-slash
// normalized) at every directory-walk step, so nested occurrences (e.g.
// docs/notes/, any node_modules/ that isn't the offline top-level one) are
// caught too.
function isExcludedPath(relPath, { offline = false } = {}) {
  const norm = relPath.split(path.sep).join('/');
  const base = norm.split('/').pop();

  if (base === '.git' || base === '.claude') return true;
  if (base === 'node_modules') {
    // Only the single top-level scripts/node_modules is ever included,
    // and only under --offline; any other node_modules (nested inside a
    // dependency, say) is always excluded.
    return !(offline && norm === 'scripts/node_modules');
  }
  if (base.includes('.local.')) return true;
  if (base === '.env' || (base.startsWith('.env.') && base !== '.env.example')) return true;
  if (base.startsWith('.bak-') || /\.bak-/.test(base)) return true;
  if (norm === 'docs/notes' || norm.startsWith('docs/notes/')) return true;

  // Private local planning docs (per this repo's own CLAUDE.md / .gitignore)
  // -- named explicitly rather than inferred, since they are root-anchored
  // and gitignored but could in principle be present in a working tree.
  const RUNBOOK_NAMES = new Set([
    'CONSOLIDATION-RUNBOOK.md',
    'RUNBOOK-INDEX.md',
    'START-HERE-CONSOLIDATION.md',
  ]);
  if (RUNBOOK_NAMES.has(base) || /^FIELD-REPORT-.*\.md$/.test(base)) return true;

  return false;
}

// ─── Directory walk ──────────────────────────────────────────────────────────
// Returns a flat list of { abs, rel } for every file under `entry`
// (relative to repoRoot), applying isExcludedPath() at every level so an
// excluded directory is never descended into.
function walkEntry(repoRoot, entry, { offline = false } = {}) {
  const absEntry = path.join(repoRoot, entry);
  const st = fs.statSync(absEntry);
  const out = [];

  function walk(absDir, relDir) {
    for (const name of fs.readdirSync(absDir).sort()) {
      const abs = path.join(absDir, name);
      const rel = relDir ? `${relDir}/${name}` : name;
      if (isExcludedPath(rel, { offline })) continue;
      const s = fs.statSync(abs);
      if (s.isDirectory()) {
        walk(abs, rel);
      } else if (s.isFile()) {
        out.push({ abs, rel });
      }
    }
  }

  if (st.isDirectory()) {
    if (isExcludedPath(entry, { offline })) return out;
    walk(absEntry, entry);
  } else if (st.isFile()) {
    if (!isExcludedPath(entry, { offline })) out.push({ abs: absEntry, rel: entry });
  }
  return out;
}

// ─── Include-list validation ────────────────────────────────────────────────
// "refuses to run if the include list contains a path that does not
// exist" -- every entry is checked up front, and ALL missing entries are
// reported together (never fail-fast on the first one), matching the
// total-classification-over-allow-list discipline used elsewhere in this
// repo's own migration scripts.
function validateIncludePaths(repoRoot, includePaths) {
  const missing = [];
  for (const entry of includePaths) {
    const abs = path.join(repoRoot, entry);
    if (!fs.existsSync(abs)) missing.push(entry);
  }
  return { missing, ok: missing.length === 0 };
}

// ─── Version resolution ─────────────────────────────────────────────────────
function resolveVersion({ versionFlag, repoRoot } = {}) {
  if (versionFlag && String(versionFlag).trim()) return String(versionFlag).trim();
  const pkgPath = path.join(repoRoot, 'scripts', 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  if (!pkg.version || typeof pkg.version !== 'string') {
    throw new Error(`build-zip: scripts/package.json has no usable "version" field (${pkgPath})`);
  }
  return pkg.version;
}

// ─── SHA256SUMS ──────────────────────────────────────────────────────────────
// sha256 of every staged file (forward-slash relative paths, sorted for
// determinism), excluding SHA256SUMS itself (it cannot hash itself).
function computeShaSums(stagedFiles) {
  const lines = stagedFiles
    .filter((f) => f.rel !== 'SHA256SUMS')
    .map((f) => {
      const buf = fs.readFileSync(f.abs);
      const hash = crypto.createHash('sha256').update(buf).digest('hex');
      return `${hash}  ${f.rel}`;
    })
    .sort();
  return lines.join('\n') + '\n';
}

// ─── Staging ─────────────────────────────────────────────────────────────────
// Copies every included, non-excluded file into a fresh staging directory,
// then writes VERSION and SHA256SUMS at the staging root. Returns
// { stageDir, stagedFiles } where stagedFiles includes VERSION and
// SHA256SUMS themselves. Pure side effect (filesystem only) -- no
// archiving here, so tests can assert on staged content without needing a
// working platform archiver.
function stageBuild({ repoRoot, includePaths, offline, version, stageDir }) {
  const files = [];
  for (const entry of includePaths) {
    for (const f of walkEntry(repoRoot, entry, { offline })) {
      files.push(f);
    }
  }

  // De-dupe (two include entries should never overlap, but never trust
  // that silently -- collapse rather than double-copy/double-hash).
  const seen = new Map();
  for (const f of files) seen.set(f.rel, f);
  const uniqueFiles = [...seen.values()].sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));

  fs.mkdirSync(stageDir, { recursive: true });
  for (const f of uniqueFiles) {
    const dest = path.join(stageDir, f.rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(f.abs, dest);
  }

  const versionPath = path.join(stageDir, 'VERSION');
  fs.writeFileSync(versionPath, version + '\n', 'utf8');
  const stagedFiles = [...uniqueFiles, { abs: versionPath, rel: 'VERSION' }];

  const shaSumsContent = computeShaSums(stagedFiles);
  const shaSumsPath = path.join(stageDir, 'SHA256SUMS');
  fs.writeFileSync(shaSumsPath, shaSumsContent, 'utf8');
  stagedFiles.push({ abs: shaSumsPath, rel: 'SHA256SUMS' });

  return { stageDir, stagedFiles };
}

// ─── Archiving ───────────────────────────────────────────────────────────────
function findArchiver() {
  if (process.platform === 'win32') {
    const probe = spawnSync('tar', ['--version'], { stdio: 'ignore', shell: false });
    if (probe.error) {
      throw new Error(
        'build-zip: no archiver found on PATH. Windows requires tar.exe ' +
          '(bsdtar, ships with Windows 10+ at C:\\Windows\\System32\\tar.exe). ' +
          'Ensure System32 is on PATH ahead of any MSYS/Git-for-Windows tar.'
      );
    }
    return 'win32-tar';
  }
  const probe = spawnSync('zip', ['-v'], { stdio: 'ignore', shell: false });
  if (probe.error) {
    throw new Error(
      'build-zip: no archiver found on PATH. Install `zip` (e.g. ' +
        '`apt-get install zip` / `brew install zip`) and re-run.'
    );
  }
  return 'posix-zip';
}

function archive(zipPath, stageDir) {
  fs.mkdirSync(path.dirname(zipPath), { recursive: true });
  if (fs.existsSync(zipPath)) fs.rmSync(zipPath);

  const entries = fs.readdirSync(stageDir).sort();
  const archiver = findArchiver();

  let res;
  if (archiver === 'win32-tar') {
    res = spawnSync('tar', ['-a', '-c', '-f', zipPath, ...entries], { cwd: stageDir, stdio: 'inherit' });
  } else {
    res = spawnSync('zip', ['-r', '-q', zipPath, ...entries], { cwd: stageDir, stdio: 'inherit' });
  }
  if (res.error) throw res.error;
  if (res.status !== 0) {
    throw new Error(`build-zip: archiver exited with status ${res.status}`);
  }
  return zipPath;
}

// ─── Orchestration ───────────────────────────────────────────────────────────
function buildZip({ repoRoot = REPO_ROOT, versionFlag, offline = false, outDir } = {}) {
  const includePaths = getIncludePaths({ offline });

  const { missing, ok } = validateIncludePaths(repoRoot, includePaths);
  if (!ok) {
    throw new Error(
      `build-zip: refusing to run -- the include list names ${missing.length} ` +
        `path(s) that do not exist on disk:\n  ${missing.join('\n  ')}`
    );
  }

  const version = resolveVersion({ versionFlag, repoRoot });
  const resolvedOutDir = outDir || path.join(repoRoot, 'dist');
  const zipName = `memory-manager-${version}${offline ? '-offline' : ''}.zip`;
  const zipPath = path.join(resolvedOutDir, zipName);

  const stageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-build-zip-'));
  try {
    const { stagedFiles } = stageBuild({ repoRoot, includePaths, offline, version, stageDir });
    archive(zipPath, stageDir);
    return { zipPath, version, stagedFiles, stageDir };
  } finally {
    fs.rmSync(stageDir, { recursive: true, force: true });
  }
}

// ─── CLI ─────────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const args = { offline: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--version') {
      args.versionFlag = argv[++i];
    } else if (a === '--offline') {
      args.offline = true;
    } else if (a === '--out-dir') {
      args.outDir = argv[++i];
    } else if (a === '--help' || a === '-h') {
      args.help = true;
    } else {
      throw new Error(`build-zip: unrecognized argument "${a}"`);
    }
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(
      'Usage: node scripts/build-zip.js [--version <v>] [--offline] [--out-dir <dir>]'
    );
    process.exit(0);
  }
  const result = buildZip({
    versionFlag: args.versionFlag,
    offline: args.offline,
    outDir: args.outDir ? path.resolve(args.outDir) : undefined,
  });
  console.log(`Built ${result.zipPath} (${result.stagedFiles.length} files, version ${result.version})`);
}

module.exports = {
  REPO_ROOT,
  getIncludePaths,
  isExcludedPath,
  walkEntry,
  validateIncludePaths,
  resolveVersion,
  computeShaSums,
  stageBuild,
  archive,
  findArchiver,
  buildZip,
  parseArgs,
};

if (require.main === module) {
  try {
    main();
  } catch (err) {
    console.error(err.message || err);
    process.exit(1);
  }
}
