'use strict';

/**
 * test-migrate-05-sync-file-memory.js
 *
 * Regression suite for scripts/migrations/migrate-05-sync-file-memory.js
 * (§6.1(f) + its F5-1..F5-12 amendment, mm#11(f)). Synthetic fixtures ONLY
 * (H-13 rule) -- no real topic-file prose, no real project ids, no real
 * database names beyond the already-public `claude_policy_framework`/
 * `pipeline_pipeline` literals migrate-04's own test suite already uses
 * (not new leaked info) -- and even those two are only referenced by
 * db-triage classification tests here, never actually connected to.
 *
 * Self-contained: creates/drops its own `_staging`-suffixed scratch target
 * database, scratch "absorb source" databases (custom names, injected via
 * runStepA/runStepB's absorbSourceDbs/excludedSourceDbs override params --
 * see migrate-05's own header comment on why this override exists), and an
 * isolated scratch filesystem tree for Step C. Never touches
 * claude_policy_framework/pipeline_pipeline/memory_manager_staging/any real
 * ~/.claude/projects directory.
 *
 * Usage: node test/migrations/test-migrate-05-sync-file-memory.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { createRequire } = require('module');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const MIGRATE05_PATH = path.join(PROJECT_ROOT, 'scripts', 'migrations', 'migrate-05-sync-file-memory.js');
const migrate05 = require(MIGRATE05_PATH);

const scriptsRequire = createRequire(require.resolve('../../scripts/package.json'));
const { Client } = scriptsRequire('pg');
const shared = require(path.join(PROJECT_ROOT, 'scripts', 'migrations', 'lib', 'verify15-shared.js'));
const migrateOne = require(path.join(PROJECT_ROOT, 'scripts', 'migrations', 'migrate-01-canonical-db.js'));
const sourceFileNormalize = require(path.join(PROJECT_ROOT, 'scripts', 'lib', 'source-file-normalize.js'));

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

function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

function writeTempJson(name, data) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'migrate05-test-'));
  const p = path.join(dir, name);
  fs.writeFileSync(p, JSON.stringify(data, null, 2), 'utf8');
  return p;
}

// ─── SYNTHETIC FIXTURES ─────────────────────────────────────────────────────

const SYNTH_DB_TRIAGE = writeTempJson('db-triage.json', {
  databases: {
    claude_policy_framework: 'REAL-MIGRATE',
    pipeline_pipeline: 'REAL-MIGRATE',
    example_ephemeral_db: 'EPHEMERAL-DROP',
  },
});

// ─── MAIN ───────────────────────────────────────────────────────────────────

async function main() {
  console.log('test-migrate-05-sync-file-memory: starting');

  // ── db-triage total classification reuse (E-1/E-8 pattern) ──────────────
  const migrate04 = require(path.join(PROJECT_ROOT, 'scripts', 'migrations', 'migrate-04-absorb-pipeline-tables.js'));
  await run('DBT-1', 'REAL-MIGRATE absorb source classified correctly (reused via reference)', async () => {
    const triage = migrate04.loadDbTriage(SYNTH_DB_TRIAGE);
    assert(migrate04.classifyDb('claude_policy_framework', triage) === 'REAL-MIGRATE', 'expected REAL-MIGRATE');
  });
  await run('DBT-2', 'unclassified absorb source db refuses (never guessed REAL-MIGRATE)', async () => {
    const triage = migrate04.loadDbTriage(SYNTH_DB_TRIAGE);
    assert(migrate04.classifyDb('some_never_seen_db', triage) === 'UNCLASSIFIED', 'expected UNCLASSIFIED default branch');
  });

  // ── checkAbsorbColumnShape: precondition (mirrors migrate-04's own CSP tests) ──
  await run('CSP-1', 'declared column set passes precondition', () => {
    const unmapped = migrate05.checkAbsorbColumnShape(['id', 'created_at', 'name', 'body'], { name: 'name', body: 'body' });
    assert(unmapped.length === 0, `expected clean precondition, got ${JSON.stringify(unmapped)}`);
  });
  await run('CSP-2', 'undeclared live column refused, never silently dropped', () => {
    const unmapped = migrate05.checkAbsorbColumnShape(['id', 'name', 'body', 'brand_new_col'], { name: 'name', body: 'body' });
    assert(unmapped.length === 1 && unmapped[0] === 'brand_new_col', `expected ['brand_new_col'], got ${JSON.stringify(unmapped)}`);
  });
  await run('CSP-3', 'extraIgnored (entry_id) column excluded from unmapped set', () => {
    const unmapped = migrate05.checkAbsorbColumnShape(['id', 'entry_id', 'content'], { content: 'content' }, ['entry_id']);
    assert(unmapped.length === 0, `expected clean precondition, got ${JSON.stringify(unmapped)}`);
  });

  // ── extractDescription: first "# " heading AFTER any frontmatter block ──
  await run('DESC-1', 'description sourced from first # heading in body, not frontmatter', () => {
    const body = '\nSome preamble text.\n\n# Real Title\n\nBody text follows.';
    assert(migrate05.extractDescription(body) === 'Real Title', `got ${migrate05.extractDescription(body)}`);
  });
  await run('DESC-2', 'no "# " heading anywhere -> null, never a false positive on "## "', () => {
    const body = '## Not an H1\n\nJust prose.';
    assert(migrate05.extractDescription(body) === null, `expected null, got ${migrate05.extractDescription(body)}`);
  });

  // ── identity normalization (comparison key folding) ─────────────────────
  await run('NORM-1', 'backslash and forward-slash "memory/" forms fold to the same comparison key', () => {
    const a = sourceFileNormalize.normalize('memory/Foo.md');
    const b = sourceFileNormalize.normalize('memory\\Foo.md');
    const c = sourceFileNormalize.normalize('Foo.md');
    assert(a === b && b === c, `expected identical keys, got a=${a} b=${b} c=${c}`);
  });

  // ── LIVE DB fixtures ──────────────────────────────────────────────────────
  const stamp = Date.now();
  const TARGET_DB = `migrate05_test_${stamp}_staging`;
  const SRC_CPF = `migrate05_test_src_cpf_${stamp}`;
  const SRC_PP = `migrate05_test_src_pp_${stamp}`;
  const SRC_EXCL = `migrate05_test_src_excl_${stamp}`;
  const ABSORB_DBS = [SRC_CPF, SRC_PP];
  const EXCLUDED_DBS = { [SRC_EXCL]: 'test-artifact-db' };
  const DB_TRIAGE_PATH = writeTempJson('db-triage-live.json', {
    databases: { [SRC_CPF]: 'REAL-MIGRATE', [SRC_PP]: 'REAL-MIGRATE' },
  });
  const dbTriage = migrate04.loadDbTriage(DB_TRIAGE_PATH);

  await createDb(TARGET_DB);
  await createDb(SRC_CPF);
  await createDb(SRC_PP);
  await createDb(SRC_EXCL);

  const scratchDirs = [];
  try {
    const tgt = await pgConnect(TARGET_DB);
    try {
      await tgt.query('CREATE EXTENSION IF NOT EXISTS vector');
      await tgt.query(`
        CREATE TABLE memory_entries (
          id SERIAL PRIMARY KEY,
          name TEXT NOT NULL,
          description TEXT,
          mem_type TEXT,
          body TEXT NOT NULL,
          source_file TEXT UNIQUE,
          content_hash TEXT,
          created_at TIMESTAMPTZ DEFAULT NOW(),
          updated_at TIMESTAMPTZ DEFAULT NOW(),
          embedding vector(1024),
          project_id TEXT NOT NULL
        );
        CREATE TABLE memory_entry_chunks (
          id SERIAL PRIMARY KEY,
          entry_id INTEGER NOT NULL REFERENCES memory_entries(id) ON DELETE CASCADE,
          chunk_idx INTEGER NOT NULL,
          content TEXT NOT NULL,
          content_hash TEXT,
          created_at TIMESTAMPTZ DEFAULT NOW(),
          embedding vector(1024),
          project_id TEXT NOT NULL,
          UNIQUE (entry_id, chunk_idx)
        );
      `);
      await shared.applyDdl(tgt); // migration_manifest + pipeline_migration_row_ids
      await migrateOne.applySqlFile(tgt, migrate05.SQL_FILE); // drop UNIQUE(source_file), plain indexes, last_modified col

      // Source schemas mirror the REAL absorb sources (no content_hash on
      // memory_entries -- see migrate-05's own ABSORB_COLUMN_MAPS comment;
      // content_hash IS present on memory_entry_chunks).
      for (const src of [SRC_CPF, SRC_PP]) {
        const c = await pgConnect(src);
        try {
          await c.query(`
            CREATE TABLE memory_entries (
              id SERIAL PRIMARY KEY, name TEXT NOT NULL, description TEXT, mem_type TEXT,
              body TEXT NOT NULL, source_file TEXT, project_id TEXT
            );
            CREATE TABLE memory_entry_chunks (
              id SERIAL PRIMARY KEY, entry_id INTEGER NOT NULL, chunk_idx INTEGER NOT NULL,
              content TEXT NOT NULL, content_hash TEXT, project_id TEXT
            );
          `);
        } finally {
          await c.end();
        }
      }
      {
        const c = await pgConnect(SRC_EXCL);
        try {
          await c.query(`
            CREATE TABLE memory_entries (
              id SERIAL PRIMARY KEY, name TEXT NOT NULL, description TEXT, mem_type TEXT,
              body TEXT NOT NULL, source_file TEXT, project_id TEXT
            );
          `);
          await c.query(`INSERT INTO memory_entries (name, body, source_file, project_id) VALUES ('junk', 'junk body', 'memory/junk.md', 'some-proj')`);
        } finally {
          await c.end();
        }
      }

      // ── STEP A: seed rows in both absorb sources, migrate, verify lineage-gated idempotency ──
      await run('ABSORB-1', 'Step A migrates rows from both sources under lossless-fidelity column shape', async () => {
        const c1 = await pgConnect(SRC_CPF);
        await c1.query(`INSERT INTO memory_entries (name, description, mem_type, body, source_file, project_id) VALUES ('cpf1', 'd1', 'project', 'cpf body one', 'actions/cpf1.md', 'proj-alpha')`);
        await c1.end();
        const c2 = await pgConnect(SRC_PP);
        await c2.query(`INSERT INTO memory_entries (name, description, mem_type, body, source_file, project_id) VALUES ('pp1', 'd2', 'feedback', 'pp body one', 'memory/pp1.md', 'proj-alpha')`);
        await c2.end();

        const result = await migrate05.runStepA(tgt, dbTriage, false, () => {}, ABSORB_DBS);
        assert(result.precheckFailures.length === 0, `expected no precheck failures, got ${JSON.stringify(result.precheckFailures)}`);
        const { rows } = await tgt.query(`SELECT COUNT(*)::int AS n FROM memory_entries WHERE project_id='proj-alpha'`);
        assert(rows[0].n === 2, `expected 2 absorbed rows, got ${rows[0].n}`);

        // content_hash is COMPUTED (source never carries it) -- verify non-null.
        const { rows: hashRows } = await tgt.query(`SELECT content_hash FROM memory_entries WHERE project_id='proj-alpha'`);
        for (const r of hashRows) assert(r.content_hash && r.content_hash.length === 64, `expected a computed sha256 content_hash, got ${r.content_hash}`);
      });

      await run('ABSORB-2', 'lineage-gated idempotency: re-run is a zero-delta no-op', async () => {
        const before = (await tgt.query(`SELECT COUNT(*)::int AS n FROM memory_entries`)).rows[0].n;
        const result = await migrate05.runStepA(tgt, dbTriage, false, () => {}, ABSORB_DBS);
        for (const s of result.perSlice) assert(s.migrated === 0, `expected zero newly-migrated on re-run, got ${JSON.stringify(s)}`);
        const after = (await tgt.query(`SELECT COUNT(*)::int AS n FROM memory_entries`)).rows[0].n;
        assert(before === after, `expected zero row-count delta, before=${before} after=${after}`);
      });

      // ── STEP B: exclusion-row writes ─────────────────────────────────────
      await run('EXCL-1', 'excluded source writes a manifest slice with excluded_reason, never inserts target rows', async () => {
        const beforeCount = (await tgt.query(`SELECT COUNT(*)::int AS n FROM memory_entries`)).rows[0].n;
        const exclusions = await migrate05.runStepB(tgt, false, () => {}, EXCLUDED_DBS);
        assert(exclusions.length === 1 && exclusions[0].reason === 'test-artifact-db', `expected one test-artifact-db exclusion, got ${JSON.stringify(exclusions)}`);
        const afterCount = (await tgt.query(`SELECT COUNT(*)::int AS n FROM memory_entries`)).rows[0].n;
        assert(beforeCount === afterCount, 'excluded slice must never write target rows');
        const { rows } = await tgt.query(
          `SELECT row_count, excluded_reason FROM migration_manifest WHERE source_db=$1 AND source_table=$2`,
          [SRC_EXCL, migrate05.ABSORB_MANIFEST_LABELS.memory_entries]
        );
        assert(rows.length === 1 && Number(rows[0].row_count) === 1 && rows[0].excluded_reason === 'test-artifact-db', `expected one excluded manifest row, got ${JSON.stringify(rows)}`);
      });

      await run('EXCL-2', 'NULL-safe manifest re-write (field-found fix): re-running Step B never duplicates the excluded slice', async () => {
        await migrate05.runStepB(tgt, false, () => {}, EXCLUDED_DBS);
        await migrate05.runStepB(tgt, false, () => {}, EXCLUDED_DBS);
        const { rows } = await tgt.query(
          `SELECT COUNT(*)::int AS n FROM migration_manifest WHERE source_db=$1 AND source_table=$2`,
          [SRC_EXCL, migrate05.ABSORB_MANIFEST_LABELS.memory_entries]
        );
        assert(rows[0].n === 1, `expected exactly one manifest row after repeated re-runs (never a NULL-equality duplicate), got ${rows[0].n}`);
      });

      // ── Manifest labels never collide with migrate-03's bare table names ──
      await run('LABEL-1', 'Step A/B manifest source_table labels are distinct from the bare table names', () => {
        assert(migrate05.ABSORB_MANIFEST_LABELS.memory_entries !== 'memory_entries', 'must not collide with migrate-03\'s own manifest bookkeeping');
        assert(migrate05.ABSORB_MANIFEST_LABELS.memory_entry_chunks !== 'memory_entry_chunks', 'must not collide with migrate-03\'s own manifest bookkeeping');
      });

      // ── STEP C: filesystem sync fixtures ────────────────────────────────
      const projRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'migrate05-projects-'));
      scratchDirs.push(projRoot);
      const dirName = 'C--scratch-proj-one';
      const memDir = path.join(projRoot, dirName, 'memory');
      fs.mkdirSync(memDir, { recursive: true });
      const PROJECT_ID = 'scratch-project-uuid-1';
      const ENROLLMENT_PATH = writeTempJson('enrollment.json', {
        enrolled_dirs: [{ dir_name: dirName, project_id: PROJECT_ID }],
        test_artifact_patterns: [],
      });
      const enrollmentConfig = require(path.join(PROJECT_ROOT, 'scripts', 'migrations', 'migrate-09-file-memory-markdown.js')).loadEnrollmentConfig(ENROLLMENT_PATH);

      fs.writeFileSync(path.join(memDir, 'MEMORY.md'), '# Index\n\n- [topic-one](topic-one.md) — a topic\n');
      fs.writeFileSync(path.join(memDir, 'topic-one.md'), '---\ntype: project\n---\n\n# Topic One\n\nSome body content for topic one.\n');
      fs.writeFileSync(path.join(memDir, 'weird_no_type.md'), '# No Frontmatter Type\n\nBody with no frontmatter at all.\n');

      const divMap0 = await migrate05.buildDivergenceMap(tgt);
      const r1 = await migrate05.processEnrolledDir(tgt, PROJECT_ID, dirName, memDir, divMap0, false, () => {});

      await run('SYNC-1', 'MEMORY.md is excluded by exact name, case-insensitive (I-7 reuse)', () => {
        assert(r1.counts.total === 2, `expected 2 topic files (MEMORY.md excluded), got ${r1.counts.total}`);
      });
      await run('SYNC-2', 'new files insert rows with the canonical memory/<filename> source_file', async () => {
        const { rows } = await tgt.query(`SELECT source_file FROM memory_entries WHERE project_id=$1 ORDER BY source_file`, [PROJECT_ID]);
        assert(rows.length === 2, `expected 2 rows, got ${rows.length}`);
        assert(rows.some((r) => r.source_file === 'memory/topic-one.md'), `expected canonical source_file, got ${JSON.stringify(rows)}`);
      });
      await run('SYNC-3', 'unmatched-type fallback: no frontmatter type and no filename prefix -> mem_type NULL, row still written', async () => {
        const { rows } = await tgt.query(`SELECT mem_type FROM memory_entries WHERE project_id=$1 AND source_file='memory/weird_no_type.md'`, [PROJECT_ID]);
        assert(rows.length === 1 && rows[0].mem_type === null, `expected mem_type NULL row still written, got ${JSON.stringify(rows)}`);
      });
      await run('SYNC-4', 'no-embedding-write invariant: embedding stays NULL after Step C writes', async () => {
        const { rows } = await tgt.query(`SELECT COUNT(*)::int AS n FROM memory_entries WHERE project_id=$1 AND embedding IS NOT NULL`, [PROJECT_ID]);
        assert(rows[0].n === 0, `expected zero non-null embeddings, got ${rows[0].n}`);
        const { rows: chunkRows } = await tgt.query(`SELECT COUNT(*)::int AS n FROM memory_entry_chunks mc JOIN memory_entries me ON me.id=mc.entry_id WHERE me.project_id=$1 AND mc.embedding IS NOT NULL`, [PROJECT_ID]);
        assert(chunkRows[0].n === 0, `expected zero non-null chunk embeddings, got ${chunkRows[0].n}`);
      });

      await run('SYNC-5', 'idempotent re-run: unchanged files produce zero live-matched-changed / new', async () => {
        const divMap = await migrate05.buildDivergenceMap(tgt);
        const r2 = await migrate05.processEnrolledDir(tgt, PROJECT_ID, dirName, memDir, divMap, false, () => {});
        assert(r2.counts.new === 0 && r2.counts.liveMatchedChanged === 0, `expected zero new/changed on re-run, got ${JSON.stringify(r2.counts)}`);
        assert(r2.counts.liveMatchedUnchanged === 2, `expected 2 live-matched-unchanged, got ${JSON.stringify(r2.counts)}`);
      });

      // ── stale-chunk deletion on shrink (F5-3) ────────────────────────────
      await run('CHUNK-1', 'a shrunk file deletes its now-stale higher-idx chunks in the same transaction', async () => {
        const bigBody = '# Topic One\n\n' + 'A'.repeat(5000) + '\n\n## Section 2\n\n' + 'B'.repeat(3000);
        fs.writeFileSync(path.join(memDir, 'topic-one.md'), `---\ntype: project\n---\n\n${bigBody}\n`);
        const divMapA = await migrate05.buildDivergenceMap(tgt);
        await migrate05.processEnrolledDir(tgt, PROJECT_ID, dirName, memDir, divMapA, false, () => {});
        const { rows: entryRows } = await tgt.query(`SELECT id FROM memory_entries WHERE project_id=$1 AND source_file='memory/topic-one.md'`, [PROJECT_ID]);
        const entryId = entryRows[0].id;
        const before = (await tgt.query(`SELECT COUNT(*)::int AS n FROM memory_entry_chunks WHERE entry_id=$1`, [entryId])).rows[0].n;
        assert(before > 1, `expected multiple chunks for the big body, got ${before}`);

        fs.writeFileSync(path.join(memDir, 'topic-one.md'), '---\ntype: project\n---\n\n# Topic One\n\nShrunk back down.\n');
        const divMapB = await migrate05.buildDivergenceMap(tgt);
        await migrate05.processEnrolledDir(tgt, PROJECT_ID, dirName, memDir, divMapB, false, () => {});
        const after = (await tgt.query(`SELECT COUNT(*)::int AS n FROM memory_entry_chunks WHERE entry_id=$1`, [entryId])).rows[0].n;
        assert(after === 1, `expected exactly 1 chunk after shrink (stale higher-idx deleted), got ${after}`);
      });

      // ── file-gone kept-flagged (F5-9) ────────────────────────────────────
      await run('GONE-1', 'a deleted topic file is kept in target and reported file-gone, never deleted', async () => {
        fs.unlinkSync(path.join(memDir, 'weird_no_type.md'));
        const divMap = await migrate05.buildDivergenceMap(tgt);
        const r3 = await migrate05.processEnrolledDir(tgt, PROJECT_ID, dirName, memDir, divMap, false, () => {});
        assert(r3.counts.fileGone === 1, `expected 1 file-gone, got ${JSON.stringify(r3.counts)}`);
        const { rows } = await tgt.query(`SELECT COUNT(*)::int AS n FROM memory_entries WHERE project_id=$1 AND source_file='memory/weird_no_type.md'`, [PROJECT_ID]);
        assert(rows[0].n === 1, `expected the file-gone row to be KEPT, got count=${rows[0].n}`);
      });

      // ── renamed-candidate reporting (F5-9, never auto-merged) ────────────
      await run('RENAME-1', 'same content-hash different filename is reported renamed-candidate, never auto-merged (a NEW row is written)', async () => {
        const oldPath = path.join(memDir, 'rename-src.md');
        fs.writeFileSync(oldPath, '---\ntype: reference\n---\n\n# Rename Source\n\nIdentical content for rename detection.\n');
        let divMap = await migrate05.buildDivergenceMap(tgt);
        await migrate05.processEnrolledDir(tgt, PROJECT_ID, dirName, memDir, divMap, false, () => {});

        fs.renameSync(oldPath, path.join(memDir, 'rename-dst.md'));
        divMap = await migrate05.buildDivergenceMap(tgt);
        const r4 = await migrate05.processEnrolledDir(tgt, PROJECT_ID, dirName, memDir, divMap, false, () => {});
        const renameEvents = r4.events.filter((e) => e.kind === 'renamed-candidate');
        assert(renameEvents.length === 1 && renameEvents[0].oldFileName === 'rename-src.md', `expected a renamed-candidate event, got ${JSON.stringify(r4.events)}`);
        const { rows } = await tgt.query(`SELECT source_file FROM memory_entries WHERE project_id=$1 AND name IN ('rename-src','rename-dst')`, [PROJECT_ID]);
        assert(rows.length === 2, `expected BOTH old and new rows to coexist (never auto-merged), got ${JSON.stringify(rows)}`);
      });

      // ── cross-project same-filename non-collision (F5-2 supersession) ────
      await run('CROSS-1', 'two different projects\' files sharing a filename coexist under the same source_file value', async () => {
        const dirName2 = 'C--scratch-proj-two';
        const memDir2 = path.join(projRoot, dirName2, 'memory');
        fs.mkdirSync(memDir2, { recursive: true });
        scratchDirs.push(memDir2);
        fs.writeFileSync(path.join(memDir2, 'topic-one.md'), '---\ntype: user\n---\n\n# Topic One In Project Two\n\nDifferent content, same filename.\n');
        const PROJECT_ID_2 = 'scratch-project-uuid-2';
        const divMap = await migrate05.buildDivergenceMap(tgt);
        await migrate05.processEnrolledDir(tgt, PROJECT_ID_2, dirName2, memDir2, divMap, false, () => {});
        const { rows } = await tgt.query(`SELECT project_id FROM memory_entries WHERE source_file='memory/topic-one.md' ORDER BY project_id`);
        assert(rows.length === 2, `expected 2 rows sharing source_file='memory/topic-one.md' across 2 projects (no UNIQUE violation post-supersession), got ${JSON.stringify(rows)}`);
      });

      // ── absorb-adoption / divergence diffing (F5-8/C-3) ──────────────────
      await run('DIVERGE-1', 'a live file matching an absorbed row\'s content_hash is ADOPTED (renamed, not duplicated)', async () => {
        const c1 = await pgConnect(SRC_CPF);
        const legacyBody = 'adoption body content shared verbatim';
        // Backslash form of the SAME logical filename the live sync will
        // canonicalize to `memory/adopt-me.md` -- the exact F5-2 collision
        // class (a legacy path that folds to the same comparison-
        // normalized key via scripts/lib/source-file-normalize.js, e.g.
        // live CPF's real "memory.md" + "memory\MEMORY.md" pair) is what
        // makes the divergence-map LOOKUP find this candidate at all;
        // content_hash then decides adopt-vs-diverge.
        await c1.query(
          `INSERT INTO memory_entries (name, description, mem_type, body, source_file, project_id) VALUES ('legacy', 'd', 'project', $1, 'memory\\adopt-me.md', $2)`,
          [legacyBody, PROJECT_ID]
        );
        await c1.end();
        await migrate05.runStepA(tgt, dbTriage, false, () => {}, ABSORB_DBS);

        const adoptFile = path.join(memDir, 'adopt-me.md');
        fs.writeFileSync(adoptFile, `---\ntype: project\n---\n\n# Adopt Me\n\n${legacyBody}`);
        // The absorbed row's own body differs from the live file's body by
        // the frontmatter/heading wrapper -- adoption keys on the PARENT's
        // computed content_hash (sha256 of the FULL body, including the
        // heading), so this fixture writes the exact same raw body text as
        // the absorbed row for a true hash match.
        const legacyHash = sha256(legacyBody);
        const { rows: absorbedRows } = await tgt.query(`SELECT id, content_hash FROM memory_entries WHERE source_file='memory\\adopt-me.md'`);
        assert(absorbedRows.length === 1, `expected exactly one absorbed legacy row, got ${JSON.stringify(absorbedRows)}`);
        // Overwrite the fixture file so its FULL body byte-matches the
        // absorbed row's body exactly (adoption requires an EXACT hash match).
        const absorbedBodyRes = await tgt.query(`SELECT body FROM memory_entries WHERE id=$1`, [absorbedRows[0].id]);
        fs.writeFileSync(adoptFile, absorbedBodyRes.rows[0].body);

        const divMap = await migrate05.buildDivergenceMap(tgt);
        const r5 = await migrate05.processEnrolledDir(tgt, PROJECT_ID, dirName, memDir, divMap, false, () => {});
        const adoptedEvents = r5.events.filter((e) => e.kind === 'absorbed-row-adopted');
        assert(adoptedEvents.length === 1, `expected 1 absorbed-row-adopted event, got ${JSON.stringify(r5.events.filter((e) => e.kind.startsWith('absorb')))}`);
        const { rows: afterRows } = await tgt.query(`SELECT id, source_file FROM memory_entries WHERE id=$1`, [absorbedRows[0].id]);
        assert(afterRows[0].source_file === 'memory/adopt-me.md', `expected the absorbed row renamed to canonical form, got ${afterRows[0].source_file}`);
      });

      await run('DIVERGE-2', 'a live file with the SAME comparison-normalized source_file but DIFFERENT content is reported divergent, both rows kept', async () => {
        const c1 = await pgConnect(SRC_CPF);
        await c1.query(
          `INSERT INTO memory_entries (name, description, mem_type, body, source_file, project_id) VALUES ('diverge-legacy', 'd', 'project', 'ORIGINAL legacy body text', 'memory/diverge-case.md', $1)`,
          [PROJECT_ID]
        );
        await c1.end();
        await migrate05.runStepA(tgt, dbTriage, false, () => {}, ABSORB_DBS);

        fs.writeFileSync(path.join(memDir, 'diverge-case.md'), '---\ntype: project\n---\n\n# Diverge Case\n\nCOMPLETELY DIFFERENT live body text.\n');
        const divMap = await migrate05.buildDivergenceMap(tgt);
        const r6 = await migrate05.processEnrolledDir(tgt, PROJECT_ID, dirName, memDir, divMap, false, () => {});
        const divergeEvents = r6.events.filter((e) => e.kind === 'absorb-divergence');
        assert(divergeEvents.length === 1, `expected 1 absorb-divergence event, got ${JSON.stringify(r6.events.filter((e) => e.kind.startsWith('absorb')))}`);
        const { rows } = await tgt.query(`SELECT source_file, content_hash FROM memory_entries WHERE project_id=$1 AND name IN ('diverge-legacy','diverge-case') ORDER BY name`, [PROJECT_ID]);
        assert(rows.length === 2, `expected BOTH the absorbed row and the new live-sync row to coexist, got ${JSON.stringify(rows)}`);
      });

      // ── manifest slices reconcile against lineage (F5-7) ─────────────────
      await run('MANIFEST-1', 'per-dir file_memory_raw_entries/chunks manifest slices reconcile to live lineage-tracked row counts', async () => {
        const { filesystemSourceDb } = require(path.join(PROJECT_ROOT, 'scripts', 'lib', 'fs-path-normalize.js'));
        const fsDb = filesystemSourceDb(memDir);
        const { rows: manifestRows } = await tgt.query(
          `SELECT row_count FROM migration_manifest WHERE source_db=$1 AND source_table=$2`,
          [fsDb, migrate05.SOURCE_TABLE_RAW_ENTRIES]
        );
        const { rows: liveRows } = await tgt.query(
          `SELECT COUNT(*)::int AS n FROM pipeline_migration_row_ids WHERE source_db=$1 AND source_table=$2`,
          [fsDb, migrate05.SOURCE_TABLE_RAW_ENTRIES]
        );
        assert(manifestRows.length === 1, `expected exactly one manifest slice, got ${manifestRows.length}`);
        assert(Number(manifestRows[0].row_count) === liveRows[0].n, `expected manifest row_count to equal live lineage count, manifest=${manifestRows[0].row_count} live=${liveRows[0].n}`);
      });

      // ── ROLLBACK round-trip (target + manifest + lineage all purged) ────
      await run('ROLLBACK-1', 'Step C rollback purges target rows (cascading chunks), lineage, and manifest slices for one dir', async () => {
        const { filesystemSourceDb } = require(path.join(PROJECT_ROOT, 'scripts', 'lib', 'fs-path-normalize.js'));
        const fsDb = filesystemSourceDb(memDir);
        // NOTE: memDir accumulated fixtures from prior sub-tests, including
        // DIVERGE-2's deliberately-never-adopted Step-A-absorbed row
        // ('diverge-legacy', project_id=PROJECT_ID, tracked ONLY by Step
        // A's own lineage) -- that row is correctly OUT OF SCOPE for a
        // Step-C-only rollback (Step A/Step C rollback are independently
        // scoped by design, see migrate-05's header comment point 4/F5-8),
        // so this assertion checks a KNOWN Step-C-synced file specifically
        // rather than the whole project_id's row count.
        const knownFile = (await tgt.query(`SELECT id FROM memory_entries WHERE project_id=$1 AND source_file='memory/topic-one.md'`, [PROJECT_ID])).rows;
        assert(knownFile.length === 1, 'expected the known Step-C-synced row present before rollback');

        await migrate05.rollbackDir(tgt, fsDb, () => {});

        const afterKnown = (await tgt.query(`SELECT COUNT(*)::int AS n FROM memory_entries WHERE project_id=$1 AND source_file='memory/topic-one.md'`, [PROJECT_ID])).rows[0].n;
        assert(afterKnown === 0, `expected the known Step-C-synced row purged after rollback, got ${afterKnown}`);
        const afterLineage = (await tgt.query(`SELECT COUNT(*)::int AS n FROM pipeline_migration_row_ids WHERE source_db=$1`, [fsDb])).rows[0].n;
        assert(afterLineage === 0, `expected zero lineage rows after rollback, got ${afterLineage}`);
        const afterManifest = (await tgt.query(`SELECT COUNT(*)::int AS n FROM migration_manifest WHERE source_db=$1`, [fsDb])).rows[0].n;
        assert(afterManifest === 0, `expected zero manifest rows after rollback, got ${afterManifest}`);
      });

      await run('ROLLBACK-2', 'Step A rollback purges absorbed target rows, lineage, and _db_absorb manifest slices', async () => {
        const before = (await tgt.query(`SELECT COUNT(*)::int AS n FROM memory_entries WHERE project_id='proj-alpha'`)).rows[0].n;
        assert(before > 0, 'expected absorbed rows present before rollback');

        await migrate05.rollbackAbsorb(tgt, () => {}, ABSORB_DBS);

        const afterEntries = (await tgt.query(`SELECT COUNT(*)::int AS n FROM memory_entries WHERE project_id='proj-alpha'`)).rows[0].n;
        assert(afterEntries === 0, `expected zero absorbed rows after rollback, got ${afterEntries}`);
        const afterLineage = (await tgt.query(
          `SELECT COUNT(*)::int AS n FROM pipeline_migration_row_ids WHERE source_db = ANY($1::text[]) AND source_table='memory_entries'`,
          [ABSORB_DBS]
        )).rows[0].n;
        assert(afterLineage === 0, `expected zero Step A lineage rows after rollback, got ${afterLineage}`);
      });

      await run('ROLLBACK-3', 'Step B rollback clears exclusion manifest slices', async () => {
        await migrate05.rollbackExclusions(tgt, () => {}, EXCLUDED_DBS);
        const { rows } = await tgt.query(
          `SELECT COUNT(*)::int AS n FROM migration_manifest WHERE source_db=$1`,
          [SRC_EXCL]
        );
        assert(rows[0].n === 0, `expected zero exclusion manifest rows after rollback, got ${rows[0].n}`);
      });
    } finally {
      await tgt.end();
    }
  } finally {
    await dropDb(TARGET_DB);
    await dropDb(SRC_CPF);
    await dropDb(SRC_PP);
    await dropDb(SRC_EXCL);
    for (const d of scratchDirs) {
      try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) { /* best-effort cleanup */ }
    }
  }

  console.log(`\ntest-migrate-05-sync-file-memory: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
