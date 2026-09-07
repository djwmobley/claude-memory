'use strict';

/**
 * test-init-embeddability.js — init-embeddability spec (categorical fix for
 * "fresh handoff:init leaves a project un-embeddable, silently").
 *
 * Covers the spec's named Tests section (T1-T8) plus one regression test
 * per accepted adversary finding (AF1-AF9, matching the finding numbers in
 * the adversary-pass doc). Every test creates/drops its own scratch
 * database and temp project directory; NONE touch claude_memory_eval_test,
 * pipeline_pwa_etl, or any other shared/live database.
 *
 * Usage: node test/test-init-embeddability.js
 * Requires: live Postgres at PGHOST/PGUSER/PGPASSWORD (CI env, or
 * localhost/postgres/postgres). T1 additionally creates and drops a
 * throwaway low-privilege ROLE (never touches any pre-existing role).
 * Exit 0 = all pass; nonzero = any failure.
 */

const { spawnSync } = require('child_process');
const fs   = require('fs');
const os   = require('os');
const path = require('path');
const http = require('http');

const PROJECT_ROOT   = path.resolve(__dirname, '..');
const HANDOFF_SCRIPT = path.join(PROJECT_ROOT, 'scripts', 'handoff.js');
const TS = Date.now();

const { pgConnect } = require(path.join(PROJECT_ROOT, 'scripts', 'lib', 'test-pg-helpers.js'));
const { MARKER_FILENAME } = require(path.join(PROJECT_ROOT, 'scripts', 'lib', 'project-marker.js'));
const { runBackfillEmbeddings } = require(path.join(PROJECT_ROOT, 'scripts', 'lib', 'backfill-embeddings.js'));
const { resolveDialect, createAdapter } = require(path.join(PROJECT_ROOT, 'scripts', 'lib', 'db-seam.js'));

let passed = 0, failed = 0;
const failures = [];
async function test(label, fn) {
  try {
    await fn();
    console.log(`  [PASS] ${label}`);
    passed++;
  } catch (err) {
    console.error(`  [FAIL] ${label}: ${err.message}`);
    failures.push({ label, err });
    failed++;
  }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }
function assertEqual(a, b, msg) { if (a !== b) throw new Error(`${msg || 'assertEqual'} — expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); }

// ── Fixture helpers ────────────────────────────────────────────────────────

function makeTempDir(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `handoff-embeddability-${tag}-`));
  fs.mkdirSync(path.join(dir, '.git'));
  return dir;
}

function writePipelineYml(projectDir, { database, user, vllmEmbedUrl } = {}) {
  fs.mkdirSync(path.join(projectDir, '.claude'), { recursive: true });
  const lines = [
    'project:', '  name: handoff-embeddability-test', '',
    'knowledge:', '  tier: "postgres"', '  host: "localhost"', '  port: 5432',
  ];
  if (database) lines.push(`  database: "${database}"`);
  if (user) lines.push(`  user: "${user}"`);
  if (vllmEmbedUrl) lines.push(`  vllm_embed_url: "${vllmEmbedUrl}"`);
  fs.writeFileSync(path.join(projectDir, '.claude', 'pipeline.yml'), lines.join('\n') + '\n', 'utf8');
}

async function createRawDb(dbName) {
  const admin = await pgConnect('postgres');
  await admin.query(`CREATE DATABASE "${dbName}"`);
  await admin.end();
}

async function dropRawDb(dbName) {
  let admin;
  try {
    admin = await pgConnect('postgres');
    await admin.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
      [dbName]
    );
    await admin.query(`DROP DATABASE IF EXISTS "${dbName}"`);
  } catch (_) { /* best-effort */ } finally {
    if (admin) { try { await admin.end(); } catch (_) {} }
  }
}

function runCli(args, opts = {}) {
  return spawnSync(process.execPath, [HANDOFF_SCRIPT, ...args], {
    cwd: opts.cwd || PROJECT_ROOT,
    env: { ...process.env, ...opts.env },
    encoding: 'utf8',
    timeout: opts.timeout || 20000,
    input: opts.input,
  });
}

const HALFVEC_DIMS = 4000; // assertions.embedding is a FIXED halfvec(4000) column
function fakeVector(fillValue) {
  return new Array(HALFVEC_DIMS).fill(fillValue);
}
function fakeVectorLiteral(fillValue) {
  return `[${fakeVector(fillValue).join(',')}]`;
}

/**
 * startFakeEmbedServer — a minimal real HTTP server answering the vLLM
 * /v1/embeddings wire contract with a fixed-dimension vector. Used instead
 * of monkey-patching embedding-provider.js's exports: backfill-embeddings.js
 * destructures {resolveDefaultProvider, createProviderFromRow} at require
 * time, so reassigning the exported properties afterward has no effect on
 * its already-bound local references — a real (loopback-only) transport is
 * simpler and more faithful than fighting module-cache internals.
 */
function startFakeEmbedServer(vectorLength, fillValue = 0.5) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data: [{ embedding: new Array(vectorLength).fill(fillValue) }] }));
      });
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

async function seedDefaultProvider(dbName, { nativeDims = 8, storedDims = 4, endpoint = 'http://127.0.0.1:1' } = {}) {
  const db = await pgConnect(dbName);
  await db.query(
    `INSERT INTO embedding_providers (name, model_label, native_dims, stored_dims, endpoint, is_default, data_egress_approved)
     VALUES ('test-provider', 'test-model', $1, $2, $3, true, true)
     ON CONFLICT DO NOTHING`,
    [nativeDims, storedDims, endpoint]
  );
  const { rows } = await db.query(`SELECT id FROM embedding_providers WHERE name = 'test-provider'`);
  await db.end();
  return rows[0].id;
}

(async () => {
  // ─── T1: extension absent, role lacks CREATE privilege → BLOCK ──────────
  console.log('\n=== T1: extension absent + no privilege -> BLOCK, exit 1, no marker ===');
  await test('T1: extension absent, role lacks CREATE privilege -> BLOCK exit 1, no marker, exact remedy string', async () => {
    const dbName    = `handoff_embed_t1_${TS}`;
    const roleName  = `handoff_nopriv_${TS}`;
    const rolePass  = 'testpass123x';
    const projectDir = makeTempDir('t1');
    await createRawDb(dbName);
    const admin = await pgConnect('postgres');
    try {
      await admin.query(`DROP ROLE IF EXISTS "${roleName}"`);
      await admin.query(`CREATE ROLE "${roleName}" LOGIN PASSWORD '${rolePass}'`);
      await admin.query(`GRANT CONNECT ON DATABASE "${dbName}" TO "${roleName}"`);
      await admin.query(`REVOKE CREATE ON DATABASE "${dbName}" FROM PUBLIC`);
      await admin.query(`REVOKE ALL ON DATABASE "${dbName}" FROM "${roleName}"`);
      await admin.query(`GRANT CONNECT ON DATABASE "${dbName}" TO "${roleName}"`);
    } finally {
      await admin.end();
    }
    writePipelineYml(projectDir, { database: dbName, user: roleName });
    try {
      const r = runCli(['init', '-y'], {
        cwd: projectDir,
        env: { PROJECT_ROOT: projectDir, PGPASSWORD: rolePass, HANDOFF_DB: undefined },
      });
      const out = (r.stdout || '') + (r.stderr || '');
      assertEqual(r.status, 1, `expected exit 1, got ${r.status}. Output:\n${out.slice(0, 800)}`);
      assert(out.includes('CREATE EXTENSION vector'), `expected the exact remedy command in output:\n${out.slice(0, 800)}`);
      assert(out.includes(dbName), `expected the target DB name in the remedy, got:\n${out.slice(0, 800)}`);
      assert(!fs.existsSync(path.join(projectDir, MARKER_FILENAME)), 'no project marker must be written on BLOCK');
    } finally {
      const admin2 = await pgConnect('postgres');
      try {
        await admin2.query(`DROP OWNED BY "${roleName}"`).catch(() => {});
        await admin2.query(`DROP ROLE IF EXISTS "${roleName}"`);
      } finally { await admin2.end(); }
      await dropRawDb(dbName);
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  // ─── T2: extension present, no endpoint configured anywhere → BLOCK ──────
  console.log('\n=== T2: extension present, no endpoint -> BLOCK (distinct message from T1) ===');
  await test('T2: extension present, no endpoint configured -> BLOCK exit 1, distinguishable from T1', async () => {
    const dbName = `handoff_embed_t2_${TS}`;
    const projectDir = makeTempDir('t2');
    await createRawDb(dbName);
    const db = await pgConnect(dbName);
    await db.query('CREATE EXTENSION IF NOT EXISTS vector').catch(() => {});
    await db.end();
    writePipelineYml(projectDir, { database: dbName });
    try {
      const r = runCli(['init', '-y'], {
        cwd: projectDir,
        env: {
          PROJECT_ROOT: projectDir, HANDOFF_DB: undefined,
          VLLM_EMBED_URL: undefined,
          HANDOFF_BASE_DIR: makeTempDir('t2-base'), // isolate from any real ~/.claude/handoff-embed.json
        },
      });
      const out = (r.stdout || '') + (r.stderr || '');
      assertEqual(r.status, 1, `expected exit 1, got ${r.status}. Output:\n${out.slice(0, 800)}`);
      assert(!out.includes('CREATE EXTENSION vector'), `T2 must NOT report the extension remedy (extension is present) — got:\n${out.slice(0, 800)}`);
      assert(out.includes('no default embedding provider could be seeded'), `expected the no-endpoint BLOCK message, got:\n${out.slice(0, 800)}`);
      assert(!fs.existsSync(path.join(projectDir, MARKER_FILENAME)), 'no project marker must be written on BLOCK');
    } finally {
      await dropRawDb(dbName);
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  // ─── T3: user-scope handoff-embed.json (LOCAL) seeds the provider ────────
  console.log('\n=== T3: user-scope handoff-embed.json LOCAL url -> seeded, source logged ===');
  await test('T3: extension present, user-scope handoff-embed.json LOCAL url, no project/env config -> provider seeded, source=user_scope', async () => {
    const dbName = `handoff_embed_t3_${TS}`;
    const projectDir = makeTempDir('t3');
    const baseDir = makeTempDir('t3-base');
    await createRawDb(dbName);
    const db = await pgConnect(dbName);
    await db.query('CREATE EXTENSION IF NOT EXISTS vector').catch(() => {});
    await db.end();
    writePipelineYml(projectDir, { database: dbName }); // no vllm_embed_url
    fs.writeFileSync(path.join(baseDir, 'handoff-embed.json'), JSON.stringify({ vllm_embed_url: 'http://127.0.0.1:8800' }), 'utf8');
    try {
      const r = runCli(['init', '-y'], {
        cwd: projectDir,
        env: { PROJECT_ROOT: projectDir, HANDOFF_DB: undefined, VLLM_EMBED_URL: undefined, HANDOFF_BASE_DIR: baseDir },
      });
      const out = (r.stdout || '') + (r.stderr || '');
      assertEqual(r.status, 0, `expected exit 0, got ${r.status}. Output:\n${out.slice(0, 1200)}`);
      assert(out.includes('user_scope'), `expected source=user_scope logged, got:\n${out.slice(0, 1200)}`);
      const checkDb = await pgConnect(dbName);
      const { rows } = await checkDb.query(`SELECT endpoint FROM embedding_providers WHERE is_default = true`);
      await checkDb.end();
      assertEqual(rows.length, 1, 'exactly one default provider row expected');
      assertEqual(rows[0].endpoint, 'http://127.0.0.1:8800');
    } finally {
      await dropRawDb(dbName);
      fs.rmSync(projectDir, { recursive: true, force: true });
      fs.rmSync(baseDir, { recursive: true, force: true });
    }
  });

  // ─── T4: backfill-embeddings dry-run — writes nothing, correct counts ────
  console.log('\n=== T4: backfill-embeddings dry-run — no writes, correct counts ===');
  await test('T4: backfill-embeddings (no --apply) reports counts and writes nothing', async () => {
    const dbName = `handoff_embed_t4_${TS}`;
    await createRawDb(dbName);
    const db = await pgConnect(dbName);
    await db.query('CREATE EXTENSION IF NOT EXISTS vector').catch(() => {});
    const schemaSql = fs.readFileSync(path.join(PROJECT_ROOT, 'scripts', 'sql', 'handoff-core-schema.sql'), 'utf8');
    await db.query(schemaSql);
    const decisionsSql = fs.readFileSync(path.join(PROJECT_ROOT, 'scripts', 'sql', 'decisions-base.sql'), 'utf8');
    await db.query(decisionsSql);
    const projectId = 'test-project-t4';
    await db.query(
      `INSERT INTO assertions (project_id, subject, predicate, object, confidence, source, valid_at)
       VALUES ($1, 'null-subject-1', 'p', 'o', 5, 'user_stated', now()),
              ($1, '   ', 'p', 'o2', 5, 'user_stated', now())`, // second row: whitespace-only text (AF9 "no-embeddable-text" bucket)
      [projectId]
    );
    await db.query(
      `INSERT INTO decisions (project_id, topic, decision, reason) VALUES ($1, 'test-topic-1', 'a decision', 'a reason')`,
      [projectId]
    );
    const beforeCounts = await db.query(`SELECT COUNT(*) FILTER (WHERE embedding IS NULL) AS n FROM assertions WHERE project_id = $1`, [projectId]);
    await db.end();

    const adapter = await createAdapter('postgres', { host: 'localhost', port: 5432, database: dbName, user: 'postgres' });
    try {
      const result = await runBackfillEmbeddings({ db: adapter, projectId, table: 'all', apply: false });
      assertEqual(result.ok, true);
      assertEqual(result.dryRun, true);
      const assertionsRow = result.tables.find((t) => t.table === 'assertions');
      assertEqual(assertionsRow.actionableNull, 1, 'exactly 1 actionable NULL row (the whitespace-only one is excluded)');
      assertEqual(assertionsRow.noTextNull, 1, 'exactly 1 no-embeddable-text row');
      const decisionsRow = result.tables.find((t) => t.table === 'decisions');
      assertEqual(decisionsRow.actionableNull, 1);

      // No writes at all.
      const after = await adapter.query(`SELECT COUNT(*) FILTER (WHERE embedding IS NULL) AS n FROM assertions WHERE project_id = $1`, [projectId]);
      assertEqual(after.rows[0].n, beforeCounts.rows[0].n, 'dry-run must not change any row');
    } finally {
      await adapter.end();
      await dropRawDb(dbName);
    }
  });

  // ─── T5: backfill --apply only touches NULL rows, byte-identical elsewhere ─
  console.log('\n=== T5: backfill --apply — only NULL rows change ===');
  await test('T5: backfill-embeddings --apply touches ONLY embedding IS NULL rows; pre-existing rows/columns unchanged', async () => {
    const dbName = `handoff_embed_t5_${TS}`;
    await createRawDb(dbName);
    const db = await pgConnect(dbName);
    await db.query('CREATE EXTENSION IF NOT EXISTS vector').catch(() => {});
    const schemaSql = fs.readFileSync(path.join(PROJECT_ROOT, 'scripts', 'sql', 'handoff-core-schema.sql'), 'utf8');
    await db.query(schemaSql);
    const projectId = 'test-project-t5';
    const fakeServer = await startFakeEmbedServer(HALFVEC_DIMS, 0.9);
    const port = fakeServer.address().port;
    const providerId = await seedDefaultProvider(dbName, { nativeDims: HALFVEC_DIMS, storedDims: HALFVEC_DIMS, endpoint: `http://127.0.0.1:${port}` });
    // One row already embedded (must survive byte-identical); one NULL row (must get embedded).
    await db.query(
      `INSERT INTO assertions (project_id, subject, predicate, object, confidence, source, valid_at, embedding, embedded_by_provider_id)
       VALUES ($1, 'already-embedded', 'p', 'o', 7, 'user_stated', now(), $3::halfvec, $2)`,
      [projectId, providerId, fakeVectorLiteral(0.1)]
    );
    await db.query(
      `INSERT INTO assertions (project_id, subject, predicate, object, confidence, source, valid_at)
       VALUES ($1, 'pending-embed', 'p', 'o', 5, 'user_stated', now())`,
      [projectId]
    );
    const before = await db.query(`SELECT id, subject, embedding::text AS embedding_text FROM assertions WHERE project_id = $1 AND subject = 'already-embedded'`, [projectId]);
    await db.end();

    const adapter = await createAdapter('postgres', { host: 'localhost', port: 5432, database: dbName, user: 'postgres' });
    try {
      const result = await runBackfillEmbeddings({ db: adapter, projectId, table: 'assertions', apply: true });
      assertEqual(result.ok, true, JSON.stringify(result.refusal));
      const row = result.tables[0];
      assertEqual(row.embedded, 1, `exactly one row should be embedded — errors: ${JSON.stringify(row.errors)}`);

      const afterAll = await adapter.query(`SELECT subject, embedding IS NULL AS is_null FROM assertions WHERE project_id = $1 ORDER BY subject`, [projectId]);
      const nullMap = Object.fromEntries(afterAll.rows.map((r) => [r.subject, r.is_null]));
      assertEqual(nullMap['pending-embed'], false, 'the pending row must now be embedded');
      assertEqual(nullMap['already-embedded'], false, 'the pre-existing row must still be embedded');

      const afterExisting = await adapter.query(`SELECT subject, embedding::text AS embedding_text FROM assertions WHERE project_id = $1 AND subject = 'already-embedded'`, [projectId]);
      assertEqual(afterExisting.rows[0].embedding_text, before.rows[0].embedding_text, 'pre-existing embedding must be byte-identical — never overwritten');
    } finally {
      await adapter.end();
      fakeServer.close();
      await dropRawDb(dbName);
    }
  });

  // ─── T6: status embedding_readiness states ────────────────────────────────
  console.log('\n=== T6: handoff:status embedding_readiness — READY / UNEMBEDDABLE:* ===');
  await test('T6: status reports UNEMBEDDABLE:no-extension, UNEMBEDDABLE:no-provider, and READY correctly', async () => {
    const dbName = `handoff_embed_t6_${TS}`;
    const projectDir = makeTempDir('t6');
    await createRawDb(dbName);
    writePipelineYml(projectDir, { database: dbName });

    // Apply the FULL postgres unit set (matching cmdInit's own applicable set)
    // WITHOUT the extension present (every gated block silently skips).
    const db1 = await pgConnect(dbName);
    const schemaSql = fs.readFileSync(path.join(PROJECT_ROOT, 'scripts', 'sql', 'handoff-core-schema.sql'), 'utf8');
    const decisionsSql = fs.readFileSync(path.join(PROJECT_ROOT, 'scripts', 'sql', 'decisions-base.sql'), 'utf8');
    await db1.query(schemaSql);
    await db1.query(decisionsSql);
    await db1.end();

    let out = runCli(['status', '--json'], { cwd: projectDir, env: { PROJECT_ROOT: projectDir, HANDOFF_DB: undefined } }).stdout || '';
    assert(out.includes('"embedding_readiness": "UNEMBEDDABLE:no-extension"'), `expected no-extension state, got:\n${out}`);

    // Now install the extension + re-apply (heals the gated columns) but no provider.
    const db2 = await pgConnect(dbName);
    await db2.query('CREATE EXTENSION IF NOT EXISTS vector');
    await db2.query(schemaSql); // idempotent re-apply now creates the gated columns
    await db2.query(decisionsSql);
    await db2.end();

    out = runCli(['status', '--json'], { cwd: projectDir, env: { PROJECT_ROOT: projectDir, HANDOFF_DB: undefined } }).stdout || '';
    assert(out.includes('"embedding_readiness": "UNEMBEDDABLE:no-provider"'), `expected no-provider state, got:\n${out}`);

    // Seed a default provider -> READY.
    await seedDefaultProvider(dbName);
    out = runCli(['status', '--json'], { cwd: projectDir, env: { PROJECT_ROOT: projectDir, HANDOFF_DB: undefined } }).stdout || '';
    assert(out.includes('"embedding_readiness": "READY"'), `expected READY state, got:\n${out}`);

    await dropRawDb(dbName);
    fs.rmSync(projectDir, { recursive: true, force: true });
  });

  // ─── T7: SQLite seam — N/A branch, never BLOCK/UNEMBEDDABLE ──────────────
  console.log('\n=== T7: SQLite seam — init/status/backfill-embeddings all N/A, never BLOCK ===');
  await test('T7: SQLite dialect — status reports N/A, backfill-embeddings reports 0 embeddable (no column on backend)', async () => {
    const { SUPPORTED_TABLES } = require(path.join(PROJECT_ROOT, 'scripts', 'lib', 'backfill-embeddings.js'));
    const adapter = await createAdapter('sqlite', { dbPath: ':memory:' });
    try {
      const result = await runBackfillEmbeddings({ db: adapter, table: 'all', apply: false });
      assertEqual(result.ok, true);
      for (const t of result.tables) {
        assertEqual(t.dialect, 'sqlite');
        assertEqual(t.embeddableRows, 0);
        assert(t.note.includes('no embedding column'), `expected the N/A note, got: ${t.note}`);
      }
      assertEqual(result.tables.map((t) => t.table).sort().join(','), SUPPORTED_TABLES.slice().sort().join(','));

      // --apply on SQLite must ALSO be the N/A branch — never BLOCK, never a real write attempt.
      const applyResult = await runBackfillEmbeddings({ db: adapter, table: 'all', apply: true });
      assertEqual(applyResult.ok, true);
      assertEqual(applyResult.tables[0].embeddableRows, 0);
    } finally {
      await adapter.end();
    }
  });

  // ─── T8: concurrency — new NULL rows inserted mid-run are never lost/clobbered ─
  console.log('\n=== T8: backfill-embeddings --apply concurrency safety ===');
  await test('T8: a row inserted concurrently mid-run is left for the next run; a row embedded by another writer meanwhile is never clobbered', async () => {
    const dbName = `handoff_embed_t8_${TS}`;
    await createRawDb(dbName);
    const db = await pgConnect(dbName);
    await db.query('CREATE EXTENSION IF NOT EXISTS vector').catch(() => {});
    const schemaSql = fs.readFileSync(path.join(PROJECT_ROOT, 'scripts', 'sql', 'handoff-core-schema.sql'), 'utf8');
    await db.query(schemaSql);
    const projectId = 'test-project-t8';
    const fakeServer = await startFakeEmbedServer(HALFVEC_DIMS, 0.5);
    const port = fakeServer.address().port;
    const providerId = await seedDefaultProvider(dbName, { nativeDims: HALFVEC_DIMS, storedDims: HALFVEC_DIMS, endpoint: `http://127.0.0.1:${port}` });

    // Row A: NULL, present before the run starts (must get embedded).
    await db.query(
      `INSERT INTO assertions (project_id, subject, predicate, object, confidence, source, valid_at) VALUES ($1, 'row-a', 'p', 'o', 5, 'user_stated', now())`,
      [projectId]
    );
    // Row B: embedded by a "concurrent writer" BEFORE the run's UPDATE fires
    // (simulated by embedding it directly, right here, before calling
    // runBackfillEmbeddings — proves the UPDATE's `AND embedding IS NULL`
    // re-check never clobbers a row a concurrent writer already filled).
    const { rows: rowBIns } = await db.query(
      `INSERT INTO assertions (project_id, subject, predicate, object, confidence, source, valid_at) VALUES ($1, 'row-b', 'p', 'o', 5, 'user_stated', now()) RETURNING id`,
      [projectId]
    );
    await db.query(
      `UPDATE assertions SET embedding = $1::halfvec, embedded_by_provider_id = $2 WHERE id = $3`,
      [fakeVectorLiteral(0.42), providerId, rowBIns[0].id]
    );
    const beforeRowB = await db.query(`SELECT embedding::text AS t FROM assertions WHERE id = $1`, [rowBIns[0].id]);
    await db.end();

    const adapter = await createAdapter('postgres', { host: 'localhost', port: 5432, database: dbName, user: 'postgres' });
    try {
      const result = await runBackfillEmbeddings({ db: adapter, projectId, table: 'assertions', apply: true, batchSize: 1 });
      assertEqual(result.ok, true, JSON.stringify(result.refusal));
      assertEqual(result.tables[0].embedded, 1, 'only row-a (the genuinely NULL row) should be embedded this run');

      const afterRowB = await adapter.query(`SELECT embedding::text AS t FROM assertions WHERE id = $1`, [rowBIns[0].id]);
      assertEqual(afterRowB.rows[0].t, beforeRowB.rows[0].t, 'row-b (already embedded by a concurrent writer) must be byte-identical — never clobbered');

      // Row C: inserted AFTER this run's scan started (simulated: inserted
      // now, after the run above completed) — a NEW NULL row must be picked
      // up correctly by the NEXT run, never silently lost.
      await adapter.query(
        `INSERT INTO assertions (project_id, subject, predicate, object, confidence, source, valid_at) VALUES ($1, 'row-c', 'p', 'o', 5, 'user_stated', now())`,
        [projectId]
      );
      const secondRun = await runBackfillEmbeddings({ db: adapter, projectId, table: 'assertions', apply: true, batchSize: 1 });
      assertEqual(secondRun.ok, true);
      assertEqual(secondRun.tables[0].embedded, 1, 'the next run must pick up the newly-inserted NULL row');
    } finally {
      await adapter.end();
      fakeServer.close();
      await dropRawDb(dbName);
    }
  });

  // ─── AF3: mixed-provider refusal ──────────────────────────────────────────
  console.log('\n=== AF3: backfill-embeddings mixed-provider refusal (adversary finding #3) ===');
  await test('AF3: backfill-embeddings --apply refuses when existing embedded rows carry a different provider id than the resolved default', async () => {
    const dbName = `handoff_embed_af3_${TS}`;
    await createRawDb(dbName);
    const db = await pgConnect(dbName);
    await db.query('CREATE EXTENSION IF NOT EXISTS vector').catch(() => {});
    const schemaSql = fs.readFileSync(path.join(PROJECT_ROOT, 'scripts', 'sql', 'handoff-core-schema.sql'), 'utf8');
    await db.query(schemaSql);
    const projectId = 'test-project-af3';
    await db.query(
      `INSERT INTO embedding_providers (name, model_label, native_dims, stored_dims, endpoint, is_default, data_egress_approved)
       VALUES ('provider-old', 'model-old', $1, $1, 'http://127.0.0.1:1', false, true),
              ('provider-new', 'model-new', $1, $1, 'http://127.0.0.1:2', true, true)`,
      [HALFVEC_DIMS]
    );
    const { rows: oldRows } = await db.query(`SELECT id FROM embedding_providers WHERE name = 'provider-old'`);
    await db.query(
      `INSERT INTO assertions (project_id, subject, predicate, object, confidence, source, valid_at, embedding, embedded_by_provider_id)
       VALUES ($1, 'old-embedded', 'p', 'o', 7, 'user_stated', now(), $3::halfvec, $2)`,
      [projectId, oldRows[0].id, fakeVectorLiteral(0.1)]
    );
    await db.query(
      `INSERT INTO assertions (project_id, subject, predicate, object, confidence, source, valid_at)
       VALUES ($1, 'pending', 'p', 'o', 5, 'user_stated', now())`,
      [projectId]
    );
    await db.end();

    const adapter = await createAdapter('postgres', { host: 'localhost', port: 5432, database: dbName, user: 'postgres' });
    try {
      const result = await runBackfillEmbeddings({ db: adapter, projectId, table: 'assertions', apply: true });
      assertEqual(result.ok, false, 'must refuse without --force-mixed-provider');
      assertEqual(result.refusal.reason, 'mixed_provider');

      const forced = await runBackfillEmbeddings({ db: adapter, projectId, table: 'assertions', apply: true, forceMixedProvider: true });
      assertEqual(forced.ok, true, `--force-mixed-provider must proceed: ${JSON.stringify(forced.refusal)}`);
    } finally {
      await adapter.end();
      await dropRawDb(dbName);
    }
  });

  // ─── AF4: user-scope REMOTE value still BLOCKs ────────────────────────────
  console.log('\n=== AF4: user-scope REMOTE endpoint still BLOCKs (adversary finding #4) ===');
  await test('AF4: user-scope handoff-embed.json with a REMOTE url still BLOCKs (no unguarded seed path)', async () => {
    const dbName = `handoff_embed_af4_${TS}`;
    const projectDir = makeTempDir('af4');
    const baseDir = makeTempDir('af4-base');
    await createRawDb(dbName);
    const db = await pgConnect(dbName);
    await db.query('CREATE EXTENSION IF NOT EXISTS vector').catch(() => {});
    await db.end();
    writePipelineYml(projectDir, { database: dbName });
    fs.writeFileSync(path.join(baseDir, 'handoff-embed.json'), JSON.stringify({ vllm_embed_url: 'http://0.0.0.0:8800' }), 'utf8');
    try {
      const r = runCli(['init', '-y'], {
        cwd: projectDir,
        env: { PROJECT_ROOT: projectDir, HANDOFF_DB: undefined, VLLM_EMBED_URL: undefined, HANDOFF_BASE_DIR: baseDir },
      });
      const out = (r.stdout || '') + (r.stderr || '');
      assertEqual(r.status, 1, `expected exit 1 (REMOTE without --allow-remote-embed), got ${r.status}. Output:\n${out.slice(0, 800)}`);
      assert(out.includes('data_egress_approved'), `expected the REMOTE attestation-required message, got:\n${out.slice(0, 800)}`);
    } finally {
      await dropRawDb(dbName);
      fs.rmSync(projectDir, { recursive: true, force: true });
      fs.rmSync(baseDir, { recursive: true, force: true });
    }
  });

  // ─── AF5: persisted opt-out honored on re-init ────────────────────────────
  console.log('\n=== AF5: persisted embeddings_opt_out auto-honored on re-init (adversary finding #5) ===');
  await test('AF5: a prior --no-embeddings opt-out is auto-honored on a routine re-init (no false re-BLOCK)', async () => {
    const dbName = `handoff_embed_af5_${TS}`;
    const projectDir = makeTempDir('af5');
    await createRawDb(dbName);
    writePipelineYml(projectDir, { database: dbName });

    const r1 = runCli(['init', '-y', '--no-embeddings'], {
      cwd: projectDir,
      env: { PROJECT_ROOT: projectDir, HANDOFF_DB: undefined, VLLM_EMBED_URL: undefined, HANDOFF_BASE_DIR: makeTempDir('af5-base') },
    });
    assertEqual(r1.status, 0, `first init --no-embeddings must succeed: ${(r1.stdout || '') + (r1.stderr || '')}`);

    // Routine re-init, no flags, endpoint still unconfigured — must NOT BLOCK.
    const r2 = runCli(['init', '-y'], {
      cwd: projectDir,
      env: { PROJECT_ROOT: projectDir, HANDOFF_DB: undefined, VLLM_EMBED_URL: undefined, HANDOFF_BASE_DIR: makeTempDir('af5-base2') },
    });
    const out2 = (r2.stdout || '') + (r2.stderr || '');
    assertEqual(r2.status, 0, `re-init must auto-honor the persisted opt-out, not re-BLOCK: ${out2.slice(0, 800)}`);
    assert(out2.includes('opt-out already on file'), `expected the auto-honor NOTE line, got:\n${out2.slice(0, 800)}`);

    await dropRawDb(dbName);
    fs.rmSync(projectDir, { recursive: true, force: true });
  });

  // ─── AF6: corrupt user-scope JSON treated as absent ──────────────────────
  console.log('\n=== AF6: corrupt handoff-embed.json treated as absent, non-fatal NOTE (adversary finding #6) ===');
  await test('AF6: a corrupt ~/.claude/handoff-embed.json is treated as effectively absent, never crashes init', async () => {
    const { _readUserScopeEmbedUrl } = require(path.join(PROJECT_ROOT, 'scripts', 'lib', 'embedding-provider.js'));
    const baseDir = makeTempDir('af6-base');
    fs.writeFileSync(path.join(baseDir, 'handoff-embed.json'), '{ this is not valid JSON,,, ]', 'utf8');
    const saved = process.env.HANDOFF_BASE_DIR;
    process.env.HANDOFF_BASE_DIR = baseDir;
    try {
      const result = _readUserScopeEmbedUrl();
      assertEqual(result.url, null, 'corrupt file must resolve to null url, never throw');
      assertEqual(result.corrupt, true, 'corrupt file must be flagged');
    } finally {
      if (saved === undefined) delete process.env.HANDOFF_BASE_DIR; else process.env.HANDOFF_BASE_DIR = saved;
      fs.rmSync(baseDir, { recursive: true, force: true });
    }
  });

  // ─── AF2: bounded timeout on the production embedForWrite path ──────────
  console.log('\n=== AF2: embedForWrite bounded timeout against a black-holed endpoint (adversary finding #2) ===');
  await test('AF2: a black-holed endpoint (TCP accepts, never responds) degrades embedForWrite to fail-soft NULL within the bounded timeout, never hangs', async () => {
    const net = require('net');
    const blackHole = net.createServer((socket) => {
      // Accept the connection, read nothing, write nothing, never close —
      // the exact "TCP handshake completes, HTTP response never arrives"
      // shape finding #2 names.
      socket.on('data', () => {});
    });
    await new Promise((resolve) => blackHole.listen(0, '127.0.0.1', resolve));
    const port = blackHole.address().port;

    const dbName = `handoff_embed_af2_${TS}`;
    await createRawDb(dbName);
    const db = await pgConnect(dbName);
    await db.query('CREATE EXTENSION IF NOT EXISTS vector').catch(() => {});
    const schemaSql = fs.readFileSync(path.join(PROJECT_ROOT, 'scripts', 'sql', 'handoff-core-schema.sql'), 'utf8');
    await db.query(schemaSql);
    await db.query(
      `INSERT INTO embedding_providers (name, model_label, native_dims, stored_dims, endpoint, is_default, data_egress_approved)
       VALUES ('black-hole', 'model', $1, $1, $2, true, true)`,
      [HALFVEC_DIMS, `http://127.0.0.1:${port}`]
    );

    const { embedForWrite } = require(path.join(PROJECT_ROOT, 'scripts', 'lib', 'write-time-embed.js'));
    const start = Date.now();
    const result = await embedForWrite(db, 'probe text', { timeoutMs: 800 });
    const elapsedMs = Date.now() - start;

    assertEqual(result.vectorLiteral, null, 'a black-holed endpoint must fail soft to NULL, never a thrown error');
    assert(typeof result.warning === 'string' && result.warning.length > 0, 'a warning must be surfaced');
    assert(elapsedMs < 5000, `embedForWrite must be BOUNDED by the timeout, not hang — took ${elapsedMs}ms (timeout was 800ms)`);

    await db.end();
    blackHole.close();
    await dropRawDb(dbName);
  });

  console.log(`\n─── Results ──────────────────────────────────────`);
  console.log(`PASS ${passed}  FAIL ${failed}`);
  if (failures.length > 0) {
    console.log('\nFailures:');
    for (const { label, err } of failures) console.log(`  - ${label}\n    ${err.stack || err.message}`);
  }
  process.exit(failed > 0 ? 1 : 0);
})().catch((err) => {
  console.error('FATAL:', err.stack || err.message);
  process.exit(1);
});
