'use strict';

/**
 * memory-view.js — §8 memory_view_set / memory_view_run
 * (CONSOLIDATION-RUNBOOK.md §8, M-15/M-16, memory-manager#18).
 *
 * CRUD + execute on saved `retrieval_contract` `kind:'view'` rows.
 *
 * M-15: requires `retrieval_contract.kind TEXT NOT NULL DEFAULT 'contract'
 * CHECK (kind IN ('contract','view'))` (migrate-15-mcp-addenda.sql). A
 * `retrieval_contract` row with no `kind` column write ever reaches this
 * table without one, thanks to the DEFAULT — existing next-session-contract
 * rows written before this migration are `kind='contract'` by the default,
 * never silently reinterpreted as a view.
 *
 * M-16: memoryViewRun interprets ONLY the existing structured §4
 * query-type JSON (entity/assertion/recency/vector) — NEVER raw SQL text.
 * Any future raw-SQL view capability requires its own owner-confirmed
 * authorization design (explicitly out of scope here).
 *
 * NOT byte-identical code reuse of handoff.js's own contract-query dispatch
 * (cmdLoaderLoad's `for (const q of queries)` loop, ~handoff.js:2755+): that
 * function is tightly coupled to markdown-section assembly and
 * session-load token-budget state (tokenBudget, handoffPath, tierAware
 * gates, etc.) and returns rendered markdown, not structured JSON — not a
 * clean function to call from an MCP tool that needs a JSON result. This
 * module is a deliberately SMALLER, self-contained interpreter scoped to
 * exactly the 4 query types M-16 names, mirroring the SAME WHERE-clause
 * shape (same tables/predicates) as handoff.js's own entity/assertion/
 * recency branches, and delegating to memory-search.js's memorySearch (by
 * reference) for the vector type — never a second embedding/scoring
 * implementation. Flagged as a unilaterally-resolved design choice in the
 * authoring PR body, not a silent divergence.
 */

const { memorySearch } = require('./memory-search.js');

class MemoryViewError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'MemoryViewError';
    this.code = code;
    this.details = details || null;
  }
}

function requireNonEmptyString(value, name) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new MemoryViewError('validation', `memory-view: "${name}" is required and must be a non-empty string`);
  }
  return value;
}

const SUPPORTED_QUERY_TYPES = Object.freeze(['entity', 'assertion', 'recency', 'vector']);

function validateQueries(queries) {
  if (!Array.isArray(queries) || queries.length === 0) {
    throw new MemoryViewError('validation', 'memory-view: queries must be a non-empty array');
  }
  for (const [i, q] of queries.entries()) {
    const type = q && (q.type || q.kind);
    if (!SUPPORTED_QUERY_TYPES.includes(type)) {
      throw new MemoryViewError(
        'unsupportedQueryType',
        `memory-view: queries[${i}] has unsupported type ${JSON.stringify(type)} (allowed: ${SUPPORTED_QUERY_TYPES.join(', ')}) — M-16: only the structured §4 query-type JSON is interpreted, never raw SQL.`
      );
    }
  }
}

/**
 * memoryViewSet — create or update a `kind='view'` retrieval_contract row.
 * Guards against a cross-kind collision (a 'view' name colliding with an
 * existing 'contract' row, or vice versa) — never silently converts one
 * kind into the other.
 */
async function memoryViewSet(client, { projectId, name, queries }) {
  requireNonEmptyString(projectId, 'projectId');
  requireNonEmptyString(name, 'name');
  validateQueries(queries);

  const { rows: existingRows } = await client.query(
    `SELECT id, kind FROM retrieval_contract WHERE project_id = $1 AND name = $2`,
    [projectId, name]
  );
  if (existingRows.length > 0 && existingRows[0].kind !== 'view') {
    throw new MemoryViewError(
      'kindCollision',
      `memory_view_set: a retrieval_contract row named "${name}" already exists for this project with kind="${existingRows[0].kind}" — refusing to silently convert it to a view. Choose a different name.`
    );
  }

  const { rows } = await client.query(
    `INSERT INTO retrieval_contract (project_id, name, queries, kind, version)
     VALUES ($1, $2, $3::jsonb, 'view', 1)
     ON CONFLICT (project_id, name) DO UPDATE SET
       queries = EXCLUDED.queries,
       kind = 'view',
       version = retrieval_contract.version + 1,
       updated_at = now()
     RETURNING *`,
    [projectId, name, JSON.stringify(queries)]
  );
  return rows[0];
}

async function memoryViewGet(client, { projectId, name }) {
  requireNonEmptyString(projectId, 'projectId');
  requireNonEmptyString(name, 'name');
  const { rows } = await client.query(
    `SELECT * FROM retrieval_contract WHERE project_id = $1 AND name = $2 AND kind = 'view'`,
    [projectId, name]
  );
  return rows[0] || null;
}

// ── M-16 interpreters, one per supported query type ────────────────────

async function runEntityQuery(client, projectId, q) {
  const { rows } = await client.query(
    `SELECT name, entity_type, description FROM entities
      WHERE project_id = $1 AND ($2::text IS NULL OR name = $2) AND suppressed = false
      ORDER BY created_at DESC LIMIT $3`,
    [projectId, (q.filter && q.filter.name) || null, q.limit || 20]
  );
  return rows;
}

async function runAssertionQuery(client, projectId, q) {
  const { rows } = await client.query(
    `SELECT subject, predicate, object, confidence, created_at FROM assertions
      WHERE project_id = $1
        AND ($2::text IS NULL OR subject = $2)
        AND ($3::text IS NULL OR predicate = $3)
        AND suppressed = false AND invalid_at IS NULL
      ORDER BY confidence DESC, created_at DESC LIMIT $4`,
    [projectId, (q.filter && q.filter.subject) || null, (q.filter && q.filter.predicate) || null, q.limit || 20]
  );
  return rows;
}

async function runRecencyQuery(client, projectId, q) {
  const { rows } = await client.query(
    `SELECT subject, predicate, object, created_at FROM assertions
      WHERE project_id = $1 AND suppressed = false AND invalid_at IS NULL
      ORDER BY created_at DESC LIMIT $2`,
    [projectId, q.limit || 20]
  );
  return rows;
}

async function runVectorQuery(client, projectId, q, embedder) {
  // Delegates to memorySearch BY REFERENCE — never a second embedding/
  // scoring implementation (§10.1/§10.3, M-19-style "one canonical path").
  const result = await memorySearch(client, {
    projectId,
    query: q.query || '',
    tables: q.tables,
    limit: q.limit || 10,
    embedder, // TEST-ONLY passthrough — see memory-search.js's own note
  });
  return result.hits;
}

/**
 * memoryViewRun — M-16: interprets ONLY the structured §4 query-type JSON.
 * Returns { results: { [queryIndex]: rows } } keyed by position in the
 * saved `queries` array, plus the view's own metadata.
 *
 * @param {object} [opts]
 * @param {(text:string) => Promise<number[]>} [opts.embedder] — TEST-ONLY
 *   passthrough to a 'vector'-type query's underlying memorySearch call.
 */
async function memoryViewRun(client, { projectId, name }, opts) {
  const view = await memoryViewGet(client, { projectId, name });
  if (!view) {
    throw new MemoryViewError('notFound', `memory_view_run: no view named "${name}" for this project (or it exists with kind != 'view').`);
  }
  const queries = view.queries;
  validateQueries(queries);

  const results = [];
  for (const q of queries) {
    const type = q.type || q.kind;
    let rows;
    if (type === 'entity') rows = await runEntityQuery(client, projectId, q);
    else if (type === 'assertion') rows = await runAssertionQuery(client, projectId, q);
    else if (type === 'recency') rows = await runRecencyQuery(client, projectId, q);
    else if (type === 'vector') rows = await runVectorQuery(client, projectId, q, opts && opts.embedder);
    results.push({ type, rows });
  }

  return { viewId: view.id, name: view.name, version: view.version, results };
}

module.exports = {
  SUPPORTED_QUERY_TYPES,
  MemoryViewError,
  validateQueries,
  memoryViewSet,
  memoryViewGet,
  memoryViewRun,
};
