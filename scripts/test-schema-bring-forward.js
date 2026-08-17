'use strict';

/**
 * test-schema-bring-forward.js — cm#185 schema bring-forward: aged-DB fixture
 * + atomic-pair regression proof + fingerprint stability (R-10 / S-19).
 *
 * Fresh-DB CI (test-both-backends.js's bothBackends() harness) cannot exercise
 * any prior-state-dependent failure mode: every test there starts from a
 * schema that was JUST applied by the harness itself. This file constructs
 * genuinely AGED database states by hand (drop an index, seed pre-existing
 * rows, run the real engine against that) so the failure modes S-11/S-13/S-17
 * were written to close are actually exercised, not merely asserted never to
 * regress by construction.
 *
 * T1  Aged-DB fixture (S-19 literal prescription, adapted for physical
 *     realizability — see the long comment on testT1 for why "duplicate rows
 *     coexisting with a live unique index" cannot be constructed any other
 *     way than dropping the index first): core-only provision, drop the 1:1
 *     integrity index, seed a live-duplicate pair that would violate it, run
 *     the REAL ensureSchemaCurrent. Asserts: retrieval_events now exists
 *     (app-retrieval-events-schema.sql, a LATER unit, still gets applied even
 *     though the core unit's Phase-B index recreation fails); the fingerprint
 *     is NOT upserted; a persistent schema_apply_degraded row is written; a
 *     retry is idempotent (never falsely marks success).
 * T2  Atomic DROP+CREATE pair regression proof (S-11's sharper claim): a
 *     PREVIOUSLY WORKING integrity index survives a failed re-create attempt
 *     — db.runIntegrityIndexPair rolls the DROP back together with the failed
 *     CREATE, so the index is never left in a "dropped but not recreated"
 *     state. (This cannot be proven via real duplicate-row data — Postgres
 *     physically refuses to let a duplicate coexist with a live unique index
 *     in the first place — so this test uses a deliberately-broken CREATE
 *     statement to force the failure path instead.)
 * T3  Run-twice zero-DDL idempotency: a second ensureSchemaCurrent call after
 *     a successful apply issues no further DDL (proxy: no error, fingerprint
 *     unchanged, and the underlying classification+fingerprint computation is
 *     pure/deterministic across calls).
 * T4  CRLF/BOM fingerprint stability (the S-8 regression gate): fingerprint
 *     computed from a CRLF+BOM copy of a schema file equals the fingerprint
 *     computed from the LF original.
 *
 * Requires Postgres (PGHOST/PGUSER/PGPASSWORD, defaults localhost/postgres/postgres).
 * T4 is pure and runs with no DB. Exit 0 = all run tests passed.
 */

const fs   = require('fs');
const path = require('path');
const os   = require('os');
const { Client } = require('pg');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const handoffModule = require(path.join(PROJECT_ROOT, 'scripts', 'handoff.js'));
const { PostgresAdapter } = require(path.join(PROJECT_ROOT, 'scripts', 'lib', 'db-seam.js'));
const { classifySchemaFiles, normalizeContent } = require(path.join(PROJECT_ROOT, 'scripts', 'lib', 'schema-classify.js'));

let passed = 0;
let failed = 0;
const failures = [];
function pass(label) { console.log(`PASS  ${label}`); passed++; }
function fail(label, reason) { console.log(`FAIL  ${label}: ${reason}`); failures.push({ label, reason }); failed++; }
function assertTrue(v, msg) { if (v !== true) throw new Error(msg || `expected true, got ${JSON.stringify(v)}`); }
function assertEqual(a, b, msg) { if (a !== b) throw new Error(msg || `expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); }

async function pgConnect(database) {
  const client = new Client({
    host: process.env.PGHOST || 'localhost',
    port: parseInt(process.env.PGPORT || '5432', 10),
    user: process.env.PGUSER || 'postgres',
    password: process.env.PGPASSWORD || 'postgres',
    database,
  });
  // Swallow the 'error' event a dangling client emits if dropThrowawayDb's
  // pg_terminate_backend fires against it during test cleanup (e.g. after an
  // assertion throw skipped the normal db.end() call) -- without this handler
  // that is an unhandled 'error' event that crashes the whole process.
  client.on('error', () => {});
  await client.connect();
  return client;
}

let _pgAvail = null;
async function isPgAvailable() {
  if (_pgAvail !== null) return _pgAvail;
  try {
    const c = await pgConnect('postgres');
    await c.end();
    _pgAvail = true;
  } catch (_) {
    _pgAvail = false;
    console.log('[INFO] Postgres unavailable — DB-backed tests will be SKIPPED.');
  }
  return _pgAvail;
}

async function createThrowawayDb(dbName) {
  const sys = await pgConnect('postgres');
  try {
    await sys.query(`DROP DATABASE IF EXISTS "${dbName}"`);
    await sys.query(`CREATE DATABASE "${dbName}"`);
  } finally {
    await sys.end();
  }
}

async function dropThrowawayDb(dbName) {
  try {
    const sys = await pgConnect('postgres');
    try {
      await sys.query(
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()`,
        [dbName]
      );
      await sys.query(`DROP DATABASE IF EXISTS "${dbName}"`);
    } finally {
      await sys.end();
    }
  } catch (_) { /* best-effort */ }
}

// ── T1: aged-DB fixture ───────────────────────────────────────────────────────

async function testT1() {
  const label = 'T1: aged-DB fixture — core-only + dropped 1:1 index + live-duplicate pair; real ensureSchemaCurrent never falsely marks success';
  if (!(await isPgAvailable())) { console.log(`SKIP  ${label} (Postgres unavailable)`); return; }

  const dbName = `cm185_t1_${Date.now()}`;
  const PID = 'cm185-t1-project';

  try {
    await createThrowawayDb(dbName);

    // (1) Provision with ONLY the core schema file, applied wholesale (the
    // literal S-19 prescription — this is what an old install, or one
    // provisioned before app-retrieval-events-schema.sql was ordered into the
    // roster, looks like).
    const coreSchemaSql = fs.readFileSync(
      path.join(PROJECT_ROOT, 'scripts', 'sql', 'handoff-core-schema.sql'), 'utf8'
    );
    let db = await pgConnect(dbName);
    await db.query('BEGIN');
    await db.query(coreSchemaSql);
    await db.query('COMMIT');

    // (2) Simulate the aged-DB state this bug class requires: the 1:1
    // integrity index is ABSENT (a duplicate live pair cannot coexist with a
    // working unique index in Postgres — the only physically realizable way
    // to reach "duplicate rows + no index" is for the index to not be present
    // when the rows are written, exactly what an old engine build, a rolling
    // deploy window, or this very S-11 bug would produce) and two LIVE rows
    // share (project_id, subject, predicate) for a real 1:1-cardinality
    // predicate ('chose'), with different objects so the 1:N exact-duplicate
    // index (a different, 4-column invariant) is NOT violated.
    await db.query(`DROP INDEX IF EXISTS assertions_1to1_unique`);
    await db.query(
      `INSERT INTO assertions (project_id, subject, predicate, object, confidence, source, suppressed)
       VALUES ($1, 'aged-subject', 'chose', 'option-A', 8, 'user_stated', false)`,
      [PID]
    );
    await db.query(
      `INSERT INTO assertions (project_id, subject, predicate, object, confidence, source, suppressed)
       VALUES ($1, 'aged-subject', 'chose', 'option-B', 8, 'user_stated', false)`,
      [PID]
    );

    // (3) Run the REAL ensureSchemaCurrent (not a mirror).
    const adapter = new PostgresAdapter(db);
    const result = await handoffModule.ensureSchemaCurrent(adapter, PID, { silent: true });

    // (4) Assertions.
    assertFalse_(result.applied, 'T1: apply must NOT report success (integrity index failed)');
    assertEqual(result.reason, 'integrity_index_failed', 'T1: reason is integrity_index_failed');

    const { rows: rteRows } = await db.query(
      `SELECT 1 FROM information_schema.tables WHERE table_name = 'retrieval_events'`
    );
    assertEqual(rteRows.length, 1, 'T1: retrieval_events exists — the later app-retrieval-events-schema.sql unit still applied despite the earlier unit\'s Phase-B index failure');

    const { rows: fpRows } = await db.query(
      `SELECT value FROM project_settings WHERE project_id=$1 AND key='schema_fingerprint'`,
      [PID]
    );
    assertEqual(fpRows.length, 0, 'T1: schema_fingerprint was NEVER upserted — retry will be attempted on the next invocation, not falsely marked current forever');

    const { rows: degRows } = await db.query(
      `SELECT value FROM project_settings WHERE project_id=$1 AND key='schema_apply_degraded'`,
      [PID]
    );
    assertEqual(degRows.length, 1, 'T1: persistent schema_apply_degraded row written (surfaced by /handoff:status and the resume banner)');
    const degParsed = JSON.parse(degRows[0].value);
    assertEqual(degParsed.reason, 'integrity_index_failed', 'T1: degradation reason recorded correctly');

    const { rows: idxRows } = await db.query(
      `SELECT 1 FROM pg_indexes WHERE indexname = 'assertions_1to1_unique'`
    );
    assertEqual(idxRows.length, 0, 'T1: index remains in its pre-attempt (absent) state — the failed atomic DROP+CREATE pair left it exactly as it started, never left "dropped but not recreated"');

    // Retry: still degraded (dupes are still there), never a false "current".
    const retry = await handoffModule.ensureSchemaCurrent(adapter, PID, { silent: true });
    assertFalse_(retry.applied, 'T1 retry: still refuses to falsely mark success while the dupes remain');

    await db.end();
    pass(label);
  } catch (err) {
    fail(label, err.message);
  } finally {
    await dropThrowawayDb(dbName);
  }
}

function assertFalse_(v, msg) { if (v !== false) throw new Error(msg || `expected false, got ${JSON.stringify(v)}`); }

// ── T2: atomic DROP+CREATE pair regression proof ──────────────────────────────

async function testT2() {
  const label = 'T2: runIntegrityIndexPair — a previously-WORKING index survives a failed re-create attempt (S-11 sharpest claim)';
  if (!(await isPgAvailable())) { console.log(`SKIP  ${label} (Postgres unavailable)`); return; }

  const dbName = `cm185_t2_${Date.now()}`;
  try {
    await createThrowawayDb(dbName);
    const coreSchemaSql = fs.readFileSync(
      path.join(PROJECT_ROOT, 'scripts', 'sql', 'handoff-core-schema.sql'), 'utf8'
    );
    const db = await pgConnect(dbName);
    await db.query('BEGIN');
    await db.query(coreSchemaSql);
    await db.query('COMMIT');

    // Confirm the index exists and is genuinely working (clean DB, no dupes).
    const before = await db.query(`SELECT indexdef FROM pg_indexes WHERE indexname = 'assertions_1to1_unique'`);
    assertEqual(before.rows.length, 1, 'T2 precondition: index exists before the pair attempt');

    const adapter = new PostgresAdapter(db);
    // Deliberately-broken CREATE (references a nonexistent column) forces the
    // failure path without needing physically-impossible duplicate data.
    const result = await adapter.runIntegrityIndexPair(
      `DROP INDEX IF EXISTS assertions_1to1_unique;`,
      `CREATE UNIQUE INDEX assertions_1to1_unique ON assertions (project_id, this_column_does_not_exist_xyz);`
    );
    assertFalse_(result.ok, 'T2: the pair reports failure');

    const after = await db.query(`SELECT indexdef FROM pg_indexes WHERE indexname = 'assertions_1to1_unique'`);
    assertEqual(after.rows.length, 1, 'T2: the index STILL EXISTS after the failed pair — the DROP was rolled back together with the failed CREATE, never left destroyed');
    assertEqual(after.rows[0].indexdef, before.rows[0].indexdef, 'T2: the surviving index definition is byte-identical to the original (not silently altered)');

    await db.end();
    pass(label);
  } catch (err) {
    fail(label, err.message);
  } finally {
    await dropThrowawayDb(dbName);
  }
}

// ── T3: run-twice zero-DDL idempotency ────────────────────────────────────────

async function testT3() {
  const label = 'T3: run-twice idempotency — second ensureSchemaCurrent call after a successful apply is a pure no-op';
  if (!(await isPgAvailable())) { console.log(`SKIP  ${label} (Postgres unavailable)`); return; }

  const dbName = `cm185_t3_${Date.now()}`;
  const PID = 'cm185-t3-project';
  try {
    await createThrowawayDb(dbName);
    const db = await pgConnect(dbName);
    const adapter = new PostgresAdapter(db);

    // ensureSchemaCurrent's precondition (unchanged from the pre-cm#185 engine)
    // is that project_settings already exists -- cmdInit always runs the full
    // bootstrap apply before ensureSchemaCurrent is ever invoked in production
    // (cmdLoaderLoad/cmdClose, never cmdInit itself). Bootstrap the same way
    // here: a bare `CREATE TABLE project_settings` is enough to satisfy the
    // precondition without duplicating the whole apply engine.
    await db.query(
      `CREATE TABLE project_settings (project_id TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (project_id, key))`
    );

    const first = await handoffModule.ensureSchemaCurrent(adapter, PID, { silent: true });
    assertTrue(first.applied, 'T3: first call applies (fresh DB)');

    const { rows: fp1 } = await db.query(
      `SELECT value FROM project_settings WHERE project_id=$1 AND key='schema_fingerprint'`, [PID]
    );

    const second = await handoffModule.ensureSchemaCurrent(adapter, PID, { silent: true });
    assertFalse_(second.applied, 'T3: second call is a no-op');
    assertEqual(second.reason, 'current', 'T3: second-call reason is "current"');

    const { rows: fp2 } = await db.query(
      `SELECT value FROM project_settings WHERE project_id=$1 AND key='schema_fingerprint'`, [PID]
    );
    assertEqual(fp2[0].value, fp1[0].value, 'T3: fingerprint value unchanged by the no-op call');

    await db.end();
    pass(label);
  } catch (err) {
    fail(label, err.message);
  } finally {
    await dropThrowawayDb(dbName);
  }
}

// ── T4: CRLF/BOM fingerprint stability (pure, no DB) ──────────────────────────

function testT4() {
  const label = 'T4: fingerprint(CRLF+BOM) === fingerprint(LF) — the S-8 cross-platform stability gate';
  try {
    const coreFile = path.join(PROJECT_ROOT, 'scripts', 'sql', 'handoff-core-schema.sql');
    const rawOnDisk = fs.readFileSync(coreFile, 'utf8');
    const lfContent = rawOnDisk.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    const crlfBomContent = '﻿' + lfContent.replace(/\n/g, '\r\n');

    const lfTmp = path.join(os.tmpdir(), `cm185-t4-lf-${Date.now()}.sql`);
    const crlfTmp = path.join(os.tmpdir(), `cm185-t4-crlfbom-${Date.now()}.sql`);
    fs.writeFileSync(lfTmp, lfContent, 'utf8');
    fs.writeFileSync(crlfTmp, crlfBomContent, 'utf8');

    const hashLF = handoffModule._hashSchemaFileNormalized(lfTmp);
    const hashCRLFBOM = handoffModule._hashSchemaFileNormalized(crlfTmp);

    fs.unlinkSync(lfTmp);
    fs.unlinkSync(crlfTmp);

    assertEqual(hashLF, hashCRLFBOM, 'T4: normalized hash is identical for LF vs CRLF+BOM copies of the same content');

    // Also assert normalizeContent() itself round-trips correctly (unit-level,
    // independent of the file-hash cache).
    assertEqual(normalizeContent(crlfBomContent), lfContent, 'T4: normalizeContent strips BOM and normalizes CRLF/CR -> LF');

    pass(label);
  } catch (err) {
    fail(label, err.message);
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('=== test-schema-bring-forward.js (cm#185 aged-DB fixture + atomic-pair proof) ===');
  testT4();
  await testT1();
  await testT2();
  await testT3();

  console.log('');
  console.log(`Results: ${passed} passed, ${failed} failed`);
  if (failures.length > 0) {
    console.log('\nFailures:');
    for (const f of failures) console.log(`  FAIL  ${f.label}: ${f.reason}`);
    process.exit(1);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error('Unexpected error:', err);
  process.exit(1);
});
