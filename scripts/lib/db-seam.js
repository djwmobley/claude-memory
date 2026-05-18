'use strict';

// db-seam.js -- Thin storage abstraction for handoff.js.
// Wraps Postgres (pg.Client, default) or SQLite (node:sqlite, Node 22+).
// Enabled via STORAGE_BACKEND=sqlite or storage_backend:sqlite in pipeline.yml.
// Default is 'postgres' -- byte-identical behavior when unset.
//
// DIALECT DIFFERENCES HANDLED:
//   1. Param placeholders:  $N -> ?
//   2. JSONB vs TEXT:       serialize/deserialize queries + payload columns
//   3. Date arithmetic:     EXTRACT(EPOCH FROM (now()-col))/86400
//                           -> (julianday('now')-julianday(col)) [numerically identical]
//   4. ON CONFLICT:         identical syntax -- no rewrite needed
//   5. ADD COLUMN IF NOT EXISTS: identical -- no rewrite
//   6. Graph CTE cycle prevention: Postgres ARRAY path -> SQLite delimited string path
//   7. Array params:        id = ANY($n::int[]) -> IN (?,?) via buildInClause()
//   8. RETURNING id:        INSERT then SELECT last_insert_rowid()
//   9. now():               -> datetime('now')
//  10. Interval subtraction: col < now()-($n||' days')::interval
//                            -> col < datetime('now', '-' || ? || ' days')
//
// The 86400 constants at handoff.js lines 273/2193/2280 are JS-level; NOT in SQL path.
// SQL decay: EXTRACT(EPOCH...)/86400 == (julianday('now')-julianday(col)) (both = fractional days).

const path = require('path');

// ---- resolveDialect -------------------------------------------------------

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

// ---- rewriteForSQLite ----------------------------------------------------

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

// ---- param / row helpers -------------------------------------------------

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

// ---- statement splitter --------------------------------------------------

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

// ---- SQLiteClient --------------------------------------------------------

class SQLiteClient {
  constructor(dbPath) {
    this._dbPath  = dbPath;
    this._db      = null;
    this._txDepth = 0;
  }

  async connect() {
    const { DatabaseSync } = require('node:sqlite');
    this._db = new DatabaseSync(this._dbPath);
    this._db.prepare('PRAGMA journal_mode=WAL').run();
    this._db.prepare('PRAGMA foreign_keys=ON').run();
  }

  async query(sql, params) {
    const db = this._db;
    if (!db) throw new Error('SQLiteClient: not connected');
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
    if (!db) throw new Error('SQLiteClient: not connected');
    const stmts = splitStatements(rewriteForSQLite(sql));
    for (const stmt of stmts) {
      const s = stmt.trim();
      if (s) db.prepare(s).run();
    }
  }

  async end() {
    if (this._db) { try { this._db.close(); } catch (_) {} this._db = null; }
  }
}

Object.defineProperty(SQLiteClient.prototype, 'dialect', { get() { return 'sqlite'; } });

// ---- PostgresClient (transparent pass-through) ---------------------------

class PostgresClient {
  constructor(pgClient) { this._client = pgClient; }
  async connect()             { return this._client.connect(); }
  async query(sql, params)    { return this._client.query(sql, params); }
  async end()                 { return this._client.end(); }
  async runSchema(sql)        { return this._client.query(sql); }
}

Object.defineProperty(PostgresClient.prototype, 'dialect', { get() { return 'postgres'; } });

// ---- factory -------------------------------------------------------------

async function createClient(dialect, opts) {
  if (dialect === 'sqlite') {
    const c = new SQLiteClient(opts.dbPath);
    await c.connect();
    return c;
  }
  const { Client } = require('pg');
  const pgc = new Client({
    host: opts.host, port: opts.port,
    database: opts.database, user: opts.user,
  });
  const w = new PostgresClient(pgc);
  await w.connect();
  return w;
}

// ---- buildInClause -------------------------------------------------------

function buildInClause(columnExpr, values) {
  if (!values || values.length === 0) return { clause: '1=0', params: [] };
  return {
    clause: `${columnExpr} IN (${values.map(() => '?').join(', ')})`,
    params: values.slice(),
  };
}

// ---- buildSQLiteGraphCTE -------------------------------------------------

/**
 * Build a SQLite-compatible recursive CTE for graph traversal.
 * Cycle prevention: '|'-delimited path string.
 *   Guard: INSTR('|' || t.path || '|', '|' || entity || '|') = 0
 * Seeds expand as one UNION ALL base row each. maxDepth clamped <=5 by caller.
 *
 * @param {'out'|'in'|'both'} direction
 * @param {string[]} seeds        entity names
 * @param {number}   maxDepth     (already clamped to <=5 by caller)
 * @param {number}   maxNodes
 * @param {string}   projectId
 * @returns {{ sql: string, params: any[] }}
 */
function buildSQLiteGraphCTE(direction, seeds, maxDepth, maxNodes, projectId) {
  if (direction === 'both') return _buildBothCTE(seeds, maxDepth, maxNodes, projectId);

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

function _buildBothCTE(seeds, maxDepth, maxNodes, projectId) {
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

// ---- resolveSQLiteDbPath -------------------------------------------------

function resolveSQLiteDbPath(projectRoot) {
  if (process.env.HANDOFF_SQLITE_PATH) return process.env.HANDOFF_SQLITE_PATH;
  return path.join(projectRoot, '.claude', 'handoff.sqlite');
}

// ---- exports -------------------------------------------------------------

module.exports = {
  resolveDialect,
  createClient,
  rewriteForSQLite,
  buildInClause,
  buildSQLiteGraphCTE,
  resolveSQLiteDbPath,
  SQLiteClient,
  PostgresClient,
  // exported for tests:
  splitStatements,
  deserializeRow,
  serializeParams,
};