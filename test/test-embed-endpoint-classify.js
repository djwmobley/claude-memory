'use strict';

/**
 * test-embed-endpoint-classify.js — init-seed-local-provider AUTHOR task.
 *
 * Pure-unit, no DB, no network. Covers scripts/lib/embedding-provider.js's
 * three new exports:
 *
 *   classifyEmbedEndpoint(url)               — total classification into
 *                                               exactly one of LOCAL / REMOTE / INVALID.
 *   resolveConfiguredEmbedEndpoint(opts)     — single-precedence endpoint
 *                                               resolution (pipeline.yml, then env,
 *                                               then NONE — never the hardcoded
 *                                               localhost:8800 runtime fallback).
 *   seedLocalEmbeddingProvider(opts)         — the cmdInit seeding step itself,
 *                                               exercised here against a FAKE db
 *                                               (no live Postgres/SQLite needed).
 *
 * This is the adversary-pass unit suite named directly by the AUTHOR task
 * spec (item 6) — every case in the spec's list is represented below by id.
 *
 * Usage: node test/test-embed-endpoint-classify.js
 * Exit 0 = all pass; nonzero = any failure.
 */

const fs   = require('fs');
const os   = require('os');
const path = require('path');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const {
  classifyEmbedEndpoint,
  resolveConfiguredEmbedEndpoint,
  resolveConfiguredEmbedEndpointDetailed,
  _readUserScopeEmbedUrl,
  seedLocalEmbeddingProvider,
  LOCAL_PROVIDER_NAME,
  LOCAL_PROVIDER_MODEL_LABEL,
  LOCAL_PROVIDER_NATIVE_DIMS,
  LOCAL_PROVIDER_STORED_DIMS,
} = require(path.join(PROJECT_ROOT, 'scripts', 'lib', 'embedding-provider.js'));

let passed = 0, failed = 0;
async function test(label, fn) {
  try {
    await fn();
    console.log(`  [PASS] ${label}`);
    passed++;
  } catch (err) {
    console.error(`  [FAIL] ${label}: ${err.message}`);
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'embed-endpoint-test-'));
  fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
  if (pipelineYmlBody !== null) {
    fs.writeFileSync(path.join(dir, '.claude', 'pipeline.yml'), pipelineYmlBody, 'utf8');
  }
  return dir;
}

/**
 * Minimal fake StoragePort. Tracks INSERT calls; simulates ON CONFLICT DO
 * NOTHING by rejecting a second insert of the same `name`, OR any insert at
 * all when `blockedByExistingDefault` is set (simulating a different row
 * already holding is_default=true, which the untargeted "ON CONFLICT DO
 * NOTHING" in the real SQL also absorbs as rowCount 0 — see
 * embedding_providers_is_default_unique_idx).
 */
function fakeDb({ blockedByExistingDefault = false, dialect = 'postgres', existingDefaultName = null } = {}) {
  const inserted = new Set();
  const calls = [];
  return {
    dialect,
    calls,
    async query(sql, params) {
      calls.push({ sql, params });
      if (/^\s*INSERT INTO embedding_providers/i.test(sql)) {
        const name = params[0];
        if (blockedByExistingDefault || inserted.has(name)) {
          return { rows: [], rowCount: 0 };
        }
        inserted.add(name);
        return { rows: [], rowCount: 1 };
      }
      // Adversary finding #7's diagnostic SELECT (_alreadyPresentLines).
      if (/^\s*SELECT name FROM embedding_providers WHERE is_default/i.test(sql)) {
        if (existingDefaultName) return { rows: [{ name: existingDefaultName }], rowCount: 1 };
        if (inserted.has(LOCAL_PROVIDER_NAME)) return { rows: [{ name: LOCAL_PROVIDER_NAME }], rowCount: 1 };
        return { rows: [], rowCount: 0 };
      }
      throw new Error(`fakeDb: unexpected SQL: ${sql}`);
    },
  };
}

(async () => {
  // ─── Section 1: classifyEmbedEndpoint — adversary case list (spec item 6) ─

  console.log('\n=== Section 1: classifyEmbedEndpoint total classification ===');

  const CLASSIFY_CASES = [
    ['http://LOCALHOST:8800',        'LOCAL',   'uppercase host normalizes to localhost'],
    ['http://localhost.:8800',       'LOCAL',   'single trailing dot stripped'],
    ['http://127.0.0.2',             'LOCAL',   '127.0.0.0/8 prefix, not just 127.0.0.1'],
    ['http://0.0.0.0:8800',          'REMOTE',  '0.0.0.0 is a bind-all address, not "local" for this purpose'],
    ['http://[::1]:8800',            'LOCAL',   'IPv6 loopback, brackets stripped'],
    ['http://user@localhost',        'REMOTE',  'userinfo present forces REMOTE even against localhost'],
    ['http://localhost:8800/v1',     'LOCAL',   'path suffix does not affect classification'],
    ['localhost:8800',               'INVALID', 'scheme-less — WHATWG parses "localhost:" as the protocol, empty hostname'],
    ['http://host.docker.internal',  'REMOTE',  'docker-internal host is not literally localhost'],
    ['https://myhost.localhost',     'REMOTE',  '*.localhost subdomain is NOT equal to "localhost"'],
    ['',                             'INVALID', 'empty string'],
    ['ftp://localhost',              'INVALID', 'non-http(s) scheme'],
  ];

  for (const [url, expected, why] of CLASSIFY_CASES) {
    await test(`classifyEmbedEndpoint(${JSON.stringify(url)}) === ${expected} (${why})`, () => {
      assertEqual(classifyEmbedEndpoint(url), expected);
    });
  }

  // A few extra edges beyond the spec's named list, since this is a total
  // classification and every input must map to exactly one branch.
  await test('classifyEmbedEndpoint(undefined) === INVALID (non-string)', () => {
    assertEqual(classifyEmbedEndpoint(undefined), 'INVALID');
  });
  await test('classifyEmbedEndpoint(null) === INVALID (non-string)', () => {
    assertEqual(classifyEmbedEndpoint(null), 'INVALID');
  });
  await test('classifyEmbedEndpoint(123) === INVALID (non-string)', () => {
    assertEqual(classifyEmbedEndpoint(123), 'INVALID');
  });
  await test('classifyEmbedEndpoint("   ") === INVALID (whitespace-only)', () => {
    assertEqual(classifyEmbedEndpoint('   '), 'INVALID');
  });
  await test('classifyEmbedEndpoint("not a url at all") === INVALID (unparseable)', () => {
    assertEqual(classifyEmbedEndpoint('not a url at all'), 'INVALID');
  });
  await test('classifyEmbedEndpoint("http://") === INVALID (empty hostname, explicit scheme)', () => {
    assertEqual(classifyEmbedEndpoint('http://'), 'INVALID');
  });
  await test('classifyEmbedEndpoint("https://LOCALHOST.") === LOCAL (uppercase + trailing dot combined)', () => {
    assertEqual(classifyEmbedEndpoint('https://LOCALHOST.'), 'LOCAL');
  });
  await test('classifyEmbedEndpoint("http://192.168.1.5:8800") === REMOTE (LAN IP)', () => {
    assertEqual(classifyEmbedEndpoint('http://192.168.1.5:8800'), 'REMOTE');
  });
  await test('classifyEmbedEndpoint("http://user:pass@127.0.0.1") === REMOTE (userinfo beats loopback IP too)', () => {
    assertEqual(classifyEmbedEndpoint('http://user:pass@127.0.0.1'), 'REMOTE');
  });
  await test('classifyEmbedEndpoint total classification never returns a fourth value', () => {
    const result = classifyEmbedEndpoint('http://[::1].');
    assert(['LOCAL', 'REMOTE', 'INVALID'].includes(result), 'must land in exactly one classification branch');
  });

  // ─── Section 2: resolveConfiguredEmbedEndpoint precedence ────────────────

  console.log('\n=== Section 2: resolveConfiguredEmbedEndpoint precedence ===');

  await test('resolveConfiguredEmbedEndpoint: (a) pipeline.yml wins over (b) env', () => {
    const root = makeTmpProjectRoot(`
project:
  name: test

knowledge:
  tier: "postgres"
  vllm_embed_url: "http://localhost:9001"
`.trim());
    const result = resolveConfiguredEmbedEndpoint({ projectRoot: root, env: { VLLM_EMBED_URL: 'http://localhost:9002' } });
    assertEqual(result, 'http://localhost:9001');
  });

  await test('resolveConfiguredEmbedEndpoint: (b) env used when pipeline.yml has no vllm_embed_url', () => {
    const root = makeTmpProjectRoot(`
project:
  name: test

knowledge:
  tier: "postgres"
`.trim());
    const result = resolveConfiguredEmbedEndpoint({ projectRoot: root, env: { VLLM_EMBED_URL: 'http://localhost:9002' } });
    assertEqual(result, 'http://localhost:9002');
  });

  // Both tests below fall through to precedence step (c) — the user-scope
  // ${resolveBaseDir()}/handoff-embed.json file — which reads the REAL
  // process.env.HANDOFF_BASE_DIR (default ~/.claude) unless isolated here.
  // Isolating this is required for hermetic CI correctness: if an operator's
  // real machine ever has a genuine ~/.claude/handoff-embed.json (the whole
  // point of this feature), these "must resolve to NONE" tests must not
  // accidentally read it.
  function withIsolatedBaseDir(fn) {
    const saved = process.env.HANDOFF_BASE_DIR;
    const isolatedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'embed-endpoint-basedir-'));
    process.env.HANDOFF_BASE_DIR = isolatedDir;
    try {
      return fn();
    } finally {
      if (saved === undefined) delete process.env.HANDOFF_BASE_DIR; else process.env.HANDOFF_BASE_DIR = saved;
      fs.rmSync(isolatedDir, { recursive: true, force: true });
    }
  }

  await test('resolveConfiguredEmbedEndpoint: (c) NONE (null) when neither is set (isolated from any real user-scope file)', () => {
    withIsolatedBaseDir(() => {
      const root = makeTmpProjectRoot(`
project:
  name: test
`.trim());
      const result = resolveConfiguredEmbedEndpoint({ projectRoot: root, env: {} });
      assertEqual(result, null);
    });
  });

  await test('resolveConfiguredEmbedEndpoint: NEVER falls back to the hardcoded localhost:8800 runtime default (isolated from any real user-scope file)', () => {
    withIsolatedBaseDir(() => {
      // No projectRoot at all, no pipeline.yml, empty env — must be null, not
      // the shared.js/embed.js runtime convenience default.
      const result = resolveConfiguredEmbedEndpoint({ env: {} });
      assertEqual(result, null);
    });
  });

  await test('resolveConfiguredEmbedEndpoint: absent pipeline.yml file falls through to env', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'embed-endpoint-test-'));
    // No .claude directory at all.
    const result = resolveConfiguredEmbedEndpoint({ projectRoot: dir, env: { VLLM_EMBED_URL: 'http://localhost:8800' } });
    assertEqual(result, 'http://localhost:8800');
  });

  // ─── Section 2b: user-scope handoff-embed.json precedence (init-embeddability) ─

  console.log('\n=== Section 2b: user-scope handoff-embed.json precedence + corruption handling ===');

  await test('resolveConfiguredEmbedEndpointDetailed: (c) user-scope wins when neither pipeline.yml nor env is set', () => {
    withIsolatedBaseDir(() => {
      fs.writeFileSync(path.join(process.env.HANDOFF_BASE_DIR, 'handoff-embed.json'), JSON.stringify({ vllm_embed_url: 'http://127.0.0.1:8800' }), 'utf8');
      const result = resolveConfiguredEmbedEndpointDetailed({ env: {} });
      assertEqual(result.url, 'http://127.0.0.1:8800');
      assertEqual(result.source, 'user_scope');
    });
  });

  await test('resolveConfiguredEmbedEndpointDetailed: pipeline.yml (a) still wins over user-scope (c)', () => {
    withIsolatedBaseDir(() => {
      fs.writeFileSync(path.join(process.env.HANDOFF_BASE_DIR, 'handoff-embed.json'), JSON.stringify({ vllm_embed_url: 'http://127.0.0.1:9999' }), 'utf8');
      const root = makeTmpProjectRoot(`
knowledge:
  vllm_embed_url: "http://localhost:9001"
`.trim());
      const result = resolveConfiguredEmbedEndpointDetailed({ projectRoot: root, env: {} });
      assertEqual(result.url, 'http://localhost:9001');
      assertEqual(result.source, 'pipeline_yml');
    });
  });

  await test('resolveConfiguredEmbedEndpointDetailed: env (b) still wins over user-scope (c)', () => {
    withIsolatedBaseDir(() => {
      fs.writeFileSync(path.join(process.env.HANDOFF_BASE_DIR, 'handoff-embed.json'), JSON.stringify({ vllm_embed_url: 'http://127.0.0.1:9999' }), 'utf8');
      const result = resolveConfiguredEmbedEndpointDetailed({ env: { VLLM_EMBED_URL: 'http://localhost:9002' } });
      assertEqual(result.url, 'http://localhost:9002');
      assertEqual(result.source, 'env');
    });
  });

  await test('resolveConfiguredEmbedEndpointDetailed: a user-scope REMOTE value is returned as-is — classification/BLOCK gating happens downstream, never a separate unguarded path (adversary finding #4)', () => {
    withIsolatedBaseDir(() => {
      fs.writeFileSync(path.join(process.env.HANDOFF_BASE_DIR, 'handoff-embed.json'), JSON.stringify({ vllm_embed_url: 'http://0.0.0.0:8800' }), 'utf8');
      const result = resolveConfiguredEmbedEndpointDetailed({ env: {} });
      assertEqual(result.url, 'http://0.0.0.0:8800');
      assertEqual(classifyEmbedEndpoint(result.url), 'REMOTE', 'the SAME classifyEmbedEndpoint downstream callers use — no bespoke user-scope classification');
    });
  });

  await test('_readUserScopeEmbedUrl: absent file -> url:null, corrupt:false', () => {
    withIsolatedBaseDir(() => {
      const result = _readUserScopeEmbedUrl();
      assertEqual(result.url, null);
      assertEqual(result.corrupt, false);
    });
  });

  await test('_readUserScopeEmbedUrl: corrupt JSON (adversary finding #6) -> url:null, corrupt:true, never throws', () => {
    withIsolatedBaseDir(() => {
      fs.writeFileSync(path.join(process.env.HANDOFF_BASE_DIR, 'handoff-embed.json'), '{ not: valid json,,', 'utf8');
      const result = _readUserScopeEmbedUrl();
      assertEqual(result.url, null);
      assertEqual(result.corrupt, true);
    });
  });

  await test('_readUserScopeEmbedUrl: valid JSON but missing/non-string vllm_embed_url -> url:null, corrupt:false', () => {
    withIsolatedBaseDir(() => {
      fs.writeFileSync(path.join(process.env.HANDOFF_BASE_DIR, 'handoff-embed.json'), JSON.stringify({ other_key: 123 }), 'utf8');
      const result = _readUserScopeEmbedUrl();
      assertEqual(result.url, null);
      assertEqual(result.corrupt, false);
    });
  });

  // ─── Section 3: seedLocalEmbeddingProvider against a FAKE db ─────────────

  console.log('\n=== Section 3: seedLocalEmbeddingProvider (fake db — no live Postgres/SQLite) ===');

  await test('seedLocalEmbeddingProvider: NONE endpoint → no write, NOTE line, seeded=false', async () => {
    const db = fakeDb();
    const result = await seedLocalEmbeddingProvider({ db, dialect: 'postgres', env: {} });
    assertEqual(result.classification, 'NONE');
    assertEqual(result.seeded, false);
    assertEqual(db.calls.length, 0, 'NONE must never touch the db');
    assert(result.lines.some((l) => l.includes('[NOTE]') && l.includes('not configured/invalid')), 'expected the NONE/INVALID NOTE line');
  });

  await test('seedLocalEmbeddingProvider: INVALID endpoint → no write, same NOTE bucket as NONE', async () => {
    const db = fakeDb();
    const result = await seedLocalEmbeddingProvider({ db, dialect: 'postgres', env: { VLLM_EMBED_URL: 'localhost:8800' } });
    assertEqual(result.classification, 'INVALID');
    assertEqual(result.seeded, false);
    assertEqual(db.calls.length, 0);
  });

  await test('seedLocalEmbeddingProvider: REMOTE endpoint → no write, attestation-required NOTE line naming the host', async () => {
    const db = fakeDb();
    const result = await seedLocalEmbeddingProvider({ db, dialect: 'postgres', env: { VLLM_EMBED_URL: 'http://0.0.0.0:8800' } });
    assertEqual(result.classification, 'REMOTE');
    assertEqual(result.seeded, false);
    assertEqual(db.calls.length, 0, 'REMOTE must never touch the db (no write without owner attestation)');
    assert(result.lines.some((l) => l.includes('0.0.0.0') && l.includes('data_egress_approved')), 'expected the REMOTE attestation-required NOTE line naming the host');
  });

  await test('seedLocalEmbeddingProvider: LOCAL endpoint → exactly one INSERT, OK line, seeded=true', async () => {
    const db = fakeDb();
    const result = await seedLocalEmbeddingProvider({ db, dialect: 'postgres', env: { VLLM_EMBED_URL: 'http://localhost:8800' } });
    assertEqual(result.classification, 'LOCAL');
    assertEqual(result.seeded, true);
    assertEqual(db.calls.length, 1, 'exactly one statement — never check-then-insert');
    const { sql, params } = db.calls[0];
    assert(/^\s*INSERT INTO embedding_providers/i.test(sql), 'must be a single INSERT');
    assert(/ON CONFLICT DO NOTHING/i.test(sql), 'must use untargeted ON CONFLICT DO NOTHING (also absorbs the different-default-row case)');
    assertEqual(params[0], LOCAL_PROVIDER_NAME);
    assertEqual(params[1], LOCAL_PROVIDER_MODEL_LABEL);
    assertEqual(params[2], LOCAL_PROVIDER_NATIVE_DIMS);
    assertEqual(params[3], LOCAL_PROVIDER_STORED_DIMS);
    assertEqual(params[4], 'http://localhost:8800');
    assertEqual(params[5], true, 'is_default param must be the Postgres boolean literal true for dialect=postgres');
    assertEqual(params[6], true, 'data_egress_approved param must be true for dialect=postgres');
    assert(result.lines.some((l) => l.includes('[OK]') && l.includes(LOCAL_PROVIDER_NAME) && l.includes('http://localhost:8800')), 'expected the OK seeded line naming the provider and endpoint');
  });

  await test('seedLocalEmbeddingProvider: LOCAL on sqlite dialect passes integer 1 params, never a JS boolean', async () => {
    const db = fakeDb({ dialect: 'sqlite' });
    const result = await seedLocalEmbeddingProvider({ db, dialect: 'sqlite', env: { VLLM_EMBED_URL: 'http://localhost:8800' } });
    assertEqual(result.seeded, true);
    const { params } = db.calls[0];
    assertEqual(params[5], 1, 'is_default param must be integer 1 for dialect=sqlite (node:sqlite rejects JS booleans)');
    assertEqual(params[6], 1, 'data_egress_approved param must be integer 1 for dialect=sqlite');
  });

  await test('seedLocalEmbeddingProvider: a second call for an already-present row → rowCount 0, NOTE "already present", seeded=false', async () => {
    const db = fakeDb();
    await seedLocalEmbeddingProvider({ db, dialect: 'postgres', env: { VLLM_EMBED_URL: 'http://localhost:8800' } });
    const second = await seedLocalEmbeddingProvider({ db, dialect: 'postgres', env: { VLLM_EMBED_URL: 'http://localhost:8800' } });
    assertEqual(second.seeded, false);
    assert(second.lines.some((l) => l.includes('[NOTE]') && l.includes('already present')), 'expected the "already present — left untouched" NOTE line');
  });

  await test('seedLocalEmbeddingProvider: an existing DIFFERENT default row → rowCount 0 via untargeted DO NOTHING (never throws)', async () => {
    const db = fakeDb({ blockedByExistingDefault: true });
    const result = await seedLocalEmbeddingProvider({ db, dialect: 'postgres', env: { VLLM_EMBED_URL: 'http://localhost:8800' } });
    assertEqual(result.seeded, false);
    assert(result.lines.some((l) => l.includes('already present')), 'blocked-by-different-default case reports through the same "already present" NOTE bucket, per spec');
  });

  await test('seedLocalEmbeddingProvider: db.query throwing is caught — never propagates, init never fails because of this step', async () => {
    const db = { dialect: 'postgres', async query() { throw new Error('connection reset'); } };
    const result = await seedLocalEmbeddingProvider({ db, dialect: 'postgres', env: { VLLM_EMBED_URL: 'http://localhost:8800' } });
    assertEqual(result.seeded, false);
    assert(result.lines.some((l) => l.includes('non-fatal') && l.includes('connection reset')), 'unexpected db errors must be caught and reported non-fatally');
  });

  await test('seedLocalEmbeddingProvider: never check-then-insert (exactly one db.query call total)', async () => {
    const db = fakeDb();
    await seedLocalEmbeddingProvider({ db, dialect: 'postgres', env: { VLLM_EMBED_URL: 'http://localhost:8800' } });
    assertEqual(db.calls.length, 1, 'exactly one db.query call total — no preceding SELECT/check');
  });

  await test('seedLocalEmbeddingProvider: INVALID endpoint message names the offending value and the expected shape', async () => {
    const db = fakeDb();
    const result = await seedLocalEmbeddingProvider({ db, dialect: 'postgres', env: { VLLM_EMBED_URL: 'localhost:8800' } });
    assertEqual(result.classification, 'INVALID');
    assert(result.lines.some((l) => l.includes('localhost:8800')), `expected the offending value in the message, got: ${result.lines.join(' | ')}`);
    assert(result.lines.some((l) => l.includes('http(s)://host')), `expected the expected-shape hint, got: ${result.lines.join(' | ')}`);
  });

  await test('seedLocalEmbeddingProvider: adversary finding #7 — a DIFFERENT default provider is distinguished from "same name already present"', async () => {
    const db = fakeDb({ blockedByExistingDefault: true, existingDefaultName: 'some-other-provider' });
    const result = await seedLocalEmbeddingProvider({ db, dialect: 'postgres', env: { VLLM_EMBED_URL: 'http://localhost:8800' } });
    assertEqual(result.seeded, false);
    assert(result.lines.some((l) => l.includes('some-other-provider') && l.includes('NOT seeded')), `expected the distinguishing NOTE line, got: ${result.lines.join(' | ')}`);
  });

  await test('seedLocalEmbeddingProvider: adversary finding #7 — a SAME-name already-present row still reports the original "already present" message', async () => {
    const db = fakeDb();
    await seedLocalEmbeddingProvider({ db, dialect: 'postgres', env: { VLLM_EMBED_URL: 'http://localhost:8800' } });
    const second = await seedLocalEmbeddingProvider({ db, dialect: 'postgres', env: { VLLM_EMBED_URL: 'http://localhost:8800' } });
    assert(second.lines.some((l) => l.includes('already present') && l.includes(LOCAL_PROVIDER_NAME) && !l.includes('a different provider')), `expected the plain "already present" line, got: ${second.lines.join(' | ')}`);
  });

  await test('seedLocalEmbeddingProvider: adversary finding #7 diagnostic SELECT failing (minimal fake db) falls back to the generic message, never throws', async () => {
    // Same fakeDb as the pre-existing "an existing DIFFERENT default row" test
    // above (no SELECT support) — the diagnostic SELECT throws internally and
    // is caught, falling back to the pre-cm#-init-embeddability generic message.
    const db = { dialect: 'postgres', calls: [], async query(sql) { this.calls.push(sql); if (/^\s*INSERT/i.test(sql)) return { rows: [], rowCount: 0 }; throw new Error('no SELECT support'); } };
    const result = await seedLocalEmbeddingProvider({ db, dialect: 'postgres', env: { VLLM_EMBED_URL: 'http://localhost:8800' } });
    assertEqual(result.seeded, false);
    assert(result.lines.some((l) => l.includes('already present')), 'must fall back to the generic message, never throw');
  });

  await test('seedLocalEmbeddingProvider: REMOTE + allowRemoteEmbed seeds with data_egress_approved=false and prints the hand-edit remedy (A5)', async () => {
    const db = fakeDb();
    const result = await seedLocalEmbeddingProvider({ db, dialect: 'postgres', allowRemoteEmbed: true, env: { VLLM_EMBED_URL: 'http://0.0.0.0:8800' } });
    assertEqual(result.classification, 'REMOTE');
    assertEqual(result.seeded, true);
    assertEqual(result.remoteApproved, false);
    const { params } = db.calls[0];
    assertEqual(params[6], false, 'data_egress_approved must be false for the --allow-remote-embed path');
    assert(result.lines.some((l) => l.includes('UPDATE embedding_providers') && l.includes('data_egress_approved = true')), 'expected the exact hand-edit SQL remedy');
  });

  await test('seedLocalEmbeddingProvider: REMOTE WITHOUT allowRemoteEmbed still never writes (regression guard for A5 not weakening the existing BLOCK)', async () => {
    const db = fakeDb();
    const result = await seedLocalEmbeddingProvider({ db, dialect: 'postgres', env: { VLLM_EMBED_URL: 'http://0.0.0.0:8800' } });
    assertEqual(result.seeded, false);
    assertEqual(db.calls.length, 0);
  });

  console.log(`\n─── Results ──────────────────────────────────────`);
  console.log(`PASS ${passed}  FAIL ${failed}`);
  process.exit(failed > 0 ? 1 : 0);
})();
