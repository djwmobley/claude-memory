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
  // Codex review r2 finding 4 (2026-09-13): the ENTIRE body below is wrapped
  // in one outer try/catch (which also catches RangeError) as a backstop —
  // a manifest whose schema_epoch is a pathologically deep nested structure
  // (e.g. an array nested 20,000 levels) could previously blow the stack
  // inside JSON.stringify(epoch) below (used only to render the error
  // string), well AFTER JSON.parse itself had already succeeded. The fix
  // removes that JSON.stringify call entirely (no recursion over the parsed
  // value anywhere in this function — a plain `typeof` check is enough to
  // reject anything that isn't already a number) and this outer catch is
  // the last line of defense against any other unanticipated throw
  // (including one from JSON.parse's own native depth limit, on an engine
  // build where that throws RangeError instead of returning).
  try {
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
    if (typeof parsed !== 'object' || parsed === null) {
      return { ok: false, error: `${manifestPath}: parsed manifest is not an object (got ${typeof parsed})` };
    }
    const epoch = parsed.schema_epoch;
    if (typeof epoch !== 'number' || !Number.isSafeInteger(epoch) || epoch < 1) {
      // Deliberately no JSON.stringify(epoch) here — epoch is untrusted and
      // may be an arbitrarily deep/large structure; `typeof` never recurses.
      return {
        ok: false,
        error: `${manifestPath}: schema_epoch must be a positive safe integer, got a value of type ${typeof epoch}`,
      };
    }
    return { ok: true, epoch };
  } catch (err) {
    return { ok: false, error: `${manifestPath}: unexpected error reading schema epoch: ${err && err.message}` };
  }
}

// Codex review r2 finding 1 (2026-09-13): checkSpawnEngineEpochOrThrow's
// pre-spawn comparison only ever read the override checkout's
// schema-manifest.json — a half-updated override whose manifest was bumped
// to match but whose scripts/handoff.js still declares an OLDER SCHEMA_EPOCH
// literal would pass that check and still execute. readEngineEpochLiteral
// reads (at most) the first MAX_HANDOFF_JS_READ_BYTES of the override's own
// scripts/handoff.js and extracts its `const SCHEMA_EPOCH = <int>;`
// declaration directly, as TEXT — never by require()'ing/evaluating the
// file (this module has no business executing an arbitrary override
// checkout's code just to learn one integer it declares).
const MAX_HANDOFF_JS_READ_BYTES = 512 * 1024;
const SCHEMA_EPOCH_LITERAL_RE = /^\s*const SCHEMA_EPOCH\s*=\s*(\d+)\s*;/m;

/**
 * Reads at most the first MAX_HANDOFF_JS_READ_BYTES bytes of
 * <engineRoot>/scripts/handoff.js and extracts its SCHEMA_EPOCH literal.
 * Never throws — every failure mode (missing file, unreadable, no matching
 * literal in the read window, a non-numeric/non-positive/unsafe match)
 * returns {ok:false, error}.
 *
 * @param {string} engineRoot
 * @returns {{ok: true, epoch: number} | {ok: false, error: string}}
 */
function readEngineEpochLiteral(engineRoot) {
  const handoffPath = path.join(engineRoot, 'scripts', 'handoff.js');
  try {
    let text;
    let fd;
    try {
      fd = fs.openSync(handoffPath, 'r');
    } catch (err) {
      return { ok: false, error: `cannot read ${handoffPath}: ${err.message}` };
    }
    try {
      const buf = Buffer.alloc(MAX_HANDOFF_JS_READ_BYTES);
      const bytesRead = fs.readSync(fd, buf, 0, MAX_HANDOFF_JS_READ_BYTES, 0);
      text = buf.toString('utf8', 0, bytesRead);
    } catch (err) {
      return { ok: false, error: `cannot read ${handoffPath}: ${err.message}` };
    } finally {
      try { fs.closeSync(fd); } catch (_err) { /* best-effort */ }
    }
    const match = SCHEMA_EPOCH_LITERAL_RE.exec(text);
    if (!match) {
      return {
        ok: false,
        error: `cannot find a "const SCHEMA_EPOCH = <int>;" literal in the first ${MAX_HANDOFF_JS_READ_BYTES} bytes of ${handoffPath}`,
      };
    }
    const epoch = Number(match[1]);
    if (!Number.isSafeInteger(epoch) || epoch < 1) {
      return { ok: false, error: `${handoffPath}: SCHEMA_EPOCH literal must be a positive safe integer, got "${match[1]}"` };
    }
    return { ok: true, epoch };
  } catch (err) {
    return { ok: false, error: `${handoffPath}: unexpected error reading SCHEMA_EPOCH literal: ${err && err.message}` };
  }
}

// Never let a heal_failed report-only message accidentally read as an
// init/resume remedy (adversary requirement: no arm may name either verb).
// eslint-disable-next-line no-useless-escape
const NAMES_INIT_OR_RESUME = /\b(init|resume)\b/i;

// Codex review r2 finding 3 (2026-09-13): normalizes BOTH (a) a real control/
// whitespace character embedded directly in a RAW string value — form feed,
// vertical tab, NEL, NBSP, line/paragraph separator, any \s — to a plain
// space, so e.g. the raw string "run\finit" (an actual form-feed byte) reads
// as "run init" with a genuine word boundary, and (b) a JSON-serialized
// ESCAPED whitespace sequence — JSON.stringify renders a real newline as the
// TWO literal characters backslash+n, so "run\ninit" survives serialization
// as the literal text run\ninit, where the escape's "n" and "init"'s "i" are
// adjacent word characters with no boundary between them. Both
// normalizations are applied unconditionally and are each no-ops against
// text the other doesn't apply to, so one function is safe to use against
// either a raw string or an already-serialized one.
const ESCAPED_WHITESPACE_RE = /\\[ntr]/g;
// eslint-disable-next-line no-control-regex
const RAW_WHITESPACE_AND_CONTROL_RE = /[\s\u0000-\u001f\u007f\u0085\u00a0\u2028\u2029]+/g;

function normalizeForRemedyScan(str) {
  return str.replace(ESCAPED_WHITESPACE_RE, ' ').replace(RAW_WHITESPACE_AND_CONTROL_RE, ' ');
}

function namesInitOrResume(str) {
  return NAMES_INIT_OR_RESUME.test(normalizeForRemedyScan(str));
}

// The exact, exhaustive set of `reason` strings scripts/handoff.js's
// ensureSchemaCurrentCore can return (enumerated 2026-09-13 by grepping every
// `return { applied: ..., reason: '<x>' }` in that function — see the PR
// body for the exact grep). Codex review r2 finding 3: healReason is
// caller-supplied and must be whitelisted before interpolation exactly like
// detail is redacted — an arbitrary/hostile string (or a value that isn't a
// string at all, including undefined) is never echoed verbatim.
const KNOWN_HEAL_REASONS = new Set([
  'ahead', 'applied', 'apply_failed', 'classification_error', 'current',
  'degraded', 'integrity_index_failed', 'lock_acquire_failed',
  'manifest_error', 'unknown', 'verification_failed', 'verification_probe_failed',
]);

function safeHealReason(reason) {
  return KNOWN_HEAL_REASONS.has(reason) ? reason : 'unknown_reason';
}

const MAX_DETAIL_WALK_DEPTH = 8;

/**
 * Recursively walks `value` over its OWN enumerable properties only —
 * Codex review r2 finding 3: deliberately NEVER via JSON.stringify/toJSON.
 * A stateful toJSON() (safe text on one call, remedy text on the next) must
 * never be trusted for detection; only the real own-property structure is
 * inspected here, so this cannot be fooled by a toJSON() that lies about the
 * object's own shape. Arrays are included (their own enumerable index
 * properties). Depth-capped at MAX_DETAIL_WALK_DEPTH — a value nested deeper
 * than that simply stops being inspected (never treated as a match, never
 * recursed into further) — and cycle-safe via a Set of already-visited
 * objects (a repeat visit returns false immediately rather than looping).
 * A throwing getter for one property is skipped (not a match, not a crash);
 * the walk continues over the object's other properties.
 */
function detailNamesRemedy(value, depth, seen) {
  if (typeof value === 'string') return namesInitOrResume(value);
  if (value === null || typeof value !== 'object') return false;
  if (depth > MAX_DETAIL_WALK_DEPTH) return false;
  if (seen.has(value)) return false;
  seen.add(value);
  let keys;
  try {
    keys = Object.keys(value);
  } catch (_err) {
    return false;
  }
  for (const key of keys) {
    if (typeof key === 'string' && namesInitOrResume(key)) return true;
    let child;
    try {
      child = value[key];
    } catch (_err) {
      continue;
    }
    if (detailNamesRemedy(child, depth + 1, seen)) return true;
  }
  return false;
}

function safeStringifyOnce(value) {
  try {
    const text = JSON.stringify(value);
    return typeof text === 'string' ? { ok: true, text } : { ok: false };
  } catch (_err) {
    return { ok: false };
  }
}

const REDACTED_DETAIL_TEXT = '{"redacted":true}';

/**
 * Produces the exact `, detail: <json>` suffix for a report-only
 * heal_failed message (or '' when detail is absent). Codex review r2
 * finding 3: the prior implementation called JSON.stringify(detail) TWICE —
 * once (via redactDetailIfNamesRemedy) to test for a match, once more (in
 * healFailedMessage) to render the output — so a stateful toJSON() could
 * return safe text on the first call and the remedy on the second, emitting
 * it unchanged. This version calls JSON.stringify on the ORIGINAL detail AT
 * MOST ONCE, ever:
 *   1. First, the raw-structure walk above (which never touches toJSON) —
 *      if it finds a match, detail is redacted WITHOUT ever serializing the
 *      original at all.
 *   2. Only if step 1 finds nothing: serialize `detail` exactly once. If
 *      that single call throws (BigInt, a circular reference, anything else
 *      JSON.stringify cannot handle), the result is the unserializable stub.
 *      Otherwise, the ONE string that call produced is tested for a remedy
 *      word (covering a toJSON() whose OUTPUT — not its raw own-properties —
 *      names one) and, if it matches, that string is discarded (never
 *      re-stringified, never partially emitted) in favor of the bare stub.
 */
function sanitizeDetailForMessage(detail) {
  if (detail === undefined || detail === null) return '';

  if (detailNamesRemedy(detail, 0, new Set())) {
    return `, detail: ${REDACTED_DETAIL_TEXT}`;
  }

  const serialized = safeStringifyOnce(detail);
  if (!serialized.ok) {
    return ', detail: {"redacted":true,"reason":"unserializable"}';
  }
  if (namesInitOrResume(serialized.text)) {
    return `, detail: ${REDACTED_DETAIL_TEXT}`;
  }
  return `, detail: ${serialized.text}`;
}

/**
 * Builds the exact report-only 'heal_failed' message. Exposed (beyond
 * classifyEpochDrift itself) so a caller that lands on classifyEpochDrift's
 * message:null branches (proceed/annotate_only) in a context where it
 * ALREADY knows independently that the heal failed (e.g. withProjectDb's
 * post-ensureSchemaCurrent call site, when the manifest is unreadable and
 * therefore contributes no epoch signal) can still render the SAME wording
 * from the SAME reason/detail, rather than a second hand-written string.
 * No string from `detail` or `reason` reaches the returned message except
 * through sanitizeDetailForMessage (detail) and safeHealReason (reason).
 *
 * @param {string|undefined} reason
 * @param {object|undefined} detail
 * @returns {string}
 */
function healFailedMessage(reason, detail) {
  const safeReason = safeHealReason(reason);
  const detailSuffix = sanitizeDetailForMessage(detail);
  return (
    `handoff MCP: schema is not current for this project DB and the automatic bring-forward did not ` +
    `succeed (reason: ${safeReason}${detailSuffix}). Report-only: no command is offered; this state needs a maintainer.`
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
  // Codex review r2 finding 1: the SAME literal-extraction helper
  // handoff-mcp.mjs's checkSpawnEngineEpochOrThrow uses to validate a
  // HANDOFF_MCP_ENGINE_PATH override's own scripts/handoff.js, exposed for
  // direct unit coverage — no second implementation.
  readEngineEpochLiteral,
};
