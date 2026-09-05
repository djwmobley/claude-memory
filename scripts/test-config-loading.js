'use strict';

/**
 * test-config-loading.js — Unit tests for loadConfig and findProjectRoot in
 * scripts/lib/shared.js.
 *
 * Tests the config parsing in isolation by writing fixture pipeline.yml files
 * to a temp dir and pointing loadConfig at them via process.env.PROJECT_ROOT.
 *
 * Coverage:
 *   T1  Pure LF pipeline.yml parses correctly (baseline)
 *   T2  Pure CRLF pipeline.yml parses to byte-identical values as LF —
 *       specifically NO embedded \r survives in ANY parsed value (shared.js:~84 footgun)
 *   T3  Mixed CRLF/LF pipeline.yml — same guarantee: no \r in any parsed value
 *   T4  Absent pipeline.yml falls back to PGHOST/PGUSER/PGPASSWORD documented defaults
 *   T5  findProjectRoot: returns PROJECT_ROOT env var if set
 *   T6  findProjectRoot: walks up from cwd to find .git directory
 *   T7  loadConfig: project name derived from root directory basename when no config
 *   T8  loadConfig: nested knowledge object has all required fields in no-config fallback
 *
 * IMPORTANT — CRLF footgun analysis (shared.js getInSection / getTopLevel):
 *   The regex `([^"\n]+)` followed by `.trim()` would capture a trailing \r from
 *   CRLF content as part of the match — BUT `.trim()` strips it.  This test
 *   verifies that `.trim()` is in fact being called and no \r survives.  If a
 *   future refactor removes `.trim()`, T2 and T3 will catch the regression.
 *
 * Usage:
 *   node scripts/test-config-loading.js
 *
 * No Postgres or Ollama required. Pure file-system unit test.
 * Exit 0 = all tests passed. Exit 1 = any failure.
 */

const fs   = require('fs');
const os   = require('os');
const path = require('path');

// Load shared.js exports.
const { loadConfig, findProjectRoot } = require(path.join(__dirname, 'lib', 'shared'));

// ── Tracking ───────────────────────────────────────────────────────────────────

let passed  = 0;
let failed  = 0;
const failures = [];

function pass(label)         { console.log(`PASS  ${label}`); passed++; }
function fail(label, reason) { console.log(`FAIL  ${label}: ${reason}`); failures.push({ label, reason }); failed++; }

// ── Helpers ────────────────────────────────────────────────────────────────────

/**
 * Convert a LF-only string to CRLF.
 * @param {string} s - Source string with LF line endings.
 * @returns {string} - Same string with CRLF line endings.
 */
function lfToCrlf(s) {
  return s.replace(/\n/g, '\r\n');
}

/**
 * Convert a string to mixed CRLF/LF (alternating, starting with CRLF).
 * @param {string} s - Source string with LF line endings.
 * @returns {string} - Same string with alternating CRLF/LF line endings.
 */
function lfToMixed(s) {
  let i = 0;
  return s.replace(/\n/g, () => (i++ % 2 === 0 ? '\r\n' : '\n'));
}

/**
 * Recursively collect all string leaf values from an object.
 * Used to assert no \r appears anywhere in a parsed config.
 */
function collectStringLeaves(obj, prefix) {
  const result = [];
  for (const [key, val] of Object.entries(obj)) {
    const fullKey = prefix ? `${prefix}.${key}` : key;
    if (val === null || val === undefined) continue;
    if (typeof val === 'string') {
      result.push({ key: fullKey, val });
    } else if (typeof val === 'object' && !Array.isArray(val)) {
      result.push(...collectStringLeaves(val, fullKey));
    }
  }
  return result;
}

// ── Test runner ────────────────────────────────────────────────────────────────

async function runTest(label, fn) {
  try {
    await fn();
    pass(label);
  } catch (err) {
    fail(label, err.message);
  }
}

// ── Fixture content (canonical LF form) ───────────────────────────────────────
//
// A realistic pipeline.yml that exercises project.name, knowledge.host,
// knowledge.port, knowledge.database, knowledge.user, knowledge.tier,
// knowledge.embedding_model, and storage_backend top-level key.

const FIXTURE_LF = [
  'project:',
  '  name: my-test-project',
  'knowledge:',
  '  tier: embeddings',
  '  host: mydbhost',
  '  port: 5433',
  '  database: my_test_db',
  '  user: myuser',
  '  embedding_model: Qwen/Qwen3-Embedding-8B',
  '  num_ctx: 8192',
  'storage_backend: postgres',
  '',
].join('\n');

// ── Tests ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('Running: test-config-loading\n');

  // Build a reusable temp root dir with the .claude subdirectory.
  // Use os.tmpdir()+path.join — never hardcode /tmp.
  const TS      = Date.now();
  const tmpBase = path.join(os.tmpdir(), `handoff_cfg_${TS}`);
  const claudeDir  = path.join(tmpBase, '.claude');

  fs.mkdirSync(claudeDir, { recursive: true });

  // Save and restore PROJECT_ROOT so we don't corrupt the outer process env.
  const origProjectRoot = process.env.PROJECT_ROOT;
  const origCwd         = process.cwd();

  try {
    // T1 — Pure LF pipeline.yml parses correctly (baseline)
    await runTest('T1: pure LF pipeline.yml parses correctly', () => {
      const cfgPath = path.join(claudeDir, 'pipeline.yml');
      fs.writeFileSync(cfgPath, FIXTURE_LF, { encoding: 'utf8' });

      process.env.PROJECT_ROOT = tmpBase;
      const cfg = loadConfig();

      if (cfg.project !== 'my-test-project') throw new Error(`project: expected 'my-test-project', got '${cfg.project}'`);
      if (cfg.host !== 'mydbhost')            throw new Error(`host: expected 'mydbhost', got '${cfg.host}'`);
      if (cfg.port !== 5433)                  throw new Error(`port: expected 5433, got ${cfg.port}`);
      if (cfg.database !== 'my_test_db')      throw new Error(`database: expected 'my_test_db', got '${cfg.database}'`);
      if (cfg.user !== 'myuser')              throw new Error(`user: expected 'myuser', got '${cfg.user}'`);
      if (cfg.knowledge.tier !== 'embeddings') throw new Error(`tier: expected 'embeddings', got '${cfg.knowledge.tier}'`);
      if (cfg.knowledge.embedding_model !== 'Qwen/Qwen3-Embedding-8B') throw new Error(`embedding_model: expected 'Qwen/Qwen3-Embedding-8B', got '${cfg.knowledge.embedding_model}'`);
      if (cfg.storage_backend !== 'postgres') throw new Error(`storage_backend: expected 'postgres', got '${cfg.storage_backend}'`);

      fs.unlinkSync(cfgPath);
    });

    // T2 — Pure CRLF pipeline.yml parses to byte-identical values as LF
    await runTest('T2: pure CRLF pipeline.yml — no \\r survives in any parsed value (CRLF footgun guard)', () => {
      const cfgPath = path.join(claudeDir, 'pipeline.yml');
      const crlfContent = lfToCrlf(FIXTURE_LF);
      fs.writeFileSync(cfgPath, crlfContent, { encoding: 'utf8' });

      process.env.PROJECT_ROOT = tmpBase;
      const cfg = loadConfig();

      // Check every string leaf for embedded \r
      const leaves = collectStringLeaves(cfg, '');
      for (const { key, val } of leaves) {
        if (val.includes('\r')) {
          throw new Error(
            `CRLF footgun: config key '${key}' has embedded \\r (value: ${JSON.stringify(val)}). ` +
            'shared.js loadConfig does not strip \\r from CRLF content. Fix: normalize content on read, ' +
            'or ensure all regex capture groups call .trim() on results.'
          );
        }
      }

      // Values must equal the LF-parsed baseline.
      if (cfg.project !== 'my-test-project') throw new Error(`CRLF: project: expected 'my-test-project', got ${JSON.stringify(cfg.project)}`);
      if (cfg.host !== 'mydbhost')            throw new Error(`CRLF: host: expected 'mydbhost', got ${JSON.stringify(cfg.host)}`);
      if (cfg.port !== 5433)                  throw new Error(`CRLF: port: expected 5433, got ${cfg.port}`);
      if (cfg.database !== 'my_test_db')      throw new Error(`CRLF: database: expected 'my_test_db', got ${JSON.stringify(cfg.database)}`);
      if (cfg.user !== 'myuser')              throw new Error(`CRLF: user: expected 'myuser', got ${JSON.stringify(cfg.user)}`);
      if (cfg.knowledge.tier !== 'embeddings') throw new Error(`CRLF: tier: expected 'embeddings', got ${JSON.stringify(cfg.knowledge.tier)}`);
      if (cfg.knowledge.embedding_model !== 'Qwen/Qwen3-Embedding-8B') throw new Error(`CRLF: embedding_model: expected 'Qwen/Qwen3-Embedding-8B', got ${JSON.stringify(cfg.knowledge.embedding_model)}`);
      if (cfg.storage_backend !== 'postgres') throw new Error(`CRLF: storage_backend: expected 'postgres', got ${JSON.stringify(cfg.storage_backend)}`);

      fs.unlinkSync(cfgPath);
    });

    // T3 — Mixed CRLF/LF pipeline.yml — same no-\r guarantee
    await runTest('T3: mixed CRLF/LF pipeline.yml — no \\r survives in any parsed value', () => {
      const cfgPath = path.join(claudeDir, 'pipeline.yml');
      const mixedContent = lfToMixed(FIXTURE_LF);
      fs.writeFileSync(cfgPath, mixedContent, { encoding: 'utf8' });

      process.env.PROJECT_ROOT = tmpBase;
      const cfg = loadConfig();

      const leaves = collectStringLeaves(cfg, '');
      for (const { key, val } of leaves) {
        if (val.includes('\r')) {
          throw new Error(
            `mixed-CRLF footgun: config key '${key}' has embedded \\r (value: ${JSON.stringify(val)}). ` +
            'shared.js loadConfig does not strip \\r from mixed-CRLF content.'
          );
        }
      }

      // Values must match LF baseline.
      if (cfg.project !== 'my-test-project') throw new Error(`mixed: project: expected 'my-test-project', got ${JSON.stringify(cfg.project)}`);
      if (cfg.host !== 'mydbhost')            throw new Error(`mixed: host: expected 'mydbhost', got ${JSON.stringify(cfg.host)}`);

      fs.unlinkSync(cfgPath);
    });

    // T4 — Absent pipeline.yml falls back to PG*/documented defaults
    await runTest('T4: absent pipeline.yml — falls back to PG*/documented defaults', () => {
      // Ensure no pipeline.yml exists.
      const cfgPath = path.join(claudeDir, 'pipeline.yml');
      if (fs.existsSync(cfgPath)) fs.unlinkSync(cfgPath);

      process.env.PROJECT_ROOT = tmpBase;

      // Remove PG env vars so we get pure defaults.
      // (loadConfig does not read PGHOST — it always returns 'localhost' as default host
      //  and derives the database from the project name)
      const cfg = loadConfig();

      // host must default to 'localhost'
      if (cfg.host !== 'localhost') throw new Error(`fallback host expected 'localhost', got '${cfg.host}'`);
      // port must default to 5432
      if (cfg.port !== 5432) throw new Error(`fallback port expected 5432, got ${cfg.port}`);
      // user must default to 'postgres'
      if (cfg.user !== 'postgres') throw new Error(`fallback user expected 'postgres', got '${cfg.user}'`);
      // database must be derived from project name (pipeline_<sanitized>)
      if (!cfg.database.startsWith('pipeline_')) throw new Error(`fallback database expected prefix 'pipeline_', got '${cfg.database}'`);
      // knowledge object must be present with all required fields
      if (!cfg.knowledge) throw new Error('fallback: knowledge object must be present');
      if (cfg.knowledge.tier !== 'files') throw new Error(`fallback knowledge.tier expected 'files', got '${cfg.knowledge.tier}'`);
      if (cfg.knowledge.embedding_model !== null) throw new Error(`fallback knowledge.embedding_model expected null, got '${cfg.knowledge.embedding_model}'`);
      if (cfg.knowledge.num_ctx !== null) throw new Error(`fallback knowledge.num_ctx expected null, got '${cfg.knowledge.num_ctx}'`);
      // root must be set
      if (!cfg.root) throw new Error('fallback: root must be set');
      // project must be the directory basename (tmpBase basename)
      const expectedProject = path.basename(tmpBase);
      if (cfg.project !== expectedProject) throw new Error(`fallback project expected '${expectedProject}', got '${cfg.project}'`);
    });

    // T5 — findProjectRoot: honors PROJECT_ROOT env var
    await runTest('T5: findProjectRoot — honors PROJECT_ROOT env var', () => {
      process.env.PROJECT_ROOT = tmpBase;
      const root = findProjectRoot();
      if (root !== tmpBase) throw new Error(`expected '${tmpBase}', got '${root}'`);
    });

    // T6 — findProjectRoot: walks up from cwd to find .git directory
    await runTest('T6: findProjectRoot — walks up from a subdir to find .git directory', () => {
      // Unset PROJECT_ROOT so findProjectRoot uses cwd walk.
      delete process.env.PROJECT_ROOT;

      // The actual repo has a .git at PROJECT_ROOT (the claude-memory repo root).
      // We change cwd into the scripts/ directory so the walk has to go up one level.
      const scriptsDir = path.join(PROJECT_ROOT_CONST, 'scripts');
      process.chdir(scriptsDir);
      try {
        const root = findProjectRoot();
        // The .git is at the repo root — we expect the walk to find it.
        if (!fs.existsSync(path.join(root, '.git'))) {
          throw new Error(`findProjectRoot returned '${root}' which has no .git`);
        }
      } finally {
        process.chdir(origCwd);
        process.env.PROJECT_ROOT = origProjectRoot || tmpBase; // restore
      }
    });

    // T7 — loadConfig: project name derived from directory basename when no config
    await runTest('T7: loadConfig — project name is directory basename when config absent', () => {
      const cfgPath = path.join(claudeDir, 'pipeline.yml');
      if (fs.existsSync(cfgPath)) fs.unlinkSync(cfgPath);

      process.env.PROJECT_ROOT = tmpBase;
      const cfg = loadConfig();
      const expected = path.basename(tmpBase);
      if (cfg.project !== expected) {
        throw new Error(`expected project='${expected}', got '${cfg.project}'`);
      }
    });

    // T8 — loadConfig: knowledge object has all required fields in no-config fallback
    await runTest('T8: loadConfig — knowledge object has all required fields in fallback', () => {
      const cfgPath = path.join(claudeDir, 'pipeline.yml');
      if (fs.existsSync(cfgPath)) fs.unlinkSync(cfgPath);

      process.env.PROJECT_ROOT = tmpBase;
      const cfg = loadConfig();
      const k = cfg.knowledge;
      if (!k) throw new Error('knowledge object absent from fallback config');
      const required = ['tier', 'host', 'port', 'database', 'user', 'embedding_model', 'num_ctx'];
      for (const field of required) {
        if (!(field in k)) throw new Error(`knowledge.${field} is missing from fallback config`);
      }
    });

  } finally {
    // Restore env and cwd.
    if (origProjectRoot !== undefined) {
      process.env.PROJECT_ROOT = origProjectRoot;
    } else {
      delete process.env.PROJECT_ROOT;
    }
    try { process.chdir(origCwd); } catch (_) {}
    // Clean up temp dir.
    if (fs.existsSync(tmpBase)) {
      try { fs.rmSync(tmpBase, { recursive: true, force: true }); } catch (_) {}
    }
  }

  // ── Summary ────────────────────────────────────────────────────────────────────

  console.log('');
  console.log(`Results: ${passed} passed, ${failed} failed`);
  if (failures.length > 0) {
    console.log('\nFailures:');
    for (const f of failures) {
      console.log(`  FAIL  ${f.label}: ${f.reason}`);
    }
  }
  console.log('');
  process.exit(failed > 0 ? 1 : 0);
}

// Constant for repo root — used in T6.
const PROJECT_ROOT_CONST = path.resolve(__dirname, '..');

main().catch((err) => {
  console.error('Uncaught error:', err);
  process.exit(1);
});
