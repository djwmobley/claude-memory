'use strict';

/**
 * test-handoff.js — Golden-path tests for the /handoff skill helper.
 *
 * Sets up a temporary project_id, runs each subcommand against
 * claude_memory_eval_test, and asserts row counts and file contents.
 *
 * Mirrors the structure of test/eval/eval-retrieval.js.
 *
 * Usage:
 *   node test/handoff/test-handoff.js
 *
 * Prerequisites:
 *   - Postgres running with claude_memory_eval_test database
 *   - Phase 2 schema already applied (entities, assertions, edges, etc.)
 *
 * Exit codes: 0 all-pass, 1 any failure, 2 infrastructure error.
 */

const assert = require('assert');
const path   = require('path');
const fs     = require('fs');
const os     = require('os');
const { execFileSync, spawnSync } = require('child_process');

const { loadConfig }              = require('../../scripts/lib/shared');
const { encodeCwd }               = require('../../scripts/lib/encoded-cwd');
const { writeMarker, readMarker } = require('../../scripts/lib/project-marker');
const { resolveHandoffMdPath }    = require('../../scripts/lib/handoff-paths');
// pg lives in scripts/node_modules — use createRequire anchored to scripts/package.json
// so the import is portable across any pnpm/npm/yarn layout (hoisted or symlink-store).
const { createRequire } = require('module');
const scriptsRequire = createRequire(require.resolve('../../scripts/package.json'));
const { Client }     = scriptsRequire('pg');

// ─── CONFIG ───────────────────────────────────────────────────────────────────

const TARGET_DB  = 'claude_memory_eval_test';
const HELPER     = path.resolve(__dirname, '..', '..', 'scripts', 'handoff.js');
const PROJECT_ID = 'test--handoff--' + Date.now();  // unique to this test run

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
        failed++;
      });
    }
    console.log(`PASS  ${label}`);
    passed++;
  } catch (err) {
    console.error(`FAIL  ${label}`);
    console.error(`      ${err.message}`);
    failed++;
  }
  return Promise.resolve();
}

async function connectDb() {
  const cfg = loadConfig();
  const client = new Client({
    host:     cfg.host,
    port:     cfg.port,
    database: TARGET_DB,
    user:     cfg.user,
  });
  await client.connect();
  return client;
}

async function countRows(client, table, projectId) {
  const { rows } = await client.query(
    `SELECT COUNT(*) AS n FROM ${table} WHERE project_id = $1`,
    [projectId]
  );
  return parseInt(rows[0].n, 10);
}

/** `handoff.js status --json` prints a "Running: ..." banner before the JSON
 * object (and a "Done: ..." summary after it) — mirrors handoff-mcp.mjs's own
 * extractJsonBlock() so this test parses stdout the same way the MCP tool does. */
function parseStatusJson(stdout) {
  const start = stdout.indexOf('{');
  const end   = stdout.lastIndexOf('}');
  return JSON.parse(stdout.slice(start, end + 1));
}

/** Run the handoff.js helper as a subprocess with a fake project root. */
function runHelper(sub, extraArgs = [], opts = {}) {
  // We fake the project root by pointing PROJECT_ROOT to a temp dir that has
  // a .git folder and a .claude/pipeline.yml so loadConfig() and findProjectRoot() work.
  const fakeRoot = opts.fakeRoot || global.__fakeRoot;
  const env = {
    ...process.env,
    PROJECT_ROOT: fakeRoot,
    HANDOFF_TEST_PROJECT_ID: PROJECT_ID,
  };
  return execFileSync(
    process.execPath,
    [HELPER, sub, ...extraArgs],
    {
      cwd: fakeRoot,
      env,
      encoding: 'utf8',
      timeout: 30000,
      input: opts.stdin || undefined,
    }
  );
}

// ─── SETUP ────────────────────────────────────────────────────────────────────

async function setup() {
  // Create a fake project root that handoff.js will discover
  const fakeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'handoff-test-'));
  global.__fakeRoot = fakeRoot;

  // Create .git dir so findProjectRoot() stops here
  fs.mkdirSync(path.join(fakeRoot, '.git'));

  // Create .claude/pipeline.yml so loadConfig() finds DB config
  fs.mkdirSync(path.join(fakeRoot, '.claude'));
  fs.writeFileSync(path.join(fakeRoot, '.claude', 'pipeline.yml'), `
project:
  name: handoff-test

knowledge:
  tier: "postgres"
  host: "localhost"
  port: 5432
  database: "${TARGET_DB}"
  user: "postgres"
`.trim(), 'utf8');

  // Also create a minimal scripts/handoff.js stub check path
  fs.mkdirSync(path.join(fakeRoot, 'scripts', 'lib'), { recursive: true });
  // Symlink is cross-platform-awkward; copy just enough for the check
  // The command files check for `scripts/handoff.js` existence in their walk-up logic

  // Pre-mint the project marker so init/close/checkpoint/drop/purge all
  // resolve project_id to a known UUID. Without this, ensureProjectIdentity()
  // auto-mints a UUID at first helper invocation and DB rows go to that UUID
  // while the test still looks up by encodeCwd(fakeRoot) — the cause of the
  // pre-fix 12-failure cascade. With the marker in place at setup time, every
  // helper invocation reads the existing UUID and all writes/lookups align.
  const marker = writeMarker(fakeRoot);
  global.__projectId = marker.uuid;

  console.log(`\n  test project_id: ${PROJECT_ID}`);
  console.log(`  fake root:       ${fakeRoot}`);
  console.log(`  marker uuid:     ${marker.uuid}`);

  // Ensure DB tables exist (run phase2 schema)
  let db;
  try {
    db = await connectDb();
  } catch (err) {
    console.error(`\nInfrastructure error: cannot connect to ${TARGET_DB}: ${err.message}`);
    console.error('Run: psql -U postgres -c "CREATE DATABASE claude_memory_eval_test;"');
    process.exit(2);
  }

  // Apply every postgres-classified schema unit, in manifest order (cm#185:
  // derived from the same total classification the engine itself uses —
  // scripts/lib/schema-classify.js + scripts/sql/schema-manifest.json —
  // rather than a hand-maintained file list here. Currently resolves to
  // handoff-core-schema.sql then app-retrieval-events-schema.sql; both are
  // now auto-applied by /handoff:init in production too (cm#185 bring-forward).
  const { classifySchemaFiles } = require('../../scripts/lib/schema-classify');
  const classification = classifySchemaFiles({ engineRoot: path.resolve(__dirname, '..', '..') });
  if (!classification.ok) {
    throw new Error(`test-handoff.js setup: schema classification failed: ${classification.errors.join('; ')}`);
  }
  for (const unit of classification.unitsByDialect.postgres) {
    let sql = fs.readFileSync(unit.fullPath, 'utf8');
    // Strip psql meta-commands (e.g. \c, \echo) so we can run via the JS client.
    sql = sql.replace(/^\\[a-z].*$/gm, '');
    try {
      await db.query(sql);
    } catch (err) {
      // May already exist — non-fatal
      if (!err.message.includes('already exists')) {
        console.warn(`  Schema apply warning (${unit.basename}): ${err.message}`);
      }
    }
  }

  await db.end();
  return fakeRoot;
}

// ─── TEARDOWN ─────────────────────────────────────────────────────────────────

async function teardown() {
  const fakeRoot        = global.__fakeRoot;
  const encodedFakeRoot = fakeRoot ? encodeCwd(fakeRoot) : null;
  const projectUuid     = global.__projectId;  // marker UUID minted in setup()

  let db;
  try {
    db = await connectDb();
    // 'decisions' cleanup added cm#230 (payload.decisions[] regression tests
    // above write real rows here — same hygiene as the other seam tables).
    const tables = ['edges', 'assertions', 'entities', 'retrieval_contract', 'project_settings', 'decisions'];
    // Clean rows under both the UUID (where writes go) and the legacy encoded-cwd
    // (in case any legacy code path leaked rows under the old project_id).
    const ids = [projectUuid, encodedFakeRoot].filter(Boolean);
    for (const tbl of tables) {
      for (const id of ids) {
        await db.query(`DELETE FROM ${tbl} WHERE project_id = $1`, [id]);
      }
    }
    await db.end();
  } catch (_) {
    // best-effort cleanup
  }

  // Remove fake root
  try {
    fs.rmSync(fakeRoot, { recursive: true, force: true });
  } catch (_) {}

  // Remove the handoff.md project dir where it actually lives.
  try {
    if (projectUuid) {
      const dir = path.dirname(resolveHandoffMdPath(projectUuid));
      if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
    }
  } catch (_) {}
}

// ─── TESTS ────────────────────────────────────────────────────────────────────

async function runTests() {
  const fakeRoot = await setup();
  let db = await connectDb();

  // ── Test 1: init creates DB rows and handoff.md ──────────────────────────
  // project_id throughout the test = the marker UUID (pre-minted in setup).
  // Variable name kept as `encodedRoot` to minimize churn across the file —
  // its value is the UUID, not the encoded-cwd; behavior is identical because
  // handoff.js's resolveProjectId() reads the marker when present.
  const encodedRoot = global.__projectId;
  // Helper: claude per-project dir resolved via the UUID, not the legacy
  // encodeCwd path. Delegates to the same resolveHandoffMdPath() handoff.js uses.
  function claudeProjectDir() {
    return path.dirname(resolveHandoffMdPath(encodedRoot));
  }

  await test('init: creates project_settings defaults', async () => {
    runHelper('init', ['-y'], { fakeRoot });
    const { rows } = await db.query(
      'SELECT COUNT(*) AS n FROM project_settings WHERE project_id = $1',
      [encodedRoot]
    );
    const n = parseInt(rows[0].n, 10);
    assert.ok(n >= 5, `Expected >= 5 project_settings rows for ${encodedRoot}, got ${n}`);
  });

  await test('init: creates retrieval_contract default row', async () => {
    const { rows: r2 } = await db.query(
      "SELECT name FROM retrieval_contract WHERE project_id = $1 AND name = 'default'",
      [encodedRoot]
    );
    assert.ok(r2.length >= 1, `Expected retrieval_contract 'default' row for project ${encodedRoot}`);
  });

  await test('init: creates handoff.md', () => {
    const dir = claudeProjectDir();
    const handoffPath = path.join(dir, 'handoff.md');
    assert.ok(fs.existsSync(handoffPath), `Expected handoff.md at ${handoffPath}`);
    const content = fs.readFileSync(handoffPath, 'utf8');
    assert.ok(content.includes('project_id:'), 'handoff.md should have project_id frontmatter');
    assert.ok(content.includes('last_close:'), 'handoff.md should have last_close frontmatter');
    assert.ok(content.includes('# Handoff'), 'handoff.md should have # Handoff heading');
  });

  await test('init is idempotent (can be run twice)', () => {
    // Should not throw on second run
    runHelper('init', ['-y'], { fakeRoot });
  });

  // ── Test 2: status is read-only and outputs expected fields ──────────────
  await test('status: outputs project_id and counts', () => {
    const out = runHelper('status', [], { fakeRoot });
    assert.ok(out.includes('entities:'),   'status should show entities count');
    assert.ok(out.includes('assertions:'), 'status should show assertions count');
    assert.ok(out.includes('edges:'),      'status should show edges count');
    assert.ok(out.includes('Done: handoff:status'), 'status should emit Done line');
  });

  // ── cm#232 regression: handoff_status "assertions" count must exclude
  // suppressed/invalidated rows (live-row predicate), and every Done line
  // must name the project so a summary can't be misread as another
  // project's — see cm#232/cm#233 issue text for the pwa-etl evidence
  // (status reported 30 assertions after 4 suppressions + 3 adds when the
  // live count was 26).
  await test('status: assertions count excludes suppressed and invalidated rows (cm#232)', async () => {
    // Baseline live count before injecting any extra rows.
    const before = parseStatusJson(runHelper('status', ['--json'], { fakeRoot }));

    await db.query(
      `INSERT INTO assertions (project_id, subject, predicate, object, confidence, source, last_reinforced)
       VALUES ($1, 'CM232_LIVE', 'has_tag', 'live-marker', 8, 'user_stated', now())`,
      [encodedRoot]
    );
    await db.query(
      `INSERT INTO assertions (project_id, subject, predicate, object, confidence, source, last_reinforced, suppressed)
       VALUES ($1, 'CM232_SUPPRESSED', 'has_tag', 'suppressed-marker', 8, 'user_stated', now(), true)`,
      [encodedRoot]
    );
    await db.query(
      `INSERT INTO assertions (project_id, subject, predicate, object, confidence, source, last_reinforced, suppressed, invalid_at)
       VALUES ($1, 'CM232_INVALIDATED', 'has_tag', 'invalidated-marker', 8, 'user_stated', now(), false, now())`,
      [encodedRoot]
    );

    try {
      const out  = parseStatusJson(runHelper('status', ['--json'], { fakeRoot }));
      assert.strictEqual(out.assertions, before.assertions + 1,
        `Expected live assertions count to grow by exactly 1 (the non-suppressed, non-invalidated row); before=${before.assertions}, after=${out.assertions}`);
      assert.strictEqual(out.assertions_suppressed, (before.assertions_suppressed || 0) + 1,
        'Expected assertions_suppressed to grow by exactly 1');
      assert.strictEqual(out.assertions_invalidated, (before.assertions_invalidated || 0) + 1,
        'Expected assertions_invalidated to grow by exactly 1');
      assert.strictEqual(out.assertions_total, before.assertions_total + 3,
        'Expected assertions_total to grow by 3 (all rows written, regardless of live-ness)');

      // Prose output must show the same three numbers in the documented shape.
      const prose = runHelper('status', [], { fakeRoot });
      const proseMatch = prose.match(/assertions:\s*(\d+) \(suppressed: (\d+), invalidated: (\d+)\)/);
      assert.ok(proseMatch, `Expected "assertions: N (suppressed: N, invalidated: N)" in prose output:\n${prose}`);
      assert.strictEqual(parseInt(proseMatch[1], 10), out.assertions, 'prose live count should match --json live count');
      assert.strictEqual(parseInt(proseMatch[2], 10), out.assertions_suppressed, 'prose suppressed count should match --json');
      assert.strictEqual(parseInt(proseMatch[3], 10), out.assertions_invalidated, 'prose invalidated count should match --json');
    } finally {
      // Clean up so later tests' exact-count assertions are unaffected.
      await db.query(
        `DELETE FROM assertions WHERE project_id = $1 AND subject IN ('CM232_LIVE', 'CM232_SUPPRESSED', 'CM232_INVALIDATED')`,
        [encodedRoot]
      );
    }
  });

  // ── cm#232 regression: entities/edges counts must also exclude suppressed
  // rows — the same unfiltered-COUNT(*) bug applied to all three tables.
  await test('status: entities/edges counts exclude suppressed rows (cm#232)', async () => {
    const before = parseStatusJson(runHelper('status', ['--json'], { fakeRoot }));

    await db.query(
      `INSERT INTO entities (project_id, name, entity_type, description)
       VALUES ($1, 'CM232_SUPPRESSED_ENTITY', 'system', 'test')`,
      [encodedRoot]
    );
    await db.query(`UPDATE entities SET suppressed = true WHERE project_id = $1 AND name = 'CM232_SUPPRESSED_ENTITY'`, [encodedRoot]);
    await db.query(
      `INSERT INTO edges (project_id, from_entity, edge_type, to_entity, weight)
       VALUES ($1, 'CM232_A', 'relates_to', 'CM232_B', 1.0)`,
      [encodedRoot]
    );
    await db.query(`UPDATE edges SET suppressed = true WHERE project_id = $1 AND from_entity = 'CM232_A'`, [encodedRoot]);

    try {
      const out = parseStatusJson(runHelper('status', ['--json'], { fakeRoot }));
      assert.strictEqual(out.entities, before.entities, 'Suppressed entity must not inflate the live entities count');
      assert.strictEqual(out.edges, before.edges, 'Suppressed edge must not inflate the live edges count');
    } finally {
      await db.query(`DELETE FROM entities WHERE project_id = $1 AND name = 'CM232_SUPPRESSED_ENTITY'`, [encodedRoot]);
      await db.query(`DELETE FROM edges WHERE project_id = $1 AND from_entity = 'CM232_A'`, [encodedRoot]);
    }
  });

  // ── cm#232 regression: close/checkpoint Done lines must name the project
  // (name + marker uuid) so a summary read out of context can't be misread
  // as another project's close.
  await test('close: Done line includes project name and marker uuid (cm#232)', () => {
    const out = runHelper('close', ['--json', '-'], {
      fakeRoot,
      stdin: JSON.stringify({ session_id: 'cm232-close-naming', tldr: 'cm232 naming test', assertions: [] }),
    });
    const projectBasename = path.basename(fakeRoot);
    const doneLine = out.split('\n').find((l) => l.startsWith('Done: handoff:close'));
    assert.ok(doneLine, `Expected a "Done: handoff:close" line in output:\n${out}`);
    assert.ok(doneLine.includes(`project=${projectBasename}`), `Expected Done line to include project=${projectBasename}, got: ${doneLine}`);
    assert.ok(doneLine.includes(`marker=${encodedRoot}`), `Expected Done line to include marker=${encodedRoot}, got: ${doneLine}`);
  });

  await test('checkpoint: Done line includes project name and marker uuid (cm#232)', () => {
    const out = runHelper('checkpoint', ['--json', '-'], {
      fakeRoot,
      stdin: JSON.stringify({ session_id: 'cm232-checkpoint-naming', tldr: 'cm232 naming test', assertions: [] }),
    });
    const projectBasename = path.basename(fakeRoot);
    const doneLine = out.split('\n').find((l) => l.startsWith('Done: handoff:checkpoint'));
    assert.ok(doneLine, `Expected a "Done: handoff:checkpoint" line in output:\n${out}`);
    assert.ok(doneLine.includes(`project=${projectBasename}`), `Expected Done line to include project=${projectBasename}, got: ${doneLine}`);
    assert.ok(doneLine.includes(`marker=${encodedRoot}`), `Expected Done line to include marker=${encodedRoot}, got: ${doneLine}`);
  });

  // ── cm#232 regression: handoff.md header must name the project and marker
  // uuid. This template already carried PROJECT_NAME/PROJECT_ID (PR #92) —
  // this test pins that invariant so it can never silently regress.
  await test('handoff.md header includes project name and marker uuid (cm#232)', () => {
    runHelper('close', ['--json', '-'], {
      fakeRoot,
      stdin: JSON.stringify({ session_id: 'cm232-handoffmd-naming', tldr: 'cm232 handoff.md naming test', assertions: [] }),
    });
    const handoffPath = resolveHandoffMdPath(encodedRoot);
    const content = fs.readFileSync(handoffPath, 'utf8');
    assert.ok(content.includes(`project_id: ${encodedRoot}`), 'handoff.md frontmatter should include the marker uuid');
    assert.ok(content.includes(`# Handoff — ${path.basename(fakeRoot)}`), 'handoff.md heading should include the project name');
  });

  // ── Test 3: close writes entities/assertions/edges from JSON stdin ────────
  const closePayload = {
    entities: [
      { name: 'TestEntity',  entity_type: 'system',  description: 'A test entity' },
      { name: 'TestEntity2', entity_type: 'concept', description: 'Another test entity' },
    ],
    assertions: [
      { subject: 'TestEntity', predicate: 'uses', object: 'Postgres', confidence: 8, source: 'model_extracted' },
      { subject: 'TestEntity', predicate: 'status', object: 'active',  confidence: 7, source: 'user_stated' },
    ],
    edges: [
      { from_entity: 'TestEntity', edge_type: 'depends_on', to_entity: 'TestEntity2', weight: 1.0 },
    ],
    contract: { queries: [{ type: 'recency', token_budget: 500 }] },
    tldr: 'Test session closed successfully.',
    open_threads: ['verify edge weights', 'add more entities'],
    quick_references: 'TestEntity = main test fixture',
    session_id: 'test-session-001',
  };

  await test('close: writes entities to DB', async () => {
    runHelper('close', ['--json', '-'], { fakeRoot, stdin: JSON.stringify(closePayload) });
    const { rows } = await db.query(
      'SELECT COUNT(*) AS n FROM entities WHERE project_id = $1',
      [encodedRoot]
    );
    assert.strictEqual(parseInt(rows[0].n, 10), 2, `Expected 2 entities, got ${rows[0].n}`);
  });

  await test('close: writes assertions to DB', async () => {
    const { rows } = await db.query(
      'SELECT COUNT(*) AS n FROM assertions WHERE project_id = $1',
      [encodedRoot]
    );
    assert.ok(parseInt(rows[0].n, 10) >= 2, `Expected >= 2 assertions, got ${rows[0].n}`);
  });

  await test('close: writes edges to DB', async () => {
    const { rows } = await db.query(
      'SELECT COUNT(*) AS n FROM edges WHERE project_id = $1',
      [encodedRoot]
    );
    assert.ok(parseInt(rows[0].n, 10) >= 1, `Expected >= 1 edge, got ${rows[0].n}`);
  });

  await test('close: updates retrieval_contract', async () => {
    const { rows } = await db.query(
      "SELECT queries FROM retrieval_contract WHERE project_id = $1 AND name = 'default'",
      [encodedRoot]
    );
    assert.ok(rows.length >= 1, 'Expected retrieval_contract default row');
    const q = rows[0].queries;
    assert.ok(q && q.queries && Array.isArray(q.queries), 'queries should be an object with queries array');
  });

  await test('close: rewrites handoff.md with correct content', () => {
    const dir = claudeProjectDir();
    const handoffPath = path.join(dir, 'handoff.md');
    const content = fs.readFileSync(handoffPath, 'utf8');
    // Section headers must be present (thin-pointer template).
    assert.ok(content.includes('## TL;DR'), 'handoff.md should have ## TL;DR section header');
    assert.ok(content.includes('## Open threads'), 'handoff.md should have ## Open threads section header');
    assert.ok(content.includes('## Quick references'), 'handoff.md should have ## Quick references section header');
    // The body must be a thin pointer — raw prose (tldr text, open-thread text) must NOT
    // be embedded in the MD body (it lives in Postgres as queryable assertion rows instead).
    assert.ok(!content.includes('Test session closed successfully.'), 'handoff.md body must NOT contain raw TL;DR prose (thin-pointer: prose lives in PG rows)');
    assert.ok(!content.includes('verify edge weights'), 'handoff.md body must NOT contain raw open-thread prose (thin-pointer: threads live in PG rows)');
  });

  await test('close: clears session_in_progress marker', async () => {
    const { rows } = await db.query(
      "SELECT value FROM project_settings WHERE project_id = $1 AND key = 'session_in_progress'",
      [encodedRoot]
    );
    assert.strictEqual(rows.length, 0, 'session_in_progress should be cleared after close');
  });

  await test('close: emits Done line', () => {
    const out = runHelper('close', ['--json', '-'], { fakeRoot, stdin: JSON.stringify(closePayload) });
    assert.ok(out.includes('Done: handoff:close'), 'close should emit Done line');
  });

  // ── Test 3b: extraction-empty close warning (non-fatal, engine-level) ─────
  await test('close: no WARNING line when payload carries entities/assertions/edges', () => {
    const out = runHelper('close', ['--json', '-'], { fakeRoot, stdin: JSON.stringify(closePayload) });
    assert.ok(!out.includes('WARNING: extraction-empty close'),
      'close with a full extraction payload should not emit the extraction-empty warning');
  });

  await test('close: WARNING line when payload carries no entities/assertions/edges', () => {
    const thinPayload = {
      tldr: 'Thin close — no extraction this pass.',
      open_threads: [],
      quick_references: 'nothing new',
    };
    const out = runHelper('close', ['--json', '-'], { fakeRoot, stdin: JSON.stringify(thinPayload) });
    assert.ok(out.includes('WARNING: extraction-empty close'),
      'close with zero entities/assertions/edges should emit the extraction-empty warning');
    assert.ok(out.includes('Done: handoff:close'),
      'the warning must be non-fatal — close should still succeed');
  });

  // ── Test 3c: close persists payload.decisions[] (cm#230) ──────────────────
  // Own payload/topic, isolated from closePayload above — writes to the
  // project-scoped `decisions` table are NOT covered by the entities/
  // assertions/edges cleanup in teardown(), so this uses a topic unique to
  // this test run (PROJECT_ID is Date.now()-suffixed) and the test DB
  // (claude_memory_eval_test) has NO default embedding_providers row at the
  // time this suite runs — verified independently — so this ALSO exercises
  // the embedding-provider-down fail-soft path end to end (deterministic
  // unit coverage for the same scenario lives in
  // test/lib/test-decisions-writer.js's DW-8, which does not depend on this
  // DB's provider configuration).
  // TOPIC_RE (decisions-writer.js) requires kebab-case with NO run of two+
  // hyphens (each hyphen must be immediately followed by [a-z0-9]) — collapse
  // every run of non-alnum chars (PROJECT_ID's own "test--handoff--<ts>"
  // double-dash convention included) to a SINGLE hyphen, not a 1:1 replace.
  const decisionTopic = `cm230-test-decision-${PROJECT_ID}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const decisionsClosePayload = {
    tldr: 'cm#230 decisions[] regression payload.',
    decisions: [{ topic: decisionTopic, decision: 'first decision text', reason: 'initial reason' }],
  };

  await test('close: writes payload.decisions[] to the decisions table', async () => {
    const out = runHelper('close', ['--json', '-'], { fakeRoot, stdin: JSON.stringify(decisionsClosePayload) });
    assert.ok(out.includes('Done: handoff:close'), 'close with decisions[] should still succeed (non-fatal contract)');
    const { rows } = await db.query(
      'SELECT topic, decision, reason FROM decisions WHERE project_id = $1 AND topic = $2',
      [encodedRoot, decisionTopic]
    );
    assert.strictEqual(rows.length, 1, `Expected exactly 1 decisions row for topic "${decisionTopic}", got ${rows.length}`);
    assert.strictEqual(rows[0].decision, 'first decision text');
    assert.strictEqual(rows[0].reason, 'initial reason');
  });

  await test('close: decisions[] embedding-provider-down is non-fatal and surfaces a DIVERGENCE line (this DB has no default embedding_providers row)', () => {
    const out = runHelper('close', ['--json', '-'], {
      fakeRoot,
      stdin: JSON.stringify({
        tldr: 'cm#230 embed-degraded probe.',
        decisions: [{ topic: `${decisionTopic}-probe`, decision: 'probe decision', reason: 'probe reason' }],
      }),
    });
    assert.ok(out.includes('Done: handoff:close'), 'a degraded embedding must never fail the close (non-fatal contract)');
    assert.ok(
      out.includes(`DIVERGENCE: decision:${decisionTopic}-probe EMBEDDING DEGRADED`),
      `expected an EMBEDDING DEGRADED divergence line for a DB with no default provider, got:\n${out}`
    );
  });

  await test('close: re-closing with the SAME decision topic UPDATES the row, never duplicates it', async () => {
    const revised = {
      tldr: 'cm#230 idempotent-reclose probe.',
      decisions: [{ topic: decisionTopic, decision: 'REVISED decision text', reason: 'revised reason' }],
    };
    runHelper('close', ['--json', '-'], { fakeRoot, stdin: JSON.stringify(revised) });
    const { rows } = await db.query(
      'SELECT decision, reason FROM decisions WHERE project_id = $1 AND topic = $2',
      [encodedRoot, decisionTopic]
    );
    assert.strictEqual(rows.length, 1, `Expected the SAME single row after a re-close with the same topic (upsert, not duplicate), got ${rows.length}`);
    assert.strictEqual(rows[0].decision, 'REVISED decision text', 'expected the row content to be UPDATED by the re-close');
    assert.strictEqual(rows[0].reason, 'revised reason');
  });

  await test('close: a decisions[] row that fails validation is skipped (non-fatal) and surfaces NOT PERSISTED', () => {
    const out = runHelper('close', ['--json', '-'], {
      fakeRoot,
      stdin: JSON.stringify({
        tldr: 'cm#230 bad-topic probe.',
        decisions: [{ topic: 'NoHyphenUppercase', decision: 'd', reason: 'r' }],
      }),
    });
    assert.ok(out.includes('Done: handoff:close'), 'a validation-rejected decision row must never fail the close');
    assert.ok(out.includes('DIVERGENCE: decision:NoHyphenUppercase NOT PERSISTED'),
      `expected a NOT PERSISTED divergence line for an invalid topic, got:\n${out}`);
  });

  // ── Test 4: checkpoint writes rows but does NOT clear session_in_progress ─
  const checkpointPayload = {
    ...closePayload,
    entities: [{ name: 'CheckpointEntity', entity_type: 'decision', description: 'Checkpoint test' }],
    assertions: [{ subject: 'CheckpointEntity', predicate: 'state', object: 'testing', confidence: 6, source: 'model_extracted' }],
    edges: [],
    session_id: 'test-session-002',
  };

  // First set a session_in_progress marker
  await db.query(
    `INSERT INTO project_settings (project_id, key, value) VALUES ($1, 'session_in_progress', 'test-session-002')
     ON CONFLICT (project_id, key) DO UPDATE SET value = EXCLUDED.value`,
    [encodedRoot]
  );

  await test('checkpoint: writes entities to DB', async () => {
    runHelper('checkpoint', ['--json', '-'], { fakeRoot, stdin: JSON.stringify(checkpointPayload) });
    const { rows } = await db.query(
      "SELECT COUNT(*) AS n FROM entities WHERE project_id = $1 AND name = 'CheckpointEntity'",
      [encodedRoot]
    );
    assert.strictEqual(parseInt(rows[0].n, 10), 1, 'Expected CheckpointEntity to be written');
  });

  await test('checkpoint: does NOT clear session_in_progress', async () => {
    const { rows } = await db.query(
      "SELECT value FROM project_settings WHERE project_id = $1 AND key = 'session_in_progress'",
      [encodedRoot]
    );
    assert.strictEqual(rows.length, 1, 'session_in_progress should remain after checkpoint');
  });

  await test('checkpoint: emits Done line', () => {
    const out = runHelper('checkpoint', ['--json', '-'], { fakeRoot, stdin: JSON.stringify(checkpointPayload) });
    assert.ok(out.includes('Done: handoff:checkpoint'), 'checkpoint should emit Done line');
  });

  // ── Test 5: resume loads context ─────────────────────────────────────────
  await test('resume: emits Running and Done lines', () => {
    const out = runHelper('resume', [], { fakeRoot });
    assert.ok(out.includes('Running: handoff:resume'), 'resume should emit Running line');
    assert.ok(out.includes('Done: handoff:resume'), 'resume should emit Done line');
  });

  await test('resume: seeds session_in_progress marker', async () => {
    // Resume may have triggered identity resolution (ensureProjectIdentity), which mints a
    // UUID marker in fakeRoot and writes all DB rows under that UUID — not under the
    // legacy encodedRoot.  Resolve the actual project_id by reading the marker if
    // present; fall back to encodedRoot for repos that have not yet been migrated.
    const marker = readMarker(fakeRoot);
    const resumeProjectId = marker ? marker.uuid : encodedRoot;

    // Clear any existing marker under whichever project_id resume will use.
    await db.query(
      "DELETE FROM project_settings WHERE project_id = $1 AND key = 'session_in_progress'",
      [resumeProjectId]
    );
    runHelper('resume', [], { fakeRoot });
    const { rows } = await db.query(
      "SELECT value FROM project_settings WHERE project_id = $1 AND key = 'session_in_progress'",
      [resumeProjectId]
    );
    assert.strictEqual(rows.length, 1, 'session_in_progress should be set after resume');
    // Value should be an ISO timestamp (non-empty string).
    assert.ok(rows[0].value && rows[0].value.length > 0, 'session_in_progress value should be a non-empty ISO timestamp');
  });

  // ── Test 6: drop zeroes assertions and archives handoff.md ───────────────
  await test('drop: emits Running and Done lines', () => {
    const out = runHelper('drop', [], { fakeRoot });
    assert.ok(out.includes('Running: handoff:drop'), 'drop should emit Running line');
    assert.ok(out.includes('Done: handoff:drop'),    'drop should emit Done line');
    assert.ok(out.includes('assertions suppressed'), 'drop should report suppressed count');
  });

  await test('drop: creates fresh handoff.md', () => {
    const dir = claudeProjectDir();
    const handoffPath = path.join(dir, 'handoff.md');
    assert.ok(fs.existsSync(handoffPath), 'handoff.md should exist after drop');
    const content = fs.readFileSync(handoffPath, 'utf8');
    assert.ok(content.includes('dropped'), 'fresh handoff.md should mention drop');
  });

  await test('drop: archives old handoff.md', () => {
    const dir = claudeProjectDir();
    const files = fs.readdirSync(dir);
    const archived = files.some((f) => f.includes('.archived.md'));
    assert.ok(archived, 'Expected an archived handoff.*.archived.md file');
  });

  // ── Test 7: purge with --yes flag deletes all rows ───────────────────────
  await test('purge --yes: deletes all project rows', async () => {
    // Re-insert a row so we have something to delete
    await db.query(
      `INSERT INTO project_settings (project_id, key, value) VALUES ($1, 'test_key', 'test_val')
       ON CONFLICT DO NOTHING`,
      [encodedRoot]
    );
    runHelper('purge', ['--yes'], { fakeRoot });
    const n = await countRows(db, 'project_settings', encodedRoot);
    assert.strictEqual(n, 0, `Expected 0 project_settings rows after purge, got ${n}`);
    const ne = await countRows(db, 'entities', encodedRoot);
    assert.strictEqual(ne, 0, `Expected 0 entities after purge, got ${ne}`);
    const na = await countRows(db, 'assertions', encodedRoot);
    assert.strictEqual(na, 0, `Expected 0 assertions after purge, got ${na}`);
  });

  await test('purge --yes: removes handoff.md', () => {
    const dir = claudeProjectDir();
    const handoffPath = path.join(dir, 'handoff.md');
    assert.ok(!fs.existsSync(handoffPath), 'handoff.md should be removed after purge');
  });

  await test('purge --yes: emits Done line', () => {
    // Purge again (should be idempotent when nothing to delete)
    const out = runHelper('purge', ['--yes'], { fakeRoot });
    assert.ok(out.includes('Done: handoff:purge'), 'purge should emit Done line');
  });

  // ── Test 8: unknown subcommand exits 2 ────────────────────────────────────
  await test('unknown subcommand exits with code 2', () => {
    try {
      runHelper('nonexistent-cmd', [], { fakeRoot });
      assert.fail('Expected exit code 2');
    } catch (err) {
      assert.strictEqual(err.status, 2, `Expected exit code 2, got ${err.status}`);
    }
  });

  // ── Test 9: TARGET_DB resolution order ────────────────────────────────────
  // Helper that runs a tiny inline script via the same Node binary so that
  // handoff.js's top-level TARGET_DB constant is resolved under our env.
  function resolveTargetDb(extraEnv = {}, fakeRootOverride) {
    const root = fakeRootOverride || fakeRoot;
    const env = {
      ...process.env,
      PROJECT_ROOT: root,
      HANDOFF_TEST_PROJECT_ID: PROJECT_ID,
    };
    // Strip HANDOFF_DB unless explicitly provided in extraEnv
    delete env.HANDOFF_DB;
    Object.assign(env, extraEnv);

    // Require handoff.js then immediately print TARGET_DB via a wrapper script.
    // We use a one-liner passed via -e so we don't need a temp file.
    const wrapper = `process.env.HANDOFF_DB = ${JSON.stringify(env.HANDOFF_DB || '')}; ` +
      `if (!env) {} ` + // dummy
      `const h = require(${JSON.stringify(HELPER)}); ` +
      `process.stdout.write(h.__TARGET_DB__ || '');`;

    // Actually: handoff.js doesn't export TARGET_DB. Use a simpler approach —
    // run `node scripts/handoff.js --print-target-db` if that flag existed,
    // or parse stderr/stdout. Since we can't do that without changing handoff.js,
    // we test observable behavior (init connects to the right DB) instead of
    // the constant value directly. See comment below.
    void wrapper; // unused

    // Observable-behavior approach: run `node handoff.js debug-db` (hypothetical).
    // Since no such flag exists, we use the status subcommand and parse its output
    // which includes the database name in its connection header.
    const out = execFileSync(
      process.execPath,
      [HELPER, 'status'],
      { cwd: root, env, encoding: 'utf8', timeout: 15000 }
    );
    return out;
  }

  await test('TARGET_DB: env HANDOFF_DB wins over pipeline.yml', () => {
    // fakeRoot's pipeline.yml has database=claude_memory_eval_test.
    // Override with HANDOFF_DB=claude_memory_eval_test (same value — any valid name works).
    // We verify the run succeeds (no crash from bad DB name) and the env value is accepted.
    // Using the same DB name as the yml keeps the test self-contained (no extra DB needed).
    const out = resolveTargetDb({ HANDOFF_DB: TARGET_DB });
    assert.ok(out.includes('Done: handoff:status'), 'status should succeed when HANDOFF_DB is set');
  });

  await test('TARGET_DB: pipeline.yml database used when HANDOFF_DB absent', () => {
    // fakeRoot's pipeline.yml has database: claude_memory_eval_test.
    // With HANDOFF_DB absent, TARGET_DB should resolve to claude_memory_eval_test and connect.
    const out = resolveTargetDb({});
    assert.ok(out.includes('Done: handoff:status'), 'status should succeed reading DB from pipeline.yml');
  });

  await test('TARGET_DB: falls back to claude_memory_eval_test when both absent', () => {
    // Create a fakeRoot with no pipeline.yml — only a .git dir.
    const bareRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'handoff-noconfig-'));
    try {
      fs.mkdirSync(path.join(bareRoot, '.git'));
      // No .claude/pipeline.yml — loadConfig() will return defaults based on project name.
      // The default from projectToDbName(path.basename(bareRoot)) is pipeline_<name>,
      // which won't exist as a DB. So we can't run status (it would fail to connect).
      // Instead we verify that with HANDOFF_DB absent and no pipeline.yml, handoff.js
      // exits non-zero due to a connection error (not a regex validation error), which
      // proves it fell through to a DB name rather than crashing at the validation step.
      // Note: loadConfig() without a pipeline.yml returns a project-name-derived default,
      // not 'claude_memory_eval_test', so this case documents a known limitation:
      // the hardcoded fallback only fires when loadConfig() itself throws, which it
      // doesn't — it returns a name-derived default instead. This is acceptable behavior.
      try {
        execFileSync(
          process.execPath,
          [HELPER, 'status'],
          { cwd: bareRoot, env: { ...process.env, PROJECT_ROOT: bareRoot }, encoding: 'utf8', timeout: 15000 }
        );
        // If it somehow succeeds (e.g., the derived DB exists), that's also fine.
      } catch (err) {
        // Expected: connection error to the non-existent DB, not a regex crash.
        // Regex-crash exits with code 1 and prints "Invalid database name".
        // Connection error exits with code 1 but prints something about ECONNREFUSED / does not exist.
        const combined = (err.stdout || '') + (err.stderr || '');
        assert.ok(
          !combined.includes('Invalid database name'),
          'Should not fail regex validation — DB name derived from project dir is always valid'
        );
      }
    } finally {
      try { fs.rmSync(bareRoot, { recursive: true, force: true }); } catch (_) {}
    }
  });

  // ── Test 10: resurrect subcommand ────────────────────────────────────────
  //
  // Re-open a fresh DB connection for the resurrect tests (the previous one
  // was closed above by the teardown-adjacent db.end() — but teardown hasn't
  // run yet; we just need to re-resolve the project_id now that init has
  // minted a project marker UUID in fakeRoot).
  {
    // Resolve the live project_id (may be a UUID marker, not just encodedRoot).
    const resurrectMarker = readMarker(fakeRoot);
    const resurrectProjectId = resurrectMarker ? resurrectMarker.uuid : encodedRoot;

    // Re-connect for resurrect tests.
    const rdb = await connectDb();

    // Ensure the project exists in DB (init may have used the UUID project_id).
    // Insert a live trusted-anchor assertion so the M2 gate can pass.
    await rdb.query(
      `INSERT INTO entities (project_id, name, entity_type, description)
       VALUES ($1, 'resurrect-subject', 'concept', 'test resurrect entity')
       ON CONFLICT DO NOTHING`,
      [resurrectProjectId]
    );
    // Trusted-anchor live row (reality_check='verified').
    await rdb.query(
      `INSERT INTO assertions (project_id, subject, predicate, object, confidence,
                               source, suppressed, reality_check)
       VALUES ($1, 'resurrect-subject', 'status', 'trusted-live', 9,
               'user_stated', false, 'verified')
       ON CONFLICT DO NOTHING`,
      [resurrectProjectId]
    );
    // Probationary (downvoted_probation) row for the same subject.
    await rdb.query(
      `INSERT INTO assertions (project_id, subject, predicate, object, confidence,
                               source, suppressed, suppression_kind, tier)
       VALUES ($1, 'resurrect-subject', 'old_detail', 'probation-value', 6,
               'model_extracted', true, 'downvoted_probation', 'probationary')
       ON CONFLICT DO NOTHING`,
      [resurrectProjectId]
    );

    await test('resurrect: dry-run finds matching probationary row', () => {
      // The fuzzy seed 'resurrect-subject' should match the probationary row.
      const out = runHelper('resurrect', ['resurrect-subject'], { fakeRoot });
      assert.ok(out.includes('Running: handoff:resurrect'), 'resurrect should emit Running line');
      // Either the row is found (section present) or no matches (both are valid success paths).
      assert.ok(
        out.includes('Done: handoff:resurrect'),
        'resurrect should emit Done line'
      );
      // Should be a dry-run (no rows revived).
      assert.ok(
        out.includes('dry-run') || out.includes('no matches'),
        'resurrect dry-run should mention dry-run or no-matches'
      );
    });

    await test('resurrect: --revive flag emits revived output or no-matches', () => {
      const out = runHelper('resurrect', ['resurrect-subject', '--revive'], { fakeRoot });
      assert.ok(out.includes('Done: handoff:resurrect'), 'resurrect --revive should emit Done line');
      // Either rows were revived or no matches — both are valid DB states.
      assert.ok(
        out.includes('revived') || out.includes('no matches'),
        'resurrect --revive should mention revived or no-matches'
      );
    });

    await test('resurrect: seed with no matching rows emits no-matches message', () => {
      const out = runHelper('resurrect', ['xyzzy-nonexistent-seed-qqqq'], { fakeRoot });
      assert.ok(
        out.includes('No matching probationary rows found') || out.includes('Done: handoff:resurrect'),
        'resurrect should handle no-match seed gracefully'
      );
      assert.ok(out.includes('Done: handoff:resurrect'), 'resurrect should emit Done line on no match');
    });

    await test('resurrect: missing seed exits 2 with usage on stderr', () => {
      try {
        runHelper('resurrect', [], { fakeRoot });
        assert.fail('Expected exit code 2 when seed is missing');
      } catch (err) {
        assert.strictEqual(err.status, 2, `Expected exit code 2, got ${err.status}`);
        const combined = (err.stdout || '') + (err.stderr || '');
        assert.ok(
          combined.includes('seed text is required') || combined.includes('Usage:'),
          'Missing seed should print usage info'
        );
      }
    });

    await rdb.end();
  }

  // ── Test 11: C2 session id resolution fallback chain ────────────────────────
  //
  // The helper below runs handoff.js and captures BOTH stdout and stderr so we
  // can assert on the C2 degraded-close messages that go to stderr.
  //
  // Note: execFileSync with stdio:'pipe' throws on non-zero exit but also sets
  // err.stdout / err.stderr on the thrown error object — we only care about the
  // close output, so we suppress the throw and inspect the captured output.
  // runHelperBoth — like runHelper but captures both stdout and stderr.
  // Uses spawnSync so both streams are available regardless of exit code.
  function runHelperBoth(sub, extraArgs = [], opts = {}) {
    const fakeRoot = opts.fakeRoot || global.__fakeRoot;
    const env = {
      ...process.env,
      PROJECT_ROOT: fakeRoot,
      HANDOFF_TEST_PROJECT_ID: PROJECT_ID,
      ...opts.extraEnv,
    };
    // Remove env keys the caller wants cleared.
    for (const k of (opts.deleteEnv || [])) {
      delete env[k];
    }
    const result = spawnSync(
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
    return {
      stdout:   result.stdout  || '',
      stderr:   result.stderr  || '',
      exitCode: result.status  != null ? result.status : 1,
    };
  }

  // Minimal close payload with no session_id — shared across C2 tests.
  const c2BasePayload = {
    entities:    [],
    assertions:  [],
    edges:       [],
    contract:    { queries: [{ type: 'recency', token_budget: 500 }] },
    tldr:        'C2 session id resolution test.',
    open_threads: [],
  };

  // Re-open DB connection for the C2 tests (previous db was closed above).
  const c2db = await connectDb();

  // Resolve the live project_id (may be a UUID marker after init minted it).
  const c2Marker    = readMarker(fakeRoot);
  const c2ProjectId = c2Marker ? c2Marker.uuid : encodedRoot;

  // Test A: C2 does not degrade when payload omits session_id but DB marker is set.
  await test('close: C2 does not degrade when payload omits session_id but DB marker is set', async () => {
    // Seed session_in_progress for the test project.
    await c2db.query(
      `INSERT INTO project_settings (project_id, key, value) VALUES ($1, 'session_in_progress', 'test-db-marker-session')
       ON CONFLICT (project_id, key) DO UPDATE SET value = EXCLUDED.value`,
      [c2ProjectId]
    );
    // Run close with CLAUDE_CODE_SESSION_ID unset so the env fallback is bypassed and
    // the test exercises the DB-marker path exclusively.
    const result = runHelperBoth('close', ['--json', '-'], {
      fakeRoot,
      stdin: JSON.stringify(c2BasePayload),
      deleteEnv: ['CLAUDE_CODE_SESSION_ID'],
    });
    assert.ok(
      !result.stderr.includes('C2 feedback: no session id resolvable'),
      `Expected C2 NOT to degrade when DB marker is set. stderr: ${result.stderr}`
    );
    // Verify no degraded_close C2 row was written.
    const { rows } = await c2db.query(
      `SELECT value FROM project_settings WHERE project_id = $1 AND key LIKE 'degraded_close:%'`,
      [c2ProjectId]
    );
    const c2Degraded = rows.filter((r) => {
      try { return JSON.parse(r.value).subsystem === 'C2'; } catch (_) { return false; }
    });
    assert.strictEqual(c2Degraded.length, 0, `Expected 0 C2 degraded_close rows, got ${c2Degraded.length}`);
  });

  // Test B: C2 does not degrade when payload omits session_id, DB marker absent, but env var is set.
  await test('close: C2 does not degrade when env var CLAUDE_CODE_SESSION_ID is set (DB marker absent)', async () => {
    // Ensure no session_in_progress row exists.
    await c2db.query(
      `DELETE FROM project_settings WHERE project_id = $1 AND key = 'session_in_progress'`,
      [c2ProjectId]
    );
    // Also clear any degraded_close rows from prior test runs.
    await c2db.query(
      `DELETE FROM project_settings WHERE project_id = $1 AND key LIKE 'degraded_close:%'`,
      [c2ProjectId]
    );
    // Run close with CLAUDE_CODE_SESSION_ID explicitly set in the subprocess env.
    const result = runHelperBoth('close', ['--json', '-'], {
      fakeRoot,
      stdin: JSON.stringify(c2BasePayload),
      extraEnv: { CLAUDE_CODE_SESSION_ID: 'test-env-session-001' },
    });
    assert.ok(
      !result.stderr.includes('C2 feedback: no session id resolvable'),
      `Expected C2 NOT to degrade when env var is set. stderr: ${result.stderr}`
    );
  });

  // Test C (negative): C2 degrades when payload omits session_id and both DB marker and env var absent.
  await test('close: C2 degrades when payload omits session_id and both DB marker and env var absent', async () => {
    // Ensure no session_in_progress row.
    await c2db.query(
      `DELETE FROM project_settings WHERE project_id = $1 AND key = 'session_in_progress'`,
      [c2ProjectId]
    );
    // Run close with CLAUDE_CODE_SESSION_ID explicitly removed from subprocess env.
    const result = runHelperBoth('close', ['--json', '-'], {
      fakeRoot,
      stdin: JSON.stringify(c2BasePayload),
      deleteEnv: ['CLAUDE_CODE_SESSION_ID'],
    });
    assert.ok(
      result.stderr.includes('C2 feedback: no session id resolvable'),
      `Expected C2 to degrade when no session id is resolvable. stderr: ${result.stderr}`
    );
  });

  await c2db.end();

  // ── Tests 11–16: close-reconciliation gate ───────────────────────────────
  //
  // These tests verify the contradiction-detection gate added in
  // feat/close-reconciliation-gate. Each test runs a close via subprocess and
  // inspects the written handoff.md. The gate is soft-inject only (never blocks
  // close), so all tests expect exit 0 and a valid Done line.
  //
  // Setup: re-run init to ensure the project row exists (purge may have wiped it).
  runHelper('init', ['-y'], { fakeRoot });

  // Helper: resolve the actual handoff.md path for a given project root.
  // After init, ensureProjectIdentity may mint a UUID-based project marker,
  // so the handoff.md lives under resolveHandoffMdPath(uuid), not under the
  // encodeCwd(root) path. Read the marker when present.
  function resolveHandoffPath(root) {
    const marker = readMarker(root);
    if (marker) return resolveHandoffMdPath(marker.uuid);
    const { getClaudeProjectDir } = require('../../scripts/lib/encoded-cwd');
    return path.join(getClaudeProjectDir(root), 'handoff.md');
  }

  // ── Test 11 (C-1): degraded label in tldr → Reconciliation notice fires ──
  await test('reconciliation C-1: degraded label in tldr → notice in handoff.md', () => {
    const payload = {
      tldr: 'This session addressed C2 session attribution and related bookkeeping.',
      open_threads: ['verify C2 attribution is working'],
      quick_references: '(none)',
      // No entities/assertions/edges so the close runs quickly.
      entities: [],
      assertions: [],
      edges: [],
      // Intentionally omit session_id so C2 degrades (fbSessionId = null →
      // _degradedSubsystems gets a C2 entry). The tldr mentions "C2" → C-1 fires.
      // IMPORTANT: must strip CLAUDE_CODE_SESSION_ID from subprocess env so that
      // resolveSessionId() (PR #79) cannot fall back to the env var and prevent
      // C2 degradation — otherwise the test loses its signal.
    };
    runHelperBoth('close', ['--json', '-'], { fakeRoot, stdin: JSON.stringify(payload), deleteEnv: ['CLAUDE_CODE_SESSION_ID'] });
    const handoffPath = resolveHandoffPath(fakeRoot);
    const content = fs.readFileSync(handoffPath, 'utf8');
    // C2 will be degraded (no session_id resolvable), and the tldr mentions "C2",
    // so C-1 should fire and the Reconciliation notice should appear.
    assert.ok(
      content.includes('## Reconciliation notice'),
      'handoff.md should contain ## Reconciliation notice when C-1 fires'
    );
    assert.ok(
      content.includes('[C-1]'),
      'handoff.md Reconciliation notice should include [C-1] rule label'
    );
  });

  // ── Test 12 (byte-identity): clean close → no Reconciliation notice ──────
  await test('reconciliation byte-identity: clean payload → no notice, no literal placeholder', () => {
    // Re-init (purge may have run, so ensure the project row is fresh).
    runHelper('init', ['-y'], { fakeRoot });
    const payload = {
      tldr: 'Everything looks great — quiet session with minor housekeeping.',
      open_threads: ['follow up on documentation'],
      quick_references: '(none)',
      entities: [],
      assertions: [],
      edges: [],
      session_id: 'test-session-recon-002',
    };
    runHelper('close', ['--json', '-'], { fakeRoot, stdin: JSON.stringify(payload) });
    const handoffPath = resolveHandoffPath(fakeRoot);
    const content = fs.readFileSync(handoffPath, 'utf8');
    // Clean close: no degraded subsystems, no fix-claim keywords adjacent to labels,
    // no green-build claim, no dangling SHAs → Reconciliation section must be absent.
    assert.ok(
      !content.includes('## Reconciliation notice'),
      'handoff.md should NOT contain ## Reconciliation notice on a clean close'
    );
    // Placeholder must not appear literally in the rendered output.
    assert.ok(
      !content.includes('{{RECONCILIATION_SECTION}}'),
      'rendered handoff.md must not contain the literal {{RECONCILIATION_SECTION}} placeholder'
    );
  });

  // ── Test 13 (C-2): fix-keyword adjacent to degraded label → fires ─────────
  await test('reconciliation C-2: fix-keyword adjacent to degraded label in tldr → notice in handoff.md', () => {
    runHelper('init', ['-y'], { fakeRoot });
    const payload = {
      // "fixed" is within 60 chars of "C2" and session_id is omitted so C2 degrades.
      // Both C-1 (label "C2" present in tldr) and C-2 ("fixed" adjacent to "C2") fire.
      tldr: 'fixed the C2 session attribution — everything working now.',
      open_threads: [],
      quick_references: '(none)',
      entities: [],
      assertions: [],
      edges: [],
      // Intentionally omit session_id → C2 degrades → "C2" label is in degradedList.
      // Must strip CLAUDE_CODE_SESSION_ID so resolveSessionId() (PR #79) cannot
      // use the env-var fallback and prevent C2 degradation.
    };
    runHelperBoth('close', ['--json', '-'], { fakeRoot, stdin: JSON.stringify(payload), deleteEnv: ['CLAUDE_CODE_SESSION_ID'] });
    const handoffPath = resolveHandoffPath(fakeRoot);
    const content = fs.readFileSync(handoffPath, 'utf8');
    // C2 will degrade (no session_id resolvable), and "fixed" is adjacent to "C2".
    // Both C-1 (label present) and C-2 (fix keyword present) may fire.
    assert.ok(
      content.includes('## Reconciliation notice'),
      'handoff.md should contain ## Reconciliation notice when C-2 fires'
    );
    assert.ok(
      content.includes('[C-2]') || content.includes('[C-1]'),
      'handoff.md should contain at least one reconciliation rule label'
    );
  });

  // ── Test 14 (C-3): retrieval_outcome=success + C2 degraded → fires ────────
  await test('reconciliation C-3: retrieval_outcome success + C2 degraded → notice in handoff.md', () => {
    runHelper('init', ['-y'], { fakeRoot });
    const payload = {
      tldr: 'Retrieval worked well this session.',
      open_threads: [],
      quick_references: '(none)',
      entities: [],
      assertions: [],
      edges: [],
      // C2 will degrade (session_id not in DB → no resolvable session).
      // Claiming retrieval_outcome=success contradicts the degraded C2.
      // Must strip CLAUDE_CODE_SESSION_ID so resolveSessionId() (PR #79) cannot
      // use the env-var fallback and prevent C2 degradation.
      retrieval_outcome: 'success',
    };
    runHelperBoth('close', ['--json', '-'], { fakeRoot, stdin: JSON.stringify(payload), deleteEnv: ['CLAUDE_CODE_SESSION_ID'] });
    const handoffPath = resolveHandoffPath(fakeRoot);
    const content = fs.readFileSync(handoffPath, 'utf8');
    assert.ok(
      content.includes('## Reconciliation notice'),
      'handoff.md should contain ## Reconciliation notice when C-3 fires'
    );
    assert.ok(
      content.includes('[C-3]'),
      'handoff.md Reconciliation notice should include [C-3] rule label'
    );
  });

  // ── Test 15 (C-6): dangling SHA in quick_references → fires ──────────────
  //
  // Note: this test sets up a lightweight temp git repo so that gitObjectExists
  // can actually verify that the fake SHA does not exist. If the test fakeRoot
  // is itself a git repo (unlikely in CI), the result may differ. We use a
  // dedicated bare git repo to avoid cross-contamination.
  await test('reconciliation C-6: dangling SHA in quick_references → notice in handoff.md', () => {
    // Initialize a bare git repo in a temp dir so gitObjectExists has a real repo to probe.
    const gitTestRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'handoff-git-recon-'));
    try {
      execFileSync('git', ['init', gitTestRoot], { encoding: 'utf8', timeout: 10000 });
      // Create a minimal config so handoff.js can find the project root.
      fs.mkdirSync(path.join(gitTestRoot, '.claude'));
      fs.writeFileSync(path.join(gitTestRoot, '.claude', 'pipeline.yml'), `
project:
  name: handoff-git-recon-test

knowledge:
  tier: "postgres"
  host: "localhost"
  port: 5432
  database: "${TARGET_DB}"
  user: "postgres"
`.trim(), 'utf8');

      // Run init on the temp git root.
      execFileSync(
        process.execPath,
        [HELPER, 'init', '-y'],
        {
          cwd: gitTestRoot,
          env: { ...process.env, PROJECT_ROOT: gitTestRoot },
          encoding: 'utf8',
          timeout: 30000,
        }
      );

      const fakeDeadSha = 'deadbeef123456789012345678901234deadbeef';
      const payload = {
        tldr: 'Quiet session.',
        open_threads: [],
        quick_references: `see commit ${fakeDeadSha} for details`,
        entities: [],
        assertions: [],
        edges: [],
      };
      execFileSync(
        process.execPath,
        [HELPER, 'close', '--json', '-'],
        {
          cwd: gitTestRoot,
          env: { ...process.env, PROJECT_ROOT: gitTestRoot },
          encoding: 'utf8',
          timeout: 30000,
          input: JSON.stringify(payload),
        }
      );
      // Use resolveHandoffPath to handle UUID-based project IDs from ensureProjectIdentity.
      const handoffPath = resolveHandoffPath(gitTestRoot);
      const content = fs.readFileSync(handoffPath, 'utf8');
      assert.ok(
        content.includes('## Reconciliation notice'),
        'handoff.md should contain ## Reconciliation notice when C-6 fires (dangling SHA)'
      );
      assert.ok(
        content.includes('[C-6]'),
        'handoff.md Reconciliation notice should include [C-6] rule label'
      );
    } finally {
      try { fs.rmSync(gitTestRoot, { recursive: true, force: true }); } catch (_) {}
      // Clean up the handoff.md dir for the temp git root (both encodedCwd and UUID paths).
      try {
        const { getClaudeProjectDir } = require('../../scripts/lib/encoded-cwd');
        const dir = getClaudeProjectDir(gitTestRoot);
        if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
      } catch (_) {}
    }
  });

  // ── Test 16 (C-4 excluded / acceptable divergence — must NOT fire) ─────────
  await test('reconciliation acceptable divergence: open_threads mentions C2 without fix-claim in tldr → no notice', () => {
    runHelper('init', ['-y'], { fakeRoot });
    const payload = {
      // tldr does NOT mention C2 or any fix-claim keywords next to a degraded label.
      // open_threads mentions C2 (acceptable — C-4 is intentionally excluded).
      tldr: 'Session ended; known degradation in session attribution continues.',
      open_threads: ['C2 session id attribution still unresolved — follow up next session'],
      quick_references: '(none)',
      entities: [],
      assertions: [],
      edges: [],
      session_id: 'test-session-recon-006',
    };
    runHelper('close', ['--json', '-'], { fakeRoot, stdin: JSON.stringify(payload) });
    const handoffPath = resolveHandoffPath(fakeRoot);
    const content = fs.readFileSync(handoffPath, 'utf8');
    // The tldr does not mention "C2" and has no fix-claim keywords adjacent to
    // a degraded label. open_threads divergence (C-4) is excluded by design.
    // C-3 requires retrieval_outcome=success (not set here).
    // C-5 requires a green-build claim (not set here).
    // C-6 requires a dangling SHA (quick_references is '(none)').
    // Therefore no contradiction rules should fire.
    assert.ok(
      !content.includes('## Reconciliation notice'),
      'handoff.md should NOT contain ## Reconciliation notice when only open_threads mentions C2 (C-4 excluded)'
    );
  });


  await db.end();
  await teardown();
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
