'use strict';

/**
 * test-handoff.js — Golden-path tests for the /handoff skill helper.
 *
 * Sets up a temporary project_id, runs each subcommand against
 * claude_memory_eval_test, and asserts row counts and file contents.
 *
 * Mirrors the structure of test/eval/eval-retrieval.js.
 *
 * Usage:
 *   node test/handoff/test-handoff.js
 *
 * Prerequisites:
 *   - Postgres running with claude_memory_eval_test database
 *   - Phase 2 schema already applied (entities, assertions, edges, etc.)
 *
 * Exit codes: 0 all-pass, 1 any failure, 2 infrastructure error.
 */

const assert = require('assert');
const path   = require('path');
const fs     = require('fs');
const os     = require('os');
const { execFileSync } = require('child_process');

const { loadConfig } = require('../../scripts/lib/shared');
const { encodeCwd }  = require('../../scripts/lib/encoded-cwd');
// pg lives in scripts/node_modules (the package.json root for this repo's deps)
const { Client }     = require('../../scripts/node_modules/pg');

// ─── CONFIG ───────────────────────────────────────────────────────────────────

const TARGET_DB  = 'claude_memory_eval_test';
const HELPER     = path.resolve(__dirname, '..', '..', 'scripts', 'handoff.js');
const PROJECT_ID = 'test--handoff--' + Date.now();  // unique to this test run

// ─── HELPERS ──────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function test(label, fn) {
  try {
    const result = fn();
    if (result && typeof result.then === 'function') {
      return result.then(() => {
        console.log(`PASS  ${label}`);
        passed++;
      }).catch((err) => {
        console.error(`FAIL  ${label}`);
        console.error(`      ${err.message}`);
        failed++;
      });
    }
    console.log(`PASS  ${label}`);
    passed++;
  } catch (err) {
    console.error(`FAIL  ${label}`);
    console.error(`      ${err.message}`);
    failed++;
  }
  return Promise.resolve();
}

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

async function countRows(client, table, projectId) {
  const { rows } = await client.query(
    `SELECT COUNT(*) AS n FROM ${table} WHERE project_id = $1`,
    [projectId]
  );
  return parseInt(rows[0].n, 10);
}

/** Run the handoff.js helper as a subprocess with a fake project root. */
function runHelper(sub, extraArgs = [], opts = {}) {
  // We fake the project root by pointing PROJECT_ROOT to a temp dir that has
  // a .git folder and a .claude/pipeline.yml so loadConfig() and findProjectRoot() work.
  const fakeRoot = opts.fakeRoot || global.__fakeRoot;
  const env = {
    ...process.env,
    PROJECT_ROOT: fakeRoot,
    HANDOFF_TEST_PROJECT_ID: PROJECT_ID,
  };
  return execFileSync(
    process.execPath,
    [HELPER, sub, ...extraArgs],
    {
      cwd: fakeRoot,
      env,
      encoding: 'utf8',
      timeout: 30000,
      input: opts.stdin || undefined,
    }
  );
}

// ─── SETUP ────────────────────────────────────────────────────────────────────

async function setup() {
  // Create a fake project root that handoff.js will discover
  const fakeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'handoff-test-'));
  global.__fakeRoot = fakeRoot;

  // Create .git dir so findProjectRoot() stops here
  fs.mkdirSync(path.join(fakeRoot, '.git'));

  // Create .claude/pipeline.yml so loadConfig() finds DB config
  fs.mkdirSync(path.join(fakeRoot, '.claude'));
  fs.writeFileSync(path.join(fakeRoot, '.claude', 'pipeline.yml'), `
project:
  name: handoff-test

knowledge:
  tier: "postgres"
  host: "localhost"
  port: 5432
  database: "${TARGET_DB}"
  user: "postgres"
`.trim(), 'utf8');

  // Also create a minimal scripts/handoff.js stub check path
  fs.mkdirSync(path.join(fakeRoot, 'scripts', 'lib'), { recursive: true });
  // Symlink is cross-platform-awkward; copy just enough for the check
  // The command files check for `scripts/handoff.js` existence in their walk-up logic

  console.log(`\n  test project_id: ${PROJECT_ID}`);
  console.log(`  fake root:       ${fakeRoot}`);

  // Ensure DB tables exist (run phase2 schema)
  let db;
  try {
    db = await connectDb();
  } catch (err) {
    console.error(`\nInfrastructure error: cannot connect to ${TARGET_DB}: ${err.message}`);
    console.error('Run: psql -U postgres -c "CREATE DATABASE claude_memory_eval_test;"');
    process.exit(2);
  }

  // Apply phase2 schema (idempotent)
  const schemaFile = path.resolve(__dirname, '..', '..', 'scripts', 'sql', 'phase2-schema.sql');
  if (fs.existsSync(schemaFile)) {
    let sql = fs.readFileSync(schemaFile, 'utf8');
    sql = sql.replace(/^\\[a-z].*$/gm, '');
    try {
      await db.query(sql);
    } catch (err) {
      // May already exist — non-fatal
      if (!err.message.includes('already exists')) {
        console.warn(`  Schema apply warning: ${err.message}`);
      }
    }
  }

  await db.end();
  return fakeRoot;
}

// ─── TEARDOWN ─────────────────────────────────────────────────────────────────

async function teardown() {
  const fakeRoot = global.__fakeRoot;
  const encodedFakeRoot = fakeRoot ? encodeCwd(fakeRoot) : null;

  let db;
  try {
    db = await connectDb();
    const tables = ['edges', 'assertions', 'entities', 'retrieval_contract', 'project_settings'];
    for (const tbl of tables) {
      if (encodedFakeRoot) {
        await db.query(`DELETE FROM ${tbl} WHERE project_id = $1`, [encodedFakeRoot]);
      }
    }
    await db.end();
  } catch (_) {
    // best-effort cleanup
  }

  // Remove fake root
  try {
    fs.rmSync(fakeRoot, { recursive: true, force: true });
  } catch (_) {}

  // Remove any handoff.md created under ~/.claude/projects/<encoded_fakeRoot>/
  try {
    const { getClaudeProjectDir } = require('../../scripts/lib/encoded-cwd');
    const dir = getClaudeProjectDir(fakeRoot);
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  } catch (_) {}
}

// ─── TESTS ────────────────────────────────────────────────────────────────────

async function runTests() {
  const fakeRoot = await setup();
  let db = await connectDb();

  // ── Test 1: init creates DB rows and handoff.md ──────────────────────────
  const encodedRoot = encodeCwd(fakeRoot);

  await test('init: creates project_settings defaults', async () => {
    runHelper('init', [], { fakeRoot });
    const { rows } = await db.query(
      'SELECT COUNT(*) AS n FROM project_settings WHERE project_id = $1',
      [encodedRoot]
    );
    const n = parseInt(rows[0].n, 10);
    assert.ok(n >= 5, `Expected >= 5 project_settings rows for ${encodedRoot}, got ${n}`);
  });

  await test('init: creates retrieval_contract default row', async () => {
    const { rows: r2 } = await db.query(
      "SELECT name FROM retrieval_contract WHERE project_id = $1 AND name = 'default'",
      [encodedRoot]
    );
    assert.ok(r2.length >= 1, `Expected retrieval_contract 'default' row for project ${encodedRoot}`);
  });

  await test('init: creates handoff.md', () => {
    const { getClaudeProjectDir } = require('../../scripts/lib/encoded-cwd');
    const dir = getClaudeProjectDir(fakeRoot);
    const handoffPath = path.join(dir, 'handoff.md');
    assert.ok(fs.existsSync(handoffPath), `Expected handoff.md at ${handoffPath}`);
    const content = fs.readFileSync(handoffPath, 'utf8');
    assert.ok(content.includes('project_id:'), 'handoff.md should have project_id frontmatter');
    assert.ok(content.includes('last_close:'), 'handoff.md should have last_close frontmatter');
    assert.ok(content.includes('# Handoff'), 'handoff.md should have # Handoff heading');
  });

  await test('init is idempotent (can be run twice)', () => {
    // Should not throw on second run
    runHelper('init', [], { fakeRoot });
  });

  // ── Test 2: status is read-only and outputs expected fields ──────────────
  await test('status: outputs project_id and counts', () => {
    const out = runHelper('status', [], { fakeRoot });
    assert.ok(out.includes('entities:'),   'status should show entities count');
    assert.ok(out.includes('assertions:'), 'status should show assertions count');
    assert.ok(out.includes('edges:'),      'status should show edges count');
    assert.ok(out.includes('Done: handoff:status'), 'status should emit Done line');
  });

  // ── Test 3: close writes entities/assertions/edges from JSON stdin ────────
  const closePayload = {
    entities: [
      { name: 'TestEntity',  entity_type: 'system',  description: 'A test entity' },
      { name: 'TestEntity2', entity_type: 'concept', description: 'Another test entity' },
    ],
    assertions: [
      { subject: 'TestEntity', predicate: 'uses', object: 'Postgres', confidence: 8, source: 'model_extracted' },
      { subject: 'TestEntity', predicate: 'status', object: 'active',  confidence: 7, source: 'user_stated' },
    ],
    edges: [
      { from_entity: 'TestEntity', edge_type: 'depends_on', to_entity: 'TestEntity2', weight: 1.0 },
    ],
    contract: { queries: [{ type: 'recency', token_budget: 500 }] },
    tldr: 'Test session closed successfully.',
    open_threads: ['verify edge weights', 'add more entities'],
    quick_references: 'TestEntity = main test fixture',
    session_id: 'test-session-001',
  };

  await test('close: writes entities to DB', async () => {
    runHelper('close', ['--json', '-'], { fakeRoot, stdin: JSON.stringify(closePayload) });
    const { rows } = await db.query(
      'SELECT COUNT(*) AS n FROM entities WHERE project_id = $1',
      [encodedRoot]
    );
    assert.strictEqual(parseInt(rows[0].n, 10), 2, `Expected 2 entities, got ${rows[0].n}`);
  });

  await test('close: writes assertions to DB', async () => {
    const { rows } = await db.query(
      'SELECT COUNT(*) AS n FROM assertions WHERE project_id = $1',
      [encodedRoot]
    );
    assert.ok(parseInt(rows[0].n, 10) >= 2, `Expected >= 2 assertions, got ${rows[0].n}`);
  });

  await test('close: writes edges to DB', async () => {
    const { rows } = await db.query(
      'SELECT COUNT(*) AS n FROM edges WHERE project_id = $1',
      [encodedRoot]
    );
    assert.ok(parseInt(rows[0].n, 10) >= 1, `Expected >= 1 edge, got ${rows[0].n}`);
  });

  await test('close: updates retrieval_contract', async () => {
    const { rows } = await db.query(
      "SELECT queries FROM retrieval_contract WHERE project_id = $1 AND name = 'default'",
      [encodedRoot]
    );
    assert.ok(rows.length >= 1, 'Expected retrieval_contract default row');
    const q = rows[0].queries;
    assert.ok(q && q.queries && Array.isArray(q.queries), 'queries should be an object with queries array');
  });

  await test('close: rewrites handoff.md with correct content', () => {
    const { getClaudeProjectDir } = require('../../scripts/lib/encoded-cwd');
    const dir = getClaudeProjectDir(fakeRoot);
    const handoffPath = path.join(dir, 'handoff.md');
    const content = fs.readFileSync(handoffPath, 'utf8');
    assert.ok(content.includes('Test session closed successfully.'), 'handoff.md should contain TL;DR');
    assert.ok(content.includes('## Open threads'), 'handoff.md should have Open threads section');
    assert.ok(content.includes('verify edge weights'), 'handoff.md should list open threads');
  });

  await test('close: clears session_in_progress marker', async () => {
    const { rows } = await db.query(
      "SELECT value FROM project_settings WHERE project_id = $1 AND key = 'session_in_progress'",
      [encodedRoot]
    );
    assert.strictEqual(rows.length, 0, 'session_in_progress should be cleared after close');
  });

  await test('close: emits Done line', () => {
    const out = runHelper('close', ['--json', '-'], { fakeRoot, stdin: JSON.stringify(closePayload) });
    assert.ok(out.includes('Done: handoff:close'), 'close should emit Done line');
  });

  // ── Test 4: checkpoint writes rows but does NOT clear session_in_progress ─
  const checkpointPayload = {
    ...closePayload,
    entities: [{ name: 'CheckpointEntity', entity_type: 'decision', description: 'Checkpoint test' }],
    assertions: [{ subject: 'CheckpointEntity', predicate: 'state', object: 'testing', confidence: 6, source: 'model_extracted' }],
    edges: [],
    session_id: 'test-session-002',
  };

  // First set a session_in_progress marker
  await db.query(
    `INSERT INTO project_settings (project_id, key, value) VALUES ($1, 'session_in_progress', 'test-session-002')
     ON CONFLICT (project_id, key) DO UPDATE SET value = EXCLUDED.value`,
    [encodedRoot]
  );

  await test('checkpoint: writes entities to DB', async () => {
    runHelper('checkpoint', ['--json', '-'], { fakeRoot, stdin: JSON.stringify(checkpointPayload) });
    const { rows } = await db.query(
      "SELECT COUNT(*) AS n FROM entities WHERE project_id = $1 AND name = 'CheckpointEntity'",
      [encodedRoot]
    );
    assert.strictEqual(parseInt(rows[0].n, 10), 1, 'Expected CheckpointEntity to be written');
  });

  await test('checkpoint: does NOT clear session_in_progress', async () => {
    const { rows } = await db.query(
      "SELECT value FROM project_settings WHERE project_id = $1 AND key = 'session_in_progress'",
      [encodedRoot]
    );
    assert.strictEqual(rows.length, 1, 'session_in_progress should remain after checkpoint');
  });

  await test('checkpoint: emits Done line', () => {
    const out = runHelper('checkpoint', ['--json', '-'], { fakeRoot, stdin: JSON.stringify(checkpointPayload) });
    assert.ok(out.includes('Done: handoff:checkpoint'), 'checkpoint should emit Done line');
  });

  // ── Test 5: resume loads context ─────────────────────────────────────────
  await test('resume: emits Running and Done lines', () => {
    const out = runHelper('resume', [], { fakeRoot });
    assert.ok(out.includes('Running: handoff:resume'), 'resume should emit Running line');
    assert.ok(out.includes('Done: handoff:resume'), 'resume should emit Done line');
  });

  await test('resume: seeds session_in_progress marker', async () => {
    // Resume may have triggered identity resolution (ensureProjectIdentity), which mints a
    // .claude-memory UUID marker in fakeRoot and writes all DB rows under that UUID — not
    // under the legacy encodedRoot.  Resolve the actual project_id by reading the marker
    // if present; fall back to encodedRoot for repos that have not yet been migrated.
    const markerPath = path.join(fakeRoot, '.claude-memory');
    let resumeProjectId = encodedRoot;
    if (fs.existsSync(markerPath)) {
      try {
        const markerText = fs.readFileSync(markerPath, 'utf8');
        const uuidMatch  = markerText.match(/"uuid"\s*:\s*"([^"]+)"/);
        if (uuidMatch) resumeProjectId = uuidMatch[1];
      } catch (_) { /* ignore — fall back to encodedRoot */ }
    }

    // Clear any existing marker under whichever project_id resume will use.
    await db.query(
      "DELETE FROM project_settings WHERE project_id = $1 AND key = 'session_in_progress'",
      [resumeProjectId]
    );
    runHelper('resume', [], { fakeRoot });
    const { rows } = await db.query(
      "SELECT value FROM project_settings WHERE project_id = $1 AND key = 'session_in_progress'",
      [resumeProjectId]
    );
    assert.strictEqual(rows.length, 1, 'session_in_progress should be set after resume');
    // Value should be an ISO timestamp (non-empty string).
    assert.ok(rows[0].value && rows[0].value.length > 0, 'session_in_progress value should be a non-empty ISO timestamp');
  });

  // ── Test 6: drop zeroes assertions and archives handoff.md ───────────────
  await test('drop: emits Running and Done lines', () => {
    const out = runHelper('drop', [], { fakeRoot });
    assert.ok(out.includes('Running: handoff:drop'), 'drop should emit Running line');
    assert.ok(out.includes('Done: handoff:drop'),    'drop should emit Done line');
    assert.ok(out.includes('assertions suppressed'), 'drop should report suppressed count');
  });

  await test('drop: creates fresh handoff.md', () => {
    const { getClaudeProjectDir } = require('../../scripts/lib/encoded-cwd');
    const dir = getClaudeProjectDir(fakeRoot);
    const handoffPath = path.join(dir, 'handoff.md');
    assert.ok(fs.existsSync(handoffPath), 'handoff.md should exist after drop');
    const content = fs.readFileSync(handoffPath, 'utf8');
    assert.ok(content.includes('dropped'), 'fresh handoff.md should mention drop');
  });

  await test('drop: archives old handoff.md', () => {
    const { getClaudeProjectDir } = require('../../scripts/lib/encoded-cwd');
    const dir = getClaudeProjectDir(fakeRoot);
    const files = fs.readdirSync(dir);
    const archived = files.some((f) => f.includes('.archived.md'));
    assert.ok(archived, 'Expected an archived handoff.*.archived.md file');
  });

  // ── Test 7: purge with --yes flag deletes all rows ───────────────────────
  await test('purge --yes: deletes all project rows', async () => {
    // Re-insert a row so we have something to delete
    await db.query(
      `INSERT INTO project_settings (project_id, key, value) VALUES ($1, 'test_key', 'test_val')
       ON CONFLICT DO NOTHING`,
      [encodedRoot]
    );
    runHelper('purge', ['--yes'], { fakeRoot });
    const n = await countRows(db, 'project_settings', encodedRoot);
    assert.strictEqual(n, 0, `Expected 0 project_settings rows after purge, got ${n}`);
    const ne = await countRows(db, 'entities', encodedRoot);
    assert.strictEqual(ne, 0, `Expected 0 entities after purge, got ${ne}`);
    const na = await countRows(db, 'assertions', encodedRoot);
    assert.strictEqual(na, 0, `Expected 0 assertions after purge, got ${na}`);
  });

  await test('purge --yes: removes handoff.md', () => {
    const { getClaudeProjectDir } = require('../../scripts/lib/encoded-cwd');
    const dir = getClaudeProjectDir(fakeRoot);
    const handoffPath = path.join(dir, 'handoff.md');
    assert.ok(!fs.existsSync(handoffPath), 'handoff.md should be removed after purge');
  });

  await test('purge --yes: emits Done line', () => {
    // Purge again (should be idempotent when nothing to delete)
    const out = runHelper('purge', ['--yes'], { fakeRoot });
    assert.ok(out.includes('Done: handoff:purge'), 'purge should emit Done line');
  });

  // ── Test 8: unknown subcommand exits 2 ────────────────────────────────────
  await test('unknown subcommand exits with code 2', () => {
    try {
      runHelper('nonexistent-cmd', [], { fakeRoot });
      assert.fail('Expected exit code 2');
    } catch (err) {
      assert.strictEqual(err.status, 2, `Expected exit code 2, got ${err.status}`);
    }
  });

  await db.end();
  await teardown();
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────

runTests().then(() => {
  console.log('');
  if (failed > 0) {
    console.error(`${passed} passed, ${failed} FAILED.`);
    process.exit(1);
  } else {
    console.log(`All ${passed} test(s) passed.`);
    process.exit(0);
  }
}).catch((err) => {
  console.error(`\nUnhandled error: ${err.message}`);
  if (process.env.DEBUG) console.error(err.stack);
  process.exit(2);
});
