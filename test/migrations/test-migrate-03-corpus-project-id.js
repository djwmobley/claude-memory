'use strict';

/**
 * test-migrate-03-corpus-project-id.js — Test harness for
 * scripts/migrations/migrate-03-corpus-project-id.js (CONSOLIDATION-
 * RUNBOOK.md §6.1(d) + D3-1..D3-11 amendment, memory-manager#11(d)).
 *
 * Mirrors test-migrate-02-decisions.js's conventions: self-contained
 * scratch databases (target "_staging"-suffixed to satisfy migrate-01's
 * own classifyTarget, reused by reference), scratch corpus databases
 * scoped via --db-prefix (this script's own explicit, printed test-
 * isolation boundary — see migrate-03's header comment on D3-4), scratch
 * fixture project directories under an isolated HANDOFF_BASE_DIR temp
 * root (never a real ~/.claude/projects tree), unconditional cleanup.
 *
 * Covers:
 *   - Pure unit tests (no DB): findCwdsFromTranscripts (zero-transcript /
 *     no-cwd-field / cwd(s)-found / trailing-slash dedup), resolveProjectIdForDir
 *     (real marker via project-marker.js, unmapped reasons, root-based
 *     divergence classification — see the two field-finding regressions
 *     below), buildProjectDirIndex (memory/-subdir-presence as the total
 *     classification, never a name-shape check), resolveDbMapping
 *     (winner-directory heuristic, deterministic tie-break, unique-fallback,
 *     ambiguous -> unmapped), classifyDatabase's unreachable branch.
 *   - FIELD-FINDING REGRESSIONS (second round): "worktree-cwd-resolves-
 *     same-project" — transcripts carrying a repo root cwd AND a
 *     `<repo>/.claude/worktrees/agent-x` cwd (the real-world norm for
 *     worktree agent sessions) resolve cleanly to the ONE project both
 *     paths' marker walk-up converges on, raw-cwd variety irrelevant; and
 *     "two-distinct-marker-roots-unmapped" — transcripts whose cwds
 *     resolve to two GENUINELY different marker roots are (correctly)
 *     unmapped with the divergence reason.
 *   - Discovery: holds-corpus / no-corpus classification against real
 *     scratch databases; --discover-only mutates nothing.
 *   - Happy path: a single corpus DB backfilled from a matching fixture
 *     project directory — real project id applied, NOT NULL applied,
 *     manifest slice written to the bookkeeping target, and a pre-mutation
 *     backup dump written for every corpus table before any ALTER/backfill.
 *   - Cross-DB same-filename disambiguation: two corpus DBs, two fixture
 *     project directories that BOTH contain a file with the identical
 *     basename — each DB's winner-directory heuristic resolves it to its
 *     OWN project id via the DB's full distinct-source_file overlap, not
 *     a name collision.
 *   - Orphan bucket: a source_file with no filesystem match anywhere ->
 *     'unmapped-orphan-memory-entry', migrates normally, never blocks the
 *     NOT NULL step for the rest of the table.
 *   - Orphan RE-ATTRIBUTION (field finding, second round): once the
 *     source project's directory later appears on disk, a re-run
 *     re-attributes a row this script itself previously orphaned (the
 *     placeholder is this script's own sentinel, safely distinguishable
 *     from a manual correction) and the manifest's orphan slice shrinks
 *     accordingly.
 *   - Idempotent re-run: second invocation touches zero additional rows,
 *     manifest slices stable (no duplication, no orphaned leftover slice).
 *   - Rollback: drops project_id from the corpus DB + clears this DB's
 *     manifest slices from the bookkeeping target.
 *
 * Usage: node test/migrations/test-migrate-03-corpus-project-id.js
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
const MIGRATE03_PATH = path.join(PROJECT_ROOT, 'scripts', 'migrations', 'migrate-03-corpus-project-id.js');

const migrate03 = require(MIGRATE03_PATH);
const projectMarker = require(path.join(PROJECT_ROOT, 'scripts', 'lib', 'project-marker.js'));

const scriptsRequire = createRequire(require.resolve('../../scripts/package.json'));
const { Client } = scriptsRequire('pg');

const TS = Date.now();
const DB_PREFIX = `verify03_${TS}_`;

let passed = 0;
let failed = 0;

function pass(id, label) { console.log(`[${id}] ${label} ... PASS`); passed++; }
function fail(id, label, reason) { console.log(`[${id}] ${label} ... FAIL: ${reason}`); failed++; }
async function run(id, label, fn) {
  try { await fn(); pass(id, label); } catch (err) { fail(id, label, err && err.stack ? err.stack : String(err)); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }

// ─── PG helpers ─────────────────────────────────────────────────────────

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

const MINIMAL_CORPUS_DDL = `
  CREATE TABLE memory_entries (
    id           SERIAL PRIMARY KEY,
    name         TEXT NOT NULL,
    description  TEXT,
    mem_type     TEXT,
    body         TEXT NOT NULL,
    source_file  TEXT UNIQUE,
    content_hash TEXT,
    created_at   TIMESTAMPTZ DEFAULT NOW(),
    updated_at   TIMESTAMPTZ DEFAULT NOW()
  );
  CREATE TABLE memory_entry_chunks (
    id           SERIAL PRIMARY KEY,
    entry_id     INTEGER NOT NULL REFERENCES memory_entries(id) ON DELETE CASCADE,
    chunk_idx    INTEGER NOT NULL,
    content      TEXT NOT NULL,
    content_hash TEXT,
    created_at   TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (entry_id, chunk_idx)
  );
`;

/** Creates a scratch corpus DB with the minimal memory_entries/memory_entry_chunks shape this script depends on (no pgvector/FTS — out of scope for this migration). */
async function setupCorpusDb(dbName, rows) {
  await createDb(dbName);
  const client = await pgConnect(dbName);
  try {
    await client.query(MINIMAL_CORPUS_DDL);
    for (const r of rows) {
      const { rows: ins } = await client.query(
        `INSERT INTO memory_entries (name, description, mem_type, body, source_file) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
        [r.name, r.description ?? null, r.mem_type ?? 'reference', r.body, r.source_file ?? null]
      );
      if (r.chunks) {
        const entryId = ins[0].id;
        let idx = 0;
        for (const c of r.chunks) {
          await client.query(
            `INSERT INTO memory_entry_chunks (entry_id, chunk_idx, content) VALUES ($1,$2,$3)`,
            [entryId, idx++, c]
          );
        }
      }
    }
  } finally {
    await client.end();
  }
}

function runMigrateOne(args, timeoutMs = 30000) {
  return spawnSync(process.execPath, [MIGRATE_ONE_PATH, ...args], { cwd: PROJECT_ROOT, env: process.env, encoding: 'utf8', timeout: timeoutMs });
}

async function setupTargetSchema(dbName) {
  const r1 = runMigrateOne(['--db', dbName]);
  if (r1.status !== 0) throw new Error(`migrate-01 fixture setup failed: status=${r1.status} stderr=${r1.stderr}`);
}

// Every invocation is pointed at a scratch --backup-dir (never the real,
// gitignored scripts/migrations/backups/ this repo's own runs write to) --
// a caller needing a DIFFERENT backup dir simply passes its own
// --backup-dir later in argv, which migrate-03's own parseArgs takes
// last-flag-wins on (mirrors test-migrate-02-decisions.js's
// EXAMPLE_ROUTING_MAP_PATH convention).
let BACKUP_DIR;
function runMigrate03(args, extraEnv = {}, timeoutMs = 30000) {
  return spawnSync(process.execPath, [MIGRATE03_PATH, '--db-prefix', DB_PREFIX, '--backup-dir', BACKUP_DIR, ...args], {
    cwd: PROJECT_ROOT,
    env: { ...process.env, ...extraEnv },
    encoding: 'utf8',
    timeout: timeoutMs,
  });
}

// ─── Fixture filesystem tree ────────────────────────────────────────────

/**
 * Builds a scratch HANDOFF_BASE_DIR tree:
 *   <base>/projects/<dirName>/*.jsonl   (transcripts, cwd field pointing
 *                                        at <base>/checkouts/<checkoutName>)
 *   <base>/projects/<dirName>/memory/*.md
 *   <base>/checkouts/<checkoutName>/.memory-engine  (real marker, minted
 *                                        via project-marker.js — never
 *                                        hand-rolled JSON)
 */
function makeFixtureBase() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'm03-fixture-'));
  fs.mkdirSync(path.join(base, 'projects'), { recursive: true });
  fs.mkdirSync(path.join(base, 'checkouts'), { recursive: true });
  return base;
}

function mintCheckout(base, checkoutName) {
  const root = path.join(base, 'checkouts', checkoutName);
  fs.mkdirSync(root, { recursive: true });
  const { uuid } = projectMarker.writeMarker(root);
  return { root, uuid };
}

function writeProjectDir(base, dirName, { checkoutRoot, memoryFiles, transcriptLines }) {
  const dirPath = path.join(base, 'projects', dirName);
  const memPath = path.join(dirPath, 'memory');
  fs.mkdirSync(memPath, { recursive: true });
  for (const [fname, body] of Object.entries(memoryFiles || {})) {
    fs.writeFileSync(path.join(memPath, fname), body, 'utf8');
  }
  if (transcriptLines !== null) {
    const lines = transcriptLines !== undefined
      ? transcriptLines
      : [JSON.stringify({ type: 'system', sessionId: 'x', cwd: checkoutRoot })];
    fs.writeFileSync(path.join(dirPath, `${crypto.randomUUID()}.jsonl`), lines.join('\n') + '\n', 'utf8');
  }
  return dirPath;
}

// ─── Manifest query helper ──────────────────────────────────────────────

async function getManifestSlices(tgtClient, sourceDb, sourceTable) {
  const { rows } = await tgtClient.query(
    `SELECT project_id_or_null, row_count FROM migration_manifest WHERE source_db=$1 AND source_table=$2 ORDER BY project_id_or_null`,
    [sourceDb, sourceTable]
  );
  return rows;
}

// ─── Main ────────────────────────────────────────────────────────────────

const DB_TARGET = `${DB_PREFIX}target_staging`;
const DB_CORPUS_HAPPY = `${DB_PREFIX}corpus_happy`;
const DB_CORPUS_ORPHAN = `${DB_PREFIX}corpus_orphan`;
const DB_CORPUS_A = `${DB_PREFIX}corpus_a`;
const DB_CORPUS_B = `${DB_PREFIX}corpus_b`;
const DB_NOCORPUS = `${DB_PREFIX}nocorpus`;
const DB_ROLLBACK = `${DB_PREFIX}corpus_rollback`;
const CREATED_DBS = [DB_TARGET, DB_CORPUS_HAPPY, DB_CORPUS_ORPHAN, DB_CORPUS_A, DB_CORPUS_B, DB_NOCORPUS, DB_ROLLBACK];

let fixtureBase;

async function main() {
  BACKUP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'm03-backups-'));

  // ── Group 1: pure unit tests (no DB) ────────────────────────────────

  await run('U1', 'findCwdsFromTranscripts: zero transcript files -> [] + reason', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'm03-u1-'));
    const r = migrate03.findCwdsFromTranscripts(dir);
    assert(Array.isArray(r.cwds) && r.cwds.length === 0, 'expected empty cwds array');
    assert(/zero transcript files/.test(r.reason), `expected zero-transcript reason, got: ${r.reason}`);
  });

  await run('U2', 'findCwdsFromTranscripts: transcripts present but none carry a cwd field -> [] + reason', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'm03-u2-'));
    fs.writeFileSync(path.join(dir, 'a.jsonl'), JSON.stringify({ type: 'mode', mode: 'normal' }) + '\n', 'utf8');
    const r = migrate03.findCwdsFromTranscripts(dir);
    assert(r.cwds.length === 0, 'expected empty cwds array');
    assert(/none carried a "cwd" field/.test(r.reason), `unexpected reason: ${r.reason}`);
  });

  await run('U3', 'findCwdsFromTranscripts: a line carrying a string cwd field is found', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'm03-u3-'));
    fs.writeFileSync(path.join(dir, 'a.jsonl'), [
      JSON.stringify({ type: 'mode' }),
      JSON.stringify({ type: 'system', cwd: '/some/real/path' }),
    ].join('\n') + '\n', 'utf8');
    const r = migrate03.findCwdsFromTranscripts(dir);
    assert(r.cwds.length === 1 && r.cwds[0] === '/some/real/path', `expected ["/some/real/path"], got ${JSON.stringify(r.cwds)}`);
    assert(r.reason === null, 'expected null reason on success');
  });

  await run('two-distinct-raw-cwds-collected', 'findCwdsFromTranscripts: two transcripts with different raw cwd values are BOTH collected -- multiple distinct raw cwds is the norm, never itself an unmapped verdict at this layer (post-review, second round)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'm03-two-raw-'));
    fs.writeFileSync(path.join(dir, 'a.jsonl'), JSON.stringify({ type: 'system', cwd: '/path/one' }) + '\n', 'utf8');
    fs.writeFileSync(path.join(dir, 'b.jsonl'), JSON.stringify({ type: 'system', cwd: '/path/two' }) + '\n', 'utf8');
    const r = migrate03.findCwdsFromTranscripts(dir);
    assert(r.reason === null, `expected no reason (collection never itself judges divergence), got: ${r.reason}`);
    assert(r.cwds.length === 2 && r.cwds.includes('/path/one') && r.cwds.includes('/path/two'), `expected both raw values collected, got ${JSON.stringify(r.cwds)}`);
  });

  await run('U3c', 'findCwdsFromTranscripts: a trailing-slash-only difference between two transcripts dedupes to ONE raw value (light canonicalization, cwdCompareKey)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'm03-trailing-slash-'));
    fs.writeFileSync(path.join(dir, 'a.jsonl'), JSON.stringify({ type: 'system', cwd: '/path/same' }) + '\n', 'utf8');
    fs.writeFileSync(path.join(dir, 'b.jsonl'), JSON.stringify({ type: 'system', cwd: '/path/same/' }) + '\n', 'utf8');
    const r = migrate03.findCwdsFromTranscripts(dir);
    assert(r.cwds.length === 1, `expected trailing-slash dedup to 1 distinct raw value, got ${JSON.stringify(r.cwds)}`);
  });

  await run('U3d', 'findCwdsFromTranscripts: three transcripts (two agreeing, one different) collects exactly two distinct raw values', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'm03-three-'));
    fs.writeFileSync(path.join(dir, 'a.jsonl'), JSON.stringify({ type: 'system', cwd: '/path/one' }) + '\n', 'utf8');
    fs.writeFileSync(path.join(dir, 'b.jsonl'), JSON.stringify({ type: 'system', cwd: '/path/one' }) + '\n', 'utf8');
    fs.writeFileSync(path.join(dir, 'c.jsonl'), JSON.stringify({ type: 'system', cwd: '/path/two' }) + '\n', 'utf8');
    const r = migrate03.findCwdsFromTranscripts(dir);
    assert(r.cwds.length === 2, `expected 2 distinct raw values (not 3), got ${JSON.stringify(r.cwds)}`);
  });

  await run('U3e', 'resolveProjectIdForDir: multiple distinct raw cwds, NONE of which resolve to any marker root -> unmapped ("no project marker found"), never a guess', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'm03-no-marker-multi-'));
    fs.writeFileSync(path.join(dir, 'a.jsonl'), JSON.stringify({ cwd: '/path/one/nowhere' }) + '\n', 'utf8');
    fs.writeFileSync(path.join(dir, 'b.jsonl'), JSON.stringify({ cwd: '/path/two/nowhere' }) + '\n', 'utf8');
    const r = migrate03.resolveProjectIdForDir(dir);
    assert(r.projectId === null, 'expected null project id when nothing resolves to a marker');
    assert(/no project marker found/.test(r.unmappedReason), `expected the no-marker reason, got: ${r.unmappedReason}`);
  });

  await run('worktree-cwd-resolves-same-project', 'resolveProjectIdForDir: transcripts carrying [repo-root, repo-root/.claude/worktrees/agent-x] resolve cleanly to the ONE project both converge on -- field finding, second round (previously over-orphaned nearly the entire real estate)', async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'm03-worktree-'));
    const repoRoot = path.join(base, 'repo');
    fs.mkdirSync(repoRoot, { recursive: true });
    const { uuid } = projectMarker.writeMarker(repoRoot);
    const worktreeCwd = path.join(repoRoot, '.claude', 'worktrees', 'agent-x');
    fs.mkdirSync(worktreeCwd, { recursive: true }); // no marker of its own -- walk-up finds repoRoot's
    const dirPath = path.join(base, 'encoded-cwd-dir');
    fs.mkdirSync(dirPath, { recursive: true });
    fs.writeFileSync(path.join(dirPath, 'a.jsonl'), JSON.stringify({ cwd: repoRoot }) + '\n', 'utf8');
    fs.writeFileSync(path.join(dirPath, 'b.jsonl'), JSON.stringify({ cwd: worktreeCwd }) + '\n', 'utf8');
    const r = migrate03.resolveProjectIdForDir(dirPath);
    assert(r.projectId === uuid, `expected ${uuid} (raw-cwd variety irrelevant once both converge on one root), got ${r.projectId} (reason: ${r.unmappedReason})`);
    assert(r.unmappedReason === null, `expected a clean resolve, got reason: ${r.unmappedReason}`);
  });

  await run('two-distinct-marker-roots-unmapped', 'resolveProjectIdForDir: transcripts resolving to TWO genuinely different marker roots are unmapped with the divergence reason', async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'm03-two-roots-'));
    const rootOne = path.join(base, 'project-one');
    const rootTwo = path.join(base, 'project-two');
    fs.mkdirSync(rootOne, { recursive: true });
    fs.mkdirSync(rootTwo, { recursive: true });
    projectMarker.writeMarker(rootOne);
    projectMarker.writeMarker(rootTwo);
    const dirPath = path.join(base, 'encoded-cwd-dir');
    fs.mkdirSync(dirPath, { recursive: true });
    fs.writeFileSync(path.join(dirPath, 'a.jsonl'), JSON.stringify({ cwd: rootOne }) + '\n', 'utf8');
    fs.writeFileSync(path.join(dirPath, 'b.jsonl'), JSON.stringify({ cwd: rootTwo }) + '\n', 'utf8');
    const r = migrate03.resolveProjectIdForDir(dirPath);
    assert(r.projectId === null, 'expected null project id on genuine root divergence');
    assert(/divergent-transcript-cwds: 2 distinct resolved project root/.test(r.unmappedReason), `expected the resolved-root divergence reason, got: ${r.unmappedReason}`);
  });

  await run('U4', 'resolveProjectIdForDir: real marker resolved via cwd walk-up (project-marker.js, never decoded)', async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'm03-u4-'));
    const checkoutRoot = path.join(base, 'checkout');
    fs.mkdirSync(checkoutRoot, { recursive: true });
    const { uuid } = projectMarker.writeMarker(checkoutRoot);
    const subDir = path.join(checkoutRoot, 'nested', 'deep');
    fs.mkdirSync(subDir, { recursive: true });
    const dirPath = path.join(base, 'encoded-cwd-dir');
    fs.mkdirSync(dirPath, { recursive: true });
    fs.writeFileSync(path.join(dirPath, 'a.jsonl'), JSON.stringify({ cwd: subDir }) + '\n', 'utf8');
    const r = migrate03.resolveProjectIdForDir(dirPath);
    assert(r.projectId === uuid, `expected ${uuid}, got ${r.projectId}`);
    assert(r.unmappedReason === null, 'expected no unmapped reason on success');
  });

  await run('U5', 'resolveProjectIdForDir: zero transcripts -> unmapped with reason, never guessed', async () => {
    const dirPath = fs.mkdtempSync(path.join(os.tmpdir(), 'm03-u5-'));
    const r = migrate03.resolveProjectIdForDir(dirPath);
    assert(r.projectId === null, 'expected null project id');
    assert(/zero transcript files/.test(r.unmappedReason), `unexpected reason: ${r.unmappedReason}`);
  });

  await run('U6', 'resolveProjectIdForDir: cwd found but no marker anywhere up the tree -> unmapped', async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'm03-u6-'));
    const noMarkerDir = path.join(base, 'no-marker-here');
    fs.mkdirSync(noMarkerDir, { recursive: true });
    const dirPath = path.join(base, 'encoded-cwd-dir');
    fs.mkdirSync(dirPath, { recursive: true });
    fs.writeFileSync(path.join(dirPath, 'a.jsonl'), JSON.stringify({ cwd: noMarkerDir }) + '\n', 'utf8');
    const r = migrate03.resolveProjectIdForDir(dirPath);
    assert(r.projectId === null, 'expected null project id');
    assert(/no project marker found/.test(r.unmappedReason), `unexpected reason: ${r.unmappedReason}`);
  });

  await run('U7', 'buildProjectDirIndex: total classification is "has a memory/ subdir", never a name-shape check', async () => {
    const base = makeFixtureBase();
    const { root } = mintCheckout(base, 'ck1');
    writeProjectDir(base, 'ARBITRARY-NAME-not-encoded-cwd-shaped', { checkoutRoot: root, memoryFiles: { 'foo.md': 'x' } });
    // A directory with NO memory/ subdir must be skipped entirely, even though it has transcripts.
    const noMemDir = path.join(base, 'projects', 'no-memory-subdir');
    fs.mkdirSync(noMemDir, { recursive: true });
    fs.writeFileSync(path.join(noMemDir, 'a.jsonl'), JSON.stringify({ cwd: root }) + '\n', 'utf8');
    const idx = migrate03.buildProjectDirIndex(base);
    assert(idx.dirs.length === 1, `expected exactly 1 candidate dir, got ${idx.dirs.length}`);
    assert(idx.dirs[0].dirName === 'ARBITRARY-NAME-not-encoded-cwd-shaped', 'expected the memory/-bearing dir to be indexed regardless of its name shape');
  });

  await run('U8', 'resolveDbMapping: winner-directory heuristic picks the directory with maximal overlap', async () => {
    const dirs = [
      { dirName: 'dirA', projectId: 'proj-A', files: new Set(['x.md', 'y.md', 'z.md']) },
      { dirName: 'dirB', projectId: 'proj-B', files: new Set(['x.md']) },
    ];
    const { mapping, winner } = migrate03.resolveDbMapping(['memory/x.md', 'memory/y.md', 'memory/z.md'], dirs);
    assert(winner.projectId === 'proj-A', `expected proj-A to win, got ${winner.projectId}`);
    assert(mapping.get('memory/x.md').projectId === 'proj-A', 'x.md should resolve via the winner');
    assert(mapping.get('memory/y.md').projectId === 'proj-A', 'y.md should resolve via the winner');
  });

  await run('U9', 'resolveDbMapping: a distinct source_file outside the winner falls back to a strict unique match', async () => {
    const dirs = [
      { dirName: 'dirA', projectId: 'proj-A', files: new Set(['x.md', 'y.md']) },
      { dirName: 'dirC', projectId: 'proj-C', files: new Set(['only-in-c.md']) },
    ];
    const { mapping } = migrate03.resolveDbMapping(['memory/x.md', 'memory/y.md', 'memory/only-in-c.md'], dirs);
    assert(mapping.get('memory/only-in-c.md').projectId === 'proj-C', 'expected unique-fallback to proj-C');
    assert(mapping.get('memory/only-in-c.md').method === 'unique-fallback', 'expected method=unique-fallback');
  });

  await run('U10', 'resolveDbMapping: a source_file present in 2+ non-winner directories is unmapped (never guessed)', async () => {
    const dirs = [
      { dirName: 'dirA', projectId: 'proj-A', files: new Set(['x.md', 'y.md']) },
      { dirName: 'dirB', projectId: 'proj-B', files: new Set(['ambiguous.md']) },
      { dirName: 'dirC', projectId: 'proj-C', files: new Set(['ambiguous.md']) },
    ];
    // dirA wins overall (2/3 overlap on x.md/y.md), but "ambiguous.md" is
    // NOT in dirA's file set, and is present in BOTH dirB and dirC -- must
    // be unmapped, never guessed toward either.
    const { mapping, winner } = migrate03.resolveDbMapping(['memory/x.md', 'memory/y.md', 'memory/ambiguous.md'], dirs);
    assert(winner.projectId === 'proj-A', `expected dirA to win on x/y overlap, got ${winner.projectId}`);
    const m = mapping.get('memory/ambiguous.md');
    assert(m.projectId === null, `expected null (unmapped), got ${m.projectId}`);
    assert(/ambiguous/.test(m.reason), `expected ambiguous reason, got ${m.reason}`);
  });

  await run('U11', 'resolveDbMapping: a source_file matching zero directories is unmapped', async () => {
    const dirs = [{ dirName: 'dirA', projectId: 'proj-A', files: new Set(['x.md']) }];
    const { mapping } = migrate03.resolveDbMapping(['memory/x.md', 'memory/nowhere.md'], dirs);
    assert(mapping.get('memory/nowhere.md').projectId === null, 'expected unmapped for a file present nowhere');
  });

  await run('U12', 'resolveDbMapping: NULL source_file is unmapped without throwing', async () => {
    const dirs = [{ dirName: 'dirA', projectId: 'proj-A', files: new Set(['x.md']) }];
    const { mapping } = migrate03.resolveDbMapping([null], dirs);
    assert(mapping.get(null).projectId === null, 'expected NULL source_file to be unmapped');
  });

  await run('U13', 'classifyDatabase: a nonexistent database name classifies as unreachable', async () => {
    const c = await migrate03.classifyDatabase(`${DB_PREFIX}definitely_does_not_exist`);
    assert(c.status === 'unreachable', `expected unreachable, got ${c.status}`);
  });

  // ── Group 2: full-stack DB integration tests ────────────────────────

  fixtureBase = makeFixtureBase();
  const ckHappy = mintCheckout(fixtureBase, 'ck-happy');
  writeProjectDir(fixtureBase, 'dir-happy', {
    checkoutRoot: ckHappy.root,
    memoryFiles: {
      'feedback_example.md': 'happy path feedback',
      'MEMORY.md': 'happy path memory index',
    },
  });
  // A directory with zero transcripts — its file(s) must never be offered
  // as a candidate to any DB (D3-1).
  writeProjectDir(fixtureBase, 'dir-zero-transcript', { transcriptLines: null, memoryFiles: { 'never-a-candidate.md': 'x' } });

  await run('I1', 'setup: create bookkeeping target + corpus DBs', async () => {
    await setupTargetSchema(DB_TARGET);
    await setupCorpusDb(DB_CORPUS_HAPPY, [
      { name: 'feedback_example', body: 'happy path feedback', source_file: 'memory\\feedback_example.md' }, // backslash regression (D3-2)
      { name: 'MEMORY', body: 'happy path memory index', source_file: 'memory/MEMORY.md', chunks: ['chunk one', 'chunk two'] },
    ]);
    await setupCorpusDb(DB_CORPUS_ORPHAN, [
      { name: 'deleted', body: 'this file no longer exists on disk', source_file: 'memory/long-deleted-file.md' },
    ]);
    await setupCorpusDb(DB_NOCORPUS, []); // has memory_entries but we'll drop it to prove no-corpus classification
    const client = await pgConnect(DB_NOCORPUS);
    try { await client.query('DROP TABLE memory_entry_chunks; DROP TABLE memory_entries;'); } finally { await client.end(); }
  });

  await run('I2', 'discovery classification: holds-corpus vs no-corpus, scoped by --db-prefix', async () => {
    const classifications = await migrate03.discoverAndClassify(DB_PREFIX);
    const byName = Object.fromEntries(classifications.map((c) => [c.dbName, c]));
    assert(byName[DB_CORPUS_HAPPY].status === 'holds-corpus', 'expected DB_CORPUS_HAPPY holds-corpus');
    assert(byName[DB_CORPUS_HAPPY].hasChunks === true, 'expected hasChunks=true');
    assert(byName[DB_NOCORPUS].status === 'no-corpus', 'expected DB_NOCORPUS no-corpus');
    // DB_TARGET is provisioned via migrate-01-canonical-db.js, which applies
    // the FULL canonical schema (setup.sql included) -- it genuinely DOES
    // carry (empty) memory_entries/memory_entry_chunks tables, same as any
    // other corpus DB. This is correct, not a classification bug: the
    // consolidation target is itself a legitimate corpus-holding database.
    assert(byName[DB_TARGET].status === 'holds-corpus', `expected the bookkeeping target to genuinely hold (empty) corpus tables via migrate-01's setup.sql, got ${byName[DB_TARGET].status}`);
  });

  await run('I3', '--discover-only mutates nothing (no project_id column added anywhere)', async () => {
    const r = runMigrate03(['--discover-only'], { HANDOFF_BASE_DIR: fixtureBase });
    assert(r.status === 0, `expected exit 0, got ${r.status}: ${r.stderr}`);
    const client = await pgConnect(DB_CORPUS_HAPPY);
    try {
      const has = await migrate03.columnExists(client, 'memory_entries', 'project_id');
      assert(has === false, 'discover-only must not add project_id');
    } finally { await client.end(); }
  });

  await run('I4', 'happy path: backfill resolves the real project id, applies NOT NULL, writes manifest', async () => {
    const r = runMigrate03(['--db', DB_TARGET], { HANDOFF_BASE_DIR: fixtureBase });
    assert(r.status === 0, `expected exit 0, got ${r.status}\nstdout:${r.stdout}\nstderr:${r.stderr}`);
    const client = await pgConnect(DB_CORPUS_HAPPY);
    try {
      const { rows } = await client.query(`SELECT source_file, project_id FROM memory_entries ORDER BY source_file`);
      for (const row of rows) {
        assert(row.project_id === ckHappy.uuid, `expected ${ckHappy.uuid} for ${row.source_file}, got ${row.project_id}`);
      }
      const { rows: chunkRows } = await client.query(`SELECT project_id FROM memory_entry_chunks`);
      for (const row of chunkRows) {
        assert(row.project_id === ckHappy.uuid, `expected chunk project_id ${ckHappy.uuid}, got ${row.project_id}`);
      }
      const { rows: notNullCheck } = await client.query(
        `SELECT is_nullable FROM information_schema.columns WHERE table_name='memory_entries' AND column_name='project_id'`
      );
      assert(notNullCheck[0].is_nullable === 'NO', 'expected project_id SET NOT NULL after a clean gate');
    } finally { await client.end(); }

    const tgtClient = await pgConnect(DB_TARGET);
    try {
      const slices = await getManifestSlices(tgtClient, DB_CORPUS_HAPPY, 'memory_entries');
      assert(slices.length === 1, `expected exactly 1 manifest slice, got ${slices.length}`);
      assert(slices[0].project_id_or_null === ckHappy.uuid, 'expected the manifest slice keyed by the real project id');
      assert(Number(slices[0].row_count) === 2, `expected row_count=2, got ${slices[0].row_count}`);
    } finally { await tgtClient.end(); }
  });

  await run('I5', 'backslash source_file value (D3-2 regression) is matched despite the fixture memory/ dir using forward slashes on disk', async () => {
    const client = await pgConnect(DB_CORPUS_HAPPY);
    try {
      const { rows } = await client.query(`SELECT project_id FROM memory_entries WHERE source_file = 'memory\\feedback_example.md'`);
      assert(rows.length === 1 && rows[0].project_id === ckHappy.uuid, 'backslash-separated source_file must resolve to the real project id, not orphan');
    } finally { await client.end(); }
  });

  await run('I5b', 'backup: a timestamped pre-mutation JSON dump was written for every corpus table before any ALTER/backfill (§6.1(d) step 1, field finding, second round)', async () => {
    const files = fs.readdirSync(BACKUP_DIR);
    const entriesBackup = files.find((f) => f.startsWith(`${DB_CORPUS_HAPPY}-memory_entries-backup-`) && f.endsWith('.json'));
    const chunksBackup = files.find((f) => f.startsWith(`${DB_CORPUS_HAPPY}-memory_entry_chunks-backup-`) && f.endsWith('.json'));
    assert(entriesBackup, `expected a memory_entries backup file for ${DB_CORPUS_HAPPY}, found: ${JSON.stringify(files)}`);
    assert(chunksBackup, `expected a memory_entry_chunks backup file for ${DB_CORPUS_HAPPY} (hasChunks=true), found: ${JSON.stringify(files)}`);
    const payload = JSON.parse(fs.readFileSync(path.join(BACKUP_DIR, entriesBackup), 'utf8'));
    assert(payload.source_db === DB_CORPUS_HAPPY, `expected source_db=${DB_CORPUS_HAPPY}, got ${payload.source_db}`);
    assert(payload.source_table === 'memory_entries', `expected source_table=memory_entries, got ${payload.source_table}`);
    assert(Array.isArray(payload.rows) && payload.rows.length === payload.row_count, 'expected row_count to match the dumped rows array length');
  });

  await run('I6', 'orphan bucket: a source_file absent from every candidate directory migrates as unmapped-orphan-memory-entry, never blocks NOT NULL', async () => {
    const r = runMigrate03(['--db', DB_TARGET], { HANDOFF_BASE_DIR: fixtureBase });
    assert(r.status === 0, `expected exit 0, got ${r.status}: ${r.stderr}`);
    const client = await pgConnect(DB_CORPUS_ORPHAN);
    try {
      const { rows } = await client.query(`SELECT project_id FROM memory_entries`);
      assert(rows.length === 1 && rows[0].project_id === migrate03.ORPHAN_PROJECT_ID, `expected orphan placeholder, got ${JSON.stringify(rows)}`);
      const { rows: notNullCheck } = await client.query(
        `SELECT is_nullable FROM information_schema.columns WHERE table_name='memory_entries' AND column_name='project_id'`
      );
      assert(notNullCheck[0].is_nullable === 'NO', 'an all-orphan table must still reach SET NOT NULL — the orphan placeholder is a real value, not a NULL');
    } finally { await client.end(); }
  });

  await run('I6b', 'orphan RE-ATTRIBUTION: once the source project directory appears on disk, a re-run reclassifies the row this script itself orphaned, and the manifest orphan slice shrinks to zero (field finding, second round)', async () => {
    // The source project for DB_CORPUS_ORPHAN's row ("memory/long-deleted-file.md")
    // did not exist anywhere in the fixture tree during I6 -- it "recovers"
    // here, simulating either the directory reappearing or a resolver fix.
    const ckRecovered = mintCheckout(fixtureBase, 'ck-recovered');
    writeProjectDir(fixtureBase, 'dir-recovered', {
      checkoutRoot: ckRecovered.root,
      memoryFiles: { 'long-deleted-file.md': 'recovered content' },
    });

    const r = runMigrate03(['--db', DB_TARGET], { HANDOFF_BASE_DIR: fixtureBase });
    assert(r.status === 0, `expected exit 0, got ${r.status}\nstdout:${r.stdout}\nstderr:${r.stderr}`);

    const client = await pgConnect(DB_CORPUS_ORPHAN);
    try {
      const { rows } = await client.query(`SELECT project_id FROM memory_entries WHERE source_file='memory/long-deleted-file.md'`);
      assert(rows.length === 1 && rows[0].project_id === ckRecovered.uuid, `expected re-attribution to ${ckRecovered.uuid}, got ${JSON.stringify(rows)}`);
    } finally { await client.end(); }

    const tgtClient = await pgConnect(DB_TARGET);
    try {
      const slices = await getManifestSlices(tgtClient, DB_CORPUS_ORPHAN, 'memory_entries');
      const orphanSlice = slices.find((s) => s.project_id_or_null === migrate03.ORPHAN_PROJECT_ID);
      assert(!orphanSlice, `expected the orphan slice to have shrunk away entirely (0 rows -> deleted by orphan reconciliation), still present: ${JSON.stringify(orphanSlice)}`);
      const recoveredSlice = slices.find((s) => s.project_id_or_null === ckRecovered.uuid);
      assert(recoveredSlice && Number(recoveredSlice.row_count) === 1, `expected a new slice for ${ckRecovered.uuid} with row_count=1, got ${JSON.stringify(slices)}`);
    } finally { await tgtClient.end(); }
  });

  await run('I7', 'idempotent re-run: zero additional rows touched, manifest slice unchanged, no orphaned leftover slice', async () => {
    const before = await (async () => {
      const c = await pgConnect(DB_TARGET);
      try { return await getManifestSlices(c, DB_CORPUS_HAPPY, 'memory_entries'); } finally { await c.end(); }
    })();
    const r = runMigrate03(['--db', DB_TARGET], { HANDOFF_BASE_DIR: fixtureBase });
    assert(r.status === 0, `expected exit 0 on re-run, got ${r.status}: ${r.stderr}`);
    const after = await (async () => {
      const c = await pgConnect(DB_TARGET);
      try { return await getManifestSlices(c, DB_CORPUS_HAPPY, 'memory_entries'); } finally { await c.end(); }
    })();
    assert(JSON.stringify(before) === JSON.stringify(after), `expected identical manifest slices across re-run, before=${JSON.stringify(before)} after=${JSON.stringify(after)}`);
  });

  // ── Cross-DB same-filename disambiguation ────────────────────────────

  const ckA = mintCheckout(fixtureBase, 'ck-a');
  const ckB = mintCheckout(fixtureBase, 'ck-b');
  writeProjectDir(fixtureBase, 'dir-a', {
    checkoutRoot: ckA.root,
    memoryFiles: { 'MEMORY.md': 'project A index', 'feedback_a1.md': 'a1', 'feedback_a2.md': 'a2' },
  });
  writeProjectDir(fixtureBase, 'dir-b', {
    checkoutRoot: ckB.root,
    memoryFiles: { 'MEMORY.md': 'project B index', 'feedback_b1.md': 'b1' },
  });

  await run('I8', 'setup: two corpus DBs, each overlapping strongly with a DIFFERENT project directory, both containing an identically-named MEMORY.md', async () => {
    await setupCorpusDb(DB_CORPUS_A, [
      { name: 'MEMORY', body: 'A', source_file: 'memory/MEMORY.md' },
      { name: 'feedback_a1', body: 'a1', source_file: 'memory/feedback_a1.md' },
      { name: 'feedback_a2', body: 'a2', source_file: 'memory/feedback_a2.md' },
    ]);
    await setupCorpusDb(DB_CORPUS_B, [
      { name: 'MEMORY', body: 'B', source_file: 'memory/MEMORY.md' },
      { name: 'feedback_b1', body: 'b1', source_file: 'memory/feedback_b1.md' },
    ]);
  });

  await run('I9', 'cross-DB disambiguation: each DB resolves its identically-named MEMORY.md row to its OWN project via full-set overlap, not a name collision', async () => {
    const r = runMigrate03(['--db', DB_TARGET], { HANDOFF_BASE_DIR: fixtureBase });
    assert(r.status === 0, `expected exit 0, got ${r.status}\nstdout:${r.stdout}\nstderr:${r.stderr}`);
    const clientA = await pgConnect(DB_CORPUS_A);
    const clientB = await pgConnect(DB_CORPUS_B);
    try {
      const { rows: rowsA } = await clientA.query(`SELECT project_id FROM memory_entries WHERE source_file='memory/MEMORY.md'`);
      const { rows: rowsB } = await clientB.query(`SELECT project_id FROM memory_entries WHERE source_file='memory/MEMORY.md'`);
      assert(rowsA[0].project_id === ckA.uuid, `expected DB_CORPUS_A's MEMORY.md -> ${ckA.uuid}, got ${rowsA[0].project_id}`);
      assert(rowsB[0].project_id === ckB.uuid, `expected DB_CORPUS_B's MEMORY.md -> ${ckB.uuid}, got ${rowsB[0].project_id}`);
      assert(rowsA[0].project_id !== rowsB[0].project_id, 'the two DBs must resolve the identical filename to DIFFERENT project ids');
    } finally { await clientA.end(); await clientB.end(); }
  });

  // ── Rollback ─────────────────────────────────────────────────────────

  await run('I10', 'rollback: drops project_id from a corpus DB + clears its manifest slices', async () => {
    await setupCorpusDb(DB_ROLLBACK, [{ name: 'x', body: 'x', source_file: 'memory/nowhere.md' }]);
    const first = runMigrate03(['--db', DB_TARGET], { HANDOFF_BASE_DIR: fixtureBase });
    assert(first.status === 0, `expected exit 0 on forward run, got ${first.status}: ${first.stderr}`);

    const clientBefore = await pgConnect(DB_ROLLBACK);
    try {
      assert(await migrate03.columnExists(clientBefore, 'memory_entries', 'project_id'), 'expected project_id present before rollback');
    } finally { await clientBefore.end(); }

    const rb = runMigrate03(['--db', DB_TARGET, '--rollback'], { HANDOFF_BASE_DIR: fixtureBase });
    assert(rb.status === 0, `expected exit 0 on rollback, got ${rb.status}: ${rb.stderr}`);

    const clientAfter = await pgConnect(DB_ROLLBACK);
    try {
      assert(!(await migrate03.columnExists(clientAfter, 'memory_entries', 'project_id')), 'expected project_id dropped after rollback');
    } finally { await clientAfter.end(); }

    const tgtClient = await pgConnect(DB_TARGET);
    try {
      const slices = await getManifestSlices(tgtClient, DB_ROLLBACK, 'memory_entries');
      assert(slices.length === 0, `expected zero manifest slices after rollback, got ${slices.length}`);
    } finally { await tgtClient.end(); }
  });

  console.log(`\n${passed} passed, ${failed} failed`);
}

async function cleanup() {
  for (const db of CREATED_DBS) await dropDb(db);
  if (fixtureBase) { try { fs.rmSync(fixtureBase, { recursive: true, force: true }); } catch (_) {} }
  if (BACKUP_DIR) { try { fs.rmSync(BACKUP_DIR, { recursive: true, force: true }); } catch (_) {} }
}

main()
  .catch((err) => { console.error(err && err.stack ? err.stack : err); failed++; })
  .finally(async () => {
    await cleanup();
    process.exitCode = failed > 0 ? 1 : 0;
  });
