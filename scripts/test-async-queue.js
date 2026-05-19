'use strict';

/**
 * test-async-queue.js — Tests for the async extraction queue state machine.
 *
 * Exercises the queue paths in scripts/handoff.js via spawnSync subprocesses
 * that drive cmdCheckpoint (enqueue path) and cmdQueueDrain (drain path), with
 * direct DB inspection to verify state transitions.
 *
 * Coverage:
 *   T1  Enqueue creates a pending row in extraction_queue (extraction_async_enabled=true)
 *   T2  Queue-drain processes pending→done; row is marked 'done' after drain
 *   T3  Session_id drain corner: payload.session_id absent AND session_in_progress
 *       already cleared before drain — documented L4-degraded behavior; no crash,
 *       not a silent corrupt write (entities/assertions still written with null sessionId)
 *   T4  Idempotent re-drain: a 'done' row is not re-processed on second drain call
 *   T5  Drain with empty queue: clean no-op, exit 0, no rows mutated
 *
 * Uses a throwaway Postgres DB. Requires PGHOST/PGUSER/PGPASSWORD or defaults to
 * localhost/postgres/postgres.
 *
 * Usage:
 *   node scripts/test-async-queue.js
 *
 * Exit 0 = all tests passed (or Postgres unavailable — skip). Exit 1 = any failure.
 */

const { spawnSync } = require('child_process');
const fs   = require('fs');
const os   = require('os');
const path = require('path');
const { Client } = require('pg');

// ── Constants ──────────────────────────────────────────────────────────────────

const PROJECT_ROOT   = path.resolve(__dirname, '..');
const HANDOFF_SCRIPT = path.join(PROJECT_ROOT, 'scripts', 'handoff.js');
const TS             = Date.now();
const AQ_DB          = `claude_memory_aq_test_${TS}`;
const SCHEMA_FILE    = path.join(PROJECT_ROOT, 'scripts', 'sql', 'handoff-core-schema.sql');

// Use os.tmpdir()+path.join — never hardcode /tmp or POSIX-only paths.
const TEMP_DIR = path.join(os.tmpdir(), `handoff_aq_${TS}`);

// ── Tracking ───────────────────────────────────────────────────────────────────

let passed  = 0;
let failed  = 0;
const failures = [];

function pass(label)         { console.log(`PASS  ${label}`); passed++; }
function fail(label, reason) { console.log(`FAIL  ${label}: ${reason}`); failures.push({ label, reason }); failed++; }

// ── Helpers ────────────────────────────────────────────────────────────────────

async function pgConnect(database) {
  const cfg = {
    host:     process.env.PGHOST     || 'localhost',
    port:     parseInt(process.env.PGPORT || '5432', 10),
    user:     process.env.PGUSER     || 'postgres',
    password: process.env.PGPASSWORD || 'postgres',
    database: database || 'postgres',
  };
  const client = new Client(cfg);
  await client.connect();
  return client;
}

let _pgAvail = null;
async function isPgAvailable() {
  if (_pgAvail !== null) return _pgAvail;
  try {
    const c = await pgConnect('postgres');
    await c.end();
    _pgAvail = true;
  } catch (_) {
    _pgAvail = false;
    console.log('[INFO] Postgres unavailable — all async-queue tests will be SKIPPED.');
  }
  return _pgAvail;
}

async function createAqDb() {
  const sys = await pgConnect('postgres');
  await sys.query(`CREATE DATABASE "${AQ_DB}"`);
  await sys.end();
  // Apply schema
  const schemaSql = fs.readFileSync(SCHEMA_FILE, 'utf8');
  const db = await pgConnect(AQ_DB);
  await db.query(schemaSql);
  await db.end();
}

async function dropAqDb() {
  let sys = null;
  try {
    sys = await pgConnect('postgres');
    await sys.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()`,
      [AQ_DB]
    );
    await sys.query(`DROP DATABASE IF EXISTS "${AQ_DB}"`);
  } catch (_) {
  } finally {
    if (sys) { try { await sys.end(); } catch (_) {} }
  }
}

/** Run a handoff subcommand via spawnSync. Returns { status, stdout, stderr }. */
function runHandoff(subcmd, extraArgs = [], stdinData = null, extraEnv = {}) {
  const args = [HANDOFF_SCRIPT, subcmd, ...extraArgs];
  const opts = {
    cwd:      PROJECT_ROOT,
    env:      {
      ...process.env,
      HANDOFF_DB:   AQ_DB,
      PROJECT_ROOT: TEMP_DIR,
      ...extraEnv,
    },
    encoding: 'utf8',
    timeout:  30000,
  };
  if (stdinData !== null) {
    opts.input = stdinData;
    args.splice(2, 0, '--json', '-'); // insert after subcmd but before extra args
  }
  return spawnSync(process.execPath, args, opts);
}

/** Run handoff close with JSON payload via stdin. */
function runClose(payload, extraEnv = {}) {
  const args = [HANDOFF_SCRIPT, 'close', '--json', '-'];
  return spawnSync(process.execPath, args, {
    cwd:      PROJECT_ROOT,
    env:      {
      ...process.env,
      HANDOFF_DB:   AQ_DB,
      PROJECT_ROOT: TEMP_DIR,
      ...extraEnv,
    },
    input:    JSON.stringify(payload),
    encoding: 'utf8',
    timeout:  30000,
  });
}

/** Run handoff checkpoint with JSON payload via stdin. */
function runCheckpoint(payload, extraEnv = {}) {
  const args = [HANDOFF_SCRIPT, 'checkpoint', '--json', '-'];
  return spawnSync(process.execPath, args, {
    cwd:      PROJECT_ROOT,
    env:      {
      ...process.env,
      HANDOFF_DB:   AQ_DB,
      PROJECT_ROOT: TEMP_DIR,
      ...extraEnv,
    },
    input:    JSON.stringify(payload),
    encoding: 'utf8',
    timeout:  30000,
  });
}

/** Run handoff queue-drain. */
function runQueueDrain(extraArgs = [], extraEnv = {}) {
  return spawnSync(process.execPath, [HANDOFF_SCRIPT, 'queue-drain', ...extraArgs], {
    cwd:      PROJECT_ROOT,
    env:      {
      ...process.env,
      HANDOFF_DB:   AQ_DB,
      PROJECT_ROOT: TEMP_DIR,
      ...extraEnv,
    },
    encoding: 'utf8',
    timeout:  30000,
  });
}

// ── Test runner ────────────────────────────────────────────────────────────────

async function runTest(label, fn) {
  try {
    await fn();
    pass(label);
  } catch (err) {
    fail(label, err.message);
  }
}

// ── Test setup: init the project so handoff.js can resolve a project_id ───────

async function setupProject(db) {
  // handoff.js init creates the project_settings row and the .claude-memory marker.
  // We need to run init so a project_id exists in the DB.
  const r = runHandoff('init', []);
  if (r.status !== 0) {
    const out = (r.stdout || '') + (r.stderr || '');
    throw new Error(`handoff init failed: ${out.slice(0, 300)}`);
  }
  // Enable extraction_async_enabled for our test DB/project.
  // We resolve the project_id the same way handoff does (encoded cwd or marker).
  // Since we cannot call the internal resolveProjectId, we set it via the settings
  // table using a direct SQL UPDATE on the row that init just created.
  await db.query(
    `UPDATE project_settings SET value = 'true' WHERE key = 'extraction_async_enabled'`
  );
}

// ── Tests ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('Running: test-async-queue\n');

  const pgAvail = await isPgAvailable();
  if (!pgAvail) {
    console.log('SKIP  all tests: Postgres unavailable');
    console.log('\nResults: 0 passed, 0 failed (all skipped — Postgres unavailable)');
    process.exit(0);
  }

  // Set up temp dir for the project root that handoff will use.
  fs.mkdirSync(TEMP_DIR, { recursive: true });
  fs.mkdirSync(path.join(TEMP_DIR, '.claude'), { recursive: true });

  let db = null;
  try {
    await createAqDb();
    db = await pgConnect(AQ_DB);

    // Run init to provision the project identity and settings.
    await setupProject(db);

    // T1 — Enqueue creates a pending row
    await runTest('T1: enqueue (checkpoint async) creates a pending row in extraction_queue', async () => {
      // Checkpoint with async enabled should INSERT into extraction_queue.
      const payload = {
        session_id:  'aq-test-session-t1',
        tldr:        'T1 async queue test',
        entities:    [{ name: 'TestEntityT1', entity_type: 'concept' }],
        assertions:  [],
        edges:       [],
      };
      const r = runCheckpoint(payload);
      const out = (r.stdout || '') + (r.stderr || '');
      if (r.status !== 0) {
        throw new Error(`checkpoint exit ${r.status}: ${out.slice(0, 400)}`);
      }

      const { rows } = await db.query(
        `SELECT id, status, source_ref FROM extraction_queue WHERE status = 'pending' ORDER BY id DESC LIMIT 1`
      );
      if (rows.length === 0) {
        throw new Error('no pending row found in extraction_queue after async checkpoint');
      }
      if (rows[0].status !== 'pending') {
        throw new Error(`expected status='pending', got '${rows[0].status}'`);
      }
      if (rows[0].source_ref !== 'aq-test-session-t1') {
        throw new Error(`expected source_ref='aq-test-session-t1', got '${rows[0].source_ref}'`);
      }
    });

    // T2 — Queue-drain processes pending→done
    await runTest('T2: queue-drain processes pending row → marks it done', async () => {
      // Insert a fresh pending row directly so this test is isolated.
      const testPayload = {
        session_id:  'aq-test-session-t2',
        tldr:        'T2 drain test',
        entities:    [{ name: 'TestEntityT2', entity_type: 'fact' }],
        assertions:  [],
        edges:       [],
      };
      // Re-enable async setting (setupProject may have been reset by previous test close).
      await db.query(
        `UPDATE project_settings SET value = 'true' WHERE key = 'extraction_async_enabled'`
      );
      const r = runCheckpoint(testPayload);
      const out = (r.stdout || '') + (r.stderr || '');
      if (r.status !== 0) {
        throw new Error(`checkpoint for T2 failed: ${out.slice(0, 400)}`);
      }

      // Find the new pending row.
      const { rows: pending } = await db.query(
        `SELECT id FROM extraction_queue WHERE status = 'pending' ORDER BY id DESC LIMIT 1`
      );
      if (pending.length === 0) {
        throw new Error('no pending row found to drain in T2');
      }
      const rowId = pending[0].id;

      // Run queue-drain.
      const dr = runQueueDrain([]);
      const drOut = (dr.stdout || '') + (dr.stderr || '');
      if (dr.status !== 0) {
        throw new Error(`queue-drain exited ${dr.status}: ${drOut.slice(0, 400)}`);
      }

      // Row should now be 'done'.
      const { rows: after } = await db.query(
        `SELECT status FROM extraction_queue WHERE id = $1`, [rowId]
      );
      if (after.length === 0) {
        throw new Error(`row ${rowId} not found after drain`);
      }
      if (after[0].status !== 'done') {
        throw new Error(`expected status='done' after drain, got '${after[0].status}'`);
      }
    });

    // T3 — Session_id drain corner: payload.session_id absent AND session_in_progress cleared
    await runTest('T3: session_id absent + session_in_progress cleared before drain — no crash, entities written with null sessionId (documented L4-degraded behavior)', async () => {
      // This test locks in the current defined behavior for the pre-existing L4 corner:
      //   - A row enqueued with session_id=null (absent)
      //   - session_in_progress marker cleared from project_settings before drain runs
      // Expected: drain completes without crashing, row marked 'done',
      //           entity is written with session_id=NULL (not an error or corrupt write).

      // Re-enable async setting.
      await db.query(
        `UPDATE project_settings SET value = 'true' WHERE key = 'extraction_async_enabled'`
      );

      // Payload deliberately omits session_id.
      const testPayload = {
        tldr:        'T3 null session corner',
        entities:    [{ name: 'TestEntityT3NullSession', entity_type: 'fact' }],
        assertions:  [],
        edges:       [],
      };
      const r = runCheckpoint(testPayload);
      const out = (r.stdout || '') + (r.stderr || '');
      if (r.status !== 0) {
        throw new Error(`checkpoint for T3 failed: ${out.slice(0, 400)}`);
      }

      // Find the pending row (source_ref should be null since session_id was absent).
      const { rows: pending } = await db.query(
        `SELECT id, source_ref FROM extraction_queue WHERE status = 'pending' ORDER BY id DESC LIMIT 1`
      );
      if (pending.length === 0) {
        throw new Error('no pending row found for T3');
      }
      const rowId = pending[0].id;
      if (pending[0].source_ref !== null) {
        // source_ref should be null when session_id is absent at enqueue time
        throw new Error(`expected source_ref=null for absent session_id, got '${pending[0].source_ref}'`);
      }

      // Ensure session_in_progress is cleared (simulating marker already gone).
      await db.query(
        `DELETE FROM project_settings WHERE key = 'session_in_progress'`
      );

      // Run queue-drain — must NOT crash.
      const dr = runQueueDrain([]);
      const drOut = (dr.stdout || '') + (dr.stderr || '');
      // Drain must not crash (exit 0 on success; exit 1 only if write error).
      // We accept exit 0 or any exit where the process did not throw/segfault.
      if (dr.signal) {
        throw new Error(`queue-drain killed by signal ${dr.signal} — unexpected crash`);
      }
      if (dr.error) {
        throw new Error(`queue-drain spawn error: ${dr.error.message}`);
      }

      // Row must be marked done or error — not left pending.
      const { rows: after } = await db.query(
        `SELECT status FROM extraction_queue WHERE id = $1`, [rowId]
      );
      if (after.length === 0) {
        throw new Error(`row ${rowId} not found after T3 drain`);
      }
      const finalStatus = after[0].status;
      if (finalStatus === 'pending') {
        throw new Error(`row ${rowId} still pending after drain — drain did not process it`);
      }

      // If done, verify entity was written with null session_id (not a corrupt/missing write).
      if (finalStatus === 'done') {
        const { rows: ents } = await db.query(
          `SELECT name, session_id FROM entities WHERE name = 'TestEntityT3NullSession' LIMIT 1`
        );
        if (ents.length === 0) {
          throw new Error('entity TestEntityT3NullSession not found after drain despite done status');
        }
        // session_id should be null — entity written without session binding (expected L4 degraded behavior)
        if (ents[0].session_id !== null) {
          throw new Error(
            `entity session_id expected null (L4-degraded: no session marker), got '${ents[0].session_id}'`
          );
        }
      }
      // If error, that is also acceptable documented behavior — the important invariant
      // is no crash and no silent corrupt write.
      // (current behavior: writeExtraction writes entity with sessionId=null when getSetting returns null)
    });

    // T3b — Stale session_in_progress marker: drain's staleness-guard MUST reject it
    await runTest('T3b: stale session_in_progress marker PRESENT during drain — staleness guard rejects it, entity written with session_id=NULL', async () => {
      // This test locks in the staleness-guard branch in writeExtraction (PR #70).
      //
      // The guard (handoff.js writeExtraction): when payload.session_id is absent,
      // the fallback reads session_in_progress from project_settings. If the stored
      // ISO timestamp is older than staleness_days (default 7), the marker is REJECTED
      // and sessionId stays null — the entity must be written with session_id=NULL.
      //
      // PREVIOUS BUG (fixed here): T3b was deleting session_in_progress before
      // runQueueDrain, so getSetting returned null and the absent-marker path ran —
      // not the staleness-rejection path. That duplicated T3 and gave a false safety
      // signal. The guard's age-check branch was never exercised.
      //
      // CORRECT SETUP:
      //   1. Enqueue via checkpoint (checkpoint internally deletes session_in_progress).
      //   2. INSERT a stale marker (30 days old, well past the 7-day threshold)
      //      AFTER the checkpoint, so it is present when queue-drain calls writeExtraction.
      //   3. Do NOT delete the marker before drain.
      //   4. Run drain — writeExtraction reads the stale marker, parses its timestamp,
      //      detects age > staleness_days, and leaves sessionId=null.
      //   5. Assert entity.session_id IS NULL (staleness guard rejected the marker).
      //   6. Assert the marker is STILL PRESENT in project_settings after drain
      //      (the guard does not consume or delete it — only cmdClose/cmdCheckpoint do).
      //
      // FALSIFIABILITY: a hypothetical no-guard implementation (writeExtraction simply
      // reads session_in_progress and uses it regardless of age) would produce
      // entity.session_id = staleTs (the ISO string), causing assertion step 5 to FAIL.

      // Step 1: re-enable async and enqueue a row. No payload.session_id.
      await db.query(
        `UPDATE project_settings SET value = 'true' WHERE key = 'extraction_async_enabled'`
      );
      const testPayload = {
        // Deliberately omit session_id — fallback in writeExtraction hits the staleness guard.
        tldr:        'T3b stale marker corner',
        entities:    [{ name: 'TestEntityT3bStaleSession', entity_type: 'fact' }],
        assertions:  [],
        edges:       [],
      };
      const r = runCheckpoint(testPayload);
      const out = (r.stdout || '') + (r.stderr || '');
      if (r.status !== 0) {
        throw new Error(`checkpoint for T3b failed: ${out.slice(0, 400)}`);
      }

      // Find the pending row created by the checkpoint.
      const { rows: pending } = await db.query(
        `SELECT id FROM extraction_queue WHERE status = 'pending' ORDER BY id DESC LIMIT 1`
      );
      if (pending.length === 0) {
        throw new Error('no pending row found for T3b');
      }
      const rowId = pending[0].id;

      // Step 2: INSERT a stale marker (30 days ago — well beyond the 7-day threshold).
      // The checkpoint just cleared session_in_progress, so we must insert it now.
      // Format matches what cmdLoaderHook writes: new Date().toISOString() — a raw ISO string.
      const staleTs = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
      await db.query(
        `INSERT INTO project_settings (project_id, key, value)
         SELECT project_id, 'session_in_progress', $1
         FROM project_settings WHERE key = 'extraction_async_enabled' LIMIT 1
         ON CONFLICT (project_id, key) DO UPDATE SET value = $1`,
        [staleTs]
      );

      // Verify the stale marker is in place before drain.
      const { rows: markerBefore } = await db.query(
        `SELECT value FROM project_settings WHERE key = 'session_in_progress'`
      );
      if (markerBefore.length === 0) {
        throw new Error('stale marker not inserted — cannot exercise staleness-guard branch');
      }

      // Step 3: Run drain WITH the stale marker present (no delete before drain).
      // writeExtraction will read the marker, parse staleTs, compute age > 7 days,
      // and reject it — leaving sessionId=null.
      const dr = runQueueDrain([]);
      if (dr.signal) {
        throw new Error(`queue-drain killed by signal ${dr.signal} — unexpected crash`);
      }
      if (dr.error) {
        throw new Error(`queue-drain spawn error: ${dr.error.message}`);
      }

      // Step 4: Check queue row status.
      const { rows: qrows } = await db.query(
        `SELECT status FROM extraction_queue WHERE id = $1`, [rowId]
      );
      const qstatus = qrows[0] ? qrows[0].status : 'not found';

      // Step 5: Assert entity.session_id IS NULL (staleness guard rejected the marker).
      if (qstatus === 'done') {
        const { rows: ents } = await db.query(
          `SELECT name, session_id FROM entities WHERE name = 'TestEntityT3bStaleSession' LIMIT 1`
        );
        if (ents.length === 0) {
          throw new Error('entity TestEntityT3bStaleSession not found after drain (status=done)');
        }
        if (ents[0].session_id !== null) {
          // A no-guard implementation would set session_id = staleTs here — failing this check.
          throw new Error(
            `STALENESS GUARD FAILED: entity session_id='${ents[0].session_id}' ` +
            `but expected null — stale session_in_progress marker was used instead of rejected`
          );
        }
      } else if (qstatus === 'error') {
        // Drain errored — stale marker did not cause a corrupt bind. Acceptable.
        // The important invariant (no entity written with stale session_id) holds trivially.
      } else {
        throw new Error(`unexpected queue row status '${qstatus}' after drain`);
      }

      // Step 6: Assert the stale marker is STILL PRESENT after drain.
      // writeExtraction's staleness guard does not delete the marker — only cmdClose
      // and cmdCheckpoint do. If the marker was consumed/deleted by drain, that would
      // indicate unintended side-effects in the guard implementation.
      const { rows: markerAfter } = await db.query(
        `SELECT value FROM project_settings WHERE key = 'session_in_progress'`
      );
      if (markerAfter.length === 0) {
        throw new Error(
          'session_in_progress marker was deleted by queue-drain — ' +
          'the staleness guard must not consume the marker (only cmdClose/cmdCheckpoint clear it)'
        );
      }
      if (markerAfter[0].value !== staleTs) {
        throw new Error(
          `session_in_progress value changed during drain: expected '${staleTs}', got '${markerAfter[0].value}'`
        );
      }
    });

    // T4 — Idempotent re-drain: done row is not re-processed
    await runTest('T4: idempotent re-drain — done row not re-processed on second drain call', async () => {
      // Find a 'done' row from earlier tests.
      const { rows: done } = await db.query(
        `SELECT id, processed_at FROM extraction_queue WHERE status = 'done' ORDER BY id ASC LIMIT 1`
      );
      if (done.length === 0) {
        // Ensure there is at least one done row from prior tests; if not, skip gracefully.
        console.log('  (no done rows from prior tests — inserting directly for idempotency check)');
        await db.query(
          `INSERT INTO extraction_queue (project_id, payload, source_ref, status, enqueued_at, processed_at)
           SELECT project_id, '{"entities":[],"assertions":[]}'::jsonb, 'idempotent-test', 'done', now(), now()
           FROM project_settings WHERE key='extraction_async_enabled' LIMIT 1`
        );
        const { rows: inserted } = await db.query(
          `SELECT id, processed_at FROM extraction_queue WHERE status='done' ORDER BY id DESC LIMIT 1`
        );
        if (inserted.length === 0) throw new Error('could not insert a done row for idempotency test');
        done.push(inserted[0]);
      }

      const rowId     = done[0].id;
      const procAtBefore = done[0].processed_at;

      // Run drain again.
      const dr = runQueueDrain([]);
      if (dr.signal) throw new Error(`queue-drain killed by signal ${dr.signal}`);

      // The done row's processed_at must not have changed.
      const { rows: after } = await db.query(
        `SELECT status, processed_at FROM extraction_queue WHERE id = $1`, [rowId]
      );
      if (after.length === 0) throw new Error(`row ${rowId} not found after re-drain`);
      if (after[0].status !== 'done') {
        throw new Error(`expected status='done' still after re-drain, got '${after[0].status}'`);
      }
      // processed_at should be unchanged (drain selects only WHERE status='pending')
      const procAtAfter = after[0].processed_at;
      if (procAtBefore && procAtAfter && procAtBefore.toISOString() !== procAtAfter.toISOString()) {
        throw new Error(`processed_at changed on re-drain — done row was mutated`);
      }
    });

    // T5 — Drain with empty queue: clean no-op, exit 0
    await runTest('T5: drain with empty pending queue — clean no-op, exit 0', async () => {
      // Ensure no pending rows remain.
      await db.query(
        `UPDATE extraction_queue SET status = 'done', processed_at = now() WHERE status = 'pending'`
      );

      const dr = runQueueDrain([]);
      const drOut = (dr.stdout || '') + (dr.stderr || '');
      if (dr.status !== 0) {
        throw new Error(`queue-drain on empty queue exited ${dr.status}: ${drOut.slice(0, 400)}`);
      }
      if (dr.signal) {
        throw new Error(`queue-drain killed by signal ${dr.signal} on empty queue`);
      }
      // Output should mention 0 rows processed or empty queue.
      const combined = drOut.toLowerCase();
      if (!combined.includes('0 rows') && !combined.includes('no pending')) {
        throw new Error(`unexpected output for empty drain: ${drOut.slice(0, 300)}`);
      }
    });

  } finally {
    if (db) { try { await db.end(); } catch (_) {} }
    await dropAqDb();
    // Clean up temp dir.
    if (fs.existsSync(TEMP_DIR)) {
      try { fs.rmSync(TEMP_DIR, { recursive: true, force: true }); } catch (_) {}
    }
  }

  // ── Summary ────────────────────────────────────────────────────────────────────

  console.log('');
  console.log(`Results: ${passed} passed, ${failed} failed`);
  if (failures.length > 0) {
    console.log('\nFailures:');
    for (const f of failures) {
      console.log(`  FAIL  ${f.label}: ${f.reason}`);
    }
  }
  console.log('');
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('Uncaught error:', err);
  process.exit(1);
});
