'use strict';

/**
 * verify-20-mcp-surface.js — §8 generalized MCP tool surface operator smoke
 * test (CONSOLIDATION-RUNBOOK.md §8, M-1..M-19, memory-manager#18).
 *
 * Exercises the LIBRARY functions that back every new §8 tool directly
 * against a live target — the SAME "exercise the lib, not the stdio
 * transport" convention verify-13/17/18/19 already use. A separate,
 * lightweight stdio round-trip (runMcpRegistrationCheck, invoked from
 * main()) proves handoff-mcp.mjs actually REGISTERS all 35 tools (5
 * pre-existing + 25 new + handoff_resume, added later on the same
 * child-process transport as the 5 pre-existing tools, + 4 more from the
 * §17 B1 routing write surface — model_registry_set,
 * routing_session_override_set/_get/_clear, 2026-09-06) and that at least
 * one new direct-pg tool is
 * independently callable end-to-end through the real MCP protocol via
 * mcp-db-connect.js + ensureProjectIdentity (M-19) against a disposable
 * scratch project root — never the real claude-memory dogfood project.
 *
 * Scratch project_ids are ALWAYS prefixed `smoke-mm18-` (per this PR's own
 * task description) — distinct from smoke-harness.js's default
 * `smoke<label>-` convention, so this run's rows are never mistaken for a
 * concurrent migrate-02 author's own scratch fixtures.
 *
 * Two connections, same split rationale as verify-19-seams-smoke.js: most
 * checks run inside ONE transaction that is ALWAYS rolled back (checks that
 * use a single client.query call, or nested BEGIN via harness.withSavepoint
 * for negative-perturbation checks); appendExchange/assertionUpdate/
 * routingProfileSet each own their OWN BEGIN/COMMIT/ROLLBACK — incompatible
 * with the outer rolled-back transaction on the same connection — so those
 * run on a SEPARATE dedicated connection with explicit manual cleanup.
 *
 * Prerequisite: migrate-15-mcp-addenda.js AND a re-applied migrate-13-
 * agent-exchange.js (to wire entities_audit) must already PASS against the
 * target.
 *
 * Usage: node scripts/migrations/verify-20-mcp-surface.js [--db <target>]
 * Exit codes: 0 = all checks PASS, 1 = any FAIL / refused target / missing
 * prerequisite, 2 = bad CLI usage.
 */

const path = require('path');
const os = require('os');
const fs = require('fs');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { Client } = require('pg');

const migrateOne = require('./migrate-01-canonical-db');
const harness = require('./lib/smoke-harness');

const memoryUpsert = require('../lib/memory-upsert.js');
const memorySearchLib = require('../lib/memory-search.js');
const entityCrud = require('../lib/entity-graph-crud.js');
// cm#231: assertionCreate/assertionUpdate now route through
// writeAssertionWithSupersession (handoff.js), which requires the
// StoragePort adapter shape (buildSupersessionUpdate/buildBumpAssertions) —
// a bare `pg.Client` (what this script's own `client`/`client2` are) does
// NOT have those methods. PostgresAdapter is a transparent wrapper around an
// already-connected pg.Client (.query() forwards unchanged) — used ONLY at
// the two entityCrud.assertionCreate/assertionUpdate call sites below, never
// altering how the rest of this script talks to `client`/`client2` directly.
const { PostgresAdapter } = require('../lib/db-seam.js');
const { canonicalize } = require('../lib/subject-canon.js');
const memoryView = require('../lib/memory-view.js');
const exchangeLog = require('../lib/exchange-log.js');
const routingProfile = require('../lib/routing-profile.js');
const routeResolve = require('../lib/route-resolve.js');
const usageTelemetry = require('../lib/usage-telemetry.js');
const normalizeText = require('../lib/normalize-text.js');
const writeTimeEmbed = require('../lib/write-time-embed.js');
const { PROJECT_ID_TABLES } = require('../lib/project-identity.js');

const LABEL = '20';
const PROJECT_ROOT = path.resolve(__dirname, '..', '..');

const PREREQUISITE_TABLES = [
  'entities', 'assertions', 'edges', 'agent_exchange', 'embedding_providers',
  'decisions', 'gotchas', 'findings', 'routing_profiles', 'turn_usage',
  'session_usage', 'model_registry', 'retrieval_contract',
];

class UsageError extends Error {}

function parseArgs(argv) {
  const parsed = { db: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--db') parsed.db = argv[++i];
    else if (a.startsWith('--db=')) parsed.db = a.slice('--db='.length);
    else throw new UsageError(`Unknown argument: ${a}`);
  }
  return parsed;
}

async function checkPrerequisites(client) {
  const { rows } = await client.query(
    `SELECT table_name FROM information_schema.tables
      WHERE table_schema = current_schema() AND table_type = 'BASE TABLE'`
  );
  const actual = new Set(rows.map((r) => r.table_name.toLowerCase()));
  const missing = PREREQUISITE_TABLES.filter((t) => !actual.has(t));
  if (missing.length === 0) {
    const { rows: colRows } = await client.query(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = 'retrieval_contract' AND column_name = 'kind'`
    );
    if (colRows.length === 0) missing.push('retrieval_contract.kind (run migrate-15-mcp-addenda.js)');
    const { rows: suppRows } = await client.query(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = 'entities' AND column_name = 'suppressed'`
    );
    if (suppRows.length === 0) missing.push('entities.suppressed (run migrate-15-mcp-addenda.js)');
  }
  return missing;
}

function assert(cond, msg) { if (!cond) throw new Error(msg); }
function assertEq(actual, expected, msg) {
  if (actual !== expected) throw new Error(`${msg} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
}

// EMBED_SKIP=1 (the SAME env var every other embedding-touching CI step in
// .github/workflows/test.yml already sets — vLLM is not available in CI):
// every write-time-embed.js / memory-search.js call in this script is
// injected with a deterministic mock embedder instead of hitting live
// vLLM, mirroring verify-19-seams-smoke.js's own mockEmbedder() precedent
// for exchange-log.js. Unset (the default for a local operator run) uses
// the real default-provider path end-to-end — this is how this PR's
// author actually validated the hybrid-search/embed-at-write checks below
// against live vLLM (Qwen3-Embedding-8B) before authoring this fallback.
function mockEmbedder() {
  return async () => new Array(4000).fill(0).map((_, i) => (i === 0 ? 0.1 : 0));
}
const EMBEDDER = process.env.EMBED_SKIP === '1' ? mockEmbedder() : undefined;

/**
 * cm#201 S-A.3: embedForWrite's injected `opts.embedder` seam now REQUIRES
 * `opts.embedderProviderId` alongside it (both-or-neither). Resolves a real
 * embedding_providers.id when EMBEDDER is the mock (EMBED_SKIP=1); returns
 * undefined when EMBEDDER is undefined (the real default-provider path,
 * which resolves its own providerId internally and never consults this
 * value at all — see embedForWrite's `if (opts && opts.embedder)` gate).
 */
async function resolveMockEmbedderProviderId(client) {
  if (!EMBEDDER) return undefined;
  const { rows } = await client.query(`SELECT id FROM embedding_providers WHERE is_default = true LIMIT 1`);
  return rows.length > 0 ? rows[0].id : null;
}

async function runChecks(client, prefix) {
  let allOk = true;
  const results = [];
  async function check(id, name, fn) {
    const ok = await harness.runCheck(client, LABEL, id, name, fn);
    results.push({ id, name, ok });
    if (!ok) allOk = false;
  }
  const embedderProviderId = await resolveMockEmbedderProviderId(client);

  const projectA = `${prefix}-proj-a`;

  // ── M-11: normalizeForCompare NFC/NFD pair ──────────────────────────────
  await check(1, 'normalize-text: NFC/NFD visually-identical pair compares equal (M-11)', async () => {
    const nfc = 'café'; // precomposed é
    const nfd = 'café'; // e + combining acute
    assertEq(normalizeText.normalizeForCompare(nfc), normalizeText.normalizeForCompare(nfd), 'NFC/NFD forms normalize identically');
    assert(!normalizeText.materiallyDifferent(nfc, nfd), 'NFC/NFD forms are not materially different');
  });

  // ── M-7: PROJECT_ID_TABLES coverage ─────────────────────────────────────
  await check(2, 'project-identity: PROJECT_ID_TABLES includes all §8 M-7 tables', async () => {
    const required = [
      'decisions', 'gotchas', 'findings', 'research', 'incidents', 'code_index',
      'tasks', 'checklist_items', 'corpus_files', 'workflow_discovery',
      'agent_rewrites', 'policy_sections', 'session_chunks', 'agent_exchange',
      'routing_profiles', 'turn_usage', 'session_usage',
    ];
    const missing = required.filter((t) => !PROJECT_ID_TABLES.includes(t));
    assert(missing.length === 0, `missing from PROJECT_ID_TABLES: ${missing.join(', ')}`);
  });

  // ── memory_upsert: decisions ON CONFLICT carve-out (M-1) + inline embed (M-2) ──
  await check(3, 'memory-upsert: upsertDecisionRow inserts then updates via ON CONFLICT (M-1)', async () => {
    const embed = await writeTimeEmbed.embedForWrite(client, 'smoke decision text for embed', { embedder: EMBEDDER, embedderProviderId });
    assert(embed.vectorLiteral !== null, 'expected a real embedding (vLLM up)');
    const ins = await memoryUpsert.upsertDecisionRow(client, {
      project_id: projectA, topic: 'smoke-topic', decision: 'first', reason: 'r1',
    }, { embeddingVectorLiteral: embed.vectorLiteral, embeddedByProviderId: embed.providerId });
    assertEq(ins.inserted, true, 'first write is an insert');
    const upd = await memoryUpsert.upsertDecisionRow(client, {
      project_id: projectA, topic: 'smoke-topic', decision: 'second', reason: 'r2',
    });
    assertEq(upd.inserted, false, 'second write on same (project_id, topic) is an update');
    assertEq(upd.decision, 'second', 'update applied');
  });

  await check(4, 'write-time-embed: fail-soft NULL + warning when no default provider (M-2)', async () => {
    await harness.withSavepoint(client, `sp_${prefix.replace(/-/g, '_')}_no_provider`, async () => {
      await client.query(`UPDATE embedding_providers SET is_default = false WHERE is_default = true`);
      const result = await writeTimeEmbed.embedForWrite(client, 'text with no provider available');
      assertEq(result.vectorLiteral, null, 'embedding fails soft to NULL');
      assert(typeof result.warning === 'string' && result.warning.length > 0, 'a warning is returned');
      throw new Error('__rollback_savepoint__');
    }).catch((err) => { if (err.message !== '__rollback_savepoint__') throw err; });
  });

  await check(5, 'memory-upsert: writeMemoryRow accepts an embeddingVectorLiteral opt (M-2)', async () => {
    const embed = await writeTimeEmbed.embedForWrite(client, 'gotcha issue and rule text', { embedder: EMBEDDER, embedderProviderId });
    const row = await memoryUpsert.writeMemoryRow(client, 'gotchas', {
      project_id: projectA, issue: 'smoke issue', rule: 'smoke rule',
    }, { embeddingVectorLiteral: embed.vectorLiteral, embeddedByProviderId: embed.providerId });
    assert(row.embedding !== null, 'embedding column populated');
  });

  // ── memory_get ───────────────────────────────────────────────────────
  // NOTE (harness.runCheck): every check runs inside its OWN savepoint,
  // ALWAYS rolled back regardless of pass/fail — checks never see another
  // check's writes. Each check that needs a fixture row writes its own.
  await check(6, 'memory-upsert: memoryGet looks up by natural key', async () => {
    await memoryUpsert.writeMemoryRow(client, 'decisions', { project_id: projectA, topic: 'get-topic', decision: 'get-me', reason: 'r' });
    const rows = await memoryUpsert.memoryGet(client, 'decisions', projectA, { topic: 'get-topic' });
    assertEq(rows.length, 1, 'one row found');
    assertEq(rows[0].decision, 'get-me', 'correct row returned');
  });

  await check(7, 'memory-upsert: memoryGet unknown lookup column is a hard error', async () => {
    try {
      await memoryUpsert.memoryGet(client, 'decisions', projectA, { not_a_real_column: 'x' });
      throw new Error('expected unknownKey error');
    } catch (err) {
      assertEq(err.code, 'unknownKey', 'error code');
    }
  });

  // ── memory_search (M-14) ────────────────────────────────────────────
  await check(8, 'memory-search: unknown table is a hard tool error (M-14)', async () => {
    try {
      await memorySearchLib.memorySearch(client, { projectId: projectA, query: 'x', tables: ['not_a_real_table'] });
      throw new Error('expected unknownTable error');
    } catch (err) {
      assertEq(err.code, 'unknownTable', 'error code');
    }
  });

  await check(9, 'memory-search: hybrid hit across a table WITH fts_vec (decisions) and one WITHOUT (assertions)', async () => {
    const searchText = 'unicorn zephyr quantum decision text for search fixture';
    const embed = await writeTimeEmbed.embedForWrite(client, searchText, { embedder: EMBEDDER, embedderProviderId });
    await memoryUpsert.writeMemoryRow(
      client, 'decisions',
      { project_id: projectA, topic: 'search-fixture', decision: searchText, reason: 'r' },
      { embeddingVectorLiteral: embed.vectorLiteral, embeddedByProviderId: embed.providerId }
    );
    await client.query(
      `INSERT INTO assertions (project_id, subject, predicate, object, confidence, source, embedding)
       VALUES ($1, $2, 'uses', $3, 8, 'user_stated', $4::halfvec)`,
      [projectA, `${prefix}-search-subj`, searchText, embed.vectorLiteral]
    );
    const result = await memorySearchLib.memorySearch(client, {
      projectId: projectA, query: searchText, tables: ['decisions', 'assertions'], limit: 10, embedder: EMBEDDER,
    });
    const tables = new Set(result.hits.map((h) => h.sourceTable));
    assert(tables.has('decisions'), 'decisions table represented in hits');
    assert(tables.has('assertions'), 'assertions table (no fts_vec, structurally-zero FTS term) represented in hits');
    assert(result.hits.every((h) => Number.isFinite(h.score)), 'every hit has a finite numeric score');
  });

  await check(10, 'memory-search: memory_entry_chunks is NOT in the closed table enum (dimension-mismatch exclusion)', async () => {
    assert(!memorySearchLib.ALLOWED_TABLES.includes('memory_entry_chunks'), 'memory_entry_chunks deliberately excluded (vector(1024) vs halfvec(4000))');
  });

  // ── entity CRUD + near-match + revival (M-4/M-12/M-13) ──────────────
  await check(11, 'entity-graph-crud: entityCreate surfaces exact + fuzzy near-matches, never auto-merges', async () => {
    const e1 = await entityCrud.entityCreate(client, { projectId: projectA, name: `${prefix}-Widget`, entityType: 'component' });
    const e2 = await entityCrud.entityCreate(client, { projectId: projectA, name: `${prefix}-widget`, entityType: 'component' }); // exact-normalized dup
    assert(e2.warnings.exact.length === 1, 'exact near-match surfaced');
    assert(e2.row.id !== e1.row.id, 'a live exact-normalized dup is NOT auto-merged — a second row is written');
  });

  await check(12, 'entity-graph-crud: entityCreate on a short (<4 char) name gets exact-only matching (fuzzy skipped)', async () => {
    const e1 = await entityCrud.entityCreate(client, { projectId: projectA, name: 'abc', entityType: 'tag' });
    const near = await entityCrud.findNearMatchEntities(client, projectA, 'abd'); // 1-char-off fuzzy neighbor
    assert(near.fuzzy.length === 0, 'fuzzy matching skipped for <4-char normalized candidates');
    assert(e1.row.name === 'abc');
  });

  await check(13, 'entity-graph-crud: entityCreate revives a suppressed exact match instead of a second insert (M-4)', async () => {
    const e1 = await entityCrud.entityCreate(client, { projectId: projectA, name: `${prefix}-Revivable`, entityType: 'component', description: 'v1' });
    await entityCrud.entitySuppress(client, { projectId: projectA, id: e1.row.id });
    const e2 = await entityCrud.entityCreate(client, { projectId: projectA, name: `${prefix}-Revivable`, entityType: 'component', description: 'v2' });
    assertEq(e2.revived, true, 'revival flagged');
    assertEq(e2.row.id, e1.row.id, 'same row id — never a second insert');
    assertEq(e2.row.suppressed, false, 'un-suppressed');
    assertEq(e2.row.description, 'v2', 'description updated');
  });

  // ── assertion CRUD ──────────────────────────────────────────────────
  // cm#231: assertionCreate's check moved to runSelfTransactioningChecks
  // (below, on its own connection) — assertionCreate now routes through
  // writeAssertionWithSupersession, which owns its own BEGIN/COMMIT
  // (mirroring assertionUpdate's own pre-existing reason for living there:
  // a COMMIT issued from inside this function's outer rolled-back
  // transaction would commit the ENTIRE outer transaction, not just this
  // check, poisoning every check that runs after it in this group).

  await check(15, 'entity-graph-crud: resolveAssertionUpdateTargetId infers a 1:1 predicate target from (subject, predicate)', async () => {
    await client.query(
      `INSERT INTO assertions (project_id, subject, predicate, object, confidence, source)
       VALUES ($1, $2, 'now_uses', 'Postgres', 8, 'user_stated')`,
      [projectA, `${prefix}-1to1-subj`]
    );
    const targetId = await entityCrud.resolveAssertionUpdateTargetId(client, { projectId: projectA, subject: `${prefix}-1to1-subj`, predicate: 'now_uses' });
    assert(Number.isInteger(targetId), 'a numeric target id was inferred');
  });

  await check(16, 'entity-graph-crud: assertionUpdate on a 1:N predicate with no explicit id is a hard error (M-6)', async () => {
    await client.query(
      `INSERT INTO assertions (project_id, subject, predicate, object, confidence, source)
       VALUES ($1, $2, 'applies', 'scope-a', 8, 'user_stated')`,
      [projectA, `${prefix}-1toN-subj`]
    );
    try {
      await entityCrud.assertionUpdate(client, { projectId: projectA, subject: `${prefix}-1toN-subj`, predicate: 'applies', newObject: 'scope-b' });
      throw new Error('expected targetRequired error');
    } catch (err) {
      assertEq(err.code, 'targetRequired', 'error code (M-6: never guess)');
    }
  });

  // ── edge CRUD ────────────────────────────────────────────────────────
  await check(17, 'entity-graph-crud: edge create/read/update/suppress round-trip', async () => {
    const e1 = await entityCrud.edgeCreate(client, { projectId: projectA, fromEntity: `${prefix}-A`, edgeType: 'uses', toEntity: `${prefix}-B` });
    const upd = await entityCrud.edgeUpdate(client, { projectId: projectA, id: e1.id, weight: 5 });
    assertEq(Number(upd.weight), 5, 'weight updated in place');
    await entityCrud.edgeSuppress(client, { projectId: projectA, id: e1.id });
    const reads = await entityCrud.edgeRead(client, { projectId: projectA, id: e1.id });
    assertEq(reads.length, 0, 'suppressed edge excluded from edgeRead');
  });

  // ── memory_view_set/run (M-15/M-16) ──────────────────────────────────
  await check(18, 'memory-view: memoryViewSet + memoryViewRun round-trip (entity/assertion/recency/vector)', async () => {
    await memoryView.memoryViewSet(client, {
      projectId: projectA, name: 'smoke-view',
      queries: [
        { type: 'entity', limit: 5 },
        { type: 'assertion', limit: 5 },
        { type: 'recency', limit: 5 },
        { type: 'vector', query: 'smoke decision text', limit: 3 },
      ],
    });
    const run = await memoryView.memoryViewRun(client, { projectId: projectA, name: 'smoke-view' }, { embedder: EMBEDDER });
    const types = run.results.map((r) => r.type);
    assert(['entity', 'assertion', 'recency', 'vector'].every((t) => types.includes(t)), 'all 4 query types executed');
  });

  await check(19, 'memory-view: memoryViewSet refuses to overwrite a differently-kinded row (kind collision)', async () => {
    await client.query(
      `INSERT INTO retrieval_contract (project_id, name, queries, kind, version) VALUES ($1, 'collide-name', '[]'::jsonb, 'contract', 1)`,
      [projectA]
    );
    try {
      await memoryView.memoryViewSet(client, { projectId: projectA, name: 'collide-name', queries: [{ type: 'recency', limit: 5 }] });
      throw new Error('expected kindCollision error');
    } catch (err) {
      assertEq(err.code, 'kindCollision', 'error code');
    }
  });

  await check(20, 'memory-view: memoryViewRun on an unsupported query type is a hard error (M-16)', async () => {
    await client.query(
      `INSERT INTO retrieval_contract (project_id, name, queries, kind, version) VALUES ($1, 'bad-view', $2::jsonb, 'view', 1)`,
      [projectA, JSON.stringify([{ type: 'raw_sql', query: 'DROP TABLE x' }])]
    );
    try {
      await memoryView.memoryViewRun(client, { projectId: projectA, name: 'bad-view' });
      throw new Error('expected unsupportedQueryType error');
    } catch (err) {
      assertEq(err.code, 'unsupportedQueryType', 'error code — M-16: never raw SQL');
    }
  });

  return { allOk, results };
}

/**
 * runSelfTransactioningChecks — checks 21-29, run against a SEPARATE
 * dedicated connection (appendExchange/assertionCreate/assertionUpdate/
 * routingProfileSet each own their own BEGIN/COMMIT/ROLLBACK per
 * §7.7/M-5/M-18/cm#231 — same incompatibility with the outer rolled-back
 * transaction verify-19-seams-smoke.js's own header comment documents for
 * exchange-log.js). cm#231: assertionCreate joined this group when it started
 * routing through writeAssertionWithSupersession (which owns its own
 * BEGIN/COMMIT) — it used to be a plain single-statement INSERT, safe inside
 * the outer rolled-back transaction/savepoint group above.
 */
async function runSelfTransactioningChecks(client2, prefix) {
  const projectA = `${prefix}-proj-a`;
  let idCounter = 21;
  const results = [];
  let allOk = true;

  // cm#201 S-A.3: appendExchange's injected `embedder` seam now REQUIRES
  // `embedderProviderId` alongside it (both-or-neither). Resolve a real
  // embedding_providers.id once — mirrors verify-19-seams-smoke.js's own
  // runExchangeLogChecks precedent.
  const { rows: mockProviderRows } = await client2.query(`SELECT id FROM embedding_providers WHERE is_default = true LIMIT 1`);
  const mockProviderId = mockProviderRows.length > 0 ? mockProviderRows[0].id : null;

  async function check(name, fn) {
    const id = idCounter++;
    try {
      await fn();
      console.log(`[SMOKE-${LABEL}][${id}] PASS ${name}`);
      results.push({ id, name, ok: true });
    } catch (err) {
      console.log(`[SMOKE-${LABEL}][${id}] FAIL ${name}: ${err.message}`);
      results.push({ id, name, ok: false });
      allOk = false;
    }
  }

  function mockEmbedder() {
    return async () => new Array(4000).fill(0).map((_, i) => (i === 0 ? 0.1 : 0));
  }

  // cm#231: moved from runChecks (formerly check 14) — assertionCreate now
  // routes through writeAssertionWithSupersession (handoff.js), which owns
  // its own BEGIN/COMMIT, so it must run on this dedicated connection like
  // assertionUpdate already does, wrapped in a PostgresAdapter (the adapter
  // shape writeAssertionWithSupersession requires — see the import comment
  // above).
  await check('entity-graph-crud: assertionCreate surfaces a contradiction warning, and supersedes a same-cardinality-key prior row (cm#231)', async () => {
    const db2 = new PostgresAdapter(client2);
    // 'applies' is registered 1:N (predicate-registry.json) — deliberately
    // NOT a predicate assertions_1to1_unique's partial index enforces, so 2
    // genuinely live rows under the same (subject, predicate) are actually
    // reachable, so long as the object differs (writeAssertionWithSupersession's
    // 1:N branch only supersedes an EXACT (subject,predicate,object) duplicate
    // — S-6's ingest-time contradiction check is deliberately cardinality-
    // agnostic, but the DB schema's own 1:N supersession key is not, so the
    // fixture must pick a predicate + differing-object pair that survives as
    // two live rows).
    const r1 = await entityCrud.assertionCreate(db2, { projectId: projectA, subject: `${prefix}-CSubj`, predicate: 'applies', object: 'yes', confidence: 8, source: 'user_stated' });
    const r2 = await entityCrud.assertionCreate(db2, { projectId: projectA, subject: `${prefix}-CSubj`, predicate: 'applies', object: 'no', confidence: 8, source: 'user_stated' });
    assert(r2.contradictionWarning !== null, 'contradiction warning present');
    assertEq(r2.contradictionWarning.object, 'yes', 'warning names the conflicting row');
    assert(r1.row.tier !== null, 'cm#231: tier is non-null on the first row (was NULL pre-fix)');
    assert(r1.row.valid_at !== null, 'cm#231: valid_at is non-null on the first row (was NULL pre-fix)');
    assert(r2.row.tier !== null, 'cm#231: tier is non-null on the second row');
    assert(r2.row.valid_at !== null, 'cm#231: valid_at is non-null on the second row');

    // Exact (subject, predicate, object) repeat: superseded, not left as a 3rd live row.
    // NOTE: writeAssertionWithSupersession stores the CANONICALIZED subject
    // (trim+lowercase+collapse — see subject-canon.js), never the raw
    // fixture-cased subject, so this query matches on the canonical form too.
    const r3 = await entityCrud.assertionCreate(db2, { projectId: projectA, subject: `${prefix}-CSubj`, predicate: 'applies', object: 'no', confidence: 8, source: 'model_extracted' });
    const { rows: liveNo } = await client2.query(
      `SELECT id FROM assertions WHERE project_id = $1 AND subject = $2 AND predicate = 'applies' AND object = 'no' AND suppressed = false`,
      [projectA, canonicalize(`${prefix}-CSubj`)]
    );
    assertEq(liveNo.length, 1, 'exact 1:N duplicate superseded — exactly one live row for object="no"');
    assertEq(liveNo[0].id, r3.row.id, 'the live row is the newest write');
  });

  await check('entity-graph-crud: assertionSuppress sets invalid_at + suppression_kind=\'retired\' (cm#231)', async () => {
    const db2 = new PostgresAdapter(client2);
    const created = await entityCrud.assertionCreate(db2, { projectId: projectA, subject: `${prefix}-SuppSubj`, predicate: 'applies', object: 'retire-me', confidence: 8, source: 'user_stated' });
    const suppressed = await entityCrud.assertionSuppress(db2, { projectId: projectA, id: created.row.id });
    assertEq(suppressed.suppressed, true, 'suppressed flag set');
    assert(suppressed.invalid_at !== null, 'cm#231: invalid_at set (was NULL pre-fix)');
    assertEq(suppressed.suppression_kind, 'retired', 'cm#231: suppression_kind=\'retired\' (was NULL pre-fix)');
  });

  await check('entity-graph-crud: assertionUpdate supersedes old + inserts new, one transaction, optimistic guard (M-5)', async () => {
    const ins = await client2.query(
      `INSERT INTO assertions (project_id, subject, predicate, object, confidence, source)
       VALUES ($1, $2, 'now_uses', 'Postgres', 8, 'user_stated') RETURNING id`,
      [projectA, `${prefix}-supersede-subj`]
    );
    const oldId = ins.rows[0].id;
    const result = await entityCrud.assertionUpdate(client2, { projectId: projectA, id: oldId, predicate: 'now_uses', newObject: 'SQLite' });
    assertEq(result.oldId, oldId, 'old id returned');
    const { rows: oldRow } = await client2.query(`SELECT suppressed, invalid_at, suppression_kind FROM assertions WHERE id = $1`, [oldId]);
    assertEq(oldRow[0].suppressed, true, 'old row suppressed');
    assert(oldRow[0].invalid_at !== null, 'old row invalidated');
    assertEq(oldRow[0].suppression_kind, 'superseded', 'cm#231: old row suppression_kind=\'superseded\' (was NULL pre-fix)');
    assert(result.newRow.tier !== null, 'cm#231: new row tier is non-null (was NULL pre-fix)');
    assertEq(result.newRow.tier, 'probationary', 'cm#231: new row is born probationary (never auto-consolidated on an explicit update)');
    assert(result.newRow.valid_at !== null, 'cm#231: new row valid_at is non-null (was NULL pre-fix)');
  });

  await check('entity-graph-crud: assertionUpdate on an already-superseded target rolls back (stale optimistic guard, M-5)', async () => {
    const ins = await client2.query(
      `INSERT INTO assertions (project_id, subject, predicate, object, confidence, source)
       VALUES ($1, $2, 'now_uses', 'v1', 8, 'user_stated') RETURNING id`,
      [projectA, `${prefix}-stale-subj`]
    );
    const targetId = ins.rows[0].id;
    // Suppress it out from under the update.
    await client2.query(`UPDATE assertions SET suppressed = true, invalid_at = now() WHERE id = $1`, [targetId]);
    try {
      await entityCrud.assertionUpdate(client2, { projectId: projectA, id: targetId, predicate: 'now_uses', newObject: 'v2' });
      throw new Error('expected staleTarget error');
    } catch (err) {
      assertEq(err.code, 'staleTarget', 'error code');
    }
  });

  await check('exchange-log: exchangeRead M-8 no-watermark vs watermark behavior', async () => {
    const r1 = await exchangeLog.appendExchange(client2, {
      projectId: projectA, agentId: `${prefix}-agent-a`, kind: 'proposal', body: 'body one', summary: 'digest one', embedder: mockEmbedder(), embedderProviderId: mockProviderId,
    });
    const noFloor = await exchangeLog.exchangeRead(client2, { projectId: projectA, toAgent: `${prefix}-agent-b` });
    assert(noFloor.length >= 1, 'M-8: omitted watermark returns everything, not zero rows');
    const withFloor = await exchangeLog.exchangeRead(client2, { projectId: projectA, toAgent: `${prefix}-agent-b`, afterCreatedAt: r1.created_at, afterId: r1.id });
    assertEq(withFloor.length, 0, 'watermark = the row itself excludes it (no re-delivery)');
  });

  await check('exchange-log: exchangeRead M-9 compound watermark never loses a same-millisecond sibling', async () => {
    // Two rows forced to the exact same created_at via a direct UPDATE
    // after insert (real concurrent same-millisecond inserts are not
    // reliably reproducible in a single-threaded test).
    const rA = await exchangeLog.appendExchange(client2, {
      projectId: projectA, agentId: `${prefix}-agent-a`, kind: 'proposal', body: 'tie A', summary: 'tie A digest', embedder: mockEmbedder(), embedderProviderId: mockProviderId,
    });
    const rB = await exchangeLog.appendExchange(client2, {
      projectId: projectA, agentId: `${prefix}-agent-a`, kind: 'proposal', body: 'tie B', summary: 'tie B digest', embedder: mockEmbedder(), embedderProviderId: mockProviderId,
    });
    await client2.query(`UPDATE agent_exchange SET created_at = $1 WHERE id IN ($2, $3)`, [rA.created_at, rA.id, rB.id]);
    const afterA = await exchangeLog.exchangeRead(client2, { projectId: projectA, toAgent: `${prefix}-agent-b`, afterCreatedAt: rA.created_at, afterId: rA.id });
    assert(afterA.some((r) => r.id === rB.id), 'same-millisecond sibling (rB) is NOT lost when watermarked past rA (M-9)');
  });

  await check('routing-profile: routingProfileSet versions correctly under M-18\'s advisory-lock transaction', async () => {
    const v1 = await routingProfile.routingProfileSet(client2, { projectId: projectA, role: 'draft', capabilityTier: 'mid', preferredModel: 'model-a' });
    const v2 = await routingProfile.routingProfileSet(client2, { projectId: projectA, role: 'draft', capabilityTier: 'mid', preferredModel: 'model-b' });
    assertEq(v2.version, v1.version + 1, 'version incremented');
    const active = await routingProfile.routingProfileGet(client2, { projectId: projectA });
    assertEq(active.length, 1, 'only one active row for the role');
    assertEq(active[0].preferred_model, 'model-b', 'latest version is active');
  });

  await check('route-resolve: route_resolve M-10 override_ignored on a replay with a different override_model', async () => {
    await client2.query(
      `INSERT INTO model_registry (label, provider, capability_tier, available, cost_in_per_mtok, cost_out_per_mtok) VALUES ($1, 'p', 'mid', true, 1, 1) ON CONFLICT (label) DO NOTHING`,
      [`${prefix}-model-x`]
    );
    const r1 = await routeResolve.routeResolve(client2, { projectId: projectA, sessionId: 'sess-1', turnIdx: 0, role: 'draft', overrideModel: `${prefix}-model-x` });
    assertEq(r1.replayed, false, 'first resolve is not a replay');
    const r2 = await routeResolve.routeResolve(client2, { projectId: projectA, sessionId: 'sess-1', turnIdx: 0, role: 'draft', overrideModel: `${prefix}-model-y` });
    assertEq(r2.replayed, true, 'second resolve with a different override is still a replay');
    assertEq(r2.model, `${prefix}-model-x`, 'recorded model unchanged — the tool layer computes override_ignored from this (see handoff-mcp.mjs:toolRouteResolve)');
  });

  await check('usage-telemetry: usage_record after route_resolve updates the same turn_usage row', async () => {
    const rec = await usageTelemetry.usageRecord(client2, { projectId: projectA, sessionId: 'sess-1', turnIdx: 0, agentRole: 'draft', tokensIn: 10, tokensOut: 5 });
    assertEq(rec.created, false, 'route_resolve already created this row — usage_record updates it');
  });

  // Manual cleanup — this function does not run inside the outer
  // withTransactionRollback, so it owns its own zero-residue guarantee.
  for (const t of ['assertions', 'agent_exchange', 'routing_profiles', 'turn_usage', 'model_registry']) {
    await client2.query(`DELETE FROM ${t} WHERE project_id = $1`, [projectA]).catch(() => {});
  }
  await client2.query(`DELETE FROM model_registry WHERE label = $1`, [`${prefix}-model-x`]).catch(() => {});

  return { allOk, results };
}

/**
 * runMcpRegistrationCheck — spawns the REAL handoff-mcp.mjs over stdio,
 * lists tools (asserts all 35 names present — 5 pre-existing + 25 new +
 * handoff_resume + 4 more from the §17 B1 routing write surface,
 * 2026-09-06),
 * then calls entity_create through the real protocol against a disposable
 * scratch tmpdir project root (its own `.git` + a fresh marker minted by
 * `node handoff.js init -y`) — NEVER the real claude-memory dogfood
 * project. Proves mcp-db-connect.js + ensureProjectIdentity (M-19) work
 * end-to-end through the actual MCP transport, which the direct-lib checks
 * above (Group A/B) do not exercise (they call library functions directly
 * with a bare project_id string, bypassing withProjectDb entirely).
 */
async function runMcpRegistrationCheck(dbName, cleanupClient) {
  const { Client: SdkClient } = require(path.join(PROJECT_ROOT, 'scripts', 'node_modules', '@modelcontextprotocol', 'sdk', 'dist', 'cjs', 'client', 'index.js'));
  const { StdioClientTransport } = require(path.join(PROJECT_ROOT, 'scripts', 'node_modules', '@modelcontextprotocol', 'sdk', 'dist', 'cjs', 'client', 'stdio.js'));

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'verify20-mcp-scratch-'));
  fs.mkdirSync(path.join(tmpRoot, '.git'));
  const claudeDir = path.join(tmpRoot, '.claude');
  fs.mkdirSync(claudeDir, { recursive: true });
  fs.writeFileSync(
    path.join(claudeDir, 'pipeline.yml'),
    `project:\n  name: verify20-scratch\nknowledge:\n  tier: "postgres"\n  host: "${process.env.PGHOST || 'localhost'}"\n  port: ${process.env.PGPORT || 5432}\n  database: "${dbName}"\n  user: "${process.env.PGUSER || 'postgres'}"\n`
  );

  const serverPath = path.join(PROJECT_ROOT, 'scripts', 'handoff-mcp.mjs');
  const transport = new StdioClientTransport({ command: process.execPath, args: [serverPath], env: { ...process.env, HANDOFF_DB: dbName } });
  const client = new SdkClient({ name: 'verify-20-registration-check', version: '0.1.0' }, { capabilities: {} });

  let ok = true;
  const failures = [];
  try {
    await client.connect(transport);
    const toolsList = await client.listTools();
    const actualNames = new Set(toolsList.tools.map((t) => t.name));
    const expected = [
      'handoff_status', 'handoff_checkpoint', 'handoff_close', 'handoff_init', 'persist_decisions',
      'handoff_resume',
      'memory_search', 'memory_upsert', 'memory_get', 'memory_lint',
      'memory_view_set', 'memory_view_run',
      'entity_create', 'entity_read', 'entity_update', 'entity_suppress',
      'assertion_create', 'assertion_read', 'assertion_update', 'assertion_suppress',
      'edge_create', 'edge_read', 'edge_update', 'edge_suppress',
      'exchange_append', 'exchange_read',
      'route_resolve', 'routing_profile_set', 'routing_profile_get',
      'model_registry_set', 'routing_session_override_set', 'routing_session_override_get', 'routing_session_override_clear',
      'usage_record', 'usage_query',
    ];
    const missing = expected.filter((n) => !actualNames.has(n));
    if (missing.length) { ok = false; failures.push(`missing tool registrations: ${missing.join(', ')}`); }
    if (actualNames.size !== expected.length) {
      failures.push(`WARNING: tool count is ${actualNames.size}, expected ${expected.length} (extra: ${[...actualNames].filter((n) => !expected.includes(n)).join(', ')})`);
    }

    const createRes = await client.callTool({
      name: 'entity_create',
      arguments: { projectRoot: tmpRoot, name: 'RegistrationCheckEntity', entityType: 'component' },
    });
    if (createRes.isError) { ok = false; failures.push(`entity_create through real MCP transport errored: ${createRes.content[0].text}`); }
    else {
      const parsed = JSON.parse(createRes.content[0].text);
      if (!parsed.row || !Number.isInteger(parsed.row.id)) { ok = false; failures.push('entity_create through real MCP transport returned no row.id'); }
      // This wrote through a REAL ensureProjectIdentity call, which mints its
      // own fresh marker UUID for tmpRoot — not a smoke-mm18- prefixed id
      // (that convention only applies to the direct-lib checks above, which
      // supply their own project_id string). Clean it up explicitly by the
      // exact id this call returned, on the SAME connection/database the
      // server itself wrote to (dbName), never a broad prefix scan.
      else if (cleanupClient && parsed.row.project_id) {
        await cleanupClient.query(`DELETE FROM entities WHERE project_id = $1`, [parsed.row.project_id]).catch(() => {});
      }
    }
  } catch (err) {
    ok = false;
    failures.push(err.stack || String(err));
  } finally {
    try { await client.close(); } catch (_) {}
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch (_) {}
  }

  console.log(`[SMOKE-${LABEL}][mcp-registration] ${ok ? 'PASS' : 'FAIL'} 35-tool registration + entity_create through the real stdio MCP transport`);
  for (const f of failures) console.log(`    ${f}`);
  return ok;
}

async function main() {
  let parsed;
  try {
    parsed = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exit(2);
  }

  const { name: target, source } = migrateOne.resolveTargetDb(parsed);
  if (!migrateOne.DB_NAME_RE.test(target)) {
    console.error(`Invalid database name "${target}" (from ${source})`);
    process.exit(1);
  }
  const classification = migrateOne.classifyTarget(target);
  if (!classification.allowed) {
    console.error(`Refused: ${classification.reason}`);
    process.exit(1);
  }

  console.log(`verify-20-mcp-surface: target="${target}" (resolved from ${source})`);

  const db = new Client(migrateOne.pgConfig(target));
  await db.connect();

  try {
    const missing = await checkPrerequisites(db);
    if (missing.length) {
      console.error(`Refused: target "${target}" is missing prerequisite(s): ${missing.join(', ')}.`);
      console.error('Run migrate-15-mcp-addenda.js (and re-apply migrate-13-agent-exchange.js) first.');
      process.exitCode = 1;
      return;
    }

    // crypto.randomUUID() (CSPRNG), not Math.random() (predictable, non-
    // cryptographic PRNG) — this value only needs to be a collision-safe
    // scratch-fixture namespace, not secret, but CodeQL's js/insecure-
    // randomness query flags any Math.random() call regardless of the
    // sink's actual sensitivity, so this repo's convention (see
    // handoff-mcp.mjs's writeTempJson) is randomUUID() everywhere, even for
    // non-secret uses like this one.
    const prefix = `smoke-mm18-${Date.now().toString(36)}-${crypto.randomUUID().replace(/-/g, '').slice(0, 8)}`;
    console.log(`  run prefix: ${prefix}`);

    const { allOk } = await harness.withTransactionRollback(db, [], async () => runChecks(db, prefix));

    const db2 = new Client(migrateOne.pgConfig(target));
    await db2.connect();
    let selfTxOk;
    try {
      ({ allOk: selfTxOk } = await runSelfTransactioningChecks(db2, prefix));
    } finally {
      await db2.end();
    }

    const residue = await harness.scanForResidue(db, prefix, [
      { table: 'decisions', where: `project_id LIKE $1` },
      { table: 'gotchas', where: `project_id LIKE $1` },
      { table: 'entities', where: `project_id LIKE $1` },
      { table: 'assertions', where: `project_id LIKE $1` },
      { table: 'edges', where: `project_id LIKE $1` },
      { table: 'agent_exchange', where: `project_id LIKE $1` },
      { table: 'routing_profiles', where: `project_id LIKE $1` },
      { table: 'retrieval_contract', where: `project_id LIKE $1` },
    ]);
    if (residue.length) {
      console.error(`  RESIDUE DETECTED: ${residue.join('; ')}`);
    } else {
      console.log('  residue scan: clean (0 rows)');
    }

    const mcpOk = await runMcpRegistrationCheck(target, db);

    const finalOk = allOk && selfTxOk && residue.length === 0 && mcpOk;
    harness.printSummary(LABEL, finalOk);
    process.exitCode = finalOk ? 0 : 1;
  } finally {
    await db.end();
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err && err.stack ? err.stack : err);
    process.exitCode = 1;
  });
}

module.exports = { PREREQUISITE_TABLES, checkPrerequisites, runChecks, runSelfTransactioningChecks };
