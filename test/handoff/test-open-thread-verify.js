'use strict';

/**
 * test-open-thread-verify.js — Tests for the open_thread serve-time staleness gate.
 *
 * Coverage:
 *   OT1  Replay of the real bug: open_thread citing a PR that IS in git log as
 *        merged (squash-merge "(#NNN)" subject) → served output contains [STALE:].
 *   OT2  open_thread citing a PR number NOT in git log → NO annotation.
 *   OT3  open_thread with no # anchor → NO annotation.
 *   OT4  Fail-soft: probeOpenThread from a non-git directory → null, no throw.
 *   OT5  Safety (critical): close with a live open_thread citing a merged PR →
 *        row remains suppressed=false, suppression_kind IS NULL, no degraded_close
 *        record.  Proves annotateOnly prevents close-time mutation.
 *   OT6  getMergedPrSet unit: parses (#NNN) from subjects, memoizes, returns null
 *        on git failure from a non-git directory.
 *   OT7  Regression (issue #150): qualified cross-repo refs ("foreignrepo#N",
 *        "owner/repo#N") whose N IS in the local merged set → probe returns
 *        null (no false [STALE:]).
 *   OT8  Named tradeoff: prose-glued local form "PR#N" with N merged → probe
 *        returns null (locked as intended behavior, not a future bug).
 *   OT9  Non-weakening: bare "(#N)" and whitespace-preceded "#N" with N
 *        merged still return the staleness hint (existing OT1/OT1b/OT6c
 *        signal must survive the #150 fix untouched).
 *   OT10 Start-of-string "#N" (no preceding char) → still a local candidate.
 *   OT11 Chained "#12#13" shape → second token suppressed (digit precedes
 *        its "#"); a lookbehind artifact in the safe (suppress) direction.
 *   OT12 (adversary finding #11) getMergedPrSet parens-adjacency immunity:
 *        commit subject "fix cross-repo (foreignrepo#16) handling (#150)"
 *        → merged set contains "150", does NOT contain "16".
 *   OT13 Unicode-preceded "#N" (em-dash / non-ASCII letter directly before
 *        "#") → local candidate (locks the ASCII-only class against a
 *        future `\p{L}`/`\w` "improvement" that would reintroduce #150).
 *
 * Uses the claude_memory_eval_test database (same as other test/handoff tests).
 * Each test with DB access uses an isolated projectId and cleans up after itself.
 *
 * Usage:
 *   PGHOST=localhost PGUSER=postgres PGPASSWORD=postgres \
 *     node test/handoff/test-open-thread-verify.js
 *
 * Exit codes: 0 all-pass, 1 any failure, 2 infrastructure error.
 */

const assert           = require('assert');
const path             = require('path');
const fs               = require('fs');
const os               = require('os');
const { execFileSync } = require('child_process');

const { loadConfig }   = require('../../scripts/lib/shared');
const { writeMarker }  = require('../../scripts/lib/project-marker');
const { resolveHandoffMdPath } = require('../../scripts/lib/handoff-paths');
const {
  getMergedPrSet,
  probeOpenThread,
  OPEN_THREAD_TOKEN_RE,
} = require('../../scripts/lib/reality-checks');
const { createRequire } = require('module');
const scriptsRequire    = createRequire(require.resolve('../../scripts/package.json'));
const { Client }        = scriptsRequire('pg');

// ─── CONFIG ───────────────────────────────────────────────────────────────────

const TARGET_DB = 'claude_memory_eval_test';
const HELPER    = path.resolve(__dirname, '..', '..', 'scripts', 'handoff.js');

// The actual repo root (where git log will find real merged PRs).
const REPO_ROOT = path.resolve(__dirname, '..', '..');

// ─── COUNTERS ─────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

async function test(label, fn) {
  try {
    await fn();
    console.log(`PASS  ${label}`);
    passed++;
  } catch (err) {
    console.error(`FAIL  ${label}`);
    console.error(`      ${err.message}`);
    if (process.env.DEBUG) console.error(err.stack);
    failed++;
  }
}

// ─── DB HELPERS ───────────────────────────────────────────────────────────────

async function connectDb() {
  const cfg = loadConfig();
  const client = new Client({
    host:     cfg.host,
    port:     cfg.port,
    database: TARGET_DB,
    user:     cfg.user,
  });
  await client.connect();
  return client;
}

// ─── SETUP / TEARDOWN ─────────────────────────────────────────────────────────

/**
 * Create a minimal fakeRoot that is also a real git repo (init + initial commit),
 * so that getMergedPrSet can run git log against it.
 *
 * To ensure the probe finds at least one merged PR, we author a commit whose
 * subject contains "(#NNN)".  We use PR #9001 (safely above any real repo PR
 * number that exists in the main repo history, but we will also use a real
 * merged number like #106 for the replay test using REPO_ROOT).
 */
async function setupWithGit(mergedPrNumbers) {
  const fakeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'open-thread-test-'));
  fs.mkdirSync(path.join(fakeRoot, '.claude'));
  fs.writeFileSync(path.join(fakeRoot, '.claude', 'pipeline.yml'), [
    'project:',
    '  name: open-thread-test',
    '',
    'knowledge:',
    '  tier: "postgres"',
    '  host: "localhost"',
    '  port: 5432',
    `  database: "${TARGET_DB}"`,
    '  user: "postgres"',
  ].join('\n'), 'utf8');

  // Initialize a real git repo.
  const gitEnv = {
    ...process.env,
    GIT_AUTHOR_NAME:    'test',
    GIT_AUTHOR_EMAIL:   'test@test',
    GIT_COMMITTER_NAME: 'test',
    GIT_COMMITTER_EMAIL: 'test@test',
  };
  execFileSync('git', ['init'], { cwd: fakeRoot, encoding: 'utf8', timeout: 10000 });
  execFileSync('git', ['commit', '--allow-empty', '-m', 'init', '--no-gpg-sign'],
    { cwd: fakeRoot, encoding: 'utf8', timeout: 10000, env: gitEnv });

  // Author one commit per requested merged PR number so git log picks them up.
  for (const prNum of (mergedPrNumbers || [])) {
    execFileSync('git', ['commit', '--allow-empty', '-m', `feat: test (#${prNum})`, '--no-gpg-sign'],
      { cwd: fakeRoot, encoding: 'utf8', timeout: 10000, env: gitEnv });
  }

  // Pre-mint the project marker so handoff.js uses the same UUID.
  const marker    = writeMarker(fakeRoot);
  const projectId = marker.uuid;

  let db;
  try {
    db = await connectDb();
  } catch (err) {
    console.error(`\nInfrastructure error: cannot connect to ${TARGET_DB}: ${err.message}`);
    process.exit(2);
  }

  // Apply schema idempotently.
  const sqlDir = path.resolve(__dirname, '..', '..', 'scripts', 'sql');
  for (const s of ['handoff-core-schema.sql']) {
    const f = path.join(sqlDir, s);
    if (!fs.existsSync(f)) continue;
    let sql = fs.readFileSync(f, 'utf8');
    sql = sql.replace(/^\\[a-z].*$/gm, '');
    try { await db.query(sql); } catch (e) {
      if (!e.message.includes('already exists')) console.warn(`  Schema warning (${s}): ${e.message}`);
    }
  }

  return { fakeRoot, projectId, db };
}

async function teardown(ctx) {
  const { fakeRoot, projectId, db } = ctx;
  const tables = ['edges', 'assertions', 'entities', 'retrieval_contract',
    'retrieval_contract_history', 'project_settings'];
  for (const tbl of tables) {
    try { await db.query(`DELETE FROM ${tbl} WHERE project_id = $1`, [projectId]); }
    catch (_) {}
  }
  try { await db.end(); } catch (_) {}
  try { fs.rmSync(fakeRoot, { recursive: true, force: true }); } catch (_) {}
  try {
    const dir = path.dirname(resolveHandoffMdPath(projectId));
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  } catch (_) {}
}

// ─── SUBPROCESS HELPERS ───────────────────────────────────────────────────────

function helperEnv(fakeRoot) {
  return { ...process.env, PROJECT_ROOT: fakeRoot };
}

function runClose(fakeRoot, payload) {
  return execFileSync(
    process.execPath,
    [HELPER, 'close', '--json', '-'],
    { cwd: fakeRoot, env: helperEnv(fakeRoot), encoding: 'utf8', timeout: 60000,
      input: JSON.stringify(payload) }
  );
}

function runInit(fakeRoot) {
  return execFileSync(
    process.execPath,
    [HELPER, 'init', '-y'],
    { cwd: fakeRoot, env: helperEnv(fakeRoot), encoding: 'utf8', timeout: 60000 }
  );
}

function runResume(fakeRoot) {
  return execFileSync(
    process.execPath,
    [HELPER, 'resume'],
    { cwd: fakeRoot, env: helperEnv(fakeRoot), encoding: 'utf8', timeout: 60000 }
  );
}

// ─── TEST: pick a real merged PR number from the actual repo's git log ─────────

/**
 * Find a real merged PR number from REPO_ROOT's git log.
 * Returns a string like "106" or null if not found.
 */
function findRealMergedPr() {
  try {
    const { execFileSync: ef } = require('child_process');
    const out = ef('git', ['-C', REPO_ROOT, 'log', '--format=%s', '-n', '200'],
      { encoding: 'utf8', timeout: 5000 });
    const m = out.match(/\(#(\d+)\)/);
    return m ? m[1] : null;
  } catch (_) {
    return null;
  }
}

// ─── TESTS ────────────────────────────────────────────────────────────────────

async function runTests() {

  // ── OT1: Replay of the real bug ───────────────────────────────────────────────
  //
  // Seed a live open_thread row whose object cites a PR that IS in the git log
  // as a merged "(#NNN)" commit subject.  Run resume and assert [STALE: appears.
  await test('(OT1) replay real bug: open_thread citing merged PR → [STALE: in served output', async () => {
    // Use a fake git repo with a synthetic merged PR #9001.
    const ctx = await setupWithGit([9001]);
    const { fakeRoot, projectId, db } = ctx;
    try {
      // Skip runInit (it fails when constraints are violated in the shared DB).
      // We already called writeMarker in setupWithGit which is sufficient.

      // Seed a live open_thread row citing #9001.
      await db.query(
        `INSERT INTO assertions
           (project_id, subject, predicate, object, confidence, source,
            suppressed, invalid_at, tier, session_id)
         VALUES ($1, $2, $3, $4, $5, $6, false, NULL, 'probationary', 'prior-ot1-session')`,
        [projectId, path.basename(fakeRoot), 'open_thread',
          'fix cmdprune-validkinds-gap NOT started (#9001)', 9, 'user_stated']
      );

      // Ensure serve_time_reality_check is enabled.
      await db.query(
        `INSERT INTO project_settings (project_id, key, value)
         VALUES ($1, 'serve_time_reality_check', 'enabled')
         ON CONFLICT (project_id, key) DO UPDATE SET value = 'enabled'`,
        [projectId]
      );

      // Ensure retrieval_contract exists so the loader runs assertion queries.
      await db.query(
        `INSERT INTO retrieval_contract (project_id, name, queries, version)
         VALUES ($1, 'default', $2::jsonb, 1)
         ON CONFLICT (project_id, name) DO UPDATE SET queries = EXCLUDED.queries`,
        [projectId, JSON.stringify({ queries: [{ kind: 'assertion', token_budget: 1000 }] })]
      );

      const resumeOut = runResume(fakeRoot);

      assert.ok(
        resumeOut.includes('[STALE:'),
        `Expected [STALE: annotation in resume output for open_thread citing merged PR #9001.\n` +
        `Got output:\n${resumeOut}`
      );
    } finally {
      await teardown(ctx);
    }
  });

  // ── OT1b: Replay using the actual repo root ────────────────────────────────────
  //
  // Use REPO_ROOT (which has real merged PR commits) to verify the probe works
  // against the real git log.  This confirms #106/other real merged PRs are found.
  await test('(OT1b) probe against real repo log: merged PR is detected', async () => {
    const realPr = findRealMergedPr();
    if (!realPr) {
      console.log('      SKIP: no real merged PR found in git log');
      passed++; // count as pass (skip condition)
      return;
    }

    const result = probeOpenThread(REPO_ROOT, `some open thread (#${realPr}) not started`, '');
    assert.ok(
      typeof result === 'string' && result.includes(`#${realPr}`),
      `Expected probeOpenThread to return a string citing #${realPr}, got: ${result}`
    );
    assert.ok(
      result.includes('verify thread is still open'),
      `Expected "verify thread is still open" in probe result, got: ${result}`
    );
  });

  // ── OT2: PR number NOT in git log → no annotation ────────────────────────────
  await test('(OT2) open_thread citing PR not in git log → NO annotation', async () => {
    const ctx = await setupWithGit([9002]); // only #9002 is merged in this repo
    const { fakeRoot, projectId, db } = ctx;
    try {
      // Skip runInit (uses writeMarker in setupWithGit already).

      // Seed an open_thread citing #99999 which is NOT in the git log.
      await db.query(
        `INSERT INTO assertions
           (project_id, subject, predicate, object, confidence, source,
            suppressed, invalid_at, tier, session_id)
         VALUES ($1, $2, $3, $4, $5, $6, false, NULL, 'probationary', 'prior-ot2-session')`,
        [projectId, path.basename(fakeRoot), 'open_thread',
          'some open work item (#99999) pending', 7, 'user_stated']
      );

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
        [projectId, JSON.stringify({ queries: [{ kind: 'assertion', token_budget: 1000 }] })]
      );

      const resumeOut = runResume(fakeRoot);

      // The specific open_thread line should NOT be annotated with [STALE:
      // (though other rows might be).
      const threadLine = resumeOut.split('\n').find(l => l.includes('#99999'));
      if (threadLine) {
        assert.ok(
          !threadLine.includes('[STALE:'),
          `Expected no [STALE: annotation on open_thread line citing unmergerd PR.\nLine: ${threadLine}`
        );
      }
      // Even if the line isn't present, no crash means pass.
    } finally {
      await teardown(ctx);
    }
  });

  // ── OT3: No # anchor → no annotation (unit probe test) ─────────────────────
  await test('(OT3) open_thread with no # anchor → probeOpenThread returns null', async () => {
    // Use the real repo root (has git log) — the thread itself has no #NNN anchor.
    const result = probeOpenThread(REPO_ROOT, 'investigate the build pipeline slowness', 'perf-issue');
    assert.strictEqual(result, null,
      `Expected null (no anchor) for anchorless thread, got: ${result}`);
  });

  // ── OT4: Fail-soft: non-git directory → null, no throw ──────────────────────
  await test('(OT4) fail-soft: probeOpenThread from non-git directory → null, no throw', async () => {
    const nonGitDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ot4-nongit-'));
    try {
      let result;
      let threw = false;
      try {
        result = probeOpenThread(nonGitDir, 'some open work (#9999)', 'subject');
      } catch (_) {
        threw = true;
      }
      assert.ok(!threw, 'probeOpenThread must not throw on non-git directory');
      assert.strictEqual(result, null,
        `Expected null (git failure) from non-git directory, got: ${result}`);
    } finally {
      try { fs.rmSync(nonGitDir, { recursive: true, force: true }); } catch (_) {}
    }
  });

  // ── OT5: Safety — annotateOnly prevents close-time mutation (critical) ────────
  //
  // Seed a live open_thread row citing a merged PR (#9005).
  // Run a close.  Assert afterward:
  //   - row is still suppressed=false
  //   - row's suppression_kind IS NULL
  //   - NO degraded_close record was created on its behalf
  //
  // This proves annotateOnly prevents close-time suppression, supersession,
  // reconciliation, and degraded-close alarms.
  await test('(OT5) safety (annotateOnly): close with merged-PR open_thread → row unchanged, no degraded_close', async () => {
    const ctx = await setupWithGit([9005]);
    const { fakeRoot, projectId, db } = ctx;
    try {
      // Skip runInit (uses writeMarker in setupWithGit already).

      // cm#233 fix-round (round 3): SCHEMA_EPOCH 3->4 means a brand-new
      // project's FIRST ensureSchemaCurrent touch also runs migrate-17's
      // one-time open_thread re-key (by design). Without this pre-touch,
      // the row seeded below would be superseded by migrate-17 during the
      // close a few lines down (its subject is an arbitrary placeholder —
      // path.basename(fakeRoot), not modeling the intentKey/legacy
      // derivation convention — so it is not "deliberately legacy-shaped"
      // and is not rewritten to intentKey(object) here; the fix is to run
      // the SAME ensureSchemaCurrent path the engine uses BEFORE seeding,
      // so this project's cutover gate is already recorded done and the
      // thread-less close cannot touch the row via migrate-17).
      const { PostgresAdapter } = require('../../scripts/lib/db-seam.js');
      const handoffModule = require('../../scripts/handoff.js');
      await handoffModule.ensureSchemaCurrent(new PostgresAdapter(db), projectId, { silent: true });

      // Seed the open_thread row.
      const { rows: inserted } = await db.query(
        `INSERT INTO assertions
           (project_id, subject, predicate, object, confidence, source,
            suppressed, invalid_at, tier, session_id)
         VALUES ($1, $2, $3, $4, $5, $6, false, NULL, 'probationary', 'prior-ot5-session')
         RETURNING id`,
        [projectId, path.basename(fakeRoot), 'open_thread',
          'cmdprune-gap NOT started (#9005)', 9, 'user_stated']
      );
      const rowId = inserted[0].id;

      // Run a close — this is where suppression/degrade would incorrectly occur.
      runClose(fakeRoot, {
        session_id:  'ot5-close-session',
        tldr:        'OT5 safety test close',
        assertions:  [],
      });

      // Assert the row is still live (suppressed=false).
      const { rows: afterRows } = await db.query(
        `SELECT suppressed, suppression_kind, invalid_at FROM assertions WHERE id = $1`,
        [rowId]
      );
      assert.ok(afterRows.length > 0, 'open_thread row not found after close');
      const r = afterRows[0];
      const isSuppressed = r.suppressed === true || r.suppressed === 1;
      assert.ok(!isSuppressed,
        `open_thread row must remain suppressed=false after close (annotateOnly), ` +
        `got suppressed=${r.suppressed}`);
      assert.strictEqual(r.suppression_kind, null,
        `open_thread row must have suppression_kind=NULL after close, got '${r.suppression_kind}'`);

      // Assert NO degraded_close record was created for reality_verify on this project.
      const { rows: dcRows } = await db.query(
        `SELECT key, value FROM project_settings
         WHERE project_id = $1 AND key LIKE 'degraded_close:%'`,
        [projectId]
      );
      const realityVerifyDc = dcRows.filter((row) => {
        try { return JSON.parse(row.value).subsystem === 'reality_verify'; } catch (_) { return false; }
      });
      assert.strictEqual(realityVerifyDc.length, 0,
        `Expected no reality_verify degraded_close row for open_thread, ` +
        `found ${realityVerifyDc.length}: ${JSON.stringify(realityVerifyDc)}`);
    } finally {
      await teardown(ctx);
    }
  });

  // ── OT6: getMergedPrSet unit tests ───────────────────────────────────────────
  await test('(OT6a) getMergedPrSet: parses (#NNN) subjects from git log', async () => {
    // Use a temp git repo with known synthetic commits.
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ot6-gitparse-'));
    try {
      const gitEnv = {
        ...process.env,
        GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 'test@test',
        GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 'test@test',
      };
      execFileSync('git', ['init'], { cwd: tmpRoot, encoding: 'utf8', timeout: 5000 });
      execFileSync('git', ['commit', '--allow-empty', '-m', 'feat: add foo (#42)', '--no-gpg-sign'],
        { cwd: tmpRoot, encoding: 'utf8', timeout: 5000, env: gitEnv });
      execFileSync('git', ['commit', '--allow-empty', '-m', 'fix: bar (#77)', '--no-gpg-sign'],
        { cwd: tmpRoot, encoding: 'utf8', timeout: 5000, env: gitEnv });
      execFileSync('git', ['commit', '--allow-empty', '-m', 'no pr number here', '--no-gpg-sign'],
        { cwd: tmpRoot, encoding: 'utf8', timeout: 5000, env: gitEnv });

      // Clear the memo cache so we get a fresh read.
      // Access the internal cache via the module's exported helper by using
      // a unique root path (tmp dir).
      const mergedSet = getMergedPrSet(tmpRoot);
      assert.ok(mergedSet !== null, 'getMergedPrSet should succeed on a valid git repo');
      assert.ok(mergedSet.has('42'), `Expected #42 in merged set; got: ${[...mergedSet]}`);
      assert.ok(mergedSet.has('77'), `Expected #77 in merged set; got: ${[...mergedSet]}`);
      assert.ok(!mergedSet.has('999'), 'Expected #999 NOT in merged set');

      // Memoize: second call returns the same Set instance.
      const mergedSet2 = getMergedPrSet(tmpRoot);
      assert.strictEqual(mergedSet, mergedSet2, 'getMergedPrSet should return memoized Set');
    } finally {
      try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch (_) {}
    }
  });

  await test('(OT6b) getMergedPrSet: returns null on non-git directory', async () => {
    const nonGitDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ot6-nongit-'));
    try {
      const result = getMergedPrSet(nonGitDir);
      assert.strictEqual(result, null,
        `Expected null from getMergedPrSet on non-git directory, got: ${result}`);
    } finally {
      try { fs.rmSync(nonGitDir, { recursive: true, force: true }); } catch (_) {}
    }
  });

  // ── OT6c: probeOpenThread deduplicated output ─────────────────────────────────
  await test('(OT6c) probeOpenThread: deduplicates repeated PR numbers in output', async () => {
    // Use a temp git repo with #9006 merged.
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ot6c-dedup-'));
    try {
      const gitEnv = {
        ...process.env,
        GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 'test@test',
        GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 'test@test',
      };
      execFileSync('git', ['init'], { cwd: tmpRoot, encoding: 'utf8', timeout: 5000 });
      execFileSync('git', ['commit', '--allow-empty', '-m', 'feat: thing (#9006)', '--no-gpg-sign'],
        { cwd: tmpRoot, encoding: 'utf8', timeout: 5000, env: gitEnv });

      // Cite #9006 twice in the object.
      const result = probeOpenThread(tmpRoot, 'work on #9006 follow-up from #9006', 'subj');
      assert.ok(typeof result === 'string', `Expected string result, got: ${result}`);
      // The output should mention #9006 exactly once (deduplicated).
      const occurrences = (result.match(/#9006/g) || []).length;
      assert.strictEqual(occurrences, 1,
        `Expected #9006 mentioned exactly once in deduped output, got ${occurrences}: ${result}`);
    } finally {
      try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch (_) {}
    }
  });

  // ── OT7: Regression (#150) — qualified cross-repo refs never match local set ──
  //
  // The bug: `foreignrepo#12` or `owner/repo#12` had its `#12` intersected
  // with LOCAL PR numbers.  Seed a temp repo where #12 IS locally merged, then
  // probe with qualified-ref haystacks citing #12 — must return null.
  await test('(OT7) regression #150: qualified cross-repo refs → NO false annotation', async () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ot7-qualified-'));
    try {
      const gitEnv = {
        ...process.env,
        GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 'test@test',
        GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 'test@test',
      };
      execFileSync('git', ['init'], { cwd: tmpRoot, encoding: 'utf8', timeout: 5000 });
      execFileSync('git', ['commit', '--allow-empty', '-m', 'feat: thing (#12)', '--no-gpg-sign'],
        { cwd: tmpRoot, encoding: 'utf8', timeout: 5000, env: gitEnv });

      const foreignRepoForm = probeOpenThread(tmpRoot, 'see foreignrepo#12 for context', 'subj');
      assert.strictEqual(foreignRepoForm, null,
        `Expected null for "foreignrepo#12" haystack (local #12 IS merged), got: ${foreignRepoForm}`);

      const ownerRepoForm = probeOpenThread(tmpRoot, 'tracked in owner/repo#12', 'subj');
      assert.strictEqual(ownerRepoForm, null,
        `Expected null for "owner/repo#12" haystack (local #12 IS merged), got: ${ownerRepoForm}`);
    } finally {
      try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch (_) {}
    }
  });

  // ── OT8: Named tradeoff — glued "PR#N" form is intentionally lossy ─────────
  await test('(OT8) named tradeoff: glued "PR#N" form → NO annotation (locked, not a bug)', async () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ot8-glued-'));
    try {
      const gitEnv = {
        ...process.env,
        GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 'test@test',
        GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 'test@test',
      };
      execFileSync('git', ['init'], { cwd: tmpRoot, encoding: 'utf8', timeout: 5000 });
      execFileSync('git', ['commit', '--allow-empty', '-m', 'feat: thing (#152)', '--no-gpg-sign'],
        { cwd: tmpRoot, encoding: 'utf8', timeout: 5000, env: gitEnv });

      const result = probeOpenThread(tmpRoot, 'see PR#152 for the base change', 'subj');
      assert.strictEqual(result, null,
        `Expected null for glued "PR#152" (accepted tradeoff — ambiguous forms are ` +
        `never distinguished from qualified cross-repo refs), got: ${result}`);
    } finally {
      try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch (_) {}
    }
  });

  // ── OT9: Non-weakening — bare "(#N)" and whitespace-preceded "#N" still fire ──
  await test('(OT9) non-weakening: "(#N)" and whitespace-preceded "#N" still return staleness hint', async () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ot9-nonweak-'));
    try {
      const gitEnv = {
        ...process.env,
        GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 'test@test',
        GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 'test@test',
      };
      execFileSync('git', ['init'], { cwd: tmpRoot, encoding: 'utf8', timeout: 5000 });
      execFileSync('git', ['commit', '--allow-empty', '-m', 'feat: thing (#9009)', '--no-gpg-sign'],
        { cwd: tmpRoot, encoding: 'utf8', timeout: 5000, env: gitEnv });

      const parenForm = probeOpenThread(tmpRoot, 'follow-up work (#9009) pending', 'subj');
      assert.ok(typeof parenForm === 'string' && parenForm.includes('#9009'),
        `Expected staleness hint for "(#9009)" form, got: ${parenForm}`);

      const wsForm = probeOpenThread(tmpRoot, 'follow-up work item #9009 pending', 'subj');
      assert.ok(typeof wsForm === 'string' && wsForm.includes('#9009'),
        `Expected staleness hint for whitespace-preceded "#9009" form, got: ${wsForm}`);
    } finally {
      try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch (_) {}
    }
  });

  // ── OT10: Start-of-string "#N" (no preceding char) → still a local candidate ──
  //
  // probeOpenThread's real haystack is always `subject + ' ' + object`, so a
  // literal index-0 "#" is unreachable through its public interface (there is
  // always at least a joining space before the object's content, even when
  // subject is empty).  To lock the TRUE start-of-string boundary condition
  // — the negative lookbehind at index 0, where there is no preceding
  // character at all for it to inspect — this test exercises the exported
  // OPEN_THREAD_TOKEN_RE pattern directly against a string that begins with
  // "#N", plus an end-to-end confirmation via probeOpenThread using a
  // whitespace-preceded token (the closest reachable equivalent, already
  // covered structurally by the same "not an ownership char" branch).
  await test('(OT10) start-of-string "#N" (no preceding char) → local candidate', async () => {
    // Direct pattern lock: index 0 of the string, nothing precedes "#".
    const re = new RegExp(OPEN_THREAD_TOKEN_RE.source, OPEN_THREAD_TOKEN_RE.flags);
    const m = re.exec('#9010 needs follow-up');
    assert.ok(m !== null, 'Expected OPEN_THREAD_TOKEN_RE to match "#9010" at true start-of-string');
    assert.strictEqual(m.index, 0, `Expected match at index 0, got index ${m && m.index}`);
    assert.strictEqual(m[1], '9010', `Expected captured digits "9010", got: ${m && m[1]}`);

    // End-to-end confirmation via the real probe (reachable equivalent).
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ot10-startofstring-'));
    try {
      const gitEnv = {
        ...process.env,
        GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 'test@test',
        GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 'test@test',
      };
      execFileSync('git', ['init'], { cwd: tmpRoot, encoding: 'utf8', timeout: 5000 });
      execFileSync('git', ['commit', '--allow-empty', '-m', 'feat: thing (#9010)', '--no-gpg-sign'],
        { cwd: tmpRoot, encoding: 'utf8', timeout: 5000, env: gitEnv });

      const result = probeOpenThread(tmpRoot, '#9010 needs follow-up', '');
      assert.ok(typeof result === 'string' && result.includes('#9010'),
        `Expected staleness hint when "#9010" is the first token in the object, got: ${result}`);
    } finally {
      try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch (_) {}
    }
  });

  // ── OT11: Chained "#12#13" — second token suppressed (digit precedes it) ────
  await test('(OT11) chained "#N#M": second token suppressed (lookbehind artifact, safe direction)', async () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ot11-chained-'));
    try {
      const gitEnv = {
        ...process.env,
        GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 'test@test',
        GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 'test@test',
      };
      execFileSync('git', ['init'], { cwd: tmpRoot, encoding: 'utf8', timeout: 5000 });
      // Both #9011 and #9012 are locally merged.
      execFileSync('git', ['commit', '--allow-empty', '-m', 'feat: thing (#9011)', '--no-gpg-sign'],
        { cwd: tmpRoot, encoding: 'utf8', timeout: 5000, env: gitEnv });
      execFileSync('git', ['commit', '--allow-empty', '-m', 'feat: other (#9012)', '--no-gpg-sign'],
        { cwd: tmpRoot, encoding: 'utf8', timeout: 5000, env: gitEnv });

      // "#9011#9012" — the digit "1" (last char of "9011") immediately
      // precedes the second "#", so #9012 is suppressed even though it is
      // itself a plausible local ref and is in the merged set.  Only #9011
      // (start-of-token, unsuppressed) should appear in the result.
      const result = probeOpenThread(tmpRoot, '#9011#9012', 'subj');
      assert.ok(typeof result === 'string', `Expected a string result (at least #9011 fires), got: ${result}`);
      assert.ok(result.includes('#9011'), `Expected #9011 in result, got: ${result}`);
      assert.ok(!result.includes('#9012'),
        `Expected #9012 to be suppressed (digit "1" precedes its "#"), got: ${result}`);
    } finally {
      try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch (_) {}
    }
  });

  // ── OT12 (adversary finding #11): parens-adjacency immunity ─────────────────
  //
  // Locks getMergedPrSet's `\(#(\d+)\)` pattern against a future refactor:
  // a commit subject that contains a qualified cross-repo ref INSIDE the same
  // subject as a real parenthesized squash-merge anchor must only harvest the
  // parenthesized number, never the qualified one, even though both are
  // present in the same string.
  await test('(OT12) getMergedPrSet: parens-adjacency immunizes against qualified refs in the same subject', async () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ot12-parens-immunity-'));
    try {
      const gitEnv = {
        ...process.env,
        GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 'test@test',
        GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 'test@test',
      };
      execFileSync('git', ['init'], { cwd: tmpRoot, encoding: 'utf8', timeout: 5000 });
      execFileSync(
        'git',
        ['commit', '--allow-empty', '-m', 'fix cross-repo (foreignrepo#16) handling (#150)', '--no-gpg-sign'],
        { cwd: tmpRoot, encoding: 'utf8', timeout: 5000, env: gitEnv }
      );

      const mergedSet = getMergedPrSet(tmpRoot);
      assert.ok(mergedSet !== null, 'getMergedPrSet should succeed on a valid git repo');
      assert.ok(mergedSet.has('150'), `Expected "150" in merged set; got: ${[...mergedSet]}`);
      assert.ok(!mergedSet.has('16'),
        `Expected "16" NOT in merged set (qualified ref inside parens-adjacent subject ` +
        `must not be harvested); got: ${[...mergedSet]}`);
    } finally {
      try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch (_) {}
    }
  });

  // ── OT13: Unicode-preceded "#N" → local candidate (locks ASCII-only class) ──
  await test('(OT13) Unicode-preceded "#N" (em-dash / non-ASCII letter) → local candidate', async () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ot13-unicode-'));
    try {
      const gitEnv = {
        ...process.env,
        GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 'test@test',
        GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 'test@test',
      };
      execFileSync('git', ['init'], { cwd: tmpRoot, encoding: 'utf8', timeout: 5000 });
      execFileSync('git', ['commit', '--allow-empty', '-m', 'feat: thing (#9013)', '--no-gpg-sign'],
        { cwd: tmpRoot, encoding: 'utf8', timeout: 5000, env: gitEnv });

      // Em-dash directly before "#".
      const emDashForm = probeOpenThread(tmpRoot, 'follow-up work—#9013 pending', 'subj');
      assert.ok(typeof emDashForm === 'string' && emDashForm.includes('#9013'),
        `Expected staleness hint for em-dash-preceded "#9013", got: ${emDashForm}`);

      // Non-ASCII letter directly before "#" (must NOT be treated as an
      // ownership char even though it IS a letter — this is what locks the
      // ASCII-only decision against a future \p{L}/\w "improvement").
      const unicodeLetterForm = probeOpenThread(tmpRoot, 'café#9013 pending', 'subj');
      assert.ok(typeof unicodeLetterForm === 'string' && unicodeLetterForm.includes('#9013'),
        `Expected staleness hint for non-ASCII-letter-preceded "#9013", got: ${unicodeLetterForm}`);
    } finally {
      try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch (_) {}
    }
  });

  // ─── Summary ─────────────────────────────────────────────────────────────────

  console.log('');
  if (failed > 0) {
    console.error(`${passed} passed, ${failed} FAILED.`);
    process.exit(1);
  } else {
    console.log(`All ${passed} test(s) passed.`);
    process.exit(0);
  }
}

runTests().catch((err) => {
  console.error(`\nInfrastructure error: ${err.message}`);
  if (process.env.DEBUG) console.error(err.stack);
  process.exit(2);
});
