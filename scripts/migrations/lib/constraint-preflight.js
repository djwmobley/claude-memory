'use strict';

/**
 * constraint-preflight.js
 *
 * cm#233's successor / item B follow-up (2026-09-06): catalog-driven unique-
 * constraint preflight for migrate-08-handoff-markdown.js's WRITE. The
 * DEFECT this closes: writeProjectMigration() does one plain INSERT per row
 * with no ON CONFLICT and no in-batch dedup, so a real HANDOFF-HISTORY.md
 * batch (every session re-lists its own unresolved carry-overs) violates
 * assertions_1to1_unique and assertions_1ton_exact_unique at INSERT time —
 * dry-run never caught this because it never simulated the batch against
 * either index.
 *
 * TOTAL CLASSIFICATION, NEVER AN ALLOW-LIST (adversary-amended spec): every
 * unique index on `assertions` is discovered from pg_index/pg_class at
 * RUN TIME — no predicate list, no column name, no index name is
 * hard-coded here. A newly-added unique index picked up by this file with
 * ZERO code change is the acceptance bar (see test P4 "new unique index in
 * scratch schema").
 *
 * KEY EQUALITY IS DB BYTE-EQUALITY, DELIBERATELY NOT intentKeyEquals()'s
 * runtime case-insensitivity: this preflight simulates what the live unique
 * index actually enforces (GROUP BY over the index's own key expressions,
 * evaluated by Postgres), and Postgres's own index equality is exact byte
 * comparison for TEXT/citext-less columns here. Applying a SEPARATE,
 * looser (case-insensitive) equality here would make this preflight
 * disagree with the constraint it exists to predict — it would report
 * PASS while the real INSERT still throws, or (worse) suppress a batch row
 * as "duplicate" that the live index would have happily accepted as
 * distinct. This is a considered decision, not an oversight.
 *
 * ALGORITHM (see runPreflight, the sole entry point):
 *   1. enumerateUniqueIndexes()      — pg_index/pg_get_indexdef/pg_get_expr,
 *      total: every VALID unique index on 'assertions'::regclass.
 *   2. classifyIndexApplicability()  — APPLICABLE iff every column the
 *      index's key expressions reference is a column the batch supplies
 *      (i.e. every non-`id` assertions column — the serial PK's `id` is
 *      the one column never supplied by a pre-insert batch, hence
 *      NOT_APPLICABLE for assertions_pkey without hard-coding that name).
 *   3. Batch rows load into a TEMP table shaped (assertions columns minus
 *      id) + batch_ord + session_rank, inside a transaction that is ALWAYS
 *      rolled back (never committed — read-only on the target regardless
 *      of dry-run or write mode).
 *   4. Per applicable index: simulate the post-DELETE live set (existing
 *      rows for this project_id, suppressed=false, NOT this migration's
 *      own source_model tag, UNION ALL every batch row as a suppressed=
 *      false candidate), filter by the index's own partial predicate
 *      (evaluated generically, not hard-coded), then GROUP BY the index's
 *      own key expressions. A NULL key component is EXCLUDED from grouping
 *      (Postgres treats each NULL as distinct under a unique index — unlike
 *      SQL GROUP BY, which would incorrectly merge every NULL together) and
 *      flagged instead.
 *   5. Priority classification per batch row (documented deliberately,
 *      spec text alone under-specifies the null/error interaction):
 *        collides_existing > in_batch_duplicate > unclassified > insert.
 *      unclassified is the floor for a NULL key component or a per-index
 *      evaluation error — it can only ever override 'insert', never
 *      downgrade a definitive collides_existing/in_batch_duplicate finding
 *      from a DIFFERENT, successfully-evaluated index.
 *   6. --on-duplicate=keep-newest: union-find over every in_batch_duplicate
 *      group (transitive across indexes — cm#233-style chained duplicates
 *      collapse into ONE connected component, not resolved index-by-index
 *      independently); the single newest member (by session_rank desc,
 *      then earlier document position = newer, then lowest batch_ord as a
 *      final deterministic tiebreak) survives LIVE, every other member is
 *      marked suppressed=true/suppression_kind='superseded'. The whole
 *      grouping pass is then RE-RUN over (existing UNION ALL only the
 *      now-live batch rows) — the recheck must find ZERO surviving groups,
 *      or the affected batch rows degrade to 'unclassified' (never silently
 *      "trust the algorithm").
 *
 * session_rank (P2): the section heading's parsed Session N / date decides
 * recency, NEVER document position — a real HANDOFF-HISTORY.md is
 * NEWEST-FIRST (line 1 = the highest session number), so using position as
 * the PRIMARY signal would pick the OLDEST session as "newest". Position
 * is used ONLY as the documented tiebreak WITHIN one otherwise-identical
 * session_rank. Rows sourced from --file (the active HANDOFF.md) always
 * rank newest of all, per the spec's literal instruction.
 *
 * BLIND SPOT (documented, not hidden): a row parsed from --history-file
 * whose enclosing section carries no parseable session number OR date
 * (e.g. a durable/next_step row that isn't nested under any session
 * heading in the archive — an unusual but structurally legal shape) has
 * no temporal signal at all. It is ranked as the OLDEST tier by
 * construction (never "newest", never guessed from position) so it never
 * incorrectly wins a keep-newest contest it has no real claim to.
 */

const crypto = require('crypto');

const INTEGRITY_TABLE = 'assertions';

// ─── STEP 1/2: CATALOG-DRIVEN INDEX ENUMERATION + APPLICABILITY ──────────

/**
 * enumerateUniqueIndexes — every VALID unique index on 'assertions'::regclass,
 * total (pg_index WHERE indisunique AND indisvalid), keyed ONLY by its first
 * indnkeyatts entries (INCLUDE columns are stored past indnkeyatts and are
 * never part of the uniqueness key — excluded by construction, never by
 * name).
 *
 * @param {object} tgtClient - connected pg.Client (or transaction-scoped)
 * @returns {Promise<Array<{name:string, indnkeyatts:number, keyTexts:string[], predicate:string|null}>>}
 */
async function enumerateUniqueIndexes(tgtClient) {
  const { rows } = await tgtClient.query(
    `SELECT c.relname AS name, i.indexrelid AS indexrelid, i.indrelid AS indrelid,
            i.indnkeyatts AS indnkeyatts,
            pg_get_expr(i.indpred, i.indrelid) AS predicate
       FROM pg_index i
       JOIN pg_class c ON c.oid = i.indexrelid
      WHERE i.indrelid = $1::regclass
        AND i.indisunique
        AND i.indisvalid`,
    [INTEGRITY_TABLE]
  );
  const indexes = [];
  for (const r of rows) {
    const keyTexts = [];
    for (let k = 1; k <= r.indnkeyatts; k++) {
      const { rows: defRows } = await tgtClient.query(
        `SELECT pg_get_indexdef($1::oid, $2::int, true) AS key_expr`,
        [r.indexrelid, k]
      );
      keyTexts.push(defRows[0].key_expr);
    }
    indexes.push({ name: r.name, indnkeyatts: r.indnkeyatts, keyTexts, predicate: r.predicate || null });
  }
  return indexes;
}

/**
 * allAssertionsColumns — total column list (ordinal order), used both to
 * build the batch temp table and to resolve which real columns an index
 * key expression references (word-boundary match against this authoritative
 * list — never a hard-coded column name).
 */
async function allAssertionsColumns(tgtClient) {
  const { rows } = await tgtClient.query(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = $1
      ORDER BY ordinal_position`,
    [INTEGRITY_TABLE]
  );
  return rows.map((r) => r.column_name);
}

/**
 * referencedColumns — which of `allColumns` appear as whole-word identifiers
 * inside `exprText` (e.g. "md5(object)" -> ["object"]; "project_id" ->
 * ["project_id"]). Generic text-based resolution over the CATALOG's own
 * column list (not a hard-coded name), sufficient for the plain-column and
 * simple-function-of-a-column shapes this schema's indexes use today, and
 * for any future index of the same character (documented as this
 * function's own scope, not silently assumed universal — see BLIND SPOTS
 * in the PR body for the arbitrary-expression limit).
 */
function referencedColumns(exprText, allColumns) {
  const found = [];
  for (const col of allColumns) {
    const re = new RegExp(`\\b${col.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);
    if (re.test(exprText)) found.push(col);
  }
  return found;
}

/**
 * classifyIndexApplicability — APPLICABLE iff every column referenced by
 * EVERY key expression is present in batchColumns (the columns the batch
 * temp table actually supplies: every assertions column except `id`).
 * NOT_APPLICABLE otherwise (e.g. assertions_pkey's sole key column is
 * `id`, which a pre-insert batch never supplies) — reported by index name,
 * never evaluated further.
 */
function classifyIndexApplicability(index, allColumns, batchColumns) {
  const batchSet = new Set(batchColumns);
  const missing = new Set();
  for (const keyText of index.keyTexts) {
    for (const col of referencedColumns(keyText, allColumns)) {
      if (!batchSet.has(col)) missing.add(col);
    }
  }
  return { applicable: missing.size === 0, missingColumns: Array.from(missing) };
}

// ─── STEP 3: BATCH TEMP TABLE ─────────────────────────────────────────────

function quoteIdent(name) {
  return `"${String(name).replace(/"/g, '""')}"`;
}

/**
 * createBatchTempTable — TEMP table shaped (assertions columns minus id) +
 * batch_ord + session_rank, per the spec's literal shape. Built via
 * `CREATE TEMP TABLE ... AS SELECT <cols> FROM assertions WHERE false` —
 * copies column TYPES only (no defaults, no constraints, no indexes, and
 * critically no reference to the real `id` sequence — the temp table never
 * touches assertions_id_seq, so this stays genuinely read-only/side-effect-
 * free even though it runs inside a transaction that will be rolled back).
 *
 * @returns {Promise<{tempName:string, nonIdColumns:string[]}>}
 */
async function createBatchTempTable(tgtClient, nonIdColumns, tempName) {
  const colList = nonIdColumns.map(quoteIdent).join(', ');
  await tgtClient.query(
    `CREATE TEMP TABLE ${quoteIdent(tempName)} AS SELECT ${colList} FROM ${INTEGRITY_TABLE} WHERE false`
  );
  await tgtClient.query(`ALTER TABLE ${quoteIdent(tempName)} ADD COLUMN batch_ord INT`);
  await tgtClient.query(`ALTER TABLE ${quoteIdent(tempName)} ADD COLUMN session_rank INT`);
  return { tempName, nonIdColumns };
}

async function insertBatchRows(tgtClient, tempName, nonIdColumns, rows) {
  const colList = [...nonIdColumns, 'batch_ord', 'session_rank'].map(quoteIdent).join(', ');
  let ord = 0;
  for (const row of rows) {
    ord += 1;
    const vals = nonIdColumns.map((c) => (row.values[c] === undefined ? null : row.values[c]));
    vals.push(ord, row.sessionRank);
    const placeholders = vals.map((_, i) => `$${i + 1}`).join(', ');
    await tgtClient.query(
      `INSERT INTO ${quoteIdent(tempName)} (${colList}) VALUES (${placeholders})`,
      vals
    );
  }
}

// ─── SESSION RANK (P2) ─────────────────────────────────────────────────────

/**
 * computeRankKey — {tier, dateTs, sessionNum} per row. tier 2 = --file
 * (active, newest of all); tier 1 = --history-file with a parseable
 * session number and/or date; tier 0 = --history-file with neither (the
 * documented blind spot — no temporal signal, ranked oldest).
 */
function computeRankKey(row) {
  if (row.fileKind === 'active') return { tier: 2, dateTs: NaN, sessionNum: NaN };
  const es = row.enclosingSession || null;
  const dateTs = es && es.date ? Date.parse(es.date) : NaN;
  const sessionNumRaw = es && es.sessionNum != null ? parseInt(es.sessionNum, 10) : NaN;
  const hasDate = Number.isFinite(dateTs);
  const hasNum = Number.isFinite(sessionNumRaw);
  return {
    tier: (hasDate || hasNum) ? 1 : 0,
    dateTs: hasDate ? dateTs : NaN,
    sessionNum: hasNum ? sessionNumRaw : NaN,
  };
}

function rankKeyCompare(a, b) {
  if (a.tier !== b.tier) return a.tier - b.tier;
  const ad = Number.isFinite(a.dateTs) ? a.dateTs : -Infinity;
  const bd = Number.isFinite(b.dateTs) ? b.dateTs : -Infinity;
  if (ad !== bd) return ad - bd;
  const an = Number.isFinite(a.sessionNum) ? a.sessionNum : -Infinity;
  const bn = Number.isFinite(b.sessionNum) ? b.sessionNum : -Infinity;
  return an - bn;
}

/**
 * assignSessionRanks — dense integer rank (higher = newer) per DISTINCT
 * rankKey, so every row sharing one session/file identity gets the SAME
 * session_rank. Position-level tiebreaking within one session_rank happens
 * separately (see positionKey below), never folded into this integer.
 */
function assignSessionRanks(rows) {
  const keyed = rows.map((r) => ({ row: r, key: computeRankKey(r) }));
  const uniqueKeys = [];
  const seen = new Map();
  for (const { key } of keyed) {
    const sig = `${key.tier}|${key.dateTs}|${key.sessionNum}`;
    if (!seen.has(sig)) { seen.set(sig, key); uniqueKeys.push(key); }
  }
  uniqueKeys.sort(rankKeyCompare);
  const rankOf = new Map();
  uniqueKeys.forEach((key, idx) => {
    const sig = `${key.tier}|${key.dateTs}|${key.sessionNum}`;
    rankOf.set(sig, idx);
  });
  for (const { row, key } of keyed) {
    const sig = `${key.tier}|${key.dateTs}|${key.sessionNum}`;
    row.sessionRank = rankOf.get(sig);
  }
  return rows;
}

/** positionKey — earlier (smaller) = newer, per the spec's literal tiebreak. */
function positionKey(row) {
  if (typeof row.sourceLineNo === 'number') return row.sourceLineNo;
  if (typeof row.headingLineNo === 'number') return row.headingLineNo;
  return Number.MAX_SAFE_INTEGER;
}

// ─── UNION-FIND (transitive in_batch_duplicate resolution, P2) ───────────

class UnionFind {
  constructor() { this.parent = new Map(); }
  find(x) {
    if (!this.parent.has(x)) this.parent.set(x, x);
    let root = x;
    while (this.parent.get(root) !== root) root = this.parent.get(root);
    let cur = x;
    while (this.parent.get(cur) !== root) {
      const next = this.parent.get(cur);
      this.parent.set(cur, root);
      cur = next;
    }
    return root;
  }
  union(a, b) {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent.set(ra, rb);
  }
  componentsAmong(nodes) {
    const byRoot = new Map();
    for (const n of nodes) {
      const r = this.find(n);
      if (!byRoot.has(r)) byRoot.set(r, []);
      byRoot.get(r).push(n);
    }
    return Array.from(byRoot.values());
  }
}

// ─── STEP 4/5: PER-INDEX GROUPING QUERY ───────────────────────────────────

function existingSelectSql(nonIdColumnsQuoted, sourceModelTag) {
  return `SELECT 'existing'::text AS origin, NULL::int AS batch_ord, ${nonIdColumnsQuoted.join(', ')}
            FROM ${INTEGRITY_TABLE}
           WHERE project_id = $1 AND suppressed = false AND source_model IS DISTINCT FROM $2`;
}

function batchSelectSql(nonIdColumnsQuoted, tempName, extraFilterSql) {
  return `SELECT 'batch'::text AS origin, batch_ord, ${nonIdColumnsQuoted.join(', ')}
            FROM ${quoteIdent(tempName)}
           ${extraFilterSql || ''}`;
}

/**
 * runIndexGrouping — for ONE applicable index, against the combined
 * (existing ∪ batch) simulated post-DELETE set: returns
 *   { nullKeyBatchOrds: Set<int>, groups: Array<{batchOrds:int[], hasExisting:boolean}> }
 * A row with any NULL key component (evaluated over rows satisfying the
 * partial predicate) is excluded from grouping and reported separately —
 * GROUP BY would otherwise incorrectly merge distinct NULLs together,
 * unlike the real unique index.
 *
 * `batchFilterSql` (optional) restricts which temp-table rows participate
 * (used by the P2 recheck pass to consider only the currently-LIVE batch
 * rows) — it is appended with $3 bound to the caller-supplied array.
 */
async function runIndexGrouping(tgtClient, index, nonIdColumns, tempName, projectId, sourceModelTag, batchFilterSql, batchFilterParam) {
  const nonIdColumnsQuoted = nonIdColumns.map(quoteIdent);
  const combinedSql = `${existingSelectSql(nonIdColumnsQuoted, sourceModelTag)}
                        UNION ALL
                        ${batchSelectSql(nonIdColumnsQuoted, tempName, batchFilterSql)}`;
  const keyAliases = index.keyTexts.map((_, i) => `k${i}`);
  const keyedSelect = index.keyTexts.map((t, i) => `(${t}) AS k${i}`).join(', ');
  const wherePredicate = index.predicate ? index.predicate : 'true';

  const keyedCte = `keyed AS (
    SELECT origin, batch_ord, ${keyedSelect}
      FROM combined
     WHERE ${wherePredicate}
  )`;

  const params = batchFilterParam !== undefined ? [projectId, sourceModelTag, batchFilterParam] : [projectId, sourceModelTag];

  const nullSql = `WITH combined AS (${combinedSql}), ${keyedCte}
    SELECT batch_ord FROM keyed
     WHERE origin = 'batch' AND (${keyAliases.map((k) => `${k} IS NULL`).join(' OR ')})`;
  const { rows: nullRows } = await tgtClient.query(nullSql, params);
  const nullKeyBatchOrds = new Set(nullRows.map((r) => r.batch_ord));

  const nonNullFilter = keyAliases.map((k) => `${k} IS NOT NULL`).join(' AND ') || 'true';
  const groupSql = `WITH combined AS (${combinedSql}), ${keyedCte}
    SELECT array_agg(origin) AS origins, array_agg(batch_ord) AS batch_ords, count(*) AS n
      FROM keyed
     WHERE ${nonNullFilter}
     GROUP BY ${keyAliases.join(', ')}
    HAVING count(*) > 1`;
  const { rows: groupRows } = await tgtClient.query(groupSql, params);

  const groups = groupRows.map((r) => ({
    batchOrds: r.batch_ords.filter((bo, i) => r.origins[i] === 'batch'),
    hasExisting: r.origins.includes('existing'),
    memberCount: Number(r.n),
  }));
  return { nullKeyBatchOrds, groups };
}

// ─── MAIN ENTRY POINT ──────────────────────────────────────────────────────

/**
 * runPreflight — the sole entry point (P1/P2/P3). Always runs inside a
 * transaction it ROLLS BACK itself (read-only on the target regardless of
 * caller mode). Never throws for a data-shape reason — a per-index
 * evaluation error is caught and downgrades affected rows to
 * 'unclassified' rather than aborting the whole preflight.
 *
 * @param {object} tgtClient - connected pg.Client
 * @param {object} opts
 * @param {string} opts.projectId
 * @param {string} opts.sourceModelTag
 * @param {Array<{values:object, fileKind:'active'|'history', enclosingSession:object|null, sourceLineNo:number|null, headingLineNo:number|null}>} opts.rows
 *   one entry per batch row, `values` keyed by non-id assertions column name.
 * @param {'fail'|'keep-newest'} opts.onDuplicate
 * @returns {Promise<object>} full report (see buildPreflightReport below)
 */
async function runPreflight(tgtClient, { projectId, sourceModelTag, rows, onDuplicate }) {
  await tgtClient.query('BEGIN');
  try {
    const allColumns = await allAssertionsColumns(tgtClient);
    const nonIdColumns = allColumns.filter((c) => c !== 'id');
    const indexes = await enumerateUniqueIndexes(tgtClient);
    const applicableIndexes = [];
    const notApplicableIndexes = [];
    for (const idx of indexes) {
      const { applicable, missingColumns } = classifyIndexApplicability(idx, allColumns, nonIdColumns);
      if (applicable) applicableIndexes.push(idx);
      else notApplicableIndexes.push({ name: idx.name, missingColumns });
    }

    assignSessionRanks(rows);
    const tempName = `cm08_batch_${crypto.randomBytes(6).toString('hex')}`;
    await createBatchTempTable(tgtClient, nonIdColumns, tempName);
    await insertBatchRows(tgtClient, tempName, nonIdColumns, rows.map((r) => ({ values: r.values, sessionRank: r.sessionRank })));

    // Per-row working state, 1-indexed by batch_ord (matches insert order).
    const state = rows.map((r, i) => ({
      batchOrd: i + 1,
      row: r,
      bucket: 'insert',
      hadNullOrError: false,
    }));
    const byOrd = new Map(state.map((s) => [s.batchOrd, s]));

    const perIndexErrors = [];
    const allGroupsForReport = [];
    const pureBatchEdges = []; // [batchOrd, batchOrd] pairs, for union-find

    for (const idx of applicableIndexes) {
      try {
        const { nullKeyBatchOrds, groups } = await runIndexGrouping(
          tgtClient, idx, nonIdColumns, tempName, projectId, sourceModelTag, null, undefined
        );
        for (const bo of nullKeyBatchOrds) {
          const s = byOrd.get(bo);
          if (s) s.hadNullOrError = true;
        }
        for (const g of groups) {
          allGroupsForReport.push({ index: idx.name, ...g });
          if (g.hasExisting) {
            for (const bo of g.batchOrds) {
              const s = byOrd.get(bo);
              if (s) s.bucket = 'collides_existing';
            }
          } else if (g.batchOrds.length > 1) {
            for (let i = 0; i < g.batchOrds.length; i++) {
              for (let j = i + 1; j < g.batchOrds.length; j++) {
                pureBatchEdges.push([g.batchOrds[i], g.batchOrds[j]]);
              }
            }
          }
        }
      } catch (err) {
        perIndexErrors.push({ index: idx.name, error: err.message });
        for (const s of state) {
          if (s.bucket === 'insert') s.hadNullOrError = true;
        }
      }
    }

    // Priority: collides_existing (already set) > in_batch_duplicate > unclassified > insert.
    const uf = new UnionFind();
    for (const [a, b] of pureBatchEdges) uf.union(a, b);
    const inBatchCandidates = state.filter((s) => s.bucket === 'insert');
    for (const s of inBatchCandidates) {
      const [a] = pureBatchEdges.find((e) => e.includes(s.batchOrd)) || [];
      if (a !== undefined) s.bucket = 'in_batch_duplicate';
    }
    // A row only truly belongs to an in_batch_duplicate GROUP (size>=2) once
    // collides_existing members are excluded — recompute components using
    // only currently in_batch_duplicate-bucketed rows.
    const dupOrds = state.filter((s) => s.bucket === 'in_batch_duplicate').map((s) => s.batchOrd);
    const components = uf.componentsAmong(dupOrds).filter((c) => c.length > 1);
    // Single-node "components" (an edge existed but the partner turned out
    // to be collides_existing) are not real in-batch duplicates — revert.
    const inComponent = new Set(components.flat());
    for (const s of state) {
      if (s.bucket === 'in_batch_duplicate' && !inComponent.has(s.batchOrd)) s.bucket = 'insert';
    }

    for (const s of state) {
      if (s.hadNullOrError && s.bucket === 'insert') s.bucket = 'unclassified';
    }

    let policyLiveOrds = null;
    let recheckGroups = [];
    if (onDuplicate === 'keep-newest' && components.length > 0) {
      policyLiveOrds = new Set();
      const suppressedOrds = new Set();
      for (const comp of components) {
        const ranked = comp.slice().sort((a, b) => {
          const ra = byOrd.get(a).row, rb = byOrd.get(b).row;
          if (ra.sessionRank !== rb.sessionRank) return rb.sessionRank - ra.sessionRank;
          const pa = positionKey(ra), pb = positionKey(rb);
          if (pa !== pb) return pa - pb;
          return a - b;
        });
        const newest = ranked[0];
        policyLiveOrds.add(newest);
        for (const ord of ranked.slice(1)) suppressedOrds.add(ord);
      }
      for (const ord of suppressedOrds) {
        const s = byOrd.get(ord);
        s.suppressedByPolicy = true;
        s.suppressionKind = 'superseded';
      }

      // Recheck (P2): re-run grouping restricted to only the currently-live
      // batch rows (suppressed losers excluded) -- must find zero groups,
      // else the affected rows degrade to unclassified. Reuses
      // runIndexGrouping() unchanged (never a second grouping implementation)
      // with batchFilterSql restricting the temp-table side to live batch_ord
      // values only.
      const liveFilterSql = `WHERE batch_ord = ANY($3::int[])`;
      const liveOrdsArr = state.filter((s) => !s.suppressedByPolicy).map((s) => s.batchOrd);
      for (const idx of applicableIndexes) {
        try {
          const { groups: recheckGroupRows } = await runIndexGrouping(
            tgtClient, idx, nonIdColumns, tempName, projectId, sourceModelTag, liveFilterSql, liveOrdsArr
          );
          if (recheckGroupRows.length > 0) {
            recheckGroups.push({ index: idx.name, groups: recheckGroupRows.length });
            for (const g of recheckGroupRows) {
              for (const bo of g.batchOrds) {
                const s = byOrd.get(bo);
                if (s) s.bucket = 'unclassified';
              }
            }
          }
        } catch (err) {
          recheckGroups.push({ index: idx.name, error: err.message });
          for (const ord of liveOrdsArr) {
            const s = byOrd.get(ord);
            if (s) s.bucket = 'unclassified';
          }
        }
      }
    }

    const buckets = { insert: 0, in_batch_duplicate: 0, collides_existing: 0, unclassified: 0 };
    for (const s of state) buckets[s.bucket] += 1;

    allGroupsForReport.sort((a, b) => b.memberCount - a.memberCount);
    const topGroups = allGroupsForReport.slice(0, 10).map((g) => ({
      index: g.index,
      memberCount: g.memberCount,
      hasExisting: g.hasExisting,
      sessions: g.batchOrds.map((bo) => {
        const s = byOrd.get(bo);
        return s ? { batchOrd: bo, sessionRank: s.row.sessionRank, fileKind: s.row.fileKind } : { batchOrd: bo };
      }),
    }));

    const result = {
      policy: onDuplicate,
      buckets,
      notApplicableIndexes,
      applicableIndexNames: applicableIndexes.map((i) => i.name),
      topGroups,
      perIndexErrors,
      recheckGroups,
      perRow: state.map((s) => ({
        batchOrd: s.batchOrd,
        bucket: s.bucket,
        suppressed: !!s.suppressedByPolicy,
        suppressionKind: s.suppressionKind || null,
      })),
    };
    return result;
  } finally {
    await tgtClient.query('ROLLBACK');
  }
}

module.exports = {
  enumerateUniqueIndexes,
  allAssertionsColumns,
  referencedColumns,
  classifyIndexApplicability,
  computeRankKey,
  rankKeyCompare,
  assignSessionRanks,
  positionKey,
  UnionFind,
  runIndexGrouping,
  runPreflight,
  createBatchTempTable,
  insertBatchRows,
  quoteIdent,
};
