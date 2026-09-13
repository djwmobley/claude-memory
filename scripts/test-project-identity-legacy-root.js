'use strict';

/**
 * test-project-identity-legacy-root.js — pure-unit coverage for
 * scripts/lib/project-identity.js's `_findLegacyRoot` helper (Codex review
 * of PR #302, finding 6b, 2026-09-13).
 *
 * Bug fixed: `_findLegacyRoot` used to prefer `process.env.PROJECT_ROOT`
 * over its own `startDir` argument UNCONDITIONALLY — even when
 * `ensureProjectIdentity` had already resolved an explicit `opts.cwd` in
 * preference to the env var one level up. A markerless MCP call against
 * project root A, made from a server process whose own `PROJECT_ROOT` env
 * happened to be set to a DIFFERENT project B, silently targeted B for
 * legacy-row lookup and marker placement instead of the caller's own
 * explicit A.
 *
 * Fix: `_findLegacyRoot(startDir, { explicitRoot })` — when `explicitRoot`
 * is true, `PROJECT_ROOT` env is NEVER consulted; `startDir` wins outright.
 * `ensureProjectIdentity` passes `explicitRoot: !!opts.cwd`, so only the
 * CLI's own no-opts.cwd path (where `PROJECT_ROOT` env is the documented,
 * intentional resolution source) still reads the env var.
 *
 * No Postgres, no filesystem writes beyond a throwaway tmpdir with no `.git`
 * anywhere in its ancestry other than the real repo's own root (which every
 * fixture directory here is created OUTSIDE of, under os.tmpdir()).
 *
 * Usage: node scripts/test-project-identity-legacy-root.js
 * Exit codes: 0 = all pass, 1 = any failure.
 */

const assert = require('node:assert');
const fs     = require('node:fs');
const os     = require('node:os');
const path   = require('node:path');
const { _findLegacyRoot } = require('./lib/project-identity.js');

let passed = 0;
let failed = 0;

function check(label, condition) {
  try {
    assert.ok(condition, label);
    console.log(`PASS  ${label}`);
    passed++;
  } catch (err) {
    console.log(`FAIL  ${label}: ${err.message}`);
    failed++;
  }
}

function restoreEnvVar(key, savedValue) {
  if (savedValue === undefined) delete process.env[key];
  else process.env[key] = savedValue;
}

function makeTmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

(function main() {
  const savedProjectRoot = process.env.PROJECT_ROOT;

  try {
    // ── explicitRoot: true — PROJECT_ROOT env must be ignored entirely ────

    check('explicit root A with PROJECT_ROOT=B, no explicit-root .git anywhere -> returns A (env never consulted)', (() => {
      const rootA = makeTmpDir('legacy-root-A-');
      const rootB = makeTmpDir('legacy-root-B-');
      process.env.PROJECT_ROOT = rootB;
      try {
        const result = _findLegacyRoot(rootA, { explicitRoot: true });
        return result === rootA;
      } finally {
        fs.rmSync(rootA, { recursive: true, force: true });
        fs.rmSync(rootB, { recursive: true, force: true });
      }
    })());

    check('explicit root with no PROJECT_ROOT set at all -> still returns the explicit root unchanged', (() => {
      const rootA = makeTmpDir('legacy-root-noenv-');
      delete process.env.PROJECT_ROOT;
      try {
        const result = _findLegacyRoot(rootA, { explicitRoot: true });
        return result === rootA;
      } finally {
        fs.rmSync(rootA, { recursive: true, force: true });
      }
    })());

    check('explicit root containing its own .git -> walk finds it (still explicit-root-scoped, not env-scoped)', (() => {
      const rootA = makeTmpDir('legacy-root-withgit-');
      const rootB = makeTmpDir('legacy-root-B2-');
      fs.mkdirSync(path.join(rootA, '.git'));
      process.env.PROJECT_ROOT = rootB;
      try {
        const result = _findLegacyRoot(rootA, { explicitRoot: true });
        return result === rootA;
      } finally {
        fs.rmSync(rootA, { recursive: true, force: true });
        fs.rmSync(rootB, { recursive: true, force: true });
      }
    })());

    // ── explicitRoot: false (default) — legacy CLI-path behavior unchanged ─

    check('explicitRoot omitted (default false) + PROJECT_ROOT set -> env wins (pre-existing CLI-path behavior preserved)', (() => {
      const rootA = makeTmpDir('legacy-root-clidefault-');
      const rootB = makeTmpDir('legacy-root-clienv-');
      process.env.PROJECT_ROOT = rootB;
      try {
        const result = _findLegacyRoot(rootA);
        return result === rootB;
      } finally {
        fs.rmSync(rootA, { recursive: true, force: true });
        fs.rmSync(rootB, { recursive: true, force: true });
      }
    })());

    check('explicitRoot: false explicitly + PROJECT_ROOT set -> env still wins', (() => {
      const rootA = makeTmpDir('legacy-root-explicitfalse-');
      const rootB = makeTmpDir('legacy-root-explicitfalse-env-');
      process.env.PROJECT_ROOT = rootB;
      try {
        const result = _findLegacyRoot(rootA, { explicitRoot: false });
        return result === rootB;
      } finally {
        fs.rmSync(rootA, { recursive: true, force: true });
        fs.rmSync(rootB, { recursive: true, force: true });
      }
    })());

    check('explicitRoot omitted + no PROJECT_ROOT set -> falls back to the .git walk from startDir', (() => {
      const rootA = makeTmpDir('legacy-root-walk-');
      delete process.env.PROJECT_ROOT;
      try {
        const result = _findLegacyRoot(rootA);
        // No .git anywhere under os.tmpdir()'s own ancestry (by construction
        // of a fresh mkdtemp dir) — the walk exhausts and returns startDir.
        return result === rootA;
      } finally {
        fs.rmSync(rootA, { recursive: true, force: true });
      }
    })());
  } finally {
    restoreEnvVar('PROJECT_ROOT', savedProjectRoot);
  }

  console.log('');
  console.log(`Results: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
})();
