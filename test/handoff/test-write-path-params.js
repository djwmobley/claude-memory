'use strict';

/**
 * test-write-path-params.js — Tests for the three write-path command parameters:
 *
 *   checkpoint --note "<text>"
 *     Writes a single session_note assertion without requiring a JSON payload.
 *
 *   promote --subject/--predicate/--object  (promote by content)
 *     Resolves the matching live assertion(s) and promotes the unique match.
 *     Exits non-zero on zero matches or multiple matches.
 *
 *   promote --demote <id>
 *     Clears the promoted flag and removes the CLAUDE.md line.
 *
 *   close --dry-run
 *     Validates + previews without writing any rows. Row counts must be
 *     unchanged after the dry-run.
 *
 * Usage:
 *   node test/handoff/test-write-path-params.js
 *
 * Prerequisites:
 *   - Postgres running with claude_memory_eval_test database.
 *   - Phase 2 schema already applied (entities, assertions, edges, etc.).
 *
 * Exit codes: 0 all-pass, 1 any failure, 2 infrastructure error.
 */

const assert = require('assert');
const path   = require('path');
const fs     = require('fs');
const os     = require('os');
const { execFileSync, spawnSync } = require('child_process');

const { loadConfig }  = require('../../scripts/lib/shared');
const { encodeCwd }   = require('../../scripts/lib/encoded-cwd');
const { writeMarker } = require('../../scripts/lib/project-marker');

const { createRequire } = require('module');
const scriptsRequire = createRequire(require.resolve('../../scripts/package.json'));
const { Client }     = scriptsRequire('pg');

// ─── CONFIG ───────────────────────────────────────────────────────────────────

const TARGET_DB  = 'claude_memory_eval_test';
const HELPER     = path.resolve(__dirname, '..', '..', 'scripts', 'handoff.js');

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
        if (process.env.DEBUG) console.error(err.stack);
        failed++;
      });
    }
    console.log(`PASS  ${label}`);
    passed++;
  } catch (err) {
    console.error(`FAIL  ${label}`);
    console.error(`      ${err.message}`);
    if (process.env.DEBUG) console.error(err.stack);
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

/** Run the handoff.js helper as a subprocess. Returns stdout. Throws on non-zero exit. */
function runHelper(sub, extraArgs = [], opts = {}) {
  const fakeRoot = opts.fakeRoot || global.__fakeRoot;
  const env = {
    ...process.env,
    PROJECT_ROOT:              fakeRoot,
    HANDOFF_TEST_PROJECT_ID:   global.__legacyProjectId || '',
    OLLAMA_SKIP: '1',
    ...(opts.extraEnv || {}),
  };
  return execFileSync(
    process.execPath,
    [HELPER, sub, ...extraArgs],
    {
      cwd:      fakeRoot,
      env,
      encoding: 'utf8',
      timeout:  30000,
      input:    opts.stdin || undefined,
    }
  );
}

/** Like runHelper but captures both stdout and stderr without throwing. */
function runHelperBoth(sub, extraArgs = [], opts = {}) {
  const fakeRoot = opts.fakeRoot || global.__fakeRoot;
  const env = {
    ...process.env,
    PROJECT_ROOT:              fakeRoot,
    HANDOFF_TEST_PROJECT_ID:   global.__legacyProjectId || '',
    OLLAMA_SKIP: '1',
    ...(opts.extraEnv || {}),
  };
  const result = spawnSync(
    process.execPath,
    [HELPER, sub, ...extraArgs],
    {
      cwd:      fakeRoot,
      env,
      encoding: 'utf8',
      timeout:  30000,
      input:    opts.stdin || undefined,
    }
  );
  return {
    stdout:   result.stdout  || '',
    stderr:   result.stderr  || '',
    exitCode: result.status  != null ? result.status : 1,
  };
}

// ─── SETUP ────────────────────────────────────────────────────────────────────

async function setup() {
  const fakeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'handoff-write-path-test-'));
  global.__fakeRoot = fakeRoot;

  fs.mkdirSync(path.join(fakeRoot, '.git'));
  fs.mkdirSync(path.join(fakeRoot, '.claude'));
  fs.writeFileSync(path.join(fakeRoot, '.claude', 'pipeline.yml'), `
project:
  name: write-path-test

knowledge:
  tier: "postgres"
  host: "localhost"
  port: 5432
  database: "${TARGET_DB}"
  user: "postgres"
`.trim(), 'utf8');

  // Write a minimal CLAUDE.md for promote/demote tests.
  fs.writeFileSync(path.join(fakeRoot, 'CLAUDE.md'), `# write-path-test\n\n## Durable facts\n\n- (No durable facts promoted yet)\n`, 'utf8');

  const marker = writeMarker(fakeRoot);
  global.__projectId     = marker.uuid;
  global.__legacyProjectId = encodeCwd(fakeRoot);

  console.log(`\n  test project_id (uuid): ${marker.uuid}`);
  console.log(`  fake root:               ${fakeRoot}`);

  let db;
  try {
    db = await connectDb();
  } catch (err) {
    console.error(`\nInfrastructure error: cannot connect to ${TARGET_DB}: ${err.message}`);
    process.exit(2);
  }

  // Apply schema if needed.
  const sqlDir = path.resolve(__dirname, '..', '..', 'scripts', 'sql');
  for (const schemaName of ['handoff-core-schema.sql', 'app-retrieval-events-schema.sql']) {
    const schemaFile = path.join(sqlDir, schemaName);
    if (!fs.existsSync(schemaFile)) continue;
    let sql = fs.readFileSync(schemaFile, 'utf8');
    sql = sql.replace(/^\\[a-z].*$/gm, '');
    try {
      await db.query(sql);
    } catch (err) {
      if (!err.message.includes('already exists')) {
        console.warn(`  Schema apply warning (${schemaName}): ${err.message}`);
      }
    }
  }

  await db.end();
  return fakeRoot;
}

// ─── TEARDOWN ─────────────────────────────────────────────────────────────────

async function teardown() {
  const fakeRoot    = global.__fakeRoot;
  const projectUuid = global.__projectId;

  let db;
  try {
    db = await connectDb();
    const tables = ['edges', 'assertions', 'entities', 'retrieval_contract', 'project_settings'];
    const ids = [projectUuid, fakeRoot ? encodeCwd(fakeRoot) : null].filter(Boolean);
    for (const tbl of tables) {
      for (const id of ids) {
        await db.query(`DELETE FROM ${tbl} WHERE project_id = $1`, [id]);
      }
    }
    await db.end();
  } catch (_) {}

  try { if (fakeRoot) fs.rmSync(fakeRoot, { recursive: true, force: true }); } catch (_) {}
  try {
    if (projectUuid) {
      const dir = path.join(os.homedir(), '.claude', 'projects', projectUuid);
      if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
    }
  } catch (_) {}
}

// ─── TESTS ────────────────────────────────────────────────────────────────────

async function runTests() {
  const fakeRoot  = await setup();
  const db        = await connectDb();
  const projectId = global.__projectId;

  // Provision the project.
  runHelper('init', [], { fakeRoot });

  // ─── Feature 1: checkpoint --note ─────────────────────────────────────────

  await test('checkpoint --note: exits 0', () => {
    const result = runHelperBoth('checkpoint', ['--note', 'test session_note capture'], { fakeRoot });
    assert.strictEqual(result.exitCode, 0,
      `checkpoint --note should exit 0; got ${result.exitCode}. stderr: ${result.stderr}`);
  });

  await test('checkpoint --note: output mentions session_note written', () => {
    const result = runHelperBoth('checkpoint', ['--note', 'test note output check'], { fakeRoot });
    assert.ok(result.stdout.includes('session_note written'),
      `output should mention session_note written. stdout: ${result.stdout}`);
  });

  await test('checkpoint --note: writes a session_note row to the DB', async () => {
    const noteText = 'test-note-db-write-' + Date.now();
    runHelper('checkpoint', ['--note', noteText], { fakeRoot });

    const { rows } = await db.query(
      `SELECT id, subject, predicate, object, confidence, source
       FROM assertions
       WHERE project_id = $1 AND predicate = 'session_note' AND object = $2`,
      [projectId, noteText]
    );
    assert.strictEqual(rows.length, 1, 'exactly one session_note row should be written');
    assert.strictEqual(rows[0].predicate, 'session_note', 'predicate must be session_note');
    assert.strictEqual(rows[0].confidence, 8, 'confidence must be 8');
    assert.strictEqual(rows[0].source, 'user_stated', 'source must be user_stated');
  });

  await test('checkpoint --note: multiple notes accumulate (1:N — not superseded)', async () => {
    const note1 = 'accumulate-note-a-' + Date.now();
    const note2 = 'accumulate-note-b-' + Date.now();
    runHelper('checkpoint', ['--note', note1], { fakeRoot });
    runHelper('checkpoint', ['--note', note2], { fakeRoot });

    const { rows } = await db.query(
      `SELECT id FROM assertions
       WHERE project_id = $1 AND predicate = 'session_note'
         AND object IN ($2, $3) AND suppressed = false`,
      [projectId, note1, note2]
    );
    assert.strictEqual(rows.length, 2, 'both notes should remain live (1:N — not superseded)');
  });

  await test('checkpoint --note: missing text exits 2', () => {
    const result = runHelperBoth('checkpoint', ['--note'], { fakeRoot });
    assert.strictEqual(result.exitCode, 2,
      `checkpoint --note with no text should exit 2; got ${result.exitCode}`);
  });

  // ─── Feature 2: promote --subject / --predicate / --object ────────────────

  // Seed an assertion for promote-by-content tests.
  const promoteTestSubject  = 'promote-content-subject-' + Date.now();
  const promoteTestPredicate = 'uses';
  const promoteTestObject    = 'promote-content-object-' + Date.now();

  let seedAssertionId;
  {
    const { rows: seedRows } = await db.query(
      `INSERT INTO assertions (project_id, subject, predicate, object, confidence, source, suppressed)
       VALUES ($1, $2, $3, $4, 9, 'user_stated', false)
       RETURNING id`,
      [projectId, promoteTestSubject, promoteTestPredicate, promoteTestObject]
    );
    seedAssertionId = seedRows[0].id;
  }

  await test('promote --subject/--predicate/--object: exactly one match promotes it', () => {
    const result = runHelperBoth('promote', [
      '--subject',   promoteTestSubject,
      '--predicate', promoteTestPredicate,
      '--object',    promoteTestObject,
    ], { fakeRoot });
    assert.strictEqual(result.exitCode, 0,
      `promote by content should exit 0; got ${result.exitCode}. stderr: ${result.stderr}`);
    assert.ok(result.stdout.includes('Done: handoff:promote'),
      `output should include Done line. stdout: ${result.stdout}`);
  });

  await test('promote --subject/--predicate/--object: DB promoted flag is set', async () => {
    const { rows } = await db.query(
      `SELECT promoted FROM assertions WHERE id = $1`,
      [seedAssertionId]
    );
    assert.ok(rows.length > 0, 'assertion should still exist');
    assert.ok(rows[0].promoted, 'assertion promoted flag should be true');
  });

  await test('promote --subject only: zero matches exits non-zero', () => {
    const result = runHelperBoth('promote', [
      '--subject', 'nonexistent-subject-xyzzy-12345',
    ], { fakeRoot });
    assert.notStrictEqual(result.exitCode, 0,
      'zero content matches should exit non-zero');
    assert.ok(result.stderr.includes('no live assertion matches') || result.stdout.includes('no live assertion matches'),
      'output should mention no live assertion matches');
  });

  await test('promote --subject only: multiple matches exits non-zero with candidate list', async () => {
    // Seed two assertions with the same subject but different predicates.
    const multiSubject = 'multi-match-subject-' + Date.now();
    await db.query(
      `INSERT INTO assertions (project_id, subject, predicate, object, confidence, source, suppressed)
       VALUES ($1, $2, 'uses', 'alpha', 8, 'user_stated', false),
              ($1, $2, 'is',   'beta',  7, 'user_stated', false)`,
      [projectId, multiSubject]
    );

    const result = runHelperBoth('promote', ['--subject', multiSubject], { fakeRoot });
    assert.notStrictEqual(result.exitCode, 0,
      'multiple content matches should exit non-zero');
    // The candidate list should appear in stderr (our errors go to stderr).
    const combinedOutput = result.stdout + result.stderr;
    assert.ok(combinedOutput.includes('match') || combinedOutput.includes('disambiguate'),
      `output should mention multiple matches / disambiguate. combined: ${combinedOutput}`);
  });

  // ─── Feature 2b: promote --demote <id> ────────────────────────────────────

  // Use the seedAssertionId that was promoted above.
  await test('promote --demote: exits 0 on a promoted assertion', () => {
    const result = runHelperBoth('promote', ['--demote', String(seedAssertionId)], { fakeRoot });
    assert.strictEqual(result.exitCode, 0,
      `promote --demote should exit 0; got ${result.exitCode}. stderr: ${result.stderr}`);
    assert.ok(result.stdout.includes('Done: handoff:promote --demote'),
      `output should include Done line. stdout: ${result.stdout}`);
  });

  await test('promote --demote: DB promoted flag is cleared', async () => {
    const { rows } = await db.query(
      `SELECT promoted FROM assertions WHERE id = $1`,
      [seedAssertionId]
    );
    assert.ok(rows.length > 0, 'assertion should still exist');
    assert.ok(!rows[0].promoted, 'assertion promoted flag should be false after demote');
  });

  await test('promote --demote: idempotent on non-promoted assertion exits 0', () => {
    const result = runHelperBoth('promote', ['--demote', String(seedAssertionId)], { fakeRoot });
    assert.strictEqual(result.exitCode, 0,
      'demote on non-promoted assertion should exit 0 (idempotent)');
    assert.ok(result.stdout.includes('not currently promoted'),
      'output should say not currently promoted');
  });

  await test('promote --demote: missing id exits 2', () => {
    const result = runHelperBoth('promote', ['--demote'], { fakeRoot });
    assert.strictEqual(result.exitCode, 2,
      `promote --demote with no id should exit 2; got ${result.exitCode}`);
  });

  // ─── Feature 3: close --dry-run ───────────────────────────────────────────

  // Seed some initial data so counts are non-zero.
  const dryRunPayload = {
    entities: [
      { name: 'DryRunEntity', entity_type: 'system', description: 'Dry-run test entity' },
    ],
    assertions: [
      { subject: 'DryRunEntity', predicate: 'uses', object: 'Postgres', confidence: 8, source: 'model_extracted' },
    ],
    edges:    [],
    contract: { queries: [{ type: 'recency', token_budget: 500 }] },
    tldr:     'dry-run test seeded',
    open_threads: ['verify dry-run works'],
    session_id: 'test-dry-run-001',
  };
  // Seed via a real close so we have rows to count.
  runHelper('close', ['--json', '-'], { fakeRoot, stdin: JSON.stringify(dryRunPayload) });

  const assCountBefore = await countRows(db, 'assertions',       projectId);
  const entCountBefore = await countRows(db, 'entities',         projectId);
  const psCountBefore  = await countRows(db, 'project_settings', projectId);

  await test('close --dry-run: exits 0', () => {
    const dryPayload = {
      entities:   [{ name: 'DryRunNew', entity_type: 'concept', description: 'would-be-new' }],
      assertions: [{ subject: 'DryRunNew', predicate: 'uses', object: 'Node.js', confidence: 7, source: 'model_extracted' }],
      edges:      [],
      contract:   { queries: [{ type: 'recency', token_budget: 300 }] },
      tldr:       'dry-run test pass',
      open_threads: [],
      session_id: 'test-dry-run-002',
    };
    const result = runHelperBoth('close', ['--json', '--dry-run'], { fakeRoot, stdin: JSON.stringify(dryPayload) });
    assert.strictEqual(result.exitCode, 0,
      `close --dry-run should exit 0; got ${result.exitCode}. stderr: ${result.stderr}`);
  });

  await test('close --dry-run: output mentions dry-run and no mutations', () => {
    const dryPayload = {
      entities:   [],
      assertions: [{ subject: 'DryRunCheck', predicate: 'uses', object: 'check', confidence: 6, source: 'model_extracted' }],
      edges:      [],
      contract:   { queries: [{ type: 'recency', token_budget: 300 }] },
      tldr:       'dry-run output check',
      open_threads: [],
    };
    const result = runHelperBoth('close', ['--json', '--dry-run'], { fakeRoot, stdin: JSON.stringify(dryPayload) });
    assert.ok(result.stdout.includes('DRY-RUN'),
      `output should include DRY-RUN header. stdout: ${result.stdout}`);
    assert.ok(result.stdout.includes('no mutations') || result.stdout.includes('nothing will be written'),
      `output should mention no mutations. stdout: ${result.stdout}`);
    assert.ok(result.stdout.includes('Done: handoff:close --dry-run'),
      `output should include Done --dry-run line. stdout: ${result.stdout}`);
  });

  await test('close --dry-run: row counts are unchanged in assertions', async () => {
    const dryPayload = {
      entities:   [{ name: 'DryRunNoWrite', entity_type: 'concept', description: 'dry-run entity' }],
      assertions: [
        { subject: 'DryRunNoWrite', predicate: 'uses', object: 'Postgres', confidence: 8, source: 'model_extracted' },
        { subject: 'DryRunNoWrite', predicate: 'is',   object: 'test',     confidence: 7, source: 'model_extracted' },
      ],
      edges:      [],
      contract:   { queries: [{ type: 'recency', token_budget: 300 }] },
      tldr:       'dry-run no-write test',
      open_threads: [],
      session_id: 'test-dry-run-003',
    };
    runHelperBoth('close', ['--json', '--dry-run'], { fakeRoot, stdin: JSON.stringify(dryPayload) });

    const assCountAfter = await countRows(db, 'assertions',       projectId);
    const entCountAfter = await countRows(db, 'entities',         projectId);
    const psCountAfter  = await countRows(db, 'project_settings', projectId);

    assert.strictEqual(assCountAfter, assCountBefore,
      `assertions count should be unchanged after --dry-run (before=${assCountBefore}, after=${assCountAfter})`);
    assert.strictEqual(entCountAfter, entCountBefore,
      `entities count should be unchanged after --dry-run (before=${entCountBefore}, after=${entCountAfter})`);
    assert.strictEqual(psCountAfter,  psCountBefore,
      `project_settings count should be unchanged after --dry-run (before=${psCountBefore}, after=${psCountAfter})`);
  });

  await test('close --dry-run: reports payload rows that WOULD be written', () => {
    const dryPayload = {
      entities:   [{ name: 'E1', entity_type: 'system', description: 'd1' }],
      assertions: [
        { subject: 'E1', predicate: 'uses', object: 'X', confidence: 7, source: 'model_extracted' },
        { subject: 'E1', predicate: 'is',   object: 'Y', confidence: 6, source: 'model_extracted' },
      ],
      edges:      [{ from_entity: 'E1', edge_type: 'depends_on', to_entity: 'DryRunEntity' }],
      contract:   { queries: [{ type: 'recency', token_budget: 300 }] },
      tldr:       'would-write count check',
      open_threads: [],
    };
    const result = runHelperBoth('close', ['--json', '--dry-run'], { fakeRoot, stdin: JSON.stringify(dryPayload) });
    assert.ok(result.stdout.includes('entities:'),
      `dry-run output should list entity count. stdout: ${result.stdout}`);
    assert.ok(result.stdout.includes('assertions:'),
      `dry-run output should list assertion count. stdout: ${result.stdout}`);
    assert.ok(result.stdout.includes('edges:'),
      `dry-run output should list edge count. stdout: ${result.stdout}`);
  });

  await test('close --dry-run: works without --json (empty payload)', () => {
    // --dry-run without --json should work (empty payload path).
    const result = runHelperBoth('close', ['--dry-run'], { fakeRoot });
    assert.strictEqual(result.exitCode, 0,
      `close --dry-run without --json should exit 0; got ${result.exitCode}. stderr: ${result.stderr}`);
    assert.ok(result.stdout.includes('DRY-RUN'),
      `output should include DRY-RUN header even without --json. stdout: ${result.stdout}`);
  });

  // ─── Feature 3 extra: close --dry-run zero-mutation invariant on reality_check ──
  //
  // Seeds a live assertion with a verify-mode predicate (branch_exists) and a known
  // reality_check value, then runs close --dry-run and asserts the reality_check
  // column is UNCHANGED.  This locks the invariant that the pre-write verify refresh
  // (UPDATE assertions SET reality_check) is fully skipped under --dry-run.

  await test('close --dry-run: reality_check column is not mutated for verify-predicate rows', async () => {
    // Seed a live branch_exists assertion with a known reality_check value.
    const knownRealityCheck = 'verified';
    const { rows: seedRcRows } = await db.query(
      `INSERT INTO assertions
         (project_id, subject, predicate, object, confidence, source, suppressed, reality_check)
       VALUES ($1, 'dry-run-branch-subject', 'branch_exists', 'nonexistent-branch-xyzzy', 8, 'user_stated', false, $2)
       RETURNING id`,
      [projectId, knownRealityCheck]
    );
    const rcAssertionId = seedRcRows[0].id;

    // Also seed an in_file assertion with a known reality_check to cover a second
    // verify-mode predicate in the same pass.
    const { rows: seedInFileRows } = await db.query(
      `INSERT INTO assertions
         (project_id, subject, predicate, object, confidence, source, suppressed, reality_check)
       VALUES ($1, 'dry-run-file-subject', 'in_file', 'scripts/handoff.js', 8, 'user_stated', false, $2)
       RETURNING id`,
      [projectId, knownRealityCheck]
    );
    const inFileAssertionId = seedInFileRows[0].id;

    // Run close --dry-run with a payload that would normally trigger the pre-write refresh.
    const dryPayload = {
      entities:   [],
      assertions: [
        { subject: 'dry-run-branch-subject', predicate: 'uses', object: 'Node.js', confidence: 7, source: 'model_extracted' },
      ],
      edges:    [],
      contract: { queries: [{ type: 'recency', token_budget: 300 }] },
      tldr:     'reality-check zero-mutation test',
      open_threads: [],
      session_id: 'test-dry-run-rc-001',
    };
    const result = runHelperBoth('close', ['--json', '--dry-run'], { fakeRoot, stdin: JSON.stringify(dryPayload) });
    assert.strictEqual(result.exitCode, 0,
      `close --dry-run should exit 0; got ${result.exitCode}. stderr: ${result.stderr}`);

    // Assert reality_check is UNCHANGED for both seeded rows.
    const { rows: rcAfterRows } = await db.query(
      `SELECT id, reality_check FROM assertions WHERE id = ANY($1::int[])`,
      [[rcAssertionId, inFileAssertionId]]
    );
    assert.strictEqual(rcAfterRows.length, 2, 'both seeded assertions should still exist');
    for (const row of rcAfterRows) {
      assert.strictEqual(
        row.reality_check, knownRealityCheck,
        `reality_check for assertion ${row.id} should be '${knownRealityCheck}' after --dry-run, got '${row.reality_check}'`
      );
    }

    // Clean up the seeded rows so they do not affect other tests.
    await db.query(`DELETE FROM assertions WHERE id = ANY($1::int[])`, [[rcAssertionId, inFileAssertionId]]);
  });

  // ─── Cleanup ──────────────────────────────────────────────────────────────
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
