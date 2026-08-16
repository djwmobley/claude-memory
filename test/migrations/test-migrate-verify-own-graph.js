'use strict';

/**
 * test-migrate-verify-own-graph.js — Test harness for
 * scripts/migrations/migrate-verify-own-graph.js (CONSOLIDATION-RUNBOOK.md
 * §6.1(c) + C-1..C-11 amendment, memory-manager#11(c)).
 *
 * Mirrors test-migrate-02-decisions.js's conventions: self-contained
 * scratch databases (target "_staging"-suffixed to satisfy migrate-01's own
 * classifyTarget, reused by reference), unconditional cleanup, never
 * touches claude_memory_eval_test/memory_manager_staging. Every fixture is
 * SYNTHETIC (fake UUIDs, fake project ids) -- no real instance data.
 *
 * Covers (task-mandated minimum):
 *   - junk exclusion: a project_id absent from known-own-graph-project-ids
 *     migrates ZERO rows and gets a migration_manifest row with
 *     excluded_reason='eval-junk-project-id', per table it appears in.
 *   - idempotent re-run: running the script twice against the same source
 *     produces zero net row-count change, including suppressed=true
 *     assertions rows (C-6's named hazard -- no covering unique index).
 *   - content-divergence logging: a foreign row already occupying a REAL
 *     slice's natural key with DIFFERENT content is detected, logged via
 *     [CONTENT-DIVERGENCE], and NEVER overwritten.
 *   - manifest slice shapes: one migration_manifest row per (table,
 *     project_id), real and junk alike -- never one aggregated NULL-scoped
 *     exclusion row.
 * Plus (this script's own id-remap design, load-bearing for correctness):
 *   - retrieval_event_assertions FK remap survives a delete-then-reinsert
 *     re-run (event_id/assertion_id point at the NEW target ids, not stale
 *     source ids).
 * Plus (history-collapse fix, 2026-08-16, found in the first real staging
 * run -- T2 FAILed: assertions expected 623 found 504, edges expected 118
 * found 104, both caused by supersession-chain rows silently collapsing to
 * one via a LOGICAL natural-key check that has since been removed for the
 * six tables where it was never DB-enforced):
 *   - H1/H2: a 3-row bi-temporal supersession chain (1 live + 2 suppressed
 *     ancestors, IDENTICAL project_id/subject/predicate/object) lands as 3
 *     DISTINCT target rows on first migrate AND survives an idempotent
 *     re-run as exactly 3 (never collapsed, never duplicated).
 *   - H3: MIGRATION_RESULT's STRICT reconciliation (migrated === source_
 *     real, not "<=") with the chain present -- the T2-shaped proof.
 *   - H4: [CONTENT-DIVERGENCE] is now reserved for the GENUINE case (this
 *     exact source id migrated before, content changed since) -- logged
 *     informationally and RE-SYNCED, never skipped, distinguishing it from
 *     D1's FOREIGN-row case below (which correctly IS skipped and now
 *     correctly FAILs the strict gate -- see D1's updated exit-code
 *     expectation).
 *   - U2: redactRowForLog() strips *embedding*-named fields from log lines
 *     (review finding: unredacted logs were ~1.4MB of vector noise/run).
 *
 * Usage: node test/migrations/test-migrate-verify-own-graph.js
 * Exit 0 = all pass; nonzero = any failure.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { createRequire } = require('module');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const MIGRATE_ONE_PATH = path.join(PROJECT_ROOT, 'scripts', 'migrations', 'migrate-01-canonical-db.js');
const SCRIPT_PATH = path.join(PROJECT_ROOT, 'scripts', 'migrations', 'migrate-verify-own-graph.js');
const T0_ROSTER_SCRIPT_PATH = path.join(PROJECT_ROOT, 'scripts', 'migrations', 'verify-15-t0-roster.js');

const migrateOne = require(MIGRATE_ONE_PATH);
const script = require(SCRIPT_PATH);

const scriptsRequire = createRequire(require.resolve('../../scripts/package.json'));
const { Client } = scriptsRequire('pg');

const TS = Date.now();

let passed = 0;
let failed = 0;
function pass(id, label) { console.log(`[${id}] ${label} ... PASS`); passed++; }
function fail(id, label, reason) { console.log(`[${id}] ${label} ... FAIL: ${reason}`); failed++; }
async function run(id, label, fn) {
  try { await fn(); pass(id, label); } catch (err) { fail(id, label, err && err.stack ? err.stack : String(err)); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }

function pgConfig(database) {
  return {
    host: process.env.PGHOST || 'localhost',
    port: parseInt(process.env.PGPORT || '5432', 10),
    user: process.env.PGUSER || 'postgres',
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
    await sys.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`, [dbName]);
    await sys.query(`DROP DATABASE IF EXISTS "${dbName}"`);
  } catch (_) { /* best-effort */ } finally {
    if (sys) { try { await sys.end(); } catch (_) {} }
  }
}
async function createDb(dbName) {
  const sys = await pgConnect('postgres');
  try {
    await sys.query(`CREATE DATABASE "${dbName}"`);
  } finally {
    await sys.end();
  }
}

/** Applies the same four schema files migrate-01 applies, directly (bypasses migrate-01's CLI target-name refusal -- a scratch "source" DB standing in for claude_memory_eval_test is never named *_staging). */
async function applyEngineSchema(dbName) {
  const client = await pgConnect(dbName);
  try {
    for (const ext of ['vector', 'pg_trgm']) {
      try { await client.query(`CREATE EXTENSION IF NOT EXISTS ${ext}`); } catch (_) {}
    }
    for (const file of migrateOne.SCHEMA_FILES) {
      await migrateOne.applySqlFile(client, file);
    }
  } finally {
    await client.end();
  }
}

async function setupTargetSchema(dbName) {
  const r = require('child_process').spawnSync(process.execPath, [MIGRATE_ONE_PATH, '--db', dbName], { cwd: PROJECT_ROOT, env: process.env, encoding: 'utf8', timeout: 30000 });
  if (r.status !== 0) throw new Error(`migrate-01 fixture setup failed: status=${r.status} stderr=${r.stderr}`);
}

function writeKnownIds(dirPath, ids) {
  const p = path.join(dirPath, `known-ids-${TS}-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(p, JSON.stringify({ known_project_ids: ids }));
  return p;
}

function runScript(args, timeoutMs = 30000) {
  return require('child_process').spawnSync(process.execPath, [SCRIPT_PATH, ...args], { cwd: PROJECT_ROOT, env: process.env, encoding: 'utf8', timeout: timeoutMs });
}

function runT0Roster(args, extraEnv, timeoutMs = 20000) {
  return require('child_process').spawnSync(process.execPath, [T0_ROSTER_SCRIPT_PATH, ...args], { cwd: PROJECT_ROOT, env: { ...process.env, ...extraEnv }, encoding: 'utf8', timeout: timeoutMs });
}

async function queryCount(dbName, sql, params) {
  const client = await pgConnect(dbName);
  try {
    const { rows } = await client.query(sql, params);
    return Number(rows[0].n);
  } finally {
    await client.end();
  }
}
async function query(dbName, sql, params) {
  const client = await pgConnect(dbName);
  try {
    return (await client.query(sql, params)).rows;
  } finally {
    await client.end();
  }
}

const DB_TARGET = `verifyown_target_${TS}_staging`;
const DB_SOURCE = `verifyown_source_${TS}`;
const CREATED_DBS = [DB_TARGET, DB_SOURCE];
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'test-migrate-verify-own-graph-'));

const REAL_PROJECT_ID = 'real-proj-11111111-1111-1111-1111-111111111111';
const JUNK_PROJECT_ID = 'eval-junk-uuid-22222222-2222-2222-2222-222222222222';
const KNOWN_IDS_PATH = writeKnownIds(TMP_DIR, [REAL_PROJECT_ID]);

// History-collapse regression fixture (2026-08-16) -- see seedSource().
const CHAIN_SUBJECT = 'claude-memory';
const CHAIN_PREDICATE = 'has_unpackaged_state';
const CHAIN_OBJECT = 'dirty — dirty working tree';

async function seedSource() {
  const client = await pgConnect(DB_SOURCE);
  try {
    // REAL slice: entities, assertions (one suppressed=true, no covering
    // unique index -- C-6's named idempotency hazard), edges,
    // retrieval_events + a joining retrieval_event_assertions row.
    const { rows: e1 } = await client.query(
      `INSERT INTO entities (project_id, name, entity_type, description) VALUES ($1,'widget','system','the widget') RETURNING id`,
      [REAL_PROJECT_ID]
    );
    void e1;
    const { rows: a1 } = await client.query(
      `INSERT INTO assertions (project_id, subject, predicate, object, confidence, source, suppressed)
       VALUES ($1,'widget','depends_on','gadget',8.0,'user_stated',false) RETURNING id`,
      [REAL_PROJECT_ID]
    );
    const { rows: a2 } = await client.query(
      `INSERT INTO assertions (project_id, subject, predicate, object, confidence, source, suppressed)
       VALUES ($1,'widget','old_note','stale value',3.0,'model_extracted',true) RETURNING id`,
      [REAL_PROJECT_ID]
    );
    await client.query(
      `INSERT INTO edges (project_id, from_entity, edge_type, to_entity) VALUES ($1,'widget','depends_on','gadget')`,
      [REAL_PROJECT_ID]
    );
    // Bi-temporal supersession chain (history-collapse regression fixture,
    // 2026-08-16): 3 rows sharing the EXACT SAME (project_id, subject,
    // predicate, object) -- 1 live (suppressed=false) + 2 suppressed
    // ancestors (suppression_kind='superseded'), each with a distinct id
    // and its own valid_at/invalid_at window. Mirrors the real staging
    // repro exactly (source id=22 / target-existing id=948, s/p/o
    // "claude-memory / has_unpackaged_state / dirty — dirty working tree").
    // All 3 MUST migrate -- this is legitimate history, never a
    // [CONTENT-DIVERGENCE] collision.
    await client.query(
      `INSERT INTO assertions (project_id, subject, predicate, object, confidence, source, suppressed, valid_at)
       VALUES ($1,$2,$3,$4,6.0,'model_extracted',false,'2026-08-16T12:00:00Z')`,
      [REAL_PROJECT_ID, CHAIN_SUBJECT, CHAIN_PREDICATE, CHAIN_OBJECT]
    );
    await client.query(
      `INSERT INTO assertions (project_id, subject, predicate, object, confidence, source, suppressed, suppression_kind, valid_at, invalid_at)
       VALUES ($1,$2,$3,$4,6.0,'model_extracted',true,'superseded','2026-08-15T09:00:00Z','2026-08-16T12:00:00Z')`,
      [REAL_PROJECT_ID, CHAIN_SUBJECT, CHAIN_PREDICATE, CHAIN_OBJECT]
    );
    await client.query(
      `INSERT INTO assertions (project_id, subject, predicate, object, confidence, source, suppressed, suppression_kind, valid_at, invalid_at)
       VALUES ($1,$2,$3,$4,6.0,'model_extracted',true,'superseded','2026-08-14T09:00:00Z','2026-08-15T09:00:00Z')`,
      [REAL_PROJECT_ID, CHAIN_SUBJECT, CHAIN_PREDICATE, CHAIN_OBJECT]
    );
    const { rows: ev1 } = await client.query(
      `INSERT INTO retrieval_events (project_id, query_text, session_id) VALUES ($1,'find widget deps','sess-1') RETURNING id`,
      [REAL_PROJECT_ID]
    );
    await client.query(
      `INSERT INTO retrieval_event_assertions (event_id, assertion_id) VALUES ($1,$2)`,
      [ev1[0].id, a1[0].id]
    );
    await client.query(
      `INSERT INTO retrieval_contract (project_id, name, queries) VALUES ($1,'default','[]'::jsonb)`,
      [REAL_PROJECT_ID]
    );
    await client.query(
      `INSERT INTO project_settings (project_id, key, value) VALUES ($1,'staleness_days','7')`,
      [REAL_PROJECT_ID]
    );
    // The remaining 3 of the 10 §6.1(c) in-scope tables (needed so T0-REG's
    // full-10-entry shipped-roster check below finds a migration_manifest
    // row for every entry it loads, not just the 7 tables seeded above).
    await client.query(
      `INSERT INTO retrieval_contract_history (project_id, name, version, queries, change_note)
       VALUES ($1,'default',1,'[]'::jsonb,'seed')`,
      [REAL_PROJECT_ID]
    );
    await client.query(
      `INSERT INTO entity_communities (project_id, entity_name, community_id, level, run_id)
       VALUES ($1,'widget',1,0,'run-1')`,
      [REAL_PROJECT_ID]
    );
    await client.query(
      `INSERT INTO extraction_queue (project_id, payload, source_ref, status)
       VALUES ($1,'{}'::jsonb,'sess-1','pending')`,
      [REAL_PROJECT_ID]
    );

    // JUNK slice: same shapes, different (unlisted) project_id.
    await client.query(
      `INSERT INTO entities (project_id, name, entity_type) VALUES ($1,'junk-entity','concept')`,
      [JUNK_PROJECT_ID]
    );
    await client.query(
      `INSERT INTO assertions (project_id, subject, predicate, object, confidence, source)
       VALUES ($1,'junk','is_status','noise',5.0,'model_extracted')`,
      [JUNK_PROJECT_ID]
    );
    void a2;
    return { assertionId1: a1[0].id, eventId1: ev1[0].id };
  } finally {
    await client.end();
  }
}

async function main() {
  await run('SETUP', 'target + source scratch databases provisioned, engine schema applied to both', async () => {
    await setupTargetSchema(DB_TARGET);
    await createDb(DB_SOURCE);
    await applyEngineSchema(DB_SOURCE);
  });

  let seeded;
  await run('SEED', 'synthetic REAL + JUNK own-graph fixture rows inserted into source', async () => {
    seeded = await seedSource();
    assert(seeded.assertionId1 > 0, 'seed assertion id captured');
  });

  // ── classifyProjectId unit tests (no DB) ──────────────────────────────
  await run('U1', 'classifyProjectId: REAL iff present in known set, JUNK is the default branch', () => {
    const known = new Set(['a', 'b']);
    assert(script.classifyProjectId('a', known) === 'REAL', 'a should be REAL');
    assert(script.classifyProjectId('unknown-uuid', known) === 'JUNK', 'unknown-uuid should be JUNK (default branch)');
    assert(script.classifyProjectId('', known) === 'JUNK', 'empty string should be JUNK, never a silent pass');
  });

  await run('U2', 'redactRowForLog: any *embedding*-named field is replaced with a short placeholder, everything else passes through unchanged (review finding: unredacted logs were ~1.4MB of vector noise per real run)', () => {
    const bigVector = '[' + '0.123456,'.repeat(4000) + ']';
    const row = { id: 5, subject: 'x', embedding: bigVector, query_embedding: bigVector, note: null };
    const redacted = script.redactRowForLog(row);
    assert(redacted.id === 5 && redacted.subject === 'x', 'non-embedding fields pass through unchanged');
    assert(redacted.note === null, 'a null non-embedding field passes through unchanged');
    assert(!redacted.embedding.includes('0.123456'), 'embedding field content is redacted');
    assert(redacted.embedding.length < 100, `redacted embedding placeholder should be short, got ${redacted.embedding.length} chars (bigVector was ${bigVector.length})`);
    assert(!redacted.query_embedding.includes('0.123456'), 'any *embedding*-named field is redacted, not just the literal "embedding" key');
  });

  let firstRunResult;
  await run('M1', 'first migrate run: exits 0, real rows migrated, junk rows excluded', async () => {
    firstRunResult = runScript(['--db', DB_TARGET, '--source-db', DB_SOURCE, '--known-ids', KNOWN_IDS_PATH]);
    assert(firstRunResult.status === 0, `expected exit 0, got ${firstRunResult.status}. stdout=${firstRunResult.stdout} stderr=${firstRunResult.stderr}`);
    assert(/MIGRATION_RESULT: PASS/.test(firstRunResult.stdout), `expected PASS in stdout: ${firstRunResult.stdout}`);
  });

  // ── T0 regression (review finding, 2026-08-16): own_graph_migration_ids
  // was previously created via a PRIVATE per-script DDL block, invisible to
  // verify-15-t0-roster.js's live-table total classification (category (b),
  // "battery-infra", derived from verify15-shared.js's OWN DDL_SQL text) --
  // T0 FAILed naming it as an unclassified table present in the target
  // (reproduced twice by the independent reviewer). Fixed by registering
  // the table's DDL in verify15-shared.js's shared DDL_SQL instead of a
  // private constant in this script. Reproduces the reviewer's exact
  // scenario against DB_TARGET (a disposable, persistent scratch DB, schema
  // applied via migrate-01, already carrying real migrate-verify-own-graph.js
  // output from M1 above): run this script, THEN run verify-15-t0-roster.js
  // against the SAME target and confirm PASS with own_graph_migration_ids
  // never appearing in the "unclassified" bucket. Placed here (before B1's
  // --rollback, which later deletes the real-slice migration_manifest rows
  // T0's roster-totality forward-check below depends on).
  await run('T0-REG', 'C-DDL-registration + roster-completeness: after a real migrate-verify-own-graph.js run, verify-15-t0-roster.js PASSes against the SHIPPED committed example roster (all 10 entries, never a bespoke hand-typed subset) and classifies own_graph_migration_ids as battery-infra (never unclassified)', async () => {
    // Loads the REAL, committed scripts/migrations/source-table-roster.
    // example.json -- the same file an operator copies from -- rather than
    // a hand-typed roster in this test file. This is deliberate: a second
    // reviewer finding (2026-08-16) caught that the committed example was
    // MISSING the 'assertions' entry (9 of 10, not 10 of 10), a drift a
    // bespoke test roster could never detect because it would just be
    // hand-typed to match whatever the test author remembered to include.
    // Loading the shipped file directly means any future regression of the
    // SAME shape (an entry silently dropped from the example) fails this
    // test immediately, not just a live operator's real run.
    const exampleRosterPath = path.join(PROJECT_ROOT, 'scripts', 'migrations', 'source-table-roster.example.json');
    const exampleRoster = JSON.parse(fs.readFileSync(exampleRosterPath, 'utf8'));
    // Filter to this script's own tagged entries (source_db ===
    // script.DEFAULT_SOURCE_DB, i.e. 'claude_memory_eval_test' -- the OTHER
    // example entries in the file belong to migrate-02-decisions.js /
    // routing_profiles / memory_entries and are irrelevant here), then
    // remap source_db -> DB_SOURCE (this test's actual scratch source) so
    // the entries match what migrate-verify-own-graph.js's real
    // migration_manifest rows carry -- every OTHER field (targetTable,
    // loadBearingCols, hasContentBearingText, requires_project_id_scope,
    // embeddingCol) is used VERBATIM from the shipped file, unmodified.
    const ownGraphEntries = exampleRoster
      .filter((e) => e.source_db === script.DEFAULT_SOURCE_DB)
      .map((e) => ({ ...e, source_db: DB_SOURCE }));
    // Self-check: fails loud (not silently passing with fewer entries) if
    // the shipped file ever regresses below the full 10-table set this
    // script's in-scope roster requires -- the exact class of drift caught
    // above.
    assert(ownGraphEntries.length === 10, `expected exactly 10 migrate-verify-own-graph.js-tagged entries in the shipped source-table-roster.example.json, got ${ownGraphEntries.length}: ${JSON.stringify(ownGraphEntries.map((e) => e.targetTable))}`);
    const expectedTables = ['entities', 'assertions', 'edges', 'retrieval_contract', 'retrieval_contract_history', 'project_settings', 'entity_communities', 'extraction_queue', 'retrieval_events', 'retrieval_event_assertions'];
    for (const t of expectedTables) {
      assert(ownGraphEntries.some((e) => e.targetTable === t), `shipped example roster is missing a migrate-verify-own-graph.js entry for targetTable="${t}"`);
    }

    const t0RosterPath = path.join(TMP_DIR, `t0-reg-roster-${TS}.json`);
    fs.writeFileSync(t0RosterPath, JSON.stringify(ownGraphEntries, null, 2));

    const r = runT0Roster(['--db', DB_TARGET], { SOURCE_TABLE_ROSTER: t0RosterPath });
    const out = r.stdout + r.stderr;
    assert(r.status === 0, `expected verify-15-t0-roster.js to exit 0 after a real migrate-verify-own-graph.js run using the SHIPPED example roster, got ${r.status}. stdout=${r.stdout} stderr=${r.stderr}`);
    assert(!/unclassified.*own_graph_migration_ids|own_graph_migration_ids.*unclassified/.test(out), `own_graph_migration_ids must never appear in the unclassified bucket: ${out}`);
    assert(/unclassified=0/.test(out), `expected unclassified=0 (own_graph_migration_ids classified as battery-infra), got: ${out}`);
    assert(/battery-infra=[1-9]/.test(out), `expected battery-infra count >= 1, got: ${out}`);
    assert(/OK \(forward\)/.test(out), `expected T0 forward direction to pass against the full 10-entry shipped roster: ${out}`);
    assert(/OK \(inverse\)/.test(out), `expected T0 inverse direction to pass (every non-excluded manifest pair has a roster entry, including assertions): ${out}`);
  });

  // ── Junk exclusion ─────────────────────────────────────────────────────
  await run('J1', 'junk project_id: zero rows migrated into target entities/assertions', async () => {
    const nEntities = await queryCount(DB_TARGET, `SELECT COUNT(*) AS n FROM entities WHERE project_id = $1`, [JUNK_PROJECT_ID]);
    const nAssertions = await queryCount(DB_TARGET, `SELECT COUNT(*) AS n FROM assertions WHERE project_id = $1`, [JUNK_PROJECT_ID]);
    assert(nEntities === 0, `expected 0 junk entities in target, got ${nEntities}`);
    assert(nAssertions === 0, `expected 0 junk assertions in target, got ${nAssertions}`);
  });
  await run('J2', 'junk project_id: migration_manifest carries excluded_reason=eval-junk-project-id per (table,project_id) slice, rows NOT copied', async () => {
    const rows = await query(
      DB_TARGET,
      `SELECT source_table, row_count, excluded_reason FROM migration_manifest WHERE source_db=$1 AND project_id_or_null=$2 ORDER BY source_table`,
      [DB_SOURCE, JUNK_PROJECT_ID]
    );
    assert(rows.length === 2, `expected manifest rows for entities+assertions junk slices, got ${rows.length}: ${JSON.stringify(rows)}`);
    for (const r of rows) {
      assert(r.excluded_reason === 'eval-junk-project-id', `expected excluded_reason='eval-junk-project-id', got ${r.excluded_reason}`);
      assert(Number(r.row_count) === 1, `expected row_count=1 (documented, not copied), got ${r.row_count}`); // BIGINT comes back as string from pg
    }
  });

  // ── Real migration correctness ────────────────────────────────────────
  await run('R1', 'real project_id: entities/assertions/edges/retrieval_contract/project_settings migrated', async () => {
    const nEntities = await queryCount(DB_TARGET, `SELECT COUNT(*) AS n FROM entities WHERE project_id = $1`, [REAL_PROJECT_ID]);
    const nAssertions = await queryCount(DB_TARGET, `SELECT COUNT(*) AS n FROM assertions WHERE project_id = $1`, [REAL_PROJECT_ID]);
    const nSuppressed = await queryCount(DB_TARGET, `SELECT COUNT(*) AS n FROM assertions WHERE project_id = $1 AND suppressed = true`, [REAL_PROJECT_ID]);
    const nEdges = await queryCount(DB_TARGET, `SELECT COUNT(*) AS n FROM edges WHERE project_id = $1`, [REAL_PROJECT_ID]);
    const nContract = await queryCount(DB_TARGET, `SELECT COUNT(*) AS n FROM retrieval_contract WHERE project_id = $1`, [REAL_PROJECT_ID]);
    const nSettings = await queryCount(DB_TARGET, `SELECT COUNT(*) AS n FROM project_settings WHERE project_id = $1`, [REAL_PROJECT_ID]);
    // 2 original (1 live + 1 unrelated suppressed) + 3 chain rows (1 live + 2 suppressed ancestors) = 5 / 3.
    assert(nEntities === 1, `expected 1 entity, got ${nEntities}`);
    assert(nAssertions === 5, `expected 5 assertions (2 original + 3-row supersession chain), got ${nAssertions}`);
    assert(nSuppressed === 3, `expected 3 suppressed assertions migrated (1 original + 2 chain ancestors), got ${nSuppressed}`);
    assert(nEdges === 1, `expected 1 edge, got ${nEdges}`);
    assert(nContract === 1, `expected 1 retrieval_contract row, got ${nContract}`);
    assert(nSettings === 1, `expected 1 project_settings row, got ${nSettings}`);
  });

  // ── History-collapse fix (2026-08-16): supersession chains migrate 1:1 ──
  await run('H1', 'supersession-chain regression: 3-row chain (1 live + 2 suppressed, identical s/p/o) lands as 3 DISTINCT target rows -- lossless fidelity, never collapsed to 1', async () => {
    const rows = await query(
      DB_TARGET,
      `SELECT id, suppressed, suppression_kind FROM assertions WHERE project_id=$1 AND subject=$2 AND predicate=$3 AND object=$4 ORDER BY id`,
      [REAL_PROJECT_ID, CHAIN_SUBJECT, CHAIN_PREDICATE, CHAIN_OBJECT]
    );
    assert(rows.length === 3, `expected exactly 3 target rows for the supersession chain, got ${rows.length}: ${JSON.stringify(rows)}`);
    const ids = new Set(rows.map((r) => r.id));
    assert(ids.size === 3, `expected 3 DISTINCT target ids (never collapsed), got ${ids.size} distinct among ${JSON.stringify(rows.map((r) => r.id))}`);
    const nLive = rows.filter((r) => r.suppressed === false).length;
    const nSuperseded = rows.filter((r) => r.suppressed === true && r.suppression_kind === 'superseded').length;
    assert(nLive === 1, `expected exactly 1 live (suppressed=false) row in the chain, got ${nLive}`);
    assert(nSuperseded === 2, `expected exactly 2 suppressed/superseded ancestor rows, got ${nSuperseded}`);
  });

  await run('R2', 'retrieval_event_assertions FK remap: event_id/assertion_id point at the NEW target ids, not stale source ids', async () => {
    const rows = await query(
      DB_TARGET,
      `SELECT rea.event_id, rea.assertion_id, re.id AS real_event_id, a.id AS real_assertion_id
         FROM retrieval_event_assertions rea
         JOIN retrieval_events re ON re.id = rea.event_id AND re.project_id = $1
         JOIN assertions a ON a.id = rea.assertion_id AND a.project_id = $1`,
      [REAL_PROJECT_ID]
    );
    assert(rows.length === 1, `expected exactly 1 remapped join row, got ${rows.length}`);
    // NOTE: target ids are fresh SERIAL values assigned independently on the
    // target DB -- they may coincidentally equal the source id (e.g. both
    // "1" on a freshly-seeded scratch pair). The real proof of a correct
    // remap is that event_id/assertion_id resolve via JOIN to REAL target
    // rows scoped to this project_id (checked below), not that the numbers
    // happen to differ from the source.
    assert(rows[0].event_id === rows[0].real_event_id, 'remapped event_id resolves to a real target retrieval_events row');
    assert(rows[0].assertion_id === rows[0].real_assertion_id, 'remapped assertion_id resolves to a real target assertions row');
  });

  // ── Idempotent re-run ───────────────────────────────────────────────────
  let secondRunResult;
  await run('I1', 'second (idempotent) run: exits 0, PASS', async () => {
    secondRunResult = runScript(['--db', DB_TARGET, '--source-db', DB_SOURCE, '--known-ids', KNOWN_IDS_PATH]);
    assert(secondRunResult.status === 0, `expected exit 0, got ${secondRunResult.status}. stdout=${secondRunResult.stdout} stderr=${secondRunResult.stderr}`);
    assert(/MIGRATION_RESULT: PASS/.test(secondRunResult.stdout), `expected PASS: ${secondRunResult.stdout}`);
  });
  await run('I2', 'second run: zero net row-count change across every migrated table, INCLUDING the suppressed=true row (C-6\'s named hazard)', async () => {
    const nEntities = await queryCount(DB_TARGET, `SELECT COUNT(*) AS n FROM entities WHERE project_id = $1`, [REAL_PROJECT_ID]);
    const nAssertions = await queryCount(DB_TARGET, `SELECT COUNT(*) AS n FROM assertions WHERE project_id = $1`, [REAL_PROJECT_ID]);
    const nSuppressed = await queryCount(DB_TARGET, `SELECT COUNT(*) AS n FROM assertions WHERE project_id = $1 AND suppressed = true`, [REAL_PROJECT_ID]);
    const nEdges = await queryCount(DB_TARGET, `SELECT COUNT(*) AS n FROM edges WHERE project_id = $1`, [REAL_PROJECT_ID]);
    const nRea = await queryCount(
      DB_TARGET,
      `SELECT COUNT(*) AS n FROM retrieval_event_assertions rea JOIN retrieval_events re ON re.id = rea.event_id WHERE re.project_id = $1`,
      [REAL_PROJECT_ID]
    );
    assert(nEntities === 1, `entities duplicated on re-run: ${nEntities}`);
    assert(nAssertions === 5, `assertions duplicated/lost on re-run: ${nAssertions}`);
    assert(nSuppressed === 3, `suppressed=true assertions duplicated/lost on re-run (C-6): ${nSuppressed}`);
    assert(nEdges === 1, `edges duplicated on re-run: ${nEdges}`);
    assert(nRea === 1, `retrieval_event_assertions duplicated on re-run: ${nRea}`);
  });
  await run('H2', 'supersession-chain regression: idempotent re-run of the same 3-row chain still lands as exactly 3 rows (never duplicated, never collapsed to 1)', async () => {
    const rows = await query(
      DB_TARGET,
      `SELECT id, suppressed, suppression_kind FROM assertions WHERE project_id=$1 AND subject=$2 AND predicate=$3 AND object=$4 ORDER BY id`,
      [REAL_PROJECT_ID, CHAIN_SUBJECT, CHAIN_PREDICATE, CHAIN_OBJECT]
    );
    assert(rows.length === 3, `expected exactly 3 target rows after idempotent re-run, got ${rows.length}: ${JSON.stringify(rows)}`);
    const nLive = rows.filter((r) => r.suppressed === false).length;
    const nSuperseded = rows.filter((r) => r.suppressed === true && r.suppression_kind === 'superseded').length;
    assert(nLive === 1 && nSuperseded === 2, `expected 1 live + 2 superseded after re-run, got live=${nLive} superseded=${nSuperseded}`);
  });
  await run('H3', 'supersession-chain regression: MIGRATION_RESULT strictly reconciles (migrated === source_real) with the chain present -- T2-shaped proof', async () => {
    assert(/MIGRATION_RESULT: PASS \(source_real=\d+, migrated=\d+\)/.test(secondRunResult.stdout), `expected a PASS line with matching counts: ${secondRunResult.stdout}`);
    const m = secondRunResult.stdout.match(/MIGRATION_RESULT: PASS \(source_real=(\d+), migrated=(\d+)\)/);
    assert(m && m[1] === m[2], `expected source_real === migrated (strict reconciliation), got source_real=${m && m[1]} migrated=${m && m[2]}`);
  });
  await run('I3', 'second run: manifest slice rows replaced in place, not duplicated (still exactly 1 row per table/project pair)', async () => {
    const rows = await query(
      DB_TARGET,
      `SELECT source_table, COUNT(*) AS n FROM migration_manifest WHERE source_db=$1 AND project_id_or_null=$2 GROUP BY source_table`,
      [DB_SOURCE, REAL_PROJECT_ID]
    );
    for (const r of rows) {
      assert(Number(r.n) === 1, `expected exactly 1 manifest row for ${r.source_table}/${REAL_PROJECT_ID}, got ${r.n}`);
    }
  });

  // ── Genuine same-source-id divergence (history-collapse fix companion) ──
  await run('H4', 'genuine same-source-id divergence: editing an already-migrated row at the SOURCE is logged [CONTENT-DIVERGENCE] as informational and RE-SYNCED (never skipped, never a foreign-row false-positive)', async () => {
    const srcClient = await pgConnect(DB_SOURCE);
    try {
      await srcClient.query(`UPDATE assertions SET confidence = 9.5 WHERE id = $1`, [seeded.assertionId1]);
    } finally {
      await srcClient.end();
    }
    const r = runScript(['--db', DB_TARGET, '--source-db', DB_SOURCE, '--known-ids', KNOWN_IDS_PATH]);
    assert(r.status === 0, `expected exit 0 (a same-source-id re-sync is NEVER a foreign collision), got ${r.status}. stdout=${r.stdout} stderr=${r.stderr}`);
    assert(/MIGRATION_RESULT: PASS/.test(r.stdout), `expected PASS: ${r.stdout}`);
    assert(/\[CONTENT-DIVERGENCE\].*re-syncing/.test(r.stdout), `expected the informational genuine-divergence log line naming THIS as a re-sync: ${r.stdout}`);
    const rows = await query(
      DB_TARGET,
      `SELECT confidence FROM assertions WHERE project_id=$1 AND subject='widget' AND predicate='depends_on' AND object='gadget'`,
      [REAL_PROJECT_ID]
    );
    assert(rows.length === 1, `expected exactly 1 row (never duplicated by the re-sync), got ${rows.length}`);
    assert(Number(rows[0].confidence) === 9.5, `expected the target row to reflect the NEW source content (re-synced, never skipped), got ${rows[0].confidence}`);
  });

  // ── Content-divergence detection ────────────────────────────────────────
  await run('D1', 'a foreign row occupying a REAL slice\'s natural key with DIFFERENT content is logged [CONTENT-DIVERGENCE] and never overwritten', async () => {
    // Insert a FOREIGN (non-migration-owned) entities row sharing the same
    // (project_id, name) natural key as an entity that will migrate next
    // run, but with different content -- simulates live, non-migration
    // data occupying the slot.
    const client = await pgConnect(DB_TARGET);
    try {
      await client.query(
        `INSERT INTO entities (project_id, name, entity_type, description) VALUES ($1,'gizmo','system','LIVE foreign description')`,
        [REAL_PROJECT_ID]
      );
    } finally {
      await client.end();
    }
    const srcClient = await pgConnect(DB_SOURCE);
    try {
      await srcClient.query(
        `INSERT INTO entities (project_id, name, entity_type, description) VALUES ($1,'gizmo','system','MIGRATED description differs')`,
        [REAL_PROJECT_ID]
      );
    } finally {
      await srcClient.end();
    }
    const r = runScript(['--db', DB_TARGET, '--source-db', DB_SOURCE, '--known-ids', KNOWN_IDS_PATH]);
    // History-collapse fix (2026-08-16): MIGRATION_RESULT is now STRICT
    // (migrated === source_real) -- a genuine foreign-row skip on a REAL
    // DB-enforced natural key (entities) correctly makes this run's own
    // entities slice fall 1 short, so the script correctly reports FAIL
    // (exit 1) rather than silently passing over the collision. This is a
    // desired behavior change from the pre-fix "<=" gate, not a bug: an
    // unresolvable foreign-row collision IS an actionable problem an
    // operator needs surfaced, exactly like a real T2 shortfall would be.
    assert(r.status === 1, `expected exit 1 (a genuine foreign-row divergence must FAIL the strict reconciliation gate), got ${r.status}. stdout=${r.stdout} stderr=${r.stderr}`);
    assert(/MIGRATION_RESULT: FAIL/.test(r.stdout), `expected MIGRATION_RESULT: FAIL: ${r.stdout}`);
    assert(/\[CONTENT-DIVERGENCE\]/.test(r.stdout), `expected [CONTENT-DIVERGENCE] logged: stdout=${r.stdout}`);
    const rows = await query(DB_TARGET, `SELECT description FROM entities WHERE project_id=$1 AND name='gizmo'`, [REAL_PROJECT_ID]);
    assert(rows.length === 1, `expected the foreign row to remain exactly once (never overwritten, never duplicated), got ${rows.length}`);
    assert(rows[0].description === 'LIVE foreign description', `expected the FOREIGN row's content preserved untouched, got "${rows[0].description}"`);
    // Everything ELSE in this run still migrated correctly despite the one
    // FAIL-worthy collision -- the strict gate flags the problem, it does
    // not abort the whole run or roll back unrelated slices.
    const chainRows = await query(
      DB_TARGET,
      `SELECT id FROM assertions WHERE project_id=$1 AND subject=$2 AND predicate=$3 AND object=$4`,
      [REAL_PROJECT_ID, CHAIN_SUBJECT, CHAIN_PREDICATE, CHAIN_OBJECT]
    );
    assert(chainRows.length === 3, `expected the unrelated 3-row supersession chain to remain intact despite the entities collision, got ${chainRows.length}`);
  });

  // ── Rollback mode (manual, manifest-guided) ─────────────────────────────
  await run('B1', '--rollback deletes exactly this source\'s migrated real-slice rows via lineage, leaves the foreign gizmo row untouched', async () => {
    const r = runScript(['--db', DB_TARGET, '--source-db', DB_SOURCE, '--known-ids', KNOWN_IDS_PATH, '--rollback']);
    assert(r.status === 0, `expected exit 0, got ${r.status}. stdout=${r.stdout} stderr=${r.stderr}`);
    assert(/ROLLBACK_RESULT: PASS/.test(r.stdout), `expected ROLLBACK_RESULT: PASS: ${r.stdout}`);
    // The D1 test left TWO 'gizmo'-named-collision rows in play: a FOREIGN
    // one (inserted directly into target, never migration-owned) and a
    // migration attempt that was skipped (logged CONTENT-DIVERGENCE, never
    // written). Only 'widget' (this test file's originally-migrated entity)
    // is migration-owned and lineage-tracked -- rollback must remove exactly
    // that one, leaving the foreign 'gizmo' row untouched.
    const nEntities = await queryCount(DB_TARGET, `SELECT COUNT(*) AS n FROM entities WHERE project_id = $1`, [REAL_PROJECT_ID]);
    assert(nEntities === 1, `expected exactly 1 entity remaining after rollback (the FOREIGN 'gizmo' row, never migration-owned) -- got ${nEntities}`);
    const remaining = await query(DB_TARGET, `SELECT name, description FROM entities WHERE project_id = $1`, [REAL_PROJECT_ID]);
    assert(remaining[0].name === 'gizmo' && remaining[0].description === 'LIVE foreign description', `expected the surviving row to be the untouched foreign 'gizmo' row, got ${JSON.stringify(remaining)}`);
    const nManifest = await queryCount(DB_TARGET, `SELECT COUNT(*) AS n FROM migration_manifest WHERE source_db=$1 AND project_id_or_null=$2 AND excluded_reason IS NULL`, [DB_SOURCE, REAL_PROJECT_ID]);
    assert(nManifest === 0, `expected 0 non-excluded manifest rows remaining after rollback, got ${nManifest}`);
  });

  // ── Missing known-ids config ────────────────────────────────────────────
  await run('E1', 'missing known-ids config: loud FATAL exit 1, no DB connection needed to fail', () => {
    const r = runScript(['--db', DB_TARGET, '--source-db', DB_SOURCE, '--known-ids', path.join(TMP_DIR, 'does-not-exist.json')]);
    assert(r.status === 1, `expected exit 1, got ${r.status}`);
    assert(/FATAL/.test(r.stderr), `expected FATAL in stderr: ${r.stderr}`);
  });

  // ── Cleanup ──────────────────────────────────────────────────────────────
  await run('CLEANUP', 'scratch databases + tempfiles dropped', async () => {
    for (const db of CREATED_DBS) await dropDb(db);
    fs.rmSync(TMP_DIR, { recursive: true, force: true });
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(async (err) => {
  console.error('FATAL:', err && err.stack ? err.stack : err);
  for (const db of CREATED_DBS) await dropDb(db);
  process.exit(1);
});
