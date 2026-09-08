'use strict';

/**
 * codex-install.js — OpenAI Codex CLI host adapter for install.js.
 *
 * Kept as a SEPARATE module from install.js so the Claude Code install path
 * in install.js is provably untouched by this feature (see
 * scripts/test-install-host.js's byte-identical-Claude-fixture case) —
 * install.js only branches into this module when `--host codex` resolves.
 *
 * Verified against docs only (no `codex` binary is installed on the
 * authoring machine — flagged in the PR body's BLIND SPOTS section, not
 * silently assumed):
 *   - MCP registration: `codex mcp add <name> [--env KEY=VALUE ...] -- <command> [args...]`.
 *     Config: ${CODEX_HOME:-~/.codex}/config.toml under [mcp_servers.<name>]
 *     with command / args / [mcp_servers.<name>.env].
 *     https://learn.chatgpt.com/docs/extend/mcp
 *   - Hooks: user-scope ${CODEX_HOME:-~/.codex}/hooks.json, shape
 *     {"hooks":{"SessionStart":[{"matcher":"startup|resume","hooks":[{"type":"command","command":"...","timeout":<seconds>}]}],
 *               "SessionEnd":[{"hooks":[{"type":"command","command":"...","timeout":<seconds>}]}]}}.
 *     Project-scope .codex/hooks.json is known-buggy upstream — user scope
 *     only, no `codex hooks add` CLI exists.
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
function spawnSync(command, args, opts) {
  const cmd = (/\s/.test(command) && !/^".*"$/.test(command)) ? `"${command}"` : command;
  return nodeSpawnSync(cmd, args, {
    windowsHide: true,
    ...opts,
    shell: true,
  });
}

// ─── whole-token "handoff" match (S2) ────────────────────────────────────────
// Hyphen deliberately does NOT count as a token boundary, so `handoff-dev`
// must NOT match — only the exact standalone token `handoff` does.
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

/**
 * `codex mcp get handoff` — total classification:
 *   nonzero exit (or a spawn error)                       -> not registered
 *   zero exit, stdout contains "handoff" as a whole token  -> registered
 *   zero exit, stdout does NOT contain that token          -> not registered
 *     (there is no third state to invent here; `codex mcp add` is safe to
 *     attempt in this branch and will itself fail loudly on a real conflict)
 */
function checkHandoffRegistered(codexCommand) {
  const result = spawnSync(codexCommand, ['mcp', 'get', MCP_SERVER_NAME], { encoding: 'utf8', windowsHide: true });
  if (result.error) return { registered: false, stdout: '', stderr: String(result.error.message || '') };
  if (typeof result.status !== 'number' || result.status !== 0) {
    return { registered: false, stdout: result.stdout || '', stderr: result.stderr || '' };
  }
  return { registered: isHandoffToken(result.stdout), stdout: result.stdout || '', stderr: result.stderr || '' };
}

/** Runs `codex mcp add ...` for real via spawnSync with an argv array (never a shell string). */
function registerHandoffMcp(codexCommand, enginePath) {
  const argv = buildMcpAddArgv(enginePath);
  const result = spawnSync(codexCommand, argv, { encoding: 'utf8', windowsHide: true });
  const ok = !result.error && typeof result.status === 'number' && result.status === 0;
  return { ok, argv, stdout: result.stdout || '', stderr: result.error ? String(result.error.message) : (result.stderr || '') };
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
  resolveCodexHome,
  installCodexHooks,
};
