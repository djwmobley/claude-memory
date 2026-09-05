'use strict';

/**
 * test-cmd-params.js — Focused tests for the new command-parameter flags
 * added in feat/cmd-params-read-preview:
 *
 *   status --json           emits valid JSON with expected keys
 *   status --breakdown      emits breakdown section (prose and included in JSON)
 *   status --stale-pointers emits stale pointer count
 *   purge --dry-run         prints row counts but deletes nothing
 *   close --json (alone)    reads stdin without requiring the trailing '-' token
 *   checkpoint --json (alone) same as above
 *   resurrect --json        emits structured JSON output
 *
 * Usage:
 *   node test/handoff/test-cmd-params.js
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
const { execFileSync, spawnSync } = require('child_process');

const { loadConfig }             = require('../../scripts/lib/shared');
const { encodeCwd }              = require('../../scripts/lib/encoded-cwd');
const { writeMarker, readMarker } = require('../../scripts/lib/project-marker');
const { resolveHandoffMdPath }   = require('../../scripts/lib/handoff-paths');

const { createRequire } = require('module');
const scriptsRequire = createRequire(require.resolve('../../scripts/package.json'));
const { Client }     = scriptsRequire('pg');

// ─── CONFIG ───────────────────────────────────────────────────────────────────

const TARGET_DB  = 'claude_memory_eval_test';
const HELPER     = path.resolve(__dirname, '..', '..', 'scripts', 'handoff.js');
const PROJECT_ID = 'test--cmd-params--' + Date.now();

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

/** Run the handoff.js helper as a subprocess. */
function runHelper(sub, extraArgs = [], opts = {}) {
  const fakeRoot = opts.fakeRoot || global.__fakeRoot;
  const env = {
    ...process.env,
    PROJECT_ROOT:              fakeRoot,
    HANDOFF_TEST_PROJECT_ID:   PROJECT_ID,
    // Disable vLLM embedding so resurrect falls back to fuzzy match.
    EMBED_SKIP: '1',
    ...(opts.extraEnv || {}),
  };
  for (const k of (opts.deleteEnv || [])) delete env[k];
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

/** Like runHelper but captures both stdout and stderr (never throws). */
function runHelperBoth(sub, extraArgs = [], opts = {}) {
  const fakeRoot = opts.fakeRoot || global.__fakeRoot;
  const env = {
    ...process.env,
    PROJECT_ROOT:            fakeRoot,
    HANDOFF_TEST_PROJECT_ID: PROJECT_ID,
    EMBED_SKIP: '1',
    ...(opts.extraEnv || {}),
  };
  for (const k of (opts.deleteEnv || [])) delete env[k];
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
  const fakeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'handoff-cmd-params-test-'));
  global.__fakeRoot = fakeRoot;

  fs.mkdirSync(path.join(fakeRoot, '.git'));
  fs.mkdirSync(path.join(fakeRoot, '.claude'));
  fs.writeFileSync(path.join(fakeRoot, '.claude', 'pipeline.yml'), `
project:
  name: cmd-params-test

knowledge:
  tier: "postgres"
  host: "localhost"
  port: 5432
  database: "${TARGET_DB}"
  user: "postgres"
`.trim(), 'utf8');

  const marker = writeMarker(fakeRoot);
  global.__projectId = marker.uuid;

  console.log(`\n  test project_id: ${PROJECT_ID}`);
  console.log(`  fake root:       ${fakeRoot}`);
  console.log(`  marker uuid:     ${marker.uuid}`);

  let db;
  try {
    db = await connectDb();
  } catch (err) {
    console.error(`\nInfrastructure error: cannot connect to ${TARGET_DB}: ${err.message}`);
    process.exit(2);
  }

  // Apply every postgres-classified schema unit, in manifest order (cm#185:
  // derived from the same total classification the engine uses, instead of a
  // hand-maintained file list here).
  const { classifySchemaFiles } = require('../../scripts/lib/schema-classify');
  const classification = classifySchemaFiles({ engineRoot: path.resolve(__dirname, '..', '..') });
  if (!classification.ok) {
    throw new Error(`schema classification failed: ${classification.errors.join('; ')}`);
  }
  for (const unit of classification.unitsByDialect.postgres) {
    let sql = fs.readFileSync(unit.fullPath, 'utf8');
    sql = sql.replace(/^\\[a-z].*$/gm, '');
    try {
      await db.query(sql);
    } catch (err) {
      if (!err.message.includes('already exists')) {
        console.warn(`  Schema apply warning (${unit.basename}): ${err.message}`);
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
      const dir = path.dirname(resolveHandoffMdPath(projectUuid));
      if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
    }
  } catch (_) {}
}

// ─── TESTS ────────────────────────────────────────────────────────────────────

async function runTests() {
  const fakeRoot  = await setup();
  const db        = await connectDb();
  const projectId = global.__projectId;

  // ── Provision the project ─────────────────────────────────────────────────
  runHelper('init', ['-y'], { fakeRoot });

  // ── Seed some data so counts are non-zero ─────────────────────────────────
  const seedPayload = {
    entities: [
      { name: 'ParamTestEntity', entity_type: 'system', description: 'Cmd-params test entity' },
    ],
    assertions: [
      { subject: 'ParamTestEntity', predicate: 'uses',   object: 'Postgres',  confidence: 8, source: 'model_extracted' },
      { subject: 'ParamTestEntity', predicate: 'status', object: 'active',    confidence: 9, source: 'user_stated' },
    ],
    edges:         [],
    contract:      { queries: [{ type: 'recency', token_budget: 500 }] },
    tldr:          'Param-test session seeded.',
    open_threads:  ['verify param flags work'],
    quick_references: 'ParamTestEntity = test fixture',
    session_id:    'test-params-001',
  };
  runHelper('close', ['--json', '-'], { fakeRoot, stdin: JSON.stringify(seedPayload) });

  // ── 1. status --json ──────────────────────────────────────────────────────

  await test('status --json: exits 0 and emits valid JSON', () => {
    const out = runHelper('status', ['--json'], { fakeRoot });
    // Strip the "Running:" and "Done:" prose lines that wrap the JSON object.
    const jsonMatch = out.match(/\{[\s\S]*\}/);
    assert.ok(jsonMatch, 'status --json output should contain a JSON object');
    const obj = JSON.parse(jsonMatch[0]);
    assert.ok(obj, 'JSON.parse should succeed');
  });

  await test('status --json: output contains expected top-level keys', () => {
    const out = runHelper('status', ['--json'], { fakeRoot });
    const jsonMatch = out.match(/\{[\s\S]*\}/);
    const obj = JSON.parse(jsonMatch[0]);
    const requiredKeys = [
      'project_id', 'db', 'handoff_md', 'last_close', 'days_since',
      'entities', 'assertions', 'edges', 'contracts', 'session_active', 'session_id',
    ];
    for (const k of requiredKeys) {
      assert.ok(Object.prototype.hasOwnProperty.call(obj, k), `JSON output should have key "${k}"`);
    }
  });

  await test('status --json: numeric counts are integers', () => {
    const out = runHelper('status', ['--json'], { fakeRoot });
    const jsonMatch = out.match(/\{[\s\S]*\}/);
    const obj = JSON.parse(jsonMatch[0]);
    assert.strictEqual(typeof obj.entities,   'number', 'entities should be a number');
    assert.strictEqual(typeof obj.assertions, 'number', 'assertions should be a number');
    assert.strictEqual(typeof obj.edges,      'number', 'edges should be a number');
    assert.ok(obj.entities   >= 0, 'entities count should be >= 0');
    assert.ok(obj.assertions >= 0, 'assertions count should be >= 0');
  });

  await test('status --json: contracts is an array', () => {
    const out = runHelper('status', ['--json'], { fakeRoot });
    const jsonMatch = out.match(/\{[\s\S]*\}/);
    const obj = JSON.parse(jsonMatch[0]);
    assert.ok(Array.isArray(obj.contracts), 'contracts should be an array');
  });

  // ── 2. status --breakdown ──────────────────────────────────────────────────

  await test('status --breakdown: prose output contains breakdown section', () => {
    const out = runHelper('status', ['--breakdown'], { fakeRoot });
    assert.ok(out.includes('breakdown'), 'status --breakdown should include breakdown section');
    assert.ok(out.includes('by tier'),       'breakdown should include by-tier counts');
    assert.ok(out.includes('by suppression'), 'breakdown should include suppression counts');
  });

  await test('status --json --breakdown: JSON output includes breakdown object', () => {
    const out = runHelper('status', ['--json', '--breakdown'], { fakeRoot });
    const jsonMatch = out.match(/\{[\s\S]*\}/);
    const obj = JSON.parse(jsonMatch[0]);
    assert.ok(Object.prototype.hasOwnProperty.call(obj, 'breakdown'), 'JSON should include breakdown key');
    assert.ok(typeof obj.breakdown === 'object' && obj.breakdown !== null, 'breakdown should be an object');
    assert.ok(Object.prototype.hasOwnProperty.call(obj.breakdown, 'by_tier'),        'breakdown should have by_tier');
    assert.ok(Object.prototype.hasOwnProperty.call(obj.breakdown, 'by_suppression'), 'breakdown should have by_suppression');
    assert.ok(Object.prototype.hasOwnProperty.call(obj.breakdown, 'top_predicates'), 'breakdown should have top_predicates');
    assert.ok(Array.isArray(obj.breakdown.top_predicates), 'top_predicates should be an array');
  });

  // ── 3. status --stale-pointers ────────────────────────────────────────────

  await test('status --stale-pointers: prose output contains stale pointers line', () => {
    const out = runHelper('status', ['--stale-pointers'], { fakeRoot });
    assert.ok(out.includes('stale pointers'), 'status --stale-pointers should include stale pointers line');
  });

  await test('status --json --stale-pointers: JSON output includes stale_pointer_count key', () => {
    const out = runHelper('status', ['--json', '--stale-pointers'], { fakeRoot });
    const jsonMatch = out.match(/\{[\s\S]*\}/);
    const obj = JSON.parse(jsonMatch[0]);
    assert.ok(
      Object.prototype.hasOwnProperty.call(obj, 'stale_pointer_count'),
      'JSON should include stale_pointer_count key'
    );
    // May be null (if project root resolution fails) or a non-negative integer.
    assert.ok(
      obj.stale_pointer_count === null || (typeof obj.stale_pointer_count === 'number' && obj.stale_pointer_count >= 0),
      'stale_pointer_count should be null or a non-negative integer'
    );
  });

  // ── 4. purge --dry-run ────────────────────────────────────────────────────

  await test('purge --dry-run: exits 0', () => {
    const out = runHelper('purge', ['--dry-run'], { fakeRoot });
    assert.ok(out.includes('Done: handoff:purge'), 'purge --dry-run should emit Done line');
    assert.ok(out.includes('dry-run'), 'purge --dry-run output should mention dry-run');
  });

  await test('purge --dry-run: prints per-table row counts', () => {
    const out = runHelper('purge', ['--dry-run'], { fakeRoot });
    assert.ok(out.includes('assertions:'), 'dry-run output should list assertions count');
    assert.ok(out.includes('entities:'),   'dry-run output should list entities count');
    assert.ok(out.includes('edges:'),      'dry-run output should list edges count');
  });

  await test('purge --dry-run: does NOT delete any rows', async () => {
    // Record row counts BEFORE dry-run.
    const assCountBefore = await countRows(db, 'assertions',     projectId);
    const entCountBefore = await countRows(db, 'entities',       projectId);
    const psCountBefore  = await countRows(db, 'project_settings', projectId);

    runHelper('purge', ['--dry-run'], { fakeRoot });

    // Counts should be identical afterward.
    const assCountAfter = await countRows(db, 'assertions',     projectId);
    const entCountAfter = await countRows(db, 'entities',       projectId);
    const psCountAfter  = await countRows(db, 'project_settings', projectId);

    assert.strictEqual(assCountAfter, assCountBefore, 'assertions count should be unchanged after dry-run');
    assert.strictEqual(entCountAfter, entCountBefore, 'entities count should be unchanged after dry-run');
    assert.strictEqual(psCountAfter,  psCountBefore,  'project_settings count should be unchanged after dry-run');
  });

  await test('purge --dry-run: handoff.md is NOT removed', () => {
    const marker      = readMarker(fakeRoot);
    const projectUuid = marker ? marker.uuid : projectId;
    const handoffPath = resolveHandoffMdPath(projectUuid);
    runHelper('purge', ['--dry-run'], { fakeRoot });
    assert.ok(fs.existsSync(handoffPath), 'handoff.md should still exist after purge --dry-run');
  });

  // ── 5. close --json (without trailing '-') ────────────────────────────────

  await test('close --json alone reads stdin (no "-" token required)', async () => {
    // Re-init to ensure project exists after any prior manipulation.
    runHelper('init', ['-y'], { fakeRoot });

    const payload = {
      entities:  [{ name: 'JsonAloneEntity', entity_type: 'concept', description: 'JSON-alone test' }],
      assertions: [{ subject: 'JsonAloneEntity', predicate: 'uses', object: 'stdin', confidence: 7, source: 'model_extracted' }],
      edges:     [],
      contract:  { queries: [{ type: 'recency', token_budget: 300 }] },
      tldr:      'close --json-alone test.',
      open_threads: [],
      session_id: 'test-json-alone-close-001',
    };

    // Pass --json without the trailing '-' — this is the new relaxed form.
    const result = runHelperBoth('close', ['--json'], { fakeRoot, stdin: JSON.stringify(payload) });
    assert.ok(result.exitCode === 0, `close --json (alone) should exit 0; got ${result.exitCode}. stderr: ${result.stderr}`);
    assert.ok(result.stdout.includes('Done: handoff:close'), 'close --json alone should emit Done line');

    // Verify entity was written.
    const { rows } = await db.query(
      `SELECT COUNT(*) AS n FROM entities WHERE project_id = $1 AND name = 'JsonAloneEntity'`,
      [projectId]
    );
    assert.ok(parseInt(rows[0].n, 10) >= 1, 'JsonAloneEntity should be written to DB when using --json alone');
  });

  await test('close --json - (legacy form with dash) still works', () => {
    runHelper('init', ['-y'], { fakeRoot });
    const payload = {
      entities: [], assertions: [], edges: [],
      contract: { queries: [{ type: 'recency', token_budget: 300 }] },
      tldr: 'legacy json-dash test.', open_threads: [],
      session_id: 'test-legacy-dash-001',
    };
    const result = runHelperBoth('close', ['--json', '-'], { fakeRoot, stdin: JSON.stringify(payload) });
    assert.ok(result.exitCode === 0, `close --json - should still exit 0; got ${result.exitCode}`);
    assert.ok(result.stdout.includes('Done: handoff:close'), 'close --json - should emit Done line');
  });

  // ── 6. checkpoint --json (without trailing '-') ───────────────────────────

  await test('checkpoint --json alone reads stdin (no "-" token required)', async () => {
    runHelper('init', ['-y'], { fakeRoot });

    // Seed a session_in_progress marker so checkpoint can retain it.
    await db.query(
      `INSERT INTO project_settings (project_id, key, value)
         VALUES ($1, 'session_in_progress', 'test-cp-json-alone')
         ON CONFLICT (project_id, key) DO UPDATE SET value = EXCLUDED.value`,
      [projectId]
    );

    const payload = {
      entities:  [{ name: 'CheckpointJsonAlone', entity_type: 'concept', description: 'Checkpoint JSON-alone test' }],
      assertions: [{ subject: 'CheckpointJsonAlone', predicate: 'status', object: 'testing', confidence: 6, source: 'model_extracted' }],
      edges:     [],
      contract:  { queries: [{ type: 'recency', token_budget: 300 }] },
      tldr:      'checkpoint --json-alone test.',
      open_threads: [],
      session_id: 'test-cp-json-alone',
    };

    const result = runHelperBoth('checkpoint', ['--json'], { fakeRoot, stdin: JSON.stringify(payload) });
    assert.ok(result.exitCode === 0, `checkpoint --json (alone) should exit 0; got ${result.exitCode}. stderr: ${result.stderr}`);
    assert.ok(result.stdout.includes('Done: handoff:checkpoint'), 'checkpoint --json alone should emit Done line');
  });

  await test('checkpoint --json - (legacy form with dash) still works', () => {
    runHelper('init', ['-y'], { fakeRoot });
    const payload = {
      entities: [], assertions: [], edges: [],
      contract: { queries: [{ type: 'recency', token_budget: 300 }] },
      tldr: 'legacy cp json-dash test.', open_threads: [],
      session_id: 'test-cp-legacy-dash',
    };
    const result = runHelperBoth('checkpoint', ['--json', '-'], { fakeRoot, stdin: JSON.stringify(payload) });
    assert.ok(result.exitCode === 0, `checkpoint --json - should still exit 0; got ${result.exitCode}`);
    assert.ok(result.stdout.includes('Done: handoff:checkpoint'), 'checkpoint --json - should emit Done line');
  });

  // ── 7. resurrect --json ───────────────────────────────────────────────────
  //
  // Seed a probationary row to give resurrect something to find.
  {
    // Re-use the marker UUID as project_id for insert.
    const resurrectProjectId = projectId;

    await db.query(
      `INSERT INTO entities (project_id, name, entity_type, description)
         VALUES ($1, 'json-resurrect-subject', 'concept', 'resurrect --json test entity')
         ON CONFLICT DO NOTHING`,
      [resurrectProjectId]
    );
    // Trusted-anchor live row (M2 gate requirement).
    await db.query(
      `INSERT INTO assertions (project_id, subject, predicate, object, confidence,
                               source, suppressed, reality_check)
         VALUES ($1, 'json-resurrect-subject', 'status', 'trusted-live', 9,
                 'user_stated', false, 'verified')
         ON CONFLICT DO NOTHING`,
      [resurrectProjectId]
    );
    // Probationary (downvoted_probation) row.
    await db.query(
      `INSERT INTO assertions (project_id, subject, predicate, object, confidence,
                               source, suppressed, suppression_kind, tier)
         VALUES ($1, 'json-resurrect-subject', 'old_detail', 'probation-value', 6,
                 'model_extracted', true, 'downvoted_probation', 'probationary')
         ON CONFLICT DO NOTHING`,
      [resurrectProjectId]
    );

    await test('resurrect --json: exits 0', () => {
      const result = runHelperBoth('resurrect', ['json-resurrect-subject', '--json'], { fakeRoot });
      assert.ok(result.exitCode === 0, `resurrect --json should exit 0; got ${result.exitCode}. stderr: ${result.stderr}`);
    });

    await test('resurrect --json: output contains a JSON object with expected keys', () => {
      const out = runHelper('resurrect', ['json-resurrect-subject', '--json'], { fakeRoot });
      const jsonMatch = out.match(/\{[\s\S]*\}/);
      assert.ok(jsonMatch, 'resurrect --json output should contain a JSON object');
      const obj = JSON.parse(jsonMatch[0]);
      const requiredKeys = ['seed', 'mode', 'candidate_count', 'candidates', 'revived_count', 'revived_ids'];
      for (const k of requiredKeys) {
        assert.ok(Object.prototype.hasOwnProperty.call(obj, k), `JSON output should have key "${k}"`);
      }
    });

    await test('resurrect --json: mode is "dry-run" when --revive is absent', () => {
      const out = runHelper('resurrect', ['json-resurrect-subject', '--json'], { fakeRoot });
      const jsonMatch = out.match(/\{[\s\S]*\}/);
      const obj = JSON.parse(jsonMatch[0]);
      assert.strictEqual(obj.mode, 'dry-run', 'mode should be "dry-run" without --revive');
    });

    await test('resurrect --json: candidates is an array', () => {
      const out = runHelper('resurrect', ['json-resurrect-subject', '--json'], { fakeRoot });
      const jsonMatch = out.match(/\{[\s\S]*\}/);
      const obj = JSON.parse(jsonMatch[0]);
      assert.ok(Array.isArray(obj.candidates), 'candidates should be an array');
    });

    await test('resurrect --json --revive: mode is "revived"', () => {
      const out = runHelper('resurrect', ['json-resurrect-subject', '--json', '--revive'], { fakeRoot });
      const jsonMatch = out.match(/\{[\s\S]*\}/);
      assert.ok(jsonMatch, 'resurrect --json --revive output should contain a JSON object');
      const obj = JSON.parse(jsonMatch[0]);
      assert.strictEqual(obj.mode, 'revived', 'mode should be "revived" when --revive is passed');
    });

    await test('resurrect --json: no-match seed still returns valid JSON', () => {
      const out = runHelper('resurrect', ['zzzz-totally-nonexistent-xyzzy', '--json'], { fakeRoot });
      const jsonMatch = out.match(/\{[\s\S]*\}/);
      assert.ok(jsonMatch, 'resurrect --json should still emit a JSON object on no-match');
      const obj = JSON.parse(jsonMatch[0]);
      assert.ok(Array.isArray(obj.candidates), 'candidates should be an empty array on no-match');
    });
  }

  // ── Cleanup ───────────────────────────────────────────────────────────────

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
