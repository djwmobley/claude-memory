'use strict';

/**
 * test-degraded-close-retention.js — Focused unit tests for pruneDegradedClose().
 *
 * Exercises the keep-most-recent-100 retention policy in isolation — no full
 * close path, no retrieval_events table required.
 *
 * Coverage:
 *   D1  110 seeded records → 100 remain; 10 oldest deleted (Postgres).
 *   D2  The 10 deleted records are the 10 with the lowest key values (oldest).
 *   D3  2 seeded records → both retained; prune is a no-op (< 100 limit).
 *   D4  Same as D1–D3 on SQLite backend.
 *   D5  custom keep=5: 8 seeded → 5 newest retained; 3 oldest deleted.
 *
 * Usage:
 *   node test/handoff/test-degraded-close-retention.js
 *
 * Postgres: PGHOST/PGUSER/PGPASSWORD env (default localhost/postgres/postgres).
 * SQLite:   built-in node:sqlite (Node >= 22).
 * Exit 0 = all tests passed. Exit 1 = any failure.
 */

const assert = require('assert');
const path   = require('path');
const os     = require('os');
const fs     = require('fs');

const { createRequire } = require('module');
const scriptsRequire    = createRequire(
  require.resolve(path.resolve(__dirname, '..', '..', 'scripts', 'package.json'))
);

const { pruneDegradedClose } = require('../../scripts/handoff');
const {
  createAdapter,
  resolveDialect,
  SQLiteAdapter,
  PostgresAdapter,
} = require('../../scripts/lib/db-seam');

// ─── counters ────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

async function test(label, fn) {
  try {
    await fn();
    console.log(`PASS  ${label}`);
    passed++;
  } catch (err) {
    console.error(`FAIL  ${label}`);
    console.error(`      ${err.message}`);
    if (process.env.DEBUG) console.error(err.stack);
    failed++;
  }
}

// ─── DB bootstrap helpers ────────────────────────────────────────────────────

const SCHEMA_SQLITE = path.resolve(
  __dirname, '..', '..', 'scripts', 'sql', 'handoff-sqlite-schema.sql'
);
const SCHEMA_CORE = path.resolve(
  __dirname, '..', '..', 'scripts', 'sql', 'handoff-core-schema.sql'
);

/** Create an in-memory SQLiteAdapter with the project_settings table present. */
async function makeSqliteDb() {
  const db = new SQLiteAdapter(':memory:');
  await db.connect();
  // Apply minimal schema — project_settings table only.
  const sql = fs.readFileSync(SCHEMA_SQLITE, 'utf8');
  await db.runSchema(sql);
  return db;
}

/** Connect to Postgres test DB and ensure project_settings table exists. */
async function makePgDb() {
  const { Client } = scriptsRequire('pg');
  const cfg = {
    host:     process.env.PGHOST     || 'localhost',
    port:     parseInt(process.env.PGPORT || '5432', 10),
    user:     process.env.PGUSER     || 'postgres',
    password: process.env.PGPASSWORD || 'postgres',
    database: process.env.PGDATABASE || 'claude_memory_eval_test',
  };
  const client = new Client(cfg);
  await client.connect();

  // Wrap in PostgresAdapter-compatible shape (has .query).
  // Apply minimal schema idempotently.
  let sql = fs.readFileSync(SCHEMA_CORE, 'utf8');
  sql = sql.replace(/^\\[a-z].*$/gm, ''); // strip psql meta-commands
  try { await client.query(sql); } catch (e) {
    if (!e.message.includes('already exists')) throw e;
  }
  return client;
}

// ─── seed / query helpers ────────────────────────────────────────────────────

/**
 * Seed N degraded_close records with ascending ISO-stamp keys.
 * Returns array of seeded key strings, oldest first.
 */
async function seedRecords(db, projectId, count) {
  const keys = [];
  for (let i = 0; i < count; i++) {
    const d = new Date('2020-01-01T00:00:00.000Z');
    d.setUTCDate(d.getUTCDate() + i);
    const stamp = d.toISOString();
    const key   = `degraded_close:${stamp}:${String(i).padStart(4, '0')}`;
    keys.push(key);
    await db.query(
      `INSERT INTO project_settings (project_id, key, value)
       VALUES ($1, $2, $3)
       ON CONFLICT (project_id, key) DO UPDATE SET value = EXCLUDED.value`,
      [projectId, key, JSON.stringify({ subsystem: 'C2', reason: `seed-${i}` })]
    );
  }
  return keys;
}

async function countRemaining(db, projectId) {
  const { rows } = await db.query(
    `SELECT key FROM project_settings
     WHERE project_id = $1 AND key LIKE 'degraded_close:%'
     ORDER BY key`,
    [projectId]
  );
  return rows.map((r) => r.key);
}

async function keyExists(db, projectId, key) {
  const { rows } = await db.query(
    `SELECT key FROM project_settings WHERE project_id = $1 AND key = $2`,
    [projectId, key]
  );
  return rows.length > 0;
}

/** Unique project id per test run to avoid cross-test pollution. */
let _seq = 0;
function freshProjectId() {
  return `test-retention-${Date.now()}-${++_seq}`;
}

/** Delete all project_settings rows for a project id (cleanup). */
async function cleanProject(db, projectId) {
  try {
    await db.query(
      `DELETE FROM project_settings WHERE project_id = $1`,
      [projectId]
    );
  } catch (_) {}
}

// ─── test suite (backend-agnostic) ───────────────────────────────────────────

async function runSuite(label, db) {
  // D1/D4: 110 seeded → 100 remain.
  await test(`${label} D1: 110 seeded → 100 remain after prune`, async () => {
    const projectId = freshProjectId();
    try {
      await seedRecords(db, projectId, 110);
      await pruneDegradedClose(db, projectId, 100);
      const remaining = await countRemaining(db, projectId);
      assert.strictEqual(remaining.length, 100,
        `Expected 100 records, got ${remaining.length}`);
    } finally {
      await cleanProject(db, projectId);
    }
  });

  // D2/D4: The 10 deleted are the 10 with the lowest key values (oldest).
  await test(`${label} D2: 10 oldest deleted; 100 newest retained`, async () => {
    const projectId = freshProjectId();
    try {
      const keys = await seedRecords(db, projectId, 110);
      await pruneDegradedClose(db, projectId, 100);

      // keys[0..9] — oldest — must be gone.
      for (let i = 0; i < 10; i++) {
        const exists = await keyExists(db, projectId, keys[i]);
        assert.ok(!exists, `Expected key '${keys[i]}' to be deleted (rank ${i}), but it still exists`);
      }

      // keys[10..109] — newest — must be present.
      for (let i = 10; i < 110; i++) {
        const exists = await keyExists(db, projectId, keys[i]);
        assert.ok(exists, `Expected key '${keys[i]}' to be retained (rank ${i}), but it was deleted`);
      }
    } finally {
      await cleanProject(db, projectId);
    }
  });

  // D3/D4: 2 seeded → both retained; prune is a no-op.
  await test(`${label} D3: 2 seeded → both retained (no-op, under 100 limit)`, async () => {
    const projectId = freshProjectId();
    try {
      const keys = await seedRecords(db, projectId, 2);
      await pruneDegradedClose(db, projectId, 100);
      const remaining = await countRemaining(db, projectId);
      assert.strictEqual(remaining.length, 2,
        `Expected 2 records (no-op prune), got ${remaining.length}`);
      for (const key of keys) {
        const exists = await keyExists(db, projectId, key);
        assert.ok(exists, `Expected key '${key}' to be retained but it was deleted`);
      }
    } finally {
      await cleanProject(db, projectId);
    }
  });

  // D5: custom keep=5: 8 seeded → 5 newest retained; 3 oldest deleted.
  await test(`${label} D5: keep=5: 8 seeded → 5 newest retained, 3 oldest deleted`, async () => {
    const projectId = freshProjectId();
    try {
      const keys = await seedRecords(db, projectId, 8);
      await pruneDegradedClose(db, projectId, 5);
      const remaining = await countRemaining(db, projectId);
      assert.strictEqual(remaining.length, 5,
        `Expected 5 records, got ${remaining.length}`);
      // Oldest 3 (keys[0..2]) must be gone.
      for (let i = 0; i < 3; i++) {
        const exists = await keyExists(db, projectId, keys[i]);
        assert.ok(!exists, `Expected key '${keys[i]}' to be deleted, but it still exists`);
      }
      // Newest 5 (keys[3..7]) must remain.
      for (let i = 3; i < 8; i++) {
        const exists = await keyExists(db, projectId, keys[i]);
        assert.ok(exists, `Expected key '${keys[i]}' to be retained, but it was deleted`);
      }
    } finally {
      await cleanProject(db, projectId);
    }
  });
}

// ─── main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log('=== degraded_close retention unit tests ===\n');

  // ── Postgres backend ──
  let pgDb = null;
  let pgSkipped = false;
  try {
    pgDb = await makePgDb();
  } catch (err) {
    console.warn(`[SKIP] Postgres unavailable (${err.message}); skipping PG arms.`);
    pgSkipped = true;
  }

  if (!pgSkipped && pgDb) {
    console.log('--- Postgres ---');
    await runSuite('PG', pgDb);
    try { await pgDb.end(); } catch (_) {}
  }

  // ── SQLite backend ──
  let sqliteDb = null;
  let sqliteSkipped = false;
  try {
    sqliteDb = await makeSqliteDb();
  } catch (err) {
    console.warn(`[SKIP] SQLite unavailable (${err.message}); skipping SQLite arms.`);
    sqliteSkipped = true;
  }

  if (!sqliteSkipped && sqliteDb) {
    console.log('\n--- SQLite ---');
    await runSuite('SQLite', sqliteDb);
    try { await sqliteDb.end(); } catch (_) {}
  }

  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) {
    process.exit(1);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error(`[FATAL] ${err.message}`);
  if (process.env.DEBUG) console.error(err.stack);
  process.exit(1);
});
