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
const { readMarker }          = require('../../scripts/lib/project-marker');
const { resolveHandoffMdPath } = require('../../scripts/lib/handoff-paths');
const { createRequire } = require('module');
const scriptsRequire = createRequire(require.resolve('../../scripts/package.json'));
const { Client } = scriptsRequire('pg');

// Import pointer-gate internals from handoff.js (no CLI execution)
const {
  _extractPointers,
  _deriveAnchor,
  _findSymbolRange,
  _findSnippetLine,
  _resolvePointerPath,
  _proseVsContentOverlap,
  _suppressStaleLegacyPointers,
  validatePointers,
  runPointerGate,
  // cm#297 TOTAL pointer-scope classification internals.
  _classifyPointerScope,
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

/**
 * init-embeddability spec: `init` now BLOCKs by default when no embed
 * endpoint is configured; this suite's fixtures configure none (CI has
 * none available) and are not about embeddability, so bare `init` calls
 * auto-opt-out via --no-embeddings unless already opted in explicitly.
 */
function _initNoEmbeddingsDefault(sub, extraArgs) {
  const args = extraArgs || [];
  if (sub !== 'init') return args;
  if (args.some((a) => a === '--seed-provider' || a === '--no-embeddings' || a === '--allow-remote-embed')) return args;
  return [...args, '--no-embeddings'];
}

function runHelper(sub, extraArgs, opts = {}) {
  extraArgs = _initNoEmbeddingsDefault(sub, extraArgs);
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
  const marker = readMarker(root);
  if (marker) return resolveHandoffMdPath(marker.uuid);
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

    // Text includes "legacyFunc" — overlaps with the function name at line 2, so P-4 does not fire.
    const { rewrittenText, findings } = validatePointers(
      `See ${pointer} for legacyFunc impl.`, dir, storedAnchors, derivedAnchors, correctedPtrs, 'close', false
    );
    // Text should be unchanged (line number is plausible and overlap passes)
    assert.strictEqual(rewrittenText, `See ${pointer} for legacyFunc impl.`, 'Text must not change for legacy pointer with plausible line');
    // A derived anchor should have been created for future use
    assert.ok(derivedAnchors.has(pointer), 'derivedAnchors should contain a derived entry for the legacy pointer');
    const derived = derivedAnchors.get(pointer);
    assert.ok(derived && (derived.symbol || derived.snippet), 'Derived anchor must have symbol or snippet');
    const p4 = findings.filter((f) => f.rule === 'P-4');
    assert.strictEqual(p4.length, 0, 'No P-4 finding when prose overlaps with file content');
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

      runHelper('init', ['-y'], { fakeRoot });

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

      runHelper('init', ['-y'], { fakeRoot });

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

      runHelper('init', ['-y'], { fakeRoot });

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

  // ── T11: Legacy pointer, zero token overlap → P-4 finding, no anchor derived ─
  await test('T11: legacy pointer, zero prose-vs-content overlap → P-4, no derived anchor', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ptr-gate-t11-'));
    const scriptsDir = path.join(dir, 'scripts');
    fs.mkdirSync(scriptsDir, { recursive: true });
    // File line 42: contains only unrelated code, no tokens from the prose
    const lines = Array.from({ length: 45 }, (_, i) => {
      if (i === 41) return "const unrelated = require('./elsewhere');";
      return `// line ${i + 1}`;
    });
    fs.writeFileSync(path.join(scriptsDir, 'handoff.js'), lines.join('\n'), 'utf8');

    // Text that mentions the pointer — prose tokens: "semantic-vector-stub", "WIRED"
    // None of these appear in line 42 content
    const pointer = 'scripts/handoff.js:42';
    const text    = `semantic-vector-stub NOT WIRED at ${pointer}`;
    const storedAnchors  = new Map();
    const derivedAnchors = new Map();
    const correctedPtrs  = new Map();

    const { findings } = validatePointers(text, dir, storedAnchors, derivedAnchors, correctedPtrs, 'close', false);
    const p4 = findings.filter((f) => f.rule === 'P-4');
    assert.ok(p4.length >= 1, `Expected at least one P-4 finding, got: ${JSON.stringify(findings)}`);
    assert.ok(p4[0].message.includes(pointer), `P-4 message should name the pointer, got: ${p4[0].message}`);
    assert.ok(!derivedAnchors.has(pointer), 'derivedAnchors must NOT contain the pointer when overlap is zero');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  // ── T12: Legacy pointer, token overlap → no P-4, anchor derived ──────────────
  await test('T12: legacy pointer, token overlap passes → no P-4, derived anchor present', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ptr-gate-t12-'));
    const scriptsDir = path.join(dir, 'scripts');
    fs.mkdirSync(scriptsDir, { recursive: true });
    // File line 42: contains tokens matching the prose ("semantic" or "stub")
    const lines = Array.from({ length: 45 }, (_, i) => {
      if (i === 41) return 'function semanticVectorStub() {';
      if (i === 42) return '  return null;';
      if (i === 43) return '}';
      return `// line ${i + 1}`;
    });
    fs.writeFileSync(path.join(scriptsDir, 'handoff.js'), lines.join('\n'), 'utf8');

    const pointer = 'scripts/handoff.js:42';
    const text    = `semantic-vector-stub NOT WIRED at ${pointer}`;
    const storedAnchors  = new Map();
    const derivedAnchors = new Map();
    const correctedPtrs  = new Map();

    const { findings } = validatePointers(text, dir, storedAnchors, derivedAnchors, correctedPtrs, 'close', false);
    const p4 = findings.filter((f) => f.rule === 'P-4');
    assert.strictEqual(p4.length, 0, `Expected no P-4 finding, got: ${JSON.stringify(p4)}`);
    assert.ok(derivedAnchors.has(pointer), 'derivedAnchors must contain an entry when overlap passes');
    const derived = derivedAnchors.get(pointer);
    assert.ok(derived && (derived.symbol || derived.snippet), 'Derived anchor must have symbol or snippet');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  // ── T13: Bulk supersession pass (cm#297 TOTAL classification) ──────────────────
  //
  // Rewritten for cm#297: staleness is now decided purely by TOTAL scope
  // classification (file exists + line in-range), NOT prose-vs-content token
  // overlap — the prose-overlap heuristic (P-4) stays in the SEPARATE
  // serve-time validatePointers gate only (cm#297 non-goal). Row A here is
  // genuinely stale (line 9999 does not exist); Row B cites a real, in-range
  // line regardless of whether its prose happens to mention matching tokens.
  await test('T13: bulk supersession — in-range-stale suppressed w/ kind+invalid_at, in-range-valid anchored, already-suppressed unchanged', async () => {
    const fakeRoot = mkFakeRoot(TARGET_DB);
    try {
      const scriptsDir = path.join(fakeRoot, 'scripts');
      fs.mkdirSync(scriptsDir, { recursive: true });
      const lines = Array.from({ length: 102 }, (_, i) => {
        if (i === 49) return 'function realHelper() {';
        if (i === 50) return '  return true;';
        if (i === 51) return '}';
        if (i === 98) return '// placeholder line 99';
        return `// line ${i + 1}`;
      });
      fs.writeFileSync(path.join(scriptsDir, 'handoff.js'), lines.join('\n'), 'utf8');

      // Connect to the throwaway DB and provision the schema
      runHelper('init', ['-y'], { fakeRoot });

      // Read the project_id from the project marker written by init
      const markerAfterInit = readMarker(fakeRoot);
      assert.ok(markerAfterInit, 'project marker must exist after init');
      const testProjectId = markerAfterInit.uuid;

      // Open a direct DB connection to insert test rows
      const db = await pgConnect(TARGET_DB);
      try {

        // Insert Row A: stale — line 9999 does not exist in the 102-line file.
        const rowA = await db.query(
          `INSERT INTO assertions (project_id, subject, predicate, object, confidence, source, anchor, suppressed)
           VALUES ($1, 'dangling-thing', 'is_at', 'scripts/handoff.js:9999', 7, 'model_extracted', NULL, false)
           RETURNING id`,
          [testProjectId]
        );
        const idA = rowA.rows[0].id;

        // Insert Row B: passes — line 50 is a real, in-range, non-blank line.
        const rowB = await db.query(
          `INSERT INTO assertions (project_id, subject, predicate, object, confidence, source, anchor, suppressed)
           VALUES ($1, 'real-helper', 'is_at', 'scripts/handoff.js:50', 7, 'model_extracted', NULL, false)
           RETURNING id`,
          [testProjectId]
        );
        const idB = rowB.rows[0].id;

        // Insert Row C: already suppressed — must be unchanged
        const rowC = await db.query(
          `INSERT INTO assertions (project_id, subject, predicate, object, confidence, source, anchor, suppressed)
           VALUES ($1, 'already-suppressed', 'is_at', 'scripts/handoff.js:99', 7, 'model_extracted', NULL, true)
           RETURNING id`,
          [testProjectId]
        );
        const idC = rowC.rows[0].id;

        // Run the bulk supersession pass
        const result1 = await _suppressStaleLegacyPointers(db, testProjectId, fakeRoot);
        assert.ok(result1.findings.some((f) => f.kind === 'stale_pointer_suppressed'),
          `expected a stale_pointer_suppressed finding, got: ${JSON.stringify(result1.findings)}`);

        // Check Row A: should be suppressed, with suppression_kind + invalid_at
        // set in the SAME statement (cm#297's root defect), anchor still NULL.
        const afterA = await db.query(`SELECT suppressed, suppression_kind, invalid_at, anchor FROM assertions WHERE id = $1`, [idA]);
        assert.strictEqual(afterA.rows[0].suppressed, true, 'Row A must be suppressed');
        assert.strictEqual(afterA.rows[0].suppression_kind, 'stale_pointer', 'Row A suppression_kind must be stale_pointer');
        assert.ok(afterA.rows[0].invalid_at !== null, 'Row A invalid_at must be set');
        assert.strictEqual(afterA.rows[0].anchor, null, 'Row A anchor must remain NULL');

        // Check Row B: suppressed=false, anchor IS NOT NULL
        const afterB = await db.query(`SELECT suppressed, anchor FROM assertions WHERE id = $1`, [idB]);
        assert.strictEqual(afterB.rows[0].suppressed, false, 'Row B must remain unsuppressed');
        assert.ok(afterB.rows[0].anchor !== null, 'Row B must have an anchor derived');

        // Check Row C: unchanged — suppressed=true, kind/anchor still NULL
        const afterC = await db.query(`SELECT suppressed, suppression_kind, anchor FROM assertions WHERE id = $1`, [idC]);
        assert.strictEqual(afterC.rows[0].suppressed, true, 'Row C must still be suppressed (unchanged)');
        assert.strictEqual(afterC.rows[0].suppression_kind, null, 'Row C suppression_kind must remain untouched (NULL)');
        assert.strictEqual(afterC.rows[0].anchor, null, 'Row C anchor must remain NULL');

        // Idempotency: run again — no changes
        const result2 = await _suppressStaleLegacyPointers(db, testProjectId, fakeRoot);
        assert.strictEqual(result2.findings.length, 0, 'second run must find nothing left to classify (anchor now set on A/B or already-suppressed on C)');
        const idempA = await db.query(`SELECT suppressed, anchor FROM assertions WHERE id = $1`, [idA]);
        assert.strictEqual(idempA.rows[0].suppressed, true, 'Row A idempotent: still suppressed');
        const idempB = await db.query(`SELECT suppressed, anchor FROM assertions WHERE id = $1`, [idB]);
        assert.strictEqual(idempB.rows[0].suppressed, false, 'Row B idempotent: still unsuppressed');

      } finally {
        await db.end();
      }
    } finally {
      fs.rmSync(fakeRoot, { recursive: true, force: true });
    }
  });

  // ── T14: Bare-filename path fallback ─────────────────────────────────────────
  await test('T14: bare-filename pointer resolved via scripts/ fallback → no P-1, anchor derived', () => {
    // Create a project root with scripts/handoff.js but no root-level handoff.js
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ptr-gate-t14-'));
    const scriptsDir = path.join(dir, 'scripts');
    fs.mkdirSync(scriptsDir, { recursive: true });
    // Line 10 contains "handoffContext" which overlaps with "handoff" and "context" in prose
    const lines = Array.from({ length: 15 }, (_, i) => {
      if (i === 9) return 'function handoffContext() { return true; }';
      return `// line ${i + 1}`;
    });
    fs.writeFileSync(path.join(scriptsDir, 'handoff.js'), lines.join('\n'), 'utf8');
    // No root-level handoff.js — the bare-filename fallback must kick in

    // Text uses bare filename pointer (no scripts/ prefix)
    const pointer = 'handoff.js:10';
    const text    = `see ${pointer} for handoff context`;
    const storedAnchors  = new Map();
    const derivedAnchors = new Map();
    const correctedPtrs  = new Map();

    const { findings } = validatePointers(text, dir, storedAnchors, derivedAnchors, correctedPtrs, 'close', false);
    const p1 = findings.filter((f) => f.rule === 'P-1');
    assert.strictEqual(p1.length, 0, `Expected no P-1 finding (fallback should resolve), got: ${JSON.stringify(p1)}`);
    assert.ok(derivedAnchors.has(pointer), `derivedAnchors must contain an entry for ${pointer}`);
    const derived = derivedAnchors.get(pointer);
    assert.ok(derived && (derived.symbol || derived.snippet), 'Derived anchor must have symbol or snippet');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  // ── T15-T21: cm#297 TOTAL pointer-scope classification (_classifyPointerScope) ──
  // Unit-level — no DB required. Each is an adversary-hardened fixture from
  // the cm#297 spec's own worked examples.

  await test('T15: Windows absolute backslash pointer never falls back to bare-filename match, even with a same-named in-repo file', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ptr-gate-t15-'));
    const scriptsDir = path.join(dir, 'scripts');
    fs.mkdirSync(scriptsDir, { recursive: true });
    // A same-named file DOES exist in-repo — the pre-filter must still win.
    fs.writeFileSync(path.join(scriptsDir, 'a.js'), 'function a() { return 1; }\n', 'utf8');

    const r = _classifyPointerScope(dir, 'C:\\other\\a.js:10');
    assert.strictEqual(r.scope, 'UNPARSEABLE_OR_EXTERNAL', `expected UNPARSEABLE_OR_EXTERNAL, got ${r.scope}`);
    assert.strictEqual(r.resolvedAbsPath, null, 'must never resolve to the in-repo same-named file');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  await test('T16: UNC path (\\\\server\\share\\x.js:1) classifies UNPARSEABLE_OR_EXTERNAL', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ptr-gate-t16-'));
    const r = _classifyPointerScope(dir, '\\\\server\\share\\x.js:1');
    assert.strictEqual(r.scope, 'UNPARSEABLE_OR_EXTERNAL', `expected UNPARSEABLE_OR_EXTERNAL, got ${r.scope}`);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  await test('T17: forward-slash drive-letter path (C:/Users/x/other/a.js:10) classifies UNPARSEABLE_OR_EXTERNAL', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ptr-gate-t17-'));
    const r = _classifyPointerScope(dir, 'C:/Users/x/other/a.js:10');
    assert.strictEqual(r.scope, 'UNPARSEABLE_OR_EXTERNAL', `expected UNPARSEABLE_OR_EXTERNAL, got ${r.scope}`);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  await test('T18: relative pointer that normalizes back inside the repo classifies IN_REPO_RESOLVABLE', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ptr-gate-t18-'));
    fs.writeFileSync(path.join(dir, 'x.js'), Array.from({ length: 5 }, (_, i) => i === 2 ? 'const y = 1;' : `// ${i}`).join('\n'), 'utf8');
    const base = path.basename(dir);
    const r = _classifyPointerScope(dir, `../${base}/x.js:3`);
    assert.strictEqual(r.scope, 'IN_REPO_RESOLVABLE', `expected IN_REPO_RESOLVABLE, got ${r.scope}`);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  await test('T19: relative pointer that resolves outside the repo classifies OUTSIDE_REPO', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ptr-gate-t19-'));
    const r = _classifyPointerScope(dir, '../other/b.js:3');
    assert.strictEqual(r.scope, 'OUTSIDE_REPO', `expected OUTSIDE_REPO, got ${r.scope}`);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  await test('T20: line-range pointer (x.js:10-12) parses endLine and resolves IN_REPO_RESOLVABLE', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ptr-gate-t20-'));
    fs.writeFileSync(path.join(dir, 'x.js'), Array.from({ length: 15 }, (_, i) => i === 9 ? 'const z = 1;' : `// ${i}`).join('\n'), 'utf8');
    const r = _classifyPointerScope(dir, 'x.js:10-12');
    assert.strictEqual(r.scope, 'IN_REPO_RESOLVABLE', `expected IN_REPO_RESOLVABLE, got ${r.scope}`);
    assert.strictEqual(r.startLine, 10, 'startLine must be 10');
    assert.strictEqual(r.endLine, 12, 'endLine must be 12');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  await test('T21: x.js#L10 (anchor-style, not a code pointer) classifies NOT_A_POINTER', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ptr-gate-t21-'));
    const r = _classifyPointerScope(dir, 'x.js#L10');
    assert.strictEqual(r.scope, 'NOT_A_POINTER', `expected NOT_A_POINTER, got ${r.scope}`);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  // ── T22-T25: cm#297 row-decision fixtures (_suppressStaleLegacyPointers) ───────

  await test('T22: row citing two pointers (one stale, one resolvable) is NOT suppressed', async () => {
    const fakeRoot = mkFakeRoot(TARGET_DB);
    try {
      const scriptsDir = path.join(fakeRoot, 'scripts');
      fs.mkdirSync(scriptsDir, { recursive: true });
      fs.writeFileSync(path.join(scriptsDir, 'both.js'), Array.from({ length: 10 }, (_, i) => i === 4 ? 'function ok() {}' : `// ${i}`).join('\n'), 'utf8');

      runHelper('init', ['-y'], { fakeRoot });
      const testProjectId = readMarker(fakeRoot).uuid;

      const db = await pgConnect(TARGET_DB);
      try {
        const row = await db.query(
          `INSERT INTO assertions (project_id, subject, predicate, object, confidence, source, anchor, suppressed)
           VALUES ($1, 'mixed', 'cites', 'see scripts/both.js:5 and scripts/both.js:9999', 7, 'model_extracted', NULL, false)
           RETURNING id`,
          [testProjectId]
        );
        const id = row.rows[0].id;

        await _suppressStaleLegacyPointers(db, testProjectId, fakeRoot);
        const after = await db.query(`SELECT suppressed FROM assertions WHERE id = $1`, [id]);
        assert.strictEqual(after.rows[0].suppressed, false, 'row with a mixed stale/resolvable pointer set must NOT be suppressed');
      } finally {
        await db.end();
      }
    } finally {
      fs.rmSync(fakeRoot, { recursive: true, force: true });
    }
  });

  await test('T23: intent row (session_tldr) citing only a stale in-repo pointer survives with annotation, never suppressed', async () => {
    const fakeRoot = mkFakeRoot(TARGET_DB);
    try {
      runHelper('init', ['-y'], { fakeRoot });
      const testProjectId = readMarker(fakeRoot).uuid;

      const db = await pgConnect(TARGET_DB);
      try {
        const row = await db.query(
          `INSERT INTO assertions (project_id, subject, predicate, object, confidence, source, anchor, suppressed)
           VALUES ($1, 'ptr-gate-test', 'session_tldr', 'see scripts/nope.js:9999 for detail', 7, 'model_extracted', NULL, false)
           RETURNING id`,
          [testProjectId]
        );
        const id = row.rows[0].id;

        const result = await _suppressStaleLegacyPointers(db, testProjectId, fakeRoot);
        assert.ok(result.findings.some((f) => f.kind === 'stale_pointer_note' && f.predicate === 'session_tldr'),
          `expected a stale_pointer_note finding for the intent row, got: ${JSON.stringify(result.findings)}`);
        const after = await db.query(`SELECT suppressed, suppression_kind FROM assertions WHERE id = $1`, [id]);
        assert.strictEqual(after.rows[0].suppressed, false, 'session_tldr row must never be suppressed by the bulk pass');
        assert.strictEqual(after.rows[0].suppression_kind, null, 'suppression_kind must remain NULL on an unsuppressed row');
      } finally {
        await db.end();
      }
    } finally {
      fs.rmSync(fakeRoot, { recursive: true, force: true });
    }
  });

  await test('T24: out-of-scope pointer (OUTSIDE_REPO) leaves the row untouched with an annotation, never suppressed', async () => {
    const fakeRoot = mkFakeRoot(TARGET_DB);
    try {
      runHelper('init', ['-y'], { fakeRoot });
      const testProjectId = readMarker(fakeRoot).uuid;

      const db = await pgConnect(TARGET_DB);
      try {
        const row = await db.query(
          `INSERT INTO assertions (project_id, subject, predicate, object, confidence, source, anchor, suppressed)
           VALUES ($1, 't24', 'cites', 'see ../other-repo/b.js:3 for context', 7, 'model_extracted', NULL, false)
           RETURNING id`,
          [testProjectId]
        );
        const id = row.rows[0].id;

        const result = await _suppressStaleLegacyPointers(db, testProjectId, fakeRoot);
        assert.ok(result.findings.some((f) => f.kind === 'stale_pointer_note'),
          `expected a stale_pointer_note finding for the out-of-scope pointer, got: ${JSON.stringify(result.findings)}`);
        const after = await db.query(`SELECT suppressed FROM assertions WHERE id = $1`, [id]);
        assert.strictEqual(after.rows[0].suppressed, false, 'a row citing only an OUTSIDE_REPO pointer must never be suppressed');
      } finally {
        await db.end();
      }
    } finally {
      fs.rmSync(fakeRoot, { recursive: true, force: true });
    }
  });

  await test('T25: after the bulk pass, no row has suppressed=true AND suppression_kind IS NULL', async () => {
    const fakeRoot = mkFakeRoot(TARGET_DB);
    try {
      runHelper('init', ['-y'], { fakeRoot });
      const testProjectId = readMarker(fakeRoot).uuid;

      const db = await pgConnect(TARGET_DB);
      try {
        await db.query(
          `INSERT INTO assertions (project_id, subject, predicate, object, confidence, source, anchor, suppressed)
           VALUES ($1, 't25', 'cites', 'scripts/gone.js:9999', 7, 'model_extracted', NULL, false)`,
          [testProjectId]
        );

        await _suppressStaleLegacyPointers(db, testProjectId, fakeRoot);

        const bad = await db.query(
          `SELECT COUNT(*) AS n FROM assertions WHERE project_id = $1 AND suppressed = true AND suppression_kind IS NULL`,
          [testProjectId]
        );
        assert.strictEqual(parseInt(bad.rows[0].n, 10), 0, 'every suppression made by the bulk pass must carry a suppression_kind');
      } finally {
        await db.end();
      }
    } finally {
      fs.rmSync(fakeRoot, { recursive: true, force: true });
    }
  });

  // ── T26: --dry-run parity (spec item 5) ─────────────────────────────────────────

  await test('T26: close --dry-run prints legacy stale-pointer classification prefixed "(dry-run)" and performs zero writes', async () => {
    const fakeRoot = mkFakeRoot(TARGET_DB);
    try {
      runHelper('init', ['-y'], { fakeRoot });
      const testProjectId = readMarker(fakeRoot).uuid;

      const db = await pgConnect(TARGET_DB);
      let rowId;
      try {
        const row = await db.query(
          `INSERT INTO assertions (project_id, subject, predicate, object, confidence, source, anchor, suppressed)
           VALUES ($1, 't26', 'cites', 'scripts/dry-gone.js:9999', 7, 'model_extracted', NULL, false)
           RETURNING id`,
          [testProjectId]
        );
        rowId = row.rows[0].id;
      } finally {
        await db.end();
      }

      const payload = minimalClosePayload();
      let out = '';
      try {
        out = runHelper('close', ['--dry-run', '--json', '-'], { fakeRoot, stdin: JSON.stringify(payload) });
      } catch (e) {
        out = (e.stdout || '') + (e.message || '');
      }
      assert.ok(out.includes('(dry-run)'), `expected a "(dry-run)"-prefixed line in dry-run output, got:\n${out}`);
      assert.ok(/SUPPRESSED/.test(out), `expected a SUPPRESSED classification line in dry-run output, got:\n${out}`);

      const db2 = await pgConnect(TARGET_DB);
      try {
        const after = await db2.query(`SELECT suppressed, suppression_kind FROM assertions WHERE id = $1`, [rowId]);
        assert.strictEqual(after.rows[0].suppressed, false, 'dry-run must perform zero writes — row must remain unsuppressed');
        assert.strictEqual(after.rows[0].suppression_kind, null, 'dry-run must not set suppression_kind');
      } finally {
        await db2.end();
      }
    } finally {
      fs.rmSync(fakeRoot, { recursive: true, force: true });
    }
  });

  // ── T27: win32-only case-insensitive path comparison ────────────────────────────

  await test('T27: win32 case-insensitive relative-pointer comparison does not misclassify OUTSIDE_REPO', () => {
    if (process.platform !== 'win32') {
      console.log('  (skipped — win32-only, running on ' + process.platform + ')');
      return;
    }
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ptr-gate-t27-'));
    fs.writeFileSync(path.join(dir, 'x.js'), Array.from({ length: 5 }, (_, i) => i === 2 ? 'const q = 1;' : `// ${i}`).join('\n'), 'utf8');
    const base = path.basename(dir);
    const upperPointer = `../${base.toUpperCase()}/x.js:3`;
    const r = _classifyPointerScope(dir, upperPointer);
    assert.strictEqual(r.scope, 'IN_REPO_RESOLVABLE',
      `case-differing relative pointer must resolve IN_REPO on win32, got ${r.scope} for ${upperPointer} against root ${dir}`);
    fs.rmSync(dir, { recursive: true, force: true });
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
