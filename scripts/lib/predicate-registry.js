'use strict';

/**
 * predicate-registry.js — Authoritative owner of predicate cardinality and
 * unrecognized-predicate behavior for the assertion write path.
 *
 * This module is the SINGLE authoritative source of truth for:
 *   1. Which predicates are in the declared vocabulary (loadRegistry / recognizedPredicates).
 *   2. The cardinality of each recognized predicate (cardinalityOf).
 *   3. How an unrecognized predicate is handled at write time (classifyPredicate).
 *   4. Whether a predicate is directive-shaped (isDirective) — governs cmdRetire semantics.
 *
 * COHERENCE CONTRACT — READ BEFORE EXTENDING:
 *   Any consumer that needs to know a predicate's cardinality or needs to decide
 *   how to handle an unrecognized predicate MUST call classifyPredicate() from
 *   this module. Do NOT restate the fallback cardinality (1:N) or the strict/
 *   permissive behavior in any other module. The write-time supersession work
 *   that depends on this registry must consume classifyPredicate() exclusively.
 *   Duplicating the fallback logic elsewhere re-creates the uncontrolled-vocabulary
 *   unsoundness this module was introduced to prevent.
 *
 * Registry invariants (from the assertion extraction architecture spec):
 *   R-1: Every predicate written is either in the registry or explicitly flagged.
 *   R-2: Cardinality is determined by the registry, not by per-call heuristics.
 *   R-5: Adding a predicate is a versioned, recorded operation (edit the JSON).
 *   R-6: The supersession logic consumes cardinality exclusively from this module.
 *   R-7: The directive flag governs whole-predicate retirement without --object.
 *        Only predicates explicitly marked "directive": true permit mass-retirement.
 */

const fs   = require('fs');
const path = require('path');

const REGISTRY_PATH = path.join(__dirname, 'predicate-registry.json');

const VALID_CARDINALITIES = new Set(['1:1', '1:N']);

// Module-level cache: loaded once per process.
let _cache = null;

/**
 * Load and validate the predicate registry from disk.
 *
 * Validates that:
 *   - The file is parseable JSON with an "entries" array.
 *   - Each entry has the four required fields: predicate (non-empty string),
 *     cardinality ("1:1" or "1:N"), description (string), added_version (string).
 *
 * Results are cached in-process after the first successful load.
 *
 * @returns {{ byPredicate: Map<string, object>, sorted: string[] }}
 * @throws {Error} on a malformed registry (R-1/R-5).
 */
function loadRegistry() {
  if (_cache) return _cache;

  let raw;
  try {
    raw = fs.readFileSync(REGISTRY_PATH, 'utf8');
  } catch (err) {
    throw new Error(
      `predicate-registry: cannot read registry file at ${REGISTRY_PATH}: ${err.message}`
    );
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `predicate-registry: registry file is not valid JSON: ${err.message}`
    );
  }

  if (!parsed || !Array.isArray(parsed.entries)) {
    throw new Error(
      `predicate-registry: registry file must be an object with an "entries" array`
    );
  }

  const byPredicate = new Map();

  for (let i = 0; i < parsed.entries.length; i++) {
    const entry = parsed.entries[i];

    if (!entry || typeof entry !== 'object') {
      throw new Error(
        `predicate-registry: entry at index ${i} is not an object`
      );
    }
    if (typeof entry.predicate !== 'string' || entry.predicate.length === 0) {
      throw new Error(
        `predicate-registry: entry at index ${i} missing or empty "predicate" field`
      );
    }
    if (!VALID_CARDINALITIES.has(entry.cardinality)) {
      throw new Error(
        `predicate-registry: entry "${entry.predicate}" has invalid cardinality "${entry.cardinality}" — must be "1:1" or "1:N"`
      );
    }
    if (typeof entry.description !== 'string') {
      throw new Error(
        `predicate-registry: entry "${entry.predicate}" missing "description" field`
      );
    }
    if (typeof entry.added_version !== 'string') {
      throw new Error(
        `predicate-registry: entry "${entry.predicate}" missing "added_version" field`
      );
    }

    // "directive" is optional; if present it must be a boolean.
    if ('directive' in entry && typeof entry.directive !== 'boolean') {
      throw new Error(
        `predicate-registry: entry "${entry.predicate}" has invalid "directive" value "${entry.directive}" — must be a boolean`
      );
    }

    if (byPredicate.has(entry.predicate)) {
      throw new Error(
        `predicate-registry: duplicate predicate "${entry.predicate}" in registry`
      );
    }

    byPredicate.set(entry.predicate, entry);
  }

  const sorted = Array.from(byPredicate.keys()).sort();

  _cache = { byPredicate, sorted };
  return _cache;
}

/**
 * Return the declared cardinality for a recognized predicate, or null if the
 * predicate is not in the registry.
 *
 * @param {string} predicate
 * @returns {"1:1" | "1:N" | null}
 */
function cardinalityOf(predicate) {
  const { byPredicate } = loadRegistry();
  const entry = byPredicate.get(predicate);
  return entry ? entry.cardinality : null;
}

/**
 * Classify a predicate: return its cardinality and whether it is recognized.
 *
 * Applies the unrecognized-predicate policy from OQ-B of the extraction
 * architecture spec:
 *   - "permissive" (default): unrecognized predicates are accepted with a safe
 *     fallback cardinality of "1:N" and recognized=false. 1:N is the safe
 *     fallback because it never silently destroys parallel values, which is
 *     a worse outcome than retaining duplicates.
 *   - "strict": an unrecognized predicate throws a clear Error. Callers that
 *     catch this error should skip the assertion and log a stderr warning;
 *     they must not abort the entire write operation.
 *
 * Recognized predicates always return their declared cardinality with
 * recognized=true, regardless of mode.
 *
 * @param {string} predicate - The predicate string to classify.
 * @param {"permissive" | "strict"} [mode="permissive"] - Enforcement mode.
 * @returns {{ cardinality: "1:1" | "1:N", recognized: boolean }}
 * @throws {Error} in strict mode when predicate is not in the registry.
 */
function classifyPredicate(predicate, mode) {
  const effectiveMode = mode === 'strict' ? 'strict' : 'permissive';
  const { byPredicate } = loadRegistry();
  const entry = byPredicate.get(predicate);

  if (entry) {
    return { cardinality: entry.cardinality, recognized: true };
  }

  if (effectiveMode === 'strict') {
    throw new Error(
      `predicate-registry: unrecognized predicate "${predicate}" — strict mode rejects unknown predicates; add to predicate-registry.json to extend the vocabulary`
    );
  }

  // Permissive mode: accept with safe fallback cardinality 1:N.
  return { cardinality: '1:N', recognized: false };
}

/**
 * Return a sorted array of all recognized predicate strings.
 *
 * Intended for use by the JSON-Schema-enum generator (a later commit) that
 * constrains background extraction to the declared vocabulary. The array is
 * sorted lexicographically so the output is deterministic across runs.
 *
 * @returns {string[]}
 */
function recognizedPredicates() {
  const { sorted } = loadRegistry();
  return sorted.slice(); // return a copy so callers cannot mutate the cache
}

/**
 * Return true if the predicate is explicitly marked as directive-shaped
 * in the registry (i.e. the entry has "directive": true).
 *
 * Directive predicates are permitted by cmdRetire to retire ALL live rows
 * for a (subject, predicate) tuple when --object is omitted — the "rescind
 * the whole rule" form.  Non-directive 1:N predicates record parallel values
 * (e.g. uses, covers) that must not be mass-retired without an explicit object.
 *
 * Unrecognized predicates return false (non-directive by default).
 *
 * @param {string} predicate
 * @returns {boolean}
 */
function isDirective(predicate) {
  const { byPredicate } = loadRegistry();
  const entry = byPredicate.get(predicate);
  return !!(entry && entry.directive === true);
}

module.exports = { loadRegistry, cardinalityOf, classifyPredicate, recognizedPredicates, isDirective };
