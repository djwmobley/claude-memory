'use strict';

/**
 * embed-heal.js — categorical fix for "assertion/decision rows written by a
 * writer that bypasses write-time embed accumulate as a silent NULL
 * backlog while status still reports embedding: READY".
 *
 * Point-fix history this replaces: two manual `backfill-embeddings --apply`
 * runs on two separate live projects (pipeline_pwa_etl 4710 rows from
 * migrate-08's bulk import, pipeline_judge 2 rows from a live-session write
 * that bypassed write-time embed) on two consecutive days. PR #260 added
 * write-time embed only to the close/checkpoint writer
 * (writeAssertionWithSupersession / decisions-writer.js) — every OTHER
 * writer (bulk migrations, and — until this PR — entity-graph-crud.js's
 * assertionUpdate) still leaves embedding NULL at write time. This module
 * is the drain: run a little, on every touch, regardless of which writer
 * left the NULL rows behind.
 *
 * Design:
 *   - Reuses backfill-embeddings.js's runBackfillEmbeddings — the ONE
 *     embedding-write implementation — via its new opts.rowCap/opts.deadlineAt
 *     bounds (added alongside this file), never a second embed-loop.
 *   - Fail-soft, TOTAL classification of the outcome on every exit:
 *     healed | partial | disabled | provider_unready | error:<short>.
 *     Recorded to project_settings.last_embed_heal = {ts, embedded,
 *     remaining, outcome, ...}. NEVER throws, NEVER changes the caller's
 *     exit code — a failure here degrades to "rows stay NULL, try again
 *     next touch", exactly like every other embed-write failure in this
 *     engine (write-time-embed.js's own header documents the same posture).
 *   - Bounded to `embed_heal_batch` rows (project_settings, default 250;
 *     0 disables) AND a 2-second wall-clock budget per touch — checked
 *     between batches AND between individual row embeds (see
 *     backfill-embeddings.js's _applyTable) so a slow/degraded provider
 *     can't turn a routine touch into a multi-second stall.
 *   - Runs under a non-blocking Postgres advisory lock in a DIFFERENT
 *     namespace (44) from the schema-apply lock (db-seam.js uses 43) so
 *     concurrent touches never double-embed the same rows; losing the race
 *     is not an error — it reports 'partial' and the next touch tries
 *     again (each backfill UPDATE re-checks `embedding IS NULL` in its own
 *     WHERE clause regardless, so double-embedding was never possible even
 *     without this lock — the lock exists to avoid wasted duplicate work,
 *     not for correctness).
 *
 * Callers: scripts/handoff.js's ensureSchemaCurrent wrapper (the shared
 * status+resume+every-other-touch entry point), invoked AFTER schema is
 * confirmed healed ('current'/'applied') — mirrors runIntentKeyMigrationIfNeeded's
 * placement immediately above it in that same file.
 */

const { runBackfillEmbeddings } = require('./backfill-embeddings.js');
const { resolveDefaultProvider, createProviderFromRow, probeProvider } = require('./embedding-provider.js');

const EMBED_HEAL_BATCH_SETTING_KEY = 'embed_heal_batch';
const LAST_EMBED_HEAL_SETTING_KEY = 'last_embed_heal';
const DEFAULT_BATCH_PER_TOUCH = 250;
const TIME_BUDGET_MS = 2000;
// Advisory-lock namespace — deliberately NOT db-seam.js's 43 (schema-apply):
// a heal touch must never contend with, or be blocked behind, a schema
// apply, and vice versa. hashtext(lockKey) keeps different projectIds'
// heals independent within this namespace, same convention as db-seam.js's
// own acquireSchemaApplyLock.
const LOCK_NAMESPACE = 44;

function _short(msg) {
  return String(msg || 'unknown').replace(/\s+/g, ' ').trim().slice(0, 160);
}

async function _setSetting(db, projectId, key, value) {
  await db.query(
    `INSERT INTO project_settings (project_id, key, value) VALUES ($1, $2, $3)
     ON CONFLICT (project_id, key) DO UPDATE SET value = EXCLUDED.value`,
    [projectId, key, value]
  );
}

async function _getSetting(db, projectId, key) {
  const { rows } = await db.query(
    'SELECT value FROM project_settings WHERE project_id = $1 AND key = $2',
    [projectId, key]
  );
  return rows.length > 0 ? rows[0].value : null;
}

/** Persist last_embed_heal (best-effort — a failure here is itself swallowed, never re-thrown). */
async function _recordOutcome(db, projectId, outcome, embedded, remaining, extra, silent) {
  const record = { ts: new Date().toISOString(), embedded, remaining, outcome, ...(extra || {}) };
  try {
    await _setSetting(db, projectId, LAST_EMBED_HEAL_SETTING_KEY, JSON.stringify(record));
  } catch (err) {
    if (!silent) {
      process.stderr.write(`[handoff] embed-heal: failed to record last_embed_heal (non-fatal): ${err.message}\n`);
    }
  }
  return record;
}

/**
 * runEmbedHealIfNeeded — TOTAL classification, fail-soft, bounded heal of
 * the assertions/decisions embedding NULL backlog for one project, run once
 * per touch of the shared ensureSchemaCurrent path.
 *
 * @param {object} db          — connected StoragePort/pg adapter
 * @param {string} projectId
 * @param {object} [opts]
 * @param {boolean} [opts.silent] — suppress stderr informational output
 * @returns {Promise<object|null>} the persisted last_embed_heal record, or
 *   `null` on the SQLite / no-embedding-column branch (nothing recorded —
 *   mirrors computeEmbeddingReadiness's own 'UNSUPPORTED:sqlite' verdict,
 *   which likewise records nothing).
 */
async function runEmbedHealIfNeeded(db, projectId, opts = {}) {
  const silent = !!opts.silent;
  try {
    // Branch 0: backend has no embedding column at all (SQLite) — never
    // query, never record. Matches backfill-embeddings.js's own SQLite
    // total-classification branch.
    if (db && typeof db.supportsEmbeddingColumns === 'function' && !db.supportsEmbeddingColumns()) {
      return null;
    }

    // E4 (owner directive "READY should mean fully embedded"): opt-out
    // checked FIRST, before touching any row — an operator who ran `init
    // --no-embeddings` gets outcome 'disabled' with NO row-touching work
    // whatsoever (no dry-run count, no lock, no provider resolve/probe).
    // Lazy require of handoff.js's isEmbeddingsOptedOut: handoff.js
    // requires this module at its own top level, so a top-of-file require
    // here would be circular and see handoff.js's module.exports mid-
    // construction (empty). Safe as a lazy, in-function require because
    // runEmbedHealIfNeeded only ever executes at runtime, long after both
    // modules have finished loading and handoff.js's module.exports is
    // fully populated.
    try {
      const { isEmbeddingsOptedOut } = require('../handoff.js');
      if (typeof isEmbeddingsOptedOut === 'function' && await isEmbeddingsOptedOut(db, projectId)) {
        return await _recordOutcome(db, projectId, 'disabled', 0, null, { reason: 'embeddings_opt_out' }, silent);
      }
    } catch (_) {
      // If the opt-out probe itself fails for any reason, do not block
      // healing on it — fall through to the normal branches below (a
      // genuine DB error will surface again, loudly, in the very next
      // branch's own setting read).
    }

    const startedAt = Date.now();
    const deadlineAt = startedAt + TIME_BUDGET_MS;

    // Branch: setting read failure — DB error, record and bail.
    let batch;
    try {
      const raw = await _getSetting(db, projectId, EMBED_HEAL_BATCH_SETTING_KEY);
      batch = raw == null ? DEFAULT_BATCH_PER_TOUCH : parseInt(raw, 10);
      if (!Number.isFinite(batch)) batch = DEFAULT_BATCH_PER_TOUCH;
    } catch (err) {
      return await _recordOutcome(db, projectId, `error:${_short(err.message)}`, 0, null, {}, silent);
    }

    // Branch: disabled via project_settings.embed_heal_batch = 0 (or lower).
    if (batch <= 0) {
      return await _recordOutcome(db, projectId, 'disabled', 0, null, { reason: 'embed_heal_batch<=0' }, silent);
    }

    // Cheap dry-run count first — no lock, no provider probe/network call —
    // on the common "nothing to heal" touch (the overwhelming majority).
    let dry;
    try {
      dry = await runBackfillEmbeddings({ db, projectId, table: 'all', apply: false, liveOnly: true });
    } catch (err) {
      return await _recordOutcome(db, projectId, `error:${_short(err.message)}`, 0, null, {}, silent);
    }
    const actionableTotal = (dry.tables || []).reduce((sum, t) => sum + (t.actionableNull || 0), 0);
    if (actionableTotal === 0) {
      return await _recordOutcome(db, projectId, 'healed', 0, 0, {}, silent);
    }

    // Non-blocking advisory lock — a touch that loses the race reports
    // 'partial' rather than waiting; the next touch tries again.
    const lockKey = 'embed_heal:' + projectId;
    let lockHeld = false;
    try {
      const { rows } = await db.query('SELECT pg_try_advisory_lock(hashtext($1), $2) AS locked', [lockKey, LOCK_NAMESPACE]);
      lockHeld = !!(rows[0] && (rows[0].locked === true || rows[0].locked === 't'));
    } catch (err) {
      return await _recordOutcome(db, projectId, `error:${_short(err.message)}`, 0, actionableTotal, {}, silent);
    }
    if (!lockHeld) {
      return await _recordOutcome(db, projectId, 'partial', 0, actionableTotal, { reason: 'concurrent_heal_in_progress' }, silent);
    }

    try {
      if (Date.now() >= deadlineAt) {
        return await _recordOutcome(db, projectId, 'partial', 0, actionableTotal, { reason: 'time_budget_exceeded_before_provider_probe' }, silent);
      }

      let providerRow;
      try {
        providerRow = await resolveDefaultProvider(db);
      } catch (err) {
        return await _recordOutcome(db, projectId, 'provider_unready', 0, actionableTotal, { reason: _short(err.message) }, silent);
      }

      const provider = createProviderFromRow(providerRow);
      try {
        await probeProvider(provider, { timeoutMs: Math.max(500, deadlineAt - Date.now()) });
      } catch (err) {
        return await _recordOutcome(db, projectId, 'provider_unready', 0, actionableTotal, { reason: _short(err.message) }, silent);
      }

      if (Date.now() >= deadlineAt) {
        return await _recordOutcome(db, projectId, 'partial', 0, actionableTotal, { reason: 'time_budget_exceeded_before_apply' }, silent);
      }

      let applyResult;
      try {
        applyResult = await runBackfillEmbeddings({
          db, projectId, table: 'all', apply: true,
          batchSize: Math.min(25, batch),
          rowCap: batch,
          deadlineAt,
          liveOnly: true,
        });
      } catch (err) {
        return await _recordOutcome(db, projectId, `error:${_short(err.message)}`, 0, actionableTotal, {}, silent);
      }

      if (!applyResult.ok) {
        const reason = (applyResult.refusal && applyResult.refusal.reason) || 'refused';
        return await _recordOutcome(db, projectId, `error:${_short(reason)}`, 0, actionableTotal, { detail: applyResult.refusal }, silent);
      }

      const embedded = (applyResult.tables || []).reduce((sum, t) => sum + (t.embedded || 0), 0);
      const rowErrors = (applyResult.tables || []).reduce((sum, t) => sum + (t.errors || 0), 0);
      const anyStopped = (applyResult.tables || []).some((t) => !!t.stopped);

      // Fresh remaining count — cheap, precise, reflects any concurrent
      // writer activity during the apply window. Falls back to the
      // pre-apply estimate if this second dry-run itself fails.
      let remaining = Math.max(0, actionableTotal - embedded);
      try {
        const post = await runBackfillEmbeddings({ db, projectId, table: 'all', apply: false, liveOnly: true });
        remaining = (post.tables || []).reduce((sum, t) => sum + (t.actionableNull || 0), 0);
      } catch (_) { /* keep the estimate */ }

      const outcome = remaining === 0 ? 'healed' : 'partial';
      return await _recordOutcome(db, projectId, outcome, embedded, remaining, {
        ...(anyStopped ? { stopped: true } : {}),
        ...(rowErrors > 0 ? { rowErrors } : {}),
      }, silent);
    } finally {
      try {
        await db.query('SELECT pg_advisory_unlock(hashtext($1), $2)', [lockKey, LOCK_NAMESPACE]);
      } catch (_) { /* best-effort — a session-scoped lock is released on disconnect regardless */ }
    }
  } catch (err) {
    // Absolute last-resort net — this function must NEVER throw upward,
    // per spec (fail-soft, never changes the caller's exit code).
    if (!silent) {
      process.stderr.write(`[handoff] embed-heal: unexpected error (non-fatal): ${err.message}\n`);
    }
    try {
      return await _recordOutcome(db, projectId, `error:${_short(err.message)}`, 0, null, {}, silent);
    } catch (_) {
      return null;
    }
  }
}

module.exports = {
  EMBED_HEAL_BATCH_SETTING_KEY,
  LAST_EMBED_HEAL_SETTING_KEY,
  DEFAULT_BATCH_PER_TOUCH,
  TIME_BUDGET_MS,
  runEmbedHealIfNeeded,
};
