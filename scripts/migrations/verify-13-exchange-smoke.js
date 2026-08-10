'use strict';

/**
 * verify-13-exchange-smoke.js
 *
 * Operator-run CLI, the agent-exchange interop smoke test. Exercises the
 * live agent_exchange / audit_log / log_guarded_change() objects that
 * migrate-13-agent-exchange.js installs, against a real target database.
 *
 * CLI CONVENTIONS -- identical to verify-17-routing-smoke.js /
 * verify-18-usage-smoke.js: --db flag, then MIGRATE_TARGET_DB env, then
 * memory_manager_staging built-in default. Reuses migrate-01-canonical-db.js's
 * own resolveTargetDb/classifyTarget/DB_NAME_RE/pgConfig by import (never
 * forked). Refusal is a total classification and runs BEFORE any database
 * connection is opened. Never reads HANDOFF_DB.
 *
 * PREREQUISITE CHECK: agent_exchange, audit_log, assertions -- the third
 * because check 3 (the worked cross-agent example) writes an attributed
 * assertions row. A missing table is a loud FAIL naming
 * migrate-13-agent-exchange.js (and, transitively, migrate-01-canonical-db.js
 * for assertions), exit 1, before any fixture work begins.
 *
 * TRANSACTION ISOLATION -- identical posture to verify-17/verify-18 (via
 * the shared harness in ./lib/smoke-harness.js): the entire fixture-and-
 * check lifecycle runs inside ONE transaction on ONE connection, BEGIN, run-
 * prefixed fixture inserts, all checks through that same client, then
 * ROLLBACK always -- success or failure. NOTHING is wiped (WIPE_TABLES=[]):
 * unlike verify-18's model_registry, no global-pool table is involved here
 * -- agent_exchange/audit_log/assertions rows are only ever
 * prefix-residue-scanned post-rollback, never DELETEd.
 *
 * Every smoke project/agent id carries the `smoke13-<random-suffix>` prefix
 * generated once per run (via the shared harness's makeRunPrefix).
 *
 * Usage:
 *   node scripts/migrations/verify-13-exchange-smoke.js [--db <name>]
 *
 * Exit codes: 0 = all checks PASS, 1 = refused / prerequisite missing / any
 * check FAIL, 2 = bad CLI usage.
 */

const { Client } = require('pg');

const migrateOne = require('./migrate-01-canonical-db');
const migrate13 = require('./migrate-13-agent-exchange');
const smokeHarness = require('./lib/smoke-harness');

// ─── Prerequisite tables ───────────────────────────────────────────────────

const PREREQUISITE_TABLES = ['agent_exchange', 'audit_log', 'assertions'];

// Nothing is ever wiped -- no global-pool table is involved (unlike
// verify-18's model_registry).
const WIPE_TABLES = [];

// Post-rollback residue-scan specs -- agent_exchange and assertions are
// scanned by project_id; audit_log has no project_id column of its own, so
// it is scanned via its JSONB old_row/new_row snapshots (which retain
// project_id -- only 'embedding' is stripped by the trigger, per
// ADVERSARY-PASS A-3), "where applicable" per the design note.
const RESIDUE_SPECS = [
  { table: 'agent_exchange', where: 'project_id LIKE $1' },
  { table: 'assertions', where: 'project_id LIKE $1' },
  { table: 'audit_log', where: "(old_row->>'project_id') LIKE $1 OR (new_row->>'project_id') LIKE $1" },
];

// ─── CLI ARGS ──────────────────────────────────────────────────────────────

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
    'Usage: node scripts/migrations/verify-13-exchange-smoke.js [--db <name>]',
    '',
    '  --db <name>  Target database name (else MIGRATE_TARGET_DB env, else',
    '               memory_manager_staging). Never reads HANDOFF_DB. Runs',
    '               entirely inside one transaction that is always rolled',
    '               back -- safe to run against a live staging database.',
  ].join('\n'));
}

// ─── Assertion helpers ──────────────────────────────────────────────────────

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function assertEq(actual, expected, msg) {
  if (actual !== expected) {
    throw new Error(`${msg || 'assertion failed'} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
  }
}

// ─── Fixture helpers ─────────────────────────────────────────────────────

// NOTE (round-trip precision): node-postgres parses TIMESTAMPTZ into a JS
// Date, which only carries millisecond precision, while Postgres itself
// stores microsecond precision. Every row inside this smoke run's single
// transaction shares the exact same transaction_timestamp() value (NOW()),
// so if a Date-rounded cursor were fed back into a `created_at > $cursor`
// comparison, a stored value with a nonzero microsecond remainder would
// compare GREATER than the rounded-down cursor and every already-seen row
// would silently reappear -- exactly the bug this comment guards against.
// created_at_raw (::text, full precision, no JS Date round-trip) is what
// MUST be used as the cursor; the plain `created_at` Date field is for
// display/comparison-by-humans only, never for re-querying.
async function insertExchange(client, { projectId, docketId = null, parentId = null, agentId, sourceModel = null, toAgent = null, kind, body, createdAt = null }) {
  const { rows } = await client.query(
    `INSERT INTO agent_exchange (project_id, docket_id, parent_id, agent_id, source_model, to_agent, kind, body_caveman, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, COALESCE($9, NOW()))
     RETURNING id, parent_id, created_at, created_at::text AS created_at_raw`,
    [projectId, docketId, parentId, agentId, sourceModel, toAgent, kind, body, createdAt]
  );
  return rows[0];
}

/** E-1+E-3: compound cursor (created_at, id) watermark poll -- never created_at
 * alone. `afterCreatedAt` MUST be a full-precision text value (e.g. a prior
 * row's created_at_raw), cast back to timestamptz server-side -- never a
 * JS Date, which would silently truncate to millisecond precision (see the
 * NOTE above insertExchange). */
async function pollWatermark(client, { projectId, toAgent, afterCreatedAt, afterId }) {
  const { rows } = await client.query(
    `SELECT id, parent_id, agent_id, to_agent, kind, body_caveman, created_at, created_at::text AS created_at_raw
       FROM agent_exchange
      WHERE project_id = $1
        AND (to_agent = $2 OR to_agent IS NULL)
        AND (created_at, id) > ($3::timestamptz, $4)
      ORDER BY created_at, id`,
    [projectId, toAgent, afterCreatedAt, afterId]
  );
  return rows;
}

// ─── The checks ──────────────────────────────────────────────────────────

// CHECK 1: POST + BROADCAST + WATERMARK POLL (E-1+E-3 -- compound cursor).
// Every fixture row in this check shares one transaction_timestamp() value,
// so the check deliberately does NOT rely on wall-clock separation: the
// SECOND poll uses the cursor RETURNED by the first poll's own last row
// (created_at, id) -- proving the compound cursor excludes prior rows even
// when every row shares one created_at value, immune to same-timestamp ties.
async function checkPostBroadcastWatermark(client, PREFIX) {
  const projectId = `${PREFIX}-proj-c1`;
  const agentA = `${PREFIX}-agent-a-c1`;
  const agentB = `${PREFIX}-agent-b-c1`;
  const agentC = `${PREFIX}-agent-c-c1`; // decoy -- must never appear in agentB's poll

  const addressed = await insertExchange(client, { projectId, agentId: agentA, toAgent: agentB, kind: 'proposal', body: 'addressed to b' });
  const broadcast = await insertExchange(client, { projectId, agentId: agentA, toAgent: null, kind: 'observation', body: 'broadcast to all' });
  await insertExchange(client, { projectId, agentId: agentA, toAgent: agentC, kind: 'proposal', body: 'addressed to c -- must not appear for b' });

  const first = await pollWatermark(client, { projectId, toAgent: agentB, afterCreatedAt: '1970-01-01T00:00:00Z', afterId: 0 });
  assertEq(first.length, 2, `expected exactly 2 rows (addressed + broadcast) for agentB's first poll, got ${first.length}`);
  assertEq(first[0].id, addressed.id, 'addressed-then-broadcast insert order must be preserved by (created_at, id) ordering');
  assertEq(first[1].id, broadcast.id, 'broadcast row must be second (inserted after addressed, same created_at)');
  assert(!first.some((r) => r.to_agent === agentC), 'agentC-addressed row must never appear in agentB\'s poll');

  const last = first[first.length - 1];
  const second = await pollWatermark(client, { projectId, toAgent: agentB, afterCreatedAt: last.created_at_raw, afterId: last.id });
  assertEq(second.length, 0, 'a watermark cursored past the last-seen (created_at, id) must exclude both already-seen rows, even though they share one created_at value');
}

// CHECK 2: THREADED REPLY -- response row with parent_id set; thread
// reconstruction via the parent chain (3 levels: root -> reply -> reply).
async function checkThreadedReply(client, PREFIX) {
  const projectId = `${PREFIX}-proj-c2`;
  const agentA = `${PREFIX}-agent-a-c2`;
  const agentB = `${PREFIX}-agent-b-c2`;

  const root = await insertExchange(client, { projectId, agentId: agentA, kind: 'proposal', body: 'root proposal' });
  const reply1 = await insertExchange(client, { projectId, parentId: root.id, agentId: agentB, kind: 'response', body: 'first reply' });
  const reply2 = await insertExchange(client, { projectId, parentId: reply1.id, agentId: agentA, kind: 'response', body: 'second reply' });

  const { rows } = await client.query(
    `SELECT id, parent_id, kind FROM agent_exchange WHERE id IN ($1, $2, $3)`,
    [root.id, reply1.id, reply2.id]
  );
  const byId = new Map(rows.map((r) => [r.id, r]));

  assertEq(byId.get(root.id).parent_id, null, 'root row must have no parent');
  assertEq(byId.get(reply1.id).parent_id, root.id, 'reply1.parent_id must chain to root');
  assertEq(byId.get(reply2.id).parent_id, reply1.id, 'reply2.parent_id must chain to reply1');

  // Walk the chain from the leaf back to the root -- reconstruction.
  const chain = [reply2.id];
  let cursor = byId.get(reply2.id).parent_id;
  while (cursor !== null) {
    chain.push(cursor);
    const { rows: r } = await client.query('SELECT parent_id FROM agent_exchange WHERE id = $1', [cursor]);
    cursor = r[0].parent_id;
  }
  assertEq(chain.length, 3, `expected a 3-row chain, got ${chain.length}`);
  assertEq(chain[2], root.id, 'chain reconstruction must terminate at the root row');
}

// CHECK 3: WORKED CROSS-AGENT EXAMPLE (adapted -- the findings seam table
// doesn't exist yet, so the second write is an attributed assertions row
// instead). Synthetic agent A posts a proposal; synthetic agent B polls,
// writes an attributed assertion (source_model/agent_id = B's synthetic
// label), then posts a threaded response. Asserts attribution columns
// landed and the thread links.
async function checkWorkedCrossAgentExample(client, PREFIX) {
  const projectId = `${PREFIX}-proj-c3`;
  const agentA = `${PREFIX}-agent-a-c3`;
  const agentB = `${PREFIX}-agent-b-c3`;

  const proposal = await insertExchange(client, { projectId, agentId: agentA, sourceModel: agentA, kind: 'proposal', body: 'please review the migrate-13 design' });

  const polled = await pollWatermark(client, { projectId, toAgent: agentB, afterCreatedAt: '1970-01-01T00:00:00Z', afterId: 0 });
  assertEq(polled.length, 1, 'agentB must see exactly the one broadcast proposal');
  assertEq(polled[0].id, proposal.id, 'polled row must be the proposal agentA posted');

  const { rows: assertionRows } = await client.query(
    `INSERT INTO assertions (project_id, subject, predicate, object, confidence, source, source_model, agent_id)
     VALUES ($1, $2, 'reviewed_by', $3, 8, 'model_extracted', $4, $4)
     RETURNING id, source_model, agent_id`,
    [projectId, `${PREFIX}-subject-c3`, agentB, agentB]
  );
  assertEq(assertionRows[0].source_model, agentB, 'attributed assertion source_model must be agentB\'s synthetic label');
  assertEq(assertionRows[0].agent_id, agentB, 'attributed assertion agent_id must be agentB\'s synthetic label');

  const response = await insertExchange(client, { projectId, parentId: proposal.id, agentId: agentB, sourceModel: agentB, toAgent: agentA, kind: 'response', body: 'reviewed -- filed an attributed assertion, see thread' });
  assertEq(response.parent_id, proposal.id, 'response.parent_id must link the thread back to the original proposal');
}

// CHECK 4: TAMPER-EVIDENCE UPDATE -- raw UPDATE succeeds AND audit_log
// captures table_name/operation/row_id/db_user/old_row/new_row (old vs new
// diff asserted on the changed field).
async function checkTamperEvidenceUpdate(client, PREFIX) {
  const projectId = `${PREFIX}-proj-c4`;
  const agentA = `${PREFIX}-agent-a-c4`;

  const row = await insertExchange(client, { projectId, agentId: agentA, kind: 'proposal', body: 'original body' });

  const { rows: updated } = await client.query(
    `UPDATE agent_exchange SET body_caveman = $1 WHERE id = $2 RETURNING id, body_caveman`,
    ['mutated body -- tamper-evidence check', row.id]
  );
  assertEq(updated[0].body_caveman, 'mutated body -- tamper-evidence check', 'the raw UPDATE itself must succeed (detection, not prevention)');

  const { rows: audit } = await client.query(
    `SELECT table_name, operation, row_id, db_user, old_row, new_row FROM audit_log
      WHERE table_name = 'agent_exchange' AND operation = 'UPDATE' AND row_id = $1
      ORDER BY id DESC LIMIT 1`,
    [row.id]
  );
  assertEq(audit.length, 1, 'expected exactly one audit_log row for this UPDATE');
  const a = audit[0];
  assertEq(a.table_name, 'agent_exchange');
  assertEq(a.operation, 'UPDATE');
  assertEq(Number(a.row_id), row.id);
  assert(typeof a.db_user === 'string' && a.db_user.length > 0, 'db_user must be captured');
  assertEq(a.old_row.body_caveman, 'original body', 'old_row must capture the pre-UPDATE value');
  assertEq(a.new_row.body_caveman, 'mutated body -- tamper-evidence check', 'new_row must capture the post-UPDATE value');
  assert(!Object.prototype.hasOwnProperty.call(a.old_row, 'embedding'), 'old_row must strip the embedding key (ADVERSARY-PASS A-3)');
  assert(!Object.prototype.hasOwnProperty.call(a.new_row, 'embedding'), 'new_row must strip the embedding key (ADVERSARY-PASS A-3)');
}

// CHECK 5: TAMPER-EVIDENCE DELETE -- raw DELETE succeeds AND audit_log
// captures the full old_row, new_row NULL.
async function checkTamperEvidenceDelete(client, PREFIX) {
  const projectId = `${PREFIX}-proj-c5`;
  const agentA = `${PREFIX}-agent-a-c5`;

  const row = await insertExchange(client, { projectId, agentId: agentA, kind: 'proposal', body: 'to be deleted' });

  const del = await client.query(`DELETE FROM agent_exchange WHERE id = $1`, [row.id]);
  assertEq(del.rowCount, 1, 'the raw DELETE itself must succeed (detection, not prevention)');

  const { rows: audit } = await client.query(
    `SELECT table_name, operation, row_id, db_user, old_row, new_row FROM audit_log
      WHERE table_name = 'agent_exchange' AND operation = 'DELETE' AND row_id = $1
      ORDER BY id DESC LIMIT 1`,
    [row.id]
  );
  assertEq(audit.length, 1, 'expected exactly one audit_log row for this DELETE');
  const a = audit[0];
  assertEq(a.operation, 'DELETE');
  assertEq(Number(a.row_id), row.id);
  assertEq(a.old_row.body_caveman, 'to be deleted', 'old_row must capture the full pre-DELETE row');
  assertEq(a.old_row.project_id, projectId, 'old_row must be the full row, not a partial snapshot');
  assert(a.new_row === null, 'new_row must be NULL for a DELETE');
}

// CHECK 6: TRIGGER COVERAGE REPORT -- every PRESENT table in the 15-table
// checklist + agent_exchange must be wired (else FAIL); absent tables are
// printed as deferred, never a failure.
async function checkTriggerCoverageReport(client) {
  const { rows: trigRows } = await client.query(
    `SELECT tgname FROM pg_trigger WHERE tgname LIKE '%\\_audit' ESCAPE '\\' AND NOT tgisinternal`
  );
  const wiredTriggerNames = new Set(trigRows.map((r) => r.tgname));

  const checklist = ['agent_exchange', ...migrate13.CHECKLIST_TABLES];
  const failures = [];
  const deferred = [];
  const wired = [];

  for (const t of checklist) {
    const { rows: existsRows } = await client.query(
      `SELECT 1 FROM information_schema.tables WHERE table_schema = current_schema() AND table_name = $1`,
      [t]
    );
    const exists = existsRows.length > 0;
    if (!exists) {
      deferred.push(t);
      continue;
    }
    if (wiredTriggerNames.has(`${t}_audit`)) {
      wired.push(t);
    } else {
      failures.push(t);
    }
  }

  console.log(`  [SMOKE-13][6] trigger coverage -- wired: ${wired.join(', ') || '(none)'}; deferred: ${deferred.join(', ') || '(none)'}`);
  assert(failures.length === 0, `present table(s) missing an audit trigger: ${failures.join(', ')}`);
}

// CHECK 7: APPEND-ONLY CONVENTION SANITY -- no status/read_at column exists
// on agent_exchange (guards against a future "helpful" mailbox regression).
async function checkAppendOnlyConventionSanity(client) {
  const { rows } = await client.query(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = 'agent_exchange'
        AND column_name IN ('status', 'read_at')`
  );
  assertEq(rows.length, 0, `agent_exchange must never carry a status/read_at column -- found: ${rows.map((r) => r.column_name).join(', ')}`);
}

// ─── Runner ────────────────────────────────────────────────────────────────

async function checkPrerequisites(client) {
  const { rows } = await client.query(
    `SELECT table_name FROM information_schema.tables
      WHERE table_schema = current_schema() AND table_type = 'BASE TABLE'`
  );
  const actual = new Set(rows.map((r) => r.table_name.toLowerCase()));
  const missing = PREREQUISITE_TABLES.filter((t) => !actual.has(t));
  return { ok: missing.length === 0, missing };
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

  const classification = migrateOne.classifyTarget(target);
  if (!classification.allowed) {
    console.error(`Refused: ${classification.reason}`);
    console.error(`(resolved from ${source} — no database connection was opened.)`);
    process.exit(1);
  }

  console.log(`verify-13-exchange-smoke: target="${target}" (resolved from ${source})`);

  const client = new Client(migrateOne.pgConfig(target));
  try {
    await client.connect();
  } catch (err) {
    console.error(`Could not connect to target database "${target}": ${err.message}`);
    process.exit(1);
  }

  const PREFIX = smokeHarness.makeRunPrefix('13');
  console.log(`  run prefix: ${PREFIX}`);

  try {
    const prereq = await checkPrerequisites(client);
    if (!prereq.ok) {
      console.error(`Refused: target "${target}" is missing prerequisite table(s): ${prereq.missing.join(', ')}.`);
      console.error('Run migrate-13-agent-exchange.js against this target first (after migrate-01-canonical-db.js for assertions), then re-run this smoke test.');
      smokeHarness.printSummary('13', false);
      process.exitCode = 1;
      return;
    }

    let overallOk = await smokeHarness.withTransactionRollback(client, WIPE_TABLES, async () => {
      const results = [];
      results.push(await smokeHarness.runCheck(client, '13', 1, 'POST + BROADCAST + WATERMARK POLL', () => checkPostBroadcastWatermark(client, PREFIX)));
      results.push(await smokeHarness.runCheck(client, '13', 2, 'THREADED REPLY', () => checkThreadedReply(client, PREFIX)));
      results.push(await smokeHarness.runCheck(client, '13', 3, 'WORKED CROSS-AGENT EXAMPLE', () => checkWorkedCrossAgentExample(client, PREFIX)));
      results.push(await smokeHarness.runCheck(client, '13', 4, 'TAMPER-EVIDENCE UPDATE', () => checkTamperEvidenceUpdate(client, PREFIX)));
      results.push(await smokeHarness.runCheck(client, '13', 5, 'TAMPER-EVIDENCE DELETE', () => checkTamperEvidenceDelete(client, PREFIX)));
      results.push(await smokeHarness.runCheck(client, '13', 6, 'TRIGGER COVERAGE REPORT', () => checkTriggerCoverageReport(client)));
      results.push(await smokeHarness.runCheck(client, '13', 7, 'APPEND-ONLY CONVENTION SANITY', () => checkAppendOnlyConventionSanity(client)));
      return results.every(Boolean);
    });

    const residue = await smokeHarness.scanForResidue(client, PREFIX, RESIDUE_SPECS);
    if (residue.length > 0) {
      console.log(`[SMOKE-13][residue] FAIL post-rollback residue detected: ${residue.join('; ')}`);
      overallOk = false;
    } else {
      console.log('[SMOKE-13][residue] PASS zero residue post-rollback');
    }

    smokeHarness.printSummary('13', overallOk);
    process.exitCode = overallOk ? 0 : 1;
  } finally {
    await client.end();
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err && err.stack ? err.stack : err);
    smokeHarness.printSummary('13', false);
    process.exitCode = 1;
  });
}

module.exports = {
  parseArgs,
  UsageError,
  PREREQUISITE_TABLES,
  checkPrerequisites,
  insertExchange,
  pollWatermark,
};
