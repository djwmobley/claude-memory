'use strict';

/**
 * test-predicate-vocabulary.js — CI guard for predicate-vocabulary enforcement.
 *
 * Tests:
 *   T1  auditAssertionPredicates catches a used-but-unregistered predicate
 *       (the has_updated class — silent drift that permissive mode allowed through).
 *   T2  auditAssertionPredicates returns [] when all rows use registered predicates.
 *   T3  validatePayload in strict mode accepts a payload built from registered predicates.
 *   T4  findUnregisteredPredicates correctly identifies unregistered predicates and
 *       confirms has_updated and in_file ARE now registered (locks this PR's fix).
 *
 * Usage:
 *   PGHOST=localhost PGUSER=postgres PGPASSWORD=postgres \
 *     node test/handoff/test-predicate-vocabulary.js
 *
 * Exit codes: 0 all-pass, 1 any failure, 2 infrastructure error.
 */

const assert = require('assert');
const path   = require('path');

// pg lives in scripts/node_modules — use createRequire anchored to scripts/package.json.
const { createRequire } = require('module');
const scriptsRequire = createRequire(require.resolve('../../scripts/package.json'));
const { Client }     = scriptsRequire('pg');

const { loadConfig }               = require('../../scripts/lib/shared');
const { findUnregisteredPredicates, auditAssertionPredicates } = require('../../scripts/lib/predicate-audit');
const { validatePayload }          = require('../../scripts/lib/payload-schema');

// ── Constants ─────────────────────────────────────────────────────────────────

const TARGET_DB = 'claude_memory_eval_test';

// Unique project id scoped to this test run so rows from other tests never collide.
const PROJECT_ID = 'test--pred-vocab--' + Date.now();

// ── Helpers ───────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function test(label, fn) {
  try {
    const result = fn();
    if (result && typeof result.then === 'function') {
      return result
        .then(() => {
          console.log(`PASS  ${label}`);
          passed++;
        })
        .catch((err) => {
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
  const cfg    = loadConfig();
  const client = new Client({
    host:     cfg.host,
    port:     cfg.port,
    database: TARGET_DB,
    user:     cfg.user,
  });
  await client.connect();
  return client;
}

// ── Setup / teardown ──────────────────────────────────────────────────────────

async function ensureSchema(client) {
  // Apply the handoff core schema so the assertions table exists.
  const fs      = require('fs');
  const sqlPath = path.resolve(__dirname, '../../scripts/sql/handoff-core-schema.sql');
  if (!fs.existsSync(sqlPath)) return;
  let sql = fs.readFileSync(sqlPath, 'utf8');
  // Strip psql meta-commands (\c, \echo, etc.) so the JS client can run it.
  sql = sql.replace(/^\\[a-z].*$/gm, '');
  try {
    await client.query(sql);
  } catch (err) {
    if (!err.message.includes('already exists')) {
      console.warn(`  Schema apply warning: ${err.message}`);
    }
  }
}

async function teardown(client) {
  try {
    await client.query('DELETE FROM assertions WHERE project_id = $1', [PROJECT_ID]);
  } catch (_) {
    // best-effort; table may not exist if setup failed early
  }
  await client.end().catch(() => {});
}

// ── Tests ─────────────────────────────────────────────────────────────────────

async function runTests() {
  let client;
  try {
    client = await connectDb();
  } catch (err) {
    console.error(`\nInfrastructure error: cannot connect to ${TARGET_DB}: ${err.message}`);
    console.error('Run: psql -U postgres -c "CREATE DATABASE claude_memory_eval_test;"');
    process.exit(2);
  }

  await ensureSchema(client);

  console.log(`\n  test project_id: ${PROJECT_ID}\n`);

  try {
    // ── T1: audit catches DB drift (the has_updated class) ────────────────────
    await test('T1: auditAssertionPredicates detects unregistered predicate in DB', async () => {
      // Insert rows including one deliberately-unregistered predicate.
      await client.query(
        `INSERT INTO assertions (project_id, subject, predicate, object, confidence, source)
         VALUES
           ($1, 'SubjectA', 'is_status',               'active',        8, 'model_extracted'),
           ($1, 'SubjectA', 'in_file',                 'lib/foo.js',    7, 'model_extracted'),
           ($1, 'SubjectA', 'has_updated',             'readme update', 6, 'model_extracted'),
           ($1, 'SubjectB', 'zzz_fake_predicate_xyzzy','sentinel',      5, 'model_extracted')`,
        [PROJECT_ID]
      );

      const drifted = await auditAssertionPredicates(client, { projectId: PROJECT_ID });

      assert.ok(
        drifted.length === 1,
        `Expected 1 unregistered predicate, got ${drifted.length}: ${JSON.stringify(drifted)}`
      );
      assert.strictEqual(
        drifted[0].predicate, 'zzz_fake_predicate_xyzzy',
        `Expected zzz_fake_predicate_xyzzy, got ${drifted[0].predicate}`
      );
      assert.strictEqual(
        drifted[0].count, 1,
        `Expected count 1, got ${drifted[0].count}`
      );
    });

    // ── T2: clean corpus returns empty array ───────────────────────────────────
    await test('T2: auditAssertionPredicates returns [] for all-registered corpus', async () => {
      // Use a fresh sub-id suffix so rows are isolated from T1.
      const cleanId = PROJECT_ID + '--clean';
      try {
        await client.query(
          `INSERT INTO assertions (project_id, subject, predicate, object, confidence, source)
           VALUES
             ($1, 'EntityX', 'is_status',  'active',    9, 'user_stated'),
             ($1, 'EntityX', 'shipped_at', 'abc1234',   8, 'user_stated'),
             ($1, 'EntityX', 'has_updated','readme fix', 7, 'model_extracted')`,
          [cleanId]
        );

        const drifted = await auditAssertionPredicates(client, { projectId: cleanId });

        assert.deepStrictEqual(
          drifted, [],
          `Expected [], got ${JSON.stringify(drifted)}`
        );
      } finally {
        await client.query('DELETE FROM assertions WHERE project_id = $1', [cleanId]).catch(() => {});
      }
    });

    // ── T3: strict-mode close vocabulary guard ─────────────────────────────────
    await test('T3: validatePayload strict accepts payload with registered predicates', () => {
      const payload = {
        assertions: [
          { subject: 'WorkItem',   predicate: 'is_status',    object: 'done',        confidence: 9, source: 'user_stated' },
          { subject: 'WorkItem',   predicate: 'commit_merged', object: 'abc1234',    confidence: 9, source: 'user_stated' },
          { subject: 'SomeDoc',    predicate: 'in_file',       object: 'docs/x.md',  confidence: 7, source: 'model_extracted' },
          { subject: 'SomeDoc',    predicate: 'has_updated',   object: 'toc added',  confidence: 6, source: 'model_extracted' },
          { subject: 'Release1',   predicate: 'shipped_at',    object: 'v1.2.0',     confidence: 8, source: 'model_extracted' },
        ],
      };

      const result = validatePayload(payload, 'strict');

      assert.strictEqual(result.ok, true, `Expected ok=true; errors: ${JSON.stringify(result.errors)}`);
      assert.strictEqual(result.errors.length, 0, `Expected no errors, got: ${JSON.stringify(result.errors)}`);
    });

    // ── T4: pure helper + locks this PR's fix ────────────────────────────────
    await test('T4: findUnregisteredPredicates — has_updated and in_file now registered', () => {
      const input  = ['has_updated', 'in_file', 'definitely_not_registered_zzz'];
      const result = findUnregisteredPredicates(input);

      assert.deepStrictEqual(
        result, ['definitely_not_registered_zzz'],
        `Expected only definitely_not_registered_zzz; got ${JSON.stringify(result)}`
      );
    });

  } finally {
    await teardown(client);
  }

  console.log(`\n  ${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests().catch((err) => {
  console.error('Unexpected error:', err);
  process.exit(2);
});
