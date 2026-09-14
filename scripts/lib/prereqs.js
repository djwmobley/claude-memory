'use strict';

/**
 * scripts/lib/prereqs.js — installer prerequisite checker
 * (docs/specs/package-and-installer.md §3).
 *
 * Implements the total, six-outcome classification the spec requires:
 * PRESENT_OK / PRESENT_TOO_OLD / ABSENT / UNKNOWN / AMBIGUOUS_PG (postgres
 * row only) / ABSENT_BUT_AVAILABLE (pgvector row only, round 2 H4 below).
 * Findings this file specifically closes (see the spec section
 * of the same letter for the full rationale):
 *
 *   A1/G1 — classifyVersion parses a STRICT ^v?\d+\.\d+\.\d+$ token; any
 *           other shape (range, prerelease, bare major) is UNKNOWN, never
 *           silently accepted as satisfying a minimum.
 *   B3    — the STRICT rule above is wrong for PostgreSQL-family binaries:
 *           PostgreSQL >= 10 reports a two-part version (`postgres
 *           (PostgreSQL) 16.2`, `pg_dump (PostgreSQL) 18.0`); versions
 *           before 10 reported three-part. classifyVersion takes an
 *           optional `{ family: 'postgres' }` rule that swaps in
 *           PG_VERSION_TOKEN_RE (two-OR-three-part, no "v" prefix, no
 *           prerelease/build suffix) instead of the strict rule -- applied
 *           via the same first-whitespace-token-that-matches-in-full scan,
 *           so it lands on the numeral in the tool's own `(PostgreSQL)
 *           X.Y` banner without needing to special-case that marker's
 *           position. Every other prerequisite (node/git/gh/codex/claude)
 *           keeps the strict three-part rule unchanged. A dev/beta build
 *           (`17devel`) has no `.` in its token and still never matches --
 *           UNKNOWN, never coerced. Only the `pgDump` row is wired to this
 *           family today (the only Postgres-family binary this file
 *           actually version-probes); the mechanism is written per-family
 *           so any future Postgres-family row (`psql`, `postgres`,
 *           `pg_isready`, `SHOW server_version`) can opt in the same way.
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
 * Round 2 fixes (Codex review of PR #309, r1 -- 6 blockers):
 *   H1 (git prefix family) — real `git --version` output carries a
 *      platform-specific packaging suffix the strict three-part rule
 *      rejects: `git version 2.49.0.windows.1` (Windows) never matches
 *      `^v?\d+\.\d+\.\d+$`. classifyVersion's family registry now also
 *      carries `family: 'git'`, using GIT_VERSION_TOKEN_RE — a three-part
 *      numeric PREFIX match that requires the character immediately after
 *      the numeral to be either end-of-token or a literal `.` (so a real
 *      packaging suffix like `.windows.1`/`.msysgit.1` is accepted and
 *      ignored, while a merged-garbage or prerelease shape like
 *      `2.49.0-rc1`/`2.49.0abc` still has no matching token and is
 *      UNKNOWN, same as every other family's rule). macOS git
 *      (`git version 2.39.3 (Apple Git-146)`) and Linux git already passed
 *      under the strict rule (their token has no suffix) and are unaffected.
 *      Every family's version rule is now a documented, named entry in
 *      VERSION_FAMILY_RULES rather than an inline ternary — "no family" /
 *      an unrecognized family name falls back to the strict default, never
 *      silently matches everything.
 *   H2 (classifyProbe spawn-error totality) — a truthy `result.error` used
 *      to become ABSENT unconditionally, which is correct only for a
 *      confirmed ENOENT (nothing resolves at that name) and wrong for
 *      EACCES/EPERM/any other spawn-level error code (something IS there
 *      but could not be launched — permissions, AV block, broken
 *      interpreter shebang). Only `error.code === 'ENOENT'` is ABSENT now;
 *      every other spawn-error code is UNKNOWN with the code embedded in
 *      the reason (`spawn_error_<code>`), never silently coerced to
 *      ENOENT's confident absence. The win32 exit-9009 "not recognized"
 *      signal is a SEPARATE, pre-existing UNKNOWN path reached only when
 *      the process DID spawn (see classifyVersion) — it never surfaces as
 *      result.error at all, so it is unaffected by this fix.
 *   H3 (codex sibling must be a file) — classifyCodexFunctional's
 *      `codex-code-mode-host*` sibling match now requires fs.statSync(...)
 *      .isFile() (which follows symlinks, so a symlink resolving to a
 *      regular file still counts) on every name match, not just a
 *      directory-entry NAME match — a directory happening to be named
 *      `codex-code-mode-host` no longer satisfies the check.
 *   H4 (pgvector probe is read-only) — probeAll's pgvector row used to run
 *      `psql -c "CREATE EXTENSION IF NOT EXISTS vector;"`, which can WRITE
 *      to the connected database despite `--check-only`'s documented
 *      "writes nothing" contract. It now runs two read-only queries —
 *      `SELECT 1 FROM pg_extension WHERE extname='vector'` (is it
 *      installed?) and, only when that returns no row,
 *      `SELECT * FROM pg_available_extensions WHERE name='vector'` (is it
 *      installable?) — never CREATE EXTENSION. This adds a SIXTH total
 *      outcome, ABSENT_BUT_AVAILABLE (installable but not yet installed;
 *      still gates as failing, same as ABSENT/UNKNOWN, but with distinct,
 *      more useful remediation text — see classifyPgvectorProbe and
 *      assistFor's `extension_available_not_installed` branch).
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
// no bare major/minor. A1/G1. Used for node/git/gh/codex/claude.
const VERSION_TOKEN_RE = /^v?(\d+)\.(\d+)\.(\d+)$/;

// Postgres-family version token — two-OR-three-part digits, no "v" prefix,
// no prerelease/build suffix. B3: PostgreSQL >= 10 reports two-part
// (16.2); pre-10 reported three-part (9.6.24). A dev/beta build
// (17devel, 18beta2) has no "." in its token and never matches.
const PG_VERSION_TOKEN_RE = /^(\d+)\.(\d+)(?:\.(\d+))?$/;

// Git-family version token (H1) — a three-part numeric PREFIX, requiring
// whatever immediately follows the numeral to be either end-of-token or a
// literal "." (never an arbitrary character). Real `git --version` output
// carries a platform packaging suffix the strict rule rejects:
// `git version 2.49.0.windows.1` (Windows), `git version 2.43.0` (Linux,
// no suffix, already matches the strict rule too). The end-of-token-or-dot
// guard is what keeps this a PREFIX match rather than an unanchored one: a
// prerelease/garbage shape like `2.49.0-rc1` or `2.49.0abc` has no
// character-after-numeral that is "." or end-of-token, so it still has no
// matching token and is UNKNOWN, exactly like every other family's rule.
const GIT_VERSION_TOKEN_RE = /^(\d+)\.(\d+)\.(\d+)(?=\.|$)/;

// Per-family version-token rule registry (H1) — every prerequisite's rule
// is a named, documented entry here, never an inline ternary. An
// unrecognized/omitted family name falls back to VERSION_TOKEN_RE (the
// strict default), never silently matches everything.
const VERSION_FAMILY_RULES = {
  postgres: PG_VERSION_TOKEN_RE,
  git: GIT_VERSION_TOKEN_RE,
};

function versionRuleFor(family) {
  return VERSION_FAMILY_RULES[family] || VERSION_TOKEN_RE;
}

// B1: prereqs whose real-world install command is elevated on every
// supported platform (Docker Desktop, a system Postgres, the pgvector
// extension package). node/git/gh have non-elevated install paths on at
// least one supported platform (winget --scope user, brew, apt for a
// non-root-required flow is still elevated on Linux, but we deliberately
// keep this list to the unambiguous cases rather than guessing).
const ELEVATED_PREREQS = new Set(['docker', 'postgres', 'pgvector']);

const REQUIRED_PREREQS_DEFAULT = ['node', 'git', 'pgDump', 'hostCli', 'postgres', 'pgvector', 'embedder'];

// ─── pure version parsing ────────────────────────────────────────────────

function parseVersionToken(stdout, re) {
  re = re || VERSION_TOKEN_RE;
  if (typeof stdout !== 'string') return null;
  const tokens = stdout.trim().split(/\s+/);
  for (const raw of tokens) {
    const token = raw.replace(/[,;]+$/, '');
    const m = re.exec(token);
    if (m) return { major: Number(m[1]), minor: Number(m[2]), patch: m[3] !== undefined ? Number(m[3]) : 0 };
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
 * classifyVersion(stdout, exitCode, min, opts) — pure, total classification
 * of a version probe's raw output. Returns { outcome, reason, version, min }.
 * outcome is one of PRESENT_OK / PRESENT_TOO_OLD / UNKNOWN. Never ABSENT —
 * that outcome requires a confirmed spawn-level failure this function
 * never sees (see classifyProbe).
 * opts.family: looks up the named rule in VERSION_FAMILY_RULES (H1) —
 * 'postgres' selects PG_VERSION_TOKEN_RE (B3), 'git' selects
 * GIT_VERSION_TOKEN_RE (H1) — every other prerequisite (including an
 * omitted or unrecognized family) keeps the strict VERSION_TOKEN_RE rule.
 */
function classifyVersion(stdout, exitCode, min, opts) {
  opts = opts || {};
  const versionRe = versionRuleFor(opts.family);
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
  const found = parseVersionToken(stdout, versionRe);
  if (!found) {
    // A1/G1 (strict rule) / B3 (postgres-family rule): anything that is
    // not the applicable token shape -- a range, a prerelease suffix, a
    // bare major, a dev/beta build with no "." -- is UNKNOWN, never
    // silently treated as satisfying the minimum.
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
 * error with error.code === 'ENOENT' (H2: confirmed "nothing resolves at
 * this name") is the ONLY path to ABSENT. Any OTHER spawn-error code
 * (EACCES, EPERM, etc. — something IS there but could not be launched) is
 * UNKNOWN, with the code embedded in the reason.
 * rule: { min, family } for a version rule (family: 'postgres' selects the
 * B3 two-or-three-part rule, see classifyVersion), or { functional: fn(result) }
 * to delegate entirely (used for docker info / host-CLI functional checks).
 */
function classifyProbe(result, rule) {
  rule = rule || {};
  result = result || {};
  if (result.timedOut) {
    return { outcome: 'UNKNOWN', reason: 'timeout', version: null };
  }
  if (result.error) {
    // H2: only a confirmed ENOENT ("nothing resolves at this name") is
    // ABSENT. EACCES/EPERM/any other spawn-error code means something IS
    // there but could not be launched -- ambiguous, never a confident
    // absence. The win32 exit-9009 "not recognized" signal is a SEPARATE
    // path (classifyVersion, reached only when the process DID spawn) and
    // never surfaces as result.error, so it is untouched here.
    const code = result.error && result.error.code;
    if (code === 'ENOENT') {
      return { outcome: 'ABSENT', reason: 'not_found', version: null };
    }
    return { outcome: 'UNKNOWN', reason: `spawn_error_${code || 'unknown'}`, version: null };
  }
  if (typeof rule.functional === 'function') {
    return rule.functional(result);
  }
  return classifyVersion(result.stdout, result.status, rule.min, { family: rule.family });
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
  // H3: a directory-entry NAME match is not sufficient -- a directory
  // (or a broken/unreadable path) named `codex-code-mode-host` must never
  // satisfy this check. fs.statSync follows symlinks, so a symlink that
  // resolves to a regular file still counts; a name-matching entry whose
  // stat throws (broken symlink, permission, race) is treated as not a
  // match rather than aborting the whole check.
  const hasHost = entries.some((f) => {
    if (!/^codex-code-mode-host/i.test(f)) return false;
    try {
      return fs.statSync(path.join(dir, f)).isFile();
    } catch (_) {
      return false;
    }
  });
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

// ─── pgvector: read-only 6-way total classification (H4) ─────────────────

/**
 * classifyPsqlBooleanQuery(result) — pure classification of one read-only
 * `psql -tAc "<boolean-shaped SELECT>"` probe result (execFile-shaped, same
 * as classifyProbe's `result` param). Returns { state: 'yes'|'no'|'unknown',
 * reason }. 'yes' means the query returned at least one row (non-empty
 * `-tAc` stdout); 'no' means it ran cleanly and returned zero rows; every
 * other case (timeout, spawn error, no exit code, nonzero exit) is
 * 'unknown' -- never coerced to a confident yes/no.
 */
function classifyPsqlBooleanQuery(result) {
  result = result || {};
  if (result.timedOut) return { state: 'unknown', reason: 'timeout' };
  if (result.error) {
    const code = result.error && result.error.code;
    // H2 parity: a confirmed ENOENT (psql itself not on PATH) is still
    // "unknown" here, never ABSENT -- this probe classifies the VECTOR
    // EXTENSION's state, not psql's own presence (that is a separate,
    // undeclared prerequisite outside this file's §3 row list).
    return { state: 'unknown', reason: code === 'ENOENT' ? 'psql_not_found' : `spawn_error_${code || 'unknown'}` };
  }
  if (typeof result.status !== 'number') return { state: 'unknown', reason: 'no_exit_code' };
  if (result.status !== 0) return { state: 'unknown', reason: 'nonzero_exit' };
  const out = String(result.stdout || '').trim();
  return { state: out.length > 0 ? 'yes' : 'no', reason: null };
}

/**
 * classifyPgvectorProbe(presentResult, availableResult) — H4: replaces the
 * old write-capable `CREATE EXTENSION IF NOT EXISTS vector` probe with two
 * READ-ONLY queries. `presentResult` is the result of
 * `SELECT 1 FROM pg_extension WHERE extname='vector'`; `availableResult`
 * (only consulted when `presentResult` classifies 'no' -- may be `null`
 * otherwise) is the result of
 * `SELECT * FROM pg_available_extensions WHERE name='vector'`. This is a
 * total classification over both queries' outcomes:
 *   present=yes                       -> PRESENT_OK
 *   present=unknown                   -> UNKNOWN
 *   present=no, available=yes         -> ABSENT_BUT_AVAILABLE (new outcome;
 *                                         installable but not installed --
 *                                         still gates as failing, like
 *                                         ABSENT/UNKNOWN, but with distinct
 *                                         remediation text, see assistFor)
 *   present=no, available=no          -> ABSENT
 *   present=no, available=unknown     -> UNKNOWN
 */
function classifyPgvectorProbe(presentResult, availableResult) {
  const present = classifyPsqlBooleanQuery(presentResult);
  if (present.state === 'unknown') {
    return { outcome: 'UNKNOWN', reason: present.reason };
  }
  if (present.state === 'yes') {
    return { outcome: 'PRESENT_OK', reason: null };
  }
  const available = classifyPsqlBooleanQuery(availableResult);
  if (available.state === 'unknown') {
    return { outcome: 'UNKNOWN', reason: `availability_${available.reason}` };
  }
  if (available.state === 'yes') {
    return { outcome: 'ABSENT_BUT_AVAILABLE', reason: 'extension_available_not_installed' };
  }
  return { outcome: 'ABSENT', reason: 'extension_unavailable' };
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
  if (outcome.reason === 'extension_available_not_installed') {
    return {
      text: `pgvector: the vector extension is available on the connected Postgres ` +
        `server but not yet installed in this database. Run \`CREATE EXTENSION ` +
        `vector;\` as a database superuser (see PREREQS.md) -- this checker never ` +
        `runs it for you, even under --yes.`,
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
  // git (H1: family: 'git' handles real Windows/macOS/Linux version banners)
  {
    const r = await exec('git', ['--version'], DEFAULT_TIMEOUT_MS);
    rows.push({ prereq: 'git', required: true, ...classifyProbe(r, { min: '0.0.0', family: 'git' }) });
  }
  // gh (G2, optional -- never gates)
  {
    const r = await exec('gh', ['--version'], DEFAULT_TIMEOUT_MS);
    rows.push({ prereq: 'gh', required: false, ...classifyProbe(r, { min: '0.0.0' }) });
  }
  // pg_dump (E1)
  {
    const r = await exec('pg_dump', ['--version'], DEFAULT_TIMEOUT_MS);
    rows.push({ prereq: 'pgDump', required: true, ...classifyProbe(r, { min: opts.pgDumpMin || '16.0.0', family: 'postgres' }) });
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
      // H4: read-only. Never CREATE EXTENSION. `presentR` alone decides
      // PRESENT_OK/UNKNOWN; `availableR` is only fetched (a second
      // round-trip) when `presentR` classifies 'no', to distinguish
      // ABSENT_BUT_AVAILABLE from a genuine ABSENT.
      const presentR = await exec('psql', ['-tAc', "SELECT 1 FROM pg_extension WHERE extname='vector'"], DEFAULT_TIMEOUT_MS);
      const presentState = classifyPsqlBooleanQuery(presentR);
      let availableR = null;
      if (presentState.state === 'no') {
        availableR = await exec('psql', ['-tAc', "SELECT * FROM pg_available_extensions WHERE name='vector'"], DEFAULT_TIMEOUT_MS);
      }
      const outcome = classifyPgvectorProbe(presentR, availableR);
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
  PG_VERSION_TOKEN_RE,
  GIT_VERSION_TOKEN_RE,
  VERSION_FAMILY_RULES,
  ELEVATED_PREREQS,
  REQUIRED_PREREQS_DEFAULT,
  parseVersionToken,
  compareVersion,
  classifyVersion,
  classifyProbe,
  classifyCodexFunctional,
  classifyClaudeFunctional,
  classifyPostgresRow,
  classifyPsqlBooleanQuery,
  classifyPgvectorProbe,
  assistFor,
  probeAll,
  defaultExec,
  defaultHttpProbe,
  DEFAULT_TIMEOUT_MS,
  DOCKER_INFO_TIMEOUT_MS,
};
