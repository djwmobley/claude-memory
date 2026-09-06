'use strict';

/**
 * scripts/lib/route-resolve.js
 *
 * Least-cost routing resolver (runbook §17.1/§17.2). Given a turn's
 * identity (project, session, turn index, agent role), resolves which
 * model/provider that turn should use and records the decision exactly
 * once in `turn_usage`. CommonJS, plain `pg` client (Client or Pool)
 * passed in by the caller — this library never opens, owns, or closes a
 * database connection. NOTE (2026-09-06, §17.1.1): when `agentId` is
 * supplied, routeResolve issues `BEGIN`/`pg_advisory_xact_lock`/`COMMIT`/
 * `ROLLBACK` on the SAME `pg` argument (matching routing-profile.js's M-18
 * pattern) — this requires a single persistent connection (a `Client`, or a
 * `PostgresAdapter`-style single-connection wrapper, as every caller in this
 * repo already passes); a raw `pg.Pool` would checkout a different
 * connection per query and silently break the transaction. Every existing
 * caller (handoff-mcp.mjs's `withProjectDb`, every verify- and test-
 * harness under scripts/migrations and test/migrations) already passes a
 * single-connection object, so this is a documented constraint, not a
 * behavior change.
 *
 * RESOLUTION PRECEDENCE (routeResolve), first hit wins:
 *   1. Idempotent replay — a turn_usage row already exists for this exact
 *      (project_id, session_id, turn_idx, agent_role) key. Returned
 *      unchanged; a second call for the same key never re-resolves.
 *   2. Directive chain (resolved_via='directive'): overrideModel argument,
 *      then routing_session_overrides, then an active project-scoped
 *      routing_profiles pin, then an active '*'-scoped (global default)
 *      routing_profiles pin. The directive chain performs NO tier check —
 *      operator intent wins outright — but a registered directive model
 *      below the required tier is flagged in `rationale`.
 *   3. No directive → recommendLeastCost (resolved_via='recommendation').
 *
 * REQUIRED-TIER RESOLUTION (resolveRequiredTier) is a SEPARATE, total
 * classification: explicit capabilityTier argument, then an active
 * project-scoped routing_profiles.capability_tier, then an active
 * '*'-scoped routing_profiles.capability_tier. Nothing else — a miss is a
 * hard error naming the role. The §17.1.1 role→tier suggestion table
 * (orchestrate/spec=high, draft/write=mid, read/index/bookkeep=low,
 * review=high) is an install-time Q&A SUGGESTION per the owner's
 * no-silent-defaults directive (§17.1.2) and deliberately does NOT exist
 * as a fallback table/map/object anywhere in this file — its content
 * appears only as prose in the hard-error remediation hint below, never as
 * an applied value.
 *
 * "THE" ACTIVE ROW: every routing_profiles lookup in this file — both the
 * directive chain and resolveRequiredTier, both (project_id, role) and
 * ('*', role) — is `... WHERE active = true [AND preferred_model IS NOT
 * NULL where applicable] ORDER BY version DESC LIMIT 1`. Multiple active
 * versions can legitimately coexist; highest version wins, deterministically,
 * everywhere. '*' is matched ONLY as this literal sentinel project_id, at
 * these lookup steps — never as a wildcard anywhere else in this file.
 *
 * REGISTRY JOIN KEY: model_registry is joined exclusively on `label` (NOT
 * NULL UNIQUE). turn_usage.model_id and routing_session_overrides.model_id
 * hold strings that conventionally match model_registry.label (per
 * migrate-11-usage-telemetry.sql's own header comment). migrate-10's
 * model_registry.model_id column (the provider's own identifier string, no
 * uniqueness) is UNUSED by this resolver.
 *
 * IDENTITY NORMALIZATION (2026-09-06, §17 B1 spec-adversary F-1): every
 * identity key this file looks up (label, role, session_id, project_id)
 * is normalized via scripts/lib/routing-identity.js's normLabel/normRole/
 * normId — the SAME functions routing-write-surface.js's model_registry_set
 * / routing_session_override_set apply at write time. `routeResolve` and
 * `resolveRequiredTier` normalize projectId/sessionId/role ONCE at entry
 * (immediately after presence validation) and thread the normalized values
 * through every downstream query, including the turn_usage replay/insert —
 * so a session/project/role identity that differs only in leading/trailing
 * whitespace resolves to the SAME turn_usage row and the SAME directive
 * lookups. `lookupRegistryByLabel`, `fetchActiveProfile`, and
 * `fetchActivePin` additionally normalize their own arguments directly
 * (defense in depth — they are exported test seams that can be called
 * without going through routeResolve/resolveRequiredTier first). Before
 * this fix, every lookup here was a raw byte-exact `=` with nothing to
 * "share" despite T1/T2's spec assuming a shared engine already existed.
 *
 * PROVIDER RESOLUTION is a 3-step total classification, applied whenever a
 * directive supplies the model: (1) the directive row's own provider
 * column when non-NULL (routing_session_overrides.provider /
 * routing_profiles.preferred_provider — operator-supplied for possibly-
 * unregistered models); (2) else model_registry.provider for the chosen
 * label when registered; (3) else NULL. The bare overrideModel argument
 * (a plain string, no provider field) always skips step 1.
 *
 * NUMERIC COERCION (load-bearing): node-postgres returns NUMERIC columns
 * as strings. Every cost value read from the database is coerced via
 * `coerceCost` (NULL preserved as null, never coerced to 0) before any
 * comparison, sum, or subtraction. Before a cost_delta_usd value is
 * written to turn_usage, `Number.isFinite` is asserted — a non-finite
 * result is written as NULL (unknown), never as NaN.
 *
 * PERSISTENCE / RACE HANDLING: the resolver's ONLY write is a single
 * `INSERT ... ON CONFLICT (project_id, session_id, turn_idx, agent_role)
 * DO NOTHING` into turn_usage. If the insert reports rowCount === 0 (a
 * concurrent resolver won the key), the winner's row is re-selected and
 * returned with replayed:true — the caller never receives values that
 * differ from what the table holds. This is the entire idempotency
 * mechanism; no advisory locks are used.
 *
 * §17.1.1 REVIEW-IDENTITY ENFORCEMENT (2026-09-06, closes G4,
 * docs/notes/2026-09-06-s17-routing-gap-audit.md): an OPTIONAL `agentId`
 * argument lets a caller identify WHICH agent is making this turn's call.
 * When supplied, routeResolve enforces — session-scoped, bidirectional,
 * case-folded — that a 'review' turn never shares an agent identity with
 * any non-review turn in the SAME (project_id, session_id), and vice versa;
 * same-role repeats (review-after-review, draft-after-draft, ...) never
 * collide. A collision is a hard REVIEW_IDENTITY_COLLISION error, thrown
 * after the idempotent-replay check and before the turn_usage INSERT — it
 * never silently downgrades or flags-only. `agentId` omitted resolves
 * exactly as before (agent_id written NULL, no enforcement, response
 * carries identity_enforced:false / identity_reason:'agentId not
 * supplied') — this is a strictly additive, opt-in capability; every
 * existing caller that never passes agentId observes byte-identical
 * behavior to before this fix.
 *
 * DOCUMENTED EVASION VECTOR: enforcement is CASE-FOLDED (foldForComparison
 * = normLabel(s).toLowerCase(), plain toLowerCase, never
 * toLocaleLowerCase) but NOT homoglyph- or hyphen-variant-aware — 'Agent-1'
 * (U+002D hyphen-minus) and 'Agent‐1' (U+2010 hyphen) fold to two DIFFERENT
 * strings and will NOT be unified, so an agent that varies its own
 * identity string by such substitution can defeat this check. This is a
 * known, accepted gap (matching normLabel/normRole's own case-preserving,
 * non-Unicode-confusable-aware design), not an oversight — see
 * test/migrations/test-route-resolve-contract.js's documented-non-collision
 * case. `agentId` is capped at 256 characters (after normLabel) and must
 * not contain U+0000; both are hard errors, never silently truncated.
 * Enforcement is scoped to ONE session — it does not, and is not intended
 * to, unify identity across different session_id values or across
 * projects.
 *
 * CONCURRENCY: when `agentId` is supplied, the prior-identity SELECT and
 * the turn_usage INSERT run inside ONE transaction guarded by a
 * `pg_advisory_xact_lock(hashtext(project_id||session_id||foldedAgentId))`
 * transaction-scoped advisory lock — the SAME hashtext-keyed pattern
 * routing-profile.js's M-18 fix already uses — so two concurrent calls
 * carrying the SAME folded identity in the SAME session serialize instead
 * of racing the collision check. This lock is scoped to (project_id,
 * session_id, foldedAgentId); it does NOT serialize across different
 * sessions or projects, by design (§17's routing state is already
 * project/session-partitioned everywhere else in this file).
 *
 * This resolver still never mutates schema and never inserts into
 * model_registry / routing_profiles / routing_session_overrides.
 */

const routingIdentity = require('./routing-identity.js');

const TIER_RANK = Object.freeze({ low: 0, mid: 1, high: 2 });
const VALID_TIERS = Object.freeze(['high', 'mid', 'low']);

/** §17.1.1 review-identity enforcement (2026-09-06). */
const MAX_AGENT_ID_LENGTH = 256;

class RouteResolveError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'RouteResolveError';
    this.code = code;
  }
}

// ─── INPUT VALIDATION ────────────────────────────────────────────────────

function requireNonEmptyString(value, name) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`route-resolve: "${name}" must be a non-empty string (got ${JSON.stringify(value)})`);
  }
  return value;
}

/** Number.isInteger(turnIdx) && turnIdx >= 0 — never a truthy check (2-1). turnIdx=0 is valid. */
function requireTurnIdx(turnIdx) {
  if (!(Number.isInteger(turnIdx) && turnIdx >= 0)) {
    throw new Error(`route-resolve: "turnIdx" must be a non-negative integer (got ${JSON.stringify(turnIdx)})`);
  }
  return turnIdx;
}

/**
 * Optional-argument presence semantics (2-3): undefined/null = not given
 * (falls through the directive chain). Any other value must be valid — a
 * non-empty string — or this throws; never a silent fall-through.
 */
function normalizeOverrideModel(overrideModel) {
  if (overrideModel === undefined || overrideModel === null) return null;
  if (typeof overrideModel !== 'string' || overrideModel.length === 0) {
    throw new Error(`route-resolve: "overrideModel" must be a non-empty string when given (got ${JSON.stringify(overrideModel)})`);
  }
  return overrideModel;
}

/**
 * Optional-argument presence semantics (2-3): undefined/null = not given.
 * Any other value must be one of ('high','mid','low') or this throws.
 */
function normalizeCapabilityTier(capabilityTier) {
  if (capabilityTier === undefined || capabilityTier === null) return null;
  if (!VALID_TIERS.includes(capabilityTier)) {
    throw new Error(`route-resolve: "capabilityTier" must be one of ${JSON.stringify(VALID_TIERS)} (got ${JSON.stringify(capabilityTier)})`);
  }
  return capabilityTier;
}

/**
 * §17.1.1 review-identity enforcement (2026-09-06) — total classification:
 *   - undefined/null                              -> {supplied:false}, no enforcement.
 *   - non-string, empty, or whitespace-only        -> hard error (requireNormalizedNonEmpty).
 *   - contains U+0000                              -> hard error.
 *   - > MAX_AGENT_ID_LENGTH chars AFTER normLabel  -> hard error.
 *   - otherwise                                    -> {supplied:true, stored: normLabel(agentId)
 *     (case preserved), folded: stored.toLowerCase() (plain toLowerCase, never
 *     toLocaleLowerCase)}.
 * Never coerced — every non-undefined/null value either fully validates or throws.
 */
function normalizeAgentId(agentId) {
  if (agentId === undefined || agentId === null) {
    return { supplied: false, stored: null, folded: null };
  }
  if (typeof agentId !== 'string' || agentId.length === 0) {
    throw new RouteResolveError(
      'validation',
      `route-resolve: "agentId" must be a non-empty string when given (got ${JSON.stringify(agentId)})`
    );
  }
  if (agentId.indexOf('\u0000') !== -1) {
    throw new RouteResolveError(
      'validation',
      'route-resolve: "agentId" must not contain a NUL character (U+0000)'
    );
  }
  let stored;
  try {
    stored = routingIdentity.requireNormalizedNonEmpty(agentId, 'agentId', routingIdentity.normLabel);
  } catch (err) {
    throw new RouteResolveError('validation', `route-resolve: ${err.message}`);
  }
  if (stored.length > MAX_AGENT_ID_LENGTH) {
    throw new RouteResolveError(
      'validation',
      `route-resolve: "agentId" must be at most ${MAX_AGENT_ID_LENGTH} characters after normalization ` +
      `(got ${stored.length} characters). Dispatch the agent with a shorter identity string.`
    );
  }
  return { supplied: true, stored, folded: stored.toLowerCase() };
}

// ─── NUMERIC COERCION (3-1, load-bearing) ────────────────────────────────

/**
 * node-postgres returns NUMERIC columns as strings. Coerce to a JS Number
 * for every comparison/sum/subtraction. NULL/undefined preserved as null —
 * NEVER coerced to 0 (a cost-less model must stay distinguishable from a
 * free one).
 */
function coerceCost(x) {
  if (x === null || x === undefined) return null;
  return Number(x);
}

// ─── routing_profiles LOOKUPS ("the" active row — 1-1) ───────────────────

/** Active routing_profiles row for (projectId, role), highest version wins. Tier-only lookup (no preferred_model filter). Normalizes projectId/role (F-1) — '*' passes through normId unchanged (trim-only, already a bare sentinel). */
async function fetchActiveProfile(pg, projectId, role) {
  const normProjectId = routingIdentity.normId(projectId);
  const normRole = routingIdentity.normRole(role);
  const { rows } = await pg.query(
    `SELECT capability_tier, preferred_model, preferred_provider, version
       FROM routing_profiles
      WHERE project_id = $1 AND role = $2 AND active = true
      ORDER BY version DESC LIMIT 1`,
    [normProjectId, normRole]
  );
  return rows[0] || null;
}

/** Active routing_profiles row for (projectId, role) that also carries a pin (non-NULL preferred_model). Normalizes projectId/role (F-1). */
async function fetchActivePin(pg, projectId, role) {
  const normProjectId = routingIdentity.normId(projectId);
  const normRole = routingIdentity.normRole(role);
  const { rows } = await pg.query(
    `SELECT capability_tier, preferred_model, preferred_provider, version
       FROM routing_profiles
      WHERE project_id = $1 AND role = $2 AND active = true AND preferred_model IS NOT NULL
      ORDER BY version DESC LIMIT 1`,
    [normProjectId, normRole]
  );
  return rows[0] || null;
}

// ─── resolveRequiredTier ──────────────────────────────────────────────────

/**
 * Total classification, first hit wins: (1) explicit capabilityTier arg,
 * (2) active routing_profiles.capability_tier for (projectId, role),
 * (3) active routing_profiles.capability_tier for ('*', role). NOTHING
 * ELSE — a miss is a hard error naming the role. The §17.1.1 role-default
 * table's content is NOT applied here; it appears only as prose in the
 * remediation hint.
 *
 * @param {import('pg').Client|import('pg').Pool} pg
 * @param {{ projectId: string, role: string, capabilityTier?: string|null }} args
 * @returns {Promise<'high'|'mid'|'low'>}
 */
async function resolveRequiredTier(pg, { projectId, role, capabilityTier } = {}) {
  requireNonEmptyString(projectId, 'projectId');
  requireNonEmptyString(role, 'role');
  // F-1: normalize AFTER presence validation (so numeric/empty inputs still
  // throw the existing, tested messages) but BEFORE any lookup — a
  // whitespace-only projectId/role is rejected here too (requireNormalizedNonEmpty).
  const normProjectId = routingIdentity.requireNormalizedNonEmpty(projectId, 'projectId', routingIdentity.normId);
  const normRole = routingIdentity.requireNormalizedNonEmpty(role, 'role', routingIdentity.normRole);
  const explicitTier = normalizeCapabilityTier(capabilityTier);
  if (explicitTier) return explicitTier;

  const projectProfile = await fetchActiveProfile(pg, normProjectId, normRole);
  if (projectProfile && projectProfile.capability_tier) return projectProfile.capability_tier;

  const globalProfile = await fetchActiveProfile(pg, '*', normRole);
  if (globalProfile && globalProfile.capability_tier) return globalProfile.capability_tier;

  throw new Error(
    `unconfigured routing for role '${role}' — no active routing_profiles row sets a ` +
    "capability_tier for this role (checked project-scoped, then the '*' global default). " +
    'Configure one via the routing_profile_set MCP tool (routingProfileSet in ' +
    'scripts/lib/routing-profile.js), e.g. { projectId, role, capabilityTier }. Suggested ' +
    'per-role defaults exist only as prose (orchestrate/spec=high, draft/write=mid, ' +
    'read/index/bookkeep=low, review=high) and are never applied automatically — an ' +
    'operator must call routing_profile_set explicitly to confirm one. Candidate models ' +
    'must also be registered in model_registry before they can be recommended or pinned — ' +
    'use the model_registry_set MCP tool (§17 B1) rather than raw SQL.'
  );
}

// ─── recommendLeastCost ───────────────────────────────────────────────────

/**
 * Candidate pool: model_registry rows with available=true AND
 * capability_tier non-NULL AND rank(capability_tier) >= rank(required).
 * The RECOMMENDATION pool additionally requires both cost columns non-NULL
 * (a cost-less model can still be chosen via directive, never via
 * recommendation). Selection: lowest sufficient tier first (tier-fit
 * before cost — never reach for a higher tier because it is cheaper),
 * then (cost_in_per_mtok + cost_out_per_mtok) ascending, then label
 * ascending as the deterministic tiebreak.
 *
 * Empty-pool classification is TOTAL and distinguishes two causes:
 *   - no model at/above the required tier at all → error naming the tier
 *   - model(s) exist at/above the tier but ALL lack cost figures → a
 *     DISTINCT error naming the cost-unconfigured models (V9)
 *
 * @param {import('pg').Client|import('pg').Pool} pg
 * @param {'high'|'mid'|'low'} requiredTier
 * @returns {Promise<{ label: string, provider: string|null, cost_in_per_mtok: number, cost_out_per_mtok: number }>}
 */
async function recommendLeastCost(pg, requiredTier) {
  if (!VALID_TIERS.includes(requiredTier)) {
    throw new Error(`route-resolve: recommendLeastCost requires a valid tier, one of ${JSON.stringify(VALID_TIERS)} (got ${JSON.stringify(requiredTier)})`);
  }
  const requiredRank = TIER_RANK[requiredTier];

  const { rows } = await pg.query(
    `SELECT label, provider, capability_tier, cost_in_per_mtok, cost_out_per_mtok
       FROM model_registry
      WHERE available = true AND capability_tier IS NOT NULL`
  );

  const atOrAboveTier = rows.filter((r) => TIER_RANK[r.capability_tier] >= requiredRank);

  if (atOrAboveTier.length === 0) {
    throw new Error(
      `route-resolve: no available model at/above required tier '${requiredTier}' — model_registry has ` +
      'zero eligible rows at this tier (or is entirely empty). This is by design: every call errors until ' +
      'registration happens, never a silent downgrade.'
    );
  }

  const costed = atOrAboveTier
    .filter((r) => r.cost_in_per_mtok !== null && r.cost_out_per_mtok !== null)
    .map((r) => ({
      label: r.label,
      provider: r.provider,
      capability_tier: r.capability_tier,
      cost_in_per_mtok: coerceCost(r.cost_in_per_mtok),
      cost_out_per_mtok: coerceCost(r.cost_out_per_mtok),
    }));

  if (costed.length === 0) {
    const names = atOrAboveTier.map((r) => r.label).sort().join(', ');
    throw new Error(
      `route-resolve: model(s) at/above required tier '${requiredTier}' exist but ALL lack cost figures ` +
      `(cost_in_per_mtok/cost_out_per_mtok) — least-cost ranking stays inert for: ${names}. ` +
      'Set cost_in_per_mtok/cost_out_per_mtok for these models via the model_registry_set MCP ' +
      'tool (§17 B1). A directive can still route to one of these models via the ' +
      'routing_profile_set or routing_session_override_set MCP tools, bypassing the ' +
      'recommendation ranking entirely.'
    );
  }

  costed.sort((a, b) => {
    const rankDiff = TIER_RANK[a.capability_tier] - TIER_RANK[b.capability_tier];
    if (rankDiff !== 0) return rankDiff;
    const costDiff = (a.cost_in_per_mtok + a.cost_out_per_mtok) - (b.cost_in_per_mtok + b.cost_out_per_mtok);
    if (costDiff !== 0) return costDiff;
    if (a.label < b.label) return -1;
    if (a.label > b.label) return 1;
    return 0;
  });

  const winner = costed[0];
  return {
    label: winner.label,
    provider: winner.provider,
    cost_in_per_mtok: winner.cost_in_per_mtok,
    cost_out_per_mtok: winner.cost_out_per_mtok,
  };
}

// ─── model_registry lookup by label (5-1) ─────────────────────────────────

async function lookupRegistryByLabel(pg, label) {
  // F-1: normalize the lookup key so a directive's model string (an
  // overrideModel arg, a routing_profiles.preferred_model pin, or a
  // routing_session_overrides.model_id) finds a model_registry row
  // regardless of whether the ORIGINAL source of that string was itself
  // written through the normalized model_registry_set path — this is the
  // single point where every directive type's label converges on the
  // registry join, so normalizing here (rather than at each of those three
  // upstream write sites) covers all of them uniformly.
  const normLabel = routingIdentity.normLabel(label);
  const { rows } = await pg.query(
    `SELECT label, provider, capability_tier, cost_in_per_mtok, cost_out_per_mtok
       FROM model_registry WHERE label = $1`,
    [normLabel]
  );
  return rows[0] || null;
}

// ─── DIRECTIVE CHAIN (routeResolve step 2) ────────────────────────────────

/**
 * First hit wins: (a) overrideModel argument, (b) routing_session_overrides
 * row for (projectId, sessionId, role), (c) active project-scoped
 * routing_profiles pin, (d) active '*'-scoped (global default) pin. Returns
 * null when no directive applies (falls through to recommendation).
 */
async function resolveDirective(pg, { projectId, sessionId, role, overrideModel }) {
  if (overrideModel) {
    return { model: overrideModel, provider: null, rationale: 'per-turn override' };
  }

  // F-1: normalize before the session-override lookup — belt-and-suspenders
  // with routeResolve's own top-of-function normalization (this function is
  // also an exported test seam callable directly, bypassing routeResolve).
  const normProjectId = routingIdentity.normId(projectId);
  const normSessionId = routingIdentity.normId(sessionId);
  const normRole = routingIdentity.normRole(role);

  const { rows: sessionRows } = await pg.query(
    `SELECT model_id, provider FROM routing_session_overrides
      WHERE project_id = $1 AND session_id = $2 AND role = $3`,
    [normProjectId, normSessionId, normRole]
  );
  if (sessionRows.length > 0) {
    return {
      model: sessionRows[0].model_id,
      provider: sessionRows[0].provider,
      rationale: `session override role=${role}`,
    };
  }

  const projectPin = await fetchActivePin(pg, projectId, role);
  if (projectPin) {
    return {
      model: projectPin.preferred_model,
      provider: projectPin.preferred_provider,
      rationale: `project pin v${projectPin.version}`,
    };
  }

  const globalPin = await fetchActivePin(pg, '*', role);
  if (globalPin) {
    return {
      model: globalPin.preferred_model,
      provider: globalPin.preferred_provider,
      rationale: 'global default pin',
    };
  }

  return null;
}

// ─── turn_usage replay/persistence (2-2) ──────────────────────────────────

/** Same aliased shape used by both the step-1 replay SELECT and the race-loser re-SELECT (2-2). Now also carries agent_id (§17.1.1) for replay-time identity_conflict recomputation. */
async function selectTurnUsage(pg, projectId, sessionId, turnIdx, role) {
  // F-1: normalize — belt-and-suspenders with routeResolve's top-of-function
  // normalization (exported test seam, callable directly).
  const normProjectId = routingIdentity.normId(projectId);
  const normSessionId = routingIdentity.normId(sessionId);
  const normRole = routingIdentity.normRole(role);
  const { rows } = await pg.query(
    `SELECT model_id AS model, provider, resolved_via, recommended_model, cost_delta_usd, agent_id
       FROM turn_usage
      WHERE project_id = $1 AND session_id = $2 AND turn_idx = $3 AND agent_role = $4`,
    [normProjectId, normSessionId, turnIdx, normRole]
  );
  return rows[0] || null;
}

// ─── §17.1.1 review-identity enforcement helpers ──────────────────────────

/**
 * Every turn_usage row in this (project_id, session_id) that carries a
 * non-NULL agent_id — the full pool a collision check draws from.
 * ORDER BY turn_idx ASC so a collision message deterministically names the
 * EARLIEST colliding turn, and so `identity_enforced`'s empty-vs-non-empty
 * classification (item 4) is computed from a stable set. Exported as a test
 * seam, matching selectTurnUsage/fetchActiveProfile/fetchActivePin's own
 * exported-for-direct-exercise convention.
 */
async function fetchPriorAgentIds(pg, projectId, sessionId) {
  const normProjectId = routingIdentity.normId(projectId);
  const normSessionId = routingIdentity.normId(sessionId);
  const { rows } = await pg.query(
    `SELECT agent_role, agent_id, turn_idx
       FROM turn_usage
      WHERE project_id = $1 AND session_id = $2 AND agent_id IS NOT NULL
      ORDER BY turn_idx ASC`,
    [normProjectId, normSessionId]
  );
  return rows;
}

/**
 * Bidirectional, insertion-order-independent, case-folded collision check
 * (item 3). `currentRoleFolded`/`currentAgentIdFolded` are already
 * case-folded via routingIdentity.foldForComparison. Same-role repeats
 * (review-review, draft-draft, ...) never collide — the explicit
 * `rowRoleFolded === currentRoleFolded` skip below is belt-and-suspenders
 * with the review/non-review branch that would already exclude them.
 * Returns the first (lowest turn_idx, per fetchPriorAgentIds' ORDER BY)
 * colliding row, or null.
 */
function findIdentityCollision(priorRows, currentRoleFolded, currentAgentIdFolded) {
  const currentIsReview = currentRoleFolded === 'review';
  for (const row of priorRows) {
    const rowRoleFolded = routingIdentity.foldForComparison(row.agent_role);
    if (rowRoleFolded === currentRoleFolded) continue; // same-role repeats never collide
    const rowAgentIdFolded = routingIdentity.foldForComparison(row.agent_id);
    if (rowAgentIdFolded !== currentAgentIdFolded) continue;
    const rowIsReview = rowRoleFolded === 'review';
    if (currentIsReview && !rowIsReview) return row;
    if (!currentIsReview && rowIsReview) return row;
  }
  return null;
}

/** Replay-path identity_conflict recomputation (item 6) — shared by the
 * step-1 replay branch and the race-loser re-select branch. Runs the SAME
 * bidirectional predicate against the RECORDED row's own stored agent_id
 * (never the current call's agentId argument, mirroring how the replay
 * branch already ignores the current call's overrideModel). A recorded row
 * with no agent_id (NULL) never conflicts — nothing to check. */
async function computeReplayIdentityConflict(pg, projectId, sessionId, recordedRole, recordedAgentId) {
  if (!recordedAgentId) return false;
  const priorRows = await fetchPriorAgentIds(pg, projectId, sessionId);
  const roleFolded = routingIdentity.foldForComparison(recordedRole);
  const agentFolded = routingIdentity.foldForComparison(recordedAgentId);
  return findIdentityCollision(priorRows, roleFolded, agentFolded) !== null;
}

// ─── routeResolve ──────────────────────────────────────────────────────────

/**
 * @param {import('pg').Client|import('pg').Pool} pg
 * @param {{ projectId: string, sessionId: string, turnIdx: number, role: string, overrideModel?: string|null, capabilityTier?: string|null, agentId?: string|null }} args
 * @returns {Promise<{ model: string|null, provider: string|null, resolved_via: string, recommended_model: string|null, cost_delta_usd: number|null, rationale: string, replayed: boolean, identity_enforced?: boolean, identity_reason?: string, identity_conflict?: boolean }>}
 */
async function routeResolve(pg, args = {}) {
  const projectIdRaw = requireNonEmptyString(args.projectId, 'projectId');
  const sessionIdRaw = requireNonEmptyString(args.sessionId, 'sessionId');
  const turnIdx = requireTurnIdx(args.turnIdx);
  const roleRaw = requireNonEmptyString(args.role, 'role');
  const overrideModel = normalizeOverrideModel(args.overrideModel);
  const capabilityTier = normalizeCapabilityTier(args.capabilityTier);
  // §17.1.1 (item 1): total classification — undefined/null -> no
  // enforcement; present-but-invalid -> hard error, never coerced.
  const agentIdInfo = normalizeAgentId(args.agentId);

  // F-1: normalize ONCE, immediately after presence validation, and thread
  // the normalized identity through every downstream query in this function
  // (replay SELECT, directive chain, tier resolution, the final INSERT) —
  // never a mix of raw-here/normalized-there for the SAME call's identity.
  const projectId = routingIdentity.requireNormalizedNonEmpty(projectIdRaw, 'projectId', routingIdentity.normId);
  const sessionId = routingIdentity.requireNormalizedNonEmpty(sessionIdRaw, 'sessionId', routingIdentity.normId);
  const role = routingIdentity.requireNormalizedNonEmpty(roleRaw, 'role', routingIdentity.normRole);

  // ── Step 1: idempotent replay — a second call for the SAME key never
  // re-resolves. ──────────────────────────────────────────────────────────
  const existing = await selectTurnUsage(pg, projectId, sessionId, turnIdx, role);
  if (existing) {
    // §17.1.1 item 6: a replayed call never throws — re-run the collision
    // predicate against the RECORDED row's own stored agent_id (never this
    // call's agentId argument) and annotate, mirroring override_ignored.
    const identityConflict = await computeReplayIdentityConflict(pg, projectId, sessionId, role, existing.agent_id);
    return {
      model: existing.model,
      provider: existing.provider,
      resolved_via: existing.resolved_via,
      recommended_model: existing.recommended_model,
      cost_delta_usd: coerceCost(existing.cost_delta_usd),
      rationale: 'replay: turn already resolved',
      replayed: true,
      identity_conflict: identityConflict,
    };
  }

  // ── Step 2/3: directive chain, else recommendation ──────────────────────
  const directive = await resolveDirective(pg, { projectId, sessionId, role, overrideModel });

  let model;
  let provider;
  let resolvedVia;
  let rationale;
  let recommendedModel = null;
  let costDeltaUsd = null;

  if (directive) {
    model = directive.model;
    resolvedVia = 'directive';
    rationale = directive.rationale;

    const registryRow = await lookupRegistryByLabel(pg, model);

    // Provider resolution, 3-step total classification (5-2). A bare
    // overrideModel directive carries provider:null and so always falls to
    // step 2/3 here — it never had a step-1 provider to begin with.
    if (directive.provider !== null && directive.provider !== undefined) {
      provider = directive.provider;
    } else if (registryRow) {
      provider = registryRow.provider;
    } else {
      provider = null;
    }

    // 1-2: once ANY directive has produced a model, the entire best-effort
    // recommendation computation is wrapped in a try/catch. Any failure
    // degrades to recommended_model=NULL, cost_delta_usd=NULL and NEVER
    // propagates — resolveRequiredTier's hard error is fatal only on the
    // no-directive path.
    //
    // The tier-mismatch rationale flag (1-3) depends ONLY on the required
    // tier being resolvable, NOT on recommendLeastCost succeeding — a
    // registry with nothing at/above the required tier (recommendLeastCost
    // throws) must still surface the mismatch. So required-tier resolution
    // and the mismatch check happen in their own try/catch, wrapping the
    // (separately best-effort) recommendLeastCost call.
    try {
      const requiredTier = await resolveRequiredTier(pg, { projectId, role, capabilityTier });

      if (registryRow && registryRow.capability_tier && TIER_RANK[registryRow.capability_tier] < TIER_RANK[requiredTier]) {
        rationale = `${rationale} (tier-mismatch: pin=${registryRow.capability_tier} < required=${requiredTier})`;
      }

      try {
        const rec = await recommendLeastCost(pg, requiredTier);
        recommendedModel = rec.label;

        const directiveIn = registryRow ? coerceCost(registryRow.cost_in_per_mtok) : null;
        const directiveOut = registryRow ? coerceCost(registryRow.cost_out_per_mtok) : null;
        if (directiveIn !== null && directiveOut !== null) {
          const delta = (directiveIn + directiveOut) - (rec.cost_in_per_mtok + rec.cost_out_per_mtok);
          costDeltaUsd = Number.isFinite(delta) ? delta : null;
        } else {
          // Unregistered or cost-less directive — unknown, never fabricated as 0.
          costDeltaUsd = null;
        }
      } catch (_recErr) {
        recommendedModel = null;
        costDeltaUsd = null;
      }
    } catch (_tierErr) {
      recommendedModel = null;
      costDeltaUsd = null;
    }
  } else {
    resolvedVia = 'recommendation';
    // No directive to rescue a failure here — both calls are fatal and
    // propagate to the caller.
    const requiredTier = await resolveRequiredTier(pg, { projectId, role, capabilityTier });
    const rec = await recommendLeastCost(pg, requiredTier);
    model = rec.label;
    provider = rec.provider;
    recommendedModel = rec.label;
    // The chosen model IS the recommendation — the delta is definitionally
    // zero (still routed through the same finite-guard for uniformity).
    const delta = (rec.cost_in_per_mtok + rec.cost_out_per_mtok) - (rec.cost_in_per_mtok + rec.cost_out_per_mtok);
    costDeltaUsd = Number.isFinite(delta) ? delta : null;
    rationale = `recommend cheapest ${requiredTier}-tier, no directive set`;
  }

  // 3-1: assert Number.isFinite before writing — a non-finite result is
  // written as NULL, never as NaN (Postgres NUMERIC accepts the 'NaN'
  // literal and would silently corrupt telemetry).
  const costForWrite = (costDeltaUsd !== null && Number.isFinite(costDeltaUsd)) ? costDeltaUsd : null;

  const insertSql =
    `INSERT INTO turn_usage
       (project_id, session_id, turn_idx, agent_role, model_id, provider, resolved_via, recommended_model, cost_delta_usd, agent_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     ON CONFLICT (project_id, session_id, turn_idx, agent_role) DO NOTHING`;
  const insertParams = [projectId, sessionId, turnIdx, role, model, provider, resolvedVia, recommendedModel, costForWrite, agentIdInfo.stored];

  // §17.1.1 items 3/4/7: agentId absent -> byte-identical to pre-existing
  // behavior (no lock, no collision check, identity_enforced:false with the
  // "not supplied" reason). agentId present -> the prior-identity SELECT
  // and this INSERT run inside ONE transaction guarded by a
  // pg_advisory_xact_lock keyed on (project_id, session_id, foldedAgentId)
  // — the M-18 hashtext-keyed pattern (routing-profile.js) — so two
  // concurrent calls carrying the SAME folded identity in the SAME session
  // serialize instead of racing the collision check. Documented blind spot:
  // this lock namespace does not, and is not intended to, serialize across
  // different sessions or projects.
  if (!agentIdInfo.supplied) {
    const insertResult = await pg.query(insertSql, insertParams);

    if (insertResult.rowCount === 0) {
      // RACE RULE: a concurrent resolver won the key. Re-select and return
      // the WINNER's values — the caller must never receive values that
      // differ from what the table holds.
      const winner = await selectTurnUsage(pg, projectId, sessionId, turnIdx, role);
      const identityConflict = await computeReplayIdentityConflict(pg, projectId, sessionId, role, winner.agent_id);
      return {
        model: winner.model,
        provider: winner.provider,
        resolved_via: winner.resolved_via,
        recommended_model: winner.recommended_model,
        cost_delta_usd: coerceCost(winner.cost_delta_usd),
        rationale: 'replay: lost insert race, returning winner',
        replayed: true,
        identity_conflict: identityConflict,
      };
    }

    return {
      model,
      provider,
      resolved_via: resolvedVia,
      recommended_model: recommendedModel,
      cost_delta_usd: costForWrite,
      rationale,
      replayed: false,
      identity_enforced: false,
      identity_reason: 'agentId not supplied',
    };
  }

  // ── agentId supplied: transaction-scoped advisory lock + bidirectional
  // collision check + INSERT, all one transaction. ────────────────────────
  await pg.query('BEGIN');
  try {
    await pg.query(
      `SELECT pg_advisory_xact_lock(hashtext($1))`,
      [`route_resolve_identity:${projectId}:${sessionId}:${agentIdInfo.folded}`]
    );

    const priorRows = await fetchPriorAgentIds(pg, projectId, sessionId);
    const currentRoleFolded = routingIdentity.foldForComparison(role);
    const collision = findIdentityCollision(priorRows, currentRoleFolded, agentIdInfo.folded);

    if (collision) {
      // Rolled back uniformly by the outer catch below. Item 5: named code
      // REVIEW_IDENTITY_COLLISION, message names the
      // folded agentId + the colliding turn_idx/agent_role, remediation is
      // "dispatch a fresh agent" — no alternative-tier suggestion (this is
      // an identity problem, not a routing-tier problem).
      throw new RouteResolveError(
        'REVIEW_IDENTITY_COLLISION',
        `route-resolve: agentId '${agentIdInfo.folded}' (case-folded) already appears as turn_idx=${collision.turn_idx} ` +
        `agent_role='${collision.agent_role}' in this session (project_id='${projectId}', session_id='${sessionId}') — ` +
        `a 'review' turn must use a different agent identity than the turn(s) it reviews, and vice versa. ` +
        `Remediation: dispatch a fresh agent with a distinct agentId.`
      );
    }

    const identityEnforced = priorRows.length > 0;
    const identityReason = identityEnforced ? undefined : 'no prior identified turns in session';

    const insertResult = await pg.query(insertSql, insertParams);

    if (insertResult.rowCount === 0) {
      // Per-turn race (a DIFFERENT concurrent resolver won the exact
      // (project_id, session_id, turn_idx, agent_role) key) — orthogonal to
      // the identity lock above (that lock is keyed on identity, this
      // conflict is keyed on turn). Nothing to roll back; commit cleanly
      // and re-select the winner, same as the no-agentId path.
      await pg.query('COMMIT');
      const winner = await selectTurnUsage(pg, projectId, sessionId, turnIdx, role);
      const identityConflict = await computeReplayIdentityConflict(pg, projectId, sessionId, role, winner.agent_id);
      return {
        model: winner.model,
        provider: winner.provider,
        resolved_via: winner.resolved_via,
        recommended_model: winner.recommended_model,
        cost_delta_usd: coerceCost(winner.cost_delta_usd),
        rationale: 'replay: lost insert race, returning winner',
        replayed: true,
        identity_conflict: identityConflict,
      };
    }

    await pg.query('COMMIT');
    return {
      model,
      provider,
      resolved_via: resolvedVia,
      recommended_model: recommendedModel,
      cost_delta_usd: costForWrite,
      rationale,
      replayed: false,
      identity_enforced: identityEnforced,
      ...(identityReason !== undefined ? { identity_reason: identityReason } : {}),
    };
  } catch (err) {
    try { await pg.query('ROLLBACK'); } catch (_rollbackErr) { /* best-effort */ }
    throw err;
  }
}

module.exports = {
  routeResolve,
  recommendLeastCost,
  resolveRequiredTier,
  TIER_RANK,
  VALID_TIERS,
  coerceCost,
  RouteResolveError,
  // Exported test seams (not part of the "public" three-function surface,
  // but useful for direct unit exercise without a full routeResolve call).
  resolveDirective,
  lookupRegistryByLabel,
  selectTurnUsage,
  fetchActiveProfile,
  fetchActivePin,
  fetchPriorAgentIds,
};
