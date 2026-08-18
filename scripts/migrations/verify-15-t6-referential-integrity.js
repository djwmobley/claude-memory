'use strict';

const AUTHORED_BY = 'sonnet-t-battery-author-2026-07-27';

/**
 * verify-15-t6-referential-integrity.js — T6, referential integrity
 * (§15.2).
 *
 * edges.from_entity/to_entity resolve to existing entities rows, scoped to
 * LIVE (non-suppressed) edges only (T6-SUPPRESSION pass, 2026-08-18,
 * cm spec-adversary A-1/A-2/A-4/A-6 -- see checkOrphans' header comment):
 * a suppressed edge is a tombstone whose referents may legitimately no
 * longer exist, so it is excluded from the orphan check rather than
 * counted against it; entity existence ignores entities.suppressed (a
 * tombstone entity is still a valid referent). memory_entry_chunks.entry_id
 * resolves to a parent memory_entries.id; project_id NOT NULL holds on
 * every roster-scoped table.
 *
 * Coverage direction inverted (closes A-6): enumerates the INTENDED-scoped
 * roster FIRST (source-table-roster.json entries where
 * requires_project_id_scope === true) and asserts each targetTable BOTH has
 * a project_id column AND has it NOT NULL — a missing column on a
 * roster-scoped table is now a FAIL, not silence (the original
 * information_schema-only query only saw tables that already HAD the
 * column).
 *
 * Exported as a module (runReferentialIntegrity) so T8 (idempotency) can
 * re-run this SAME check as its own last step, per §15.2's T8 fix (closes
 * A-12: idempotency must re-verify referential integrity after a second
 * run, not just diff row hashes).
 *
 * Usage: node scripts/migrations/verify-15-t6-referential-integrity.js [--db <target>]
 * Exit codes: 0 = zero orphans and full project_id coverage, 1 = any gap.
 */

const shared = require('./lib/verify15-shared');

async function checkOrphans(client) {
  // BF-R5 (cm#188 spec-adversary pass, 2026-08-18): edges.from_entity/
  // to_entity reference entities BY NAME, not by entities.id -- the schema
  // itself documents this (scripts/sql/handoff-core-schema.sql: "from_entity
  // TEXT NOT NULL, -- entities.name (source)"). entities.id is an internal
  // SERIAL surrogate key never referenced by edges at all; joining on it
  // (the pre-fix query) is a type mismatch (integer vs text) that fails
  // outright rather than resolving anything.
  //
  // Plain `=` (not IS NOT DISTINCT FROM) is SAFE here per the PR #191
  // NULL-safe-equality classification discipline: entities.project_id/name
  // and edges.project_id/from_entity/to_entity are ALL declared TEXT NOT
  // NULL by DDL (handoff-core-schema.sql) -- NULL is structurally
  // impossible on either side of this join, so `=`'s NULL-is-unknown
  // behavior can never silently no-op it. This is the exact opposite shape
  // of T2/T9's project_id_or_null comparisons, where NULL is a real,
  // expected value that `=` would silently mishandle.
  //
  // Exact-text matching (no case-folding, no .trim()) is INTENTIONAL:
  // entities carries UNIQUE(project_id, name) (handoff-core-schema.sql),
  // so an exact-text match resolves to AT MOST ONE entities row by
  // construction. A case-insensitive or whitespace-normalized join would
  // risk silently resolving an edge to a DIFFERENT entities row than the
  // one its writer actually named.
  //
  // T6-SUPPRESSION pass (2026-08-18): A-1/A-2/A-4/A-6 (cm spec-adversary
  // pass, BINDING). The store retires rows by SUPPRESSION, never DELETE,
  // and the own-graph migration is lossless (suppressed rows migrate too).
  // A suppressed edge is therefore a TOMBSTONE whose from_entity/to_entity
  // referents may legitimately no longer exist (the entity that named them
  // may itself have been suppressed, or never migrated forward at all) --
  // scoping the orphan-edge check to LIVE (non-suppressed) edges only is
  // the correct total classification, not a narrowing of coverage: a
  // suppressed row is no longer a live claim about the graph, so an
  // unresolved referent on it is not a referential-integrity defect.
  //
  // A-1 (BLOCKING): edges.suppressed does NOT exist in
  // scripts/sql/handoff-core-schema.sql (see the CREATE TABLE above the
  // comment this replaces) and does NOT exist on any target DB that
  // predates scripts/migrations/sql/migrate-15-mcp-addenda.sql, which adds
  // it via `ALTER TABLE edges ADD COLUMN IF NOT EXISTS suppressed BOOLEAN
  // NOT NULL DEFAULT false` (mm#18/M-4). A naive `e.suppressed = false`
  // predicate would crash with "column edges.suppressed does not exist" on
  // any DB that hasn't run that addendum yet. Total classification, probed
  // BEFORE the query is built (shared.tableHasColumn, the same
  // information_schema helper T1/T2/T3/T3b/T9 already share -- never a
  // second hand-written probe):
  //   - column PRESENT  -> scoped query (live edges only, predicate below).
  //   - column ABSENT   -> check runs UNSCOPED, over every edge. This is
  //     semantically identical to "every edge defaults to non-suppressed"
  //     (the addendum's own DEFAULT false), so behavior does not change on
  //     an un-addended DB -- but it is NEVER silent: an explicit log line
  //     below states the column is absent and the check ran unscoped, so
  //     an operator reading the output is never left guessing which mode
  //     ran.
  //
  // A-2: the live-edge predicate is `e.suppressed IS DISTINCT FROM true`,
  // NEVER `e.suppressed = false` -- migrate-15-mcp-addenda.sql's `NOT NULL
  // DEFAULT false` guarantees no live row is ever actually NULL today, but
  // pinning the predicate to the safe form is still required: `= false`
  // would put a hypothetical NULL in the UNCHECKED (silent-escape) branch,
  // while `IS DISTINCT FROM true` puts it in the CHECKED (friction) branch
  // -- friction is always the safer default per this repo's total-
  // classification canon, and this predicate is correct regardless of
  // whether the NOT NULL constraint is ever weakened later. Boolean-literal
  // comparison only (`true`, not the string 'true'/'t') -- suppressed is a
  // real BOOLEAN column, never a text-encoded flag.
  //
  // A-4: entity-side semantics are UNCHANGED and PINNED here explicitly:
  // "does the referent exist" means the entities ROW EXISTS, regardless of
  // entities.suppressed. A suppressed (tombstoned) entity is still a VALID
  // referent for a live edge -- suppression retires an entity's active
  // status, not its identity, and this query has never filtered on
  // entities.suppressed (nothing below references it). Do not add such a
  // filter: doing so would make a live edge pointing at a tombstoned-but-
  // still-real entity a false orphan.
  const hasSuppressedCol = await shared.tableHasColumn(client, 'edges', 'suppressed');
  let liveEdgePredicate;
  if (hasSuppressedCol) {
    liveEdgePredicate = 'e.suppressed IS DISTINCT FROM true';
  } else {
    console.log('[T6] INFO: edges.suppressed column is ABSENT on this target (pre-migrate-15-mcp-addenda.sql schema) -- suppression scoping SKIPPED; the orphan-edge check ran UNSCOPED over every edge (equivalent to every edge defaulting to non-suppressed).');
    liveEdgePredicate = 'TRUE';
  }
  const { rows: edgeRows } = await client.query(`
    SELECT COUNT(*) AS n FROM edges e
    WHERE ${liveEdgePredicate}
      AND (
        NOT EXISTS (
          SELECT 1 FROM entities x WHERE x.project_id = e.project_id AND x.name = e.from_entity
        ) OR NOT EXISTS (
          SELECT 1 FROM entities x WHERE x.project_id = e.project_id AND x.name = e.to_entity
        )
      )
  `);
  const { rows: chunkRows } = await client.query(`
    SELECT COUNT(*) AS n FROM memory_entry_chunks c
    WHERE NOT EXISTS (SELECT 1 FROM memory_entries m WHERE m.id = c.entry_id)
  `);
  return {
    orphanEdges: Number(edgeRows[0].n),
    orphanChunks: Number(chunkRows[0].n),
  };
}

async function checkProjectIdCoverage(client, roster) {
  const scopedTables = [...new Set(roster.filter((e) => e.requires_project_id_scope === true).map((e) => e.targetTable))];
  if (scopedTables.length === 0) return [];

  const { rows } = await client.query(`
    SELECT expected.target_table,
           c.column_name IS NULL AS missing_column,
           c.is_nullable
      FROM (SELECT unnest($1::text[]) AS target_table) expected
      LEFT JOIN information_schema.columns c
        ON c.table_name = expected.target_table AND c.column_name = 'project_id' AND c.table_schema = current_schema()
     WHERE c.column_name IS NULL OR c.is_nullable = 'YES'
  `, [scopedTables]);
  return rows.map((r) => ({
    targetTable: r.target_table,
    missingColumn: r.missing_column,
    isNullable: r.is_nullable,
  }));
}

/**
 * Run the full T6 check against an already-connected client. Standalone so
 * T8 can import and re-run it as its own last step.
 */
async function runReferentialIntegrity(client, roster) {
  const { orphanEdges, orphanChunks } = await checkOrphans(client);
  const projectIdGaps = await checkProjectIdCoverage(client, roster);
  const pass = orphanEdges === 0 && orphanChunks === 0 && projectIdGaps.length === 0;
  return { pass, orphanEdges, orphanChunks, projectIdGaps };
}

async function main() {
  const argv = process.argv.slice(2);
  const { name: target, source } = shared.resolveAndClassifyTargetDb(argv);
  console.log(`verify-15-t6-referential-integrity: target="${target}" (resolved from ${source})`);

  const roster = shared.loadRoster();
  const client = await shared.connect(target);
  let result;
  try {
    result = await runReferentialIntegrity(client, roster);
  } finally {
    await client.end();
  }

  if (result.orphanEdges > 0) console.error(`[T6] FAIL: ${result.orphanEdges} orphan edge(s) (from_entity/to_entity not resolving to entities).`);
  else console.log('[T6] OK: zero orphan edges.');

  if (result.orphanChunks > 0) console.error(`[T6] FAIL: ${result.orphanChunks} orphan memory_entry_chunks row(s) (entry_id not resolving to memory_entries).`);
  else console.log('[T6] OK: zero orphan memory_entry_chunks rows.');

  if (result.projectIdGaps.length > 0) {
    for (const g of result.projectIdGaps) {
      console.error(`[T6] FAIL: ${g.targetTable}: ${g.missingColumn ? 'project_id column MISSING entirely' : `project_id is nullable (is_nullable=${g.isNullable})`}`);
    }
  } else {
    console.log('[T6] OK: project_id NOT NULL holds on every roster-scoped table.');
  }

  process.exit(result.pass ? 0 : 1);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err && err.stack ? err.stack : err);
    process.exit(1);
  });
}

module.exports = { AUTHORED_BY, checkOrphans, checkProjectIdCoverage, runReferentialIntegrity };
