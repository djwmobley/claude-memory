/**
 * shared.js — Common utilities for pipeline scripts
 *
 * Exports: findProjectRoot, loadConfig, connect, c, ollamaDefaults
 */

const { Client } = require('pg');
const fs = require('fs');
const path = require('path');

// ─── ANSI ────────────────────────────────────────────────────────────────────

const c = {
  bold:   (s) => `\x1b[1m${s}\x1b[0m`,
  green:  (s) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  red:    (s) => `\x1b[31m${s}\x1b[0m`,
  cyan:   (s) => `\x1b[36m${s}\x1b[0m`,
  dim:    (s) => `\x1b[2m${s}\x1b[0m`,
};

// ─── OLLAMA DEFAULTS ────────────────────────────────────────────────────────

const ollamaDefaults = {
  host: 'localhost',
  port: 11434,
  model: 'mxbai-embed-large',
};

// ─── PROJECT ROOT ───────────────────────────────────────────────────────────

/**
 * Find the project root directory.
 *
 * Resolution order:
 * 1. process.env.PROJECT_ROOT — if set, used as-is (avoids the bug where
 *    scripts invoked via `cd <scripts_dir> && node pipeline-db.js` find
 *    the pipeline plugin's .git instead of the user project's .git).
 * 2. Walk up from cwd looking for a .git directory.
 * 3. Fall back to cwd.
 */
function findProjectRoot() {
  if (process.env.PROJECT_ROOT) return process.env.PROJECT_ROOT;
  let dir = process.cwd();
  while (dir !== path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, '.git'))) return dir;
    dir = path.dirname(dir);
  }
  return process.cwd();
}

// ─── CONFIG ─────────────────────────────────────────────────────────────────

/**
 * Sanitize a project name into a valid Postgres database name.
 * Lowercase, replace non-alphanumeric with underscore, prefix with pipeline_.
 */
function projectToDbName(projectName) {
  const sanitized = projectName.toLowerCase().replace(/[^a-z0-9]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '');
  return `pipeline_${sanitized}`;
}

function loadConfig() {
  const root = findProjectRoot();
  const configPath = path.join(root, '.claude', 'pipeline.yml');
  const projectName = path.basename(root);
  const defaults = {
    host: 'localhost', port: 5432,
    database: projectToDbName(projectName), user: 'postgres',
    project: projectName,
  };

  if (!fs.existsSync(configPath)) return { ...defaults, root, knowledge: { tier: 'files', host: defaults.host, port: defaults.port, database: defaults.database, user: defaults.user, embedding_model: null, num_ctx: null } };
  const content = fs.readFileSync(configPath, 'utf8');

  // Get a top-level key (not indented)
  const getTopLevel = (key) => {
    const match = content.match(new RegExp(`^${key}:\\s*"?([^"\\n]+)"?`, 'm'));
    return match ? match[1].trim() : null;
  };

  // Extract a YAML section (from "key:" to next top-level key or EOF)
  const getSection = (section) => {
    const match = content.match(new RegExp(`^${section}:.*\\n((?:[ \\t]+.*\\n?)*)`, 'm'));
    return match ? match[1] : '';
  };

  // Get a value within a specific section
  const getInSection = (section, key) => {
    const sectionContent = getSection(section);
    const match = sectionContent.match(new RegExp(`^\\s*${key}:\\s*"?([^"\\n]+)"?`, 'm'));
    return match ? match[1].trim() : null;
  };

  const resolvedProjectName = getInSection('project', 'name') || defaults.project;
  const tier = getInSection('knowledge', 'tier') || 'files';
  const host = getInSection('knowledge', 'host') || defaults.host;
  const port = parseInt(getInSection('knowledge', 'port') || defaults.port);
  const database = getInSection('knowledge', 'database') || defaults.database;
  const user = getInSection('knowledge', 'user') || defaults.user;
  const embedding_model = getInSection('knowledge', 'embedding_model') || null;
  const num_ctx = getInSection('knowledge', 'num_ctx') || null;

  return {
    host,
    port,
    database,
    user,
    project: resolvedProjectName,
    // knowledge: nested object mirrors routing-config.js shape for cross-script consistency
    knowledge: { tier, host, port, database, user, embedding_model, num_ctx },
    root,
  };
}

// ─── CONNECT ────────────────────────────────────────────────────────────────

async function connect(config) {
  const cfg = config || loadConfig();
  const client = new Client({
    host: cfg.host,
    port: cfg.port,
    database: cfg.database,
    user: cfg.user,
  });
  await client.connect();
  return client;
}

// ─── OLLAMA EMBED ──────────────────────────────────────────────────────────

const http = require('http');

/**
 * Call Ollama /api/embed to generate vector embeddings for one or more texts.
 * Returns an array of embedding arrays (one per input text).
 */
function ollamaEmbed(texts, config) {
  const model = (config && config.embedding_model) || ollamaDefaults.model;
  const host = ollamaDefaults.host;
  const port = ollamaDefaults.port;
  const numCtx = config && config.num_ctx ? parseInt(config.num_ctx) : null;

  return new Promise((resolve, reject) => {
    const reqBody = { model, input: texts };
    if (numCtx) reqBody.options = { num_ctx: numCtx };
    const body = JSON.stringify(reqBody);
    const opts = {
      hostname: host, port, path: '/api/embed', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    };
    const req = http.request(opts, (res) => {
      let data = '';
      res.on('data', d => { data += d; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (!parsed.embeddings || !Array.isArray(parsed.embeddings)) {
            return reject(new Error(`Ollama error: ${JSON.stringify(parsed).slice(0, 200)}`));
          }
          if (parsed.embeddings.length !== texts.length) {
            return reject(new Error(
              `Ollama returned ${parsed.embeddings.length} embeddings for ${texts.length} inputs ` +
              `(likely context overrun — chunk text smaller before retry)`
            ));
          }
          for (let i = 0; i < parsed.embeddings.length; i++) {
            const vec = parsed.embeddings[i];
            if (!Array.isArray(vec) || vec.length === 0) {
              return reject(new Error(
                `Ollama returned empty embedding at index ${i} ` +
                `(likely context overrun — chunk text smaller before retry)`
              ));
            }
            let sumSquares = 0;
            for (let j = 0; j < vec.length; j++) sumSquares += vec[j] * vec[j];
            if (Math.sqrt(sumSquares) < 1e-9) {
              return reject(new Error(
                `Ollama returned zero-magnitude embedding at index ${i} ` +
                `(likely context overrun — chunk text smaller before retry)`
              ));
            }
          }
          resolve(parsed.embeddings);
        } catch (e) { reject(e); }
      });
    });
    req.on('error', (e) => {
      reject(new Error(`Cannot reach Ollama at ${host}:${port} — is it running? (${e.message})`));
    });
    req.write(body);
    req.end();
  });
}

/**
 * Embed a single text and write the vector to a table row. Degrades gracefully —
 * if Ollama is not running or the embedding column doesn't exist, the row is
 * written without an embedding (can be backfilled later with `pipeline-embed.js index`).
 *
 * @param {Client} client - connected pg Client
 * @param {string} table - table name (MUST be a static constant, never user input)
 * @param {string} idCol - column name for the row identifier
 * @param {*} idVal - value of the row identifier
 * @param {string} text - text to embed
 * @param {object} config - pipeline config (for embedding_model)
 */
async function tryEmbed(client, table, idCol, idVal, text, config) {
  try {
    // Check if embedding column exists
    const { rows } = await client.query(
      "SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = $1 AND column_name = 'embedding'",
      [table]
    );
    if (rows.length === 0) return; // no embedding column — skip silently

    const [embedding] = await ollamaEmbed([text], config);
    const vec = `[${embedding.join(',')}]`;
    await client.query(`UPDATE ${table} SET embedding = $1 WHERE ${idCol} = $2`, [vec, idVal]);
  } catch (_) {
    // Ollama not running or embed failed — row exists without embedding.
    // Backfill later with: node pipeline-embed.js index
  }
}

// ─── WINDOWS BINARY INVOCATION ──────────────────────────────────────────────
//
// Invokes a binary that may be distributed as .cmd or .bat on Windows (pnpm, npx,
// az, yarn, etc.). Handles two Windows subprocess hazards:
//
//   1. PATHEXT resolution. `execFileSync(bin, ...)` with `shell: false` does not
//      resolve PATHEXT, so bare names like `pnpm` fail with ENOENT when the
//      installed file is `pnpm.cmd` or `pnpm.exe`. Caller passes an explicit
//      candidate list and we iterate on ENOENT.
//
//   2. CVE-2024-27980 / "BatBadBut" hardening. Node 22+ refuses to invoke .cmd
//      and .bat files via execFile with `shell: false`, returning EINVAL with
//      "spawnSync <file> EINVAL". Fix: for .cmd/.bat, spawn cmd.exe /d /s /c
//      explicitly with args concatenated into cmd.exe's command-line grammar,
//      with values that contain whitespace or cmd.exe metacharacters quoted.
//
// The helper returns the same shape as execFileSync: stdout string on success,
// throws with stdout / stderr / status / signal on non-zero exit or timeout.
// Caller can catch and inspect as with execFileSync.

function quoteForCmd(arg) {
  const s = typeof arg === 'string' ? arg : String(arg);
  if (s.length === 0) return '""';
  if (!/[\s"&<>|^%()]/.test(s)) return s;
  // cmd.exe convention: wrap in double quotes, escape embedded double quotes by
  // doubling. This covers the common cases — ADO project names with spaces,
  // URLs, paths. It does NOT attempt to defend against variable-expansion
  // injection via `%VAR%` sequences; callers must treat their own args as
  // trusted input (we only use this for CLI flag values we construct ourselves).
  return '"' + s.replace(/"/g, '""') + '"';
}

// cmd.exe's not-found signal: when the command-name after /c doesn't resolve,
// cmd.exe returns exit=1 with stderr starting "'<cmd>' is not recognized as an
// internal or external command". This is indistinguishable from real exit=1
// errors by exit code alone — we match on the stderr string to fall through
// candidates as if ENOENT had been thrown at the Node level.
const CMD_NOT_FOUND_RE = /is not recognized as an internal or external command/;

function runWinBin(candidates, args, opts = {}) {
  const { execFileSync } = require('child_process');
  const isWindows = process.platform === 'win32';
  const effectiveCandidates = isWindows ? candidates : [candidates[candidates.length - 1]];
  let lastErr;

  for (const bin of effectiveCandidates) {
    const isShellExt = isWindows && /\.(cmd|bat)$/i.test(bin);

    if (!isShellExt) {
      try {
        return execFileSync(bin, args, opts);
      } catch (e) {
        lastErr = e;
        if (e.code === 'ENOENT') continue; // try next candidate
        throw e; // real error: invocation failure, non-zero exit, timeout
      }
      continue;
    }

    // .cmd/.bat path: invoke via cmd.exe /d /s /c <bin> <quoted-args...>.
    //   /d — skip AutoRun commands from registry
    //   /s — modify how /c handles quoting (strip outermost quotes if the full
    //        line is quoted; combined with our own quoting, behaves as expected)
    //   /c — execute the command and exit
    const cmdArgs = ['/d', '/s', '/c', bin, ...args.map(quoteForCmd)];
    try {
      return execFileSync('cmd.exe', cmdArgs, opts);
    } catch (e) {
      lastErr = e;
      if (e.code === 'ENOENT') continue; // cmd.exe not on PATH (should never happen)
      // Inspect stderr for cmd.exe's "not recognized" signal — fall through as if
      // the binary had been absent.
      const stderr = e.stderr ? e.stderr.toString('utf8') : '';
      if (CMD_NOT_FOUND_RE.test(stderr)) continue;
      throw e;
    }
  }

  throw lastErr;
}

// ─── EXPORTS ────────────────────────────────────────────────────────────────

module.exports = {
  findProjectRoot, loadConfig, connect, c, ollamaDefaults, projectToDbName,
  ollamaEmbed, tryEmbed, runWinBin, quoteForCmd,
};
