'use strict';

/**
 * test-engine-revision.js — feat/status-engine-revision.
 *
 * Owner ruling (2026-09-13): `handoff_status` reports the engine revision
 * and schema epoch three ways — LOADED (captured once at module import: the
 * SCHEMA_EPOCH literal plus a revision stamp computed at import), DISK
 * (recomputed on every call from the engine checkout on disk), and DB (the
 * project DB's stored epoch) — and reports both loaded and disk, never one.
 * scripts/lib/engine-revision.js supplies readDiskRevision()/LOADED; this
 * suite covers its total classification plus the resulting cmdStatus fields.
 *
 * Coverage map:
 *   T1  git checkout -> source 'git', revision matches `git rev-parse --short HEAD`.
 *   T2  non-git dir with a VERSION file -> source 'version-file', revision = trimmed contents.
 *   T3  empty dir (no git, no VERSION, no manifest) -> revision 'unknown', source
 *       'unknown', schema_epoch null.
 *   T4  a dir with only schema-manifest.json (no git, no VERSION) -> schema_epoch
 *       is read correctly even though revision/source fall through to unknown.
 *   T5  LOADED (module-import snapshot) vs a fresh readDiskRevision() call differ
 *       after the checkout's VERSION file is rewritten post-import — LOADED never
 *       changes, the fresh call reflects the rewrite. Run in a child process (via
 *       CLAUDE_PLUGIN_ROOT) so LOADED's capture-at-import moment is under this
 *       test's control.
 *   T6  live `handoff.js status --json`: the `engine` object is present with
 *       loaded/disk/db/drift/remedy, loaded.source === 'git' (this repo checkout),
 *       drift === 'proceed' with remedy === null on a freshly-inited project DB.
 *
 * T1-T5 require no Postgres (filesystem/subprocess only). T6 requires Postgres
 * (same infra convention as test-index-cap-md5.js / test-schema-heal.js) and is
 * skipped with a clear reason if unreachable.
 *
 * Exit 0 = all run tests passed.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const { readDiskRevision } = require(path.join(PROJECT_ROOT, 'scripts', 'lib', 'engine-revision.js'));
const { copySchemaUnits } = require(path.join(__dirname, 'lib', 'scratch-engine-root.js'));
const {
  pgConnect,
  createDb,
  dropDb,
  runHandoff,
  resolveProjectId,
  cleanupHandoffMd,
  setupProject,
} = require(path.join(PROJECT_ROOT, 'scripts', 'lib', 'test-pg-helpers'));

let passed = 0;
let failed = 0;
let skipped = 0;
const failures = [];
function pass(label) { console.log(`PASS  ${label}`); passed++; }
function fail(label, reason) { console.log(`FAIL  ${label}: ${reason}`); failures.push({ label, reason }); failed++; }
function skip(label, reason) { console.log(`SKIP  ${label} (${reason})`); skipped++; }
function assertEqual(a, b, msg) { if (a !== b) throw new Error(msg || `expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); }

// ── Scratch engine roots ─────────────────────────────────────────────────────

function makeScratchRoot(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `engine-rev-${prefix}-`));
}

function gitInitCommit(root) {
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'test'], { cwd: root });
  execFileSync('git', ['add', '-A'], { cwd: root });
  execFileSync('git', ['commit', '-q', '-m', 'scratch'], { cwd: root });
  return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: root }).toString('utf8').trim();
}

// ── T1: git checkout ──────────────────────────────────────────────────────────

function testT1_GitCheckout() {
  const label = 'T1 git checkout -> source git, revision matches rev-parse --short HEAD';
  const root = makeScratchRoot('t1');
  try {
    copySchemaUnits(PROJECT_ROOT, root);
    const sha = gitInitCommit(root);
    const result = readDiskRevision(root);
    assertEqual(result.source, 'git', 'source');
    assertEqual(result.revision, sha, 'revision');
    assertEqual(result.schema_epoch, 5, 'schema_epoch (this repo\'s manifest)');
    pass(label);
  } catch (err) {
    fail(label, err.message);
  } finally {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) {}
  }
}

// ── T2: VERSION file, no git ──────────────────────────────────────────────────

function testT2_VersionFileNoGit() {
  const label = 'T2 non-git dir with VERSION -> source version-file, revision = trimmed contents';
  const root = makeScratchRoot('t2');
  try {
    copySchemaUnits(PROJECT_ROOT, root);
    fs.writeFileSync(path.join(root, 'VERSION'), '  1.2.3-scratch  \n');
    const result = readDiskRevision(root);
    assertEqual(result.source, 'version-file', 'source');
    assertEqual(result.revision, '1.2.3-scratch', 'revision (trimmed)');
    assertEqual(result.schema_epoch, 5, 'schema_epoch');
    pass(label);
  } catch (err) {
    fail(label, err.message);
  } finally {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) {}
  }
}

// ── T3: empty dir -> unknown/unknown/null ────────────────────────────────────

function testT3_EmptyDirUnknown() {
  const label = 'T3 empty dir -> revision unknown, source unknown, schema_epoch null';
  const root = makeScratchRoot('t3');
  try {
    const result = readDiskRevision(root);
    assertEqual(result.source, 'unknown', 'source');
    assertEqual(result.revision, 'unknown', 'revision');
    assertEqual(result.schema_epoch, null, 'schema_epoch');
    pass(label);
  } catch (err) {
    fail(label, err.message);
  } finally {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) {}
  }
}

// ── T4: manifest present, no git/VERSION -> epoch known, revision unknown ────

function testT4_ManifestOnlyNoRevisionSignal() {
  const label = 'T4 manifest-only dir (no git, no VERSION) -> schema_epoch known, revision unknown';
  const root = makeScratchRoot('t4');
  try {
    copySchemaUnits(PROJECT_ROOT, root);
    const result = readDiskRevision(root);
    assertEqual(result.source, 'unknown', 'source');
    assertEqual(result.revision, 'unknown', 'revision');
    assertEqual(result.schema_epoch, 5, 'schema_epoch');
    pass(label);
  } catch (err) {
    fail(label, err.message);
  } finally {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) {}
  }
}

// ── T5: LOADED (frozen at import) vs a fresh disk read after a post-import
//        VERSION rewrite. Run as a child process so this test controls
//        exactly what CLAUDE_PLUGIN_ROOT (and therefore the child's own
//        module-import-time LOADED) points at. ────────────────────────────

function testT5_LoadedVsDiskDrift() {
  const label = 'T5 LOADED (import-time) never changes; a fresh readDiskRevision() call reflects a post-import VERSION rewrite';
  const root = makeScratchRoot('t5');
  const childScript = path.join(root, '__child.js');
  try {
    copySchemaUnits(PROJECT_ROOT, root);
    fs.writeFileSync(path.join(root, 'VERSION'), 'v1\n');

    const engineRevisionPath = path.join(PROJECT_ROOT, 'scripts', 'lib', 'engine-revision.js');
    fs.writeFileSync(
      childScript,
      [
        `const fs = require('fs');`,
        `const path = require('path');`,
        `const { readDiskRevision, LOADED } = require(${JSON.stringify(engineRevisionPath)});`,
        `const root = ${JSON.stringify(root)};`,
        // Rewrite VERSION AFTER LOADED was already captured at require()-time above.
        `fs.writeFileSync(path.join(root, 'VERSION'), 'v2\\n');`,
        `const fresh = readDiskRevision(root);`,
        `process.stdout.write(JSON.stringify({ loaded: LOADED, fresh }));`,
      ].join('\n')
    );

    const r = spawnSync(process.execPath, [childScript], {
      cwd: root,
      env: { ...process.env, CLAUDE_PLUGIN_ROOT: root },
      encoding: 'utf8',
      timeout: 15000,
    });
    if (r.status !== 0) {
      throw new Error(`child exited ${r.status}. stderr: ${r.stderr}`);
    }
    const { loaded, fresh } = JSON.parse(r.stdout);
    assertEqual(loaded.revision, 'v1', 'LOADED.revision must be the pre-rewrite snapshot');
    assertEqual(fresh.revision, 'v2', 'fresh readDiskRevision() must reflect the rewrite');
    if (loaded.revision === fresh.revision) {
      throw new Error('loaded and fresh must differ after the post-import rewrite');
    }
    pass(label);
  } catch (err) {
    fail(label, err.message);
  } finally {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) {}
  }
}

// ── T6: live status --json ────────────────────────────────────────────────────

async function testT6_StatusJsonEngineField() {
  const label = 'T6 handoff.js status --json includes engine.{loaded,disk,db,drift,remedy}';
  const TS = Date.now();
  const dbName = `claude_memory_enginerev_${TS}`;
  const projectDir = path.join(os.tmpdir(), `enginerev_${TS}`);
  let projectId;
  try {
    await createDb(dbName, projectDir);
    projectId = await setupProject(dbName, projectDir);

    const r = runHandoff('status', ['--json'], null, dbName, projectDir);
    if (r.status !== 0) {
      fail(label, `status exited ${r.status}. stderr: ${r.stderr}`);
      return;
    }
    const start = r.stdout.indexOf('{');
    const end = r.stdout.lastIndexOf('}');
    const out = JSON.parse(r.stdout.slice(start, end + 1));

    if (typeof out.engine !== 'object' || out.engine === null) {
      throw new Error(`expected out.engine to be an object, got ${JSON.stringify(out.engine)}`);
    }
    for (const key of ['loaded', 'disk', 'db', 'drift', 'remedy']) {
      if (!(key in out.engine)) throw new Error(`engine.${key} missing from status --json output`);
    }
    for (const half of ['loaded', 'disk']) {
      for (const field of ['schema_epoch', 'revision', 'source']) {
        if (!(field in out.engine[half])) {
          throw new Error(`engine.${half}.${field} missing from status --json output`);
        }
      }
    }
    if (!('schema_epoch' in out.engine.db)) {
      throw new Error('engine.db.schema_epoch missing from status --json output');
    }
    assertEqual(out.engine.loaded.source, 'git', 'engine.loaded.source (this repo checkout is a git checkout)');
    assertEqual(out.engine.disk.source, 'git', 'engine.disk.source');
    // A freshly-inited project DB, touched by a checkout-consistent engine,
    // must classify as 'proceed' with no remedy text.
    assertEqual(out.engine.drift, 'proceed', 'engine.drift on a freshly-inited, checkout-consistent DB');
    assertEqual(out.engine.remedy, null, 'engine.remedy on the proceed branch');

    pass(label);
  } catch (err) {
    fail(label, err.message);
  } finally {
    if (projectId) cleanupHandoffMd(projectId);
    await dropDb(dbName, projectDir);
  }
}

// ── Main ───────────────────────────────────────────────────────────────────────

async function main() {
  console.log('=== feat/status-engine-revision tests ===\n');

  testT1_GitCheckout();
  testT2_VersionFileNoGit();
  testT3_EmptyDirUnknown();
  testT4_ManifestOnlyNoRevisionSignal();
  testT5_LoadedVsDiskDrift();

  let pgAvail = false;
  try {
    const probe = await pgConnect('postgres');
    await probe.end();
    pgAvail = true;
  } catch (err) {
    skip('T6 handoff.js status --json engine field', `Postgres not available: ${err.message}`);
  }
  if (pgAvail) {
    await testT6_StatusJsonEngineField();
  }

  console.log(`\n=== Results: ${passed} passed, ${failed} failed, ${skipped} skipped ===`);
  if (failures.length > 0) {
    console.log('\nFailures:');
    for (const f of failures) console.log(`  FAIL  ${f.label}: ${f.reason}`);
    process.exit(1);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error(`[FATAL] test runner crashed: ${err.stack || err.message}`);
  process.exit(1);
});
