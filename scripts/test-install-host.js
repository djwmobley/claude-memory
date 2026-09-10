'use strict';

/**
 * test-install-host.js — codex-host-adapter (cm feat/codex-host-adapter,
 * hardened 2026-09-09 against real codex-cli 0.153.4 behavior) test suite:
 * the `--host` total classification shared by install.js and handoff.js's
 * loader-hook/loader-stop (S1), the Codex MCP registration classifier +
 * backup/add/re-verify orchestration (S2), the Codex hooks.json wiring (S3),
 * and a proof that the Claude Code install path is byte-for-byte unaffected
 * by any of it (S4/S5).
 *
 * Coverage:
 *   C1-C14  --host classification matrix (scripts/lib/host-target.js
 *           resolveHost) — every refuse case in the spec plus the accept
 *           cases, exercised directly (fast, no subprocess).
 *   D1-D2   discoverCodex(): not found (empty PATH) / found via a stub.
 *   Z1-Z17  checkHandoffRegistered() TOTAL CLASSIFICATION, exercised via the
 *           `spawnSyncImpl` test seam (deterministic, no subprocess): every
 *           branch of NOT_INSTALLED / NOT_REGISTERED / UNKNOWN / REGISTERED /
 *           NEEDS_REPAIR / REGISTERED_UNVERIFIED, including the entry-shape
 *           variants (bare object, array, `servers`/`mcp_servers` wrapper),
 *           output-hardening variants (banner line, BOM, ANSI codes), the
 *           `--json`-unsupported plain-text fallback (success AND the
 *           adversarial "not found, try codex mcp add handoff" case that
 *           must NOT read as registered), and the name-mismatch UNKNOWN case.
 *   BK1-BK3 backupConfigTomlIfPresent(): skipped when absent; created with
 *           matching content when present; two calls in the same process
 *           tick produce distinct filenames.
 *   A1-A2   registerHandoffMcp(): exact argv recorded by a real stub process;
 *           nonzero exit -> ok:false with stderr surfaced.
 *   R1      checkHandoffRegistered() against a REAL spawned stub process
 *           (sanity check that the deterministic Z-series logic also holds
 *           end-to-end through actual process spawning, not just the mock).
 *   E1-E9   End-to-end `node install.js --host codex` subprocess runs against
 *           a plain (non-worktree) copy of the engine, PATH-pointed at a
 *           STATEFUL stub `codex` (an `mcp add` durably changes what a later
 *           `mcp get` reports, simulating real config.toml persistence):
 *           not-found -> exit 2 with argv+TOML stanza printed; dry-run runs
 *           nothing but the discovery probe; absent -> real add runs with
 *           exact argv and a config.toml backup is (correctly) skipped when
 *           none exists yet; already-registered -> add skipped; stale engine
 *           path -> NEEDS_REPAIR, add re-runs, re-verified REGISTERED; add
 *           nonzero exit -> refuse exit 1 with backup path; hooks.json
 *           created fresh with the SessionStart matcher "startup|resume" and
 *           no matcher on SessionEnd; a pre-existing config.toml IS backed up
 *           before add runs; `mcp add` reports success but a post-add
 *           re-verify still can't confirm registration -> refuse exit 1.
 *   H1-H3   hooks.json merge preserves unrelated hooks; idempotent re-run
 *           (registration persists via the stateful stub, so the second run
 *           sees REGISTERED and skips add) is byte-identical with no new
 *           backup; a cross-host (`--host claude`, i.e. no --host suffix)
 *           entry found inside hooks.json is flagged unrecognizedShape and
 *           left untouched, never repointed.
 *   Q1      Engine path containing a space is double-quoted in the emitted
 *           hook commands (S3).
 *   K1-K4   CODEX_HOME: unset defaults to ~/.codex; relative -> refuse;
 *           empty -> refuse; absolute+writable -> accepted verbatim.
 *   F1      Claude path (`--host` absent) produces settings.json output
 *           byte-identical to a pre-codex-host-adapter fixture — proves S4's
 *           "byte-for-byte unchanged" requirement holds for install.js too.
 *
 * BLIND SPOTS (see PR body): the Z-series exercises the classification LOGIC
 * against synthetic {status,stdout,stderr} shapes, not a live process; the
 * stateful stub in the E/H/Q series is a hand-written Node script, verified
 * only against the documented/observed CLI shapes captured this session on
 * codex-cli 0.153.4 — a future codex-cli release could still change wording,
 * exit codes, or JSON field names in ways this suite cannot detect.
 *
 * Usage: node scripts/test-install-host.js
 * Exit 0 = all pass, 1 = any failure.
 */

const { spawnSync } = require('child_process');
const fs   = require('fs');
const os   = require('os');
const path = require('path');

const { resolveHost }             = require('./lib/host-target');
const codexInstall                = require('./lib/codex-install');

const REPO_ROOT     = path.resolve(__dirname, '..');
const COMMANDS_DIR  = path.join(REPO_ROOT, 'commands', 'handoff');
const REAL_INSTALL  = path.join(REPO_ROOT, 'scripts', 'install.js');
const REAL_LIB_DIR  = path.join(REPO_ROOT, 'scripts', 'lib');

let passed = 0;
let failed = 0;
const failures = [];

function pass(label)         { console.log(`PASS  ${label}`); passed++; }
function fail(label, reason) { console.log(`FAIL  ${label}: ${reason}`); failures.push({ label, reason }); failed++; }

// ═══════════════════════════════════════════════════════════════════════════
// C1-C14 — --host classification matrix (resolveHost, direct call)
// ═══════════════════════════════════════════════════════════════════════════

function checkHost(label, argv, expect) {
  const r = resolveHost(argv, process.env);
  if (expect.ok) {
    if (!r.ok) return fail(label, `expected ok host=${expect.host}, got refuse: ${r.reason}`);
    if (r.host !== expect.host) return fail(label, `expected host=${expect.host}, got ${r.host}`);
  } else {
    if (r.ok) return fail(label, `expected a refusal, got ok host=${r.host}`);
  }
  pass(label);
}

checkHost('C1: --host absent -> claude (default)', [], { ok: true, host: 'claude' });
checkHost('C2: --host claude -> claude', ['--host', 'claude'], { ok: true, host: 'claude' });
checkHost('C3: --host codex -> codex', ['--host', 'codex'], { ok: true, host: 'codex' });
checkHost('C4: --host= (empty inline value) -> refuse', ['--host='], { ok: false });
checkHost('C5: --host <unknown value> -> refuse', ['--host', 'Codex'], { ok: false });
checkHost('C6: --host <unknown value, different case> -> refuse (no case-folding)', ['--host', 'CODEX'], { ok: false });
checkHost('C7: bare --host at end of argv -> refuse', ['--host'], { ok: false });
checkHost('C8: --host followed by another --flag -> refuse', ['--host', '--dry-run'], { ok: false });
checkHost('C9: repeated --host, same value -> ok', ['--host', 'codex', '--host', 'codex'], { ok: true, host: 'codex' });
checkHost('C10: repeated --host, conflicting values -> refuse', ['--host', 'codex', '--host', 'claude'], { ok: false });
checkHost('C11: --host value with trailing space -> refuse (no trimming)', ['--host', 'codex '], { ok: false });
checkHost('C12: --Host (wrong case flag name) is not recognized at all -> default claude', ['--Host', 'codex'], { ok: true, host: 'claude' });
checkHost('C13: --host=codex (inline form) -> codex', ['--host=codex'], { ok: true, host: 'codex' });
checkHost('C14: --host=codex --host=claude (inline, conflicting) -> refuse', ['--host=codex', '--host=claude'], { ok: false });

// ═══════════════════════════════════════════════════════════════════════════
// codex stub — a hand-written, STATEFUL Node script, env-var-driven,
// PATH-installed. Stateful: a successful `mcp add` durably changes what a
// later `mcp get` on the same CODEX_STUB_STATE_FILE reports, simulating a
// real config.toml — required because codex-install.js's real workflow
// always re-classifies after `add` to verify it actually took.
// ═══════════════════════════════════════════════════════════════════════════

const STUB_SOURCE = `
'use strict';
const fs = require('fs');
const argv = process.argv.slice(2);
const argvFile = process.env.CODEX_STUB_ARGV_FILE;
if (argvFile) {
  try { fs.appendFileSync(argvFile, JSON.stringify(argv) + '\\n'); } catch (_) {}
}

function loadState(stateFile) {
  if (!stateFile) return { entries: {} };
  try { return JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch (_) { return { entries: {} }; }
}
function saveState(stateFile, state) {
  if (!stateFile) return;
  fs.writeFileSync(stateFile, JSON.stringify(state), 'utf8');
}

if (argv[0] === '--version') {
  const code = parseInt(process.env.CODEX_STUB_VERSION_EXIT || '0', 10);
  if (code === 0) process.stdout.write('codex-stub 0.0.0-test\\n');
  process.exit(code);
}

if (argv[0] === 'mcp' && argv[1] === 'get') {
  const name = argv[2];
  const hasJsonFlag = argv.includes('--json');
  const stateFile = process.env.CODEX_STUB_STATE_FILE;
  const state = loadState(stateFile);

  if (hasJsonFlag && process.env.CODEX_STUB_JSON_UNSUPPORTED === '1') {
    process.stderr.write(process.env.CODEX_STUB_JSON_REJECT_STDERR || "error: unexpected argument '--json' found\\n");
    process.exit(parseInt(process.env.CODEX_STUB_JSON_REJECT_EXIT || '2', 10));
  }

  const exitVar   = hasJsonFlag ? 'CODEX_STUB_GET_EXIT'   : 'CODEX_STUB_GET_PLAIN_EXIT';
  const stdoutVar = hasJsonFlag ? 'CODEX_STUB_GET_STDOUT' : 'CODEX_STUB_GET_PLAIN_STDOUT';
  const stderrVar = hasJsonFlag ? 'CODEX_STUB_GET_STDERR' : 'CODEX_STUB_GET_PLAIN_STDERR';
  const overridden = process.env[exitVar] !== undefined || process.env[stdoutVar] !== undefined || process.env[stderrVar] !== undefined;

  if (!overridden && state.entries[name]) {
    const entry = state.entries[name];
    if (hasJsonFlag) {
      process.stdout.write(JSON.stringify(entry) + '\\n');
    } else {
      process.stdout.write('name: ' + name + '\\ncommand: ' + entry.command + '\\n');
    }
    process.exit(0);
  }

  // Default (nothing overridden, no persisted state entry): simulate an
  // ABSENT registration, not a fabricated success — a test must opt IN to a
  // pre-existing registration via CODEX_STUB_STATE_FILE or an explicit
  // CODEX_STUB_GET_EXIT/STDOUT/STDERR override.
  const explicitExit = process.env[exitVar];
  const code = explicitExit !== undefined ? parseInt(explicitExit, 10) : 1;
  let out = process.env[stdoutVar];
  let err = process.env[stderrVar];
  if (out === undefined && err === undefined) {
    if (code !== 0) {
      err = "Error: No MCP server named '" + name + "' found.\\n";
    } else {
      out = JSON.stringify({ command: 'node', args: ['/default/stub/engine.mjs'] }) + '\\n';
    }
  }
  if (out) process.stdout.write(out);
  if (err) process.stderr.write(err);
  process.exit(code);
}

if (argv[0] === 'mcp' && argv[1] === 'add') {
  const name = argv[2];
  const stateFile = process.env.CODEX_STUB_STATE_FILE;
  const code = parseInt(process.env.CODEX_STUB_ADD_EXIT || '0', 10);
  const err = process.env.CODEX_STUB_ADD_STDERR || '';
  if (err) process.stderr.write(err);
  if (code === 0 && process.env.CODEX_STUB_ADD_NO_PERSIST !== '1') {
    const dashIdx = argv.indexOf('--');
    const tail = dashIdx !== -1 ? argv.slice(dashIdx + 1) : [];
    const command = tail[0];
    const args = tail.slice(1);
    const state = loadState(stateFile);
    state.entries[name] = { command, args };
    saveState(stateFile, state);
    process.stdout.write("Added global MCP server '" + name + "'.\\n");
  }
  process.exit(code);
}

process.exit(1);
`;

/** Create a PATH-installable `codex` (+ codex.cmd on win32) stub in `binDir`. */
function makeCodexStub(binDir) {
  fs.mkdirSync(binDir, { recursive: true });
  const stubJs = path.join(binDir, 'codex-stub.js');
  fs.writeFileSync(stubJs, STUB_SOURCE, 'utf8');
  if (process.platform === 'win32') {
    fs.writeFileSync(path.join(binDir, 'codex.cmd'), '@echo off\r\nnode "%~dp0codex-stub.js" %*\r\n', 'utf8');
  } else {
    const shPath = path.join(binDir, 'codex');
    fs.writeFileSync(shPath, `#!/usr/bin/env node\n${STUB_SOURCE}`, 'utf8');
    fs.chmodSync(shPath, 0o755);
  }
}

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/**
 * Restore a saved process.env value — `process.env.X = undefined` does NOT
 * delete the var; it coerces to the literal STRING "undefined" (process.env
 * values are always strings), which then leaks into every child process
 * spawned afterward. Use this in every save/mutate/restore block below.
 */
function restoreEnv(key, savedValue) {
  if (savedValue === undefined) delete process.env[key];
  else process.env[key] = savedValue;
}

// ═══════════════════════════════════════════════════════════════════════════
// D1-D2 — discoverCodex()
// ═══════════════════════════════════════════════════════════════════════════

{
  const label = 'D1: discoverCodex() with an empty PATH -> not found';
  const r = codexInstall.discoverCodex({ PATH: '' });
  if (r.found) fail(label, `expected not found, got ${JSON.stringify(r)}`);
  else pass(label);
}
{
  const label = 'D2: discoverCodex() finds a PATH-installed stub via a synchronous --version probe';
  const dir = makeTempDir('codex-stub-d2-');
  try {
    makeCodexStub(dir);
    const r = codexInstall.discoverCodex({ PATH: dir, PATHEXT: process.env.PATHEXT });
    if (!r.found) fail(label, `expected found, got ${JSON.stringify(r)}`);
    else pass(label);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
{
  const label = 'D3: HANDOFF_CODEX_BIN override bypasses PATH discovery entirely and is probed directly';
  const dir = makeTempDir('codex-stub-d3-');
  try {
    makeCodexStub(dir);
    const command = process.platform === 'win32' ? path.join(dir, 'codex.cmd') : path.join(dir, 'codex');
    // Empty PATH proves the override, not a PATH walk, found this binary.
    const r = codexInstall.discoverCodex({ PATH: '', HANDOFF_CODEX_BIN: command });
    if (!r.found || r.command !== command) fail(label, `expected found at ${command}, got ${JSON.stringify(r)}`);
    else pass(label);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
{
  const label = 'D4: HANDOFF_CODEX_BIN pointing at a nonexistent path -> not found, no fallback to PATH';
  const dir = makeTempDir('codex-stub-d4-');
  try {
    makeCodexStub(dir);
    // A WORKING codex is on PATH, but HANDOFF_CODEX_BIN points at garbage —
    // must NOT silently fall back to the PATH-found binary.
    const r = codexInstall.discoverCodex({ PATH: dir, PATHEXT: process.env.PATHEXT, HANDOFF_CODEX_BIN: path.join(dir, 'does-not-exist') });
    if (r.found) fail(label, `expected not found (override must not fall back to PATH), got ${JSON.stringify(r)}`);
    else pass(label);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
{
  const label = 'D5: HANDOFF_CODEX_BIN set to whitespace-only -> treated as unset, normal PATH discovery proceeds';
  const dir = makeTempDir('codex-stub-d5-');
  try {
    makeCodexStub(dir);
    const r = codexInstall.discoverCodex({ PATH: dir, PATHEXT: process.env.PATHEXT, HANDOFF_CODEX_BIN: '   ' });
    if (!r.found) fail(label, `expected found via normal PATH discovery, got ${JSON.stringify(r)}`);
    else pass(label);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

// ═══════════════════════════════════════════════════════════════════════════
// Z1-Z17 — checkHandoffRegistered() TOTAL CLASSIFICATION via spawnSyncImpl
// ═══════════════════════════════════════════════════════════════════════════

const ENGINE = '/abs/path/scripts/handoff-mcp.mjs';

/** Each mock result is consumed in order for each successive spawnSync call the classifier makes. */
function mockSpawn(results) {
  let i = 0;
  return function (_command, _args, _opts) {
    const r = results[Math.min(i, results.length - 1)];
    i++;
    return r;
  };
}

function classify(label, results, expectState, checkFn, enginePath) {
  const r = codexInstall.checkHandoffRegistered('codex', enginePath || ENGINE, { spawnSyncImpl: mockSpawn(results) });
  if (r.state !== expectState) {
    fail(label, `expected state ${expectState}, got ${r.state} (${r.detail})`);
    return;
  }
  if (checkFn) {
    const err = checkFn(r);
    if (err) { fail(label, err); return; }
  }
  pass(label);
}

classify('Z1: spawn error -> NOT_INSTALLED', [{ error: new Error('spawn codex ENOENT') }], 'NOT_INSTALLED');

classify('Z2: nonzero exit with the real "No MCP server named" message -> NOT_REGISTERED',
  [{ status: 1, stdout: '', stderr: "Error: No MCP server named 'handoff' found.\n" }], 'NOT_REGISTERED');

classify('Z3: nonzero exit, unrecognized error text -> UNKNOWN (never guesses)',
  [{ status: 1, stdout: '', stderr: 'boom: internal error\n' }], 'UNKNOWN');

classify('Z4: exit 0, bare object entry (no name key) matching engine path -> REGISTERED',
  [{ status: 0, stdout: JSON.stringify({ transport: { type: 'stdio' }, command: 'node', args: [ENGINE] }), stderr: '' }], 'REGISTERED');

classify('Z5: exit 0, entry command/args point at a DIFFERENT path -> NEEDS_REPAIR',
  [{ status: 0, stdout: JSON.stringify({ command: 'node', args: ['/old/stale/path/handoff-mcp.mjs'] }), stderr: '' }],
  'NEEDS_REPAIR',
  (r) => (Array.isArray(r.oldArgs) && r.oldArgs.includes('/old/stale/path/handoff-mcp.mjs')) ? null : `expected oldArgs to include the stale path, got ${JSON.stringify(r.oldArgs)}`);

classify('Z6: exit 0, array-of-servers shape, matching element found by name -> REGISTERED',
  [{ status: 0, stdout: JSON.stringify([{ name: 'other', command: 'node', args: ['/x'] }, { name: 'handoff', command: 'node', args: [ENGINE] }]), stderr: '' }],
  'REGISTERED');

classify('Z7: exit 0, {"servers": {"handoff": {...}}} wrapper shape -> REGISTERED',
  [{ status: 0, stdout: JSON.stringify({ servers: { handoff: { command: 'node', args: [ENGINE] } } }), stderr: '' }],
  'REGISTERED');

classify('Z8: exit 0, {"mcp_servers": {"handoff": {...}}} wrapper shape -> REGISTERED',
  [{ status: 0, stdout: JSON.stringify({ mcp_servers: { handoff: { command: 'node', args: [ENGINE] } } }), stderr: '' }],
  'REGISTERED');

classify('Z9: exit 0, a banner/warning line precedes the JSON -> REGISTERED (extracts the LAST JSON value)',
  [{ status: 0, stdout: 'warning: clamping SessionEnd hook timeout to 3s\n' + JSON.stringify({ command: 'node', args: [ENGINE] }), stderr: '' }],
  'REGISTERED');

classify('Z10: exit 0, UTF-8 BOM prefix on stdout -> REGISTERED',
  [{ status: 0, stdout: '﻿' + JSON.stringify({ command: 'node', args: [ENGINE] }), stderr: '' }],
  'REGISTERED');

classify('Z11: exit 0, ANSI color codes wrapping the JSON -> REGISTERED (ANSI stripped first)',
  [{ status: 0, stdout: `\x1b[32m${JSON.stringify({ command: 'node', args: [ENGINE] })}\x1b[0m`, stderr: '' }],
  'REGISTERED');

classify('Z12: not-found text on STDOUT with empty stderr -> NOT_REGISTERED (checks combined stdout+stderr)',
  [{ status: 1, stdout: "Error: No MCP server named 'handoff' found.\n", stderr: '' }],
  'NOT_REGISTERED');

classify('Z13: --json unrecognized then plain-fallback success (whole-token match, no not-found wording) -> REGISTERED_UNVERIFIED',
  [
    { status: 2, stdout: '', stderr: "error: unexpected argument '--json' found\n" },
    { status: 0, stdout: 'name: handoff\ncommand: node\n', stderr: '' },
  ],
  'REGISTERED_UNVERIFIED');

classify('Z14 (adversarial): plain fallback stdout says "not found, try codex mcp add handoff" -> must NOT be REGISTERED',
  [
    { status: 2, stdout: '', stderr: "error: unrecognized argument '--json'\n" },
    { status: 0, stdout: 'not found, try codex mcp add handoff\n', stderr: '' },
  ],
  'UNKNOWN');

classify('Z15: exit 0, entry.name explicitly disagrees with expected name -> UNKNOWN',
  [{ status: 0, stdout: JSON.stringify({ name: 'some-other-server', command: 'node', args: [ENGINE] }), stderr: '' }],
  'UNKNOWN');

classify('Z16: exit 0, JSON present but no recognizable entry shape -> UNKNOWN',
  [{ status: 0, stdout: JSON.stringify({ foo: 'bar' }), stderr: '' }],
  'UNKNOWN');

classify('Z17: exit 0, no JSON at all in stdout -> UNKNOWN',
  [{ status: 0, stdout: 'plain text, no json here\n', stderr: '' }],
  'UNKNOWN');

// ═══════════════════════════════════════════════════════════════════════════
// BK1-BK3 — backupConfigTomlIfPresent()
// ═══════════════════════════════════════════════════════════════════════════

{
  const label = 'BK1: backupConfigTomlIfPresent() with no config.toml -> skipped, no file created';
  const dir = makeTempDir('codex-home-bk1-');
  try {
    const r = codexInstall.backupConfigTomlIfPresent(dir);
    if (!r.skipped || r.backupPath !== null || !r.reason) {
      fail(label, `expected skipped:true, backupPath:null, a reason; got ${JSON.stringify(r)}`);
    } else {
      pass(label);
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

{
  const label = 'BK2: backupConfigTomlIfPresent() with an existing config.toml -> backup created with matching content';
  const dir = makeTempDir('codex-home-bk2-');
  try {
    const configPath = path.join(dir, 'config.toml');
    const content = '[mcp_servers.other]\ncommand = "node"\n';
    fs.writeFileSync(configPath, content, 'utf8');
    const r = codexInstall.backupConfigTomlIfPresent(dir);
    if (r.skipped) { fail(label, 'expected skipped:false'); return; }
    if (!fs.existsSync(r.backupPath)) { fail(label, `backup file not found at ${r.backupPath}`); return; }
    if (fs.readFileSync(r.backupPath, 'utf8') !== content) { fail(label, 'backup content does not match original'); return; }
    if (!/\.bak-\d{8}T\d{6}-\d+-\d+-\d+$/.test(r.backupPath)) {
      fail(label, `backup filename does not match the documented shape: ${r.backupPath}`);
      return;
    }
    pass(label);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

{
  const label = 'BK3: two backupConfigTomlIfPresent() calls in the same tick produce distinct filenames';
  const dir = makeTempDir('codex-home-bk3-');
  try {
    fs.writeFileSync(path.join(dir, 'config.toml'), '[mcp_servers.other]\n', 'utf8');
    const r1 = codexInstall.backupConfigTomlIfPresent(dir);
    const r2 = codexInstall.backupConfigTomlIfPresent(dir);
    if (r1.backupPath === r2.backupPath) { fail(label, `both calls produced the same backup path: ${r1.backupPath}`); return; }
    if (!fs.existsSync(r1.backupPath) || !fs.existsSync(r2.backupPath)) { fail(label, 'expected both backup files to exist'); return; }
    pass(label);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

// ═══════════════════════════════════════════════════════════════════════════
// R1 — checkHandoffRegistered() sanity check against a REAL spawned process
// ═══════════════════════════════════════════════════════════════════════════

function withStub(fn) {
  const dir = makeTempDir('codex-stub-r-');
  try {
    makeCodexStub(dir);
    const command = process.platform === 'win32' ? path.join(dir, 'codex.cmd') : path.join(dir, 'codex');
    return fn(command);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

withStub((command) => {
  const label = 'R1: checkHandoffRegistered() against a real spawned stub process -> NOT_REGISTERED (default, no state file)';
  const saved = process.env.CODEX_STUB_GET_EXIT;
  process.env.CODEX_STUB_GET_EXIT = '1';
  try {
    const r = codexInstall.checkHandoffRegistered(command, ENGINE);
    if (r.state !== 'NOT_REGISTERED') fail(label, `expected NOT_REGISTERED, got ${r.state} (${r.detail})`);
    else pass(label);
  } finally { restoreEnv('CODEX_STUB_GET_EXIT', saved); }
});

// ═══════════════════════════════════════════════════════════════════════════
// A1-A2 — registerHandoffMcp(): exact argv, and failure surfacing
// ═══════════════════════════════════════════════════════════════════════════

withStub((command) => {
  const label = 'A1: registerHandoffMcp() records the exact expected argv and succeeds on exit 0';
  const dir = makeTempDir('argv-record-a1-');
  const argvFile = path.join(dir, 'argv.log');
  const saved = process.env.CODEX_STUB_ARGV_FILE;
  process.env.CODEX_STUB_ARGV_FILE = argvFile;
  try {
    const enginePath = '/abs/path/scripts/handoff-mcp.mjs';
    const result = codexInstall.registerHandoffMcp(command, enginePath);
    const expectedArgv = ['mcp', 'add', 'handoff', '--env', 'HANDOFF_PROMOTION_FILE=AGENTS.md', '--', 'node', enginePath];
    if (!result.ok) { fail(label, `expected ok:true, got ${JSON.stringify(result)}`); return; }
    if (JSON.stringify(result.argv) !== JSON.stringify(expectedArgv)) {
      fail(label, `argv mismatch: expected ${JSON.stringify(expectedArgv)}, got ${JSON.stringify(result.argv)}`);
      return;
    }
    const recorded = JSON.parse(fs.readFileSync(argvFile, 'utf8').trim().split('\n').pop());
    if (JSON.stringify(recorded) !== JSON.stringify(expectedArgv)) {
      fail(label, `stub-recorded argv mismatch: expected ${JSON.stringify(expectedArgv)}, got ${JSON.stringify(recorded)}`);
      return;
    }
    pass(label);
  } finally {
    restoreEnv('CODEX_STUB_ARGV_FILE', saved);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

withStub((command) => {
  const label = 'A2: registerHandoffMcp() nonzero exit -> ok:false with stderr surfaced';
  const savedExit = process.env.CODEX_STUB_ADD_EXIT;
  const savedErr  = process.env.CODEX_STUB_ADD_STDERR;
  process.env.CODEX_STUB_ADD_EXIT   = '1';
  process.env.CODEX_STUB_ADD_STDERR = 'boom: server name already in use\n';
  try {
    const result = codexInstall.registerHandoffMcp(command, '/abs/engine.mjs');
    if (result.ok) { fail(label, 'expected ok:false'); return; }
    if (!/boom/.test(result.stderr)) { fail(label, `expected stderr to surface the child's stderr, got: ${result.stderr}`); return; }
    pass(label);
  } finally {
    restoreEnv('CODEX_STUB_ADD_EXIT', savedExit);
    restoreEnv('CODEX_STUB_ADD_STDERR', savedErr);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// QW1-QW10 — classifyAndQuoteWin32()/needsCmdShell(): pure, platform-
// independent unit coverage of the shell-quoting/classification internals
// (PR #276 review finding: a real spawned `codex mcp add` with an argument
// containing "&" but no whitespace was passed UNQUOTED under the old
// conditional-quoting scheme and cmd.exe executed the remainder as a second
// command). These are pure string functions with no OS calls, so they are
// exercised directly regardless of the CURRENT process.platform.
// ═══════════════════════════════════════════════════════════════════════════

function quoteOk(label, input, checkFn) {
  const r = codexInstall.classifyAndQuoteWin32(input);
  if (!r.ok) { fail(label, `expected ok:true (a safe quoting), got refusal: ${r.reason}`); return; }
  if (checkFn) {
    const err = checkFn(r.quoted);
    if (err) { fail(label, err); return; }
  }
  pass(label);
}

function quoteRefused(label, input) {
  const r = codexInstall.classifyAndQuoteWin32(input);
  if (r.ok) { fail(label, `expected a refusal, got ok:true quoted=${JSON.stringify(r.quoted)}`); return; }
  pass(label);
}

quoteOk('QW1: classifyAndQuoteWin32("a&b") quotes successfully — "&" is safe once inside quotes', 'a&b',
  (q) => (q === '"a&b"') ? null : `expected "a&b" (quoted verbatim), got ${JSON.stringify(q)}`);
quoteOk('QW2: classifyAndQuoteWin32("a|b") quotes successfully — "|" is safe once inside quotes', 'a|b',
  (q) => (q === '"a|b"') ? null : `expected "a|b", got ${JSON.stringify(q)}`);
quoteOk('QW3: classifyAndQuoteWin32("a^b") quotes successfully — "^" is safe once inside quotes', 'a^b',
  (q) => (q === '"a^b"') ? null : `expected "a^b", got ${JSON.stringify(q)}`);
quoteOk('QW4: classifyAndQuoteWin32("x(y)") quotes successfully — "(", ")" are safe once inside quotes', 'x(y)',
  (q) => (q === '"x(y)"') ? null : `expected "x(y)", got ${JSON.stringify(q)}`);
quoteOk('QW5: classifyAndQuoteWin32("a<b>c") quotes successfully — "<", ">" are safe once inside quotes', 'a<b>c',
  (q) => (q === '"a<b>c"') ? null : `expected "a<b>c", got ${JSON.stringify(q)}`);
quoteOk('QW6: classifyAndQuoteWin32("a b") quotes an argument with no special chars UNCONDITIONALLY (not just when it "needs" it)', 'a b',
  (q) => (q === '"a b"') ? null : `expected "a b", got ${JSON.stringify(q)}`);
quoteOk('QW7: classifyAndQuoteWin32(\'a"b\') doubles the preceding backslash count and escapes the embedded quote', 'a"b',
  (q) => (q === '"a\\"b"') ? null : `expected "a\\"b" (as a JS string: a\\"b wrapped in quotes), got ${JSON.stringify(q)}`);
quoteRefused('QW8: classifyAndQuoteWin32("a%TEMP%b") is REFUSED — cmd.exe expands %VAR% even inside quotes', 'a%TEMP%b');
quoteRefused('QW9: classifyAndQuoteWin32("a!VAR!b") is REFUSED — cmd.exe expands !VAR! under delayed expansion even inside quotes', 'a!VAR!b');
quoteRefused('QW10: classifyAndQuoteWin32("a\\nb") (embedded newline) is REFUSED', 'a\nb');

{
  const label = 'QW11: needsCmdShell(".cmd"/".bat") is true ONLY on win32; ".exe" and extensionless are always false';
  const isWin = process.platform === 'win32';
  const cases = [
    ['C:/dev/codex.cmd', isWin],
    ['C:/dev/codex.CMD', isWin], // case-insensitive extension match
    ['C:/dev/codex.bat', isWin],
    ['/usr/local/bin/codex', false],
    ['C:/dev/codex.exe', false],
  ];
  let ok = true;
  for (const [input, expected] of cases) {
    const got = codexInstall.needsCmdShell(input);
    if (got !== expected) { ok = false; fail(label, `needsCmdShell(${JSON.stringify(input)}) expected ${expected}, got ${got}`); break; }
  }
  if (ok) pass(label);
}

// ═══════════════════════════════════════════════════════════════════════════
// INJ1-INJ5 — end-to-end shell-injection-safety proof via a REAL spawned
// stub process: an engine path containing shell metacharacters must reach
// the child as ONE unmangled argv token, and — the actual proof, not just an
// argv-integrity check — an injected side-effect command embedded in that
// path must NEVER execute (no marker file appears). Runs through whichever
// mechanism the CURRENT platform actually uses (shell:false + argv array
// on POSIX and for a non-.cmd/.bat win32 executable; the quoted cmd.exe
// shell fallback for the .cmd stub withStub() builds on win32) — both are
// exercised for real by CI (ubuntu-latest) and by a Windows dev run.
// ═══════════════════════════════════════════════════════════════════════════

function runInjectionCase(label, buildDangerousSegment) {
  withStub((command) => {
    const dir = makeTempDir('inj-');
    const argvFile   = path.join(dir, 'argv.log');
    const markerFile = path.join(dir, 'PWNED.txt');
    const savedArgvFile = process.env.CODEX_STUB_ARGV_FILE;
    process.env.CODEX_STUB_ARGV_FILE = argvFile;
    try {
      const dangerousSegment = buildDangerousSegment(markerFile);
      // The dangerous segment does not need to exist on disk — it is never
      // opened, only passed through argv to the (stub) codex process.
      const enginePath = `${dir}${path.sep}${dangerousSegment}${path.sep}handoff-mcp.mjs`;
      const result = codexInstall.registerHandoffMcp(command, enginePath);
      if (fs.existsSync(markerFile)) {
        fail(label, `INJECTION SUCCEEDED — marker file was created at ${markerFile}`);
        return;
      }
      if (!result.ok) {
        // A refusal is an acceptable, SAFE outcome for a %/!/newline case —
        // covered independently by the QW8-QW10 pure unit tests above.
        pass(`${label} (refused safely rather than risk it: ${String(result.stderr).slice(0, 160)})`);
        return;
      }
      const lines = fs.existsSync(argvFile)
        ? fs.readFileSync(argvFile, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
        : [];
      const addCall = lines.find((a) => a[0] === 'mcp' && a[1] === 'add');
      if (!addCall) { fail(label, `no mcp add call recorded; result=${JSON.stringify(result)}`); return; }
      const gotEnginePath = addCall[addCall.length - 1];
      if (gotEnginePath !== enginePath) {
        fail(label, `argv split/mangled — expected exactly one token ${JSON.stringify(enginePath)}, got ${JSON.stringify(gotEnginePath)} (full argv: ${JSON.stringify(addCall)})`);
        return;
      }
      pass(label);
    } finally {
      restoreEnv('CODEX_STUB_ARGV_FILE', savedArgvFile);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}

runInjectionCase(
  'INJ1: engine path containing "a&echo INJ>marker&b" reaches the child as ONE argv token — no command injection, no marker file',
  (markerFile) => `a&echo INJ>${markerFile}&b`
);
runInjectionCase(
  'INJ2: engine path containing "a|whoami|b" reaches the child as ONE argv token — no pipe injection, no marker file',
  (markerFile) => `a|whoami>${markerFile}|b`
);
runInjectionCase(
  'INJ3: engine path containing "a^b" reaches the child as ONE argv token unmangled',
  () => 'a^b'
);
runInjectionCase(
  'INJ4: engine path containing "x(y)" reaches the child as ONE argv token unmangled',
  () => 'x(y)'
);
runInjectionCase(
  'INJ5: engine path containing a space reaches the child as ONE argv token unmangled (real-spawn re-proof alongside Q1)',
  () => 'a b'
);

// ═══════════════════════════════════════════════════════════════════════════
// K1-K4 — resolveCodexHome()
// ═══════════════════════════════════════════════════════════════════════════

{
  const label = 'K1: CODEX_HOME unset -> defaults to ~/.codex';
  const r = codexInstall.resolveCodexHome({});
  const want = path.join(os.homedir(), '.codex');
  if (!r.ok || r.dir !== want) fail(label, `expected ${want}, got ${JSON.stringify(r)}`);
  else pass(label);
}
{
  const label = 'K2: CODEX_HOME set to a relative path -> refuse';
  const r = codexInstall.resolveCodexHome({ CODEX_HOME: 'relative/codex' });
  if (r.ok) fail(label, 'expected a refusal');
  else pass(label);
}
{
  const label = 'K3: CODEX_HOME set to an empty string -> refuse';
  const r = codexInstall.resolveCodexHome({ CODEX_HOME: '' });
  if (r.ok) fail(label, 'expected a refusal');
  else pass(label);
}
{
  const label = 'K4: CODEX_HOME set to a writable absolute path -> accepted verbatim';
  const dir = makeTempDir('codex-home-k4-');
  try {
    const r = codexInstall.resolveCodexHome({ CODEX_HOME: dir });
    if (!r.ok || r.dir !== dir) fail(label, `expected ${dir}, got ${JSON.stringify(r)}`);
    else pass(label);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

// ═══════════════════════════════════════════════════════════════════════════
// E1-E9 / H1-H3 / Q1 / F1 — end-to-end `node install.js --host codex`
// (and one `--host` absent Claude-path fixture check), against a plain
// (non-worktree) copy of the engine — install.js refuses to run its real
// write path from inside a .claude/worktrees/ checkout regardless of host.
// ═══════════════════════════════════════════════════════════════════════════

function setupEngineCopy() {
  const engineRoot = makeTempDir('install-host-engine-');
  fs.mkdirSync(path.join(engineRoot, 'scripts', 'lib'), { recursive: true });
  fs.mkdirSync(path.join(engineRoot, 'commands', 'handoff'), { recursive: true });
  fs.copyFileSync(REAL_INSTALL, path.join(engineRoot, 'scripts', 'install.js'));
  for (const f of fs.readdirSync(REAL_LIB_DIR)) {
    if (f.endsWith('.js')) fs.copyFileSync(path.join(REAL_LIB_DIR, f), path.join(engineRoot, 'scripts', 'lib', f));
  }
  for (const f of fs.readdirSync(COMMANDS_DIR)) {
    if (f.endsWith('.md')) fs.copyFileSync(path.join(COMMANDS_DIR, f), path.join(engineRoot, 'commands', 'handoff', f));
  }
  return { engineRoot, installScript: path.join(engineRoot, 'scripts', 'install.js') };
}

/** The exact MCP engine path install.js will compute for a given engineRoot copy. */
function expectedMcpEnginePath(engineRoot) {
  return path.join(engineRoot, 'scripts', 'handoff-mcp.mjs');
}

/** Run the copied install.js with a controlled PATH (codex stub dir optional), CODEX_HOME, HOME. */
function runInstall({ installScript, args, stubDir, codexHome, homeDir, extraEnv }) {
  const pathParts = [];
  if (stubDir) pathParts.push(stubDir);
  pathParts.push(process.env.PATH || process.env.Path || '');
  const env = {
    ...process.env,
    PATH: pathParts.join(path.delimiter),
    HOME: homeDir,
    USERPROFILE: homeDir,
    ...(codexHome !== undefined ? { CODEX_HOME: codexHome } : {}),
    ...extraEnv,
  };
  return spawnSync(process.execPath, [installScript, ...args], { cwd: homeDir, env, encoding: 'utf8', timeout: 15000 });
}

{
  const label = 'E1: codex not found (no stub on PATH) -> exit 2, argv + TOML stanza printed';
  const { installScript } = setupEngineCopy();
  const homeDir = makeTempDir('install-host-e1-home-');
  try {
    // An empty directory as the ONLY PATH entry guarantees no real `codex` is found.
    const emptyPathDir = makeTempDir('install-host-e1-emptypath-');
    const r = runInstall({ installScript, args: ['--host', 'codex', '--dry-run'], stubDir: null, homeDir, extraEnv: { PATH: emptyPathDir, Path: emptyPathDir } });
    if (r.status !== 2) { fail(label, `expected exit 2, got ${r.status}; stderr: ${(r.stderr || '').slice(0, 500)}`); }
    else if (!/codex mcp add handoff/.test(r.stderr) || !/mcp_servers\.handoff/.test(r.stderr)) {
      fail(label, `expected stderr to contain the mcp add argv AND the TOML stanza; got: ${r.stderr.slice(0, 800)}`);
    } else {
      pass(label);
    }
  } finally { fs.rmSync(homeDir, { recursive: true, force: true }); }
}

{
  const label = 'E2: dry-run with codex found (absent registration) runs nothing but the discovery probe — no real add, no hooks.json write';
  const { engineRoot, installScript } = setupEngineCopy();
  const stubDir = path.join(engineRoot, '_bin');
  makeCodexStub(stubDir);
  const homeDir = makeTempDir('install-host-e2-home-');
  const codexHome = path.join(homeDir, '.codex');
  try {
    const r = runInstall({
      installScript, args: ['--host', 'codex', '--dry-run'], stubDir, codexHome, homeDir,
      extraEnv: { CODEX_STUB_GET_EXIT: '1' }, // absent
    });
    if (r.status !== 0) { fail(label, `expected exit 0, got ${r.status}; stderr: ${(r.stderr || '').slice(0, 500)}`); }
    else if (fs.existsSync(path.join(codexHome, 'hooks.json'))) {
      fail(label, 'expected hooks.json to NOT be written under --dry-run');
    } else if (!/would run: codex mcp add/.test(r.stdout)) {
      fail(label, `expected stdout to preview the mcp add command; got: ${r.stdout.slice(0, 500)}`);
    } else {
      pass(label);
    }
  } finally { fs.rmSync(homeDir, { recursive: true, force: true }); }
}

{
  const label = 'E3: absent registration -> real `codex mcp add` runs with the exact expected argv; backup correctly skipped (no config.toml yet)';
  const { engineRoot, installScript } = setupEngineCopy();
  const stubDir = path.join(engineRoot, '_bin');
  makeCodexStub(stubDir);
  const homeDir = makeTempDir('install-host-e3-home-');
  const codexHome = path.join(homeDir, '.codex');
  const argvFile = path.join(homeDir, 'argv.log');
  const stateFile = path.join(homeDir, 'codex-state.json');
  try {
    const r = runInstall({
      installScript, args: ['--host', 'codex', '--force'], stubDir, codexHome, homeDir,
      extraEnv: { CODEX_STUB_ARGV_FILE: argvFile, CODEX_STUB_STATE_FILE: stateFile },
    });
    if (r.status !== 0) { fail(label, `expected exit 0, got ${r.status}; stderr: ${(r.stderr || '').slice(0, 500)}`); return; }
    if (!/skipping backup/.test(r.stdout)) { fail(label, `expected stdout to report the skipped backup; got: ${r.stdout.slice(0, 800)}`); return; }
    const lines = fs.readFileSync(argvFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const addCall = lines.find((a) => a[0] === 'mcp' && a[1] === 'add');
    if (!addCall) { fail(label, `no mcp add call recorded; calls: ${JSON.stringify(lines)}`); return; }
    const enginePathArg = addCall[addCall.length - 1];
    const expected = ['mcp', 'add', 'handoff', '--env', 'HANDOFF_PROMOTION_FILE=AGENTS.md', '--', 'node', enginePathArg];
    if (JSON.stringify(addCall) !== JSON.stringify(expected)) {
      fail(label, `unexpected argv: ${JSON.stringify(addCall)}`);
      return;
    }
    if (!/handoff-mcp\.mjs$/.test(enginePathArg.replace(/\\/g, '/'))) {
      fail(label, `engine path arg does not end in handoff-mcp.mjs: ${enginePathArg}`);
      return;
    }
    if (!/registered/.test(r.stdout)) { fail(label, `expected stdout to confirm registration; got: ${r.stdout.slice(0, 500)}`); return; }
    pass(label);
  } finally { fs.rmSync(homeDir, { recursive: true, force: true }); }
}

{
  const label = 'E4: already registered (JSON entry matches this checkout) -> add is skipped';
  const { engineRoot, installScript } = setupEngineCopy();
  const stubDir = path.join(engineRoot, '_bin');
  makeCodexStub(stubDir);
  const homeDir = makeTempDir('install-host-e4-home-');
  const codexHome = path.join(homeDir, '.codex');
  const argvFile = path.join(homeDir, 'argv.log');
  const stateFile = path.join(homeDir, 'codex-state.json');
  fs.writeFileSync(stateFile, JSON.stringify({ entries: { handoff: { command: 'node', args: [expectedMcpEnginePath(engineRoot)] } } }), 'utf8');
  try {
    const r = runInstall({
      installScript, args: ['--host', 'codex', '--force'], stubDir, codexHome, homeDir,
      extraEnv: { CODEX_STUB_ARGV_FILE: argvFile, CODEX_STUB_STATE_FILE: stateFile },
    });
    if (r.status !== 0) { fail(label, `expected exit 0, got ${r.status}; stderr: ${(r.stderr || '').slice(0, 500)}`); return; }
    const lines = fs.existsSync(argvFile) ? fs.readFileSync(argvFile, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
    const addCall = lines.find((a) => a[0] === 'mcp' && a[1] === 'add');
    if (addCall) { fail(label, `expected NO mcp add call; got ${JSON.stringify(addCall)}`); return; }
    if (!/already registered/.test(r.stdout)) { fail(label, `expected stdout to report already-registered; got: ${r.stdout.slice(0, 500)}`); return; }
    pass(label);
  } finally { fs.rmSync(homeDir, { recursive: true, force: true }); }
}

{
  const label = 'E5: stale engine path (NEEDS_REPAIR) -> add re-runs and is re-verified REGISTERED afterward';
  const { engineRoot, installScript } = setupEngineCopy();
  const stubDir = path.join(engineRoot, '_bin');
  makeCodexStub(stubDir);
  const homeDir = makeTempDir('install-host-e5-home-');
  const codexHome = path.join(homeDir, '.codex');
  const argvFile = path.join(homeDir, 'argv.log');
  const stateFile = path.join(homeDir, 'codex-state.json');
  fs.writeFileSync(stateFile, JSON.stringify({ entries: { handoff: { command: 'node', args: ['/some/old/stale/checkout/scripts/handoff-mcp.mjs'] } } }), 'utf8');
  try {
    const r = runInstall({
      installScript, args: ['--host', 'codex', '--force'], stubDir, codexHome, homeDir,
      extraEnv: { CODEX_STUB_ARGV_FILE: argvFile, CODEX_STUB_STATE_FILE: stateFile },
    });
    if (r.status !== 0) { fail(label, `expected exit 0, got ${r.status}; stderr: ${(r.stderr || '').slice(0, 500)}`); return; }
    const lines = fs.readFileSync(argvFile, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const addCall = lines.find((a) => a[0] === 'mcp' && a[1] === 'add');
    if (!addCall) { fail(label, 'expected an mcp add call to repair the stale registration'); return; }
    const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    if (!state.entries.handoff || !state.entries.handoff.args.includes(expectedMcpEnginePath(engineRoot))) {
      fail(label, `expected the state file to now point at this checkout, got: ${JSON.stringify(state)}`);
      return;
    }
    pass(label);
  } finally { fs.rmSync(homeDir, { recursive: true, force: true }); }
}

{
  const label = 'E6: `codex mcp add` failing (nonzero exit) -> refuse, exit 1, backup path printed';
  const { engineRoot, installScript } = setupEngineCopy();
  const stubDir = path.join(engineRoot, '_bin');
  makeCodexStub(stubDir);
  const homeDir = makeTempDir('install-host-e6-home-');
  const codexHome = path.join(homeDir, '.codex');
  const stateFile = path.join(homeDir, 'codex-state.json');
  fs.mkdirSync(codexHome, { recursive: true });
  fs.writeFileSync(path.join(codexHome, 'config.toml'), '[mcp_servers.other]\ncommand = "node"\n', 'utf8');
  try {
    const r = runInstall({
      installScript, args: ['--host', 'codex', '--force'], stubDir, codexHome, homeDir,
      extraEnv: { CODEX_STUB_ADD_EXIT: '1', CODEX_STUB_ADD_STDERR: 'stub: add failed\n', CODEX_STUB_STATE_FILE: stateFile },
    });
    if (r.status !== 1) { fail(label, `expected exit 1, got ${r.status}; stderr: ${(r.stderr || '').slice(0, 500)}`); return; }
    if (!/add failed/.test(r.stderr)) { fail(label, `expected stderr to surface the child's failure; got: ${r.stderr.slice(0, 500)}`); return; }
    if (!/config\.toml/.test(r.stderr)) { fail(label, `expected stderr to mention the config.toml backup path; got: ${r.stderr.slice(0, 500)}`); return; }
    pass(label);
  } finally { fs.rmSync(homeDir, { recursive: true, force: true }); }
}

{
  const label = 'E7: hooks.json created fresh — SessionStart carries matcher "startup|resume", SessionEnd carries none';
  const { engineRoot, installScript } = setupEngineCopy();
  const stubDir = path.join(engineRoot, '_bin');
  makeCodexStub(stubDir);
  const homeDir = makeTempDir('install-host-e7-home-');
  const codexHome = path.join(homeDir, '.codex');
  const stateFile = path.join(homeDir, 'codex-state.json');
  try {
    const r = runInstall({
      installScript, args: ['--host', 'codex', '--force'], stubDir, codexHome, homeDir,
      extraEnv: { CODEX_STUB_STATE_FILE: stateFile },
    });
    if (r.status !== 0) { fail(label, `expected exit 0, got ${r.status}; stderr: ${(r.stderr || '').slice(0, 500)}`); return; }
    const hooksPath = path.join(codexHome, 'hooks.json');
    if (!fs.existsSync(hooksPath)) { fail(label, `hooks.json was not created at ${hooksPath}`); return; }
    const parsed = JSON.parse(fs.readFileSync(hooksPath, 'utf8'));
    const startGroup = (parsed.hooks.SessionStart || [])[0];
    const endGroup    = (parsed.hooks.SessionEnd   || [])[0];
    if (!startGroup || startGroup.matcher !== 'startup|resume') {
      fail(label, `expected SessionStart[0].matcher === 'startup|resume', got ${JSON.stringify(startGroup)}`);
      return;
    }
    if (!endGroup || endGroup.matcher !== undefined) {
      fail(label, `expected SessionEnd[0] to have NO matcher key, got ${JSON.stringify(endGroup)}`);
      return;
    }
    if (!/--host codex$/.test(startGroup.hooks[0].command) || !/--host codex$/.test(endGroup.hooks[0].command)) {
      fail(label, `expected both commands to end in --host codex, got ${startGroup.hooks[0].command} / ${endGroup.hooks[0].command}`);
      return;
    }
    pass(label);
  } finally { fs.rmSync(homeDir, { recursive: true, force: true }); }
}

{
  const label = 'E8: pre-existing config.toml IS backed up before `mcp add` runs';
  const { engineRoot, installScript } = setupEngineCopy();
  const stubDir = path.join(engineRoot, '_bin');
  makeCodexStub(stubDir);
  const homeDir = makeTempDir('install-host-e8-home-');
  const codexHome = path.join(homeDir, '.codex');
  const stateFile = path.join(homeDir, 'codex-state.json');
  fs.mkdirSync(codexHome, { recursive: true });
  const configContent = '[mcp_servers.other]\ncommand = "node"\n';
  fs.writeFileSync(path.join(codexHome, 'config.toml'), configContent, 'utf8');
  try {
    const r = runInstall({
      installScript, args: ['--host', 'codex', '--force'], stubDir, codexHome, homeDir,
      extraEnv: { CODEX_STUB_STATE_FILE: stateFile },
    });
    if (r.status !== 0) { fail(label, `expected exit 0, got ${r.status}; stderr: ${(r.stderr || '').slice(0, 500)}`); return; }
    if (!/rewrites the entire config\.toml/.test(r.stdout)) {
      fail(label, `expected the whole-file-rewrite warning; stdout: ${r.stdout.slice(0, 500)}`);
      return;
    }
    const backups = fs.readdirSync(codexHome).filter((f) => f.startsWith('config.toml.bak-'));
    if (backups.length !== 1) { fail(label, `expected exactly 1 config.toml backup, found ${backups.length}: ${JSON.stringify(backups)}`); return; }
    if (fs.readFileSync(path.join(codexHome, backups[0]), 'utf8') !== configContent) {
      fail(label, 'backup content does not match the pre-add config.toml');
      return;
    }
    pass(label);
  } finally { fs.rmSync(homeDir, { recursive: true, force: true }); }
}

{
  const label = 'E9: `mcp add` reports success but post-add re-verification still cannot confirm registration -> refuse, exit 1';
  const { engineRoot, installScript } = setupEngineCopy();
  const stubDir = path.join(engineRoot, '_bin');
  makeCodexStub(stubDir);
  const homeDir = makeTempDir('install-host-e9-home-');
  const codexHome = path.join(homeDir, '.codex');
  const stateFile = path.join(homeDir, 'codex-state.json');
  try {
    const r = runInstall({
      installScript, args: ['--host', 'codex', '--force'], stubDir, codexHome, homeDir,
      // ADD "succeeds" (exit 0) but is told not to persist — simulates a
      // `codex mcp add` that lies about success.
      extraEnv: { CODEX_STUB_ADD_EXIT: '0', CODEX_STUB_ADD_NO_PERSIST: '1', CODEX_STUB_STATE_FILE: stateFile },
    });
    if (r.status !== 1) { fail(label, `expected exit 1, got ${r.status}; stdout: ${r.stdout.slice(0, 300)}; stderr: ${(r.stderr || '').slice(0, 500)}`); return; }
    if (!/verif/i.test(r.stderr)) { fail(label, `expected stderr to mention verification failure; got: ${r.stderr.slice(0, 500)}`); return; }
    pass(label);
  } finally { fs.rmSync(homeDir, { recursive: true, force: true }); }
}

{
  const label = 'H1: hooks.json merge preserves a pre-existing unrelated hook untouched';
  const { engineRoot, installScript } = setupEngineCopy();
  const stubDir = path.join(engineRoot, '_bin');
  makeCodexStub(stubDir);
  const homeDir = makeTempDir('install-host-h1-home-');
  const codexHome = path.join(homeDir, '.codex');
  const stateFile = path.join(homeDir, 'codex-state.json');
  fs.mkdirSync(codexHome, { recursive: true });
  const hooksPath = path.join(codexHome, 'hooks.json');
  const before = { hooks: { SessionStart: [{ matcher: 'startup', hooks: [{ type: 'command', command: 'echo some-other-tool' }] }] } };
  fs.writeFileSync(hooksPath, JSON.stringify(before, null, 2) + '\n', 'utf8');
  try {
    const r = runInstall({
      installScript, args: ['--host', 'codex', '--force'], stubDir, codexHome, homeDir,
      extraEnv: { CODEX_STUB_STATE_FILE: stateFile },
    });
    if (r.status !== 0) { fail(label, `expected exit 0, got ${r.status}; stderr: ${(r.stderr || '').slice(0, 500)}`); return; }
    const after = JSON.parse(fs.readFileSync(hooksPath, 'utf8'));
    const survived = after.hooks.SessionStart.some((g) => (g.hooks || []).some((h) => h.command === 'echo some-other-tool'));
    if (!survived) { fail(label, `unrelated hook did not survive the merge: ${JSON.stringify(after)}`); return; }
    pass(label);
  } finally { fs.rmSync(homeDir, { recursive: true, force: true }); }
}

{
  const label = 'H2: idempotent re-run (registration persists via the stateful stub) is byte-identical, no new backup';
  const { engineRoot, installScript } = setupEngineCopy();
  const stubDir = path.join(engineRoot, '_bin');
  makeCodexStub(stubDir);
  const homeDir = makeTempDir('install-host-h2-home-');
  const codexHome = path.join(homeDir, '.codex');
  const stateFile = path.join(homeDir, 'codex-state.json');
  try {
    const r1 = runInstall({ installScript, args: ['--host', 'codex', '--force'], stubDir, codexHome, homeDir, extraEnv: { CODEX_STUB_STATE_FILE: stateFile } });
    if (r1.status !== 0) { fail(label, `first run: expected exit 0, got ${r1.status}; stderr: ${(r1.stderr || '').slice(0, 500)}`); return; }
    const hooksPath = path.join(codexHome, 'hooks.json');
    const firstContent = fs.readFileSync(hooksPath, 'utf8');

    // Second run reuses the SAME state file, so the stub now reports the
    // registration the first run's `mcp add` actually wrote — REGISTERED,
    // add skipped, just like a real second run against a real config.toml.
    const r2 = runInstall({ installScript, args: ['--host', 'codex', '--force'], stubDir, codexHome, homeDir, extraEnv: { CODEX_STUB_STATE_FILE: stateFile } });
    if (r2.status !== 0) { fail(label, `second run: expected exit 0, got ${r2.status}; stderr: ${(r2.stderr || '').slice(0, 500)}`); return; }
    if (!/already registered/.test(r2.stdout)) { fail(label, `expected second run to report already-registered; got: ${r2.stdout.slice(0, 500)}`); return; }
    const secondContent = fs.readFileSync(hooksPath, 'utf8');
    if (firstContent !== secondContent) { fail(label, 'hooks.json content changed on idempotent re-run'); return; }
    const backups = fs.readdirSync(codexHome).filter((f) => f.includes('.bak-'));
    if (backups.length !== 0) { fail(label, `expected zero backups on a no-op re-run, found: ${JSON.stringify(backups)}`); return; }
    pass(label);
  } finally { fs.rmSync(homeDir, { recursive: true, force: true }); }
}

{
  const label = 'H3: a cross-host entry (no --host suffix, i.e. host=claude) inside hooks.json is flagged unrecognizedShape and left untouched, never repointed';
  const { engineRoot, installScript } = setupEngineCopy();
  const stubDir = path.join(engineRoot, '_bin');
  makeCodexStub(stubDir);
  const homeDir = makeTempDir('install-host-h3-home-');
  const codexHome = path.join(homeDir, '.codex');
  const stateFile = path.join(homeDir, 'codex-state.json');
  fs.mkdirSync(codexHome, { recursive: true });
  const hooksPath = path.join(codexHome, 'hooks.json');
  const claudeStyleCmd = `node ${path.join(engineRoot, 'scripts', 'handoff.js').replace(/\\/g, '/')} loader-hook`; // no --host suffix
  const before = { hooks: { SessionStart: [{ hooks: [{ type: 'command', command: claudeStyleCmd }] }] } };
  fs.writeFileSync(hooksPath, JSON.stringify(before, null, 2) + '\n', 'utf8');
  try {
    const r = runInstall({
      installScript, args: ['--host', 'codex', '--force'], stubDir, codexHome, homeDir,
      extraEnv: { CODEX_STUB_STATE_FILE: stateFile },
    });
    if (r.status !== 0) { fail(label, `expected exit 0, got ${r.status}; stderr: ${(r.stderr || '').slice(0, 500)}`); return; }
    const after = JSON.parse(fs.readFileSync(hooksPath, 'utf8'));
    const crossHostSurvived = after.hooks.SessionStart.some((g) => (g.hooks || []).some((h) => h.command === claudeStyleCmd));
    if (!crossHostSurvived) { fail(label, `cross-host entry was repointed/removed instead of left untouched: ${JSON.stringify(after)}`); return; }
    if (!/unrecognized_shape: 1/.test(r.stdout)) { fail(label, `expected the summary to flag 1 unrecognized_shape entry; stdout: ${r.stdout.slice(0, 500)}`); return; }
    pass(label);
  } finally { fs.rmSync(homeDir, { recursive: true, force: true }); }
}

{
  const label = 'Q1: engine path containing a space is double-quoted in the emitted codex hook commands';
  const engineRoot = makeTempDir('install-host-q1-with space-');
  fs.mkdirSync(path.join(engineRoot, 'scripts', 'lib'), { recursive: true });
  fs.mkdirSync(path.join(engineRoot, 'commands', 'handoff'), { recursive: true });
  fs.copyFileSync(REAL_INSTALL, path.join(engineRoot, 'scripts', 'install.js'));
  for (const f of fs.readdirSync(REAL_LIB_DIR)) {
    if (f.endsWith('.js')) fs.copyFileSync(path.join(REAL_LIB_DIR, f), path.join(engineRoot, 'scripts', 'lib', f));
  }
  for (const f of fs.readdirSync(COMMANDS_DIR)) {
    if (f.endsWith('.md')) fs.copyFileSync(path.join(COMMANDS_DIR, f), path.join(engineRoot, 'commands', 'handoff', f));
  }
  const installScript = path.join(engineRoot, 'scripts', 'install.js');
  const stubDir = path.join(engineRoot, '_bin');
  makeCodexStub(stubDir);
  const homeDir = makeTempDir('install-host-q1-home-');
  const codexHome = path.join(homeDir, '.codex');
  const stateFile = path.join(homeDir, 'codex-state.json');
  try {
    const r = runInstall({ installScript, args: ['--host', 'codex', '--force'], stubDir, codexHome, homeDir, extraEnv: { CODEX_STUB_STATE_FILE: stateFile } });
    if (r.status !== 0) { fail(label, `expected exit 0, got ${r.status}; stderr: ${(r.stderr || '').slice(0, 500)}`); return; }
    const after = JSON.parse(fs.readFileSync(path.join(codexHome, 'hooks.json'), 'utf8'));
    const cmd = after.hooks.SessionStart[0].hooks[0].command;
    if (!/^node "/.test(cmd)) { fail(label, `expected the engine path to be double-quoted, got: ${cmd}`); return; }
    pass(label);
  } finally { fs.rmSync(homeDir, { recursive: true, force: true }); }
}

{
  const label = 'F1: Claude path (--host absent) settings.json output is unaffected by the codex-host-adapter change';
  const { installScript } = setupEngineCopy();
  const homeDir = makeTempDir('install-host-f1-home-');
  try {
    const r = runInstall({ installScript, args: ['--force', '--hooks-scope', 'user'], homeDir });
    if (r.status !== 0) { fail(label, `expected exit 0, got ${r.status}; stderr: ${(r.stderr || '').slice(0, 500)}`); return; }
    const settingsPath = path.join(homeDir, '.claude', 'settings.json');
    if (!fs.existsSync(settingsPath)) { fail(label, `settings.json not written at ${settingsPath}`); return; }
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    const startCmd = settings.hooks.SessionStart[0].hooks[0].command;
    const stopCmd  = settings.hooks.SessionEnd[0].hooks[0].command;
    if (/--host/.test(startCmd) || /--host/.test(stopCmd)) {
      fail(label, `expected NO --host suffix on the Claude path, got: ${startCmd} / ${stopCmd}`);
      return;
    }
    if (settings.hooks.SessionStart[0].matcher !== undefined) {
      fail(label, `expected no matcher on the Claude SessionStart group (unchanged behavior), got: ${JSON.stringify(settings.hooks.SessionStart[0])}`);
      return;
    }
    pass(label);
  } finally { fs.rmSync(homeDir, { recursive: true, force: true }); }
}

// ═══════════════════════════════════════════════════════════════════════════

console.log('');
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failures.length > 0) {
  console.log('Failed:', failures.map((f) => f.label).join(', '));
}
process.exit(failed > 0 ? 1 : 0);
