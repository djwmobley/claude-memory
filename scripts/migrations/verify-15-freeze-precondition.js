'use strict';

const AUTHORED_BY = 'sonnet-t-battery-author-2026-07-27';

/**
 * verify-15-freeze-precondition.js — §15.1's T1 freeze-enforcement probe.
 *
 * "Frozen READ-ONLY" is a policy statement, not a mechanism, until something
 * verifies it. This script attempts ONE throwaway write against each frozen
 * source, THROUGH ITS NORMAL WRITE PATH, and asserts the write is REJECTED —
 * not merely that no write happened to occur during the check. This is a
 * PRECONDITION on T1: T1's "populated for every in-scope source table"
 * checklist line does not get checked green until this probe has passed for
 * every source T1 is about to snapshot.
 *
 * Probe mechanism: `UPDATE <table> SET id = id WHERE false` against each
 * distinct, non-filesystem source_db in the roster (one probe table per
 * source_db — the first roster entry's source_table for that source_db).
 * WHERE false touches zero rows but the statement is still a data-modifying
 * statement, so it is rejected identically under EITHER of §15.1's two
 * enforcement mechanisms:
 *   (a) REVOKE INSERT/UPDATE/DELETE on the app role — rejected as a
 *       permission-denied error at the privilege-check stage, before any
 *       row is touched;
 *   (b) ALTER DATABASE ... SET default_transaction_read_only = true —
 *       rejected as a read-only-transaction error at statement-execution
 *       time, also before any row is touched.
 * If the UPDATE does NOT throw, the freeze is NOT enforced for that source —
 * a hard FAIL, regardless of which mechanism was supposedly applied.
 *
 * filesystem:-prefixed sources (markdown, §6.1(h)/(i)) have no SQL write
 * path to probe — freeze there means filesystem permissions, which this
 * script does not check (documented blind spot, see PR body).
 *
 * `net-new:<store>`-prefixed sources (§9/§17/§18 tables with no migration
 * source — see shared.classifyRosterSourceDb) ALSO have nothing to probe:
 * there is no source system to freeze in the first place, since nothing is
 * ever migrated FROM one. Skipped explicitly, with a printed count — never
 * silently dropped from `distinctSqlSourceDbs`'s output without comment.
 *
 * LABEL-DUPLICATE ENTRIES ARE NEVER SELECTED AS THE PROBE TABLE (cm#210 fix,
 * closes A-2). This script probes ONE table per distinct source_db --
 * previously "the first roster entry's source_table for that source_db," a
 * POSITIONAL assumption over a human-edited file (this repo's own canon
 * forbids exactly this shape: humans reorder roster entries by hand, and a
 * parser that assumes position breaks silently on the next such edit). A
 * label-duplicate entry's source_table is a manifest-bookkeeping LABEL, not
 * a physical relation (see verify-15-t3-content-hash.js's branch (c) header
 * comment) -- probing it with `UPDATE <label> SET id=id WHERE false` against
 * a relation that was never supposed to exist throws "relation does not
 * exist" (Postgres 42P01), which the OLD probeFrozen miscounted as
 * `rejected: true` ("freeze confirmed") regardless of whether the source was
 * actually writable. Concrete exploit this closed: reorder the real roster
 * so a label-duplicate entry (e.g. memory_entries_db_absorb) is FIRST for
 * its source_db -- the old code silently "confirmed" freeze on a fully
 * writable source, zero code changes needed to trigger. distinctSqlSourceDbs
 * now skips label-duplicate entries when choosing a probe table (load-time
 * validation guarantees a real SQL-sourced physical sibling exists under the
 * SAME source_db, so a source_db can never end up probe-less because of this
 * skip); probeFrozen ALSO now total-classifies 42P01 specifically (see its
 * own header comment) as an independent, general fix -- so ANY probe target
 * that doesn't exist is refused loud as a config error, not silently
 * confirmed as evidence of freeze, closing the underlying bug class, not
 * just this one instance of it.
 *

 * Usage: node scripts/migrations/verify-15-freeze-precondition.js
 * (reads --source-db repeated, or defaults to every distinct source_db in
 * the roster)
 * Exit codes: 0 = every probed source rejected the write, 1 = any source
 * accepted it (freeze not enforced) or a probe errored for an unrelated
 * reason.
 */

const shared = require('./lib/verify15-shared');

function distinctSqlSourceDbs(roster) {
  const map = new Map(); // source_db -> first NON-label-duplicate source_table
  for (const entry of roster) {
    if (entry.source_db.startsWith('filesystem:')) continue;
    const { isSourceless } = shared.classifyRosterSourceDb(entry.source_db, `roster entry targetTable=${entry.targetTable}`);
    if (isSourceless) continue; // net-new: no source system exists to freeze
    // cm#210 fix (A-2): never select a label-duplicate entry as the probe
    // table -- its source_table is a manifest-bookkeeping LABEL, not a
    // physical relation (see this file's header comment). Load-time
    // validation (validateManifestLabelDuplicates) guarantees a real,
    // SQL-sourced physical sibling exists under this SAME source_db, so
    // skipping label-duplicate entries here can never leave a source_db
    // probe-less.
    if (entry.manifest_label_duplicate_of) continue;
    if (!map.has(entry.source_db)) map.set(entry.source_db, entry.source_table);
  }
  return map;
}

/**
 * Probe one source: attempt a no-op-but-real UPDATE through a live
 * connection. Returns { rejected: boolean, errMessage: string|null,
 * configError: string|null }.
 *
 * TOTAL CLASSIFICATION OF THE QUERY ERROR (cm#210 fix, closes A-2's general
 * form). Before this fix, ANY thrown error -- including Postgres 42P01
 * (undefined_table, "relation ... does not exist") -- was folded into
 * `rejected: true`, i.e. "freeze confirmed." A probe table that doesn't
 * exist is not evidence of freeze either way: it is a CONFIG error (the
 * roster's probe-table selection named something that isn't live on this
 * source), reported as `configError`, never silently counted as `rejected`.
 * Every OTHER error still classifies `rejected: true` exactly as before
 * (permission-denied from a REVOKEd role, read-only-transaction from
 * default_transaction_read_only -- both are genuine freeze-enforcement
 * evidence). Exported standalone so the test suite can exercise it directly
 * against a deliberately non-frozen (writable) scratch DB to prove the FAIL
 * branch fires, against a frozen one to prove the PASS branch fires, and
 * against a nonexistent relation to prove the configError branch fires
 * (never silently miscounted as PASS).
 */
async function probeFrozen(sourceDb, table) {
  const client = await shared.connect(sourceDb);
  let rejected = false;
  let errMessage = null;
  let configError = null;
  try {
    await client.query(`UPDATE ${table} SET id = id WHERE false`);
  } catch (err) {
    if (err && err.code === '42P01') {
      configError = `probe table "${table}" does not exist on source_db "${sourceDb}" (Postgres 42P01 undefined_table) — this is not evidence of freeze; fix the roster's probe-table selection (or the source schema), never treat this as "freeze confirmed."`;
    } else {
      rejected = true;
      errMessage = err.message;
    }
  } finally {
    await client.end();
  }
  return { rejected, errMessage, configError };
}

async function main() {
  const argv = process.argv.slice(2);
  const explicitSourceDbs = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--source-db') explicitSourceDbs.push(argv[++i]);
    else if (argv[i].startsWith('--source-db=')) explicitSourceDbs.push(argv[i].slice('--source-db='.length));
  }

  const roster = shared.loadRoster();
  const { sourceless } = shared.partitionRoster(roster);
  if (sourceless.length) {
    console.log(`[freeze-precondition] ${sourceless.length} sourceless (net-new:) roster entr${sourceless.length === 1 ? 'y' : 'ies'} excluded from probing — no source system exists to freeze:`);
    for (const e of sourceless) console.log(`  - ${e.source_db} -> ${e.targetTable}`);
  }
  const allSources = distinctSqlSourceDbs(roster);

  let toProbe;
  if (explicitSourceDbs.length) {
    toProbe = new Map();
    for (const db of explicitSourceDbs) {
      if (!allSources.has(db)) {
        console.error(`FATAL: --source-db "${db}" is not a SQL-shaped source_db present in the roster.`);
        process.exit(1);
      }
      toProbe.set(db, allSources.get(db));
    }
  } else {
    toProbe = allSources;
  }

  if (toProbe.size === 0) {
    console.error('FATAL: no SQL-shaped sources found to probe (roster has zero non-filesystem entries, or --source-db matched nothing).');
    process.exit(1);
  }

  let failed = false;
  for (const [sourceDb, table] of toProbe) {
    try {
      const { rejected, errMessage, configError } = await probeFrozen(sourceDb, table);
      if (configError) {
        // cm#210 fix (A-2): a 42P01 (undefined_table) probe result is a
        // config error, never evidence of freeze either way -- reported as
        // its own FATAL-shaped branch, distinct from both PASS and the
        // ordinary "freeze not enforced" FAIL.
        failed = true;
        console.error(`[freeze-precondition] FATAL: ${sourceDb} (probed via ${table}): ${configError}`);
      } else if (rejected) {
        console.log(`[freeze-precondition] OK: ${sourceDb} (probed via ${table}) rejected the throwaway write: ${errMessage}`);
      } else {
        failed = true;
        console.error(`[freeze-precondition] FAIL: ${sourceDb} (probed via ${table}) ACCEPTED the throwaway write — freeze is NOT enforced.`);
      }
    } catch (err) {
      failed = true;
      console.error(`[freeze-precondition] FAIL: ${sourceDb} probe errored unexpectedly: ${err.message}`);
    }
  }
  process.exit(failed ? 1 : 0);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err && err.stack ? err.stack : err);
    process.exit(1);
  });
}

module.exports = { AUTHORED_BY, distinctSqlSourceDbs, probeFrozen };
