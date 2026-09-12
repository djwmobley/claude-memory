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
 * T5  cmdInit regression (independent review B1): the SAME aged-DB
 *     construction as T1, but driving the real `handoff.js init -y` CLI (not
 *     ensureSchemaCurrent directly) as a subprocess -- init's own fatal
 *     post-apply verification previously re-promoted the non-fatal integrity-
 *     index WARN into a hard `process.exit(1)`, contradicting the WARN
 *     block's own "handoff init succeeds WITHOUT this index" text. Asserts
 *     exit 0, the WARN block present, verification reports PASSED (not
 *     FAILED), retrieval_events still created, the failed index remains
 *     absent, and cmdInit never writes schema_fingerprint at all (so R-6's
 *     "never upsert on integrity failure" invariant holds identically on
 *     both the init path and the ensureSchemaCurrent sentinel path).
 * T11 Manifest lint (PR-A fix-what-you-flag categorical guard, 2026-09-12):
 *     (a) every unit with classification "postgres" that declares a
 *     non-empty expected_objects.tables must also declare a non-empty
 *     expected_objects.columns (a totally-empty columns list on a unit with
 *     real tables is exactly the F2-class gap Codex review flagged for the
 *     telemetry units -- a dropped base column is invisible to the
 *     fingerprint-'current' fast path forever), and every column named in
 *     that list must textually appear in the unit's own SQL file (manifest/
 *     DDL identifier parity, mirrors schema-classify.js's own check but in
 *     the missing-coverage direction that check does not cover); (b) every
 *     table in a required_roster postgres unit whose own DDL declares an
 *     ANONYMOUS table-level UNIQUE constraint (not a named CREATE UNIQUE
 *     INDEX, not a PRIMARY KEY) must have a matching expected_uniques entry
 *     -- a table whose only uniqueness guarantee is its PRIMARY KEY needs no
 *     further manifest tracking (this manifest format has no
 *     expected_primary_keys field), and a table with neither a PK nor an
 *     anonymous UNIQUE in its own DDL (e.g. retrieval_event_assertions, an
 *     observability-only join table by design) is out of this check's scope
 *     entirely, never a false failure. Pure, no DB required. Fixture proof:
 *     a fixture unit with "columns": [] must fail (a); the live manifest,
 *     after this same commit populates app-retrieval-events-schema.sql's
 *     previously-empty columns list and handoff-core-schema.sql's
 *     previously-untracked retrieval_contract UNIQUE (project_id, name),
 *     must pass both (a) and (b).
 *
 * Requires Postgres (PGHOST/PGUSER/PGPASSWORD, defaults localhost/postgres/postgres).
 * T4 and T11 are pure and run with no DB. Exit 0 = all run tests passed.
 */

const fs   = require('fs');
const path = require('path');
const os   = require('os');
const { spawnSync } = require('child_process');
const { Client } = require('pg');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const handoffModule = require(path.join(PROJECT_ROOT, 'scripts', 'handoff.js'));
const { PostgresAdapter } = require(path.join(PROJECT_ROOT, 'scripts', 'lib', 'db-seam.js'));
const { classifySchemaFiles, normalizeContent } = require(path.join(PROJECT_ROOT, 'scripts', 'lib', 'schema-classify.js'));
// cm#224 follow-up: shared guarded pgvector-extension installer.
const { ensureVectorExtension } = require(path.join(PROJECT_ROOT, 'scripts', 'lib', 'test-pg-helpers.js'));
// PR-A (2026-09-12): usage_query's feature-granularity read, exercised
// against the fresh heal-only DB in testT6 below. Codex review follow-up
// (2026-09-12): usageRecord, exercised against a model_registry-less fresh
// engine DB in testT8 below (F1).
const { usageQuery, usageRecord } = require(path.join(PROJECT_ROOT, 'scripts', 'lib', 'usage-telemetry.js'));

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

    // cm#224 follow-up: this test's own intent is run-twice IDEMPOTENCY,
    // unrelated to pgvector — create the extension (via the ONE shared,
    // guarded implementation) so the second-call assertion below isn't
    // confounded by the independent pgvector-gated-degradation check
    // ensureSchemaCurrent now also runs on every call (a scratch DB with no
    // vector extension genuinely IS degraded post-apply, correctly
    // reported as reason:'degraded' rather than 'current' — see
    // test/test-decisions-canon.js's dedicated T3 for that behavior's own
    // test coverage).
    await ensureVectorExtension(dbName);

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

// ── T5: cmdInit regression — legacy-duplicate corpus succeeds with warning ────

async function testT5() {
  const label = 'T5: `handoff.js init` against a legacy-duplicate corpus succeeds with warning (not exit 1); retrieval_events created; fingerprint never claimed';
  if (!(await isPgAvailable())) { console.log(`SKIP  ${label} (Postgres unavailable)`); return; }

  const dbName = `cm185_t5_${Date.now()}`;
  const projDir = path.join(os.tmpdir(), `cm185-t5-init-${Date.now()}`);

  try {
    await createThrowawayDb(dbName);

    // Seed the aged state BEFORE running init: core schema applied (so the
    // table + index exist), then the 1:1 index dropped and a live-duplicate
    // pair seeded -- identical construction to T1, but this time init itself
    // (not ensureSchemaCurrent directly) is the thing under test, since B1
    // was a cmdInit-only bug (the sentinel path was already correct — see T1).
    const coreSchemaSql = fs.readFileSync(
      path.join(PROJECT_ROOT, 'scripts', 'sql', 'handoff-core-schema.sql'), 'utf8'
    );
    const seedDb = await pgConnect(dbName);
    await seedDb.query('BEGIN');
    await seedDb.query(coreSchemaSql);
    await seedDb.query('COMMIT');
    await seedDb.query(`DROP INDEX IF EXISTS assertions_1to1_unique`);
    await seedDb.query(
      `INSERT INTO assertions (project_id, subject, predicate, object, confidence, source, suppressed)
       VALUES ('cm185-t5-seed', 'aged-subject', 'chose', 'option-A', 8, 'user_stated', false)`
    );
    await seedDb.query(
      `INSERT INTO assertions (project_id, subject, predicate, object, confidence, source, suppressed)
       VALUES ('cm185-t5-seed', 'aged-subject', 'chose', 'option-B', 8, 'user_stated', false)`
    );
    await seedDb.end();

    // Fresh throwaway project directory (git-initialized, no pre-existing
    // marker) — init needs a real .git for findProjectRoot.
    fs.mkdirSync(projDir, { recursive: true });
    const gitInit = spawnSync('git', ['-C', projDir, 'init', '-q'], { encoding: 'utf8' });
    if (gitInit.status !== 0) throw new Error(`git init failed: ${gitInit.stderr}`);

    const result = spawnSync(
      process.execPath,
      [path.join(PROJECT_ROOT, 'scripts', 'handoff.js'), 'init', '-y', '--no-embeddings'],
      {
        cwd: projDir,
        encoding: 'utf8',
        timeout: 30000,
        env: { ...process.env, HANDOFF_DB: dbName, PROJECT_ROOT: projDir },
      }
    );

    assertEqual(
      result.status, 0,
      `T5: init must exit 0 (succeed-with-warning), got ${result.status}. stdout:\n${result.stdout}\nstderr:\n${result.stderr}`
    );
    assertTrue(
      result.stdout.includes('Integrity index NOT created: assertions_1to1_unique'),
      'T5: init prints the WARN block for the failed integrity index'
    );
    assertTrue(
      result.stdout.includes('handoff init succeeds WITHOUT'),
      'T5: init prints the §7 SKIP "succeeds WITHOUT this index" message'
    );
    assertTrue(
      result.stdout.includes('Post-apply schema verification passed'),
      'T5: post-apply verification still reports PASSED (the failed index was excluded from the expected set, not the whole check skipped)'
    );
    assertTrue(
      !result.stdout.includes('Post-apply schema verification failed'),
      'T5: init must NOT report verification FAILED'
    );

    const verifyDb = await pgConnect(dbName);
    try {
      const { rows: rteRows } = await verifyDb.query(
        `SELECT 1 FROM information_schema.tables WHERE table_name = 'retrieval_events'`
      );
      assertEqual(rteRows.length, 1, "T5: retrieval_events was still created by init despite the earlier unit's integrity-index failure");

      const { rows: idxRows } = await verifyDb.query(
        `SELECT 1 FROM pg_indexes WHERE indexname = 'assertions_1to1_unique'`
      );
      assertEqual(idxRows.length, 0, 'T5: the failed index remains absent (not falsely reported present)');

      const { rows: fpRows } = await verifyDb.query(
        `SELECT 1 FROM project_settings WHERE key = 'schema_fingerprint'`
      );
      assertEqual(
        fpRows.length, 0,
        'T5: cmdInit never writes schema_fingerprint at all (consistent with ensureSchemaCurrent, which also never upserts it when an integrity index fails — R-6 semantics hold on both paths)'
      );
    } finally {
      await verifyDb.end();
    }

    pass(label);
  } catch (err) {
    fail(label, err.message);
  } finally {
    await dropThrowawayDb(dbName);
    try { fs.rmSync(projDir, { recursive: true, force: true }); } catch (_) { /* best-effort */ }
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

// ── T6: PR-A telemetry-manifest registration — classification + fresh-DB
//     provisioning + idempotency + empty feature-grain query ────────────────
//
// Adversary G4 guard: this must NOT pass merely because
// memory_manager_staging already carries these tables from the pre-existing
// migrate-schema-addenda.js path — every assertion below runs against a
// FRESH throwaway DB this test provisions itself, with nothing seeded, so a
// manifest registration bug (missing unit, wrong classification, wrong
// order, phantom expected_objects entry) would fail here even if staging
// looked fine.

async function testT6() {
  const label = 'T6: usage-telemetry-schema.sql + feature-usage-schema.sql — classified postgres, fresh-DB apply creates all 3 tables/8 named indexes/3 uniques/2 checks, idempotent re-run, empty feature-grain query';
  if (!(await isPgAvailable())) { console.log(`SKIP  ${label} (Postgres unavailable)`); return; }

  // (a)+(b): classification + manifest/DDL identifier parity — no DB needed.
  const classification = classifySchemaFiles({ engineRoot: PROJECT_ROOT });
  assertTrue(classification.ok, `T6(a/b): classifySchemaFiles reports ok (manifest/DDL desync would fail here) — errors: ${JSON.stringify(classification.errors)}`);
  const postgresBasenames = classification.unitsByDialect.postgres.map((u) => u.basename);
  assertTrue(postgresBasenames.includes('usage-telemetry-schema.sql'), 'T6(a): usage-telemetry-schema.sql classified postgres and present');
  assertTrue(postgresBasenames.includes('feature-usage-schema.sql'), 'T6(a): feature-usage-schema.sql classified postgres and present');
  const usageUnit = classification.unitsByDialect.postgres.find((u) => u.basename === 'usage-telemetry-schema.sql');
  const featureUnit = classification.unitsByDialect.postgres.find((u) => u.basename === 'feature-usage-schema.sql');
  assertTrue(usageUnit.order < featureUnit.order, 'T6(b): usage-telemetry-schema.sql (order 40) sorts before feature-usage-schema.sql (order 50)');

  const dbName = `cm_pra_t6_${Date.now()}`;
  const PID = 'cm-pra-t6-project';
  try {
    await createThrowawayDb(dbName);
    await ensureVectorExtension(dbName);

    const db = await pgConnect(dbName);
    const adapter = new PostgresAdapter(db);

    // Bootstrap precondition only (identical to T3): a fresh throwaway DB
    // with NOTHING but project_settings — every table this test asserts on
    // must come from ensureSchemaCurrent's own additive apply, not from any
    // fixture SQL this test applies by hand.
    await db.query(
      `CREATE TABLE project_settings (project_id TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (project_id, key))`
    );

    // (c): fresh apply.
    const first = await handoffModule.ensureSchemaCurrent(adapter, PID, { silent: true });
    assertTrue(first.applied, 'T6(c): first call applies against the fresh DB');

    const { rows: tableRows } = await db.query(
      `SELECT table_name FROM information_schema.tables WHERE table_name IN ('turn_usage','session_usage','feature_usage') ORDER BY table_name`
    );
    assertEqual(tableRows.length, 3, 'T6(c): all 3 tables (turn_usage, session_usage, feature_usage) exist after a bare fresh-DB apply');

    const expectedNamedIndexes = [
      'turn_usage_project_idx', 'turn_usage_session_idx', 'turn_usage_model_idx', 'session_usage_project_idx',
      'feature_usage_project_idx', 'feature_usage_project_branch_idx', 'feature_usage_project_pr_idx', 'feature_usage_session_ids_gin_idx',
    ];
    const { rows: idxRows } = await db.query(
      `SELECT indexname FROM pg_indexes WHERE indexname = ANY($1::text[])`,
      [expectedNamedIndexes]
    );
    assertEqual(idxRows.length, 8, `T6(c): all 8 explicitly-named indexes across both units exist (got ${idxRows.length}: ${idxRows.map((r) => r.indexname).join(',')})`);

    const { rows: uqRows } = await db.query(
      `SELECT conrelid::regclass::text AS tbl FROM pg_constraint
        WHERE contype = 'u' AND conrelid IN ('turn_usage'::regclass, 'session_usage'::regclass, 'feature_usage'::regclass)`
    );
    assertEqual(uqRows.length, 3, `T6(c): all 3 anonymous table-level UNIQUE constraints exist (adversary G6 — verified as constraints, not named indexes), got ${uqRows.length}`);

    const { rows: ckRows } = await db.query(
      `SELECT conname FROM pg_constraint WHERE contype = 'c' AND conrelid = 'turn_usage'::regclass`
    );
    assertEqual(ckRows.length, 2, `T6(c): turn_usage carries exactly 2 CHECK constraints (resolved_via, outcome), got ${ckRows.length}`);

    // (d): idempotent re-run — zero DDL errors, reason 'current'.
    const second = await handoffModule.ensureSchemaCurrent(adapter, PID, { silent: true });
    assertFalse_(second.applied, 'T6(d): second call is a no-op');
    assertEqual(second.reason, 'current', 'T6(d): second-call reason is "current" — no DDL re-attempted');

    // usageQuery granularity='feature' against this fresh, heal-only-created
    // DB: feature_usage exists but has zero rows (never backfilled here) —
    // must return an EMPTY ARRAY, never throw (G1: this is empty by design,
    // not a defect — feature_usage is populated only by migrate-12-
    // feature-usage.js's data migration or a live feature run, never by
    // schema apply itself).
    const featureResult = await usageQuery(db, { projectId: PID, granularity: 'feature' });
    assertTrue(Array.isArray(featureResult), 'T6: usageQuery(feature) returns an array');
    assertEqual(featureResult.length, 0, 'T6: usageQuery(feature) against the fresh heal-only DB returns an EMPTY result, not an error');

    await db.end();
    pass(label);
  } catch (err) {
    fail(label, err.message);
  } finally {
    await dropThrowawayDb(dbName);
  }
}

// ── T7: (e) hand-made turn_usage missing the resolved_via CHECK — healed
//     exactly once via the fingerprint-'current' fast path, no loop on the
//     second touch ──────────────────────────────────────────────────────────

async function testT7() {
  const label = 'T7: turn_usage missing the resolved_via CHECK — healed on the first fast-path touch, idempotent (no re-heal, no duplicate constraint) on the second';
  if (!(await isPgAvailable())) { console.log(`SKIP  ${label} (Postgres unavailable)`); return; }

  const dbName = `cm_pra_t7_${Date.now()}`;
  const PID = 'cm-pra-t7-project';
  try {
    await createThrowawayDb(dbName);
    await ensureVectorExtension(dbName);

    const db = await pgConnect(dbName);
    const adapter = new PostgresAdapter(db);
    await db.query(
      `CREATE TABLE project_settings (project_id TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (project_id, key))`
    );

    // Establish a clean, fully-applied, fingerprint-'current' baseline first
    // (mirrors a live install that has already run init/heal once).
    const baseline = await handoffModule.ensureSchemaCurrent(adapter, PID, { silent: true });
    assertTrue(baseline.applied, 'T7 precondition: baseline apply succeeds');

    // Simulate the "hand-made turn_usage" aged state (adversary G4: a
    // pre-existing table that was never healed, not a fresh CREATE) by
    // dropping ONLY the resolved_via CHECK constraint by hand -- turn_usage
    // itself, its other CHECK (outcome), and its indexes/uniques are left
    // untouched, so this exercises the CHECK-heal path in isolation.
    await db.query(`ALTER TABLE turn_usage DROP CONSTRAINT turn_usage_resolved_via_check`);
    const { rows: droppedCheck } = await db.query(
      `SELECT conname FROM pg_constraint WHERE contype = 'c' AND conrelid = 'turn_usage'::regclass`
    );
    assertEqual(droppedCheck.length, 1, 'T7 precondition: only the outcome CHECK remains after the hand-drop');

    // First touch after the hand-drop: fingerprint is STILL 'current' (SQL
    // bytes never changed) — this must heal via the fast-path constraint-heal
    // block (never re-run the whole additive apply), and must not error.
    const healRun = await handoffModule.ensureSchemaCurrent(adapter, PID, { silent: true });
    assertFalse_(healRun.applied, 'T7: heal touch does not report a fresh "applied" (fingerprint was already current -- the heal is folded into the fast path, not a new apply)');
    assertEqual(healRun.reason, 'current', 'T7: heal touch resolves to "current" once the CHECK is healed');

    const { rows: healedCheck } = await db.query(
      `SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE contype = 'c' AND conrelid = 'turn_usage'::regclass ORDER BY conname`
    );
    assertEqual(healedCheck.length, 2, 'T7: exactly 2 CHECK constraints on turn_usage after healing (resolved_via re-added, outcome untouched) -- not 0, not 3');
    assertTrue(
      healedCheck.some((r) => r.def.includes("'directive'") && r.def.includes("'recommendation'")),
      'T7: the healed resolved_via CHECK carries the correct def'
    );

    // Second touch: must be a pure no-op — no loop, no duplicate ADD
    // CONSTRAINT, no error.
    const secondTouch = await handoffModule.ensureSchemaCurrent(adapter, PID, { silent: true });
    assertFalse_(secondTouch.applied, 'T7: second touch is a no-op');
    assertEqual(secondTouch.reason, 'current', 'T7: second touch reason is "current"');

    const { rows: finalCheck } = await db.query(
      `SELECT conname FROM pg_constraint WHERE contype = 'c' AND conrelid = 'turn_usage'::regclass`
    );
    assertEqual(finalCheck.length, 2, 'T7: still exactly 2 CHECK constraints after the second touch — no duplicate re-heal, no loop');

    await db.end();
    pass(label);
  } catch (err) {
    fail(label, err.message);
  } finally {
    await dropThrowawayDb(dbName);
  }
}

// ── T8: Codex review F1 — computeServerSideCost fails soft when
//     model_registry does not exist on a fresh engine DB ────────────────────
//
// model_registry is created by scripts/migrations/sql/model-registry-base.sql
// via migrate-schema-addenda.js, NOT by any scripts/sql/*.sql unit
// ensureSchemaCurrent applies -- so a fresh engine DB provisioned by
// ensureSchemaCurrent ALONE (exactly what this test does) genuinely has no
// model_registry table at all. usageRecord with costUsd omitted must
// therefore succeed with cost_usd NULL (fail-soft), never throw pg's raw
// 42P01 (undefined_table).

async function testT8() {
  const label = 'T8: Codex review F1 — usageRecord(costUsd omitted) against a fresh engine DB with no model_registry succeeds, cost_usd NULL, one stderr line, no throw';
  if (!(await isPgAvailable())) { console.log(`SKIP  ${label} (Postgres unavailable)`); return; }

  const dbName = `cm_pra_t8_${Date.now()}`;
  const PID = 'cm-pra-t8-project';
  try {
    await createThrowawayDb(dbName);
    await ensureVectorExtension(dbName);

    const db = await pgConnect(dbName);
    const adapter = new PostgresAdapter(db);
    await db.query(
      `CREATE TABLE project_settings (project_id TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (project_id, key))`
    );

    // Provision via ensureSchemaCurrent ONLY — no migrate-schema-addenda.js,
    // no model-registry-base.sql applied by hand. This is the exact "fresh
    // engine DB" state F1 names.
    const apply = await handoffModule.ensureSchemaCurrent(adapter, PID, { silent: true });
    assertTrue(apply.applied, 'T8 precondition: fresh apply succeeds');

    const { rows: mrRows } = await db.query(
      `SELECT 1 FROM information_schema.tables WHERE table_name = 'model_registry'`
    );
    assertEqual(mrRows.length, 0, 'T8 precondition: model_registry genuinely does not exist on this DB');

    // Capture stderr to confirm the ONE documented fail-soft line, without
    // letting it print during a normal test run.
    const originalWrite = process.stderr.write.bind(process.stderr);
    const stderrLines = [];
    process.stderr.write = (chunk, ...args) => { stderrLines.push(String(chunk)); return true; };
    let result;
    try {
      result = await usageRecord(db, {
        projectId: PID, sessionId: 'sess-t8', turnIdx: 0, agentRole: 'test',
        modelId: 'claude-sonnet-5', tokensIn: 100, tokensOut: 50,
        // costUsd deliberately omitted -> COMPUTE branch -> hits the
        // model_registry lookup that does not exist.
      });
    } finally {
      process.stderr.write = originalWrite;
    }

    assertEqual(result.costUsd, null, 'T8: cost_usd is NULL (fail-soft), never a thrown error and never a guessed price');
    assertEqual(result.tokensIn, 100, 'T8: tokensIn written correctly despite the cost fail-soft branch');
    assertTrue(
      stderrLines.some((l) => l.includes('model_registry') && l.includes('42P01')),
      `T8: exactly one fail-soft stderr line naming model_registry + 42P01 was emitted — got: ${JSON.stringify(stderrLines)}`
    );

    // Explicit costUsd still wins (unaffected by the fail-soft branch, per
    // F1's own wording) — same model_registry-less DB, a second turn.
    const explicit = await usageRecord(db, {
      projectId: PID, sessionId: 'sess-t8', turnIdx: 1, agentRole: 'test',
      tokensIn: 10, tokensOut: 10, costUsd: 0.05,
    });
    assertEqual(explicit.costUsd, 0.05, 'T8: an explicit costUsd is used verbatim, never overridden by the fail-soft branch');

    await db.end();
    pass(label);
  } catch (err) {
    fail(label, err.message);
  } finally {
    await dropThrowawayDb(dbName);
  }
}

// ── T9: Codex review F2 — a dropped base column on turn_usage/session_usage/
//     feature_usage is no longer invisible to ensureSchemaCurrent's
//     fingerprint-'current' fast path ──────────────────────────────────────

async function testT9() {
  const label = 'T9: Codex review F2 — a hand-dropped feature_usage.tokens_in column is DETECTED on the next touch, never a silent reason:"current"';
  if (!(await isPgAvailable())) { console.log(`SKIP  ${label} (Postgres unavailable)`); return; }

  const dbName = `cm_pra_t9_${Date.now()}`;
  const PID = 'cm-pra-t9-project';
  try {
    await createThrowawayDb(dbName);
    await ensureVectorExtension(dbName);

    const db = await pgConnect(dbName);
    const adapter = new PostgresAdapter(db);
    await db.query(
      `CREATE TABLE project_settings (project_id TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (project_id, key))`
    );

    const baseline = await handoffModule.ensureSchemaCurrent(adapter, PID, { silent: true });
    assertTrue(baseline.applied, 'T9 precondition: baseline apply succeeds');

    // Hand-drop a BASE column (part of the original CREATE TABLE, never an
    // ALTER TABLE ADD COLUMN target — the exact shape F2's finding named).
    await db.query(`ALTER TABLE feature_usage DROP COLUMN tokens_in`);
    const { rows: droppedCol } = await db.query(
      `SELECT 1 FROM information_schema.columns WHERE table_name = 'feature_usage' AND column_name = 'tokens_in'`
    );
    assertEqual(droppedCol.length, 0, 'T9 precondition: tokens_in genuinely absent after the hand-drop');

    // Fingerprint is STILL 'current' (SQL bytes never changed) — this is
    // exactly the fast-path branch F2's finding named as silently reporting
    // "current" forever with an empty columns list. Parity check: this must
    // resolve to something OTHER than a clean 'current' no-op, mirroring how
    // handoff-core-schema.sql's own tracked columns are treated when absent
    // (S1(b): apply-and-reverify, not a silent pass).
    const touch = await handoffModule.ensureSchemaCurrent(adapter, PID, { silent: true });
    assertTrue(
      touch.reason !== 'current' || touch.applied === true,
      `T9: a dropped base column must never resolve to a silent applied:false/reason:'current' no-op — got ${JSON.stringify({ applied: touch.applied, reason: touch.reason })}`
    );
    // This unit's DDL is a bare CREATE TABLE IF NOT EXISTS (no ALTER TABLE
    // ADD COLUMN for tokens_in) — re-running it cannot itself resurrect a
    // dropped base column, so the concrete outcome here is
    // reason:'verification_failed' naming the missing column (S1(b)'s
    // post-apply schemaObjectsExist check), never a false 'current'.
    assertEqual(touch.reason, 'verification_failed', 'T9: reported as verification_failed (detected, not silently "current") — the column cannot self-heal from a bare CREATE TABLE IF NOT EXISTS, but the gap is no longer invisible');
    assertTrue(
      touch.detail.missing.some((m) => m.type === 'column' && m.table === 'feature_usage' && m.column === 'tokens_in'),
      `T9: the reported missing set names feature_usage.tokens_in specifically — got ${JSON.stringify(touch.detail.missing)}`
    );

    await db.end();
    pass(label);
  } catch (err) {
    fail(label, err.message);
  } finally {
    await dropThrowawayDb(dbName);
  }
}

// ── T10: Codex review F3 — usage-telemetry-schema.sql / feature-usage-
//     schema.sql are in required_roster; a fixture missing either file's own
//     SQL fails classification, never a silent ok:true ─────────────────────

function testT10() {
  const label = 'T10: Codex review F3 — usage-telemetry-schema.sql and feature-usage-schema.sql are BOTH in required_roster; a fixture missing either file fails classification naming it';
  try {
    // (a) The real, live manifest actually lists both — the literal fix.
    const liveManifestPath = path.join(PROJECT_ROOT, 'scripts', 'sql', 'schema-manifest.json');
    const liveManifest = JSON.parse(fs.readFileSync(liveManifestPath, 'utf8'));
    assertTrue(
      liveManifest.required_roster.includes('usage-telemetry-schema.sql'),
      'T10(a): usage-telemetry-schema.sql is in the live required_roster'
    );
    assertTrue(
      liveManifest.required_roster.includes('feature-usage-schema.sql'),
      'T10(a): feature-usage-schema.sql is in the live required_roster'
    );

    // (b) In-memory fixture: BOTH files declared in required_roster, but one
    // (usage-telemetry-schema.sql) is missing from scripts/sql/ entirely —
    // before F3 this returned ok:true (both units absent from required_roster
    // meant classifySchemaFiles never even looked for them).
    for (const missingFile of ['usage-telemetry-schema.sql', 'feature-usage-schema.sql']) {
      const scratchRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-pra-t10-'));
      const sqlDir = path.join(scratchRoot, 'scripts', 'sql');
      fs.mkdirSync(sqlDir, { recursive: true });

      const otherFile = missingFile === 'usage-telemetry-schema.sql' ? 'feature-usage-schema.sql' : 'usage-telemetry-schema.sql';
      fs.writeFileSync(
        path.join(sqlDir, otherFile),
        '-- handoff:dialect postgres\nCREATE TABLE IF NOT EXISTS widgets (id serial primary key);\n',
        'utf8'
      );
      fs.writeFileSync(
        path.join(sqlDir, 'schema-manifest.json'),
        JSON.stringify({
          schema_epoch: 1,
          required_roster: ['usage-telemetry-schema.sql', 'feature-usage-schema.sql'],
          units: {
            [otherFile]: { classification: 'postgres', order: 10, expected_objects: { tables: ['widgets'], columns: [], indexes: [] } },
          },
        }, null, 2),
        'utf8'
      );

      const result = classifySchemaFiles({ engineRoot: scratchRoot });
      assertFalse(result.ok, `T10(b): fixture missing ${missingFile} must fail classification (ok:false), not silently pass`);
      assertTrue(
        result.errors.some((e) => e.includes(missingFile) && e.includes('required schema file missing')),
        `T10(b): an error names the specific missing file "${missingFile}" — got ${JSON.stringify(result.errors)}`
      );

      fs.rmSync(scratchRoot, { recursive: true, force: true });
    }

    pass(label);
  } catch (err) {
    fail(label, err.message);
  }
}

function assertFalse(v, msg) { if (v !== false) throw new Error(msg || `expected false, got ${JSON.stringify(v)}`); }

// ── T11: manifest lint — every postgres unit's tables carry non-empty,
//     DDL-backed columns; every required-roster table's anonymous DDL
//     UNIQUE is tracked in expected_uniques ─────────────────────────────────

function _escapeRegExpT11(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

// Cheap textual sanity check — NOT a DDL parser (mirrors schema-classify.js's
// own internal _identifierAppearsInSQL, reimplemented here rather than
// exported from that module since this file has no other reason to import
// its private surface).
function _identifierInSqlT11(sql, identifier) {
  if (typeof identifier !== 'string' || identifier.length === 0) return false;
  return new RegExp('\\b' + _escapeRegExpT11(identifier) + '\\b', 'i').test(sql);
}

// Extracts the column-list text between a CREATE TABLE [IF NOT EXISTS]
// <table> ( ... ) statement's own outer parens, via paren-depth counting (so
// nested CHECK(...)/DEFAULT now() parens don't terminate the scan early).
// Returns null if no CREATE TABLE for `table` is found in `sqlText`.
function _createTableBlockT11(sqlText, table) {
  const re = new RegExp('CREATE\\s+TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?' + _escapeRegExpT11(table) + '\\s*\\(', 'i');
  const m = re.exec(sqlText);
  if (!m) return null;
  let depth = 1;
  let i = m.index + m[0].length;
  const start = i;
  while (i < sqlText.length && depth > 0) {
    if (sqlText[i] === '(') depth++;
    else if (sqlText[i] === ')') depth--;
    i++;
  }
  return sqlText.slice(start, i - 1);
}

// True iff `table`'s own CREATE TABLE block declares an ANONYMOUS table-level
// UNIQUE constraint (`UNIQUE (...)` inside the column list) — deliberately
// excludes a standalone `CREATE UNIQUE INDEX ...` (outside the block, tracked
// instead via expected_index_defs/indexes) and a column-level `... UNIQUE`
// modifier folded into a PRIMARY KEY (a bare PK needs no expected_uniques
// entry — this manifest format has no expected_primary_keys field at all).
function _ddlHasAnonUniqueT11(sqlText, table) {
  const block = _createTableBlockT11(sqlText, table);
  if (block == null) return false;
  return /(?:^|[,\n])\s*UNIQUE\s*\(/i.test(block);
}

function _lintManifestT11(manifest, sqlDir) {
  const errors = [];
  const units = manifest.units || {};
  const roster = new Set(manifest.required_roster || []);

  for (const [basename, unit] of Object.entries(units)) {
    if (unit.classification !== 'postgres') continue;
    const eo = unit.expected_objects || {};
    const tables = Array.isArray(eo.tables) ? eo.tables : [];
    if (tables.length === 0) continue; // nothing to check (excluded/roster-less units land here too)

    const columns = Array.isArray(eo.columns) ? eo.columns : [];
    if (columns.length === 0) {
      errors.push(
        `${basename}: expected_objects.tables is non-empty (${tables.join(', ')}) but expected_objects.columns ` +
        `is EMPTY — every classification:postgres unit with tables must declare its columns (T11 categorical guard)`
      );
      continue; // no columns to identifier-parity-check
    }

    let sqlText = null;
    try { sqlText = fs.readFileSync(path.join(sqlDir, basename), 'utf8'); } catch (_) { /* reported below */ }
    if (sqlText == null) {
      errors.push(`${basename}: expected_objects.columns declared but the unit's own SQL file could not be read for identifier-parity checking`);
      continue;
    }

    for (const c of columns) {
      if (!c || typeof c.column !== 'string' || !_identifierInSqlT11(sqlText, c.column)) {
        errors.push(
          `${basename}: expected_objects.columns entry "${c && c.table}.${c && c.column}" has no textual match ` +
          `in ${basename}'s own SQL file — manifest/DDL desync`
        );
      }
    }

    // (b) required-roster uniques-or-PK coverage — scoped to roster units
    // only (the required-roster is the set schema-classify.js's own F3 fix
    // treats as mandatory; a non-roster postgres unit's uniqueness tracking
    // is not this guard's concern).
    if (roster.has(basename)) {
      const uniques = Array.isArray(unit.expected_uniques) ? unit.expected_uniques : [];
      for (const table of tables) {
        if (!_ddlHasAnonUniqueT11(sqlText, table)) continue; // no anonymous UNIQUE for this table — nothing to track (a bare PK, or neither, is out of scope)
        const tracked = uniques.some((u) => u && u.table === table);
        if (!tracked) {
          errors.push(
            `${basename}: required-roster table "${table}" declares an anonymous UNIQUE constraint in its own DDL ` +
            `with no matching expected_uniques entry — untracked constraint would go un-healed if dropped`
          );
        }
      }
    }
  }

  return errors;
}

function testT11() {
  const label = 'T11: manifest lint — every postgres unit with tables declares non-empty, DDL-identifier-parity-checked columns; every required-roster anonymous-UNIQUE table is tracked in expected_uniques';
  try {
    const sqlDir = path.join(PROJECT_ROOT, 'scripts', 'sql');

    // (1) Fixture: a unit with non-empty tables but columns: [] must FAIL —
    // the exact shape app-retrieval-events-schema.sql had before this commit.
    const fixtureManifest = {
      required_roster: [],
      units: {
        'usage-telemetry-schema.sql': {
          classification: 'postgres',
          expected_objects: { tables: ['turn_usage', 'session_usage'], columns: [], indexes: [] },
        },
      },
    };
    const fixtureErrors = _lintManifestT11(fixtureManifest, sqlDir);
    assertTrue(
      fixtureErrors.some((e) => e.includes('usage-telemetry-schema.sql') && e.includes('EMPTY')),
      `T11(1): fixture unit with columns: [] must be flagged — got ${JSON.stringify(fixtureErrors)}`
    );

    // (2) Fixture: a bogus column name (no textual match in the real SQL
    // file) must FAIL identifier parity.
    const fixtureDesync = {
      required_roster: [],
      units: {
        'usage-telemetry-schema.sql': {
          classification: 'postgres',
          expected_objects: {
            tables: ['turn_usage'],
            columns: [{ table: 'turn_usage', column: 'this_column_does_not_exist_xyz' }],
            indexes: [],
          },
        },
      },
    };
    const desyncErrors = _lintManifestT11(fixtureDesync, sqlDir);
    assertTrue(
      desyncErrors.some((e) => e.includes('this_column_does_not_exist_xyz') && e.includes('manifest/DDL desync')),
      `T11(2): fixture with a phantom column name must be flagged as manifest/DDL desync — got ${JSON.stringify(desyncErrors)}`
    );

    // (3) Fixture: a required-roster table with an anonymous DDL UNIQUE and
    // no expected_uniques entry must FAIL (b).
    const fixtureUnique = {
      required_roster: ['usage-telemetry-schema.sql'],
      units: {
        'usage-telemetry-schema.sql': {
          classification: 'postgres',
          expected_objects: {
            tables: ['turn_usage', 'session_usage'],
            columns: [{ table: 'turn_usage', column: 'project_id' }, { table: 'session_usage', column: 'project_id' }],
            indexes: [],
          },
          expected_uniques: [],
        },
      },
    };
    const uniqueErrors = _lintManifestT11(fixtureUnique, sqlDir);
    assertTrue(
      uniqueErrors.some((e) => e.includes('turn_usage') && e.includes('anonymous UNIQUE')),
      `T11(3): fixture with an untracked anonymous DDL UNIQUE on a required-roster table must be flagged — got ${JSON.stringify(uniqueErrors)}`
    );

    // (4) The live manifest, after this same commit's fixes, passes BOTH
    // checks cleanly — zero errors, not merely "fewer" errors.
    const liveManifestPath = path.join(sqlDir, 'schema-manifest.json');
    const liveManifest = JSON.parse(fs.readFileSync(liveManifestPath, 'utf8'));
    const liveErrors = _lintManifestT11(liveManifest, sqlDir);
    assertEqual(liveErrors.length, 0, `T11(4): live schema-manifest.json must pass the lint cleanly — got ${JSON.stringify(liveErrors)}`);

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
  await testT5();
  await testT6();
  await testT7();
  await testT8();
  await testT9();
  testT10();
  testT11();

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
