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

const fs     = require('node:fs');
const path   = require('node:path');
const os     = require('node:os');
const crypto = require('node:crypto');
const { spawnSync: nodeSpawnSync } = require('node:child_process');

const MCP_SERVER_NAME = 'handoff';

// The dispatcher skill's name — a foreign `handoff` skill at this exact
// target path would keep firing on every bare `handoff` utterance, so its
// user-authored case ((d), see installSkills below) is a BLOCKING error
// rather than a skip, unless --force-skills is given.
const DISPATCHER_SKILL_NAME = 'handoff';

// HARDENED AGAIN (2026-09-09, independent-reviewer finding on PR #276):
// shell:true was previously used UNCONDITIONALLY for every spawn in this
// file, with args quoted only when they contained whitespace/a quote. Two
// real, verified holes in that approach:
//   1. An argument containing `&`, `|`, `^`, `(`, `)`, `<`, or `>` but no
//      whitespace (e.g. a checkout path like `C:\dev\a&b\...\handoff-mcp.mjs`)
//      was passed UNQUOTED and cmd.exe parsed the remainder as a second
//      shell command — arbitrary command injection via a maliciously- or
//      even just unluckily-named directory.
//   2. Even when quoted, cmd.exe expands `%VAR%` and (with delayed expansion
//      enabled) `!VAR!` tokens INSIDE double quotes — quoting cannot
//      neutralize those, only refusing to run can.
//
// The fix has two parts:
//   A. AVOID THE SHELL WHENEVER POSSIBLE. The `codex` executable is always a
//      single already-resolved path (from discoverCodex's PATH/PATHEXT walk,
//      or the HANDOFF_CODEX_BIN override) — never itself untrusted shell
//      text. A real executable (win32: anything that isn't `.cmd`/`.bat`;
//      POSIX: always, since exec() there needs no shell to parse special
//      characters out of an argv array) is spawned with shell:false and a
//      plain argv array — Windows CreateProcess and POSIX execve both take
//      arguments as discrete strings with NO shell metacharacter parsing at
//      all, so `&`, `|`, spaces, quotes, `%`, none of it needs escaping.
//   B. Only a win32 `.cmd`/`.bat` (the common shape for an npm-installed
//      global CLI, and the sole reason shell:true is needed anywhere in this
//      file — Windows cannot directly CreateProcess a batch file) falls back
//      to shell:true, and in that path EVERY argument (never conditionally)
//      is quoted per the documented cmd.exe/CRT rules, AND classified first:
//      an argument containing `%`, `!`, or a newline/CR is refused outright
//      (visible error naming the offending argument), since cmd.exe expands
//      those regardless of quoting — there is no safe quoting for them.
//
// Every spawn in this file goes through spawnCodex() below — the single
// remaining shell:true call site (inside the .cmd/.bat fallback branch)
// counts against test-os-portability.js's P2 sanctioned-exception cap for
// this file, same as before.

/** win32 only: does this resolved path need the cmd.exe shell fallback? */
function needsCmdShell(command) {
  if (process.platform === 'win32') return /\.(cmd|bat)$/i.test(String(command));
  return false;
}

// cmd.exe expands these regardless of quoting (%VAR%, !VAR! under delayed
// expansion, and a literal CR/LF would terminate/split the command line) —
// there is no safe quoting strategy for them, so an argument containing any
// of these is refused rather than passed through unsafely.
const CMD_UNQUOTABLE_RE = /[%!\r\n]/;

/**
 * Unconditionally quote one token for a win32 cmd.exe command line — wraps
 * in double quotes NO MATTER WHAT (never conditional on whitespace/quote
 * presence, so `&`, `|`, `^`, `(`, `)`, `<`, `>` are always safely inside
 * quotes) and doubles a run of backslashes immediately preceding a quote or
 * the token's end (the same algorithm Node's own child_process uses
 * internally — see child_process.js's `_convertToValidWin32ArgIfNecessary`
 * — needed here because shell:true bypasses that internal path entirely).
 * Returns { ok:false, reason } instead of a string when the token contains
 * an unquotable character (see CMD_UNQUOTABLE_RE).
 */
function classifyAndQuoteWin32(token) {
  const s = String(token);
  if (CMD_UNQUOTABLE_RE.test(s)) {
    return {
      ok: false,
      reason: `argument contains %, !, or a newline — cmd.exe expands these even inside quotes, so it cannot be passed safely: ${JSON.stringify(s)}. ` +
        `Workaround: rename the offending path, or set HANDOFF_CODEX_BIN to an absolute path to the codex executable (bypasses this .cmd/.bat shell fallback entirely).`,
    };
  }
  let result = '"';
  let backslashes = 0;
  for (const ch of s) {
    if (ch === '\\') { backslashes++; continue; }
    if (ch === '"') { result += '\\'.repeat(backslashes * 2 + 1) + '"'; backslashes = 0; continue; }
    result += '\\'.repeat(backslashes) + ch;
    backslashes = 0;
  }
  result += '\\'.repeat(backslashes * 2) + '"';
  return { ok: true, quoted: result };
}

/**
 * POSIX /bin/sh single-quote wrapping, UNCONDITIONAL (never conditional on
 * content) — embedded single quotes escaped via the standard '\'' idiom.
 * In practice this path should be unreachable (needsCmdShell() is always
 * false on POSIX — shell:false with a plain argv array is always used
 * instead, see spawnCodex), kept only as a defensive fallback.
 */
function quoteShellArgPosix(token) {
  const s = String(token);
  return `'${s.replace(/'/g, "'\\''")}'`;
}

/**
 * Spawn the resolved `codex` command. Avoids the shell entirely (shell:false,
 * plain argv array — no quoting needed or possible to get wrong) unless
 * `command` is a win32 `.cmd`/`.bat`, in which case every token (command AND
 * every arg) is unconditionally quoted and classified per the rules above;
 * a refusal from that classification is surfaced as `result.error` (the
 * same shape a real spawn error takes — every caller in this file already
 * checks `result.error` first).
 */
function spawnSync(command, args, opts) {
  const argv = Array.isArray(args) ? args : [];

  if (!needsCmdShell(command)) {
    return nodeSpawnSync(command, argv, {
      windowsHide: true,
      ...opts,
      shell: false,
    });
  }

  const quotedCommand = classifyAndQuoteWin32(command);
  if (!quotedCommand.ok) return { error: new Error(quotedCommand.reason) };

  const quotedArgs = [];
  for (const a of argv) {
    const q = classifyAndQuoteWin32(a);
    if (!q.ok) return { error: new Error(q.reason) };
    quotedArgs.push(q.quoted);
  }

  return nodeSpawnSync(quotedCommand.quoted, quotedArgs, {
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
 *
 * HANDOFF_CODEX_BIN (an absolute path to the codex executable), when set to
 * a non-empty (post-trim) value, BYPASSES the PATH/PATHEXT walk entirely —
 * it is probed directly, and the result (found or not) is returned as-is
 * with no fallback to a PATH search. This exists for two reasons: (1) an
 * escape hatch when `codex` isn't on PATH at all, and (2) a way to point at
 * a real `codex.exe`/binary directly when a `.cmd`/`.bat` shim on PATH would
 * otherwise force every spawn in this file through the cmd.exe shell
 * fallback (see spawnSync's header comment) — pointing HANDOFF_CODEX_BIN at
 * the underlying executable avoids that shell entirely.
 * @returns {{ found: boolean, command: string|null, version: string|null }}
 */
function discoverCodex(env) {
  env = env || process.env;

  const overrideRaw = typeof env.HANDOFF_CODEX_BIN === 'string' ? env.HANDOFF_CODEX_BIN.trim() : '';
  if (overrideRaw.length > 0) {
    const probe = probeVersion(overrideRaw);
    return probe.ok
      ? { found: true, command: overrideRaw, version: probe.version }
      : { found: false, command: null, version: null };
  }

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
  return [
    'mcp', 'add', MCP_SERVER_NAME,
    '--env', 'HANDOFF_PROMOTION_FILE=AGENTS.md',
    '--env', 'HANDOFF_HOST=codex',
    '--', 'node', enginePath,
  ];
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
    `HANDOFF_HOST = "codex"`,
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

// ─── Codex skills install (A) ────────────────────────────────────────────────
//
// Installs adapter-owned skills from templates/codex-skills/<name>/SKILL.md
// (the source of truth, rendered by scripts/gen-codex-skills — kept as
// static files so their content is reviewable in a diff like any other
// template) to the Codex skills discovery directory
// (HANDOFF_CODEX_SKILLS_DIR if set, else ~/.agents/skills).
//
// Every managed skill file carries a marker line right after the closing
// frontmatter `---`:
//   <!-- managed-by: claude-memory handoff-skills v1 sha256:<hash> -->
// where <hash> = sha256 of the LF-normalized, BOM-stripped, trailing-
// newline-trimmed file body EXCLUDING the marker line itself. This lets the
// installer distinguish "our file, unchanged" / "our file, needs upgrading"
// from "a human wrote something here" without ever comparing raw bytes
// (a byte compare would treat trivial re-wrapping as "changed" and a stale
// old marker as new content — hash-of-normalized-body avoids both).

const SKILL_MARKER_LINE_RE = /^<!--\s*managed-by:\s*claude-memory handoff-skills v1 sha256:([0-9a-f]{64})\s*-->\s*$/;

/** Strip BOM, normalize CRLF/CR to LF, and trim trailing newline(s). */
function normalizeForHash(text) {
  const noBOM = String(text).replace(/^﻿/, '');
  return noBOM.replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\n+$/, '');
}

/** Remove every line matching the marker pattern, then normalize. */
function stripMarkerLine(text) {
  const noBOM = String(text).replace(/^﻿/, '');
  const lf = noBOM.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const kept = lf.split('\n').filter((line) => !SKILL_MARKER_LINE_RE.test(line));
  return kept.join('\n').replace(/\n+$/, '');
}

/** sha256 hex digest of a skill file's body, marker line excluded. */
function computeSkillBodyHash(text) {
  return crypto.createHash('sha256').update(stripMarkerLine(text), 'utf8').digest('hex');
}

/** Extract the hash recorded in an existing file's marker line, or null if absent. */
function extractSkillMarkerHash(text) {
  const noBOM = String(text).replace(/^﻿/, '');
  const lf = noBOM.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  for (const line of lf.split('\n')) {
    const m = line.match(SKILL_MARKER_LINE_RE);
    if (m) return m[1];
  }
  return null;
}

/**
 * Build the final SKILL.md text for one skill: frontmatter, then the marker
 * line (hash computed over frontmatter+body with no marker present yet),
 * then the body. Exported so a generator script and tests share the exact
 * same construction the installer's comparison logic expects.
 */
function buildSkillFileText(name, description, body) {
  const frontmatter = `---\nname: ${name}\ndescription: ${description}\n---\n`;
  const withoutMarker = frontmatter + body;
  const hash = crypto.createHash('sha256').update(normalizeForHash(withoutMarker), 'utf8').digest('hex');
  const marker = `<!-- managed-by: claude-memory handoff-skills v1 sha256:${hash} -->\n`;
  return frontmatter + marker + body;
}

/** HANDOFF_CODEX_SKILLS_DIR resolution: unset/empty -> default; relative -> refused. */
function resolveCodexSkillsDir(env) {
  env = env || process.env;
  const raw = env.HANDOFF_CODEX_SKILLS_DIR;
  if (typeof raw !== 'string' || raw.trim() === '') {
    return { ok: true, dir: path.join(os.homedir(), '.agents', 'skills') };
  }
  if (!path.isAbsolute(raw)) {
    return { ok: false, reason: `HANDOFF_CODEX_SKILLS_DIR ('${raw}') must be an absolute path — relative values are refused.` };
  }
  return { ok: true, dir: raw };
}

function statNoThrow(p) {
  try { return fs.lstatSync(p); } catch (_) { return null; }
}

function makeTimestampedBackupPath(targetPath) {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}` +
    `T${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}`;
  return `${targetPath}.bak-${stamp}-${Date.now()}-${process.pid}`;
}

/**
 * Classify one skill's install target — TOTAL CLASSIFICATION over every
 * filesystem shape fs.stat/fs.lstat can report (never a path-string
 * compare, so this is correct on case-insensitive filesystems too):
 *
 *   write             — (a) neither <dir>/<name>/ nor its SKILL.md exists.
 *   unchanged         — (b) SKILL.md exists, carries our marker, hash equal.
 *   overwrite         — (c) SKILL.md exists, carries our marker, hash differs.
 *   skip              — (d) SKILL.md exists, no marker (user-authored).
 *   blocked           — (d) for the dispatcher name specifically: same as
 *                       skip, but callers must treat this as a hard error.
 *   force-overwrite   — (f) --force-skills flag turns skip/blocked into a
 *                       backup-then-overwrite.
 *   error             — (e) <dir>/<name> exists and is not a directory (or
 *                       is a symlink/junction), OR its SKILL.md exists and
 *                       is not a regular file (or is a symlink).
 */
function classifySkillTarget({ targetDir, name, desiredContent, force }) {
  const skillDir = path.join(targetDir, name);
  const skillFile = path.join(skillDir, 'SKILL.md');

  const dirStat = statNoThrow(skillDir);
  if (dirStat !== null) {
    if (dirStat.isSymbolicLink()) {
      return { action: 'error', skillDir, skillFile, reason: `${skillDir} is a symlink/junction — refusing to install through it.` };
    }
    if (!dirStat.isDirectory()) {
      return { action: 'error', skillDir, skillFile, reason: `${skillDir} exists and is not a directory.` };
    }
  }

  const fileStat = statNoThrow(skillFile);
  if (fileStat === null) {
    return { action: 'write', skillDir, skillFile };
  }
  if (fileStat.isSymbolicLink()) {
    return { action: 'error', skillDir, skillFile, reason: `${skillFile} is a symlink — refusing to install through it.` };
  }
  if (!fileStat.isFile()) {
    return { action: 'error', skillDir, skillFile, reason: `${skillFile} exists and is not a regular file.` };
  }

  const existingContent = fs.readFileSync(skillFile, 'utf8');
  const existingHash = extractSkillMarkerHash(existingContent);
  const desiredHash = extractSkillMarkerHash(desiredContent);

  if (existingHash === null) {
    if (force) {
      return { action: 'force-overwrite', skillDir, skillFile, existingContent };
    }
    if (name === DISPATCHER_SKILL_NAME) {
      return {
        action: 'blocked', skillDir, skillFile,
        reason: `${skillFile} is user-authored (no managed-by marker) — a foreign "${DISPATCHER_SKILL_NAME}" skill here ` +
          `would keep firing on every bare "${DISPATCHER_SKILL_NAME}" utterance. Re-run with --force-skills to overwrite it (a .bak copy is made first).`,
      };
    }
    return {
      action: 'skip', skillDir, skillFile,
      reason: `${skillFile} is user-authored (no managed-by marker); use --force-skills to overwrite.`,
    };
  }

  if (existingHash === desiredHash) {
    return { action: 'unchanged', skillDir, skillFile };
  }
  return { action: 'overwrite', skillDir, skillFile, oldHash: existingHash, newHash: desiredHash };
}

/** Atomic write: temp file + rename, in the same directory as the target. */
function atomicWriteFile(targetPath, content) {
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  const tmpPath = `${targetPath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmpPath, content, 'utf8');
  fs.renameSync(tmpPath, targetPath);
}

// Stale pre-adapter artifacts: Codex auto-migrated ~/.claude/commands into
// ~/.agents/skills/source-command-handoff-* for users who had Claude Code
// installed. These are never touched (never followed if a symlink, never
// deleted) — only reported, since removing another tool's auto-migrated
// content is out of scope and risky.
const STALE_SOURCE_COMMAND_RE = /^source-command-handoff-/i;

function findStaleSourceCommandSkills(targetDir) {
  let entries;
  try { entries = fs.readdirSync(targetDir, { withFileTypes: true }); } catch (_) { return []; }
  const stale = [];
  for (const entry of entries) {
    if (!STALE_SOURCE_COMMAND_RE.test(entry.name)) continue;
    const full = path.join(targetDir, entry.name);
    const isSymlink = statNoThrow(full)?.isSymbolicLink() === true;
    stale.push({ name: entry.name, path: full, isSymlink });
  }
  return stale;
}

/**
 * Install every skill in `skills` ([{ name, content }]) into `targetDir`.
 * Never throws — every per-skill outcome is collected into `results`, and
 * the caller decides exit code (any 'error' or 'blocked' result -> exit 1).
 * `dryRun` classifies and reports without writing or backing up anything.
 */
function installSkills({ targetDir, skills, dryRun, force }) {
  const results = [];
  for (const skill of skills) {
    const plan = classifySkillTarget({ targetDir, name: skill.name, desiredContent: skill.content, force });

    if (dryRun) {
      results.push({ ...plan, name: skill.name, wrote: false });
      continue;
    }

    switch (plan.action) {
      case 'write': {
        atomicWriteFile(plan.skillFile, skill.content);
        results.push({ ...plan, name: skill.name, wrote: true });
        break;
      }
      case 'overwrite': {
        atomicWriteFile(plan.skillFile, skill.content);
        results.push({ ...plan, name: skill.name, wrote: true });
        break;
      }
      case 'force-overwrite': {
        const backupPath = makeTimestampedBackupPath(plan.skillFile);
        fs.copyFileSync(plan.skillFile, backupPath);
        atomicWriteFile(plan.skillFile, skill.content);
        results.push({ ...plan, name: skill.name, wrote: true, backupPath });
        break;
      }
      case 'unchanged':
      case 'skip':
      case 'blocked':
      case 'error':
      default: {
        results.push({ ...plan, name: skill.name, wrote: false });
        break;
      }
    }
  }

  const stale = findStaleSourceCommandSkills(targetDir);

  const summary = {
    written: results.filter((r) => r.action === 'write' || r.action === 'overwrite' || r.action === 'force-overwrite').length,
    unchanged: results.filter((r) => r.action === 'unchanged').length,
    skipped: results.filter((r) => r.action === 'skip').length,
    errors: results.filter((r) => r.action === 'error' || r.action === 'blocked').length,
  };

  return { results, stale, summary };
}

module.exports = {
  MCP_SERVER_NAME,
  DISPATCHER_SKILL_NAME,
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
  // Exported for direct, platform-independent unit testing of the shell-
  // quoting/classification internals (PR #276 review finding) — pure string
  // functions, safe to call regardless of the CURRENT process.platform.
  needsCmdShell,
  classifyAndQuoteWin32,
  quoteShellArgPosix,
  spawnSync,
  // Codex skills install (A)
  computeSkillBodyHash,
  extractSkillMarkerHash,
  buildSkillFileText,
  resolveCodexSkillsDir,
  classifySkillTarget,
  installSkills,
  findStaleSourceCommandSkills,
  makeTimestampedBackupPath,
  atomicWriteFile,
};
