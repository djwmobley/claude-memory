'use strict';

/**
 * test-migrate-08-handoff-markdown.js — DB integration test harness for
 * scripts/migrations/migrate-08-handoff-markdown.js (CONSOLIDATION-
 * RUNBOOK.md §6.1(h) + H-1..H-14 amendment, memory-manager#11(h), + cm#222
 * 2026-09-06 hardening pass: true --dry-run, header-driven carry-over
 * tables, NEXT SESSION explicit states).
 *
 * Mirrors test-migrate-02-decisions.js's conventions: self-contained
 * scratch database ("_staging"-suffixed to satisfy migrate-01's own
 * classifyTarget, reused by reference), unconditional cleanup. Fixture
 * HANDOFF.md / HANDOFF-HISTORY.md files are written to a scratch temp
 * directory per run — SYNTHETIC content only (invented project/session
 * names), never real pwa-etl text, per H-13. Fixtures now use the
 * 3-column (Item/Status/Notes) header shape cm#222's header-driven
 * rewrite was built against — this IS the real-world shape (F-1).
 *
 * Covers:
 *   - Happy path: both files present -> session_tldr_archived (numbered
 *     AND dated shapes both land here — both files' blocks survive),
 *     open_thread (all carryover_status='open', header-driven 3-column
 *     parsing), pinned durable-section rows, next_step rows with seq.
 *   - H-1: session_tldr_archived is written, NEVER live session_tldr;
 *     created_at is backdated to the parsed session date.
 *   - H-4: every open_thread row is carryover_status='open' regardless of
 *     the cm#222 Status total-classification (report-only, never written).
 *   - cm#222 A1: --dry-run performs ZERO assertions/manifest writes and
 *     is refused together with --rollback.
 *   - cm#222 A5: NEXT SESSION absent / present_empty / present_variant
 *     states are surfaced in the report.
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
  const r2 = runAddenda(['--db', dbName]);
  if (r2.status !== 0) throw new Error(`schema-addenda fixture setup failed: status=${r2.status} stderr=${r2.stderr}`);
}

const DB_TARGET = `verify08_target_${TS}_staging`;
const CREATED_DBS = [DB_TARGET];

const SCRATCH_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'migrate08-fixtures-'));

const PROJECT_A = `example-project-alpha-${TS}`;

// ── Synthetic fixtures (invented content only, per H-13) — 3-column
//    (Item/Status/Notes) header shape, the real-world convention cm#222's
//    header-driven rewrite targets. ──────────────────────────────────────

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
  '| Item | Status | Notes |',
  '|------|--------|-------|',
  '| EXAMPLE-THREAD-ALPHA: something | Open | do the example alpha thing |',
  '| EXAMPLE-THREAD-BETA: other | DONE -- merged | do the example beta thing |',
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
  '| Item | Status | Notes |',
  '|------|--------|-------|',
  '| EXAMPLE-THREAD-GAMMA: legacy | Open | resolved in a later session, still open by construction |',
  '',
  '## SESSION 2025-12-20 (session 1) -- Initial example commit',
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

function readReportFile(reportScratchDir, projectId) {
  const files = fs.readdirSync(reportScratchDir).filter((f) => f.includes(projectId));
  assertEq(files.length, 1, `expected exactly one report file for project ${projectId}`);
  return JSON.parse(fs.readFileSync(path.join(reportScratchDir, files[0]), 'utf8'));
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
      assertEq(tldrRows.length, 3, 'expected 3 session_tldr_archived rows (2 in history + 1 in active) — numbered AND dated shapes both land here');
      assert(allRows.every((r2) => r2.predicate !== 'session_tldr'), 'H-1 violation: a live session_tldr row was written by the migration');

      const openThreadRows = allRows.filter((r2) => r2.predicate === 'open_thread');
      assertEq(openThreadRows.length, 3, 'expected 3 open_thread rows (2 active + 1 history) — header-driven 3-column parsing');
      assert(openThreadRows.every((r2) => r2.carryover_status === 'open'), 'H-4 violation: an open_thread row was not carryover_status=open, regardless of Status cell content');

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

  // ── T2: H-1 created_at backdating (numbered AND dated shapes) ────────
  await run('T2', 'H-1: session_tldr_archived created_at is backdated to the parsed session date, for both the numbered and dated heading shapes', async () => {
    const client = await pgConnect(DB_TARGET);
    try {
      const { rows } = await client.query(
        `SELECT subject, created_at FROM assertions WHERE project_id=$1 AND predicate='session_tldr_archived' ORDER BY created_at ASC`,
        [PROJECT_A]
      );
      assertEq(rows.length, 3, 'expected 3 rows');
      const first = new Date(rows[0].created_at);
      assertEq(first.toISOString().slice(0, 10), '2025-12-20', 'earliest (dated-shape) session block not backdated correctly');
      const last = new Date(rows[2].created_at);
      assertEq(last.toISOString().slice(0, 10), '2026-01-05', 'latest (numbered-shape) session block not backdated correctly');
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

  // ── T6b: H-6 cross-file collision reporting ──────────────────────────
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

    const report = readReportFile(reportScratchDir, projectC);
    assert(report.cross_file_collisions, 'report is missing cross_file_collisions entirely');
    const sessionCollisions = report.cross_file_collisions.session_tldr_archived;
    assertEq(sessionCollisions.length, 1, 'expected exactly one session_tldr_archived cross-file collision entry in the report');
    assertEq(sessionCollisions[0].activeCount, 1, 'wrong activeCount in the cross-file collision report entry');
    assertEq(sessionCollisions[0].historyCount, 1, 'wrong historyCount in the cross-file collision report entry');
  });

  // ── T6c: H-6 WITHIN-file durable-heading collision ───────────────────
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

    const report = readReportFile(reportScratchDir, projectD);
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
  await run('T7d', 'cm#222 A1: usage: --dry-run and --rollback together is refused (ambiguous scope)', async () => {
    const r = runMigrate08(['--db', DB_TARGET, '--project-id', PROJECT_A, '--dry-run', '--rollback']);
    assertEq(r.status, 2, '--dry-run + --rollback together should exit 2');
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

  // ── T9: cm#222 A1 — true --dry-run performs ZERO writes ──────────────
  await run('T9', 'cm#222 A1: --dry-run with --db runs only the read-only precondition checks and writes ZERO assertions/manifest rows', async () => {
    const projectE = `example-project-epsilon-${TS}`;
    const reportScratchDir = path.join(SCRATCH_DIR, 'reports-t9');
    const before = await pgConnect(DB_TARGET);
    let beforeAssertions;
    let beforeManifest;
    try {
      beforeAssertions = (await before.query(`SELECT COUNT(*)::int AS n FROM assertions`)).rows[0].n;
      beforeManifest = (await before.query(`SELECT COUNT(*)::int AS n FROM migration_manifest`)).rows[0].n;
    } finally {
      await before.end();
    }

    const r = runMigrate08(['--db', DB_TARGET, '--project-id', projectE, '--file', activeFilePath, '--history-file', historyFilePath, '--dry-run', '--report-dir', reportScratchDir]);
    if (r.status !== 0) throw new Error(`dry-run failed: status=${r.status}\nstdout=${r.stdout}\nstderr=${r.stderr}`);
    assert(/DRY_RUN_RESULT: PASS/.test(r.stdout), 'expected DRY_RUN_RESULT: PASS in stdout');
    assert(r.stdout.includes('precondition'), 'expected the precondition-check summary in stdout');

    const after = await pgConnect(DB_TARGET);
    try {
      const afterAssertions = (await after.query(`SELECT COUNT(*)::int AS n FROM assertions`)).rows[0].n;
      const afterManifest = (await after.query(`SELECT COUNT(*)::int AS n FROM migration_manifest`)).rows[0].n;
      assertEq(afterAssertions, beforeAssertions, '--dry-run must never write any assertions row, anywhere');
      assertEq(afterManifest, beforeManifest, '--dry-run must never write any migration_manifest row, anywhere');
      const { rows: projectRows } = await after.query(`SELECT COUNT(*)::int AS n FROM assertions WHERE project_id=$1`, [projectE]);
      assertEq(projectRows[0].n, 0, '--dry-run must not have written anything for its own project_id either');
    } finally {
      await after.end();
    }

    const report = readReportFile(reportScratchDir, projectE);
    assertEq(report.mode, 'dry_run', 'report mode should be dry_run');
    assertEq(report.total_assertions_written, 0, 'report should reflect zero writes');
    assert(report.precondition_checks, 'report is missing precondition_checks');
    assertEq(report.precondition_checks.assertions_table, 'pass', 'precondition check should pass against a fully-provisioned target');
    assertEq(report.precondition_checks.required_columns, 'pass', 'precondition check should pass against a fully-provisioned target');
  });

  await run('T9b', 'cm#222 A1/F-9: --dry-run without --db reports "not checked", never "assumed OK"', async () => {
    const projectF = `example-project-zeta-${TS}`;
    const reportScratchDir = path.join(SCRATCH_DIR, 'reports-t9b');
    const r = runMigrate08(['--project-id', projectF, '--file', activeFilePath, '--dry-run', '--report-dir', reportScratchDir]);
    if (r.status !== 0) throw new Error(`no-db dry-run failed: status=${r.status}\nstdout=${r.stdout}\nstderr=${r.stderr}`);
    assert(/DRY_RUN_RESULT: PASS/.test(r.stdout), 'expected DRY_RUN_RESULT: PASS in stdout');
    assert(/not checked/i.test(r.stdout), 'expected an explicit "not checked" precondition message without --db');
    const report = readReportFile(reportScratchDir, projectF);
    assertEq(report.precondition_checks.assertions_table, 'not_checked', 'precondition check should be not_checked without --db, never assumed pass');
    assertEq(report.precondition_checks.required_columns, 'not_checked', 'precondition check should be not_checked without --db, never assumed pass');
  });

  await run('T9c', 'cm#222 F-9: --dry-run against a target missing required columns reports FAIL, never silently PASS', async () => {
    const dbBare = `verify08_bare_${TS}_staging`;
    CREATED_DBS.push(dbBare);
    await dropDb(dbBare);
    const sysB = await pgConnect('postgres');
    await sysB.query(`CREATE DATABASE "${dbBare}"`);
    await sysB.end();
    const r1 = runMigrateOne(['--db', dbBare]); // migrate-01 ONLY — no schema-addenda, so source_model/carryover_status are missing
    if (r1.status !== 0) throw new Error(`migrate-01 bare fixture setup failed: status=${r1.status} stderr=${r1.stderr}`);

    const projectG = `example-project-eta-${TS}`;
    const reportScratchDir = path.join(SCRATCH_DIR, 'reports-t9c');
    const r = runMigrate08(['--db', dbBare, '--project-id', projectG, '--file', activeFilePath, '--dry-run', '--report-dir', reportScratchDir]);
    assertEq(r.status, 1, 'dry-run against a target missing required columns should exit 1 (FAIL), not 0');
    assert(/DRY_RUN_RESULT: FAIL/.test(r.stdout + r.stderr), 'expected DRY_RUN_RESULT: FAIL in stdout or stderr');

    const report = readReportFile(reportScratchDir, projectG);
    assertEq(report.precondition_checks.assertions_table, 'pass', 'assertions table itself exists after migrate-01');
    assertEq(report.precondition_checks.required_columns, 'fail', 'required_columns should FAIL on a migrate-01-only target, never silently pass');
  });

  // ── T10: cm#222 A5 — NEXT SESSION explicit states ────────────────────
  await run('T10', 'cm#222 A5: NEXT SESSION state is "absent" when no such heading (canonical or variant) exists', () => {
    const migrate08 = require(MIGRATE08_PATH);
    const mdParse = require(path.join(PROJECT_ROOT, 'scripts', 'lib', 'handoff-markdown-parse.js'));
    const doc = ['## Session 1 — 2026-01-01 — Title', '', 'body', ''].join('\n');
    const sections = mdParse.splitDocumentIntoSections(doc, []);
    const state = migrate08.computeNextSessionState(sections);
    assertEq(state.state, 'absent', 'expected absent state');
  });

  await run('T10b', 'cm#222 A5: NEXT SESSION state is "present_empty" when the canonical heading has zero items', () => {
    const migrate08 = require(MIGRATE08_PATH);
    const mdParse = require(path.join(PROJECT_ROOT, 'scripts', 'lib', 'handoff-markdown-parse.js'));
    const doc = ['## NEXT SESSION', '', '_(none)_', ''].join('\n');
    const sections = mdParse.splitDocumentIntoSections(doc, []);
    const state = migrate08.computeNextSessionState(sections);
    assertEq(state.state, 'present_empty', 'expected present_empty state');
    assertEq(state.itemCount, 0, 'expected zero items');
  });

  await run('T10c', 'cm#222 A5: NEXT SESSION state is "present_with_items" for the normal case', () => {
    const migrate08 = require(MIGRATE08_PATH);
    const mdParse = require(path.join(PROJECT_ROOT, 'scripts', 'lib', 'handoff-markdown-parse.js'));
    const doc = ['## NEXT SESSION', '', '1. do the thing', ''].join('\n');
    const sections = mdParse.splitDocumentIntoSections(doc, []);
    const state = migrate08.computeNextSessionState(sections);
    assertEq(state.state, 'present_with_items', 'expected present_with_items state');
    assertEq(state.itemCount, 1, 'expected one item');
  });

  await run('T10d', 'cm#222 A5/F-5: NEXT SESSION state is "present_variant" for a non-canonical next+session heading, and no items are extracted from it', () => {
    const migrate08 = require(MIGRATE08_PATH);
    const mdParse = require(path.join(PROJECT_ROOT, 'scripts', 'lib', 'handoff-markdown-parse.js'));
    const doc = ['## Next up: session wrap notes', '', '1. this should not become a next_step row', ''].join('\n');
    const sections = mdParse.splitDocumentIntoSections(doc, []);
    const state = migrate08.computeNextSessionState(sections);
    assertEq(state.state, 'present_variant', 'expected present_variant state');
    assert(state.variantHeadingText, 'expected the variant heading text to be captured');
  });

  await run('T10e', 'end-to-end: NEXT SESSION absence is surfaced in the migrate-08 report, and zero next_step rows are written', async () => {
    const noNextSessionPath = writeFixture(
      'HANDOFF-no-next-session.md',
      ['## Session 5 — 2026-03-01 — No NEXT SESSION heading in this file', '', '### Done', '- something', ''].join('\n')
    );
    const reportScratchDir = path.join(SCRATCH_DIR, 'reports-t10e');
    const projectH = `example-project-theta-${TS}`;
    const r = runMigrate08(['--db', DB_TARGET, '--project-id', projectH, '--file', noNextSessionPath, '--report-dir', reportScratchDir]);
    if (r.status !== 0) throw new Error(`run failed: status=${r.status}\nstdout=${r.stdout}\nstderr=${r.stderr}`);
    const report = readReportFile(reportScratchDir, projectH);
    assertEq(report.active.nextSessionState.state, 'absent', 'report should say the NEXT SESSION heading is absent');
    const client = await pgConnect(DB_TARGET);
    try {
      const { rows } = await client.query(`SELECT COUNT(*)::int AS n FROM assertions WHERE project_id=$1 AND predicate='next_step'`, [projectH]);
      assertEq(rows[0].n, 0, 'zero next_step rows should be written when NEXT SESSION is absent');
    } finally {
      await client.end();
    }
  });

  // ── T11: coordinator follow-up — carry-over heading variant + a real
  //    canonical table with a parenthetical suffix, both end-to-end ─────
  await run('T11', 'coordinator follow-up: a non-canonical carry-over-shaped heading is reported end-to-end; its table is never written, while a parenthetical-suffixed CANONICAL heading\'s table IS written', async () => {
    const fixturePath = writeFixture(
      'HANDOFF-carryover-variant.md',
      [
        '## Session 6 — 2026-03-05 — Carry-over heading variant coverage',
        '',
        '### Open carry-overs (rotated forward from a prior close)',
        '',
        '| Item | Status | Notes |',
        '|---|---|---|',
        '| Real carryover row | Open | this table is canonical (parenthetical suffix) and MUST be written |',
        '',
        '### Carryover backlog (not the canonical heading shape)',
        '',
        '| Item | Status | Notes |',
        '|---|---|---|',
        '| Should never be written | Open | this heading is a variant, not canonical |',
        '',
      ].join('\n')
    );
    const reportScratchDir = path.join(SCRATCH_DIR, 'reports-t11');
    const projectI = `example-project-iota-${TS}`;
    const r = runMigrate08(['--db', DB_TARGET, '--project-id', projectI, '--file', fixturePath, '--report-dir', reportScratchDir]);
    if (r.status !== 0) throw new Error(`run failed: status=${r.status}\nstdout=${r.stdout}\nstderr=${r.stderr}`);

    const report = readReportFile(reportScratchDir, projectI);
    assertEq(report.active.carryoverHeadingVariants.length, 1, 'expected exactly one reported carry-over heading variant');
    assert(/Carryover backlog/.test(report.active.carryoverHeadingVariants[0].headingLine), 'wrong heading reported as the variant');

    const client = await pgConnect(DB_TARGET);
    try {
      const { rows } = await client.query(`SELECT object FROM assertions WHERE project_id=$1 AND predicate='open_thread'`, [projectI]);
      assertEq(rows.length, 1, 'exactly one open_thread row should be written — from the canonical (parenthetical-suffixed) heading only');
      assert(rows[0].object.includes('this table is canonical'), 'the wrong table\'s row was written, or the variant table\'s row leaked through');
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
