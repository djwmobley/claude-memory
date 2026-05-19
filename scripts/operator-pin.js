'use strict';

/**
 * operator-pin.js — Insert operator-pinned canon assertions into the assertions store.
 *
 * Usage:
 *   node scripts/operator-pin.js --facts <path.json>               # dry run (default)
 *   node scripts/operator-pin.js --facts <path.json> --apply       # write to DB
 *   node scripts/operator-pin.js --facts <path.json> --project-id <id> --apply
 *
 * Contract:
 *   - Reads operator-supplied canon facts from a JSON file (array of
 *     {subject, predicate, object} objects).
 *   - Dry-run mode (default): prints the planned inserts; makes no DB changes.
 *   - --apply mode: inserts each fact as a fresh assertion row with:
 *       source='user_stated', pinned=true, confidence=10, tier='consolidated',
 *       consolidated_at=now(), corroboration_count=0, valid_at=now(),
 *       suppressed=false, invalid_at=NULL, session_id=NULL.
 *   - Idempotent: skips insert if an identical live
 *     (project_id, subject, predicate, object, pinned=true, suppressed=false) row exists.
 *   - Never DELETEs, UPDATEs, or touches the engine corpus.
 *   - Standalone only: NOT wired into the handoff.js subcommand dispatch map.
 *     Must be run directly: `node scripts/operator-pin.js`.
 *
 * Rows written here are eligible as quality corroborators in the L2 gate
 * (reality_check='verified' OR pinned=true) and as M2 seed-gate anchors
 * for the resurrect query type.
 *
 * See also: docs/specs/ for the L2/resurrect design record.
 */

const path = require('path');
const fs   = require('fs');

// Resolve PROJECT_ROOT before requiring shared modules so findProjectRoot()
// picks up the repo root rather than the scripts/ subdirectory.
if (!process.env.PROJECT_ROOT) {
  process.env.PROJECT_ROOT = path.resolve(__dirname, '..');
}

const { loadConfig } = require('./lib/shared');
const { encodeCwd }  = require('./lib/encoded-cwd');
const { Client }     = require('pg');

// ─── MAIN ─────────────────────────────────────────────────────────────────────

async function main() {
  const args      = process.argv.slice(2);
  const applyMode = args.includes('--apply');

  // --facts <path>
  const factsIdx  = args.indexOf('--facts');
  if (factsIdx === -1 || !args[factsIdx + 1]) {
    console.error('operator-pin: --facts <path.json> is required');
    process.exit(2);
  }
  const factsPath = args[factsIdx + 1];

  // --project-id <id>
  const pidIdx = args.indexOf('--project-id');
  let projectId;
  if (pidIdx !== -1 && args[pidIdx + 1]) {
    projectId = args[pidIdx + 1];
  } else {
    projectId = encodeCwd(process.env.PROJECT_ROOT);
  }

  // Load facts file.
  let facts;
  try {
    const raw = fs.readFileSync(factsPath, 'utf8');
    facts = JSON.parse(raw);
  } catch (err) {
    console.error(`operator-pin: cannot read facts file: ${err.message}`);
    process.exit(1);
  }
  if (!Array.isArray(facts)) {
    console.error('operator-pin: facts file must be a JSON array of {subject, predicate, object}');
    process.exit(1);
  }

  // Validate each entry.
  const validFacts = [];
  for (let i = 0; i < facts.length; i++) {
    const f = facts[i];
    if (!f || typeof f.subject !== 'string' || !f.subject.trim()) {
      console.error(`operator-pin: facts[${i}] missing or invalid "subject" — skipping`);
      continue;
    }
    if (typeof f.predicate !== 'string' || !f.predicate.trim()) {
      console.error(`operator-pin: facts[${i}] missing or invalid "predicate" — skipping`);
      continue;
    }
    if (typeof f.object !== 'string' || !f.object.trim()) {
      console.error(`operator-pin: facts[${i}] missing or invalid "object" — skipping`);
      continue;
    }
    validFacts.push({ subject: f.subject.trim(), predicate: f.predicate.trim(), object: f.object.trim() });
  }

  if (validFacts.length === 0) {
    console.error('operator-pin: no valid facts to process — exiting');
    process.exit(1);
  }

  // Connect — use pg Client directly (not connectHandoff) so this script is
  // non-model-invocable and uses separate creds from the main engine.
  const cfg = loadConfig();
  // SSL is governed by standard libpq / pg environment variables (e.g. PGSSLMODE),
  // not by pipeline.yml — loadConfig() does not return an ssl key.
  const client = new Client({
    host:     process.env.PGHOST     || cfg.host     || 'localhost',
    port:     parseInt(process.env.PGPORT || String(cfg.port || 5432), 10),
    database: process.env.PGDATABASE || cfg.database || 'postgres',
    user:     process.env.PGUSER     || cfg.user     || 'postgres',
    password: process.env.PGPASSWORD || cfg.password || undefined,
  });
  await client.connect();

  console.log('');
  console.log('=== operator-pin ===');
  console.log(`mode       : ${applyMode ? '--apply (WRITES ENABLED)' : 'dry-run (read-only, default)'}`);
  console.log(`project_id : ${projectId}`);
  console.log(`facts file : ${factsPath}`);
  console.log(`facts count: ${validFacts.length} (after validation)`);
  console.log('');

  // In --apply mode, wrap everything in a transaction for atomicity.
  if (applyMode) await client.query('BEGIN');

  let insertedCount = 0;
  let skippedCount  = 0;

  try {
    for (const { subject, predicate, object } of validFacts) {
      // Idempotency check: skip if an identical live pinned row already exists.
      const { rows: existing } = await client.query(
        `SELECT id FROM assertions
         WHERE project_id = $1
           AND subject    = $2
           AND predicate  = $3
           AND object     = $4
           AND pinned     = true
           AND suppressed = false
         LIMIT 1`,
        [projectId, subject, predicate, object]
      );

      if (existing.length > 0) {
        console.log(`  [skip]  ${subject} ${predicate} ${object}  (live pinned row already exists, id=${existing[0].id})`);
        skippedCount++;
        continue;
      }

      if (applyMode) {
        // INSERT directly — do NOT route through writeAssertionWithSupersession,
        // which deliberately omits the pinned column.
        await client.query(
          `INSERT INTO assertions
             (project_id, subject, predicate, object,
              confidence, source, pinned,
              tier, consolidated_at, corroboration_count,
              valid_at, suppressed, invalid_at, session_id,
              decay_rate)
           VALUES
             ($1, $2, $3, $4,
              10, 'user_stated', true,
              'consolidated', now(), 0,
              now(), false, NULL, NULL,
              0.05)`,
          [projectId, subject, predicate, object]
        );
        console.log(`  [insert] ${subject} ${predicate} ${object}`);
      } else {
        console.log(`  [dry]   ${subject} ${predicate} ${object}  (would insert pinned=true, conf=10, tier=consolidated)`);
      }
      insertedCount++;
    }

    if (applyMode) await client.query('COMMIT');
  } catch (err) {
    if (applyMode) {
      try { await client.query('ROLLBACK'); } catch (_) {}
    }
    console.error(`\noperator-pin: fatal error — ${err.message}`);
    await client.end();
    process.exit(1);
  }

  console.log('');
  if (applyMode) {
    console.log(`Inserted : ${insertedCount}`);
    console.log(`Skipped  : ${skippedCount} (already-live idempotency)`);
  } else {
    console.log(`Would insert: ${insertedCount}`);
    console.log(`Would skip  : ${skippedCount} (already-live idempotency)`);
    console.log('(run with --apply to execute)');
  }
  console.log('');

  await client.end();
}

main().catch((err) => {
  console.error('operator-pin: fatal error:', err.message);
  process.exit(1);
});
