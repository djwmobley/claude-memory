'use strict';

/**
 * generate-embed-fixtures.js — One-shot script to generate deterministic embed
 * fixtures for the resurrect semantic seed tests.
 *
 * Two modes:
 *
 * 1. REAL MODE (default): Calls the configured vLLM embedder
 *    (Qwen/Qwen3-Embedding-8B @ port 8800) to get real model vectors.
 *    Writes test/handoff/fixtures/embed-fixtures.json.
 *
 * 2. SYNTHETIC MODE (--synthetic): Generates mathematically-constructed unit
 *    vectors with guaranteed cosine similarity properties. No vLLM required.
 *    Use this when vLLM is unavailable or to create a self-contained fixture set.
 *    Synthetic vectors satisfy ALL test A–I similarity invariants by construction.
 *
 * Fixture schema:
 *   {
 *     "<query-text>": [<n1>, ..., <n4000>],   // query-side vectors
 *     "_row:<subject>:<predicate>:<object>": [...]  // row-side vectors
 *   }
 *
 * Row-side keys follow the convention "_row:<subject>:<predicate>:<object>".
 * embed.js looks up query keys directly by exact text; test setup seeds row
 * vectors using these keys via insertAssertionWithEmbedding().
 *
 * Usage:
 *   node scripts/dev/generate-embed-fixtures.js             # real vLLM
 *   node scripts/dev/generate-embed-fixtures.js --synthetic # math vectors
 *
 * Prerequisites (real mode only):
 *   - vLLM running at http://localhost:8800 with Qwen/Qwen3-Embedding-8B
 *   - Start if needed: wsl --exec bash ~/start-vllm-040.sh
 *
 * Regenerate in real mode whenever test queries change and you want actual
 * model vectors. The synthetic mode is always available as a fallback.
 *
 * Output: test/handoff/fixtures/embed-fixtures.json
 */

const fs   = require('fs');
const path = require('path');
const http = require('http');

const REPO_ROOT   = path.resolve(__dirname, '..', '..');
const OUTPUT_FILE = path.join(REPO_ROOT, 'test', 'handoff', 'fixtures', 'embed-fixtures.json');
const VLLM_URL    = process.env.VLLM_URL    || 'http://localhost:8800';
const EMBED_MODEL = process.env.EMBED_MODEL || 'Qwen/Qwen3-Embedding-8B';
const DIM         = 4000;
const SYNTHETIC   = process.argv.includes('--synthetic');

// ─── Text pairs ───────────────────────────────────────────────────────────────
//
// Each entry defines:
//   query  — the seed text used by tests (key in fixtures JSON)
//   rows   — array of row texts (key format: _row:<subject>:<predicate>:<object>)
//   close  — true  → cosine sim >= 0.75 (θ=20°, sim≈0.94)
//             false → cosine sim ∈ (0.01, 0.75) — above 0.01 threshold (θ=60°, sim≈0.50)
//                     Test B-3 lowers threshold to 0.01, which is BELOW 0.50, so
//                     the row now fails even the low threshold. To test "lowering
//                     includes more rows", we use close:'medium' → sim≈0.50, so:
//                       threshold=0.75: excluded (0.50 < 0.75)
//                       threshold=0.01: still excluded (0.50 > 0.01) — wait, 0.01 is LOWER...
//
// REVISED CONVENTION for test B:
//   close: true   → sim ≈ 0.94  (above 0.75 threshold — included)
//   close: 'medium' → sim ≈ 0.50 (BELOW 0.75 threshold — excluded at default)
//                                  ABOVE 0.40 threshold — included when threshold lowered to 0.40
//
// In test B-3, we set threshold=0.40 to include the 'medium' row.

const TEXT_PAIRS = [
  // ── A / C / D / E / H / I ────────────────────────────────────────────────
  {
    query: 'authentication service token configuration',
    rows: [
      { text: '_row:auth-service:token_expiry:24h', close: true },
    ],
  },

  // ── B: threshold gate ────────────────────────────────────────────────────
  {
    query: 'database connection pooling settings',
    rows: [
      { text: '_row:postgres-pool:max_connections:50', close: true     },
      { text: '_row:css-theme:primary_color:blue',    close: 'medium' },
    ],
  },

  // ── C / D (unused in tests but kept for completeness) ────────────────────
  {
    query: 'cache eviction policy',
    rows: [
      { text: '_row:cache-backend:eviction_policy:LRU', close: true },
    ],
  },

  // ── F: multi-project isolation ───────────────────────────────────────────
  {
    query: 'API rate limiting configuration',
    rows: [
      { text: '_row:api-gateway:rate_limit:1000rpm', close: true },
      { text: '_row:api-gateway:rate_limit:500rpm',  close: true },
    ],
  },

  // ── G: token-budget enforcement ──────────────────────────────────────────
  {
    query: 'deployment pipeline configuration',
    rows: [
      { text: '_row:deploy-pipeline:stage:build',          close: true },
      { text: '_row:deploy-pipeline:stage:test',           close: true },
      { text: '_row:deploy-pipeline:stage:publish',        close: true },
      { text: '_row:deploy-pipeline:timeout:30m',          close: true },
      { text: '_row:deploy-pipeline:trigger:push',         close: true },
      { text: '_row:deploy-pipeline:environment:production', close: true },
    ],
  },
];

// ─── Synthetic vector generation ──────────────────────────────────────────────
//
// Strategy: deterministic PRNG based on MurmurHash-style seed.
// "Close" pairs: query vector + small rotation (cos sim ≈ 0.95).
// "Distant" pairs: independently seeded vector (cos sim ≈ 0.0–0.15).

function mulberry32(seed) {
  return function () {
    let t = seed += 0x6d2b79f5;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function strToSeed(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

function randomUnitVector(prng) {
  const v = new Float64Array(DIM);
  for (let i = 0; i < DIM; i++) {
    // Box-Muller for Gaussian distribution, then normalize
    const u1 = prng() || 1e-10;
    const u2 = prng();
    v[i] = Math.sqrt(-2.0 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  }
  // Normalize to unit length
  let norm = 0;
  for (let i = 0; i < DIM; i++) norm += v[i] * v[i];
  norm = Math.sqrt(norm);
  for (let i = 0; i < DIM; i++) v[i] /= norm;
  return Array.from(v);
}

function dotProduct(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

/**
 * Create a rotated unit vector at angle θ from `base`.
 * Result has cosine similarity cos(θ) with `base`.
 *
 * @param {number[]} base       — Unit vector to rotate from.
 * @param {Function} perpPrng   — PRNG for the perpendicular component.
 * @param {number}   cosTheta   — Target cosine similarity (= cos of rotation angle).
 * @returns {number[]}
 */
function rotatedVector(base, perpPrng, cosTheta) {
  const sinTheta = Math.sqrt(Math.max(0, 1 - cosTheta * cosTheta));
  const perp = randomUnitVector(perpPrng);
  // Gram-Schmidt: remove base component so perp is truly orthogonal.
  const dp = dotProduct(perp, base);
  const truePerp = perp.map((x, i) => x - dp * base[i]);
  let perpNorm = 0;
  for (const x of truePerp) perpNorm += x * x;
  perpNorm = Math.sqrt(perpNorm);
  if (perpNorm < 1e-10) {
    // Degenerate (theoretically impossible in high dim) — return base.
    return base.slice();
  }
  const normPerp = truePerp.map((x) => x / perpNorm);
  const v = base.map((x, i) => cosTheta * x + sinTheta * normPerp[i]);
  // Re-normalize (should already be unit, but guard against floating-point drift).
  let norm = 0;
  for (const x of v) norm += x * x;
  norm = Math.sqrt(norm);
  return v.map((x) => x / norm);
}

function generateSynthetic() {
  const fixtures = {};

  for (const pair of TEXT_PAIRS) {
    // Generate the query unit vector from a deterministic seed.
    const qPrng = mulberry32(strToSeed(pair.query));
    const qVec  = randomUnitVector(qPrng);
    fixtures[pair.query] = qVec;

    for (const row of pair.rows) {
      const perpPrng = mulberry32(strToSeed(row.text));
      if (row.close === true) {
        // cos(20°) ≈ 0.9397 — well above 0.75 threshold.
        fixtures[row.text] = rotatedVector(qVec, perpPrng, 0.9397);
      } else if (row.close === 'medium') {
        // cos(60°) = 0.5000 — below 0.75 threshold but above 0.40 threshold.
        // Test B-3 lowers threshold to 0.40 to include this row.
        fixtures[row.text] = rotatedVector(qVec, perpPrng, 0.5000);
      } else {
        // Independent random vector — near-orthogonal (sim ≈ 0.0 in high dim).
        fixtures[row.text] = randomUnitVector(perpPrng);
      }
    }
  }

  // Sanity check: print similarities to verify invariants.
  console.log('\nSanity check (cosine similarities):');
  for (const pair of TEXT_PAIRS) {
    for (const row of pair.rows) {
      const sim = dotProduct(fixtures[pair.query], fixtures[row.text]);
      let expected, ok;
      if (row.close === true)       { expected = '>= 0.75'; ok = sim >= 0.75; }
      else if (row.close === 'medium') { expected = '0.40-0.74'; ok = sim >= 0.40 && sim < 0.75; }
      else                           { expected = '< 0.40';  ok = sim < 0.40; }
      const flag = ok ? 'OK' : 'FAIL';
      console.log(`  [${flag}] sim("${pair.query.slice(0, 35)}", "${row.text.slice(0, 35)}") = ${sim.toFixed(4)}  [${expected}]`);
    }
  }

  return fixtures;
}

// ─── vLLM embed helper ─────────────────────────────────────────────────────────

function embedOne(text) {
  return new Promise((resolve, reject) => {
    const url  = new URL('/v1/embeddings', VLLM_URL);
    const body = JSON.stringify({ model: EMBED_MODEL, input: text, encoding_format: 'float' });
    const opts = {
      hostname: url.hostname,
      port:     parseInt(url.port || '80', 10),
      path:     url.pathname,
      method:   'POST',
      headers: {
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    };
    const req = http.request(opts, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`HTTP ${res.statusCode}: ${raw.slice(0, 200)}`));
          return;
        }
        try {
          const parsed = JSON.parse(raw);
          const vec = parsed.data && parsed.data[0] && parsed.data[0].embedding;
          if (!Array.isArray(vec) || vec.length === 0) {
            reject(new Error(`missing data[0].embedding: ${raw.slice(0, 200)}`));
            return;
          }
          // Matryoshka truncation to DIM. Qwen3-Embedding-8B returns native 4096;
          // pgvector 0.8.1 caps halfvec HNSW at 4000 dims, so leading DIM dims are
          // the stable storage form (mirrors scripts/lib/{shared,embed}.js).
          const truncated = DIM < vec.length ? vec.slice(0, DIM) : vec;
          resolve(truncated);
        } catch (err) {
          reject(new Error(`JSON parse: ${err.message}`));
        }
      });
    });
    req.on('error', (err) => reject(new Error(`network: ${err.message}`)));
    req.write(body);
    req.end();
  });
}

async function generateReal() {
  const allTexts = [];
  for (const pair of TEXT_PAIRS) {
    allTexts.push(pair.query);
    for (const row of pair.rows) allTexts.push(row.text);
  }
  const uniqueTexts = [...new Set(allTexts)];

  console.log(`Embedding ${uniqueTexts.length} texts via ${VLLM_URL} (model: ${EMBED_MODEL})`);

  // Health check.
  try {
    const hv = await embedOne('health');
    console.log(`vLLM OK — vector dim after Matryoshka truncation: ${hv.length} (target ${DIM})`);
    if (hv.length !== DIM) {
      throw new Error(`post-truncation dim ${hv.length} != target ${DIM} — refusing to write fixtures that won't load into halfvec(${DIM})`);
    }
  } catch (err) {
    console.error(`\nFATAL: vLLM not reachable at ${VLLM_URL}: ${err.message}`);
    console.error('Start vLLM: wsl --exec bash ~/start-vllm-040.sh');
    console.error('Alternatively run with --synthetic to generate math vectors: node scripts/dev/generate-embed-fixtures.js --synthetic');
    process.exit(1);
  }

  const fixtures = {};
  for (let i = 0; i < uniqueTexts.length; i++) {
    const text = uniqueTexts[i];
    process.stdout.write(`  [${i + 1}/${uniqueTexts.length}] ${text.slice(0, 60)}...`);
    try {
      fixtures[text] = await embedOne(text);
      process.stdout.write(` dim=${fixtures[text].length} OK\n`);
    } catch (err) {
      process.stderr.write(`\n  FAILED: ${err.message}\n`);
      process.exit(1);
    }
  }

  return fixtures;
}

// ─── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  let fixtures;

  if (SYNTHETIC) {
    console.log(`Generating SYNTHETIC fixtures (DIM=${DIM}, guaranteed similarity invariants)`);
    fixtures = generateSynthetic();
  } else {
    fixtures = await generateReal();

    // Sanity check for real mode.
    console.log('\nSanity check (cosine similarities):');
    for (const pair of TEXT_PAIRS) {
      for (const row of pair.rows) {
        if (fixtures[pair.query] && fixtures[row.text]) {
          const sim = dotProduct(fixtures[pair.query], fixtures[row.text]);
          let expected, ok;
          if (row.close === true)         { expected = '>= 0.75';  ok = sim >= 0.75; }
          else if (row.close === 'medium') { expected = '0.40-0.74'; ok = sim >= 0.40 && sim < 0.75; }
          else                             { expected = '< 0.40';   ok = sim < 0.40; }
          const flag = ok ? 'OK' : 'WARN';
          console.log(`  [${flag}] sim("${pair.query.slice(0, 35)}", "${row.text.slice(0, 35)}") = ${sim.toFixed(4)}  [${expected}]`);
          if (!ok) {
            console.warn(`  NOTE: Invariant not satisfied — pair has sim=${sim.toFixed(4)}.`);
            console.warn('  Consider adjusting test thresholds or using --synthetic mode.');
          }
        }
      }
    }
  }

  // Ensure output directory exists.
  fs.mkdirSync(path.dirname(OUTPUT_FILE), { recursive: true });
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(fixtures, null, 2) + '\n', 'utf8');
  const mode = SYNTHETIC ? 'SYNTHETIC' : 'REAL (vLLM)';
  console.log(`\n[${mode}] Wrote ${Object.keys(fixtures).length} fixtures to ${OUTPUT_FILE}`);
  console.log('Commit test/handoff/fixtures/embed-fixtures.json to check it in.');
}

function dotProduct(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
