'use strict';

/**
 * scripts/lib/prereqs.js — installer prerequisite checker
 * (docs/specs/package-and-installer.md §3).
 *
 * Implements the total, five-outcome classification the spec requires:
 * PRESENT_OK / PRESENT_TOO_OLD / ABSENT / UNKNOWN / AMBIGUOUS_PG (postgres
 * row only). Findings this file specifically closes (see the spec section
 * of the same letter for the full rationale):
 *
 *   A1/G1 — classifyVersion parses a STRICT ^v?\d+\.\d+\.\d+$ token; any
 *           other shape (range, prerelease, bare major) is UNKNOWN, never
 *           silently accepted as satisfying a minimum.
 *   A2    — exit 9009 / empty stdout on exit 0 / any nonzero exit from a
 *           process that DID spawn is UNKNOWN, not ABSENT. ABSENT is
 *           reserved for a confirmed spawn-level not-found (ENOENT),
 *           produced only by classifyProbe, never by classifyVersion.
 *   A3/A4 — classifyCodexFunctional / classifyClaudeFunctional layer a
 *           functional check on top of a passing version parse.
 *   A5    — probeAll's docker row also probes `docker info` (15s timeout).
 *   B1    — assistFor never marks an ELEVATED_PREREQS remediation
 *           mayAutoRun: true, regardless of outcome or --yes.
 *   B2    — classifyPostgresRow is a genuine 5-way total classification
 *           (including AMBIGUOUS_PG), not a boolean.
 *   G2    — gh's nonzero-non-ENOENT exit classifies UNKNOWN (via the same
 *           A2 rule), never ABSENT, and probeAll marks it required: false.
 *
 * Design: every classify* function is pure (no I/O) and takes an
 * execFile-shaped result object, so tests never spawn real processes.
 * probeAll() is the only function that touches the outside world, and even
 * it takes an injectable `exec` (opts.exec) for the same reason — the real
 * default implementation (defaultExec, using child_process.execFile) is
 * intentionally the thin, untested-here part; see this repo's PR
 * description "BLIND SPOTS" for what real-OS probe behavior this file
 * cannot verify in CI.
 */

const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const http = require('node:http');
const https = require('node:https');

const DEFAULT_TIMEOUT_MS = 5000;
const DOCKER_INFO_TIMEOUT_MS = 15000; // A5

// Strict major.minor.patch only — no ranges, no prerelease/build suffixes,
// no bare major/minor. A1/G1.
const VERSION_TOKEN_RE = /^v?(\d+)\.(\d+)\.(\d+)$/;

// B1: prereqs whose real-world install command is elevated on every
// supported platform (Docker Desktop, a system Postgres, the pgvector
// extension package). node/git/gh have non-elevated install paths on at
// least one supported platform (winget --scope user, brew, apt for a
// non-root-required flow is still elevated on Linux, but we deliberately
// keep this list to the unambiguous cases rather than guessing).
const ELEVATED_PREREQS = new Set(['docker', 'postgres', 'pgvector']);

const REQUIRED_PREREQS_DEFAULT = ['node', 'git', 'pgDump', 'hostCli', 'postgres', 'pgvector', 'embedder'];

// ─── pure version parsing ────────────────────────────────────────────────

function parseVersionToken(stdout) {
  if (typeof stdout !== 'string') return null;
  const tokens = stdout.trim().split(/\s+/);
  for (const raw of tokens) {
    const token = raw.replace(/[,;]+$/, '');
    const m = VERSION_TOKEN_RE.exec(token);
    if (m) return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) };
  }
  return null;
}

function compareVersion(a, b) {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  return a.patch - b.patch;
}

function fmtVersion(v) {
  return `${v.major}.${v.minor}.${v.patch}`;
}

function parseMin(min) {
  if (min && typeof min === 'object' && typeof min.major === 'number') return min;
  const parsed = parseVersionToken(String(min));
  if (!parsed) throw new Error(`prereqs.js: invalid min version ${JSON.stringify(min)}`);
  return parsed;
}

/**
 * classifyVersion(stdout, exitCode, min) — pure, total classification of a
 * version probe's raw output. Returns { outcome, reason, version, min }.
 * outcome is one of PRESENT_OK / PRESENT_TOO_OLD / UNKNOWN. Never ABSENT —
 * that outcome requires a confirmed spawn-level failure this function
 * never sees (see classifyProbe).
 */
function classifyVersion(stdout, exitCode, min) {
  const minVer = parseMin(min);
  const minStr = fmtVersion(minVer);

  if (exitCode === 9009) {
    // A2: Windows "not recognized" surfacing through a shell-wrapper spawn.
    // Ambiguous -- could be a broken PATH shim shadowing a working install
    // further down PATH. Never a plain ABSENT.
    return { outcome: 'UNKNOWN', reason: 'path_alias_shadowing', version: null, min: minStr };
  }
  if (typeof exitCode !== 'number') {
    return { outcome: 'UNKNOWN', reason: 'no_exit_code', version: null, min: minStr };
  }
  if (exitCode !== 0) {
    // G2: a nonzero exit from a process that DID spawn is ambiguous, not a
    // confident "absent" -- only classifyProbe's ENOENT path is ABSENT.
    return { outcome: 'UNKNOWN', reason: 'nonzero_exit', version: null, min: minStr };
  }
  if (typeof stdout !== 'string' || stdout.trim() === '') {
    // A2: empty stdout on exit 0 -- a launcher stub (e.g. a Windows Store
    // app-execution alias) that returns immediately with nothing printed.
    return { outcome: 'UNKNOWN', reason: 'empty_stdout', version: null, min: minStr };
  }
  const found = parseVersionToken(stdout);
  if (!found) {
    // A1/G1: anything that is not a strict v?\d+.\d+.\d+ token -- a range,
    // a prerelease suffix, a bare major -- is UNKNOWN, never silently
    // treated as satisfying the minimum.
    return { outcome: 'UNKNOWN', reason: 'unparseable_version', version: null, min: minStr };
  }
  const outcome = compareVersion(found, minVer) >= 0 ? 'PRESENT_OK' : 'PRESENT_TOO_OLD';
  return { outcome, reason: null, version: fmtVersion(found), min: minStr };
}

/**
 * classifyProbe(result, rule) — wraps classifyVersion (or a functional-only
 * rule) with the spawn-level outcomes. result is execFile-shaped:
 * { error, status, stdout, stderr, timedOut }. A timeout is UNKNOWN (the
 * process may still be running -- never silently ABSENT). A real spawn
 * error (ENOENT-shaped: result.error set, no numeric status) is the ONLY
 * path to ABSENT.
 * rule: { min } for a version rule, or { functional: fn(result) } to
 * delegate entirely (used for docker info / host-CLI functional checks).
 */
function classifyProbe(result, rule) {
  rule = rule || {};
  result = result || {};
  if (result.timedOut) {
    return { outcome: 'UNKNOWN', reason: 'timeout', version: null };
  }
  if (result.error) {
    return { outcome: 'ABSENT', reason: 'not_found', version: null };
  }
  if (typeof rule.functional === 'function') {
    return rule.functional(result);
  }
  return classifyVersion(result.stdout, result.status, rule.min);
}

// ─── host CLI functional checks (A3/A4) ──────────────────────────────────

/**
 * codex: after a passing version parse, the resolved binary's OWN
 * directory must contain a codex-code-mode-host* sibling file. Missing it
 * is UNKNOWN (reason missing_code_mode_host) -- a `--version`-only probe
 * cannot tell "works" from "answers --version but every real tool call
 * fails" (see reference_codex_cli_working_binary_for_exec).
 */
function classifyCodexFunctional(result, opts) {
  opts = opts || {};
  const versionOutcome = classifyVersion(result.stdout, result.status, opts.min);
  if (versionOutcome.outcome === 'UNKNOWN') return versionOutcome;

  const dir = opts.resolvedDir;
  if (!dir) {
    return { outcome: 'UNKNOWN', reason: 'no_resolved_dir', version: versionOutcome.version, min: versionOutcome.min };
  }
  let entries = [];
  try {
    entries = fs.readdirSync(dir);
  } catch (_) {
    return { outcome: 'UNKNOWN', reason: 'resolved_dir_unreadable', version: versionOutcome.version, min: versionOutcome.min };
  }
  const hasHost = entries.some((f) => /^codex-code-mode-host/i.test(f));
  if (!hasHost) {
    return { outcome: 'UNKNOWN', reason: 'missing_code_mode_host', version: versionOutcome.version, min: versionOutcome.min };
  }
  return versionOutcome;
}

/**
 * claude: after a passing version parse, the probe's stdout must carry the
 * CLI's own signature text. A bare version with no marker is UNKNOWN
 * (reason desktop_launcher_suspected) -- a desktop-app launcher stub can
 * answer `--version` with just a number before doing something else
 * entirely.
 */
function classifyClaudeFunctional(result, opts) {
  opts = opts || {};
  const versionOutcome = classifyVersion(result.stdout, result.status, opts.min);
  if (versionOutcome.outcome === 'UNKNOWN') return versionOutcome;

  const stdout = String(result.stdout || '');
  if (!/claude code/i.test(stdout)) {
    return { outcome: 'UNKNOWN', reason: 'desktop_launcher_suspected', version: versionOutcome.version, min: versionOutcome.min };
  }
  return versionOutcome;
}

// ─── postgres row: total 5-way classification (B2) ───────────────────────

/**
 * classifyPostgresRow({ dockerAvailable, externalPgOn5432, composeWanted })
 * dockerAvailable / externalPgOn5432: 'yes' | 'no' | 'unknown'.
 * composeWanted: boolean -- the user's stated preference for the compose
 * path, independent of what is actually reachable.
 * Returns { outcome, reason } where outcome is one of PRESENT_OK / ABSENT /
 * UNKNOWN / AMBIGUOUS_PG. This is a total classification over the 3x3x2
 * input space, not a boolean allow-list.
 */
function classifyPostgresRow(opts) {
  opts = opts || {};
  const dockerAvailable = opts.dockerAvailable;
  const externalPgOn5432 = opts.externalPgOn5432;
  const composeWanted = !!opts.composeWanted;

  if (dockerAvailable !== 'yes' && dockerAvailable !== 'no') {
    return { outcome: 'UNKNOWN', reason: 'docker_probe_inconclusive' };
  }
  if (externalPgOn5432 !== 'yes' && externalPgOn5432 !== 'no') {
    return { outcome: 'UNKNOWN', reason: 'external_pg_probe_inconclusive' };
  }
  if (externalPgOn5432 === 'yes' && dockerAvailable === 'yes' && composeWanted) {
    // B2: both paths resolve and the user asked for compose while an
    // external instance is ALSO reachable on the well-known port -- never
    // silently pick one.
    return { outcome: 'AMBIGUOUS_PG', reason: 'external_and_compose_both_available' };
  }
  if (externalPgOn5432 === 'yes' || dockerAvailable === 'yes') {
    return { outcome: 'PRESENT_OK', reason: null };
  }
  return { outcome: 'ABSENT', reason: 'neither_resolved' };
}

// ─── remediation text (B1) ────────────────────────────────────────────────

const REMEDIATION = {
  node:     { win32: 'winget install OpenJS.NodeJS.LTS', darwin: 'brew install node', linux: 'apt install nodejs' },
  git:      { win32: 'winget install Git.Git', darwin: 'brew install git', linux: 'apt install git' },
  gh:       { win32: 'winget install GitHub.cli', darwin: 'brew install gh', linux: 'apt install gh' },
  docker:   { win32: 'winget install Docker.DockerDesktop', darwin: 'brew install --cask docker', linux: 'apt install docker.io docker-compose-plugin' },
  postgres: { win32: 'winget install PostgreSQL.PostgreSQL', darwin: 'brew install postgresql@16', linux: 'apt install postgresql-16' },
  pgvector: { win32: 'CREATE EXTENSION vector; (see PREREQS.md -- Windows requires the pgvector binary build)', darwin: 'brew install pgvector', linux: 'apt install postgresql-16-pgvector' },
  pgDump:   { win32: 'ships with PostgreSQL.PostgreSQL', darwin: 'ships with postgresql@16', linux: 'apt install postgresql-client-16' },
  codex:    { win32: 'see https://github.com/openai/codex#install', darwin: 'see https://github.com/openai/codex#install', linux: 'see https://github.com/openai/codex#install' },
  claude:   { win32: 'see https://docs.claude.com/claude-code', darwin: 'see https://docs.claude.com/claude-code', linux: 'see https://docs.claude.com/claude-code' },
  hostCli:  { win32: 'see docs/hosts/codex.md or https://docs.claude.com/claude-code', darwin: 'see docs/hosts/codex.md or https://docs.claude.com/claude-code', linux: 'see docs/hosts/codex.md or https://docs.claude.com/claude-code' },
  embedder: { win32: 'see docs/hosts/codex.md (vLLM/Ollama setup) or decline for FTS-only', darwin: 'see docs/hosts/codex.md (vLLM/Ollama setup) or decline for FTS-only', linux: 'see docs/hosts/codex.md (vLLM/Ollama setup) or decline for FTS-only' },
};

/**
 * assistFor(prereq, outcome, platform) — remediation text plus whether it
 * may run unattended under --yes. outcome is a classify* result object
 * ({ outcome, reason, ... }). B1: an ELEVATED_PREREQS remediation is NEVER
 * mayAutoRun: true, regardless of --yes.
 */
function assistFor(prereq, outcome, platform) {
  platform = platform || process.platform;
  outcome = outcome || {};

  if (outcome.outcome === 'PRESENT_OK') {
    return { text: null, mayAutoRun: false };
  }

  if (outcome.reason === 'path_alias_shadowing') {
    return {
      text: `${prereq}: found something on PATH but it did not behave like ${prereq} ` +
        `(empty output / exit 9009 / launcher stub). This usually means a PATH ` +
        `alias or shim is shadowing the real executable earlier in PATH. Check ` +
        `\`where ${prereq}\` (Windows) / \`which -a ${prereq}\` (POSIX) for ` +
        `duplicate entries before installing anything -- installing over this ` +
        `would not fix a shadowing problem.`,
      mayAutoRun: false,
    };
  }
  if (outcome.reason === 'missing_code_mode_host') {
    return {
      text: `codex: found on PATH but its directory has no codex-code-mode-host ` +
        `sibling binary -- every MCP tool call will fail with "failed to spawn ` +
        `code-mode host". Point HANDOFF_CODEX_BIN at a complete install (see ` +
        `docs/hosts/codex.md) instead of the resolved PATH entry.`,
      mayAutoRun: false,
    };
  }
  if (outcome.reason === 'desktop_launcher_suspected') {
    return {
      text: `claude: the resolved binary printed a version but not the CLI's own ` +
        `signature text -- this may be a desktop-app launcher stub, not the ` +
        `Claude Code CLI. Re-check PATH ordering; see docs/troubleshooting.md.`,
      mayAutoRun: false,
    };
  }
  if (outcome.outcome === 'AMBIGUOUS_PG') {
    return {
      text: `postgres: both a Docker-compose Postgres and an external Postgres on ` +
        `5432 are available, and compose was requested. Pass --pg-source ` +
        `docker|external to choose explicitly -- this is never auto-picked.`,
      mayAutoRun: false,
    };
  }

  const elevated = ELEVATED_PREREQS.has(prereq);
  const platformCmds = REMEDIATION[prereq] || {};
  const cmd = platformCmds[platform] || `install ${prereq} manually`;
  const versionNote = outcome.outcome === 'PRESENT_TOO_OLD'
    ? ` (found ${outcome.version}, need >= ${outcome.min})`
    : '';
  return {
    text: `${prereq}${versionNote} -- ${cmd}`,
    // B1: only a non-elevated remediation may ever run unattended, and only
    // when the caller has --yes; ELEVATED_PREREQS is never mayAutoRun. A2:
    // an UNKNOWN outcome is never auto-installed over either, regardless of
    // whether the prereq itself is elevated -- an ambiguous probe result
    // (timeout, unparseable output, nonzero exit) is not a safe basis for
    // an unattended install even of a normally non-elevated tool.
    mayAutoRun: !elevated && outcome.outcome !== 'UNKNOWN' && outcome.outcome !== 'AMBIGUOUS_PG',
  };
}

// ─── real-world exec (untested here -- see PR blind spots) ──────────────

function defaultExec(command, args, timeoutMs) {
  return new Promise((resolve) => {
    execFile(command, args, { timeout: timeoutMs, windowsHide: true }, (error, stdout, stderr) => {
      if (error) {
        if (error.killed && error.signal) {
          resolve({ error: null, status: null, stdout: stdout || '', stderr: stderr || '', timedOut: true });
          return;
        }
        if (typeof error.code !== 'number') {
          // ENOENT and friends -- spawn-level failure, the process never ran.
          resolve({ error, status: null, stdout: '', stderr: '', timedOut: false });
          return;
        }
        resolve({ error: null, status: error.code, stdout: stdout || '', stderr: stderr || '', timedOut: false });
        return;
      }
      resolve({ error: null, status: 0, stdout: stdout || '', stderr: stderr || '', timedOut: false });
    });
  });
}

function defaultHttpProbe(url, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    let client;
    try {
      client = new URL(url).protocol === 'https:' ? https : http;
    } catch (_) {
      resolve('unknown');
      return;
    }
    const req = client.get(url, { timeout: timeoutMs }, (res) => {
      if (settled) return;
      settled = true;
      res.destroy();
      resolve(res.statusCode >= 200 && res.statusCode < 300);
    });
    req.on('timeout', () => {
      if (settled) return;
      settled = true;
      req.destroy();
      resolve('unknown');
    });
    req.on('error', () => {
      if (settled) return;
      settled = true;
      resolve(false);
    });
  });
}

// ─── probeAll: orchestrates every §3 row ─────────────────────────────────

/**
 * probeAll(opts) -- runs every §3 prerequisite row and returns
 * { rows, ok, platform, host }. `exec` and `httpProbe` are injectable for
 * tests; the real defaults spawn real processes / make a real HTTP probe
 * (the part of this file NOT covered by test/test-prereqs.js -- see PR
 * blind spots).
 *
 * opts: {
 *   exec, httpProbe,                       // injectable I/O seams
 *   platform, host,                        // 'claude' | 'codex', default 'claude'
 *   codexMin, claudeMin, nodeMin, pgDumpMin, pgvectorImage,
 *   resolveHostDir(host) -> string|null,   // caller re-resolves at wiring time (TOCTOU, A3/A4)
 *   composeWanted, dockerImageShipsVector,
 *   embedderDeclined, embedderUrl,
 *   skipDockerInfo,                        // test seam -- never used by the real CLI wiring
 * }
 */
async function probeAll(opts) {
  opts = opts || {};
  const exec = opts.exec || defaultExec;
  const httpProbe = opts.httpProbe || defaultHttpProbe;
  const platform = opts.platform || process.platform;
  const host = opts.host === 'codex' ? 'codex' : 'claude';
  const rows = [];

  // node
  {
    const r = await exec('node', ['--version'], DEFAULT_TIMEOUT_MS);
    rows.push({ prereq: 'node', required: true, ...classifyProbe(r, { min: opts.nodeMin || '22.0.0' }) });
  }
  // git
  {
    const r = await exec('git', ['--version'], DEFAULT_TIMEOUT_MS);
    rows.push({ prereq: 'git', required: true, ...classifyProbe(r, { min: '0.0.0' }) });
  }
  // gh (G2, optional -- never gates)
  {
    const r = await exec('gh', ['--version'], DEFAULT_TIMEOUT_MS);
    rows.push({ prereq: 'gh', required: false, ...classifyProbe(r, { min: '0.0.0' }) });
  }
  // pg_dump (E1)
  {
    const r = await exec('pg_dump', ['--version'], DEFAULT_TIMEOUT_MS);
    rows.push({ prereq: 'pgDump', required: true, ...classifyProbe(r, { min: opts.pgDumpMin || '16.0.0' }) });
  }
  // host CLI (A3/A4)
  {
    const cliCmd = host === 'codex' ? 'codex' : 'claude';
    const min = host === 'codex' ? (opts.codexMin || '0.100.0') : (opts.claudeMin || '0.0.0');
    const r = await exec(cliCmd, ['--version'], DEFAULT_TIMEOUT_MS);
    const resolvedDir = typeof opts.resolveHostDir === 'function' ? opts.resolveHostDir(host) : null;
    const functional = host === 'codex'
      ? (res) => classifyCodexFunctional(res, { min, resolvedDir })
      : (res) => classifyClaudeFunctional(res, { min });
    rows.push({ prereq: 'hostCli', host, required: true, ...classifyProbe(r, { functional }) });
  }
  // docker + postgres pair (A5/B2)
  {
    const dockerR = await exec('docker', ['compose', 'version'], DEFAULT_TIMEOUT_MS);
    const dockerInfoR = opts.skipDockerInfo ? null : await exec('docker', ['info'], DOCKER_INFO_TIMEOUT_MS);
    const psqlR = await exec('psql', ['-c', 'SELECT 1'], DEFAULT_TIMEOUT_MS);

    const dockerOk = (r) => !!(r && !r.error && !r.timedOut && r.status === 0);
    const dockerBad = (r) => !!(r && r.error);
    let dockerAvailable = 'unknown';
    if (dockerOk(dockerR) && (opts.skipDockerInfo || dockerOk(dockerInfoR))) dockerAvailable = 'yes';
    else if (dockerBad(dockerR) || (!opts.skipDockerInfo && dockerBad(dockerInfoR))) dockerAvailable = 'no';

    let externalPgOn5432 = 'unknown';
    if (dockerOk(psqlR)) externalPgOn5432 = 'yes';
    else if (dockerBad(psqlR)) externalPgOn5432 = 'no';

    const c = classifyPostgresRow({ dockerAvailable, externalPgOn5432, composeWanted: !!opts.composeWanted });
    rows.push({ prereq: 'postgres', required: true, version: null, ...c });
  }
  // pgvector extension creatable
  {
    if (opts.dockerImageShipsVector) {
      rows.push({ prereq: 'pgvector', required: true, outcome: 'PRESENT_OK', reason: 'docker_image_ships_vector', version: null });
    } else {
      const r = await exec('psql', ['-c', 'CREATE EXTENSION IF NOT EXISTS vector;'], DEFAULT_TIMEOUT_MS);
      let outcome;
      if (r && r.timedOut) outcome = { outcome: 'UNKNOWN', reason: 'timeout' };
      else if (r && r.error) outcome = { outcome: 'ABSENT', reason: 'not_found' };
      else if (r && r.status === 0) outcome = { outcome: 'PRESENT_OK', reason: null };
      else outcome = { outcome: 'UNKNOWN', reason: 'nonzero_exit' };
      rows.push({ prereq: 'pgvector', required: true, version: null, ...outcome });
    }
  }
  // embedder
  {
    if (opts.embedderDeclined) {
      rows.push({ prereq: 'embedder', required: false, outcome: 'PRESENT_OK', reason: 'declined_degraded_fts_only', version: null });
    } else if (opts.embedderUrl) {
      const ok = await httpProbe(opts.embedderUrl, DEFAULT_TIMEOUT_MS);
      const outcome = ok === true ? 'PRESENT_OK' : ok === 'unknown' ? 'UNKNOWN' : 'ABSENT';
      rows.push({ prereq: 'embedder', required: true, outcome, reason: outcome === 'PRESENT_OK' ? null : 'unreachable', version: null });
    } else {
      rows.push({ prereq: 'embedder', required: true, outcome: 'ABSENT', reason: 'not_configured', version: null });
    }
  }

  const requiredFailing = rows.filter((r) => r.required && r.outcome !== 'PRESENT_OK');
  const ok = requiredFailing.length === 0;
  return { rows, ok, platform, host };
}

module.exports = {
  VERSION_TOKEN_RE,
  ELEVATED_PREREQS,
  REQUIRED_PREREQS_DEFAULT,
  parseVersionToken,
  compareVersion,
  classifyVersion,
  classifyProbe,
  classifyCodexFunctional,
  classifyClaudeFunctional,
  classifyPostgresRow,
  assistFor,
  probeAll,
  defaultExec,
  defaultHttpProbe,
  DEFAULT_TIMEOUT_MS,
  DOCKER_INFO_TIMEOUT_MS,
};
