'use strict';

/**
 * scripts/lib/usage-telemetry.js
 *
 * Usage-telemetry record/query library (runbook §18.2). Companion to
 * scripts/lib/route-resolve.js: routeResolve decides which model a turn
 * should use and records that decision; usageRecord measures what actually
 * happened (tokens, cost, outcome) for the SAME (project_id, session_id,
 * turn_idx, agent_role) key, whether or not routeResolve ever ran for it
 * (an agent that picked its own model outside the routing harness is still
 * measurable). CommonJS, plain `pg` client (Client or Pool) passed in by the
 * caller -- this library never opens, owns, or closes a database
 * connection, and never touches schema.
 *
 * TABLE OWNERSHIP (hard invariant): usageRecord writes ONLY turn_usage.
 * sessionUsageRollup writes ONLY session_usage. usageQuery never writes
 * anything. Neither function ever writes model_registry, routing_profiles,
 * or routing_session_overrides.
 *
 * usageRecord(pg, { projectId, sessionId, turnIdx, agentRole, tokensIn,
 * tokensOut, cacheReadTokens?, cacheWriteTokens?, costUsd?, modelId?,
 * provider?, outcome?, sourceModel?, agentId? })
 *
 *   Matched on (project_id, session_id, turn_idx, agent_role) -- the same
 *   key route-resolve.js's turn_usage UNIQUE constraint uses. If a row
 *   already exists for the key (the common resolve-first-measure-after
 *   case), it is UPDATEd; otherwise a fresh row is INSERTed with
 *   resolved_via NULL.
 *
 *   UNIVERSAL PRESERVATION RULE (A-1): for every parameter EXCEPT costUsd,
 *   undefined/null on the UPDATE path preserves the existing column value;
 *   only a provided (non-null, non-undefined) value is written. This is
 *   implemented in SQL via COALESCE($param, turn_usage.<col>) inside a
 *   single INSERT ... ON CONFLICT DO UPDATE statement (A-6) -- there is no
 *   check-then-act, and no second write. resolved_via, recommended_model,
 *   and cost_delta_usd are NEVER written by this function (not in the
 *   INSERT column list, not in the UPDATE SET list) -- they belong
 *   exclusively to route-resolve.js.
 *
 *   costUsd IS THE ONE EXCEPTION (A-2), a three-way state machine:
 *     - undefined  -> compute server-side (see COST COMPUTATION below);
 *                     the computed value (or NULL on any fail-soft branch)
 *                     is ALWAYS written -- this is the one field never
 *                     "preserved" by omission.
 *     - null       -> force NULL verbatim (caller asserts the turn is
 *                     unbillable/unknowable; server compute suppressed).
 *     - finite non-negative number -> used verbatim (validated: A-5).
 *     - anything else (NaN, Infinity, negative, non-number) -> hard error.
 *
 *   DDL-DEFAULT DISCIPLINE (A-4): when `outcome` is not provided, the
 *   INSERT statement OMITS the outcome column entirely so the DDL's own
 *   `DEFAULT 'unknown'` applies (an explicit NULL would bypass that
 *   default) -- and the UPDATE SET clause likewise omits `outcome`
 *   entirely, preserving whatever value the row already carries. The SQL
 *   text is therefore built in two variants (outcome-provided /
 *   outcome-omitted), both fully parameterized -- never string-interpolated
 *   values, only a structural branch on which parameterized columns are
 *   present.
 *
 *   COST COMPUTATION (server-side, only when costUsd is omitted):
 *   cost_usd = (tokens_in * cost_in_per_mtok + tokens_out * cost_out_per_mtok)
 *   / 1e6, using model_registry rates for the EFFECTIVE model (this call's
 *   modelId when provided, else the pre-existing row's model_id) and the
 *   EFFECTIVE token counts (this call's tokensIn/tokensOut when provided,
 *   else the pre-existing row's). Determining "effective" requires a
 *   best-effort SELECT of the existing row BEFORE the write -- that read is
 *   for COST INPUT ONLY (A-6); it never gates the write and the write
 *   remains a single upsert statement. NARROW RACE CASE (A-6, documented,
 *   accepted): if that read finds no existing row (fresh key, or a
 *   concurrent insert this read did not observe) but the upsert itself then
 *   conflicts with a row a concurrent caller just inserted, the computed
 *   cost basis is this call's OWN params only -- it is never re-read after
 *   the upsert, so the winning cost value can, in that narrow interleaving,
 *   reflect a token/model basis that is not the row's final COALESCEd
 *   state. Fails soft to NULL (never a guessed price, never 0) when: no
 *   effective model, the effective model is unregistered, either registered
 *   rate is NULL (the V9 gap), or either effective token count is
 *   unavailable. Cache tokens are NEVER priced -- provider cache-pricing
 *   semantics vary and no rate columns exist for them; an operator wanting
 *   cache-aware cost passes an explicit costUsd.
 *
 *   RANGE GUARD (distinct from the fail-soft-NULL branches above): cost_usd
 *   is NUMERIC(12,6) (max magnitude 999999.999999 -- MAX_NUMERIC_12_6). A
 *   cost value that IS computable but exceeds that bound -- whether
 *   caller-supplied or server-computed -- is a computable anomaly, not an
 *   unknowable price, so it throws CostOutOfRangeError instead of silently
 *   degrading to NULL (which would hide it). Caller-supplied costUsd is
 *   checked before any SQL runs at all; a server-computed overflow is
 *   checked before usageRecord's upsert statement is built, so no row is
 *   ever written or modified when this throws.
 *
 *   Returns the post-write row (aliased camelCase shape, every NUMERIC/
 *   BIGINT value coerced to a JS number-or-null, never a pg string) plus
 *   `{ created: boolean }` (true iff this call's own upsert performed the
 *   physical INSERT, determined via the `xmax = 0` RETURNING idiom -- race-
 *   safe: under a genuine concurrent conflict, Postgres row-level locking on
 *   the unique index serializes the two upserts, so exactly one of them
 *   observes `created: true`).
 *
 * sessionUsageRollup(pg, { projectId, sessionId })
 *
 *   Recomputes and UPSERTs the session_usage row for (projectId, sessionId)
 *   by aggregating turn_usage, as ONE SQL statement (A-11): a CTE computes
 *   the model_breakdown JSONB and the session totals from a single scan of
 *   turn_usage, then INSERT ... SELECT ... ON CONFLICT (project_id,
 *   session_id) DO UPDATE writes the result. This is a single internally-
 *   consistent snapshot -- concurrent rollups are last-write-wins between
 *   two such snapshots (documented, accepted: callers are checkpoint/close,
 *   serialized in practice; A-11).
 *
 *   model_breakdown shape: { "<model_id>": { tokens_in, tokens_out,
 *   cost_usd, turns } }, with rows whose model_id IS NULL aggregating under
 *   the literal key "(none)". NULL/SUM semantics are exactly SQL SUM's own:
 *   a NULL-valued column is ignored by SUM, and the aggregate is NULL only
 *   when EVERY contributing value was NULL -- never coerced to 0 (that
 *   would fabricate a $0.00 cost for an unmeasured turn). turn_count =
 *   COUNT(*).
 *
 *   ZERO-TURN ROLLUP (A-17): rolling up a (project, session) key with zero
 *   turn_usage rows still UPSERTs a visible row: turn_count = 0, every
 *   total NULL, model_breakdown = '{}' -- a "measured nothing" record, never
 *   a silent no-op and never a fabricated zero-cost row.
 *
 *   RESERVED-SENTINEL DEFENSE (A-9): before aggregating, this function
 *   checks for any turn_usage row in scope whose model_id is literally the
 *   reserved string "(none)" (usageRecord itself refuses to ever write
 *   that value as modelId -- see A-9 below -- but a row could still reach
 *   this state via some other write path, e.g. a direct SQL INSERT). If
 *   found, this function hard-errors naming the anomalous row ids rather
 *   than silently merging that population with the genuinely-NULL-model
 *   population under the same "(none)" breakdown key.
 *
 * usageQuery(pg, { projectId, sessionId?, groupBy? })
 *
 *   groupBy in ('model','role','provider','day'), default 'model'; anything
 *   else hard-errors (total classification, never a silent fallback).
 *
 *   SESSION-SCOPED (sessionId given): aggregates turn_usage directly for
 *   that session, grouped by the requested dimension. 'day' is computed
 *   ONCE, IN SQL, IN UTC (A-12): `to_char(ts AT TIME ZONE 'UTC',
 *   'YYYY-MM-DD')`, returned as a plain string -- there is no driver-side
 *   Date/toISOString re-derivation anywhere in this path, and no dependence
 *   on the session's own TimeZone setting. NULL group keys (model, provider)
 *   are reported as the string "(none)". Rows: { key, tokens_in, tokens_out,
 *   cost_usd, turns }, ordered by cost_usd DESC NULLS LAST then key ASC.
 *   Same A-9 reserved-sentinel defense as sessionUsageRollup applies here
 *   too, since this path reads raw turn_usage.
 *
 *   PROJECT-SCOPED (sessionId omitted): reads session_usage ROLLUPS only --
 *   STALENESS BY DESIGN (documented + smoke-asserted): a session whose
 *   rollup has not been (re)computed via sessionUsageRollup is invisible to
 *   this view. This function never falls back to scanning turn_usage.
 *   groupBy interaction (decided, total classification): project scope
 *   supports groupBy='model' ONLY, implemented by merging the
 *   model_breakdown JSONB maps across every session_usage row in the
 *   project using SQL-SUM-preserving-NULL semantics (never a naive `|| 0`).
 *   Any other groupBy with no sessionId hard-errors, explaining that
 *   per-role/provider/day detail lives in turn_usage and requires a
 *   sessionId -- session_usage carries no such dimensions to fabricate an
 *   answer from.
 *
 *   All returned numerics are JS numbers or null, never pg strings (A-8,
 *   broadened beyond route-resolve.js's own NUMERIC-only coercion rule to
 *   cover BIGINT columns, SUM(bigint) aggregates -- both stringified by
 *   node-postgres -- and every numeric value extracted from a
 *   model_breakdown JSONB map).
 *
 * VALIDATION (A-19, mirrors route-resolve.js's style): projectId/sessionId/
 * agentRole are required non-empty strings; turnIdx is
 * `Number.isInteger(turnIdx) && turnIdx >= 0` (never a truthy check --
 * turnIdx=0 is valid); modelId/provider/sourceModel/agentId each follow
 * undefined/null = omitted, otherwise must be a non-empty string (hard
 * error on empty string or any other type); modelId additionally must not
 * equal the reserved sentinel "(none)" (A-9) -- that value can never be
 * written as a real modelId through this API, by construction. Token counts
 * (tokensIn/tokensOut/cacheReadTokens/cacheWriteTokens): undefined/null =
 * not given; otherwise a non-negative integer no greater than
 * Number.MAX_SAFE_INTEGER (A-18 -- BIGINT's wider native range is
 * intentionally unreachable through this API). outcome: undefined/null =
 * not given; otherwise must be one of ('success','failure','downgraded',
 * 'unknown') or this hard-errors.
 */

const VALID_OUTCOMES = Object.freeze(['success', 'failure', 'downgraded', 'unknown']);
const VALID_GROUP_BY = Object.freeze(['model', 'role', 'provider', 'day']);
const RESERVED_MODEL_SENTINEL = '(none)';

/**
 * turn_usage.cost_usd and session_usage.total_cost_usd are both
 * NUMERIC(12,6) (migrate-11-usage-telemetry.sql) -- 12 total digits, 6 after
 * the decimal point, so the largest representable magnitude is
 * 999999.999999. A cost value at or beyond this bound (caller-supplied OR
 * server-computed) is a COMPUTABLE ANOMALY (a mispriced or miscounted
 * turn), not an UNKNOWABLE price (the V9 fail-soft-NULL case) -- it hard-
 * errors via CostOutOfRangeError rather than silently degrading to NULL,
 * which would hide it. Friction over silent escape.
 */
const MAX_NUMERIC_12_6 = 999999.999999;

/** Named error class for any cost value that would overflow NUMERIC(12,6) -- thrown directly by validation, and rethrown from a caught Postgres 22003 (numeric_value_out_of_range) so no raw driver error ever escapes this module. */
class CostOutOfRangeError extends Error {}

/**
 * Throws CostOutOfRangeError if `value`'s magnitude exceeds MAX_NUMERIC_12_6.
 * null passes through unchanged (callers apply this only to values already
 * known to be real numbers headed for a NUMERIC(12,6) column).
 */
function assertCostWithinRange(value, name) {
  if (value === null) return null;
  if (Math.abs(value) > MAX_NUMERIC_12_6) {
    throw new CostOutOfRangeError(
      `usage-telemetry: "${name}" out of range for NUMERIC(12,6): ${value} (max magnitude ${MAX_NUMERIC_12_6})`
    );
  }
  return value;
}

// ─── INPUT VALIDATION (A-19) ───────────────────────────────────────────────

function requireNonEmptyString(value, name) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`usage-telemetry: "${name}" must be a non-empty string (got ${JSON.stringify(value)})`);
  }
  return value;
}

/** Number.isInteger(turnIdx) && turnIdx >= 0 -- never a truthy check. turnIdx=0 is valid. */
function requireTurnIdx(turnIdx) {
  if (!(Number.isInteger(turnIdx) && turnIdx >= 0)) {
    throw new Error(`usage-telemetry: "turnIdx" must be a non-negative integer (got ${JSON.stringify(turnIdx)})`);
  }
  return turnIdx;
}

/**
 * undefined/null = omitted -> null (not given, preserved on UPDATE).
 * Otherwise must be a non-empty string, or this throws. `rejectReservedNone`
 * additionally rejects the literal "(none)" sentinel (A-9, modelId only).
 */
function normalizeOptionalString(value, name, { rejectReservedNone = false } = {}) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`usage-telemetry: "${name}" must be a non-empty string when given (got ${JSON.stringify(value)})`);
  }
  if (rejectReservedNone && value === RESERVED_MODEL_SENTINEL) {
    throw new Error(
      `usage-telemetry: "${name}" must not be the reserved sentinel "${RESERVED_MODEL_SENTINEL}" (A-9) -- ` +
      'that value is reserved for representing a NULL model_id in aggregated output and can never be stored as a real model id.'
    );
  }
  return value;
}

/** undefined/null = not given -> null. Otherwise a non-negative safe integer (A-18). */
function normalizeTokenCount(value, name) {
  if (value === undefined || value === null) return null;
  if (!(Number.isInteger(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER)) {
    throw new Error(
      `usage-telemetry: "${name}" must be a non-negative integer no greater than Number.MAX_SAFE_INTEGER when given (got ${JSON.stringify(value)})`
    );
  }
  return value;
}

const COST_MODE = Object.freeze({ COMPUTE: 'compute', FORCE_NULL: 'force-null', VALUE: 'value' });

/** A-2 three-way state machine: undefined=compute, null=force NULL, finite non-negative number=use verbatim (A-5), anything else=hard error. */
function normalizeCostUsd(costUsd) {
  if (costUsd === undefined) return { mode: COST_MODE.COMPUTE, value: null };
  if (costUsd === null) return { mode: COST_MODE.FORCE_NULL, value: null };
  if (!(typeof costUsd === 'number' && Number.isFinite(costUsd) && costUsd >= 0)) {
    throw new Error(
      `usage-telemetry: "costUsd" must be undefined (compute server-side), null (force NULL), or a finite ` +
      `non-negative number (got ${JSON.stringify(costUsd)})`
    );
  }
  // Range guard runs before any SQL is built or executed -- an out-of-range
  // caller-supplied cost is a validation failure, not a fail-soft-NULL case.
  assertCostWithinRange(costUsd, 'costUsd');
  return { mode: COST_MODE.VALUE, value: costUsd };
}

/** undefined/null = not given (INSERT omits the column for the DDL default; UPDATE preserves -- A-4). Otherwise must be a valid outcome. */
function normalizeOutcome(outcome) {
  if (outcome === undefined || outcome === null) return null;
  if (!VALID_OUTCOMES.includes(outcome)) {
    throw new Error(`usage-telemetry: "outcome" must be one of ${JSON.stringify(VALID_OUTCOMES)} (got ${JSON.stringify(outcome)})`);
  }
  return outcome;
}

// ─── NUMERIC COERCION (A-8, broadened) ─────────────────────────────────────

/**
 * node-postgres returns NUMERIC and BIGINT columns (and SUM(bigint)/
 * SUM(numeric) aggregates) as strings, and JSONB numeric fields as JS
 * numbers already -- this coercion is applied uniformly to every numeric-ish
 * read regardless of source shape. NULL/undefined preserved as null, NEVER
 * coerced to 0.
 */
function coerceNumeric(x) {
  if (x === null || x === undefined) return null;
  return Number(x);
}

function round6(x) {
  if (x === null || x === undefined) return null;
  return Math.round(x * 1e6) / 1e6;
}

// ─── A-9 RESERVED-SENTINEL DEFENSE ──────────────────────────────────────────

/**
 * Hard-errors, naming the anomalous row ids, if any turn_usage row for
 * (projectId, sessionId) carries the literal reserved model_id "(none)"
 * (A-9). usageRecord itself refuses to ever write that value, but this is a
 * defense-in-depth check against rows written by some other path (e.g. a
 * direct SQL INSERT) -- called by both sessionUsageRollup and the
 * session-scoped usageQuery path, both of which aggregate raw turn_usage.
 */
async function assertNoReservedNoneRows(pg, projectId, sessionId) {
  const { rows } = await pg.query(
    `SELECT id FROM turn_usage WHERE project_id = $1 AND session_id = $2 AND model_id = $3`,
    [projectId, sessionId, RESERVED_MODEL_SENTINEL]
  );
  if (rows.length > 0) {
    throw new Error(
      `usage-telemetry: ${rows.length} turn_usage row(s) (ids: ${rows.map((r) => r.id).join(', ')}) for ` +
      `project=${projectId} session=${sessionId} carry the reserved model_id sentinel "${RESERVED_MODEL_SENTINEL}" ` +
      '(A-9) -- refusing to aggregate rather than silently merging these with genuinely NULL-model rows under the same key.'
    );
  }
}

// ─── usageRecord ────────────────────────────────────────────────────────────

/**
 * Best-effort pre-read for the EFFECTIVE model + EFFECTIVE token counts used
 * as COST INPUT ONLY (see the module header's COST COMPUTATION section for
 * the full contract, including the documented narrow race case). Never a
 * second write; never re-read after the upsert.
 */
async function computeServerSideCost(pg, { projectId, sessionId, turnIdx, agentRole, modelId, tokensIn, tokensOut }) {
  let existing = null;
  if (modelId === null || tokensIn === null || tokensOut === null) {
    const { rows } = await pg.query(
      `SELECT model_id, tokens_in, tokens_out FROM turn_usage
        WHERE project_id = $1 AND session_id = $2 AND turn_idx = $3 AND agent_role = $4`,
      [projectId, sessionId, turnIdx, agentRole]
    );
    existing = rows[0] || null;
  }

  const effectiveModelId = modelId !== null ? modelId : (existing ? existing.model_id : null);
  const effectiveTokensIn = tokensIn !== null ? tokensIn : (existing ? coerceNumeric(existing.tokens_in) : null);
  const effectiveTokensOut = tokensOut !== null ? tokensOut : (existing ? coerceNumeric(existing.tokens_out) : null);

  if (effectiveModelId === null || effectiveTokensIn === null || effectiveTokensOut === null) {
    return null;
  }

  const { rows: regRows } = await pg.query(
    `SELECT cost_in_per_mtok, cost_out_per_mtok FROM model_registry WHERE label = $1`,
    [effectiveModelId]
  );
  if (regRows.length === 0) return null; // unregistered model
  const costIn = coerceNumeric(regRows[0].cost_in_per_mtok);
  const costOut = coerceNumeric(regRows[0].cost_out_per_mtok);
  if (costIn === null || costOut === null) return null; // V9 gap: rate(s) not configured

  const computed = (effectiveTokensIn * costIn + effectiveTokensOut * costOut) / 1e6;
  if (!Number.isFinite(computed)) return null; // non-finite (e.g. would-be Infinity) -- fail-soft, unrelated to the NUMERIC(12,6) bound
  // A finite computed cost that exceeds NUMERIC(12,6)'s range is a
  // computable anomaly, not an unknowable price -- this throws (propagating
  // out of usageRecord BEFORE its upsert statement is built or executed),
  // it never fails soft to NULL like the branches above.
  return assertCostWithinRange(computed, 'computed cost_usd');
}

/**
 * @param {import('pg').Client|import('pg').Pool} pg
 * @param {{ projectId: string, sessionId: string, turnIdx: number, agentRole: string,
 *   tokensIn?: number|null, tokensOut?: number|null, cacheReadTokens?: number|null,
 *   cacheWriteTokens?: number|null, costUsd?: number|null, modelId?: string|null,
 *   provider?: string|null, outcome?: string|null, sourceModel?: string|null,
 *   agentId?: string|null }} args
 * @returns {Promise<object>} the post-write row (camelCase, numeric-coerced) + { created }
 */
async function usageRecord(pg, args = {}) {
  const projectId = requireNonEmptyString(args.projectId, 'projectId');
  const sessionId = requireNonEmptyString(args.sessionId, 'sessionId');
  const turnIdx = requireTurnIdx(args.turnIdx);
  const agentRole = requireNonEmptyString(args.agentRole, 'agentRole');

  const modelId = normalizeOptionalString(args.modelId, 'modelId', { rejectReservedNone: true });
  const provider = normalizeOptionalString(args.provider, 'provider');
  const sourceModel = normalizeOptionalString(args.sourceModel, 'sourceModel');
  const agentId = normalizeOptionalString(args.agentId, 'agentId');

  const tokensIn = normalizeTokenCount(args.tokensIn, 'tokensIn');
  const tokensOut = normalizeTokenCount(args.tokensOut, 'tokensOut');
  const cacheReadTokens = normalizeTokenCount(args.cacheReadTokens, 'cacheReadTokens');
  const cacheWriteTokens = normalizeTokenCount(args.cacheWriteTokens, 'cacheWriteTokens');

  const costState = normalizeCostUsd(args.costUsd);
  const outcome = normalizeOutcome(args.outcome);

  // ── A-2 compute branch: best-effort pre-read for COST INPUT ONLY. ──────
  let costForWrite;
  if (costState.mode === COST_MODE.VALUE) {
    costForWrite = costState.value;
  } else if (costState.mode === COST_MODE.FORCE_NULL) {
    costForWrite = null;
  } else {
    costForWrite = await computeServerSideCost(pg, { projectId, sessionId, turnIdx, agentRole, modelId, tokensIn, tokensOut });
  }

  // ── A-6: single race-safe upsert. Fixed 13-parameter prefix; `outcome`
  // (A-4) is appended as a 14th column/placeholder/SET-clause ONLY when
  // provided -- fully parameterized either way, never string-interpolated
  // values. ────────────────────────────────────────────────────────────────
  const columns = [
    'project_id', 'session_id', 'turn_idx', 'agent_role', 'model_id', 'provider',
    'tokens_in', 'tokens_out', 'cache_read_tokens', 'cache_write_tokens', 'cost_usd',
    'source_model', 'agent_id',
  ];
  const values = [
    projectId, sessionId, turnIdx, agentRole, modelId, provider,
    tokensIn, tokensOut, cacheReadTokens, cacheWriteTokens, costForWrite,
    sourceModel, agentId,
  ];
  const setClauses = [
    'model_id = COALESCE($5, turn_usage.model_id)',
    'provider = COALESCE($6, turn_usage.provider)',
    'tokens_in = COALESCE($7, turn_usage.tokens_in)',
    'tokens_out = COALESCE($8, turn_usage.tokens_out)',
    'cache_read_tokens = COALESCE($9, turn_usage.cache_read_tokens)',
    'cache_write_tokens = COALESCE($10, turn_usage.cache_write_tokens)',
    // A-2: cost_usd is ALWAYS overwritten with the resolved value (compute
    // result, forced NULL, or verbatim) -- the one field never "preserved".
    'cost_usd = $11',
    'source_model = COALESCE($12, turn_usage.source_model)',
    'agent_id = COALESCE($13, turn_usage.agent_id)',
  ];
  if (outcome !== null) {
    columns.push('outcome');
    values.push(outcome);
    setClauses.push(`outcome = $${values.length}`);
  }
  // resolved_via / recommended_model / cost_delta_usd are deliberately never
  // in `columns` or `setClauses` -- NEVER touched by usageRecord (route-
  // resolve.js's exclusive fields). Omitted from the INSERT column list,
  // they take their DDL default of NULL on a fresh row (matching "INSERT a
  // fresh row with resolved_via NULL"); omitted from the UPDATE SET list,
  // they are left exactly as they were.

  const placeholders = values.map((_, i) => `$${i + 1}`);

  const sql = `
    INSERT INTO turn_usage (${columns.join(', ')})
    VALUES (${placeholders.join(', ')})
    ON CONFLICT (project_id, session_id, turn_idx, agent_role) DO UPDATE SET
      ${setClauses.join(',\n      ')}
    RETURNING *, (xmax = 0) AS inserted
  `;

  const { rows } = await pg.query(sql, values);
  const row = rows[0];
  return {
    projectId: row.project_id,
    sessionId: row.session_id,
    turnIdx: row.turn_idx,
    agentRole: row.agent_role,
    modelId: row.model_id,
    provider: row.provider,
    tokensIn: coerceNumeric(row.tokens_in),
    tokensOut: coerceNumeric(row.tokens_out),
    cacheReadTokens: coerceNumeric(row.cache_read_tokens),
    cacheWriteTokens: coerceNumeric(row.cache_write_tokens),
    costUsd: coerceNumeric(row.cost_usd),
    resolvedVia: row.resolved_via,
    recommendedModel: row.recommended_model,
    costDeltaUsd: coerceNumeric(row.cost_delta_usd),
    outcome: row.outcome,
    sourceModel: row.source_model,
    agentId: row.agent_id,
    ts: row.ts,
    created: row.inserted,
  };
}

// ─── sessionUsageRollup ──────────────────────────────────────────────────────

function coerceBreakdownEntry(entry) {
  return {
    tokens_in: coerceNumeric(entry.tokens_in),
    tokens_out: coerceNumeric(entry.tokens_out),
    cost_usd: coerceNumeric(entry.cost_usd),
    turns: coerceNumeric(entry.turns),
  };
}

function coerceBreakdown(breakdown) {
  const out = {};
  for (const [key, entry] of Object.entries(breakdown || {})) {
    out[key] = coerceBreakdownEntry(entry);
  }
  return out;
}

/**
 * @param {import('pg').Client|import('pg').Pool} pg
 * @param {{ projectId: string, sessionId: string }} args
 * @returns {Promise<object>} the post-write session_usage row (camelCase, numeric-coerced)
 */
async function sessionUsageRollup(pg, args = {}) {
  const projectId = requireNonEmptyString(args.projectId, 'projectId');
  const sessionId = requireNonEmptyString(args.sessionId, 'sessionId');

  await assertNoReservedNoneRows(pg, projectId, sessionId);

  // A-11: ONE SQL statement -- a single internally-consistent snapshot.
  // per_model/totals/breakdown are CTEs of the SAME statement, not separate
  // queries. Aggregates over zero input rows (A-17, the zero-turn case)
  // return exactly one row each: SUM(...) -> NULL, COUNT(*) -> 0,
  // jsonb_object_agg(...) over zero groups -> NULL, coalesced to '{}'.
  const sql = `
    WITH per_model AS (
      SELECT
        COALESCE(model_id, '${RESERVED_MODEL_SENTINEL}') AS model_key,
        SUM(tokens_in)  AS tokens_in,
        SUM(tokens_out) AS tokens_out,
        SUM(cost_usd)   AS cost_usd,
        COUNT(*)        AS turns
      FROM turn_usage
      WHERE project_id = $1 AND session_id = $2
      GROUP BY COALESCE(model_id, '${RESERVED_MODEL_SENTINEL}')
    ),
    totals AS (
      SELECT
        SUM(tokens_in)  AS total_tokens_in,
        SUM(tokens_out) AS total_tokens_out,
        SUM(cost_usd)   AS total_cost_usd,
        COUNT(*)        AS turn_count
      FROM turn_usage
      WHERE project_id = $1 AND session_id = $2
    ),
    breakdown AS (
      SELECT COALESCE(
        jsonb_object_agg(
          model_key,
          jsonb_build_object('tokens_in', tokens_in, 'tokens_out', tokens_out, 'cost_usd', cost_usd, 'turns', turns)
        ),
        '{}'::jsonb
      ) AS model_breakdown
      FROM per_model
    )
    INSERT INTO session_usage (project_id, session_id, model_breakdown, total_tokens_in, total_tokens_out, total_cost_usd, turn_count, computed_at)
    SELECT $1, $2, breakdown.model_breakdown, totals.total_tokens_in, totals.total_tokens_out, totals.total_cost_usd, totals.turn_count, NOW()
    FROM totals, breakdown
    ON CONFLICT (project_id, session_id) DO UPDATE SET
      model_breakdown  = EXCLUDED.model_breakdown,
      total_tokens_in  = EXCLUDED.total_tokens_in,
      total_tokens_out = EXCLUDED.total_tokens_out,
      total_cost_usd   = EXCLUDED.total_cost_usd,
      turn_count       = EXCLUDED.turn_count,
      computed_at       = EXCLUDED.computed_at
    RETURNING *
  `;

  // total_cost_usd is NUMERIC(12,6) same as turn_usage.cost_usd; each
  // individual contributing cost_usd was already range-checked at
  // usageRecord write time, but their SUM can still exceed the column's
  // range. Rather than a redundant pre-check read, this catches Postgres's
  // own 22003 (numeric_value_out_of_range) at the single write statement
  // and rethrows it as the same named CostOutOfRangeError -- no raw driver
  // error ever escapes this module.
  let rows;
  try {
    ({ rows } = await pg.query(sql, [projectId, sessionId]));
  } catch (err) {
    if (err && err.code === '22003') {
      throw new CostOutOfRangeError(
        `usage-telemetry: sessionUsageRollup aggregate cost out of range for NUMERIC(12,6) ` +
        `(project=${projectId} session=${sessionId}, max magnitude ${MAX_NUMERIC_12_6}) -- underlying Postgres error: ${err.message}`
      );
    }
    throw err;
  }
  const row = rows[0];
  return {
    projectId: row.project_id,
    sessionId: row.session_id,
    modelBreakdown: coerceBreakdown(row.model_breakdown),
    totalTokensIn: coerceNumeric(row.total_tokens_in),
    totalTokensOut: coerceNumeric(row.total_tokens_out),
    totalCostUsd: coerceNumeric(row.total_cost_usd),
    turnCount: coerceNumeric(row.turn_count),
    computedAt: row.computed_at,
  };
}

// ─── usageQuery ──────────────────────────────────────────────────────────────

// A-12: 'day' computed once, in SQL, in UTC -- no driver-side re-derivation.
const GROUP_BY_COLUMN = Object.freeze({
  model: `COALESCE(model_id, '${RESERVED_MODEL_SENTINEL}')`,
  role: `COALESCE(agent_role, '${RESERVED_MODEL_SENTINEL}')`,
  provider: `COALESCE(provider, '${RESERVED_MODEL_SENTINEL}')`,
  day: `to_char(ts AT TIME ZONE 'UTC', 'YYYY-MM-DD')`,
});

async function usageQuerySessionScoped(pg, { projectId, sessionId, groupBy }) {
  await assertNoReservedNoneRows(pg, projectId, sessionId);

  const keyExpr = GROUP_BY_COLUMN[groupBy];
  const { rows } = await pg.query(
    `SELECT ${keyExpr} AS key,
            SUM(tokens_in)  AS tokens_in,
            SUM(tokens_out) AS tokens_out,
            SUM(cost_usd)   AS cost_usd,
            COUNT(*)        AS turns
       FROM turn_usage
      WHERE project_id = $1 AND session_id = $2
      GROUP BY ${keyExpr}
      ORDER BY SUM(cost_usd) DESC NULLS LAST, key ASC`,
    [projectId, sessionId]
  );

  return rows.map((row) => ({
    key: row.key,
    tokens_in: coerceNumeric(row.tokens_in),
    tokens_out: coerceNumeric(row.tokens_out),
    cost_usd: coerceNumeric(row.cost_usd),
    turns: coerceNumeric(row.turns),
  }));
}

/** SQL SUM semantics for merging across session_usage.model_breakdown maps: NULL+NULL=NULL, otherwise NULLs ignored (never coerced to 0). */
function sumPreserveNull(a, b) {
  if (a === null && b === null) return null;
  return (a || 0) + (b || 0);
}

function costDescNullsLast(a, b) {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return b - a;
}

async function usageQueryProjectScoped(pg, { projectId, groupBy }) {
  if (groupBy !== 'model') {
    throw new Error(
      `usage-telemetry: project-scoped usageQuery (no sessionId) supports groupBy='model' only (got ${JSON.stringify(groupBy)}) ` +
      '-- per-role/provider/day detail lives in turn_usage and requires a sessionId; session_usage rollups carry no such dimensions to fabricate an answer from.'
    );
  }

  // STALENESS BY DESIGN: reads session_usage ONLY -- never falls back to
  // scanning turn_usage for sessions with no rollup yet.
  const { rows } = await pg.query(
    `SELECT model_breakdown FROM session_usage WHERE project_id = $1`,
    [projectId]
  );

  const merged = new Map();
  for (const row of rows) {
    const breakdown = row.model_breakdown || {};
    for (const [key, entry] of Object.entries(breakdown)) {
      const acc = merged.get(key) || { tokens_in: null, tokens_out: null, cost_usd: null, turns: null };
      acc.tokens_in = sumPreserveNull(acc.tokens_in, coerceNumeric(entry.tokens_in));
      acc.tokens_out = sumPreserveNull(acc.tokens_out, coerceNumeric(entry.tokens_out));
      acc.cost_usd = sumPreserveNull(acc.cost_usd, coerceNumeric(entry.cost_usd));
      acc.turns = sumPreserveNull(acc.turns, coerceNumeric(entry.turns));
      merged.set(key, acc);
    }
  }

  const result = [...merged.entries()].map(([key, v]) => ({ key, ...v }));
  result.sort((a, b) => {
    const costDiff = costDescNullsLast(a.cost_usd, b.cost_usd);
    if (costDiff !== 0) return costDiff;
    return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
  });
  return result;
}

/**
 * @param {import('pg').Client|import('pg').Pool} pg
 * @param {{ projectId: string, sessionId?: string|null, groupBy?: string|null }} args
 * @returns {Promise<Array<{ key: string, tokens_in: number|null, tokens_out: number|null, cost_usd: number|null, turns: number }>>}
 */
async function usageQuery(pg, args = {}) {
  const projectId = requireNonEmptyString(args.projectId, 'projectId');
  const sessionId = args.sessionId === undefined || args.sessionId === null ? null : requireNonEmptyString(args.sessionId, 'sessionId');
  const groupBy = args.groupBy === undefined || args.groupBy === null ? 'model' : args.groupBy;

  if (!VALID_GROUP_BY.includes(groupBy)) {
    throw new Error(`usage-telemetry: "groupBy" must be one of ${JSON.stringify(VALID_GROUP_BY)} (got ${JSON.stringify(groupBy)})`);
  }

  if (sessionId !== null) {
    return usageQuerySessionScoped(pg, { projectId, sessionId, groupBy });
  }
  return usageQueryProjectScoped(pg, { projectId, groupBy });
}

module.exports = {
  usageRecord,
  sessionUsageRollup,
  usageQuery,
  VALID_OUTCOMES,
  VALID_GROUP_BY,
  RESERVED_MODEL_SENTINEL,
  coerceNumeric,
  round6,
  MAX_NUMERIC_12_6,
  CostOutOfRangeError,
  // Exported test seams (not part of the "public" three-function surface,
  // but useful for direct unit exercise without a full call).
  computeServerSideCost,
  assertNoReservedNoneRows,
  sumPreserveNull,
  assertCostWithinRange,
  // Exported for reuse (2026-09-06, §17 B1 spec F-9): model_registry_set
  // (scripts/lib/routing-write-surface.js) reuses this exact three-way
  // undefined/null/finite-number-≥0 validation shape for cost_in_per_mtok/
  // cost_out_per_mtok, rather than re-implementing an equivalent check that
  // could silently drift from this one over time. It additionally applies
  // its OWN tighter NUMERIC(10,4) range check on top (model_registry's cost
  // columns are NUMERIC(10,4), not turn_usage's NUMERIC(12,6) — reusing
  // MAX_NUMERIC_12_6's bound as-is would let a value through this function
  // that Postgres then rejects with a raw, less actionable overflow error).
  COST_MODE,
  normalizeCostUsd,
};
