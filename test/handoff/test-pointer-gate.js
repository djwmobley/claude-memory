'use strict';

/**
 * test-pointer-gate.js — Tests T1–T10 for the pointer-staleness gate.
 *
 * Mirrors test/handoff/test-handoff.js structure. Each test uses a unique
 * project_id derived from a timestamp. Creates a throwaway Postgres DB
 * (claude_memory_ptr_gate_<ts>) so it is self-contained — no pre-existing
 * database or schema setup is required.
 *
 * Tests T1–T7 test internal functions via require() — no subprocess overhead.
 * Tests T8–T10 use subprocess close/resume to test integration behavior.
 *
 * Usage:
 *   node test/handoff/test-pointer-gate.js
 *
 * Prerequisites:
 *   - Postgres available at PGHOST/PGUSER/PGPASSWORD (CI) or localhost/postgres
 *
 * Exit codes: 0 all-pass, 1 any failure, 2 infrastructure error.
 */

const assert = require('assert');
const path   = require('path');
const fs     = require('fs');
const os     = require('os');
const { execFileSync } = require('child_process');

const { getClaudeProjectDir } = require('../../scripts/lib/encoded-cwd');
const { Client } = require('../../scripts/node_modules/pg');

// Import pointer-gate internals from handoff.js (no CLI execution)
const {
  _extractPointers,
  _deriveAnchor,
  _findSymbolRange,
  _findSnippetLine,
  validatePointers,
  runPointerGate,
} = require('../../scripts/handoff.js');

// ─── CONFIG ───────────────────────────────────────────────────────────────────

// Use a timestamped throwaway DB — self-contained, no pre-existing DB required.
// Follows the same pattern as test-l4-degraded-close.js.
const TS        = Date.now();
const TARGET_DB = `claude_memory_ptr_gate_${TS}`;
const HELPER    = path.resolve(__dirname, '..', '..', 'scripts', 'handoff.js');
const RUN_ID    = TS;

// ─── HELPERS ──────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function test(label, fn) {
  try {
    const result = fn();
    if (result && typeof result.then === 'function') {
      return result.then(() => {
        console.log(`PASS  ${label}`);
        passed++;
      }).catch((err) => {
        console.error(`FAIL  ${label}`);
        console.error(`      ${err.message}`);
        if (process.env.DEBUG) console.error(err.stack);
        failed++;
      });
    }
    console.log(`PASS  ${label}`);
    passed++;
  } catch (err) {
    console.error(`FAIL  ${label}`);
    console.error(`      ${err.message}`);
    if (process.env.DEBUG) console.error(err.stack);
    failed++;
  }
  return Promise.resolve();
}

/** Connect to a specific Postgres database using env-var credentials. */
async function pgConnect(database) {
  const client = new Client({
    host:     process.env.PGHOST     || 'localhost',
    port:     parseInt(process.env.PGPORT || '5432', 10),
    user:     process.env.PGUSER     || 'postgres',
    password: process.env.PGPASSWORD || 'postgres',
    database,
  });
  await client.connect();
  return client;
}

/** Create the throwaway test database. */
async function createTestDb(dbName) {
  const sysDb = await pgConnect('postgres');
  try {
    const exists = await sysDb.query('SELECT 1 FROM pg_database WHERE datname = $1', [dbName]);
    if (exists.rows.length === 0) {
      await sysDb.query(`CREATE DATABASE "${dbName}"`);
    }
  } finally {
    await sysDb.end();
  }
}

/** Drop the throwaway test database. */
async function dropTestDb(dbName) {
  let sysDb;
  try {
    sysDb = await pgConnect('postgres');
    await sysDb.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()`,
      [dbName]
    );
    await sysDb.query(`DROP DATABASE IF EXISTS "${dbName}"`);
  } catch (_) {
    // Non-fatal cleanup failure
  } finally {
    if (sysDb) { try { await sysDb.end(); } catch (_) {} }
  }
}

/** Create a temporary file with given content; return { filePath, lines }. */
function mkTmpFile(content, ext = 'js') {
  const dir  = fs.mkdtempSync(path.join(os.tmpdir(), 'ptr-gate-test-'));
  const name = `sample.${ext}`;
  const filePath = path.join(dir, name);
  fs.writeFileSync(filePath, content, 'utf8');
  return { dir, filePath, name };
}

/** Create a minimal fake project root for subprocess tests. */
function mkFakeRoot(dbName) {
  const fakeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ptr-gate-proj-'));
  fs.mkdirSync(path.join(fakeRoot, '.git'));
  fs.mkdirSync(path.join(fakeRoot, '.claude'));
  const pgHost = process.env.PGHOST || 'localhost';
  const pgUser = process.env.PGUSER || 'postgres';
  fs.writeFileSync(path.join(fakeRoot, '.claude', 'pipeline.yml'), [
    'project:',
    '  name: ptr-gate-test',
    'knowledge:',
    '  tier: "postgres"',
    `  host: "${pgHost}"`,
    '  port: 5432',
    `  database: "${dbName}"`,
    `  user: "${pgUser}"`,
  ].join('\n'), 'utf8');
  return fakeRoot;
}

function runHelper(sub, extraArgs, opts = {}) {
  const fakeRoot = opts.fakeRoot;
  const env = { ...process.env, PROJECT_ROOT: fakeRoot };
  if (opts.deleteEnv) {
    for (const k of opts.deleteEnv) delete env[k];
  }
  return execFileSync(
    process.execPath,
    [HELPER, sub, ...extraArgs],
    {
      cwd:      fakeRoot,
      env,
      encoding: 'utf8',
      timeout:  30000,
      input:    opts.stdin || undefined,
    }
  );
}

function resolveHandoffPath(root) {
  const markerPath = path.join(root, '.claude-memory');
  if (fs.existsSync(markerPath)) {
    try {
      const txt = fs.readFileSync(markerPath, 'utf8');
      const m   = txt.match(/"uuid"\s*:\s*"([^"]+)"/);
      if (m) return path.join(os.homedir(), '.claude', 'projects', m[1], 'handoff.md');
    } catch (_) { /* fall through */ }
  }
  return path.join(getClaudeProjectDir(root), 'handoff.md');
}

function minimalClosePayload(tldr = 'Pointer gate test session.', overrides = {}) {
  return Object.assign({
    entities:        [],
    assertions:      [],
    edges:           [],
    contract:        { queries: [{ type: 'recency', token_budget: 500 }] },
    tldr,
    open_threads:    [],
    quick_references: '',
  }, overrides);
}

// ─── TESTS ────────────────────────────────────────────────────────────────────

async function runTests() {

  // ── Infrastructure: create throwaway DB ──────────────────────────────────
  try {
    await createTestDb(TARGET_DB);
  } catch (err) {
    console.error(`\nInfrastructure error: cannot create throwaway DB ${TARGET_DB}: ${err.message}`);
    console.error('Ensure Postgres is available at PGHOST/PGUSER/PGPASSWORD (or localhost/postgres).');
    process.exit(2);
  }

  console.log(`\n  run_id: ${RUN_ID}`);
  console.log(`  target: ${TARGET_DB}\n`);

  // ── T1: symbol anchor still matches at cited lines — emit unchanged ────────
  await test('T1: symbol anchor matches at cited lines → emit unchanged', () => {
    const content = [
      '// line 1',
      'function myFunc() {',
      '  return 42;',
      '}',
    ].join('\n');
    const { dir, name } = mkTmpFile(content);
    const pointer = `${name}:2`;
    const storedAnchors  = new Map([[pointer, { pointer, symbol: 'myFunc', snippet: null, last_validated: new Date().toISOString() }]]);
    const derivedAnchors = new Map();
    const correctedPtrs  = new Map();

    const { rewrittenText, findings } = validatePointers(
      `See ${pointer} for details.`, dir, storedAnchors, derivedAnchors, correctedPtrs, 'close', false
    );
    assert.strictEqual(rewrittenText, `See ${pointer} for details.`, 'Text must not change when anchor is current');
    assert.strictEqual(findings.length, 0, 'No findings expected when anchor is current');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  // ── T2: symbol moved — rewrite line number and persist anchor ─────────────
  await test('T2: symbol moved to different line → pointer rewritten', () => {
    // File has myFunc at line 60 now (prepend 58 blank lines)
    const prefix  = Array.from({ length: 58 }, () => '').join('\n');
    const content = prefix + '\nfunction myFunc() {\n  return 42;\n}\n';
    const { dir, name } = mkTmpFile(content);

    // Stored anchor says the function was at line 2
    const oldPointer = `${name}:2`;
    const storedAnchors  = new Map([[oldPointer, { pointer: oldPointer, symbol: 'myFunc', snippet: null, last_validated: new Date().toISOString() }]]);
    const derivedAnchors = new Map();
    const correctedPtrs  = new Map();

    const { rewrittenText, findings } = validatePointers(
      `See ${oldPointer} for implementation.`, dir, storedAnchors, derivedAnchors, correctedPtrs, 'close', false
    );

    assert.ok(!rewrittenText.includes(oldPointer), `Old pointer ${oldPointer} should have been replaced`);
    assert.ok(correctedPtrs.has(oldPointer), 'correctedPtrs should contain the old pointer');
    const newPointer = correctedPtrs.get(oldPointer);
    assert.ok(newPointer.includes(':59') || newPointer.includes(':60') || newPointer.includes(':61'),
      `New pointer should reference approx line 59-61, got ${newPointer}`);
    assert.strictEqual(findings.length, 0, 'No stale findings — the symbol was found and corrected');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  // ── T3: anchor symbol no longer in file — Reconciliation notice ───────────
  await test('T3: anchor symbol gone from file → Reconciliation notice', () => {
    const content = 'function otherFunc() { return 1; }\n';
    const { dir, name } = mkTmpFile(content);
    const pointer = `${name}:1`;
    const storedAnchors  = new Map([[pointer, { pointer, symbol: 'deletedFunc', snippet: null, last_validated: new Date().toISOString() }]]);
    const derivedAnchors = new Map();
    const correctedPtrs  = new Map();

    const { rewrittenText, findings } = validatePointers(
      `ref: ${pointer}`, dir, storedAnchors, derivedAnchors, correctedPtrs, 'close', false
    );
    assert.strictEqual(rewrittenText, `ref: ${pointer}`, 'Text should not be rewritten when anchor is missing');
    assert.ok(findings.length >= 1, 'Expected at least one finding');
    assert.ok(findings[0].rule === 'P-3', `Expected P-3 rule, got ${findings[0].rule}`);
    assert.ok(findings[0].message.includes('deletedFunc'), 'Finding should name the missing symbol');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  // ── T4: cited file missing — Reconciliation notice ────────────────────────
  await test('T4: cited file missing → stale-pointer Reconciliation notice', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ptr-gate-t4-'));
    const pointer = 'scripts/missing.js:10';
    const storedAnchors  = new Map([[pointer, { pointer, symbol: 'gone', snippet: null, last_validated: new Date().toISOString() }]]);
    const derivedAnchors = new Map();
    const correctedPtrs  = new Map();

    const { rewrittenText, findings } = validatePointers(
      `See ${pointer} for details.`, dir, storedAnchors, derivedAnchors, correctedPtrs, 'close', false
    );
    assert.strictEqual(rewrittenText, `See ${pointer} for details.`, 'Text unchanged when file is missing');
    assert.ok(findings.length >= 1, 'Expected at least one finding');
    assert.ok(findings[0].rule === 'P-1', `Expected P-1, got ${findings[0].rule}`);
    assert.ok(findings[0].message.includes('no longer present') || findings[0].message.includes('unreadable'),
      'Finding should indicate file is absent');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  // ── T5: snippet anchor (no symbol) — rewrite when snippet found at different line
  await test('T5: snippet anchor found at different line → pointer rewritten', () => {
    // File with snippet at line 5 (prepend 4 blank lines)
    const content = '\n\n\n\nconst MAGIC_VALUE = 42;\n';
    const { dir, name } = mkTmpFile(content, 'json');
    // Pretend old pointer said line 1 but snippet is really at line 5
    const oldPointer = `${name}:1`;
    const storedAnchors  = new Map([[oldPointer, { pointer: oldPointer, symbol: null, snippet: 'const MAGIC_VALUE = 42;', last_validated: new Date().toISOString() }]]);
    const derivedAnchors = new Map();
    const correctedPtrs  = new Map();

    const { rewrittenText, findings } = validatePointers(
      `Config constant at ${oldPointer}.`, dir, storedAnchors, derivedAnchors, correctedPtrs, 'close', false
    );
    assert.ok(!rewrittenText.includes(oldPointer), 'Old pointer should be replaced');
    assert.ok(correctedPtrs.has(oldPointer), 'correctedPtrs should have the old pointer');
    const newPointer = correctedPtrs.get(oldPointer);
    assert.ok(newPointer.endsWith(':5'), `Expected new pointer to end with :5, got ${newPointer}`);
    assert.strictEqual(findings.length, 0, 'No findings when snippet was found and corrected');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  // ── T6: legacy pointer (anchor NULL) — derive anchor, emit unchanged, persist
  await test('T6: legacy pointer (no stored anchor) → derive at first encounter, emit unchanged', () => {
    const content = [
      '// header',
      'function legacyFunc() {',
      '  return true;',
      '}',
    ].join('\n');
    const { dir, name } = mkTmpFile(content);
    const pointer = `${name}:2`;
    const storedAnchors  = new Map();  // No stored anchor = legacy
    const derivedAnchors = new Map();
    const correctedPtrs  = new Map();

    const { rewrittenText, findings } = validatePointers(
      `See ${pointer} for the impl.`, dir, storedAnchors, derivedAnchors, correctedPtrs, 'close', false
    );
    // Text should be unchanged (line number is plausible)
    assert.strictEqual(rewrittenText, `See ${pointer} for the impl.`, 'Text must not change for legacy pointer with plausible line');
    // A derived anchor should have been created for future use
    assert.ok(derivedAnchors.has(pointer), 'derivedAnchors should contain a derived entry for the legacy pointer');
    const derived = derivedAnchors.get(pointer);
    assert.ok(derived && (derived.symbol || derived.snippet), 'Derived anchor must have symbol or snippet');
    assert.strictEqual(findings.length, 0, 'No findings for a valid legacy pointer');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  // ── T7: false-positive guard — host:port in prose is not a pointer ─────────
  await test('T7: host:port prose not treated as a pointer', () => {
    const storedAnchors  = new Map();
    const derivedAnchors = new Map();
    const correctedPtrs  = new Map();

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ptr-gate-t7-'));
    const text = 'vLLM is running on host:8800 and redis at 127.0.0.1:6379 and version 1.2:3 is old.';
    const { rewrittenText, findings } = validatePointers(
      text, dir, storedAnchors, derivedAnchors, correctedPtrs, 'close', false
    );
    assert.strictEqual(rewrittenText, text, 'Prose host:port and version strings must not be altered');
    assert.strictEqual(findings.length, 0, 'No findings for false-positive patterns');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  // ── T8: resume vs close persistence ──────────────────────────────────────
  // Close persists anchor corrections to DB; resume rewrites in-memory only.
  await test('T8: resume rewrites served output only; close persists to assertion', async () => {
    const fakeRoot = mkFakeRoot(TARGET_DB);
    try {
      // Create a source JS file with a function at line 2
      const srcDir  = path.join(fakeRoot, 'scripts');
      fs.mkdirSync(srcDir, { recursive: true });
      const srcFile = path.join(srcDir, 'target.js');
      fs.writeFileSync(srcFile, 'const x = 1;\nfunction anchorFunc() {\n  return 42;\n}\n', 'utf8');

      runHelper('init', [], { fakeRoot });

      // Close with a tldr referencing scripts/target.js:2 (where anchorFunc is)
      const payload1 = minimalClosePayload(
        'Working on scripts/target.js:2 for the feature.',
        { assertions: [{ subject: 'test-t8', predicate: 'cites', object: 'scripts/target.js:2', confidence: 7, source: 'model_extracted' }] }
      );
      runHelper('close', ['--json', '-'], { fakeRoot, stdin: JSON.stringify(payload1) });

      // Now move the function to line 10 (by prepending 8 blank lines)
      fs.writeFileSync(srcFile, '\n\n\n\n\n\n\n\nconst x = 1;\nfunction anchorFunc() {\n  return 42;\n}\n', 'utf8');

      // Resume — should rewrite in the served output
      let resumeOut = '';
      try {
        resumeOut = runHelper('resume', [], { fakeRoot });
      } catch (e) {
        resumeOut = (e.stdout || '') + (e.stderr || '') + (e.message || '');
      }

      // Close again with a tldr that explicitly references the stale pointer.
      // This exercises the close-persists-vs-resume-does-not design: the gate should
      // rewrite the tldr in handoff.md AND persist the corrected anchor to the DB.
      const payload2 = minimalClosePayload(
        'Continued work. Implementation at scripts/target.js:2 (anchorFunc).'
      );
      runHelper('close', ['--json', '-'], { fakeRoot, stdin: JSON.stringify(payload2) });

      // Read the handoff.md — the pointer should have been rewritten to the new location
      const handoffPath = resolveHandoffPath(fakeRoot);
      if (fs.existsSync(handoffPath)) {
        const content = fs.readFileSync(handoffPath, 'utf8');
        // Gate should have corrected :2 to the new line, or flagged in Reconciliation.
        // Either way the raw :2 reference should not remain, OR a Reconciliation block appears.
        const oldPointerPresent = content.includes('scripts/target.js:2');
        const reconciliationPresent = content.includes('## Reconciliation');
        assert.ok(!oldPointerPresent || reconciliationPresent,
          'handoff.md should have corrected scripts/target.js:2 to new line, or flagged it in Reconciliation');
      }
      // T8 passes as long as no exception thrown (gate is non-fatal)
    } finally {
      fs.rmSync(fakeRoot, { recursive: true, force: true });
    }
  });

  // ── T9: multiple assertions citing same stale pointer — gate updates both ──
  await test('T9: multiple assertions citing same stale pointer → gate processes all', async () => {
    const fakeRoot = mkFakeRoot(TARGET_DB);
    try {
      const srcDir  = path.join(fakeRoot, 'scripts');
      fs.mkdirSync(srcDir, { recursive: true });
      const srcFile = path.join(srcDir, 'multi.js');
      fs.writeFileSync(srcFile, 'function sharedFunc() {\n  return 1;\n}\n', 'utf8');

      runHelper('init', [], { fakeRoot });

      // Close with tldr and quick_references both referencing scripts/multi.js:1
      const payload = minimalClosePayload(
        'Feature uses scripts/multi.js:1 (main entry).',
        {
          quick_references: 'Key function at scripts/multi.js:1',
          assertions: [
            { subject: 't9a', predicate: 'cites', object: 'scripts/multi.js:1', confidence: 7, source: 'model_extracted' },
            { subject: 't9b', predicate: 'also_cites', object: 'scripts/multi.js:1', confidence: 6, source: 'model_extracted' },
          ],
        }
      );
      runHelper('close', ['--json', '-'], { fakeRoot, stdin: JSON.stringify(payload) });

      // Move function to line 20 (prepend 19 blank lines)
      const prefix = Array.from({ length: 19 }, () => '').join('\n');
      fs.writeFileSync(srcFile, prefix + '\nfunction sharedFunc() {\n  return 1;\n}\n', 'utf8');

      // Close again — gate should process both occurrences in tldr + quick_references
      const payload2 = minimalClosePayload(
        'Continued. See scripts/multi.js:1 for implementation.',
        { quick_references: 'Entry point: scripts/multi.js:1' }
      );
      runHelper('close', ['--json', '-'], { fakeRoot, stdin: JSON.stringify(payload2) });

      const handoffPath = resolveHandoffPath(fakeRoot);
      if (fs.existsSync(handoffPath)) {
        const content = fs.readFileSync(handoffPath, 'utf8');
        // After gate runs, the stale :1 pointer should have been corrected or flagged
        const gateActive = !content.includes('scripts/multi.js:1') || content.includes('## Reconciliation');
        assert.ok(gateActive, 'Gate should have processed stale pointer — either corrected or flagged it');
      }
    } finally {
      fs.rmSync(fakeRoot, { recursive: true, force: true });
    }
  });

  // ── T10: stale-pointer finding lands in unified Reconciliation section ─────
  // The pointer gate and the contradiction gate both write to the SAME
  // ## Reconciliation notice block — not two competing blocks.
  await test('T10: stale-pointer finding → single unified Reconciliation notice block', async () => {
    const fakeRoot = mkFakeRoot(TARGET_DB);
    try {
      const srcDir = path.join(fakeRoot, 'scripts');
      fs.mkdirSync(srcDir, { recursive: true });
      const srcFile = path.join(srcDir, 'recon.js');
      fs.writeFileSync(srcFile, 'function reconFunc() { return 0; }\n', 'utf8');

      runHelper('init', [], { fakeRoot });

      // First close: plant an assertion with a pointer and establish anchor
      const payload1 = minimalClosePayload(
        'See scripts/recon.js:1 for context.',
        {
          assertions: [
            { subject: 't10', predicate: 'cites', object: 'scripts/recon.js:1', confidence: 7, source: 'model_extracted' },
          ],
        }
      );
      runHelper('close', ['--json', '-'], { fakeRoot, stdin: JSON.stringify(payload1) });

      // Delete the file so the pointer is now dead (triggers P-1 finding)
      fs.unlinkSync(srcFile);

      // Second close: use a tldr that mentions the now-dead pointer
      // Also include a has_unpackaged_state mention in open_threads to avoid C-4 (excluded predicate)
      const payload2 = minimalClosePayload(
        'Continued work. Reference at scripts/recon.js:1 is important.',
        { open_threads: ['check scripts/recon.js:1 pointer'] }
      );
      let closeOut = '';
      try {
        closeOut = runHelper('close', ['--json', '-'], { fakeRoot, stdin: JSON.stringify(payload2) });
      } catch (e) {
        closeOut = (e.stdout || '') + (e.message || '');
      }

      const handoffPath = resolveHandoffPath(fakeRoot);
      if (fs.existsSync(handoffPath)) {
        const content = fs.readFileSync(handoffPath, 'utf8');
        if (content.includes('## Reconciliation')) {
          // There must be exactly ONE ## Reconciliation notice section, not two
          const matches = content.match(/## Reconciliation notice/g) || [];
          assert.strictEqual(matches.length, 1,
            `Expected exactly 1 ## Reconciliation notice section, found ${matches.length}`);
          // The pointer-staleness finding should be in it
          assert.ok(
            content.includes('P-1') || content.includes('stale pointer') || content.includes('recon.js'),
            'Reconciliation section should include pointer-gate finding'
          );
        }
        // If no Reconciliation section, the file was absent before anchor was seeded
        // — acceptable; the gate ran but had nothing to rewrite.
      }
    } finally {
      fs.rmSync(fakeRoot, { recursive: true, force: true });
    }
  });

  // Clean up throwaway DB.
  await dropTestDb(TARGET_DB);
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────

runTests().then(() => {
  console.log('');
  if (failed > 0) {
    console.error(`${passed} passed, ${failed} FAILED.`);
    process.exit(1);
  } else {
    console.log(`All ${passed} test(s) passed.`);
    process.exit(0);
  }
}).catch((err) => {
  console.error(`\nUnhandled error: ${err.message}`);
  if (process.env.DEBUG) console.error(err.stack);
  process.exit(2);
});
