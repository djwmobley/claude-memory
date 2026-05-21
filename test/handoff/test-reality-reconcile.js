'use strict';

/**
 * test-reality-reconcile.js — RED-before-green tests for Part 1 (reconcile-on-mismatch)
 * and Part 2 (degraded_close retention prune) of the reality-mismatch-reconcile feature.
 *
 * Coverage:
 *   R1  branch_exists close-time mismatch (1:1 predicate):
 *         stale row is suppressed by writeAssertionWithSupersession;
 *         a reality-correct successor row exists;
 *         NO degraded_close row for reality_verify;
 *         handoff.md has NO "## Degraded" section.
 *
 *   R2  Idempotency: second close after reconciliation produces no new mismatch
 *         and no new degraded_close:* record for reality_verify.
 *
 *   R3  in_file close-time mismatch (1:N predicate):
 *         stale row suppressed=true with suppression_kind='reality_reconciled';
 *         §7 no-backfill: confidence/source/object on the stale row are unchanged.
 *
 *   R4  degraded_close retention prune:
 *         seed three old degraded_close records (stamps < last_close);
 *         also seed one record with a newer stamp;
 *         run a clean close;
 *         assert old records deleted, newer record retained.
 *
 * Strategy: use the claude_memory_eval_test DB (same as other test/handoff tests).
 * Each test uses a fresh projectId (pre-minted marker) and cleans up after itself.
 *
 * Usage:
 *   PGHOST=localhost PGUSER=postgres PGPASSWORD=postgres \
 *     node test/handoff/test-reality-reconcile.js
 *
 * Exit codes: 0 all-pass, 1 any failure, 2 infrastructure error.
 */

const assert          = require('assert');
const path            = require('path');
const fs              = require('fs');
const os              = require('os');
const { execFileSync } = require('child_process');

const { loadConfig }  = require('../../scripts/lib/shared');
const { writeMarker } = require('../../scripts/lib/project-marker');
const { createRequire } = require('module');
const scriptsRequire  = createRequire(require.resolve('../../scripts/package.json'));
const { Client }      = scriptsRequire('pg');

// ─── CONFIG ───────────────────────────────────────────────────────────────────

const TARGET_DB = 'claude_memory_eval_test';
const HELPER    = path.resolve(__dirname, '..', '..', 'scripts', 'handoff.js');

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

async function setup() {
  const fakeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'reconcile-test-'));
  fs.mkdirSync(path.join(fakeRoot, '.git'));
  fs.mkdirSync(path.join(fakeRoot, '.claude'));
  fs.writeFileSync(path.join(fakeRoot, '.claude', 'pipeline.yml'), [
    'project:',
    '  name: reconcile-test',
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

  let db;
  try {
    db = await connectDb();
  } catch (err) {
    console.error(`\nInfrastructure error: cannot connect to ${TARGET_DB}: ${err.message}`);
    process.exit(2);
  }

  // Apply schemas idempotently.
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
    const dir = path.join(os.homedir(), '.claude', 'projects', projectId);
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
    [HELPER, 'init'],
    { cwd: fakeRoot, env: helperEnv(fakeRoot), encoding: 'utf8', timeout: 60000 }
  );
}

// ─── TESTS ────────────────────────────────────────────────────────────────────

async function runTests() {

  // ── R1: branch_exists mismatch (1:1) → superseded; NO degraded ───────────────

  await test('(R1) branch_exists mismatch: stale row superseded; reality-correct row written; no degraded_close', async () => {
    const ctx = await setup();
    const { fakeRoot, projectId, db } = ctx;
    try {
      // Initialize as a real git repo so branch probes work.
      execFileSync('git', ['init'], { cwd: fakeRoot, encoding: 'utf8', timeout: 10000 });
      execFileSync('git', ['commit', '--allow-empty', '-m', 'init', '--no-gpg-sign'],
        { cwd: fakeRoot, encoding: 'utf8', timeout: 10000,
          env: { ...process.env, GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 'test@test',
                 GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 'test@test' } });
      runInit(fakeRoot);

      // Seed a stale branch_exists row (branch definitely does not exist locally).
      const staleBranch = 'feat/this-branch-does-not-exist-reconcile-r1';
      await db.query(
        `INSERT INTO assertions
           (project_id, subject, predicate, object, confidence, source,
            suppressed, invalid_at, reality_check, tier, session_id)
         VALUES ($1, $2, $3, $4, $5, $6, false, NULL, 'verified', 'probationary', 'prior-r1-session')`,
        [projectId, staleBranch, 'branch_exists', 'true', 8, 'model_extracted']
      );

      runClose(fakeRoot, {
        session_id:  'r1-close-session',
        tldr:        'R1 reconcile test',
        assertions:  [],
      });

      // Stale row must now be suppressed.
      const { rows: staleRows } = await db.query(
        `SELECT suppressed, suppression_kind FROM assertions
         WHERE project_id = $1 AND predicate = 'branch_exists'
           AND session_id = 'prior-r1-session'`,
        [projectId]
      );
      assert.ok(staleRows.length > 0, 'Stale branch_exists row not found');
      const isSuppressed = staleRows[0].suppressed === true || staleRows[0].suppressed === 1;
      assert.ok(isSuppressed, `Stale row not suppressed: suppressed=${staleRows[0].suppressed}`);

      // A reality-correct successor must have been inserted (object='<absent>').
      const { rows: successorRows } = await db.query(
        `SELECT object, confidence, suppressed FROM assertions
         WHERE project_id = $1 AND predicate = 'branch_exists'
           AND subject = $2 AND suppressed = false`,
        [projectId, staleBranch]
      );
      assert.ok(successorRows.length > 0, 'No reality-correct successor row written after branch_exists reconcile');
      assert.strictEqual(successorRows[0].object, '<absent>',
        `Expected successor object='<absent>', got '${successorRows[0].object}'`);

      // NO degraded_close row for reality_verify.
      const { rows: dcRows } = await db.query(
        `SELECT key, value FROM project_settings
         WHERE project_id = $1 AND key LIKE 'degraded_close:%'`,
        [projectId]
      );
      const realityVerifyDc = dcRows.filter((r) => {
        try { return JSON.parse(r.value).subsystem === 'reality_verify'; } catch (_) { return false; }
      });
      assert.strictEqual(realityVerifyDc.length, 0,
        `Expected no reality_verify degraded_close row, found ${realityVerifyDc.length}`);

      // handoff.md must NOT contain "## Degraded".
      const handoffDir = path.join(os.homedir(), '.claude', 'projects', projectId);
      const handoffPath = path.join(handoffDir, 'handoff.md');
      if (fs.existsSync(handoffPath)) {
        const content = fs.readFileSync(handoffPath, 'utf8');
        assert.ok(!content.includes('## Degraded'),
          'handoff.md contains ## Degraded section but should not (reconcile, not degrade)');
      }
    } finally {
      await teardown(ctx);
    }
  });

  // ── R2: Idempotency — second close after reconciliation ───────────────────────

  await test('(R2) idempotency: second close after reconcile produces no new mismatch / no new degraded_close', async () => {
    const ctx = await setup();
    const { fakeRoot, projectId, db } = ctx;
    try {
      execFileSync('git', ['init'], { cwd: fakeRoot, encoding: 'utf8', timeout: 10000 });
      execFileSync('git', ['commit', '--allow-empty', '-m', 'init', '--no-gpg-sign'],
        { cwd: fakeRoot, encoding: 'utf8', timeout: 10000,
          env: { ...process.env, GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 'test@test',
                 GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 'test@test' } });
      runInit(fakeRoot);

      const staleBranch = 'feat/this-branch-does-not-exist-reconcile-r2';
      await db.query(
        `INSERT INTO assertions
           (project_id, subject, predicate, object, confidence, source,
            suppressed, invalid_at, reality_check, tier, session_id)
         VALUES ($1, $2, $3, $4, $5, $6, false, NULL, 'verified', 'probationary', 'prior-r2-session')`,
        [projectId, staleBranch, 'branch_exists', 'true', 7, 'model_extracted']
      );

      // First close — reconciles the stale row.
      runClose(fakeRoot, {
        session_id: 'r2-close-1',
        tldr:       'R2 first close',
        assertions: [],
      });

      // Count degraded_close rows after first close.
      const { rows: dc1 } = await db.query(
        `SELECT key FROM project_settings
         WHERE project_id = $1 AND key LIKE 'degraded_close:%'`,
        [projectId]
      );
      const realityDc1 = dc1.filter((r) => {
        // Key format doesn't contain subsystem — check absence only.
        return r.key.startsWith('degraded_close:');
      });

      // Second close — no stale rows remain; should be clean.
      runClose(fakeRoot, {
        session_id: 'r2-close-2',
        tldr:       'R2 second close',
        assertions: [],
      });

      // No new degraded_close:* row with subsystem='reality_verify' should appear.
      const { rows: dc2 } = await db.query(
        `SELECT key, value FROM project_settings
         WHERE project_id = $1 AND key LIKE 'degraded_close:%'`,
        [projectId]
      );
      const realityVerifyDc2 = dc2.filter((r) => {
        try { return JSON.parse(r.value).subsystem === 'reality_verify'; } catch (_) { return false; }
      });
      assert.strictEqual(realityVerifyDc2.length, 0,
        `Second close should have no reality_verify degraded_close row, found ${realityVerifyDc2.length}`);
    } finally {
      await teardown(ctx);
    }
  });

  // ── R3: in_file mismatch (1:N) → suppressed with reality_reconciled ───────────

  await test('(R3) in_file mismatch: stale row suppressed=true, suppression_kind=reality_reconciled, §7 no-backfill', async () => {
    const ctx = await setup();
    const { fakeRoot, projectId, db } = ctx;
    try {
      runInit(fakeRoot);

      // Seed a stale in_file row — file does not exist in fakeRoot.
      const staleFile = 'scripts/this-file-does-not-exist-reconcile-r3.js';
      await db.query(
        `INSERT INTO assertions
           (project_id, subject, predicate, object, confidence, source,
            suppressed, invalid_at, reality_check, tier, session_id)
         VALUES ($1, $2, $3, $4, $5, $6, false, NULL, 'verified', 'probationary', 'prior-r3-session')`,
        [projectId, 'r3-module', 'in_file', staleFile, 6, 'model_extracted']
      );

      runClose(fakeRoot, {
        session_id: 'r3-close-session',
        tldr:       'R3 in_file reconcile test',
        assertions: [],
      });

      // Stale row must be suppressed with suppression_kind='reality_reconciled'.
      const { rows: staleRows } = await db.query(
        `SELECT confidence, source, object, suppressed, suppression_kind, reality_check
         FROM assertions
         WHERE project_id = $1 AND predicate = 'in_file'
           AND session_id = 'prior-r3-session'`,
        [projectId]
      );
      assert.ok(staleRows.length > 0, 'Stale in_file row not found after close');
      const r = staleRows[0];

      const isSuppressed = r.suppressed === true || r.suppressed === 1;
      assert.ok(isSuppressed, `Expected suppressed=true, got ${r.suppressed}`);
      assert.strictEqual(r.suppression_kind, 'reality_reconciled',
        `Expected suppression_kind='reality_reconciled', got '${r.suppression_kind}'`);

      // §7: confidence/source/object must be unchanged.
      assert.strictEqual(Number(r.confidence), 6, `§7 violation: confidence changed to ${r.confidence}`);
      assert.strictEqual(r.source, 'model_extracted', `§7 violation: source changed to '${r.source}'`);
      assert.strictEqual(r.object, staleFile, `§7 violation: object changed to '${r.object}'`);

      // NO degraded_close row for reality_verify.
      const { rows: dcRows } = await db.query(
        `SELECT key, value FROM project_settings
         WHERE project_id = $1 AND key LIKE 'degraded_close:%'`,
        [projectId]
      );
      const realityVerifyDc = dcRows.filter((r2) => {
        try { return JSON.parse(r2.value).subsystem === 'reality_verify'; } catch (_) { return false; }
      });
      assert.strictEqual(realityVerifyDc.length, 0,
        `Expected no reality_verify degraded_close, found ${realityVerifyDc.length}`);
    } finally {
      await teardown(ctx);
    }
  });

  // ── R4: degraded_close retention prune ────────────────────────────────────────

  await test('(R4) degraded_close retention: records older than prior last_close are pruned; newer retained', async () => {
    const ctx = await setup();
    const { fakeRoot, projectId, db } = ctx;
    try {
      runInit(fakeRoot);

      // First close — establishes last_close in handoff.md.
      runClose(fakeRoot, {
        session_id: 'r4-close-1',
        tldr:       'R4 first close',
        assertions: [],
      });

      // Read the last_close stamp from handoff.md.
      const handoffPath = path.join(os.homedir(), '.claude', 'projects', projectId, 'handoff.md');
      assert.ok(fs.existsSync(handoffPath), 'handoff.md not found after first close');
      const handoffContent = fs.readFileSync(handoffPath, 'utf8');
      const lastCloseMatch = handoffContent.match(/last_close:\s*([\S]+)/);
      assert.ok(lastCloseMatch, 'last_close not found in handoff.md frontmatter');
      const firstLastClose = lastCloseMatch[1];

      // Seed three OLD degraded_close records with stamps strictly before firstLastClose.
      // Use ISO stamps earlier than any plausible last_close from this run.
      const oldStamps = [
        '2020-01-01T00:00:00.000Z',
        '2021-06-15T12:00:00.000Z',
        '2022-12-31T23:59:59.999Z',
      ];
      for (let i = 0; i < oldStamps.length; i++) {
        await db.query(
          `INSERT INTO project_settings (project_id, key, value)
           VALUES ($1, $2, $3)
           ON CONFLICT (project_id, key) DO UPDATE SET value = EXCLUDED.value`,
          [
            projectId,
            `degraded_close:${oldStamps[i]}:${i}`,
            JSON.stringify({ subsystem: 'C2', reason: `old-r4-${i}`, stamp: oldStamps[i] }),
          ]
        );
      }

      // Seed one NEW record with a stamp guaranteed to be newer than firstLastClose.
      // Use a stamp far in the future relative to the test run.
      const futureStamp = '2099-01-01T00:00:00.000Z';
      await db.query(
        `INSERT INTO project_settings (project_id, key, value)
         VALUES ($1, $2, $3)
         ON CONFLICT (project_id, key) DO UPDATE SET value = EXCLUDED.value`,
        [
          projectId,
          `degraded_close:${futureStamp}:0`,
          JSON.stringify({ subsystem: 'C3', reason: 'new-r4', stamp: futureStamp }),
        ]
      );

      // Second close — should prune old records, keep new record.
      runClose(fakeRoot, {
        session_id: 'r4-close-2',
        tldr:       'R4 second close',
        assertions: [],
      });

      // Old records must be deleted.
      for (let i = 0; i < oldStamps.length; i++) {
        const key = `degraded_close:${oldStamps[i]}:${i}`;
        const { rows } = await db.query(
          `SELECT key FROM project_settings WHERE project_id = $1 AND key = $2`,
          [projectId, key]
        );
        assert.strictEqual(rows.length, 0, `Expected old record '${key}' to be pruned, but it still exists`);
      }

      // New (future-stamped) record must be retained.
      const { rows: retainedRows } = await db.query(
        `SELECT key FROM project_settings
         WHERE project_id = $1 AND key = $2`,
        [projectId, `degraded_close:${futureStamp}:0`]
      );
      assert.ok(retainedRows.length > 0,
        `Expected future-stamped degraded_close record to be retained, but it was pruned`);
    } finally {
      await teardown(ctx);
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
