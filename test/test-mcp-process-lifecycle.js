'use strict';

/**
 * test-mcp-process-lifecycle.js — regression coverage for the process-
 * lifecycle fix in scripts/handoff-mcp.mjs (host-disconnect exit + parent-
 * liveness watchdog) and scripts/handoff-mcp-selftest.mjs (close() on a
 * thrown assertion, so a failing selftest run never orphans its spawned
 * server child).
 *
 * Three cases, no live Postgres required (the server registers its tools
 * synchronously in buildServer() and never connects to a DB until a tool is
 * actually called — see handoff-mcp.mjs's own buildServer() comment):
 *
 *   T1 — spawn scripts/handoff-mcp.mjs with stdio pipes + a fresh scratch
 *        cwd, end its stdin (the common "host closed its write end
 *        cleanly" disconnect shape), assert the process exits within 3s.
 *        Before this fix, the SDK's StdioServerTransport only calls its own
 *        close() on a stdin READ ERROR mid-message, never on a clean 'end'
 *        — this is the actual bug (Finding 2), not a hypothetical.
 *
 *   T2 — spawn again, send SIGTERM via child.kill(), assert the process
 *        exits within 3s. On win32, child.kill('SIGTERM') is known to
 *        forcibly terminate the process at the OS level rather than
 *        reliably invoking a registered process.on('SIGTERM') handler (see
 *        this repo's PR body / BLIND SPOTS for the platform caveat) — this
 *        case therefore asserts prompt exit under a kill signal, not that
 *        our SIGTERM handler specifically ran; POSIX CI runners exercise
 *        the handler for real.
 *
 *   T3 — unit test for the selftest fix: imports runWithClient +
 *        closeClientAndWaitForExit directly from handoff-mcp-selftest.mjs
 *        (no real server spawned, no stdio transport — a stub client/
 *        transport pair) and asserts that when the wrapped fn throws,
 *        client.close() is still invoked exactly once before the error
 *        propagates. This is the exact shape the old `await client.close()`
 *        as main()'s last statement used to skip entirely.
 *
 * Usage: node test/test-mcp-process-lifecycle.js
 * Exit 0 = all pass; nonzero = any failure.
 */

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const SERVER_PATH = path.join(PROJECT_ROOT, 'scripts', 'handoff-mcp.mjs');
const SELFTEST_PATH = path.join(PROJECT_ROOT, 'scripts', 'handoff-mcp-selftest.mjs');

let passed = 0, failed = 0;
const failures = [];

async function test(label, fn) {
  try {
    await fn();
    console.log(`  [PASS] ${label}`);
    passed++;
  } catch (err) {
    console.error(`  [FAIL] ${label}: ${err.message}`);
    failures.push({ label, err });
    failed++;
  }
}

function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }

function makeScratchCwd() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-process-lifecycle-'));
}

// Spawns the real server with stdio pipes + a scratch cwd, waits ~500ms for
// it to finish starting up (buildServer()/server.connect() are fast but
// asynchronous), then calls `act(child)` to trigger a disconnect. Resolves
// with { elapsedMs, code, signal } once the child actually exits, or
// rejects if it has not exited by `timeoutMs`.
function spawnAndDisconnect(act, timeoutMs) {
  return new Promise((resolve, reject) => {
    const cwd = makeScratchCwd();
    const child = spawn(process.execPath, [SERVER_PATH], {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stderrBuf = '';
    child.stderr.on('data', (d) => { stderrBuf += d.toString(); });
    child.on('error', reject);

    const timer = setTimeout(() => {
      // Best-effort cleanup so a failing assertion never leaves this test's
      // own probe process running.
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
      reject(new Error(`process did not exit within ${timeoutMs}ms (stderr so far: ${JSON.stringify(stderrBuf.trim().slice(0, 300))})`));
    }, timeoutMs);

    const start = Date.now();
    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ elapsedMs: Date.now() - start, code, signal, stderr: stderrBuf });
    });

    setTimeout(() => act(child), 500);
  });
}

async function run() {
  await test('T1: server exits within 3s after stdin end (clean host disconnect)', async () => {
    const { elapsedMs, code } = await spawnAndDisconnect((child) => { child.stdin.end(); }, 3000);
    // The fix's exitOnce() path calls process.exit(0) after transport.close()
    // — a clean stdin-end disconnect should exit 0, not merely "exit".
    assert(code === 0, `expected exit code 0, got ${code}`);
    assert(elapsedMs < 3000, `expected exit within 3000ms, took ${elapsedMs}ms`);
  });

  await test('T2: server exits within 3s after SIGTERM', async () => {
    const { elapsedMs } = await spawnAndDisconnect((child) => { child.kill('SIGTERM'); }, 3000);
    // win32 caveat (see file header + PR BLIND SPOTS): child.kill('SIGTERM')
    // there is known to forcibly terminate rather than reliably deliver a
    // catchable signal, so this only asserts prompt exit, not a specific
    // exit code/signal pairing.
    assert(elapsedMs < 3000, `expected exit within 3000ms, took ${elapsedMs}ms`);
  });

  await test('T3: runWithClient() still calls client.close() when the wrapped fn throws', async () => {
    const { runWithClient } = await import(require('url').pathToFileURL(SELFTEST_PATH).href);
    let closeCalls = 0;
    const stubClient = {
      close: async () => { closeCalls++; },
    };
    // pid: null skips closeClientAndWaitForExit's post-close watchdog loop
    // entirely (no real child process exists here to poll) so this unit
    // test resolves immediately instead of waiting up to 5s.
    const stubTransport = { pid: null };

    let thrown = null;
    try {
      await runWithClient(stubClient, stubTransport, 'test', async () => {
        throw new Error('boom - simulated tools/call failure mid-selftest');
      });
    } catch (err) {
      thrown = err;
    }

    assert(thrown !== null && thrown.message.includes('boom'), 'expected the thrown error to propagate unchanged');
    assert(closeCalls === 1, `expected client.close() to be called exactly once despite the throw, got ${closeCalls}`);
  });

  console.log(`\n─── Results ──────────────────────────────────────`);
  console.log(`PASS ${passed}  FAIL ${failed}`);
  if (failures.length > 0) {
    console.log('\nFailures:');
    for (const { label, err } of failures) console.log(`  - ${label}\n    ${err.stack || err.message}`);
  }
  process.exit(failed > 0 ? 1 : 0);
}

run();
