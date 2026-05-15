'use strict';

/**
 * handoff.js — Phase 3.5 /handoff skill helper.
 *
 * Subcommand router invoked by ~/.claude/commands/handoff/*.md slash-command
 * definition files. Heavy lifting (DB queries, file IO, JSON contract evaluation)
 * lives here; the Markdown files are thin recipes.
 *
 * Usage:
 *   node scripts/handoff.js <subcommand> [flags]
 *
 * Subcommands:
 *   init                    First-run provisioning for this project.
 *   status                  Read-only: show counts, last close, contract names.
 *   resume                  Inline SessionStart load (prints compact context summary).
 *   drop                    Zero all assertions, archive handoff.md, create fresh one.
 *   checkpoint --json -     Mid-session extraction (reads JSON from stdin).
 *   close      --json -     End-of-session extraction (reads JSON from stdin).
 *   purge      [--yes]      Hard-delete all project rows (requires confirmation or --yes).
 *   loader-load             Same inline load as resume; used directly or by tests.
 *   loader-hook             SessionStart hook entry point (outputs JSON to stdout).
 *
 * Environment:
 *   PROJECT_ROOT            Override project root detection.
 *   PGUSER / PGPASSWORD     Postgres credentials (standard env vars, picked up by pg).
 *
 * Exit codes: 0 success, 1 error, 2 usage.
 */

const fs    = require('fs');
const path  = require('path');
const os    = require('os');
const readline = require('readline');

const { loadConfig, connect, c, findProjectRoot } = require('./lib/shared');
const { encodeCwd, getClaudeProjectDir }           = require('./lib/encoded-cwd');

// ─── CONSTANTS ───────────────────────────────────────────────────────────────

const TARGET_DB = 'claude_memory_eval_test';
const HANDOFF_TEMPLATE = path.resolve(__dirname, '..', 'templates', 'handoff.md.tpl');
const PROJECT_CLAUDE_MD_TEMPLATE = path.resolve(__dirname, '..', 'templates', 'project-claude-md.tpl');

// ─── HELPERS ─────────────────────────────────────────────────────────────────

/** Connect to the handoff DB (always claude_memory_eval_test). */
async function connectHandoff() {
  const cfg = loadConfig();
  const { Client } = require('pg');
  const client = new Client({
    host:     cfg.host,
    port:     cfg.port,
    database: TARGET_DB,
    user:     cfg.user,
  });
  await client.connect();
  return client;
}

/** Resolve project_id for the current working directory. */
function resolveProjectId() {
  const root = findProjectRoot();
  return encodeCwd(root);
}

/** Resolve the ~/.claude/projects/<encoded_cwd>/handoff.md path. */
function resolveHandoffMdPath(projectId) {
  return path.join(os.homedir(), '.claude', 'projects', projectId, 'handoff.md');
}

/** Read handoff.md frontmatter as a plain object. Returns {} if missing. */
function readHandoffFrontmatter(handoffPath) {
  if (!fs.existsSync(handoffPath)) return {};
  const text = fs.readFileSync(handoffPath, 'utf8');
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return {};
  const fm = {};
  for (const line of match[1].split(/\r?\n/)) {
    const kv = line.match(/^(\w[\w_]*):\s*(.*)$/);
    if (!kv) continue;
    fm[kv[1]] = kv[2].trim();
  }
  // Parse session_summary sub-keys
  const ssMatch = match[1].match(/session_summary:\s*\n((?:[ \t]+.*\n?)*)/);
  if (ssMatch) {
    const ss = {};
    for (const line of ssMatch[1].split(/\r?\n/)) {
      const kv = line.match(/^\s+(\w[\w_]*):\s*(.*)$/);
      if (kv) ss[kv[1]] = kv[2].trim();
    }
    fm.session_summary = ss;
  }
  return fm;
}

/** Render a template file by replacing {{KEY}} placeholders. */
function renderTemplate(tplPath, vars) {
  let text = fs.readFileSync(tplPath, 'utf8');
  for (const [k, v] of Object.entries(vars)) {
    text = text.replace(new RegExp(`\\{\\{${k}\\}\\}`, 'g'), v);
  }
  return text;
}

/** Write handoff.md from the template. Creates parent dir if needed. */
function writeHandoffMd(handoffPath, vars) {
  fs.mkdirSync(path.dirname(handoffPath), { recursive: true });
  const content = renderTemplate(HANDOFF_TEMPLATE, vars);
  fs.writeFileSync(handoffPath, content, 'utf8');
}

/** Read JSON payload from stdin (used for --json - flag). */
function readStdin() {
  return new Promise((resolve, reject) => {
    const chunks = [];
    process.stdin.on('data', (d) => chunks.push(d));
    process.stdin.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (e) {
        reject(new Error(`Failed to parse JSON from stdin: ${e.message}`));
      }
    });
    process.stdin.on('error', reject);
  });
}

/** Days since an ISO timestamp string. Returns null if not parseable. */
function daysSince(isoStr) {
  if (!isoStr) return null;
  const d = new Date(isoStr);
  if (isNaN(d.getTime())) return null;
  return Math.floor((Date.now() - d.getTime()) / 86400000);
}

/** Get a project_settings value, with a fallback default. */
async function getSetting(db, projectId, key, defaultVal) {
  const { rows } = await db.query(
    'SELECT value FROM project_settings WHERE project_id = $1 AND key = $2',
    [projectId, key]
  );
  return rows.length > 0 ? rows[0].value : defaultVal;
}

/** Upsert a project_settings row. */
async function setSetting(db, projectId, key, value) {
  await db.query(
    `INSERT INTO project_settings (project_id, key, value) VALUES ($1, $2, $3)
     ON CONFLICT (project_id, key) DO UPDATE SET value = EXCLUDED.value`,
    [projectId, key, String(value)]
  );
}

// ─── INIT PRE-FLIGHT HELPERS ──────────────────────────────────────────────────

/** Check that Node.js is >= 18. Returns { ok, msg, fatal }. */
function checkNodeVersion() {
  const parts = process.versions.node.split('.').map(Number);
  const major = parts[0];
  if (major < 18) {
    return {
      ok: false,
      msg: `Node ${process.versions.node} detected — requires Node >= 18. Upgrade: https://nodejs.org`,
      fatal: true,
    };
  }
  return { ok: true, msg: `Node ${process.versions.node}`, fatal: false };
}

/** Check that the pg package is installed. Returns { ok, msg, fatal }. */
function checkPgPackage() {
  try {
    require('pg');
    return { ok: true, msg: 'pg package present', fatal: false };
  } catch (_) {
    return {
      ok: false,
      msg: 'pg package not installed — run: npm install (in scripts/)',
      fatal: true,
    };
  }
}

/** Check that Postgres is reachable on the system DB. Returns { ok, msg, fatal }. */
async function checkPostgresReachable(cfg) {
  const { Client } = require('pg');
  const client = new Client({
    host:     cfg.host,
    port:     cfg.port,
    database: 'postgres',  // system DB — always exists
    user:     cfg.user,
  });
  try {
    await client.connect();
    await client.end();
    return { ok: true, msg: `Postgres reachable at ${cfg.host}:${cfg.port}`, fatal: false };
  } catch (err) {
    return {
      ok: false,
      msg: `Postgres not reachable at ${cfg.host}:${cfg.port} — is it running? (${err.message})`,
      fatal: true,
    };
  }
}

/**
 * Check whether the target DB exists. If missing and autoCreate=true, create it.
 * If missing and autoCreate=false, prompt via readline (unless args includes -y).
 * Returns { ok, msg, fatal, created }.
 */
async function checkOrCreateDatabase(cfg, dbName, autoCreate) {
  const { Client } = require('pg');
  // Connect to system DB for pg_database check / CREATE DATABASE
  const sysClient = new Client({
    host:     cfg.host,
    port:     cfg.port,
    database: 'postgres',
    user:     cfg.user,
  });
  await sysClient.connect();
  const { rows } = await sysClient.query(
    'SELECT 1 FROM pg_database WHERE datname = $1',
    [dbName]
  );

  if (rows.length > 0) {
    await sysClient.end();
    return { ok: true, msg: `Database '${dbName}' exists`, fatal: false, created: false };
  }

  // DB does not exist — decide what to do
  if (autoCreate) {
    await sysClient.query(`CREATE DATABASE "${dbName}"`);
    await sysClient.end();
    return { ok: true, msg: `Database '${dbName}' created (auto)`, fatal: false, created: true };
  }

  // Prompt interactively
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise((resolve) => {
    rl.question(
      `\n  Database '${dbName}' does not exist. Create it? [y/N]: `,
      (a) => { rl.close(); resolve(a.trim()); }
    );
  });

  if (answer.toLowerCase() === 'y' || answer.toLowerCase() === 'yes') {
    await sysClient.query(`CREATE DATABASE "${dbName}"`);
    await sysClient.end();
    return { ok: true, msg: `Database '${dbName}' created`, fatal: false, created: true };
  }

  await sysClient.end();
  return {
    ok: false,
    msg: `Database '${dbName}' does not exist. Create it manually: psql -c "CREATE DATABASE ${dbName}"`,
    fatal: true,
    created: false,
  };
}

/** Check Postgres server version >= 13. Returns { ok, msg, fatal }. */
async function checkPgVersion(cfg, dbName) {
  const { Client } = require('pg');
  const client = new Client({
    host:     cfg.host,
    port:     cfg.port,
    database: dbName,
    user:     cfg.user,
  });
  try {
    await client.connect();
    const { rows } = await client.query('SHOW server_version_num');
    await client.end();
    const vnum = parseInt(rows[0].server_version_num, 10);
    // server_version_num is e.g. 140008 for 14.8
    const major = Math.floor(vnum / 10000);
    if (major < 13) {
      return {
        ok: false,
        msg: `Postgres ${major} detected — recommend >= 13 (version_num=${vnum})`,
        fatal: false,  // warn only
      };
    }
    return { ok: true, msg: `Postgres ${major} (version_num=${vnum})`, fatal: false };
  } catch (err) {
    // Non-fatal: version check failure does not block init
    return { ok: false, msg: `Could not check Postgres version: ${err.message}`, fatal: false };
  }
}

/** Print a single pre-flight result line. */
function printPreflightLine(result, stepDesc) {
  if (result.ok) {
    console.log(`  [OK]    ${stepDesc}: ${result.msg}`);
  } else if (!result.fatal) {
    console.log(`  [WARN]  ${stepDesc} — ${result.msg}`);
  } else {
    console.log(`  [FAIL]  ${stepDesc} — ${result.msg}`);
  }
}

// ─── SUBCOMMANDS ─────────────────────────────────────────────────────────────

// ── init ─────────────────────────────────────────────────────────────────────

async function cmdInit(args) {
  console.log('Running: handoff:init\n');

  const root        = findProjectRoot();
  const projectId   = encodeCwd(root);
  const handoffPath = resolveHandoffMdPath(projectId);
  const claudeMdPath = path.join(root, 'CLAUDE.md');
  const autoCreate  = args.includes('-y');

  // ── Pre-flight checks ─────────────────────────────────────────────────────

  // Step 1: Node version >= 18
  const nodeCheck = checkNodeVersion();
  printPreflightLine(nodeCheck, 'Node version >= 18');
  if (nodeCheck.fatal) { process.exit(1); }

  // Step 2: pg package installed
  const pgPkgCheck = checkPgPackage();
  printPreflightLine(pgPkgCheck, 'pg package installed');
  if (pgPkgCheck.fatal) { process.exit(1); }

  const cfg = loadConfig();

  // Step 3: Postgres reachable
  const pgReachCheck = await checkPostgresReachable(cfg);
  printPreflightLine(pgReachCheck, `Postgres reachable at ${cfg.host}:${cfg.port}`);
  if (pgReachCheck.fatal) { process.exit(1); }

  // Step 4: Target DB exists (create if needed)
  const dbCheck = await checkOrCreateDatabase(cfg, TARGET_DB, autoCreate);
  printPreflightLine(dbCheck, `Database '${TARGET_DB}' present`);
  if (dbCheck.fatal) { process.exit(1); }

  // Step 5: Postgres version >= 13 (warn only)
  const pgVerCheck = await checkPgVersion(cfg, TARGET_DB);
  printPreflightLine(pgVerCheck, 'Postgres version >= 13');
  // Not fatal — proceed regardless

  // Step 6: handoff-core-schema.sql present on disk
  const schemaFile = path.resolve(__dirname, 'sql', 'handoff-core-schema.sql');
  const schemaExists = fs.existsSync(schemaFile);
  if (schemaExists) {
    console.log(`  [OK]    Schema file present: ${path.basename(schemaFile)}`);
  } else {
    console.log(`  [FAIL]  Schema file missing: ${schemaFile}`);
    process.exit(1);
  }

  // Connect to target DB for the rest of init
  let db;
  try {
    const { Client } = require('pg');
    db = new Client({
      host:     cfg.host,
      port:     cfg.port,
      database: TARGET_DB,
      user:     cfg.user,
    });
    await db.connect();
  } catch (err) {
    console.log(`  [FAIL]  DB connection to '${TARGET_DB}' — ${err.message}`);
    process.exit(1);
  }

  // Step 7: Apply handoff-core-schema.sql inside a transaction (fatal on error)
  let sql = fs.readFileSync(schemaFile, 'utf8');
  // Remove psql meta-commands (\ir, \d, etc.) — not supported by pg client
  sql = sql.replace(/^\\[a-z].*$/gm, '');
  try {
    await db.query('BEGIN');
    await db.query(sql);
    await db.query('COMMIT');
    console.log(`  [OK]    Schema applied: ${path.basename(schemaFile)}`);
  } catch (err) {
    try { await db.query('ROLLBACK'); } catch (_) { /* ignore */ }
    await db.end();
    console.log(`  [FAIL]  Schema apply failed — ${err.message}`);
    console.log(`          Transaction rolled back. No FS writes made.`);
    process.exit(1);
  }

  // Step 8: Insert default project_settings rows (idempotent)
  const defaults = {
    staleness_days:      '7',
    loader_token_budget: '4000',
    implicit_close:      'enabled',
    decay_rate_default:  '0.05',
  };
  for (const [key, val] of Object.entries(defaults)) {
    await db.query(
      `INSERT INTO project_settings (project_id, key, value) VALUES ($1, $2, $3)
       ON CONFLICT (project_id, key) DO NOTHING`,
      [projectId, key, val]
    );
  }
  console.log(`  [OK]    project_settings defaults ensured (${Object.keys(defaults).length} keys, idempotent)`);

  // Step 9: Insert default retrieval_contract row
  await db.query(
    `INSERT INTO retrieval_contract (project_id, name, queries, updated_at)
     VALUES ($1, 'default', $2::jsonb, now())
     ON CONFLICT (project_id, name) DO NOTHING`,
    [projectId, JSON.stringify({ queries: [] })]
  );
  console.log(`  [OK]    retrieval_contract 'default' row ensured`);

  await db.end();

  // Step 10: Write handoff.md (only if all DB steps succeeded)
  if (fs.existsSync(handoffPath)) {
    console.log(`  [OK]    handoff.md already exists — skipped: ${handoffPath}`);
  } else {
    fs.mkdirSync(path.dirname(handoffPath), { recursive: true });
    writeHandoffMd(handoffPath, {
      PROJECT_ID:          projectId,
      LAST_CLOSE:          new Date().toISOString(),
      CONTRACT:            'default',
      ENTITIES_WRITTEN:    '0',
      ASSERTIONS_WRITTEN:  '0',
      EDGES_WRITTEN:       '0',
      PROJECT_NAME:        path.basename(root),
      TLDR:                '(init — no sessions closed yet)',
      OPEN_THREADS:        '- (none)',
      QUICK_REFERENCES:    '(none)',
    });
    console.log(`  [OK]    handoff.md created: ${handoffPath}`);
  }

  // Step 11: Write CLAUDE.md (only if all DB steps succeeded)
  if (fs.existsSync(claudeMdPath)) {
    console.log(`  [OK]    CLAUDE.md already exists — skipped: ${claudeMdPath}`);
  } else {
    const projectName = args.find((a) => !a.startsWith('-')) || path.basename(root);
    const projectDesc = `Memory and retrieval infrastructure project.`;
    const content = renderTemplate(PROJECT_CLAUDE_MD_TEMPLATE, {
      PROJECT_NAME:        projectName,
      PROJECT_DESCRIPTION: projectDesc,
      HANDOFF_MD_PATH:     handoffPath,
      PROJECT_ROOT:        root,
    });
    fs.writeFileSync(claudeMdPath, content, 'utf8');
    console.log(`  [OK]    CLAUDE.md created: ${claudeMdPath}`);
    console.log(`  [NOTE]  CLAUDE.md should be git-committed.`);
  }

  console.log(`\nDone: handoff:init — project ${projectId} provisioned`);
}

// ── status ────────────────────────────────────────────────────────────────────

async function cmdStatus() {
  console.log('Running: handoff:status');

  const projectId   = resolveProjectId();
  const handoffPath = resolveHandoffMdPath(projectId);
  const fm          = readHandoffFrontmatter(handoffPath);

  let db;
  try {
    db = await connectHandoff();
  } catch (err) {
    console.error(`DB connection failed: ${err.message}`);
    process.exit(1);
  }

  // Counts — sequential awaits because pg.Client is single-connection and rejects
  // concurrent queries on pg@9 (deprecation warning on pg@8). Pool would allow
  // concurrency, but these are four trivial COUNT/SELECT round-trips and serial
  // is plenty fast.
  const entRes = await db.query('SELECT COUNT(*) AS n FROM entities           WHERE project_id = $1', [projectId]);
  const assRes = await db.query('SELECT COUNT(*) AS n FROM assertions         WHERE project_id = $1', [projectId]);
  const edgRes = await db.query('SELECT COUNT(*) AS n FROM edges              WHERE project_id = $1', [projectId]);
  const rcRes  = await db.query('SELECT name        FROM retrieval_contract  WHERE project_id = $1 ORDER BY name', [projectId]);

  // Session-in-progress marker
  const sipRes = await db.query(
    "SELECT value FROM project_settings WHERE project_id = $1 AND key = 'session_in_progress'",
    [projectId]
  );

  await db.end();

  const lastClose = fm.last_close || 'never';
  const days      = daysSince(fm.last_close);
  const daysStr   = days !== null ? `${days} day(s) ago` : 'N/A';
  const contracts = rcRes.rows.map((r) => r.name).join(', ') || '(none)';
  const sip       = sipRes.rows.length > 0 ? sipRes.rows[0].value : null;

  console.log('\n  === handoff status ===');
  console.log(`  project_id:       ${projectId}`);
  console.log(`  last_close:       ${lastClose} (${daysStr})`);
  console.log(`  handoff.md:       ${fs.existsSync(handoffPath) ? handoffPath : '(missing)'}`);
  console.log(`  entities:         ${entRes.rows[0].n}`);
  console.log(`  assertions:       ${assRes.rows[0].n}`);
  console.log(`  edges:            ${edgRes.rows[0].n}`);
  console.log(`  contracts:        ${contracts}`);
  console.log(`  session_active:   ${sip ? `YES (session_id=${sip})` : 'no'}`);

  console.log(`\nDone: handoff:status — ${entRes.rows[0].n} entities, ${assRes.rows[0].n} assertions, ${edgRes.rows[0].n} edges`);
}

// ── loader-load (shared with resume and loader-hook) ─────────────────────────

/**
 * Core context-loading logic. Reads handoff.md and runs retrieval contract queries.
 *
 * @param {object} opts
 * @param {boolean} [opts.silent=false]  When true, suppress console.log output (hook mode).
 * @param {object}  [opts.db]            Pre-connected pg.Client (hook passes its own to avoid
 *                                       a second connect/disconnect cycle).
 * @returns {Promise<{
 *   outputText: string,
 *   tokensUsed: number,
 *   sectionsCount: number,
 *   entitiesCount: number,
 *   assertionsCount: number,
 *   vectorCount: number,
 *   contractName: string,
 *   lastClose: string|null,
 *   daysSinceClose: number|null,
 * }>}
 */
async function cmdLoaderLoad(opts = {}) {
  const silent = opts.silent === true;

  const projectId   = resolveProjectId();
  const handoffPath = resolveHandoffMdPath(projectId);
  const fm          = readHandoffFrontmatter(handoffPath);

  const lastClose     = fm.last_close || null;
  const daysSinceClose = daysSince(lastClose);

  // Use a caller-supplied DB connection when available (avoids double connect in hook path).
  let db = opts.db || null;
  let ownDb = false;
  if (!db) {
    try {
      db = await connectHandoff();
      ownDb = true;
    } catch (err) {
      console.error(`DB connection failed: ${err.message}`);
      process.exit(1);
    }
  }

  // Load retrieval_contract
  const contractName = fm.contract || 'default';
  const rcRes = await db.query(
    'SELECT queries FROM retrieval_contract WHERE project_id = $1 AND name = $2',
    [projectId, contractName]
  );
  const contract = rcRes.rows.length > 0 ? rcRes.rows[0].queries : { queries: [] };
  const queries  = contract.queries || [];

  const tokenBudget = parseInt(await getSetting(db, projectId, 'loader_token_budget', '4000'), 10);
  let tokensUsed     = 0;
  const sections     = [];

  // Per-type counters for the Done: line and hook output.
  let entitiesCount   = 0;
  let assertionsCount = 0;
  let vectorCount     = 0;

  for (const q of queries) {
    if (tokensUsed >= tokenBudget) break;

    if (q.type === 'entity' || q.kind === 'entity') {
      const { rows } = await db.query(
        `SELECT name, entity_type, description FROM entities
         WHERE project_id = $1 AND ($2::text IS NULL OR name = $2)
         ORDER BY created_at DESC LIMIT 20`,
        [projectId, q.filter?.name || null]
      );
      if (rows.length) {
        const text = rows.map((r) => `- ${r.name} (${r.entity_type}): ${r.description || ''}`).join('\n');
        sections.push(`### Entities\n${text}`);
        tokensUsed    += Math.ceil(text.length / 4);
        entitiesCount += rows.length;
      }

    } else if (q.type === 'assertion' || q.kind === 'assertion') {
      const { rows } = await db.query(
        `SELECT subject, predicate, object, confidence, source FROM assertions
         WHERE project_id = $1
           AND ($2::text IS NULL OR subject = $2)
           AND suppressed = false
           AND confidence * exp(-decay_rate * EXTRACT(EPOCH FROM (now() - last_reinforced)) / 86400) >= 1.0
         ORDER BY confidence DESC, last_reinforced DESC LIMIT 30`,
        [projectId, q.filter?.subject || null]
      );
      if (rows.length) {
        const text = rows.map((r) =>
          `- [${r.source}|conf=${r.confidence}] ${r.subject} ${r.predicate} ${r.object}`
        ).join('\n');
        sections.push(`### Assertions\n${text}`);
        tokensUsed      += Math.ceil(text.length / 4);
        assertionsCount += rows.length;
        // Bump reinforcement timestamps for every retrieved assertion (spec §7).
        await db.query(
          `UPDATE assertions SET last_reinforced = now(), last_retrieved = now()
           WHERE project_id = $1
             AND ($2::text IS NULL OR subject = $2)`,
          [projectId, q.filter?.subject || null]
        );
      }

    } else if (q.type === 'recency' || q.kind === 'recency') {
      const { rows } = await db.query(
        `SELECT subject, predicate, object, confidence FROM assertions
         WHERE project_id = $1
           AND suppressed = false
           AND confidence * exp(-decay_rate * EXTRACT(EPOCH FROM (now() - last_reinforced)) / 86400) >= 1.0
         ORDER BY last_reinforced DESC LIMIT 20`,
        [projectId]
      );
      if (rows.length) {
        const text = rows.map((r) =>
          `- [conf=${r.confidence}] ${r.subject} ${r.predicate} ${r.object}`
        ).join('\n');
        sections.push(`### Recent assertions\n${text}`);
        tokensUsed      += Math.ceil(text.length / 4);
        assertionsCount += rows.length;  // recency queries roll into assertionsCount
      }

    } else if (q.type === 'vector' || q.kind === 'vector') {
      // Vector search requires Ollama or vLLM — skip gracefully if unavailable.
      sections.push(`### Vector query (${q.query || ''}) — skipped in loader (Phase 3.6 hook)`);
    }
  }

  if (ownDb) await db.end();

  // Assemble output text (same content whether silent or not).
  const outputParts = [];

  if (fs.existsSync(handoffPath)) {
    const raw  = fs.readFileSync(handoffPath, 'utf8');
    const body = raw.replace(/^---[\s\S]*?---\r?\n/, '');
    outputParts.push('\n=== Handoff context ===');
    outputParts.push(body.trim());
  }

  if (sections.length) {
    outputParts.push('\n=== Retrieved context (contract: ' + contractName + ') ===');
    outputParts.push(sections.join('\n'));
  }

  outputParts.push(`\n  tokens used: ~${tokensUsed} / ${tokenBudget}`);

  const outputText = outputParts.join('\n');

  if (!silent) {
    console.log(outputText);
  }

  return {
    outputText,
    tokensUsed,
    sectionsCount:   sections.length,
    entitiesCount,
    assertionsCount,
    vectorCount,
    contractName,
    lastClose,
    daysSinceClose,
  };
}

// ── loader-hook (SessionStart hook entry point) ───────────────────────────────

async function cmdLoaderHook() {
  // All errors are swallowed and exit 0 — the hook must never break session start.
  let db = null;
  try {
    const projectId   = resolveProjectId();
    const handoffPath = resolveHandoffMdPath(projectId);

    // Silent no-op when handoff.md is absent (non-claude-memory project or not yet init-ed).
    if (!fs.existsSync(handoffPath)) {
      process.exit(0);
    }

    const fm         = readHandoffFrontmatter(handoffPath);
    const lastClose  = fm.last_close || null;
    const daysN      = daysSince(lastClose);
    const daysLabel  = daysN !== null ? `${daysN} days ago` : 'never';

    try {
      db = await connectHandoff();
    } catch (err) {
      // DB unavailable — exit silently, do not break session start.
      process.stderr.write(`handoff loader-hook: DB connection failed (${err.message}) — skipping\n`);
      process.exit(0);
    }

    const stalenessDays = parseInt(
      await getSetting(db, projectId, 'staleness_days', '7'),
      10
    );

    // ── Staleness gate ────────────────────────────────────────────────────────
    if (daysN !== null && daysN > stalenessDays) {
      process.stderr.write(
        `Running: handoff loader (project=${projectId}, last=${daysLabel}, STALE — threshold=${stalenessDays})\n`
      );

      await db.end();

      const staleMsg = [
        `⚠️  Handoff context is STALE (last close: ${lastClose}, ${daysN} days ago — threshold ${stalenessDays} days).`,
        '',
        'The auto-loader did not inject context. To proceed, run one of:',
        '  /handoff:status   — see counts and last-close details',
        '  /handoff:resume   — load context anyway, despite staleness',
        '  /handoff:drop     — archive prior session memory and start fresh',
      ].join('\n');

      // Single-line JSON on stdout — hook parser requirement.
      process.stdout.write(
        JSON.stringify({
          hookSpecificOutput: {
            hookEventName: 'SessionStart',
            additionalContext: staleMsg,
          },
        }) + '\n'
      );

      process.stderr.write('Done: handoff loader — staleness gate triggered, no context injected\n');
      process.exit(0);
    }

    // ── Non-stale path: load and inject context ───────────────────────────────
    process.stderr.write(
      `Running: handoff loader (project=${projectId}, last=${daysLabel})\n`
    );

    const result = await cmdLoaderLoad({ silent: true, db });

    // Re-connect db if cmdLoaderLoad closed it (ownDb path); re-open for the marker write.
    // In practice cmdLoaderLoad receives our db via opts.db so it doesn't close it, but
    // guard defensively: connectHandoff again only if needed.
    let markerDb = db;
    let markerDbOwned = false;
    if (!markerDb || markerDb._ending) {
      try {
        markerDb = await connectHandoff();
        markerDbOwned = true;
      } catch (_) {
        markerDb = null;
      }
    }

    // Set session_in_progress marker so the Stop hook knows a close is still needed.
    // Not set on the stale path — stale means the user is not in an auto-loaded session.
    if (markerDb) {
      await setSetting(markerDb, projectId, 'session_in_progress', new Date().toISOString());
    }

    if (markerDbOwned && markerDb) await markerDb.end();
    else if (!markerDbOwned && db) await db.end();

    // Single-line JSON on stdout.
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'SessionStart',
          additionalContext: result.outputText,
        },
      }) + '\n'
    );

    process.stderr.write(
      `Done: handoff loader — injected ${result.assertionsCount} assertions, ${result.entitiesCount} entities, ${result.vectorCount} vector matches\n`
    );

    process.exit(0);

  } catch (err) {
    // Catch-all: log to stderr, never break session start.
    process.stderr.write(`handoff loader-hook error: ${err.message}\n`);
    if (db) {
      try { await db.end(); } catch (_) { /* ignore */ }
    }
    process.exit(0);
  }
}

// ── resume ────────────────────────────────────────────────────────────────────

async function cmdResume() {
  console.log('Running: handoff:resume');
  const result = await cmdLoaderLoad();
  console.log(`\nDone: handoff:resume — injected ${result.assertionsCount} assertions, ${result.entitiesCount} entities, ${result.vectorCount} vector matches`);
}

// ── drop ──────────────────────────────────────────────────────────────────────

async function cmdDrop() {
  console.log('Running: handoff:drop');

  const projectId   = resolveProjectId();
  const handoffPath = resolveHandoffMdPath(projectId);

  let db;
  try {
    db = await connectHandoff();
  } catch (err) {
    console.error(`DB connection failed: ${err.message}`);
    process.exit(1);
  }

  // Suppress all assertions for this project (keeps rows for recovery).
  const dropRes = await db.query(
    `UPDATE assertions SET suppressed = true WHERE project_id = $1`,
    [projectId]
  );
  const zerodCount = dropRes.rowCount || 0;

  // Archive handoff.md
  let archivePath = null;
  if (fs.existsSync(handoffPath)) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    archivePath = handoffPath.replace(/handoff\.md$/, `handoff.${stamp}.archived.md`);
    fs.renameSync(handoffPath, archivePath);
  }

  // Create new empty handoff.md
  const root = findProjectRoot();
  writeHandoffMd(handoffPath, {
    PROJECT_ID:          projectId,
    LAST_CLOSE:          new Date().toISOString(),
    CONTRACT:            'default',
    ENTITIES_WRITTEN:    '0',
    ASSERTIONS_WRITTEN:  '0',
    EDGES_WRITTEN:       '0',
    PROJECT_NAME:        path.basename(root),
    TLDR:                '(dropped — prior session memory archived)',
    OPEN_THREADS:        '- (none)',
    QUICK_REFERENCES:    '(none)',
  });

  await db.end();

  console.log(`\n  assertions zeroed: ${zerodCount}`);
  if (archivePath) console.log(`  archived: ${archivePath}`);
  console.log(`  new handoff.md: ${handoffPath}`);
  console.log(`\nDone: handoff:drop — ${zerodCount} assertions suppressed, handoff.md archived`);
}

// ── extraction (shared by checkpoint and close) ───────────────────────────────

/**
 * Write entities/assertions/edges from a JSON payload.
 * Returns { entitiesWritten, assertionsWritten, edgesWritten }.
 *
 * Payload shape (all arrays optional):
 * {
 *   entities: [{name, entity_type, description}],
 *   assertions: [{subject, predicate, object, confidence, source}],
 *   edges: [{from_entity, edge_type, to_entity, weight}],
 *   contract: { queries: [...] },
 *   tldr: "...",
 *   open_threads: ["..."],
 *   quick_references: "...",
 *   session_id: "..."
 * }
 */
async function writeExtraction(db, projectId, payload) {
  const sessionId = payload.session_id || null;
  let entitiesWritten   = 0;
  let assertionsWritten = 0;
  let edgesWritten      = 0;

  // Entities
  for (const ent of (payload.entities || [])) {
    if (!ent.name || !ent.entity_type) continue;
    await db.query(
      `INSERT INTO entities (project_id, name, entity_type, description, session_id)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (project_id, name) DO UPDATE
         SET entity_type = EXCLUDED.entity_type,
             description = EXCLUDED.description`,
      [projectId, ent.name, ent.entity_type, ent.description || null, sessionId]
    );
    entitiesWritten++;
  }

  // Assertions — no unique constraint on assertions table; plain INSERT.
  for (const ass of (payload.assertions || [])) {
    if (!ass.subject || !ass.predicate || !ass.object) continue;
    const conf   = Math.min(10, Math.max(1, parseFloat(ass.confidence) || 5));
    const source = ['user_stated', 'model_extracted', 'doc_quoted', 'retrieved_from_prior'].includes(ass.source)
      ? ass.source : 'model_extracted';
    await db.query(
      `INSERT INTO assertions (project_id, subject, predicate, object, confidence, source, session_id, last_reinforced)
       VALUES ($1, $2, $3, $4, $5, $6, $7, now())`,
      [projectId, ass.subject, ass.predicate, ass.object, conf, source, sessionId]
    );
    assertionsWritten++;
  }

  // Edges
  for (const edge of (payload.edges || [])) {
    if (!edge.from_entity || !edge.edge_type || !edge.to_entity) continue;
    const weight = parseFloat(edge.weight) || 1.0;
    await db.query(
      `INSERT INTO edges (project_id, from_entity, edge_type, to_entity, weight, session_id)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [projectId, edge.from_entity, edge.edge_type, edge.to_entity, weight, sessionId]
    );
    edgesWritten++;
  }

  // Retrieval contract upsert
  if (payload.contract && typeof payload.contract === 'object') {
    await db.query(
      `INSERT INTO retrieval_contract (project_id, name, queries, updated_at)
       VALUES ($1, 'default', $2::jsonb, now())
       ON CONFLICT (project_id, name) DO UPDATE
         SET queries = EXCLUDED.queries, updated_at = now()`,
      [projectId, JSON.stringify(payload.contract)]
    );
  }

  return { entitiesWritten, assertionsWritten, edgesWritten };
}

/** Run reranker precision@5 gate check. Informational — never blocking. */
async function runRerankerGate(db, projectId, root) {
  const minChunksStr = await getSetting(db, projectId, 'precision_at_5_gate_min_chunks', '1000');
  const minChunks = parseInt(minChunksStr, 10);
  // memory_entry_chunks links to memory_entries via entry_id; no direct project_id column.
  // Count via join to memory_entries which does have project_id (mem_type scoped by entry).
  // Fallback: if no project_id column on memory_entries either, count all chunks as proxy.
  let chunkCount = 0;
  try {
    const { rows: chunkRows } = await db.query(
      `SELECT COUNT(c.*) AS n
       FROM memory_entry_chunks c
       JOIN memory_entries e ON e.id = c.entry_id
       WHERE e.source_file IS NOT NULL`
    );
    chunkCount = parseInt(chunkRows[0].n, 10);
  } catch (_) {
    // Table may not exist or schema differs — skip gate
    console.log('\n  Reranker gate: SKIPPED — could not count chunks');
    return;
  }

  if (chunkCount < minChunks) {
    console.log(`\n  Reranker gate: SKIPPED — corpus n=${chunkCount} below threshold=${minChunks}`);
    return;
  }

  // Corpus is above threshold — run eval harness in both modes.
  console.log(`\n  Reranker gate: corpus n=${chunkCount} >= threshold=${minChunks} — running eval...`);
  const evalScript = path.join(root, 'test', 'eval', 'eval-retrieval.js');
  if (!fs.existsSync(evalScript)) {
    console.log('  Reranker gate: SKIPPED — eval script not found at ' + evalScript);
    return;
  }

  const { execFileSync } = require('child_process');

  let vectorP5 = null;
  let rerankP5 = null;

  const runEval = (extraArgs) => {
    try {
      const out = execFileSync(process.execPath, [evalScript, '--quiet', ...extraArgs], {
        cwd: root,
        env: { ...process.env, PROJECT_ROOT: root },
        encoding: 'utf8',
        timeout: 120000,
      });
      // Parse precision@5 from output — look for "precision@5: 0.NN" or "P@5: 0.NN"
      const m = out.match(/(?:precision@5|P@5)[^\d]+([\d.]+)/i);
      return m ? parseFloat(m[1]) : null;
    } catch (_) {
      return null;
    }
  };

  vectorP5 = runEval([]);
  rerankP5 = runEval(['--rerank']);

  if (vectorP5 === null || rerankP5 === null) {
    console.log('  Reranker gate: could not parse precision@5 from eval output — skipping gate');
    return;
  }

  const delta = rerankP5 - vectorP5;
  console.log(`  Reranker gate: vector P@5=${vectorP5.toFixed(3)}, reranker P@5=${rerankP5.toFixed(3)}, Δ=${delta.toFixed(3)}`);
  if (delta < 0.05) {
    console.log(`  WARNING: Δ < 0.05 — reranker is not providing a meaningful lift.`);
    console.log(`    Suggestion: (a) defer next reranker re-tune, or (b) inspect for corpus drift.`);
  } else {
    console.log(`  Reranker gate: PASS (Δ >= 0.05)`);
  }
}

// ── checkpoint ───────────────────────────────────────────────────────────────

async function cmdCheckpoint(args) {
  console.log('Running: handoff:checkpoint');

  const useJson = args.includes('--json') && args.includes('-');
  const projectId   = resolveProjectId();
  const handoffPath = resolveHandoffMdPath(projectId);
  const root        = findProjectRoot();

  let payload = {};
  if (useJson) {
    payload = await readStdin();
  }

  let db;
  try {
    db = await connectHandoff();
  } catch (err) {
    console.error(`DB connection failed: ${err.message}`);
    process.exit(1);
  }

  const { entitiesWritten, assertionsWritten, edgesWritten } =
    await writeExtraction(db, projectId, payload);

  // Update handoff.md
  const stamp = new Date().toISOString();
  writeHandoffMd(handoffPath, {
    PROJECT_ID:          projectId,
    LAST_CLOSE:          stamp,
    CONTRACT:            payload.contract ? 'default' : (readHandoffFrontmatter(handoffPath).contract || 'default'),
    ENTITIES_WRITTEN:    String(entitiesWritten),
    ASSERTIONS_WRITTEN:  String(assertionsWritten),
    EDGES_WRITTEN:       String(edgesWritten),
    PROJECT_NAME:        path.basename(root),
    TLDR:                payload.tldr || '(checkpoint)',
    OPEN_THREADS:        (payload.open_threads || []).map((t) => `- ${t}`).join('\n') || '- (none)',
    QUICK_REFERENCES:    payload.quick_references || '(none)',
  });

  // Clear session_in_progress so the Phase 3.7 Stop hook treats this checkpoint
  // as an explicit save and skips the implicit close.
  await db.query(
    `DELETE FROM project_settings WHERE project_id = $1 AND key = 'session_in_progress'`,
    [projectId]
  );

  // Run reranker gate (informational)
  await runRerankerGate(db, projectId, root);

  await db.end();

  console.log(`\n  entities written:    ${entitiesWritten}`);
  console.log(`  assertions written:  ${assertionsWritten}`);
  console.log(`  edges written:       ${edgesWritten}`);
  console.log(`\nDone: handoff:checkpoint — ${entitiesWritten}e/${assertionsWritten}a/${edgesWritten}ed written (session marker cleared)`);
}

// ── close ─────────────────────────────────────────────────────────────────────

async function cmdClose(args) {
  console.log('Running: handoff:close');

  const useJson = args.includes('--json') && args.includes('-');
  const projectId   = resolveProjectId();
  const handoffPath = resolveHandoffMdPath(projectId);
  const root        = findProjectRoot();

  let payload = {};
  if (useJson) {
    payload = await readStdin();
  }

  let db;
  try {
    db = await connectHandoff();
  } catch (err) {
    console.error(`DB connection failed: ${err.message}`);
    process.exit(1);
  }

  const { entitiesWritten, assertionsWritten, edgesWritten } =
    await writeExtraction(db, projectId, payload);

  // Surface CLAUDE.md promotion candidates (conf >= 9, user_stated, multi-session)
  const { rows: candidates } = await db.query(
    `SELECT subject, predicate, object, confidence
     FROM assertions
     WHERE project_id = $1
       AND suppressed = false
       AND confidence >= 9
       AND source = 'user_stated'
       AND EXTRACT(EPOCH FROM (last_reinforced - created_at)) > 86400
     ORDER BY confidence DESC`,
    [projectId]
  );
  if (candidates.length > 0) {
    console.log('\n  CLAUDE.md promotion candidates (confidence >= 9, user_stated, multi-session):');
    for (const row of candidates) {
      console.log(`    [conf=${row.confidence}] ${row.subject} ${row.predicate} ${row.object}`);
    }
    console.log('  Review and run /handoff:close with confirm_claude_md_promotion=true to write to CLAUDE.md.');
  }

  // Write to CLAUDE.md if requested and candidates exist
  if (payload.confirm_claude_md_promotion && candidates.length > 0) {
    const claudeMdPath = path.join(root, 'CLAUDE.md');
    if (fs.existsSync(claudeMdPath)) {
      const existing = fs.readFileSync(claudeMdPath, 'utf8');
      const additions = candidates.map((r) =>
        `- [conf=${r.confidence}] ${r.subject} ${r.predicate} ${r.object}`
      ).join('\n');
      const durableFacts = existing.includes('## Durable facts')
        ? existing.replace(/## Durable facts\n.*?\n- \(No durable facts.*?\)\n/s,
            `## Durable facts\n${additions}\n`)
        : existing + `\n## Durable facts\n${additions}\n`;
      fs.writeFileSync(claudeMdPath, durableFacts, 'utf8');
      console.log(`\n  CLAUDE.md updated with ${candidates.length} durable fact(s).`);
    }
  }

  // Update handoff.md
  const stamp = new Date().toISOString();
  writeHandoffMd(handoffPath, {
    PROJECT_ID:          projectId,
    LAST_CLOSE:          stamp,
    CONTRACT:            'default',
    ENTITIES_WRITTEN:    String(entitiesWritten),
    ASSERTIONS_WRITTEN:  String(assertionsWritten),
    EDGES_WRITTEN:       String(edgesWritten),
    PROJECT_NAME:        path.basename(root),
    TLDR:                payload.tldr || '(closed)',
    OPEN_THREADS:        (payload.open_threads || []).map((t) => `- ${t}`).join('\n') || '- (none)',
    QUICK_REFERENCES:    payload.quick_references || '(none)',
  });

  // Clear session_in_progress marker
  await db.query(
    `DELETE FROM project_settings WHERE project_id = $1 AND key = 'session_in_progress'`,
    [projectId]
  );

  // Run reranker gate (informational)
  await runRerankerGate(db, projectId, root);

  await db.end();

  console.log(`\n  entities written:    ${entitiesWritten}`);
  console.log(`  assertions written:  ${assertionsWritten}`);
  console.log(`  edges written:       ${edgesWritten}`);
  console.log(`  contract:            updated`);
  console.log(`\nDone: handoff:close — ${entitiesWritten}e/${assertionsWritten}a/${edgesWritten}ed written, session marker cleared`);
}

// ── purge ─────────────────────────────────────────────────────────────────────

async function cmdPurge(args) {
  console.log('Running: handoff:purge');

  const projectId   = resolveProjectId();
  const handoffPath = resolveHandoffMdPath(projectId);

  const skipConfirm = args.includes('--yes');

  if (!skipConfirm) {
    // Interactive confirmation via stdin
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const answer = await new Promise((resolve) => {
      rl.question(
        `\n  WARNING: This will permanently delete ALL memory rows for project_id="${projectId}".\n  Type "yes" to confirm: `,
        (a) => { rl.close(); resolve(a.trim()); }
      );
    });
    if (answer.toLowerCase() !== 'yes') {
      console.log('\n  Purge cancelled.');
      console.log('\nDone: handoff:purge — cancelled (no changes made)');
      return;
    }
  }

  let db;
  try {
    db = await connectHandoff();
  } catch (err) {
    console.error(`DB connection failed: ${err.message}`);
    process.exit(1);
  }

  // Hard delete in dependency order
  const tables = ['edges', 'assertions', 'entities', 'retrieval_contract', 'project_settings'];
  for (const tbl of tables) {
    await db.query(`DELETE FROM ${tbl} WHERE project_id = $1`, [projectId]);
  }

  // Delete handoff.md
  if (fs.existsSync(handoffPath)) {
    fs.unlinkSync(handoffPath);
  }

  await db.end();

  console.log(`\n  All rows deleted for project_id="${projectId}".`);
  console.log(`  handoff.md removed.`);
  console.log(`\nDone: handoff:purge — all project memory permanently deleted`);
}

// ── loader-stop (Stop hook entry point) ──────────────────────────────────────

/**
 * Stop hook for implicit session close.
 *
 * Fires when Claude Code ends a session. Checks whether /handoff:close or
 * /handoff:checkpoint ran during this session (via the session_in_progress
 * marker set by cmdLoaderHook). If not, writes an implicit close record to
 * handoff.md and clears the marker.
 *
 * Defensive contract: ALWAYS exits 0. Any error is logged to stderr and the
 * hook exits silently — we must never break session teardown.
 *
 * Design note on handoff.md body preservation:
 *   writeHandoffMd() re-renders from the full template, which would overwrite
 *   the body (tldr, open_threads, quick_references) with whatever we pass.
 *   For an implicit close we do NOT have a fresh extraction payload, so we
 *   preserve the existing body by reading the current frontmatter and passing
 *   its values back. The only fields we override are last_close (set to now)
 *   and tldr (set to the implicit-close notice). This matches the pattern used
 *   by cmdCheckpoint — read current fm, then call writeHandoffMd with merged
 *   values — which is cleaner than trying to surgically edit the raw file.
 */
async function cmdLoaderStop() {
  let db = null;
  try {
    const projectId   = resolveProjectId();
    const handoffPath = resolveHandoffMdPath(projectId);

    // Defensive: handoff.md absent means project is not provisioned — no-op.
    if (!fs.existsSync(handoffPath)) {
      process.exit(0);
    }

    try {
      db = await connectHandoff();
    } catch (err) {
      process.stderr.write(`handoff loader-stop: DB connection failed (${err.message}) — skipping\n`);
      process.exit(0);
    }

    // Check project-level implicit_close gate (default enabled).
    const implicitClose = await getSetting(db, projectId, 'implicit_close', 'enabled');
    if (implicitClose === 'disabled') {
      await db.end();
      process.exit(0);
    }

    // Check session_in_progress marker.
    //   Absent → close already ran (or loader hook never fired). No-op.
    //   Present → no explicit close ran this session. Run implicit close.
    const sip = await getSetting(db, projectId, 'session_in_progress', null);
    if (!sip) {
      await db.end();
      process.exit(0);
    }

    // session_in_progress is set — implicit close needed.
    process.stderr.write('Running: handoff stop hook — implicit close...\n');

    // Read current frontmatter to preserve all existing fields.
    const fm   = readHandoffFrontmatter(handoffPath);
    const root = findProjectRoot();

    const stamp = new Date().toISOString();

    // Preserve existing body-level values; override last_close and tldr only.
    // open_threads and quick_references are preserved from prior close/checkpoint.
    // session_summary sub-keys live nested in fm.session_summary (parsed by
    // readHandoffFrontmatter), NOT at the top level of fm.
    const ss = fm.session_summary || {};
    const entitiesWritten   = ss.entities_written   || '0';
    const assertionsWritten = ss.assertions_written || '0';
    const edgesWritten      = ss.edges_written      || '0';
    const contractName      = fm.contract           || 'default';
    const projectName       = fm.project_name       || path.basename(root);

    // Reconstruct open_threads and quick_references from the handoff.md body.
    // writeHandoffMd expects OPEN_THREADS as bullet-prefixed lines and
    // QUICK_REFERENCES as a plain string. We read them from the raw body rather
    // than frontmatter (they live in the body section, not in YAML).
    // Safest fallback: preserve the prior close values via the template.
    // The template uses {{OPEN_THREADS}} and {{QUICK_REFERENCES}}, so we need
    // to supply them explicitly. Read the existing file body to extract them.
    let openThreads    = '- (none)';
    let quickRefs      = '(none)';
    try {
      const raw  = fs.readFileSync(handoffPath, 'utf8');
      const body = raw.replace(/^---[\s\S]*?---\r?\n/, '');
      // Extract open threads block
      const otMatch = body.match(/##\s+Open threads\r?\n([\s\S]*?)(?=\r?\n##|\r?\n$|$)/);
      if (otMatch) openThreads = otMatch[1].trim() || '- (none)';
      // Extract quick references block
      const qrMatch = body.match(/##\s+Quick references\r?\n([\s\S]*?)(?=\r?\n##|\r?\n$|$)/);
      if (qrMatch) quickRefs = qrMatch[1].trim() || '(none)';
    } catch (_) {
      // Body parse failed — fall back to safe defaults
    }

    writeHandoffMd(handoffPath, {
      PROJECT_ID:          projectId,
      LAST_CLOSE:          stamp,
      CONTRACT:            contractName,
      ENTITIES_WRITTEN:    entitiesWritten,
      ASSERTIONS_WRITTEN:  assertionsWritten,
      EDGES_WRITTEN:       edgesWritten,
      PROJECT_NAME:        projectName,
      TLDR:                '(implicit close — session ended without explicit /handoff:close)',
      OPEN_THREADS:        openThreads,
      QUICK_REFERENCES:    quickRefs,
    });

    // Clear the session_in_progress marker.
    await db.query(
      `DELETE FROM project_settings WHERE project_id = $1 AND key = 'session_in_progress'`,
      [projectId]
    );

    await db.end();

    process.stderr.write('Done: handoff stop hook — implicit close written, session marker cleared\n');
    process.exit(0);

  } catch (err) {
    // Catch-all: log to stderr, never break session teardown.
    process.stderr.write(`handoff loader-stop error: ${err.message}\n`);
    if (db) {
      try { await db.end(); } catch (_) { /* ignore */ }
    }
    process.exit(0);
  }
}

// ─── ROUTER ──────────────────────────────────────────────────────────────────

async function main() {
  const [, , sub, ...rest] = process.argv;

  const subcommands = {
    init:           () => cmdInit(rest),
    status:         () => cmdStatus(),
    resume:         () => cmdResume(),
    'loader-load':  () => cmdLoaderLoad(),
    'loader-hook':  () => cmdLoaderHook(),
    'loader-stop':  () => cmdLoaderStop(),
    drop:           () => cmdDrop(),
    checkpoint:     () => cmdCheckpoint(rest),
    close:          () => cmdClose(rest),
    purge:          () => cmdPurge(rest),
  };

  if (!sub || !subcommands[sub]) {
    const available = Object.keys(subcommands).join(', ');
    console.error(`Usage: node scripts/handoff.js <subcommand> [args]`);
    console.error(`Subcommands: ${available}`);
    process.exit(2);
  }

  try {
    await subcommands[sub]();
  } catch (err) {
    console.error(`\nhandoff:${sub} failed: ${err.message}`);
    if (process.env.DEBUG) console.error(err.stack);
    process.exit(1);
  }
}

main();
