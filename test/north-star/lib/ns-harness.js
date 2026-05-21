'use strict';

/**
 * ns-harness.js — Shared scaffold for the north-star test suite.
 *
 * The north-star suite defends three system goals:
 *   (1) lossless fidelity   — no prior plan/work lost across sessions;
 *   (2) lean, decay-ranked default resume that minimizes bootstrap token spend;
 *   (3) resurrection on demand — pull a since-devalued topic back via a query.
 *
 * Load-bearing premise: the information that drives the next session must live
 * in Postgres as queryable rows, NOT in markdown prose. The handoff.md file is
 * a thin pointer. The system currently violates this — payload.tldr /
 * open_threads / quick_references are written ONLY into the handoff.md body,
 * never persisted as queryable PG rows. The sibling test files encode the
 * RED-by-construction tests that prove that gap.
 *
 * This file provides NEUTRAL primitives only. It asserts NOTHING about whether
 * the system is broken — the RED lives in the sibling files. The one thing this
 * file *does* guarantee is that preflight() passes on a healthy environment so
 * that a sibling-file failure is attributable to the system under test, not the
 * scaffold.
 *
 * Every API used here was verified against live code (scripts/handoff.js,
 * scripts/lib/shared.js, scripts/lib/project-marker.js, scripts/sql/*.sql,
 * scripts/bench-handoff.js, test/handoff/test-handoff.js). See the report
 * accompanying this file for the file:line citations.
 *
 * CommonJS, matching the repo style. Exit codes mirror test-handoff.js:
 *   0 = all-pass, 1 = any failure, 2 = infrastructure error.
 */

const assert = require('assert');
const path   = require('path');
const fs     = require('fs');
const os     = require('os');
const http   = require('http');
const { execFileSync } = require('child_process');

// scripts/lib/shared.js exports loadConfig (verified: shared.js:732).
const { loadConfig } = require('../../../scripts/lib/shared');
// project-marker.js exports writeMarker/readMarker/resolveMarkerUUID/MARKER_FILENAME
// (verified: project-marker.js:152-159).
const { writeMarker } = require('../../../scripts/lib/project-marker');

// pg lives in scripts/node_modules — use createRequire anchored to
// scripts/package.json so the import is portable across any pnpm/npm/yarn
// layout (hoisted or symlink-store). This is the exact pattern used by
// test/handoff/test-handoff.js:32-34.
const { createRequire } = require('module');
const scriptsRequire = createRequire(require.resolve('../../../scripts/package.json'));
const { Client }     = scriptsRequire('pg');

// ─── CONFIG ─────────────────────────────────────────────────────────────────

// The eval/test database. Both the harness and handoff.js resolve to this name
// in test (handoff.js:100 built-in default; test-handoff.js:38). The handoff.js
// subprocess reads it from the fake-root pipeline.yml we write in setupNs().
const TARGET_DB = 'claude_memory_eval_test';

// Absolute path to the helper. Mirrors test-handoff.js:39.
const HELPER = path.resolve(__dirname, '..', '..', '..', 'scripts', 'handoff.js');

// vLLM embeddings endpoint (verified: shared.js:336 default 'http://localhost:8800').
const VLLM_BASE = process.env.VLLM_EMBED_URL || 'http://localhost:8800';

// ─── TEST RUNNER (re-exposed from test-handoff.js:44-68) ──────────────────────
//
// Module-level pass/fail counters. Sibling files import { test, run } and the
// counters are shared across all tests within a single node process.

let passed = 0;
let failed = 0;

/**
 * Run one test. Supports sync and async (Promise-returning) fns. Always returns
 * a Promise so the caller can `await` it. Copied verbatim from
 * test-handoff.js:47-68 so sibling files get identical PASS/FAIL semantics.
 *
 * @param {string}   label - human-readable test name.
 * @param {Function} fn    - test body; throw (or reject) to fail.
 * @returns {Promise<void>}
 */
function test(label, fn) {
  try {
    const result = fn();
    if (result && typeof result.then === 'function') {
      return result.then(() => {
        console.log(`PASS  ${label}`);
        passed++;
      }).catch((err) => {
        console.error(`FAIL  ${label}`);
        console.error(`      ${err.message}`);
        failed++;
      });
    }
    console.log(`PASS  ${label}`);
    passed++;
  } catch (err) {
    console.error(`FAIL  ${label}`);
    console.error(`      ${err.message}`);
    failed++;
  }
  return Promise.resolve();
}

/**
 * Run a tests-defining async function, then emit the summary and exit with the
 * conventional code. Mirrors the run epilogue at test-handoff.js:1104-1117.
 *
 *   0 = all tests passed
 *   1 = one or more tests failed
 *   2 = infrastructure error (thrown out of testsFn, e.g. DB unreachable)
 *
 * A SKIP signal (the object returned by preflight when a required dependency is
 * down) is the caller's responsibility to honor — see preflight() docs. If a
 * sibling file decides to skip, it should print a SKIP line and `return` from
 * testsFn before defining vLLM-dependent tests; run() then exits 0 with whatever
 * non-skipped tests passed.
 *
 * @param {Function} testsFn - async fn that defines and awaits tests.
 * @returns {Promise<void>}
 */
function run(testsFn) {
  return Promise.resolve()
    .then(() => testsFn())
    .then(() => {
      console.log('');
      if (failed > 0) {
        console.error(`${passed} passed, ${failed} FAILED.`);
        process.exit(1);
      } else {
        console.log(`All ${passed} test(s) passed.`);
        process.exit(0);
      }
    })
    .catch((err) => {
      console.error(`\nInfrastructure error: ${err.message}`);
      if (process.env.DEBUG) console.error(err.stack);
      process.exit(2);
    });
}

// ─── DB CONNECT ───────────────────────────────────────────────────────────────

/**
 * Connect a raw pg Client to claude_memory_eval_test. Host/port/user come from
 * loadConfig() (the worktree's .claude/pipeline.yml or its defaults), but the
 * database is forced to TARGET_DB. Mirrors test-handoff.js:70-80.
 *
 * @returns {Promise<import('pg').Client>}
 */
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

// ─── SCHEMA APPLY ─────────────────────────────────────────────────────────────

// Schema files, applied in this order. Verified: test-handoff.js:176 applies
// handoff-core-schema.sql THEN app-retrieval-events-schema.sql, stripping psql
// meta-commands. handoff-core gives entities/assertions/edges/retrieval_contract/
// project_settings; app-retrieval-events gives retrieval_events +
// retrieval_event_assertions.
const SCHEMA_FILES = ['handoff-core-schema.sql', 'app-retrieval-events-schema.sql'];

/**
 * Apply both canonical schemas idempotently against an open client. Strips psql
 * meta-commands (lines beginning with a backslash) so the JS client can run the
 * SQL. "already exists" errors are swallowed. Verified: test-handoff.js:175-190.
 *
 * @param {import('pg').Client} db
 */
async function applySchemas(db) {
  const sqlDir = path.resolve(__dirname, '..', '..', '..', 'scripts', 'sql');
  for (const schemaName of SCHEMA_FILES) {
    const schemaFile = path.join(sqlDir, schemaName);
    if (!fs.existsSync(schemaFile)) continue;
    let sql = fs.readFileSync(schemaFile, 'utf8');
    // Strip psql meta-commands (e.g. \c, \echo) — same regex as test-handoff.js:181.
    sql = sql.replace(/^\\[a-z].*$/gm, '');
    try {
      await db.query(sql);
    } catch (err) {
      if (!err.message.includes('already exists')) {
        console.warn(`  Schema apply warning (${schemaName}): ${err.message}`);
      }
    }
  }
}

// ─── SETUP / TEARDOWN ─────────────────────────────────────────────────────────

/**
 * Provision an isolated test environment for one sibling file.
 *
 * Creates a UNIQUE fake project root, pre-mints its .claude-memory marker so
 * handoff.js resolves a stable, isolated project_id (UUID) for this namespace,
 * applies both schemas, and returns the connected db plus a cleanup() closure.
 *
 * The marker pre-mint is the lesson from test-handoff.js:142-149: without it,
 * ensureProjectIdentity() auto-mints a UUID at the first helper invocation and
 * DB rows go to that UUID while a test that looked up encodeCwd(root) would miss
 * them. Pre-minting aligns every helper read/write to a known UUID.
 *
 * Each sibling file calls setupNs with a distinct `namespace` so that when CI
 * runs the files sequentially against the same DB they do not contaminate each
 * other's rows. The namespace is embedded in the temp-dir prefix only — project
 * isolation is by UUID, which is unique per setupNs call regardless.
 *
 * @param {object} [opts]
 * @param {string} [opts.namespace='ns'] - short tag, used in the temp dir name.
 * @returns {Promise<{ db: import('pg').Client, fakeRoot: string,
 *                      projectId: string, cleanup: () => Promise<void> }>}
 */
async function setupNs(opts = {}) {
  const namespace = (opts.namespace || 'ns').replace(/[^a-zA-Z0-9_-]/g, '');

  // Unique fake project root for this namespace.
  const fakeRoot = fs.mkdtempSync(path.join(os.tmpdir(), `ns-${namespace}-`));

  // .git so findProjectRoot() (shared.js:42-50) stops here.
  fs.mkdirSync(path.join(fakeRoot, '.git'));

  // .claude/pipeline.yml so loadConfig() (shared.js:63-118) resolves DB config.
  // handoff.js reads `database` from here (knowledge.database) and uses it as
  // TARGET_DB (handoff.js:91-95). Same shape as test-handoff.js:125-135.
  fs.mkdirSync(path.join(fakeRoot, '.claude'));
  fs.writeFileSync(
    path.join(fakeRoot, '.claude', 'pipeline.yml'),
    [
      'project:',
      `  name: ns-${namespace}`,
      '',
      'knowledge:',
      '  tier: "postgres"',
      '  host: "localhost"',
      '  port: 5432',
      `  database: "${TARGET_DB}"`,
      '  user: "postgres"',
    ].join('\n'),
    'utf8'
  );

  // Pre-mint the .claude-memory marker → stable, isolated project_id (UUID).
  // writeMarker throws if a marker already exists; the temp dir is fresh so it
  // never does (project-marker.js:108-125).
  const marker    = writeMarker(fakeRoot);
  const projectId = marker.uuid;

  // Connect and apply schemas.
  let db;
  try {
    db = await connectDb();
  } catch (err) {
    // Mirror test-handoff.js:159-163 — DB unreachable is an infra error (exit 2
    // when surfaced through run()).
    const e = new Error(
      `cannot connect to ${TARGET_DB}: ${err.message} ` +
      `(create it with: psql -U postgres -c "CREATE DATABASE ${TARGET_DB};")`
    );
    e.infra = true;
    throw e;
  }
  await applySchemas(db);

  /**
   * Delete every row this project_id wrote, then remove the temp root and the
   * ~/.claude/projects/<UUID>/ dir where handoff.md lives. Best-effort; never
   * throws. Closes the db connection it was given via setupNs's returned client
   * is the caller's job — cleanup opens its OWN short-lived connection so it
   * works even after the caller has called db.end().
   */
  async function cleanup() {
    // Tables that carry a project_id and may receive rows during a close.
    const tables = [
      'edges', 'assertions', 'entities',
      'retrieval_contract', 'retrieval_contract_history',
      'project_settings', 'entity_communities', 'extraction_queue',
      'retrieval_events',
    ];
    let cdb;
    try {
      cdb = await connectDb();
      for (const tbl of tables) {
        try {
          await cdb.query(`DELETE FROM ${tbl} WHERE project_id = $1`, [projectId]);
        } catch (_) { /* table may not exist in this DB — ignore */ }
      }
      // retrieval_event_assertions has no project_id column; its rows cascade on
      // retrieval_events delete (FK ON DELETE CASCADE — app-retrieval-events-schema.sql:58).
    } catch (_) {
      /* best-effort */
    } finally {
      if (cdb) { try { await cdb.end(); } catch (_) {} }
    }

    // Remove the fake project root.
    try { fs.rmSync(fakeRoot, { recursive: true, force: true }); } catch (_) {}

    // Remove ~/.claude/projects/<UUID>/ where handoff.md actually lives
    // (resolveHandoffMdPath — handoff.js:210-213).
    try {
      const dir = path.join(os.homedir(), '.claude', 'projects', projectId);
      if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
    } catch (_) {}
  }

  return { db, fakeRoot, projectId, cleanup };
}

// ─── SUBPROCESS DRIVERS ───────────────────────────────────────────────────────

/**
 * Build the env handoff.js subprocesses run with. PROJECT_ROOT pins root
 * resolution to the fake root (shared.js:43, handoff.js:200); the marker we
 * pre-minted there yields the isolated project_id.
 */
function helperEnv(fakeRoot) {
  return {
    ...process.env,
    PROJECT_ROOT: fakeRoot,
  };
}

/**
 * Invoke `node scripts/handoff.js close --json -`, passing the JSON payload via
 * the child's stdin (execFileSync `input` option) — NOT a shell heredoc, NOT a
 * tempfile arg. Verified: cmdClose reads `--json -` and calls readStdin()
 * (handoff.js:3726-3731, readStdin at :976-1091). Returns combined stdout.
 *
 * Allowed payload top-level keys (readStdin ALLOWED_KEYS, handoff.js:994-999):
 *   tldr, open_threads, quick_references, entities, assertions, edges,
 *   decisions, contract, session_id, confirm_claude_md_promotion,
 *   retrieval_outcome, retrieval_outcome_notes.
 *
 * @param {string} fakeRoot - project root (the one returned by setupNs).
 * @param {object} payload  - close payload object (will be JSON.stringify'd).
 * @returns {string} stdout text.
 */
function runClose(fakeRoot, payload) {
  return execFileSync(
    process.execPath,
    [HELPER, 'close', '--json', '-'],
    {
      cwd:      fakeRoot,
      env:      helperEnv(fakeRoot),
      encoding: 'utf8',
      timeout:  60000,
      input:    JSON.stringify(payload),
    }
  );
}

/**
 * Invoke `node scripts/handoff.js resume`. Returns the full served stdout, which
 * contains (verified handoff.js:2727-2774):
 *   - the OPERATING_CANON block (always first),
 *   - "=== BEGIN RETRIEVED CONTEXT (untrusted) ===" wrapper when anything was
 *     retrieved, containing "=== Handoff context ===" (the handoff.md body) and
 *     optionally "=== Retrieved context (contract: <name>) ===",
 *   - a trailing "  tokens used: ~N / M" line (handoff.js:2769),
 *   - and the "Done: handoff:resume — ..." summary line (handoff.js:2940).
 *
 * @param {string} fakeRoot
 * @returns {string} stdout text.
 */
function runResume(fakeRoot) {
  return execFileSync(
    process.execPath,
    [HELPER, 'resume'],
    {
      cwd:      fakeRoot,
      env:      helperEnv(fakeRoot),
      encoding: 'utf8',
      timeout:  60000,
    }
  );
}

/**
 * Invoke `node scripts/handoff.js resurrect <topic> [flags]`.
 *
 * VERIFIED real CLI signature (cmdResurrect, handoff.js:5002-5107; USAGE block
 * at :5022-5034):
 *   node scripts/handoff.js resurrect <topic> [--revive|-r] [--limit=N]
 *     <topic>      first non-flag arg(s), joined by spaces — required.
 *     --revive,-r  un-suppress matching probationary rows (default: dry-run).
 *     --limit=N    cap candidate subject set size (default 20).
 * Dry-run prints "### Resurrected (preview — dry-run)"; with --revive prints
 * "### Resurrected (revived)". No matches → "No matching probationary rows ...".
 *
 * @param {string}  fakeRoot
 * @param {string}  topic            - seed text.
 * @param {object}  [opts]
 * @param {boolean} [opts.revive=false] - pass --revive.
 * @param {number}  [opts.limit]        - pass --limit=N.
 * @returns {string} stdout text.
 */
function runResurrect(fakeRoot, topic, opts = {}) {
  const args = [HELPER, 'resurrect', topic];
  if (opts.revive) args.push('--revive');
  if (opts.limit != null) args.push(`--limit=${opts.limit}`);
  return execFileSync(
    process.execPath,
    args,
    {
      cwd:      fakeRoot,
      env:      helperEnv(fakeRoot),
      encoding: 'utf8',
      timeout:  60000,
    }
  );
}

// ─── HANDOFF.MD PRIMITIVES ─────────────────────────────────────────────────────

/**
 * Resolve the handoff.md path for a project_id. Verified: handoff.js:210-213 —
 * ~/.claude/projects/<projectId>/handoff.md (projectId is the marker UUID).
 *
 * @param {string} projectId
 * @returns {string} absolute path.
 */
function handoffMdPath(projectId) {
  return path.join(os.homedir(), '.claude', 'projects', projectId, 'handoff.md');
}

/**
 * Read the handoff.md file for a project_id. Returns '' if it does not exist.
 *
 * @param {string} projectId
 * @returns {string}
 */
function readHandoffMd(projectId) {
  const p = handoffMdPath(projectId);
  if (!fs.existsSync(p)) return '';
  return fs.readFileSync(p, 'utf8');
}

// A handoff.md starts with a YAML frontmatter block delimited by --- ... ---
// (template: templates/handoff.md.tpl:1-9). The same regex handoff.js uses to
// strip frontmatter when serving the body on resume (handoff.js:2734):
//   raw.replace(/^---[\s\S]*?---\r?\n/, '')
const FRONTMATTER_RE = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/;

/**
 * Split a handoff.md into { frontmatter, body }. frontmatter includes the
 * delimiters; body is everything after. If there is no frontmatter, frontmatter
 * is '' and body is the whole text.
 *
 * @param {string} text
 * @returns {{ frontmatter: string, body: string }}
 */
function splitHandoffMd(text) {
  const m = text.match(FRONTMATTER_RE);
  if (!m) return { frontmatter: '', body: text };
  return { frontmatter: m[0], body: text.slice(m[0].length) };
}

/**
 * Rewrite a project's handoff.md keeping ONLY the YAML frontmatter and emptying
 * the markdown body. This is the cornerstone primitive: a sibling test calls it,
 * then runResume(), then asserts the session-driving intent still surfaces from
 * PG (it currently does NOT — that is the RED). The frontmatter is preserved so
 * that loader frontmatter reads (last_close, contract — handoff.js:2804,
 * readHandoffFrontmatter:216-238) still behave; only the prose body is removed.
 *
 * No-op-safe: if the file is missing, does nothing and returns false.
 *
 * @param {string} projectId
 * @returns {boolean} true if a file was rewritten, false if none existed.
 */
function blankHandoffMdBody(projectId) {
  const p = handoffMdPath(projectId);
  if (!fs.existsSync(p)) return false;
  const text = fs.readFileSync(p, 'utf8');
  const { frontmatter } = splitHandoffMd(text);
  // Keep frontmatter exactly; replace the body with a single trailing newline.
  const next = frontmatter.endsWith('\n') ? frontmatter + '\n' : frontmatter + '\n\n';
  fs.writeFileSync(p, next, 'utf8');
  return true;
}

/**
 * Byte length of the handoff.md body (everything after the frontmatter),
 * trimmed. Used by assertMdThinPointer.
 *
 * @param {string} projectId
 * @returns {number} byte length of the trimmed body.
 */
function handoffMdBodyBytes(projectId) {
  const text = readHandoffMd(projectId);
  if (!text) return 0;
  const { body } = splitHandoffMd(text);
  return Buffer.byteLength(body.trim(), 'utf8');
}

// ─── DB QUERY HELPERS ──────────────────────────────────────────────────────────

/**
 * Query assertions for a project, with optional subject/predicate/object
 * filters. By default suppressed rows are EXCLUDED (the retrieval default —
 * handoff.js read paths filter suppressed=false). Pass includeSuppressed=true to
 * see every row regardless of suppressed/invalid_at state.
 *
 * Columns (handoff-core-schema.sql:67-258): id, project_id, subject, predicate,
 * object, confidence, source, suppressed, suppression_kind, tier, pinned,
 * valid_at, invalid_at, created_at, session_id, ...
 *
 * @param {import('pg').Client} db
 * @param {string} projectId
 * @param {object} [filter]
 * @param {string} [filter.subject]
 * @param {string} [filter.predicate]
 * @param {string} [filter.object]
 * @param {boolean} [filter.includeSuppressed=false]
 * @returns {Promise<object[]>} rows.
 */
async function queryAssertions(db, projectId, filter = {}) {
  const where  = ['project_id = $1'];
  const params = [projectId];
  let i = 2;
  if (filter.subject   != null) { where.push(`subject = $${i++}`);   params.push(filter.subject); }
  if (filter.predicate != null) { where.push(`predicate = $${i++}`); params.push(filter.predicate); }
  if (filter.object    != null) { where.push(`object = $${i++}`);    params.push(filter.object); }
  if (!filter.includeSuppressed) {
    where.push('suppressed = false');
    where.push('invalid_at IS NULL');
  }
  const { rows } = await db.query(
    `SELECT * FROM assertions WHERE ${where.join(' AND ')} ORDER BY id`,
    params
  );
  return rows;
}

/**
 * Query entities for a project. Columns (handoff-core-schema.sql:25-34):
 * id, project_id, name, entity_type, description, created_at, session_id.
 *
 * @param {import('pg').Client} db
 * @param {string} projectId
 * @param {object} [filter]
 * @param {string} [filter.name]
 * @param {string} [filter.entity_type]
 * @returns {Promise<object[]>} rows.
 */
async function queryEntities(db, projectId, filter = {}) {
  const where  = ['project_id = $1'];
  const params = [projectId];
  let i = 2;
  if (filter.name        != null) { where.push(`name = $${i++}`);        params.push(filter.name); }
  if (filter.entity_type != null) { where.push(`entity_type = $${i++}`); params.push(filter.entity_type); }
  const { rows } = await db.query(
    `SELECT * FROM entities WHERE ${where.join(' AND ')} ORDER BY id`,
    params
  );
  return rows;
}

/**
 * Query edges for a project. Columns (handoff-core-schema.sql:363-372):
 * id, project_id, from_entity, edge_type, to_entity, weight, created_at,
 * session_id.
 *
 * @param {import('pg').Client} db
 * @param {string} projectId
 * @param {object} [filter]
 * @param {string} [filter.from_entity]
 * @param {string} [filter.to_entity]
 * @param {string} [filter.edge_type]
 * @returns {Promise<object[]>} rows.
 */
async function queryEdges(db, projectId, filter = {}) {
  const where  = ['project_id = $1'];
  const params = [projectId];
  let i = 2;
  if (filter.from_entity != null) { where.push(`from_entity = $${i++}`); params.push(filter.from_entity); }
  if (filter.to_entity   != null) { where.push(`to_entity = $${i++}`);   params.push(filter.to_entity); }
  if (filter.edge_type   != null) { where.push(`edge_type = $${i++}`);   params.push(filter.edge_type); }
  const { rows } = await db.query(
    `SELECT * FROM edges WHERE ${where.join(' AND ')} ORDER BY id`,
    params
  );
  return rows;
}

// ─── TOKEN HELPERS ──────────────────────────────────────────────────────────────

/**
 * Token estimate convention used throughout handoff.js: Math.ceil(text.length/4)
 * (e.g. handoff.js:2711). Provided so sibling files use the SAME convention as
 * the engine when reasoning about budgets.
 *
 * @param {string} text
 * @returns {number}
 */
function estimateTokens(text) {
  return Math.ceil(String(text || '').length / 4);
}

/**
 * Parse the "tokens used: ~N / M" line out of resume/loader stdout. Returns the
 * N (tokens used) as an integer, or null if absent. Same parse as
 * bench-handoff.js:69 (/tokens used:\s*~?(\d+)/).
 *
 * @param {string} stdout
 * @returns {number|null}
 */
function parseTokensUsed(stdout) {
  const m = String(stdout || '').match(/tokens used:\s*~?(\d+)/);
  return m ? parseInt(m[1], 10) : null;
}

// ─── ASSERTION HELPERS ───────────────────────────────────────────────────────────
//
// Each throws on failure with a message naming the north-star reason. They make
// NO claim that the system is broken — they are neutral checks the sibling files
// compose into RED-by-construction assertions.

/**
 * Normalize an items arg to an array of non-empty strings.
 */
function asItemList(items) {
  if (items == null) return [];
  return (Array.isArray(items) ? items : [items])
    .map((s) => String(s))
    .filter((s) => s.length > 0);
}

/**
 * Assert that every item in `items` appears (substring) in servedText.
 *
 * @param {string} servedText - e.g. runResume() output.
 * @param {string|string[]} items - strings that must all surface.
 * @param {string} [msg] - context prefix for the failure message.
 */
function assertSurfaced(servedText, items, msg) {
  const text = String(servedText || '');
  const missing = asItemList(items).filter((it) => !text.includes(it));
  assert.strictEqual(
    missing.length, 0,
    `${msg || 'assertSurfaced'}: expected to surface in served context but did NOT: ` +
    `${JSON.stringify(missing)} — north-star (1) lossless fidelity: session-driving ` +
    `intent must survive into the next session's served context.`
  );
}

/**
 * Assert that NONE of `items` appear in servedText.
 *
 * @param {string} servedText
 * @param {string|string[]} items
 * @param {string} [msg]
 */
function assertNotSurfaced(servedText, items, msg) {
  const text = String(servedText || '');
  const present = asItemList(items).filter((it) => text.includes(it));
  assert.strictEqual(
    present.length, 0,
    `${msg || 'assertNotSurfaced'}: expected NOT to surface but did: ` +
    `${JSON.stringify(present)}.`
  );
}

/**
 * Assert that the handoff.md BODY (excluding frontmatter), trimmed, is <=
 * maxBytes. Encodes north-star premise (the handoff.md is a thin pointer; the
 * session-driving payload lives in PG rows, not prose).
 *
 * @param {string} projectId
 * @param {number} maxBytes
 * @param {string} [msg]
 */
function assertMdThinPointer(projectId, maxBytes, msg) {
  const bytes = handoffMdBodyBytes(projectId);
  assert.ok(
    bytes <= maxBytes,
    `${msg || 'assertMdThinPointer'}: handoff.md body is ${bytes} bytes (> ${maxBytes}) — ` +
    `north-star premise: handoff.md must be a THIN POINTER; the session-driving payload ` +
    `belongs in queryable PG rows, not markdown prose.`
  );
}

/**
 * Assert that the "tokens used: ~N" reported by a resume/loader stdout is <=
 * budget. Encodes north-star (2) lean default resume.
 *
 * @param {string} stdout
 * @param {number} budget
 * @param {string} [msg]
 */
function assertWithinBudget(stdout, budget, msg) {
  const used = parseTokensUsed(stdout);
  assert.notStrictEqual(
    used, null,
    `${msg || 'assertWithinBudget'}: could not find a "tokens used: ~N" line in stdout — ` +
    `cannot evaluate the lean-resume budget.`
  );
  assert.ok(
    used <= budget,
    `${msg || 'assertWithinBudget'}: resume used ~${used} tokens (> budget ${budget}) — ` +
    `north-star (2): default resume must be lean and decay-ranked.`
  );
}

/**
 * Assert that at least one LIVE (not suppressed, not invalidated) assertion row
 * exists for this project with the given predicate. This is the queryable-PG-row
 * check the suite is built around: it asks "did the session-driving fact land as
 * a queryable row?" — distinct from "is it mentioned in prose".
 *
 * @param {import('pg').Client} db
 * @param {string} projectId
 * @param {string} predicate
 * @param {string} [msg]
 */
async function assertHasQueryablePredicate(db, projectId, predicate, msg) {
  const rows = await queryAssertions(db, projectId, { predicate });
  assert.ok(
    rows.length > 0,
    `${msg || 'assertHasQueryablePredicate'}: no live assertion row with predicate ` +
    `"${predicate}" for project ${projectId} — north-star premise: the information that ` +
    `drives the next session must live in Postgres as queryable rows.`
  );
}

// ─── ENVIRONMENT PREFLIGHT ──────────────────────────────────────────────────────

/**
 * Probe whether vLLM embeddings are reachable at VLLM_BASE. Verified default
 * endpoint shared.js:336 ('http://localhost:8800'); we probe /v1/models which
 * the OpenAI-compatible server exposes. Resolves true/false; never throws.
 *
 * @param {number} [timeoutMs=1500]
 * @returns {Promise<boolean>}
 */
function vllmUp(timeoutMs = 1500) {
  return new Promise((resolve) => {
    let url;
    try {
      url = new URL('/v1/models', VLLM_BASE);
    } catch (_) {
      return resolve(false);
    }
    const req = http.request(
      {
        hostname: url.hostname,
        port:     url.port || 80,
        path:     url.pathname,
        method:   'GET',
        timeout:  timeoutMs,
      },
      (res) => {
        // Any HTTP response means the server is up.
        res.resume();
        resolve(res.statusCode != null && res.statusCode < 500);
      }
    );
    req.on('error',   () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.end();
  });
}

/**
 * Verify the environment is healthy enough to run the suite. MUST pass on a
 * healthy box. Checks:
 *   - DB reachable (claude_memory_eval_test);
 *   - both schemas applied — probes for the `assertions` and `retrieval_events`
 *     tables (the two load-bearing tables from the two schema files);
 *   - if needVllm: vLLM reachable. If vLLM is needed but DOWN, returns a SKIP
 *     signal { skip: true, reason } instead of hard-failing, so CI without vLLM
 *     can skip semantic arms.
 *
 * On a hard infrastructure failure (DB unreachable / schemas missing) throws an
 * Error with `.infra = true` so a caller running through run() exits 2.
 *
 * @param {object}  [opts]
 * @param {boolean} [opts.needVllm=false]
 * @returns {Promise<{ ok: true } | { skip: true, reason: string }>}
 */
async function preflight(opts = {}) {
  const needVllm = !!opts.needVllm;

  let db;
  try {
    db = await connectDb();
  } catch (err) {
    const e = new Error(
      `preflight: DB unreachable (${TARGET_DB}): ${err.message} — ` +
      `create it with: psql -U postgres -c "CREATE DATABASE ${TARGET_DB};"`
    );
    e.infra = true;
    throw e;
  }

  try {
    // Apply schemas first (idempotent) so a fresh DB still passes preflight.
    await applySchemas(db);

    // Probe the two load-bearing tables.
    for (const tbl of ['assertions', 'retrieval_events']) {
      const { rows } = await db.query(
        `SELECT to_regclass($1) AS reg`,
        [tbl]
      );
      if (!rows[0] || rows[0].reg == null) {
        const e = new Error(
          `preflight: required table "${tbl}" missing after schema apply — ` +
          `schema files did not apply cleanly.`
        );
        e.infra = true;
        throw e;
      }
    }
  } finally {
    try { await db.end(); } catch (_) {}
  }

  if (needVllm) {
    const up = await vllmUp();
    if (!up) {
      return {
        skip:   true,
        reason: `vLLM not reachable at ${VLLM_BASE} — skipping semantic arm. ` +
                `Start it (e.g. ~/start-vllm-040.sh, port 8800) to run this file.`,
      };
    }
  }

  return { ok: true };
}

// ─── FIXTURES LOADER ─────────────────────────────────────────────────────────────

/**
 * Recursively strip keys whose name begins with an underscore. Fixture files use
 * leading-underscore keys (e.g. "_doc") to self-document; readStdin rejects any
 * unknown top-level key (handoff.js:1000-1003), so they MUST be stripped before
 * a fixture is handed to runClose. Strips at the top level and inside any
 * "sessions" array elements (the multi-session shape). Non-mutating.
 *
 * @param {object} obj
 * @returns {object}
 */
function stripUnderscoreKeys(obj) {
  if (Array.isArray(obj)) return obj.map(stripUnderscoreKeys);
  if (obj === null || typeof obj !== 'object') return obj;
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (k.startsWith('_')) continue;
    out[k] = stripUnderscoreKeys(v);
  }
  return out;
}

/**
 * Load a fixture by name from test/north-star/fixtures/. Accepts a bare name
 * ('single-session') or a filename ('single-session.json'). Returns the parsed
 * object with leading-underscore documentation keys stripped (so the result is
 * directly close-payload-valid). For the multi-session fixture the returned
 * object has a `sessions` array of close-ready payloads. Throws if not found.
 *
 * @param {string} name
 * @returns {object}
 */
function loadFixture(name) {
  const file = name.endsWith('.json') ? name : `${name}.json`;
  const p = path.resolve(__dirname, '..', 'fixtures', file);
  if (!fs.existsSync(p)) {
    throw new Error(`loadFixture: fixture not found: ${p}`);
  }
  return stripUnderscoreKeys(JSON.parse(fs.readFileSync(p, 'utf8')));
}

// ─── EXPORTS ─────────────────────────────────────────────────────────────────────

module.exports = {
  // test runner
  test,
  run,
  // setup / lifecycle
  setupNs,
  connectDb,
  applySchemas,
  // subprocess drivers
  runClose,
  runResume,
  runResurrect,
  // handoff.md primitives
  readHandoffMd,
  blankHandoffMdBody,
  handoffMdPath,
  splitHandoffMd,
  handoffMdBodyBytes,
  // db queries
  queryAssertions,
  queryEntities,
  queryEdges,
  // token helpers
  estimateTokens,
  parseTokensUsed,
  // assertion helpers
  assertSurfaced,
  assertNotSurfaced,
  assertMdThinPointer,
  assertWithinBudget,
  assertHasQueryablePredicate,
  // preflight
  preflight,
  vllmUp,
  // fixtures
  loadFixture,
  stripUnderscoreKeys,
  // constants
  TARGET_DB,
  HELPER,
};

// ─── SELF-CHECK ────────────────────────────────────────────────────────────────
//
// `node test/north-star/lib/ns-harness.js` runs setupNs + preflight + a no-op
// close/resume round-trip and prints OK. Confirms the scaffold itself works.
// Exits 0 on success, 2 on infrastructure failure.

if (require.main === module) {
  (async () => {
    console.log('ns-harness self-check: starting');

    // 1. preflight (DB-only; vLLM not required for the self-check).
    const pf = await preflight({ needVllm: false });
    if (pf.skip) {
      console.log(`ns-harness self-check: SKIP (${pf.reason})`);
      process.exit(0);
    }
    console.log('ns-harness self-check: preflight OK');

    // 2. setupNs.
    const { db, fakeRoot, projectId, cleanup } = await setupNs({ namespace: 'selfcheck' });
    console.log(`ns-harness self-check: setupNs OK (projectId=${projectId})`);
    console.log(`ns-harness self-check: fakeRoot=${fakeRoot}`);

    try {
      // 3. no-op close round-trip — empty payload is a valid close.
      const closeOut = runClose(fakeRoot, {
        tldr: 'self-check round-trip',
        open_threads: [],
        quick_references: '(none)',
      });
      const closeOk = /Done: handoff:close/.test(closeOut);
      console.log(`ns-harness self-check: runClose ${closeOk ? 'OK' : 'UNEXPECTED OUTPUT'}`);

      // 4. handoff.md was written at the resolved path.
      const md = readHandoffMd(projectId);
      console.log(`ns-harness self-check: handoff.md ${md ? 'present' : 'MISSING'} ` +
                  `(${Buffer.byteLength(md, 'utf8')} bytes)`);

      // 5. resume round-trip — must surface the canon and a tokens-used line.
      const resumeOut = runResume(fakeRoot);
      const toks = parseTokensUsed(resumeOut);
      const resumeOk = /=== Handoff context ===/.test(resumeOut) && toks != null;
      console.log(`ns-harness self-check: runResume ${resumeOk ? 'OK' : 'UNEXPECTED OUTPUT'} ` +
                  `(tokens used ~${toks})`);

      // 6. blankHandoffMdBody primitive works.
      const blanked = blankHandoffMdBody(projectId);
      console.log(`ns-harness self-check: blankHandoffMdBody ${blanked ? 'OK' : 'NO-OP (no file)'}`);

      console.log('\nns-harness self-check: OK');
    } finally {
      try { await db.end(); } catch (_) {}
      await cleanup();
    }
    process.exit(0);
  })().catch((err) => {
    console.error(`\nns-harness self-check: FAILED — ${err.message}`);
    if (process.env.DEBUG) console.error(err.stack);
    process.exit(err && err.infra ? 2 : 1);
  });
}
