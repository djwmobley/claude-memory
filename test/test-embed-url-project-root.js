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
const { memorySearch, buildTableQuery, TABLE_DESCRIPTORS } = require(path.join(PROJECT_ROOT, 'scripts', 'lib', 'memory-search.js'));
const { withIsolatedHandoffBaseDir } = require(path.join(PROJECT_ROOT, 'scripts', 'lib', 'test-env-isolation.js'));

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

  // ─── M1: embedQuery's embedding_model fallback is projectRoot-scoped ─────

  console.log('\n=== M1: embedQuery embedding_model resolved from projectRoot, never cwd ===');

  await test('M1: embedding_model resolved from projectRoot\'s own pipeline.yml, not from cwd\'s', async () => {
    await withIsolatedEmbedEnv(async () => {
      const server = await startFakeVllmServer([0.11, 0.22, 0.33]);
      try {
        const port = server.address().port;
        const tmpA = makeTmpProjectRoot(`
knowledge:
  vllm_embed_url: "http://127.0.0.1:${port}"
  embedding_model: "model-from-project-A"
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
          assertEqual(server.lastRequestBody.model, 'model-from-project-A', 'model must resolve from projectRoot=tmpA, never cwd=tmpB');
        } finally {
          process.chdir(savedCwd);
        }
      } finally {
        server.close();
      }
    });
  });

  // ─── S1-S5: memorySearch FTS-only degrade / hybrid pass-through ──────────

  console.log('\n=== S1-S5: memorySearch embed-URL-driven FTS-only degrade ===');

  await test('S0 (assumption guard): tasks has no fts_vec column, decisions does — S1/S2 below depend on this', () => {
    assertEqual(TABLE_DESCRIPTORS.tasks.hasFts, false);
    assertEqual(TABLE_DESCRIPTORS.decisions.hasFts, true);
  });

  await test('S1: unresolvable URL -> memorySearch degrades to FTS-only, hits come back, no throw', async () => {
    await withIsolatedEmbedEnv(async () => {
      const root = makeTmpProjectRoot(null); // unconfigured
      let capturedSql = null, capturedValues = null;
      const client = makeBareClient((sql, values) => {
        capturedSql = sql; capturedValues = values;
        return { rows: [{ source_table: 'decisions', id: '1', label: 'topic', snippet: 'snip', score: 0.42 }] };
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
      const client = makeBareClient((sql) => {
        assert(!/embedding/i.test(sql), 'only fts-capable tables should ever be queried in fts_only mode');
        return { rows: [] };
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

  await test('S3: a resolvable URL -> embedStatus "ok", searchMode "hybrid", identical SQL to today\'s hybrid path', async () => {
    await withIsolatedEmbedEnv(async () => {
      const server = await startFakeVllmServer([0.5, 0.6]);
      try {
        const port = server.address().port;
        const root = makeTmpProjectRoot(`
knowledge:
  vllm_embed_url: "http://127.0.0.1:${port}"
  embedding_model: "s3-test-model"
`.trim());
        let capturedSql = null;
        const client = makeBareClient((sql) => { capturedSql = sql; return { rows: [] }; });
        const result = await memorySearch(client, { projectId: 'p1', query: 'x', tables: ['decisions'], projectRoot: root });
        assertEqual(result.embedStatus, 'ok');
        assertEqual(result.embedSource, 'pipeline_yml');
        assertEqual(result.searchMode, 'hybrid');
        assertEqual(result.note, undefined, 'no note key in hybrid mode');
        const { sql: expectedSql } = buildTableQuery('decisions');
        assertEqual(capturedSql.replace(/\s+/g, ' ').trim(), expectedSql.replace(/\s+/g, ' ').trim(), 'hybrid SQL must be byte-identical (modulo whitespace) to the pre-fix shape');
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
