'use strict';

/**
 * test-migrate-09-file-memory-markdown.js — Test harness for
 * scripts/migrations/migrate-09-file-memory-markdown.js
 * (CONSOLIDATION-RUNBOOK.md §6.1(i)).
 *
 * Mirrors test-migrate-02-decisions.js's conventions: self-contained
 * scratch databases ("_staging"-suffixed to satisfy migrate-01's own
 * classifyTarget, reused by reference), unconditional cleanup, never
 * touches claude_policy_framework/memory_manager_staging. All fixture
 * content is SYNTHETIC — no real project names, real memory-file content,
 * or owner filesystem paths (public repo).
 *
 * Covers (pure, no DB):
 *   - classifyProjectDir: enrolled / test-artifact-excluded / unmatched-
 *     flagged, precedence order.
 *   - resolveEntityType: frontmatter.type, frontmatter.metadata.type,
 *     filename-prefix fallback (logged), unmatched-type -> null (logged).
 *   - listTopicFiles: MEMORY.md excluded case-insensitively (I-7); the
 *     `.md.bak-<ts>` double-suffix sibling excluded by the extname()
 *     boundary rule, not a substring/endsWith check (I-9, named
 *     regression fixture).
 *   - extractWikiLinks: fenced-code-block bash `[[ -f x ]]` false positive
 *     avoided (I-5, named regression); inline-code false positive
 *     avoided; `|alias`/`#anchor` stripped (I-6); malformed empty target.
 *   - parseMemoryIndex: MEMORY.md index -> stem->description map.
 *   - parseProjectMemoryDir: end-to-end synthetic fixture tree exercising
 *     every construction above together.
 *
 * Covers (DB, disposable "_staging"-suffixed scratch target):
 *   - Happy-path migrate: entities/edges/manifest rows land correctly,
 *     entity_type NULL for the unmatched-type case (proves the
 *     DROP NOT NULL addendum applied).
 *   - Idempotent re-run: no duplicate edges (I-10 supersession, field
 *     finding 2026-08-16 — the write path is now an existence-guarded
 *     insert scoped to this script's own source_model tag, NOT an
 *     `ON CONFLICT` upsert against a UNIQUE index; the plain
 *     edges_project_from_type_to_idx lookup index applied by
 *     sql/migrate-09-file-memory-schema.sql is non-unique by design so it
 *     can coexist with the real table's legitimate historical duplicate
 *     4-tuples).
 *   - I-10 regressions: this script's own write is invisible to other
 *     writers' pre-existing duplicate tuples (never blocked by them) and
 *     unaffected by their presence on re-run; a target carrying duplicate
 *     tuples proves the plain index applies cleanly where the old UNIQUE
 *     index would have failed to even create.
 *   - I-12 precedence: a pre-existing entities row tagged a DIFFERENT
 *     source_model keeps its description untouched by this migration.
 *   - I-13 rollback: reference-count-gated entity cleanup — an entity
 *     with a surviving edge from another writer is preserved; one with
 *     none is deleted.
 *   - Prerequisite refusal: missing entities/edges table refuses loud,
 *     nothing applied.
 *
 * Usage: node test/migrations/test-migrate-09-file-memory-markdown.js
 * Exit 0 = all pass; nonzero = any failure.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { createRequire } = require('module');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const MIGRATE_ONE_PATH = path.join(PROJECT_ROOT, 'scripts', 'migrations', 'migrate-01-canonical-db.js');
const ADDENDA_PATH = path.join(PROJECT_ROOT, 'scripts', 'migrations', 'migrate-schema-addenda.js');
const MIGRATE09_PATH = path.join(PROJECT_ROOT, 'scripts', 'migrations', 'migrate-09-file-memory-markdown.js');
const EXAMPLE_ENROLLMENT_CONFIG_PATH = path.join(PROJECT_ROOT, 'scripts', 'migrations', 'file-memory-project-enrollment.example.json');

const migrate09 = require(MIGRATE09_PATH);

const scriptsRequire = createRequire(require.resolve('../../scripts/package.json'));
const { Client } = scriptsRequire('pg');

const TS = Date.now();

let passed = 0;
let failed = 0;

function pass(id, label) { console.log(`[${id}] ${label} ... PASS`); passed++; }
function fail(id, label, reason) { console.log(`[${id}] ${label} ... FAIL: ${reason}`); failed++; }
async function run(id, label, fn) {
  try { await fn(); pass(id, label); } catch (err) { fail(id, label, err && err.message ? err.message : String(err)); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }

function pgConfig(database) {
  return {
    host: process.env.PGHOST || 'localhost',
    port: parseInt(process.env.PGPORT || '5432', 10),
    user: process.env.PGUSER || 'postgres',
    password: process.env.PGPASSWORD || 'postgres',
    database,
  };
}
async function pgConnect(database = 'postgres') {
  const client = new Client(pgConfig(database));
  await client.connect();
  return client;
}
async function dropDb(dbName) {
  let sys;
  try {
    sys = await pgConnect('postgres');
    await sys.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`, [dbName]);
    await sys.query(`DROP DATABASE IF EXISTS "${dbName}"`);
  } catch (_) { /* best-effort */ } finally {
    if (sys) { try { await sys.end(); } catch (_) {} }
  }
}

function runMigrateOne(args, timeoutMs = 30000) {
  return spawnSync(process.execPath, [MIGRATE_ONE_PATH, ...args], { cwd: PROJECT_ROOT, env: process.env, encoding: 'utf8', timeout: timeoutMs });
}
function runAddenda(args, timeoutMs = 20000) {
  return spawnSync(process.execPath, [ADDENDA_PATH, ...args], { cwd: PROJECT_ROOT, env: process.env, encoding: 'utf8', timeout: timeoutMs });
}
function runMigrate09(args, timeoutMs = 30000) {
  return spawnSync(process.execPath, [MIGRATE09_PATH, ...args], { cwd: PROJECT_ROOT, env: process.env, encoding: 'utf8', timeout: timeoutMs });
}

/** Only migrate-01 (entities/edges tables) — used by the T7 prerequisite-refusal fixture, deliberately WITHOUT addenda. */
async function setupBareTargetSchema(dbName) {
  const r1 = runMigrateOne(['--db', dbName]);
  if (r1.status !== 0) throw new Error(`migrate-01 fixture setup failed: status=${r1.status} stderr=${r1.stderr}`);
}

/** Full fixture schema: migrate-01 (entities/edges) + migrate-schema-addenda (source_model/agent_id attribution columns). */
async function setupTargetSchema(dbName) {
  await setupBareTargetSchema(dbName);
  const r2 = runAddenda(['--db', dbName]);
  if (r2.status !== 0) throw new Error(`schema-addenda fixture setup failed: status=${r2.status} stderr=${r2.stderr}`);
}

// ─── SYNTHETIC FIXTURE TREE ─────────────────────────────────────────────────

/**
 * Builds a synthetic --projects-root tree covering every construction under
 * test: an enrolled project with topic files exercising every entity_type
 * resolution branch + wiki-link shape, a test-artifact-pattern-matching dir
 * (never enrolled), and an unmatched-flagged dir (memory/-bearing, not in
 * the enrollment config, not a test-artifact pattern).
 */
function buildFixtureTree(rootDir) {
  const enrolledDirName = 'C--Users-example-dev-proj-alpha';
  const enrolledDir = path.join(rootDir, enrolledDirName);
  const memoryDir = path.join(enrolledDir, 'memory');
  fs.mkdirSync(memoryDir, { recursive: true });

  // 1. frontmatter.type present.
  fs.writeFileSync(path.join(memoryDir, 'user_alpha_topic.md'), [
    '---',
    'name: user-alpha-topic',
    'type: user',
    '---',
    '',
    'Body text with a reference to [[project_beta_topic]] here.',
  ].join('\n'), 'utf8');

  // 2. frontmatter.type absent, frontmatter.metadata.type present.
  fs.writeFileSync(path.join(memoryDir, 'project_beta_topic.md'), [
    '---',
    'name: project-beta-topic',
    'metadata:',
    '  type: project',
    '  originSessionId: synthetic-session-0001',
    '---',
    '',
    'No links here.',
  ].join('\n'), 'utf8');

  // 3. no type anywhere; filename-prefix fallback (feedback_ -> feedback).
  fs.writeFileSync(path.join(memoryDir, 'feedback_gamma_topic.md'), [
    '---',
    'name: feedback-gamma-topic',
    '---',
    '',
    'A fenced shell snippet that must NOT be mis-scanned as a wiki-link (I-5):',
    '```bash',
    'if [[ -f some-file ]]; then echo ok; fi',
    '```',
    '',
    'An inline-code false positive that must also be avoided: `[[not-a-link]]`.',
    '',
    'A real link with alias and anchor stripped: [[project_beta_topic#Section One|Beta]].',
    '',
    'A malformed empty-target link: [[]].',
    '',
    'A broken link to a file that does not exist: [[does_not_exist_topic]].',
  ].join('\n'), 'utf8');

  // 4. no type anywhere AND no recognized filename prefix -> unmatched-type, NULL.
  fs.writeFileSync(path.join(memoryDir, 'unrecognized_delta_topic.md'), [
    '---',
    'name: unrecognized-delta-topic',
    '---',
    '',
    'No frontmatter type, no recognized filename prefix.',
  ].join('\n'), 'utf8');

  // I-9 named regression fixture: a `.md.bak-<ts>` double-suffix sibling —
  // extname() is `.bak-...`, not `.md`; must be excluded by the boundary
  // rule alone, not by a special-cased filter.
  fs.writeFileSync(path.join(memoryDir, 'user_alpha_topic.md.bak-20260101'), 'stale backup content, must never be walked', 'utf8');

  // I-7: MEMORY.md excluded by exact name, case-insensitive — write it
  // lowercase-varied to prove the check is case-insensitive.
  fs.writeFileSync(path.join(memoryDir, 'MEMORY.md'), [
    '- [Alpha Topic](user_alpha_topic.md) — the alpha topic description',
    '- [Beta Topic](project_beta_topic.md) — the beta topic description',
    '- [Gamma Topic](feedback_gamma_topic.md) — the gamma topic description',
  ].join('\n'), 'utf8');

  // Test-artifact-excluded dir: matches the example config's eval-harness
  // temp naming convention pattern.
  const testArtifactDirName = `C--Users-example-AppData-Local-Temp-claude-memory-eval-${TS}`;
  fs.mkdirSync(path.join(rootDir, testArtifactDirName, 'memory'), { recursive: true });
  fs.writeFileSync(path.join(rootDir, testArtifactDirName, 'memory', 'user_scratch.md'), '---\ntype: user\n---\nscratch', 'utf8');

  // Unmatched-flagged dir: memory/-bearing, not enrolled, not a test artifact.
  const unmatchedDirName = 'C--Users-example-dev-some-other-project';
  fs.mkdirSync(path.join(rootDir, unmatchedDirName, 'memory'), { recursive: true });
  fs.writeFileSync(path.join(rootDir, unmatchedDirName, 'memory', 'user_other.md'), '---\ntype: user\n---\nother', 'utf8');

  // A sibling top-level dir with NO memory/ subdir at all — outside the
  // classification domain entirely, must never appear in any bucket.
  fs.mkdirSync(path.join(rootDir, 'C--Users-example-dev-no-memory-dir'), { recursive: true });

  return { enrolledDirName, enrolledDir, memoryDir, testArtifactDirName, unmatchedDirName };
}

// ─── ENROLLMENT CONFIG MATCHING THE FIXTURE TREE ───────────────────────────

function writeFixtureEnrollmentConfig(configPath, enrolledDirName) {
  fs.writeFileSync(configPath, JSON.stringify({
    enrolled_dirs: [{ dir_name: enrolledDirName, project_id: 'proj-alpha-test' }],
    test_artifact_patterns: [
      'AppData-Local-Temp-[A-Za-z0-9_-]*-eval-[A-Za-z0-9]+$',
    ],
  }, null, 2), 'utf8');
}

// ─── MAIN ───────────────────────────────────────────────────────────────────

async function main() {
  // ── Pure unit tests (no DB) ─────────────────────────────────────────────

  await run('T1a', 'classifyProjectDir: enrolled wins even if it also matches a test-artifact pattern', async () => {
    const config = { enrolledDirs: [{ dir_name: 'AppData-Local-Temp-eval-x', project_id: 'p1' }], testArtifactPatterns: [/eval-/] };
    const r = migrate09.classifyProjectDir('AppData-Local-Temp-eval-x', config);
    assert(r.bucket === 'enrolled' && r.projectId === 'p1', `expected enrolled/p1, got ${JSON.stringify(r)}`);
  });

  await run('T1b', 'classifyProjectDir: test-artifact-excluded when not enrolled', async () => {
    const config = { enrolledDirs: [], testArtifactPatterns: [/AppData-Local-Temp-.*-eval-/] };
    const r = migrate09.classifyProjectDir('C--Users-x-AppData-Local-Temp-claude-memory-eval-AbC123', config);
    assert(r.bucket === 'test-artifact-excluded', `expected test-artifact-excluded, got ${JSON.stringify(r)}`);
  });

  await run('T1c', 'classifyProjectDir: unmatched-flagged default branch', async () => {
    const config = { enrolledDirs: [], testArtifactPatterns: [] };
    const r = migrate09.classifyProjectDir('C--Users-example-dev-some-private-tool', config);
    assert(r.bucket === 'unmatched-flagged', `expected unmatched-flagged, got ${JSON.stringify(r)}`);
  });

  await run('T2a', 'resolveEntityType: frontmatter.type wins', async () => {
    const r = migrate09.resolveEntityType({ type: 'user' }, 'whatever_stem');
    assert(r.entityType === 'user' && r.method === 'frontmatter.type', JSON.stringify(r));
  });

  await run('T2b', 'resolveEntityType: frontmatter.metadata.type used when top-level type absent', async () => {
    const r = migrate09.resolveEntityType({ metadata: { type: 'project' } }, 'whatever_stem');
    assert(r.entityType === 'project' && r.method === 'frontmatter.metadata.type', JSON.stringify(r));
  });

  await run('T2c', 'resolveEntityType: filename-prefix fallback (feedback_)', async () => {
    const r = migrate09.resolveEntityType({}, 'feedback_something');
    assert(r.entityType === 'feedback' && r.method === 'filename-prefix-fallback', JSON.stringify(r));
  });

  await run('T2d', 'resolveEntityType: unmatched-type -> null, logged', async () => {
    const r = migrate09.resolveEntityType({}, 'no_recognized_prefix_here');
    assert(r.entityType === null && r.method === 'unmatched-type', JSON.stringify(r));
  });

  await run('T2e', 'I-3 regression: invalid enum value ("banana") on frontmatter.type NEVER falls through to filename-prefix inference', async () => {
    // stem starts with "feedback_" -- WOULD prefix-match if resolution
    // fell through, which it must not.
    const r = migrate09.resolveEntityType({ type: 'banana' }, 'feedback_something');
    assert(r.entityType === null, `entity_type must be NULL for an invalid enum value, got ${JSON.stringify(r)}`);
    assert(r.method === 'invalid-enum-value', `expected method 'invalid-enum-value', got ${JSON.stringify(r)}`);
    assert(r.invalidValue === 'banana' && r.invalidSource === 'frontmatter.type', JSON.stringify(r));
  });

  await run('T2f', 'I-3 regression: invalid enum value on frontmatter.metadata.type ALSO never falls through to filename-prefix inference', async () => {
    const r = migrate09.resolveEntityType({ metadata: { type: 'banana' } }, 'project_something');
    assert(r.entityType === null, `entity_type must be NULL for an invalid enum value, got ${JSON.stringify(r)}`);
    assert(r.method === 'invalid-enum-value', `expected method 'invalid-enum-value', got ${JSON.stringify(r)}`);
    assert(r.invalidValue === 'banana' && r.invalidSource === 'frontmatter.metadata.type', JSON.stringify(r));
  });

  await run('T2g', 'I-3 regression: an invalid frontmatter.type is terminal — never probes frontmatter.metadata.type either, even when metadata.type is itself valid', async () => {
    const r = migrate09.resolveEntityType({ type: 'banana', metadata: { type: 'user' } }, 'user_something');
    assert(r.entityType === null && r.method === 'invalid-enum-value' && r.invalidSource === 'frontmatter.type',
      `an invalid top-level type must not be rescued by a valid metadata.type, got ${JSON.stringify(r)}`);
  });

  await run('T2h', 'VALID_ENTITY_TYPES is the exact 4-value enum', async () => {
    const vals = [...migrate09.VALID_ENTITY_TYPES].sort();
    assert(JSON.stringify(vals) === JSON.stringify(['feedback', 'project', 'reference', 'user']), JSON.stringify(vals));
  });

  await run('T3', 'listTopicFiles: MEMORY.md excluded case-insensitively + .md.bak-<ts> excluded by extname boundary (I-9)', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mm09-listfiles-'));
    try {
      fs.writeFileSync(path.join(tmp, 'real_topic.md'), 'x', 'utf8');
      fs.writeFileSync(path.join(tmp, 'memory.md'), 'x', 'utf8'); // lowercase variant
      fs.writeFileSync(path.join(tmp, 'real_topic.md.bak-20260101'), 'x', 'utf8');
      const files = migrate09.listTopicFiles(tmp);
      assert(files.length === 1 && files[0] === 'real_topic.md', `expected exactly ['real_topic.md'], got ${JSON.stringify(files)}`);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  await run('T4a', 'extractWikiLinks: fenced-code bash [[ ]] conditional never matches (I-5)', async () => {
    const body = '```bash\nif [[ -f some-file ]]; then echo ok; fi\n```\n';
    const links = migrate09.extractWikiLinks(body);
    assert(links.length === 0, `expected 0 links, got ${JSON.stringify(links)}`);
  });

  await run('T4b', 'extractWikiLinks: inline-code [[not-a-link]] never matches', async () => {
    const body = 'text `[[not-a-link]]` more text';
    const links = migrate09.extractWikiLinks(body);
    assert(links.length === 0, `expected 0 links, got ${JSON.stringify(links)}`);
  });

  await run('T4c', 'extractWikiLinks: |alias and #anchor stripped before resolution (I-6)', async () => {
    const links = migrate09.extractWikiLinks('[[project_beta_topic#Section One|Beta]]');
    assert(links.length === 1, `expected 1 link, got ${JSON.stringify(links)}`);
    assert(links[0].target === 'project_beta_topic', `expected target project_beta_topic, got ${JSON.stringify(links[0])}`);
    assert(links[0].anchor === 'Section One' && links[0].alias === 'Beta', JSON.stringify(links[0]));
  });

  await run('T4d', 'extractWikiLinks: empty target is malformed', async () => {
    const links = migrate09.extractWikiLinks('[[]]');
    assert(links.length === 1 && links[0].malformed === true, JSON.stringify(links));
  });

  await run('T5', 'parseMemoryIndex: extracts stem -> description', async () => {
    const map = migrate09.parseMemoryIndex('- [Alpha](alpha_topic.md) — the alpha description\n');
    assert(map.get('alpha_topic') === 'the alpha description', JSON.stringify([...map]));
  });

  // ── Integration (filesystem, no DB) ─────────────────────────────────────

  let fixtureRoot;
  let fixture;
  await run('T6', 'parseProjectMemoryDir: end-to-end synthetic fixture (types, descriptions, wiki-links)', async () => {
    fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mm09-fixture-'));
    fixture = buildFixtureTree(fixtureRoot);
    const parsed = migrate09.parseProjectMemoryDir(fixture.memoryDir);

    assert(parsed.entities.length === 4, `expected 4 entities (bak sibling + MEMORY.md excluded), got ${parsed.entities.length}: ${JSON.stringify(parsed.entities)}`);

    const byName = new Map(parsed.entities.map((e) => [e.name, e]));
    assert(byName.get('user_alpha_topic').entityType === 'user', 'frontmatter.type case');
    assert(byName.get('project_beta_topic').entityType === 'project', 'frontmatter.metadata.type case');
    assert(byName.get('feedback_gamma_topic').entityType === 'feedback', 'filename-prefix fallback case');
    assert(byName.get('unrecognized_delta_topic').entityType === null, 'unmatched-type case must be null');

    assert(byName.get('user_alpha_topic').description === 'the alpha topic description', JSON.stringify(byName.get('user_alpha_topic')));
    assert(byName.get('unrecognized_delta_topic').description === null, 'no MEMORY.md entry -> null description');

    // Resolved edges: user_alpha_topic -> project_beta_topic (body link),
    // feedback_gamma_topic -> project_beta_topic (alias+anchor stripped).
    assert(parsed.edges.length === 2, `expected 2 resolved edges, got ${parsed.edges.length}: ${JSON.stringify(parsed.edges)}`);
    const edgeKeys = new Set(parsed.edges.map((e) => `${e.fromEntity}->${e.toEntity}`));
    assert(edgeKeys.has('user_alpha_topic->project_beta_topic'), JSON.stringify(parsed.edges));
    assert(edgeKeys.has('feedback_gamma_topic->project_beta_topic'), JSON.stringify(parsed.edges));

    const unresolved = parsed.events.filter((e) => e.kind === 'unresolved-link');
    assert(unresolved.some((e) => e.reason === 'malformed-empty-target'), JSON.stringify(unresolved));
    assert(unresolved.some((e) => e.reason === 'not-found' && e.target === 'does_not_exist_topic'), JSON.stringify(unresolved));

    const unmatchedTypeEvents = parsed.events.filter((e) => e.kind === 'unmatched-type');
    assert(unmatchedTypeEvents.length === 1 && unmatchedTypeEvents[0].stem === 'unrecognized_delta_topic', JSON.stringify(unmatchedTypeEvents));
  });

  await run('T6b', 'I-3 regression (parseProjectMemoryDir, isolated fixture): frontmatter.type="banana" -> unmatched-type/invalid-enum-value, NULL entity_type, never prefix-inferred', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mm09-invalid-enum-'));
    try {
      // Stem starts with "feedback_" -- WOULD prefix-match to "feedback"
      // if resolution incorrectly fell through past the invalid value.
      fs.writeFileSync(path.join(tmp, 'feedback_hostile_one.md'), [
        '---',
        'type: banana',
        '---',
        '',
        'Body text, no links.',
      ].join('\n'), 'utf8');
      const parsed = migrate09.parseProjectMemoryDir(tmp);

      assert(parsed.entities.length === 1, JSON.stringify(parsed.entities));
      assert(parsed.entities[0].entityType === null, `expected entity_type NULL, got ${JSON.stringify(parsed.entities[0])}`);

      const unmatchedTypeEvents = parsed.events.filter((e) => e.kind === 'unmatched-type');
      assert(unmatchedTypeEvents.length === 1, JSON.stringify(parsed.events));
      assert(unmatchedTypeEvents[0].reason === 'invalid-enum-value', JSON.stringify(unmatchedTypeEvents));
      assert(unmatchedTypeEvents[0].invalidValue === 'banana' && unmatchedTypeEvents[0].invalidSource === 'frontmatter.type', JSON.stringify(unmatchedTypeEvents));

      const prefixFallbackEvents = parsed.events.filter((e) => e.kind === 'filename-prefix-fallback');
      assert(prefixFallbackEvents.length === 0, `invalid enum value must NEVER fall through to filename-prefix inference, got ${JSON.stringify(prefixFallbackEvents)}`);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  // ── DB tests ─────────────────────────────────────────────────────────────

  const dbName = `mm09_test_${TS}_staging`;
  let enrollmentConfigPath;

  await run('T7', 'DB: refuses loud when entities/edges tables are missing, nothing applied', async () => {
    const bareDbName = `mm09_bare_${TS}_staging`;
    const sys = await pgConnect('postgres');
    try { await sys.query(`CREATE DATABASE "${bareDbName}"`); } finally { await sys.end(); }
    try {
      const cfgPath = path.join(fixtureRoot, 'enrollment-config-t7.json');
      writeFixtureEnrollmentConfig(cfgPath, fixture.enrolledDirName);
      const r = runMigrate09(['--db', bareDbName, '--projects-root', fixtureRoot, '--enrollment-config', cfgPath]);
      assert(r.status === 1, `expected exit 1, got ${r.status}; stdout=${r.stdout} stderr=${r.stderr}`);
      assert(/missing table/i.test(r.stderr), `expected a missing-table refusal, got stderr=${r.stderr}`);
    } finally {
      await dropDb(bareDbName);
    }
  });

  await run('T8-setup', 'DB: fixture schema setup (migrate-01 + migrate-schema-addenda for source_model/agent_id)', async () => {
    await setupTargetSchema(dbName);
    enrollmentConfigPath = path.join(fixtureRoot, 'enrollment-config.json');
    writeFixtureEnrollmentConfig(enrollmentConfigPath, fixture.enrolledDirName);
  });

  await run('T9', 'DB: happy-path migrate — entities/edges/manifest rows land, entity_type NULL for unmatched-type', async () => {
    const r = runMigrate09(['--db', dbName, '--projects-root', fixtureRoot, '--enrollment-config', enrollmentConfigPath]);
    assert(r.status === 0, `expected exit 0, got ${r.status}; stdout=${r.stdout}\nstderr=${r.stderr}`);
    assert(/MIGRATION_RESULT: PASS/.test(r.stdout), `expected MIGRATION_RESULT: PASS in stdout, got: ${r.stdout}`);
    assert(/TEST-ARTIFACT-EXCLUDED/.test(r.stdout), 'expected a TEST-ARTIFACT-EXCLUDED report line');
    assert(/UNMATCHED-FLAGGED/.test(r.stdout), 'expected an UNMATCHED-FLAGGED report line');

    const client = await pgConnect(dbName);
    try {
      const { rows: entRows } = await client.query(`SELECT name, entity_type, description, source_model FROM entities WHERE project_id = 'proj-alpha-test' ORDER BY name`);
      assert(entRows.length === 4, `expected 4 entities, got ${entRows.length}: ${JSON.stringify(entRows)}`);
      const delta = entRows.find((r2) => r2.name === 'unrecognized_delta_topic');
      assert(delta && delta.entity_type === null, `expected entity_type NULL for unmatched-type row, got ${JSON.stringify(delta)}`);
      assert(delta.source_model === 'markdown-migration-i', JSON.stringify(delta));

      const { rows: edgeRows } = await client.query(`SELECT from_entity, edge_type, to_entity FROM edges WHERE project_id = 'proj-alpha-test' ORDER BY from_entity`);
      assert(edgeRows.length === 2, `expected 2 edges, got ${edgeRows.length}: ${JSON.stringify(edgeRows)}`);

      const { rows: manRows } = await client.query(`SELECT source_table, row_count FROM migration_manifest WHERE project_id_or_null = 'proj-alpha-test' ORDER BY source_table`);
      assert(manRows.length === 2, `expected 2 manifest slices, got ${JSON.stringify(manRows)}`);
      const byTable = new Map(manRows.map((r2) => [r2.source_table, Number(r2.row_count)]));
      assert(byTable.get('file_memory_entities') === 4, JSON.stringify(manRows));
      assert(byTable.get('file_memory_edges') === 2, JSON.stringify(manRows));

      // Test-artifact-excluded / unmatched-flagged dirs must never have written anything.
      const { rows: scratchRows } = await client.query(`SELECT 1 FROM entities WHERE name IN ('user_scratch', 'user_other')`);
      assert(scratchRows.length === 0, 'test-artifact/unmatched dirs must never be enrolled');
    } finally {
      await client.end();
    }
  });

  await run('T9b', 'DB: manifest source_db keys are produced by fs-path-normalize.js\'s filesystemSourceDb() (H-14/I-14 — the ONE shared normalizer)', async () => {
    const { filesystemSourceDb } = require(path.join(PROJECT_ROOT, 'scripts', 'lib', 'fs-path-normalize.js'));
    const expectedSourceDb = filesystemSourceDb(fixture.memoryDir);
    // Sanity on the expectation itself: forward-slashed, drive letter
    // upper-cased, no backslashes -- proves this assertion is actually
    // exercising the normalization, not just echoing whatever the
    // migration happened to write.
    assert(expectedSourceDb.startsWith('filesystem:'), expectedSourceDb);
    assert(!expectedSourceDb.includes('\\'), `expected no backslashes, got ${expectedSourceDb}`);
    if (/^filesystem:[a-zA-Z]:/.test(expectedSourceDb)) {
      assert(/^filesystem:[A-Z]:/.test(expectedSourceDb), `expected an upper-cased drive letter, got ${expectedSourceDb}`);
    }

    const client = await pgConnect(dbName);
    try {
      const { rows } = await client.query(
        `SELECT DISTINCT source_db FROM migration_manifest WHERE project_id_or_null = 'proj-alpha-test' AND source_table IN ('file_memory_entities','file_memory_edges')`
      );
      assert(rows.length === 1, `expected exactly one distinct source_db across both slices, got ${JSON.stringify(rows)}`);
      assert(rows[0].source_db === expectedSourceDb, `manifest source_db must equal fs-path-normalize.js's filesystemSourceDb(memoryDir) exactly, got ${JSON.stringify(rows[0])} vs expected ${expectedSourceDb}`);
    } finally {
      await client.end();
    }
  });

  await run('T10', 'DB: idempotent re-run — no duplicate edges (I-10: existence-guarded insert scoped to this script\'s own tag, not a UNIQUE-index upsert)', async () => {
    const r1 = runMigrate09(['--db', dbName, '--projects-root', fixtureRoot, '--enrollment-config', enrollmentConfigPath]);
    assert(r1.status === 0, `re-run 1 expected exit 0, got ${r1.status}; stderr=${r1.stderr}`);
    const r2 = runMigrate09(['--db', dbName, '--projects-root', fixtureRoot, '--enrollment-config', enrollmentConfigPath]);
    assert(r2.status === 0, `re-run 2 expected exit 0, got ${r2.status}; stderr=${r2.stderr}`);

    const client = await pgConnect(dbName);
    try {
      const { rows: edgeRows } = await client.query(`SELECT from_entity, to_entity, COUNT(*) AS n FROM edges WHERE project_id = 'proj-alpha-test' GROUP BY from_entity, to_entity HAVING COUNT(*) > 1`);
      assert(edgeRows.length === 0, `expected no duplicate edges after re-run, got ${JSON.stringify(edgeRows)}`);
      const { rows: entRows } = await client.query(`SELECT COUNT(*) AS n FROM entities WHERE project_id = 'proj-alpha-test'`);
      assert(Number(entRows[0].n) === 4, `expected entity count to stay at 4 after re-run, got ${entRows[0].n}`);
    } finally {
      await client.end();
    }
  });

  await run('T10b', 'I-10 regression: target pre-seeded with 3 identical-tuple edges from ANOTHER writer (source_model NULL) — this run adds its own row, never blocked by them; a re-run adds nothing further; their 3 rows are untouched', async () => {
    const cfgPath = path.join(fixtureRoot, 'enrollment-config-i10.json');
    writeFixtureEnrollmentConfig(cfgPath, fixture.enrolledDirName);
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    cfg.enrolled_dirs[0].project_id = 'proj-i10-test';
    fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2), 'utf8');

    // Pre-seed 3 identical-tuple edges under ANOTHER writer's tag, on the
    // SAME (from_entity, edge_type, to_entity) migrate-09 will itself
    // derive from this fixture (user_alpha_topic -[references]->
    // project_beta_topic, per T6's own fixture-tree wiki-link assertions).
    const client0 = await pgConnect(dbName);
    try {
      for (let i = 0; i < 3; i++) {
        await client0.query(
          `INSERT INTO edges (project_id, from_entity, edge_type, to_entity, source_model)
           VALUES ('proj-i10-test', 'user_alpha_topic', 'references', 'project_beta_topic', NULL)`
        );
      }
    } finally {
      await client0.end();
    }

    const r1 = runMigrate09(['--db', dbName, '--projects-root', fixtureRoot, '--enrollment-config', cfgPath]);
    assert(r1.status === 0, `expected exit 0 (never blocked by another writer's pre-existing duplicates), got ${r1.status}; stdout=${r1.stdout}\nstderr=${r1.stderr}`);
    assert(/MIGRATION_RESULT: PASS/.test(r1.stdout), `expected MIGRATION_RESULT: PASS, got: ${r1.stdout}`);

    const r2 = runMigrate09(['--db', dbName, '--projects-root', fixtureRoot, '--enrollment-config', cfgPath]);
    assert(r2.status === 0, `re-run expected exit 0, got ${r2.status}; stderr=${r2.stderr}`);

    const client = await pgConnect(dbName);
    try {
      const { rows: taggedRows } = await client.query(
        `SELECT source_model FROM edges WHERE project_id='proj-i10-test' AND from_entity='user_alpha_topic' AND edge_type='references' AND to_entity='project_beta_topic' AND source_model='markdown-migration-i'`
      );
      assert(taggedRows.length === 1, `expected exactly 1 row tagged this script's own source_model after run + re-run, got ${taggedRows.length}`);

      const { rows: otherRows } = await client.query(
        `SELECT source_model FROM edges WHERE project_id='proj-i10-test' AND from_entity='user_alpha_topic' AND edge_type='references' AND to_entity='project_beta_topic' AND source_model IS NULL`
      );
      assert(otherRows.length === 3, `expected the other writer's 3 pre-seeded rows untouched, got ${otherRows.length}`);

      const { rows: totalRows } = await client.query(
        `SELECT COUNT(*) AS n FROM edges WHERE project_id='proj-i10-test' AND from_entity='user_alpha_topic' AND edge_type='references' AND to_entity='project_beta_topic'`
      );
      assert(Number(totalRows[0].n) === 4, `expected 4 total rows for this tuple (3 other-writer + 1 ours), got ${totalRows[0].n}`);

      // The second, non-pre-seeded edge this fixture also derives
      // (feedback_gamma_topic -> project_beta_topic) must land normally,
      // proving the guard's scoping doesn't suppress unrelated writes.
      const { rows: secondEdge } = await client.query(
        `SELECT 1 FROM edges WHERE project_id='proj-i10-test' AND from_entity='feedback_gamma_topic' AND edge_type='references' AND to_entity='project_beta_topic' AND source_model='markdown-migration-i'`
      );
      assert(secondEdge.length === 1, `expected the second, non-pre-seeded edge to land normally, got ${JSON.stringify(secondEdge)}`);
    } finally {
      await client.end();
    }
  });

  await run('T10c', 'I-10 regression: plain edges_project_from_type_to_idx applies cleanly over pre-existing duplicated data where the old UNIQUE index would fail to even create', async () => {
    const dupDbName = `mm09_i10_dup_${TS}_staging`;
    const sys = await pgConnect('postgres');
    try { await sys.query(`CREATE DATABASE "${dupDbName}"`); } finally { await sys.end(); }
    try {
      await setupTargetSchema(dupDbName); // migrate-01 + migrate-schema-addenda -- NOT migrate-09's own schema step yet

      const client0 = await pgConnect(dupDbName);
      try {
        // Simulate staging's real finding: 2+ identical 4-tuples already
        // present in `edges`, faithfully migrated from a source graph that
        // predates any uniqueness constraint on this tuple.
        for (let i = 0; i < 2; i++) {
          await client0.query(
            `INSERT INTO edges (project_id, from_entity, edge_type, to_entity, source_model)
             VALUES ('proj-dup-test', 'entity_a', 'references', 'entity_b', NULL)`
          );
        }

        // Ground the regression: prove a UNIQUE index over this exact
        // duplicated data genuinely fails (this is not a hypothetical --
        // it is the mechanism the field finding actually hit).
        let uniqueIndexThrew = false;
        try {
          await client0.query(
            `CREATE UNIQUE INDEX test_i10_would_fail_unique ON edges (project_id, from_entity, edge_type, to_entity)`
          );
          await client0.query(`DROP INDEX test_i10_would_fail_unique`); // cleanup if it somehow succeeded
        } catch (err) {
          uniqueIndexThrew = true;
          assert(/duplicate key|could not create unique index/i.test(err.message), `expected a duplicate-key failure, got: ${err.message}`);
        }
        assert(uniqueIndexThrew, 'expected CREATE UNIQUE INDEX over pre-existing duplicate tuples to fail -- if it did not, the regression this fix addresses is not actually reproduced by this fixture');
      } finally {
        await client0.end();
      }

      // Now run migrate-09 itself (zero enrolled dirs -- this test is only
      // about the SCHEMA STEP succeeding against the duplicated table, not
      // file processing) and confirm the plain index applies cleanly.
      const emptyCfgPath = path.join(fixtureRoot, 'enrollment-config-empty.json');
      fs.writeFileSync(emptyCfgPath, JSON.stringify({ enrolled_dirs: [], test_artifact_patterns: [] }, null, 2), 'utf8');
      const emptyProjectsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mm09-empty-root-'));
      try {
        const r = runMigrate09(['--db', dupDbName, '--projects-root', emptyProjectsRoot, '--enrollment-config', emptyCfgPath]);
        assert(r.status === 0, `expected exit 0 (schema step must succeed despite pre-existing duplicates), got ${r.status}; stdout=${r.stdout}\nstderr=${r.stderr}`);
        assert(/MIGRATION_RESULT: PASS/.test(r.stdout), `expected MIGRATION_RESULT: PASS, got: ${r.stdout}`);
      } finally {
        fs.rmSync(emptyProjectsRoot, { recursive: true, force: true });
      }

      const client = await pgConnect(dupDbName);
      try {
        const { rows: idxRows } = await client.query(
          `SELECT indexname, indexdef FROM pg_indexes WHERE tablename='edges' AND indexname='edges_project_from_type_to_idx'`
        );
        assert(idxRows.length === 1, `expected edges_project_from_type_to_idx to exist, got ${JSON.stringify(idxRows)}`);
        assert(!/UNIQUE/i.test(idxRows[0].indexdef), `expected a NON-unique index, got: ${idxRows[0].indexdef}`);

        const { rows: oldIdxRows } = await client.query(
          `SELECT 1 FROM pg_indexes WHERE tablename='edges' AND indexname='edges_project_from_type_to_unique'`
        );
        assert(oldIdxRows.length === 0, 'expected the old UNIQUE index name to be absent (never created on this target, and DROP INDEX IF EXISTS is a no-op)');

        const { rows: dupRows } = await client.query(
          `SELECT COUNT(*) AS n FROM edges WHERE project_id='proj-dup-test' AND from_entity='entity_a' AND edge_type='references' AND to_entity='entity_b'`
        );
        assert(Number(dupRows[0].n) === 2, `expected the 2 pre-existing duplicate rows to survive untouched, got ${dupRows[0].n}`);
      } finally {
        await client.end();
      }
    } finally {
      await dropDb(dupDbName);
    }
  });

  await run('T10d', 'I-10 upgrade path: a target where the OLD UNIQUE index previously succeeded (dupe-free) has it DROPPED and REPLACED with the plain index — deterministic convergence', async () => {
    const upgDbName = `mm09_i10_upg_${TS}_staging`;
    const sys = await pgConnect('postgres');
    try { await sys.query(`CREATE DATABASE "${upgDbName}"`); } finally { await sys.end(); }
    try {
      await setupTargetSchema(upgDbName);

      const client0 = await pgConnect(upgDbName);
      try {
        // Simulate a target where the ORIGINAL I-10 SQL ran successfully
        // (a dupe-free table, e.g. a fresh dev/CI database) before this
        // fix existed.
        await client0.query(
          `CREATE UNIQUE INDEX edges_project_from_type_to_unique ON edges (project_id, from_entity, edge_type, to_entity)`
        );
      } finally {
        await client0.end();
      }

      const emptyCfgPath = path.join(fixtureRoot, 'enrollment-config-empty-upg.json');
      fs.writeFileSync(emptyCfgPath, JSON.stringify({ enrolled_dirs: [], test_artifact_patterns: [] }, null, 2), 'utf8');
      const emptyProjectsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mm09-empty-root-upg-'));
      try {
        const r = runMigrate09(['--db', upgDbName, '--projects-root', emptyProjectsRoot, '--enrollment-config', emptyCfgPath]);
        assert(r.status === 0, `expected exit 0, got ${r.status}; stdout=${r.stdout}\nstderr=${r.stderr}`);
      } finally {
        fs.rmSync(emptyProjectsRoot, { recursive: true, force: true });
      }

      const client = await pgConnect(upgDbName);
      try {
        const { rows: oldIdx } = await client.query(
          `SELECT 1 FROM pg_indexes WHERE tablename='edges' AND indexname='edges_project_from_type_to_unique'`
        );
        assert(oldIdx.length === 0, 'expected the old UNIQUE index to have been DROPPED');

        const { rows: newIdx } = await client.query(
          `SELECT indexdef FROM pg_indexes WHERE tablename='edges' AND indexname='edges_project_from_type_to_idx'`
        );
        assert(newIdx.length === 1, 'expected the new plain index to exist after the upgrade');
        assert(!/UNIQUE/i.test(newIdx[0].indexdef), `expected the replacement index to be non-unique, got: ${newIdx[0].indexdef}`);
      } finally {
        await client.end();
      }
    } finally {
      await dropDb(upgDbName);
    }
  });

  await run('T11', 'DB: I-12 precedence — a pre-existing row from a different source_model keeps its description untouched', async () => {
    const client = await pgConnect(dbName);
    try {
      await client.query(
        `INSERT INTO entities (project_id, name, entity_type, description, source_model)
         VALUES ('proj-precedence-test', 'user_alpha_topic', NULL, 'hand-authored description, must survive', 'handoff-close-live')`
      );
    } finally {
      await client.end();
    }

    const cfgPath = path.join(fixtureRoot, 'enrollment-config-precedence.json');
    writeFixtureEnrollmentConfig(cfgPath, fixture.enrolledDirName);
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    cfg.enrolled_dirs[0].project_id = 'proj-precedence-test';
    fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2), 'utf8');

    const r = runMigrate09(['--db', dbName, '--projects-root', fixtureRoot, '--enrollment-config', cfgPath]);
    assert(r.status === 0, `expected exit 0, got ${r.status}; stderr=${r.stderr}`);

    const client2 = await pgConnect(dbName);
    try {
      const { rows } = await client2.query(`SELECT entity_type, description, source_model FROM entities WHERE project_id='proj-precedence-test' AND name='user_alpha_topic'`);
      assert(rows.length === 1, JSON.stringify(rows));
      assert(rows[0].description === 'hand-authored description, must survive', `description must never be overwritten in additive-only mode, got ${JSON.stringify(rows[0])}`);
      assert(rows[0].source_model === 'handoff-close-live', `source_model must not be reassigned in additive-only mode, got ${JSON.stringify(rows[0])}`);
      assert(rows[0].entity_type === 'user', `entity_type should be additively filled (was NULL), got ${JSON.stringify(rows[0])}`);
    } finally {
      await client2.end();
    }
  });

  await run('T12', 'DB: I-13 rollback — reference-count-gated entity cleanup', async () => {
    const client = await pgConnect(dbName);
    try {
      // A live, non-migration writer's edge referencing project_beta_topic —
      // this must survive project_beta_topic across the rollback even though
      // this migration's own edges to it are deleted.
      await client.query(
        `INSERT INTO edges (project_id, from_entity, edge_type, to_entity, source_model)
         VALUES ('proj-alpha-test', 'some_other_entity', 'depends_on', 'project_beta_topic', 'handoff-close-live')`
      );
    } finally {
      await client.end();
    }

    const r = runMigrate09(['--db', dbName, '--projects-root', fixtureRoot, '--enrollment-config', enrollmentConfigPath, '--rollback']);
    assert(r.status === 0, `expected exit 0, got ${r.status}; stdout=${r.stdout} stderr=${r.stderr}`);
    assert(/ROLLBACK_RESULT: PASS/.test(r.stdout), `expected ROLLBACK_RESULT: PASS, got ${r.stdout}`);

    const client2 = await pgConnect(dbName);
    try {
      const { rows: migrationEdges } = await client2.query(`SELECT 1 FROM edges WHERE project_id='proj-alpha-test' AND source_model='markdown-migration-i'`);
      assert(migrationEdges.length === 0, 'all this migration\'s own edges must be deleted by rollback');

      const { rows: survivorEdge } = await client2.query(`SELECT 1 FROM edges WHERE project_id='proj-alpha-test' AND from_entity='some_other_entity' AND to_entity='project_beta_topic'`);
      assert(survivorEdge.length === 1, 'the unrelated live-writer edge must survive rollback untouched');

      const { rows: betaEntity } = await client2.query(`SELECT 1 FROM entities WHERE project_id='proj-alpha-test' AND name='project_beta_topic'`);
      assert(betaEntity.length === 1, 'project_beta_topic must be PRESERVED (still referenced by a surviving edge) — reference-count gate');

      const { rows: deltaEntity } = await client2.query(`SELECT 1 FROM entities WHERE project_id='proj-alpha-test' AND name='unrecognized_delta_topic'`);
      assert(deltaEntity.length === 0, 'unrecognized_delta_topic has zero referencing edges and must be DELETED by rollback');

      const { rows: manRows } = await client2.query(`SELECT 1 FROM migration_manifest WHERE project_id_or_null='proj-alpha-test' AND source_table IN ('file_memory_entities','file_memory_edges')`);
      assert(manRows.length === 0, 'manifest slices for this project must be cleared by rollback');
    } finally {
      await client2.end();
    }
  });

  // ── Cleanup ──────────────────────────────────────────────────────────────
  await dropDb(dbName);
  if (fixtureRoot) fs.rmSync(fixtureRoot, { recursive: true, force: true });

  console.log(`\n${passed} passed, ${failed} failed.`);
  process.exitCode = failed > 0 ? 1 : 0;
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exitCode = 1;
});
