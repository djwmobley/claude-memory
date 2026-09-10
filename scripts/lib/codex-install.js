'use strict';

/**
 * codex-install.js — OpenAI Codex CLI host adapter for install.js.
 *
 * Kept as a SEPARATE module from install.js so the Claude Code install path
 * in install.js is provably untouched by this feature (see
 * scripts/test-install-host.js's byte-identical-Claude-fixture case) —
 * install.js only branches into this module when `--host codex` resolves.
 *
 * Hardened 2026-09-09 against behaviors VERIFIED on a real codex-cli 0.153.4
 * binary this session (previously this module was verified against docs
 * only — see the removed "no codex binary is installed" note, superseded
 * below):
 *   - `codex mcp get <name> --json` exits 0 and prints a JSON object for a
 *     registered server (fields seen: transport type stdio/streamable_http,
 *     command/args/env, startup_timeout_sec, tool_timeout_sec, auth_status —
 *     a `name` key may be ABSENT, since the name is implicit in the CLI
 *     invocation). For an unknown name it exits 1 and prints exactly
 *     `Error: No MCP server named '<name>' found.` to stderr.
 *   - `codex mcp add <name> ...` on an already-registered name exits 0,
 *     prints `Added global MCP server '<name>'.`, silently OVERWRITES the
 *     entry, and rewrites the ENTIRE config.toml (key reorder, array
 *     reformat, ints→floats on unrelated entries) — never a targeted patch.
 *     This module backs up config.toml before every `mcp add` it runs.
 *   - MCP registration: `codex mcp add <name> [--env KEY=VALUE ...] --
 *     <command> [args...]`. Config: ${CODEX_HOME:-~/.codex}/config.toml
 *     under [mcp_servers.<name>] with command / args / [mcp_servers.<name>.env].
 *     https://learn.chatgpt.com/docs/extend/mcp
 *   - Hooks: user-scope ${CODEX_HOME:-~/.codex}/hooks.json, shape
 *     {"hooks":{"SessionStart":[{"matcher":"startup|resume","hooks":[{"type":"command","command":"...","timeout":<seconds>}]}],
 *               "SessionEnd":[{"hooks":[{"type":"command","command":"...","timeout":<seconds>}]}]}}.
 *     Project-scope .codex/hooks.json is known-buggy upstream — user scope
 *     only, no `codex hooks add` CLI exists. Codex clamps a SessionEnd
 *     hook's timeout to 3s regardless of the configured value — see
 *     docs/hosts/codex.md for why loader-stop's work fits that budget.
 *     https://learn.chatgpt.com/docs/hooks
 *   - AGENTS.md: read from git root down to cwd, project_doc_max_bytes 32 KiB
 *     default. https://learn.chatgpt.com/docs/agent-configuration/agents-md
 */

const fs   = require('node:fs');
const path = require('node:path');
const os   = require('node:os');
const { spawnSync: nodeSpawnSync } = require('node:child_process');

const MCP_SERVER_NAME = 'handoff';

// shell:true is required on Windows to execute a .cmd/.bat wrapper (the
// common shape for an npm-installed global CLI like a real `codex` install —
// Windows cannot directly CreateProcess a .bat/.cmd file; this is also the
// SAME reason scripts/lib/reality-checks.js's probePrState() takes shell:true
// for `gh.cmd`, sanctioned in test-os-portability.js's P2 check). On POSIX
// this simply routes through /bin/sh, harmless for the fixed, code-constructed
// argv this file ever builds (mcp/add/get/--version — never user-supplied
// shell text). `command` is quoted here whenever it contains whitespace:
// shell:true builds the shell command line by joining `command` and `args`
// with spaces and does NOT quote `command` itself even if it contains one
// (verified empirically — an unquoted space-containing command under
// shell:true is parsed by cmd.exe as two separate tokens and fails with
// "... is not recognized as an internal or external command"); `args`
// elements never need this treatment here since spawnSync's array form
// quotes each of THEM correctly on its own.
//
// Every spawnSync call in this file goes through this one wrapper — the
// single call site test-os-portability.js's P2 check counts against its
// sanctioned-exception cap for this file.
//
// VERIFIED (2026-09-09, real codex-cli 0.153.4 + a space-containing
// checkout path): the original comment above claiming "`args` elements
// never need [quoting] treatment ... since spawnSync's array form quotes
// each of THEM correctly on its own" is FALSE under shell:true. With
// shell:true on Windows, Node flattens `command` + `args` into a single
// command-line string joined by plain spaces with NO per-argument quoting;
// an args element containing an embedded space (e.g. this checkout's own
// engine path, if it lives under a directory with a space in its name) is
// silently split into two separate argv entries by the time the child
// process parses it — verified via a real spawned `codex mcp add` and
// inspecting the child's own `process.argv`. Every args element that needs
// it is now quoted here, alongside the pre-existing `command` quoting.
/**
 * Quote a single argv token for inclusion in a shell:true command line.
 * Naively wrapping in double quotes and escaping only embedded quotes (the
 * first cut at this fix) is an INCOMPLETE escape on Windows: a run of
 * backslashes immediately preceding a quote (or the end of the string, since
 * the whole token is itself wrapped in a trailing quote) must be doubled, or
 * the CRT command-line parser used by cmd.exe/node.exe collapses them and
 * can shift or drop the closing quote — this is the same algorithm Node's
 * own child_process uses internally to quote argv entries (see
 * child_process.js's `_convertToValidWin32ArgIfNecessary`), needed here
 * because shell:true bypasses that internal path entirely.
 */
function quoteShellArgWin32(s) {
  if (!/[\s"]/.test(s)) return s;
  let result = '"';
  let backslashes = 0;
  for (const ch of s) {
    if (ch === '\\') {
      backslashes++;
      continue;
    }
    if (ch === '"') {
      result += '\\'.repeat(backslashes * 2 + 1) + '"';
      backslashes = 0;
      continue;
    }
    result += '\\'.repeat(backslashes) + ch;
    backslashes = 0;
  }
  result += '\\'.repeat(backslashes * 2) + '"';
  return result;
}

/** POSIX /bin/sh quoting: single-quote wrapping, embedded quotes escaped via '\''. */
function quoteShellArgPosix(s) {
  if (!/[\s"'$`\\]/.test(s)) return s;
  return `'${s.replace(/'/g, "'\\''")}'`;
}

function quoteShellArg(token) {
  const s = String(token);
  return process.platform === 'win32' ? quoteShellArgWin32(s) : quoteShellArgPosix(s);
}

function spawnSync(command, args, opts) {
  const cmd = (/\s/.test(command) && !/^".*"$/.test(command)) ? `"${command}"` : command;
  const quotedArgs = Array.isArray(args) ? args.map(quoteShellArg) : args;
  return nodeSpawnSync(cmd, quotedArgs, {
    windowsHide: true,
    ...opts,
    shell: true,
  });
}

// ─── whole-token "handoff" match (S2) ────────────────────────────────────────
// Hyphen deliberately does NOT count as a token boundary, so `handoff-dev`
// must NOT match — only the exact standalone token `handoff` does. Name
// equality throughout this file (registration-entry `name` fields, this
// token match) is EXACT and CASE-SENSITIVE with no trimming — MCP_SERVER_NAME
// is always the literal string 'handoff', never normalized.
const HANDOFF_TOKEN_RE = /(^|[^A-Za-z0-9_-])handoff($|[^A-Za-z0-9_-])/;

function isHandoffToken(text) {
  return typeof text === 'string' && HANDOFF_TOKEN_RE.test(text);
}

// ─── codex binary discovery (S2) ─────────────────────────────────────────────

/**
 * Discover the `codex` executable on PATH (path.delimiter-split; PATHEXT on
 * Windows), confirmed by a synchronous `codex --version` probe. A nonzero
 * exit, a spawn error, or a thrown exception at any point means "not found"
 * — never throws itself.
 * @returns {{ found: boolean, command: string|null, version: string|null }}
 */
function discoverCodex(env) {
  env = env || process.env;
  const pathVar = env.PATH || env.Path || '';
  const dirs = String(pathVar).split(path.delimiter).filter(Boolean);
  const isWin = process.platform === 'win32';
  const exts = isWin
    ? String(env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
    : [''];

  for (const dir of dirs) {
    const candidates = isWin
      ? exts.map((ext) => path.join(dir, `codex${ext.startsWith('.') ? ext : `.${ext}`}`))
      : [path.join(dir, 'codex')];
    for (const candidate of candidates) {
      let exists = false;
      try { exists = fs.existsSync(candidate); } catch (_) { exists = false; }
      if (!exists) continue;
      const probe = probeVersion(candidate);
      if (probe.ok) return { found: true, command: candidate, version: probe.version };
    }
  }
  return { found: false, command: null, version: null };
}

function probeVersion(command) {
  try {
    const result = spawnSync(command, ['--version'], { encoding: 'utf8', windowsHide: true });
    if (result.error) return { ok: false };
    if (typeof result.status !== 'number' || result.status !== 0) return { ok: false };
    return { ok: true, version: (result.stdout || '').trim() };
  } catch (_) {
    return { ok: false };
  }
}

// ─── MCP registration (S2) ───────────────────────────────────────────────────

/** Build the exact `codex mcp add ...` argv (excluding the `codex` token itself). */
function buildMcpAddArgv(enginePath) {
  return ['mcp', 'add', MCP_SERVER_NAME, '--env', 'HANDOFF_PROMOTION_FILE=AGENTS.md', '--', 'node', enginePath];
}

/** The manual-paste TOML stanza printed when `codex` cannot be found. */
function buildMcpTomlStanza(enginePath) {
  const escaped = String(enginePath).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return [
    `[mcp_servers.${MCP_SERVER_NAME}]`,
    `command = "node"`,
    `args = ["${escaped}"]`,
    '',
    `[mcp_servers.${MCP_SERVER_NAME}.env]`,
    `HANDOFF_PROMOTION_FILE = "AGENTS.md"`,
  ].join('\n');
}

// ─── output normalization + JSON extraction (S2 hardening) ──────────────────

function stripAnsi(text) {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
}

function normalizeOutput(text) {
  const noBOM = String(text || '').replace(/^﻿/, '');
  return stripAnsi(noBOM).replace(/\r\n/g, '\n');
}

/**
 * Find the index of the bracket matching the opener at `start`, respecting
 * (double-quoted, backslash-escaped) JSON string literals so braces/brackets
 * inside string values never throw off the depth count. Returns -1 if the
 * text ends before the match closes.
 */
function findMatchingBracket(text, start) {
  const open = text[start];
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escape) escape = false;
      else if (ch === '\\') escape = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === open) depth++;
    else if (ch === close) { depth--; if (depth === 0) return i; }
  }
  return -1;
}

/**
 * Extract the LAST top-level JSON value (object or array) found anywhere in
 * `text` — banner/warning lines (e.g. "warning: clamping ...") may precede
 * it. Total classification over the input: every string maps to either a
 * parsed object/array or `null` (no such value present); never throws.
 */
function extractLastJsonValue(text) {
  let last = null;
  let i = 0;
  const n = text.length;
  while (i < n) {
    const ch = text[i];
    if (ch === '{' || ch === '[') {
      const end = findMatchingBracket(text, i);
      if (end !== -1) {
        const candidate = text.slice(i, end + 1);
        try {
          const val = JSON.parse(candidate);
          if (val !== null && typeof val === 'object') last = val;
          i = end + 1;
          continue;
        } catch (_) {
          // Not valid JSON starting here — fall through and advance by one.
        }
      }
    }
    i++;
  }
  return last;
}

// The real Codex error text for an unregistered name, verified this session:
//   Error: No MCP server named 'handoff' found.
const NOT_FOUND_RE = /No MCP server named '.*' found/;

// A broader, deliberately generic "not found" guard used ONLY to keep the
// ambiguous plain-fallback REGISTERED_UNVERIFIED branch from being fooled by
// wording that isn't the exact NOT_FOUND_RE shape (e.g. a hypothetical
// "not found, try codex mcp add handoff" help string, which contains the
// whole token "handoff" but is not a registration). Per this repo's
// total-classification canon, the unlisted/ambiguous case must fail toward
// friction (UNKNOWN, blocking `add`) rather than toward a silent false
// REGISTERED.
const GENERIC_NOT_FOUND_RE = /not found/i;

function notFound(text) {
  return NOT_FOUND_RE.test(text);
}

// A `--json` flag rejected by an older/newer codex-cli surfaces as a clap-style
// argument-parsing error. "near '--json'" is enforced by ALSO requiring the
// literal substring `--json` appear in the combined output — an unrelated
// nonzero exit that happens to contain one of these words but never mentions
// `--json` is NOT treated as a flag-support fallback trigger; it falls through
// to UNKNOWN instead (total classification: no third guess).
const FALLBACK_TRIGGER_RE = /unexpected argument|unrecognized|unknown option|unexpected value/i;

function looksLikeJsonFlagUnsupported(combinedText) {
  return FALLBACK_TRIGGER_RE.test(combinedText) && /--json/.test(combinedText);
}

// ─── registration-entry resolution + comparison (S2 hardening) ──────────────

/**
 * Resolve the server entry object out of an arbitrary parsed JSON value.
 * Total classification — every shape maps to an entry object or `null`:
 *   1. object carrying its own `command`/`url`/`transport` key  -> itself
 *   2. object carrying an own key === name                      -> that value
 *   3. object carrying `servers` or `mcp_servers` (itself an
 *      object) with an own key === name                         -> that value
 *   4. array -> first element whose own `name` === name
 *   5. anything else                                             -> null
 */
function resolveEntry(jsonValue, name) {
  if (jsonValue && typeof jsonValue === 'object' && !Array.isArray(jsonValue)) {
    if (Object.prototype.hasOwnProperty.call(jsonValue, 'command') ||
        Object.prototype.hasOwnProperty.call(jsonValue, 'url') ||
        Object.prototype.hasOwnProperty.call(jsonValue, 'transport')) {
      return jsonValue;
    }
    if (Object.prototype.hasOwnProperty.call(jsonValue, name)) {
      return jsonValue[name];
    }
    for (const wrapperKey of ['servers', 'mcp_servers']) {
      const wrapper = jsonValue[wrapperKey];
      if (wrapper && typeof wrapper === 'object' && !Array.isArray(wrapper) &&
          Object.prototype.hasOwnProperty.call(wrapper, name)) {
        return wrapper[name];
      }
    }
    return null;
  }
  if (Array.isArray(jsonValue)) {
    const found = jsonValue.find((el) => el && typeof el === 'object' && el.name === name);
    return found || null;
  }
  return null;
}

function commandLooksLikeNode(cmd) {
  if (typeof cmd !== 'string' || cmd.length === 0) return false;
  if (cmd === 'node') return true;
  if (!path.isAbsolute(cmd)) return false;
  return /node(\.exe)?$/i.test(path.basename(cmd));
}

/** Forward-slash, win32-case-insensitive normalization for path comparison. */
function normalizeForCompare(p) {
  const s = String(p).replace(/\\/g, '/');
  return process.platform === 'win32' ? s.toLowerCase() : s;
}

/** Does `entry` (command + args) already point at this checkout's engine? */
function entryMatchesEngine(entry, enginePath) {
  if (!entry || typeof entry !== 'object') return false;
  if (!commandLooksLikeNode(entry.command)) return false;
  const args = Array.isArray(entry.args) ? entry.args : [];
  const want = normalizeForCompare(enginePath);
  return args.some((a) => typeof a === 'string' && normalizeForCompare(a) === want);
}

// ─── `codex mcp get <name> [--json]` total classification (S2 hardening) ────

/**
 * Classify the current registration state of MCP_SERVER_NAME against a real
 * `codex` binary. TOTAL CLASSIFICATION — every combination of {spawn error,
 * exit code, stdout, stderr} maps to exactly one of these states; there is no
 * "else, assume fine" branch:
 *
 *   NOT_INSTALLED        — spawn itself failed (ENOENT etc). Caller aborts.
 *   NOT_REGISTERED       — exit != 0 and codex reported the name unknown.
 *   REGISTERED           — exit 0, JSON entry resolved, command/args already
 *                           point at this checkout's engine path.
 *   NEEDS_REPAIR         — exit 0, JSON entry resolved, command/args point at
 *                           a DIFFERENT path — caller may re-run `mcp add`.
 *   REGISTERED_UNVERIFIED— `--json` unsupported, plain-text fallback found the
 *                           name as a whole token with no not-found wording —
 *                           treated as registered, but the caller must say the
 *                           command/args path could not be verified.
 *   UNKNOWN              — anything else: unparseable JSON on exit 0, JSON
 *                           with no recognizable entry, an entry whose own
 *                           `name` field disagrees with MCP_SERVER_NAME, an
 *                           unrecognized nonzero-exit shape, or an ambiguous
 *                           plain-fallback result. Caller aborts; `mcp add`
 *                           is NEVER run from this state.
 *
 * @param {string} codexCommand
 * @param {string} enginePath
 * @param {{ spawnSyncImpl?: Function }} [opts] test seam only
 */
function checkHandoffRegistered(codexCommand, enginePath, opts) {
  const spawnFn = (opts && opts.spawnSyncImpl) || spawnSync;
  const name = MCP_SERVER_NAME;
  const env = { ...process.env, NO_COLOR: '1' };

  const primary = spawnFn(codexCommand, ['mcp', 'get', name, '--json'], { encoding: 'utf8', windowsHide: true, env });
  if (primary.error) {
    return { state: 'NOT_INSTALLED', detail: `spawn error running \`codex mcp get ${name} --json\`: ${primary.error.message}` };
  }

  const exit   = typeof primary.status === 'number' ? primary.status : null;
  const stdout = normalizeOutput(primary.stdout || '');
  const stderr = normalizeOutput(primary.stderr || '');
  const combined = `${stderr}\n${stdout}`;

  if (exit !== 0) {
    if (notFound(combined)) {
      return { state: 'NOT_REGISTERED', detail: 'codex reports no MCP server registered under this name.', exit, stdout, stderr };
    }
    if (looksLikeJsonFlagUnsupported(combined)) {
      return classifyPlainFallback(spawnFn, codexCommand, name, env);
    }
    return { state: 'UNKNOWN', detail: `\`codex mcp get ${name} --json\` exited ${exit} with an unrecognized error.`, exit, stdout, stderr };
  }

  const jsonValue = extractLastJsonValue(stdout);
  if (jsonValue === null) {
    return { state: 'UNKNOWN', detail: `\`codex mcp get ${name} --json\` exited 0 but printed no parseable JSON.`, exit, stdout, stderr };
  }

  const entry = resolveEntry(jsonValue, name);
  if (entry === null) {
    return { state: 'UNKNOWN', detail: 'codex printed JSON with no recognizable server entry for this name.', exit, stdout, stderr, jsonValue };
  }
  if (entry.name !== undefined && entry.name !== name) {
    return { state: 'UNKNOWN', detail: `resolved entry's own name ('${entry.name}') disagrees with expected '${name}'.`, exit, stdout, stderr, entry };
  }
  if (entryMatchesEngine(entry, enginePath)) {
    return { state: 'REGISTERED', detail: 'already registered and pointing at this checkout.', exit, stdout, stderr, entry };
  }
  return {
    state: 'NEEDS_REPAIR',
    detail: 'registered but command/args point at a different path than this checkout.',
    exit, stdout, stderr, entry,
    oldCommand: entry.command, oldArgs: entry.args, newEnginePath: enginePath,
  };
}

/** The `--json`-unsupported fallback path: re-run plain `codex mcp get <name>`. */
function classifyPlainFallback(spawnFn, codexCommand, name, env) {
  const result = spawnFn(codexCommand, ['mcp', 'get', name], { encoding: 'utf8', windowsHide: true, env });
  if (result.error) {
    return { state: 'NOT_INSTALLED', detail: `spawn error on plain-text fallback \`codex mcp get ${name}\`: ${result.error.message}` };
  }
  const exit   = typeof result.status === 'number' ? result.status : null;
  const stdout = normalizeOutput(result.stdout || '');
  const stderr = normalizeOutput(result.stderr || '');
  const combined = `${stderr}\n${stdout}`;

  if (exit !== 0 && notFound(combined)) {
    return { state: 'NOT_REGISTERED', detail: 'plain-text fallback: codex reports no MCP server registered under this name.', exit, stdout, stderr, viaFallback: true };
  }
  if (exit === 0 && isHandoffToken(stdout) && !notFound(combined) && !GENERIC_NOT_FOUND_RE.test(combined)) {
    return {
      state: 'REGISTERED_UNVERIFIED',
      detail: `plain-text fallback: found "${name}" as a whole token in \`codex mcp get\` output, but --json is unsupported so the command/args path could not be verified.`,
      exit, stdout, stderr, viaFallback: true,
    };
  }
  return { state: 'UNKNOWN', detail: 'plain-text fallback: could not classify `codex mcp get` output.', exit, stdout, stderr, viaFallback: true };
}

/** Runs `codex mcp add ...` for real via spawnSync with an argv array (never a shell string). */
function registerHandoffMcp(codexCommand, enginePath) {
  const argv = buildMcpAddArgv(enginePath);
  const result = spawnSync(codexCommand, argv, { encoding: 'utf8', windowsHide: true });
  const ok = !result.error && typeof result.status === 'number' && result.status === 0;
  return {
    ok, argv,
    status: result.error ? null : result.status,
    stdout: result.stdout || '',
    stderr: result.error ? String(result.error.message) : (result.stderr || ''),
  };
}

// ─── config.toml backup (S2 hardening — `mcp add` rewrites the whole file) ──

let backupSeq = 0;

/**
 * `config.toml.bak-<YYYYMMDDTHHMMSS>-<epochMs>-<pid>-<seq>`. The trailing
 * in-process `<seq>` counter is extra entropy beyond the spec'd shape, added
 * because two backups can legitimately be requested within the same
 * wall-clock second (or even the same millisecond, under a fast test) and
 * the filename must still be unique — see test-install-host.js's
 * backup-filename-uniqueness case.
 */
function makeConfigBackupPath(configPath) {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}` +
    `T${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}`;
  backupSeq += 1;
  return `${configPath}.bak-${stamp}-${Date.now()}-${process.pid}-${backupSeq}`;
}

/**
 * Back up ${codexHomeDir}/config.toml before an `mcp add` call, since a real
 * `codex mcp add` rewrites the ENTIRE file (key reorder, array reformat,
 * ints→floats on unrelated entries), never a targeted patch. If no
 * config.toml exists yet, there is nothing to protect — skip with a reason
 * rather than fabricating an empty backup.
 */
function backupConfigTomlIfPresent(codexHomeDir) {
  const configPath = path.join(codexHomeDir, 'config.toml');
  let exists = false;
  try { exists = fs.existsSync(configPath); } catch (_) { exists = false; }
  if (!exists) {
    return { skipped: true, configPath, backupPath: null, reason: `no existing config.toml at ${configPath} — skipping backup (nothing to protect).` };
  }
  const backupPath = makeConfigBackupPath(configPath);
  fs.copyFileSync(configPath, backupPath);
  return { skipped: false, configPath, backupPath, reason: null };
}

// ─── S2 orchestration: classify -> (maybe) backup+add -> re-verify ─────────

/**
 * Full registration workflow used by install.js's mainCodex(). Never throws.
 *
 * Only NOT_REGISTERED and NEEDS_REPAIR lead to a real `codex mcp add` call.
 * NOT_INSTALLED and UNKNOWN abort without ever attempting `add`. REGISTERED
 * and REGISTERED_UNVERIFIED are treated as already-done (skip).
 *
 * There is an inherent TOCTOU gap between the classify step and the `add`
 * step below (another process could register/deregister the name in
 * between) — accepted, since `codex mcp add` itself is the only registration
 * primitive available and re-running this whole workflow is always safe
 * (idempotent by re-classification).
 *
 * @returns {{ action: 'skip'|'would-add'|'added'|'add-failed'|'abort', state: string, ... }}
 */
function ensureHandoffRegistered({ codexCommand, enginePath, codexHomeDir, dryRun }) {
  const before = checkHandoffRegistered(codexCommand, enginePath);

  if (before.state === 'NOT_INSTALLED' || before.state === 'UNKNOWN') {
    return { ...before, action: 'abort' };
  }
  if (before.state === 'REGISTERED' || before.state === 'REGISTERED_UNVERIFIED') {
    return { ...before, action: 'skip' };
  }

  // before.state is NOT_REGISTERED or NEEDS_REPAIR here.
  if (dryRun) {
    return { ...before, action: 'would-add' };
  }

  const backup = backupConfigTomlIfPresent(codexHomeDir);
  const addResult = registerHandoffMcp(codexCommand, enginePath);
  const after = checkHandoffRegistered(codexCommand, enginePath);

  if (after.state !== 'REGISTERED' && after.state !== 'REGISTERED_UNVERIFIED') {
    return { ...after, action: 'add-failed', backup, addResult, before };
  }
  return { ...after, action: 'added', backup, addResult, before };
}

// ─── hooks.json (S3) ─────────────────────────────────────────────────────────

/**
 * Resolve ${CODEX_HOME:-~/.codex}. Total classification:
 *   unset                          -> default ~/.codex
 *   set to '' (explicit empty)     -> HARD refuse
 *   set, not absolute (relative)   -> HARD refuse
 *   set, absolute, unwritable      -> HARD refuse
 *   set, absolute, writable        -> accepted
 */
function resolveCodexHome(env) {
  env = env || process.env;
  const raw = env.CODEX_HOME;

  if (raw === undefined) {
    return { ok: true, dir: path.join(os.homedir(), '.codex') };
  }
  if (raw === '') {
    return { ok: false, reason: 'CODEX_HOME is set to an empty string.' };
  }
  if (!path.isAbsolute(raw)) {
    return { ok: false, reason: `CODEX_HOME ('${raw}') must be an absolute path — relative values are refused.` };
  }
  try {
    fs.mkdirSync(raw, { recursive: true });
    fs.accessSync(raw, fs.constants.W_OK);
  } catch (err) {
    return { ok: false, reason: `CODEX_HOME ('${raw}') is not writable: ${err.message}` };
  }
  return { ok: true, dir: raw };
}

/**
 * Install (or dry-run preview) the Codex hooks.json entries for loader-hook
 * (SessionStart, matcher "startup|resume") and loader-stop (SessionEnd, no
 * matcher) — reusing install.js's schema-aware mergeHooks()/serializeSettings()
 * /unifiedDiff()/makeBackupPath() helpers (lazily required to avoid a
 * circular require at module-eval time: install.js requires this module at
 * its own top level, so this module must not require install.js there too).
 *
 * @returns {{ hooksPath: string, report: object, wrote: boolean, backupPath: string|null, diff: string }}
 */
function installCodexHooks({ hooksPath, hookLoaderCmd, hookStopCmd, dryRun }) {
  const installLib = require('../install.js');

  const { settings, existed, hadBOM, eol, indent, raw, jsonTextLF } = installLib.readSettingsFileOrRefuse(hooksPath);

  const clone = raw !== null ? JSON.parse(hadBOM ? raw.slice(1) : raw) : {};
  const report = installLib.mergeHooks(clone, {
    hookLoaderCmd,
    hookStopCmd,
    targetHost: 'codex',
    matcherFor: { 'loader-hook': 'startup|resume' },
  });
  const beforeText = raw !== null ? raw : '';
  const afterText  = installLib.serializeSettings(clone, { indent, eol, hadBOM, originalJsonText: jsonTextLF });
  const diff       = installLib.unifiedDiff(beforeText, afterText, path.basename(hooksPath));

  const noop = existed && afterText === raw;

  if (dryRun || noop) {
    return { hooksPath, report, wrote: false, backupPath: null, diff };
  }

  fs.mkdirSync(path.dirname(hooksPath), { recursive: true });

  let backupPath = null;
  if (existed) {
    backupPath = installLib.makeBackupPath(hooksPath);
    fs.copyFileSync(hooksPath, backupPath);
  }
  const tmpPath = `${hooksPath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmpPath, afterText, 'utf8');
  fs.renameSync(tmpPath, hooksPath);

  return { hooksPath, report, wrote: true, backupPath, diff };
}

module.exports = {
  MCP_SERVER_NAME,
  isHandoffToken,
  discoverCodex,
  buildMcpAddArgv,
  buildMcpTomlStanza,
  checkHandoffRegistered,
  registerHandoffMcp,
  ensureHandoffRegistered,
  backupConfigTomlIfPresent,
  resolveCodexHome,
  installCodexHooks,
  // Exported for direct unit testing of the classification internals.
  normalizeOutput,
  extractLastJsonValue,
  resolveEntry,
  entryMatchesEngine,
  notFound,
  looksLikeJsonFlagUnsupported,
};
