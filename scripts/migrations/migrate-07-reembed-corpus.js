'use strict';

/**
 * migrate-07-reembed-corpus.js
 *
 * CONSOLIDATION-RUNBOOK.md §6.1(g) + its G-1..G-14 spec-adversary amendment
 * (G-R1..G-R14, 2026-08-18, memory-manager#11(g)): batches every embeddable
 * row on the target through the embedding_providers-resolved default
 * provider, writing embedding + provenance, idempotently, with a rollback
 * mode and a completeness gate.
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHAT THIS SCRIPT DOES (mapped to the amended spec's G-R items)
 * ══════════════════════════════════════════════════════════════════════
 *
 *   TABLE ENUMERATION IS DDL-DERIVED (G-R1). discoverEmbeddableTables()
 *   scans pg_attribute/pg_type/pg_class for every base table with a
 *   vector/halfvec column -- never a hand-listed table array. On live
 *   staging today this finds 18 tables: the 13 §5.3 seam tables + sessions
 *   + agent_exchange + assertions + memory_entries + memory_entry_chunks.
 *
 *   CONTENT EXPRESSION RESOLUTION -- ONE DEVIATION FROM A LITERAL READING
 *   OF G-R1, DELIBERATE AND DOCUMENTED: the amended spec frames
 *   source-table-roster.json's `contentCol` as the hint source for
 *   "single-column" tables, with a per-table COALESCE "declared once in
 *   migrate-07 itself" for the multi-column Bucket C tables. This script
 *   instead declares a content expression for EVERY table it knows about
 *   (CONTENT_EXPRESSIONS below, all 18 present-day embeddable tables) and
 *   treats the roster purely as a VALIDATION overlay: any roster row
 *   naming a `contentCol` for a table this script recognizes is checked
 *   against information_schema.columns (G-R1's hint-validation requirement,
 *   still honored) but the actual embedding-input text always comes from
 *   CONTENT_EXPRESSIONS. Reason: source-table-roster.json is real,
 *   gitignored, private-estate data (see scripts/migrations/
 *   source-table-roster.example.json's own header) -- it does not exist in
 *   CI or in a fresh checkout, and every other migrate-NN-*.js script in
 *   this repo that depends on private config (db-triage.json, pipeline-db-
 *   project-map.json, ...) accepts an override path rather than hard-
 *   requiring the real file. Making migrate-07 hard-depend on the roster
 *   for its CORE embedding-input construction would make it unable to run
 *   at all in the one environment (CI, a fresh DB, no GPU) G-R13 explicitly
 *   requires it to be tested in. A table this script does NOT recognize
 *   (declared expression absent) still REQUIRES a valid roster contentCol
 *   hint or refuses loud as unclassifiable (see resolveTableContentSpec) --
 *   so the total-classification guarantee ("every embeddable table lands
 *   somewhere, unclassified is a loud FAIL") holds regardless of which
 *   source supplied the expression.
 *
 *   STALENESS GATE IS A SINGLE UNIVERSAL RULE (G-R3): re-reading the
 *   amendment's own bucket definitions, Bucket A/B/C all resolve to the
 *   IDENTICAL runtime gate `embedding IS NULL` -- Bucket A's content_hash
 *   compare branch is explicitly "retained but documented as defensively
 *   dead." The bucket label this script computes and logs per table (A =
 *   has content_hash, B = no hash + roster-hinted content, C = no hash +
 *   declared content) is therefore a REPORTING/audit classification only,
 *   never a branch in the candidate-selection SQL itself.
 *
 *   THE ALTER SUB-STEP (G-R2) runs FIRST, before table discovery, so a
 *   freshly-ALTERed memory_entries/memory_entry_chunks is correctly
 *   discovered as halfvec(4000) rather than legacy vector(1024) by the
 *   DDL-derived scan that follows it.
 *
 *   MANIFEST EXCLUSIONS (G-R7): batch selection for a table excludes rows
 *   whose project_id was recorded excluded (excluded_reason IS NOT NULL,
 *   project_id_or_null IS NOT NULL) in migration_manifest under EITHER the
 *   target table's own name (covers migrate-verify-own-graph.js's
 *   `assertions`-labeled 231-row eval-junk exclusion directly, with zero
 *   roster dependency) OR any roster source_table label that maps to this
 *   targetTable (covers a table absorbed under a distinct manifest label,
 *   e.g. migrate-05's `memory_entries_db_absorb`). NULL-scoped (whole-slice)
 *   exclusions are deliberately NOT filtered here: a NULL-scoped exclusion
 *   means the entire source slice was never migrated into the target at
 *   all (T2 expects row_count=0 target rows for that slice) -- there are no
 *   target rows to filter out.
 *
 *   PROVENANCE (G-R5) / ROLLBACK IDENTITY (G-R4) / LOCKING (G-R10) /
 *   FAILURE POSTURE (G-R8) / DIM ASSERTION (G-R9): see embedTable() and
 *   runRollback() below -- one advisory-locked, single-row transaction per
 *   embedded row (UPDATE + embedding_write_log insert together), immediate
 *   hard stop on the first provider error (never skip-and-continue, never
 *   silently fall back to a different embedder), vector length checked
 *   against the resolved provider's stored_dims before every write.
 *
 *   COMPLETENESS GATE (G-R6): runCompletenessGate() classifies every
 *   residual NULL-embedding row into exactly one of embeddable-pending
 *   (FAILS the gate) / exempt-empty-content / exempt-suppressed-AND-empty /
 *   the corpus_files structural-disposition open question (a report-level
 *   flag layered ON TOP of, never instead of, its exempt-empty-content
 *   count -- see STRUCTURAL_DISPOSITION_TABLES below).
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHAT THIS SCRIPT DELIBERATELY DOES NOT DO
 * ══════════════════════════════════════════════════════════════════════
 *   - Never calls a live embedding endpoint from its own test suite (see
 *     test/migrations/test-migrate-07-reembed-corpus.js -- injectable
 *     transport, deterministic fixtures, no vLLM, no GPU required).
 *   - Never writes migration_manifest rows (G-R12 -- target-side only; its
 *     own lineage tables are registered sourceless via the net-new:
 *     convention in the roster, not via a manifest row).
 *   - Never re-embeds a row whose embedded_by_provider_id points at a
 *     non-default provider automatically -- flagged for owner review only
 *     (G-R5).
 *   - Never falls back to a second embedding backend on provider failure
 *     (house rule: vLLM or stop).
 *
 * Usage:
 *   node scripts/migrations/migrate-07-reembed-corpus.js [--db <target>]
 *     [--roster <path>] [--dry-run] [--rollback <run_id>]
 *
 * Exit codes: 0 = PASS, 1 = refused / precondition failure / apply failure /
 * completeness-gate failure, 2 = bad CLI usage.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Client } = require('pg');

const migrateOne = require('./migrate-01-canonical-db');               // reused by reference
const shared = require('./lib/verify15-shared');                        // reused by reference: resolveRosterPath, resolveAndClassifyTargetDb-equivalent pieces
const t9 = require('./verify-15-t9-negative');                          // reused by reference: checkExclusion (G-R11 preflight)
const embeddingProvider = require('../lib/embedding-provider');         // reused by reference

const MIGRATIONS_DIR = __dirname;
const SQL_FILE = path.join(MIGRATIONS_DIR, 'sql', 'migrate-07-ddl-addenda.sql');
const LOCK_NAMESPACE = 44; // 42/43 are taken by scripts/lib/db-seam.js (G-R10)

// Tables genuinely at legacy vector(1024) on live staging today (G-R2). Both
// carry ZERO live embedding values (live-verified) -- USING NULL never
// discards a real vector.
const LEGACY_VECTOR_TABLES = ['memory_entries', 'memory_entry_chunks'];

// TABLE-LEVEL structural-disposition candidates (G-R6). NOT an allow-list
// that exempts anything silently -- rows under these tables are still
// counted under exempt-empty-content exactly like any other table's empty
// rows; this list ONLY controls whether an additional [OPEN-QUESTION]
// report line is printed. corpus_files is the live-verified case (269/504
// empty summary -- a path/sha256 metadata index, not prose).
const STRUCTURAL_DISPOSITION_TABLES = ['corpus_files'];

// Composite/non-`id` primary keys (G-R4's row-identity encoding). Every
// other embeddable table's PK is a bare `id` SERIAL.
const PK_OVERRIDES = {
  findings: ['project_id', 'id'],
};

// Declared content expressions -- see header comment "CONTENT EXPRESSION
// RESOLUTION" for why this covers every table this script recognizes
// rather than only the amendment's literal Bucket C list. Every expression
// mirrors that table's OWN fts_vec GENERATED-column formula where one
// exists (an already-reviewed, already-shipped choice of "this table's
// content", reused for consistency rather than re-litigated) -- see
// scripts/migrations/sql/migrate-14-seam-tables.sql / migrate-04-seam-ddl-
// addenda.sql / scripts/setup.sql / scripts/sql/handoff-core-schema.sql for
// each table's own fts_vec definition.
const CONTENT_EXPRESSIONS = {
  memory_entries: "coalesce(body,'')",
  memory_entry_chunks: "coalesce(content,'')",
  policy_sections: "coalesce(content,'')",
  session_chunks: "coalesce(content,'')",
  corpus_files: "coalesce(summary,'')",
  code_index: "coalesce(description,'')",
  checklist_items: "coalesce(title,'') || ' ' || coalesce(description,'') || ' ' || coalesce(verification_step,'')",
  decisions: "coalesce(topic,'') || ' ' || coalesce(decision,'') || ' ' || coalesce(reason,'')",
  gotchas: "coalesce(issue,'') || ' ' || coalesce(rule,'')",
  findings: "coalesce(description,'') || ' ' || coalesce(impact,'') || ' ' || coalesce(remediation,'')",
  incidents: "coalesce(title,'') || ' ' || coalesce(what_happened,'') || ' ' || coalesce(what_we_did,'') || ' ' || coalesce(watch_for,'')",
  workflow_discovery: "coalesce(title,'') || ' ' || coalesce(detail,'')",
  agent_rewrites: "coalesce(agent_name,'') || ' ' || coalesce(as_is,'') || ' ' || coalesce(to_be,'') || ' ' || coalesce(gap,'')",
  research: "coalesce(title,'') || ' ' || coalesce(body,'')",
  tasks: "coalesce(title,'')",
  sessions: "coalesce(summary,'')",
  assertions: "coalesce(subject,'') || ' ' || coalesce(predicate,'') || ' ' || coalesce(object,'')",
  agent_exchange: "coalesce(body_caveman,'')",
};

// ─── CLI ARGS ─────────────────────────────────────────────────────────────

class UsageError extends Error {}

function parseArgs(argv) {
  const parsed = {
    db: null,
    rosterPath: null,
    dryRun: false,
    rollback: null,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--db') parsed.db = argv[++i];
    else if (a.startsWith('--db=')) parsed.db = a.slice('--db='.length);
    else if (a === '--roster') parsed.rosterPath = argv[++i];
    else if (a.startsWith('--roster=')) parsed.rosterPath = a.slice('--roster='.length);
    else if (a === '--dry-run') parsed.dryRun = true;
    else if (a === '--rollback') parsed.rollback = argv[++i];
    else if (a.startsWith('--rollback=')) parsed.rollback = a.slice('--rollback='.length);
    else if (a === '--help' || a === '-h') parsed.help = true;
    else throw new UsageError(`Unknown argument: ${a}`);
  }
  return parsed;
}

function printUsage() {
  console.log([
    'Usage: node scripts/migrations/migrate-07-reembed-corpus.js [--db <target>]',
    '         [--roster <path>] [--dry-run] [--rollback <run_id>]',
    '',
    '  --db <name>       Target database (else MIGRATE_TARGET_DB env, else',
    '                    memory_manager_staging). Never reads HANDOFF_DB.',
    '  --roster <path>   Path to source-table-roster.json (real roster --',
    '                    private estate data, gitignored). OPTIONAL: absent',
    '                    entirely degrades gracefully -- see this script\'s',
    '                    header comment ("CONTENT EXPRESSION RESOLUTION").',
    '  --dry-run         Classify + enumerate candidates only; no DB writes.',
    '  --rollback <id>   NULL out embedding+embedded_by_provider_id for every',
    '                    row this script wrote under run_id <id>. Scoped by',
    '                    embedding_write_log; never touches another run\'s rows.',
  ].join('\n'));
}

// ─── SMALL SCHEMA-INTROSPECTION HELPERS ────────────────────────────────────

async function hasColumn(client, table, col) {
  const { rows } = await client.query(
    `SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = $1 AND column_name = $2`,
    [table, col]
  );
  return rows.length > 0;
}

async function getFormatType(client, table, col) {
  const { rows } = await client.query(
    `SELECT format_type(a.atttypid, a.atttypmod) AS t
       FROM pg_attribute a
       JOIN pg_class c ON a.attrelid = c.oid
       JOIN pg_namespace n ON c.relnamespace = n.oid
      WHERE n.nspname = current_schema() AND c.relname = $1 AND a.attname = $2
        AND a.attnum > 0 AND NOT a.attisdropped`,
    [table, col]
  );
  return rows.length ? rows[0].t : null;
}

/**
 * DDL-derived embeddable-table enumeration (G-R1). Never a hand-listed
 * table array -- a pg_attribute/pg_type/pg_class scan for every base table
 * carrying a vector/halfvec column. A table with MORE than one such column
 * is a shape this script was never written for and refuses loud rather
 * than silently picking one (total classification, never a silent choice).
 */
async function discoverEmbeddableTables(client) {
  const { rows } = await client.query(`
    SELECT c.relname AS table_name, a.attname AS column_name, format_type(a.atttypid, a.atttypmod) AS coltype
      FROM pg_attribute a
      JOIN pg_class c ON a.attrelid = c.oid
      JOIN pg_namespace n ON c.relnamespace = n.oid
      JOIN pg_type t ON a.atttypid = t.oid
     WHERE n.nspname = current_schema()
       AND c.relkind = 'r'
       AND a.attnum > 0 AND NOT a.attisdropped
       AND t.typname IN ('vector', 'halfvec')
     ORDER BY c.relname, a.attname
  `);
  const byTable = new Map();
  for (const r of rows) {
    if (!byTable.has(r.table_name)) byTable.set(r.table_name, []);
    byTable.get(r.table_name).push(r);
  }
  const tables = [];
  const multiColumn = [];
  for (const [table, cols] of byTable) {
    if (cols.length > 1) { multiColumn.push({ table, cols: cols.map((c) => c.column_name) }); continue; }
    tables.push({ table, embeddingCol: cols[0].column_name, coltype: cols[0].coltype });
  }
  if (multiColumn.length > 0) {
    throw new Error(`discoverEmbeddableTables: table(s) with more than one vector/halfvec column -- this script assumes exactly one embedding column per table, never silently picks one: ${JSON.stringify(multiColumn)}`);
  }
  return tables;
}

async function ensureProvenanceColumn(client, table, log) {
  await client.query(`ALTER TABLE "${table}" ADD COLUMN IF NOT EXISTS embedded_by_provider_id INTEGER REFERENCES embedding_providers(id)`);
  log(`  [DDL] ${table}.embedded_by_provider_id ensured (idempotent).`);
}

// ─── ROSTER (soft-loaded -- see header comment) ────────────────────────────

function tryLoadRoster(rosterPathArg, log) {
  const rosterPath = rosterPathArg || shared.resolveRosterPath();
  if (!fs.existsSync(rosterPath)) {
    log(`  [ROSTER] no roster file at "${rosterPath}" -- content-expression resolution is fully self-contained via this script's own CONTENT_EXPRESSIONS for every table it recognizes; manifest-exclusion scoping (G-R7) still checks the target table's own name directly. This is the expected/supported CI posture (roster is gitignored, private estate data).`);
    return [];
  }
  const raw = fs.readFileSync(rosterPath, 'utf8');
  const roster = JSON.parse(raw);
  if (!Array.isArray(roster)) throw new Error(`roster at "${rosterPath}" must be a JSON array`);
  log(`  [ROSTER] loaded ${roster.length} entries from "${rosterPath}".`);
  return roster;
}

/**
 * Resolve + validate this table's content expression (G-R1). Declared
 * expression wins when present (see header comment); otherwise a roster
 * contentCol hint, validated against information_schema.columns, is used;
 * otherwise this table is UNCLASSIFIABLE and this function throws loud.
 * Every roster hint found for this table is validated regardless of
 * whether it ends up being used (a bad hint on a table this script already
 * has a declared expression for is STILL a bad roster row worth a loud
 * FATAL, not a silently-ignored one).
 */
async function resolveTableContentSpec(client, table, roster, log) {
  const rosterEntries = roster.filter((e) => e.targetTable === table && e.contentCol);
  for (const entry of rosterEntries) {
    const exists = await hasColumn(client, table, entry.contentCol);
    if (!exists) {
      throw new Error(
        `FATAL roster contentCol hint: source_db="${entry.source_db}" source_table="${entry.source_table}" ` +
        `targetTable="${table}" contentCol="${entry.contentCol}" -- column does not exist on "${table}". Fix the roster row.`
      );
    }
  }
  const declared = CONTENT_EXPRESSIONS[table];
  if (declared) {
    return { expr: declared, source: 'declared' };
  }
  if (rosterEntries.length > 0) {
    const hinted = rosterEntries[0];
    log(`  [CLASSIFY] ${table}: no declared CONTENT_EXPRESSIONS entry -- using validated roster contentCol="${hinted.contentCol}".`);
    return { expr: `coalesce(${hinted.contentCol},'')`, source: 'roster', contentCol: hinted.contentCol };
  }
  throw new Error(
    `UNCLASSIFIABLE: table "${table}" has an embedding column but no declared CONTENT_EXPRESSIONS entry and no ` +
    `roster contentCol hint -- refusing (total classification: every embeddable table must resolve to exactly one ` +
    `content source; unclassified is a loud FAIL, never a silent skip).`
  );
}

/**
 * Every roster source_table label that maps to this targetTable, PLUS the
 * target table's own name (covers manifest rows written under the bare
 * target-table name directly, e.g. migrate-verify-own-graph.js's
 * assertions-labeled eval-junk exclusion -- works with ZERO roster
 * dependency). Used by getManifestExcludedProjectIds (G-R7).
 */
function manifestLabelsForTable(roster, table) {
  const labels = new Set([table]);
  for (const entry of roster) {
    if (entry.targetTable === table) labels.add(entry.source_table);
  }
  return [...labels];
}

async function getManifestExcludedProjectIds(client, roster, table) {
  const labels = manifestLabelsForTable(roster, table);
  const { rows } = await client.query(
    `SELECT DISTINCT project_id_or_null FROM migration_manifest
      WHERE source_table = ANY($1::text[]) AND excluded_reason IS NOT NULL AND project_id_or_null IS NOT NULL`,
    [labels]
  );
  return new Set(rows.map((r) => r.project_id_or_null));
}

// ─── PK IDENTITY ENCODING (G-R4) ───────────────────────────────────────────

function getPkSpec(table) {
  return { cols: PK_OVERRIDES[table] || ['id'] };
}

function encodePk(pkSpec, row) {
  return {
    colStr: pkSpec.cols.join(','),
    valStr: JSON.stringify(pkSpec.cols.map((c) => row[c])),
  };
}

function decodePk(colStr, valStr) {
  const cols = colStr.split(',');
  const vals = JSON.parse(valStr);
  return cols.map((c, i) => ({ col: c, val: vals[i] }));
}

function pkWhereClause(cols, offset) {
  return cols.map((c, i) => `"${c}"=$${offset + i + 1}`).join(' AND ');
}

// ─── G-R11 PREFLIGHT (reuses verify-15-t9-negative.checkExclusion by reference) ─

async function runPreflight(client, roster, log) {
  const { rows: exclusions } = await client.query(
    `SELECT DISTINCT source_db, excluded_reason, source_table, project_id_or_null FROM migration_manifest WHERE excluded_reason IS NOT NULL`
  );
  if (exclusions.length === 0) {
    log('  [PREFLIGHT] OK: zero excluded_reason slices present in migration_manifest -- nothing to verify (T9-equivalent trivial pass).');
    return { ok: true, checked: 0 };
  }
  let failed = false;
  for (const exclusion of exclusions) {
    const label = `source_db="${exclusion.source_db}" / ${exclusion.source_table} / project_id_or_null=${exclusion.project_id_or_null ?? '(NULL-scoped)'} / excluded_reason="${exclusion.excluded_reason}"`;
    const result = await t9.checkExclusion(client, roster, exclusion, exclusion.source_db);
    if (!result.ok) {
      failed = true;
      const reason = result.reason || (result.liveCount > 0
        ? `excluded but ${result.liveCount} row(s) present in ${result.targetTable}`
        : result.provenanceDetail);
      log(`  [PREFLIGHT] FAIL: ${label}: ${reason}`);
    } else {
      log(`  [PREFLIGHT] OK: ${label}`);
    }
  }
  return { ok: !failed, checked: exclusions.length };
}

// ─── G-R2: ALTER SUB-STEP (legacy vector(1024) -> halfvec(4000)) ──────────

async function runAlterLegacyVectorColumn(client, table, log) {
  const coltype = await getFormatType(client, table, 'embedding');
  if (coltype === null) {
    log(`  [ALTER-SKIP] ${table}.embedding does not exist (pgvector likely not installed on this target) -- skipping.`);
    return { applied: false, reason: 'column-absent' };
  }
  if (coltype === 'halfvec(4000)') {
    log(`  [ALTER-SKIP] ${table}.embedding is already halfvec(4000) -- idempotent no-op.`);
    return { applied: false, reason: 'already-halfvec' };
  }
  if (!coltype.startsWith('vector')) {
    log(`  [ALTER-SKIP] ${table}.embedding has unexpected type "${coltype}" (neither vector(...) nor halfvec(4000)) -- refusing to touch a shape this migration was not written for.`);
    return { applied: false, reason: 'unexpected-type' };
  }

  // pg_depend: which views (if any) depend SPECIFICALLY on this column
  // (not merely on the table)? Live-verified: only v_memory_hits, only on
  // memory_entry_chunks.embedding.
  const { rows: depRows } = await client.query(
    `SELECT DISTINCT dv.relname AS view_name
       FROM pg_depend d
       JOIN pg_rewrite r ON d.objid = r.oid
       JOIN pg_class dv ON r.ev_class = dv.oid
       JOIN pg_attribute a ON a.attrelid = d.refobjid AND a.attnum = d.refobjsubid
       JOIN pg_class tc ON tc.oid = d.refobjid
      WHERE tc.relname = $1 AND a.attname = 'embedding' AND dv.relkind = 'v'`,
    [table]
  );

  await client.query('BEGIN');
  try {
    const viewDefs = [];
    for (const { view_name: viewName } of depRows) {
      const { rows: defRows } = await client.query(`SELECT pg_get_viewdef($1::regclass, true) AS def`, [viewName]);
      viewDefs.push({ viewName, def: defRows[0].def });
      await client.query(`DROP VIEW "${viewName}"`);
      log(`  [ALTER] dropped view "${viewName}" (depends on ${table}.embedding) -- captured its live pg_get_viewdef for recreation.`);
    }

    const { rows: idxRows } = await client.query(
      `SELECT indexname FROM pg_indexes WHERE schemaname = current_schema() AND tablename = $1
         AND indexdef ILIKE '%vector_cosine_ops%' AND indexdef NOT ILIKE '%WHERE%'`,
      [table]
    );
    for (const { indexname } of idxRows) {
      await client.query(`DROP INDEX "${indexname}"`);
      log(`  [ALTER] dropped legacy index "${indexname}" (vector_cosine_ops, non-partial) on ${table}.embedding.`);
    }

    // USING NULL, NEVER a cast -- dims differ (1024 vs 4000) and both
    // in-scope tables carry zero live embedding values on staging today,
    // so nothing is discarded.
    await client.query(`ALTER TABLE "${table}" ALTER COLUMN embedding TYPE halfvec(4000) USING NULL`);
    log(`  [ALTER] ${table}.embedding TYPE ${coltype} -> halfvec(4000) (USING NULL).`);

    const newIndexName = `${table}_embedding_hnsw_idx`;
    await client.query(
      `CREATE INDEX IF NOT EXISTS "${newIndexName}" ON "${table}" USING hnsw (embedding halfvec_cosine_ops) WITH (m='16', ef_construction='64') WHERE embedding IS NOT NULL`
    );
    log(`  [ALTER] created "${newIndexName}" USING hnsw (embedding halfvec_cosine_ops) WHERE embedding IS NOT NULL.`);

    for (const { viewName, def } of viewDefs) {
      await client.query(`CREATE VIEW "${viewName}" AS ${def}`);
      log(`  [ALTER] recreated view "${viewName}" from its captured pg_get_viewdef.`);
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  }
  return { applied: true };
}

// ─── EMBED LOOP (G-R3/G-R4/G-R5/G-R7/G-R8/G-R9/G-R10) ──────────────────────

async function embedTable(client, table, spec, provider, providerId, runId, excludedProjectIds, log, dryRun) {
  const pkSpec = getPkSpec(table);
  const selectColsList = [...new Set([...pkSpec.cols, 'project_id'])];
  const selectCols = selectColsList.map((c) => `"${c}"`).join(', ');
  let sql = `SELECT ${selectCols}, (${spec.expr}) AS __content_text FROM "${table}" WHERE embedding IS NULL`;
  const params = [];
  if (excludedProjectIds.size > 0) {
    params.push([...excludedProjectIds]);
    sql += ` AND (project_id IS NULL OR project_id <> ALL($${params.length}::text[]))`;
  }
  sql += ` ORDER BY ${pkSpec.cols.map((c) => `"${c}"`).join(', ')}`;
  const { rows } = await client.query(sql, params);

  const counts = { candidates: rows.length, embedded: 0, exemptEmptyContent: 0 };

  if (dryRun) {
    for (const row of rows) {
      const text = (row.__content_text || '').trim();
      if (!text) { counts.exemptEmptyContent++; continue; }
      log(`  [DRY-RUN] would embed ${table} pk=${encodePk(pkSpec, row).valStr}`);
    }
    return counts;
  }

  const storedDims = provider.storedDims();
  let batchId = null;

  for (const row of rows) {
    const text = (row.__content_text || '').trim();
    if (!text) {
      counts.exemptEmptyContent++;
      log(`  [EXEMPT-EMPTY-CONTENT] ${table} pk=${encodePk(pkSpec, row).valStr}: declared content expression trims to '' -- never embedded.`);
      continue;
    }

    if (batchId === null) {
      const { rows: br } = await client.query(
        `INSERT INTO embedding_migration_batches (table_name, run_id) VALUES ($1,$2) RETURNING id`,
        [table, runId]
      );
      batchId = br[0].id;
    }

    const pkVals = pkSpec.cols.map((c) => row[c]);

    await client.query('BEGIN');
    try {
      // G-R10: per single-row transaction advisory lock, namespace 44.
      await client.query(`SELECT pg_advisory_xact_lock(hashtext($1), $2)`, [`migrate-07:${table}`, LOCK_NAMESPACE]);

      // Race guard: re-check under the lock before spending a provider call.
      const { rows: recheck } = await client.query(
        `SELECT embedding FROM "${table}" WHERE ${pkWhereClause(pkSpec.cols, 0)}`,
        pkVals
      );
      if (recheck.length === 0 || recheck[0].embedding !== null) {
        await client.query('ROLLBACK');
        continue;
      }

      // G-R8: first provider error is an immediate hard stop -- never
      // caught-and-continued here; propagates out of this function.
      const result = await provider.embed(text);

      // G-R9: dim assertion before every write.
      if (!Array.isArray(result.vector) || result.vector.length !== storedDims) {
        throw new Error(
          `DIM-MISMATCH: table="${table}" pk=${JSON.stringify(pkVals)} provider returned ` +
          `${result.vector ? result.vector.length : 'no'} dims, expected storedDims=${storedDims}.`
        );
      }

      const vectorLiteral = JSON.stringify(result.vector);
      await client.query(
        `UPDATE "${table}" SET embedding=$1::halfvec, embedded_by_provider_id=$2 WHERE ${pkWhereClause(pkSpec.cols, 2)}`,
        [vectorLiteral, providerId, ...pkVals]
      );
      const { colStr, valStr } = encodePk(pkSpec, row);
      await client.query(
        `INSERT INTO embedding_write_log (batch_id, table_name, row_pk_col, row_pk_value) VALUES ($1,$2,$3,$4)`,
        [batchId, table, colStr, valStr]
      );
      await client.query('COMMIT');
      counts.embedded++;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err; // G-R8: hard stop, no skip-and-continue, no fallback embedder.
    }
  }
  return counts;
}

// ─── G-R5 PROVENANCE VERIFICATION ──────────────────────────────────────────

async function runProvenanceVerification(client, tables, log) {
  let ok = true;
  for (const table of tables) {
    const { rows: gapRows } = await client.query(
      `SELECT COUNT(*) AS n FROM "${table}" WHERE embedding IS NOT NULL AND embedded_by_provider_id IS NULL`
    );
    const gap = Number(gapRows[0].n);
    if (gap > 0) {
      ok = false;
      log(`  [PROVENANCE-FAIL] ${table}: ${gap} row(s) have embedding IS NOT NULL but embedded_by_provider_id IS NULL.`);
    }
    const { rows: nonDefaultRows } = await client.query(
      `SELECT COUNT(*) AS n FROM "${table}" t JOIN embedding_providers p ON p.id = t.embedded_by_provider_id WHERE p.is_default = false`
    );
    const nd = Number(nonDefaultRows[0].n);
    if (nd > 0) {
      log(`  [PROVENANCE-FLAG] ${table}: ${nd} row(s) were embedded by a non-default provider -- flagged for owner review, never auto-re-embedded.`);
    }
  }
  return ok;
}

// ─── G-R6 COMPLETENESS GATE ─────────────────────────────────────────────────

async function runCompletenessGate(client, tableSpecs, log) {
  let pass = true;
  const report = [];
  for (const { table, spec, hasSuppressed } of tableSpecs) {
    const suppressedExpr = hasSuppressed ? '"suppressed"' : 'false';
    const { rows } = await client.query(
      `SELECT
         COUNT(*) FILTER (WHERE length(trim(coalesce((${spec.expr}), ''))) > 0) AS pending,
         COUNT(*) FILTER (WHERE length(trim(coalesce((${spec.expr}), ''))) = 0 AND NOT (${suppressedExpr})) AS exempt_empty,
         COUNT(*) FILTER (WHERE length(trim(coalesce((${spec.expr}), ''))) = 0 AND (${suppressedExpr})) AS exempt_suppressed_empty
       FROM "${table}" WHERE embedding IS NULL`
    );
    const r = rows[0];
    const pending = Number(r.pending);
    const exemptEmpty = Number(r.exempt_empty);
    const exemptSuppressedEmpty = Number(r.exempt_suppressed_empty);
    if (pending > 0) pass = false;
    report.push({ table, pending, exemptEmpty, exemptSuppressedEmpty });
    log(`  [COMPLETENESS] ${table}: embeddable-pending=${pending} exempt-empty-content=${exemptEmpty} exempt-suppressed-and-empty=${exemptSuppressedEmpty}${pending > 0 ? ' [FAIL]' : ''}`);
    if (STRUCTURAL_DISPOSITION_TABLES.includes(table) && exemptEmpty > 0) {
      log(`  [OPEN-QUESTION] ${table}: ${exemptEmpty} row(s) have structurally empty declared content -- whether this table belongs in the embeddable set at all (vs. a richer content expression, vs. exempt-structurally-non-content-bearing) is an OWNER decision, not auto-resolved here. See PR body.`);
    }
  }
  return { pass, report };
}

// ─── G-R4 ROLLBACK ───────────────────────────────────────────────────────

async function runRollback(client, runId, log) {
  const { rows: batches } = await client.query(
    `SELECT id, table_name FROM embedding_migration_batches WHERE run_id = $1`,
    [runId]
  );
  if (batches.length === 0) {
    log(`  [ROLLBACK] no embedding_migration_batches rows for run_id="${runId}" -- nothing to roll back.`);
    return { rolledBack: 0 };
  }
  let rolledBack = 0;
  for (const batch of batches) {
    const { rows: logRows } = await client.query(
      `SELECT row_pk_col, row_pk_value FROM embedding_write_log WHERE batch_id = $1`,
      [batch.id]
    );
    for (const { row_pk_col: rowPkCol, row_pk_value: rowPkValue } of logRows) {
      const pk = decodePk(rowPkCol, rowPkValue);
      const where = pk.map((p, i) => `"${p.col}"=$${i + 1}`).join(' AND ');
      const vals = pk.map((p) => p.val);
      await client.query(`UPDATE "${batch.table_name}" SET embedding=NULL, embedded_by_provider_id=NULL WHERE ${where}`, vals);
      rolledBack++;
    }
    log(`  [ROLLBACK] ${batch.table_name} (batch_id=${batch.id}): NULLed ${logRows.length} row(s).`);
  }
  return { rolledBack };
}

// ─── MAIN ───────────────────────────────────────────────────────────────────

async function main(runtimeOpts = {}) {
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

  const { name: target, source: targetSource } = migrateOne.resolveTargetDb({ db: parsed.db });
  if (!migrateOne.DB_NAME_RE.test(target)) {
    console.error(`Invalid database name "${target}" (from ${targetSource}) — must match /^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/.`);
    return false;
  }
  const classification = migrateOne.classifyTarget(target);
  if (!classification.allowed) {
    console.error(`Refused: ${classification.reason}`);
    console.error(`(resolved from ${targetSource} — no database connection was opened.)`);
    return false;
  }

  console.log(`migrate-07-reembed-corpus: target="${target}" (resolved from ${targetSource}) mode=${parsed.rollback ? 'ROLLBACK' : parsed.dryRun ? 'DRY-RUN' : 'MIGRATE'}`);

  const client = new Client(migrateOne.pgConfig(target));
  await client.connect();

  try {
    await migrateOne.applySqlFile(client, SQL_FILE); // embedding_migration_batches + embedding_write_log

    const roster = tryLoadRoster(parsed.rosterPath, console.log);

    // ── G-R11 preflight ──────────────────────────────────────────────────
    const preflight = await runPreflight(client, roster, console.log);
    if (!preflight.ok) {
      console.error('Refused: G-R11 preflight failed -- phase (e)/(f) manifest-exclusion coverage is not intact. Nothing was embedded.');
      return false;
    }

    // ── G-R2 ALTER sub-step (idempotent, always attempted first) ──────────
    for (const t of LEGACY_VECTOR_TABLES) {
      await runAlterLegacyVectorColumn(client, t, console.log);
    }

    // ── G-R1 table discovery (post-ALTER) + provenance column ─────────────
    const discovered = await discoverEmbeddableTables(client);
    for (const { table } of discovered) {
      await ensureProvenanceColumn(client, table, console.log);
    }

    if (parsed.rollback) {
      const result = await runRollback(client, parsed.rollback, console.log);
      console.log(`ROLLBACK_RESULT: PASS (rolled_back=${result.rolledBack})`);
      return true;
    }

    // ── classify every discovered table ────────────────────────────────
    const tableSpecs = [];
    for (const { table } of discovered) {
      const spec = await resolveTableContentSpec(client, table, roster, console.log);
      const hasHash = await hasColumn(client, table, 'content_hash');
      const hasSuppressed = await hasColumn(client, table, 'suppressed');
      const bucket = hasHash ? 'A' : (spec.source === 'roster' ? 'B' : 'C');
      tableSpecs.push({ table, spec, hasHash, hasSuppressed, bucket });
      console.log(`  [CLASSIFY] ${table}: bucket=${bucket} content-source=${spec.source} expr="${spec.expr}"`);
    }

    const providerRow = runtimeOpts.providerRow || await embeddingProvider.resolveDefaultProvider(client);
    const provider = embeddingProvider.createProviderFromRow(providerRow, { transport: runtimeOpts.transport });
    console.log(`  [PROVIDER] resolved default provider "${providerRow.name}" (native_dims=${providerRow.native_dims}, stored_dims=${providerRow.stored_dims}).`);

    const runId = runtimeOpts.runId || crypto.randomUUID();
    console.log(`RUN_ID: ${runId}`);

    const report = [];
    for (const ts of tableSpecs) {
      const excludedProjectIds = await getManifestExcludedProjectIds(client, roster, ts.table);
      const counts = await embedTable(client, ts.table, ts.spec, provider, providerRow.id, runId, excludedProjectIds, console.log, parsed.dryRun);
      report.push({ table: ts.table, ...counts, excludedByManifest: excludedProjectIds.size });
      console.log(`  [EMBED] ${ts.table}: candidates=${counts.candidates} embedded=${counts.embedded} exempt-empty-content=${counts.exemptEmptyContent} excluded-project-ids=${excludedProjectIds.size}`);
    }

    if (parsed.dryRun) {
      console.log('DRY_RUN_RESULT: PASS (no writes performed)');
      return true;
    }

    const provOk = await runProvenanceVerification(client, discovered.map((d) => d.table), console.log);
    const gate = await runCompletenessGate(client, tableSpecs, console.log);

    const pass = provOk && gate.pass;
    console.log(JSON.stringify({ target, runId, report, completeness: gate.report }, null, 2));
    console.log(`MIGRATION_RESULT: ${pass ? 'PASS' : 'FAIL'} (provenance_ok=${provOk}, completeness_gate_pass=${gate.pass})`);
    return pass;
  } finally {
    await client.end();
  }
}

if (require.main === module) {
  main()
    .then((ok) => { process.exitCode = ok ? 0 : 1; })
    .catch((err) => {
      console.error(err && err.stack ? err.stack : err);
      process.exitCode = 1;
    });
}

/**
 * T8-idempotency-compatible entry point (mirrors migrate-05's run()).
 * `opts.transport`/`opts.providerRow`/`opts.runId` are in-process-only
 * injection points (never expressible via argv) -- this is how the test
 * suite exercises the embed loop deterministically without a live vLLM
 * endpoint (G-R13).
 */
async function run(targetDbName, opts = {}) {
  const argv = ['--db', targetDbName];
  if (opts.rosterPath) argv.push('--roster', opts.rosterPath);
  if (opts.rollback) argv.push('--rollback', opts.rollback);
  if (opts.dryRun) argv.push('--dry-run');
  process.argv = [process.argv[0], process.argv[1] || __filename, ...argv];
  return main({ transport: opts.transport, providerRow: opts.providerRow, runId: opts.runId });
}

module.exports = {
  parseArgs,
  UsageError,
  printUsage,
  main,
  run,
  hasColumn,
  getFormatType,
  discoverEmbeddableTables,
  ensureProvenanceColumn,
  tryLoadRoster,
  resolveTableContentSpec,
  manifestLabelsForTable,
  getManifestExcludedProjectIds,
  getPkSpec,
  encodePk,
  decodePk,
  pkWhereClause,
  runPreflight,
  runAlterLegacyVectorColumn,
  embedTable,
  runProvenanceVerification,
  runCompletenessGate,
  runRollback,
  CONTENT_EXPRESSIONS,
  LEGACY_VECTOR_TABLES,
  STRUCTURAL_DISPOSITION_TABLES,
  PK_OVERRIDES,
  LOCK_NAMESPACE,
  SQL_FILE,
};
