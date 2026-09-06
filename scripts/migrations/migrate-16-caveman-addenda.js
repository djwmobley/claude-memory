'use strict';

/**
 * migrate-16-caveman-addenda.js
 *
 * Applies scripts/migrations/sql/migrate-16-caveman-addenda.sql (§3.5 schema
 * addendum for the store-wide caveman-economy gate — K-9 owner-delegate
 * decision, memory-manager#12/T7, 2026-08-16) against a migrate-01 target
 * that already has the `assertions` table.
 *
 * WHY A SEPARATE FILE/RUNNER, NOT FOLDED INTO migrate-schema-addenda.js:
 * same precedent as migrate-15-mcp-addenda.js (see that file's own header
 * comment) — keeping this addendum in its own runner avoids a merge
 * collision on migrate-schema-addenda.js's shared SQL_FILES array with any
 * concurrent sibling PR that also adds an addendum in the same window.
 *
 * WHAT THIS SCRIPT DOES:
 *   1. Resolves + validates the target database name — identical resolution
 *      to every other migrate-*.js runner (--db flag, then
 *      MIGRATE_TARGET_DB env, then memory_manager_staging), reusing
 *      migrate-01's own exported helpers by reference. Never reads
 *      HANDOFF_DB.
 *   2. Confirms the target database EXISTS (migrate-schema-addenda.js's
 *      exported checkDbExists, reused by reference) before opening any
 *      connection to the target itself. Does not create the target
 *      database.
 *   3. Confirms the `assertions` table already exists — a missing
 *      prerequisite is a hard, up-front refusal, nothing applied.
 *   4. Applies the one SQL file via migrate-01's own applySqlFile.
 *   5. Verifies via migrate-schema-addenda.js's generic
 *      deriveSchemaAddenda/verifyAddenda (reused by reference) — the
 *      `authoring_mode` column + its CHECK constraint both fit the generic
 *      "ALTER TABLE ... ADD COLUMN IF NOT EXISTS ... CHECK (...)" shape it
 *      already parses; no targeted checks are needed beyond that (unlike
 *      migrate-15, this addendum adds no index/seed-row shape the generic
 *      deriver can't express).
 *   6. ADDITIONALLY verifies the grandfather property itself (K-9): any
 *      pre-existing assertion row must read `authoring_mode IS NULL` after
 *      this migration — never silently backfilled to 'caveman'. This is
 *      the one property the generic column/CHECK deriver cannot express
 *      (it only checks the column and constraint DEFINITIONS, not that no
 *      DEFAULT clause was attached) — verified directly against
 *      information_schema.columns.column_default.
 *
 * Usage:
 *   node scripts/migrations/migrate-16-caveman-addenda.js [--db <name>]
 *
 * Exit codes: 0 = PASS, 1 = refused / prerequisite missing / apply failure /
 * verification failure, 2 = bad CLI usage.
 */

const path = require('path');
const { Client } = require('pg');

const migrateOne = require('./migrate-01-canonical-db');
const addenda = require('./migrate-schema-addenda'); // reused by reference (never forked)

const MIGRATIONS_DIR = __dirname;
const SQL_DIR = path.join(MIGRATIONS_DIR, 'sql');
const SQL_FILE = path.join(SQL_DIR, 'migrate-16-caveman-addenda.sql');
const SQL_FILES = [SQL_FILE];

const PREREQUISITE_TABLES = ['assertions'];

class UsageError extends Error {}

function parseArgs(argv) {
  const parsed = { db: null, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--db') {
      parsed.db = argv[++i];
    } else if (a.startsWith('--db=')) {
      parsed.db = a.slice('--db='.length);
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

function printUsage() {
  console.log([
    'Usage: node scripts/migrations/migrate-16-caveman-addenda.js [--db <name>]',
    '',
    '  --db <name>  Target database name (else MIGRATE_TARGET_DB env, else',
    '               memory_manager_staging). Never reads HANDOFF_DB. The',
    '               target database must already exist and already carry',
    '               the assertions table.',
  ].join('\n'));
}

async function checkPrerequisiteTables(client) {
  const { rows } = await client.query(
    `SELECT table_name FROM information_schema.tables
      WHERE table_schema = current_schema() AND table_type = 'BASE TABLE'`
  );
  const actual = new Set(rows.map((r) => r.table_name.toLowerCase()));
  const missing = PREREQUISITE_TABLES.filter((t) => !actual.has(t));
  return { ok: missing.length === 0, missing };
}

/**
 * Grandfather-property check the generic column/CHECK deriver cannot express:
 * the column must carry NO column_default (nullable grandfather pattern, same
 * as `tier`/`reality_check`) — never a DEFAULT that would silently backfill
 * every pre-existing row to 'caveman'.
 */
async function checkNoDefault(client) {
  const { rows } = await client.query(
    `SELECT column_default FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = 'assertions' AND column_name = 'authoring_mode'`
  );
  if (rows.length === 0) {
    return { status: 'FAIL', reason: 'assertions.authoring_mode column not found' };
  }
  const hasDefault = rows[0].column_default !== null;
  return {
    status: hasDefault ? 'FAIL' : 'PASS',
    reason: hasDefault
      ? `column_default is "${rows[0].column_default}" — grandfathering requires NO default (existing rows must read NULL, never silently backfilled)`
      : null,
  };
}

async function verifyMigration16(client) {
  const generic = await addenda.verifyAddenda(client, SQL_FILES);
  const noDefault = await checkNoDefault(client);
  const pass = generic.pass && noDefault.status === 'PASS';
  return { generic, noDefault, pass };
}

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

  const { name: target, source } = migrateOne.resolveTargetDb(parsed);

  if (!migrateOne.DB_NAME_RE.test(target)) {
    console.error(`Invalid database name "${target}" (from ${source}) — must match /^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/.`);
    process.exit(1);
  }

  const classification = await migrateOne.classifyTarget({ dbName: target });
  if (!classification.allowed) {
    console.error(`Refused: ${classification.reason}`);
    console.error(`(resolved from ${source} — no database connection was opened.)`);
    process.exit(1);
  }

  console.log(`migrate-16-caveman-addenda: target="${target}" (resolved from ${source})`);

  let sysClient;
  try {
    sysClient = new Client(migrateOne.pgConfig('postgres'));
    await sysClient.connect();
  } catch (err) {
    console.error(`Could not connect to the maintenance database to check target existence: ${err.message}`);
    process.exit(1);
  }

  let exists;
  try {
    exists = await addenda.checkDbExists(sysClient, target);
  } catch (err) {
    await sysClient.end();
    console.error(`Error while checking target database existence: ${err.message}`);
    process.exit(1);
  }
  await sysClient.end();

  if (!exists) {
    console.error(`Refused: target database "${target}" does not exist.`);
    console.error('This runner does not create databases. Run migrate-01-canonical-db.js first, then re-run this script.');
    process.exit(1);
  }

  const db = new Client(migrateOne.pgConfig(target));
  try {
    await db.connect();
  } catch (err) {
    console.error(`Could not connect to target database "${target}": ${err.message}`);
    process.exit(1);
  }

  try {
    const prereq = await checkPrerequisiteTables(db);
    if (!prereq.ok) {
      console.error(`Refused: target "${target}" is missing prerequisite table(s): ${prereq.missing.join(', ')}.`);
      console.error('Run migrate-01-canonical-db.js against this target first, then re-run this script. Nothing was applied.');
      process.exitCode = 1;
      return;
    }

    let applyOk = true;
    try {
      await migrateOne.applySqlFile(db, SQL_FILE);
      console.log(`  [OK]   ${path.relative(path.join(MIGRATIONS_DIR, '..'), SQL_FILE)}`);
    } catch (err) {
      applyOk = false;
      console.log(`  [FAIL] ${path.relative(path.join(MIGRATIONS_DIR, '..'), SQL_FILE)}: ${err.message}`);
    }

    const v = await verifyMigration16(db);

    console.log(`  missing columns: ${v.generic.missingColumns.length ? v.generic.missingColumns.map((c) => `${c.table}.${c.column}`).join(', ') : '(none)'}`);
    console.log(`  wrong-type columns: ${v.generic.wrongTypeColumns.length ? v.generic.wrongTypeColumns.map((c) => `${c.table}.${c.column}`).join(', ') : '(none)'}`);
    console.log(`  missing CHECK constraints: ${v.generic.missingChecks.length ? v.generic.missingChecks.map((c) => `${c.table}.${c.column}`).join(', ') : '(none)'}`);
    console.log(`  authoring_mode grandfather (no default): ${v.noDefault.status}${v.noDefault.reason ? ` -- ${v.noDefault.reason}` : ''}`);

    const pass = applyOk && v.pass;
    console.log(`MIGRATION_RESULT: ${pass ? 'PASS' : 'FAIL'}`);
    process.exitCode = pass ? 0 : 1;
  } finally {
    await db.end();
  }
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
  SQL_FILE,
  SQL_FILES,
  PREREQUISITE_TABLES,
  checkPrerequisiteTables,
  checkNoDefault,
  verifyMigration16,
};
