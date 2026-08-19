'use strict';

/**
 * phase0-decisions-backfill.js
 *
 * Phase 0 of Bundle A: migrate rows from pipeline_pipeline.decisions into the
 * claude-memory schema (memory_entries + memory_entry_chunks) on claude_memory_eval_test.
 *
 * Source:  localhost Postgres / pipeline_pipeline / public.decisions (147 rows)
 * Target:  localhost Postgres / claude_memory_eval_test / memory_entries + memory_entry_chunks
 *
 * Field mapping:
 *   name         <- "Decision #<id>: <topic>" (truncated to 200 chars)
 *   description  <- NULL
 *   mem_type     <- 'decision'
 *   body         <- Markdown-formatted (see composeBody())
 *   source_file  <- "decisions/decision-<id>-<slugified-topic>.md" (capped at 80 chars slug)
 *   content_hash <- sha256(body).slice(0,16)
 *   embedding    <- NULL (Phase 1 will backfill at 4096-dim)
 *
 * Idempotency: ON CONFLICT (source_file) DO UPDATE on parent row; DELETE + re-INSERT chunks.
 *
 * Usage:
 *   node scripts/phase0-decisions-backfill.js [--dry-run] [--quiet]
 *
 * Flags:
 *   --dry-run  Read source, compute chunks, print summary; no DB writes.
 *   --quiet    Suppress per-row progress; errors still go to stderr.
 *
 * Exit codes: 0 success, 1 any error.
 *
 * Plan reference: BUNDLE-A-SPEC.md / HANDOFF-2026-05-14b-phase1-implementation-ready.md
 */

const path   = require('path');
const crypto = require('crypto');
const { Client } = require('pg');

const { chunkText }  = require('./pipeline-chunker');
const { loadConfig, hasProvenanceColumn } = require('./lib/shared');

// ─── ARGUMENT PARSING ────────────────────────────────────────────────────────

const args   = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const quiet  = args.includes('--quiet');

const log = (...a) => { if (!quiet) console.log(...a); };

// ─── CONSTANTS ───────────────────────────────────────────────────────────────

const PROSE_CEILING = 1400;

// ─── HELPERS ─────────────────────────────────────────────────────────────────

/** sha256 hex; mirrors pipeline-memory-loader.js convention */
function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

/** sha256(text).slice(0,16) — 16-hex content_hash used throughout the loader */
function contentHash(text) {
  return sha256(text).slice(0, 16);
}

/**
 * Slugify a topic string for use in source_file paths.
 * Lowercase, replace non-alphanumeric runs with '-', trim, collapse repeats.
 */
function slugify(str) {
  return str
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-');
}

/**
 * Compose the body markdown for a single decisions row.
 */
function composeBody(row) {
  const reasonText = row.reason ? row.reason : '(no reason recorded)';
  const sessionStr = row.session_num != null ? String(row.session_num) : 'n/a';
  const createdStr = row.created_at ? new Date(row.created_at).toISOString() : 'unknown';

  return [
    `# ${row.topic}`,
    '',
    '## Decision',
    row.decision,
    '',
    '## Reason',
    reasonText,
    '',
    '---',
    `Source: pipeline_pipeline.decisions id=${row.id}, session=${sessionStr}, created_at=${createdStr}`,
  ].join('\n');
}

/**
 * Build the source_file path for a decisions row.
 * Slug capped so the full path is at most ~120 chars (80-char slug limit is generous).
 */
function buildSourceFile(id, topic) {
  const rawSlug = `decision-${id}-${slugify(topic)}`;
  const slug    = rawSlug.slice(0, 80);
  return `decisions/${slug}.md`;
}

/**
 * Build the name for a decisions row (truncated to 200 chars).
 */
function buildName(id, topic) {
  const full = `Decision #${id}: ${topic}`;
  return full.slice(0, 200);
}

// ─── DATABASE CONNECTIONS ────────────────────────────────────────────────────

async function connectTo(database, baseConfig) {
  const client = new Client({
    host:     baseConfig.host,
    port:     baseConfig.port,
    user:     baseConfig.user,
    database,
  });
  await client.connect();
  return client;
}

// ─── MAIN ────────────────────────────────────────────────────────────────────

async function main() {
  const start = Date.now();

  // Load config to get host/port/user from .claude/pipeline.yml
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    console.error(`Config load failed: ${err.message}`);
    process.exit(1);
  }

  // Source DB: pipeline_pipeline (same cluster, same user)
  let srcDb, tgtDb;
  if (!dryRun) {
    try {
      srcDb = await connectTo('pipeline_pipeline', config);
      tgtDb = await connectTo('claude_memory_eval_test', config);
    } catch (err) {
      console.error(`DB connection failed: ${err.message}`);
      process.exit(1);
    }
  } else {
    // dry-run: still connect to source to read rows; skip target
    try {
      srcDb = await connectTo('pipeline_pipeline', config);
    } catch (err) {
      console.error(`Source DB connection failed: ${err.message}`);
      process.exit(1);
    }
  }

  // ── 1. Fetch all decision rows from source ──────────────────────────────────
  let rows;
  try {
    const res = await srcDb.query(
      `SELECT id, session_num, topic, decision, reason, created_at
       FROM decisions
       ORDER BY id`
    );
    rows = res.rows;
  } catch (err) {
    console.error(`Source query failed: ${err.message}`);
    await srcDb.end().catch(() => {});
    if (tgtDb) await tgtDb.end().catch(() => {});
    process.exit(1);
  }

  log(`phase0-decisions-backfill: fetched ${rows.length} rows from pipeline_pipeline.decisions`);
  if (dryRun) log(`  (dry-run mode — no DB writes)`);

  // cm#201 completeness item #10 (inverse violator): classified ONCE for
  // this whole run -- when memory_entries/memory_entry_chunks have adopted
  // embedded_by_provider_id, every embedding=NULL this script writes must
  // pair embedded_by_provider_id=NULL in the SAME statement, never left
  // standing stale on a row whose embedding was just cleared/omitted.
  const entriesHaveProvenanceCol = !dryRun ? await hasProvenanceColumn(tgtDb, 'memory_entries') : false;
  const chunksHaveProvenanceCol  = !dryRun ? await hasProvenanceColumn(tgtDb, 'memory_entry_chunks') : false;

  // ── 2. Process rows ─────────────────────────────────────────────────────────
  const stats = {
    rows:       rows.length,
    upserted:   0,
    skipped:    0,
    totalChunks: 0,
    chunkCounts: [],
    errors:     0,
  };

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];

    let body, sourceFile, name, hash, chunks;
    try {
      body       = composeBody(row);
      sourceFile = buildSourceFile(row.id, row.topic);
      name       = buildName(row.id, row.topic);
      hash       = contentHash(body);
      chunks     = chunkText(body, PROSE_CEILING, 'prose');
    } catch (err) {
      console.error(`  [ERROR] Row id=${row.id}: compose failed: ${err.message}`);
      stats.errors++;
      continue;
    }

    stats.chunkCounts.push(chunks.length);
    stats.totalChunks += chunks.length;

    // Progress every 25 rows
    if (!quiet && (i + 1) % 25 === 0) {
      log(`  processed ${i + 1}/${rows.length} rows...`);
    }

    if (dryRun) {
      stats.upserted++;
      continue;
    }

    // ── per-row transaction ──────────────────────────────────────────────────
    try {
      await tgtDb.query('BEGIN');

      // a. Upsert memory_entries row (cm#201: pair embedded_by_provider_id
      // = NULL alongside embedding = NULL, in the same statement, when
      // this table has adopted the column -- classified once above).
      const entrySql = entriesHaveProvenanceCol
        ? `INSERT INTO memory_entries
             (name, description, mem_type, body, source_file, content_hash, embedding, embedded_by_provider_id)
           VALUES ($1, NULL, 'decision', $2, $3, $4, NULL, NULL)
           ON CONFLICT (source_file) DO UPDATE
             SET name         = EXCLUDED.name,
                 mem_type     = EXCLUDED.mem_type,
                 body         = EXCLUDED.body,
                 content_hash = EXCLUDED.content_hash,
                 embedding    = NULL,
                 embedded_by_provider_id = NULL,
                 updated_at   = NOW()
           RETURNING id`
        : `INSERT INTO memory_entries
             (name, description, mem_type, body, source_file, content_hash, embedding)
           VALUES ($1, NULL, 'decision', $2, $3, $4, NULL)
           ON CONFLICT (source_file) DO UPDATE
             SET name         = EXCLUDED.name,
                 mem_type     = EXCLUDED.mem_type,
                 body         = EXCLUDED.body,
                 content_hash = EXCLUDED.content_hash,
                 embedding    = NULL,
                 updated_at   = NOW()
           RETURNING id`;
      const parentRes = await tgtDb.query(entrySql, [name, body, sourceFile, hash]);
      const entryId = parentRes.rows[0].id;

      // b. Delete existing chunks for this entry (clean-slate re-insert)
      await tgtDb.query(
        `DELETE FROM memory_entry_chunks WHERE entry_id = $1`,
        [entryId]
      );

      // c. Insert fresh chunk rows (cm#201: pair embedded_by_provider_id
      // explicitly when this table has adopted the column -- this is a
      // fresh INSERT, so "explicit NULL" and "omitted" are equivalent in
      // effect, but explicit keeps the invariant self-evident at the call
      // site rather than relying on the table default).
      const chunkSql = chunksHaveProvenanceCol
        ? `INSERT INTO memory_entry_chunks
             (entry_id, chunk_idx, content, content_hash, embedding, embedded_by_provider_id)
           VALUES ($1, $2, $3, $4, NULL, NULL)`
        : `INSERT INTO memory_entry_chunks
             (entry_id, chunk_idx, content, content_hash, embedding)
           VALUES ($1, $2, $3, $4, NULL)`;
      for (const chunk of chunks) {
        const chunkHash = contentHash(chunk.content);
        await tgtDb.query(chunkSql, [entryId, chunk.chunkIdx, chunk.content, chunkHash]);
      }

      await tgtDb.query('COMMIT');
      stats.upserted++;
    } catch (err) {
      await tgtDb.query('ROLLBACK').catch(() => {});
      console.error(`  [ERROR] Row id=${row.id}: DB write failed: ${err.message}`);
      stats.errors++;
    }
  }

  await srcDb.end().catch(() => {});

  // ── 3. Summary ───────────────────────────────────────────────────────────────
  const ms = Date.now() - start;

  log('');
  log('─── phase0-decisions-backfill summary ───────────────────────────────────────');
  log(`  Rows processed:    ${stats.rows}`);
  log(`  Entries upserted:  ${stats.upserted}`);
  log(`  Errors:            ${stats.errors}`);
  log(`  Total chunks:      ${stats.totalChunks}`);

  if (stats.chunkCounts.length > 0) {
    const sorted = stats.chunkCounts.slice().sort((a, b) => a - b);
    const min    = sorted[0];
    const max    = sorted[sorted.length - 1];
    const mid    = sorted[Math.floor(sorted.length / 2)];
    log(`  Chunks per entry:  min=${min}, median=${mid}, max=${max}`);
  }

  log(`  Duration:          ${(ms / 1000).toFixed(1)}s`);

  if (dryRun) {
    log('');
    log('  (dry-run: no DB writes performed)');
    await tgtDb && tgtDb.end && tgtDb.end().catch(() => {});
    process.exit(stats.errors > 0 ? 1 : 0);
  }

  // ── 4. Verification queries ───────────────────────────────────────────────────
  log('');
  log('─── verification ────────────────────────────────────────────────────────────');

  try {
    const decisionCount = await tgtDb.query(
      `SELECT COUNT(*) AS n FROM memory_entries WHERE mem_type = 'decision'`
    );
    log(`  memory_entries with mem_type='decision': ${decisionCount.rows[0].n} (expected 147)`);

    const totalEntries = await tgtDb.query(
      `SELECT COUNT(*) AS n FROM memory_entries`
    );
    log(`  memory_entries total: ${totalEntries.rows[0].n} (expected 189)`);

    const totalChunks = await tgtDb.query(
      `SELECT COUNT(*) AS n FROM memory_entry_chunks`
    );
    log(`  memory_entry_chunks total: ${totalChunks.rows[0].n}`);

    // Chunks that belong to decision entries
    const decisionChunks = await tgtDb.query(
      `SELECT COUNT(*) AS n
       FROM memory_entry_chunks mc
       JOIN memory_entries me ON me.id = mc.entry_id
       WHERE me.mem_type = 'decision'`
    );
    log(`  memory_entry_chunks from decisions: ${decisionChunks.rows[0].n} (= ${stats.totalChunks} expected from this run)`);

    // Spot-check: confirm embedding is NULL for decision rows
    const embCheck = await tgtDb.query(
      `SELECT id, name, embedding
       FROM memory_entries
       WHERE mem_type = 'decision' AND embedding IS NOT NULL
       LIMIT 5`
    );
    if (embCheck.rows.length === 0) {
      log(`  Embedding spot-check: PASS — zero decision entries have a non-NULL embedding`);
    } else {
      console.error(`  Embedding spot-check: FAIL — ${embCheck.rows.length} decision entries unexpectedly have embeddings`);
      stats.errors++;
    }

    // Sample 3 random decision entries with chunk counts
    const sampleRows = await tgtDb.query(
      `SELECT me.id, me.name, me.source_file, COUNT(mc.id) AS chunk_count
       FROM memory_entries me
       LEFT JOIN memory_entry_chunks mc ON mc.entry_id = me.id
       WHERE me.mem_type = 'decision'
       GROUP BY me.id, me.name, me.source_file
       ORDER BY RANDOM()
       LIMIT 3`
    );
    log('');
    log('  Sample 3 random decision entries:');
    for (const r of sampleRows.rows) {
      log(`    id=${r.id}  chunks=${r.chunk_count}  ${r.source_file}`);
      log(`    name: ${r.name.slice(0, 80)}`);
    }
  } catch (err) {
    console.error(`Verification query failed: ${err.message}`);
    stats.errors++;
  }

  await tgtDb.end().catch(() => {});

  log('');
  log('─────────────────────────────────────────────────────────────────────────────');

  process.exit(stats.errors > 0 ? 1 : 0);
}

main().catch(err => {
  console.error(`Unhandled error: ${err.message}`);
  process.exit(1);
});
