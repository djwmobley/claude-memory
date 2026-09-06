'use strict';

/**
 * scripts/lib/routing-write-surface.js — §17 B1 (CONSOLIDATION-RUNBOOK.md
 * §17, 2026-09-06 gap-audit + spec-adversary). Closes the two MISSING rows
 * the gap-audit found: no way to register a model, and no way to write a
 * session override, through the MCP surface — precedence step 2 of
 * route-resolve.js's directive chain (`routing_session_overrides`) was
 * unreachable without hand-written SQL until this file existed.
 *
 * `model_registry_set` — upsert-on-label. `routing_session_override_set` /
 * `_get` / `_clear` — the session-scoped directive tier route-resolve.js's
 * `resolveDirective` already reads (see route-resolve.js lines ~330+).
 *
 * IDENTITY NORMALIZATION: every label/role/session_id/project_id this file
 * writes or reads goes through scripts/lib/routing-identity.js's ONE
 * normalization engine — the SAME functions route-resolve.js's read sites
 * now apply (F-1). A value written here is guaranteed findable by
 * route_resolve, and vice versa.
 *
 * Every function here is a single already-classified operation — no
 * allow-lists, no positional/contiguity assumptions (CLAUDE.md's validation-
 * gate rule): unknown top-level argument keys are the explicit reject-with-
 * reason default branch, not a silently-ignored extra.
 */

const routingIdentity = require('./routing-identity.js');
const usageTelemetryLib = require('./usage-telemetry.js');

class RoutingWriteSurfaceError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'RoutingWriteSurfaceError';
    this.code = code;
  }
}

function reject(reason) {
  throw new RoutingWriteSurfaceError('validation', `routing-write-surface: ${reason}`);
}

function rejectUnknownKeys(args, allowedKeys, fnName) {
  const unknown = Object.keys(args || {}).filter((k) => !allowedKeys.has(k));
  if (unknown.length > 0) {
    reject(`${fnName}: unknown argument(s): ${unknown.join(', ')} (allowed: ${[...allowedKeys].join(', ')})`);
  }
}

// ─── model_registry_set (T2) ───────────────────────────────────────────────

const CAPABILITY_TIERS = Object.freeze(['high', 'mid', 'low']);

// model_registry's cost columns are NUMERIC(10,4) — NOT turn_usage's
// NUMERIC(12,6). Reusing MAX_NUMERIC_12_6 as-is would let a value through
// that Postgres then rejects with a raw, less actionable overflow error.
const MAX_NUMERIC_10_4 = 999999.9999;

const MODEL_REGISTRY_SET_KEYS = new Set([
  'label', 'modelId', 'provider', 'capabilityTier',
  'costInPerMtok', 'costOutPerMtok', 'contextWindow', 'headlessCliCmd',
  'available', 'kind', 'notes', 'force', 'configuredBy',
]);

/**
 * undefined -> {touched:false} (leave the column untouched on UPDATE, DB
 * default/NULL on INSERT). null -> {touched:true, value:null} (explicit
 * clear). Anything else is passed to `validate`, which must return the
 * DB-ready value or call `reject`.
 */
function classifyOptionalField(value, validate) {
  if (value === undefined) return { touched: false, value: undefined };
  if (value === null) return { touched: true, value: null };
  return { touched: true, value: validate(value) };
}

function validateNonEmptyStringField(value, name) {
  if (typeof value !== 'string') reject(`"${name}" must be a string or null when given (got ${JSON.stringify(value)})`);
  return value;
}

function validateCapabilityTierField(value) {
  if (!CAPABILITY_TIERS.includes(value)) {
    reject(`"capabilityTier" must be one of ${JSON.stringify(CAPABILITY_TIERS)} (got ${JSON.stringify(value)})`);
  }
  return value;
}

/** F-9: reuses usage-telemetry.js's normalizeCostUsd for the finite/≥0 shape, then applies model_registry's own tighter NUMERIC(10,4) range check. */
function validateRegistryCostField(value, name) {
  // normalizeCostUsd's undefined/null branches are unreachable here —
  // classifyOptionalField already filters those out before calling
  // `validate` — only the "a real value was given" branch executes, so its
  // COMPUTE/FORCE_NULL modes never apply; VALUE is the only mode reached.
  const normalized = usageTelemetryLib.normalizeCostUsd(value);
  if (normalized.mode !== usageTelemetryLib.COST_MODE.VALUE) {
    // Defensive — cannot happen given the caller-side filtering above, but
    // never silently fall through if it somehow did.
    reject(`"${name}" must be a finite non-negative number when given (got ${JSON.stringify(value)})`);
  }
  if (normalized.value > MAX_NUMERIC_10_4) {
    reject(`"${name}" out of range for model_registry's NUMERIC(10,4) column: ${normalized.value} (max ${MAX_NUMERIC_10_4})`);
  }
  return normalized.value;
}

function validateContextWindowField(value) {
  if (!(Number.isInteger(value) && value > 0)) {
    reject(`"contextWindow" must be a positive integer when given (got ${JSON.stringify(value)})`);
  }
  return value;
}

function validateAvailableField(value) {
  // available is NOT NULL in the DDL — undefined (untouched) is the only
  // way to skip it; null is rejected here rather than silently coerced or
  // silently accepted as a constraint-violation surprise from Postgres.
  if (value === null) reject('"available" must be a boolean, not null (the column is NOT NULL — use `false` to mark a model unavailable)');
  if (typeof value !== 'boolean') reject(`"available" must be a boolean when given (got ${JSON.stringify(value)}) — never coerced from a truthy/falsy value`);
  return value;
}

/**
 * model_registry_set(args) — upsert keyed on normalized label.
 *
 * TOTAL CLASSIFICATION (label): non-empty after trim+NFC -> accept;
 * empty/whitespace-only/non-string/missing -> reject-with-reason.
 *
 * TOTAL CLASSIFICATION (modelId, F-2/F-3): omitted -> untouched; existing
 * row has a DIFFERENT non-NULL model_id and force is not true -> reject
 * (re-pointing protection); the SAME model_id already used by a DIFFERENT
 * label and force is not true -> reject (duplicate-alias protection);
 * explicit null -> clears the column (never treated as "re-pointing" —
 * there is nothing left to collide with once cleared).
 *
 * TOTAL CLASSIFICATION (capabilityTier): omitted -> untouched; null ->
 * clear; one of high/mid/low -> accept; anything else -> reject BEFORE
 * hitting the DB's own CHECK constraint (a clean message, not a raw
 * constraint-violation error).
 *
 * TOTAL CLASSIFICATION (costInPerMtok/costOutPerMtok, F-9): omitted ->
 * untouched; null -> explicit clear; finite number >= 0 within
 * NUMERIC(10,4) range -> accept; negative/NaN/Infinity/string/out-of-range
 * -> reject, never coerced.
 *
 * TOTAL CLASSIFICATION (contextWindow): omitted -> untouched; null ->
 * clear (nullable column); positive integer -> accept;
 * zero/negative/non-integer/string -> reject.
 *
 * TOTAL CLASSIFICATION (available): omitted -> untouched (DB default true
 * applies on INSERT); boolean -> accept; anything else (incl. null, since
 * the column is NOT NULL) -> reject, never coerced from truthiness.
 *
 * TOTAL CLASSIFICATION (provider/kind/headlessCliCmd/notes): omitted ->
 * untouched; null -> clear; string -> accept; anything else -> reject.
 *
 * configuredBy: optional caller-supplied string, nullable, no derivation
 * (F-11 — no server-side agent identity exists anywhere in this MCP
 * surface to draw from). ALWAYS stamped on every write (reflects who made
 * THIS write, not "leave untouched" like the other optional fields) —
 * omitted stores NULL, matching configured_at's own always-stamped
 * behavior; never fabricated to a placeholder like 'unknown'.
 *
 * unknown/extra top-level key -> reject-with-reason, naming them.
 */
async function modelRegistrySet(client, args) {
  rejectUnknownKeys(args, MODEL_REGISTRY_SET_KEYS, 'model_registry_set');

  const label = routingIdentity.requireNormalizedNonEmpty(args.label, 'label', routingIdentity.normLabel);
  const force = args.force === undefined ? false : args.force;
  if (typeof force !== 'boolean') reject(`"force" must be a boolean when given (got ${JSON.stringify(args.force)})`);
  const configuredBy = args.configuredBy === undefined ? null : args.configuredBy;
  if (configuredBy !== null && typeof configuredBy !== 'string') {
    reject(`"configuredBy" must be a string or null/omitted when given (got ${JSON.stringify(args.configuredBy)})`);
  }

  const fields = {
    model_id: classifyOptionalField(args.modelId, (v) => validateNonEmptyStringField(v, 'modelId')),
    provider: classifyOptionalField(args.provider, (v) => validateNonEmptyStringField(v, 'provider')),
    capability_tier: classifyOptionalField(args.capabilityTier, validateCapabilityTierField),
    cost_in_per_mtok: classifyOptionalField(args.costInPerMtok, (v) => validateRegistryCostField(v, 'costInPerMtok')),
    cost_out_per_mtok: classifyOptionalField(args.costOutPerMtok, (v) => validateRegistryCostField(v, 'costOutPerMtok')),
    context_window: classifyOptionalField(args.contextWindow, validateContextWindowField),
    headless_cli_cmd: classifyOptionalField(args.headlessCliCmd, (v) => validateNonEmptyStringField(v, 'headlessCliCmd')),
    available: classifyOptionalField(args.available, validateAvailableField),
    kind: classifyOptionalField(args.kind, (v) => validateNonEmptyStringField(v, 'kind')),
    notes: classifyOptionalField(args.notes, (v) => validateNonEmptyStringField(v, 'notes')),
  };

  await client.query('BEGIN');
  try {
    const { rows: existingRows } = await client.query(
      `SELECT * FROM model_registry WHERE label = $1 FOR UPDATE`,
      [label]
    );
    const existing = existingRows[0] || null;

    // F-2: re-pointing an existing non-NULL model_id to a DIFFERENT value.
    if (fields.model_id.touched && fields.model_id.value !== null && existing &&
        existing.model_id !== null && existing.model_id !== fields.model_id.value && !force) {
      reject(
        `label "${label}" already points to model_id "${existing.model_id}"; pass force:true to ` +
        `re-point it to "${fields.model_id.value}" (the prior value is not preserved anywhere once ` +
        'overwritten — any turn_usage/routing_session_overrides rows recorded under the OLD model_id ' +
        'will read as if this label had always pointed at the new one)'
      );
    }

    // F-3: the SAME model_id already used by a DIFFERENT label.
    if (fields.model_id.touched && fields.model_id.value !== null) {
      const { rows: dupRows } = await client.query(
        `SELECT label FROM model_registry WHERE model_id = $1 AND label <> $2`,
        [fields.model_id.value, label]
      );
      if (dupRows.length > 0 && !force) {
        reject(
          `model_id "${fields.model_id.value}" is already used by label(s): ${dupRows.map((r) => r.label).join(', ')} — ` +
          'pass force:true to allow this alias (route_resolve\'s least-cost recommender joins on label only, so two ' +
          'labels sharing a model_id can be priced/tiered independently, which may not be intended)'
        );
      }
    }

    const touchedCols = Object.entries(fields).filter(([, f]) => f.touched);

    let row;
    if (existing) {
      const setClauses = touchedCols.map(([col], i) => `${col} = $${i + 2}`);
      setClauses.push('configured_by = $' + (touchedCols.length + 2));
      setClauses.push('configured_at = NOW()');
      setClauses.push('last_seen = NOW()');
      const vals = [label, ...touchedCols.map(([, f]) => f.value), configuredBy];
      const { rows } = await client.query(
        `UPDATE model_registry SET ${setClauses.join(', ')} WHERE label = $1 RETURNING *`,
        vals
      );
      row = rows[0];
    } else {
      const cols = ['label', ...touchedCols.map(([col]) => col), 'configured_by'];
      const vals = [label, ...touchedCols.map(([, f]) => f.value), configuredBy];
      const placeholders = vals.map((_, i) => `$${i + 1}`);
      cols.push('configured_at');
      placeholders.push('NOW()');
      const { rows } = await client.query(
        `INSERT INTO model_registry (${cols.join(', ')}) VALUES (${placeholders.join(', ')}) RETURNING *`,
        vals
      );
      row = rows[0];
    }

    await client.query('COMMIT');
    return {
      id: row.id,
      label: row.label,
      model_id: row.model_id,
      provider: row.provider,
      capability_tier: row.capability_tier,
      cost_in_per_mtok: row.cost_in_per_mtok === null ? null : Number(row.cost_in_per_mtok),
      cost_out_per_mtok: row.cost_out_per_mtok === null ? null : Number(row.cost_out_per_mtok),
      context_window: row.context_window,
      headless_cli_cmd: row.headless_cli_cmd,
      available: row.available,
      kind: row.kind,
      notes: row.notes,
      configured_by: row.configured_by,
      configured_at: row.configured_at,
      created: !existing,
    };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  }
}

// ─── routing_session_override_set / _get / _clear (T1) ─────────────────────

/**
 * F-4: '*' is reserved for routing_profiles' project-scoped global-default
 * sentinel — routing_session_overrides has NO session-level equivalent of a
 * global scope (no `session_id = '*'` concept exists anywhere in the
 * schema). A '*' projectId/sessionId here would create a real row that
 * route_resolve's session-override read (scoped by the caller's REAL
 * project/session) can never read back — a permanently orphaned row.
 * Rejected uniformly across set/get/clear for validation consistency, even
 * though get/clear with '*' cannot itself create an orphan (a rejected
 * input here is friction, never a silent no-op that could be mistaken for
 * "no override configured").
 */
function requireSessionScopeIds(projectIdRaw, sessionIdRaw) {
  const projectId = routingIdentity.requireNormalizedNonEmpty(projectIdRaw, 'projectId', routingIdentity.normId);
  if (projectId === '*') {
    reject("projectId cannot be '*' — session overrides are per-project; '*' is reserved for routing_profiles' global-default pin and has no meaning here");
  }
  const sessionId = routingIdentity.requireNormalizedNonEmpty(sessionIdRaw, 'sessionId', routingIdentity.normId);
  if (sessionId === '*') {
    reject("sessionId cannot be '*' — sessions have no global-scope concept");
  }
  return { projectId, sessionId };
}

const SESSION_OVERRIDE_SET_KEYS = new Set(['projectId', 'sessionId', 'role', 'label', 'provider', 'setBy']);
const SESSION_OVERRIDE_GET_KEYS = new Set(['projectId', 'sessionId', 'role']);
const SESSION_OVERRIDE_CLEAR_KEYS = new Set(['projectId', 'sessionId', 'role']);

/**
 * routing_session_override_set(args) -> upsert on (project_id, session_id,
 * role), the table's own UNIQUE key. route_resolve's directive chain reads
 * this exact key (route-resolve.js's resolveDirective) — this is the ONLY
 * write path for it (route_resolve never mutates schema).
 *
 * TOTAL CLASSIFICATION: projectId/sessionId non-empty and not '*' -> accept;
 * '*' or empty/non-string/missing -> reject (F-4). role non-empty (any
 * string, no taxonomy check — see route-resolve.js's own documented
 * no-hardcoded-roles design; a CHECK/allow-list here would contradict it,
 * F-5) -> accept; empty/non-string/missing -> reject. label non-empty,
 * NORMALIZED, and present in model_registry -> accept; not registered ->
 * reject naming the missing label (F-1: the label is looked up in its
 * NORMALIZED form, matching model_registry_set's write-time normalization);
 * empty/non-string/missing -> reject (the column is NOT NULL). provider any
 * string or omitted -> accept. setBy any string or omitted -> accept,
 * nullable, no derivation (F-11). No TTL, no expiry — clearing an override
 * at session end is the CALLER's responsibility (F-8); this tool does not
 * and cannot reap stale rows on its own. unknown/extra top-level key ->
 * reject-with-reason.
 */
async function routingSessionOverrideSet(client, args) {
  rejectUnknownKeys(args, SESSION_OVERRIDE_SET_KEYS, 'routing_session_override_set');

  const { projectId, sessionId } = requireSessionScopeIds(args.projectId, args.sessionId);
  const role = routingIdentity.requireNormalizedNonEmpty(args.role, 'role', routingIdentity.normRole);
  const label = routingIdentity.requireNormalizedNonEmpty(args.label, 'label', routingIdentity.normLabel);

  const provider = args.provider === undefined ? null : args.provider;
  if (provider !== null && typeof provider !== 'string') {
    reject(`"provider" must be a string or null/omitted when given (got ${JSON.stringify(args.provider)})`);
  }
  const setBy = args.setBy === undefined ? null : args.setBy;
  if (setBy !== null && typeof setBy !== 'string') {
    reject(`"setBy" must be a string or null/omitted when given (got ${JSON.stringify(args.setBy)})`);
  }

  const { rows: modelRows } = await client.query(`SELECT label FROM model_registry WHERE label = $1`, [label]);
  if (modelRows.length === 0) {
    reject(`label "${label}" is not registered in model_registry — call model_registry_set first, then retry this override`);
  }

  const { rows } = await client.query(
    `INSERT INTO routing_session_overrides (project_id, session_id, role, model_id, provider, set_by)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (project_id, session_id, role) DO UPDATE SET
       model_id = EXCLUDED.model_id, provider = EXCLUDED.provider, set_by = EXCLUDED.set_by, set_at = NOW()
     RETURNING id, project_id, session_id, role, model_id, provider, set_by, set_at`,
    [projectId, sessionId, role, label, provider, setBy]
  );
  return rows[0];
}

/**
 * routing_session_override_get(args) -> lists active overrides for a
 * session (role omitted -> every role for that project+session), without
 * side effects (never a substitute for calling route_resolve — this is a
 * read-only peek at what T1 has written, addressing F-6's usability gap:
 * before this existed, the only way to see what override was active was to
 * call route_resolve itself, which has the side effect of finalizing that
 * turn's resolution).
 */
async function routingSessionOverrideGet(client, args) {
  rejectUnknownKeys(args, SESSION_OVERRIDE_GET_KEYS, 'routing_session_override_get');
  const { projectId, sessionId } = requireSessionScopeIds(args.projectId, args.sessionId);

  let role = null;
  if (args.role !== undefined && args.role !== null) {
    role = routingIdentity.requireNormalizedNonEmpty(args.role, 'role', routingIdentity.normRole);
  }

  const { rows } = await client.query(
    `SELECT id, project_id, session_id, role, model_id, provider, set_by, set_at
       FROM routing_session_overrides
      WHERE project_id = $1 AND session_id = $2 AND ($3::text IS NULL OR role = $3)
      ORDER BY role`,
    [projectId, sessionId, role]
  );
  return rows;
}

/**
 * routing_session_override_clear(args) -> deletes the (project_id,
 * session_id, role) row if present. TOTAL CLASSIFICATION (F-7): a row
 * existed and was deleted -> {cleared:true}; no row matched -> {cleared:
 * false} — NOT an error; clearing an already-clear state is idempotent by
 * definition. role is REQUIRED (unlike _get) — clearing targets exactly one
 * row of the table's UNIQUE key, never a whole-session wildcard delete.
 */
async function routingSessionOverrideClear(client, args) {
  rejectUnknownKeys(args, SESSION_OVERRIDE_CLEAR_KEYS, 'routing_session_override_clear');
  const { projectId, sessionId } = requireSessionScopeIds(args.projectId, args.sessionId);
  const role = routingIdentity.requireNormalizedNonEmpty(args.role, 'role', routingIdentity.normRole);

  const { rowCount } = await client.query(
    `DELETE FROM routing_session_overrides WHERE project_id = $1 AND session_id = $2 AND role = $3`,
    [projectId, sessionId, role]
  );
  return { cleared: rowCount > 0 };
}

module.exports = {
  RoutingWriteSurfaceError,
  modelRegistrySet,
  routingSessionOverrideSet,
  routingSessionOverrideGet,
  routingSessionOverrideClear,
  // Exported test seams / constants.
  CAPABILITY_TIERS,
  MAX_NUMERIC_10_4,
};
