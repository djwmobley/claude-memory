'use strict';

/**
 * predicate-audit.js — Detect used-but-unregistered predicates in the assertions table.
 *
 * Exports two functions:
 *   findUnregisteredPredicates(predicates) — pure helper, no DB.
 *   auditAssertionPredicates(db, opts)     — queries live assertions rows.
 *
 * Purpose: close the CI gap that let predicates such as `has_updated` be emitted
 * for multiple sessions, silently kept by the permissive write path, and never
 * surfaced as a test failure because no test checked that predicates written to
 * the DB are a subset of the registry.
 */

const { recognizedPredicates } = require('./predicate-registry');

/**
 * Given an array of predicate strings, return those that are NOT in the
 * declared registry vocabulary, deduped and in original input order.
 *
 * Pure function — no DB access, no side effects.
 *
 * @param {string[]} predicates
 * @returns {string[]}
 */
function findUnregisteredPredicates(predicates) {
  const known = new Set(recognizedPredicates());
  const seen  = new Set();
  const out   = [];
  for (const p of predicates) {
    if (!known.has(p) && !seen.has(p)) {
      out.push(p);
      seen.add(p);
    }
  }
  return out;
}

/**
 * Query the assertions table for every distinct predicate that is NOT in the
 * declared registry vocabulary, along with its occurrence count.
 *
 * When opts.projectId is provided the query is scoped to that project; otherwise
 * the entire DB is scanned (useful as an ops-gate against the live corpus).
 *
 * @param {import('pg').Client} db - A connected pg Client.
 * @param {{ projectId?: string }} [opts={}]
 * @returns {Promise<Array<{ predicate: string, count: number }>>}
 */
async function auditAssertionPredicates(db, opts) {
  const { projectId } = opts || {};

  let queryText;
  let queryParams;

  if (projectId != null) {
    queryText  = 'SELECT predicate, COUNT(*) AS n FROM assertions WHERE project_id = $1 GROUP BY predicate';
    queryParams = [projectId];
  } else {
    queryText  = 'SELECT predicate, COUNT(*) AS n FROM assertions GROUP BY predicate';
    queryParams = [];
  }

  const { rows } = await db.query(queryText, queryParams);

  const known = new Set(recognizedPredicates());
  return rows
    .filter((r) => !known.has(r.predicate))
    .map((r) => ({ predicate: r.predicate, count: parseInt(r.n, 10) }));
}

module.exports = { findUnregisteredPredicates, auditAssertionPredicates };
