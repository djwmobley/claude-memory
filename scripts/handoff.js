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
 *   prune      [flags]      Operator manual prune: hard-delete selected assertion rows.
 *                           Flags: --suppressed, --suppression-kind <kind>, --subject <s>,
 *                           --older-than <days>, --include-pinned, --apply.
 *                           Dry-run by default; --apply performs the delete.
 *                           At least one criterion required. Manual/operator-invoked only.
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
const {
  resolveDialect, createAdapter, createInitProbe,
  resolveSQLiteDbPath,
} = require('./lib/db-seam');
const { canonicalize }                             = require('./lib/subject-canon');
const {
  MARKER_FILENAME,
  findProjectRootByMarker,
  readMarker,
  writeMarker,
} = require('./lib/project-marker');
const {
  ensureProjectIdentity,
  reconcileLegacySettings,
} = require('./lib/project-identity');

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

// ─── PLUGIN ROOT RESOLUTION ───────────────────────────────────────────────────
// When running as a Claude Code plugin, CLAUDE_PLUGIN_ROOT is set to the plugin
// install directory.  Asset paths (templates, SQL schemas) are resolved from
// the plugin root in that case, and from __dirname's parent otherwise.
// This lets standalone repo usage (CLAUDE_PLUGIN_ROOT unset) behave byte-identically
// to pre-plugin behavior — CI passes with no env-var changes required.
const _ENGINE_ROOT = process.env.CLAUDE_PLUGIN_ROOT
  ? process.env.CLAUDE_PLUGIN_ROOT
  : path.resolve(__dirname, '..');

const HANDOFF_TEMPLATE = path.join(_ENGINE_ROOT, 'templates', 'handoff.md.tpl');
const PROJECT_CLAUDE_MD_TEMPLATE = path.join(_ENGINE_ROOT, 'templates', 'project-claude-md.tpl');

// ─── OPERATING CANON (hardcoded trusted preamble) ─────────────────────────────
// Emitted unconditionally before the untrusted retrieved-context block so every
// session sees the canon in the trusted zone — never inside the untrusted delimiters.
const OPERATING_CANON = `=== OPERATING CANON (trusted — applies to this and every session) ===
1. Follow the user's directions and scope exactly. When asked to do X, and X has an established definition (a backlog item, a prior handoff, a multi-part deliverable), deliver all of X. Do not silently narrow scope, reinterpret it, or substitute a smaller deliverable. If scope genuinely seems too large or ambiguous, say so and ask — do not shrink it unilaterally.
2. Never autonomously defer authorized work to a subsequent session/bundle/phase. Deferring in-scope work without explicit user say-so is a bug. Surface genuine design forks as written open questions with a recommended lean; never use deferral or an invented "later phase" as a mechanism to offload work that is in scope now.
=== END OPERATING CANON ===`;

// ─── HELPERS ─────────────────────────────────────────────────────────────────

/**
 * Connect to the handoff DB.
 *
 * Composition root — the SINGLE place where dialect is resolved and an adapter
 * is selected.  Returns a StoragePort adapter (PostgresAdapter or SQLiteAdapter).
 * The engine (this file) never inspects the dialect after this point; it calls
 * only port methods that are identical across both adapters.
 *
 *   - STORAGE_BACKEND=sqlite  → embedded SQLite at <project_root>/.claude/handoff.sqlite
 *     (or HANDOFF_SQLITE_PATH env var override)
 *   - STORAGE_BACKEND=postgres or unset → Postgres at TARGET_DB (unchanged default)
 */
async function connectHandoff() {
  const cfg     = loadConfig();
  const dialect = resolveDialect(cfg);

  if (dialect === 'sqlite') {
    // Plugin mode: Postgres is a declared prerequisite. Silently falling back to
    // SQLite in plugin mode would violate the design premise and risk data loss /
    // incorrect behavior in multi-project setups. Fail loudly so the user can
    // configure Postgres rather than silently operating on a wrong backend.
    if (process.env.CLAUDE_PLUGIN_ROOT) {
      const msg = [
        '[handoff plugin] STORAGE_BACKEND=sqlite is not supported in plugin mode.',
        'Postgres is required. Set PGHOST/PGUSER/PGPASSWORD (and optionally HANDOFF_DB)',
        'to point at your Postgres instance, then remove STORAGE_BACKEND=sqlite.',
        'SQLite is available only for the db-seam test suite (standalone repo mode).',
      ].join('\n');
      process.stderr.write(msg + '\n');
      process.exit(1);
    }
    const root   = findProjectRoot();
    const dbPath = resolveSQLiteDbPath(root);
    return createAdapter('sqlite', { dbPath });
  }

  // Postgres path (default) — behavior byte-identical to pre-abstraction.
  return createAdapter('postgres', {
    host:     cfg.host,
    port:     cfg.port,
    database: TARGET_DB,
    user:     cfg.user,
  });
}

/**
 * Resolve project_id for the current working directory.
 *
 * LEGACY FALLBACK: this function is used by subcommands that do not connect
 * to the DB (status, drop, purge, etc.) and by cmdInit. It returns the best
 * available id WITHOUT running the one-shot migration.
 *
 * Resolution order:
 *   1. If a .claude-memory marker exists at/above cwd → return the UUID.
 *   2. Otherwise fall back to encodeCwd(root) for backward compatibility.
 *
 * For the authoritative identity (with migration), use ensureProjectIdentity()
 * which is wired into cmdLoaderLoad and cmdClose.
 */
function resolveProjectId() {
  // Honor PROJECT_ROOT env var to match the behavior of findProjectRoot() and
  // ensureProjectIdentity() — subprocesses that set PROJECT_ROOT must not have
  // their marker walk start from the node process's cwd (which may be the repo
  // root and therefore find the wrong marker).
  const startDir = process.env.PROJECT_ROOT || process.cwd();
  const markerRoot = findProjectRootByMarker(startDir);
  if (markerRoot) {
    const marker = readMarker(markerRoot);
    if (marker) return marker.uuid;
  }
  const root = findProjectRoot();
  return encodeCwd(root);
}

/** Resolve the ~/.claude/projects/<projectId>/handoff.md path. */
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
 * L4: Record a degraded close — a subsystem (C2 or C3) that silently skipped
 * because the session id was unresolvable.
 *
 * Writes a project_settings row keyed `degraded_close:<closeStamp>` with a
 * JSON value carrying the subsystem name, reason, and timestamp. The key
 * includes an ISO timestamp so successive degraded closes accumulate as
 * distinct rows (append-style — never overwrites a prior degraded record).
 *
 * Non-fatal: any write error is logged to stderr and ignored so cmdClose
 * continues. Returns the stamp used in the key so callers can reference it.
 *
 * @param {object}      db         - storage adapter (port interface)
 * @param {string}      projectId
 * @param {string|null} sessionId  - session id if known, null if unresolvable
 * @param {string}      subsystem  - 'C2' | 'C3'
 * @param {string}      reason     - human-readable skip reason
 * @returns {Promise<string>}       - the ISO stamp used in the key
 */
// Monotonic counter for recordDegradedClose key uniqueness within a process.
// Ensures that two records written within the same millisecond get distinct keys.
let _degradedCloseSeq = 0;

async function recordDegradedClose(db, projectId, sessionId, subsystem, reason) {
  const stamp = new Date().toISOString();
  const seq   = String(_degradedCloseSeq++).padStart(4, '0');
  // Key: degraded_close:<ISO-stamp>:<seq> — ISO stamp for ordering/filtering;
  // seq suffix guarantees uniqueness when multiple subsystems degrade in the same ms.
  const key   = `degraded_close:${stamp}:${seq}`;
  const val   = JSON.stringify({ subsystem, reason, stamp, sessionId: sessionId || null });
  try {
    await db.query(
      `INSERT INTO project_settings (project_id, key, value) VALUES ($1, $2, $3)
       ON CONFLICT (project_id, key) DO NOTHING`,
      [projectId, key, val]
    );
  } catch (writeErr) {
    process.stderr.write(`[handoff] recordDegradedClose write failed (non-fatal): ${writeErr.message}\n`);
  }
  return stamp;
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
      {
        encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'],
        // Pass PROJECT_ROOT so any transitive subprocess resolves the correct project root.
        env: { ...process.env, PROJECT_ROOT: cwd },
      }
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
    // Pass PROJECT_ROOT so any transitive subprocess resolves the correct project root.
    const execOpts = {
      encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, PROJECT_ROOT: root },
    };

    // Check for dirty working tree (untracked, modified, or staged changes).
    const statusOut = execFileSync('git', ['-C', root, 'status', '--porcelain'], execOpts);
    // Defense-in-depth: filter out any porcelain line whose path basename matches the
    // reserved close-payload staging pattern.  This ensures that even an in-tree payload
    // file (which should NEVER be written inside the repo — see close.md) cannot flip the
    // snapshot to dirty.  The real fix is operator hygiene (use os.tmpdir() staging); this
    // filter is a safety net only.
    const PAYLOAD_STAGING_RE = /^(?:\.)?handoff-close-payload.*\.json$/i;
    const filteredLines = statusOut.split('\n').filter((line) => {
      if (!line.trim()) return false;
      // Git --porcelain format: "XY filename" or "XY dir/filename" (may include quotes).
      const filePart = line.slice(3).trim().replace(/^"(.*)"$/, '$1');
      return !PAYLOAD_STAGING_RE.test(path.basename(filePart));
    });
    const dirty = filteredLines.length > 0;

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

// ─── SCHEMA AUTO-APPLY (Deliverable A) ───────────────────────────────────────

// Module-level cache: maps schemaFilePath → { mtime, hash } so repeated calls in one
// process don't re-read or re-hash the SQL files.  Reset implicitly on process restart.
const _schemaHashCache = new Map();

/**
 * Return a stable SHA-256 hex digest of a schema file's content.
 * Caches by (filePath + mtime) so file I/O is amortized within a process run.
 */
function _hashSchemaFile(filePath) {
  const crypto = require('crypto');
  let mtime;
  try {
    mtime = fs.statSync(filePath).mtimeMs;
  } catch (_) {
    mtime = 0;
  }
  const cached = _schemaHashCache.get(filePath);
  if (cached && cached.mtime === mtime) return cached.hash;
  const content = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : '';
  const hash = crypto.createHash('sha256').update(content).digest('hex');
  _schemaHashCache.set(filePath, { mtime, hash });
  return hash;
}

/**
 * Compute a single fingerprint covering BOTH schema files.
 * Even if only one backend is active, hashing both files means any schema change
 * to either file triggers a re-apply on the active backend.
 */
function _computeSchemaFingerprint() {
  const pgFile     = path.join(_ENGINE_ROOT, 'scripts', 'sql', 'handoff-core-schema.sql');
  const sqliteFile = path.join(_ENGINE_ROOT, 'scripts', 'sql', 'handoff-sqlite-schema.sql');
  const crypto = require('crypto');
  return crypto.createHash('sha256')
    .update(_hashSchemaFile(pgFile))
    .update(_hashSchemaFile(sqliteFile))
    .digest('hex');
}

/**
 * Apply the additive DDL for the active dialect's schema file.
 *
 * Mirrors the Phase A logic in cmdInit but factored out for reuse:
 *   - Reads the schema file, strips psql meta-commands.
 *   - Extracts and removes the two integrity index CREATE UNIQUE INDEX statements.
 *   - Runs core DDL inside BEGIN/COMMIT (idempotent IF NOT EXISTS DDL).
 *   - Runs each integrity index via db.runIntegrityIndex() (non-fatal on failure).
 *
 * Always uses db.query() for the additive ALTER TABLE statements so the seam
 * handles dialect rewriting (IF NOT EXISTS → stripped + caught for SQLite).
 *
 * @param {object}  db         — connected StoragePort adapter
 * @param {string}  schemaFile — absolute path to the active SQL schema file
 * @param {object}  [opts]
 * @param {boolean} [opts.silent=false] — suppress informational stderr output
 */
async function applyAdditiveSchema(db, schemaFile, { silent } = {}) {
  if (!fs.existsSync(schemaFile)) {
    if (!silent) process.stderr.write(`[handoff] applyAdditiveSchema: schema file not found: ${schemaFile}\n`);
    return;
  }

  let sql = fs.readFileSync(schemaFile, 'utf8');
  // Strip psql meta-commands (\ir, \d, etc.) — not supported by pg client.
  sql = sql.replace(/^\\[a-z].*$/gm, '');

  // Extract integrity index statements (same logic as cmdInit Phase B).
  const INTEGRITY_INDEX_NAMES = ['assertions_1to1_unique', 'assertions_1ton_exact_unique'];
  const integrityIndexSqls = [];
  let coreSchemaSQL = sql;
  for (const idxName of INTEGRITY_INDEX_NAMES) {
    const pattern = new RegExp(
      `CREATE\\s+UNIQUE\\s+INDEX\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?${idxName}[\\s\\S]*?;`,
      'i'
    );
    const m = coreSchemaSQL.match(pattern);
    if (m) {
      integrityIndexSqls.push({ name: idxName, sql: m[0] });
      coreSchemaSQL = coreSchemaSQL.replace(m[0], '');
    }
  }

  // Phase A: core DDL inside a transaction.
  await db.query('BEGIN');
  try {
    await db.runSchema(coreSchemaSQL);
    // Idempotent migration: add promoted / promoted_at columns (Bundle A).
    // MUST use db.runSchema() (not db.query()) so the SQLiteAdapter's IF NOT EXISTS
    // strip-and-catch path is applied — node:sqlite does not support ADD COLUMN IF NOT EXISTS.
    await db.runSchema(`ALTER TABLE assertions ADD COLUMN IF NOT EXISTS promoted    BOOLEAN     NOT NULL DEFAULT false`);
    await db.runSchema(`ALTER TABLE assertions ADD COLUMN IF NOT EXISTS promoted_at TIMESTAMPTZ`);
    // L3 reality-check tag (additive, NULL-tolerant).
    // 'verified' | 'mismatch' | 'unverifiable' | NULL (pre-L3 rows).
    // On mismatch, conf/source/tier are NEVER modified — only this column.
    await db.runSchema(`ALTER TABLE assertions ADD COLUMN IF NOT EXISTS reality_check TEXT`);
    await db.query('COMMIT');
  } catch (err) {
    try { await db.query('ROLLBACK'); } catch (_) { /* ignore */ }
    throw err;
  }

  // Phase B: integrity indexes (non-fatal on legacy-dupe corpus).
  for (const { name, sql: idxSql } of integrityIndexSqls) {
    const result = await db.runIntegrityIndex(idxSql);
    if (!result.ok && !silent) {
      process.stderr.write(`[handoff] applyAdditiveSchema: integrity index ${name} skipped (non-fatal): ${result.msg}\n`);
    }
  }
}

/**
 * Cheap drift sentinel: compare the stored schema_fingerprint in project_settings
 * against the current file hash.  If they differ (or the key is absent), apply the
 * additive schema and upsert the fingerprint.  If they match, return immediately
 * (hot path = one SELECT + one cached hash computation).
 *
 * Non-fatal: all errors are caught and logged to stderr; callers must wrap in try/catch
 * and continue regardless.
 *
 * @param {object}  db        — connected StoragePort adapter
 * @param {string}  projectId — encoded_cwd
 * @param {object}  [opts]
 * @param {boolean} [opts.silent=false] — suppress informational stderr output
 */
async function ensureSchemaCurrent(db, projectId, { silent } = {}) {
  const fingerprint = _computeSchemaFingerprint();

  // Hot path: one SELECT.
  const { rows } = await db.query(
    'SELECT value FROM project_settings WHERE project_id = $1 AND key = $2',
    [projectId, 'schema_fingerprint']
  );
  if (rows.length > 0 && rows[0].value === fingerprint) {
    // Schema is current — no-op.
    return;
  }

  // Fingerprint missing or stale: apply the active dialect's schema file.
  if (!silent) {
    process.stderr.write('[handoff] schema drift detected — running additive schema apply\n');
  }

  // Resolve the schema file for the active dialect.
  const schemaFileName = db.schemaFileName;
  const schemaFile = path.join(_ENGINE_ROOT, 'scripts', 'sql', schemaFileName);
  await applyAdditiveSchema(db, schemaFile, { silent });

  // Upsert the new fingerprint into project_settings.
  await db.query(
    `INSERT INTO project_settings (project_id, key, value) VALUES ($1, $2, $3)
     ON CONFLICT (project_id, key) DO UPDATE SET value = EXCLUDED.value`,
    [projectId, 'schema_fingerprint', fingerprint]
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

  // Determine project root: prefer the .claude-memory marker if present, else
  // fall back to the .git walk (same as legacy behavior for the init case).
  // Honor PROJECT_ROOT env var as the starting point, matching findProjectRoot().
  const initCwd    = process.env.PROJECT_ROOT || process.cwd();
  const markerRoot = findProjectRootByMarker(initCwd);
  const root       = markerRoot || findProjectRoot();

  // Resolve or mint the project marker so projectId is UUID-based.
  // cmdInit is special: it doesn't have a live DB yet, so we can't call
  // ensureProjectIdentity. Instead we read an existing marker or mint a new one.
  let projectId;
  {
    const existingMarker = readMarker(root);
    if (existingMarker) {
      projectId = existingMarker.uuid;
      console.log(`  [OK]    .claude-memory marker present: uuid=${projectId}`);
    } else {
      // Mint a new marker.
      let newMarker;
      try {
        newMarker = writeMarker(root);
      } catch (markerErr) {
        console.log(`  [FAIL]  Could not write .claude-memory marker — ${markerErr.message}`);
        process.exit(1);
      }
      projectId = newMarker.uuid;
      console.log(`  [OK]    .claude-memory marker created: uuid=${projectId}`);
      console.log(`          Path: ${path.join(root, MARKER_FILENAME)}`);
    }
  }

  const handoffPath = resolveHandoffMdPath(projectId);
  const claudeMdPath = path.join(root, 'CLAUDE.md');
  const autoCreate  = args.includes('-y');

  const cfg = loadConfig();

  // ── Pre-flight checks ─────────────────────────────────────────────────────

  // Step 1: Node version >= 18 (dialect-independent)
  const nodeCheck = checkNodeVersion();
  printPreflightLine(nodeCheck, 'Node version >= 18');
  if (nodeCheck.fatal) { process.exit(1); }

  // Steps 2-5: dialect-specific pre-flight — fully encapsulated inside the
  // probe adapter. createInitProbe() resolves dialect once and returns the
  // appropriate adapter. No dialect conditionals in this function.
  const probeAdapter = createInitProbe(cfg);
  try {
    await probeAdapter.runInitPreflight(cfg, TARGET_DB, autoCreate, root, printPreflightLine);
  } catch (err) {
    // fatal errors thrown by runInitPreflight are already printed by printPreflightLine
    process.exit(1);
  }

  // Step 6: schema file present on disk — adapter knows the correct filename.
  const schemaFileName = probeAdapter.schemaFileName;
  const schemaFile = path.join(_ENGINE_ROOT, 'scripts', 'sql', schemaFileName);
  const schemaExists = fs.existsSync(schemaFile);
  if (schemaExists) {
    console.log(`  [OK]    Schema file present: ${path.basename(schemaFile)}`);
  } else {
    console.log(`  [FAIL]  Schema file missing: ${schemaFile}`);
    process.exit(1);
  }

  // Connect to target DB — adapter handles dialect-specific connection setup.
  let db;
  try {
    db = await probeAdapter.connectForInit(cfg, TARGET_DB, root);
  } catch (err) {
    console.log(`  [FAIL]  DB connection failed — ${err.message}`);
    process.exit(1);
  }

  // Step 7: Apply schema in two phases — separated to ensure additive/table DDL
  // commits even when a legacy-duplicate corpus prevents integrity index creation.
  //
  // Phase A (transactional): tables, regular indexes, additive ALTER TABLE ADD COLUMN
  //   statements.  These are safe to run idempotently and never fail due to existing
  //   data.  Committed atomically; fatal on failure.
  //
  // Phase B (non-transactional, non-fatal): partial unique integrity indexes
  //   (assertions_1to1_unique, assertions_1ton_exact_unique).  These can fail on a
  //   legacy-duplicate corpus because existing rows violate the uniqueness constraint.
  //   Each index is attempted individually via db.runIntegrityIndex().  Failure is
  //   non-fatal: a clear actionable warning is printed and init continues to success.
  //   On a clean DB (no legacy duplicates) both indexes are created and no warning
  //   is emitted — behavior is identical to the pre-fix path.
  //
  //   State when index is NOT created (legacy-dupe corpus):
  //     - The additive bi-temporal columns (valid_at, invalid_at, suppression_kind,
  //       pinned) ARE present — Phase A guarantees this.
  //     - Supersession correctness is still enforced transactionally in
  //       writeAssertionWithSupersession (BEGIN/suppress+INSERT/COMMIT).
  //     - The missing index is a defense-in-depth layer, not the primary guarantee.
  //     - The blocking rows are LIVE duplicates (suppressed=false). The `prune
  //       --suppressed` command targets only suppressed=true rows and will NOT
  //       resolve this condition. Resolving live-duplicate rows is corpus-dedupe
  //       work — precisely the §7 SKIP (WILL-NOT-RUN) decision — and requires
  //       explicit operator authorization, not a routine command.
  let sql = fs.readFileSync(schemaFile, 'utf8');
  // Remove psql meta-commands (\ir, \d, etc.) — not supported by pg client
  sql = sql.replace(/^\\[a-z].*$/gm, '');

  // Extract the two integrity index CREATE UNIQUE INDEX statements by name so they
  // can be run separately in Phase B.  Each is a single statement ending with `;`.
  // The regex matches from `CREATE UNIQUE INDEX IF NOT EXISTS <name>` to the closing `;`.
  const INTEGRITY_INDEX_NAMES = ['assertions_1to1_unique', 'assertions_1ton_exact_unique'];
  const integrityIndexSqls = [];
  let coreSchemaSQL = sql;
  for (const idxName of INTEGRITY_INDEX_NAMES) {
    // Match the full CREATE UNIQUE INDEX statement for this index name.
    // Uses a non-greedy match to the next `;` after the index name.
    const pattern = new RegExp(
      `CREATE\\s+UNIQUE\\s+INDEX\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?${idxName}[\\s\\S]*?;`,
      'i'
    );
    const m = coreSchemaSQL.match(pattern);
    if (m) {
      integrityIndexSqls.push({ name: idxName, sql: m[0] });
      coreSchemaSQL = coreSchemaSQL.replace(m[0], '');
    }
  }

  // Phase A: apply core schema (no integrity indexes) inside a transaction.
  try {
    await db.query('BEGIN');
    await db.runSchema(coreSchemaSQL);
    // Idempotent migration: add `promoted` and `promoted_at` columns to assertions
    // (used by /handoff:promote explicit-promotion command, added in Bundle A hardening).
    // For Postgres: BOOLEAN / TIMESTAMPTZ. For SQLite: INTEGER / TEXT (seam rewrites DDL).
    // MUST use db.runSchema() (not db.query()) so the SQLiteAdapter's IF NOT EXISTS
    // strip-and-catch path is applied — node:sqlite does not support ADD COLUMN IF NOT EXISTS.
    await db.runSchema(`ALTER TABLE assertions ADD COLUMN IF NOT EXISTS promoted    BOOLEAN     NOT NULL DEFAULT false`);
    await db.runSchema(`ALTER TABLE assertions ADD COLUMN IF NOT EXISTS promoted_at TIMESTAMPTZ`);
    // L3 reality-check tag (additive, NULL-tolerant).
    // 'verified' | 'mismatch' | 'unverifiable' | NULL (pre-L3 rows).
    // On mismatch, conf/source/tier are NEVER modified — only this column.
    await db.runSchema(`ALTER TABLE assertions ADD COLUMN IF NOT EXISTS reality_check TEXT`);
    await db.query('COMMIT');
    console.log(`  [OK]    Schema applied: ${path.basename(schemaFile)}`);
  } catch (err) {
    try { await db.query('ROLLBACK'); } catch (_) { /* ignore */ }
    await db.end();
    console.log(`  [FAIL]  Schema apply failed — ${err.message}`);
    console.log(`          Transaction rolled back. No FS writes made.`);
    process.exit(1);
  }

  // Phase B: attempt each integrity index individually (non-fatal on legacy-dupe corpus).
  for (const { name, sql: idxSql } of integrityIndexSqls) {
    const result = await db.runIntegrityIndex(idxSql);
    if (!result.ok) {
      console.log(`  [WARN]  Integrity index NOT created: ${name}`);
      console.log(`          Reason: ${result.msg}`);
      console.log(`          This means the DB contains pre-existing duplicate live rows`);
      console.log(`          (same project_id/subject/predicate with suppressed=false) that`);
      console.log(`          violate the uniqueness constraint — a legacy-duplicate corpus.`);
      console.log(`          The blocking rows are LIVE duplicates (suppressed=false).`);
      console.log(`          prune --suppressed targets only suppressed=true rows and will`);
      console.log(`          NOT resolve this — do not run it for this condition.`);
      console.log(`          Resolving live-duplicate rows is corpus-dedupe work (§7 SKIP,`);
      console.log(`          WILL-NOT-RUN) and requires explicit operator authorization.`);
      console.log(`          Until that decision is taken, handoff init succeeds WITHOUT`);
      console.log(`          this index. Supersession correctness is still enforced`);
      console.log(`          transactionally in writeAssertionWithSupersession`);
      console.log(`          (BEGIN/suppress+INSERT/COMMIT). The missing index is`);
      console.log(`          defense-in-depth only.`);
    }
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
    // C2: outcome→ranking+decay feedback loop (default ON as of PR-B).
    // When explicitly set to any value other than 'enabled', gate-OFF SQL remains
    // byte-identical in structure (no outcome_bias term); see I-6 in the spec.
    feedback_loop_enabled:            'enabled',
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
      DEGRADED_SECTION:    '',
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

  // ── Identity resolution (MUST run before ensureSchemaCurrent) ────────────
  // Ordering constraint: project_id (which keys the schema_fingerprint row)
  // cannot be known until identity is resolved. ensureProjectIdentity is
  // the FIRST internal-check step; ensureSchemaCurrent follows immediately.
  let projectId;
  try {
    const identity = await ensureProjectIdentity(db, { silent });
    projectId = identity.projectId;
  } catch (idErr) {
    // ensureProjectIdentity calls process.exit(1) on fatal errors.
    // This catch is a belt-and-suspenders guard for unexpected throws.
    process.stderr.write('[handoff] identity resolution failed (unexpected): ' + idErr.message + '\n');
    process.exit(1);
  }

  const handoffPath = resolveHandoffMdPath(projectId);
  const fm          = readHandoffFrontmatter(handoffPath);

  const lastClose     = fm.last_close || null;
  const daysSinceClose = daysSince(lastClose);

  // Deliverable A: auto-apply additive schema on drift (non-fatal).
  // Runs immediately after identity resolution, before retrieval_contract SELECT.
  // Any error here must NOT abort resume/load — wrap and continue.
  try {
    await ensureSchemaCurrent(db, projectId, { silent });
  } catch (schemaErr) {
    process.stderr.write('[handoff] schema auto-apply failed (non-fatal): ' + schemaErr.message + '\n');
  }

  // L4: Resume banner — warn if the last close ran degraded (C2/C3 skipped).
  // Query project_settings for any degraded_close:* key newer than the last
  // clean close (i.e., last_close frontmatter timestamp). Non-fatal: any error
  // here must not abort the load.
  try {
    const { rows: degradedRows } = await db.query(
      `SELECT key, value FROM project_settings
       WHERE project_id = $1 AND key LIKE 'degraded_close:%'
       ORDER BY key DESC`,
      [projectId]
    );
    if (degradedRows.length > 0) {
      // Filter to rows newer than the last clean close (if we have one).
      // Key format: degraded_close:<ISO-stamp>:<seq> — extract the ISO portion
      // (first 24 chars of the ISO 8601 timestamp) for comparison.
      const lastCleanStamp = lastClose || null;
      const newerRows = lastCleanStamp
        ? degradedRows.filter((r) => {
            // Key format: degraded_close:<ISO-stamp>:<seq>
            // Extract ISO stamp: the segment between the first ':' separator
            // (after 'degraded_close') and the trailing ':<seq>'.
            const afterPrefix  = r.key.slice('degraded_close:'.length);
            // ISO stamp is everything up to the last ':' (the seq suffix).
            const lastColon    = afterPrefix.lastIndexOf(':');
            const stampPart    = lastColon >= 0 ? afterPrefix.slice(0, lastColon) : afterPrefix;
            return stampPart > lastCleanStamp;
          })
        : degradedRows;
      if (newerRows.length > 0) {
        // Collect unique subsystem names and session ids for the banner.
        const degradedEntries = newerRows.map((r) => {
          try { return JSON.parse(r.value); } catch (_) { return null; }
        }).filter(Boolean);
        const subsystems = [...new Set(degradedEntries.map((e) => e.subsystem))].join(', ');
        const sessionRef = degradedEntries[0] && degradedEntries[0].sessionId
          ? degradedEntries[0].sessionId
          : 'unknown';
        const bannerLine =
          `RESUME WARNING: last close ran degraded (${subsystems} skipped) — ` +
          `feedback/evolution state is stale for session ${sessionRef}`;
        if (!silent) {
          console.log(`\n  ${bannerLine}`);
        } else {
          process.stderr.write(`[handoff] ${bannerLine}\n`);
        }
      }
    }
  } catch (degradedCheckErr) {
    process.stderr.write('[handoff] degraded-close resume check failed (non-fatal): ' + degradedCheckErr.message + '\n');
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
  // Default is now 'enabled' (PR-B default-on).  When explicitly set to any other value,
  // gate-OFF SQL has no outcome_bias term — byte-identical in structure to pre-C2 (I-6).
  const feedbackLoopEnabled = await getSetting(db, projectId, 'feedback_loop_enabled', 'enabled');

  // Two-tier durability retrieval gate (orthogonal to C2 feedback gate).
  // Default 'enabled' = ON.  Prepends a tier-priority sort key to ORDER BY so that
  // consolidated/NULL rows rank above probationary rows.  Probationary rows are NEVER
  // filtered out (only re-ranked) — the LIMIT-30 dormancy floor invariant is preserved.
  // When any other value: ORDER BY is byte-identical to the pre-feature SQL (no CASE WHEN
  // tier term at all) — the I-6 byte-identical guarantee is honored on this gate as well.
  // Gate composition: 4 explicit SQL strings (feedbackOn/Off × tierOn/Off) remain readable.
  const tierAware = await getSetting(db, projectId, 'tier_aware_retrieval', 'enabled');
  // Computed prefix: if tier-aware ON, prepend the CASE WHEN tier sort key to ORDER BY.
  // CASE WHEN tier='probationary' THEN 1 ELSE 0 END is plain SQL, valid on PG and node:sqlite
  // — no rewrite/port method needed (no now(), no EXTRACT, no dialect-specific syntax).
  // NULL tier (grandfathered rows) hits ELSE → 0 → ranked with consolidated. Correct.
  const tierPrefix = tierAware === 'enabled'
    ? "(CASE WHEN tier = 'probationary' THEN 1 ELSE 0 END) ASC, "
    : '';

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
      // Commit B: decay is a ranking-only signal — it no longer gates rows out of the loader.
      // Previously the WHERE clause enforced a >= 1.0 effective-confidence cutoff, which caused
      // dormancy: any assertion not retrieved for ~6+ weeks decayed below 1.0 and was silently
      // excluded, even though the data was intact in the DB. Fix: remove the decay cutoff from
      // WHERE entirely; LIMIT 30 is now the guaranteed top-N floor. Suppressed rows are still
      // excluded via suppressed = false.
      //
      // Gate ON (feedback_loop_enabled='enabled'): ORDER BY uses
      //   confidence * exp(-decay_rate * age_days) + outcome_bias  (decayed score + feedback bias).
      // Gate OFF: ORDER BY uses confidence * exp(-decay_rate * age_days) (decayed score only).
      // The gate-ON/gate-OFF difference is now only the outcome_bias term in the ranking expression.
      // outcome_bias semantics (gap 5b) are unchanged.
      //
      // Clamp design: outcome_bias is bounded by feedback_bias_clamp on write (see cmdClose).
      let assertionQuerySql;
      let assertionQueryParams;
      if (feedbackLoopEnabled === 'enabled') {
        // Gate ON: rank by decayed score + outcome_bias; no cutoff filter.
        // PR-B: also exclude bi-temporally invalidated rows (invalid_at IS NULL = still live).
        // Tier gate (orthogonal, I-6 honored): tierPrefix prepended to ORDER BY when
        // tier_aware_retrieval='enabled'; empty string when disabled (byte-identical then).
        assertionQuerySql = `SELECT id, subject, predicate, object, confidence, source FROM assertions
         WHERE project_id = $1
           AND ($2::text IS NULL OR subject = $2)
           AND suppressed = false
           AND invalid_at IS NULL
         ORDER BY ${tierPrefix}(confidence * exp(-decay_rate * EXTRACT(EPOCH FROM (now() - last_reinforced)) / 86400) + outcome_bias) DESC, last_reinforced DESC LIMIT 30`;
        assertionQueryParams = [projectId, q.filter?.subject || null];
      } else {
        // Gate OFF: rank by decayed score only (no outcome_bias term); no cutoff filter.
        // I-6: when C2 is EXPLICITLY disabled, the gate-OFF SQL omits the outcome_bias term —
        // that is the ONLY C2-driven difference vs gate-ON. The AND invalid_at IS NULL predicate
        // is a bi-temporal extension (PR-B) present identically in both gate-ON and gate-OFF;
        // it is NOT a C2 change.
        // Tier gate (orthogonal, I-6 honored): tierPrefix prepended to ORDER BY when
        // tier_aware_retrieval='enabled'; empty string when disabled (byte-identical then).
        assertionQuerySql = `SELECT id, subject, predicate, object, confidence, source FROM assertions
         WHERE project_id = $1
           AND ($2::text IS NULL OR subject = $2)
           AND suppressed = false
           AND invalid_at IS NULL
         ORDER BY ${tierPrefix}confidence * exp(-decay_rate * EXTRACT(EPOCH FROM (now() - last_reinforced)) / 86400) DESC, last_reinforced DESC LIMIT 30`;
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
        // (per-row precision instead of project-wide or subject-wide).
        // OQ-2: AND suppressed=false prevents bumping suppressed history rows.
        // Dialect-specific SQL (IN vs ANY, now() vs datetime('now')) is
        // encapsulated inside db.buildBumpAssertions() — no conditionals here.
        const bumpStmt = db.buildBumpAssertions(retrievedAssertionIds);
        if (bumpStmt) {
          await db.query(bumpStmt.sql, bumpStmt.params);
        }
      }

    } else if (q.type === 'recency' || q.kind === 'recency') {
      // Commit B: decay cutoff removed from recency kind too — dormancy fix applies here.
      // Recency queries are ordered by last_reinforced DESC regardless of gate state;
      // decay is not factored into the ORDER BY for recency (recency stays recency-ordered).
      // LIMIT 20 is the guaranteed top-N floor; suppressed = false still excludes suppressed rows.
      let recencyQuerySql;
      if (feedbackLoopEnabled === 'enabled') {
        // Gate ON: no cutoff filter; recency order unchanged.
        // PR-B: exclude bi-temporally invalidated rows (invalid_at IS NULL = still live).
        recencyQuerySql = `SELECT id, subject, predicate, object, confidence FROM assertions
         WHERE project_id = $1
           AND suppressed = false
           AND invalid_at IS NULL
         ORDER BY last_reinforced DESC LIMIT 20`;
      } else {
        // Gate OFF: no cutoff filter; recency order unchanged.
        // PR-B: invalid_at IS NULL applies in both gate states.
        recencyQuerySql = `SELECT id, subject, predicate, object, confidence FROM assertions
         WHERE project_id = $1
           AND suppressed = false
           AND invalid_at IS NULL
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
      // 4E history kind: return suppressed / bi-temporally invalidated rows for a given
      // subject so the caller can inspect the superseded trail + probation rows without
      // paying the default context cost.
      //
      // PR-B additions:
      //   - Includes rows with suppressed=true OR invalid_at IS NOT NULL (catches
      //     downvoted_probation rows that are excluded from standard retrieval).
      //   - suppression_kind and invalid_at are included in the formatted output.
      //   - NO bump: history retrieval must not reinforce non-live rows (OQ-2).
      //
      // Design decisions (per spec §7.3 + PR-B Fork 1):
      //   - Opt-in via contract kind:'history' + filter.subject; never in default contract.
      //   - created_at is included so the caller can reason about temporal ordering.
      //
      // I-2 guard: the default contract ({queries:[]}) contains no history query, so
      // this branch is unreachable in a default session.  Including a history query in
      // the contract is an explicit opt-in that must go through recordContractChange.
      const historySubject = q.filter?.subject || null;
      const { rows: hRows } = await db.query(
        `SELECT id, subject, predicate, object, confidence, source, created_at,
                suppression_kind, invalid_at
         FROM assertions
         WHERE project_id = $1
           AND ($2::text IS NULL OR subject = $2)
           AND (suppressed = true OR invalid_at IS NOT NULL)
         ORDER BY subject, predicate, created_at DESC
         LIMIT 20`,
        [projectId, historySubject]
      );
      if (hRows.length) {
        const text = hRows.map((r) => {
          const ts = r.created_at
            ? (typeof r.created_at === 'string' ? r.created_at : r.created_at.toISOString())
            : 'unknown';
          const kindTag = r.suppression_kind ? `|${r.suppression_kind}` : '|suppressed';
          return `- [${r.source}|conf=${r.confidence}${kindTag}|${ts}] ${r.subject} ${r.predicate} ${r.object}`;
        }).join('\n');
        sections.push(`### Assertion history (suppressed/probation trail)\n${text}`);
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

            // Build + execute the graph CTE.
            // Dialect-specific SQL construction (ARRAY path for Postgres vs.
            // delimited-string path for SQLite) is fully encapsulated in the
            // adapter's buildGraphCTE() method — no conditionals in the engine.
            const { sql: cteSql, params: cteParams } =
              db.buildGraphCTE(direction, seeds, maxDepth, maxNodes, projectId);
            const { rows: graphRows } = await db.query(cteSql, cteParams);

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
    // Dialect-specific multi-row VALUES formatting is encapsulated in buildMultiPairInsert().
    const eventId = evtRes.rows[0] && evtRes.rows[0].id;
    if (eventId != null && retrievedAssertionIds.length > 0) {
      const uniqueIds = [...new Set(retrievedAssertionIds)];
      const insertStmt = db.buildMultiPairInsert(
        'retrieval_event_assertions', 'event_id', 'assertion_id', eventId, uniqueIds
      );
      await db.query(insertStmt.sql, insertStmt.params);
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
        // buildCommunityIdsQuery() encapsulates the dialect-specific array lookup.
        const cidQ = db.buildCommunityIdsQuery(projectId, latestRunId, retrievedEntityNames);
        const communityRes = await db.query(cidQ.sql, cidQ.params);
        if (communityRes.rows.length > 0) {
          const communityIds = communityRes.rows.map((r) => r.community_id);
          const clusterMaxSiblings = parseInt(
            await getSetting(db, projectId, 'cluster_max_siblings', '10'), 10
          );
          // Fetch sibling entities in the same communities, excluding already-retrieved ones.
          // buildSiblingsQuery() encapsulates the dialect-specific IN/ANY and NOT IN/<>ALL.
          const sibQ = db.buildSiblingsQuery(
            projectId, latestRunId, communityIds, retrievedEntityNames, clusterMaxSiblings
          );
          const siblingRes = await db.query(sibQ.sql, sibQ.params);
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
    DEGRADED_SECTION:    '',
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

  // ── Spine step 5: prospective subject canonicalization (Option 2, §7-honoring) ──
  //
  // Canonicalize the incoming subject: trim + lowercase + collapse whitespace + alias-map.
  // The NEW row is inserted with the canonical subject.
  //
  // Canonical-aware supersession match (application-code approach — dialect-neutral):
  //   We fetch candidate prior live rows scoped to (project_id, predicate [+ object for 1:N]),
  //   canonicalize each stored subject in JS, and identify those whose canonical form equals
  //   the new canonical subject.  We then suppress those rows by calling buildSupersessionUpdate
  //   with their stored subject (so the existing PR-B mechanism handles dialect-specific
  //   boolean/timestamp SQL — zero new dialect conditionals in the engine).
  //
  //   Rationale: dialect-specific SQL expressions like lower(regexp_replace(...)) are NOT
  //   portable — SQLite (node:sqlite, zero extensions) has no regexp_replace.  The
  //   application-code approach uses only plain SELECT + the existing suppression port method,
  //   both already dialect-neutral.
  //
  // §7 zero-corpus-mutation guarantee:
  //   The ONLY writes are: (a) the new INSERT with canonical subject, and (b) the existing
  //   PR-B suppression mechanism setting suppressed/invalid_at/suppression_kind on matched rows.
  //   We NEVER issue UPDATE assertions SET subject = ... on any existing row.
  //   A matched prior row's stored subject column is NOT modified — it retains its original
  //   byte-for-byte value.  The suppression path (buildSupersessionUpdate) writes only
  //   suppressed, invalid_at, and suppression_kind — never the subject column.
  const canonSubject = canonicalize(ass.subject);

  // Wrap suppress+INSERT in an explicit transaction (atomicity requirement I-A mechanism-a).
  //
  // PR-B: supersession is enriched via db.buildSupersessionUpdate() which sets:
  //   suppressed = true, invalid_at = now(), suppression_kind = 'superseded'
  // on the prior live row(s).  Rows with pinned = true are EXEMPT from auto-suppression
  // here — they are skipped by buildSupersessionUpdate's WHERE clause.
  // Note: explicit user re-statement of a 1:1 predicate WILL supersede a pinned row
  // (pinned blocks C2 AUTO actions, not explicit writes — documented distinction).
  //
  // The new INSERT also sets valid_at = now() to record when the assertion became live.
  await db.query('BEGIN');
  try {
    // ── Step 1: Canonical-aware match — find prior live rows to suppress ──────────
    //
    // Fetch candidate rows using only the non-subject scope keys (project_id, predicate
    // [+ object for 1:N]), suppressed=false AND invalid_at IS NULL, non-pinned.
    // Canonicalize each stored subject in JS.  Collect the stored subjects of rows whose
    // canonical form equals canonSubject — these are the rows to suppress.
    //
    // We group by stored subject so that each unique stored subject triggers exactly one
    // buildSupersessionUpdate call.  This handles both the exact-match case (stored subject
    // already canonical) and the variant-spelling case (stored subject differs in case/whitespace
    // but maps to the same canonical form).
    // Note on pinned guard: we omit the pinned filter from the candidate SELECT intentionally.
    // buildSupersessionUpdate already guards on pinned (= 0 for SQLite, = false OR IS NULL for
    // Postgres) — so even if a pinned candidate is collected here, it will be skipped by the
    // UPDATE's WHERE clause.  Omitting the pinned filter here keeps the SELECT dialect-neutral
    // (no boolean literal that differs between backends).
    const storedSubjectsToSuppress = new Set();
    // Touch-only ids: same-session exact repeats that should only have last_reinforced bumped,
    // NOT suppressed+reinserted. Accumulate across both cardinalities before deciding path.
    const touchOnlyIds = [];
    // Two-tier durability: track corroboration signals from 1:N exact-duplicate matches.
    // For 1:N only (pre-L0): collect session_id and corroboration_count from canonical-matched
    // prior live rows to determine cross-session corroboration (hybrid consolidation trigger b).
    // See the INSERT below for how these are used to compute tier and corroboration_count.
    //
    // L0: crossSessionCorroborated is also set for 1:1 cardinality when the same
    // (subject, predicate, object) was seen from a distinct prior non-null session_id.
    // The disabled-mode path uses preLo1NCorroborated (1:N only, pre-L0 formula) to
    // preserve byte-identical behavior when the gate is disabled.
    let crossSessionCorroborated = false; // L0 enforce gate: both 1:1 and 1:N
    let preLo1NCorroborated      = false; // disabled-mode path: 1:N only (pre-L0 formula)
    let maxPriorCorrob = 1;

    // L2: track whether at least one cross-session corroborating row is independently
    // trustworthy (reality_check='verified' OR pinned=true/1).
    // This is the positive-evidence quality plug — the load-bearing L2 element.
    let hasQualityCorroborator = false; // ≥1 independently-trustworthy corroborating prior row

    if (cardinality === '1:1') {
      const { rows: candidates } = await db.query(
        `SELECT id, subject, object, session_id, confidence, source, reality_check, pinned FROM assertions
         WHERE project_id = $1
           AND predicate  = $2
           AND suppressed = false
           AND invalid_at IS NULL`,
        [projectId, ass.predicate]
      );
      for (const r of candidates) {
        if (canonicalize(r.subject) === canonSubject) {
          // Same-session exact repeat (1:1): object, conf, source, session all match →
          // touch-only (bump last_reinforced only; no new row, no suppression).
          if (
            r.object === ass.object &&
            r.session_id != null && sessionId != null &&
            r.session_id === sessionId &&
            Number(r.confidence) === conf && r.source === source
          ) {
            touchOnlyIds.push(r.id);
          } else {
            storedSubjectsToSuppress.add(r.subject);
            // L0: Cross-session corroboration for 1:1 — same (subject, predicate, object)
            // asserted from a DISTINCT non-null session_id counts as genuine corroboration.
            // Same-session re-assertion (or null session_id on either side) does NOT count.
            // Note: the 1:1 corroboration signal is ONLY used by the L0 enforce gate;
            // the disabled-mode path preserves the pre-L0 formula exactly (see Step 3).
            if (
              r.object === ass.object &&
              r.session_id !== null && r.session_id !== undefined &&
              sessionId !== null && sessionId !== undefined &&
              r.session_id !== sessionId
            ) {
              crossSessionCorroborated = true;
              // L2 quality plug: this corroborating row is independently trustworthy if
              // reality_check='verified' OR pinned=true/1.
              if (r.reality_check === 'verified' || r.pinned === true || r.pinned === 1) {
                hasQualityCorroborator = true;
              }
            }
          }
        }
      }
    } else {
      // 1:N: only exact (project_id, subject[canonical], predicate, object) duplicates.
      // Also retrieve session_id and corroboration_count for the Hybrid consolidation check.
      // Cross-session corroboration requires: both session_ids non-null AND DISTINCT from each other.
      // Same-session re-assertion does NOT graduate. NULL session_id on either side is NOT corroboration.
      const { rows: candidates } = await db.query(
        `SELECT id, subject, session_id, corroboration_count, confidence, source, reality_check, pinned FROM assertions
         WHERE project_id = $1
           AND predicate  = $2
           AND object     = $3
           AND suppressed = false
           AND invalid_at IS NULL`,
        [projectId, ass.predicate, ass.object]
      );
      for (const r of candidates) {
        if (canonicalize(r.subject) === canonSubject) {
          // Same-session exact repeat (1:N): conf, source, session all match →
          // touch-only (bump last_reinforced only; skip suppression + corroboration tracking).
          if (
            r.session_id != null && sessionId != null &&
            r.session_id === sessionId &&
            Number(r.confidence) === conf && r.source === source
          ) {
            touchOnlyIds.push(r.id);
            continue; // skip suppression + corroboration tracking for this row
          }
          storedSubjectsToSuppress.add(r.subject);
          // Cross-session corroboration check: prior row must have a non-null session_id
          // that is DISTINCT from the incoming sessionId (also non-null).
          if (
            r.session_id !== null && r.session_id !== undefined &&
            sessionId !== null && sessionId !== undefined &&
            r.session_id !== sessionId
          ) {
            crossSessionCorroborated = true; // L0 enforce path
            preLo1NCorroborated      = true; // disabled-mode path (pre-L0 formula, 1:N only)
            // L2 quality plug: this corroborating row is independently trustworthy if
            // reality_check='verified' OR pinned=true/1.
            if (r.reality_check === 'verified' || r.pinned === true || r.pinned === 1) {
              hasQualityCorroborator = true;
            }
          }
          // Track max corroboration_count among matched priors (for new row's count).
          const priorCount = typeof r.corroboration_count === 'number'
            ? r.corroboration_count
            : parseInt(r.corroboration_count, 10) || 1;
          if (priorCount > maxPriorCorrob) maxPriorCorrob = priorCount;
        }
      }
    }

    // ── Touch-only short-circuit ───────────────────────────────────────────────
    // ALL matched live candidates are same-session exact repeats: bump last_reinforced/
    // last_retrieved only via buildBumpAssertions, then commit and return false.
    // No new row, no suppression, no advance of valid_at/tier/consolidated_at/corroboration_count.
    // Mixed case (some touch-only + some suppress): fall through to normal suppress+INSERT path.
    if (touchOnlyIds.length > 0 && storedSubjectsToSuppress.size === 0) {
      const bumpStmt = db.buildBumpAssertions(touchOnlyIds);
      if (bumpStmt) await db.query(bumpStmt.sql, bumpStmt.params);
      await db.query('COMMIT');
      return false; // no new row; caller must NOT increment assertionsWritten
    }

    // ── Step 2: Suppress matched prior rows via the existing PR-B port method ────
    //
    // buildSupersessionUpdate(cardinality, projectId, storedSubject, predicate, object)
    // matches on the exact stored subject in its WHERE clause.  Passing the stored subject
    // (not the canonical one) ensures it hits the exact rows we identified above.
    // This reuses the existing mechanism without modification — the subject column of
    // the matched rows is NEVER updated (only suppressed/invalid_at/suppression_kind).
    for (const storedSubject of storedSubjectsToSuppress) {
      const supersessionStmt = db.buildSupersessionUpdate(
        cardinality, projectId, storedSubject, ass.predicate, ass.object
      );
      await db.query(supersessionStmt.sql, supersessionStmt.params);
    }

    // ── Step 3: INSERT the new row with canonical subject ─────────────────────────
    //
    // Two-tier durability (Hybrid consolidation trigger):
    //   (a) High-trust: source='user_stated' AND confidence >= 9 — subject to L0 gate (see below).
    //   (b) Cross-session corroboration: same (subject, predicate, object) asserted
    //       from a DISTINCT non-null prior-session row → tier='consolidated'.
    //       (1:N tracked via the candidate loop above; 1:1 also tracked since L0.)
    //   Otherwise → tier='probationary'.
    //
    // L0 — consolidation_corroboration_gate (Attack-1 single-close forge prevention):
    //   When setting = 'enforce' (DEFAULT): the FULL newTier consolidated-birth decision
    //   is gated on genuine cross-session corroboration (crossSessionCorroborated = true).
    //   Defense-in-depth: the gate covers the ENTIRE decision (not just the isHighTrust
    //   boolean term) — both trigger (a) and trigger (b) require corroboration.
    //   A single close cannot self-stamp consolidated regardless of the source/confidence
    //   values it supplies — those are model-controlled fields. Only persisted, distinct
    //   prior close rows from a different session_id (which the closing model cannot
    //   fabricate in one close) satisfy the gate.
    //   If corroboration does NOT hold: row is born probationary (data fully preserved;
    //   probationary still participates in retrieval, ranked below consolidated).
    //   When setting = 'disabled': reverts to pre-L0 behavior byte-for-byte.
    //   The pre-L0 formula was: (isHighTrust || (cardinality === '1:N' && 1:N-corroboration))
    //   which is reproduced exactly via preLo1NCorroborated (1:N only, the original variable).
    //   Pinned rows: pinned is a suppression-exemption flag; not a tier-grant flag at write
    //   time. L0 does not alter pinned handling (suppression path, unaffected by newTier).
    //
    // L2 — consolidation_gate_mode (patient-adversary quality plug):
    //   Builds on L0 with a 3-arm gate.  A row is born consolidated ONLY IF:
    //     Arm (a) — reality-verified: this assertion's corroborating row OR the incoming
    //               close's own reality_check will be 'verified' (L3 reality-bound). However,
    //               the incoming row's reality_check is written AFTER the INSERT by the L3
    //               verify pass. For the L2 arm (a), we check whether the insertion context
    //               will be verified: not feasible at INSERT time without circular dependency.
    //               Instead, arm (a) is implemented via the pinned/reality_check check on
    //               the incoming assertion's own prior corroborators (or operator-confirmed).
    //               See note below: arm (a) for the NEW row itself is handled post-INSERT by
    //               cmdClose's L3 pass re-evaluating reality_check='verified' rows (these rows
    //               are already born consolidated by arm (a) if they arrive with a verified prior).
    //     Arm (b) — corroborated AND quality-plugged: crossSessionCorroborated=true AND
    //               hasQualityCorroborator=true (≥1 corroborating prior-session row is
    //               independently trustworthy: reality_check='verified' OR pinned).
    //     Arm (c) — operator-confirmed: the incoming assertion's pinned flag is true.
    //               This is the only genuine second actor in a single-operator system.
    //   Count-based thresholds (THR) are RETIRED: N corroborations is never the criterion.
    //   Only ONE independently-trustworthy corroborator is needed — adding more self-stamped
    //   corroborations never changes the outcome (a patient attacker cannot forge quality).
    //
    //   NOTE on the "genuinely user-evidenced" corroborator path: the design also names
    //   "genuinely user-evidenced" as a trustworthy basis, but that depends on L1
    //   (model-independent transcript capture) which is NOT implemented. In v1, the
    //   independently-trustworthy predicate is: (reality_check='verified') OR (pinned).
    //   The user-evidenced arm activates when L1 lands.
    //
    // consolidation_gate_mode: new setting controlling L2 behavior.
    //   disabled: L2 inert — tier outcomes byte-identical to post-L0 main (L0 gate applies).
    //   report:   compute L2 decision, LOG would-withhold, but do NOT change tier outcomes.
    //             (DEFAULT — mandatory report window before enforce)
    //   enforce:  full L2 3-arm gate actually decides tier.
    //
    // consolidated_at: set to now() when consolidated, SQL NULL otherwise.
    // corroboration_count: 1 + maxPriorCorrob when cross-session corroboration fires; 1 otherwise.
    //
    // SQL style note: consolidated_at uses now() (PG) / datetime('now') (SQLite) as a raw SQL
    // fragment embedded in the query string (matching the existing valid_at / last_reinforced
    // style) — NOT as a JS parameter.  The SQLiteAdapter's rewriteForSQLite regex rewrites
    // now() → datetime('now') automatically.  Do not parametrize a SQL function.
    //
    // L0 gate: read once, inside the transaction (plain SELECT — safe, no write).
    const corrobGate  = await getSetting(db, projectId, 'consolidation_corroboration_gate', 'enforce');
    const gateMode    = await getSetting(db, projectId, 'consolidation_gate_mode', 'report');
    const isHighTrust = (source === 'user_stated' && conf >= 9);
    const isPinned    = (ass.pinned === true || ass.pinned === 1);

    // L2 arm evaluation (evaluated regardless of gateMode for report/enforce use):
    //   arm (a): any corroborating prior row has reality_check='verified' (or is itself pinned)
    //            — hasQualityCorroborator already captures this from the candidate loop above.
    //   arm (b): crossSessionCorroborated AND hasQualityCorroborator.
    //   arm (c): the incoming assertion is operator-pinned.
    const l2ArmA = hasQualityCorroborator; // independently-trustworthy corroborator exists
    const l2ArmB = crossSessionCorroborated && hasQualityCorroborator;
    const l2ArmC = isPinned; // operator-confirmed
    const l2Consolidates = l2ArmA || l2ArmB || l2ArmC;

    // L0 tier outcome (used as base for disabled/report modes):
    const l0Tier = (corrobGate === 'disabled')
      ? ((isHighTrust || (cardinality === '1:N' && preLo1NCorroborated)) ? 'consolidated' : 'probationary')
      : (crossSessionCorroborated ? 'consolidated' : 'probationary');

    // newTier — full consolidated-birth decision considering both L0 and L2:
    let newTier;
    if (gateMode === 'enforce') {
      // L2 enforce: full 3-arm gate.
      newTier = l2Consolidates ? 'consolidated' : 'probationary';
    } else {
      // disabled or report: tier outcome is byte-identical to L0 (post-L0 main behavior).
      newTier = l0Tier;
      if (gateMode === 'report' && l0Tier === 'consolidated' && !l2Consolidates) {
        // Report mode: log what WOULD be withheld under enforce (but do NOT change the tier).
        process.stderr.write(
          `[handoff] L2 report: would-withhold consolidated→probationary for ` +
          `${canonSubject} ${ass.predicate} "${ass.object}" ` +
          `(crossSessionCorroborated=${crossSessionCorroborated}, hasQualityCorroborator=${hasQualityCorroborator}, pinned=${isPinned})\n`
        );
      }
    }

    const consolidatedAtSql = (newTier === 'consolidated') ? 'now()' : 'NULL';
    const newCorrob = (cardinality === '1:N' && crossSessionCorroborated)
      ? (maxPriorCorrob + 1)
      : 1;

    await db.query(
      `INSERT INTO assertions
         (project_id, subject, predicate, object, confidence, source, session_id,
          last_reinforced, valid_at, tier, consolidated_at, corroboration_count)
       VALUES ($1, $2, $3, $4, $5, $6, $7, now(), now(), $8, ${consolidatedAtSql}, $9)`,
      [projectId, canonSubject, ass.predicate, ass.object, conf, source, sessionId,
       newTier, newCorrob]
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
      DEGRADED_SECTION:    '',
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
    DEGRADED_SECTION:    '',
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

  // ── Identity resolution (MUST run before ensureSchemaCurrent) ────────────
  // Ordering constraint: project_id (which keys the schema_fingerprint row)
  // cannot be known until identity is resolved. ensureProjectIdentity is
  // the FIRST internal-check step; ensureSchemaCurrent follows immediately.
  let projectId;
  let root;
  try {
    const identity = await ensureProjectIdentity(db, { silent: false });
    projectId = identity.projectId;
    root      = identity.root;
  } catch (idErr) {
    // ensureProjectIdentity calls process.exit(1) on fatal errors.
    process.stderr.write('[handoff] identity resolution failed (unexpected): ' + idErr.message + '\n');
    process.exit(1);
  }

  // ── Item 6: Idempotent legacy-settings reconciliation ────────────────────
  // Remove orphaned project_settings rows keyed to the legacy encodeCwd(root) id
  // for this project ONLY — strictly scoped, idempotent, snapshot-first.
  // Non-fatal: any error is logged and ignored so close can proceed.
  try {
    const { encodeCwd: _encodeCwd } = require('./lib/encoded-cwd');
    const legacyIdForReconcile = _encodeCwd(root);
    await reconcileLegacySettings(db, legacyIdForReconcile, projectId, { silent: true });
  } catch (reconcileErr) {
    process.stderr.write('[handoff] legacy reconcile (non-fatal): ' + reconcileErr.message + '\n');
  }

  const handoffPath = resolveHandoffMdPath(projectId);

  // Deliverable A: auto-apply additive schema on drift (non-fatal).
  // Runs immediately after identity resolution, before payload processing.
  // Any error here must NOT abort close — wrap and continue.
  try {
    await ensureSchemaCurrent(db, projectId, { silent: false });
  } catch (schemaErr) {
    process.stderr.write('[handoff] schema auto-apply failed (non-fatal): ' + schemaErr.message + '\n');
  }

  // ── L3: Reality-check registry — authoritative pass ──────────────────────────
  //
  // Replaces the former "Deliverable B" hard-coded has_unpackaged_state block.
  // Behavior is fully generalized through the REALITY_CHECKS registry (see
  // scripts/lib/reality-checks.js) while preserving byte-identical output for
  // the existing has_unpackaged_state authoritative injection (golden test).
  //
  // Authoritative mode: for each registered 'authoritative' entry whose
  //   subjectMatch fires on at least one assertion (or unconditionally), strip
  //   ALL model-supplied assertions for that predicate and inject a single
  //   code-computed canonical one.  Applies to BOTH the async (enqueue) path
  //   and the synchronous (writeExtraction) path.
  //
  // The subject, confidence, and source of each injected assertion are determined
  // by the registry entry's probe and the canonical injection shape below.
  {
    const { REALITY_CHECKS } = require('./lib/reality-checks');

    for (const check of REALITY_CHECKS) {
      if (check.mode !== 'authoritative') continue;

      // Strip model-supplied rows for this predicate.
      const originalCount = (payload.assertions || []).length;
      const filtered = (payload.assertions || []).filter((a) => {
        if (typeof a.predicate === 'string' &&
            a.predicate.trim().toLowerCase() === check.predicate.toLowerCase()) {
          process.stderr.write(
            `[handoff] discarded model-supplied ${check.predicate} assertion — ${check.predicate} state is computed authoritatively\n`
          );
          return false;
        }
        return true;
      });
      if (filtered.length < originalCount) {
        payload = Object.assign({}, payload, { assertions: filtered });
      }

      // Run the probe and inject the canonical assertion.
      // Probe is fail-soft: null return → skip injection (non-fatal).
      try {
        const probeResult = check.probe(root);
        if (probeResult !== null) {
          // Canonical injection shape — byte-identical to the pre-L3 hard-coded block
          // for has_unpackaged_state (golden-test invariant):
          //   subject:    path.basename(root)
          //   predicate:  check.predicate
          //   object:     probe result string
          //   confidence: 9
          //   source:     'user_stated'
          const canonicalAssertion = {
            subject:    path.basename(root),
            predicate:  check.predicate,
            object:     probeResult,
            confidence: 9,
            source:     'user_stated',
          };
          payload = Object.assign({}, payload, {
            assertions: (payload.assertions || []).concat([canonicalAssertion]),
          });
        }
      } catch (probeErr) {
        // Non-fatal: probe threw unexpectedly — skip injection and continue.
        process.stderr.write(
          `[handoff] ${check.predicate} authoritative probe failed (non-fatal): ${probeErr.message}\n`
        );
      }
    }
  }

  // ── Deliverable B2: suppress legacy-subject has_unpackaged_state orphans ──────
  //
  // Prior to PR-1, the packaging assertion was written via writeAssertionWithSupersession
  // using subject "<basename> working tree" (source=model_extracted, confidence=8).
  // PR-1 changed the canonical subject to "<basename>" (source=user_stated, confidence=9).
  // Because the subjects differ, canonicalization differs, so the new canonical write does
  // NOT suppress the old row — leaving a stale contradictory orphan.
  //
  // Fix: after injecting the canonical assertion, suppress any live (suppressed=false)
  // has_unpackaged_state row in this project whose subject is NOT the canonical subject.
  // Uses the existing buildSupersessionUpdate port method (dialect-neutral, zero new SQL).
  // Idempotent: once suppressed, subsequent closes are a no-op on the legacy row.
  // Non-fatal: mirrors the surrounding ensureSchemaCurrent error semantics.
  try {
    const canonBasename = path.basename(root);
    const { rows: legacyPackRows } = await db.query(
      `SELECT DISTINCT subject FROM assertions
       WHERE project_id = $1
         AND predicate  = $2
         AND suppressed = false
         AND invalid_at IS NULL`,
      [projectId, 'has_unpackaged_state']
    );
    for (const row of legacyPackRows) {
      if (row.subject !== canonBasename) {
        // This is a legacy/non-canonical subject row — suppress it.
        const suppressStmt = db.buildSupersessionUpdate('1:1', projectId, row.subject, 'has_unpackaged_state', null);
        await db.query(suppressStmt.sql, suppressStmt.params);
      }
    }
  } catch (legacyCleanupErr) {
    process.stderr.write('[handoff] legacy has_unpackaged_state cleanup failed (non-fatal): ' + legacyCleanupErr.message + '\n');
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
      DEGRADED_SECTION:    '',
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

  // Surface CLAUDE.md promotion candidates (conf >= 9, user_stated, multi-session).
  // Hole A fix: col-minus-col epoch difference now goes through a port method so both
  // Postgres (EXTRACT) and SQLite (julianday) produce identical results.
  //
  // Candidate-query bug fix (L2): SELECT was missing id and tier columns. Later code
  // reads r.id (for the source_assertion annotation) and r.tier (for L2 transitive
  // binding). Without these columns, r.id is undefined and the annotation is corrupted.
  //
  // L2 transitive binding: only gate-consolidated rows are eligible for CLAUDE.md
  // promotion. A self-stamped row that is merely source='user_stated' but tier='probationary'
  // (because it did not satisfy the L2 gate) is NOT eligible — this closes the transitive
  // forge where a self-stamped row both self-consolidates and self-promotes into CLAUDE.md.
  // When consolidation_gate_mode='disabled' or 'report', tier='consolidated' rows are those
  // produced by the L0 gate (post-L0 main behavior); under 'enforce', only L2-consolidated
  // rows have tier='consolidated'. In all modes, the tier='consolidated' filter is the
  // gate — CLAUDE.md eligibility is always transitively bound to the active gate decision.
  const multiSessionPred = db.buildEpochSecondsDiffPredicate(
    'last_reinforced', 'created_at', '>', 86400
  );
  const { rows: candidates } = await db.query(
    `SELECT id, subject, predicate, object, confidence, tier
     FROM assertions
     WHERE project_id = $1
       AND suppressed = false
       AND confidence >= 9
       AND source = 'user_stated'
       AND tier = 'consolidated'
       AND ${multiSessionPred}
     ORDER BY confidence DESC`,
    [projectId]
  );
  if (candidates.length > 0) {
    console.log('\n  CLAUDE.md promotion candidates (confidence >= 9, user_stated, consolidated, multi-session):');
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

  // L4: Accumulate degraded-close records for C2/C3 unresolvable-session skips.
  // Written to project_settings and surfaced in the close summary / handoff.md
  // by the writeHandoffMd call below (after C2 and C3 complete).
  const stamp = new Date().toISOString();
  const _degradedSubsystems = [];

  // ── L3: Reality-check registry — verify pass (strictly non-mutating) ──────────
  //
  // For each registered 'verify'-mode entry, find live assertions written this
  // close whose predicate and subject match the entry.  Run the probe and tag the
  // row with reality_check='verified' | 'mismatch' | 'unverifiable'.
  //
  // DESIGN-OF-RECORD INVARIANTS:
  //   - confidence, source, and tier are NEVER modified on any row.
  //   - Only the reality_check column is written.
  //   - Probe failure (null) → 'unverifiable'; close exits normally.
  //   - Mismatch → routes through recordDegradedClose (L4 surface) so it persists,
  //     shows in the close summary, and re-surfaces on resume via the L4 banner.
  //   - is_at_commit is NOT included; it records historical ship points and must
  //     not be reality-verified against now-state.
  try {
    const { REALITY_CHECKS } = require('./lib/reality-checks');
    const verifySessionId = payload.session_id || null;

    for (const check of REALITY_CHECKS) {
      if (check.mode !== 'verify') continue;

      // Find live assertions for this predicate (written this close or pre-existing).
      // The verify pass is best-effort — it queries all live rows for the predicate
      // so it catches just-written assertions regardless of session id.
      let verifyRows;
      try {
        const { rows } = await db.query(
          `SELECT id, subject, object FROM assertions
           WHERE project_id = $1
             AND predicate  = $2
             AND suppressed = false
             AND invalid_at IS NULL`,
          [projectId, check.predicate]
        );
        verifyRows = rows;
      } catch (queryErr) {
        process.stderr.write(
          `[handoff] L3 verify query for "${check.predicate}" failed (non-fatal): ${queryErr.message}\n`
        );
        continue;
      }

      for (const row of verifyRows) {
        if (!check.subjectMatch(row.subject, root)) continue;

        // Run the probe; it accepts (root, object) to allow object-dependent probes.
        let probeResult;
        try {
          probeResult = check.probe(root, row.object);
        } catch (probeErr) {
          // Probe threw unexpectedly — treat as unverifiable (fail-soft).
          probeResult = null;
        }

        let tag;
        if (probeResult === null) {
          tag = 'unverifiable';
        } else if (probeResult === row.object) {
          tag = 'verified';
        } else {
          tag = 'mismatch';
        }

        // Write only the reality_check column — NEVER touch conf/source/tier.
        try {
          await db.query(
            `UPDATE assertions SET reality_check = $1 WHERE id = $2`,
            [tag, row.id]
          );
        } catch (updateErr) {
          process.stderr.write(
            `[handoff] L3 reality_check tag write failed for assertion ${row.id} (non-fatal): ${updateErr.message}\n`
          );
          continue;
        }

        // On mismatch, route through L4's degraded-close surface.
        if (tag === 'mismatch') {
          const reason =
            `${check.predicate} subject="${row.subject}": ` +
            `asserted "${row.object}" but probe returned "${probeResult}"`;
          await recordDegradedClose(db, projectId, verifySessionId, 'reality_verify', reason);
          _degradedSubsystems.push({ subsystem: 'reality_verify', reason });
          process.stderr.write(
            `[handoff] L3 reality mismatch (non-fatal): ${reason}\n`
          );
        }
      }
    }
  } catch (verifyPassErr) {
    // Fully non-fatal: any error in the verify dispatch must not abort close.
    process.stderr.write(`[handoff] L3 verify pass failed (non-fatal): ${verifyPassErr.message}\n`);
  }

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
    const feedbackEnabled = await getSetting(db, projectId, 'feedback_loop_enabled', 'enabled');
    if (feedbackEnabled === 'enabled') {
      // Re-resolve session id (same approach as outcome capture, before marker is cleared).
      const fbSessionId = (typeof payload.session_id === 'string' && payload.session_id.length > 0)
        ? payload.session_id
        : await getSetting(db, projectId, 'session_in_progress', null);

      if (!fbSessionId) {
        // No session id — skip silently (nothing to attribute).
        // L4: Record degraded close — C2 skipped because session id is unresolvable.
        // Persists to project_settings so the resume path can surface a warning banner.
        process.stderr.write('[handoff] C2 feedback: no session id resolvable — skipping bias update\n');
        await recordDegradedClose(db, projectId, null, 'C2', 'no session id resolvable — skipping bias update');
        _degradedSubsystems.push({ subsystem: 'C2', reason: 'no session id resolvable — skipping bias update' });
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
            // PR-B: C2 feedback now distinguishes suppression_kind and respects pinned exemption.
            //
            // Downvote thresholds (hardcoded conservative values):
            //   Net delta < -1.5 over this session → downvoted_probation (soft, recoverable).
            //   Net delta < -3.0 over this session → downvoted_terminal  (terminal, not auto-revivable).
            // Positive net delta → REHABILITATION: if a row is in downvoted_probation,
            //   clear it back to live (clears suppressed, invalid_at, suppression_kind).
            //
            // Pinned rows (pinned = true/1): NEVER auto-suppressed/downvoted by this path.
            //   The filter is applied via a WHERE pinned = false guard on all downvote UPDATEs.
            //
            // outcome_bias update is applied REGARDLESS of whether suppression fires —
            //   bias reflects retrieval quality signal even on live rows.
            const DOWNVOTE_PROBATION_THRESHOLD = -1.5;
            const DOWNVOTE_TERMINAL_THRESHOLD  = -3.0;

            let biasAdjusted = 0;
            let downvotedProbation = 0;
            let downvotedTerminal  = 0;
            let rehabilitated      = 0;

            for (const row of aggRes.rows) {
              const delta =
                row.success_count    * successDelta +
                row.failure_count    * failureDelta +
                row.irrelevant_count * irrelevantDelta;

              // 1. Update outcome_bias (CLAMP via GREATEST/LEAST in SQL for atomicity).
              await db.query(
                `UPDATE assertions
                 SET outcome_bias = GREATEST($2::float, LEAST($3::float, outcome_bias + $4::float))
                 WHERE id = $1`,
                [row.assertion_id, -biasClamp, biasClamp, delta]
              );
              biasAdjusted++;

              // 2. Determine downvote / rehabilitation action based on net delta.
              if (delta > 0) {
                // Positive signal → attempt rehabilitation for probation rows.
                const rehabStmt = db.buildProbationRehabUpdate([row.assertion_id]);
                if (rehabStmt) {
                  const rehabResult = await db.query(rehabStmt.sql, rehabStmt.params);
                  if (rehabResult.rowCount > 0) rehabilitated++;
                }
              } else if (delta <= DOWNVOTE_TERMINAL_THRESHOLD) {
                // Strong negative → terminal downvote (not auto-revivable; pinned exempt).
                // Only fires on currently live rows (suppressed=false, invalid_at IS NULL).
                await db.query(
                  `UPDATE assertions
                   SET suppressed = true, invalid_at = now(), suppression_kind = 'downvoted_terminal'
                   WHERE id = $1
                     AND suppressed = false
                     AND invalid_at IS NULL
                     AND (pinned = false OR pinned IS NULL)`,
                  [row.assertion_id]
                );
                downvotedTerminal++;
              } else if (delta <= DOWNVOTE_PROBATION_THRESHOLD) {
                // Moderate negative → probation downvote (recoverable via rehabilitation).
                // Only fires on currently live rows (suppressed=false, invalid_at IS NULL).
                await db.query(
                  `UPDATE assertions
                   SET suppressed = true, invalid_at = now(), suppression_kind = 'downvoted_probation'
                   WHERE id = $1
                     AND suppressed = false
                     AND invalid_at IS NULL
                     AND (pinned = false OR pinned IS NULL)`,
                  [row.assertion_id]
                );
                downvotedProbation++;
              }
              // else: delta between 0 and DOWNVOTE_PROBATION_THRESHOLD → bias adjustment only.
            }
            const parts = [`adjusted outcome_bias for ${biasAdjusted} assertion(s)`];
            if (downvotedProbation > 0) parts.push(`${downvotedProbation} → downvoted_probation`);
            if (downvotedTerminal  > 0) parts.push(`${downvotedTerminal} → downvoted_terminal`);
            if (rehabilitated      > 0) parts.push(`${rehabilitated} probation row(s) rehabilitated`);
            console.log(`  C2 feedback: ${parts.join('; ')} (session=${fbSessionId})`);
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
        // L4: Record degraded close — C3 skipped because session id is unresolvable.
        // Persists to project_settings so the resume path can surface a warning banner.
        process.stderr.write('[handoff] C3 evolution: no session id resolvable — skipping\n');
        await recordDegradedClose(db, projectId, null, 'C3', 'no session id resolvable — skipping');
        _degradedSubsystems.push({ subsystem: 'C3', reason: 'no session id resolvable — skipping' });
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
              // Hole B fix: >= interval predicate now goes through a port method so
              // both Postgres and SQLite produce identical row selection results.
              const withinWindowPred = db.buildWithinDaysPredicate('retrieved_at', '>=', 2);
              const { rows: evtRows } = await db.query(
                `SELECT query_text, outcome
                 FROM retrieval_events
                 WHERE project_id = $1
                   AND outcome IN ('success', 'failure', 'irrelevant')
                   AND ${withinWindowPred}`,
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

  // ── L4: Write handoff.md (after C2/C3) with DEGRADED_SECTION ─────────────────
  //
  // This is the single authoritative handoff.md write for the synchronous close path.
  // When _degradedSubsystems is empty (clean close), DEGRADED_SECTION is '' and the
  // rendered output is byte-identical to the pre-L4 template output.
  // When any subsystem is degraded, a ## Degraded section is appended.
  {
    const degradedSection = _degradedSubsystems.length > 0
      ? '\n\n## Degraded\n' + _degradedSubsystems.map(
          (d) => `- ${d.subsystem} ${d.reason}`
        ).join('\n')
      : '';

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
      DEGRADED_SECTION:    degradedSection,
    });

    // Surface degraded subsystems in the close summary (operator-visible).
    for (const d of _degradedSubsystems) {
      console.log(`  ${d.subsystem} skipped: ${d.reason}`);
    }
  }

  // ── Packaging-honesty display (non-fatal, synchronous close path only) ────────
  //
  // Detects whether the session's work is already committed and pushed, and
  // displays the result.  The has_unpackaged_state assertion is now written
  // authoritatively via payload.assertions (injected above, before writeExtraction)
  // so no separate writeAssertionWithSupersession call is needed here.
  // NEVER blocks, commits, stashes, pushes, or mutates the repository.
  try {
    const packState = detectUnpackagedState(root);
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

  // L4: Read close_degraded_exit_mode BEFORE closing the DB connection.
  // Values: 'warn' (default, exit 0) | 'strict' (exit 3 on any degraded subsystem).
  const closeDegradedExitMode = await getSetting(db, projectId, 'close_degraded_exit_mode', 'warn');

  await db.end();

  console.log(`\n  entities written:    ${entitiesWritten}`);
  console.log(`  assertions written:  ${assertionsWritten}`);
  console.log(`  edges written:       ${edgesWritten}`);
  console.log(`  contract:            updated`);
  console.log(`\nDone: handoff:close — ${entitiesWritten}e/${assertionsWritten}a/${edgesWritten}ed written, session marker cleared`);

  // L4: Exit-code gate — 'strict' mode exits 3 when any subsystem ran degraded.
  if (_degradedSubsystems.length > 0 && closeDegradedExitMode === 'strict') {
    process.stderr.write(
      `[handoff] close_degraded_exit_mode=strict — exiting 3 (${_degradedSubsystems.length} degraded subsystem(s))\n`
    );
    process.exit(3);
  }
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
      DEGRADED_SECTION:    '',
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

  // Mark assertion as promoted and graduate to consolidated tier.
  // Two-tier durability: explicit promote is the sanctioned graduation arm (not a §7 violation —
  // §7 forbids auto-mutating the existing corpus; explicit /handoff:promote of one targeted row
  // is an intentional user-driven action, not a backfill).  Sets tier='consolidated',
  // consolidated_at=now() in addition to the existing promoted/promoted_at columns.
  await db.query(
    `UPDATE assertions
     SET promoted = true, promoted_at = now(),
         tier = 'consolidated', consolidated_at = now()
     WHERE id = $1`,
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

// ── prune ─────────────────────────────────────────────────────────────────────

/**
 * Operator manual prune: surgically hard-delete selected assertion rows.
 *
 * Distinct from purge (hard-delete EVERYTHING) and drop (archive + fresh start).
 * Operates on assertions ONLY — entities and edges are out of scope for this command.
 * MANUAL / operator-invoked ONLY — never triggered automatically.
 *
 * Usage:
 *   node scripts/handoff.js prune [--suppressed] [--suppression-kind <kind>]
 *                                  [--subject <subject>] [--older-than <days>]
 *                                  [--include-pinned] [--apply]
 *
 *   At least ONE criterion flag is required (--suppressed, --suppression-kind,
 *   --subject, or --older-than). Running with no criteria is refused — that is
 *   what `purge` is for.
 *
 * Behavior:
 *   Dry-run (default, no --apply): prints counts and a sample of what WOULD be
 *     deleted; makes zero DB changes.
 *   --apply: performs the hard DELETE; second --apply is idempotent (no-op if
 *     nothing matches).
 *
 * Pinned safety:
 *   Pinned rows (pinned=true/1) are NEVER deleted unless --include-pinned is given.
 *   Pinned rows that match the criteria are counted and reported as skipped.
 *
 * Criteria (AND-combined):
 *   --suppressed                          rows where suppressed = true
 *   --suppression-kind <kind>             rows where suppression_kind = <kind>
 *                                         valid: superseded | downvoted_terminal |
 *                                                downvoted_probation
 *   --subject <raw-or-canonical>          rows where subject = canonicalize(<arg>)
 *   --older-than <days>                   rows where last_reinforced < now()-N days
 *
 *   Criteria combine as AND. Always project-scoped (never touches other projects).
 */
async function cmdPrune(args) {
  console.log('Running: handoff:prune');

  // ── Parse flags ─────────────────────────────────────────────────────────────

  const applyMode    = args.includes('--apply');
  const includePinned = args.includes('--include-pinned');

  // --suppressed (boolean flag)
  const wantSuppressed = args.includes('--suppressed');

  // --suppression-kind <kind>
  const skIdx = args.indexOf('--suppression-kind');
  const suppressionKind = skIdx !== -1 ? args[skIdx + 1] : undefined;
  if (skIdx !== -1 && !suppressionKind) {
    console.error('prune: --suppression-kind requires a value (superseded | downvoted_terminal | downvoted_probation)');
    process.exit(2);
  }
  const validKinds = ['superseded', 'downvoted_terminal', 'downvoted_probation'];
  if (suppressionKind && !validKinds.includes(suppressionKind)) {
    console.error(`prune: invalid --suppression-kind "${suppressionKind}". Valid: ${validKinds.join(', ')}`);
    process.exit(2);
  }

  // --subject <raw-or-canonical>
  const subjectIdx = args.indexOf('--subject');
  let rawSubject = subjectIdx !== -1 ? args[subjectIdx + 1] : undefined;
  if (subjectIdx !== -1 && !rawSubject) {
    console.error('prune: --subject requires a value');
    process.exit(2);
  }
  // Canonicalize: trim + lowercase + collapse whitespace + alias-map lookup
  const canonSubject = rawSubject != null ? canonicalize(rawSubject) : undefined;

  // --older-than <days>
  const otIdx = args.indexOf('--older-than');
  let olderThanDays;
  if (otIdx !== -1) {
    const rawDays = args[otIdx + 1];
    if (!rawDays) {
      console.error('prune: --older-than requires a value (number of days)');
      process.exit(2);
    }
    olderThanDays = Number(rawDays);
    if (!Number.isFinite(olderThanDays) || olderThanDays <= 0) {
      console.error(`prune: invalid --older-than value "${rawDays}" — must be a positive number`);
      process.exit(2);
    }
  }

  // ── At least one criterion required ─────────────────────────────────────────
  const hasCriteria = wantSuppressed || suppressionKind != null || canonSubject != null || olderThanDays != null;
  if (!hasCriteria) {
    console.error(
      'prune: at least one criterion is required (--suppressed, --suppression-kind, --subject, --older-than).\n' +
      'To delete ALL project memory, use: handoff purge'
    );
    process.exit(2);
  }

  // ── Build criteria object ────────────────────────────────────────────────────
  const criteria = {
    suppressed:      wantSuppressed    ? true          : undefined,
    suppressionKind: suppressionKind,
    subject:         canonSubject,
    olderThanDays:   olderThanDays,
    includePinned:   includePinned,
  };

  const projectId = resolveProjectId();

  console.log('');
  console.log(`  mode          : ${applyMode ? '--apply (DELETES ENABLED)' : 'dry-run (read-only, default)'}`);
  console.log(`  project_id    : ${projectId}`);
  if (criteria.suppressed)      console.log(`  criterion     : suppressed = true`);
  if (criteria.suppressionKind) console.log(`  criterion     : suppression_kind = '${criteria.suppressionKind}'`);
  if (criteria.subject != null) console.log(`  criterion     : subject = '${criteria.subject}' (canonicalized from '${rawSubject}')`);
  if (criteria.olderThanDays)   console.log(`  criterion     : last_reinforced < now() - ${criteria.olderThanDays} day(s)`);
  console.log(`  include-pinned: ${includePinned}`);
  console.log('');

  let db;
  try {
    db = await connectHandoff();
  } catch (err) {
    console.error(`DB connection failed: ${err.message}`);
    process.exit(1);
  }

  // ── SELECT: preview what matches ──────────────────────────────────────────────
  const { sql: selectSql, params: selectParams } = db.buildPruneSelect(criteria, projectId);
  const { rows: matchedRows } = await db.query(selectSql, selectParams);

  // Partition into pinned and non-pinned
  const pinnedRows    = matchedRows.filter((r) => r.pinned === true || r.pinned === 1);
  const nonPinnedRows = matchedRows.filter((r) => !(r.pinned === true || r.pinned === 1));

  // In dry-run, report what would be deleted (non-pinned) and what would be skipped (pinned)
  const toDeleteCount = includePinned ? matchedRows.length : nonPinnedRows.length;
  const skippedPinnedCount = includePinned ? 0 : pinnedRows.length;

  console.log(`  Matched rows        : ${matchedRows.length}`);
  console.log(`  Would delete        : ${toDeleteCount}`);
  if (skippedPinnedCount > 0) {
    console.log(`  Skipped (pinned)    : ${skippedPinnedCount} (use --include-pinned to include)`);
  }
  console.log('');

  if (matchedRows.length > 0) {
    // Print a sample of up to 10 rows for operator review
    const sampleSize = Math.min(10, toDeleteCount);
    const sampleRows = includePinned ? matchedRows.slice(0, sampleSize) : nonPinnedRows.slice(0, sampleSize);
    if (sampleRows.length > 0) {
      console.log(`  Sample of rows that ${applyMode ? 'will be' : 'would be'} deleted (up to 10):`);
      for (const row of sampleRows) {
        const pinnedNote = (row.pinned === true || row.pinned === 1) ? ' [PINNED]' : '';
        console.log(`    id=${row.id}  subject="${row.subject}"  predicate="${row.predicate}"  object="${String(row.object).slice(0, 60)}"${pinnedNote}`);
      }
      if (toDeleteCount > sampleSize) {
        console.log(`    ... and ${toDeleteCount - sampleSize} more`);
      }
      console.log('');
    }
    if (skippedPinnedCount > 0) {
      const pinnedSample = Math.min(5, pinnedRows.length);
      console.log(`  Skipped pinned rows (up to 5):`);
      for (const row of pinnedRows.slice(0, pinnedSample)) {
        console.log(`    id=${row.id}  subject="${row.subject}"  predicate="${row.predicate}"`);
      }
      if (pinnedRows.length > pinnedSample) {
        console.log(`    ... and ${pinnedRows.length - pinnedSample} more pinned rows skipped`);
      }
      console.log('');
    }
  }

  if (!applyMode) {
    await db.end();
    if (toDeleteCount === 0) {
      console.log('  No rows match the given criteria.');
    } else {
      console.log(`  Dry-run complete — no changes made.`);
      console.log(`  Run with --apply to perform the deletion.`);
    }
    console.log('\nDone: handoff:prune — dry-run (no changes)');
    return;
  }

  // ── APPLY: hard delete ────────────────────────────────────────────────────────
  if (toDeleteCount === 0) {
    await db.end();
    console.log('  No rows match the given criteria — nothing to delete.');
    console.log('\nDone: handoff:prune — 0 rows deleted (no-op)');
    return;
  }

  const { sql: deleteSql, params: deleteParams } = db.buildPruneDelete(criteria, projectId);
  const { rowCount: deletedCount } = await db.query(deleteSql, deleteParams);

  await db.end();

  console.log(`  Deleted ${deletedCount} assertion row(s).`);
  if (skippedPinnedCount > 0) {
    console.log(`  ${skippedPinnedCount} pinned row(s) protected from deletion (use --include-pinned to override).`);
  }
  console.log(`\nDone: handoff:prune — ${deletedCount} row(s) hard-deleted`);
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
    prune:           () => cmdPrune(rest),
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
