'use strict';

const AUTHORED_BY = 'sonnet-t-battery-author-2026-07-27';

/**
 * verify-15-t6-referential-integrity.js — T6, referential integrity
 * (§15.2).
 *
 * edges.from_entity/to_entity resolve to existing entities rows;
 * memory_entry_chunks.entry_id resolves to a parent memory_entries.id;
 * project_id NOT NULL holds on every roster-scoped table.
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
  const { rows: edgeRows } = await client.query(`
    SELECT COUNT(*) AS n FROM edges e
    WHERE NOT EXISTS (SELECT 1 FROM entities x WHERE x.id = e.from_entity)
       OR NOT EXISTS (SELECT 1 FROM entities x WHERE x.id = e.to_entity)
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
