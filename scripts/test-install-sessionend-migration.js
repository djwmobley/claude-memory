'use strict';

/**
 * test-install-sessionend-migration.js — Regression guard for install.js's
 * mergeHooks() operating on Claude Code's real matcher-wrapped hooks schema
 * (hooks.<Event>: [{ matcher?, hooks: [{ type:'command', command, ... }] }]),
 * across both scope files (user ~/.claude/settings.json and project
 * .claude/settings.local.json), plus the CLI's safety rails: refuse-on-
 * malformed input, backup + atomic write, dry-run diff, and format
 * preservation (indentation / EOL / BOM).
 *
 * This supersedes the flat-schema-only test suite from PR #242: that suite
 * exercised {command} array elements directly, a shape Claude Code's real
 * hooks reference never documents and which a spec-adversary pass (see
 * installjs-adversary-2026-09-06.md) proved was invisible to the old
 * mergeHooks(), causing every re-run to append a duplicate flat entry and
 * never migrate a real loader-stop entry out of Stop.
 *
 * Part A (in-memory, via mergeHooks/isOurs/normalizeCommand/
 * validateHooksSection/detectIndent exported by install.js) covers the
 * adversary's total-classification table row-by-row and F-1..F-10.
 *
 * Part B (file-level, via spawnSync against temp copies of install.js) never
 * touches a real settings file: HOME/USERPROFILE point at an isolated temp
 * dir for every run, and the engine itself is copied out of this checkout
 * into a plain temp directory before any REAL (non-dry-run) write-path test
 * runs it — install.js refuses to write hooks when its own resolved engine
 * path sits inside a `.claude/worktrees/` directory (by design: a worktree
 * checkout is disposable), so a write-path test must exercise a copy that
 * lives outside any worktree, exactly as a normal clone or CI checkout
 * would. The one test that deliberately keeps the ORIGINAL (possibly
 * worktree) location is B-WORKTREE-REFUSAL, which proves the refusal itself.
 *
 * Usage:
 *   node scripts/test-install-sessionend-migration.js
 *
 * No Postgres or Ollama required. Pure Node. Exit 0 = all pass, 1 = failure.
 */

const assert         = require('assert');
const crypto         = require('crypto');
const fs             = require('fs');
const os             = require('os');
const path           = require('path');
const { spawnSync }  = require('child_process');

const {
  mergeHooks,
  isOurs,
  normalizeCommand,
  validateHooksSection,
  detectIndent,
  detectOursPresent,
  serializeSettings,
  reconcileFormatting,
  makeBackupPath,
} = require('./install.js');

const REPO_ROOT       = path.resolve(__dirname, '..');
const REAL_INSTALL_JS = path.join(REPO_ROOT, 'scripts', 'install.js');
const COMMANDS_DIR    = path.join(REPO_ROOT, 'commands', 'handoff');

let passed = 0;
let failed = 0;
const failures = [];

function test(label, fn) {
  try {
    fn();
    console.log(`PASS  ${label}`);
    passed++;
  } catch (err) {
    console.error(`FAIL  ${label}`);
    console.error(`      ${err.message}`);
    failures.push(label);
    failed++;
  }
}

const CMD = {
  hookLoaderCmd: 'node /repo/scripts/handoff.js loader-hook',
  hookStopCmd:   'node /repo/scripts/handoff.js loader-stop',
};

// ═══════════════════════════════════════════════════════════════════════════
// PART A — in-memory: identity, validation, and mergeHooks classification
// ═══════════════════════════════════════════════════════════════════════════

// ── S2 identity: normalizeCommand ────────────────────────────────────────────

test('normalizeCommand: collapses whitespace, backslashes -> forward slashes, folds only the drive letter', () => {
  assert.strictEqual(
    normalizeCommand('  node   C:\\Repo\\Scripts\\handoff.js   loader-hook  '),
    'node c:/Repo/Scripts/handoff.js loader-hook'
  );
});

test('normalizeCommand: non-string input returns empty string, never throws', () => {
  assert.strictEqual(normalizeCommand(null), '');
  assert.strictEqual(normalizeCommand(undefined), '');
  assert.strictEqual(normalizeCommand(42), '');
});

// ── S2 identity: isOurs (F-5) ─────────────────────────────────────────────────

test('isOurs: basic loader-hook matches', () => {
  assert.deepStrictEqual(isOurs('node /repo/scripts/handoff.js loader-hook'), { verb: 'loader-hook' });
});

test('isOurs: node.exe with a Windows backslash path matches', () => {
  assert.deepStrictEqual(isOurs('node.exe C:\\repo\\scripts\\handoff.js loader-stop'), { verb: 'loader-stop' });
});

test('isOurs: double-quoted path containing spaces matches', () => {
  assert.deepStrictEqual(
    isOurs('node "C:/Program Files/repo/scripts/handoff.js" loader-hook'),
    { verb: 'loader-hook' }
  );
});

test('isOurs: HANDOFF_ENGINE=<path> prefix matches', () => {
  assert.deepStrictEqual(
    isOurs('HANDOFF_ENGINE=/x/y/scripts/handoff.js node /x/y/scripts/handoff.js loader-stop'),
    { verb: 'loader-stop' }
  );
});

test('isOurs: ${CLAUDE_PLUGIN_ROOT}-prefixed path matches', () => {
  assert.deepStrictEqual(
    isOurs('node ${CLAUDE_PLUGIN_ROOT}/scripts/handoff.js loader-hook'),
    { verb: 'loader-hook' }
  );
});

test('isOurs (F-5 false-negative guard): quoted path, extra internal whitespace, still matches', () => {
  assert.ok(isOurs('node    "/repo/scripts/handoff.js"   loader-stop'));
});

test('isOurs (F-5/A4 false-positive guard): vendor/handoff.js is NOT ours', () => {
  assert.strictEqual(isOurs('node vendor/handoff.js loader-hook'), null);
});

test('isOurs (A4 false-positive guard): wrapper-for-handoff.js-notifier.js lookalike is NOT ours', () => {
  assert.strictEqual(isOurs('node /opt/wrapper-for-handoff.js-notifier.js loader-hook-lookalike'), null);
});

test('isOurs: extra trailing flag breaks the anchor — NOT ours', () => {
  assert.strictEqual(isOurs('node ./scripts/handoff.js loader-hook --extra-flag'), null);
});

test('isOurs: unrelated command is NOT ours', () => {
  assert.strictEqual(isOurs('node /some/other/tool.js'), null);
});

test('isOurs: non-string / null / number never throws, returns null', () => {
  assert.strictEqual(isOurs(null), null);
  assert.strictEqual(isOurs(undefined), null);
  assert.strictEqual(isOurs(42), null);
});

// ── S5 validation total classification (F-3, F-4) ─────────────────────────────

test('validateHooksSection: absent hooks key is ok', () => {
  assert.deepStrictEqual(validateHooksSection({}), { ok: true });
});

test('validateHooksSection: well-formed matcher-wrapped hooks is ok', () => {
  const r = validateHooksSection({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'x' }] }] } });
  assert.strictEqual(r.ok, true);
});

test('validateHooksSection (F-4): hooks: null is refused, not silently treated as empty', () => {
  assert.strictEqual(validateHooksSection({ hooks: null }).ok, false);
});

test('validateHooksSection: hooks: [] (array) is refused', () => {
  assert.strictEqual(validateHooksSection({ hooks: [] }).ok, false);
});

test('validateHooksSection: hooks: "oops" (primitive) is refused', () => {
  assert.strictEqual(validateHooksSection({ hooks: 'oops' }).ok, false);
});

test('validateHooksSection (F-3): a non-array event value is refused, never silently coerced to []', () => {
  const r = validateHooksSection({ hooks: { SessionStart: { command: 'x' } } });
  assert.strictEqual(r.ok, false);
  assert.match(r.reason, /SessionStart/);
});

test('validateHooksSection: an event array containing a non-object element is refused', () => {
  assert.strictEqual(validateHooksSection({ hooks: { Stop: ['not-an-object'] } }).ok, false);
  assert.strictEqual(validateHooksSection({ hooks: { Stop: [null] } }).ok, false);
  assert.strictEqual(validateHooksSection({ hooks: { Stop: [42] } }).ok, false);
});

test('validateHooksSection: top-level non-object settings is refused', () => {
  assert.strictEqual(validateHooksSection(null).ok, false);
  assert.strictEqual(validateHooksSection([]).ok, false);
});

// ── mergeHooks: total-classification rows ─────────────────────────────────────

test('U1 (fresh install): both verbs added, nothing pre-existing', () => {
  const settings = {};
  const r = mergeHooks(settings, CMD);
  assert.deepStrictEqual(r.added.slice().sort(), ['loader-hook', 'loader-stop']);
  assert.ok(isOurs(settings.hooks.SessionStart[0].hooks[0].command));
  assert.ok(isOurs(settings.hooks.SessionEnd[0].hooks[0].command));
  assert.strictEqual(settings.hooks.SessionStart[0].hooks[0].command, CMD.hookLoaderCmd);
});

test('idempotency: running mergeHooks twice on its own output changes nothing', () => {
  const settings = {};
  mergeHooks(settings, CMD);
  const snapshot = JSON.stringify(settings);
  const r2 = mergeHooks(settings, CMD);
  assert.strictEqual(JSON.stringify(settings), snapshot, 'settings must be byte-identical after a no-op re-run');
  assert.deepStrictEqual(r2, {
    upgraded: [], moved: [], removed: [], added: [], deduped: [], repointed: [], unrecognizedShape: [],
  });
});

test('F-1 (real owner shape): matcher-wrapped groups are recognized, no duplicate flat entries appended, siblings untouched', () => {
  const settings = {
    hooks: {
      SessionStart: [{ hooks: [
        { type: 'command', command: 'node C:/tools/pg-module-repair.js' },
        { type: 'command', command: 'node C:/repo/scripts/handoff.js loader-hook' },
      ] }],
      Stop: [{ hooks: [
        { type: 'command', command: 'node C:/tools/pg-module-repair.js' },
        { type: 'command', command: 'node C:/repo/scripts/handoff.js loader-stop' },
        { type: 'command', command: 'node C:/tools/no-punt-guard.js' },
        { type: 'command', command: 'node C:/tools/handoff-close-worktree-gate.js' },
      ] }],
    },
  };
  const ownerCmd = {
    hookLoaderCmd: 'node C:/repo/scripts/handoff.js loader-hook',
    hookStopCmd:   'node C:/repo/scripts/handoff.js loader-stop',
  };
  const r = mergeHooks(settings, ownerCmd);

  assert.strictEqual(settings.hooks.SessionStart.length, 1, 'no second group appended to SessionStart');
  assert.strictEqual(settings.hooks.SessionStart[0].hooks.length, 2, 'SessionStart siblings untouched, no duplicate loader-hook');

  assert.strictEqual(settings.hooks.Stop[0].hooks.length, 3, 'F-6: 3 unrelated Stop siblings preserved');
  assert.ok(!settings.hooks.Stop[0].hooks.some((h) => isOurs(h.command)), 'loader-stop removed from Stop');

  assert.strictEqual(settings.hooks.SessionEnd.length, 1);
  assert.strictEqual(settings.hooks.SessionEnd[0].hooks.length, 1);
  assert.ok(isOurs(settings.hooks.SessionEnd[0].hooks[0].command));

  assert.deepStrictEqual(r.moved, [{ verb: 'loader-stop', from: 'Stop', to: 'SessionEnd' }]);
  assert.strictEqual(r.added.length, 0, 'loader-hook already present at SessionStart — not "added"');
  assert.strictEqual(r.repointed.length, 0, 'command already matched the target — no repoint needed');
});

test('re-point (S3): a stale engine path on an already-correctly-placed entry is updated in place, siblings kept', () => {
  const settings = {
    hooks: {
      SessionStart: [{ hooks: [
        { type: 'command', command: 'node sibling.js' },
        { type: 'command', command: 'node /old/checkout/scripts/handoff.js loader-hook' },
      ] }],
    },
  };
  const r = mergeHooks(settings, CMD);
  assert.strictEqual(settings.hooks.SessionStart[0].hooks.length, 2, 'sibling preserved, group not duplicated');
  assert.strictEqual(settings.hooks.SessionStart[0].hooks[0].command, 'node sibling.js');
  assert.strictEqual(settings.hooks.SessionStart[0].hooks[1].command, CMD.hookLoaderCmd);
  assert.strictEqual(r.repointed.length, 1);
});

test('matcher-wrapped group with matcher key + no ours inner hook: left completely untouched', () => {
  const settings = { hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'node other.js' }] }] } };
  const before = JSON.stringify(settings);
  mergeHooks(settings, CMD);
  assert.strictEqual(JSON.stringify(settings.hooks.PreToolUse), JSON.stringify(JSON.parse(before).hooks.PreToolUse));
});

test('flat legacy ours entry AT the correct event: upgraded in place, preserves timeout/statusMessage', () => {
  const settings = { hooks: { SessionStart: [{ command: 'node /repo/scripts/handoff.js loader-hook', timeout: 30, statusMessage: 'loading' }] } };
  const r = mergeHooks(settings, CMD);
  assert.strictEqual(settings.hooks.SessionStart.length, 1);
  assert.ok(Array.isArray(settings.hooks.SessionStart[0].hooks));
  assert.strictEqual(settings.hooks.SessionStart[0].hooks[0].timeout, 30);
  assert.strictEqual(settings.hooks.SessionStart[0].hooks[0].statusMessage, 'loading');
  assert.strictEqual(settings.hooks.SessionStart[0].hooks[0].command, CMD.hookLoaderCmd);
  assert.deepStrictEqual(r.upgraded, [{ verb: 'loader-hook', event: 'SessionStart' }]);
});

test('flat legacy ours entry at the WRONG event: moved AND upgraded, extra field preserved', () => {
  const settings = { hooks: { Stop: [{ command: 'node /repo/scripts/handoff.js loader-stop', statusMessage: 'bye' }] } };
  const r = mergeHooks(settings, CMD);
  assert.strictEqual(settings.hooks.Stop.length, 0);
  assert.strictEqual(settings.hooks.SessionEnd.length, 1);
  assert.strictEqual(settings.hooks.SessionEnd[0].hooks[0].statusMessage, 'bye');
  assert.strictEqual(r.moved.length, 1);
  assert.strictEqual(r.upgraded.length, 1);
});

test('S1: flat legacy entry that does NOT match is left untouched and reported as unrecognized_shape', () => {
  const settings = { hooks: { SessionStart: [{ command: 'node /some/other/tool.js' }] } };
  const r = mergeHooks(settings, CMD);
  assert.strictEqual(settings.hooks.SessionStart.length, 2, 'untouched original entry + our new addition');
  assert.strictEqual(settings.hooks.SessionStart[0].command, 'node /some/other/tool.js', 'untouched, same position');
  assert.deepStrictEqual(r.unrecognizedShape, [{ event: 'SessionStart', index: 0 }]);
});

test('unknown entry shape (neither hooks[] nor command string) is left untouched and reported', () => {
  const settings = { hooks: { SessionStart: [{ matcher: 'x' }] } };
  const r = mergeHooks(settings, CMD);
  assert.strictEqual(settings.hooks.SessionStart.length, 2);
  assert.deepStrictEqual(settings.hooks.SessionStart[0], { matcher: 'x' });
  assert.deepStrictEqual(r.unrecognizedShape, [{ event: 'SessionStart', index: 0 }]);
});

test('dedupe: two loader-stop entries (one in Stop, one already in SessionEnd) collapse to exactly one', () => {
  const settings = {
    hooks: {
      Stop: [{ hooks: [{ type: 'command', command: 'node /repo/scripts/handoff.js loader-stop' }] }],
      SessionEnd: [{ hooks: [{ type: 'command', command: 'node /repo/scripts/handoff.js loader-stop' }] }],
      SessionStart: [{ hooks: [{ type: 'command', command: 'node /repo/scripts/handoff.js loader-hook' }] }],
    },
  };
  const r = mergeHooks(settings, CMD);
  assert.strictEqual(settings.hooks.Stop.length, 0, 'Stop group was ours-only, dropped once emptied');
  assert.strictEqual(settings.hooks.SessionEnd.length, 1, 'not duplicated');
  assert.strictEqual(settings.hooks.SessionEnd[0].hooks.length, 1);
  assert.strictEqual(r.deduped.length, 1);
  assert.strictEqual(r.added.length, 0);
});

test('U4-equivalent: unrelated pre-existing hooks in every event are never touched, reordered, or reformatted', () => {
  const settings = {
    hooks: {
      SessionStart: [{ hooks: [
        { type: 'command', command: 'node /repo/scripts/handoff.js loader-hook' },
        { type: 'command', command: 'node /some/other/tool.js' },
      ] }],
      Stop: [{ hooks: [
        { type: 'command', command: 'node /repo/scripts/handoff.js loader-stop' },
        { type: 'command', command: 'node /another/tool.js' },
      ] }],
      SessionEnd: [{ hooks: [{ type: 'command', command: 'node /yet-another/tool.js' }] }],
    },
  };
  mergeHooks(settings, CMD);
  assert.ok(settings.hooks.SessionStart[0].hooks.some((h) => h.command === 'node /some/other/tool.js'));
  assert.ok(settings.hooks.Stop[0].hooks.some((h) => h.command === 'node /another/tool.js'));
  assert.strictEqual(settings.hooks.Stop[0].hooks.length, 1, 'loader-stop removed, unrelated sibling kept');
  assert.ok(settings.hooks.SessionEnd.some((g) => g.hooks.some((h) => h.command === 'node /yet-another/tool.js')));
});

test('key order of untouched top-level keys is preserved (object mutated in place, never rebuilt)', () => {
  const settings = { zzz: 1, hooks: {}, aaa: 2 };
  mergeHooks(settings, CMD);
  assert.deepStrictEqual(Object.keys(settings), ['zzz', 'hooks', 'aaa']);
});

// ── reconcileFormatting / serializeSettings (mixed-indentation regression) ───

test('reconcileFormatting: a stray-tab line among 2-space siblings keeps its original bytes when untouched', () => {
  const original = '{\n  "a": 1,\n\t  "b": 2\n}';
  const naive     = '{\n  "a": 1,\n  "b": 2\n}';
  assert.strictEqual(reconcileFormatting(original, naive), original);
});

test('reconcileFormatting: a genuine content change on the same line is NOT reconciled away', () => {
  const original = '{\n  "a": 1\n}';
  const naive     = '{\n  "a": 2\n}';
  assert.strictEqual(reconcileFormatting(original, naive), naive);
});

test('serializeSettings end-to-end: mixed-indentation sibling keys produce zero diff noise on an unrelated hooks-only change', () => {
  const originalJsonText =
    '{\n' +
    '  "permissions": {\n' +
    '    "allow": [\n' +
    '      "Read(*)",\n' +
    '\t  "Edit",\n' + // stray tab+2sp indent, exactly like the real owner file
    '      "Glob(*)"\n' +
    '    ]\n' +
    '  },\n' +
    '  "hooks": {\n' +
    '    "Stop": [{ "hooks": [{ "type": "command", "command": "node /repo/scripts/handoff.js loader-stop" }] }]\n' +
    '  }\n' +
    '}\n';
  const settings = JSON.parse(originalJsonText);
  mergeHooks(settings, CMD);
  const outText = serializeSettings(settings, { indent: '  ', eol: '\n', hadBOM: false, originalJsonText });
  const editLine = outText.split('\n').find((l) => l.trim() === '"Edit",');
  assert.strictEqual(editLine, '\t  "Edit",', 'the untouched stray-tab line keeps its exact original bytes, not reformatted to 2-space');
});

// ── detectIndent ───────────────────────────────────────────────────────────

test('detectIndent: 2-space file', () => assert.strictEqual(detectIndent('{\n  "a": 1\n}\n'), '  '));
test('detectIndent: 4-space file', () => assert.strictEqual(detectIndent('{\n    "a": 1\n}\n'), '    '));
test('detectIndent: tab file', () => assert.strictEqual(detectIndent('{\n\t"a": 1\n}\n'), '\t'));
test('detectIndent: one-line file defaults to 2 spaces', () => assert.strictEqual(detectIndent('{"a":1}'), '  '));

// ── makeBackupPath: collision-safe naming ───────────────────────────────────
test('makeBackupPath: appends a numeric suffix when the timestamped name already exists, and never overwrites', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'install-backup-collision-'));
  try {
    const target = path.join(dir, 'settings.local.json');
    fs.writeFileSync(target, '{}', 'utf8');
    const ts = '2026-09-06T00-00-00.000Z';
    const base = `${target}.bak-${ts}`;
    fs.writeFileSync(base, 'existing backup 1', 'utf8');

    const first = makeBackupPath(target, ts);
    assert.notStrictEqual(first, base, 'must not reuse a name that already exists on disk');
    assert.ok(!fs.existsSync(first), 'chosen name must be free');

    fs.writeFileSync(first, 'existing backup 2', 'utf8');
    const second = makeBackupPath(target, ts);
    assert.notStrictEqual(second, base);
    assert.notStrictEqual(second, first);
    assert.ok(!fs.existsSync(second), 'second collision also resolves to a free name');

    // makeBackupPath only ever picks a name; it must never itself write/overwrite.
    assert.strictEqual(fs.readFileSync(base, 'utf8'), 'existing backup 1', 'first pre-existing backup left untouched');
    assert.strictEqual(fs.readFileSync(first, 'utf8'), 'existing backup 2', 'second pre-existing backup left untouched');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// PART B — file-level: scope, dry-run diff, backup+atomic, safety, format
// ═══════════════════════════════════════════════════════════════════════════

/** Copy scripts/install.js + commands/handoff/*.md into a plain (non-worktree) temp dir. */
function setupEngineCopy(tmpBase) {
  const engineRoot = path.join(tmpBase, '_engine');
  fs.mkdirSync(path.join(engineRoot, 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(engineRoot, 'commands', 'handoff'), { recursive: true });
  fs.copyFileSync(REAL_INSTALL_JS, path.join(engineRoot, 'scripts', 'install.js'));
  for (const f of fs.readdirSync(COMMANDS_DIR)) {
    if (f.endsWith('.md')) fs.copyFileSync(path.join(COMMANDS_DIR, f), path.join(engineRoot, 'commands', 'handoff', f));
  }
  return path.join(engineRoot, 'scripts', 'install.js');
}

function runEngine(engineScript, cwd, homeDir, extraArgs) {
  return spawnSync(process.execPath, [engineScript, ...extraArgs], {
    cwd,
    env: { ...process.env, HOME: homeDir, USERPROFILE: homeDir },
    timeout: 15000,
    encoding: 'utf8',
  });
}

function freshProject(tmpBase, name) {
  const projectDir = path.join(tmpBase, name, 'project');
  const homeDir    = path.join(tmpBase, name, 'home');
  fs.mkdirSync(projectDir, { recursive: true });
  fs.mkdirSync(homeDir, { recursive: true });
  return { projectDir, homeDir };
}

function projectSettingsPath(projectDir) {
  return path.join(projectDir, '.claude', 'settings.local.json');
}

function userSettingsPath(homeDir) {
  return path.join(homeDir, '.claude', 'settings.json');
}

{
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'install-hooks-test-'));
  try {
    const engineScript = setupEngineCopy(tmpBase);

    // ── B-BACKUP-ATOMIC ───────────────────────────────────────────────────
    test('B-BACKUP-ATOMIC: real write backs up the original, writes atomically, no .tmp- residue', () => {
      const { projectDir, homeDir } = freshProject(tmpBase, 'backup-atomic');
      const settingsFile = projectSettingsPath(projectDir);
      fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
      const original = JSON.stringify({
        permissions: { allow: ['Bash(git:*)'] },
        hooks: { Stop: [{ hooks: [{ type: 'command', command: 'node /old/scripts/handoff.js loader-stop' }] }] },
      }, null, 2) + '\n';
      fs.writeFileSync(settingsFile, original, 'utf8');

      const result = runEngine(engineScript, projectDir, homeDir, ['--force', '--non-interactive']);
      assert.strictEqual(result.status, 0, `install exited ${result.status}; stderr: ${result.stderr}`);

      const dirEntries = fs.readdirSync(path.dirname(settingsFile));
      const backups = dirEntries.filter((f) => f.startsWith('settings.local.json.bak-'));
      const tmps    = dirEntries.filter((f) => f.includes('.tmp-'));
      assert.strictEqual(backups.length, 1, 'exactly one backup file created');
      assert.strictEqual(tmps.length, 0, 'no .tmp- file left behind');
      assert.strictEqual(fs.readFileSync(path.join(path.dirname(settingsFile), backups[0]), 'utf8'), original, 'backup holds the pre-write content byte-for-byte');

      const after = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
      assert.deepStrictEqual(after.permissions, { allow: ['Bash(git:*)'] }, 'unrelated permissions block untouched');
      assert.ok(!after.hooks.Stop.some((g) => Array.isArray(g.hooks) && g.hooks.length === 0), 'no empty group left over');
    });

    // ── B-IDEMPOTENT ─────────────────────────────────────────────────────
    test('B-IDEMPOTENT: a second real run yields byte-identical settings content', () => {
      const { projectDir, homeDir } = freshProject(tmpBase, 'idempotent');
      runEngine(engineScript, projectDir, homeDir, ['--force', '--non-interactive']);
      const firstContent = fs.readFileSync(projectSettingsPath(projectDir), 'utf8');
      const second = runEngine(engineScript, projectDir, homeDir, ['--force', '--non-interactive']);
      assert.strictEqual(second.status, 0, `second run exited ${second.status}; stderr: ${second.stderr}`);
      const secondContent = fs.readFileSync(projectSettingsPath(projectDir), 'utf8');
      assert.strictEqual(secondContent, firstContent, 'settings.local.json content unchanged by a no-op re-run');
    });

    // ── B-BACKUP-FIRST-RUN ───────────────────────────────────────────────
    test('B-BACKUP-FIRST-RUN: first real migrating run creates exactly one .bak- file', () => {
      const { projectDir, homeDir } = freshProject(tmpBase, 'backup-first-run');
      const settingsFile = projectSettingsPath(projectDir);
      fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
      const original = JSON.stringify({
        hooks: { Stop: [{ hooks: [{ type: 'command', command: 'node /old/scripts/handoff.js loader-stop' }] }] },
      }, null, 2) + '\n';
      fs.writeFileSync(settingsFile, original, 'utf8');

      const result = runEngine(engineScript, projectDir, homeDir, ['--force', '--non-interactive']);
      assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
      const backups = fs.readdirSync(path.dirname(settingsFile)).filter((f) => f.startsWith('settings.local.json.bak-'));
      assert.strictEqual(backups.length, 1, 'exactly one backup file after the first migrating run');
    });

    // ── B-NOOP-NO-BACKUP ─────────────────────────────────────────────────
    test('B-NOOP-NO-BACKUP: a re-run on an already-migrated file writes no new backup and no new content', () => {
      const { projectDir, homeDir } = freshProject(tmpBase, 'noop-no-backup');
      const settingsFile = projectSettingsPath(projectDir);
      fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
      const original = JSON.stringify({
        hooks: { Stop: [{ hooks: [{ type: 'command', command: 'node /old/scripts/handoff.js loader-stop' }] }] },
      }, null, 2) + '\n';
      fs.writeFileSync(settingsFile, original, 'utf8');

      const first = runEngine(engineScript, projectDir, homeDir, ['--force', '--non-interactive']);
      assert.strictEqual(first.status, 0, `first run exited ${first.status}; stderr: ${first.stderr}`);
      const backupsAfterFirst = fs.readdirSync(path.dirname(settingsFile)).filter((f) => f.startsWith('settings.local.json.bak-'));
      assert.strictEqual(backupsAfterFirst.length, 1, 'sanity: first run performed a real migration and backed up once');

      const contentBefore = fs.readFileSync(settingsFile, 'utf8');
      const md5Before = crypto.createHash('md5').update(contentBefore).digest('hex');

      const second = runEngine(engineScript, projectDir, homeDir, ['--force', '--non-interactive']);
      assert.strictEqual(second.status, 0, `second run exited ${second.status}; stderr: ${second.stderr}`);
      assert.match(second.stdout, /no changes; nothing written/i, 'no-op run prints the one-line no-op summary');

      const backupsAfterSecond = fs.readdirSync(path.dirname(settingsFile)).filter((f) => f.startsWith('settings.local.json.bak-'));
      assert.strictEqual(backupsAfterSecond.length, 1, 'no new backup file created by the no-op second run');

      const contentAfter = fs.readFileSync(settingsFile, 'utf8');
      const md5After = crypto.createHash('md5').update(contentAfter).digest('hex');
      assert.strictEqual(md5After, md5Before, 'settings file content (md5) unchanged by the no-op run');
    });

    // ── B-DRYRUN-NOOP ─────────────────────────────────────────────────────
    test('B-DRYRUN-NOOP: --dry-run writes nothing at all, prints a diff', () => {
      const { projectDir, homeDir } = freshProject(tmpBase, 'dryrun-noop');
      const settingsFile = projectSettingsPath(projectDir);
      fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
      const original = JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'node /old/scripts/handoff.js loader-stop' }] }] } }, null, 2) + '\n';
      fs.writeFileSync(settingsFile, original, 'utf8');

      const result = runEngine(engineScript, projectDir, homeDir, ['--dry-run']);
      assert.strictEqual(result.status, 0, `dry-run exited ${result.status}; stderr: ${result.stderr}`);
      assert.strictEqual(fs.readFileSync(settingsFile, 'utf8'), original, 'file untouched');
      const siblingFiles = fs.readdirSync(path.dirname(settingsFile));
      assert.strictEqual(siblingFiles.length, 1, 'no backup, no tmp file created during dry-run');
      assert.ok(!fs.existsSync(path.join(projectDir, '.claude', 'commands')), 'dry-run never copies command files');
      assert.match(result.stdout, /Diff:/, 'F-7: dry-run prints a diff section');
      assert.match(result.stdout, /@@/, 'F-7: dry-run diff contains a unified-diff hunk header');
    });

    // ── B-MALFORMED-REFUSE ────────────────────────────────────────────────
    test('B-MALFORMED-REFUSE (F-10): invalid JSON refuses with exit 2 and leaves the file byte-identical', () => {
      const { projectDir, homeDir } = freshProject(tmpBase, 'malformed');
      const settingsFile = projectSettingsPath(projectDir);
      fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
      const original = '{ "permissions": { "allow": ["Bash(git:*)",] } }'; // trailing comma
      fs.writeFileSync(settingsFile, original, 'utf8');

      const result = runEngine(engineScript, projectDir, homeDir, ['--force', '--non-interactive']);
      assert.strictEqual(result.status, 2, `expected exit 2, got ${result.status}; stdout: ${result.stdout}`);
      assert.match(result.stderr, /Refusing:/);
      assert.strictEqual(fs.readFileSync(settingsFile, 'utf8'), original, 'malformed file left byte-identical, permissions never wiped');
    });

    // ── B-INDENT (2sp / 4sp / tab / one-line) ─────────────────────────────
    for (const [label, seedIndent] of [['2-space', '  '], ['4-space', '    '], ['tab', '\t']]) {
      test(`B-INDENT ${label}: preserved on write`, () => {
        const { projectDir, homeDir } = freshProject(tmpBase, `indent-${label}`);
        const settingsFile = projectSettingsPath(projectDir);
        fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
        const original = JSON.stringify({ permissions: { allow: ['x'] } }, null, seedIndent) + '\n';
        fs.writeFileSync(settingsFile, original, 'utf8');

        const result = runEngine(engineScript, projectDir, homeDir, ['--force', '--non-interactive']);
        assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
        const after = fs.readFileSync(settingsFile, 'utf8');
        const firstIndentedLine = after.split(/\r?\n/).find((l) => /^[ \t]+\S/.test(l));
        const unit = seedIndent === '\t' ? '\t' : seedIndent;
        assert.ok(firstIndentedLine.startsWith(unit), `expected indent unit ${JSON.stringify(unit)} in line ${JSON.stringify(firstIndentedLine)}`);
      });
    }

    test('B-INDENT one-line: source has no newlines, output is pretty-printed with 2-space indent', () => {
      const { projectDir, homeDir } = freshProject(tmpBase, 'indent-one-line');
      const settingsFile = projectSettingsPath(projectDir);
      fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
      fs.writeFileSync(settingsFile, '{"permissions":{"allow":["x"]}}', 'utf8');

      const result = runEngine(engineScript, projectDir, homeDir, ['--force', '--non-interactive']);
      assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
      const after = fs.readFileSync(settingsFile, 'utf8');
      assert.ok(after.includes('\n  "'), 'output re-indented with 2 spaces per S5');
    });

    // ── B-CRLF ─────────────────────────────────────────────────────────────
    test('B-CRLF: CRLF line endings preserved end to end', () => {
      const { projectDir, homeDir } = freshProject(tmpBase, 'crlf');
      const settingsFile = projectSettingsPath(projectDir);
      fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
      const original = (JSON.stringify({ permissions: { allow: ['x'] } }, null, 2) + '\n').replace(/\n/g, '\r\n');
      fs.writeFileSync(settingsFile, original, 'utf8');

      const result = runEngine(engineScript, projectDir, homeDir, ['--force', '--non-interactive']);
      assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
      const after = fs.readFileSync(settingsFile, 'utf8');
      assert.ok(after.includes('\r\n'), 'CRLF present');
      assert.ok(!/[^\r]\n/.test(after), 'no bare LF (every \\n is preceded by \\r)');
    });

    // ── B-BOM ────────────────────────────────────────────────────────────
    test('B-BOM: UTF-8 BOM preserved end to end', () => {
      const { projectDir, homeDir } = freshProject(tmpBase, 'bom');
      const settingsFile = projectSettingsPath(projectDir);
      fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
      const original = '\uFEFF' + JSON.stringify({ permissions: { allow: ['x'] } }, null, 2) + '\n';
      fs.writeFileSync(settingsFile, original, 'utf8');

      const result = runEngine(engineScript, projectDir, homeDir, ['--force', '--non-interactive']);
      assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
      const buf = fs.readFileSync(settingsFile);
      assert.strictEqual(buf[0], 0xef);
      assert.strictEqual(buf[1], 0xbb);
      assert.strictEqual(buf[2], 0xbf);
    });

    // ── B-SCOPE-USER-EXPLICIT ────────────────────────────────────────────
    test('B-SCOPE-USER-EXPLICIT (F-2): --hooks-scope user writes the user-scope file, leaves project file untouched', () => {
      const { projectDir, homeDir } = freshProject(tmpBase, 'scope-user');
      const projFile = projectSettingsPath(projectDir);
      fs.mkdirSync(path.dirname(projFile), { recursive: true });
      fs.writeFileSync(projFile, '{}\n', 'utf8');

      const result = runEngine(engineScript, projectDir, homeDir, ['--force', '--non-interactive', '--hooks-scope', 'user']);
      assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
      assert.strictEqual(fs.readFileSync(projFile, 'utf8'), '{}\n', 'project file untouched');
      const userFile = userSettingsPath(homeDir);
      assert.ok(fs.existsSync(userFile), 'user-scope file created');
      const userSettings = JSON.parse(fs.readFileSync(userFile, 'utf8'));
      assert.ok(isOurs(userSettings.hooks.SessionStart[0].hooks[0].command));
    });

    // ── B-SCOPE-AUTO-DETECTS-USER ────────────────────────────────────────
    test('B-SCOPE-AUTO-DETECTS-USER (F-2): auto scope prefers an existing user-scope entry over project', () => {
      const { projectDir, homeDir } = freshProject(tmpBase, 'scope-auto-user');
      const userFile = userSettingsPath(homeDir);
      fs.mkdirSync(path.dirname(userFile), { recursive: true });
      fs.writeFileSync(userFile, JSON.stringify({
        hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'node /old/scripts/handoff.js loader-hook' }] }] },
      }, null, 2) + '\n', 'utf8');

      const result = runEngine(engineScript, projectDir, homeDir, ['--force', '--non-interactive']);
      assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
      assert.ok(!fs.existsSync(projectSettingsPath(projectDir)), 'project-scope file never created — auto chose user scope');
      const userSettings = JSON.parse(fs.readFileSync(userFile, 'utf8'));
      assert.ok(isOurs(userSettings.hooks.SessionEnd[0].hooks[0].command), 'loader-stop wired into the user-scope file');
    });

    // ── B-SCOPE-AUTO-DEFAULTS-PROJECT ────────────────────────────────────
    test('B-SCOPE-AUTO-DEFAULTS-PROJECT: with nothing pre-existing anywhere, auto defaults to project scope', () => {
      const { projectDir, homeDir } = freshProject(tmpBase, 'scope-auto-default');
      const result = runEngine(engineScript, projectDir, homeDir, ['--force', '--non-interactive']);
      assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
      assert.ok(fs.existsSync(projectSettingsPath(projectDir)), 'project-scope file created by default');
      assert.ok(!fs.existsSync(userSettingsPath(homeDir)), 'user-scope file never created');
    });

    // ── B-ENGINE-PATH-REQUIRES-DRYRUN ────────────────────────────────────
    test('B-ENGINE-PATH-REQUIRES-DRYRUN: --engine-path without --dry-run refuses', () => {
      const { projectDir, homeDir } = freshProject(tmpBase, 'engine-path-guard');
      const result = runEngine(engineScript, projectDir, homeDir, ['--engine-path', '/x/y/handoff.js', '--force', '--non-interactive']);
      assert.strictEqual(result.status, 2);
      assert.match(result.stderr, /--engine-path may only be used together with --dry-run/);
      assert.ok(!fs.existsSync(projectSettingsPath(projectDir)));
    });

    // ── B-HOOKS-SCOPE-INVALID ─────────────────────────────────────────────
    test('B-HOOKS-SCOPE-INVALID: an unrecognized --hooks-scope value refuses', () => {
      const { projectDir, homeDir } = freshProject(tmpBase, 'scope-invalid');
      const result = runEngine(engineScript, projectDir, homeDir, ['--hooks-scope', 'bogus']);
      assert.strictEqual(result.status, 2);
      assert.match(result.stderr, /--hooks-scope must be one of/);
    });

  } finally {
    fs.rmSync(tmpBase, { recursive: true, force: true });
  }
}

// ── B-WORKTREE-REFUSAL: exercises the REAL (possibly worktree-checked-out) install.js ──

test('B-WORKTREE-REFUSAL: install.js run from within a .claude/worktrees checkout refuses, zero I/O', () => {
  const isWorktree = /[\\/]\.claude[\\/]worktrees[\\/]/i.test(REPO_ROOT);
  if (!isWorktree) {
    console.log('      (skipped: this checkout is not inside .claude/worktrees/ — refusal path not exercised here)');
    return;
  }
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'install-worktree-guard-'));
  try {
    const { projectDir, homeDir } = freshProject(tmpBase, 'wt');
    const result = runEngine(REAL_INSTALL_JS, projectDir, homeDir, ['--force', '--non-interactive']);
    assert.strictEqual(result.status, 2, `expected refusal exit 2, got ${result.status}`);
    assert.match(result.stderr, /git worktree checkout/);
    assert.ok(!fs.existsSync(path.join(projectDir, '.claude')), 'no .claude dir created — refusal is zero-I/O');
  } finally {
    fs.rmSync(tmpBase, { recursive: true, force: true });
  }
});

test('B-WORKTREE-DRYRUN-OVERRIDE (S9): --dry-run + --engine-path bypasses the worktree refusal', () => {
  const isWorktree = /[\\/]\.claude[\\/]worktrees[\\/]/i.test(REPO_ROOT);
  if (!isWorktree) {
    console.log('      (skipped: this checkout is not inside .claude/worktrees/)');
    return;
  }
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'install-worktree-override-'));
  try {
    const { projectDir, homeDir } = freshProject(tmpBase, 'wt-override');
    const result = runEngine(REAL_INSTALL_JS, projectDir, homeDir, [
      '--dry-run', '--engine-path', 'C:/pretend/scripts/handoff.js',
    ]);
    assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
    assert.match(result.stdout, /pretend\/scripts\/handoff\.js/);
  } finally {
    fs.rmSync(tmpBase, { recursive: true, force: true });
  }
});

// ═══════════════════════════════════════════════════════════════════════════

console.log('');
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log(`Failed: ${failures.join(', ')}`);
}
process.exit(failed > 0 ? 1 : 0);
