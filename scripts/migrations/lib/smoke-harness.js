'use strict';

/**
 * smoke-harness.js
 *
 * Shared transaction+rollback / run-prefix / residue-scan harness, extracted
 * from verify-17-routing-smoke.js (runbook §18, ADVERSARY-PASS AMENDMENTS
 * A-15/A-16). Used by BOTH verify-17-routing-smoke.js and
 * verify-18-usage-smoke.js so the "run entirely inside one transaction that
 * is always rolled back, then prove zero residue" pattern lives in exactly
 * one place.
 *
 * DESIGN CONTRACT (A-15): wipeTables and residueSpecs are explicit
 * PER-CALLER parameters passed to withTransactionRollback / scanForResidue
 * -- there are no shared default lists baked into this module. Only
 * model_registry is EVER an appropriate wipe-list entry across the whole
 * repo (it is the single global, cross-project recommendation pool a smoke
 * run needs to make deterministic); turn_usage and session_usage are NEVER
 * wiped -- a live target's real telemetry rows must survive a smoke run
 * untouched, so those tables are only ever prefix-residue-scanned, never
 * DELETEd, even inside the always-rolled-back transaction.
 *
 * LABEL CONTRACT (A-16): runCheck/printSummary/makeRunPrefix parametrize
 * BOTH label formats verify-17's own regression test (test/migrations/
 * test-verify-17.js) depends on byte-for-byte:
 *   - check lines:   "[SMOKE-<label>][<id>] PASS|FAIL <name>[: <reason>]"
 *     (note the dash between SMOKE and the label)
 *   - summary line:  "SMOKE<label>_RESULT: PASS|FAIL"
 *     (note: NO dash between SMOKE and the label here -- this asymmetry is
 *     intentional and preserved exactly as verify-17 originally emitted it)
 * Acceptance (A-16): verify-17-routing-smoke.js's stdout is byte-identical
 * pre/post this extraction for a passing run, and test-verify-17.js passes
 * UNMODIFIED against the extracted version.
 */

const crypto = require('crypto');

/**
 * Generate a run-prefixed fixture namespace, e.g. "smoke17-a1b2c3d4" for
 * label="17". Every smoke fixture (project/session id, role, model label,
 * etc.) is scoped under this prefix so a live target's real rows can never
 * collide with -- or be mistaken for -- a smoke run's own fixtures.
 *
 * @param {string} label -- the smoke script's number, e.g. "17" or "18"
 * @returns {string}
 */
function makeRunPrefix(label) {
  return `smoke${label}-${crypto.randomBytes(4).toString('hex')}`;
}

/**
 * Run one named check, printing the "[SMOKE-<label>][<id>] PASS|FAIL <name>"
 * line the smoke script's own test suite regex-matches on. Never throws --
 * a thrown error inside `fn` is caught and reported as a FAIL line carrying
 * the error's message, matching verify-17's original runCheck contract.
 *
 * @param {string} label -- e.g. "17" or "18"
 * @param {number|string} id -- the check's number within this smoke run
 * @param {string} name -- the check's display name
 * @param {() => Promise<void>} fn -- the check body; throws on failure
 * @returns {Promise<boolean>} true on PASS, false on FAIL
 */
async function runCheck(label, id, name, fn) {
  try {
    await fn();
    console.log(`[SMOKE-${label}][${id}] PASS ${name}`);
    return true;
  } catch (err) {
    console.log(`[SMOKE-${label}][${id}] FAIL ${name}: ${err.message}`);
    return false;
  }
}

/**
 * Print the smoke run's final summary line. Deliberately NO dash between
 * "SMOKE" and the label (asymmetric with the per-check "[SMOKE-<label>]"
 * bracket format above) -- preserved exactly as verify-17 originally
 * emitted it, since test-verify-17.js regex-matches this literal shape.
 *
 * @param {string} label
 * @param {boolean} ok
 */
function printSummary(label, ok) {
  console.log(`SMOKE${label}_RESULT: ${ok ? 'PASS' : 'FAIL'}`);
}

/**
 * Run `fn` entirely inside one transaction on the given client, first
 * DELETE-ing every table in `wipeTables` (in array order) to make the
 * run deterministic regardless of what real operator rows already exist in
 * those (small, global) tables, then unconditionally ROLLBACK -- success or
 * failure. This IS the entire cleanup mechanism (mirrors verify-17's
 * ADVERSARY-PASS AMENDMENT 4-1/4-2/4-3): zero residue by construction,
 * Postgres itself guarantees rollback on connection death, so no
 * crash/SIGKILL cleanup path is needed. The BEGIN/DELETE/ROLLBACK sequence
 * is unguarded by its own try/catch beyond the outer try/finally -- if BEGIN
 * itself fails, the finally's ROLLBACK attempt surfaces its own error to the
 * caller, matching verify-17's original (unwrapped) behavior exactly.
 *
 * @param {import('pg').Client} client
 * @param {string[]} wipeTables -- explicit per-caller list (A-15); no
 *   shared default. Only ever ['model_registry'] anywhere in this repo.
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 * @template T
 */
async function withTransactionRollback(client, wipeTables, fn) {
  let result;
  try {
    await client.query('BEGIN');
    for (const table of wipeTables) {
      await client.query(`DELETE FROM ${table}`);
    }
    result = await fn();
  } finally {
    await client.query('ROLLBACK');
  }
  return result;
}

/**
 * Post-rollback defense-in-depth scan: prove zero COMMITTED rows carry this
 * run's prefix across the given residue specs. Each spec names a table and
 * a raw WHERE-clause fragment referencing `$1` as the `<prefix>%` LIKE
 * parameter -- a plain per-table column check for most tables, but able to
 * express the routing_profiles-style compound OR clause (the '*' sentinel
 * project_id fixture, matched on its run-prefixed role instead) that a
 * single {table, column} shape could not.
 *
 * @param {import('pg').Client} client
 * @param {string} prefix -- e.g. "smoke17-a1b2c3d4"
 * @param {{ table: string, where: string }[]} residueSpecs -- explicit
 *   per-caller list (A-15); no shared default. Table names and WHERE
 *   fragments come from source-controlled config, never user input.
 * @returns {Promise<string[]>} human-readable residue descriptions; empty
 *   when clean
 */
async function scanForResidue(client, prefix, residueSpecs) {
  const residue = [];
  const like = `${prefix}%`;
  for (const spec of residueSpecs) {
    const { rows } = await client.query(
      `SELECT count(*)::int AS n FROM ${spec.table} WHERE ${spec.where}`,
      [like]
    );
    if (rows[0].n > 0) residue.push(`${spec.table}: ${rows[0].n} row(s)`);
  }
  return residue;
}

module.exports = {
  makeRunPrefix,
  runCheck,
  printSummary,
  withTransactionRollback,
  scanForResidue,
};
