'use strict';
const __startNs = process.hrtime.bigint();

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
 *   promote    <id>         Explicitly promote an assertion to CLAUDE.md durable facts.
 *   loader-load             Same inline load as resume; used directly or by tests.
 *   loader-hook             SessionStart hook entry point (outputs JSON to stdout).
 *   queue-drain [--max=N]   Drain pending async extraction queue rows (background worker).
 *
 * Environment:
 *   PROJECT_ROOT            Override project root detection.
 *   PGUSER / PGPASSWORD     Postgres credentials (standard env vars, picked up by pg).
 *   HANDOFF_MULTI_AUTHOR_OVERRIDE  Override git author count for testing (integer string).
 *
 * Exit codes: 0 success, 1 error, 2 usage.
 */

const fs    = require('fs');
const path  = require('path');
const os    = require('os');
const readline = require('readline');

const { loadConfig, connect, c, findProjectRoot } = require('./lib/shared');
const { encodeCwd, getClaudeProjectDir }           = require('./lib/encoded-cwd');
const { classifyPredicate }                        = require('./lib/predicate-registry');
const { validatePayload }                          = require('./lib/payload-schema');

process.on('exit', () => {
  const ms = Number(process.hrtime.bigint() - __startNs) / 1e6;
  process.stderr.write(`internal_ms=${ms.toFixed(1)}\n`);
});

// ─── CONSTANTS ───────────────────────────────────────────────────────────────

// HANDOFF_DB — documented env-var override for projects that don't use the default DB name.
// Validated against a strict identifier regex because DDL cannot use parameterized $1 and
// the double-quote wrap in CREATE DATABASE can be broken by names containing '"'.
const _rawTargetDb = process.env.HANDOFF_DB || 'claude_memory_eval_test';
const _DB_NAME_RE  = /^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/;
if (!_DB_NAME_RE.test(_rawTargetDb)) {
  process.stderr.write(
    `Invalid HANDOFF_DB value "${_rawTargetDb}" — must match /^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/.\n`
  );
  process.exit(1);
}
const TARGET_DB = _rawTargetDb;
const HANDOFF_TEMPLATE = path.resolve(__dirname, '..', 'templates', 'handoff.md.tpl');
const PROJECT_CLAUDE_MD_TEMPLATE = path.resolve(__dirname, '..', 'templates', 'project-claude-md.tpl');

// ─── OPERATING CANON (hardcoded trusted preamble) ─────────────────────────────
// Emitted unconditionally before the untrusted retrieved-context block so every
// session sees the canon in the trusted zone — never inside the untrusted delimiters.
const OPERATING_CANON = `=== OPERATING CANON (trusted — applies to this and every session) ===
1. Follow the user's directions and scope exactly. When asked to do X, and X has an established definition (a backlog item, a prior handoff, a multi-part deliverable), deliver all of X. Do not silently narrow scope, reinterpret it, or substitute a smaller deliverable. If scope genuinely seems too large or ambiguous, say so and ask — do not shrink it unilaterally.
2. Never autonomously defer authorized work to a subsequent session/bundle/phase. Deferring in-scope work without explicit user say-so is a bug. Surface genuine design forks as written open questions with a recommended lean; never use deferral or an invented "later phase" as a mechanism to offload work that is in scope now.
=== END OPERATING CANON ===`;

// ─── HELPERS ─────────────────────────────────────────────────────────────────

/** Connect to the handoff DB (TARGET_DB, overridable via HANDOFF_DB env var). */
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

/**
 * Read JSON payload from stdin (used for --json - flag).
 * Validates structure: only allowed top-level keys, string-field length caps,
 * array length caps. Throws with a field-naming error message on violation.
 *
 * Allowed top-level keys: tldr, open_threads, quick_references, entities,
 *   assertions, edges, decisions, contract, session_id, confirm_claude_md_promotion.
 */
function readStdin() {
  return new Promise((resolve, reject) => {
    const chunks = [];
    process.stdin.on('data', (d) => chunks.push(d));
    process.stdin.on('end', () => {
      let parsed;
      try {
        parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch (e) {
        return reject(new Error(`Failed to parse JSON from stdin: ${e.message}`));
      }

      // Must be a plain object, not array or primitive.
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        return reject(new Error('stdin JSON: payload must be a plain object (not array or primitive)'));
      }

      // Reject unknown top-level keys.
      const ALLOWED_KEYS = new Set([
        'tldr', 'open_threads', 'quick_references',
        'entities', 'assertions', 'edges', 'decisions',
        'contract', 'session_id', 'confirm_claude_md_promotion',
        'retrieval_outcome', 'retrieval_outcome_notes',
      ]);
      for (const k of Object.keys(parsed)) {
        if (!ALLOWED_KEYS.has(k)) {
          return reject(new Error(`stdin JSON: unknown top-level key "${k}"`));
        }
      }

      // Validate retrieval_outcome if present.
      if ('retrieval_outcome' in parsed) {
        const VALID_OUTCOMES = new Set(['success', 'failure', 'irrelevant']);
        if (typeof parsed.retrieval_outcome !== 'string' || !VALID_OUTCOMES.has(parsed.retrieval_outcome)) {
          return reject(new Error(
            `stdin JSON: "retrieval_outcome" must be one of 'success', 'failure', 'irrelevant' ` +
            `(got ${JSON.stringify(parsed.retrieval_outcome)}); 'pending' and other values are not accepted`
          ));
        }
      }

      // String fields with length cap.
      // Note: open_threads is an array (not a string); quick_references is a string.
      const STRING_FIELDS = ['tldr', 'quick_references', 'session_id', 'retrieval_outcome_notes'];
      const STRING_MAX    = 4000;
      for (const field of STRING_FIELDS) {
        if (field in parsed) {
          if (typeof parsed[field] !== 'string') {
            return reject(new Error(`stdin JSON: "${field}" must be a string`));
          }
          if (parsed[field].length > STRING_MAX) {
            return reject(new Error(
              `stdin JSON: "${field}" exceeds max length (${parsed[field].length} > ${STRING_MAX})`
            ));
          }
        }
      }

      // open_threads: array of strings, each <= STRING_MAX, array length <= 200.
      if ('open_threads' in parsed) {
        if (!Array.isArray(parsed.open_threads)) {
          return reject(new Error('stdin JSON: "open_threads" must be an array'));
        }
        if (parsed.open_threads.length > 200) {
          return reject(new Error(
            `stdin JSON: "open_threads" array length ${parsed.open_threads.length} exceeds max 200`
          ));
        }
        for (let i = 0; i < parsed.open_threads.length; i++) {
          const item = parsed.open_threads[i];
          if (typeof item !== 'string') {
            return reject(new Error(`stdin JSON: "open_threads[${i}]" must be a string`));
          }
          if (item.length > STRING_MAX) {
            return reject(new Error(
              `stdin JSON: "open_threads[${i}]" exceeds max length (${item.length} > ${STRING_MAX})`
            ));
          }
        }
      }

      // Array-of-records fields: cap array length and per-record string field length.
      const ARRAY_FIELDS  = ['entities', 'assertions', 'edges', 'decisions'];
      const ARRAY_MAX     = 200;
      const RECORD_STR_MAX = 1000;
      for (const field of ARRAY_FIELDS) {
        if (field in parsed) {
          if (!Array.isArray(parsed[field])) {
            return reject(new Error(`stdin JSON: "${field}" must be an array`));
          }
          if (parsed[field].length > ARRAY_MAX) {
            return reject(new Error(
              `stdin JSON: "${field}" array length ${parsed[field].length} exceeds max ${ARRAY_MAX}`
            ));
          }
          for (let i = 0; i < parsed[field].length; i++) {
            const rec = parsed[field][i];
            if (typeof rec !== 'object' || rec === null || Array.isArray(rec)) {
              return reject(new Error(`stdin JSON: "${field}[${i}]" must be a plain object`));
            }
            for (const [k, v] of Object.entries(rec)) {
              if (typeof v === 'string' && v.length > RECORD_STR_MAX) {
                return reject(new Error(
                  `stdin JSON: "${field}[${i}].${k}" exceeds max length (${v.length} > ${RECORD_STR_MAX})`
                ));
              }
            }
          }
        }
      }

      resolve(parsed);
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

/**
 * Deep-equal comparison for two retrieval contract objects.
 * Compares via JSON.stringify (contract shape is {queries:[...]}, deterministic).
 * Exported for unit tests.
 *
 * @param {object} a
 * @param {object} b
 * @returns {boolean}
 */
function queriesEqual(a, b) {
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch (_) {
    return false;
  }
}

/**
 * Record a contract change: bump the version and write a history row.
 *
 * Transactional:
 *   1. SELECT current version + queries for (projectId, name).
 *   2. If the row exists and its queries deep-equal newQueriesObj → NO-OP
 *      (idempotent — prevents history spam on identical re-close).
 *   3. Otherwise compute newVersion, UPSERT retrieval_contract with the new
 *      queries/version, and INSERT a retrieval_contract_history row.
 *
 * Non-fatal: callers must wrap in try/catch — a history failure must not abort
 * the operation that triggered it.
 *
 * @param {object}  db            — pg Client
 * @param {string}  projectId     — encoded_cwd
 * @param {string}  name          — contract name (e.g. 'default')
 * @param {object}  newQueriesObj — the new contract object (e.g. {queries:[...]})
 * @param {string|null} changeNote — human-readable note stored in history row
 */
async function recordContractChange(db, projectId, name, newQueriesObj, changeNote) {
  await db.query('BEGIN');
  try {
    // Read current state.
    const { rows } = await db.query(
      `SELECT version, queries FROM retrieval_contract
       WHERE project_id = $1 AND name = $2`,
      [projectId, name]
    );

    const existing = rows.length > 0 ? rows[0] : null;

    // Idempotent no-op: if the contract is unchanged, do nothing.
    if (existing && queriesEqual(existing.queries, newQueriesObj)) {
      await db.query('COMMIT');
      return;
    }

    const newVersion = existing ? (existing.version || 0) + 1 : 1;

    // Upsert the live contract row with the new queries and bumped version.
    await db.query(
      `INSERT INTO retrieval_contract (project_id, name, queries, version, updated_at)
       VALUES ($1, $2, $3::jsonb, $4, now())
       ON CONFLICT (project_id, name) DO UPDATE
         SET queries = EXCLUDED.queries, version = EXCLUDED.version, updated_at = now()`,
      [projectId, name, JSON.stringify(newQueriesObj), newVersion]
    );

    // Insert audit history row.
    await db.query(
      `INSERT INTO retrieval_contract_history (project_id, name, version, queries, change_note)
       VALUES ($1, $2, $3, $4::jsonb, $5)`,
      [projectId, name, newVersion, JSON.stringify(newQueriesObj), changeNote || null]
    );

    await db.query('COMMIT');
  } catch (err) {
    try { await db.query('ROLLBACK'); } catch (_) { /* ignore */ }
    throw err;
  }
}

/**
 * Detect whether the repository at `cwd` has more than one commit author in the
 * past year. Returns the distinct author-email count.
 *
 * Uses HANDOFF_MULTI_AUTHOR_OVERRIDE env var to inject a fixed count for tests.
 *
 * Silently returns 1 if:
 *   - git is unavailable
 *   - the directory is not a git repo
 *   - any other error occurs
 */
function detectMultiAuthor(cwd) {
  // Test hook: override the count without touching the real git log.
  const override = process.env.HANDOFF_MULTI_AUTHOR_OVERRIDE;
  if (override !== undefined) {
    const n = parseInt(override, 10);
    return isNaN(n) ? 1 : n;
  }

  try {
    const { execFileSync } = require('child_process');
    const out = execFileSync(
      'git',
      ['-C', cwd, 'log', '--format=%ae', '--since=1 year ago'],
      { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }
    );
    const emails = new Set(out.split('\n').map((e) => e.trim()).filter(Boolean));
    return emails.size || 1;
  } catch (_) {
    // git not available, not a repo, or no commits — treat as single-author.
    return 1;
  }
}

/**
 * Read-only git probe: determine whether the working tree at `root` has
 * unpackaged state (dirty tree or local commits not yet pushed upstream).
 *
 * Returns { dirty: boolean, aheadCount: number, label: string }.
 *
 * Failures (git unavailable, not a repo, no upstream) are handled silently:
 *   - git errors → dirty=false, aheadCount=0, label='clean (probe unavailable)'
 *   - no upstream branch → aheadCount treated as 0 (not an error condition)
 *
 * NEVER runs a mutating git command.
 */
function detectUnpackagedState(root) {
  try {
    const { execFileSync } = require('child_process');
    const execOpts = { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'] };

    // Check for dirty working tree (untracked, modified, or staged changes).
    const statusOut = execFileSync('git', ['-C', root, 'status', '--porcelain'], execOpts);
    const dirty = statusOut.trim().length > 0;

    // Check for local commits ahead of upstream; treat no-upstream as 0.
    let aheadCount = 0;
    try {
      const aheadOut = execFileSync(
        'git', ['-C', root, 'rev-list', '--count', '@{upstream}..HEAD'], execOpts
      );
      aheadCount = parseInt(aheadOut.trim(), 10) || 0;
    } catch (_) {
      // No upstream configured — treat as 0 ahead, not an error.
      aheadCount = 0;
    }

    const unpackaged = dirty || aheadCount > 0;
    const parts = [];
    if (dirty) parts.push('dirty working tree');
    if (aheadCount > 0) parts.push(`${aheadCount} commit(s) ahead of upstream`);
    const label = unpackaged ? parts.join(', ') : 'clean';
    return { dirty, aheadCount, unpackaged, label };
  } catch (_) {
    // git unavailable, not a repo, or any other error — skip silently.
    return { dirty: false, aheadCount: 0, unpackaged: false, label: 'clean (probe unavailable)' };
  }
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
    // Idempotent migration: add `promoted` and `promoted_at` columns to assertions
    // (used by /handoff:promote explicit-promotion command, added in Bundle A hardening).
    await db.query(`ALTER TABLE assertions ADD COLUMN IF NOT EXISTS promoted    BOOLEAN     NOT NULL DEFAULT false`);
    await db.query(`ALTER TABLE assertions ADD COLUMN IF NOT EXISTS promoted_at TIMESTAMPTZ`);
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
    staleness_days:                   '7',
    loader_token_budget:              '4000',
    implicit_close:                   'enabled',
    decay_rate_default:               '0.05',
    retrieval_outcome_timeout_days:   '14',
    cluster_aware_retrieval:          'enabled',
    cluster_max_siblings:             '10',
    // Graph edge traversal retrieval (opt-in via contract kind:'graph', default OFF-by-contract).
    // When graph_retrieval_enabled='disabled', the branch is a no-op even with a graph query
    // in the contract. Default contract has no graph query — byte-identical to pre-feature.
    graph_retrieval_enabled:          'enabled',
    graph_max_depth:                  '2',
    graph_max_nodes:                  '25',
    // C2: outcome→ranking+decay feedback loop (default OFF — byte-identical to pre-C2 when disabled).
    feedback_loop_enabled:            'disabled',
    feedback_success_delta:           '0.5',   // bias nudge per success outcome
    feedback_failure_delta:           '-0.75', // bias nudge per failure outcome
    feedback_irrelevant_delta:        '-0.25', // bias nudge per irrelevant outcome (smaller penalty)
    feedback_bias_clamp:              '3.0',   // max absolute value of outcome_bias ∈ [-clamp, +clamp]
    // C3: auto-evolve retrieval_contract from retrieval_events outcome patterns (default OFF).
    // Fully independent of feedback_loop_enabled — evolution can be evaluated even when bias
    // feedback is disabled (uses only retrieval_events.outcome, not assertions.outcome_bias).
    // When 'disabled', zero contract mutation occurs — cmdClose output byte-identical to pre-C3.
    contract_evolution_enabled:       'disabled',
    contract_evolution_window_days:   '30',    // rolling window for outcome aggregation
    contract_evolution_min_events:    '10',    // minimum events per kind before any rule fires
    contract_evolution_failure_threshold: '0.5', // failure+irrelevant rate that triggers budget reduction
    contract_evolution_budget_floor:  '200',   // minimum token_budget for any kind (never reduced below)
    contract_evolution_budget_step:   '200',   // max budget change per evolution pass (gradual, bounded)
    // Async extraction queue (opt-in, default OFF — byte-identical to synchronous write when disabled).
    // When 'true', cmdClose and cmdCheckpoint enqueue the payload for the deterministic
    // background worker (queue-drain subcommand) instead of writing synchronously.
    extraction_async_enabled:         'false',
    // Predicate registry enforcement mode (default 'permissive' — unrecognized predicates
    // are flagged via stderr warning but still written; 'strict' skips them).
    predicate_registry_mode:          'permissive',
  };
  for (const [key, val] of Object.entries(defaults)) {
    await db.query(
      `INSERT INTO project_settings (project_id, key, value) VALUES ($1, $2, $3)
       ON CONFLICT (project_id, key) DO NOTHING`,
      [projectId, key, val]
    );
  }
  console.log(`  [OK]    project_settings defaults ensured (${Object.keys(defaults).length} keys, idempotent)`);

  // Step 9: Insert default retrieval_contract row (DO NOTHING keeps it idempotent)
  await db.query(
    `INSERT INTO retrieval_contract (project_id, name, queries, updated_at)
     VALUES ($1, 'default', $2::jsonb, now())
     ON CONFLICT (project_id, name) DO NOTHING`,
    [projectId, JSON.stringify({ queries: [] })]
  );
  console.log(`  [OK]    retrieval_contract 'default' row ensured`);

  // Idempotently ensure a v1 baseline history row exists (non-fatal).
  // If the project is brand new, the DO NOTHING above just inserted v1 and there
  // is no history row yet. If init is re-run, DO NOTHING above is a no-op and a
  // baseline row may already exist — we guard with a COUNT check.
  try {
    const { rows: hRows } = await db.query(
      `SELECT COUNT(*) AS n FROM retrieval_contract_history
       WHERE project_id = $1 AND name = 'default'`,
      [projectId]
    );
    if (parseInt(hRows[0].n, 10) === 0) {
      // Fetch the contract's current version and queries for the baseline row.
      const { rows: rcRows } = await db.query(
        `SELECT version, queries FROM retrieval_contract WHERE project_id = $1 AND name = 'default'`,
        [projectId]
      );
      if (rcRows.length > 0) {
        await db.query(
          `INSERT INTO retrieval_contract_history (project_id, name, version, queries, change_note)
           VALUES ($1, 'default', $2, $3::jsonb, 'init baseline')`,
          [projectId, rcRows[0].version, JSON.stringify(rcRows[0].queries)]
        );
      }
    }
    console.log(`  [OK]    retrieval_contract_history baseline ensured (idempotent)`);
  } catch (histErr) {
    console.log(`  [WARN]  retrieval_contract_history baseline failed (non-fatal): ${histErr.message}`);
  }

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

  // Multi-author detection — inform once per invocation; no behavior change today.
  const authorCount = detectMultiAuthor(root);
  if (authorCount > 1) {
    // Re-open DB to persist the flag (init already closed db above).
    try {
      const flagCfg = loadConfig();
      const { Client } = require('pg');
      const flagDb = new Client({
        host: flagCfg.host, port: flagCfg.port,
        database: TARGET_DB, user: flagCfg.user,
      });
      await flagDb.connect();
      await setSetting(flagDb, projectId, 'multi_author_detected', 'true');
      await flagDb.end();
    } catch (_) { /* non-fatal */ }
    process.stderr.write(
      '[handoff] multi-author repo detected — see README#trust-model before relying on CLAUDE.md auto-promotion\n'
    );
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

  // Packaging-honesty probe (read-only — no DB writes).
  let packagingLine = '';
  try {
    const statusRoot   = findProjectRoot();
    const packState    = detectUnpackagedState(statusRoot);
    packagingLine = packState.unpackaged
      ? `  packaging:        UNPACKAGED (${packState.label})`
      : `  packaging:        clean`;
  } catch (_) {
    // Non-fatal — skip display if probe fails for any unexpected reason.
  }

  console.log('\n  === handoff status ===');
  console.log(`  project_id:       ${projectId}`);
  console.log(`  last_close:       ${lastClose} (${daysStr})`);
  console.log(`  handoff.md:       ${fs.existsSync(handoffPath) ? handoffPath : '(missing)'}`);
  console.log(`  entities:         ${entRes.rows[0].n}`);
  console.log(`  assertions:       ${assRes.rows[0].n}`);
  console.log(`  edges:            ${edgRes.rows[0].n}`);
  console.log(`  contracts:        ${contracts}`);
  console.log(`  session_active:   ${sip ? `YES (session_id=${sip})` : 'no'}`);
  if (packagingLine) console.log(packagingLine);

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

  // W3: collect entity names retrieved during the contract loop for cluster expansion.
  const retrievedEntityNames = [];

  // C1: collect assertion ids retrieved during the contract loop for attribution.
  const retrievedAssertionIds = [];

  // C2: read feedback gate once before the loop.
  // When not 'enabled', ALL assertion query SQL is byte-identical to pre-C2 — no outcome_bias
  // term appears anywhere in the query, so disabled mode has zero performance or behavioral impact.
  const feedbackLoopEnabled = await getSetting(db, projectId, 'feedback_loop_enabled', 'disabled');

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
        // W3: capture names for cluster-aware sibling expansion.
        for (const r of rows) retrievedEntityNames.push(r.name);
      }

    } else if (q.type === 'assertion' || q.kind === 'assertion') {
      // C2: When feedback_loop_enabled='enabled', factor outcome_bias into both the suppression
      // threshold and the ORDER BY so that positive bias promotes assertions and negative bias
      // demotes them. effective_confidence = confidence * exp(-decay_rate * age_days) + outcome_bias.
      //
      // Clamp design: outcome_bias is bounded by feedback_bias_clamp on write (see cmdClose).
      // An assertion with confidence=1.0 at the floor and outcome_bias=-clamp could in theory
      // go just below the 1.0 suppression threshold, which is the intended behavior for a
      // repeatedly-unhelpful assertion. We use the same formula for both the WHERE filter and
      // ORDER BY, so they are consistent.
      //
      // When gate is OFF: SQL is byte-identical to the pre-C2 query (no outcome_bias term).
      let assertionQuerySql;
      let assertionQueryParams;
      if (feedbackLoopEnabled === 'enabled') {
        // Gate ON: incorporate outcome_bias into effective_confidence.
        assertionQuerySql = `SELECT id, subject, predicate, object, confidence, source FROM assertions
         WHERE project_id = $1
           AND ($2::text IS NULL OR subject = $2)
           AND suppressed = false
           AND (confidence * exp(-decay_rate * EXTRACT(EPOCH FROM (now() - last_reinforced)) / 86400) + outcome_bias) >= 1.0
         ORDER BY (confidence * exp(-decay_rate * EXTRACT(EPOCH FROM (now() - last_reinforced)) / 86400) + outcome_bias) DESC, last_reinforced DESC LIMIT 30`;
        assertionQueryParams = [projectId, q.filter?.subject || null];
      } else {
        // Gate OFF: byte-identical to pre-C2 query.
        assertionQuerySql = `SELECT id, subject, predicate, object, confidence, source FROM assertions
         WHERE project_id = $1
           AND ($2::text IS NULL OR subject = $2)
           AND suppressed = false
           AND confidence * exp(-decay_rate * EXTRACT(EPOCH FROM (now() - last_reinforced)) / 86400) >= 1.0
         ORDER BY confidence DESC, last_reinforced DESC LIMIT 30`;
        assertionQueryParams = [projectId, q.filter?.subject || null];
      }
      const { rows } = await db.query(assertionQuerySql, assertionQueryParams);
      if (rows.length) {
        const text = rows.map((r) =>
          `- [${r.source}|conf=${r.confidence}] ${r.subject} ${r.predicate} ${r.object}`
        ).join('\n');
        sections.push(`### Assertions\n${text}`);
        tokensUsed      += Math.ceil(text.length / 4);
        assertionsCount += rows.length;
        // C1: record retrieved assertion ids for attribution.
        for (const r of rows) retrievedAssertionIds.push(r.id);
        // 4C: Bump reinforcement timestamps ONLY for the rows actually returned
        // (per-row precision instead of project-wide or subject-wide).  Using
        // id = ANY($1::int[]) ensures last_reinforced reflects real retrieval
        // frequency so decay-based eviction ranking is meaningful (spec §4C +
        // OQ-2: AND suppressed=false prevents bumping suppressed history rows).
        await db.query(
          `UPDATE assertions SET last_reinforced = now(), last_retrieved = now()
           WHERE id = ANY($1::int[])
             AND suppressed = false`,
          [retrievedAssertionIds]
        );
      }

    } else if (q.type === 'recency' || q.kind === 'recency') {
      // C2: Same gate pattern as assertion kind — incorporate outcome_bias when enabled.
      // Gate OFF: byte-identical to pre-C2 query. Gate ON: outcome_bias shifts threshold + rank.
      let recencyQuerySql;
      if (feedbackLoopEnabled === 'enabled') {
        recencyQuerySql = `SELECT id, subject, predicate, object, confidence FROM assertions
         WHERE project_id = $1
           AND suppressed = false
           AND (confidence * exp(-decay_rate * EXTRACT(EPOCH FROM (now() - last_reinforced)) / 86400) + outcome_bias) >= 1.0
         ORDER BY last_reinforced DESC LIMIT 20`;
      } else {
        recencyQuerySql = `SELECT id, subject, predicate, object, confidence FROM assertions
         WHERE project_id = $1
           AND suppressed = false
           AND confidence * exp(-decay_rate * EXTRACT(EPOCH FROM (now() - last_reinforced)) / 86400) >= 1.0
         ORDER BY last_reinforced DESC LIMIT 20`;
      }
      const { rows } = await db.query(recencyQuerySql, [projectId]);
      if (rows.length) {
        const text = rows.map((r) =>
          `- [conf=${r.confidence}] ${r.subject} ${r.predicate} ${r.object}`
        ).join('\n');
        sections.push(`### Recent assertions\n${text}`);
        tokensUsed      += Math.ceil(text.length / 4);
        assertionsCount += rows.length;  // recency queries roll into assertionsCount
        // C1: record retrieved assertion ids for attribution.
        for (const r of rows) retrievedAssertionIds.push(r.id);
      }

    } else if (q.type === 'history' || q.kind === 'history') {
      // 4E history kind: return suppressed rows for a given subject so the caller
      // can inspect the superseded trail without paying the default context cost.
      //
      // Design decisions (per spec §7.3):
      //   - Selects suppressed=true rows only (live rows are covered by assertion kind).
      //   - NO bump: history retrieval must not reinforce suppressed rows (OQ-2).
      //   - Opt-in via contract kind:'history' + filter.subject; never in default contract.
      //   - created_at is included so the caller can reason about temporal ordering.
      //
      // I-2 guard: the default contract ({queries:[]}) contains no history query, so
      // this branch is unreachable in a default session.  Including a history query in
      // the contract is an explicit opt-in that must go through recordContractChange.
      const historySubject = q.filter?.subject || null;
      const { rows: hRows } = await db.query(
        `SELECT id, subject, predicate, object, confidence, source, created_at
         FROM assertions
         WHERE project_id = $1
           AND ($2::text IS NULL OR subject = $2)
           AND suppressed = true
         ORDER BY subject, predicate, created_at DESC
         LIMIT 20`,
        [projectId, historySubject]
      );
      if (hRows.length) {
        const text = hRows.map((r) =>
          `- [${r.source}|conf=${r.confidence}|suppressed|${r.created_at.toISOString()}] ${r.subject} ${r.predicate} ${r.object}`
        ).join('\n');
        sections.push(`### Assertion history (suppressed trail)\n${text}`);
        tokensUsed      += Math.ceil(text.length / 4);
        assertionsCount += hRows.length;
        // No bump — history rows are read-only for decay purposes.
      }

    } else if (q.type === 'graph' || q.kind === 'graph') {
      // Graph kind: recursive-CTE edge traversal from seed entities.
      //
      // Design decisions:
      //   1. Seeds: q.filter.seed (string or array). If absent, fall back to
      //      retrievedEntityNames (so a graph query placed after an entity query
      //      inherits the entity results as seeds). If still no seeds → no-op.
      //   2. Direction: q.filter.direction ∈ 'out'|'in'|'both', default 'out'.
      //   3. Depth: effective = q.filter.max_depth if positive int, else setting
      //      graph_max_depth (default '2'). HARD-clamped to Math.min(effective, 5).
      //   4. Node cap: setting graph_max_nodes (default '25'). Deterministic ordering:
      //      min_depth ASC, weight DESC, entity_name ASC.
      //   5. Recursive CTE with cycle prevention via path array.
      //   6. Gating: graph_retrieval_enabled default 'enabled'. When 'disabled', no-op.
      //   7. Output: strictly additive "### Related (graph)" section.
      //   8. No modification of default contract — default session: byte-identical output.
      //      (Same I-2 guard as the history kind.)
      //
      // REGRESSION GUARD: the default retrieval_contract is NOT modified by this PR.
      // A default session has no graph query, so this branch is unreachable in default
      // sessions — loader output is byte-identical to pre-feature. (I-2 guarantee.)
      try {
        const graphEnabled = await getSetting(db, projectId, 'graph_retrieval_enabled', 'enabled');
        if (graphEnabled !== 'enabled') {
          // Gate off: no-op. Do not add any section or modify tokensUsed.
        } else {
          // Resolve seeds.
          let seeds = [];
          if (q.filter && q.filter.seed != null) {
            seeds = Array.isArray(q.filter.seed) ? q.filter.seed : [q.filter.seed];
            seeds = seeds.filter((s) => typeof s === 'string' && s.length > 0);
          }
          if (seeds.length === 0) {
            seeds = retrievedEntityNames.slice(); // fallback: entities retrieved earlier
          }

          if (seeds.length > 0 && tokensUsed < tokenBudget) {
            // Resolve direction.
            const direction = (q.filter && q.filter.direction) || 'out';

            // Resolve max depth.
            const settingDepth = parseInt(
              await getSetting(db, projectId, 'graph_max_depth', '2'), 10
            );
            const filterDepth = (q.filter && Number.isInteger(q.filter.max_depth) && q.filter.max_depth > 0)
              ? q.filter.max_depth : settingDepth;
            const maxDepth = Math.min(filterDepth, 5); // abuse guard

            // Resolve node cap.
            const maxNodes = parseInt(
              await getSetting(db, projectId, 'graph_max_nodes', '25'), 10
            );

            // Build direction-aware edge join clause.
            // 'out': from_entity → to_entity (follow outgoing edges)
            // 'in':  to_entity → from_entity (follow incoming edges)
            // 'both': union of both directions
            //
            // Recursive CTE structure:
            //   base:      seed entities at depth 0
            //   recursive: join edges in chosen direction, depth + 1, cycle prevention
            // Aggregate reached nodes excluding seeds themselves.
            // All parameterized — no string interpolation of user values.

            let cteReachSql;
            if (direction === 'in') {
              cteReachSql = `
                WITH RECURSIVE graph_traverse(entity_name, depth, weight, from_e, edge_type, to_e, path) AS (
                  -- Base: seeds at depth 0
                  SELECT
                    unnest($2::text[]) AS entity_name,
                    0                  AS depth,
                    1.0::float         AS weight,
                    ''::text           AS from_e,
                    ''::text           AS edge_type,
                    ''::text           AS to_e,
                    ARRAY[unnest($2::text[])] AS path
                  UNION ALL
                  -- Recursive: follow edges INBOUND (to_entity → from_entity)
                  SELECT
                    e.from_entity      AS entity_name,
                    t.depth + 1        AS depth,
                    e.weight           AS weight,
                    e.from_entity      AS from_e,
                    e.edge_type        AS edge_type,
                    e.to_entity        AS to_e,
                    t.path || e.from_entity AS path
                  FROM edges e
                  JOIN graph_traverse t ON e.to_entity = t.entity_name
                  WHERE e.project_id = $1
                    AND t.depth + 1 <= $3
                    AND NOT (e.from_entity = ANY(t.path))
                )
                SELECT
                  entity_name,
                  MIN(depth) AS min_depth,
                  MAX(weight) AS max_weight,
                  (array_agg(from_e ORDER BY depth ASC, weight DESC))[1] AS rep_from,
                  (array_agg(edge_type ORDER BY depth ASC, weight DESC))[1] AS rep_edge_type,
                  (array_agg(to_e ORDER BY depth ASC, weight DESC))[1] AS rep_to
                FROM graph_traverse
                WHERE depth > 0
                  AND NOT (entity_name = ANY($2::text[]))
                GROUP BY entity_name
                ORDER BY min_depth ASC, max_weight DESC, entity_name ASC
                LIMIT $4
              `;
            } else if (direction === 'both') {
              // PostgreSQL recursive CTEs do not allow two recursive references to the
              // working table in a single WITH RECURSIVE. Use two separate CTEs (out + in)
              // and UNION their results before aggregating.
              cteReachSql = `
                WITH RECURSIVE
                gt_out(entity_name, depth, weight, from_e, edge_type, to_e, path) AS (
                  -- Base: seeds at depth 0 (outbound traversal)
                  SELECT
                    unnest($2::text[]) AS entity_name,
                    0                  AS depth,
                    1.0::float         AS weight,
                    ''::text           AS from_e,
                    ''::text           AS edge_type,
                    ''::text           AS to_e,
                    ARRAY[unnest($2::text[])] AS path
                  UNION ALL
                  -- Recursive: follow edges OUTBOUND (from_entity → to_entity)
                  SELECT
                    e.to_entity        AS entity_name,
                    t.depth + 1        AS depth,
                    e.weight           AS weight,
                    e.from_entity      AS from_e,
                    e.edge_type        AS edge_type,
                    e.to_entity        AS to_e,
                    t.path || e.to_entity AS path
                  FROM edges e
                  JOIN gt_out t ON e.from_entity = t.entity_name
                  WHERE e.project_id = $1
                    AND t.depth + 1 <= $3
                    AND NOT (e.to_entity = ANY(t.path))
                ),
                gt_in(entity_name, depth, weight, from_e, edge_type, to_e, path) AS (
                  -- Base: seeds at depth 0 (inbound traversal)
                  SELECT
                    unnest($2::text[]) AS entity_name,
                    0                  AS depth,
                    1.0::float         AS weight,
                    ''::text           AS from_e,
                    ''::text           AS edge_type,
                    ''::text           AS to_e,
                    ARRAY[unnest($2::text[])] AS path
                  UNION ALL
                  -- Recursive: follow edges INBOUND (to_entity → from_entity)
                  SELECT
                    e.from_entity      AS entity_name,
                    t.depth + 1        AS depth,
                    e.weight           AS weight,
                    e.from_entity      AS from_e,
                    e.edge_type        AS edge_type,
                    e.to_entity        AS to_e,
                    t.path || e.from_entity AS path
                  FROM edges e
                  JOIN gt_in t ON e.to_entity = t.entity_name
                  WHERE e.project_id = $1
                    AND t.depth + 1 <= $3
                    AND NOT (e.from_entity = ANY(t.path))
                ),
                combined AS (
                  SELECT entity_name, depth, weight, from_e, edge_type, to_e
                  FROM gt_out WHERE depth > 0 AND NOT (entity_name = ANY($2::text[]))
                  UNION ALL
                  SELECT entity_name, depth, weight, from_e, edge_type, to_e
                  FROM gt_in  WHERE depth > 0 AND NOT (entity_name = ANY($2::text[]))
                )
                SELECT
                  entity_name,
                  MIN(depth) AS min_depth,
                  MAX(weight) AS max_weight,
                  (array_agg(from_e ORDER BY depth ASC, weight DESC))[1] AS rep_from,
                  (array_agg(edge_type ORDER BY depth ASC, weight DESC))[1] AS rep_edge_type,
                  (array_agg(to_e ORDER BY depth ASC, weight DESC))[1] AS rep_to
                FROM combined
                GROUP BY entity_name
                ORDER BY min_depth ASC, max_weight DESC, entity_name ASC
                LIMIT $4
              `;
            } else {
              // Default: 'out' — follow outgoing edges from_entity → to_entity
              cteReachSql = `
                WITH RECURSIVE graph_traverse(entity_name, depth, weight, from_e, edge_type, to_e, path) AS (
                  -- Base: seeds at depth 0
                  SELECT
                    unnest($2::text[]) AS entity_name,
                    0                  AS depth,
                    1.0::float         AS weight,
                    ''::text           AS from_e,
                    ''::text           AS edge_type,
                    ''::text           AS to_e,
                    ARRAY[unnest($2::text[])] AS path
                  UNION ALL
                  -- Recursive: follow edges OUTBOUND (from_entity → to_entity)
                  SELECT
                    e.to_entity        AS entity_name,
                    t.depth + 1        AS depth,
                    e.weight           AS weight,
                    e.from_entity      AS from_e,
                    e.edge_type        AS edge_type,
                    e.to_entity        AS to_e,
                    t.path || e.to_entity AS path
                  FROM edges e
                  JOIN graph_traverse t ON e.from_entity = t.entity_name
                  WHERE e.project_id = $1
                    AND t.depth + 1 <= $3
                    AND NOT (e.to_entity = ANY(t.path))
                )
                SELECT
                  entity_name,
                  MIN(depth) AS min_depth,
                  MAX(weight) AS max_weight,
                  (array_agg(from_e ORDER BY depth ASC, weight DESC))[1] AS rep_from,
                  (array_agg(edge_type ORDER BY depth ASC, weight DESC))[1] AS rep_edge_type,
                  (array_agg(to_e ORDER BY depth ASC, weight DESC))[1] AS rep_to
                FROM graph_traverse
                WHERE depth > 0
                  AND NOT (entity_name = ANY($2::text[]))
                GROUP BY entity_name
                ORDER BY min_depth ASC, max_weight DESC, entity_name ASC
                LIMIT $4
              `;
            }

            const { rows: graphRows } = await db.query(cteReachSql, [
              projectId,
              seeds,
              maxDepth,
              maxNodes,
            ]);

            if (graphRows.length > 0 && tokensUsed < tokenBudget) {
              const graphText = graphRows.map((r) =>
                `- ${r.entity_name} (depth ${r.min_depth}, via ${r.rep_from} -[${r.rep_edge_type}]-> ${r.rep_to})`
              ).join('\n');
              const graphSection = `### Related (graph)\n${graphText}`;
              // Only add if budget allows.
              const cost = Math.ceil(graphSection.length / 4);
              if (tokensUsed + cost <= tokenBudget) {
                sections.push(graphSection);
                tokensUsed += cost;
              }
            }
          }
        }
      } catch (graphErr) {
        // Non-fatal: any error degrades gracefully (no graph section, no crash).
        if (!silent) console.error(`[handoff] graph traversal error (non-fatal): ${graphErr.message}`);
      }

    } else if (q.type === 'vector' || q.kind === 'vector') {
      // Vector search requires Ollama or vLLM — skip gracefully if unavailable.
      sections.push(`### Vector query (${q.query || ''}) — skipped in loader (Phase 3.6 hook)`);
    }
  }

  // ── Retrieval event logging (side-channel, non-fatal) ────────────────────────
  // Insert one retrieval_events row per loader invocation for observability.
  // C1: capture RETURNING id and bulk-insert retrieval_event_assertions rows.
  // Wrapped entirely in try/catch — never throws, never alters return value or output.
  try {
    const kinds = [...new Set(queries.map((q) => q.kind || q.type || 'unknown'))].join(',');
    const queryText = `loader:contract=${contractName};kinds=${kinds};sections=${sections.length}`.slice(0, 1000);
    const sessionId = await getSetting(db, projectId, 'session_in_progress', null);
    const notes = `entities=${entitiesCount};assertions=${assertionsCount};vector=${vectorCount};tokens=${tokensUsed}`.slice(0, 1000);
    const evtRes = await db.query(
      `INSERT INTO retrieval_events (project_id, query_text, session_id, notes)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [projectId, queryText, sessionId || null, notes]
    );
    // C1: attribute the retrieved assertions to this event.
    // Deduplicate ids (recency and assertion queries may overlap) and bulk-insert.
    const eventId = evtRes.rows[0] && evtRes.rows[0].id;
    if (eventId != null && retrievedAssertionIds.length > 0) {
      const uniqueIds = [...new Set(retrievedAssertionIds)];
      // Build VALUES list: ($1, $2), ($1, $3), ...
      const params = [eventId];
      const valuePlaceholders = uniqueIds.map((assertionId, i) => {
        params.push(assertionId);
        return `($1, $${i + 2})`;
      });
      await db.query(
        `INSERT INTO retrieval_event_assertions (event_id, assertion_id) VALUES ${valuePlaceholders.join(', ')}`,
        params
      );
    }
  } catch (evtErr) {
    if (!silent) console.error(`[handoff] retrieval_events insert failed (non-fatal): ${evtErr.message}`);
  }

  // ── W3: cluster-aware sibling expansion (strictly additive, fully gated) ──────
  // Appends a "### Related (community)" section for same-community sibling entities
  // of the entities already retrieved. Fully wrapped in try/catch — any error causes
  // a clean no-op fallback to pre-W3 output. No community run in entity_communities
  // => guaranteed byte-identical pre-W3 output (no regression).
  try {
    const clusterSetting = await getSetting(db, projectId, 'cluster_aware_retrieval', 'enabled');
    if (clusterSetting === 'enabled' && retrievedEntityNames.length > 0 && tokensUsed < tokenBudget) {
      // Find the latest community run for this project.
      const runRes = await db.query(
        `SELECT run_id FROM entity_communities WHERE project_id = $1 ORDER BY computed_at DESC LIMIT 1`,
        [projectId]
      );
      if (runRes.rows.length > 0) {
        const latestRunId = runRes.rows[0].run_id;
        // Find community_ids for the hit entities in this run.
        const communityRes = await db.query(
          `SELECT DISTINCT community_id FROM entity_communities
           WHERE project_id = $1 AND run_id = $2 AND entity_name = ANY($3)`,
          [projectId, latestRunId, retrievedEntityNames]
        );
        if (communityRes.rows.length > 0) {
          const communityIds = communityRes.rows.map((r) => r.community_id);
          const clusterMaxSiblings = parseInt(
            await getSetting(db, projectId, 'cluster_max_siblings', '10'), 10
          );
          // Fetch sibling entities in the same communities, excluding already-retrieved ones.
          const siblingRes = await db.query(
            `SELECT DISTINCT entity_name FROM entity_communities
             WHERE project_id = $1 AND run_id = $2
               AND community_id = ANY($3)
               AND entity_name <> ALL($4)
             LIMIT $5`,
            [projectId, latestRunId, communityIds, retrievedEntityNames, clusterMaxSiblings]
          );
          if (siblingRes.rows.length > 0 && tokensUsed < tokenBudget) {
            const siblingText = siblingRes.rows.map((r) => `- ${r.entity_name}`).join('\n');
            sections.push(`### Related (community)\n${siblingText}`);
            tokensUsed += Math.ceil(siblingText.length / 4);
          }
        }
      }
    }
  } catch (clusterErr) {
    // Non-fatal: any error degrades gracefully to pre-W3 output (no expansion).
    if (!silent) console.error(`[handoff] W3 cluster expansion error (non-fatal): ${clusterErr.message}`);
  }

  if (ownDb) await db.end();

  // Assemble output text (same content whether silent or not).
  // All retrieved content is wrapped with trust-boundary labels — unconditional
  // hygiene for both solo and multi-author repos. "untrusted" is the correct label
  // on a public repo where PR/code review content may flow into Claude sessions.
  const outputParts = [];
  // Trusted canon is always the first element — never inside the untrusted delimiters.
  outputParts.push(OPERATING_CANON);
  const retrievedParts = [];

  if (fs.existsSync(handoffPath)) {
    const raw  = fs.readFileSync(handoffPath, 'utf8');
    const body = raw.replace(/^---[\s\S]*?---\r?\n/, '');
    retrievedParts.push('=== Handoff context ===');
    retrievedParts.push(body.trim());
  }

  if (sections.length) {
    retrievedParts.push('=== Retrieved context (contract: ' + contractName + ') ===');
    retrievedParts.push(sections.join('\n'));
  }

  if (retrievedParts.length) {
    outputParts.push('=== BEGIN RETRIEVED CONTEXT (untrusted) ===');
    outputParts.push(retrievedParts.join('\n'));
    outputParts.push('=== END RETRIEVED CONTEXT ===');
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
 * 4A — Cardinality-aware write-time supersession helper.
 *
 * For each incoming assertion, execute the two-step suppress+INSERT within an
 * explicit transaction so the pair is atomic (spec §4A mechanism-a):
 *
 *   1:1 predicate — suppress any existing live row for (project_id, subject, predicate).
 *   1:N predicate — suppress only an exact duplicate (project_id, subject, predicate, object).
 *   Unrecognized  — permissive fallback → treat as 1:N (classifyPredicate handles this).
 *
 * COHERENCE CONTRACT (OQ-5): the WHERE-key used here is the canonical supersession key.
 * The 4D distillation migration script applies the same key directly; shared test fixtures
 * enforce correctness of both paths.  The steady-state write path (this function) and the
 * migration MUST NOT diverge in their key selection.
 *
 * @param {object} db            — pg Client
 * @param {string} projectId     — encoded_cwd
 * @param {object} ass           — assertion object: {subject, predicate, object, confidence, source}
 * @param {string} sessionId     — session_id (may be null)
 * @param {string} registryMode  — 'permissive'|'strict'
 * @returns {boolean} true if the row was inserted; false if skipped (strict unrecognized)
 */
async function writeAssertionWithSupersession(db, projectId, ass, sessionId, registryMode) {
  // Classify predicate cardinality.  strict throws for unrecognized; permissive returns 1:N.
  let cardinality;
  try {
    const classification = classifyPredicate(ass.predicate, registryMode);
    if (!classification.recognized && registryMode !== 'strict') {
      process.stderr.write(
        `[handoff] unrecognized predicate "${ass.predicate}" — registry permissive mode, treated 1:N (flag for registry extension)\n`
      );
    }
    cardinality = classification.cardinality;
  } catch (regErr) {
    // strict mode: skip
    process.stderr.write(
      `[handoff] skipping assertion (predicate="${ass.predicate}"): ${regErr.message}\n`
    );
    return false;
  }

  const conf   = Math.min(10, Math.max(1, parseFloat(ass.confidence) || 5));
  const source = ['user_stated', 'model_extracted', 'doc_quoted', 'retrieved_from_prior'].includes(ass.source)
    ? ass.source : 'model_extracted';

  // Wrap suppress+INSERT in an explicit transaction (atomicity requirement I-A mechanism-a).
  await db.query('BEGIN');
  try {
    if (cardinality === '1:1') {
      // Suppress any existing live row for this (project_id, subject, predicate) pair.
      await db.query(
        `UPDATE assertions SET suppressed = true
         WHERE project_id = $1
           AND subject    = $2
           AND predicate  = $3
           AND suppressed = false`,
        [projectId, ass.subject, ass.predicate]
      );
    } else {
      // 1:N: suppress only an exact (project_id, subject, predicate, object) duplicate.
      await db.query(
        `UPDATE assertions SET suppressed = true
         WHERE project_id = $1
           AND subject    = $2
           AND predicate  = $3
           AND object     = $4
           AND suppressed = false`,
        [projectId, ass.subject, ass.predicate, ass.object]
      );
    }

    await db.query(
      `INSERT INTO assertions (project_id, subject, predicate, object, confidence, source, session_id, last_reinforced)
       VALUES ($1, $2, $3, $4, $5, $6, $7, now())`,
      [projectId, ass.subject, ass.predicate, ass.object, conf, source, sessionId]
    );

    await db.query('COMMIT');
  } catch (err) {
    try { await db.query('ROLLBACK'); } catch (_) { /* ignore */ }
    throw err;
  }

  return true;
}

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

  // Assertions — 4A: cardinality-aware two-step supersession via writeAssertionWithSupersession.
  // Each assertion is processed through suppress+INSERT within an explicit transaction
  // (atomicity requirement I-A mechanism-a).  Predicate cardinality is looked up via
  // classifyPredicate(predicate, registryMode); 1:1 predicates suppress any prior live row
  // for the same (project_id, subject, predicate); 1:N predicates suppress only exact
  // (project_id, subject, predicate, object) duplicates.
  const registryMode = await getSetting(db, projectId, 'predicate_registry_mode', 'permissive');

  for (const ass of (payload.assertions || [])) {
    if (!ass.subject || !ass.predicate || !ass.object) continue;
    const inserted = await writeAssertionWithSupersession(db, projectId, ass, sessionId, registryMode);
    if (inserted) assertionsWritten++;
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

  // Retrieval contract change — versioned and history-recorded (non-fatal).
  if (payload.contract && typeof payload.contract === 'object') {
    const changeNote = `close session=${payload.session_id || 'unknown'}`;
    try {
      await recordContractChange(db, projectId, 'default', payload.contract, changeNote);
    } catch (contractErr) {
      process.stderr.write(`[handoff] contract history record failed (non-fatal): ${contractErr.message}\n`);
    }
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

  // ── Async extraction gate (opt-in, default OFF = synchronous as before) ──────
  // When extraction_async_enabled='true', validate the payload and enqueue it for
  // the deterministic background worker (queue-drain subcommand) instead of writing
  // synchronously. Default ('false') is fully unchanged from prior behavior.
  const asyncMode      = await getSetting(db, projectId, 'extraction_async_enabled', 'false');
  const registryMode   = await getSetting(db, projectId, 'predicate_registry_mode', 'permissive');

  let entitiesWritten   = 0;
  let assertionsWritten = 0;
  let edgesWritten      = 0;

  if (asyncMode === 'true') {
    // Async path: validate then enqueue; do NOT write assertions/entities/edges now.
    const validation = validatePayload(payload, registryMode);

    // Emit warnings to stderr (permissive mode).
    for (const w of validation.warnings) {
      process.stderr.write(`[handoff] checkpoint async: ${w}\n`);
    }

    // In strict mode, filter out assertions with errors; emit each skipped assertion to stderr.
    // We skip-and-continue — never abort the checkpoint.
    let payloadToEnqueue = payload;
    if (registryMode === 'strict' && validation.errors.length > 0) {
      for (const e of validation.errors) {
        process.stderr.write(`[handoff] checkpoint async strict: skipping assertion — ${e}\n`);
      }
      // Build a filtered payload with only clean assertions.
      const badIndices = new Set(
        validation.errors
          .map((e) => { const m = e.match(/^assertions\[(\d+)\]/); return m ? parseInt(m[1], 10) : null; })
          .filter((n) => n !== null)
      );
      payloadToEnqueue = Object.assign({}, payload, {
        assertions: (payload.assertions || []).filter((_, i) => !badIndices.has(i)),
      });
    }

    const sourceRef = payload.session_id || null;
    await db.query(
      `INSERT INTO extraction_queue (project_id, payload, source_ref, status, enqueued_at)
       VALUES ($1, $2::jsonb, $3, 'pending', now())`,
      [projectId, JSON.stringify(payloadToEnqueue), sourceRef]
    );

    const assertionCount = (payloadToEnqueue.assertions || []).length;
    const entityCount    = (payloadToEnqueue.entities   || []).length;
    const edgeCount      = (payloadToEnqueue.edges      || []).length;
    console.log(
      `\n  queued for async extraction: ${entityCount} entities, ${assertionCount} assertions, ${edgeCount} edges`
    );
    if (validation.warnings.length > 0) {
      console.log(`  predicate warnings: ${validation.warnings.length} (see stderr)`);
    }
    if (registryMode === 'strict' && validation.errors.length > 0) {
      console.log(`  predicate strict-mode skips: ${validation.errors.length} (see stderr)`);
    }

    // Update handoff.md (reflects enqueue, not yet written to DB)
    const stamp = new Date().toISOString();
    writeHandoffMd(handoffPath, {
      PROJECT_ID:          projectId,
      LAST_CLOSE:          stamp,
      CONTRACT:            payload.contract ? 'default' : (readHandoffFrontmatter(handoffPath).contract || 'default'),
      ENTITIES_WRITTEN:    '0 (queued)',
      ASSERTIONS_WRITTEN:  '0 (queued)',
      EDGES_WRITTEN:       '0 (queued)',
      PROJECT_NAME:        path.basename(root),
      TLDR:                payload.tldr || '(checkpoint — async queued)',
      OPEN_THREADS:        (payload.open_threads || []).map((t) => `- ${t}`).join('\n') || '- (none)',
      QUICK_REFERENCES:    payload.quick_references || '(none)',
    });

    // Clear session_in_progress so the Stop hook treats this checkpoint as an explicit save.
    await db.query(
      `DELETE FROM project_settings WHERE project_id = $1 AND key = 'session_in_progress'`,
      [projectId]
    );

    await db.end();

    console.log(`\nDone: handoff:checkpoint — payload queued for async extraction (session marker cleared)`);
    return;
  }

  // ── Synchronous path (default) — unchanged behavior ──────────────────────────
  const extraction = await writeExtraction(db, projectId, payload);
  entitiesWritten   = extraction.entitiesWritten;
  assertionsWritten = extraction.assertionsWritten;
  edgesWritten      = extraction.edgesWritten;

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

  // ── Async extraction gate (opt-in, default OFF = synchronous as before) ──────
  // When extraction_async_enabled='true', validate the payload and enqueue it for
  // the deterministic background worker (queue-drain subcommand). The whole payload
  // (entities + assertions + edges + contract) goes on the queue; the worker calls
  // writeExtraction() so behavior is equivalent, just deferred.
  // Default ('false') is fully unchanged from prior behavior.
  const asyncMode    = await getSetting(db, projectId, 'extraction_async_enabled', 'false');
  const registryMode = await getSetting(db, projectId, 'predicate_registry_mode', 'permissive');

  if (asyncMode === 'true') {
    // Async path: validate then enqueue; skip synchronous writeExtraction().
    const validation = validatePayload(payload, registryMode);

    // Emit warnings to stderr (permissive mode).
    for (const w of validation.warnings) {
      process.stderr.write(`[handoff] close async: ${w}\n`);
    }

    // Strict mode: filter out assertions that fail vocabulary check; skip-and-continue.
    let payloadToEnqueue = payload;
    if (registryMode === 'strict' && validation.errors.length > 0) {
      for (const e of validation.errors) {
        process.stderr.write(`[handoff] close async strict: skipping assertion — ${e}\n`);
      }
      const badIndices = new Set(
        validation.errors
          .map((e) => { const m = e.match(/^assertions\[(\d+)\]/); return m ? parseInt(m[1], 10) : null; })
          .filter((n) => n !== null)
      );
      payloadToEnqueue = Object.assign({}, payload, {
        assertions: (payload.assertions || []).filter((_, i) => !badIndices.has(i)),
      });
    }

    const sourceRef = payload.session_id || null;
    await db.query(
      `INSERT INTO extraction_queue (project_id, payload, source_ref, status, enqueued_at)
       VALUES ($1, $2::jsonb, $3, 'pending', now())`,
      [projectId, JSON.stringify(payloadToEnqueue), sourceRef]
    );

    const assertionCount = (payloadToEnqueue.assertions || []).length;
    const entityCount    = (payloadToEnqueue.entities   || []).length;
    const edgeCount      = (payloadToEnqueue.edges      || []).length;
    console.log(
      `\n  queued for async extraction: ${entityCount} entities, ${assertionCount} assertions, ${edgeCount} edges`
    );
    if (validation.warnings.length > 0) {
      console.log(`  predicate warnings: ${validation.warnings.length} (see stderr)`);
    }
    if (registryMode === 'strict' && validation.errors.length > 0) {
      console.log(`  predicate strict-mode skips: ${validation.errors.length} (see stderr)`);
    }

    // Update handoff.md (reflects enqueue, not yet written to DB)
    const queueStamp = new Date().toISOString();
    writeHandoffMd(handoffPath, {
      PROJECT_ID:          projectId,
      LAST_CLOSE:          queueStamp,
      CONTRACT:            'default',
      ENTITIES_WRITTEN:    '0 (queued)',
      ASSERTIONS_WRITTEN:  '0 (queued)',
      EDGES_WRITTEN:       '0 (queued)',
      PROJECT_NAME:        path.basename(root),
      TLDR:                payload.tldr || '(closed — async queued)',
      OPEN_THREADS:        (payload.open_threads || []).map((t) => `- ${t}`).join('\n') || '- (none)',
      QUICK_REFERENCES:    payload.quick_references || '(none)',
    });

    // Clear session_in_progress marker
    await db.query(
      `DELETE FROM project_settings WHERE project_id = $1 AND key = 'session_in_progress'`,
      [projectId]
    );

    await db.end();

    console.log(`\n  entities:    0 (queued)`);
    console.log(`  assertions:  0 (queued)`);
    console.log(`  edges:       0 (queued)`);
    console.log(`  contract:    queued`);
    console.log(`\nDone: handoff:close — payload queued for async extraction, session marker cleared`);
    return;
  }

  // ── Synchronous path (default) — unchanged behavior ──────────────────────────
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
      const existing  = fs.readFileSync(claudeMdPath, 'utf8');
      const today     = new Date().toISOString().slice(0, 10);
      const sessionId = payload.session_id || 'unknown';
      const additions = candidates.map((r) => {
        const annotation = `<!-- promoted: session=${sessionId}, conf=${r.confidence}, date=${today}, source_assertion=${r.id} -->`;
        const factLine   = `- [conf=${r.confidence}] ${r.subject} ${r.predicate} ${r.object}`;
        return `${annotation}\n${factLine}`;
      }).join('\n');
      const durableFacts = existing.includes('## Durable facts')
        ? existing.replace(/## Durable facts\n.*?\n- \(No durable facts.*?\)\n/s,
            `## Durable facts\n${additions}\n`)
        : existing + `\n## Durable facts\n${additions}\n`;
      fs.writeFileSync(claudeMdPath, durableFacts, 'utf8');
      console.log(`\n  CLAUDE.md updated with ${candidates.length} durable fact(s).`);
    }
  }

  // Multi-author detection — inform once per invocation; no behavior change today.
  const closeAuthorCount = detectMultiAuthor(root);
  if (closeAuthorCount > 1) {
    try {
      await setSetting(db, projectId, 'multi_author_detected', 'true');
    } catch (_) { /* non-fatal */ }
    process.stderr.write(
      '[handoff] multi-author repo detected — see README#trust-model before relying on CLAUDE.md auto-promotion\n'
    );
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

  // ── Retrieval outcome capture (non-fatal) ─────────────────────────────────────
  // Must run BEFORE session_in_progress is cleared (we need the session id).
  // Order: self-report first, then timeout-decay sweep (so just-reported rows are
  // not also swept).
  try {
    // 1. Resolve session id: payload.session_id takes precedence, then the DB marker.
    const closeSessionId = (typeof payload.session_id === 'string' && payload.session_id.length > 0)
      ? payload.session_id
      : await getSetting(db, projectId, 'session_in_progress', null);

    // 2. Agent self-report: update pending events for this session.
    if (payload.retrieval_outcome) {
      if (closeSessionId) {
        const selfRes = await db.query(
          `UPDATE retrieval_events
           SET outcome = $2, outcome_at = now(), outcome_signal = 'agent_self_report',
               notes = COALESCE($3, notes)
           WHERE project_id = $1 AND outcome = 'pending' AND session_id = $4`,
          [projectId, payload.retrieval_outcome, payload.retrieval_outcome_notes || null, closeSessionId]
        );
        console.log(`  retrieval outcome: marked ${selfRes.rowCount} pending event(s) ${payload.retrieval_outcome} (signal=agent_self_report)`);
      } else {
        process.stderr.write('[handoff] retrieval_outcome set but no session id resolvable — self-report skipped\n');
      }
    }

    // 3. Timeout-decay sweep: flip stale pending events to irrelevant.
    const timeoutDays = parseInt(await getSetting(db, projectId, 'retrieval_outcome_timeout_days', '14'), 10);
    const decayRes = await db.query(
      `UPDATE retrieval_events
       SET outcome = 'irrelevant', outcome_at = now(), outcome_signal = 'timeout_decay'
       WHERE project_id = $1 AND outcome = 'pending'
         AND retrieved_at < now() - ($2 || ' days')::interval`,
      [projectId, String(timeoutDays)]
    );
    if (decayRes.rowCount > 0) {
      console.log(`  retrieval outcome: ${decayRes.rowCount} stale pending event(s) decayed to irrelevant (signal=timeout_decay)`);
    }
  } catch (outcomeErr) {
    process.stderr.write(`[handoff] retrieval outcome capture failed (non-fatal): ${outcomeErr.message}\n`);
  }

  // ── C2: Outcome→bias feedback application (non-fatal, gated, batch at close) ────────────────
  //
  // Formula:
  //   delta = sum(success_count * success_delta
  //             + failure_count * failure_delta
  //             + irrelevant_count * irrelevant_delta)
  //   new_bias = CLAMP(old_bias + delta, -clamp, +clamp)
  //
  // Idempotency guard: we only consider retrieval_events that were outcome-set
  // (outcome != 'pending') for THIS session. We use a processed-marker in
  // project_settings keyed as 'feedback_applied:<sessionId>' to detect re-runs.
  // On re-run the marker already exists → we skip silently (true idempotency).
  // The marker is only written after a successful feedback application pass.
  //
  // Session resolution: same logic as the outcome capture block above — payload.session_id
  // takes precedence, then the DB marker. Both are read before session_in_progress is cleared.
  try {
    const feedbackEnabled = await getSetting(db, projectId, 'feedback_loop_enabled', 'disabled');
    if (feedbackEnabled === 'enabled') {
      // Re-resolve session id (same approach as outcome capture, before marker is cleared).
      const fbSessionId = (typeof payload.session_id === 'string' && payload.session_id.length > 0)
        ? payload.session_id
        : await getSetting(db, projectId, 'session_in_progress', null);

      if (!fbSessionId) {
        // No session id — skip silently (nothing to attribute).
        process.stderr.write('[handoff] C2 feedback: no session id resolvable — skipping bias update\n');
      } else {
        // Idempotency check: if we have already applied feedback for this session, skip.
        const markerKey = `feedback_applied:${fbSessionId}`;
        const alreadyApplied = await getSetting(db, projectId, markerKey, null);
        if (alreadyApplied !== null) {
          console.log(`  C2 feedback: already applied for session ${fbSessionId} — skipping (idempotent)`);
        } else {
          // Read tunable deltas and clamp.
          const successDelta    = parseFloat(await getSetting(db, projectId, 'feedback_success_delta',    '0.5'));
          const failureDelta    = parseFloat(await getSetting(db, projectId, 'feedback_failure_delta',    '-0.75'));
          const irrelevantDelta = parseFloat(await getSetting(db, projectId, 'feedback_irrelevant_delta', '-0.25'));
          const biasClamp       = parseFloat(await getSetting(db, projectId, 'feedback_bias_clamp',       '3.0'));

          // Aggregate per assertion: count outcomes across this session's events.
          // Join: retrieval_events (session, non-pending) → retrieval_event_assertions → assertions.
          const aggRes = await db.query(
            `SELECT
               rea.assertion_id,
               SUM(CASE WHEN re.outcome = 'success'    THEN 1 ELSE 0 END)    AS success_count,
               SUM(CASE WHEN re.outcome = 'failure'    THEN 1 ELSE 0 END)    AS failure_count,
               SUM(CASE WHEN re.outcome = 'irrelevant' THEN 1 ELSE 0 END)    AS irrelevant_count
             FROM retrieval_events re
             JOIN retrieval_event_assertions rea ON rea.event_id = re.id
             WHERE re.project_id = $1
               AND re.session_id = $2
               AND re.outcome != 'pending'
             GROUP BY rea.assertion_id`,
            [projectId, fbSessionId]
          );

          if (aggRes.rows.length > 0) {
            // Apply bounded delta to each assertion's outcome_bias.
            for (const row of aggRes.rows) {
              const delta =
                row.success_count    * successDelta +
                row.failure_count    * failureDelta +
                row.irrelevant_count * irrelevantDelta;
              // CLAMP via GREATEST/LEAST in SQL for atomicity.
              await db.query(
                `UPDATE assertions
                 SET outcome_bias = GREATEST($2::float, LEAST($3::float, outcome_bias + $4::float))
                 WHERE id = $1`,
                [row.assertion_id, -biasClamp, biasClamp, delta]
              );
            }
            console.log(`  C2 feedback: adjusted outcome_bias for ${aggRes.rows.length} assertion(s) (session=${fbSessionId})`);
          } else {
            console.log(`  C2 feedback: no attributed outcomes found for session ${fbSessionId} — nothing to adjust`);
          }

          // Write idempotency marker — keyed per session so it does not collide across sessions.
          // Value is the ISO timestamp of this application pass.
          await setSetting(db, projectId, markerKey, new Date().toISOString());
        }
      }
    }
  } catch (feedbackErr) {
    // Fully non-fatal: any error here must not break cmdClose.
    process.stderr.write(`[handoff] C2 feedback application failed (non-fatal): ${feedbackErr.message}\n`);
  }

  // ── C3: Learnable contracts — auto-evolve retrieval_contract from outcome patterns ─────────────
  //
  // Rules engine executed at close (non-fatal, fully gated). Fires only when
  // contract_evolution_enabled='enabled'. When not 'enabled', zero contract mutation occurs
  // and cmdClose output/behavior is byte-identical to pre-C3.
  //
  // Gate is INDEPENDENT of feedback_loop_enabled: contract evolution is driven purely by
  // retrieval_events.outcome aggregated per query kind, not by assertions.outcome_bias.
  // This means evolution can be evaluated even when the C2 bias feedback loop is off.
  //
  // Evolution rule set (deterministic, documented):
  //
  //   RULE 1 — UNDERPERFORMING KIND BUDGET REDUCTION:
  //     For each kind present in recent retrieval events (within the rolling window):
  //       If kind's (failure + irrelevant) rate > failure_threshold
  //         AND sample count >= min_events:
  //       → Reduce that kind's token_budget by budget_step (bounded below by budget_floor).
  //       Applied to at most one kind per pass (the worst performer) — gradual, recoverable.
  //
  //   RULE 2 — REALLOCATION TO BEST PERFORMER:
  //     Simultaneously with Rule 1, if a reduction was made:
  //       The best-performing kind (lowest failure+irrelevant rate, >= min_events) gains
  //       the budget that was removed from the underperformer, capped so total budget stays
  //       within the original contract envelope (sum of all kind budgets unchanged).
  //
  //   INVARIANTS:
  //     - No kind is ever deleted (min budget floor enforced, not zero).
  //     - Total token budget stays within the original envelope (±budget_step rounding).
  //     - At most one budget reduction per close pass (gradual — bad signal is recoverable via rollback CLI).
  //     - If the worst performer's kind is not present in the live contract, no evolution occurs.
  //     - Evolution is skipped when any kind has fewer than min_events in the window (thin data guard).
  //
  // Idempotency: marker key 'contract_evolved:<sessionId>' in project_settings prevents
  // re-evaluation for a session that has already been processed.
  //
  // Non-fatal: any failure inside this block is caught and logged to stderr; cmdClose continues.
  // Rollback: use `node scripts/bundleb-w4-contract.js rollback <prior_version>` to revert.
  try {
    const evolutionEnabled = await getSetting(db, projectId, 'contract_evolution_enabled', 'disabled');
    if (evolutionEnabled === 'enabled') {
      // Resolve session id (same approach as C2 — payload takes precedence, then DB marker).
      const evolSessionId = (typeof payload.session_id === 'string' && payload.session_id.length > 0)
        ? payload.session_id
        : await getSetting(db, projectId, 'session_in_progress', null);

      if (!evolSessionId) {
        process.stderr.write('[handoff] C3 evolution: no session id resolvable — skipping\n');
      } else {
        // Idempotency check: skip if we already processed this session.
        const evolMarkerKey   = `contract_evolved:${evolSessionId}`;
        const alreadyEvolved  = await getSetting(db, projectId, evolMarkerKey, null);
        if (alreadyEvolved !== null) {
          console.log(`  C3 evolution: already applied for session ${evolSessionId} — skipping (idempotent)`);
        } else {
          // Read tunable parameters.
          const windowDays        = parseInt(await getSetting(db, projectId, 'contract_evolution_window_days',        '30'),  10);
          const minEvents         = parseInt(await getSetting(db, projectId, 'contract_evolution_min_events',         '10'),  10);
          const failureThreshold  = parseFloat(await getSetting(db, projectId, 'contract_evolution_failure_threshold', '0.5'));
          const budgetFloor       = parseInt(await getSetting(db, projectId, 'contract_evolution_budget_floor',       '200'), 10);
          const budgetStep        = parseInt(await getSetting(db, projectId, 'contract_evolution_budget_step',         '200'), 10);

          // Read the active contract name from handoff.md frontmatter (mirrors loader logic).
          const evolFm       = readHandoffFrontmatter(resolveHandoffMdPath(projectId));
          const contractName = evolFm.contract || 'default';

          // Load the live contract.
          const { rows: rcRows } = await db.query(
            `SELECT queries, version FROM retrieval_contract
             WHERE project_id = $1 AND name = $2`,
            [projectId, contractName]
          );
          if (rcRows.length === 0) {
            process.stderr.write(`[handoff] C3 evolution: contract '${contractName}' not found — skipping\n`);
          } else {
            const liveContract = rcRows[0].queries;
            const liveQueries  = Array.isArray(liveContract) ? liveContract : (liveContract.queries || []);

            // Only proceed if the contract has at least one query with a token_budget.
            const queriesWithBudget = liveQueries.filter((q) => typeof q.token_budget === 'number');
            if (queriesWithBudget.length === 0) {
              process.stderr.write(`[handoff] C3 evolution: contract '${contractName}' has no queries with token_budget — skipping\n`);
            } else {
              // Aggregate outcome counts per kind from retrieval_events in the rolling window.
              // query_text encodes kinds as 'loader:contract=<name>;kinds=<k1,k2,...>;sections=<n>'.
              // We extract individual kind tokens by splitting on commas and semicolons.
              const { rows: evtRows } = await db.query(
                `SELECT query_text, outcome
                 FROM retrieval_events
                 WHERE project_id = $1
                   AND outcome IN ('success', 'failure', 'irrelevant')
                   AND retrieved_at >= now() - ($2 || ' days')::interval`,
                [projectId, String(windowDays)]
              );

              // Parse per-kind outcome counts from query_text.
              // Format: 'loader:contract=<name>;kinds=<k1,k2,...>;sections=<n>'
              const kindStats = {};  // kind → { success, failure, irrelevant, total }
              for (const row of evtRows) {
                const kindsMatch = (row.query_text || '').match(/kinds=([^;]+)/);
                if (!kindsMatch) continue;
                const kinds = kindsMatch[1].split(',').map((k) => k.trim()).filter(Boolean);
                for (const kind of kinds) {
                  if (!kindStats[kind]) kindStats[kind] = { success: 0, failure: 0, irrelevant: 0, total: 0 };
                  if (row.outcome === 'success')    kindStats[kind].success++;
                  if (row.outcome === 'failure')    kindStats[kind].failure++;
                  if (row.outcome === 'irrelevant') kindStats[kind].irrelevant++;
                  kindStats[kind].total++;
                }
              }

              // Identify kinds that meet the minimum event threshold.
              const qualifyingKinds = Object.entries(kindStats).filter(([, s]) => s.total >= minEvents);

              if (qualifyingKinds.length === 0) {
                console.log(`  C3 evolution: insufficient data (all kinds below min_events=${minEvents} in ${windowDays}d window) — no evolution`);
              } else {
                // Compute failure rate per qualifying kind.
                const ratedKinds = qualifyingKinds.map(([kind, s]) => ({
                  kind,
                  total:       s.total,
                  failureRate: (s.failure + s.irrelevant) / s.total,
                }));

                // Sort descending by failure rate (worst first).
                ratedKinds.sort((a, b) => b.failureRate - a.failureRate);
                const worstKind = ratedKinds[0];
                const bestKind  = ratedKinds[ratedKinds.length - 1];

                if (worstKind.failureRate <= failureThreshold) {
                  console.log(`  C3 evolution: no kind exceeds failure threshold ${failureThreshold} (worst: ${worstKind.kind} @ ${worstKind.failureRate.toFixed(2)}) — no evolution`);
                } else if (worstKind.kind === bestKind.kind) {
                  console.log(`  C3 evolution: only one qualifying kind; cannot reallocate — no evolution`);
                } else {
                  // Find the underperformer and best performer in the live contract queries.
                  const worstIdx = liveQueries.findIndex((q) => (q.kind || q.type) === worstKind.kind);
                  const bestIdx  = liveQueries.findIndex((q) => (q.kind || q.type) === bestKind.kind);

                  if (worstIdx === -1) {
                    process.stderr.write(`[handoff] C3 evolution: worst kind '${worstKind.kind}' not in live contract — skipping\n`);
                  } else {
                    // Clone queries for mutation.
                    const newQueries = liveQueries.map((q) => Object.assign({}, q));

                    const currentBudget = typeof newQueries[worstIdx].token_budget === 'number'
                      ? newQueries[worstIdx].token_budget : 0;
                    const actualReduction = Math.min(budgetStep, Math.max(0, currentBudget - budgetFloor));

                    if (actualReduction === 0) {
                      console.log(`  C3 evolution: '${worstKind.kind}' already at budget floor (${budgetFloor}) — no evolution`);
                    } else {
                      // Apply reduction to worst kind.
                      newQueries[worstIdx] = Object.assign({}, newQueries[worstIdx], {
                        token_budget: currentBudget - actualReduction,
                      });

                      // Reallocate gained budget to best kind (if in contract and different from worst).
                      if (bestIdx !== -1 && bestIdx !== worstIdx) {
                        const bestCurrent = typeof newQueries[bestIdx].token_budget === 'number'
                          ? newQueries[bestIdx].token_budget : 0;
                        newQueries[bestIdx] = Object.assign({}, newQueries[bestIdx], {
                          token_budget: bestCurrent + actualReduction,
                        });
                      }

                      const newQueriesObj = { queries: newQueries };
                      const changeNote = [
                        `auto-evolve: reduced '${worstKind.kind}' by ${actualReduction}`,
                        bestIdx !== -1 && bestIdx !== worstIdx
                          ? ` → reallocated to '${bestKind.kind}'`
                          : '',
                        ` (failureRate=${worstKind.failureRate.toFixed(2)}>threshold=${failureThreshold},`,
                        ` window=${windowDays}d, n=${worstKind.total})`,
                      ].join('');

                      await recordContractChange(db, projectId, contractName, newQueriesObj, changeNote);
                      console.log(`  C3 evolution: applied — ${changeNote}`);

                      // Write idempotency marker.
                      await setSetting(db, projectId, evolMarkerKey, new Date().toISOString());
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  } catch (evolutionErr) {
    // Fully non-fatal: any error here must not break cmdClose.
    process.stderr.write(`[handoff] C3 contract evolution failed (non-fatal): ${evolutionErr.message}\n`);
  }

  // ── Packaging-honesty probe (non-fatal, synchronous close path only) ─────────
  //
  // Detects whether the session's work is already committed and pushed.
  // Writes a 1:1 assertion (superseding the prior session's row) so the close
  // record is "true to itself" — next-session resume will see the actual state.
  // NEVER blocks, commits, stashes, pushes, or mutates the repository.
  try {
    const packState    = detectUnpackagedState(root);
    const closeSessionId = (typeof payload.session_id === 'string' && payload.session_id.length > 0)
      ? payload.session_id
      : await getSetting(db, projectId, 'session_in_progress', null);

    const packSubject = `${path.basename(root)} working tree`;
    const packObject  = packState.unpackaged ? packState.label : 'clean';

    await writeAssertionWithSupersession(db, projectId, {
      subject:    packSubject,
      predicate:  'has_unpackaged_state',
      object:     packObject,
      confidence: 8,
      source:     'model_extracted',
    }, closeSessionId, registryMode);

    if (packState.unpackaged) {
      console.log(`\n  packaging:           UNPACKAGED — ${packState.label}`);
      console.log('  (session work is not fully committed/pushed; close record reflects actual state)');
    } else {
      console.log(`\n  packaging:           clean`);
    }
  } catch (packErr) {
    process.stderr.write(`[handoff] packaging-honesty probe failed (non-fatal): ${packErr.message}\n`);
  }

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

// ── promote ───────────────────────────────────────────────────────────────────

/**
 * Explicitly promote a single assertion to CLAUDE.md durable facts.
 * Idempotent: re-running on an already-promoted assertion prints a notice and exits 0.
 *
 * Usage: node scripts/handoff.js promote <assertion_id>
 *   assertion_id — integer primary key from the assertions table.
 */
async function cmdPromote(args) {
  const idArg = args[0];
  if (!idArg) {
    console.error('Usage: node scripts/handoff.js promote <assertion_id>');
    process.exit(2);
  }
  const assertionId = parseInt(idArg, 10);
  if (isNaN(assertionId)) {
    console.error(`promote: invalid assertion_id "${idArg}" — must be an integer`);
    process.exit(2);
  }

  const root        = findProjectRoot();
  const projectId   = resolveProjectId();
  const claudeMdPath = path.join(root, 'CLAUDE.md');

  let db;
  try {
    db = await connectHandoff();
  } catch (err) {
    console.error(`DB connection failed: ${err.message}`);
    process.exit(1);
  }

  // Look up the assertion.
  const { rows } = await db.query(
    `SELECT id, project_id, subject, predicate, object, confidence, source, promoted, promoted_at
     FROM assertions WHERE id = $1`,
    [assertionId]
  );

  if (rows.length === 0) {
    await db.end();
    console.error(`promote: assertion id=${assertionId} not found`);
    process.exit(2);
  }

  const row = rows[0];

  // Idempotent: already promoted.
  if (row.promoted) {
    await db.end();
    const promotedDate = row.promoted_at
      ? new Date(row.promoted_at).toISOString().slice(0, 10)
      : '(unknown date)';
    console.log(`already promoted on ${promotedDate}: [conf=${row.confidence}] ${row.subject} ${row.predicate} ${row.object}`);
    process.exit(0);
  }

  // Build the annotation + fact line using the same template as cmdClose auto-promotion.
  const today     = new Date().toISOString().slice(0, 10);
  const annotation = `<!-- promoted: session=explicit, conf=${row.confidence}, date=${today}, source_assertion=${row.id} -->`;
  const factLine   = `- [conf=${row.confidence}] ${row.subject} ${row.predicate} ${row.object}`;

  // Append to CLAUDE.md under ## Durable facts.
  if (!fs.existsSync(claudeMdPath)) {
    await db.end();
    console.error(`promote: CLAUDE.md not found at ${claudeMdPath} — run /handoff:init first`);
    process.exit(1);
  }

  const existing = fs.readFileSync(claudeMdPath, 'utf8');
  let updated;
  if (existing.includes('## Durable facts')) {
    // Insert before the closing of the Durable facts section.
    updated = existing.replace(
      /(## Durable facts\n)([\s\S]*?)(\n(?=##)|$)/,
      (_, heading, body, tail) => `${heading}${body}\n${annotation}\n${factLine}${tail}`
    );
  } else {
    updated = existing + `\n## Durable facts\n${annotation}\n${factLine}\n`;
  }
  fs.writeFileSync(claudeMdPath, updated, 'utf8');

  // Mark assertion as promoted.
  await db.query(
    `UPDATE assertions SET promoted = true, promoted_at = now() WHERE id = $1`,
    [assertionId]
  );

  await db.end();

  console.log(`promoted: ${annotation}`);
  console.log(`          ${factLine}`);
  console.log(`\nDone: handoff:promote — assertion id=${assertionId} promoted to CLAUDE.md`);
}

// ── queue-drain ───────────────────────────────────────────────────────────────

/**
 * Deterministic background worker for the async extraction queue.
 *
 * Usage: node scripts/handoff.js queue-drain [--max=N]
 *
 * Selects pending rows from extraction_queue for the resolved project (oldest
 * first, optional row limit via --max=N). For each row:
 *   1. Re-runs validatePayload() as a defense-in-depth check.
 *   2. Calls writeExtraction() with the stored payload.
 *   3. Marks the row 'done' (processed_at = now()).
 *   On write error: marks the row 'error' with error_detail and continues —
 *   one bad row never blocks the queue.
 *
 * Pure script, deterministic, no model calls. Same input → same output every run.
 */
async function cmdQueueDrain(args) {
  console.log('Running: handoff:queue-drain');

  const projectId = resolveProjectId();

  // Parse --max=N flag (optional)
  const maxArg = args.find((a) => a.startsWith('--max='));
  const maxRows = maxArg ? parseInt(maxArg.slice(6), 10) : null;
  if (maxArg && (isNaN(maxRows) || maxRows < 1)) {
    console.error(`queue-drain: invalid --max value "${maxArg.slice(6)}" — must be a positive integer`);
    process.exit(2);
  }

  let db;
  try {
    db = await connectHandoff();
  } catch (err) {
    console.error(`DB connection failed: ${err.message}`);
    process.exit(1);
  }

  // Read the registry mode from project_settings (default permissive for defense-in-depth).
  const registryMode = await getSetting(db, projectId, 'predicate_registry_mode', 'permissive');

  // Select pending rows — oldest first (FIFO). Optional row limit.
  let selectSql = `SELECT id, payload, source_ref FROM extraction_queue
     WHERE project_id = $1 AND status = 'pending'
     ORDER BY enqueued_at ASC`;
  const selectParams = [projectId];
  if (maxRows !== null) {
    selectSql += ` LIMIT $2`;
    selectParams.push(maxRows);
  }

  const { rows: pendingRows } = await db.query(selectSql, selectParams);

  if (pendingRows.length === 0) {
    console.log(`\n  No pending rows in extraction_queue for project ${projectId}.`);
    await db.end();
    console.log('\nDone: handoff:queue-drain — 0 rows processed');
    return;
  }

  console.log(`\n  Found ${pendingRows.length} pending row(s). Processing...`);

  let doneCount  = 0;
  let errorCount = 0;

  for (const row of pendingRows) {
    const rowId = row.id;
    const payload = row.payload;

    // Defense-in-depth: re-validate the payload before writing.
    // This catches any rows that were enqueued with a looser mode.
    const validation = validatePayload(payload, registryMode);

    // Emit warnings regardless of mode.
    for (const w of validation.warnings) {
      process.stderr.write(`[queue-drain] row ${rowId}: ${w}\n`);
    }

    // In strict mode, filter bad assertions before writing (skip-and-continue).
    let payloadToWrite = payload;
    if (registryMode === 'strict' && validation.errors.length > 0) {
      for (const e of validation.errors) {
        process.stderr.write(`[queue-drain] row ${rowId} strict: skipping — ${e}\n`);
      }
      const badIndices = new Set(
        validation.errors
          .map((e) => { const m = e.match(/^assertions\[(\d+)\]/); return m ? parseInt(m[1], 10) : null; })
          .filter((n) => n !== null)
      );
      payloadToWrite = Object.assign({}, payload, {
        assertions: (payload.assertions || []).filter((_, i) => !badIndices.has(i)),
      });
    }

    try {
      const { entitiesWritten, assertionsWritten, edgesWritten } =
        await writeExtraction(db, projectId, payloadToWrite);

      // Mark done.
      await db.query(
        `UPDATE extraction_queue
         SET status = 'done', processed_at = now()
         WHERE id = $1`,
        [rowId]
      );

      const skipCount = (payload.assertions || []).length - (payloadToWrite.assertions || []).length;
      const skipNote  = skipCount > 0 ? ` (${skipCount} predicate-rejected)` : '';
      console.log(
        `  [done] row ${rowId} (source=${row.source_ref || 'null'}): ` +
        `${entitiesWritten}e/${assertionsWritten}a/${edgesWritten}ed written${skipNote}`
      );
      doneCount++;
    } catch (writeErr) {
      // Mark error; do not rethrow — one bad row never blocks the queue.
      const detail = writeErr.message.slice(0, 500);
      try {
        await db.query(
          `UPDATE extraction_queue
           SET status = 'error', processed_at = now(), error_detail = $2
           WHERE id = $1`,
          [rowId, detail]
        );
      } catch (markErr) {
        process.stderr.write(`[queue-drain] row ${rowId}: failed to mark error row: ${markErr.message}\n`);
      }
      process.stderr.write(`[queue-drain] row ${rowId} WRITE ERROR: ${detail}\n`);
      errorCount++;
    }
  }

  await db.end();

  console.log(`\n  Summary: ${doneCount} done, ${errorCount} error(s) out of ${pendingRows.length} processed`);
  console.log(`\nDone: handoff:queue-drain — ${doneCount}/${pendingRows.length} rows written`);

  // Non-zero exit if any errors occurred, so callers can detect partial failures.
  if (errorCount > 0) {
    process.exitCode = 1;
  }
}

// ─── ROUTER ──────────────────────────────────────────────────────────────────

async function main() {
  const [, , sub, ...rest] = process.argv;

  const subcommands = {
    init:            () => cmdInit(rest),
    status:          () => cmdStatus(),
    resume:          () => cmdResume(),
    'loader-load':   () => cmdLoaderLoad(),
    'loader-hook':   () => cmdLoaderHook(),
    'loader-stop':   () => cmdLoaderStop(),
    drop:            () => cmdDrop(),
    checkpoint:      () => cmdCheckpoint(rest),
    close:           () => cmdClose(rest),
    purge:           () => cmdPurge(rest),
    promote:         () => cmdPromote(rest),
    'queue-drain':   () => cmdQueueDrain(rest),
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

// ─── EXPORTS (for tests and CLI scripts) ─────────────────────────────────────
// When required as a module, export helpers without running the CLI router.
if (require.main === module) {
  main();
} else {
  module.exports = { queriesEqual, recordContractChange };
}
