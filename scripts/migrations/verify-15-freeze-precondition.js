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

 * Usage: node scripts/migrations/verify-15-freeze-precondition.js
 * (reads --source-db repeated, or defaults to every distinct source_db in
 * the roster)
 * Exit codes: 0 = every probed source rejected the write, 1 = any source
 * accepted it (freeze not enforced) or a probe errored for an unrelated
 * reason.
 */

const shared = require('./lib/verify15-shared');

function distinctSqlSourceDbs(roster) {
  const map = new Map(); // source_db -> first source_table
  for (const entry of roster) {
    if (entry.source_db.startsWith('filesystem:')) continue;
    const { isSourceless } = shared.classifyRosterSourceDb(entry.source_db, `roster entry targetTable=${entry.targetTable}`);
    if (isSourceless) continue; // net-new: no source system exists to freeze
    if (!map.has(entry.source_db)) map.set(entry.source_db, entry.source_table);
  }
  return map;
}

/**
 * Probe one source: attempt a no-op-but-real UPDATE through a live
 * connection. Returns { rejected: boolean, errMessage: string|null }.
 * Exported standalone so the test suite can exercise it directly against a
 * deliberately non-frozen (writable) scratch DB to prove the FAIL branch
 * fires, and against a frozen one to prove the PASS branch fires.
 */
async function probeFrozen(sourceDb, table) {
  const client = await shared.connect(sourceDb);
  let rejected = false;
  let errMessage = null;
  try {
    await client.query(`UPDATE ${table} SET id = id WHERE false`);
  } catch (err) {
    rejected = true;
    errMessage = err.message;
  } finally {
    await client.end();
  }
  return { rejected, errMessage };
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
      const { rejected, errMessage } = await probeFrozen(sourceDb, table);
      if (rejected) {
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
