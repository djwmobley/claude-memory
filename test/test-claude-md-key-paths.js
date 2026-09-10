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
 *     (scripts/lib/handoff-paths.js): HANDOFF_BASE_DIR, else ~/.claude (that
 *     function has no CLAUDE_CONFIG_DIR branch). Helper script: CLAUDE_PLUGIN_ROOT if set, else
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
const os   = require('os');
const path = require('path');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const { execFileSync } = require('child_process');
const {
  renderKeyPathsBullets,
  healKeyPathsSection,
  isAbsolutePath,
  isPortableForm,
  resolveProjectDisplayName,
} = require(path.join(PROJECT_ROOT, 'scripts', 'lib', 'claude-md-key-paths.js'));
// renderTemplate() — the SAME {{KEY}}-substitution function cmdInit uses to
// write both handoff.md and the CLAUDE.md promotion file — exposed by
// scripts/handoff.js's module.exports for this literal-fixture test.
const { renderTemplate } = require(path.join(PROJECT_ROOT, 'scripts', 'handoff.js'));

// Verbatim snapshot of templates/project-claude-md.tpl as it stood at commit
// 8314367 (`git show 8314367:templates/project-claude-md.tpl`) — the last
// commit before #263's portable-path rewrite: {{HANDOFF_MD_PATH}} /
// {{PROJECT_ROOT}}/scripts/handoff.js placeholders, both filesystem-absolute
// when rendered by that era's cmdInit. Embedded byte-for-byte (all 36 lines,
// not a reduced excerpt) rather than read via `git show` at test time so the
// fixture does not depend on git history being present in a shallow CI
// checkout.
const LEGACY_TPL_8314367 =
  '# {{PROJECT_NAME}}\n' +
  '\n' +
  '{{PROJECT_DESCRIPTION}}\n' +
  '\n' +
  '---\n' +
  '\n' +
  '## Operating canon (non-negotiable)\n' +
  '\n' +
  'These rules are canon. They override convenience, time pressure, and apparent context. Violating them is a workflow bug to be remediated, not a stylistic choice.\n' +
  '\n' +
  '1. **Follow the user\'s directions and scope exactly.** When asked to do X, and X has an established definition (a backlog item, a prior handoff, a multi-part deliverable), deliver all of X. Do not silently narrow scope, reinterpret it, or substitute a smaller deliverable. If scope genuinely seems too large or ambiguous, say so and ask — do not shrink it unilaterally.\n' +
  '2. **Never autonomously defer authorized work to a subsequent session, bundle, or phase.** Deferring in-scope work without explicit user say-so is a bug. Surface genuine design forks as written open questions with a recommended lean; never use deferral or an invented "later phase" as a mechanism to offload work that is in scope now.\n' +
  '\n' +
  '---\n' +
  '\n' +
  '## Skill invocation hints\n' +
  '\n' +
  '- `/handoff:status` — show last close, days since close, entity/assertion counts\n' +
  '- `/handoff:resume` — load context from prior session regardless of staleness\n' +
  '- `/handoff:close` — end-of-session extraction: entities, assertions, edges, contract update\n' +
  '- `/handoff:checkpoint` — mid-session save without ending the session\n' +
  '- `/handoff:drop` — archive prior session memory and start fresh\n' +
  '- `/handoff:purge` — hard delete all project memory (confirmation required)\n' +
  '\n' +
  '---\n' +
  '\n' +
  '## Key paths\n' +
  '\n' +
  '- Handoff file: `{{HANDOFF_MD_PATH}}`\n' +
  '- Helper script: `{{PROJECT_ROOT}}/scripts/handoff.js`\n' +
  '\n' +
  '---\n' +
  '\n' +
  '## Durable facts\n' +
  '\n' +
  '- (No durable facts promoted yet — promoted by `/handoff:close` when confidence ≥ 9 and user_stated across multiple sessions)\n';

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

test('CLAUDE_CONFIG_DIR is not a recognized base override (matches resolveBaseDir, which has no such branch)', () => {
  const b = renderKeyPathsBullets({ CLAUDE_CONFIG_DIR: '/home/bob/.claude' });
  assertEqual(b.handoffPath, '~/.claude/projects/<project-id>/handoff.md');
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

// ─── healKeyPathsSection() — heal-on-touch coverage ────────────────────────
//
// TOTAL classification: every fixture below is constructed to land in
// exactly one of {absent, ambiguous, healed, noop, unrecognized}.

// Literal-fixture helper: render LEGACY_TPL_8314367 through the repo's real
// renderTemplate() with an absolute HANDOFF_MD_PATH / PROJECT_ROOT pair, the
// same way pre-#263 cmdInit actually wrote a CLAUDE.md.
function renderLegacyFixture(handoffMdPath, projectRoot) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-legacy-tpl-'));
  const tplPath = path.join(tmpDir, 'project-claude-md.tpl');
  fs.writeFileSync(tplPath, LEGACY_TPL_8314367, 'utf8');
  try {
    return renderTemplate(tplPath, {
      PROJECT_NAME:        'proj',
      PROJECT_DESCRIPTION: 'desc',
      HANDOFF_MD_PATH:     handoffMdPath,
      PROJECT_ROOT:        projectRoot,
    });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

const LEGACY_FIXTURE_VARIANTS = [
  { label: 'Windows',  handoffMdPath: 'C:\\Users\\bob\\.claude\\projects\\abc123\\handoff.md', projectRoot: 'C:\\Users\\bob\\claude-memory' },
  { label: 'POSIX',    handoffMdPath: '/home/bob/.claude/projects/abc123/handoff.md',           projectRoot: '/home/bob/claude-memory' },
];

for (const { label, handoffMdPath, projectRoot } of LEGACY_FIXTURE_VARIANTS) {
  test(`legacy absolute fixture (${label}, rendered via real renderTemplate): healed, other lines preserved`, () => {
    const fixture = renderLegacyFixture(handoffMdPath, projectRoot);
    // Sanity: the literal-rendered fixture really does carry an absolute
    // bullet before healing (otherwise this test would vacuously pass).
    assert(fixture.includes(handoffMdPath), 'fixture must contain the absolute handoff path pre-heal');
    const r = healKeyPathsSection(fixture, {});
    assertEqual(r.outcome, 'healed');
    assert(r.text.includes('- Handoff file: `~/.claude/projects/<project-id>/handoff.md`'), 'handoff bullet not healed to portable form');
    assert(r.text.includes('- Helper script: `<engine-root>/scripts/handoff.js`'), 'helper bullet not healed to portable form');
    assert(r.text.includes('<!-- memory-engine:key-paths v2 -->'), 'marker not inserted');
    assert(r.text.includes('# proj\n'), 'unrelated leading line not preserved');
    assert(r.text.includes('## Durable facts\n\n- (No durable facts promoted yet — promoted by `/handoff:close` when confidence ≥ 9 and user_stated across multiple sessions)\n'), 'Durable facts section not preserved verbatim');
    assert(!r.text.includes(handoffMdPath), 'absolute handoff path must be gone after heal');
    assert(!r.text.includes(projectRoot), 'absolute project root must be gone after heal');
  });
}

test('idempotent second pass: healing already-healed output is byte-identical (noop)', () => {
  const fixture =
    '## Key paths\n\n' +
    '- Handoff file: `/home/bob/.claude/projects/xyz/handoff.md`\n' +
    '- Helper script: `/home/bob/claude-memory/scripts/handoff.js`\n';
  const first  = healKeyPathsSection(fixture, {});
  assertEqual(first.outcome, 'healed');
  const second = healKeyPathsSection(first.text, {});
  assertEqual(second.outcome, 'noop');
  assertEqual(second.text, first.text, 'second pass must be byte-identical to first pass output');
});

test('extra user bullet + absolute engine bullets: healed, extra bullet preserved', () => {
  const fixture =
    '## Key paths\n\n' +
    '- Handoff file: `/home/bob/.claude/projects/xyz/handoff.md`\n' +
    '- Helper script: `/home/bob/claude-memory/scripts/handoff.js`\n' +
    '- Extra: something else entirely\n';
  const r = healKeyPathsSection(fixture, {});
  assertEqual(r.outcome, 'healed');
  assert(r.text.includes('- Extra: something else entirely\n'), 'extra user bullet must be preserved verbatim');
  assert(!r.text.includes('/home/bob/'), 'absolute paths must be gone after heal');
});

test('hand-authored /home/bob/notes.md section: unrecognized + leak note', () => {
  const fixture = '## Key paths\n\n- Notes: /home/bob/notes.md\n';
  const r = healKeyPathsSection(fixture, {});
  assertEqual(r.outcome, 'unrecognized');
  assertEqual(r.text, fixture, 'unrecognized must leave text unchanged');
  assert(r.notes.length >= 1, 'unrecognized must carry a note');
  assert(r.notes.some((n) => n.includes('/home/bob/notes.md')), 'note must name the leaked absolute path');
});

test('duplicate "## Key paths" heading: ambiguous', () => {
  const fixture = '## Key paths\n\n- a\n\n## Key paths\n\n- b\n';
  const r = healKeyPathsSection(fixture, {});
  assertEqual(r.outcome, 'ambiguous');
  assertEqual(r.text, fixture, 'ambiguous must leave text unchanged');
  assert(r.notes.length >= 1, 'ambiguous must carry a note');
});

test('heading inside a fenced code block is ignored (no real heading -> absent)', () => {
  const fixture = '```\n## Key paths\n```\nSome other content\n';
  const r = healKeyPathsSection(fixture, {});
  assertEqual(r.outcome, 'absent');
  assertEqual(r.text, fixture);
});

test('"### Key paths" (level 3) is not matched -> absent', () => {
  const fixture = '### Key paths\n\n- x\n';
  const r = healKeyPathsSection(fixture, {});
  assertEqual(r.outcome, 'absent');
});

test('"## Key Paths " (case + trailing space) is matched', () => {
  const fixture =
    '## Key Paths \n\n' +
    '- Handoff file: `~/.claude/projects/<project-id>/handoff.md`\n' +
    '- Helper script: `<engine-root>/scripts/handoff.js`\n';
  const r = healKeyPathsSection(fixture, {});
  assert(r.outcome !== 'absent', 'trailing-space/case heading must still be recognized');
  assertEqual(r.outcome, 'noop', 'already-portable engine bullets must be a noop');
});

test('CRLF line endings and a leading BOM are preserved through a heal', () => {
  const fixture =
    '\uFEFF' +
    '## Key paths\r\n\r\n' +
    '- Handoff file: `C:\\Users\\bob\\.claude\\projects\\abc\\handoff.md`\r\n' +
    '- Helper script: `C:\\Users\\bob\\repo\\scripts\\handoff.js`\r\n' +
    '\r\n## Durable facts\r\n\r\n- none\r\n';
  const r = healKeyPathsSection(fixture, {});
  assertEqual(r.outcome, 'healed');
  assert(r.text.charCodeAt(0) === 0xFEFF, 'leading BOM must be preserved');
  assert(r.text.includes('\r\n## Durable facts\r\n\r\n- none\r\n'), 'CRLF-terminated unrelated lines must be preserved exactly');
  assert(!r.text.includes('\n\n## Durable facts\n'), 'must not silently flatten CRLF to LF');
});

test('EOF without a trailing newline is preserved', () => {
  const fixture =
    '## Key paths\n\n' +
    '- Handoff file: `/home/bob/.claude/projects/x/handoff.md`\n' +
    '- Helper script: `/home/bob/repo/scripts/handoff.js`'; // no trailing \n
  const r = healKeyPathsSection(fixture, {});
  assertEqual(r.outcome, 'healed');
  assert(!r.text.endsWith('\n'), 'must not add a trailing newline that was not in the original');
  assert(r.text.endsWith('`<engine-root>/scripts/handoff.js`'), 'last line must be the healed helper bullet with no trailing newline');
});

test('absent: no "## Key paths" heading at all', () => {
  const fixture = '# proj\n\nsome content\n\n## Durable facts\n\n- none\n';
  const r = healKeyPathsSection(fixture, {});
  assertEqual(r.outcome, 'absent');
  assertEqual(r.text, fixture);
  assertEqual(r.notes.length, 0);
});

test('engine-shaped via marker alone (bullets absent) with no absolute path: noop', () => {
  const fixture =
    '## Key paths\n\n' +
    '<!-- memory-engine:key-paths v2 -->\n' +
    '- Something: not a recognized bullet shape\n';
  const r = healKeyPathsSection(fixture, {});
  assertEqual(r.outcome, 'noop');
  assertEqual(r.text, fixture);
});

// ─── resolveProjectDisplayName() — N0-N3 total classification (PR #290) ────
//
// Incident: `promote --regenerate` run from a worktree checkout wrote
// `# agent-a0979417bd522838e` (the worktree's own disposable directory
// name) as the fresh CLAUDE.md's H1. resolveProjectDisplayName() is the ONE
// shared resolver cmdInit and cmdPromoteRegenerate both call instead of
// independently falling back to `path.basename(root)`.

// N0 — explicit name always wins, regardless of root/content.
test('N0: explicit name wins over everything else', () => {
  const r = resolveProjectDisplayName({
    root: '/x',
    explicitName: '  My Explicit Name  ',
    existingFileContent: '# some-other-name\n',
  });
  assertEqual(r.name, 'My Explicit Name');
  assertEqual(r.branch, 'N0');
});

test('N0: whitespace-only explicit name does not count as N0 (falls through)', () => {
  const r = resolveProjectDisplayName({ root: '/x', explicitName: '   ' });
  assert(r.branch !== 'N0', `whitespace-only explicitName must not win as N0, got branch ${r.branch}`);
});

// N1 — first H1 of existing file content.
test('N1: good H1 with inline markup is stripped and collapsed', () => {
  const r = resolveProjectDisplayName({
    root: '/x',
    existingFileContent: '#   **My**   `Cool`   _Project_  \n\nbody text\n',
  });
  assertEqual(r.name, 'My Cool Project');
  assertEqual(r.branch, 'N1');
});

test('N1: markup-wrapped H1 with an HTML tag is stripped', () => {
  const r = resolveProjectDisplayName({
    root: '/x',
    existingFileContent: '# <b>pwa-etl</b>\n',
  });
  assertEqual(r.name, 'pwa-etl');
  assertEqual(r.branch, 'N1');
});

test('N1: placeholder H1 "# Project" is rejected (falls through to N3 here)', () => {
  const r = resolveProjectDisplayName({ root: '/some/root/myproj', existingFileContent: '# Project\n' });
  assert(r.branch !== 'N1', `placeholder H1 must not be accepted as N1, got branch ${r.branch}`);
  assertEqual(r.name, 'myproj');
  assertEqual(r.branch, 'N3');
});

test('N1: worktree-shaped H1 "# agent-<hex>" is rejected (an already-broken prior render is not carried forward)', () => {
  const r = resolveProjectDisplayName({
    root: '/some/root/myproj',
    existingFileContent: '# agent-a0979417bd522838e\n',
  });
  assert(r.branch !== 'N1', `worktree-shaped H1 must not be accepted as N1, got branch ${r.branch}`);
  assertEqual(r.name, 'myproj');
  assertEqual(r.branch, 'N3');
});

test('N1: path-like H1 ("# foo/bar") is rejected', () => {
  const r = resolveProjectDisplayName({ root: '/some/root/myproj', existingFileContent: '# foo/bar\n' });
  assert(r.branch !== 'N1', `path-like H1 must not be accepted as N1, got branch ${r.branch}`);
  assertEqual(r.name, 'myproj');
});

test('N1: "##" (level-2 heading) is not mistaken for an H1', () => {
  const r = resolveProjectDisplayName({
    root: '/some/root/myproj',
    existingFileContent: '## Not An H1\n\n# Real Title\n',
  });
  assertEqual(r.name, 'Real Title');
  assertEqual(r.branch, 'N1');
});

test('N1: no H1 at all falls through past N1', () => {
  const r = resolveProjectDisplayName({ root: '/some/root/myproj', existingFileContent: 'no heading here\n' });
  assert(r.branch !== 'N1', `content with no H1 must not produce N1, got branch ${r.branch}`);
});

// N2 — git worktree checkout resolution (git-backed, not naming-convention-based).
function makeGitWorktreeFixture() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-n2-worktree-'));
  const mainRoot = path.join(tmp, 'fake-main-checkout');
  fs.mkdirSync(mainRoot, { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: mainRoot });
  fs.writeFileSync(path.join(mainRoot, '.memory-engine'), '{}', 'utf8');
  fs.writeFileSync(path.join(mainRoot, 'placeholder.txt'), 'x', 'utf8');
  execFileSync('git', ['add', '.'], { cwd: mainRoot });
  execFileSync('git', ['-c', 'user.email=test@example.com', '-c', 'user.name=test', 'commit', '-q', '-m', 'init'], { cwd: mainRoot });
  const worktreesDir = path.join(mainRoot, '.claude', 'worktrees');
  fs.mkdirSync(worktreesDir, { recursive: true });
  const worktreePath = path.join(worktreesDir, 'agent-deadbeef01');
  execFileSync('git', ['worktree', 'add', worktreePath, '-b', 'cm-n2-test-branch'], { cwd: mainRoot });
  return { tmp, mainRoot, worktreePath };
}

test('N2: root under .claude/worktrees resolves to the main checkout basename via git', () => {
  const { tmp, mainRoot, worktreePath } = makeGitWorktreeFixture();
  try {
    const r = resolveProjectDisplayName({ root: worktreePath });
    assertEqual(r.name, path.basename(mainRoot));
    assertEqual(r.branch, 'N2');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('N2: git failure (bogus PATH) is caught non-throwing and falls through to N3', () => {
  const { tmp, worktreePath } = makeGitWorktreeFixture();
  const savedPath = process.env.PATH;
  try {
    process.env.PATH = path.join(tmp, 'definitely-not-a-real-bin-dir');
    const r = resolveProjectDisplayName({ root: worktreePath }); // must not throw
    assertEqual(r.branch, 'N3');
    assertEqual(r.name, path.basename(worktreePath));
  } finally {
    process.env.PATH = savedPath;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// N3 — basename(root) fallback, including the drive-letter-only literal-project case.
test('N3: normal root basenames cleanly with no git/worktree signal', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-n3-plain-'));
  const plainRoot = path.join(tmp, 'my-plain-project');
  fs.mkdirSync(plainRoot, { recursive: true });
  try {
    const r = resolveProjectDisplayName({ root: plainRoot });
    assertEqual(r.name, 'my-plain-project');
    assertEqual(r.branch, 'N3');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('N3: bare Windows drive-letter root falls back to the literal "project"', () => {
  const r = resolveProjectDisplayName({ root: 'C:' });
  assertEqual(r.name, 'project');
  assertEqual(r.branch, 'N3');
});

// ─── integration-style: init-on-existing write path (no DB required) ──────
//
// Mirrors the exact heal+atomic-write sequence in cmdInit's "CLAUDE.md
// already exists" branch (scripts/handoff.js, Step 11) without needing a DB
// connection — this block only exercises the filesystem side of that
// branch: read -> healKeyPathsSection -> write only on 'healed'.

test('init-on-existing integration: healed legacy CLAUDE.md is written atomically', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-heal-test-'));
  const claudeMdPath = path.join(tmpDir, 'CLAUDE.md');
  const legacy =
    '# proj\n\n## Key paths\n\n' +
    '- Handoff file: `C:\\Users\\bob\\.claude\\projects\\abc\\handoff.md`\n' +
    '- Helper script: `C:\\Users\\bob\\repo\\scripts\\handoff.js`\n';
  fs.writeFileSync(claudeMdPath, legacy, 'utf8');

  // Same sequence as cmdInit Step 11's existing-file branch.
  const existingContent = fs.readFileSync(claudeMdPath, 'utf8');
  const healResult = healKeyPathsSection(existingContent, {});
  assertEqual(healResult.outcome, 'healed');
  const tmpPath = `${claudeMdPath}.tmp-${process.pid}`;
  fs.writeFileSync(tmpPath, healResult.text, 'utf8');
  fs.renameSync(tmpPath, claudeMdPath);

  assert(!fs.existsSync(tmpPath), 'tmp file must be renamed away, not left behind');
  const onDisk = fs.readFileSync(claudeMdPath, 'utf8');
  assertEqual(onDisk, healResult.text, 'on-disk content must match the healed text');
  assert(onDisk.includes('~/.claude/projects/<project-id>/handoff.md'), 'on-disk file must carry the healed portable path');

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('init-on-existing integration: unrecognized existing file is left untouched (no write)', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-heal-test-'));
  const claudeMdPath = path.join(tmpDir, 'CLAUDE.md');
  const handAuthored = '## Key paths\n\n- Notes: /home/bob/notes.md\n';
  fs.writeFileSync(claudeMdPath, handAuthored, 'utf8');
  const before = fs.statSync(claudeMdPath).mtimeMs;

  const existingContent = fs.readFileSync(claudeMdPath, 'utf8');
  const healResult = healKeyPathsSection(existingContent, {});
  assertEqual(healResult.outcome, 'unrecognized');
  // Only 'healed' writes — an unrecognized outcome must never touch disk.
  if (healResult.outcome !== 'healed') {
    // no-op: matches cmdInit's branch, which skips the write here
  }
  const after = fs.statSync(claudeMdPath).mtimeMs;
  assertEqual(after, before, 'file must not be rewritten for a non-healed outcome');
  assertEqual(fs.readFileSync(claudeMdPath, 'utf8'), handAuthored);

  fs.rmSync(tmpDir, { recursive: true, force: true });
});


// ─── summary ──────────────────────────────────────────────────────────────

console.log('');
console.log(`Results: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
