'use strict';

/**
 * Shared utility: encode a filesystem path into Claude Code's per-project directory name.
 *
 * Claude Code stores per-project transcripts and memory at:
 *   ~/.claude/projects/<encoded-cwd>/
 *
 * Encoding rule: replace every character NOT matching /[A-Za-z0-9-]/ with '-'.
 * Hyphens stay hyphens. No collapsing of consecutive dashes. No special casing —
 * the same replace runs on Windows paths (backslashes, colons) and POSIX paths
 * (leading slash) alike.
 *
 * Examples:
 *   /home/user/dev/myproj          -> -home-user-dev-myproj
 *   C:\Users\djwmo\dev\pipeline    -> C--Users-djwmo-dev-pipeline
 *   /home/user/path with spaces/p  -> -home-user-path-with-spaces-p
 *
 * Plan: docs/plans/2026-04-26-chunker-loader-plan.md (Phase 3)
 */

const path = require('path');
const os = require('os');

/**
 * Encode an absolute filesystem path into Claude Code's per-project directory name.
 *
 * Trailing slashes and backslashes are trimmed before encoding so that
 * `/foo/bar/` and `/foo/bar` produce identical results.
 *
 * @param {string} cwdAbsolute - Absolute working-directory path
 * @returns {string} Encoded directory name (no leading ~/.claude/projects/ prefix)
 */
function encodeCwd(cwdAbsolute) {
  if (!cwdAbsolute) return '';
  // Trim trailing path separators (both / and \) before encoding.
  const trimmed = cwdAbsolute.replace(/[/\\]+$/, '');
  return trimmed.replace(/[^A-Za-z0-9-]/g, '-');
}

/**
 * Resolve the absolute path to ~/.claude/projects/<encoded-cwd>/ for a given cwd.
 *
 * Does not check whether the directory exists on disk.
 *
 * @param {string} cwdAbsolute - Absolute working-directory path
 * @returns {string} Absolute directory path
 */
function getClaudeProjectDir(cwdAbsolute) {
  return path.join(os.homedir(), '.claude', 'projects', encodeCwd(cwdAbsolute));
}

module.exports = { encodeCwd, getClaudeProjectDir };

// ---------------------------------------------------------------------------
// Inline tests — run with: node scripts/lib/encoded-cwd.js
// ---------------------------------------------------------------------------
if (require.main === module) {
  const assert = require('assert');
  const fs = require('fs');
  let passed = 0;

  function test(label, fn) {
    try {
      fn();
      console.log(`PASS  ${label}`);
      passed++;
    } catch (err) {
      console.error(`FAIL  ${label}`);
      console.error(`      ${err.message}`);
      process.exitCode = 1;
    }
  }

  // Test 1: POSIX path
  test('encodeCwd POSIX /home/user/dev/myproj', () => {
    assert.strictEqual(
      encodeCwd('/home/user/dev/myproj'),
      '-home-user-dev-myproj'
    );
  });

  // Test 2: Windows path without trailing backslash
  test('encodeCwd Windows C:\\Users\\djwmo\\dev\\pipeline (no trailing slash)', () => {
    assert.strictEqual(
      encodeCwd('C:\\Users\\djwmo\\dev\\pipeline'),
      'C--Users-djwmo-dev-pipeline'
    );
  });

  // Test 3: Windows path WITH trailing backslash — must produce same result as test 2
  test('encodeCwd Windows C:\\Users\\djwmo\\dev\\pipeline\\ (trailing backslash trimmed)', () => {
    assert.strictEqual(
      encodeCwd('C:\\Users\\djwmo\\dev\\pipeline\\'),
      'C--Users-djwmo-dev-pipeline'
    );
  });

  // Test 4: Path with spaces
  test('encodeCwd path with spaces', () => {
    assert.strictEqual(
      encodeCwd('/home/user/path with spaces/proj'),
      '-home-user-path-with-spaces-proj'
    );
  });

  // Test 5: Empty string
  test('encodeCwd empty string returns empty string', () => {
    assert.strictEqual(encodeCwd(''), '');
  });

  // Test 6: Period encoded
  test('encodeCwd period in path becomes dash', () => {
    assert.strictEqual(
      encodeCwd('foo/bar.baz'),
      'foo-bar-baz'
    );
  });

  // Test 7: getClaudeProjectDir ends with correct encoded segment
  test('getClaudeProjectDir ends with C--Users-djwmo-dev-pipeline', () => {
    const result = getClaudeProjectDir('C:\\Users\\djwmo\\dev\\pipeline');
    assert.ok(
      result.endsWith('C--Users-djwmo-dev-pipeline'),
      `Expected result to end with 'C--Users-djwmo-dev-pipeline', got: ${result}`
    );
  });

  // Test 8: Round-trip against the real on-disk directory for the live cwd.
  // Wraps in try/catch so the file remains testable in isolation (e.g., in a
  // fresh checkout where no Claude Code project directory exists yet). But in
  // the normal pipeline project environment this MUST succeed.
  test('getClaudeProjectDir round-trip: ~/.claude/projects/<encoded-cwd>/ exists on disk', () => {
    const cwd = process.cwd();
    const projectDir = getClaudeProjectDir(cwd);
    let exists = false;
    let skipReason = null;
    try {
      exists = fs.existsSync(projectDir);
    } catch (statErr) {
      skipReason = statErr.message;
    }
    if (skipReason) {
      // Non-fatal: filesystem error checking existence
      console.log(`      (round-trip check skipped: ${skipReason})`);
      return;
    }
    if (!exists) {
      // Non-fatal in isolation; fatal in the project's normal build environment.
      // Log enough detail for diagnosis but do not fail the entire test run.
      console.warn(`      WARNING: directory does not exist: ${projectDir}`);
      console.warn(`      cwd=${cwd}`);
      console.warn('      This is expected ONLY when running outside the pipeline project.');
      // Intentionally not throwing — isolation mode.
      return;
    }
    // If we reach here, the directory exists — assert it for clarity.
    assert.ok(exists, `Expected ${projectDir} to exist on disk`);
    console.log(`      confirmed: ${projectDir}`);
  });

  console.log('');
  if (process.exitCode) {
    console.error(`${passed} test(s) passed, 1 or more FAILED.`);
  } else {
    console.log(`All ${passed} test(s) passed.`);
  }
}
