'use strict';

/**
 * test-schema-heal.js — cm#185-schema-heal: total classification on the
 * fingerprint fast path (S1-S5), plus one regression test per accepted
 * adversary finding (see the schema-heal-adversary.md pass this PR
 * implements in full — BLOCKERs and MAJOR/MINOR alike).
 *
 * PROBLEM this closes: ensureSchemaCurrentCore's cmp==='current' fast path
 * only ever checked the pgvector-GATED objects, never the full ungated
 * expected_objects set — a DB fingerprinted current before a schema file
 * gained a column stayed short of it forever. cmdInit never wrote
 * schema_fingerprint at all, so every fresh/re-init immediately looked
 * BEHIND on its very first subsequent touch. `status` and
 * backfill-embeddings classified columns without ever healing first.
 *
 * Coverage map (spec S1-S5 + adversary findings #1-#10):
 *   T1  S1(a)  — stale degraded row + everything actually fine -> HEALED, cleared.
 *   T2  S1(b)  — ungated column dropped by hand heals on `status` (S3 wiring).
 *   T3  S1(c)  — extension absent -> stays degraded, RE-STAMPED with the
 *                current probe (S4) on every subsequent touch.
 *   T4  S1(d)  — extension installed after the fact -> next touch applies
 *                the gated DDL and clears the degraded row.
 *   T5  finding #3  — concurrent (d)-state touches take the SAME lock:
 *                exactly one applies, the other is a clean no-op.
 *   T6  finding #5  — opted-out project + extension present + gated
 *                missing -> stays degraded, NEVER auto-applies.
 *   T7  finding #1  — manifest/DDL desync -> classification_error, never
 *                the apply-retry branch (isolated fixture, no DB).
 *   T8  S2     — fresh `init` records schema_fingerprint (previously never
 *                written at all).
 *   T9  S2/finding #4 — `init` against a genuinely-broken gated DDL still
 *                FATALs (exit 1) exactly as before, while ALSO recording
 *                schema_fingerprint (the two policies are independent).
 *   T10 S2     — re-`init` after pgvector is installed clears a stale
 *                degraded row left by an earlier touch.
 *   T11 finding #6  — a hand-created wrong-shape gated column (vector(1024)
 *                instead of halfvec(4000)) is never reported HEALED.
 *   T12 finding #7  — the schema-apply lifecycle pins search_path to the
 *                canonical 'public' schema.
 *   T13 finding #9  — a manifest-only edit (zero SQL byte change) still
 *                changes the fingerprint (forces exactly one re-apply, not
 *                a silent status flip with no explanation).
 *   T14 finding #8  — white-box: cmdInit and ensureSchemaCurrentCore call
 *                the SAME shared recordSchemaFingerprint export.
 *   T15 S1 "any other" — a probe FAILURE (not a real missing-object list)
 *                BLOCKs, it never flows into the apply-retry branch.
 *   T16 S5     — SQLite seam: the fast path's new ungated probe is
 *                dialect-agnostic and does not regress the SQLite adapter.
 *   T17 review round 3 — classifySchemaFiles() memoizes per engineRoot (a
 *                second call in the same process does ZERO additional file
 *                reads and returns the SAME result object); touching a
 *                schema file's mtime invalidates the cache on the very
 *                next call (no DB — pure fixture, like T7).
 *
 * Requires live Postgres (PGHOST/PGUSER/PGPASSWORD, defaults
 * localhost/postgres/postgres) for T1-T6, T8-T13, T15. T7, T14, and T17 are
 * pure (no DB). T16 uses node:sqlite in-process. Every fixture is its own
 * throwaway DB/dir; none touch claude_memory_eval_test, pipeline_pwa_etl,
 * or any other shared/live database. Exit 0 = all run tests passed.
 */

const fs   = require('fs');
const os   = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const PROJECT_ROOT   = path.resolve(__dirname, '..');
const HANDOFF_SCRIPT = path.join(PROJECT_ROOT, 'scripts', 'handoff.js');

const handoffModule = require(path.join(PROJECT_ROOT, 'scripts', 'handoff.js'));
const { PostgresAdapter, SQLiteAdapter } = require(path.join(PROJECT_ROOT, 'scripts', 'lib', 'db-seam.js'));
const { classifySchemaFiles, _clearClassifyCache } = require(path.join(PROJECT_ROOT, 'scripts', 'lib', 'schema-classify.js'));
const { copySchemaUnits } = require(path.join(__dirname, 'lib', 'scratch-engine-root.js'));
// cm#185 review: 'pg' is a dependency of scripts/ (scripts/node_modules),
// not of the repo root or test/ — requiring it from a lib file that already
// lives under scripts/ (test-pg-helpers.js) resolves correctly regardless
// of which directory this test file itself is run from; a direct
// `require('pg')` from test/ would NOT (same reason test-decisions-canon.js
// and test-index-cap-md5.js never require('pg') directly either).
const { pgConnect: _sharedPgConnect, startFakeEmbedServerProcess } = require(path.join(PROJECT_ROOT, 'scripts', 'lib', 'test-pg-helpers.js'));
const { LOCAL_PROVIDER_NATIVE_DIMS } = require(path.join(PROJECT_ROOT, 'scripts', 'lib', 'embedding-provider.js'));

let passed = 0;
let failed = 0;
let skipped = 0;
const failures = [];
function pass(label) { console.log(`PASS  ${label}`); passed++; }
function fail(label, reason) { console.log(`FAIL  ${label}: ${reason}`); failures.push({ label, reason }); failed++; }
function skip(label, reason) { console.log(`SKIP  ${label} (${reason})`); skipped++; }
function assertTrue(v, msg) { if (v !== true) throw new Error(msg || `expected true, got ${JSON.stringify(v)}`); }
function assertFalse(v, msg) { if (v !== false) throw new Error(msg || `expected false, got ${JSON.stringify(v)}`); }
function assertEqual(a, b, msg) { if (a !== b) throw new Error(msg || `expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); }

// ── DB helpers (raw — full control over WHEN the extension is installed) ────

async function pgConnect(database) {
  const client = await _sharedPgConnect(database);
  client.on('error', () => {}); // swallow dangling-client errors during teardown races
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

/**
 * Bootstrap a fully-provisioned, freshly-fingerprinted "clean current" DB:
 * optionally installs pgvector, applies the full active-dialect unit set via
 * the REAL engine (applyAdditiveSchema), then runs ensureSchemaCurrentCore
 * ONCE to stamp schema_fingerprint (+ a degraded row, if the extension is
 * absent) — mirroring the exact state a real project reaches after
 * `handoff.js init`. Returns { adapter, boot, classification, units }.
 */
async function bootstrapCurrentDb(client, projectId, { withExtension }) {
  if (withExtension) {
    try { await client.query('CREATE EXTENSION IF NOT EXISTS vector'); } catch (_) { /* see isPgvectorAvailable below */ }
  }
  const adapter = new PostgresAdapter(client);
  const classification = classifySchemaFiles({ engineRoot: PROJECT_ROOT });
  assertTrue(classification.ok, `bootstrap: classification must be clean — ${JSON.stringify(classification.errors)}`);
  const units = classification.unitsByDialect.postgres;
  const applyResult = await handoffModule.applyAdditiveSchema(adapter, units, { silent: true });
  assertTrue(applyResult.ok, `bootstrap: applyAdditiveSchema must succeed — ${applyResult.errorMsg}`);
  const boot = await handoffModule.ensureSchemaCurrentCore(adapter, projectId, { silent: true });
  return { adapter, boot, classification, units };
}

async function isPgvectorAvailable() {
  const c = await pgConnect('postgres');
  try {
    const { rows } = await c.query(`SELECT 1 FROM pg_available_extensions WHERE name = 'vector'`);
    return rows.length > 0;
  } catch (_) {
    return false;
  } finally {
    await c.end();
  }
}

function runCli(args, opts = {}) {
  return spawnSync(process.execPath, [HANDOFF_SCRIPT, ...args], {
    cwd: opts.cwd || PROJECT_ROOT,
    env: { ...process.env, ...opts.env },
    encoding: 'utf8',
    timeout: opts.timeout || 20000,
  });
}

async function getDegradedRow(client, projectId) {
  const { rows } = await client.query(
    `SELECT value FROM project_settings WHERE project_id = $1 AND key = 'schema_apply_degraded'`,
    [projectId]
  );
  if (rows.length === 0) return null;
  try { return JSON.parse(rows[0].value); } catch (_) { return { reason: 'unknown' }; }
}

async function getFingerprint(client, projectId) {
  const { rows } = await client.query(
    `SELECT value FROM project_settings WHERE project_id = $1 AND key = 'schema_fingerprint'`,
    [projectId]
  );
  return rows.length > 0 ? rows[0].value : null;
}

// ── T1: S1(a) — HEALED, stale degraded row cleared ──────────────────────────

async function testT1() {
  const label = 'T1: S1(a) — fast-path HEALED: a stale degraded row with everything actually fine is cleared on touch';
  if (!(await isPgAvailable())) { skip(label, 'Postgres unavailable'); return; }
  const hasVector = await isPgvectorAvailable();
  if (!hasVector) { skip(label, 'pgvector extension not available on this Postgres'); return; }

  const dbName = `cm185heal_t1_${Date.now()}`;
  const PID = 'schema-heal-t1';
  try {
    await createThrowawayDb(dbName);
    const client = await pgConnect(dbName);
    const { adapter } = await bootstrapCurrentDb(client, PID, { withExtension: true });

    // Confirm the healthy baseline has NO degraded row (extension present,
    // everything applied cleanly) before injecting a stale one.
    assertEqual(await getDegradedRow(client, PID), null, 'T1 precondition: no degraded row on the clean baseline');

    // Inject a stale degraded row that does not reflect reality (simulates
    // leftover history — e.g. an operator manually fixed things without a
    // touch ever clearing the record).
    await client.query(
      `INSERT INTO project_settings (project_id, key, value) VALUES ($1, 'schema_apply_degraded', $2)`,
      [PID, JSON.stringify({ reason: 'pgvector_gated_skip', detail: { stale: true }, stamp: new Date(0).toISOString() })]
    );
    assertTrue(!!(await getDegradedRow(client, PID)), 'T1 precondition: stale degraded row now present');

    const result = await handoffModule.ensureSchemaCurrentCore(adapter, PID, { silent: true });
    assertEqual(result.reason, 'current', 'T1: fast path reports current (HEALED, nothing to apply)');
    assertEqual(result.applied, false, 'T1: no DDL apply needed');
    assertEqual(await getDegradedRow(client, PID), null, 'T1: the stale degraded row was CLEARED — this is the HEALED outcome');

    await client.end();
    pass(label);
  } catch (err) {
    fail(label, err.message);
  } finally {
    await dropThrowawayDb(dbName);
  }
}

// ── T2: S1(b) — ungated column dropped by hand heals on `status` ───────────

async function testT2() {
  const label = 'T2: S1(b) — an ungated column dropped by hand on a fingerprint-current DB heals on `handoff.js status` (S3)';
  if (!(await isPgAvailable())) { skip(label, 'Postgres unavailable'); return; }
  const hasVector = await isPgvectorAvailable();
  if (!hasVector) { skip(label, 'pgvector extension not available on this Postgres'); return; }

  const dbName = `cm185heal_t2_${Date.now()}`;
  const projDir = path.join(os.tmpdir(), `cm185heal-t2-${Date.now()}`);
  try {
    await createThrowawayDb(dbName);
    const client = await pgConnect(dbName);
    // resolveProjectId()'s marker-less fallback is encodeCwd(root) — compute
    // the SAME value here so this test seeds rows under the exact project_id
    // the `status` subprocess will independently derive (mirrors
    // test-decisions-canon.js's own T3 pattern).
    const { encodeCwd } = require(path.join(PROJECT_ROOT, 'scripts', 'lib', 'encoded-cwd.js'));
    fs.mkdirSync(projDir, { recursive: true });
    const gitInit = spawnSync('git', ['-C', projDir, 'init', '-q'], { encoding: 'utf8' });
    if (gitInit.status !== 0) throw new Error(`git init failed: ${gitInit.stderr}`);
    const PID = encodeCwd(projDir);

    await bootstrapCurrentDb(client, PID, { withExtension: true });
    assertEqual(await getDegradedRow(client, PID), null, 'T2 precondition: clean baseline, no degraded row');

    // Drop an UNGATED column by hand — physically missing despite the
    // fingerprint staying byte-identical (the SQL never changed).
    await client.query(`ALTER TABLE assertions DROP COLUMN reality_check`);
    const { rows: preCheck } = await client.query(
      `SELECT 1 FROM information_schema.columns WHERE table_name='assertions' AND column_name='reality_check'`
    );
    assertEqual(preCheck.length, 0, 'T2 precondition: reality_check column is genuinely absent');

    const statusResult = runCli(['status', '--json'], {
      cwd: projDir,
      env: { PROJECT_ROOT: projDir, HANDOFF_DB: dbName, PGDATABASE: undefined },
    });
    assertEqual(statusResult.status, 0, `T2: status must exit 0, got ${statusResult.status}. stdout:\n${statusResult.stdout}\nstderr:\n${statusResult.stderr}`);
    const doneIdx = statusResult.stdout.indexOf('\nDone:');
    const jsonBlockText = doneIdx >= 0 ? statusResult.stdout.slice(0, doneIdx) : statusResult.stdout;
    const statusJson = JSON.parse(jsonBlockText.slice(jsonBlockText.indexOf('{')));
    assertTrue(!!statusJson.schema_heal, `T2: status --json's schema_heal field says what it healed — got: ${JSON.stringify(statusJson.schema_heal)}`);

    const { rows: postCheck } = await client.query(
      `SELECT 1 FROM information_schema.columns WHERE table_name='assertions' AND column_name='reality_check'`
    );
    assertEqual(postCheck.length, 1, 'T2: reality_check column was RESTORED by the status-triggered heal');

    await client.end();
    pass(label);
  } catch (err) {
    fail(label, err.message);
  } finally {
    await dropThrowawayDb(dbName);
    try { fs.rmSync(projDir, { recursive: true, force: true }); } catch (_) {}
  }
}

// ── T3: S1(c) — extension absent, re-stamped every touch ───────────────────

async function testT3() {
  const label = 'T3: S1(c) — extension absent stays degraded and RE-STAMPS with the current probe on every touch (S4)';
  if (!(await isPgAvailable())) { skip(label, 'Postgres unavailable'); return; }

  const dbName = `cm185heal_t3_${Date.now()}`;
  const PID = 'schema-heal-t3';
  try {
    await createThrowawayDb(dbName);
    const client = await pgConnect(dbName);
    const { adapter } = await bootstrapCurrentDb(client, PID, { withExtension: false });

    const first = await getDegradedRow(client, PID);
    assertTrue(!!first, 'T3 precondition: degraded row present (extension absent)');
    assertEqual(first.reason, 'pgvector_gated_skip', 'T3 precondition: reason is pgvector_gated_skip');
    assertEqual(first.detail.vectorExtensionPresent, false, 'T3 precondition: vectorExtensionPresent false');

    // Sleep-free stamp-change proof: ISO timestamps at millisecond
    // resolution could tie on a very fast loop, so assert on CONTENT
    // (still reflects the SAME live state, i.e. re-probed, not stale-copied)
    // rather than requiring a strictly-later stamp string.
    const result = await handoffModule.ensureSchemaCurrentCore(adapter, PID, { silent: true });
    assertEqual(result.reason, 'degraded', 'T3: fast path (cmp=current) still reports degraded — never silently current');
    assertEqual(result.applied, false, 'T3: no apply attempted (nothing an apply could fix — extension absent)');

    const second = await getDegradedRow(client, PID);
    assertTrue(!!second, 'T3: degraded row still present after the fast-path touch');
    assertEqual(second.reason, 'pgvector_gated_skip', 'T3: reason unchanged');
    assertEqual(second.detail.vectorExtensionPresent, false, 'T3: re-stamped detail still correctly reports extension absent');
    assertTrue(
      second.stamp !== first.stamp,
      `T3: the degraded row was RE-STAMPED (fresh probe), not left as a stale copy — first=${first.stamp} second=${second.stamp}`
    );

    await client.end();
    pass(label);
  } catch (err) {
    fail(label, err.message);
  } finally {
    await dropThrowawayDb(dbName);
  }
}

// ── T4: S1(d) — extension installed after the fact, next touch applies ─────

async function testT4() {
  const label = 'T4: S1(d) — pgvector installed AFTER a degraded fingerprint-current touch: the next touch applies the gated DDL and clears the degraded row';
  if (!(await isPgAvailable())) { skip(label, 'Postgres unavailable'); return; }
  const hasVector = await isPgvectorAvailable();
  if (!hasVector) { skip(label, 'pgvector extension not available on this Postgres'); return; }

  const dbName = `cm185heal_t4_${Date.now()}`;
  const PID = 'schema-heal-t4';
  try {
    await createThrowawayDb(dbName);
    const client = await pgConnect(dbName);
    const { adapter } = await bootstrapCurrentDb(client, PID, { withExtension: false });
    assertTrue(!!(await getDegradedRow(client, PID)), 'T4 precondition: degraded (extension absent)');
    const { rows: preCol } = await client.query(
      `SELECT 1 FROM information_schema.columns WHERE table_name='assertions' AND column_name='embedding'`
    );
    assertEqual(preCol.length, 0, 'T4 precondition: assertions.embedding genuinely absent');

    // Exactly the pipeline_judge scenario the PROBLEM statement names: an
    // operator installs the extension out-of-band, with NO schema re-apply.
    await client.query('CREATE EXTENSION IF NOT EXISTS vector');

    const result = await handoffModule.ensureSchemaCurrentCore(adapter, PID, { silent: true });
    assertEqual(result.reason, 'applied', 'T4: S1(d) applies now that the extension is present');
    assertEqual(result.applied, true, 'T4: applied:true');

    const { rows: postCol } = await client.query(
      `SELECT 1 FROM information_schema.columns WHERE table_name='assertions' AND column_name='embedding'`
    );
    assertEqual(postCol.length, 1, 'T4: assertions.embedding now exists');
    assertEqual(await getDegradedRow(client, PID), null, 'T4: the stale degraded row was CLEARED — "stale degraded row with extension present clears on touch"');

    await client.end();
    pass(label);
  } catch (err) {
    fail(label, err.message);
  } finally {
    await dropThrowawayDb(dbName);
  }
}

// ── T5: finding #3 — concurrent (d)-state touches take the SAME lock ───────

async function testT5() {
  const label = 'T5: finding #3 — two concurrent S1(d) touches take the SAME advisory lock: exactly one applies, the other is a clean no-op';
  if (!(await isPgAvailable())) { skip(label, 'Postgres unavailable'); return; }
  const hasVector = await isPgvectorAvailable();
  if (!hasVector) { skip(label, 'pgvector extension not available on this Postgres'); return; }

  const dbName = `cm185heal_t5_${Date.now()}`;
  const PID = 'schema-heal-t5';
  try {
    await createThrowawayDb(dbName);
    const seedClient = await pgConnect(dbName);
    await bootstrapCurrentDb(seedClient, PID, { withExtension: false });
    await seedClient.query('CREATE EXTENSION IF NOT EXISTS vector');
    await seedClient.end();

    // Two SEPARATE connections — pg_advisory_lock is session-scoped, so this
    // genuinely exercises cross-connection mutual exclusion, not just
    // in-process async interleaving.
    const clientA = await pgConnect(dbName);
    const clientB = await pgConnect(dbName);
    const adapterA = new PostgresAdapter(clientA);
    const adapterB = new PostgresAdapter(clientB);

    const [resultA, resultB] = await Promise.all([
      handoffModule.ensureSchemaCurrentCore(adapterA, PID, { silent: true }),
      handoffModule.ensureSchemaCurrentCore(adapterB, PID, { silent: true }),
    ]);

    const appliedCount = [resultA, resultB].filter((r) => r.applied === true).length;
    assertEqual(appliedCount, 1, `T5: EXACTLY ONE of the two concurrent calls actually applied — got ${appliedCount} (resultA=${JSON.stringify(resultA)}, resultB=${JSON.stringify(resultB)})`);
    const reasons = [resultA.reason, resultB.reason].sort();
    assertEqual(reasons[0], 'applied', `T5: one call reports 'applied' — got reasons ${JSON.stringify(reasons)}`);
    assertEqual(reasons[1], 'current', `T5: the OTHER call is a clean no-op ('current', the already-fixed re-probe) — got reasons ${JSON.stringify(reasons)}`);

    const { rows: postCol } = await clientA.query(
      `SELECT 1 FROM information_schema.columns WHERE table_name='assertions' AND column_name='embedding'`
    );
    assertEqual(postCol.length, 1, 'T5: assertions.embedding exists after the race');
    assertEqual(await getDegradedRow(clientA, PID), null, 'T5: degraded row cleared after the race');

    await clientA.end();
    await clientB.end();
    pass(label);
  } catch (err) {
    fail(label, err.message);
  } finally {
    await dropThrowawayDb(dbName);
  }
}

// ── T6: finding #5 — opted-out project never auto-applies gated DDL ────────

async function testT6() {
  const label = 'T6: finding #5 — an opted-out project with the extension now present still NEVER auto-applies gated DDL';
  if (!(await isPgAvailable())) { skip(label, 'Postgres unavailable'); return; }
  const hasVector = await isPgvectorAvailable();
  if (!hasVector) { skip(label, 'pgvector extension not available on this Postgres'); return; }

  const dbName = `cm185heal_t6_${Date.now()}`;
  const PID = 'schema-heal-t6';
  try {
    await createThrowawayDb(dbName);
    const client = await pgConnect(dbName);
    const { adapter } = await bootstrapCurrentDb(client, PID, { withExtension: false });
    await client.query(
      `INSERT INTO project_settings (project_id, key, value) VALUES ($1, 'embeddings_opt_out', $2)`,
      [PID, JSON.stringify({ reason: 'operator', stamp: new Date().toISOString() })]
    );

    // Same "operator installs the extension out-of-band" state as T4 — the
    // ONLY difference is the opt-out flag.
    await client.query('CREATE EXTENSION IF NOT EXISTS vector');

    const result = await handoffModule.ensureSchemaCurrentCore(adapter, PID, { silent: true });
    assertEqual(result.reason, 'degraded', 'T6: still reports degraded, NEVER applied, despite the extension now being present');
    assertEqual(result.applied, false, 'T6: applied:false — the opt-out must never be silently overridden');

    const { rows: postCol } = await client.query(
      `SELECT 1 FROM information_schema.columns WHERE table_name='assertions' AND column_name='embedding'`
    );
    assertEqual(postCol.length, 0, 'T6: assertions.embedding was NEVER created — no ALTER TABLE was attempted against the opted-out project');

    await client.end();
    pass(label);
  } catch (err) {
    fail(label, err.message);
  } finally {
    await dropThrowawayDb(dbName);
  }
}

// ── T7: finding #1 — manifest/DDL desync -> classification_error ───────────

function testT7() {
  const label = 'T7: finding #1 — a manifest expected_objects entry with no matching DDL in its own SQL is a classification_error, never live "missing"';
  try {
    const scratchRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cm185heal-t7-'));
    const sqlDir = path.join(scratchRoot, 'scripts', 'sql');
    fs.mkdirSync(sqlDir, { recursive: true });

    fs.writeFileSync(
      path.join(sqlDir, 'fake-unit.sql'),
      '-- handoff:dialect postgres\nCREATE TABLE IF NOT EXISTS widgets (id serial primary key);\n',
      'utf8'
    );
    fs.writeFileSync(
      path.join(sqlDir, 'schema-manifest.json'),
      JSON.stringify({
        schema_epoch: 1,
        required_roster: ['fake-unit.sql'],
        units: {
          'fake-unit.sql': {
            classification: 'postgres',
            order: 10,
            expected_objects: {
              tables: ['widgets'],
              columns: [{ table: 'widgets', column: 'totally_phantom_column' }],
              indexes: [],
            },
          },
        },
      }, null, 2),
      'utf8'
    );

    const result = classifySchemaFiles({ engineRoot: scratchRoot });
    assertFalse(result.ok, 'T7: classification must FAIL on the phantom column entry');
    assertTrue(
      result.errors.some((e) => e.includes('totally_phantom_column') && e.includes('desync')),
      `T7: an error names the phantom column and calls it a desync — got: ${JSON.stringify(result.errors)}`
    );
    fs.rmSync(scratchRoot, { recursive: true, force: true });
    pass(label);
  } catch (err) {
    fail(label, err.message);
  }
}

// ── T8: S2 — fresh init records schema_fingerprint ──────────────────────────

async function testT8() {
  const label = 'T8: S2 — `handoff.js init` records schema_fingerprint (previously NEVER written by init at all)';
  if (!(await isPgAvailable())) { skip(label, 'Postgres unavailable'); return; }

  const dbName = `cm185heal_t8_${Date.now()}`;
  const projDir = path.join(os.tmpdir(), `cm185heal-t8-init-${Date.now()}`);
  try {
    await createThrowawayDb(dbName);
    fs.mkdirSync(projDir, { recursive: true });
    const gitInit = spawnSync('git', ['-C', projDir, 'init', '-q'], { encoding: 'utf8' });
    if (gitInit.status !== 0) throw new Error(`git init failed: ${gitInit.stderr}`);

    const result = runCli(['init', '-y', '--no-embeddings'], {
      cwd: projDir,
      env: { PROJECT_ROOT: projDir, HANDOFF_DB: dbName },
    });
    assertEqual(result.status, 0, `T8: init must exit 0, got ${result.status}. stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    assertTrue(result.stdout.includes('schema_fingerprint recorded'), `T8: init prints the new [OK] schema_fingerprint recorded line — got:\n${result.stdout}`);

    const client = await pgConnect(dbName);
    const { rows } = await client.query(`SELECT value FROM project_settings WHERE key = 'schema_fingerprint'`);
    await client.end();
    assertEqual(rows.length, 1, 'T8: exactly one schema_fingerprint row now exists after init');
    assertTrue(/^\d+:[0-9a-f]{64}$/.test(rows[0].value), `T8: fingerprint value is epoch-prefixed hex, got: ${rows[0].value}`);

    pass(label);
  } catch (err) {
    fail(label, err.message);
  } finally {
    await dropThrowawayDb(dbName);
    try { fs.rmSync(projDir, { recursive: true, force: true }); } catch (_) {}
  }
}

// ── T9: S2/finding #4 — init still FATALs on gated-missing, AND records fingerprint ──

async function testT9() {
  const label = 'T9: S2/finding #4 — init against a genuinely-broken gated column DDL still exits 1 (unchanged policy), while ALSO recording schema_fingerprint (unified plumbing)';
  if (!(await isPgAvailable())) { skip(label, 'Postgres unavailable'); return; }
  const hasVector = await isPgvectorAvailable();
  if (!hasVector) { skip(label, 'pgvector extension not available on this Postgres'); return; }

  const dbName = `cm185heal_t9_${Date.now()}`;
  const projDir = path.join(os.tmpdir(), `cm185heal-t9-init-${Date.now()}`);
  const scratchEngineRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cm185heal-t9-engine-'));
  try {
    await createThrowawayDb(dbName);
    // Extension present BEFORE init runs — init's needsExtensionInstall
    // preflight then never even attempts CREATE EXTENSION, isolating this
    // test to the "extension confirmed present, gated DDL still didn't
    // take" defect class the FATAL block exists for.
    const preClient = await pgConnect(dbName);
    await preClient.query('CREATE EXTENSION IF NOT EXISTS vector');
    await preClient.end();

    // Scratch engine root: real schema-manifest.json + every OTHER
    // required_roster SQL unit, copied verbatim by the shared
    // copySchemaUnits() helper (test/lib/scratch-engine-root.js) so this
    // list can never again go stale as required_roster grows (cm#298 CI
    // break: a hand-typed basename list here omitted usage-telemetry-
    // schema.sql / feature-usage-schema.sql after they were added).
    // handoff-core-schema.sql is the ONE deliberate exclusion — this test's
    // whole point is to apply a MUTATED copy of it (see below) with its
    // gated ALTER rewritten to a bogus type, so the DO $$ ...
    // EXCEPTION WHEN OTHERS $$ block still degrades gracefully but now
    // ALWAYS fails regardless of pgvector's presence (a stand-in for
    // "extension present, gated DDL still doesn't take" — e.g. an old
    // pgvector build with no halfvec type — without needing to control the
    // test Postgres's actual pgvector version).
    const realSqlDir = path.join(PROJECT_ROOT, 'scripts', 'sql');
    const scratchSqlDir = path.join(scratchEngineRoot, 'scripts', 'sql');
    copySchemaUnits(PROJECT_ROOT, scratchEngineRoot, { exclude: ['handoff-core-schema.sql'] });
    const coreSrc = fs.readFileSync(path.join(realSqlDir, 'handoff-core-schema.sql'), 'utf8');
    assertTrue(coreSrc.includes('embedding halfvec(4000)'), 'T9 precondition: the real file still has the expected gated ALTER text to rewrite');
    const brokenCore = coreSrc.replace(
      'ALTER TABLE assertions ADD COLUMN IF NOT EXISTS embedding halfvec(4000);',
      'ALTER TABLE assertions ADD COLUMN IF NOT EXISTS embedding no_such_type_cm185heal_t9;'
    );
    assertTrue(brokenCore !== coreSrc, 'T9 precondition: the rewrite actually changed something');
    fs.writeFileSync(path.join(scratchSqlDir, 'handoff-core-schema.sql'), brokenCore, 'utf8');

    fs.mkdirSync(projDir, { recursive: true });
    const gitInit = spawnSync('git', ['-C', projDir, 'init', '-q'], { encoding: 'utf8' });
    if (gitInit.status !== 0) throw new Error(`git init failed: ${gitInit.stderr}`);

    // CI-portability audit (review round 2): this run deterministically
    // FATALs at the gated-column check, which runs strictly BEFORE Step 7.5
    // (embedding_providers seeding) in cmdInit's own control flow — so it
    // never actually reads HANDOFF_BASE_DIR/handoff-embed.json or needs a
    // VLLM_EMBED_URL regardless of machine. HANDOFF_BASE_DIR is still
    // pinned defensively (empty scratch dir) so this test can never
    // accidentally depend on this machine's real user-scope config even if
    // cmdInit's ordering ever changes.
    const result = runCli(['init', '-y'], {
      cwd: projDir,
      env: { PROJECT_ROOT: projDir, HANDOFF_DB: dbName, CLAUDE_PLUGIN_ROOT: scratchEngineRoot, HANDOFF_BASE_DIR: scratchEngineRoot },
    });
    const out = (result.stdout || '') + (result.stderr || '');
    assertEqual(result.status, 1, `T9: init must still exit 1 (unchanged fatal policy), got ${result.status}. Output:\n${out.slice(0, 2000)}`);
    assertTrue(out.includes('gated column(s)/index(es) are still missing'), `T9: the SAME fatal message fires — got:\n${out.slice(0, 2000)}`);
    assertTrue(out.includes('assertions.embedding'), `T9: the message names assertions.embedding — got:\n${out.slice(0, 2000)}`);

    const client = await pgConnect(dbName);
    const { rows: fpRows } = await client.query(`SELECT value FROM project_settings WHERE key = 'schema_fingerprint'`);
    assertEqual(fpRows.length, 1, 'T9: schema_fingerprint WAS recorded despite the fatal exit — S2 unifies only the persistence plumbing, not the pass/fail policy');
    const { rows: degRows } = await client.query(`SELECT value FROM project_settings WHERE key = 'schema_apply_degraded'`);
    assertEqual(degRows.length, 1, 'T9: a schema_apply_degraded row WAS recorded before the fatal exit (S4 — status on this project would show the real state)');
    const degParsed = JSON.parse(degRows[0].value);
    assertEqual(degParsed.reason, 'pgvector_gated_skip', 'T9: degraded row reason is pgvector_gated_skip');
    await client.end();

    pass(label);
  } catch (err) {
    fail(label, err.message);
  } finally {
    await dropThrowawayDb(dbName);
    try { fs.rmSync(projDir, { recursive: true, force: true }); } catch (_) {}
    try { fs.rmSync(scratchEngineRoot, { recursive: true, force: true }); } catch (_) {}
  }
}

// ── T10: S2 — re-init clears a stale degraded row ───────────────────────────

async function testT10() {
  const label = 'T10: S2 — re-`init` after pgvector is installed clears a stale schema_apply_degraded row left by an earlier touch';
  if (!(await isPgAvailable())) { skip(label, 'Postgres unavailable'); return; }
  const hasVector = await isPgvectorAvailable();
  if (!hasVector) { skip(label, 'pgvector extension not available on this Postgres'); return; }

  const dbName = `cm185heal_t10_${Date.now()}`;
  const projDir = path.join(os.tmpdir(), `cm185heal-t10-init-${Date.now()}`);
  const baseDir = path.join(os.tmpdir(), `cm185heal-t10-base-${Date.now()}`);
  let fakeServer = null;
  try {
    await createThrowawayDb(dbName);
    fs.mkdirSync(projDir, { recursive: true });
    fs.mkdirSync(baseDir, { recursive: true });
    const gitInit = spawnSync('git', ['-C', projDir, 'init', '-q'], { encoding: 'utf8' });
    if (gitInit.status !== 0) throw new Error(`git init failed: ${gitInit.stderr}`);

    // CI portability (review round 2): a real `init -y` without
    // --no-embeddings runs Step 7.5 (seed embedding_providers), which reads
    // ${HANDOFF_BASE_DIR}/handoff-embed.json / VLLM_EMBED_URL / pipeline.yml
    // — none of which exist on a fresh CI runner. This test's own scenario
    // (re-init clearing a stale degraded row) has nothing to do with
    // embeddings, but it DOES need init to reach a full success (exit 0),
    // so it needs *some* endpoint to resolve rather than BLOCK. Spin up a
    // real (separate-process) fake embed server and point VLLM_EMBED_URL at
    // it — deterministic on every machine, never dependent on this one's
    // own ~/.claude/handoff-embed.json or a locally-running vLLM. HANDOFF_BASE_DIR
    // is ALSO pinned to an empty scratch dir so a real user-scope
    // handoff-embed.json (if one exists on the machine running this test)
    // is never consulted at all.
    fakeServer = await startFakeEmbedServerProcess(LOCAL_PROVIDER_NATIVE_DIMS, 0.1);
    const embedEnv = {
      PROJECT_ROOT: projDir, HANDOFF_DB: dbName,
      VLLM_EMBED_URL: `http://127.0.0.1:${fakeServer.port}`,
      HANDOFF_BASE_DIR: baseDir,
    };

    // Step 1: a REAL, fully-successful first init — mints its OWN marker
    // UUID (never encodeCwd(projDir); that fallback belongs to
    // resolveProjectId()'s marker-LESS path used by status/resume, not to
    // init's own provisioning, which always mints or reuses a real marker).
    const first = runCli(['init', '-y'], { cwd: projDir, env: embedEnv });
    assertEqual(first.status, 0, `T10 precondition: first init must succeed, got ${first.status}. stdout:\n${first.stdout}\nstderr:\n${first.stderr}`);

    const { readMarker } = require(path.join(PROJECT_ROOT, 'scripts', 'lib', 'project-marker.js'));
    const marker = readMarker(projDir);
    assertTrue(!!(marker && marker.uuid), 'T10 precondition: marker written by the first init is readable');
    const PID = marker.uuid;

    // Step 2: stamp a stale degraded row directly under the REAL project_id
    // (simulating history left behind by an earlier TOUCH — e.g. the exact
    // T4 scenario — without needing to re-run the whole degrade-then-fix
    // sequence here too).
    const seedClient = await pgConnect(dbName);
    await seedClient.query(
      `INSERT INTO project_settings (project_id, key, value) VALUES ($1, 'schema_apply_degraded', $2)
       ON CONFLICT (project_id, key) DO UPDATE SET value = EXCLUDED.value`,
      [PID, JSON.stringify({ reason: 'pgvector_gated_skip', detail: { stale: true }, stamp: new Date(0).toISOString() })]
    );
    await seedClient.end();

    // Step 3: re-init of the SAME (already-marked) project — reuses the
    // existing marker's UUID.
    const second = runCli(['init', '-y'], { cwd: projDir, env: embedEnv });
    assertEqual(second.status, 0, `T10: re-init must exit 0, got ${second.status}. stdout:\n${second.stdout}\nstderr:\n${second.stderr}`);

    const client = await pgConnect(dbName);
    const { rows: degRows } = await client.query(
      `SELECT value FROM project_settings WHERE project_id = $1 AND key = 'schema_apply_degraded'`, [PID]
    );
    await client.end();
    assertEqual(degRows.length, 0, 'T10: the stale degraded row was cleared by the re-init run (S2 completeness — resolves history on an existing project, not just fresh ones)');

    pass(label);
  } catch (err) {
    fail(label, err.message);
  } finally {
    if (fakeServer) { try { fakeServer.stop(); } catch (_) {} }
    await dropThrowawayDb(dbName);
    try { fs.rmSync(projDir, { recursive: true, force: true }); } catch (_) {}
    try { fs.rmSync(baseDir, { recursive: true, force: true }); } catch (_) {}
  }
}

// ── T11: finding #6 — dims/type mismatch never reports HEALED ──────────────

async function testT11() {
  const label = 'T11: finding #6 — a hand-created wrong-shape gated column (vector(1024) instead of halfvec(4000)) is never reported HEALED';
  if (!(await isPgAvailable())) { skip(label, 'Postgres unavailable'); return; }
  const hasVector = await isPgvectorAvailable();
  if (!hasVector) { skip(label, 'pgvector extension not available on this Postgres'); return; }

  const dbName = `cm185heal_t11_${Date.now()}`;
  const PID = 'schema-heal-t11';
  try {
    await createThrowawayDb(dbName);
    const client = await pgConnect(dbName);
    const classification = classifySchemaFiles({ engineRoot: PROJECT_ROOT });
    const units = classification.unitsByDialect.postgres;
    const adapter = new PostgresAdapter(client);

    // Step 1: apply the FULL real engine WITHOUT the extension — the gated
    // embedding block degrades gracefully exactly as it would on any stock
    // Postgres (assertions.embedding genuinely absent afterward).
    const firstApply = await handoffModule.applyAdditiveSchema(adapter, units, { silent: true });
    assertTrue(firstApply.ok, `T11: initial apply (extension absent) must succeed — ${firstApply.errorMsg}`);

    // Step 2: install the extension, then hand-create the WRONG-shape
    // column BEFORE the engine ever touches it — this is the "manually
    // created vector(1024) instead of the manifest's halfvec(4000)"
    // scenario verbatim (this project's own prior legacy-1024-dim-store
    // incident class).
    await client.query('CREATE EXTENSION IF NOT EXISTS vector');
    await client.query(`ALTER TABLE assertions ADD COLUMN embedding vector(1024)`);

    // Step 3: the first REAL touch (fingerprint absent -> apply branch).
    // ADD COLUMN IF NOT EXISTS embedding halfvec(4000) NO-OPS against the
    // pre-existing (wrong-shape) column — the DDL apply itself "succeeds"
    // (never throws), so only the shape check can catch this.
    const boot = await handoffModule.ensureSchemaCurrentCore(adapter, PID, { silent: true });
    assertEqual(boot.reason, 'degraded', `T11: shape mismatch must be reported as degraded, NEVER 'applied'/HEALED — got ${JSON.stringify(boot)}`);
    assertTrue(
      boot.detail.missing.some((m) => m.table === 'assertions' && m.column === 'embedding' && m.reason === 'shape_mismatch'),
      `T11: the missing list names the shape_mismatch reason — got ${JSON.stringify(boot.detail.missing)}`
    );

    // Retouch (fast path, fingerprint now current): must STILL report
    // degraded — existence-only re-probing would incorrectly say HEALED.
    const retouch = await handoffModule.ensureSchemaCurrentCore(adapter, PID, { silent: true });
    assertEqual(retouch.reason, 'degraded', 'T11: the fast path ALSO catches the shape mismatch, not just the initial apply path');

    await client.end();
    pass(label);
  } catch (err) {
    fail(label, err.message);
  } finally {
    await dropThrowawayDb(dbName);
  }
}

// ── T12: finding #7 — schema pinning ────────────────────────────────────────

async function testT12() {
  const label = 'T12: finding #7 — the schema-apply lifecycle pins search_path to the canonical \'public\' schema';
  if (!(await isPgAvailable())) { skip(label, 'Postgres unavailable'); return; }

  const dbName = `cm185heal_t12_${Date.now()}`;
  const PID = 'schema-heal-t12';
  try {
    await createThrowawayDb(dbName);
    const client = await pgConnect(dbName);
    // Simulate a role/session with a customized default search_path BEFORE
    // any schema-lifecycle call runs.
    await client.query(`SET search_path TO "$user", public`);
    await client.query(`SET search_path TO 'nonexistent_schema_cm185heal_t12', public`);

    const { adapter } = await bootstrapCurrentDb(client, PID, { withExtension: false });
    const { rows } = await client.query('SHOW search_path');
    assertEqual(rows[0].search_path, 'public', `T12: after the schema-apply lifecycle ran, search_path is pinned to the canonical 'public' — got: ${rows[0].search_path}`);

    await client.end();
    pass(label);
  } catch (err) {
    fail(label, err.message);
  } finally {
    await dropThrowawayDb(dbName);
  }
}

// ── T13: finding #9 — manifest-only edit changes the fingerprint ───────────

function testT13() {
  const label = 'T13: finding #9 — a manifest-only edit (zero SQL byte change) still changes the fingerprint';
  try {
    const classification = classifySchemaFiles({ engineRoot: PROJECT_ROOT });
    const units = classification.unitsByDialect.postgres;
    const original = handoffModule._computeSchemaFingerprint(units);

    // Simulate a manifest hand-edit by hashing against a MODIFIED copy of
    // the manifest bytes, using the SAME internal hash-of-file primitive
    // the fingerprint uses, without touching the real repo file on disk.
    const manifestPath = path.join(PROJECT_ROOT, 'scripts', 'sql', 'schema-manifest.json');
    const originalManifestHash = handoffModule._hashSchemaFileNormalized(manifestPath);
    const scratchManifest = path.join(os.tmpdir(), `cm185heal-t13-manifest-${Date.now()}.json`);
    const manifestRaw = fs.readFileSync(manifestPath, 'utf8');
    fs.writeFileSync(scratchManifest, manifestRaw + '\n// a trailing byte the real file does not have\n', 'utf8');
    const editedManifestHash = handoffModule._hashSchemaFileNormalized(scratchManifest);
    fs.unlinkSync(scratchManifest);
    assertTrue(editedManifestHash !== originalManifestHash, 'T13 precondition: the edited manifest bytes hash differently');

    // The fingerprint over the SAME units is stable across repeated calls
    // (proves it is a pure function of file content, not e.g. current time),
    // and _computeSchemaFingerprint's own source includes the manifest hash
    // in its digest input (white-box: the fingerprint changes if and only
    // if EITHER a unit's bytes OR the manifest's bytes change).
    const again = handoffModule._computeSchemaFingerprint(units);
    assertEqual(again, original, 'T13: fingerprint is stable/pure across repeated calls with unchanged files');

    const engineSrc = fs.readFileSync(path.join(PROJECT_ROOT, 'scripts', 'handoff.js'), 'utf8');
    const fnStart = engineSrc.indexOf('function _computeSchemaFingerprint(');
    const fnEnd = engineSrc.indexOf('\n}', fnStart);
    const fnBody = engineSrc.slice(fnStart, fnEnd);
    assertTrue(
      fnBody.includes('schema-manifest.json'),
      'T13: _computeSchemaFingerprint\'s own source folds schema-manifest.json\'s bytes into the hash input'
    );

    pass(label);
  } catch (err) {
    fail(label, err.message);
  }
}

// ── T14: finding #8 — white-box, ONE shared fingerprint-write helper ───────

function testT14() {
  const label = 'T14: finding #8 — cmdInit and ensureSchemaCurrentCore call the SAME shared recordSchemaFingerprint export (not a duplicate copy)';
  try {
    assertTrue(typeof handoffModule.recordSchemaFingerprint === 'function', 'T14: recordSchemaFingerprint is exported');

    const engineSrc = fs.readFileSync(path.join(PROJECT_ROOT, 'scripts', 'handoff.js'), 'utf8');
    const callSites = engineSrc.split('recordSchemaFingerprint(').length - 1;
    // 1 definition + at least 2 call sites (cmdInit, and inside
    // ensureSchemaCurrentCore's shared runSchemaApplySequence helper).
    assertTrue(callSites >= 3, `T14: expected the definition plus >=2 call sites of recordSchemaFingerprint, found ${callSites} occurrences total`);

    // There must be exactly ONE function definition (never a duplicate).
    const defCount = (engineSrc.match(/async function recordSchemaFingerprint\(/g) || []).length;
    assertEqual(defCount, 1, 'T14: exactly one recordSchemaFingerprint function definition exists');

    pass(label);
  } catch (err) {
    fail(label, err.message);
  }
}

// ── T15: S1 "any other" — a probe FAILURE BLOCKs, never apply-retries ──────

async function testT15() {
  const label = 'T15: S1 "any other" branch — a probe FAILURE (not a real missing list) BLOCKs and never enters the apply-retry branch';
  if (!(await isPgAvailable())) { skip(label, 'Postgres unavailable'); return; }
  const hasVector = await isPgvectorAvailable();
  if (!hasVector) { skip(label, 'pgvector extension not available on this Postgres'); return; }

  const dbName = `cm185heal_t15_${Date.now()}`;
  const PID = 'schema-heal-t15';
  try {
    await createThrowawayDb(dbName);
    const client = await pgConnect(dbName);
    const { adapter } = await bootstrapCurrentDb(client, PID, { withExtension: true });
    assertEqual(await getDegradedRow(client, PID), null, 'T15 precondition: clean baseline');

    // Monkeypatch THIS INSTANCE's probeFastPathSchemaState (PR #262 perf
    // follow-up: the fast path's combined catalog query) to simulate a
    // probe failure (e.g. a transient connection error) — instance-level,
    // not module-level, so it affects only this adapter object, never any
    // other test or the require() cache.
    adapter.probeFastPathSchemaState = async () => {
      throw new Error('simulated transient connection error');
    };

    const result = await handoffModule.ensureSchemaCurrentCore(adapter, PID, { silent: true });
    assertEqual(result.reason, 'verification_probe_failed', `T15: a probe error BLOCKs with its own distinct reason, never 'apply_failed'/'behind' — got ${JSON.stringify(result)}`);
    assertEqual(result.applied, false, 'T15: applied:false — no DDL was attempted against a database we just failed to read from');

    const degraded = await getDegradedRow(client, PID);
    assertTrue(!!degraded, 'T15: a degraded row was recorded');
    assertEqual(degraded.reason, 'verification_probe_failed', 'T15: degraded row reason matches');

    await client.end();
    pass(label);
  } catch (err) {
    fail(label, err.message);
  } finally {
    await dropThrowawayDb(dbName);
  }
}

// ── T16: SQLite seam unaffected ─────────────────────────────────────────────

async function testT16() {
  const label = 'T16: S5 — SQLite seam: the fast path\'s new ungated probe is dialect-agnostic, no regression';
  try {
    const dbPath = path.join(os.tmpdir(), `cm185heal-t16-${Date.now()}.sqlite`);
    const adapter = new SQLiteAdapter(dbPath);
    await adapter.connect();
    const PID = 'schema-heal-t16';

    const classification = classifySchemaFiles({ engineRoot: PROJECT_ROOT });
    const units = classification.unitsByDialect.sqlite;
    const applyResult = await handoffModule.applyAdditiveSchema(adapter, units, { silent: true });
    assertTrue(applyResult.ok, `T16: SQLite apply must succeed — ${applyResult.errorMsg}`);

    const first = await handoffModule.ensureSchemaCurrentCore(adapter, PID, { silent: true });
    assertEqual(first.reason, 'applied', 'T16: first touch applies (fresh fingerprint)');

    // Second touch: fast path (cmp==='current'). Must run the NEW ungated
    // probe cleanly on SQLite (schemaObjectsExist is implemented there) and
    // report 'current' — SQLite's manifest unit declares no pgvector_gated
    // entry at all, so the gated branch short-circuits ok:true with zero
    // extra queries.
    const second = await handoffModule.ensureSchemaCurrentCore(adapter, PID, { silent: true });
    assertEqual(second.reason, 'current', 'T16: second touch (fast path) is a clean no-op on SQLite');
    assertEqual(second.applied, false, 'T16: no re-apply on SQLite fast path');

    await adapter.end();
    fs.rmSync(dbPath, { force: true });
    try { fs.rmSync(dbPath + '-wal', { force: true }); } catch (_) {}
    try { fs.rmSync(dbPath + '-shm', { force: true }); } catch (_) {}
    pass(label);
  } catch (err) {
    fail(label, err.message);
  }
}

// ── T17: review round 3 — classifySchemaFiles memoization ──────────────────

function testT17() {
  const label = 'T17: review round 3 — classifySchemaFiles() memoizes per engineRoot; a schema file mtime change invalidates';
  const scratchRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cm185heal-t17-'));
  try {
    const sqlDir = path.join(scratchRoot, 'scripts', 'sql');
    fs.mkdirSync(sqlDir, { recursive: true });
    const sqlFile = path.join(sqlDir, 'fake-unit.sql');
    fs.writeFileSync(
      sqlFile,
      '-- handoff:dialect postgres\nCREATE TABLE IF NOT EXISTS widgets (id serial primary key);\n',
      'utf8'
    );
    fs.writeFileSync(
      path.join(sqlDir, 'schema-manifest.json'),
      JSON.stringify({
        schema_epoch: 1,
        required_roster: ['fake-unit.sql'],
        units: {
          'fake-unit.sql': { classification: 'postgres', order: 10, expected_objects: { tables: ['widgets'], columns: [], indexes: [] } },
        },
      }, null, 2),
      'utf8'
    );

    _clearClassifyCache(); // isolate from any other test that reused this path (none do; belt-and-suspenders)

    // Prove "the parse is skipped" directly: count fs.readFileSync calls.
    // Fully synchronous section (classifySchemaFiles itself is sync, and
    // this test never awaits) — no other code can interleave and pollute
    // the count between install and restore.
    const originalReadFileSync = fs.readFileSync;
    let readCount = 0;
    fs.readFileSync = function (...args) { readCount++; return originalReadFileSync.apply(fs, args); };
    try {
      const r1 = classifySchemaFiles({ engineRoot: scratchRoot });
      assertTrue(r1.ok, `T17 precondition: fixture classifies cleanly — ${JSON.stringify(r1.errors)}`);
      const afterFirstCall = readCount;
      assertTrue(afterFirstCall > 0, 'T17 precondition: the first call actually read file content (manifest + the SQL unit)');

      const r2 = classifySchemaFiles({ engineRoot: scratchRoot });
      assertEqual(readCount, afterFirstCall, 'T17: a second call in the same process performs ZERO additional file reads — cache hit, parse skipped');
      assertTrue(r1 === r2, 'T17: the cache hit returns the SAME result object reference (not merely equal content)');

      // Touch the SQL file's mtime forward — the stat SIGNATURE is always
      // recomputed (that part is never skipped), so this must invalidate.
      const future = new Date(Date.now() + 10000);
      fs.utimesSync(sqlFile, future, future);

      const r3 = classifySchemaFiles({ engineRoot: scratchRoot });
      assertTrue(readCount > afterFirstCall, 'T17: after an mtime change, the NEXT call re-reads file content — cache invalidated, never held stale past a real on-disk change');
      assertTrue(r3 !== r1, 'T17: the invalidated call returns a freshly-computed result object, not the stale cached one');
      assertTrue(r3.ok, 'T17: the freshly-computed result is still a clean classification (content itself did not change, only mtime)');
    } finally {
      fs.readFileSync = originalReadFileSync;
    }

    pass(label);
  } catch (err) {
    fail(label, err.message);
  } finally {
    fs.rmSync(scratchRoot, { recursive: true, force: true });
  }
}

// ── FK extension tests (cm#185-schema-heal FK follow-up, F1-F8) ────────────
//   FKT1 F1  — a phantom expected_fks entry (table/column/ref_table/
//              ref_column with no textual match) is a manifest_desync
//              classification_error, never a live "missing" finding.
//   FKT2 F3  — _classifyExpectedFks total-classification matrix: table_absent,
//              absent, present_mismatched (wrong reference / on_delete /
//              not_validated / extra_constraint), present_matching — pure,
//              no DB, fabricated probe rows.
//   FKT3 F5  — SQLite's probeFastPathSchemaState FK arm is a real empty set,
//              never a crash or a false "missing".
//   FKT4 F7  — an absent FK is healed on touch; the live catalog now carries
//              the correct constraint.
//   FKT5 F7  — a wrong-reference FK (pointing at entities instead of
//              embedding_providers) is healed: DROP the wrong one, ADD the
//              correct one, in one transaction.
//   FKT6 F4/F7 — orphan rows make the corrective ADD CONSTRAINT fail; the
//              whole heal transaction rolls back, the prior (absent) state
//              is retained, and the degraded reason names the SQLSTATE.
//   FKT7 F3/F7 — a NOT VALID FK (right identity, unvalidated) classifies as
//              present_mismatched(not_validated) and heals to validated.

async function testFKT1() {
  const label = 'FKT1: F1 — a phantom expected_fks entry is a manifest_desync classification_error, never a live "missing"';
  try {
    const scratchRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cm185heal-fkt1-'));
    const sqlDir = path.join(scratchRoot, 'scripts', 'sql');
    fs.mkdirSync(sqlDir, { recursive: true });

    fs.writeFileSync(
      path.join(sqlDir, 'fake-unit.sql'),
      '-- handoff:dialect postgres\n' +
      'CREATE TABLE IF NOT EXISTS widgets (id serial primary key);\n' +
      'CREATE TABLE IF NOT EXISTS makers (id serial primary key);\n' +
      'ALTER TABLE widgets ADD COLUMN IF NOT EXISTS maker_id INTEGER REFERENCES makers(id);\n',
      'utf8'
    );
    fs.writeFileSync(
      path.join(sqlDir, 'schema-manifest.json'),
      JSON.stringify({
        schema_epoch: 1,
        required_roster: ['fake-unit.sql'],
        units: {
          'fake-unit.sql': {
            classification: 'postgres',
            order: 10,
            expected_objects: { tables: ['widgets', 'makers'], columns: [{ table: 'widgets', column: 'maker_id' }], indexes: [] },
            expected_fks: [
              { table: 'widgets', columns: ['maker_id'], ref_table: 'totally_phantom_ref_table', ref_columns: ['id'], on_delete: 'NO ACTION' },
            ],
          },
        },
      }, null, 2),
      'utf8'
    );

    const result = classifySchemaFiles({ engineRoot: scratchRoot });
    assertFalse(result.ok, 'FKT1: classification must FAIL on the phantom ref_table entry');
    assertTrue(
      result.errors.some((e) => e.includes('totally_phantom_ref_table') && e.includes('manifest_desync')),
      `FKT1: an error names the phantom ref_table and tags manifest_desync — got: ${JSON.stringify(result.errors)}`
    );
    fs.rmSync(scratchRoot, { recursive: true, force: true });
    pass(label);
  } catch (err) {
    fail(label, err.message);
  }
}

function testFKT2() {
  const label = 'FKT2: F3 — _classifyExpectedFks total-classification matrix (table_absent/absent/mismatched×4/matching)';
  try {
    const expected = [
      { unit: 'u', table: 'ghost_table', columns: ['x'], ref_table: 'r', ref_columns: ['id'], on_delete: 'NO ACTION' },
      { unit: 'u', table: 'assertions', columns: ['absent_col'], ref_table: 'embedding_providers', ref_columns: ['id'], on_delete: 'NO ACTION' },
      { unit: 'u', table: 'assertions', columns: ['wrong_ref_col'], ref_table: 'embedding_providers', ref_columns: ['id'], on_delete: 'NO ACTION' },
      { unit: 'u', table: 'assertions', columns: ['bad_delete_col'], ref_table: 'embedding_providers', ref_columns: ['id'], on_delete: 'NO ACTION' },
      { unit: 'u', table: 'assertions', columns: ['not_valid_col'], ref_table: 'embedding_providers', ref_columns: ['id'], on_delete: 'NO ACTION' },
      { unit: 'u', table: 'assertions', columns: ['extra_col'], ref_table: 'embedding_providers', ref_columns: ['id'], on_delete: 'NO ACTION' },
      { unit: 'u', table: 'assertions', columns: ['ok_col'], ref_table: 'embedding_providers', ref_columns: ['id'], on_delete: 'NO ACTION' },
    ];
    const tablesFound = new Set(['assertions']); // ghost_table absent
    const liveFks = [
      { table: 'assertions', columns: ['wrong_ref_col'], ref_table: 'entities', ref_columns: ['id'], on_delete: 'a', validated: true, conname: 'c1' },
      { table: 'assertions', columns: ['bad_delete_col'], ref_table: 'embedding_providers', ref_columns: ['id'], on_delete: 'c', validated: true, conname: 'c2' },
      { table: 'assertions', columns: ['not_valid_col'], ref_table: 'embedding_providers', ref_columns: ['id'], on_delete: 'a', validated: false, conname: 'c3' },
      { table: 'assertions', columns: ['extra_col'], ref_table: 'embedding_providers', ref_columns: ['id'], on_delete: 'a', validated: true, conname: 'c4' },
      { table: 'assertions', columns: ['extra_col'], ref_table: 'entities', ref_columns: ['id'], on_delete: 'a', validated: true, conname: 'c4_stale' },
      { table: 'assertions', columns: ['ok_col'], ref_table: 'embedding_providers', ref_columns: ['id'], on_delete: 'a', validated: true, conname: 'c5' },
    ];
    const results = handoffModule._classifyExpectedFks(expected, tablesFound, liveFks);
    const byCol = {};
    for (const r of results) byCol[r.columns[0]] = r;

    assertEqual(byCol['x'].state, 'table_absent', `FKT2: ghost_table -> table_absent, got ${byCol['x'].state}`);
    assertEqual(byCol['absent_col'].state, 'absent', `FKT2: no live row -> absent, got ${byCol['absent_col'].state}`);
    assertEqual(byCol['wrong_ref_col'].state, 'present_mismatched', 'FKT2: wrong ref -> present_mismatched');
    assertTrue(byCol['wrong_ref_col'].reason.startsWith('wrong_reference:'), `FKT2: reason names wrong_reference — got ${byCol['wrong_ref_col'].reason}`);
    assertEqual(byCol['bad_delete_col'].state, 'present_mismatched', 'FKT2: ON DELETE mismatch -> present_mismatched');
    assertEqual(byCol['bad_delete_col'].reason, 'on_delete:CASCADE', `FKT2: reason names actual on_delete — got ${byCol['bad_delete_col'].reason}`);
    assertEqual(byCol['not_valid_col'].state, 'present_mismatched', 'FKT2: convalidated=false -> present_mismatched');
    assertEqual(byCol['not_valid_col'].reason, 'not_validated', 'FKT2: reason is not_validated');
    assertEqual(byCol['extra_col'].state, 'present_mismatched', 'FKT2: a correct match PLUS a stale extra on the same columns -> present_mismatched (inventory diff)');
    assertTrue(byCol['extra_col'].reason.startsWith('extra_constraint:'), `FKT2: reason names extra_constraint — got ${byCol['extra_col'].reason}`);
    assertEqual(byCol['ok_col'].state, 'present_matching', 'FKT2: identity+on_delete+validated all agree -> present_matching');

    pass(label);
  } catch (err) {
    fail(label, err.message);
  }
}

async function testFKT3() {
  const label = 'FKT3: F5 — SQLite probeFastPathSchemaState FK arm is a real empty set, never a crash';
  try {
    const dbPath = path.join(os.tmpdir(), `cm185heal-fkt3-${Date.now()}.sqlite`);
    const adapter = new SQLiteAdapter(dbPath);
    await adapter.connect();
    const classification = classifySchemaFiles({ engineRoot: PROJECT_ROOT });
    const units = classification.unitsByDialect.sqlite;
    const applyResult = await handoffModule.applyAdditiveSchema(adapter, units, { silent: true });
    assertTrue(applyResult.ok, `FKT3 precondition: SQLite apply must succeed — ${applyResult.errorMsg}`);

    const probe = await adapter.probeFastPathSchemaState({ tables: ['assertions'], columns: [], indexes: [], shapeTargets: [] });
    assertTrue(Array.isArray(probe.fks), 'FKT3: probe.fks is an array on SQLite');
    assertEqual(probe.fks.length, 0, 'FKT3: probe.fks is empty on SQLite');
    const classified = handoffModule._classifyExpectedFks(
      [{ unit: 'u', table: 'assertions', columns: ['x'], ref_table: 'y', ref_columns: ['id'], on_delete: 'NO ACTION' }],
      probe.tablesFound, probe.fks
    );
    assertEqual(classified[0].state, 'absent', 'FKT3: an empty FK set classifies any declared entry as absent, never a false match/crash (assertions table itself IS present)');
    await adapter.end();
    fs.rmSync(dbPath, { force: true });
    pass(label);
  } catch (err) {
    fail(label, err.message);
  }
}

async function testFKT4() {
  const label = 'FKT4: F7 — an absent FK (dropped by hand) is healed on touch; the live catalog carries the correct constraint afterward';
  if (!(await isPgAvailable())) { skip(label, 'Postgres unavailable'); return; }

  const dbName = `cm185heal_fkt4_${Date.now()}`;
  const PID = 'schema-heal-fkt4';
  try {
    await createThrowawayDb(dbName);
    const client = await pgConnect(dbName);
    const { adapter } = await bootstrapCurrentDb(client, PID, { withExtension: false });

    const { rows: before } = await client.query(
      `SELECT conname FROM pg_constraint WHERE conrelid = 'assertions'::regclass AND contype = 'f'`
    );
    assertTrue(before.length > 0, 'FKT4 precondition: assertions has a live FK to drop');
    for (const r of before) {
      await client.query(`ALTER TABLE assertions DROP CONSTRAINT "${r.conname}"`);
    }

    await handoffModule.ensureSchemaCurrentCore(adapter, PID, { silent: true });

    const { rows: after } = await client.query(
      `SELECT confrelid::regclass::text AS ref_table
         FROM pg_constraint c
         JOIN pg_class tc ON tc.oid = c.conrelid
        WHERE tc.relname = 'assertions' AND c.contype = 'f'
          AND c.conkey = (SELECT array_agg(attnum) FROM pg_attribute WHERE attrelid='assertions'::regclass AND attname='embedded_by_provider_id')`
    );
    assertTrue(after.length > 0, 'FKT4: the FK exists again after one touch');
    assertEqual(after[0].ref_table, 'embedding_providers', `FKT4: the healed FK targets embedding_providers — got ${after[0].ref_table}`);

    await client.end();
    pass(label);
  } catch (err) {
    fail(label, err.message);
  } finally {
    await dropThrowawayDb(dbName);
  }
}

async function testFKT5() {
  const label = 'FKT5: F7 — a wrong-reference FK (pointing at entities instead of embedding_providers) is healed: drop wrong, add correct, one transaction';
  if (!(await isPgAvailable())) { skip(label, 'Postgres unavailable'); return; }

  const dbName = `cm185heal_fkt5_${Date.now()}`;
  const PID = 'schema-heal-fkt5';
  try {
    await createThrowawayDb(dbName);
    const client = await pgConnect(dbName);
    const { adapter } = await bootstrapCurrentDb(client, PID, { withExtension: false });

    const { rows: before } = await client.query(
      `SELECT conname FROM pg_constraint WHERE conrelid = 'assertions'::regclass AND contype = 'f'`
    );
    for (const r of before) await client.query(`ALTER TABLE assertions DROP CONSTRAINT "${r.conname}"`);
    await client.query(
      `ALTER TABLE assertions ADD CONSTRAINT assertions_wrong_ref_fkey FOREIGN KEY (embedded_by_provider_id) REFERENCES entities(id)`
    );

    await handoffModule.ensureSchemaCurrentCore(adapter, PID, { silent: true });

    const { rows: after } = await client.query(
      `SELECT c.conname, confrelid::regclass::text AS ref_table
         FROM pg_constraint c JOIN pg_class tc ON tc.oid = c.conrelid
        WHERE tc.relname = 'assertions' AND c.contype = 'f'`
    );
    assertEqual(after.length, 1, `FKT5: exactly one FK remains on assertions (stale wrong one dropped) — got ${JSON.stringify(after)}`);
    assertEqual(after[0].ref_table, 'embedding_providers', 'FKT5: the surviving FK targets embedding_providers');
    assertTrue(after[0].conname !== 'assertions_wrong_ref_fkey', 'FKT5: the wrong-reference constraint name is gone');

    await client.end();
    pass(label);
  } catch (err) {
    fail(label, err.message);
  } finally {
    await dropThrowawayDb(dbName);
  }
}

async function testFKT6() {
  const label = 'FKT6: F4 — orphan rows make the corrective ADD CONSTRAINT fail; the heal transaction rolls back and the prior (absent) state is retained';
  if (!(await isPgAvailable())) { skip(label, 'Postgres unavailable'); return; }

  const dbName = `cm185heal_fkt6_${Date.now()}`;
  const PID = 'schema-heal-fkt6';
  try {
    await createThrowawayDb(dbName);
    const client = await pgConnect(dbName);
    const { adapter } = await bootstrapCurrentDb(client, PID, { withExtension: false });

    const { rows: before } = await client.query(
      `SELECT conname FROM pg_constraint WHERE conrelid = 'assertions'::regclass AND contype = 'f'`
    );
    for (const r of before) await client.query(`ALTER TABLE assertions DROP CONSTRAINT "${r.conname}"`);

    // Orphan row: embedded_by_provider_id references a provider id that
    // does not exist — with the FK gone, this insert succeeds freely.
    await client.query(
      `INSERT INTO assertions (project_id, subject, predicate, object, confidence, source, embedded_by_provider_id)
       VALUES ('fkt6', 'subj', 'pred', 'obj', 5.0, 'user_stated', 999999)`
    );

    const result = await handoffModule.ensureSchemaCurrentCore(adapter, PID, { silent: true });
    assertEqual(result.reason, 'degraded', `FKT6: heal failure must report degraded, never 'applied'/'current' — got ${JSON.stringify(result)}`);
    assertTrue(
      typeof result.detail.reason === 'string' && result.detail.reason.startsWith('heal_failed:'),
      `FKT6: degraded detail names heal_failed:<sqlstate> — got ${JSON.stringify(result.detail)}`
    );

    const { rows: after } = await client.query(
      `SELECT conname FROM pg_constraint WHERE conrelid = 'assertions'::regclass AND contype = 'f'`
    );
    assertEqual(after.length, 0, 'FKT6: rollback left the prior (absent) state exactly as it was — no half-migrated constraint');

    const degraded = await getDegradedRow(client, PID);
    assertEqual(degraded.reason, 'fk_mismatch', 'FKT6: the degraded row is keyed fk_mismatch');

    await client.end();
    pass(label);
  } catch (err) {
    fail(label, err.message);
  } finally {
    await dropThrowawayDb(dbName);
  }
}

async function testFKT7() {
  const label = 'FKT7: F3/F7 — a NOT VALID FK (right identity, unvalidated) classifies present_mismatched(not_validated) and heals to validated';
  if (!(await isPgAvailable())) { skip(label, 'Postgres unavailable'); return; }

  const dbName = `cm185heal_fkt7_${Date.now()}`;
  const PID = 'schema-heal-fkt7';
  try {
    await createThrowawayDb(dbName);
    const client = await pgConnect(dbName);
    const { adapter } = await bootstrapCurrentDb(client, PID, { withExtension: false });

    const { rows: before } = await client.query(
      `SELECT conname FROM pg_constraint WHERE conrelid = 'assertions'::regclass AND contype = 'f'`
    );
    for (const r of before) await client.query(`ALTER TABLE assertions DROP CONSTRAINT "${r.conname}"`);
    await client.query(
      `ALTER TABLE assertions ADD CONSTRAINT assertions_notvalid_fkey
         FOREIGN KEY (embedded_by_provider_id) REFERENCES embedding_providers(id) NOT VALID`
    );

    const result = await handoffModule.ensureSchemaCurrentCore(adapter, PID, { silent: true });
    assertTrue(result.reason === 'current' || result.reason === 'degraded', `FKT7 sanity: a recognizable reason — got ${result.reason}`);

    const { rows: after } = await client.query(
      `SELECT convalidated FROM pg_constraint WHERE conrelid = 'assertions'::regclass AND contype = 'f'`
    );
    assertEqual(after.length, 1, 'FKT7: exactly one FK remains');
    assertEqual(after[0].convalidated, true, 'FKT7: the healed FK is validated');

    await client.end();
    pass(label);
  } catch (err) {
    fail(label, err.message);
  } finally {
    await dropThrowawayDb(dbName);
  }
}

// ── Constraint extension tests (cm#185-schema-heal constraint follow-up) ──
//   CT1 — a phantom entry in each of expected_uniques/expected_not_nulls/
//         expected_checks/expected_index_defs is a manifest_desync
//         classification_error, never a live "missing".
//   CT2 — _classifyExpectedUniques total-classification matrix.
//   CT3 — _classifyExpectedNotNulls total-classification matrix.
//   CT4 — _classifyExpectedChecks total-classification matrix.
//   CT5 — _classifyExpectedIndexDefs total-classification matrix.
//   CT6 — SQLite's probeFastPathSchemaState returns real empty arrays for
//         all four new kinds — never a crash or false match.
//   CT7 — an absent UNIQUE (dropped by hand) is healed on touch.
//   CT8 — a NOT NULL heal on a column with live NULL rows fails CLOSED:
//         the whole heal transaction rolls back, prior state retained,
//         DEGRADED reason names the SQLSTATE.
//   CT9 — a UNIQUE heal on a table with duplicate rows fails CLOSED, same
//         rollback guarantee.

function testCT1() {
  const label = 'CT1: phantom expected_uniques/expected_not_nulls/expected_checks/expected_index_defs entries are manifest_desync classification_errors';
  try {
    const scratchRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cm185heal-ct1-'));
    const sqlDir = path.join(scratchRoot, 'scripts', 'sql');
    fs.mkdirSync(sqlDir, { recursive: true });
    fs.writeFileSync(
      path.join(sqlDir, 'fake-unit.sql'),
      '-- handoff:dialect postgres\n' +
      'CREATE TABLE IF NOT EXISTS widgets (id serial primary key, sku text NOT NULL, qty int CHECK (qty >= 0));\n' +
      'CREATE UNIQUE INDEX IF NOT EXISTS widgets_sku_idx ON widgets (sku);\n',
      'utf8'
    );
    fs.writeFileSync(
      path.join(sqlDir, 'schema-manifest.json'),
      JSON.stringify({
        schema_epoch: 1,
        required_roster: ['fake-unit.sql'],
        units: {
          'fake-unit.sql': {
            classification: 'postgres',
            order: 10,
            expected_objects: { tables: ['widgets'], columns: [], indexes: ['widgets_sku_idx'] },
            expected_uniques: [{ table: 'widgets', columns: ['totally_phantom_unique_col'] }],
            expected_not_nulls: [{ table: 'widgets', column: 'totally_phantom_notnull_col' }],
            expected_checks: [{ table: 'widgets', expression_tokens: ['totally_phantom_check_token'], def: 'totally_phantom_check_token >= 0' }],
            expected_index_defs: [{ name: 'totally_phantom_index_name', create_sql: 'CREATE INDEX totally_phantom_index_name ON widgets (sku)' }],
          },
        },
      }, null, 2),
      'utf8'
    );
    const result = classifySchemaFiles({ engineRoot: scratchRoot });
    assertFalse(result.ok, 'CT1: classification must FAIL on the four phantom entries');
    for (const needle of ['totally_phantom_unique_col', 'totally_phantom_notnull_col', 'totally_phantom_check_token', 'totally_phantom_index_name']) {
      assertTrue(
        result.errors.some((e) => e.includes(needle) && e.includes('manifest_desync')),
        `CT1: an error names "${needle}" and tags manifest_desync — got: ${JSON.stringify(result.errors)}`
      );
    }
    fs.rmSync(scratchRoot, { recursive: true, force: true });
    pass(label);
  } catch (err) {
    fail(label, err.message);
  }
}

function testCT2() {
  const label = 'CT2: _classifyExpectedUniques total-classification matrix (table_absent/absent/mismatched-predicate/mismatched-extra/matching)';
  try {
    const expected = [
      { unit: 'u', table: 'ghost_table', columns: ['x'], predicate: null },
      { unit: 'u', table: 'widgets', columns: ['absent_col'], predicate: null },
      { unit: 'u', table: 'widgets', columns: ['pred_col'], predicate: 'active = true' },
      { unit: 'u', table: 'widgets', columns: ['extra_col'], predicate: null },
      { unit: 'u', table: 'widgets', columns: ['ok_col'], predicate: null },
    ];
    const tablesFound = new Set(['widgets']);
    const liveUniques = [
      { table: 'widgets', name: 'pred_idx', columns: ['pred_col'], predicate: 'deleted = false' },
      { table: 'widgets', name: 'extra_idx_1', columns: ['extra_col'], predicate: null },
      { table: 'widgets', name: 'extra_idx_2', columns: ['extra_col'], predicate: null },
      { table: 'widgets', name: 'ok_idx', columns: ['ok_col'], predicate: null },
    ];
    const results = handoffModule._classifyExpectedUniques(expected, tablesFound, liveUniques);
    const byCol = {}; for (const r of results) byCol[r.columns[0]] = r;
    assertEqual(byCol['x'].state, 'table_absent', 'CT2: ghost_table -> table_absent');
    assertEqual(byCol['absent_col'].state, 'absent', 'CT2: no live row -> absent');
    assertEqual(byCol['pred_col'].state, 'present_mismatched', 'CT2: wrong predicate -> present_mismatched');
    assertEqual(byCol['pred_col'].reason, 'predicate_mismatch', 'CT2: reason is predicate_mismatch');
    assertEqual(byCol['extra_col'].state, 'present_mismatched', 'CT2: two live indexes on same columns -> present_mismatched (inventory diff)');
    assertTrue(byCol['extra_col'].reason.startsWith('extra_constraint:'), 'CT2: reason names extra_constraint');
    assertEqual(byCol['ok_col'].state, 'present_matching', 'CT2: identity+predicate agree -> present_matching');
    pass(label);
  } catch (err) {
    fail(label, err.message);
  }
}

function testCT3() {
  const label = 'CT3: _classifyExpectedNotNulls total-classification matrix (table_absent/absent/mismatched-nullable/matching)';
  try {
    const expected = [
      { unit: 'u', table: 'ghost_table', column: 'x' },
      { unit: 'u', table: 'widgets', column: 'absent_col' },
      { unit: 'u', table: 'widgets', column: 'nullable_col' },
      { unit: 'u', table: 'widgets', column: 'ok_col' },
    ];
    const tablesFound = new Set(['widgets']);
    const liveNotNulls = [
      { table: 'widgets', column: 'nullable_col', notNull: false },
      { table: 'widgets', column: 'ok_col', notNull: true },
    ];
    const results = handoffModule._classifyExpectedNotNulls(expected, tablesFound, liveNotNulls);
    const byCol = {}; for (const r of results) byCol[r.column] = r;
    assertEqual(byCol['x'].state, 'table_absent', 'CT3: ghost_table -> table_absent');
    assertEqual(byCol['absent_col'].state, 'absent', 'CT3: column itself absent -> absent');
    assertEqual(byCol['nullable_col'].state, 'present_mismatched', 'CT3: live column is nullable -> present_mismatched');
    assertEqual(byCol['nullable_col'].reason, 'nullable', 'CT3: reason is nullable');
    assertEqual(byCol['ok_col'].state, 'present_matching', 'CT3: attnotnull=true -> present_matching');
    pass(label);
  } catch (err) {
    fail(label, err.message);
  }
}

function testCT4() {
  const label = 'CT4: _classifyExpectedChecks total-classification matrix (table_absent/absent/matching, normalized-text comparison)';
  try {
    // Build via the real collector so normalized_def is computed the SAME way _classifyExpectedChecks expects.
    const manifest = { units: { fake: { expected_checks: [
      { table: 'ghost_table', expression_tokens: ['x'], def: 'CHECK ((x >= 0))' },
      { table: 'widgets', expression_tokens: ['absent'], def: 'CHECK ((absent >= 0))' },
      { table: 'widgets', expression_tokens: ['qty'], def: '  CHECK ( (qty  >=   0) )  ' },
    ] } } };
    const collected = handoffModule._collectExpectedChecks(manifest, [{ basename: 'fake' }]);
    const tablesFound = new Set(['widgets']);
    const liveChecks = [
      { table: 'widgets', conname: 'widgets_qty_check', columns: ['qty'], def: 'CHECK((qty >= 0))' },
    ];
    const results = handoffModule._classifyExpectedChecks(collected, tablesFound, liveChecks);
    const byTable = {}; for (const r of results) byTable[`${r.table}:${r.expression_tokens[0]}`] = r;
    assertEqual(byTable['ghost_table:x'].state, 'table_absent', 'CT4: ghost_table -> table_absent');
    assertEqual(byTable['widgets:absent'].state, 'absent', 'CT4: no matching live CHECK text -> absent');
    assertEqual(byTable['widgets:qty'].state, 'present_matching', 'CT4: whitespace/case/paren-normalized text matches -> present_matching');
    pass(label);
  } catch (err) {
    fail(label, err.message);
  }
}

function testCT5() {
  const label = 'CT5: _classifyExpectedIndexDefs total-classification matrix (absent/mismatched index_def_drift/matching, normalized-text comparison)';
  try {
    const expected = handoffModule._collectExpectedIndexDefs(
      { units: { fake: { expected_index_defs: [
        { name: 'ghost_idx', create_sql: 'CREATE INDEX ghost_idx ON widgets (sku)' },
        { name: 'drift_idx', create_sql: 'CREATE INDEX drift_idx ON widgets (sku)' },
        { name: 'ok_idx', create_sql: '  CREATE   INDEX ok_idx ON widgets (sku)  ' },
      ] } } },
      [{ basename: 'fake' }]
    );
    const liveIndexDefs = [
      { name: 'drift_idx', def: 'CREATE INDEX drift_idx ON widgets USING btree (qty)' },
      { name: 'ok_idx', def: 'CREATE INDEX ok_idx ON widgets (sku)' },
    ];
    const results = handoffModule._classifyExpectedIndexDefs(expected, liveIndexDefs);
    const byName = {}; for (const r of results) byName[r.name] = r;
    assertEqual(byName['ghost_idx'].state, 'absent', 'CT5: no live index by this name -> absent');
    assertEqual(byName['drift_idx'].state, 'present_mismatched', 'CT5: different definition text -> present_mismatched');
    assertEqual(byName['drift_idx'].reason, 'index_def_drift', 'CT5: reason is index_def_drift');
    assertEqual(byName['ok_idx'].state, 'present_matching', 'CT5: whitespace-normalized text matches -> present_matching');
    pass(label);
  } catch (err) {
    fail(label, err.message);
  }
}

async function testCT6() {
  const label = 'CT6: SQLite probeFastPathSchemaState returns real empty arrays for uniques/notNulls/checks/indexDefs — never a crash or false match';
  try {
    const dbPath = path.join(os.tmpdir(), `cm185heal-ct6-${Date.now()}.sqlite`);
    const adapter = new SQLiteAdapter(dbPath);
    await adapter.connect();
    const classification = classifySchemaFiles({ engineRoot: PROJECT_ROOT });
    const units = classification.unitsByDialect.sqlite;
    const applyResult = await handoffModule.applyAdditiveSchema(adapter, units, { silent: true });
    assertTrue(applyResult.ok, `CT6 precondition: SQLite apply must succeed — ${applyResult.errorMsg}`);

    const probe = await adapter.probeFastPathSchemaState({ tables: ['assertions'], columns: [], indexes: [], shapeTargets: [] });
    for (const key of ['uniques', 'notNulls', 'checks', 'indexDefs']) {
      assertTrue(Array.isArray(probe[key]), `CT6: probe.${key} is an array on SQLite`);
      assertEqual(probe[key].length, 0, `CT6: probe.${key} is empty on SQLite`);
    }
    const healResult = await adapter.healConstraints([{ kind: 'notnull', table: 'assertions', column: 'confidence' }]);
    assertTrue(healResult.ok, 'CT6: SQLite healConstraints is a real no-op (ok:true), never a crash');

    await adapter.end();
    fs.rmSync(dbPath, { force: true });
    pass(label);
  } catch (err) {
    fail(label, err.message);
  }
}

async function testCT7() {
  const label = 'CT7: an absent UNIQUE (dropped by hand) is healed on touch; the live catalog carries the correct unique index afterward';
  if (!(await isPgAvailable())) { skip(label, 'Postgres unavailable'); return; }
  const dbName = `cm185heal_ct7_${Date.now()}`;
  const PID = 'schema-heal-ct7';
  try {
    await createThrowawayDb(dbName);
    const client = await pgConnect(dbName);
    const { adapter } = await bootstrapCurrentDb(client, PID, { withExtension: false });

    const { rows: before } = await client.query(
      `SELECT indexname FROM pg_indexes WHERE tablename='entities' AND indexdef ILIKE '%UNIQUE%' AND indexname NOT LIKE '%pkey%'`
    );
    assertTrue(before.length > 0, 'CT7 precondition: entities has a live unique index to drop');
    for (const r of before) {
      // entities' UNIQUE (project_id, name) is a table-level constraint
      // (auto-backed by a same-name index) — DROP CONSTRAINT first (a
      // no-op if it's actually a bare index), then DROP INDEX.
      await client.query(`ALTER TABLE entities DROP CONSTRAINT IF EXISTS "${r.indexname}"`);
      await client.query(`DROP INDEX IF EXISTS "${r.indexname}"`);
    }

    // bootstrapCurrentDb runs with withExtension:false — the pgvector-gated
    // columns are therefore ALSO legitimately absent, independent of this
    // test's own unique-index scenario, so the overall touch result can
    // legitimately still be 'degraded' (pgvector_gated_skip). What CT7
    // actually proves is narrower and unaffected by that: the unique heal
    // itself ran and the index was restored, and the degraded reason (if
    // any) does not name unique_mismatch.
    const result = await handoffModule.ensureSchemaCurrentCore(adapter, PID, { silent: true });
    assertTrue(result.reason === 'current' || result.reason === 'degraded', `CT7: a recognizable reason — got ${result.reason}`);

    const { rows: after } = await client.query(
      `SELECT 1 FROM pg_indexes WHERE tablename='entities' AND indexdef ILIKE '%UNIQUE%' AND indexname NOT LIKE '%pkey%'`
    );
    assertTrue(after.length > 0, 'CT7: the unique index on entities(project_id, name) exists again after one touch');
    const degradedRow = await getDegradedRow(client, PID);
    assertTrue(!degradedRow || degradedRow.reason !== 'unique_mismatch', `CT7: no lingering unique_mismatch degradation — got ${JSON.stringify(degradedRow)}`);

    await client.end();
    pass(label);
  } catch (err) {
    fail(label, err.message);
  } finally {
    await dropThrowawayDb(dbName);
  }
}

async function testCT8() {
  const label = 'CT8: F4-equivalent — a NOT NULL heal on a column with live NULL rows fails CLOSED: rollback, prior nullable state retained, DEGRADED names the SQLSTATE';
  if (!(await isPgAvailable())) { skip(label, 'Postgres unavailable'); return; }
  const dbName = `cm185heal_ct8_${Date.now()}`;
  const PID = 'schema-heal-ct8';
  try {
    await createThrowawayDb(dbName);
    const client = await pgConnect(dbName);
    const { adapter } = await bootstrapCurrentDb(client, PID, { withExtension: false });

    // Make `assertions.confidence` nullable and insert a live NULL row, then
    // declare it expected-not-null via a scratch manifest override so the
    // heal path actually attempts (and must fail) a SET NOT NULL.
    await client.query(`ALTER TABLE assertions ALTER COLUMN confidence DROP NOT NULL`);
    await client.query(
      `INSERT INTO assertions (project_id, subject, predicate, object, confidence, source)
       VALUES ('ct8', 'subj', 'affirmed', 'obj', NULL, 'user_stated')`
    );

    const fixable = [{ unit: 'u', table: 'assertions', column: 'confidence', state: 'present_mismatched', reason: 'nullable' }];
    const healOutcome = await handoffModule._healExpectedNotNulls(adapter, PID, fixable);
    assertFalse(healOutcome.ok, 'CT8: heal must fail (NULL rows present)');
    assertTrue(!!healOutcome.sqlstate, `CT8: a SQLSTATE is reported — got ${JSON.stringify(healOutcome)}`);

    const { rows: after } = await client.query(
      `SELECT attnotnull FROM pg_attribute WHERE attrelid='assertions'::regclass AND attname='confidence'`
    );
    assertEqual(after[0].attnotnull, false, 'CT8: prior nullable state was retained — no partial heal');
    const { rows: stillNull } = await client.query(`SELECT 1 FROM assertions WHERE project_id='ct8' AND confidence IS NULL`);
    assertEqual(stillNull.length, 1, 'CT8: the NULL row is untouched — heal never silently deleted/coerced it');

    await client.end();
    pass(label);
  } catch (err) {
    fail(label, err.message);
  } finally {
    await dropThrowawayDb(dbName);
  }
}

async function testCT9() {
  const label = 'CT9: a UNIQUE heal on a table with duplicate rows fails CLOSED: rollback, no partial index left behind, DEGRADED names the SQLSTATE';
  if (!(await isPgAvailable())) { skip(label, 'Postgres unavailable'); return; }
  const dbName = `cm185heal_ct9_${Date.now()}`;
  const PID = 'schema-heal-ct9';
  try {
    await createThrowawayDb(dbName);
    const client = await pgConnect(dbName);
    const { adapter } = await bootstrapCurrentDb(client, PID, { withExtension: false });

    const { rows: idx } = await client.query(
      `SELECT indexname FROM pg_indexes WHERE tablename='entities' AND indexdef ILIKE '%UNIQUE%' AND indexname NOT LIKE '%pkey%'`
    );
    for (const r of idx) {
      await client.query(`ALTER TABLE entities DROP CONSTRAINT IF EXISTS "${r.indexname}"`);
      await client.query(`DROP INDEX IF EXISTS "${r.indexname}"`);
    }
    await client.query(`INSERT INTO entities (project_id, name, entity_type) VALUES ('ct9', 'dup', 'concept'), ('ct9', 'dup', 'concept')`);

    const fixable = [{ unit: 'u', table: 'entities', columns: ['project_id', 'name'], predicate: null, state: 'absent' }];
    const healOutcome = await handoffModule._healExpectedUniques(adapter, PID, fixable);
    assertFalse(healOutcome.ok, 'CT9: heal must fail (duplicate rows present)');
    assertTrue(!!healOutcome.sqlstate, `CT9: a SQLSTATE is reported — got ${JSON.stringify(healOutcome)}`);

    const { rows: after } = await client.query(
      `SELECT 1 FROM pg_indexes WHERE tablename='entities' AND indexdef ILIKE '%UNIQUE%' AND indexname NOT LIKE '%pkey%'`
    );
    assertEqual(after.length, 0, 'CT9: no partial/leftover unique index — the failed heal left the table exactly as it was');

    await client.end();
    pass(label);
  } catch (err) {
    fail(label, err.message);
  } finally {
    await dropThrowawayDb(dbName);
  }
}

async function testCT10() {
  const label = 'CT10: reviewer follow-up — retrieval_event_assertions.event_id -> retrieval_events(id) ON DELETE CASCADE classifies present_matching on a fresh DB and heals absent -> present after a hand-drop';
  if (!(await isPgAvailable())) { skip(label, 'Postgres unavailable'); return; }
  const dbName = `cm185heal_ct10_${Date.now()}`;
  const PID = 'schema-heal-ct10';
  try {
    await createThrowawayDb(dbName);
    const client = await pgConnect(dbName);
    const { adapter, classification, units } = await bootstrapCurrentDb(client, PID, { withExtension: false });

    const expectedFks = handoffModule._collectExpectedFks(classification.manifest, units);
    const reaEntry = expectedFks.find((f) => f.table === 'retrieval_event_assertions');
    assertTrue(!!reaEntry, 'CT10 precondition: retrieval_event_assertions has an expected_fks entry');

    let probe = await adapter.probeFastPathSchemaState({ tables: ['retrieval_event_assertions'], columns: [], indexes: [], shapeTargets: [] });
    let classified = handoffModule._classifyExpectedFks([reaEntry], probe.tablesFound, probe.fks);
    assertEqual(classified[0].state, 'present_matching', `CT10: fresh DB classifies present_matching — got ${classified[0].state}`);

    const { rows: before } = await client.query(
      `SELECT conname FROM pg_constraint WHERE conrelid = 'retrieval_event_assertions'::regclass AND contype = 'f'`
    );
    assertTrue(before.length > 0, 'CT10 precondition: a live FK exists to drop');
    for (const r of before) await client.query(`ALTER TABLE retrieval_event_assertions DROP CONSTRAINT "${r.conname}"`);

    probe = await adapter.probeFastPathSchemaState({ tables: ['retrieval_event_assertions'], columns: [], indexes: [], shapeTargets: [] });
    classified = handoffModule._classifyExpectedFks([reaEntry], probe.tablesFound, probe.fks);
    assertEqual(classified[0].state, 'absent', `CT10: dropped FK classifies absent — got ${classified[0].state}`);

    await handoffModule.ensureSchemaCurrentCore(adapter, PID, { silent: true });

    const { rows: after } = await client.query(
      `SELECT confrelid::regclass::text AS ref_table, confdeltype
         FROM pg_constraint WHERE conrelid = 'retrieval_event_assertions'::regclass AND contype = 'f'`
    );
    assertEqual(after.length, 1, 'CT10: the FK exists again after one touch');
    assertEqual(after[0].ref_table, 'retrieval_events', `CT10: healed FK targets retrieval_events — got ${after[0].ref_table}`);
    assertEqual(after[0].confdeltype, 'c', 'CT10: healed FK is ON DELETE CASCADE');

    await client.end();
    pass(label);
  } catch (err) {
    fail(label, err.message);
  } finally {
    await dropThrowawayDb(dbName);
  }
}

async function testCT11() {
  const label = 'CT11: inventory completeness — every live CHECK on an expected_objects table and every named expected_objects index is covered by a manifest expected_checks/expected_index_defs entry; a fresh DB classifies every kind present_matching';
  if (!(await isPgAvailable())) { skip(label, 'Postgres unavailable'); return; }
  const dbName = `cm185heal_ct11_${Date.now()}`;
  const PID = 'schema-heal-ct11';
  try {
    await createThrowawayDb(dbName);
    const client = await pgConnect(dbName);
    const { adapter, classification, units } = await bootstrapCurrentDb(client, PID, { withExtension: false });

    const expectedChecks = handoffModule._collectExpectedChecks(classification.manifest, units);
    const expectedIndexDefs = handoffModule._collectExpectedIndexDefs(classification.manifest, units);
    const coveredCheckTables = new Set(expectedChecks.map((c) => c.table));
    const coveredIndexNames = new Set(expectedIndexDefs.map((i) => i.name));

    for (const u of units) {
      const entry = classification.manifest.units[u.basename];
      if (!entry || !entry.expected_objects) continue;
      const tables = entry.expected_objects.tables || [];
      const indexes = entry.expected_objects.indexes || [];

      if (tables.length > 0) {
        const { rows: liveChecks } = await client.query(
          `SELECT c.relname AS table, con.conname
             FROM pg_constraint con
             JOIN pg_class c ON c.oid = con.conrelid
             JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
            WHERE con.contype = 'c' AND c.relname = ANY($1::text[])`,
          [tables]
        );
        for (const r of liveChecks) {
          assertTrue(
            coveredCheckTables.has(r.table),
            `CT11: live CHECK "${r.conname}" on table "${r.table}" (in ${u.basename}'s expected_objects.tables) has NO expected_checks manifest entry — a CHECK added to DDL without a manifest entry must fail this test`
          );
        }
      }
      for (const idxName of indexes) {
        assertTrue(
          coveredIndexNames.has(idxName),
          `CT11: expected_objects index "${idxName}" (${u.basename}) has NO expected_index_defs manifest entry — an index added to expected_objects.indexes without a matching expected_index_defs entry must fail this test`
        );
      }
    }
    // Reverse direction: every expected_index_defs entry this PR's manifest
    // names is one the fresh DB actually has (no phantom entry slipped
    // through as "populated" but absent).
    const { rows: liveIdx } = await client.query(
      `SELECT indexname FROM pg_indexes WHERE schemaname='public' AND indexname = ANY($1::text[])`,
      [[...coveredIndexNames]]
    );
    assertEqual(liveIdx.length, coveredIndexNames.size, `CT11: every expected_index_defs entry name exists on the fresh DB — got ${liveIdx.length}/${coveredIndexNames.size}`);

    // A fresh, fully-applied DB classifies every populated kind present_matching.
    const probe = await adapter.probeFastPathSchemaState({
      tables: [...new Set([...expectedChecks.map((c) => c.table), ...handoffModule._collectExpectedUniques(classification.manifest, units).map((u2) => u2.table), ...handoffModule._collectExpectedNotNulls(classification.manifest, units).map((n) => n.table)])],
      columns: [], indexes: [...coveredIndexNames], shapeTargets: [],
    });
    const uniqResults = handoffModule._classifyExpectedUniques(handoffModule._collectExpectedUniques(classification.manifest, units), probe.tablesFound, probe.uniques);
    const nnResults = handoffModule._classifyExpectedNotNulls(handoffModule._collectExpectedNotNulls(classification.manifest, units), probe.tablesFound, probe.notNulls);
    const checkResults = handoffModule._classifyExpectedChecks(expectedChecks, probe.tablesFound, probe.checks);
    const idxResults = handoffModule._classifyExpectedIndexDefs(expectedIndexDefs, probe.indexDefs);
    for (const [kind, results] of [['unique', uniqResults], ['notnull', nnResults], ['check', checkResults], ['indexdef', idxResults]]) {
      const bad = results.filter((r) => r.state !== 'present_matching');
      assertEqual(bad.length, 0, `CT11: every ${kind} entry classifies present_matching on a fresh DB — got ${JSON.stringify(bad)}`);
    }

    await client.end();
    pass(label);
  } catch (err) {
    fail(label, err.message);
  } finally {
    await dropThrowawayDb(dbName);
  }
}

// ── PR #268 review fix: CHECK identity/drift/extra tests (CT12-CT14) ───────

function testCT12() {
  const label = 'CT12: _classifyExpectedChecks identity fix — a drifted expression on the SAME column set is present_mismatched(check_def_drift), never absent; a stale extra on the same identity is present_mismatched(extra_constraint)';
  try {
    const manifest = { units: { fake: { expected_checks: [
      { table: 'widgets', columns: ['qty'], expression_tokens: ['qty'], def: 'CHECK ((qty >= 0))' },
      { table: 'widgets', columns: ['sku'], expression_tokens: ['sku'], def: "CHECK ((sku <> ''::text))" },
    ] } } };
    const collected = handoffModule._collectExpectedChecks(manifest, [{ basename: 'fake' }]);
    const tablesFound = new Set(['widgets']);
    // qty: live CHECK on the SAME column but a DIFFERENT expression (drift).
    // sku: live CHECK matches identity-exactly PLUS a stale duplicate (extra).
    const liveChecks = [
      { table: 'widgets', conname: 'widgets_qty_drifted', columns: ['qty'], def: 'CHECK ((qty > 0))' },
      { table: 'widgets', conname: 'widgets_sku_check', columns: ['sku'], def: "CHECK ((sku <> ''::text))" },
      { table: 'widgets', conname: 'widgets_sku_stale', columns: ['sku'], def: "CHECK ((sku <> ''::text))" },
    ];
    const results = handoffModule._classifyExpectedChecks(collected, tablesFound, liveChecks);
    const byCol = {}; for (const r of results) byCol[r.columns[0]] = r;

    assertEqual(byCol['qty'].state, 'present_mismatched', 'CT12: a drifted expression on the identity-matching column classifies present_mismatched, NEVER absent');
    assertTrue(byCol['qty'].reason.startsWith('check_def_drift:'), `CT12: reason names check_def_drift — got ${byCol['qty'].reason}`);
    assertEqual(byCol['qty'].dropTargets.length, 1, 'CT12: dropTargets names the ONE stale drifted constraint to drop');

    assertEqual(byCol['sku'].state, 'present_mismatched', 'CT12: an identity-match PLUS a stale duplicate classifies present_mismatched (inventory diff)');
    assertTrue(byCol['sku'].reason.startsWith('extra_constraint:'), `CT12: reason names extra_constraint — got ${byCol['sku'].reason}`);
    assertEqual(byCol['sku'].dropTargets.length, 1, 'CT12: dropTargets names ONLY the stale extra, not the already-correct match');
    assertEqual(byCol['sku'].dropTargets[0].conname, 'widgets_sku_stale', 'CT12: the correct widgets_sku_check is NOT in dropTargets');

    pass(label);
  } catch (err) {
    fail(label, err.message);
  }
}

async function testCT13() {
  const label = 'CT13: a drifted CHECK (same column, different expression) heals — old constraint gone, new one present, one transaction';
  if (!(await isPgAvailable())) { skip(label, 'Postgres unavailable'); return; }
  const dbName = `cm185heal_ct13_${Date.now()}`;
  const PID = 'schema-heal-ct13';
  try {
    await createThrowawayDb(dbName);
    const client = await pgConnect(dbName);
    const { adapter } = await bootstrapCurrentDb(client, PID, { withExtension: false });

    // Drift the live authoring_mode CHECK to a DIFFERENT (but still valid
    // for existing rows) expression on the SAME column.
    const { rows: liveChk } = await client.query(
      `SELECT conname FROM pg_constraint WHERE conrelid='decisions'::regclass AND contype='c'`
    );
    const authoringConname = liveChk.find((r) => r.conname.includes('authoring_mode'));
    assertTrue(!!authoringConname, 'CT13 precondition: the live authoring_mode CHECK exists');
    await client.query(`ALTER TABLE decisions DROP CONSTRAINT "${authoringConname.conname}"`);
    await client.query(`ALTER TABLE decisions ADD CONSTRAINT decisions_authoring_mode_drifted CHECK (authoring_mode = ANY (ARRAY['caveman','verbose','legacy']))`);

    const result = await handoffModule.ensureSchemaCurrentCore(adapter, PID, { silent: true });
    assertTrue(result.reason === 'current' || result.reason === 'degraded', `CT13 sanity: got ${result.reason}`);

    const { rows: after } = await client.query(
      `SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conrelid='decisions'::regclass AND contype='c'`
    );
    assertEqual(after.length, 1, `CT13: exactly one CHECK remains on decisions.authoring_mode's column — got ${after.length}: ${JSON.stringify(after)}`);
    assertTrue(!after.some((r) => r.conname === 'decisions_authoring_mode_drifted'), 'CT13: the drifted constraint is GONE');
    assertTrue(after[0].def.includes("'legacy'") === false, 'CT13: the healed constraint is the canonical one (no legacy value)');

    await client.end();
    pass(label);
  } catch (err) {
    fail(label, err.message);
  } finally {
    await dropThrowawayDb(dbName);
  }
}

async function testCT14() {
  const label = 'CT14: a CHECK heal that would reject live violating rows fails CLOSED — rollback, prior (drifted) constraint retained, DEGRADED names the SQLSTATE';
  if (!(await isPgAvailable())) { skip(label, 'Postgres unavailable'); return; }
  const dbName = `cm185heal_ct14_${Date.now()}`;
  const PID = 'schema-heal-ct14';
  try {
    await createThrowawayDb(dbName);
    const client = await pgConnect(dbName);
    const { adapter } = await bootstrapCurrentDb(client, PID, { withExtension: false });

    const { rows: liveChk } = await client.query(
      `SELECT conname FROM pg_constraint WHERE conrelid='decisions'::regclass AND contype='c'`
    );
    const authoringConname = liveChk.find((r) => r.conname.includes('authoring_mode'));
    await client.query(`ALTER TABLE decisions DROP CONSTRAINT "${authoringConname.conname}"`);
    // A permissive drifted CHECK that allows a value the canonical CHECK
    // (caveman|verbose only) rejects, then a live row using that value —
    // the heal's ADD CONSTRAINT must fail against this row.
    await client.query(`ALTER TABLE decisions ADD CONSTRAINT decisions_authoring_mode_permissive CHECK (authoring_mode IS NOT NULL)`);
    await client.query(
      `INSERT INTO decisions (project_id, topic, decision, authoring_mode) VALUES ('ct14', 'topic1', 'dec1', 'legacy_bad_value')`
    );

    const fixable = [{
      unit: 'u', table: 'decisions', columns: ['authoring_mode'],
      def: "CHECK ((authoring_mode = ANY (ARRAY['caveman'::text, 'verbose'::text])))",
      state: 'present_mismatched', reason: 'check_def_drift:decisions_authoring_mode_permissive',
      dropTargets: [{ conname: 'decisions_authoring_mode_permissive' }],
    }];
    const healOutcome = await handoffModule._healExpectedChecks(adapter, PID, fixable);
    assertFalse(healOutcome.ok, 'CT14: heal must fail (a live row violates the corrective CHECK)');
    assertTrue(!!healOutcome.sqlstate, `CT14: a SQLSTATE is reported — got ${JSON.stringify(healOutcome)}`);

    const { rows: after } = await client.query(
      `SELECT conname FROM pg_constraint WHERE conrelid='decisions'::regclass AND contype='c'`
    );
    assertEqual(after.length, 1, 'CT14: exactly one CHECK remains — the ROLLED-BACK heal left it exactly as it was');
    assertEqual(after[0].conname, 'decisions_authoring_mode_permissive', 'CT14: the prior (drifted/permissive) constraint is retained, not silently dropped');
    const { rows: stillThere } = await client.query(`SELECT 1 FROM decisions WHERE project_id='ct14' AND authoring_mode='legacy_bad_value'`);
    assertEqual(stillThere.length, 1, 'CT14: the violating row is untouched');

    await client.end();
    pass(label);
  } catch (err) {
    fail(label, err.message);
  } finally {
    await dropThrowawayDb(dbName);
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('=== test-schema-heal.js (cm#185-schema-heal: S1-S5 + adversary findings #1-#10) ===');
  testT7();
  testT13();
  testT14();
  testT17();
  await testT16();
  await testT1();
  await testT2();
  await testT3();
  await testT4();
  await testT5();
  await testT6();
  await testT8();
  await testT9();
  await testT10();
  await testT11();
  await testT12();
  await testT15();

  await testFKT1();
  testFKT2();
  await testFKT3();
  await testFKT4();
  await testFKT5();
  await testFKT6();
  await testFKT7();

  testCT1();
  testCT2();
  testCT3();
  testCT4();
  testCT5();
  await testCT6();
  await testCT7();
  await testCT8();
  await testCT9();
  await testCT10();
  await testCT11();
  testCT12();
  await testCT13();
  await testCT14();

  console.log('');
  console.log(`Results: ${passed} passed, ${failed} failed, ${skipped} skipped`);
  if (failures.length > 0) {
    console.log('\nFailures:');
    for (const f of failures) console.log(`  FAIL  ${f.label}: ${f.reason}`);
    process.exit(1);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error('Unexpected error:', err.stack || err.message);
  process.exit(1);
});
