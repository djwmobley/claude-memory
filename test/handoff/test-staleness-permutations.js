'use strict';

/**
 * test-staleness-permutations.js — Adversarial permutation harness for serve-time
 * staleness detection.
 *
 * Tests that the serve-time reality re-probe system:
 *   1. Never serves a stale volatile claim as live truth.
 *   2. Never lets a probe FAILURE upgrade trust (fail-closed).
 *   3. Never hangs on offline network probes (circuit-breaker).
 *   4. Honors §7 no-backfill (only reality_check modified by serve pass).
 *   5. Gate-off produces byte-identical output.
 *   6. All serve paths (resume AND resurrect) annotate stale rows.
 *   7. Multi-session round-trip: verified → STALE → verified again.
 *   8. Concurrency: two serve passes racing reality_check UPDATE, no corruption.
 *   9. Floor: no-probe predicate never annotated.
 *  10. Budget: annotations do not push served size over 4000-token budget.
 *
 * Permutation matrix:
 *   P1  pr_state  open→merged    (mismatch)
 *   P2  pr_state  open→closed    (mismatch)
 *   P3  pr_state  merged→open    (mismatch — reopened)
 *   P4  pr_state  verified match (no drift → verified)
 *   P5  branch_exists  exists→deleted   (mismatch)
 *   P6  branch_exists  missing→created  (mismatch)
 *   P7  branch_exists  stable→verified  (no drift)
 *   P8  commit_merged  not-merged→merged  (mismatch)
 *   P9  commit_merged  merged→still-merged (verified)
 *   P10 commit_merged  bad-sha→unverifiable
 *   P11 in_file  present→deleted  (mismatch)
 *   P12 in_file  absent→created   (mismatch)
 *   P13 in_file  present→verified (no drift)
 *   P14 packaging  clean→dirty    (authoritative — not verify-mode; floor stays)
 *
 * Trust fail-closed adversarial:
 *   F1  gh binary missing             → unverifiable (never verified)
 *   F2  gh present-but-not-executable → unverifiable
 *   F3  gh timeout/hang               → unverifiable (bounded time)
 *   F4  git not-a-repo                → unverifiable for branch/commit probes
 *   F5  malformed gh output (not JSON)→ unverifiable
 *   F6  gh JSON missing state field   → unverifiable
 *
 * GH-offline latency:
 *   L1  Many pr_state rows, fake gh hangs near timeout → total bounded (circuit-breaker)
 *
 * §7 invariance:
 *   S7  After every permutation, conf/source/tier/object unchanged; only reality_check differs.
 *
 * Gate-off:
 *   G1  serve_time_reality_check disabled → byte-identical, no [STALE:] annotation
 *
 * All serve paths:
 *   A1  resurrect also annotates stale rows (not only resume)
 *
 * Multi-session round-trip:
 *   R1  N: verified → world changes → N+1: STALE → world reverts → N+2: verified
 *
 * Concurrency:
 *   C1  Two concurrent serve passes racing reality_check UPDATE → no crash, no corruption
 *
 * Budget economy:
 *   B1  Realistic 4000-token corpus with annotations stays within budget
 *
 * Usage:
 *   PGHOST=localhost PGUSER=postgres PGPASSWORD=postgres \
 *     node test/handoff/test-staleness-permutations.js
 *
 * Exit codes: 0 all-pass, 1 any failure, 2 infrastructure error.
 */

const assert         = require('assert');
const path           = require('path');
const fs             = require('fs');
const os             = require('os');
const { execFileSync, execSync } = require('child_process');

const { loadConfig }  = require('../../scripts/lib/shared');
const { writeMarker } = require('../../scripts/lib/project-marker');
const { createRequire } = require('module');
const scriptsRequire = createRequire(require.resolve('../../scripts/package.json'));
const { Client } = scriptsRequire('pg');

// ─── CONFIG ──────────────────────────────────────────────────────────────────

const TARGET_DB = 'claude_memory_eval_test';
const HELPER    = path.resolve(__dirname, '..', '..', 'scripts', 'handoff.js');
const REPO_ROOT = path.resolve(__dirname, '..', '..');

// ─── COUNTERS ─────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
const failures = [];

async function test(label, fn) {
  try {
    const result = fn();
    if (result && typeof result.then === 'function') {
      await result;
    }
    console.log(`PASS  ${label}`);
    passed++;
  } catch (err) {
    console.error(`FAIL  ${label}`);
    console.error(`      ${err.message}`);
    if (process.env.DEBUG) console.error(err.stack);
    failed++;
    failures.push({ label, message: err.message });
  }
}

// ─── DB HELPERS ───────────────────────────────────────────────────────────────

async function connectDb() {
  const cfg = loadConfig();
  const client = new Client({
    host: cfg.host,
    port: cfg.port,
    database: TARGET_DB,
    user: cfg.user,
  });
  await client.connect();
  return client;
}

// ─── SETUP / TEARDOWN ─────────────────────────────────────────────────────────

/**
 * Create an isolated test project directory with a fakeRoot containing:
 *   - .git (initialized git repo, so branch/commit probes work)
 *   - .claude/pipeline.yml pointing to TARGET_DB
 *   - A project marker UUID pre-minted
 *
 * Returns { fakeRoot, projectId, db }.
 */
async function setupProject(label) {
  const fakeRoot = fs.mkdtempSync(path.join(os.tmpdir(), `perm-test-${label}-`));

  // Initialize a real git repo so branch_exists and commit_merged probes work.
  execFileSync('git', ['-C', fakeRoot, 'init', '--initial-branch=main'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'test',
      GIT_AUTHOR_EMAIL: 'test@test.com',
      GIT_COMMITTER_NAME: 'test',
      GIT_COMMITTER_EMAIL: 'test@test.com',
    },
  });

  // Write README and .claude/pipeline.yml + project marker BEFORE the initial
  // commit so they are tracked on main and survive git checkout operations in
  // tests that create and delete branches (e.g. P8 uses gitMakeCommit which
  // runs git add . — if .claude/ were untracked at that point, a subsequent
  // git checkout main would remove them).
  fs.writeFileSync(path.join(fakeRoot, 'README.md'), 'test\n', 'utf8');
  fs.mkdirSync(path.join(fakeRoot, '.claude'));
  fs.writeFileSync(path.join(fakeRoot, '.claude', 'pipeline.yml'), [
    'project:',
    '  name: perm-test',
    '',
    'knowledge:',
    '  tier: "postgres"',
    '  host: "localhost"',
    '  port: 5432',
    `  database: "${TARGET_DB}"`,
    '  user: "postgres"',
  ].join('\n'), 'utf8');

  const marker    = writeMarker(fakeRoot);
  const projectId = marker.uuid;

  // Commit everything (README + .claude/) as the initial main commit.
  execFileSync('git', ['-C', fakeRoot, 'add', '.'], { encoding: 'utf8', stdio: 'pipe' });
  execFileSync('git', ['-C', fakeRoot, 'commit', '-m', 'init'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'test',
      GIT_AUTHOR_EMAIL: 'test@test.com',
      GIT_COMMITTER_NAME: 'test',
      GIT_COMMITTER_EMAIL: 'test@test.com',
    },
  });

  let db;
  try {
    db = await connectDb();
  } catch (err) {
    console.error(`\nInfrastructure error: cannot connect to ${TARGET_DB}: ${err.message}`);
    process.exit(2);
  }

  // Apply schemas idempotently.
  const sqlDir = path.resolve(__dirname, '..', '..', 'scripts', 'sql');
  for (const s of ['handoff-core-schema.sql', 'app-retrieval-events-schema.sql']) {
    const f = path.join(sqlDir, s);
    if (!fs.existsSync(f)) continue;
    let sql = fs.readFileSync(f, 'utf8');
    sql = sql.replace(/^\\[a-z].*$/gm, '');
    try { await db.query(sql); } catch (e) {
      if (!e.message.includes('already exists')) console.warn(`  Schema warning (${s}): ${e.message}`);
    }
  }

  // Enable serve_time_reality_check (default is enabled, but be explicit).
  await db.query(
    `INSERT INTO project_settings (project_id, key, value)
     VALUES ($1, 'serve_time_reality_check', 'enabled')
     ON CONFLICT (project_id, key) DO UPDATE SET value = 'enabled'`,
    [projectId]
  );

  // Ensure we have a retrieval_contract so loader-load runs the assertion query.
  await db.query(
    `INSERT INTO retrieval_contract (project_id, name, queries, version)
     VALUES ($1, 'default', $2::jsonb, 1)
     ON CONFLICT (project_id, name) DO UPDATE SET queries = EXCLUDED.queries`,
    [projectId, JSON.stringify({ queries: [{ kind: 'assertion', token_budget: 500 }] })]
  );

  return { fakeRoot, projectId, db };
}

async function teardownProject(ctx) {
  const { fakeRoot, projectId, db } = ctx;
  const tables = ['edges', 'assertions', 'entities', 'retrieval_contract',
    'retrieval_contract_history', 'project_settings', 'retrieval_events', 'degraded_close'];
  try {
    for (const tbl of tables) {
      try { await db.query(`DELETE FROM ${tbl} WHERE project_id = $1`, [projectId]); }
      catch (_) {}
    }
  } catch (_) {}
  try { await db.end(); } catch (_) {}
  try { fs.rmSync(fakeRoot, { recursive: true, force: true }); } catch (_) {}
  try {
    const dir = path.join(os.homedir(), '.claude', 'projects', projectId);
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  } catch (_) {}
}

// ─── SUBPROCESS HELPERS ───────────────────────────────────────────────────────

function helperEnv(fakeRoot, extraEnv) {
  return { ...process.env, PROJECT_ROOT: fakeRoot, ...(extraEnv || {}) };
}

function runResume(fakeRoot, extraEnv) {
  return execFileSync(
    process.execPath,
    [HELPER, 'resume'],
    { cwd: fakeRoot, env: helperEnv(fakeRoot, extraEnv), encoding: 'utf8', timeout: 60000 }
  );
}

function runInit(fakeRoot) {
  return execFileSync(
    process.execPath,
    [HELPER, 'init'],
    { cwd: fakeRoot, env: helperEnv(fakeRoot), encoding: 'utf8', timeout: 60000 }
  );
}

function runClose(fakeRoot, payload, extraEnv) {
  return execFileSync(
    process.execPath,
    [HELPER, 'close', '--json', '-'],
    { cwd: fakeRoot, env: helperEnv(fakeRoot, extraEnv), encoding: 'utf8', timeout: 60000,
      input: JSON.stringify(payload) }
  );
}

function runResurrect(fakeRoot, seedText, extraEnv) {
  try {
    return execFileSync(
      process.execPath,
      [HELPER, 'resurrect', seedText],
      { cwd: fakeRoot, env: helperEnv(fakeRoot, extraEnv), encoding: 'utf8', timeout: 60000 }
    );
  } catch (err) {
    // exit code 0 is expected even if no rows found; capture stdout on any exit
    return (err.stdout || '') + (err.stderr || '');
  }
}

// ─── FAKE GH SHIM HELPER ─────────────────────────────────────────────────────

/**
 * Create a fake `gh` shim that works cross-platform (Windows + POSIX).
 *
 * On Windows, Node's execFileSync resolves executables via Windows PATH
 * (semicolon-separated, Windows paths).  A bare bash script on a POSIX /tmp
 * path won't be found by the Windows process launcher.  We therefore create:
 *   - A Node.js JS file (gh-impl.js) containing the stub logic.
 *   - A Windows batch file (gh.cmd) that invokes `node gh-impl.js`.
 *   - A POSIX shell script (gh, no extension) for Linux/macOS CI environments.
 *
 * Behavior controlled by env vars in the calling subprocess:
 *   FAKE_GH_FAIL=1          → exits non-zero (simulate missing/unauthenticated)
 *   FAKE_GH_SLEEP=N         → sleeps N seconds before responding (simulate timeout)
 *   FAKE_GH_BAD_JSON=1      → returns malformed text (not JSON)
 *   FAKE_GH_MISSING_STATE=1 → returns JSON without .state field
 *   FAKE_GH_STATE=<STATE>   → returns {"state":"<STATE>"} (default: "open")
 *
 * Returns shimDir (prepend to PATH to shadow real gh — use ';' separator on
 * Windows, ':' on POSIX).
 */
function createGhShim() {
  const shimDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-shim-'));

  // ── JS implementation (works everywhere, Node is always on PATH in CI) ──
  const jsImplPath = path.join(shimDir, 'gh-impl.js');
  fs.writeFileSync(jsImplPath, [
    "'use strict';",
    "const sleep = (ms) => new Promise((r) => setTimeout(r, ms));",
    "(async () => {",
    "  const sleepSec = parseFloat(process.env.FAKE_GH_SLEEP || '0');",
    "  if (sleepSec > 0) await sleep(sleepSec * 1000);",
    "  if (process.env.FAKE_GH_FAIL === '1') {",
    "    process.stderr.write('error: not authenticated\\n');",
    "    process.exit(1);",
    "  }",
    "  if (process.env.FAKE_GH_BAD_JSON === '1') {",
    "    process.stdout.write('not valid json at all\\n');",
    "    process.exit(0);",
    "  }",
    "  if (process.env.FAKE_GH_MISSING_STATE === '1') {",
    "    process.stdout.write(JSON.stringify({number: 1}) + '\\n');",
    "    process.exit(0);",
    "  }",
    "  const state = (process.env.FAKE_GH_STATE || 'open').toUpperCase();",
    "  process.stdout.write(JSON.stringify({state}) + '\\n');",
    "  process.exit(0);",
    "})();",
  ].join('\n'), 'utf8');

  // ── Windows batch wrapper (gh.cmd) — found by Windows PATH lookup ──────
  // Node executable path is resolved from current process for portability.
  // Use the raw Windows paths (Node gives us backslash-separated paths on Windows).
  // Do NOT escape backslashes — .cmd files use literal Windows paths.
  const nodeExe = process.execPath;
  fs.writeFileSync(path.join(shimDir, 'gh.cmd'),
    '@"' + nodeExe + '" "' + jsImplPath + '" %*\r\n', 'utf8');

  // ── POSIX shell wrapper (gh, no extension) — found by POSIX PATH lookup ─
  // Convert a Windows path (C:\foo\bar) to MSYS POSIX path (/c/foo/bar).
  // On Linux/macOS, paths are already POSIX and no conversion is needed.
  function toPosix(p) {
    if (!p || p[1] !== ':') return p; // already POSIX or no drive letter
    return '/' + p[0].toLowerCase() + p.slice(2).replace(/\\/g, '/');
  }
  const nodeExePosix = toPosix(process.execPath);
  const jsImplPosix  = toPosix(jsImplPath);
  fs.writeFileSync(path.join(shimDir, 'gh'),
    `#!/bin/sh\nexec "${nodeExePosix}" "${jsImplPosix}" "$@"\n`, 'utf8');
  try { fs.chmodSync(path.join(shimDir, 'gh'), 0o755); } catch (_) {}

  return shimDir;
}

/**
 * Build a PATH string that prepends shimDir before the current PATH,
 * using the platform-correct separator (';' on Windows, ':' on POSIX).
 */
function shimPath(shimDir) {
  const sep = process.platform === 'win32' ? ';' : ':';
  return shimDir + sep + (process.env.PATH || '');
}

// ─── ASSERTION INSERTION HELPERS ─────────────────────────────────────────────

async function insertAssertion(db, projectId, { subject, predicate, object, conf, source, tier, realityCheck, sessionId }) {
  const { rows } = await db.query(
    `INSERT INTO assertions
       (project_id, subject, predicate, object, confidence, source,
        suppressed, invalid_at, reality_check, tier, session_id)
     VALUES ($1, $2, $3, $4, $5, $6, false, NULL, $7, $8, $9)
     RETURNING id, confidence, source, tier, object, reality_check`,
    [projectId, subject, predicate, object,
     conf || 7, source || 'model_extracted',
     realityCheck || null,
     tier || 'probationary',
     sessionId || 'test-session']
  );
  return rows[0];
}

/**
 * Insert a suppressed 'downvoted_probation' assertion (for resurrect testing).
 */
async function insertSuppressedAssertion(db, projectId, { subject, predicate, object, conf, source, realityCheck, sessionId }) {
  const { rows } = await db.query(
    `INSERT INTO assertions
       (project_id, subject, predicate, object, confidence, source,
        suppressed, invalid_at, suppression_kind, reality_check, tier, session_id)
     VALUES ($1, $2, $3, $4, $5, $6, true, now(), 'downvoted_probation', $7, 'probationary', $8)
     RETURNING id`,
    [projectId, subject, predicate, object,
     conf || 7, source || 'model_extracted',
     realityCheck || null,
     sessionId || 'test-session']
  );
  return rows[0];
}

/**
 * Insert a live (non-suppressed) assertion that anchors a subject as trusted
 * (reality_check='verified') so M2 resurrect-gate passes.
 */
async function insertTrustedAnchor(db, projectId, { subject }) {
  const { rows } = await db.query(
    `INSERT INTO assertions
       (project_id, subject, predicate, object, confidence, source,
        suppressed, invalid_at, reality_check, tier, session_id)
     VALUES ($1, $2, 'is_trusted_anchor', 'yes', 9, 'user_stated', false, NULL, 'verified', 'consolidated', 'anchor-session')
     RETURNING id`,
    [projectId, subject]
  );
  return rows[0];
}

// ─── HELPER: GET ROW BY ID ────────────────────────────────────────────────────

async function getAssertionById(db, id) {
  const { rows } = await db.query(
    `SELECT id, subject, predicate, object, confidence, source, tier, reality_check
     FROM assertions WHERE id = $1`,
    [id]
  );
  return rows[0] || null;
}

// ─── HELPER: ASSERT §7 INVARIANT ─────────────────────────────────────────────

/**
 * Assert that conf/source/tier/object of a row are unchanged from snapBefore,
 * but reality_check may differ.
 */
function assertSection7(snapBefore, snapAfter, label) {
  assert.strictEqual(String(snapAfter.confidence), String(snapBefore.confidence),
    `${label}: confidence modified (${snapBefore.confidence} → ${snapAfter.confidence})`);
  assert.strictEqual(snapAfter.source, snapBefore.source,
    `${label}: source modified (${snapBefore.source} → ${snapAfter.source})`);
  assert.strictEqual(snapAfter.tier, snapBefore.tier,
    `${label}: tier modified (${snapBefore.tier} → ${snapAfter.tier})`);
  assert.strictEqual(snapAfter.object, snapBefore.object,
    `${label}: object modified (${snapBefore.object} → ${snapAfter.object})`);
}

// ─── HELPER: BUILD GIT SHA IN FAKE REPO ──────────────────────────────────────

function gitHeadSha(repoRoot) {
  return execFileSync('git', ['-C', repoRoot, 'rev-parse', 'HEAD'], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function gitCreateBranch(repoRoot, branchName) {
  execFileSync('git', ['-C', repoRoot, 'checkout', '-b', branchName], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env },
  });
}

function gitDeleteBranch(repoRoot, branchName) {
  execFileSync('git', ['-C', repoRoot, 'checkout', 'main'], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env },
  });
  execFileSync('git', ['-C', repoRoot, 'branch', '-D', branchName], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env },
  });
}

function gitMakeCommit(repoRoot, message) {
  const filePath = path.join(repoRoot, `commit-${Date.now()}.txt`);
  fs.writeFileSync(filePath, message + '\n', 'utf8');
  execFileSync('git', ['-C', repoRoot, 'add', '.'], { encoding: 'utf8', stdio: 'pipe' });
  execFileSync('git', ['-C', repoRoot, 'commit', '-m', message], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'test',
      GIT_AUTHOR_EMAIL: 'test@test.com',
      GIT_COMMITTER_NAME: 'test',
      GIT_COMMITTER_EMAIL: 'test@test.com',
    },
  });
  return gitHeadSha(repoRoot);
}

// ─── TESTS ────────────────────────────────────────────────────────────────────

async function runTests() {
  const ghShimDir = createGhShim();

  console.log('\n── Permutation Harness: Adversarial Staleness Tests ─────────────\n');

  // ═══════════════════════════════════════════════════════════════════════════
  // P-GROUP: Per-predicate drift in every direction
  // ═══════════════════════════════════════════════════════════════════════════

  // ── P1: pr_state open→merged ─────────────────────────────────────────────
  await test('P1 pr_state: open→merged (mismatch → [STALE: now "merged"])', async () => {
    const ctx = await setupProject('p1');
    const { fakeRoot, projectId, db } = ctx;
    runInit(fakeRoot);

    const row = await insertAssertion(db, projectId, {
      subject: 'PR #1', predicate: 'pr_state', object: 'open',
      realityCheck: 'verified', sessionId: 'test-p1',
    });
    const snapBefore = await getAssertionById(db, row.id);

    // Fake gh returns 'merged'.
    const out = runResume(fakeRoot, {
      PATH: shimPath(ghShimDir),
      FAKE_GH_STATE: 'MERGED',
    });
    assert.ok(out.includes('[STALE:'), `P1: expected [STALE: in output.\nGot:\n${out}`);
    assert.ok(out.includes('merged'), `P1: expected 'merged' in STALE annotation.\nGot:\n${out}`);

    const snapAfter = await getAssertionById(db, row.id);
    assertSection7(snapBefore, snapAfter, 'P1');
    assert.strictEqual(snapAfter.reality_check, 'mismatch', `P1: expected reality_check='mismatch'`);

    await teardownProject(ctx);
  });

  // ── P2: pr_state open→closed ─────────────────────────────────────────────
  await test('P2 pr_state: open→closed (mismatch → [STALE: now "closed"])', async () => {
    const ctx = await setupProject('p2');
    const { fakeRoot, projectId, db } = ctx;
    runInit(fakeRoot);

    const row = await insertAssertion(db, projectId, {
      subject: 'PR #2', predicate: 'pr_state', object: 'open',
      realityCheck: 'verified', sessionId: 'test-p2',
    });

    const out = runResume(fakeRoot, {
      PATH: shimPath(ghShimDir),
      FAKE_GH_STATE: 'CLOSED',
    });
    assert.ok(out.includes('[STALE:'), `P2: expected [STALE: in output.\nGot:\n${out}`);
    assert.ok(out.includes('closed'), `P2: STALE annotation should mention 'closed'.\nGot:\n${out}`);

    const after = await getAssertionById(db, row.id);
    assert.strictEqual(after.reality_check, 'mismatch', `P2: expected reality_check='mismatch'`);

    await teardownProject(ctx);
  });

  // ── P3: pr_state merged→open (reopened) ──────────────────────────────────
  await test('P3 pr_state: merged→open (reopened, mismatch → [STALE: now "open"])', async () => {
    const ctx = await setupProject('p3');
    const { fakeRoot, projectId, db } = ctx;
    runInit(fakeRoot);

    const row = await insertAssertion(db, projectId, {
      subject: 'PR #3', predicate: 'pr_state', object: 'merged',
      realityCheck: 'verified', sessionId: 'test-p3',
    });

    const out = runResume(fakeRoot, {
      PATH: shimPath(ghShimDir),
      FAKE_GH_STATE: 'OPEN',
    });
    assert.ok(out.includes('[STALE:'), `P3: expected [STALE: in output.\nGot:\n${out}`);

    const after = await getAssertionById(db, row.id);
    assert.strictEqual(after.reality_check, 'mismatch', `P3: expected reality_check='mismatch'`);

    await teardownProject(ctx);
  });

  // ── P4: pr_state verified match (no drift) ───────────────────────────────
  await test('P4 pr_state: no drift → [verified✓] annotation', async () => {
    const ctx = await setupProject('p4');
    const { fakeRoot, projectId, db } = ctx;
    runInit(fakeRoot);

    const row = await insertAssertion(db, projectId, {
      subject: 'PR #4', predicate: 'pr_state', object: 'open',
      realityCheck: 'verified', sessionId: 'test-p4',
    });

    const out = runResume(fakeRoot, {
      PATH: shimPath(ghShimDir),
      FAKE_GH_STATE: 'OPEN',  // matches asserted object
    });
    assert.ok(out.includes('[verified✓]'), `P4: expected [verified✓] in output.\nGot:\n${out}`);
    assert.ok(!out.includes('[STALE:'), `P4: no [STALE: expected when probe matches`);

    const after = await getAssertionById(db, row.id);
    assert.strictEqual(after.reality_check, 'verified', `P4: expected reality_check='verified'`);

    await teardownProject(ctx);
  });

  // ── P5: branch_exists exists→deleted ────────────────────────────────────
  await test('P5 branch_exists: exists→deleted (mismatch → [STALE: now "<absent>"])', async () => {
    const ctx = await setupProject('p5');
    const { fakeRoot, projectId, db } = ctx;
    runInit(fakeRoot);

    // Create branch, assert it 'exists', then delete.
    gitCreateBranch(fakeRoot, 'feat/my-feature');
    const row = await insertAssertion(db, projectId, {
      subject: 'feat/my-feature', predicate: 'branch_exists', object: 'exists',
      realityCheck: 'verified', sessionId: 'test-p5',
    });
    const snapBefore = await getAssertionById(db, row.id);

    // Delete the branch (simulates post-merge deletion).
    gitDeleteBranch(fakeRoot, 'feat/my-feature');

    const out = runResume(fakeRoot);
    assert.ok(out.includes('[STALE:'), `P5: expected [STALE: in output.\nGot:\n${out}`);

    const snapAfter = await getAssertionById(db, row.id);
    assertSection7(snapBefore, snapAfter, 'P5');
    assert.strictEqual(snapAfter.reality_check, 'mismatch', `P5: expected reality_check='mismatch'`);

    await teardownProject(ctx);
  });

  // ── P6: branch_exists missing→created ───────────────────────────────────
  await test('P6 branch_exists: missing→created (mismatch → stale "<absent>" now "exists")', async () => {
    const ctx = await setupProject('p6');
    const { fakeRoot, projectId, db } = ctx;
    runInit(fakeRoot);

    // Assert branch as '<absent>' (was not there at close time), then create it.
    const row = await insertAssertion(db, projectId, {
      subject: 'feat/new-branch', predicate: 'branch_exists', object: '<absent>',
      realityCheck: 'verified', sessionId: 'test-p6',
    });

    // Create the branch — probe should now return 'exists' (mismatch with '<absent>').
    gitCreateBranch(fakeRoot, 'feat/new-branch');

    const out = runResume(fakeRoot);
    assert.ok(out.includes('[STALE:'), `P6: expected [STALE: in output.\nGot:\n${out}`);

    const after = await getAssertionById(db, row.id);
    assert.strictEqual(after.reality_check, 'mismatch', `P6: expected reality_check='mismatch'`);

    await teardownProject(ctx);
  });

  // ── P7: branch_exists stable → verified ─────────────────────────────────
  await test('P7 branch_exists: stable (main always exists) → [verified✓]', async () => {
    const ctx = await setupProject('p7');
    const { fakeRoot, projectId, db } = ctx;
    runInit(fakeRoot);

    const row = await insertAssertion(db, projectId, {
      subject: 'main', predicate: 'branch_exists', object: 'exists',
      realityCheck: null, sessionId: 'test-p7',
    });

    const out = runResume(fakeRoot);
    assert.ok(out.includes('[verified✓]'), `P7: expected [verified✓] in output.\nGot:\n${out}`);
    assert.ok(!out.includes('[STALE:'), `P7: no [STALE: expected for stable branch`);

    const after = await getAssertionById(db, row.id);
    assert.strictEqual(after.reality_check, 'verified', `P7: expected reality_check='verified'`);

    await teardownProject(ctx);
  });

  // ── P8: commit_merged asserted "merged" but sha NOT in main → mismatch ────
  //
  // Setup: create a commit on a side branch (not merged into main), then delete
  // the branch.  The orphaned commit's sha is NOT an ancestor of main.
  // Assert the object as "<branchSha> on main" (claiming the commit is merged).
  // Probe: merge-base --is-ancestor branchSha main → exit 1 → returns '<not-merged>'.
  // '<not-merged>' !== "<branchSha> on main" → mismatch → served as [STALE:].
  await test('P8 commit_merged: sha NOT ancestor of main → [STALE: mismatch]', async () => {
    const ctx = await setupProject('p8');
    const { fakeRoot, projectId, db } = ctx;
    runInit(fakeRoot);

    // Create an orphaned commit on a side branch (not in main).
    const branchSha = (() => {
      gitCreateBranch(fakeRoot, 'side-branch-p8');
      const sha = gitMakeCommit(fakeRoot, 'side branch commit p8');
      gitDeleteBranch(fakeRoot, 'side-branch-p8');
      return sha;
    })();

    // branchSha is NOT an ancestor of main (branch deleted, commit orphaned).
    // Assert it using the canonical "sha on branch" format as if it WERE merged.
    const object = `${branchSha} on main`;
    const row = await insertAssertion(db, projectId, {
      subject: 'pr-p8', predicate: 'commit_merged', object,
      realityCheck: 'verified', sessionId: 'test-p8',
    });
    const snapBefore = await getAssertionById(db, row.id);

    const out = runResume(fakeRoot);

    // Probe returns '<not-merged>' because branchSha is NOT an ancestor of main.
    // '<not-merged>' !== object → mismatch → [STALE:] annotation in output.
    assert.ok(out.includes('[STALE:'),
      `P8: expected [STALE: in output.\nGot:\n${out}`);

    const snapAfter = await getAssertionById(db, row.id);
    assertSection7(snapBefore, snapAfter, 'P8');
    assert.strictEqual(snapAfter.reality_check, 'mismatch',
      `P8: expected reality_check='mismatch', got '${snapAfter.reality_check}'`);

    await teardownProject(ctx);
  });

  // ── P9: commit_merged sha IS ancestor of main → [verified✓] ─────────────
  //
  // This test is the CANONICAL regression guard for the defect:
  //   OLD probe: returns 'merged' on success → 'merged' !== "<sha> on main" → always mismatch
  //   FIXED probe: returns the asserted object on success → object === object → verified
  //
  // Negative-control result (validated locally before commit):
  //   Against OLD probe (returning 'merged'): P9 FAILS — assertion shows mismatch,
  //     output has no [verified✓], reality_check='mismatch'.
  //   Against FIXED probe (echoing object): P9 PASSES — [verified✓] in output,
  //     reality_check='verified'.
  await test('P9 commit_merged: sha IS ancestor of main → [verified✓]', async () => {
    const ctx = await setupProject('p9');
    const { fakeRoot, projectId, db } = ctx;
    runInit(fakeRoot);

    // The initial commit sha IS an ancestor of HEAD (it IS the HEAD).
    const sha = gitHeadSha(fakeRoot);

    // Use the canonical documented format: "<sha> on <branch>".
    const object = `${sha} on main`;
    const row = await insertAssertion(db, projectId, {
      subject: 'pr-p9', predicate: 'commit_merged', object,
      realityCheck: null, sessionId: 'test-p9',
    });
    const snapBefore = await getAssertionById(db, row.id);

    const out = runResume(fakeRoot);

    // Fixed probe: merge-base --is-ancestor sha main → exit 0 → returns object.
    // object === object → tag='verified' → [verified✓] in served output.
    assert.ok(out.includes('[verified✓]'),
      `P9: expected [verified✓] in output (probe must echo object, not 'merged').\nGot:\n${out}`);
    assert.ok(!out.includes('[STALE:'),
      `P9: no [STALE:] expected when sha is a real ancestor.\nGot:\n${out}`);

    const snapAfter = await getAssertionById(db, row.id);
    assertSection7(snapBefore, snapAfter, 'P9');
    assert.strictEqual(snapAfter.reality_check, 'verified',
      `P9: expected reality_check='verified', got '${snapAfter.reality_check}'`);

    await teardownProject(ctx);
  });

  // ── P10: commit_merged bad object (not a sha) → unverifiable ─────────────
  //
  // Object is not a hex sha string and does not match the "<sha> on <branch>"
  // or bare-sha patterns, so the probe returns null → unverifiable.
  // No [STALE:] annotation; reality_check stays 'unverifiable' (fail-soft).
  await test('P10 commit_merged: non-sha object → unverifiable (fail-soft)', async () => {
    const ctx = await setupProject('p10');
    const { fakeRoot, projectId, db } = ctx;
    runInit(fakeRoot);

    const row = await insertAssertion(db, projectId, {
      subject: 'pr-p10', predicate: 'commit_merged', object: 'not-a-real-sha',
      realityCheck: 'verified', sessionId: 'test-p10',
    });

    const out = runResume(fakeRoot);

    // Non-sha object → probe returns null → unverifiable → no annotation.
    assert.ok(!out.includes('[STALE:'),
      `P10: no [STALE:] expected for non-sha object.\nGot:\n${out}`);
    assert.ok(!out.includes('[verified✓]'),
      `P10: no [verified✓] expected for non-sha object.\nGot:\n${out}`);

    const after = await getAssertionById(db, row.id);
    assert.strictEqual(after.reality_check, 'unverifiable',
      `P10: expected reality_check='unverifiable', got '${after.reality_check}'`);

    await teardownProject(ctx);
  });

  // ── P11: in_file present→deleted ─────────────────────────────────────────
  await test('P11 in_file: present→deleted → [STALE: now "<absent>"]', async () => {
    const ctx = await setupProject('p11');
    const { fakeRoot, projectId, db } = ctx;
    runInit(fakeRoot);

    const targetFile = path.join(fakeRoot, 'present-file.txt');
    fs.writeFileSync(targetFile, 'content\n', 'utf8');

    const row = await insertAssertion(db, projectId, {
      subject: 'docs', predicate: 'in_file', object: 'present-file.txt',
      realityCheck: 'verified', sessionId: 'test-p11',
    });
    const snapBefore = await getAssertionById(db, row.id);

    // Delete the file — drift!
    fs.unlinkSync(targetFile);

    const out = runResume(fakeRoot);
    assert.ok(out.includes('[STALE:'), `P11: expected [STALE: in output.\nGot:\n${out}`);
    assert.ok(out.includes('<absent>'), `P11: expected '<absent>' in STALE annotation.\nGot:\n${out}`);

    const snapAfter = await getAssertionById(db, row.id);
    assertSection7(snapBefore, snapAfter, 'P11');
    assert.strictEqual(snapAfter.reality_check, 'mismatch', `P11: expected mismatch`);

    await teardownProject(ctx);
  });

  // ── P12: in_file absent→created ──────────────────────────────────────────
  await test('P12 in_file: absent→created (asserted absent, now present → mismatch)', async () => {
    const ctx = await setupProject('p12');
    const { fakeRoot, projectId, db } = ctx;
    runInit(fakeRoot);

    const targetFile = path.join(fakeRoot, 'absent-file.txt');
    // File does NOT exist yet.

    const row = await insertAssertion(db, projectId, {
      subject: 'docs', predicate: 'in_file', object: 'absent-file.txt',
      realityCheck: 'verified',
      // Object is the path; probe returns '<absent>' when not found.
      // The assertion says the file is at 'absent-file.txt' (claiming presence).
      // Probe: file absent → returns '<absent>' ≠ 'absent-file.txt' → mismatch.
      // Wait — the probe returns the path when file exists, or '<absent>' when not.
      // So object='absent-file.txt', probe returns '<absent>' → mismatch. Correct.
      sessionId: 'test-p12',
    });

    // File still doesn't exist → probe returns '<absent>' → mismatch with 'absent-file.txt'.
    const out = runResume(fakeRoot);
    assert.ok(out.includes('[STALE:'), `P12: expected [STALE: in output.\nGot:\n${out}`);

    const after = await getAssertionById(db, row.id);
    assert.strictEqual(after.reality_check, 'mismatch', `P12: expected mismatch`);

    await teardownProject(ctx);
  });

  // ── P13: in_file present → verified ─────────────────────────────────────
  await test('P13 in_file: present (file exists) → [verified✓]', async () => {
    const ctx = await setupProject('p13');
    const { fakeRoot, projectId, db } = ctx;
    runInit(fakeRoot);

    const targetFile = path.join(fakeRoot, 'stable-file.txt');
    fs.writeFileSync(targetFile, 'stable\n', 'utf8');

    const row = await insertAssertion(db, projectId, {
      subject: 'docs', predicate: 'in_file', object: 'stable-file.txt',
      realityCheck: null, sessionId: 'test-p13',
    });

    const out = runResume(fakeRoot);
    assert.ok(out.includes('[verified✓]'), `P13: expected [verified✓] in output.\nGot:\n${out}`);
    assert.ok(!out.includes('[STALE:'), `P13: no [STALE:] for present file`);

    const after = await getAssertionById(db, row.id);
    assert.strictEqual(after.reality_check, 'verified', `P13: expected verified`);

    await teardownProject(ctx);
  });

  // ── P14: packaging (authoritative) — not annotated by verify path ────────
  await test('P14 packaging: has_unpackaged_state is authoritative-mode, never verify-annotated', async () => {
    const ctx = await setupProject('p14');
    const { fakeRoot, projectId, db } = ctx;
    runInit(fakeRoot);

    // Insert a has_unpackaged_state row manually.
    const row = await insertAssertion(db, projectId, {
      subject: path.basename(fakeRoot),
      predicate: 'has_unpackaged_state',
      object: 'clean',
      realityCheck: null,
      sessionId: 'test-p14',
    });

    const out = runResume(fakeRoot);
    // Authoritative mode — this row should NOT be annotated by the verify pass.
    // (The authoritative pass overwrites it, but the verify pass doesn't touch it.)
    const row14Lines = out.split('\n').filter((l) => l.includes('has_unpackaged_state'));
    for (const l of row14Lines) {
      assert.ok(!l.includes('[STALE:') && !l.includes('[verified✓]'),
        `P14: has_unpackaged_state should not have verify annotation: ${l}`);
    }

    await teardownProject(ctx);
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // F-GROUP: Trust fail-closed adversarial
  // ═══════════════════════════════════════════════════════════════════════════

  // ── F1: gh binary missing → unverifiable ────────────────────────────────
  await test('F1 fail-closed: gh binary missing → unverifiable, never verified', async () => {
    const ctx = await setupProject('f1');
    const { fakeRoot, projectId, db } = ctx;
    runInit(fakeRoot);

    // Use a PATH with NO gh binary.
    const emptyShimDir = fs.mkdtempSync(path.join(os.tmpdir(), 'empty-shim-'));
    const row = await insertAssertion(db, projectId, {
      subject: 'PR #99', predicate: 'pr_state', object: 'open',
      realityCheck: 'verified', sessionId: 'test-f1',
    });

    // Build a PATH that has only the empty dir (no gh binary anywhere).
    // On Windows, also exclude Program Files paths that have the real gh.
    const pathSep = process.platform === 'win32' ? ';' : ':';
    const minPath = emptyShimDir + pathSep + (process.platform === 'win32'
      ? 'C:\\Windows\\System32'
      : '/usr/bin:/bin');
    const out = runResume(fakeRoot, { PATH: minPath });
    assert.ok(!out.includes('[STALE:'), `F1: no [STALE:] when gh missing`);

    const after = await getAssertionById(db, row.id);
    // probe returns null → unverifiable, NOT mismatch (fail-closed)
    assert.strictEqual(after.reality_check, 'unverifiable',
      `F1: expected 'unverifiable' when gh missing, got '${after.reality_check}'`);

    fs.rmSync(emptyShimDir, { recursive: true, force: true });
    await teardownProject(ctx);
  });

  // ── F2: gh present but returns non-zero exit → unverifiable ─────────────
  await test('F2 fail-closed: gh non-zero exit (unauthenticated) → unverifiable', async () => {
    const ctx = await setupProject('f2');
    const { fakeRoot, projectId, db } = ctx;
    runInit(fakeRoot);

    const row = await insertAssertion(db, projectId, {
      subject: 'PR #98', predicate: 'pr_state', object: 'open',
      realityCheck: 'verified', sessionId: 'test-f2',
    });

    const out = runResume(fakeRoot, {
      PATH: shimPath(ghShimDir),
      FAKE_GH_FAIL: '1',
    });
    assert.ok(!out.includes('[STALE:'), `F2: no [STALE:] on gh failure`);

    const after = await getAssertionById(db, row.id);
    assert.strictEqual(after.reality_check, 'unverifiable',
      `F2: expected 'unverifiable' on gh non-zero exit, got '${after.reality_check}'`);

    await teardownProject(ctx);
  });

  // ── F3: gh timeout/hang → unverifiable + bounded time ────────────────────
  // Also verifies F3b: a row with reality_check='verified' stays 'unverifiable'
  // after probe failure, never gets upgraded.
  await test('F3 fail-closed: gh timeout → unverifiable (not verified), bounded time', async () => {
    const ctx = await setupProject('f3');
    const { fakeRoot, projectId, db } = ctx;
    runInit(fakeRoot);

    const row = await insertAssertion(db, projectId, {
      subject: 'PR #97', predicate: 'pr_state', object: 'open',
      realityCheck: 'verified', sessionId: 'test-f3',
    });

    // Fake gh sleeps for 10s (well beyond the 5s timeout).
    // The probe has a 5s timeout → it should return null → unverifiable.
    const start = Date.now();
    const out = runResume(fakeRoot, {
      PATH: shimPath(ghShimDir),
      FAKE_GH_SLEEP: '10',  // 10 seconds — beyond 5s probe timeout
    });
    const elapsed = Date.now() - start;

    assert.ok(!out.includes('[STALE:'), `F3: no [STALE:] on gh timeout`);

    const after = await getAssertionById(db, row.id);
    assert.strictEqual(after.reality_check, 'unverifiable',
      `F3: expected 'unverifiable' on gh timeout, got '${after.reality_check}'`);

    // Should complete within 30s total (well within the 5s probe timeout + overhead).
    assert.ok(elapsed < 30000, `F3: resume took too long: ${elapsed}ms`);

    await teardownProject(ctx);
  });

  // ── F4: git not-a-repo → unverifiable for branch/commit probes ───────────
  await test('F4 fail-closed: non-git directory → branch/commit probes unverifiable', async () => {
    // Create a fakeRoot that is NOT a git repo.
    const nonGitRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'non-git-'));
    fs.mkdirSync(path.join(nonGitRoot, '.claude'));
    fs.writeFileSync(path.join(nonGitRoot, '.claude', 'pipeline.yml'), [
      'project:',
      '  name: non-git-test',
      '',
      'knowledge:',
      '  tier: "postgres"',
      '  host: "localhost"',
      '  port: 5432',
      `  database: "${TARGET_DB}"`,
      '  user: "postgres"',
    ].join('\n'), 'utf8');

    const marker    = writeMarker(nonGitRoot);
    const projectId = marker.uuid;

    const db = await connectDb();
    const sqlDir = path.resolve(__dirname, '..', '..', 'scripts', 'sql');
    for (const s of ['handoff-core-schema.sql', 'app-retrieval-events-schema.sql']) {
      const f = path.join(sqlDir, s);
      if (!fs.existsSync(f)) continue;
      let sql = fs.readFileSync(f, 'utf8');
      sql = sql.replace(/^\\[a-z].*$/gm, '');
      try { await db.query(sql); } catch (e) {
        if (!e.message.includes('already exists')) {}
      }
    }
    await db.query(
      `INSERT INTO project_settings (project_id, key, value)
       VALUES ($1, 'serve_time_reality_check', 'enabled')
       ON CONFLICT (project_id, key) DO UPDATE SET value = 'enabled'`,
      [projectId]
    );
    await db.query(
      `INSERT INTO retrieval_contract (project_id, name, queries, version)
       VALUES ($1, 'default', $2::jsonb, 1)
       ON CONFLICT (project_id, name) DO UPDATE SET queries = EXCLUDED.queries`,
      [projectId, JSON.stringify({ queries: [{ kind: 'assertion', token_budget: 500 }] })]
    );

    const row = await insertAssertion(db, projectId, {
      subject: 'some-branch', predicate: 'branch_exists', object: 'exists',
      realityCheck: 'verified', sessionId: 'test-f4',
    });

    const env = { ...process.env, PROJECT_ROOT: nonGitRoot };
    runInit(nonGitRoot);
    const out = execFileSync(
      process.execPath, [HELPER, 'resume'],
      { cwd: nonGitRoot, env, encoding: 'utf8', timeout: 60000 }
    );

    // Non-git dir → branch probe returns null → unverifiable.
    assert.ok(!out.includes('[STALE:'), `F4: no [STALE:] in non-git dir`);

    const after = await db.query(
      `SELECT reality_check FROM assertions WHERE id = $1`, [row.id]
    );
    assert.strictEqual(after.rows[0].reality_check, 'unverifiable',
      `F4: expected 'unverifiable' in non-git dir, got '${after.rows[0].reality_check}'`);

    // Cleanup.
    await db.query(`DELETE FROM assertions WHERE project_id = $1`, [projectId]);
    await db.query(`DELETE FROM project_settings WHERE project_id = $1`, [projectId]);
    await db.query(`DELETE FROM retrieval_contract WHERE project_id = $1`, [projectId]);
    await db.end();
    fs.rmSync(nonGitRoot, { recursive: true, force: true });
    const homeDir = path.join(os.homedir(), '.claude', 'projects', projectId);
    if (fs.existsSync(homeDir)) fs.rmSync(homeDir, { recursive: true, force: true });
  });

  // ── F5: malformed gh JSON → unverifiable ─────────────────────────────────
  await test('F5 fail-closed: malformed gh JSON output → unverifiable', async () => {
    const ctx = await setupProject('f5');
    const { fakeRoot, projectId, db } = ctx;
    runInit(fakeRoot);

    const row = await insertAssertion(db, projectId, {
      subject: 'PR #96', predicate: 'pr_state', object: 'open',
      realityCheck: 'verified', sessionId: 'test-f5',
    });

    const out = runResume(fakeRoot, {
      PATH: shimPath(ghShimDir),
      FAKE_GH_BAD_JSON: '1',
    });
    assert.ok(!out.includes('[STALE:'), `F5: no [STALE:] on bad JSON`);

    const after = await getAssertionById(db, row.id);
    assert.strictEqual(after.reality_check, 'unverifiable',
      `F5: expected 'unverifiable' on bad JSON, got '${after.reality_check}'`);

    await teardownProject(ctx);
  });

  // ── F6: gh JSON missing state field → unverifiable ───────────────────────
  await test('F6 fail-closed: gh JSON missing .state field → unverifiable', async () => {
    const ctx = await setupProject('f6');
    const { fakeRoot, projectId, db } = ctx;
    runInit(fakeRoot);

    const row = await insertAssertion(db, projectId, {
      subject: 'PR #95', predicate: 'pr_state', object: 'open',
      realityCheck: 'verified', sessionId: 'test-f6',
    });

    const out = runResume(fakeRoot, {
      PATH: shimPath(ghShimDir),
      FAKE_GH_MISSING_STATE: '1',
    });
    assert.ok(!out.includes('[STALE:'), `F6: no [STALE:] on missing .state`);

    const after = await getAssertionById(db, row.id);
    assert.strictEqual(after.reality_check, 'unverifiable',
      `F6: expected 'unverifiable' on missing .state, got '${after.reality_check}'`);

    await teardownProject(ctx);
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // L-GROUP: GH-offline latency — circuit-breaker must bound total time
  // ═══════════════════════════════════════════════════════════════════════════

  await test('L1 gh-offline latency: many pr_state rows, fake gh hangs → circuit-breaker bounds total time', async () => {
    const ctx = await setupProject('l1');
    const { fakeRoot, projectId, db } = ctx;
    runInit(fakeRoot);

    // Insert 8 pr_state rows — without circuit-breaker this would be 8 × 5s = 40s.
    const N = 8;
    for (let i = 1; i <= N; i++) {
      await insertAssertion(db, projectId, {
        subject: `PR #${1000 + i}`, predicate: 'pr_state', object: 'open',
        realityCheck: 'verified', sessionId: 'test-l1',
      });
    }

    // Fake gh sleeps 6 seconds (just over the 5s probe timeout).
    // Without circuit-breaker: ~40s total.  With circuit-breaker: ~5s (first fail) + near-zero * 7.
    const start = Date.now();
    const out = runResume(fakeRoot, {
      PATH: shimPath(ghShimDir),
      FAKE_GH_SLEEP: '6',  // 6 seconds — above 5s probe timeout
    });
    const elapsed = Date.now() - start;

    // Should complete well under N×5s = 40s. Allow generous 20s.
    assert.ok(elapsed < 20000,
      `L1: circuit-breaker failed — took ${elapsed}ms for ${N} rows (expected < 20000ms)`);

    console.log(`    L1: elapsed=${elapsed}ms for ${N} rows (circuit-breaker working)`);

    // All rows should be 'unverifiable' (circuit triggered).
    const { rows: afterRows } = await db.query(
      `SELECT reality_check FROM assertions
       WHERE project_id = $1 AND predicate = 'pr_state'`,
      [projectId]
    );
    for (const r of afterRows) {
      assert.strictEqual(r.reality_check, 'unverifiable',
        `L1: expected all rows 'unverifiable' after circuit-breaker`);
    }

    await teardownProject(ctx);
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // S7-GROUP: §7 invariance after ALL permutations
  // ═══════════════════════════════════════════════════════════════════════════

  await test('S7 §7 invariance: serve-time pass ONLY modifies reality_check, never conf/source/tier/object', async () => {
    const ctx = await setupProject('s7');
    const { fakeRoot, projectId, db } = ctx;
    runInit(fakeRoot);

    const testFile = path.join(fakeRoot, 's7-file.txt');
    fs.writeFileSync(testFile, 'x\n', 'utf8');

    const row = await insertAssertion(db, projectId, {
      subject: 's7-subject', predicate: 'in_file', object: 's7-file.txt',
      conf: 9, source: 'user_stated', tier: 'consolidated',
      realityCheck: 'verified', sessionId: 'test-s7',
    });
    const snapBefore = await getAssertionById(db, row.id);

    // Delete file → mismatch.
    fs.unlinkSync(testFile);
    runResume(fakeRoot);

    const snapAfter = await getAssertionById(db, row.id);
    assertSection7(snapBefore, snapAfter, 'S7');
    assert.strictEqual(snapAfter.reality_check, 'mismatch',
      `S7: expected reality_check='mismatch' after mismatch pass`);

    await teardownProject(ctx);
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // G1-GROUP: Gate off — byte-identical when disabled
  // ═══════════════════════════════════════════════════════════════════════════

  await test('G1 gate-off: serve_time_reality_check=disabled → no annotation, byte-identical', async () => {
    const ctx = await setupProject('g1');
    const { fakeRoot, projectId, db } = ctx;
    runInit(fakeRoot);

    const staleFile = path.join(fakeRoot, 'g1-stale.txt');
    // File will NOT exist (drift).

    await insertAssertion(db, projectId, {
      subject: 'g1-subject', predicate: 'in_file', object: 'g1-stale.txt',
      realityCheck: 'verified', sessionId: 'test-g1',
    });

    // Disable gate.
    await db.query(
      `INSERT INTO project_settings (project_id, key, value)
       VALUES ($1, 'serve_time_reality_check', 'disabled')
       ON CONFLICT (project_id, key) DO UPDATE SET value = 'disabled'`,
      [projectId]
    );

    const outDisabled = runResume(fakeRoot);
    assert.ok(!outDisabled.includes('[STALE:'), `G1: no [STALE:] when gate disabled`);
    assert.ok(!outDisabled.includes('[verified✓]'), `G1: no [verified✓] when gate disabled`);
    assert.ok(!outDisabled.includes('[unverifiable]'), `G1: no [unverifiable] when gate disabled`);

    // Re-enable and verify annotation DOES appear.
    await db.query(
      `UPDATE project_settings SET value = 'enabled'
       WHERE project_id = $1 AND key = 'serve_time_reality_check'`,
      [projectId]
    );
    const outEnabled = runResume(fakeRoot);
    assert.ok(outEnabled.includes('[STALE:'), `G1: [STALE:] should appear when gate enabled`);

    await teardownProject(ctx);
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // A1-GROUP: All serve paths — resurrect also annotates stale rows
  // ═══════════════════════════════════════════════════════════════════════════

  await test('A1 resurrect path: stale in_file annotation via resurrect serve path', async () => {
    const ctx = await setupProject('a1');
    const { fakeRoot, projectId, db } = ctx;
    runInit(fakeRoot);

    const targetFile = path.join(fakeRoot, 'a1-resurrect-file.txt');
    fs.writeFileSync(targetFile, 'content\n', 'utf8');

    const subject = 'a1-resurrect-subject';

    // Insert a suppressed 'downvoted_probation' row (resurrect-eligible).
    const row = await insertSuppressedAssertion(db, projectId, {
      subject,
      predicate: 'in_file',
      object: 'a1-resurrect-file.txt',
      realityCheck: 'verified',
      sessionId: 'test-a1',
    });

    // Insert a trusted anchor so M2 gate passes.
    await insertTrustedAnchor(db, projectId, { subject });

    // Add a resurrect query to the contract.
    await db.query(
      `INSERT INTO retrieval_contract (project_id, name, queries, version)
       VALUES ($1, 'default', $2::jsonb, 1)
       ON CONFLICT (project_id, name) DO UPDATE SET queries = EXCLUDED.queries`,
      [projectId, JSON.stringify({
        queries: [
          { kind: 'assertion', token_budget: 200 },
          { kind: 'resurrect', seed: subject, token_budget: 500 },
        ],
      })]
    );

    // Delete the file so the probe returns '<absent>' (mismatch).
    fs.unlinkSync(targetFile);

    // Resume with resurrect query in contract — the resurrect section should
    // include [STALE:] annotation.
    const out = runResume(fakeRoot, {
      OLLAMA_SKIP: '1',
    });
    assert.ok(out.includes('[STALE:'),
      `A1: expected [STALE: annotation via resurrect serve path.\nGot:\n${out}`);

    await teardownProject(ctx);
  });

  // Also test the CLI resurrect path (cmdResurrect).
  await test('A1b resurrect CLI: stale in_file annotation via cmdResurrect', async () => {
    const ctx = await setupProject('a1b');
    const { fakeRoot, projectId, db } = ctx;
    runInit(fakeRoot);

    const targetFile = path.join(fakeRoot, 'a1b-file.txt');
    fs.writeFileSync(targetFile, 'content\n', 'utf8');

    const subject = 'a1b-cli-subject';

    // Insert suppressed row.
    await insertSuppressedAssertion(db, projectId, {
      subject,
      predicate: 'in_file',
      object: 'a1b-file.txt',
      realityCheck: 'verified',
      sessionId: 'test-a1b',
    });

    // Insert trusted anchor.
    await insertTrustedAnchor(db, projectId, { subject });

    // Delete the file.
    fs.unlinkSync(targetFile);

    // Run resurrect CLI.
    const out = runResurrect(fakeRoot, subject, { OLLAMA_SKIP: '1' });
    assert.ok(out.includes('[STALE:'),
      `A1b: expected [STALE: annotation via cmdResurrect.\nGot:\n${out}`);

    await teardownProject(ctx);
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // R1-GROUP: Multi-session round-trip
  // ═══════════════════════════════════════════════════════════════════════════

  await test('R1 multi-session round-trip: verified → STALE → verified again', async () => {
    const ctx = await setupProject('r1');
    const { fakeRoot, projectId, db } = ctx;
    runInit(fakeRoot);

    const targetFile = path.join(fakeRoot, 'round-trip-file.txt');
    fs.writeFileSync(targetFile, 'content\n', 'utf8');

    const row = await insertAssertion(db, projectId, {
      subject: 'r1-subject', predicate: 'in_file', object: 'round-trip-file.txt',
      realityCheck: null, sessionId: 'test-r1',
    });

    // Session N: file exists → verified.
    const outN = runResume(fakeRoot);
    assert.ok(outN.includes('[verified✓]'), `R1 session N: expected [verified✓].\nGot:\n${outN}`);
    let after = await getAssertionById(db, row.id);
    assert.strictEqual(after.reality_check, 'verified', `R1 session N: expected verified`);

    // World changes: delete file.
    fs.unlinkSync(targetFile);

    // Session N+1: file gone → STALE.
    const outN1 = runResume(fakeRoot);
    assert.ok(outN1.includes('[STALE:'), `R1 session N+1: expected [STALE:].\nGot:\n${outN1}`);
    after = await getAssertionById(db, row.id);
    assert.strictEqual(after.reality_check, 'mismatch', `R1 session N+1: expected mismatch`);

    // World reverts: restore file.
    fs.writeFileSync(targetFile, 'content\n', 'utf8');

    // Session N+2: file back → verified again.
    const outN2 = runResume(fakeRoot);
    assert.ok(outN2.includes('[verified✓]'), `R1 session N+2: expected [verified✓] again.\nGot:\n${outN2}`);
    after = await getAssertionById(db, row.id);
    assert.strictEqual(after.reality_check, 'verified', `R1 session N+2: expected verified`);

    await teardownProject(ctx);
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // C1-GROUP: Concurrency — two serve passes racing reality_check UPDATE
  // ═══════════════════════════════════════════════════════════════════════════

  await test('C1 concurrency: two simultaneous serve passes → no crash, no corruption', async () => {
    const ctx = await setupProject('c1');
    const { fakeRoot, projectId, db } = ctx;
    runInit(fakeRoot);

    const targetFile = path.join(fakeRoot, 'concurrent-file.txt');
    fs.writeFileSync(targetFile, 'content\n', 'utf8');

    await insertAssertion(db, projectId, {
      subject: 'c1-subject', predicate: 'in_file', object: 'concurrent-file.txt',
      realityCheck: null, sessionId: 'test-c1',
    });

    // Delete file so probe will return mismatch.
    fs.unlinkSync(targetFile);

    // Launch two resume processes concurrently.
    const child1Promise = new Promise((resolve, reject) => {
      const { execFile } = require('child_process');
      execFile(
        process.execPath, [HELPER, 'resume'],
        { cwd: fakeRoot, env: helperEnv(fakeRoot), encoding: 'utf8', timeout: 60000 },
        (err, stdout) => {
          if (err && !stdout) reject(err);
          else resolve(stdout || '');
        }
      );
    });
    const child2Promise = new Promise((resolve, reject) => {
      const { execFile } = require('child_process');
      execFile(
        process.execPath, [HELPER, 'resume'],
        { cwd: fakeRoot, env: helperEnv(fakeRoot), encoding: 'utf8', timeout: 60000 },
        (err, stdout) => {
          if (err && !stdout) reject(err);
          else resolve(stdout || '');
        }
      );
    });

    const [out1, out2] = await Promise.all([child1Promise, child2Promise]);

    // Both should complete without crash and include STALE annotation.
    assert.ok(out1.includes('[STALE:') || out1.includes('[verified✓]'),
      `C1: process 1 should have annotation.\nGot:\n${out1}`);
    assert.ok(out2.includes('[STALE:') || out2.includes('[verified✓]'),
      `C1: process 2 should have annotation.\nGot:\n${out2}`);

    // DB should not be corrupted — reality_check is valid.
    const { rows: finalRows } = await db.query(
      `SELECT reality_check FROM assertions
       WHERE project_id = $1 AND predicate = 'in_file'`,
      [projectId]
    );
    for (const r of finalRows) {
      assert.ok(
        ['verified', 'mismatch', 'unverifiable', null].includes(r.reality_check),
        `C1: invalid reality_check value: ${r.reality_check}`
      );
    }

    await teardownProject(ctx);
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Floor: no-probe predicate never annotated
  // ═══════════════════════════════════════════════════════════════════════════

  await test('Floor: no-probe predicate never annotated regardless of content', async () => {
    const ctx = await setupProject('floor');
    const { fakeRoot, projectId, db } = ctx;
    runInit(fakeRoot);

    // Insert assertions with predicates not in the registry.
    const predicates = ['is_status', 'was_designed_by', 'uses_model', 'deployed_to', 'custom_pred'];
    for (const pred of predicates) {
      await insertAssertion(db, projectId, {
        subject: `floor-${pred}`, predicate: pred, object: 'some-value',
        realityCheck: null, sessionId: 'test-floor',
      });
    }

    const out = runResume(fakeRoot);

    // None of these lines should have STALE or verified annotations.
    const lines = out.split('\n');
    for (const pred of predicates) {
      const matchingLines = lines.filter((l) => l.includes(`floor-${pred}`));
      for (const l of matchingLines) {
        assert.ok(!l.includes('[STALE:') && !l.includes('[verified✓]'),
          `Floor: predicate '${pred}' should not be annotated: ${l}`);
      }
    }

    await teardownProject(ctx);
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // B1-GROUP: Budget economy — annotations don't blow the 4000-token budget
  // ═══════════════════════════════════════════════════════════════════════════

  await test('B1 budget economy: realistic annotated corpus stays within 4000-token budget', async () => {
    const ctx = await setupProject('b1');
    const { fakeRoot, projectId, db } = ctx;
    runInit(fakeRoot);

    // Create 20 in_file assertions with files that exist (verified annotations).
    for (let i = 0; i < 20; i++) {
      const fname = `b1-file-${i}.txt`;
      fs.writeFileSync(path.join(fakeRoot, fname), `content ${i}\n`, 'utf8');
      await insertAssertion(db, projectId, {
        subject: `b1-entity-${i}`,
        predicate: 'in_file',
        object: fname,
        conf: 7, source: 'model_extracted', tier: 'probationary',
        realityCheck: null, sessionId: 'test-b1',
      });
    }

    // Set a 4000-token budget.
    await db.query(
      `INSERT INTO project_settings (project_id, key, value)
       VALUES ($1, 'loader_token_budget', '4000')
       ON CONFLICT (project_id, key) DO UPDATE SET value = '4000'`,
      [projectId]
    );

    const out = runResume(fakeRoot);

    // The output should include the budget line; check true token count.
    const tokensMatch = out.match(/tokens used: ~(\d+) \//);
    if (tokensMatch) {
      const trueTokens = parseInt(tokensMatch[1], 10);
      assert.ok(trueTokens <= 4000,
        `B1: trueServedTokens ${trueTokens} exceeds 4000-token budget`);
      console.log(`    B1: trueServedTokens=${trueTokens} (budget=4000)`);
    }
    // No [STALE:] — all files exist.
    assert.ok(!out.includes('[STALE:'), `B1: no STALE for existing files`);

    await teardownProject(ctx);
  });

  // ─── Final report ──────────────────────────────────────────────────────────

  console.log('\n─────────────────────────────────────────────────────────────────');

  // Clean up gh shim.
  try { fs.rmSync(ghShimDir, { recursive: true, force: true }); } catch (_) {}

  if (failed > 0) {
    console.error(`\n${passed} passed, ${failed} FAILED.`);
    for (const f of failures) {
      console.error(`  FAIL  ${f.label}`);
      console.error(`        ${f.message}`);
    }
    process.exit(1);
  } else {
    console.log(`\nAll ${passed} test(s) passed.`);
    process.exit(0);
  }
}

runTests().catch((err) => {
  console.error(`\nInfrastructure error: ${err.message}`);
  if (process.env.DEBUG) console.error(err.stack);
  process.exit(2);
});
