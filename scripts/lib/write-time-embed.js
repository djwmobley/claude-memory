'use strict';

/**
 * write-time-embed.js — §8 M-2 inline embedding at write time.
 *
 * "Seam-table rows written via memory_upsert/persist_decisions are embedded
 * INLINE at write time via the SAME provider path exchange_append uses
 * (fail-soft: provider down -> embedding NULL + returned warning,
 * backfillable later). Phase-8 done-bar includes this."
 * (CONSOLIDATION-RUNBOOK.md §8, M-2, memory-manager#18)
 *
 * Deliberately the OPPOSITE fail posture from exchange-log.js's own
 * resolveDefaultEmbedder/appendExchange (which is fail-LOUD by design, per
 * §7.7 — A2A traffic must never silently ship unembedded). M-2 explicitly
 * asks for fail-SOFT here: seam-table writes must still succeed with the row
 * persisted (caveman-authored text is never lost) even when the embedding
 * provider is down; only the embedding column degrades to NULL, with a
 * warning surfaced back to the caller for visibility.
 *
 * Reuses exchange-log.js's resolveDefaultEmbedder (the embedding_providers
 * is_default=true lookup + embedQuery() + dimension-mismatch guard) BY
 * REFERENCE — never a second embedding_providers lookup implementation.
 */

const { resolveDefaultEmbedder } = require('./exchange-log.js');

/**
 * embedForWrite — fail-soft wrapper around resolveDefaultEmbedder's embedder.
 *
 * @param {object} client — pg client/pool
 * @param {string} text — the text to embed (caller decides the concatenation
 *   of which columns feed this, per-table)
 * @param {object} [opts]
 * @param {(text:string) => Promise<number[]>} [opts.embedder] — TEST-ONLY
 *   injectable embedder seam, mirroring exchange-log.js's own `embedder`
 *   param. Production call sites (handoff-mcp.mjs) NEVER pass this — M-2's
 *   spec is "the SAME provider path exchange_append uses" (the
 *   embedding_providers is_default lookup), so the production path always
 *   goes through resolveDefaultEmbedder. This seam exists so CI (no live
 *   vLLM) can exercise the write-time-embed success path deterministically,
 *   the same way verify-19-seams-smoke.js's mockEmbedder() already does for
 *   exchange-log.js.
 * @param {number} [opts.embedderProviderId] — cm#201 S-A.3: REQUIRED
 *   whenever opts.embedder is supplied (both-or-neither, mirroring
 *   exchange-log.js's appendExchange `embedder`/`embedderProviderId`
 *   pairing rule) — the injector names the provider id its stub vector is
 *   attributed to; this seam NEVER auto-stamps the live default provider's
 *   id alongside an injected embedder.
 * @returns {Promise<{ vectorLiteral: string|null, providerId: number|null, warning: string|null }>}
 *   vectorLiteral is a halfvec literal string (e.g. "[0.1,0.2,...]") ready
 *   to bind as a parameterized value, or null on any failure (empty text,
 *   provider absent, network error, dimension mismatch, or a misused
 *   injector seam). cm#201 INVARIANT: (vectorLiteral === null) is ALWAYS
 *   equivalent to (providerId === null) — both null together, or both
 *   non-null together, on EVERY path through this function. warning is a
 *   short, human-readable string describing the failure, or null on
 *   success.
 */
async function embedForWrite(client, text, opts) {
  if (typeof text !== 'string' || !text.trim()) {
    return { vectorLiteral: null, providerId: null, warning: 'write-time-embed: empty embed text — skipped, embedding left NULL' };
  }
  try {
    let embedFn, providerId;
    if (opts && opts.embedder) {
      if (opts.embedderProviderId === undefined || opts.embedderProviderId === null) {
        throw new Error(
          'write-time-embed: opts.embedder was supplied without opts.embedderProviderId (both-or-neither, test seam only) — ' +
          'never auto-stamp the live default provider alongside an injected embedder.'
        );
      }
      embedFn = opts.embedder;
      providerId = opts.embedderProviderId;
    } else {
      const resolved = await resolveDefaultEmbedder(client);
      embedFn = resolved.embed;
      providerId = resolved.providerId;
    }
    const vector = await embedFn(text);
    return { vectorLiteral: `[${vector.join(',')}]`, providerId, warning: null };
  } catch (err) {
    return {
      vectorLiteral: null,
      providerId: null,
      warning: `write-time-embed: embedding failed (fail-soft, row still written with embedding=NULL): ${err.message}`,
    };
  }
}

/**
 * writeRowWithProvenanceRetry — composes embedForWrite with a caller-
 * supplied write function, classifying a Postgres FK 23503 on
 * embedded_by_provider_id (cm#201 S-A.4: the resolved provider row was
 * deleted/deactivated in the race window between resolution and write --
 * e.g. two concurrent writers racing two different is_default flips).
 * Policy: re-resolve the default embedder ONCE and retry with the fresh
 * (embeddingVectorLiteral, embeddedByProviderId) pair; if that retry ALSO
 * hits 23503, degrade to writing the row with NEITHER embedding column
 * (embedding=NULL, embedded_by_provider_id=NULL) plus a warning — the
 * row-never-lost promise is preserved (the row itself is ALWAYS written;
 * only its embedding degrades to backfillable-NULL). Any other write error
 * (not a 23503 on this specific FK) propagates unchanged, immediately.
 *
 * @param {object} client
 * @param {string} embedText — text to embed (already built by the caller,
 *   e.g. via memory-upsert.js's buildEmbedText)
 * @param {(opts:{embeddingVectorLiteral:string|null, embeddedByProviderId:number|null}) => Promise<object>} writeFn
 *   — performs the actual INSERT/UPSERT (writeMemoryRow or
 *   upsertDecisionRow, pre-bound to its table/row by the caller), called
 *   with the both-or-neither opts pair this function computes.
 * @param {object} [embedOpts] — TEST-ONLY, threaded verbatim to EVERY
 *   embedForWrite call this function makes (both the first attempt and the
 *   re-resolve retry) — mirrors embedForWrite's own `opts.embedder`/
 *   `opts.embedderProviderId` injectable seam. Production call sites
 *   (handoff-mcp.mjs) NEVER pass this; CI (no live vLLM) uses it to
 *   exercise the FK-23503-retry orchestration deterministically, with a
 *   fake `writeFn` simulating the FK failure/recovery sequence.
 * @returns {Promise<{ written: object, warning: string|null }>}
 */
async function writeRowWithProvenanceRetry(client, embedText, writeFn, embedOpts) {
  const embed = await embedForWrite(client, embedText, embedOpts);
  try {
    const written = await writeFn({ embeddingVectorLiteral: embed.vectorLiteral, embeddedByProviderId: embed.providerId });
    return { written, warning: embed.warning };
  } catch (err) {
    if (!(err && err.code === '23503' && /embedded_by_provider_id/.test(String(err.message || '') + String(err.constraint || '')))) {
      throw err; // not the race-window FK class -- propagate unchanged
    }
    const reEmbed = await embedForWrite(client, embedText, embedOpts);
    try {
      const written = await writeFn({ embeddingVectorLiteral: reEmbed.vectorLiteral, embeddedByProviderId: reEmbed.providerId });
      return {
        written,
        warning: `write-time-embed: re-resolved embedding provider after FK 23503 on embedded_by_provider_id (race: the provider row changed between resolution and write)${reEmbed.warning ? `; ${reEmbed.warning}` : ''}`,
      };
    } catch (err2) {
      if (!(err2 && err2.code === '23503')) throw err2;
      const written = await writeFn({ embeddingVectorLiteral: null, embeddedByProviderId: null });
      return {
        written,
        warning: `write-time-embed: FK 23503 on embedded_by_provider_id persisted after one re-resolve+retry — row written with embedding=NULL, embedded_by_provider_id=NULL (row-never-lost promise preserved): ${err2.message}`,
      };
    }
  }
}

module.exports = { embedForWrite, writeRowWithProvenanceRetry };
