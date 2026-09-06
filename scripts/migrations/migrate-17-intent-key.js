'use strict';

/**
 * migrate-17-intent-key.js
 *
 * cm#233: one-time re-key of every LIVE `open_thread` assertion row on a
 * project's own live handoff DB from the old `deriveIntentSubject`
 * derivation (colon-split-before-char-60-else-truncate-to-80, removed from
 * scripts/handoff.js in the same change that added this migration) to the
 * new `intentKey` derivation (scripts/lib/intent-key.js: NFC-normalize,
 * collapse all whitespace to single spaces, cap at 1000 UTF-8 bytes at a
 * whitespace boundary).
 *
 * NUMBERING NOTE: the cm#233 spec named this file
 * `migrate-13-intent-key.js`, but `migrate-13-agent-exchange.js` already
 * exists in this repo (shipped PR #158, predates this spec) — this file
 * uses the next free number (17; migrate-14/15/16 are also taken) instead
 * of colliding with it.
 *
 * ARCHITECTURE — this is NOT a migrate-01/02/08/09-family consolidation
 * migration (those move data INTO memory_manager_staging FROM some other
 * source, and gate their target via migrate-01's classifyTarget staging-
 * only allowlist). open_thread rows live on EACH PROJECT's own live handoff
 * DB, so this migration re-keys rows IN PLACE on whatever DB
 * scripts/handoff.js itself would connect to for that project. Accordingly:
 *
 *   - The exported `migrateIntentKeys(db, projectId, opts)` function takes
 *     an ALREADY-CONNECTED StoragePort adapter + resolved project_id — the
 *     SAME shape ensureSchemaCurrent/writeExtraction/etc. take. This is
 *     what scripts/handoff.js's `runIntentKeyMigrationIfNeeded` (wired into
 *     the `ensureSchemaCurrent` wrapper, gated on SCHEMA_EPOCH) calls
 *     directly — no subprocess, no second connection.
 *   - The CLI entry point (`require.main === module`) below connects via
 *     the SAME `connectHandoff`/`ensureProjectIdentity` composition root
 *     scripts/handoff.js's own commands use (run it from inside the target
 *     project's own working directory, exactly like `handoff:close`) —
 *     never migrate-01's classifyTarget (that resolver is for the
 *     memory_manager_staging consolidation target, not a per-project DB).
 *
 * ALGORITHM (read-only PLAN phase, then an optional WRITE phase):
 *   1. Fetch every live (suppressed=false, invalid_at IS NULL) open_thread
 *      row for the project.
 *   2. For each row, compute newKey = intentKey(row.object). A row "needs
 *      rekey" when NOT intentKeyEquals(row.subject, newKey) — deliberately
 *      a case-insensitive comparison, not a strict `!==` on the spec's
 *      literal "subject != intentKey(object)" wording: writeAssertionWith-
 *      Supersession (the SAME write path this migration re-inserts
 *      through, per the spec) always additionally applies subject-canon.js's
 *      canonicalize() (lowercase + collapse) before storing, so a strict
 *      byte comparison against the case-preserving intentKey() output would
 *      NEVER converge — every already-migrated row would look "different"
 *      forever and get re-migrated on every run, violating the spec's own
 *      "idempotent: a second --write run reports 0 changes" requirement.
 *      intentKeyEquals is the total-classification-consistent reading: the
 *      SAME equality every other cm#233 matcher (classifyResolvedThreads,
 *      dedupOpenThreadIntents) uses for "is this the same key".
 *   3. BEFORE any write: group rows by newKey using intentKeyEquals
 *      (case-insensitive) to find pre-existing collisions — two or more
 *      live rows that will now key identically. For each collision group,
 *      the WINNER is the row with the latest last_reinforced (tie-break:
 *      highest id); every row in the group (winner included) is superseded
 *      by id, and exactly ONE successor row is written (winner's object/
 *      confidence/source/session_id). Each collision group is printed,
 *      dry-run or not.
 *   4. Non-colliding rows needing a rekey: superseded by id, one successor
 *      row written with subject=newKey.
 *   5. In --dry-run (the default), steps 3/4 are computed and printed but
 *      NO UPDATE/INSERT is issued. In --write, they are applied.
 *
 * NEVER UPDATEs an existing row's `subject` column (anti-forge invariant,
 * owner comment on cm#233) — every rekey is supersede-old-row-by-id +
 * insert-new-row, mirroring the auto-retire/re-author-guard pattern used
 * throughout scripts/handoff.js.
 *
 * Usage:
 *   node scripts/migrations/migrate-17-intent-key.js [--dry-run|--write]
 *
 * Exit codes: 0 = PASS (report printed, or write applied), 1 = failure
 * (DB connection/identity resolution error).
 */

const path = require('path');
const ENGINE_ROOT = path.resolve(__dirname, '..');

const { intentKey, intentKeyEquals } = require(path.join(ENGINE_ROOT, 'lib', 'intent-key.js'));

/**
 * Read-only PLAN phase: fetch live open_thread rows and classify each as
 * NO-CHANGE-NEEDED, REKEY-SINGLE, or part of a COLLISION-GROUP. Never
 * touches the database beyond the initial SELECT.
 *
 * @param {object} db
 * @param {string} projectId
 * @returns {Promise<{
 *   singles: Array<{row:object, newKey:string}>,
 *   collisionGroups: Array<{ key:string, rows:object[], winner:object, newKey:string }>,
 *   unchangedCount: number,
 *   totalLiveCount: number,
 * }>}
 */
async function planIntentKeyMigration(db, projectId) {
  const { rows } = await db.query(
    `SELECT id, subject, object, session_id, confidence, source, last_reinforced
     FROM assertions
     WHERE project_id = $1 AND predicate = 'open_thread'
       AND suppressed = false AND invalid_at IS NULL`,
    [projectId]
  );

  const withKeys = rows.map((row) => ({ row, newKey: intentKey(row.object) }));

  // Group by newKey (case-insensitive, via intentKeyEquals) to find
  // pre-existing collisions. Linear grouping (not a Map keyed on a raw
  // string) so the comparison is EXACTLY intentKeyEquals, not an
  // independent case-folding that could disagree with it.
  const groups = []; // Array<{ newKey: string, entries: Array<{row, newKey}> }>
  for (const entry of withKeys) {
    let group = groups.find((g) => intentKeyEquals(g.newKey, entry.newKey));
    if (!group) {
      group = { newKey: entry.newKey, entries: [] };
      groups.push(group);
    }
    group.entries.push(entry);
  }

  const singles = [];
  const collisionGroups = [];
  let unchangedCount = 0;

  for (const group of groups) {
    if (group.entries.length > 1) {
      // Collision: 2+ live rows will key identically.
      const winnerEntry = group.entries.reduce((best, cur) => {
        const bestTs = best.row.last_reinforced ? new Date(best.row.last_reinforced).getTime() : 0;
        const curTs  = cur.row.last_reinforced  ? new Date(cur.row.last_reinforced).getTime()  : 0;
        if (curTs > bestTs) return cur;
        if (curTs < bestTs) return best;
        // Tie-break: highest id.
        return (Number(cur.row.id) > Number(best.row.id)) ? cur : best;
      }, group.entries[0]);
      collisionGroups.push({
        key: group.newKey,
        rows: group.entries.map((e) => e.row),
        winner: winnerEntry.row,
        newKey: winnerEntry.newKey,
      });
      continue;
    }

    const entry = group.entries[0];
    if (intentKeyEquals(entry.row.subject, entry.newKey)) {
      unchangedCount++;
    } else {
      singles.push(entry);
    }
  }

  return { singles, collisionGroups, unchangedCount, totalLiveCount: rows.length };
}

/**
 * Print the plan (dry-run or pre-write report — same format either way).
 *
 * cm#233 fix-round finding: the auto-run gate (runIntentKeyMigrationIfNeeded,
 * wired into ensureSchemaCurrent) was calling this unconditionally, so a
 * real close/checkpoint/resume printed the FULL per-row plan to STDOUT on
 * every project's first post-upgrade touch — polluting exact-stdout
 * consumers like scripts/smoketest-handoff.js's C2/C5 checks.
 *
 * @param {object} plan
 * @param {{dryRun: boolean, silent?: boolean}} opts
 *   silent=true: NO console.log at all (the auto-run path always passes
 *   this — it decides its own, separate one-line stderr summary). This
 *   mirrors how PR #225's decisions schema bring-forward silences its own
 *   apply-time logging via the SAME { silent } convention ensureSchema-
 *   Current itself already uses everywhere else in this file.
 *   silent=false (CLI default): a zero-change plan prints EXACTLY ONE
 *   summary line, never the full per-row report — only a non-empty plan
 *   gets the full breakdown.
 * @returns {string[]} lines that WOULD be/were printed, for test assertions
 *   (populated even when silent=true, so callers/tests can still inspect
 *   the plan's rendering without stdout noise).
 */
function printPlan(plan, { dryRun, silent } = {}) {
  const verb = dryRun ? 'would' : 'will';
  const lines = [];
  const log = (l) => {
    lines.push(l);
    if (!silent) console.log(l);
  };

  const changeCount = plan.singles.length + plan.collisionGroups.length;
  if (changeCount === 0) {
    log(`  intent-key migration: ${plan.totalLiveCount} open_thread row(s) scanned, 0 need rekeying.`);
    return lines;
  }

  log(`  intent-key migration plan (${dryRun ? 'DRY-RUN' : 'WRITE'}):`);
  log(`    live open_thread rows scanned: ${plan.totalLiveCount}`);
  log(`    already correctly keyed:       ${plan.unchangedCount}`);
  log(`    ${verb} rekey (no collision):    ${plan.singles.length}`);
  log(`    collision group(s):            ${plan.collisionGroups.length}`);

  for (const entry of plan.singles) {
    log(`    REKEY id=${entry.row.id} old_subject="${String(entry.row.subject).slice(0, 60)}" -> new_key="${entry.newKey.slice(0, 60)}"`);
  }
  for (const group of plan.collisionGroups) {
    log(`    COLLISION new_key="${group.newKey.slice(0, 60)}" — ${group.rows.length} live row(s): [${group.rows.map((r) => r.id).join(', ')}], winner id=${group.winner.id} (latest last_reinforced, tie-break highest id) — ${verb} supersede all ${group.rows.length}, insert 1 successor`);
  }

  return lines;
}

/**
 * WRITE phase: supersede old rows by id (never UPDATE subject) and insert
 * successor rows via writeAssertionWithSupersession (the SAME gated write
 * path payload.assertions/persistSessionIntent use).
 *
 * @returns {Promise<{changed: number, collisions: number}>}
 */
async function applyIntentKeyMigration(db, projectId, plan, registryMode, writeAssertionWithSupersession) {
  let changed = 0;

  const supersedeById = async (id) => {
    await db.query(
      `UPDATE assertions
       SET suppressed = true, invalid_at = now(), suppression_kind = 'superseded'
       WHERE id = $1 AND suppressed = false`,
      [id]
    );
  };

  for (const entry of plan.singles) {
    await supersedeById(entry.row.id);
    await writeAssertionWithSupersession(
      db, projectId,
      {
        subject: entry.newKey,
        predicate: 'open_thread',
        object: entry.row.object,
        confidence: entry.row.confidence,
        source: entry.row.source,
      },
      entry.row.session_id || null,
      registryMode
    );
    changed++;
  }

  for (const group of plan.collisionGroups) {
    for (const row of group.rows) {
      await supersedeById(row.id);
      changed++;
    }
    await writeAssertionWithSupersession(
      db, projectId,
      {
        subject: group.newKey,
        predicate: 'open_thread',
        object: group.winner.object,
        confidence: group.winner.confidence,
        source: group.winner.source,
      },
      group.winner.session_id || null,
      registryMode
    );
  }

  return { changed, collisions: plan.collisionGroups.length };
}

/**
 * Public entry point — called directly (already-connected db+projectId) by
 * BOTH the CLI wrapper below and scripts/handoff.js's
 * runIntentKeyMigrationIfNeeded (the cm#233 cutover-atomicity gate wired
 * into the ensureSchemaCurrent wrapper).
 *
 * @param {object} db          - StoragePort adapter (Postgres or SQLite).
 * @param {string} projectId
 * @param {{dryRun?: boolean, silent?: boolean, getSetting?: Function, writeAssertionWithSupersession?: Function}} [opts]
 *   dryRun defaults to TRUE (spec: "with --dry-run default"). Callers that
 *   want to actually apply must pass { dryRun: false } explicitly.
 *
 *   silent (default false): suppresses ALL of this function's own
 *   console.log output (see printPlan's header comment for the stdout-
 *   pollution finding this fixes). handoff.js's runIntentKeyMigrationIfNeeded
 *   (the auto-run-on-next-touch gate) ALWAYS passes silent:true — it never
 *   wants this function's stdout, and prints its own single stderr line
 *   only when rows actually changed. The CLI wrapper below never passes
 *   this (defaults to false: full/verbose plan output, except a zero-
 *   change plan still collapses to one summary line regardless of silent).
 *
 *   getSetting/writeAssertionWithSupersession — OPTIONAL direct function
 *   injection. handoff.js's OWN runIntentKeyMigrationIfNeeded (the cm#233
 *   cutover-atomicity gate wired into the ensureSchemaCurrent wrapper)
 *   ALWAYS passes these directly (it already has them in scope as local
 *   functions) rather than relying on the require() fallback below — when
 *   handoff.js is running as the CLI entry point itself (require.main ===
 *   module, e.g. `handoff.js close`/`checkpoint`, exactly the path that
 *   drives the auto-run-on-next-touch scenario), handoff.js's OWN
 *   `if (require.main === module) { main(); } else { module.exports = ... }`
 *   guard means its module.exports is NEVER populated — a require() of
 *   handoff.js from a lazily-required file like this one, while handoff.js
 *   is mid-execution as the main module, would return an object with
 *   neither function defined. The CLI wrapper below and any test that
 *   requires handoff.js as a plain (non-main) module are unaffected by this
 *   and may omit these — the require() fallback covers them.
 * @returns {Promise<{changed: number, collisions: number, dryRun: boolean, plan: object}>}
 */
async function migrateIntentKeys(db, projectId, opts = {}) {
  const dryRun = opts.dryRun !== false; // default true unless explicitly false
  const silent = opts.silent === true;  // default false
  const plan = await planIntentKeyMigration(db, projectId);
  printPlan(plan, { dryRun, silent });

  if (dryRun) {
    return { changed: 0, collisions: plan.collisionGroups.length, dryRun: true, plan };
  }

  let getSettingFn = opts.getSetting;
  let writeFn = opts.writeAssertionWithSupersession;
  if (!getSettingFn || !writeFn) {
    // Fallback ONLY — see the injection note above for why handoff.js's own
    // production call site never relies on this path.
    const handoffModule = require(path.join(ENGINE_ROOT, 'handoff.js'));
    getSettingFn = getSettingFn || handoffModule.getSetting;
    writeFn = writeFn || handoffModule.writeAssertionWithSupersession;
  }
  const registryMode = await getSettingFn(db, projectId, 'predicate_registry_mode', 'permissive');
  const result = await applyIntentKeyMigration(db, projectId, plan, registryMode, writeFn);

  return { changed: result.changed, collisions: result.collisions, dryRun: false, plan };
}

module.exports = {
  migrateIntentKeys,
  planIntentKeyMigration,
  printPlan,
  applyIntentKeyMigration,
};

// ─── CLI entry point ──────────────────────────────────────────────────────────
if (require.main === module) {
  (async () => {
    const args = process.argv.slice(2);
    const write = args.includes('--write');
    const dryRun = !write; // default dry-run unless --write is explicit

    const handoffModule = require(path.join(ENGINE_ROOT, 'handoff.js'));
    const { ensureProjectIdentity } = require(path.join(ENGINE_ROOT, 'lib', 'project-identity.js'));

    let db;
    try {
      db = await handoffModule.connectHandoff();
    } catch (err) {
      console.error(`migrate-17-intent-key: DB connection failed: ${err.message}`);
      process.exit(1);
    }

    let projectId;
    try {
      const identity = await ensureProjectIdentity(db, { silent: false });
      projectId = identity.projectId;
    } catch (err) {
      console.error(`migrate-17-intent-key: identity resolution failed: ${err.message}`);
      process.exit(1);
    }

    console.log(`Running: migrate-17-intent-key (${dryRun ? '--dry-run (default)' : '--write'})`);
    try {
      const result = await migrateIntentKeys(db, projectId, { dryRun });
      console.log(
        `\nDone: migrate-17-intent-key — ${dryRun ? 'DRY-RUN, nothing written' : `rekeyed ${result.changed} row(s), ${result.collisions} collision group(s) resolved`}`
      );
      process.exit(0);
    } catch (err) {
      console.error(`migrate-17-intent-key failed: ${err.message}`);
      if (process.env.DEBUG) console.error(err.stack);
      process.exit(1);
    }
  })();
}
