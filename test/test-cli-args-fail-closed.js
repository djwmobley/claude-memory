'use strict';

/**
 * test-cli-args-fail-closed.js — total-classification CLI argument tests
 * (spec A1-A4, incident 2026-09-07: `close --help` was silently ignored as
 * an unrecognized flag, ran a real extraction-empty close, and cleared the
 * session marker — a write command silently ignoring an unknown argument is
 * an allow-list failure mode).
 *
 * Covers, for every write subcommand declared in scripts/lib/cli-args.js:
 *   - an unknown flag exits 2 and attempts NO DB connection (the argv gate
 *     in main() runs before subcommands[sub]() is ever invoked, so this
 *     holds regardless of what any individual command's own body does);
 *   - --help / -h exits 0, prints usage, and attempts NO DB connection;
 * plus the A3 empty-stdin / empty-payload guards specific to close and
 * checkpoint, and a check that loader-stop (the legitimate SessionEnd
 * implicit-close caller) is untouched by any of this — it never goes
 * through cmdClose's argv path at all.
 *
 * No live Postgres is required: every reject case is asserted to happen
 * BEFORE connectHandoff() is ever called, using a scratch PROJECT_ROOT with
 * no .claude/pipeline.yml at all (so if a connection were ever attempted,
 * connectHandoff's own catch block would print its distinctive
 * "DB connection failed: ..." line -- its absence is the proof).
 *
 * Usage: node test/test-cli-args-fail-closed.js
 * Exit 0 = all pass; nonzero = any failure.
 */

const { spawnSync } = require('child_process');
const fs   = require('fs');
const os   = require('os');
const path = require('path');

const PROJECT_ROOT   = path.resolve(__dirname, '..');
const HANDOFF_SCRIPT = path.join(PROJECT_ROOT, 'scripts', 'handoff.js');
const { WRITE_SUBCOMMANDS } = require(path.join(PROJECT_ROOT, 'scripts', 'lib', 'cli-args.js'));

let passed = 0, failed = 0;
const failures = [];
function test(label, fn) {
  try {
    fn();
    console.log(`  [PASS] ${label}`);
    passed++;
  } catch (err) {
    console.error(`  [FAIL] ${label}: ${err.message}`);
    failures.push({ label, err });
    failed++;
  }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }

// ── Fixture: scratch project root with NO DB config at all ──────────────────
function makeScratchRoot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'handoff-cli-args-'));
  fs.mkdirSync(path.join(dir, '.git'));
  // Deliberately no .claude/pipeline.yml -- these tests never need a real
  // DB connection to succeed; they need one to NEVER be attempted.
  return dir;
}

function runCli(args, { input } = {}) {
  const root = makeScratchRoot();
  return spawnSync(process.execPath, [HANDOFF_SCRIPT, ...args], {
    cwd: root,
    env: Object.assign({}, process.env, { PROJECT_ROOT: root }),
    input: input !== undefined ? input : '',
    encoding: 'utf8',
    timeout: 15000,
  });
}

const CONNECTION_MARKER = 'DB connection failed';
const SUCCESS_MARKER    = /^Done: handoff:/m;

function assertNoConnectionAttempted(r, label) {
  const combined = `${r.stdout || ''}${r.stderr || ''}`;
  assert(!combined.includes(CONNECTION_MARKER),
    `${label}: expected NO DB connection attempt, but saw "${CONNECTION_MARKER}" in output: ${combined.slice(0, 300)}`);
  assert(!SUCCESS_MARKER.test(combined),
    `${label}: expected NO successful write, but saw a "Done: handoff:..." line: ${combined.slice(0, 300)}`);
}

// ── A1: unknown flag -> exit 2, no DB connection, for every write subcommand ─
for (const cmd of WRITE_SUBCOMMANDS) {
  test(`${cmd} --totally-bogus-flag exits 2 with no DB connection attempted`, () => {
    const r = runCli([cmd, '--totally-bogus-flag']);
    assert(r.status === 2, `expected exit 2, got ${r.status} (stderr: ${(r.stderr || '').slice(0, 300)})`);
    assert(
      r.stderr.includes(`unknown argument "--totally-bogus-flag" for ${cmd}; run "handoff.js ${cmd} --help"`),
      `expected the exact rejection message, got: ${r.stderr}`
    );
    assertNoConnectionAttempted(r, cmd);
  });
}

// ── A2: --help / -h -> exit 0, usage printed, no DB connection ──────────────
for (const cmd of WRITE_SUBCOMMANDS) {
  test(`${cmd} --help exits 0 with usage and no DB connection attempted`, () => {
    const r = runCli([cmd, '--help']);
    assert(r.status === 0, `expected exit 0, got ${r.status} (stderr: ${(r.stderr || '').slice(0, 300)})`);
    assert(r.stdout.includes(`Usage: node scripts/handoff.js ${cmd}`), `expected usage text, got: ${r.stdout}`);
    assertNoConnectionAttempted(r, `${cmd} --help`);
  });
  test(`${cmd} -h exits 0 with no DB connection attempted`, () => {
    const r = runCli([cmd, '-h']);
    assert(r.status === 0, `expected exit 0, got ${r.status}`);
    assertNoConnectionAttempted(r, `${cmd} -h`);
  });
}

// ── A1 regression: the EXACT incident shape ──────────────────────────────────
test('close --help (the incident shape) exits 0 and writes nothing', () => {
  const r = runCli(['close', '--help']);
  assert(r.status === 0, `expected exit 0, got ${r.status} (stderr: ${(r.stderr || '').slice(0, 300)})`);
  assertNoConnectionAttempted(r, 'close --help');
});

// ── A1: dispatch-level flags that a command's own body never sees (e.g.
// drop is called as cmdDrop() with no args forwarded) are still classified —
// the gate runs on argv before the subcommand function is invoked at all.
test('drop --whatever exits 2 with no DB connection attempted (drop ignores its own argv)', () => {
  const r = runCli(['drop', '--whatever']);
  assert(r.status === 2, `expected exit 2, got ${r.status}`);
  assertNoConnectionAttempted(r, 'drop --whatever');
});

// ── A3: close/checkpoint --json - with empty stdin -> exit 2, no write ──────
test('close --json - with empty stdin exits 2 and writes nothing', () => {
  const r = runCli(['close', '--json', '-'], { input: '' });
  assert(r.status === 2, `expected exit 2, got ${r.status} (stderr: ${(r.stderr || '').slice(0, 300)})`);
  assert(r.stderr.includes('--json - requires a payload on stdin'), `expected empty-stdin rejection, got: ${r.stderr}`);
  assertNoConnectionAttempted(r, 'close --json - (empty stdin)');
});
test('checkpoint --json - with empty stdin exits 2 and writes nothing', () => {
  const r = runCli(['checkpoint', '--json', '-'], { input: '' });
  assert(r.status === 2, `expected exit 2, got ${r.status} (stderr: ${(r.stderr || '').slice(0, 300)})`);
  assert(r.stderr.includes('--json - requires a payload on stdin'), `expected empty-stdin rejection, got: ${r.stderr}`);
  assertNoConnectionAttempted(r, 'checkpoint --json - (empty stdin)');
});

// ── A3: bare close / checkpoint (no --json, no --note, no --allow-empty) ────
// is the OTHER shape of the same bug class (payload silently stays {}); now
// rejected up front rather than proceeding as a real extraction-empty write.
test('bare close (no flags at all) exits 2 and writes nothing', () => {
  const r = runCli(['close']);
  assert(r.status === 2, `expected exit 2, got ${r.status} (stderr: ${(r.stderr || '').slice(0, 300)})`);
  assertNoConnectionAttempted(r, 'bare close');
});
test('bare checkpoint (no flags at all) exits 2 and writes nothing', () => {
  const r = runCli(['checkpoint']);
  assert(r.status === 2, `expected exit 2, got ${r.status} (stderr: ${(r.stderr || '').slice(0, 300)})`);
  assertNoConnectionAttempted(r, 'bare checkpoint');
});

// ── A3: --allow-empty is honored as an explicit opt-in -- it must NOT be
// blocked by the empty-payload guard; it should proceed PAST argument
// validation to the point of attempting a DB connection (which then fails
// against the scratch root's unconfigured DB, proving the opt-in worked and
// the code reached exactly as far as it did before this change).
test('close --allow-empty (no --json) proceeds past the empty-payload guard to a DB connection attempt', () => {
  const r = runCli(['close', '--allow-empty']);
  assert(r.status !== 2 || !r.stderr.includes('requires a payload on stdin'),
    `--allow-empty must not be rejected by the empty-payload guard; got status ${r.status}, stderr: ${r.stderr}`);
  assert(!r.stderr.includes('close requires --json'),
    `--allow-empty must bypass the "close requires --json" guard; stderr: ${r.stderr}`);
  const combined = `${r.stdout || ''}${r.stderr || ''}`;
  assert(combined.includes(CONNECTION_MARKER),
    `--allow-empty should reach connectHandoff() (and fail there, since this scratch root has no DB config) -- got: ${combined.slice(0, 300)}`);
});

// ── A4: loader-stop (SessionEnd implicit-close) is untouched by this gate ───
// loader-stop is intentionally NOT declared in scripts/lib/cli-args.js
// SPECS -- it never goes through cmdClose/readStdin's argv path at all (it
// calls writeImplicitClose() directly). Confirmed structurally here (no
// live-DB dependency needed for this specific invariant): the shared
// classifier must be a no-op for a subcommand it doesn't recognize.
test('loader-stop is not gated by scripts/lib/cli-args.js (writeImplicitClose path is separate from cmdClose)', () => {
  const { enforceTotalClassification, SPECS } = require(path.join(PROJECT_ROOT, 'scripts', 'lib', 'cli-args.js'));
  assert(!('loader-stop' in SPECS), 'loader-stop must not be declared as a gated write subcommand -- it is the legitimate empty-close caller');
  // Must not throw or call process.exit for arbitrary argv, since main()
  // never forwards argv to loader-stop's dispatch entry anyway.
  let threw = false;
  try { enforceTotalClassification('loader-stop', ['--anything', 'goes']); } catch (_) { threw = true; }
  assert(!threw, 'enforceTotalClassification must no-op for subcommands outside SPECS');
});
// End-to-end functional coverage of loader-stop's SessionEnd path (safe
// no-op branch: handoff.md absent -> no-op, exit 0) lives in
// scripts/smoketest-handoff.js (HOOKS sections) and is unaffected by this
// change, since loader-stop's dispatch entry (`() => cmdLoaderStop()`) takes
// no argv at all -- see scripts/handoff.js main()'s subcommands table.
test('loader-stop with a scratch (unprovisioned) project is still a safe no-op (exit 0)', () => {
  const root = makeScratchRoot();
  const r = spawnSync(process.execPath, [HANDOFF_SCRIPT, 'loader-stop'], {
    cwd: root,
    env: Object.assign({}, process.env, { PROJECT_ROOT: root }),
    input: JSON.stringify({ hook_event_name: 'SessionEnd', session_id: 'cli-args-fail-closed-test' }),
    encoding: 'utf8',
    timeout: 15000,
  });
  // loader-stop is fail-soft by design (never breaks session teardown) --
  // it always exits 0, whether or not a DB connection succeeds.
  assert(r.status === 0, `expected loader-stop to exit 0 (fail-soft), got ${r.status} (stderr: ${(r.stderr || '').slice(0, 300)})`);
});

console.log(`\n─── Results ──────────────────────────────────────`);
console.log(`PASS ${passed}  FAIL ${failed}`);
if (failures.length > 0) {
  console.log('\nFailures:');
  for (const { label, err } of failures) console.log(`  - ${label}\n    ${err.stack || err.message}`);
}
process.exit(failed > 0 ? 1 : 0);
