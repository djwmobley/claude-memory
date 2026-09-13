'use strict';

/**
 * schema-epoch-guard.js — fix/mcp-stale-engine-gate.
 *
 * PROBLEM (incident 2026-09-13): scripts/handoff-mcp.mjs's withProjectDb
 * emitted the SAME "run `node scripts/handoff.js init` (or `resume`)"
 * remedy for every ensureSchemaCurrent heal failure, including reason
 * 'ahead' (the DATABASE's stored schema epoch is newer than what THIS
 * running engine process knows about). A handoff-mcp.mjs server process
 * started 2026-09-10 held SCHEMA_EPOCH=4 in memory (a frozen literal —
 * scripts/handoff.js:2094 — read once at require() time and never
 * re-evaluated) after `main` moved to schema_epoch 5. Its own
 * _computeSchemaFingerprint re-reads the schema SQL files fresh off disk
 * on every call, so it kept re-deriving "4:<hash>" against a database
 * fingerprinted "5:<same hash>" by a newer process. withProjectDb's old
 * blanket remedy would have told the caller to run `init`/`resume` — the
 * exact commands that could force the database backward. That is a
 * DOWNGRADE, never an acceptable auto-remedy.
 *
 * FIX: total classification (classifyEpochDrift below) separates four
 * distinct situations a bare `reason` string conflates:
 *   1. stale_engine                 — loaded < disk. THIS PROCESS is behind
 *                                     its own checkout on disk. Restart the
 *                                     MCP server so it reloads handoff.js;
 *                                     no database action needed.
 *   2. engine_checkout_inconsistent — loaded > disk. THIS PROCESS's own
 *                                     checkout is internally inconsistent
 *                                     (handoff.js declares a higher epoch
 *                                     than schema-manifest.json, on the SAME
 *                                     checkout). Nothing short of restoring
 *                                     a clean checkout fixes this.
 *   3. engine_behind_db             — loaded === disk (this checkout is
 *                                     internally consistent), but
 *                                     ensureSchemaCurrentCore's own 'ahead'
 *                                     classification says the DATABASE's
 *                                     stored epoch is newer still. The
 *                                     engine build itself needs upgrading.
 *   4. heal_failed                  — every other non-proceeding
 *                                     ensureSchemaCurrent reason
 *                                     (manifest_error, classification_error,
 *                                     lock_acquire_failed, apply_failed,
 *                                     integrity_index_failed,
 *                                     verification_failed,
 *                                     verification_probe_failed, unknown, or
 *                                     anything not enumerated here) — this
 *                                     needs a maintainer; report-only, no
 *                                     command is ever offered.
 *
 * No arm of classifyEpochDrift ever names `init`/`resume` as a remedy:
 * doing so would be a no-op (1), meaningless (2 — there is no DB action
 * that fixes a broken checkout), an actual downgrade attempt (3), or a
 * guess unsupported by the evidence (4).
 *
 * KNOWN RESIDUAL GAP (documented, not fixed here — see handoff-mcp.mjs's
 * own comment at its call sites): this guard validates the SERVER
 * PROCESS's OWN engine identity only (the handoff.js it required at
 * startup, and that same handoff.js's own _ENGINE_ROOT). A deployment
 * where HANDOFF_MCP_ENGINE_PATH points a runNode-spawned child at a
 * DIFFERENT checkout than the one this server required is invisible to
 * this guard — see handoff-mcp.mjs.
 */

const fs = require('fs');
const path = require('path');

/**
 * Reads <engineRoot>/scripts/sql/schema-manifest.json fresh off disk on
 * EVERY call — no memoization, no stat-based cache, and deliberately NOT
 * scripts/lib/schema-classify.js's classifySchemaFiles (which validates the
 * full SQL-unit roster against git and has its own memoization semantics
 * unrelated to this narrow, cheap question: "what schema_epoch integer does
 * the checkout ON DISK declare, right now"). The whole point of this guard
 * is catching drift that a memoized/cached read would hide.
 *
 * @param {string} engineRoot
 * @returns {{ok: true, epoch: number} | {ok: false, error: string}}
 */
function readDiskSchemaEpoch(engineRoot) {
  const manifestPath = path.join(engineRoot, 'scripts', 'sql', 'schema-manifest.json');
  let raw;
  try {
    raw = fs.readFileSync(manifestPath, 'utf8');
  } catch (err) {
    return { ok: false, error: `cannot read ${manifestPath}: ${err.message}` };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { ok: false, error: `cannot parse ${manifestPath}: ${err.message}` };
  }
  const epoch = parsed ? parsed.schema_epoch : undefined;
  if (!Number.isSafeInteger(epoch) || epoch < 1) {
    return {
      ok: false,
      error: `${manifestPath}: schema_epoch must be a positive safe integer, got ${JSON.stringify(epoch)}`,
    };
  }
  return { ok: true, epoch };
}

// Never let a heal_failed report-only message accidentally read as an
// init/resume remedy (adversary requirement: no arm may name either verb).
// eslint-disable-next-line no-useless-escape
const NAMES_INIT_OR_RESUME = /\b(init|resume)\b/i;

/**
 * If `detail` (as JSON) mentions "init" or "resume" anywhere (e.g. a
 * lower-level error message that itself suggested `handoff.js init`),
 * replace it with a redaction stub that keeps only its top-level key names
 * — never the remedy-shaped text — before it is interpolated into a
 * report-only message.
 */
function redactDetailIfNamesRemedy(detail) {
  if (detail === undefined || detail === null) return detail;
  let asString;
  try {
    asString = JSON.stringify(detail);
  } catch (_err) {
    return detail;
  }
  if (typeof asString !== 'string' || !NAMES_INIT_OR_RESUME.test(asString)) return detail;
  let keys = [];
  try {
    if (typeof detail === 'object' && !Array.isArray(detail)) keys = Object.keys(detail);
  } catch (_err) {
    keys = [];
  }
  return { redacted: true, keys };
}

/**
 * Builds the exact report-only 'heal_failed' message. Exposed (beyond
 * classifyEpochDrift itself) so a caller that lands on classifyEpochDrift's
 * message:null branches (proceed/annotate_only) in a context where it
 * ALREADY knows independently that the heal failed (e.g. withProjectDb's
 * post-ensureSchemaCurrent call site, when the manifest is unreadable and
 * therefore contributes no epoch signal) can still render the SAME wording
 * from the SAME reason/detail, rather than a second hand-written string.
 *
 * @param {string|undefined} reason
 * @param {object|undefined} detail
 * @returns {string}
 */
function healFailedMessage(reason, detail) {
  const safeDetail = redactDetailIfNamesRemedy(detail);
  const detailSuffix = safeDetail !== undefined && safeDetail !== null
    ? `, detail: ${JSON.stringify(safeDetail)}`
    : '';
  return (
    `handoff MCP: schema is not current for this project DB and the automatic bring-forward did not ` +
    `succeed (reason: ${reason}${detailSuffix}). Report-only: no command is offered; this state needs a maintainer.`
  );
}

/**
 * Pure, total classifier over the four branches described in the module
 * header. No I/O, never throws, every combination of inputs maps to exactly
 * one branch (see test/test-mcp-epoch-guard.js T8 for the exhaustive proof).
 *
 * Rules, evaluated IN ORDER (first match wins):
 *   1. loadedEpoch not a positive safe integer         -> heal_failed
 *   2. diskEpoch is null/undefined (manifest unreadable) -> annotate_only
 *   3. loadedEpoch < diskEpoch                          -> stale_engine
 *   4. loadedEpoch > diskEpoch                          -> engine_checkout_inconsistent
 *   5. healReason in {current, applied, degraded, undefined} -> proceed
 *   6. healReason === 'ahead' and dbEpoch is a positive safe
 *      integer with diskEpoch < dbEpoch                 -> engine_behind_db
 *      (otherwise, which should be unreachable)          -> heal_failed
 *   7. any other healReason                             -> heal_failed
 *
 * @param {object} args
 * @param {*} args.loadedEpoch  - SCHEMA_EPOCH from the running process's own required handoff.js.
 * @param {number|null|undefined} args.diskEpoch - readDiskSchemaEpoch(...).epoch, or null/undefined if unreadable.
 * @param {*} [args.dbEpoch]    - the DATABASE's stored epoch (ensureSchemaCurrentCore's 'ahead' detail.stored_epoch).
 * @param {string} [args.healReason] - ensureSchemaCurrent's {reason}.
 * @param {object} [args.healDetail] - ensureSchemaCurrent's {detail}.
 * @returns {{branch: string, message: string|null}}
 */
function classifyEpochDrift({ loadedEpoch, diskEpoch, dbEpoch, healReason, healDetail } = {}) {
  if (!Number.isSafeInteger(loadedEpoch) || loadedEpoch < 1) {
    return { branch: 'heal_failed', message: healFailedMessage(healReason, healDetail) };
  }

  if (diskEpoch === null || diskEpoch === undefined) {
    return { branch: 'annotate_only', message: null };
  }

  if (loadedEpoch < diskEpoch) {
    return {
      branch: 'stale_engine',
      message: `handoff MCP: this server is running a stale engine build (loaded schema epoch ${loadedEpoch}, on disk ${diskEpoch}). Restart the MCP server so it reloads scripts/handoff.js, then retry. No database change is needed.`,
    };
  }
  if (loadedEpoch > diskEpoch) {
    return {
      branch: 'engine_checkout_inconsistent',
      message: `handoff MCP: the engine checkout is internally inconsistent (scripts/handoff.js declares schema epoch ${loadedEpoch}, scripts/sql/schema-manifest.json declares ${diskEpoch}). The checkout is broken or half-updated; restore a clean engine checkout and restart the MCP server.`,
    };
  }

  // loadedEpoch === diskEpoch from here on — this checkout is internally
  // consistent; whatever happens next is about the DATABASE, not this build.
  if (healReason === 'current' || healReason === 'applied' || healReason === 'degraded' || healReason === undefined) {
    return { branch: 'proceed', message: null };
  }

  if (healReason === 'ahead') {
    if (Number.isSafeInteger(dbEpoch) && dbEpoch >= 1 && diskEpoch < dbEpoch) {
      return {
        branch: 'engine_behind_db',
        message: `handoff MCP: the engine checkout is older than the database (engine schema epoch ${diskEpoch}, database ${dbEpoch}). Upgrade the engine checkout to the build that wrote epoch ${dbEpoch}, then restart the MCP server. Refusing to apply a downgrade.`,
      };
    }
    // Should be unreachable: ensureSchemaCurrentCore only ever returns
    // reason:'ahead' when it itself found the DB's stored epoch strictly
    // newer than its own current one. If dbEpoch was not threaded through
    // (or is otherwise malformed) there is no evidence-backed remedy to
    // offer — fall back to the same report-only treatment as any other
    // unclassifiable heal failure, rather than guessing.
    return { branch: 'heal_failed', message: healFailedMessage(healReason, healDetail) };
  }

  // manifest_error, classification_error, lock_acquire_failed, apply_failed,
  // integrity_index_failed, verification_failed, verification_probe_failed,
  // unknown, or anything not enumerated above.
  return { branch: 'heal_failed', message: healFailedMessage(healReason, healDetail) };
}

module.exports = {
  readDiskSchemaEpoch,
  classifyEpochDrift,
  // Exposed for withProjectDb's post-heal call site (see module header) and
  // for direct unit coverage (test/test-mcp-epoch-guard.js T5/T7/T12) — not
  // part of the two required exports, but the SAME function classifyEpochDrift
  // uses internally, never a second implementation.
  healFailedMessage,
};
