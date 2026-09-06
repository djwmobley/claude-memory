'use strict';

/**
 * scripts/lib/routing-identity.js — ONE normalization engine for every
 * identity key the §17 routing subsystem writes or reads (CONSOLIDATION-
 * RUNBOOK.md §17, 2026-09-06 B1 spec-adversary finding F-1).
 *
 * BEFORE this file existed, route-resolve.js's own header claimed a "shared
 * normalization engine" that did not exist anywhere — every lookup
 * (model_registry.label, routing_profiles.role, routing_session_overrides'
 * project_id/session_id/role) was a raw byte-exact Postgres `=`. The
 * adversary pass on the B1 bundle (routing_session_override_set/clear/get,
 * model_registry_set) found this meant a normalize-on-write-only design
 * would make a value legal to WRITE but unfindable to READ — worse than no
 * normalization at all. This module is pinned as resolution (a): trim +
 * Unicode NFC + internal-whitespace collapse for label/role, applied
 * IDENTICALLY at every write site (the new T1/T2 tools in
 * routing-write-surface.js) and every existing read site that looks up
 * label/role/session_id/project_id (route-resolve.js's
 * lookupRegistryByLabel/fetchActiveProfile/fetchActivePin/resolveDirective/
 * selectTurnUsage/routeResolve/resolveRequiredTier, routing-profile.js's
 * routingProfileSet/routingProfileGet).
 *
 * normLabel / normRole: trim, Unicode NFC, collapse any run of internal
 * whitespace to a single space. Case is PRESERVED — equality after
 * normalization is byte-exact (=== in JS, `=` in SQL). This intentionally
 * does NOT fold case: `Claude Sonnet` and `claude sonnet` remain two
 * distinct labels/roles after normalization (case-folding was never
 * requested by the spec and would be a separate, larger behavior change to
 * an already-shipped, tested UNIQUE-keyed column).
 *
 * normId (session_id / project_id): trim only — no NFC, no whitespace
 * collapse. These are opaque caller-supplied identifiers (a session id, a
 * project marker/path) where internal whitespace is never incidental
 * human-typo formatting the way it can be in a label or role typed by a
 * person at an init-time prompt; collapsing it could silently merge two
 * distinct identifiers that happen to differ only in whitespace run length.
 * '*' is explicitly NOT special-cased here — the routing_profiles global-
 * sentinel meaning of the literal string '*' is a caller-level convention
 * enforced by the CALLERS of this module (route-resolve.js's fetchActivePin
 * et al., and routing-write-surface.js's T1 rejection of '*' for session
 * overrides — see F-4), not a normalization concern.
 *
 * requireNormalizedNonEmpty: the total-classification wrapper every write
 * and read site should call — raw input must be a non-empty string BEFORE
 * normalization (rejects non-strings/empty strings with the raw value in
 * the message), and the NORMALIZED result must also be non-empty (rejects
 * whitespace-only input, which would otherwise silently normalize to `""`
 * and become indistinguishable from "no value" once written).
 */

function normLabel(value) {
  if (typeof value !== 'string') return value;
  return value.trim().normalize('NFC').replace(/\s+/g, ' ');
}

// role uses the identical rule to label (both are short human-typed
// tokens) — exported as a separate name so call sites read as intent, not
// coincidence, and so the two can diverge later without a silent shared-
// function surprise.
const normRole = normLabel;

function normId(value) {
  if (typeof value !== 'string') return value;
  return value.trim();
}

/**
 * @param {*} rawValue
 * @param {string} name — used in the error message only
 * @param {(v: string) => string} normalizeFn — normLabel, normRole, or normId
 * @returns {string} the normalized value
 */
function requireNormalizedNonEmpty(rawValue, name, normalizeFn) {
  if (typeof rawValue !== 'string' || rawValue.length === 0) {
    throw new Error(`routing-identity: "${name}" must be a non-empty string (got ${JSON.stringify(rawValue)})`);
  }
  const normalized = normalizeFn(rawValue);
  if (normalized.length === 0) {
    throw new Error(`routing-identity: "${name}" must be a non-empty string after normalization — whitespace-only input is rejected, never silently stored as "" (got ${JSON.stringify(rawValue)})`);
  }
  return normalized;
}

module.exports = {
  normLabel,
  normRole,
  normId,
  requireNormalizedNonEmpty,
};
