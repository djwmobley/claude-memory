'use strict';

/**
 * test-embed-heal.js — embed-heal-on-touch categorical fix (scripts/lib/embed-heal.js).
 *
 * Covers the spec's E5 test list:
 *   T1  NULL rows + READY provider -> healed, embedded count matches, rows
 *       actually carry a non-NULL embedding + embedded_by_provider_id after.
 *   T2  batch bound respected — embed_heal_batch smaller than the backlog
 *       leaves `remaining > 0` and reports 'partial'.
 *   T3  disabled via project_settings.embed_heal_batch = 0 — rows untouched,
 *       outcome 'disabled'.
 *   T4  provider down (no default provider row) -> 'provider_unready', rows
 *       untouched, and — critically — the CALLER (ensureSchemaCurrent) exit
 *       code/return contract is completely unaffected by this failure.
 *   T5  concurrent touch (two separate connections racing the SAME backlog)
 *       -> no double embed: the sum of BOTH calls' `embedded` never exceeds
 *       the true backlog, and a fresh COUNT after both settle shows every
 *       row embedded exactly once (never re-embedded).
 *   T6  status line rendering — `handoff.js status --json` on a READY
 *       project with a backlog reports `embedding_readiness: "READY"` +
 *       nonzero `embedding_null_counts`, and the prose form's `embedding:`
 *       line contains "backlog" (never a bare "READY").
 *   T7  MCP write path (entity-graph-crud.js assertionUpdate) embeds the
 *       superseding row at write time — the live-observed pipeline_judge
 *       gap this PR closes.
 *
 * Requires Postgres with pgvector (PGHOST/PGUSER/PGPASSWORD, defaults
 * localhost/postgres/postgres) — every test SKIPs cleanly if unavailable.
 * A DEDICATED throwaway DB is created and dropped per run; never touches
 * eval_test/pipeline_judge/pipeline_pwa_etl. Exit 0 = all run tests passed.
 */

const path = require('path');
const { Client } = require('pg');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const handoffModule = require(path.join(PROJECT_ROOT, 'scripts', 'handoff.js'));
const { PostgresAdapter } = require(path.join(PROJECT_ROOT, 'scripts', 'lib', 'db-seam.js'));
const entityCrudLib = require(path.join(PROJECT_ROOT, 'scripts', 'lib', 'entity-graph-crud.js'));
const { runEmbedHealIfNeeded } = require(path.join(PROJECT_ROOT, 'scripts', 'lib', 'embed-heal.js'));
const { ensureVectorExtension, startFakeEmbedServerProcess, applySchema } = require(path.join(PROJECT_ROOT, 'scripts', 'lib', 'test-pg-helpers.js'));

let passed = 0, failed = 0;
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

const DB_NAME = `cm_embedheal_${Date.now()}`;
const PID = 'embed-heal-test-project';

async function setUpSharedDb() {
  const sys = await pgConnect('postgres');
  try {
    await sys.query(`DROP DATABASE IF EXISTS "${DB_NAME}"`);
    await sys.query(`CREATE DATABASE "${DB_NAME}"`);
  } finally {
    await sys.end();
  }
  await ensureVectorExtension(DB_NAME);
  // ensureSchemaCurrent's own fingerprint check assumes project_settings
  // (and the rest of core) already exists — same aged-DB-fixture pattern
  // test-schema-bring-forward.js's T1 uses: apply core schema RAW once,
  // then let the real ensureSchemaCurrent bring the rest of the manifest
  // (decisions-base.sql, embedding_providers, etc.) forward via its normal
  // 'absent'-fingerprint apply path.
  await applySchema(DB_NAME);
  const raw = await pgConnect(DB_NAME);
  const adapter = new PostgresAdapter(raw);
  const result = await handoffModule.ensureSchemaCurrent(adapter, PID, { silent: true });
  assertTrue(result.applied === true || result.reason === 'current' || result.reason === 'applied',
    `expected schema apply to succeed, got ${JSON.stringify(result)}`);
  return { raw, adapter };
}

async function tearDownSharedDb(raw) {
  try { await raw.end(); } catch (_) {}
  try {
    const sys = await pgConnect('postgres');
    await sys.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()`, [DB_NAME]);
    await sys.query(`DROP DATABASE IF EXISTS "${DB_NAME}"`);
    await sys.end();
  } catch (_) { /* best-effort */ }
}

async function seedNullAssertions(raw, projectId, n, subjectPrefix) {
  for (let i = 0; i < n; i++) {
    await raw.query(
      `INSERT INTO assertions (project_id, subject, predicate, object, confidence, source)
       VALUES ($1, $2, 'chose', 'value', 5, 'user_stated')`,
      [projectId, `${subjectPrefix}-${i}`]
    );
  }
}

async function nullCount(raw, projectId, subjectPrefix) {
  const { rows } = await raw.query(
    `SELECT COUNT(*) AS n FROM assertions WHERE project_id = $1 AND subject LIKE $2 AND embedding IS NULL`,
    [projectId, `${subjectPrefix}-%`]
  );
  return parseInt(rows[0].n, 10);
}

// Never DELETE embedding_providers rows — assertions.embedded_by_provider_id
// is an FK to this table, and earlier tests' already-embedded rows may
// reference an existing row. Upsert-by-name + toggle is_default instead
// (embedding_providers_is_default_unique_idx allows only one true row).
async function seedProvider(raw, endpoint, nativeDims, storedDims) {
  await raw.query(`UPDATE embedding_providers SET is_default = false WHERE is_default = true`);
  await raw.query(
    `INSERT INTO embedding_providers (name, model_label, native_dims, stored_dims, endpoint, is_default, data_egress_approved, data_egress_approved_by, data_egress_approved_at)
     VALUES ('test-provider', 'test/model', $1, $2, $3, true, true, 'test', now())
     ON CONFLICT (name) DO UPDATE SET
       model_label = EXCLUDED.model_label, native_dims = EXCLUDED.native_dims,
       stored_dims = EXCLUDED.stored_dims, endpoint = EXCLUDED.endpoint, is_default = true`,
    [nativeDims, storedDims, endpoint]
  );
}

async function clearProvider(raw) {
  await raw.query(`UPDATE embedding_providers SET is_default = false WHERE is_default = true`);
}

async function setBatch(raw, projectId, value) {
  await raw.query(
    `INSERT INTO project_settings (project_id, key, value) VALUES ($1, 'embed_heal_batch', $2)
     ON CONFLICT (project_id, key) DO UPDATE SET value = EXCLUDED.value`,
    [projectId, String(value)]
  );
}

async function clearBatchSetting(raw, projectId) {
  await raw.query(`DELETE FROM project_settings WHERE project_id = $1 AND key = 'embed_heal_batch'`, [projectId]);
}

async function main() {
  if (!(await isPgAvailable())) {
    console.log('SKIP  all embed-heal tests (Postgres unavailable)');
    console.log('\nDone: test-embed-heal.js — 0 passed, 0 failed (skipped)');
    return;
  }

  const { raw, adapter } = await setUpSharedDb();
  let fakeServer = null;

  try {
    fakeServer = await startFakeEmbedServerProcess(4096, 0.1);
    const endpoint = `http://127.0.0.1:${fakeServer.port}/v1/embeddings`;

    // ── T1: NULL rows + READY provider -> healed ──────────────────────────
    try {
      const label = 'T1: NULL rows + READY provider -> healed, rows actually embedded';
      await clearBatchSetting(raw, PID);
      await seedProvider(raw, endpoint, 4096, 4000);
      await seedNullAssertions(raw, PID, 5, 't1');
      const before = await nullCount(raw, PID, 't1');
      assertEqual(before, 5, 'expected 5 seeded NULL rows');
      const result = await runEmbedHealIfNeeded(adapter, PID, { silent: true });
      assertEqual(result.outcome, 'healed', `expected healed, got ${JSON.stringify(result)}`);
      assertTrue(result.embedded >= 5, `expected >=5 embedded, got ${result.embedded}`);
      const after = await nullCount(raw, PID, 't1');
      assertEqual(after, 0, 'expected all t1 rows embedded');
      pass(label);
    } catch (err) { fail('T1', err.message); }

    // ── T2: batch bound respected ──────────────────────────────────────────
    try {
      const label = 'T2: embed_heal_batch smaller than backlog -> partial, remaining > 0';
      await setBatch(raw, PID, 2);
      await seedNullAssertions(raw, PID, 6, 't2');
      const result = await runEmbedHealIfNeeded(adapter, PID, { silent: true });
      assertEqual(result.embedded, 2, `expected exactly 2 embedded (batch bound), got ${result.embedded}`);
      assertTrue(result.remaining > 0, `expected remaining > 0, got ${result.remaining}`);
      assertEqual(result.outcome, 'partial', `expected partial, got ${result.outcome}`);
      // Drain the rest so it doesn't bleed into later tests' counts.
      await setBatch(raw, PID, 250);
      await runEmbedHealIfNeeded(adapter, PID, { silent: true });
      const after = await nullCount(raw, PID, 't2');
      assertEqual(after, 0, 'expected t2 backlog fully drained after raising the batch back up');
      pass(label);
    } catch (err) { fail('T2', err.message); }

    // ── T3: disabled via embed_heal_batch=0 ────────────────────────────────
    try {
      const label = 'T3: embed_heal_batch=0 -> disabled, rows untouched';
      await setBatch(raw, PID, 0);
      await seedNullAssertions(raw, PID, 3, 't3');
      const result = await runEmbedHealIfNeeded(adapter, PID, { silent: true });
      assertEqual(result.outcome, 'disabled', `expected disabled, got ${JSON.stringify(result)}`);
      assertEqual(result.embedded, 0, 'expected 0 embedded while disabled');
      const after = await nullCount(raw, PID, 't3');
      assertEqual(after, 3, 'expected all 3 t3 rows still NULL while disabled');
      await clearBatchSetting(raw, PID);
      pass(label);
    } catch (err) { fail('T3', err.message); }

    // ── T4: provider down -> provider_unready, exit code/contract unaffected ──
    try {
      const label = 'T4: no default provider -> provider_unready, rows untouched, ensureSchemaCurrent contract unaffected';
      await clearProvider(raw);
      await seedNullAssertions(raw, PID, 2, 't4');
      const result = await runEmbedHealIfNeeded(adapter, PID, { silent: true });
      assertEqual(result.outcome, 'provider_unready', `expected provider_unready, got ${JSON.stringify(result)}`);
      const after = await nullCount(raw, PID, 't4');
      assertEqual(after, 2, 'expected t4 rows untouched while provider is down');
      // The touch path itself must never throw or change its own return contract.
      const schemaResult = await handoffModule.ensureSchemaCurrent(adapter, PID, { silent: true });
      assertTrue(schemaResult.reason === 'current' || schemaResult.reason === 'applied',
        `expected ensureSchemaCurrent to still report current/applied despite embed-heal failure, got ${JSON.stringify(schemaResult)}`);
      pass(label);
    } catch (err) { fail('T4', err.message); }

    // ── T5: concurrent touch -> no double embed ────────────────────────────
    try {
      const label = 'T5: concurrent touch (2 connections) -> no double embed';
      await seedProvider(raw, endpoint, 4096, 4000);
      await seedNullAssertions(raw, PID, 8, 't5');
      // Total actionable backlog at race start — includes leftovers this
      // suite deliberately left NULL earlier (T3's disabled-batch rows,
      // T4's provider-down rows), not just this test's own 8 seeded rows.
      // The invariant under test is "never re-embed an already-embedded
      // row", not "only this test's own rows exist".
      const { rows: backlogRows } = await raw.query(
        `SELECT COUNT(*) AS n FROM assertions WHERE project_id = $1 AND embedding IS NULL AND trim(coalesce(subject,'')) <> ''`,
        [PID]
      );
      const totalBacklogAtStart = parseInt(backlogRows[0].n, 10);
      const rawA = await pgConnect(DB_NAME);
      const rawB = await pgConnect(DB_NAME);
      const adapterA = new PostgresAdapter(rawA);
      const adapterB = new PostgresAdapter(rawB);
      const [resA, resB] = await Promise.all([
        runEmbedHealIfNeeded(adapterA, PID, { silent: true }),
        runEmbedHealIfNeeded(adapterB, PID, { silent: true }),
      ]);
      await rawA.end();
      await rawB.end();
      const totalEmbedded = resA.embedded + resB.embedded;
      assertTrue(totalEmbedded <= totalBacklogAtStart,
        `expected combined embedded <= backlog-at-start (${totalBacklogAtStart}) (no double-embed), got ${totalEmbedded} (A=${JSON.stringify(resA)}, B=${JSON.stringify(resB)})`);
      // One of the two must have lost the non-blocking lock race and skipped
      // (or both partially drained sequentially) — either way the backlog
      // converges to 0 after a final drain, never double-processed.
      const finalResult = await runEmbedHealIfNeeded(adapter, PID, { silent: true });
      const after = await nullCount(raw, PID, 't5');
      assertEqual(after, 0, `expected t5 backlog fully drained, final=${JSON.stringify(finalResult)}`);
      pass(label);
    } catch (err) { fail('T5', err.message); }

    // ── T6: embedding_readiness reflects live HEALING(n)->READY (E1/E3 owner
    //    directive "READY should mean fully embedded" — supersedes the old
    //    "READY (backlog N)" print-time override this test used to assert) ──
    try {
      const label = 'T6: embedding_readiness is HEALING(n) with a live backlog, READY only once drained';
      await seedProvider(raw, endpoint, 4096, 4000);
      await setBatch(raw, PID, 1); // deliberately small so a backlog persists after one heal touch
      await seedNullAssertions(raw, PID, 4, 't6');
      const beforeReadiness = await handoffModule.computeEmbeddingReadiness(adapter, PID, {});
      assertEqual(beforeReadiness, 'HEALING(4)', `expected HEALING(4) before heal, got ${beforeReadiness}`);
      const healResult = await runEmbedHealIfNeeded(adapter, PID, { silent: true });
      assertEqual(healResult.embedded, 1, `expected exactly 1 row healed (batch=1), got ${JSON.stringify(healResult)}`);
      const afterOneTouch = await handoffModule.computeEmbeddingReadiness(adapter, PID, {});
      assertEqual(afterOneTouch, 'HEALING(3)', `expected HEALING(3) after one heal touch, got ${afterOneTouch}`);
      const nullCounts = await handoffModule.computeEmbeddingNullCounts(adapter, PID);
      assertTrue(nullCounts.assertions === 3, `expected exactly 3 remaining assertions NULL count, got ${nullCounts.assertions}`);
      // Drain fully and confirm the classifier converges to READY.
      await setBatch(raw, PID, 250);
      await runEmbedHealIfNeeded(adapter, PID, { silent: true });
      const finalReadiness = await handoffModule.computeEmbeddingReadiness(adapter, PID, {});
      assertEqual(finalReadiness, 'READY', `expected READY after full drain, got ${finalReadiness}`);
      pass(label);
    } catch (err) { fail('T6', err.message); }

    // ── T8: opt-out with a live backlog -> classifier DISABLED, heal is a
    //    no-op (E4/E5) ───────────────────────────────────────────────────────
    try {
      const label = 'T8: embeddings_opt_out -> DISABLED (never HEALING/READY) and embed-heal touches nothing';
      await raw.query(
        `INSERT INTO project_settings (project_id, key, value) VALUES ($1, 'embeddings_opt_out', 'true')
         ON CONFLICT (project_id, key) DO NOTHING`,
        [PID]
      );
      await setBatch(raw, PID, 250);
      await seedNullAssertions(raw, PID, 3, 't8');
      const readiness = await handoffModule.computeEmbeddingReadiness(adapter, PID, {});
      assertEqual(readiness, 'DISABLED', `expected DISABLED, got ${readiness}`);
      const healResult = await runEmbedHealIfNeeded(adapter, PID, { silent: true });
      assertEqual(healResult.outcome, 'disabled', `expected heal outcome disabled, got ${JSON.stringify(healResult)}`);
      const after = await nullCount(raw, PID, 't8');
      assertEqual(after, 3, 'expected t8 rows untouched — opt-out heal must be a total no-op');
      await raw.query(`DELETE FROM project_settings WHERE project_id = $1 AND key = 'embeddings_opt_out'`, [PID]);
      // Drain t8's rows so they don't bleed into later assertions.
      await runEmbedHealIfNeeded(adapter, PID, { silent: true });
      pass(label);
    } catch (err) { fail('T8', err.message); }

    // ── T7: MCP assertionUpdate embeds at write time ────────────────────────
    try {
      const label = 'T7: entity-graph-crud.assertionUpdate embeds the new (superseding) row at write time';
      await seedProvider(raw, endpoint, 4096, 4000);
      await raw.query(
        `INSERT INTO assertions (project_id, subject, predicate, object, confidence, source)
         VALUES ($1, 't7-subject', 'chose', 'old-value', 5, 'user_stated') RETURNING id`,
        [PID]
      );
      const created = await entityCrudLib.assertionCreate(adapter, {
        projectId: PID, subject: 't7-subject-2', predicate: 'chose', object: 'v1',
        confidence: 5, source: 'user_stated',
      });
      const updateResult = await entityCrudLib.assertionUpdate(adapter, {
        projectId: PID, id: created.row.id, predicate: 'chose', newObject: 'v2', source: 'user_stated',
      });
      const { rows } = await raw.query(
        `SELECT embedding IS NOT NULL AS has_embedding, embedded_by_provider_id FROM assertions WHERE id = $1`,
        [updateResult.newRow.id]
      );
      assertTrue(rows[0].has_embedding === true, 'expected the superseding row from assertionUpdate to carry a non-NULL embedding');
      assertTrue(rows[0].embedded_by_provider_id !== null, 'expected embedded_by_provider_id to be stamped');
      pass(label);
    } catch (err) { fail('T7', err.message); }

    // ── T9: suppressed rows never count; empty-text NULLs never count
    //    (E2/E5) — both are excluded from n, empty-text surfaced separately
    //    as unembeddableEmptyText, and a zero-backlog project is READY even
    //    with suppressed/empty-text NULL rows sitting untouched. ──────────
    try {
      const label = 'T9: suppressed rows and empty-text NULLs never inflate the backlog; READY once genuine backlog is 0';
      await seedProvider(raw, endpoint, 4096, 4000);
      await setBatch(raw, PID, 250);
      // Drain any leftovers from earlier tests first so this test's counts are exact.
      await runEmbedHealIfNeeded(adapter, PID, { silent: true });
      const baseline = await handoffModule.computeEmbeddingReadiness(adapter, PID, {});
      assertEqual(baseline, 'READY', `expected READY baseline before seeding t9 rows, got ${baseline}`);

      // Suppressed row — must never count toward the backlog.
      await raw.query(
        `INSERT INTO assertions (project_id, subject, predicate, object, confidence, source, suppressed)
         VALUES ($1, 't9-suppressed', 'chose', 'value', 5, 'user_stated', true)`,
        [PID]
      );
      // Empty-text row (subject is NULL/blank) — must never count toward the
      // backlog either, but IS surfaced via unembeddableEmptyText.
      await raw.query(
        `INSERT INTO assertions (project_id, subject, predicate, object, confidence, source)
         VALUES ($1, '', 'chose', 'value', 5, 'user_stated')`,
        [PID]
      );
      const readinessAfterSeed = await handoffModule.computeEmbeddingReadiness(adapter, PID, {});
      assertEqual(readinessAfterSeed, 'READY', `expected READY (suppressed + empty-text NULLs never block READY), got ${readinessAfterSeed}`);
      const nullCounts = await handoffModule.computeEmbeddingNullCounts(adapter, PID);
      assertEqual(nullCounts.assertions, 0, `expected 0 live+actionable assertions NULL count, got ${nullCounts.assertions}`);
      assertTrue(nullCounts.unembeddableEmptyText.assertions >= 1, `expected >=1 empty-text NULL surfaced, got ${nullCounts.unembeddableEmptyText.assertions}`);

      // A genuine actionable row DOES flip readiness -> HEALING (E5:
      // "READY -> HEALING after an un-embedded write").
      await raw.query(
        `INSERT INTO assertions (project_id, subject, predicate, object, confidence, source)
         VALUES ($1, 't9-actionable', 'chose', 'value', 5, 'user_stated')`,
        [PID]
      );
      const readinessAfterWrite = await handoffModule.computeEmbeddingReadiness(adapter, PID, {});
      assertEqual(readinessAfterWrite, 'HEALING(1)', `expected HEALING(1) after an un-embedded write, got ${readinessAfterWrite}`);
      await runEmbedHealIfNeeded(adapter, PID, { silent: true });
      pass(label);
    } catch (err) { fail('T9', err.message); }

    // ── T10: probe cache key includes projectId + endpoint (PR #273 review
    //    gap — was keyed on providerId alone) ────────────────────────────
    try {
      const label = 'T10: probe cache is keyed by projectId+providerId+endpoint — no cross-project/endpoint reuse';
      await seedProvider(raw, endpoint, 4096, 4000);
      const { rows: provRows } = await raw.query(`SELECT * FROM embedding_providers WHERE name = 'test-provider'`);
      const providerRow = provRows[0];
      handoffModule._embedProbeCache.clear();

      await handoffModule._cachedProbeProvider('t10-project-a', providerRow);
      assertEqual(handoffModule._embedProbeCache.size, 1, 'expected exactly 1 cache entry after the first project probes');

      // Same providerId, DIFFERENT projectId -> must NOT reuse the same entry.
      await handoffModule._cachedProbeProvider('t10-project-b', providerRow);
      assertEqual(handoffModule._embedProbeCache.size, 2, 'expected a SEPARATE cache entry for a second project sharing the same providerId');

      // Same projectId+providerId, DIFFERENT endpoint (in-place row edit) -> must NOT reuse either.
      const editedRow = { ...providerRow, endpoint: endpoint + '?edited=1' };
      await handoffModule._cachedProbeProvider('t10-project-a', editedRow);
      assertEqual(handoffModule._embedProbeCache.size, 3, 'expected a changed endpoint to bust the cache (new entry), not reuse the stale one');

      pass(label);
    } catch (err) { fail('T10', err.message); }

  } finally {
    if (fakeServer) { try { fakeServer.stop(); } catch (_) {} }
    await tearDownSharedDb(raw);
  }

  console.log(`\nDone: test-embed-heal.js — ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.log('\nFailures:');
    for (const f of failures) console.log(`  - ${f.label}: ${f.reason}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
