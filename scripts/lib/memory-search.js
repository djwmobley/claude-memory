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
 */

const { embedQuery } = require('./embed.js');

// ── M-14 closed enum (total classification — unknown table names are a hard
// tool error, mirroring S-1's "table param is a closed enum" precedent). ──
const TABLE_DESCRIPTORS = Object.freeze({
  assertions: {
    idExpr: 'id',
    labelExpr: 'subject',
    snippetExpr: `substring(coalesce(object,''), 1, 300)`,
    hasFts: false,
    whereExtra: 'suppressed = false AND invalid_at IS NULL',
  },
  agent_exchange: {
    idExpr: 'id',
    labelExpr: 'agent_id',
    snippetExpr: `substring(coalesce(body_caveman,''), 1, 300)`,
    hasFts: false,
    whereExtra: null,
  },
  decisions: {
    idExpr: 'id',
    labelExpr: 'topic',
    snippetExpr: `substring(coalesce(decision,''), 1, 300)`,
    hasFts: true,
    whereExtra: null,
  },
  gotchas: {
    idExpr: 'id',
    labelExpr: 'issue',
    snippetExpr: `substring(coalesce(rule,''), 1, 300)`,
    hasFts: true,
    whereExtra: null,
  },
  findings: {
    idExpr: 'id',
    labelExpr: 'id',
    snippetExpr: `substring(coalesce(description,''), 1, 300)`,
    hasFts: true,
    whereExtra: null,
  },
  research: {
    idExpr: 'id',
    labelExpr: 'title',
    snippetExpr: `substring(coalesce(body,''), 1, 300)`,
    hasFts: false,
    whereExtra: null,
  },
  incidents: {
    idExpr: 'id',
    labelExpr: 'title',
    snippetExpr: `substring(coalesce(what_happened,''), 1, 300)`,
    hasFts: false,
    whereExtra: null,
  },
  code_index: {
    idExpr: 'id',
    labelExpr: 'path',
    snippetExpr: `substring(coalesce(description,''), 1, 300)`,
    hasFts: true,
    whereExtra: null,
  },
  tasks: {
    idExpr: 'id',
    labelExpr: 'title',
    snippetExpr: `substring(coalesce(title,''), 1, 300)`,
    hasFts: false,
    whereExtra: null,
  },
  checklist_items: {
    idExpr: 'id',
    labelExpr: 'title',
    snippetExpr: `substring(coalesce(description, title, ''), 1, 300)`,
    hasFts: false,
    whereExtra: null,
  },
  corpus_files: {
    idExpr: 'id',
    labelExpr: 'path',
    snippetExpr: `substring(coalesce(summary, path, ''), 1, 300)`,
    hasFts: false,
    whereExtra: null,
  },
  workflow_discovery: {
    idExpr: 'id',
    labelExpr: 'title',
    snippetExpr: `substring(coalesce(detail, title, ''), 1, 300)`,
    hasFts: false,
    whereExtra: null,
  },
  agent_rewrites: {
    idExpr: 'id',
    labelExpr: 'agent_name',
    snippetExpr: `substring(coalesce(gap, as_is, ''), 1, 300)`,
    hasFts: false,
    whereExtra: null,
  },
  policy_sections: {
    idExpr: 'id',
    labelExpr: `coalesce(section_title, doc_id)`,
    snippetExpr: `substring(coalesce(content,''), 1, 300)`,
    hasFts: false,
    whereExtra: null,
  },
  session_chunks: {
    idExpr: 'id',
    labelExpr: `coalesce(chunk_kind, 'chunk')`,
    snippetExpr: `substring(coalesce(content,''), 1, 300)`,
    hasFts: false,
    whereExtra: null,
  },
});

const ALLOWED_TABLES = Object.freeze(Object.keys(TABLE_DESCRIPTORS));

class MemorySearchError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'MemorySearchError';
    this.code = code; // 'unknownTable' | 'validation'
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
 * memorySearch — §8/§10.1/§10.3.
 *
 * @param {object} client — pg client/pool
 * @param {object} args
 * @param {string} args.projectId
 * @param {string} args.query — free-text query
 * @param {string[]} [args.tables] — subset of ALLOWED_TABLES; default = all
 * @param {number} [args.limit] — default 10, applied per-table AND to the
 *   final merged result (see module header for why fetching `limit` per
 *   table is sufficient to recover the true global top-`limit`)
 * @param {(text:string) => Promise<number[]>} [args.embedder] — TEST-ONLY
 *   injectable embedder seam (same rationale as write-time-embed.js's own
 *   `opts.embedder`) — production call sites never pass this; CI (no live
 *   vLLM) injects a deterministic mock.
 * @returns {Promise<{ hits: Array, tablesSearched: string[] }>}
 * @throws {MemorySearchError} 'unknownTable' | 'validation'
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

  const tables = Array.isArray(args.tables) && args.tables.length ? args.tables : ALLOWED_TABLES.slice();
  const unknown = tables.filter((t) => !ALLOWED_TABLES.includes(t));
  if (unknown.length) {
    throw new MemorySearchError(
      'unknownTable',
      `memory_search: unknown table(s) [${unknown.join(', ')}] (allowed: ${ALLOWED_TABLES.join(', ')})`,
      { unknown }
    );
  }

  const embedFn = args.embedder || embedQuery; // fail-loud by embed.js's own contract (or the injected mock)
  const queryVector = await embedFn(query);
  const vectorLiteral = `[${queryVector.join(',')}]`;

  const valuesByKey = { vector: vectorLiteral, query, projectId, limit };
  const perTableResults = await Promise.all(
    tables.map(async (table) => {
      const { sql, paramKeys } = buildTableQuery(table);
      const values = paramKeys.map((k) => valuesByKey[k]);
      const { rows } = await client.query(sql, values);
      return rows;
    })
  );

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
    tablesSearched: tables,
  };
}

module.exports = {
  TABLE_DESCRIPTORS,
  ALLOWED_TABLES,
  MemorySearchError,
  buildTableQuery,
  memorySearch,
};
