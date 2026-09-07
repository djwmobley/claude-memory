'use strict';

/**
 * backfill-embeddings.js — init-embeddability spec, "Backfill command".
 *
 * Generalizes scripts/dev/backfill-assertion-embeddings.js (assertions-only,
 * a standalone CLI script with its own DB-connect/module-resolution
 * bootstrap) into a shared library function covering BOTH `assertions` and
 * `decisions`, promoted onto the `scripts/handoff.js backfill-embeddings`
 * CLI surface (A3: "a general fix, not a one-off dev script"). The old
 * script is thinned to a pointer that requires this module directly (see
 * its own header) — this file is the ONE implementation.
 *
 * Design, per spec + adversary findings:
 *   - Dry-run by default; --apply required to write anything.
 *   - --apply refuses loudly (no writes) if the target has no
 *     `embedding_providers` row with is_default=true, or the target
 *     table(s) lack the embedding/embedded_by_provider_id columns.
 *   - Mixed-provider refusal (adversary finding #3, BLOCKER): if any
 *     already-embedded row's embedded_by_provider_id differs from the
 *     resolved default's id, --apply refuses (unless --force-mixed-provider)
 *     rather than silently mixing two incompatible embedding spaces in the
 *     same halfvec column.
 *   - The default provider is resolved ONCE per run (stamped-at-write-time
 *     semantics — a mid-run is_default flip does not change which provider
 *     id this run's rows are stamped with), mirroring
 *     backfill-assertion-embeddings.js's own documented behavior.
 *   - Batched via keyset pagination (`id > lastId`, never OFFSET) so a
 *     concurrent writer inserting new NULL rows mid-run is never skipped
 *     NOR double-processed (adversary finding T8): each row is visited at
 *     most once per run because ids only increase, and a new row inserted
 *     mid-run either falls after the current cursor (picked up later in
 *     THIS run) or, if it arrives after this run's scan has passed its id
 *     range entirely, is simply left for the next run — never silently lost.
 *   - Each UPDATE re-checks `embedding IS NULL` in its own WHERE clause
 *     (closing the gap backfill-assertion-embeddings.js:409 left open) — a
 *     row embedded by a concurrent writer between this run's SELECT and its
 *     UPDATE is left untouched, never clobbered.
 *   - Rows whose embed-text is empty/whitespace-only are excluded from the
 *     "actionable" NULL count and never fetched into a batch (adversary
 *     finding #9, MINOR) — reported as a SEPARATE, expected bucket, not
 *     conflated with genuinely pending/failed embeds.
 *   - SQLite: total-classification 4th branch — `handoff-sqlite-schema.sql`
 *     declares no `embedding` column on ANY table, so every table reports
 *     `0 embeddable rows (no embedding column on this backend)` without
 *     issuing any real query — never silence, never a BLOCK.
 */

const { resolveDefaultProvider, createProviderFromRow } = require('./embedding-provider');
const { buildEmbedText } = require('./memory-upsert');

const SUPPORTED_TABLES = ['assertions', 'decisions'];

/** Per-table SQL expression computing the embed text, trimmed, for use in a WHERE/SELECT. */
const TEXT_SQL_EXPR = {
  assertions: `coalesce(subject, '')`,
  decisions:  `(coalesce(topic, '') || ' ' || coalesce(decision, '') || ' ' || coalesce(reason, ''))`,
};

/** Per-table JS function building the exact same text embedForWrite/embedding-time callers would embed. */
const TEXT_JS_BUILDER = {
  assertions: (row) => row.subject || '',
  decisions:  (row) => buildEmbedText('decisions', row),
};

/**
 * LIVE_SQL_EXPR — E2/E4 (owner directive "READY should mean fully
 * embedded"): the "is this row still live" predicate per table, for the
 * optional `liveOnly` scoping threaded through _countsForTable/
 * _sampleSubjects/_applyTable/runBackfillEmbeddings below. `assertions`
 * carries suppressed/invalid_at; `decisions` carries neither column (no
 * suppression/invalidation concept exists for that table today), so every
 * decisions row is live by construction — `null` here means "no extra
 * filter needed," never "skip this table."
 */
const LIVE_SQL_EXPR = {
  assertions: `suppressed = false AND invalid_at IS NULL`,
  decisions:  null,
};

/** Returns an `AND <expr>` fragment (or '') for the liveOnly scoping of `table`. */
function _liveScopeSql(table, liveOnly) {
  if (!liveOnly) return '';
  const expr = LIVE_SQL_EXPR[table];
  return expr ? `AND ${expr}` : '';
}

/**
 * resolveTables — normalize the --table flag ('assertions'|'decisions'|'all')
 * into the concrete array this run processes. Total classification: any
 * other value is a usage error (caller's responsibility to validate before
 * calling this — see handoff.js's cmdBackfillEmbeddings).
 */
function resolveTables(tableFlag) {
  if (!tableFlag || tableFlag === 'all') return SUPPORTED_TABLES.slice();
  if (SUPPORTED_TABLES.includes(tableFlag)) return [tableFlag];
  throw new Error(`backfill-embeddings: unrecognized --table value "${tableFlag}" — expected one of: all, ${SUPPORTED_TABLES.join(', ')}`);
}

/**
 * _hasEmbeddingColumns — Postgres information_schema probe: does `table`
 * carry BOTH `embedding` and `embedded_by_provider_id`?
 */
async function _hasEmbeddingColumns(db, table) {
  const { rows } = await db.query(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema = current_schema() AND table_name = $1
       AND column_name IN ('embedding', 'embedded_by_provider_id')`,
    [table]
  );
  const names = new Set(rows.map((r) => r.column_name));
  return names.has('embedding') && names.has('embedded_by_provider_id');
}

/**
 * _countsForTable — dry-run / pre-apply counts for one table, scoped by an
 * optional projectId. Distinguishes "no embeddable text" (never actionable
 * — adversary finding #9) from genuinely pending rows.
 */
async function _countsForTable(db, table, projectId, liveOnly = false) {
  const textExpr = TEXT_SQL_EXPR[table];
  const scopeSql = projectId ? `AND project_id = $1` : '';
  const liveSql = _liveScopeSql(table, liveOnly);
  const params = projectId ? [projectId] : [];
  const { rows } = await db.query(
    `SELECT
       COUNT(*) FILTER (WHERE embedding IS NULL AND trim(${textExpr}) <> '')  AS actionable_null,
       COUNT(*) FILTER (WHERE embedding IS NULL AND trim(${textExpr}) = '')   AS no_text_null,
       COUNT(*) FILTER (WHERE embedding IS NOT NULL)                          AS already_embedded,
       COUNT(*)                                                                AS total
     FROM ${table}
     WHERE 1=1 ${scopeSql} ${liveSql}`,
    params
  );
  const r = rows[0];
  return {
    actionableNull: parseInt(r.actionable_null, 10),
    noTextNull: parseInt(r.no_text_null, 10),
    alreadyEmbedded: parseInt(r.already_embedded, 10),
    total: parseInt(r.total, 10),
  };
}

async function _sampleSubjects(db, table, projectId, limit, liveOnly = false) {
  const textExpr = TEXT_SQL_EXPR[table];
  const scopeSql = projectId ? `AND project_id = $1` : '';
  const liveSql = _liveScopeSql(table, liveOnly);
  const params = projectId ? [projectId, limit] : [limit];
  const limitIdx = projectId ? 2 : 1;
  const { rows } = await db.query(
    `SELECT id, ${textExpr} AS text FROM ${table}
     WHERE embedding IS NULL AND trim(${textExpr}) <> '' ${scopeSql} ${liveSql}
     ORDER BY id ASC LIMIT $${limitIdx}`,
    params
  );
  return rows.map((r) => r.text);
}

/**
 * _mixedProviderCheck — adversary finding #3 (BLOCKER). Returns
 * `{ mixed: boolean, existingProviderIds: number[] }`.
 */
async function _mixedProviderCheck(db, table, projectId, defaultProviderId) {
  const scopeSql = projectId ? `AND project_id = $1` : '';
  const params = projectId ? [projectId] : [];
  const { rows } = await db.query(
    `SELECT DISTINCT embedded_by_provider_id FROM ${table}
     WHERE embedding IS NOT NULL AND embedded_by_provider_id IS NOT NULL ${scopeSql}`,
    params
  );
  const existingProviderIds = rows.map((r) => Number(r.embedded_by_provider_id));
  const mixed = existingProviderIds.some((id) => id !== defaultProviderId);
  return { mixed, existingProviderIds };
}

/**
 * _applyTable — the actual backfill loop for one table. Keyset-paginated
 * (id > lastId), per-batch BEGIN/COMMIT, UPDATE re-checks embedding IS NULL.
 */
async function _applyTable(db, table, projectId, provider, providerId, batchSize, log, boundOpts = {}) {
  const textExpr = TEXT_SQL_EXPR[table];
  let embedded = 0, alreadyEmbedded = 0, errors = 0, lastId = 0;
  const t0 = Date.now();
  // cm#embed-heal-on-touch: optional bounds so this shared loop can also
  // serve a time/row-budgeted "heal a little on every touch" caller
  // (scripts/lib/embed-heal.js), never just the unbounded CLI backfill run.
  // Both default to unbounded (Infinity) — the pre-existing CLI behavior is
  // byte-identical when neither option is supplied.
  const rowCap     = Number.isFinite(boundOpts.rowCap) ? boundOpts.rowCap : Infinity;
  const deadlineAt = Number.isFinite(boundOpts.deadlineAt) ? boundOpts.deadlineAt : Infinity;
  const liveOnly   = !!boundOpts.liveOnly;
  const liveSql    = _liveScopeSql(table, liveOnly);
  let stopped = null; // null | 'row_cap' | 'deadline'

  for (;;) {
    if (embedded >= rowCap) { stopped = 'row_cap'; break; }
    if (Date.now() >= deadlineAt) { stopped = 'deadline'; break; }

    const thisBatchSize = Math.max(1, Math.min(batchSize, rowCap - embedded));
    const scopeSql = projectId ? `AND project_id = $2` : '';
    const limitIdx = projectId ? 3 : 2;
    const { rows: batch } = await db.query(
      `SELECT id, ${textExpr} AS text FROM ${table}
       WHERE embedding IS NULL AND trim(${textExpr}) <> '' AND id > $1 ${scopeSql} ${liveSql}
       ORDER BY id ASC LIMIT $${limitIdx}`,
      projectId ? [lastId, projectId, thisBatchSize] : [lastId, thisBatchSize]
    );
    if (batch.length === 0) break;
    lastId = batch[batch.length - 1].id;

    // Embed BEFORE opening any transaction — never hold a transaction open
    // across a network round-trip (same discipline as writeAssertionWithSupersession
    // / decisions-writer.js).
    const updates = [];
    for (const row of batch) {
      // "measure and stop between rows" (embed-heal.js spec E2 time budget):
      // checked before EACH embed call, not just between batches, so a
      // slow-responding provider can't blow past the deadline mid-batch.
      if (Date.now() >= deadlineAt) { stopped = 'deadline'; break; }
      try {
        const result = await provider.embed(row.text);
        updates.push({ id: row.id, vecLiteral: `[${result.vector.join(',')}]` });
      } catch (embedErr) {
        errors++;
        log(`  ERROR: embed failed for ${table} id=${row.id}: ${embedErr.message}`);
      }
    }
    if (updates.length === 0) { if (stopped) break; continue; }

    try {
      await db.query('BEGIN');
      for (const u of updates) {
        // Adversary-verified-safe gap closed here (backfill-assertion-embeddings.js:409
        // omitted this re-check): a row embedded by a concurrent writer
        // between our SELECT and this UPDATE is left untouched, not clobbered.
        const { rowCount } = await db.query(
          `UPDATE ${table} SET embedding = $1::halfvec, embedded_by_provider_id = $2
           WHERE id = $3 AND embedding IS NULL`,
          [u.vecLiteral, providerId, u.id]
        );
        if (rowCount === 1) embedded++;
        else alreadyEmbedded++;
      }
      await db.query('COMMIT');
    } catch (dbErr) {
      try { await db.query('ROLLBACK'); } catch (_) { /* ignore */ }
      errors++;
      log(`  ERROR: batch write failed for ${table} (rows up to id=${lastId}): ${dbErr.message}`);
    }
    if (stopped) break;
  }

  return { embedded, alreadyEmbedded, errors, elapsedMs: Date.now() - t0, stopped };
}

/**
 * runBackfillEmbeddings — the ONE implementation behind both
 * `scripts/handoff.js backfill-embeddings` and the thinned
 * scripts/dev/backfill-assertion-embeddings.js pointer.
 *
 * @param {object} opts
 * @param {object} opts.db          — connected StoragePort/pg client (`.query`, `.dialect`)
 * @param {string} [opts.projectId] — scope to one project; omitted = whole DB
 * @param {string} [opts.table]     — 'assertions'|'decisions'|'all' (default 'all')
 * @param {boolean} [opts.apply]    — perform writes (default false = dry-run)
 * @param {number} [opts.batchSize] — rows per BEGIN/COMMIT batch (default 10)
 * @param {boolean} [opts.forceMixedProvider] — bypass the mixed-provider refusal
 * @param {function} [opts.log]     — line-sink (default: no-op; caller wires console.log)
 * @param {number} [opts.rowCap]    — cm#embed-heal-on-touch: max TOTAL rows to
 *   embed across all tables THIS call (default Infinity — unbounded, the
 *   pre-existing CLI behavior). Consumed across tables in `tables` order —
 *   a cap reached partway through the first table stops before the second
 *   ever runs.
 * @param {number} [opts.deadlineAt] — cm#embed-heal-on-touch: a Date.now()-
 *   comparable epoch-ms wall-clock deadline (default Infinity — unbounded).
 *   Checked between batches AND between individual row embeds within a
 *   batch (see _applyTable) so a slow provider cannot blow past it.
 * @returns {Promise<{ ok: boolean, dryRun: boolean, refusal: object|null, tables: Array<object> }>}
 */
async function runBackfillEmbeddings(opts = {}) {
  const db = opts.db;
  const dialect = (db && db.dialect) || opts.dialect || 'postgres';
  const projectId = opts.projectId || null;
  const apply = !!opts.apply;
  const batchSize = Math.max(1, parseInt(opts.batchSize, 10) || 10);
  const forceMixedProvider = !!opts.forceMixedProvider;
  const log = typeof opts.log === 'function' ? opts.log : () => {};
  const tables = resolveTables(opts.table);
  const rowCap = Number.isFinite(opts.rowCap) ? opts.rowCap : Infinity;
  const deadlineAt = Number.isFinite(opts.deadlineAt) ? opts.deadlineAt : Infinity;
  // E2/E4 (owner directive): scope candidate rows to LIVE (suppressed=false
  // AND invalid_at IS NULL, on tables that carry those columns) -- default
  // false preserves byte-identical behavior for the pre-existing CLI/dev-
  // script callers; embed-heal.js's own calls opt in explicitly.
  const liveOnly = !!opts.liveOnly;

  // ── SQLite: total-classification 4th branch — never queries, never BLOCKs ──
  if (dialect === 'sqlite') {
    return {
      ok: true, dryRun: !apply, refusal: null,
      tables: tables.map((table) => ({
        table, dialect: 'sqlite', embeddableRows: 0,
        note: 'no embedding column on this backend',
      })),
    };
  }

  // ── Column-shape precondition (both dry-run and --apply check this; a
  //    dry-run against a table with no embedding column reports it as a
  //    distinct, named condition rather than a bare zero count) ────────────
  const columnShape = {};
  for (const table of tables) {
    columnShape[table] = await _hasEmbeddingColumns(db, table);
  }
  const missingColumnsTables = tables.filter((t) => !columnShape[t]);

  if (apply) {
    // ── --apply readiness gate: no writes at all if anything below fails ──
    if (missingColumnsTables.length > 0) {
      return {
        ok: false, dryRun: false,
        refusal: {
          reason: 'missing_embedding_columns',
          detail: `Table(s) missing embedding/embedded_by_provider_id: ${missingColumnsTables.join(', ')}. ` +
            'Bring the schema current (CREATE EXTENSION vector; then re-run handoff:init or a schema apply) before backfilling.',
        },
        tables: [],
      };
    }
    let providerRow;
    try {
      providerRow = await resolveDefaultProvider(db);
    } catch (err) {
      return {
        ok: false, dryRun: false,
        refusal: { reason: 'no_default_provider', detail: err.message },
        tables: [],
      };
    }
    const provider = createProviderFromRow(providerRow);

    // ── Mixed-provider refusal (adversary finding #3, BLOCKER) ────────────
    for (const table of tables) {
      const { mixed, existingProviderIds } = await _mixedProviderCheck(db, table, projectId, providerRow.id);
      if (mixed && !forceMixedProvider) {
        return {
          ok: false, dryRun: false,
          refusal: {
            reason: 'mixed_provider',
            detail: `Table "${table}" already has row(s) embedded by provider id(s) ${existingProviderIds.filter((id) => id !== providerRow.id).join(', ')}, ` +
              `which differ from the currently-resolved default provider id ${providerRow.id} ("${providerRow.name}"). ` +
              'Backfilling would silently mix two incompatible embedding spaces in the same column. ' +
              'Re-run with --force-mixed-provider only if you have verified this is intentional.',
          },
          tables: [],
        };
      }
    }

    const results = [];
    let totalEmbeddedSoFar = 0;
    for (const table of tables) {
      const counts = await _countsForTable(db, table, projectId, liveOnly);
      const remainingRowCap = rowCap - totalEmbeddedSoFar;
      if (remainingRowCap <= 0 || Date.now() >= deadlineAt) {
        // Budget already exhausted by an earlier table — skip this one's
        // apply entirely (never a zero-row apply call, just a bounds-only
        // report) rather than issuing a no-op batch query.
        results.push({
          table, dialect: 'postgres',
          providerId: providerRow.id, providerName: providerRow.name,
          beforeActionableNull: counts.actionableNull,
          beforeNoTextNull: counts.noTextNull,
          beforeAlreadyEmbedded: counts.alreadyEmbedded,
          embedded: 0, alreadyEmbedded: 0, errors: 0, elapsedMs: 0,
          stopped: remainingRowCap <= 0 ? 'row_cap' : 'deadline',
        });
        continue;
      }
      const applied = await _applyTable(db, table, projectId, provider, providerRow.id, batchSize, log, {
        rowCap: remainingRowCap, deadlineAt, liveOnly,
      });
      totalEmbeddedSoFar += applied.embedded;
      results.push({
        table, dialect: 'postgres',
        providerId: providerRow.id, providerName: providerRow.name,
        beforeActionableNull: counts.actionableNull,
        beforeNoTextNull: counts.noTextNull,
        beforeAlreadyEmbedded: counts.alreadyEmbedded,
        ...applied,
      });
    }
    return { ok: true, dryRun: false, refusal: null, tables: results };
  }

  // ── Dry-run: counts + up to 5 sample subjects, no writes, no provider
  //    resolution required at all (matches spec: "no `is_default` row" is
  //    only checked on --apply). ──────────────────────────────────────────
  const results = [];
  for (const table of tables) {
    if (!columnShape[table]) {
      results.push({
        table, dialect: 'postgres', embeddableRows: 0,
        note: 'embedding/embedded_by_provider_id column(s) absent on this table',
      });
      continue;
    }
    const counts = await _countsForTable(db, table, projectId, liveOnly);
    const samples = counts.actionableNull > 0 ? await _sampleSubjects(db, table, projectId, 5, liveOnly) : [];
    results.push({
      table, dialect: 'postgres',
      actionableNull: counts.actionableNull,
      noTextNull: counts.noTextNull,
      alreadyEmbedded: counts.alreadyEmbedded,
      total: counts.total,
      sampleSubjects: samples,
    });
  }
  return { ok: true, dryRun: true, refusal: null, tables: results };
}

module.exports = {
  SUPPORTED_TABLES,
  resolveTables,
  runBackfillEmbeddings,
};
