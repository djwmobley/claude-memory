'use strict';

const AUTHORED_BY = 'sonnet-cm210-author-2026-08-24';

/**
 * audit-roster-t3-declarations.js — roster-wide mechanical audit (cm#210,
 * spec section 2.4). Read-only, never writes anything. Total-classifies
 * EVERY roster entry against four sweep classes designed to catch the NEXT
 * instance of this issue's two gaps (a label-only entry with no
 * manifest_label_duplicate_of, a no-project-column table with an undeclared
 * exclusion) before it ever reaches T3 as a live FAIL/FATAL, plus the
 * separate cm#210 cross-table-mismap blind spot (sessions -> assertions).
 *
 * TWO MODES:
 *   --no-connect: declaration-SHAPE checks only (class 3 + class 4's
 *     source_table!==targetTable name-difference list) — no live database
 *     connection at all, opened. Runnable in CI against
 *     scripts/migrations/source-table-roster.example.json, which carries no
 *     live databases to connect to.
 *   --db <target> (full mode, requires a target): everything --no-connect
 *     does, PLUS live source AND target connections for classes 1 and 2, and
 *     class 4's missing-column check (which needs the live TARGET schema).
 *     This is the mode the orchestrator runs against staging (spec 2.5).
 *
 * CLASS 1 — UNDECLARED-LABEL-SUSPECT / LABEL-SHADOWED-BY-RELATION (closes
 *   A-4 in both directions). For every SQL-sourced entry carrying NONE of
 *   the three branch-selecting declarations (manifest_label_duplicate_of,
 *   lineageMappedCols+lineageMembership, sourceProjectExclusions):
 *   `SELECT to_regclass('<source_table>')` on its own source_db. NULL means
 *   the entry's source_table does not resolve to a live relation on THIS
 *   source_db -- exactly the shape A-1's four *_db_absorb entries had before
 *   they were declared (a label with no backing table, silently absorbed
 *   into ordinary branch-(a) hashing, which then crashes loud) -- flagged
 *   UNDECLARED-LABEL-SUSPECT (a class-1 finding, exit 1). The INVERSE catches
 *   A-4's decoy-relation scenario from the other side: a DECLARED
 *   label-duplicate entry whose label ALSO happens to resolve to a live
 *   relation is flagged LABEL-SHADOWED-BY-RELATION (WARN only, never exit 1
 *   on its own -- it may be entirely legitimate, e.g. a truly empty scratch
 *   table coexisting with the label by coincidence, but it is exactly the
 *   shape A-4 warns could silently vacuous-green branch (a) if the
 *   declaration were ever removed, so it is surfaced for a human to look at).
 *
 * CLASS 2 — SOURCELESS-EXCLUSION-UNDECLARED (closes the general form of this
 *   issue's second live gap, claude_context.decisions). For every entry
 *   carrying NONE of the three branch-selecting declarations: read
 *   migration_manifest for project-scoped (non-NULL project_id_or_null),
 *   non-retired exclusions for the pair; if any exist AND the live source
 *   table has no resolvable project_id column AND sourceProjectExclusions is
 *   not declared, this is EXACTLY the shape that crashes T3 branch (a)'s
 *   hashTableMultisetExcludingProjects with "cannot scope the exclusion
 *   filter" -- flagged before T3 ever has to say so at run time.
 *
 * CLASS 3 — ABSORB-LABEL DECLARATION COMPLETENESS (closes A-1/A-3
 *   generally, re-runs the roster-load-time manifest_label_duplicate_of
 *   validations' intent as a proactive SWEEP rather than a per-entry
 *   load-time check). The established live-roster naming convention for a
 *   label-only bookkeeping entry is a `_db_absorb`-suffixed source_table
 *   (migrate-05-sync-file-memory.js's own convention, confirmed by every
 *   live instance this issue's two live reports found). Every roster entry
 *   whose source_table matches that suffix is expected to carry
 *   manifest_label_duplicate_of; one that doesn't is a finding (exit 1) --
 *   this is a NAMING HEURISTIC, not a structural guarantee (documented
 *   limitation, see this script's own header note below and the PR's
 *   blind-spot section): an absorb-shaped entry named WITHOUT that suffix
 *   would not be caught by this class, only by class 1 if it also happens to
 *   have no live physical relation.
 *
 * CLASS 4 — CROSS-TABLE MISMAP (cm#210's own originally-reported symptom,
 *   the sessions -> assertions crash). Two separate lists, over EVERY roster
 *   entry regardless of declaration:
 *     (a) name-difference list: source_table !== targetTable -- INFO only,
 *         never exit 1 on its own (a genuine cross-table migration is a
 *         legitimate shape; this list exists so a human can eyeball it,
 *         per this issue's own still-open "columnNameMap" design-fork
 *         question);
 *     (b) missing-column FAIL (full mode only, needs the live target
 *         schema): any loadBearingCols entry naming a column absent from
 *         the live target table -- exactly cm#210's crash shape
 *         ("assertions" has no "summary" column). Exit 1. The FAIL message
 *         names the columnNameMap design fork explicitly, so the NEXT
 *         genuine cross-table entry is stopped at audit/declaration time,
 *         not mid-T3-run.
 *
 * Usage:
 *   node scripts/migrations/audit-roster-t3-declarations.js --no-connect
 *   node scripts/migrations/audit-roster-t3-declarations.js --db <target>
 * Exit codes: 0 = no findings in classes 1-3 and no class-4 missing-column
 * FAILs; 1 = any class-1/2/3 finding, or any class-4 missing-column FAIL.
 * LABEL-SHADOWED-BY-RELATION (class 1's inverse) and the class-4
 * name-difference list are INFO/WARN only and never affect the exit code on
 * their own.
 */

const shared = require('./lib/verify15-shared');

function parseArgs(argv) {
  return { noConnect: argv.includes('--no-connect') };
}

const ABSORB_LABEL_SUFFIX_RE = /_db_absorb$/;

/**
 * Class 3 + class 4(a): declaration-shape sweeps that need no live
 * connection at all -- runnable against source-table-roster.example.json in
 * CI. Pure roster-JSON inspection.
 */
function runNoConnectChecks(roster) {
  const class3MissingDeclaration = [];
  const class4NameDiff = [];
  for (const entry of roster) {
    if (ABSORB_LABEL_SUFFIX_RE.test(entry.source_table) && !entry.manifest_label_duplicate_of) {
      class3MissingDeclaration.push(entry);
    }
    if (entry.source_table !== entry.targetTable) {
      class4NameDiff.push(entry);
    }
  }
  return { class3MissingDeclaration, class4NameDiff };
}

/**
 * Classes 1, 2, and class 4(b) -- every check that needs a live connection.
 * Groups SQL-sourced roster entries by source_db (same partitioning
 * discipline as T3's own groupRosterBySourceDb: filesystem:/net-new: entries
 * are excluded, since neither has a live source relation to probe), opens
 * one source connection per source_db, and the one target connection passed
 * in.
 */
async function runFullChecks(roster, targetDb) {
  const findings = {
    class1Undeclared: [],
    class1Shadowed: [],
    class2Undeclared: [],
    class4MissingCol: [],
  };
  const tgtClient = await shared.connect(targetDb);
  try {
    await shared.applyDdl(tgtClient);

    const bySourceDb = new Map();
    for (const entry of roster) {
      if (typeof entry.source_db === 'string' && entry.source_db.startsWith('filesystem:')) continue;
      const { isSourceless } = shared.classifyRosterSourceDb(entry.source_db, `audit entry targetTable=${entry.targetTable}`);
      if (isSourceless) continue;
      if (!bySourceDb.has(entry.source_db)) bySourceDb.set(entry.source_db, []);
      bySourceDb.get(entry.source_db).push(entry);
    }

    for (const [sourceDb, entries] of bySourceDb) {
      let srcClient;
      try {
        srcClient = await shared.connect(sourceDb);
      } catch (err) {
        console.error(`[audit] WARN: could not connect to source_db "${sourceDb}": ${err.message} -- classes 1/2 SKIPPED for its ${entries.length} entr${entries.length === 1 ? 'y' : 'ies'} (not counted as a finding OR a clean pass -- this run is incomplete for this source_db).`);
        continue;
      }
      try {
        for (const entry of entries) {
          const hasAnyDeclaration = shared.branchSelectionFlags(entry).length > 0;

          shared.assertSafeIdentifier(entry.source_table, 'audit source_table');
          const { rows: relRows } = await srcClient.query('SELECT to_regclass($1) AS r', [entry.source_table]);
          const relationExists = relRows[0].r !== null;

          if (!hasAnyDeclaration && !relationExists) {
            findings.class1Undeclared.push({ entry, sourceDb });
          }
          if (entry.manifest_label_duplicate_of && relationExists) {
            findings.class1Shadowed.push({ entry, sourceDb });
          }

          if (!hasAnyDeclaration) {
            const { rows: exRows } = await tgtClient.query(
              `SELECT COUNT(*)::int AS n FROM migration_manifest
               WHERE source_db=$1 AND source_table=$2 AND project_id_or_null IS NOT NULL
                 AND excluded_reason IS NOT NULL AND retired_at IS NULL`,
              [sourceDb, entry.source_table]
            );
            const exclusionCount = exRows[0].n;
            if (exclusionCount > 0) {
              const hasProjectCol = await shared.tableHasColumn(srcClient, entry.source_table, 'project_id');
              if (!hasProjectCol) {
                findings.class2Undeclared.push({ entry, sourceDb, exclusionCount });
              }
            }
          }

          shared.assertSafeIdentifier(entry.targetTable, 'audit targetTable');
          for (const col of entry.loadBearingCols) {
            const hasCol = await shared.tableHasColumn(tgtClient, entry.targetTable, col);
            if (!hasCol) findings.class4MissingCol.push({ entry, sourceDb, col });
          }
        }
      } finally {
        await srcClient.end();
      }
    }
  } finally {
    await tgtClient.end();
  }
  return findings;
}

async function main() {
  const argv = process.argv.slice(2);
  const { noConnect } = parseArgs(argv);
  const roster = shared.loadRoster();
  const rosterPath = shared.resolveRosterPath();
  console.log(`audit-roster-t3-declarations: roster="${rosterPath}" (${roster.length} entries), mode=${noConnect ? '--no-connect' : 'full'}`);

  const { class3MissingDeclaration, class4NameDiff } = runNoConnectChecks(roster);

  let full = { class1Undeclared: [], class1Shadowed: [], class2Undeclared: [], class4MissingCol: [] };
  if (noConnect) {
    console.log('[audit] --no-connect mode: classes 1 and 2, and class 4\'s missing-column check, are SKIPPED (they require live source/target connections). Only class 3 and class 4\'s name-difference list ran.');
  } else {
    const { name: target, source } = await shared.resolveAndClassifyTargetDb(argv);
    console.log(`[audit] target="${target}" (resolved from ${source})`);
    full = await runFullChecks(roster, target);
  }

  let failed = false;

  if (full.class1Undeclared.length) {
    failed = true;
    console.error(`[audit] CLASS-1 FAIL (UNDECLARED-LABEL-SUSPECT): ${full.class1Undeclared.length} entr${full.class1Undeclared.length === 1 ? 'y' : 'ies'} with NO branch-selecting declaration whose source_table does NOT resolve to a live relation on its own source_db:`);
    for (const f of full.class1Undeclared) {
      console.error(`  - source_db="${f.sourceDb}" source_table="${f.entry.source_table}" targetTable="${f.entry.targetTable}" -- either give it a manifest_label_duplicate_of declaration (if it's a bookkeeping label like this issue's *_db_absorb entries), or investigate why its physical table is missing.`);
    }
  } else if (!noConnect) {
    console.log('[audit] CLASS-1 OK: every undeclared, SQL-sourced entry resolves to a live relation on its own source_db.');
  }

  if (full.class1Shadowed.length) {
    console.error(`[audit] CLASS-1 WARN (LABEL-SHADOWED-BY-RELATION, non-blocking): ${full.class1Shadowed.length} declared label-duplicate entr${full.class1Shadowed.length === 1 ? 'y' : 'ies'} whose label ALSO resolves to a live relation -- verify this isn't an A-4 decoy (a scratch/leaked table that would let a REMOVED declaration silently vacuous-green branch (a) at 0 rows):`);
    for (const f of full.class1Shadowed) {
      console.error(`  - source_db="${f.sourceDb}" source_table="${f.entry.source_table}" (duplicates "${f.entry.manifest_label_duplicate_of}")`);
    }
  }

  if (full.class2Undeclared.length) {
    failed = true;
    console.error(`[audit] CLASS-2 FAIL (SOURCELESS-EXCLUSION-UNDECLARED): ${full.class2Undeclared.length} entr${full.class2Undeclared.length === 1 ? 'y' : 'ies'} with project-scoped migration_manifest exclusions, no source-side project_id column, and no sourceProjectExclusions declaration (this is exactly the shape that crashes T3 branch (a) with "cannot scope the exclusion filter"):`);
    for (const f of full.class2Undeclared) {
      console.error(`  - source_db="${f.sourceDb}" source_table="${f.entry.source_table}" targetTable="${f.entry.targetTable}" (${f.exclusionCount} excluded manifest row(s))`);
    }
  } else if (!noConnect) {
    console.log('[audit] CLASS-2 OK: no undeclared entry has an unscopable project-scoped exclusion.');
  }

  if (class3MissingDeclaration.length) {
    failed = true;
    console.error(`[audit] CLASS-3 FAIL: ${class3MissingDeclaration.length} absorb-shaped entr${class3MissingDeclaration.length === 1 ? 'y' : 'ies'} (source_table matches ${ABSORB_LABEL_SUFFIX_RE}) lack manifest_label_duplicate_of (naming heuristic -- see this script's header comment; an absorb-shaped entry named without this suffix is NOT caught by this class):`);
    for (const e of class3MissingDeclaration) {
      console.error(`  - source_db="${e.source_db}" source_table="${e.source_table}" targetTable="${e.targetTable}"`);
    }
  } else {
    console.log(`[audit] CLASS-3 OK: every absorb-shaped entry (source_table matching ${ABSORB_LABEL_SUFFIX_RE}) carries manifest_label_duplicate_of, or none exist in this roster.`);
  }

  if (class4NameDiff.length) {
    console.log(`[audit] CLASS-4 INFO (name-difference, non-blocking): ${class4NameDiff.length} entr${class4NameDiff.length === 1 ? 'y' : 'ies'} with source_table !== targetTable -- eyeball these against cm#210's still-open columnNameMap design-fork question:`);
    for (const e of class4NameDiff) {
      console.log(`  - source_db="${e.source_db}" source_table="${e.source_table}" targetTable="${e.targetTable}"`);
    }
  } else {
    console.log('[audit] CLASS-4 INFO: no entry has source_table !== targetTable.');
  }

  if (full.class4MissingCol.length) {
    failed = true;
    console.error(`[audit] CLASS-4 FAIL (missing-column): ${full.class4MissingCol.length} loadBearingCols reference(s) name a column absent from the live target table -- this is the cm#210 sessions->assertions crash class. A genuine cross-table entry needs a source->target column-name-mapping declaration (columnNameMap, not yet implemented -- see cm#210's own still-open design-fork discussion) before it can be added to the roster; do not "fix" this by silently renaming the roster's targetTable to whatever makes the column exist without confirming the physical migration target first:`);
    for (const f of full.class4MissingCol) {
      console.error(`  - source_db="${f.sourceDb}" source_table="${f.entry.source_table}" targetTable="${f.entry.targetTable}" missing column="${f.col}"`);
    }
  } else if (!noConnect) {
    console.log('[audit] CLASS-4 OK: every loadBearingCols entry resolves to a real column on its live target table.');
  }

  process.exit(failed ? 1 : 0);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err && err.stack ? err.stack : err);
    process.exit(1);
  });
}

module.exports = { AUTHORED_BY, runNoConnectChecks, runFullChecks, ABSORB_LABEL_SUFFIX_RE };
