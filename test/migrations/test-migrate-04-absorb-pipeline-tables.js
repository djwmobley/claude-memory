'use strict';

/**
 * test-migrate-04-absorb-pipeline-tables.js
 *
 * Regression suite for scripts/migrations/migrate-04-absorb-pipeline-tables.js
 * (§6.1(e) + its E-1..E-15 amendment, mm#11(e)). Synthetic fixtures ONLY —
 * no real topic strings, no real db names beyond the already-public
 * `claude_policy_framework` literal (migrate-02-decisions.js's own hardcoded
 * default, not new leaked info), no real classifier rules.
 *
 * Covers:
 *   - db-triage.json total classification (E-1/E-8): REAL-MIGRATE/
 *     EPHEMERAL-DROP/OWNER-REVIEW/ENGINE-INFRA classification, UNCLASSIFIED
 *     default branch.
 *   - claude-context-topic-rules.json CONTAINS classifier (E-11):
 *     first-match-wins, excluded-bucket routing, unmatched-<word> fallback.
 *   - pipeline-db-project-map.json DB-level derivation + never-guessed
 *     unmapped-* fallback.
 *   - task_id total classification (E-10): null / valid-remappable /
 *     dangling-pre-existing.
 *   - column-shape precondition (point 2 of the script's header comment):
 *     an unmapped live column refuses loud rather than silently dropping.
 *   - lineage idempotency (E-6): a second insert attempt for the SAME
 *     source row is a no-op (skip via pipeline_migration_row_ids), a
 *     natural-key collision on `decisions` (E-3/E-12) disambiguates rather
 *     than drops.
 *   - rollback scoping (a real bug found + fixed authoring this script):
 *     rollback for one source db must never touch another migration
 *     script's manifest rows for the SAME source db, and must exclude the
 *     (claude_policy_framework, decisions) pair which stays phase (b)'s job
 *     in every mode.
 *
 * Self-contained: creates/drops its own `_staging`-suffixed scratch target
 * database and plain (non-`_staging`) scratch source databases; never
 * touches claude_policy_framework/pipeline_pipeline/claude_context/
 * memory_manager_staging/claude_memory_eval_test.
 *
 * Usage: node test/migrations/test-migrate-04-absorb-pipeline-tables.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { createRequire } = require('module');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const MIGRATE04_PATH = path.join(PROJECT_ROOT, 'scripts', 'migrations', 'migrate-04-absorb-pipeline-tables.js');
const migrate04 = require(MIGRATE04_PATH);

// The scripts/ workspace carries its own node_modules (pg, etc.) — resolved
// via createRequire the same way test-migrate-02-decisions.js does, since
// this test file lives under test/migrations/, outside that workspace.
const scriptsRequire = createRequire(require.resolve('../../scripts/package.json'));
const { Client } = scriptsRequire('pg');

// ─── HARNESS ────────────────────────────────────────────────────────────────

let passed = 0, failed = 0;
async function run(id, label, fn) {
  try {
    await fn();
    console.log(`  [PASS] ${id} ${label}`);
    passed++;
  } catch (err) {
    console.error(`  [FAIL] ${id} ${label}: ${err.message}`);
    failed++;
  }
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
  const sys = await pgConnect('postgres');
  try {
    await sys.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`, [dbName]);
    await sys.query(`DROP DATABASE IF EXISTS "${dbName}"`);
  } finally {
    await sys.end();
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

// ─── SYNTHETIC FIXTURES ─────────────────────────────────────────────────────

function writeTempJson(name, data) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'migrate04-test-'));
  const p = path.join(dir, name);
  fs.writeFileSync(p, JSON.stringify(data, null, 2), 'utf8');
  return p;
}

const SYNTH_DB_TRIAGE = writeTempJson('db-triage.json', {
  databases: {
    example_real_db: 'REAL-MIGRATE',
    example_ephemeral_db: 'EPHEMERAL-DROP',
    example_owner_review_db: 'OWNER-REVIEW',
    example_engine_db: 'ENGINE-INFRA',
  },
});

const SYNTH_PIPELINE_DB_MAP = writeTempJson('pipeline-db-project-map.json', {
  known_project_ids: ['example-project-alpha'],
  map: { example_mapped_db: 'example-project-alpha' },
});

const SYNTH_CLAUDE_CONTEXT_RULES = writeTempJson('claude-context-topic-rules.json', {
  rules: [
    { type: 'CONTAINS', pattern: 'acme-widget-portal', target: 'owner-review-acme-widget-portal', excluded_reason: 'owner-review-acme-widget-portal' },
    { type: 'CONTAINS', pattern: 'widget', target: 'unmatched-example-app' },
  ],
});

// ─── MAIN ───────────────────────────────────────────────────────────────────

async function main() {
  console.log('test-migrate-04-absorb-pipeline-tables: starting');

  // ── db-triage.json total classification (E-1/E-8) ──────────────────────
  await run('DBT-1', 'REAL-MIGRATE classified correctly', async () => {
    const triage = migrate04.loadDbTriage(SYNTH_DB_TRIAGE);
    assert(migrate04.classifyDb('example_real_db', triage) === 'REAL-MIGRATE', 'expected REAL-MIGRATE');
  });
  await run('DBT-2', 'EPHEMERAL-DROP classified correctly', async () => {
    const triage = migrate04.loadDbTriage(SYNTH_DB_TRIAGE);
    assert(migrate04.classifyDb('example_ephemeral_db', triage) === 'EPHEMERAL-DROP', 'expected EPHEMERAL-DROP');
  });
  await run('DBT-3', 'OWNER-REVIEW classified correctly', async () => {
    const triage = migrate04.loadDbTriage(SYNTH_DB_TRIAGE);
    assert(migrate04.classifyDb('example_owner_review_db', triage) === 'OWNER-REVIEW', 'expected OWNER-REVIEW');
  });
  await run('DBT-4', 'ENGINE-INFRA classified correctly', async () => {
    const triage = migrate04.loadDbTriage(SYNTH_DB_TRIAGE);
    assert(migrate04.classifyDb('example_engine_db', triage) === 'ENGINE-INFRA', 'expected ENGINE-INFRA');
  });
  await run('DBT-5', 'unlisted db is UNCLASSIFIED (default branch, never silently REAL-MIGRATE)', async () => {
    const triage = migrate04.loadDbTriage(SYNTH_DB_TRIAGE);
    assert(migrate04.classifyDb('some_never_seen_db', triage) === 'UNCLASSIFIED', 'expected UNCLASSIFIED default branch');
  });

  // ── pipeline-db-project-map.json DB-level derivation ────────────────────
  await run('PDM-1', 'mapped db resolves to its configured project_id', async () => {
    const map = migrate04.loadPipelineDbProjectMap(SYNTH_PIPELINE_DB_MAP);
    const r = migrate04.deriveDbLevelProjectId('example_mapped_db', map);
    assert(r.projectId === 'example-project-alpha', `expected example-project-alpha, got ${r.projectId}`);
    assert(r.excluded === false, 'a mapped db is never excluded');
  });
  await run('PDM-2', 'unmapped db falls to unmapped-pipeline-db-<name>, never guessed', async () => {
    const map = migrate04.loadPipelineDbProjectMap(SYNTH_PIPELINE_DB_MAP);
    const r = migrate04.deriveDbLevelProjectId('example_totally_unknown_db', map);
    assert(r.projectId === 'unmapped-pipeline-db-example_totally_unknown_db', `expected unmapped fallback, got ${r.projectId}`);
  });

  // ── claude-context-topic-rules.json CONTAINS classifier (E-11) ──────────
  await run('CCT-1', 'acme-widget-portal-shaped topic routes to the excluded bucket', async () => {
    const rules = migrate04.loadClaudeContextTopicRules(SYNTH_CLAUDE_CONTEXT_RULES);
    const r = migrate04.classifyClaudeContextTopic('acme-widget-portal search improvements', rules);
    assert(r.projectId === 'owner-review-acme-widget-portal', `expected owner-review-acme-widget-portal, got ${r.projectId}`);
    assert(r.excluded === true, 'acme-widget-portal-shaped topic must be excluded');
    assert(r.excludedReason === 'owner-review-acme-widget-portal', 'excludedReason must be set');
  });
  await run('CCT-2', 'CONTAINS match is case-insensitive', async () => {
    const rules = migrate04.loadClaudeContextTopicRules(SYNTH_CLAUDE_CONTEXT_RULES);
    const r = migrate04.classifyClaudeContextTopic('Some WIDGET launch plan', rules);
    assert(r.projectId === 'unmatched-example-app', `expected unmatched-example-app, got ${r.projectId}`);
    assert(r.excluded === false, 'a matched non-excluded rule must not be excluded');
  });
  await run('CCT-3', 'zero-match topic falls to unmatched-<first-word>, never guessed', async () => {
    const rules = migrate04.loadClaudeContextTopicRules(SYNTH_CLAUDE_CONTEXT_RULES);
    const r = migrate04.classifyClaudeContextTopic('Totally unrelated subject line', rules);
    assert(r.projectId === 'unmatched-totally', `expected unmatched-totally, got ${r.projectId}`);
    assert(r.excluded === false, 'unmatched fallback is never excluded');
  });
  await run('CCT-4', 'first-match-wins ordering respected', async () => {
    const rulesPath = writeTempJson('order-rules.json', {
      rules: [
        { type: 'CONTAINS', pattern: 'foo', target: 'first-target' },
        { type: 'CONTAINS', pattern: 'foobar', target: 'second-target' },
      ],
    });
    const rules = migrate04.loadClaudeContextTopicRules(rulesPath);
    const r = migrate04.classifyClaudeContextTopic('a foobar topic', rules);
    assert(r.projectId === 'first-target', `expected first-target (first rule wins), got ${r.projectId}`);
  });

  // ── task_id total classification (E-10) ──────────────────────────────────
  await run('TID-1', 'NULL task_id passes through as null', () => {
    const r = migrate04.classifyTaskId(null, new Map());
    assert(r.bucket === 'null' && r.value === null, `expected null bucket, got ${JSON.stringify(r)}`);
  });
  await run('TID-2', 'a mapped task_id remaps to its new id', () => {
    const map = new Map([['5', 105]]);
    const r = migrate04.classifyTaskId(5, map);
    assert(r.bucket === 'valid-remappable' && r.value === 105, `expected valid-remappable/105, got ${JSON.stringify(r)}`);
  });
  await run('TID-3', 'a non-NULL task_id with no map entry is dangling-pre-existing, nulled', () => {
    const r = migrate04.classifyTaskId(999, new Map());
    assert(r.bucket === 'dangling-pre-existing' && r.value === null, `expected dangling-pre-existing/null, got ${JSON.stringify(r)}`);
  });

  // ── column-shape precondition (point 2, header comment) ──────────────────
  await run('CSP-1', 'a fully-declared column set passes precondition', () => {
    const unmapped = migrate04.checkColumnShapePrecondition(['id', 'created_at', 'issue', 'rule'], { issue: 'issue', rule: 'rule' }, 'x', 'gotchas');
    assert(unmapped.length === 0, `expected clean precondition, got ${JSON.stringify(unmapped)}`);
  });
  await run('CSP-2', 'an undeclared live column is refused, never silently dropped', () => {
    const unmapped = migrate04.checkColumnShapePrecondition(['id', 'issue', 'rule', 'brand_new_column'], { issue: 'issue', rule: 'rule' }, 'x', 'gotchas');
    assert(unmapped.length === 1 && unmapped[0] === 'brand_new_column', `expected ['brand_new_column'], got ${JSON.stringify(unmapped)}`);
  });

  // ── sourceIdCol: code_index has no source `id` column ────────────────────
  await run('SID-1', 'code_index uses path as its source identity column', () => {
    assert(migrate04.sourceIdCol('code_index') === 'path', `expected path, got ${migrate04.sourceIdCol('code_index')}`);
  });
  await run('SID-2', 'every other table defaults to id', () => {
    assert(migrate04.sourceIdCol('decisions') === 'id', 'expected id');
    assert(migrate04.sourceIdCol('tasks') === 'id', 'expected id');
  });

  // ── LIVE DB: lineage idempotency + decisions disambiguation + rollback ──
  const TARGET_DB = `migrate04_test_${Date.now()}_staging`;
  const SRC_A = `migrate04_test_src_a_${Date.now()}`;

  await createDb(TARGET_DB);
  await createDb(SRC_A);
  try {
    const tgt = await pgConnect(TARGET_DB);
    try {
      // Minimal target schema: just what insertGenericRow/insertDecisionRow need.
      await tgt.query(`
        CREATE TABLE gotchas (
          id SERIAL PRIMARY KEY, project_id TEXT NOT NULL, issue TEXT NOT NULL,
          rule TEXT NOT NULL, source_model TEXT, authoring_mode TEXT
        );
        CREATE TABLE decisions (
          id SERIAL PRIMARY KEY, project_id TEXT NOT NULL, topic TEXT NOT NULL,
          decision TEXT NOT NULL, reason TEXT, source_model TEXT, authoring_mode TEXT
        );
        CREATE UNIQUE INDEX decisions_project_topic_unique ON decisions(project_id, topic);
      `);
      const shared = require(path.join(__dirname, '..', '..', 'scripts', 'migrations', 'lib', 'verify15-shared.js'));
      await shared.applyDdl(tgt); // migration_manifest + pipeline_migration_row_ids

      // insertGenericRow/insertDecisionRow issue their own internal
      // SAVEPOINT (designed to run inside an outer per-slice transaction,
      // as migrateTableSlice's BEGIN/COMMIT provides in production) -- each
      // direct call here needs the same outer transaction wrapper.
      async function withTxn(fn) {
        await tgt.query('BEGIN');
        try {
          const result = await fn();
          await tgt.query('COMMIT');
          return result;
        } catch (err) {
          await tgt.query('ROLLBACK');
          throw err;
        }
      }

      await run('LIN-1', 'first insert of a source row migrates and records lineage', async () => {
        const outcome = await withTxn(() => migrate04.insertGenericRow(tgt, SRC_A, 'gotchas', { id: 1, issue: 'i1', rule: 'r1' }, 'proj-x', { issue: 'issue', rule: 'rule' }, () => {}));
        assert(outcome === 'migrated', `expected migrated, got ${outcome}`);
        const { rows } = await tgt.query(`SELECT count(*)::int AS n FROM gotchas WHERE project_id='proj-x'`);
        assert(rows[0].n === 1, `expected 1 row, got ${rows[0].n}`);
      });
      await run('LIN-2', 'a second attempt at the SAME source row is a no-op (idempotent)', async () => {
        const outcome = await withTxn(() => migrate04.insertGenericRow(tgt, SRC_A, 'gotchas', { id: 1, issue: 'i1', rule: 'r1' }, 'proj-x', { issue: 'issue', rule: 'rule' }, () => {}));
        assert(outcome === 'already-migrated', `expected already-migrated, got ${outcome}`);
        const { rows } = await tgt.query(`SELECT count(*)::int AS n FROM gotchas WHERE project_id='proj-x'`);
        assert(rows[0].n === 1, `expected still 1 row (no duplicate), got ${rows[0].n}`);
      });
      await run('LIN-3', 'a DIFFERENT source row (distinct id) with identical content is a distinct migrated row (E-5: byte-identical siblings never collapse)', async () => {
        const outcome = await withTxn(() => migrate04.insertGenericRow(tgt, SRC_A, 'gotchas', { id: 2, issue: 'i1', rule: 'r1' }, 'proj-x', { issue: 'issue', rule: 'rule' }, () => {}));
        assert(outcome === 'migrated', `expected migrated, got ${outcome}`);
        const { rows } = await tgt.query(`SELECT count(*)::int AS n FROM gotchas WHERE project_id='proj-x'`);
        assert(rows[0].n === 2, `expected 2 rows (both distinct source ids survive), got ${rows[0].n}`);
      });

      await run('DEC-1', 'first decisions insert lands under its own topic', async () => {
        const outcome = await withTxn(() => migrate04.insertDecisionRow(tgt, SRC_A, { id: 10, topic: 'example-recurring-topic', decision: 'd1', reason: 'r1' }, 'proj-x', { topic: 'topic', decision: 'decision', reason: 'reason' }, () => {}));
        assert(outcome === 'migrated', `expected migrated, got ${outcome}`);
      });
      await run('DEC-2', 'a DISTINCT decisions row sharing the SAME topic gets a disambiguated topic, never dropped (E-3/E-12)', async () => {
        const outcome = await withTxn(() => migrate04.insertDecisionRow(tgt, SRC_A, { id: 11, topic: 'example-recurring-topic', decision: 'd2-different', reason: 'r2-different' }, 'proj-x', { topic: 'topic', decision: 'decision', reason: 'reason' }, () => {}));
        assert(outcome === 'migrated', `expected migrated (disambiguated), got ${outcome}`);
        const { rows } = await tgt.query(`SELECT count(*)::int AS n FROM decisions WHERE project_id='proj-x' AND topic LIKE 'example-recurring-topic%'`);
        assert(rows[0].n === 2, `expected 2 distinct rows preserved (never collapsed), got ${rows[0].n}`);
      });
      await run('DEC-3', 'an IDENTICAL-content collision is a benign coincidence, never duplicated', async () => {
        const outcome = await withTxn(() => migrate04.insertDecisionRow(tgt, SRC_A, { id: 12, topic: 'example-recurring-topic', decision: 'd1', reason: 'r1' }, 'proj-x', { topic: 'topic', decision: 'decision', reason: 'reason' }, () => {}));
        assert(outcome === 'benign-coincidence', `expected benign-coincidence, got ${outcome}`);
        const { rows } = await tgt.query(`SELECT count(*)::int AS n FROM decisions WHERE project_id='proj-x' AND topic LIKE 'example-recurring-topic%'`);
        assert(rows[0].n === 2, `expected still 2 rows (no duplicate of identical content), got ${rows[0].n}`);
      });
      await run('DEC-4', 're-running the SAME disambiguated-source-row is idempotent (already-migrated)', async () => {
        const outcome = await withTxn(() => migrate04.insertDecisionRow(tgt, SRC_A, { id: 11, topic: 'example-recurring-topic', decision: 'd2-different', reason: 'r2-different' }, 'proj-x', { topic: 'topic', decision: 'decision', reason: 'reason' }, () => {}));
        assert(outcome === 'already-migrated', `expected already-migrated, got ${outcome}`);
      });

      // ── Rollback scoping: must never touch a DIFFERENT source_table's
      // manifest rows for the same source_db (the real bug found authoring
      // this script -- migrate-03-corpus-project-id.js's memory_entries
      // manifest rows were destroyed by an unscoped rollback query).
      await run('ROL-1+2', 'rollback removes this script\'s own rows + lineage, never touches a foreign slice for the same source_db', async () => {
        const { rows: gBefore } = await tgt.query(`SELECT count(*)::int AS n FROM gotchas WHERE project_id='proj-x'`);
        assert(gBefore[0].n > 0, 'sanity: gotchas should have rows from LIN-1..3 before rollback');
        // Re-seed manifest rows for gotchas/decisions slices so rollback has
        // something to iterate (LIN-1..3/DEC-1..4 only exercised the insert
        // helpers directly, never migrateTableSlice's own manifest write) --
        // plus one FOREIGN slice (memory_entries, a table this script never
        // touches) simulating another migration script's bookkeeping for
        // the SAME source_db (the real bug found authoring this script:
        // migrate-03-corpus-project-id.js's memory_entries manifest rows
        // were destroyed by an earlier, unscoped rollback query).
        await tgt.query(`DELETE FROM migration_manifest WHERE source_db=$1 AND source_table IN ('gotchas','decisions','memory_entries')`, [SRC_A]);
        await tgt.query(
          `INSERT INTO migration_manifest (source_db, source_table, project_id_or_null, row_count, content_fingerprint, excluded_reason)
           VALUES ($1,'gotchas','proj-x',2,'x',NULL), ($1,'decisions','proj-x',3,'y',NULL), ($1,'memory_entries','some-other-project',3,'deadbeef',NULL)`,
          [SRC_A]
        );
        await migrate04.runRollback(tgt, [SRC_A], () => {});
        const { rows: gAfter } = await tgt.query(`SELECT count(*)::int AS n FROM gotchas WHERE project_id='proj-x'`);
        const { rows: dAfter } = await tgt.query(`SELECT count(*)::int AS n FROM decisions WHERE project_id='proj-x'`);
        assert(gAfter[0].n === 0, `expected gotchas rows removed by rollback, found ${gAfter[0].n}`);
        assert(dAfter[0].n === 0, `expected decisions rows removed by rollback, found ${dAfter[0].n}`);
        const { rows: foreign } = await tgt.query(
          `SELECT count(*)::int AS n FROM migration_manifest WHERE source_db=$1 AND source_table='memory_entries'`,
          [SRC_A]
        );
        assert(foreign[0].n === 1, `expected the foreign memory_entries manifest row to survive rollback, found ${foreign[0].n}`);
      });
    } finally {
      await tgt.end();
    }
  } finally {
    await dropDb(TARGET_DB);
    await dropDb(SRC_A);
  }

  console.log(`\nRESULT: ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err && err.stack ? err.stack : err);
    process.exit(1);
  });
}
