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
 * NOTE on HANDOFF_MCP_ENGINE_PATH (Codex review P1a, 2026-09-13): this
 * module's own two exports (readDiskSchemaEpoch, classifyEpochDrift) are
 * root-parameterized and reason about whatever engineRoot is handed to
 * them — they have no opinion on WHICH checkout that is. The caller
 * (handoff-mcp.mjs) is responsible for calling them once for its own
 * required checkout (_ENGINE_ROOT) and, separately, once more for
 * HANDOFF_MCP_ENGINE_PATH's checkout when that override diverges from
 * _ENGINE_ROOT — see handoff-mcp.mjs's checkSpawnEngineEpochOrThrow.
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

// Codex review P2b (2026-09-13): JSON.stringify escapes a real newline/tab/
// carriage-return inside a string value as the TWO literal characters
// backslash+letter (e.g. the four characters \, n for a real "\n"). Against
// the RAW string "Fix: run\ninit" that is a genuine word boundary (a real
// newline), but against the SERIALIZED string "Fix: run\\ninit" the "n" of
// the escape and the "n" of "init" are adjacent WORD characters with no
// boundary between them, so \binit\b silently fails to match. Normalize
// those three escape sequences to a real space before testing so a remedy
// word split across an escaped whitespace character cannot slip through.
function normalizeEscapedWhitespace(str) {
  return str.replace(/\\[ntr]/g, ' ');
}

function namesInitOrResume(str) {
  return NAMES_INIT_OR_RESUME.test(normalizeEscapedWhitespace(str));
}

/**
 * If `detail` (or any of its own top-level key names) mentions "init" or
 * "resume" anywhere — e.g. a lower-level error message that itself
 * suggested `handoff.js init`, OR a key literally named after one of those
 * verbs — replace the ENTIRE detail with a bare redaction stub (no key
 * list, no fragment of the original content) before it is interpolated
 * into a report-only message. Codex review P2b (2026-09-13): the prior
 * version's `{redacted: true, keys}` shape copied the original UNSANITIZED
 * key names into the replacement, which could itself contain the remedy
 * text (a key literally named "run handoff.js init"). There is no safe
 * subset of a matching detail to preserve, so a match redacts everything.
 * Serialization failure (BigInt, a circular reference, or anything else
 * JSON.stringify cannot handle) is treated as its OWN redaction reason —
 * P2c requires this function to never throw and never pass an
 * unserializable value through.
 */
function redactDetailIfNamesRemedy(detail) {
  if (detail === undefined || detail === null) return detail;
  let asString;
  try {
    asString = JSON.stringify(detail);
  } catch (_err) {
    return { redacted: true, reason: 'unserializable' };
  }
  if (typeof asString !== 'string') return { redacted: true, reason: 'unserializable' };

  if (namesInitOrResume(asString)) return { redacted: true };

  // Defense in depth: also scan each own top-level key independently (the
  // whole-string scan above already covers this in the common case, since
  // JSON.stringify emits key names as quoted substrings of asString, but a
  // key scan makes the "any key" requirement explicit and keeps working
  // even if the whole-string scan's normalization ever diverges).
  let keys = [];
  try {
    if (typeof detail === 'object' && !Array.isArray(detail)) keys = Object.keys(detail);
  } catch (_err) {
    keys = [];
  }
  if (keys.some((k) => namesInitOrResume(k))) return { redacted: true };

  return detail;
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
  let detailSuffix = '';
  if (safeDetail !== undefined && safeDetail !== null) {
    // P2c: redactDetailIfNamesRemedy already guarantees safeDetail is either
    // the original (proven-serializable, non-remedy-naming) detail or a
    // trivially-serializable {redacted:true[, reason]} stub — but stringify
    // it defensively anyway so this function itself can never throw.
    try {
      detailSuffix = `, detail: ${JSON.stringify(safeDetail)}`;
    } catch (_err) {
      detailSuffix = ', detail: {"redacted":true,"reason":"unserializable"}';
    }
  }
  return (
    `handoff MCP: schema is not current for this project DB and the automatic bring-forward did not ` +
    `succeed (reason: ${reason}${detailSuffix}). Report-only: no command is offered; this state needs a maintainer.`
  );
}

const GENERIC_CLASSIFICATION_FAILURE_MESSAGE =
  'handoff MCP: schema-epoch classification failed unexpectedly. Report-only: no command is offered; this state needs a maintainer.';

function isPositiveSafeInteger(n) {
  return Number.isSafeInteger(n) && n >= 1;
}

/**
 * Pure, total classifier over the six branches described in the module
 * header. No I/O, NEVER throws (P2c — the entire body is wrapped so any
 * unexpected exception still returns a branch, never propagates), and every
 * combination of inputs maps to exactly one branch (see
 * test/test-mcp-epoch-guard.js T8 for the exhaustive proof).
 *
 * Rules, evaluated IN ORDER (first match wins):
 *   1. loadedEpoch not a positive safe integer          -> heal_failed
 *   2. diskEpoch not a positive safe integer (manifest
 *      unreadable OR malformed — NaN/fractional/string/
 *      negative/Infinity all count) AND healReason is
 *      undefined (pre-connect call, no heal has run yet) -> annotate_only
 *   2b. same disk-epoch condition, but healReason IS
 *       present (post-heal call — Codex review P2a: an
 *       unreadable/malformed manifest must not silently
 *       out-rank an already-observed heal failure)        -> heal_failed
 *   3. loadedEpoch < diskEpoch                            -> stale_engine
 *   4. loadedEpoch > diskEpoch                            -> engine_checkout_inconsistent
 *   5. healReason in {current, applied, degraded, undefined} -> proceed
 *   6. healReason === 'ahead' and dbEpoch is a positive safe
 *      integer with diskEpoch < dbEpoch                   -> engine_behind_db
 *      (otherwise, which should be unreachable)            -> heal_failed
 *   7. any other healReason                               -> heal_failed
 *
 * @param {object} args
 * @param {*} args.loadedEpoch  - SCHEMA_EPOCH from the running process's own required handoff.js.
 * @param {*} args.diskEpoch    - readDiskSchemaEpoch(...).epoch when ok, or null/undefined/anything else when unreadable or malformed.
 * @param {*} [args.dbEpoch]    - the DATABASE's stored epoch (ensureSchemaCurrentCore's 'ahead' detail.stored_epoch).
 * @param {string} [args.healReason] - ensureSchemaCurrent's {reason}. undefined means "no heal has run yet" (pre-connect call).
 * @param {object} [args.healDetail] - ensureSchemaCurrent's {detail}.
 * @returns {{branch: string, message: string|null}}
 */
function classifyEpochDrift(args) {
  try {
    const { loadedEpoch, diskEpoch, dbEpoch, healReason, healDetail } = args || {};

    if (!isPositiveSafeInteger(loadedEpoch)) {
      return { branch: 'heal_failed', message: healFailedMessage(healReason, healDetail) };
    }

    if (!isPositiveSafeInteger(diskEpoch)) {
      // Codex review P2a/P2c: a positive-safe-integer check here (not a
      // bare null/undefined check) also catches every malformed on-disk
      // value (NaN, 5.5, '5', -1, Infinity, {}, ...) — none of those is
      // evidence the checkout is either behind or ahead, so none of them
      // may reach the loadedEpoch/diskEpoch comparisons below. Whether that
      // "no epoch signal available" state is annotate_only (silent,
      // pre-connect — the engine's own ensureSchemaCurrent call will
      // independently hit the same unreadable file moments later) or
      // heal_failed (report-only, post-heal — a heal was already attempted
      // and already failed; a merely-unreadable manifest must not
      // out-rank and hide that observed failure) depends ONLY on whether a
      // heal has run yet, signaled by healReason being present.
      if (healReason === undefined) {
        return { branch: 'annotate_only', message: null };
      }
      return { branch: 'heal_failed', message: healFailedMessage(healReason, healDetail) };
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
      if (isPositiveSafeInteger(dbEpoch) && diskEpoch < dbEpoch) {
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
  } catch (_err) {
    // P2c: total means NEVER throws, even against an input shape nothing
    // above anticipated (e.g. a getter that throws, a Proxy, a hostile
    // dbEpoch). No detail is echoed here — it may be the very thing that
    // caused the exception, so its own JSON.stringify could throw again.
    return { branch: 'heal_failed', message: GENERIC_CLASSIFICATION_FAILURE_MESSAGE };
  }
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
