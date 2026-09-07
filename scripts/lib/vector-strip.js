'use strict';

/**
 * vector-strip.js — strips pgvector-typed columns (embedding, etc.) from row
 * objects before they cross the MCP tool boundary. Observed live 2026-09-07:
 * assertion_read with predicate=open_thread on claude-memory returned ~2.5MB
 * across ~1,500 lines because every row carried its full embedding vector
 * (4000 dims) plus related columns — the tool was unusable for its actual
 * purpose (finding rows by subject/predicate to update or suppress).
 *
 * TOTAL CLASSIFICATION (not an allow-list): the set of vector-valued columns
 * per table is derived from scripts/sql/schema-manifest.json's
 * `pgvector_gated` entries -- a column is either declared vector-typed in
 * the manifest (every unit's pgvector_gated.columns entries, unioned across
 * units) or it is not; there is no hand-maintained name list to drift out of
 * sync with the schema. A table with no pgvector_gated entry strips nothing
 * (stripRow/stripRows are then a no-op passthrough), which is the correct
 * behavior for entities/edges today and stays correct if either ever grows
 * a vector column declared in the manifest -- no code change needed here.
 */

const fs = require('fs');
const path = require('path');

const MANIFEST_PATH = path.join(__dirname, '..', 'sql', 'schema-manifest.json');

let cachedColumnsByTable = null;

/**
 * Builds { tableName: [{ column, type, dims }] } from every unit's
 * pgvector_gated.columns entries in schema-manifest.json, unioned across
 * units (a column declared by more than one unit is deduped by
 * table+column, last-write-wins on type/dims -- schema-manifest.json today
 * has no such duplicate, but the union is defensive rather than assuming
 * that never changes).
 */
function loadVectorColumnsByTable() {
  if (cachedColumnsByTable) return cachedColumnsByTable;

  const map = Object.create(null);
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
  } catch (err) {
    // Fail-soft, never fail-open on secrecy: if the manifest can't be read/
    // parsed, we cannot prove a column is vector-typed, so we strip NOTHING
    // rather than guess. This is the same posture the manifest's own _doc
    // requires for schema classification (loud degrade, not a silent skip)
    // -- surfaced here as an empty map (stripRow/stripRows become no-ops)
    // rather than throwing, since a read tool that used to work must not
    // start hard-failing because of an unrelated manifest read error.
    cachedColumnsByTable = map;
    return map;
  }

  const units = (manifest && manifest.units) || {};
  for (const unitName of Object.keys(units)) {
    const gated = units[unitName] && units[unitName].pgvector_gated;
    const cols = gated && Array.isArray(gated.columns) ? gated.columns : [];
    for (const entry of cols) {
      if (!entry || typeof entry.table !== 'string' || typeof entry.column !== 'string') continue;
      if (!map[entry.table]) map[entry.table] = [];
      const existing = map[entry.table].find((c) => c.column === entry.column);
      if (existing) {
        existing.type = entry.type;
        existing.dims = entry.dims;
      } else {
        map[entry.table].push({ column: entry.column, type: entry.type, dims: entry.dims });
      }
    }
  }

  cachedColumnsByTable = map;
  return map;
}

/** Test-only: force a re-read of schema-manifest.json on next call. */
function _resetCacheForTests() {
  cachedColumnsByTable = null;
}

/**
 * getVectorColumnsForTable — returns the manifest-declared vector columns
 * for `table` ([] when the table has none).
 */
function getVectorColumnsForTable(table) {
  const map = loadVectorColumnsByTable();
  return map[table] || [];
}

/**
 * stripRow — strips manifest-declared vector columns from a single flat row
 * object, replacing each with `<col>_present: true|false` and, when
 * present, `<col>_dims: N`. Non-object input (null/undefined) passes
 * through unchanged. includeEmbeddings:true returns the row unmodified
 * (R2 opt-in).
 */
function stripRow(row, table, { includeEmbeddings = false } = {}) {
  if (!row || typeof row !== 'object') return row;
  if (includeEmbeddings) return row;

  const vectorCols = getVectorColumnsForTable(table);
  if (vectorCols.length === 0) return row;

  const out = { ...row };
  for (const { column, dims } of vectorCols) {
    if (!Object.prototype.hasOwnProperty.call(out, column)) continue;
    const value = out[column];
    const present = value !== null && value !== undefined;
    delete out[column];
    out[`${column}_present`] = present;
    if (present && Number.isInteger(dims)) {
      out[`${column}_dims`] = dims;
    }
  }
  return out;
}

/** stripRows — stripRow applied over an array; non-array input passes through. */
function stripRows(rows, table, opts) {
  if (!Array.isArray(rows)) return rows;
  return rows.map((row) => stripRow(row, table, opts));
}

module.exports = {
  getVectorColumnsForTable,
  stripRow,
  stripRows,
  _resetCacheForTests,
};
