'use strict';

/**
 * test-decisions-canon.js — idempotency + live-audit proof for
 * scripts/sql/decisions-base.sql (cm#224: "init leaves per-project DB
 * without decisions table" canon-class fix).
 *
 * Two scratch-DB cases, both created and dropped by this file, PG-only
 * (skips cleanly when Postgres is unavailable, same pattern as
 * scripts/test-schema-bring-forward.js's isPgAvailable()):
 *
 * T1 — fresh-DB idempotency + live audit proof. On a brand-new scratch DB:
 *   (a) run the REAL ensureSchemaCurrent (scripts/handoff.js's own export,
 *       never a test-side reimplementation) — applies the full postgres
 *       unit set (handoff-core-schema.sql, app-retrieval-events-schema.sql,
 *       decisions-base.sql) in one pass. Asserts applied:true and that
 *       `decisions` + `audit_log` now exist.
 *   (b) apply migrate-14-seam-tables.sql, migrate-15-mcp-addenda.sql,
 *       migrate-13-agent-exchange.sql, and migrate-14-seam-tables-
 *       embeddings.sql RAW via `psql -f` (bypassing their .js runners'
 *       classifyTarget staging-only restriction on purpose — the point is
 *       to prove canon and the staging appliers never diverge, not to
 *       exercise the staging runners' own prerequisite gates). Every
 *       invocation passes `-v ON_ERROR_STOP=1` so a real mid-script error
 *       fails the psql process (nonzero exit) rather than being silently
 *       swallowed by psql's default continue-past-errors behavior — the
 *       spec's "zero errors" bar is enforced by the exit code, not by
 *       eyeballing stdout.
 *   (c) pg_indexes: decisions_project_topic_unique's indexdef is a UNIQUE
 *       index on (project_id, topic).
 *   (d) live INSERT ... ON CONFLICT (project_id, topic) DO UPDATE, twice
 *       (insert then update-by-conflict) — asserts the decisions_audit
 *       trigger actually fired: an audit_log row for the UPDATE exists.
 *
 * T2 — ADVERSARY RESIDUE (a): a staging DB where migrate-14 ran but
 *   migrate-15 never did (arbiter index absent) is a genuinely realizable
 *   degraded state — this reproduces it, then runs the REAL
 *   ensureSchemaCurrent and asserts the arbiter index now exists. Answers
 *   the PR body's residue question directly: this DB state is REPAIRED by
 *   a schema-drift-sentinel touch (handoff:resume/close, or this MCP fix's
 *   own withProjectDb call), not left permanently degraded.
 *
 * T3 — cm#224 follow-up (independent PR #225 review finding): a
 *   pgvector-ABSENT target (core canon applied, no `vector` extension ever
 *   created). Asserts (a) ensureSchemaCurrent reports reason:'degraded'
 *   (not 'current') with the skipped columns listed and
 *   vectorExtensionPresent:false, a project_settings.schema_apply_degraded
 *   row populated with reason 'pgvector_gated_skip', and that a SECOND call
 *   (fingerprint now current) still reports 'degraded' rather than
 *   silently reverting to 'current' forever; (b) memory-upsert.js's
 *   upsertDecisionRow throws the named EmbeddingColumnAbsentError (not a
 *   raw 42703) when an embedding is supplied against the missing column;
 *   (c) `handoff.js status --json`, run as a real subprocess (same
 *   PROJECT_ROOT/HANDOFF_DB pattern scripts/test-schema-bring-forward.js's
 *   T5 uses), surfaces the degraded record.
 *
 * BLIND SPOT (adversary residue (b), documented not proven — cannot be
 * proven differently by a test, only stated): `CREATE INDEX IF NOT EXISTS`
 * never verifies a same-named index's DEFINITION, only its NAME. T1(c)'s
 * pg_indexes assertion proves the index CURRENTLY installed under this name
 * is a correct unique (project_id, topic) index — it does NOT prove no
 * third party could have pre-created a same-named index with a DIFFERENT
 * definition before canon ever touched this DB (canon's IF NOT EXISTS would
 * silently no-op against it, leaving the wrong definition in place
 * undetected by this test, by ensureSchemaCurrent's own post-apply
 * schemaObjectsExist() probe, or by any other automated gate in this repo).
 *
 * Requires Postgres (PGHOST/PGPORT/PGUSER/PGPASSWORD, defaults
 * localhost/5432/postgres/postgres) AND the `psql` CLI on PATH. Exit 0 =
 * all run tests passed (or all skipped due to PG/psql unavailability).
 *
 * Usage: node test/test-decisions-canon.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { createRequire } = require('module');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const handoffModule = require(path.join(PROJECT_ROOT, 'scripts', 'handoff.js'));
const { PostgresAdapter } = require(path.join(PROJECT_ROOT, 'scripts', 'lib', 'db-seam.js'));
const memoryUpsertLib = require(path.join(PROJECT_ROOT, 'scripts', 'lib', 'memory-upsert.js'));
const { encodeCwd } = require(path.join(PROJECT_ROOT, 'scripts', 'lib', 'encoded-cwd.js'));

// test/ has no node_modules of its own (only scripts/ does) — same fix
// test/migrations/test-migrate-14-seam-tables.js and friends already use.
const scriptsRequire = createRequire(path.join(PROJECT_ROOT, 'scripts', 'package.json'));
const { Client } = scriptsRequire('pg');

const PGHOST = process.env.PGHOST || 'localhost';
const PGPORT = parseInt(process.env.PGPORT || '5432', 10);
const PGUSER = process.env.PGUSER || 'postgres';
const PGPASSWORD = process.env.PGPASSWORD || 'postgres';

let passed = 0;
let failed = 0;
const failures = [];
function pass(label) { console.log(`PASS  ${label}`); passed++; }
function fail(label, reason) { console.log(`FAIL  ${label}: ${reason}`); failures.push({ label, reason }); failed++; }
function skip(label, reason) { console.log(`SKIP  ${label} (${reason})`); }
function assertTrue(v, msg) { if (v !== true) throw new Error(msg || `expected true, got ${JSON.stringify(v)}`); }
function assertEqual(a, b, msg) { if (a !== b) throw new Error(msg || `expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); }

async function pgConnect(database) {
  const client = new Client({ host: PGHOST, port: PGPORT, user: PGUSER, password: PGPASSWORD, database });
  client.on('error', () => {}); // swallow dangling-client errors during cleanup races
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

let _psqlAvail = null;
function isPsqlAvailable() {
  if (_psqlAvail !== null) return _psqlAvail;
  const probe = spawnSync('psql', ['--version'], { encoding: 'utf8' });
  _psqlAvail = probe.status === 0;
  if (!_psqlAvail) console.log('[INFO] psql CLI unavailable — raw-apply steps will be SKIPPED.');
  return _psqlAvail;
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

/**
 * Best-effort `CREATE EXTENSION IF NOT EXISTS vector` + `pg_trgm` — never
 * fails the caller. pg_trgm is needed by migrate-15-mcp-addenda.sql's
 * entities_name_trgm_idx (gin_trgm_ops) and handoff-core-schema.sql's own
 * assertions_trgm_text_idx — both already gracefully degrade without it
 * (DO-block for the latter), but migrate-15's raw statement is a PLAIN
 * CREATE INDEX (no DO-block guard, matching its own header's stated
 * assumption that pg_trgm is "already present on the staging target"), so
 * a scratch DB with no pg_trgm would otherwise fail this test's raw-apply
 * step for a reason unrelated to decisions-base.sql.
 */
async function tryCreateOptionalExtensions(db) {
  for (const ext of ['vector', 'pg_trgm']) {
    try {
      await db.query(`CREATE EXTENSION IF NOT EXISTS ${ext}`);
    } catch (_) { /* not installed on this Postgres — graceful-degrade paths cover the rest */ }
  }
}

/** Runs `psql -v ON_ERROR_STOP=1 -f <file>` against dbName. Throws on nonzero exit. */
function psqlApplyRaw(dbName, filePath) {
  const result = spawnSync('psql', [
    '-h', PGHOST, '-p', String(PGPORT), '-U', PGUSER, '-d', dbName,
    '-v', 'ON_ERROR_STOP=1', '-f', filePath,
  ], {
    encoding: 'utf8',
    env: { ...process.env, PGPASSWORD },
  });
  if (result.status !== 0) {
    throw new Error(
      `psql -f ${path.basename(filePath)} against ${dbName} exited ${result.status}\n` +
      `stdout: ${result.stdout}\nstderr: ${result.stderr}`
    );
  }
  return result;
}

// ── T1: fresh-DB idempotency + live audit proof ─────────────────────────────

async function testT1() {
  const label = 'T1: decisions-base.sql canon — fresh apply, raw-migration idempotency, arbiter index shape, live audit trigger proof';
  if (!(await isPgAvailable())) { skip(label, 'Postgres unavailable'); return; }
  if (!isPsqlAvailable()) { skip(label, 'psql CLI unavailable'); return; }

  const dbName = `cm_decisions_canon_test_${Date.now()}`;
  const PID = 'cm-decisions-canon-t1-project';

  try {
    await createThrowawayDb(dbName);

    // Bootstrap with ONLY handoff-core-schema.sql, raw via psql -- this is
    // what an OLDER engine build's `handoff.js init` already produced
    // (project_settings, entities, assertions, embedding_providers, etc.)
    // BEFORE decisions-base.sql ever existed. ensureSchemaCurrent's own
    // fingerprint-comparison SELECT requires project_settings to already
    // exist (it is itself one of core's tables) -- exactly like the real
    // drift-sentinel call sites (cmdLoaderLoad/cmdClose/withProjectDb),
    // which only ever run against an already-`init`-ed project, never a
    // genuinely bare DB (cmdInit bootstraps via applyAdditiveSchema
    // directly, never via ensureSchemaCurrent -- see handoff.js's own
    // cmdInit Step 7). This construction is also the literal defect
    // scenario this fix closes: an existing live project DB, provisioned
    // before this fix shipped, touched by the upgraded engine.
    psqlApplyRaw(dbName, path.join(PROJECT_ROOT, 'scripts', 'sql', 'handoff-core-schema.sql'));

    let db = await pgConnect(dbName);
    await tryCreateOptionalExtensions(db);

    // (a) REAL ensureSchemaCurrent — no schema_fingerprint row exists yet
    // (the raw psql apply above never stamps one), so cmp is 'absent' and
    // the full current postgres unit set applies: handoff-core-schema.sql
    // (already present, idempotent no-op), app-retrieval-events-schema.sql,
    // and decisions-base.sql (both genuinely new here).
    const adapter = new PostgresAdapter(db);
    const result = await handoffModule.ensureSchemaCurrent(adapter, PID, { silent: true });
    assertTrue(result.applied === true, `T1a: ensureSchemaCurrent must report applied:true on a fresh DB, got: ${JSON.stringify(result)}`);
    assertTrue(
      result.detail.appliedUnits.includes('decisions-base.sql'),
      `T1a: decisions-base.sql must be in appliedUnits, got: ${JSON.stringify(result.detail.appliedUnits)}`
    );

    const { rows: tableRows } = await db.query(
      `SELECT table_name FROM information_schema.tables WHERE table_schema=current_schema() AND table_name IN ('decisions','audit_log') ORDER BY table_name`
    );
    assertEqual(tableRows.map((r) => r.table_name).join(','), 'audit_log,decisions', 'T1a: decisions + audit_log both exist after canon apply');

    // (b) raw psql -f apply of the four staging-side source files — proves
    // canon and staging never diverge into "two different definitions of
    // the same object". ON_ERROR_STOP=1 makes a real error a nonzero exit.
    //
    // migrate-06-carryover-status.sql is prepended: migrate-14-seam-
    // tables.sql's own v_handoff_card_inputs view (§5.9) selects
    // assertions.carryover_status, a column migrate-06 adds and canon does
    // NOT carry (out of this fix's scope — carryover_status is unrelated to
    // decisions) — this is a genuine, pre-existing prerequisite of
    // migrate-14-seam-tables.sql's raw SQL on ANY target, not something this
    // fix introduces; omitting it here would fail this test for a reason
    // that has nothing to do with decisions-base.sql.
    const rawFiles = [
      path.join(PROJECT_ROOT, 'scripts', 'migrations', 'sql', 'migrate-06-carryover-status.sql'),
      path.join(PROJECT_ROOT, 'scripts', 'migrations', 'sql', 'migrate-14-seam-tables.sql'),
      path.join(PROJECT_ROOT, 'scripts', 'migrations', 'sql', 'migrate-15-mcp-addenda.sql'),
      path.join(PROJECT_ROOT, 'scripts', 'migrations', 'sql', 'migrate-13-agent-exchange.sql'),
      path.join(PROJECT_ROOT, 'scripts', 'migrations', 'sql', 'migrate-14-seam-tables-embeddings.sql'),
    ];
    for (const f of rawFiles) {
      psqlApplyRaw(dbName, f); // throws (fails the test) on nonzero exit
    }

    // (c) pg_indexes: decisions_project_topic_unique is a genuine UNIQUE
    // index on (project_id, topic) — the exact shape memory-upsert.js's
    // ON CONFLICT (project_id, topic) requires.
    const { rows: idxRows } = await db.query(
      `SELECT indexdef FROM pg_indexes WHERE schemaname=current_schema() AND indexname='decisions_project_topic_unique'`
    );
    assertEqual(idxRows.length, 1, 'T1c: decisions_project_topic_unique exists exactly once');
    const indexdef = idxRows[0].indexdef;
    assertTrue(/CREATE UNIQUE INDEX/i.test(indexdef), `T1c: index must be UNIQUE, got: ${indexdef}`);
    assertTrue(/\(project_id,\s*topic\)/i.test(indexdef), `T1c: index must cover (project_id, topic), got: ${indexdef}`);

    // (d) live INSERT ... ON CONFLICT (project_id, topic) DO UPDATE, twice
    // — proves decisions_audit actually fires on the real conflict-driven
    // UPDATE path memory-upsert.js:upsertDecisionRow uses.
    const ins1 = await db.query(
      `INSERT INTO decisions (project_id, topic, decision, reason)
       VALUES ($1, 'canon-test-topic', 'first decision', 'seed')
       ON CONFLICT (project_id, topic) DO UPDATE SET decision = EXCLUDED.decision
       RETURNING id`,
      [PID]
    );
    const decisionId = ins1.rows[0].id;

    await db.query(
      `INSERT INTO decisions (project_id, topic, decision, reason)
       VALUES ($1, 'canon-test-topic', 'revised decision', 'update-by-conflict')
       ON CONFLICT (project_id, topic) DO UPDATE SET decision = EXCLUDED.decision, reason = EXCLUDED.reason
       RETURNING id`,
      [PID]
    );

    const { rows: auditRows } = await db.query(
      `SELECT operation, row_id FROM audit_log WHERE table_name='decisions' AND operation='UPDATE' AND row_id=$1`,
      [String(decisionId)]
    );
    assertTrue(auditRows.length >= 1, `T1d: decisions_audit must have fired an UPDATE row into audit_log for row_id=${decisionId}, found ${auditRows.length}`);

    await db.end();
    pass(label);
  } catch (err) {
    fail(label, err.message);
  } finally {
    await dropThrowawayDb(dbName);
  }
}

// ── T2: adversary residue (a) — staging DB where migrate-14 ran but ────────
//        migrate-15 never did; does a schema-drift touch repair it? ────────

async function testT2() {
  const label = 'T2: adversary residue (a) — migrate-14-without-migrate-15 degraded staging state is REPAIRED by the real ensureSchemaCurrent';
  if (!(await isPgAvailable())) { skip(label, 'Postgres unavailable'); return; }
  if (!isPsqlAvailable()) { skip(label, 'psql CLI unavailable'); return; }

  const dbName = `cm_decisions_canon_test_staging_repair_${Date.now()}`;
  const PID = 'cm-decisions-canon-t2-project';

  try {
    await createThrowawayDb(dbName);

    // Reproduce the degraded state: core schema (raw, so no fingerprint is
    // ever stamped) + migrate-14-seam-tables.sql (creates `decisions` +
    // `audit_log` etc.) but deliberately NOT migrate-15-mcp-addenda.sql — so
    // decisions_project_topic_unique is genuinely absent, exactly the
    // real-world "migrate-14 ran, migrate-15 never did" state.
    psqlApplyRaw(dbName, path.join(PROJECT_ROOT, 'scripts', 'sql', 'handoff-core-schema.sql'));
    // migrate-14-seam-tables.sql itself expects audit_log to already exist
    // (its own header PREREQUISITE note) — apply migrate-13 first so the raw
    // sequence is physically realizable, exactly as the real staging runner
    // order requires.
    psqlApplyRaw(dbName, path.join(PROJECT_ROOT, 'scripts', 'migrations', 'sql', 'migrate-13-agent-exchange.sql'));
    // migrate-06 first — see T1's comment: migrate-14's v_handoff_card_inputs
    // view needs assertions.carryover_status, a pre-existing prerequisite
    // unrelated to this fix.
    psqlApplyRaw(dbName, path.join(PROJECT_ROOT, 'scripts', 'migrations', 'sql', 'migrate-06-carryover-status.sql'));
    psqlApplyRaw(dbName, path.join(PROJECT_ROOT, 'scripts', 'migrations', 'sql', 'migrate-14-seam-tables.sql'));

    const db = await pgConnect(dbName);
    await tryCreateOptionalExtensions(db);

    const { rows: preRows } = await db.query(
      `SELECT 1 FROM pg_indexes WHERE schemaname=current_schema() AND indexname='decisions_project_topic_unique'`
    );
    assertEqual(preRows.length, 0, 'T2 precondition: arbiter index genuinely absent before any canon touch (migrate-15 never ran)');

    // The repair: a schema-drift-sentinel touch (what handoff:resume/close,
    // and now withProjectDb's own ensureSchemaCurrent call, does on every
    // invocation) — no fingerprint row exists yet on this DB (it was
    // provisioned via raw psql -f, not via ensureSchemaCurrent), so cmp is
    // 'absent' and a full postgres-unit apply runs, including decisions-
    // base.sql's own `CREATE UNIQUE INDEX IF NOT EXISTS
    // decisions_project_topic_unique` statement.
    const adapter = new PostgresAdapter(db);
    const result = await handoffModule.ensureSchemaCurrent(adapter, PID, { silent: true });
    assertTrue(result.applied === true, `T2: repair touch must report applied:true, got: ${JSON.stringify(result)}`);

    const { rows: postRows } = await db.query(
      `SELECT indexdef FROM pg_indexes WHERE schemaname=current_schema() AND indexname='decisions_project_topic_unique'`
    );
    assertEqual(postRows.length, 1, 'T2: arbiter index now present after the repair touch — this class of degraded staging DB is NOT permanently stuck');
    assertTrue(/CREATE UNIQUE INDEX/i.test(postRows[0].indexdef), 'T2: repaired index is UNIQUE');

    await db.end();
    pass(label);
  } catch (err) {
    fail(label, err.message);
  } finally {
    await dropThrowawayDb(dbName);
  }
}

// ── T3: pgvector-absent — loud degradation + named error + handoff_status ──

async function testT3() {
  const label = 'T3: pgvector-absent target — reason:"degraded", named EmbeddingColumnAbsentError, handoff_status surfaces the record';
  if (!(await isPgAvailable())) { skip(label, 'Postgres unavailable'); return; }
  if (!isPsqlAvailable()) { skip(label, 'psql CLI unavailable'); return; }

  const dbName = `cm_decisions_canon_test_pgvabsent_${Date.now()}`;
  const projDir = path.join(os.tmpdir(), `cm-decisions-canon-t3-${Date.now()}`);

  try {
    await createThrowawayDb(dbName);
    // Bootstrap core ONLY, raw via psql, deliberately WITHOUT creating the
    // vector extension — a genuine pgvector-absent target (no
    // tryCreateOptionalExtensions call here, unlike T1/T2).
    psqlApplyRaw(dbName, path.join(PROJECT_ROOT, 'scripts', 'sql', 'handoff-core-schema.sql'));

    const db = await pgConnect(dbName);
    const adapter = new PostgresAdapter(db);

    // Fresh git-initialized scratch project dir — `handoff.js status`'s own
    // resolveProjectId() falls back to encodeCwd(root) when no marker exists
    // (same pattern scripts/test-schema-bring-forward.js's T5 relies on for
    // `handoff.js init`); computing the SAME value here lets this test seed
    // rows under the exact project_id the T3c subprocess will independently
    // derive.
    fs.mkdirSync(projDir, { recursive: true });
    const gitInit = spawnSync('git', ['-C', projDir, 'init', '-q'], { encoding: 'utf8' });
    if (gitInit.status !== 0) throw new Error(`T3: git init failed: ${gitInit.stderr}`);
    const PID = encodeCwd(projDir);

    // (a) real ensureSchemaCurrent against the pgvector-absent target.
    const result = await handoffModule.ensureSchemaCurrent(adapter, PID, { silent: true });
    assertEqual(result.reason, 'degraded', `T3a: reason must be 'degraded' on a pgvector-absent target, got: ${JSON.stringify(result)}`);
    assertTrue(Array.isArray(result.detail.missing) && result.detail.missing.length > 0, 'T3a: detail.missing lists the skipped gated columns');
    assertTrue(result.detail.missing.some((m) => m.table === 'decisions' && m.column === 'embedding'), 'T3a: decisions.embedding is in the missing list');
    assertTrue(result.detail.missing.some((m) => m.table === 'assertions' && m.column === 'embedding'), 'T3a: assertions.embedding is ALSO in the missing list (general mechanism, not decisions-only)');
    assertEqual(result.detail.vectorExtensionPresent, false, 'T3a: vectorExtensionPresent correctly false');

    const { rows: degRows } = await db.query(
      `SELECT value FROM project_settings WHERE project_id=$1 AND key='schema_apply_degraded'`, [PID]
    );
    assertEqual(degRows.length, 1, 'T3a: schema_apply_degraded row populated');
    const degParsed = JSON.parse(degRows[0].value);
    assertEqual(degParsed.reason, 'pgvector_gated_skip', 'T3a: degradation reason is pgvector_gated_skip');

    // Re-run — the fingerprint is now 'current', but this must STILL report
    // degraded, never silently revert to 'current' forever (the finding's
    // core complaint).
    const result2 = await handoffModule.ensureSchemaCurrent(adapter, PID, { silent: true });
    assertEqual(result2.reason, 'degraded', 'T3a: second call (fingerprint now current) still reports degraded');
    assertEqual(result2.applied, false, 'T3a: second call is a DDL no-op (applied:false) but still reports degraded');

    // (b) a real embedding write against the missing column throws the
    // NAMED error, never a raw 42703.
    let namedErr = null;
    try {
      await memoryUpsertLib.upsertDecisionRow(db, {
        project_id: PID, topic: 't3-topic', decision: 't3 decision', reason: 'probe',
      }, { embeddingVectorLiteral: '[0.1,0.2,0.3]', embeddedByProviderId: 1 });
    } catch (err) {
      namedErr = err;
    }
    assertTrue(namedErr !== null, 'T3b: upsertDecisionRow must throw when an embedding is supplied and the column is absent');
    assertEqual(namedErr.name, 'EmbeddingColumnAbsentError', 'T3b: error is the named EmbeddingColumnAbsentError, not a raw pg DatabaseError');
    assertEqual(namedErr.code, 'embeddingColumnAbsent', 'T3b: error code is embeddingColumnAbsent');
    assertTrue(/pgvector is not installed/.test(namedErr.message), 'T3b: message names pgvector as the cause');
    assertTrue(/schema_apply_degraded/.test(namedErr.message), 'T3b: message points at schema_apply_degraded for the full record');

    await db.end();

    // (c) `handoff.js status --json`, a real subprocess, surfaces the
    // degraded record. Stdout carries a "Running: ..." preamble line and a
    // trailing "Done: ..." summary line around the pretty-printed JSON
    // block — extract just the JSON object.
    const statusResult = spawnSync(
      process.execPath,
      [path.join(PROJECT_ROOT, 'scripts', 'handoff.js'), 'status', '--json'],
      { cwd: projDir, encoding: 'utf8', timeout: 30000, env: { ...process.env, HANDOFF_DB: dbName, PROJECT_ROOT: projDir } }
    );
    assertEqual(statusResult.status, 0, `T3c: handoff.js status --json must exit 0, got ${statusResult.status}. stdout:\n${statusResult.stdout}\nstderr:\n${statusResult.stderr}`);
    const doneIdx = statusResult.stdout.indexOf('\nDone:');
    const jsonBlockText = doneIdx >= 0 ? statusResult.stdout.slice(0, doneIdx) : statusResult.stdout;
    const firstBrace = jsonBlockText.indexOf('{');
    const statusJson = JSON.parse(jsonBlockText.slice(firstBrace));
    assertTrue(!!statusJson.schema_apply_degraded, 'T3c: handoff_status JSON output includes a schema_apply_degraded record');
    assertEqual(statusJson.schema_apply_degraded.reason, 'pgvector_gated_skip', 'T3c: surfaced record has the right reason');

    pass(label);
  } catch (err) {
    fail(label, err.message);
  } finally {
    await dropThrowawayDb(dbName);
    try { fs.rmSync(projDir, { recursive: true, force: true }); } catch (_) { /* best-effort */ }
  }
}

// ── Main ──────────────────────────────────────────────────────────────────

async function main() {
  console.log('=== test-decisions-canon.js (cm#224 decisions-base.sql canon proof) ===');
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
