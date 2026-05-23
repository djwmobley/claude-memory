'use strict';

/**
 * test-schema-suppression-kind.js — Regression tests for the suppression_kind
 * CHECK constraint ordering bug (issue #124).
 *
 * Background: the schema previously contained two sequential DO blocks that each
 * dropped and re-added the suppression_kind CHECK constraint.  The FIRST block
 * re-added only a 4-value set (omitting 'reality_reconciled').  On any DB that
 * already had an assertions row with suppression_kind='reality_reconciled', the
 * ADD CONSTRAINT in the first block failed with "check constraint ... is violated
 * by some row", aborting the Phase A transaction before the second (correct) block
 * could run.  CI never caught this because CI always starts from a fresh DB.
 *
 * Fix: remove the first block; define the constraint in exactly ONE place with the
 * full 5-value canonical set.  The ADD COLUMN IF NOT EXISTS no longer carries an
 * inline CHECK so the constraint definition is single-sourced.
 *
 * Coverage:
 *   T1  Field-report repro: apply schema fresh; INSERT one row per suppression_kind
 *       value (5 rows total, including 'reality_reconciled'); RE-APPLY the full
 *       handoff-core-schema.sql (simulating re-init); assert no constraint error.
 *   T2  Categorical invariant: every suppression_kind value assigned in handoff.js
 *       source code is present in the schema's final CHECK constraint value set.
 *       Catches any future engine-emitted value missing from the schema.
 *
 * Isolation: tests run under a namespaced schema (CREATE SCHEMA + SET search_path)
 * inside the configured test DB (claude_memory_eval_test).  The schema's DO blocks
 * use current_schema(), so they target the test schema correctly.  Public schema
 * and real assertions data are never touched.  The test schema is dropped on exit.
 *
 * Usage:
 *   node scripts/test-schema-suppression-kind.js
 *
 * Requires: Postgres at PGHOST/PGUSER/PGPASSWORD (CI env) or localhost/postgres.
 * Exit 0 = all tests passed. Exit 1 = any failure.
 */

const fs   = require('fs');
const path = require('path');
const { Client } = require('pg');

// ── Constants ─────────────────────────────────────────────────────────────────

const PROJECT_ROOT = path.resolve(__dirname, '..');
const SCHEMA_SQL   = path.join(PROJECT_ROOT, 'scripts', 'sql', 'handoff-core-schema.sql');
const HANDOFF_JS   = path.join(PROJECT_ROOT, 'scripts', 'handoff.js');
const TARGET_DB    = 'claude_memory_eval_test';
const TEST_SCHEMA  = `suppression_kind_test_${Date.now()}`;

// ── Tracking ──────────────────────────────────────────────────────────────────

let passed  = 0;
let failed  = 0;
const failures = [];

function pass(label)         { console.log(`PASS  ${label}`); passed++; }
function fail(label, reason) { console.log(`FAIL  ${label}: ${reason}`); failures.push({ label, reason }); failed++; }

// ── DB connection ─────────────────────────────────────────────────────────────

async function pgConnect(database) {
  const client = new Client({
    host:     process.env.PGHOST     || 'localhost',
    port:     parseInt(process.env.PGPORT || '5432', 10),
    user:     process.env.PGUSER     || 'postgres',
    password: process.env.PGPASSWORD || 'postgres',
    database,
  });
  await client.connect();
  return client;
}

// ── Schema parsing helpers ────────────────────────────────────────────────────

/**
 * Parse all suppression_kind IN (...) occurrences from the schema SQL.
 * Returns the largest (widest) set found — the canonical post-migration value set.
 */
function parseSchemaKinds(schemaSrc) {
  const re = /suppression_kind\s+IN\s*\(([^)]*)\)/gi;
  let best = new Set();
  let m;
  while ((m = re.exec(schemaSrc)) !== null) {
    const tokens = m[1].match(/'([^']+)'/g) || [];
    const vals = tokens.map((t) => t.slice(1, -1));
    if (vals.length > best.size) best = new Set(vals);
  }
  return best;
}

/**
 * Parse every string literal assigned to suppression_kind in handoff.js source.
 * Matches patterns like: suppression_kind = 'some_value'
 */
function parseHandoffAssignedKinds(src) {
  const re = /suppression_kind\s*=\s*'([a-z_]+)'/g;
  const found = new Set();
  let m;
  while ((m = re.exec(src)) !== null) {
    found.add(m[1]);
  }
  return found;
}

// ── Postgres availability check ───────────────────────────────────────────────

let _pgAvail = null;
async function isPgAvailable() {
  if (_pgAvail !== null) return _pgAvail;
  try {
    const c = await pgConnect(TARGET_DB);
    await c.end();
    _pgAvail = true;
  } catch (_) {
    _pgAvail = false;
    console.log(`[INFO] Postgres DB "${TARGET_DB}" unavailable — DB-backed tests will be SKIPPED.`);
  }
  return _pgAvail;
}

// ── T1: Field-report repro ────────────────────────────────────────────────────

async function testT1() {
  const label = 'T1: field-report repro — re-apply schema with reality_reconciled rows present';

  const pgAvail = await isPgAvailable();
  if (!pgAvail) {
    console.log(`SKIP  ${label} (Postgres unavailable)`);
    return;
  }

  const CANONICAL_KINDS = [
    'superseded',
    'downvoted_terminal',
    'downvoted_probation',
    'retired',
    'reality_reconciled',
  ];

  let db = null;
  try {
    db = await pgConnect(TARGET_DB);

    // Create an isolated namespaced schema.
    await db.query(`CREATE SCHEMA "${TEST_SCHEMA}"`);
    await db.query(`SET search_path TO "${TEST_SCHEMA}"`);

    // Apply the schema for the first time (fresh DB state).
    const schemaSql = fs.readFileSync(SCHEMA_SQL, 'utf8');
    await db.query(schemaSql);

    // INSERT one minimal assertions row for each canonical suppression_kind value.
    // Required NOT NULL columns (no DB default): project_id, subject, predicate,
    // object, confidence, source.  suppressed has a default (false) but we set it
    // explicitly since suppression_kind rows represent suppressed assertions.
    for (const kind of CANONICAL_KINDS) {
      await db.query(
        `INSERT INTO assertions
           (project_id, subject, predicate, object, confidence, source, suppression_kind, suppressed)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          'test-project',
          `subject-${kind}`,
          'is_status',
          `value-${kind}`,
          7.0,
          'user_stated',
          kind,
          true,
        ]
      );
    }

    // Verify all 5 rows were inserted.
    const { rows: insertedRows } = await db.query(
      `SELECT suppression_kind FROM assertions WHERE project_id = $1 ORDER BY suppression_kind`,
      ['test-project']
    );
    if (insertedRows.length !== CANONICAL_KINDS.length) {
      fail(label, `Expected ${CANONICAL_KINDS.length} inserted rows, got ${insertedRows.length}`);
      return;
    }

    // RE-APPLY the full schema (simulating re-init on an existing DB with live rows).
    // This is the exact operation that previously failed with:
    //   "check constraint assertions_suppression_kind_check of relation assertions
    //    is violated by some row"
    // With the fix, the single monotonic DO block must complete without error.
    try {
      await db.query(schemaSql);
    } catch (err) {
      fail(label, `Re-apply schema failed (constraint violation bug reproduced): ${err.message}`);
      return;
    }

    // Assert all 5 rows remain intact after re-apply (no data mutation on re-init).
    const { rows: afterRows } = await db.query(
      `SELECT suppression_kind FROM assertions WHERE project_id = $1 ORDER BY suppression_kind`,
      ['test-project']
    );
    if (afterRows.length !== CANONICAL_KINDS.length) {
      fail(label, `After re-apply: expected ${CANONICAL_KINDS.length} rows, got ${afterRows.length}`);
      return;
    }

    // Verify the installed constraint accepts all 5 canonical values by inspecting
    // the catalog definition.
    const { rows: constraintRows } = await db.query(
      `SELECT pg_get_constraintdef(con.oid) AS def
       FROM   pg_constraint con
       JOIN   pg_class      rel ON rel.oid = con.conrelid
       JOIN   pg_namespace  ns  ON ns.oid  = rel.relnamespace
       WHERE  con.contype = 'c'
         AND  rel.relname = 'assertions'
         AND  ns.nspname  = $1
         AND  pg_get_constraintdef(con.oid) LIKE '%suppression_kind%'`,
      [TEST_SCHEMA]
    );
    if (constraintRows.length === 0) {
      fail(label, 'No suppression_kind CHECK constraint found in test schema after re-apply');
      return;
    }
    const constraintDef = constraintRows[0].def;
    const missingFromConstraint = CANONICAL_KINDS.filter((k) => !constraintDef.includes(k));
    if (missingFromConstraint.length > 0) {
      fail(label, `Constraint definition missing values ${missingFromConstraint.join(', ')}: ${constraintDef}`);
      return;
    }

    pass(label);
  } catch (err) {
    fail(label, err.message);
  } finally {
    if (db) {
      // Always clean up the test schema regardless of test outcome.
      try {
        await db.query(`SET search_path TO public`);
        await db.query(`DROP SCHEMA IF EXISTS "${TEST_SCHEMA}" CASCADE`);
      } catch (_) {}
      try { await db.end(); } catch (_) {}
    }
  }
}

// ── T2: Categorical invariant ─────────────────────────────────────────────────

async function testT2() {
  const label = 'T2: categorical invariant — every suppression_kind value assigned in handoff.js is in the schema CHECK';

  const schemaSrc  = fs.readFileSync(SCHEMA_SQL, 'utf8');
  const handoffSrc = fs.readFileSync(HANDOFF_JS, 'utf8');

  const schemaKinds  = parseSchemaKinds(schemaSrc);
  const engineKinds  = parseHandoffAssignedKinds(handoffSrc);

  console.log(`  [T2] Schema canonical set (${schemaKinds.size}): ${[...schemaKinds].sort().join(', ')}`);
  console.log(`  [T2] Engine-assigned set  (${engineKinds.size}): ${[...engineKinds].sort().join(', ')}`);

  if (schemaKinds.size === 0) {
    fail(label, 'Could not parse any suppression_kind IN (...) from schema SQL');
    return;
  }
  if (engineKinds.size === 0) {
    fail(label, 'Could not parse any suppression_kind assignments from handoff.js');
    return;
  }

  // Every value the engine emits must be accepted by the constraint.
  const missingFromSchema = [...engineKinds].filter((v) => !schemaKinds.has(v));
  if (missingFromSchema.length > 0) {
    fail(label, `Engine assigns suppression_kind values NOT in schema CHECK: ${missingFromSchema.join(', ')}`);
    return;
  }

  pass(label);
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('=== test-schema-suppression-kind.js ===');
  console.log(`Node: ${process.versions.node}`);
  console.log(`Test schema namespace: ${TEST_SCHEMA}\n`);

  await testT1();
  await testT2();

  console.log('');
  console.log(`Results: ${passed} passed, ${failed} failed`);
  if (failures.length > 0) {
    console.log('\nFailures:');
    for (const f of failures) {
      console.log(`  FAIL  ${f.label}: ${f.reason}`);
    }
    process.exit(1);
  }
  console.log('\nAll tests passed.');
  process.exit(0);
}

main().catch((err) => {
  console.error('Unexpected error:', err);
  process.exit(1);
});
