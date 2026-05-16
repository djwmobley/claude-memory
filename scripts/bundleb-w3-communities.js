'use strict';

/**
 * bundleb-w3-communities.js — Bundle B Workstream 3
 *
 * Standalone driver for Leiden community detection over the entity/edge graph
 * for a project. Populates the entity_communities table with community membership
 * assignments produced by scripts/leiden_communities.py (via Python subprocess).
 *
 * GATING (all layers — every exit is 0 / non-fatal):
 *   W3_SKIP=1        → immediate no-op exit 0.
 *   python3 absent   → clear message, exit 0 (CI Node-only stays green).
 *   deps missing     → actionable install message, exit 0 (non-fatal).
 *   no graph         → no-op message, exit 0.
 *   any other error  → logged, exit 0 (W3 is optional infra).
 *
 * Cluster detection is a full no-op when entity_communities has no rows for the
 * project — the loader's cluster-aware expansion block guarantees byte-identical
 * pre-W3 loader output (no regression; CI/no-Python stays green).
 *
 * Usage:
 *   node scripts/bundleb-w3-communities.js [--limit N] [--dry-run]
 *
 * Flags:
 *   --limit N    Process at most N nodes (useful for ops/testing; default: all).
 *   --dry-run    Compute communities and print summary; do not write to DB.
 *
 * Environment:
 *   W3_SKIP=1        Skip all computation — clean no-op exit 0.
 *   HANDOFF_DB       Override the target database name (default: claude_memory_eval_test).
 *   PROJECT_ROOT     Override project root detection.
 *
 * Exit codes: 0 always (W3 is optional infra — never blocks anything).
 *
 * Exports (for tests): buildGraphPayload
 */

const path        = require('path');
const { spawnSync } = require('child_process');
const { Client }  = require('pg');

const { loadConfig, findProjectRoot } = require('./lib/shared');
const { encodeCwd }                   = require('./lib/encoded-cwd');

// ─── CONSTANTS ────────────────────────────────────────────────────────────────

const PYTHON_SCRIPT = path.join(__dirname, 'leiden_communities.py');

// ─── HELPERS ─────────────────────────────────────────────────────────────────

/** Resolve project_id for the current working directory (mirrors handoff.js). */
function resolveProjectId() {
  const root = findProjectRoot();
  return encodeCwd(root);
}

/** Connect to the handoff target DB using config from .claude/pipeline.yml. */
async function connectDb(targetDb) {
  const cfg = loadConfig();
  const client = new Client({
    host:     cfg.host,
    port:     cfg.port,
    database: targetDb,
    user:     cfg.user,
  });
  await client.connect();
  return client;
}

/**
 * Detect the Python 3 interpreter name ('python3' or 'python').
 * Returns the interpreter name string, or null if neither is found.
 *
 * @returns {string|null}
 */
function detectPython() {
  for (const candidate of ['python3', 'python']) {
    const r = spawnSync(candidate, ['--version'], { encoding: 'utf8', timeout: 5000 });
    if (r.status === 0 || r.stdout || r.stderr) {
      // Either candidate reported a version — confirm it is Python 3.
      const versionOutput = (r.stdout || '') + (r.stderr || '');
      if (versionOutput.includes('Python 3')) {
        return candidate;
      }
    }
  }
  return null;
}

/**
 * Build the {nodes, edges} graph payload from entity/edge DB rows.
 *
 * @param {string[]} nodeNames   - List of entity name strings.
 * @param {Array<{from_entity:string, to_entity:string, weight:number}>} edgeRows
 * @returns {{ nodes: string[], edges: Array<[string, string, number]> }}
 */
function buildGraphPayload(nodeNames, edgeRows) {
  const nodeSet = new Set(nodeNames);
  const edges = [];
  for (const row of edgeRows) {
    // Only include edges where both endpoints are in the node set.
    if (nodeSet.has(row.from_entity) && nodeSet.has(row.to_entity)) {
      edges.push([row.from_entity, row.to_entity, row.weight || 1.0]);
    }
  }
  return { nodes: nodeNames, edges };
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────

async function main() {
  // ── Gate 1: W3_SKIP ──────────────────────────────────────────────────────
  if (process.env.W3_SKIP === '1') {
    console.log('[w3-communities] W3_SKIP=1 — no-op');
    process.exit(0);
  }

  // ── Gate 2: Python 3 detection ───────────────────────────────────────────
  const pythonBin = detectPython();
  if (!pythonBin) {
    console.log('[w3-communities] python3 not found — skipping community detection (no-op)');
    console.log('  To enable: ensure python3 is on PATH, then: pip install leidenalg python-igraph');
    process.exit(0);
  }

  // ── Parse CLI args ────────────────────────────────────────────────────────
  const args    = process.argv.slice(2);
  const limitIdx = args.indexOf('--limit');
  const limit   = limitIdx !== -1 ? parseInt(args[limitIdx + 1], 10) : null;
  const dryRun  = args.includes('--dry-run');

  // ── Connect to DB ─────────────────────────────────────────────────────────
  const TARGET_DB = process.env.HANDOFF_DB || 'claude_memory_eval_test';
  let db;
  try {
    db = await connectDb(TARGET_DB);
  } catch (err) {
    console.log(`[w3-communities] DB connection failed — skipping (${err.message})`);
    process.exit(0);
  }

  let projectId;
  try {
    projectId = resolveProjectId();
  } catch (err) {
    console.log(`[w3-communities] project_id resolution failed — skipping (${err.message})`);
    await db.end();
    process.exit(0);
  }

  // ── Load graph data ───────────────────────────────────────────────────────
  let nodeRows;
  let edgeRows;
  try {
    const entityQ = limit !== null
      ? `SELECT name FROM entities WHERE project_id = $1 ORDER BY created_at DESC LIMIT ${limit}`
      : `SELECT name FROM entities WHERE project_id = $1 ORDER BY created_at DESC`;
    const eRes = await db.query(entityQ, [projectId]);
    nodeRows = eRes.rows;

    const edgeQ = `SELECT from_entity, to_entity, weight FROM edges WHERE project_id = $1`;
    const edgeRes = await db.query(edgeQ, [projectId]);
    edgeRows = edgeRes.rows;
  } catch (err) {
    console.log(`[w3-communities] DB query failed — skipping (${err.message})`);
    await db.end();
    process.exit(0);
  }

  const nodeNames = nodeRows.map((r) => r.name);

  // ── Gate 3: empty graph ───────────────────────────────────────────────────
  if (nodeNames.length < 2 || edgeRows.length === 0) {
    console.log(`[w3-communities] no graph to cluster (nodes=${nodeNames.length}, edges=${edgeRows.length}) — no-op`);
    await db.end();
    process.exit(0);
  }

  // ── Build payload and invoke Python ──────────────────────────────────────
  const payload = buildGraphPayload(nodeNames, edgeRows);
  const payloadJson = JSON.stringify(payload);

  const pyResult = spawnSync(pythonBin, [PYTHON_SCRIPT], {
    input:    payloadJson,
    encoding: 'utf8',
    timeout:  120000,
  });

  // ── Gate 4: deps missing (Python exit 3) ─────────────────────────────────
  if (pyResult.status === 3) {
    console.log('[w3-communities] leidenalg/python-igraph not installed — skipping (no-op)');
    console.log('  Install: pip install leidenalg python-igraph');
    await db.end();
    process.exit(0);
  }

  // ── Gate 5: any other Python failure ─────────────────────────────────────
  if (pyResult.status !== 0) {
    console.log(`[w3-communities] Python script failed (exit ${pyResult.status}) — skipping (non-fatal)`);
    if (pyResult.stderr) console.log(`  stderr: ${pyResult.stderr.slice(0, 500)}`);
    await db.end();
    process.exit(0);
  }

  // ── Parse Python output ───────────────────────────────────────────────────
  let communityMap;
  try {
    communityMap = JSON.parse(pyResult.stdout);
  } catch (err) {
    console.log(`[w3-communities] failed to parse Python output — skipping (non-fatal): ${err.message}`);
    await db.end();
    process.exit(0);
  }

  const entries = Object.entries(communityMap);
  if (entries.length === 0) {
    console.log('[w3-communities] no community assignments returned — no-op');
    await db.end();
    process.exit(0);
  }

  // Count distinct communities for summary.
  const communityCount = new Set(Object.values(communityMap)).size;

  // ── Dry run: print and exit ───────────────────────────────────────────────
  if (dryRun) {
    console.log(`[w3-communities] dry-run: ${entries.length} nodes, ${communityCount} communities`);
    for (const [name, cid] of entries) {
      console.log(`  ${name} -> community ${cid}`);
    }
    await db.end();
    process.exit(0);
  }

  // ── Insert entity_communities rows ────────────────────────────────────────
  const runId = new Date().toISOString();
  let inserted = 0;
  for (const [entityName, communityId] of entries) {
    try {
      await db.query(
        `INSERT INTO entity_communities (project_id, entity_name, community_id, level, run_id)
         VALUES ($1, $2, $3, 0, $4)`,
        [projectId, entityName, communityId, runId]
      );
      inserted++;
    } catch (err) {
      // Row-level failure is non-fatal — log and continue.
      console.log(`[w3-communities] insert failed for '${entityName}': ${err.message}`);
    }
  }

  await db.end();

  console.log(`[w3-communities] done: ${inserted} nodes, ${communityCount} communities, run_id=${runId}`);
  process.exit(0);
}

if (require.main === module) {
  main().catch((err) => {
    console.log(`[w3-communities] unexpected error — skipping (non-fatal): ${err.message}`);
    process.exit(0);
  });
}

module.exports = { buildGraphPayload };
