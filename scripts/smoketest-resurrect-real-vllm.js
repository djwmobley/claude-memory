'use strict';

/**
 * smoketest-resurrect-real-vllm.js — Real-vLLM regression guard for the resurrect
 * semantic-seed pipeline.
 *
 * Guards against: PR #83's invisible bug where scripts/lib/embed.js returned a
 * raw 4096-dim vLLM vector instead of Matryoshka-truncating to halfvec(4000),
 * causing runResurrectQuery's cosine SQL to throw "different halfvec dimensions"
 * and silently fall back to fuzzy-only results. Mock-based CI tests (which use
 * pre-generated 4000-dim fixtures) never caught this class of regression.
 *
 * When to run: locally before releasing any change that touches embed.js,
 * handoff.js resurrect path, or pipeline.yml embedding config. NOT added to CI
 * (CI has no vLLM). Run with vLLM running at localhost:8800.
 *
 * Exit codes: 0 = pass or skip (vLLM unreachable), 1 = test failure,
 *             2 = config/internal error.
 */

const path = require('path');
const fs   = require('fs');
const http = require('http');

// ─── Module resolution (mirrors backfill-assertion-embeddings.js) ─────────────

const SCRIPTS_DIR = path.resolve(__dirname);
const REPO_ROOT   = path.resolve(SCRIPTS_DIR, '..');

function findScriptsNodeModules() {
  const local = path.join(SCRIPTS_DIR, 'node_modules');
  if (fs.existsSync(path.join(local, 'pg'))) return local;

  const gitFile = path.join(REPO_ROOT, '.git');
  try {
    const gitContent = fs.readFileSync(gitFile, 'utf8').trim();
    const m = gitContent.match(/^gitdir:\s*(.+)$/);
    if (m) {
      const adminDir     = path.resolve(REPO_ROOT, m[1].trim());
      const parentRoot   = path.resolve(adminDir, '..', '..', '..');
      const parentScripts = path.join(parentRoot, 'scripts', 'node_modules');
      if (fs.existsSync(path.join(parentScripts, 'pg'))) return parentScripts;
    }
  } catch (_) {}
  return null;
}

const _pgModulesDir = findScriptsNodeModules();
if (!_pgModulesDir) {
  process.stderr.write(
    'ERROR: cannot locate scripts/node_modules/pg.\n' +
    `  Tried: ${path.join(SCRIPTS_DIR, 'node_modules', 'pg')}\n` +
    '  Fix: run `npm install` inside the scripts/ directory.\n'
  );
  process.exit(2);
}

if (!process.env._PATHS_INJECTED) {
  const existing = process.env.NODE_PATH || '';
  const newPath  = existing ? `${_pgModulesDir}${path.delimiter}${existing}` : _pgModulesDir;
  const { spawnSync } = require('child_process');
  const result = spawnSync(process.execPath, process.argv.slice(1), {
    env:   { ...process.env, NODE_PATH: newPath, _PATHS_INJECTED: '1' },
    stdio: 'inherit',
  });
  process.exit(result.status === null ? 1 : result.status);
}

const { Client } = require('pg');
const { loadConfig } = require('./lib/shared');
const { embedQuery } = require('./lib/embed');
const embeddingProvider = require('./lib/embedding-provider');

// ─── Helpers ──────────────────────────────────────────────────────────────────

const EMBED_DIMS   = parseInt(process.env.EMBED_DIMS || '4000', 10);
const VLLM_HOST    = 'localhost';
const VLLM_PORT    = 8800;
const SCRATCH_PID  = '__smoketest_resurrect_real_vllm__';

let passed = 0;
let failed = 0;

function pass(label) {
  console.log(`PASS  ${label}`);
  passed++;
}

function fail(label, detail) {
  console.error(`FAIL  ${label}${detail ? ': ' + detail : ''}`);
  failed++;
}

function probeVllm() {
  return new Promise((resolve) => {
    const req = http.get(
      { hostname: VLLM_HOST, port: VLLM_PORT, path: '/v1/models', timeout: 2000 },
      (res) => { res.resume(); resolve(res.statusCode >= 200 && res.statusCode < 300); }
    );
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.on('error',   () => resolve(false));
  });
}

function resolveDbName(cfg) {
  if (process.env.HANDOFF_DB) return process.env.HANDOFF_DB;
  if (cfg && cfg.database) return cfg.database;
  return 'claude_memory_eval_test';
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  // Step 1: probe vLLM
  const reachable = await probeVllm();
  if (!reachable) {
    console.log(`SKIP: vLLM unreachable at localhost:${VLLM_PORT} — set VLLM not running`);
    process.exit(0);
  }

  // Load config
  let cfg;
  try {
    cfg = loadConfig();
  } catch (err) {
    process.stderr.write(`ERROR: loadConfig() failed — ${err.message}\n`);
    process.exit(2);
  }

  // ── Test 1: embed dim ────────────────────────────────────────────────────────
  let vec;
  try {
    vec = await embedQuery('release readiness verification');
    if (vec.length === EMBED_DIMS) {
      pass(`T1: embedQuery dim = ${vec.length}, expected ${EMBED_DIMS}`);
    } else {
      fail(`T1: embedQuery dim = ${vec.length}, expected ${EMBED_DIMS}`);
    }
  } catch (err) {
    fail('T1: embedQuery threw', err.message);
    process.exit(1);
  }

  if (failed > 0) process.exit(1);

  // ── Test 2: cosine SQL round-trip ────────────────────────────────────────────
  const dbName   = resolveDbName(cfg);
  const client   = new Client({
    host:     process.env.PGHOST     || 'localhost',
    port:     parseInt(process.env.PGPORT || '5432', 10),
    user:     process.env.PGUSER     || 'postgres',
    password: process.env.PGPASSWORD || 'postgres',
    database: dbName,
  });

  let scratchId = null;
  try {
    await client.connect();

    // Insert scratch row using the truncated vector from T1. cm#201 #9:
    // stamp via the shared resolver when this target has adopted
    // embedded_by_provider_id (it exercises the real provider anyway, and
    // this scratch row is deleted in the finally block below regardless).
    // Total-classified at run time, same as every other legacy writer this
    // PR touches: a target that has NOT been through the schema bring-
    // forward that adds the column (e.g. claude_memory_eval_test as of
    // 2026-08-18, this script's own default target) proceeds unchanged --
    // out of provenance scope, never a hard requirement for this smoke test.
    const { rows: provenanceColRows } = await client.query(
      `SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'assertions' AND column_name = 'embedded_by_provider_id'`
    );
    const hasProvenanceCol = provenanceColRows.length > 0;
    let providerId = null;
    if (hasProvenanceCol) {
      const providerRow = await embeddingProvider.resolveDefaultProvider(client);
      providerId = providerRow.id;
    }

    const vecLiteral = '[' + vec.join(',') + ']';
    const insertSql = hasProvenanceCol
      ? `INSERT INTO assertions (project_id, subject, predicate, object, confidence, source, embedding, embedded_by_provider_id)
         VALUES ($1, $2, $3, $4, 10, 'user_stated', $5::halfvec, $6)
         RETURNING id`
      : `INSERT INTO assertions (project_id, subject, predicate, object, confidence, source, embedding)
         VALUES ($1, $2, $3, $4, 10, 'user_stated', $5::halfvec)
         RETURNING id`;
    const insertParams = hasProvenanceCol
      ? [SCRATCH_PID, 'smoketest-subject', 'is', 'smoketest-object', vecLiteral, providerId]
      : [SCRATCH_PID, 'smoketest-subject', 'is', 'smoketest-object', vecLiteral];
    const ins = await client.query(insertSql, insertParams);
    scratchId = ins.rows[0].id;

    // Run the exact SQL from handoff.js:1986-1997
    const { rows } = await client.query(
      `SELECT DISTINCT subject
       FROM (
         SELECT subject, (embedding <=> $2::halfvec) AS dist
         FROM assertions
         WHERE project_id = $1
           AND embedding IS NOT NULL
           AND 1 - (embedding <=> $2::halfvec) >= $3
         ORDER BY dist ASC
         LIMIT $4
       ) sub`,
      [SCRATCH_PID, vecLiteral, 0.5, 10]
    );

    if (rows.length > 0) {
      pass('T2: cosine SQL round-trip — no error, row returned');
    } else {
      fail('T2: cosine SQL round-trip — query succeeded but returned zero rows');
    }
  } catch (err) {
    fail('T2: cosine SQL round-trip', err.message);
  } finally {
    // Cleanup scratch row
    if (scratchId !== null) {
      try {
        await client.query('DELETE FROM assertions WHERE id = $1', [scratchId]);
      } catch (_) {}
    }
    try { await client.end(); } catch (_) {}
  }

  // ── Summary ──────────────────────────────────────────────────────────────────
  if (failed > 0) {
    process.exit(1);
  }
  console.log(`PASS  smoketest-resurrect-real-vllm — ${passed} test(s) green`);
  process.exit(0);
}

main().catch((err) => {
  process.stderr.write(`FATAL: ${err.stack || err.message}\n`);
  process.exit(2);
});
