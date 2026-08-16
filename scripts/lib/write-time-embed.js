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
 * @returns {Promise<{ vectorLiteral: string|null, warning: string|null }>}
 *   vectorLiteral is a halfvec literal string (e.g. "[0.1,0.2,...]") ready
 *   to bind as a parameterized value, or null on any failure (provider
 *   absent, network error, dimension mismatch). warning is a short,
 *   human-readable string describing the failure, or null on success.
 */
async function embedForWrite(client, text, opts) {
  if (typeof text !== 'string' || !text.trim()) {
    return { vectorLiteral: null, warning: 'write-time-embed: empty embed text — skipped, embedding left NULL' };
  }
  try {
    const embedder = (opts && opts.embedder) || await resolveDefaultEmbedder(client);
    const vector = await embedder(text);
    return { vectorLiteral: `[${vector.join(',')}]`, warning: null };
  } catch (err) {
    return {
      vectorLiteral: null,
      warning: `write-time-embed: embedding failed (fail-soft, row still written with embedding=NULL): ${err.message}`,
    };
  }
}

module.exports = { embedForWrite };
