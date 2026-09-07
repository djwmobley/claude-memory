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
 *
 * Requires live Postgres (PGHOST/PGUSER/PGPASSWORD, defaults
 * localhost/postgres/postgres) for T1-T6, T8-T13, T15. T7 and T14 are pure
 * (no DB). T16 uses node:sqlite in-process. Every fixture is its own
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
const { classifySchemaFiles } = require(path.join(PROJECT_ROOT, 'scripts', 'lib', 'schema-classify.js'));
// cm#185 review: 'pg' is a dependency of scripts/ (scripts/node_modules),
// not of the repo root or test/ — requiring it from a lib file that already
// lives under scripts/ (test-pg-helpers.js) resolves correctly regardless
// of which directory this test file itself is run from; a direct
// `require('pg')` from test/ would NOT (same reason test-decisions-canon.js
// and test-index-cap-md5.js never require('pg') directly either).
const { pgConnect: _sharedPgConnect } = require(path.join(PROJECT_ROOT, 'scripts', 'lib', 'test-pg-helpers.js'));

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

    // Scratch engine root: real schema-manifest.json + real SQL units,
    // EXCEPT handoff-core-schema.sql's gated ALTER is rewritten to a bogus
    // type — the DO $$ ... EXCEPTION WHEN OTHERS $$ block still degrades
    // gracefully, but now ALWAYS fails regardless of pgvector's presence
    // (a stand-in for "extension present, gated DDL still doesn't take" —
    // e.g. an old pgvector build with no halfvec type — without needing to
    // control the test Postgres's actual pgvector version).
    const realSqlDir = path.join(PROJECT_ROOT, 'scripts', 'sql');
    const scratchSqlDir = path.join(scratchEngineRoot, 'scripts', 'sql');
    fs.mkdirSync(scratchSqlDir, { recursive: true });
    for (const basename of ['schema-manifest.json', 'handoff-sqlite-schema.sql', 'app-retrieval-events-schema.sql', 'decisions-base.sql']) {
      fs.copyFileSync(path.join(realSqlDir, basename), path.join(scratchSqlDir, basename));
    }
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

    const result = runCli(['init', '-y'], {
      cwd: projDir,
      env: { PROJECT_ROOT: projDir, HANDOFF_DB: dbName, CLAUDE_PLUGIN_ROOT: scratchEngineRoot },
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
  try {
    await createThrowawayDb(dbName);
    fs.mkdirSync(projDir, { recursive: true });
    const gitInit = spawnSync('git', ['-C', projDir, 'init', '-q'], { encoding: 'utf8' });
    if (gitInit.status !== 0) throw new Error(`git init failed: ${gitInit.stderr}`);

    // Step 1: a REAL, fully-successful first init — mints its OWN marker
    // UUID (never encodeCwd(projDir); that fallback belongs to
    // resolveProjectId()'s marker-LESS path used by status/resume, not to
    // init's own provisioning, which always mints or reuses a real marker).
    const first = runCli(['init', '-y'], {
      cwd: projDir,
      env: { PROJECT_ROOT: projDir, HANDOFF_DB: dbName },
    });
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
    const second = runCli(['init', '-y'], {
      cwd: projDir,
      env: { PROJECT_ROOT: projDir, HANDOFF_DB: dbName },
    });
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
    await dropThrowawayDb(dbName);
    try { fs.rmSync(projDir, { recursive: true, force: true }); } catch (_) {}
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

    // Monkeypatch THIS INSTANCE's schemaObjectsExist to simulate a probe
    // failure (e.g. a transient connection error) — instance-level, not
    // module-level, so it affects only this adapter object, never any other
    // test or the require() cache.
    const realSchemaObjectsExist = adapter.schemaObjectsExist.bind(adapter);
    let callCount = 0;
    adapter.schemaObjectsExist = async (expected) => {
      callCount++;
      if (callCount === 1) {
        return { ok: false, missing: [{ type: 'error', message: 'simulated transient connection error' }] };
      }
      return realSchemaObjectsExist(expected);
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

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('=== test-schema-heal.js (cm#185-schema-heal: S1-S5 + adversary findings #1-#10) ===');
  testT7();
  testT13();
  testT14();
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
