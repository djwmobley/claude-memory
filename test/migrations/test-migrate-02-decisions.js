'use strict';

/**
 * test-migrate-02-decisions.js — Test harness for
 * scripts/migrations/migrate-02-decisions.js (CONSOLIDATION-RUNBOOK.md
 * §6.1(b) + D-1..D-12 amendment, memory-manager#11(b)).
 *
 * Mirrors test-migrate-14-seam-tables.js's conventions: self-contained
 * scratch databases (target DBs "_staging"-suffixed to satisfy migrate-01's
 * own classifyTarget, reused by reference), unconditional cleanup, never
 * touches claude_policy_framework/memory_manager_staging.
 *
 * Covers:
 *   - classifyTopic: LITERAL vs WILDCARD precedence, first-match-wins,
 *     fallback bucket, single-token topics.
 *   - loadRoutingMap: D-12 validation (bad target not in known_project_ids
 *     and not an "unmatched-*" bucket -> loud FATAL, no DB connection
 *     ever opened).
 *   - Preconditions (D-3/D-4): a non-normalized topic and a duplicate
 *     topic each refuse loudly with NOTHING inserted.
 *   - Happy path: fresh migrate against a synthetic source `decisions`
 *     table covering every rule shape (LITERAL/WILDCARD/singleton/
 *     fallback) -> per-slice manifest rows + correctly classified
 *     decisions rows; idempotent re-run (no duplication).
 *   - Manifest transactionality: a deliberately-failing row mid-slice
 *     rolls back BOTH the decisions upserts AND the manifest writes for
 *     that slice (proof of atomicity against a FRESH database — CI has
 *     no staging).
 *   - Rollback mode (D-7/D-8): deletes exactly this source's migrated
 *     rows + manifest rows.
 *
 * Usage: node test/migrations/test-migrate-02-decisions.js
 * Exit 0 = all pass; nonzero = any failure.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { createRequire } = require('module');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const MIGRATE_ONE_PATH = path.join(PROJECT_ROOT, 'scripts', 'migrations', 'migrate-01-canonical-db.js');
const ADDENDA_PATH = path.join(PROJECT_ROOT, 'scripts', 'migrations', 'migrate-schema-addenda.js');
const MIGRATE13_PATH = path.join(PROJECT_ROOT, 'scripts', 'migrations', 'migrate-13-agent-exchange.js');
const MIGRATE14_PATH = path.join(PROJECT_ROOT, 'scripts', 'migrations', 'migrate-14-seam-tables.js');
const MIGRATE02_PATH = path.join(PROJECT_ROOT, 'scripts', 'migrations', 'migrate-02-decisions.js');
// The real topic-prefix-to-project.json is gitignored, private instance
// data — never present in CI (or any fresh checkout). This suite loads
// (and every migrate-02 invocation below is pointed explicitly at) the
// committed SYNTHETIC example instead, so the suite is fully self-
// contained and never depends on private data being present on disk.
const EXAMPLE_ROUTING_MAP_PATH = path.join(PROJECT_ROOT, 'scripts', 'migrations', 'topic-prefix-to-project.example.json');

const migrate02 = require(MIGRATE02_PATH);

const scriptsRequire = createRequire(require.resolve('../../scripts/package.json'));
const { Client } = scriptsRequire('pg');

const TS = Date.now();

let passed = 0;
let failed = 0;

function pass(id, label) { console.log(`[${id}] ${label} ... PASS`); passed++; }
function fail(id, label, reason) { console.log(`[${id}] ${label} ... FAIL: ${reason}`); failed++; }
async function run(id, label, fn) {
  try { await fn(); pass(id, label); } catch (err) { fail(id, label, err && err.message ? err.message : String(err)); }
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

function runMigrateOne(args, timeoutMs = 30000) {
  return spawnSync(process.execPath, [MIGRATE_ONE_PATH, ...args], { cwd: PROJECT_ROOT, env: process.env, encoding: 'utf8', timeout: timeoutMs });
}
function runAddenda(args, timeoutMs = 20000) {
  return spawnSync(process.execPath, [ADDENDA_PATH, ...args], { cwd: PROJECT_ROOT, env: process.env, encoding: 'utf8', timeout: timeoutMs });
}
function runMigrate13(args, timeoutMs = 20000) {
  return spawnSync(process.execPath, [MIGRATE13_PATH, ...args], { cwd: PROJECT_ROOT, env: process.env, encoding: 'utf8', timeout: timeoutMs });
}
function runMigrate14(args, timeoutMs = 20000) {
  return spawnSync(process.execPath, [MIGRATE14_PATH, ...args], { cwd: PROJECT_ROOT, env: process.env, encoding: 'utf8', timeout: timeoutMs });
}
// Every invocation is pointed at the committed synthetic example routing
// map by default (never the gitignored real file, which is absent in CI) —
// callers that need a DIFFERENT map (e.g. the D-12 bad-map test) simply
// pass their own --routing-map later in argv, which migrate-02's own
// parseArgs takes last-flag-wins on (each flag just overwrites parsed.*).
function runMigrate02(args, timeoutMs = 30000) {
  return spawnSync(process.execPath, [MIGRATE02_PATH, '--routing-map', EXAMPLE_ROUTING_MAP_PATH, ...args], { cwd: PROJECT_ROOT, env: process.env, encoding: 'utf8', timeout: timeoutMs });
}

async function setupTargetSchema(dbName) {
  const r1 = runMigrateOne(['--db', dbName]);
  if (r1.status !== 0) throw new Error(`migrate-01 fixture setup failed: status=${r1.status} stderr=${r1.stderr}`);
  const r2 = runAddenda(['--db', dbName]);
  if (r2.status !== 0) throw new Error(`schema-addenda fixture setup failed: status=${r2.status} stderr=${r2.stderr}`);
  const r3 = runMigrate13(['--db', dbName]);
  if (r3.status !== 0) throw new Error(`migrate-13 fixture setup failed: status=${r3.status} stdout=${r3.stdout} stderr=${r3.stderr}`);
  const r4 = runMigrate14(['--db', dbName]);
  if (r4.status !== 0) throw new Error(`migrate-14 fixture setup failed: status=${r4.status} stdout=${r4.stdout} stderr=${r4.stderr}`);
}

/** Creates a scratch "source" DB with a claude_policy_framework-shaped decisions table (no schema script ships that raw shape in this repo — the source is external infrastructure). */
async function setupSourceDb(dbName) {
  await createDb(dbName);
  const client = await pgConnect(dbName);
  try {
    await client.query(`
      CREATE TABLE decisions (
        id SERIAL PRIMARY KEY,
        session_num INTEGER,
        topic TEXT NOT NULL,
        decision TEXT NOT NULL,
        reason TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
  } finally {
    await client.end();
  }
}

async function insertSourceRows(dbName, rows) {
  const client = await pgConnect(dbName);
  try {
    for (const r of rows) {
      await client.query(
        `INSERT INTO decisions (session_num, topic, decision, reason) VALUES ($1,$2,$3,$4)`,
        [r.session_num ?? null, r.topic, r.decision, r.reason ?? null]
      );
    }
  } finally {
    await client.end();
  }
}

const DB_TARGET = `verify02_target_${TS}_staging`;
const DB_SOURCE_HAPPY = `verify02_src_happy_${TS}`;
const DB_SOURCE_BADTOPIC = `verify02_src_badtopic_${TS}`;
const DB_SOURCE_DUPE = `verify02_src_dupe_${TS}`;
const DB_SOURCE_TXN = `verify02_src_txn_${TS}`;
const DB_SOURCE_ROLLBACK = `verify02_src_rollback_${TS}`;
const DB_SOURCE_DRIFT_ADDED = `verify02_src_drift_added_${TS}`;   // rule-added: unmatched -> routed
const DB_SOURCE_DRIFT_REMOVED = `verify02_src_drift_removed_${TS}`; // rule-removed: routed -> unmatched
const CREATED_DBS = [DB_TARGET, DB_SOURCE_HAPPY, DB_SOURCE_BADTOPIC, DB_SOURCE_DUPE, DB_SOURCE_TXN, DB_SOURCE_ROLLBACK, DB_SOURCE_DRIFT_ADDED, DB_SOURCE_DRIFT_REMOVED];

const HAPPY_ROWS = [
  { topic: 'proj-alpha-foo-bar', decision: 'use approach A', reason: 'perf' },
  { topic: 'proj-alpha-baz', decision: 'use approach B', reason: null },
  { topic: 'proj-scan-init', decision: 'scan decision', reason: 'r' },
  { topic: 'proj-qa', decision: 'qa singleton decision', reason: null },
  { topic: 'proj-web-x', decision: 'web decision', reason: null },
  { topic: 'beta-svc-schema', decision: 'beta decision', reason: null },
  { topic: 'gamma-judge', decision: 'gamma judge decision', reason: null },
  { topic: 'gamma-phase-5', decision: 'gamma phase decision', reason: null },
  { topic: 'delta-widget-config', decision: 'delta decision', reason: null },
  { topic: 'delta-security', decision: 'delta security decision', reason: null },
  { topic: 'epsilon-tool-rule', decision: 'epsilon decision', reason: null },
  { topic: 'zeta-embed-x', decision: 'zeta embed decision', reason: null },
  { topic: 'cache-warmup-fix', decision: 'owner-review singleton', reason: null },
  { topic: 'totally-unknown-thing', decision: 'nobody knows', reason: null },
];
const HAPPY_ROW_COUNT = HAPPY_ROWS.length;

async function main() {
  // ── Group 1: pure classifyTopic unit tests (no DB) ─────────────────────
  await run('C1', 'classifyTopic: LITERAL match wins on first-two-dash-tokens', async () => {
    const map = { rules: [{ type: 'LITERAL', prefix: 'proj-alpha', target: 'proj-alpha' }] };
    const r = migrate02.classifyTopic('proj-alpha-foo-bar', map);
    assert(r.projectId === 'proj-alpha', `expected proj-alpha, got ${r.projectId}`);
    assert(r.sourceProjectHint === 'proj-alpha', `expected hint proj-alpha, got ${r.sourceProjectHint}`);
  });

  await run('C2', 'classifyTopic: WILDCARD matches on first-dash-token regardless of second token', async () => {
    const map = { rules: [{ type: 'WILDCARD', prefix: 'gamma', target: 'proj-gamma' }] };
    const r1 = migrate02.classifyTopic('gamma-judge', map);
    const r2 = migrate02.classifyTopic('gamma-phase-5', map);
    assert(r1.projectId === 'proj-gamma', `expected proj-gamma, got ${r1.projectId}`);
    assert(r2.projectId === 'proj-gamma', `expected proj-gamma, got ${r2.projectId}`);
  });

  await run('C3', 'classifyTopic: first-match-wins — earlier rule in array order shadows a later one that would also match', async () => {
    // Both a LITERAL "a-b" rule and a WILDCARD "a" rule could match "a-b-c".
    // Whichever is FIRST in the array wins — proven both directions.
    const mapLiteralFirst = { rules: [
      { type: 'LITERAL', prefix: 'a-b', target: 'literal-target' },
      { type: 'WILDCARD', prefix: 'a', target: 'wildcard-target' },
    ] };
    const mapWildcardFirst = { rules: [
      { type: 'WILDCARD', prefix: 'a', target: 'wildcard-target' },
      { type: 'LITERAL', prefix: 'a-b', target: 'literal-target' },
    ] };
    const r1 = migrate02.classifyTopic('a-b-c', mapLiteralFirst);
    const r2 = migrate02.classifyTopic('a-b-c', mapWildcardFirst);
    assert(r1.projectId === 'literal-target', `expected literal-target first, got ${r1.projectId}`);
    assert(r2.projectId === 'wildcard-target', `expected wildcard-target first, got ${r2.projectId}`);
  });

  await run('C4', 'classifyTopic: zero-rule-match falls to unmatched-<first-dash-token>', async () => {
    const map = { rules: [{ type: 'LITERAL', prefix: 'proj-alpha', target: 'proj-alpha' }] };
    const r = migrate02.classifyTopic('wiring-script-x', map);
    assert(r.projectId === 'unmatched-wiring', `expected unmatched-wiring, got ${r.projectId}`);
    assert(r.sourceProjectHint === 'wiring', `expected hint "wiring", got ${r.sourceProjectHint}`);
  });

  await run('C5', 'classifyTopic: single-token topic (no dash) still classifies via WILDCARD or fallback', async () => {
    const map = { rules: [{ type: 'WILDCARD', prefix: 'solo', target: 'Solo' }] };
    const r1 = migrate02.classifyTopic('solo', map);
    assert(r1.projectId === 'Solo', `expected Solo, got ${r1.projectId}`);
    const r2 = migrate02.classifyTopic('nodash', { rules: [] });
    assert(r2.projectId === 'unmatched-nodash', `expected unmatched-nodash, got ${r2.projectId}`);
  });

  await run('C6', 'classifyTopic: the committed synthetic example routing map classifies every documented rule shape correctly', async () => {
    const map = migrate02.loadRoutingMap(EXAMPLE_ROUTING_MAP_PATH);
    const cases = [
      ['proj-alpha-anything', 'proj-alpha'],
      ['proj-scan-x', 'proj-alpha'],
      ['proj-qa', 'proj-alpha'],
      ['proj-web-y', 'proj-alpha'],
      ['beta-svc-z', 'proj-beta-monolith'],
      ['gamma-anything-at-all', 'proj-gamma'],
      ['delta-anything-at-all', 'org.DeltaWidgetSupport'],
      ['epsilon-tool-rule', 'tool-epsilon'],
      ['zeta-embed-x', 'svc-zeta'],
      ['cache-warmup-fix', 'unmatched-cache-warmup'],
      ['readme-audit-x', 'unmatched-readme-audit'],
      ['first-pass-x', 'unmatched-first-pass'],
      ['legacy-tooling-x', 'unmatched-legacy-tooling'],
      ['draft-semantic-x', 'unmatched-draft-semantic'],
      ['wiring-script-x', 'unmatched-wiring-script'],
      ['never-seen-before-topic', 'unmatched-never'],
    ];
    for (const [topic, expected] of cases) {
      const r = migrate02.classifyTopic(topic, map);
      assert(r.projectId === expected, `topic "${topic}": expected "${expected}", got "${r.projectId}"`);
    }
  });

  // ── Group 2: loadRoutingMap D-12 validation (no DB connection ever opened) ──
  await run('D12', 'D-12: a rule target absent from known_project_ids and not an unmatched-* bucket refuses loud, before any DB connection', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'migrate02-badmap-'));
    const badMapPath = path.join(tmpDir, 'bad-routing-map.json');
    fs.writeFileSync(badMapPath, JSON.stringify({
      known_project_ids: ['proj-alpha'],
      rules: [{ type: 'LITERAL', prefix: 'foo', target: 'not-a-known-project' }],
    }));
    try {
      const r = runMigrate02(['--db', 'nonexistent_unreachable_staging', '--routing-map', badMapPath]);
      assert(r.status === 1, `expected exit 1, got ${r.status}. stdout=${r.stdout} stderr=${r.stderr}`);
      assert(/FATAL.*D-12/.test(r.stderr) || /not in known_project_ids/.test(r.stderr), `expected D-12 FATAL message. stderr=${r.stderr}`);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  // ── Fixture setup shared by the remaining (DB-backed) groups ────────────
  await run('SETUP', 'target + source scratch databases provisioned', async () => {
    await setupTargetSchema(DB_TARGET);
    await setupSourceDb(DB_SOURCE_HAPPY);
    await insertSourceRows(DB_SOURCE_HAPPY, HAPPY_ROWS);
    await setupSourceDb(DB_SOURCE_BADTOPIC);
    await insertSourceRows(DB_SOURCE_BADTOPIC, [{ topic: '  PROJ-ALPHA-Bad-Case  ', decision: 'x', reason: null }]);
    await setupSourceDb(DB_SOURCE_DUPE);
    await insertSourceRows(DB_SOURCE_DUPE, [
      { topic: 'proj-alpha-dupe', decision: 'first', reason: null },
      { topic: 'proj-alpha-dupe', decision: 'second', reason: null },
    ]);
    await setupSourceDb(DB_SOURCE_ROLLBACK);
    await insertSourceRows(DB_SOURCE_ROLLBACK, [{ topic: 'proj-alpha-rollback-me', decision: 'temp', reason: null }]);
    // Distinct topic literals per drift test -- the (project_id, topic)
    // upsert key means two DIFFERENT sources landing the SAME topic under
    // the SAME project_id (as R2 and R3 both eventually route "proj-real")
    // would collide and conflate into one row, corrupting each test's
    // assertions about its own source's slice. Globally-unique topics
    // sidestep that (an orthogonal, pre-existing multi-source-collision
    // limitation of this schema, not something this fix needs to solve).
    await setupSourceDb(DB_SOURCE_DRIFT_ADDED);
    await insertSourceRows(DB_SOURCE_DRIFT_ADDED, [{ topic: 'cache-warmup-fix-added', decision: 'x', reason: null }]);
    await setupSourceDb(DB_SOURCE_DRIFT_REMOVED);
    await insertSourceRows(DB_SOURCE_DRIFT_REMOVED, [{ topic: 'cache-warmup-fix-removed', decision: 'x', reason: null }]);
  });

  // ── Group 3: preconditions (D-3/D-4) — loud FAIL, nothing inserted ──────
  await run('P1', 'D-3: a non-normalized topic (mixed case / untrimmed) refuses loud, nothing inserted', async () => {
    const r = runMigrate02(['--db', DB_TARGET, '--source-db', DB_SOURCE_BADTOPIC]);
    assert(r.status === 1, `expected exit 1, got ${r.status}. stdout=${r.stdout} stderr=${r.stderr}`);
    assert(/Refused \(D-3\)/.test(r.stderr), `expected D-3 refusal. stderr=${r.stderr}`);
    const client = await pgConnect(DB_TARGET);
    try {
      const { rows } = await client.query(`SELECT COUNT(*) AS n FROM migration_manifest WHERE source_db = $1`, [DB_SOURCE_BADTOPIC]);
      assert(Number(rows[0].n) === 0, `expected zero manifest rows for badtopic source, found ${rows[0].n}`);
    } finally {
      await client.end();
    }
  });

  await run('P2', 'D-4/M-1: duplicate topics in source refuse loud, nothing inserted', async () => {
    const r = runMigrate02(['--db', DB_TARGET, '--source-db', DB_SOURCE_DUPE]);
    assert(r.status === 1, `expected exit 1, got ${r.status}. stdout=${r.stdout} stderr=${r.stderr}`);
    assert(/Refused \(D-4\/M-1\)/.test(r.stderr), `expected D-4/M-1 refusal. stderr=${r.stderr}`);
    const client = await pgConnect(DB_TARGET);
    try {
      const { rows } = await client.query(`SELECT COUNT(*) AS n FROM migration_manifest WHERE source_db = $1`, [DB_SOURCE_DUPE]);
      assert(Number(rows[0].n) === 0, `expected zero manifest rows for dupe source, found ${rows[0].n}`);
    } finally {
      await client.end();
    }
  });

  // ── Group 4: happy path + idempotent re-run ─────────────────────────────
  await run('H1', 'fresh migrate: exit 0, MIGRATION_RESULT PASS, per-slice manifest + decisions rows correct', async () => {
    const r = runMigrate02(['--db', DB_TARGET, '--source-db', DB_SOURCE_HAPPY]);
    assert(r.status === 0, `expected exit 0, got ${r.status}. stdout=${r.stdout} stderr=${r.stderr}`);
    assert(/MIGRATION_RESULT: PASS/.test(r.stdout), `expected PASS. stdout=${r.stdout}`);

    const client = await pgConnect(DB_TARGET);
    try {
      const { rows: manifestRows } = await client.query(
        `SELECT project_id_or_null, row_count FROM migration_manifest WHERE source_db = $1 ORDER BY project_id_or_null`,
        [DB_SOURCE_HAPPY]
      );
      const byProject = Object.fromEntries(manifestRows.map((r) => [r.project_id_or_null, Number(r.row_count)]));
      // proj-alpha slice = 2 proj-alpha-literal rows + proj-scan + proj-qa + proj-web = 5.
      assert(byProject['proj-alpha'] === 5, `expected proj-alpha slice=5, got ${byProject['proj-alpha']}`);
      assert(byProject['proj-beta-monolith'] === 1, `expected proj-beta-monolith slice=1, got ${byProject['proj-beta-monolith']}`);
      assert(byProject['proj-gamma'] === 2, `expected proj-gamma slice=2, got ${byProject['proj-gamma']}`);
      assert(byProject['org.DeltaWidgetSupport'] === 2, `expected org.DeltaWidgetSupport slice=2, got ${byProject['org.DeltaWidgetSupport']}`);
      assert(byProject['tool-epsilon'] === 1, `expected tool-epsilon slice=1, got ${byProject['tool-epsilon']}`);
      assert(byProject['svc-zeta'] === 1, `expected svc-zeta slice=1, got ${byProject['svc-zeta']}`);
      assert(byProject['unmatched-cache-warmup'] === 1, `expected unmatched-cache-warmup slice=1, got ${byProject['unmatched-cache-warmup']}`);
      assert(byProject['unmatched-totally'] === 1, `expected unmatched-totally slice=1, got ${byProject['unmatched-totally']}`);
      const total = Object.values(byProject).reduce((a, b) => a + b, 0);
      assert(total === HAPPY_ROW_COUNT, `expected total migrated rows=${HAPPY_ROW_COUNT}, got ${total}`);
    } finally {
      await client.end();
    }
  });

  await run('H2', 'decisions rows carry correct project_id/source_project_hint/source_model/authoring_mode', async () => {
    const client = await pgConnect(DB_TARGET);
    try {
      const { rows } = await client.query(
        `SELECT project_id, topic, source_project_hint, source_model, authoring_mode FROM decisions WHERE topic = 'gamma-judge'`
      );
      assert(rows.length === 1, `expected exactly 1 row for gamma-judge, found ${rows.length}`);
      const row = rows[0];
      assert(row.project_id === 'proj-gamma', `expected project_id=proj-gamma, got ${row.project_id}`);
      assert(row.source_project_hint === 'gamma', `expected hint=gamma, got ${row.source_project_hint}`);
      assert(row.source_model === 'unknown-pre-migration', `expected source_model tag, got ${row.source_model}`);
      assert(row.authoring_mode === 'verbose', `expected authoring_mode=verbose, got ${row.authoring_mode}`);

      const { rows: unmatchedRows } = await client.query(`SELECT project_id FROM decisions WHERE topic = 'totally-unknown-thing'`);
      assert(unmatchedRows.length === 1 && unmatchedRows[0].project_id === 'unmatched-totally', `expected unmatched-totally, got ${JSON.stringify(unmatchedRows)}`);
    } finally {
      await client.end();
    }
  });

  await run('H3', 'unique index decisions_project_topic_unique exists with the exact required name', async () => {
    const client = await pgConnect(DB_TARGET);
    try {
      const { rows } = await client.query(
        `SELECT indexdef FROM pg_indexes WHERE schemaname = current_schema() AND indexname = 'decisions_project_topic_unique'`
      );
      assert(rows.length === 1, 'expected decisions_project_topic_unique index to exist');
      assert(/UNIQUE/i.test(rows[0].indexdef), `expected a UNIQUE index, got: ${rows[0].indexdef}`);
    } finally {
      await client.end();
    }
  });

  await run('H4', 'idempotent re-run: same source content re-run does not duplicate decisions or manifest rows', async () => {
    const before = await pgConnect(DB_TARGET);
    let beforeDecisions, beforeManifest;
    try {
      beforeDecisions = (await before.query(`SELECT COUNT(*) AS n FROM decisions`)).rows[0].n;
      beforeManifest = (await before.query(`SELECT COUNT(*) AS n FROM migration_manifest WHERE source_db = $1`, [DB_SOURCE_HAPPY])).rows[0].n;
    } finally {
      await before.end();
    }

    const r = runMigrate02(['--db', DB_TARGET, '--source-db', DB_SOURCE_HAPPY]);
    assert(r.status === 0, `expected exit 0 on re-run, got ${r.status}. stdout=${r.stdout} stderr=${r.stderr}`);
    assert(/MIGRATION_RESULT: PASS/.test(r.stdout), `expected PASS on re-run. stdout=${r.stdout}`);

    const after = await pgConnect(DB_TARGET);
    try {
      const afterDecisions = (await after.query(`SELECT COUNT(*) AS n FROM decisions`)).rows[0].n;
      const afterManifest = (await after.query(`SELECT COUNT(*) AS n FROM migration_manifest WHERE source_db = $1`, [DB_SOURCE_HAPPY])).rows[0].n;
      assert(afterDecisions === beforeDecisions, `expected decisions count unchanged on re-run: before=${beforeDecisions} after=${afterDecisions}`);
      assert(afterManifest === beforeManifest, `expected manifest slice count unchanged on re-run: before=${beforeManifest} after=${afterManifest}`);
    } finally {
      await after.end();
    }
  });

  // ── Group 5: manifest transactionality against a FRESH database ────────
  await run('T1', 'upsertSlice: a mid-slice failure rolls back BOTH the decisions upserts AND the manifest writes (proof of atomicity)', async () => {
    const client = await pgConnect(DB_TARGET);
    try {
      const sourceDb = 'txn-proof-source';
      const projectId = 'txn-proof-project';
      const goodRow = { id: 9001, session_num: null, topic: 'txn-proof-good', decision: 'ok', reason: null, sourceProjectHint: 'txn' };
      // topic: null violates decisions.topic NOT NULL -- forces an error
      // mid-loop, AFTER the first (good) row's INSERT has already run inside
      // the SAME transaction.
      const badRow = { id: 9002, session_num: null, topic: null, decision: 'boom', reason: null, sourceProjectHint: 'txn' };

      let threw = false;
      try {
        await migrate02.upsertSlice(client, sourceDb, projectId, [goodRow, badRow]);
      } catch (_) {
        threw = true;
      }
      assert(threw, 'expected upsertSlice to throw on the constraint-violating row');

      const { rows: decRows } = await client.query(`SELECT COUNT(*) AS n FROM decisions WHERE project_id = $1`, [projectId]);
      assert(Number(decRows[0].n) === 0, `expected ZERO decisions rows after rollback, found ${decRows[0].n} — transaction did not roll back atomically`);

      const { rows: manRows } = await client.query(`SELECT COUNT(*) AS n FROM migration_manifest WHERE source_db = $1`, [sourceDb]);
      assert(Number(manRows[0].n) === 0, `expected ZERO manifest rows after rollback, found ${manRows[0].n} — manifest write escaped the transaction`);
    } finally {
      await client.end();
    }
  });

  // ── Group 6: rollback mode (D-7/D-8) ────────────────────────────────────
  await run('R1', 'rollback mode: migrate then roll back — decisions + manifest + row_hashes all removed for this source', async () => {
    const migrateResult = runMigrate02(['--db', DB_TARGET, '--source-db', DB_SOURCE_ROLLBACK]);
    assert(migrateResult.status === 0, `expected exit 0 on migrate, got ${migrateResult.status}. stdout=${migrateResult.stdout} stderr=${migrateResult.stderr}`);

    const rollbackResult = runMigrate02(['--db', DB_TARGET, '--source-db', DB_SOURCE_ROLLBACK, '--rollback']);
    assert(rollbackResult.status === 0, `expected exit 0 on rollback, got ${rollbackResult.status}. stdout=${rollbackResult.stdout} stderr=${rollbackResult.stderr}`);
    assert(/ROLLBACK_RESULT: PASS/.test(rollbackResult.stdout), `expected ROLLBACK_RESULT PASS. stdout=${rollbackResult.stdout}`);

    const client = await pgConnect(DB_TARGET);
    try {
      const { rows: decRows } = await client.query(`SELECT COUNT(*) AS n FROM decisions WHERE topic = 'proj-alpha-rollback-me'`);
      assert(Number(decRows[0].n) === 0, `expected the rolled-back decision row to be gone, found ${decRows[0].n}`);
      const { rows: manRows } = await client.query(`SELECT COUNT(*) AS n FROM migration_manifest WHERE source_db = $1`, [DB_SOURCE_ROLLBACK]);
      assert(Number(manRows[0].n) === 0, `expected zero manifest rows for the rolled-back source, found ${manRows[0].n}`);
      const { rows: hashRows } = await client.query(`SELECT COUNT(*) AS n FROM migration_manifest_row_hashes WHERE source_db = $1`, [DB_SOURCE_ROLLBACK]);
      assert(Number(hashRows[0].n) === 0, `expected zero row_hashes rows for the rolled-back source, found ${hashRows[0].n}`);

      // The unrelated happy-path source's rows must survive untouched.
      const { rows: happyRows } = await client.query(`SELECT COUNT(*) AS n FROM decisions WHERE topic = 'gamma-judge'`);
      assert(Number(happyRows[0].n) === 1, `expected the unrelated happy-path source's row to survive, found ${happyRows[0].n}`);
    } finally {
      await client.end();
    }
  });

  // ── Group 7: reconciliation (review-round-1 fix) — re-classification drift ──
  // Reproduces the independent reviewer's finding in BOTH directions: a
  // topic's derived project_id changing between two runs (the documented
  // D-2 owner-review workflow: fix an unmatched-* bucket's rule and
  // re-run, or the inverse — a rule removed drops a topic back to
  // unmatched-*). Asserts single-row-per-topic, the old slice's full
  // removal (manifest + row_hashes), and slice-set equality — the three
  // things the old code silently got wrong while still printing
  // MIGRATION_RESULT: PASS on both runs.
  const driftTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'migrate02-drift-'));
  const MAP_UNMATCHED_PATH = path.join(driftTmpDir, 'map-unmatched.json');
  const MAP_ROUTED_PATH = path.join(driftTmpDir, 'map-routed.json');
  fs.writeFileSync(MAP_UNMATCHED_PATH, JSON.stringify({
    known_project_ids: ['placeholder-project'],
    rules: [{ type: 'LITERAL', prefix: 'cache-warmup', target: 'unmatched-cache-warmup' }],
  }));
  fs.writeFileSync(MAP_ROUTED_PATH, JSON.stringify({
    known_project_ids: ['proj-real'],
    rules: [{ type: 'LITERAL', prefix: 'cache-warmup', target: 'proj-real' }],
  }));

  await run('R2', 'reconciliation: rule ADDED (unmatched-* -> routed) — old slice fully removed, single row under the new project_id', async () => {
    const firstRun = runMigrate02(['--db', DB_TARGET, '--source-db', DB_SOURCE_DRIFT_ADDED, '--routing-map', MAP_UNMATCHED_PATH]);
    assert(firstRun.status === 0, `expected exit 0 on first run, got ${firstRun.status}. stdout=${firstRun.stdout} stderr=${firstRun.stderr}`);
    assert(/MIGRATION_RESULT: PASS/.test(firstRun.stdout), `expected PASS on first run. stdout=${firstRun.stdout}`);

    const secondRun = runMigrate02(['--db', DB_TARGET, '--source-db', DB_SOURCE_DRIFT_ADDED, '--routing-map', MAP_ROUTED_PATH]);
    assert(secondRun.status === 0, `expected exit 0 on second (re-classified) run, got ${secondRun.status}. stdout=${secondRun.stdout} stderr=${secondRun.stderr}`);
    assert(/MIGRATION_RESULT: PASS/.test(secondRun.stdout), `expected PASS on second run. stdout=${secondRun.stdout}`);
    assert(/\[RECLASSIFY\] topic="cache-warmup-fix-added"/.test(secondRun.stdout), `expected a [RECLASSIFY] log line on the second run. stdout=${secondRun.stdout}`);
    assert(/\[RECONCILE\] removed orphaned migration_manifest slice project_id="unmatched-cache-warmup"/.test(secondRun.stdout), `expected a [RECONCILE] log line removing the vacated unmatched-cache-warmup slice. stdout=${secondRun.stdout}`);

    const client = await pgConnect(DB_TARGET);
    try {
      const { rows: decRows } = await client.query(`SELECT project_id FROM decisions WHERE topic = 'cache-warmup-fix-added'`);
      assert(decRows.length === 1, `expected exactly 1 decisions row for topic, found ${decRows.length}`);
      assert(decRows[0].project_id === 'proj-real', `expected project_id=proj-real, got ${decRows[0].project_id}`);

      const { rows: manRows } = await client.query(
        `SELECT project_id_or_null FROM migration_manifest WHERE source_db = $1 AND source_table = 'decisions'`,
        [DB_SOURCE_DRIFT_ADDED]
      );
      assert(manRows.length === 1, `expected exactly 1 manifest slice, found ${manRows.length}: ${JSON.stringify(manRows)}`);
      assert(manRows[0].project_id_or_null === 'proj-real', `expected the sole manifest slice to be proj-real, got ${manRows[0].project_id_or_null}`);

      const { rows: staleManRows } = await client.query(
        `SELECT 1 FROM migration_manifest WHERE source_db = $1 AND source_table = 'decisions' AND project_id_or_null = 'unmatched-cache-warmup'`,
        [DB_SOURCE_DRIFT_ADDED]
      );
      assert(staleManRows.length === 0, 'expected the old unmatched-cache-warmup manifest slice to be gone');
      const { rows: staleHashRows } = await client.query(
        `SELECT 1 FROM migration_manifest_row_hashes WHERE source_db = $1 AND source_table = 'decisions' AND project_id_or_null = 'unmatched-cache-warmup'`,
        [DB_SOURCE_DRIFT_ADDED]
      );
      assert(staleHashRows.length === 0, 'expected the old unmatched-cache-warmup row_hashes to be gone');

      // An unrelated source's slices must be untouched by the orphan cleanup
      // (proves the DELETE is scoped by source_db, not global).
      const { rows: happyRows } = await client.query(`SELECT COUNT(*) AS n FROM decisions WHERE topic = 'gamma-judge'`);
      assert(Number(happyRows[0].n) === 1, `expected the unrelated happy-path source's row to survive, found ${happyRows[0].n}`);
      const { rows: happyManRows } = await client.query(
        `SELECT COUNT(*) AS n FROM migration_manifest WHERE source_db = $1 AND source_table = 'decisions'`,
        [DB_SOURCE_HAPPY]
      );
      assert(Number(happyManRows[0].n) > 0, 'expected the unrelated happy-path source to still have its manifest slices');
    } finally {
      await client.end();
    }
  });

  await run('R3', 'reconciliation: rule REMOVED (routed -> unmatched-*) — inverse direction, same three guarantees', async () => {
    const firstRun = runMigrate02(['--db', DB_TARGET, '--source-db', DB_SOURCE_DRIFT_REMOVED, '--routing-map', MAP_ROUTED_PATH]);
    assert(firstRun.status === 0, `expected exit 0 on first run, got ${firstRun.status}. stdout=${firstRun.stdout} stderr=${firstRun.stderr}`);
    assert(/MIGRATION_RESULT: PASS/.test(firstRun.stdout), `expected PASS on first run. stdout=${firstRun.stdout}`);

    const secondRun = runMigrate02(['--db', DB_TARGET, '--source-db', DB_SOURCE_DRIFT_REMOVED, '--routing-map', MAP_UNMATCHED_PATH]);
    assert(secondRun.status === 0, `expected exit 0 on second (re-classified) run, got ${secondRun.status}. stdout=${secondRun.stdout} stderr=${secondRun.stderr}`);
    assert(/MIGRATION_RESULT: PASS/.test(secondRun.stdout), `expected PASS on second run. stdout=${secondRun.stdout}`);
    assert(/\[RECLASSIFY\] topic="cache-warmup-fix-removed"/.test(secondRun.stdout), `expected a [RECLASSIFY] log line on the second run. stdout=${secondRun.stdout}`);
    assert(/\[RECONCILE\] removed orphaned migration_manifest slice project_id="proj-real"/.test(secondRun.stdout), `expected a [RECONCILE] log line removing the vacated proj-real slice. stdout=${secondRun.stdout}`);

    const client = await pgConnect(DB_TARGET);
    try {
      const { rows: decRows } = await client.query(`SELECT project_id FROM decisions WHERE topic = 'cache-warmup-fix-removed'`);
      assert(decRows.length === 1, `expected exactly 1 decisions row for topic, found ${decRows.length}`);
      assert(decRows[0].project_id === 'unmatched-cache-warmup', `expected project_id=unmatched-cache-warmup, got ${decRows[0].project_id}`);

      const { rows: manRows } = await client.query(
        `SELECT project_id_or_null FROM migration_manifest WHERE source_db = $1 AND source_table = 'decisions'`,
        [DB_SOURCE_DRIFT_REMOVED]
      );
      assert(manRows.length === 1, `expected exactly 1 manifest slice, found ${manRows.length}: ${JSON.stringify(manRows)}`);
      assert(manRows[0].project_id_or_null === 'unmatched-cache-warmup', `expected the sole manifest slice to be unmatched-cache-warmup, got ${manRows[0].project_id_or_null}`);

      const { rows: staleManRows } = await client.query(
        `SELECT 1 FROM migration_manifest WHERE source_db = $1 AND source_table = 'decisions' AND project_id_or_null = 'proj-real'`,
        [DB_SOURCE_DRIFT_REMOVED]
      );
      assert(staleManRows.length === 0, 'expected the old proj-real manifest slice to be gone');
    } finally {
      await client.end();
    }
  });

  fs.rmSync(driftTmpDir, { recursive: true, force: true });

  // ── Cleanup ──────────────────────────────────────────────────────────
  for (const db of CREATED_DBS) {
    await dropDb(db);
  }

  console.log('');
  console.log(`TOTAL: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
