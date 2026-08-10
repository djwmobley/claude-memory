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
 * SAVEPOINT ISOLATION (added post-review, PR #157): every check runs inside
 * its own named SAVEPOINT within the shared outer transaction, unconditionally
 * ROLLBACK TO SAVEPOINT'd afterward -- success or failure. This does two
 * things: (1) undoes whatever DML a passing check left behind (redundant
 * with a well-behaved check's own cleanup, but harmless and now guaranteed
 * rather than assumed); (2) HEALS the shared transaction when a check's
 * failure was a genuine Postgres-level statement error (e.g. a NUMERIC
 * column-range overflow), not merely a JS-level throw. Without this, a
 * check that provokes a real Postgres error poisons the connection --
 * "current transaction is aborted, commands ignored until end of
 * transaction block" -- for every subsequent query on it, including that
 * SAME check's own post-failure assertions and every check that runs after
 * it. Discovered via verify-18-usage-smoke.js's COST RANGE GUARD check,
 * whose rollup-overflow sub-case deliberately triggers a real Postgres
 * 22003 (see usage-telemetry.js's CostOutOfRangeError); fixed here, at the
 * shared harness level, rather than as a narrow point-fix local to that one
 * check, so no future check in either smoke script can reintroduce the
 * same class of bug. Every check in this repo currently uses a disjoint,
 * PREFIX-suffixed fixture namespace (no check reads another check's
 * leftover state), so per-check savepoint isolation is safe by construction
 * -- verified against both verify-17-routing-smoke.js's and
 * verify-18-usage-smoke.js's own checks.
 *
 * @param {import('pg').Client} client
 * @param {string} label -- e.g. "17" or "18"
 * @param {number|string} id -- the check's number within this smoke run
 * @param {string} name -- the check's display name
 * @param {() => Promise<void>} fn -- the check body; throws on failure
 * @returns {Promise<boolean>} true on PASS, false on FAIL
 */
async function runCheck(client, label, id, name, fn) {
  const savepoint = `smoke_check_${label}_${id}`;
  await client.query(`SAVEPOINT ${savepoint}`);
  let ok;
  try {
    await fn();
    console.log(`[SMOKE-${label}][${id}] PASS ${name}`);
    ok = true;
  } catch (err) {
    console.log(`[SMOKE-${label}][${id}] FAIL ${name}: ${err.message}`);
    ok = false;
  }
  await client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
  return ok;
}

/**
 * Run `fn` inside its own named SAVEPOINT within the current transaction.
 * On success, RELEASE SAVEPOINT (keeps `fn`'s effects). On failure,
 * ROLLBACK TO SAVEPOINT (undoes `fn`'s effects AND heals the transaction if
 * `fn` triggered a genuine Postgres-level statement error, e.g. a NUMERIC
 * column-range overflow) and then re-throws the original error unchanged --
 * callers still see and can assert on it.
 *
 * runCheck's own per-check savepoint (above) protects LATER checks from an
 * EARLIER check's DB-level error, but does nothing for code that runs
 * AFTER the poisoning point but STILL INSIDE the same check (e.g. a
 * post-failure row-count assertion in the same check function) -- the
 * poisoned transaction persists until something issues a ROLLBACK [TO
 * SAVEPOINT]. This helper is the fine-grained tool a check uses to wrap
 * ONLY the specific sub-operation expected to trigger a genuine DB-level
 * error, so the rest of that same check keeps running against a healthy
 * transaction. (Discovered via verify-18-usage-smoke.js's COST RANGE GUARD
 * check, whose rollup-overflow sub-case needed exactly this.)
 *
 * @param {import('pg').Client} client
 * @param {string} name -- a valid SQL identifier, unique within its scope
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 * @template T
 */
async function withSavepoint(client, name, fn) {
  await client.query(`SAVEPOINT ${name}`);
  try {
    const result = await fn();
    await client.query(`RELEASE SAVEPOINT ${name}`);
    return result;
  } catch (err) {
    await client.query(`ROLLBACK TO SAVEPOINT ${name}`);
    throw err;
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
  withSavepoint,
  printSummary,
  withTransactionRollback,
  scanForResidue,
};
