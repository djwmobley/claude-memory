'use strict';

/**
 * backfill-assertion-embeddings.js — Backfill assertions.embedding (halfvec 4000)
 * for all live-project assertion rows whose embedding is currently NULL.
 *
 * Purpose: unblocks the resurrect semantic-seed cosine ANN path in production
 * by ensuring every assertion row has a halfvec embedding for the cosine
 * search in runResurrectQuery.
 *
 * Project-id resolution:
 *   Uses resolveProjectId() from handoff.js's own inline logic, replicated here
 *   because handoff.js does not export it as a module. Resolution order:
 *     1. --project-id=<id> CLI flag (explicit override)
 *     2. project marker UUID walked up from PROJECT_ROOT env or cwd
 *     3. encodeCwd(root) fallback for backward compatibility
 *   This mirrors exactly what cmdResurrect calls in handoff.js.
 *
 * DB connection:
 *   Database name from loadConfig() (pipeline.yml knowledge.database).
 *   Credentials from env: PGHOST / PGUSER / PGPASSWORD (defaults: localhost /
 *   postgres / postgres), PGPORT (default 5432). Honors HANDOFF_DB env override
 *   to match handoff.js's TARGET_DB resolution so the same DB is targeted.
 *
 * Embed strategy:
 *   Embeds row.subject only (no s/p/o concatenation). This is the confirmed
 *   design: the semantic seed at query time also embeds only the query text.
 *
 * Cast pattern (mirrors handoff.js:1985 runResurrectQuery):
 *   Bind '[v0,v1,...,v3999]' as a string, cast with $1::halfvec in SQL.
 *
 * Provenance (cm#201): every write is routed through the embedding_providers
 * -resolved DEFAULT provider object (row-driven endpoint/model/stored_dims
 * -- never embedQuery()/pipeline.yml's EMBED_DIMS env var, which this
 * script used before cm#201 and which had no notion of a provider id to
 * stamp). Resolved ONCE at the top of the run and reused for every row
 * (stamped-at-write-time semantics: a mid-run is_default flip by an
 * operator does NOT change which provider id this run's rows are stamped
 * with). Every UPDATE sets embedding AND embedded_by_provider_id together,
 * in the same statement. If the target database has NOT been through the
 * schema bring-forward that adds embedding_providers/embedded_by_provider_id
 * (e.g. claude_memory_eval_test as of 2026-08-18), this script REFUSES
 * loudly and writes nothing — never a provenance-less write, never a
 * silent skip.
 *
 * Usage:
 *   node scripts/dev/backfill-assertion-embeddings.js [--project-id=<id>]
 *       [--dry-run] [--batch-size=N] [--verbose]
 *
 *   --project-id=<id>  Explicit project UUID. Default: auto-resolve from cwd.
 *   --dry-run          Print count + 5 sample subjects, exit 0. No writes.
 *   --batch-size=N     Rows per BEGIN/COMMIT batch. Default: 10.
 *   --verbose          Per-row progress to stderr.
 *   --help             Print usage.
 */

const path = require('path');
const fs   = require('fs');

// ─── Module resolution ────────────────────────────────────────────────────────
// pg lives in scripts/node_modules. When this script runs inside a git worktree
// there are no node_modules next to scripts/package.json; the canonical location
// is the parent checkout's scripts/node_modules. We locate it by:
//   1. checking scripts/node_modules next to this file's scripts/ dir
//   2. falling back to the parent checkout, resolved via the .git pointer file

const SCRIPTS_DIR = path.resolve(__dirname, '..');
const REPO_ROOT   = path.resolve(SCRIPTS_DIR, '..');

function findScriptsNodeModules() {
  // Candidate 1: scripts/node_modules exists in the same scripts dir as this file
  const local = path.join(SCRIPTS_DIR, 'node_modules');
  if (fs.existsSync(path.join(local, 'pg'))) return local;

  // Candidate 2: derive parent checkout from .git pointer file
  const gitFile = path.join(REPO_ROOT, '.git');
  try {
    const gitContent = fs.readFileSync(gitFile, 'utf8').trim();
    // Format: "gitdir: <path-to-worktree-admin>"
    const m = gitContent.match(/^gitdir:\s*(.+)$/);
    if (m) {
      // worktree admin dir is <parent>/.git/worktrees/<name>
      // parent checkout .git dir is <parent>/.git
      // parent checkout root is three levels up from admin dir
      const adminDir    = path.resolve(REPO_ROOT, m[1].trim());
      const parentRoot  = path.resolve(adminDir, '..', '..', '..');
      const parentScripts = path.join(parentRoot, 'scripts', 'node_modules');
      if (fs.existsSync(path.join(parentScripts, 'pg'))) return parentScripts;
    }
  } catch (_) {}

  // Candidate 3: parent directory of REPO_ROOT may be the parent checkout
  // (e.g., repo root is .claude/worktrees/<name>, parent is .claude/worktrees)
  // Not useful — skip and let require fail with an informative message.
  return null;
}

const _pgModulesDir = findScriptsNodeModules();
if (!_pgModulesDir) {
  process.stderr.write(
    'ERROR: cannot locate scripts/node_modules/pg.\n' +
    `  Tried: ${path.join(SCRIPTS_DIR, 'node_modules', 'pg')}\n` +
    '  Fix: run `npm install` inside the scripts/ directory.\n'
  );
  process.exit(1);
}

// Node's CJS resolver for a required file (like shared.js) uses that file's own
// directory as the starting point for node_modules lookup — it does NOT inherit
// modifications to the parent script's require paths. The only pre-process-start
// mechanism is NODE_PATH. If NODE_PATH doesn't already include our modules dir,
// re-exec this process with it set. The flag _PATHS_INJECTED prevents recursion.
if (!process.env._PATHS_INJECTED) {
  const existing  = process.env.NODE_PATH || '';
  const newPath   = existing ? `${_pgModulesDir}${path.delimiter}${existing}` : _pgModulesDir;
  const { spawnSync } = require('child_process');
  const result = spawnSync(process.execPath, process.argv.slice(1), {
    env:   { ...process.env, NODE_PATH: newPath, _PATHS_INJECTED: '1' },
    stdio: 'inherit',
  });
  process.exit(result.status === null ? 1 : result.status);
}

const { Client } = require('pg');

// ─── Internal lib imports ─────────────────────────────────────────────────────

const { loadConfig, findProjectRoot }     = require('../lib/shared');
const embeddingProvider                    = require('../lib/embedding-provider');
const { findProjectRootByMarker, readMarker } = require('../lib/project-marker');
const { encodeCwd }                        = require('../lib/encoded-cwd');

// ─── Arg parsing ──────────────────────────────────────────────────────────────

const ARGS = process.argv.slice(2);

if (ARGS.includes('--help') || ARGS.includes('-h')) {
  console.log(`
Usage: node scripts/dev/backfill-assertion-embeddings.js [options]

Backfill assertions.embedding (halfvec 4000) for rows with NULL embedding.

Options:
  --project-id=<id>  Explicit project UUID to target.
                     Default: auto-resolved from cwd (project marker or
                     encodeCwd fallback), honoring PROJECT_ROOT env var.
  --dry-run          Count and sample rows that would be embedded; do not write.
  --batch-size=N     Rows per BEGIN/COMMIT batch (default: 10).
  --verbose          Per-row progress on stderr.
  --help             Show this message.

Environment:
  PROJECT_ROOT       Override cwd for project-id resolution.
  PGHOST             Postgres host (default: localhost).
  PGPORT             Postgres port (default: 5432).
  PGUSER             Postgres user (default: postgres).
  PGPASSWORD         Postgres password (default: postgres).
  HANDOFF_DB         Override database name (default: from pipeline.yml).

Provenance (cm#201): requires the target DB to carry embedding_providers AND
assertions.embedded_by_provider_id (bring it current via
migrate-07-reembed-corpus.js first if it does not) — this script refuses
loudly, writing nothing, if either is absent. Truncation dims are read from
the resolved default provider row's native_dims/stored_dims, not an env var.

Exit codes:
  0  Success (including dry-run).
  1  Error (DB failure, embed failure, config failure).
  2  Usage error.
`.trimStart());
  process.exit(0);
}

function parseFlag(name, defaultVal) {
  const flag = ARGS.find((a) => a.startsWith(`--${name}=`));
  if (flag) return flag.slice(name.length + 3);
  return defaultVal;
}

const DRY_RUN    = ARGS.includes('--dry-run');
const VERBOSE    = ARGS.includes('--verbose');
const BATCH_SIZE = Math.max(1, parseInt(parseFlag('batch-size', '10'), 10));
const ARG_PID    = parseFlag('project-id', null);

if (isNaN(BATCH_SIZE)) {
  process.stderr.write('ERROR: --batch-size must be a positive integer\n');
  process.exit(2);
}

// ─── Project-id resolution ────────────────────────────────────────────────────
// Mirrors resolveProjectId() in handoff.js (not exported, so replicated here).
// Resolution order: project marker UUID → encodeCwd fallback.

function resolveProjectId() {
  if (ARG_PID) return ARG_PID;
  const startDir  = process.env.PROJECT_ROOT || process.cwd();
  const markerRoot = findProjectRootByMarker(startDir);
  if (markerRoot) {
    const marker = readMarker(markerRoot);
    if (marker && marker.uuid) return marker.uuid;
  }
  // Fallback: encodeCwd of the project root (backward compat with legacy projects).
  const root = process.env.PROJECT_ROOT || findProjectRoot();
  return encodeCwd(root);
}

// ─── DB connection ────────────────────────────────────────────────────────────

function resolveDbName(cfg) {
  // Honor HANDOFF_DB override (same order as handoff.js TARGET_DB resolution).
  if (process.env.HANDOFF_DB) return process.env.HANDOFF_DB;
  if (cfg && cfg.database) return cfg.database;
  return 'claude_memory_eval_test';
}

async function connectDb(cfg) {
  const dbName = resolveDbName(cfg);
  const client = new Client({
    host:     process.env.PGHOST     || cfg.host     || 'localhost',
    port:     parseInt(process.env.PGPORT || String(cfg.port || 5432), 10),
    user:     process.env.PGUSER     || cfg.user     || 'postgres',
    password: process.env.PGPASSWORD || 'postgres',
    database: dbName,
  });
  await client.connect();
  return { client, dbName };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const t0 = Date.now();

  // ── Config + project-id ────────────────────────────────────────────────────

  let cfg;
  try {
    cfg = loadConfig();
  } catch (err) {
    process.stderr.write(`ERROR: loadConfig() failed — ${err.message}\n`);
    process.exit(1);
  }

  let projectId;
  try {
    projectId = resolveProjectId();
  } catch (err) {
    process.stderr.write(`ERROR: project-id resolution failed — ${err.message}\n`);
    process.exit(1);
  }

  // ── Connect ────────────────────────────────────────────────────────────────

  let client, dbName;
  try {
    ({ client, dbName } = await connectDb(cfg));
  } catch (err) {
    process.stderr.write(`ERROR: DB connection failed — ${err.message}\n`);
    process.exit(1);
  }

  console.log(`backfill-assertion-embeddings`);
  console.log(`  database   : ${dbName}`);
  console.log(`  project_id : ${projectId}`);
  console.log(`  dry_run    : ${DRY_RUN}`);
  console.log(`  batch_size : ${BATCH_SIZE}`);

  try {
    // ── cm#201 S-A.5: total-classify provenance readiness BEFORE any write ──
    // (a) embedding_providers table AND assertions.embedded_by_provider_id
    //     column both present -> stamped writes via the shared provider
    //     object (resolved ONCE for this whole run -- see below).
    // (b) either absent -> LOUD REFUSAL naming the missing object and the
    //     step that adds it. Never a provenance-less write, never a silent
    //     skip -- this mirrors the exact live gap found against
    //     claude_memory_eval_test (this script's own current default
    //     target, per resolveDbName() above): it has assertions.embedding
    //     but neither embedding_providers nor embedded_by_provider_id.
    const { rows: providerTableRows } = await client.query(
      `SELECT 1 FROM information_schema.tables WHERE table_schema = current_schema() AND table_name = 'embedding_providers'`
    );
    const hasProviderTable = providerTableRows.length > 0;
    const { rows: provenanceColRows } = await client.query(
      `SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'assertions' AND column_name = 'embedded_by_provider_id'`
    );
    const hasProvenanceColumn = provenanceColRows.length > 0;

    if (!hasProviderTable || !hasProvenanceColumn) {
      const missing = [
        !hasProviderTable ? '"embedding_providers" table' : null,
        !hasProvenanceColumn ? '"assertions.embedded_by_provider_id" column' : null,
      ].filter(Boolean).join(' and ');
      process.stderr.write(
        `ERROR: backfill-assertion-embeddings refuses to write "assertions".embedding without true provenance — ${missing} missing on database "${dbName}".\n` +
        `  Fix: bring this database through migrate-07-reembed-corpus.js (or the same schema bring-forward it applies via ` +
        `ensureProvenanceColumn) so embedding_providers exists and every embeddable table (including assertions) carries ` +
        `embedded_by_provider_id, then re-run this script. Never a provenance-less write, never a silent skip (cm#201).\n`
      );
      await client.end();
      process.exit(1);
    }

    // Resolve the default provider ONCE for this whole run (cm#201 S-A.5:
    // "stamped-at-write-time semantics on mid-run default flips -- do NOT
    // re-resolve per row" — every row this run embeds is attributed to the
    // SAME provider row this run resolved at startup, even if an operator
    // flips is_default mid-run). Wire call routes through the provider
    // object (row-driven endpoint/model/stored_dims) — never embedQuery()/
    // pipeline.yml (the provenance-truth rule: the stamped id must name the
    // provider object that ACTUALLY produced the vector).
    const providerRow = await embeddingProvider.resolveDefaultProvider(client);
    const provider = embeddingProvider.createProviderFromRow(providerRow);
    console.log(`  provider   : "${providerRow.name}" (id=${providerRow.id}, native_dims=${providerRow.native_dims}, stored_dims=${providerRow.stored_dims}, resolved once for this run)`);

    // ── Count already-embedded rows (for summary) ──────────────────────────

    const { rows: countRows } = await client.query(
      `SELECT
         COUNT(*) FILTER (WHERE embedding IS NULL)     AS null_count,
         COUNT(*) FILTER (WHERE embedding IS NOT NULL) AS embedded_count,
         COUNT(*)                                       AS total_count
       FROM assertions
       WHERE project_id = $1`,
      [projectId]
    );

    const nullCount     = parseInt(countRows[0].null_count,     10);
    const embeddedCount = parseInt(countRows[0].embedded_count, 10);
    const totalCount    = parseInt(countRows[0].total_count,    10);

    console.log(`  total_rows : ${totalCount}  (${embeddedCount} already embedded, ${nullCount} to embed)`);

    if (nullCount === 0) {
      console.log('\nDone: all rows already have embeddings. Nothing to do.');
      return;
    }

    // ── Dry-run path ───────────────────────────────────────────────────────

    if (DRY_RUN) {
      const { rows: sampleRows } = await client.query(
        `SELECT subject FROM assertions
         WHERE project_id = $1 AND embedding IS NULL
         ORDER BY id ASC
         LIMIT 5`,
        [projectId]
      );
      console.log(`\nDry-run: ${nullCount} row(s) would be embedded.`);
      console.log('Sample subjects (up to 5):');
      for (const r of sampleRows) {
        console.log(`  ${r.subject}`);
      }
      return;
    }

    // ── Live backfill ──────────────────────────────────────────────────────

    // Fetch all rows needing embedding in id order for deterministic progress.
    const { rows: pending } = await client.query(
      `SELECT id, subject FROM assertions
       WHERE project_id = $1 AND embedding IS NULL
       ORDER BY id ASC`,
      [projectId]
    );

    let embedded = 0;
    let errors   = 0;
    let batchNum = 0;

    for (let batchStart = 0; batchStart < pending.length; batchStart += BATCH_SIZE) {
      const batch = pending.slice(batchStart, batchStart + BATCH_SIZE);
      batchNum++;
      const batchEnd = Math.min(batchStart + BATCH_SIZE, pending.length);

      console.log(`[batch ${batchNum}] rows ${batchStart + 1}–${batchEnd} of ${pending.length}`);

      // Embed + accumulate vectors before opening the transaction so that a slow
      // vLLM call does not hold a DB transaction open across network round-trips.
      const updates = [];
      for (const row of batch) {
        try {
          const result = await provider.embed(row.subject);
          const vecLiteral = '[' + result.vector.join(',') + ']';
          updates.push({ id: row.id, subject: row.subject, vecLiteral });
          if (VERBOSE) {
            process.stderr.write(`  [${batchStart + updates.length}/${pending.length}] embedded id=${row.id} subject="${row.subject.slice(0, 60)}"\n`);
          }
        } catch (embedErr) {
          process.stderr.write(
            `ERROR: embed failed for id=${row.id} subject="${row.subject.slice(0, 80)}"\n` +
            `  ${embedErr.stack || embedErr.message}\n`
          );
          errors++;
          // Abort: fail loudly per spec — do not silently continue past failures.
          await client.end();
          process.exit(1);
        }
      }

      // Write batch atomically.
      try {
        await client.query('BEGIN');
        for (const u of updates) {
          // cm#201 invariant: this statement assigns embedding, so it ALSO
          // assigns embedded_by_provider_id, in the same statement -- the
          // run-resolved providerRow.id (stamped-at-write-time; never
          // re-resolved per row, see the total-classification note above).
          await client.query(
            'UPDATE assertions SET embedding = $1::halfvec, embedded_by_provider_id = $2 WHERE id = $3',
            [u.vecLiteral, providerRow.id, u.id]
          );
        }
        await client.query('COMMIT');
        embedded += updates.length;
      } catch (dbErr) {
        try { await client.query('ROLLBACK'); } catch (_) {}
        process.stderr.write(
          `ERROR: DB write failed for batch ${batchNum} (rows ${batchStart + 1}–${batchEnd})\n` +
          `  ${dbErr.stack || dbErr.message}\n`
        );
        errors++;
        await client.end();
        process.exit(1);
      }
    }

    const elapsedMs = Date.now() - t0;
    const elapsedS  = (elapsedMs / 1000).toFixed(1);

    console.log('');
    console.log('Summary:');
    console.log(`  embedded : ${embedded}`);
    console.log(`  skipped  : ${embeddedCount}  (already had embedding)`);
    console.log(`  errors   : ${errors}`);
    console.log(`  elapsed  : ${elapsedS}s`);

  } finally {
    try { await client.end(); } catch (_) {}
  }
}

main().catch((err) => {
  process.stderr.write(`FATAL: ${err.stack || err.message}\n`);
  process.exit(1);
});
