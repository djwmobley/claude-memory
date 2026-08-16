'use strict';

/**
 * normalize-text.js — the ONE shared normalization helper (§7.3/S-6,
 * §7.4/S-7, §7.8/S-8, CONSOLIDATION-RUNBOOK.md, memory-manager#17).
 *
 * S-8: "One SHARED normalization helper (a single exported function) is
 * used by §7.3's ingest-time contradiction check, this probe [§7.4's
 * dangling_entity_reference], and all four §7.8 checks. Prior drafts of
 * these three specs were each independently silent on case/whitespace
 * handling, which risked three mutually inconsistent matchers doing
 * conceptually the same comparison."
 *
 * S-6's definition of "materially different" / normalized-equality:
 *   normalize both candidates (case-fold, trim, collapse internal
 *   whitespace, strip trailing sentence punctuation .!?;), then compare by
 *   PLAIN STRING INEQUALITY. Exact-normalized-equality is NOT a
 *   contradiction. No fuzzy/similarity matching.
 */

/**
 * normalizeForCompare — case-fold, trim, collapse internal whitespace,
 * strip trailing sentence punctuation (.!?;). Pure, total (never throws —
 * non-string input is coerced via String()).
 *
 * @param {*} value
 * @returns {string}
 */
function normalizeForCompare(value) {
  let s = String(value == null ? '' : value);
  s = s.trim();
  s = s.toLowerCase();
  s = s.replace(/\s+/g, ' ');
  s = s.replace(/[.!?;]+$/g, '');
  return s;
}

/**
 * materiallyDifferent — S-6's exact comparison rule: normalize both sides,
 * then plain string inequality. Returns true iff the normalized forms
 * differ (i.e. a contradiction/mismatch by this codebase's single
 * definition).
 *
 * @param {*} a
 * @param {*} b
 * @returns {boolean}
 */
function materiallyDifferent(a, b) {
  return normalizeForCompare(a) !== normalizeForCompare(b);
}

module.exports = {
  normalizeForCompare,
  materiallyDifferent,
};
