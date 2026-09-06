'use strict';

/**
 * migrate-14-seam-tables.js
 *
 * Applies scripts/migrations/sql/migrate-14-seam-tables.sql (13 §5.3
 * absorbed-seam tables + §5.9's v_handoff_card_inputs view + a narrow
 * audit_log.row_id widening -- see that file's own header comment for the
 * two documented deviations from §5.3's verbatim text) and its sidecar
 * migrate-14-seam-tables-embeddings.sql (the embedding halfvec(4000) columns
 * + HNSW indexes, kept in a separate dollar-quoted file per §7.9/S-16 --
 * see that file's header comment) against a migrate-01 + migrate-schema-
 * addenda + migrate-13-agent-exchange target.
 *
 * WHAT THIS SCRIPT DOES NOT DO: it does not wire audit triggers onto the 13
 * seam tables it creates. Trigger wiring is entirely owned by
 * migrate-13-agent-exchange.sql's own idempotent, self-detecting DO block
 * (CHECKLIST_TABLES) -- per the task this script ships under, the correct
 * sequence is: run this script, THEN re-run
 * `node scripts/migrations/migrate-13-agent-exchange.js` (unmodified, reused
 * by reference) so its trigger-wiring DO block finds the now-existing seam
 * tables and wires them automatically. This script deliberately does not
 * fold that re-apply in, to avoid ever forking or reimplementing
 * migrate-13-agent-exchange.js's wiring logic.
 *
 * WHAT THIS SCRIPT DOES:
 *   1. Resolves + validates the target database name -- identical resolution
 *      to migrate-01/migrate-schema-addenda/migrate-13-agent-exchange
 *      (--db flag, then MIGRATE_TARGET_DB env, then memory_manager_staging),
 *      reusing migrate-01's exported helpers by reference. Never reads
 *      HANDOFF_DB.
 *   2. Confirms the target database EXISTS (migrate-schema-addenda.js's
 *      exported checkDbExists, reused by reference) before opening any
 *      connection to the target itself. Does not create the target
 *      database.
 *   3. Confirms prerequisite tables (entities, assertions, edges, audit_log,
 *      agent_exchange -- the last two from migrate-13-agent-exchange.js)
 *      already exist. A missing prerequisite is a hard, up-front refusal,
 *      nothing applied.
 *   4. Applies the two SQL files, in order (tables+view+widening, then
 *      embeddings), via migrate-01's own applySqlFile.
 *   5. Verifies the result in three layers:
 *        (a) GENERIC derived verification (migrate-schema-addenda.js's
 *            exported deriveSchemaAddenda/verifyAddenda, reused by
 *            reference) against ONLY migrate-14-seam-tables.sql (the
 *            dollar-quote-free file) -- tables, columns (excluding
 *            embedding), CHECK constraints, plain indexes, UNIQUE
 *            constraints.
 *        (b) SEAM-SPECIFIC checks the generic layer cannot express: the
 *            embedding column type + HNSW index definition for each of the
 *            13 seam tables (mirrors migrate-13-agent-exchange.js's D-3/D-4
 *            checkEmbeddingColumn/checkHnswIndex, generalized into a loop),
 *            and the audit_log.row_id widening (data_type = 'text').
 *        (c) v_handoff_card_inputs view: existence (pg_views) + a
 *            BEHAVIORAL probe (post-review fix, G2 -- NOT a pg_get_viewdef
 *            text/substring match, which is defeatable by an AND->OR edit
 *            that keeps the same tokens): 4 probe assertion rows are
 *            inserted inside a transaction (one that should be visible,
 *            three that each individually trip one of the view's filter
 *            predicates -- suppressed / invalid_at / carryover_status='
 *            resolved', the S-14 defense predicate specifically), the view
 *            is queried, exactly the one valid row must be visible, then
 *            the transaction is unconditionally ROLLED BACK (zero residue
 *            -- INSERT never fires the assertions_audit trigger).
 *
 * Usage:
 *   node scripts/migrations/migrate-14-seam-tables.js [--db <name>]
 *
 * Exit codes: 0 = PASS, 1 = refused / prerequisite missing / apply failure /
 * verification failure, 2 = bad CLI usage.
 */

const path = require('path');
const { Client } = require('pg');

const migrateOne = require('./migrate-01-canonical-db');
const addenda = require('./migrate-schema-addenda');   // reused by reference (never forked)
const exchange13 = require('./migrate-13-agent-exchange'); // reused by reference (checkDbExists helper origin)

// ─── PATHS ────────────────────────────────────────────────────────────────────

const MIGRATIONS_DIR = __dirname;
const SQL_DIR = path.join(MIGRATIONS_DIR, 'sql');
const SQL_FILE_TABLES = path.join(SQL_DIR, 'migrate-14-seam-tables.sql');
const SQL_FILE_EMBEDDINGS = path.join(SQL_DIR, 'migrate-14-seam-tables-embeddings.sql');
// Apply order: tables (+ view + row_id widening) BEFORE embeddings (which
// ALTERs those same tables to add the embedding column).
const SQL_FILES_APPLY = [SQL_FILE_TABLES, SQL_FILE_EMBEDDINGS];
// Passed to the generic addenda.verifyAddenda layer -- the dollar-quote-free
// file ONLY (§7.9/S-16).
const SQL_FILES_GENERIC_VERIFY = [SQL_FILE_TABLES];

const PREREQUISITE_TABLES = ['entities', 'assertions', 'edges', 'audit_log', 'agent_exchange'];

// The 13 §5.3 seam tables -- single source of truth for the per-table
// embedding/HNSW loop below (mirrors migrate-13-agent-exchange.js's own
// CHECKLIST_TABLES precedent of a short, explicit, hand-maintained constant
// for a set the SQL files don't declare in a form the generic derivation
// layer could read back out of DO-block text).
const SEAM_TABLES = [
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
    'Usage: node scripts/migrations/migrate-14-seam-tables.js [--db <name>]',
    '',
    '  --db <name>  Target database name (else MIGRATE_TARGET_DB env, else',
    '               memory_manager_staging). Never reads HANDOFF_DB. The',
    '               target database must already exist and already carry',
    '               entities/assertions/edges/audit_log/agent_exchange.',
    '               After this script PASSes, re-run',
    '               migrate-13-agent-exchange.js to wire audit triggers',
    '               onto the newly-created seam tables.',
  ].join('\n'));
}

// ─── PREREQUISITE CHECK ───────────────────────────────────────────────────────

async function checkPrerequisiteTables(client) {
  const { rows } = await client.query(
    `SELECT table_name FROM information_schema.tables
      WHERE table_schema = current_schema() AND table_type = 'BASE TABLE'`
  );
  const actual = new Set(rows.map((r) => r.table_name.toLowerCase()));
  const missing = PREREQUISITE_TABLES.filter((t) => !actual.has(t));
  return { ok: missing.length === 0, missing };
}

async function checkPgvectorPresent(client) {
  const { rows } = await client.query(`SELECT extversion FROM pg_extension WHERE extname = 'vector'`);
  return rows.length > 0;
}

// ─── SEAM-SPECIFIC VERIFICATION ───────────────────────────────────────────────

/** Embedding column type via migrate-01's probeColumnType (NOT information_schema,
 * which reports pgvector types as USER-DEFINED). Degrades to SKIPPED when
 * pgvector is absent -- mirrors migrate-13-agent-exchange.js's checkEmbeddingColumn. */
async function checkEmbeddingColumn(client, table, pgvectorPresent) {
  const coltype = await migrateOne.probeColumnType(client, table, 'embedding');
  if (!pgvectorPresent) {
    return { table, status: 'SKIPPED-degraded', coltype };
  }
  const ok = coltype === 'halfvec(4000)';
  return { table, status: ok ? 'PASS' : 'FAIL', coltype };
}

/** HNSW index definition check -- mirrors migrate-13-agent-exchange.js's checkHnswIndex. */
async function checkHnswIndex(client, table, pgvectorPresent) {
  const { rows } = await client.query(
    `SELECT indexdef FROM pg_indexes
      WHERE schemaname = current_schema() AND indexname = $1`,
    [`${table}_embedding_idx`]
  );
  if (rows.length === 0) {
    return pgvectorPresent
      ? { table, status: 'FAIL', reason: `${table}_embedding_idx is missing on a pgvector-present target` }
      : { table, status: 'SKIPPED-degraded', reason: 'pgvector absent' };
  }
  const def = rows[0].indexdef;
  const ok = /hnsw/i.test(def) && /embedding/i.test(def) && /halfvec/i.test(def);
  return {
    table,
    status: ok ? 'PASS' : 'FAIL',
    reason: ok ? null : `indexdef missing an expected token (hnsw/embedding/halfvec): ${def}`,
    indexdef: def,
  };
}

/** Deviation (2) -- audit_log.row_id widened BIGINT -> TEXT (see
 * migrate-14-seam-tables.sql's header comment for the full rationale). */
async function checkRowIdWidened(client) {
  const { rows } = await client.query(
    `SELECT data_type FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = 'audit_log' AND column_name = 'row_id'`
  );
  if (rows.length === 0) return { status: 'FAIL', reason: 'audit_log.row_id column not found' };
  const ok = rows[0].data_type === 'text';
  return { status: ok ? 'PASS' : 'FAIL', dataType: rows[0].data_type };
}

/** v_handoff_card_inputs (§5.9): existence + the S-14 defense-in-depth
 * predicate present in its definition. */
/**
 * checkHandoffCardView — v_handoff_card_inputs (§5.9): BEHAVIORAL check
 * (post-review fix, G2), not text-matching.
 *
 * The prior implementation substring-matched pg_get_viewdef()'s SQL text
 * for the S-14 defense-in-depth predicate. That is defeatable: an
 * AND -> OR edit (or any other semantically-destructive rewrite that keeps
 * the same tokens) passes a substring check while disabling every filter
 * the view is supposed to apply. This version instead inserts 4 probe
 * assertion rows inside a transaction -- one that SHOULD be visible
 * through the view, and three that each individually trip exactly ONE of
 * the view's filter predicates (suppressed=true / invalid_at set /
 * carryover_status='resolved') -- queries the view, asserts EXACTLY the
 * one valid probe row is visible, then ROLLS BACK unconditionally. Zero
 * residue: assertions_audit only fires on UPDATE/DELETE (never INSERT), so
 * this leaves no audit_log rows behind either, and the ROLLBACK discards
 * the probe rows themselves.
 */
async function checkHandoffCardView(client) {
  const { rows: viewRows } = await client.query(
    `SELECT 1 FROM pg_views WHERE schemaname = current_schema() AND viewname = 'v_handoff_card_inputs'`
  );
  if (viewRows.length === 0) return { status: 'FAIL', reason: 'v_handoff_card_inputs view not found' };

  const probeProjectId = `t14-viewcheck-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  let status = 'FAIL';
  let reason = null;
  let observedSubjects = null;

  await client.query('BEGIN');
  try {
    const probes = [
      // { subject, carryover_status, suppressed, invalidAt, expectVisible }
      { subject: 'probe-valid',       carryover_status: 'open',     suppressed: false, invalidAt: false, expectVisible: true },
      { subject: 'probe-suppressed',  carryover_status: 'open',     suppressed: true,  invalidAt: false, expectVisible: false },
      { subject: 'probe-invalidated', carryover_status: 'open',     suppressed: false, invalidAt: true,  expectVisible: false },
      { subject: 'probe-resolved',    carryover_status: 'resolved', suppressed: false, invalidAt: false, expectVisible: false },
    ];
    for (const p of probes) {
      await client.query(
        `INSERT INTO assertions
           (project_id, subject, predicate, object, confidence, source, carryover_status, suppressed, invalid_at)
         VALUES ($1, $2, 'open_thread', $3, 8, 'user_stated', $4, $5, ${p.invalidAt ? 'now()' : 'NULL'})`,
        [probeProjectId, p.subject, `${p.subject} object text`, p.carryover_status, p.suppressed]
      );
    }

    const { rows: viewResults } = await client.query(
      `SELECT subject FROM v_handoff_card_inputs WHERE project_id = $1 ORDER BY subject`,
      [probeProjectId]
    );
    observedSubjects = viewResults.map((r) => r.subject);
    const expectedVisible = probes.filter((p) => p.expectVisible).map((p) => p.subject).sort();

    if (JSON.stringify(observedSubjects) === JSON.stringify(expectedVisible)) {
      status = 'PASS';
    } else {
      status = 'FAIL';
      reason = `expected exactly ${JSON.stringify(expectedVisible)} visible through the view, got ${JSON.stringify(observedSubjects)}`;
    }
  } catch (err) {
    status = 'FAIL';
    reason = `probe insert/query error: ${err.message}`;
  } finally {
    await client.query('ROLLBACK'); // unconditional -- zero residue regardless of outcome above
  }

  return { status, reason, observedSubjects };
}

// ─── FULL VERIFICATION PASS ────────────────────────────────────────────────

async function verifyMigration14(client, pgvectorPresent) {
  const generic = await addenda.verifyAddenda(client, SQL_FILES_GENERIC_VERIFY);

  const embeddingResults = [];
  const hnswResults = [];
  for (const t of SEAM_TABLES) {
    embeddingResults.push(await checkEmbeddingColumn(client, t, pgvectorPresent));
    hnswResults.push(await checkHnswIndex(client, t, pgvectorPresent));
  }
  const embeddingFails = embeddingResults.filter((r) => r.status === 'FAIL');
  const hnswFails = hnswResults.filter((r) => r.status === 'FAIL');

  const rowIdWidened = await checkRowIdWidened(client);
  const handoffCardView = await checkHandoffCardView(client);

  const pass =
    generic.pass &&
    embeddingFails.length === 0 &&
    hnswFails.length === 0 &&
    rowIdWidened.status === 'PASS' &&
    handoffCardView.status === 'PASS';

  return { generic, embeddingResults, hnswResults, embeddingFails, hnswFails, rowIdWidened, handoffCardView, pass };
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

  const classification = await migrateOne.classifyTarget({ dbName: target });
  if (!classification.allowed) {
    console.error(`Refused: ${classification.reason}`);
    console.error(`(resolved from ${source} — no database connection was opened.)`);
    process.exit(1);
  }

  console.log(`migrate-14-seam-tables: target="${target}" (resolved from ${source})`);

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
      console.error('Run migrate-schema-addenda.js and migrate-13-agent-exchange.js against this target first, then re-run this script. Nothing was applied.');
      process.exitCode = 1;
      return;
    }

    const pgvectorPresent = await checkPgvectorPresent(db);
    console.log(`  pgvector present: ${pgvectorPresent}`);
    if (!pgvectorPresent) {
      console.log('  [WARN] pgvector absent -- embedding column and HNSW index checks below will report SKIPPED-degraded, not FAIL.');
    }

    const fileResults = [];
    for (const file of SQL_FILES_APPLY) {
      const label = path.relative(path.join(MIGRATIONS_DIR, '..'), file);
      try {
        await migrateOne.applySqlFile(db, file);
        fileResults.push({ file: label, ok: true });
        console.log(`  [OK]   ${label}`);
      } catch (err) {
        fileResults.push({ file: label, ok: false, error: err.message });
        console.log(`  [FAIL] ${label}: ${err.message}`);
      }
    }
    const anyFileFailed = fileResults.some((r) => !r.ok);

    const v = await verifyMigration14(db, pgvectorPresent);

    console.log(`  derived expected tables: ${v.generic.expectedTables.length} (${v.generic.expectedTables.join(', ')})`);
    console.log(`  missing tables: ${v.generic.missingTables.length ? v.generic.missingTables.join(', ') : '(none)'}`);
    console.log(`  missing columns: ${v.generic.missingColumns.length ? v.generic.missingColumns.map((c) => `${c.table}.${c.column}`).join(', ') : '(none)'}`);
    console.log(`  wrong-type columns: ${v.generic.wrongTypeColumns.length ? v.generic.wrongTypeColumns.map((c) => `${c.table}.${c.column}`).join(', ') : '(none)'}`);
    console.log(`  missing CHECK constraints: ${v.generic.missingChecks.length ? v.generic.missingChecks.map((c) => `${c.table}.${c.column}`).join(', ') : '(none)'}`);
    console.log(`  missing indexes: ${v.generic.missingIndexes.length ? v.generic.missingIndexes.map((i) => i.name).join(', ') : '(none)'}`);
    console.log(`  missing UNIQUE constraints: ${v.generic.missingUniques.length ? v.generic.missingUniques.map((u) => `${u.table}(${u.columns.join(',')})`).join(', ') : '(none)'}`);

    console.log('  embedding columns (13 seam tables):');
    for (const r of v.embeddingResults) console.log(`    - ${r.table}.embedding: ${r.status} (coltype=${r.coltype === null ? 'ABSENT' : r.coltype})`);
    console.log('  HNSW indexes (13 seam tables):');
    for (const r of v.hnswResults) console.log(`    - ${r.table}_embedding_idx: ${r.status}${r.reason ? ` -- ${r.reason}` : ''}`);

    console.log(`  audit_log.row_id widening (deviation 2): ${v.rowIdWidened.status} (data_type=${v.rowIdWidened.dataType || 'n/a'})`);
    console.log(`  v_handoff_card_inputs (§5.9, S-14 defense predicate, BEHAVIORAL probe): ${v.handoffCardView.status}${v.handoffCardView.reason ? ` -- ${v.handoffCardView.reason}` : ''}`);

    console.log('');
    console.log('  NEXT STEP: re-run `node scripts/migrations/migrate-13-agent-exchange.js` (unmodified) so its trigger-wiring DO block finds these 13 newly-created tables and auto-wires audit triggers onto them.');

    const pass = !anyFileFailed && v.pass;
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
  SQL_FILE_TABLES,
  SQL_FILE_EMBEDDINGS,
  SQL_FILES_APPLY,
  SQL_FILES_GENERIC_VERIFY,
  PREREQUISITE_TABLES,
  SEAM_TABLES,
  checkPrerequisiteTables,
  checkPgvectorPresent,
  checkEmbeddingColumn,
  checkHnswIndex,
  checkRowIdWidened,
  checkHandoffCardView,
  verifyMigration14,
  // re-exported so callers/tests never need to re-require migrate-13-agent-exchange.js separately
  _exchange13: exchange13,
};
