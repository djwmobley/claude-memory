'use strict';

/**
 * eval-retrieval.js — Retrieval-quality regression harness for hybrid FTS + vector search.
 *
 * Loads a fixed fixture corpus into an isolated eval DB, runs hand-labeled queries,
 * computes Recall@1, Recall@3 (relaxed), MRR, and Negative Precision, then asserts
 * the metrics meet committed baselines.
 *
 * Usage:
 *   node test/eval/eval-retrieval.js                 # Run full eval
 *   node test/eval/eval-retrieval.js --update-baseline  # Accept current metrics as new baseline
 *   node test/eval/eval-retrieval.js --quiet          # Summary only (no per-query output)
 *   node test/eval/eval-retrieval.js --ollama-skip    # FTS-only; skip vector parts
 *
 * Prerequisites:
 *   - Create the eval DB before first run:
 *       psql -U postgres -c "CREATE DATABASE claude_memory_eval_test;"
 *       psql -U postgres -d claude_memory_eval_test -c "CREATE EXTENSION IF NOT EXISTS vector;"
 *   - Ollama running with mxbai-embed-large pulled (unless --ollama-skip).
 *
 * Exit codes: 0 all-pass, 1 metric regression, 2 infrastructure failure.
 */

const assert        = require('assert');
const path          = require('path');
const fs            = require('fs');
const os            = require('os');
const { execFileSync } = require('child_process');

const { loadConfig, connect, ollamaEmbed, c } = require('../../scripts/lib/shared');
const { encodeCwd }                            = require('../../scripts/lib/encoded-cwd');

// ─── CLI FLAGS ────────────────────────────────────────────────────────────────

const argv             = process.argv.slice(2);
const FLAG_UPDATE      = argv.includes('--update-baseline');
const FLAG_QUIET       = argv.includes('--quiet');
const FLAG_OLLAMA_SKIP = argv.includes('--ollama-skip');

// ─── PATHS ────────────────────────────────────────────────────────────────────

const EVAL_DIR      = path.join(__dirname);
const FIXTURES_DIR  = path.join(EVAL_DIR, 'fixtures');
const QUERIES_FILE  = path.join(EVAL_DIR, 'queries.json');
const BASELINE_FILE = path.join(EVAL_DIR, 'baseline.json');
const LAST_RUN_FILE = path.join(EVAL_DIR, 'last-run.json');
const SCRIPTS_DIR   = path.join(__dirname, '..', '..', 'scripts');
const SETUP_SQL     = path.join(SCRIPTS_DIR, 'setup.sql');
const LOADER_SCRIPT = path.join(SCRIPTS_DIR, 'pipeline-memory-loader.js');

// ─── DB OVERRIDE ──────────────────────────────────────────────────────────────

const EVAL_DB_NAME = process.env.EVAL_DB_NAME || 'claude_memory_eval_test';

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
  process.exit(2);
}

// ─── HYBRID SQL ───────────────────────────────────────────────────────────────

const HYBRID_SQL = `
  SELECT label, source_table, chunk_id, chunk_idx,
         ts_rank(fts_vec, plainto_tsquery($1)) * 0.3 +
         (1 - (embedding <=> $2::vector)) * 0.7 AS score
  FROM v_memory_hits
  WHERE embedding IS NOT NULL
  ORDER BY score DESC
  LIMIT 5
`;

const FTS_ONLY_SQL = `
  SELECT label, source_table, chunk_id, chunk_idx,
         ts_rank(fts_vec, plainto_tsquery($1)) AS score
  FROM v_memory_hits
  WHERE fts_vec @@ plainto_tsquery($1)
  ORDER BY score DESC
  LIMIT 5
`;

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
  const runStartedAt = new Date().toISOString();
  console.log('');
  console.log(c.bold('eval-retrieval — Hybrid retrieval quality eval'));
  console.log(`  DB:      ${EVAL_DB_NAME}`);
  console.log(`  Ollama:  ${FLAG_OLLAMA_SKIP ? 'SKIP (--ollama-skip)' : 'enabled'}`);
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

  let config, db;
  try {
    config          = loadConfig();
    const evalConfig = { ...config, database: EVAL_DB_NAME };
    db              = await connect(evalConfig);
    step(`Connected to ${EVAL_DB_NAME}`, true);
  } catch (err) {
    infraFail(`DB connection failed (${EVAL_DB_NAME}): ${err.message}\n  Ensure the database exists: psql -c "CREATE DATABASE ${EVAL_DB_NAME}"`);
  }

  try {
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
          env:      { ...process.env, PROJECT_ROOT: path.resolve(__dirname, '..', '..') },
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
        const res = await db.query(FTS_ONLY_SQL, [query]);
        rows = res.rows;
      } else {
        // Embed the query
        let qVec;
        try {
          const embeddings = await ollamaEmbed([query], config && config.knowledge);
          qVec = `[${embeddings[0].join(',')}]`;
        } catch (err) {
          infraFail(`Ollama embedding failed for query "${query}": ${err.message}`);
        }
        const res = await db.query(HYBRID_SQL, [query, qVec]);
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
      const noLeak        = !must_not_appear_top_5.some(f => topFilenames.includes(f));

      perQueryResults.push({
        id, query,
        expected_top_1, expected_top_3, must_not_appear_top_5,
        isNegative,
        hits,
        top1Match, top3Match, mrr, noLeak,
      });

      const label = `Query [${id}]: ${query.slice(0, 40)}`;
      // For negative queries, success is no leak. For positive queries, all three.
      const ok    = isNegative ? noLeak : (top1Match && top3Match && noLeak);
      const detail = !ok
        ? (isNegative
            ? `negative-query leak=${must_not_appear_top_5.filter(f => topFilenames.includes(f))}; top3=${JSON.stringify(topFilenames.slice(0, 3))}`
            : `top1=${topFilenames[0] || '(none)'} expected=${expected_top_1}; ` +
              `top3=${JSON.stringify(topFilenames.slice(0, 3))}; ` +
              `leak=${!noLeak ? must_not_appear_top_5.filter(f => topFilenames.includes(f)) : 'none'}`)
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
    } else {
      metricLine('Recall@1:',           recall_at_1,        baseline.recall_at_1,         false);
      metricLine('Recall@3 (relaxed):', recall_at_3_relaxed, baseline.recall_at_3_relaxed, false);
      metricLine('MRR:',               mrr,                 baseline.mrr,                 false);
      metricLine('Negative precision:', negative_precision,  baseline.negative_precision,   true);
    }

    console.log('='.repeat(60));

    const queryWord = n === 1 ? 'query' : 'queries';
    if (!anyRegression || FLAG_OLLAMA_SKIP) {
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
    process.exit(anyRegression && !FLAG_OLLAMA_SKIP ? 1 : 0);

  } catch (err) {
    try { await db.end(); } catch (_) {}
    if (!infraOk) process.exit(2);
    console.error(`\n${c.red('Unhandled error:')} ${err.message}`);
    console.error(err.stack);
    process.exit(2);
  }
}

main().catch(err => {
  console.error(`\nFatal: ${err.message}`);
  process.exit(2);
});
