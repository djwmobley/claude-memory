'use strict';

/**
 * test-install-host.js — codex-host-adapter (cm feat/codex-host-adapter)
 * test suite: the `--host` total classification shared by install.js and
 * handoff.js's loader-hook/loader-stop (S1), the Codex MCP registration
 * shell-out (S2), the Codex hooks.json wiring (S3), and a proof that the
 * Claude Code install path is byte-for-byte unaffected by any of it (S4/S5).
 *
 * Coverage:
 *   C1-C11  --host classification matrix (scripts/lib/host-target.js
 *           resolveHost) — every refuse case in the spec plus the accept
 *           cases, exercised directly (fast, no subprocess).
 *   D1-D2   discoverCodex(): not found (empty PATH) / found via a stub.
 *   R1-R4   checkHandoffRegistered(): nonzero exit -> absent; zero exit +
 *           "handoff" whole token -> registered; zero exit + "handoff-dev"
 *           (NOT a whole-token match) -> absent; zero exit, no token -> absent.
 *   A1-A2   registerHandoffMcp(): exact argv recorded by the stub; nonzero
 *           exit -> ok:false with stderr surfaced.
 *   E1-E7   End-to-end `node install.js --host codex` subprocess runs against
 *           a plain (non-worktree) copy of the engine, PATH-pointed at a
 *           stub `codex`: not-found -> exit 2 with argv+TOML stanza printed;
 *           dry-run runs nothing but the discovery probe (no mcp add, no
 *           hooks.json write); absent -> real add runs with exact argv;
 *           already-registered ("handoff" token) -> add skipped; "handoff-dev"
 *           token -> add still runs (not a whole-token match); add nonzero ->
 *           refuse exit 2; hooks.json created fresh with the SessionStart
 *           matcher "startup|resume" and no matcher on SessionEnd.
 *   H1-H3   hooks.json merge preserves unrelated hooks; idempotent re-run is
 *           byte-identical with no new backup; a cross-host (`--host claude`,
 *           i.e. no --host suffix) entry found inside hooks.json is flagged
 *           unrecognizedShape and left untouched, never repointed.
 *   Q1      Engine path containing a space is double-quoted in the emitted
 *           hook commands (S3).
 *   K1-K3   CODEX_HOME: unset defaults to ~/.codex; relative -> refuse;
 *           empty -> refuse.
 *   F1      Claude path (`--host` absent) produces settings.json output
 *           byte-identical to a pre-codex-host-adapter fixture — proves S4's
 *           "byte-for-byte unchanged" requirement holds for install.js too.
 *
 * BLIND SPOTS (see PR body): the `codex` stub here is a hand-written Node
 * script driven by env vars, verified only against the documented CLI shape
 * (codex mcp add/get argv, exit-code conventions) — never against the real
 * `codex` binary, which is not installed on the authoring machine.
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
// C1-C11 — --host classification matrix (resolveHost, direct call)
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
// codex stub — a hand-written Node script, env-var-driven, PATH-installed
// ═══════════════════════════════════════════════════════════════════════════

const STUB_SOURCE = `
'use strict';
const fs = require('fs');
const argv = process.argv.slice(2);
const argvFile = process.env.CODEX_STUB_ARGV_FILE;
if (argvFile) {
  try { fs.appendFileSync(argvFile, JSON.stringify(argv) + '\\n'); } catch (_) {}
}
if (argv[0] === '--version') {
  const code = parseInt(process.env.CODEX_STUB_VERSION_EXIT || '0', 10);
  if (code === 0) process.stdout.write('codex-stub 0.0.0-test\\n');
  process.exit(code);
}
if (argv[0] === 'mcp' && argv[1] === 'get') {
  const code = parseInt(process.env.CODEX_STUB_GET_EXIT || '0', 10);
  const out = process.env.CODEX_STUB_GET_STDOUT || '';
  if (out) process.stdout.write(out);
  process.exit(code);
}
if (argv[0] === 'mcp' && argv[1] === 'add') {
  const code = parseInt(process.env.CODEX_STUB_ADD_EXIT || '0', 10);
  const err = process.env.CODEX_STUB_ADD_STDERR || '';
  if (err) process.stderr.write(err);
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

// ═══════════════════════════════════════════════════════════════════════════
// R1-R4 — checkHandoffRegistered() total classification
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
  const label = 'R1: `codex mcp get handoff` nonzero exit -> not registered';
  const saved = process.env.CODEX_STUB_GET_EXIT;
  process.env.CODEX_STUB_GET_EXIT = '1';
  try {
    const r = codexInstall.checkHandoffRegistered(command);
    if (r.registered) fail(label, `expected not registered, got ${JSON.stringify(r)}`);
    else pass(label);
  } finally { restoreEnv('CODEX_STUB_GET_EXIT', saved); }
});

withStub((command) => {
  const label = 'R2: zero exit, stdout contains "handoff" as a whole token -> registered';
  const savedExit = process.env.CODEX_STUB_GET_EXIT;
  const savedOut  = process.env.CODEX_STUB_GET_STDOUT;
  process.env.CODEX_STUB_GET_EXIT   = '0';
  process.env.CODEX_STUB_GET_STDOUT = 'name: handoff\ncommand: node\n';
  try {
    const r = codexInstall.checkHandoffRegistered(command);
    if (!r.registered) fail(label, `expected registered, got ${JSON.stringify(r)}`);
    else pass(label);
  } finally {
    restoreEnv('CODEX_STUB_GET_EXIT', savedExit);
    restoreEnv('CODEX_STUB_GET_STDOUT', savedOut);
  }
});

withStub((command) => {
  const label = 'R3: zero exit, stdout contains "handoff-dev" (NOT a whole token) -> not registered';
  const savedExit = process.env.CODEX_STUB_GET_EXIT;
  const savedOut  = process.env.CODEX_STUB_GET_STDOUT;
  process.env.CODEX_STUB_GET_EXIT   = '0';
  process.env.CODEX_STUB_GET_STDOUT = 'name: handoff-dev\n';
  try {
    const r = codexInstall.checkHandoffRegistered(command);
    if (r.registered) fail(label, `expected not registered (handoff-dev must not match), got ${JSON.stringify(r)}`);
    else pass(label);
  } finally {
    restoreEnv('CODEX_STUB_GET_EXIT', savedExit);
    restoreEnv('CODEX_STUB_GET_STDOUT', savedOut);
  }
});

withStub((command) => {
  const label = 'R4: zero exit, stdout has no "handoff" token at all -> not registered';
  const savedExit = process.env.CODEX_STUB_GET_EXIT;
  const savedOut  = process.env.CODEX_STUB_GET_STDOUT;
  process.env.CODEX_STUB_GET_EXIT   = '0';
  process.env.CODEX_STUB_GET_STDOUT = 'name: some-other-server\n';
  try {
    const r = codexInstall.checkHandoffRegistered(command);
    if (r.registered) fail(label, `expected not registered, got ${JSON.stringify(r)}`);
    else pass(label);
  } finally {
    restoreEnv('CODEX_STUB_GET_EXIT', savedExit);
    restoreEnv('CODEX_STUB_GET_STDOUT', savedOut);
  }
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
// K1-K3 — resolveCodexHome()
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
// E1-E7 / H1-H3 / Q1 / F1 — end-to-end `node install.js --host codex`
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
  const label = 'E3: absent registration -> real `codex mcp add` runs with the exact expected argv';
  const { engineRoot, installScript } = setupEngineCopy();
  const stubDir = path.join(engineRoot, '_bin');
  makeCodexStub(stubDir);
  const homeDir = makeTempDir('install-host-e3-home-');
  const codexHome = path.join(homeDir, '.codex');
  const argvFile = path.join(homeDir, 'argv.log');
  try {
    const r = runInstall({
      installScript, args: ['--host', 'codex', '--force'], stubDir, codexHome, homeDir,
      extraEnv: { CODEX_STUB_GET_EXIT: '1', CODEX_STUB_ARGV_FILE: argvFile },
    });
    if (r.status !== 0) { fail(label, `expected exit 0, got ${r.status}; stderr: ${(r.stderr || '').slice(0, 500)}`); return; }
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
    pass(label);
  } finally { fs.rmSync(homeDir, { recursive: true, force: true }); }
}

{
  const label = 'E4: already registered ("handoff" whole-token match) -> add is skipped';
  const { engineRoot, installScript } = setupEngineCopy();
  const stubDir = path.join(engineRoot, '_bin');
  makeCodexStub(stubDir);
  const homeDir = makeTempDir('install-host-e4-home-');
  const codexHome = path.join(homeDir, '.codex');
  const argvFile = path.join(homeDir, 'argv.log');
  try {
    const r = runInstall({
      installScript, args: ['--host', 'codex', '--force'], stubDir, codexHome, homeDir,
      extraEnv: { CODEX_STUB_GET_EXIT: '0', CODEX_STUB_GET_STDOUT: 'name: handoff\n', CODEX_STUB_ARGV_FILE: argvFile },
    });
    if (r.status !== 0) { fail(label, `expected exit 0, got ${r.status}; stderr: ${(r.stderr || '').slice(0, 500)}`); return; }
    const lines = fs.readFileSync(argvFile, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const addCall = lines.find((a) => a[0] === 'mcp' && a[1] === 'add');
    if (addCall) { fail(label, `expected NO mcp add call; got ${JSON.stringify(addCall)}`); return; }
    if (!/already registered/.test(r.stdout)) { fail(label, `expected stdout to report already-registered; got: ${r.stdout.slice(0, 500)}`); return; }
    pass(label);
  } finally { fs.rmSync(homeDir, { recursive: true, force: true }); }
}

{
  const label = 'E5: "handoff-dev" (NOT a whole-token match) -> add still runs';
  const { engineRoot, installScript } = setupEngineCopy();
  const stubDir = path.join(engineRoot, '_bin');
  makeCodexStub(stubDir);
  const homeDir = makeTempDir('install-host-e5-home-');
  const codexHome = path.join(homeDir, '.codex');
  const argvFile = path.join(homeDir, 'argv.log');
  try {
    const r = runInstall({
      installScript, args: ['--host', 'codex', '--force'], stubDir, codexHome, homeDir,
      extraEnv: { CODEX_STUB_GET_EXIT: '0', CODEX_STUB_GET_STDOUT: 'name: handoff-dev\n', CODEX_STUB_ARGV_FILE: argvFile },
    });
    if (r.status !== 0) { fail(label, `expected exit 0, got ${r.status}; stderr: ${(r.stderr || '').slice(0, 500)}`); return; }
    const lines = fs.readFileSync(argvFile, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const addCall = lines.find((a) => a[0] === 'mcp' && a[1] === 'add');
    if (!addCall) { fail(label, 'expected an mcp add call (handoff-dev must not count as already-registered)'); return; }
    pass(label);
  } finally { fs.rmSync(homeDir, { recursive: true, force: true }); }
}

{
  const label = 'E6: `codex mcp add` failing (nonzero exit) -> refuse, exit 2';
  const { engineRoot, installScript } = setupEngineCopy();
  const stubDir = path.join(engineRoot, '_bin');
  makeCodexStub(stubDir);
  const homeDir = makeTempDir('install-host-e6-home-');
  const codexHome = path.join(homeDir, '.codex');
  try {
    const r = runInstall({
      installScript, args: ['--host', 'codex', '--force'], stubDir, codexHome, homeDir,
      extraEnv: { CODEX_STUB_GET_EXIT: '1', CODEX_STUB_ADD_EXIT: '1', CODEX_STUB_ADD_STDERR: 'stub: add failed\n' },
    });
    if (r.status !== 2) { fail(label, `expected exit 2, got ${r.status}`); return; }
    if (!/add failed/.test(r.stderr)) { fail(label, `expected stderr to surface the child's failure; got: ${r.stderr.slice(0, 500)}`); return; }
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
  try {
    const r = runInstall({
      installScript, args: ['--host', 'codex', '--force'], stubDir, codexHome, homeDir,
      extraEnv: { CODEX_STUB_GET_EXIT: '1' },
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
  const label = 'H1: hooks.json merge preserves a pre-existing unrelated hook untouched';
  const { engineRoot, installScript } = setupEngineCopy();
  const stubDir = path.join(engineRoot, '_bin');
  makeCodexStub(stubDir);
  const homeDir = makeTempDir('install-host-h1-home-');
  const codexHome = path.join(homeDir, '.codex');
  fs.mkdirSync(codexHome, { recursive: true });
  const hooksPath = path.join(codexHome, 'hooks.json');
  const before = { hooks: { SessionStart: [{ matcher: 'startup', hooks: [{ type: 'command', command: 'echo some-other-tool' }] }] } };
  fs.writeFileSync(hooksPath, JSON.stringify(before, null, 2) + '\n', 'utf8');
  try {
    const r = runInstall({
      installScript, args: ['--host', 'codex', '--force'], stubDir, codexHome, homeDir,
      extraEnv: { CODEX_STUB_GET_EXIT: '1' },
    });
    if (r.status !== 0) { fail(label, `expected exit 0, got ${r.status}; stderr: ${(r.stderr || '').slice(0, 500)}`); return; }
    const after = JSON.parse(fs.readFileSync(hooksPath, 'utf8'));
    const survived = after.hooks.SessionStart.some((g) => (g.hooks || []).some((h) => h.command === 'echo some-other-tool'));
    if (!survived) { fail(label, `unrelated hook did not survive the merge: ${JSON.stringify(after)}`); return; }
    pass(label);
  } finally { fs.rmSync(homeDir, { recursive: true, force: true }); }
}

{
  const label = 'H2: idempotent re-run is byte-identical, no new backup';
  const { engineRoot, installScript } = setupEngineCopy();
  const stubDir = path.join(engineRoot, '_bin');
  makeCodexStub(stubDir);
  const homeDir = makeTempDir('install-host-h2-home-');
  const codexHome = path.join(homeDir, '.codex');
  try {
    const r1 = runInstall({ installScript, args: ['--host', 'codex', '--force'], stubDir, codexHome, homeDir, extraEnv: { CODEX_STUB_GET_EXIT: '1' } });
    if (r1.status !== 0) { fail(label, `first run: expected exit 0, got ${r1.status}; stderr: ${(r1.stderr || '').slice(0, 500)}`); return; }
    const hooksPath = path.join(codexHome, 'hooks.json');
    const firstContent = fs.readFileSync(hooksPath, 'utf8');

    const r2 = runInstall({ installScript, args: ['--host', 'codex', '--force'], stubDir, codexHome, homeDir, extraEnv: { CODEX_STUB_GET_EXIT: '0', CODEX_STUB_GET_STDOUT: 'name: handoff\n' } });
    if (r2.status !== 0) { fail(label, `second run: expected exit 0, got ${r2.status}; stderr: ${(r2.stderr || '').slice(0, 500)}`); return; }
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
  fs.mkdirSync(codexHome, { recursive: true });
  const hooksPath = path.join(codexHome, 'hooks.json');
  const claudeStyleCmd = `node ${path.join(engineRoot, 'scripts', 'handoff.js').replace(/\\/g, '/')} loader-hook`; // no --host suffix
  const before = { hooks: { SessionStart: [{ hooks: [{ type: 'command', command: claudeStyleCmd }] }] } };
  fs.writeFileSync(hooksPath, JSON.stringify(before, null, 2) + '\n', 'utf8');
  try {
    const r = runInstall({
      installScript, args: ['--host', 'codex', '--force'], stubDir, codexHome, homeDir,
      extraEnv: { CODEX_STUB_GET_EXIT: '1' },
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
  try {
    const r = runInstall({ installScript, args: ['--host', 'codex', '--force'], stubDir, codexHome, homeDir, extraEnv: { CODEX_STUB_GET_EXIT: '1' } });
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
