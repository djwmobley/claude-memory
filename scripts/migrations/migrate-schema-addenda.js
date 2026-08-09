'use strict';

/**
 * migrate-schema-addenda.js
 *
 * Second migration in scripts/migrations/. Applies six net-new, schema-only
 * SQL pieces that are prerequisites for later routing/telemetry/interop work
 * but belong to no single migration phase: attribution columns on the
 * engine-core tables, a carryover_status column, a model registry base
 * table, an embedding-providers base table (with one seed row), and the
 * routing-harness and usage-telemetry table groups. See scripts/migrations/
 * sql/*.sql for the DDL itself and each file's own header comment for its
 * origin section.
 *
 * WHAT THIS SCRIPT DOES:
 *   1. Resolves + validates the target database name — IDENTICAL resolution
 *      to migrate-01-canonical-db.js (--db flag, then MIGRATE_TARGET_DB env,
 *      then memory_manager_staging), reusing migrate-01's own exported
 *      resolveTargetDb/classifyTarget/DB_NAME_RE rather than forking them.
 *   2. Confirms the target database EXISTS (via a maintenance-DB `postgres`
 *      connection querying pg_database — see DB-EXISTENCE DETECTION below)
 *      before opening any connection to the target itself. This script does
 *      NOT create the target database; that is migrate-01's job.
 *   3. Confirms the engine-core tables this addendum ALTERs (entities,
 *      assertions, edges) already exist in the target (see PREREQUISITE
 *      CHECK below), before applying anything.
 *   4. Applies the six SQL files, in the explicit order below (NOT filename
 *      lexicographic order — see the ORDER note), via the imported
 *      applySqlFile (no psql/pg_dump shell-outs, same plain pg-client apply
 *      pattern as migrate-01).
 *   5. Verifies the result: derives every expected table, column (+ its
 *      declared type), CHECK constraint, index, and UNIQUE constraint FROM
 *      THE SIX SQL FILES' OWN TEXT at verify time (never a hand-maintained
 *      list — same D-4 rule migrate-01 established), diffs each against the
 *      live catalog, and verifies the embedding_providers seed row's values.
 *
 * WHAT THIS SCRIPT DELIBERATELY DOES NOT DO (out of scope):
 *   - No data migration, no route_resolve/usage_record logic, no MCP tools,
 *     no change to handoff.js's operational resolver, no change to any
 *     verify-15-*.js script, no roster changes.
 *   - It never reads HANDOFF_DB, for the same reason migrate-01 never does:
 *     that env var belongs to the operational resolver, not a schema
 *     migration.
 *
 * TARGET RESOLUTION (identical to migrate-01-canonical-db.js — see its
 * header comment for the full rationale): --db flag, then MIGRATE_TARGET_DB
 * env, then memory_manager_staging built-in default. Refusal is a total
 * classification (unrecognized names are REFUSED, not silently allowed
 * through) and runs BEFORE any database connection is opened.
 *
 * DB-EXISTENCE DETECTION: this script does not create databases, so a
 * missing target is a hard, named refusal rather than an opaque connection
 * error. Existence is checked via a `postgres`-database connection querying
 * pg_database.datname (the same maintenance-connection precedent as
 * migrate-01's ensureDatabaseCreated), BEFORE any connection to the target
 * itself is attempted. A missing target fails loud, naming
 * migrate-01-canonical-db.js as the prerequisite, exit 1. Any OTHER
 * connection or query error at this step (auth failure, network failure,
 * insufficient privilege) surfaces its own real error text — it is never
 * folded into the generic "run migrate-01 first" message, which is reserved
 * strictly for the confirmed-absent case.
 *
 * PREREQUISITE CHECK: even once the target database exists, its schema may
 * not yet include the engine-core tables (entities/assertions/edges) this
 * addendum's ALTER TABLE statements target. That check runs BEFORE any of
 * the six SQL files are applied — not as an afterthought once an ALTER
 * fails, but as an up-front, self-explanatory refusal so the predictable
 * total-failure case (an addendum run against a target migrate-01 has never
 * touched) never silently attempts partial DDL. A missing prerequisite
 * table is a loud FAIL naming migrate-01-canonical-db.js, exit 1, nothing
 * applied. (Failures mid-sequence, once past this up-front check, are a
 * distinct and accepted case — see CONCURRENCY/IDEMPOTENCY below: every file
 * is idempotent and re-runnable, so a partial apply followed by a fix and a
 * re-run is a supported recovery path, not a bug.)
 *
 * ORDER: attribution-columns -> migrate-06-carryover-status ->
 * model-registry-base -> embedding-providers-base ->
 * migrate-10-routing-harness -> migrate-11-usage-telemetry. This is the
 * runner's own explicit SQL_FILES array, never filename lexicographic
 * order — model_registry's base CREATE TABLE must precede migrate-10's
 * ALTERs onto it, and entities/assertions/edges (migrate-01's tables) are a
 * hard prerequisite for the very first file.
 *
 * CONCURRENCY SCOPE (read before running this against a shared target):
 * identical posture to migrate-01-canonical-db.js — this is an operator-run,
 * run-once-per-target setup tool, not a concurrent production code path.
 * The schema-apply phase is NOT wrapped in any lock and is NOT safe against
 * two invocations racing the SAME target concurrently (possible catalog-
 * level collisions). Run it from a single invocation per target. Idempotency
 * (running it twice, sequentially, against the same target) IS a hard
 * requirement and is exercised by the test suite.
 *
 * CONNECTION CONFIG: same standard pg env vars as migrate-01
 * (PGHOST/PGPORT/PGUSER/PGPASSWORD, all with the same defaults). The
 * maintenance connection always targets the literal `postgres` database.
 *
 * Usage:
 *   node scripts/migrations/migrate-schema-addenda.js [--db <name>]
 *
 * Exit codes: 0 = PASS, 1 = refused / prerequisite missing / apply failure /
 * verification failure, 2 = bad CLI usage.
 */

const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

const migrateOne = require('./migrate-01-canonical-db');

// ─── PATHS ────────────────────────────────────────────────────────────────────

const MIGRATIONS_DIR = __dirname;
const SQL_DIR = path.join(MIGRATIONS_DIR, 'sql');

// Explicit apply order (see ORDER note in the header comment above) — NEVER
// filename lexicographic order.
const SQL_FILES = [
  path.join(SQL_DIR, 'attribution-columns.sql'),
  path.join(SQL_DIR, 'migrate-06-carryover-status.sql'),
  path.join(SQL_DIR, 'model-registry-base.sql'),
  path.join(SQL_DIR, 'embedding-providers-base.sql'),
  path.join(SQL_DIR, 'migrate-10-routing-harness.sql'),
  path.join(SQL_DIR, 'migrate-11-usage-telemetry.sql'),
];

// Engine-core tables this addendum's ALTER TABLE statements target. Must
// already exist in the target — see PREREQUISITE CHECK in the header
// comment. Deliberately a short, explicit constant (not derived from the SQL
// files, which do not CREATE these tables — they only ALTER them, so there
// is nothing in this addendum's own text to derive this list FROM).
const PREREQUISITE_TABLES = ['entities', 'assertions', 'edges'];

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
    'Usage: node scripts/migrations/migrate-schema-addenda.js [--db <name>]',
    '',
    '  --db <name>  Target database name (else MIGRATE_TARGET_DB env, else',
    '               memory_manager_staging). Never reads HANDOFF_DB. The',
    '               target database must already exist (this script does not',
    '               create databases — run migrate-01-canonical-db.js first)',
    '               and must already carry the entities/assertions/edges',
    '               engine-core tables.',
  ].join('\n'));
}

// ─── SQL TEXT PARSING HELPERS (pure, no DB) ──────────────────────────────────
//
// Every helper below operates on stripSqlNoise()'d text (imported from
// migrate-01, not re-implemented) so `--`/`/* */` comments and quoted-string
// contents can never be mistaken for statement structure. None of this is a
// general SQL parser — it is deliberately scoped to the statement shapes the
// six shipped addendum files actually use (plain CREATE TABLE / ALTER TABLE
// ADD COLUMN / CREATE INDEX / INSERT ... ON CONFLICT), the same scoping
// migrate-01's own TABLE_RE/VIEW_RE regex scan uses.

/**
 * Split a string on a top-level separator character, honoring parenthesis
 * nesting AND single-quoted string literals (so a comma inside NUMERIC(10,4)
 * or inside a quoted value never causes a false split).
 */
function splitTopLevelSql(s, sep) {
  const parts = [];
  let depth = 0;
  let start = 0;
  let inStr = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (c === "'") {
        if (s[i + 1] === "'") { i++; continue; } // doubled '' escape
        inStr = false;
      }
      continue;
    }
    if (c === "'") { inStr = true; continue; }
    if (c === '(') depth++;
    else if (c === ')') depth--;
    else if (c === sep && depth === 0) {
      parts.push(s.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(s.slice(start));
  return parts.map((p) => p.trim()).filter((p) => p.length > 0);
}

/**
 * Find the parenthesized group starting at s[openIdx] (which must be '(')
 * and return its inner text plus the index of the matching close paren.
 */
function extractParenGroupAt(s, openIdx) {
  let depth = 0;
  for (let i = openIdx; i < s.length; i++) {
    if (s[i] === '(') depth++;
    else if (s[i] === ')') {
      depth--;
      if (depth === 0) return { inner: s.slice(openIdx + 1, i), end: i };
    }
  }
  throw new Error('Unbalanced parentheses while scanning SQL text');
}

/**
 * Extract the inner text of the FIRST `CHECK ( ... )` clause in `text`
 * (paren-depth aware, so a nested `IN (...)` list inside the CHECK does not
 * truncate the match early). Returns null if no CHECK clause is present.
 */
function extractCheckClause(text) {
  const m = /CHECK\s*\(/i.exec(text);
  if (!m) return null;
  const openIdx = m.index + m[0].length - 1;
  return extractParenGroupAt(text, openIdx).inner;
}

/** Every single-quoted literal's inner text, in order, e.g. "IN ('a','b')" -> ['a','b']. */
function extractQuotedLiterals(text) {
  const literals = [];
  const re = /'([^']*)'/g;
  let m;
  while ((m = re.exec(text))) literals.push(m[1]);
  return literals;
}

/** Parse one SQL literal token (from a VALUES list) into a typed {type, value}. */
function parseSqlLiteral(tokRaw) {
  const tok = tokRaw.trim();
  if (/^'([\s\S]*)'$/.test(tok)) {
    return { type: 'string', value: tok.slice(1, -1).replace(/''/g, "'") };
  }
  if (/^true$/i.test(tok)) return { type: 'boolean', value: true };
  if (/^false$/i.test(tok)) return { type: 'boolean', value: false };
  if (/^null$/i.test(tok)) return { type: 'null', value: null };
  if (/^-?\d+(\.\d+)?$/.test(tok)) return { type: 'number', value: Number(tok) };
  return { type: 'raw', value: tok };
}

function parseInsertStatement(stmt) {
  const headMatch = /^INSERT\s+INTO\s+"?([a-zA-Z_][a-zA-Z0-9_]*)"?\s*\(/i.exec(stmt);
  if (!headMatch) return null;
  const table = headMatch[1].toLowerCase();
  const colsOpenIdx = headMatch[0].length - 1;
  const colsGroup = extractParenGroupAt(stmt, colsOpenIdx);
  const columns = splitTopLevelSql(colsGroup.inner, ',').map((c) => c.trim().replace(/"/g, '').toLowerCase());

  const rest = stmt.slice(colsGroup.end + 1);
  const valuesHead = /^\s*VALUES\s*\(/i.exec(rest);
  if (!valuesHead) return null;
  const valuesOpenIdx = valuesHead[0].length - 1;
  const valuesGroup = extractParenGroupAt(rest, valuesOpenIdx);
  const values = splitTopLevelSql(valuesGroup.inner, ',').map(parseSqlLiteral);

  const tail = rest.slice(valuesGroup.end + 1);
  const conflictMatch = /ON\s+CONFLICT\s*\(([^)]*)\)/i.exec(tail);
  const conflictColumns = conflictMatch
    ? conflictMatch[1].split(',').map((c) => c.trim().replace(/"/g, '').toLowerCase())
    : [];

  return { table, columns, values, conflictColumns };
}

// ─── TYPE NORMALIZATION (a translation table, not a hand-maintained list of
// tables/columns — A-5) ───────────────────────────────────────────────────

const TYPE_NORMALIZE = {
  TEXT: 'text',
  TIMESTAMPTZ: 'timestamp with time zone',
  SERIAL: 'integer',
  NUMERIC: 'numeric',
  BIGINT: 'bigint',
  INTEGER: 'integer',
  BOOLEAN: 'boolean',
  JSONB: 'jsonb',
};

function normalizeType(typeToken) {
  if (!typeToken) return null;
  return TYPE_NORMALIZE[typeToken.toUpperCase()] || null;
}

// ─── DERIVED SCHEMA-ADDENDA OBJECT SET (A-1/A-2/A-3/A-5 — never a
// hand-maintained list; derived from the six SQL files' own text at verify
// time, mirroring migrate-01's D-4 rule and deriveExpectedObjects style) ────

/**
 * Derive every column (+ declared type token), CHECK constraint, index, and
 * UNIQUE constraint the six addendum SQL files declare — from BOTH
 * `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` statements AND the column lists
 * inside `CREATE TABLE IF NOT EXISTS` bodies (A-1). Table names themselves
 * are derived via migrate-01's own exported deriveExpectedObjects (reused,
 * not re-implemented) — see verifyAddenda below.
 *
 * @param {string[]} sqlFiles — absolute paths, in any order (statement
 *   scanning does not depend on cross-file order; apply order is a runner
 *   concern, not a derivation concern)
 */
function deriveSchemaAddenda(sqlFiles) {
  const columns = [];   // { table, column, typeToken, source: 'CREATE TABLE'|'ALTER' }
  const checks = [];    // { table, column, literals: string[] }
  const indexes = [];   // { name, table, columns: string[], hasWhere: boolean }
  const uniques = [];   // { table, columns: string[] }
  const seeds = [];     // { table, columns: string[], values: {type,value}[], conflictColumns: string[] }

  for (const file of sqlFiles) {
    const clean = migrateOne.stripSqlNoise(fs.readFileSync(file, 'utf8'));
    const statements = clean.split(';').map((s) => s.trim()).filter(Boolean);

    for (const stmt of statements) {
      let m;

      // CREATE TABLE IF NOT EXISTS <table> ( <body> )
      if ((m = /^CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?"?([a-zA-Z_][a-zA-Z0-9_]*)"?\s*\(([\s\S]*)\)\s*$/i.exec(stmt))) {
        const table = m[1].toLowerCase();
        const parts = splitTopLevelSql(m[2], ',');
        for (const part of parts) {
          if (/^UNIQUE\s*\(/i.test(part)) {
            const cm = /^UNIQUE\s*\(([^)]*)\)/i.exec(part);
            uniques.push({
              table,
              columns: cm[1].split(',').map((c) => c.trim().replace(/"/g, '').toLowerCase()),
            });
            continue;
          }
          if (/^(PRIMARY\s+KEY|CONSTRAINT|CHECK|FOREIGN\s+KEY)\b/i.test(part)) {
            // Table-level constraint shapes not used by the shipped files
            // beyond UNIQUE (handled above); not otherwise derived.
            continue;
          }
          const colMatch = /^"?([a-zA-Z_][a-zA-Z0-9_]*)"?\s+([\s\S]*)$/.exec(part);
          if (!colMatch) continue;
          const colName = colMatch[1].toLowerCase();
          const rest = colMatch[2];
          const typeMatch = /^([A-Za-z_]+)(\([^)]*\))?/.exec(rest.trim());
          const typeToken = typeMatch ? typeMatch[1].toUpperCase() : null;
          columns.push({ table, column: colName, typeToken, source: 'CREATE TABLE' });
          if (/\bUNIQUE\b/i.test(rest)) {
            uniques.push({ table, columns: [colName] });
          }
          const checkInner = extractCheckClause(rest);
          if (checkInner) {
            checks.push({ table, column: colName, literals: extractQuotedLiterals(checkInner) });
          }
        }
        continue;
      }

      // ALTER TABLE <table> ADD COLUMN IF NOT EXISTS <col> <rest>
      if ((m = /^ALTER\s+TABLE\s+"?([a-zA-Z_][a-zA-Z0-9_]*)"?\s+ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\s+"?([a-zA-Z_][a-zA-Z0-9_]*)"?\s+([\s\S]*)$/i.exec(stmt))) {
        const table = m[1].toLowerCase();
        const colName = m[2].toLowerCase();
        const rest = m[3];
        const typeMatch = /^([A-Za-z_]+)(\([^)]*\))?/.exec(rest.trim());
        const typeToken = typeMatch ? typeMatch[1].toUpperCase() : null;
        columns.push({ table, column: colName, typeToken, source: 'ALTER' });
        const checkInner = extractCheckClause(rest);
        if (checkInner) {
          checks.push({ table, column: colName, literals: extractQuotedLiterals(checkInner) });
        }
        continue;
      }

      // CREATE INDEX IF NOT EXISTS <name> ON <table> (<cols>) [WHERE ...]
      if ((m = /^CREATE\s+INDEX\s+IF\s+NOT\s+EXISTS\s+"?([a-zA-Z_][a-zA-Z0-9_]*)"?\s+ON\s+"?([a-zA-Z_][a-zA-Z0-9_]*)"?\s*\(([^)]*)\)([\s\S]*)$/i.exec(stmt))) {
        const name = m[1].toLowerCase();
        const table = m[2].toLowerCase();
        const cols = m[3].split(',').map((c) => c.trim().replace(/"/g, '').toLowerCase());
        const trailing = m[4] || '';
        indexes.push({ name, table, columns: cols, hasWhere: /\bWHERE\b/i.test(trailing) });
        continue;
      }

      // INSERT INTO <table> (<cols>) VALUES (<values>) [ON CONFLICT (<cols>) ...]
      if (/^INSERT\s+INTO\b/i.test(stmt)) {
        const parsed = parseInsertStatement(stmt);
        if (parsed) seeds.push(parsed);
        continue;
      }
    }
  }

  return { columns, checks, indexes, uniques, seeds };
}

// ─── DB-EXISTENCE + PREREQUISITE CHECKS ──────────────────────────────────────

/** Check target existence via a maintenance-DB connection (A-6). */
async function checkDbExists(sysClient, target) {
  const { rows } = await sysClient.query('SELECT 1 FROM pg_database WHERE datname = $1', [target]);
  return rows.length > 0;
}

/** Check that entities/assertions/edges already exist in the (connected) target. */
async function checkPrerequisites(client) {
  const { rows } = await client.query(
    `SELECT table_name FROM information_schema.tables
      WHERE table_schema = current_schema() AND table_type = 'BASE TABLE'`
  );
  const actual = new Set(rows.map((r) => r.table_name.toLowerCase()));
  const missing = PREREQUISITE_TABLES.filter((t) => !actual.has(t));
  return { ok: missing.length === 0, missing };
}

// ─── SEED ROW VERIFICATION (A-4) ─────────────────────────────────────────────

async function verifySeedRow(client, seed) {
  const { table, columns, values, conflictColumns } = seed;
  if (conflictColumns.length === 0) {
    return { pass: false, table, reason: `seed row for ${table} has no ON CONFLICT column to key a lookup on` };
  }
  const conflictCol = conflictColumns[0];
  const keyIdx = columns.indexOf(conflictCol);
  if (keyIdx === -1) {
    return { pass: false, table, reason: `ON CONFLICT column "${conflictCol}" is not in ${table}'s INSERT column list` };
  }
  const keyVal = values[keyIdx];
  const { rows } = await client.query(
    `SELECT ${columns.map((c) => `"${c}"`).join(', ')} FROM ${table} WHERE "${conflictCol}" = $1`,
    [keyVal.value]
  );
  if (rows.length === 0) {
    return { pass: false, table, conflictCol, keyVal: keyVal.value, reason: `seed row ${table}.${conflictCol}="${keyVal.value}" is missing` };
  }
  const row = rows[0];
  const mismatches = [];
  columns.forEach((col, i) => {
    const expected = values[i];
    const actual = row[col];
    let match = true;
    if (expected.type === 'string') match = actual === expected.value;
    else if (expected.type === 'number') match = Number(actual) === expected.value;
    else if (expected.type === 'boolean') match = actual === expected.value;
    if (!match) mismatches.push({ column: col, expected: expected.value, actual });
  });
  return {
    pass: mismatches.length === 0,
    table,
    conflictCol,
    keyVal: keyVal.value,
    mismatches,
    reason: mismatches.length
      ? `seed row ${table}.${conflictCol}="${keyVal.value}" has divergent value(s): ${mismatches.map((mm) => `${mm.column} expected=${JSON.stringify(mm.expected)} actual=${JSON.stringify(mm.actual)}`).join('; ')}`
      : null,
  };
}

// ─── VERIFICATION (A-1..A-5, A-9 — the full derived-vs-live diff pass) ──────

/**
 * Run the full verification pass against an already-connected client for the
 * target database. Deliberately a standalone function (not inlined into
 * main()) so it can be exercised directly against a deliberately-perturbed
 * database state without going through the CLI's apply step, which would
 * otherwise silently heal several perturbations before verification saw the
 * gap — the same seam migrate-01's verifyTarget establishes.
 *
 * @param {import('pg').Client} client — connected to the target database
 * @param {string[]} sqlFiles — absolute paths to the six addendum files
 */
async function verifyAddenda(client, sqlFiles) {
  const derived = deriveSchemaAddenda(sqlFiles);
  const expectedTables = [...migrateOne.deriveExpectedObjects(sqlFiles).tables].sort();

  // ── Tables ────────────────────────────────────────────────────────────
  const actualTablesRes = await client.query(
    `SELECT table_name FROM information_schema.tables
      WHERE table_schema = current_schema() AND table_type = 'BASE TABLE'`
  );
  const actualTables = new Set(actualTablesRes.rows.map((r) => r.table_name.toLowerCase()));
  const missingTables = expectedTables.filter((t) => !actualTables.has(t));

  // ── Columns + types (A-1, A-5) ──────────────────────────────────────────
  const missingColumns = [];
  const wrongTypeColumns = [];
  for (const col of derived.columns) {
    const { rows } = await client.query(
      `SELECT data_type FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = $1 AND column_name = $2`,
      [col.table, col.column]
    );
    if (rows.length === 0) {
      missingColumns.push(col);
      continue;
    }
    const expectedType = normalizeType(col.typeToken);
    if (expectedType && rows[0].data_type !== expectedType) {
      wrongTypeColumns.push({ ...col, expectedType, actualType: rows[0].data_type });
    }
  }

  // ── CHECK constraints (A-2) ─────────────────────────────────────────────
  const missingChecks = [];
  const checkDefsByTable = new Map();
  for (const chk of derived.checks) {
    if (!checkDefsByTable.has(chk.table)) {
      const { rows } = await client.query(
        `SELECT pg_get_constraintdef(con.oid) AS def
           FROM pg_constraint con
           JOIN pg_class c ON con.conrelid = c.oid
           JOIN pg_namespace n ON c.relnamespace = n.oid
          WHERE n.nspname = current_schema() AND c.relname = $1 AND con.contype = 'c'`,
        [chk.table]
      );
      checkDefsByTable.set(chk.table, rows.map((r) => r.def));
    }
    const defs = checkDefsByTable.get(chk.table);
    const found = defs.some(
      (def) => def.includes(chk.column) && chk.literals.every((lit) => def.includes(`'${lit}'`))
    );
    if (!found) missingChecks.push(chk);
  }

  // ── Indexes + partial-index WHERE clauses (A-3) ─────────────────────────
  const missingIndexes = [];
  const malformedIndexes = [];
  for (const idx of derived.indexes) {
    const { rows } = await client.query(
      `SELECT indexdef FROM pg_indexes WHERE schemaname = current_schema() AND indexname = $1`,
      [idx.name]
    );
    if (rows.length === 0) {
      missingIndexes.push(idx);
      continue;
    }
    if (idx.hasWhere && !/\bWHERE\b/i.test(rows[0].indexdef)) {
      malformedIndexes.push({ ...idx, reason: 'expected a partial index (WHERE clause) but none was found', indexdef: rows[0].indexdef });
    }
  }

  // ── UNIQUE constraints (A-3) ────────────────────────────────────────────
  const missingUniques = [];
  const uniqueDefsByTable = new Map();
  for (const uq of derived.uniques) {
    if (!uniqueDefsByTable.has(uq.table)) {
      const { rows } = await client.query(
        `SELECT pg_get_constraintdef(con.oid) AS def
           FROM pg_constraint con
           JOIN pg_class c ON con.conrelid = c.oid
           JOIN pg_namespace n ON c.relnamespace = n.oid
          WHERE n.nspname = current_schema() AND c.relname = $1 AND con.contype = 'u'`,
        [uq.table]
      );
      uniqueDefsByTable.set(uq.table, rows.map((r) => r.def));
    }
    const defs = uniqueDefsByTable.get(uq.table);
    const found = defs.some((def) => uq.columns.every((c) => new RegExp(`\\b${c}\\b`).test(def)));
    if (!found) missingUniques.push(uq);
  }

  // ── Seed row values (A-4) ───────────────────────────────────────────────
  const seedResults = [];
  for (const seed of derived.seeds) {
    seedResults.push(await verifySeedRow(client, seed));
  }
  const failedSeeds = seedResults.filter((r) => !r.pass);

  // ── model_registry row count: observability only, NEVER gates (A-9) ────
  let modelRegistryCount = null;
  try {
    const { rows } = await client.query('SELECT count(*) AS n FROM model_registry');
    modelRegistryCount = Number(rows[0].n);
  } catch (_) {
    // Table may not exist yet in a partially-applied state; observability
    // only, so absence here is reported, never a verification failure.
  }

  const pass =
    missingTables.length === 0 &&
    missingColumns.length === 0 &&
    wrongTypeColumns.length === 0 &&
    missingChecks.length === 0 &&
    missingIndexes.length === 0 &&
    malformedIndexes.length === 0 &&
    missingUniques.length === 0 &&
    failedSeeds.length === 0;

  return {
    expectedTables,
    missingTables,
    missingColumns,
    wrongTypeColumns,
    missingChecks,
    missingIndexes,
    malformedIndexes,
    missingUniques,
    seedResults,
    failedSeeds,
    modelRegistryCount,
    pass,
  };
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

  console.log(`migrate-schema-addenda: target="${target}" (resolved from ${source})`);

  // ── DB-existence check via maintenance DB, BEFORE any target connection ──

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
    exists = await checkDbExists(sysClient, target);
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

    const prereq = await checkPrerequisites(db);
    if (!prereq.ok) {
      console.error(`Refused: target "${target}" is missing prerequisite table(s): ${prereq.missing.join(', ')}.`);
      console.error('Run migrate-01-canonical-db.js against this target first to stand up the engine-core schema, then re-run this script. Nothing was applied.');
      process.exitCode = 1;
      return;
    }

    // ── Apply the six SQL files, in explicit order ──────────────────────────

    const fileResults = [];
    for (const file of SQL_FILES) {
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

    // ── Verification ─────────────────────────────────────────────────────

    const v = await verifyAddenda(db, SQL_FILES);

    console.log(`  derived expected tables: ${v.expectedTables.length} (${v.expectedTables.join(', ')})`);
    console.log(`  missing tables: ${v.missingTables.length ? v.missingTables.join(', ') : '(none)'}`);
    console.log(`  missing columns: ${v.missingColumns.length ? v.missingColumns.map((c) => `${c.table}.${c.column}`).join(', ') : '(none)'}`);
    console.log(`  wrong-type columns: ${v.wrongTypeColumns.length ? v.wrongTypeColumns.map((c) => `${c.table}.${c.column} (expected ${c.expectedType}, found ${c.actualType})`).join(', ') : '(none)'}`);
    console.log(`  missing CHECK constraints: ${v.missingChecks.length ? v.missingChecks.map((c) => `${c.table}.${c.column}`).join(', ') : '(none)'}`);
    console.log(`  missing indexes: ${v.missingIndexes.length ? v.missingIndexes.map((i) => i.name).join(', ') : '(none)'}`);
    console.log(`  malformed indexes: ${v.malformedIndexes.length ? v.malformedIndexes.map((i) => `${i.name}: ${i.reason}`).join(', ') : '(none)'}`);
    console.log(`  missing UNIQUE constraints: ${v.missingUniques.length ? v.missingUniques.map((u) => `${u.table}(${u.columns.join(',')})`).join(', ') : '(none)'}`);
    console.log(`  seed rows: ${v.failedSeeds.length ? v.failedSeeds.map((s) => s.reason).join('; ') : 'OK'}`);
    console.log(`  model_registry row count (observability only, never gates PASS/FAIL): ${v.modelRegistryCount === null ? 'ABSENT' : v.modelRegistryCount}`);

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
  // Re-exported by reference (not forked) from migrate-01-canonical-db.js —
  // A-14's reference-identity requirement.
  resolveTargetDb: migrateOne.resolveTargetDb,
  classifyTarget: migrateOne.classifyTarget,
  DB_NAME_RE: migrateOne.DB_NAME_RE,
  pgConfig: migrateOne.pgConfig,
  applySqlFile: migrateOne.applySqlFile,
  stripPsqlMetaCommands: migrateOne.stripPsqlMetaCommands,
  stripSqlNoise: migrateOne.stripSqlNoise,
  deriveExpectedObjects: migrateOne.deriveExpectedObjects,

  // This module's own exports (test seams).
  parseArgs,
  UsageError,
  SQL_FILES,
  PREREQUISITE_TABLES,
  checkDbExists,
  checkPrerequisites,
  deriveSchemaAddenda,
  verifyAddenda,
  verifySeedRow,
  TYPE_NORMALIZE,
  normalizeType,
  splitTopLevelSql,
  extractParenGroupAt,
  extractCheckClause,
  extractQuotedLiterals,
  parseSqlLiteral,
  parseInsertStatement,
};
