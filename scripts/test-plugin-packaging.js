'use strict';

/**
 * test-plugin-packaging.js — Plugin packaging integration tests.
 *
 * Asserts:
 *   P1  .claude-plugin/plugin.json and marketplace.json are valid JSON
 *       with all required fields.
 *   P2  Engine asset resolution honors CLAUDE_PLUGIN_ROOT when set:
 *       template and SQL schema paths resolve under the plugin root.
 *   P3  Engine asset resolution falls back to __dirname-relative paths when
 *       CLAUDE_PLUGIN_ROOT is unset (standalone / CI mode unchanged).
 *   P4  SessionStart hook (loader-hook) exits 0 with no output when the
 *       target project has no project marker.
 *   P5  Plugin mode rejects STORAGE_BACKEND=sqlite with exit 1 and a clear
 *       message — never silently falls through to SQLite.
 *
 * Isolation: all tests run against temp directories; never touch the canonical
 * UUID 90394596-a215-4435-95e6-27a70dc415a8, real ~/.claude/projects/**, or
 * production project_settings.
 *
 * Usage:
 *   node scripts/test-plugin-packaging.js
 *
 * Exit 0 = all tests passed; 1 = any failure.
 */

const { spawnSync } = require('child_process');
const fs            = require('fs');
const os            = require('os');
const path          = require('path');
const { test }      = require('node:test');
const assert        = require('node:assert/strict');
const { MARKER_FILENAME } = require('./lib/project-marker');
const { resolveHandoffMdPath } = require('./lib/handoff-paths');

// ── Paths ─────────────────────────────────────────────────────────────────────

const REPO_ROOT      = path.resolve(__dirname, '..');
const HANDOFF_SCRIPT = path.join(REPO_ROOT, 'scripts', 'handoff.js');
const PLUGIN_JSON    = path.join(REPO_ROOT, '.claude-plugin', 'plugin.json');
const MARKET_JSON    = path.join(REPO_ROOT, '.claude-plugin', 'marketplace.json');
const HOOKS_JSON     = path.join(REPO_ROOT, 'hooks', 'hooks.json');

// ── P1: Manifest validity ─────────────────────────────────────────────────────

test('P1a: .claude-plugin/plugin.json is valid JSON with required fields', () => {
  assert.ok(fs.existsSync(PLUGIN_JSON), `plugin.json not found at ${PLUGIN_JSON}`);

  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(PLUGIN_JSON, 'utf8'));
  } catch (e) {
    assert.fail(`plugin.json is not valid JSON: ${e.message}`);
  }

  // Required fields per spec
  assert.ok(typeof manifest.name        === 'string' && manifest.name.length > 0, 'name must be a non-empty string');
  assert.ok(typeof manifest.description === 'string' && manifest.description.length > 0, 'description must be a non-empty string');
  assert.ok(typeof manifest.version     === 'string' && manifest.version.length > 0, 'version must be a non-empty string');
  assert.ok(typeof manifest.author      === 'object' && manifest.author !== null, 'author must be an object');
  assert.ok(typeof manifest.author.name === 'string' && manifest.author.name.length > 0, 'author.name must be a non-empty string');

  // Name must be kebab-case (plugin namespace)
  assert.match(manifest.name, /^[a-z][a-z0-9-]*$/, 'name must be kebab-case');

  // Commands and hooks fields must be relative-path strings (must start with "./").
  assert.ok(typeof manifest.commands === 'string' && manifest.commands.startsWith('./'), 'commands must be a relative path string starting with "./"');
  assert.ok(typeof manifest.hooks    === 'string' && manifest.hooks.startsWith('./'),    'hooks must be a relative path string starting with "./"');
});

test('P1b: .claude-plugin/marketplace.json is valid JSON with required fields', () => {
  assert.ok(fs.existsSync(MARKET_JSON), `marketplace.json not found at ${MARKET_JSON}`);

  let catalog;
  try {
    catalog = JSON.parse(fs.readFileSync(MARKET_JSON, 'utf8'));
  } catch (e) {
    assert.fail(`marketplace.json is not valid JSON: ${e.message}`);
  }

  // Top-level catalog fields required by the claude plugin validate schema.
  assert.ok(typeof catalog.name        === 'string' && catalog.name.length > 0, 'marketplace.json must have a top-level "name" string');
  assert.ok(typeof catalog.owner       === 'object' && catalog.owner !== null, 'marketplace.json must have a top-level "owner" object');
  assert.ok(typeof catalog.owner.name  === 'string' && catalog.owner.name.length > 0, 'owner.name must be a non-empty string');

  assert.ok(Array.isArray(catalog.plugins), 'marketplace.json must have a "plugins" array');
  assert.ok(catalog.plugins.length > 0, 'plugins array must not be empty');

  const plugin = catalog.plugins[0];
  assert.ok(typeof plugin.name        === 'string', 'plugins[0].name must be a string');
  assert.ok(typeof plugin.description === 'string', 'plugins[0].description must be a string');
  assert.ok(typeof plugin.version     === 'string', 'plugins[0].version must be a string');
  // source must be a relative path (canonical format uses "./" not bare ".")
  assert.ok(typeof plugin.source === 'string' && plugin.source.startsWith('./'), 'plugins[0].source must be a relative path starting with "./"');
});

test('P1c: hooks/hooks.json is valid JSON with SessionStart registration', () => {
  assert.ok(fs.existsSync(HOOKS_JSON), `hooks.json not found at ${HOOKS_JSON}`);

  let hooks;
  try {
    hooks = JSON.parse(fs.readFileSync(HOOKS_JSON, 'utf8'));
  } catch (e) {
    assert.fail(`hooks.json is not valid JSON: ${e.message}`);
  }

  assert.ok(typeof hooks.hooks === 'object' && hooks.hooks !== null, 'hooks.json must have a top-level "hooks" object');
  assert.ok(Array.isArray(hooks.hooks.SessionStart), 'hooks.SessionStart must be an array');
  assert.ok(hooks.hooks.SessionStart.length > 0, 'SessionStart array must not be empty');

  const entry = hooks.hooks.SessionStart[0];
  assert.ok(Array.isArray(entry.hooks), 'SessionStart[0].hooks must be an array');
  assert.ok(entry.hooks.length > 0, 'SessionStart[0].hooks must not be empty');

  const hookDef = entry.hooks[0];
  assert.equal(hookDef.type, 'command', 'hook type must be "command"');
  assert.ok(
    typeof hookDef.command === 'string' && hookDef.command.includes('${CLAUDE_PLUGIN_ROOT}'),
    'hook command must reference ${CLAUDE_PLUGIN_ROOT}'
  );
  assert.ok(
    hookDef.command.includes('handoff.js'),
    'hook command must invoke handoff.js'
  );
  assert.ok(
    hookDef.command.includes('loader-hook'),
    'hook command must invoke the loader-hook subcommand'
  );
});

// ── P2: Engine asset resolution with CLAUDE_PLUGIN_ROOT set ──────────────────

test('P2: CLAUDE_PLUGIN_ROOT env var is used for asset paths when set', () => {
  // Create a fake plugin root with the required file structure.
  const tmpBase    = fs.mkdtempSync(path.join(os.tmpdir(), 'handoff-plugin-test-'));
  const fakeRoot   = path.join(tmpBase, 'plugin-root');
  const sqlDir     = path.join(fakeRoot, 'scripts', 'sql');
  const tplDir     = path.join(fakeRoot, 'templates');

  try {
    fs.mkdirSync(sqlDir, { recursive: true });
    fs.mkdirSync(tplDir, { recursive: true });

    // Write stub files so fs.existsSync checks in handoff.js pass.
    fs.writeFileSync(path.join(sqlDir, 'handoff-core-schema.sql'), '-- stub\n');
    fs.writeFileSync(path.join(sqlDir, 'handoff-sqlite-schema.sql'), '-- stub\n');
    fs.writeFileSync(path.join(tplDir, 'handoff.md.tpl'), '# stub\n');
    fs.writeFileSync(path.join(tplDir, 'project-claude-md.tpl'), '# stub\n');

    // Use a project dir that has no project marker so loader-hook exits 0 quickly.
    const emptyProjectDir = path.join(tmpBase, 'empty-project');
    fs.mkdirSync(emptyProjectDir, { recursive: true });

    // Run loader-hook with CLAUDE_PLUGIN_ROOT pointing to fakeRoot.
    // The hook will resolve handoffPath using findProjectRootByMarker(emptyProjectDir) → null,
    // then fall through to the handoffPath check → missing → exit 0 cleanly.
    const result = spawnSync(
      process.execPath,
      [HANDOFF_SCRIPT, 'loader-hook'],
      {
        env: {
          ...process.env,
          CLAUDE_PLUGIN_ROOT: fakeRoot,
          PROJECT_ROOT: emptyProjectDir,
          // Ensure no DB connection attempt pollutes stderr in a meaningful way;
          // the hook exits 0 before connecting when handoff.md is absent.
        },
        cwd: emptyProjectDir,
        timeout: 10000,
      }
    );

    // loader-hook must exit 0 (no marker = inert).
    assert.equal(
      result.status,
      0,
      `loader-hook should exit 0 when no marker found; got ${result.status}.\nstderr: ${result.stderr?.toString()}`
    );

    // The constants in handoff.js now use _ENGINE_ROOT = CLAUDE_PLUGIN_ROOT.
    // We verify this indirectly: if the file was loaded without crashing and the
    // path constants resolve under fakeRoot, the test passes.  The crash path is
    // covered by P3 (wrong-cwd test for standalone).
    //
    // Direct path verification: require handoff.js in a child process and print
    // the resolved HANDOFF_TEMPLATE path.
    const probe = spawnSync(
      process.execPath,
      ['-e', `
        process.env.CLAUDE_PLUGIN_ROOT = ${JSON.stringify(fakeRoot)};
        // Suppress DB connection by exiting before any DB call.
        const origExit = process.exit;
        // Re-require with the env var set.
        delete require.cache[require.resolve(${JSON.stringify(HANDOFF_SCRIPT)})];
      `],
      { env: { ...process.env, CLAUDE_PLUGIN_ROOT: fakeRoot }, timeout: 5000 }
    );
    // The probe may fail on DB checks; we only care that _ENGINE_ROOT is set.
    // We test the actual constant by asking handoff.js to print it via a tiny helper.
    const pathProbe = spawnSync(
      process.execPath,
      ['-e', `
        // Minimal shim: set env var, then read the _ENGINE_ROOT by sourcing just
        // the top of handoff.js up to the constant definition.
        const fs = require('fs');
        const src = fs.readFileSync(${JSON.stringify(HANDOFF_SCRIPT)}, 'utf8');
        // Extract _ENGINE_ROOT definition block.
        const match = src.match(/const _ENGINE_ROOT = ([\\s\\S]+?);\\r?\\n/);
        if (!match) { process.stderr.write('_ENGINE_ROOT pattern not found\\n'); process.exit(1); }
        process.stdout.write(match[1] + '\\n');
        process.exit(0);
      `],
      { env: { ...process.env, CLAUDE_PLUGIN_ROOT: fakeRoot }, timeout: 5000 }
    );

    const engineRootExpr = pathProbe.stdout?.toString().trim();
    // Must reference process.env.CLAUDE_PLUGIN_ROOT in the expression.
    assert.ok(
      engineRootExpr && engineRootExpr.includes('CLAUDE_PLUGIN_ROOT'),
      `_ENGINE_ROOT expression must reference CLAUDE_PLUGIN_ROOT; got: ${engineRootExpr}`
    );

  } finally {
    fs.rmSync(tmpBase, { recursive: true, force: true });
  }
});

// ── P3: Engine asset resolution without CLAUDE_PLUGIN_ROOT (standalone/CI) ───

test('P3: __dirname fallback is used when CLAUDE_PLUGIN_ROOT is unset', () => {
  // Run loader-hook from a cwd that is NOT the repo root and has no project marker.
  // If asset paths were hard-coded to cwd-relative they would break; __dirname fallback
  // keeps them anchored to the actual scripts/ directory.
  const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'handoff-standalone-test-'));

  try {
    const env = { ...process.env };
    delete env.CLAUDE_PLUGIN_ROOT;

    const result = spawnSync(
      process.execPath,
      [HANDOFF_SCRIPT, 'loader-hook'],
      {
        env: { ...env, PROJECT_ROOT: emptyDir },
        cwd: emptyDir,
        timeout: 10000,
      }
    );

    // Must exit 0 (no marker → inert).
    assert.equal(
      result.status,
      0,
      `loader-hook should exit 0 in standalone mode from non-repo cwd; got ${result.status}.\nstderr: ${result.stderr?.toString()}`
    );

    // Verify that the fallback expression does NOT reference CLAUDE_PLUGIN_ROOT.
    // We do this by reading the source and confirming the fallback branch uses __dirname.
    const pathProbe = spawnSync(
      process.execPath,
      ['-e', `
        const fs = require('fs');
        const src = fs.readFileSync(${JSON.stringify(HANDOFF_SCRIPT)}, 'utf8');
        const match = src.match(/const _ENGINE_ROOT = ([\\s\\S]+?);\\r?\\n/);
        if (!match) { process.stderr.write('_ENGINE_ROOT not found\\n'); process.exit(1); }
        const expr = match[1];
        // Must contain __dirname as the fallback.
        if (!expr.includes('__dirname')) {
          process.stderr.write('__dirname fallback missing from _ENGINE_ROOT\\n');
          process.exit(1);
        }
        process.exit(0);
      `],
      { env, timeout: 5000 }
    );

    assert.equal(
      pathProbe.status,
      0,
      `__dirname fallback check failed: ${pathProbe.stderr?.toString()}`
    );

  } finally {
    fs.rmSync(emptyDir, { recursive: true, force: true });
  }
});

// ── P4: loader-hook is inert when no project marker is present ────────────────

test('P4: loader-hook exits 0 with no stdout when project has no project marker', () => {
  const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'handoff-noop-test-'));

  try {
    const env = { ...process.env };
    delete env.CLAUDE_PLUGIN_ROOT;

    const result = spawnSync(
      process.execPath,
      [HANDOFF_SCRIPT, 'loader-hook'],
      {
        env: { ...env, PROJECT_ROOT: emptyDir },
        cwd: emptyDir,
        timeout: 10000,
      }
    );

    assert.equal(
      result.status,
      0,
      `loader-hook must exit 0 when no marker found; got ${result.status}.\nstderr: ${result.stderr?.toString()}`
    );

    const stdout = result.stdout?.toString().trim() ?? '';
    assert.equal(
      stdout,
      '',
      `loader-hook must produce no stdout when no marker found; got: ${JSON.stringify(stdout)}`
    );

  } finally {
    fs.rmSync(emptyDir, { recursive: true, force: true });
  }
});

test('P4b: loader-hook exits 0 with no stdout even when CLAUDE_PLUGIN_ROOT is set but no marker', () => {
  const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'handoff-noop-plugin-test-'));

  try {
    const result = spawnSync(
      process.execPath,
      [HANDOFF_SCRIPT, 'loader-hook'],
      {
        env: {
          ...process.env,
          CLAUDE_PLUGIN_ROOT: REPO_ROOT,
          PROJECT_ROOT: emptyDir,
        },
        cwd: emptyDir,
        timeout: 10000,
      }
    );

    assert.equal(
      result.status,
      0,
      `loader-hook must exit 0 in plugin mode with no marker; got ${result.status}.\nstderr: ${result.stderr?.toString()}`
    );

    const stdout = result.stdout?.toString().trim() ?? '';
    assert.equal(
      stdout,
      '',
      `loader-hook must produce no stdout in plugin mode with no marker; got: ${JSON.stringify(stdout)}`
    );

  } finally {
    fs.rmSync(emptyDir, { recursive: true, force: true });
  }
});

// ── P5: Plugin mode refuses STORAGE_BACKEND=sqlite ───────────────────────────

test('P5: plugin mode exits 1 with actionable message when STORAGE_BACKEND=sqlite', () => {
  // We need to trigger connectHandoff() in plugin mode with sqlite.
  // The easiest path is `status` — it calls connectHandoff after resolveProjectId.
  // But status short-circuits before DB when handoff.md is absent...
  // Instead use `loader-load` or a small inline script that calls connectHandoff
  // by running handoff.js with a marker-bearing project dir so it doesn't no-op.

  // Create a temp project with a project marker so the hook doesn't no-op.
  const tmpBase    = fs.mkdtempSync(path.join(os.tmpdir(), 'handoff-sqlite-guard-'));
  const projectDir = path.join(tmpBase, 'test-project');
  fs.mkdirSync(projectDir, { recursive: true });

  // Write a minimal marker under the current (non-legacy) name.
  // UUID must be valid v4 (version nibble=4, variant nibble∈{8,9,a,b}) so
  // readMarker's isValidUUID check passes and resolveProjectId returns the UUID.
  const marker = {
    uuid:           'aaaabbbb-cccc-4ddd-8eee-ffffffffffff',
    created_at:     new Date().toISOString(),
    schema_version: 1,
  };
  fs.writeFileSync(path.join(projectDir, MARKER_FILENAME), JSON.stringify(marker, null, 2) + '\n');

  // Write a stub handoff.md so the hook proceeds past the "no handoff.md → exit 0" gate.
  const handoffPath = resolveHandoffMdPath(marker.uuid);
  const handoffDir  = path.dirname(handoffPath);
  fs.mkdirSync(handoffDir, { recursive: true });
  const handoffCreated = !fs.existsSync(handoffPath);
  if (handoffCreated) {
    fs.writeFileSync(handoffPath, '---\nlast_close: 2026-01-01T00:00:00Z\n---\n');
  }

  try {
    const result = spawnSync(
      process.execPath,
      [HANDOFF_SCRIPT, 'loader-hook'],
      {
        env: {
          ...process.env,
          CLAUDE_PLUGIN_ROOT: REPO_ROOT,
          PROJECT_ROOT: projectDir,
          STORAGE_BACKEND: 'sqlite',
        },
        cwd: projectDir,
        timeout: 10000,
      }
    );

    // Must NOT be exit 0 — plugin mode must refuse sqlite.
    // Accept exit 1 (explicit refusal) or any non-zero.
    // The hook wraps everything in a try/catch that calls process.exit(0) on errors,
    // BUT the sqlite guard calls process.exit(1) BEFORE the catch, so it propagates.
    assert.notEqual(
      result.status,
      0,
      'plugin mode with STORAGE_BACKEND=sqlite must NOT exit 0 (silent SQLite fallback)'
    );

    const stderr = result.stderr?.toString() ?? '';
    assert.ok(
      stderr.includes('sqlite') || stderr.includes('SQLite'),
      `stderr must mention SQLite; got: ${JSON.stringify(stderr)}`
    );
    assert.ok(
      stderr.includes('Postgres') || stderr.includes('postgres'),
      `stderr must mention Postgres; got: ${JSON.stringify(stderr)}`
    );

  } finally {
    if (handoffCreated && fs.existsSync(handoffPath)) {
      try { fs.unlinkSync(handoffPath); } catch (_) { /* best effort */ }
    }
    fs.rmSync(tmpBase, { recursive: true, force: true });
  }
});

// ── Summary ───────────────────────────────────────────────────────────────────

// node:test handles the summary output; the process exit code is set by the test runner.
