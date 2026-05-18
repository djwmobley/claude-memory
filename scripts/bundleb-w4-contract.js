'use strict';

/**
 * bundleb-w4-contract.js — Bundle B Workstream 4
 *
 * CLI for inspecting and rolling back the versioned retrieval_contract.
 *
 * Usage:
 *   node scripts/bundleb-w4-contract.js list [name=default]
 *   node scripts/bundleb-w4-contract.js show <version> [name=default]
 *   node scripts/bundleb-w4-contract.js rollback <version> [name=default]
 *   node scripts/bundleb-w4-contract.js diff <vA> <vB> [name=default]
 *
 * Subcommands:
 *   list      Print history rows (version, changed_at, change_note, query-count),
 *             ordered by version ascending.
 *   show      Print the queries JSON for a specific version (pretty-printed).
 *   rollback  Non-destructively set the live contract to a prior version's queries.
 *             This creates a NEW history row (preserves all prior history). Exits 1
 *             if the requested version does not exist.
 *   diff      Textual line-diff of the query arrays for two versions.
 *             No external dependencies — uses a simple line-based diff.
 *
 * Environment:
 *   HANDOFF_DB   Override target database name (default: claude_memory_eval_test).
 *   PROJECT_ROOT Override project root detection.
 *
 * Exit codes:
 *   0  success (all read-only subcommands; rollback on success)
 *   1  error (version not found, DB error, usage error)
 *   2  usage error (missing required argument)
 *
 * Exports (for tests): queriesEqual
 */

const path  = require('path');
const { Client } = require('pg');

const { loadConfig, findProjectRoot } = require('./lib/shared');
const { encodeCwd }                   = require('./lib/encoded-cwd');
const { queriesEqual, recordContractChange } = require('./handoff');
const {
  findProjectRootByMarker,
  readMarker,
} = require('./lib/project-marker');

// ─── CONSTANTS ────────────────────────────────────────────────────────────────

const _rawTargetDb = process.env.HANDOFF_DB || 'claude_memory_eval_test';
const _DB_NAME_RE  = /^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/;
if (!_DB_NAME_RE.test(_rawTargetDb)) {
  process.stderr.write(
    `Invalid HANDOFF_DB value "${_rawTargetDb}" — must match /^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/.\n`
  );
  process.exit(1);
}
const TARGET_DB = _rawTargetDb;

// ─── HELPERS ─────────────────────────────────────────────────────────────────

/**
 * Resolve project_id for the current working directory.
 * Mirrors the resolution logic in handoff.js: check for a .claude-memory marker
 * first (UUID-based identity), fall back to encodeCwd(root) for legacy projects.
 */
function resolveProjectId() {
  const startDir = process.env.PROJECT_ROOT || process.cwd();
  const markerRoot = findProjectRootByMarker(startDir);
  if (markerRoot) {
    const marker = readMarker(markerRoot);
    if (marker) return marker.uuid;
  }
  const root = findProjectRoot();
  return encodeCwd(root);
}

/** Connect to the handoff target DB. */
async function connectDb() {
  const cfg = loadConfig();
  const client = new Client({
    host:     cfg.host,
    port:     cfg.port,
    database: TARGET_DB,
    user:     cfg.user,
  });
  await client.connect();
  return client;
}

/**
 * Simple line-based diff of two strings.
 * Returns an array of diff-line strings (prefixed with +, -, or ' ').
 *
 * @param {string} textA
 * @param {string} textB
 * @returns {string[]}
 */
function lineDiff(textA, textB) {
  const linesA = textA.split('\n');
  const linesB = textB.split('\n');

  // Build a simple patience-style LCS using a hash map.
  // For clarity in output, fall back to a straightforward approach:
  // mark lines unique to A as removed, unique to B as added, shared as context.
  const setA = new Map();
  const setB = new Map();
  for (const [i, line] of linesA.entries()) {
    if (!setA.has(line)) setA.set(line, []);
    setA.get(line).push(i);
  }
  for (const [i, line] of linesB.entries()) {
    if (!setB.has(line)) setB.set(line, []);
    setB.get(line).push(i);
  }

  // Simple two-pointer walk producing output lines.
  const result = [];
  let ia = 0;
  let ib = 0;

  while (ia < linesA.length || ib < linesB.length) {
    const la = linesA[ia];
    const lb = linesB[ib];

    if (ia >= linesA.length) {
      result.push(`+ ${lb}`);
      ib++;
    } else if (ib >= linesB.length) {
      result.push(`- ${la}`);
      ia++;
    } else if (la === lb) {
      result.push(`  ${la}`);
      ia++;
      ib++;
    } else if (!setB.has(la)) {
      result.push(`- ${la}`);
      ia++;
    } else if (!setA.has(lb)) {
      result.push(`+ ${lb}`);
      ib++;
    } else {
      // Both lines appear in both arrays — advance both to avoid stalls.
      result.push(`- ${la}`);
      result.push(`+ ${lb}`);
      ia++;
      ib++;
    }
  }

  return result;
}

// ─── SUBCOMMAND IMPLEMENTATIONS ───────────────────────────────────────────────

/**
 * list — print history rows ordered by version.
 *
 * @param {object} db
 * @param {string} projectId
 * @param {string} name
 */
async function cmdList(db, projectId, name) {
  const { rows } = await db.query(
    `SELECT version, changed_at, change_note, queries
     FROM retrieval_contract_history
     WHERE project_id = $1 AND name = $2
     ORDER BY version ASC`,
    [projectId, name]
  );

  if (rows.length === 0) {
    console.log(`No history rows found for contract name="${name}" in project "${projectId}".`);
    console.log('Hint: run "node scripts/handoff.js init" to create a baseline history row.');
    return;
  }

  console.log(`Contract history for name="${name}"  (project: ${projectId})\n`);
  console.log(
    'VERSION'.padEnd(9) +
    'CHANGED_AT'.padEnd(28) +
    'QUERY_COUNT'.padEnd(13) +
    'CHANGE_NOTE'
  );
  console.log('-'.repeat(80));

  for (const row of rows) {
    const queries    = (row.queries && row.queries.queries) ? row.queries.queries : [];
    const qCount     = String(queries.length).padEnd(13);
    const ver        = String(row.version).padEnd(9);
    const ts         = (row.changed_at ? new Date(row.changed_at).toISOString() : '').padEnd(28);
    const note       = row.change_note || '(none)';
    console.log(`${ver}${ts}${qCount}${note}`);
  }
}

/**
 * show — pretty-print the queries JSON for a specific version.
 *
 * @param {object} db
 * @param {string} projectId
 * @param {string} name
 * @param {number} version
 */
async function cmdShow(db, projectId, name, version) {
  const { rows } = await db.query(
    `SELECT queries FROM retrieval_contract_history
     WHERE project_id = $1 AND name = $2 AND version = $3`,
    [projectId, name, version]
  );

  if (rows.length === 0) {
    console.error(`Error: version ${version} not found for contract name="${name}".`);
    process.exitCode = 1;
    return;
  }

  console.log(JSON.stringify(rows[0].queries, null, 2));
}

/**
 * rollback — set the live contract to a prior version's queries (non-destructive).
 *
 * Creates a new history row with change_note `rollback to v<version>`.
 * Exits 1 if the version does not exist.
 *
 * @param {object} db
 * @param {string} projectId
 * @param {string} name
 * @param {number} version
 */
async function cmdRollback(db, projectId, name, version) {
  const { rows } = await db.query(
    `SELECT queries FROM retrieval_contract_history
     WHERE project_id = $1 AND name = $2 AND version = $3`,
    [projectId, name, version]
  );

  if (rows.length === 0) {
    console.error(`Error: version ${version} not found for contract name="${name}" — rollback refused.`);
    console.error(`Run "node scripts/bundleb-w4-contract.js list" to see available versions.`);
    process.exitCode = 1;
    return;
  }

  const targetQueries = rows[0].queries;
  const changeNote    = `rollback to v${version}`;

  await recordContractChange(db, projectId, name, targetQueries, changeNote);

  // Print the new live version.
  const { rows: rcRows } = await db.query(
    `SELECT version FROM retrieval_contract WHERE project_id = $1 AND name = $2`,
    [projectId, name]
  );
  const newVersion = rcRows.length > 0 ? rcRows[0].version : '?';
  console.log(`Rolled back to v${version} queries. Live contract is now v${newVersion} (history preserved).`);
}

/**
 * diff — textual line-diff of two versions' query arrays.
 *
 * @param {object} db
 * @param {string} projectId
 * @param {string} name
 * @param {number} vA
 * @param {number} vB
 */
async function cmdDiff(db, projectId, name, vA, vB) {
  const { rows } = await db.query(
    `SELECT version, queries FROM retrieval_contract_history
     WHERE project_id = $1 AND name = $2 AND version = ANY($3::int[])`,
    [projectId, name, [vA, vB]]
  );

  const byVersion = {};
  for (const row of rows) {
    byVersion[row.version] = row.queries;
  }

  if (!byVersion[vA]) {
    console.error(`Error: version ${vA} not found for contract name="${name}".`);
    process.exitCode = 1;
    return;
  }
  if (!byVersion[vB]) {
    console.error(`Error: version ${vB} not found for contract name="${name}".`);
    process.exitCode = 1;
    return;
  }

  const textA = JSON.stringify(byVersion[vA].queries || byVersion[vA], null, 2);
  const textB = JSON.stringify(byVersion[vB].queries || byVersion[vB], null, 2);

  console.log(`--- v${vA}`);
  console.log(`+++ v${vB}`);
  console.log('');

  const diffLines = lineDiff(textA, textB);
  for (const line of diffLines) {
    console.log(line);
  }

  if (diffLines.every((l) => l.startsWith('  '))) {
    console.log('(no differences)');
  }
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const sub  = args[0];

  if (!sub || sub === '--help' || sub === '-h') {
    console.log([
      'Usage: node scripts/bundleb-w4-contract.js <subcommand> [args]',
      '',
      'Subcommands:',
      '  list [name=default]            Print contract history (version, changed_at, query-count, note)',
      '  show <version> [name=default]  Print queries JSON for a specific version',
      '  rollback <version> [name=default]  Non-destructive rollback (creates new version)',
      '  diff <vA> <vB> [name=default]  Textual diff of two versions\' query arrays',
      '',
      'Environment:',
      '  HANDOFF_DB    Override target DB (default: claude_memory_eval_test)',
      '  PROJECT_ROOT  Override project root detection',
    ].join('\n'));
    process.exitCode = sub ? 0 : 2;
    return;
  }

  const projectId = resolveProjectId();
  let db;
  try {
    db = await connectDb();
  } catch (err) {
    console.error(`DB connection failed: ${err.message}`);
    process.exitCode = 1;
    return;
  }

  try {
    if (sub === 'list') {
      const name = args[1] || 'default';
      await cmdList(db, projectId, name);

    } else if (sub === 'show') {
      const version = parseInt(args[1], 10);
      if (isNaN(version)) {
        console.error('Usage: bundleb-w4-contract.js show <version> [name=default]');
        process.exitCode = 2;
        return;
      }
      const name = args[2] || 'default';
      await cmdShow(db, projectId, name, version);

    } else if (sub === 'rollback') {
      const version = parseInt(args[1], 10);
      if (isNaN(version)) {
        console.error('Usage: bundleb-w4-contract.js rollback <version> [name=default]');
        process.exitCode = 2;
        return;
      }
      const name = args[2] || 'default';
      await cmdRollback(db, projectId, name, version);

    } else if (sub === 'diff') {
      const vA = parseInt(args[1], 10);
      const vB = parseInt(args[2], 10);
      if (isNaN(vA) || isNaN(vB)) {
        console.error('Usage: bundleb-w4-contract.js diff <vA> <vB> [name=default]');
        process.exitCode = 2;
        return;
      }
      const name = args[3] || 'default';
      await cmdDiff(db, projectId, name, vA, vB);

    } else {
      console.error(`Unknown subcommand: "${sub}"`);
      console.error('Valid subcommands: list, show, rollback, diff');
      process.exitCode = 2;
    }
  } finally {
    try { await db.end(); } catch (_) {}
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`bundleb-w4-contract error: ${err.message}`);
    if (process.env.DEBUG) console.error(err.stack);
    process.exitCode = 1;
  });
}

// ─── EXPORTS (for tests) ─────────────────────────────────────────────────────
module.exports = { queriesEqual };
