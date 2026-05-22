/**
 * shared.js — Common utilities for pipeline scripts
 *
 * Exports: findProjectRoot, loadConfig, connect, c, ollamaDefaults
 */

const { Client } = require('pg');
const fs = require('fs');
const path = require('path');

// ─── ANSI ────────────────────────────────────────────────────────────────────

const c = {
  bold:   (s) => `\x1b[1m${s}\x1b[0m`,
  green:  (s) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  red:    (s) => `\x1b[31m${s}\x1b[0m`,
  cyan:   (s) => `\x1b[36m${s}\x1b[0m`,
  dim:    (s) => `\x1b[2m${s}\x1b[0m`,
};

// ─── OLLAMA DEFAULTS ────────────────────────────────────────────────────────

const ollamaDefaults = {
  host: 'localhost',
  port: 11434,
  model: 'mxbai-embed-large',
};

// ─── PROJECT ROOT ───────────────────────────────────────────────────────────

/**
 * Find the project root directory.
 *
 * Resolution order:
 * 1. process.env.PROJECT_ROOT — if set, used as-is (avoids the bug where
 *    scripts invoked via `cd <scripts_dir> && node pipeline-db.js` find
 *    the pipeline plugin's .git instead of the user project's .git).
 * 2. Walk up from cwd looking for a .git directory.
 * 3. Fall back to cwd.
 */
function findProjectRoot() {
  if (process.env.PROJECT_ROOT) return process.env.PROJECT_ROOT;
  let dir = process.cwd();
  while (dir !== path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, '.git'))) return dir;
    dir = path.dirname(dir);
  }
  return process.cwd();
}

// ─── CONFIG ─────────────────────────────────────────────────────────────────

/**
 * Sanitize a project name into a valid Postgres database name.
 * Lowercase, replace non-alphanumeric with underscore, prefix with pipeline_.
 */
function projectToDbName(projectName) {
  const sanitized = projectName.toLowerCase().replace(/[^a-z0-9]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '');
  return `pipeline_${sanitized}`;
}

function loadConfig() {
  const root = findProjectRoot();
  const configPath = path.join(root, '.claude', 'pipeline.yml');
  const projectName = path.basename(root);
  const defaults = {
    host: 'localhost', port: 5432,
    database: projectToDbName(projectName), user: 'postgres',
    project: projectName,
  };

  if (!fs.existsSync(configPath)) return { ...defaults, root, knowledge: { tier: 'files', host: defaults.host, port: defaults.port, database: defaults.database, user: defaults.user, embedding_model: null, num_ctx: null } };
  const content = fs.readFileSync(configPath, 'utf8');

  // Get a top-level key (not indented)
  const getTopLevel = (key) => {
    const match = content.match(new RegExp(`^${key}:\\s*"?([^"\\n]+)"?`, 'm'));
    return match ? match[1].trim() : null;
  };

  // Extract a YAML section (from "key:" to next top-level key or EOF)
  const getSection = (section) => {
    const match = content.match(new RegExp(`^${section}:.*\\r?\\n((?:[ \\t]+.*\\r?\\n?)*)`, 'm'));
    return match ? match[1] : '';
  };

  // Get a value within a specific section
  const getInSection = (section, key) => {
    const sectionContent = getSection(section);
    const match = sectionContent.match(new RegExp(`^\\s*${key}:\\s*"?([^"\\n]+)"?`, 'm'));
    return match ? match[1].trim() : null;
  };

  const resolvedProjectName = getInSection('project', 'name') || defaults.project;
  const tier = getInSection('knowledge', 'tier') || 'files';
  const host = getInSection('knowledge', 'host') || defaults.host;
  const port = parseInt(getInSection('knowledge', 'port') || defaults.port);
  const database = getInSection('knowledge', 'database') || defaults.database;
  const user = getInSection('knowledge', 'user') || defaults.user;
  const embedding_model = getInSection('knowledge', 'embedding_model') || null;
  const num_ctx = getInSection('knowledge', 'num_ctx') || null;
  // storage_backend: 'postgres' (default) or 'sqlite' — read from top-level key.
  // Used by db-seam.js to select the embedded SQLite backend when set to 'sqlite'.
  const storage_backend = getTopLevel('storage_backend') || null;

  return {
    host,
    port,
    database,
    user,
    project: resolvedProjectName,
    storage_backend,
    // knowledge: nested object mirrors routing-config.js shape for cross-script consistency
    knowledge: { tier, host, port, database, user, embedding_model, num_ctx },
    root,
  };
}

// ─── CONNECT ────────────────────────────────────────────────────────────────

async function connect(config) {
  const cfg = config || loadConfig();
  // PGDATABASE env override allows callers (e.g. eval-retrieval's loader subprocess)
  // to direct the connection at a different DB without modifying pipeline.yml.
  const database = process.env.PGDATABASE || cfg.database;
  const client = new Client({
    host: cfg.host,
    port: cfg.port,
    database,
    user: cfg.user,
  });
  await client.connect();
  return client;
}

// ─── OLLAMA EMBED ──────────────────────────────────────────────────────────

const http = require('http');

/**
 * Call Ollama /api/embed to generate vector embeddings for one or more texts.
 * Returns an array of embedding arrays (one per input text).
 */
function ollamaEmbed(texts, config) {
  const model = (config && config.embedding_model) || ollamaDefaults.model;
  const host = ollamaDefaults.host;
  const port = ollamaDefaults.port;
  const numCtx = config && config.num_ctx ? parseInt(config.num_ctx) : null;

  return new Promise((resolve, reject) => {
    const reqBody = { model, input: texts };
    if (numCtx) reqBody.options = { num_ctx: numCtx };
    const body = JSON.stringify(reqBody);
    const opts = {
      hostname: host, port, path: '/api/embed', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    };
    const req = http.request(opts, (res) => {
      let data = '';
      res.on('data', d => { data += d; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (!parsed.embeddings || !Array.isArray(parsed.embeddings)) {
            return reject(new Error(`Ollama error: ${JSON.stringify(parsed).slice(0, 200)}`));
          }
          if (parsed.embeddings.length !== texts.length) {
            return reject(new Error(
              `Ollama returned ${parsed.embeddings.length} embeddings for ${texts.length} inputs ` +
              `(likely context overrun — chunk text smaller before retry)`
            ));
          }
          for (let i = 0; i < parsed.embeddings.length; i++) {
            const vec = parsed.embeddings[i];
            if (!Array.isArray(vec) || vec.length === 0) {
              return reject(new Error(
                `Ollama returned empty embedding at index ${i} ` +
                `(likely context overrun — chunk text smaller before retry)`
              ));
            }
            let sumSquares = 0;
            for (let j = 0; j < vec.length; j++) sumSquares += vec[j] * vec[j];
            if (Math.sqrt(sumSquares) < 1e-9) {
              return reject(new Error(
                `Ollama returned zero-magnitude embedding at index ${i} ` +
                `(likely context overrun — chunk text smaller before retry)`
              ));
            }
          }
          resolve(parsed.embeddings);
        } catch (e) { reject(e); }
      });
    });
    req.on('error', (e) => {
      reject(new Error(`Cannot reach Ollama at ${host}:${port} — is it running? (${e.message})`));
    });
    req.write(body);
    req.end();
  });
}

/**
 * Embed a single text and write the vector to a table row. Degrades gracefully —
 * if Ollama is not running or the embedding column doesn't exist, the row is
 * written without an embedding (can be backfilled later with `pipeline-embed.js index`).
 *
 * @param {Client} client - connected pg Client
 * @param {string} table - table name (MUST be a static constant, never user input)
 * @param {string} idCol - column name for the row identifier
 * @param {*} idVal - value of the row identifier
 * @param {string} text - text to embed
 * @param {object} config - pipeline config (for embedding_model)
 */
async function tryEmbed(client, table, idCol, idVal, text, config) {
  try {
    // Check if embedding column exists
    const { rows } = await client.query(
      "SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = $1 AND column_name = 'embedding'",
      [table]
    );
    if (rows.length === 0) return; // no embedding column — skip silently

    const [embedding] = await ollamaEmbed([text], config);
    const vec = `[${embedding.join(',')}]`;
    await client.query(`UPDATE ${table} SET embedding = $1 WHERE ${idCol} = $2`, [vec, idVal]);
  } catch (_) {
    // Ollama not running or embed failed — row exists without embedding.
    // Backfill later with: node pipeline-embed.js index
  }
}

// ─── WINDOWS BINARY INVOCATION ──────────────────────────────────────────────
//
// Invokes a binary that may be distributed as .cmd or .bat on Windows (pnpm, npx,
// az, yarn, etc.). Handles two Windows subprocess hazards:
//
//   1. PATHEXT resolution. `execFileSync(bin, ...)` with `shell: false` does not
//      resolve PATHEXT, so bare names like `pnpm` fail with ENOENT when the
//      installed file is `pnpm.cmd` or `pnpm.exe`. Caller passes an explicit
//      candidate list and we iterate on ENOENT.
//
//   2. CVE-2024-27980 / "BatBadBut" hardening. Node 22+ refuses to invoke .cmd
//      and .bat files via execFile with `shell: false`, returning EINVAL with
//      "spawnSync <file> EINVAL". Fix: for .cmd/.bat, spawn cmd.exe /d /s /c
//      explicitly with args concatenated into cmd.exe's command-line grammar,
//      with values that contain whitespace or cmd.exe metacharacters quoted.
//
// The helper returns the same shape as execFileSync: stdout string on success,
// throws with stdout / stderr / status / signal on non-zero exit or timeout.
// Caller can catch and inspect as with execFileSync.

function quoteForCmd(arg) {
  const s = typeof arg === 'string' ? arg : String(arg);
  if (s.length === 0) return '""';
  if (!/[\s"&<>|^%()]/.test(s)) return s;
  // cmd.exe convention: wrap in double quotes, escape embedded double quotes by
  // doubling. This covers the common cases — ADO project names with spaces,
  // URLs, paths. It does NOT attempt to defend against variable-expansion
  // injection via `%VAR%` sequences; callers must treat their own args as
  // trusted input (we only use this for CLI flag values we construct ourselves).
  return '"' + s.replace(/"/g, '""') + '"';
}

// cmd.exe's not-found signal: when the command-name after /c doesn't resolve,
// cmd.exe returns exit=1 with stderr starting "'<cmd>' is not recognized as an
// internal or external command". This is indistinguishable from real exit=1
// errors by exit code alone — we match on the stderr string to fall through
// candidates as if ENOENT had been thrown at the Node level.
const CMD_NOT_FOUND_RE = /is not recognized as an internal or external command/;

function runWinBin(candidates, args, opts = {}) {
  const { execFileSync } = require('child_process');
  const isWindows = process.platform === 'win32';
  const effectiveCandidates = isWindows ? candidates : [candidates[candidates.length - 1]];
  let lastErr;

  for (const bin of effectiveCandidates) {
    const isShellExt = isWindows && /\.(cmd|bat)$/i.test(bin);

    if (!isShellExt) {
      try {
        return execFileSync(bin, args, opts);
      } catch (e) {
        lastErr = e;
        if (e.code === 'ENOENT') continue; // try next candidate
        throw e; // real error: invocation failure, non-zero exit, timeout
      }
      continue;
    }

    // .cmd/.bat path: invoke via cmd.exe /d /s /c <bin> <quoted-args...>.
    //   /d — skip AutoRun commands from registry
    //   /s — modify how /c handles quoting (strip outermost quotes if the full
    //        line is quoted; combined with our own quoting, behaves as expected)
    //   /c — execute the command and exit
    const cmdArgs = ['/d', '/s', '/c', bin, ...args.map(quoteForCmd)];
    try {
      return execFileSync('cmd.exe', cmdArgs, opts);
    } catch (e) {
      lastErr = e;
      if (e.code === 'ENOENT') continue; // cmd.exe not on PATH (should never happen)
      // Inspect stderr for cmd.exe's "not recognized" signal — fall through as if
      // the binary had been absent.
      const stderr = e.stderr ? e.stderr.toString('utf8') : '';
      if (CMD_NOT_FOUND_RE.test(stderr)) continue;
      throw e;
    }
  }

  throw lastErr;
}

// ─── VLLM EMBED ──────────────────────────────────────────────────────────────

const VLLM_MODEL = 'Qwen/Qwen3-Embedding-8B';
const VLLM_RERANK_MODEL = 'Qwen/Qwen3-Reranker-4B';

// EMBED_DIMS controls Matryoshka truncation at write time.
// Qwen3-Embedding-8B is Matryoshka-trained: the first N leading dims are a
// valid embedding. pgvector 0.8.1 caps HNSW at 4000 dims for halfvec, so we
// default to 4000 and store halfvec(4000). Set EMBED_DIMS to a smaller value
// (e.g. 3500, 3000) if a future tuning pass finds a better trade-off.
const EMBED_DIMS = parseInt(process.env.EMBED_DIMS || '4000', 10);

/**
 * Parse a base URL string into { hostname, port, basePath }.
 * Falls back to localhost:8800 with an empty basePath on parse failure.
 *
 * @param {string} baseUrl
 * @returns {{ hostname: string, port: number, basePath: string }}
 */
function _parseBaseUrl(baseUrl) {
  let hostname = 'localhost';
  let port = 8800;
  let basePath = '';
  try {
    const parsed = new URL(baseUrl);
    hostname = parsed.hostname;
    port = parseInt(parsed.port) || (parsed.protocol === 'https:' ? 443 : 80);
    basePath = parsed.pathname.replace(/\/$/, '');
  } catch (_) {
    // keep defaults
  }
  return { hostname, port, basePath };
}

/**
 * Call a vLLM-compatible OpenAI /v1/embeddings endpoint to generate vector
 * embeddings for one or more texts. Returns an array of embedding arrays
 * (one per input text), matching the same signature as ollamaEmbed.
 *
 * @param {string[]} texts - Array of strings to embed.
 * @param {object}   [opts] - Optional overrides (currently unused; reserved).
 * @returns {Promise<number[][]>}
 */
function vllmEmbed(texts, opts) {
  const baseUrl = process.env.VLLM_EMBED_URL || 'http://localhost:8800';
  const { hostname, port, basePath } = _parseBaseUrl(baseUrl);
  const reqPath = basePath + '/v1/embeddings';

  return new Promise((resolve, reject) => {
    // The OpenAI /v1/embeddings API accepts either a string or array for input.
    const body = JSON.stringify({ model: VLLM_MODEL, input: texts });
    const reqOpts = {
      hostname,
      port,
      path: reqPath,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    };
    const req = http.request(reqOpts, (res) => {
      let data = '';
      res.on('data', d => { data += d; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (!parsed.data || !Array.isArray(parsed.data)) {
            return reject(new Error(`vLLM error: ${JSON.stringify(parsed).slice(0, 200)}`));
          }
          // Sort by index to guarantee order matches input order.
          const sorted = [...parsed.data].sort((a, b) => a.index - b.index);
          if (sorted.length !== texts.length) {
            return reject(new Error(
              `vLLM returned ${sorted.length} embeddings for ${texts.length} inputs`
            ));
          }
          const embeddings = sorted.map((d, i) => {
            const vec = d.embedding;
            if (!Array.isArray(vec) || vec.length === 0) {
              throw new Error(`vLLM returned empty embedding at index ${i}`);
            }
            let sumSquares = 0;
            for (let j = 0; j < vec.length; j++) sumSquares += vec[j] * vec[j];
            if (Math.sqrt(sumSquares) < 1e-9) {
              throw new Error(`vLLM returned zero-magnitude embedding at index ${i}`);
            }
            // Matryoshka truncation: slice to EMBED_DIMS leading dimensions.
            // Qwen3-Embedding-8B guarantees leading dims preserve semantic load.
            // pgvector 0.8.1 caps halfvec HNSW at 4000 dims; default is 4000.
            return EMBED_DIMS < vec.length ? vec.slice(0, EMBED_DIMS) : vec;
          });
          resolve(embeddings);
        } catch (e) { reject(e); }
      });
    });
    req.on('error', (e) => {
      reject(new Error(`Cannot reach vLLM at ${hostname}:${port} — is it running? (${e.message})`));
    });
    req.write(body);
    req.end();
  });
}

// ─── VLLM RERANK ─────────────────────────────────────────────────────────────

async function vllmRerank(query, documents, opts) {
  const baseUrl = (opts && opts.baseUrl) || process.env.VLLM_RERANK_URL || 'http://localhost:8001';
  const parsed = new URL('/v1/rerank', baseUrl);
  const hostname = parsed.hostname;
  const port = parseInt(parsed.port || (parsed.protocol === 'https:' ? '443' : '80'), 10);
  const pathname = parsed.pathname;

  const body = JSON.stringify({ model: VLLM_RERANK_MODEL, query, documents });

  return new Promise((resolve, reject) => {
    const req = http.request({ hostname, port, path: pathname, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, (res) => {
      let raw = '';
      res.on('data', (chunk) => { raw += chunk; });
      res.on('end', () => {
        try {
          const parsed2 = JSON.parse(raw);
          if (!parsed2.results || !Array.isArray(parsed2.results)) {
            return reject(new Error(`vLLM reranker response missing results array: ${raw.slice(0, 200)}`));
          }
          // Build a lookup from input index -> relevance_score
          const scoreByIndex = new Map();
          for (const entry of parsed2.results) {
            scoreByIndex.set(entry.index, entry.relevance_score);
          }
          // Return in the same order as the input documents array
          const out = documents.map((_, i) => {
            if (!scoreByIndex.has(i)) {
              throw new Error(`vLLM reranker omitted document at index ${i} — cannot continue`);
            }
            return { index: i, score: scoreByIndex.get(i) };
          });
          resolve(out);
        } catch (e) { reject(e); }
      });
    });
    req.on('error', (e) => {
      reject(new Error(`Cannot reach vLLM reranker at ${hostname}:${port} — is it running? (${e.message})`));
    });
    req.write(body);
    req.end();
  });
}

// ─── OLLAMA BLURB GENERATION ─────────────────────────────────────────────────

/**
 * Generate a contextual blurb for a chunk using qwen2.5:14b via Ollama.
 *
 * The blurb is a ≤200-token description of the chunk's topic, suitable for
 * prepending to chunk text at embed time to give the embedder topic-anchored
 * context.
 *
 * @param {string} parentName   - Name of the parent memory entry (doc name).
 * @param {string} heading      - Section heading context (may be empty string).
 * @param {string} content      - The chunk text.
 * @param {object} [opts]       - Optional overrides: { model, host, port }.
 * @returns {Promise<string|null>} Blurb string, or null on failure.
 */
function ollamaGenerateBlurb(parentName, heading, content, opts) {
  const model  = (opts && opts.model)  || 'qwen2.5:14b';
  const host   = (opts && opts.host)   || ollamaDefaults.host;
  const port   = (opts && opts.port)   || ollamaDefaults.port;

  const headingContext = heading ? ` under the section "${heading}"` : '';
  const prompt =
    `You are a concise technical indexer. In at most 2 sentences (≤200 tokens), ` +
    `describe the main topic of the following chunk from the document "${parentName}"${headingContext}. ` +
    `Output only the description — no preamble, no bullets.\n\n${content.slice(0, 1200)}`;

  return new Promise((resolve) => {
    const body = JSON.stringify({ model, prompt, stream: false, options: { num_predict: 200 } });
    const reqOpts = {
      hostname: host,
      port,
      path: '/api/generate',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    };
    const req = http.request(reqOpts, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          const blurb = (parsed.response || '').trim();
          resolve(blurb.length > 0 ? blurb : null);
        } catch (_) {
          resolve(null);
        }
      });
    });
    req.on('error', () => resolve(null));
    req.write(body);
    req.end();
  });
}

// ─── VLLM TOKENIZE ───────────────────────────────────────────────────────────

/**
 * Tokenize text using vLLM's /tokenize endpoint.
 * Returns BPE token strings (Ġ = leading space in the token stream).
 *
 * @param {string} text  - Text to tokenize.
 * @param {object} [opts] - Optional overrides: { baseUrl }.
 * @returns {Promise<{ tokens: string[], token_ids: number[] }>}
 */
function vllmTokenize(text, opts) {
  const baseUrl = (opts && opts.baseUrl) || process.env.VLLM_EMBED_URL || 'http://localhost:8800';
  const { hostname, port, basePath } = _parseBaseUrl(baseUrl);

  const body = JSON.stringify({
    model: VLLM_MODEL,
    prompt: text,
    return_token_strs: true,
    add_special_tokens: false,
  });

  return new Promise((resolve, reject) => {
    const reqOpts = {
      hostname,
      port,
      path: basePath + '/tokenize',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    };
    const req = http.request(reqOpts, (res) => {
      let data = '';
      res.on('data', (d) => { data += d; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          // vLLM /tokenize returns { tokens: int[], token_strs: string[] }
          // (tokens are numeric IDs; the BPE string forms are in token_strs)
          if (!Array.isArray(parsed.token_strs) || !Array.isArray(parsed.tokens)) {
            return reject(new Error(`vLLM /tokenize unexpected response: ${data.slice(0, 200)}`));
          }
          resolve({ tokens: parsed.token_strs, token_ids: parsed.tokens });
        } catch (e) { reject(e); }
      });
    });
    req.on('error', (e) => reject(new Error(`vLLM tokenize error: ${e.message}`)));
    req.write(body);
    req.end();
  });
}

// ─── VLLM TOKEN EMBED ────────────────────────────────────────────────────────

/**
 * Obtain per-token hidden-state vectors from vLLM's /pooling endpoint
 * using task="token_embed". Returns an array of token vectors.
 *
 * @param {string} text   - Text to process.
 * @param {object} [opts] - Optional overrides: { baseUrl }.
 * @returns {Promise<number[][]>} Array of per-token vectors.
 */
function vllmTokenEmbed(text, opts) {
  const baseUrl = (opts && opts.baseUrl) || process.env.VLLM_EMBED_URL || 'http://localhost:8800';
  const { hostname, port, basePath } = _parseBaseUrl(baseUrl);

  const body = JSON.stringify({
    model: VLLM_MODEL,
    input: text,
    task: 'token_embed',
  });

  return new Promise((resolve, reject) => {
    const reqOpts = {
      hostname,
      port,
      path: basePath + '/pooling',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    };
    const req = http.request(reqOpts, (res) => {
      let data = '';
      res.on('data', (d) => { data += d; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          // vLLM /pooling with token_embed returns per-token vectors in data[0].data
          if (!parsed.data || !Array.isArray(parsed.data) || !parsed.data[0]) {
            return reject(new Error(`vLLM /pooling token_embed unexpected response: ${data.slice(0, 200)}`));
          }
          const tokenVectors = parsed.data[0].data;
          if (!Array.isArray(tokenVectors)) {
            return reject(new Error(`vLLM /pooling token_embed: data[0].data is not an array`));
          }
          resolve(tokenVectors);
        } catch (e) { reject(e); }
      });
    });
    req.on('error', (e) => reject(new Error(`vLLM token embed error: ${e.message}`)));
    req.write(body);
    req.end();
  });
}

// ─── LATE CHUNK EMBED ────────────────────────────────────────────────────────

/**
 * Late chunking: embed multiple chunks from a single document pass.
 *
 * Sends the full augmented document text to vLLM /pooling with task="token_embed"
 * to obtain per-token hidden states, then maps chunk character offsets to token
 * spans via /tokenize, mean-pools over each span, and L2-normalizes.
 *
 * Each entry in chunkOffsets is [charStart, charEnd] (character positions in text).
 *
 * Returns one EMBED_DIMS-truncated, L2-normalized vector per chunk.
 *
 * @param {string}       text          - Full document text (augmented with blurbs).
 * @param {number[][]}   chunkOffsets  - Array of [charStart, charEnd] pairs.
 * @param {object}       [opts]        - Optional overrides: { baseUrl }.
 * @returns {Promise<number[][]>}      One vector per chunk (EMBED_DIMS dims).
 */
async function lateChunkEmbed(text, chunkOffsets, opts) {
  // Obtain per-token vectors for the full document
  const tokenVectors = await vllmTokenEmbed(text, opts);

  // Obtain BPE token strings to map char offsets to token indices
  const { tokens } = await vllmTokenize(text, opts);

  // vLLM /pooling appends model special tokens (e.g. <|endoftext|> for Qwen3)
  // even though /tokenize was asked to exclude them. Trim the trailing extras
  // so per-token vectors align 1:1 with the tokenize output used for offsets.
  // Diff > 2 indicates something more wrong than a trailing EOS — fail loud.
  const extras = tokenVectors.length - tokens.length;
  if (extras < 0 || extras > 2) {
    throw new Error(
      `lateChunkEmbed: tokenize returned ${tokens.length} tokens but pooling returned ` +
      `${tokenVectors.length} vectors — cannot map offsets`
    );
  }
  if (extras > 0) tokenVectors.length = tokens.length;

  // Build char-to-token index mapping.
  // Reconstruct character offsets for each token by walking the token strings.
  // BPE tokens: Ġ (U+0120) represents a leading space in the original text.
  const tokenCharStart = new Int32Array(tokens.length);
  const tokenCharEnd   = new Int32Array(tokens.length);
  let charPos = 0;
  for (let i = 0; i < tokens.length; i++) {
    // Replace BPE leading-space marker with actual space for length accounting
    const tokenStr = tokens[i].replace(/Ġ/g, ' ');
    tokenCharStart[i] = charPos;
    charPos += tokenStr.length;
    tokenCharEnd[i] = charPos;
  }

  const dim = tokenVectors[0] ? tokenVectors[0].length : 0;
  const results = [];

  for (const [cStart, cEnd] of chunkOffsets) {
    // Find token span covering [cStart, cEnd)
    let tStart = -1;
    let tEnd   = -1;
    for (let i = 0; i < tokens.length; i++) {
      if (tStart === -1 && tokenCharEnd[i] > cStart) tStart = i;
      if (tokenCharStart[i] < cEnd) tEnd = i + 1;
    }

    if (tStart === -1 || tEnd <= tStart) {
      // No tokens in range — return zero vector as fallback
      results.push(new Array(EMBED_DIMS).fill(0));
      continue;
    }

    // Mean-pool over the token span
    const pooled = new Float64Array(dim);
    for (let i = tStart; i < tEnd; i++) {
      const vec = tokenVectors[i];
      for (let j = 0; j < dim; j++) pooled[j] += vec[j];
    }
    const spanLen = tEnd - tStart;
    for (let j = 0; j < dim; j++) pooled[j] /= spanLen;

    // L2-normalize
    let sumSq = 0;
    for (let j = 0; j < dim; j++) sumSq += pooled[j] * pooled[j];
    const norm = Math.sqrt(sumSq);
    const normalized = norm > 1e-9
      ? Array.from(pooled).map((v) => v / norm)
      : Array.from(pooled);

    // Matryoshka truncation to EMBED_DIMS
    results.push(EMBED_DIMS < normalized.length ? normalized.slice(0, EMBED_DIMS) : normalized);
  }

  return results;
}

// ─── EXPORTS ────────────────────────────────────────────────────────────────

module.exports = {
  findProjectRoot, loadConfig, connect, c, ollamaDefaults, projectToDbName,
  ollamaEmbed, vllmEmbed, tryEmbed, runWinBin, quoteForCmd, vllmRerank,
  ollamaGenerateBlurb, vllmTokenize, vllmTokenEmbed, lateChunkEmbed,
};
