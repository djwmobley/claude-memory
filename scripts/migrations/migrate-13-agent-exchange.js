'use strict';

/**
 * migrate-13-agent-exchange.js
 *
 * Applies scripts/migrations/sql/migrate-13-agent-exchange.sql (schema-setup
 * only, no data migration) against a migrate-01 + migrate-schema-addenda
 * target: the agent_exchange append-only A2A exchange log, and the generic
 * audit_log + log_guarded_change() tamper-evidence infrastructure, wired
 * onto every append-only table that already exists in the target.
 *
 * WHAT THIS SCRIPT DOES:
 *   1. Resolves + validates the target database name — IDENTICAL resolution
 *      to migrate-01-canonical-db.js / migrate-schema-addenda.js (--db flag,
 *      then MIGRATE_TARGET_DB env, then memory_manager_staging), reusing
 *      migrate-01's own resolveTargetDb/classifyTarget/DB_NAME_RE/pgConfig
 *      by reference. Never reads HANDOFF_DB.
 *   2. Confirms the target database EXISTS (via migrate-schema-addenda.js's
 *      own exported checkDbExists — a maintenance-DB `postgres` connection
 *      querying pg_database — reused by reference, never forked) before
 *      opening any connection to the target itself. This script does NOT
 *      create the target database.
 *   3. Confirms the engine-core tables (entities/assertions/edges) already
 *      exist in the target, naming migrate-01-canonical-db.js if not — a
 *      hard, up-front refusal, nothing applied. Also probes pgvector
 *      presence; ABSENCE of pgvector is reported and degrades later
 *      verification steps (embedding column, HNSW index) to SKIPPED, but is
 *      NOT itself a refusal — the shipped SQL is designed to degrade
 *      gracefully on a pgvector-absent target (ADVERSARY-PASS A-1), so the
 *      runner's prerequisite gate mirrors that: pgvector is checked and
 *      reported, never a hard blocker.
 *   4. Applies the one SQL file via migrate-01's own applySqlFile (no
 *      psql/pg_dump shell-outs).
 *   5. Verifies the result in two layers:
 *        (a) GENERIC derived verification (F-2 — migrate-schema-addenda.js
 *            is imported and called with THIS script's own SQL file list,
 *            via its already-exported deriveSchemaAddenda/verifyAddenda —
 *            migrate-schema-addenda.js itself is NOT modified in any way):
 *            tables, columns (+ declared type, EXCLUDING embedding — see
 *            D-4 below), CHECK constraints, plain indexes (name + partial-
 *            WHERE presence), UNIQUE constraints, seed rows (none shipped
 *            by this migration, so this layer is vacuously satisfied for
 *            seeds).
 *        (b) MIGRATE-13-SPECIFIC checks the generic layer cannot express:
 *            - embedding column type via migrate-01's probeColumnType
 *              (D-4) — NOT the addenda runner's information_schema type
 *              map (pgvector types report 'USER-DEFINED' there).
 *            - HNSW index definition (D-3) — indexdef must contain hnsw,
 *              embedding, and halfvec, not just exist by name.
 *            - log_guarded_change() existence (pg_proc) + body (D-2) —
 *              pg_get_functiondef must contain both INSERT INTO audit_log
 *              branches.
 *            - agent_exchange_audit trigger existence AND both UPDATE and
 *              DELETE events (D-1) — event-level, not name-level.
 *            - Trigger-wiring classification across the 15-table checklist
 *              (assertions, edges, 13 §5.3 seam tables): wired / FAIL
 *              (present, not wired, or wired but missing an event) /
 *              absent-deferred (reported, never a failure).
 *            - Conditional FK (agent_exchange_docket_fk), a total 4-state
 *              classification (C-1): validated / added-not-validated
 *              (orphan docket_id ids listed, capped at 20) / deferred
 *              (tasks absent) / FAIL (tasks present, constraint absent).
 *
 * WHAT THIS SCRIPT DELIBERATELY DOES NOT DO (out of scope):
 *   - No data migration, no MCP exchange_append/exchange_read tools, no
 *     concrete AgentProvider/EmbeddingProvider, no seam-table creation
 *     (§5.3 — decisions/gotchas/etc. ship in a later migration wave), no
 *     full-checklist row-count gate (that belongs to the migration-phase
 *     issue, not this script), no change to handoff.js.
 *   - It never reads HANDOFF_DB and never creates the target database.
 *
 * TARGET RESOLUTION / CONNECTION CONFIG: identical to migrate-schema-
 * addenda.js — see that script's header comment for the full rationale.
 *
 * Usage:
 *   node scripts/migrations/migrate-13-agent-exchange.js [--db <name>]
 *
 * Exit codes: 0 = PASS, 1 = refused / prerequisite missing / apply failure /
 * verification failure, 2 = bad CLI usage.
 */

const path = require('path');
const { Client } = require('pg');

const migrateOne = require('./migrate-01-canonical-db');
// Imported by reference only (F-2 — ADVERSARY-PASS AMENDMENTS). This file's
// exported helpers already take (client, sqlFiles) parameters, so they are
// called here with migrate-13's own SQL file list. migrate-schema-addenda.js
// itself is NOT modified anywhere in this PR, and its own 30-case suite runs
// unmodified and green.
const addenda = require('./migrate-schema-addenda');

// ─── PATHS ────────────────────────────────────────────────────────────────────

const MIGRATIONS_DIR = __dirname;
const SQL_DIR = path.join(MIGRATIONS_DIR, 'sql');
const SQL_FILE = path.join(SQL_DIR, 'migrate-13-agent-exchange.sql');
const SQL_FILES = [SQL_FILE];

// Engine-core tables this migration's DDL depends on existing already (the
// self-FK on agent_exchange.parent_id and the audit-trigger wiring onto
// assertions/edges both require them). Naming migrate-01-canonical-db.js on
// refusal, same convention as migrate-schema-addenda.js's own
// PREREQUISITE_TABLES.
const PREREQUISITE_TABLES = ['entities', 'assertions', 'edges'];

// 16-table audit-trigger wiring checklist (Deliverable 1b / §5.8 in the
// origin design): assertions + edges + entities (exist on any migrate-01
// target — effectively unconditional, but still run through the same
// guarded gate as everything else, never special-cased) + the 13 §5.3 seam
// tables, expected ABSENT today and wired automatically whenever this file
// is re-applied after a later migration wave creates them. audit_log is
// deliberately NOT in this list — see the SQL file's own comment
// (ADVERSARY-PASS B-3): an audit_log_audit trigger must never exist.
//
// §8 M-4 amendment (memory-manager#18): 'entities' added — the canonical
// wired set (this checklist + agent_exchange, checked separately via
// agentExchangeTriggerOk below) grows 16 -> 17. edges was ALREADY in this
// list; only entities was missing.
const CHECKLIST_TABLES = [
  'assertions', 'edges', 'entities',
  'decisions', 'gotchas', 'findings', 'research', 'incidents',
  'code_index', 'tasks', 'checklist_items', 'corpus_files',
  'workflow_discovery', 'agent_rewrites', 'policy_sections', 'session_chunks',
];

// ─── CLI ARGS ─────────────────────────────────────────────────────────────────

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
    'Usage: node scripts/migrations/migrate-13-agent-exchange.js [--db <name>]',
    '',
    '  --db <name>  Target database name (else MIGRATE_TARGET_DB env, else',
    '               memory_manager_staging). Never reads HANDOFF_DB. The',
    '               target database must already exist (this script does not',
    '               create databases) and must already carry the',
    '               entities/assertions/edges engine-core tables.',
  ].join('\n'));
}

// ─── PREREQUISITE CHECKS ──────────────────────────────────────────────────────

/** Check that entities/assertions/edges already exist in the (connected) target. */
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
 * Informational only — NEVER a refusal (see header comment). Feeds the
 * degraded-SKIP branches of the embedding-column and HNSW-index checks.
 */
async function checkPgvectorPresent(client) {
  const { rows } = await client.query(`SELECT extversion FROM pg_extension WHERE extname = 'vector'`);
  return rows.length > 0;
}

// ─── MIGRATE-13-SPECIFIC VERIFICATION (D-1..D-4, C-1) ─────────────────────────

/** Distinct trigger events (e.g. {'UPDATE','DELETE'}) for a named trigger on a table (D-1). */
async function getTriggerEvents(client, table, triggerName) {
  const { rows } = await client.query(
    `SELECT DISTINCT event_manipulation FROM information_schema.triggers
      WHERE event_object_schema = current_schema()
        AND event_object_table = $1
        AND trigger_name = $2`,
    [table, triggerName]
  );
  return new Set(rows.map((r) => r.event_manipulation));
}

/** D-4: embedding column type via probeColumnType (imported from migrate-01), NOT the
 * addenda runner's information_schema/data_type map (pgvector types report
 * 'USER-DEFINED' there). Degrades to SKIPPED when pgvector is absent. */
async function checkEmbeddingColumn(client, pgvectorPresent) {
  const coltype = await migrateOne.probeColumnType(client, 'agent_exchange', 'embedding');
  if (!pgvectorPresent) {
    return { status: 'SKIPPED-degraded', coltype };
  }
  const ok = coltype === 'halfvec(4000)';
  return { status: ok ? 'PASS' : 'FAIL', coltype };
}

/** D-3: index DEFINITION check, not name-only existence. Degrades to SKIPPED
 * when pgvector is absent; on a pgvector-present target, absence of the
 * index itself is a FAIL. */
async function checkHnswIndex(client, pgvectorPresent) {
  const { rows } = await client.query(
    `SELECT indexdef FROM pg_indexes
      WHERE schemaname = current_schema() AND indexname = 'agent_exchange_embedding_idx'`
  );
  if (rows.length === 0) {
    return pgvectorPresent
      ? { status: 'FAIL', reason: 'agent_exchange_embedding_idx is missing on a pgvector-present target' }
      : { status: 'SKIPPED-degraded', reason: 'pgvector absent' };
  }
  const def = rows[0].indexdef;
  // Plain substring checks (case-insensitive), not \b-bounded -- "halfvec"
  // is immediately followed by "_cosine_ops" in the shipped opclass name,
  // and "_" is a word character, so a \b-anchored regex would never match
  // it. Mirrors the constraint-def substring-grep precedent used elsewhere
  // in this codebase (e.g. migrate-schema-addenda.js's CHECK-clause check).
  const ok = /hnsw/i.test(def) && /embedding/i.test(def) && /halfvec/i.test(def);
  return {
    status: ok ? 'PASS' : 'FAIL',
    reason: ok ? null : `indexdef missing an expected token (hnsw/embedding/halfvec): ${def}`,
    indexdef: def,
  };
}

/** D-2: function existence (pg_proc) AND body (pg_get_functiondef must contain
 * both INSERT INTO audit_log branches — the UPDATE branch and the DELETE
 * branch). A stub replacement with an unrelated body is a FAIL here, not
 * just a name-match PASS. */
async function checkGuardFunction(client) {
  const { rows } = await client.query(`SELECT 1 FROM pg_proc WHERE proname = 'log_guarded_change'`);
  if (rows.length === 0) {
    return { exists: false, bodyOk: false, reason: 'log_guarded_change() not found in pg_proc' };
  }
  const { rows: defRows } = await client.query(`SELECT pg_get_functiondef('log_guarded_change'::regproc) AS def`);
  const def = defRows[0].def;
  const insertCount = (def.match(/INSERT INTO audit_log/gi) || []).length;
  const bodyOk = insertCount >= 2;
  return { exists: true, bodyOk, reason: bodyOk ? null : `expected 2 "INSERT INTO audit_log" branches, found ${insertCount}`, def: bodyOk ? undefined : def };
}

/** Trigger-wiring classification across the 15-table checklist (D-1 applied
 * per-table): 'wired' (present, both UPDATE+DELETE events) / 'FAIL'
 * (present but not wired, or wired but missing an event) /
 * 'absent-deferred' (table does not exist yet -- reported, never a
 * failure). */
async function classifyTriggerWiring(client) {
  const results = [];
  for (const t of CHECKLIST_TABLES) {
    const { rows: existsRows } = await client.query(
      `SELECT 1 FROM information_schema.tables
        WHERE table_schema = current_schema() AND table_name = $1 AND table_type = 'BASE TABLE'`,
      [t]
    );
    if (existsRows.length === 0) {
      results.push({ table: t, state: 'absent-deferred' });
      continue;
    }
    const events = await getTriggerEvents(client, t, `${t}_audit`);
    if (events.has('UPDATE') && events.has('DELETE')) {
      results.push({ table: t, state: 'wired' });
    } else if (events.size > 0) {
      results.push({
        table: t, state: 'FAIL',
        reason: `trigger present but missing event(s) -- needs UPDATE+DELETE, found [${[...events].join(', ')}]`,
      });
    } else {
      results.push({ table: t, state: 'FAIL', reason: 'table present but no audit trigger wired' });
    }
  }
  return results;
}

/** C-1: conditional FK, total 4-state classification. */
async function classifyFk(client) {
  const { rows: taskRows } = await client.query(`SELECT to_regclass('tasks') IS NOT NULL AS present`);
  const tasksPresent = taskRows[0].present;

  const { rows: conRows } = await client.query(
    `SELECT con.convalidated
       FROM pg_constraint con
       JOIN pg_class c ON con.conrelid = c.oid
       JOIN pg_namespace n ON c.relnamespace = n.oid
      WHERE con.conname = 'agent_exchange_docket_fk' AND n.nspname = current_schema()`
  );

  if (conRows.length === 0) {
    if (!tasksPresent) return { state: 'deferred', reason: 'tasks table absent' };
    return { state: 'FAIL', reason: 'tasks table present but agent_exchange_docket_fk constraint is absent after apply' };
  }

  if (conRows[0].convalidated) {
    return { state: 'validated' };
  }

  const { rows: orphanRows } = await client.query(
    `SELECT id FROM agent_exchange
      WHERE docket_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM tasks WHERE tasks.id = agent_exchange.docket_id)
      ORDER BY id LIMIT 20`
  );
  return { state: 'added-not-validated', orphanIds: orphanRows.map((r) => r.id) };
}

// ─── FULL VERIFICATION PASS ────────────────────────────────────────────────

/**
 * Run the full verification pass against an already-connected client.
 * Deliberately standalone (not inlined into main()) so it can be exercised
 * directly against a deliberately-perturbed database state, mirroring the
 * seam migrate-01's verifyTarget / addenda's verifyAddenda establish.
 *
 * @param {import('pg').Client} client -- connected to the target database
 * @param {boolean} pgvectorPresent
 */
async function verifyMigration13(client, pgvectorPresent) {
  const generic = await addenda.verifyAddenda(client, SQL_FILES);
  const embedding = await checkEmbeddingColumn(client, pgvectorPresent);
  const hnsw = await checkHnswIndex(client, pgvectorPresent);
  const guardFn = await checkGuardFunction(client);
  const agentExchangeEvents = await getTriggerEvents(client, 'agent_exchange', 'agent_exchange_audit');
  const agentExchangeTriggerOk = agentExchangeEvents.has('UPDATE') && agentExchangeEvents.has('DELETE');
  const triggerWiring = await classifyTriggerWiring(client);
  const triggerWiringFails = triggerWiring.filter((r) => r.state === 'FAIL');
  const fk = await classifyFk(client);

  const pass =
    generic.pass &&
    embedding.status !== 'FAIL' &&
    hnsw.status !== 'FAIL' &&
    guardFn.exists && guardFn.bodyOk &&
    agentExchangeTriggerOk &&
    triggerWiringFails.length === 0 &&
    fk.state !== 'FAIL';

  return { generic, embedding, hnsw, guardFn, agentExchangeTriggerOk, agentExchangeEvents: [...agentExchangeEvents], triggerWiring, triggerWiringFails, fk, pass };
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

  console.log(`migrate-13-agent-exchange: target="${target}" (resolved from ${source})`);

  // ── DB-existence check via maintenance DB, BEFORE any target connection ──
  // (reused by reference from migrate-schema-addenda.js -- F-2)

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
    console.error('This runner does not create databases. Run migrate-01-canonical-db.js first to stand up the target, then re-run this script.');
    process.exit(1);
  }

  // ── Connect to target ────────────────────────────────────────────────────

  const db = new Client(migrateOne.pgConfig(target));
  try {
    await db.connect();
  } catch (err) {
    console.error(`Could not connect to target database "${target}": ${err.message}`);
    process.exit(1);
  }

  try {
    // ── Prerequisite check, BEFORE applying anything ───────────────────────

    const prereq = await checkPrerequisiteTables(db);
    if (!prereq.ok) {
      console.error(`Refused: target "${target}" is missing prerequisite table(s): ${prereq.missing.join(', ')}.`);
      console.error('Run migrate-01-canonical-db.js against this target first to stand up the engine-core schema, then re-run this script. Nothing was applied.');
      process.exitCode = 1;
      return;
    }

    const pgvectorPresent = await checkPgvectorPresent(db);
    console.log(`  pgvector present: ${pgvectorPresent}`);
    if (!pgvectorPresent) {
      console.log('  [WARN] pgvector absent -- embedding column and HNSW index checks below will report SKIPPED-degraded, not FAIL (the shipped SQL degrades gracefully by design).');
    }

    // ── Apply the one SQL file ──────────────────────────────────────────────

    let applyOk = true;
    try {
      await migrateOne.applySqlFile(db, SQL_FILE);
      console.log(`  [OK]   ${path.relative(path.join(MIGRATIONS_DIR, '..'), SQL_FILE)}`);
    } catch (err) {
      applyOk = false;
      console.log(`  [FAIL] ${path.relative(path.join(MIGRATIONS_DIR, '..'), SQL_FILE)}: ${err.message}`);
    }

    // ── Verification ─────────────────────────────────────────────────────

    const v = await verifyMigration13(db, pgvectorPresent);

    console.log(`  derived expected tables: ${v.generic.expectedTables.length} (${v.generic.expectedTables.join(', ')})`);
    console.log(`  missing tables: ${v.generic.missingTables.length ? v.generic.missingTables.join(', ') : '(none)'}`);
    console.log(`  missing columns: ${v.generic.missingColumns.length ? v.generic.missingColumns.map((c) => `${c.table}.${c.column}`).join(', ') : '(none)'}`);
    console.log(`  wrong-type columns: ${v.generic.wrongTypeColumns.length ? v.generic.wrongTypeColumns.map((c) => `${c.table}.${c.column} (expected ${c.expectedType}, found ${c.actualType})`).join(', ') : '(none)'}`);
    console.log(`  missing indexes: ${v.generic.missingIndexes.length ? v.generic.missingIndexes.map((i) => i.name).join(', ') : '(none)'}`);
    console.log(`  malformed indexes: ${v.generic.malformedIndexes.length ? v.generic.malformedIndexes.map((i) => `${i.name}: ${i.reason}`).join(', ') : '(none)'}`);

    console.log(`  agent_exchange.embedding: ${v.embedding.status} (coltype=${v.embedding.coltype === null ? 'ABSENT' : v.embedding.coltype})`);
    console.log(`  agent_exchange_embedding_idx: ${v.hnsw.status}${v.hnsw.reason ? ` -- ${v.hnsw.reason}` : ''}`);
    console.log(`  log_guarded_change(): exists=${v.guardFn.exists} bodyOk=${v.guardFn.bodyOk}${v.guardFn.reason ? ` -- ${v.guardFn.reason}` : ''}`);
    console.log(`  agent_exchange_audit trigger events: [${v.agentExchangeEvents.join(', ')}] (ok=${v.agentExchangeTriggerOk})`);

    console.log('  trigger-wiring checklist (15 tables):');
    for (const r of v.triggerWiring) {
      console.log(`    - ${r.table}: ${r.state}${r.reason ? ` -- ${r.reason}` : ''}`);
    }
    const deferred = v.triggerWiring.filter((r) => r.state === 'absent-deferred').map((r) => r.table);
    console.log(`  deferred (table absent, not yet wired): ${deferred.length ? deferred.join(', ') : '(none)'}`);

    console.log(`  agent_exchange_docket_fk: ${v.fk.state}${v.fk.reason ? ` -- ${v.fk.reason}` : ''}${v.fk.orphanIds ? ` (orphan ids: ${v.fk.orphanIds.join(', ') || '(none listed)'})` : ''}`);

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
  CHECKLIST_TABLES,
  checkPrerequisiteTables,
  checkPgvectorPresent,
  getTriggerEvents,
  checkEmbeddingColumn,
  checkHnswIndex,
  checkGuardFunction,
  classifyTriggerWiring,
  classifyFk,
  verifyMigration13,
};
