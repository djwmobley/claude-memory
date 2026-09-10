'use strict';

/**
 * test-promote-regenerate.js — coverage for `node scripts/handoff.js promote
 * --regenerate [--dry-run]` (cm: regenerate the durable-facts promotion file
 * from its template without running `init --force-promotion`, which bundles
 * ~9 unrelated DB/FS writes).
 *
 * Mirrors the harness shape of test/handoff/test-handoff.js: a fake project
 * root with a pre-minted marker (see that file's setup() for why pre-minting
 * matters — without it, ensureProjectIdentity() auto-mints a UUID at first
 * helper invocation and DB rows/marker lookups diverge).
 *
 * Usage:
 *   node test/handoff/test-promote-regenerate.js
 *
 * Prerequisites:
 *   - Postgres running with claude_memory_eval_test database (same DB the
 *     rest of the handoff test suite uses; this file only ever needs
 *     connectHandoff() to succeed for the reachability precondition — no
 *     table is read or written).
 *
 * Exit codes: 0 all-pass, 1 any failure, 2 infrastructure error.
 */

const assert = require('assert');
const path   = require('path');
const fs     = require('fs');
const os     = require('os');
const { execFileSync } = require('child_process');

const { loadConfig }  = require('../../scripts/lib/shared');
const { writeMarker } = require('../../scripts/lib/project-marker');
const { classifySchemaFiles } = require('../../scripts/lib/schema-classify');
const { createRequire } = require('module');
const scriptsRequire = createRequire(require.resolve('../../scripts/package.json'));
const { Client }     = scriptsRequire('pg');

// ─── CONFIG ───────────────────────────────────────────────────────────────────

const TARGET_DB = 'claude_memory_eval_test';
const HELPER    = path.resolve(__dirname, '..', '..', 'scripts', 'handoff.js');

// ─── HELPERS ──────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function test(label, fn) {
  try {
    fn();
    console.log(`PASS  ${label}`);
    passed++;
  } catch (err) {
    console.error(`FAIL  ${label}`);
    console.error(`      ${err.message}`);
    failed++;
  }
}

async function connectDb() {
  const cfg = loadConfig();
  const client = new Client({ host: cfg.host, port: cfg.port, database: TARGET_DB, user: cfg.user });
  await client.connect();
  return client;
}

/** Run the handoff.js helper as a subprocess with a fake project root. */
function runHelper(sub, extraArgs = [], opts = {}) {
  const fakeRoot = opts.fakeRoot || global.__fakeRoot;
  const env = { ...process.env, PROJECT_ROOT: fakeRoot };
  return execFileSync(
    process.execPath,
    [HELPER, sub, ...extraArgs],
    { cwd: fakeRoot, env, encoding: 'utf8', timeout: 30000 }
  );
}

function claudeMdPath(fakeRoot) {
  return path.join(fakeRoot, 'CLAUDE.md');
}

/** Remove CLAUDE.md and any backup/tmp artifacts it may have left behind, so
 * each test starts from a clean slate regardless of what the previous test did. */
function cleanPromotionArtifacts(fakeRoot) {
  for (const entry of fs.readdirSync(fakeRoot)) {
    if (entry === 'CLAUDE.md' || /^CLAUDE\.md\.(bak|tmp)-/.test(entry)) {
      fs.rmSync(path.join(fakeRoot, entry), { recursive: true, force: true });
    }
  }
}

function listBackups(fakeRoot) {
  return fs.readdirSync(fakeRoot).filter((e) => /^CLAUDE\.md\.bak-/.test(e));
}

function listTmpFiles(fakeRoot) {
  return fs.readdirSync(fakeRoot).filter((e) => /^CLAUDE\.md\.tmp-/.test(e));
}

function buildFixture({ hasSection, factLines, eol }) {
  const NL = eol === 'crlf' ? '\r\n' : '\n';
  const parts = [
    '# old-project-name',
    '',
    'Some existing description that regenerate will overwrite.',
    '',
    '---',
    '',
  ];
  if (hasSection) {
    parts.push('## Durable facts', '');
    if (factLines && factLines.length > 0) {
      parts.push(...factLines);
    } else {
      parts.push('- (No durable facts promoted yet — promoted by `/handoff:close` when confidence >= 9 and user_stated across multiple sessions)');
    }
    parts.push('');
  } else {
    parts.push('## Some Other Section', '', 'No Durable facts heading exists in this file at all.', '');
  }
  return parts.join(NL);
}

// ─── SETUP / TEARDOWN ─────────────────────────────────────────────────────────

async function setup() {
  const fakeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'promote-regen-test-'));
  global.__fakeRoot = fakeRoot;

  fs.mkdirSync(path.join(fakeRoot, '.git'));
  fs.mkdirSync(path.join(fakeRoot, '.claude'));
  fs.writeFileSync(path.join(fakeRoot, '.claude', 'pipeline.yml'), `
project:
  name: promote-regen-test

knowledge:
  tier: "postgres"
  host: "localhost"
  port: 5432
  database: "${TARGET_DB}"
  user: "postgres"
`.trim(), 'utf8');

  // Pre-mint the project marker (see test-handoff.js setup() for why this
  // matters) so `promote --regenerate`'s marker-resolvable precondition and
  // resolvePromotionFilePath() both resolve against a known, stable root.
  const marker = writeMarker(fakeRoot);
  global.__projectId = marker.uuid;

  console.log(`\n  fake root:   ${fakeRoot}`);
  console.log(`  marker uuid: ${marker.uuid}`);

  // Ensure the schema this DB expects exists (idempotent) — promote
  // --regenerate never queries a table, but its DB-reachable precondition
  // still opens a real connection via connectHandoff(), which requires the
  // target database itself to exist.
  let db;
  try {
    db = await connectDb();
  } catch (err) {
    console.error(`\nInfrastructure error: cannot connect to ${TARGET_DB}: ${err.message}`);
    console.error('Run: psql -U postgres -c "CREATE DATABASE claude_memory_eval_test;"');
    process.exit(2);
  }
  const classification = classifySchemaFiles({ engineRoot: path.resolve(__dirname, '..', '..') });
  if (!classification.ok) {
    throw new Error(`test-promote-regenerate.js setup: schema classification failed: ${classification.errors.join('; ')}`);
  }
  for (const unit of classification.unitsByDialect.postgres) {
    let sql = fs.readFileSync(unit.fullPath, 'utf8');
    sql = sql.replace(/^\\[a-z].*$/gm, '');
    try {
      await db.query(sql);
    } catch (err) {
      if (!err.message.includes('already exists')) {
        console.warn(`  Schema apply warning (${unit.basename}): ${err.message}`);
      }
    }
  }
  await db.end();

  return fakeRoot;
}

function teardown() {
  const fakeRoot = global.__fakeRoot;
  try {
    if (fakeRoot) fs.rmSync(fakeRoot, { recursive: true, force: true });
  } catch (_) { /* best-effort */ }
}

// ─── TESTS ────────────────────────────────────────────────────────────────────

async function runTests() {
  const fakeRoot = await setup();

  test('absent target: writes fresh, no backup, 0 facts carried', () => {
    cleanPromotionArtifacts(fakeRoot);
    const out = runHelper('promote', ['--regenerate']);
    assert.ok(fs.existsSync(claudeMdPath(fakeRoot)), 'CLAUDE.md should be created');
    assert.strictEqual(listBackups(fakeRoot).length, 0, 'no backup should be made for an absent target');
    const content = fs.readFileSync(claudeMdPath(fakeRoot), 'utf8');
    assert.ok(content.includes(path.basename(fakeRoot)), 'fresh render should interpolate the project name');
    assert.ok(content.includes('## Durable facts'), 'fresh render should have a Durable facts section');
    assert.ok(/facts carried:\s*0/.test(out), `expected "facts carried: 0" in output, got: ${out}`);
    assert.ok(/backup:\s*none/.test(out), `expected "backup: none" in output, got: ${out}`);
  });

  test('regular file with 2 fact lines: carried into fresh render, backup made', () => {
    cleanPromotionArtifacts(fakeRoot);
    const factLines = [
      '<!-- promoted: session=explicit, conf=8, date=2026-01-01, source_assertion=1 -->',
      '- [conf=8] Foo is_bar Baz',
      '<!-- promoted: session=explicit, conf=9, date=2026-01-02, source_assertion=2 -->',
      '- [conf=9] Alpha is_beta Gamma',
    ];
    const original = buildFixture({ hasSection: true, factLines });
    fs.writeFileSync(claudeMdPath(fakeRoot), original, 'utf8');

    const out = runHelper('promote', ['--regenerate']);

    assert.strictEqual(listBackups(fakeRoot).length, 1, 'exactly one backup should be made');
    const backupName = listBackups(fakeRoot)[0];
    const backupContent = fs.readFileSync(path.join(fakeRoot, backupName), 'utf8');
    assert.strictEqual(backupContent, original, 'backup should be byte-identical to the pre-regenerate file');

    const regenerated = fs.readFileSync(claudeMdPath(fakeRoot), 'utf8');
    for (const line of factLines) {
      assert.ok(regenerated.includes(line), `regenerated file should carry forward: ${line}`);
    }
    assert.ok(!regenerated.includes('(No durable facts promoted yet'), 'placeholder should be replaced when facts are carried');
    assert.ok(/facts carried:\s*2/.test(out), `expected "facts carried: 2" in output, got: ${out}`);
    assert.ok(out.includes(`backup:        ${path.join(fakeRoot, backupName)}`) || out.includes(backupName), 'output should report the backup path');
  });

  test('file with no parseable "## Durable facts" section: warns, backs up, writes fresh', () => {
    cleanPromotionArtifacts(fakeRoot);
    const original = buildFixture({ hasSection: false });
    fs.writeFileSync(claudeMdPath(fakeRoot), original, 'utf8');

    const out = runHelper('promote', ['--regenerate']);

    assert.strictEqual(listBackups(fakeRoot).length, 1, 'a backup should still be made');
    const backupName = listBackups(fakeRoot)[0];
    const backupContent = fs.readFileSync(path.join(fakeRoot, backupName), 'utf8');
    assert.strictEqual(backupContent, original, 'backup should preserve the un-parseable original byte-for-byte');

    assert.ok(/\[WARN\]/.test(out), 'a WARN line should be printed');
    assert.ok(/NOT carried forward/.test(out), 'the warning should say prior content was NOT carried forward');
    assert.ok(out.includes(backupName), 'the warning/output should point at the backup');

    const regenerated = fs.readFileSync(claudeMdPath(fakeRoot), 'utf8');
    assert.ok(regenerated.includes('(No durable facts promoted yet'), 'fresh render keeps the placeholder when nothing could be carried');
    assert.ok(/facts carried:\s*0/.test(out), `expected "facts carried: 0" in output, got: ${out}`);
  });

  test('directory target: exit 1, nothing written', () => {
    cleanPromotionArtifacts(fakeRoot);
    fs.mkdirSync(claudeMdPath(fakeRoot));
    try {
      let threw;
      try {
        runHelper('promote', ['--regenerate']);
      } catch (err) {
        threw = err;
      }
      assert.ok(threw, 'expected promote --regenerate against a directory target to fail');
      assert.strictEqual(threw.status, 1, `expected exit 1, got ${threw.status}`);
      const combined = (threw.stdout || '') + (threw.stderr || '');
      assert.ok(/directory/i.test(combined), `expected a directory-related message, got: ${combined}`);
      assert.ok(/[Nn]othing written/.test(combined), `expected "nothing written" language, got: ${combined}`);
      assert.ok(fs.statSync(claudeMdPath(fakeRoot)).isDirectory(), 'the directory must be left untouched');
    } finally {
      fs.rmSync(claudeMdPath(fakeRoot), { recursive: true, force: true });
    }
  });

  test('--regenerate with a positional argument: exit 2', () => {
    cleanPromotionArtifacts(fakeRoot);
    let threw;
    try {
      runHelper('promote', ['--regenerate', '42']);
    } catch (err) {
      threw = err;
    }
    assert.ok(threw, 'expected promote --regenerate 42 to fail');
    assert.strictEqual(threw.status, 2, `expected exit 2, got ${threw.status}`);
    assert.ok(!fs.existsSync(claudeMdPath(fakeRoot)), 'nothing should be written on a rejected invocation');
  });

  test('--regenerate with an unknown flag: exit 2', () => {
    cleanPromotionArtifacts(fakeRoot);
    let threw;
    try {
      runHelper('promote', ['--regenerate', '--bogus-flag']);
    } catch (err) {
      threw = err;
    }
    assert.ok(threw, 'expected promote --regenerate --bogus-flag to fail');
    assert.strictEqual(threw.status, 2, `expected exit 2, got ${threw.status}`);
    assert.ok(!fs.existsSync(claudeMdPath(fakeRoot)), 'nothing should be written on a rejected invocation');
  });

  test('--dry-run: writes nothing, creates no backup, reports would-be state', () => {
    cleanPromotionArtifacts(fakeRoot);
    const factLines = [
      '<!-- promoted: session=explicit, conf=7, date=2026-01-01, source_assertion=9 -->',
      '- [conf=7] X does_y Z',
    ];
    const original = buildFixture({ hasSection: true, factLines });
    fs.writeFileSync(claudeMdPath(fakeRoot), original, 'utf8');
    const statBefore = fs.statSync(claudeMdPath(fakeRoot));

    const out = runHelper('promote', ['--regenerate', '--dry-run']);

    const after = fs.readFileSync(claudeMdPath(fakeRoot), 'utf8');
    assert.strictEqual(after, original, 'dry-run must not modify the target file');
    assert.strictEqual(fs.statSync(claudeMdPath(fakeRoot)).mtimeMs, statBefore.mtimeMs, 'dry-run must not even touch mtime');
    assert.strictEqual(listBackups(fakeRoot).length, 0, 'dry-run must not create a backup');
    assert.strictEqual(listTmpFiles(fakeRoot).length, 0, 'dry-run must not leave a tmp file');
    assert.ok(/dry-run/i.test(out), 'output should identify itself as a dry run');
    assert.ok(/would-be bytes:\s*\d+/.test(out), `expected "would-be bytes: N" in output, got: ${out}`);
    assert.ok(/facts that would carry:\s*1/.test(out), `expected "facts that would carry: 1" in output, got: ${out}`);
  });

  test('CRLF file: regenerated output preserves CRLF, carries facts', () => {
    cleanPromotionArtifacts(fakeRoot);
    const factLines = [
      '<!-- promoted: session=explicit, conf=6, date=2026-01-01, source_assertion=11 -->',
      '- [conf=6] Crlf preserves_eol Correctly',
    ];
    const original = buildFixture({ hasSection: true, factLines, eol: 'crlf' });
    assert.ok(original.includes('\r\n'), 'fixture sanity check: must actually be CRLF');
    fs.writeFileSync(claudeMdPath(fakeRoot), original, 'utf8');

    const out = runHelper('promote', ['--regenerate']);
    assert.ok(/facts carried:\s*1/.test(out), `expected "facts carried: 1" in output, got: ${out}`);

    const regenerated = fs.readFileSync(claudeMdPath(fakeRoot), 'utf8');
    const crlfCount = (regenerated.match(/\r\n/g) || []).length;
    const bareLfCount = (regenerated.match(/(?<!\r)\n/g) || []).length;
    assert.ok(crlfCount > 0, 'regenerated content should contain CRLF terminators');
    assert.strictEqual(bareLfCount, 0, `regenerated content should have no bare LF terminators, found ${bareLfCount}`);
    assert.ok(regenerated.includes('- [conf=6] Crlf preserves_eol Correctly'), 'carried fact line should be present');
  });

  test('backup filename contains no ":" in its basename', () => {
    cleanPromotionArtifacts(fakeRoot);
    const original = buildFixture({ hasSection: true, factLines: ['- [conf=5] A b C'] });
    fs.writeFileSync(claudeMdPath(fakeRoot), original, 'utf8');

    runHelper('promote', ['--regenerate']);

    const backups = listBackups(fakeRoot);
    assert.strictEqual(backups.length, 1, 'exactly one backup should exist');
    assert.ok(!backups[0].includes(':'), `backup basename must not contain ":" (Windows-unsafe): ${backups[0]}`);
  });

  teardown();
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
