'use strict';

/**
 * test-install-sessionend-migration.js — Regression guard for install.js's
 * Stop -> SessionEnd hook migration (fix for "implicit close fires at turn
 * end, not session end").
 *
 * loader-stop used to be wired under the Claude Code Stop hook, which fires
 * at EVERY turn end. It is now wired under SessionEnd (fires once, at true
 * session end). scripts/install.js's mergeHooks() must:
 *   (a) support a SessionEnd hooks array,
 *   (b) add the loader-stop entry there,
 *   (c) actively REMOVE any pre-existing loader-stop entry from the Stop
 *       array on re-run (idempotent migration for already-provisioned
 *       projects).
 *
 * Unit-tested here on an in-memory hooks object via mergeHooks() directly
 * (exported by install.js) — never against a real settings.local.json file
 * (scripts/test-install-engine-path.js already covers install.js's real-file
 * behavior for the unrelated .engine-path feature; this file stays pure/fast
 * and cannot accidentally touch a real project's settings).
 *
 * Usage:
 *   node scripts/test-install-sessionend-migration.js
 *
 * No Postgres or Ollama required. Pure Node. Exit 0 = all pass, 1 = failure.
 */

const assert = require('assert');
const { mergeHooks } = require('./install.js');

let passed = 0;
let failed = 0;

function test(label, fn) {
  try {
    fn();
    console.log(`PASS  ${label}`);
    passed++;
  } catch (err) {
    console.error(`FAIL  ${label}`);
    console.error(`      ${err.message}`);
    failed++;
  }
}

// ── U1: fresh install — no pre-existing hooks object at all ──────────────────

test('U1: fresh install wires SessionStart (loader-hook) and SessionEnd (loader-stop); Stop untouched', () => {
  const settings = {};
  const result = mergeHooks(settings);

  assert.strictEqual(result.addedStart, true, 'addedStart should be true on a fresh install');
  assert.strictEqual(result.addedSessionEnd, true, 'addedSessionEnd should be true on a fresh install');
  assert.strictEqual(result.removedStop, false, 'removedStop should be false — nothing to remove');

  assert.ok(
    settings.hooks.SessionStart.some((e) => e.command.includes('loader-hook')),
    'SessionStart must contain the loader-hook entry'
  );
  assert.ok(
    settings.hooks.SessionEnd.some((e) => e.command.includes('loader-stop')),
    'SessionEnd must contain the loader-stop entry'
  );
  assert.strictEqual(settings.hooks.Stop.length, 0, 'Stop must be empty on a fresh install');
});

// ── U2: migration — an OLD install has loader-stop under Stop ────────────────

test('U2: re-run on a pre-fix install migrates loader-stop out of Stop and into SessionEnd', () => {
  const settings = {
    hooks: {
      SessionStart: [{ command: 'node /repo/scripts/handoff.js loader-hook' }],
      Stop: [{ command: 'node /repo/scripts/handoff.js loader-stop' }],
    },
  };
  const result = mergeHooks(settings);

  assert.strictEqual(result.addedStart, false, 'loader-hook already present — should not be re-added');
  assert.strictEqual(result.addedSessionEnd, true, 'SessionEnd should gain the migrated loader-stop entry');
  assert.strictEqual(result.removedStop, true, 'the old Stop entry should be reported as removed');

  assert.strictEqual(
    settings.hooks.Stop.some((e) => e.command.includes('loader-stop')),
    false,
    'Stop must no longer contain a loader-stop entry after migration'
  );
  assert.strictEqual(
    settings.hooks.SessionEnd.filter((e) => e.command.includes('loader-stop')).length,
    1,
    'SessionEnd must contain exactly one loader-stop entry after migration'
  );
});

// ── U3: idempotency — running twice on an already-migrated install is a no-op ─

test('U3: running mergeHooks twice on an already-migrated install changes nothing the second time', () => {
  const settings = {
    hooks: {
      SessionStart: [{ command: 'node /repo/scripts/handoff.js loader-hook' }],
      Stop: [],
      SessionEnd: [{ command: 'node /repo/scripts/handoff.js loader-stop' }],
    },
  };
  const first = mergeHooks(settings);
  assert.strictEqual(first.addedStart, false);
  assert.strictEqual(first.addedSessionEnd, false);
  assert.strictEqual(first.removedStop, false);

  const snapshotBefore = JSON.stringify(settings);
  const second = mergeHooks(settings);
  assert.strictEqual(second.addedStart, false, 'second run: addedStart must stay false');
  assert.strictEqual(second.addedSessionEnd, false, 'second run: addedSessionEnd must stay false');
  assert.strictEqual(second.removedStop, false, 'second run: removedStop must stay false');
  assert.strictEqual(JSON.stringify(settings), snapshotBefore, 'settings object must be byte-identical after a no-op re-run');
});

// ── U4: a user's own unrelated hooks are preserved verbatim ──────────────────

test('U4: unrelated pre-existing hooks in SessionStart/Stop/SessionEnd are never touched', () => {
  const settings = {
    hooks: {
      SessionStart: [{ command: 'node /repo/scripts/handoff.js loader-hook' }, { command: 'node /some/other/tool.js' }],
      Stop: [{ command: 'node /repo/scripts/handoff.js loader-stop' }, { command: 'node /another/tool.js' }],
      SessionEnd: [{ command: 'node /yet-another/tool.js' }],
    },
  };
  mergeHooks(settings);

  assert.ok(
    settings.hooks.SessionStart.some((e) => e.command === 'node /some/other/tool.js'),
    'unrelated SessionStart entry must survive'
  );
  assert.ok(
    settings.hooks.Stop.some((e) => e.command === 'node /another/tool.js'),
    'unrelated Stop entry must survive'
  );
  assert.strictEqual(
    settings.hooks.Stop.some((e) => e.command.includes('loader-stop')),
    false,
    'the loader-stop Stop entry must still be removed even alongside an unrelated Stop entry'
  );
  assert.ok(
    settings.hooks.SessionEnd.some((e) => e.command === 'node /yet-another/tool.js'),
    'unrelated pre-existing SessionEnd entry must survive'
  );
  assert.strictEqual(
    settings.hooks.SessionEnd.filter((e) => e.command.includes('loader-stop')).length,
    1,
    'exactly one loader-stop entry should end up in SessionEnd'
  );
});

// ── U5: SessionEnd already has loader-stop AND Stop still has a stale copy ───

test('U5: loader-stop present in both Stop (stale) and SessionEnd (already migrated) — Stop copy removed, SessionEnd not duplicated', () => {
  const settings = {
    hooks: {
      SessionStart: [{ command: 'node /repo/scripts/handoff.js loader-hook' }],
      Stop: [{ command: 'node /repo/scripts/handoff.js loader-stop' }],
      SessionEnd: [{ command: 'node /repo/scripts/handoff.js loader-stop' }],
    },
  };
  const result = mergeHooks(settings);

  assert.strictEqual(result.removedStop, true, 'stale Stop copy must be reported as removed');
  assert.strictEqual(result.addedSessionEnd, false, 'SessionEnd already had it — must not report added');
  assert.strictEqual(settings.hooks.Stop.length, 0, 'Stop must end up empty');
  assert.strictEqual(
    settings.hooks.SessionEnd.filter((e) => e.command.includes('loader-stop')).length,
    1,
    'SessionEnd must not end up with a duplicate loader-stop entry'
  );
});

// ── Summary ───────────────────────────────────────────────────────────────────

console.log('');
console.log(`Results: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
