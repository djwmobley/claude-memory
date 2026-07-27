'use strict';

const AUTHORED_BY = 'sonnet-t-battery-author-2026-07-27';

/**
 * verify-15-t0-roster.js — T0, roster totality (§15.2, closes A-1).
 *
 * Independent source-of-truth check: every (source_db, source_table) pair in
 * scripts/migrations/source-table-roster.json MUST have at least one
 * migration_manifest row. A roster entry with ZERO manifest rows is a FAIL —
 * even a genuinely EMPTY source table still gets a migration_manifest row
 * with row_count = 0 once T1 snapshots it; only a table NEVER snapshotted at
 * all trips T0. This closes the self-referential-coverage hazard where
 * T1-T9 all key off migration_manifest's own contents: a table that never
 * gets a migrate-NN-*.js script pointed at it is invisible to every
 * downstream check unless something OUTSIDE migration_manifest itself names
 * it as in-scope.
 *
 * NOT EXISTS anti-join (never NOT IN — see this codebase's canon on the
 * NULL-poisoning trap; this particular query has no nullable column on
 * either side of the join, but the anti-join form is used uniformly across
 * this battery for consistency and to never establish a NOT IN precedent
 * a future edit could copy into a nullable context).
 *
 * SOURCELESS (net-new:) ROSTER ENTRIES — total classification, not a skip
 * (fix for the PR #152 review finding). §9/§17/§18's net-new tables
 * (routing_profiles, turn_usage, agent_exchange, …) MUST have roster
 * entries — T0-completeness's bidirectional match against
 * inventory-manifest.json and T5/T6's roster-driven target-side
 * enumeration both depend on it — but they have NO migration source: T1
 * will NEVER snapshot one, so demanding a migration_manifest row for them
 * (the ordinary T0 bar) spuriously FAILs on every real run. The roster
 * partitions into SOURCED entries (this check's ordinary bar applies) and
 * SOURCELESS entries (`source_db` shaped `net-new:<store>`, via
 * shared.partitionRoster/classifyRosterSourceDb) — SOURCELESS entries are
 * NEVER silently exempted from this script's output: they are named
 * explicitly, every run, so "sourceless" reads as a checked classification
 * on the page, not an unexplained absence.
 *
 * INVERSE DIRECTION — every non-excluded manifest pair has a roster entry
 * (closes the open gap named in this PR's own blind-spot section: a
 * forgotten roster reclassification — e.g. §18.3's future
 * migrate-12-backfill-feature-token-usage.js eventually writing real
 * migration_manifest rows under a real source_db while the roster's
 * corresponding entry still says `net-new:` — would otherwise silently
 * stop being verified by T3/T3b/T1's roster-side check forever, with zero
 * FAIL anywhere). Mirror image of the roster→manifest direction above: a
 * NOT EXISTS anti-join from a manifest-derived set against the SAME roster
 * temp table, the other way round.
 *
 * SCOPED TO excluded_reason IS NULL — deliberately, not the whole
 * migration_manifest table. Excluded manifest rows (EPHEMERAL-DROP
 * snapshots, eval-junk slices, §16.3) must remain RECORDABLE without
 * requiring roster membership: T1 has to be able to snapshot-and-exclude a
 * source that was NEVER meant to be part of the migration's real scope in
 * the first place, and demanding a roster entry for it would force
 * enrolling a deliberately-out-of-scope source into the SAME total
 * classification that names what's actually migrating — a category
 * confusion. Excluded rows' visibility already lives in T9's loop over
 * migration_manifest's own distinct excluded_reason values (§15.2) — that
 * is where an excluded source is verified, not here. A NON-excluded
 * manifest pair with no roster entry, by contrast, is a LIVE migration
 * source nothing names as in-scope — exactly the forgotten-reclassification
 * shape above, PLUS the original A-1 hazard read from the opposite
 * direction: any migrate-NN-*.js script pointed at a table nobody
 * registered in the roster.
 *
 * Usage: node scripts/migrations/verify-15-t0-roster.js [--db <target>]
 * Exit codes: 0 = PASS (every SOURCED roster entry has >=1 manifest row,
 * AND every non-excluded manifest pair has a roster entry), 1 = FAIL or
 * refused target.
 */

const shared = require('./lib/verify15-shared');

async function main() {
  const argv = process.argv.slice(2);
  const { name: target, source } = shared.resolveAndClassifyTargetDb(argv);
  console.log(`verify-15-t0-roster: target="${target}" (resolved from ${source})`);

  const roster = shared.loadRoster();
  const { sourced, sourceless } = shared.partitionRoster(roster);

  if (sourceless.length) {
    console.log(`[T0] ${sourceless.length} SOURCELESS (net-new:) roster entr${sourceless.length === 1 ? 'y' : 'ies'} — no migration source, NO migration_manifest row expected; covered instead by T5/T6's target-side checks:`);
    for (const e of sourceless) console.log(`  - ${e.source_db} -> ${e.targetTable}`);
  }

  const client = await shared.connect(target);
  let failed = false;
  try {
    await shared.applyDdl(client);

    await client.query('BEGIN');
    // Populated with SOURCED entries ONLY — sourceless (net-new:) entries'
    // source_db values (e.g. "net-new:memory_manager") can never equal a
    // REAL migration_manifest.source_db (T1 only ever connects to actual
    // database names; the net-new: shape fails the DB-name regex outright),
    // so they are irrelevant to BOTH directions' anti-joins below and are
    // deliberately left out — including them in the forward direction would
    // resurrect the exact spurious-FAIL bug the net-new: fix (PR #152)
    // exists to close; including them in the inverse direction would just
    // be dead weight, since no real manifest row could ever match one.
    // Always created, even with zero SOURCED entries -- the INVERSE
    // direction below needs a roster_t0 to anti-join against regardless.
    await client.query('CREATE TEMP TABLE roster_t0 (source_db TEXT NOT NULL, source_table TEXT NOT NULL) ON COMMIT DROP');
    for (const entry of sourced) {
      await client.query('INSERT INTO roster_t0 (source_db, source_table) VALUES ($1, $2)', [entry.source_db, entry.source_table]);
    }

    // ── Forward direction: every SOURCED roster entry has >=1 manifest row ──
    if (sourced.length === 0) {
      console.log('[T0] OK (forward): zero SOURCED roster entries — nothing to check (this is a legitimate PASS, not a skip; every roster entry is either accounted for above or has no manifest requirement).');
    } else {
      const { rows: forwardGaps } = await client.query(`
        SELECT r.source_db, r.source_table
        FROM roster_t0 r
        WHERE NOT EXISTS (
          SELECT 1 FROM migration_manifest m
          WHERE m.source_db = r.source_db AND m.source_table = r.source_table
        )
        ORDER BY r.source_db, r.source_table
      `);

      if (forwardGaps.length) {
        failed = true;
        console.error(`[T0] FAIL (forward): ${forwardGaps.length} SOURCED roster entr${forwardGaps.length === 1 ? 'y has' : 'ies have'} zero migration_manifest rows:`);
        for (const r of forwardGaps) console.error(`  - ${r.source_db} / ${r.source_table}`);
      } else {
        console.log(`[T0] OK (forward): all ${sourced.length} SOURCED roster entries have >=1 migration_manifest row.`);
      }
    }

    // ── Inverse direction: every non-excluded manifest pair has a roster
    // entry (see header comment for the excluded_reason IS NULL scoping) ──
    const { rows: inverseGaps } = await client.query(`
      SELECT DISTINCT m.source_db, m.source_table
      FROM migration_manifest m
      WHERE m.excluded_reason IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM roster_t0 r
          WHERE r.source_db = m.source_db AND r.source_table = m.source_table
        )
      ORDER BY m.source_db, m.source_table
    `);
    await client.query('COMMIT');

    if (inverseGaps.length) {
      failed = true;
      console.error(`[T0] FAIL (inverse): ${inverseGaps.length} non-excluded migration_manifest pair(s) have NO roster entry:`);
      for (const r of inverseGaps) {
        console.error(`  - ${r.source_db} / ${r.source_table} — unregistered source: roster is the total classification; if this is a newly-landed backfill source, reclassify the target's sourceless roster entry to this real source.`);
      }
    } else {
      console.log('[T0] OK (inverse): every non-excluded migration_manifest pair has a roster entry.');
    }
  } finally {
    await client.end();
  }
  process.exit(failed ? 1 : 0);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err && err.stack ? err.stack : err);
    process.exit(1);
  });
}

module.exports = { AUTHORED_BY };
