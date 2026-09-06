'use strict';

/**
 * test-migrate-01.js — Test harness for scripts/migrations/migrate-01-canonical-db.js.
 *
 * Requires Postgres at PGHOST/PGUSER/PGPASSWORD (CI env) or localhost/postgres,
 * with the pgvector extension available on the server (pgvector/pgvector:pg16
 * image in CI, matching test.yml's other Postgres-dependent steps).
 *
 * Self-contained: creates its own scratch databases (all named to satisfy the
 * script's own target classification — see classifyTarget in the script under
 * test — so no --allow-existing bypass or classifier weakening is needed) and
 * drops them all in an unconditional finally block. Never touches
 * claude_memory_eval_test beyond the refusal-branch assertion (T5), which
 * exits before any database connection is opened. Never creates
 * memory_manager_staging (the script's built-in default) — the default-
 * resolution path is exercised as a pure unit test against the exported
 * resolveTargetDb(), not by invoking the CLI with no --db.
 *
 * Usage: node test/migrations/test-migrate-01.js
 * Exit 0 = all pass; nonzero = any failure.
 */

const { spawnSync } = require('child_process');
const path  = require('path');
const { createRequire } = require('module');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const SCRIPT_PATH   = path.join(PROJECT_ROOT, 'scripts', 'migrations', 'migrate-01-canonical-db.js');
const migrateModule = require(SCRIPT_PATH);
const handoffModule = require(path.join(PROJECT_ROOT, 'scripts', 'handoff.js'));

// scripts/ has its own node_modules (pg, etc.) — this test lives under test/,
// outside that tree, so resolve 'pg' the same way test/handoff/test-resurrect-
// semantic.js does: via a require() rooted at scripts/package.json.
const scriptsRequire = createRequire(require.resolve('../../scripts/package.json'));
const { Client } = scriptsRequire('pg');

const TS = Date.now();

// ── Tracking ────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function pass(id, label) {
  console.log(`[${id}] ${label} ... PASS`);
  passed++;
}

function fail(id, label, reason) {
  console.log(`[${id}] ${label} ... FAIL: ${reason}`);
  failed++;
}

// ── PG helpers ────────────────────────────────────────────────────────────────

function pgConfig(database) {
  return {
    host:     process.env.PGHOST     || 'localhost',
    port:     parseInt(process.env.PGPORT || '5432', 10),
    user:     process.env.PGUSER     || 'postgres',
    password: process.env.PGPASSWORD || 'postgres',
    database,
  };
}

async function pgConnect(database = 'postgres') {
  const client = new Client(pgConfig(database));
  await client.connect();
  return client;
}

async function dropDb(dbName) {
  let sys;
  try {
    sys = await pgConnect('postgres');
    await sys.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
      [dbName]
    );
    await sys.query(`DROP DATABASE IF EXISTS "${dbName}"`);
  } catch (_) {
    // best-effort cleanup
  } finally {
    if (sys) { try { await sys.end(); } catch (_) {} }
  }
}

/** Run the migration script as a subprocess. Returns spawnSync result. */
function runMigrate(args, extraEnv = {}, timeoutMs = 20000) {
  return spawnSync(process.execPath, [SCRIPT_PATH, ...args], {
    cwd: PROJECT_ROOT,
    env: { ...process.env, ...extraEnv },
    encoding: 'utf8',
    timeout: timeoutMs,
  });
}

// Scratch DB names — all satisfy classifyTarget's allowed pattern (end in
// "_staging") so the script itself accepts them as legitimate targets.
const DB1 = `migrate01_test1_${TS}_staging`;
const DB2 = `migrate01_test2_${TS}_staging`;
const DB3 = `migrate01_test3_${TS}_staging`;
const DB_RACE = `migrate01_race_${TS}_staging`;
// Deliberately does NOT end in "_staging" and is not memory_manager — this is
// what makes it a PER_PROJECT_ENGINE candidate the marker probe must decide
// on, not a name matched by any name-only branch.
const DB_ENGINE = `migrate01_engine_${TS}`;
const CREATED_DBS = [DB1, DB2, DB3, DB_RACE, DB_ENGINE];

// Two distinct, well-formed v4 UUIDs used across the marker-probe tests.
const PROJECT_UUID_A = 'ef808da0-f490-473d-9f08-28b6c8297e85';
const PROJECT_UUID_B = '32a4775d-1234-4abc-8def-1234567890ab';

// ── Test sections ─────────────────────────────────────────────────────────────

async function testFreshApply() {
  const r = runMigrate(['--db', DB1]);
  if (r.status === 0 && /MIGRATION_RESULT: PASS/.test(r.stdout)) {
    pass('T1', 'fresh apply against empty scratch DB → PASS');
  } else {
    fail('T1', 'fresh apply against empty scratch DB → PASS', `status=${r.status} stdout=${r.stdout} stderr=${r.stderr}`);
  }
}

async function testRefusedWithoutAllowExisting() {
  const r = runMigrate(['--db', DB1]);
  if (r.status === 1 && /already contains/.test(r.stderr) && /--allow-existing/.test(r.stderr)) {
    pass('T2', 're-run against non-empty target without --allow-existing → refused');
  } else {
    fail('T2', 're-run against non-empty target without --allow-existing → refused', `status=${r.status} stderr=${r.stderr}`);
  }
}

async function testIdempotentSecondRun() {
  const r = runMigrate(['--db', DB1, '--allow-existing']);
  const zeroNetChange = /missing: \(none\)/.test(r.stdout) &&
    /extra \(later-phase or unknown\): \(none\)/.test(r.stdout);
  if (r.status === 0 && /MIGRATION_RESULT: PASS/.test(r.stdout) && zeroNetChange) {
    pass('T3', 'idempotent second run with --allow-existing → PASS, zero net change');
  } else {
    fail('T3', 'idempotent second run with --allow-existing → PASS, zero net change', `status=${r.status} stdout=${r.stdout}`);
  }
}

async function testProofOfFiringMissingTable() {
  const client = await pgConnect(DB1);
  try {
    await client.query('DROP TABLE IF EXISTS edges CASCADE');
    const result = await migrateModule.verifyTarget(client, migrateModule.SCHEMA_FILES);
    if (result.pass === false && result.missingTables.includes('edges')) {
      pass('T4', 'proof-of-firing: verifyTarget FAILS and names the missing table when one is dropped');
    } else {
      fail('T4', 'proof-of-firing: verifyTarget FAILS and names the missing table when one is dropped',
        `pass=${result.pass} missingTables=${JSON.stringify(result.missingTables)}`);
    }
    // Heal the DB back for any later reuse (defensive; DB1 is not reused after this point).
    await migrateModule.applySqlFile(client, migrateModule.SCHEMA_FILES[0]);
  } finally {
    await client.end();
  }
}

async function testRefusalWithoutConnecting() {
  // PGHOST points at an RFC 5737 TEST-NET-1 address — guaranteed unroutable.
  // If the refusal branch did not fire BEFORE opening a connection, the
  // process would hang on TCP connect until the OS-level timeout (tens of
  // seconds), which the subprocess timeout below (5s) would catch as a
  // distinct failure (spawnSync returns status=null on timeout-kill).
  const r = runMigrate(['--db', 'claude_memory_eval_test'], { PGHOST: '192.0.2.1' }, 5000);
  const noHang = r.status !== null && r.signal === null;
  const refused = r.status === 1 && /claude_memory_eval_test/.test(r.stderr) && /no database connection was opened/.test(r.stderr);
  if (noHang && refused) {
    pass('T5', 'refusal branch (--db claude_memory_eval_test) fires before any connection is opened');
  } else {
    fail('T5', 'refusal branch (--db claude_memory_eval_test) fires before any connection is opened',
      `status=${r.status} signal=${r.signal} stderr=${r.stderr}`);
  }
}

async function testRefusedPipelinePrefix() {
  const r = runMigrate(['--db', 'pipeline_something']);
  if (r.status === 1 && /pipeline_/.test(r.stderr)) {
    pass('T6', 'refuses names matching /^pipeline_/');
  } else {
    fail('T6', 'refuses names matching /^pipeline_/', `status=${r.status} stderr=${r.stderr}`);
  }
}

async function testRefusedPolicyFramework() {
  const r = runMigrate(['--db', 'claude_policy_framework']);
  if (r.status === 1 && /claude_policy_framework/.test(r.stderr)) {
    pass('T7', 'refuses claude_policy_framework');
  } else {
    fail('T7', 'refuses claude_policy_framework', `status=${r.status} stderr=${r.stderr}`);
  }
}

async function testDefaultBranchRefusesUnknownName() {
  // Total-classification proof: a name that is NOT one of the three
  // historical named refusals and NOT CANON/STAGING must still be refused —
  // the default is refuse, not a silent proceed. Since migration-target-
  // per-project-marker (cm owner decision item G, 2026-09-06), a name like
  // this is no longer refused by a static "not recognized" message: it now
  // goes through the marker probe, and without --project-id the probe's own
  // precondition failure is the (more actionable) reason surfaced.
  const r = runMigrate(['--db', `migrate01_unrecognized_${TS}_scratch`]);
  const refused = r.status === 1 && /no --project-id supplied; per-project engine targets require it/.test(r.stderr);
  const noConnection = /no database connection was opened/.test(r.stderr);
  if (refused && noConnection) {
    pass('T8', 'default branch of target classification refuses an unlisted/unrecognized name (no --project-id)');
  } else {
    fail('T8', 'default branch of target classification refuses an unlisted/unrecognized name (no --project-id)', `status=${r.status} stderr=${r.stderr}`);
  }
}

async function testUnrecognizedNameBadUuidRejected() {
  // Same unrecognized name, but WITH a malformed --project-id: the probe's
  // UUID-shape check fires (still before any connection is opened) instead
  // of the "absent" precondition.
  const r = runMigrate(['--db', `migrate01_unrecognized_${TS}_scratch`, '--project-id', 'not-a-uuid']);
  const refused = r.status === 1 && /project-id is not a UUID/.test(r.stderr);
  const noConnection = /no database connection was opened/.test(r.stderr);
  if (refused && noConnection) {
    pass('T8b', 'malformed --project-id is refused before any connection is opened');
  } else {
    fail('T8b', 'malformed --project-id is refused before any connection is opened', `status=${r.status} stderr=${r.stderr}`);
  }
}

async function testStagingPrecedenceOverProbe() {
  // Precedence proof: a *_staging name is classified STAGING purely by
  // name — the marker probe must never even run for it, regardless of
  // --project-id. Proven behaviorally (not just by absence of a query) by
  // injecting a `connect` that throws if it is ever invoked.
  const connectShouldNotBeCalled = async () => {
    throw new Error('probe connect() must not be called for a *_staging name');
  };
  const result = await migrateModule.classifyTarget({
    dbName: DB1,
    projectId: 'not-a-uuid-but-irrelevant',
    connect: connectShouldNotBeCalled,
  });
  if (result.branch === 'STAGING' && result.allowed === true && result.connectionOpened === false) {
    pass('T14', '*_staging name classifies STAGING without ever running the marker probe');
  } else {
    fail('T14', '*_staging name classifies STAGING without ever running the marker probe', JSON.stringify(result));
  }
}

async function testProbeConnectionRefused() {
  // Connection-refused path, mocked via an injected connect() — never a
  // thrown exception out of classifyTarget.
  const result = await migrateModule.classifyTarget({
    dbName: DB_ENGINE,
    projectId: PROJECT_UUID_A,
    connect: async () => { throw new Error('connect ECONNREFUSED 192.0.2.1:5432'); },
  });
  if (result.branch === 'SOURCE_ONLY' && result.allowed === false &&
      /^cannot connect: /.test(result.reason) && result.connectionOpened === false) {
    pass('T15', 'connection-refused probe outcome is SOURCE_ONLY, never a thrown exception');
  } else {
    fail('T15', 'connection-refused probe outcome is SOURCE_ONLY, never a thrown exception', JSON.stringify(result));
  }
}

async function testProbeLiveBranches() {
  // Exercises every live (real-connection) marker-probe SOURCE_ONLY reason
  // plus the PER_PROJECT_ENGINE pass, against ONE scratch engine DB whose
  // state is mutated step by step — mirroring T1-T4's mutate-in-place style
  // against DB1. DB_ENGINE deliberately does not end in "_staging".
  const sys = await pgConnect('postgres');
  try {
    await sys.query(`CREATE DATABASE "${DB_ENGINE}"`);
  } finally {
    await sys.end();
  }

  const client = await pgConnect(DB_ENGINE);
  try {
    // (a) project_settings absent entirely.
    let result = await migrateModule.classifyTarget({ dbName: DB_ENGINE, projectId: PROJECT_UUID_A });
    if (result.branch === 'SOURCE_ONLY' && result.reason === 'no engine schema (project_settings absent)' && result.connectionOpened) {
      pass('T16', 'probe: project_settings absent -> SOURCE_ONLY');
    } else {
      fail('T16', 'probe: project_settings absent -> SOURCE_ONLY', JSON.stringify(result));
    }

    await client.query(`
      CREATE TABLE project_settings (
        project_id TEXT NOT NULL,
        key        TEXT NOT NULL,
        value      TEXT NOT NULL,
        PRIMARY KEY (project_id, key)
      )
    `);

    // (b) table present, zero rows.
    result = await migrateModule.classifyTarget({ dbName: DB_ENGINE, projectId: PROJECT_UUID_A });
    if (result.branch === 'SOURCE_ONLY' && result.reason === 'no project rows' && result.connectionOpened) {
      pass('T17', 'probe: zero project_settings rows -> SOURCE_ONLY');
    } else {
      fail('T17', 'probe: zero project_settings rows -> SOURCE_ONLY', JSON.stringify(result));
    }

    // (c) two distinct project_ids present -> ambiguous, refused.
    await client.query(`INSERT INTO project_settings (project_id, key, value) VALUES ($1, 'x', '1'), ($2, 'x', '1')`, [PROJECT_UUID_A, PROJECT_UUID_B]);
    result = await migrateModule.classifyTarget({ dbName: DB_ENGINE, projectId: PROJECT_UUID_A });
    if (result.branch === 'SOURCE_ONLY' && result.reason === 'multiple project_ids present: refusing ambiguous target' && result.connectionOpened) {
      pass('T18', 'probe: 2 distinct project_ids -> SOURCE_ONLY ambiguous refusal');
    } else {
      fail('T18', 'probe: 2 distinct project_ids -> SOURCE_ONLY ambiguous refusal', JSON.stringify(result));
    }
    await client.query(`DELETE FROM project_settings WHERE key = 'x'`);

    // (d) single row, but its project_id does NOT match --project-id.
    await client.query(`INSERT INTO project_settings (project_id, key, value) VALUES ($1, 'seed', '1')`, [PROJECT_UUID_B]);
    result = await migrateModule.classifyTarget({ dbName: DB_ENGINE, projectId: PROJECT_UUID_A });
    if (result.branch === 'SOURCE_ONLY' && result.reason === `marker mismatch: db has ${PROJECT_UUID_B}` && result.connectionOpened) {
      pass('T19', 'probe: marker mismatch -> SOURCE_ONLY');
    } else {
      fail('T19', 'probe: marker mismatch -> SOURCE_ONLY', JSON.stringify(result));
    }
    await client.query(`DELETE FROM project_settings WHERE key = 'seed'`);

    // (e) matching project_id, but no schema_fingerprint row yet.
    await client.query(`INSERT INTO project_settings (project_id, key, value) VALUES ($1, 'seed', '1')`, [PROJECT_UUID_A]);
    result = await migrateModule.classifyTarget({ dbName: DB_ENGINE, projectId: PROJECT_UUID_A });
    if (result.branch === 'SOURCE_ONLY' && result.reason === 'schema_fingerprint absent' && result.connectionOpened) {
      pass('T20', 'probe: schema_fingerprint absent -> SOURCE_ONLY');
    } else {
      fail('T20', 'probe: schema_fingerprint absent -> SOURCE_ONLY', JSON.stringify(result));
    }

    // (f) fingerprint present but epoch BEHIND current SCHEMA_EPOCH.
    const hash = 'a'.repeat(64);
    await client.query(
      `INSERT INTO project_settings (project_id, key, value) VALUES ($1, 'schema_fingerprint', $2)`,
      [PROJECT_UUID_A, `1:${hash}`]
    );
    result = await migrateModule.classifyTarget({ dbName: DB_ENGINE, projectId: PROJECT_UUID_A });
    if (result.branch === 'SOURCE_ONLY' && /^schema epoch 1 behind \d+; run the engine once against this project first$/.test(result.reason) && result.connectionOpened) {
      pass('T21', 'probe: schema epoch behind -> SOURCE_ONLY');
    } else {
      fail('T21', 'probe: schema epoch behind -> SOURCE_ONLY', JSON.stringify(result));
    }

    // (g) fingerprint epoch AHEAD of current SCHEMA_EPOCH.
    await client.query(
      `UPDATE project_settings SET value = $1 WHERE project_id = $2 AND key = 'schema_fingerprint'`,
      [`99999:${hash}`, PROJECT_UUID_A]
    );
    result = await migrateModule.classifyTarget({ dbName: DB_ENGINE, projectId: PROJECT_UUID_A });
    if (result.branch === 'SOURCE_ONLY' && /^schema epoch ahead of this code/.test(result.reason) && result.connectionOpened) {
      pass('T22', 'probe: schema epoch ahead -> SOURCE_ONLY');
    } else {
      fail('T22', 'probe: schema epoch ahead -> SOURCE_ONLY', JSON.stringify(result));
    }

    // (h) fingerprint at the CURRENT epoch -> PER_PROJECT_ENGINE, allowed.
    await client.query(
      `UPDATE project_settings SET value = $1 WHERE project_id = $2 AND key = 'schema_fingerprint'`,
      [`${handoffModule.SCHEMA_EPOCH}:${hash}`, PROJECT_UUID_A]
    );
    result = await migrateModule.classifyTarget({ dbName: DB_ENGINE, projectId: PROJECT_UUID_A });
    if (result.branch === 'PER_PROJECT_ENGINE' && result.allowed === true && result.projectId === PROJECT_UUID_A) {
      pass('T23', 'probe: current schema epoch + matching marker -> PER_PROJECT_ENGINE, allowed');
    } else {
      fail('T23', 'probe: current schema epoch + matching marker -> PER_PROJECT_ENGINE, allowed', JSON.stringify(result));
    }

    // (i) braces + uppercase --project-id normalizes to the same match.
    result = await migrateModule.classifyTarget({
      dbName: DB_ENGINE,
      projectId: `{${PROJECT_UUID_A.toUpperCase()}}`,
    });
    if (result.branch === 'PER_PROJECT_ENGINE' && result.allowed === true) {
      pass('T24', 'probe: braces + uppercase --project-id normalizes and still passes');
    } else {
      fail('T24', 'probe: braces + uppercase --project-id normalizes and still passes', JSON.stringify(result));
    }
  } finally {
    await client.end();
  }
}

async function testInvalidIdentifierRejected() {
  const r = runMigrate(['--db', 'bad-name!']);
  if (r.status === 1 && /Invalid database name/.test(r.stderr)) {
    pass('T9', 'invalid identifier (regex mismatch) is rejected');
  } else {
    fail('T9', 'invalid identifier (regex mismatch) is rejected', `status=${r.status} stderr=${r.stderr}`);
  }
}

async function testHandoffDbIgnored() {
  // If the script incorrectly read HANDOFF_DB, it would target
  // claude_memory_eval_test instead of DB2 and hit the refusal branch
  // (exit 1) instead of succeeding — a behavioral proof, not just a log
  // inspection.
  const r = runMigrate(['--db', DB2], { HANDOFF_DB: 'claude_memory_eval_test' });
  if (r.status === 0 && r.stdout.includes(`target="${DB2}"`) && /resolved from --db flag/.test(r.stdout)) {
    pass('T10', 'HANDOFF_DB env var is ignored — --db flag target is used instead');
  } else {
    fail('T10', 'HANDOFF_DB env var is ignored — --db flag target is used instead', `status=${r.status} stdout=${r.stdout} stderr=${r.stderr}`);
  }
}

async function testMigrateTargetDbEnvResolution() {
  const r = runMigrate([], { MIGRATE_TARGET_DB: DB3 });
  if (r.status === 0 && r.stdout.includes(`target="${DB3}"`) && /resolved from MIGRATE_TARGET_DB env var/.test(r.stdout)) {
    pass('T11', 'MIGRATE_TARGET_DB env var resolves the target when --db is absent');
  } else {
    fail('T11', 'MIGRATE_TARGET_DB env var resolves the target when --db is absent', `status=${r.status} stdout=${r.stdout} stderr=${r.stderr}`);
  }
}

async function testDefaultTargetIsBuiltIn() {
  // Pure unit test against the exported resolver — deliberately NEVER invokes
  // the CLI with no --db, which would attempt to create the real
  // memory_manager_staging database.
  const saved = process.env.MIGRATE_TARGET_DB;
  delete process.env.MIGRATE_TARGET_DB;
  const result = migrateModule.resolveTargetDb({ db: null });
  if (saved !== undefined) process.env.MIGRATE_TARGET_DB = saved;
  if (result.name === 'memory_manager_staging' && result.source === 'built-in default') {
    pass('T12', 'default target resolves to memory_manager_staging (unit test, no DB created)');
  } else {
    fail('T12', 'default target resolves to memory_manager_staging (unit test, no DB created)', JSON.stringify(result));
  }
}

async function testCreateDatabaseRaceHandled() {
  // Targets ONLY the ensureDatabaseCreated() step's race-safety (D-5), not
  // full-script concurrency — the schema-apply phase is explicitly NOT
  // claimed to be concurrency-safe (see the CONCURRENCY SCOPE section of the
  // script's header comment; this was discovered empirically while
  // developing this test: racing two full CLI invocations against the same
  // target reliably collided on catalog constraints during schema apply,
  // which is out of D-5's stated scope). Two separate maintenance
  // connections race the exact check-then-create sequence for the same
  // not-yet-existing name. On this codebase's Postgres version this
  // reliably (not merely occasionally) surfaces as a 23505 unique_violation
  // on pg_database_datname_index for the loser, not the more commonly
  // assumed 42P04 — both must be handled, and this test would fail loudly
  // if either stopped being caught.
  const sys1 = await pgConnect('postgres');
  const sys2 = await pgConnect('postgres');
  try {
    const [s1, s2] = await Promise.all([
      migrateModule.ensureDatabaseCreated(sys1, DB_RACE),
      migrateModule.ensureDatabaseCreated(sys2, DB_RACE),
    ]);
    const oneCreatedOneNot = [s1, s2].filter((s) => s === 'created').length >= 1;
    const bothValid = [s1, s2].every((s) => ['created', 'existed', 'existed (race-handled)'].includes(s));
    if (bothValid && oneCreatedOneNot) {
      pass('T13', 'ensureDatabaseCreated is race-safe under real concurrency (neither call throws)');
    } else {
      fail('T13', 'ensureDatabaseCreated is race-safe under real concurrency (neither call throws)', `s1=${s1} s2=${s2}`);
    }
  } catch (err) {
    fail('T13', 'ensureDatabaseCreated is race-safe under real concurrency (neither call throws)', err.message);
  } finally {
    await sys1.end();
    await sys2.end();
  }
}

// ── Main ───────────────────────────────────────────────────────────────────────

async function main() {
  try {
    await testFreshApply();
    await testRefusedWithoutAllowExisting();
    await testIdempotentSecondRun();
    await testProofOfFiringMissingTable();
    await testRefusalWithoutConnecting();
    await testRefusedPipelinePrefix();
    await testRefusedPolicyFramework();
    await testDefaultBranchRefusesUnknownName();
    await testUnrecognizedNameBadUuidRejected();
    await testStagingPrecedenceOverProbe();
    await testProbeConnectionRefused();
    await testProbeLiveBranches();
    await testInvalidIdentifierRejected();
    await testHandoffDbIgnored();
    await testMigrateTargetDbEnvResolution();
    await testDefaultTargetIsBuiltIn();
    await testCreateDatabaseRaceHandled();
  } finally {
    for (const db of CREATED_DBS) {
      await dropDb(db);
    }
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exitCode = 1;
});
