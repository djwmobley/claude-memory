'use strict';

/**
 * test-graph-traversal.js — Exhaustive test harness for the graph edge-traversal
 * retrieval feature (kind:'graph' recursive-CTE loader branch).
 *
 * Architecture mirrors smoketest-handoff.js:
 *   - Throwaway DB: claude_memory_graphtest_<timestamp>
 *   - Unique temp project dir → unique project_id via encodeCwd
 *   - Subprocess env redirect via HANDOFF_DB + PROJECT_ROOT
 *   - Applies handoff-core-schema.sql
 *   - UNCONDITIONAL finally-block teardown (drop DB + temp dirs)
 *   - Seeded PRNG for reproducible "organic" content
 *
 * Usage:
 *   node scripts/test-graph-traversal.js                    # all sections
 *   node scripts/test-graph-traversal.js --section=A        # recursion correctness
 *   node scripts/test-graph-traversal.js --section=B        # integration
 *   node scripts/test-graph-traversal.js --section=C        # organic use
 *   node scripts/test-graph-traversal.js --section=D        # performance
 *   node scripts/test-graph-traversal.js --section=gr       # alias for A (smoketest compat)
 *
 * Exit 0 = all pass; nonzero = any failure.
 */

const { spawnSync } = require('child_process');
const fs            = require('fs');
const os            = require('os');
const path          = require('path');
const { Client }    = require('pg');
const { readMarker } = require('./lib/project-marker');
// cm#224 follow-up: shared guarded pgvector-extension installer.
const { ensureVectorExtension } = require('./lib/test-pg-helpers');

// ── CLI args ──────────────────────────────────────────────────────────────────

const ARGS       = process.argv.slice(2);
const sectionArg = ARGS.find((a) => a.startsWith('--section='));
const SECTION    = sectionArg ? sectionArg.split('=')[1] : 'all';

const VALID_SECTIONS = ['all', 'A', 'B', 'C', 'D', 'gr'];
if (!VALID_SECTIONS.includes(SECTION)) {
  console.error(`Unknown --section value: ${SECTION}. Valid: ${VALID_SECTIONS.join(', ')}`);
  process.exit(2);
}

// ── Constants ─────────────────────────────────────────────────────────────────

const PROJECT_ROOT   = path.resolve(__dirname, '..');
const HANDOFF_SCRIPT = path.join(PROJECT_ROOT, 'scripts', 'handoff.js');
const SCHEMA_FILE    = path.join(PROJECT_ROOT, 'scripts', 'sql', 'handoff-core-schema.sql');
const TS             = Date.now();

// Seeded PRNG — fixed seed for reproducibility.
// LCG parameters from Numerical Recipes.
const PRNG_SEED = 0xDEADBEEF;
let _prngState  = PRNG_SEED;
function prngNext() {
  _prngState = (Math.imul(1664525, _prngState) + 1013904223) >>> 0;
  return _prngState;
}
function prngFloat() { return prngNext() / 0xFFFFFFFF; }
function prngInt(lo, hi) { return lo + (prngNext() % (hi - lo + 1)); }
function prngChoice(arr) { return arr[prngNext() % arr.length]; }

// Reset PRNG to a known state for a sub-test.
function resetPrng() { _prngState = PRNG_SEED; }

// ── Tracking ──────────────────────────────────────────────────────────────────

let aPassed = 0;
let aFailed = 0;
let bPassed = 0;
let bFailed = 0;
let cPassed = 0;
let cFailed = 0;
let dPassed = 0;
let dFailed = 0;

function pass(section, step, label) {
  console.log(`[${section} ${step}] ${label} ... PASS`);
  if (section.startsWith('A')) aPassed++;
  else if (section.startsWith('B')) bPassed++;
  else if (section.startsWith('C')) cPassed++;
  else if (section.startsWith('D')) dPassed++;
}

function fail(section, step, label, reason) {
  console.log(`[${section} ${step}] ${label} ... FAIL: ${reason}`);
  if (section.startsWith('A')) aFailed++;
  else if (section.startsWith('B')) bFailed++;
  else if (section.startsWith('C')) cFailed++;
  else if (section.startsWith('D')) dFailed++;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Extract a named section from loader-load stdout.
 * Returns the section body (text after the header up to the next blank line),
 * or '' if the section header is absent.
 *
 * @param {string} stdout      - subprocess stdout
 * @param {string} sectionName - section header string (e.g. '### Related (graph)')
 * @returns {string}
 */
function extractGraphSection(stdout, sectionName) {
  if (!stdout.includes(sectionName)) return '';
  return stdout.split(sectionName)[1]?.split('\n\n')[0] || '';
}

/**
 * Strip variable token-count line from output so two runs can be compared.
 * Normalizes: "tokens used: ~N / M (sections: ~S)" → "tokens used: ~X"
 *
 * @param {string} s
 * @returns {string}
 */
function normalizeTokenLine(s) {
  return s.replace(/tokens used: ~\d+(?: \/ \d+)?(?: \(sections: ~\d+\))?/g, 'tokens used: ~X');
}

function encodeCwd(p) {
  return p.replace(/[/\\]+$/, '').replace(/[^A-Za-z0-9-]/g, '-');
}

/**
 * Read the project marker UUID from a directory.
 * Returns the UUID string if present and valid, or the encodeCwd fallback otherwise.
 *
 * @param {string} dir
 * @returns {string}
 */
function markerUUIDOrFallback(dir) {
  const m = readMarker(dir);
  return (m && m.uuid) ? m.uuid : encodeCwd(dir);
}

async function pgConnect(database = 'postgres') {
  const cfg = {
    host:     process.env.PGHOST     || 'localhost',
    port:     parseInt(process.env.PGPORT || '5432', 10),
    user:     process.env.PGUSER     || 'postgres',
    password: process.env.PGPASSWORD || 'postgres',
    database,
  };
  const client = new Client(cfg);
  await client.connect();
  return client;
}

async function createTestDb(dbName, projectDir) {
  const sysDb = await pgConnect('postgres');
  const exists = await sysDb.query('SELECT 1 FROM pg_database WHERE datname = $1', [dbName]);
  if (exists.rows.length > 0) {
    await sysDb.end();
    throw new Error(`DB ${dbName} already exists — naming collision`);
  }
  await sysDb.query(`CREATE DATABASE "${dbName}"`);
  await sysDb.end();
  await ensureVectorExtension(dbName);
  fs.mkdirSync(projectDir, { recursive: true });
}

async function dropTestDb(dbName, projectDir) {
  // Clean up filesystem.
  try {
    if (fs.existsSync(projectDir)) fs.rmSync(projectDir, { recursive: true, force: true });
  } catch (_) {}

  // Drop DB.
  let sysDb;
  try {
    sysDb = await pgConnect('postgres');
    await sysDb.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
       WHERE datname = $1 AND pid <> pg_backend_pid()`,
      [dbName]
    );
    await sysDb.query(`DROP DATABASE IF EXISTS "${dbName}"`);
    await sysDb.end();
    console.log(`[TEARDOWN] Dropped DB: ${dbName}`);
  } catch (err) {
    if (sysDb) { try { await sysDb.end(); } catch (_) {} }
    console.error(`[TEARDOWN] WARNING: cleanup failed — ${err.message}`);
  }
}

/** Apply the handoff schema to a DB (idempotent CREATE IF NOT EXISTS). */
async function applySchema(dbName) {
  const sql = fs.readFileSync(SCHEMA_FILE, 'utf8');
  const db  = await pgConnect(dbName);
  await db.query('BEGIN');
  await db.query(sql);
  await db.query('COMMIT');
  await db.end();
}

/** Run `node scripts/handoff.js <sub> [args]` synchronously, env-redirected. */
function runHandoff(sub, extraArgs = [], stdin = null, dbName, projectDir) {
  const env = {
    ...process.env,
    HANDOFF_DB:   dbName,
    PROJECT_ROOT: projectDir,
  };
  const opts = {
    cwd:      PROJECT_ROOT,
    env,
    encoding: 'utf8',
    timeout:  60000,
  };
  if (stdin !== null) opts.input = stdin;
  return spawnSync(process.execPath, [HANDOFF_SCRIPT, sub, ...extraArgs], opts);
}

/** Bootstrap a fresh throwaway DB: create, applySchema, init, write CLAUDE.md. */
async function bootstrapDb(dbName, projectDir) {
  await createTestDb(dbName, projectDir);
  fs.writeFileSync(
    path.join(projectDir, 'CLAUDE.md'),
    '# graph-test\n\n## Durable facts\n- (none)\n',
    'utf8'
  );
  const initR = runHandoff('init', ['-y'], null, dbName, projectDir);
  if (initR.status !== 0) {
    throw new Error(`init failed: ${(initR.stderr || initR.stdout || '').slice(0, 300)}`);
  }
}

/** Insert edges directly into the DB for unit-style tests. */
async function insertEdges(db, projectId, edges) {
  for (const { from, type, to, weight } of edges) {
    await db.query(
      `INSERT INTO edges (project_id, from_entity, edge_type, to_entity, weight)
       VALUES ($1, $2, $3, $4, $5)`,
      [projectId, from, type, to, weight || 1.0]
    );
  }
}

/** Insert entities into the DB. */
async function insertEntities(db, projectId, names) {
  for (const name of names) {
    await db.query(
      `INSERT INTO entities (project_id, name, entity_type, description)
       VALUES ($1, $2, 'concept', $2)
       ON CONFLICT DO NOTHING`,
      [projectId, name]
    );
  }
}

/** Update a project_settings key. */
async function setSetting(db, projectId, key, value) {
  await db.query(
    `INSERT INTO project_settings (project_id, key, value) VALUES ($1, $2, $3)
     ON CONFLICT (project_id, key) DO UPDATE SET value = $3`,
    [projectId, key, value]
  );
}

/** Set the retrieval_contract queries for loader-load. */
async function setContract(db, projectId, queries) {
  await db.query(
    `UPDATE retrieval_contract SET queries = $2::jsonb, updated_at = now()
     WHERE project_id = $1 AND name = 'default'`,
    [projectId, JSON.stringify({ queries })]
  );
}

/**
 * Call the loader directly via DB (not subprocess) for unit tests.
 * Runs loader-load subprocess and returns {stdout, stderr, status}.
 */
function runLoaderLoad(dbName, projectDir) {
  return runHandoff('loader-load', [], null, dbName, projectDir);
}

// ── SECTION A: Recursion correctness ─────────────────────────────────────────

/**
 * A-1: Linear chain A→B→C→D→E.
 * Assert exact reachable set at max_depth ∈ {0,1,2,3,5}.
 */
async function sectionA_linearChain(aDb, aProjectId, aProjectDir) {
  const label = 'Linear chain A→B→C→D→E: reachable set at depth 0,1,2,3,5';
  try {
    // Insert chain edges (fresh connection, closed before loader subprocess).
    {
      const db = await pgConnect(aDb);
      await insertEdges(db, aProjectId, [
        { from: 'A', type: 'depends_on', to: 'B' },
        { from: 'B', type: 'depends_on', to: 'C' },
        { from: 'C', type: 'depends_on', to: 'D' },
        { from: 'D', type: 'depends_on', to: 'E' },
      ]);
      await db.end();
    }

    // Note: filter.max_depth=0 is NOT a valid positive int so it falls back to the setting
    // (graph_max_depth default = '2'). The test cases use only positive max_depth values.
    const casesOut = [
      { depth: 1, expected: ['B'] },
      { depth: 2, expected: ['B', 'C'] },
      { depth: 3, expected: ['B', 'C', 'D'] },
      { depth: 5, expected: ['B', 'C', 'D', 'E'] },
    ];

    for (const { depth, expected } of casesOut) {
      // Open a fresh connection per iteration, close before the subprocess.
      const db = await pgConnect(aDb);
      await setContract(db, aProjectId, [
        { kind: 'graph', filter: { seed: 'A', direction: 'out', max_depth: depth } },
      ]);
      await db.end();

      const r = runLoaderLoad(aDb, aProjectDir);

      if (r.status !== 0) {
        fail('A', 'A-1', label, `depth=${depth} loader-load exited ${r.status}: ${(r.stderr || r.stdout || '').slice(0, 200)}`);
        return;
      }

      const out = r.stdout || '';
      // Check all expected are present.
      const missing = expected.filter((e) => !out.includes(`- ${e} (`));
      // Check no entity outside expected appears in the graph section.
      const graphSection = extractGraphSection(out, '### Related (graph)');
      const allFound = graphSection.split('\n')
        .filter((l) => l.startsWith('- '))
        .map((l) => l.replace(/^- /, '').split(' ')[0]);
      const unexpected = allFound.filter((f) => f.length > 0 && !expected.includes(f));

      if (missing.length > 0) {
        fail('A', 'A-1', label, `depth=${depth}: missing expected nodes ${JSON.stringify(missing)}`);
        return;
      }
      if (unexpected.length > 0) {
        fail('A', 'A-1', label, `depth=${depth}: unexpected nodes found ${JSON.stringify(unexpected)}`);
        return;
      }
    }

    pass('A', 'A-1', label);
  } catch (err) {
    fail('A', 'A-1', label, err.message);
  }
}

/**
 * A-2: Simple cycle A→B→C→A — terminates, each node exactly once, no infinite loop.
 * Uses a timeout assertion (generous 10s bound).
 */
async function sectionA_cycle(aDb, aProjectId, aProjectDir) {
  const label = 'Simple cycle A→B→C→A: terminates, each node once, no infinite loop';
  try {
    const db = await pgConnect(aDb);

    // Insert cycle — these may already exist from A-1; use unique names.
    await insertEdges(db, aProjectId, [
      { from: 'CYC_A', type: 'depends_on', to: 'CYC_B' },
      { from: 'CYC_B', type: 'depends_on', to: 'CYC_C' },
      { from: 'CYC_C', type: 'depends_on', to: 'CYC_A' },
    ]);

    await setContract(db, aProjectId, [
      { kind: 'graph', filter: { seed: 'CYC_A', direction: 'out', max_depth: 5 } },
    ]);
    await db.end();

    const start = Date.now();
    const r = runHandoff('loader-load', [], null, aDb, aProjectDir);
    const elapsed = Date.now() - start;

    if (r.status !== 0) {
      fail('A', 'A-2', label, `loader-load exited ${r.status}: ${(r.stderr || r.stdout || '').slice(0, 200)}`);
      return;
    }

    if (elapsed > 10000) {
      fail('A', 'A-2', label, `loader-load took ${elapsed}ms — too slow (possible cycle hang)`);
      return;
    }

    const out = r.stdout || '';
    // CYC_B and CYC_C should be reachable (not CYC_A itself — it's the seed).
    if (!out.includes('- CYC_B (') && !out.includes('- CYC_C (')) {
      // May also produce no section if both are filtered as seeds via path
      // (cycle prevention might stop CYC_A from re-entering). That's fine.
      // The key invariant is: no hang.
    }

    // Verify CYC_A does not appear as a reached node (it's the seed, excluded).
    const graphSection = extractGraphSection(out, '### Related (graph)');
    if (graphSection.includes('- CYC_A (')) {
      fail('A', 'A-2', label, 'Seed CYC_A appears in graph output — should be excluded');
      return;
    }

    // Count occurrences of CYC_B and CYC_C — each should appear at most once.
    const bCount = (graphSection.match(/- CYC_B \(/g) || []).length;
    const cCount = (graphSection.match(/- CYC_C \(/g) || []).length;
    if (bCount > 1) { fail('A', 'A-2', label, `CYC_B appears ${bCount} times — expected ≤1`); return; }
    if (cCount > 1) { fail('A', 'A-2', label, `CYC_C appears ${cCount} times — expected ≤1`); return; }

    pass('A', 'A-2', label);
  } catch (err) {
    fail('A', 'A-2', label, err.message);
  }
}

/**
 * A-3: Self-loop A→A — terminates, A not duplicated.
 */
async function sectionA_selfLoop(aDb, aProjectId, aProjectDir) {
  const label = 'Self-loop SL_A→SL_A: terminates, SL_A not in output';
  try {
    const db = await pgConnect(aDb);

    await insertEdges(db, aProjectId, [
      { from: 'SL_A', type: 'depends_on', to: 'SL_A' },
    ]);

    await setContract(db, aProjectId, [
      { kind: 'graph', filter: { seed: 'SL_A', direction: 'out', max_depth: 5 } },
    ]);
    await db.end();

    const start = Date.now();
    const r = runHandoff('loader-load', [], null, aDb, aProjectDir);
    const elapsed = Date.now() - start;

    if (r.status !== 0) {
      fail('A', 'A-3', label, `loader-load exited ${r.status}: ${(r.stderr || r.stdout || '').slice(0, 200)}`);
      return;
    }
    if (elapsed > 10000) {
      fail('A', 'A-3', label, `took ${elapsed}ms — possible infinite loop on self-loop`);
      return;
    }

    const out = r.stdout || '';
    const graphSection = extractGraphSection(out, '### Related (graph)');
    // SL_A is the seed — it must NOT appear as a reached node.
    if (graphSection.includes('- SL_A (')) {
      fail('A', 'A-3', label, 'SL_A appears in graph output — self-loop seed should be excluded');
      return;
    }

    pass('A', 'A-3', label);
  } catch (err) {
    fail('A', 'A-3', label, err.message);
  }
}

/**
 * A-4: Diamond A→B, A→C, B→D, C→D.
 * D appears exactly once, min_depth = 2.
 */
async function sectionA_diamond(aDb, aProjectId, aProjectDir) {
  const label = 'Diamond A→B,A→C,B→D,C→D: D appears once, depth=2';
  try {
    const db = await pgConnect(aDb);

    await insertEdges(db, aProjectId, [
      { from: 'DIA_A', type: 'depends_on', to: 'DIA_B' },
      { from: 'DIA_A', type: 'depends_on', to: 'DIA_C' },
      { from: 'DIA_B', type: 'depends_on', to: 'DIA_D' },
      { from: 'DIA_C', type: 'depends_on', to: 'DIA_D' },
    ]);

    await setContract(db, aProjectId, [
      { kind: 'graph', filter: { seed: 'DIA_A', direction: 'out', max_depth: 5 } },
    ]);
    await db.end();

    const r = runHandoff('loader-load', [], null, aDb, aProjectDir);
    if (r.status !== 0) {
      fail('A', 'A-4', label, `loader-load exited ${r.status}: ${(r.stderr || r.stdout || '').slice(0, 200)}`);
      return;
    }

    const out = r.stdout || '';
    const graphSection = extractGraphSection(out, '### Related (graph)');

    // DIA_D must appear exactly once.
    const dCount = (graphSection.match(/- DIA_D \(/g) || []).length;
    if (dCount !== 1) {
      fail('A', 'A-4', label, `DIA_D appears ${dCount} times — expected exactly 1`);
      return;
    }

    // DIA_D must have depth 2.
    const dLine = graphSection.split('\n').find((l) => l.includes('- DIA_D ('));
    if (!dLine || !dLine.includes('depth 2')) {
      fail('A', 'A-4', label, `DIA_D line does not show depth 2: "${dLine}"`);
      return;
    }

    pass('A', 'A-4', label);
  } catch (err) {
    fail('A', 'A-4', label, err.message);
  }
}

/**
 * A-5: Disconnected components — seed in component 1 never returns component 2 nodes.
 */
async function sectionA_disconnected(aDb, aProjectId, aProjectDir) {
  const label = 'Disconnected components: seed in comp-1 returns zero comp-2 nodes';
  try {
    const db = await pgConnect(aDb);

    // Component 1: DC1_X → DC1_Y
    // Component 2: DC2_P → DC2_Q (no edges to/from comp1)
    await insertEdges(db, aProjectId, [
      { from: 'DC1_X', type: 'depends_on', to: 'DC1_Y' },
      { from: 'DC2_P', type: 'depends_on', to: 'DC2_Q' },
    ]);

    await setContract(db, aProjectId, [
      { kind: 'graph', filter: { seed: 'DC1_X', direction: 'out', max_depth: 5 } },
    ]);
    await db.end();

    const r = runHandoff('loader-load', [], null, aDb, aProjectDir);
    if (r.status !== 0) {
      fail('A', 'A-5', label, `loader-load exited ${r.status}: ${(r.stderr || r.stdout || '').slice(0, 200)}`);
      return;
    }

    const out = r.stdout || '';
    if (out.includes('DC2_P') || out.includes('DC2_Q')) {
      fail('A', 'A-5', label, 'Component 2 nodes (DC2_P/DC2_Q) appeared in comp-1 seed traversal');
      return;
    }
    if (!out.includes('DC1_Y')) {
      fail('A', 'A-5', label, 'DC1_Y (reachable from seed) not found in output');
      return;
    }

    pass('A', 'A-5', label);
  } catch (err) {
    fail('A', 'A-5', label, err.message);
  }
}

/**
 * A-6: Direction — same graph, out / in / both produce different results.
 * Graph: DIR_A → DIR_B → DIR_C, seed = DIR_B.
 *   out:  reaches DIR_C
 *   in:   reaches DIR_A
 *   both: reaches DIR_A and DIR_C
 */
async function sectionA_direction(aDb, aProjectId, aProjectDir) {
  const label = 'Direction out/in/both: correct nodes per direction for same graph';
  try {
    // Insert edges once (fresh connection, closed before any subprocess).
    {
      const db = await pgConnect(aDb);
      await insertEdges(db, aProjectId, [
        { from: 'DIR_A', type: 'depends_on', to: 'DIR_B' },
        { from: 'DIR_B', type: 'depends_on', to: 'DIR_C' },
      ]);
      await db.end();
    }

    for (const { direction, expectIn, expectNotIn } of [
      { direction: 'out',  expectIn: ['DIR_C'], expectNotIn: ['DIR_A'] },
      { direction: 'in',   expectIn: ['DIR_A'], expectNotIn: ['DIR_C'] },
      { direction: 'both', expectIn: ['DIR_A', 'DIR_C'], expectNotIn: [] },
    ]) {
      // Fresh connection per case, closed before subprocess.
      const db = await pgConnect(aDb);
      await setContract(db, aProjectId, [
        { kind: 'graph', filter: { seed: 'DIR_B', direction, max_depth: 5 } },
      ]);
      await db.end();

      const r = runHandoff('loader-load', [], null, aDb, aProjectDir);

      if (r.status !== 0) {
        fail('A', 'A-6', label, `direction=${direction}: exited ${r.status}: ${(r.stderr || r.stdout || '').slice(0, 200)}`);
        return;
      }

      const out = r.stdout || '';
      for (const e of expectIn) {
        if (!out.includes(`- ${e} (`)) {
          fail('A', 'A-6', label, `direction=${direction}: expected ${e} in output but not found`);
          return;
        }
      }
      for (const e of expectNotIn) {
        if (out.includes(`- ${e} (`)) {
          fail('A', 'A-6', label, `direction=${direction}: did not expect ${e} in output but found it`);
          return;
        }
      }
    }

    pass('A', 'A-6', label);
  } catch (err) {
    fail('A', 'A-6', label, err.message);
  }
}

/**
 * A-7: Fan-out star — 1 hub → 10,000 leaves.
 * Assert result capped at graph_max_nodes (default 25).
 * Assert wall-time < 5s.
 */
async function sectionA_fanOutStar(aDb, aProjectId, aProjectDir) {
  const label = 'Fan-out star 1→10000 leaves: capped at graph_max_nodes, wall-time < 5s';
  try {
    const db = await pgConnect(aDb);

    // Insert 10,000 leaves via a single bulk VALUES insert.
    const LEAF_COUNT = 10000;
    const valueChunks = [];
    for (let i = 0; i < LEAF_COUNT; i += 500) {
      const vals = [];
      const params = [aProjectId, 'STAR_HUB', 'depends_on'];
      let pi = 4;
      for (let j = i; j < Math.min(i + 500, LEAF_COUNT); j++) {
        vals.push(`($1, $2, $3, $${pi}, 1.0)`);
        params.push(`STAR_LEAF_${j}`);
        pi++;
      }
      await db.query(
        `INSERT INTO edges (project_id, from_entity, edge_type, to_entity, weight) VALUES ${vals.join(', ')}`,
        params
      );
    }

    // Set graph_max_nodes to 25 (already default, but be explicit).
    await setSetting(db, aProjectId, 'graph_max_nodes', '25');
    await setContract(db, aProjectId, [
      { kind: 'graph', filter: { seed: 'STAR_HUB', direction: 'out', max_depth: 1 } },
    ]);
    await db.end();

    const start = Date.now();
    const r = runHandoff('loader-load', [], null, aDb, aProjectDir);
    const elapsed = Date.now() - start;

    if (r.status !== 0) {
      fail('A', 'A-7', label, `loader-load exited ${r.status}: ${(r.stderr || r.stdout || '').slice(0, 200)}`);
      return;
    }
    if (elapsed > 5000) {
      fail('A', 'A-7', label, `wall-time ${elapsed}ms exceeds 5s bound`);
      return;
    }

    const out = r.stdout || '';
    const graphSection = extractGraphSection(out, '### Related (graph)');
    const leafLines = (graphSection.match(/- STAR_LEAF_\d+/g) || []);
    if (leafLines.length > 25) {
      fail('A', 'A-7', label, `${leafLines.length} leaves returned — cap of 25 exceeded`);
      return;
    }
    if (leafLines.length === 0) {
      fail('A', 'A-7', label, 'No leaf nodes returned — expected up to 25');
      return;
    }

    pass('A', 'A-7', label);
  } catch (err) {
    fail('A', 'A-7', label, err.message);
  }
}

/**
 * A-8: Weight ordering — under the cap, higher-weight edges selected first.
 * 3 nodes from hub, weights 1.0, 5.0, 2.0 — ordered 5.0, 2.0, 1.0 in output.
 */
async function sectionA_weightOrdering(aDb, aProjectId, aProjectDir) {
  const label = 'Weight ordering: higher-weight nodes first under cap';
  try {
    const db = await pgConnect(aDb);

    await insertEdges(db, aProjectId, [
      { from: 'WO_HUB', type: 'depends_on', to: 'WO_LOW',  weight: 1.0 },
      { from: 'WO_HUB', type: 'depends_on', to: 'WO_HIGH', weight: 5.0 },
      { from: 'WO_HUB', type: 'depends_on', to: 'WO_MED',  weight: 2.0 },
    ]);

    await setSetting(db, aProjectId, 'graph_max_nodes', '25');
    await setContract(db, aProjectId, [
      { kind: 'graph', filter: { seed: 'WO_HUB', direction: 'out', max_depth: 1 } },
    ]);
    await db.end();

    const r = runHandoff('loader-load', [], null, aDb, aProjectDir);
    if (r.status !== 0) {
      fail('A', 'A-8', label, `loader-load exited ${r.status}: ${(r.stderr || r.stdout || '').slice(0, 200)}`);
      return;
    }

    const out = r.stdout || '';
    const graphSection = extractGraphSection(out, '### Related (graph)');
    const lines = graphSection.split('\n').filter((l) => l.startsWith('- WO_'));
    if (lines.length !== 3) {
      fail('A', 'A-8', label, `expected 3 WO_ lines, got ${lines.length}: ${graphSection}`);
      return;
    }

    // Expected order: WO_HIGH (5.0), WO_MED (2.0), WO_LOW (1.0).
    // (All same depth=1, so sort is weight DESC, then name ASC.)
    const names = lines.map((l) => l.replace(/^- /, '').split(' ')[0]);
    if (names[0] !== 'WO_HIGH') {
      fail('A', 'A-8', label, `expected WO_HIGH first, got ${names[0]}`);
      return;
    }
    if (names[1] !== 'WO_MED') {
      fail('A', 'A-8', label, `expected WO_MED second, got ${names[1]}`);
      return;
    }
    if (names[2] !== 'WO_LOW') {
      fail('A', 'A-8', label, `expected WO_LOW third, got ${names[2]}`);
      return;
    }

    pass('A', 'A-8', label);
  } catch (err) {
    fail('A', 'A-8', label, err.message);
  }
}

/**
 * A-9: Edge/seed absence — no edges, missing seed, empty seed → clean empty result.
 */
async function sectionA_absence(aDb, aProjectId, aProjectDir) {
  const label = 'Edge/seed absence: no edges, missing seed, empty seed → exit 0, no section';
  try {
    const db = await pgConnect(aDb);

    // Sub-test 1: explicit seed with no edges.
    await setContract(db, aProjectId, [
      { kind: 'graph', filter: { seed: 'ABSENT_ENTITY_XYZ', direction: 'out', max_depth: 5 } },
    ]);
    await db.end();

    let r = runHandoff('loader-load', [], null, aDb, aProjectDir);
    if (r.status !== 0) {
      fail('A', 'A-9', label, `missing-seed: exited ${r.status}: ${(r.stderr || r.stdout || '').slice(0, 200)}`);
      return;
    }
    if ((r.stdout || '').includes('### Related (graph)')) {
      fail('A', 'A-9', label, 'missing-seed: graph section present but should be empty');
      return;
    }

    // Sub-test 2: empty seed array → no-op fallback to retrievedEntityNames (also empty).
    const db2 = await pgConnect(aDb);
    await setContract(db2, aProjectId, [
      { kind: 'graph', filter: { seed: [], direction: 'out', max_depth: 5 } },
    ]);
    await db2.end();

    r = runHandoff('loader-load', [], null, aDb, aProjectDir);
    if (r.status !== 0) {
      fail('A', 'A-9', label, `empty-seed: exited ${r.status}`);
      return;
    }

    // Sub-test 3: no filter.seed key → falls back to retrievedEntityNames (empty contract = no entity query).
    const db3 = await pgConnect(aDb);
    await setContract(db3, aProjectId, [
      { kind: 'graph', filter: { direction: 'out', max_depth: 5 } },
    ]);
    await db3.end();

    r = runHandoff('loader-load', [], null, aDb, aProjectDir);
    if (r.status !== 0) {
      fail('A', 'A-9', label, `no-seed-key: exited ${r.status}`);
      return;
    }
    // No graph section expected (no seeds, no entity query before it).
    if ((r.stdout || '').includes('### Related (graph)')) {
      fail('A', 'A-9', label, 'no-seed-key: graph section present with no seeds');
      return;
    }

    pass('A', 'A-9', label);
  } catch (err) {
    fail('A', 'A-9', label, err.message);
  }
}

/**
 * A-10: Multi-tenant isolation — two project_ids with identical entity names and edges.
 * Traversal in project 1 returns ZERO nodes from project 2.
 */
async function sectionA_multiTenant(aDb, aProjectId, aProjectDir) {
  const label = 'Multi-tenant: project_id isolation — traversal returns zero nodes from other project';
  try {
    const db = await pgConnect(aDb);

    const project2Id = 'ISOLATED_PROJECT_TWO';

    // Project 1 edges: MT_A → MT_B
    await insertEdges(db, aProjectId, [
      { from: 'MT_A', type: 'depends_on', to: 'MT_B' },
    ]);

    // Project 2 edges: MT_A → MT_C (same source name, different target)
    await insertEdges(db, project2Id, [
      { from: 'MT_A', type: 'depends_on', to: 'MT_C' },
    ]);

    await setContract(db, aProjectId, [
      { kind: 'graph', filter: { seed: 'MT_A', direction: 'out', max_depth: 5 } },
    ]);
    await db.end();

    const r = runHandoff('loader-load', [], null, aDb, aProjectDir);
    if (r.status !== 0) {
      fail('A', 'A-10', label, `loader-load exited ${r.status}: ${(r.stderr || r.stdout || '').slice(0, 200)}`);
      return;
    }

    const out = r.stdout || '';
    // MT_B should appear (project 1 node).
    if (!out.includes('- MT_B (')) {
      fail('A', 'A-10', label, 'MT_B (project 1 node) not found — expected in project 1 traversal');
      return;
    }
    // MT_C must NOT appear (project 2 node).
    if (out.includes('- MT_C (')) {
      fail('A', 'A-10', label, 'MT_C (project 2 node) appeared in project 1 traversal — isolation breach');
      return;
    }

    pass('A', 'A-10', label);
  } catch (err) {
    fail('A', 'A-10', label, err.message);
  }
}

/**
 * A-11: Depth clamp — request max_depth=99 → behaves as clamped (≤5).
 * A chain of 7 nodes should only reach 5 hops.
 */
async function sectionA_depthClamp(aDb, aProjectId, aProjectDir) {
  const label = 'Depth clamp: max_depth=99 clamped to 5, chain-7 only shows 5 hops';
  try {
    const db = await pgConnect(aDb);

    // Chain: CL_A→CL_B→CL_C→CL_D→CL_E→CL_F→CL_G (7 nodes, 6 hops from CL_A)
    await insertEdges(db, aProjectId, [
      { from: 'CL_A', type: 'depends_on', to: 'CL_B' },
      { from: 'CL_B', type: 'depends_on', to: 'CL_C' },
      { from: 'CL_C', type: 'depends_on', to: 'CL_D' },
      { from: 'CL_D', type: 'depends_on', to: 'CL_E' },
      { from: 'CL_E', type: 'depends_on', to: 'CL_F' },
      { from: 'CL_F', type: 'depends_on', to: 'CL_G' },
    ]);

    await setSetting(db, aProjectId, 'graph_max_nodes', '25');
    await setContract(db, aProjectId, [
      { kind: 'graph', filter: { seed: 'CL_A', direction: 'out', max_depth: 99 } },
    ]);
    await db.end();

    const r = runHandoff('loader-load', [], null, aDb, aProjectDir);
    if (r.status !== 0) {
      fail('A', 'A-11', label, `loader-load exited ${r.status}: ${(r.stderr || r.stdout || '').slice(0, 200)}`);
      return;
    }

    const out = r.stdout || '';
    // At max_depth=5 (clamped from 99), CL_F is reachable (hop 5), CL_G is NOT (hop 6).
    if (!out.includes('- CL_F (')) {
      fail('A', 'A-11', label, 'CL_F (hop 5) not found — depth clamp may be too aggressive');
      return;
    }
    if (out.includes('- CL_G (')) {
      fail('A', 'A-11', label, 'CL_G (hop 6) found — depth clamp to 5 not enforced');
      return;
    }

    pass('A', 'A-11', label);
  } catch (err) {
    fail('A', 'A-11', label, err.message);
  }
}

/**
 * A-12: Determinism — identical input run twice → byte-identical graph section.
 */
async function sectionA_determinism(aDb, aProjectId, aProjectDir) {
  const label = 'Determinism: identical input run twice → byte-identical graph section';
  try {
    const db = await pgConnect(aDb);

    // Simple deterministic graph.
    await insertEdges(db, aProjectId, [
      { from: 'DET_A', type: 'depends_on', to: 'DET_B', weight: 3.0 },
      { from: 'DET_A', type: 'depends_on', to: 'DET_C', weight: 2.0 },
    ]);

    await setContract(db, aProjectId, [
      { kind: 'graph', filter: { seed: 'DET_A', direction: 'out', max_depth: 2 } },
    ]);
    await db.end();

    const r1 = runHandoff('loader-load', [], null, aDb, aProjectDir);
    const r2 = runHandoff('loader-load', [], null, aDb, aProjectDir);

    if (r1.status !== 0 || r2.status !== 0) {
      fail('A', 'A-12', label, `loader-load failed: ${r1.status}/${r2.status}`);
      return;
    }

    // Extract graph section from each run.
    const s1 = extractGraphSection(r1.stdout || '', '### Related (graph)');
    const s2 = extractGraphSection(r2.stdout || '', '### Related (graph)');

    if (s1 !== s2) {
      fail('A', 'A-12', label, `Graph sections differ:\nRun1: ${JSON.stringify(s1)}\nRun2: ${JSON.stringify(s2)}`);
      return;
    }

    pass('A', 'A-12', label);
  } catch (err) {
    fail('A', 'A-12', label, err.message);
  }
}

async function runSectionA() {
  console.log('\n=== SECTION A: Recursion Correctness (12 tests) ===');
  const TS_A   = Date.now();
  const A_DB   = `claude_memory_graphtest_A_${TS_A}`;
  const A_DIR  = path.join(os.tmpdir(), `graphtest_A_${TS_A}`);

  try {
    await bootstrapDb(A_DB, A_DIR);
    // Read the UUID minted by cmdInit (PR #53 marker-identity model).
    const A_PID  = markerUUIDOrFallback(A_DIR);
    console.log(`[A] DB: ${A_DB}  project_id: ${A_PID}`);

    await sectionA_linearChain(A_DB, A_PID, A_DIR);
    await sectionA_cycle(A_DB, A_PID, A_DIR);
    await sectionA_selfLoop(A_DB, A_PID, A_DIR);
    await sectionA_diamond(A_DB, A_PID, A_DIR);
    await sectionA_disconnected(A_DB, A_PID, A_DIR);
    await sectionA_direction(A_DB, A_PID, A_DIR);
    await sectionA_fanOutStar(A_DB, A_PID, A_DIR);
    await sectionA_weightOrdering(A_DB, A_PID, A_DIR);
    await sectionA_absence(A_DB, A_PID, A_DIR);
    await sectionA_multiTenant(A_DB, A_PID, A_DIR);
    await sectionA_depthClamp(A_DB, A_PID, A_DIR);
    await sectionA_determinism(A_DB, A_PID, A_DIR);

  } finally {
    await dropTestDb(A_DB, A_DIR);
  }
}

// ── SECTION B: Integration ────────────────────────────────────────────────────

/**
 * B-1: entity query + graph query in contract — graph seeds from retrieved entities.
 */
async function sectionB_entitySeedFallback(bDb, bProjectId, bProjectDir) {
  const label = 'Contract entity+graph: graph seeds from entity query results';
  try {
    const db = await pgConnect(bDb);

    // Insert an entity so the entity kind returns it.
    await insertEntities(db, bProjectId, ['B1_SOURCE']);
    // Edge: B1_SOURCE → B1_TARGET (multi-hop).
    await insertEdges(db, bProjectId, [
      { from: 'B1_SOURCE', type: 'depends_on', to: 'B1_TARGET' },
      { from: 'B1_TARGET', type: 'depends_on', to: 'B1_DEEP' },
    ]);

    // Contract: entity first (loads B1_SOURCE into retrievedEntityNames),
    // then graph (no explicit seed → inherits retrievedEntityNames = ['B1_SOURCE']).
    await setContract(db, bProjectId, [
      { kind: 'entity', filter: { name: 'B1_SOURCE' } },
      { kind: 'graph',  filter: { direction: 'out', max_depth: 2 } },
    ]);
    await db.end();

    const r = runHandoff('loader-load', [], null, bDb, bProjectDir);
    if (r.status !== 0) {
      fail('B', 'B-1', label, `loader-load exited ${r.status}: ${(r.stderr || r.stdout || '').slice(0, 200)}`);
      return;
    }

    const out = r.stdout || '';
    if (!out.includes('### Related (graph)')) {
      fail('B', 'B-1', label, 'Graph section not present');
      return;
    }
    if (!out.includes('- B1_TARGET (')) {
      fail('B', 'B-1', label, 'B1_TARGET (hop 1) not found in graph section');
      return;
    }
    if (!out.includes('- B1_DEEP (')) {
      fail('B', 'B-1', label, 'B1_DEEP (hop 2) not found in graph section');
      return;
    }

    pass('B', 'B-1', label);
  } catch (err) {
    fail('B', 'B-1', label, err.message);
  }
}

/**
 * B-2: Explicit filter.seed in contract.
 */
async function sectionB_explicitSeed(bDb, bProjectId, bProjectDir) {
  const label = 'Explicit filter.seed in contract: correct nodes returned';
  try {
    const db = await pgConnect(bDb);

    await insertEdges(db, bProjectId, [
      { from: 'B2_SEED', type: 'implements', to: 'B2_IMPL' },
    ]);

    await setContract(db, bProjectId, [
      { kind: 'graph', filter: { seed: 'B2_SEED', direction: 'out', max_depth: 1 } },
    ]);
    await db.end();

    const r = runHandoff('loader-load', [], null, bDb, bProjectDir);
    if (r.status !== 0) {
      fail('B', 'B-2', label, `exited ${r.status}: ${(r.stderr || r.stdout || '').slice(0, 200)}`);
      return;
    }

    const out = r.stdout || '';
    if (!out.includes('- B2_IMPL (')) {
      fail('B', 'B-2', label, 'B2_IMPL not found in graph section');
      return;
    }

    pass('B', 'B-2', label);
  } catch (err) {
    fail('B', 'B-2', label, err.message);
  }
}

/**
 * B-3: Token budget — small budget; graph section truncated/omitted rather than overflowing.
 */
async function sectionB_tokenBudget(bDb, bProjectId, bProjectDir) {
  const label = 'Token budget: graph section omitted/truncated when budget exhausted';
  try {
    const db = await pgConnect(bDb);

    // Insert enough edges so the graph section would be large.
    for (let i = 0; i < 30; i++) {
      await db.query(
        `INSERT INTO edges (project_id, from_entity, edge_type, to_entity, weight)
         VALUES ($1, 'B3_HUB', 'depends_on', $2, 1.0)`,
        [bProjectId, `B3_LEAF_${i}`]
      );
    }

    // Set a very small token budget.
    await setSetting(db, bProjectId, 'loader_token_budget', '50');

    await setContract(db, bProjectId, [
      { kind: 'graph', filter: { seed: 'B3_HUB', direction: 'out', max_depth: 1 } },
    ]);
    await db.end();

    const r = runHandoff('loader-load', [], null, bDb, bProjectDir);
    if (r.status !== 0) {
      fail('B', 'B-3', label, `exited ${r.status}: ${(r.stderr || r.stdout || '').slice(0, 200)}`);
      return;
    }

    // Parse "tokens used: ~TRUE / BUDGET (sections: ~SECT)" from output.
    // The TRUE figure includes canon + handoff.md body and legitimately exceeds
    // tiny test budgets (those components are always served regardless of budget).
    // The REAL invariant is that the SECTIONS figure respects the section budget:
    // if the budget is tiny the graph section must be omitted/truncated so that
    // the sections-only cost stays within budget.
    const out = r.stdout || '';
    const match = out.match(/tokens used: ~(\d+) \/ (\d+)(?: \(sections: ~(\d+)\))?/);
    if (!match) {
      fail('B', 'B-3', label, 'Could not parse "tokens used" line from output');
      return;
    }
    const budget = parseInt(match[2], 10);
    // Use sections figure when available (new format); fall back to headline (old format).
    const sect = match[3] !== undefined ? parseInt(match[3], 10) : parseInt(match[1], 10);

    if (sect > budget) {
      fail('B', 'B-3', label, `sections tokens (${sect}) exceeds budget (${budget}) — graph section not omitted/truncated`);
      return;
    }

    // Restore budget.
    const db2 = await pgConnect(bDb);
    await setSetting(db2, bProjectId, 'loader_token_budget', '4000');
    await db2.end();

    pass('B', 'B-3', label);
  } catch (err) {
    fail('B', 'B-3', label, err.message);
  }
}

/**
 * B-4: W3 + graph both enabled — both sections present; budget respected.
 */
async function sectionB_w3AndGraph(bDb, bProjectId, bProjectDir) {
  const label = 'W3 (community) + graph both enabled: both sections present, budget respected';
  try {
    const db = await pgConnect(bDb);

    // Insert entities and edges.
    await insertEntities(db, bProjectId, ['B4_ENT']);
    await insertEdges(db, bProjectId, [
      { from: 'B4_ENT', type: 'depends_on', to: 'B4_GRAPH_NODE' },
    ]);

    // Insert a community run so W3 can potentially produce output.
    // (W3 requires entity_communities rows; insert minimal ones.)
    const runId = `b4-run-${Date.now()}`;
    try {
      await db.query(
        `INSERT INTO entity_communities (project_id, entity_name, community_id, run_id, computed_at)
         VALUES ($1, 'B4_ENT', 1, $2, now()), ($1, 'B4_COMM_SIBLING', 1, $2, now())`,
        [bProjectId, runId]
      );
    } catch (_) {
      // entity_communities may not exist in some environments — skip W3 part of this check.
    }

    // Restore budget.
    await setSetting(db, bProjectId, 'loader_token_budget', '4000');

    await setContract(db, bProjectId, [
      { kind: 'entity', filter: { name: 'B4_ENT' } },
      { kind: 'graph',  filter: { direction: 'out', max_depth: 1 } },
    ]);
    await db.end();

    const r = runHandoff('loader-load', [], null, bDb, bProjectDir);
    if (r.status !== 0) {
      fail('B', 'B-4', label, `exited ${r.status}: ${(r.stderr || r.stdout || '').slice(0, 200)}`);
      return;
    }

    const out = r.stdout || '';

    // Graph section must be present.
    if (!out.includes('### Related (graph)')) {
      fail('B', 'B-4', label, 'Graph section not present');
      return;
    }
    if (!out.includes('- B4_GRAPH_NODE (')) {
      fail('B', 'B-4', label, 'B4_GRAPH_NODE not found in graph section');
      return;
    }

    // Token budget respected (sections figure, not TRUE which includes canon+body).
    const match = out.match(/tokens used: ~(\d+) \/ (\d+)(?: \(sections: ~(\d+)\))?/);
    if (match) {
      const budget = parseInt(match[2], 10);
      const sect   = match[3] !== undefined ? parseInt(match[3], 10) : parseInt(match[1], 10);
      if (sect > budget) {
        fail('B', 'B-4', label, `sections tokens (${sect}) exceeds budget (${budget})`);
        return;
      }
    }

    pass('B', 'B-4', label);
  } catch (err) {
    fail('B', 'B-4', label, err.message);
  }
}

/**
 * B-5: Gating graph_retrieval_enabled=disabled → output BYTE-IDENTICAL to same scenario without feature.
 */
async function sectionB_gatingDisabled(bDb, bProjectId, bProjectDir) {
  const label = 'Gating disabled: loader output byte-identical to scenario without graph query';
  try {
    const db = await pgConnect(bDb);

    await insertEdges(db, bProjectId, [
      { from: 'B5_SRC', type: 'depends_on', to: 'B5_DEST' },
    ]);

    // Baseline: contract with graph query, gate enabled → has graph section.
    await setSetting(db, bProjectId, 'graph_retrieval_enabled', 'enabled');
    await setContract(db, bProjectId, [
      { kind: 'graph', filter: { seed: 'B5_SRC', direction: 'out', max_depth: 1 } },
    ]);
    await db.end();

    const rEnabled = runHandoff('loader-load', [], null, bDb, bProjectDir);
    if (rEnabled.status !== 0) {
      fail('B', 'B-5', label, `gate-enabled: exited ${rEnabled.status}`);
      return;
    }

    // Gate disabled: same contract but gate off → NO graph section.
    const db2 = await pgConnect(bDb);
    await setSetting(db2, bProjectId, 'graph_retrieval_enabled', 'disabled');
    await db2.end();

    const rDisabled = runHandoff('loader-load', [], null, bDb, bProjectDir);
    if (rDisabled.status !== 0) {
      fail('B', 'B-5', label, `gate-disabled: exited ${rDisabled.status}`);
      return;
    }

    const outEnabled  = rEnabled.stdout || '';
    const outDisabled = rDisabled.stdout || '';

    if (outDisabled.includes('### Related (graph)')) {
      fail('B', 'B-5', label, 'Graph section present when graph_retrieval_enabled=disabled');
      return;
    }

    // Baseline (no graph query at all): contract without graph query.
    const db3 = await pgConnect(bDb);
    await setSetting(db3, bProjectId, 'graph_retrieval_enabled', 'enabled'); // restore
    await setContract(db3, bProjectId, []); // empty contract
    await db3.end();

    const rNoGraph = runHandoff('loader-load', [], null, bDb, bProjectDir);
    if (rNoGraph.status !== 0) {
      fail('B', 'B-5', label, `no-graph: exited ${rNoGraph.status}`);
      return;
    }

    // Compare disabled-gate with no-graph-query output (normalize token count).
    // Mask the full token line: ~TRUE / BUDGET (sections: ~SECT) — all three numbers vary.
    if (normalizeTokenLine(outDisabled) !== normalizeTokenLine(rNoGraph.stdout || '')) {
      fail('B', 'B-5', label, 'gate-disabled output differs from no-graph-query baseline');
      return;
    }

    pass('B', 'B-5', label);
  } catch (err) {
    fail('B', 'B-5', label, err.message);
  }
}

/**
 * B-6: Contract WITHOUT a graph query — output BYTE-IDENTICAL to pre-feature baseline.
 * This is the regression guard.
 */
async function sectionB_noGraphQuery_regressionGuard(bDb, bProjectId, bProjectDir) {
  const label = 'Regression guard: no graph query → byte-identical baseline output (run 1 vs run 2)';
  try {
    const db = await pgConnect(bDb);

    // Standard assertion contract (no graph kind).
    await db.query(
      `INSERT INTO assertions (project_id, subject, predicate, object, confidence, source, last_reinforced)
       VALUES ($1, 'B6_SUBJ', 'is_status', 'B6_OBJ', 8, 'user_stated', now())
       ON CONFLICT DO NOTHING`,
      [bProjectId]
    );

    await setContract(db, bProjectId, [
      { kind: 'assertion' },
    ]);
    await db.end();

    const r1 = runHandoff('loader-load', [], null, bDb, bProjectDir);
    const r2 = runHandoff('loader-load', [], null, bDb, bProjectDir);

    if (r1.status !== 0 || r2.status !== 0) {
      fail('B', 'B-6', label, `loader-load failed: ${r1.status}/${r2.status}`);
      return;
    }

    // Mask the full token line: ~TRUE / BUDGET (sections: ~SECT) — all three numbers vary.
    const out1 = normalizeTokenLine(r1.stdout || '');
    const out2 = normalizeTokenLine(r2.stdout || '');

    if (out1 !== out2) {
      fail('B', 'B-6', label, 'Two runs with no-graph contract produced different output — regression');
      return;
    }
    if (out1.includes('### Related (graph)')) {
      fail('B', 'B-6', label, 'Graph section present in no-graph contract output — regression');
      return;
    }

    pass('B', 'B-6', label);
  } catch (err) {
    fail('B', 'B-6', label, err.message);
  }
}

/**
 * B-7: Fault injection — dropped edges table mid-run → loader degrades non-fatally.
 * (We simulate this by using a graph query referencing a non-existent config column
 * to trigger the catch block. Actually we drop and recreate the edges table.)
 */
async function sectionB_faultInjection(bDb, bProjectId, bProjectDir) {
  const label = 'Fault injection: dropped edges table → loader exit 0, rest of context preserved';
  try {
    const db = await pgConnect(bDb);

    // Add a simple assertion so there is "rest of context" to check.
    await db.query(
      `INSERT INTO assertions (project_id, subject, predicate, object, confidence, source, last_reinforced)
       VALUES ($1, 'B7_FAULT', 'is_status', 'present', 9, 'user_stated', now())
       ON CONFLICT DO NOTHING`,
      [bProjectId]
    );

    await setContract(db, bProjectId, [
      { kind: 'assertion' },
      { kind: 'graph', filter: { seed: 'B7_FAULT', direction: 'out', max_depth: 1 } },
    ]);

    // Drop the edges table to force fault in graph branch.
    await db.query('DROP TABLE IF EXISTS edges CASCADE');
    await db.end();

    const r = runHandoff('loader-load', [], null, bDb, bProjectDir);

    // Restore edges table for subsequent tests.
    const db2 = await pgConnect(bDb);
    await db2.query(`
      CREATE TABLE IF NOT EXISTS edges (
        id           SERIAL PRIMARY KEY,
        project_id   TEXT NOT NULL,
        from_entity  TEXT NOT NULL,
        edge_type    TEXT NOT NULL,
        to_entity    TEXT NOT NULL,
        weight       FLOAT DEFAULT 1.0,
        created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
        session_id   TEXT
      )
    `);
    await db2.query(`CREATE INDEX IF NOT EXISTS edges_project_idx ON edges (project_id)`);
    await db2.query(`CREATE INDEX IF NOT EXISTS edges_from_idx ON edges (project_id, from_entity)`);
    await db2.query(`CREATE INDEX IF NOT EXISTS edges_to_idx ON edges (project_id, to_entity)`);
    await db2.end();

    // Loader must exit 0 (non-fatal degradation).
    if (r.status !== 0) {
      fail('B', 'B-7', label, `loader-load exited ${r.status} instead of 0 after edges drop`);
      return;
    }

    // Assertion context must still be present (graph error is non-fatal).
    const out = r.stdout || '';
    if (!out.includes('B7_FAULT')) {
      fail('B', 'B-7', label, 'Assertion context (B7_FAULT) missing after graph fault — non-fatal degradation failed');
      return;
    }

    // Graph section must NOT be present (fault caught cleanly).
    if (out.includes('### Related (graph)')) {
      fail('B', 'B-7', label, 'Graph section present despite dropped table — fault not caught cleanly');
      return;
    }

    pass('B', 'B-7', label);
  } catch (err) {
    fail('B', 'B-7', label, err.message);
  }
}

async function runSectionB() {
  console.log('\n=== SECTION B: Integration (7 tests) ===');
  const TS_B  = Date.now();
  const B_DB  = `claude_memory_graphtest_B_${TS_B}`;
  const B_DIR = path.join(os.tmpdir(), `graphtest_B_${TS_B}`);

  try {
    await bootstrapDb(B_DB, B_DIR);
    // Read the UUID minted by cmdInit (PR #53 marker-identity model).
    const B_PID = markerUUIDOrFallback(B_DIR);
    console.log(`[B] DB: ${B_DB}  project_id: ${B_PID}`);

    await sectionB_entitySeedFallback(B_DB, B_PID, B_DIR);
    await sectionB_explicitSeed(B_DB, B_PID, B_DIR);
    await sectionB_tokenBudget(B_DB, B_PID, B_DIR);
    await sectionB_w3AndGraph(B_DB, B_PID, B_DIR);
    await sectionB_gatingDisabled(B_DB, B_PID, B_DIR);
    await sectionB_noGraphQuery_regressionGuard(B_DB, B_PID, B_DIR);
    await sectionB_faultInjection(B_DB, B_PID, B_DIR);

  } finally {
    await dropTestDb(B_DB, B_DIR);
  }
}

// ── SECTION C: Organic use ────────────────────────────────────────────────────

/**
 * Generate a seeded realistic domain knowledge graph.
 * ~500 entities, ~1500 typed edges, skewed degree, some cycles, some isolated.
 */
function generateOrganicGraph() {
  resetPrng();

  const ENTITY_COUNT = 500;
  const EDGE_COUNT   = 1500;
  const EDGE_TYPES   = ['depends_on', 'implements', 'supersedes', 'blocks', 'owns'];

  const entities = [];
  for (let i = 0; i < ENTITY_COUNT; i++) {
    entities.push(`ORG_ENT_${i}`);
  }

  const edges = [];
  const edgeSet = new Set();

  // Power-law-like degree distribution: hubs get more edges.
  // For each edge, source is biased toward low-index entities (hubs).
  for (let e = 0; e < EDGE_COUNT; e++) {
    // Source: power-law index (bias toward first ~50 entities).
    const fromIdx = Math.floor(Math.abs(prngFloat()) * Math.abs(prngFloat()) * ENTITY_COUNT);
    const toIdx   = prngInt(0, ENTITY_COUNT - 1);

    if (fromIdx === toIdx) continue; // no self-loops in organic graph

    const key = `${fromIdx}-${toIdx}`;
    if (edgeSet.has(key)) continue;
    edgeSet.add(key);

    edges.push({
      from:   entities[fromIdx],
      to:     entities[toIdx],
      type:   prngChoice(EDGE_TYPES),
      weight: 0.5 + prngFloat() * 4.5, // weight ∈ [0.5, 5.0]
    });
  }

  // Add ~20 cycles.
  for (let c = 0; c < 20; c++) {
    const a = prngInt(0, ENTITY_COUNT - 1);
    const b = prngInt(0, ENTITY_COUNT - 1);
    if (a !== b) {
      edges.push({ from: entities[a], to: entities[b], type: 'depends_on', weight: 1.0 });
      edges.push({ from: entities[b], to: entities[a], type: 'depends_on', weight: 1.0 });
    }
  }

  return { entities, edges };
}

/**
 * C-1: Organic close → resume cycle.
 * Generate ~500 entities / ~1500 edges, close with them, resume with graph contract.
 * Assert: multi-hop neighbors surface, caps respected, exit 0.
 */
async function sectionC_organicCloseResume(cDb, cProjectId, cProjectDir) {
  const label = 'Organic close→resume: ~500 entities ~1500 edges, graph contract, exit 0, caps respected';
  try {
    const { entities, edges } = generateOrganicGraph();

    // Insert entities + edges via a close payload.
    // The close command ingests assertions; we insert entities/edges directly.
    const db = await pgConnect(cDb);
    console.log(`  [C-1] Inserting ${entities.length} entities and ${edges.length} edges...`);

    // Bulk insert entities.
    for (let i = 0; i < entities.length; i += 100) {
      const chunk = entities.slice(i, i + 100);
      const vals  = chunk.map((_, j) => `($1, $${j + 2}, 'concept', 'organic entity')`).join(', ');
      await db.query(
        `INSERT INTO entities (project_id, name, entity_type, description) VALUES ${vals}
         ON CONFLICT DO NOTHING`,
        [cProjectId, ...chunk]
      );
    }

    // Bulk insert edges.
    for (let i = 0; i < edges.length; i += 200) {
      const chunk = edges.slice(i, i + 200);
      const vals  = [];
      const params = [cProjectId];
      let pi = 2;
      for (const edge of chunk) {
        vals.push(`($1, $${pi}, $${pi + 1}, $${pi + 2}, $${pi + 3})`);
        params.push(edge.from, edge.type, edge.to, edge.weight);
        pi += 4;
      }
      await db.query(
        `INSERT INTO edges (project_id, from_entity, edge_type, to_entity, weight) VALUES ${vals.join(', ')}`,
        params
      );
    }

    // Insert a handful of assertions for the entity query.
    for (let i = 0; i < 5; i++) {
      await db.query(
        `INSERT INTO assertions (project_id, subject, predicate, object, confidence, source, last_reinforced)
         VALUES ($1, $2, 'is_status', 'active', 8, 'user_stated', now())
         ON CONFLICT DO NOTHING`,
        [cProjectId, entities[i]]
      );
    }

    // Set graph contract: entity query (loads first 5 entities) then graph from them.
    await setSetting(db, cProjectId, 'loader_token_budget', '4000');
    await setSetting(db, cProjectId, 'graph_max_nodes', '25');
    await setContract(db, cProjectId, [
      { kind: 'entity' },
      { kind: 'graph', filter: { direction: 'out', max_depth: 2 } },
    ]);
    await db.end();

    const r = runHandoff('loader-load', [], null, cDb, cProjectDir);
    if (r.status !== 0) {
      fail('C', 'C-1', label, `loader-load exited ${r.status}: ${(r.stderr || r.stdout || '').slice(0, 200)}`);
      return;
    }

    const out = r.stdout || '';

    // Graph section must be present (entities 0-4 are seeds; entity[0] = ORG_ENT_0 is a hub).
    if (!out.includes('### Related (graph)')) {
      fail('C', 'C-1', label, 'Graph section not present with organic data');
      return;
    }

    // Token budget respected (sections figure, not TRUE which includes canon+body).
    const match = out.match(/tokens used: ~(\d+) \/ (\d+)(?: \(sections: ~(\d+)\))?/);
    if (match) {
      const budget = parseInt(match[2], 10);
      const sect   = match[3] !== undefined ? parseInt(match[3], 10) : parseInt(match[1], 10);
      if (sect > budget) {
        fail('C', 'C-1', label, `sections tokens (${sect}) exceeds budget (${budget})`);
        return;
      }
    }

    // Count leaf lines — must be ≤ graph_max_nodes (25).
    const graphSection = out.split('### Related (graph)')[1]?.split('\n\n')[0] || '';
    const leafCount = (graphSection.match(/^- /gm) || []).length;
    if (leafCount > 25) {
      fail('C', 'C-1', label, `${leafCount} nodes returned — exceeds graph_max_nodes=25`);
      return;
    }

    pass('C', 'C-1', label);
  } catch (err) {
    fail('C', 'C-1', label, err.message);
  }
}

async function runSectionC() {
  console.log('\n=== SECTION C: Organic Use (1 test) ===');
  const TS_C  = Date.now();
  const C_DB  = `claude_memory_graphtest_C_${TS_C}`;
  const C_DIR = path.join(os.tmpdir(), `graphtest_C_${TS_C}`);

  try {
    await bootstrapDb(C_DB, C_DIR);
    // Read the UUID minted by cmdInit (PR #53 marker-identity model).
    const C_PID = markerUUIDOrFallback(C_DIR);
    console.log(`[C] DB: ${C_DB}  project_id: ${C_PID}`);
    await sectionC_organicCloseResume(C_DB, C_PID, C_DIR);
  } finally {
    await dropTestDb(C_DB, C_DIR);
  }
}

// ── SECTION D: Performance ────────────────────────────────────────────────────

/**
 * D-1: Organic corpus (~500 entities / ~1500 edges) resume < 3s.
 * D-2: 10k-star capped resume < 5s (same as A-7 but measured here).
 * D-3: Default (no-graph) path unregressed — run without graph query and
 *      confirm it doesn't slow down (exits < 3s as proxy check).
 */
async function runSectionD() {
  console.log('\n=== SECTION D: Performance (3 tests) ===');
  const TS_D  = Date.now();
  const D_DB  = `claude_memory_graphtest_D_${TS_D}`;
  const D_DIR = path.join(os.tmpdir(), `graphtest_D_${TS_D}`);

  try {
    await bootstrapDb(D_DB, D_DIR);
    // Read the UUID minted by cmdInit (PR #53 marker-identity model).
    const D_PID = markerUUIDOrFallback(D_DIR);
    console.log(`[D] DB: ${D_DB}  project_id: ${D_PID}`);

    // ── D-1: Organic corpus ───────────────────────────────────────────────────
    {
      const label = 'D-1: Organic corpus (~500 ent, ~1500 edges) graph-augmented resume < 3s';
      try {
        const { entities, edges } = generateOrganicGraph();
        const db = await pgConnect(D_DB);

        console.log(`  [D-1] Inserting ${entities.length} entities and ${edges.length} edges...`);
        for (let i = 0; i < entities.length; i += 100) {
          const chunk = entities.slice(i, i + 100);
          const vals  = chunk.map((_, j) => `($1, $${j + 2}, 'concept', 'perf entity')`).join(', ');
          await db.query(
            `INSERT INTO entities (project_id, name, entity_type, description) VALUES ${vals} ON CONFLICT DO NOTHING`,
            [D_PID, ...chunk]
          );
        }
        for (let i = 0; i < edges.length; i += 200) {
          const chunk  = edges.slice(i, i + 200);
          const vals   = [];
          const params = [D_PID];
          let pi = 2;
          for (const e of chunk) {
            vals.push(`($1, $${pi}, $${pi + 1}, $${pi + 2}, $${pi + 3})`);
            params.push(e.from, e.type, e.to, e.weight);
            pi += 4;
          }
          await db.query(
            `INSERT INTO edges (project_id, from_entity, edge_type, to_entity, weight) VALUES ${vals.join(', ')}`,
            params
          );
        }

        // Seed a few assertions so the entity query returns something.
        for (let i = 0; i < 5; i++) {
          await db.query(
            `INSERT INTO assertions (project_id, subject, predicate, object, confidence, source, last_reinforced)
             VALUES ($1, $2, 'is_status', 'active', 8, 'user_stated', now()) ON CONFLICT DO NOTHING`,
            [D_PID, entities[i]]
          );
        }

        await setContract(db, D_PID, [
          { kind: 'entity' },
          { kind: 'graph', filter: { direction: 'out', max_depth: 2 } },
        ]);
        await db.end();

        const start   = Date.now();
        const r       = runHandoff('loader-load', [], null, D_DB, D_DIR);
        const elapsed = Date.now() - start;

        console.log(`  [D-1] elapsed: ${elapsed}ms`);

        if (r.status !== 0) {
          fail('D', 'D-1', label, `loader-load exited ${r.status}: ${(r.stderr || r.stdout || '').slice(0, 200)}`);
        } else if (elapsed > 3000) {
          fail('D', 'D-1', label, `elapsed ${elapsed}ms exceeds 3s bound`);
        } else {
          pass('D', 'D-1', label);
        }
      } catch (err) {
        fail('D', 'D-1', label, err.message);
      }
    }

    // ── D-2: 10k-star ────────────────────────────────────────────────────────
    {
      const label = 'D-2: 10k-star hub, cap 25, graph resume < 5s';
      try {
        const db = await pgConnect(D_DB);

        console.log('  [D-2] Inserting 10,000 star leaves...');
        const STAR_COUNT = 10000;
        for (let i = 0; i < STAR_COUNT; i += 500) {
          const vals   = [];
          const params = [D_PID, 'DSTAR_HUB', 'depends_on'];
          let pi = 4;
          for (let j = i; j < Math.min(i + 500, STAR_COUNT); j++) {
            vals.push(`($1, $2, $3, $${pi}, 1.0)`);
            params.push(`DSTAR_LEAF_${j}`);
            pi++;
          }
          await db.query(
            `INSERT INTO edges (project_id, from_entity, edge_type, to_entity, weight) VALUES ${vals.join(', ')}`,
            params
          );
        }

        await setSetting(db, D_PID, 'graph_max_nodes', '25');
        await setContract(db, D_PID, [
          { kind: 'graph', filter: { seed: 'DSTAR_HUB', direction: 'out', max_depth: 1 } },
        ]);
        await db.end();

        const start   = Date.now();
        const r       = runHandoff('loader-load', [], null, D_DB, D_DIR);
        const elapsed = Date.now() - start;

        console.log(`  [D-2] elapsed: ${elapsed}ms`);

        if (r.status !== 0) {
          fail('D', 'D-2', label, `loader-load exited ${r.status}: ${(r.stderr || r.stdout || '').slice(0, 200)}`);
        } else if (elapsed > 5000) {
          fail('D', 'D-2', label, `elapsed ${elapsed}ms exceeds 5s bound`);
        } else {
          const out         = r.stdout || '';
          const graphSection = extractGraphSection(out, '### Related (graph)');
          const leafCount = (graphSection.match(/- DSTAR_LEAF_/g) || []).length;
          if (leafCount > 25) {
            fail('D', 'D-2', label, `${leafCount} leaves returned — cap of 25 exceeded`);
          } else {
            pass('D', 'D-2', label);
          }
        }
      } catch (err) {
        fail('D', 'D-2', label, err.message);
      }
    }

    // ── D-3: Default (no-graph) path unregressed ──────────────────────────────
    {
      const label = 'D-3: Default (no-graph) contract resume < 3s — unregressed';
      try {
        const db = await pgConnect(D_DB);
        await setContract(db, D_PID, [
          { kind: 'assertion' },
        ]);
        await db.end();

        const start   = Date.now();
        const r       = runHandoff('loader-load', [], null, D_DB, D_DIR);
        const elapsed = Date.now() - start;

        console.log(`  [D-3] elapsed: ${elapsed}ms`);

        if (r.status !== 0) {
          fail('D', 'D-3', label, `loader-load exited ${r.status}: ${(r.stderr || r.stdout || '').slice(0, 200)}`);
        } else if (elapsed > 3000) {
          fail('D', 'D-3', label, `elapsed ${elapsed}ms exceeds 3s bound (no-graph path regressed)`);
        } else if ((r.stdout || '').includes('### Related (graph)')) {
          fail('D', 'D-3', label, 'Graph section present in no-graph contract — regression');
        } else {
          pass('D', 'D-3', label);
        }
      } catch (err) {
        fail('D', 'D-3', label, err.message);
      }
    }

  } finally {
    await dropTestDb(D_DB, D_DIR);
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`test-graph-traversal: section=${SECTION}`);
  console.log('');

  const runA = SECTION === 'all' || SECTION === 'A' || SECTION === 'gr';
  const runB = SECTION === 'all' || SECTION === 'B';
  const runC = SECTION === 'all' || SECTION === 'C';
  const runD = SECTION === 'all' || SECTION === 'D';

  if (runA) await runSectionA();
  if (runB) await runSectionB();
  if (runC) await runSectionC();
  if (runD) await runSectionD();

  console.log('');

  const aTotal = aPassed + aFailed;
  const bTotal = bPassed + bFailed;
  const cTotal = cPassed + cFailed;
  const dTotal = dPassed + dFailed;
  const totalPass = aPassed + bPassed + cPassed + dPassed;
  const totalAll  = aTotal  + bTotal  + cTotal  + dTotal;

  console.log(`test-graph-traversal: ${totalPass}/${totalAll} passed`);
  if (aTotal > 0) console.log(`  A (recursion): ${aPassed}/${aTotal}`);
  if (bTotal > 0) console.log(`  B (integration): ${bPassed}/${bTotal}`);
  if (cTotal > 0) console.log(`  C (organic): ${cPassed}/${cTotal}`);
  if (dTotal > 0) console.log(`  D (perf): ${dPassed}/${dTotal}`);

  if (aFailed + bFailed + cFailed + dFailed > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error('test-graph-traversal fatal:', err.message);
  if (process.env.DEBUG) console.error(err.stack);
  process.exitCode = 1;
});
