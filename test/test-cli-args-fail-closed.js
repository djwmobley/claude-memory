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
const { WRITE_SUBCOMMANDS, SPECS, enforceTotalClassification } = require(path.join(PROJECT_ROOT, 'scripts', 'lib', 'cli-args.js'));

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

// ── Legitimate-invocation acceptance tests ───────────────────────────────────
//
// PR #272 review finding: SPECS.init declared no positional, so the REAL
// `init <name> -y` shape (used by scripts/handoff-mcp.mjs's toolHandoffInit
// AND documented in commands/handoff/init.md) was itself rejected by the
// new gate — a false positive from a spec that was guessed instead of
// derived from cmdInit's own body (scripts/handoff.js:4273:
// `args.find((a) => !a.startsWith('-'))` — an OPTIONAL project-name
// positional). Fixed in scripts/lib/cli-args.js.
//
// Every entry below is a REAL argv shape lifted verbatim from one of the
// three caller classes named in the review: (a) scripts/handoff-mcp.mjs's
// spawn arrays, (b) a `handoff.js <cmd> ...` line in commands/handoff/*.md,
// (c) a spawnSync argv in .github/workflows/test.yml-run scripts/test-*.js
// or test/**/*.js. Each must be ACCEPTED (enforceTotalClassification must
// return normally, not call process.exit) — a regression here means a real
// caller would start failing exactly like the PR #272 finding.
const LEGIT_INVOCATIONS = [
  // (a) scripts/handoff-mcp.mjs
  { cmd: 'init',       argv: ['my-project', '-y'], cite: 'scripts/handoff-mcp.mjs:366 toolHandoffInit (name given)' },
  { cmd: 'init',       argv: ['-y'],               cite: 'scripts/handoff-mcp.mjs:366 toolHandoffInit (no name)' },
  { cmd: 'checkpoint', argv: ['--json', '-'],       cite: 'scripts/handoff-mcp.mjs:343 runPayloadSubcommand (checkpoint)' },
  { cmd: 'close',      argv: ['--json', '-'],       cite: 'scripts/handoff-mcp.mjs:343 runPayloadSubcommand (close)' },

  // (b) commands/handoff/*.md
  { cmd: 'init',       argv: ['--seed-provider'],  cite: 'commands/handoff/init.md:53' },
  { cmd: 'init',       argv: [],                    cite: 'commands/handoff/init.md:116' },
  { cmd: 'init',       argv: ['my-project'],        cite: 'commands/handoff/init.md:119' },
  { cmd: 'init',       argv: ['-y'],                cite: 'commands/handoff/init.md:122' },
  { cmd: 'init',       argv: ['my-project', '-y'],  cite: 'commands/handoff/init.md:125' },
  { cmd: 'drop',       argv: [],                    cite: 'commands/handoff/drop.md:64' },
  { cmd: 'checkpoint', argv: ['--note', 'discovered session_id threading gap in L2 path'], cite: 'commands/handoff/checkpoint.md:10' },
  { cmd: 'checkpoint', argv: ['--json'],            cite: 'commands/handoff/checkpoint.md:153' },
  { cmd: 'checkpoint', argv: ['--json', '-'],       cite: 'commands/handoff/checkpoint.md:156' },
  { cmd: 'close',      argv: ['--json'],            cite: 'commands/handoff/close.md:308' },
  { cmd: 'close',      argv: ['--json', '-'],       cite: 'commands/handoff/close.md:311' },
  { cmd: 'close',      argv: ['--json', '--dry-run'], cite: 'commands/handoff/close.md:314' },
  // --dry-run without --json is a real, tested, legitimate shape: --dry-run
  // performs ZERO DB mutations by construction, so an empty/missing payload
  // under it carries none of the incident's risk. Found as a real
  // regression (CI red on scripts/handoff.js's original A3 gate, which did
  // not exempt --dry-run) via test/handoff/test-write-path-params.js's own
  // "close --dry-run: works without --json (empty payload)" test.
  { cmd: 'close',      argv: ['--dry-run'],           cite: 'test/handoff/test-write-path-params.js:525' },
  { cmd: 'purge',      argv: ['--yes'],             cite: 'commands/handoff/purge.md:75' },
  { cmd: 'purge',      argv: ['--dry-run'],         cite: 'commands/handoff/purge.md:78' },
  { cmd: 'promote',    argv: ['42'],                cite: 'commands/handoff/promote.md:65' },
  { cmd: 'promote',    argv: ['--subject', 'vLLM', '--predicate', 'is_model', '--object', 'Qwen3-Embedding-8B'], cite: 'commands/handoff/promote.md:68' },
  { cmd: 'promote',    argv: ['--subject', 'vLLM', '--predicate', 'is_model'], cite: 'commands/handoff/promote.md:71' },
  { cmd: 'promote',    argv: ['--demote', '42'],    cite: 'commands/handoff/promote.md:74' },
  { cmd: 'queue-drain', argv: [],                   cite: 'commands/handoff/close.md:17' },

  // (c) .github/workflows/test.yml-run scripts/test-*.js and test/**/*.js
  { cmd: 'init',       argv: ['-y', '--no-embeddings'], cite: 'scripts/smoketest-handoff.js:1408 (et al.), scripts/test-init-atomic.js:149, test/handoff/test-session-marker-concurrency.js:147' },
  { cmd: 'init',       argv: [],                    cite: 'scripts/test-init-confirm.js:280 (NO -y, C3 non-TTY safe-fail case)' },
  { cmd: 'init',       argv: ['--no-embeddings'],   cite: 'scripts/test-init-confirm.js:102 finalArgs (--no-embeddings already present)' },
  { cmd: 'init',       argv: ['--allow-remote-embed'], cite: 'scripts/test-init-confirm.js:102 finalArgs (--allow-remote-embed already present)' },
  { cmd: 'promote',    argv: ['5'],                 cite: 'scripts/smoketest-handoff.js:1617' },
  { cmd: 'close',      argv: ['--json', '-'],       cite: 'scripts/test-async-queue.js:135' },
  { cmd: 'checkpoint', argv: ['--json', '-'],       cite: 'scripts/test-async-queue.js:152' },
  { cmd: 'queue-drain', argv: [],                   cite: 'scripts/test-async-queue.js:169 (no extraArgs)' },
  { cmd: 'prune',      argv: [],                    cite: 'scripts/smoketest-handoff.js:6233' },
  { cmd: 'prune',      argv: ['--suppressed'],      cite: 'scripts/smoketest-handoff.js:6259' },
  { cmd: 'prune',      argv: ['--suppressed', '--suppression-kind', 'superseded', '--apply'], cite: 'scripts/smoketest-handoff.js:6293' },
  { cmd: 'prune',      argv: ['--suppressed', '--include-pinned', '--apply'], cite: 'scripts/smoketest-handoff.js:6376' },

  // retire — no commands/handoff/*.md caller exists; every shape below is
  // lifted from scripts/test-l5-directive-retirement.js's runHandoff() calls
  // (PR #272 review round 2: retire/backfill-embeddings had no .md-sourced
  // ACCEPT cases at all).
  { cmd: 'retire', argv: ['--subject', 'rule-engine', '--predicate', 'must_do'], cite: 'scripts/test-l5-directive-retirement.js:414 (T5)' },
  { cmd: 'retire', argv: ['--subject', 'system', '--predicate', 'must_do', '--object', 'check-A', '--apply'], cite: 'scripts/test-l5-directive-retirement.js:440-442 (T6)' },
  { cmd: 'retire', argv: ['--subject', 'agent', '--predicate', 'never_uses', '--apply'], cite: 'scripts/test-l5-directive-retirement.js:475-477 (T7)' },
  { cmd: 'retire', argv: ['--subject', 'some-subject', '--predicate', 'uses'], cite: 'scripts/test-l5-directive-retirement.js:505-507 (T8)' },
  { cmd: 'retire', argv: ['--subject', 'config-service', '--predicate', 'policy', '--object', 'no-debug-in-prod', '--apply'], cite: 'scripts/test-l5-directive-retirement.js:525-528 (T9)' },
  // T10's own point: this shape (--replace-with VALUE) must be ACCEPTED by
  // the gate -- cmdRetire itself is the one that rejects it, with its own
  // specific message. See the dedicated precedence test below for the
  // full spawnSync round-trip proving cmdRetire's message wins.
  { cmd: 'retire', argv: ['--subject', 'x', '--predicate', 'must_do', '--object', 'old-rule', '--replace-with', 'new-rule'], cite: 'scripts/test-l5-directive-retirement.js:560-563 (T10)' },

  // backfill-embeddings — no commands/handoff/*.md or spawnSync-based test
  // caller exists (test-init-embeddability.js calls runBackfillEmbeddings()
  // as an in-process library function, not through the CLI argv path).
  // Shapes below are derived directly from cmdBackfillEmbeddings's own body
  // (scripts/handoff.js:10290-10298) plus the two documented forms in
  // docs/how-memory-works.md:259/282 and docs/mcp-tools.md:127 (outside
  // commands/handoff/*.md, but the only documented CLI usage that exists).
  { cmd: 'backfill-embeddings', argv: [], cite: 'scripts/handoff.js:10293 apply=false default; docs/how-memory-works.md:259 (dry-run)' },
  { cmd: 'backfill-embeddings', argv: ['--apply'], cite: 'scripts/handoff.js:10293; docs/how-memory-works.md:282' },
  { cmd: 'backfill-embeddings', argv: ['--force-mixed-provider'], cite: 'scripts/handoff.js:10294' },
  { cmd: 'backfill-embeddings', argv: ['--table=assertions'], cite: 'scripts/handoff.js:10295' },
  { cmd: 'backfill-embeddings', argv: ['--batch-size=25'], cite: 'scripts/handoff.js:10296-10297' },
  { cmd: 'backfill-embeddings', argv: ['--project-id=00000000-0000-0000-0000-000000000000'], cite: 'scripts/handoff.js:10298' },
];

function assertAccepted(cmd, argv, cite) {
  const origExit = process.exit;
  let exitCalledWith = null;
  process.exit = (code) => {
    exitCalledWith = code;
    throw new Error(`__ENFORCE_EXIT_${code}__`);
  };
  try {
    enforceTotalClassification(cmd, argv);
  } catch (e) {
    if (!/^__ENFORCE_EXIT_/.test(e.message)) throw e;
  } finally {
    process.exit = origExit;
  }
  assert(exitCalledWith === null,
    `${cite}: real argv ${JSON.stringify([cmd, ...argv])} must be ACCEPTED, but the classifier called process.exit(${exitCalledWith})`);
}

for (const { cmd, argv, cite } of LEGIT_INVOCATIONS) {
  test(`ACCEPT ${cmd} ${JSON.stringify(argv)} — ${cite}`, () => assertAccepted(cmd, argv, cite));
}

// ── Precedence: a command's own specific rejection message must win over
// the gate's generic "unknown argument" message (PR #272 review round 2) ──
//
// scripts/test-l5-directive-retirement.js's T10 spawns the real CLI with
// `retire --subject x --predicate must_do --object old-rule --replace-with
// new-rule` and asserts exit 2 with stderr mentioning "--replace-with" --
// cmdRetire's own dedicated message (scripts/handoff.js:10124-10130), not
// this gate's generic rejection. Declaring --replace-with as a 'value' flag
// (see scripts/lib/cli-args.js SPECS.retire) lets the whole argv classify
// successfully at the gate, so cmdRetire is actually invoked and its own
// check fires. Reproduced here as a full spawnSync round-trip (not just the
// in-process classifier check above) so a regression that reintroduces the
// generic-message-wins bug is caught even if someone "fixes" the gate a
// different way that still happens to pass the pure classifier check.
test('retire --replace-with precedence: cmdRetire\'s own message wins, not a generic "unknown argument"', () => {
  const r = runCli([
    'retire', '--subject', 'x', '--predicate', 'must_do',
    '--object', 'old-rule', '--replace-with', 'new-rule',
  ]);
  assert(r.status === 2, `expected exit 2, got ${r.status} (stderr: ${(r.stderr || '').slice(0, 300)})`);
  assert(r.stderr.includes('--replace-with'), `expected cmdRetire's specific --replace-with message, got: ${r.stderr}`);
  assert(!r.stderr.includes('unknown argument'), `the gate's generic message must NOT preempt cmdRetire's specific one, got: ${r.stderr}`);
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
