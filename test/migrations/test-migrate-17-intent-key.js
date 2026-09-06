'use strict';

/**
 * test-migrate-17-intent-key.js — DB integration test harness for
 * scripts/migrations/migrate-17-intent-key.js (cm#233: one-time re-key of
 * live open_thread rows from the removed deriveIntentSubject derivation to
 * intentKey).
 *
 * Creates its own throwaway Postgres scratch database (never
 * claude_memory_eval_test / memory_manager / memory_manager_staging / any
 * pipeline_* DB), applies handoff-core-schema.sql, and drops it on exit —
 * matching test-migrate-08-handoff-markdown.js's own convention.
 *
 * Covers:
 *   T1  --dry-run (default): plan is computed and printed but NO row is
 *       mutated (subject unchanged, no suppression, no new row).
 *   T2  --write (single row, no collision): old row superseded by id
 *       (never an UPDATE of its subject column), exactly one successor row
 *       inserted with subject=intentKey(object).
 *   T3  Idempotent: a second --write run over the same data reports
 *       changed=0, collisions=0, and does not touch row counts again.
 *   T4  Collision: two live rows whose objects intentKey to the SAME key
 *       (case-insensitively) — winner is the row with the latest
 *       last_reinforced; BOTH old rows are superseded; exactly ONE
 *       successor row is written using the winner's object/confidence/
 *       source; the collision is printed.
 *
 * Usage: node test/migrations/test-migrate-17-intent-key.js
 * Requires Postgres (PGHOST/PGUSER/PGPASSWORD — CI defaults to
 * localhost/postgres/postgres). Skips (exit 0) if Postgres is unavailable.
 */

const path = require('path');
const crypto = require('crypto');
const PROJECT_ROOT = path.resolve(__dirname, '..', '..');

const { PostgresAdapter } = require(path.join(PROJECT_ROOT, 'scripts', 'lib', 'db-seam.js'));
const {
  pgConnect, createTestDb, dropTestDb, applySchema,
} = require(path.join(PROJECT_ROOT, 'scripts', 'lib', 'test-pg-helpers.js'));
const { migrateIntentKeys } = require(path.join(PROJECT_ROOT, 'scripts', 'migrations', 'migrate-17-intent-key.js'));
const { intentKey } = require(path.join(PROJECT_ROOT, 'scripts', 'lib', 'intent-key.js'));

const DB_NAME = `intent_key_migration_test_${Date.now()}`;
const PROJECT_DIR = path.join(require('os').tmpdir(), `intent-key-migration-test-${Date.now()}`);

let passed = 0, failed = 0;
async function run(id, label, fn) {
  try {
    await fn();
    console.log(`  [PASS] ${id} ${label}`);
    passed++;
  } catch (err) {
    console.error(`  [FAIL] ${id} ${label}: ${err.message}`);
    if (process.env.DEBUG) console.error(err.stack);
    failed++;
  }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }
function assertEqual(actual, expected, msg) {
  if (actual !== expected) throw new Error(`${msg || 'assertEqual'}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

function freshPid(prefix) {
  return `${prefix}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
}

async function insertOpenThread(db, projectId, { subject, object, lastReinforced, confidence = 7, source = 'user_stated' }) {
  const { rows } = await db.query(
    `INSERT INTO assertions (project_id, subject, predicate, object, confidence, source, last_reinforced)
     VALUES ($1, $2, 'open_thread', $3, $4, $5, $6)
     RETURNING id`,
    [projectId, subject, object, confidence, source, lastReinforced || new Date()]
  );
  return rows[0].id;
}

async function liveOpenThreadRows(db, projectId) {
  const { rows } = await db.query(
    `SELECT id, subject, object, suppressed, invalid_at, suppression_kind
     FROM assertions
     WHERE project_id = $1 AND predicate = 'open_thread'
     ORDER BY id ASC`,
    [projectId]
  );
  return rows;
}

async function main() {
  let dbAvailable = true;
  try {
    const probe = await pgConnect('postgres');
    await probe.end();
  } catch (_) {
    dbAvailable = false;
  }
  if (!dbAvailable) {
    console.log('[SKIP] Postgres unavailable — test-migrate-17-intent-key.js skipped entirely.');
    process.exit(0);
  }

  await createTestDb(DB_NAME, PROJECT_DIR);
  await applySchema(DB_NAME);
  const pgClient = await pgConnect(DB_NAME);
  const db = new PostgresAdapter(pgClient);

  try {
    // ── T1: --dry-run (default) — no mutation ────────────────────────────
    await run('T1', '--dry-run (default): plan computed, zero mutation', async () => {
      const pid = freshPid('t1');
      // NO colon anywhere -- exercises the actual cm#233 regression (the old
      // 80-char-truncation-style subject vs. the new whitespace-collapsed
      // full-text key), not the (now correctly preserved) colon-key path.
      const oldSubject = 'OLD-STYLE-80-CHAR-TRUNCATED-SUBJECT-FROM-BEFORE-THIS-MIGRATION-EVER-RAN-XY';
      const objectText = 'finish the thing\nwith a newline that the old truncation style never normalized';
      await insertOpenThread(db, pid, { subject: oldSubject, object: objectText });

      const result = await migrateIntentKeys(db, pid, { dryRun: true });
      assertEqual(result.dryRun, true, 'T1: result.dryRun must be true');
      assertEqual(result.changed, 0, 'T1: dry-run must report changed=0');
      assertEqual(result.plan.singles.length, 1, 'T1: plan must identify exactly one row needing rekey');

      const rows = await liveOpenThreadRows(db, pid);
      assertEqual(rows.length, 1, 'T1: still exactly one row (no insert happened)');
      assertEqual(rows[0].subject, oldSubject, 'T1: subject column must be UNCHANGED after dry-run');
      assertFalseVal(rows[0].suppressed, 'T1: row must not be suppressed after dry-run');
    });

    // ── T2: --write, single row, no collision ────────────────────────────
    let t2Pid;
    await run('T2', '--write (no collision): old row superseded by id, one successor inserted with subject=intentKey(object)', async () => {
      t2Pid = freshPid('t2');
      // NO colon -- see T1's comment for why the fixture avoids the (now
      // correctly preserved) colon-key path.
      const oldSubject = 'LEGACY-80-CHAR-TRUNCATED-SUBJECT-NO-COLON-HERE-JUST-A-LONG-OLD-STYLE-KEY-ZZ';
      const objectText = 'finish   the   thing'; // extra interior whitespace — intentKey collapses it
      const oldId = await insertOpenThread(db, t2Pid, { subject: oldSubject, object: objectText });

      const result = await migrateIntentKeys(db, t2Pid, { dryRun: false });
      assertEqual(result.dryRun, false, 'T2: result.dryRun must be false');
      assertEqual(result.changed, 1, 'T2: exactly one row changed');
      assertEqual(result.collisions, 0, 'T2: zero collisions');

      const rows = await liveOpenThreadRows(db, t2Pid);
      assertEqual(rows.length, 2, 'T2: old row (suppressed) + one new successor row = 2 total rows');
      const oldRow = rows.find((r) => r.id === oldId);
      assert(oldRow, 'T2: old row must still exist');
      assertEqual(oldRow.subject, oldSubject, 'T2: old row subject column must NEVER be updated');
      assertTrueVal(oldRow.suppressed, 'T2: old row must be suppressed');
      assertEqual(oldRow.suppression_kind, 'superseded', 'T2: old row suppression_kind must be superseded');
      assert(oldRow.invalid_at !== null, 'T2: old row invalid_at must be set');

      const newRow = rows.find((r) => r.id !== oldId);
      assert(newRow, 'T2: a new successor row must exist');
      assertFalseVal(newRow.suppressed, 'T2: new row must be live');
      const expectedKey = intentKey(objectText);
      assert(
        newRow.subject.toLowerCase() === expectedKey.toLowerCase(),
        `T2: new row subject "${newRow.subject}" must match intentKey(object) "${expectedKey}" (case-insensitively — writeAssertionWithSupersession's own canonicalize() lowercases on store)`
      );
    });

    // ── T3: idempotent — second --write run reports 0 changes ───────────
    await run('T3', 'idempotent: a second --write run over the same project reports changed=0, collisions=0', async () => {
      const result = await migrateIntentKeys(db, t2Pid, { dryRun: false });
      assertEqual(result.changed, 0, 'T3: second --write run must report changed=0');
      assertEqual(result.collisions, 0, 'T3: second --write run must report collisions=0');
      const rows = await liveOpenThreadRows(db, t2Pid);
      assertEqual(rows.length, 2, 'T3: row count must be unchanged by the idempotent re-run');
    });

    // ── T4: collision — two live rows key identically (case-insensitive) ─
    await run('T4', 'collision: two live rows with the same case-insensitive key — latest last_reinforced wins, both superseded, ONE successor written', async () => {
      const pid = freshPid('t4');
      const older = new Date(Date.now() - 60 * 60 * 1000); // 1 hour ago
      const newer = new Date();
      const idOlder = await insertOpenThread(db, pid, {
        subject: 'COLLIDE-A', object: 'Ship the migration', lastReinforced: older, confidence: 6,
      });
      const idNewer = await insertOpenThread(db, pid, {
        subject: 'COLLIDE-B', object: 'ship   the   migration', lastReinforced: newer, confidence: 8,
      });
      // Sanity: both objects must intentKey-equal (case-insensitively) but
      // NOT be byte-identical (proves this is a genuine collision, not a
      // duplicate-payload artifact).
      assert(intentKey('Ship the migration').toLowerCase() === intentKey('ship   the   migration').toLowerCase(),
        'T4 sanity: the two object texts must key identically (case-insensitive)');

      const result = await migrateIntentKeys(db, pid, { dryRun: false });
      assertEqual(result.collisions, 1, 'T4: exactly one collision group');
      assertEqual(result.changed, 2, 'T4: both rows in the collision group count as changed');

      const rows = await liveOpenThreadRows(db, pid);
      assertEqual(rows.length, 3, 'T4: 2 old (suppressed) + 1 new successor = 3 total rows');
      const oldA = rows.find((r) => r.id === idOlder);
      const oldB = rows.find((r) => r.id === idNewer);
      assertTrueVal(oldA.suppressed, 'T4: older row must be suppressed');
      assertTrueVal(oldB.suppressed, 'T4: newer row must ALSO be suppressed (winner is not exempt from supersession-by-id)');
      assertEqual(oldA.subject, 'COLLIDE-A', 'T4: old row A subject column never updated');
      assertEqual(oldB.subject, 'COLLIDE-B', 'T4: old row B subject column never updated');

      const successor = rows.find((r) => r.id !== idOlder && r.id !== idNewer);
      assert(successor, 'T4: exactly one successor row must exist');
      assertFalseVal(successor.suppressed, 'T4: successor row must be live');
      // Winner is the row with the LATEST last_reinforced (idNewer, object "ship   the   migration").
      assertEqual(successor.object, 'ship   the   migration', 'T4: successor object must come from the winner (latest last_reinforced)');
    });

    // ── T5: silent:true suppresses ALL console.log, even when rows change ──
    await run('T5', 'silent:true suppresses ALL stdout, even with a non-empty plan (fix-round stdout-pollution finding)', async () => {
      const pid = freshPid('t5');
      await insertOpenThread(db, pid, { subject: 'OLD-NO-COLON-XYZ', object: 'a fresh unkeyed thread with no colon at all' });
      const origLog = console.log;
      const captured = [];
      console.log = (...args) => { captured.push(args.join(' ')); };
      let result;
      try {
        result = await migrateIntentKeys(db, pid, { dryRun: false, silent: true });
      } finally {
        console.log = origLog;
      }
      assertEqual(captured.length, 0, `T5: silent:true must produce ZERO console.log calls, got ${captured.length}: ${JSON.stringify(captured)}`);
      assertEqual(result.changed, 1, 'T5: the migration still actually ran (silent only affects stdout, not behavior)');
    });

    // ── T6: a zero-change plan collapses to ONE summary line even when NOT silent ──
    await run('T6', 'non-silent CLI mode: a zero-change plan prints exactly ONE summary line, never the full per-row report', async () => {
      const pid = freshPid('t6');
      // No rows at all for this project -- guaranteed zero-change plan.
      const origLog = console.log;
      const captured = [];
      console.log = (...args) => { captured.push(args.join(' ')); };
      try {
        await migrateIntentKeys(db, pid, { dryRun: true }); // silent NOT passed (default false)
      } finally {
        console.log = origLog;
      }
      assertEqual(captured.length, 1, `T6: expected exactly one summary line, got ${captured.length}: ${JSON.stringify(captured)}`);
      assert(captured[0].includes('0 need rekeying'), `T6: summary line must say "0 need rekeying", got: ${captured[0]}`);
    });

  } finally {
    try { await pgClient.end(); } catch (_) {}
    await dropTestDb(DB_NAME, PROJECT_DIR);
  }

  console.log(`\ntest-migrate-17-intent-key: ${passed} passed, ${failed} failed`);
  process.exitCode = failed > 0 ? 1 : 0;
}

function assertTrueVal(v, msg) { if (!(v === true || v === 1)) throw new Error(msg || `expected true/1, got ${JSON.stringify(v)}`); }
function assertFalseVal(v, msg) { if (!(v === false || v === 0)) throw new Error(msg || `expected false/0, got ${JSON.stringify(v)}`); }

main().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exitCode = 1;
});
