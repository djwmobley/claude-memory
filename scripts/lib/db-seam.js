'use strict';

// db-seam.js — Storage port + concrete adapters for handoff.js.
//
// Architecture: storage ABSTRACTION
// ──────────────────────────────────
// The engine (handoff.js) depends ONLY on the StoragePort interface defined by
// the method signatures below.  All dialect specifics live inside the concrete
// adapters (PostgresAdapter, SQLiteAdapter).  The engine contains ZERO backend
// or dialect conditionals.
//
// Single injection point: connectHandoff() in handoff.js calls createAdapter()
// once, passing the resolved dialect.  Every engine call goes through the same
// method names regardless of which adapter is live.
//
// Port methods (both adapters implement all of these):
//
//   query(sql, params)             — Execute SQL, return { rows, rowCount }.
//                                    Postgres SQL is passed through unchanged.
//                                    SQLiteAdapter rewrites PG dialect internally.
//   end()                          — Close the connection.
//   runSchema(sql)                 — Apply a DDL script (multi-statement).
//   dialect                        — 'postgres' | 'sqlite' (getter, for diagnostics only).
//   schemaFileName                 — 'handoff-core-schema.sql' | 'handoff-sqlite-schema.sql'.
//
//   buildGraphCTE(dir, seeds, maxDepth, maxNodes, projectId)
//                                  — Returns { sql, params } for a recursive-CTE
//                                    graph traversal.  Postgres: ARRAY path + ANY/unnest.
//                                    SQLite: delimited-string path + INSTR cycle guard.
//   buildArrayContains(col, values, paramOffset)
//                                  — col = ANY($n::text[])   (Postgres, single array param)
//                                  — col IN (?,?,?)          (SQLite, expanded params)
//                                  Returns { clause, params }.
//   buildArrayExcludes(col, values, paramOffset)
//                                  — col <> ALL($n::text[])  (Postgres)
//                                  — col NOT IN (?,?,?)      (SQLite, or 1=1 if empty)
//                                  Returns { clause, params }.
//   buildBumpAssertions(ids)
//                                  — Returns { sql, params } for updating
//                                    last_reinforced + last_retrieved on the given ids.
//                                    Only touches live rows (suppressed=false, invalid_at IS NULL).
//   buildSupersessionUpdate(cardinality, projectId, subject, predicate, object)
//                                  — Returns { sql, params } that sets suppressed, invalid_at,
//                                    suppression_kind='superseded' on the prior live row(s).
//                                    Pinned rows (pinned=true/1) are exempt from auto-suppression.
//   buildProbationRehabUpdate(ids)
//                                  — Returns { sql, params } that revives downvoted_probation rows
//                                    (clears suppressed/invalid_at/suppression_kind).
//   buildPruneSelect(criteria, projectId)
//                                  — Returns { sql, params } for SELECT id, subject, predicate,
//                                    object, pinned FROM assertions WHERE <criteria>.
//                                    criteria: { suppressed?, suppressionKind?, subject?,
//                                      olderThanDays?, includePinned? }.
//                                    Project-scoped; at least one criterion enforced by caller.
//   buildPruneDelete(criteria, projectId)
//                                  — Returns { sql, params } for DELETE FROM assertions
//                                    WHERE <criteria>.  Same criteria shape as buildPruneSelect.
//                                    Never deletes pinned rows unless criteria.includePinned=true.
//   buildMultiPairInsert(table, col1, col2, col1Val, col2Values)
//                                  — Returns { sql, params } for an INSERT of
//                                    (col1Val, col2Values[0]), (col1Val, col2Values[1])...
//   runInitPreflight(cfg, targetDb, autoCreate, root, printLine)
//                                  — Runs dialect-specific pre-flight checks.
//                                    printLine(result, stepDesc) mirrors printPreflightLine().
//                                    Throws { fatal: true } on fatal failure.
//                                    Resolves on success (exits on fatal error when
//                                    called by cmdInit).
//   connectForInit(cfg, targetDb, root)
//                                  — Connect to the target database for the init command.
//                                    Handles dialect-specific connection setup.
//
// Dialect differences handled internally by SQLiteAdapter:
//   1. Param placeholders:  $N -> ?
//   2. JSONB vs TEXT:       serialize/deserialize queries + payload columns
//   3. Date arithmetic:     EXTRACT(EPOCH FROM (now()-col))/86400
//                           -> (julianday('now')-julianday(col)) [numerically identical]
//   4. ON CONFLICT:         identical syntax — no rewrite needed
//   5. ADD COLUMN IF NOT EXISTS: SQLite 3.51 does not support this syntax.
//      runSchema() strips "IF NOT EXISTS" and catches "duplicate column name" errors.
//   6. Graph CTE cycle prevention: Postgres ARRAY path -> SQLite path-string
//   7. Array params:        id = ANY($n::int[]) -> IN (?,?) via buildArrayContains()
//   8. RETURNING id:        INSERT then SELECT last_insert_rowid()
//   9. now():               -> datetime('now')
//  10. Interval subtraction: col < now()-($n||' days')::interval
//                            -> col < datetime('now', '-' || ? || ' days')
//
// The 86400 constants at handoff.js lines 273/2193/2280 are JS-level; NOT in SQL path.
// SQL decay: EXTRACT(EPOCH...)/86400 == (julianday('now')-julianday(col)) (both = fractional days).

const path = require('path');

// ─── resolveDialect ───────────────────────────────────────────────────────────

function resolveDialect(cfg) {
  const env = (process.env.STORAGE_BACKEND || '').toLowerCase().trim();
  if (env === 'sqlite')   return 'sqlite';
  if (env === 'postgres') return 'postgres';
  if (cfg && cfg.storage_backend) {
    const v = String(cfg.storage_backend).toLowerCase().trim();
    if (v === 'sqlite') return 'sqlite';
  }
  return 'postgres';
}

// ─── SQL rewrite helpers (SQLite-internal) ────────────────────────────────────

function rewriteForSQLite(sql) {
  let s = sql;
  // Decay ORDER BY: EXTRACT(EPOCH FROM (now() - col)) / 86400
  //                 -> (julianday('now') - julianday(col))
  s = s.replace(
    /EXTRACT\s*\(\s*EPOCH\s+FROM\s+\(\s*now\s*\(\s*\)\s*-\s*(\w+)\s*\)\s*\)\s*\/\s*86400/gi,
    (_, col) => `(julianday('now') - julianday(${col}))`
  );
  // now() -> datetime('now')
  s = s.replace(/\bnow\s*\(\s*\)/gi, "datetime('now')");
  // ($N || ' days')::interval -> strip ::interval cast
  s = s.replace(/\(\s*\$\d+\s*\|\|\s*' days'\s*\)\s*::interval/gi,
    (m) => m.replace(/::interval/i, ''));
  // $N -> ?
  s = s.replace(/\$\d+/g, '?');
  // Remove Postgres type casts
  s = s.replace(/::halfvec\(\d+\)/gi, '');
  s = s.replace(/::int\[\]/gi,   '');
  s = s.replace(/::text\[\]/gi,  '');
  s = s.replace(/::integer/gi,   '');
  s = s.replace(/::float/gi,     '');
  s = s.replace(/::jsonb/gi,     '');
  s = s.replace(/::text/gi,      '');
  s = s.replace(/::interval/gi,  '');
  // TIMESTAMPTZ -> TEXT in DDL
  s = s.replace(/TIMESTAMPTZ/gi, 'TEXT');
  return s;
}

function rewriteIntervalSubtraction(sql) {
  // col < datetime('now') - ? || ' days'
  // -> col < datetime('now', '-' || ? || ' days')
  return sql.replace(
    /(\w+)\s*<\s*datetime\('now'\)\s*-\s*\?\s*\|\|\s*' days'/gi,
    (_, col) => `${col} < datetime('now', '-' || ? || ' days')`
  );
}

// ─── param / row helpers ─────────────────────────────────────────────────────

function serializeParams(params) {
  if (!params || !params.length) return params;
  return params.map((p) => {
    if (p !== null && typeof p === 'object') return JSON.stringify(p);
    return p;
  });
}

function deserializeRow(row) {
  if (!row) return row;
  const out = Object.assign({}, row);
  for (const col of ['queries', 'payload']) {
    if (col in out && typeof out[col] === 'string') {
      try { out[col] = JSON.parse(out[col]); } catch (_) {}
    }
  }
  return out;
}

// ─── statement splitter ───────────────────────────────────────────────────────

function splitStatements(sql) {
  const stmts = [];
  let cur = '';
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const ch = sql[i];
    if (ch === "'") {
      cur += ch; i++;
      while (i < n) {
        const c2 = sql[i]; cur += c2; i++;
        if (c2 === "'") {
          if (i < n && sql[i] === "'") { cur += "'"; i++; }
          else break;
        }
      }
      continue;
    }
    if (ch === '-' && i+1 < n && sql[i+1] === '-') {
      while (i < n && sql[i] !== '\n') { cur += sql[i++]; }
      continue;
    }
    if (ch === '/' && i+1 < n && sql[i+1] === '*') {
      cur += sql[i++]; cur += sql[i++];
      while (i < n) {
        if (sql[i] === '*' && i+1 < n && sql[i+1] === '/') {
          cur += sql[i++]; cur += sql[i++]; break;
        }
        cur += sql[i++];
      }
      continue;
    }
    if (ch === ';') {
      const t = cur.trim();
      if (t) stmts.push(t);
      cur = ''; i++;
      continue;
    }
    cur += ch; i++;
  }
  const last = cur.trim();
  if (last) stmts.push(last);
  return stmts;
}

// ─── PostgreSQL graph CTE builders ───────────────────────────────────────────

function buildPostgresGraphCTE(direction, seeds, maxDepth, maxNodes, projectId) {
  // Postgres CTE uses unnest($2::text[]) for seeds, ARRAY path for cycle prevention,
  // and NOT (col = ANY(t.path)) as cycle guard.
  // params: [projectId, seeds_array, maxDepth, maxNodes]
  let cteReachSql;

  if (direction === 'in') {
    cteReachSql = `
      WITH RECURSIVE graph_traverse(entity_name, depth, weight, from_e, edge_type, to_e, path) AS (
        -- Base: seeds at depth 0
        SELECT
          unnest($2::text[]) AS entity_name,
          0                  AS depth,
          1.0::float         AS weight,
          ''::text           AS from_e,
          ''::text           AS edge_type,
          ''::text           AS to_e,
          ARRAY[unnest($2::text[])] AS path
        UNION ALL
        -- Recursive: follow edges INBOUND (to_entity → from_entity)
        SELECT
          e.from_entity      AS entity_name,
          t.depth + 1        AS depth,
          e.weight           AS weight,
          e.from_entity      AS from_e,
          e.edge_type        AS edge_type,
          e.to_entity        AS to_e,
          t.path || e.from_entity AS path
        FROM edges e
        JOIN graph_traverse t ON e.to_entity = t.entity_name
        WHERE e.project_id = $1
          AND t.depth + 1 <= $3
          AND NOT (e.from_entity = ANY(t.path))
      )
      SELECT
        entity_name,
        MIN(depth) AS min_depth,
        MAX(weight) AS max_weight,
        (array_agg(from_e ORDER BY depth ASC, weight DESC))[1] AS rep_from,
        (array_agg(edge_type ORDER BY depth ASC, weight DESC))[1] AS rep_edge_type,
        (array_agg(to_e ORDER BY depth ASC, weight DESC))[1] AS rep_to
      FROM graph_traverse
      WHERE depth > 0
        AND NOT (entity_name = ANY($2::text[]))
      GROUP BY entity_name
      ORDER BY min_depth ASC, max_weight DESC, entity_name ASC
      LIMIT $4
    `;
  } else if (direction === 'both') {
    // PostgreSQL recursive CTEs do not allow two recursive references to the
    // working table in a single WITH RECURSIVE. Use two separate CTEs (out + in)
    // and UNION their results before aggregating.
    cteReachSql = `
      WITH RECURSIVE
      gt_out(entity_name, depth, weight, from_e, edge_type, to_e, path) AS (
        -- Base: seeds at depth 0 (outbound traversal)
        SELECT
          unnest($2::text[]) AS entity_name,
          0                  AS depth,
          1.0::float         AS weight,
          ''::text           AS from_e,
          ''::text           AS edge_type,
          ''::text           AS to_e,
          ARRAY[unnest($2::text[])] AS path
        UNION ALL
        -- Recursive: follow edges OUTBOUND (from_entity → to_entity)
        SELECT
          e.to_entity        AS entity_name,
          t.depth + 1        AS depth,
          e.weight           AS weight,
          e.from_entity      AS from_e,
          e.edge_type        AS edge_type,
          e.to_entity        AS to_e,
          t.path || e.to_entity AS path
        FROM edges e
        JOIN gt_out t ON e.from_entity = t.entity_name
        WHERE e.project_id = $1
          AND t.depth + 1 <= $3
          AND NOT (e.to_entity = ANY(t.path))
      ),
      gt_in(entity_name, depth, weight, from_e, edge_type, to_e, path) AS (
        -- Base: seeds at depth 0 (inbound traversal)
        SELECT
          unnest($2::text[]) AS entity_name,
          0                  AS depth,
          1.0::float         AS weight,
          ''::text           AS from_e,
          ''::text           AS edge_type,
          ''::text           AS to_e,
          ARRAY[unnest($2::text[])] AS path
        UNION ALL
        -- Recursive: follow edges INBOUND (to_entity → from_entity)
        SELECT
          e.from_entity      AS entity_name,
          t.depth + 1        AS depth,
          e.weight           AS weight,
          e.from_entity      AS from_e,
          e.edge_type        AS edge_type,
          e.to_entity        AS to_e,
          t.path || e.from_entity AS path
        FROM edges e
        JOIN gt_in t ON e.to_entity = t.entity_name
        WHERE e.project_id = $1
          AND t.depth + 1 <= $3
          AND NOT (e.from_entity = ANY(t.path))
      ),
      combined AS (
        SELECT entity_name, depth, weight, from_e, edge_type, to_e
        FROM gt_out WHERE depth > 0 AND NOT (entity_name = ANY($2::text[]))
        UNION ALL
        SELECT entity_name, depth, weight, from_e, edge_type, to_e
        FROM gt_in  WHERE depth > 0 AND NOT (entity_name = ANY($2::text[]))
      )
      SELECT
        entity_name,
        MIN(depth) AS min_depth,
        MAX(weight) AS max_weight,
        (array_agg(from_e ORDER BY depth ASC, weight DESC))[1] AS rep_from,
        (array_agg(edge_type ORDER BY depth ASC, weight DESC))[1] AS rep_edge_type,
        (array_agg(to_e ORDER BY depth ASC, weight DESC))[1] AS rep_to
      FROM combined
      GROUP BY entity_name
      ORDER BY min_depth ASC, max_weight DESC, entity_name ASC
      LIMIT $4
    `;
  } else {
    // Default: 'out' — follow outgoing edges from_entity → to_entity
    cteReachSql = `
      WITH RECURSIVE graph_traverse(entity_name, depth, weight, from_e, edge_type, to_e, path) AS (
        -- Base: seeds at depth 0
        SELECT
          unnest($2::text[]) AS entity_name,
          0                  AS depth,
          1.0::float         AS weight,
          ''::text           AS from_e,
          ''::text           AS edge_type,
          ''::text           AS to_e,
          ARRAY[unnest($2::text[])] AS path
        UNION ALL
        -- Recursive: follow edges OUTBOUND (from_entity → to_entity)
        SELECT
          e.to_entity        AS entity_name,
          t.depth + 1        AS depth,
          e.weight           AS weight,
          e.from_entity      AS from_e,
          e.edge_type        AS edge_type,
          e.to_entity        AS to_e,
          t.path || e.to_entity AS path
        FROM edges e
        JOIN graph_traverse t ON e.from_entity = t.entity_name
        WHERE e.project_id = $1
          AND t.depth + 1 <= $3
          AND NOT (e.to_entity = ANY(t.path))
      )
      SELECT
        entity_name,
        MIN(depth) AS min_depth,
        MAX(weight) AS max_weight,
        (array_agg(from_e ORDER BY depth ASC, weight DESC))[1] AS rep_from,
        (array_agg(edge_type ORDER BY depth ASC, weight DESC))[1] AS rep_edge_type,
        (array_agg(to_e ORDER BY depth ASC, weight DESC))[1] AS rep_to
      FROM graph_traverse
      WHERE depth > 0
        AND NOT (entity_name = ANY($2::text[]))
      GROUP BY entity_name
      ORDER BY min_depth ASC, max_weight DESC, entity_name ASC
      LIMIT $4
    `;
  }

  return { sql: cteReachSql, params: [projectId, seeds, maxDepth, maxNodes] };
}

// ─── SQLite graph CTE builders ────────────────────────────────────────────────

/**
 * Build a SQLite-compatible recursive CTE for graph traversal.
 * Cycle prevention: '|'-delimited path string.
 *   Guard: INSTR('|' || t.path || '|', '|' || entity || '|') = 0
 * Seeds expand as one UNION ALL base row each. maxDepth clamped <=5 by caller.
 */
function buildSQLiteGraphCTE(direction, seeds, maxDepth, maxNodes, projectId) {
  if (direction === 'both') return _buildSQLiteBothCTE(seeds, maxDepth, maxNodes, projectId);

  const seedUnion = seeds.map(() =>
    "SELECT ? AS entity_name, 0 AS depth, 1.0 AS weight, '' AS from_e, '' AS edge_type, '' AS to_e, '|' || ? || '|' AS path"
  ).join('\n  UNION ALL\n  ');
  const seedParams = seeds.flatMap((s) => [s, s]);

  const entityCol = direction === 'in' ? 'from_entity' : 'to_entity';
  const joinCol   = direction === 'in' ? 'to_entity'   : 'from_entity';

  const notSeedClause = seeds.length > 0
    ? seeds.map(() => 'entity_name != ?').join(' AND ')
    : '1=1';
  const notSeedParams = seeds.slice();

  const sql = `
    WITH RECURSIVE graph_traverse(entity_name, depth, weight, from_e, edge_type, to_e, path) AS (
      ${seedUnion}
      UNION ALL
      SELECT
        e.${entityCol}   AS entity_name,
        t.depth + 1      AS depth,
        e.weight         AS weight,
        e.from_entity    AS from_e,
        e.edge_type      AS edge_type,
        e.to_entity      AS to_e,
        t.path || e.${entityCol} || '|' AS path
      FROM edges e
      JOIN graph_traverse t ON e.${joinCol} = t.entity_name
      WHERE e.project_id = ?
        AND t.depth + 1 <= ?
        AND INSTR('|' || t.path || '|', '|' || e.${entityCol} || '|') = 0
    )
    SELECT
      entity_name,
      MIN(depth)     AS min_depth,
      MAX(weight)    AS max_weight,
      MIN(from_e)    AS rep_from,
      MIN(edge_type) AS rep_edge_type,
      MIN(to_e)      AS rep_to
    FROM graph_traverse
    WHERE depth > 0
      AND (${notSeedClause})
    GROUP BY entity_name
    ORDER BY min_depth ASC, max_weight DESC, entity_name ASC
    LIMIT ?`;

  return {
    sql,
    params: [...seedParams, projectId, maxDepth, ...notSeedParams, maxNodes],
  };
}

function _buildSQLiteBothCTE(seeds, maxDepth, maxNodes, projectId) {
  const seedUnion = seeds.map(() =>
    "SELECT ? AS entity_name, 0 AS depth, 1.0 AS weight, '' AS from_e, '' AS edge_type, '' AS to_e, '|' || ? || '|' AS path"
  ).join('\n    UNION ALL\n    ');
  const seedParams = seeds.flatMap((s) => [s, s]);
  const notSeedClause = seeds.length > 0
    ? seeds.map(() => 'entity_name != ?').join(' AND ')
    : '1=1';
  const notSeedParams = seeds.slice();

  const sql = `
    WITH RECURSIVE
    gt_out(entity_name, depth, weight, from_e, edge_type, to_e, path) AS (
      ${seedUnion}
      UNION ALL
      SELECT e.to_entity, t.depth+1, e.weight, e.from_entity, e.edge_type, e.to_entity,
             t.path || e.to_entity || '|'
      FROM edges e JOIN gt_out t ON e.from_entity = t.entity_name
      WHERE e.project_id = ? AND t.depth+1 <= ?
        AND INSTR('|' || t.path || '|', '|' || e.to_entity || '|') = 0
    ),
    gt_in(entity_name, depth, weight, from_e, edge_type, to_e, path) AS (
      ${seedUnion}
      UNION ALL
      SELECT e.from_entity, t.depth+1, e.weight, e.from_entity, e.edge_type, e.to_entity,
             t.path || e.from_entity || '|'
      FROM edges e JOIN gt_in t ON e.to_entity = t.entity_name
      WHERE e.project_id = ? AND t.depth+1 <= ?
        AND INSTR('|' || t.path || '|', '|' || e.from_entity || '|') = 0
    ),
    combined AS (
      SELECT entity_name, depth, weight, from_e, edge_type, to_e
      FROM gt_out WHERE depth>0 AND (${notSeedClause})
      UNION ALL
      SELECT entity_name, depth, weight, from_e, edge_type, to_e
      FROM gt_in  WHERE depth>0 AND (${notSeedClause})
    )
    SELECT entity_name, MIN(depth) AS min_depth, MAX(weight) AS max_weight,
           MIN(from_e) AS rep_from, MIN(edge_type) AS rep_edge_type, MIN(to_e) AS rep_to
    FROM combined
    GROUP BY entity_name
    ORDER BY min_depth ASC, max_weight DESC, entity_name ASC
    LIMIT ?`;

  return {
    sql,
    params: [
      ...seedParams, projectId, maxDepth,  // gt_out base + recursive
      ...seedParams, projectId, maxDepth,  // gt_in  base + recursive
      ...notSeedParams,                    // combined out filter
      ...notSeedParams,                    // combined in filter
      maxNodes,
    ],
  };
}

// ─── resolveSQLiteDbPath ──────────────────────────────────────────────────────

function resolveSQLiteDbPath(projectRoot) {
  if (process.env.HANDOFF_SQLITE_PATH) return process.env.HANDOFF_SQLITE_PATH;
  return path.join(projectRoot, '.claude', 'handoff.sqlite');
}

// ─── _buildPruneClauses ───────────────────────────────────────────────────────
//
// Shared helper for buildPruneSelect / buildPruneDelete on both adapters.
// Builds the WHERE clauses and params array for a manual-prune query.
//
// criteria:
//   suppressed       — boolean | undefined.  If true, add: suppressed = <true/1>
//   suppressionKind  — string | undefined.   If set, add: suppression_kind = <kind>
//   subject          — string | undefined.   If set, add: subject = <canonical>
//   olderThanDays    — number | undefined.   If set, add: last_reinforced < now()-N days
//   includePinned    — boolean.  Does NOT affect the WHERE clauses here (handled
//                      by callers for DELETE; SELECT always fetches all matching rows
//                      so caller can count skipped-pinned separately).
//
// dialect: 'postgres' | 'sqlite'
//   Postgres: $N placeholders, ($N || ' days')::interval for interval arithmetic.
//   SQLite:   ?  placeholders, datetime('now', '-' || ? || ' days') for interval.
//             (SQLiteAdapter.query() also runs rewriteForSQLite(), but the
//              olderThanDays clause needs to be pre-built in dialect-native form
//              because the rewrite targets a specific textual pattern that may not
//              match if we emit raw Postgres syntax here.)
//
// Always includes: project_id = <projectId>  as the first clause.
//
// Returns: { clauses: string[], params: any[] }
//   clauses — one clause per criterion; caller joins with ' AND '
//   params  — positional params in order

function _buildPruneClauses(criteria, projectId, dialect) {
  const clauses = [];
  const params  = [];

  const pg = dialect === 'postgres';

  // Helper: placeholder for the most-recently pushed param.
  // Call AFTER params.push() so params.length is already the 1-based index.
  function nextPh() {
    if (pg) return `$${params.length}`;
    return '?';
  }

  // ── 1. project_id (always first) ──────────────────────────────────────────
  params.push(projectId);
  clauses.push(`project_id = ${pg ? '$1' : '?'}`);

  // ── 2. suppressed ─────────────────────────────────────────────────────────
  if (criteria.suppressed === true) {
    params.push(pg ? true : 1);
    clauses.push(`suppressed = ${nextPh()}`);
  }

  // ── 3. suppression_kind ───────────────────────────────────────────────────
  if (criteria.suppressionKind != null) {
    params.push(criteria.suppressionKind);
    clauses.push(`suppression_kind = ${nextPh()}`);
  }

  // ── 4. subject ────────────────────────────────────────────────────────────
  if (criteria.subject != null) {
    params.push(criteria.subject);
    clauses.push(`subject = ${nextPh()}`);
  }

  // ── 5. older-than (by last_reinforced) ────────────────────────────────────
  if (criteria.olderThanDays != null) {
    const days = Number(criteria.olderThanDays);
    if (pg) {
      params.push(String(days));
      clauses.push(`last_reinforced < now() - ($${params.length} || ' days')::interval`);
    } else {
      params.push(String(days));
      clauses.push(`last_reinforced < datetime('now', '-' || ? || ' days')`);
    }
  }

  return { clauses, params };
}

// ─── SQLiteAdapter ────────────────────────────────────────────────────────────

class SQLiteAdapter {
  constructor(dbPath) {
    this._dbPath  = dbPath;
    this._db      = null;
    this._txDepth = 0;
  }

  // ── Core port methods ──────────────────────────────────────────────────────

  async connect() {
    const { DatabaseSync } = require('node:sqlite');
    this._db = new DatabaseSync(this._dbPath);
    this._db.prepare('PRAGMA journal_mode=WAL').run();
    this._db.prepare('PRAGMA foreign_keys=ON').run();
  }

  async query(sql, params) {
    const db = this._db;
    if (!db) throw new Error('SQLiteAdapter: not connected');
    const trimmed = sql.trim();
    const upper   = trimmed.toUpperCase();

    if (upper === 'BEGIN') {
      if (this._txDepth === 0) db.prepare('BEGIN').run();
      this._txDepth++;
      return { rows: [], rowCount: 0 };
    }
    if (upper === 'COMMIT') {
      this._txDepth = Math.max(0, this._txDepth - 1);
      if (this._txDepth === 0) db.prepare('COMMIT').run();
      return { rows: [], rowCount: 0 };
    }
    if (upper === 'ROLLBACK') {
      this._txDepth = 0;
      try { db.prepare('ROLLBACK').run(); } catch (_) {}
      return { rows: [], rowCount: 0 };
    }

    let rewritten = rewriteForSQLite(trimmed);
    rewritten     = rewriteIntervalSubtraction(rewritten);
    const safeParams = serializeParams(params || []);

    // RETURNING id handling
    const retMatch = rewritten.match(/\bRETURNING\s+(\w+)\s*$/i);
    if (retMatch) {
      const colName   = retMatch[1];
      const insertSql = rewritten.slice(0, rewritten.lastIndexOf(retMatch[0])).trimEnd();
      db.prepare(insertSql).run(...safeParams);
      const lastId = db.prepare('SELECT last_insert_rowid() AS id').get();
      return { rows: [{ [colName]: lastId ? lastId.id : null }], rowCount: 1 };
    }

    // SELECT / WITH
    if (/^\s*(?:SELECT|WITH)\b/i.test(rewritten)) {
      const rawRows = db.prepare(rewritten).all(...safeParams);
      return { rows: rawRows.map(deserializeRow), rowCount: rawRows.length };
    }

    // DML / DDL
    const stmts = splitStatements(rewritten);
    let rowCount = 0;
    for (const stmt of stmts) {
      const s = stmt.trim();
      if (!s) continue;
      // PRAGMA table_info / index_list / etc. return rows; PRAGMA key=value do not.
      // Distinguish by checking for '=' in the pragma operand (setter form).
      if (/^PRAGMA\b/i.test(s) && !/^PRAGMA\s+\w+\s*=/i.test(s)) {
        const pragmaRows = db.prepare(s).all(...safeParams);
        if (pragmaRows.length > 0) {
          return { rows: pragmaRows.map(deserializeRow), rowCount: pragmaRows.length };
        }
      } else if (/^(?:CREATE|DROP|ALTER|VACUUM)\b/i.test(s) || /^PRAGMA\s+\w+\s*=/i.test(s)) {
        db.prepare(s).run();
      } else {
        const result = db.prepare(s).run(...safeParams);
        rowCount = result.changes || 0;
      }
    }
    return { rows: [], rowCount };
  }

  async runSchema(sql) {
    const db = this._db;
    if (!db) throw new Error('SQLiteAdapter: not connected');
    const stmts = splitStatements(rewriteForSQLite(sql));
    for (const stmt of stmts) {
      const s = stmt.trim();
      if (!s) continue;
      // Strip leading -- comment lines to expose the actual SQL keyword.
      // splitStatements() appends comment text to the preceding statement's buffer,
      // so a statement may start with one or more "--..." comment lines.
      const stripped = s.replace(/^(--[^\n]*\n\s*)*/g, '').trim();
      if (!stripped) continue;
      // SQLite does not support ALTER TABLE ... ADD COLUMN IF NOT EXISTS syntax.
      // Simulate idempotency: strip "IF NOT EXISTS" and catch "duplicate column name".
      if (/^ALTER\s+TABLE\s+\S+\s+ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\b/i.test(stripped)) {
        const rewritten = stripped.replace(/\bIF\s+NOT\s+EXISTS\b/i, '');
        try { db.prepare(rewritten).run(); } catch (e) {
          if (!/duplicate column name/i.test(e.message)) throw e;
          // Column already exists — idempotent, continue.
        }
        continue;
      }
      db.prepare(s).run();
    }
  }

  /**
   * Attempt to create a single integrity (partial unique) index.
   * Non-fatal: if the index creation fails because existing rows violate the
   * uniqueness constraint (legacy duplicate corpus), returns { ok: false, msg }.
   * On success (index created or already exists), returns { ok: true }.
   * Never throws — the caller decides how to surface the result.
   */
  async runIntegrityIndex(sql) {
    const db = this._db;
    if (!db) throw new Error('SQLiteAdapter: not connected');
    const rewritten = rewriteForSQLite(sql.trim());
    try {
      db.prepare(rewritten).run();
      return { ok: true, msg: 'index created' };
    } catch (e) {
      // SQLite reports unique-constraint violations on index creation as
      // "UNIQUE constraint failed" or "would not be unique".
      return { ok: false, msg: e.message };
    }
  }

  async end() {
    if (this._db) { try { this._db.close(); } catch (_) {} this._db = null; }
  }

  get dialect() { return 'sqlite'; }

  get schemaFileName() { return 'handoff-sqlite-schema.sql'; }

  // ── Port methods: query building ──────────────────────────────────────────

  /**
   * Build a recursive-CTE graph traversal for SQLite.
   * Cycle prevention uses a delimited string path ('|' || entity || '|').
   */
  buildGraphCTE(direction, seeds, maxDepth, maxNodes, projectId) {
    return buildSQLiteGraphCTE(direction, seeds, maxDepth, maxNodes, projectId);
  }

  /**
   * Build: col IN (?,?,...)  — SQLite has no native array params.
   * paramOffset is ignored (SQLite always uses positional ?).
   * Returns { clause, params }.
   */
  buildArrayContains(colExpr, values, _paramOffset) {
    if (!values || values.length === 0) return { clause: '1=0', params: [] };
    return {
      clause: `${colExpr} IN (${values.map(() => '?').join(', ')})`,
      params: values.slice(),
    };
  }

  /**
   * Build: col NOT IN (?,?,...)  — or 1=1 if values is empty.
   * Returns { clause, params }.
   */
  buildArrayExcludes(colExpr, values, _paramOffset) {
    if (!values || values.length === 0) return { clause: '1=1', params: [] };
    return {
      clause: `${colExpr} NOT IN (${values.map(() => '?').join(', ')})`,
      params: values.slice(),
    };
  }

  /**
   * Build an UPDATE to bump last_reinforced + last_retrieved for the given ids.
   * suppressedFalseValue: the literal false-equivalent for this dialect (0 for SQLite).
   * Only bumps live rows (suppressed = 0 AND invalid_at IS NULL) — OQ-2 guard.
   * Returns { sql, params }.
   */
  buildBumpAssertions(ids) {
    if (!ids || ids.length === 0) return null;
    const { clause: inClause, params: inParams } = this.buildArrayContains('id', ids);
    return {
      sql: `UPDATE assertions SET last_reinforced = datetime('now'), last_retrieved = datetime('now')
            WHERE ${inClause} AND suppressed = 0 AND invalid_at IS NULL`,
      params: inParams,
    };
  }

  /**
   * Build an UPDATE that marks a row as superseded by enriching the suppression columns.
   * Sets: suppressed = 1 (SQLite), invalid_at = now(), suppression_kind = 'superseded'.
   *
   * For 1:1 cardinality: suppresses all live rows for (project_id, subject, predicate)
   *   that are NOT pinned (pinned = 0 blocks auto-suppression).
   * For 1:N cardinality: suppresses only exact (project_id, subject, predicate, object) duplicates.
   *
   * Returns { sql, params } — designed for use inside a BEGIN/COMMIT transaction.
   */
  buildSupersessionUpdate(cardinality, projectId, subject, predicate, object) {
    if (cardinality === '1:1') {
      return {
        sql: `UPDATE assertions
              SET suppressed = 1, invalid_at = datetime('now'), suppression_kind = 'superseded'
              WHERE project_id = ?
                AND subject    = ?
                AND predicate  = ?
                AND suppressed = 0
                AND pinned     = 0`,
        params: [projectId, subject, predicate],
      };
    }
    // 1:N: only exact duplicate suppressed; pinned exemption applies here too.
    return {
      sql: `UPDATE assertions
            SET suppressed = 1, invalid_at = datetime('now'), suppression_kind = 'superseded'
            WHERE project_id = ?
              AND subject    = ?
              AND predicate  = ?
              AND object     = ?
              AND suppressed = 0
              AND pinned     = 0`,
      params: [projectId, subject, predicate, object],
    };
  }

  /**
   * Build an UPDATE that rehabilitates downvoted_probation rows back to live.
   * Clears: suppressed → 0, invalid_at → NULL, suppression_kind → NULL.
   * Only acts on rows with suppression_kind = 'downvoted_probation'.
   * Returns { sql, params } — safe to call with an empty ids array (returns null).
   */
  buildProbationRehabUpdate(ids) {
    if (!ids || ids.length === 0) return null;
    const { clause: inClause, params: inParams } = this.buildArrayContains('id', ids);
    return {
      sql: `UPDATE assertions
            SET suppressed = 0, invalid_at = NULL, suppression_kind = NULL
            WHERE ${inClause} AND suppression_kind = 'downvoted_probation'`,
      params: inParams,
    };
  }

  /**
   * Build a SELECT for the manual-prune preview (dry-run).
   * Returns rows matching the AND-combined criteria, scoped to projectId.
   * Pinned rows are included in the result set but flagged — caller uses pinned
   * column to compute skip counts.  The caller applies the includePinned filter
   * at the application layer after counting.
   * Returns { sql, params }.
   */
  buildPruneSelect(criteria, projectId) {
    const { clauses, params } = _buildPruneClauses(criteria, projectId, 'sqlite');
    return {
      sql: `SELECT id, subject, predicate, object, pinned FROM assertions WHERE ${clauses.join(' AND ')}`,
      params,
    };
  }

  /**
   * Build a hard DELETE for the manual-prune command.
   * Applies the AND-combined criteria scoped to projectId.
   * Excludes pinned rows UNLESS criteria.includePinned = true.
   * Returns { sql, params }.
   */
  buildPruneDelete(criteria, projectId) {
    const { clauses, params } = _buildPruneClauses(criteria, projectId, 'sqlite');
    if (!criteria.includePinned) {
      clauses.push('pinned = 0');
    }
    return {
      sql: `DELETE FROM assertions WHERE ${clauses.join(' AND ')}`,
      params,
    };
  }

  /**
   * Build a multi-row INSERT of (col1Val, col2Values[i]) pairs.
   * SQLite uses anonymous ? placeholders — cannot reuse a single $1 for col1Val;
   * each row has its own two ?s.
   * Returns { sql, params }.
   */
  buildMultiPairInsert(table, col1, col2, col1Val, col2Values) {
    const params = [];
    const valuePlaceholders = col2Values.map((v) => {
      params.push(col1Val, v);
      return '(?, ?)';
    });
    return {
      sql: `INSERT INTO ${table} (${col1}, ${col2}) VALUES ${valuePlaceholders.join(', ')}`,
      params,
    };
  }

  /**
   * Build: SELECT DISTINCT community_id FROM entity_communities
   *          WHERE project_id = ? AND run_id = ? AND entity_name IN (?,...)
   * Returns { sql, params }.
   */
  buildCommunityIdsQuery(projectId, runId, entityNames) {
    if (!entityNames || entityNames.length === 0) {
      return {
        sql: `SELECT DISTINCT community_id FROM entity_communities WHERE project_id = ? AND run_id = ? AND 1=0`,
        params: [projectId, runId],
      };
    }
    const placeholders = entityNames.map(() => '?').join(', ');
    return {
      sql: `SELECT DISTINCT community_id FROM entity_communities
            WHERE project_id = ? AND run_id = ? AND entity_name IN (${placeholders})`,
      params: [projectId, runId, ...entityNames],
    };
  }

  /**
   * Build: SELECT DISTINCT entity_name FROM entity_communities
   *          WHERE project_id = ? AND run_id = ?
   *            AND community_id IN (?,...)
   *            AND entity_name NOT IN (?,...)
   *          LIMIT ?
   * Returns { sql, params }.
   */
  buildSiblingsQuery(projectId, runId, communityIds, excludeNames, limit) {
    const cidPlaceholders = (communityIds && communityIds.length > 0)
      ? communityIds.map(() => '?').join(', ')
      : null;
    const cidClause = cidPlaceholders
      ? `community_id IN (${cidPlaceholders})`
      : '1=0';
    const cidParams = communityIds && communityIds.length > 0 ? communityIds.slice() : [];

    const nameExcludeClause = (excludeNames && excludeNames.length > 0)
      ? `entity_name NOT IN (${excludeNames.map(() => '?').join(', ')})`
      : '1=1';
    const nameExcludeParams = excludeNames && excludeNames.length > 0 ? excludeNames.slice() : [];

    return {
      sql: `SELECT DISTINCT entity_name FROM entity_communities
            WHERE project_id = ? AND run_id = ?
              AND ${cidClause}
              AND ${nameExcludeClause}
            LIMIT ?`,
      params: [projectId, runId, ...cidParams, ...nameExcludeParams, limit],
    };
  }

  // ── Port methods: init ────────────────────────────────────────────────────

  /**
   * Run dialect-specific pre-flight checks for `handoff init`.
   * Calls printLine(result, stepDesc) for each check (mirrors printPreflightLine).
   * Throws on fatal error (caller handles process.exit).
   */
  async runInitPreflight(_cfg, _targetDb, _autoCreate, root, printLine) {
    // SQLite pre-flight: just log the backend choice and db file path.
    const dbPath = resolveSQLiteDbPath(root);
    printLine({ ok: true, msg: 'SQLite (node:sqlite, embedded)', fatal: false },
      'Storage backend');
    printLine({ ok: true, msg: dbPath, fatal: false }, 'SQLite database');
  }

  /**
   * Connect to the target database for the init command.
   * For SQLite: create/open the db file at the resolved path.
   */
  async connectForInit(_cfg, _targetDb, root) {
    const dbPath = resolveSQLiteDbPath(root);
    const adapter = new SQLiteAdapter(dbPath);
    await adapter.connect();
    return adapter;
  }
}

// ─── PostgresAdapter ─────────────────────────────────────────────────────────

class PostgresAdapter {
  constructor(pgClient) { this._client = pgClient; }

  // ── Core port methods ──────────────────────────────────────────────────────

  async connect()             { return this._client.connect(); }
  async query(sql, params)    { return this._client.query(sql, params); }
  async end()                 { return this._client.end(); }
  async runSchema(sql)        { return this._client.query(sql); }

  /**
   * Attempt to create a single integrity (partial unique) index.
   * Non-fatal: if the index creation fails because existing rows violate the
   * uniqueness constraint (legacy duplicate corpus), returns { ok: false, msg }.
   * On success (index created or already exists), returns { ok: true }.
   * Never throws — the caller decides how to surface the result.
   */
  async runIntegrityIndex(sql) {
    try {
      await this._client.query(sql.trim());
      return { ok: true, msg: 'index created' };
    } catch (e) {
      return { ok: false, msg: e.message };
    }
  }

  get dialect() { return 'postgres'; }

  get schemaFileName() { return 'handoff-core-schema.sql'; }

  // ── Port methods: query building ──────────────────────────────────────────

  /**
   * Build a recursive-CTE graph traversal for Postgres.
   * Uses unnest($2::text[]) for seeds and ARRAY path for cycle prevention.
   */
  buildGraphCTE(direction, seeds, maxDepth, maxNodes, projectId) {
    return buildPostgresGraphCTE(direction, seeds, maxDepth, maxNodes, projectId);
  }

  /**
   * Build: col = ANY($n::text[])  — Postgres passes the array as one param.
   * paramOffset: the 1-based index to assign to the array param in the query
   *   (caller supplies the offset so it can interleave with other $N params).
   * Returns { clause, params }.
   */
  buildArrayContains(colExpr, values, paramOffset) {
    const n = paramOffset || 1;
    return {
      clause: `${colExpr} = ANY($${n}::text[])`,
      params: [values],
    };
  }

  /**
   * Build: col <> ALL($n::text[])  — or 1=1 if values is empty.
   * Returns { clause, params }.
   */
  buildArrayExcludes(colExpr, values, paramOffset) {
    if (!values || values.length === 0) return { clause: '1=1', params: [] };
    const n = paramOffset || 1;
    return {
      clause: `${colExpr} <> ALL($${n}::text[])`,
      params: [values],
    };
  }

  /**
   * Build an UPDATE to bump last_reinforced + last_retrieved for the given ids.
   * Postgres passes the ids as a single int[] array.
   * Only bumps live rows (suppressed = false AND invalid_at IS NULL) — OQ-2 guard.
   * Returns { sql, params }.
   */
  buildBumpAssertions(ids) {
    if (!ids || ids.length === 0) return null;
    return {
      sql: `UPDATE assertions SET last_reinforced = now(), last_retrieved = now()
            WHERE id = ANY($1::int[])
              AND suppressed = false
              AND invalid_at IS NULL`,
      params: [ids],
    };
  }

  /**
   * Build an UPDATE that marks a row as superseded by enriching the suppression columns.
   * Sets: suppressed = true, invalid_at = now(), suppression_kind = 'superseded'.
   *
   * For 1:1 cardinality: suppresses all live, non-pinned rows for (project_id, subject, predicate).
   * For 1:N cardinality: suppresses only exact (project_id, subject, predicate, object) duplicates.
   *   Pinned rows are exempt from auto-suppression in both cardinality classes.
   *
   * Returns { sql, params } — designed for use inside a BEGIN/COMMIT transaction.
   */
  buildSupersessionUpdate(cardinality, projectId, subject, predicate, object) {
    if (cardinality === '1:1') {
      return {
        sql: `UPDATE assertions
              SET suppressed = true, invalid_at = now(), suppression_kind = 'superseded'
              WHERE project_id = $1
                AND subject    = $2
                AND predicate  = $3
                AND suppressed = false
                AND (pinned = false OR pinned IS NULL)`,
        params: [projectId, subject, predicate],
      };
    }
    // 1:N: only exact duplicate suppressed; pinned exemption applies here too.
    return {
      sql: `UPDATE assertions
            SET suppressed = true, invalid_at = now(), suppression_kind = 'superseded'
            WHERE project_id = $1
              AND subject    = $2
              AND predicate  = $3
              AND object     = $4
              AND suppressed = false
              AND (pinned = false OR pinned IS NULL)`,
      params: [projectId, subject, predicate, object],
    };
  }

  /**
   * Build an UPDATE that rehabilitates downvoted_probation rows back to live.
   * Clears: suppressed → false, invalid_at → NULL, suppression_kind → NULL.
   * Only acts on rows with suppression_kind = 'downvoted_probation'.
   * Returns { sql, params } — safe to call with empty ids (returns null).
   */
  buildProbationRehabUpdate(ids) {
    if (!ids || ids.length === 0) return null;
    return {
      sql: `UPDATE assertions
            SET suppressed = false, invalid_at = NULL, suppression_kind = NULL
            WHERE id = ANY($1::int[])
              AND suppression_kind = 'downvoted_probation'`,
      params: [ids],
    };
  }

  /**
   * Build a SELECT for the manual-prune preview (dry-run).
   * Returns rows matching the AND-combined criteria, scoped to projectId.
   * Pinned rows are included in the result set — caller uses the pinned column
   * to compute skip counts.  The caller applies the includePinned filter
   * at the application layer after counting.
   * Returns { sql, params }.
   */
  buildPruneSelect(criteria, projectId) {
    const { clauses, params } = _buildPruneClauses(criteria, projectId, 'postgres');
    return {
      sql: `SELECT id, subject, predicate, object, pinned FROM assertions WHERE ${clauses.join(' AND ')}`,
      params,
    };
  }

  /**
   * Build a hard DELETE for the manual-prune command.
   * Applies the AND-combined criteria scoped to projectId.
   * Excludes pinned rows UNLESS criteria.includePinned = true.
   * Returns { sql, params }.
   */
  buildPruneDelete(criteria, projectId) {
    const { clauses, params } = _buildPruneClauses(criteria, projectId, 'postgres');
    if (!criteria.includePinned) {
      clauses.push('(pinned = false OR pinned IS NULL)');
    }
    return {
      sql: `DELETE FROM assertions WHERE ${clauses.join(' AND ')}`,
      params,
    };
  }

  /**
   * Build a multi-row INSERT of (col1Val, col2Values[i]) pairs.
   * Postgres reuses $1 for col1Val and assigns sequential $i for each col2 value.
   * Returns { sql, params }.
   */
  buildMultiPairInsert(table, col1, col2, col1Val, col2Values) {
    const params = [col1Val];
    const valuePlaceholders = col2Values.map((v, i) => {
      params.push(v);
      return `($1, $${i + 2})`;
    });
    return {
      sql: `INSERT INTO ${table} (${col1}, ${col2}) VALUES ${valuePlaceholders.join(', ')}`,
      params,
    };
  }

  /**
   * Build: SELECT DISTINCT community_id FROM entity_communities
   *          WHERE project_id = $1 AND run_id = $2 AND entity_name = ANY($3)
   * Postgres infers array type from param; no explicit cast needed.
   * Returns { sql, params }.
   */
  buildCommunityIdsQuery(projectId, runId, entityNames) {
    if (!entityNames || entityNames.length === 0) {
      return {
        sql: `SELECT DISTINCT community_id FROM entity_communities WHERE project_id = $1 AND run_id = $2 AND 1=0`,
        params: [projectId, runId],
      };
    }
    return {
      sql: `SELECT DISTINCT community_id FROM entity_communities
            WHERE project_id = $1 AND run_id = $2 AND entity_name = ANY($3)`,
      params: [projectId, runId, entityNames],
    };
  }

  /**
   * Build: SELECT DISTINCT entity_name FROM entity_communities
   *          WHERE project_id = $1 AND run_id = $2
   *            AND community_id = ANY($3)
   *            AND entity_name <> ALL($4::text[])
   *          LIMIT $5
   * community_id is INTEGER in the schema; no cast needed — Postgres infers.
   * Returns { sql, params }.
   */
  buildSiblingsQuery(projectId, runId, communityIds, excludeNames, limit) {
    const cidClause = (communityIds && communityIds.length > 0)
      ? 'community_id = ANY($3)'
      : '1=0';
    const cidParam  = (communityIds && communityIds.length > 0) ? communityIds : [];

    const excludeClause = (excludeNames && excludeNames.length > 0)
      ? 'entity_name <> ALL($4::text[])'
      : '1=1';
    const excludeParam  = (excludeNames && excludeNames.length > 0) ? excludeNames : [];

    // Build params array; empty arrays for unused slots so $N indexes are stable.
    const params = [projectId, runId, cidParam, excludeParam, limit];
    return {
      sql: `SELECT DISTINCT entity_name FROM entity_communities
            WHERE project_id = $1 AND run_id = $2
              AND ${cidClause}
              AND ${excludeClause}
            LIMIT $5`,
      params,
    };
  }

  // ── Port methods: init ────────────────────────────────────────────────────

  /**
   * Run dialect-specific pre-flight checks for `handoff init`.
   * Calls printLine(result, stepDesc) for each check.
   * Throws on fatal error (caller handles process.exit).
   */
  async runInitPreflight(cfg, targetDb, autoCreate, _root, printLine) {
    // Step 2: pg package installed
    let result = _checkPgPackage();
    printLine(result, 'pg package installed');
    if (result.fatal) throw Object.assign(new Error(result.msg), { fatal: true });

    // Step 3: Postgres reachable
    result = await _checkPostgresReachable(cfg);
    printLine(result, `Postgres reachable at ${cfg.host}:${cfg.port}`);
    if (result.fatal) throw Object.assign(new Error(result.msg), { fatal: true });

    // Step 4: Target DB exists (create if needed)
    result = await _checkOrCreateDatabase(cfg, targetDb, autoCreate);
    printLine(result, `Database '${targetDb}' present`);
    if (result.fatal) throw Object.assign(new Error(result.msg), { fatal: true });

    // Step 5: Postgres version >= 13 (warn only, non-fatal)
    result = await _checkPgVersion(cfg, targetDb);
    printLine(result, 'Postgres version >= 13');
  }

  /**
   * Connect to the target Postgres database for the init command.
   */
  async connectForInit(cfg, targetDb, _root) {
    const { Client } = require('pg');
    const pgClient = new Client({
      host:     cfg.host,
      port:     cfg.port,
      database: targetDb,
      user:     cfg.user,
    });
    const adapter = new PostgresAdapter(pgClient);
    await adapter.connect();
    return adapter;
  }
}

// ─── Postgres helper functions (private to this module) ───────────────────────

function _checkPgPackage() {
  try {
    require('pg');
    return { ok: true, msg: 'pg package present', fatal: false };
  } catch (_) {
    return {
      ok: false,
      msg: 'pg package not installed — run: npm install (in scripts/)',
      fatal: true,
    };
  }
}

async function _checkPostgresReachable(cfg) {
  const { Client } = require('pg');
  const client = new Client({
    host:     cfg.host,
    port:     cfg.port,
    database: 'postgres',  // system DB — always exists
    user:     cfg.user,
  });
  try {
    await client.connect();
    await client.end();
    return { ok: true, msg: `Postgres reachable at ${cfg.host}:${cfg.port}`, fatal: false };
  } catch (err) {
    return {
      ok: false,
      msg: `Postgres not reachable at ${cfg.host}:${cfg.port} — is it running? (${err.message})`,
      fatal: true,
    };
  }
}

async function _checkOrCreateDatabase(cfg, dbName, autoCreate) {
  const { Client } = require('pg');
  const readline = require('readline');
  const sysClient = new Client({
    host:     cfg.host,
    port:     cfg.port,
    database: 'postgres',
    user:     cfg.user,
  });
  await sysClient.connect();
  const { rows } = await sysClient.query(
    'SELECT 1 FROM pg_database WHERE datname = $1',
    [dbName]
  );

  if (rows.length > 0) {
    await sysClient.end();
    return { ok: true, msg: `Database '${dbName}' exists`, fatal: false, created: false };
  }

  if (autoCreate) {
    await sysClient.query(`CREATE DATABASE "${dbName}"`);
    await sysClient.end();
    return { ok: true, msg: `Database '${dbName}' created (auto)`, fatal: false, created: true };
  }

  // Prompt interactively
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise((resolve) => {
    rl.question(
      `\n  Database '${dbName}' does not exist. Create it? [y/N]: `,
      (a) => { rl.close(); resolve(a.trim()); }
    );
  });

  if (answer.toLowerCase() === 'y' || answer.toLowerCase() === 'yes') {
    await sysClient.query(`CREATE DATABASE "${dbName}"`);
    await sysClient.end();
    return { ok: true, msg: `Database '${dbName}' created`, fatal: false, created: true };
  }

  await sysClient.end();
  return {
    ok: false,
    msg: `Database '${dbName}' does not exist. Create it manually: psql -c "CREATE DATABASE ${dbName}"`,
    fatal: true,
    created: false,
  };
}

async function _checkPgVersion(cfg, dbName) {
  const { Client } = require('pg');
  const client = new Client({
    host:     cfg.host,
    port:     cfg.port,
    database: dbName,
    user:     cfg.user,
  });
  try {
    await client.connect();
    const { rows } = await client.query('SHOW server_version_num');
    await client.end();
    const vnum = parseInt(rows[0].server_version_num, 10);
    // server_version_num is e.g. 140008 for 14.8
    const major = Math.floor(vnum / 10000);
    if (major < 13) {
      return {
        ok: false,
        msg: `Postgres ${major} detected — recommend >= 13 (version_num=${vnum})`,
        fatal: false,  // warn only
      };
    }
    return { ok: true, msg: `Postgres ${major} (version_num=${vnum})`, fatal: false };
  } catch (err) {
    return { ok: false, msg: `Could not check Postgres version: ${err.message}`, fatal: false };
  }
}

// ─── factory ─────────────────────────────────────────────────────────────────

/**
 * Create and connect a storage adapter.
 * This is the SINGLE composition root — called once by connectHandoff() in handoff.js.
 * The engine never calls this again and never inspects the returned adapter's dialect.
 */
async function createAdapter(dialect, opts) {
  if (dialect === 'sqlite') {
    const a = new SQLiteAdapter(opts.dbPath);
    await a.connect();
    return a;
  }
  const { Client } = require('pg');
  const pgc = new Client({
    host: opts.host, port: opts.port,
    database: opts.database, user: opts.user,
  });
  const a = new PostgresAdapter(pgc);
  await a.connect();
  return a;
}

/**
 * Create a PostgresAdapter from an already-configured opts object.
 * Returns an unconnected adapter (caller must await adapter.connect() or
 * use createAdapter() which connects automatically).
 */
function createPostgresAdapter(opts) {
  const { Client } = require('pg');
  const pgc = new Client({
    host: opts.host, port: opts.port,
    database: opts.database, user: opts.user,
  });
  return new PostgresAdapter(pgc);
}

/**
 * Create a "probe" adapter for the init command.
 * Resolves dialect from cfg, creates a lightweight adapter instance suitable
 * for runInitPreflight() and connectForInit() without needing an existing connection.
 * The engine calls this instead of branching on dialect directly.
 */
function createInitProbe(cfg) {
  const dialect = resolveDialect(cfg);
  if (dialect === 'sqlite') {
    // SQLiteAdapter(:memory:) — no file needed; used only for pre-flight + connectForInit
    return new SQLiteAdapter(':memory:');
  }
  // PostgresAdapter(null) — null pg.Client; pre-flight and connectForInit don't use query()
  return new PostgresAdapter(null);
}

// ─── exports ─────────────────────────────────────────────────────────────────

module.exports = {
  resolveDialect,
  createAdapter,
  createPostgresAdapter,
  createInitProbe,
  rewriteForSQLite,           // exported for tests
  buildSQLiteGraphCTE,        // exported for tests
  resolveSQLiteDbPath,
  SQLiteAdapter,
  PostgresAdapter,
  // exported for tests:
  splitStatements,
  deserializeRow,
  serializeParams,
  // Legacy alias — kept so existing callers using buildInClause() still work
  // during migration. Points to the adapter-neutral helper.
  buildInClause: function buildInClause(columnExpr, values) {
    if (!values || values.length === 0) return { clause: '1=0', params: [] };
    return {
      clause: `${columnExpr} IN (${values.map(() => '?').join(', ')})`,
      params: values.slice(),
    };
  },
};
