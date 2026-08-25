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
 *   - FIELD-FINDING REGRESSIONS: "worktree-cwd-resolves-same-project"
 *     (second round) — transcripts carrying a repo root cwd AND a
 *     `<repo>/.claude/worktrees/agent-x` cwd (the real-world norm for
 *     worktree agent sessions) resolve cleanly to the ONE project both
 *     paths' marker walk-up converges on, raw-cwd variety irrelevant;
 *     "two-distinct-marker-roots-unmapped" (second round) — transcripts
 *     whose cwds resolve to two GENUINELY different marker roots are
 *     (correctly) unmapped with the divergence reason; and
 *     "mixed-resolvable-cwds-unmapped" (third round, the reviewer's exact
 *     repro) — [rootX-no-marker, rootY-with-marker] is unmapped, NEVER
 *     silently attributed to Y alone, because findProjectRootByMarker
 *     never checks the start path for existence (only each candidate
 *     ancestor's marker file), so an unresolvable cwd can never be a
 *     benign deleted-worktree artifact — it always means no marker exists
 *     anywhere in that ancestry.
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
 *   - DIR OVERRIDES (D3-1, fourth round — the transcript-cwd mechanism
 *     structurally cannot cover most of a real estate): loadDirOverrides
 *     (missing file is fine, present-but-malformed is a loud FATAL);
 *     buildProjectDirIndex consulting an override FIRST, before transcript
 *     resolution, on an exact dirName match; named regressions
 *     "override-resolves-zero-transcript-dir" (an override resolves a
 *     directory the transcript mechanism has literally nothing to scan),
 *     "stale-override-marker-missing-fails-loud" (unit AND full-CLI: a
 *     declared projectRoot with no live marker refuses the ENTIRE run,
 *     never a fallthrough to transcript resolution, nothing applied to
 *     any database), "dangling-override-reported" (unit AND CLI: an
 *     override matching no directory is a loud report line, never a
 *     failure), and "no-override-unchanged-behavior" (a directory with no
 *     matching override — including the worktree-cwd case — resolves
 *     exactly as before, even with unrelated overrides loaded).
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
const MIGRATE04_PATH = path.join(PROJECT_ROOT, 'scripts', 'migrations', 'migrate-04-absorb-pipeline-tables.js');

const migrate03 = require(MIGRATE03_PATH);
const migrate04 = require(MIGRATE04_PATH); // db-triage: loadDbTriageFull/classifyDbProvenance (cm#189)
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
// EXAMPLE_ROUTING_MAP_PATH convention). --db-triage is injected the SAME
// way (cm#189): a scratch fixture file, last-flag-wins, so P5a/P5b below
// can override it with their own missing/malformed path.
let BACKUP_DIR;
let TRIAGE_PATH;
function runMigrate03(args, extraEnv = {}, timeoutMs = 30000) {
  return spawnSync(process.execPath, [MIGRATE03_PATH, '--db-prefix', DB_PREFIX, '--backup-dir', BACKUP_DIR, '--db-triage', TRIAGE_PATH, ...args], {
    cwd: PROJECT_ROOT,
    env: { ...process.env, ...extraEnv },
    encoding: 'utf8',
    timeout: timeoutMs,
  });
}

// ─── db-triage.json fixture (cm#189) ────────────────────────────────────
//
// migrate-03 now REQUIRES --db-triage (A-6: write-side FATAL on a missing
// file) and runs its total provenance classification BEFORE any
// connection (A-4). TRIAGE_DATABASES/TRIAGE_PATTERNS are mutated in place
// as each test mints a new fixture DB, and writeTriageFixture() re-
// serializes the CURRENT state to TRIAGE_PATH -- every test that adds an
// entry calls it before the next runMigrate03 invocation that needs to see
// it. The bookkeeping target (DB_TARGET) deliberately gets NO entry here:
// classifyDbProvenance's bookkeeping-target branch resolves it via a
// byte-exact match against the CLI's own --db value, ahead of the triage
// branch (spec §2.1 precedence order) -- see test P8 for the regression
// proving this precedence explicitly.
let TRIAGE_DATABASES = {};
let TRIAGE_PATTERNS = [];
function writeTriageFixture() {
  fs.writeFileSync(TRIAGE_PATH, JSON.stringify({ databases: TRIAGE_DATABASES, test_artifact_db_patterns: TRIAGE_PATTERNS }, null, 2), 'utf8');
}

// Fixture DBs minted by the cm#189 classification tests (Group 3, below)
// beyond the fixed CREATED_DBS roster -- tracked here so cleanup()'s
// best-effort finally-drop covers them too (issue item 3: teardown
// hardening is a secondary, non-load-bearing defense; the classifier
// branch itself is the load-bearing fix, per A-1/A-4).
let EXTRA_DBS = [];
async function createExtraCorpusDb(dbName, rows) {
  await setupCorpusDb(dbName, rows);
  EXTRA_DBS.push(dbName);
  return dbName;
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
  TRIAGE_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'm03-triage-')), 'db-triage.json');
  writeTriageFixture(); // starts empty -- populated as each fixture DB is minted, below

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

  await run('mixed-resolvable-cwds-unmapped', 'resolveProjectIdForDir: [rootX-no-marker, rootY-with-marker] -> unmapped with mixed-resolvable-cwds (reviewer\'s exact repro, third round): an unresolvable cwd is NEVER a benign deleted-worktree artifact (findProjectRootByMarker never checks the start path for existence), so it must never be silently absorbed into whichever side happened to resolve', async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'm03-mixed-'));
    // Project Y: real, has a live marker.
    const rootY = path.join(base, 'project-y');
    fs.mkdirSync(rootY, { recursive: true });
    const { uuid: uuidY } = projectMarker.writeMarker(rootY);
    // Project X: simulates a checkout whose marker was deleted/never
    // restored, or an alien path -- deliberately NO marker written here.
    const rootX = path.join(base, 'project-x-no-marker');
    fs.mkdirSync(rootX, { recursive: true });

    const dirPath = path.join(base, 'encoded-cwd-dir');
    fs.mkdirSync(dirPath, { recursive: true });
    fs.writeFileSync(path.join(dirPath, 'a.jsonl'), JSON.stringify({ cwd: rootX }) + '\n', 'utf8');
    fs.writeFileSync(path.join(dirPath, 'b.jsonl'), JSON.stringify({ cwd: rootY }) + '\n', 'utf8');

    const r = migrate03.resolveProjectIdForDir(dirPath);
    assert(r.projectId === null, `expected null project id (NEVER silently attributed to Y=${uuidY}), got ${r.projectId}`);
    assert(/mixed-resolvable-cwds: 1 resolved to 1 root\(s\), 1 unresolvable/.test(r.unmappedReason), `expected the mixed-resolvable-cwds reason, got: ${r.unmappedReason}`);
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

  await run('U14', 'loadDirOverrides: a missing file is NOT an error -- overrides are optional (unlike topic-prefix-to-project.json)', async () => {
    const r = migrate03.loadDirOverrides(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'm03-nofile-')), 'does-not-exist.json'));
    assert(Array.isArray(r.overrides) && r.overrides.length === 0, 'expected an empty overrides array');
    assert(r.source === null, 'expected null source for a missing file');
  });

  // ── Group 1b: dir-overrides pure unit tests (D3-1, fourth round) ────

  await run('override-resolves-zero-transcript-dir', 'buildProjectDirIndex: an override resolves a directory that has ZERO transcripts -- the exact case the transcript mechanism structurally cannot cover (named regression, reviewer-requested)', async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'm03-ov-zero-'));
    const checkoutRoot = path.join(base, 'checkout');
    fs.mkdirSync(checkoutRoot, { recursive: true });
    const { uuid } = projectMarker.writeMarker(checkoutRoot);
    fs.mkdirSync(path.join(base, 'projects'), { recursive: true });
    const dirName = 'zero-transcript-dir';
    const memPath = path.join(base, 'projects', dirName, 'memory');
    fs.mkdirSync(memPath, { recursive: true });
    fs.writeFileSync(path.join(memPath, 'orphaned-forever-without-override.md'), 'x', 'utf8');
    // deliberately NO *.jsonl written -- this directory has zero transcripts

    const dirOverrides = { overrides: [{ dirName, projectRoot: checkoutRoot }], source: 'test' };
    const idx = migrate03.buildProjectDirIndex(base, dirOverrides);
    assert(idx.staleOverrideFailures.length === 0, `expected no stale failures, got ${JSON.stringify(idx.staleOverrideFailures)}`);
    assert(idx.appliedOverrides.length === 1 && idx.appliedOverrides[0].projectId === uuid, `expected 1 applied override resolving to ${uuid}, got ${JSON.stringify(idx.appliedOverrides)}`);
    const dir = idx.dirs.find((d) => d.dirName === dirName);
    assert(dir && dir.projectId === uuid, `expected the zero-transcript dir to resolve to ${uuid} via the override, got ${JSON.stringify(dir)}`);
  });

  await run('stale-override-marker-missing-fails-loud (unit)', 'buildProjectDirIndex: an override whose projectRoot has NO marker in its ancestry is collected as a stale failure -- never a fallthrough to transcript resolution, never a silent skip', async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'm03-ov-stale-'));
    const noMarkerRoot = path.join(base, 'checkout-no-marker');
    fs.mkdirSync(noMarkerRoot, { recursive: true }); // deliberately no marker written
    fs.mkdirSync(path.join(base, 'projects'), { recursive: true });
    const dirName = 'stale-override-dir';
    const memPath = path.join(base, 'projects', dirName, 'memory');
    fs.mkdirSync(memPath, { recursive: true });
    fs.writeFileSync(path.join(memPath, 'x.md'), 'x', 'utf8');

    const dirOverrides = { overrides: [{ dirName, projectRoot: noMarkerRoot }], source: 'test' };
    const idx = migrate03.buildProjectDirIndex(base, dirOverrides);
    assert(idx.appliedOverrides.length === 0, `expected zero applied overrides, got ${JSON.stringify(idx.appliedOverrides)}`);
    assert(idx.staleOverrideFailures.length === 1, `expected exactly 1 stale failure, got ${JSON.stringify(idx.staleOverrideFailures)}`);
    assert(idx.staleOverrideFailures[0].dirName === dirName, 'expected the stale failure to name the correct dirName');
    const dir = idx.dirs.find((d) => d.dirName === dirName);
    assert(dir && dir.projectId === null, 'expected the directory itself to remain unresolved (projectId=null), never a fallthrough to transcript resolution');
  });

  await run('dangling-override-reported (unit)', 'buildProjectDirIndex: an override whose dirName matches no existing directory is reported as dangling -- informational, never an error, never affects any other directory', async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'm03-ov-dangling-'));
    fs.mkdirSync(path.join(base, 'projects'), { recursive: true }); // zero project directories at all
    const dirOverrides = { overrides: [{ dirName: 'this-directory-does-not-exist-anywhere', projectRoot: base }], source: 'test' };
    const idx = migrate03.buildProjectDirIndex(base, dirOverrides);
    assert(idx.error === null, 'expected no error');
    assert(idx.staleOverrideFailures.length === 0, 'a dangling override must never be classified as stale -- it was never even attempted');
    assert(idx.danglingOverrides.length === 1 && idx.danglingOverrides[0].dirName === 'this-directory-does-not-exist-anywhere', `expected exactly 1 dangling override, got ${JSON.stringify(idx.danglingOverrides)}`);
  });

  await run('no-override-unchanged-behavior', 'buildProjectDirIndex: a directory with NO matching override resolves via the UNCHANGED transcript/marker mechanism, including the worktree-cwd case, even with unrelated overrides loaded', async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'm03-ov-unaffected-'));
    const repoRoot = path.join(base, 'repo');
    fs.mkdirSync(repoRoot, { recursive: true });
    const { uuid } = projectMarker.writeMarker(repoRoot);
    const worktreeCwd = path.join(repoRoot, '.claude', 'worktrees', 'agent-x');
    fs.mkdirSync(worktreeCwd, { recursive: true });
    fs.mkdirSync(path.join(base, 'projects'), { recursive: true });
    const dirName = 'no-override-here';
    const memPath = path.join(base, 'projects', dirName, 'memory');
    fs.mkdirSync(memPath, { recursive: true });
    fs.writeFileSync(path.join(memPath, 'x.md'), 'x', 'utf8');
    fs.writeFileSync(path.join(path.join(base, 'projects', dirName), 'a.jsonl'), JSON.stringify({ cwd: repoRoot }) + '\n', 'utf8');
    fs.writeFileSync(path.join(path.join(base, 'projects', dirName), 'b.jsonl'), JSON.stringify({ cwd: worktreeCwd }) + '\n', 'utf8');

    // Overrides ARE loaded this run, but carry an entry for a COMPLETELY
    // UNRELATED dirName -- must have zero effect on this directory.
    const dirOverrides = { overrides: [{ dirName: 'some-other-directory-entirely', projectRoot: base }], source: 'test' };
    const idx = migrate03.buildProjectDirIndex(base, dirOverrides);
    const dir = idx.dirs.find((d) => d.dirName === dirName);
    assert(dir && dir.projectId === uuid, `expected unchanged transcript-resolution behavior (worktree case) -> ${uuid}, got ${JSON.stringify(dir)}`);
    assert(idx.appliedOverrides.length === 0, 'expected zero applied overrides (this dir had none)');
    assert(idx.danglingOverrides.length === 1, 'expected the unrelated override entry to be reported as dangling');
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

  // cm#189: every corpus DB used by the "MIGRATE"-mode tests below must be
  // explicitly enrolled REAL-MIGRATE -- migrate-03 now runs a TOTAL
  // provenance classification (A-1) and refuses the whole run on any
  // unenrolled name. The bookkeeping target (DB_TARGET) needs NO entry
  // here -- it resolves via the bookkeeping-target branch instead (spec
  // §2.1 precedence order 1, ahead of the triage branch).
  TRIAGE_DATABASES[DB_CORPUS_HAPPY] = 'REAL-MIGRATE';
  TRIAGE_DATABASES[DB_CORPUS_ORPHAN] = 'REAL-MIGRATE';
  TRIAGE_DATABASES[DB_NOCORPUS] = 'REAL-MIGRATE';
  writeTriageFixture();

  await run('I2', 'discovery classification: holds-corpus vs no-corpus, scoped by --db-prefix; the bookkeeping target is its OWN branch, never a corpus source (cm#189 A-2)', async () => {
    const triage = migrate04.loadDbTriageFull(TRIAGE_PATH);
    const classifications = await migrate03.discoverAndClassify(DB_PREFIX, triage, DB_TARGET);
    const byName = Object.fromEntries(classifications.map((c) => [c.dbName, c]));
    assert(byName[DB_CORPUS_HAPPY].status === 'holds-corpus', 'expected DB_CORPUS_HAPPY holds-corpus');
    assert(byName[DB_CORPUS_HAPPY].hasChunks === true, 'expected hasChunks=true');
    assert(byName[DB_NOCORPUS].status === 'no-corpus', 'expected DB_NOCORPUS no-corpus');
    // DB_TARGET is provisioned via migrate-01-canonical-db.js, which applies
    // the FULL canonical schema (setup.sql included) -- it genuinely DOES
    // carry (empty) memory_entries/memory_entry_chunks tables, same as any
    // other corpus DB, physically. Pre-cm#189 this classified holds-corpus
    // like any other DB (a latent bug, A-2: an unscoped run would manifest
    // the consolidation TARGET as its own migration source, double-
    // counting every absorbed row against T2 Branch A). The bookkeeping-
    // target branch now takes precedence over the corpus-source discovery
    // path entirely -- the target is never even connected via
    // classifyDatabase for this purpose.
    assert(byName[DB_TARGET].branch === 'bookkeeping-target', `expected the bookkeeping target classified via its OWN branch (never a corpus source, cm#189 A-2), got branch=${byName[DB_TARGET].branch}`);
    assert(byName[DB_TARGET].status === 'bookkeeping-target', `expected status=bookkeeping-target, got ${byName[DB_TARGET].status}`);
  });

  await run('I3', '--discover-only mutates nothing (no project_id column added anywhere)', async () => {
    const r = runMigrate03(['--discover-only', '--db', DB_TARGET], { HANDOFF_BASE_DIR: fixtureBase });
    assert(r.status === 0, `expected exit 0, got ${r.status}\nstdout:${r.stdout}\nstderr:${r.stderr}`);
    const client = await pgConnect(DB_CORPUS_HAPPY);
    try {
      const has = await migrate03.columnExists(client, 'memory_entries', 'project_id');
      assert(has === false, 'discover-only must not add project_id');
    } finally { await client.end(); }
  });

  await run('stale-override-marker-missing-fails-loud (CLI)', 'CLI: a stale override (reviewer\'s exact repro-class) refuses the ENTIRE run before any database is touched -- exit non-zero, loud stderr, nothing applied', async () => {
    const overridesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'm03-cli-stale-'));
    const overridesPath = path.join(overridesDir, 'dir-overrides.json');
    const noMarkerRoot = path.join(overridesDir, 'no-marker-here');
    fs.mkdirSync(noMarkerRoot, { recursive: true }); // deliberately no marker
    fs.writeFileSync(overridesPath, JSON.stringify({ overrides: [{ dirName: 'dir-happy', projectRoot: noMarkerRoot }] }), 'utf8');

    const r = runMigrate03(['--db', DB_TARGET, '--dir-overrides', overridesPath], { HANDOFF_BASE_DIR: fixtureBase });
    assert(r.status !== 0, `expected a non-zero exit on a stale override, got ${r.status}`);
    assert(/stale override/i.test(r.stderr), `expected "stale override" mentioned loudly in stderr, got: ${r.stderr}`);

    const client = await pgConnect(DB_CORPUS_HAPPY);
    try {
      const has = await migrate03.columnExists(client, 'memory_entries', 'project_id');
      assert(has === false, 'a stale override must refuse BEFORE any database is touched -- project_id must still be absent');
    } finally { await client.end(); }
  });

  await run('dir-overrides-malformed-file-fails-loud (CLI)', 'CLI: a PRESENT but malformed dir-overrides file (not valid JSON) is a loud FATAL, distinct from a missing file (which is fine)', async () => {
    const overridesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'm03-cli-malformed-'));
    const overridesPath = path.join(overridesDir, 'dir-overrides.json');
    fs.writeFileSync(overridesPath, '{ this is not valid JSON', 'utf8');
    const r = runMigrate03(['--db', DB_TARGET, '--dir-overrides', overridesPath], { HANDOFF_BASE_DIR: fixtureBase });
    assert(r.status !== 0, `expected a non-zero exit on a malformed overrides file, got ${r.status}`);
    assert(/not valid JSON/i.test(r.stderr), `expected the JSON-parse FATAL message, got: ${r.stderr}`);
  });

  await run('dangling-override-reported (CLI)', 'CLI: an override whose dirName matches nothing is reported (loud report line) but does NOT fail the run', async () => {
    const overridesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'm03-cli-dangling-'));
    const overridesPath = path.join(overridesDir, 'dir-overrides.json');
    fs.writeFileSync(overridesPath, JSON.stringify({ overrides: [{ dirName: 'nothing-matches-this-dirname', projectRoot: overridesDir }] }), 'utf8');
    const r = runMigrate03(['--db', DB_TARGET, '--dir-overrides', overridesPath], { HANDOFF_BASE_DIR: fixtureBase });
    assert(r.status === 0, `expected exit 0 (a dangling override is informational, never a failure), got ${r.status}\nstdout:${r.stdout}\nstderr:${r.stderr}`);
    assert(/\[DANGLING-OVERRIDE\]/.test(r.stdout), `expected a [DANGLING-OVERRIDE] report line in stdout, got: ${r.stdout}`);
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

  TRIAGE_DATABASES[DB_CORPUS_A] = 'REAL-MIGRATE';
  TRIAGE_DATABASES[DB_CORPUS_B] = 'REAL-MIGRATE';
  writeTriageFixture();

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
    TRIAGE_DATABASES[DB_ROLLBACK] = 'REAL-MIGRATE';
    writeTriageFixture();
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

  // ── Group 3: cm#189 total provenance classification (spec §2.5) ─────

  await run('P1', 'pattern-matched fixture DB (holds corpus): classified test-artifact-db via pattern, never connected, never manifested, exit 0', async () => {
    const dbName = `${DB_PREFIX}patterntest_p1`;
    await createExtraCorpusDb(dbName, [{ name: 'x', body: 'x', source_file: 'memory/x.md' }]);
    TRIAGE_PATTERNS.push(`^${DB_PREFIX}patterntest_p1$`);
    writeTriageFixture();

    const r = runMigrate03(['--db', DB_TARGET], { HANDOFF_BASE_DIR: fixtureBase });
    assert(r.status === 0, `expected exit 0, got ${r.status}\nstdout:${r.stdout}\nstderr:${r.stderr}`);
    assert(r.stdout.includes(`[TEST-ARTIFACT-DB] "${dbName}" (pattern /`), `expected the pattern-form report line, got:\n${r.stdout}`);

    const client = await pgConnect(dbName);
    try {
      assert(!(await migrate03.columnExists(client, 'memory_entries', 'project_id')), 'a pattern-matched test-artifact DB must never be connected/altered');
    } finally { await client.end(); }
    const tgtClient = await pgConnect(DB_TARGET);
    try {
      const slices = await getManifestSlices(tgtClient, dbName, 'memory_entries');
      assert(slices.length === 0, `expected zero manifest slices for a pattern-excluded DB, got ${slices.length}`);
    } finally { await tgtClient.end(); }
  });

  await run('P2', 'EPHEMERAL-DROP triage entry: same disposition as a pattern match, reported in the "explicit form"', async () => {
    const dbName = `${DB_PREFIX}ephemeral_p2`;
    await createExtraCorpusDb(dbName, [{ name: 'x', body: 'x', source_file: 'memory/x.md' }]);
    TRIAGE_DATABASES[dbName] = 'EPHEMERAL-DROP';
    writeTriageFixture();

    const r = runMigrate03(['--db', DB_TARGET], { HANDOFF_BASE_DIR: fixtureBase });
    assert(r.status === 0, `expected exit 0, got ${r.status}\nstdout:${r.stdout}\nstderr:${r.stderr}`);
    assert(r.stdout.includes(`[TEST-ARTIFACT-DB] "${dbName}" (triage EPHEMERAL-DROP)`), `expected the explicit-form report line, got:\n${r.stdout}`);

    const client = await pgConnect(dbName);
    try {
      assert(!(await migrate03.columnExists(client, 'memory_entries', 'project_id')), 'an EPHEMERAL-DROP DB must never be connected/altered');
    } finally { await client.end(); }
  });

  await run('P3-A2-regression', 'A-2 regression (LOAD-BEARING): an ENGINE-INFRA holds-corpus DB with a PRE-RETIRED manifest triple stays retired across a re-run -- never resurrected, never re-connected', async () => {
    const dbName = `${DB_PREFIX}engineinfra_p3`;
    await createExtraCorpusDb(dbName, [{ name: 'x', body: 'x', source_file: 'memory/x.md' }]);
    TRIAGE_DATABASES[dbName] = 'ENGINE-INFRA';
    writeTriageFixture();

    let manifestIdBefore;
    const tgtClientA = await pgConnect(DB_TARGET);
    try {
      const ins = await tgtClientA.query(
        `INSERT INTO migration_manifest (source_db, source_table, project_id_or_null, row_count, content_fingerprint, excluded_reason, retired_at, retired_note)
         VALUES ($1,'memory_entries','unmapped-orphan-memory-entry',1,'deadbeef',NULL,NOW(),'pre-retired fixture for the cm#189 A-2 regression test')
         RETURNING id, retired_at`,
        [dbName]
      );
      manifestIdBefore = ins.rows[0];
      assert(manifestIdBefore.retired_at !== null, 'sanity: fixture row must start retired');
    } finally { await tgtClientA.end(); }

    const r = runMigrate03(['--db', DB_TARGET], { HANDOFF_BASE_DIR: fixtureBase });
    assert(r.status === 0, `expected exit 0, got ${r.status}\nstdout:${r.stdout}\nstderr:${r.stderr}`);
    assert(r.stdout.includes(`[ENGINE-INFRA-SKIP] "${dbName}"`), `expected the engine-infra-skip report line, got:\n${r.stdout}`);

    // Never reconnected/altered -- the classifier refusal, not a pattern
    // match, is what stops this (neither claude_memory_eval_ci nor
    // claude_memory_eval_test is fixture-named; only an explicit
    // ENGINE-INFRA triage entry can refuse them, per A-2/A-4).
    const client = await pgConnect(dbName);
    try {
      assert(!(await migrate03.columnExists(client, 'memory_entries', 'project_id')), 'an ENGINE-INFRA DB must never be connected/altered');
    } finally { await client.end(); }

    // The pre-existing retired row is UNCHANGED -- same row id, still
    // retired, never DELETEd-and-reINSERTed as a fresh live row. Under the
    // pre-cm#189 code, an unscoped discovery would have connected to this
    // DB, found holds-corpus, and writeManifestForTable's DELETE-then-
    // INSERT would have wiped this retired row and replaced it with a
    // live one (excluded_reason=NULL, retired_at=NULL) -- exactly the
    // resurrection this test guards against.
    const tgtClientB = await pgConnect(DB_TARGET);
    try {
      const { rows } = await tgtClientB.query(
        `SELECT id, retired_at, retired_note FROM migration_manifest WHERE source_db=$1 AND source_table='memory_entries'`,
        [dbName]
      );
      assert(rows.length === 1, `expected exactly the one pre-existing row, got ${rows.length}: ${JSON.stringify(rows)}`);
      assert(rows[0].id === manifestIdBefore.id, 'expected the SAME row (never deleted+reinserted)');
      assert(rows[0].retired_at !== null, 'expected the row to remain retired (never resurrected as a live row -- the A-2 hazard)');
    } finally { await tgtClientB.end(); }
  });

  await run('P4', 'unlisted DB: full classification printed, run refused, nothing altered anywhere (E-1 default branch)', async () => {
    const dbName = `${DB_PREFIX}unlisted_p4`;
    await createDb(dbName); // deliberately self-contained -- dropped at the end of THIS test, never left for later tests to trip over
    try {
      const client = await pgConnect(dbName);
      try { await client.query(MINIMAL_CORPUS_DDL); } finally { await client.end(); }

      const r = runMigrate03(['--db', DB_TARGET], { HANDOFF_BASE_DIR: fixtureBase });
      assert(r.status !== 0, `expected non-zero exit for an UNCLASSIFIED database, got ${r.status}`);
      assert(r.stdout.includes(`[UNCLASSIFIED] "${dbName}"`), `expected the UNCLASSIFIED report line, got:\n${r.stdout}`);
      assert(/Refused \(E-1 total classification\)/.test(r.stderr), `expected the E-1 refusal message, got: ${r.stderr}`);

      const chkClient = await pgConnect(DB_CORPUS_HAPPY);
      try {
        assert(await migrate03.columnExists(chkClient, 'memory_entries', 'project_id'), 'sanity: DB_CORPUS_HAPPY was already migrated by earlier tests and must remain unaffected by this refused run');
      } finally { await chkClient.end(); }
    } finally {
      await dropDb(dbName); // must not leak into later tests' total classification
    }
  });

  await run('P5a', 'missing --db-triage file: loud FATAL (A-6 write-side posture, distinct from T0/T2/T4/T9\'s read-side non-fatal-on-absence)', async () => {
    const missingPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'm03-triage-missing-')), 'does-not-exist.json');
    const r = runMigrate03(['--db', DB_TARGET, '--db-triage', missingPath], { HANDOFF_BASE_DIR: fixtureBase });
    assert(r.status !== 0, `expected non-zero exit, got ${r.status}`);
    assert(/FATAL: db-triage config not found/.test(r.stderr), `expected the missing-file FATAL, got: ${r.stderr}`);
  });

  await run('P5b', 'malformed --db-triage file: collected multi-error FATAL naming EVERY problem (bad class, unanchored pattern, invalid regex, a pattern shadowing a REAL-MIGRATE name)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'm03-triage-malformed-'));
    const malformedPath = path.join(dir, 'db-triage.json');
    fs.writeFileSync(malformedPath, JSON.stringify({
      databases: {
        [DB_CORPUS_HAPPY]: 'REAL-MIGRATE',
        bad_class_db: 'NOT-A-REAL-CLASS',
      },
      test_artifact_db_patterns: [
        'not-anchored',
        '^[invalid(',
        `^${DB_CORPUS_HAPPY}$`,
      ],
    }, null, 2), 'utf8');

    const r = runMigrate03(['--db', DB_TARGET, '--db-triage', malformedPath], { HANDOFF_BASE_DIR: fixtureBase });
    assert(r.status !== 0, `expected non-zero exit, got ${r.status}`);
    assert(/is not a valid class/.test(r.stderr), `expected the invalid-class problem named, got: ${r.stderr}`);
    assert(/is not anchored/.test(r.stderr), `expected the unanchored-pattern problem named, got: ${r.stderr}`);
    assert(/is not a valid regular expression/.test(r.stderr), `expected the invalid-regex problem named, got: ${r.stderr}`);
    assert(new RegExp(`matches "${DB_CORPUS_HAPPY}", which this file triages "REAL-MIGRATE"`).test(r.stderr), `expected the pattern-shadows-REAL-MIGRATE cross-check problem named, got: ${r.stderr}`);
  });

  await run('P6-A7', 'classifyDbProvenance (A-7): an OWN "constructor" property in triage.databases classifies by ITS OWN value; a DB literally named "constructor" ABSENT from triage is UNCLASSIFIED, never Object.prototype.constructor', async () => {
    const triageWithConstructor = { databases: JSON.parse('{"constructor":"REAL-MIGRATE"}'), compiledPatterns: [] };
    const r1 = migrate04.classifyDbProvenance('constructor', triageWithConstructor, 'some_bookkeeping_target');
    assert(r1.branch === 'real-migrate', `expected real-migrate for an explicit own-property "constructor" entry, got ${r1.branch}`);

    const triageWithoutConstructor = { databases: {}, compiledPatterns: [] };
    const r2 = migrate04.classifyDbProvenance('constructor', triageWithoutConstructor, 'some_bookkeeping_target');
    assert(r2.branch === 'unclassified', `expected UNCLASSIFIED for a DB literally named "constructor" absent from triage (never a silent escape via Object.prototype.constructor), got ${r2.branch}`);
  });

  // NOTE on class choice (author's resolution of a genuine spec tension,
  // documented in the PR body): spec item (7) names REAL-MIGRATE, but A-5's
  // own load-time cross-check (implemented in loadDbTriageFull, spec §2.2)
  // FATALs the ENTIRE config load if any pattern matches a name triaged
  // REAL-MIGRATE or OWNER-REVIEW -- the two requirements are mutually
  // exclusive for those two classes specifically (a REAL-MIGRATE fixture
  // that also matches a pattern can never reach the runtime classifier at
  // all; the config is refused first). ENGINE-INFRA and EPHEMERAL-DROP are
  // NOT covered by that cross-check, so "explicit wins over pattern" is
  // demonstrated here via ENGINE-INFRA instead -- the same precedence
  // property (spec §2.1's precedence order 2 over 3), proven by the
  // triage branch's OWN report line (ENGINE-INFRA-SKIP) firing instead of
  // the pattern branch's (TEST-ARTIFACT-DB), plus the shadow INFO line.
  await run('P7', 'explicit-wins: a name BOTH triaged ENGINE-INFRA AND pattern-matching resolves via the triage branch (not the pattern branch), with a shadow INFO line', async () => {
    const dbName = `${DB_PREFIX}patterntest_p7_shadow`;
    await createExtraCorpusDb(dbName, [{ name: 'x', body: 'shadow test', source_file: 'memory/x.md' }]);
    TRIAGE_PATTERNS.push(`^${DB_PREFIX}patterntest_p7_`); // matches dbName
    TRIAGE_DATABASES[dbName] = 'ENGINE-INFRA'; // explicit entry ALSO applies -- must win over the pattern
    writeTriageFixture();

    const r = runMigrate03(['--db', DB_TARGET], { HANDOFF_BASE_DIR: fixtureBase });
    assert(r.status === 0, `expected exit 0, got ${r.status}\nstdout:${r.stdout}\nstderr:${r.stderr}`);
    assert(r.stdout.includes('explicit triage class "ENGINE-INFRA" wins over shadowed pattern'), `expected the shadow INFO line, got:\n${r.stdout}`);
    assert(r.stdout.includes(`[ENGINE-INFRA-SKIP] "${dbName}"`), `expected the triage branch's own report line to win, got:\n${r.stdout}`);
    assert(!r.stdout.includes(`[TEST-ARTIFACT-DB] "${dbName}"`), 'the pattern-form report line must NOT fire once an explicit triage entry claims this name');
  });

  await run('P8', 'bookkeeping target matching a pattern: classified bookkeeping-target (precedence order 1, ahead of the pattern branch), run proceeds unaffected', async () => {
    TRIAGE_PATTERNS.push(`^${DB_TARGET}$`); // deliberately matches the bookkeeping target's own name
    writeTriageFixture();
    try {
      const r = runMigrate03(['--db', DB_TARGET], { HANDOFF_BASE_DIR: fixtureBase });
      assert(r.status === 0, `expected exit 0, got ${r.status}\nstdout:${r.stdout}\nstderr:${r.stderr}`);
      assert(r.stdout.includes(`[BOOKKEEPING-TARGET] "${DB_TARGET}"`), `expected the bookkeeping-target report line despite the pattern match, got:\n${r.stdout}`);
      assert(!r.stdout.includes(`[TEST-ARTIFACT-DB] "${DB_TARGET}"`), 'the bookkeeping target must NEVER be reported as test-artifact-db, even when a pattern matches its own name');
    } finally {
      TRIAGE_PATTERNS.pop(); // must not carry this pattern forward into later tests
      writeTriageFixture();
    }
  });

  await run('P9', '--discover-only: prints all branches, exits 1 iff an UNCLASSIFIED database is present', async () => {
    const clean = runMigrate03(['--discover-only', '--db', DB_TARGET], { HANDOFF_BASE_DIR: fixtureBase });
    assert(clean.status === 0, `expected exit 0 with no UNCLASSIFIED names present, got ${clean.status}\nstdout:${clean.stdout}\nstderr:${clean.stderr}`);

    const dbName = `${DB_PREFIX}unlisted_p9`;
    await createDb(dbName);
    try {
      const client = await pgConnect(dbName);
      try { await client.query(MINIMAL_CORPUS_DDL); } finally { await client.end(); }
      const dirty = runMigrate03(['--discover-only', '--db', DB_TARGET], { HANDOFF_BASE_DIR: fixtureBase });
      assert(dirty.status !== 0, `expected non-zero exit with an UNCLASSIFIED name present, got ${dirty.status}`);
      assert(dirty.stdout.includes(`[UNCLASSIFIED] "${dbName}"`), `expected the UNCLASSIFIED report line, got:\n${dirty.stdout}`);
    } finally {
      await dropDb(dbName);
    }
  });

  console.log(`\n${passed} passed, ${failed} failed`);
}

async function cleanup() {
  for (const db of CREATED_DBS) await dropDb(db);
  for (const db of EXTRA_DBS) await dropDb(db); // cm#189 Group 3 fixtures (best-effort, non-load-bearing)
  if (fixtureBase) { try { fs.rmSync(fixtureBase, { recursive: true, force: true }); } catch (_) {} }
  if (BACKUP_DIR) { try { fs.rmSync(BACKUP_DIR, { recursive: true, force: true }); } catch (_) {} }
}

main()
  .catch((err) => { console.error(err && err.stack ? err.stack : err); failed++; })
  .finally(async () => {
    await cleanup();
    process.exitCode = failed > 0 ? 1 : 0;
  });
