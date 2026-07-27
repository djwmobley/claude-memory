'use strict';

/**
 * distill-corpus.js — 4D Bootstrap distillation migration script.
 *
 * Processes historical handoff corpus files in chronological order (enforcing
 * I-5 / OQ-1) and applies the cardinality-aware two-step supersession contract
 * (same WHERE-key as the steady-state write path) against the assertions table.
 *
 * Usage:
 *   node scripts/distill-corpus.js [--dry-run] [--db=<dbname>] [--project-root=<dir>]
 *
 * Flags:
 *   --dry-run        Extract and classify but do NOT write to the database.
 *   --db=<name>      Override target DB (default: HANDOFF_DB env or 'claude_memory_eval_test').
 *   --project-root=<dir>  Override project root (default: PROJECT_ROOT env or cwd).
 *
 * Corpus files enumerated (relative to --project-root):
 *   HANDOFF-2026-05-1*.md   (sorted ascending by filename date, then mtime)
 *   DEBATE-BUNDLE-A.md
 *   AS-IS-INTERSESSION-MEMORY.md
 *
 * Processing:
 *   For each file in sorted order:
 *     1. Check for a <filename>.ingested marker — skip if already ingested.
 *     2. Parse the file content looking for structured assertion blocks
 *        (the assertion JSON schema: {subject, predicate, object, confidence, source}).
 *
 *        *** MODEL EXTRACTION NOTE ***
 *        Per spec §7.2 step 2, a full implementation requires a model pass that
 *        reads each file and emits the JSON extraction payload (the same payload
 *        shape accepted by /handoff:close --json -). This script cannot call the
 *        active language model from within Node.js; it implements the database-side
 *        of the pipeline and provides a --payload-file=<path> flag so the caller
 *        can inject a pre-extracted JSON payload for a given source file.
 *
 *        **OQ (OPEN QUESTION, distillation):** Programmatic invocation of the
 *        extraction model from within this Node.js script is not currently
 *        implemented because the project has no committed model-provider SDK
 *        dependency and the extraction prompt is skill-defined in Claude Code
 *        commands (not a standalone function).  Recommended lean: introduce a
 *        provider-agnostic "extraction provider" interface (config-selected —
 *        e.g. a pipeline.yml setting choosing which provider's SDK/endpoint to
 *        call — never a single vendor's SDK hard-coded as the lean) + a
 *        dedicated extraction prompt in a follow-on commit and wire it here;
 *        the DB-write and supersession halves of the pipeline are already
 *        implemented and tested.  The existing skill-based path (running
 *        /handoff:close --json - with model-extracted JSON piped to stdin)
 *        remains the fully-operational path for production use, and is
 *        itself already provider-agnostic since it runs inside whatever
 *        MCP-speaking client the operator is using.
 *
 *     3. Apply cardinality-aware two-step supersession (same contract as 4A):
 *        1:1 predicates → suppress any live (project_id, subject, predicate) row.
 *        1:N predicates → suppress only exact (project_id, subject, predicate, object) dups.
 *        Each suppress+INSERT is wrapped in an explicit transaction (atomicity).
 *     4. After successful ingest, write a <filename>.ingested marker file.
 *
 *   After all files: run the §7.2 step-4 verification query.
 *   Output a summary of rows suppressed and inserted per file.
 *
 * Contract (OQ-5): This script applies the identical supersession WHERE-key as
 *   writeAssertionWithSupersession() in handoff.js.  The shared invariant test
 *   fixture in smoketest-handoff.js section "collision" verifies both paths.
 *
 * Exit codes: 0 success (or dry-run), 1 error.
 */

const fs   = require('fs');
const path = require('path');
const os   = require('os');

const { classifyPredicate, loadRegistry } = require('./lib/predicate-registry');
const { loadConfig }                       = require('./lib/shared');

// ─── ARGUMENT PARSING ────────────────────────────────────────────────────────

const args = process.argv.slice(2);

const dryRun = args.includes('--dry-run');

const dbArg = args.find((a) => a.startsWith('--db='));
const _rawDb = dbArg ? dbArg.slice(5) : (process.env.HANDOFF_DB || 'claude_memory_eval_test');
const _DB_NAME_RE = /^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/;
if (!_DB_NAME_RE.test(_rawDb)) {
  process.stderr.write(`distill-corpus: invalid DB name "${_rawDb}"\n`);
  process.exit(1);
}
const TARGET_DB = _rawDb;

const rootArg = args.find((a) => a.startsWith('--project-root='));
const PROJECT_ROOT = rootArg
  ? rootArg.slice(16)
  : (process.env.PROJECT_ROOT || process.cwd());

// --payload-file=<path>: inject a pre-extracted JSON payload for a named source file.
// May be specified multiple times: --payload-file=HANDOFF-2026-05-13.md:./extracted.json
const payloadFileArgs = args.filter((a) => a.startsWith('--payload-file='));
/** Map<sourceFileName, absolutePayloadPath> */
const payloadFileMap = new Map();
for (const arg of payloadFileArgs) {
  const val = arg.slice('--payload-file='.length);
  const colonIdx = val.indexOf(':');
  if (colonIdx === -1) {
    process.stderr.write(`distill-corpus: --payload-file must be in format <source>:<payload>, got "${arg}"\n`);
    process.exit(2);
  }
  payloadFileMap.set(val.slice(0, colonIdx), path.resolve(val.slice(colonIdx + 1)));
}

// ─── CORPUS FILE ENUMERATION ─────────────────────────────────────────────────

/**
 * Enumerate corpus files in the project root, sorted ascending by:
 *   1. The date string embedded in the filename (for HANDOFF-*.md files).
 *   2. Filesystem mtime (tiebreaker; also used for non-dated files).
 *
 * This enforces I-5 / OQ-1: the latest value wins for 1:1 predicates because
 * the last file processed sets the live row.
 *
 * @param {string} projectRoot
 * @returns {Array<{name: string, absPath: string, sortKey: string}>}
 */
function enumerateCorpusFiles(projectRoot) {
  const files = [];

  // Pattern 1: HANDOFF-2026-05-1*.md (date-prefixed handoff files)
  let dirEntries;
  try {
    dirEntries = fs.readdirSync(projectRoot);
  } catch (err) {
    throw new Error(`distill-corpus: cannot read project root "${projectRoot}": ${err.message}`);
  }

  for (const name of dirEntries) {
    if (/^HANDOFF-\d{4}-\d{2}-\d{2}/.test(name) && name.endsWith('.md')) {
      const absPath = path.join(projectRoot, name);
      // Extract date portion for sort (e.g. "2026-05-13b" → sort key includes suffix for stability).
      const dateMatch = name.match(/^HANDOFF-(\d{4}-\d{2}-\d{2}[a-z]*)/);
      const datePart  = dateMatch ? dateMatch[1] : '';
      let mtime = 0;
      try { mtime = fs.statSync(absPath).mtimeMs; } catch (_) {}
      files.push({ name, absPath, sortKey: `${datePart}_${String(mtime).padStart(20, '0')}` });
    }
  }

  // Pattern 2: fixed named files (no date in name → sort by mtime only).
  for (const fixedName of ['DEBATE-BUNDLE-A.md', 'AS-IS-INTERSESSION-MEMORY.md']) {
    const absPath = path.join(projectRoot, fixedName);
    if (fs.existsSync(absPath)) {
      let mtime = 0;
      try { mtime = fs.statSync(absPath).mtimeMs; } catch (_) {}
      // Fixed files sort after all HANDOFF-* files (use a high prefix so they come last
      // if they were created after the HANDOFF chain, which matches typical bootstrap order).
      files.push({ name: fixedName, absPath, sortKey: `9999-99-99_${String(mtime).padStart(20, '0')}` });
    }
  }

  // Sort ascending: earliest date first → last processed file wins for 1:1 predicates.
  files.sort((a, b) => a.sortKey.localeCompare(b.sortKey));

  return files;
}

// ─── DATABASE ────────────────────────────────────────────────────────────────

async function connectDb() {
  const { Client } = require('pg');
  const cfg = loadConfig();
  const client = new Client({
    host:     cfg.host,
    port:     cfg.port,
    database: TARGET_DB,
    user:     cfg.user,
  });
  await client.connect();
  return client;
}

/**
 * Resolve project_id for the PROJECT_ROOT using the same algorithm as handoff.js.
 * encodeCwd from shared is not re-exported; replicate the formula.
 */
function encodeProjectRoot(p) {
  return p.replace(/[/\\]+$/, '').replace(/[^A-Za-z0-9-]/g, '-');
}

// ─── SUPERSESSION (same contract as writeAssertionWithSupersession in handoff.js) ──

/**
 * Apply cardinality-aware supersession + INSERT for one assertion, within a
 * transaction (atomicity mechanism-a).
 *
 * This function implements the IDENTICAL supersession WHERE-key contract as
 * writeAssertionWithSupersession() in handoff.js.  The OQ-5 shared invariant
 * fixture tests both paths against the same contract.
 *
 * @param {object} db
 * @param {string} projectId
 * @param {object} ass     — {subject, predicate, object, confidence, source}
 * @param {string|null} sessionId
 * @param {string} mode    — 'permissive'|'strict'
 * @returns {{ inserted: boolean, cardinality: string }}
 */
async function applySupersession(db, projectId, ass, sessionId, mode) {
  let cardinality;
  try {
    const cls = classifyPredicate(ass.predicate, mode);
    if (!cls.recognized && mode !== 'strict') {
      process.stderr.write(
        `[distill] unrecognized predicate "${ass.predicate}" — permissive fallback 1:N\n`
      );
    }
    cardinality = cls.cardinality;
  } catch (err) {
    process.stderr.write(`[distill] skipping predicate "${ass.predicate}": ${err.message}\n`);
    return { inserted: false, cardinality: null };
  }

  const conf   = Math.min(10, Math.max(1, parseFloat(ass.confidence) || 5));
  const source = ['user_stated', 'model_extracted', 'doc_quoted', 'retrieved_from_prior'].includes(ass.source)
    ? ass.source : 'model_extracted';

  await db.query('BEGIN');
  try {
    if (cardinality === '1:1') {
      await db.query(
        `UPDATE assertions SET suppressed = true
         WHERE project_id = $1
           AND subject    = $2
           AND predicate  = $3
           AND suppressed = false`,
        [projectId, ass.subject, ass.predicate]
      );
    } else {
      await db.query(
        `UPDATE assertions SET suppressed = true
         WHERE project_id = $1
           AND subject    = $2
           AND predicate  = $3
           AND object     = $4
           AND suppressed = false`,
        [projectId, ass.subject, ass.predicate, ass.object]
      );
    }

    await db.query(
      `INSERT INTO assertions (project_id, subject, predicate, object, confidence, source, session_id, last_reinforced)
       VALUES ($1, $2, $3, $4, $5, $6, $7, now())`,
      [projectId, ass.subject, ass.predicate, ass.object, conf, source, sessionId]
    );

    await db.query('COMMIT');
  } catch (err) {
    try { await db.query('ROLLBACK'); } catch (_) {}
    throw err;
  }

  return { inserted: true, cardinality };
}

// ─── VERIFICATION (spec §7.2 step 4) ─────────────────────────────────────────

/**
 * Run the post-distillation verification query.
 * Returns true if I-1 is satisfied (zero 1:1-cardinality violations).
 */
async function runVerification(db, projectId) {
  // Collect all 1:1 predicates from the registry for the IN clause.
  const registry = loadRegistry();
  const one2onePredicates = [];
  for (const [pred, entry] of registry.byPredicate) {
    if (entry.cardinality === '1:1') one2onePredicates.push(pred);
  }

  if (one2onePredicates.length === 0) {
    console.log('  [verify] No 1:1 predicates in registry — nothing to check.');
    return true;
  }

  // Parameterized IN list.
  const placeholders = one2onePredicates.map((_, i) => `$${i + 2}`).join(', ');
  const { rows: violations } = await db.query(
    `SELECT subject, predicate, COUNT(*) AS live_count
     FROM assertions
     WHERE project_id = $1
       AND suppressed = false
       AND predicate IN (${placeholders})
     GROUP BY subject, predicate
     HAVING COUNT(*) > 1`,
    [projectId, ...one2onePredicates]
  );

  if (violations.length > 0) {
    console.log('  [verify] FAIL — 1:1 cardinality violations found:');
    for (const row of violations) {
      console.log(`    subject="${row.subject}" predicate="${row.predicate}" live_count=${row.live_count}`);
    }
    return false;
  }

  console.log('  [verify] PASS — no 1:1 cardinality violations (I-1 satisfied).');

  // Secondary check: no exact (subject, predicate, object) duplicates in live rows.
  const { rows: dupViolations } = await db.query(
    `SELECT subject, predicate, object, COUNT(*) AS n
     FROM assertions
     WHERE project_id = $1
       AND suppressed = false
     GROUP BY subject, predicate, object
     HAVING COUNT(*) > 1`,
    [projectId]
  );

  if (dupViolations.length > 0) {
    console.log('  [verify] FAIL — exact-duplicate live 1:N rows found:');
    for (const row of dupViolations) {
      console.log(`    subject="${row.subject}" predicate="${row.predicate}" object="${row.object}" n=${row.n}`);
    }
    return false;
  }

  console.log('  [verify] PASS — no exact-duplicate live rows (1:N constraint satisfied).');
  return true;
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`distill-corpus: project-root=${PROJECT_ROOT} db=${TARGET_DB}${dryRun ? ' [DRY-RUN]' : ''}`);

  const corpusFiles = enumerateCorpusFiles(PROJECT_ROOT);

  if (corpusFiles.length === 0) {
    console.log('distill-corpus: no corpus files found — nothing to do.');
    return;
  }

  console.log(`\nCorpus files (${corpusFiles.length}, sorted ascending):`);
  for (const f of corpusFiles) {
    const markerPath = f.absPath + '.ingested';
    const alreadyDone = fs.existsSync(markerPath);
    console.log(`  ${alreadyDone ? '[ingested] ' : '           '}${f.name}`);
  }
  console.log('');

  if (dryRun) {
    console.log('DRY-RUN: skipping DB writes and .ingested markers.');
    console.log('distill-corpus: dry-run complete.');
    return;
  }

  let db;
  try {
    db = await connectDb();
  } catch (err) {
    process.stderr.write(`distill-corpus: DB connection failed: ${err.message}\n`);
    process.exit(1);
  }

  const projectId = encodeProjectRoot(PROJECT_ROOT);
  let totalInserted  = 0;
  let totalSuppressed = 0;
  let totalSkipped   = 0;
  let filesProcessed = 0;

  for (const f of corpusFiles) {
    const markerPath = f.absPath + '.ingested';

    // Skip already-ingested files.
    if (fs.existsSync(markerPath)) {
      console.log(`[skip] ${f.name} (already ingested)`);
      continue;
    }

    // Resolve payload for this file.
    // Priority: --payload-file=<name>:<path> CLI arg, then attempt inline parse.
    let payload = null;
    const payloadPath = payloadFileMap.get(f.name);

    if (payloadPath) {
      try {
        const raw = fs.readFileSync(payloadPath, 'utf8');
        payload = JSON.parse(raw);
        console.log(`[file] ${f.name} — using injected payload from ${payloadPath}`);
      } catch (err) {
        process.stderr.write(`[distill] ERROR reading payload for ${f.name}: ${err.message}\n`);
        continue;
      }
    } else {
      // No model extraction available: emit a warning and skip DB writes for this file.
      // The .ingested marker is NOT written so the file remains re-processable once
      // a payload is provided via --payload-file.
      console.log(
        `[file] ${f.name} — no extracted payload available.\n` +
        `         To ingest: run model extraction on this file and pass the result via\n` +
        `         --payload-file=${f.name}:<path-to-json>\n` +
        `         See OQ in distill-corpus.js header for the programmatic extraction gap.`
      );
      continue;
    }

    // Apply the supersession for each assertion in the payload.
    const assertions = payload.assertions || [];
    console.log(`[file] ${f.name} — ${assertions.length} assertion(s) to process`);

    let fileInserted   = 0;
    let fileSuppressed = 0;
    let fileSkipped    = 0;

    const sessionId = payload.session_id || `distill:${f.name}`;

    for (const ass of assertions) {
      if (!ass.subject || !ass.predicate || !ass.object) { fileSkipped++; continue; }

      // Count how many live rows existed before suppression.
      const { rows: preCnt } = await db.query(
        `SELECT COUNT(*) AS n FROM assertions
         WHERE project_id = $1 AND subject = $2 AND predicate = $3 AND suppressed = false`,
        [projectId, ass.subject, ass.predicate]
      );
      const preCount = parseInt(preCnt[0].n, 10);

      const { inserted } = await applySupersession(db, projectId, ass, sessionId, 'permissive');

      if (inserted) {
        fileInserted++;
        fileSuppressed += preCount; // rows suppressed by this operation
      } else {
        fileSkipped++;
      }
    }

    totalInserted   += fileInserted;
    totalSuppressed += fileSuppressed;
    totalSkipped    += fileSkipped;
    filesProcessed++;

    console.log(
      `  → inserted=${fileInserted} suppressed=${fileSuppressed} skipped=${fileSkipped}`
    );

    // Write .ingested marker.
    try {
      fs.writeFileSync(markerPath, `distilled at ${new Date().toISOString()}\n`, 'utf8');
      console.log(`  → marker written: ${path.basename(markerPath)}`);
    } catch (markerErr) {
      process.stderr.write(`[distill] WARNING: could not write marker for ${f.name}: ${markerErr.message}\n`);
    }
  }

  console.log(`\nDistillation complete: ${filesProcessed} file(s) processed`);
  console.log(`  total inserted:   ${totalInserted}`);
  console.log(`  total suppressed: ${totalSuppressed}`);
  console.log(`  total skipped:    ${totalSkipped}`);

  // §7.2 step 4 verification.
  if (filesProcessed > 0) {
    console.log('\nRunning post-distillation verification query (spec §7.2 step 4):');
    const ok = await runVerification(db, projectId);
    if (!ok) {
      process.stderr.write('distill-corpus: verification FAILED — see output above\n');
      await db.end();
      process.exit(1);
    }
  }

  await db.end();
  console.log('\ndistill-corpus: done.');
}

main().catch((err) => {
  process.stderr.write(`distill-corpus: fatal error: ${err.message}\n`);
  if (process.env.DEBUG) process.stderr.write(err.stack + '\n');
  process.exit(1);
});
