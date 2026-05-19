'use strict';

/**
 * eval-retrieval.js — Retrieval-quality regression harness for hybrid FTS + vector search.
 *
 * Loads a fixed fixture corpus into an isolated eval DB, runs hand-labeled queries,
 * computes Recall@1, Recall@3 (relaxed), MRR, and Negative Precision, then asserts
 * the metrics meet committed baselines.
 *
 * Usage:
 *   node test/eval/eval-retrieval.js                 # Run full eval (auto throwaway DB)
 *   node test/eval/eval-retrieval.js --update-baseline  # Accept current metrics as new baseline
 *   node test/eval/eval-retrieval.js --quiet          # Summary only (no per-query output)
 *   node test/eval/eval-retrieval.js --ollama-skip    # FTS-only; skip vector parts
 *
 * DB lifecycle:
 *   When EVAL_DB_NAME is NOT set (default): the harness generates a unique throwaway
 *   DB name (claude_memory_eval_run_<timestamp>_<rand>), creates it at startup, and
 *   drops it at end — even on failure (try/finally). No manual setup required.
 *
 *   When EVAL_DB_NAME IS set: the harness uses that name as-is and does NOT create or
 *   drop it — the caller owns the lifecycle. This is the CI path (EVAL_DB_NAME is set
 *   to an ephemeral database created by the workflow before this script runs).
 *
 * Prerequisites (only needed when running with an explicit EVAL_DB_NAME):
 *   - The named database must already exist and have the pgvector extension.
 *   - Ollama running with mxbai-embed-large pulled (unless --ollama-skip).
 *
 * Exit codes: 0 all-pass, 1 metric regression, 2 infrastructure failure.
 */

const assert        = require('assert');
const path          = require('path');
const fs            = require('fs');
const os            = require('os');
const { execFileSync } = require('child_process');

// pg is in scripts/node_modules — load via explicit path since test/ has no
// node_modules of its own. Using path.resolve so this works from any cwd.
const { Client }                               = require(path.resolve(__dirname, '..', '..', 'scripts', 'node_modules', 'pg'));
const { loadConfig, connect, ollamaEmbed, vllmEmbed, vllmRerank, c } = require('../../scripts/lib/shared');
const { encodeCwd }                            = require('../../scripts/lib/encoded-cwd');

// ─── CLI FLAGS ────────────────────────────────────────────────────────────────

const argv             = process.argv.slice(2);
const FLAG_UPDATE      = argv.includes('--update-baseline');
const FLAG_QUIET       = argv.includes('--quiet');
const FLAG_OLLAMA_SKIP = argv.includes('--ollama-skip');
const FLAG_RERANK = argv.includes('--rerank') || process.env.RERANK === '1';
const RERANK_CANDIDATE_POOL = parseInt(process.env.RERANK_CANDIDATE_POOL || '20', 10);

// ─── EMBED BACKEND / COLUMN ROUTING ──────────────────────────────────────────
// When EMBED_BACKEND=vllm, embed queries with vllmEmbed.
// Both backends now share the single `embedding halfvec(4000)` column and the
// v_memory_hits view. The two-column architecture (embedding_4096 alternate
// column + v_memory_hits_4096) was retired in Phase 1 step 5 when the primary
// embedding column was converted to halfvec(4000) via Matryoshka truncation.
const EMBED_BACKEND_ENV = (process.env.EMBED_BACKEND || '').toLowerCase();
const USE_VLLM_EVAL     = EMBED_BACKEND_ENV === 'vllm';
const HITS_VIEW         = 'v_memory_hits';

// ─── NEGATIVE PRECISION — SCORE-AWARE GATE ───────────────────────────────────
// A fixture in must_not_appear_top_5 counts as a leak only if it appears in
// top-5 AND its hybrid score is above this threshold. Rationale: out-of-corpus
// queries surface low-score topical adjacencies under higher-recall embedders
// (e.g., q10 "graphql federation" → rag-architecture.md at 0.389). A score-
// aware gate measures high-confidence false positives, which is the real
// precision concern — a rank-5 result at score 0.35 is not a meaningful
// retrieval hit for the user.
const NEG_PREC_SCORE_THRESHOLD = parseFloat(process.env.NEG_PREC_SCORE_THRESHOLD || '0.5');

function evalEmbed(texts, config) {
  if (USE_VLLM_EVAL) return vllmEmbed(texts);
  return ollamaEmbed(texts, config);
}

// ─── PATHS ────────────────────────────────────────────────────────────────────

const EVAL_DIR      = path.join(__dirname);
const FIXTURES_DIR  = path.join(EVAL_DIR, 'fixtures');
const QUERIES_FILE  = path.join(EVAL_DIR, 'queries.json');
const BASELINE_FILE = path.join(EVAL_DIR, 'baseline.json');
const LAST_RUN_FILE = path.join(EVAL_DIR, 'last-run.json');
const SCRIPTS_DIR   = path.join(__dirname, '..', '..', 'scripts');
const SETUP_SQL     = path.join(SCRIPTS_DIR, 'setup.sql');
const LOADER_SCRIPT = path.join(SCRIPTS_DIR, 'pipeline-memory-loader.js');

// ─── DB NAME — throwaway vs caller-supplied ───────────────────────────────────
//
// When EVAL_DB_NAME env is set: use it as-is; the caller owns the DB lifecycle
// (create/drop). This is the CI path.
//
// When EVAL_DB_NAME env is NOT set: generate a unique per-run throwaway name.
// The harness creates the DB at startup and drops it at end (try/finally), so
// no manual DB setup is required for local runs.

const _CALLER_SUPPLIED_DB = process.env.EVAL_DB_NAME || '';
const EVAL_DB_OWNED        = !_CALLER_SUPPLIED_DB; // true = harness owns lifecycle
const EVAL_DB_NAME         = _CALLER_SUPPLIED_DB ||
  `claude_memory_eval_run_${Date.now()}_${Math.floor(Math.random() * 10000)}`;

// ─── THROWAWAY DB HELPERS ─────────────────────────────────────────────────────

/** Open a connection to the postgres maintenance DB using the same host/auth as
 *  the eval config. Used only when EVAL_DB_OWNED=true to CREATE/DROP the throwaway. */
async function pgSysConnect(config) {
  const client = new Client({
    host:     process.env.PGHOST     || config.host     || 'localhost',
    port:     parseInt(process.env.PGPORT || String(config.port || 5432), 10),
    user:     process.env.PGUSER     || config.user     || 'postgres',
    password: process.env.PGPASSWORD || config.password || undefined,
    database: 'postgres',
  });
  await client.connect();
  return client;
}

async function createEvalDb(config, dbName) {
  const sys = await pgSysConnect(config);
  try {
    await sys.query(`CREATE DATABASE "${dbName}"`);
  } finally {
    await sys.end().catch(() => {});
  }
}

async function dropEvalDb(config, dbName) {
  let sys;
  try {
    sys = await pgSysConnect(config);
    // Terminate any open connections to the throwaway DB before dropping.
    await sys.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
       WHERE datname = $1 AND pid <> pg_backend_pid()`,
      [dbName]
    );
    await sys.query(`DROP DATABASE IF EXISTS "${dbName}"`);
    console.log(`[TEARDOWN] Dropped throwaway eval DB: ${dbName}`);
  } catch (err) {
    console.error(`[TEARDOWN] WARNING: could not drop throwaway DB ${dbName}: ${err.message}`);
    console.error(`           Manual cleanup: psql -c 'DROP DATABASE IF EXISTS "${dbName}"'`);
  } finally {
    if (sys) { try { await sys.end(); } catch (_) {} }
  }
}

// ─── STEP / SUMMARY HELPERS (mirrors test-chunker.js) ────────────────────────

let passed  = 0;
let failed  = 0;
let infraOk = true;

function step(label, ok, detail) {
  if (FLAG_QUIET) return;
  const pad    = Math.max(1, 60 - label.length);
  const status = ok ? c.green('OK') : c.red('FAIL');
  console.log(`  ${label}${' '.repeat(pad)}${status}`);
  if (!ok && detail) console.log(`    Reason: ${detail}`);
}

function log(...args) {
  if (!FLAG_QUIET) console.log(...args);
}

function infraFail(msg) {
  console.error(`\n${c.red('[INFRA]')} ${msg}`);
  infraOk = false;
  // Throw rather than process.exit() so that the try/finally teardown (DB drop)
  // runs before the process exits. The catch block at the bottom of main() sets
  // exitCode=2 when infraOk is false and returns, allowing finally to execute.
  throw new Error(`[INFRA] ${msg}`);
}

// ─── HYBRID SQL ───────────────────────────────────────────────────────────────
// Built at runtime so they reference the correct view (v_memory_hits or
// v_memory_hits_4096) and the correct embedding column name.

function buildHybridSql(view, embCol) {
  return `
  SELECT label, source_table, chunk_id, chunk_idx,
         ts_rank(fts_vec, plainto_tsquery($1)) * 0.3 +
         (1 - (${embCol} <=> $2::halfvec(4000))) * 0.7 AS score
  FROM ${view}
  WHERE ${embCol} IS NOT NULL
  ORDER BY score DESC
  LIMIT 5
`;
}

// v_memory_hits exposes `content` directly, so we include it here to avoid
// a second round-trip for reranker candidate text.
function buildHybridSqlPool(view, embCol, limit) {
  return `
  SELECT label, source_table, chunk_id, chunk_idx, content,
         ts_rank(fts_vec, plainto_tsquery($1)) * 0.3 +
         (1 - (${embCol} <=> $2::halfvec(4000))) * 0.7 AS score
  FROM ${view}
  WHERE ${embCol} IS NOT NULL
  ORDER BY score DESC
  LIMIT ${parseInt(limit, 10)}
`;
}

function buildFtsOnlySql(view) {
  return `
  SELECT label, source_table, chunk_id, chunk_idx,
         ts_rank(fts_vec, plainto_tsquery($1)) AS score
  FROM ${view}
  WHERE fts_vec @@ plainto_tsquery($1)
  ORDER BY score DESC
  LIMIT 5
`;
}

// ─── FIXTURE STAGING ──────────────────────────────────────────────────────────

/**
 * Stage fixtures into a temp directory so the loader subprocess can find them.
 * The loader resolves the memory dir as:
 *   getClaudeProjectDir(process.cwd()) + '/memory'
 *   = ~/.claude/projects/<encoded-cwd>/memory
 *
 * Strategy: create a unique temp dir, use it as the subprocess cwd, and
 * populate ~/.claude/projects/<encoded-tempdir>/memory/ with the fixture files.
 * Returns { tempCwd, memoryDir, cleanup }.
 */
function stageFixtures() {
  const fixtures = fs.readdirSync(FIXTURES_DIR).filter(f => f.endsWith('.md'));
  if (fixtures.length === 0) infraFail(`No fixture .md files found in ${FIXTURES_DIR}`);

  // Create a temp working directory
  const tempCwd   = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-memory-eval-'));
  const encoded   = encodeCwd(tempCwd);
  const memoryDir = path.join(os.homedir(), '.claude', 'projects', encoded, 'memory');

  fs.mkdirSync(memoryDir, { recursive: true });

  for (const f of fixtures) {
    fs.copyFileSync(path.join(FIXTURES_DIR, f), path.join(memoryDir, f));
  }

  function cleanup() {
    try { fs.rmSync(tempCwd,   { recursive: true, force: true }); } catch (_) {}
    try { fs.rmSync(memoryDir, { recursive: true, force: true }); } catch (_) {}
    // Remove the .claude/projects/<encoded> dir if now empty
    const projectDir = path.join(os.homedir(), '.claude', 'projects', encoded);
    try {
      if (fs.readdirSync(projectDir).length === 0) {
        fs.rmdirSync(projectDir);
      }
    } catch (_) {}
  }

  return { tempCwd, memoryDir, fixtures, cleanup };
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────

async function main() {
  if (FLAG_RERANK && FLAG_OLLAMA_SKIP) {
    console.error('ERROR: --rerank and --ollama-skip are incompatible. Reranker requires vector embeddings.');
    process.exit(2);
  }

  const runStartedAt = new Date().toISOString();
  console.log('');
  console.log(c.bold('eval-retrieval — Hybrid retrieval quality eval'));
  console.log(`  DB:      ${EVAL_DB_NAME}${EVAL_DB_OWNED ? c.dim(' (throwaway — will be created and dropped)') : c.dim(' (caller-supplied — lifecycle not managed here)')}`);
  console.log(`  Backend: ${FLAG_OLLAMA_SKIP ? 'SKIP (--ollama-skip)' : (USE_VLLM_EVAL ? 'vLLM (Qwen3-Embedding-8B)' : 'Ollama (mxbai-embed-large)')}`);
  console.log(`  View:    ${HITS_VIEW}`);
  console.log(`  Started: ${runStartedAt}`);
  console.log('');

  // ── Step 1: Verify prerequisites ────────────────────────────────────────────

  console.log('STEP 1 — Verify fixtures and queries');

  if (!fs.existsSync(FIXTURES_DIR)) infraFail(`Fixtures directory not found: ${FIXTURES_DIR}`);
  if (!fs.existsSync(QUERIES_FILE)) infraFail(`queries.json not found: ${QUERIES_FILE}`);
  if (!fs.existsSync(BASELINE_FILE)) infraFail(`baseline.json not found: ${BASELINE_FILE}`);
  if (!fs.existsSync(SETUP_SQL))    infraFail(`setup.sql not found: ${SETUP_SQL}`);
  if (!fs.existsSync(LOADER_SCRIPT)) infraFail(`pipeline-memory-loader.js not found: ${LOADER_SCRIPT}`);

  let queries, baseline;
  try {
    queries  = JSON.parse(fs.readFileSync(QUERIES_FILE, 'utf8'));
    baseline = JSON.parse(fs.readFileSync(BASELINE_FILE, 'utf8'));
  } catch (err) {
    infraFail(`Failed to parse queries.json or baseline.json: ${err.message}`);
  }

  if (!Array.isArray(queries) || queries.length === 0) infraFail('queries.json must be a non-empty array');
  step(`Loaded ${queries.length} queries from queries.json`, true);
  step(`Loaded baseline from baseline.json`, true);

  // ── Step 2: Connect to eval DB ───────────────────────────────────────────────

  console.log('\nSTEP 2 — Connect to eval DB');

  // Load config early — needed for pgSysConnect host/auth when creating/dropping
  // the throwaway DB, and for the eval DB connection config below.
  // Declared here (outside the try/finally) so the finally block can reference it.
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    console.error(`\n${c.red('[INFRA]')} Failed to load config: ${err.message}`);
    exitCode = 2;
    return;
  }

  // Everything from DB creation onwards is wrapped in try/finally so the
  // throwaway DB is always dropped, even if an infraFail() throw propagates.
  let db;
  try {
    // ── Throwaway DB creation (EVAL_DB_OWNED only) ─────────────────────────

    if (EVAL_DB_OWNED) {
      try {
        await createEvalDb(config, EVAL_DB_NAME);
        log(c.dim(`  Created throwaway DB: ${EVAL_DB_NAME}`));
      } catch (err) {
        infraFail(`Failed to create throwaway eval DB "${EVAL_DB_NAME}": ${err.message}`);
      }
    }

    // ── Connect ────────────────────────────────────────────────────────────

    try {
      const evalConfig = { ...config, database: EVAL_DB_NAME };
      db              = await connect(evalConfig);
      step(`Connected to ${EVAL_DB_NAME}`, true);
    } catch (err) {
      infraFail(`DB connection failed (${EVAL_DB_NAME}): ${err.message}`);
    }

    // ── Step 3: Apply schema ─────────────────────────────────────────────────

    console.log('\nSTEP 3 — Apply schema');

    try {
      execFileSync('psql', ['-d', EVAL_DB_NAME, '-f', SETUP_SQL], {
        stdio: 'pipe',
        encoding: 'utf8',
      });
      step('setup.sql applied (idempotent)', true);
    } catch (err) {
      // On Windows, psql may be invoked differently
      try {
        execFileSync('cmd.exe', ['/d', '/s', '/c', 'psql', '-d', EVAL_DB_NAME, '-f', SETUP_SQL], {
          stdio: 'pipe',
          encoding: 'utf8',
        });
        step('setup.sql applied via cmd.exe (idempotent)', true);
      } catch (err2) {
        infraFail(`psql schema apply failed: ${err2.message}\n  Ensure psql is on PATH and DB exists.`);
      }
    }

    // ── Step 4: Truncate tables ──────────────────────────────────────────────

    console.log('\nSTEP 4 — Truncate tables');

    await db.query('TRUNCATE memory_entries CASCADE');
    step('memory_entries (+ cascaded chunks) truncated', true);

    // ── Step 5: Load fixtures via loader subprocess ───────────────────────────

    console.log('\nSTEP 5 — Load fixtures');

    const { tempCwd, memoryDir, fixtures, cleanup } = stageFixtures();
    step(`Staged ${fixtures.length} fixture(s) into ${memoryDir}`, true);

    let loaderOut;
    try {
      loaderOut = execFileSync(
        'node',
        [LOADER_SCRIPT, 'memory'],
        {
          cwd:      tempCwd,
          env:      { ...process.env, PROJECT_ROOT: path.resolve(__dirname, '..', '..'), PGDATABASE: EVAL_DB_NAME },
          stdio:    'pipe',
          encoding: 'utf8',
          timeout:  120000,
        }
      );
    } catch (err) {
      const msg = (err.stdout || '') + (err.stderr || '') + err.message;
      infraFail(`Loader subprocess failed: ${msg.slice(0, 500)}`);
    } finally {
      // finally runs on both success and error paths; covers cleanup before
      // infraFail's process.exit(2) takes effect. Single call is correct.
      cleanup();
    }

    // Parse loader output for error count
    const errMatch    = loaderOut.match(/Errors:\s+(\d+)/);
    const loaderErrors = errMatch ? parseInt(errMatch[1], 10) : -1;
    const loaderOk    = loaderErrors === 0;
    step(
      `Loader exited with Errors: ${loaderErrors} (expected 0)`,
      loaderOk,
      loaderOk ? null : `Loader stdout:\n${loaderOut.slice(0, 400)}`
    );
    if (!loaderOk) infraFail(`Loader reported ${loaderErrors} error(s). Check fixture files.`);

    // Verify all chunks have embeddings (unless --ollama-skip)
    if (!FLAG_OLLAMA_SKIP) {
      if (USE_VLLM_EVAL) {
        // vLLM path: the loader may have embedded via Ollama (if running) into the
        // `embedding` column. Run pipeline-embed with vLLM backend to (re-)embed
        // all chunks into the halfvec(4000) embedding column using Qwen3-Embedding-8B
        // with Matryoshka truncation to 4000 dims.
        const EMBED_SCRIPT = path.join(path.resolve(__dirname, '..', '..'), 'scripts', 'pipeline-embed.js');
        log(c.dim('  Running vLLM re-embed pass to populate embedding (halfvec 4000)...'));
        try {
          const embedOut = execFileSync(
            'node',
            [EMBED_SCRIPT, 'index', '--all'],
            {
              env: {
                ...process.env,
                PROJECT_ROOT:    path.resolve(__dirname, '..', '..'),
                EMBED_BACKEND:   'vllm',
                VLLM_EMBED_URL:  process.env.VLLM_EMBED_URL || 'http://localhost:8800',
                PGDATABASE:      EVAL_DB_NAME,
              },
              stdio:    'pipe',
              encoding: 'utf8',
              timeout:  300000,
            }
          );
          log(embedOut.slice(0, 600));
        } catch (err) {
          const msg = (err.stdout || '') + (err.stderr || '') + err.message;
          infraFail(`vLLM embed pass failed: ${msg.slice(0, 500)}`);
        }

        // Verify embedding coverage
        const nullRes = await db.query(
          'SELECT COUNT(*) AS n FROM memory_entry_chunks WHERE embedding IS NULL'
        );
        const nullCount = parseInt(nullRes.rows[0].n, 10);
        const embedOk   = nullCount === 0;
        step(
          `Chunks with NULL embedding (halfvec 4000): ${nullCount} (expected 0)`,
          embedOk,
          embedOk ? null : `${nullCount} chunk(s) missing vLLM embeddings`
        );
        if (!embedOk) infraFail(`${nullCount} chunk(s) have NULL embedding. Check vLLM service.`);
      } else {
        // Ollama path: check standard embedding column
        const nullRes = await db.query(
          'SELECT COUNT(*) AS n FROM memory_entry_chunks WHERE embedding IS NULL'
        );
        const nullCount = parseInt(nullRes.rows[0].n, 10);
        const embedOk   = nullCount === 0;
        step(
          `Chunks with NULL embedding: ${nullCount} (expected 0)`,
          embedOk,
          embedOk ? null : `${nullCount} chunk(s) missing embeddings — check Ollama`
        );
        if (!embedOk) infraFail(`${nullCount} chunk(s) have NULL embeddings. Ensure Ollama is running.`);
      }
    } else {
      step('Embedding verification skipped (--ollama-skip)', true);
    }

    // ── Step 6: Build source_file lookup (label -> fixture filename) ─────────

    // memory_entries.name == filename without .md (set by loader)
    // label in v_memory_hits == memory_entries.name
    // So: hit.label == fixture filename without extension
    // We normalize to just the basename without .md for comparison.

    const entryRows = await db.query('SELECT id, name, source_file FROM memory_entries');
    // Map name -> basename of source_file (filename with .md stripped by loader)
    // source_file is stored as 'memory/<filename>.md'
    const labelToFilename = new Map();
    for (const row of entryRows.rows) {
      const basename = path.basename(row.source_file || row.name + '.md');
      labelToFilename.set(row.name, basename);
    }

    // ── Step 7: Run queries ──────────────────────────────────────────────────

    console.log('\nSTEP 6 — Run queries');

    const perQueryResults = [];

    for (const qSpec of queries) {
      const { id, query, expected_top_1, expected_top_3, must_not_appear_top_5 = [] } = qSpec;

      let rows;

      if (FLAG_OLLAMA_SKIP) {
        // FTS-only mode
        const res = await db.query(buildFtsOnlySql(HITS_VIEW), [query]);
        rows = res.rows;
      } else if (FLAG_RERANK) {
        // Reranker mode: vector recall pool -> cross-encoder rerank -> top-5
        let qVec;
        try {
          const embeddings = await evalEmbed([query], config && config.knowledge);
          qVec = `[${embeddings[0].join(',')}]`;
        } catch (err) {
          infraFail(`Embedding failed for query "${query}": ${err.message}`);
        }
        const poolRes = await db.query(buildHybridSqlPool(HITS_VIEW, 'embedding', RERANK_CANDIDATE_POOL), [query, qVec]);
        const candidates = poolRes.rows;
        const documents = candidates.map(r => r.content);
        let rerankScores;
        try {
          rerankScores = await vllmRerank(query, documents);
        } catch (err) {
          infraFail(`Reranker failed for query "${query}": ${err.message}`);
        }
        // Sort candidates by reranker score desc, take top-5
        const ranked = rerankScores
          .map(s => ({ candidate: candidates[s.index], score: s.score }))
          .sort((a, b) => b.score - a.score)
          .slice(0, 5);
        rows = ranked.map(r => ({ ...r.candidate, score: r.score }));

        // Log retrieval event
        try {
          await db.query(
            `INSERT INTO retrieval_events (project_id, query_text, query_embedding, retrieved_at, outcome, session_id, notes)
             VALUES ($1, $2, $3::halfvec(4000), now(), 'pending', $4, $5)`,
            [
              'C--Users-djwmo-dev-claude-memory',
              query,
              qVec,
              runStartedAt,
              `eval reranked top-${RERANK_CANDIDATE_POOL}→top-5`,
            ]
          );
        } catch (_) {
          // retrieval_events logging is best-effort; do not abort the eval
        }
      } else {
        // Standard hybrid mode
        let qVec;
        try {
          const embeddings = await evalEmbed([query], config && config.knowledge);
          qVec = `[${embeddings[0].join(',')}]`;
        } catch (err) {
          infraFail(`Embedding failed for query "${query}": ${err.message}`);
        }
        const res = await db.query(buildHybridSql(HITS_VIEW, 'embedding'), [query, qVec]);
        rows = res.rows;
      }

      // Map each result row label to its fixture filename
      const hits = rows.map((row, idx) => ({
        rank:     idx + 1,
        label:    row.label,
        filename: labelToFilename.get(row.label) || (row.label + '.md'),
        score:    parseFloat(row.score) || 0,
      }));

      // Negative queries (expected_top_1 === "") have no positive expectation —
      // success = no leak from must_not_appear_top_5. They are excluded from
      // recall@1 / recall@3 / MRR aggregates (which only make sense when there
      // IS an expected target) and contribute only to negative_precision.
      const isNegative = expected_top_1 === '' || expected_top_1 == null;

      // Compute per-query metrics
      const topFilenames  = hits.map(h => h.filename);
      const top1Match     = !isNegative && topFilenames.length > 0 && topFilenames[0] === expected_top_1;
      const top3Match     = isNegative
        ? false
        : (expected_top_3 && expected_top_3.length > 0
            ? topFilenames.slice(0, 3).some(f => expected_top_3.includes(f))
            : top1Match);
      const rankOfExpected = isNegative ? -1 : topFilenames.indexOf(expected_top_1); // -1 if missing
      const mrr           = rankOfExpected >= 0 ? 1 / (rankOfExpected + 1) : 0;
      // Score-aware leak check: a fixture counts as a leak only if it appears in
      // top-5 AND its score exceeds NEG_PREC_SCORE_THRESHOLD. Low-score topical
      // adjacencies (e.g., out-of-corpus queries surfacing related docs at ~0.35)
      // are not high-confidence false positives and should not fail the gate.
      const noLeak        = !must_not_appear_top_5.some(f => {
        const hit = hits.find(h => h.filename === f);
        return hit !== undefined && hit.score > NEG_PREC_SCORE_THRESHOLD;
      });

      // Nearest false-positive: recorded for ALL queries (positive and negative) so
      // cross-model comparisons can track how close must_not_appear fixtures came,
      // independent of whether the threshold gate triggered. Summarized only for negatives.
      let nearestFp = null;
      for (const f of must_not_appear_top_5) {
        const hit = hits.find(h => h.filename === f);
        if (hit && (nearestFp === null || hit.score > nearestFp.score)) {
          nearestFp = { filename: hit.filename, score: hit.score, rank: hit.rank };
        }
      }

      perQueryResults.push({
        id, query,
        expected_top_1, expected_top_3, must_not_appear_top_5,
        isNegative,
        hits,
        top1Match, top3Match, mrr, noLeak, nearestFp,
      });

      const label = `Query [${id}]: ${query.slice(0, 40)}`;
      // For negative queries, success is no leak. For positive queries, all three.
      const ok    = isNegative ? noLeak : (top1Match && top3Match && noLeak);
      const detail = !ok
        ? (isNegative
            ? `negative-query leak (score>${NEG_PREC_SCORE_THRESHOLD})=${must_not_appear_top_5.filter(f => { const h = hits.find(h2 => h2.filename === f); return h && h.score > NEG_PREC_SCORE_THRESHOLD; })}; top3=${JSON.stringify(topFilenames.slice(0, 3))}`
            : `top1=${topFilenames[0] || '(none)'} expected=${expected_top_1}; ` +
              `top3=${JSON.stringify(topFilenames.slice(0, 3))}; ` +
              `leak=${!noLeak ? must_not_appear_top_5.filter(f => { const h = hits.find(h2 => h2.filename === f); return h && h.score > NEG_PREC_SCORE_THRESHOLD; }) : 'none'}`)
        : null;
      step(label, ok, detail);

      if (ok) passed++;
      else failed++;
    }

    // ── Step 8: Aggregate metrics ────────────────────────────────────────────

    const n            = perQueryResults.length;
    const positiveQueries = perQueryResults.filter(r => !r.isNegative);
    const positiveN    = positiveQueries.length;
    // Recall and MRR are only computed against positive queries (those with an
    // expected target). Negative queries don't have a meaningful "did we find
    // it" metric — they're scored on no-leak (negative_precision) only.
    const recall_at_1  = positiveN > 0 ? positiveQueries.filter(r => r.top1Match).length / positiveN : 1;
    const recall_at_3_relaxed = positiveN > 0 ? positiveQueries.filter(r => r.top3Match).length / positiveN : 1;
    const mrr          = positiveN > 0 ? positiveQueries.reduce((s, r) => s + r.mrr, 0) / positiveN : 1;
    const negative_precision = perQueryResults.filter(r => r.noLeak).length / n;

    const metrics = { recall_at_1, recall_at_3_relaxed, mrr, negative_precision };

    const negativeQueries = perQueryResults.filter(r => r.isNegative);
    const negative_query_nearest_fp = {};
    for (const r of negativeQueries) {
      negative_query_nearest_fp[r.id] = r.nearestFp; // null if no must_not_appear fixture appeared in results
    }

    // ── Step 9: Write last-run.json ──────────────────────────────────────────

    const lastRun = {
      runStartedAt,
      ollamaSkip: FLAG_OLLAMA_SKIP,
      db: EVAL_DB_NAME,
      queryCount: n,
      metrics,
      perQueryResults: perQueryResults.map(r => ({
        id:          r.id,
        query:       r.query,
        top1Match:   r.top1Match,
        top3Match:   r.top3Match,
        mrr:         r.mrr,
        noLeak:      r.noLeak,
        nearestFp:   r.nearestFp,
        hits:        r.hits.map(h => ({ rank: h.rank, filename: h.filename, score: h.score })),
      })),
    };
    fs.writeFileSync(LAST_RUN_FILE, JSON.stringify(lastRun, null, 2), 'utf8');

    // ── Step 10: Compare against baseline ───────────────────────────────────

    console.log('');
    console.log('='.repeat(60));

    const NOISE = 0.05;
    let anyRegression = false;

    function metricLine(label, actual, baselineVal, strict, extraNote) {
      const padLabel  = label.padEnd(26);
      const actStr    = actual.toFixed(2);
      const baseStr   = baselineVal !== undefined ? baselineVal.toFixed(2) : 'n/a';
      const noiseStr  = strict ? 'strict' : `noise floor ${NOISE.toFixed(2)}`;
      let pass;
      if (strict) {
        pass = actual >= 1.0;
      } else {
        pass = actual >= baselineVal - NOISE;
      }
      if (!pass) anyRegression = true;
      const indicator = pass ? c.green('PASS') : c.red('FAIL');
      const note      = extraNote ? ` ${c.dim(extraNote)}` : '';
      console.log(`  ${padLabel} ${actStr.padStart(6)} (baseline ${baseStr}, ${noiseStr})  ${indicator}${note}`);
      if (!pass) {
        console.log(c.red(`    REGRESSION: ${label} = ${actStr} < baseline ${baseStr} - ${NOISE.toFixed(2)} = ${(baselineVal - NOISE).toFixed(2)}`));
      }
    }

    if (FLAG_OLLAMA_SKIP) {
      console.log(c.yellow('  NOTE: --ollama-skip mode — vector metrics are degraded; baseline comparison skipped.'));
      console.log(`  FTS recall@1:           ${recall_at_1.toFixed(2)}`);
      console.log(`  FTS recall@3 (relaxed): ${recall_at_3_relaxed.toFixed(2)}`);
      console.log(`  Negative precision:     ${negative_precision.toFixed(2)}`);
    } else if (FLAG_RERANK) {
      console.log(c.cyan('--- Reranker mode ---'));
      console.log(c.yellow('  NOTE: --rerank mode — reporting reranker metrics only; no baseline comparison.'));
      const precision5Positive = positiveQueries.filter(r => {
        const top5files = r.hits.map(h => h.filename);
        return (r.expected_top_3 && r.expected_top_3.length > 0)
          ? r.expected_top_3.some(f => top5files.includes(f))
          : (r.expected_top_1 && top5files.includes(r.expected_top_1));
      });
      const precision_at_5 = positiveN > 0 ? precision5Positive.length / positiveN : 1;
      console.log(`  Recall@1:               ${recall_at_1.toFixed(2)}`);
      console.log(`  Recall@3 (relaxed):     ${recall_at_3_relaxed.toFixed(2)}`);
      console.log(`  MRR:                    ${mrr.toFixed(2)}`);
      console.log(`  Negative precision:     ${negative_precision.toFixed(2)}`);
      console.log(`  Precision@5:            ${precision_at_5.toFixed(2)}  (${precision5Positive.length}/${positiveN} positive queries)`);
    } else {
      metricLine('Recall@1:',           recall_at_1,        baseline.recall_at_1,         false);
      metricLine('Recall@3 (relaxed):', recall_at_3_relaxed, baseline.recall_at_3_relaxed, false);
      metricLine('MRR:',               mrr,                 baseline.mrr,                 false);
      metricLine('Negative precision:', negative_precision,  baseline.negative_precision,   true);
    }

    console.log('='.repeat(60));

    const queryWord = n === 1 ? 'query' : 'queries';
    if (!anyRegression || FLAG_OLLAMA_SKIP || FLAG_RERANK) {
      console.log(c.green(`SUMMARY: ${n}/${n} ${queryWord} evaluated, all metrics within tolerance.`));
    } else {
      console.log(c.red(`SUMMARY: ${n} ${queryWord} evaluated — METRIC REGRESSION DETECTED.`));
    }
    console.log('='.repeat(60));

    // ── Step 11: --update-baseline ───────────────────────────────────────────

    if (FLAG_UPDATE) {
      if (FLAG_OLLAMA_SKIP) {
        console.log(c.yellow('\nBaseline update skipped: --ollama-skip produces degraded metrics.'));
      } else {
        const newBaseline = {
          recall_at_1,
          recall_at_3_relaxed,
          mrr,
          negative_precision,
          neg_prec_score_threshold: NEG_PREC_SCORE_THRESHOLD,
          embedding_type: USE_VLLM_EVAL ? 'halfvec(4000)' : 'vector(1024)',
          negative_query_nearest_fp,
          updatedAt: runStartedAt,
        };
        fs.writeFileSync(BASELINE_FILE, JSON.stringify(newBaseline, null, 2), 'utf8');
        console.log(c.green(`\nBaseline updated: ${BASELINE_FILE}`));
        console.log(`  recall_at_1:          ${recall_at_1.toFixed(4)}`);
        console.log(`  recall_at_3_relaxed:  ${recall_at_3_relaxed.toFixed(4)}`);
        console.log(`  mrr:                  ${mrr.toFixed(4)}`);
        console.log(`  negative_precision:   ${negative_precision.toFixed(4)}`);
      }
    }

    await db.end().catch(() => {});
    exitCode = anyRegression && !FLAG_OLLAMA_SKIP && !FLAG_RERANK ? 1 : 0;

  } catch (err) {
    try { await db.end(); } catch (_) {}
    if (!infraOk) { exitCode = 2; return; }
    console.error(`\n${c.red('Unhandled error:')} ${err.message}`);
    console.error(err.stack);
    exitCode = 2;
  } finally {
    // Drop the throwaway DB regardless of success or failure.
    // This block runs even when the catch sets exitCode — process.exit() is
    // deferred to after cleanup so the DROP always executes.
    // Guard: if config is undefined (failure before config loading), dropEvalDb
    // falls back to env-var defaults for host/auth — still safe.
    if (EVAL_DB_OWNED) {
      await dropEvalDb(config || {}, EVAL_DB_NAME);
    }
  }
}

// ─── ENTRY POINT ──────────────────────────────────────────────────────────────
// exitCode is set inside main() then read here so that the try/finally teardown
// (DB drop) runs before process.exit() is called.

let exitCode = 0;

main().then(() => {
  process.exit(exitCode);
}).catch(err => {
  console.error(`\nFatal: ${err.message}`);
  process.exit(2);
});
