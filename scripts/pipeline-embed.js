#!/usr/bin/env node
/**
 * pipeline-embed.js — Generic Ollama-backed embedding pipeline for
 * memory_entries and memory_entry_chunks.
 *
 * This file is the embedding engine for claude-memory, a generic memory
 * schema for AI agents on Postgres + pgvector + Ollama. It was forked from
 * the pipeline plugin (https://github.com/djwmobley/pipeline) as a spiritual
 * callback — the pipeline embed engine proved robust for production use and
 * serves as the foundation here.
 *
 * Reads connection config from .claude/pipeline.yml.
 *
 * Usage:
 *   node pipeline-embed.js index              # Embed all unembedded entries
 *   node pipeline-embed.js index --all        # Re-embed everything
 *   node pipeline-embed.js search "<query>"   # Pure vector similarity search
 *   node pipeline-embed.js hybrid "<query>"   # FTS + vector hybrid search (best)
 *   node pipeline-embed.js stats              # Show embedding coverage per table
 *
 * Requires:
 *   - Ollama running at localhost:11434
 *   - Model pulled: ollama pull mxbai-embed-large
 *   - PostgreSQL with pgvector extension
 */

const { loadConfig, connect, c, ollamaDefaults, ollamaEmbed, vllmEmbed, tryEmbed } = require('./lib/shared');

// ─── CONFIG ──────────────────────────────────────────────────────────────────

const CONFIG = loadConfig();
const OLLAMA_HOST = ollamaDefaults.host;
const OLLAMA_PORT = ollamaDefaults.port;
const EMBED_MODEL = CONFIG.embedding_model || ollamaDefaults.model;

// ─── EMBED BACKEND ROUTING ───────────────────────────────────────────────────
// EMBED_BACKEND=vllm  → use vllmEmbed (Qwen3-Embedding-8B, 4096-dim)
// EMBED_BACKEND unset → use ollamaEmbed (mxbai-embed-large, 1024-dim)
const EMBED_BACKEND = (process.env.EMBED_BACKEND || '').toLowerCase();
const USE_VLLM = EMBED_BACKEND === 'vllm';

// EMBED_COLUMN=embedding_4096 → write 4096-dim vectors to the alternate column.
// Default is 'embedding' (the production 1024-dim column).
const EMBED_COLUMN = process.env.EMBED_COLUMN || 'embedding';

// ─── TABLE DEFINITIONS ──────────────────────────────────────────────────────
// Each entry defines how to read, embed, and search a table.
// SECURITY: tbl.name, tbl.selectCols, and tbl.idCol are expanded into SQL
// identifiers. These MUST remain static source constants — never populated
// from pipeline.yml, user input, or any external data.

const TABLES = [
  {
    name: 'memory_entries',
    idCol: 'id',
    textFn: (r) => `Memory: ${r.name}\n${r.description || ''}\n\n${(r.body || '').substring(0, 5000)}`,
    selectCols: 'id, name, description, mem_type, body',
    get updateSql() { return `UPDATE memory_entries SET ${EMBED_COLUMN} = $1 WHERE id = $2`; },
    label: (r) => `memory: ${r.name || '?'}`,
    snippet: (r) => r.description || (r.body || '').substring(0, 120),
    ftsCol: 'fts_vec',
  },
  {
    name: 'memory_entry_chunks',
    idCol: 'id',
    // Embed with parent-name context to match the loader's inline embedPending
    // path (pipeline-memory-loader.js:295, "Memory: ${name}\n\n${content}").
    // Without the parent name, backfilled chunks have weaker embeddings than
    // chunks embedded during the load pass.
    textFn: (r) => `Memory: ${r.entry_name || ''}\n\n${r.content || ''}`,
    selectCols: 'id, entry_id, chunk_idx, content, (SELECT name FROM memory_entries WHERE id = entry_id) AS entry_name',
    get updateSql() { return `UPDATE memory_entry_chunks SET ${EMBED_COLUMN} = $1 WHERE id = $2`; },
    label: (r) => `memory entry #${r.entry_id} chunk ${r.chunk_idx}`,
    snippet: (r) => (r.content || '').substring(0, 120),
    ftsCol: 'fts_vec',
  },
];

// ─── EMBED CONSTANTS ─────────────────────────────────────────────────────────

// Safety guard: mxbai-embed-large has a 512-token cap (~4 chars/token, 2000 bytes).
// Qwen3-Embedding-8B has 32K context; use a much larger guard (16000 bytes).
const MAX_EMBED_BYTES = USE_VLLM ? 16000 : 2000;

// ─── CHUNK-COVERED TABLES ────────────────────────────────────────────────────
// Derived from information_schema at first use; cached for the process lifetime.
// Tables covered by v_memory_hits view (the *_chunks tables).
// Used by cmdSearch / cmdHybrid to skip per-table iteration for chunk tables —
// their hits are surfaced via v_memory_hits and would otherwise double-count.
// cmdIndex no longer skips chunk tables: they have small per-row content and
// embed cleanly, and the loader's inline embed path is not always exercised
// (e.g., when consumers populate chunks via their own ingest layers).
let _chunkTablesCached = null;

async function getChunkTables(client) {
  if (_chunkTablesCached) return _chunkTablesCached;
  const { rows } = await client.query(
    "SELECT table_name FROM information_schema.tables " +
    "WHERE table_name LIKE '%_chunks' AND table_schema = current_schema()"
  );
  _chunkTablesCached = new Set(rows.map(r => r.table_name));
  return _chunkTablesCached;
}

// ─── INTROSPECTION HELPERS ──────────────────────────────────────────────────

async function tableExists(client, tableName) {
  const { rows } = await client.query(
    "SELECT 1 FROM information_schema.tables WHERE table_schema = current_schema() AND table_name = $1",
    [tableName]
  );
  return rows.length > 0;
}

async function columnExists(client, tableName, colName) {
  const { rows } = await client.query(
    "SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = $1 AND column_name = $2",
    [tableName, colName]
  );
  return rows.length > 0;
}

async function hasAnyEmbeddings(client, tableName) {
  if (!(await columnExists(client, tableName, 'embedding'))) return false;
  const { rows } = await client.query(
    `SELECT 1 FROM ${tableName} WHERE embedding IS NOT NULL LIMIT 1`
  );
  return rows.length > 0;
}

// ─── EMBED WITH RETRY ────────────────────────────────────────────────────────

/**
 * Batch-embed rows with oversize guard, per-batch failure isolation, and
 * per-row exponential-backoff retry.
 *
 * @param {Array}    rows                  - Array of { id, text, ...passthrough } objects.
 *                                           Caller must set row.text before calling.
 * @param {Function} embedFn               - async (string[]) => number[][] — one vector per input.
 * @param {object}   [opts]
 * @param {number}   [opts.batchSize=32]   - Number of rows per Ollama call.
 * @param {number}   [opts.maxRetries=3]   - Per-row retry attempts after batch failure.
 * @param {Function} [opts.onBatchError]   - (err, batch) => void — called on batch rejection.
 * @returns {Promise<{ embedded: number, skipped: number, failed: number }>}
 *   Successful rows have row._vector set (pgvector string "[v0,v1,...]").
 */
async function embedWithRetry(rows, embedFn, { batchSize = 32, maxRetries = 3, onBatchError = null } = {}) {
  let embedded = 0;
  let skipped  = 0;
  let failed   = 0;

  // Partition: skip rows whose text exceeds MAX_EMBED_BYTES
  const eligible  = [];
  const oversized = [];
  for (const row of rows) {
    if ((row.text || '').length > MAX_EMBED_BYTES) {
      oversized.push(row);
    } else {
      eligible.push(row);
    }
  }

  for (const row of oversized) {
    process.stderr.write(
      `[embedWithRetry] Skipping row id=${row.id}: ${(row.text || '').length} chars exceeds MAX_EMBED_BYTES (${MAX_EMBED_BYTES})\n`
    );
    skipped++;
  }

  // Process eligible rows in batches
  for (let i = 0; i < eligible.length; i += batchSize) {
    const batch = eligible.slice(i, i + batchSize);
    const texts = batch.map(r => r.text || '');

    try {
      const embeddings = await embedFn(texts);
      for (let j = 0; j < batch.length; j++) {
        batch[j]._vector = `[${embeddings[j].join(',')}]`;
        embedded++;
      }
    } catch (batchErr) {
      if (onBatchError) onBatchError(batchErr, batch);

      // Per-row retry with exponential backoff (2s / 4s / 8s)
      for (const row of batch) {
        let rowEmbedded = false;
        for (let attempt = 1; attempt <= maxRetries; attempt++) {
          const delayMs = Math.pow(2, attempt) * 1000; // 2s, 4s, 8s
          await new Promise(res => setTimeout(res, delayMs));
          try {
            const [vec] = await embedFn([row.text || '']);
            row._vector = `[${vec.join(',')}]`;
            embedded++;
            rowEmbedded = true;
            break;
          } catch (retryErr) {
            if (attempt === maxRetries) {
              process.stderr.write(
                `[embedWithRetry] Failed row id=${row.id} after ${maxRetries} retries: ${retryErr.message.slice(0, 100)}\n`
              );
            }
          }
        }
        if (!rowEmbedded) failed++;
      }
    }
  }

  return { embedded, skipped, failed };
}

// ─── INDEX ───────────────────────────────────────────────────────────────────

async function cmdIndex(forceAll) {
  const client = await connect(CONFIG);
  try {
    let totalDone = 0;

    // Route the embed function based on EMBED_BACKEND env var.
    const embedFn = USE_VLLM
      ? (texts) => vllmEmbed(texts)
      : (texts) => ollamaEmbed(texts, CONFIG);

    const backendLabel = USE_VLLM ? `vLLM (${process.env.VLLM_EMBED_URL || 'http://localhost:8800'})` : `Ollama ${EMBED_MODEL}`;
    console.log(c.dim(`Backend: ${backendLabel} | Column: ${EMBED_COLUMN} | Max bytes: ${MAX_EMBED_BYTES}`));

    for (const tbl of TABLES) {
      if (!(await tableExists(client, tbl.name))) {
        console.log(c.dim(`Skipping ${tbl.name} — table does not exist.`));
        continue;
      }
      if (!(await columnExists(client, tbl.name, EMBED_COLUMN))) {
        console.log(c.dim(`Skipping ${tbl.name} — no ${EMBED_COLUMN} column.`));
        continue;
      }

      const query = forceAll
        ? `SELECT ${tbl.selectCols} FROM ${tbl.name} ORDER BY ${tbl.idCol}`
        : `SELECT ${tbl.selectCols} FROM ${tbl.name} WHERE ${EMBED_COLUMN} IS NULL ORDER BY ${tbl.idCol}`;
      const { rows } = await client.query(query);

      if (rows.length === 0) {
        console.log(c.green(`${tbl.name}: all entries already embedded.`));
        continue;
      }

      console.log(`${c.bold('Embedding')} ${rows.length} ${tbl.name} entries via ${backendLabel}...`);

      // Pre-compute text for each row so embedFn is a pure (texts) => vectors call
      for (const row of rows) {
        row.text   = tbl.textFn(row);
        row.id     = row[tbl.idCol]; // embedWithRetry expects row.id
      }

      const result = await embedWithRetry(rows, embedFn, { batchSize: 32 });

      // Write successfully embedded rows to DB
      let done = 0;
      for (const row of rows) {
        if (row._vector) {
          await client.query(tbl.updateSql, [row._vector, row[tbl.idCol]]);
          done++;
          process.stdout.write(`\r  ${done}/${rows.length} embedded...`);
        }
      }

      console.log(`\n${c.green('Done.')} ${tbl.name}: ${result.embedded} embedded, ${result.skipped} skipped (oversize), ${result.failed} failed.`);
      totalDone += result.embedded;
    }

    console.log(`\n${c.bold('Total:')} ${totalDone} entries embedded across all tables.`);
  } finally {
    await client.end();
  }
}

// ─── SEMANTIC SEARCH ─────────────────────────────────────────────────────────

async function cmdSearch(query) {
  console.log(`${c.bold('Semantic search:')} "${query}"\n`);

  const client = await connect(CONFIG);
  try {
    // Pre-check: is there anything to search?
    let anyEmbedded = false;
    for (const tbl of TABLES) {
      if (await hasAnyEmbeddings(client, tbl.name)) { anyEmbedded = true; break; }
    }
    if (!anyEmbedded) {
      console.log(c.yellow('No embeddings found across any table. Run "index" first.'));
      return;
    }

    const embedQueryFn = USE_VLLM ? vllmEmbed : (texts) => ollamaEmbed(texts, CONFIG);
    const [qEmbedding] = await embedQueryFn([query]);
    const vec = `[${qEmbedding.join(',')}]`;

    let resultNum = 0;

    // ── v_memory_hits (chunked: memory + sessions + policy) ──
    const { rows: viewExists } = await client.query(
      "SELECT 1 FROM pg_views WHERE viewname = 'v_memory_hits' LIMIT 1"
    );
    if (!viewExists.length) {
      console.log(c.yellow('  (v_memory_hits view not found — run setup to enable chunked memory search)'));
    } else {
      const { rows: viewRows } = await client.query(
        `SELECT source_table, chunk_id, source_row_id, source_ordinal, chunk_idx, total_chunks, label, snippet,
                1 - (embedding <=> $1::halfvec(4000)) AS cosine_similarity
         FROM v_memory_hits
         WHERE embedding IS NOT NULL
         ORDER BY embedding <=> $1::halfvec(4000)
         LIMIT 5`,
        [vec]
      );
      if (viewRows.length > 0) {
        console.log(c.bold('── memory (chunked: memory + sessions + policy) ──'));
        viewRows.forEach((row) => {
          resultNum++;
          const score = (row.cosine_similarity * 100).toFixed(1);
          const chunkLabel = row.total_chunks > 1
            ? ` (chunk ${row.chunk_idx + 1}/${row.total_chunks})`
            : '';
          const snippet = (row.snippet || '').substring(0, 120).replace(/\n/g, ' ');
          console.log(`${c.cyan(String(resultNum).padStart(2))}. ${c.bold(`[${row.source_table}] ${row.label}${chunkLabel}`)} ${c.dim(`(${score}%)`)}`);
          console.log(`    ${snippet}...\n`);
        });
      }
    }

    const chunkTables = await getChunkTables(client);
    for (const tbl of TABLES) {
      if (chunkTables.has(tbl.name)) continue;
      if (!(await tableExists(client, tbl.name))) continue;

      const { rows: [{ count }] } = await client.query(`SELECT COUNT(*) FROM ${tbl.name}`);
      if (parseInt(count) === 0) continue;

      if (!(await hasAnyEmbeddings(client, tbl.name))) continue;

      const { rows } = await client.query(
        `SELECT ${tbl.selectCols},
                1 - (embedding <=> $1::halfvec(4000)) AS cosine_similarity
         FROM ${tbl.name}
         WHERE embedding IS NOT NULL
         ORDER BY embedding <=> $1::halfvec(4000)
         LIMIT 5`,
        [vec]
      );

      if (rows.length === 0) continue;

      console.log(c.bold(`── ${tbl.name} ──`));
      rows.forEach((row) => {
        resultNum++;
        const score = (row.cosine_similarity * 100).toFixed(1);
        const snippet = (tbl.snippet(row) || '').substring(0, 120).replace(/\n/g, ' ');
        console.log(`${c.cyan(String(resultNum).padStart(2))}. ${c.bold(tbl.label(row))} ${c.dim(`(${score}%)`)}`);
        console.log(`    ${snippet}...\n`);
      });
    }

    if (resultNum === 0) console.log(c.yellow('No results.'));
  } finally {
    await client.end();
  }
}

// ─── HYBRID SEARCH (FTS + vector) ───────────────────────────────────────────

async function cmdHybrid(query) {
  console.log(`${c.bold('Hybrid search:')} "${query}"\n`);

  const client = await connect(CONFIG);
  try {
    let resultNum = 0;
    let qEmb = null;
    const embedQueryFnH = USE_VLLM ? vllmEmbed : (texts) => ollamaEmbed(texts, CONFIG);

    // ── v_memory_hits (chunked: memory + sessions + policy) ──
    const { rows: viewExists } = await client.query(
      "SELECT 1 FROM pg_views WHERE viewname = 'v_memory_hits' LIMIT 1"
    );
    if (!viewExists.length) {
      console.log(c.yellow('  (v_memory_hits view not found — run setup to enable chunked memory search)'));
    } else {
      if (!qEmb) { [qEmb] = await embedQueryFnH([query]); }
      const vec = `[${qEmb.join(',')}]`;
      const { rows: viewRows } = await client.query(
        `SELECT source_table, chunk_id, source_row_id, source_ordinal, chunk_idx, total_chunks, label, snippet,
                ts_rank(fts_vec, plainto_tsquery($1)) * 0.3 +
                (1 - (embedding <=> $2::halfvec(4000))) * 0.7 AS score
         FROM v_memory_hits
         WHERE embedding IS NOT NULL
         ORDER BY score DESC
         LIMIT 5`,
        [query, vec]
      );
      if (viewRows.length > 0) {
        console.log(c.bold('── memory (chunked: memory + sessions + policy) ──'));
        viewRows.forEach((row) => {
          resultNum++;
          const chunkLabel = row.total_chunks > 1
            ? ` (chunk ${row.chunk_idx + 1}/${row.total_chunks})`
            : '';
          const snippet = (row.snippet || '').substring(0, 120).replace(/\n/g, ' ');
          console.log(`${c.cyan(String(resultNum).padStart(2))}. ${c.bold(`[${row.source_table}] ${row.label}${chunkLabel}`)} ${c.dim(`(${(row.score * 100).toFixed(1)}%)`)}`);
          console.log(`    ${snippet}...\n`);
        });
      }
    }

    const chunkTables = await getChunkTables(client);
    for (const tbl of TABLES) {
      if (chunkTables.has(tbl.name)) continue;
      if (!(await tableExists(client, tbl.name))) continue;

      const { rows: [{ count }] } = await client.query(`SELECT COUNT(*) FROM ${tbl.name}`);
      if (parseInt(count) === 0) continue;

      const hasEmb = await hasAnyEmbeddings(client, tbl.name);
      const hasFts = await columnExists(client, tbl.name, 'fts_vec');

      let rows;
      if (!hasEmb) {
        // FTS-only fallback
        if (!hasFts) continue;
        console.log(c.yellow(`  (${tbl.name}: no embeddings — keyword-only results)`));

        const result = await client.query(
          `SELECT ${tbl.selectCols},
                  ts_rank(fts_vec, plainto_tsquery($1)) AS score
           FROM ${tbl.name}
           WHERE fts_vec @@ plainto_tsquery($1)
           ORDER BY score DESC
           LIMIT 5`,
          [query]
        );
        rows = result.rows;
      } else if (!hasFts) {
        // Vector-only (fts_vec missing — schema not updated)
        console.log(c.yellow(`  (${tbl.name}: no fts_vec column — vector-only results. Run setup to enable hybrid.)`));
        if (!qEmb) { [qEmb] = await embedQueryFnH([query]); }
        const vec = `[${qEmb.join(',')}]`;

        const result = await client.query(
          `SELECT ${tbl.selectCols},
                  1 - (embedding <=> $1::halfvec(4000)) AS score
           FROM ${tbl.name}
           WHERE embedding IS NOT NULL
           ORDER BY embedding <=> $1::halfvec(4000)
           LIMIT 5`,
          [vec]
        );
        rows = result.rows;
      } else {
        // Hybrid: 30% FTS + 70% vector
        if (!qEmb) { [qEmb] = await embedQueryFnH([query]); }
        const vec = `[${qEmb.join(',')}]`;

        const result = await client.query(
          `SELECT ${tbl.selectCols},
                  ts_rank(fts_vec, plainto_tsquery($1)) * 0.3 +
                  (1 - (embedding <=> $2::halfvec(4000))) * 0.7 AS score
           FROM ${tbl.name}
           WHERE embedding IS NOT NULL
           ORDER BY score DESC
           LIMIT 5`,
          [query, vec]
        );
        rows = result.rows;
      }

      if (!rows || rows.length === 0) continue;

      console.log(c.bold(`── ${tbl.name} ──`));
      rows.forEach((row) => {
        resultNum++;
        const snippet = (tbl.snippet(row) || '').substring(0, 120).replace(/\n/g, ' ');
        console.log(`${c.cyan(String(resultNum).padStart(2))}. ${c.bold(tbl.label(row))} ${c.dim(`(${(row.score * 100).toFixed(1)}%)`)}`);
        console.log(`    ${snippet}...\n`);
      });
    }

    if (resultNum === 0) console.log(c.yellow('No results.'));
  } finally {
    await client.end();
  }
}

// ─── STATS ──────────────────────────────────────────────────────────────────

async function cmdStats() {
  const client = await connect(CONFIG);
  try {
    console.log(`${c.bold('Embedding coverage:')}\n`);
    for (const tbl of TABLES) {
      if (!(await tableExists(client, tbl.name))) {
        console.log(`  ${tbl.name}: ${c.dim('table does not exist')}`);
        continue;
      }

      const { rows: [{ count: total }] } = await client.query(
        `SELECT COUNT(*) FROM ${tbl.name}`
      );

      if (!(await columnExists(client, tbl.name, 'embedding'))) {
        console.log(`  ${tbl.name}: ${total} rows, ${c.yellow('no embedding column')}`);
        continue;
      }

      const { rows: [{ count: embedded }] } = await client.query(
        `SELECT COUNT(*) FROM ${tbl.name} WHERE embedding IS NOT NULL`
      );

      const pct = parseInt(total) > 0 ? ((parseInt(embedded) / parseInt(total)) * 100).toFixed(0) : 0;
      const color = pct == 100 ? c.green : pct > 0 ? c.yellow : c.red;
      console.log(`  ${tbl.name}: ${color(`${embedded}/${total} embedded (${pct}%)`)}`);
    }
  } finally {
    await client.end();
  }
}

// ─── HELP ────────────────────────────────────────────────────────────────────

function help() {
  console.log(`
${c.bold('pipeline-embed.js')} — Multi-table embedding index + semantic search
${c.dim(`Database: ${CONFIG.database} | Ollama: ${OLLAMA_HOST}:${OLLAMA_PORT} | Model: ${EMBED_MODEL}`)}
${c.dim(`Tables: ${TABLES.map(t => t.name).join(', ')}`)}

  ${c.cyan('index')}
      Embed all unembedded entries across all tables

  ${c.cyan('index --all')}
      Re-embed everything (force refresh)

  ${c.cyan('search')} "<query>"
      Pure vector similarity search (all tables)

  ${c.cyan('hybrid')} "<query>"
      FTS + vector hybrid search (best results, all tables)

  ${c.cyan('stats')}
      Show embedding coverage per table

Requires: Ollama running at ${OLLAMA_HOST}:${OLLAMA_PORT}
  ollama pull ${EMBED_MODEL}
`);
}

// ─── EXPORTS ─────────────────────────────────────────────────────────────────

module.exports = { embedWithRetry, MAX_EMBED_BYTES };

// ─── ENTRY ───────────────────────────────────────────────────────────────────

if (require.main === module) {
const [, , cmd, ...args] = process.argv;

(async () => {
  try {
    if (!cmd || cmd === 'help' || cmd === '--help') {
      help();
    } else if (cmd === 'index') {
      await cmdIndex(args[0] === '--all');
    } else if (cmd === 'search') {
      await cmdSearch(args.join(' '));
    } else if (cmd === 'hybrid') {
      await cmdHybrid(args.join(' '));
    } else if (cmd === 'stats') {
      await cmdStats();
    } else {
      console.error(`Unknown command: ${cmd}`);
      help();
      process.exit(1);
    }
  } catch (err) {
    console.error(c.red('Error: ') + err.message);
    process.exit(1);
  }
})();
} // end require.main === module
