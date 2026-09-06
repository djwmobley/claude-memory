'use strict';

/**
 * payload-schema.js — Deterministic payload validation for the handoff close path.
 *
 * This module derives the JSON-Schema constraint for the `assertions[].predicate`
 * field exclusively from `predicate-registry.js`. It must NOT restate the
 * predicate vocabulary directly; the registry JSON is the single source of truth.
 *
 * Satisfies OQ-C (JSON-Schema enum from registry, zero drift) and R-D (schema
 * constraint generation is deterministic and automated, not manual).
 *
 * COHERENCE CONTRACT — READ BEFORE EXTENDING:
 *   - This module derives its predicate list from predicate-registry.js at call
 *     time. Do NOT hardcode predicate strings here.
 *   - validatePayload() never throws for control flow. It always returns
 *     { ok, warnings, errors } and callers decide what to do with the result.
 *   - The "permissive" / "strict" semantics mirror classifyPredicate() exactly:
 *     permissive collects unrecognized predicates as warnings (assertion kept);
 *     strict collects them as errors (caller should skip those assertions).
 */

const { recognizedPredicates, classifyPredicate } = require('./predicate-registry');

/**
 * Build a JSON-Schema object for the handoff close payload.
 *
 * The `assertions[].predicate` field is constrained to an `enum` derived from
 * `recognizedPredicates()` at call time. This means the schema is always in
 * sync with the registry — no separate checked-in schema file required.
 *
 * The schema encodes the structural constraints that `readStdin` already enforces
 * at the handoff.js boundary (array length cap of 200, record field types). It
 * mirrors those constraints for consumers that want schema-level documentation
 * without re-implementing readStdin logic.
 *
 * @returns {object} JSON-Schema object (draft-07 compatible)
 */
function buildPayloadSchema() {
  const predicateEnum = recognizedPredicates();

  return {
    $schema: 'http://json-schema.org/draft-07/schema#',
    title: 'HandoffClosePayload',
    description: 'Payload accepted by handoff close / checkpoint via stdin (--json -). ' +
      'The predicate field of each assertion is constrained to the declared ' +
      'predicate-vocabulary registry (scripts/lib/predicate-registry.json).',
    type: 'object',
    additionalProperties: false,
    properties: {
      tldr: { type: 'string', maxLength: 4000 },
      open_threads: {
        type: 'array',
        maxItems: 200,
        items: { type: 'string', maxLength: 4000 },
      },
      resolved_threads: {
        type: 'array',
        maxItems: 200,
        items: { type: 'string', maxLength: 4000 },
      },
      quick_references: { type: 'string', maxLength: 4000 },
      session_id: { type: 'string', maxLength: 4000 },
      confirm_claude_md_promotion: { type: 'boolean' },
      retrieval_outcome: {
        type: 'string',
        enum: ['success', 'failure', 'irrelevant'],
      },
      retrieval_outcome_notes: { type: 'string', maxLength: 4000 },
      entities: {
        type: 'array',
        maxItems: 200,
        items: {
          type: 'object',
          required: ['name', 'entity_type'],
          properties: {
            name:        { type: 'string', maxLength: 1000 },
            entity_type: { type: 'string', maxLength: 1000 },
            description: { type: 'string', maxLength: 1000 },
          },
        },
      },
      assertions: {
        type: 'array',
        maxItems: 200,
        items: {
          type: 'object',
          required: ['subject', 'predicate', 'object'],
          properties: {
            subject: {
              type: 'string',
              maxLength: 1000,
            },
            predicate: {
              type: 'string',
              // OQ-C: enum derived from registry at call time — zero drift, no
              // separate checked-in schema file. This is the JSON-Schema constraint
              // that locks the extraction model to the declared vocabulary.
              enum: predicateEnum,
              maxLength: 1000,
            },
            object: {
              type: 'string',
              maxLength: 1000,
            },
            confidence: {
              type: 'number',
              minimum: 1,
              maximum: 10,
            },
            source: {
              type: 'string',
              enum: ['user_stated', 'model_extracted', 'doc_quoted', 'retrieved_from_prior'],
              maxLength: 1000,
            },
          },
        },
      },
      edges: {
        type: 'array',
        maxItems: 200,
        items: {
          type: 'object',
          required: ['from_entity', 'edge_type', 'to_entity'],
          properties: {
            from_entity: { type: 'string', maxLength: 1000 },
            edge_type:   { type: 'string', maxLength: 1000 },
            to_entity:   { type: 'string', maxLength: 1000 },
            weight:      { type: 'number' },
          },
        },
      },
      decisions: {
        type: 'array',
        maxItems: 200,
        // cm#230: persisted through scripts/lib/decisions-writer.js's
        // persistDecisionRow — the SAME write path scripts/handoff-mcp.mjs's
        // persist_decisions MCP tool uses (ON CONFLICT (project_id, topic) DO
        // UPDATE, inline-embedded at write time, fail-soft on embed failure).
        // Real per-row shape enforcement (topic MUST be lowercase kebab-case
        // with >=1 hyphen; decision/reason MUST be non-empty strings) is
        // decisions-writer.js's validateDecisionRows, run per-row at write
        // time by writeExtraction — NOT restated here as a JSON-Schema
        // `required`/`pattern` (this object's properties are documentation +
        // the two structural checks readStdin/validatePayload actually run:
        // array maxItems and topic byte-length). A row that fails
        // validateDecisionRows is skipped (non-fatal) and surfaced as a
        // DIVERGENCE line — see writeExtraction's header comment.
        items: {
          type: 'object',
          properties: {
            // cm#227: topic is the conflict-target column of the plain btree
            // `decisions_project_topic_unique (project_id, topic)` index — no
            // md5() wrap on that index (unlike assertions_1ton_exact_unique).
            // JSON-Schema's maxLength counts UTF-16 code units, not bytes, so
            // it cannot express the real physical (UTF-8 byte) limit exactly;
            // this maxLength is a conservative upper bound only. The
            // authoritative byte-length check (2000 bytes, Buffer.byteLength)
            // lives in validatePayload() below and in readStdin()
            // (scripts/handoff.js) — both real enforcement points.
            topic: { type: 'string', maxLength: 2000 },
            // decision/reason/session_num: cm#230 addition — documents the
            // REST of decisions-writer.js's row shape (topic alone was
            // documented pre-cm#230, back when this array was validated but
            // never actually written). decision/reason are REQUIRED at write
            // time (validateDecisionRows) even though JSON-Schema `required`
            // is intentionally not restated here (see note above).
            decision: { type: 'string', maxLength: 1000 },
            reason: { type: 'string', maxLength: 1000 },
            session_num: { type: 'number' },
          },
        },
      },
      contract: {
        type: 'object',
        properties: {
          queries: { type: 'array' },
        },
      },
    },
  };
}

/**
 * Deterministic validation of a payload's `assertions` against the predicate
 * registry vocabulary.
 *
 * Mode semantics (mirror classifyPredicate from predicate-registry.js):
 *   'permissive' (default): an unrecognized predicate is collected into
 *     `warnings[]` but the assertion is NOT excluded — it passes through to
 *     the caller unchanged. The caller can write it or inspect the warning.
 *   'strict': an unrecognized predicate is collected into `errors[]`. The
 *     caller SHOULD skip that assertion (skip-and-continue — never abort).
 *
 * Recognized predicates always produce no warning or error regardless of mode.
 *
 * This function never throws. It is deterministic: same (payload, mode, registry
 * state) → same { ok, warnings, errors } every run.
 *
 * @param {object} payload - The parsed payload object (from readStdin or equivalent).
 * @param {"permissive"|"strict"} [mode="permissive"] - Enforcement mode.
 * @returns {{ ok: boolean, warnings: string[], errors: string[] }}
 */
function validatePayload(payload, mode) {
  const effectiveMode = mode === 'strict' ? 'strict' : 'permissive';
  const warnings = [];
  const errors   = [];

  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    errors.push('payload must be a plain object');
    return { ok: false, warnings, errors };
  }

  // cm#227: decisions[].topic byte-length cap — checked here (in addition to
  // readStdin() in scripts/handoff.js, which is the primary gate for the CLI/
  // MCP --json - path) so callers that construct a payload object directly
  // (e.g. queue-drain re-validating an already-enqueued row) still reject a
  // too-long topic before it reaches the decisions table's plain btree
  // `decisions_project_topic_unique (project_id, topic)` index. Checked
  // BEFORE the assertions-array early-return below so a decisions-only
  // payload (no assertions) is still validated.
  const DECISIONS_TOPIC_BYTE_MAX = 2000;
  if (Array.isArray(payload.decisions)) {
    for (let i = 0; i < payload.decisions.length; i++) {
      const dec = payload.decisions[i];
      if (dec && typeof dec === 'object' && typeof dec.topic === 'string') {
        const topicBytes = Buffer.byteLength(dec.topic, 'utf8');
        if (topicBytes > DECISIONS_TOPIC_BYTE_MAX) {
          errors.push(
            `decisions[${i}].topic exceeds max byte length (${topicBytes} > ${DECISIONS_TOPIC_BYTE_MAX} bytes)`
          );
        }
      }
    }
  }

  const assertions = payload.assertions;
  if (!assertions) {
    // No assertions array — nothing further to validate.
    return { ok: errors.length === 0, warnings, errors };
  }

  if (!Array.isArray(assertions)) {
    errors.push('"assertions" must be an array');
    return { ok: false, warnings, errors };
  }

  for (let i = 0; i < assertions.length; i++) {
    const ass = assertions[i];
    if (!ass || typeof ass !== 'object' || Array.isArray(ass)) {
      errors.push(`assertions[${i}] must be a plain object`);
      continue;
    }

    const predicate = ass.predicate;
    if (predicate === undefined || predicate === null) {
      // Missing predicate — will be caught by writeExtraction's required-field guard.
      // Not a vocabulary error; do not produce a vocabulary warning/error here.
      continue;
    }

    if (typeof predicate !== 'string') {
      errors.push(`assertions[${i}].predicate must be a string (got ${typeof predicate})`);
      continue;
    }

    // Classify against the registry using classifyPredicate semantics.
    // In permissive mode classifyPredicate never throws — it returns recognized=false.
    // In strict mode it throws on unrecognized — we catch and convert to an error entry.
    try {
      const classification = classifyPredicate(predicate, effectiveMode);
      if (!classification.recognized) {
        // Permissive mode — unrecognized predicate; collect as warning.
        warnings.push(
          `assertions[${i}].predicate "${predicate}" is not in the declared registry ` +
          `(permissive mode: assertion kept; flag for registry extension)`
        );
      }
      // Recognized predicates produce no message.
    } catch (regErr) {
      // Strict mode — classifyPredicate threw for an unrecognized predicate.
      errors.push(
        `assertions[${i}].predicate "${predicate}": ${regErr.message}`
      );
    }
  }

  const ok = errors.length === 0;
  return { ok, warnings, errors };
}

/**
 * Validate the `resolved_threads` field if present.
 * Mirrors the structural validation in readStdin() for this field.
 * Returns { ok, error } where error is a string on failure, null on success.
 *
 * @param {object} payload
 * @returns {{ ok: boolean, error: string|null }}
 */
function validateResolvedThreads(payload) {
  const STRING_MAX = 4000;
  if (!('resolved_threads' in payload)) return { ok: true, error: null };
  const rt = payload.resolved_threads;
  if (!Array.isArray(rt)) {
    return { ok: false, error: 'stdin JSON: "resolved_threads" must be an array' };
  }
  if (rt.length > 200) {
    return { ok: false, error: `stdin JSON: "resolved_threads" array length ${rt.length} exceeds max 200` };
  }
  for (let i = 0; i < rt.length; i++) {
    const item = rt[i];
    if (typeof item !== 'string') {
      return { ok: false, error: `stdin JSON: "resolved_threads[${i}]" must be a string` };
    }
    if (item.length > STRING_MAX) {
      return { ok: false, error: `stdin JSON: "resolved_threads[${i}]" exceeds max length (${item.length} > ${STRING_MAX})` };
    }
  }
  return { ok: true, error: null };
}

module.exports = { buildPayloadSchema, validatePayload, validateResolvedThreads };
