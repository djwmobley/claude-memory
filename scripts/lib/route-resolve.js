'use strict';

/**
 * scripts/lib/route-resolve.js
 *
 * Least-cost routing resolver (runbook §17.1/§17.2). Given a turn's
 * identity (project, session, turn index, agent role), resolves which
 * model/provider that turn should use and records the decision exactly
 * once in `turn_usage`. CommonJS, plain `pg` client (Client or Pool)
 * passed in by the caller — this library never opens, owns, or closes a
 * database connection.
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
 * OUT OF SCOPE (caller responsibility): the §17.1.1 review-role/agent-
 * identity separation note ("review never resolves to the drafting
 * agent_id") is an orchestration-layer concern this resolver has no
 * artifact context to enforce — callers routing a 'review' role are
 * responsible for ensuring the reviewing agent differs from the drafting
 * agent. This resolver never mutates schema and never inserts into
 * model_registry / routing_profiles / routing_session_overrides.
 */

const TIER_RANK = Object.freeze({ low: 0, mid: 1, high: 2 });
const VALID_TIERS = Object.freeze(['high', 'mid', 'low']);

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

/** Active routing_profiles row for (projectId, role), highest version wins. Tier-only lookup (no preferred_model filter). */
async function fetchActiveProfile(pg, projectId, role) {
  const { rows } = await pg.query(
    `SELECT capability_tier, preferred_model, preferred_provider, version
       FROM routing_profiles
      WHERE project_id = $1 AND role = $2 AND active = true
      ORDER BY version DESC LIMIT 1`,
    [projectId, role]
  );
  return rows[0] || null;
}

/** Active routing_profiles row for (projectId, role) that also carries a pin (non-NULL preferred_model). */
async function fetchActivePin(pg, projectId, role) {
  const { rows } = await pg.query(
    `SELECT capability_tier, preferred_model, preferred_provider, version
       FROM routing_profiles
      WHERE project_id = $1 AND role = $2 AND active = true AND preferred_model IS NOT NULL
      ORDER BY version DESC LIMIT 1`,
    [projectId, role]
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
  const explicitTier = normalizeCapabilityTier(capabilityTier);
  if (explicitTier) return explicitTier;

  const projectProfile = await fetchActiveProfile(pg, projectId, role);
  if (projectProfile && projectProfile.capability_tier) return projectProfile.capability_tier;

  const globalProfile = await fetchActiveProfile(pg, '*', role);
  if (globalProfile && globalProfile.capability_tier) return globalProfile.capability_tier;

  throw new Error(
    `unconfigured routing for role '${role}' — run routing init Q&A ` +
    '(install-time suggested per-role defaults exist — e.g. orchestrate/spec=high, ' +
    'draft/write=mid, read/index/bookkeep=low, review=high — but the suggested set never ' +
    'applies on its own; it must be explicitly confirmed via the init Q&A, never applied ' +
    'automatically by this resolver)'
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
      'Run the init Q&A to register cost figures for these models.'
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
  const { rows } = await pg.query(
    `SELECT label, provider, capability_tier, cost_in_per_mtok, cost_out_per_mtok
       FROM model_registry WHERE label = $1`,
    [label]
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

  const { rows: sessionRows } = await pg.query(
    `SELECT model_id, provider FROM routing_session_overrides
      WHERE project_id = $1 AND session_id = $2 AND role = $3`,
    [projectId, sessionId, role]
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

/** Same aliased shape used by both the step-1 replay SELECT and the race-loser re-SELECT (2-2). */
async function selectTurnUsage(pg, projectId, sessionId, turnIdx, role) {
  const { rows } = await pg.query(
    `SELECT model_id AS model, provider, resolved_via, recommended_model, cost_delta_usd
       FROM turn_usage
      WHERE project_id = $1 AND session_id = $2 AND turn_idx = $3 AND agent_role = $4`,
    [projectId, sessionId, turnIdx, role]
  );
  return rows[0] || null;
}

// ─── routeResolve ──────────────────────────────────────────────────────────

/**
 * @param {import('pg').Client|import('pg').Pool} pg
 * @param {{ projectId: string, sessionId: string, turnIdx: number, role: string, overrideModel?: string|null, capabilityTier?: string|null }} args
 * @returns {Promise<{ model: string|null, provider: string|null, resolved_via: string, recommended_model: string|null, cost_delta_usd: number|null, rationale: string, replayed: boolean }>}
 */
async function routeResolve(pg, args = {}) {
  const projectId = requireNonEmptyString(args.projectId, 'projectId');
  const sessionId = requireNonEmptyString(args.sessionId, 'sessionId');
  const turnIdx = requireTurnIdx(args.turnIdx);
  const role = requireNonEmptyString(args.role, 'role');
  const overrideModel = normalizeOverrideModel(args.overrideModel);
  const capabilityTier = normalizeCapabilityTier(args.capabilityTier);

  // ── Step 1: idempotent replay — a second call for the SAME key never
  // re-resolves. ──────────────────────────────────────────────────────────
  const existing = await selectTurnUsage(pg, projectId, sessionId, turnIdx, role);
  if (existing) {
    return {
      model: existing.model,
      provider: existing.provider,
      resolved_via: existing.resolved_via,
      recommended_model: existing.recommended_model,
      cost_delta_usd: coerceCost(existing.cost_delta_usd),
      rationale: 'replay: turn already resolved',
      replayed: true,
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

  const insertResult = await pg.query(
    `INSERT INTO turn_usage
       (project_id, session_id, turn_idx, agent_role, model_id, provider, resolved_via, recommended_model, cost_delta_usd)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (project_id, session_id, turn_idx, agent_role) DO NOTHING`,
    [projectId, sessionId, turnIdx, role, model, provider, resolvedVia, recommendedModel, costForWrite]
  );

  if (insertResult.rowCount === 0) {
    // RACE RULE: a concurrent resolver won the key. Re-select and return
    // the WINNER's values — the caller must never receive values that
    // differ from what the table holds.
    const winner = await selectTurnUsage(pg, projectId, sessionId, turnIdx, role);
    return {
      model: winner.model,
      provider: winner.provider,
      resolved_via: winner.resolved_via,
      recommended_model: winner.recommended_model,
      cost_delta_usd: coerceCost(winner.cost_delta_usd),
      rationale: 'replay: lost insert race, returning winner',
      replayed: true,
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
  };
}

module.exports = {
  routeResolve,
  recommendLeastCost,
  resolveRequiredTier,
  TIER_RANK,
  VALID_TIERS,
  coerceCost,
  // Exported test seams (not part of the "public" three-function surface,
  // but useful for direct unit exercise without a full routeResolve call).
  resolveDirective,
  lookupRegistryByLabel,
  selectTurnUsage,
  fetchActiveProfile,
  fetchActivePin,
};
