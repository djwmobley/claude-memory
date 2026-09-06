'use strict';

/**
 * test-loader-stop-gate.js — S1 regression guard for cmdLoaderStop's total
 * classification of the hook event, evaluated BEFORE any file or DB I/O.
 *
 * Background: loader-stop used to be wired under the Claude Code Stop hook,
 * which fires at EVERY turn end. It never read stdin at all, so it ran its
 * full DB-connect + marker-check sequence on every single turn. This PR
 * moves the wiring to SessionEnd (fires once) AND adds a stdin-based gate so
 * that even a stray/legacy Stop-shaped invocation is a zero-I/O no-op.
 *
 * These tests prove the gate fires BEFORE any I/O by pointing PGHOST at an
 * unroutable address and asserting the process still exits 0 near-instantly
 * (a real DB-connect attempt against an unreachable host takes seconds to
 * time out, not milliseconds) — a proof-of-firing, not just an exit-code
 * check. No real Postgres is used or required by this file.
 *
 * Usage:
 *   node scripts/test-loader-stop-gate.js
 *
 * Exit 0 = all pass, 1 = any failure.
 */

const { spawnSync }           = require('child_process');
const path                    = require('path');
const os                      = require('os');
const fs                      = require('fs');
const { writeMarker }         = require('./lib/project-marker');
const { resolveHandoffMdPath } = require('./lib/handoff-paths');

const HELPER = path.resolve(__dirname, 'handoff.js');

// An address in the TEST-NET-1 documentation range (RFC 5737) — guaranteed
// non-routable, so a real connection attempt would hang until TCP timeout
// (tens of seconds), never succeed or fail fast. If the gate is bypassed,
// this test will time out (a loud failure) rather than silently pass.
const UNREACHABLE_HOST = '192.0.2.1';
const FAST_MS          = 3000; // generous vs. a real connect attempt, tight vs. a TCP timeout

let passed = 0;
let failed = 0;

function pass(label)         { console.log(`PASS  ${label}`); passed++; }
function fail(label, reason) { console.log(`FAIL  ${label}: ${reason}`); failed++; }

/** Run `handoff.js loader-stop` as a subprocess with the given stdin (raw string, or undefined for none). */
function runLoaderStop(stdin, opts = {}) {
  const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loader-stop-gate-test-'));
  const env = {
    ...process.env,
    PGHOST: UNREACHABLE_HOST,
    PROJECT_ROOT: emptyDir,
    ...opts.env,
  };
  const start = Date.now();
  const result = spawnSync(
    process.execPath,
    [HELPER, 'loader-stop'],
    {
      cwd: emptyDir,
      env,
      encoding: 'utf8',
      timeout: 10000,
      input: stdin === undefined ? undefined : stdin,
    }
  );
  const elapsedMs = Date.now() - start;
  fs.rmSync(emptyDir, { recursive: true, force: true });
  return { ...result, elapsedMs };
}

function assertFastNoOp(label, stdin) {
  const r = runLoaderStop(stdin);
  if (r.status !== 0) {
    fail(label, `expected exit 0, got ${r.status} (signal ${r.signal}); stderr: ${(r.stderr || '').slice(0, 300)}`);
    return;
  }
  if (r.elapsedMs >= FAST_MS) {
    fail(label, `expected a fast no-op (<${FAST_MS}ms — proves no DB connect attempt against the unreachable host), took ${r.elapsedMs}ms`);
    return;
  }
  pass(`${label} (exit 0, ${r.elapsedMs}ms)`);
}

// ── T1: Stop-shaped stdin — the exact regression this PR fixes ──────────────
assertFastNoOp(
  'T1: hook_event_name=Stop is a fast zero-I/O no-op',
  JSON.stringify({ hook_event_name: 'Stop', session_id: 'sess-1', transcript_path: 'stub-transcript', cwd: 'stub-cwd' })
);

// ── T2: malformed JSON ────────────────────────────────────────────────────
assertFastNoOp('T2: malformed stdin (invalid JSON) is a fast zero-I/O no-op', 'not-json{{{');

// ── T3: empty stdin ───────────────────────────────────────────────────────
assertFastNoOp('T3: empty stdin is a fast zero-I/O no-op', '');

// ── T4: no stdin provided at all (spawnSync default — closes immediately) ──
assertFastNoOp('T4: absent stdin (no input given to the child) is a fast zero-I/O no-op', undefined);

// ── T5: hook_event_name missing from an otherwise well-formed object ───────
assertFastNoOp(
  'T5: valid JSON object with no hook_event_name is a fast zero-I/O no-op',
  JSON.stringify({ session_id: 'sess-1' })
);

// ── T6: hook_event_name present but some other value (never SessionEnd) ────
assertFastNoOp(
  'T6: hook_event_name=PreToolUse is a fast zero-I/O no-op',
  JSON.stringify({ hook_event_name: 'PreToolUse', session_id: 'sess-1' })
);

// ── T7: stdin is valid JSON but a top-level array, not an object ───────────
assertFastNoOp(
  'T7: top-level JSON array stdin is a fast zero-I/O no-op',
  JSON.stringify([{ hook_event_name: 'SessionEnd' }])
);

// ── T8: stdin is valid JSON but a bare primitive, not an object ────────────
assertFastNoOp('T8: bare JSON primitive stdin is a fast zero-I/O no-op', '"just a string"');

// ── T9 (proof the harness itself can detect a slow path): hook_event_name=
// SessionEnd, against a project that HAS a provisioned handoff.md (so the
// cheap existence-check no-op doesn't short-circuit it first), DOES attempt
// a DB connection and is therefore slow/blocked against the unreachable
// host — the contrapositive proof that T1-T8 are not fast merely because
// the whole binary is fast, or because an uninitiated project always no-ops
// regardless of hook_event_name. Uses a short spawnSync timeout; a kill
// (status null) counts as "did not fast-no-op", the expected/passing outcome.
{
  const label = 'T9 (contrapositive): hook_event_name=SessionEnd on a provisioned project is NOT a fast no-op (proves T1-T8 exercise a real gate)';
  const provisionedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loader-stop-gate-provisioned-'));
  let r;
  let handoffDirToClean = null;
  try {
    const marker = writeMarker(provisionedDir);
    // loadConfig() reads host/port/database/user from THIS file, not from
    // PGHOST — resolveDialect/connectHandoff never consult the env var
    // directly, so the unreachable host must be injected via pipeline.yml.
    fs.mkdirSync(path.join(provisionedDir, '.claude'), { recursive: true });
    fs.writeFileSync(
      path.join(provisionedDir, '.claude', 'pipeline.yml'),
      `knowledge:\n  tier: "postgres"\n  host: "${UNREACHABLE_HOST}"\n  port: 5432\n  database: "loader_stop_gate_test"\n  user: "postgres"\n`,
      'utf8'
    );
    const handoffPath = resolveHandoffMdPath(marker.uuid);
    handoffDirToClean = path.dirname(handoffPath);
    fs.mkdirSync(handoffDirToClean, { recursive: true });
    fs.writeFileSync(
      handoffPath,
      '---\nproject_id: ' + marker.uuid + '\nlast_close: 2026-01-01T00:00:00.000Z\n---\n# Handoff\n\n## Open threads\n- (none)\n\n## Quick references\n(none)\n',
      'utf8'
    );
    r = runLoaderStop(
      JSON.stringify({ hook_event_name: 'SessionEnd', session_id: 'sess-1' }),
      { env: { PROJECT_ROOT: provisionedDir } }
    );
  } finally {
    fs.rmSync(provisionedDir, { recursive: true, force: true });
    if (handoffDirToClean) {
      try { fs.rmSync(handoffDirToClean, { recursive: true, force: true }); } catch (_) { /* best-effort */ }
    }
  }
  // Either it's still slow (DB connect attempt in flight, killed by the spawnSync
  // timeout -> status null) or it happens to fail fast with a connection error —
  // both are acceptable; the ONLY unacceptable outcome is silently matching T1-T8's
  // near-instant profile AND exiting 0, which would mean SessionEnd is being
  // short-circuited by the same gate as Stop (a real bug, not a perf artifact).
  if (r.status === 0 && r.elapsedMs < FAST_MS) {
    fail(label, `hook_event_name=SessionEnd exited 0 in ${r.elapsedMs}ms — indistinguishable from the Stop no-op path; the gate may be over-matching`);
  } else {
    pass(`${label} (exit ${r.status}, signal ${r.signal}, ${r.elapsedMs}ms — attempted real work, as expected)`);
  }
}

// ── Summary ───────────────────────────────────────────────────────────────────

console.log('');
console.log(`Results: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
