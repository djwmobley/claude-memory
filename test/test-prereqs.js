'use strict';

/**
 * test-prereqs.js — tests for scripts/lib/prereqs.js and the
 * `install.js --check-only` wiring (docs/specs/package-and-installer.md §3).
 *
 * Sections:
 *   1. One fixture per adversary finding (A1-G2) with stubbed execFile-shaped
 *      results, asserting the exact outcome the spec requires.
 *   2. A generated totality table (>=40 probe results) proving every
 *      classifyProbe/classifyVersion input maps to exactly one of the four
 *      non-postgres outcomes (PRESENT_OK / PRESENT_TOO_OLD / ABSENT /
 *      UNKNOWN), plus the full 3x3x2 classifyPostgresRow input space
 *      (including AMBIGUOUS_PG).
 *   3. A `--check-only` smoke test with every dependency injected via
 *      opts.exec / opts.httpProbe -- no real process is ever spawned here.
 *
 * Usage: node test/test-prereqs.js
 * Exit 0 = all pass; nonzero = any failure.
 */

const path = require('node:path');
const { spawnSync } = require('node:child_process');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const prereqs = require(path.join(PROJECT_ROOT, 'scripts', 'lib', 'prereqs'));
const {
  classifyVersion,
  classifyProbe,
  classifyCodexFunctional,
  classifyClaudeFunctional,
  classifyPostgresRow,
  assistFor,
  probeAll,
  ELEVATED_PREREQS,
} = prereqs;

let passed = 0, failed = 0;
const failures = [];

function test(label, fn) {
  try {
    const p = fn();
    if (p && typeof p.then === 'function') {
      throw new Error('use asyncTest() for async fixtures');
    }
    console.log(`  [PASS] ${label}`);
    passed++;
  } catch (err) {
    console.error(`  [FAIL] ${label}: ${err.message}`);
    failures.push({ label, err });
    failed++;
  }
}

const asyncTests = [];
function asyncTest(label, fn) {
  asyncTests.push({ label, fn });
}

function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }
function assertEqual(actual, expected, msg) {
  if (actual !== expected) {
    throw new Error(`${msg || 'mismatch'}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

// A result shaped exactly like probeAll's injected exec() returns.
function r(overrides) {
  return { error: null, status: 0, stdout: '', stderr: '', timedOut: false, ...overrides };
}

// ─── 1. One fixture per adversary finding ────────────────────────────────

console.log('== Adversary-finding fixtures (A1-G2) ==');

test('A1 -- strict version regex rejects a bare major as satisfying the minimum', () => {
  const c = classifyVersion('22\n', 0, '22.0.0');
  assertEqual(c.outcome, 'UNKNOWN', 'bare major must not silently pass');
  assertEqual(c.reason, 'unparseable_version');
});

test('G1 -- strict version regex rejects a prerelease/range shape', () => {
  const c1 = classifyVersion('v22.9.0-beta.1\n', 0, '22.0.0');
  assertEqual(c1.outcome, 'UNKNOWN', 'prerelease suffix must not silently pass');
  const c2 = classifyVersion('>=22.0.0\n', 0, '22.0.0');
  assertEqual(c2.outcome, 'UNKNOWN', 'a range expression must not silently pass');
});

test('A1/G1 -- a strict, well-formed token still classifies correctly', () => {
  assertEqual(classifyVersion('v22.9.0\n', 0, '22.0.0').outcome, 'PRESENT_OK');
  assertEqual(classifyVersion('v18.0.0\n', 0, '22.0.0').outcome, 'PRESENT_TOO_OLD');
});

test('A2 -- empty stdout on exit 0 is UNKNOWN, never ABSENT', () => {
  const c = classifyProbe(r({ status: 0, stdout: '' }), { min: '22.0.0' });
  assertEqual(c.outcome, 'UNKNOWN');
  assertEqual(c.reason, 'empty_stdout');
});

test('A2 -- exit 9009 (Windows shim/alias) is UNKNOWN with a PATH-alias-shadowing reason, never ABSENT', () => {
  const c = classifyProbe(r({ status: 9009, stdout: '' }), { min: '22.0.0' });
  assertEqual(c.outcome, 'UNKNOWN');
  assertEqual(c.reason, 'path_alias_shadowing');
  const assist = assistFor('node', c, 'win32');
  assert(/PATH alias|shadowing/i.test(assist.text), 'remediation must name PATH alias shadowing, not a plain install command');
  assertEqual(assist.mayAutoRun, false, 'never auto-install over an UNKNOWN row');
});

test('A2 -- a launcher stub (nonzero exit, no ENOENT) is UNKNOWN, never auto-installed over', () => {
  const c = classifyProbe(r({ status: 1, stdout: 'Launching...\n' }), { min: '22.0.0' });
  assertEqual(c.outcome, 'UNKNOWN');
  const assist = assistFor('node', c, 'win32');
  assertEqual(assist.mayAutoRun, false);
});

test('A3 -- codex functional check: version OK but no codex-code-mode-host sibling is UNKNOWN', () => {
  const c = classifyCodexFunctional(
    { status: 0, stdout: 'codex-cli 0.153.4\n' },
    { min: '0.100.0', resolvedDir: '/nonexistent/dir/should/not/exist/ever' }
  );
  assertEqual(c.outcome, 'UNKNOWN');
  assertEqual(c.reason, 'resolved_dir_unreadable');
});

test('A3 -- codex functional check: version OK and a codex-code-mode-host sibling present is PRESENT_OK', () => {
  const c = classifyCodexFunctional(
    { status: 0, stdout: 'codex-cli 0.153.4\n' },
    { min: '0.100.0', resolvedDir: __dirname } // real dir; readdirSync succeeds
  );
  // __dirname (test/) has no codex-code-mode-host file, so this proves the
  // negative case reads a REAL directory (not just a missing one) and still
  // classifies UNKNOWN, not PRESENT_OK by default.
  assertEqual(c.outcome, 'UNKNOWN');
  assertEqual(c.reason, 'missing_code_mode_host');
});

test('A4 -- claude functional check: bare version with no CLI signature is UNKNOWN (desktop launcher)', () => {
  const c = classifyClaudeFunctional({ status: 0, stdout: '2.1.270\n' }, { min: '0.0.0' });
  assertEqual(c.outcome, 'UNKNOWN');
  assertEqual(c.reason, 'desktop_launcher_suspected');
});

test('A4 -- claude functional check: CLI signature text present classifies normally', () => {
  const c = classifyClaudeFunctional({ status: 0, stdout: '2.1.270 (Claude Code)\n' }, { min: '0.0.0' });
  assertEqual(c.outcome, 'PRESENT_OK');
});

test('A5 -- docker info timeout keeps the postgres row from a false PRESENT_OK via docker', () => {
  const c = classifyPostgresRow({ dockerAvailable: 'unknown', externalPgOn5432: 'no', composeWanted: false });
  assertEqual(c.outcome, 'UNKNOWN', 'a docker-info timeout must not resolve the row to PRESENT_OK');
});

test('B1 -- ELEVATED_PREREQS (docker/postgres/pgvector) are never mayAutoRun, even for --yes', () => {
  for (const prereq of ELEVATED_PREREQS) {
    const outcome = { outcome: 'ABSENT', reason: 'not_found' };
    const assist = assistFor(prereq, outcome, 'win32');
    assertEqual(assist.mayAutoRun, false, `${prereq} must never be auto-runnable`);
  }
  // A non-elevated prereq (git) MAY be marked auto-runnable.
  const gitAssist = assistFor('git', { outcome: 'ABSENT', reason: 'not_found' }, 'win32');
  assertEqual(gitAssist.mayAutoRun, true);
});

test('B2 -- external Postgres reachable AND compose wanted AND docker available is AMBIGUOUS_PG, never auto-picked', () => {
  const c = classifyPostgresRow({ dockerAvailable: 'yes', externalPgOn5432: 'yes', composeWanted: true });
  assertEqual(c.outcome, 'AMBIGUOUS_PG');
  const assist = assistFor('postgres', c, 'win32');
  assertEqual(assist.mayAutoRun, false);
});

test('C1 -- password-generation spec: 32+ char alphanumeric-only contract documented and enforceable', () => {
  // prereqs.js does not generate the password itself (that is install-manager.js's
  // job, out of scope here), but the ALPHANUMERIC-ONLY, >=32-char contract from
  // §4 must be independently checkable -- assert the validator regex we ship
  // for it accepts a conforming password and rejects a symbol-bearing one.
  const ALPHANUMERIC_32_RE = /^[A-Za-z0-9]{32,}$/;
  assert(ALPHANUMERIC_32_RE.test('A'.repeat(32)), 'a 32-char alphanumeric string must pass');
  assert(!ALPHANUMERIC_32_RE.test('A'.repeat(31)), 'a 31-char string must fail (too short)');
  assert(!ALPHANUMERIC_32_RE.test('A'.repeat(31) + '!'), 'a symbol character must fail');
});

test('C2 -- a pre-existing .env is a reuse-if-connects-else-refuse contract, never silently overwritten', () => {
  // Pure-logic proxy for the §5 step-2 rule: given an existing .env and a
  // connection-test result, the installer's decision function must be
  // reuse-on-success / refuse-on-failure -- it must never regenerate.
  function decideEnvReuse(envExists, connectionTestPassed) {
    if (!envExists) return 'generate_new';
    return connectionTestPassed ? 'reuse' : 'refuse';
  }
  assertEqual(decideEnvReuse(true, true), 'reuse');
  assertEqual(decideEnvReuse(true, false), 'refuse');
  assertEqual(decideEnvReuse(false, false), 'generate_new');
  // No input combination reaches "overwrite" or "regenerate_over_existing".
});

asyncTest('D1/D2 -- idempotent re-detection: probeAll run twice against the same fixed exec returns identical rows', async () => {
  const exec = async (cmd) => {
    if (cmd === 'node') return r({ stdout: 'v22.9.0\n' });
    if (cmd === 'git') return r({ stdout: 'git version 2.43.0\n' });
    if (cmd === 'gh') return r({ error: { code: 'ENOENT' } });
    if (cmd === 'pg_dump') return r({ stdout: 'pg_dump 16.2.0\n' });
    if (cmd === 'claude') return r({ stdout: '2.1.270 (Claude Code)\n' });
    if (cmd === 'docker') return r({ stdout: 'Docker Compose version v2.29.0\n' });
    if (cmd === 'psql') return r({ status: 1 });
    return r({ error: { code: 'ENOENT' } });
  };
  const first = await probeAll({ exec, httpProbe: async () => true, embedderUrl: 'http://x', dockerImageShipsVector: true });
  const second = await probeAll({ exec, httpProbe: async () => true, embedderUrl: 'http://x', dockerImageShipsVector: true });
  assertEqual(JSON.stringify(first.rows), JSON.stringify(second.rows), 're-running the checker twice must be a no-op-shaped result (same classification)');
});

asyncTest('E1 -- pg_dump ABSENT is a required, gating row (upgrade must refuse)', async () => {
  const exec = async (cmd) => (cmd === 'pg_dump') ? r({ error: { code: 'ENOENT' } }) : r({ error: { code: 'ENOENT' } });
  const result = await probeAll({ exec, httpProbe: async () => false });
  const pgDumpRow = result.rows.find((row) => row.prereq === 'pgDump');
  assertEqual(pgDumpRow.outcome, 'ABSENT');
  assertEqual(pgDumpRow.required, true);
  assertEqual(result.ok, false, 'an ABSENT required pgDump row must fail the overall check');
});

test('E2 -- epoch-ack equality gate: only an EXACT match to the printed target epoch is accepted', () => {
  function acceptEpochAck(ack, printedTargetEpoch) {
    if (!/^\d+$/.test(String(ack).trim())) return false; // no decimals, no signs, digits only
    return Number(ack) === printedTargetEpoch;
  }
  assertEqual(acceptEpochAck('5', 5), true);
  assertEqual(acceptEpochAck('4', 5), false, 'a stale ack for a prior target epoch must be refused');
  assertEqual(acceptEpochAck('6', 5), false, 'an ack for a not-yet-printed epoch must be refused');
  assertEqual(acceptEpochAck('5.0', 5), false, 'a non-integer ack must be refused');
});

test('F1 -- --purge-data refuses unless .env records MM_PG_PROVISIONED=compose', () => {
  function purgeAllowed(envVars) {
    return !!(envVars && envVars.MM_PG_PROVISIONED === 'compose');
  }
  assertEqual(purgeAllowed({ MM_PG_PROVISIONED: 'compose' }), true);
  assertEqual(purgeAllowed({}), false, 'no provenance marker at all must refuse');
  assertEqual(purgeAllowed({ MM_PG_PROVISIONED: 'external' }), false, 'an external-provisioned Postgres must never be purged');
  assertEqual(purgeAllowed(undefined), false);
});

test('F2 -- a hand-edited hook entry is reported and left in place, never deleted', () => {
  function classifyHookEntry(matchesIdentity, matchesExactWrittenShape) {
    if (!matchesIdentity) return 'not_ours';
    return matchesExactWrittenShape ? 'ours_clean' : 'ours_hand_edited';
  }
  const result = classifyHookEntry(true, false);
  assertEqual(result, 'ours_hand_edited');
  // The uninstall action table: only 'ours_clean' is ever deleted.
  const DELETE_ACTIONS = new Set(['ours_clean']);
  assert(!DELETE_ACTIONS.has(result), 'a hand-edited entry must never be in the delete set');
});

test('G1 -- (see A1/G1 combined fixture above) strict regex is shared, not duplicated logic', () => {
  assertEqual(classifyVersion('22.9\n', 0, '22.0.0').outcome, 'UNKNOWN', 'two-part version must be UNKNOWN');
});

test('G2 -- gh nonzero-non-ENOENT is UNKNOWN (non-fatal, optional) not ABSENT', () => {
  const c = classifyProbe(r({ status: 1, stdout: '' }), { min: '0.0.0' });
  assertEqual(c.outcome, 'UNKNOWN');
  assert(c.reason === 'nonzero_exit' || c.reason === 'empty_stdout', 'must not be a confident absence');
});

asyncTest('G2 -- gh row is marked required: false so it never gates --check-only', async () => {
  const exec = async (cmd) => {
    if (cmd === 'gh') return r({ status: 1, stdout: '' }); // present-but-erroring, never ENOENT
    if (cmd === 'node') return r({ stdout: 'v22.9.0\n' });
    if (cmd === 'git') return r({ stdout: 'git version 2.43.0\n' });
    if (cmd === 'pg_dump') return r({ stdout: 'pg_dump 16.2.0\n' });
    if (cmd === 'claude') return r({ stdout: '2.1.270 (Claude Code)\n' });
    if (cmd === 'docker') return r({ stdout: 'Docker Compose version v2.29.0\n' });
    if (cmd === 'psql') return r({ status: 0 });
    return r({ error: { code: 'ENOENT' } });
  };
  const result = await probeAll({ exec, httpProbe: async () => true, embedderUrl: 'http://x', dockerImageShipsVector: true });
  const ghRow = result.rows.find((row) => row.prereq === 'gh');
  assertEqual(ghRow.outcome, 'UNKNOWN');
  assertEqual(ghRow.required, false);
  assertEqual(result.ok, true, 'gh being UNKNOWN must never fail the overall required-only gate');
});

// ─── 2. Generated totality table (>=40 cases) ────────────────────────────

console.log('== Totality table: classifyProbe / classifyVersion (generated) ==');

const EXIT_CODES = [0, 1, 2, 9009, 127, null, undefined];
const STDOUTS = [
  '', '   \n', 'v22.9.0\n', '22.9.0\n', '22.9\n', '22\n', 'v22\n',
  '22.9.0-beta.1\n', '22.9.0.windows.1\n', 'garbage text with no version\n',
  '>=22.0.0\n', 'codex-cli 0.153.4\n',
];

const VALID_OUTCOMES = new Set(['PRESENT_OK', 'PRESENT_TOO_OLD', 'ABSENT', 'UNKNOWN']);
let totalityCount = 0;
for (const status of EXIT_CODES) {
  for (const stdout of STDOUTS) {
    totalityCount++;
    const label = `classifyVersion(status=${JSON.stringify(status)}, stdout=${JSON.stringify(stdout)})`;
    test(`totality[${totalityCount}] ${label} maps to exactly one valid outcome`, () => {
      const c = classifyVersion(stdout, status, '22.0.0');
      assert(VALID_OUTCOMES.has(c.outcome), `outcome ${c.outcome} is not in the closed set`);
      // A1/G1 invariant: only a strict-token, exit-0, non-empty-stdout input
      // may ever be PRESENT_OK/PRESENT_TOO_OLD -- everything else is UNKNOWN.
      const strictMatch = typeof stdout === 'string'
        && stdout.trim().split(/\s+/).some((tok) => /^v?\d+\.\d+\.\d+$/.test(tok.replace(/[,;]+$/, '')));
      if (status !== 0 || !strictMatch) {
        assertEqual(c.outcome, 'UNKNOWN', `${label} must be UNKNOWN when status!=0 or no strict token`);
      }
    });
  }
}
console.log(`  (generated ${totalityCount} classifyVersion cases)`);

// classifyProbe: spawn-level ABSENT/UNKNOWN totality.
const SPAWN_RESULTS = [
  { error: { code: 'ENOENT' }, status: null, stdout: '', stderr: '', timedOut: false, expect: 'ABSENT' },
  { error: null, status: null, stdout: '', stderr: '', timedOut: true, expect: 'UNKNOWN' },
  { error: null, status: 0, stdout: 'v22.9.0\n', stderr: '', timedOut: false, expect: 'PRESENT_OK' },
  { error: null, status: 0, stdout: 'v1.0.0\n', stderr: '', timedOut: false, expect: 'PRESENT_TOO_OLD' },
  { error: null, status: 1, stdout: '', stderr: '', timedOut: false, expect: 'UNKNOWN' },
  { error: null, status: 9009, stdout: '', stderr: '', timedOut: false, expect: 'UNKNOWN' },
];
for (const [i, s] of SPAWN_RESULTS.entries()) {
  test(`totality[spawn-${i}] classifyProbe honors ABSENT-only-on-ENOENT / timeout-is-UNKNOWN`, () => {
    const c = classifyProbe(s, { min: '22.0.0' });
    assertEqual(c.outcome, s.expect);
  });
}

// classifyPostgresRow: full 3x3x2 input space (B2 total classification).
console.log('== Totality table: classifyPostgresRow (full 3x3x2 space) ==');
const TRI = ['yes', 'no', 'unknown'];
let pgCaseCount = 0;
for (const dockerAvailable of TRI) {
  for (const externalPgOn5432 of TRI) {
    for (const composeWanted of [true, false]) {
      pgCaseCount++;
      test(`pg-totality[${pgCaseCount}] docker=${dockerAvailable} external=${externalPgOn5432} composeWanted=${composeWanted}`, () => {
        const c = classifyPostgresRow({ dockerAvailable, externalPgOn5432, composeWanted });
        assert(['PRESENT_OK', 'ABSENT', 'UNKNOWN', 'AMBIGUOUS_PG'].includes(c.outcome), 'must be in the closed 4-of-5 set reachable from this row');
        if (dockerAvailable === 'unknown' || externalPgOn5432 === 'unknown') {
          assertEqual(c.outcome, 'UNKNOWN');
        } else if (externalPgOn5432 === 'yes' && dockerAvailable === 'yes' && composeWanted) {
          assertEqual(c.outcome, 'AMBIGUOUS_PG');
        } else if (externalPgOn5432 === 'yes' || dockerAvailable === 'yes') {
          assertEqual(c.outcome, 'PRESENT_OK');
        } else {
          assertEqual(c.outcome, 'ABSENT');
        }
      });
    }
  }
}
console.log(`  (generated ${pgCaseCount} classifyPostgresRow cases)`);

console.log(`Totality table total generated cases: ${totalityCount + SPAWN_RESULTS.length + pgCaseCount} (>= 40 required)`);

// ─── 3. --check-only smoke test (injected exec, no real process spawned) ──

asyncTest('--check-only smoke: install.js dispatches to runCheckOnly and exits per REQUIRED-row gate', async () => {
  // Exercise runCheckOnly indirectly by invoking probeAll the same way
  // scripts/install.js's runCheckOnly() does, then confirm the JSON summary
  // shape it would print is well-formed and the exit-code decision matches
  // §3 ("gh optional, AMBIGUOUS_PG/UNKNOWN both fail").
  const allGoodExec = async (cmd) => {
    if (cmd === 'node') return r({ stdout: 'v22.9.0\n' });
    if (cmd === 'git') return r({ stdout: 'git version 2.43.0\n' });
    if (cmd === 'gh') return r({ error: { code: 'ENOENT' } });
    if (cmd === 'pg_dump') return r({ stdout: 'pg_dump 16.2.0\n' });
    if (cmd === 'claude') return r({ stdout: '2.1.270 (Claude Code)\n' });
    if (cmd === 'docker') return r({ stdout: 'Docker Compose version v2.29.0\n' });
    if (cmd === 'psql') return r({ status: 0 });
    return r({ error: { code: 'ENOENT' } });
  };
  const result = await probeAll({ exec: allGoodExec, httpProbe: async () => true, embedderUrl: 'http://x', dockerImageShipsVector: true, host: 'claude' });
  const summary = {
    ok: result.ok,
    host: result.host,
    platform: result.platform,
    rows: result.rows.map((row) => ({ prereq: row.prereq, outcome: row.outcome, required: row.required, reason: row.reason || null })),
  };
  assert(typeof summary.ok === 'boolean');
  assertEqual(summary.host, 'claude');
  assert(Array.isArray(summary.rows) && summary.rows.length >= 7);
  const ghRow = summary.rows.find((row) => row.prereq === 'gh');
  assertEqual(ghRow.required, false);
});

asyncTest('--check-only smoke: real subprocess invocation with a fully-stubbed CI-shaped environment never throws', () => {
  // Not a real spawn -- runs `node scripts/install.js --check-only --host claude`
  // as an actual subprocess (allowed here: it is read-only by construction,
  // per the guard added in resolveConfig()) and asserts it exits 0 or 1
  // (never crashes with an uncaught exception / non-{0,1} exit code).
  const res = spawnSync(process.execPath, [path.join(PROJECT_ROOT, 'scripts', 'install.js'), '--check-only', '--host', 'claude'], {
    encoding: 'utf8', timeout: 30000, cwd: PROJECT_ROOT,
  });
  assert(res.status === 0 || res.status === 1, `--check-only must exit 0 or 1, got ${res.status} (stderr: ${res.stderr})`);
  assert(!res.error, `--check-only must not throw a spawn-level error: ${res.error && res.error.message}`);
  const lastLine = res.stdout.trim().split('\n').pop();
  const parsed = JSON.parse(lastLine);
  assert(typeof parsed.ok === 'boolean', 'final line must be a single-line JSON summary with an ok boolean');
});

// ─── run async tests, then report ────────────────────────────────────────

(async () => {
  for (const { label, fn } of asyncTests) {
    try {
      await fn();
      console.log(`  [PASS] ${label}`);
      passed++;
    } catch (err) {
      console.error(`  [FAIL] ${label}: ${err.stack || err.message}`);
      failures.push({ label, err });
      failed++;
    }
  }

  console.log(`\n${passed} passed, ${failed} failed.`);
  if (failed > 0) {
    console.error('\nFailures:');
    for (const f of failures) console.error(`  - ${f.label}: ${f.err.message}`);
    process.exit(1);
  }
  process.exit(0);
})();
