'use strict';

/**
 * mcp-db-connect.js — §8 direct-pg connection resolution for handoff-mcp.mjs
 * (CONSOLIDATION-RUNBOOK.md §8, memory-manager#18).
 *
 * The existing 5 handoff-mcp.mjs tools never open a Postgres connection
 * in-process — every tool spawns `node scripts/handoff.js <sub>` as a child
 * process with PROJECT_ROOT set in the CHILD's env (see handoff-mcp.mjs's
 * own header comment). That pattern is safe for concurrent/differing
 * projectRoots because each child process gets its OWN env — nothing is
 * shared across calls.
 *
 * The new §8 direct-pg tools (memory_search, memory_upsert, entity/
 * assertion/edge CRUD, memory_view_*, etc.) need a live `db` handle
 * in-process (no child-process round trip) so a single MCP tool call can run
 * a transaction (M-5's supersede-in-one-transaction, M-18's routing_profile_
 * set transaction). handoff.js's own connectHandoff()/loadConfig() resolve
 * their target DB from `findProjectRoot()`, which reads
 * process.env.PROJECT_ROOT (or falls back to process.cwd()) ONCE, at module
 * load / call time — appropriate for a short-lived CLI process but NOT safe
 * to reuse as-is inside a long-lived MCP server that may serve tool calls
 * for DIFFERENT projectRoots. Mutating process.env.PROJECT_ROOT per call
 * would work for a single in-flight call but races under overlapping
 * concurrent calls (a real MCP client can pipeline tool calls without
 * waiting for a reply).
 *
 * This module is the fix: an explicit, `root`-parameterized re-derivation
 * of loadConfig()'s pipeline.yml-reading logic (scripts/lib/shared.js) and
 * handoff.js's own TARGET_DB resolution order (HANDOFF_DB env > pipeline.yml
 * `knowledge.database` > built-in default) — NEVER touching process.env or
 * process.cwd(). This is a deliberate, narrow duplication of ~20 lines of
 * YAML-section parsing (not a refactor of shared.js/handoff.js's own
 * module-load-time resolution, which several existing call sites depend on
 * byte-for-byte) — flagged here and in the PR body as a resolved design
 * choice, not an oversight.
 *
 * Returns a connected PostgresAdapter (scripts/lib/db-seam.js) — the SAME
 * StoragePort shape ensureProjectIdentity() (scripts/lib/project-identity.js)
 * requires, and its `.query(sql, params)` forwards directly to the
 * underlying pg Client, so every existing lib function written against a
 * "plain pg Client or Pool" (route-resolve.js, usage-telemetry.js,
 * exchange-log.js, memory-upsert.js, memory-lint.js) accepts it unchanged.
 */

const fs = require('fs');
const path = require('path');

const { createAdapter } = require('./db-seam');

const DB_NAME_RE = /^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/;

/**
 * Sanitize a project name into the same pipeline_<name> convention
 * shared.js:projectToDbName uses, for the built-in-default fallback path.
 */
function projectToDbName(projectName) {
  const sanitized = String(projectName || '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '');
  return `pipeline_${sanitized}`;
}

/**
 * Re-derivation of shared.js:loadConfig(), parameterized by an explicit
 * `root` instead of findProjectRoot()/process.cwd(). Never reads
 * process.env.PROJECT_ROOT.
 *
 * @param {string} root — absolute project root path
 * @returns {{host:string, port:number, database:string, user:string, root:string}}
 */
function loadConfigForRoot(root) {
  const configPath = path.join(root, '.claude', 'pipeline.yml');
  const projectName = path.basename(root);
  const defaults = {
    host: 'localhost', port: 5432,
    database: projectToDbName(projectName), user: 'postgres',
  };

  if (!fs.existsSync(configPath)) {
    return { ...defaults, root };
  }
  const content = fs.readFileSync(configPath, 'utf8');

  const getSection = (section) => {
    const match = content.match(new RegExp(`^${section}:.*\\r?\\n((?:[ \\t]+.*\\r?\\n?)*)`, 'm'));
    return match ? match[1] : '';
  };
  const getInSection = (section, key) => {
    const sectionContent = getSection(section);
    const match = sectionContent.match(new RegExp(`^\\s*${key}:\\s*"?([^"\\n]+)"?`, 'm'));
    return match ? match[1].trim() : null;
  };

  const host = getInSection('knowledge', 'host') || defaults.host;
  const port = parseInt(getInSection('knowledge', 'port') || defaults.port, 10);
  const database = getInSection('knowledge', 'database') || defaults.database;
  const user = getInSection('knowledge', 'user') || defaults.user;

  return { host, port, database, user, root };
}

/**
 * Mirrors handoff.js's TARGET_DB resolution order EXACTLY:
 *   1. process.env.HANDOFF_DB (a global MCP-server-process override — same
 *      semantics as handoff.js's own module-load-time read; this is a
 *      deliberate global, not per-project, since it is how every existing
 *      caller of handoff.js already treats it)
 *   2. loadConfigForRoot(root).database (.claude/pipeline.yml)
 *   3. 'claude_memory_eval_test' built-in default
 *
 * @param {string} root
 * @returns {{name: string, source: string}}
 */
function resolveTargetDbForRoot(root) {
  if (process.env.HANDOFF_DB) {
    return { name: process.env.HANDOFF_DB, source: 'HANDOFF_DB env var' };
  }
  let cfg = null;
  try {
    cfg = loadConfigForRoot(root);
  } catch (_) {
    // fall through to built-in default
  }
  if (cfg && cfg.database) {
    return { name: cfg.database, source: '.claude/pipeline.yml' };
  }
  return { name: 'claude_memory_eval_test', source: 'built-in default' };
}

/**
 * Connect a fresh PostgresAdapter for the given projectRoot. Caller owns the
 * connection lifecycle — always `.end()` it (a `finally` at the tool-handler
 * call site).
 *
 * @param {string} root — absolute project root path
 * @returns {Promise<import('./db-seam').PostgresAdapter>}
 */
async function connectForRoot(root) {
  const cfg = loadConfigForRoot(root);
  const { name: database, source } = resolveTargetDbForRoot(root);
  if (!DB_NAME_RE.test(database)) {
    throw new Error(`mcp-db-connect: invalid database name "${database}" (from ${source})`);
  }
  return createAdapter('postgres', { host: cfg.host, port: cfg.port, database, user: cfg.user });
}

module.exports = {
  DB_NAME_RE,
  projectToDbName,
  loadConfigForRoot,
  resolveTargetDbForRoot,
  connectForRoot,
};
