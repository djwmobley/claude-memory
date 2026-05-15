'use strict';

/**
 * phase3b-schema-apply.js
 *
 * Phase 3b of Bundle A: add the blurb column to memory_entry_chunks.
 *
 * Applies scripts/sql/phase3b-schema.sql to claude_memory_eval_test.
 * The DDL uses ADD COLUMN IF NOT EXISTS — safe to rerun.
 *
 * Usage:
 *   PGUSER=postgres node scripts/phase3b-schema-apply.js [--dry-run] [--quiet]
 *
 * Flags:
 *   --dry-run  Print the SQL and planned DB target; no connection or apply.
 *   --quiet    Suppress per-step logging; errors still go to stderr.
 *
 * Exit codes: 0 success, 1 any error or column missing after apply.
 */

const fs   = require('fs');
const path = require('path');
const { Client } = require('pg');

const { loadConfig } = require('./lib/shared');

// ─── ARGUMENT PARSING ────────────────────────────────────────────────────────

const args   = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const quiet  = args.includes('--quiet');

const log = (...a) => { if (!quiet) console.log(...a); };

// ─── CONSTANTS ───────────────────────────────────────────────────────────────

const TARGET_DB = 'claude_memory_eval_test';
const SQL_FILE  = path.resolve(__dirname, 'sql', 'phase3b-schema.sql');

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
    log('─── phase3b-schema-apply (dry-run) ──────────────────────────────────────────');
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

  log('─── phase3b-schema-apply ────────────────────────────────────────────────────');
  log(`  Target DB: ${TARGET_DB}`);
  log(`  SQL file:  ${SQL_FILE}`);
  log('  Applying DDL inside a single transaction...');

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

  let errors = 0;

  try {
    const colRes = await db.query(
      `SELECT column_name
       FROM information_schema.columns
       WHERE table_schema = current_schema()
         AND table_name   = 'memory_entry_chunks'
         AND column_name  = 'blurb'`
    );

    if (colRes.rows.length > 0) {
      log('  memory_entry_chunks.blurb column: PASS');
    } else {
      console.error('  memory_entry_chunks.blurb column: FAIL (not found after apply)');
      errors++;
    }
  } catch (err) {
    console.error(`  Column check failed: ${err.message}`);
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
