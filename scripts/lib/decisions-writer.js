'use strict';

/**
 * decisions-writer.js — cm#230: the ONE write path for `decisions` table
 * rows, shared by:
 *   - scripts/handoff-mcp.mjs's `persist_decisions` MCP tool (toolPersistDecisions)
 *   - scripts/handoff.js's `writeExtraction` (payload.decisions[] from a
 *     close/checkpoint stdin payload — cm#230's own fix: this array was
 *     schema-validated but never actually written before this file existed)
 *
 * Neither caller re-implements row validation, embed-text construction, or
 * the write-time-embed/upsert call chain — both call validateDecisionRows
 * and persistDecisionRow below, BY REFERENCE.
 *
 * validateDecisionRows/TOPIC_RE moved here VERBATIM from handoff-mcp.mjs
 * (byte-identical regex and error strings — persist_decisions' external
 * behavior is unchanged by this move).
 */

const memoryUpsertLib = require('./memory-upsert.js');
const { writeRowWithProvenanceRetry } = require('./write-time-embed.js');

const TOPIC_RE = /^[a-z0-9]+(-[a-z0-9]+)+$/;

/**
 * validateDecisionRows — ALL-OR-NOTHING validation of an array of decision
 * rows (persist_decisions' contract: any invalid row rejects the WHOLE
 * call, no partial writes). Callers that want PER-ROW fault isolation
 * instead (writeExtraction's close/checkpoint fail-soft contract) call this
 * once per row (validateDecisionRows([row])) rather than once per array —
 * same function, no behavior fork.
 *
 * @param {Array<object>} rows
 * @returns {string[]} errors — empty array means every row is valid.
 */
function validateDecisionRows(rows) {
  const errors = [];
  if (!Array.isArray(rows) || rows.length === 0) {
    errors.push('rows must be a non-empty array.');
    return errors;
  }
  rows.forEach((row, i) => {
    if (typeof row !== 'object' || row === null || Array.isArray(row)) {
      errors.push(`rows[${i}]: must be an object.`);
      return;
    }
    if (typeof row.topic !== 'string' || !TOPIC_RE.test(row.topic)) {
      errors.push(`rows[${i}].topic: required, must be a lowercase kebab-case string with at least one hyphen (e.g. "ppm-monolith-foo"); got ${JSON.stringify(row.topic)}.`);
    }
    if (typeof row.decision !== 'string' || row.decision.trim() === '') {
      errors.push(`rows[${i}].decision: required non-empty string.`);
    }
    if (typeof row.reason !== 'string' || row.reason.trim() === '') {
      errors.push(`rows[${i}].reason: required non-empty string.`);
    }
    if (row.session_num !== undefined && row.session_num !== null && typeof row.session_num !== 'number') {
      errors.push(`rows[${i}].session_num: must be a number or null if present.`);
    }
  });
  return errors;
}

/**
 * persistDecisionRow — writes ONE already-validated decision row through
 * the SAME embed-at-write-time (write-time-embed.js, fail-soft — see that
 * file's header) + upsertDecisionRow (ON CONFLICT (project_id, topic) DO
 * UPDATE) chain persist_decisions used inline before cm#230. A caller
 * should validate the row first (validateDecisionRows) — this function
 * does not re-validate; it assumes row.topic/decision/reason are already
 * the right shape and forwards them as-is (mirrors upsertDecisionRow's own
 * "no re-validation" contract at the SQL-builder layer).
 *
 * @param {object} db - pg client/pool (Postgres port; decisions/embedding
 *   are Postgres-only tables, no SQLite seam)
 * @param {string} projectId
 * @param {object} row - {topic, decision, reason, session_num?}
 * @returns {Promise<{written: {id:number, topic:string, inserted:boolean}, warning: string|null}>}
 *   `warning` is non-null exactly when the embedding degraded (fail-soft —
 *   the row is STILL written; only its embedding/embedded_by_provider_id
 *   pair is NULL). Any error OTHER than the fail-soft embedding path
 *   (e.g. a genuine write error) is thrown, not swallowed — same contract
 *   writeRowWithProvenanceRetry documents.
 */
async function persistDecisionRow(db, projectId, row) {
  const embedText = memoryUpsertLib.buildEmbedText('decisions', {
    topic: row.topic, decision: row.decision, reason: row.reason,
  });
  // cm#201: threads providerId alongside the vector (both-or-neither) and
  // classifies a race-window FK 23503 on embedded_by_provider_id (re-resolve
  // once, retry; degrade to neither on persistent failure).
  const { written, warning } = await writeRowWithProvenanceRetry(db, embedText, (opts) =>
    memoryUpsertLib.upsertDecisionRow(db, {
      project_id: projectId,
      topic: row.topic,
      decision: row.decision,
      reason: row.reason,
      session_num: row.session_num ?? null,
    }, opts)
  );
  return {
    written: { id: written.id, topic: written.topic, inserted: written.inserted },
    warning,
  };
}

module.exports = { TOPIC_RE, validateDecisionRows, persistDecisionRow };
