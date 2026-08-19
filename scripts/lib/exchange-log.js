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
const embeddingProvider = require('./embedding-provider.js');

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
 * resolveDefaultEmbedder — cm#201 S-A.2: ONE resolution engine. Delegates
 * to embedding-provider.js's resolveDefaultProvider (strict: throws on 0 or
 * >1 default rows) + createProviderFromRow, and its wire call now goes
 * through that PROVIDER OBJECT (row-driven endpoint/model/stored_dims) --
 * NO LONGER through embed.js's embedQuery()/pipeline.yml. This is a
 * DELIBERATE, PINNED change from the pre-cm#201 shape: embedQuery() stays
 * reserved for the read-time resurrect query-embedding seed only (a
 * genuinely different, env-configured call path -- see embed.js's own
 * header). The reason this matters beyond style: provenance must be TRUE,
 * not merely present -- embedded_by_provider_id must name the row whose
 * endpoint/model ACTUALLY produced the vector, and only the provider-object
 * path is guaranteed to be the SAME object whose `.id` gets stamped
 * alongside it (embedQuery() had no notion of a provider id at all).
 *
 * RETURN-SHAPE CHANGE (PINNED, cm#201 S-A.2): this now returns
 * `{ embed, providerId }` instead of a bare `embedder(text) => vector`
 * function. All FOUR consumers of this shape (exchange-log.js's own
 * appendExchange below, write-time-embed.js, verify-19-seams-smoke.js,
 * verify-20-mcp-surface.js) were updated in the same PR that introduced
 * this change -- see the PR body for the full consumer list.
 *
 * Throws loudly (via resolveDefaultProvider) if zero or more than one
 * default row exists, or if the resolved vector's length does not match
 * the provider's declared stored_dims (a silent dimension mismatch would
 * otherwise corrupt the halfvec(4000) column at INSERT time with a cryptic
 * Postgres error instead of a named one).
 *
 * @param {object} client
 * @returns {Promise<{ providerId: number, embed: (text: string) => Promise<number[]> }>}
 */
async function resolveDefaultEmbedder(client) {
  let providerRow;
  try {
    providerRow = await embeddingProvider.resolveDefaultProvider(client);
  } catch (err) {
    throw new ExchangeLogError(
      'noDefaultProvider',
      `exchange-log: ${err.message} — refusing to embed silently (never a silent skip/fallback per §7.7)`
    );
  }
  const provider = embeddingProvider.createProviderFromRow(providerRow);
  return {
    providerId: providerRow.id,
    embed: async function defaultEmbedder(text) {
      const result = await provider.embed(text); // provider-object-driven wire call (row endpoint/model/stored_dims)
      if (!Array.isArray(result.vector) || result.vector.length !== providerRow.stored_dims) {
        throw new ExchangeLogError(
          'dimensionMismatch',
          `exchange-log: default embedder ("${providerRow.name}") returned ${Array.isArray(result.vector) ? result.vector.length : typeof result.vector} dims, expected ${providerRow.stored_dims}`
        );
      }
      return result.vector;
    },
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
 *   embedder seam; defaults to resolveDefaultEmbedder(client). cm#201
 *   S-A.3: when supplied, `params.embedderProviderId` MUST also be
 *   supplied explicitly (both-or-neither) — the injector names the
 *   provider id its stub vector is attributed to; this seam NEVER
 *   auto-stamps the live default provider's id alongside an injected
 *   (i.e. NOT-actually-that-provider's) embedder, which would be a false
 *   provenance claim.
 * @param {number} [params.embedderProviderId] - required iff params.embedder
 *   is supplied (see above); ignored/unused when params.embedder is absent
 *   (the default path resolves its own providerId internally).
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
    embedder, embedderProviderId, transition,
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

  // cm#201 S-A.3: injected embedder/embedderProviderId is both-or-neither —
  // never auto-stamp the live default provider's id alongside a caller
  // that supplied its OWN embedder (that would be a false provenance
  // claim: the stamped id must name the provider that ACTUALLY produced
  // the vector).
  const embedderGiven = embedder !== undefined && embedder !== null;
  const embedderProviderIdGiven = embedderProviderId !== undefined && embedderProviderId !== null;
  if (embedderGiven !== embedderProviderIdGiven) {
    throw new ExchangeLogError(
      'validation',
      'exchange-log: appendExchange requires BOTH params.embedder and params.embedderProviderId when either is supplied (test seam; never an auto-stamped default alongside an injected embedder).'
    );
  }

  const kindWarning = KNOWN_KINDS.has(kind)
    ? null
    : `kind "${kind}" is not one of the documented vocabulary values (${[...KNOWN_KINDS].join('|')}) — accepted per §5.8's "extend by convention, not by migration", but flagged here for visibility`;

  // ── Embed BEFORE opening the transaction (§7.7 requirement) ────────────
  let embedFn, providerId;
  if (embedderGiven) {
    embedFn = embedder;
    providerId = embedderProviderId;
  } else {
    const resolved = await resolveDefaultEmbedder(client);
    embedFn = resolved.embed;
    providerId = resolved.providerId;
  }
  const vector = await embedFn(summary);
  const vectorLiteral = `[${vector.join(',')}]`;

  await client.query('BEGIN');
  try {
    // cm#201 invariant: every statement that assigns `embedding` ALSO
    // assigns `embedded_by_provider_id` in the SAME statement.
    const insertRes = await client.query(
      `INSERT INTO agent_exchange
         (project_id, docket_id, parent_id, agent_id, source_model, to_agent, kind, body_caveman, embedding, embedded_by_provider_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING id, created_at`,
      [projectId, docketId, parentId, agentId, sourceModel, toAgent, kind, body, vectorLiteral, providerId]
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
 * exchangeRead — §8's exchange_read tool. Polls the append-only
 * agent_exchange log:
 * `WHERE project_id=$1 AND (to_agent=$2 OR to_agent IS NULL) AND
 * created_at > $3` — a WATERMARK, not a status flag (§5.8's append-only
 * design has no `status` column to filter on).
 *
 * (M-8) null/omitted watermark = an EXPLICIT no-floor branch — never a bare
 * `created_at > NULL` bind (which would silently match ZERO rows in SQL's
 * three-valued logic, a correctness bug this function refuses to reproduce
 * by construction: the floor clause is structurally OMITTED from the SQL
 * text entirely when no watermark is given, not passed as a NULL parameter
 * that happens to evaluate false against everything).
 *
 * (M-9) watermark is COMPOUND `(created_at, id)` with `ORDER BY created_at,
 * id` — equal-timestamp rows are never lost. A watermark of
 * `(afterCreatedAt, afterId)` selects rows where
 * `(created_at, id) > (afterCreatedAt, afterId)` (row-wise comparison,
 * lexicographic on the tuple) — the next poll's watermark is simply the
 * last row returned this poll, so re-polling with that exact watermark
 * never re-returns it and never skips a same-timestamp sibling.
 *
 * MILLISECOND TRUNCATION (correctness fix found during authoring): a real
 * MCP caller can only round-trip `created_at` through JSON, which has no
 * native Date type and represents timestamps as millisecond-precision
 * ISO-8601 strings — Postgres TIMESTAMPTZ carries microsecond precision.
 * Comparing a caller's millisecond-truncated watermark directly against
 * the full-precision `created_at` column means a row's OWN timestamp
 * (untruncated) is ALWAYS >= its own truncated watermark, and strictly >
 * whenever it has a nonzero microsecond remainder — causing that SAME row
 * to be spuriously re-returned on the very next poll (empirically
 * reproduced while authoring this file: a poll immediately re-using the
 * just-inserted row's own `created_at`/`id` as the watermark returned that
 * row again). Both the WHERE comparison and the ORDER BY below therefore
 * operate on `date_trunc('milliseconds', created_at)` — matching the
 * precision any real caller can actually supply — with `id` as the
 * tie-breaker for same-millisecond rows (M-9's own "equal-timestamp rows
 * are never lost" guarantee, now anchored to millisecond granularity
 * instead of an unreachable microsecond one).
 *
 * @param {object} client
 * @param {object} args
 * @param {string} args.projectId
 * @param {string} [args.toAgent] — omitted/null = poll the broadcast-or-any
 *   inbox (to_agent = toAgent OR to_agent IS NULL); note toAgent itself is
 *   ALWAYS included in the OR (an agent polling its own inbox sees both
 *   messages addressed to it and broadcasts)
 * @param {string|Date} [args.afterCreatedAt] — watermark timestamp;
 *   omitted/null = no floor (M-8)
 * @param {number} [args.afterId] — watermark id (M-9); REQUIRED whenever
 *   afterCreatedAt is given (a timestamp-only watermark cannot express the
 *   compound-tuple comparison) — omitted while afterCreatedAt is present is
 *   a validation error, never a silent single-column fallback.
 * @param {number} [args.limit] — default 50
 * @returns {Promise<Array<object>>} rows ordered by (created_at, id) ASC
 */
async function exchangeRead(client, args) {
  const { projectId, toAgent = null, afterCreatedAt = null, afterId = null } = args || {};
  if (typeof projectId !== 'string' || !projectId.trim()) {
    throw new ExchangeLogError('validation', 'exchange-log: exchangeRead requires a non-empty projectId');
  }
  if (afterCreatedAt !== null && afterId === null) {
    throw new ExchangeLogError(
      'validation',
      'exchange-log: exchangeRead requires afterId whenever afterCreatedAt is given (M-9: compound watermark, never a timestamp-only comparison).'
    );
  }
  const limit = Number.isInteger(args.limit) && args.limit > 0 ? args.limit : 50;

  // M-8: the floor clause is structurally present or absent from the SQL
  // text itself — never a bare `> $n` bound to a NULL parameter. Both sides
  // of the tuple comparison are millisecond-truncated (see header comment).
  const watermarkClause = afterCreatedAt !== null
    ? "AND (date_trunc('milliseconds', created_at), id) > (date_trunc('milliseconds', $3::timestamptz), $4)"
    : '';
  const params = afterCreatedAt !== null
    ? [projectId, toAgent, afterCreatedAt, afterId, limit]
    : [projectId, toAgent, limit];
  const limitPlaceholder = afterCreatedAt !== null ? '$5' : '$3';

  const { rows } = await client.query(
    `SELECT id, project_id, docket_id, parent_id, agent_id, source_model, to_agent, kind, body_caveman, created_at
       FROM agent_exchange
      WHERE project_id = $1 AND (to_agent = $2 OR to_agent IS NULL)
        ${watermarkClause}
      ORDER BY date_trunc('milliseconds', created_at) ASC, id ASC
      LIMIT ${limitPlaceholder}`,
    params
  );
  return rows;
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
  exchangeRead,
  EXCHANGE_APPEND_TOOL_DESCRIPTION,
};
