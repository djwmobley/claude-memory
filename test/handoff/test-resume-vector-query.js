'use strict';

/**
 * test-resume-vector-query.js — Regression guard for the resume/loader
 * `vector` query-kind fix (fix/resume-vector-query).
 *
 * Before this fix, cmdLoaderLoad's `vector` branch was a stub: it never ran
 * a query, never incremented `vectorCount`, and always rendered
 * "### Vector query (<text>) — skipped in loader (Phase 3.6 hook)". This
 * file pins the real behavior: the vector kind now runs the SAME canonical
 * path memory-view.js's `runVectorQuery` (delegating to memory-search.js's
 * `memorySearch`) already serves for the `memory_view_run` / `memory_search`
 * MCP tools — never a second embedding/scoring implementation — and is
 * fail-soft on any embedder/provider error.
 *
 * Mirrors the throwaway-DB / subprocess-runner architecture of
 * test/handoff/test-resurrect-semantic.js (same repo, same mock strategy):
 * EMBED_MOCK_FIXTURES_PATH points at test/handoff/fixtures/embed-fixtures.json
 * so no live vLLM is required. Tests run `handoff.js resume` in a subprocess
 * against a throwaway Postgres DB and assert on stdout — `resume` (not the
 * bare `loader-load` subcommand) is what prints the "Done: ... N vector
 * matches" summary line this file pins vectorCount against.
 *
 * Test 1 (happy path): a `{kind:'vector'}` contract entry whose query text
 *   has a fixture vector, matched against one seeded assertion row that
 *   also carries an embedding — asserts vectorCount > 0 in the Done line
 *   and that the hit is rendered as a bullet under "### Vector query (...)".
 *
 * Test 2 (fail-soft): a `{kind:'vector'}` contract entry whose query text
 *   has NO fixture entry — embedQuery throws a "mock fixture miss" error.
 *   Asserts the loader still exits 0, renders exactly the one-line
 *   "— vector query unavailable: <reason>" fallback (not a crash, not a
 *   blank section), and leaves vectorCount at 0.
 *
 * Test 3 (PR #274 review — missing table in a multi-table fan-out): a
 *   default (`tables` omitted) vector query fans out to every ALLOWED_TABLES
 *   member; this throwaway DB only has `assertions` (handoff-core-schema.sql
 *   creates no seam-absorbed tables). Asserts memorySearch's per-table
 *   existence probe skips the absent tables instead of letting one missing
 *   relation kill the whole query — real hits from `assertions` still
 *   render, and the skipped tables are named in a
 *   "— skipped missing tables: ..." line, never a raw DB error.
 *
 * Test 4 (PR #274 review — every requested table missing): an explicit
 *   `tables:['gotchas','findings']` filter where BOTH are absent from this
 *   DB (neither is created by scripts/sql/*.sql — only by the migrate-14 JS
 *   migration, never applied here). Asserts exit 0, a skip line naming both
 *   tables, and vectorCount left at 0 — no raw "relation ... does not
 *   exist" ever reaches stdout.
 *
 * Usage: node test/handoff/test-resume-vector-query.js
 * Prerequisites: Postgres running (PGHOST/PGUSER/PGPASSWORD or defaults),
 * test/handoff/fixtures/embed-fixtures.json present (checked into the repo;
 * CI regenerates it synthetically before this test runs).
 * Exit codes: 0 all-pass, nonzero any failure.
 */

const { spawnSync } = require('child_process');
const fs            = require('fs');
const os            = require('os');
const path          = require('path');
const { createRequire } = require('module');
const scriptsRequire = createRequire(require.resolve('../../scripts/package.json'));
const { Client }    = scriptsRequire('pg');
const { readMarker } = require('../../scripts/lib/project-marker');

const REPO_ROOT      = path.resolve(__dirname, '..', '..');
const HELPER         = path.join(REPO_ROOT, 'scripts', 'handoff.js');
const SCHEMA_FILE    = path.join(REPO_ROOT, 'scripts', 'sql', 'handoff-core-schema.sql');
const FIXTURES_FILE  = path.join(__dirname, 'fixtures', 'embed-fixtures.json');
const TS             = Date.now();
const DB_NAME        = `claude_memory_vectest_${TS}`;

if (!fs.existsSync(FIXTURES_FILE)) {
  console.error(`\nFATAL: fixture file not found: ${FIXTURES_FILE}`);
  console.error('Generate it first: node scripts/dev/generate-embed-fixtures.js --synthetic');
  process.exit(2);
}
const FIXTURE_VECS = JSON.parse(fs.readFileSync(FIXTURES_FILE, 'utf8'));

let passed = 0;
let failed = 0;
function pass(label) { console.log(`PASS  ${label}`); passed++; }
function fail(label, reason) { console.error(`FAIL  ${label}`); console.error(`      ${reason}`); failed++; }

// ─── DB helpers (mirrors test-resurrect-semantic.js) ──────────────────────────

function pgCfg() {
  return {
    host:     process.env.PGHOST     || 'localhost',
    port:     parseInt(process.env.PGPORT || '5432', 10),
    user:     process.env.PGUSER     || 'postgres',
    password: process.env.PGPASSWORD || 'postgres',
  };
}

async function pgConnect(database) {
  const client = new Client({ ...pgCfg(), database: database || 'postgres' });
  await client.connect();
  return client;
}

async function createTestDb(dbName) {
  const sys = await pgConnect('postgres');
  const ex  = await sys.query('SELECT 1 FROM pg_database WHERE datname = $1', [dbName]);
  if (ex.rows.length > 0) throw new Error(`DB ${dbName} already exists`);
  await sys.query(`CREATE DATABASE "${dbName}"`);
  await sys.end();
}

async function dropTestDb(dbName) {
  let sys;
  try {
    sys = await pgConnect('postgres');
    await sys.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
       WHERE datname = $1 AND pid <> pg_backend_pid()`,
      [dbName]
    );
    await sys.query(`DROP DATABASE IF EXISTS "${dbName}"`);
    await sys.end();
  } catch (err) {
    if (sys) { try { await sys.end(); } catch (_) {} }
    console.error(`[TEARDOWN] DB drop warning: ${err.message}`);
  }
}

async function applySchema(dbName) {
  const sql = fs.readFileSync(SCHEMA_FILE, 'utf8');
  const db  = await pgConnect(dbName);
  try {
    await db.query('CREATE EXTENSION IF NOT EXISTS vector');
    await db.query('CREATE EXTENSION IF NOT EXISTS pg_trgm');
    await db.query(sql);
  } finally {
    await db.end();
  }
}

async function insertAssertionWithEmbedding(db, projectId, opts) {
  const {
    subject, predicate, object,
    confidence = 5.0,
    source     = 'model_extracted',
    embedding  = null,
  } = opts;

  const { rows } = await db.query(
    `INSERT INTO assertions
       (project_id, subject, predicate, object, confidence, source,
        suppressed, valid_at, decay_rate)
     VALUES
       ($1, $2, $3, $4, $5, $6, false, now(), 0.05)
     RETURNING id`,
    [projectId, subject, predicate, object, confidence, source]
  );
  const id = rows[0].id;

  if (Array.isArray(embedding) && embedding.length > 0) {
    const vecLiteral = '[' + embedding.join(',') + ']';
    await db.query(`UPDATE assertions SET embedding = $1::halfvec WHERE id = $2`, [vecLiteral, id]);
  }
  return id;
}

async function setContract(db, projectId, queries) {
  await db.query(
    `UPDATE retrieval_contract SET queries = $2::jsonb, updated_at = now()
     WHERE project_id = $1 AND name = 'default'`,
    [projectId, JSON.stringify({ queries })]
  );
}

// ─── Subprocess runner ────────────────────────────────────────────────────────

function runLoader(dbName, projectDir, envOverride = {}) {
  const env = {
    ...process.env,
    HANDOFF_DB:               dbName,
    PROJECT_ROOT:             projectDir,
    EMBED_MOCK_FIXTURES_PATH: FIXTURES_FILE,
    EMBED_SKIP:               undefined,
    ...envOverride,
  };
  for (const k of Object.keys(env)) {
    if (env[k] === undefined) delete env[k];
  }
  // Uses `resume`, not `loader-load`: cmdLoaderLoad's own console.log only
  // renders outputText (sections + token line) — the "Done: ... N vector
  // matches" summary line this test asserts on is printed by cmdResume
  // (and separately by loader-hook, to stderr), not by cmdLoaderLoad or the
  // bare loader-load subcommand.
  return spawnSync(process.execPath, [HELPER, 'resume'], {
    cwd: REPO_ROOT, env, encoding: 'utf8', timeout: 60000,
  });
}

function createProjectDir(suffix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `vectest-${suffix}-`));
  fs.mkdirSync(path.join(dir, '.git'));
  fs.mkdirSync(path.join(dir, '.claude'));
  fs.writeFileSync(
    path.join(dir, '.claude', 'pipeline.yml'),
    [
      'project:',
      '  name: vectest',
      '',
      'knowledge:',
      '  tier: "postgres"',
      '  host: "localhost"',
      '  port: 5432',
      `  database: "${DB_NAME}"`,
      '  user: "postgres"',
      '  embedding_model: "Qwen/Qwen3-Embedding-8B"',
      '  vllm_embed_url: http://localhost:8800',
    ].join('\n'),
    'utf8'
  );
  return dir;
}

async function bootstrapProject(projectDir) {
  const initR = spawnSync(process.execPath, [HELPER, 'init', '-y', '--no-embeddings'], {
    cwd: REPO_ROOT,
    env: { ...process.env, HANDOFF_DB: DB_NAME, PROJECT_ROOT: projectDir, EMBED_SKIP: '1' },
    encoding: 'utf8', timeout: 30000,
  });
  if (initR.status !== 0) {
    throw new Error(`init failed for ${projectDir}: ${(initR.stderr || initR.stdout || '').slice(0, 400)}`);
  }
  const marker = readMarker(projectDir);
  if (marker && marker.uuid) return marker.uuid;
  return projectDir.replace(/[/\\]+$/, '').replace(/[^A-Za-z0-9-]/g, '-');
}

async function cleanupProject(db, projectId, projectDir) {
  const tables = ['edges', 'assertions', 'entities', 'retrieval_contract',
                  'project_settings', 'retrieval_contract_history'];
  for (const t of tables) {
    try { await db.query(`DELETE FROM ${t} WHERE project_id = $1`, [projectId]); } catch (_) {}
  }
  if (projectDir && fs.existsSync(projectDir)) {
    try { fs.rmSync(projectDir, { recursive: true, force: true }); } catch (_) {}
  }
}

function extractVectorMatchCount(stdout) {
  const m = stdout.match(/(\d+)\s+vector matches/);
  return m ? parseInt(m[1], 10) : null;
}

// ─── Test 1: happy path — real hit, vectorCount > 0, rendered bullet ──────────

async function test1(db) {
  const projectDir = createProjectDir('t1');
  const projectId  = await bootstrapProject(projectDir);
  try {
    await insertAssertionWithEmbedding(db, projectId, {
      subject: 'cache-backend', predicate: 'eviction_policy', object: 'LRU',
      embedding: FIXTURE_VECS['_row:cache-backend:eviction_policy:LRU'],
    });

    await setContract(db, projectId, [
      { kind: 'vector', query: 'cache eviction policy', tables: ['assertions'], limit: 5 },
    ]);

    const r   = runLoader(DB_NAME, projectDir);
    const out = r.stdout || '';

    if (r.status === 0) {
      pass('T1-1: loader exits 0 with a real vector hit');
    } else {
      fail('T1-1: loader exits 0 with a real vector hit',
        `exit ${r.status}: ${(r.stderr || '').slice(0, 400)}\nstdout=${out.slice(0, 400)}`);
    }

    if (out.includes('### Vector query (cache eviction policy)')) {
      pass('T1-2: ### Vector query section header present');
    } else {
      fail('T1-2: ### Vector query section header present', `stdout=${out.slice(0, 600)}`);
    }

    if (out.includes('cache-backend') && out.includes('LRU')) {
      pass('T1-3: hit rendered as a bullet (label + snippet present)');
    } else {
      fail('T1-3: hit rendered as a bullet', `stdout=${out.slice(0, 600)}`);
    }

    const count = extractVectorMatchCount(out);
    if (count !== null && count > 0) {
      pass(`T1-4: Done line reports vectorCount > 0 (got ${count})`);
    } else {
      fail('T1-4: Done line reports vectorCount > 0', `parsed count=${count}; stdout tail=${out.slice(-300)}`);
    }

    if (!out.includes('vector query unavailable')) {
      pass('T1-5: no fail-soft line on the happy path');
    } else {
      fail('T1-5: no fail-soft line on the happy path', `stdout=${out.slice(0, 600)}`);
    }
  } finally {
    await cleanupProject(db, projectId, projectDir);
  }
}

// ─── Test 2: fail-soft — embedder error renders exactly one line, exit 0 ──────

async function test2(db) {
  const projectDir = createProjectDir('t2');
  const projectId  = await bootstrapProject(projectDir);
  try {
    const badQuery = 'zzz_no_fixture_entry_for_this_query_zzz';
    await setContract(db, projectId, [
      { kind: 'vector', query: badQuery, tables: ['assertions'] },
    ]);

    const r   = runLoader(DB_NAME, projectDir);
    const out = r.stdout || '';

    if (r.status === 0) {
      pass('T2-1: loader exits 0 despite embedder failure (fail-soft, never throws)');
    } else {
      fail('T2-1: loader exits 0 despite embedder failure',
        `exit ${r.status}: ${(r.stderr || '').slice(0, 400)}\nstdout=${out.slice(0, 400)}`);
    }

    const expectedLine = `### Vector query (${badQuery}) — vector query unavailable:`;
    if (out.includes(expectedLine)) {
      pass('T2-2: exactly-one-line fail-soft rendering present');
    } else {
      fail('T2-2: exactly-one-line fail-soft rendering present', `stdout=${out.slice(0, 800)}`);
    }

    if (out.includes('mock fixture miss')) {
      pass('T2-3: underlying embedder error reason surfaced (mock fixture miss)');
    } else {
      fail('T2-3: underlying embedder error reason surfaced', `stdout=${out.slice(0, 800)}`);
    }

    const count = extractVectorMatchCount(out);
    if (count === 0) {
      pass('T2-4: Done line reports vectorCount === 0 on the fail-soft path');
    } else {
      fail('T2-4: Done line reports vectorCount === 0', `parsed count=${count}; stdout tail=${out.slice(-300)}`);
    }

    // Never silently blank: the header line must never appear with an empty tail.
    if (!out.includes('### Vector query (' + badQuery + ')\n\n')) {
      pass('T2-5: section is not silently blank');
    } else {
      fail('T2-5: section is not silently blank', `stdout=${out.slice(0, 800)}`);
    }
  } finally {
    await cleanupProject(db, projectId, projectDir);
  }
}

// ─── Test 3: missing table in the fan-out is skipped, not fatal (PR #274 review) ──
//
// Regression for the live-review finding: a contract vector query with NO
// `tables` filter fans out to every ALLOWED_TABLES member (15 total). This
// throwaway DB's schema (handoff-core-schema.sql only) has `assertions` but
// NONE of the 14 seam-absorbed tables (decisions, gotchas, agent_exchange,
// etc.) — exactly the shape the reviewer hit live against
// claude_memory_eval_test (agent_exchange missing pre-migrate-13/14).
// Before the fix, ONE missing table killed the whole query
// ("relation \"agent_exchange\" does not exist" -> the generic catch ->
// "vector query unavailable"). After the fix, memorySearch's own
// total-classification existence probe skips absent tables per-table and
// still returns real hits from the tables that DO exist.

async function test3(db) {
  const projectDir = createProjectDir('t3');
  const projectId  = await bootstrapProject(projectDir);
  try {
    await insertAssertionWithEmbedding(db, projectId, {
      subject: 'cache-backend', predicate: 'eviction_policy', object: 'LRU',
      embedding: FIXTURE_VECS['_row:cache-backend:eviction_policy:LRU'],
    });

    // No `tables` filter -> defaults to the full ALLOWED_TABLES enum, most
    // of which do not exist in this throwaway DB.
    await setContract(db, projectId, [
      { kind: 'vector', query: 'cache eviction policy', limit: 5 },
    ]);

    const r   = runLoader(DB_NAME, projectDir);
    const out = r.stdout || '';

    if (r.status === 0) {
      pass('T3-1: loader exits 0 with a missing table in the default fan-out');
    } else {
      fail('T3-1: loader exits 0 with a missing table in the default fan-out',
        `exit ${r.status}: ${(r.stderr || '').slice(0, 400)}\nstdout=${out.slice(0, 400)}`);
    }

    if (out.includes('cache-backend') && out.includes('LRU')) {
      pass('T3-2: real hit from the PRESENT table (assertions) still renders');
    } else {
      fail('T3-2: real hit from the present table still renders', `stdout=${out.slice(0, 800)}`);
    }

    if (!out.includes('does not exist') && !out.includes('vector query unavailable')) {
      pass('T3-3: the missing-table error never surfaces as a fatal/unavailable line');
    } else {
      fail('T3-3: the missing-table error never surfaces as a fatal/unavailable line', `stdout=${out.slice(0, 800)}`);
    }

    if (/— skipped missing tables: [^\n]*decisions/.test(out) || /skipped missing tables:/.test(out)) {
      pass('T3-4: skipped tables reported in a "— skipped missing tables:" line');
    } else {
      fail('T3-4: skipped tables reported', `stdout=${out.slice(0, 1200)}`);
    }

    const count = extractVectorMatchCount(out);
    if (count !== null && count > 0) {
      pass(`T3-5: Done line reports vectorCount > 0 despite the missing tables (got ${count})`);
    } else {
      fail('T3-5: Done line reports vectorCount > 0 despite the missing tables', `parsed count=${count}; stdout tail=${out.slice(-300)}`);
    }
  } finally {
    await cleanupProject(db, projectId, projectDir);
  }
}

// ─── Test 4: every requested table is missing -> skip line, exit 0, no crash ──

async function test4(db) {
  const projectDir = createProjectDir('t4');
  const projectId  = await bootstrapProject(projectDir);
  try {
    // Both explicitly-requested tables are absent from this throwaway DB.
    // decisions IS created here (scripts/sql/decisions-base.sql is applied
    // additively by init's ensureSchemaCurrent), so it is deliberately NOT
    // used in this test — gotchas/findings come only from the migrate-14 JS
    // migration, never applied to this throwaway DB.
    await setContract(db, projectId, [
      { kind: 'vector', query: 'cache eviction policy', tables: ['gotchas', 'findings'] },
    ]);

    const r   = runLoader(DB_NAME, projectDir);
    const out = r.stdout || '';

    if (r.status === 0) {
      pass('T4-1: loader exits 0 when every requested table is missing');
    } else {
      fail('T4-1: loader exits 0 when every requested table is missing',
        `exit ${r.status}: ${(r.stderr || '').slice(0, 400)}\nstdout=${out.slice(0, 400)}`);
    }

    if (out.includes('skipped missing tables: gotchas, findings') || out.includes('skipped missing tables: findings, gotchas')) {
      pass('T4-2: both missing tables named in the skip line');
    } else {
      fail('T4-2: both missing tables named in the skip line', `stdout=${out.slice(0, 800)}`);
    }

    if (!out.includes('does not exist')) {
      pass('T4-3: no raw DB error ("relation ... does not exist") ever reaches stdout');
    } else {
      fail('T4-3: no raw DB error reaches stdout', `stdout=${out.slice(0, 800)}`);
    }

    const count = extractVectorMatchCount(out);
    if (count === 0) {
      pass('T4-4: Done line reports vectorCount === 0 (no table was queryable)');
    } else {
      fail('T4-4: Done line reports vectorCount === 0', `parsed count=${count}; stdout tail=${out.slice(-300)}`);
    }
  } finally {
    await cleanupProject(db, projectId, projectDir);
  }
}

// ─── Main ──────────────────────────────────────────────────────────────────────

(async () => {
  let db;
  try {
    await createTestDb(DB_NAME);
    await applySchema(DB_NAME);
    db = await pgConnect(DB_NAME);

    await test1(db);
    await test2(db);
    await test3(db);
    await test4(db);
  } catch (err) {
    console.error(`FATAL: ${err.message}`);
    console.error(err.stack);
    failed++;
  } finally {
    if (db) { try { await db.end(); } catch (_) {} }
    await dropTestDb(DB_NAME);
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
})();
