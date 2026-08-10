'use strict';

/**
 * scripts/lib/embedding-provider.js
 *
 * Abstract contract for an embedding backend (§9.2 in the origin design).
 * Concrete providers are registered by NAME as rows in the
 * `embedding_providers` table (migrate-schema-addenda.js's
 * embedding-providers-base.sql) -- DATA, not code. Default resolution reads
 * the row with `is_default = true`. This module is the CONTRACT operators
 * implement when adding a new embedding backend; it does not itself
 * register, resolve, or call any provider.
 *
 * OUT OF SCOPE (deliberately NOT done by this PR -- resolver-flip
 * territory, later, human-reviewed): the engine's existing embedding call
 * path (scripts/lib/embed.js and its callers) is NOT rewired onto this
 * abstract class here. This file adds a contract other code can eventually
 * implement against; it changes no existing runtime behavior.
 *
 * No named real-world model/vendor identifiers appear anywhere in this
 * file. The one already-shipped seed row ('vllm-local' /
 * 'Qwen3-Embedding-8B' in embedding-providers-base.sql) is pre-existing
 * data from an earlier PR, not something this file adds to.
 */

class EmbeddingProvider {
  /**
   * Embed `text`, resolving to `{ vector, dims, model }`:
   *   vector -- number[], length equal to `dims`
   *   dims   -- the vector's native dimensionality (before any storage-time
   *             truncation a caller might apply -- see storedDims() below)
   *   model  -- free-text identifier for the embedding model that produced
   *             this vector (operator-supplied, not declared by this
   *             contract)
   *
   * @param {string} text
   * @returns {Promise<{ vector: number[], dims: number, model: string }>}
   */
  async embed(text) {
    throw new Error('EmbeddingProvider.embed() not implemented -- this is an abstract base class; operators supply a concrete subclass.');
  }

  /**
   * The dimensionality this provider's vectors are STORED at (which may be
   * less than embed()'s native `dims` -- e.g. Matryoshka truncation to fit
   * a fixed-width halfvec column; see embedding_providers.stored_dims,
   * which this method's return value is expected to match for a registered
   * provider).
   *
   * @returns {number}
   */
  storedDims() {
    throw new Error('EmbeddingProvider.storedDims() not implemented -- this is an abstract base class; operators supply a concrete subclass.');
  }
}

module.exports = { EmbeddingProvider };
