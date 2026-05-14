'use strict';

/**
 * phase2-schema-apply.js
 *
 * Phase 2 of Bundle A: apply the knowledge-graph + retrieval-infrastructure
 * DDL from scripts/sql/phase2-schema.sql to claude_memory_eval_test.
 *
 * Target: localhost Postgres / claude_memory_eval_test
 *
 * Tables created (all IF NOT EXISTS — idempotent):
 *   retrieval_events, entities, assertions, edges,
 *   retrieval_contract, project_settings
 *
 * Usage:
 *   PGUSER=postgres node scripts/phase2-schema-apply.js [--dry-run] [--quiet]
 *
 * Flags:
 *   --dry-run  Print the SQL and planned DB target; no connection or apply.
 *   --quiet    Suppress per-step logging; errors still go to stderr.
 *
 * Exit codes: 0 success, 1 any error or missing table after apply.
 *
 * Plan reference: BUNDLE-A-SPEC.md v5 Section 4
 */

const fs     = require('fs');
const path   = require('path');
const { Client } = require('pg');

const { loadConfig } = require('./lib/shared');

// ─── ARGUMENT PARSING ────────────────────────────────────────────────────────

const args   = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const quiet  = args.includes('--quiet');

const log = (...a) => { if (!quiet) console.log(...a); };

// ─── CONSTANTS ───────────────────────────────────────────────────────────────

const TARGET_DB     = 'claude_memory_eval_test';
const SQL_FILE      = path.resolve(__dirname, 'sql', 'phase2-schema.sql');
const EXPECTED_TABLES = [
  'retrieval_events',
  'entities',
  'assertions',
  'edges',
  'retrieval_contract',
  'project_settings',
];

// ─── HELPERS ─────────────────────────────────────────────────────────────────

function connectTo(database, baseConfig) {
  const client = new Client({
    host:     baseConfig.host,
    port:     baseConfig.port,
    user:     baseConfig.user,
    database,
  });
  return client.connect().then(() => client);
}

// ─── MAIN ────────────────────────────────────────────────────────────────────

async function main() {
  let sql;
  try {
    sql = fs.readFileSync(SQL_FILE, 'utf8');
  } catch (err) {
    console.error(`Failed to read SQL file ${SQL_FILE}: ${err.message}`);
    process.exit(1);
  }

  if (dryRun) {
    log('─── phase2-schema-apply (dry-run) ───────────────────────────────────────────');
    log(`  SQL file:  ${SQL_FILE}`);
    log(`  Target DB: ${TARGET_DB} (no connection will be made)`);
    log('');
    log('─── SQL to be applied ───────────────────────────────────────────────────────');
    log(sql);
    log('─────────────────────────────────────────────────────────────────────────────');
    log('  (dry-run: no DB writes performed)');
    process.exit(0);
  }

  let config;
  try {
    config = loadConfig();
  } catch (err) {
    console.error(`Config load failed: ${err.message}`);
    process.exit(1);
  }

  let db;
  try {
    db = await connectTo(TARGET_DB, config);
  } catch (err) {
    console.error(`DB connection failed (${TARGET_DB}): ${err.message}`);
    process.exit(1);
  }

  log('─── phase2-schema-apply ─────────────────────────────────────────────────────');
  log(`  Target DB: ${TARGET_DB}`);
  log(`  SQL file:  ${SQL_FILE}`);
  log('  Applying DDL inside a single transaction...');

  let errors = 0;

  try {
    await db.query('BEGIN');
    await db.query(sql);
    await db.query('COMMIT');
    log('  DDL committed.');
  } catch (err) {
    await db.query('ROLLBACK').catch(() => {});
    console.error(`DDL apply failed — rolled back: ${err.message}`);
    await db.end().catch(() => {});
    process.exit(1);
  }

  // ── Verification ─────────────────────────────────────────────────────────────

  log('');
  log('─── verification ────────────────────────────────────────────────────────────');

  let presentTables;
  try {
    const tableRes = await db.query(
      `SELECT table_name
       FROM information_schema.tables
       WHERE table_schema = current_schema()
         AND table_name = ANY($1::text[])`,
      [EXPECTED_TABLES]
    );
    presentTables = new Set(tableRes.rows.map(r => r.table_name));
  } catch (err) {
    console.error(`Table existence check failed: ${err.message}`);
    await db.end().catch(() => {});
    process.exit(1);
  }

  let halfvecType = null;
  try {
    const colRes = await db.query(
      `SELECT data_type, udt_name
       FROM information_schema.columns
       WHERE table_schema = current_schema()
         AND table_name   = 'retrieval_events'
         AND column_name  = 'query_embedding'`
    );
    if (colRes.rows.length > 0) {
      halfvecType = colRes.rows[0].udt_name;
    }
  } catch (err) {
    console.error(`Column type check failed: ${err.message}`);
    errors++;
  }

  log('');
  log('  table                | rows | status');
  log('  ─────────────────────┼──────┼────────────');

  for (const tbl of EXPECTED_TABLES) {
    if (!presentTables.has(tbl)) {
      console.error(`  ${tbl.padEnd(20)} | n/a  | MISSING`);
      errors++;
      continue;
    }

    let rowCount = 'n/a';
    try {
      const cntRes = await db.query(`SELECT COUNT(*) AS n FROM ${tbl}`);
      rowCount = cntRes.rows[0].n;
    } catch (err) {
      console.error(`  ${tbl.padEnd(20)} | err  | COUNT failed: ${err.message}`);
      errors++;
      continue;
    }

    const rowStr = String(rowCount).padStart(4);
    log(`  ${tbl.padEnd(20)} | ${rowStr} | OK`);
  }

  log('');

  if (halfvecType !== null) {
    if (halfvecType === 'halfvec') {
      log(`  retrieval_events.query_embedding udt_name: ${halfvecType} — PASS`);
    } else {
      console.error(`  retrieval_events.query_embedding udt_name: ${halfvecType} — FAIL (expected halfvec)`);
      errors++;
    }
  } else {
    console.error('  retrieval_events.query_embedding: column not found — FAIL');
    errors++;
  }

  await db.end().catch(() => {});

  log('');
  log('─────────────────────────────────────────────────────────────────────────────');

  process.exit(errors > 0 ? 1 : 0);
}

main().catch(err => {
  console.error(`Unhandled error: ${err.message}`);
  process.exit(1);
});
