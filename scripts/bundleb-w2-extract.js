'use strict';

/**
 * bundleb-w2-extract.js — Bundle B Workstream 2
 *
 * Standalone batch LLM extraction of entities, assertions, and edges from the
 * backfilled decisions corpus (memory_entries WHERE mem_type='decision').
 *
 * Writes into the EXISTING entities/assertions/edges tables (same schema as
 * handoff-core-schema.sql, project-scoped via project_id). Does NOT modify
 * the loader, close, ranking, or decay logic.
 *
 * SAFETY PROPERTY (enforced in code, documented here):
 *   All assertions written by this script use source='model_extracted' and a
 *   FIXED confidence of 5.0. This can NEVER satisfy the CLAUDE.md auto-promotion
 *   gate, which requires confidence >= 9 AND source='user_stated' AND multi-session
 *   reinforcement. Cross-ref SECURITY.md trust model: model_extracted rows are
 *   untrusted input — they cannot self-promote into durable facts.
 *
 * Usage:
 *   node scripts/bundleb-w2-extract.js [--force] [--limit N] [--decision <id>]
 *
 * Flags:
 *   --force          Re-extract decisions already processed (deletes existing rows
 *                    with the deterministic session_id 'w2-extract:decision:<id>',
 *                    then re-extracts).
 *   --limit N        Process at most N decisions (useful for ops/testing).
 *   --decision <id>  Process a single decision by memory_entries.id.
 *
 * Environment:
 *   EMBED_SKIP=1     Skip all LLM calls and DB writes — clean no-op (CI-safe).
 *   HANDOFF_DB       Override the target database name (default: claude_memory_eval_test).
 *   PROJECT_ROOT     Override project root detection (used by resolveProjectId()).
 *
 * Exit codes: 0 normal completion (even if some decisions failed — see summary counts),
 *             1 fatal setup error (DB connection failure, etc.).
 *
 * Exports (for tests): parseExtraction
 */

const http = require('http');
const { Client } = require('pg');

const { loadConfig, ollamaDefaults, findProjectRoot } = require('./lib/shared');
const { encodeCwd } = require('./lib/encoded-cwd');

// ─── CONSTANTS ───────────────────────────────────────────────────────────────

const EXTRACT_MODEL    = 'qwen2.5:14b';
const BODY_CAP         = 6000;    // chars fed to the LLM per decision
const ARRAY_CAP        = 100;     // max entities/assertions/edges per extraction
const STRING_CAP       = 1000;    // max chars per individual string field
const ASSERTION_CONF   = 5.0;     // FIXED — must never equal or exceed promotion gate (>= 9)
const ASSERTION_SOURCE = 'model_extracted'; // must never be 'user_stated'
const EDGE_WEIGHT_DEFAULT = 1.0;

// ─── DB NAME VALIDATION HELPER ───────────────────────────────────────────────

const _DB_NAME_RE = /^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/;

// ─── HELPERS ─────────────────────────────────────────────────────────────────

/** Resolve project_id for the current working directory (mirrors handoff.js). */
function resolveProjectId() {
  const root = findProjectRoot();
  return encodeCwd(root);
}

/** Connect to the handoff target DB using config from .claude/pipeline.yml. */
async function connectDb(targetDb) {
  const cfg = loadConfig();
  const client = new Client({
    host:     cfg.host,
    port:     cfg.port,
    database: targetDb,
    user:     cfg.user,
  });
  await client.connect();
  return client;
}

/**
 * Call Ollama /api/generate — mirrors ollamaGenerateBlurb pattern from shared.js:462-502.
 * Returns the response string, or null on any failure (never throws).
 *
 * @param {string} prompt
 * @param {object} [opts] - Optional overrides: { model, host, port }.
 * @returns {Promise<string|null>}
 */
function ollamaGenerate(prompt, opts) {
  const model = (opts && opts.model) || EXTRACT_MODEL;
  const host  = (opts && opts.host)  || ollamaDefaults.host;
  const port  = (opts && opts.port)  || ollamaDefaults.port;

  return new Promise((resolve) => {
    const body = JSON.stringify({
      model,
      prompt,
      stream: false,
      options: { num_predict: 1024 },
    });
    const reqOpts = {
      hostname: host,
      port,
      path: '/api/generate',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    };
    const req = http.request(reqOpts, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          const text = (parsed.response || '').trim();
          resolve(text.length > 0 ? text : null);
        } catch (_) {
          resolve(null);
        }
      });
    });
    req.on('error', () => resolve(null));
    req.write(body);
    req.end();
  });
}

/**
 * Build the strict-JSON extraction prompt for a decision body.
 *
 * @param {string} name   - The decision's name field.
 * @param {string} body   - The decision's body text (will be capped at BODY_CAP chars).
 * @returns {string} prompt
 */
function buildPrompt(name, body) {
  const snippet = body.slice(0, BODY_CAP);
  return (
    `You are a knowledge-graph extractor. Read the decision record below and extract structured knowledge.\n` +
    `Output ONLY a single JSON object with exactly these three keys — no prose, no explanation, no code fences:\n` +
    `{"entities":[{"name":"<string>","entity_type":"<string>","description":"<string>"}],"assertions":[{"subject":"<string>","predicate":"<string>","object":"<string>"}],"edges":[{"from_entity":"<string>","edge_type":"<string>","to_entity":"<string>"}]}\n\n` +
    `Rules:\n` +
    `- entities: things mentioned (people, systems, concepts, processes). entity_type must be one of: person, system, concept, process, tool, repo, file, other\n` +
    `- assertions: factual claims in subject-predicate-object triple form\n` +
    `- edges: relationships between named entities\n` +
    `- All string values must be concise (under 200 chars each)\n` +
    `- If there is nothing to extract for a category, use an empty array []\n\n` +
    `Decision record: "${name}"\n\n${snippet}`
  );
}

/**
 * Parse the raw LLM response into a validated extraction object.
 *
 * Handles: clean JSON, ```json fenced ```, prose-wrapped {...}.
 * Returns null for null/empty input or any parsing/validation failure.
 *
 * Exported for unit testing.
 *
 * @param {string|null} raw
 * @returns {{entities: object[], assertions: object[], edges: object[]}|null}
 */
function parseExtraction(raw) {
  if (raw == null || raw.trim().length === 0) return null;

  let text = raw.trim();

  // Strip ```json ... ``` or ``` ... ``` code fences
  text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();

  // Extract the first balanced {...} substring (handles prose-wrapped JSON)
  const braceStart = text.indexOf('{');
  if (braceStart === -1) return null;

  let depth = 0;
  let braceEnd = -1;
  for (let i = braceStart; i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}') {
      depth--;
      if (depth === 0) { braceEnd = i; break; }
    }
  }
  if (braceEnd === -1) return null;

  const jsonStr = text.slice(braceStart, braceEnd + 1);

  let parsed;
  try {
    parsed = JSON.parse(jsonStr);
  } catch (_) {
    return null;
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;

  // Validate/coerce the three arrays — default to [] if missing
  const rawEntities   = Array.isArray(parsed.entities)   ? parsed.entities   : [];
  const rawAssertions = Array.isArray(parsed.assertions)  ? parsed.assertions : [];
  const rawEdges      = Array.isArray(parsed.edges)       ? parsed.edges      : [];

  // Cap array sizes
  const entities = rawEntities.slice(0, ARRAY_CAP).reduce((acc, e) => {
    if (!e || typeof e !== 'object') return acc;
    const name        = typeof e.name        === 'string' ? e.name.slice(0, STRING_CAP).trim()        : '';
    const entity_type = typeof e.entity_type === 'string' ? e.entity_type.slice(0, STRING_CAP).trim() : '';
    const description = typeof e.description === 'string' ? e.description.slice(0, STRING_CAP).trim() : null;
    if (!name || !entity_type) return acc; // required fields
    acc.push({ name, entity_type, description });
    return acc;
  }, []);

  const assertions = rawAssertions.slice(0, ARRAY_CAP).reduce((acc, a) => {
    if (!a || typeof a !== 'object') return acc;
    const subject   = typeof a.subject   === 'string' ? a.subject.slice(0, STRING_CAP).trim()   : '';
    const predicate = typeof a.predicate === 'string' ? a.predicate.slice(0, STRING_CAP).trim() : '';
    const object    = typeof a.object    === 'string' ? a.object.slice(0, STRING_CAP).trim()    : '';
    if (!subject || !predicate || !object) return acc; // all three required
    acc.push({ subject, predicate, object });
    return acc;
  }, []);

  const edges = rawEdges.slice(0, ARRAY_CAP).reduce((acc, g) => {
    if (!g || typeof g !== 'object') return acc;
    const from_entity = typeof g.from_entity === 'string' ? g.from_entity.slice(0, STRING_CAP).trim() : '';
    const edge_type   = typeof g.edge_type   === 'string' ? g.edge_type.slice(0, STRING_CAP).trim()   : '';
    const to_entity   = typeof g.to_entity   === 'string' ? g.to_entity.slice(0, STRING_CAP).trim()   : '';
    if (!from_entity || !edge_type || !to_entity) return acc;
    acc.push({ from_entity, edge_type, to_entity });
    return acc;
  }, []);

  return { entities, assertions, edges };
}

// ─── INSERT HELPERS ───────────────────────────────────────────────────────────

/**
 * Write extracted entities/assertions/edges for one decision.
 * Mirrors the insert pattern from handoff.js writeExtraction (~1099-1130).
 *
 * SAFETY: assertions are always inserted with source='model_extracted' and
 * confidence=5.0 — this can never satisfy the CLAUDE.md auto-promotion gate
 * (requires confidence >= 9 AND source='user_stated'), per SECURITY.md trust model.
 *
 * @param {object} db         - Connected pg Client
 * @param {string} projectId  - Resolved project_id
 * @param {string} sid        - Deterministic session_id for this decision
 * @param {object} extraction - Parsed extraction { entities, assertions, edges }
 * @returns {Promise<{entitiesWritten, assertionsWritten, edgesWritten}>}
 */
async function writeDecisionExtraction(db, projectId, sid, extraction) {
  let entitiesWritten   = 0;
  let assertionsWritten = 0;
  let edgesWritten      = 0;

  // Entities — upsert pattern (ON CONFLICT DO UPDATE), session_id=sid
  for (const ent of extraction.entities) {
    await db.query(
      `INSERT INTO entities (project_id, name, entity_type, description, session_id)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (project_id, name) DO UPDATE
         SET entity_type  = EXCLUDED.entity_type,
             description  = EXCLUDED.description`,
      [projectId, ent.name, ent.entity_type, ent.description || null, sid]
    );
    entitiesWritten++;
  }

  // Assertions — plain INSERT (no unique constraint), fixed source + confidence
  // SAFETY: source is hardcoded 'model_extracted', confidence hardcoded 5.0.
  // These values can NEVER satisfy the auto-promotion gate (conf >= 9, source='user_stated').
  for (const ass of extraction.assertions) {
    await db.query(
      `INSERT INTO assertions
         (project_id, subject, predicate, object, confidence, source, session_id, last_reinforced)
       VALUES ($1, $2, $3, $4, $5, $6, $7, now())`,
      [projectId, ass.subject, ass.predicate, ass.object, ASSERTION_CONF, ASSERTION_SOURCE, sid]
    );
    assertionsWritten++;
  }

  // Edges — plain INSERT, default weight
  for (const edge of extraction.edges) {
    await db.query(
      `INSERT INTO edges (project_id, from_entity, edge_type, to_entity, weight, session_id)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [projectId, edge.from_entity, edge.edge_type, edge.to_entity, EDGE_WEIGHT_DEFAULT, sid]
    );
    edgesWritten++;
  }

  return { entitiesWritten, assertionsWritten, edgesWritten };
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────

async function main() {
  // ─── EMBED_SKIP GUARD (first — before any DB or LLM work) ───────────────
  if (process.env.EMBED_SKIP === '1') {
    console.log('[w2-extract] EMBED_SKIP=1 — no-op (LLM extraction skipped)');
    process.exit(0);
  }

  // ─── Argument parsing ─────────────────────────────────────────────────────
  const args     = process.argv.slice(2);
  const force    = args.includes('--force');
  const limitIdx = args.indexOf('--limit');
  const limit    = limitIdx !== -1 ? parseInt(args[limitIdx + 1], 10) : null;
  const decIdx   = args.indexOf('--decision');
  const singleId = decIdx !== -1 ? parseInt(args[decIdx + 1], 10) : null;

  // ─── DB name validation ───────────────────────────────────────────────────
  const rawTargetDb = process.env.HANDOFF_DB || 'claude_memory_eval_test';
  if (!_DB_NAME_RE.test(rawTargetDb)) {
    process.stderr.write(
      `Invalid HANDOFF_DB value "${rawTargetDb}" — must match /^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/.\n`
    );
    process.exit(1);
  }
  const TARGET_DB = rawTargetDb;

  const start = Date.now();

  // ── Connect to DB ──────────────────────────────────────────────────────────
  let db;
  try {
    db = await connectDb(TARGET_DB);
  } catch (err) {
    process.stderr.write(`[w2-extract] Fatal: DB connection failed: ${err.message}\n`);
    process.exit(1);
  }

  // ── Resolve project_id ────────────────────────────────────────────────────
  const projectId = resolveProjectId();

  // ── Fetch decisions ────────────────────────────────────────────────────────
  let rows;
  try {
    let query = `SELECT id, name, body FROM memory_entries WHERE mem_type='decision' ORDER BY id`;
    const params = [];

    if (singleId != null) {
      query = `SELECT id, name, body FROM memory_entries WHERE mem_type='decision' AND id = $1 ORDER BY id`;
      params.push(singleId);
    }

    const res = await db.query(query, params);
    rows = res.rows;

    if (limit != null && limit > 0) {
      rows = rows.slice(0, limit);
    }
  } catch (err) {
    process.stderr.write(`[w2-extract] Fatal: query failed: ${err.message}\n`);
    await db.end().catch(() => {});
    process.exit(1);
  }

  console.log(`[w2-extract] project_id=${projectId} db=${TARGET_DB} decisions=${rows.length}${force ? ' --force' : ''}`);

  // ── Process decisions ──────────────────────────────────────────────────────
  let processed = 0;
  let skipped   = 0;
  let failed    = 0;
  let totalEntities   = 0;
  let totalAssertions = 0;
  let totalEdges      = 0;

  for (const row of rows) {
    const sid = `w2-extract:decision:${row.id}`;

    try {
      // ── Idempotency check (join-based skip, no schema change) ──────────────
      if (!force) {
        const existing = await db.query(
          `SELECT 1 FROM assertions WHERE project_id = $1 AND session_id = $2 LIMIT 1`,
          [projectId, sid]
        );
        if (existing.rows.length > 0) {
          console.log(`[w2-extract] skip ${row.id} (already extracted)`);
          skipped++;
          continue;
        }
      } else {
        // --force: delete existing rows with this session_id from all three tables
        await db.query(
          `DELETE FROM assertions WHERE project_id = $1 AND session_id = $2`,
          [projectId, sid]
        );
        await db.query(
          `DELETE FROM edges WHERE project_id = $1 AND session_id = $2`,
          [projectId, sid]
        );
        // Entities: W2-owned rows carry the session_id; delete those
        await db.query(
          `DELETE FROM entities WHERE project_id = $1 AND session_id = $2`,
          [projectId, sid]
        );
      }

      // ── Build prompt and call Ollama ───────────────────────────────────────
      const prompt = buildPrompt(row.name || '', row.body || '');
      const raw    = await ollamaGenerate(prompt);

      if (raw == null) {
        console.error(`[w2-extract] decision ${row.id}: Ollama returned null — skipping`);
        failed++;
        continue;
      }

      // ── Parse extraction ──────────────────────────────────────────────────
      const extraction = parseExtraction(raw);
      if (extraction == null) {
        console.error(`[w2-extract] decision ${row.id}: parse failed — skipping (raw: ${raw.slice(0, 200)})`);
        failed++;
        continue;
      }

      // ── Insert ────────────────────────────────────────────────────────────
      const { entitiesWritten, assertionsWritten, edgesWritten } =
        await writeDecisionExtraction(db, projectId, sid, extraction);

      console.log(
        `[w2-extract] decision ${row.id}: +${entitiesWritten} entities, +${assertionsWritten} assertions, +${edgesWritten} edges`
      );

      totalEntities   += entitiesWritten;
      totalAssertions += assertionsWritten;
      totalEdges      += edgesWritten;
      processed++;

    } catch (err) {
      // Per-decision try/catch: one bad decision cannot abort the batch
      console.error(`[w2-extract] decision ${row.id}: unexpected error — ${err.message}`);
      failed++;
    }
  }

  await db.end().catch(() => {});

  // ── Summary ────────────────────────────────────────────────────────────────
  const ms = Date.now() - start;
  console.log('');
  console.log('─── bundleb-w2-extract summary ──────────────────────────────────────────────');
  console.log(`  Decisions total:    ${rows.length}`);
  console.log(`  Processed:          ${processed}`);
  console.log(`  Skipped (dup):      ${skipped}`);
  console.log(`  Failed:             ${failed}`);
  console.log(`  Entities inserted:  ${totalEntities}`);
  console.log(`  Assertions inserted:${totalAssertions}`);
  console.log(`  Edges inserted:     ${totalEdges}`);
  console.log(`  Duration:           ${(ms / 1000).toFixed(1)}s`);

  // Exit 0 on normal completion even if some decisions failed.
  // Only fatal setup errors (caught above) cause non-zero exit.
  process.exit(0);
}

// ─── EXPORTS & CLI ENTRY ─────────────────────────────────────────────────────

module.exports = { parseExtraction };

if (require.main === module) {
  main().catch((err) => {
    process.stderr.write(`[w2-extract] Unhandled error: ${err.message}\n`);
    process.exit(1);
  });
}
