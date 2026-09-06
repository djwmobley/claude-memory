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
//   buildFuzzyMatch(projectId, seedText, limit)
//                                  — Returns { sql, params } for a fuzzy-text subject/entity search.
//                                    Postgres: uses pg_trgm similarity() on subject+predicate+object.
//                                    SQLite:   uses LIKE / instr fallback.
//                                    Returns id, subject, predicate, object rows ranked by relevance.
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
//   buildEpochSecondsDiffPredicate(col1, col2, operator, thresholdSeconds)
//                                  — Returns a SQL predicate string (no params) for
//                                    comparing (col1 - col2) in seconds vs a threshold.
//                                    Postgres: EXTRACT(EPOCH FROM (col1-col2)) op threshold
//                                    SQLite: (julianday(col1)-julianday(col2))*86400 op threshold
//   buildWithinDaysPredicate(col, operator, paramOffset)
//                                  — Returns a SQL predicate string for
//                                    col <operator> now() - N days (N bound via param).
//                                    Postgres: col op now() - ($N||' days')::interval
//                                    SQLite: col op datetime('now','-'||?||' days')
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
//   cm#185 schema bring-forward port methods (both adapters implement all four):
//   runIntegrityIndexPair(dropSql, createSql)
//                                  — Atomic DROP INDEX IF EXISTS + CREATE [UNIQUE] INDEX
//                                    pair (own transaction). CREATE failure rolls back
//                                    the DROP too. Never throws; returns { ok, msg }.
//   schemaObjectsExist({tables?, columns?, indexes?})
//                                  — Post-apply structural verification probe (PG:
//                                    information_schema/pg_indexes; SQLite: sqlite_master/
//                                    PRAGMA table_info). Returns { ok, missing }.
//   setApplyTimeouts()             — SET LOCAL lock_timeout/statement_timeout for the
//                                    current apply transaction (PG only; SQLite no-op).
//   acquireSchemaApplyLock(lockKey) / releaseSchemaApplyLock(lockKey)
//                                  — Session-scoped advisory lock guarding the whole
//                                    detect+apply+verify+upsert sequence (PG: pg_advisory_
//                                    lock/unlock, namespace 43; SQLite: no-op, seam-test-only).
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
//  11. md5(col) in index DDL: -> col (SQLite has no md5() builtin and no
//                            equivalent btree row-size cap; see
//                            assertions_1ton_exact_unique, cm#227)
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
  // md5(col) -> col — cm#227: assertions_1ton_exact_unique is keyed on
  // md5(object) on Postgres solely to bound the indexed key's physical size
  // under Postgres's per-btree-version row-size cap (observed: "index row
  // size 2936 exceeds btree version 4 maximum 2704" once a 4000-char TL;DR
  // was persisted verbatim as an assertion object). SQLite has no md5()
  // builtin and no equivalent index-key-size ceiling for this shape, so the
  // wrapper is unwrapped back to the raw column here — the index still
  // enforces uniqueness, just directly on object's bytes instead of its
  // digest. Scoped to a bare single-identifier argument (the only shape
  // this schema ever uses); no other md5(...) call appears in any SQL this
  // adapter executes.
  s = s.replace(/\bmd5\(\s*(\w+)\s*\)/gi, '$1');
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
    // Set a sane busy_timeout so concurrent processes wait rather than immediately
    // failing when another writer holds the write-lock (BEGIN IMMEDIATE).
    this._db.prepare('PRAGMA busy_timeout=5000').run();
    this._db.prepare('PRAGMA journal_mode=WAL').run();
    this._db.prepare('PRAGMA foreign_keys=ON').run();
  }

  /**
   * Acquire a per-migration-key advisory lock and begin a transaction atomically.
   *
   * SQLite: issues BEGIN IMMEDIATE (exclusive write-lock).  This both starts the
   * transaction AND acquires the write-lock, serializing all concurrent writers.
   * The lock_key argument is ignored — the lock is implicitly scoped to the db file.
   *
   * After acquiring, callers MUST:
   *   1. Re-check DB state (re-check pattern after lock acquisition).
   *   2. Call db.query('COMMIT') or db.query('ROLLBACK') to release the lock.
   *
   * IMPORTANT: do NOT call db.query('BEGIN') before this method — this method
   * IS the transaction start.  Calling BEGIN first would result in a plain BEGIN
   * (no exclusive lock) followed by a second nested-BEGIN no-op here.
   *
   * @param {string} _lockKey  — ignored for SQLite; the write-lock is global per db file.
   * @returns {Promise<void>}
   */
  async acquireMigrationLock(_lockKey) {
    const db = this._db;
    if (!db) throw new Error('SQLiteAdapter: not connected');
    // BEGIN IMMEDIATE upgrades the connection to an exclusive write-lock.
    // If a transaction is already open (nested call) we escalate to the write-lock
    // by committing the current deferred transaction and starting an IMMEDIATE one.
    // In practice, runOneShot calls acquireMigrationLock as the FIRST DB operation,
    // so _txDepth should be 0 here.
    if (this._txDepth === 0) {
      db.prepare('BEGIN IMMEDIATE').run();
      this._txDepth++;
    } else {
      // Already in a transaction — we are inside a nested call or a pre-opened txn.
      // The existing BEGIN (not IMMEDIATE) may not hold an exclusive lock; but since
      // SQLite's WAL mode with IMMEDIATE is the serialization mechanism, and we cannot
      // upgrade in place, we log a warning and rely on the existing transaction.
      // This path should not occur in normal runOneShot usage.
      process.stderr.write('[handoff] acquireMigrationLock(SQLite): already in transaction — relying on existing lock\n');
    }
  }

  /**
   * SQLite counterpart to PostgresAdapter.acquireNamedXactLock — no
   * cross-connection advisory-lock primitive exists, and this codebase's
   * SQLite seam is a single-process/test-only backend, so this is a
   * documented no-op (lockKey ignored). Callers already hold whatever
   * serialization a plain BEGIN provides on this connection; see
   * acquireMigrationLock's own header comment for why BEGIN IMMEDIATE would
   * be the real fix if SQLite ever needed genuine cross-connection locking.
   *
   * @param {string} _lockKey — ignored.
   * @returns {Promise<void>}
   */
  async acquireNamedXactLock(_lockKey) {
    // No-op by design.
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

  /**
   * cm#185: run a DROP INDEX IF EXISTS + CREATE [UNIQUE] INDEX pair as a single
   * atomic unit (its own transaction). If CREATE fails (legacy-duplicate corpus),
   * the DROP is rolled back too -- the index is never left in a "dropped but not
   * recreated" state (closes S-11: a failed re-create must not silently destroy
   * a previously-working integrity index).
   * Never throws -- returns { ok, msg }.
   */
  async runIntegrityIndexPair(dropSql, createSql) {
    const db = this._db;
    if (!db) throw new Error('SQLiteAdapter: not connected');
    try {
      db.prepare('BEGIN').run();
      if (dropSql) db.prepare(rewriteForSQLite(dropSql.trim())).run();
      db.prepare(rewriteForSQLite(createSql.trim())).run();
      db.prepare('COMMIT').run();
      return { ok: true, msg: 'index recreated' };
    } catch (e) {
      try { db.prepare('ROLLBACK').run(); } catch (_) {}
      return { ok: false, msg: e.message };
    }
  }

  /**
   * cm#185: probe whether the given tables/columns/indexes exist. Used as the
   * post-apply structural verification gate before the schema_fingerprint is
   * upserted (closes S-13: "did not throw" is not proof of "is present").
   * expected: { tables?: string[], columns?: {table,column}[], indexes?: string[] }
   * Returns { ok: boolean, missing: [{type, ...}] }. Never throws.
   */
  async schemaObjectsExist(expected) {
    const db = this._db;
    if (!db) throw new Error('SQLiteAdapter: not connected');
    const missing = [];
    const safeIdent = /^[A-Za-z_][A-Za-z0-9_]*$/;
    for (const t of (expected.tables || [])) {
      let row = null;
      try { row = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name = ?`).get(t); } catch (_) {}
      if (!row) missing.push({ type: 'table', table: t });
    }
    const byTable = {};
    for (const c of (expected.columns || [])) {
      (byTable[c.table] = byTable[c.table] || []).push(c.column);
    }
    for (const [table, cols] of Object.entries(byTable)) {
      let info = [];
      if (safeIdent.test(table)) {
        try { info = db.prepare(`PRAGMA table_info(${table})`).all(); } catch (_) {}
      }
      const found = new Set(info.map((r) => r.name));
      for (const col of cols) {
        if (!found.has(col)) missing.push({ type: 'column', table, column: col });
      }
    }
    for (const idx of (expected.indexes || [])) {
      let row = null;
      try { row = db.prepare(`SELECT name FROM sqlite_master WHERE type='index' AND name = ?`).get(idx); } catch (_) {}
      if (!row) missing.push({ type: 'index', index: idx });
    }
    return { ok: missing.length === 0, missing };
  }

  /**
   * cm#185: set the per-apply lock/statement timeout budget (R-7). No-op for
   * SQLite -- busy_timeout is already set at connect() time and there is no
   * per-transaction lock_timeout/statement_timeout concept to mirror.
   */
  async setApplyTimeouts() { /* no-op: SQLite has no SET LOCAL lock_timeout concept */ }

  /**
   * cm#185: acquire/release the schema-apply advisory lock (R-8). No-op for
   * SQLite -- this adapter is seam-test-only (single embedded db file, single
   * test process); true write-serialization for SQLite comes from
   * acquireMigrationLock's BEGIN IMMEDIATE elsewhere, not from a session-level
   * advisory lock (SQLite has no such primitive). Documented as a blind spot:
   * no cross-process schema-apply mutual exclusion exists on the SQLite path.
   */
  async acquireSchemaApplyLock(_lockKey) { /* no-op: see method doc */ }
  async releaseSchemaApplyLock(_lockKey) { /* no-op: see method doc */ }

  /**
   * Execute a SELECT query that may fail (e.g., table might not exist) without
   * aborting the surrounding transaction.
   *
   * SQLite: SQLite errors within a transaction do NOT abort the whole transaction
   * (unlike Postgres), so a plain try/catch is sufficient.
   *
   * Returns { rows, rowCount } on success, or { rows: [], rowCount: 0 } on error
   * (error is swallowed; the caller treats absence/error as "0 rows").
   *
   * @param {string} sql
   * @param {any[]}  params
   * @returns {Promise<{ rows: any[], rowCount: number }>}
   */
  async querySafe(sql, params) {
    try {
      return await this.query(sql, params);
    } catch (_) {
      return { rows: [], rowCount: 0 };
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
   * Build an UPDATE that retires one or more live directive rows (L5).
   * Sets: suppressed = 1, invalid_at = datetime('now'), suppression_kind = 'retired'.
   * Only acts on live rows (suppressed = 0 AND invalid_at IS NULL).
   *
   * withObject=true  (--object supplied): retire only exact (project_id, subject, predicate, object).
   * withObject=false (--object omitted):  retire ALL live rows for (project_id, subject, predicate).
   *   Caller is responsible for checking isDirective(predicate) before invoking this form.
   *
   * Returns { sql, params }.
   */
  buildRetirementUpdate(projectId, subject, predicate, object, withObject) {
    if (withObject) {
      return {
        sql: `UPDATE assertions
              SET suppressed = 1, invalid_at = datetime('now'), suppression_kind = 'retired'
              WHERE project_id = ?
                AND subject    = ?
                AND predicate  = ?
                AND object     = ?
                AND suppressed = 0
                AND invalid_at IS NULL`,
        params: [projectId, subject, predicate, object],
      };
    }
    return {
      sql: `UPDATE assertions
            SET suppressed = 1, invalid_at = datetime('now'), suppression_kind = 'retired'
            WHERE project_id = ?
              AND subject    = ?
              AND predicate  = ?
              AND suppressed = 0
              AND invalid_at IS NULL`,
      params: [projectId, subject, predicate],
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
   * Build a fuzzy-text match query over assertions using per-token OR LIKE / instr().
   * SQLite fallback: uses instr() since pg_trgm is not available.
   * Matches against the concatenated subject || ' ' || predicate || ' ' || object.
   * Returns id, subject, predicate, object rows; limit is applied.
   * Returns { sql, params }.
   *
   * INTENTIONAL CROSS-BACKEND SEMANTIC DIFFERENCE:
   *   Postgres (PostgresAdapter.buildFuzzyMatch): uses pg_trgm phrase similarity
   *     (% operator / similarity()) — a single whole-phrase match against the seed.
   *   SQLite (this adapter): joins per-token LIKE clauses with OR — a row matches if
   *     ANY token from the seed appears in the concatenated text.
   * Multi-word seeds may therefore yield different candidate sets across backends.
   * This is accepted: the resurrect branch runs on the Postgres loader path;
   * the SQLite arm is best-effort (seam validation only, not production traffic).
   * Eligibility filtering (suppressed=true, suppression_kind='downvoted_probation')
   * is the caller's responsibility (Steps 3/4 in the resurrect branch).
   */
  buildFuzzyMatch(projectId, seedText, limit) {
    // Normalise seed to lower-case for case-insensitive matching.
    const tokens = String(seedText || '').toLowerCase().split(/\s+/).filter(Boolean);
    // Build one LIKE clause per token joined with OR — zero tokens -> match nothing.
    if (tokens.length === 0) {
      return {
        sql: `SELECT id, subject, predicate, object FROM assertions WHERE 1=0`,
        params: [],
      };
    }
    // SQLite: positional ? placeholders; projectId is param 1.
    const whereClauses = tokens.map(
      () => `(instr(lower(subject || ' ' || predicate || ' ' || object), ?) > 0)`
    );
    const params = [projectId, ...tokens, limit];
    return {
      sql: `SELECT id, subject, predicate, object
            FROM assertions
            WHERE project_id = ?
              AND (${whereClauses.join(' OR ')})
            ORDER BY subject ASC
            LIMIT ?`,
      params,
    };
  }

  /**
   * Build a SQL predicate for comparing the epoch-seconds difference between two
   * timestamp columns against a fixed threshold.
   *
   * SQLite: `(julianday(col1) - julianday(col2)) * 86400 <operator> <thresholdSeconds>`
   * (julianday returns fractional days; multiplied by 86400 gives seconds)
   *
   * Returns a plain SQL string (no params) — both columns and the threshold are
   * embedded directly.  Caller must integrate this into a WHERE clause.
   *
   * @param {string} col1              — minuend column (e.g. 'last_reinforced')
   * @param {string} col2              — subtrahend column (e.g. 'created_at')
   * @param {string} operator          — comparison operator (e.g. '>', '>=', '<', '<=')
   * @param {number} thresholdSeconds  — threshold in integer seconds (e.g. 86400)
   * @returns {string}
   */
  buildEpochSecondsDiffPredicate(col1, col2, operator, thresholdSeconds) {
    return `(julianday(${col1}) - julianday(${col2})) * 86400 ${operator} ${thresholdSeconds}`;
  }

  /**
   * Build a SQL predicate for `col <operator> now() - N days` using a bound parameter.
   *
   * SQLite: `col <operator> datetime('now', '-' || ? || ' days')`
   * The corresponding query param (the number of days as a string) must be bound
   * at the position matching the `?` placeholder.
   *
   * @param {string} col                  — column name (e.g. 'retrieved_at')
   * @param {string} operator             — comparison operator (e.g. '>=', '<')
   * @param {number} _paramOffset         — ignored for SQLite (uses positional ?)
   * @returns {string}
   */
  buildWithinDaysPredicate(col, operator, _paramOffset) {
    return `${col} ${operator} datetime('now', '-' || ? || ' days')`;
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
   * Acquire a per-migration-key advisory lock and begin a transaction atomically.
   *
   * Postgres: issues BEGIN, then takes pg_advisory_xact_lock(hashtext(lockKey), 42).
   * The advisory lock is scoped to the transaction and released automatically at
   * COMMIT or ROLLBACK.  Concurrent processes calling this with the same key will
   * block here until the winner commits/rolls back, then proceed to the re-check.
   *
   * After acquiring, callers MUST:
   *   1. Re-check DB state (re-check pattern after lock acquisition).
   *   2. Call db.query('COMMIT') or db.query('ROLLBACK') to release the lock.
   *
   * IMPORTANT: do NOT call db.query('BEGIN') before this method — this method
   * IS the transaction start.  Matching the SQLite signature for uniform callers.
   *
   * @param {string} lockKey  — typically the legacy project id; used as the hash input.
   * @returns {Promise<void>}
   */
  async acquireMigrationLock(lockKey) {
    // Begin the transaction.
    await this._client.query('BEGIN');
    // pg_advisory_xact_lock(int4, int4) — two-int4 overload.
    // hashtext($1) returns int4; constant second argument (42) namespaces this
    // usage away from other advisory lock consumers in the same DB.
    // The lock is held until the transaction ends.
    await this._client.query(
      `SELECT pg_advisory_xact_lock(hashtext($1), 42)`,
      [lockKey]
    );
  }

  /**
   * Take a transaction-scoped named advisory lock WITHOUT starting the
   * transaction itself (unlike acquireMigrationLock, which is namespaced to
   * migrations via the two-int4 overload and IS the BEGIN). Callers issue
   * their own BEGIN first, then call this, then COMMIT/ROLLBACK — same
   * calling convention scripts/lib/routing-profile.js's routingProfileSet
   * uses inline (BEGIN, then `pg_advisory_xact_lock(hashtext($1))`, do the
   * work, COMMIT). Exists so engine code (handoff.js) never branches on
   * db.dialect directly (S8 abstraction invariant) — the dialect-specific
   * mechanism lives here, one call site per adapter.
   *
   * @param {string} lockKey — arbitrary namespaced string, e.g.
   *   `session_in_progress:<project_id>`.
   * @returns {Promise<void>}
   */
  async acquireNamedXactLock(lockKey) {
    await this._client.query(
      `SELECT pg_advisory_xact_lock(hashtext($1))`,
      [lockKey]
    );
  }

  /**
   * Execute a SELECT query that may fail (e.g., table might not exist) without
   * aborting the surrounding transaction.
   *
   * Postgres: an error inside a transaction aborts the entire transaction block,
   * causing all subsequent queries to fail with "current transaction is aborted".
   * To prevent this, we wrap speculative queries in a SAVEPOINT/ROLLBACK TO SAVEPOINT
   * pair so that a table-not-found error only rolls back to the savepoint, leaving
   * the outer transaction intact.
   *
   * Outside a transaction: SAVEPOINTs are not valid (Postgres rejects them), so we
   * use a plain try/catch instead — a query error outside a transaction only affects
   * that single query and leaves the connection in a usable state.
   *
   * Returns { rows, rowCount } on success, or { rows: [], rowCount: 0 } on error
   * (error is swallowed; the caller treats absence/error as "0 rows").
   *
   * @param {string} sql
   * @param {any[]}  params
   * @returns {Promise<{ rows: any[], rowCount: number }>}
   */
  async querySafe(sql, params) {
    // Detect whether we are currently inside a transaction by probing the pg client's
    // internal state.  pg.Client exposes `_queryable` and transaction state via the
    // connection; the most reliable cross-version check is to attempt a SAVEPOINT and
    // treat the "not in a transaction" error as the signal to fall through to a plain
    // try/catch path.
    const spName = `sp_qs_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
    let inTransaction = false;
    try {
      await this._client.query(`SAVEPOINT ${spName}`);
      inTransaction = true;
    } catch (_) {
      // "SAVEPOINT can only be used in transaction blocks" — we are NOT in a transaction.
      inTransaction = false;
    }

    if (inTransaction) {
      // We are inside a transaction — use SAVEPOINT to prevent aborting on error.
      try {
        const result = await this._client.query(sql, params);
        await this._client.query(`RELEASE SAVEPOINT ${spName}`);
        return result;
      } catch (_) {
        try { await this._client.query(`ROLLBACK TO SAVEPOINT ${spName}`); } catch (_2) {}
        try { await this._client.query(`RELEASE SAVEPOINT ${spName}`); } catch (_2) {}
        return { rows: [], rowCount: 0 };
      }
    } else {
      // Outside a transaction — plain try/catch is safe.
      try {
        return await this._client.query(sql, params);
      } catch (_) {
        return { rows: [], rowCount: 0 };
      }
    }
  }

  /**
   * Attempt to create a single integrity (partial unique) index.
   * Non-fatal: if the index creation fails because existing rows violate the
   * uniqueness constraint (legacy duplicate corpus), returns { ok: false, msg }.
   * On success (index created or already exists), returns { ok: true }.
   * Never throws — the caller decides how to surface the result.
   *
   * cm#185 review B2: wrapped in the same BEGIN / SET LOCAL lock_timeout+
   * statement_timeout / COMMIT envelope as runIntegrityIndexPair (R-7) —
   * this is the lone-CREATE path (no preceding DROP, e.g.
   * assertions_1ton_exact_unique's `CREATE UNIQUE INDEX IF NOT EXISTS`), which
   * previously issued a bare, un-timeouted statement. A non-CONCURRENTLY
   * CREATE UNIQUE INDEX takes SHARE on the table (blocks writes); un-timeouted
   * against a live DB this is the indefinite-stall wedge R-7 exists to close.
   * CREATE INDEX (without CONCURRENTLY) is valid inside an explicit
   * transaction block, so this wrapping is safe.
   */
  async runIntegrityIndex(sql) {
    try {
      await this._client.query('BEGIN');
      await this._client.query(`SET LOCAL lock_timeout = '5s'`);
      await this._client.query(`SET LOCAL statement_timeout = '120s'`);
      await this._client.query(sql.trim());
      await this._client.query('COMMIT');
      return { ok: true, msg: 'index created' };
    } catch (e) {
      try { await this._client.query('ROLLBACK'); } catch (_) {}
      return { ok: false, msg: e.message };
    }
  }

  /**
   * cm#185: run a DROP INDEX IF EXISTS + CREATE [UNIQUE] INDEX pair as a single
   * atomic unit (its own transaction, with the R-7 lock/statement timeout
   * budget applied). If CREATE fails (legacy-duplicate corpus), the DROP is
   * rolled back too -- the index is never left in a "dropped but not
   * recreated" state (closes S-11).
   * Never throws -- returns { ok, msg }.
   */
  async runIntegrityIndexPair(dropSql, createSql) {
    try {
      await this._client.query('BEGIN');
      await this._client.query(`SET LOCAL lock_timeout = '5s'`);
      await this._client.query(`SET LOCAL statement_timeout = '120s'`);
      if (dropSql) await this._client.query(dropSql.trim());
      await this._client.query(createSql.trim());
      await this._client.query('COMMIT');
      return { ok: true, msg: 'index recreated' };
    } catch (e) {
      try { await this._client.query('ROLLBACK'); } catch (_) {}
      return { ok: false, msg: e.message };
    }
  }

  /**
   * cm#185: probe whether the given tables/columns/indexes exist via
   * information_schema / pg_indexes. Used as the post-apply structural
   * verification gate before the schema_fingerprint is upserted (closes
   * S-13: "did not throw" is not proof of "is present").
   * expected: { tables?: string[], columns?: {table,column}[], indexes?: string[] }
   * Returns { ok: boolean, missing: [{type, ...}] }. Never throws.
   */
  async schemaObjectsExist(expected) {
    // cm#185 review N4: wrapped in try/catch to actually honor the documented
    // "Never throws" contract. A query failure here (e.g. a transient
    // connection error) now fails CLOSED — reported as ok:false with a
    // synthetic 'error' entry in missing[] — rather than throwing past
    // ensureSchemaCurrent's verification-gate check without writing a
    // schema_apply_degraded row (the lock's own `finally` release was never
    // at risk, but the degradation row was).
    try {
      const missing = [];
      const client = this._client;
      if (expected.tables && expected.tables.length) {
        const { rows } = await client.query(
          `SELECT table_name FROM information_schema.tables
            WHERE table_schema = current_schema() AND table_name = ANY($1::text[])`,
          [expected.tables]
        );
        const found = new Set(rows.map((r) => r.table_name));
        for (const t of expected.tables) if (!found.has(t)) missing.push({ type: 'table', table: t });
      }
      if (expected.columns && expected.columns.length) {
        const { rows } = await client.query(
          `SELECT table_name, column_name FROM information_schema.columns
            WHERE table_schema = current_schema()`
        );
        const found = new Set(rows.map((r) => `${r.table_name}.${r.column_name}`));
        for (const c of expected.columns) {
          if (!found.has(`${c.table}.${c.column}`)) missing.push({ type: 'column', table: c.table, column: c.column });
        }
      }
      if (expected.indexes && expected.indexes.length) {
        const { rows } = await client.query(
          `SELECT indexname FROM pg_indexes
            WHERE schemaname = current_schema() AND indexname = ANY($1::text[])`,
          [expected.indexes]
        );
        const found = new Set(rows.map((r) => r.indexname));
        for (const i of expected.indexes) if (!found.has(i)) missing.push({ type: 'index', index: i });
      }
      return { ok: missing.length === 0, missing };
    } catch (e) {
      return { ok: false, missing: [{ type: 'error', message: e.message }] };
    }
  }

  /**
   * cm#185 (R-7): set the per-apply-transaction lock/statement timeout budget.
   * MUST be called after BEGIN (SET LOCAL is only valid inside a transaction
   * block). A blocked DDL statement now fails fast (non-fatal, retried on the
   * next invocation) rather than potentially wedging the live session behind a
   * queued ACCESS EXCLUSIVE lock indefinitely.
   */
  async setApplyTimeouts() {
    await this._client.query(`SET LOCAL lock_timeout = '5s'`);
    await this._client.query(`SET LOCAL statement_timeout = '120s'`);
  }

  /**
   * cm#185 (R-8): session-level advisory lock for the schema-apply sequence
   * (detect+apply+verify+upsert). Deliberately pg_advisory_lock (session-scoped),
   * NOT pg_advisory_xact_lock -- the apply phase runs multiple independently
   * committing per-file transactions (R-6 fail-fast), so a lock tied to a
   * single outer transaction (as acquireMigrationLock provides) cannot span
   * them. Namespace 43 (vs. acquireMigrationLock's 42) keeps this lock key
   * space disjoint from the existing identity-resolution advisory lock usage
   * in this same file.
   */
  /**
   * cm#185 review N1: bounded acquire. Without a bound, a wedged/long-lived
   * holder (e.g. a stuck concurrent process) blocks every subsequent close/
   * load/init on this project indefinitely. lock_timeout applies to blocking
   * advisory-lock acquisition the same as any other lock wait, so a 10s
   * SET lock_timeout before the acquire caps the wait; on timeout the query
   * throws and the caller (ensureSchemaCurrent / cmdInit) treats it as a
   * non-fatal, retried-next-time degradation rather than a hang. The
   * session-level SET is reset immediately after (success or failure) so the
   * bounded acquire-only timeout never leaks into unrelated later queries on
   * this same connection (e.g. the per-file apply transactions' own
   * SET LOCAL timeouts, or ordinary write-path queries later in the process).
   */
  async acquireSchemaApplyLock(lockKey) {
    try {
      await this._client.query(`SET lock_timeout = '10s'`);
      await this._client.query(`SELECT pg_advisory_lock(hashtext($1), 43)`, [lockKey]);
    } finally {
      try { await this._client.query(`SET lock_timeout = 0`); } catch (_) { /* best-effort reset */ }
    }
  }

  async releaseSchemaApplyLock(lockKey) {
    try { await this._client.query(`SELECT pg_advisory_unlock(hashtext($1), 43)`, [lockKey]); } catch (_) {}
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
   * Build an UPDATE that retires one or more live directive rows (L5).
   * Sets: suppressed = true, invalid_at = now(), suppression_kind = 'retired'.
   * Only acts on live rows (suppressed = false AND invalid_at IS NULL).
   *
   * withObject=true  (--object supplied): retire only exact (project_id, subject, predicate, object).
   * withObject=false (--object omitted):  retire ALL live rows for (project_id, subject, predicate).
   *   Caller is responsible for checking isDirective(predicate) before invoking this form.
   *
   * Returns { sql, params }.
   */
  buildRetirementUpdate(projectId, subject, predicate, object, withObject) {
    if (withObject) {
      return {
        sql: `UPDATE assertions
              SET suppressed = true, invalid_at = now(), suppression_kind = 'retired'
              WHERE project_id = $1
                AND subject    = $2
                AND predicate  = $3
                AND object     = $4
                AND suppressed = false
                AND invalid_at IS NULL`,
        params: [projectId, subject, predicate, object],
      };
    }
    return {
      sql: `UPDATE assertions
            SET suppressed = true, invalid_at = now(), suppression_kind = 'retired'
            WHERE project_id = $1
              AND subject    = $2
              AND predicate  = $3
              AND suppressed = false
              AND invalid_at IS NULL`,
      params: [projectId, subject, predicate],
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
   * Build a fuzzy-text match query over assertions using pg_trgm similarity.
   * Requires pg_trgm extension (added to setup.sql).
   * Matches against subject || ' ' || predicate || ' ' || object via similarity().
   * The % operator is equivalent to similarity(a,b) > pg_trgm.similarity_threshold.
   * Returns candidate subjects from any matching rows ordered by descending similarity.
   * Eligibility filtering (suppressed, suppression_kind, etc.) is the caller's
   * responsibility — this method does not filter by suppression state.
   * Returns { sql, params }.
   *
   * INTENTIONAL CROSS-BACKEND SEMANTIC DIFFERENCE:
   *   Postgres (this adapter): uses pg_trgm phrase similarity — whole-phrase match.
   *   SQLite (SQLiteAdapter.buildFuzzyMatch): uses per-token OR LIKE — matches if
   *     ANY token appears. Multi-word seeds may yield different candidate sets.
   * This is accepted: the resurrect branch runs on the Postgres loader path;
   * the SQLite arm is best-effort (seam validation only, not production traffic).
   */
  buildFuzzyMatch(projectId, seedText, limit) {
    const seed = String(seedText || '').trim();
    if (!seed) {
      return {
        sql: `SELECT id, subject, predicate, object FROM assertions WHERE 1=0`,
        params: [],
      };
    }
    return {
      sql: `SELECT id, subject, predicate, object,
                   similarity($2, subject || ' ' || predicate || ' ' || object) AS sim_score
            FROM assertions
            WHERE project_id = $1
              AND (subject || ' ' || predicate || ' ' || object) % $2
            ORDER BY sim_score DESC
            LIMIT $3`,
      params: [projectId, seed, limit],
    };
  }

  /**
   * Build a SQL predicate for comparing the epoch-seconds difference between two
   * timestamp columns against a fixed threshold.
   *
   * Postgres: `EXTRACT(EPOCH FROM (col1 - col2)) <operator> <thresholdSeconds>`
   * (EXTRACT(EPOCH FROM interval) returns seconds as a double precision value)
   *
   * Returns a plain SQL string (no params) — both columns and the threshold are
   * embedded directly.  Caller must integrate this into a WHERE clause.
   *
   * @param {string} col1              — minuend column (e.g. 'last_reinforced')
   * @param {string} col2              — subtrahend column (e.g. 'created_at')
   * @param {string} operator          — comparison operator (e.g. '>', '>=', '<', '<=')
   * @param {number} thresholdSeconds  — threshold in integer seconds (e.g. 86400)
   * @returns {string}
   */
  buildEpochSecondsDiffPredicate(col1, col2, operator, thresholdSeconds) {
    return `EXTRACT(EPOCH FROM (${col1} - ${col2})) ${operator} ${thresholdSeconds}`;
  }

  /**
   * Build a SQL predicate for `col <operator> now() - N days` using a bound parameter.
   *
   * Postgres: `col <operator> now() - ($N || ' days')::interval`
   * The corresponding query param (the number of days as a string) must be bound
   * at position paramOffset in the query's param array.
   *
   * @param {string} col         — column name (e.g. 'retrieved_at')
   * @param {string} operator    — comparison operator (e.g. '>=', '<')
   * @param {number} paramOffset — 1-based position of the days param (e.g. 2 for $2)
   * @returns {string}
   */
  buildWithinDaysPredicate(col, operator, paramOffset) {
    return `${col} ${operator} now() - ($${paramOffset} || ' days')::interval`;
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
