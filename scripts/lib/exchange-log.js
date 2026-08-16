'use strict';

/**
 * exchange-log.js — §7.7 A2A write split, "model reasons, tool ships it"
 * (CONSOLIDATION-RUNBOOK.md §7.7/§5.8/§9.4/L15, memory-manager#17).
 *
 * Ports the body/summary write-split PATTERN (§7.7's own citation: a
 * private internal reference implementation's --body/--summary CLI split
 * and its optimistic UPDATE guard) into the generic, non-courtroom-specific
 * shape this codebase uses: the AGENT authors a caveman `body` (full
 * reasoning text) plus a short `summary` (kept DISTINCT from the body, so
 * the embedding scores on the digest, not the full body). The TOOL's job
 * is mechanical: embed the summary, INSERT INTO agent_exchange RETURNING
 * id/created_at, and OPTIONALLY perform ONE guarded, atomic state
 * transition in the SAME transaction, using an optimistic row-count check
 * modeled on that same private reference's update-guard shape.
 *
 * NOT PORTED (explicitly, per the runbook's own boundary note): the
 * private reference's courtroom-role transition-authorization table. The
 * guard below is a generic EXPECTED-CURRENT-STATE check against a stale
 * write (UPDATE ... WHERE id=$1 AND status=$2), not a role-authorization
 * concept — this file has no notion of courtroom roles at all.
 *
 * EMBEDDER SEAM (injectable, per this PR's task description): the DEFAULT
 * embedder resolves the `embedding_providers` row with is_default=true and
 * calls scripts/lib/embed.js's embedQuery() (already fail-loud by its own
 * contract — throws on every error, never returns a degraded/partial
 * result). Tests inject a deterministic stub explicitly via the `embedder`
 * parameter. A provider that is unreachable, absent, or returns the wrong
 * dimensionality is a LOUD thrown error — NEVER a silent skip or fallback
 * (unlike scripts/lib/shared.js's tryEmbed(), which degrades gracefully by
 * DESIGN for a different, non-A2A call path — that is a DELIBERATE
 * divergence from tryEmbed's precedent, not an oversight, because §7.7
 * requires the opposite posture).
 *
 * EMBED-BEFORE-TRANSACTION: the embed call happens BEFORE `BEGIN` — a slow
 * or failing embed call never holds a transaction/row lock open.
 */

const path = require('path');
const { embedQuery } = require('./embed.js');

const KNOWN_KINDS = new Set([
  'proposal', 'response', 'opinion', 'ruling', 'observation', 'research', 'handoff',
]);

class ExchangeLogError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ExchangeLogError';
    this.code = code;
  }
}

/**
 * resolveDefaultEmbedder — reads the `embedding_providers` row with
 * is_default=true and returns an `embedder(text) => Promise<number[]>`
 * function bound to it. Throws loudly if no default row exists, or if the
 * resolved vector's length does not match the provider's declared
 * stored_dims (a silent dimension mismatch would otherwise corrupt the
 * halfvec(4000) column at INSERT time with a cryptic Postgres error
 * instead of a named one).
 *
 * @param {object} client
 * @returns {Promise<(text: string) => Promise<number[]>>}
 */
async function resolveDefaultEmbedder(client) {
  const { rows } = await client.query(
    `SELECT name, stored_dims FROM embedding_providers WHERE is_default = true LIMIT 1`
  );
  if (rows.length === 0) {
    throw new ExchangeLogError(
      'noDefaultProvider',
      'exchange-log: no embedding_providers row with is_default=true — refusing to embed silently (never a silent skip/fallback per §7.7)'
    );
  }
  const provider = rows[0];
  return async function defaultEmbedder(text) {
    const vector = await embedQuery(text); // fail-loud by embed.js's own contract
    if (!Array.isArray(vector) || vector.length !== provider.stored_dims) {
      throw new ExchangeLogError(
        'dimensionMismatch',
        `exchange-log: default embedder ("${provider.name}") returned ${Array.isArray(vector) ? vector.length : typeof vector} dims, expected ${provider.stored_dims}`
      );
    }
    return vector;
  };
}

/**
 * appendExchange — the ONE write path for agent_exchange rows.
 *
 * @param {object} client - pg client (a single connection; this function
 *   issues BEGIN/COMMIT/ROLLBACK itself, so callers must NOT already be
 *   inside a transaction on this client)
 * @param {object} params
 * @param {string} params.projectId
 * @param {string} params.agentId
 * @param {string} params.kind        - one of KNOWN_KINDS (free-text
 *   convention per §5.8 — unrecognized values are accepted but logged as a
 *   non-fatal warning on the returned result, never rejected: "extend by
 *   convention, not by migration")
 * @param {string} params.body        - caveman body_caveman (full text)
 * @param {string} params.summary     - short digest, DISTINCT from body,
 *   embedded instead of the full body
 * @param {string} [params.sourceModel]
 * @param {string} [params.toAgent]   - null/omitted = broadcast
 * @param {number} [params.docketId]
 * @param {number} [params.parentId]
 * @param {(text:string) => Promise<number[]>} [params.embedder] - injectable
 *   embedder seam; defaults to resolveDefaultEmbedder(client)
 * @param {{table:'tasks', id:number, fromStatus:string, toStatus:string}} [params.transition]
 *   - optional ONE guarded atomic state transition in the SAME transaction
 *     as the INSERT. `table` is a closed enum of 'tasks' only in Phase 7
 *     (§7.7's own sketch targets tasks.status specifically) — any other
 *     value is a hard error, never a silently-ignored transition.
 * @returns {Promise<{id:number, created_at:Date, kindWarning:string|null, transition:object|null}>}
 */
async function appendExchange(client, params) {
  const {
    projectId, agentId, kind, body, summary,
    sourceModel = null, toAgent = null, docketId = null, parentId = null,
    embedder, transition,
  } = params || {};

  if (typeof projectId !== 'string' || !projectId.trim()) {
    throw new ExchangeLogError('validation', 'exchange-log: projectId is required and must be a non-empty string');
  }
  if (typeof agentId !== 'string' || !agentId.trim()) {
    throw new ExchangeLogError('validation', 'exchange-log: agentId is required and must be a non-empty string');
  }
  if (typeof kind !== 'string' || !kind.trim()) {
    throw new ExchangeLogError('validation', 'exchange-log: kind is required and must be a non-empty string');
  }
  if (typeof body !== 'string' || !body.trim()) {
    throw new ExchangeLogError('validation', 'exchange-log: body is required and must be a non-empty string (caveman full text)');
  }
  if (typeof summary !== 'string' || !summary.trim()) {
    throw new ExchangeLogError('validation', 'exchange-log: summary is required and must be a non-empty string (short digest, distinct from body)');
  }
  if (transition && transition.table !== 'tasks') {
    throw new ExchangeLogError('validation', `exchange-log: transition.table must be "tasks" in Phase 7 (got "${transition.table}")`);
  }

  const kindWarning = KNOWN_KINDS.has(kind)
    ? null
    : `kind "${kind}" is not one of the documented vocabulary values (${[...KNOWN_KINDS].join('|')}) — accepted per §5.8's "extend by convention, not by migration", but flagged here for visibility`;

  // ── Embed BEFORE opening the transaction (§7.7 requirement) ────────────
  const embedFn = embedder || await resolveDefaultEmbedder(client);
  const vector = await embedFn(summary);
  const vectorLiteral = `[${vector.join(',')}]`;

  await client.query('BEGIN');
  try {
    const insertRes = await client.query(
      `INSERT INTO agent_exchange
         (project_id, docket_id, parent_id, agent_id, source_model, to_agent, kind, body_caveman, embedding)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING id, created_at`,
      [projectId, docketId, parentId, agentId, sourceModel, toAgent, kind, body, vectorLiteral]
    );
    const exchangeRow = insertRes.rows[0];

    let transitionResult = null;
    if (transition) {
      const { id, fromStatus, toStatus } = transition;
      // Optimistic row-count guard — modeled on the private reference's
      // update-guard shape (see file header), NOT its courtroom-role
      // authorization table (deliberately not ported — see file header).
      const updateRes = await client.query(
        `UPDATE tasks SET status = $1, updated_at = now() WHERE id = $2 AND status = $3 RETURNING id, status`,
        [toStatus, id, fromStatus]
      );
      if (updateRes.rowCount !== 1) {
        throw new ExchangeLogError(
          'transitionRowCountMismatch',
          `Expected 1 row updated on task #${id} ${fromStatus}->${toStatus}; got ${updateRes.rowCount}. Rolling back.`
        );
      }
      transitionResult = updateRes.rows[0];
    }

    await client.query('COMMIT');
    return { id: exchangeRow.id, created_at: exchangeRow.created_at, kindWarning, transition: transitionResult };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  }
}

/**
 * Tool-description text (§3.4/§7.7): the "model reasons, tool ships it"
 * split, stated for any MCP client wiring this up as `exchange_append`
 * (renamed per L15).
 */
const EXCHANGE_APPEND_TOOL_DESCRIPTION = [
  'Append ONE row to the append-only agent_exchange A2A log.',
  '',
  'WRITE SPLIT (§7.7): you (the model) author `body` — the full caveman',
  'reasoning text (§3.1: no authoring_mode escape hatch on this table, A2A',
  'traffic is ALWAYS caveman) — plus `summary`, a SHORT digest DISTINCT',
  'from body. The tool embeds `summary`, not `body`, so the embedding',
  'scores on the digest. Append-only: there is no read/ack status column —',
  'an acknowledgement is a NEW row (kind=\'observation\', parent_id set to',
  'the row being acknowledged), never an update of this row.',
].join('\n');

module.exports = {
  KNOWN_KINDS,
  ExchangeLogError,
  resolveDefaultEmbedder,
  appendExchange,
  EXCHANGE_APPEND_TOOL_DESCRIPTION,
};
