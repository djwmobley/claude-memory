'use strict';

/**
 * memory-search.js — §8/§10 memory_search: hybrid vector+FTS, project-scoped
 * recall across the generalized MCP tool surface (CONSOLIDATION-RUNBOOK.md
 * §8's memory_search bullet + M-14, §10.1's vector-kind un-stub, §10.3's
 * hybrid scoring formula, memory-manager#18).
 *
 * TABLE ENUM (M-14) — derived at authoring time from the LIVE staging DDL
 * (psql memory_manager_staging, 2026-08-15), not the runbook's illustrative
 * §10.2 view sketch, which predates several of the schema's actual
 * per-table column shapes:
 *
 *   - assertions: has `embedding halfvec(4000)`, NO `fts_vec` column (§10.2's
 *     own view sketch already selects `NULL::tsvector AS fts_vec` for
 *     assertions — confirmed against the live catalog, not just the sketch).
 *   - agent_exchange: has `embedding halfvec(4000)`, NO `fts_vec` column.
 *     M-14 explicitly calls this out — "agent_exchange PARTICIPATES" —
 *     despite failing the literal "carries BOTH fts_vec and embedding"
 *     filter, exactly like assertions. Both are included with a
 *     structurally-zero FTS term (see SCORING below).
 *   - decisions/gotchas/findings/code_index: the ONLY 4 of the 13 §5.3 seam
 *     tables that carry BOTH `fts_vec` (migrate-14-seam-tables.sql) AND
 *     `embedding` (migrate-14-seam-tables-embeddings.sql) — confirmed live.
 *   - research/incidents/tasks/checklist_items/corpus_files/
 *     workflow_discovery/agent_rewrites/policy_sections/session_chunks: the
 *     other 9 seam tables carry `embedding` only, no `fts_vec` — included
 *     with a structurally-zero FTS term, same as assertions/agent_exchange.
 *   - memory_entry_chunks: DELIBERATELY EXCLUDED. Its `embedding` column is
 *     `vector(1024)` (pgvector's plain `vector` type, legacy pre-Qwen3
 *     provider), NOT `halfvec(4000)` like every other table's `embedding`
 *     column — a genuine, load-bearing TYPE and DIMENSION mismatch the
 *     runbook's §10.2 sketch does not address (it lists memory_entry_chunks
 *     as a UNION member without noting this). Casting/truncating a
 *     halfvec(4000) query vector to compare against a vector(1024) column
 *     would either error or produce a semantically meaningless similarity
 *     score (no guarantee the legacy provider's 1024-dim space is even the
 *     same embedding model's prefix). Excluding it is a unilaterally-
 *     resolved decision, flagged here and in the authoring PR body — NOT a
 *     silent omission.
 *
 * SCORING (§10.3, applied per-table): `score = COALESCE(ts_rank(fts_vec,
 * plainto_tsquery('english', $query)), 0) * 0.3 + (1 - (embedding <=>
 * $queryVec::halfvec)) * 0.7`. For a table with no `fts_vec` column, the
 * ts_rank term is a literal `0` (never computed, never a NULL propagating
 * through the arithmetic) — the SAME formula, just structurally zero on its
 * first term for that table, exactly mirroring how §10.2's own view sketch
 * treats assertions' `NULL::tsvector`.
 *
 * QUERY SHAPE — per-table, not a single cross-table UNION: pgvector's
 * `halfvec` and `vector` types cannot coexist in one UNION ALL column
 * without an explicit (and here, invalid) cast, so this module runs ONE
 * parameterized query per requested table and merges results in JS.
 * CORRECTNESS OF THE PER-TABLE-LIMIT MERGE: fetching the top-`limit` rows
 * from EVERY requested table and re-sorting the union by score is
 * mathematically guaranteed to recover the true global top-`limit` (not a
 * heuristic): for any row r in the true global top-K, at most K-1 other
 * rows (across ALL sources combined) can outscore it — so at most K-1 rows
 * WITHIN r's own source can outscore it, meaning r is always within that
 * source's own local top-K. Hence global top-K subset-of union of local
 * top-K, for every K.
 *
 * ── PER-TABLE AVAILABILITY GATE (adversary review, 2026-09-09) ────────────
 * The original existence probe (schemaObjectsExist({tables})) was TABLE-only
 * — it never checked that the columns buildTableQuery's SQL text actually
 * references (the embedding column above all) are present. A "degraded"
 * schema (cm#224/#225: table created, but a pgvector-gated column/index was
 * skipped at apply time because the `vector` extension was unavailable) has
 * the table present and every referenced column absent, so the OLD probe
 * reported "present" and buildTableQuery's SQL then threw 42703
 * (undefined_column) at client.query — failing the WHOLE memory_search call
 * for every table, not just the degraded one. Eight findings drove this
 * rewrite (also enumerated in the authoring PR body):
 *   1. type mismatch — a column can exist with the wrong pgvector type/dims
 *      (checkColumnShape, not just existence).
 *   2. view vs table — schemaObjectsExist's tables probe never filtered by
 *      table_type, so a same-named VIEW would have satisfied "present".
 *   3. extension absent — pgvector missing surfaces as 42704/42883
 *      (undefined_object/undefined_function) from the live query, a THIRD
 *      degraded shape beyond "table missing" and "column missing".
 *   4. connection fan-out — a dead/degraded connection must not turn into
 *      15 misleading per-table "query_error" skips.
 *   5. `tables: []` — an explicit empty array is NOT "everything"; it was
 *      silently coerced to the full default enum by `array.length ?` truthy
 *      checks below.
 *   6. `allSkipped` — callers had no single boolean to check "did this
 *      search actually run against anything".
 *   7. declared-list drift — a descriptor's expression strings and its
 *      declared `requiredColumns` list can silently diverge as the SQL
 *      text is edited; enforced by a static test, not at runtime.
 *   8. probe/query session — the probe and the live query must resolve
 *      identifiers against the SAME schema. This module's client is always
 *      a single-connection `pg.Client` (never a `Pool` — see db-seam.js's
 *      PostgresAdapter/connectForRoot, the only production caller), so the
 *      probe's `current_schema()` and the query's unqualified table names
 *      already resolve against the identical session with no code change
 *      required here; documented rather than re-implemented via an explicit
 *      schema-qualification, since there is no code path in this codebase
 *      where memorySearch's `client` argument is backed by a connection
 *      pool.
 *
 * TOTAL CLASSIFICATION — every candidate table lands in exactly one of:
 *   (a) table_missing   — schemaObjectsExist reports the BASE TABLE absent.
 *   (b) column_missing  — a `requiredColumns` entry is absent, OR a shape
 *                          check (embedding/FTS column) reports a mismatch
 *                          (`detail.subReason === 'type_mismatch'`).
 *   (c) queried          — present and shape-correct; the live SELECT runs.
 * A table that reaches (c) but whose live query still throws lands in a
 * FOURTH bucket, `query_error` (SQLSTATE attached; `subReason:
 * 'extension_absent'` for 42704/42883), UNLESS the error is connection-class
 * (SQLSTATE class 08/28) or an identical SQLSTATE has now recurred on ≥2
 * tables — either escalates to a call-level throw instead of a per-table
 * skip, so a dead connection is reported once, not fanned out.
 */

const { embedQuery } = require('./embed.js');

// Every table's embedding column has the identical name and pgvector shape
// (halfvec(4000), Qwen3-Embedding-8B's output dimension) — see the
// memory_entry_chunks exclusion note above for the one table that does NOT
// share this shape (and is therefore not in TABLE_DESCRIPTORS at all).
const EMBEDDING_COLUMN = 'embedding';
const EMBEDDING_SHAPE = Object.freeze({ type: 'halfvec', dims: 4000 });
const FTS_COLUMN = 'fts_vec';
const FTS_SHAPE_TYPE = 'tsvector';

// SQLSTATE classes (first two chars) that mean "the connection/session
// itself is the problem", never "this one table's schema is the problem":
// class 08 = connection_exception, class 28 = invalid_authorization_specification.
const CONNECTION_ERROR_CLASSES = new Set(['08', '28']);
// undefined_object (extension-provided type, e.g. halfvec, missing) /
// undefined_function (extension-provided operator, e.g. <=>, missing) — the
// live-query signature of "pgvector extension not installed on this DB",
// distinct from a plain missing-column 42703.
const EXTENSION_ABSENT_SQLSTATES = new Set(['42704', '42883']);

// ── M-14 closed enum (total classification — unknown table names are a hard
// tool error, mirroring S-1's "table param is a closed enum" precedent). ──
// `requiredColumns` lists EVERY column referenced anywhere in this table's
// idExpr/labelExpr/snippetExpr/whereExtra/embedding/FTS — enforced against
// drift by a static test (parses the expression strings; never trusted at
// runtime — the declared list here is authoritative for the probe).
const TABLE_DESCRIPTORS = Object.freeze({
  assertions: {
    idExpr: 'id',
    labelExpr: 'subject',
    snippetExpr: `substring(coalesce(object,''), 1, 300)`,
    hasFts: false,
    whereExtra: 'suppressed = false AND invalid_at IS NULL',
    requiredColumns: ['id', 'subject', 'object', 'suppressed', 'invalid_at', 'project_id', EMBEDDING_COLUMN],
  },
  agent_exchange: {
    idExpr: 'id',
    labelExpr: 'agent_id',
    snippetExpr: `substring(coalesce(body_caveman,''), 1, 300)`,
    hasFts: false,
    whereExtra: null,
    requiredColumns: ['id', 'agent_id', 'body_caveman', 'project_id', EMBEDDING_COLUMN],
  },
  decisions: {
    idExpr: 'id',
    labelExpr: 'topic',
    snippetExpr: `substring(coalesce(decision,''), 1, 300)`,
    hasFts: true,
    whereExtra: null,
    requiredColumns: ['id', 'topic', 'decision', 'project_id', EMBEDDING_COLUMN, FTS_COLUMN],
  },
  gotchas: {
    idExpr: 'id',
    labelExpr: 'issue',
    snippetExpr: `substring(coalesce(rule,''), 1, 300)`,
    hasFts: true,
    whereExtra: null,
    requiredColumns: ['id', 'issue', 'rule', 'project_id', EMBEDDING_COLUMN, FTS_COLUMN],
  },
  findings: {
    idExpr: 'id',
    labelExpr: 'id',
    snippetExpr: `substring(coalesce(description,''), 1, 300)`,
    hasFts: true,
    whereExtra: null,
    requiredColumns: ['id', 'description', 'project_id', EMBEDDING_COLUMN, FTS_COLUMN],
  },
  research: {
    idExpr: 'id',
    labelExpr: 'title',
    snippetExpr: `substring(coalesce(body,''), 1, 300)`,
    hasFts: false,
    whereExtra: null,
    requiredColumns: ['id', 'title', 'body', 'project_id', EMBEDDING_COLUMN],
  },
  incidents: {
    idExpr: 'id',
    labelExpr: 'title',
    snippetExpr: `substring(coalesce(what_happened,''), 1, 300)`,
    hasFts: false,
    whereExtra: null,
    requiredColumns: ['id', 'title', 'what_happened', 'project_id', EMBEDDING_COLUMN],
  },
  code_index: {
    idExpr: 'id',
    labelExpr: 'path',
    snippetExpr: `substring(coalesce(description,''), 1, 300)`,
    hasFts: true,
    whereExtra: null,
    requiredColumns: ['id', 'path', 'description', 'project_id', EMBEDDING_COLUMN, FTS_COLUMN],
  },
  tasks: {
    idExpr: 'id',
    labelExpr: 'title',
    snippetExpr: `substring(coalesce(title,''), 1, 300)`,
    hasFts: false,
    whereExtra: null,
    requiredColumns: ['id', 'title', 'project_id', EMBEDDING_COLUMN],
  },
  checklist_items: {
    idExpr: 'id',
    labelExpr: 'title',
    snippetExpr: `substring(coalesce(description, title, ''), 1, 300)`,
    hasFts: false,
    whereExtra: null,
    requiredColumns: ['id', 'title', 'description', 'project_id', EMBEDDING_COLUMN],
  },
  corpus_files: {
    idExpr: 'id',
    labelExpr: 'path',
    snippetExpr: `substring(coalesce(summary, path, ''), 1, 300)`,
    hasFts: false,
    whereExtra: null,
    requiredColumns: ['id', 'path', 'summary', 'project_id', EMBEDDING_COLUMN],
  },
  workflow_discovery: {
    idExpr: 'id',
    labelExpr: 'title',
    snippetExpr: `substring(coalesce(detail, title, ''), 1, 300)`,
    hasFts: false,
    whereExtra: null,
    requiredColumns: ['id', 'title', 'detail', 'project_id', EMBEDDING_COLUMN],
  },
  agent_rewrites: {
    idExpr: 'id',
    labelExpr: 'agent_name',
    snippetExpr: `substring(coalesce(gap, as_is, ''), 1, 300)`,
    hasFts: false,
    whereExtra: null,
    requiredColumns: ['id', 'agent_name', 'gap', 'as_is', 'project_id', EMBEDDING_COLUMN],
  },
  policy_sections: {
    idExpr: 'id',
    labelExpr: `coalesce(section_title, doc_id)`,
    snippetExpr: `substring(coalesce(content,''), 1, 300)`,
    hasFts: false,
    whereExtra: null,
    requiredColumns: ['id', 'section_title', 'doc_id', 'content', 'project_id', EMBEDDING_COLUMN],
  },
  session_chunks: {
    idExpr: 'id',
    labelExpr: `coalesce(chunk_kind, 'chunk')`,
    snippetExpr: `substring(coalesce(content,''), 1, 300)`,
    hasFts: false,
    whereExtra: null,
    requiredColumns: ['id', 'chunk_kind', 'content', 'project_id', EMBEDDING_COLUMN],
  },
});

const ALLOWED_TABLES = Object.freeze(Object.keys(TABLE_DESCRIPTORS));

class MemorySearchError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'MemorySearchError';
    // 'unknownTable' | 'validation' | 'connectionError'
    this.code = code;
    this.details = details || null;
  }
}

/**
 * Build the per-table SELECT. Identifiers come ONLY from TABLE_DESCRIPTORS
 * (never caller input) — table/column names are never interpolated from
 * caller-supplied strings; the only caller-supplied SQL text is the FULLY
 * PARAMETERIZED query string/vector/project_id/limit.
 *
 * Placeholder count is PER-TABLE, not fixed: a table with no `fts_vec`
 * column never references the query-text parameter at all in its SQL text
 * (the FTS term is the literal `0`), and Postgres refuses to plan a
 * parameter that appears in NO expression at all ("could not determine
 * data type of parameter", 42P18) — so the query-text placeholder is
 * OMITTED (not merely unused) for `hasFts: false` tables, and every
 * placeholder after it is renumbered accordingly. Returns both the SQL text
 * and the ordered list of value KEYS ('vector'|'query'|'projectId'|'limit')
 * so the caller binds the right values in the right position without
 * duplicating this table's hasFts branch.
 */
function buildTableQuery(table) {
  const d = TABLE_DESCRIPTORS[table];
  const whereExtra = d.whereExtra ? ` AND ${d.whereExtra}` : '';

  const paramKeys = d.hasFts ? ['vector', 'query', 'projectId', 'limit'] : ['vector', 'projectId', 'limit'];
  const ph = {};
  paramKeys.forEach((k, i) => { ph[k] = `$${i + 1}`; });

  const ftsTerm = d.hasFts
    ? `COALESCE(ts_rank(fts_vec, plainto_tsquery('english', ${ph.query})), 0)`
    : `0`;

  const sql = `
    SELECT '${table}'::text AS source_table,
           (${d.idExpr})::text AS id,
           (${d.labelExpr})::text AS label,
           ${d.snippetExpr} AS snippet,
           (${ftsTerm} * 0.3 + (1 - (embedding <=> ${ph.vector}::halfvec)) * 0.7) AS score
      FROM "${table}"
     WHERE project_id = ${ph.projectId} AND embedding IS NOT NULL${whereExtra}
     ORDER BY score DESC
     LIMIT ${ph.limit}`;

  return { sql, paramKeys };
}

/**
 * classifyQueryError — sorts a thrown client.query() error into the S4
 * total classification: connection-class (escalate, never a per-table
 * skip) vs. ordinary query error (per-table skip), and tags the
 * extension-absent sub-case.
 */
function classifyQueryError(err) {
  const code = err && typeof err.code === 'string' ? err.code : null;
  const errClass = code ? code.slice(0, 2) : null;
  return {
    code,
    isConnectionClass: errClass !== null && CONNECTION_ERROR_CLASSES.has(errClass),
    isExtensionAbsent: code !== null && EXTENSION_ABSENT_SQLSTATES.has(code),
  };
}

/**
 * probeTableAvailability — the S1-S2 per-table gate. For each candidate
 * table, resolves exactly one of 'table_missing' | 'column_missing' | 'ok'.
 *
 * Runs on the SAME `client` the live queries below run on (see module
 * header §8: this codebase's only production `client` is a single
 * `pg.Client`, never a `Pool`), so `schemaObjectsExist`'s
 * `current_schema()` and `checkColumnShape`'s `::regclass` resolution
 * already share the live queries' session/search_path with no additional
 * schema-qualification needed.
 *
 * A bare pg Client/Pool with neither `schemaObjectsExist` nor
 * `checkColumnShape` (no db-seam.js wrapper) degrades to "assume every
 * candidate exists, skip shape checks" — unchanged legacy behavior for any
 * such caller, same as before this rewrite.
 *
 * @returns {Promise<Map<string, {status:'ok'|'table_missing'|'column_missing', detail?:object}>>}
 */
async function probeTableAvailability(client, tables) {
  const result = new Map();

  if (typeof client.schemaObjectsExist !== 'function') {
    for (const t of tables) result.set(t, { status: 'ok' });
    return result;
  }

  const columnsExpected = [];
  for (const t of tables) {
    for (const c of TABLE_DESCRIPTORS[t].requiredColumns) columnsExpected.push({ table: t, column: c });
  }

  const { missing } = await client.schemaObjectsExist({ tables, columns: columnsExpected });

  // schemaObjectsExist's own documented contract is "never throws" — a
  // probe-level failure (e.g. a dead connection) is instead reported as a
  // synthetic {type:'error'} entry. Fanning THAT out as 15 per-table
  // column_missing skips would be exactly the misleading behavior S4
  // forbids for live-query connection errors, so it is treated the same
  // way here: escalate to a call-level throw.
  const probeError = missing.find((m) => m.type === 'error');
  if (probeError) {
    throw new MemorySearchError(
      'connectionError',
      `memory_search: the schema existence probe itself failed (${probeError.message}) — treating as a dead/degraded ` +
        `connection rather than reporting every candidate table as column_missing`,
      { message: probeError.message }
    );
  }

  const missingTables = new Set(missing.filter((m) => m.type === 'table').map((m) => m.table));
  const missingColsByTable = new Map();
  for (const m of missing) {
    if (m.type !== 'column') continue;
    if (!missingColsByTable.has(m.table)) missingColsByTable.set(m.table, []);
    missingColsByTable.get(m.table).push(m.column);
  }

  const shapeCandidates = [];
  for (const t of tables) {
    if (missingTables.has(t)) { result.set(t, { status: 'table_missing' }); continue; }
    const missingCols = missingColsByTable.get(t);
    if (missingCols && missingCols.length) {
      result.set(t, { status: 'column_missing', detail: { columns: missingCols.slice() } });
      continue;
    }
    shapeCandidates.push(t);
  }

  if (typeof client.checkColumnShape === 'function') {
    for (const t of shapeCandidates) {
      const d = TABLE_DESCRIPTORS[t];
      const mismatchedColumns = [];

      const embShape = await client.checkColumnShape(t, EMBEDDING_COLUMN);
      // checkColumnShape returns null on ANY probe failure (including
      // "column does not exist", already ruled out above by the column
      // existence probe) — per its own contract, null is NEVER treated as
      // a mismatch, only an actual shape disagreement is.
      if (embShape && (embShape.type !== EMBEDDING_SHAPE.type || embShape.dims !== EMBEDDING_SHAPE.dims)) {
        mismatchedColumns.push({ column: EMBEDDING_COLUMN, expected: EMBEDDING_SHAPE, actual: embShape });
      }

      if (d.hasFts) {
        const ftsShape = await client.checkColumnShape(t, FTS_COLUMN);
        if (ftsShape && ftsShape.type !== FTS_SHAPE_TYPE) {
          mismatchedColumns.push({ column: FTS_COLUMN, expected: { type: FTS_SHAPE_TYPE }, actual: ftsShape });
        }
      }

      if (mismatchedColumns.length) {
        result.set(t, {
          status: 'column_missing',
          detail: { columns: mismatchedColumns.map((m) => m.column), subReason: 'type_mismatch', mismatches: mismatchedColumns },
        });
      } else {
        result.set(t, { status: 'ok' });
      }
    }
  } else {
    for (const t of shapeCandidates) result.set(t, { status: 'ok' });
  }

  return result;
}

/**
 * memorySearch — §8/§10.1/§10.3.
 *
 * @param {object} client — pg client/pool
 * @param {object} args
 * @param {string} args.projectId
 * @param {string} args.query — free-text query
 * @param {string[]} [args.tables] — subset of ALLOWED_TABLES. Omitted ->
 *   every ALLOWED_TABLES entry is a candidate. An explicit `[]` is NOT the
 *   same as omitted — it means zero candidates, and returns immediately
 *   with `hits: []`, `allSkipped: false` (nothing was skipped; nothing was
 *   asked for either). Duplicate entries (`["decisions","decisions"]`) are
 *   collapsed to one candidate, first-occurrence order preserved, after the
 *   unknown-table validation and before the `[]` emptiness check — a
 *   duplicate never queries its table twice or double-counts hits.
 * @param {number} [args.limit] — default 10, applied per-table AND to the
 *   final merged result (see module header for why fetching `limit` per
 *   table is sufficient to recover the true global top-`limit`)
 * @param {(text:string) => Promise<number[]>} [args.embedder] — TEST-ONLY
 *   injectable embedder seam (same rationale as write-time-embed.js's own
 *   `opts.embedder`) — production call sites never pass this; CI (no live
 *   vLLM) injects a deterministic mock.
 *
 * AVAILABILITY GATE — see module header. Every candidate table lands in
 * exactly one of: queried (tablesSearched) | table_missing | column_missing
 * | query_error (skippedTables, each `{table, reason, detail}`). A
 * connection-class query error (SQLSTATE class 08/28), a probe-level
 * failure, or an identical SQLSTATE recurring on ≥2 tables escalates to a
 * thrown MemorySearchError('connectionError', ...) instead of fanning out
 * per-table skips — never fatal for an ordinary per-table schema gap, but
 * NOT silently swallowed when the connection itself is the problem.
 *
 * @returns {Promise<{ hits: Array, tablesSearched: string[], skippedTables: Array<{table:string, reason:string, detail?:object}>, allSkipped: boolean }>}
 * @throws {MemorySearchError} 'unknownTable' | 'validation' | 'connectionError'
 */
async function memorySearch(client, args) {
  const { projectId, query } = args || {};
  if (typeof projectId !== 'string' || !projectId.trim()) {
    throw new MemorySearchError('validation', 'memory_search: projectId is required and must be a non-empty string');
  }
  if (typeof query !== 'string' || !query.trim()) {
    throw new MemorySearchError('validation', 'memory_search: query is required and must be a non-empty string');
  }
  const limit = Number.isInteger(args.limit) && args.limit > 0 ? args.limit : 10;

  // Total classification of `args.tables`: omitted -> full enum; an array
  // (including an explicit empty one) -> exactly that array; anything else
  // -> a hard validation error. `tables: []` is deliberately NOT coerced to
  // the full enum (S3/finding #5) — it is zero candidates, reported below.
  let candidateTables;
  if (args.tables === undefined) {
    candidateTables = ALLOWED_TABLES.slice();
  } else if (Array.isArray(args.tables)) {
    candidateTables = args.tables.slice();
  } else {
    throw new MemorySearchError('validation', 'memory_search: tables, when provided, must be an array of table names');
  }

  const unknown = candidateTables.filter((t) => !ALLOWED_TABLES.includes(t));
  if (unknown.length) {
    throw new MemorySearchError(
      'unknownTable',
      `memory_search: unknown table(s) [${unknown.join(', ')}] (allowed: ${ALLOWED_TABLES.join(', ')})`,
      { unknown }
    );
  }

  // De-duplicate AFTER the unknown-table rejection above (so a duplicate of
  // an invalid name still surfaces in the 'unknownTable' error) and BEFORE
  // the `tables: []` short-circuit below (so the emptiness check operates on
  // the deduped list, not the raw one — a request of `["x","x"]` never
  // reaches the empty-candidates branch, and `[]` still does). Duplicates
  // otherwise query the same table twice and return duplicate hits — a
  // requester's `tables: ["decisions","decisions"]` is understood as
  // "search decisions", not "search decisions twice at double weight".
  // Order is first-occurrence order (Set preserves insertion order).
  candidateTables = [...new Set(candidateTables)];

  if (candidateTables.length === 0) {
    // Explicit `tables: []` — zero candidates is not "everything" and not
    // a degraded search either; nothing was requested, so nothing was
    // skipped.
    return { hits: [], tablesSearched: [], skippedTables: [], allSkipped: false };
  }

  const skippedTables = [];
  const availability = await probeTableAvailability(client, candidateTables);
  const tables = [];
  for (const t of candidateTables) {
    const a = availability.get(t) || { status: 'ok' };
    if (a.status === 'ok') tables.push(t);
    else skippedTables.push({ table: t, reason: a.status, detail: a.detail || null });
  }

  if (tables.length === 0) {
    // Every candidate table is missing or shape-mismatched — nothing to
    // search. Skip the embed call entirely (no point embedding a query with
    // no table to run it against) and report every candidate as skipped.
    return { hits: [], tablesSearched: [], skippedTables, allSkipped: true };
  }

  const embedFn = args.embedder || embedQuery; // fail-loud by embed.js's own contract (or the injected mock)
  const queryVector = await embedFn(query);
  const vectorLiteral = `[${queryVector.join(',')}]`;

  // Sequential, not Promise.all: a plain pg Client/PostgresAdapter serves
  // one query at a time on a single connection — concurrent .query() calls
  // on it queue internally rather than actually running in parallel (same
  // constraint memory-lint.js's checkUnlinkedMentions already documents for
  // its own sequential queries), and node-postgres additionally logs a
  // deprecation warning for overlapping .query() calls on one Client,
  // slated to become a hard error in pg@9. A loop is the correct shape here
  // regardless of the (non-)concurrency question — result-merge logic
  // (flatten + re-sort + slice) is unchanged.
  const valuesByKey = { vector: vectorLiteral, query, projectId, limit };
  const perTableResults = [];
  const tablesSearched = [];
  const codeOccurrences = new Map();
  for (const table of tables) {
    const { sql, paramKeys } = buildTableQuery(table);
    const values = paramKeys.map((k) => valuesByKey[k]);
    try {
      const { rows } = await client.query(sql, values);
      perTableResults.push(rows);
      tablesSearched.push(table);
    } catch (err) {
      const { code, isConnectionClass, isExtensionAbsent } = classifyQueryError(err);
      if (isConnectionClass) {
        throw new MemorySearchError(
          'connectionError',
          `memory_search: connection-class error (SQLSTATE ${code || 'unknown'}) on table "${table}" aborted the ` +
            `whole call rather than being reported as a per-table skip: ${err.message}`,
          { table, code, message: err.message }
        );
      }
      if (code) {
        const occurrences = (codeOccurrences.get(code) || 0) + 1;
        codeOccurrences.set(code, occurrences);
        if (occurrences >= 2) {
          throw new MemorySearchError(
            'connectionError',
            `memory_search: SQLSTATE ${code} recurred on ${occurrences} tables — treating this as a dead/degraded ` +
              `connection or missing shared dependency (e.g. the pgvector extension) rather than fanning out a ` +
              `per-table skip for every remaining table: ${err.message}`,
            { table, code, message: err.message, occurrences }
          );
        }
      }
      skippedTables.push({
        table,
        reason: 'query_error',
        detail: {
          sqlstate: code,
          message: err.message,
          ...(isExtensionAbsent ? { subReason: 'extension_absent' } : {}),
        },
      });
    }
  }

  const allHits = perTableResults.flat();
  allHits.sort((a, b) => Number(b.score) - Number(a.score));

  return {
    hits: allHits.slice(0, limit).map((r) => ({
      sourceTable: r.source_table,
      id: r.id,
      label: r.label,
      snippet: r.snippet,
      score: Number(r.score),
    })),
    tablesSearched,
    skippedTables,
    allSkipped: candidateTables.length > 0 && tablesSearched.length === 0,
  };
}

module.exports = {
  TABLE_DESCRIPTORS,
  ALLOWED_TABLES,
  EMBEDDING_COLUMN,
  FTS_COLUMN,
  MemorySearchError,
  buildTableQuery,
  probeTableAvailability,
  classifyQueryError,
  memorySearch,
};
