'use strict';

const AUTHORED_BY = 'sonnet-cm194-196-197-199-author-2026-08-18';

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

// Total, stated relkind classification for checkProjectIdCoverage's own
// scopedTables set (cm#199, S4' rewrite). Mirrors T0's ENUMERATED_RELKINDS
// posture: every relkind pg_class can report for a roster-scoped
// targetTable is EXPLICITLY handled, never left to fall through to a
// misleading generic message.
const PROJECT_ID_RELKIND_LABELS = {
  f: 'foreign table', t: 'TOAST table', i: 'index', S: 'sequence',
  c: 'composite type', I: 'partitioned index',
};

/**
 * Byte-exact relkind lookup for one scoped table — the SAME normalization
 * engine as shared.tableHasColumn (parameterized, case-sensitive,
 * current_schema()-scoped comparison; never a case-folded or LIKE match).
 * Returns null when the name is absent from pg_class entirely (a missing
 * object, distinct from "present but wrong kind").
 */
async function classifyScopedTableRelkind(client, table) {
  const { rows } = await client.query(
    `SELECT c.relkind FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = current_schema() AND c.relname = $1`,
    [table]
  );
  return rows.length ? rows[0].relkind : null;
}

/**
 * checkProjectIdCoverage — cm#199, S4' rewrite. Every roster-scoped
 * targetTable is total-classified by its LIVE pg_class relkind BEFORE any
 * project_id check runs, rather than treating every scopedTable identically
 * (the original bug: `v_handoff_card_inputs`, a VIEW whose underlying
 * `assertions.project_id` IS declared NOT NULL, false-FAILed because
 * PostgreSQL's information_schema.is_nullable is ALWAYS 'YES' for a view
 * column, by construction — Postgres does not propagate a base table's NOT
 * NULL constraint through a view, even a direct pass-through SELECT).
 *
 *   - 'r' (table) / 'p' (partitioned table): BASE branch — today's
 *     missing-column + is_nullable checks, UNCHANGED.
 *   - 'v' (view): VIEW branch — (a) KEEP the missing-column check (still
 *     valid: a view can genuinely omit project_id from its SELECT list);
 *     (b) SKIP is_nullable entirely (structurally meaningless for a view);
 *     (c) run a live DATA-LEVEL probe instead: COUNT(*) WHERE project_id IS
 *     NULL — nonzero is a real integrity gap, constraint or no constraint;
 *     (d) log one INFO line stating constraint-level verification is
 *     structurally unavailable for views and this probe is data-level only,
 *     so nobody reading a clean view PASS mistakes it for the same
 *     guarantee a NOT NULL constraint gives.
 *   - 'm' (materialized view): loud FAIL naming it a matview — NEVER let a
 *     matview fall through to the base branch's "missing column" message:
 *     information_schema.columns structurally EXCLUDES materialized views
 *     (the exact silent-escape shape T0's own live-table classification
 *     closes one layer up), so a naive LEFT JOIN against it would report a
 *     matview's project_id column as "missing" even when it genuinely has
 *     one — a misleading diagnosis, not just a missed one.
 *   - anything else present in pg_class ('f' foreign table, 't' TOAST,
 *     'i' index, 'S' sequence, 'c' composite type, 'I' partitioned index):
 *     loud FAIL naming the relkind — none of these are legitimate shapes
 *     for a roster-scoped targetTable.
 *   - absent from pg_class entirely: loud FAIL, missing object.
 *
 * T2's crossCheckProjectIdScope (lib/verify15-shared.js) is DELIBERATELY
 * left untouched by this rewrite: it only asserts COLUMN PRESENCE (never
 * is_nullable), which is already view-correct as written (a view either
 * selects project_id or it doesn't — presence is a real, meaningful fact
 * about a view, unlike nullability) — do not "harmonize" it with this
 * function's relkind branching; they answer different questions.
 */
async function checkProjectIdCoverage(client, roster) {
  const scopedTables = [...new Set(roster.filter((e) => e.requires_project_id_scope === true).map((e) => e.targetTable))];
  if (scopedTables.length === 0) return [];

  const gaps = [];
  for (const table of scopedTables) {
    // Every table interpolated into raw SQL below (the view branch's live
    // NULL-probe is the only one that does) is byte-exact validated first
    // -- same identifier-safety posture T5 established (shared.SAFE_IDENTIFIER_RE),
    // applied uniformly here rather than only at the one interpolation site.
    shared.assertSafeIdentifier(table, 'roster-scoped targetTable');
    const relkind = await classifyScopedTableRelkind(client, table);

    if (relkind === null) {
      gaps.push({ targetTable: table, kind: 'MISSING-OBJECT' });
      continue;
    }

    if (relkind === 'r' || relkind === 'p') {
      const { rows } = await client.query(`
        SELECT c.column_name IS NULL AS missing_column, c.is_nullable
          FROM (SELECT $1::text AS target_table) expected
          LEFT JOIN information_schema.columns c
            ON c.table_name = expected.target_table AND c.column_name = 'project_id' AND c.table_schema = current_schema()
      `, [table]);
      const r = rows[0];
      if (r.missing_column) gaps.push({ targetTable: table, kind: 'MISSING-COLUMN' });
      else if (r.is_nullable === 'YES') gaps.push({ targetTable: table, kind: 'NULLABLE', isNullable: r.is_nullable });
      continue;
    }

    if (relkind === 'v') {
      const { rows: colRows } = await client.query(
        `SELECT 1 FROM information_schema.columns WHERE table_name = $1 AND column_name = 'project_id' AND table_schema = current_schema()`,
        [table]
      );
      if (colRows.length === 0) {
        gaps.push({ targetTable: table, kind: 'MISSING-COLUMN', isView: true });
        continue;
      }
      console.log(`[T6] INFO: "${table}" is a VIEW — constraint-level (NOT NULL) verification is structurally unavailable for views (information_schema.is_nullable is always 'YES' for a view column); this check runs a data-level live probe (COUNT(*) WHERE project_id IS NULL) instead of an is_nullable check.`);
      const { rows: probeRows } = await client.query(`SELECT COUNT(*) AS n FROM ${table} WHERE project_id IS NULL`);
      const nullCount = Number(probeRows[0].n);
      if (nullCount > 0) gaps.push({ targetTable: table, kind: 'VIEW-NULL-PROBE-FAIL', nullCount });
      continue;
    }

    if (relkind === 'm') {
      gaps.push({ targetTable: table, kind: 'MATVIEW' });
      continue;
    }

    gaps.push({ targetTable: table, kind: 'UNEXPECTED-RELKIND', relkind, relkindLabel: PROJECT_ID_RELKIND_LABELS[relkind] || relkind });
  }
  return gaps;
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
      switch (g.kind) {
        case 'MISSING-OBJECT':
          console.error(`[T6] FAIL: ${g.targetTable}: missing object — not present in pg_class in this schema at all.`);
          break;
        case 'MISSING-COLUMN':
          console.error(`[T6] FAIL: ${g.targetTable}: project_id column MISSING entirely${g.isView ? ' (view)' : ''}`);
          break;
        case 'NULLABLE':
          console.error(`[T6] FAIL: ${g.targetTable}: project_id is nullable (is_nullable=${g.isNullable})`);
          break;
        case 'VIEW-NULL-PROBE-FAIL':
          console.error(`[T6] FAIL: ${g.targetTable}: view live-probe found ${g.nullCount} row(s) with project_id IS NULL.`);
          break;
        case 'MATVIEW':
          console.error(`[T6] FAIL: ${g.targetTable}: is a MATERIALIZED VIEW — information_schema.columns excludes matviews; this is a loud FAIL, never a silent "missing column".`);
          break;
        case 'UNEXPECTED-RELKIND':
          console.error(`[T6] FAIL: ${g.targetTable}: has relkind="${g.relkind}" (${g.relkindLabel}) — not a legitimate shape for a roster-scoped targetTable.`);
          break;
        default:
          console.error(`[T6] FAIL: ${g.targetTable}: ${JSON.stringify(g)}`);
      }
    }
  } else {
    console.log('[T6] OK: project_id NOT NULL holds on every roster-scoped table (base tables via constraint check, views via live NULL probe).');
  }

  process.exit(result.pass ? 0 : 1);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err && err.stack ? err.stack : err);
    process.exit(1);
  });
}

module.exports = { AUTHORED_BY, checkOrphans, checkProjectIdCoverage, classifyScopedTableRelkind, runReferentialIntegrity };
