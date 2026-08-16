'use strict';

/**
 * test-migrate-08-handoff-markdown.js — DB integration test harness for
 * scripts/migrations/migrate-08-handoff-markdown.js (CONSOLIDATION-
 * RUNBOOK.md §6.1(h) + H-1..H-14 amendment, memory-manager#11(h)).
 *
 * Mirrors test-migrate-02-decisions.js's conventions: self-contained
 * scratch database ("_staging"-suffixed to satisfy migrate-01's own
 * classifyTarget, reused by reference), unconditional cleanup. Fixture
 * HANDOFF.md / HANDOFF-HISTORY.md files are written to a scratch temp
 * directory per run — SYNTHETIC content only (invented project/session
 * names), never a real file, per H-13.
 *
 * Covers:
 *   - Happy path: both files present -> session_tldr_archived (both
 *     files' blocks survive, proving the H-6 whole-project delete does
 *     NOT clobber across slices sharing the session_tldr_archived
 *     predicate), open_thread (all carryover_status='open'), pinned
 *     durable-section rows, next_step rows with seq.
 *   - H-1: session_tldr_archived is written, NEVER live session_tldr;
 *     created_at is backdated to the parsed session date.
 *   - H-4: every open_thread row is carryover_status='open'.
 *   - Idempotent re-run: identical content re-run produces the identical
 *     row set (no duplication).
 *   - Content-shrink re-run: a next_step item removed between runs is
 *     actually gone after re-running (proves the H-6 delete-and-reinsert
 *     mechanism, not an accreting upsert).
 *   - Fail-soft: one file missing, migration still succeeds on the other.
 *   - Rollback: deletes exactly this project's tagged rows.
 *   - Manifest: per-slice migration_manifest rows with correct row_count
 *     and filesystem:-prefixed, H-14-normalized source_db.
 *   - DDL preamble: `seq` and `authoring_mode` columns actually land on
 *     `assertions`.
 *
 * Usage: node test/migrations/test-migrate-08-handoff-markdown.js
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
const MIGRATE08_PATH = path.join(PROJECT_ROOT, 'scripts', 'migrations', 'migrate-08-handoff-markdown.js');

const scriptsRequire = createRequire(require.resolve('../../scripts/package.json'));
const { Client } = scriptsRequire('pg');

const { normalizeFsPath } = require(path.join(PROJECT_ROOT, 'scripts', 'lib', 'fs-path-normalize.js'));

const TS = Date.now();

let passed = 0;
let failed = 0;
function pass(id, label) { console.log(`[${id}] ${label} ... PASS`); passed++; }
function fail(id, label, reason) { console.log(`[${id}] ${label} ... FAIL: ${reason}`); failed++; }
async function run(id, label, fn) {
  try { await fn(); pass(id, label); } catch (err) { fail(id, label, err && err.message ? err.message : String(err)); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }
function assertEq(actual, expected, msg) {
  if (actual !== expected) throw new Error(`${msg}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

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

function runMigrateOne(args, timeoutMs = 30000) {
  return spawnSync(process.execPath, [MIGRATE_ONE_PATH, ...args], { cwd: PROJECT_ROOT, env: process.env, encoding: 'utf8', timeout: timeoutMs });
}
function runAddenda(args, timeoutMs = 20000) {
  return spawnSync(process.execPath, [ADDENDA_PATH, ...args], { cwd: PROJECT_ROOT, env: process.env, encoding: 'utf8', timeout: timeoutMs });
}
function runMigrate08(args, timeoutMs = 30000) {
  return spawnSync(process.execPath, [MIGRATE08_PATH, ...args], { cwd: PROJECT_ROOT, env: process.env, encoding: 'utf8', timeout: timeoutMs });
}

async function setupTargetSchema(dbName) {
  const r1 = runMigrateOne(['--db', dbName]);
  if (r1.status !== 0) throw new Error(`migrate-01 fixture setup failed: status=${r1.status} stderr=${r1.stderr}`);
  // attribution-columns.sql (source_model/agent_id) + migrate-06-carryover-
  // status.sql (carryover_status) both land via migrate-schema-addenda.js —
  // migrate-01 alone does not carry either column.
  const r2 = runAddenda(['--db', dbName]);
  if (r2.status !== 0) throw new Error(`schema-addenda fixture setup failed: status=${r2.status} stderr=${r2.stderr}`);
}

const DB_TARGET = `verify08_target_${TS}_staging`;
const CREATED_DBS = [DB_TARGET];

const SCRATCH_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'migrate08-fixtures-'));

const PROJECT_A = `example-project-alpha-${TS}`;

// ── Synthetic fixtures (invented content only, per H-13) ──────────────────

const HANDOFF_MD = [
  '## NEXT SESSION',
  '',
  '1. [ ] Finish the widget parser refactor',
  '   continuation detail about the widget refactor',
  '   - nested sub bullet about the widget refactor',
  '2. Ship the example doc update',
  '',
  '## Session 3 — 2026-01-05 — Fixed the example bug',
  '',
  '### Done',
  '- did an example thing',
  '',
  '### Ceiling',
  '- blocked on example thing',
  '',
  '### Open carry-overs',
  '',
  '| Subject | Detail |',
  '|---|---|',
  '| EXAMPLE-THREAD-ALPHA: something | do the example alpha thing |',
  '| EXAMPLE-THREAD-BETA: other | do the example beta thing |',
  '',
  '## Run commands',
  '',
  'npm run example-test',
  '',
  '## Critical operational notes',
  '',
  'Never run the example destroy script in prod.',
  '',
  '## Key paths',
  '',
  '`example/path/to/file.js`',
  '',
].join('\n');

const HANDOFF_HISTORY_MD = [
  '## Session 2 — 2026-01-01 — Set up the example scaffold',
  '',
  '### Done',
  '- scaffolded the example project',
  '',
  '### Open carry-overs',
  '',
  '| Subject | Detail |',
  '|---|---|',
  '| EXAMPLE-THREAD-GAMMA: legacy | resolved in a later session, still open by construction |',
  '',
  '## Session 1 — 2025-12-20 — Initial example commit',
  '',
  '### Done',
  '- initial example commit',
  '',
  '### Open carry-overs',
  '',
  '_(no open carry-overs)_',
  '',
].join('\n');

function writeFixture(name, content) {
  const p = path.join(SCRATCH_DIR, name);
  fs.writeFileSync(p, content, 'utf8');
  return p;
}

async function main() {
  const activeFilePath = writeFixture('HANDOFF.md', HANDOFF_MD);
  const historyFilePath = writeFixture('HANDOFF-HISTORY.md', HANDOFF_HISTORY_MD);

  await dropDb(DB_TARGET);
  const sys = await pgConnect('postgres');
  await sys.query(`CREATE DATABASE "${DB_TARGET}"`);
  await sys.end();
  await setupTargetSchema(DB_TARGET);

  // ── T1: happy path ───────────────────────────────────────────────────
  await run('T1', 'happy path: both files migrate, DDL preamble columns land, report written', async () => {
    const r = runMigrate08(['--db', DB_TARGET, '--project-id', PROJECT_A, '--file', activeFilePath, '--history-file', historyFilePath]);
    if (r.status !== 0) throw new Error(`migrate-08 failed: status=${r.status}\nstdout=${r.stdout}\nstderr=${r.stderr}`);
    assert(/MIGRATION_RESULT: PASS/.test(r.stdout), 'expected MIGRATION_RESULT: PASS in stdout');

    const client = await pgConnect(DB_TARGET);
    try {
      const cols = await client.query(
        `SELECT column_name FROM information_schema.columns WHERE table_name='assertions' AND column_name IN ('seq','authoring_mode')`
      );
      assertEq(cols.rows.length, 2, 'DDL preamble did not add both seq and authoring_mode columns');

      const { rows: allRows } = await client.query(
        `SELECT subject, predicate, object, pinned, carryover_status, seq, authoring_mode, source_model FROM assertions WHERE project_id = $1 ORDER BY predicate, subject`,
        [PROJECT_A]
      );
      assert(allRows.length > 0, 'no rows were written');
      assert(allRows.every((r2) => r2.source_model === 'markdown-migration-h'), 'every row must be tagged source_model=markdown-migration-h');
      assert(allRows.every((r2) => r2.authoring_mode === 'verbose'), 'default authoring_mode should be "verbose"');

      const tldrRows = allRows.filter((r2) => r2.predicate === 'session_tldr_archived');
      assertEq(tldrRows.length, 3, 'expected 3 session_tldr_archived rows (2 in history + 1 in active)');
      assert(allRows.every((r2) => r2.predicate !== 'session_tldr'), 'H-1 violation: a live session_tldr row was written by the migration');

      const openThreadRows = allRows.filter((r2) => r2.predicate === 'open_thread');
      assertEq(openThreadRows.length, 3, 'expected 3 open_thread rows (2 active + 1 history)');
      assert(openThreadRows.every((r2) => r2.carryover_status === 'open'), 'H-4 violation: an open_thread row was not carryover_status=open');

      const pinnedRows = allRows.filter((r2) => r2.pinned === true);
      assertEq(pinnedRows.length, 3, 'expected 3 pinned durable-section rows');
      const pinnedPredicates = pinnedRows.map((r2) => r2.predicate).sort();
      assertEq(pinnedPredicates.join(','), 'critical_operational_notes,key_paths,run_commands', 'wrong set of durable predicates');

      const nextStepRows = allRows.filter((r2) => r2.predicate === 'next_step');
      assertEq(nextStepRows.length, 2, 'expected 2 next_step rows');
      const seqs = nextStepRows.map((r2) => r2.seq).sort((a, b) => a - b);
      assertEq(seqs.join(','), '1,2', 'next_step seq values not reassigned 1..N');
    } finally {
      await client.end();
    }
  });

  // ── T2: H-1 created_at backdating ────────────────────────────────────
  await run('T2', 'H-1: session_tldr_archived created_at is backdated to the parsed session date', async () => {
    const client = await pgConnect(DB_TARGET);
    try {
      const { rows } = await client.query(
        `SELECT subject, created_at FROM assertions WHERE project_id=$1 AND predicate='session_tldr_archived' ORDER BY created_at ASC`,
        [PROJECT_A]
      );
      assertEq(rows.length, 3, 'expected 3 rows');
      const first = new Date(rows[0].created_at);
      assertEq(first.toISOString().slice(0, 10), '2025-12-20', 'earliest session block not backdated correctly');
      const last = new Date(rows[2].created_at);
      assertEq(last.toISOString().slice(0, 10), '2026-01-05', 'latest session block not backdated correctly');
    } finally {
      await client.end();
    }
  });

  // ── T3: manifest rows ─────────────────────────────────────────────────
  await run('T3', 'migration_manifest rows: correct row_count and H-14-normalized filesystem: source_db', async () => {
    const client = await pgConnect(DB_TARGET);
    try {
      const { rows } = await client.query(
        `SELECT source_db, source_table, row_count FROM migration_manifest WHERE project_id_or_null=$1 ORDER BY source_table`,
        [PROJECT_A]
      );
      assert(rows.length >= 6, `expected at least 6 manifest slices, got ${rows.length}`);
      const bySlice = Object.fromEntries(rows.map((r2) => [r2.source_table, r2]));
      assertEq(Number(bySlice.handoff_next_session_items.row_count), 2, 'wrong row_count for handoff_next_session_items');
      assertEq(Number(bySlice.handoff_active_session_summary.row_count), 1, 'wrong row_count for handoff_active_session_summary');
      assertEq(Number(bySlice.handoff_open_carryovers.row_count), 2, 'wrong row_count for handoff_open_carryovers');
      assertEq(Number(bySlice.handoff_durable_sections.row_count), 3, 'wrong row_count for handoff_durable_sections');
      assertEq(Number(bySlice.handoff_history_session_blocks.row_count), 2, 'wrong row_count for handoff_history_session_blocks');
      assertEq(Number(bySlice.handoff_history_open_carryovers.row_count), 1, 'wrong row_count for handoff_history_open_carryovers');

      const expectedSourceDb = `filesystem:${normalizeFsPath(activeFilePath)}`;
      assertEq(bySlice.handoff_next_session_items.source_db, expectedSourceDb, 'source_db was not H-14-normalized correctly');
    } finally {
      await client.end();
    }
  });

  // ── T4: idempotent re-run ────────────────────────────────────────────
  await run('T4', 'idempotent re-run: identical content produces the identical row count (no duplication)', async () => {
    const client = await pgConnect(DB_TARGET);
    let before;
    try {
      before = (await client.query(`SELECT COUNT(*)::int AS n FROM assertions WHERE project_id=$1`, [PROJECT_A])).rows[0].n;
    } finally {
      await client.end();
    }
    const r = runMigrate08(['--db', DB_TARGET, '--project-id', PROJECT_A, '--file', activeFilePath, '--history-file', historyFilePath]);
    if (r.status !== 0) throw new Error(`re-run failed: status=${r.status}\nstderr=${r.stderr}`);
    const client2 = await pgConnect(DB_TARGET);
    try {
      const after = (await client2.query(`SELECT COUNT(*)::int AS n FROM assertions WHERE project_id=$1`, [PROJECT_A])).rows[0].n;
      assertEq(after, before, 're-run with unchanged content changed the row count');
    } finally {
      await client2.end();
    }
  });

  // ── T5: content-shrink re-run proves delete-and-reinsert, not accretion ─
  await run('T5', 'content-shrink re-run: a removed next_step item is actually gone (delete-and-reinsert, not accretion)', async () => {
    const shrunkActive = HANDOFF_MD.replace('2. Ship the example doc update\n', '');
    const shrunkPath = writeFixture('HANDOFF-shrunk.md', shrunkActive);
    const r = runMigrate08(['--db', DB_TARGET, '--project-id', PROJECT_A, '--file', shrunkPath, '--history-file', historyFilePath]);
    if (r.status !== 0) throw new Error(`shrink re-run failed: status=${r.status}\nstderr=${r.stderr}`);
    const client = await pgConnect(DB_TARGET);
    try {
      const { rows } = await client.query(
        `SELECT object FROM assertions WHERE project_id=$1 AND predicate='next_step'`,
        [PROJECT_A]
      );
      assertEq(rows.length, 1, 'removed next_step item was not actually removed after re-run (accretion bug)');
    } finally {
      await client.end();
    }
  });

  // ── T6: fail-soft, one file missing ──────────────────────────────────
  await run('T6', 'fail-soft: migration succeeds when one of the two files is missing', async () => {
    const missingPath = path.join(SCRATCH_DIR, 'does-not-exist-HANDOFF-HISTORY.md');
    const projectB = `example-project-beta-${TS}`;
    const r = runMigrate08(['--db', DB_TARGET, '--project-id', projectB, '--file', activeFilePath, '--history-file', missingPath]);
    if (r.status !== 0) throw new Error(`fail-soft run failed: status=${r.status}\nstdout=${r.stdout}\nstderr=${r.stderr}`);
    assert(/FAIL-SOFT/.test(r.stdout), 'expected a FAIL-SOFT log line for the missing file');
    const client = await pgConnect(DB_TARGET);
    try {
      const { rows } = await client.query(`SELECT COUNT(*)::int AS n FROM assertions WHERE project_id=$1`, [projectB]);
      assert(rows[0].n > 0, 'fail-soft run with one missing file wrote zero rows');
    } finally {
      await client.end();
    }
  });

  // ── T6b: H-6 cross-file collision reporting (independent-review fix,
  // PR #172 blocker 2) — same session heading present in BOTH --file and
  // --history-file must produce a loud, named cross-file collision event
  // (console line + report entry), never silently write both rows with
  // an empty collision array. ──────────────────────────────────────────
  await run('T6b', 'H-6: an identical session heading in both files produces a reported cross-file collision, and BOTH rows survive', async () => {
    const dupHeading = '## Session 9 — 2026-02-10 — Duplicated across files';
    const activeDupPath = writeFixture(
      'HANDOFF-dup-active.md',
      [dupHeading, '', '### Done', '- did an example thing in the active file', ''].join('\n')
    );
    const historyDupPath = writeFixture(
      'HANDOFF-HISTORY-dup.md',
      [dupHeading, '', '### Done', '- did an example thing in the archive', ''].join('\n')
    );
    const reportScratchDir = path.join(SCRATCH_DIR, 'reports-t6b');
    const projectC = `example-project-gamma-${TS}`;
    const r = runMigrate08(['--db', DB_TARGET, '--project-id', projectC, '--file', activeDupPath, '--history-file', historyDupPath, '--report-dir', reportScratchDir]);
    if (r.status !== 0) throw new Error(`cross-file collision run failed: status=${r.status}\nstdout=${r.stdout}\nstderr=${r.stderr}`);
    assert(/\[CROSS-FILE-SUBJECT-COLLISION\]/.test(r.stdout), 'expected a loud [CROSS-FILE-SUBJECT-COLLISION] console line');
    assert(r.stdout.includes('category="session_tldr_archived"'), 'expected the collision to be reported under the session_tldr_archived category');

    const client = await pgConnect(DB_TARGET);
    try {
      const { rows } = await client.query(
        `SELECT subject, object FROM assertions WHERE project_id=$1 AND predicate='session_tldr_archived'`,
        [projectC]
      );
      assertEq(rows.length, 2, 'both the active-file and history-file rows for the duplicated heading must survive (1:N-safe by design)');
      assert(rows.every((r2) => r2.subject === rows[0].subject), 'both rows should share the identical subject (same heading text in both files)');
    } finally {
      await client.end();
    }

    const reportFiles = fs.readdirSync(reportScratchDir).filter((f) => f.includes(projectC));
    assertEq(reportFiles.length, 1, 'expected exactly one report file for this run');
    const report = JSON.parse(fs.readFileSync(path.join(reportScratchDir, reportFiles[0]), 'utf8'));
    assert(report.cross_file_collisions, 'report is missing cross_file_collisions entirely');
    const sessionCollisions = report.cross_file_collisions.session_tldr_archived;
    assertEq(sessionCollisions.length, 1, 'expected exactly one session_tldr_archived cross-file collision entry in the report');
    assertEq(sessionCollisions[0].activeCount, 1, 'wrong activeCount in the cross-file collision report entry');
    assertEq(sessionCollisions[0].historyCount, 1, 'wrong historyCount in the cross-file collision report entry');
  });

  // ── T6c: H-6 WITHIN-file durable-heading collision (independent-review
  // fix, PR #176) — a duplicated durable-section heading (e.g. two
  // '## Run commands' sections in the SAME file) is the exact regression
  // PR #176's author found empirically: registering run_commands/
  // critical_operational_notes/key_paths as cardinality 1:1 (and widening
  // assertions_1to1_unique to match) converts this documented, log-and-
  // continue collision path into a hard Postgres "duplicate key value
  // violates unique constraint" error that aborts the whole-project
  // transaction (zero rows written). This fixture pins the CORRECT (1:N)
  // behavior permanently so a future re-introduction of 1:1 for any
  // durable-section predicate fails this test immediately, not just the
  // reviewer's one-off manual repro. Distinct from T6b: T6b is a CROSS-file
  // (--file vs --history-file) collision on session_tldr_archived; this is
  // a WITHIN-file collision on a durable-section predicate. ─────────────
  await run('T6c', 'H-6: a duplicated durable-section heading ("## Run commands" twice) within one file produces a reported within-file collision, exits 0, and BOTH rows survive', async () => {
    const dupDurablePath = writeFixture(
      'HANDOFF-dup-durable.md',
      [
        '## Run commands',
        '',
        'npm run example-test-one',
        '',
        '## Run commands',
        '',
        'npm run example-test-two',
        '',
      ].join('\n')
    );
    const reportScratchDir = path.join(SCRATCH_DIR, 'reports-t6c');
    const projectD = `example-project-delta-${TS}`;
    const r = runMigrate08(['--db', DB_TARGET, '--project-id', projectD, '--file', dupDurablePath, '--report-dir', reportScratchDir]);
    if (r.status !== 0) throw new Error(`within-file durable-heading collision run failed (should exit 0, not crash): status=${r.status}\nstdout=${r.stdout}\nstderr=${r.stderr}`);
    assert(/MIGRATION_RESULT: PASS/.test(r.stdout), 'expected MIGRATION_RESULT: PASS in stdout');
    assert(/\[SUBJECT-COLLISION\]/.test(r.stdout), 'expected a loud [SUBJECT-COLLISION] console line');
    assert(r.stdout.includes('category="durable"'), 'expected the collision to be reported under the durable category');
    assert(r.stdout.includes('key="run_commands::Run commands"'), 'expected the collision key to name the run_commands predicate and Run commands subject');

    const client = await pgConnect(DB_TARGET);
    try {
      const { rows } = await client.query(
        `SELECT subject, object, predicate, pinned FROM assertions WHERE project_id=$1 AND predicate='run_commands' ORDER BY object`,
        [projectD]
      );
      assertEq(rows.length, 2, 'both durable-section rows for the duplicated "## Run commands" heading must survive (1:N-safe by design, never constraint-blocked)');
      assert(rows.every((r2) => r2.subject === 'Run commands'), 'both rows should share the identical canonical subject');
      assert(rows.every((r2) => r2.pinned === true), 'durable-section rows must be written pinned=true');
      assert(rows[0].object !== rows[1].object, 'the two colliding rows should retain their distinct body content, not be merged or deduplicated');
    } finally {
      await client.end();
    }

    const reportFiles = fs.readdirSync(reportScratchDir).filter((f) => f.includes(projectD));
    assertEq(reportFiles.length, 1, 'expected exactly one report file for this run');
    const report = JSON.parse(fs.readFileSync(path.join(reportScratchDir, reportFiles[0]), 'utf8'));
    assert(report.active && report.active.collisions && report.active.collisions.durable, 'report is missing active.collisions.durable entirely');
    const durableCollisions = report.active.collisions.durable;
    assertEq(durableCollisions.length, 1, 'expected exactly one durable within-file collision entry in the report');
    assertEq(durableCollisions[0].key, 'run_commands::Run commands', 'wrong key in the within-file durable collision report entry');
    assertEq(durableCollisions[0].count, 2, 'wrong count in the within-file durable collision report entry');
  });

  // ── T7: usage errors ──────────────────────────────────────────────────
  await run('T7', 'usage: --project-id is required', async () => {
    const r = runMigrate08(['--db', DB_TARGET, '--file', activeFilePath]);
    assertEq(r.status, 2, 'missing --project-id should exit 2');
  });
  await run('T7b', 'usage: at least one of --file/--history-file is required', async () => {
    const r = runMigrate08(['--db', DB_TARGET, '--project-id', PROJECT_A]);
    assertEq(r.status, 2, 'missing both file args should exit 2');
  });
  await run('T7c', 'usage: invalid --authoring-mode is rejected', async () => {
    const r = runMigrate08(['--db', DB_TARGET, '--project-id', PROJECT_A, '--file', activeFilePath, '--authoring-mode', 'bogus']);
    assertEq(r.status, 2, 'invalid --authoring-mode should exit 2');
  });

  // ── T8: rollback ──────────────────────────────────────────────────────
  await run('T8', 'rollback: deletes exactly this project\'s tagged rows', async () => {
    const r = runMigrate08(['--db', DB_TARGET, '--project-id', PROJECT_A, '--rollback']);
    if (r.status !== 0) throw new Error(`rollback failed: status=${r.status}\nstderr=${r.stderr}`);
    assert(/ROLLBACK_RESULT: PASS/.test(r.stdout), 'expected ROLLBACK_RESULT: PASS');
    const client = await pgConnect(DB_TARGET);
    try {
      const { rows } = await client.query(`SELECT COUNT(*)::int AS n FROM assertions WHERE project_id=$1`, [PROJECT_A]);
      assertEq(rows[0].n, 0, 'rollback did not remove all of this project\'s rows');
      const { rows: manifestRows } = await client.query(`SELECT COUNT(*)::int AS n FROM migration_manifest WHERE project_id_or_null=$1`, [PROJECT_A]);
      assertEq(manifestRows[0].n, 0, 'rollback did not remove this project\'s manifest rows');
    } finally {
      await client.end();
    }
  });

  console.log(`\nResults: ${passed} passed, ${failed} failed`);
  for (const db of CREATED_DBS) await dropDb(db);
  try { fs.rmSync(SCRATCH_DIR, { recursive: true, force: true }); } catch (_) { /* best-effort */ }
  process.exitCode = failed > 0 ? 1 : 0;
}

main().catch(async (err) => {
  console.error(err && err.stack ? err.stack : err);
  for (const db of CREATED_DBS) await dropDb(db);
  process.exitCode = 1;
});
