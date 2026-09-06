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
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { createRequire } = require('module');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const MIGRATE_ONE_PATH = path.join(PROJECT_ROOT, 'scripts', 'migrations', 'migrate-01-canonical-db.js');
const ADDENDA_PATH = path.join(PROJECT_ROOT, 'scripts', 'migrations', 'migrate-schema-addenda.js');
const MIGRATE08_PATH = path.join(PROJECT_ROOT, 'scripts', 'migrations', 'migrate-08-handoff-markdown.js');
const CORE_SCHEMA_SQL_PATH = path.join(PROJECT_ROOT, 'scripts', 'sql', 'handoff-core-schema.sql');

const scriptsRequire = createRequire(require.resolve('../../scripts/package.json'));
const { Client } = scriptsRequire('pg');

const { normalizeFsPath } = require(path.join(PROJECT_ROOT, 'scripts', 'lib', 'fs-path-normalize.js'));
const handoffModule = require(path.join(PROJECT_ROOT, 'scripts', 'handoff.js'));
const { PostgresAdapter } = require(path.join(PROJECT_ROOT, 'scripts', 'lib', 'db-seam.js'));
const migrate08Module = require(path.join(PROJECT_ROOT, 'scripts', 'migrations', 'migrate-08-handoff-markdown.js'));

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

// ── PER_PROJECT_ENGINE fixture (item B / #251 follow-up) ──────────────────────────
//
// Provisions a scratch DB carrying ONLY scripts/sql/handoff-core-schema.sql
// (ENGINE_CANON) — deliberately NEVER migrate-schema-addenda.js, so
// carryover_status (ADDENDA_ONLY) never lands here — plus a project_settings
// marker row at the current SCHEMA_EPOCH, mirroring what classifyTarget()'s
// probeProjectMarker() requires to return PER_PROJECT_ENGINE, allowed:true
// (see probeProjectMarker in migrate-01-canonical-db.js and its own
// test-migrate-01.js T16-T24 for the identical fixture-construction
// pattern this reuses). The fingerprint's hash half is never validated by
// the probe — only the epoch — so a placeholder hash is used here exactly
// as test-migrate-01.js's own T21-T23 do.
async function setupPerProjectEngineTarget(dbName, projectId) {
  const schemaSql = fs.readFileSync(CORE_SCHEMA_SQL_PATH, 'utf8');
  const client = await pgConnect(dbName);
  try {
    // Real per-project engine DBs are always provisioned via /handoff:init
    // (or migrate-01, which pre-creates these extensions before applying
    // any schema file — see migrate-01-canonical-db.js's own ensureExtensions()
    // doc comment for why order matters: handoff-core-schema.sql's
    // assertions.embedding column is wrapped in a DO block that silently
    // skips the ALTER TABLE if pgvector isn't installed YET in this
    // database). Mirrored here so this hand-built fixture doesn't manufacture
    // a "degraded" schema-apply outcome that a real per-project engine DB
    // would never actually have.
    for (const ext of ['vector', 'pg_trgm']) {
      try { await client.query(`CREATE EXTENSION IF NOT EXISTS ${ext}`); } catch (_) { /* best-effort, mirrors migrate-01 */ }
    }
    await client.query(schemaSql);
    await client.query(
      `INSERT INTO project_settings (project_id, key, value) VALUES ($1, 'schema_fingerprint', $2)
         ON CONFLICT (project_id, key) DO UPDATE SET value = EXCLUDED.value`,
      [projectId, `${handoffModule.SCHEMA_EPOCH}:${'0'.repeat(64)}`]
    );
  } finally {
    await client.end();
  }
}

async function assertionColumnExists(dbName, columnName) {
  const client = await pgConnect(dbName);
  try {
    const { rows } = await client.query(
      `SELECT 1 FROM information_schema.columns WHERE table_name='assertions' AND column_name=$1`,
      [columnName]
    );
    return rows.length > 0;
  } finally {
    await client.end();
  }
}

// ── S1/S2/S3 fixture helpers (engine index bring-forward + integrity-index
// gate, 2026-09-06 pass) ─────────────────────────────────────────────────

/**
 * Revert a fully-provisioned target's assertions_1ton_exact_unique index
 * back to the KNOWN pre-cm#227 raw form (DROP the canonical md5(object)
 * index, CREATE the raw-object one) — reproduces the live DEFECT this pass
 * closes (memory_manager_staging's actual observed shape).
 */
async function revertIndexToStaleRawForm(dbName) {
  const client = await pgConnect(dbName);
  try {
    await client.query('DROP INDEX IF EXISTS assertions_1ton_exact_unique');
    await client.query(
      'CREATE UNIQUE INDEX assertions_1ton_exact_unique ON assertions (project_id, subject, predicate, object) WHERE suppressed = false'
    );
  } finally {
    await client.end();
  }
}

/** Read back the live index's pg_get_indexdef/indisvalid, or null if absent. */
async function getLiveIndexInfo(dbName) {
  const client = await pgConnect(dbName);
  try {
    const { rows } = await client.query(
      `SELECT pg_get_indexdef(i.indexrelid) AS indexdef, i.indisvalid, i.indisunique
         FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
        WHERE i.indrelid = 'assertions'::regclass AND c.relname = 'assertions_1ton_exact_unique'`
    );
    return rows.length > 0 ? rows[0] : null;
  } finally {
    await client.end();
  }
}

// Full STAGING-shaped fixture (migrate-01 + schema-addenda), matching
// setupTargetSchema()'s own two-step sequence exactly — a STAGING target's
// requiredColumnsForBranch() includes carryover_status (ADDENDA_ONLY), so a
// migrate-01-only fixture would always fail checkSchemaPreconditions here,
// unrelated to anything S1/S2/S3 classify.
async function createFreshStagingDb(name) {
  await dropDb(name);
  const sys = await pgConnect('postgres');
  await sys.query(`CREATE DATABASE "${name}"`);
  await sys.end();
  await setupTargetSchema(name);
}

const DB_TARGET = `verify08_target_${TS}_staging`;
// Deliberately does NOT end in "_staging" and is not "memory_manager" — must
// fall through classifyTarget()'s name-only branches into the marker probe.
const DB_ENGINE = `verify08_engine_${TS}`;
const CREATED_DBS = [DB_TARGET, DB_ENGINE];

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
    // migrate-01 ONLY — no schema-addenda. handoff-core-schema.sql (applied
    // by migrate-01 itself) already carries source_model; carryover_status
    // is migrate-06-carryover-status.sql, ADDENDA_ONLY, never applied here.
    const r1 = runMigrateOne(['--db', dbBare]);
    if (r1.status !== 0) throw new Error(`migrate-01 bare fixture setup failed: status=${r1.status} stderr=${r1.stderr}`);

    const projectG = `example-project-eta-${TS}`;
    const reportScratchDir = path.join(SCRATCH_DIR, 'reports-t9c');
    const r = runMigrate08(['--db', dbBare, '--project-id', projectG, '--file', activeFilePath, '--dry-run', '--report-dir', reportScratchDir]);
    assertEq(r.status, 1, 'dry-run against a target missing required columns should exit 1 (FAIL), not 0');
    assert(/DRY_RUN_RESULT: FAIL/.test(r.stdout + r.stderr), 'expected DRY_RUN_RESULT: FAIL in stdout or stderr');

    const report = readReportFile(reportScratchDir, projectG);
    assertEq(report.precondition_checks.assertions_table, 'pass', 'assertions table itself exists after migrate-01');
    assertEq(report.precondition_checks.required_columns, 'fail', 'required_columns should FAIL on a migrate-01-only target, never silently pass');
    // item B / #251 follow-up: a STAGING (CANON-like) target's required-columns set
    // is NEVER loosened by the PER_PROJECT_ENGINE branch-awareness fix —
    // carryover_status is still required here, and is exactly what's missing.
    assertEq(report.precondition_checks.required_columns_list.slice().sort().join(','), 'carryover_status,source_model', 'CANON/STAGING required_columns_list must remain [source_model, carryover_status] — unchanged by this fix');
    assertEq(report.precondition_checks.missing_columns.join(','), 'carryover_status', 'expected ONLY carryover_status missing on a migrate-01-only STAGING target (source_model is ENGINE_CANON, already present)');
  });

  // ── T9d-T9h: item B / #251 follow-up — PER_PROJECT_ENGINE branch-aware preconditions ──
  //
  // A scratch DB provisioned from scripts/sql/handoff-core-schema.sql ONLY
  // (never migrate-schema-addenda.js) plus a positive project_settings
  // marker at the current SCHEMA_EPOCH — exactly the shape of a real
  // pipeline_pwa_etl-style per-project engine DB post-#251. This is the
  // scenario the ground-truth diagnosis found migrate-08 always refused
  // before this fix (carryover_status required unconditionally).
  const PROJECT_ENGINE = crypto.randomUUID();

  await run('T9d', 'item B / #251 follow-up: PER_PROJECT_ENGINE target provisioned from scripts/sql ONLY — dry-run precondition PASSES (previously always FAILed here)', async () => {
    await dropDb(DB_ENGINE);
    const sys = await pgConnect('postgres');
    await sys.query(`CREATE DATABASE "${DB_ENGINE}"`);
    await sys.end();
    await setupPerProjectEngineTarget(DB_ENGINE, PROJECT_ENGINE);

    // Ground truth: carryover_status must genuinely be absent from this
    // fixture, or this test would not be exercising the bug it targets.
    assert(!(await assertionColumnExists(DB_ENGINE, 'carryover_status')), 'fixture bug: carryover_status must be absent from a scripts/sql-only engine DB');
    assert(await assertionColumnExists(DB_ENGINE, 'source_model'), 'fixture bug: source_model (ENGINE_CANON) must be present after handoff-core-schema.sql alone');

    const reportScratchDir = path.join(SCRATCH_DIR, 'reports-t9d');
    const r = runMigrate08(['--db', DB_ENGINE, '--project-id', PROJECT_ENGINE, '--file', activeFilePath, '--dry-run', '--report-dir', reportScratchDir]);
    if (r.status !== 0) throw new Error(`PER_PROJECT_ENGINE dry-run failed: status=${r.status}\nstdout=${r.stdout}\nstderr=${r.stderr}`);
    assert(/DRY_RUN_RESULT: PASS/.test(r.stdout), `expected DRY_RUN_RESULT: PASS; got:\n${r.stdout}`);
    assert(/branch=PER_PROJECT_ENGINE/.test(r.stdout), 'expected the resolved branch to be logged as PER_PROJECT_ENGINE');

    const report = readReportFile(reportScratchDir, PROJECT_ENGINE);
    assertEq(report.precondition_checks.assertions_table, 'pass', 'assertions table exists');
    assertEq(report.precondition_checks.required_columns, 'pass', 'PER_PROJECT_ENGINE required_columns must PASS without carryover_status');
    assert(!report.precondition_checks.required_columns_list.includes('carryover_status'), 'PER_PROJECT_ENGINE required_columns_list must never include carryover_status (ADDENDA_ONLY)');
    assertEq(report.omitted_columns.join(','), 'carryover_status', 'report should name carryover_status as the omitted ADDENDA_ONLY column');
  });

  await run('T9e', 'item B / #251 follow-up: PER_PROJECT_ENGINE write succeeds; carryover_status is omitted from the INSERT (never NULL-padded, never ALTERed into existence)', async () => {
    const r = runMigrate08(['--db', DB_ENGINE, '--project-id', PROJECT_ENGINE, '--file', activeFilePath, '--history-file', historyFilePath]);
    if (r.status !== 0) throw new Error(`PER_PROJECT_ENGINE write failed: status=${r.status}\nstdout=${r.stdout}\nstderr=${r.stderr}`);
    assert(/MIGRATION_RESULT: PASS/.test(r.stdout), 'expected MIGRATION_RESULT: PASS');
    assert(/branch=PER_PROJECT_ENGINE omitted_columns=\[carryover_status\]/.test(r.stdout), 'expected the omitted_columns log line naming carryover_status');

    assert(!(await assertionColumnExists(DB_ENGINE, 'carryover_status')), 'the write path must never ALTER carryover_status into existence on a PER_PROJECT_ENGINE target');

    const client = await pgConnect(DB_ENGINE);
    try {
      const { rows } = await client.query(
        `SELECT subject, predicate, object, pinned, seq, authoring_mode, source_model, tier, created_at FROM assertions WHERE project_id=$1`,
        [PROJECT_ENGINE]
      );
      assert(rows.length > 0, 'no rows were written to the PER_PROJECT_ENGINE target');
      assert(rows.every((r2) => r2.source_model === 'markdown-migration-h'), 'ENGINE_CANON column source_model must still be written correctly');
      assert(rows.some((r2) => r2.predicate === 'open_thread'), 'expected at least one open_thread row (the row whose carryoverStatus value is now dropped, not NULL-padded)');
    } finally {
      await client.end();
    }
  });

  await run('T9f', 'item B / #251 follow-up: PER_PROJECT_ENGINE re-run is idempotent (delete-and-reinsert, no accretion)', async () => {
    const client = await pgConnect(DB_ENGINE);
    let before;
    try {
      before = (await client.query(`SELECT COUNT(*)::int AS n FROM assertions WHERE project_id=$1`, [PROJECT_ENGINE])).rows[0].n;
    } finally {
      await client.end();
    }
    const r = runMigrate08(['--db', DB_ENGINE, '--project-id', PROJECT_ENGINE, '--file', activeFilePath, '--history-file', historyFilePath]);
    if (r.status !== 0) throw new Error(`PER_PROJECT_ENGINE re-run failed: status=${r.status}\nstderr=${r.stderr}`);
    const client2 = await pgConnect(DB_ENGINE);
    try {
      const after = (await client2.query(`SELECT COUNT(*)::int AS n FROM assertions WHERE project_id=$1`, [PROJECT_ENGINE])).rows[0].n;
      assertEq(after, before, 'PER_PROJECT_ENGINE re-run with unchanged content changed the row count (accretion bug)');
    } finally {
      await client2.end();
    }
  });

  await run('T9g', 'item B / #251 follow-up: PER_PROJECT_ENGINE target missing an ENGINE_CANON column (source_model) fails, naming it', async () => {
    const dbDrifted = `verify08_drifted_${TS}`;
    CREATED_DBS.push(dbDrifted);
    await dropDb(dbDrifted);
    const sys = await pgConnect('postgres');
    await sys.query(`CREATE DATABASE "${dbDrifted}"`);
    await sys.end();
    const projectDrifted = crypto.randomUUID();
    await setupPerProjectEngineTarget(dbDrifted, projectDrifted);
    // Simulate schema drift: a per-project engine DB whose schema_fingerprint
    // marker claims "current" but is actually missing an ENGINE_CANON column
    // (see the PR body's "pass-but-shouldn't" construction for why the
    // fingerprint marker alone is not a content guarantee).
    const client = await pgConnect(dbDrifted);
    try {
      await client.query('ALTER TABLE assertions DROP COLUMN source_model');
    } finally {
      await client.end();
    }

    const reportScratchDir = path.join(SCRATCH_DIR, 'reports-t9g');
    const r = runMigrate08(['--db', dbDrifted, '--project-id', projectDrifted, '--file', activeFilePath, '--dry-run', '--report-dir', reportScratchDir]);
    assertEq(r.status, 1, 'dry-run against a PER_PROJECT_ENGINE target missing an ENGINE_CANON column should exit 1 (FAIL)');
    assert(/DRY_RUN_RESULT: FAIL/.test(r.stdout + r.stderr), 'expected DRY_RUN_RESULT: FAIL');

    const report = readReportFile(reportScratchDir, projectDrifted);
    assertEq(report.precondition_checks.required_columns, 'fail', 'required_columns must FAIL when an ENGINE_CANON column is missing');
    assertEq(report.precondition_checks.missing_columns.join(','), 'source_model', 'missing_columns must name source_model specifically');
  });

  await run('T9h', 'item B / #251 follow-up: requiredColumnsForBranch() throws a hard error for any branch other than CANON/STAGING/PER_PROJECT_ENGINE', () => {
    const migrate08 = require(MIGRATE08_PATH);
    for (const bogusBranch of ['SOURCE_ONLY', 'UNKNOWN', 'NOT_A_REAL_BRANCH', undefined, null]) {
      let threw = false;
      try {
        migrate08.requiredColumnsForBranch(bogusBranch);
      } catch (err) {
        threw = true;
        assert(/unreachable branch/.test(err.message), `expected an "unreachable branch" error message for ${JSON.stringify(bogusBranch)}, got: ${err.message}`);
      }
      assert(threw, `requiredColumnsForBranch(${JSON.stringify(bogusBranch)}) should have thrown — SOURCE_ONLY/UNKNOWN are refused upstream and must never reach this function silently`);
    }
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

  // ── T12-T18: engine index bring-forward (S1) + total-classified
  // integrity-index gate (S2/S3), 2026-09-06 pass — the memory_manager_
  // staging DEFECT reproduction and its fix. ────────────────────────────

  await run('T12', 'S1: a non-success ensureSchemaCurrent reason ("ahead") aborts the write BEFORE checkSchemaPreconditions / any INSERT, zero writes', async () => {
    const projectAhead = `example-project-s1-ahead-${TS}`;
    // A stored fingerprint epoch far newer than this engine build's own
    // SCHEMA_EPOCH -> ensureSchemaCurrentCore's cmp === 'ahead' branch ->
    // {applied:false, reason:'ahead'} -- a controllable, deterministic
    // non-success reason (S1 aborts on ANY non-'current'/'applied' reason,
    // not only 'integrity_index_failed').
    const client = await pgConnect(DB_TARGET);
    try {
      await client.query(
        `INSERT INTO project_settings (project_id, key, value) VALUES ($1, 'schema_fingerprint', $2)
           ON CONFLICT (project_id, key) DO UPDATE SET value = EXCLUDED.value`,
        [projectAhead, `9999:${'0'.repeat(64)}`]
      );
    } finally {
      await client.end();
    }

    const r = runMigrate08(['--db', DB_TARGET, '--project-id', projectAhead, '--file', activeFilePath]);
    assertEq(r.status, 1, 'S1 abort on a non-success ensureSchemaCurrent reason should exit 1');
    assert(/SCHEMA-BRING-FORWARD/.test(r.stdout), 'expected the S1 bring-forward log line');
    assert(/reason=ahead/.test(r.stdout), 'expected reason=ahead in the S1 log line');
    assert(/Refused: schema bring-forward/.test(r.stdout + r.stderr), 'expected the S1 refusal message');

    const after = await pgConnect(DB_TARGET);
    try {
      const { rows } = await after.query(`SELECT COUNT(*)::int AS n FROM assertions WHERE project_id=$1`, [projectAhead]);
      assertEq(rows[0].n, 0, 'S1 abort must happen before any INSERT for this project_id');
    } finally {
      await after.end();
    }
  });

  await run('T13', 'S4(a)/DEFECT REPRO: a target whose index is the stale pre-cm#227 raw form has it brought forward to md5(object) BEFORE the write, and a >2704-byte object row inserts successfully (previously: btree row-size failure)', async () => {
    const dbDefect = `verify08_defect_${TS}_staging`;
    CREATED_DBS.push(dbDefect);
    await createFreshStagingDb(dbDefect);
    await revertIndexToStaleRawForm(dbDefect);
    const before = await getLiveIndexInfo(dbDefect);
    assert(before && /\(project_id, subject, predicate, object\)/.test(before.indexdef), 'fixture bug: index must be reverted to the raw (non-md5) form before this test runs');

    // A durable-section body over 2704 bytes -- this is the exact shape
    // that failed against a live STALE_RAW_OBJECT index ("index row size
    // 3552 exceeds btree version 4 maximum 2704"). 3000 'X' characters,
    // well past the limit, comfortably under the payload schema's 4000-char
    // cap for this kind of content.
    const giantNote = 'X'.repeat(3000);
    const giantFixturePath = writeFixture(
      'HANDOFF-giant-object.md',
      ['## Critical operational notes', '', giantNote, ''].join('\n')
    );

    const projectDefect = `example-project-defect-${TS}`;
    const r = runMigrate08(['--db', dbDefect, '--project-id', projectDefect, '--file', giantFixturePath]);
    if (r.status !== 0) throw new Error(`DEFECT-REPRO write should now succeed: status=${r.status}\nstdout=${r.stdout}\nstderr=${r.stderr}`);
    assert(/MIGRATION_RESULT: PASS/.test(r.stdout), 'expected MIGRATION_RESULT: PASS');
    assert(/integrity_index_class=CURRENT/.test(r.stdout), 'expected the post-bring-forward index class to be logged as CURRENT');

    const after = await getLiveIndexInfo(dbDefect);
    assert(after && /md5\(object\)/.test(after.indexdef), 'the index must have been brought forward to the md5(object) canonical form');
    assertEq(after.indisvalid, true, 'the brought-forward index must be valid');

    const client = await pgConnect(dbDefect);
    try {
      const { rows } = await client.query(
        `SELECT length(object) AS len FROM assertions WHERE project_id=$1 AND predicate='critical_operational_notes'`,
        [projectDefect]
      );
      assertEq(rows.length, 1, 'expected exactly one critical_operational_notes row');
      assert(rows[0].len > 2704, `expected the giant object row to actually persist (>2704 bytes), got length=${rows[0].len}`);
    } finally {
      await client.end();
    }
  });

  // ── T14: S2 total classification, one sub-case per class (+ the
  // same-name-on-another-table MISSING variant) ────────────────────────
  const DB_CLASSIFY = `verify08_classify_${TS}_staging`;
  await run('T14a', 'S2: CURRENT -- freshly-provisioned canonical schema classifies CURRENT', async () => {
    CREATED_DBS.push(DB_CLASSIFY);
    await createFreshStagingDb(DB_CLASSIFY);
    const client = await pgConnect(DB_CLASSIFY);
    try {
      const result = await migrate08Module.classifyIntegrityIndex(client);
      assertEq(result.class, 'CURRENT', 'expected CURRENT on a freshly-provisioned canonical schema');
      assertEq(result.indisvalid, true, 'CURRENT requires indisvalid=true');
      assertEq(result.indisunique, true, 'CURRENT requires indisunique=true');
    } finally {
      await client.end();
    }
  });

  await run('T14b', 'S2: STALE_RAW_OBJECT -- the known pre-cm#227 raw form classifies STALE_RAW_OBJECT', async () => {
    await revertIndexToStaleRawForm(DB_CLASSIFY);
    const client = await pgConnect(DB_CLASSIFY);
    try {
      const result = await migrate08Module.classifyIntegrityIndex(client);
      assertEq(result.class, 'STALE_RAW_OBJECT', 'expected STALE_RAW_OBJECT on the reverted raw-form index');
    } finally {
      await client.end();
    }
  });

  await run('T14c', 'S2: MISSING -- no index at all on assertions', async () => {
    const client = await pgConnect(DB_CLASSIFY);
    try {
      await client.query('DROP INDEX IF EXISTS assertions_1ton_exact_unique');
      const result = await migrate08Module.classifyIntegrityIndex(client);
      assertEq(result.class, 'MISSING', 'expected MISSING when no such index exists on assertions');
      assertEq(result.indexdef, null, 'MISSING must carry a null indexdef');
    } finally {
      await client.end();
    }
  });

  await run('T14d', 'S2: MISSING -- a same-named index exists, but on a DIFFERENT table (indrelid-scoped, never a bare relname match)', async () => {
    const client = await pgConnect(DB_CLASSIFY);
    try {
      await client.query('CREATE TABLE other_table_test_t14d (project_id text, subject text, predicate text, object text, suppressed boolean)');
      await client.query('CREATE UNIQUE INDEX assertions_1ton_exact_unique ON other_table_test_t14d (project_id, subject, predicate, object) WHERE suppressed = false');
      const result = await migrate08Module.classifyIntegrityIndex(client);
      assertEq(result.class, 'MISSING', 'a same-named index on a different table must still classify MISSING for assertions');
      await client.query('DROP TABLE other_table_test_t14d');
    } finally {
      await client.end();
    }
  });

  await run('T14e', 'S2: UNRECOGNIZED -- a valid index whose shape matches neither canonical nor the known stale-raw form', async () => {
    const client = await pgConnect(DB_CLASSIFY);
    try {
      await client.query('CREATE UNIQUE INDEX assertions_1ton_exact_unique ON assertions (project_id, subject, predicate) WHERE suppressed = false');
      const result = await migrate08Module.classifyIntegrityIndex(client);
      assertEq(result.class, 'UNRECOGNIZED', 'expected UNRECOGNIZED for an unrecognized valid shape');
      assertEq(result.indisvalid, true, 'this fixture is deliberately VALID -- proves UNRECOGNIZED is not only reached via the invalid path');
      await client.query('DROP INDEX assertions_1ton_exact_unique');
    } finally {
      await client.end();
    }
  });

  await run('T14f', 'S2: UNRECOGNIZED -- an INVALID index of the CANONICAL shape is still UNRECOGNIZED, never CURRENT (indisvalid checked before any shape comparison)', async () => {
    const client = await pgConnect(DB_CLASSIFY);
    try {
      await client.query('CREATE UNIQUE INDEX assertions_1ton_exact_unique ON assertions (project_id, subject, predicate, md5(object)) WHERE suppressed = false');
      await client.query(`UPDATE pg_index SET indisvalid = false WHERE indexrelid = 'assertions_1ton_exact_unique'::regclass`);
      const result = await migrate08Module.classifyIntegrityIndex(client);
      assertEq(result.class, 'UNRECOGNIZED', 'an INVALID index of the canonical shape must classify UNRECOGNIZED, never CURRENT');
      assertEq(result.indisvalid, false, 'sanity: the fixture is genuinely marked invalid');
    } finally {
      await client.end();
    }
  });

  // ── T15: S3 dry-run reporting per class ───────────────────────────────
  const DB_DRYCLASS = `verify08_dryclass_${TS}_staging`;
  await run('T15a', 'S3: dry-run against STALE_RAW_OBJECT is PASS-with-note ("write mode will bring forward"), never FAIL', async () => {
    CREATED_DBS.push(DB_DRYCLASS);
    await createFreshStagingDb(DB_DRYCLASS);
    await revertIndexToStaleRawForm(DB_DRYCLASS);
    const reportScratchDir = path.join(SCRATCH_DIR, 'reports-t15a');
    const projectDry = `example-project-dry-stale-${TS}`;
    const r = runMigrate08(['--db', DB_DRYCLASS, '--project-id', projectDry, '--file', activeFilePath, '--dry-run', '--report-dir', reportScratchDir]);
    if (r.status !== 0) throw new Error(`dry-run against STALE_RAW_OBJECT should PASS: status=${r.status}\nstdout=${r.stdout}\nstderr=${r.stderr}`);
    assert(/DRY_RUN_RESULT: PASS/.test(r.stdout), 'expected DRY_RUN_RESULT: PASS for STALE_RAW_OBJECT');
    assert(/write mode will bring forward/.test(r.stdout), 'expected the "write mode will bring forward" note');
    const report = readReportFile(reportScratchDir, projectDry);
    assertEq(report.integrity_index_class, 'STALE_RAW_OBJECT', 'report should carry integrity_index_class=STALE_RAW_OBJECT');
  });

  await run('T15b', 'S3: dry-run against MISSING is PASS-with-note ("write mode will bring forward"), never FAIL', async () => {
    const client = await pgConnect(DB_DRYCLASS);
    try {
      await client.query('DROP INDEX IF EXISTS assertions_1ton_exact_unique');
    } finally {
      await client.end();
    }
    const reportScratchDir = path.join(SCRATCH_DIR, 'reports-t15b');
    const projectDry = `example-project-dry-missing-${TS}`;
    const r = runMigrate08(['--db', DB_DRYCLASS, '--project-id', projectDry, '--file', activeFilePath, '--dry-run', '--report-dir', reportScratchDir]);
    if (r.status !== 0) throw new Error(`dry-run against MISSING should PASS: status=${r.status}\nstdout=${r.stdout}\nstderr=${r.stderr}`);
    assert(/DRY_RUN_RESULT: PASS/.test(r.stdout), 'expected DRY_RUN_RESULT: PASS for MISSING');
    assert(/write mode will bring forward/.test(r.stdout), 'expected the "write mode will bring forward" note');
    const report = readReportFile(reportScratchDir, projectDry);
    assertEq(report.integrity_index_class, 'MISSING', 'report should carry integrity_index_class=MISSING');
  });

  await run('T15c', 'S3: dry-run against UNRECOGNIZED FAILs the dry-run report (never silently PASS)', async () => {
    const client = await pgConnect(DB_DRYCLASS);
    try {
      await client.query('CREATE UNIQUE INDEX assertions_1ton_exact_unique ON assertions (project_id, subject, predicate) WHERE suppressed = false');
    } finally {
      await client.end();
    }
    const reportScratchDir = path.join(SCRATCH_DIR, 'reports-t15c');
    const projectDry = `example-project-dry-unrecognized-${TS}`;
    const r = runMigrate08(['--db', DB_DRYCLASS, '--project-id', projectDry, '--file', activeFilePath, '--dry-run', '--report-dir', reportScratchDir]);
    assertEq(r.status, 1, 'dry-run against UNRECOGNIZED must exit 1 (FAIL)');
    assert(/DRY_RUN_RESULT: FAIL/.test(r.stdout + r.stderr), 'expected DRY_RUN_RESULT: FAIL for UNRECOGNIZED');
    const report = readReportFile(reportScratchDir, projectDry);
    assertEq(report.integrity_index_class, 'UNRECOGNIZED', 'report should carry integrity_index_class=UNRECOGNIZED');
  });

  await run('T16', 'S1 doc / S4(c): a failed CREATE in the DROP+CREATE pair leaves the pre-existing (stale) index intact -- db-seam.js runIntegrityIndexPair rolls the paired DROP back too', async () => {
    const dbPair = `verify08_pairfail_${TS}`;
    CREATED_DBS.push(dbPair);
    await dropDb(dbPair);
    const sys = await pgConnect('postgres');
    await sys.query(`CREATE DATABASE "${dbPair}"`);
    await sys.end();

    const client = await pgConnect(dbPair);
    try {
      await client.query('CREATE TABLE assertions (project_id text, subject text, predicate text, object text, suppressed boolean)');
      const rawCreate = 'CREATE UNIQUE INDEX assertions_1ton_exact_unique ON assertions (project_id, subject, predicate, object) WHERE suppressed = false';
      await client.query(rawCreate);

      const adapter = new PostgresAdapter(client);
      // Deliberately-broken createSql (references a nonexistent column) --
      // a deterministic, reproducible CREATE failure that exercises the
      // SAME atomic DROP+CREATE pairing S1's bring-forward relies on,
      // without depending on an unconstructable genuine md5-collision
      // scenario (see this PR's BLIND SPOTS).
      const dropSql = 'DROP INDEX IF EXISTS assertions_1ton_exact_unique';
      const badCreate = 'CREATE UNIQUE INDEX assertions_1ton_exact_unique ON assertions (project_id, subject, predicate, md5(does_not_exist)) WHERE suppressed = false';

      const result = await adapter.runIntegrityIndexPair(dropSql, badCreate);
      assertEq(result.ok, false, 'the deliberately-broken CREATE must fail');

      const { rows } = await client.query(
        `SELECT pg_get_indexdef(i.indexrelid) AS def, i.indisvalid
           FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
          WHERE i.indrelid = 'assertions'::regclass AND c.relname = 'assertions_1ton_exact_unique'`
      );
      assertEq(rows.length, 1, 'the pre-existing index must still be present after the failed CREATE (DROP was rolled back too)');
      assertEq(rows[0].indisvalid, true, 'the surviving index must still be valid');
      assert(/, object\)/.test(rows[0].def), 'the surviving index must be the untouched RAW form, not partially rebuilt into the canonical shape');
    } finally {
      await client.end();
    }
  });

  await run('T17', 'S4(d): S1 bring-forward on a shared STAGING target is idempotent across two DISTINCT project_ids', async () => {
    const projectS1a = `example-project-s1-shared-a-${TS}`;
    const projectS1b = `example-project-s1-shared-b-${TS}`;
    const r1 = runMigrate08(['--db', DB_TARGET, '--project-id', projectS1a, '--file', activeFilePath]);
    if (r1.status !== 0) throw new Error(`first project_id write failed: status=${r1.status}\nstderr=${r1.stderr}`);
    assert(/MIGRATION_RESULT: PASS/.test(r1.stdout), 'expected PASS for the first project_id');
    assert(/integrity_index_class=CURRENT/.test(r1.stdout), 'expected CURRENT for the first project_id');

    const r2 = runMigrate08(['--db', DB_TARGET, '--project-id', projectS1b, '--file', activeFilePath]);
    if (r2.status !== 0) throw new Error(`second (distinct) project_id write failed: status=${r2.status}\nstderr=${r2.stderr}`);
    assert(/MIGRATION_RESULT: PASS/.test(r2.stdout), 'expected PASS for the second, distinct project_id');
    assert(/integrity_index_class=CURRENT/.test(r2.stdout), 'expected CURRENT for the second project_id');

    const after = await getLiveIndexInfo(DB_TARGET);
    assert(after && /md5\(object\)/.test(after.indexdef) && after.indisvalid === true, 'the shared target\'s index must remain the valid canonical form after both runs');
  });

  await run('T18', 'S4(e)/S2: dry-run leaves ZERO persistent objects on the target (pg_class row count unchanged before/after)', async () => {
    const before = await pgConnect(DB_TARGET);
    let countBefore;
    try {
      countBefore = (await before.query(`SELECT COUNT(*)::int AS n FROM pg_class`)).rows[0].n;
    } finally {
      await before.end();
    }

    const projectDry = `example-project-dry-nopersist-${TS}`;
    const reportScratchDir = path.join(SCRATCH_DIR, 'reports-t18');
    const r = runMigrate08(['--db', DB_TARGET, '--project-id', projectDry, '--file', activeFilePath, '--dry-run', '--report-dir', reportScratchDir]);
    if (r.status !== 0) throw new Error(`dry-run failed: status=${r.status}\nstderr=${r.stderr}`);
    assert(/DRY_RUN_RESULT: PASS/.test(r.stdout), 'expected DRY_RUN_RESULT: PASS');

    const after = await pgConnect(DB_TARGET);
    let countAfter;
    try {
      countAfter = (await after.query(`SELECT COUNT(*)::int AS n FROM pg_class`)).rows[0].n;
    } finally {
      await after.end();
    }
    assertEq(countAfter, countBefore, 'dry-run must leave zero persistent catalog objects (temp tables must be rolled back, never committed)');
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
