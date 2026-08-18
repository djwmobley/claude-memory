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
const { VllmHttpError } = require(path.join(PROJECT_ROOT, 'scripts', 'lib', 'embed.js'));

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

// ─── OL-8 FIXTURE: live-captured 400 body ──────────────────────────────────
//
// Verbatim from the spec-adversary pass's live probe against the real vLLM
// endpoint, 2026-08-18. DEVIATION (surfaced, never silent): the spec text
// this fixture is transcribed from is missing the outer object's closing
// brace (`...,"code":400}` with only ONE trailing `}, never two) -- a
// direct copy would not JSON.parse. Every character of the CONTENT is
// verbatim; the second closing brace is added here only to make the JSON
// structurally valid so isContextLengthError's JSON.parse(err.rawBody) can
// actually parse it, matching what the real endpoint returns (a
// well-formed JSON object).
const OVERLENGTH_400_BODY = JSON.stringify({
  error: {
    message: "This model's maximum context length is 8192 tokens. However, you requested 0 output tokens and your prompt contains at least 8193 input tokens, for a total of at least 8193 tokens. Please reduce the length of the input prompt or the number of requested output tokens. (parameter=input_tokens, value=8193)",
    type: 'BadRequestError',
    param: 'input_tokens',
    code: 400,
  },
});

/**
 * Transport that fails with the VERBATIM live-captured context-length 400
 * body (OL-8) whenever the input text is "too long" -- either unconditionally
 * (`alwaysFail`) or once its length exceeds `failThreshold`. `otherParam`
 * swaps in a structurally-similar-but-DIFFERENT-param 400 body (OL-2
 * negative case: a 400 that is NOT the context-length class).
 */
function makeOverlengthTransport(dims, { failThreshold = Infinity, alwaysFail = false, otherParam = false } = {}) {
  return async (text) => {
    const shouldFail = alwaysFail || text.length > failThreshold;
    if (!shouldFail) return deterministicVector(text, dims);
    const body = otherParam
      ? JSON.stringify({ error: { message: 'unsupported model parameter', type: 'BadRequestError', param: 'model', code: 400 } })
      : OVERLENGTH_400_BODY;
    throw new VllmHttpError(`[embed] vLLM returned HTTP 400: ${body.slice(0, 200)}`, 400, body);
  };
}

/** Simulated connection error (ECONNRESET) -- NOT a VllmHttpError, must still hard-stop (OL-2 negative case). */
function makeConnectionErrorTransport() {
  return async () => {
    throw new Error('[embed] vLLM network error (http://fake-endpoint.invalid): ECONNRESET');
  };
}

/** Runs `fn` with console.log captured (in addition to passing through), returns the captured lines. */
async function captureConsoleLog(fn) {
  const lines = [];
  const orig = console.log;
  console.log = (...args) => { lines.push(args.map(String).join(' ')); orig(...args); };
  try {
    const result = await fn();
    return { result, lines };
  } finally {
    console.log = orig;
  }
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

  // ── OL-2 MATCHER (pure unit, no DB) -- pinned structural classification ──
  await run('OL-MATCH-1', 'isContextLengthError: true for the exact matched shape (VllmHttpError, 400, error.param==="input_tokens")', () => {
    const err = new VllmHttpError('x', 400, OVERLENGTH_400_BODY);
    assert(migrate07.isContextLengthError(err) === true, 'expected true for the matched shape');
  });
  await run('OL-MATCH-2', 'isContextLengthError: false for a structurally similar 400 with a DIFFERENT param', () => {
    const body = JSON.stringify({ error: { message: 'x', type: 'BadRequestError', param: 'model', code: 400 } });
    const err = new VllmHttpError('x', 400, body);
    assert(migrate07.isContextLengthError(err) === false, 'expected false for a non-input_tokens param');
  });
  await run('OL-MATCH-3', 'isContextLengthError: false for a non-400 status code carrying the same body', () => {
    const err = new VllmHttpError('x', 503, OVERLENGTH_400_BODY);
    assert(migrate07.isContextLengthError(err) === false, 'expected false for a 503');
  });
  await run('OL-MATCH-4', 'isContextLengthError: false (never throws) for unparseable rawBody', () => {
    const err = new VllmHttpError('x', 400, 'not json{{{');
    assert(migrate07.isContextLengthError(err) === false, 'expected false, not a throw, for malformed JSON');
  });
  await run('OL-MATCH-5', 'isContextLengthError: false for a plain Error even if it spoofs a .statusCode property (instanceof gate, never duck-typed)', () => {
    const err = new Error('ECONNRESET');
    err.statusCode = 400;
    err.rawBody = OVERLENGTH_400_BODY;
    assert(migrate07.isContextLengthError(err) === false, 'expected false for a non-VllmHttpError instance');
  });

  // ── OL-4 HALVING RETRY (pure unit, fake provider, no DB) ─────────────────
  await run('OL-HALVE-1', 'embedWithHalvingRetry: halves progressively from the PREVIOUS attempt (not the original) and returns ok:true once under the fake threshold', async () => {
    const attemptedLengths = [];
    const provider = {
      embed: async (text) => {
        attemptedLengths.push(text.length);
        if (text.length > 3000) throw new VllmHttpError('x', 400, OVERLENGTH_400_BODY);
        return { vector: [0, 0, 0, 0] };
      },
    };
    const result = await migrate07.embedWithHalvingRetry(provider, 'E'.repeat(10000), () => {}, 'unit-test', 1);
    assert(result.ok === true, `expected ok:true, got ${JSON.stringify(result)}`);
    assert(JSON.stringify(attemptedLengths) === JSON.stringify([10000, 5000, 2500]), `expected attempt lengths [10000,5000,2500], got ${JSON.stringify(attemptedLengths)}`);
    assert(result.halvings === 2 && result.finalLength === 2500, `expected halvings=2 finalLength=2500, got ${JSON.stringify(result)}`);
  });
  await run('OL-HALVE-2', 'embedWithHalvingRetry: floors at HALVING_FLOOR_CHARS and returns ok:false after HALVING_MAX_ATTEMPTS', async () => {
    const provider = { embed: async () => { throw new VllmHttpError('x', 400, OVERLENGTH_400_BODY); } };
    const result = await migrate07.embedWithHalvingRetry(provider, 'F'.repeat(5000), () => {}, 'unit-test', 1);
    assert(result.ok === false, `expected ok:false, got ${JSON.stringify(result)}`);
    assert(result.halvings === migrate07.HALVING_MAX_ATTEMPTS, `expected halvings===HALVING_MAX_ATTEMPTS(${migrate07.HALVING_MAX_ATTEMPTS}), got ${result.halvings}`);
  });
  await run('OL-HALVE-3', 'embedWithHalvingRetry: a non-context-length error propagates immediately -- zero halving attempts', async () => {
    let calls = 0;
    const provider = { embed: async () => { calls++; throw new Error('SIMULATED-ECONNRESET'); } };
    await assertThrows(() => migrate07.embedWithHalvingRetry(provider, 'G'.repeat(5000), () => {}, 'unit-test', 1), 'SIMULATED-ECONNRESET');
    assert(calls === 1, `expected exactly 1 attempt (no halving retry for a non-matched error), got ${calls}`);
  });

  // ── OL-7 CARDINALITY ALARM (pure unit, no DB) -- pinned thresholds ───────
  await run('OL-CARD-1', 'evaluateCardinalityAlarm: total exempt-overlength > 20 FAILS even with no single table over the per-table ratio', () => {
    const report = [{ table: 't1', exemptOverlength: 11, candidates: 1000 }, { table: 't2', exemptOverlength: 10, candidates: 1000 }];
    const result = migrate07.evaluateCardinalityAlarm(report, () => {});
    assert(result.pass === false, 'expected FAIL (total=21>20)');
    assert(result.totalExemptOverlength === 21, `expected total=21, got ${result.totalExemptOverlength}`);
  });
  await run('OL-CARD-2', 'evaluateCardinalityAlarm: a single table over 5% FAILS even when the total is small', () => {
    const report = [{ table: 't1', exemptOverlength: 6, candidates: 100 }];
    const result = migrate07.evaluateCardinalityAlarm(report, () => {});
    assert(result.pass === false, 'expected FAIL (6/100=6%>5%)');
  });
  await run('OL-CARD-3', 'evaluateCardinalityAlarm: PASSES when both pinned thresholds are respected (5% exactly is not > 5%)', () => {
    const report = [{ table: 't1', exemptOverlength: 5, candidates: 100 }, { table: 't2', exemptOverlength: 0, candidates: 50 }];
    const result = migrate07.evaluateCardinalityAlarm(report, () => {});
    assert(result.pass === true, `expected PASS (5/100=5% is not >5%; total=5<=20), got ${JSON.stringify(result)}`);
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

    // ── G-R2 SAFETY: reproduces the independent review's blocking finding ──
    // (--dry-run performing the destructive ALTER, --rollback performing
    // forward DDL) as a regression fixture, THEN proves the fix. Uses a
    // THROWAWAY `memory_entries` table with ONE populated legacy-vector row
    // -- created and dropped entirely within this block, before ALTER-1..4
    // below creates the real (empty) fixture LEGACY_VECTOR_TABLES expects.
    await run('ALTER-SAFETY-1', 'dry-run REPORTS the G-R2 ALTER but performs zero DDL -- column type AND populated count unchanged', async () => {
      await tgt.query(`CREATE TABLE memory_entries (id SERIAL PRIMARY KEY, project_id TEXT, body TEXT, embedding vector(4))`);
      await tgt.query(`INSERT INTO memory_entries (project_id, body, embedding) VALUES ('proj-alter-safety', 'has a real vector', '[1,2,3,4]')`);

      const before = await migrate07.getFormatType(tgt, 'memory_entries', 'embedding');
      const { rows: beforeCount } = await tgt.query(`SELECT COUNT(*)::int AS n FROM memory_entries WHERE embedding IS NOT NULL`);
      assert(before === 'vector(4)' && beforeCount[0].n === 1, 'precondition: populated vector(4) column');

      const result = await migrate07.runAlterLegacyVectorColumn(tgt, 'memory_entries', () => {}, true /* dryRun */);
      assert(result.applied === false && result.dryRun === true && result.populatedCount === 1, `expected a dry-run report, got ${JSON.stringify(result)}`);

      const after = await migrate07.getFormatType(tgt, 'memory_entries', 'embedding');
      const { rows: afterCount } = await tgt.query(`SELECT COUNT(*)::int AS n FROM memory_entries WHERE embedding IS NOT NULL`);
      const { rows: value } = await tgt.query(`SELECT embedding::text AS v FROM memory_entries WHERE project_id='proj-alter-safety'`);
      assert(after === 'vector(4)', `expected column type UNCHANGED (vector(4)), got ${after}`);
      assert(afterCount[0].n === 1, `expected populated count UNCHANGED (1), got ${afterCount[0].n}`);
      assert(value[0].v === '[1,2,3,4]', `expected the stored vector value UNCHANGED, got ${value[0].v}`);
    });
    await run('ALTER-SAFETY-2', 'a real (non-dry-run) ALTER on a populated column is a loud refusal, never a silent USING NULL discard', async () => {
      const before = await migrate07.getFormatType(tgt, 'memory_entries', 'embedding');
      await assertThrows(() => migrate07.runAlterLegacyVectorColumn(tgt, 'memory_entries', () => {}, false), 'G-R2 SAFETY GUARD');
      const after = await migrate07.getFormatType(tgt, 'memory_entries', 'embedding');
      const { rows: value } = await tgt.query(`SELECT embedding::text AS v FROM memory_entries WHERE project_id='proj-alter-safety'`);
      assert(after === before && after === 'vector(4)', `expected column type UNCHANGED after refusal, before=${before} after=${after}`);
      assert(value[0].v === '[1,2,3,4]', `expected the stored vector value UNCHANGED after refusal, got ${value[0].v}`);
    });
    await run('ALTER-SAFETY-3', 'full run() with --dry-run never reaches the destructive ALTER (end-to-end reproduction of the reviewer\'s exact scenario)', async () => {
      const ok = await migrate07.run(TARGET_DB, { dryRun: true, rosterPath: ROSTER_PATH, transport: makeFakeTransport(NATIVE_DIMS) });
      assert(ok === true, 'expected the dry run itself to PASS (report-only, not a failure)');
      const after = await migrate07.getFormatType(tgt, 'memory_entries', 'embedding');
      const { rows: value } = await tgt.query(`SELECT embedding::text AS v FROM memory_entries WHERE project_id='proj-alter-safety'`);
      assert(after === 'vector(4)', `expected memory_entries.embedding UNCHANGED after a full --dry-run invocation, got ${after}`);
      assert(value[0].v === '[1,2,3,4]', `expected the stored vector value UNCHANGED after a full --dry-run invocation, got ${value[0].v}`);
    });
    await run('ALTER-SAFETY-4', 'full run() with --rollback never performs forward DDL (the ALTER loop sits below the rollback early-return)', async () => {
      // A run_id with zero batches -- a trivial, legitimate rollback no-op --
      // is enough to prove the ordering fix: if the ALTER loop still ran
      // above the rollback branch, memory_entries would be silently
      // converted to halfvec(4000) as a SIDE EFFECT of this call, discarding
      // the populated row. It must not be touched at all.
      const ok = await migrate07.run(TARGET_DB, { rollback: crypto.randomUUID(), rosterPath: ROSTER_PATH, transport: makeFakeTransport(NATIVE_DIMS) });
      assert(ok === true, 'expected the (no-op) rollback to PASS');
      const after = await migrate07.getFormatType(tgt, 'memory_entries', 'embedding');
      const { rows: value } = await tgt.query(`SELECT embedding::text AS v FROM memory_entries WHERE project_id='proj-alter-safety'`);
      assert(after === 'vector(4)', `expected memory_entries.embedding UNCHANGED after --rollback (no forward DDL), got ${after}`);
      assert(value[0].v === '[1,2,3,4]', `expected the stored vector value UNCHANGED after --rollback, got ${value[0].v}`);

      // Cleanup: drop this throwaway fixture so ALTER-1..4 below can create
      // the real (empty) memory_entries/memory_entry_chunks pair it expects.
      await tgt.query('DROP TABLE memory_entries');
    });

    // ── TOCTOU FIX: guard + ALTER in ONE transaction (structural proof) ──
    // A lightweight query-spy wrapping the real client: delegates every
    // query to the real connection (so behavior/correctness is exercised
    // for real) while recording each statement's first line so the test can
    // assert ORDERING and TRANSACTION BOUNDARIES. This is a structural
    // assertion, NOT a true concurrent-writer test -- see this suite's
    // header comment / the PR's blind-spots section for that honest limit:
    // nothing here proves a second, genuinely concurrent client is actually
    // blocked by the ACCESS EXCLUSIVE lock while it is held.
    function querySpy(realClient) {
      const calls = [];
      return {
        calls,
        client: {
          query: async (sql, params) => {
            calls.push(typeof sql === 'string' ? sql.trim().split('\n')[0].trim() : String(sql));
            return realClient.query(sql, params);
          },
          // Delegated, not spied on -- escapeLiteral is a pure local string
          // transform (no round trip), never a statement this spy needs to
          // record. Present so any future probe fixture that DOES touch a
          // commented view still works through this wrapper.
          escapeLiteral: (val) => realClient.escapeLiteral(val),
        },
      };
    }

    await run('ALTER-SAFETY-5', 'guard COUNT and ALTER run on the SAME client inside ONE open transaction (BEGIN -> LOCK -> COUNT -> ALTER -> COMMIT, in order)', async () => {
      await tgt.query(`CREATE TABLE alter_txn_probe (id SERIAL PRIMARY KEY, project_id TEXT, embedding vector(4))`);
      const { calls, client: spyClient } = querySpy(tgt);

      const result = await migrate07.runAlterLegacyVectorColumn(spyClient, 'alter_txn_probe', () => {}, false);
      assert(result.applied === true, `expected the ALTER to apply on an empty table, got ${JSON.stringify(result)}`);

      const idx = (re) => calls.findIndex((c) => re.test(c));
      const beginIdx = idx(/^BEGIN/i);
      const lockIdx = idx(/^LOCK TABLE/i);
      const countIdx = idx(/^SELECT COUNT\(\*\)/i);
      const alterIdx = idx(/^ALTER TABLE/i);
      const commitIdx = idx(/^COMMIT/i);
      assert([beginIdx, lockIdx, countIdx, alterIdx, commitIdx].every((i) => i !== -1), `expected all 5 statements to appear, got ${JSON.stringify(calls)}`);
      assert(beginIdx < lockIdx, `expected LOCK TABLE after BEGIN, got ${JSON.stringify(calls)}`);
      assert(lockIdx < countIdx, `expected the guard COUNT to run AFTER the lock is held (closes the TOCTOU window), got ${JSON.stringify(calls)}`);
      assert(countIdx < alterIdx, `expected the ALTER to run after the guard COUNT, got ${JSON.stringify(calls)}`);
      assert(alterIdx < commitIdx, `expected COMMIT after the ALTER, got ${JSON.stringify(calls)}`);
      // exactly ONE transaction bracket covering lock+count+alter (no
      // interleaved second BEGIN/COMMIT that would reopen the TOCTOU window)
      const secondBegin = calls.findIndex((c, i) => i > beginIdx && /^BEGIN/i.test(c));
      assert(secondBegin === -1, `expected exactly one BEGIN...COMMIT bracket, got ${JSON.stringify(calls)}`);

      await tgt.query('DROP TABLE alter_txn_probe');
    });
    await run('ALTER-SAFETY-6', 'refusal path ROLLBACKs the SAME transaction that held the lock; the ALTER itself never runs; column type unchanged', async () => {
      await tgt.query(`CREATE TABLE alter_txn_probe2 (id SERIAL PRIMARY KEY, project_id TEXT, embedding vector(4))`);
      await tgt.query(`INSERT INTO alter_txn_probe2 (project_id, embedding) VALUES ('p', '[1,2,3,4]')`);
      const { calls, client: spyClient } = querySpy(tgt);

      await assertThrows(() => migrate07.runAlterLegacyVectorColumn(spyClient, 'alter_txn_probe2', () => {}, false), 'G-R2 SAFETY GUARD');

      const idx = (re) => calls.findIndex((c) => re.test(c));
      const lockIdx = idx(/^LOCK TABLE/i);
      const rollbackIdx = idx(/^ROLLBACK/i);
      assert(lockIdx !== -1 && rollbackIdx !== -1 && lockIdx < rollbackIdx, `expected LOCK then ROLLBACK, got ${JSON.stringify(calls)}`);
      assert(idx(/^ALTER TABLE/i) === -1, `expected the ALTER to never run when the guard refuses, got ${JSON.stringify(calls)}`);

      const afterType = await migrate07.getFormatType(tgt, 'alter_txn_probe2', 'embedding');
      assert(afterType === 'vector(4)', `expected type UNCHANGED after refusal, got ${afterType}`);
      await tgt.query('DROP TABLE alter_txn_probe2');
    });
    await run('ALTER-SAFETY-7', 'dry-run NEVER takes the ACCESS EXCLUSIVE lock and NEVER opens a transaction', async () => {
      await tgt.query(`CREATE TABLE alter_txn_probe3 (id SERIAL PRIMARY KEY, project_id TEXT, embedding vector(4))`);
      const { calls, client: spyClient } = querySpy(tgt);

      await migrate07.runAlterLegacyVectorColumn(spyClient, 'alter_txn_probe3', () => {}, true /* dryRun */);

      assert(!calls.some((c) => /^BEGIN/i.test(c)), `expected NO BEGIN in dry-run mode, got ${JSON.stringify(calls)}`);
      assert(!calls.some((c) => /^LOCK TABLE/i.test(c)), `expected NO LOCK TABLE in dry-run mode, got ${JSON.stringify(calls)}`);
      assert(!calls.some((c) => /^ALTER TABLE/i.test(c)), `expected NO ALTER in dry-run mode, got ${JSON.stringify(calls)}`);
      await tgt.query('DROP TABLE alter_txn_probe3');
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
        -- Mirrors scripts/sql/v_memory_hits.sql's REAL shape: the view must
        -- SELECT the embedding column itself (not just other sibling
        -- columns) so pg_depend records a column-level dependency on
        -- memory_entry_chunks.embedding specifically -- getDependentViews()
        -- joins on a.attname = 'embedding'. A view that never selects
        -- embedding (the pre-fix vacuous fixture) is never returned by that
        -- query, so the DROP/recreate/comment-restore path never fires and
        -- this whole test would pass even with the COMMENT ON VIEW ... IS
        -- $1 syntax-error defect independent review #2 found live.
        CREATE VIEW v_memory_hits AS SELECT id AS chunk_id, entry_id, content, embedding FROM memory_entry_chunks;
        -- Single quote + embedded newline -- proves escapeLiteral's escaping,
        -- not just the happy path (independent review #2's explicit ask).
        COMMENT ON VIEW v_memory_hits IS 'it''s a test fixture comment
with an embedded newline -- must survive the escapeLiteral round-trip';
      `);

      const r1 = await migrate07.runAlterLegacyVectorColumn(tgt, 'memory_entries', () => {});
      assert(r1.applied === true, 'expected memory_entries ALTER to apply');
      const r2 = await migrate07.runAlterLegacyVectorColumn(tgt, 'memory_entry_chunks', () => {});
      assert(r2.applied === true, 'expected memory_entry_chunks ALTER to apply');

      const t1 = await migrate07.getFormatType(tgt, 'memory_entries', 'embedding');
      const t2 = await migrate07.getFormatType(tgt, 'memory_entry_chunks', 'embedding');
      assert(t1 === 'halfvec(4000)', `memory_entries.embedding expected halfvec(4000), got ${t1}`);
      assert(t2 === 'halfvec(4000)', `memory_entry_chunks.embedding expected halfvec(4000), got ${t2}`);

      // view preserved and queryable -- including its embedding column,
      // which is WHY this view was dropped/recreated at all (pg_depend).
      const { rows: viewRows } = await tgt.query(`SELECT chunk_id, entry_id, content, embedding FROM v_memory_hits`);
      assert(Array.isArray(viewRows), 'expected v_memory_hits to still be queryable post-ALTER, embedding column included');

      // non-blocking review item (c), re-fixed after independent review #2
      // found the original fix syntactically broken (`COMMENT ON VIEW ...
      // IS $1` -- bind params are not legal in utility statements) AND the
      // original fixture vacuous (its view never selected `embedding`, so
      // the DROP/recreate/comment-restore path never ran). This fixture's
      // view now selects `embedding` (exercising the real path) and its
      // comment carries a single quote + an embedded newline (exercising
      // escapeLiteral's escaping, not just a quote-free happy path).
      const EXPECTED_COMMENT = "it's a test fixture comment\nwith an embedded newline -- must survive the escapeLiteral round-trip";
      const { rows: commentRows } = await tgt.query(`SELECT obj_description('v_memory_hits'::regclass, 'pg_class') AS c`);
      assert(commentRows[0].c === EXPECTED_COMMENT, `expected the view comment (quote+newline intact) to be preserved, got ${JSON.stringify(commentRows[0].c)}`);

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

    // ── OL-1..OL-11: OVER-LENGTH EMBED INPUT (2026-08-18, mm#11(g) follow-up) ─
    // Full run()-through-DB integration proofs, on top of the pure-unit
    // OL-MATCH-*/OL-HALVE-*/OL-CARD-* tests above. `halvingDelayMs: 1`
    // throughout -- these tests override the real ~300ms HALVING_DELAY_MS
    // pacing (in-process-only injection, never expressible via argv,
    // mirroring transport/providerRow/runId) purely so this suite does not
    // take real wall-clock minutes; the pacing VALUE itself is asserted by
    // the module's exported HALVING_DELAY_MS constant, not re-timed here.

    await run('OL-1', 'halving converges after the pre-cap alone is insufficient; provenance (truncated_to_chars + halvings) written; row embedded', async () => {
      const bigText = 'A'.repeat(30000); // > EMBED_TEXT_CAP_CHARS(24000) -- pre-cap engages first
      await tgt.query(`INSERT INTO widget (project_id, blurb) VALUES ('proj-ol1', $1)`, [bigText]);
      const { result: ok, lines } = await captureConsoleLog(() => migrate07.run(TARGET_DB, {
        rosterPath: ROSTER_PATH,
        // capped text (24000) still fails; halves to 12000 (still fails); halves to 6000 (succeeds) -- halvings=2
        transport: makeOverlengthTransport(NATIVE_DIMS, { failThreshold: 10000 }),
        runId: crypto.randomUUID(),
        halvingDelayMs: 1,
      }));
      assert(ok === true, 'expected run() to PASS');
      const { rows } = await tgt.query(`SELECT id, embedding FROM widget WHERE project_id='proj-ol1'`);
      assert(rows[0].embedding !== null, 'expected the row embedded after halving converged');
      const { rows: logRows } = await tgt.query(`SELECT truncated_to_chars FROM embedding_write_log WHERE table_name='widget' AND row_pk_value=$1`, [JSON.stringify([rows[0].id])]);
      assert(logRows.length === 1, `expected exactly 1 write_log row, got ${logRows.length}`);
      assert(logRows[0].truncated_to_chars === 6000, `expected truncated_to_chars=6000 (24000 -> 12000 -> 6000), got ${logRows[0].truncated_to_chars}`);
      assert(lines.some((l) => l.includes('[EMBEDDED-TRUNCATED]') && l.includes('halvings=2') && l.includes('halving-triggered')), `expected an [EMBEDDED-TRUNCATED] halvings=2 halving-triggered log line, got:\n${lines.join('\n')}`);
      await tgt.query(`DELETE FROM widget WHERE project_id='proj-ol1'`);
    });

    await run('OL-2', 'pre-cap alone resolves an over-length row with zero halvings -- distinguished from halving-triggered', async () => {
      const bigText = 'B'.repeat(26000); // > cap, but the CAPPED (24000-char) text embeds on the first attempt
      await tgt.query(`INSERT INTO widget (project_id, blurb) VALUES ('proj-ol2', $1)`, [bigText]);
      const { result: ok, lines } = await captureConsoleLog(() => migrate07.run(TARGET_DB, {
        rosterPath: ROSTER_PATH,
        transport: makeOverlengthTransport(NATIVE_DIMS, { failThreshold: 25000 }),
        runId: crypto.randomUUID(),
        halvingDelayMs: 1,
      }));
      assert(ok === true, 'expected run() to PASS');
      const { rows } = await tgt.query(`SELECT id, embedding FROM widget WHERE project_id='proj-ol2'`);
      assert(rows[0].embedding !== null, 'expected the row embedded');
      const { rows: logRows } = await tgt.query(`SELECT truncated_to_chars FROM embedding_write_log WHERE table_name='widget' AND row_pk_value=$1`, [JSON.stringify([rows[0].id])]);
      assert(logRows[0].truncated_to_chars === 24000, `expected truncated_to_chars=24000 (pre-cap only), got ${logRows[0].truncated_to_chars}`);
      assert(lines.some((l) => l.includes('[EMBEDDED-TRUNCATED]') && l.includes('halvings=0') && l.includes('pre-cap-only')), `expected a pre-cap-only halvings=0 log line, got:\n${lines.join('\n')}`);
      await tgt.query(`DELETE FROM widget WHERE project_id='proj-ol2'`);
    });

    await run('OL-3', 'halving floor exhausted lands a row in exempt-overlength, never embedded -- overall run still PASSES when diluted below both cardinality thresholds', async () => {
      // 20 ordinary small rows + 1 always-over-threshold row => this
      // table's candidate pool is 21 when embedTable's SELECT runs; 1/21
      // ~= 4.8%, under the 5% per-table threshold, and 1 total is under
      // the 20 total threshold -- isolates "floor exhausted -> exempt-
      // overlength, row never embedded" from the SEPARATE cardinality-
      // alarm behavior, which OL-4 below tests directly.
      for (let i = 0; i < 20; i++) {
        await tgt.query(`INSERT INTO widget (project_id, blurb) VALUES ('proj-ol3', $1)`, [`small content ${i}`]);
      }
      await tgt.query(`INSERT INTO widget (project_id, blurb) VALUES ('proj-ol3', $1)`, ['H'.repeat(30000)]);
      const transport = makeOverlengthTransport(NATIVE_DIMS, { failThreshold: 500 }); // floor (1000) > 500 -- big row can never succeed
      const { result: ok, lines } = await captureConsoleLog(() => migrate07.run(TARGET_DB, {
        rosterPath: ROSTER_PATH, transport, runId: crypto.randomUUID(), halvingDelayMs: 1,
      }));
      assert(ok === true, `expected run() to PASS (1 exempt-overlength row diluted under both thresholds), got ${ok}`);
      const { rows } = await tgt.query(`SELECT embedding FROM widget WHERE project_id='proj-ol3' AND length(blurb) > 1000`);
      assert(rows.length === 1 && rows[0].embedding === null, 'expected the over-length row to remain unembedded (floor exhausted)');
      const { rows: smallRows } = await tgt.query(`SELECT COUNT(*)::int AS n FROM widget WHERE project_id='proj-ol3' AND length(blurb) <= 1000 AND embedding IS NOT NULL`);
      assert(smallRows[0].n === 20, `expected all 20 small rows embedded normally, got ${smallRows[0].n}`);
      assert(lines.some((l) => l.includes('[EXEMPT-OVERLENGTH]') && l.includes(`halvings=${migrate07.HALVING_MAX_ATTEMPTS}`)), `expected an [EXEMPT-OVERLENGTH] log line, got:\n${lines.join('\n')}`);
      await tgt.query(`DELETE FROM widget WHERE project_id='proj-ol3'`);
    });

    await run('OL-4', 'cardinality alarm trips when exempt-overlength exceeds 20 total -- migration FAILS, never passes-with-exemption', async () => {
      for (let i = 0; i < 25; i++) {
        await tgt.query(`INSERT INTO widget (project_id, blurb) VALUES ('proj-ol4', $1)`, [`I${i}`.repeat(6000)]);
      }
      const transport = makeOverlengthTransport(NATIVE_DIMS, { alwaysFail: true }); // simulated total provider outage for these rows
      const { result: ok, lines } = await captureConsoleLog(() => migrate07.run(TARGET_DB, {
        rosterPath: ROSTER_PATH, transport, runId: crypto.randomUUID(), halvingDelayMs: 1,
      }));
      assert(ok === false, 'expected run() to FAIL (25 exempt-overlength rows > CARDINALITY_TOTAL_MAX=20)');
      const { rows } = await tgt.query(`SELECT COUNT(*)::int AS n FROM widget WHERE project_id='proj-ol4' AND embedding IS NULL`);
      assert(rows[0].n === 25, `expected all 25 rows to remain unembedded, got ${rows[0].n}`);
      assert(lines.some((l) => l.includes('[CARDINALITY-ALARM]') && l.includes('total exempt-overlength=25')), `expected a [CARDINALITY-ALARM] total-exceeded log line, got:\n${lines.join('\n')}`);
      await tgt.query(`DELETE FROM widget WHERE project_id='proj-ol4'`);
    });

    await run('OL-5', 'a non-length 400 (different param) is NOT the context-length class -- immediate hard stop, G-R8 unchanged', async () => {
      await tgt.query(`INSERT INTO widget (project_id, blurb) VALUES ('proj-ol5', 'short content -- the fake transport always 400s with a different param regardless')`);
      const transport = makeOverlengthTransport(NATIVE_DIMS, { alwaysFail: true, otherParam: true });
      await assertThrows(() => migrate07.run(TARGET_DB, { rosterPath: ROSTER_PATH, transport, runId: crypto.randomUUID(), halvingDelayMs: 1 }), 'vLLM returned HTTP 400');
      const { rows } = await tgt.query(`SELECT embedding FROM widget WHERE project_id='proj-ol5'`);
      assert(rows[0].embedding === null, 'expected the row to remain unembedded after the hard stop');
      await tgt.query(`DELETE FROM widget WHERE project_id='proj-ol5'`);
    });

    await run('OL-6', 'a connection error (simulated ECONNRESET) is not a VllmHttpError -- immediate hard stop, G-R8 unchanged', async () => {
      await tgt.query(`INSERT INTO widget (project_id, blurb) VALUES ('proj-ol6', 'content')`);
      await assertThrows(() => migrate07.run(TARGET_DB, { rosterPath: ROSTER_PATH, transport: makeConnectionErrorTransport(), runId: crypto.randomUUID(), halvingDelayMs: 1 }), 'ECONNRESET');
      const { rows } = await tgt.query(`SELECT embedding FROM widget WHERE project_id='proj-ol6'`);
      assert(rows[0].embedding === null, 'expected the row to remain unembedded after the hard stop');
      await tgt.query(`DELETE FROM widget WHERE project_id='proj-ol6'`);
    });

    await run('OL-7', 'normal (short) content is embedded unchanged -- pre-cap/halving logic never engages, truncated_to_chars stays NULL', async () => {
      await tgt.query(`INSERT INTO widget (project_id, blurb) VALUES ('proj-ol7', 'a perfectly normal short row')`);
      const ok = await migrate07.run(TARGET_DB, { rosterPath: ROSTER_PATH, transport: makeFakeTransport(NATIVE_DIMS), runId: crypto.randomUUID(), halvingDelayMs: 1 });
      assert(ok === true, 'expected PASS');
      const { rows } = await tgt.query(`SELECT id, embedding FROM widget WHERE project_id='proj-ol7'`);
      assert(rows[0].embedding !== null, 'expected embedded');
      const { rows: logRows } = await tgt.query(`SELECT truncated_to_chars FROM embedding_write_log WHERE table_name='widget' AND row_pk_value=$1`, [JSON.stringify([rows[0].id])]);
      assert(logRows[0].truncated_to_chars === null, `expected truncated_to_chars NULL for a normal untouched row, got ${logRows[0].truncated_to_chars}`);
      await tgt.query(`DELETE FROM widget WHERE project_id='proj-ol7'`);
    });

    await run('OL-8', 'a resumed run does not re-embed an already embedded-truncated row (IS NULL gate, same as any other row)', async () => {
      const bigText = 'D'.repeat(30000);
      await tgt.query(`INSERT INTO widget (project_id, blurb) VALUES ('proj-ol8', $1)`, [bigText]);
      const transport = makeOverlengthTransport(NATIVE_DIMS, { failThreshold: 10000 });
      await migrate07.run(TARGET_DB, { rosterPath: ROSTER_PATH, transport, runId: crypto.randomUUID(), halvingDelayMs: 1 });
      const { rows: before } = await tgt.query(`SELECT id, embedding::text AS embedding FROM widget WHERE project_id='proj-ol8'`);
      assert(before[0].embedding !== null, 'precondition: row embedded (truncated)');
      const { rows: logBefore } = await tgt.query(`SELECT COUNT(*)::int AS n FROM embedding_write_log WHERE table_name='widget'`);

      const ok2 = await migrate07.run(TARGET_DB, { rosterPath: ROSTER_PATH, transport, runId: crypto.randomUUID(), halvingDelayMs: 1 });
      assert(ok2 === true, 'expected the resumed run to PASS as a no-op for this row');
      const { rows: after } = await tgt.query(`SELECT embedding::text AS embedding FROM widget WHERE project_id='proj-ol8'`);
      assert(after[0].embedding === before[0].embedding, 'expected the embedding UNCHANGED on resume (not re-embedded)');
      const { rows: logAfter } = await tgt.query(`SELECT COUNT(*)::int AS n FROM embedding_write_log WHERE table_name='widget'`);
      assert(logAfter[0].n === logBefore[0].n, `expected zero NEW write_log rows on resume, before=${logBefore[0].n} after=${logAfter[0].n}`);
      await tgt.query(`DELETE FROM widget WHERE project_id='proj-ol8'`);
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
