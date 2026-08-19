'use strict';

const AUTHORED_BY = 'sonnet-cm194-196-197-199-author-2026-08-18';

/**
 * verify-15-t5-embedding-coverage.js — T5, embedding coverage +
 * dimensionality (§15.2, S1' rewrite, cm#194).
 *
 * Every row with content-bearing text has a non-null vector of the correct
 * type (halfvec). Zero rows left at legacy vector(1024).
 *
 * REWRITE RATIONALE (cm#194, spec-adversary-amended S1'): the original
 * single-branch check (`roster.filter(hasContentBearingText===true)`, first
 * table wins via a `seen` Set) had three defects the 2026-08-16 spec-
 * adversary pass and the 2026-08-18 staging run both surfaced: (1) silent
 * skip of any table the roster falsely flags hasContentBearingText=false
 * (the `tasks` A-5 class — 138 real content-bearing rows, invisible to this
 * check); (2) SQL crash on a phantom roster `contentCol`; (3) 9 spurious
 * FAILs against migrate-07-reembed-corpus.js's Bucket C tables (decisions,
 * assertions, gotchas, findings, workflow_discovery, agent_rewrites,
 * checklist_items, incidents, tasks), which declare a multi-column COALESCE
 * content expression in migrate-07 itself and were never meant to require a
 * single-column roster `contentCol` at all.
 *
 * TABLE LIST IS IMPORTED BY REFERENCE, NEVER DUPLICATED (cm#194 point 1):
 * discoverEmbeddableTables/resolveTableContentSpec/CONTENT_EXPRESSIONS are
 * imported from migrate-07-reembed-corpus.js — verified side-effect-free at
 * require-time (no top-level DB calls, no cycle back into this file) — so
 * T5's notion of "what's embeddable" and "what a table's content is" can
 * never drift from migrate-07's own, since a change to either script's list
 * only has to happen in migrate-07.
 *
 * TOTAL CLASSIFICATION (cm#194 point 2): every member of
 * UNION(live-embeddable tables, distinct roster targetTables) lands in
 * EXACTLY one of six branches:
 *   (i)   live-embeddable + roster says content-bearing (>=1 entry
 *         hasContentBearingText=true) -> resolve + run the coverage check.
 *   (ii)  live-embeddable + NO roster content-bearing coverage + a declared
 *         migrate-07 CONTENT_EXPRESSIONS entry exists -> run the coverage
 *         check anyway (live instance: sessions), with a loud INFO line
 *         naming the absent roster coverage — this is a PINNED LEAN, not a
 *         FAIL: migrate-07 can embed this table correctly with zero roster
 *         involvement, so the coverage check itself still runs and still
 *         determines pass/fail on its own merits.
 *   (iii) live-embeddable + no roster coverage + no declared expression ->
 *         loud FAIL (genuinely unclassifiable — nothing in either script
 *         knows this table's content shape).
 *   (iv)  roster says content-bearing (>=1 entry hasContentBearingText=true)
 *         + table is NOT live-embeddable -> loud FAIL naming every such
 *         entry (the entities/retrieval_events class: a roster row claims
 *         content-bearing but the target has no vector/halfvec column at
 *         all to embed into).
 *   (v)   roster has >=1 entry with hasContentBearingText=false AND the
 *         table nonetheless IS live-embeddable, with NO true entry anywhere
 *         in the roster for it -> loud FAIL (the tasks A-5 class: a live
 *         embedding column is strong structural evidence the table is
 *         meant to hold embeddable content, so a roster row asserting
 *         "false" for such a table is itself the defect, independent of
 *         whether migrate-07 happens to have resilient coverage via a
 *         declared CONTENT_EXPRESSIONS entry). This branch is checked BEFORE
 *         branch (ii)'s declared-expression fallback, on purpose: a stale
 *         "false" claim on a live-embeddable table is a roster bug worth
 *         surfacing regardless of whether migrate-07 would embed it fine
 *         anyway.
 *   (vi)  roster has >=1 entry with hasContentBearingText=false and the
 *         table is NOT live-embeddable -> OK, one summary count line (this
 *         is the ordinary, correct "genuinely no content" case).
 * Every union member's `targetTable` and (when live-embeddable) discovered
 * `embeddingCol` are byte-exact validated against
 * shared.SAFE_IDENTIFIER_RE (^[a-z_][a-z0-9_]*$) before ANY interpolation
 * into raw SQL, and CONTENT_EXPRESSIONS lookups use Object.hasOwn (never
 * bare `obj[key]`) so a targetTable literally named "toString" or
 * "constructor" cannot resolve via an INHERITED Object.prototype property
 * instead of failing the "own property" test it should fail.
 *
 * PHANTOM-CONTENTCOL VALIDATION (cm#194 point 2(i)): EVERY roster entry
 * carrying a `contentCol`, for EVERY targetTable, regardless of that
 * entry's own hasContentBearingText flag value and regardless of whether
 * this table ends up using a roster hint at all, is validated against live
 * information_schema.columns up front — a phantom column anywhere in the
 * roster is a loud FATAL naming the exact roster row, never a silent skip
 * and never deferred until (if ever) that specific table happens to reach a
 * branch that would have used the hint.
 *
 * MERGED-ENTRY SEMANTICS (cm#194 point 3): entries are grouped by
 * targetTable via a real Map (never a `seen`-Set first-entry-wins scan,
 * and never a plain-object dictionary, which would reintroduce the exact
 * inherited-property hazard Object.hasOwn above exists to close). Multiple
 * roster entries for one targetTable are MERGED, not collapsed to the
 * first: an embeddingCol conflict (entries disagreeing on a non-null
 * embeddingCol value) is always a loud FAIL naming every entry; a
 * contentCol conflict is a loud FAIL naming every entry ONLY when this
 * table has no declared CONTENT_EXPRESSIONS entry (when one exists, it
 * always wins regardless of any roster hint, so disagreeing UNUSED hints —
 * still individually phantom-validated above — do not block classification,
 * though they remain a roster hygiene smell worth fixing). This is a
 * COLLECTED FAIL (validateMergedRosterEntries returns its error list; the
 * caller sets `failed=true` and keeps going), never a script-halting
 * FATAL — unlike validateAllContentColHints's phantom-contentCol check
 * just above, which DOES call process.exit(1), since a phantom column
 * makes every downstream query for that table unsafe to even attempt.
 *
 * Usage: node scripts/migrations/verify-15-t5-embedding-coverage.js [--db <target>]
 * Exit codes: 0 = every branch (i)/(ii) table has zero unembedded rows, zero
 * legacy-typed rows, and every branch (iii)/(iv)/(v) is empty, 1 = any gap.
 */

const shared = require('./lib/verify15-shared');
const {
  discoverEmbeddableTables,
  resolveTableContentSpec,
  CONTENT_EXPRESSIONS,
} = require('./migrate-07-reembed-corpus');

function declaredExpr(table) {
  return Object.hasOwn(CONTENT_EXPRESSIONS, table) ? CONTENT_EXPRESSIONS[table] : undefined;
}

/** Group the FULL roster (every entry, both flag values) by targetTable. */
function groupRosterByTable(roster) {
  const map = new Map();
  for (const entry of roster) {
    if (!map.has(entry.targetTable)) map.set(entry.targetTable, []);
    map.get(entry.targetTable).push(entry);
  }
  return map;
}

/**
 * Phantom-contentCol validation (point 2(i)): every roster entry with a
 * contentCol, for every table, validated against live information_schema —
 * regardless of hasContentBearingText or eventual use. Collects ALL
 * failures before exiting (never stops at the first).
 */
async function validateAllContentColHints(client, roster) {
  const errors = [];
  for (const entry of roster) {
    if (!entry.contentCol) continue;
    if (typeof entry.contentCol !== 'string' || !shared.SAFE_IDENTIFIER_RE.test(entry.contentCol)) {
      errors.push(`source_db="${entry.source_db}" source_table="${entry.source_table}" targetTable="${entry.targetTable}": contentCol="${entry.contentCol}" is not a safe SQL identifier.`);
      continue;
    }
    const exists = await shared.tableHasColumn(client, entry.targetTable, entry.contentCol);
    if (!exists) {
      errors.push(`source_db="${entry.source_db}" source_table="${entry.source_table}" targetTable="${entry.targetTable}": contentCol="${entry.contentCol}" does not exist on "${entry.targetTable}".`);
    }
  }
  if (errors.length) {
    console.error(`[T5] FATAL: ${errors.length} roster entr${errors.length === 1 ? 'y names a' : 'ies name'} phantom contentCol value(s):`);
    for (const e of errors) console.error(`  - ${e}`);
    process.exit(1);
  }
}

/**
 * Merged-entry conflict validation (point 3). embeddingCol conflicts are
 * always fatal; contentCol conflicts are fatal only for tables with no
 * declared CONTENT_EXPRESSIONS entry (a declared expression always wins, so
 * disagreeing-but-unused roster hints don't block classification).
 */
function validateMergedRosterEntries(rosterByTable) {
  const errors = [];
  for (const [table, entries] of rosterByTable) {
    const embeddingCols = [...new Set(entries.filter((e) => e.embeddingCol).map((e) => e.embeddingCol))];
    if (embeddingCols.length > 1) {
      errors.push(`targetTable="${table}": conflicting embeddingCol values across roster entries: ${embeddingCols.map((c) => `"${c}"`).join(', ')} (entries: ${entries.map((e) => `${e.source_db}/${e.source_table}`).join(', ')})`);
    }
    if (declaredExpr(table) === undefined) {
      const contentCols = [...new Set(entries.filter((e) => e.contentCol).map((e) => e.contentCol))];
      if (contentCols.length > 1) {
        errors.push(`targetTable="${table}": conflicting contentCol values across roster entries, and no declared CONTENT_EXPRESSIONS entry to arbitrate: ${contentCols.map((c) => `"${c}"`).join(', ')} (entries: ${entries.map((e) => `${e.source_db}/${e.source_table}`).join(', ')})`);
      }
    }
  }
  if (errors.length) {
    console.error(`[T5] FAIL: ${errors.length} targetTable(s) have conflicting merged roster entries:`);
    for (const e of errors) console.error(`  - ${e}`);
  }
  return errors;
}

/** Total-classify UNION(live-embeddable, roster targetTables) into branches i-vi. */
async function classifyUniverse(client, roster) {
  const live = await discoverEmbeddableTables(client); // [{table, embeddingCol, coltype}]
  const liveMap = new Map(live.map((l) => [l.table, l]));
  const rosterByTable = groupRosterByTable(roster);

  const allTables = new Set([...liveMap.keys(), ...rosterByTable.keys()]);
  const branches = { i: [], ii: [], iii: [], iv: [], v: [], vi: [] };

  for (const table of allTables) {
    shared.assertSafeIdentifier(table, 'targetTable');
    const inLive = liveMap.has(table);
    const entries = rosterByTable.get(table) || [];
    const hasCoverage = entries.some((e) => e.hasContentBearingText === true);
    const hasFalseEntry = entries.some((e) => e.hasContentBearingText === false);
    const declared = declaredExpr(table);

    if (inLive) {
      shared.assertSafeIdentifier(liveMap.get(table).embeddingCol, `embeddingCol for "${table}"`);
      if (hasCoverage) branches.i.push({ table, entries });
      else if (hasFalseEntry) branches.v.push({ table, entries });
      else if (declared !== undefined) branches.ii.push({ table, entries });
      else branches.iii.push({ table, entries });
    } else {
      // Union membership requires >=1 roster entry when NOT live-embeddable
      // (the only other way to join the union) -- so entries.length > 0 here
      // by construction, and every entry is boolean true or false, so
      // hasCoverage/hasFalseEntry are exhaustive for this branch.
      if (hasCoverage) branches.iv.push({ table, entries });
      else branches.vi.push({ table, entries });
    }
  }
  return { branches, liveMap };
}

async function checkTable(client, table, embeddingCol, expr) {
  const { rows: unembeddedRows } = await client.query(
    `SELECT COUNT(*) AS n FROM ${table}
     WHERE ${embeddingCol} IS NULL AND length(trim(${expr})) > 0`
  );
  const unembedded = Number(unembeddedRows[0].n);

  const { rows: typeRows } = await client.query(
    `SELECT format_type(a.atttypid, a.atttypmod) AS coltype
       FROM pg_attribute a
       JOIN pg_class c ON a.attrelid = c.oid
       JOIN pg_namespace n ON c.relnamespace = n.oid
      WHERE n.nspname = current_schema() AND c.relname = $1 AND a.attname = $2
        AND a.attnum > 0 AND NOT a.attisdropped`,
    [table, embeddingCol]
  );
  const colType = typeRows.length ? typeRows[0].coltype : null;
  const isHalfvec = colType !== null && colType.startsWith('halfvec');

  let legacyCount = 0;
  if (colType !== null) {
    const { rows: legacyRows } = await client.query(
      `SELECT COUNT(*) AS n FROM ${table}
       WHERE ${embeddingCol} IS NOT NULL AND pg_typeof(${embeddingCol})::text <> 'halfvec'`
    );
    legacyCount = Number(legacyRows[0].n);
  }

  return { ok: unembedded === 0 && isHalfvec && legacyCount === 0, unembedded, colType, isHalfvec, legacyCount };
}

async function runCoverageBranch(client, roster, table, embeddingCol, branchLabel) {
  let spec;
  try {
    spec = await resolveTableContentSpec(client, table, roster, () => {});
  } catch (err) {
    return { ok: false, reason: `unclassifiable: ${err.message}` };
  }
  let result;
  try {
    result = await checkTable(client, table, embeddingCol, spec.expr);
  } catch (err) {
    return { ok: false, reason: `query error: ${err.message}` };
  }
  return { ...result, spec, branchLabel };
}

async function main() {
  const argv = process.argv.slice(2);
  const { name: target, source } = shared.resolveAndClassifyTargetDb(argv);
  console.log(`verify-15-t5-embedding-coverage: target="${target}" (resolved from ${source})`);

  const roster = shared.loadRoster();
  const client = await shared.connect(target);
  let failed = false;
  try {
    await validateAllContentColHints(client, roster);

    const rosterByTable = groupRosterByTable(roster);
    const mergeErrors = validateMergedRosterEntries(rosterByTable);
    if (mergeErrors.length) failed = true;

    const { branches, liveMap } = await classifyUniverse(client, roster);
    console.log(`[T5] classification: (i)content-bearing-covered=${branches.i.length} (ii)declared-no-roster-coverage=${branches.ii.length} (iii)unclassifiable=${branches.iii.length} (iv)content-bearing-not-embeddable=${branches.iv.length} (v)false-flag-but-embeddable=${branches.v.length} (vi)false-flag-not-embeddable=${branches.vi.length}`);

    for (const { table } of branches.i) {
      const embeddingCol = liveMap.get(table).embeddingCol;
      const result = await runCoverageBranch(client, roster, table, embeddingCol, 'i');
      if (result.reason) {
        failed = true;
        console.error(`[T5] FAIL (i): ${table}: ${result.reason}`);
      } else if (!result.ok) {
        failed = true;
        console.error(`[T5] FAIL (i): ${table}: unembedded=${result.unembedded}, embeddingCol type=${result.colType ?? 'ABSENT'}, legacy vector(1024) rows=${result.legacyCount}`);
      } else {
        console.log(`[T5] OK (i): ${table}: 0 unembedded, type=${result.colType}, 0 legacy rows (content source: ${result.spec.source})`);
      }
    }

    for (const { table, entries } of branches.ii) {
      console.log(`[T5] INFO (ii): ${table}: no roster content-bearing coverage (${entries.length} roster entr${entries.length === 1 ? 'y' : 'ies'}, none hasContentBearingText=true) -- checking anyway via declared CONTENT_EXPRESSIONS (migrate-07 does not need roster coverage to embed this table).`);
      const embeddingCol = liveMap.get(table).embeddingCol;
      const result = await runCoverageBranch(client, roster, table, embeddingCol, 'ii');
      if (result.reason) {
        failed = true;
        console.error(`[T5] FAIL (ii): ${table}: ${result.reason}`);
      } else if (!result.ok) {
        failed = true;
        console.error(`[T5] FAIL (ii): ${table}: unembedded=${result.unembedded}, embeddingCol type=${result.colType ?? 'ABSENT'}, legacy vector(1024) rows=${result.legacyCount}`);
      } else {
        console.log(`[T5] OK (ii): ${table}: 0 unembedded, type=${result.colType}, 0 legacy rows (content source: declared)`);
      }
    }

    for (const { table } of branches.iii) {
      failed = true;
      console.error(`[T5] FAIL (iii): ${table}: live-embeddable, but no roster content-bearing coverage AND no declared migrate-07 CONTENT_EXPRESSIONS entry -- genuinely unclassifiable.`);
    }

    for (const { table, entries } of branches.iv) {
      failed = true;
      console.error(`[T5] FAIL (iv): ${table}: roster claims content-bearing (hasContentBearingText=true) but the target has no vector/halfvec embedding column at all:`);
      for (const e of entries.filter((e2) => e2.hasContentBearingText === true)) {
        console.error(`    - source_db="${e.source_db}" source_table="${e.source_table}"`);
      }
    }

    for (const { table, entries } of branches.v) {
      failed = true;
      console.error(`[T5] FAIL (v): ${table}: roster claims hasContentBearingText=false, but the target IS live-embeddable (has a vector/halfvec embedding column) and no roster entry claims true -- the roster flag is the defect (the tasks A-5 class):`);
      for (const e of entries.filter((e2) => e2.hasContentBearingText === false)) {
        console.error(`    - source_db="${e.source_db}" source_table="${e.source_table}"`);
      }
    }

    if (branches.vi.length) {
      console.log(`[T5] OK (vi): ${branches.vi.length} targetTable(s) correctly flagged hasContentBearingText=false with no embedding column -- not checked, by design.`);
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

module.exports = {
  AUTHORED_BY,
  groupRosterByTable,
  validateAllContentColHints,
  validateMergedRosterEntries,
  classifyUniverse,
  checkTable,
  runCoverageBranch,
};
