'use strict';

/**
 * pipeline-memory-loader.js
 *
 * CLI loader: reads filesystem sources, chunks via pipeline-chunker, embeds
 * via ollamaEmbed (BATCH=8), and upserts idempotently into the three chunk tables.
 *
 * Usage:
 *   node scripts/pipeline-memory-loader.js memory      # Load ~/.claude/projects/<cwd>/memory/*.md
 *   node scripts/pipeline-memory-loader.js sessions    # Load ~/.claude/projects/<cwd>/*.jsonl
 *   node scripts/pipeline-memory-loader.js policy      # Load project + global CLAUDE.md
 *   node scripts/pipeline-memory-loader.js all         # All three in sequence
 *   node scripts/pipeline-memory-loader.js help        # Help text
 *
 * Flags (apply to any subcommand):
 *   --force      Bypass content_hash skip; re-embed all chunks
 *   --dry-run    Read sources, compute chunks, print summary; no DB writes
 *   --quiet      Suppress progress output; errors still surface to stderr
 *
 * Exit codes: 0 on success, 1 on any error.
 *
 * Plan: docs/plans/2026-04-26-chunker-loader-plan.md (Phase 5)
 */

const fs     = require('fs');
const path   = require('path');
const os     = require('os');
const crypto = require('crypto');

const { chunkText }          = require('./pipeline-chunker');
const { getClaudeProjectDir } = require('./lib/encoded-cwd');
const { loadConfig, connect, c, ollamaEmbed } = require('./lib/shared');
const { embedWithRetry }                       = require('./pipeline-embed');

const BATCH                = 8;
const CONST_PROSE_CEILING  = 1400;  // DECISION-004: prose sources
const CONST_JSONL_CEILING  = 560;   // DECISION-004: JSONL/tool_result sources

// ─── ARGUMENT PARSING ────────────────────────────────────────────────────────

const args    = process.argv.slice(2);
const subcmd  = args.find(a => !a.startsWith('--')) || '';
const force   = args.includes('--force');
const dryRun  = args.includes('--dry-run');
const quiet   = args.includes('--quiet');

const log = (...a) => { if (!quiet) console.log(...a); };

// ─── MAIN ────────────────────────────────────────────────────────────────────

async function main() {
  if (!subcmd || subcmd === 'help') {
    printHelp();
    process.exit(0);
  }

  const validCmds = ['memory', 'sessions', 'policy', 'all'];
  if (!validCmds.includes(subcmd)) {
    console.error(`Unknown subcommand: ${subcmd}`);
    printHelp();
    process.exit(1);
  }

  let config, db;
  if (!dryRun) {
    try {
      config = loadConfig();
      db     = await connect(config);
    } catch (err) {
      console.error(`DB connection failed: ${err.message}`);
      process.exit(1);
    }
  }

  try {
    if (subcmd === 'memory' || subcmd === 'all') await loadMemory(db, config);
    if (subcmd === 'sessions' || subcmd === 'all') await loadSessions(db, config);
    if (subcmd === 'policy' || subcmd === 'all') await loadPolicy(db, config);
  } catch (err) {
    console.error(`Loader failed: ${err.message}`);
    if (db) await db.end().catch(() => {});
    process.exit(1);
  }

  if (db) await db.end().catch(() => {});
}

function printHelp() {
  log([
    '',
    'pipeline-memory-loader.js — embed memory, sessions, and policy into the knowledge DB',
    '',
    'Usage:',
    '  node scripts/pipeline-memory-loader.js <subcommand> [flags]',
    '',
    'Subcommands:',
    '  memory    Load ~/.claude/projects/<cwd>/memory/*.md',
    '  sessions  Load ~/.claude/projects/<cwd>/*.jsonl',
    '  policy    Load project CLAUDE.md and global ~/.claude/CLAUDE.md',
    '  all       Run memory, sessions, and policy in sequence',
    '  help      Show this help text',
    '',
    'Flags:',
    '  --force    Bypass content_hash skip; re-embed all chunks',
    '  --dry-run  Read sources and compute chunks; no DB writes',
    '  --quiet    Suppress progress output; errors still surface to stderr',
    '',
  ].join('\n'));
}

// ─── SHA256 HELPER ───────────────────────────────────────────────────────────

function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

// ─── EMBED PENDING HELPER ────────────────────────────────────────────────────

/**
 * Embed all rows with NULL embedding in a given table.
 * Selects rows, groups into BATCH=8 windows, calls ollamaEmbed, writes back.
 *
 * @param {object}   db       - pg Client (null in dry-run mode)
 * @param {object}   config   - pipeline config (for embedding_model)
 * @param {string}   table    - 'memory_entry_chunks' | 'policy_sections' | 'session_chunks'
 * @param {Function} buildCtx - (row) => string — context-prefixed text for embedding
 * @param {object}   stats    - mutable stats object with .embedded / .errored keys
 */
async function embedPending(db, config, table, buildCtx, stats) {
  if (dryRun || !db) return;

  // Allowlist guard — prevent arbitrary table names from reaching SQL
  const ALLOWED_TABLES = new Set(['memory_entry_chunks', 'session_chunks', 'policy_sections']);
  if (!ALLOWED_TABLES.has(table)) {
    throw new Error(`embedPending called with disallowed table: ${table}`);
  }

  // Fetch pending rows — join to parent table for context prefix where needed
  let rows;
  if (table === 'memory_entry_chunks') {
    const r = await db.query(
      `SELECT mc.id, mc.content, me.name
       FROM memory_entry_chunks mc
       JOIN memory_entries me ON me.id = mc.entry_id
       WHERE mc.embedding IS NULL
       ORDER BY mc.id`
    );
    rows = r.rows;
  } else {
    const r = await db.query(
      `SELECT * FROM ${table} WHERE embedding IS NULL ORDER BY id`
    );
    rows = r.rows;
  }

  if (rows.length === 0) return;

  // Pre-compute text for each row so embedFn is a pure (texts) => vectors call
  for (const row of rows) {
    row.text = buildCtx(row);
  }

  const embedFn = (texts) => ollamaEmbed(texts, config && config.knowledge);

  const result = await embedWithRetry(rows, embedFn, { batchSize: BATCH });

  // Write successfully embedded rows to DB
  for (const row of rows) {
    if (row._vector) {
      await db.query(
        `UPDATE ${table} SET embedding = $1 WHERE id = $2`,
        [row._vector, row.id]
      );
      stats.embedded++;
    }
  }

  stats.errored = (stats.errored || 0) + result.skipped + result.failed;
}

// ─── MEMORY LOADER ───────────────────────────────────────────────────────────

async function loadMemory(db, config) {
  const start   = Date.now();
  const memDir  = path.join(getClaudeProjectDir(process.cwd()), 'memory');
  const stats   = { files: 0, parents: 0, chunks: 0, embedded: 0, skipped: 0, errors: 0 };

  let files;
  try {
    files = fs.readdirSync(memDir).filter(f => f.endsWith('.md'));
  } catch (err) {
    console.error(`memory loader: cannot read directory ${memDir}: ${err.message}`);
    stats.errors++;
    printMemoryStats(stats, Date.now() - start);
    return;
  }

  for (const filename of files) {
    const filePath  = path.join(memDir, filename);
    const name      = filename.slice(0, -3); // strip .md
    const sourceFile = path.join('memory', filename);

    let body;
    try {
      body = fs.readFileSync(filePath, 'utf8');
    } catch (err) {
      console.error(`  [SKIP] Cannot read ${filePath}: ${err.message}`);
      stats.errors++;
      continue;
    }

    stats.files++;

    // Parse first non-empty line for description (must start with "# ")
    const firstLine = body.split('\n').find(l => l.trim().length > 0) || '';
    const description = firstLine.startsWith('# ')
      ? firstLine.slice(2).trim()
      : null;

    // Parse YAML frontmatter for mem_type (simple key: value scan)
    let memType = null;
    const fmMatch = body.match(/^---\s*\n([\s\S]*?)\n---/);
    if (fmMatch) {
      const typeMatch = fmMatch[1].match(/^type:\s*(.+)$/m);
      if (typeMatch) memType = typeMatch[1].trim();
    }

    if (!dryRun) {
      // Upsert parent row — conflict on source_file (the UNIQUE column)
      const parentRes = await db.query(
        `INSERT INTO memory_entries (name, description, mem_type, body, source_file)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (source_file) DO UPDATE
           SET name        = EXCLUDED.name,
               description = EXCLUDED.description,
               mem_type    = EXCLUDED.mem_type,
               body        = EXCLUDED.body,
               updated_at  = NOW()
         RETURNING id`,
        [name, description, memType, body, sourceFile]
      );
      const entryId = parentRes.rows[0].id;
      stats.parents++;

      // Chunk and upsert chunks
      const chunks = chunkText(body, CONST_PROSE_CEILING, 'prose');

      // Fetch existing content_hashes for this entry to detect skip candidates
      const existRes = await db.query(
        `SELECT chunk_idx, content_hash FROM memory_entry_chunks WHERE entry_id = $1`,
        [entryId]
      );
      const existingHashes = new Map(existRes.rows.map(r => [r.chunk_idx, r.content_hash]));

      for (const chunk of chunks) {
        const hash = sha256(chunk.content);
        const stored = existingHashes.get(chunk.chunkIdx);

        if (!force && stored === hash) {
          // Hash match and not forced — row already exists; ON CONFLICT DO NOTHING
          // preserves the existing row (including its embedding) unchanged.
          stats.skipped++;
          await db.query(
            `INSERT INTO memory_entry_chunks (entry_id, chunk_idx, content, content_hash)
             VALUES ($1, $2, $3, $4)
             ON CONFLICT (entry_id, chunk_idx) DO NOTHING`,
            [entryId, chunk.chunkIdx, chunk.content, hash]
          );
        } else {
          // New or changed chunk — upsert with NULL embedding to trigger re-embed
          await db.query(
            `INSERT INTO memory_entry_chunks (entry_id, chunk_idx, content, content_hash, embedding)
             VALUES ($1, $2, $3, $4, NULL)
             ON CONFLICT (entry_id, chunk_idx) DO UPDATE
               SET content      = EXCLUDED.content,
                   content_hash = EXCLUDED.content_hash,
                   embedding    = NULL`,
            [entryId, chunk.chunkIdx, chunk.content, hash]
          );
        }
        stats.chunks++;
      }
    } else {
      // dry-run: count only
      const chunks = chunkText(body, CONST_PROSE_CEILING, 'prose');
      stats.parents++;
      stats.chunks += chunks.length;
    }
  }

  // Embed pass — all NULL embedding rows for memory_entry_chunks
  if (!dryRun) {
    await embedPending(db, config, 'memory_entry_chunks',
      row => `Memory: ${row.name}\n\n${row.content}`,
      stats
    );
  }

  printMemoryStats(stats, Date.now() - start);
}

function printMemoryStats(stats, ms) {
  log(`memory loader:`);
  log(`  Files read:        ${stats.files}`);
  log(`  Parents upserted:  ${stats.parents}`);
  log(`  Chunks upserted:   ${stats.chunks}`);
  log(`  Chunks embedded:   ${stats.embedded}`);
  log(`  Chunks skipped (hash match, --force not set): ${stats.skipped}`);
  log(`  Errors:            ${stats.errors}`);
  log(`  Duration:          ${(ms / 1000).toFixed(1)}s`);
  if (dryRun) log(`  (dry-run: no DB writes)`);
}

// ─── SESSIONS LOADER ─────────────────────────────────────────────────────────

async function loadSessions(db, config) {
  const start      = Date.now();
  const projectDir = getClaudeProjectDir(process.cwd());
  const stats      = { files: 0, chunks: 0, embedded: 0, skipped: 0, errors: 0 };

  // NOTE: session_chunks has NO unique constraint on (session_id, chunk_idx).
  // The table only has a PRIMARY KEY on id. We use INSERT ... WHERE NOT EXISTS
  // to avoid duplicates on re-run, and UPDATE the embedding=NULL when content
  // changes (detected via content_hash comparison before insert).
  // See schema audit: scripts/setup-knowledge-db.sql ~line 448.

  let jsonlFiles;
  try {
    jsonlFiles = fs.readdirSync(projectDir)
      .filter(f => f.endsWith('.jsonl'))
      .map(f => path.join(projectDir, f));
  } catch (err) {
    console.error(`sessions loader: cannot read directory ${projectDir}: ${err.message}`);
    stats.errors++;
    printSessionStats(stats, Date.now() - start);
    return;
  }

  for (const filePath of jsonlFiles) {
    const filename  = path.basename(filePath);
    const sessionId = filename.slice(0, -6); // strip .jsonl

    let lines;
    try {
      lines = fs.readFileSync(filePath, 'utf8').split('\n').filter(l => l.trim());
    } catch (err) {
      console.error(`  [SKIP] Cannot read ${filePath}: ${err.message}`);
      stats.errors++;
      continue;
    }

    stats.files++;
    let chunkIdx = 0;

    for (const line of lines) {
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }

      const role    = msg.role || msg.type || '';
      const content = msg.content;

      if (!content) continue;

      // Build sub-chunks for this message
      const subChunks = [];

      if (typeof content === 'string') {
        if (content.length === 0) continue;
        const contentType = role === 'tool_result' ? 'tool_result' : 'prose';
        const pieces = chunkText(content, CONST_JSONL_CEILING, contentType);
        for (const p of pieces) subChunks.push(p.content);
        if (subChunks.length === 0) subChunks.push(content.slice(0, CONST_JSONL_CEILING));
      } else if (Array.isArray(content)) {
        for (const el of content) {
          // Skip non-text elements (images, tool_use refs, tool_result refs) —
          // they carry no retrievable text and would bloat the chunk store.
          let str;
          if (typeof el === 'string') {
            str = el;
          } else if (el && typeof el === 'object' && el.type === 'text' && typeof el.text === 'string') {
            str = el.text;
          } else {
            // Non-text element (image, tool_use, tool_result, etc.) — skip
            continue;
          }
          if (str.trim().length === 0) continue;
          const pieces = chunkText(str, CONST_JSONL_CEILING, 'prose');
          for (const p of pieces) subChunks.push(p.content);
          if (pieces.length === 0 && str.trim()) subChunks.push(str.slice(0, CONST_JSONL_CEILING));
        }
      } else {
        continue;
      }

      for (const chunkContent of subChunks) {
        if (!chunkContent.trim()) { chunkIdx++; continue; }
        const hash = sha256(chunkContent);

        if (!dryRun) {
          // Check existing row for this session_id + chunk_idx
          const existRes = await db.query(
            `SELECT id, content_hash, embedding FROM session_chunks
             WHERE session_id = $1 AND chunk_idx = $2
             LIMIT 1`,
            [sessionId, chunkIdx]
          );

          if (existRes.rows.length === 0) {
            // New chunk — insert
            await db.query(
              `INSERT INTO session_chunks
                 (session_id, chunk_idx, chunk_kind, content, content_hash, source_jsonl)
               VALUES ($1, $2, $3, $4, $5, $6)`,
              [sessionId, chunkIdx, role, chunkContent, hash, filePath]
            );
          } else {
            const existing = existRes.rows[0];
            if (!force && existing.content_hash === hash) {
              // Hash match — preserve embedding, skip re-embed
              stats.skipped++;
            } else {
              // Changed content — update with NULL embedding to trigger re-embed
              await db.query(
                `UPDATE session_chunks
                 SET content = $1, content_hash = $2, chunk_kind = $3,
                     embedding = NULL, source_jsonl = $4
                 WHERE id = $5`,
                [chunkContent, hash, role, filePath, existing.id]
              );
            }
          }
        }

        stats.chunks++;
        chunkIdx++;
      }
    }
  }

  // Embed pass
  if (!dryRun) {
    await embedPending(db, config, 'session_chunks',
      row => `Session: ${row.session_id} [${row.chunk_kind || ''}]\n\n${row.content}`,
      stats
    );
  }

  printSessionStats(stats, Date.now() - start);
}

function printSessionStats(stats, ms) {
  log(`sessions loader:`);
  log(`  Files read:        ${stats.files}`);
  log(`  Chunks upserted:   ${stats.chunks}`);
  log(`  Chunks embedded:   ${stats.embedded}`);
  log(`  Chunks skipped (hash match, --force not set): ${stats.skipped}`);
  log(`  Errors:            ${stats.errors}`);
  log(`  Duration:          ${(ms / 1000).toFixed(1)}s`);
  if (dryRun) log(`  (dry-run: no DB writes)`);
}

// ─── POLICY LOADER ───────────────────────────────────────────────────────────

async function loadPolicy(db, config) {
  const start   = Date.now();
  const sources = [
    { docId: 'CLAUDE.md',        filePath: path.join(process.cwd(), 'CLAUDE.md') },
    { docId: 'global-CLAUDE.md', filePath: path.join(os.homedir(), '.claude', 'CLAUDE.md') },
  ];
  const stats = { files: 0, sections: 0, chunks: 0, embedded: 0, skipped: 0, errors: 0 };

  for (const { docId, filePath } of sources) {
    if (!fs.existsSync(filePath)) continue;

    let body;
    try {
      body = fs.readFileSync(filePath, 'utf8');
    } catch (err) {
      console.error(`  [SKIP] Cannot read ${filePath}: ${err.message}`);
      stats.errors++;
      continue;
    }

    stats.files++;

    // Split on heading boundaries — each heading starts a new section
    const sections = splitPolicySections(body);

    for (const section of sections) {
      const subChunks = chunkText(section.content, CONST_PROSE_CEILING, 'prose');
      stats.sections++;

      for (const chunk of subChunks) {
        const hash = sha256(chunk.content);

        if (!dryRun) {
          // Check for existing row
          const existRes = await db.query(
            `SELECT id, content_hash FROM policy_sections
             WHERE doc_id = $1 AND section_num = $2 AND chunk_idx = $3
             LIMIT 1`,
            [docId, section.sectionNum, chunk.chunkIdx]
          );

          if (existRes.rows.length === 0) {
            // New — insert
            await db.query(
              `INSERT INTO policy_sections
                 (doc_id, section_num, section_title, content, chunk_idx, content_hash)
               VALUES ($1, $2, $3, $4, $5, $6)`,
              [docId, section.sectionNum, section.sectionTitle, chunk.content, chunk.chunkIdx, hash]
            );
          } else {
            const existing = existRes.rows[0];
            if (!force && existing.content_hash === hash) {
              stats.skipped++;
            } else {
              await db.query(
                `UPDATE policy_sections
                 SET section_title = $1, content = $2, content_hash = $3, embedding = NULL
                 WHERE id = $4`,
                [section.sectionTitle, chunk.content, hash, existing.id]
              );
            }
          }
        }

        stats.chunks++;
      }
    }
  }

  // Embed pass
  if (!dryRun) {
    await embedPending(db, config, 'policy_sections',
      row => `Policy: ${row.doc_id} §${row.section_num || ''} ${row.section_title || ''}\n\n${row.content}`,
      stats
    );
  }

  printPolicyStats(stats, Date.now() - start);
}

/**
 * Split a policy document body into sections at heading boundaries.
 * Each section has: sectionNum (string, e.g. "1.2"), sectionTitle (string), content (string).
 * sectionNum is based on heading level counters (hierarchical dotted notation).
 */
function splitPolicySections(body) {
  const lines = body.split('\n');
  const sections = [];
  const counters = [0, 0, 0, 0, 0, 0]; // index 0 = H1, index 5 = H6

  let currentTitle  = '(preamble)';
  let currentNum    = '0';
  let currentLines  = [];

  for (const line of lines) {
    const headingMatch = line.match(/^(#{1,6})\s+(.*)/);
    if (headingMatch) {
      // Flush current section
      const content = currentLines.join('\n').trim();
      if (content.length > 0) {
        sections.push({ sectionNum: currentNum, sectionTitle: currentTitle, content });
      }

      const level = headingMatch[1].length - 1; // 0-indexed
      counters[level]++;
      // Reset deeper levels
      for (let i = level + 1; i < 6; i++) counters[i] = 0;

      currentTitle = headingMatch[2].trim();
      currentNum   = counters.slice(0, level + 1).filter(n => n > 0).join('.');
      currentLines = [line]; // heading line goes into this section
    } else {
      currentLines.push(line);
    }
  }

  // Flush last section
  const content = currentLines.join('\n').trim();
  if (content.length > 0) {
    sections.push({ sectionNum: currentNum, sectionTitle: currentTitle, content });
  }

  return sections;
}

function printPolicyStats(stats, ms) {
  log(`policy loader:`);
  log(`  Files read:        ${stats.files}`);
  log(`  Sections parsed:   ${stats.sections}`);
  log(`  Chunks upserted:   ${stats.chunks}`);
  log(`  Chunks embedded:   ${stats.embedded}`);
  log(`  Chunks skipped (hash match, --force not set): ${stats.skipped}`);
  log(`  Errors:            ${stats.errors}`);
  log(`  Duration:          ${(ms / 1000).toFixed(1)}s`);
  if (dryRun) log(`  (dry-run: no DB writes)`);
}

// ─── ENTRYPOINT ──────────────────────────────────────────────────────────────

main().catch(err => {
  console.error(`Unhandled error: ${err.message}`);
  process.exit(1);
});
