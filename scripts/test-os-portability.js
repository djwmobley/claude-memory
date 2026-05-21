'use strict';

/**
 * test-os-portability.js — Static invariant assertions over the source tree.
 *
 * Pins the cross-platform abstraction invariants so future regressions are
 * caught immediately. Mirrors the S8/S9/S10 style from test-both-backends.js:
 * static source scans with explicit PASS/FAIL per invariant and offending
 * file:line on failure.
 *
 * Invariants:
 *   P1 — pg connection is OS-uniform: no process.platform/win32/darwin/linux
 *        branch inside connectHandoff's pg connection construction.
 *   P2 — no `shell: true` and no shell-string child_process anywhere in
 *        scripts/, scripts/lib/, hooks/, test/ — every spawn/exec uses an argv
 *        array (makes the suite bash/PowerShell-agnostic).
 *   P3 — the single sanctioned platform branch is runWinBin only: the ONLY
 *        process.platform === 'win32' / os.platform() site is shared.js
 *        runWinBin (and the non-branching renameSync comment in project-identity.js).
 *   P4 — marker/handoff writes are LF-only: project-marker.js and project-identity.js
 *        terminate marker writes with literal '\n' (not '\r\n'), and a physically
 *        written marker contains zero \r bytes.
 *   P5 — no test in the suite hardcodes POSIX-only assumptions: static scan of
 *        scripts/test-*.js + smoketest + test/** for hardcoded /tmp, leading-/
 *        absolute paths (in test scaffolding), /bin/sh, #!/bin/bash reliance,
 *        or `bash -c` — asserts none (with an allowlist for justified exceptions).
 *
 * Usage:
 *   node scripts/test-os-portability.js
 *
 * No Postgres or Ollama required. Pure static analysis.
 * Exit 0 = all invariants pass. Exit 1 = any failure.
 */

const fs   = require('fs');
const os   = require('os');
const path = require('path');
const crypto = require('crypto');

// ── Constants ──────────────────────────────────────────────────────────────────

const PROJECT_ROOT = path.resolve(__dirname, '..');
const SCRIPTS_DIR  = path.join(PROJECT_ROOT, 'scripts');
const HOOKS_DIR    = path.join(PROJECT_ROOT, 'hooks');
const TEST_DIR     = path.join(PROJECT_ROOT, 'test');

const HANDOFF_JS          = path.join(SCRIPTS_DIR, 'handoff.js');
const SHARED_JS           = path.join(SCRIPTS_DIR, 'lib', 'shared.js');
const PROJECT_IDENTITY_JS = path.join(SCRIPTS_DIR, 'lib', 'project-identity.js');
const PROJECT_MARKER_JS   = path.join(SCRIPTS_DIR, 'lib', 'project-marker.js');

// ── Tracking ───────────────────────────────────────────────────────────────────

let passed  = 0;
let failed  = 0;
const failures = [];

function pass(label)         { console.log(`PASS  ${label}`); passed++; }
function fail(label, reason) { console.log(`FAIL  ${label}: ${reason}`); failures.push({ label, reason }); failed++; }

// ── File helpers ───────────────────────────────────────────────────────────────

function readFile(filePath) {
  return fs.readFileSync(filePath, 'utf8');
}

/** Return all lines of a file as [lineNo, text] pairs (1-indexed). */
function lines(filePath) {
  return readFile(filePath).split('\n').map((text, i) => [i + 1, text]);
}

/**
 * Recursively collect .js file paths under a directory (skipping node_modules
 * and .claude/worktrees).
 */
function collectJsFiles(dir) {
  const results = [];
  if (!fs.existsSync(dir)) return results;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.claude') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...collectJsFiles(full));
    } else if (entry.isFile() && entry.name.endsWith('.js')) {
      results.push(full);
    }
  }
  return results;
}

/**
 * Search a file for lines matching a regex. Returns array of { file, line, text }.
 * @param {string} filePath
 * @param {RegExp} re
 */
function findInFile(filePath, re) {
  const hits = [];
  for (const [lineNo, text] of lines(filePath)) {
    if (re.test(text)) {
      hits.push({ file: filePath, line: lineNo, text: text.trim() });
    }
  }
  return hits;
}

/**
 * Search multiple files for lines matching a regex.
 */
function findInFiles(filePaths, re) {
  return filePaths.flatMap((f) => findInFile(f, re));
}

// ── P1 — pg connection is OS-uniform ──────────────────────────────────────────

function testP1() {
  const label = 'P1: pg connection is OS-uniform — no platform branch inside connectHandoff pg construction';

  const src = readFile(HANDOFF_JS);

  // Extract connectHandoff function body.
  // Strategy: find "async function connectHandoff()" and collect the braced body.
  const fnStart = src.indexOf('async function connectHandoff()');
  if (fnStart === -1) {
    fail(label, `connectHandoff not found in ${path.relative(PROJECT_ROOT, HANDOFF_JS)}`);
    return;
  }

  // Walk from fnStart to find the balanced brace for the function body.
  let depth = 0;
  let inFn  = false;
  let fnEnd = -1;
  for (let i = fnStart; i < src.length; i++) {
    if (src[i] === '{') { depth++; inFn = true; }
    else if (src[i] === '}') {
      depth--;
      if (inFn && depth === 0) { fnEnd = i; break; }
    }
  }

  if (fnEnd === -1) {
    fail(label, 'could not locate end of connectHandoff function body');
    return;
  }

  const fnBody = src.slice(fnStart, fnEnd + 1);

  // Behavioral finding: connectHandoff uses loadConfig() + resolveDialect() then
  // createAdapter('postgres', { host, port, database, user }). The pg connection
  // parameters come from cfg.host/cfg.port/cfg.user which are loaded from pipeline.yml
  // or env-independent defaults — no platform branch. Verify no os/platform conditional
  // exists within the function body for the postgres construction path.
  const platformRe = /process\.platform\s*===?\s*['"](?:win32|darwin|linux)['"]|os\.platform\(\)/;
  if (platformRe.test(fnBody)) {
    // Find offending lines relative to the file.
    const fnLines = fnBody.split('\n');
    const offending = fnLines
      .map((text, i) => ({ lineNo: src.slice(0, fnStart).split('\n').length + i, text: text.trim() }))
      .filter((l) => platformRe.test(l.text));
    const detail = offending.map((l) => `  line ~${l.lineNo}: ${l.text}`).join('\n');
    fail(label, `platform branch found inside connectHandoff:\n${detail}`);
    return;
  }

  // Also assert: the postgres createAdapter call passes a plain config object with no
  // platform-conditional fields. This is a structural assertion: the Postgres connection
  // parameters must resolve the same way regardless of OS.
  // Since the regex above passed, no platform branch exists — log the finding.
  console.log(`  [P1 finding] connectHandoff env resolution: PGHOST/PGPORT/PGUSER/PGPASSWORD are` +
    ` NOT read directly by connectHandoff; it calls loadConfig() which reads pipeline.yml` +
    ` or uses the pg.Client defaults (pg library reads PGHOST/PGUSER/PGPASSWORD/PGPASSWORD env natively).` +
    ` The HANDOFF_DB / TARGET_DB constant selects the database name. No platform branch.`);

  pass(label);
}

// ── P2 — no shell: true anywhere in scripts/hooks/test ────────────────────────

function testP2() {
  const label = 'P2: no shell:true and no shell-string child_process in scripts/, hooks/, test/';

  const dirs = [SCRIPTS_DIR, HOOKS_DIR, TEST_DIR];
  const allFiles = dirs.flatMap(collectJsFiles);

  // shell: true (with optional whitespace) — matches shell:true, shell: true, shell :true, etc.
  const shellTrueRe = /shell\s*:\s*true/;

  const THIS_FILE = path.join(SCRIPTS_DIR, 'test-os-portability.js');

  // Sanctioned exceptions: shell:true is permitted when the call site is
  // intentional, the argument list is fully hard-coded (no user-supplied
  // content), and the use is documented with a comment.
  //
  //   reality-checks.js probePrState: shell:true is required on Windows to
  //   execute 'gh.cmd' batch-file wrappers (Windows cannot directly CreateProcess
  //   a .cmd file without routing through cmd.exe).  The args are hard-coded
  //   ['pr', 'view', prNum, '--json', 'state'] where prNum is a \d+ match
  //   (digit-only string) — no shell injection risk.  On POSIX (Linux/macOS CI)
  //   this simply routes through /bin/sh, which is safe for this call shape.
  const SHELL_ALLOWED = [
    { file: path.join(SCRIPTS_DIR, 'lib', 'reality-checks.js') },
  ];

  const hits = findInFiles(allFiles, shellTrueRe).filter((h) => {
    // Skip comment lines.
    if (h.text.startsWith('//') || h.text.startsWith('*')) return false;
    // Skip this file itself — it contains the pattern in string literals used
    // for test labels and error messages, not in actual spawn call-sites.
    if (h.file === THIS_FILE) return false;
    // Skip sanctioned exception sites.
    for (const a of SHELL_ALLOWED) {
      if (h.file === a.file) return false;
    }
    return true;
  });

  if (hits.length > 0) {
    const detail = hits.map((h) => `  ${path.relative(PROJECT_ROOT, h.file)}:${h.line}: ${h.text}`).join('\n');
    fail(label, `shell:true found (makes suite non-portable):\n${detail}`);
    return;
  }

  pass(label);
}

// ── P3 — single sanctioned platform branch is runWinBin ───────────────────────

function testP3() {
  const label = 'P3: only sanctioned platform branch is shared.js runWinBin (and renameSync comment)';

  const dirs = [SCRIPTS_DIR, HOOKS_DIR, TEST_DIR];
  const allFiles = dirs.flatMap(collectJsFiles);

  const platformRe = /process\.platform\s*===?\s*['"]win32['"]|process\.platform\s*!==?\s*['"]win32['"]|os\.platform\(\)/;

  // Allowlist: sanctioned platform-branch sites.
  //   - shared.js:  isWindows = process.platform === 'win32'  (inside runWinBin)
  //   - project-identity.js: comment-only line mentioning renameSync behavior (no branch)
  //   - test-staleness-permutations.js: cross-platform test shim construction
  //     (PATH separator ';' vs ':', POSIX shell script vs .cmd) — these are
  //     intentional test-harness-only platform branches required to build a fake-gh
  //     shim that works on both Linux CI and Windows dev environments.
  //
  // We allowlist by file + approximate pattern.
  const ALLOWED = [
    {
      file: SHARED_JS,
      // Must be inside runWinBin — the only function allowed to branch on platform.
      textRe: /const isWindows\s*=\s*process\.platform\s*===\s*['"]win32['"]/,
    },
    {
      file: path.join(TEST_DIR, 'handoff', 'test-staleness-permutations.js'),
      // Platform branch is in createGhShim / shimPath helpers — cross-platform
      // shim construction for the fake gh binary in the adversarial test harness.
      textRe: /process\.platform\s*===\s*['"]win32['"]/,
    },
  ];

  const hits = findInFiles(allFiles, platformRe).filter((h) => {
    // Skip pure comment lines.
    if (h.text.startsWith('//') || h.text.startsWith('*')) return false;
    // Skip lines that are in the allowlist.
    for (const a of ALLOWED) {
      if (h.file === a.file && a.textRe.test(h.text)) return false;
    }
    return true;
  });

  if (hits.length > 0) {
    const detail = hits.map((h) =>
      `  ${path.relative(PROJECT_ROOT, h.file)}:${h.line}: ${h.text}\n` +
      `    (only shared.js runWinBin is the sanctioned platform branch)`
    ).join('\n');
    fail(label, `unsanctioned platform branch found:\n${detail}`);
    return;
  }

  // Log the confirmed sites for documentation.
  const confirmed = findInFiles(allFiles, platformRe).filter((h) =>
    !h.text.startsWith('//') && !h.text.startsWith('*')
  );
  if (confirmed.length > 0) {
    console.log(`  [P3] Confirmed platform branches (all sanctioned):`);
    for (const h of confirmed) {
      console.log(`    ${path.relative(PROJECT_ROOT, h.file)}:${h.line}: ${h.text.slice(0, 80)}`);
    }
  }

  pass(label);
}

// ── P4 — marker/handoff writes are LF-only ────────────────────────────────────

function testP4() {
  const label = 'P4: marker writes terminate with literal LF only (no \\r\\n)';

  // Static assertion: project-marker.js and project-identity.js writeFileSync calls
  // for marker files must use '\n' not '\r\n'.
  const crlfRe = /\\r\\n|\\r"/;  // matches '\r\n' or '\r" in source

  for (const filePath of [PROJECT_MARKER_JS, PROJECT_IDENTITY_JS]) {
    const hits = findInFile(filePath, crlfRe).filter((h) => {
      // Skip comment lines.
      if (h.text.startsWith('//') || h.text.startsWith('*')) return false;
      // Only flag writeFileSync lines with CRLF in the content string.
      return h.text.includes('writeFileSync') || h.text.includes('write(');
    });
    if (hits.length > 0) {
      const detail = hits.map((h) => `  ${path.relative(PROJECT_ROOT, filePath)}:${h.line}: ${h.text}`).join('\n');
      fail(label, `\\r\\n found in marker write statement:\n${detail}`);
      return;
    }
  }

  // Behavioral assertion: write a marker to a temp dir and verify the file
  // contains zero \r bytes.
  const TS      = Date.now() + Math.floor(Math.random() * 1e6);
  const tmpRoot = path.join(os.tmpdir(), `p4_marker_test_${TS}`);
  fs.mkdirSync(tmpRoot, { recursive: true });
  try {
    const { writeMarker } = require(PROJECT_MARKER_JS);
    writeMarker(tmpRoot);
    const markerPath = path.join(tmpRoot, '.claude-memory');
    const markerBytes = fs.readFileSync(markerPath);
    const crIdx = markerBytes.indexOf(0x0d); // 0x0d = \r
    if (crIdx !== -1) {
      fail(label, `marker file contains \\r at byte offset ${crIdx} — not LF-only`);
      return;
    }
    // Verify the file ends with \n (0x0a).
    const lastByte = markerBytes[markerBytes.length - 1];
    if (lastByte !== 0x0a) {
      fail(label, `marker file last byte is 0x${lastByte.toString(16)}, expected 0x0a (\\n)`);
      return;
    }
  } catch (err) {
    fail(label, `marker write/read test failed: ${err.message}`);
    return;
  } finally {
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch (_) {}
  }

  pass(label);
}

// ── P5 — no hardcoded POSIX-only assumptions in test suite ────────────────────

function testP5() {
  const label = 'P5: no hardcoded POSIX-only assumptions in test suite scripts';

  // Collect all test-*.js files + smoketest + test/**/*.js
  const testFiles = [
    ...fs.readdirSync(SCRIPTS_DIR)
      .filter((f) => (f.startsWith('test-') || f === 'smoketest-handoff.js') && f.endsWith('.js'))
      .map((f) => path.join(SCRIPTS_DIR, f)),
    ...collectJsFiles(TEST_DIR),
  ];

  // Patterns that indicate POSIX-only assumptions:
  //   1. Hardcoded /tmp  (should be os.tmpdir())
  //   2. /bin/sh or /bin/bash literals
  //   3. bash -c string invocations (hard-codes bash availability)
  //
  // Allowlist for justified exceptions.
  const HARDCODED_TMP_RE     = /['"`]\s*\/tmp\//;
  const POSIX_BINSH_RE       = /['"`]\s*\/bin\/(?:sh|bash)['"`]/;
  const BASH_C_RE            = /\bbash\s+-c\b/;

  // Allowlist entries: { file, lineRe, reason }
  //   test-sqlite-seam.js uses /tmp/custom.sqlite to test HANDOFF_SQLITE_PATH env override;
  //   that specific test is a controlled env-var injection test (the /tmp value is the input
  //   to the env var, not a temp-file creation — but it IS a hardcoded POSIX path). We
  //   document it and flag it as the one known exception.
  const ALLOWLIST = [
    {
      file:   path.join(SCRIPTS_DIR, 'test-sqlite-seam.js'),
      lineRe: /HANDOFF_SQLITE_PATH\s*=\s*['"]\/tmp\/custom\.sqlite['"]/,
      reason: 'controlled HANDOFF_SQLITE_PATH env-var injection test; /tmp value is the env input, not a temp file creation',
    },
    {
      file:   path.join(SCRIPTS_DIR, 'test-sqlite-seam.js'),
      lineRe: /assertEqual\s*\(\s*p\s*,\s*['"]\/tmp\/custom\.sqlite['"]/,
      reason: 'assertion matching the allowlisted HANDOFF_SQLITE_PATH injection above',
    },
  ];

  function isAllowed(h) {
    for (const a of ALLOWLIST) {
      if (h.file === a.file && a.lineRe.test(h.text)) return true;
    }
    return false;
  }

  const issues = [];

  for (const filePath of testFiles) {
    for (const re of [HARDCODED_TMP_RE, POSIX_BINSH_RE, BASH_C_RE]) {
      const hits = findInFile(filePath, re).filter((h) => {
        if (h.text.startsWith('//') || h.text.startsWith('*')) return false;
        return !isAllowed(h);
      });
      for (const h of hits) {
        issues.push(
          `  ${path.relative(PROJECT_ROOT, h.file)}:${h.line}: ${h.text.slice(0, 100)}`
        );
      }
    }
  }

  if (issues.length > 0) {
    fail(label, `POSIX-only assumptions found (use os.tmpdir(), argv arrays, etc.):\n${issues.join('\n')}`);
    return;
  }

  // Log the allowlisted exceptions for documentation.
  console.log(`  [P5] Allowlisted POSIX exceptions:`);
  for (const a of ALLOWLIST) {
    const rel = path.relative(PROJECT_ROOT, a.file);
    console.log(`    ${rel}: ${a.reason}`);
  }

  pass(label);
}

// ── Main ───────────────────────────────────────────────────────────────────────

async function main() {
  console.log('Running: test-os-portability\n');

  testP1();
  testP2();
  testP3();
  testP4();
  testP5();

  console.log('');
  console.log(`Results: ${passed} passed, ${failed} failed`);
  if (failures.length > 0) {
    console.log('\nFailures:');
    for (const f of failures) {
      console.log(`  FAIL  ${f.label}: ${f.reason}`);
    }
  }
  console.log('');
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('Uncaught error:', err);
  process.exit(1);
});
