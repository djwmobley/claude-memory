'use strict';

/**
 * migrate-03-corpus-project-id.js
 *
 * CONSOLIDATION-RUNBOOK.md §6.1(d) + its D3-1..D3-11 spec-adversary
 * amendment (2026-08-16, memory-manager#11(d)): adds + backfills
 * `project_id` on the corpus tables (`memory_entries`,
 * `memory_entry_chunks`) IN PLACE, on EVERY database that holds them —
 * never a data-copy migration (contrast migrate-02-decisions.js, which
 * moves rows into a new store; this script never moves a row, it only
 * ever adds a column to, and backfills, the table where the row already
 * lives).
 *
 * WHAT THIS SCRIPT DOES:
 *
 *   1. DISCOVERY (D3-4, total classification, BEFORE any ALTER anywhere):
 *      enumerates `pg_database` (every non-template, connectable-in-
 *      principle database name), CONNECTS TO EACH ONE INDIVIDUALLY (never
 *      a cross-DB `information_schema` query — verified false-result-prone
 *      across DBs), and classifies it:
 *        - holds-corpus   -- has a `memory_entries` base table (chunks
 *                            tracked as present/absent separately: a
 *                            corpus DB with entries but no chunks table
 *                            is a valid, if unusual, state)
 *        - no-corpus      -- neither corpus table exists
 *        - unreachable    -- the connection itself failed
 *      The FULL classification is printed before any ALTER TABLE is
 *      issued anywhere. Any `unreachable` database is a loud FATAL that
 *      refuses the entire run (nothing applied to any database) — this
 *      script never silently skips a database it could not reach.
 *      `--db-prefix <prefix>` scopes discovery to `datname LIKE
 *      '<prefix>%'` -- an explicit, printed, operator-declared boundary
 *      for test isolation (this repo's test suite never touches a real
 *      local database), never a silent narrowing: production invocations
 *      omit it and see the TRUE total enumeration.
 *
 *   2. MAP-BUILDING (D3-1, filesystem walk, done ONCE, shared across every
 *      corpus DB found in step 1): for every directory directly under
 *      `<HANDOFF_BASE_DIR or ~/.claude>/projects/` that has a `memory/`
 *      subdirectory, resolves the REAL project id by (a) scanning EVERY
 *      line of EVERY one of that directory's own `*.jsonl` session
 *      transcripts for a string `cwd` field — never stopping at the first
 *      hit, and refusing (never guessing) if more than one DISTINCT `cwd`
 *      value is found across those transcripts (post-review fix: a
 *      directory whose transcripts genuinely disagree, e.g. a moved/
 *      renamed checkout later reused under the same encoded-cwd directory
 *      name, must never resolve confidently to whichever transcript
 *      happened to sort first) — then (b) walking up from the single
 *      agreed-upon `cwd` via `project-marker.js`'s
 *      `findProjectRootByMarker` (imported, NEVER re-implemented) to the
 *      nearest `.memory-engine` (or legacy `.claude-memory`) marker and
 *      reading its UUID. The encoded-cwd DIRECTORY NAME ITSELF IS NEVER
 *      DECODED (D3-1: `encodeCwd` is lossy/non-invertible — "my.project",
 *      "my-project", and "my project" all encode identically). A directory
 *      with zero transcript files, zero transcript lines carrying a `cwd`
 *      field, divergent `cwd` values across its transcripts, no marker
 *      found by walking up from the agreed `cwd`, or a marker read that
 *      throws (project-marker's documented dual-marker HARD ERROR) is
 *      UNMAPPED — its `memory/*.md` filenames are simply not offered as
 *      candidates to any DB, logged with the specific reason, never
 *      guessed.
 *
 *   3. PER-DATABASE BACKFILL (one independent unit of work per corpus DB —
 *      a failure in one DB never blocks another):
 *        a. Bundle the additive, idempotent §5.2 SQL: nullable
 *           `project_id TEXT` on both corpus tables (chunks only if that
 *           table exists in this DB) + both `_project_idx` indexes.
 *        b. Capture `expected_count` = `COUNT(*)` on `memory_entries`
 *           (D3-9), immediately after (a) commits.
 *        c. Resolve THIS DATABASE'S OWN (source_file -> project_id)
 *           mapping from the shared filesystem index (D3-3/D3-7, see
 *           `resolveDbMapping` below for the winner-directory heuristic —
 *           this is what makes the persisted map genuinely keyed by
 *           (source_db, source_file), not source_file alone).
 *        d. Backfill every `memory_entries` row `WHERE project_id IS
 *           NULL` in batches of `--batch-size` (D3-8) — a row whose
 *           `source_file` has no mapped project becomes
 *           `unmapped-orphan-memory-entry` (D3-11: migrates normally,
 *           never dropped, never blocks the rest of the table).
 *        e. Backfill `memory_entry_chunks.project_id` from its parent
 *           `memory_entries` row via `entry_id` (D3-6: intra-DB only, a
 *           plain FK join, never an id-remap candidate) `WHERE
 *           project_id IS NULL`.
 *        f. Verification gate (D3-9): zero `project_id IS NULL` rows AND
 *           the LIVE row count still equals `expected_count`. A racing
 *           writer that inserted new rows between (b) and now fails this
 *           gate loudly and this DB's `SET NOT NULL` step is skipped
 *           (documented quiescence precondition) — its nullable backfill
 *           already committed and is safe to leave in place; re-run once
 *           quiescent.
 *        g. `ALTER COLUMN project_id SET NOT NULL` on each corpus table
 *           that passed its own gate.
 *        h. Manifest bookkeeping (D3-11): one `migration_manifest` (+
 *           `migration_manifest_row_hashes`) row PER (source_db=this DB,
 *           source_table, project_id_or_null) slice, `excluded_reason =
 *           NULL` always (mirrors §6.1(b)'s unmatched-* pattern, not the
 *           D-5/D-11 exclusion pattern) — written against the resolved
 *           TARGET/bookkeeping database (`--db`, same resolution +
 *           refusal posture as migrate-01/02: never HANDOFF_DB, refuses
 *           anything migrate-01's `classifyTarget` refuses). Recomputed
 *           from the table's FULL current state every run (not just rows
 *           touched this run), so a re-run against an already-migrated DB
 *           still produces an accurate, idempotent manifest.
 *
 *   4. The built map is ALSO written to `--map-out` (default:
 *      `scripts/migrations/memory-entry-project-map.json`, gitignored —
 *      real instance data) as an AUDIT ARTIFACT of the run (D3-7: this
 *      script never reads a pre-existing map file as input — map-build
 *      and map-apply happen in the same pass, no TOCTOU gap between a
 *      snapshot and its use).
 *
 * ROLLBACK MODE (--rollback): for every corpus DB found in discovery,
 * drops `project_id` (dropping NOT NULL first, tolerating either state)
 * from both corpus tables, then deletes this DB's `migration_manifest` (+
 * row_hashes) slices from the bookkeeping target. Fully reversible per
 * §6.1(d) step 7 — no other phase depends on this column existing yet.
 *
 * WHAT THIS SCRIPT DELIBERATELY DOES NOT DO:
 *   - Never moves/copies a corpus row between databases (contrast
 *     migrate-02/migrate-04).
 *   - Never decodes an encoded-cwd directory name (D3-1).
 *   - Never re-embeds or touches `embedding` (D3-5: independent of
 *     claude-memory#166's dimension question).
 *   - Never remaps `memory_entry_chunks.entry_id` (D3-6: intra-DB FK,
 *     never an id-remap candidate).
 *
 * Usage:
 *   node scripts/migrations/migrate-03-corpus-project-id.js [--db <target>]
 *     [--db-prefix <prefix>] [--batch-size <n>] [--map-out <path>]
 *     [--discover-only] [--rollback]
 *
 * Exit codes: 0 = PASS (migrate: every corpus DB fully backfilled + NOT
 * NULL applied, or zero corpus DBs found; rollback: completed;
 * discover-only: classification printed), 1 = refused / a corpus DB's
 * gate failed / discovery found an unreachable database, 2 = bad CLI usage.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Client } = require('pg');

const migrateOne = require('./migrate-01-canonical-db');
const shared = require('./lib/verify15-shared'); // migration_manifest DDL + rowHash, reused by reference
const sfn = require('../lib/source-file-normalize');
const { resolveBaseDir } = require('../lib/handoff-paths');
const { findProjectRootByMarker, readMarker } = require('../lib/project-marker');

// ─── CONSTANTS ──────────────────────────────────────────────────────────────

const MIGRATIONS_DIR = __dirname;
const DEFAULT_MAP_OUT_PATH = path.join(MIGRATIONS_DIR, 'memory-entry-project-map.json');
const ORPHAN_PROJECT_ID = 'unmapped-orphan-memory-entry';
const DEFAULT_BATCH_SIZE = 500;

const ENTRIES_TABLE = 'memory_entries';
const CHUNKS_TABLE = 'memory_entry_chunks';
// Local to this script -- an in-place column-add/backfill has no analogue
// to migrate-02's cross-store roster; these are the columns this script's
// own manifest fingerprint hashes over.
const ENTRIES_LOAD_BEARING_COLS = ['name', 'description', 'mem_type', 'body', 'source_file'];
const CHUNKS_LOAD_BEARING_COLS = ['content'];

// ─── CLI ARGS ─────────────────────────────────────────────────────────────

class UsageError extends Error {}

function parseArgs(argv) {
  const parsed = {
    db: null, dbPrefix: null, batchSize: DEFAULT_BATCH_SIZE,
    mapOut: DEFAULT_MAP_OUT_PATH, discoverOnly: false, rollback: false, help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--db') parsed.db = argv[++i];
    else if (a.startsWith('--db=')) parsed.db = a.slice('--db='.length);
    else if (a === '--db-prefix') parsed.dbPrefix = argv[++i];
    else if (a.startsWith('--db-prefix=')) parsed.dbPrefix = a.slice('--db-prefix='.length);
    else if (a === '--batch-size') parsed.batchSize = parseInt(argv[++i], 10);
    else if (a.startsWith('--batch-size=')) parsed.batchSize = parseInt(a.slice('--batch-size='.length), 10);
    else if (a === '--map-out') parsed.mapOut = argv[++i];
    else if (a.startsWith('--map-out=')) parsed.mapOut = a.slice('--map-out='.length);
    else if (a === '--discover-only') parsed.discoverOnly = true;
    else if (a === '--rollback') parsed.rollback = true;
    else if (a === '--help' || a === '-h') parsed.help = true;
    else throw new UsageError(`Unknown argument: ${a}`);
  }
  if (!Number.isInteger(parsed.batchSize) || parsed.batchSize <= 0) {
    throw new UsageError(`--batch-size must be a positive integer, got "${parsed.batchSize}"`);
  }
  return parsed;
}

function printUsage() {
  console.log([
    'Usage: node scripts/migrations/migrate-03-corpus-project-id.js [--db <target>]',
    '         [--db-prefix <prefix>] [--batch-size <n>] [--map-out <path>]',
    '         [--discover-only] [--rollback]',
    '',
    '  --db <name>          Bookkeeping target for migration_manifest rows (else',
    '                       MIGRATE_TARGET_DB env, else memory_manager_staging).',
    '                       Never reads HANDOFF_DB. The corpus DBs themselves are',
    '                       discovered separately (see --db-prefix) and mutated',
    '                       in place -- this flag never names a corpus DB.',
    '  --db-prefix <pfx>    Scope pg_database discovery to names LIKE "<pfx>%".',
    '                       TEST ISOLATION ONLY -- omit in production for true',
    '                       total enumeration. Always printed, never silent.',
    '  --batch-size <n>     Row batch size for the memory_entries backfill UPDATE',
    `                       (default ${DEFAULT_BATCH_SIZE}).`,
    '  --map-out <path>     Where to write the built map audit artifact (default:',
    '                       scripts/migrations/memory-entry-project-map.json,',
    '                       gitignored -- never read back as input).',
    '  --discover-only      Print the discovery classification and exit -- no',
    '                       database is altered.',
    '  --rollback           Drop project_id from every corpus DB found in',
    '                       discovery + delete this run\'s manifest slices.',
  ].join('\n'));
}

// ─── DISCOVERY (D3-4) ───────────────────────────────────────────────────────

/**
 * Enumerate every non-template, connect-in-principle database name.
 * `dbPrefix`, if given, scopes the enumeration to `datname LIKE
 * '<prefix>%'` -- an explicit, printed boundary (see header comment),
 * never a silent one.
 */
async function enumerateDatabases(dbPrefix) {
  const sys = new Client(migrateOne.pgConfig('postgres'));
  await sys.connect();
  try {
    let sql = `SELECT datname FROM pg_database WHERE datistemplate = false AND datallowconn = true`;
    const params = [];
    if (dbPrefix) {
      sql += ` AND datname LIKE $1`;
      params.push(`${dbPrefix}%`);
    }
    sql += ` ORDER BY datname`;
    const { rows } = await sys.query(sql, params);
    return rows.map((r) => r.datname);
  } finally {
    await sys.end();
  }
}

/**
 * Total classification of one database (D3-4): holds-corpus / no-corpus /
 * unreachable. Connects to THIS database individually -- never inferred
 * from a cross-DB information_schema query (verified false-result-prone).
 */
async function classifyDatabase(dbName) {
  let client;
  try {
    client = new Client(migrateOne.pgConfig(dbName));
    await client.connect();
  } catch (err) {
    return { dbName, status: 'unreachable', error: err.message };
  }
  try {
    const { rows } = await client.query(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = current_schema() AND table_type = 'BASE TABLE'
         AND table_name IN ($1, $2)`,
      [ENTRIES_TABLE, CHUNKS_TABLE]
    );
    const names = new Set(rows.map((r) => r.table_name));
    const hasEntries = names.has(ENTRIES_TABLE);
    const hasChunks = names.has(CHUNKS_TABLE);
    return { dbName, status: hasEntries ? 'holds-corpus' : 'no-corpus', hasEntries, hasChunks };
  } catch (err) {
    return { dbName, status: 'unreachable', error: err.message };
  } finally {
    try { await client.end(); } catch (_) {}
  }
}

async function discoverAndClassify(dbPrefix) {
  const names = await enumerateDatabases(dbPrefix);
  const classifications = [];
  for (const name of names) {
    classifications.push(await classifyDatabase(name));
  }
  return classifications;
}

function printClassification(classifications, dbPrefix) {
  console.log(`Discovery (D3-4)${dbPrefix ? ` -- scoped to datname LIKE "${dbPrefix}%" (TEST ISOLATION SCOPE, never silent)` : ' -- TRUE TOTAL enumeration (no --db-prefix scope)'}:`);
  for (const c of classifications) {
    if (c.status === 'unreachable') {
      console.log(`  - "${c.dbName}": UNREACHABLE (${c.error})`);
    } else if (c.status === 'holds-corpus') {
      console.log(`  - "${c.dbName}": holds-corpus (entries=${c.hasEntries}, chunks=${c.hasChunks})`);
    } else {
      console.log(`  - "${c.dbName}": no-corpus`);
    }
  }
}

// ─── MAP-BUILDING (D3-1/D3-2) ───────────────────────────────────────────────

/**
 * Light canonicalization used ONLY to compare two `cwd` values for
 * agreement (never used to derive a project id — the resolved `cwd`
 * returned by findCwdFromTranscripts is always the raw, as-recorded
 * string). Deliberately NOT full separator normalization (backslash <->
 * forward-slash) and NOT case-folding — either would risk masking a REAL
 * divergence (e.g. a genuinely different drive-letter-cased mount, or a
 * case-sensitive POSIX path). Trims whitespace and strips exactly one
 * trailing path separator, so a purely representational difference
 * (trailing slash) does not manufacture a false "divergent" verdict, while
 * any other difference still counts as one. Friction (routing an
 * ambiguous case to the unmapped bucket) is always the safer default than
 * silently treating two representations as equal when they might not be.
 */
function cwdCompareKey(cwd) {
  return cwd.trim().replace(/[\\/]+$/, '');
}

/**
 * Scan EVERY line of EVERY one of a directory's own *.jsonl session
 * transcripts for a string `cwd` field — never stop at the first hit
 * (post-review fix: an independent reviewer reproduced a silent confident
 * misattribution from two divergent transcripts in the same directory,
 * e.g. a moved/renamed checkout later reused under the same encoded-cwd
 * directory name — resolving from whichever transcript happened to sort
 * first is exactly the silent-misattribution failure mode D3-1's totality
 * posture forbids). Total classification of the result:
 *   - zero transcript files                              -> reason, cwd=null
 *   - N transcript files, none carry a `cwd` field        -> reason, cwd=null
 *   - every `cwd` field found agrees (via cwdCompareKey)   -> cwd, reason=null
 *   - two or more DISTINCT cwdCompareKey values found      -> reason
 *     ("divergent-transcript-cwds: N distinct values"), cwd=null — routed
 *     to the unmapped bucket exactly like the zero-transcript and
 *     dual-marker branches, never a guessed pick among the candidates.
 * Never guesses, never decodes the directory name itself.
 */
function findCwdFromTranscripts(dirAbsPath) {
  let jsonlFiles;
  try {
    jsonlFiles = fs.readdirSync(dirAbsPath).filter((f) => f.endsWith('.jsonl')).sort();
  } catch (err) {
    return { cwd: null, reason: `could not list directory: ${err.message}` };
  }
  if (jsonlFiles.length === 0) {
    return { cwd: null, reason: 'zero transcript files (*.jsonl) in this directory' };
  }
  const distinctByKey = new Map(); // cwdCompareKey -> first-seen raw cwd value
  for (const fname of jsonlFiles) {
    const fpath = path.join(dirAbsPath, fname);
    let raw;
    try {
      raw = fs.readFileSync(fpath, 'utf8');
    } catch (_) {
      continue;
    }
    const lines = raw.split('\n');
    for (const line of lines) {
      if (!line.trim()) continue;
      let obj;
      try {
        obj = JSON.parse(line);
      } catch (_) {
        continue;
      }
      if (obj && typeof obj.cwd === 'string' && obj.cwd.trim()) {
        const key = cwdCompareKey(obj.cwd);
        if (!distinctByKey.has(key)) distinctByKey.set(key, obj.cwd);
      }
    }
  }
  if (distinctByKey.size === 0) {
    return { cwd: null, reason: `${jsonlFiles.length} transcript file(s) scanned, none carried a "cwd" field` };
  }
  if (distinctByKey.size > 1) {
    return { cwd: null, reason: `divergent-transcript-cwds: ${distinctByKey.size} distinct values` };
  }
  return { cwd: distinctByKey.values().next().value, reason: null };
}

/**
 * D3-1: resolve the real project id for one ~/.claude/projects/<dir>
 * entry via its own transcripts' `cwd` field, then
 * findProjectRootByMarker(cwd) (imported, never re-implemented). A
 * dual-marker HARD ERROR thrown by findProjectRootByMarker/readMarker is
 * CAUGHT here and routed to the unmapped bucket with the error text --
 * never left to propagate and abort the whole run over one directory.
 */
function resolveProjectIdForDir(dirAbsPath) {
  const { cwd, reason: cwdReason } = findCwdFromTranscripts(dirAbsPath);
  if (!cwd) {
    return { projectId: null, unmappedReason: cwdReason };
  }
  let root;
  try {
    root = findProjectRootByMarker(cwd);
  } catch (err) {
    return { projectId: null, unmappedReason: `findProjectRootByMarker threw for cwd="${cwd}": ${err.message}` };
  }
  if (!root) {
    return { projectId: null, unmappedReason: `no project marker found walking up from cwd="${cwd}"` };
  }
  let marker;
  try {
    marker = readMarker(root);
  } catch (err) {
    return { projectId: null, unmappedReason: `readMarker threw at root="${root}": ${err.message}` };
  }
  if (!marker) {
    return { projectId: null, unmappedReason: `marker directory resolved at root="${root}" but the marker file is missing/corrupt` };
  }
  return { projectId: marker.uuid, unmappedReason: null };
}

/**
 * Walk `<baseDir>/projects/*` once. A directory qualifies as a candidate
 * ONLY if it has a `memory/` subdirectory (never a name-shape check --
 * the marker-UUID-named dirs and the encoded-cwd-named dirs are treated
 * identically; "has a memory/ subdir" is the total, content-based test).
 * Every qualifying directory's project id is resolved via
 * resolveProjectIdForDir (D3-1); its `memory/*.md` filenames are indexed
 * as normalized (via source-file-normalize) candidate keys regardless of
 * whether resolution succeeded (an unresolved directory's files are kept
 * out of the CANDIDATE list entirely -- see buildProjectDirIndex's
 * return shape: only `projectId !== null` dirs carry usable `files`).
 */
function buildProjectDirIndex(baseDir) {
  const projectsRoot = path.join(baseDir, 'projects');
  let entries;
  try {
    entries = fs.readdirSync(projectsRoot, { withFileTypes: true });
  } catch (err) {
    return { projectsRoot, dirs: [], error: `could not list ${projectsRoot}: ${err.message}` };
  }

  const dirs = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dirName = entry.name;
    const dirAbsPath = path.join(projectsRoot, dirName);
    const memoryDirPath = path.join(dirAbsPath, 'memory');
    let memFiles;
    try {
      memFiles = fs.readdirSync(memoryDirPath).filter((f) => f.toLowerCase().endsWith('.md'));
    } catch (_) {
      continue; // no memory/ subdirectory -- not a candidate directory
    }
    const { projectId, unmappedReason } = resolveProjectIdForDir(dirAbsPath);
    const files = new Set(memFiles.map((f) => sfn.normalize(path.posix.join('memory', f))));
    dirs.push({ dirName, dirAbsPath, projectId, unmappedReason, files, rawFileCount: memFiles.length });
  }
  return { projectsRoot, dirs, error: null };
}

// ─── PER-DATABASE MAPPING (D3-3/D3-7) ──────────────────────────────────────

/**
 * Resolve ONE corpus database's own (raw source_file -> project_id)
 * mapping from the shared filesystem dir index.
 *
 * Heuristic (documented design decision -- see this script's blind-spot
 * note in the authoring PR body): a single physical DB is, by
 * construction of how the memory-file loader operates, normally the
 * target of ONE project's memory/ directory contents over time (possibly
 * synced from more than one encoded-cwd directory sharing the same
 * project identity, e.g. a project root plus its git worktrees). This
 * DB's "winning" candidate directory is the one whose memory/ file
 * listing has the LARGEST overlap with this DB's own set of DISTINCT
 * source_file values (ties broken deterministically by dirName, logged).
 * Every row whose normalized source_file is in the winner's file set maps
 * to the winner's project id. A row whose normalized source_file is NOT
 * in the winner's set falls back to a strict unique-match check across
 * ALL candidate directories (regardless of winner) -- exactly one
 * candidate directory containing that file is still a confident match;
 * zero or more-than-one candidates is UNMAPPED (never guessed), and that
 * row migrates as `unmapped-orphan-memory-entry` (D3-11).
 *
 * This is what gives the persisted map genuine (source_db, source_file)
 * keying (D3-3): the SAME raw source_file string resolves independently
 * per database, and CAN legitimately resolve to different project ids in
 * two different databases whose winning directories differ.
 */
function resolveDbMapping(distinctSourceFilesRaw, candidateDirs) {
  const resolvedDirs = candidateDirs.filter((d) => d.projectId);
  const normPairs = distinctSourceFilesRaw.map((raw) => ({ raw, norm: sfn.normalize(raw) }));
  const normSet = new Set(normPairs.map((p) => p.norm).filter((n) => n !== null));

  const scores = resolvedDirs.map((dir) => {
    let count = 0;
    for (const n of normSet) if (dir.files.has(n)) count++;
    return { dirName: dir.dirName, projectId: dir.projectId, count, dir };
  });
  scores.sort((a, b) => b.count - a.count || a.dirName.localeCompare(b.dirName));
  const winner = scores.length && scores[0].count > 0 ? scores[0] : null;
  const tied = winner ? scores.filter((s) => s.count === winner.count) : [];

  const mapping = new Map(); // raw source_file -> { projectId, method, dirName }
  for (const { raw, norm } of normPairs) {
    if (norm === null) {
      mapping.set(raw, { projectId: null, method: 'unmapped', reason: 'NULL source_file' });
      continue;
    }
    if (winner && winner.dir.files.has(norm)) {
      mapping.set(raw, { projectId: winner.projectId, method: 'winner-dir', dirName: winner.dirName });
      continue;
    }
    const matches = resolvedDirs.filter((d) => d.files.has(norm));
    if (matches.length === 1) {
      mapping.set(raw, { projectId: matches[0].projectId, method: 'unique-fallback', dirName: matches[0].dirName });
    } else if (matches.length === 0) {
      mapping.set(raw, { projectId: null, method: 'unmapped', reason: 'no project directory memory/ listing contains this source_file' });
    } else {
      mapping.set(raw, {
        projectId: null, method: 'unmapped',
        reason: `ambiguous -- ${matches.length} candidate directories contain this source_file (${matches.map((m) => m.dirName).join(', ')}), none is this DB's winning directory`,
      });
    }
  }
  return { mapping, winner, tied: tied.length > 1 ? tied : null, scores };
}

// ─── SCHEMA / BACKFILL ──────────────────────────────────────────────────────

async function columnExists(client, table, column) {
  const { rows } = await client.query(
    `SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = $1 AND column_name = $2`,
    [table, column]
  );
  return rows.length > 0;
}

async function tableExists(client, table) {
  const { rows } = await client.query(
    `SELECT 1 FROM information_schema.tables WHERE table_schema = current_schema() AND table_name = $1 AND table_type = 'BASE TABLE'`,
    [table]
  );
  return rows.length > 0;
}

/** §5.2 additive SQL, bundled -- nullable column + index, idempotent. */
async function ensureNullableProjectIdColumn(client, table) {
  await client.query(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS project_id TEXT`);
  await client.query(`CREATE INDEX IF NOT EXISTS ${table}_project_idx ON ${table} (project_id)`);
}

/** D3-8: batched backfill of memory_entries.project_id via a VALUES join. */
async function backfillEntries(client, mapping, batchSize) {
  const { rows } = await client.query(`SELECT id, source_file FROM ${ENTRIES_TABLE} WHERE project_id IS NULL ORDER BY id`);
  const updates = rows.map((row) => {
    const m = row.source_file !== null ? mapping.get(row.source_file) : null;
    const projectId = m && m.projectId ? m.projectId : ORPHAN_PROJECT_ID;
    return { id: row.id, projectId };
  });
  for (let i = 0; i < updates.length; i += batchSize) {
    const batch = updates.slice(i, i + batchSize);
    if (batch.length === 0) continue;
    const valuesSql = batch.map((_, idx) => `($${idx * 2 + 1}::int, $${idx * 2 + 2}::text)`).join(',');
    const params = [];
    for (const b of batch) params.push(b.id, b.projectId);
    await client.query(
      `UPDATE ${ENTRIES_TABLE} AS m SET project_id = v.project_id
       FROM (VALUES ${valuesSql}) AS v(id, project_id)
       WHERE m.id = v.id AND m.project_id IS NULL`,
      params
    );
  }
  return updates.length;
}

/**
 * D3-6: memory_entry_chunks.project_id is derived PURELY intra-DB via the
 * entry_id FK -- a plain SQL join, no filesystem/map lookup involved, so
 * (unlike the entries backfill) it needs no per-row external computation
 * and is applied as a single statement rather than chunked by
 * --batch-size (documented deliberate choice: batching exists to bound
 * the size of a VALUES list built from JS-side map lookups, which this
 * step has none of).
 */
async function backfillChunks(client) {
  const res = await client.query(
    `UPDATE ${CHUNKS_TABLE} AS c SET project_id = e.project_id
     FROM ${ENTRIES_TABLE} e WHERE c.entry_id = e.id AND c.project_id IS NULL`
  );
  return res.rowCount;
}

/** D3-9: zero-NULL + unchanged-row-count gate, gating the NOT NULL step. */
async function verifyGateAndMaybeSetNotNull(client, table, expectedCount) {
  const { rows: cntRows } = await client.query(`SELECT COUNT(*)::bigint AS n FROM ${table}`);
  const liveCount = Number(cntRows[0].n);
  const { rows: nullRows } = await client.query(`SELECT COUNT(*)::bigint AS n FROM ${table} WHERE project_id IS NULL`);
  const nullCount = Number(nullRows[0].n);
  if (liveCount !== expectedCount) {
    return { notNullApplied: false, liveCount, nullCount, reason: `row count changed (expected ${expectedCount}, live ${liveCount}) -- a concurrent writer raced this migration; re-run once quiescent` };
  }
  if (nullCount !== 0) {
    return { notNullApplied: false, liveCount, nullCount, reason: `${nullCount} row(s) still have project_id IS NULL after backfill` };
  }
  await client.query(`ALTER TABLE ${table} ALTER COLUMN project_id SET NOT NULL`);
  return { notNullApplied: true, liveCount, nullCount, reason: null };
}

// ─── MANIFEST BOOKKEEPING (D3-11) ──────────────────────────────────────────

function computeFingerprint(orderedRows, cols) {
  const concatenated = orderedRows.map((r) => shared.rowHash(cols, r)).join('');
  return crypto.createHash('md5').update(concatenated).digest('hex');
}

/**
 * D3-11: one migration_manifest (+row_hashes) row PER (sourceDb,
 * sourceTable, project_id) slice, excluded_reason=NULL always, recomputed
 * from the table's FULL CURRENT state every run (idempotent on re-run
 * against an already-migrated DB, and self-correcting if a slice is fully
 * vacated between runs -- orphan reconciliation below).
 */
async function writeManifestForTable(tgtClient, sourceDb, sourceTable, rowsWithProjectId, loadBearingCols) {
  const slices = new Map();
  for (const r of rowsWithProjectId) {
    if (!slices.has(r.project_id)) slices.set(r.project_id, []);
    slices.get(r.project_id).push(r);
  }
  const currentProjectIds = [...slices.keys()];

  for (const [projectId, sliceRows] of slices) {
    await tgtClient.query('BEGIN');
    try {
      await tgtClient.query(
        `DELETE FROM migration_manifest WHERE source_db=$1 AND source_table=$2 AND project_id_or_null=$3`,
        [sourceDb, sourceTable, projectId]
      );
      await tgtClient.query(
        `DELETE FROM migration_manifest_row_hashes WHERE source_db=$1 AND source_table=$2 AND project_id_or_null=$3`,
        [sourceDb, sourceTable, projectId]
      );
      const ordered = [...sliceRows].sort((a, b) => a.id - b.id);
      const fp = computeFingerprint(ordered, loadBearingCols);
      await tgtClient.query(
        `INSERT INTO migration_manifest (source_db, source_table, project_id_or_null, row_count, content_fingerprint, excluded_reason)
         VALUES ($1,$2,$3,$4,$5,NULL)`,
        [sourceDb, sourceTable, projectId, sliceRows.length, fp]
      );
      for (const row of ordered) {
        const h = shared.rowHash(loadBearingCols, row);
        await tgtClient.query(
          `INSERT INTO migration_manifest_row_hashes (source_db, source_table, project_id_or_null, source_row_id, source_hash)
           VALUES ($1,$2,$3,$4,$5)`,
          [sourceDb, sourceTable, projectId, String(row.id), h]
        );
      }
      await tgtClient.query('COMMIT');
    } catch (err) {
      await tgtClient.query('ROLLBACK');
      throw err;
    }
  }

  await tgtClient.query('BEGIN');
  let orphanedSlices = 0;
  try {
    await tgtClient.query(
      `DELETE FROM migration_manifest_row_hashes WHERE source_db=$1 AND source_table=$2 AND project_id_or_null <> ALL($3::text[])`,
      [sourceDb, sourceTable, currentProjectIds]
    );
    const del = await tgtClient.query(
      `DELETE FROM migration_manifest WHERE source_db=$1 AND source_table=$2 AND project_id_or_null <> ALL($3::text[])`,
      [sourceDb, sourceTable, currentProjectIds]
    );
    orphanedSlices = del.rowCount;
    await tgtClient.query('COMMIT');
  } catch (err) {
    await tgtClient.query('ROLLBACK');
    throw err;
  }
  return { slices, currentProjectIds, orphanedSlices };
}

// ─── ROLLBACK ────────────────────────────────────────────────────────────

async function rollbackOneDb(client, tgtClient, dbName, hasChunks) {
  const dropped = { entries: false, chunks: false };
  await client.query('BEGIN');
  try {
    if (await columnExists(client, ENTRIES_TABLE, 'project_id')) {
      await client.query(`ALTER TABLE ${ENTRIES_TABLE} ALTER COLUMN project_id DROP NOT NULL`).catch(() => {});
      await client.query(`ALTER TABLE ${ENTRIES_TABLE} DROP COLUMN project_id`);
      dropped.entries = true;
    }
    if (hasChunks && (await columnExists(client, CHUNKS_TABLE, 'project_id'))) {
      await client.query(`ALTER TABLE ${CHUNKS_TABLE} ALTER COLUMN project_id DROP NOT NULL`).catch(() => {});
      await client.query(`ALTER TABLE ${CHUNKS_TABLE} DROP COLUMN project_id`);
      dropped.chunks = true;
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  }

  await tgtClient.query('BEGIN');
  let deletedManifest = 0;
  let deletedHashes = 0;
  try {
    const hRes = await tgtClient.query(
      `DELETE FROM migration_manifest_row_hashes WHERE source_db=$1 AND source_table IN ($2,$3)`,
      [dbName, ENTRIES_TABLE, CHUNKS_TABLE]
    );
    deletedHashes = hRes.rowCount;
    const mRes = await tgtClient.query(
      `DELETE FROM migration_manifest WHERE source_db=$1 AND source_table IN ($2,$3)`,
      [dbName, ENTRIES_TABLE, CHUNKS_TABLE]
    );
    deletedManifest = mRes.rowCount;
    await tgtClient.query('COMMIT');
  } catch (err) {
    await tgtClient.query('ROLLBACK');
    throw err;
  }
  return { ...dropped, deletedManifest, deletedHashes };
}

// ─── MAP AUDIT ARTIFACT (D3-7) ─────────────────────────────────────────────

function writeMapArtifact(mapOutPath, dirIndex, perDbResults) {
  const payload = {
    _comment: 'AUDIT ARTIFACT of a migrate-03-corpus-project-id.js run -- never read back as input (D3-7: map-build and map-apply happen in one atomic pass). Real instance data -- gitignored, never committed. See memory-entry-project-map.example.json for the shape documented for public consumption.',
    generated_at: new Date().toISOString(),
    projects_root: dirIndex.projectsRoot,
    resolved_dirs: dirIndex.dirs.filter((d) => d.projectId).map((d) => ({ dirName: d.dirName, projectId: d.projectId, fileCount: d.files.size })),
    unmapped_dirs: dirIndex.dirs.filter((d) => !d.projectId).map((d) => ({ dirName: d.dirName, reason: d.unmappedReason })),
    per_db: {},
  };
  for (const [dbName, r] of Object.entries(perDbResults)) {
    payload.per_db[dbName] = {
      winner: r.winner ? { dirName: r.winner.dirName, projectId: r.winner.projectId, overlapCount: r.winner.count } : null,
      tied: r.tied ? r.tied.map((t) => ({ dirName: t.dirName, projectId: t.projectId, overlapCount: t.count })) : null,
      mapping: Object.fromEntries([...r.mapping.entries()].map(([raw, m]) => [raw, { projectId: m.projectId, method: m.method, dirName: m.dirName || null, reason: m.reason || null }])),
    };
  }
  fs.mkdirSync(path.dirname(mapOutPath), { recursive: true });
  fs.writeFileSync(mapOutPath, JSON.stringify(payload, null, 2), 'utf8');
}

// ─── MAIN ───────────────────────────────────────────────────────────────────

async function main() {
  let parsed;
  try {
    parsed = parseArgs(process.argv.slice(2));
  } catch (err) {
    if (err instanceof UsageError) {
      console.error(`Error: ${err.message}`);
      printUsage();
      process.exit(2);
    }
    throw err;
  }
  if (parsed.help) {
    printUsage();
    process.exit(0);
  }

  const { name: target, source: targetSource } = migrateOne.resolveTargetDb({ db: parsed.db });
  if (!migrateOne.DB_NAME_RE.test(target)) {
    console.error(`Invalid database name "${target}" (from ${targetSource}) — must match /^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/.`);
    process.exit(1);
  }
  const classification = migrateOne.classifyTarget(target);
  if (!classification.allowed) {
    console.error(`Refused: ${classification.reason}`);
    console.error(`(resolved from ${targetSource} — no database connection was opened.)`);
    process.exit(1);
  }

  console.log(`migrate-03-corpus-project-id: bookkeeping target="${target}" (resolved from ${targetSource}) mode=${parsed.rollback ? 'ROLLBACK' : parsed.discoverOnly ? 'DISCOVER-ONLY' : 'MIGRATE'}`);

  // ── Discovery (D3-4) -- ALWAYS runs first, before any ALTER anywhere ──
  const classifications = await discoverAndClassify(parsed.dbPrefix);
  printClassification(classifications, parsed.dbPrefix);
  const unreachable = classifications.filter((c) => c.status === 'unreachable');
  if (unreachable.length) {
    console.error(`Refused: ${unreachable.length} database(s) were unreachable during discovery (D3-4) — nothing was applied to ANY database:`);
    for (const u of unreachable) console.error(`  - "${u.dbName}": ${u.error}`);
    process.exitCode = 1;
    return;
  }
  const corpusDbs = classifications.filter((c) => c.status === 'holds-corpus');
  console.log(`Discovery complete: ${corpusDbs.length} corpus-holding database(s), ${classifications.length - corpusDbs.length} without corpus tables.`);

  if (parsed.discoverOnly) {
    process.exitCode = 0;
    return;
  }

  const tgtClient = new Client(migrateOne.pgConfig(target));
  try {
    await tgtClient.connect();
  } catch (err) {
    console.error(`Could not connect to bookkeeping target "${target}": ${err.message}`);
    process.exitCode = 1;
    return;
  }

  let exitCode = 0;
  try {
    await shared.applyDdl(tgtClient); // migration_manifest + row_hashes, idempotent

    if (parsed.rollback) {
      let anyDropped = false;
      for (const db of corpusDbs) {
        const client = new Client(migrateOne.pgConfig(db.dbName));
        await client.connect();
        try {
          const r = await rollbackOneDb(client, tgtClient, db.dbName, db.hasChunks);
          anyDropped = anyDropped || r.entries || r.chunks;
          console.log(`  [ROLLBACK] "${db.dbName}": entries_dropped=${r.entries} chunks_dropped=${r.chunks} manifest_rows_deleted=${r.deletedManifest} hash_rows_deleted=${r.deletedHashes}`);
        } finally {
          await client.end();
        }
      }
      console.log(`ROLLBACK_RESULT: PASS (${corpusDbs.length} corpus database(s) processed)`);
      exitCode = 0;
      return;
    }

    // ── Map-building (D3-1/D3-2), ONCE, shared across every corpus DB ────
    const baseDir = resolveBaseDir();
    const dirIndex = buildProjectDirIndex(baseDir);
    if (dirIndex.error) {
      console.error(`Refused: ${dirIndex.error}`);
      process.exitCode = 1;
      return;
    }
    const resolvedCount = dirIndex.dirs.filter((d) => d.projectId).length;
    const unmappedCount = dirIndex.dirs.length - resolvedCount;
    console.log(`Map-building (D3-1): ${dirIndex.dirs.length} directorie(s) under "${dirIndex.projectsRoot}" carry a memory/ subdirectory — ${resolvedCount} resolved to a project id, ${unmappedCount} unmapped.`);
    for (const d of dirIndex.dirs) {
      if (!d.projectId) console.log(`  [UNMAPPED-DIR] "${d.dirName}": ${d.unmappedReason}`);
    }

    if (corpusDbs.length === 0) {
      console.log('No corpus-holding databases found — nothing to backfill.');
      writeMapArtifact(parsed.mapOut, dirIndex, {});
      console.log(`MIGRATION_RESULT: PASS (0 corpus database(s))`);
      exitCode = 0;
      return;
    }

    const perDbResults = {};
    let allPass = true;

    for (const db of corpusDbs) {
      console.log(`--- "${db.dbName}" ---`);
      const client = new Client(migrateOne.pgConfig(db.dbName));
      await client.connect();
      try {
        // (a) additive schema
        await ensureNullableProjectIdColumn(client, ENTRIES_TABLE);
        if (db.hasChunks) await ensureNullableProjectIdColumn(client, CHUNKS_TABLE);

        // (b) expected_count, captured atomically right after (a)
        const { rows: cntRows } = await client.query(`SELECT COUNT(*)::bigint AS n FROM ${ENTRIES_TABLE}`);
        const expectedEntries = Number(cntRows[0].n);

        // (c) this DB's own mapping
        const { rows: distinctRows } = await client.query(`SELECT DISTINCT source_file FROM ${ENTRIES_TABLE}`);
        const distinctSourceFiles = distinctRows.map((r) => r.source_file);
        const { mapping, winner, tied } = resolveDbMapping(distinctSourceFiles, dirIndex.dirs);
        perDbResults[db.dbName] = { mapping, winner, tied };
        if (winner) {
          console.log(`  [MAP] winning directory: "${winner.dirName}" -> project_id="${winner.projectId}" (overlap=${winner.count}/${distinctSourceFiles.length} distinct source_file(s))`);
        } else {
          console.log(`  [MAP] no winning directory (no candidate directory overlaps this DB's source_file set)`);
        }
        if (tied) {
          console.log(`  [MAP] TIE among ${tied.length} candidate directories at the winning overlap count — resolved deterministically by dirName, see map audit artifact`);
        }

        // (d) backfill entries
        const touchedEntries = await backfillEntries(client, mapping, parsed.batchSize);
        console.log(`  [OK] memory_entries: ${touchedEntries} row(s) backfilled (batch-size=${parsed.batchSize})`);

        // (e) backfill chunks
        let touchedChunks = 0;
        if (db.hasChunks) {
          touchedChunks = await backfillChunks(client);
          console.log(`  [OK] memory_entry_chunks: ${touchedChunks} row(s) backfilled`);
        }

        // (f)/(g) gate + SET NOT NULL
        const entriesGate = await verifyGateAndMaybeSetNotNull(client, ENTRIES_TABLE, expectedEntries);
        console.log(`  [GATE] memory_entries: not_null_applied=${entriesGate.notNullApplied}${entriesGate.reason ? ` (${entriesGate.reason})` : ''}`);
        let chunksGate = { notNullApplied: true, reason: null };
        if (db.hasChunks) {
          const { rows: chunkCntRows } = await client.query(`SELECT COUNT(*)::bigint AS n FROM ${CHUNKS_TABLE}`);
          const expectedChunks = Number(chunkCntRows[0].n);
          chunksGate = await verifyGateAndMaybeSetNotNull(client, CHUNKS_TABLE, expectedChunks);
          console.log(`  [GATE] memory_entry_chunks: not_null_applied=${chunksGate.notNullApplied}${chunksGate.reason ? ` (${chunksGate.reason})` : ''}`);
        }

        // (h) manifest bookkeeping -- FULL current state, every run
        const { rows: allEntries } = await client.query(
          `SELECT id, name, description, mem_type, body, source_file, project_id FROM ${ENTRIES_TABLE} ORDER BY id`
        );
        const entriesManifest = await writeManifestForTable(tgtClient, db.dbName, ENTRIES_TABLE, allEntries, ENTRIES_LOAD_BEARING_COLS);
        console.log(`  [OK] manifest: memory_entries — ${entriesManifest.slices.size} slice(s), ${entriesManifest.orphanedSlices} orphaned slice(s) reconciled`);

        if (db.hasChunks) {
          const { rows: allChunks } = await client.query(
            `SELECT id, content, project_id FROM ${CHUNKS_TABLE} ORDER BY id`
          );
          const chunksManifest = await writeManifestForTable(tgtClient, db.dbName, CHUNKS_TABLE, allChunks, CHUNKS_LOAD_BEARING_COLS);
          console.log(`  [OK] manifest: memory_entry_chunks — ${chunksManifest.slices.size} slice(s), ${chunksManifest.orphanedSlices} orphaned slice(s) reconciled`);
        }

        const dbPass = entriesGate.notNullApplied && chunksGate.notNullApplied;
        if (!dbPass) allPass = false;
        console.log(`  DB_RESULT: ${dbPass ? 'PASS' : 'FAIL'}`);
      } finally {
        await client.end();
      }
    }

    writeMapArtifact(parsed.mapOut, dirIndex, perDbResults);
    console.log(`Map audit artifact written: ${parsed.mapOut}`);

    console.log(`MIGRATION_RESULT: ${allPass ? 'PASS' : 'FAIL'} (${corpusDbs.length} corpus database(s))`);
    exitCode = allPass ? 0 : 1;
  } finally {
    await tgtClient.end();
  }
  process.exitCode = exitCode;
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err && err.stack ? err.stack : err);
    process.exitCode = 1;
  });
}

module.exports = {
  parseArgs,
  UsageError,
  printUsage,
  enumerateDatabases,
  classifyDatabase,
  discoverAndClassify,
  printClassification,
  cwdCompareKey,
  findCwdFromTranscripts,
  resolveProjectIdForDir,
  buildProjectDirIndex,
  resolveDbMapping,
  columnExists,
  tableExists,
  ensureNullableProjectIdColumn,
  backfillEntries,
  backfillChunks,
  verifyGateAndMaybeSetNotNull,
  computeFingerprint,
  writeManifestForTable,
  rollbackOneDb,
  writeMapArtifact,
  ORPHAN_PROJECT_ID,
  DEFAULT_BATCH_SIZE,
  DEFAULT_MAP_OUT_PATH,
  ENTRIES_TABLE,
  CHUNKS_TABLE,
  ENTRIES_LOAD_BEARING_COLS,
  CHUNKS_LOAD_BEARING_COLS,
};
