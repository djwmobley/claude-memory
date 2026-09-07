'use strict';

/**
 * test-claude-md-key-paths.js — cm#263 AUTHOR task: portable "## Key paths"
 * section rendering for the generated project CLAUDE.md.
 *
 * Ground truth:
 *   - templates/project-claude-md.tpl declares {{KEY_PATHS_HANDOFF_PATH}} and
 *     {{KEY_PATHS_HELPER_PATH}} (no filesystem-absolute segment interpolated;
 *     the legacy {{HANDOFF_MD_PATH}}/{{PROJECT_ROOT}} placeholders are gone).
 *   - scripts/lib/claude-md-key-paths.js's renderKeyPathsBullets(env) computes
 *     the two symbolic bullet values, mirroring resolveBaseDir()'s precedence
 *     (scripts/lib/handoff-paths.js): HANDOFF_BASE_DIR, else CLAUDE_CONFIG_DIR,
 *     else ~/.claude. Helper script: CLAUDE_PLUGIN_ROOT if set, else
 *     <engine-root> (never <repo-root> — the target project is not the engine).
 *
 * Scope: this test covers ONLY the rendering path (what a fresh `handoff
 * init` writes). It does NOT cover healing an already-generated CLAUDE.md
 * (out of scope for cm#263's AUTHOR task — see the spec's "Nothing else"
 * clause).
 *
 * Pure-unit, no DB, no network, no filesystem writes beyond none — reads the
 * real .tpl file only.
 *
 * Usage: node test/test-claude-md-key-paths.js
 * Exit 0 = all pass; nonzero = any failure.
 */

const fs   = require('fs');
const path = require('path');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const {
  renderKeyPathsBullets,
  isAbsolutePath,
  isPortableForm,
} = require(path.join(PROJECT_ROOT, 'scripts', 'lib', 'claude-md-key-paths.js'));

let passed = 0, failed = 0;
function test(label, fn) {
  try {
    fn();
    console.log(`  [PASS] ${label}`);
    passed++;
  } catch (err) {
    console.error(`  [FAIL] ${label}: ${err.message}`);
    failed++;
  }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }
function assertEqual(actual, expected, msg) {
  if (actual !== expected) {
    throw new Error(`${msg || 'assertEqual'} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

// Total-classification set of shapes a filesystem-absolute path can take:
// Windows drive-letter root, UNC, POSIX root, and MSYS-translated /c/...
// forms. A hit on ANY of these in a rendered bullet is a portability defect.
const ABSOLUTE_SHAPE_RES = [
  /[A-Za-z]:[\\/]/,   // Windows drive root (e.g. C:\ or C:/)
  /^\\\\/,            // UNC (\\server\share)
  /\/home\//,         // POSIX /home/<user>/...
  /\/Users\//,         // macOS /Users/<user>/...
  /^\/[a-z]\//,        // MSYS/Git-Bash translated (/c/Users/...)
];

function assertNoAbsoluteShape(value, label) {
  for (const re of ABSOLUTE_SHAPE_RES) {
    assert(!re.test(value), `${label}: value "${value}" matches forbidden absolute-path shape ${re}`);
  }
  assert(!isAbsolutePath(value), `${label}: isAbsolutePath() flagged "${value}"`);
}

// ─── env combos required by the AUTHOR spec (S2) ───────────────────────────

const ENV_COMBOS = [
  { label: 'none',               env: {} },
  { label: 'HANDOFF_BASE_DIR',   env: { HANDOFF_BASE_DIR: 'C:\\Users\\bob\\.claude' } },
  { label: 'CLAUDE_CONFIG_DIR',  env: { CLAUDE_CONFIG_DIR: '/home/bob/.claude' } },
  { label: 'CLAUDE_PLUGIN_ROOT', env: { CLAUDE_PLUGIN_ROOT: 'C:\\plugins\\memory-engine' } },
];

// ─── renderKeyPathsBullets() direct coverage ────────────────────────────────

for (const { label, env } of ENV_COMBOS) {
  test(`renderKeyPathsBullets(${label}): no absolute-path shape in either bullet`, () => {
    const b = renderKeyPathsBullets(env);
    assertNoAbsoluteShape(b.handoffPath, `${label} handoffPath`);
    assertNoAbsoluteShape(b.helperPath, `${label} helperPath`);
    assert(isPortableForm(b.handoffPath), `${label}: handoffPath not a recognized portable form: ${b.handoffPath}`);
  });
}

test('none: base defaults to ~/.claude, helper defaults to <engine-root>', () => {
  const b = renderKeyPathsBullets({});
  assertEqual(b.handoffPath, '~/.claude/projects/<project-id>/handoff.md');
  assertEqual(b.helperPath, '<engine-root>/scripts/handoff.js');
});

test('HANDOFF_BASE_DIR set -> literal $HANDOFF_BASE_DIR token (never expanded)', () => {
  const b = renderKeyPathsBullets({ HANDOFF_BASE_DIR: 'C:\\Users\\bob\\.claude' });
  assertEqual(b.handoffPath, '$HANDOFF_BASE_DIR/projects/<project-id>/handoff.md');
});

test('CLAUDE_CONFIG_DIR set (no HANDOFF_BASE_DIR) -> literal $CLAUDE_CONFIG_DIR token', () => {
  const b = renderKeyPathsBullets({ CLAUDE_CONFIG_DIR: '/home/bob/.claude' });
  assertEqual(b.handoffPath, '$CLAUDE_CONFIG_DIR/projects/<project-id>/handoff.md');
});

test('HANDOFF_BASE_DIR takes precedence over CLAUDE_CONFIG_DIR (matches resolveBaseDir)', () => {
  const b = renderKeyPathsBullets({ HANDOFF_BASE_DIR: 'C:\\a\\.claude', CLAUDE_CONFIG_DIR: '/b/.claude' });
  assertEqual(b.handoffPath, '$HANDOFF_BASE_DIR/projects/<project-id>/handoff.md');
});

test('CLAUDE_PLUGIN_ROOT set -> literal $CLAUDE_PLUGIN_ROOT helper, never <repo-root>', () => {
  const b = renderKeyPathsBullets({ CLAUDE_PLUGIN_ROOT: 'C:\\plugins\\memory-engine' });
  assertEqual(b.helperPath, '$CLAUDE_PLUGIN_ROOT/scripts/handoff.js');
  assert(!b.helperPath.includes('<repo-root>'), 'helperPath must never contain <repo-root>');
});

test('empty-string / whitespace-only env vars treated as unset', () => {
  const b = renderKeyPathsBullets({ HANDOFF_BASE_DIR: '   ', CLAUDE_PLUGIN_ROOT: '' });
  assertEqual(b.handoffPath, '~/.claude/projects/<project-id>/handoff.md');
  assertEqual(b.helperPath, '<engine-root>/scripts/handoff.js');
});

// ─── isAbsolutePath()/isPortableForm() classifier self-checks ──────────────

test('isAbsolutePath() flags known absolute shapes', () => {
  assert(isAbsolutePath('C:\\Users\\bob\\.claude\\projects\\a\\handoff.md'));
  assert(isAbsolutePath('/home/bob/.claude/projects/a/handoff.md'));
  assert(isAbsolutePath('/c/Users/bob/.claude/projects/a/handoff.md'));
  assert(isAbsolutePath('\\\\server\\share\\handoff.md'));
});

test('isAbsolutePath() does not flag symbolic tokens', () => {
  assert(!isAbsolutePath('~/.claude/projects/<project-id>/handoff.md'));
  assert(!isAbsolutePath('$HANDOFF_BASE_DIR/projects/<project-id>/handoff.md'));
  assert(!isAbsolutePath('$CLAUDE_PLUGIN_ROOT/scripts/handoff.js'));
  assert(!isAbsolutePath('<engine-root>/scripts/handoff.js'));
});

// ─── template file: no {{HANDOFF_MD_PATH}}/{{PROJECT_ROOT}}, marker present ─

test('templates/project-claude-md.tpl declares the new placeholders and provenance marker', () => {
  const tplPath = path.join(PROJECT_ROOT, 'templates', 'project-claude-md.tpl');
  const tpl = fs.readFileSync(tplPath, 'utf8');
  assert(tpl.includes('{{KEY_PATHS_HANDOFF_PATH}}'), 'template must declare {{KEY_PATHS_HANDOFF_PATH}}');
  assert(tpl.includes('{{KEY_PATHS_HELPER_PATH}}'), 'template must declare {{KEY_PATHS_HELPER_PATH}}');
  assert(!tpl.includes('{{HANDOFF_MD_PATH}}'), 'legacy {{HANDOFF_MD_PATH}} placeholder must be gone');
  assert(!tpl.includes('{{PROJECT_ROOT}}'), 'legacy {{PROJECT_ROOT}} placeholder must be gone');
  assert(tpl.includes('<!-- memory-engine:key-paths v2 -->'), 'template must carry the provenance marker');
});

// ─── template render end-to-end: no absolute segment for any env combo ─────

for (const { label, env } of ENV_COMBOS) {
  test(`template render (${label}): rendered "## Key paths" section has no absolute-path shape`, () => {
    const tplPath = path.join(PROJECT_ROOT, 'templates', 'project-claude-md.tpl');
    const tpl = fs.readFileSync(tplPath, 'utf8');
    const bullets = renderKeyPathsBullets(env);
    const rendered = tpl
      .replace(/\{\{PROJECT_NAME\}\}/g, 'my-project')
      .replace(/\{\{PROJECT_DESCRIPTION\}\}/g, 'desc')
      .replace(/\{\{KEY_PATHS_HANDOFF_PATH\}\}/g, bullets.handoffPath)
      .replace(/\{\{KEY_PATHS_HELPER_PATH\}\}/g, bullets.helperPath);

    const sectionMatch = rendered.match(/## Key paths\r?\n([\s\S]*?)(?:\r?\n## |$)/);
    assert(sectionMatch, `${label}: "## Key paths" section not found in rendered output`);
    const section = sectionMatch[1];

    for (const re of ABSOLUTE_SHAPE_RES) {
      assert(!re.test(section), `${label}: rendered Key paths section matches forbidden absolute-path shape ${re}: ${section}`);
    }
    assert(section.includes(bullets.handoffPath), `${label}: expected symbolic handoff path "${bullets.handoffPath}" in rendered section`);
    assert(section.includes(bullets.helperPath), `${label}: expected symbolic helper path "${bullets.helperPath}" in rendered section`);
  });
}

// ─── summary ──────────────────────────────────────────────────────────────

console.log('');
console.log(`Results: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
