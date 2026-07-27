'use strict';

/**
 * verify15-shared.js
 *
 * Shared helpers for the scripts/migrations/verify-15-*.js acceptance
 * battery (§15 of the consolidation runbook, local planning doc). Every
 * verify-15-*.js script imports from here rather than re-implementing:
 *   - pg connection config + connect() (same env-var convention as
 *     migrate-01-canonical-db.js: PGHOST/PGPORT/PGUSER/PGPASSWORD)
 *   - target-DB resolution + refusal classification (reuses migrate-01's
 *     classifyTarget/DB_NAME_RE directly — never a second classifier)
 *   - roster loading + total-classification shape validation (T0's
 *     source-table-roster.json)
 *   - row hashing (T3's reference-implementation algorithm: NULL sentinel,
 *     no .trim(), JSON.stringify of the value array, md5) — reused by T1
 *     (source snapshot), T3/T3b (live comparison), and test fixtures
 *   - DDL: CREATE TABLE IF NOT EXISTS for every shared table this battery
 *     reads/writes (migration_manifest, migration_manifest_row_hashes,
 *     memory_manager_staging_row_hashes, dual_write_shim_window,
 *     old_store_row_hashes, containment_evidence, promotion_conflict_log)
 *   - containment_evidence row writer (T4/F1-F4 evidence, §15.2.1)
 *
 * NEVER connects to claude_memory_eval_test, claude_policy_framework, any
 * pipeline_* DB, or the live memory_manager_staging in TEST code — that
 * refusal posture is enforced by the caller (test/migrations/test-verify-15.js
 * always passes an explicit scratch _staging-suffixed name) and by
 * resolveAndClassifyTargetDb() below refusing anything migrate-01's own
 * classifyTarget refuses, in every script, before any connection is opened.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Client } = require('pg');

const MIGRATIONS_DIR = path.resolve(__dirname, '..');

// migrate-01-canonical-db.js already exports a total-classification target
// resolver (allow: memory_manager / memory_manager_staging / *_staging;
// refuse everything else, including claude_memory_eval_test, pipeline_*,
// claude_policy_framework, and any unrecognized name — default branch is
// REFUSE). Reused verbatim rather than re-implemented (closes the "second
// hand-maintained classifier" hazard this canon forbids).
const migrateOne = require('../migrate-01-canonical-db');

// ─── PG CONNECTION CONFIG (same convention as migrate-01-canonical-db.js) ────

function pgConfig(database) {
  return {
    host: process.env.PGHOST || 'localhost',
    port: parseInt(process.env.PGPORT || '5432', 10),
    user: process.env.PGUSER || 'postgres',
    password: process.env.PGPASSWORD || 'postgres',
    database,
  };
}

async function connect(database) {
  const client = new Client(pgConfig(database));
  await client.connect();
  return client;
}

// ─── TARGET RESOLUTION (shared across every verify-15-*.js script) ──────────

/**
 * Minimal CLI arg parser shared by the battery scripts: only --db is common
 * to all of them (some add their own flags on top — see each script). Not a
 * full parser; each script slices its own extra args out of argv first if it
 * needs to.
 */
function parseDbFlag(argv) {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--db') return argv[i + 1];
    if (argv[i].startsWith('--db=')) return argv[i].slice('--db='.length);
  }
  return null;
}

/**
 * Resolve + classify the target (staging) database, refusing BEFORE any
 * connection is opened — identical posture to migrate-01-canonical-db.js.
 * Exits the process with a clear refusal message on a disallowed name;
 * returns { name, source } on success.
 */
function resolveAndClassifyTargetDb(argv) {
  const dbFlag = parseDbFlag(argv);
  const { name, source } = migrateOne.resolveTargetDb({ db: dbFlag });
  if (!migrateOne.DB_NAME_RE.test(name)) {
    console.error(`Invalid database name "${name}" (from ${source}) — must match /^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/.`);
    process.exit(1);
  }
  const classification = migrateOne.classifyTarget(name);
  if (!classification.allowed) {
    console.error(`Refused: ${classification.reason}`);
    console.error(`(resolved from ${source} — no database connection was opened.)`);
    process.exit(1);
  }
  return { name, source };
}

/**
 * Resolve an arbitrary SOURCE database name (--source-db flag or SOURCE_DB
 * env) through the SAME classifier — a source connection is exactly as
 * dangerous to get wrong as a target connection, so it gets the same
 * refuse-by-default posture. Unlike the target resolver, there is no
 * built-in default: a source must be named explicitly.
 */
function resolveAndClassifySourceDb(argv) {
  let name = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--source-db') { name = argv[i + 1]; break; }
    if (argv[i].startsWith('--source-db=')) { name = argv[i].slice('--source-db='.length); break; }
  }
  if (!name) name = process.env.SOURCE_DB || null;
  if (!name) return null;
  if (!migrateOne.DB_NAME_RE.test(name)) {
    console.error(`Invalid source database name "${name}" — must match /^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/.`);
    process.exit(1);
  }
  return name;
}

// ─── ROSTER LOADING (T0's total classification, read by T0/T3/T5/T6) ────────

const ROSTER_ENV_VAR = 'SOURCE_TABLE_ROSTER';
const ROSTER_EXAMPLE_FILE = 'source-table-roster.example.json';
const REQUIRED_ROSTER_FIELDS = [
  'source_db', 'source_table', 'targetTable', 'loadBearingCols',
  'hasContentBearingText', 'requires_project_id_scope',
];

function resolveRosterPath() {
  return process.env[ROSTER_ENV_VAR] || path.join(MIGRATIONS_DIR, 'source-table-roster.json');
}

/**
 * Validate the roster's SHAPE (every entry carries the fields every
 * verify-15-*.js script depends on) — not its CONTENT against the schema
 * sections (that is verify-15-t0-roster-completeness.js's separate job, per
 * spec: roster shape and roster completeness are deliberately two different
 * checks so a shape bug and a completeness gap fail with distinct, legible
 * messages instead of one script silently covering both).
 */
function validateRosterShape(roster, rosterPath) {
  const errors = [];
  roster.forEach((entry, i) => {
    for (const field of REQUIRED_ROSTER_FIELDS) {
      if (!(field in entry)) {
        errors.push(`entry ${i} (source_table=${entry.source_table || '?'}) missing required field "${field}"`);
      }
    }
  });
  if (errors.length) {
    console.error(`FATAL: source table roster at "${rosterPath}" failed shape validation:`);
    for (const e of errors) console.error(`  - ${e}`);
    process.exit(1);
  }
}

/**
 * Load + shape-validate the real source-table-roster.json. Loud fatal, never
 * a silent empty-array fallback, when the real roster is missing — names
 * both the env var and the example file so the operator knows exactly what
 * to do next.
 */
function loadRoster() {
  const rosterPath = resolveRosterPath();
  if (!fs.existsSync(rosterPath)) {
    console.error(`FATAL: source table roster not found at "${rosterPath}".`);
    console.error(`  Set ${ROSTER_ENV_VAR} to point at the real roster, or create`);
    console.error(`  scripts/migrations/source-table-roster.json (real roster — carries`);
    console.error(`  private estate data, gitignored, never committed).`);
    console.error(`  See scripts/migrations/${ROSTER_EXAMPLE_FILE} for the required shape`);
    console.error(`  (synthetic example only).`);
    process.exit(1);
  }
  let raw;
  try {
    raw = fs.readFileSync(rosterPath, 'utf8');
  } catch (err) {
    console.error(`FATAL: could not read roster at "${rosterPath}": ${err.message}`);
    process.exit(1);
  }
  let roster;
  try {
    roster = JSON.parse(raw);
  } catch (err) {
    console.error(`FATAL: roster at "${rosterPath}" is not valid JSON: ${err.message}`);
    process.exit(1);
  }
  if (!Array.isArray(roster) || roster.length === 0) {
    console.error(`FATAL: roster at "${rosterPath}" must be a non-empty JSON array.`);
    process.exit(1);
  }
  validateRosterShape(roster, rosterPath);
  return roster;
}

// ─── ROW HASHING (T3's reference implementation, §15.3 — reused everywhere) ─

// A value no real column value can equal by construction. Written as source
// text (never a literal NUL byte in this file, per canon) — this is a
// 10-character sentinel STRING, not a NUL byte; it distinguishes NULL/absent
// from an empty string without ever coalescing them to the same value.
const NULL_SENTINEL = ' __NULL__ ';

/**
 * Hash one row's load-bearing column values. No .trim() (whitespace is not
 * documented anywhere as never-load-bearing). NULL/undefined mapped to the
 * sentinel, never coalesced with ''. JSON.stringify of the VALUE ARRAY (not
 * a delimiter-joined string) so no value's own content can forge a
 * tuple-boundary collision.
 */
function rowHash(cols, row) {
  const values = cols.map((c) => (row[c] === null || row[c] === undefined) ? NULL_SENTINEL : row[c]);
  const s = JSON.stringify(values);
  return crypto.createHash('md5').update(s).digest('hex');
}

/**
 * Hash every row of `table` (via `client`) over `cols`, returning a
 * MULTISET: Map<hash, {count, sample}> — never a Set. Two identical-content
 * rows must count as 2, not collapse to 1 (closes A-8).
 */
async function hashTableMultiset(client, table, cols, { idCol = 'id', projectCol = 'project_id' } = {}) {
  const selectCols = [idCol, projectCol, ...cols].filter((c, i, a) => a.indexOf(c) === i);
  const { rows } = await client.query(`SELECT ${selectCols.map((c) => `"${c}"`).join(', ')} FROM ${table}`);
  const counts = new Map();
  for (const r of rows) {
    const h = rowHash(cols, r);
    const entry = counts.get(h) || { count: 0, sample: [] };
    entry.count += 1;
    if (entry.sample.length < 3) entry.sample.push({ id: r[idCol], project_id: r[projectCol] });
    counts.set(h, entry);
  }
  return counts;
}

/**
 * Same as hashTableMultiset, but excludes rows whose project_id is in
 * `excludedProjectIds` — used by T3's forward-containment scan to keep
 * DELIBERATELY-EXCLUDED source rows (T9's exclusion scenario) out of the
 * source-side multiset, since those rows correctly never migrate and would
 * otherwise spuriously fail T3's "every source row survived" proof.
 *
 * NOT EXISTS against unnest($1::text[]), never NOT IN (closes the
 * finding raised in PR #152 review — this repo's canon forbids NOT IN
 * (subquery) in any authored SQL, and this is exactly that shape if written
 * naively). Passing an empty array is equivalent to hashTableMultiset with
 * no filter (the WHERE clause is omitted entirely in that case, not run
 * with an empty unnest — cheaper and avoids a degenerate-array edge case).
 */
async function hashTableMultisetExcludingProjects(client, table, cols, excludedProjectIds, { idCol = 'id', projectCol = 'project_id' } = {}) {
  const selectCols = [idCol, projectCol, ...cols].filter((c, i, a) => a.indexOf(c) === i);
  let sql = `SELECT ${selectCols.map((c) => `"${c}"`).join(', ')} FROM ${table}`;
  const params = [];
  if (excludedProjectIds && excludedProjectIds.length > 0) {
    sql += ` t WHERE NOT EXISTS (SELECT 1 FROM unnest($1::text[]) AS ex(pid) WHERE ex.pid = t."${projectCol}")`;
    params.push(excludedProjectIds);
  }
  const { rows } = await client.query(sql, params);
  const counts = new Map();
  for (const r of rows) {
    const h = rowHash(cols, r);
    const entry = counts.get(h) || { count: 0, sample: [] };
    entry.count += 1;
    if (entry.sample.length < 3) entry.sample.push({ id: r[idCol], project_id: r[projectCol] });
    counts.set(h, entry);
  }
  return counts;
}

/**
 * Load T1-recorded exclusions for one (source_db, source_table) pair from
 * migration_manifest, split into the NULL-scoped (whole-DB/whole-table)
 * exclusion, if any, and the list of project-scoped exclusions. Used by T3
 * to scope its forward-containment source-side multiset to non-excluded
 * rows only (closes the PR #152 review finding: T3 previously never
 * consulted excluded_reason at all).
 *
 * @returns {Promise<{ nullScoped: object|null, projectScoped: object[] }>}
 */
async function loadExclusionsFor(tgtClient, sourceDb, sourceTable) {
  const { rows } = await tgtClient.query(
    `SELECT project_id_or_null, row_count, excluded_reason
     FROM migration_manifest
     WHERE source_db = $1 AND source_table = $2 AND excluded_reason IS NOT NULL`,
    [sourceDb, sourceTable]
  );
  const nullScoped = rows.find((r) => r.project_id_or_null === null) || null;
  const projectScoped = rows.filter((r) => r.project_id_or_null !== null);
  return { nullScoped, projectScoped };
}

/**
 * Build the roster-derived load-bearing-columns map (targetTable ->
 * loadBearingCols). Fatal on any roster entry missing a mapping — never a
 * silent partial map (closes A-2).
 */
function buildLoadBearingColsFromRoster(roster) {
  const map = {};
  for (const entry of roster) {
    if (!entry.loadBearingCols || !entry.loadBearingCols.length) {
      console.error(`FATAL: roster entry "${entry.targetTable}" has no loadBearingCols mapping — refusing to run with a partial map.`);
      process.exit(1);
    }
    map[entry.targetTable] = entry.loadBearingCols;
  }
  return map;
}

/**
 * Compute + persist per-row target_hash values into
 * memory_manager_staging_row_hashes for every row currently in `table`.
 *
 * WHO CALLS THIS IN PRODUCTION (documented gap, see PR blind-spots): today,
 * nothing does — the actual migrate-NN-*.js data-migration scripts
 * (migrate-03 through migrate-13) that would write real rows into staging
 * and hash them at write time are OUT OF THIS TASK'S SCOPE (only
 * migrate-01-canonical-db.js, the schema-standup script, exists in this
 * repo so far). This helper is what those future scripts should call at
 * write time; until they exist, it is exercised only by
 * test/migrations/test-verify-15.js's synthetic fixtures, which call it
 * directly to populate memory_manager_staging_row_hashes for T3b's
 * proof-of-firing tests.
 */
async function hashAndStoreStagingRows(client, targetTable, cols, opts = {}) {
  const multiset = await hashTableMultiset(client, targetTable, cols, opts);
  const { rows } = await client.query(
    `SELECT ${['id', 'project_id', ...cols].filter((c, i, a) => a.indexOf(c) === i).map((c) => `"${c}"`).join(', ')} FROM ${targetTable}`
  );
  let n = 0;
  for (const r of rows) {
    const h = rowHash(cols, r);
    await client.query(
      `INSERT INTO memory_manager_staging_row_hashes (target_table, project_id, target_row_id, target_hash)
       VALUES ($1,$2,$3,$4)`,
      [targetTable, r.project_id ?? null, String(r.id), h]
    );
    n += 1;
  }
  return { rowsHashed: n, distinctHashes: multiset.size };
}

// ─── DDL (shared tables this battery reads/writes) ───────────────────────────

const DDL_SQL = `
CREATE TABLE IF NOT EXISTS migration_manifest (
  id                  SERIAL PRIMARY KEY,
  source_db           TEXT NOT NULL,
  source_table        TEXT NOT NULL,
  project_id_or_null  TEXT,
  row_count           BIGINT NOT NULL,
  content_fingerprint TEXT NOT NULL,
  captured_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  excluded_reason     TEXT
);
CREATE INDEX IF NOT EXISTS migration_manifest_source_idx ON migration_manifest (source_db, source_table);
CREATE INDEX IF NOT EXISTS migration_manifest_excl_idx   ON migration_manifest (excluded_reason);

CREATE TABLE IF NOT EXISTS migration_manifest_row_hashes (
  id                  SERIAL PRIMARY KEY,
  source_db           TEXT NOT NULL,
  source_table        TEXT NOT NULL,
  project_id_or_null  TEXT,
  source_row_id       TEXT,
  source_hash         TEXT NOT NULL,
  captured_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS migration_manifest_row_hashes_hash_idx ON migration_manifest_row_hashes (source_hash);
CREATE INDEX IF NOT EXISTS migration_manifest_row_hashes_src_idx  ON migration_manifest_row_hashes (source_db, source_table);

CREATE TABLE IF NOT EXISTS memory_manager_staging_row_hashes (
  id            SERIAL PRIMARY KEY,
  target_table  TEXT NOT NULL,
  project_id    TEXT,
  target_row_id TEXT,
  target_hash   TEXT NOT NULL,
  captured_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS memory_manager_staging_row_hashes_hash_idx ON memory_manager_staging_row_hashes (target_hash);
CREATE INDEX IF NOT EXISTS memory_manager_staging_row_hashes_tbl_idx  ON memory_manager_staging_row_hashes (target_table);

CREATE TABLE IF NOT EXISTS dual_write_shim_window (
  id           SERIAL PRIMARY KEY,
  enabled_at   TIMESTAMPTZ NOT NULL,
  disabled_at  TIMESTAMPTZ,
  enabled_by   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS old_store_row_hashes (
  id          SERIAL PRIMARY KEY,
  project_id  TEXT,
  old_hash    TEXT NOT NULL,
  written_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS old_store_row_hashes_hash_idx ON old_store_row_hashes (old_hash);

CREATE TABLE IF NOT EXISTS containment_evidence (
  id           SERIAL PRIMARY KEY,
  check_id     TEXT NOT NULL CHECK (check_id IN ('T4','F1','F2','F3','F4')),
  query_text   TEXT NOT NULL,
  result       TEXT NOT NULL,
  captured_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  recorded_by  TEXT NOT NULL,
  project_id   TEXT
);
CREATE INDEX IF NOT EXISTS containment_evidence_check_idx ON containment_evidence (check_id);

CREATE TABLE IF NOT EXISTS promotion_conflict_log (
  id                   SERIAL PRIMARY KEY,
  promoted_project_id  TEXT NOT NULL,
  target_table         TEXT NOT NULL,
  row_id               TEXT NOT NULL,
  staging_hash         TEXT NOT NULL,
  canonical_hash       TEXT NOT NULL,
  reviewed             BOOLEAN NOT NULL DEFAULT false,
  reviewed_by          TEXT,
  logged_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
`.trim();

async function applyDdl(client) {
  await client.query(DDL_SQL);
}

// ─── containment_evidence WRITER (T4/F1-F4, §15.2.1) ─────────────────────────

async function writeContainmentEvidence(client, { checkId, queryText, result, recordedBy, projectId = null }) {
  if (!['T4', 'F1', 'F2', 'F3', 'F4'].includes(checkId)) {
    throw new Error(`writeContainmentEvidence: invalid checkId "${checkId}"`);
  }
  const { rows } = await client.query(
    `INSERT INTO containment_evidence (check_id, query_text, result, recorded_by, project_id)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [checkId, queryText, result, recordedBy, projectId]
  );
  return rows[0].id;
}

// ─── AUTHORSHIP (T10's independence cross-check, §15.2 V-6) ─────────────────

function loadHarnessAuthorship() {
  const p = path.join(MIGRATIONS_DIR, 'harness-authorship.json');
  const raw = fs.readFileSync(p, 'utf8');
  const data = JSON.parse(raw);
  // Strip the _comment documentation key — every OTHER key is a script
  // filename mapping to { AUTHORED_BY }. Filtering here (once, centrally)
  // means every caller (T10's independence cross-check, tests) gets a clean
  // script-name -> {AUTHORED_BY} map without re-implementing the filter.
  const clean = {};
  for (const [key, value] of Object.entries(data)) {
    if (key.startsWith('_')) continue;
    clean[key] = value;
  }
  return clean;
}

module.exports = {
  MIGRATIONS_DIR,
  pgConfig,
  connect,
  parseDbFlag,
  resolveAndClassifyTargetDb,
  resolveAndClassifySourceDb,
  ROSTER_ENV_VAR,
  ROSTER_EXAMPLE_FILE,
  REQUIRED_ROSTER_FIELDS,
  resolveRosterPath,
  validateRosterShape,
  loadRoster,
  NULL_SENTINEL,
  rowHash,
  hashTableMultiset,
  hashTableMultisetExcludingProjects,
  loadExclusionsFor,
  hashAndStoreStagingRows,
  buildLoadBearingColsFromRoster,
  DDL_SQL,
  applyDdl,
  writeContainmentEvidence,
  loadHarnessAuthorship,
};
