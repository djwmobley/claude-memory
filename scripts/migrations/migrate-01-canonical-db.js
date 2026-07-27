'use strict';

/**
 * migrate-01-canonical-db.js
 *
 * First migration in scripts/migrations/. Stands up the consolidation TARGET
 * database with the engine schema (entities/assertions/edges/retrieval_events/
 * memory_entries + v_memory_hits). Staging-first: the default target is
 * `memory_manager_staging`, not the eventual production name.
 *
 * WHAT THIS SCRIPT DOES:
 *   1. Resolves + validates the target database name (see TARGET RESOLUTION).
 *   2. Connects to the `postgres` maintenance database and creates the target
 *      if it does not already exist (race-safe — see CREATE DATABASE RACE).
 *   3. If the target already exists and contains user tables, refuses unless
 *      --allow-existing is passed (friction over silent surprise).
 *   4. Applies four SQL files, in order, via a plain JS pg-client apply (no
 *      psql/pg_dump shell-outs): scripts/sql/handoff-core-schema.sql,
 *      scripts/sql/app-retrieval-events-schema.sql, scripts/setup.sql, and
 *      scripts/sql/v_memory_hits.sql. The fourth file is applied EXPLICITLY:
 *      setup.sql's trailing `\ir sql/v_memory_hits.sql` is a psql meta-command
 *      that a plain pg-client apply silently strips, so relying on setup.sql
 *      alone would leave v_memory_hits undefined.
 *   5. Verifies the result: derives the expected table/view set FROM THE SQL
 *      FILES THEMSELVES at verify time (never a hand-maintained list), diffs
 *      it against information_schema, and probes assertions.embedding /
 *      memory_entries.embedding for real pgvector column types.
 *
 * WHAT THIS SCRIPT DELIBERATELY DOES NOT DO (out of scope):
 *   - No data migration. No cutover. No --cutover mode, no acceptance-evidence
 *     flag of any kind. A path argument is not evidence of anything and this
 *     script does not pretend otherwise.
 *   - It does not touch the operational resolver (handoff.js's TARGET_DB
 *     resolution). The eventual flip of that resolver's built-in default is a
 *     SEPARATE, later, human-reviewed change gated on the consolidation
 *     acceptance batteries. For any project with an explicit pipeline.yml
 *     `database:` key or a HANDOFF_DB env override, that eventual flip is a
 *     no-op — verifying resolution-branch coverage for that case is a
 *     cutover-time concern, not this script's.
 *   - It never reads HANDOFF_DB. That env var belongs to the resolver; an
 *     operator's shell exporting HANDOFF_DB for an unrelated purpose must not
 *     silently retarget a schema migration onto a live database.
 *
 * TARGET RESOLUTION (first match wins; unrecognized names are REFUSED — this
 * is a total classification, not an allow-list with a silent pass-through):
 *   1. --db <name>            command-line flag
 *   2. MIGRATE_TARGET_DB      environment variable
 *   3. memory_manager_staging built-in default
 * The resolved name must match /^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/ (same identifier
 * regex handoff.js uses — a database name cannot be a parameterized query
 * placeholder in DDL). It must then classify as an allowed consolidation
 * target: exactly `memory_manager`, exactly `memory_manager_staging`, or any
 * name ending in `_staging`. Every other name — including, but not limited
 * to, `claude_memory_eval_test`, anything matching /^pipeline_/, and
 * `claude_policy_framework` — is refused. The refusal check runs BEFORE any
 * database connection is opened, so a refused target is never connected to.
 *
 * CREATE DATABASE RACE:
 *   Two concurrent invocations targeting the same not-yet-existing database
 *   can both pass the `SELECT ... FROM pg_database` existence check before
 *   either issues CREATE DATABASE. The loser's CREATE DATABASE can surface
 *   as either of two distinct errors depending on exactly where the race
 *   lands: the friendly 42P04 (duplicate_database) if Postgres's own
 *   pre-check catches the collision, or a raw 23505 (unique_violation) on
 *   the pg_database_datname_index system catalog constraint if the race
 *   instead lands at the low-level catalog insert (CREATE DATABASE cannot
 *   run inside a transaction, so this path is not merely theoretical —
 *   empirical testing against a live concurrent race on this codebase's
 *   Postgres version produced 23505, not 42P04, on every trial). Both are
 *   caught and treated as the already-exists success path, not a failure.
 *
 * CONCURRENCY SCOPE (read before running this against a shared target):
 *   Only the CREATE DATABASE step (see above) is race-safe against a second
 *   concurrent invocation. The schema-apply phase is NOT wrapped in any lock
 *   and is NOT safe against two invocations racing the SAME already-existing
 *   target concurrently — concurrent DDL there can collide on catalog-level
 *   unique constraints (observed empirically: pg_class_relname_nsp_index,
 *   pg_type_typname_nsp_index, pg_extension_name_index) and fail. This is a
 *   deliberate scope boundary, not an oversight: this script is an operator-
 *   run, run-once-per-target setup tool, not a concurrent production code
 *   path like handoff.js's per-session writes, so a full advisory-lock
 *   wrapper around the entire apply+verify phase was judged out of scope for
 *   this migration. Run it from a single invocation per target.
 *
 * CONNECTION CONFIG (standard pg env vars, same convention as the rest of
 * this repo's scripts):
 *   PGHOST      default localhost
 *   PGPORT      default 5432
 *   PGUSER      default postgres
 *   PGPASSWORD  default postgres
 * The maintenance connection always targets the literal `postgres` database
 * regardless of PGDATABASE.
 *
 * Usage:
 *   node scripts/migrations/migrate-01-canonical-db.js [--db <name>] [--allow-existing]
 *
 * Exit codes: 0 = PASS, 1 = refused / apply failure / verification failure,
 * 2 = bad CLI usage.
 */

const fs   = require('fs');
const path = require('path');
const { Client } = require('pg');

// ─── PATHS ────────────────────────────────────────────────────────────────────

const SCRIPTS_DIR = path.resolve(__dirname, '..');
const SQL_DIR      = path.join(SCRIPTS_DIR, 'sql');

const SCHEMA_FILES = [
  path.join(SQL_DIR, 'handoff-core-schema.sql'),
  path.join(SQL_DIR, 'app-retrieval-events-schema.sql'),
  path.join(SCRIPTS_DIR, 'setup.sql'),
  // Applied explicitly, fourth — see header comment (D-3: setup.sql's \ir line
  // is a psql meta-command a plain pg-client apply silently strips).
  path.join(SQL_DIR, 'v_memory_hits.sql'),
];

// ─── TARGET RESOLUTION ────────────────────────────────────────────────────────

const DB_NAME_RE = /^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/;

/**
 * Resolve the migration target database name. NEVER reads HANDOFF_DB — that
 * namespace belongs to the operational resolver (handoff.js), not to schema
 * migrations. First match wins: --db flag, then MIGRATE_TARGET_DB env, then
 * the built-in default.
 *
 * @param {{ db: string|null }} parsed — parsed CLI flags (see parseArgs)
 * @returns {{ name: string, source: string }}
 */
function resolveTargetDb(parsed) {
  if (parsed.db) return { name: parsed.db, source: '--db flag' };
  if (process.env.MIGRATE_TARGET_DB) {
    return { name: process.env.MIGRATE_TARGET_DB, source: 'MIGRATE_TARGET_DB env var' };
  }
  return { name: 'memory_manager_staging', source: 'built-in default' };
}

/**
 * Total classification of a resolved target name into allowed / refused.
 * Default branch (anything not explicitly recognized as an allowed
 * consolidation target) is REFUSE — never a silent proceed. This is an
 * allow-list whose unmatched default is fail-closed, which is the opposite
 * failure mode of a blocklist (whose unmatched default would silently pass
 * an unlisted dangerous name through).
 *
 * @param {string} name
 * @returns {{ allowed: boolean, reason?: string }}
 */
function classifyTarget(name) {
  if (name === 'memory_manager' || name === 'memory_manager_staging') {
    return { allowed: true };
  }
  if (/_staging$/.test(name)) {
    return { allowed: true };
  }
  if (name === 'claude_memory_eval_test') {
    return {
      allowed: false,
      reason: 'claude_memory_eval_test is the handoff.js resolver test-suite database, not a migration target.',
    };
  }
  if (/^pipeline_/.test(name)) {
    return {
      allowed: false,
      reason: `"${name}" matches the pipeline_ source-database naming convention, not a migration target.`,
    };
  }
  if (name === 'claude_policy_framework') {
    return {
      allowed: false,
      reason: 'claude_policy_framework is not a consolidation target.',
    };
  }
  return {
    allowed: false,
    reason: `"${name}" is not a recognized consolidation target. Allowed: memory_manager, ` +
      'memory_manager_staging, or a name ending in "_staging".',
  };
}

// ─── CLI ARGS ─────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const parsed = { db: null, allowExisting: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--db') {
      parsed.db = argv[++i];
    } else if (a.startsWith('--db=')) {
      parsed.db = a.slice('--db='.length);
    } else if (a === '--allow-existing') {
      parsed.allowExisting = true;
    } else if (a === '--help' || a === '-h') {
      parsed.help = true;
    } else {
      throw new UsageError(`Unknown argument: ${a}`);
    }
  }
  if (parsed.db === undefined || parsed.db === '') {
    throw new UsageError('--db requires a value');
  }
  return parsed;
}

class UsageError extends Error {}

function printUsage() {
  console.log([
    'Usage: node scripts/migrations/migrate-01-canonical-db.js [--db <name>] [--allow-existing]',
    '',
    '  --db <name>       Target database name (else MIGRATE_TARGET_DB env, else',
    '                     memory_manager_staging). Never reads HANDOFF_DB.',
    '  --allow-existing  Permit applying schema to a pre-existing target that',
    '                     already contains user tables (schema files are additive',
    '                     and idempotent). Without this flag, a pre-existing',
    '                     non-empty target is a hard refusal.',
  ].join('\n'));
}

// ─── PG CONNECTION CONFIG ─────────────────────────────────────────────────────

function pgConfig(database) {
  return {
    host:     process.env.PGHOST     || 'localhost',
    port:     parseInt(process.env.PGPORT || '5432', 10),
    user:     process.env.PGUSER     || 'postgres',
    password: process.env.PGPASSWORD || 'postgres',
    database,
  };
}

// ─── SQL APPLY (meta-command-stripping JS pg-client pattern) ────────────────

/**
 * Strip leading psql meta-commands (\ir, \d, etc.) from a SQL file's text.
 * The node-postgres client speaks the wire protocol directly and has no
 * concept of psql meta-commands; unstripped lines would be sent to the
 * server as invalid SQL. Mirrors handoff.js applyAdditiveSchema's exact
 * stripping regex for consistency across the codebase.
 */
function stripPsqlMetaCommands(sql) {
  return sql.replace(/^\\[a-z].*$/gm, '');
}

async function applySqlFile(client, filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  const sql = stripPsqlMetaCommands(raw);
  await client.query(sql);
}

/**
 * Ensure the vector and pg_trgm extensions exist BEFORE any of the four
 * schema files are applied.
 *
 * Why this step exists: assertions.embedding halfvec(4000) (handoff-core-
 * schema.sql) and memory_entries.embedding vector(1024) (setup.sql) are both
 * wrapped in DO blocks that gracefully — and SILENTLY — skip their ALTER
 * TABLE if the pgvector extension is not yet installed in the target
 * database (caught as undefined_object, surfaced only as a RAISE NOTICE).
 * The mandated apply order runs handoff-core-schema.sql BEFORE setup.sql
 * (which is normally where `CREATE EXTENSION vector`/`pg_trgm` live), so on
 * a genuinely fresh target database the halfvec column would be silently
 * skipped and this script's own D-8 verification would fail on every
 * from-scratch run — the exact silent-degradation failure mode this
 * migration exists to catch, self-inflicted by file ordering. Creating the
 * extensions as an explicit, idempotent pre-step removes that hazard without
 * reordering the four mandated files.
 *
 * Non-fatal by design: if pgvector genuinely is not installed on the server
 * (not merely uncreated in this database), CREATE EXTENSION fails with a
 * real error; that is swallowed here and left for the later column-level
 * probe to report and fail loudly on, with the actual pgvector version (or
 * absence) named in the report.
 */
async function ensureExtensions(client) {
  for (const ext of ['vector', 'pg_trgm']) {
    try {
      await client.query(`CREATE EXTENSION IF NOT EXISTS ${ext}`);
    } catch (err) {
      console.log(`  [WARN] CREATE EXTENSION ${ext} failed (${err.message}) — continuing; verification will report the resulting gap.`);
    }
  }
}

// ─── DERIVED EXPECTED-OBJECT SET (D-4 — no hand-maintained table list) ──────

/**
 * Remove `--` line comments and `/* ... *\/` block comments from SQL text,
 * honoring single-quoted string literals so a `--` or `/*` inside a string
 * (e.g. inside a RAISE NOTICE message) is not mistaken for the start of a
 * comment. Used only to make the CREATE TABLE / CREATE VIEW regex scan below
 * immune to matches inside prose comments — not a full SQL parser.
 */
function stripSqlNoise(sql) {
  let out = '';
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const ch = sql[i];
    if (ch === "'") {
      out += ch; i++;
      while (i < n) {
        out += sql[i];
        if (sql[i] === "'") {
          i++;
          if (i < n && sql[i] === "'") { out += sql[i]; i++; continue; }
          break;
        }
        i++;
      }
      continue;
    }
    if (ch === '-' && sql[i + 1] === '-') {
      while (i < n && sql[i] !== '\n') i++;
      continue;
    }
    if (ch === '/' && sql[i + 1] === '*') {
      i += 2;
      while (i < n && !(sql[i] === '*' && sql[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    out += ch; i++;
  }
  return out;
}

const TABLE_RE = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?"?([a-zA-Z_][a-zA-Z0-9_]*)"?/gi;
const VIEW_RE  = /CREATE\s+(?:OR\s+REPLACE\s+)?VIEW\s+"?([a-zA-Z_][a-zA-Z0-9_]*)"?/gi;

/**
 * Derive the expected table/view set from the SQL files' actual text, at
 * verify time. There is no hand-maintained expected-table constant anywhere
 * in this script — that constant would drift the moment a schema file
 * changed without this script being updated in lockstep (D-4).
 *
 * @param {string[]} sqlFiles — absolute paths
 * @returns {{ tables: Set<string>, views: Set<string> }}
 */
function deriveExpectedObjects(sqlFiles) {
  const tables = new Set();
  const views  = new Set();
  for (const file of sqlFiles) {
    const clean = stripSqlNoise(fs.readFileSync(file, 'utf8'));
    let m;
    TABLE_RE.lastIndex = 0;
    while ((m = TABLE_RE.exec(clean))) tables.add(m[1].toLowerCase());
    VIEW_RE.lastIndex = 0;
    while ((m = VIEW_RE.exec(clean))) views.add(m[1].toLowerCase());
  }
  return { tables, views };
}

// ─── pgvector COLUMN PROBE (D-8) ──────────────────────────────────────────────

/**
 * format_type() reports the full declared type including typmod, e.g.
 * "halfvec(4000)" or "vector(1024)". Returns null if the column does not
 * exist (or the table does not exist) — a distinct, checkable state from any
 * particular declared type.
 */
async function probeColumnType(client, table, column) {
  const { rows } = await client.query(
    `SELECT format_type(a.atttypid, a.atttypmod) AS coltype
       FROM pg_attribute a
       JOIN pg_class c ON a.attrelid = c.oid
       JOIN pg_namespace n ON c.relnamespace = n.oid
      WHERE n.nspname = current_schema()
        AND c.relname = $1
        AND a.attname = $2
        AND a.attnum > 0
        AND NOT a.attisdropped`,
    [table, column]
  );
  return rows.length ? rows[0].coltype : null;
}

async function probePgvectorVersion(client) {
  const { rows } = await client.query(
    `SELECT extversion FROM pg_extension WHERE extname = 'vector'`
  );
  return rows.length ? rows[0].extversion : 'not installed';
}

/**
 * Run the full verification pass (D-4/D-8) against an already-connected
 * client for the target database: derive the expected table/view set from
 * the SQL files' own text, diff it against information_schema, and probe
 * the two pgvector-dependent columns.
 *
 * Deliberately a standalone function (not inlined into main()) so it can be
 * exercised directly against a deliberately-perturbed database state (e.g.
 * a table dropped after a prior successful apply) without going through the
 * CLI's apply step — which would otherwise silently heal a missing table via
 * `CREATE TABLE IF NOT EXISTS` before verification ever saw the gap. This is
 * the seam the test suite's proof-of-firing cases call directly.
 *
 * @param {import('pg').Client} client — connected to the target database
 * @param {string[]} sqlFiles — absolute paths to the schema files to derive
 *   the expected object set from (SCHEMA_FILES in normal use)
 * @returns {Promise<object>} verification result (see fields below)
 */
async function verifyTarget(client, sqlFiles) {
  const expected = deriveExpectedObjects(sqlFiles);

  const actualTablesRes = await client.query(
    `SELECT table_name FROM information_schema.tables
      WHERE table_schema = current_schema() AND table_type = 'BASE TABLE'`
  );
  const actualViewsRes = await client.query(
    `SELECT table_name FROM information_schema.views WHERE table_schema = current_schema()`
  );
  const actualTables = new Set(actualTablesRes.rows.map((r) => r.table_name.toLowerCase()));
  const actualViews  = new Set(actualViewsRes.rows.map((r) => r.table_name.toLowerCase()));

  const missingTables = [...expected.tables].filter((t) => !actualTables.has(t)).sort();
  const missingViews  = [...expected.views].filter((v) => !actualViews.has(v)).sort();
  const extraTables   = [...actualTables].filter((t) => !expected.tables.has(t)).sort();
  const extraViews    = [...actualViews].filter((v) => !expected.views.has(v)).sort();
  const extraObjects  = [...extraTables, ...extraViews];

  const pgvectorVersion = await probePgvectorVersion(client);
  const assertionsEmbeddingType    = await probeColumnType(client, 'assertions', 'embedding');
  const memoryEntriesEmbeddingType = await probeColumnType(client, 'memory_entries', 'embedding');

  const halfvecOk   = assertionsEmbeddingType === 'halfvec(4000)';
  const memVectorOk = memoryEntriesEmbeddingType !== null;

  const pass =
    missingTables.length === 0 &&
    missingViews.length === 0 &&
    halfvecOk &&
    memVectorOk;

  return {
    expectedTables: [...expected.tables].sort(),
    expectedViews: [...expected.views].sort(),
    missingTables,
    missingViews,
    extraTables,
    extraViews,
    extraObjects,
    pgvectorVersion,
    assertionsEmbeddingType,
    memoryEntriesEmbeddingType,
    halfvecOk,
    memVectorOk,
    pass,
  };
}

// ─── CREATE DATABASE (race-safe — D-5) ───────────────────────────────────────

/**
 * Ensure `target` exists, creating it if absent. Race-safe against a second
 * concurrent invocation racing the SAME check-then-create sequence for the
 * SAME not-yet-existing target — see the CREATE DATABASE RACE section of the
 * header comment for why two distinct Postgres error shapes both have to be
 * treated as the already-exists success path.
 *
 * NOT a claim of safety beyond this one step: this function only makes the
 * existence-check-and-create sequence itself race-safe. It does not — and
 * this script does not anywhere else — make the SCHEMA-APPLY phase safe
 * against a second concurrent invocation targeting the same database; see
 * the "Concurrency scope" paragraph in the header comment.
 *
 * @param {import('pg').Client} sysClient — connected to the maintenance DB
 * @param {string} target
 * @returns {Promise<'created'|'existed'|'existed (race-handled)'>}
 */
async function ensureDatabaseCreated(sysClient, target) {
  const existsRes = await sysClient.query('SELECT 1 FROM pg_database WHERE datname = $1', [target]);
  if (existsRes.rows.length > 0) return 'existed';

  try {
    await sysClient.query(`CREATE DATABASE "${target}"`);
    return 'created';
  } catch (err) {
    const isDuplicateDatabase = err.code === '42P04';
    // Real-world concurrent CREATE DATABASE races on this codebase's
    // Postgres version surface as a raw unique_violation on the system
    // catalog index, not the friendlier 42P04 — see header comment.
    const isCatalogRace = err.code === '23505' && err.constraint === 'pg_database_datname_index';
    if (isDuplicateDatabase || isCatalogRace) {
      return 'existed (race-handled)';
    }
    throw err;
  }
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────

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

  const { name: target, source } = resolveTargetDb(parsed);

  if (!DB_NAME_RE.test(target)) {
    console.error(
      `Invalid database name "${target}" (from ${source}) — must match /^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/.`
    );
    process.exit(1);
  }

  const classification = classifyTarget(target);
  if (!classification.allowed) {
    console.error(`Refused: ${classification.reason}`);
    console.error(`(resolved from ${source} — no database connection was opened.)`);
    process.exit(1);
  }

  console.log(`migrate-01-canonical-db: target="${target}" (resolved from ${source})`);

  // ── Step 1/2: connect to maintenance DB, create target if absent (race-safe) ──

  const sys = new Client(pgConfig('postgres'));
  await sys.connect();

  let status; // 'created' | 'existed' | 'existed (race-handled)'
  try {
    status = await ensureDatabaseCreated(sys, target);
  } finally {
    await sys.end();
  }

  console.log(`  database: ${status}`);

  // ── Step 3: refuse a non-empty pre-existing target without --allow-existing ──

  const db = new Client(pgConfig(target));
  await db.connect();

  let exitCode = 0;
  try {
    const existingTablesRes = await db.query(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = current_schema() AND table_type = 'BASE TABLE'
        ORDER BY table_name`
    );
    if (existingTablesRes.rows.length > 0 && !parsed.allowExisting) {
      console.error(
        `Refused: target "${target}" already contains ${existingTablesRes.rows.length} user table(s):`
      );
      for (const row of existingTablesRes.rows) console.error(`  - ${row.table_name}`);
      console.error('Pass --allow-existing to apply the (additive/idempotent) schema anyway.');
      process.exitCode = 1;
      await db.end();
      return;
    }

    // ── Step 4: apply the four SQL files, in order ──────────────────────────

    await ensureExtensions(db);

    const fileResults = [];
    for (const file of SCHEMA_FILES) {
      const label = path.relative(SCRIPTS_DIR, file);
      try {
        await applySqlFile(db, file);
        fileResults.push({ file: label, ok: true });
        console.log(`  [OK]   ${label}`);
      } catch (err) {
        fileResults.push({ file: label, ok: false, error: err.message });
        console.log(`  [FAIL] ${label}: ${err.message}`);
      }
    }
    const anyFileFailed = fileResults.some((r) => !r.ok);

    // ── Step 5: verification ────────────────────────────────────────────────

    const verification = await verifyTarget(db, SCHEMA_FILES);

    console.log(
      `  derived expected set: ${verification.expectedTables.length} table(s), ` +
      `${verification.expectedViews.length} view(s)`
    );
    if (verification.missingTables.length || verification.missingViews.length) {
      console.log(`  MISSING tables: ${verification.missingTables.length ? verification.missingTables.join(', ') : '(none)'}`);
      console.log(`  MISSING views: ${verification.missingViews.length ? verification.missingViews.join(', ') : '(none)'}`);
    } else {
      console.log('  missing: (none)');
    }
    console.log(
      `  extra (later-phase or unknown): ${verification.extraObjects.length ? verification.extraObjects.join(', ') : '(none)'}`
    );
    console.log(`  pgvector extversion: ${verification.pgvectorVersion}`);
    console.log(`  assertions.embedding: ${verification.assertionsEmbeddingType === null ? 'ABSENT' : verification.assertionsEmbeddingType}`);
    console.log(`  memory_entries.embedding: ${verification.memoryEntriesEmbeddingType === null ? 'ABSENT' : verification.memoryEntriesEmbeddingType}`);

    if (!verification.halfvecOk) {
      console.log(
        `  FAIL reason: assertions.embedding is not halfvec(4000) ` +
        `(found: ${verification.assertionsEmbeddingType === null ? 'ABSENT' : verification.assertionsEmbeddingType}; ` +
        `pgvector extversion: ${verification.pgvectorVersion}).`
      );
    }
    if (!verification.memVectorOk) {
      console.log('  FAIL reason: memory_entries.embedding is ABSENT.');
    }

    const pass = !anyFileFailed && verification.pass;
    console.log(`MIGRATION_RESULT: ${pass ? 'PASS' : 'FAIL'}`);
    exitCode = pass ? 0 : 1;
  } finally {
    await db.end();
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
  resolveTargetDb,
  classifyTarget,
  parseArgs,
  UsageError,
  deriveExpectedObjects,
  stripSqlNoise,
  stripPsqlMetaCommands,
  applySqlFile,
  ensureExtensions,
  ensureDatabaseCreated,
  probeColumnType,
  probePgvectorVersion,
  verifyTarget,
  pgConfig,
  DB_NAME_RE,
  SCHEMA_FILES,
};
