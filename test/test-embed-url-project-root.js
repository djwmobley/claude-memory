'use strict';

/**
 * test-embed-url-project-root.js — embed-url-from-project-root fix
 * (2026-09-13, cm incident: a Codex host launched the MCP server with cwd
 * `.codex-temp` and called `memory_search` with a DIFFERENT `projectRoot`;
 * the embedder threw because query-time embed-URL/model resolution used to
 * read the SERVER PROCESS'S cwd via loadConfig()/findProjectRoot(), never
 * the tool call's own `projectRoot` argument).
 *
 * Pure-unit, no live Postgres, no live vLLM. A tiny in-process HTTP server
 * stands in for vLLM's `/v1/embeddings` endpoint where a real embed call is
 * exercised (M1, S3) — deterministic and network-free beyond localhost.
 *
 * Case list (per the authoring spec):
 *   R1  explicit (opts.vllmUrl) wins over every other tier
 *   R2  pipeline.yml under projectRoot wins over env and user-scope
 *   R3  env wins when pipeline.yml is absent or its value is empty
 *   R4  user-scope wins when the first three tiers are absent
 *   R5  all absent -> {url:null, source:null, reason:'unconfigured'}
 *   R6  cwd is completely ignored (a pipeline.yml in cwd is never read)
 *   R7  process.env.PROJECT_ROOT is never consulted, even when set
 *   R8  a relative or non-string projectRoot is a hard input error (throws)
 *   R9  vllm_embed_url under a non-knowledge section/bare top level is not picked up
 *   R10 a whitespace-only env value is rejected (falls through)
 *   R11 a non-string opts.vllmUrl is ignored (falls through)
 *   M1  embedQuery's embedding_model fallback resolves from projectRoot's
 *       own pipeline.yml, never cwd's (split-brain guard)
 *   S1  unresolvable URL -> memorySearch degrades to FTS-only, no throw
 *   S2  buildTableQuery's fts_only SQL has no vector placeholder / no
 *       `embedding IS NOT NULL`; hasFts:false tables skipped as
 *       no_fts_column; note lists them
 *   S3  a resolvable URL -> embedStatus 'ok', searchMode 'hybrid', SQL
 *       identical to today's hybrid buildTableQuery output
 *   S4  an injected args.embedder bypasses resolution entirely (stays
 *       hybrid/ok even against an otherwise-unconfigured projectRoot)
 *   S5  an embedder that throws still propagates (never swallowed)
 *   C1  the CLI path (no opts.projectRoot) is byte-for-byte unchanged —
 *       resolves via loadConfig()/PROJECT_ROOT env and throws the exact
 *       pre-existing message when unconfigured
 *
 * Usage: node test/test-embed-url-project-root.js
 * Exit 0 = all pass; nonzero = any failure.
 */

const fs   = require('fs');
const os   = require('os');
const path = require('path');
const http = require('http');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const { resolveConfiguredEmbedEndpointDetailed } = require(path.join(PROJECT_ROOT, 'scripts', 'lib', 'embedding-provider.js'));
const { embedQuery, resolveEmbedUrl } = require(path.join(PROJECT_ROOT, 'scripts', 'lib', 'embed.js'));
const { memorySearch, buildTableQuery, TABLE_DESCRIPTORS, EMBEDDING_COLUMN, FTS_COLUMN } = require(path.join(PROJECT_ROOT, 'scripts', 'lib', 'memory-search.js'));
const { withIsolatedHandoffBaseDir } = require(path.join(PROJECT_ROOT, 'scripts', 'lib', 'test-env-isolation.js'));
const { VLLM_MODEL } = require(path.join(PROJECT_ROOT, 'scripts', 'lib', 'shared.js'));

let passed = 0, failed = 0;
async function test(label, fn) {
  try {
    await fn();
    console.log(`  [PASS] ${label}`);
    passed++;
  } catch (err) {
    console.error(`  [FAIL] ${label}: ${err && err.stack ? err.stack : err}`);
    failed++;
  }
}
function assertEqual(actual, expected, msg) {
  if (actual !== expected) {
    throw new Error(`${msg || 'assertEqual failed'} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }

function makeTmpProjectRoot(pipelineYmlBody) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'embed-url-project-root-test-'));
  fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
  if (pipelineYmlBody !== null) {
    fs.writeFileSync(path.join(dir, '.claude', 'pipeline.yml'), pipelineYmlBody, 'utf8');
  }
  return dir;
}

// Isolates HANDOFF_BASE_DIR (user-scope tier 3, see test-env-isolation.js's
// own header) AND clears VLLM_EMBED_URL/PROJECT_ROOT from the real process
// env for the duration of fn — every test in this file that must observe a
// deterministic tier-2/tier-3/cwd-ignored result runs through this, so a
// developer machine's own real ~/.claude/handoff-embed.json or exported
// VLLM_EMBED_URL/PROJECT_ROOT can never leak into an assertion.
async function withIsolatedEmbedEnv(fn) {
  const savedVllmUrl = process.env.VLLM_EMBED_URL;
  const savedProjectRootEnv = process.env.PROJECT_ROOT;
  delete process.env.VLLM_EMBED_URL;
  delete process.env.PROJECT_ROOT;
  try {
    return await withIsolatedHandoffBaseDir(fn);
  } finally {
    if (savedVllmUrl === undefined) delete process.env.VLLM_EMBED_URL; else process.env.VLLM_EMBED_URL = savedVllmUrl;
    if (savedProjectRootEnv === undefined) delete process.env.PROJECT_ROOT; else process.env.PROJECT_ROOT = savedProjectRootEnv;
  }
}

// A minimal fake vLLM /v1/embeddings endpoint — captures the last parsed
// request body (so a test can assert which `model` was sent) and always
// answers with a small, fixed, deterministic vector.
function startFakeVllmServer(fixedVector) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => { raw += c; });
      req.on('end', () => {
        try { server.lastRequestBody = JSON.parse(raw); } catch (_) { server.lastRequestBody = null; }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data: [{ embedding: fixedVector, index: 0 }] }));
      });
    });
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

// A bare pg-Client-shaped mock with no schemaObjectsExist/checkColumnShape —
// memory-search.js's probeTableAvailability degrades this to "assume every
// candidate table exists" (its own documented legacy-fallback branch), so
// these tests never need to stand up a fake schema probe.
function makeBareClient(queryImpl) {
  return { async query(sql, values) { return queryImpl(sql, values); } };
}

// A schema-probe-ANSWERING mock (mirrors scripts/test-memory-search-gate.js's
// own makeMockClient) — Codex review finding 3: S1/S2 previously used
// makeBareClient, which bypasses probeTableAvailability's real
// schemaObjectsExist/checkColumnShape path entirely (memory-search.js's own
// documented "no schema probe methods -> assume everything present" legacy
// fallback), so a fts_only-mode bug in the column-requirement gate (finding
// 3: the probe used to require the embedding column even in fts_only mode)
// could never be caught by these tests. This mock actually enforces
// missingColumns/missingTables/shapes, exercising the SAME probe path a real
// PostgresAdapter would.
function makeSchemaAwareClient({ missingTables = [], missingColumns = [], shapes = {}, queryImpl } = {}) {
  return {
    async schemaObjectsExist({ tables, columns }) {
      const missing = [];
      for (const t of tables) if (missingTables.includes(t)) missing.push({ type: 'table', table: t });
      for (const c of columns) {
        if (missingTables.includes(c.table)) continue; // already reported as table-missing
        if (missingColumns.some((mc) => mc.table === c.table && mc.column === c.column)) {
          missing.push({ type: 'column', table: c.table, column: c.column });
        }
      }
      return { ok: missing.length === 0, missing };
    },
    async checkColumnShape(table, column) {
      const key = `${table}.${column}`;
      if (Object.prototype.hasOwnProperty.call(shapes, key)) return shapes[key];
      return { type: column === FTS_COLUMN ? 'tsvector' : 'halfvec', dims: column === FTS_COLUMN ? null : 4000 };
    },
    async query(sql, values) { return queryImpl(sql, values); },
  };
}

(async () => {
  // ─── R1-R11: resolveConfiguredEmbedEndpointDetailed tier/edge cases ──────

  console.log('\n=== R1-R11: resolveConfiguredEmbedEndpointDetailed tiers and edge cases ===');

  await test('R1: explicit (opts.vllmUrl) wins over pipeline.yml, env, and user-scope', async () => {
    await withIsolatedEmbedEnv(async () => {
      const root = makeTmpProjectRoot(`
knowledge:
  vllm_embed_url: "http://127.0.0.1:1"
`.trim());
      fs.writeFileSync(path.join(process.env.HANDOFF_BASE_DIR, 'handoff-embed.json'), JSON.stringify({ vllm_embed_url: 'http://127.0.0.1:2' }), 'utf8');
      const result = resolveConfiguredEmbedEndpointDetailed({
        vllmUrl: 'http://127.0.0.1:3', projectRoot: root, env: { VLLM_EMBED_URL: 'http://127.0.0.1:4' },
      });
      assertEqual(result.url, 'http://127.0.0.1:3');
      assertEqual(result.source, 'explicit');
    });
  });

  await test('R2: pipeline.yml under projectRoot wins over env and user-scope', async () => {
    await withIsolatedEmbedEnv(async () => {
      const root = makeTmpProjectRoot(`
knowledge:
  vllm_embed_url: "http://127.0.0.1:5001"
`.trim());
      fs.writeFileSync(path.join(process.env.HANDOFF_BASE_DIR, 'handoff-embed.json'), JSON.stringify({ vllm_embed_url: 'http://127.0.0.1:5002' }), 'utf8');
      const result = resolveConfiguredEmbedEndpointDetailed({ projectRoot: root, env: { VLLM_EMBED_URL: 'http://127.0.0.1:5003' } });
      assertEqual(result.url, 'http://127.0.0.1:5001');
      assertEqual(result.source, 'pipeline_yml');
    });
  });

  await test('R3a: env wins when pipeline.yml is entirely absent', async () => {
    await withIsolatedEmbedEnv(async () => {
      const root = makeTmpProjectRoot(null); // no .claude/pipeline.yml at all
      const result = resolveConfiguredEmbedEndpointDetailed({ projectRoot: root, env: { VLLM_EMBED_URL: 'http://127.0.0.1:5004' } });
      assertEqual(result.url, 'http://127.0.0.1:5004');
      assertEqual(result.source, 'env');
    });
  });

  await test('R3b: env wins when pipeline.yml has an empty-string vllm_embed_url value', async () => {
    await withIsolatedEmbedEnv(async () => {
      const root = makeTmpProjectRoot(`
knowledge:
  vllm_embed_url: ""
`.trim());
      const result = resolveConfiguredEmbedEndpointDetailed({ projectRoot: root, env: { VLLM_EMBED_URL: 'http://127.0.0.1:5005' } });
      assertEqual(result.url, 'http://127.0.0.1:5005');
      assertEqual(result.source, 'env');
    });
  });

  await test('R4: user-scope wins when pipeline.yml, explicit, and env are all absent', async () => {
    await withIsolatedEmbedEnv(async () => {
      const root = makeTmpProjectRoot(null);
      fs.writeFileSync(path.join(process.env.HANDOFF_BASE_DIR, 'handoff-embed.json'), JSON.stringify({ vllm_embed_url: 'http://127.0.0.1:5006' }), 'utf8');
      const result = resolveConfiguredEmbedEndpointDetailed({ projectRoot: root, env: {} });
      assertEqual(result.url, 'http://127.0.0.1:5006');
      assertEqual(result.source, 'user_scope');
    });
  });

  await test('R5: all four tiers absent -> {url:null, source:null, reason:"unconfigured"}', async () => {
    await withIsolatedEmbedEnv(async () => {
      const root = makeTmpProjectRoot(null);
      const result = resolveConfiguredEmbedEndpointDetailed({ projectRoot: root, env: {} });
      assertEqual(result.url, null);
      assertEqual(result.source, null);
      assertEqual(result.reason, 'unconfigured');
    });
  });

  await test('R6: cwd is completely ignored — a valid pipeline.yml sitting in cwd is never consulted', async () => {
    await withIsolatedEmbedEnv(async () => {
      const tmpA = makeTmpProjectRoot(null); // the EXPLICIT projectRoot — no yml
      const tmpB = makeTmpProjectRoot(`
knowledge:
  vllm_embed_url: "http://127.0.0.1:5007"
`.trim()); // cwd will point here
      const savedCwd = process.cwd();
      process.chdir(tmpB);
      try {
        const result = resolveConfiguredEmbedEndpointDetailed({ projectRoot: tmpA, env: {} });
        assertEqual(result.url, null, 'cwd (tmpB)\'s pipeline.yml must never be consulted when projectRoot=tmpA is given');
      } finally {
        process.chdir(savedCwd);
      }
    });
  });

  await test('R7: process.env.PROJECT_ROOT is never consulted, even when set to a DIFFERENT configured root', async () => {
    await withIsolatedEmbedEnv(async () => {
      const tmpA = makeTmpProjectRoot(null); // the EXPLICIT projectRoot — no yml
      const tmpB = makeTmpProjectRoot(`
knowledge:
  vllm_embed_url: "http://127.0.0.1:5008"
`.trim());
      process.env.PROJECT_ROOT = tmpB;
      const result = resolveConfiguredEmbedEndpointDetailed({ projectRoot: tmpA, env: {} });
      assertEqual(result.url, null, 'PROJECT_ROOT env must never override or supplement the explicit projectRoot argument');
    });
  });

  await test('R8a: a relative projectRoot is a hard input error (throws)', () => {
    let threw = null;
    try { resolveConfiguredEmbedEndpointDetailed({ projectRoot: 'relative/path', env: {} }); } catch (err) { threw = err; }
    assert(threw instanceof Error, 'expected a thrown Error for a relative projectRoot');
  });

  await test('R8b: a non-string projectRoot is a hard input error (throws)', () => {
    let threw = null;
    try { resolveConfiguredEmbedEndpointDetailed({ projectRoot: 42, env: {} }); } catch (err) { threw = err; }
    assert(threw instanceof Error, 'expected a thrown Error for a non-string projectRoot');
  });

  await test('R9: a vllm_embed_url declared at bare top level (no knowledge: section) is never picked up', async () => {
    await withIsolatedEmbedEnv(async () => {
      const root = makeTmpProjectRoot(`
vllm_embed_url: "http://127.0.0.1:5009"

knowledge:
  tier: "postgres"
`.trim());
      const result = resolveConfiguredEmbedEndpointDetailed({ projectRoot: root, env: {} });
      assertEqual(result.url, null, 'a bare top-level vllm_embed_url (outside knowledge:) must not be read');
    });
  });

  await test('R10: a whitespace-only env value is rejected — falls through to the next tier', async () => {
    await withIsolatedEmbedEnv(async () => {
      const root = makeTmpProjectRoot(null);
      const result = resolveConfiguredEmbedEndpointDetailed({ projectRoot: root, env: { VLLM_EMBED_URL: '   ' } });
      assertEqual(result.url, null, 'whitespace-only VLLM_EMBED_URL must be treated as absent, not as a blank-but-truthy URL');
      assertEqual(result.source, null);
    });
  });

  await test('R11: a non-string opts.vllmUrl is ignored — falls through to the next tier', async () => {
    await withIsolatedEmbedEnv(async () => {
      const root = makeTmpProjectRoot(`
knowledge:
  vllm_embed_url: "http://127.0.0.1:5010"
`.trim());
      const result = resolveConfiguredEmbedEndpointDetailed({ vllmUrl: 12345, projectRoot: root, env: {} });
      assertEqual(result.url, 'http://127.0.0.1:5010', 'a non-string opts.vllmUrl must never be coerced/used — pipeline.yml should win');
      assertEqual(result.source, 'pipeline_yml');
    });
  });

  // ─── R12-R15: the resolver's own model tier (finding 1) ──────────────────

  console.log('\n=== R12-R15: resolveConfiguredEmbedEndpointDetailed model tier + validation ===');

  await test('R12: embedding_model resolved from projectRoot\'s pipeline.yml, source "pipeline_yml"', async () => {
    await withIsolatedEmbedEnv(async () => {
      const root = makeTmpProjectRoot(`
knowledge:
  embedding_model: "${VLLM_MODEL}"
`.trim());
      const result = resolveConfiguredEmbedEndpointDetailed({ projectRoot: root, env: {} });
      assertEqual(result.model, VLLM_MODEL);
      assertEqual(result.modelSource, 'pipeline_yml');
    });
  });

  await test('R13: an unsupported embedding_model in pipeline.yml throws validateEmbeddingModel\'s exact error', async () => {
    await withIsolatedEmbedEnv(async () => {
      const root = makeTmpProjectRoot(`
knowledge:
  embedding_model: "mxbai-embed-large"
`.trim());
      let threw = null;
      try { resolveConfiguredEmbedEndpointDetailed({ projectRoot: root, env: {} }); } catch (err) { threw = err; }
      assert(threw instanceof Error, 'expected a throw for an unsupported embedding_model');
      assert(threw.message.includes('embedding_model') && threw.message.includes('mxbai-embed-large') && threw.message.includes(VLLM_MODEL));
    });
  });

  await test('R14: opts.model explicit override wins over pipeline.yml and is NEVER validated', async () => {
    await withIsolatedEmbedEnv(async () => {
      const root = makeTmpProjectRoot(`
knowledge:
  embedding_model: "${VLLM_MODEL}"
`.trim());
      // An arbitrary, unsupported-looking string as an explicit override —
      // must pass through untouched (internal/test-caller responsibility,
      // mirrors the URL resolver's own explicit-tier convention).
      const result = resolveConfiguredEmbedEndpointDetailed({ projectRoot: root, model: 'explicit-override-model', env: {} });
      assertEqual(result.model, 'explicit-override-model');
      assertEqual(result.modelSource, 'explicit');
    });
  });

  await test('R15: no opts.model and no embedding_model key -> model:null, modelSource:null, never throws', async () => {
    await withIsolatedEmbedEnv(async () => {
      const root = makeTmpProjectRoot(`
knowledge:
  vllm_embed_url: "http://127.0.0.1:1"
`.trim());
      const result = resolveConfiguredEmbedEndpointDetailed({ projectRoot: root, env: {} });
      assertEqual(result.model, null);
      assertEqual(result.modelSource, null);
    });
  });

  // ─── F4: embedQuery ALWAYS calls the resolver when projectRoot is given ──
  // (finding 4 — explicit overrides used to bypass the resolver's own
  // normalization via an `if (!vllmUrl)` shortcut in embed.js's embedQuery).

  console.log('\n=== F4: embedQuery normalizes explicit overrides through the resolver ===');

  await test('F4a: vllmUrl "   " (whitespace-only) with projectRoot falls through to pipeline.yml, never used as a literal URL', async () => {
    await withIsolatedEmbedEnv(async () => {
      const server = await startFakeVllmServer([0.7, 0.8]);
      try {
        const port = server.address().port;
        const root = makeTmpProjectRoot(`
knowledge:
  vllm_embed_url: "http://127.0.0.1:${port}"
  embedding_model: "${VLLM_MODEL}"
`.trim());
        const vec = await embedQuery('q', { projectRoot: root, vllmUrl: '   ' });
        assert(Array.isArray(vec) && vec.length === 2, 'whitespace-only vllmUrl must fall through to pipeline.yml, not be used as a literal URL (which would fail to connect)');
      } finally {
        server.close();
      }
    });
  });

  await test('F4b: vllmUrl 12345 (non-string) with projectRoot is ignored, falls through to pipeline.yml', async () => {
    await withIsolatedEmbedEnv(async () => {
      const server = await startFakeVllmServer([0.7, 0.8]);
      try {
        const port = server.address().port;
        const root = makeTmpProjectRoot(`
knowledge:
  vllm_embed_url: "http://127.0.0.1:${port}"
  embedding_model: "${VLLM_MODEL}"
`.trim());
        const vec = await embedQuery('q', { projectRoot: root, vllmUrl: 12345 });
        assert(Array.isArray(vec) && vec.length === 2, 'a non-string vllmUrl must be ignored, not passed through to the HTTP call');
      } finally {
        server.close();
      }
    });
  });

  await test('F4c: an explicit valid vllmUrl + a RELATIVE projectRoot still throws the resolver\'s absolute-path error', async () => {
    await withIsolatedEmbedEnv(async () => {
      let threw = null;
      try {
        await embedQuery('q', { projectRoot: 'relative/path', vllmUrl: 'http://127.0.0.1:1' });
      } catch (err) { threw = err; }
      assert(threw instanceof Error, 'expected a throw for a relative projectRoot even with an explicit vllmUrl');
      assert(/absolute/i.test(threw.message), `expected an absolute-path error, got: ${threw.message}`);
    });
  });

  // ─── M1: embedQuery's embedding_model fallback is projectRoot-scoped ─────

  console.log('\n=== M1: embedQuery embedding_model resolved from projectRoot, never cwd ===');

  await test('M1: embedding_model resolved from projectRoot\'s own pipeline.yml (a SUPPORTED model), not from cwd\'s (an UNSUPPORTED one)', async () => {
    await withIsolatedEmbedEnv(async () => {
      const server = await startFakeVllmServer([0.11, 0.22, 0.33]);
      try {
        const port = server.address().port;
        // finding 1 fix: embedding_model is now validated (validateEmbeddingModel),
        // so it can no longer be an arbitrary distinguishing string per-project the
        // way "model-from-project-A"/"-B" were. The split-brain proof instead uses
        // an UNSUPPORTED model in cwd's config (tmpB) — if the implementation ever
        // regressed to reading the model from cwd instead of projectRoot=tmpA, this
        // call would throw a validation error instead of succeeding, so a clean
        // success with the correct model in the request body still proves the
        // guard holds.
        const tmpA = makeTmpProjectRoot(`
knowledge:
  vllm_embed_url: "http://127.0.0.1:${port}"
  embedding_model: "${VLLM_MODEL}"
`.trim());
        const tmpB = makeTmpProjectRoot(`
knowledge:
  vllm_embed_url: "http://127.0.0.1:9"
  embedding_model: "model-from-project-B-must-not-be-used"
`.trim());
        const savedCwd = process.cwd();
        process.chdir(tmpB);
        try {
          const vec = await embedQuery('some query text', { projectRoot: tmpA });
          assert(Array.isArray(vec) && vec.length === 3, 'expected the fake server\'s 3-dim vector back');
          assert(server.lastRequestBody, 'expected a captured request body');
          assertEqual(server.lastRequestBody.model, VLLM_MODEL, 'model must resolve from projectRoot=tmpA, never cwd=tmpB');
        } finally {
          process.chdir(savedCwd);
        }
      } finally {
        server.close();
      }
    });
  });

  await test('M1b: an UNSUPPORTED embedding_model in projectRoot\'s own pipeline.yml fails validation with the CLI\'s exact error shape (finding 1)', async () => {
    await withIsolatedEmbedEnv(async () => {
      const tmpA = makeTmpProjectRoot(`
knowledge:
  vllm_embed_url: "http://127.0.0.1:1"
  embedding_model: "mxbai-embed-large"
`.trim());
      let threw = null;
      try {
        await embedQuery('some query text', { projectRoot: tmpA });
      } catch (err) { threw = err; }
      assert(threw instanceof Error, 'expected a throw for an unsupported embedding_model');
      assert(threw.message.includes('embedding_model'), `error must name the key 'embedding_model'; got: ${threw.message}`);
      assert(threw.message.includes('mxbai-embed-large'), `error must name the offending value; got: ${threw.message}`);
      assert(threw.message.includes(VLLM_MODEL), `error must name the single supported model; got: ${threw.message}`);
    });
  });

  // ─── S1-S5: memorySearch FTS-only degrade / hybrid pass-through ──────────

  console.log('\n=== S1-S5: memorySearch embed-URL-driven FTS-only degrade ===');

  await test('S0 (assumption guard): tasks has no fts_vec column, decisions does — S1/S2 below depend on this', () => {
    assertEqual(TABLE_DESCRIPTORS.tasks.hasFts, false);
    assertEqual(TABLE_DESCRIPTORS.decisions.hasFts, true);
  });

  await test('S1: unresolvable URL -> memorySearch degrades to FTS-only, hits come back, no throw (schema-probe-answering client — finding 3)', async () => {
    await withIsolatedEmbedEnv(async () => {
      const root = makeTmpProjectRoot(null); // unconfigured
      let capturedSql = null, capturedValues = null;
      // A REAL schema-aware client (not makeBareClient — Codex review finding
      // 3: a bare client bypasses probeTableAvailability's real column-
      // requirement gate entirely, which is exactly the path finding 3's bug
      // lived in). `decisions` has NO missingColumns/missingTables entries
      // here, so it is reported fully present — including no `embedding`
      // column requirement in fts_only mode (see S1b below for the case
      // where embedding is ACTUALLY absent).
      const client = makeSchemaAwareClient({
        queryImpl: (sql, values) => {
          capturedSql = sql; capturedValues = values;
          return { rows: [{ source_table: 'decisions', id: '1', label: 'topic', snippet: 'snip', score: 0.42 }] };
        },
      });
      const result = await memorySearch(client, { projectId: 'p1', query: 'hello world', tables: ['decisions'], projectRoot: root });
      assertEqual(result.embedStatus, 'unconfigured');
      assertEqual(result.embedSource, null);
      assertEqual(result.embedReason, 'unconfigured');
      assertEqual(result.searchMode, 'fts_only');
      assertEqual(result.hits.length, 1);
      assertEqual(result.hits[0].sourceTable, 'decisions');
      assert(typeof result.note === 'string' && result.note.length > 0, 'expected a top-level note in fts_only mode');
      assert(!/<=>/.test(capturedSql), 'fts_only SQL must never reference the vector operator');
      assert(!/embedding IS NOT NULL/i.test(capturedSql), 'fts_only SQL must never filter on embedding IS NOT NULL');
      assertEqual(capturedValues.length, 3, 'fts_only paramKeys are [query, projectId, limit] — 3 values, no vector');
    });
  });

  await test('S1b: fts_only + a table with fts_vec but NO embedding column -> still hits, never allSkipped (finding 3 regression guard)', async () => {
    await withIsolatedEmbedEnv(async () => {
      const root = makeTmpProjectRoot(null); // unconfigured -> fts_only
      // `decisions` is missing its `embedding` column entirely (the exact
      // cm#224/#225-style degraded-schema shape finding 3 named) — the
      // OLD probe required EMBEDDING_COLUMN unconditionally and reported
      // this as column_missing even in fts_only mode, which never touches
      // that column at all. The fixed probe must report `decisions` as
      // fully available in fts_only mode despite the missing embedding col.
      const client = makeSchemaAwareClient({
        missingColumns: [{ table: 'decisions', column: EMBEDDING_COLUMN }],
        queryImpl: (sql) => {
          assert(!/embedding/i.test(sql), 'fts_only SQL must never reference the embedding column at all');
          return { rows: [{ source_table: 'decisions', id: '1', label: 'topic', snippet: 'snip', score: 0.9 }] };
        },
      });
      const result = await memorySearch(client, { projectId: 'p1', query: 'x', tables: ['decisions'], projectRoot: root });
      assertEqual(result.searchMode, 'fts_only');
      assertEqual(result.allSkipped, false, 'a table with fts_vec but no embedding column must NOT be allSkipped in fts_only mode');
      assertEqual(result.hits.length, 1);
      assertEqual(result.tablesSearched.length, 1);
      assertEqual(result.tablesSearched[0], 'decisions');
      assertEqual(result.skippedTables.length, 0, 'decisions must not be skipped — it has everything fts_only needs');
    });
  });

  await test('S2a: buildTableQuery fts_only SQL has no vector placeholder/embedding filter and a deterministic tiebreak', () => {
    const { sql, paramKeys } = buildTableQuery('decisions', { mode: 'fts_only' });
    assert(!/halfvec/i.test(sql), 'fts_only SQL must never reference halfvec');
    assert(!/embedding/i.test(sql), 'fts_only SQL must never reference the embedding column at all');
    assert(/ORDER BY score DESC, id DESC/.test(sql), 'expected a deterministic score DESC, id DESC tiebreak');
    assertEqual(paramKeys.join(','), 'query,projectId,limit');
  });

  await test('S2b: memorySearch fts_only mode skips hasFts:false tables as no_fts_column and lists them in note', async () => {
    await withIsolatedEmbedEnv(async () => {
      const root = makeTmpProjectRoot(null); // unconfigured
      const client = makeSchemaAwareClient({
        queryImpl: (sql) => {
          assert(!/embedding/i.test(sql), 'only fts-capable tables should ever be queried in fts_only mode');
          return { rows: [] };
        },
      });
      const result = await memorySearch(client, { projectId: 'p1', query: 'x', tables: ['tasks', 'decisions'], projectRoot: root });
      assertEqual(result.searchMode, 'fts_only');
      assertEqual(result.tablesSearched.length, 1);
      assertEqual(result.tablesSearched[0], 'decisions');
      const tasksSkip = result.skippedTables.find((s) => s.table === 'tasks');
      assert(tasksSkip, 'expected tasks in skippedTables');
      assertEqual(tasksSkip.reason, 'no_fts_column');
      assert(result.note.includes('tasks'), `expected note to list tasks, got: ${result.note}`);
    });
  });

  await test('S3: a resolvable URL + a SUPPORTED model -> embedStatus "ok", searchMode "hybrid", identical SQL to today\'s hybrid path', async () => {
    await withIsolatedEmbedEnv(async () => {
      const server = await startFakeVllmServer([0.5, 0.6]);
      try {
        const port = server.address().port;
        // finding 1 fix: embedding_model must be the ONE model vLLM supports
        // (VLLM_MODEL) — an arbitrary string like the old "s3-test-model"
        // now correctly fails validateEmbeddingModel (see S3b below), so it
        // can no longer stand in as "any non-empty model string" here.
        const root = makeTmpProjectRoot(`
knowledge:
  vllm_embed_url: "http://127.0.0.1:${port}"
  embedding_model: "${VLLM_MODEL}"
`.trim());
        let capturedSql = null;
        const client = makeBareClient((sql) => { capturedSql = sql; return { rows: [] }; });
        const result = await memorySearch(client, { projectId: 'p1', query: 'x', tables: ['decisions'], projectRoot: root });
        assertEqual(result.embedStatus, 'ok');
        assertEqual(result.embedSource, 'pipeline_yml');
        assertEqual(result.searchMode, 'hybrid');
        assertEqual(result.note, undefined, 'no note key in hybrid mode');
        // Codex review of PR #302 (r2, S3 "NOT FIXED completely"): comparing
        // against buildTableQuery()'s OWN live output proves nothing — a
        // regression inside buildTableQuery itself would change BOTH sides
        // of the comparison together and this test would still pass. This
        // literal is the 'decisions' hybrid SQL shape buildTableQuery()
        // produces from TABLE_DESCRIPTORS.decisions (idExpr 'id', labelExpr
        // 'topic', snippetExpr substring(coalesce(decision,''),1,300),
        // hasFts:true, whereExtra:null) — pinned so a future change to
        // buildTableQuery's hybrid-mode SQL text shows up here as a real
        // test failure instead of silently passing against itself.
        const expectedSql = `
    SELECT 'decisions'::text AS source_table,
           (id)::text AS id,
           (topic)::text AS label,
           substring(coalesce(decision,''), 1, 300) AS snippet,
           (COALESCE(ts_rank(fts_vec, plainto_tsquery('english', $2)), 0) * 0.3 + (1 - (embedding <=> $1::halfvec)) * 0.7) AS score
      FROM "decisions"
     WHERE project_id = $3 AND embedding IS NOT NULL
     ORDER BY score DESC
     LIMIT $4`;
        assertEqual(capturedSql.replace(/\s+/g, ' ').trim(), expectedSql.replace(/\s+/g, ' ').trim(), 'hybrid SQL must be byte-identical (modulo whitespace) to the pre-fix shape');
      } finally {
        server.close();
      }
    });
  });

  await test('S3b: a resolvable URL + an UNSUPPORTED configured model -> throws the CLI\'s validateEmbeddingModel error, never reaches HTTP (finding 1)', async () => {
    await withIsolatedEmbedEnv(async () => {
      const server = await startFakeVllmServer([0.5, 0.6]);
      try {
        const port = server.address().port;
        const root = makeTmpProjectRoot(`
knowledge:
  vllm_embed_url: "http://127.0.0.1:${port}"
  embedding_model: "s3-test-model"
`.trim());
        const client = makeBareClient(() => ({ rows: [] }));
        let threw = null;
        try {
          await memorySearch(client, { projectId: 'p1', query: 'x', tables: ['decisions'], projectRoot: root });
        } catch (err) { threw = err; }
        assert(threw instanceof Error, 'expected a throw for an unsupported configured embedding_model');
        assert(threw.message.includes('embedding_model'), `error must name the key 'embedding_model'; got: ${threw.message}`);
        assert(threw.message.includes('s3-test-model'), `error must name the offending value; got: ${threw.message}`);
        assert(threw.message.includes(VLLM_MODEL), `error must name the single supported model; got: ${threw.message}`);
        assert(server.lastRequestBody === undefined, 'an unsupported model must never reach the vLLM HTTP endpoint at all');
      } finally {
        server.close();
      }
    });
  });

  await test('S4: an injected args.embedder bypasses resolution entirely — stays hybrid/ok against an otherwise-unconfigured projectRoot', async () => {
    await withIsolatedEmbedEnv(async () => {
      const root = makeTmpProjectRoot(null); // would be 'unconfigured'/'fts_only' if resolution ran
      const client = makeBareClient(() => ({ rows: [{ source_table: 'decisions', id: '1', label: 'l', snippet: 's', score: 0.9 }] }));
      const result = await memorySearch(client, {
        projectId: 'p1', query: 'x', tables: ['decisions'], projectRoot: root, embedder: async () => [0.1, 0.2],
      });
      assertEqual(result.embedStatus, 'ok', 'injected embedder must bypass resolution — never unconfigured');
      assertEqual(result.searchMode, 'hybrid', 'injected embedder must bypass resolution — never fts_only');
      assertEqual(result.hits.length, 1);
    });
  });

  await test('S5: an embedder that throws still propagates — never swallowed into a degrade', async () => {
    await withIsolatedEmbedEnv(async () => {
      const client = makeBareClient(() => ({ rows: [] }));
      let threw = null;
      try {
        await memorySearch(client, {
          projectId: 'p1', query: 'x', tables: ['decisions'], embedder: async () => { throw new Error('boom-embedder'); },
        });
      } catch (err) { threw = err; }
      assert(threw, 'expected the embedder\'s throw to propagate');
      assertEqual(threw.message, 'boom-embedder');
    });
  });

  // ─── C1: CLI path unchanged ───────────────────────────────────────────────

  console.log('\n=== C1: embedQuery CLI path (no opts.projectRoot) is byte-for-byte unchanged ===');

  await test('C1: no opts.projectRoot -> resolves via loadConfig()/PROJECT_ROOT env, throws the exact pre-existing message when unconfigured', async () => {
    const tmp = makeTmpProjectRoot(null); // no pipeline.yml at all
    const savedProjectRootEnv = process.env.PROJECT_ROOT;
    const savedVllmUrl = process.env.VLLM_EMBED_URL;
    delete process.env.VLLM_EMBED_URL;
    process.env.PROJECT_ROOT = tmp;
    try {
      let threw = null;
      try {
        await embedQuery('hello');
      } catch (err) { threw = err; }
      assert(threw instanceof Error, 'expected a throw');
      assertEqual(threw.message, '[embed] vLLM URL not configured — set vllm_embed_url in pipeline.yml knowledge section');
    } finally {
      if (savedProjectRootEnv === undefined) delete process.env.PROJECT_ROOT; else process.env.PROJECT_ROOT = savedProjectRootEnv;
      if (savedVllmUrl === undefined) delete process.env.VLLM_EMBED_URL; else process.env.VLLM_EMBED_URL = savedVllmUrl;
    }
  });

  await test('C1b: resolveEmbedUrl({}) with nothing configured returns {url:null, reason:"unconfigured"} rather than throwing', async () => {
    await withIsolatedEmbedEnv(async () => {
      const root = makeTmpProjectRoot(null);
      const result = resolveEmbedUrl({ projectRoot: root });
      assertEqual(result.url, null);
      assertEqual(result.reason, 'unconfigured');
    });
  });

  console.log(`\n─── Results ──────────────────────────────────────`);
  console.log(`PASS ${passed}  FAIL ${failed}`);
  process.exit(failed > 0 ? 1 : 0);
})();
