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
 * Field finding, fourth round: a real estate re-run of the resolver-
 * totality fix proved the transcript-cwd mechanism structurally cannot
 * cover most of an estate (25 dirs: 1 resolved, 24 unmapped -- 20 with
 * zero transcripts, 2 with cwds carrying no marker in their ancestry, 1
 * mixed). Orphan re-attribution can never fire for these without a
 * SECOND, owner-reviewable resolution source. `memory-entry-dir-
 * overrides.json` (see `loadDirOverrides` below) is that source --
 * DELIBERATELY mirroring `topic-prefix-to-project.json`'s already-
 * adversary-hardened design (D-12), a reuse of that validated pattern,
 * not a new matcher class.
 *
 * WHAT THIS SCRIPT DOES:
 *
 *   1. DISCOVERY (D3-4, extended by cm#189's spec-adversary hardened total
 *      PROVENANCE classification, BEFORE any ALTER anywhere): enumerates
 *      `pg_database` (every non-template, connectable-in-principle
 *      database name) and classifies EACH `datname` via the shared
 *      `migrate04.classifyDbProvenance()` (scripts/migrations/migrate-04-
 *      absorb-pipeline-tables.js, reused by reference) STRICTLY BEFORE any
 *      connection is opened to it -- provenance is a NAME property, never
 *      inferred from a connection attempt. Precedence order, first match
 *      wins:
 *        1. bookkeeping-target -- `datname === <resolved --db target>`,
 *           byte-exact. Never a corpus source, never manifested, never
 *           pattern-checked (closes cm#189/A-2: an unscoped run previously
 *           discovered the consolidation TARGET itself as its own
 *           migration source, double-counting every absorbed row).
 *        2. Triage branch -- an explicit `--db-triage` (default
 *           `db-triage.json`, gitignored) entry, looked up via
 *           `Object.hasOwn` (never a plain `[dbName]` truthiness check --
 *           A-7's prototype-pollution hole): REAL-MIGRATE proceeds to
 *           CONNECT + classify holds-corpus/no-corpus/unreachable (below,
 *           unchanged); EPHEMERAL-DROP/ENGINE-INFRA/OWNER-REVIEW are a
 *           loud, named skip -- NEVER connected, never manifested, never
 *           ALTERed (ENGINE-INFRA is the branch that stops the A-2
 *           resurrection hazard for `claude_memory_eval_ci`/
 *           `claude_memory_eval_test`, neither of which is fixture-named).
 *        3. Pattern branch -- not in triage, first `test_artifact_db_
 *           patterns` regex match -> a loud, named skip (same disposition
 *           as EPHEMERAL-DROP, reported as the "pattern form").
 *        4. DEFAULT: UNCLASSIFIED -- collected, printed, then a whole-run
 *           refusal (nothing applied to ANY database) before any backup/
 *           ALTER/manifest write anywhere (E-1 posture) -- never a silent
 *           REAL-MIGRATE guess.
 *      Only a `real-migrate`-branch name is ever CONNECTED to (A-4/A-9),
 *      individually (never a cross-DB `information_schema` query --
 *      verified false-result-prone across DBs), and classified:
 *        - holds-corpus   -- has a `memory_entries` base table (chunks
 *                            tracked as present/absent separately: a
 *                            corpus DB with entries but no chunks table
 *                            is a valid, if unusual, state)
 *        - no-corpus      -- neither corpus table exists
 *        - unreachable    -- the connection itself failed
 *      The FULL classification (every branch) is printed before any ALTER
 *      TABLE is issued anywhere. Any `unreachable` real-migrate database is
 *      a loud FATAL that refuses the entire run (nothing applied to any
 *      database) -- this script never silently skips a database it could
 *      not reach. `--db-prefix <prefix>` scopes discovery to `datname LIKE
 *      '<prefix>%'` -- an explicit, printed, operator-declared boundary
 *      for test isolation (this repo's test suite never touches a real
 *      local database), never a silent narrowing: production invocations
 *      omit it and see the TRUE total enumeration.
 *
 *   2. MAP-BUILDING (D3-1, filesystem walk, done ONCE, shared across every
 *      corpus DB found in step 1): for every directory directly under
 *      `<HANDOFF_BASE_DIR or ~/.claude>/projects/` that has a `memory/`
 *      subdirectory, an OVERRIDE (see `loadDirOverrides`) whose `dirName`
 *      exactly matches is consulted FIRST -- a matching override supplies
 *      only a `projectRoot` path, resolved through the SAME
 *      `findProjectRootByMarker` primitive used below (never a shortcut
 *      that skips marker verification), and a directory with a matching
 *      override never falls through to transcript resolution at all. A
 *      directory with NO override proceeds exactly as follows, resolving
 *      the REAL project id by (a) scanning EVERY
 *      line of EVERY one of that directory's own `*.jsonl` session
 *      transcripts for a string `cwd` field — never stopping at the first
 *      hit, collecting every DISTINCT raw value found (multiple distinct
 *      raw cwds are the NORM, not an anomaly: a worktree agent session's
 *      cwd and its parent checkout's cwd both legitimately appear in the
 *      same project's transcripts) — then (b) resolving EACH distinct raw
 *      cwd through `project-marker.js`'s `findProjectRootByMarker`
 *      (imported, NEVER re-implemented) FIRST, and classifying on the SET
 *      OF RESOLVED PROJECT ROOTS, never on raw cwd string equality
 *      (field-finding fix, second round: judging on raw strings treated
 *      the ordinary worktree case as a hard failure and over-orphaned
 *      nearly an entire real estate on first production use). Exactly one
 *      distinct resolved root across every distinct raw cwd -> resolved,
 *      raw-cwd variety irrelevant; two or more distinct resolved roots ->
 *      unmapped ("divergent-transcript-cwds: N distinct resolved project
 *      root(s)") — a directory whose transcripts genuinely point at two or
 *      more DIFFERENT projects, as opposed to one project's checkout plus
 *      its own worktrees. A MIX of at least one resolving cwd and at least
 *      one NON-resolving cwd is ALSO unmapped ("mixed-resolvable-cwds: N
 *      resolved to <root-count> root(s), M unresolvable") — field-finding
 *      fix, third round: `findProjectRootByMarker` never checks the START
 *      path for existence (only each candidate ancestor's marker file), so
 *      a deleted-worktree cwd still resolves fine; an UNRESOLVABLE cwd
 *      therefore can never be explained away as a benign deleted-worktree
 *      artifact — it always means no marker exists anywhere in that path's
 *      ancestry (an alien path, or a genuinely lost second project), and
 *      silently attributing the directory to whichever cwd happened to
 *      resolve is unsafe. The encoded-cwd DIRECTORY NAME ITSELF IS NEVER
 *      DECODED (D3-1: `encodeCwd` is lossy/non-invertible — "my.project",
 *      "my-project", and "my project" all encode identically). A directory
 *      with zero transcript files, zero transcript lines carrying a `cwd`
 *      field, every resolved cwd resolving to no marker root, a mix of
 *      resolving and non-resolving cwds, divergent resolved roots, or a
 *      marker read that throws (project-marker's documented dual-marker
 *      HARD ERROR) is UNMAPPED — its `memory/*.md` filenames are simply
 *      not offered as candidates to any DB, logged with the specific
 *      reason, never guessed.
 *
 *   3. PER-DATABASE BACKFILL (one independent unit of work per corpus DB —
 *      a failure in one DB never blocks another):
 *        0. BACKUP (read-only, before ANY mutation — field finding: the
 *           §6.1(d) step 1 house backup pattern, mirroring
 *           migrate-02-decisions.js's backupSourceTable(), was missing
 *           from the first authored version): dumps every row of this
 *           DB's `memory_entries` (and `memory_entry_chunks`, if present)
 *           to a timestamped JSON file under `--backup-dir` (default
 *           `scripts/migrations/backups/`, gitignored — real corpus
 *           content), unconditionally, every run.
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
 *        d. Backfill every `memory_entries` row `WHERE project_id IS NULL
 *           OR project_id = 'unmapped-orphan-memory-entry'` in batches of
 *           `--batch-size` (D3-8) — a row whose `source_file` has no
 *           mapped project becomes `unmapped-orphan-memory-entry` (D3-11:
 *           migrates normally, never dropped, never blocks the rest of the
 *           table). The `OR project_id = '...orphan...'` half (field
 *           finding, second round) is what makes a re-run able to
 *           re-attribute a row this script itself previously orphaned —
 *           the orphan placeholder is this script's OWN sentinel value,
 *           by construction never a value a manual correction would ever
 *           write, so widening the re-run-eligible set to include it can
 *           never clobber a manual correction (D3-8's protection is
 *           preserved for every OTHER non-NULL value).
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
 *           quiescent. (This gate only ever cares about literal NULLs —
 *           an orphan-placeholder row already satisfies NOT NULL and is
 *           never itself a gate blocker; re-attribution is a separate,
 *           always-attempted reclassification pass, not a precondition of
 *           SET NOT NULL.)
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
 *           still produces an accurate, idempotent manifest — including
 *           the orphan slice correctly SHRINKING (or disappearing) as
 *           step (d)'s re-attribution moves rows out of it on a later run.
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
const migrate04 = require('./migrate-04-absorb-pipeline-tables'); // db-triage: loadDbTriageFull/classifyDbProvenance, reused by reference (cm#189)
const shared = require('./lib/verify15-shared'); // migration_manifest DDL + rowHash, reused by reference
const sfn = require('../lib/source-file-normalize');
const { resolveBaseDir } = require('../lib/handoff-paths');
const { findProjectRootByMarker, readMarker } = require('../lib/project-marker');

// ─── CONSTANTS ──────────────────────────────────────────────────────────────

const MIGRATIONS_DIR = __dirname;
const DEFAULT_MAP_OUT_PATH = path.join(MIGRATIONS_DIR, 'memory-entry-project-map.json');
const DEFAULT_BACKUP_DIR = path.join(MIGRATIONS_DIR, 'backups'); // already gitignored -- shared with migrate-02's backups
const DEFAULT_DIR_OVERRIDES_PATH = path.join(MIGRATIONS_DIR, 'memory-entry-dir-overrides.json');
const DEFAULT_DB_TRIAGE_PATH = path.join(MIGRATIONS_DIR, 'db-triage.json'); // real file gitignored; see db-triage.example.json (cm#189)
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
    mapOut: DEFAULT_MAP_OUT_PATH, backupDir: DEFAULT_BACKUP_DIR,
    dirOverridesPath: DEFAULT_DIR_OVERRIDES_PATH,
    dbTriagePath: DEFAULT_DB_TRIAGE_PATH,
    discoverOnly: false, rollback: false, help: false,
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
    else if (a === '--backup-dir') parsed.backupDir = argv[++i];
    else if (a.startsWith('--backup-dir=')) parsed.backupDir = a.slice('--backup-dir='.length);
    else if (a === '--dir-overrides') parsed.dirOverridesPath = argv[++i];
    else if (a.startsWith('--dir-overrides=')) parsed.dirOverridesPath = a.slice('--dir-overrides='.length);
    else if (a === '--db-triage') parsed.dbTriagePath = argv[++i];
    else if (a.startsWith('--db-triage=')) parsed.dbTriagePath = a.slice('--db-triage='.length);
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
    '         [--backup-dir <path>] [--dir-overrides <path>] [--discover-only]',
    '         [--rollback]',
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
    '  --backup-dir <path>  Directory for the timestamped per-(DB, table) backup',
    '                       dumps written before any mutation (default:',
    '                       scripts/migrations/backups/, gitignored, shared with',
    '                       migrate-02-decisions.js\'s backups).',
    '  --dir-overrides <p>  Path to memory-entry-dir-overrides.json (default:',
    '                       alongside this script). Consulted FIRST, before',
    '                       transcript resolution, on an exact dirName match.',
    '                       Optional -- a missing file means zero overrides;',
    '                       a PRESENT but malformed file is a loud FATAL.',
    '  --db-triage <path>   Path to db-triage.json (default: alongside this',
    '                       script). REQUIRED -- a missing file is a loud',
    '                       FATAL (cm#189): total provenance classification',
    '                       (bookkeeping-target / triage / pattern /',
    '                       UNCLASSIFIED) runs BEFORE any database is',
    '                       enumerated for connection; a name absent from',
    '                       every branch refuses the entire run.',
    '  --discover-only      Print the discovery classification and exit -- no',
    '                       database is altered. Exits 1 if any database is',
    '                       UNCLASSIFIED, even though nothing was mutated.',
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

/**
 * cm#189 (spec-adversary hardened, 2026-08-24, spec §2.1): TOTAL provenance
 * classification, replacing D3-4's old three-branch model (holds-corpus /
 * no-corpus / unreachable applied to EVERY enumerated name with no gate in
 * front of it). Every enumerated `datname` is classified via the SHARED
 * `migrate04.classifyDbProvenance()` (scripts/migrations/migrate-04-absorb-
 * pipeline-tables.js, reused by reference -- one engine, never a private
 * copy) STRICTLY BEFORE any connection is opened to it (A-4). ONLY a name
 * resolved to the 'real-migrate' branch is ever connected to (via
 * classifyDatabase, D3-4's original connect-and-inspect step, unchanged --
 * it still answers holds-corpus/no-corpus/unreachable for that name).
 * Every other branch (bookkeeping-target / test-artifact-db /
 * engine-infra-skip / owner-review-skip / unclassified) is reported with
 * ZERO connection ever attempted (A-4/A-9) -- this, not the pattern list
 * alone, is what stops the A-2 resurrection hazard for ENGINE-INFRA-
 * triaged sources like claude_memory_eval_ci/claude_memory_eval_test,
 * neither of which is fixture-named.
 *
 * `status` on the returned record equals the resolved branch name for
 * every non-real-migrate entry (so a caller filtering
 * `c.status === 'holds-corpus'` for the corpus-DB worklist, or
 * `c.status === 'unreachable'` for the whole-run refusal, is unaffected --
 * those two statuses can only ever originate from the real-migrate branch).
 */
async function discoverAndClassify(dbPrefix, triage, resolvedTarget) {
  const names = await enumerateDatabases(dbPrefix);
  const classifications = [];
  for (const name of names) {
    const provenance = migrate04.classifyDbProvenance(name, triage, resolvedTarget);
    if (provenance.branch === 'real-migrate') {
      const c = await classifyDatabase(name);
      classifications.push({ ...c, branch: 'real-migrate', provenance });
    } else {
      classifications.push({ dbName: name, status: provenance.branch, branch: provenance.branch, provenance });
    }
  }
  return classifications;
}

/**
 * Report-line format per spec §2.1: one line per branch, an INFO line for
 * any triage entry that shadows a pattern, and a per-branch summary count.
 * `[TEST-ARTIFACT-DB]`/`[ENGINE-INFRA-SKIP]`/`[OWNER-REVIEW-SKIP]` name
 * "never connected, never manifested" explicitly (never ALTERed, for
 * owner-review) -- the loudness this classification's refusal/skip
 * behavior lives in, since none of those branches ever write a manifest
 * row for the caller's own T9 roster machinery to see (spec §2.4).
 */
function printClassification(classifications, dbPrefix) {
  console.log(`Discovery + total provenance classification (D3-4 + cm#189 §2.1)${dbPrefix ? ` -- scoped to datname LIKE "${dbPrefix}%" (TEST ISOLATION SCOPE, never silent)` : ' -- TRUE TOTAL enumeration (no --db-prefix scope)'}:`);
  const counts = {
    'bookkeeping-target': 0, 'real-migrate-holds-corpus': 0, 'real-migrate-no-corpus': 0,
    'real-migrate-unreachable': 0, 'test-artifact-db': 0, 'engine-infra-skip': 0,
    'owner-review-skip': 0, unclassified: 0,
  };
  for (const c of classifications) {
    const prov = c.provenance;
    if (prov.shadowedPattern) {
      console.log(`  [INFO] "${c.dbName}": explicit triage class "${prov.triageClass}" wins over shadowed pattern /${prov.shadowedPattern}/`);
    }
    if (c.branch === 'bookkeeping-target') {
      console.log(`  [BOOKKEEPING-TARGET] "${c.dbName}" -- never a corpus source, never manifested, never pattern-checked.`);
      counts['bookkeeping-target']++;
    } else if (c.branch === 'test-artifact-db') {
      const src = prov.source === 'pattern' ? `pattern /${prov.patternSrc}/` : 'triage EPHEMERAL-DROP';
      console.log(`  [TEST-ARTIFACT-DB] "${c.dbName}" (${src}) -- never connected, never manifested`);
      counts['test-artifact-db']++;
    } else if (c.branch === 'engine-infra-skip') {
      console.log(`  [ENGINE-INFRA-SKIP] "${c.dbName}" (triage ENGINE-INFRA) -- never connected, never manifested`);
      counts['engine-infra-skip']++;
    } else if (c.branch === 'owner-review-skip') {
      console.log(`  [OWNER-REVIEW-SKIP] "${c.dbName}" (triage OWNER-REVIEW) -- never connected, never ALTERed, never manifested`);
      counts['owner-review-skip']++;
    } else if (c.branch === 'unclassified') {
      console.log(`  [UNCLASSIFIED] "${c.dbName}"${prov.reason ? ` (${prov.reason})` : ''} -- BLOCKS THE RUN (E-1 posture)`);
      counts.unclassified++;
    } else if (c.status === 'unreachable') {
      console.log(`  [REAL-MIGRATE] "${c.dbName}": UNREACHABLE (${c.error})`);
      counts['real-migrate-unreachable']++;
    } else if (c.status === 'holds-corpus') {
      console.log(`  [REAL-MIGRATE] "${c.dbName}": holds-corpus (entries=${c.hasEntries}, chunks=${c.hasChunks})`);
      counts['real-migrate-holds-corpus']++;
    } else {
      console.log(`  [REAL-MIGRATE] "${c.dbName}": no-corpus`);
      counts['real-migrate-no-corpus']++;
    }
  }
  console.log(
    `  Summary: bookkeeping-target=${counts['bookkeeping-target']} ` +
    `real-migrate-holds-corpus=${counts['real-migrate-holds-corpus']} ` +
    `real-migrate-no-corpus=${counts['real-migrate-no-corpus']} ` +
    `real-migrate-unreachable=${counts['real-migrate-unreachable']} ` +
    `test-artifact-db=${counts['test-artifact-db']} ` +
    `engine-infra-skip=${counts['engine-infra-skip']} ` +
    `owner-review-skip=${counts['owner-review-skip']} ` +
    `unclassified=${counts.unclassified}`
  );
}

// ─── MAP-BUILDING (D3-1/D3-2) ───────────────────────────────────────────────

/**
 * Field finding, fourth round: the transcript-cwd mechanism structurally
 * cannot cover most of a real estate (a first estate-wide run: 25 dirs, 1
 * resolved, 24 unmapped -- 20 with ZERO transcripts, 2 with cwds carrying
 * no marker in their ancestry, 1 mixed). Orphan re-attribution (D3-8's
 * widened predicate) can never fire for these without a SECOND,
 * owner-reviewable resolution source. This is that source: an explicit
 * overrides file, DELIBERATELY mirroring migrate-02-decisions.js's
 * topic-prefix-to-project.json pattern (D-12) -- this is a REUSE of that
 * already-adversary-hardened design, not a new matcher class: same
 * gitignored-real/committed-synthetic-.example.json split, same total-
 * classification validation posture (a malformed file is a loud FATAL
 * before any DB work, never a silently-skipped bad entry), same
 * "consulted first, exact match, everything else falls through unchanged"
 * shape.
 *
 * UNLIKE topic-prefix-to-project.json, this file is OPTIONAL: the base
 * transcript-resolution mechanism is the primary path and works without
 * any overrides at all, so a MISSING overrides file is not an error --
 * only a PRESENT-but-malformed one is (a real, broken file the operator
 * should fix, never silently ignored).
 *
 * Shape: `{ "overrides": [ { "dirName": "<exact ~/.claude/projects/ entry
 * name>", "projectRoot": "<absolute real path>" } ] }`. The override
 * supplies ONLY the path -- identity is still resolved at run time via
 * findProjectRootByMarker(projectRoot) (imported, never re-implemented;
 * same primitive the transcript-cwd path uses), so a stale override
 * (the declared path's marker has since been deleted/moved/corrupted)
 * is a loud, detectable failure rather than a value baked into the
 * config that could silently drift from reality.
 *
 * Total classification of a validation error (every malformed shape maps
 * to an explicit FATAL message, never a silent skip of the bad entry):
 *   - file present, unreadable                    -> FATAL
 *   - file present, not valid JSON                 -> FATAL
 *   - `overrides` field missing or not an array     -> FATAL
 *   - an entry that is not a plain object           -> FATAL (per entry)
 *   - `dirName` missing/empty/non-string             -> FATAL (per entry)
 *   - `projectRoot` missing/empty/non-string         -> FATAL (per entry)
 *   - `projectRoot` present but not an absolute path -> FATAL (per entry)
 *   - a `dirName` repeated across two or more entries -> FATAL (ambiguous:
 *     exactly one override per directory, never "first/last wins")
 * Every violation found is collected and printed together before exiting
 * 1 -- an operator fixing the file sees every problem in one pass, not a
 * whack-a-mole one-error-per-run cycle.
 */
function loadDirOverrides(overridesPath) {
  if (!fs.existsSync(overridesPath)) {
    return { overrides: [], source: null };
  }
  let raw;
  try {
    raw = fs.readFileSync(overridesPath, 'utf8');
  } catch (err) {
    console.error(`FATAL: could not read dir-overrides file at "${overridesPath}": ${err.message}`);
    process.exit(1);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    console.error(`FATAL: dir-overrides file at "${overridesPath}" is not valid JSON: ${err.message}`);
    process.exit(1);
  }
  if (!Array.isArray(parsed.overrides)) {
    console.error(`FATAL: dir-overrides file at "${overridesPath}" must carry an "overrides" array.`);
    console.error('See scripts/migrations/memory-entry-dir-overrides.example.json for the required shape.');
    process.exit(1);
  }
  const seenDirNames = new Set();
  const problems = [];
  parsed.overrides.forEach((entry, i) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      problems.push(`entry ${i}: must be a plain object, got ${JSON.stringify(entry)}`);
      return;
    }
    const dirNameOk = typeof entry.dirName === 'string' && entry.dirName.trim().length > 0;
    if (!dirNameOk) problems.push(`entry ${i}: "dirName" must be a non-empty string`);
    const projectRootOk = typeof entry.projectRoot === 'string' && entry.projectRoot.trim().length > 0;
    if (!projectRootOk) {
      problems.push(`entry ${i}${dirNameOk ? ` (dirName="${entry.dirName}")` : ''}: "projectRoot" must be a non-empty string`);
    } else if (!path.isAbsolute(entry.projectRoot)) {
      problems.push(`entry ${i}${dirNameOk ? ` (dirName="${entry.dirName}")` : ''}: "projectRoot" must be an absolute path, got "${entry.projectRoot}"`);
    }
    if (dirNameOk) {
      if (seenDirNames.has(entry.dirName)) {
        problems.push(`entry ${i}: duplicate dirName "${entry.dirName}" -- exactly one override per directory is allowed, never "first/last wins"`);
      }
      seenDirNames.add(entry.dirName);
    }
  });
  if (problems.length) {
    console.error(`FATAL: dir-overrides file at "${overridesPath}" failed validation (${problems.length} problem(s)):`);
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }
  return { overrides: parsed.overrides, source: overridesPath };
}

/**
 * Light canonicalization used ONLY to DEDUPE raw `cwd` strings before
 * resolving each one through findProjectRootByMarker (an efficiency/
 * clarity aid, never a correctness dependency — path.resolve() inside
 * findProjectRootByMarker already collapses a trailing-slash variant onto
 * the identical resolved root regardless). Deliberately NOT full separator
 * normalization (backslash <-> forward-slash) and NOT case-folding —
 * either would risk masking a REAL difference (e.g. a genuinely different
 * drive-letter-cased mount, or a case-sensitive POSIX path) before
 * resolution ever gets a chance to prove the paths are (or are not) the
 * same project root.
 */
function cwdCompareKey(cwd) {
  return cwd.trim().replace(/[\\/]+$/, '');
}

/**
 * Scan EVERY line of EVERY one of a directory's own *.jsonl session
 * transcripts for a string `cwd` field, returning every DISTINCT raw cwd
 * value found (deduped via cwdCompareKey) — never stops at the first hit.
 *
 * Deliberately does NOT judge divergence itself: multiple distinct raw cwd
 * values in one directory's transcripts are the NORM, not an anomaly —
 * worktree agent sessions legitimately log a worktree-specific cwd (e.g.
 * `<repo>/.claude/worktrees/agent-x`) into the SAME project's transcripts
 * alongside the main checkout's own cwd. Judging divergence on raw string
 * equality (an earlier revision's fix) treated this ordinary case as a
 * hard failure and over-orphaned an entire real estate on first
 * production use. Divergence is judged one level up, in
 * resolveProjectIdForDir, AFTER each distinct raw cwd has been resolved
 * through findProjectRootByMarker — see that function's header comment.
 *
 * Total classification of the result:
 *   - zero transcript files                          -> reason, cwds=[]
 *   - N transcript files, none carry a `cwd` field    -> reason, cwds=[]
 *   - one or more distinct cwd values found            -> cwds (1+), reason=null
 * Never guesses, never decodes the directory name itself.
 */
function findCwdsFromTranscripts(dirAbsPath) {
  let jsonlFiles;
  try {
    jsonlFiles = fs.readdirSync(dirAbsPath).filter((f) => f.endsWith('.jsonl')).sort();
  } catch (err) {
    return { cwds: [], reason: `could not list directory: ${err.message}` };
  }
  if (jsonlFiles.length === 0) {
    return { cwds: [], reason: 'zero transcript files (*.jsonl) in this directory' };
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
    return { cwds: [], reason: `${jsonlFiles.length} transcript file(s) scanned, none carried a "cwd" field` };
  }
  return { cwds: [...distinctByKey.values()], reason: null };
}

/**
 * D3-1 (post-review, second round — field finding from the first real
 * production run): resolve the real project id for one
 * ~/.claude/projects/<dir> entry by resolving EVERY distinct raw `cwd`
 * value found in its own transcripts through findProjectRootByMarker
 * FIRST (imported, never re-implemented), then classifying on the SET OF
 * RESOLVED PROJECT ROOTS — never on raw cwd string equality. Divergent raw
 * cwds are the norm (a worktree agent session's cwd and its parent
 * checkout's cwd both appear in the same project's transcripts, and both
 * legitimately resolve to the identical marker root by walking up) — the
 * first-round fix judged divergence on the raw strings and over-orphaned
 * ~24 of ~25 real memory-bearing directories, including this repo's own,
 * on first production use.
 *
 * Classification, after resolving every distinct raw cwd:
 *   - zero transcripts / no cwd field found in any of them
 *       -> unmapped (existing reason from findCwdsFromTranscripts)
 *   - findProjectRootByMarker/readMarker THROWS for ANY of the distinct
 *     cwds (the documented dual-marker HARD ERROR)
 *       -> unmapped, that error surfaced immediately — never silently
 *          proceed past a HARD ERROR just because another cwd in the set
 *          happened to resolve cleanly
 *   - the distinct cwd set is a MIX of at least one that resolves to a
 *     root AND at least one that resolves to NOTHING (checked BEFORE the
 *     two branches below, third-round field finding)
 *       -> unmapped ("mixed-resolvable-cwds: N resolved to <root-count>
 *          root(s), M unresolvable") — findProjectRootByMarker is a pure
 *          string/parent walk that NEVER checks the START path for
 *          existence (only each candidate ancestor's marker FILE is
 *          checked), so "a deleted worktree subdirectory under a real
 *          root" is NOT a case that fails to resolve — it still resolves
 *          fine, because the walk never needed the start path itself to
 *          exist. An unresolvable cwd therefore ALWAYS means no marker
 *          exists anywhere in that path's ancestry: an alien path, or a
 *          genuinely lost/never-minted second project. Silently
 *          attributing the whole directory to whichever side happened to
 *          resolve (the second-round fix's behavior) could absorb the
 *          unresolvable side's content into the wrong project — never
 *          done; friction (unmapped) is the only safe default here.
 *   - every distinct cwd resolves to NO marker root (all null, none
 *     resolving — the "mixed" case above requires at least one to
 *     resolve, so this is the ALL-unresolvable case)
 *       -> unmapped ("no project marker found walking up from any of N
 *          distinct cwd(s)")
 *   - every distinct cwd resolves, and all agree on exactly ONE root
 *       -> RESOLVED — raw-cwd variety among the inputs is irrelevant once
 *          they converge on one root (the worktree case)
 *   - every distinct cwd resolves, but to two or more DISTINCT roots
 *       -> unmapped ("divergent-transcript-cwds: N distinct resolved
 *          project root(s)"), the roots listed — a directory whose
 *          transcripts genuinely point at TWO OR MORE DIFFERENT projects
 *          (as opposed to one project's main checkout + its own
 *          worktrees) is a real, if rare, case this script must never
 *          guess through.
 */
function resolveProjectIdForDir(dirAbsPath) {
  const { cwds, reason: cwdsReason } = findCwdsFromTranscripts(dirAbsPath);
  if (cwds.length === 0) {
    return { projectId: null, unmappedReason: cwdsReason };
  }
  const resolvedRoots = new Set();
  let unresolvedCount = 0;
  for (const cwd of cwds) {
    let root;
    try {
      root = findProjectRootByMarker(cwd);
    } catch (err) {
      return { projectId: null, unmappedReason: `findProjectRootByMarker threw for cwd="${cwd}": ${err.message}` };
    }
    if (root) resolvedRoots.add(root);
    else unresolvedCount++;
  }
  // Third-round field finding: findProjectRootByMarker is a pure string/
  // parent walk that never checks the START path for existence (only each
  // candidate ancestor directory's MARKER FILE is checked) -- so an
  // unresolvable cwd is never explainable as "a deleted worktree
  // subdirectory under a real root" (that case still resolves fine, since
  // the walk never needed the start path to exist). An unresolvable cwd
  // therefore means NO marker exists anywhere in that path's ancestry: an
  // alien path, or a genuinely lost/never-minted second project. A
  // directory whose distinct cwds are a MIX of at least one that resolves
  // and at least one that does NOT must never be confidently attributed to
  // whichever side happened to resolve -- that would silently absorb the
  // unresolvable side's (possibly real, possibly foreign) content. This
  // check runs BEFORE the all-resolved-agree/all-resolved-diverge checks
  // below, so it also fires correctly when the resolving side itself
  // disagrees on more than one root.
  if (resolvedRoots.size > 0 && unresolvedCount > 0) {
    return {
      projectId: null,
      unmappedReason: `mixed-resolvable-cwds: ${cwds.length - unresolvedCount} resolved to ${resolvedRoots.size} root(s), ${unresolvedCount} unresolvable`,
    };
  }
  if (resolvedRoots.size === 0) {
    return { projectId: null, unmappedReason: `no project marker found walking up from any of ${cwds.length} distinct cwd(s): ${cwds.join(', ')}` };
  }
  if (resolvedRoots.size > 1) {
    return { projectId: null, unmappedReason: `divergent-transcript-cwds: ${resolvedRoots.size} distinct resolved project root(s): ${[...resolvedRoots].join(', ')}` };
  }
  const root = [...resolvedRoots][0];
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
 * Resolve one directory's project id via an explicit override entry --
 * consulted in place of (never as a supplement to) transcript resolution.
 * The override supplies ONLY `projectRoot`; identity still comes from
 * findProjectRootByMarker(projectRoot) at run time (same primitive the
 * transcript-cwd path uses, imported, never re-implemented), so a stale
 * override (marker deleted/moved/corrupted since the override was
 * authored) is DETECTED here, never silently trusted.
 *
 * Returns `{ projectId, unmappedReason, staleReason }`: `staleReason` is
 * non-null iff the override's declared path failed to resolve to a live
 * marker -- the caller (buildProjectDirIndex) collects every stale
 * failure across the whole run and main() refuses the ENTIRE run on any
 * of them (never a fallthrough to transcript resolution for that
 * directory, and never a silent per-directory skip that could mask
 * config drift elsewhere in the same file).
 */
function resolveProjectIdViaOverride(override) {
  let root;
  try {
    root = findProjectRootByMarker(override.projectRoot);
  } catch (err) {
    const reason = `findProjectRootByMarker threw for override projectRoot="${override.projectRoot}": ${err.message}`;
    return { projectId: null, unmappedReason: `stale override: ${reason}`, staleReason: reason };
  }
  if (!root) {
    const reason = `no project marker found walking up from override projectRoot="${override.projectRoot}"`;
    return { projectId: null, unmappedReason: `stale override: ${reason}`, staleReason: reason };
  }
  let marker;
  try {
    marker = readMarker(root);
  } catch (err) {
    const reason = `readMarker threw at override-resolved root="${root}": ${err.message}`;
    return { projectId: null, unmappedReason: `stale override: ${reason}`, staleReason: reason };
  }
  if (!marker) {
    const reason = `marker directory resolved at override-resolved root="${root}" but the marker file is missing/corrupt`;
    return { projectId: null, unmappedReason: `stale override: ${reason}`, staleReason: reason };
  }
  return { projectId: marker.uuid, unmappedReason: null, staleReason: null };
}

/**
 * Walk `<baseDir>/projects/*` once. A directory qualifies as a candidate
 * ONLY if it has a `memory/` subdirectory (never a name-shape check --
 * the marker-UUID-named dirs and the encoded-cwd-named dirs are treated
 * identically; "has a memory/ subdir" is the total, content-based test).
 *
 * For each candidate directory, an override (see loadDirOverrides) whose
 * `dirName` EXACTLY matches is consulted FIRST, before any transcript
 * scanning -- a directory with a matching override never falls through
 * to resolveProjectIdForDir at all (field finding, fourth round: this is
 * the second, owner-reviewable resolution source the transcript mechanism
 * alone cannot provide for the majority of a real estate). A directory
 * with NO matching override proceeds through resolveProjectIdForDir (D3-1)
 * completely unchanged. `memory/*.md` filenames are indexed as normalized
 * (via source-file-normalize) candidate keys regardless of whether
 * resolution succeeded (an unresolved directory's files are kept out of
 * the CANDIDATE list entirely -- see the return shape: only
 * `projectId !== null` dirs carry usable `files`).
 *
 * Return shape additions over the pre-overrides version: `appliedOverrides`
 * (every override that successfully resolved, for the run report),
 * `danglingOverrides` (every override entry whose `dirName` matched NO
 * directory actually present under `projectsRoot` this run -- reported,
 * never an error), and `staleOverrideFailures` (every override whose
 * declared `projectRoot` failed to resolve to a live marker -- the caller
 * refuses the entire run on any of these, per loadDirOverrides' header
 * comment).
 */
function buildProjectDirIndex(baseDir, dirOverrides) {
  const projectsRoot = path.join(baseDir, 'projects');
  const emptyOverrideReport = { appliedOverrides: [], danglingOverrides: [], staleOverrideFailures: [] };
  let entries;
  try {
    entries = fs.readdirSync(projectsRoot, { withFileTypes: true });
  } catch (err) {
    return { projectsRoot, dirs: [], error: `could not list ${projectsRoot}: ${err.message}`, ...emptyOverrideReport };
  }

  const overridesList = (dirOverrides && dirOverrides.overrides) || [];
  const overridesByDirName = new Map(overridesList.map((o) => [o.dirName, o]));
  const matchedDirNames = new Set();
  const appliedOverrides = [];
  const staleOverrideFailures = [];

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

    let projectId;
    let unmappedReason;
    const override = overridesByDirName.get(dirName);
    if (override) {
      matchedDirNames.add(dirName);
      const resolved = resolveProjectIdViaOverride(override);
      projectId = resolved.projectId;
      unmappedReason = resolved.unmappedReason;
      if (resolved.staleReason) {
        staleOverrideFailures.push({ dirName, projectRoot: override.projectRoot, reason: resolved.staleReason });
      } else {
        appliedOverrides.push({ dirName, projectRoot: override.projectRoot, projectId });
      }
    } else {
      ({ projectId, unmappedReason } = resolveProjectIdForDir(dirAbsPath));
    }

    const files = new Set(memFiles.map((f) => sfn.normalize(path.posix.join('memory', f))));
    dirs.push({ dirName, dirAbsPath, projectId, unmappedReason, files, rawFileCount: memFiles.length });
  }

  const danglingOverrides = overridesList.filter((o) => !matchedDirNames.has(o.dirName));

  return { projectsRoot, dirs, error: null, appliedOverrides, danglingOverrides, staleOverrideFailures };
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

// ─── BACKUP (read-only, before any mutation, §6.1(d) step 1) ──────────────

/**
 * ISO timestamp with `:`/`.` replaced so the result is a safe filename
 * fragment on every OS (mirrors migrate-02-decisions.js's
 * timestampForFilename() exactly).
 */
function timestampForFilename(d = new Date()) {
  return d.toISOString().replace(/[:.]/g, '-');
}

/**
 * §6.1(d) step 1's house backup pattern (field finding: missing from the
 * first authored version -- migrate-02-decisions.js's backupSourceTable()
 * is the house precedent this mirrors). Dumps EVERY row of `table` in
 * `dbName`, unconditionally, BEFORE any ALTER/backfill touches it --
 * called for every corpus table (memory_entries always; memory_entry_chunks
 * when present) as the very first action inside the per-database loop, on
 * every run (not just the first), to a timestamped JSON file under
 * `backupDir` (gitignored -- real corpus content, cross-project prose).
 */
async function backupCorpusTable(client, dbName, table, backupDir) {
  const { rows } = await client.query(`SELECT * FROM ${table} ORDER BY id`);
  fs.mkdirSync(backupDir, { recursive: true });
  const fileName = `${dbName}-${table}-backup-${timestampForFilename()}.json`;
  const filePath = path.join(backupDir, fileName);
  const payload = {
    source_db: dbName,
    source_table: table,
    captured_at: new Date().toISOString(),
    row_count: rows.length,
    rows,
  };
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), 'utf8');
  return { filePath, rowCount: rows.length };
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

/**
 * D3-8: batched backfill of memory_entries.project_id via a VALUES join.
 *
 * Re-run-eligible predicate (field finding, second round): `project_id IS
 * NULL OR project_id = ORPHAN_PROJECT_ID` -- widened from a bare `IS NULL`
 * so that a re-run (e.g. after a resolver fix, or after the source
 * project's directory reappears/gets remapped) can re-attribute a row
 * THIS SCRIPT itself previously orphaned. This is safe by construction:
 * ORPHAN_PROJECT_ID is this script's OWN sentinel string, never a value a
 * manual correction or any other writer would independently choose to
 * write, so it is unambiguously distinguishable from "someone deliberately
 * set this row's project_id" -- D3-8's protection (never clobber a
 * non-orphan, non-NULL value) is preserved for every OTHER value. The
 * SELECT and the UPDATE below MUST use the IDENTICAL predicate -- a
 * mismatch here (e.g. widening the SELECT but leaving the UPDATE's WHERE
 * as a bare IS NULL) would silently no-op the UPDATE for every
 * previously-orphaned row while still reporting it as "touched".
 */
async function backfillEntries(client, mapping, batchSize) {
  const { rows } = await client.query(
    `SELECT id, source_file FROM ${ENTRIES_TABLE} WHERE project_id IS NULL OR project_id = $1 ORDER BY id`,
    [ORPHAN_PROJECT_ID]
  );
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
    const orphanParamIdx = params.length + 1;
    params.push(ORPHAN_PROJECT_ID);
    await client.query(
      `UPDATE ${ENTRIES_TABLE} AS m SET project_id = v.project_id
       FROM (VALUES ${valuesSql}) AS v(id, project_id)
       WHERE m.id = v.id AND (m.project_id IS NULL OR m.project_id = $${orphanParamIdx})`,
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

/**
 * `classifications`, when supplied (omitted only by the pre-cm#189 rollback
 * caller which never runs discovery's provenance step at all under
 * --rollback -- see main()), is D3-4/§2.1's own array from
 * discoverAndClassify -- serialized here as `db_classification` per spec
 * §2.1's last line ("The map audit artifact gains a db_classification
 * section recording every branch decision").
 */
function writeMapArtifact(mapOutPath, dirIndex, perDbResults, classifications) {
  const payload = {
    _comment: 'AUDIT ARTIFACT of a migrate-03-corpus-project-id.js run -- never read back as input (D3-7: map-build and map-apply happen in one atomic pass). Real instance data -- gitignored, never committed. See memory-entry-project-map.example.json for the shape documented for public consumption.',
    generated_at: new Date().toISOString(),
    projects_root: dirIndex.projectsRoot,
    resolved_dirs: dirIndex.dirs.filter((d) => d.projectId).map((d) => ({ dirName: d.dirName, projectId: d.projectId, fileCount: d.files.size })),
    unmapped_dirs: dirIndex.dirs.filter((d) => !d.projectId).map((d) => ({ dirName: d.dirName, reason: d.unmappedReason })),
    db_classification: (classifications || []).map((c) => ({
      dbName: c.dbName,
      branch: c.branch,
      status: c.status,
      triageClass: c.provenance ? c.provenance.triageClass || null : null,
      source: c.provenance ? c.provenance.source || null : null,
      patternSrc: c.provenance ? c.provenance.patternSrc || null : null,
      shadowedPattern: c.provenance ? c.provenance.shadowedPattern || null : null,
    })),
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
  const classification = await migrateOne.classifyTarget({ dbName: target });
  if (!classification.allowed) {
    console.error(`Refused: ${classification.reason}`);
    console.error(`(resolved from ${targetSource} — no database connection was opened.)`);
    process.exit(1);
  }

  console.log(`migrate-03-corpus-project-id: bookkeeping target="${target}" (resolved from ${targetSource}) mode=${parsed.rollback ? 'ROLLBACK' : parsed.discoverOnly ? 'DISCOVER-ONLY' : 'MIGRATE'}`);

  // ── db-triage (cm#189, A-6): FATAL on missing/malformed, BEFORE any
  // enumeration or connection -- write-side posture (mirrors migrate-04's
  // own loadDbTriage refusal), never the read-side non-fatal-on-absence
  // posture T0/T2/T4/T9 use (loadDbTriage exits the process itself on any
  // problem, so no further handling is needed here on failure).
  const triage = migrate04.loadDbTriageFull(parsed.dbTriagePath);
  console.log(`db-triage: "${triage.path}" -- ${Object.keys(triage.databases).length} explicitly triaged database(s), ${triage.compiledPatterns.length} test-artifact pattern(s) loaded.`);

  // ── Discovery + total provenance classification (D3-4 + cm#189 §2.1) --
  // ALWAYS runs first, before any ALTER anywhere. Classification is a NAME
  // property resolved BEFORE any connection (A-4) -- only a name resolved
  // to the 'real-migrate' branch is ever connected to.
  const classifications = await discoverAndClassify(parsed.dbPrefix, triage, target);
  printClassification(classifications, parsed.dbPrefix);

  // UNCLASSIFIED is the E-1 total-classification default branch: a loud,
  // whole-run refusal BEFORE any backup/ALTER/manifest write anywhere --
  // checked even in --discover-only / --rollback mode (spec §2.1's last
  // line: "applies identically ... in rollback mode"), and checked BEFORE
  // the pre-existing unreachable refusal below (both are pre-mutation
  // refusals; order between them is not itself load-bearing, but an
  // operator fixing UNCLASSIFIED names first is the more useful order).
  const unclassified = classifications.filter((c) => c.branch === 'unclassified');
  if (unclassified.length) {
    console.error(`Refused (E-1 total classification): ${unclassified.length} database(s) are UNCLASSIFIED -- absent from db-triage.json's "databases" map AND matched by no "test_artifact_db_patterns" entry. Nothing was applied to ANY database:`);
    for (const u of unclassified) console.error(`  - "${u.dbName}"${u.provenance.reason ? ` (${u.provenance.reason})` : ''}`);
    console.error('Total classification: every database must resolve to bookkeeping-target, an explicit db-triage.json class, a test_artifact_db_patterns match, or UNCLASSIFIED (which blocks the run) -- never a silent guess.');
    process.exitCode = 1;
    return;
  }

  const unreachable = classifications.filter((c) => c.status === 'unreachable');
  if (unreachable.length) {
    console.error(`Refused: ${unreachable.length} database(s) were unreachable during discovery (D3-4) — nothing was applied to ANY database:`);
    for (const u of unreachable) console.error(`  - "${u.dbName}": ${u.error}`);
    process.exitCode = 1;
    return;
  }
  const corpusDbs = classifications.filter((c) => c.status === 'holds-corpus');
  console.log(`Discovery complete: ${corpusDbs.length} corpus-holding database(s) eligible for backfill (${classifications.length - corpusDbs.length} other database(s) reported above -- bookkeeping-target/no-corpus/test-artifact-db/engine-infra-skip/owner-review-skip).`);

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
    const dirOverrides = loadDirOverrides(parsed.dirOverridesPath);
    console.log(`Dir-overrides: ${dirOverrides.source ? `"${dirOverrides.source}"` : 'none present (optional -- transcript resolution only)'} — ${dirOverrides.overrides.length} entrie(s) loaded.`);

    const baseDir = resolveBaseDir();
    const dirIndex = buildProjectDirIndex(baseDir, dirOverrides);
    if (dirIndex.error) {
      console.error(`Refused: ${dirIndex.error}`);
      process.exitCode = 1;
      return;
    }

    // Stale overrides (req. 2): a marker missing/corrupt at an overridden
    // path is a LOUD FAIL, refusing the ENTIRE run -- never a fallthrough
    // to transcript resolution for that directory, never a silent skip.
    // Scoped to the whole run (not just that directory) because a stale
    // override signals the override FILE ITSELF has drifted from reality;
    // other entries in the same file may share the same staleness/typo
    // class, and an operator who only checks the exit code must not be
    // able to miss this.
    if (dirIndex.staleOverrideFailures.length) {
      console.error(`Refused: ${dirIndex.staleOverrideFailures.length} stale override(s) in "${dirOverrides.source}" — a declared projectRoot no longer resolves to a live marker (stale-override protection). Nothing was applied to any database.`);
      for (const f of dirIndex.staleOverrideFailures) {
        console.error(`  - dirName="${f.dirName}" projectRoot="${f.projectRoot}": ${f.reason}`);
      }
      process.exitCode = 1;
      return;
    }

    // Applied + dangling overrides (req. 4): every override applied, and
    // every override entry whose dirName matched no existing directory
    // this run (a dangling override is reported, never an error — the
    // directory may legitimately not exist yet).
    for (const a of dirIndex.appliedOverrides) {
      console.log(`  [OVERRIDE] dirName="${a.dirName}" -> projectRoot="${a.projectRoot}" -> project_id="${a.projectId}"`);
    }
    for (const d of dirIndex.danglingOverrides) {
      console.log(`  [DANGLING-OVERRIDE] dirName="${d.dirName}" (projectRoot="${d.projectRoot}") matched no existing directory under "${dirIndex.projectsRoot}"`);
    }

    const resolvedCount = dirIndex.dirs.filter((d) => d.projectId).length;
    const unmappedCount = dirIndex.dirs.length - resolvedCount;
    console.log(`Map-building (D3-1): ${dirIndex.dirs.length} directorie(s) under "${dirIndex.projectsRoot}" carry a memory/ subdirectory — ${resolvedCount} resolved to a project id, ${unmappedCount} unmapped.`);
    for (const d of dirIndex.dirs) {
      if (!d.projectId) console.log(`  [UNMAPPED-DIR] "${d.dirName}": ${d.unmappedReason}`);
    }

    if (corpusDbs.length === 0) {
      console.log('No corpus-holding databases found — nothing to backfill.');
      writeMapArtifact(parsed.mapOut, dirIndex, {}, classifications);
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
        // (0) BACKUP -- read-only, unconditional, before ANY mutation
        // (§6.1(d) step 1; field finding, second round: missing from the
        // first authored version).
        const entriesBackup = await backupCorpusTable(client, db.dbName, ENTRIES_TABLE, parsed.backupDir);
        console.log(`  [BACKUP] ${ENTRIES_TABLE}: ${entriesBackup.rowCount} row(s) -> ${entriesBackup.filePath}`);
        if (db.hasChunks) {
          const chunksBackup = await backupCorpusTable(client, db.dbName, CHUNKS_TABLE, parsed.backupDir);
          console.log(`  [BACKUP] ${CHUNKS_TABLE}: ${chunksBackup.rowCount} row(s) -> ${chunksBackup.filePath}`);
        }

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

    writeMapArtifact(parsed.mapOut, dirIndex, perDbResults, classifications);
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
  loadDirOverrides,
  resolveProjectIdViaOverride,
  cwdCompareKey,
  findCwdsFromTranscripts,
  resolveProjectIdForDir,
  buildProjectDirIndex,
  resolveDbMapping,
  timestampForFilename,
  backupCorpusTable,
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
  DEFAULT_BACKUP_DIR,
  DEFAULT_DIR_OVERRIDES_PATH,
  DEFAULT_DB_TRIAGE_PATH,
  ENTRIES_TABLE,
  CHUNKS_TABLE,
  ENTRIES_LOAD_BEARING_COLS,
  CHUNKS_LOAD_BEARING_COLS,
};
