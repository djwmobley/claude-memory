'use strict';

/**
 * test-migrate-07-reembed-corpus.js
 *
 * Regression suite for scripts/migrations/migrate-07-reembed-corpus.js
 * (§6.1(g) + its G-R1..G-R14 amendment, mm#11(g)). Synthetic fixtures ONLY
 * -- no real project ids, no real content, no live vLLM (every provider
 * call in this suite goes through an injected deterministic fake
 * transport; see VllmEmbeddingProvider's injectable-transport contract).
 *
 * Self-contained: creates/drops its own scratch target database with a
 * HAND-CRAFTED minimal schema (mirrors test-migrate-05's own pattern --
 * this suite does not apply the full production schema stack). Never
 * touches memory_manager_staging or any real database.
 *
 * Usage: node test/migrations/test-migrate-07-reembed-corpus.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { createRequire } = require('module');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const MIGRATE07_PATH = path.join(PROJECT_ROOT, 'scripts', 'migrations', 'migrate-07-reembed-corpus.js');
const migrate07 = require(MIGRATE07_PATH);

const scriptsRequire = createRequire(require.resolve('../../scripts/package.json'));
const { Client } = scriptsRequire('pg');
const migrateOne = require(path.join(PROJECT_ROOT, 'scripts', 'migrations', 'migrate-01-canonical-db.js'));

// ─── HARNESS ────────────────────────────────────────────────────────────────

let passed = 0, failed = 0;
async function run(id, label, fn) {
  try {
    await fn();
    console.log(`  [PASS] ${id} ${label}`);
    passed++;
  } catch (err) {
    console.error(`  [FAIL] ${id} ${label}: ${err.message}`);
    failed++;
  }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }
async function assertThrows(fn, msgIncludes) {
  let threw = false;
  try { await fn(); } catch (err) {
    threw = true;
    if (msgIncludes) assert(err.message.includes(msgIncludes), `expected error to include "${msgIncludes}", got: ${err.message}`);
  }
  assert(threw, 'expected function to throw, but it did not');
}

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
  const sys = await pgConnect('postgres');
  try {
    await sys.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`, [dbName]);
    await sys.query(`DROP DATABASE IF EXISTS "${dbName}"`);
  } finally {
    await sys.end();
  }
}
async function createDb(dbName) {
  const sys = await pgConnect('postgres');
  try {
    await sys.query(`CREATE DATABASE "${dbName}"`);
  } finally {
    await sys.end();
  }
}

function writeTempJson(name, data) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'migrate07-test-'));
  const p = path.join(dir, name);
  fs.writeFileSync(p, JSON.stringify(data, null, 2), 'utf8');
  return p;
}

// ─── DETERMINISTIC FAKE TRANSPORT (no live vLLM anywhere in this suite) ────

function deterministicVector(text, dims) {
  const h = crypto.createHash('md5').update(text).digest();
  const vec = [];
  for (let i = 0; i < dims; i++) vec.push((h[i % h.length] / 255) - 0.5);
  return vec;
}

/** Always-succeeds transport, native `dims` length. */
function makeFakeTransport(dims) {
  return async (text) => deterministicVector(text, dims);
}

/** Fails on the (failAfter+1)-th call onward -- for provider-failure-resume tests. */
function makeFailingTransport(dims, failAfter) {
  let calls = 0;
  return async (text) => {
    calls += 1;
    if (calls > failAfter) throw new Error('SIMULATED-PROVIDER-FAILURE');
    return deterministicVector(text, dims);
  };
}

// ─── MAIN ───────────────────────────────────────────────────────────────────

async function main() {
  console.log('test-migrate-07-reembed-corpus: starting');

  // ── PURE UNIT TESTS (no DB) ──────────────────────────────────────────
  await run('PK-1', 'default PK spec is bare id', () => {
    assert(JSON.stringify(migrate07.getPkSpec('widget').cols) === JSON.stringify(['id']), 'expected [\'id\']');
  });
  await run('PK-2', 'findings PK override is (project_id, id)', () => {
    assert(JSON.stringify(migrate07.getPkSpec('findings').cols) === JSON.stringify(['project_id', 'id']), 'expected composite PK');
  });
  await run('PK-3', 'encodePk/decodePk round-trip for a composite key', () => {
    const pkSpec = migrate07.getPkSpec('findings');
    const row = { project_id: 'proj-a', id: 'RT-INJ-001', other: 'ignored' };
    const { colStr, valStr } = migrate07.encodePk(pkSpec, row);
    const decoded = migrate07.decodePk(colStr, valStr);
    assert(decoded.length === 2 && decoded[0].col === 'project_id' && decoded[0].val === 'proj-a' && decoded[1].col === 'id' && decoded[1].val === 'RT-INJ-001', `round-trip mismatch: ${JSON.stringify(decoded)}`);
  });
  await run('PK-4', 'pkWhereClause offsets placeholders correctly', () => {
    assert(migrate07.pkWhereClause(['id'], 0) === '"id"=$1', 'offset-0 mismatch');
    assert(migrate07.pkWhereClause(['project_id', 'id'], 2) === '"project_id"=$3 AND "id"=$4', 'offset-2 composite mismatch');
  });
  await run('ROSTER-1', 'tryLoadRoster returns [] when the file is absent (CI posture)', () => {
    const roster = migrate07.tryLoadRoster(path.join(os.tmpdir(), `definitely-absent-${Date.now()}.json`), () => {});
    assert(Array.isArray(roster) && roster.length === 0, 'expected empty array');
  });
  await run('LABELS-1', 'manifestLabelsForTable always includes the bare targetTable name (zero-roster-dependency case)', () => {
    const labels = migrate07.manifestLabelsForTable([], 'assertions');
    assert(labels.includes('assertions'), `expected "assertions" in ${JSON.stringify(labels)}`);
  });
  await run('LABELS-2', 'manifestLabelsForTable adds every roster source_table label mapping to this targetTable', () => {
    const roster = [
      { targetTable: 'memory_entries', source_table: 'memory_entries_db_absorb' },
      { targetTable: 'memory_entries', source_table: 'file_memory_raw_entries' },
      { targetTable: 'decisions', source_table: 'decisions' },
    ];
    const labels = migrate07.manifestLabelsForTable(roster, 'memory_entries').sort();
    assert(JSON.stringify(labels) === JSON.stringify(['file_memory_raw_entries', 'memory_entries', 'memory_entries_db_absorb'].sort()), `got ${JSON.stringify(labels)}`);
  });

  // ── LIVE DB fixtures ──────────────────────────────────────────────────
  const stamp = Date.now();
  const TARGET_DB = `migrate07_test_${stamp}_staging`;
  const NATIVE_DIMS = 8;
  const STORED_DIMS = 4;

  await createDb(TARGET_DB);
  const tgt = await pgConnect(TARGET_DB);

  try {
    await tgt.query('CREATE EXTENSION IF NOT EXISTS vector');

    // Minimal embedding_providers table (mirrors embedding-providers-base.sql's
    // shape; test-scoped dims, never the real vllm-local literal values).
    await tgt.query(`
      CREATE TABLE embedding_providers (
        id           SERIAL PRIMARY KEY,
        name         TEXT NOT NULL UNIQUE,
        model_label  TEXT NOT NULL,
        native_dims  INTEGER NOT NULL,
        stored_dims  INTEGER NOT NULL,
        endpoint     TEXT,
        is_default   BOOLEAN NOT NULL DEFAULT false,
        created_at   TIMESTAMPTZ DEFAULT NOW()
      );
      INSERT INTO embedding_providers (name, model_label, native_dims, stored_dims, endpoint, is_default)
      VALUES ('test-provider', 'test-model', ${NATIVE_DIMS}, ${STORED_DIMS}, 'http://fake-endpoint.invalid', true);

      -- migration_manifest (minimal shape this script reads from -- G-R7/G-R11)
      CREATE TABLE migration_manifest (
        id SERIAL PRIMARY KEY,
        source_db TEXT NOT NULL,
        source_table TEXT NOT NULL,
        project_id_or_null TEXT,
        row_count BIGINT NOT NULL,
        content_fingerprint TEXT NOT NULL,
        captured_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        excluded_reason TEXT
      );

      -- Bucket C (declared expression, has a 'suppressed' column -- exempt-
      -- suppressed-and-empty bucket exercised here).
      CREATE TABLE assertions (
        id SERIAL PRIMARY KEY,
        project_id TEXT,
        subject TEXT, predicate TEXT, object TEXT,
        suppressed BOOLEAN NOT NULL DEFAULT false,
        embedding halfvec(${STORED_DIMS})
      );

      -- Bucket B (roster-hinted, no content_hash).
      CREATE TABLE widget (
        id SERIAL PRIMARY KEY,
        project_id TEXT,
        blurb TEXT,
        embedding halfvec(${STORED_DIMS})
      );

      -- Bucket A (roster-hinted, HAS content_hash -- still gate=embedding IS NULL).
      CREATE TABLE hashed_widget (
        id SERIAL PRIMARY KEY,
        project_id TEXT,
        blurb TEXT,
        content_hash TEXT,
        embedding halfvec(${STORED_DIMS})
      );

      -- Neither declared nor roster-hinted -- UNCLASSIFIABLE fixture.
      CREATE TABLE mystery_widget (
        id SERIAL PRIMARY KEY,
        project_id TEXT,
        blurb TEXT,
        embedding halfvec(${STORED_DIMS})
      );
    `);

    const ROSTER_PATH = writeTempJson('roster.json', [
      { source_db: 'net-new:test', source_table: 'widget', targetTable: 'widget', loadBearingCols: ['blurb'], hasContentBearingText: true, requires_project_id_scope: true, contentCol: 'blurb' },
      { source_db: 'net-new:test', source_table: 'hashed_widget', targetTable: 'hashed_widget', loadBearingCols: ['blurb'], hasContentBearingText: true, requires_project_id_scope: true, contentCol: 'blurb' },
      // Mirrors the REAL live roster's migrate-verify-own-graph.js-authored
      // row (source_table === targetTable === 'assertions') -- needed for
      // T9's checkExclusion/targetTableFor (reused by reference in
      // runPreflight) to map an 'assertions' manifest exclusion back to a
      // target table at all.
      { source_db: 'claude_memory_eval_test', source_table: 'assertions', targetTable: 'assertions', loadBearingCols: ['subject', 'predicate', 'object'], hasContentBearingText: true, requires_project_id_scope: true },
    ]);
    const roster = JSON.parse(fs.readFileSync(ROSTER_PATH, 'utf8'));

    // ── CLASSIFICATION ──────────────────────────────────────────────────
    await run('CLASSIFY-1', 'declared expression used for a table this script recognizes (assertions)', async () => {
      const spec = await migrate07.resolveTableContentSpec(tgt, 'assertions', [], () => {});
      assert(spec.source === 'declared', `expected declared, got ${spec.source}`);
    });
    await run('CLASSIFY-2', 'roster contentCol hint used + validated when no declared expression exists', async () => {
      const spec = await migrate07.resolveTableContentSpec(tgt, 'widget', roster, () => {});
      assert(spec.source === 'roster' && spec.contentCol === 'blurb', `got ${JSON.stringify(spec)}`);
    });
    await run('CLASSIFY-3', 'a roster hint naming a nonexistent column is a loud FATAL, not a silent skip (G-R1)', async () => {
      const badRoster = [{ source_db: 'x', source_table: 'y', targetTable: 'widget', contentCol: 'no_such_column' }];
      await assertThrows(() => migrate07.resolveTableContentSpec(tgt, 'widget', badRoster, () => {}), 'does not exist on "widget"');
    });
    await run('CLASSIFY-4', 'a table with neither a declared expression nor a roster hint is UNCLASSIFIABLE, never silently skipped', async () => {
      await assertThrows(() => migrate07.resolveTableContentSpec(tgt, 'mystery_widget', [], () => {}), 'UNCLASSIFIABLE');
    });
    await run('DISCOVER-1', 'DDL-derived enumeration finds every halfvec/vector-typed table this fixture created (never a hand-listed subset)', async () => {
      const discovered = await migrate07.discoverEmbeddableTables(tgt);
      const names = discovered.map((d) => d.table).sort();
      for (const t of ['assertions', 'widget', 'hashed_widget', 'mystery_widget']) {
        assert(names.includes(t), `expected "${t}" among discovered tables ${JSON.stringify(names)}`);
      }
    });
    // mystery_widget only existed to prove CLASSIFY-4/DISCOVER-1's point (an
    // embeddable table with no content source is UNCLASSIFIABLE and IS still
    // discovered, never silently dropped from enumeration). Every run() call
    // from here on processes EVERY discovered table, so mystery_widget must
    // go before any full run() -- otherwise every subsequent test would fail
    // on the same UNCLASSIFIABLE refusal, for a reason unrelated to what
    // each of those tests actually verifies.
    await tgt.query('DROP TABLE mystery_widget');

    // ── G-R11 PREFLIGHT ──────────────────────────────────────────────────
    await run('PREFLIGHT-1', 'zero exclusion rows in migration_manifest is a trivial PASS', async () => {
      const result = await migrate07.runPreflight(tgt, roster, () => {});
      assert(result.ok === true && result.checked === 0, `expected trivial pass, got ${JSON.stringify(result)}`);
    });
    await run('PREFLIGHT-2', 'an excluded_reason slice with no roster-mappable target is a FAIL (refuses, never silently ignored)', async () => {
      await tgt.query(`INSERT INTO migration_manifest (source_db, source_table, project_id_or_null, row_count, content_fingerprint, excluded_reason) VALUES ('src', 'no_roster_mapping_table', 'junk-proj', 3, 'fp', 'eval-junk-project-id')`);
      try {
        const result = await migrate07.runPreflight(tgt, roster, () => {});
        assert(result.ok === false, 'expected preflight to FAIL for an unmapped exclusion');
      } finally {
        await tgt.query(`DELETE FROM migration_manifest WHERE source_table = 'no_roster_mapping_table'`);
      }
    });
    await run('PREFLIGHT-3', 'an excluded_reason slice with zero live rows in the mapped target table is a PASS', async () => {
      await tgt.query(`INSERT INTO migration_manifest (source_db, source_table, project_id_or_null, row_count, content_fingerprint, excluded_reason) VALUES ('src', 'assertions', 'never-live-proj', 3, 'fp', 'eval-junk-project-id')`);
      try {
        const result = await migrate07.runPreflight(tgt, roster, () => {});
        assert(result.ok === true, `expected pass (0 live rows for that project_id), got ${JSON.stringify(result)}`);
      } finally {
        await tgt.query(`DELETE FROM migration_manifest WHERE source_table = 'assertions' AND project_id_or_null = 'never-live-proj'`);
      }
    });

    // ── G-R2 ALTER SUB-STEP (own isolated scratch schema) ────────────────
    await run('ALTER-1..4', 'legacy vector(1024) -> halfvec(4000): view preserved, opclass correct, idempotent second run', async () => {
      await tgt.query(`
        CREATE TABLE memory_entries (
          id SERIAL PRIMARY KEY, project_id TEXT, body TEXT, embedding vector(1024)
        );
        CREATE TABLE memory_entry_chunks (
          id SERIAL PRIMARY KEY, project_id TEXT, entry_id INTEGER REFERENCES memory_entries(id), content TEXT, embedding vector(1024)
        );
        CREATE INDEX memory_entries_vec_idx ON memory_entries USING ivfflat (embedding vector_cosine_ops);
        CREATE INDEX mem_chunks_vec_idx ON memory_entry_chunks USING ivfflat (embedding vector_cosine_ops);
        CREATE VIEW v_memory_hits AS SELECT id AS chunk_id, entry_id, content FROM memory_entry_chunks;
      `);

      const r1 = await migrate07.runAlterLegacyVectorColumn(tgt, 'memory_entries', () => {});
      assert(r1.applied === true, 'expected memory_entries ALTER to apply');
      const r2 = await migrate07.runAlterLegacyVectorColumn(tgt, 'memory_entry_chunks', () => {});
      assert(r2.applied === true, 'expected memory_entry_chunks ALTER to apply');

      const t1 = await migrate07.getFormatType(tgt, 'memory_entries', 'embedding');
      const t2 = await migrate07.getFormatType(tgt, 'memory_entry_chunks', 'embedding');
      assert(t1 === 'halfvec(4000)', `memory_entries.embedding expected halfvec(4000), got ${t1}`);
      assert(t2 === 'halfvec(4000)', `memory_entry_chunks.embedding expected halfvec(4000), got ${t2}`);

      // view preserved and queryable
      const { rows: viewRows } = await tgt.query(`SELECT * FROM v_memory_hits`);
      assert(Array.isArray(viewRows), 'expected v_memory_hits to still be queryable post-ALTER');

      // index opclass halfvec_cosine_ops, partial WHERE
      const { rows: idxRows } = await tgt.query(`SELECT indexdef FROM pg_indexes WHERE tablename = 'memory_entry_chunks' AND indexname = 'memory_entry_chunks_embedding_hnsw_idx'`);
      assert(idxRows.length === 1, 'expected the new HNSW index to exist');
      assert(idxRows[0].indexdef.includes('halfvec_cosine_ops'), `expected halfvec_cosine_ops in ${idxRows[0].indexdef}`);
      assert(idxRows[0].indexdef.toLowerCase().includes('where'), `expected a partial (WHERE embedding IS NOT NULL) index, got ${idxRows[0].indexdef}`);

      // idempotent second run: no-op, no error
      const r3 = await migrate07.runAlterLegacyVectorColumn(tgt, 'memory_entries', () => {});
      assert(r3.applied === false && r3.reason === 'already-halfvec', `expected idempotent no-op, got ${JSON.stringify(r3)}`);
    });

    // ── PROVENANCE COLUMN ─────────────────────────────────────────────────
    await run('PROV-DDL-1', 'ensureProvenanceColumn adds embedded_by_provider_id idempotently', async () => {
      await migrate07.ensureProvenanceColumn(tgt, 'widget', () => {});
      await migrate07.ensureProvenanceColumn(tgt, 'widget', () => {}); // idempotent second call
      const has = await migrate07.hasColumn(tgt, 'widget', 'embedded_by_provider_id');
      assert(has, 'expected embedded_by_provider_id to exist on widget');
      await migrate07.ensureProvenanceColumn(tgt, 'assertions', () => {});
      await migrate07.ensureProvenanceColumn(tgt, 'hashed_widget', () => {});
    });

    // ── COMPLETENESS GATE (G-R13 item 1: can genuinely FAIL) ─────────────
    await run('GATE-1', 'a NULL-embedding non-empty-content row makes the gate FAIL (nonzero)', async () => {
      await tgt.query(`INSERT INTO widget (project_id, blurb) VALUES ('proj-gate', 'has real content')`);
      const spec = await migrate07.resolveTableContentSpec(tgt, 'widget', roster, () => {});
      const gate = await migrate07.runCompletenessGate(tgt, [{ table: 'widget', spec, hasSuppressed: false }], () => {});
      assert(gate.pass === false, 'expected the gate to FAIL');
      assert(gate.report[0].pending > 0, `expected pending > 0, got ${JSON.stringify(gate.report)}`);
      await tgt.query(`DELETE FROM widget WHERE project_id = 'proj-gate'`);
    });
    await run('GATE-2', 'empty-content rows are exempt, not counted as pending', async () => {
      await tgt.query(`INSERT INTO widget (project_id, blurb) VALUES ('proj-gate2', '   ')`);
      const spec = await migrate07.resolveTableContentSpec(tgt, 'widget', roster, () => {});
      const gate = await migrate07.runCompletenessGate(tgt, [{ table: 'widget', spec, hasSuppressed: false }], () => {});
      assert(gate.pass === true, `expected pass (only exempt-empty rows), got ${JSON.stringify(gate.report)}`);
      await tgt.query(`DELETE FROM widget WHERE project_id = 'proj-gate2'`);
    });
    await run('GATE-3', 'suppressed AND empty rows land in exempt-suppressed-and-empty, distinct from plain exempt-empty', async () => {
      await tgt.query(`INSERT INTO assertions (project_id, subject, predicate, object, suppressed) VALUES ('proj-gate3', NULL, NULL, NULL, true)`);
      const spec = await migrate07.resolveTableContentSpec(tgt, 'assertions', [], () => {});
      const gate = await migrate07.runCompletenessGate(tgt, [{ table: 'assertions', spec, hasSuppressed: true }], () => {});
      assert(gate.pass === true, 'expected pass');
      assert(gate.report[0].exemptSuppressedEmpty >= 1, `expected exemptSuppressedEmpty >= 1, got ${JSON.stringify(gate.report)}`);
      await tgt.query(`DELETE FROM assertions WHERE project_id = 'proj-gate3'`);
    });

    // ── FULL EMBED LOOP via run() -- deterministic fake transport ────────
    await run('EMBED-1', 'run() embeds every non-empty candidate, writes provenance + write-log, gate passes after', async () => {
      await tgt.query(`INSERT INTO widget (project_id, blurb) VALUES ('proj-e1', 'alpha content'), ('proj-e1', 'beta content'), ('proj-e1', '')`);
      const runId = crypto.randomUUID();
      const ok = await migrate07.run(TARGET_DB, { rosterPath: ROSTER_PATH,transport: makeFakeTransport(NATIVE_DIMS), runId });
      assert(ok === true, 'expected run() to PASS');

      const { rows } = await tgt.query(`SELECT id, embedding, embedded_by_provider_id FROM widget WHERE project_id = 'proj-e1' ORDER BY id`);
      assert(rows.length === 3, `expected 3 rows, got ${rows.length}`);
      assert(rows[0].embedding !== null && rows[0].embedded_by_provider_id !== null, 'row 1 (non-empty content) expected embedded with provenance');
      assert(rows[1].embedding !== null && rows[1].embedded_by_provider_id !== null, 'row 2 (non-empty content) expected embedded with provenance');
      assert(rows[2].embedding === null, 'row 3 (empty content) expected to stay NULL (exempt, never embedded)');

      const { rows: logRows } = await tgt.query(`SELECT COUNT(*)::int AS n FROM embedding_write_log WHERE table_name='widget'`);
      assert(logRows[0].n >= 2, `expected at least 2 write_log rows, got ${logRows[0].n}`);

      // re-run is a true no-op (idempotency): zero NEW writes for already-embedded rows
      const beforeLog = logRows[0].n;
      const ok2 = await migrate07.run(TARGET_DB, { rosterPath: ROSTER_PATH,transport: makeFakeTransport(NATIVE_DIMS), runId: crypto.randomUUID() });
      assert(ok2 === true, 'expected second run() to PASS');
      const { rows: logRows2 } = await tgt.query(`SELECT COUNT(*)::int AS n FROM embedding_write_log WHERE table_name='widget'`);
      assert(logRows2[0].n === beforeLog, `expected no new write_log rows on re-run, before=${beforeLog} after=${logRows2[0].n}`);
    });

    // ── G-R13 item 2: Bucket-B mutation-visibility test ───────────────────
    await run('MUTATE-1', 'Bucket B: in-place content mutation is NOT detected -- no re-embed path exists (documented, stated limitation)', async () => {
      const { rows: before } = await tgt.query(`SELECT id, embedding FROM widget WHERE project_id='proj-e1' ORDER BY id LIMIT 1`);
      const originalEmbedding = before[0].embedding;
      assert(originalEmbedding !== null, 'precondition: row must already be embedded');

      await tgt.query(`UPDATE widget SET blurb = 'MUTATED CONTENT, COMPLETELY DIFFERENT' WHERE id = $1`, [before[0].id]);

      await migrate07.run(TARGET_DB, { rosterPath: ROSTER_PATH,transport: makeFakeTransport(NATIVE_DIMS), runId: crypto.randomUUID() });

      const { rows: after } = await tgt.query(`SELECT embedding FROM widget WHERE id = $1`, [before[0].id]);
      assert(after[0].embedding === originalEmbedding, 'expected the embedding to be UNCHANGED after an in-place content mutation -- gate is embedding IS NULL only, Bucket B has no staleness key (documented limitation, G-R14).');
    });

    // ── G-R13 item 3: rollback scoping across two runs ─────────────────
    await run('ROLLBACK-1', 'rollback of run 1 leaves run 2\'s rows untouched', async () => {
      await tgt.query(`INSERT INTO widget (project_id, blurb) VALUES ('proj-rb1', 'rollback target one')`);
      const run1Id = crypto.randomUUID();
      await migrate07.run(TARGET_DB, { rosterPath: ROSTER_PATH,transport: makeFakeTransport(NATIVE_DIMS), runId: run1Id });
      const { rows: r1rows } = await tgt.query(`SELECT id, embedding FROM widget WHERE project_id='proj-rb1'`);
      assert(r1rows[0].embedding !== null, 'run1 row expected embedded');

      await tgt.query(`INSERT INTO widget (project_id, blurb) VALUES ('proj-rb2', 'rollback target two')`);
      const run2Id = crypto.randomUUID();
      await migrate07.run(TARGET_DB, { rosterPath: ROSTER_PATH,transport: makeFakeTransport(NATIVE_DIMS), runId: run2Id });
      const { rows: r2rows } = await tgt.query(`SELECT id, embedding FROM widget WHERE project_id='proj-rb2'`);
      assert(r2rows[0].embedding !== null, 'run2 row expected embedded');

      await migrate07.run(TARGET_DB, { rosterPath: ROSTER_PATH,rollback: run1Id, transport: makeFakeTransport(NATIVE_DIMS) });

      const { rows: afterRollback1 } = await tgt.query(`SELECT embedding FROM widget WHERE project_id='proj-rb1'`);
      const { rows: afterRollback2 } = await tgt.query(`SELECT embedding FROM widget WHERE project_id='proj-rb2'`);
      assert(afterRollback1[0].embedding === null, 'expected run1 row NULLed by rollback');
      assert(afterRollback2[0].embedding !== null, 'expected run2 row UNTOUCHED by run1\'s rollback');

      // Cleanup: proj-rb1's row now has a NULL embedding + non-empty content
      // (correctly rolled back) -- left in place it would silently become a
      // candidate row for every later test's run() calls, coupling this
      // test's rollback semantics to unrelated later assertions. Delete both
      // fixture rows now that this test's own assertions are complete.
      await tgt.query(`DELETE FROM widget WHERE project_id IN ('proj-rb1', 'proj-rb2')`);
    });

    // ── G-R13 item 5: provider-failure resume ─────────────────────────────
    await run('RESUME-1', 'provider failure is an immediate hard stop; a clean re-run completes the remainder with zero re-embeds', async () => {
      await tgt.query(`INSERT INTO widget (project_id, blurb) VALUES ('proj-resume', 'row one'), ('proj-resume', 'row two'), ('proj-resume', 'row three')`);

      let threw = false;
      try {
        await migrate07.run(TARGET_DB, { rosterPath: ROSTER_PATH,transport: makeFailingTransport(NATIVE_DIMS, 1), runId: crypto.randomUUID() });
      } catch (err) {
        threw = true;
      }
      assert(threw, 'expected the run to throw on the simulated provider failure (hard stop, never swallowed)');

      const { rows: midRows } = await tgt.query(`SELECT COUNT(*)::int AS n FROM widget WHERE project_id='proj-resume' AND embedding IS NOT NULL`);
      assert(midRows[0].n === 1, `expected exactly 1 row embedded before the simulated failure, got ${midRows[0].n}`);

      const { rows: logCountBefore } = await tgt.query(`SELECT COUNT(*)::int AS n FROM embedding_write_log WHERE table_name='widget'`);

      const ok = await migrate07.run(TARGET_DB, { rosterPath: ROSTER_PATH,transport: makeFakeTransport(NATIVE_DIMS), runId: crypto.randomUUID() });
      assert(ok === true, 'expected the resumed run to PASS');

      const { rows: finalRows } = await tgt.query(`SELECT COUNT(*)::int AS n FROM widget WHERE project_id='proj-resume' AND embedding IS NOT NULL`);
      assert(finalRows[0].n === 3, `expected all 3 rows embedded after resume, got ${finalRows[0].n}`);

      const { rows: logCountAfter } = await tgt.query(`SELECT COUNT(*)::int AS n FROM embedding_write_log WHERE table_name='widget'`);
      assert(logCountAfter[0].n === logCountBefore[0].n + 2, `expected exactly 2 NEW write_log rows on resume (the 2 not yet embedded), before=${logCountBefore[0].n} after=${logCountAfter[0].n}`);
    });

    // ── G-R7 manifest exclusion scoping ───────────────────────────────────
    await run('EXCLUDE-1', 'getManifestExcludedProjectIds resolves a project-scoped exclusion via the target table\'s own name (zero-roster-dependency)', async () => {
      await tgt.query(`INSERT INTO migration_manifest (source_db, source_table, project_id_or_null, row_count, content_fingerprint, excluded_reason) VALUES ('src', 'widget', 'proj-excluded', 1, 'fp', 'eval-junk-project-id')`);
      try {
        const excluded = await migrate07.getManifestExcludedProjectIds(tgt, roster, 'widget');
        assert(excluded.has('proj-excluded'), `expected proj-excluded in exclusion set, got ${JSON.stringify([...excluded])}`);
      } finally {
        await tgt.query(`DELETE FROM migration_manifest WHERE source_table='widget' AND project_id_or_null='proj-excluded'`);
      }
    });
    await run('EXCLUDE-2', 'a manifest-excluded project_id with ZERO live target rows never becomes a candidate (the intended, coverage-intact production shape)', async () => {
      await tgt.query(`INSERT INTO migration_manifest (source_db, source_table, project_id_or_null, row_count, content_fingerprint, excluded_reason) VALUES ('src', 'widget', 'proj-excluded-clean', 0, 'fp', 'eval-junk-project-id')`);
      try {
        const ok = await migrate07.run(TARGET_DB, { rosterPath: ROSTER_PATH, transport: makeFakeTransport(NATIVE_DIMS), runId: crypto.randomUUID() });
        assert(ok === true, `expected run() to PASS (0 live rows under the excluded project_id -- preflight coverage genuinely intact), got ${ok}`);
        const { rows } = await tgt.query(`SELECT COUNT(*)::int AS n FROM widget WHERE project_id='proj-excluded-clean'`);
        assert(rows[0].n === 0, 'sanity: no row was ever inserted for this project_id');
      } finally {
        await tgt.query(`DELETE FROM migration_manifest WHERE source_table='widget' AND project_id_or_null='proj-excluded-clean'`);
      }
    });
    await run('EXCLUDE-3', 'G-R11 preflight correctly REFUSES the whole run when an excluded project_id has live rows anyway (a coverage violation -- e.g. a leak) -- G-R7\'s runtime filter is defense-in-depth for exactly this case, not the primary guarantee', async () => {
      await tgt.query(`INSERT INTO widget (project_id, blurb) VALUES ('proj-excluded-leak', 'should never have landed here')`);
      await tgt.query(`INSERT INTO migration_manifest (source_db, source_table, project_id_or_null, row_count, content_fingerprint, excluded_reason) VALUES ('src', 'widget', 'proj-excluded-leak', 1, 'fp', 'eval-junk-project-id')`);
      try {
        const ok = await migrate07.run(TARGET_DB, { rosterPath: ROSTER_PATH, transport: makeFakeTransport(NATIVE_DIMS), runId: crypto.randomUUID() });
        assert(ok === false, 'expected run() to REFUSE (preflight must catch a live row under a supposedly-excluded project_id)');
        const { rows } = await tgt.query(`SELECT embedding FROM widget WHERE project_id='proj-excluded-leak'`);
        assert(rows[0].embedding === null, 'expected the row to remain unembedded (the whole run refused before any embedding happened)');
      } finally {
        await tgt.query(`DELETE FROM migration_manifest WHERE source_table='widget' AND project_id_or_null='proj-excluded-leak'`);
        // Cleanup: delete the leaked fixture row so it never contaminates a
        // later test's run() candidate set now that the manifest exclusion
        // (and thus the preflight refusal) has been removed.
        await tgt.query(`DELETE FROM widget WHERE project_id = 'proj-excluded-leak'`);
      }
    });

    // ── DIM ASSERTION (G-R9) ───────────────────────────────────────────────
    await run('DIM-1', 'a provider returning the wrong vector length is a hard stop, never silently truncated/padded', async () => {
      await tgt.query(`INSERT INTO widget (project_id, blurb) VALUES ('proj-dim', 'dim mismatch fixture')`);
      const badTransport = async () => [1, 2]; // wrong length (native/stored both 8/4 here)
      await assertThrows(() => migrate07.run(TARGET_DB, { rosterPath: ROSTER_PATH,transport: badTransport, runId: crypto.randomUUID() }), 'DIM-MISMATCH');
      const { rows } = await tgt.query(`SELECT embedding FROM widget WHERE project_id='proj-dim'`);
      assert(rows[0].embedding === null, 'expected the row to remain unembedded after a dim-mismatch hard stop');
    });

  } finally {
    await tgt.end();
    await dropDb(TARGET_DB);
  }

  console.log(`test-migrate-07-reembed-corpus: ${passed} passed, ${failed} failed`);
  process.exitCode = failed > 0 ? 1 : 0;
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exitCode = 1;
});
