'use strict';

/**
 * test-install-engine-path.js — Install.js engine-path recording tests and
 * static consistency checks across all 9 command files.
 *
 * Part A — install.js .engine-path recording:
 *   A1  Normal install writes .engine-path with correct absolute engine path
 *   A2  --dry-run writes nothing (no .engine-path created)
 *   A3  .engine-path content is a forward-slash path ending in /scripts/handoff.js
 *   A4  .engine-path is written to destDir (the same dir as the command files)
 *
 * Part B — static consistency across all 9 command files:
 *   B1  Every command file contains a HANDOFF_ENGINE tier-1 check
 *   B2  Every command file contains the .engine-path fallback referencing
 *       commands/handoff/.engine-path
 *   B3  No command file still contains the old bare "is this a claude-memory project?"
 *       error without the .engine-path fallback present
 *   B4  Every command file contains the improved standalone error message
 *       (both fix options A and B)
 *
 * Isolation: Part A uses an isolated temp directory as HOME; never touches
 * real ~/.claude.
 *
 * Usage:
 *   node scripts/test-install-engine-path.js
 *
 * No Postgres or external dependencies required. Pure Node.
 * Exit 0 = all tests passed; 1 = any failure.
 */

const { spawnSync } = require('child_process');
const fs            = require('fs');
const os            = require('os');
const path          = require('path');

// ── Constants ─────────────────────────────────────────────────────────────────

const REPO_ROOT      = path.resolve(__dirname, '..');
const INSTALL_SCRIPT = path.join(REPO_ROOT, 'scripts', 'install.js');
const COMMANDS_DIR   = path.join(REPO_ROOT, 'commands', 'handoff');

// ── Tracking ──────────────────────────────────────────────────────────────────

let passed  = 0;
let failed  = 0;
const failures = [];

function pass(label)         { console.log(`PASS  ${label}`); passed++; }
function fail(label, reason) { console.log(`FAIL  ${label}: ${reason}`); failures.push({ label, reason }); failed++; }

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Run install.js with an isolated HOME pointing to a temp dir.
 * Returns { status, stdout, stderr, destDir }.
 */
function runInstall(tmpBase, extraArgs = []) {
  const fakeHome = path.join(tmpBase, 'fake-home');
  const destDir  = path.join(fakeHome, '.claude', 'commands', 'handoff');
  fs.mkdirSync(fakeHome, { recursive: true });

  // install.js uses os.homedir() which reads HOME (POSIX) or USERPROFILE (Windows).
  // We override both so the isolated run never touches the real ~/.claude.
  const env = {
    ...process.env,
    HOME:        fakeHome,
    USERPROFILE: fakeHome,
    // Prevent the settings.local.json write from landing in the real project dir
    // by pointing cwd at an isolated project dir.
  };

  const result = spawnSync(
    process.execPath,
    [INSTALL_SCRIPT, '--force', '--non-interactive', ...extraArgs],
    {
      cwd:     tmpBase,
      env,
      timeout: 15000,
      encoding: 'utf8',
    }
  );

  return { status: result.status, stdout: result.stdout || '', stderr: result.stderr || '', destDir };
}

/** Return all *.md command file paths under commands/handoff/ (excluding README). */
function commandFiles() {
  return fs.readdirSync(COMMANDS_DIR)
    .filter((f) => f.endsWith('.md') && f !== 'README.md')
    .map((f) => path.join(COMMANDS_DIR, f));
}

// ── Part A: install.js engine-path recording ──────────────────────────────────

{
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'handoff-install-test-'));
  try {

    // A1 — Normal install writes .engine-path
    {
      const label = 'A1: normal install writes .engine-path';
      const { status, stderr, destDir } = runInstall(tmpBase);
      const enginePathFile = path.join(destDir, '.engine-path');

      if (status !== 0) {
        fail(label, `install.js exited ${status}; stderr: ${stderr.slice(0, 200)}`);
      } else if (!fs.existsSync(enginePathFile)) {
        fail(label, `.engine-path not written to ${enginePathFile}`);
      } else {
        pass(label);
      }
    }

    // A2 — --dry-run writes nothing
    {
      const label = 'A2: --dry-run writes nothing (no .engine-path)';
      const dryBase = path.join(tmpBase, 'dry-run');
      fs.mkdirSync(dryBase, { recursive: true });
      const { status, stderr, destDir } = runInstall(dryBase, ['--dry-run']);
      const enginePathFile = path.join(destDir, '.engine-path');

      if (status !== 0) {
        fail(label, `install.js --dry-run exited ${status}; stderr: ${stderr.slice(0, 200)}`);
      } else if (fs.existsSync(enginePathFile)) {
        fail(label, `.engine-path was written during dry-run (should not be)`);
      } else {
        pass(label);
      }
    }

    // A3 — Content is a forward-slash path ending in /scripts/handoff.js
    {
      const label = 'A3: .engine-path content is forward-slash path ending in /scripts/handoff.js';
      const normalBase = path.join(tmpBase, 'content-check');
      fs.mkdirSync(normalBase, { recursive: true });
      const { status, stderr, destDir } = runInstall(normalBase);
      const enginePathFile = path.join(destDir, '.engine-path');

      if (status !== 0) {
        fail(label, `install.js exited ${status}; stderr: ${stderr.slice(0, 200)}`);
      } else if (!fs.existsSync(enginePathFile)) {
        fail(label, `.engine-path not found at ${enginePathFile}`);
      } else {
        const content = fs.readFileSync(enginePathFile, 'utf8').trim();
        if (!content.endsWith('/scripts/handoff.js')) {
          fail(label, `content does not end with /scripts/handoff.js; got: ${JSON.stringify(content)}`);
        } else if (content.includes('\\')) {
          fail(label, `content contains backslashes (must be forward-slash): ${JSON.stringify(content)}`);
        } else {
          pass(label);
        }
      }
    }

    // A4 — .engine-path lives in the same destDir as the command files
    {
      const label = 'A4: .engine-path is co-located with command files in destDir';
      const colocBase = path.join(tmpBase, 'coloc-check');
      fs.mkdirSync(colocBase, { recursive: true });
      const { status, stderr, destDir } = runInstall(colocBase);
      const enginePathFile = path.join(destDir, '.engine-path');
      // Also check that at least one .md command file exists alongside it
      const mdFiles = fs.existsSync(destDir)
        ? fs.readdirSync(destDir).filter((f) => f.endsWith('.md'))
        : [];

      if (status !== 0) {
        fail(label, `install.js exited ${status}; stderr: ${stderr.slice(0, 200)}`);
      } else if (!fs.existsSync(enginePathFile)) {
        fail(label, `.engine-path not found at ${enginePathFile}`);
      } else if (mdFiles.length === 0) {
        fail(label, `no .md command files found alongside .engine-path in ${destDir}`);
      } else {
        pass(label);
      }
    }

  } finally {
    fs.rmSync(tmpBase, { recursive: true, force: true });
  }
}

// ── Part B: static consistency across all 9 command files ────────────────────

{
  const files = commandFiles();

  if (files.length !== 9) {
    fail('B-count', `expected 9 command files (excluding README.md), found ${files.length}`);
  } else {
    pass('B-count: 9 command files found (excluding README.md)');
  }

  for (const filePath of files) {
    const rel     = path.relative(REPO_ROOT, filePath);
    const content = fs.readFileSync(filePath, 'utf8');

    // B1 — HANDOFF_ENGINE tier-1 check
    {
      const label = `B1 [${rel}]: contains HANDOFF_ENGINE tier-1 override check`;
      if (
        content.includes('[ -n "$HANDOFF_ENGINE" ]') &&
        content.includes('[ -f "$HANDOFF_ENGINE" ]')
      ) {
        pass(label);
      } else {
        fail(label, 'HANDOFF_ENGINE tier-1 block ([ -n "$HANDOFF_ENGINE" ] && [ -f "$HANDOFF_ENGINE" ]) not found');
      }
    }

    // B2 — .engine-path fallback
    {
      const label = `B2 [${rel}]: contains .engine-path fallback referencing commands/handoff/.engine-path`;
      if (content.includes('commands/handoff/.engine-path')) {
        pass(label);
      } else {
        fail(label, 'commands/handoff/.engine-path fallback not found');
      }
    }

    // B3 — old bare error message is gone
    {
      const label = `B3 [${rel}]: old bare error "is this a claude-memory project?" is absent`;
      if (content.includes('is this a claude-memory project?')) {
        fail(label, 'old bare error message still present — must be replaced by 4-tier resolution block');
      } else {
        pass(label);
      }
    }

    // B4 — improved error message with both fix options
    {
      const label = `B4 [${rel}]: improved standalone error includes both fix options (A and B)`;
      if (
        content.includes('Fix option A: set HANDOFF_ENGINE=') &&
        content.includes('Fix option B: re-run node')
      ) {
        pass(label);
      } else {
        fail(label, 'improved standalone error with Fix option A and Fix option B not found');
      }
    }
  }
}

// ── Summary ───────────────────────────────────────────────────────────────────

console.log('');
console.log(`Results: ${passed} passed, ${failed} failed`);

if (failed > 0) {
  console.log('\nFailures:');
  for (const { label, reason } of failures) {
    console.log(`  FAIL  ${label}: ${reason}`);
  }
  process.exit(1);
} else {
  console.log('All tests passed.');
  process.exit(0);
}
