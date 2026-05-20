'use strict';

/**
 * embed.js — Query-embedding helper for the resurrect semantic seed.
 *
 * Two modes:
 *   1. Mock mode  — when EMBED_MOCK_FIXTURES_PATH is set, loads a JSON fixture
 *                   file and looks up the query text. Fail-loud on cache miss.
 *   2. vLLM mode  — POSTs to the vLLM /v1/embeddings endpoint using the URL
 *                   and model from pipeline.yml (via loadConfig()).
 *
 * Matryoshka truncation: vLLM returns the model's native dimension (4096 for
 * Qwen3-Embedding-8B); leading EMBED_DIMS (default 4000) are kept because
 * pgvector 0.8.1 caps halfvec HNSW indexes at 4000 dims. Qwen3-Embedding-8B is
 * Matryoshka-trained: the leading prefix is a valid embedding. Mirrors the
 * truncation in scripts/lib/shared.js:vllmEmbed.
 *
 * This module does NOT degrade silently. It throws on every error. The caller
 * (handoff.js runResurrectQuery) decides whether to fall through to the
 * pg_trgm fuzzy path.
 *
 * Exports:
 *   embedQuery(text, opts) → Promise<Array<number>>
 *     text  — query string to embed
 *     opts  — optional { vllmUrl, model } overrides (used by tests)
 */

const fs   = require('fs');
const path = require('path');
const http = require('http');
const { loadConfig } = require('./shared');

const EMBED_DIMS = parseInt(process.env.EMBED_DIMS || '4000', 10);

/**
 * Read a key from pipeline.yml knowledge section without a full loadConfig parse.
 * Used to retrieve keys (like vllm_embed_url) that loadConfig does not expose yet.
 */
function _readPipelineYmlKey(root, key) {
  if (!root) return null;
  const configPath = path.join(root, '.claude', 'pipeline.yml');
  if (!fs.existsSync(configPath)) return null;
  const content = fs.readFileSync(configPath, 'utf8');
  // Match key inside the knowledge: section (indented by 2+ spaces).
  const m = content.match(new RegExp(`^\\s+${key}:\\s*"?([^"\\n]+)"?`, 'm'));
  return m ? m[1].trim() : null;
}

/**
 * Load and return the mock fixture map from EMBED_MOCK_FIXTURES_PATH.
 * Cached after first load (module-level cache keyed by path).
 */
const _fixtureCache = new Map();

function _loadFixtures(fixturePath) {
  if (_fixtureCache.has(fixturePath)) return _fixtureCache.get(fixturePath);
  if (!fs.existsSync(fixturePath)) {
    throw new Error(`[embed] mock fixture file not found: ${fixturePath}`);
  }
  let data;
  try {
    data = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
  } catch (err) {
    throw new Error(`[embed] failed to parse mock fixture file "${fixturePath}": ${err.message}`);
  }
  _fixtureCache.set(fixturePath, data);
  return data;
}

/**
 * POST to vLLM /v1/embeddings and return the embedding vector.
 */
function _vllmEmbed(text, vllmUrl, model) {
  return new Promise((resolve, reject) => {
    const url  = new URL('/v1/embeddings', vllmUrl);
    const body = JSON.stringify({ model, input: text, encoding_format: 'float' });

    const isHttps = url.protocol === 'https:';
    const transport = isHttps ? require('https') : http;

    const opts = {
      hostname: url.hostname,
      port:     url.port || (isHttps ? 443 : 80),
      path:     url.pathname,
      method:   'POST',
      headers: {
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    };

    const req = transport.request(opts, (res) => {
      let raw = '';
      res.on('data', (chunk) => { raw += chunk; });
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`[embed] vLLM returned HTTP ${res.statusCode}: ${raw.slice(0, 200)}`));
          return;
        }
        let parsed;
        try {
          parsed = JSON.parse(raw);
        } catch (err) {
          reject(new Error(`[embed] vLLM response JSON parse error: ${err.message}`));
          return;
        }
        const embedding = parsed && parsed.data && parsed.data[0] && parsed.data[0].embedding;
        if (!Array.isArray(embedding) || embedding.length === 0) {
          reject(new Error(`[embed] vLLM response missing data[0].embedding — got: ${raw.slice(0, 200)}`));
          return;
        }
        const truncated = EMBED_DIMS < embedding.length ? embedding.slice(0, EMBED_DIMS) : embedding;
        resolve(truncated);
      });
    });

    req.on('error', (err) => {
      reject(new Error(`[embed] vLLM network error (${vllmUrl}): ${err.message}`));
    });

    req.write(body);
    req.end();
  });
}

/**
 * Embed a query string and return a vector (Array<number>).
 *
 * @param {string} text  — text to embed
 * @param {object} [opts]
 * @param {string} [opts.vllmUrl]  — override vLLM base URL
 * @param {string} [opts.model]    — override embedding model name
 * @returns {Promise<Array<number>>}
 */
async function embedQuery(text, opts = {}) {
  if (typeof text !== 'string' || !text.trim()) {
    throw new Error('[embed] embedQuery: text must be a non-empty string');
  }

  // Mock mode: EMBED_MOCK_FIXTURES_PATH set → look up fixture.
  const fixturePath = process.env.EMBED_MOCK_FIXTURES_PATH;
  if (fixturePath) {
    const fixtures = _loadFixtures(fixturePath);
    if (!Object.prototype.hasOwnProperty.call(fixtures, text)) {
      throw new Error(
        `[embed] mock fixture miss — key not found: "${text}"\n` +
        `  Available keys: ${Object.keys(fixtures).slice(0, 10).map((k) => JSON.stringify(k)).join(', ')}` +
        (Object.keys(fixtures).length > 10 ? ` … (${Object.keys(fixtures).length} total)` : '')
      );
    }
    const vec = fixtures[text];
    if (!Array.isArray(vec)) {
      throw new Error(`[embed] fixture value for key "${text}" is not an array`);
    }
    return vec;
  }

  // vLLM mode.
  let vllmUrl = opts.vllmUrl;
  let model   = opts.model;

  if (!vllmUrl || !model) {
    let cfg;
    try {
      cfg = loadConfig();
    } catch (err) {
      throw new Error(`[embed] loadConfig() failed: ${err.message}`);
    }
    // loadConfig() does not currently parse vllm_embed_url from the knowledge section,
    // so read it directly from the raw config file via the same regex loadConfig uses.
    if (!vllmUrl) {
      vllmUrl = _readPipelineYmlKey(cfg.root, 'vllm_embed_url') || null;
    }
    if (!model) {
      model = (cfg.knowledge && cfg.knowledge.embedding_model) || null;
    }
  }

  if (!vllmUrl) {
    throw new Error('[embed] vLLM URL not configured — set vllm_embed_url in pipeline.yml knowledge section');
  }
  if (!model) {
    throw new Error('[embed] embedding model not configured — set embedding_model in pipeline.yml knowledge section');
  }

  return _vllmEmbed(text, vllmUrl, model);
}

module.exports = { embedQuery };
