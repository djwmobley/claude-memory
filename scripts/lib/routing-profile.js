'use strict';

/**
 * routing-profile.js — §8/§17.2 routing_profile_set / routing_profile_get
 * (CONSOLIDATION-RUNBOOK.md §8, §17.2, §17.3, M-18, memory-manager#18).
 *
 * routing_profile_set is ONE transaction (M-18):
 *   SELECT COALESCE(MAX(version),0)+1 ... FOR UPDATE
 *   -> UPDATE active=false WHERE active=true
 *   -> INSERT new active row
 *
 * IMPLEMENTATION NOTE (deviation from M-18's literal pseudocode, resolved
 * during authoring): `SELECT MAX(version) ... FOR UPDATE` is not valid
 * Postgres SQL — `FOR UPDATE` is rejected outright on any query containing
 * an aggregate function (error 0A000, "FOR UPDATE is not allowed with
 * aggregate functions"), confirmed empirically against live Postgres while
 * authoring this file. Row-level `FOR UPDATE` on a plain (non-aggregate)
 * SELECT also does not serialize the FIRST-ever routing_profile_set call
 * for a brand-new (project_id, role) pair, since there is no existing row
 * to lock — two concurrent first-time calls would both compute version=1
 * and race routing_profiles_project_id_role_version_key. This module
 * instead takes a `pg_advisory_xact_lock(hashtext(project_id||':'||role))`
 * transaction-scoped advisory lock BEFORE computing MAX(version) — the SAME
 * hashtext-keyed advisory-lock pattern already used by
 * scripts/lib/db-seam.js's PostgresAdapter.acquireMigrationLock, reused by
 * convention rather than reimplemented differently. This preserves M-18's
 * INTENT (one transaction, safe-under-concurrency version-then-deactivate-
 * then-insert) with a mechanism that is actually valid SQL and covers the
 * brand-new-role case the literal pseudocode's FOR UPDATE could not.
 *
 * §17.3's non-destructive-supersession posture: routing_profile_set "inserts
 * a NEW version (never mutates an existing row)... the previous version's
 * `active` flips to `false`" — this module never UPDATEs a row's own
 * capability_tier/preferred_model in place; every change is a new versioned
 * row.
 */

class RoutingProfileError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'RoutingProfileError';
    this.code = code;
  }
}

function requireNonEmptyString(value, name) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new RoutingProfileError('validation', `routing-profile: "${name}" is required and must be a non-empty string`);
  }
  return value;
}

const VALID_TIERS = Object.freeze(['high', 'mid', 'low']);

/**
 * @param {object} client — pg client (single connection; this function
 *   issues BEGIN/COMMIT/ROLLBACK itself, so callers must NOT already be
 *   inside a transaction on this client)
 * @param {object} args
 * @param {string} args.projectId
 * @param {string} args.role
 * @param {string} args.capabilityTier — one of VALID_TIERS
 * @param {string} [args.preferredModel]
 * @param {string} [args.preferredProvider]
 * @param {string} [args.sourceModel]
 * @param {string} [args.agentId]
 * @param {string} [args.notes]
 * @returns {Promise<{id:number, version:number}>}
 */
async function routingProfileSet(client, args) {
  const { projectId, role, capabilityTier } = args || {};
  requireNonEmptyString(projectId, 'projectId');
  requireNonEmptyString(role, 'role');
  if (!VALID_TIERS.includes(capabilityTier)) {
    throw new RoutingProfileError('validation', `routing-profile: capabilityTier must be one of ${JSON.stringify(VALID_TIERS)} (got ${JSON.stringify(capabilityTier)})`);
  }

  await client.query('BEGIN');
  try {
    // Transaction-scoped advisory lock, released automatically at
    // COMMIT/ROLLBACK — serializes ALL routing_profile_set calls for this
    // (project_id, role) pair, including the brand-new-role case where
    // there is no existing row for a row-level lock to hold.
    await client.query(
      `SELECT pg_advisory_xact_lock(hashtext($1))`,
      [`routing_profile:${projectId}:${role}`]
    );

    const { rows: verRows } = await client.query(
      `SELECT COALESCE(MAX(version), 0) + 1 AS next_version
         FROM routing_profiles
        WHERE project_id = $1 AND role = $2`,
      [projectId, role]
    );
    const nextVersion = verRows[0].next_version;

    await client.query(
      `UPDATE routing_profiles SET active = false WHERE project_id = $1 AND role = $2 AND active = true`,
      [projectId, role]
    );

    const { rows: insRows } = await client.query(
      `INSERT INTO routing_profiles
         (project_id, role, capability_tier, preferred_model, preferred_provider, version, active, source_model, agent_id, notes)
       VALUES ($1, $2, $3, $4, $5, $6, true, $7, $8, $9)
       RETURNING id, version`,
      [
        projectId, role, capabilityTier,
        args.preferredModel || null, args.preferredProvider || null,
        nextVersion,
        args.sourceModel || null, args.agentId || null, args.notes || null,
      ]
    );

    await client.query('COMMIT');
    return insRows[0];
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  }
}

/**
 * routing_profile_get(project_id, role?) -> [routing_profiles rows]. `role`
 * omitted returns every ACTIVE profile for the project (§17.3).
 */
async function routingProfileGet(client, { projectId, role }) {
  requireNonEmptyString(projectId, 'projectId');
  const { rows } = await client.query(
    `SELECT * FROM routing_profiles
      WHERE project_id = $1 AND active = true AND ($2::text IS NULL OR role = $2)
      ORDER BY role, version DESC`,
    [projectId, role || null]
  );
  return rows;
}

module.exports = {
  RoutingProfileError,
  VALID_TIERS,
  routingProfileSet,
  routingProfileGet,
};
