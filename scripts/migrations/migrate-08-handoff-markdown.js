'use strict';

/**
 * migrate-08-handoff-markdown.js
 *
 * CONSOLIDATION-RUNBOOK.md §6.1(h) + its H-1..H-14 spec-adversary
 * amendment (2026-08-16, memory-manager#11(h)): parses ONE project's
 * `HANDOFF.md` (active fat card) and `.claude/HANDOFF-HISTORY.md`
 * (append-only archive) into `assertions` rows on a memory-manager
 * consolidation target — the markdown-source PEER of the SQL-source
 * migrations (migrate-02 etc.), not an afterthought.
 *
 * H-13 (owner-declined scope, stated up front): this script was authored
 * and tested against SYNTHETIC fixtures only. It was never run against a
 * real project's HANDOFF.md/HANDOFF-HISTORY.md — access outside the
 * project sandbox was declined for this pass. The parser is written
 * generic + fail-soft specifically because of this: a real-file dry run
 * (owner-initiated, `--file`/`--history-file` pointed at the real paths)
 * is the actual acceptance gate, not this authoring pass.
 *
 * WHAT THIS SCRIPT DOES (normal / MIGRATE mode):
 *   1. Resolves + validates the TARGET database exactly like migrate-02
 *      (via migrate-01's classifyTarget, reused by reference).
 *   2. Bundles its own additive schema preamble (mirrors migrate-03's own
 *      bundled ALTER pattern, §6.1(d)):
 *        ALTER TABLE assertions ADD COLUMN IF NOT EXISTS seq INTEGER;
 *      PLUS (this script's own necessary addition — §6.1(h) base text
 *      point 3 requires tagging rows `authoring_mode='caveman'|'verbose'`
 *      but `assertions` carries no such column yet; only `decisions` and
 *      the §5.3 seam tables do):
 *        ALTER TABLE assertions ADD COLUMN IF NOT EXISTS authoring_mode TEXT
 *          CHECK (authoring_mode IN ('caveman','verbose'));
 *   3. Reads + H-10-normalizes `--file` (HANDOFF.md) and/or
 *      `--history-file` (HANDOFF-HISTORY.md) — at least one must exist;
 *      a missing file is fail-soft (0 sections from it, logged), not
 *      fatal, UNLESS both are missing/unreadable (nothing to migrate).
 *   4. Parses each file via scripts/lib/handoff-markdown-parse.js's total
 *      classification (H-5/H-8) into sections, then derives four
 *      assertion categories per H-1/H-4/H-7/H-11:
 *        - session_tldr_archived  (EVERY session-block section, in EITHER
 *          file — never live session_tldr, H-1)
 *        - open_thread             ("### Open carry-overs" tables nested
 *          in ANY section's body, in EITHER file — always
 *          carryover_status='open', H-4)
 *        - run_commands / critical_operational_notes / key_paths
 *          (durable-section headings, pinned=true)
 *        - next_step               ("## NEXT SESSION" section's list
 *          items, seq reassigned this run, H-11)
 *   5. Subject collisions within any one category (H-6) are loud named
 *      report events (`[SUBJECT-COLLISION]`) — never silently
 *      overwritten; both/all colliding rows are still written (categories
 *      other than the live 1:1 predicates are 1:N-safe by construction).
 *   6. Re-run semantics (H-6): per-project DELETE of this script's own
 *      `source_model='markdown-migration-h'` rows, then bulk INSERT of
 *      every freshly-parsed row, in ONE transaction — idempotent by
 *      construction (unchanged source file -> unchanged resulting rows),
 *      never a per-row upsert key.
 *   7. Writes migration_manifest + migration_manifest_row_hashes per
 *      logical slice (source_table one of: handoff_active_session_summary
 *      / handoff_open_carryovers / handoff_durable_sections /
 *      handoff_next_session_items for HANDOFF.md; handoff_history_
 *      session_blocks / handoff_history_open_carryovers for
 *      HANDOFF-HISTORY.md — see SLICE_NAMES), source_db =
 *      `filesystem:<H-14-normalized path>`, in the SAME transaction as
 *      that slice's assertion rows (mirrors migrate-02's D-5/D-11
 *      per-slice atomicity).
 *   8. Writes a per-project fail-soft report
 *      (`handoff-markdown-parse-report-<project>-<ts>.json` under
 *      scripts/migrations/reports/, gitignored) covering: sections found/
 *      unmatched, raw-line vs parsed-row tallies, H-12's per-block
 *      body-length-delta flags, H-10's unrecognized-dash flags, H-6's
 *      subject-collision events, H-9's flagged (wrong-cell-count) table
 *      rows, and H-11's dropped stray-list-line notes.
 *
 * ROLLBACK MODE (--rollback): deletes every `assertions` row tagged
 * `source_model='markdown-migration-h' AND project_id=$1` (point 7 of the
 * base spec), plus this run's migration_manifest(+row_hashes) rows for
 * this project_id, in ONE transaction.
 *
 * WHAT THIS SCRIPT DELIBERATELY DOES NOT DO (out of scope):
 *   - No inter-session diff / resolved-carryover detection (H-4 — every
 *     parsed carryover row is 'open' by construction).
 *   - No project_id derivation from a file path (D3-1's "never decode a
 *     path to guess an identity" principle applies here too) — the
 *     caller MUST pass --project-id explicitly.
 *   - No wiring into the verify-15-*.js battery beyond the two roster
 *     rows H-2 requires (handoff_next_session_items /
 *     handoff_active_session_summary) — see this script's PR body for the
 *     exact rows and the blind-spot this leaves for the other four slices.
 *
 * Usage:
 *   node scripts/migrations/migrate-08-handoff-markdown.js --db <target>
 *     --project-id <id> [--file <HANDOFF.md path>]
 *     [--history-file <HANDOFF-HISTORY.md path>]
 *     [--headings-config <path>] [--authoring-mode caveman|verbose]
 *     [--rollback] [--report-dir <path>]
 *
 * Exit codes: 0 = PASS, 1 = refused / failure, 2 = bad CLI usage.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Client } = require('pg');

const migrateOne = require('./migrate-01-canonical-db'); // reused by reference, never forked
const shared = require('./lib/verify15-shared'); // reused by reference: connect config, rowHash, applyDdl
const { deriveIntentSubject } = require('../handoff.js'); // reused by reference (H-3/H-7), never reimplemented
const { AUTHORING_MODE_VALUES } = require('../lib/memory-upsert.js'); // reused by reference, never a second Set
const mdParse = require('../lib/handoff-markdown-parse.js');
const { filesystemSourceDb } = require('../lib/fs-path-normalize.js'); // H-14: same normalizer roster entries use

const MIGRATIONS_DIR = __dirname;
const DEFAULT_HEADINGS_CONFIG_PATH = path.join(MIGRATIONS_DIR, 'handoff-section-headings.json');
const DEFAULT_REPORT_DIR = path.join(MIGRATIONS_DIR, 'reports');

const SOURCE_MODEL_TAG = 'markdown-migration-h';
const DEFAULT_CONFIDENCE = 8;
const SOURCE_VALUE = 'doc_quoted'; // valid per assertions' source CHECK: quoted verbatim from a markdown document
const TIER_VALUE = 'consolidated'; // durable/already-established historical record, not fresh probationary extraction
const LOAD_BEARING_COLS = ['subject', 'object']; // hashed as-persisted, matching migrate-02's "mirror the inserted columns" convention

const DDL_PREAMBLE_SQL = [
  'ALTER TABLE assertions ADD COLUMN IF NOT EXISTS seq INTEGER',
  "ALTER TABLE assertions ADD COLUMN IF NOT EXISTS authoring_mode TEXT CHECK (authoring_mode IN ('caveman','verbose'))",
];

// Logical manifest slice names (source_table) — H-2 requires roster rows
// for exactly the two ACTIVE-file (HANDOFF.md) slices named below; see
// this script's PR body / report for the exact rows to add and the
// documented blind spot the other four slices carry (no roster/verify-15
// battery coverage yet).
const SLICE_NAMES = {
  ACTIVE_SESSION_SUMMARY: 'handoff_active_session_summary',
  ACTIVE_OPEN_CARRYOVERS: 'handoff_open_carryovers',
  ACTIVE_DURABLE_SECTIONS: 'handoff_durable_sections',
  ACTIVE_NEXT_SESSION_ITEMS: 'handoff_next_session_items',
  HISTORY_SESSION_BLOCKS: 'handoff_history_session_blocks',
  HISTORY_OPEN_CARRYOVERS: 'handoff_history_open_carryovers',
  // Fail-soft edge case: a durable-section or NEXT-SESSION heading found
  // INSIDE the archive file (unexpected but not dropped — total
  // classification never silently discards a real match). Fixed constant
  // names (not template-string-built at call sites) so runRollback's
  // Object.values(SLICE_NAMES) enumeration covers them too.
  HISTORY_DURABLE_SECTIONS: 'handoff_durable_sections_in_history',
  HISTORY_NEXT_SESSION_ITEMS: 'handoff_next_session_items_in_history',
};

// ─── CLI ARGS ─────────────────────────────────────────────────────────────

class UsageError extends Error {}

function parseArgs(argv) {
  const parsed = {
    db: null, projectId: null, file: null, historyFile: null,
    headingsConfig: DEFAULT_HEADINGS_CONFIG_PATH, authoringMode: 'verbose',
    rollback: false, reportDir: DEFAULT_REPORT_DIR, help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--db') parsed.db = argv[++i];
    else if (a.startsWith('--db=')) parsed.db = a.slice('--db='.length);
    else if (a === '--project-id') parsed.projectId = argv[++i];
    else if (a.startsWith('--project-id=')) parsed.projectId = a.slice('--project-id='.length);
    else if (a === '--file') parsed.file = argv[++i];
    else if (a.startsWith('--file=')) parsed.file = a.slice('--file='.length);
    else if (a === '--history-file') parsed.historyFile = argv[++i];
    else if (a.startsWith('--history-file=')) parsed.historyFile = a.slice('--history-file='.length);
    else if (a === '--headings-config') parsed.headingsConfig = argv[++i];
    else if (a.startsWith('--headings-config=')) parsed.headingsConfig = a.slice('--headings-config='.length);
    else if (a === '--authoring-mode') parsed.authoringMode = argv[++i];
    else if (a.startsWith('--authoring-mode=')) parsed.authoringMode = a.slice('--authoring-mode='.length);
    else if (a === '--rollback') parsed.rollback = true;
    else if (a === '--report-dir') parsed.reportDir = argv[++i];
    else if (a.startsWith('--report-dir=')) parsed.reportDir = a.slice('--report-dir='.length);
    else if (a === '--help' || a === '-h') parsed.help = true;
    else throw new UsageError(`Unknown argument: ${a}`);
  }
  return parsed;
}

function printUsage() {
  console.log([
    'Usage: node scripts/migrations/migrate-08-handoff-markdown.js --db <target> --project-id <id>',
    '         [--file <HANDOFF.md path>] [--history-file <HANDOFF-HISTORY.md path>]',
    '         [--headings-config <path>] [--authoring-mode caveman|verbose]',
    '         [--rollback] [--report-dir <path>]',
    '',
    '  --db <name>            Target database (else MIGRATE_TARGET_DB env, else memory_manager_staging).',
    '  --project-id <id>      Required. Never derived/guessed from a file path.',
    '  --file <path>          HANDOFF.md (active fat card). Optional if --history-file is given.',
    '  --history-file <path>  HANDOFF-HISTORY.md (archive). Optional if --file is given.',
    '  --headings-config <p>  Durable-section headings config (default: handoff-section-headings.json).',
    '  --authoring-mode <m>   "caveman" or "verbose" — tags every row this run writes (default: verbose).',
    '  --rollback             Delete this project\'s migrated rows + manifest slices instead of migrating.',
    '  --report-dir <path>    Directory for the per-project fail-soft parse report (default: ./reports).',
  ].join('\n'));
}

// ─── FILE LOADING (fail-soft per file) ─────────────────────────────────────

function loadAndNormalizeFile(filePath) {
  if (!filePath) return { present: false, path: null, normalized: null, readError: null };
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    return { present: false, path: filePath, normalized: null, readError: err.message };
  }
  const normalized = mdParse.normalizeMarkdown(raw);
  return { present: true, path: filePath, normalized, readError: null };
}

// ─── PARSE ONE FILE INTO CATEGORIZED ROWS ─────────────────────────────────

/**
 * parseFileIntoRows — runs the total classification over one already-
 * normalized file and produces the four assertion-category row lists PLUS
 * a per-file report fragment. Pure (no I/O, no DB).
 *
 * @param {string} normalizedText
 * @param {Array<{canonical:string, predicate:string}>} durableHeadings
 * @param {'active'|'history'} fileKind
 * @returns {{
 *   sessionTldrRows: Array, openThreadRows: Array, durableRows: Array, nextStepRows: Array,
 *   report: object,
 * }}
 */
function parseFileIntoRows(normalizedText, durableHeadings, fileKind) {
  const sections = mdParse.splitDocumentIntoSections(normalizedText, durableHeadings);

  const sessionTldrRows = [];
  const openThreadRows = [];
  const durableRows = [];
  const nextStepRows = [];

  const unknownHeadings = [];
  const flaggedTableRows = [];
  let nextSeq = 0;

  for (const section of sections) {
    // H-4/base-point-3: "### Open carry-overs" tables can appear inside
    // ANY section's body (active preamble OR an archived session block) —
    // extracted uniformly regardless of the enclosing section's type.
    const tables = mdParse.findOpenCarryoverTables(section.bodyText, section.bodyStartLine);
    for (const table of tables) {
      for (const row of table.rows) {
        openThreadRows.push({
          subject: deriveIntentSubject(row.subjectRaw),
          object: row.objectRaw,
          sourceLineNo: row.lineNo,
        });
      }
      for (const flagged of table.flaggedRows) {
        flaggedTableRows.push({ ...flagged, enclosingHeadingLineNo: section.headingLineNo });
      }
    }

    if (section.type === 'session') {
      const headingText = section.headingLine.replace(/^##\s+/, '').trim();
      const parsedDate = new Date(section.classification.date);
      const validDate = !Number.isNaN(parsedDate.getTime());
      sessionTldrRows.push({
        subject: headingText,
        object: section.bodyText,
        createdAt: validDate ? parsedDate : null,
        dateParseFailed: !validDate,
        rawDate: section.classification.date,
        headingLineNo: section.headingLineNo,
        rawLineSpan: section.rawLineSpan,
      });
    } else if (section.type === 'durable') {
      durableRows.push({
        subject: section.classification.canonical,
        predicate: section.classification.predicate,
        object: section.bodyText.trim(),
        headingLineNo: section.headingLineNo,
      });
    } else if (section.type === 'next_session') {
      const items = mdParse.parseNextSessionItems(section.bodyText);
      for (const itemText of items) {
        nextSeq += 1;
        nextStepRows.push({
          subject: deriveIntentSubject(itemText),
          object: itemText,
          seq: nextSeq,
          headingLineNo: section.headingLineNo,
        });
      }
    } else if (section.type === 'unknown') {
      unknownHeadings.push({ headingLine: section.headingLine, headingLineNo: section.headingLineNo });
    }
    // type === 'session' already handled; durable/next_session/unknown above.
  }

  // H-12: per-block body-length-delta heuristic, computed over this FILE's
  // own session blocks only (same-file-relative, see handoff-markdown-
  // parse.js's computeBodyLengthDeltaFlags header comment).
  const bodyLengthDeltaFlags = mdParse.computeBodyLengthDeltaFlags(
    sessionTldrRows.map((r) => ({ headingLineNo: r.headingLineNo, rawLineSpan: r.rawLineSpan }))
  );

  // H-6: subject collisions within each category, this file only (cross-
  // file collisions are reported separately by the caller after merging).
  const collisions = {
    session_tldr_archived: findCollisions(sessionTldrRows, (r) => r.subject),
    open_thread: findCollisions(openThreadRows, (r) => r.subject),
    durable: findCollisions(durableRows, (r) => `${r.predicate}::${r.subject}`),
    next_step: findCollisions(nextStepRows, (r) => r.subject),
  };

  const totalRawLines = normalizedText.split('\n').length;
  const parsedRowCount = sessionTldrRows.length + openThreadRows.length + durableRows.length + nextStepRows.length;

  return {
    sessionTldrRows,
    openThreadRows,
    durableRows,
    nextStepRows,
    report: {
      fileKind,
      sectionsFound: sections.length,
      sectionTypeCounts: countByType(sections),
      unknownHeadings,
      flaggedTableRows,
      bodyLengthDeltaFlags,
      collisions,
      totalRawLines,
      parsedRowCount,
    },
  };
}

function countByType(sections) {
  const counts = {};
  for (const s of sections) counts[s.type] = (counts[s.type] || 0) + 1;
  return counts;
}

/** H-6: returns [{key, count}] for every key appearing 2+ times. */
function findCollisions(rows, keyFn) {
  const counts = new Map();
  for (const r of rows) {
    const k = keyFn(r);
    counts.set(k, (counts.get(k) || 0) + 1);
  }
  const collisions = [];
  for (const [k, n] of counts) {
    if (n > 1) collisions.push({ key: k, count: n });
  }
  return collisions;
}

// ─── CONTENT FINGERPRINT (T1 convention, mirrors migrate-02) ─────────────

function computeContentFingerprint(rowsOrderedForHash) {
  const concatenated = rowsOrderedForHash.map((r) => shared.rowHash(LOAD_BEARING_COLS, r)).join('');
  return crypto.createHash('md5').update(concatenated).digest('hex');
}

// ─── WHOLE-PROJECT WRITE (H-6: "per-project delete-and-reinsert ... in one
// transaction" — deliberately NOT per-slice. A per-slice delete scoped by
// predicate would be unsound here: session_tldr_archived rows come from
// BOTH the active-file slice and the history-file slice, so a
// predicate-scoped per-slice delete would clobber the OTHER slice's rows
// written earlier in the same run (or a prior run). The correct H-6
// mechanism is ONE delete of every row this project's markdown migration
// has ever written (unconditional on predicate, scoped only by
// project_id + source_model), followed by inserting every freshly-parsed
// row from every slice, all inside one transaction. Manifest bookkeeping
// (migration_manifest/_row_hashes) stays per-slice — that is pure
// reporting metadata, not the write-scope problem above. ────────────────

/**
 * writeProjectMigration — the H-6 whole-project delete-and-reinsert.
 *
 * @param {Array<{sourceDb, sourceTable, rows}>} slices - rows are
 *   {subject, predicate, object, pinned, carryoverStatus, seq, createdAt}
 */
async function writeProjectMigration(tgtClient, { projectId, authoringMode, slices }) {
  await tgtClient.query('BEGIN');
  let totalWritten = 0;
  try {
    // ONE unconditional delete of this project's entire markdown-migration
    // footprint — matches the base spec's rollback command exactly
    // (point 7: "DELETE FROM assertions WHERE source_model =
    // 'markdown-migration-h' AND project_id = '<project>'").
    await tgtClient.query(
      `DELETE FROM assertions WHERE project_id = $1 AND source_model = $2`,
      [projectId, SOURCE_MODEL_TAG]
    );

    for (const slice of slices) {
      for (const row of slice.rows) {
        await tgtClient.query(
          `INSERT INTO assertions
             (project_id, subject, predicate, object, confidence, source, tier,
              pinned, carryover_status, seq, source_model, authoring_mode, created_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12, COALESCE($13, now()))`,
          [
            projectId, row.subject, row.predicate, row.object, DEFAULT_CONFIDENCE, SOURCE_VALUE, TIER_VALUE,
            !!row.pinned, row.carryoverStatus || null, row.seq ?? null, SOURCE_MODEL_TAG, authoringMode,
            row.createdAt || null,
          ]
        );
        totalWritten += 1;
      }

      // Manifest bookkeeping is per-slice (T1/T3 coverage, base point 6) —
      // ALWAYS written (even row_count=0) so a slice whose content
      // vanished between runs still reflects "0 rows this run" rather
      // than leaving a stale nonzero manifest row behind.
      await tgtClient.query(
        `DELETE FROM migration_manifest WHERE source_db=$1 AND source_table=$2 AND project_id_or_null=$3`,
        [slice.sourceDb, slice.sourceTable, projectId]
      );
      await tgtClient.query(
        `DELETE FROM migration_manifest_row_hashes WHERE source_db=$1 AND source_table=$2 AND project_id_or_null=$3`,
        [slice.sourceDb, slice.sourceTable, projectId]
      );
      const fingerprint = computeContentFingerprint(slice.rows);
      await tgtClient.query(
        `INSERT INTO migration_manifest (source_db, source_table, project_id_or_null, row_count, content_fingerprint, excluded_reason)
         VALUES ($1,$2,$3,$4,$5,NULL)`,
        [slice.sourceDb, slice.sourceTable, projectId, slice.rows.length, fingerprint]
      );
      let idx = 0;
      for (const row of slice.rows) {
        idx += 1;
        const h = shared.rowHash(LOAD_BEARING_COLS, row);
        await tgtClient.query(
          `INSERT INTO migration_manifest_row_hashes (source_db, source_table, project_id_or_null, source_row_id, source_hash)
           VALUES ($1,$2,$3,$4,$5)`,
          [slice.sourceDb, slice.sourceTable, projectId, `row:${idx}`, h]
        );
      }
    }

    await tgtClient.query('COMMIT');
  } catch (err) {
    await tgtClient.query('ROLLBACK');
    throw err;
  }
  return { totalWritten };
}

// ─── ROLLBACK MODE ─────────────────────────────────────────────────────────

async function runRollback(tgtClient, projectId) {
  await tgtClient.query('BEGIN');
  let deletedAssertions = 0;
  let deletedManifest = 0;
  let deletedHashes = 0;
  try {
    const del = await tgtClient.query(
      `DELETE FROM assertions WHERE project_id = $1 AND source_model = $2`,
      [projectId, SOURCE_MODEL_TAG]
    );
    deletedAssertions = del.rowCount;
    const delManifest = await tgtClient.query(
      `DELETE FROM migration_manifest WHERE project_id_or_null = $1 AND source_table = ANY($2::text[])`,
      [projectId, Object.values(SLICE_NAMES)]
    );
    deletedManifest = delManifest.rowCount;
    const delHashes = await tgtClient.query(
      `DELETE FROM migration_manifest_row_hashes WHERE project_id_or_null = $1 AND source_table = ANY($2::text[])`,
      [projectId, Object.values(SLICE_NAMES)]
    );
    deletedHashes = delHashes.rowCount;
    await tgtClient.query('COMMIT');
  } catch (err) {
    await tgtClient.query('ROLLBACK');
    throw err;
  }
  console.log(`  [OK] deleted ${deletedAssertions} assertions row(s), ${deletedManifest} migration_manifest row(s), ${deletedHashes} migration_manifest_row_hashes row(s)`);
  console.log(`ROLLBACK_RESULT: PASS (deleted ${deletedAssertions} assertions row(s))`);
  return { deletedAssertions, deletedManifest, deletedHashes };
}

// ─── MAIN ───────────────────────────────────────────────────────────────────

async function main() {
  let parsed;
  try {
    parsed = parseArgs(process.argv.slice(2));
  } catch (err) {
    if (err instanceof UsageError) {
      console.error(`Error: ${err.message}`);
      printUsage();
      process.exit(2);
    }
    throw err;
  }
  if (parsed.help) {
    printUsage();
    process.exit(0);
  }
  if (!parsed.projectId) {
    console.error('Refused: --project-id is required (never derived/guessed from a file path).');
    process.exit(2);
  }
  if (!parsed.rollback && !parsed.file && !parsed.historyFile) {
    console.error('Refused: at least one of --file / --history-file is required (nothing to migrate).');
    process.exit(2);
  }
  if (!AUTHORING_MODE_VALUES.has(parsed.authoringMode)) {
    console.error(`Invalid --authoring-mode "${parsed.authoringMode}" — must be "caveman" or "verbose".`);
    process.exit(2);
  }

  const { name: target, source: targetSource } = migrateOne.resolveTargetDb({ db: parsed.db });
  if (!migrateOne.DB_NAME_RE.test(target)) {
    console.error(`Invalid database name "${target}" (from ${targetSource}) — must match /^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/.`);
    process.exit(1);
  }
  const classification = migrateOne.classifyTarget(target);
  if (!classification.allowed) {
    console.error(`Refused: ${classification.reason}`);
    console.error(`(resolved from ${targetSource} — no database connection was opened.)`);
    process.exit(1);
  }

  console.log(`migrate-08-handoff-markdown: target="${target}" (resolved from ${targetSource}) project_id="${parsed.projectId}" mode=${parsed.rollback ? 'ROLLBACK' : 'MIGRATE'}`);

  const tgtClient = new Client(migrateOne.pgConfig(target));
  try {
    await tgtClient.connect();
  } catch (err) {
    console.error(`Could not connect to target database "${target}": ${err.message}`);
    process.exit(1);
  }

  let exitCode = 0;
  try {
    const { rows: tblRows } = await tgtClient.query(
      `SELECT 1 FROM information_schema.tables WHERE table_schema = current_schema() AND table_name = 'assertions' AND table_type = 'BASE TABLE'`
    );
    if (tblRows.length === 0) {
      console.error(`Refused: target "${target}" is missing the "assertions" table.`);
      console.error('Run migrate-01-canonical-db.js against this target first. Nothing was applied.');
      process.exitCode = 1;
      return;
    }

    // Precondition: source_model/agent_id (attribution-columns.sql) and
    // carryover_status (migrate-06-carryover-status.sql) are pre-existing
    // generic assertions columns from already-shipped §7-era addenda, NOT
    // something this §6.1(h) migration bundles itself (this script's own
    // DDL_PREAMBLE_SQL only adds what §6.1(h) actually introduces: seq +
    // authoring_mode). Checked explicitly here so a target that only ran
    // migrate-01 gets a clear, actionable refusal instead of a raw
    // "column does not exist" SQL error mid-transaction.
    const { rows: reqCols } = await tgtClient.query(
      `SELECT column_name FROM information_schema.columns WHERE table_name='assertions' AND column_name IN ('source_model','carryover_status')`
    );
    if (reqCols.length < 2) {
      console.error(`Refused: target "${target}"'s "assertions" table is missing source_model and/or carryover_status.`);
      console.error('Run migrate-schema-addenda.js against this target first (attribution-columns.sql + migrate-06-carryover-status.sql). Nothing was applied.');
      process.exitCode = 1;
      return;
    }

    await shared.applyDdl(tgtClient); // migration_manifest + siblings, idempotent
    for (const stmt of DDL_PREAMBLE_SQL) {
      await tgtClient.query(stmt);
      console.log(`  [OK] ${stmt}`);
    }

    if (parsed.rollback) {
      await runRollback(tgtClient, parsed.projectId);
      exitCode = 0;
      return;
    }

    const headingsConfig = loadHeadingsConfig(parsed.headingsConfig);

    const activeFile = loadAndNormalizeFile(parsed.file);
    const historyFile = loadAndNormalizeFile(parsed.historyFile);

    if (parsed.file && !activeFile.present) {
      console.log(`  [FAIL-SOFT] could not read --file "${parsed.file}": ${activeFile.readError}`);
    }
    if (parsed.historyFile && !historyFile.present) {
      console.log(`  [FAIL-SOFT] could not read --history-file "${parsed.historyFile}": ${historyFile.readError}`);
    }
    if (!activeFile.present && !historyFile.present) {
      console.error('Refused: neither --file nor --history-file could be read. Nothing was applied.');
      process.exitCode = 1;
      return;
    }

    for (const flag of [...(activeFile.normalized ? activeFile.normalized.flags : []), ...(historyFile.normalized ? historyFile.normalized.flags : [])]) {
      console.log(`  [FLAG] unrecognized-dash at line ${flag.line}: "${flag.char}" (H-10 — not silently coerced)`);
    }

    const activeParsed = activeFile.present
      ? parseFileIntoRows(activeFile.normalized.text, headingsConfig.headings, 'active')
      : null;
    const historyParsed = historyFile.present
      ? parseFileIntoRows(historyFile.normalized.text, headingsConfig.headings, 'history')
      : null;

    const slices = [];
    if (activeParsed) {
      const activeSourceDb = filesystemSourceDb(parsed.file);
      slices.push({ sourceDb: activeSourceDb, sourceTable: SLICE_NAMES.ACTIVE_SESSION_SUMMARY, rows: toSessionAssertionRows(activeParsed.sessionTldrRows) });
      slices.push({ sourceDb: activeSourceDb, sourceTable: SLICE_NAMES.ACTIVE_OPEN_CARRYOVERS, rows: toOpenThreadAssertionRows(activeParsed.openThreadRows) });
      slices.push({ sourceDb: activeSourceDb, sourceTable: SLICE_NAMES.ACTIVE_DURABLE_SECTIONS, rows: toDurableAssertionRows(activeParsed.durableRows) });
      slices.push({ sourceDb: activeSourceDb, sourceTable: SLICE_NAMES.ACTIVE_NEXT_SESSION_ITEMS, rows: toNextStepAssertionRows(activeParsed.nextStepRows) });
    }
    if (historyParsed) {
      const historySourceDb = filesystemSourceDb(parsed.historyFile);
      slices.push({ sourceDb: historySourceDb, sourceTable: SLICE_NAMES.HISTORY_SESSION_BLOCKS, rows: toSessionAssertionRows(historyParsed.sessionTldrRows) });
      slices.push({ sourceDb: historySourceDb, sourceTable: SLICE_NAMES.HISTORY_OPEN_CARRYOVERS, rows: toOpenThreadAssertionRows(historyParsed.openThreadRows) });
      // Fail-soft generic parser: durable-section / NEXT-SESSION headings
      // found INSIDE the archive file are still written (total
      // classification never drops a real heading match), tagged under
      // the history file's own source_db so they never collide with the
      // active file's manifest keys. Pushed UNCONDITIONALLY (even when
      // empty this run) so a slice that HAD content in a prior run and
      // now has none still gets its manifest row overwritten to
      // row_count=0 rather than left stale.
      slices.push({ sourceDb: historySourceDb, sourceTable: SLICE_NAMES.HISTORY_DURABLE_SECTIONS, rows: toDurableAssertionRows(historyParsed.durableRows) });
      slices.push({ sourceDb: historySourceDb, sourceTable: SLICE_NAMES.HISTORY_NEXT_SESSION_ITEMS, rows: toNextStepAssertionRows(historyParsed.nextStepRows) });
    }

    const { totalWritten } = await writeProjectMigration(tgtClient, {
      projectId: parsed.projectId, authoringMode: parsed.authoringMode, slices,
    });
    for (const slice of slices) {
      console.log(`  [OK] slice source_db="${slice.sourceDb}" source_table="${slice.sourceTable}": ${slice.rows.length} row(s)`);
    }

    const report = buildReport({ parsed, activeParsed, historyParsed, totalWritten });
    const reportPath = writeReport(parsed.reportDir, parsed.projectId, report);
    console.log(`  [REPORT] ${reportPath}`);

    console.log(`MIGRATION_RESULT: PASS (project_id="${parsed.projectId}", assertions_written=${totalWritten})`);
    exitCode = 0;
  } finally {
    await tgtClient.end();
  }
  process.exitCode = exitCode;
}

// ─── ROW SHAPING (predicate + fixed flags per category) ──────────────────

function toSessionAssertionRows(rows) {
  return rows.map((r) => ({
    subject: r.subject, predicate: 'session_tldr_archived', object: r.object,
    pinned: false, carryoverStatus: null, seq: null, createdAt: r.createdAt,
  }));
}
function toOpenThreadAssertionRows(rows) {
  return rows.map((r) => ({
    subject: r.subject, predicate: 'open_thread', object: r.object,
    pinned: false, carryoverStatus: 'open', seq: null, createdAt: null,
  }));
}
function toDurableAssertionRows(rows) {
  return rows.map((r) => ({
    subject: r.subject, predicate: r.predicate, object: r.object,
    pinned: true, carryoverStatus: null, seq: null, createdAt: null,
  }));
}
function toNextStepAssertionRows(rows) {
  return rows.map((r) => ({
    subject: r.subject, predicate: 'next_step', object: r.object,
    pinned: false, carryoverStatus: null, seq: r.seq, createdAt: null,
  }));
}

// ─── HEADINGS CONFIG ────────────────────────────────────────────────────

function loadHeadingsConfig(configPath) {
  if (!fs.existsSync(configPath)) {
    console.error(`FATAL: durable-headings config not found at "${configPath}".`);
    process.exit(1);
  }
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (err) {
    console.error(`FATAL: durable-headings config at "${configPath}" is not valid JSON: ${err.message}`);
    process.exit(1);
  }
  if (!Array.isArray(parsed.headings)) {
    console.error(`FATAL: durable-headings config at "${configPath}" must carry a "headings" array.`);
    process.exit(1);
  }
  return parsed;
}

// ─── REPORT (base spec point 5, fail-soft) ────────────────────────────────

function buildReport({ parsed, activeParsed, historyParsed, totalWritten }) {
  return {
    project_id: parsed.projectId,
    generated_at: new Date().toISOString(),
    file: parsed.file || null,
    history_file: parsed.historyFile || null,
    authoring_mode: parsed.authoringMode,
    total_assertions_written: totalWritten,
    active: activeParsed ? activeParsed.report : null,
    history: historyParsed ? historyParsed.report : null,
  };
}

function writeReport(reportDir, projectId, report) {
  fs.mkdirSync(reportDir, { recursive: true });
  const safeProjectId = String(projectId).replace(/[^a-zA-Z0-9_-]/g, '_');
  const fileName = `handoff-markdown-parse-report-${safeProjectId}-${Date.now()}.json`;
  const filePath = path.join(reportDir, fileName);
  fs.writeFileSync(filePath, JSON.stringify(report, null, 2), 'utf8');
  return filePath;
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err && err.stack ? err.stack : err);
    process.exitCode = 1;
  });
}

module.exports = {
  parseArgs,
  UsageError,
  printUsage,
  loadAndNormalizeFile,
  parseFileIntoRows,
  findCollisions,
  computeContentFingerprint,
  writeProjectMigration,
  runRollback,
  loadHeadingsConfig,
  buildReport,
  toSessionAssertionRows,
  toOpenThreadAssertionRows,
  toDurableAssertionRows,
  toNextStepAssertionRows,
  SLICE_NAMES,
  SOURCE_MODEL_TAG,
  DDL_PREAMBLE_SQL,
  DEFAULT_HEADINGS_CONFIG_PATH,
  LOAD_BEARING_COLS,
};
