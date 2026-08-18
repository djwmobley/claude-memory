'use strict';

/**
 * scripts/lib/embedding-provider.js
 *
 * Abstract contract for an embedding backend (§9.2 in the origin design).
 * Concrete providers are registered by NAME as rows in the
 * `embedding_providers` table (migrate-schema-addenda.js's
 * embedding-providers-base.sql) -- DATA, not code. Default resolution reads
 * the row with `is_default = true`. This module is the CONTRACT operators
 * implement when adding a new embedding backend.
 *
 * 2026-08-18 (§6.1(g) amendment G-R..., mm#11(g)): this file now ALSO ships
 * the first concrete implementation -- VllmEmbeddingProvider -- and the
 * DB-row resolution helpers (resolveDefaultProvider/resolveProviderById/
 * createProviderFromRow) that migrate-07-reembed-corpus.js is the first
 * caller of. No named real-world model/vendor identifier appears anywhere
 * in this file EXCEPT as data read back out of the embedding_providers
 * table itself (name/model_label/endpoint are all row fields, never
 * literals here) -- this file stays vendor-agnostic; a second provider
 * backend (e.g. an OpenAI-compatible remote endpoint) is a second `name`
 * row plus, if its wire protocol genuinely differs, a second concrete class
 * alongside VllmEmbeddingProvider, never a branch inside this one.
 *
 * OUT OF SCOPE (still, deliberately -- resolver-flip territory, later,
 * human-reviewed): scripts/lib/embed.js's own embedQuery() call path (the
 * resurrect query-embedding seed) is NOT rewired onto this class here. Both
 * files now share ONE underlying HTTP call (embed.js's exported
 * `_vllmEmbedRaw`, reused BY REFERENCE below, never forked) but remain two
 * independent callers with independent truncation targets: embed.js
 * truncates to its own env-configured EMBED_DIMS; VllmEmbeddingProvider
 * truncates to the DB row's `stored_dims` -- the whole point of this file's
 * contract being DB-row-driven rather than env-driven.
 */

const { _vllmEmbedRaw } = require('./embed');

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

/**
 * Concrete provider for a vLLM-compatible /v1/embeddings HTTP endpoint.
 * Every wire-protocol detail (URL, model label, native/stored dims) comes
 * from the constructor -- normally a live `embedding_providers` row (see
 * createProviderFromRow below) -- never a hardcoded literal in this class.
 *
 * Injectable transport (G-R13): the optional `transport` constructor option
 * REPLACES the real HTTP call entirely (`(text, endpoint, modelLabel) =>
 * Promise<number[]>`, same native-vector-out contract as
 * embed.js's `_vllmEmbedRaw`). Tests pass a deterministic fake transport
 * returning fixed-length vectors -- this is how the test suite exercises
 * migrate-07's embed loop, dim-assertion, and truncation logic WITHOUT a
 * live vLLM endpoint (CI has no GPU; see embed.js's own EMBED_MOCK_FIXTURES_PATH
 * precedent for a mock-mode transport, kept separate here because migrate-07
 * needs per-row DETERMINISTIC-BUT-DISTINCT vectors, not a fixed fixture map).
 */
class VllmEmbeddingProvider extends EmbeddingProvider {
  /**
   * @param {object} opts
   * @param {string} opts.name          -- embedding_providers.name (diagnostics only)
   * @param {string} opts.modelLabel    -- embedding_providers.model_label (wire `model` field)
   * @param {number} opts.nativeDims    -- embedding_providers.native_dims
   * @param {number} opts.storedDims    -- embedding_providers.stored_dims
   * @param {string} opts.endpoint      -- embedding_providers.endpoint (base URL)
   * @param {function} [opts.transport] -- injectable (text, endpoint, modelLabel) => Promise<number[]>
   */
  constructor({ name, modelLabel, nativeDims, storedDims, endpoint, transport }) {
    super();
    if (!modelLabel) throw new Error('VllmEmbeddingProvider: modelLabel is required');
    if (!endpoint && !transport) throw new Error('VllmEmbeddingProvider: endpoint is required (unless a test transport is injected)');
    if (!Number.isInteger(nativeDims) || nativeDims <= 0) throw new Error(`VllmEmbeddingProvider: invalid nativeDims (${nativeDims})`);
    if (!Number.isInteger(storedDims) || storedDims <= 0) throw new Error(`VllmEmbeddingProvider: invalid storedDims (${storedDims})`);
    if (storedDims > nativeDims) throw new Error(`VllmEmbeddingProvider: storedDims (${storedDims}) cannot exceed nativeDims (${nativeDims})`);
    this.name = name || null;
    this.modelLabel = modelLabel;
    this.nativeDims = nativeDims;
    this._storedDims = storedDims;
    this.endpoint = endpoint || null;
    this._transport = transport || ((text, url, model) => _vllmEmbedRaw(text, url, model));
  }

  async embed(text) {
    if (typeof text !== 'string' || !text.trim()) {
      throw new Error('VllmEmbeddingProvider.embed: text must be a non-empty string');
    }
    const raw = await this._transport(text, this.endpoint, this.modelLabel);
    if (!Array.isArray(raw) || raw.length === 0) {
      throw new Error(`VllmEmbeddingProvider.embed: transport returned no vector (provider="${this.name || this.modelLabel}")`);
    }
    // Matryoshka truncation: native -> stored (leading-prefix truncation,
    // NEVER a re-normalization or re-projection -- mirrors embed.js's own
    // truncation discipline and scripts/smoketest-resurrect-real-vllm.js's
    // documented assumption that the model is Matryoshka-trained).
    const vector = raw.length > this._storedDims ? raw.slice(0, this._storedDims) : raw;
    return { vector, dims: vector.length, model: this.modelLabel };
  }

  storedDims() {
    return this._storedDims;
  }
}

/**
 * Resolve the row with is_default = true from embedding_providers. FATAL
 * (thrown, never a silent fallback to a hardcoded provider -- L6 vendor-
 * agnosticism, "vLLM or stop") if zero or more than one row is default.
 *
 * @param {import('pg').Client} client
 * @returns {Promise<object>} the embedding_providers row
 */
async function resolveDefaultProvider(client) {
  const { rows } = await client.query(`SELECT * FROM embedding_providers WHERE is_default = true`);
  if (rows.length === 0) {
    throw new Error('resolveDefaultProvider: no embedding_providers row has is_default = true');
  }
  if (rows.length > 1) {
    throw new Error(`resolveDefaultProvider: ${rows.length} embedding_providers rows have is_default = true (expected exactly 1)`);
  }
  return rows[0];
}

/**
 * Resolve a specific embedding_providers row by id. FATAL (thrown) if it
 * does not exist -- never silently substitutes the default.
 *
 * @param {import('pg').Client} client
 * @param {number} id
 * @returns {Promise<object>}
 */
async function resolveProviderById(client, id) {
  const { rows } = await client.query(`SELECT * FROM embedding_providers WHERE id = $1`, [id]);
  if (rows.length === 0) {
    throw new Error(`resolveProviderById: no embedding_providers row with id=${id}`);
  }
  return rows[0];
}

/**
 * Build a concrete VllmEmbeddingProvider from a live embedding_providers
 * row. The ONE place a DB row's columns are read into constructor field
 * names -- callers never hand-map row.* themselves.
 *
 * @param {object} row      -- an embedding_providers row (from resolveDefaultProvider/resolveProviderById)
 * @param {object} [opts]
 * @param {function} [opts.transport] -- injectable transport, see VllmEmbeddingProvider
 * @returns {VllmEmbeddingProvider}
 */
function createProviderFromRow(row, opts = {}) {
  return new VllmEmbeddingProvider({
    name: row.name,
    modelLabel: row.model_label,
    nativeDims: row.native_dims,
    storedDims: row.stored_dims,
    endpoint: row.endpoint,
    transport: opts.transport,
  });
}

module.exports = {
  EmbeddingProvider,
  VllmEmbeddingProvider,
  resolveDefaultProvider,
  resolveProviderById,
  createProviderFromRow,
};
