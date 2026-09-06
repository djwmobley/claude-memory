'use strict';

/**
 * migrate-15-mcp-addenda.js
 *
 * Applies scripts/migrations/sql/migrate-15-mcp-addenda.sql (§8 schema
 * addenda prerequisites for the generalized MCP tool surface —
 * CONSOLIDATION-RUNBOOK.md §8, M-1/M-4/M-12/M-13/M-15, memory-manager#18)
 * against a migrate-01 + migrate-schema-addenda + migrate-14-seam-tables
 * target.
 *
 * WHY A SEPARATE FILE/RUNNER, NOT FOLDED INTO migrate-schema-addenda.js: a
 * concurrent migrate-02 PR bundles the IDENTICAL idempotent
 * decisions_project_topic_unique statement (same name, same definition) —
 * see the .sql file's own header comment. Keeping this addendum in its own
 * runner avoids a merge collision on migrate-schema-addenda.js's shared
 * SQL_FILES array while both PRs still converge to the SAME live schema
 * regardless of merge order (CREATE UNIQUE INDEX IF NOT EXISTS is a proven
 * no-op on re-apply).
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
 *   3. Confirms prerequisite tables (entities, edges, retrieval_contract,
 *      decisions) already exist — a missing prerequisite is a hard,
 *      up-front refusal, nothing applied.
 *   4. Applies the one SQL file via migrate-01's own applySqlFile.
 *   5. Verifies the result in two layers:
 *        (a) GENERIC derived verification (migrate-schema-addenda.js's
 *            exported deriveSchemaAddenda/verifyAddenda, reused by
 *            reference) against THIS file: the kind column + its CHECK
 *            constraint, and both suppressed columns — all three fit the
 *            "ALTER TABLE ... ADD COLUMN IF NOT EXISTS" shape the generic
 *            deriver already parses.
 *        (b) TARGETED checks the generic layer cannot express: neither
 *            `CREATE INDEX IF NOT EXISTS ... ON <table> USING gin (...)`
 *            (entities_name_trgm_idx) nor `CREATE UNIQUE INDEX IF NOT
 *            EXISTS ...` (decisions_project_topic_unique) matches the
 *            generic deriver's index regex (which only recognizes the
 *            plain `CREATE INDEX IF NOT EXISTS <name> ON <table> (<cols>)`
 *            shape) — verified here via direct pg_indexes lookups, mirroring
 *            migrate-13-agent-exchange.js's D-3 checkHnswIndex pattern.
 *
 * Usage:
 *   node scripts/migrations/migrate-15-mcp-addenda.js [--db <name>]
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
const SQL_FILE = path.join(SQL_DIR, 'migrate-15-mcp-addenda.sql');
const SQL_FILES = [SQL_FILE];

const PREREQUISITE_TABLES = ['entities', 'edges', 'retrieval_contract', 'decisions'];

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
    'Usage: node scripts/migrations/migrate-15-mcp-addenda.js [--db <name>]',
    '',
    '  --db <name>  Target database name (else MIGRATE_TARGET_DB env, else',
    '               memory_manager_staging). Never reads HANDOFF_DB. The',
    '               target database must already exist and already carry',
    '               entities/edges/retrieval_contract/decisions.',
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

/** Targeted index checks the generic deriver cannot express (see header). */
async function checkIndexByName(client, indexName, table) {
  const { rows } = await client.query(
    `SELECT indexdef FROM pg_indexes WHERE schemaname = current_schema() AND indexname = $1`,
    [indexName]
  );
  if (rows.length === 0) {
    return { name: indexName, status: 'FAIL', reason: `${indexName} is missing` };
  }
  const def = rows[0].indexdef;
  const ok = new RegExp(`\\bON\\s+(public\\.)?${table}\\b`, 'i').test(def);
  return { name: indexName, status: ok ? 'PASS' : 'FAIL', reason: ok ? null : `indexdef does not target ${table}: ${def}`, indexdef: def };
}

async function verifyMigration15(client) {
  const generic = await addenda.verifyAddenda(client, SQL_FILES);
  const trgmIdx = await checkIndexByName(client, 'entities_name_trgm_idx', 'entities');
  const decisionsUnique = await checkIndexByName(client, 'decisions_project_topic_unique', 'decisions');

  const pass = generic.pass && trgmIdx.status === 'PASS' && decisionsUnique.status === 'PASS';
  return { generic, trgmIdx, decisionsUnique, pass };
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

  console.log(`migrate-15-mcp-addenda: target="${target}" (resolved from ${source})`);

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
      console.error('Run migrate-01-canonical-db.js / migrate-14-seam-tables.js against this target first, then re-run this script. Nothing was applied.');
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

    const v = await verifyMigration15(db);

    console.log(`  missing columns: ${v.generic.missingColumns.length ? v.generic.missingColumns.map((c) => `${c.table}.${c.column}`).join(', ') : '(none)'}`);
    console.log(`  wrong-type columns: ${v.generic.wrongTypeColumns.length ? v.generic.wrongTypeColumns.map((c) => `${c.table}.${c.column}`).join(', ') : '(none)'}`);
    console.log(`  missing CHECK constraints: ${v.generic.missingChecks.length ? v.generic.missingChecks.map((c) => `${c.table}.${c.column}`).join(', ') : '(none)'}`);
    console.log(`  entities_name_trgm_idx: ${v.trgmIdx.status}${v.trgmIdx.reason ? ` -- ${v.trgmIdx.reason}` : ''}`);
    console.log(`  decisions_project_topic_unique: ${v.decisionsUnique.status}${v.decisionsUnique.reason ? ` -- ${v.decisionsUnique.reason}` : ''}`);

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
  checkIndexByName,
  verifyMigration15,
};
