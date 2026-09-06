'use strict';

/**
 * test-index-cap-md5.js — cm#227 regression suite.
 *
 * Defect: a close whose TL;DR was long (payload schema allows tldr <= 4000
 * chars) could hit "index row size ... exceeds btree version N maximum ..."
 * on assertions_1ton_exact_unique — a plain btree partial-unique index on
 * (project_id, subject, predicate, object) — and persistSessionIntent's
 * per-row try/catch swallowed the error, so the close still printed "Done"
 * with the TL;DR silently missing.
 *
 * Fix: assertions_1ton_exact_unique is now keyed on
 * (project_id, subject, predicate, md5(object)) — a fixed-size digest, so
 * the physical row-size limit can never be hit regardless of object length.
 * Session-intent persistence failures are also now surfaced as
 * "DIVERGENCE: <predicate> NOT PERSISTED — <error>" lines (covered by
 * scripts/test-l4-degraded-close.js's T9, not duplicated here).
 *
 * Coverage (spec X6, PR cm#227):
 *   A  Close with a 3900-char tldr persists a session_tldr row; resume serves it.
 *   B  Bring-forward from a DB carrying the OLD (pre-md5) index definition:
 *      ensureSchemaCurrent re-applies once (reason:'applied'), pg_get_indexdef
 *      then shows md5(object); a second call is a no-op (reason:'current').
 *   C  Two 1:N assertions, same (subject, predicate), objects sharing an
 *      identical first 2800 bytes and diverging after — both stored, both
 *      independently retrievable (no false-collision from truncation).
 *   D  Supersession of a >2704-byte object (1:1 predicate) works: old row
 *      suppressed, new row live.
 *   F  MCP assertion_create with a 5000-char object is rejected up front,
 *      naming the 4000 limit — before any row is written.
 *   G  A decisions[].topic over 2000 UTF-8 bytes is rejected up front by
 *      handoff.js close --json -, naming the 2000-byte limit, before any
 *      DB mutation (exit code non-zero, no assertions/entities table touched).
 *
 * Requires: Postgres available at PGHOST/PGUSER/PGPASSWORD (CI env) or
 * localhost/postgres. Exit 0 = all tests passed. Exit 1 = any failure.
 */

const fs   = require('fs');
const os   = require('os');
const path = require('path');

const {
  pgConnect,
  createDb,
  dropDb,
  runHandoff,
  runClose,
  resolveProjectId,
  cleanupHandoffMd,
  setupProject,
} = require('./../scripts/lib/test-pg-helpers');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const TS           = Date.now();

let passed = 0;
let failed = 0;
const failures = [];

function pass(label)         { console.log(`PASS  ${label}`); passed++; }
function fail(label, reason) { console.log(`FAIL  ${label}: ${reason}`); failures.push({ label, reason }); failed++; }

/**
 * Connect a real MCP stdio client to the actual handoff-mcp.mjs server —
 * same pattern as scripts/migrations/verify-20-mcp-surface.js's
 * runMcpRegistrationCheck. Needed wherever a test writes an object longer
 * than readStdin()'s generic RECORD_STR_MAX (1000 chars) — assertion_create
 * is the ONLY write path that permits an object up to 4000 chars (its own
 * cm#227 zod .max(4000) cap), independent of the CLI --json - payload's
 * per-record 1000-char cap.
 */
async function connectMcp(dbName) {
  const { Client: SdkClient } = require(
    path.join(PROJECT_ROOT, 'scripts', 'node_modules', '@modelcontextprotocol', 'sdk', 'dist', 'cjs', 'client', 'index.js')
  );
  const { StdioClientTransport } = require(
    path.join(PROJECT_ROOT, 'scripts', 'node_modules', '@modelcontextprotocol', 'sdk', 'dist', 'cjs', 'client', 'stdio.js')
  );
  const serverPath = path.join(PROJECT_ROOT, 'scripts', 'handoff-mcp.mjs');
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverPath],
    env: { ...process.env, HANDOFF_DB: dbName },
  });
  const client = new SdkClient({ name: 'test-index-cap-md5', version: '0.1.0' }, { capabilities: {} });
  await client.connect(transport);
  return client;
}

// ── A: long tldr persists + resume serves it ──────────────────────────────────

async function testA_LongTldrPersists() {
  const label = 'A: 3900-char tldr persists a session_tldr row; resume serves it';
  const dbName = `claude_memory_idx_a_${TS}`;
  const projectDir = path.join(os.tmpdir(), `idxcap_a_${TS}`);
  let db = null;
  let projectId;
  try {
    await createDb(dbName, projectDir);
    projectId = await setupProject(dbName, projectDir);

    const marker = 'CM227-MARKER-A-';
    const tldr = marker + 'x'.repeat(3900 - marker.length);
    const r = runClose({ tldr, assertions: [] }, dbName, projectDir);
    if (r.status !== 0) {
      fail(label, `close exited ${r.status}. stderr: ${r.stderr}`);
      return;
    }
    if (/DIVERGENCE:/.test(r.stdout || '')) {
      fail(label, `unexpected DIVERGENCE line in stdout:\n${r.stdout}`);
      return;
    }

    db = await pgConnect(dbName);
    const { rows } = await db.query(
      `SELECT object FROM assertions
       WHERE project_id = $1 AND predicate = 'session_tldr' AND suppressed = false`,
      [projectId]
    );
    await db.end(); db = null;

    if (rows.length !== 1) {
      fail(label, `expected exactly 1 live session_tldr row, got ${rows.length}`);
      return;
    }
    if (rows[0].object !== tldr) {
      fail(label, `stored object does not match input verbatim (len stored=${rows[0].object.length}, expected=${tldr.length})`);
      return;
    }

    const resumeResult = runHandoff('resume', [], null, dbName, projectDir);
    if (resumeResult.status !== 0) {
      fail(label, `resume exited ${resumeResult.status}. stderr: ${resumeResult.stderr}`);
      return;
    }
    if (!(resumeResult.stdout || '').includes(marker)) {
      fail(label, `resume output does not include the persisted tldr marker. stdout tail:\n${(resumeResult.stdout || '').slice(-500)}`);
      return;
    }

    pass(label);
  } catch (err) {
    fail(label, err.message);
  } finally {
    if (db) { try { await db.end(); } catch (_) {} }
    if (projectId) cleanupHandoffMd(projectId);
    await dropDb(dbName, projectDir);
  }
}

// ── B: bring-forward from OLD index definition ────────────────────────────────

async function testB_BringForwardFromOldIndex() {
  const label = 'B: bring-forward from OLD (raw-object) index def -> md5(object); re-run is a no-op';
  const dbName = `claude_memory_idx_b_${TS}`;
  const projectDir = path.join(os.tmpdir(), `idxcap_b_${TS}`);
  let db = null;
  let projectId;
  try {
    await createDb(dbName, projectDir);
    // NOTE: `handoff init` (setupProject) applies schema via applyAdditiveSchema
    // directly and does NOT write project_settings.schema_fingerprint (that is
    // ensureSchemaCurrent's exclusive job — cmdInit is a separate, one-shot
    // fresh-apply path). So a just-inited DB starts with NO fingerprint row;
    // this test establishes one first (simulating "a live DB last touched at
    // the current epoch"), THEN reverts the index and downgrades that
    // fingerprint's epoch to simulate a live pre-cm#227 DB.
    projectId = await setupProject(dbName, projectDir);

    db = await pgConnect(dbName);
    const handoffLib = require(path.join(PROJECT_ROOT, 'scripts', 'handoff.js'));
    const { PostgresAdapter } = require(path.join(PROJECT_ROOT, 'scripts', 'lib', 'db-seam.js'));
    const adapter = new PostgresAdapter(db);

    // Establish a baseline current fingerprint (absent -> applied).
    const baseline = await handoffLib.ensureSchemaCurrent(adapter, projectId, { silent: true });
    if (baseline.reason !== 'applied') {
      throw new Error(`precondition failed: baseline ensureSchemaCurrent expected reason='applied', got ${JSON.stringify(baseline)}`);
    }

    // Now simulate a live pre-cm#227 DB: revert to the OLD (raw-object) index
    // definition, then downgrade the stored fingerprint's epoch so the NEXT
    // ensureSchemaCurrent touch sees 'behind' (bypassing the 'current' fast path).
    await db.query('DROP INDEX IF EXISTS assertions_1ton_exact_unique');
    await db.query(
      `CREATE UNIQUE INDEX assertions_1ton_exact_unique
         ON assertions (project_id, subject, predicate, object)
         WHERE suppressed = false`
    );
    const { rows: fpRows } = await db.query(
      `SELECT value FROM project_settings WHERE project_id = $1 AND key = 'schema_fingerprint'`,
      [projectId]
    );
    if (fpRows.length !== 1) throw new Error('schema_fingerprint row not found after baseline touch');
    const oldFingerprint = fpRows[0].value.replace(/^\d+:/, '2:');
    await db.query(
      `UPDATE project_settings SET value = $2 WHERE project_id = $1 AND key = 'schema_fingerprint'`,
      [projectId, oldFingerprint]
    );

    // Sanity: index does NOT yet mention md5.
    const before = await db.query(
      `SELECT indexdef FROM pg_indexes WHERE indexname = 'assertions_1ton_exact_unique'`
    );
    if (!before.rows[0] || /md5\(/i.test(before.rows[0].indexdef)) {
      throw new Error(`precondition failed: index already keyed on md5 before bring-forward: ${JSON.stringify(before.rows[0])}`);
    }

    const firstTouch = await handoffLib.ensureSchemaCurrent(adapter, projectId, { silent: true });
    if (firstTouch.reason !== 'applied' || firstTouch.applied !== true) {
      fail(label, `bring-forward touch: expected {applied:true, reason:'applied'}, got ${JSON.stringify(firstTouch)}`);
      return;
    }

    const after = await db.query(
      `SELECT indexdef FROM pg_indexes WHERE indexname = 'assertions_1ton_exact_unique'`
    );
    if (!after.rows[0] || !/md5\(object\)/i.test(after.rows[0].indexdef)) {
      fail(label, `expected pg_indexes.indexdef to contain md5(object) after bring-forward, got: ${after.rows[0] && after.rows[0].indexdef}`);
      return;
    }

    // Second touch: schema is now current -> fast no-op path.
    const secondTouch = await handoffLib.ensureSchemaCurrent(adapter, projectId, { silent: true });
    if (secondTouch.reason !== 'current' || secondTouch.applied !== false) {
      fail(label, `second touch: expected {applied:false, reason:'current'} (no-op), got ${JSON.stringify(secondTouch)}`);
      return;
    }

    pass(label);
  } catch (err) {
    fail(label, err.message);
  } finally {
    if (db) { try { await db.end(); } catch (_) {} }
    if (projectId) cleanupHandoffMd(projectId);
    await dropDb(dbName, projectDir);
  }
}

// ── C: same-prefix, diverging-tail objects both stored ────────────────────────

async function testC_SamePrefixDivergingTailBothStored() {
  const label = 'C: two 1:N assertions sharing a 2800-byte object prefix, diverging after — both stored + retrievable';
  const dbName = `claude_memory_idx_c_${TS}`;
  const projectDir = path.join(os.tmpdir(), `idxcap_c_${TS}`);
  let db = null;
  let projectId;
  let client = null;
  try {
    await createDb(dbName, projectDir);
    projectId = await setupProject(dbName, projectDir);

    const prefix = 'p'.repeat(2800);
    const objectA = prefix + 'TAIL-A';
    const objectB = prefix + 'TAIL-B';

    // Written via the real MCP assertion_create tool (cap 4000 chars) rather
    // than the CLI close --json - payload path: readStdin()'s generic
    // RECORD_STR_MAX (1000 chars, pre-existing, unrelated to this fix) would
    // reject a 2806-char object outright before it ever reached the index.
    // 'has' is a registered 1:N predicate (no reality-check binding) — both
    // rows must survive independently (1:N only suppresses EXACT duplicates).
    client = await connectMcp(dbName);
    for (const obj of [objectA, objectB]) {
      const res = await client.callTool({
        name: 'assertion_create',
        arguments: {
          projectRoot: projectDir,
          subject: 'cm227-collision-subject',
          predicate: 'has',
          object: obj,
          confidence: 8,
          source: 'user_stated',
        },
      });
      if (res.isError) {
        fail(label, `assertion_create errored: ${res.content[0].text}`);
        return;
      }
    }

    db = await pgConnect(dbName);
    const { rows } = await db.query(
      `SELECT object FROM assertions
       WHERE project_id = $1 AND predicate = 'has' AND subject = 'cm227-collision-subject'
         AND suppressed = false
       ORDER BY id`,
      [projectId]
    );
    await db.end(); db = null;

    if (rows.length !== 2) {
      fail(label, `expected 2 live rows (no false collision), got ${rows.length}: ${JSON.stringify(rows.map((r2) => r2.object.slice(-10)))}`);
      return;
    }
    const objs = new Set(rows.map((r2) => r2.object));
    if (!objs.has(objectA) || !objs.has(objectB)) {
      fail(label, 'both distinct objects must be independently retrievable verbatim');
      return;
    }

    pass(label);
  } catch (err) {
    fail(label, err.message);
  } finally {
    if (client) { try { await client.close(); } catch (_) {} }
    if (db) { try { await db.end(); } catch (_) {} }
    if (projectId) cleanupHandoffMd(projectId);
    await dropDb(dbName, projectDir);
  }
}

// ── D: supersession of a >2704-byte object (1:1) ──────────────────────────────

async function testD_SupersessionOfLargeObject() {
  const label = 'D: supersession of a >2704-byte object (1:1 predicate session_tldr) works';
  const dbName = `claude_memory_idx_d_${TS}`;
  const projectDir = path.join(os.tmpdir(), `idxcap_d_${TS}`);
  let db = null;
  let projectId;
  try {
    await createDb(dbName, projectDir);
    projectId = await setupProject(dbName, projectDir);

    const tldrOld = 'OLD-'.repeat(750);   // ~3000 bytes
    const tldrNew = 'NEW-'.repeat(750);   // ~3000 bytes, distinct content

    let r = runClose({ tldr: tldrOld, assertions: [] }, dbName, projectDir);
    if (r.status !== 0) { fail(label, `first close exited ${r.status}. stderr: ${r.stderr}`); return; }

    r = runClose({ tldr: tldrNew, assertions: [] }, dbName, projectDir);
    if (r.status !== 0) { fail(label, `second close exited ${r.status}. stderr: ${r.stderr}`); return; }

    db = await pgConnect(dbName);
    const { rows: liveRows } = await db.query(
      `SELECT object FROM assertions
       WHERE project_id = $1 AND predicate = 'session_tldr' AND suppressed = false`,
      [projectId]
    );
    const { rows: suppressedRows } = await db.query(
      `SELECT object, suppression_kind FROM assertions
       WHERE project_id = $1 AND predicate = 'session_tldr' AND suppressed = true`,
      [projectId]
    );
    await db.end(); db = null;

    if (liveRows.length !== 1 || liveRows[0].object !== tldrNew) {
      fail(label, `expected exactly 1 live session_tldr row = tldrNew, got: ${JSON.stringify(liveRows.map((r2) => r2.object.slice(0, 10)))}`);
      return;
    }
    if (suppressedRows.length !== 1 || suppressedRows[0].object !== tldrOld || suppressedRows[0].suppression_kind !== 'superseded') {
      fail(label, `expected exactly 1 suppressed row = tldrOld with suppression_kind='superseded', got: ${JSON.stringify(suppressedRows)}`);
      return;
    }

    pass(label);
  } catch (err) {
    fail(label, err.message);
  } finally {
    if (db) { try { await db.end(); } catch (_) {} }
    if (projectId) cleanupHandoffMd(projectId);
    await dropDb(dbName, projectDir);
  }
}

// ── F: MCP assertion_create rejects an oversized object up front ─────────────

async function testF_McpAssertionCreateRejectsOversizedObject() {
  const label = 'F: MCP assertion_create with a 5000-char object is rejected up front, naming 4000';
  const dbName = `claude_memory_idx_f_${TS}`;
  const projectDir = path.join(os.tmpdir(), `idxcap_f_${TS}`);
  let db = null;
  let projectId;
  let client = null;
  let tmpRoot = null;
  try {
    await createDb(dbName, projectDir);
    projectId = await setupProject(dbName, projectDir);

    // Real project root for the MCP server's ensureProjectIdentity (mirrors
    // verify-20-mcp-surface.js's own scratch-root convention) — reuses the
    // SAME already-provisioned project (marker + DB) set up above.
    tmpRoot = projectDir;
    client = await connectMcp(dbName);

    // cm#227: an oversized `object` fails the inputSchema's zod .max(4000)
    // check. The MCP SDK server enforces registerTool's inputSchema BEFORE
    // ever invoking the tool handler, raising McpError(InvalidParams) at the
    // protocol level — this surfaces to the SDK Client as a REJECTED
    // callTool() promise (not a {isError:true} tool result), so both a thrown
    // rejection AND (defensively) an isError result are accepted as "rejected".
    const oversized = 'z'.repeat(5000);
    let errText = null;
    try {
      const res = await client.callTool({
        name: 'assertion_create',
        arguments: {
          projectRoot: tmpRoot,
          subject: 'cm227-mcp-cap-test',
          predicate: 'has',
          object: oversized,
          confidence: 8,
          source: 'user_stated',
        },
      });
      if (res.isError) {
        errText = (res.content && res.content[0] && res.content[0].text) || '';
      } else {
        fail(label, `expected assertion_create to be rejected, got success: ${JSON.stringify(res.content)}`);
        return;
      }
    } catch (rejectErr) {
      errText = rejectErr.message || String(rejectErr);
    }
    if (!/4000/.test(errText)) {
      fail(label, `expected rejection to name the 4000 limit, got: ${errText}`);
      return;
    }

    db = await pgConnect(dbName);
    const { rows } = await db.query(
      `SELECT 1 FROM assertions WHERE project_id = $1 AND subject = 'cm227-mcp-cap-test'`,
      [projectId]
    );
    await db.end(); db = null;
    if (rows.length !== 0) {
      fail(label, `rejected assertion_create must not have written any row; found ${rows.length}`);
      return;
    }

    pass(label);
  } catch (err) {
    fail(label, err.message);
  } finally {
    if (client) { try { await client.close(); } catch (_) {} }
    if (db) { try { await db.end(); } catch (_) {} }
    if (projectId) cleanupHandoffMd(projectId);
    await dropDb(dbName, projectDir);
  }
}

// ── G: decisions[].topic over 2000 bytes rejected up front ───────────────────

async function testG_DecisionsTopicByteCapRejectedUpFront() {
  const label = 'G: decisions[].topic over 2000 UTF-8 bytes rejected up front, naming 2000, before any DB mutation';
  const dbName = `claude_memory_idx_g_${TS}`;
  const projectDir = path.join(os.tmpdir(), `idxcap_g_${TS}`);
  let db = null;
  let projectId;
  try {
    await createDb(dbName, projectDir);
    projectId = await setupProject(dbName, projectDir);

    // Multi-byte characters (3 bytes each in UTF-8) so char-length stays well
    // under the generic 1000-char RECORD_STR_MAX cap while byte-length still
    // exceeds the 2000-byte topic-specific cap — proves this is a genuinely
    // independent, byte-aware check, not a restatement of the char cap.
    const topic = '中'.repeat(900); // 900 chars * 3 bytes = 2700 bytes > 2000, < 1000 chars
    const payload = { decisions: [{ topic, decision: 'd', reason: 'r' }] };

    const r = runClose(payload, dbName, projectDir);
    if (r.status === 0) {
      fail(label, `expected a non-zero exit (rejected up front), got 0. stdout:\n${r.stdout}`);
      return;
    }
    const errText = (r.stderr || '') + (r.stdout || '');
    if (!/2000/.test(errText) || !/topic/i.test(errText)) {
      fail(label, `expected the rejection to name "topic" and the 2000-byte limit. stderr:\n${r.stderr}\nstdout:\n${r.stdout}`);
      return;
    }

    db = await pgConnect(dbName);
    const { rows: entRows } = await db.query(`SELECT 1 FROM entities WHERE project_id = $1`, [projectId]);
    const { rows: assRows } = await db.query(
      `SELECT 1 FROM assertions WHERE project_id = $1 AND predicate NOT IN ('has_unpackaged_state')`,
      [projectId]
    );
    await db.end(); db = null;
    if (entRows.length !== 0 || assRows.length !== 0) {
      fail(label, `rejected payload must cause zero DB mutation; found ${entRows.length} entities, ${assRows.length} assertions`);
      return;
    }

    pass(label);
  } catch (err) {
    fail(label, err.message);
  } finally {
    if (db) { try { await db.end(); } catch (_) {} }
    if (projectId) cleanupHandoffMd(projectId);
    await dropDb(dbName, projectDir);
  }
}

// ── Main ───────────────────────────────────────────────────────────────────────

async function main() {
  console.log('=== cm#227 index-cap (md5-keyed assertions_1ton_exact_unique) regression tests ===\n');

  let pgAvail = false;
  try {
    const probe = await pgConnect('postgres');
    await probe.end();
    pgAvail = true;
  } catch (err) {
    console.error(`[SKIP] Postgres not available (${err.message}) — all tests require Postgres.`);
    process.exit(0);
  }
  if (!pgAvail) process.exit(0);

  await testA_LongTldrPersists();
  await testB_BringForwardFromOldIndex();
  await testC_SamePrefixDivergingTailBothStored();
  await testD_SupersessionOfLargeObject();
  await testF_McpAssertionCreateRejectsOversizedObject();
  await testG_DecisionsTopicByteCapRejectedUpFront();

  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
  if (failures.length > 0) {
    console.log('\nFailures:');
    for (const f of failures) console.log(`  FAIL  ${f.label}: ${f.reason}`);
    process.exit(1);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error(`[FATAL] test runner crashed: ${err.stack || err.message}`);
  process.exit(1);
});
