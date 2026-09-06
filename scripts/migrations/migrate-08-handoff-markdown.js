'use strict';

/**
 * migrate-08-handoff-markdown.js
 *
 * CONSOLIDATION-RUNBOOK.md §6.1(h) + its H-1..H-14 spec-adversary
 * amendment (2026-08-16, memory-manager#11(h)) + cm#222's further
 * hardening pass (2026-09-06, PR body has the full disposition of
 * findings F-1..F-9): parses ONE project's `HANDOFF.md` (active fat card)
 * and `.claude/HANDOFF-HISTORY.md` (append-only archive) into `assertions`
 * rows on a memory-manager consolidation target — the markdown-source
 * PEER of the SQL-source migrations (migrate-02 etc.), not an afterthought.
 *
 * cm#222 FIXES (this pass):
 *   A1 — a TRUE `--dry-run`: zero DDL/INSERT/UPDATE/DELETE. With `--db`,
 *        runs ONLY the two read-only schema-precondition SELECTs and
 *        reports PASS/FAIL for each (never silently "assumed OK" — F-9).
 *        Without `--db`, reports "schema preconditions not checked".
 *   A2 — session-heading TOTAL classification widened to the real shapes
 *        (session_numbered / session_dated / session_shaped_unparsed —
 *        see scripts/lib/handoff-markdown-parse.js for the regex/bucket
 *        design and its cm#222 F-2/F-3 rationale).
 *   A3 — carry-over tables are HEADER-DRIVEN (cell count + column roles
 *        derived from the header row's own cell names via a synonym map),
 *        replacing the old hardcoded-2-cell assumption that failed on
 *        100% of real pwa-etl rows (F-1).
 *   A4 — Status cells get a total classification (closed/open/unknown,
 *        dual-signal -> unknown) surfaced in the report — NOT written as
 *        a new `assertions` column (out of scope; carryover_status stays
 *        fixed 'open' for every parsed row per the base spec's H-4, which
 *        cm#222 does not revisit).
 *   A5 — "## NEXT SESSION" gets an explicit per-file state (absent /
 *        present_empty / present_with_items / present_variant) instead of
 *        an ambiguous zero count (F-5).
 *   A6 — the report (both modes) carries bucket counts + line-numbered
 *        lists for every unparsed/flagged/orphaned item (H-13 acceptance
 *        artifact).
 *
 * WHAT THIS SCRIPT DOES (normal / MIGRATE mode, unchanged from H-1..H-14):
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
 *      classification into sections, then derives four assertion
 *      categories per H-1/H-4/H-7/H-11:
 *        - session_tldr_archived  (EVERY session-block section — numbered
 *          or dated — in EITHER file — never live session_tldr, H-1)
 *        - open_thread             ("### Open carry-overs" tables nested
 *          in ANY section's body, in EITHER file — always
 *          carryover_status='open', H-4)
 *        - run_commands / critical_operational_notes / key_paths
 *          (durable-section headings, pinned=true)
 *        - next_step               ("## NEXT SESSION" section's list
 *          items, seq reassigned this run, H-11)
 *   5. Subject collisions (H-6) are loud named report events, printed to
 *      stdout AND carried in the fail-soft report (point 8) — never
 *      silently overwritten; both/all colliding rows are still written
 *      (every category here is 1:N-safe by construction). Two DISTINCT
 *      collision checks run: WITHIN one file (`[SUBJECT-COLLISION]`) and
 *      ACROSS the active file and the archive file
 *      (`[CROSS-FILE-SUBJECT-COLLISION]`).
 *   6. Re-run semantics (H-6): per-project DELETE of this script's own
 *      `source_model='markdown-migration-h'` rows, then bulk INSERT of
 *      every freshly-parsed row, in ONE transaction — idempotent by
 *      construction, never a per-row upsert key.
 *   7. Writes migration_manifest + migration_manifest_row_hashes per
 *      logical slice, source_db = `filesystem:<H-14-normalized path>`, in
 *      the SAME transaction as that slice's assertion rows.
 *   8. Writes a per-project fail-soft report
 *      (`handoff-markdown-parse-report-<project>-<ts>.json` under
 *      scripts/migrations/reports/, gitignored) — see cm#222 A6 above for
 *      the extended shape.
 *
 * DRY-RUN MODE (--dry-run, cm#222 A1): parses + reports; opens a
 * connection ONLY to run the two read-only precondition SELECTs when
 * `--db` is given; zero DDL, zero writes. Mutually exclusive with
 * --rollback (both are refused together — ambiguous scope, exit 2).
 *
 * ROLLBACK MODE (--rollback): deletes every `assertions` row tagged
 * `source_model='markdown-migration-h' AND project_id=$1`, plus this
 * run's migration_manifest(+row_hashes) rows for this project_id, in ONE
 * transaction.
 *
 * WHAT THIS SCRIPT DELIBERATELY DOES NOT DO (out of scope):
 *   - No inter-session diff / resolved-carryover detection (H-4 — every
 *     parsed carryover row is 'open' by construction; cm#222's Status
 *     total-classification is report-only, never fed back into
 *     carryover_status).
 *   - No project_id derivation from a file path — the caller MUST pass
 *     --project-id explicitly.
 *   - No wiring into the verify-15-*.js battery beyond the two roster
 *     rows H-2 requires.
 *
 * Usage:
 *   node scripts/migrations/migrate-08-handoff-markdown.js --db <target>
 *     --project-id <id> [--file <HANDOFF.md path>]
 *     [--history-file <HANDOFF-HISTORY.md path>]
 *     [--headings-config <path>] [--authoring-mode caveman|verbose]
 *     [--dry-run] [--rollback] [--report-dir <path>]
 *
 * Exit codes: 0 = PASS, 1 = refused / failure, 2 = bad CLI usage.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Client } = require('pg');

const migrateOne = require('./migrate-01-canonical-db'); // reused by reference, never forked
const shared = require('./lib/verify15-shared'); // reused by reference: connect config, rowHash, applyDdl
const { intentKey } = require('../handoff.js'); // reused by reference (H-3/H-7, cm#233), never reimplemented
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

// Logical manifest slice names (source_table).
const SLICE_NAMES = {
  ACTIVE_SESSION_SUMMARY: 'handoff_active_session_summary',
  ACTIVE_OPEN_CARRYOVERS: 'handoff_open_carryovers',
  ACTIVE_DURABLE_SECTIONS: 'handoff_durable_sections',
  ACTIVE_NEXT_SESSION_ITEMS: 'handoff_next_session_items',
  HISTORY_SESSION_BLOCKS: 'handoff_history_session_blocks',
  HISTORY_OPEN_CARRYOVERS: 'handoff_history_open_carryovers',
  HISTORY_DURABLE_SECTIONS: 'handoff_durable_sections_in_history',
  HISTORY_NEXT_SESSION_ITEMS: 'handoff_next_session_items_in_history',
};

const SESSION_TYPES = new Set(['session_numbered', 'session_dated']);

// ─── CLI ARGS ─────────────────────────────────────────────────────────────

class UsageError extends Error {}

function parseArgs(argv) {
  const parsed = {
    db: null, projectId: null, file: null, historyFile: null,
    headingsConfig: DEFAULT_HEADINGS_CONFIG_PATH, authoringMode: 'verbose',
    rollback: false, dryRun: false, reportDir: DEFAULT_REPORT_DIR, help: false,
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
    else if (a === '--dry-run') parsed.dryRun = true;
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
    '         [--dry-run] [--rollback] [--report-dir <path>]',
    '',
    '  --db <name>            Target database (else MIGRATE_TARGET_DB env, else memory_manager_staging).',
    '  --project-id <id>      Required. Never derived/guessed from a file path.',
    '  --file <path>          HANDOFF.md (active fat card). Optional if --history-file is given.',
    '  --history-file <path>  HANDOFF-HISTORY.md (archive). Optional if --file is given.',
    '  --headings-config <p>  Durable-section headings config (default: handoff-section-headings.json).',
    '  --authoring-mode <m>   "caveman" or "verbose" — tags every row this run writes (default: verbose).',
    '  --dry-run              Parse + report only. Zero DDL/INSERT/UPDATE/DELETE. With --db, runs only',
    '                         the two read-only schema-precondition checks. Mutually exclusive with --rollback.',
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

// ─── cm#222: normalizeMarkdown() flag console logging ─────────────────────

/**
 * logNormalizeFlag — H-10's unrecognized-dash flag and cm#222's
 * mid-document bom-midfile flag share one console line format, keyed off
 * `flag.type` (a total switch, not an assumed shape — a flag missing a
 * `char` field, like bom-midfile, never prints "undefined").
 */
function logNormalizeFlag(flag) {
  if (flag.type === 'bom-midfile') {
    console.log(`  [FLAG] bom-midfile at line ${flag.line}: a stray U+FEFF was found mid-document (not the file's leading byte) — not silently relied upon`);
  } else {
    console.log(`  [FLAG] unrecognized-dash at line ${flag.line}: "${flag.char}" (H-10 — not silently coerced)`);
  }
}

// ─── NEXT SESSION per-file state (cm#222 A5) ──────────────────────────────

/**
 * computeNextSessionState — cm#222 A5: an explicit per-file state instead
 * of an ambiguous zero item-count. Four-way total classification (the
 * spec names three notable states; `present_with_items` is this file's
 * own necessary completion of the enum for the normal/expected case —
 * documented, not left implicit).
 *
 * @param {Array} sections
 * @returns {{state:'absent'|'present_empty'|'present_with_items'|'present_variant', headingLineNo:number|null, itemCount:number, variantHeadingText:string|null}}
 */
function computeNextSessionState(sections) {
  const canonical = sections.find((s) => s.type === 'next_session');
  if (canonical) {
    const items = mdParse.parseNextSessionItems(canonical.bodyText);
    return {
      state: items.length > 0 ? 'present_with_items' : 'present_empty',
      headingLineNo: canonical.headingLineNo,
      itemCount: items.length,
      variantHeadingText: null,
    };
  }
  const variant = sections.find((s) => s.type === 'next_session_variant');
  if (variant) {
    return {
      state: 'present_variant',
      headingLineNo: variant.headingLineNo,
      itemCount: 0,
      variantHeadingText: variant.classification.headingText,
    };
  }
  return { state: 'absent', headingLineNo: null, itemCount: 0, variantHeadingText: null };
}

// ─── PARSE ONE FILE INTO CATEGORIZED ROWS ─────────────────────────────────

/**
 * parseFileIntoRows — runs the total classification over one already-
 * normalized file and produces the four assertion-category row lists PLUS
 * a per-file report fragment (cm#222 A6). Pure (no I/O, no DB).
 *
 * @param {string} normalizedText
 * @param {Array<{canonical:string, predicate:string}>} durableHeadings
 * @param {'active'|'history'} fileKind
 * @returns {{
 *   sessionTldrRows: Array, openThreadRows: Array, durableRows: Array, nextStepRows: Array,
 *   report: object,
 * }}
 */
function parseFileIntoRows(normalizedText, durableHeadings, fileKind, normalizeFlags) {
  const sections = mdParse.splitDocumentIntoSections(normalizedText, durableHeadings);
  const sessionHeadingLevel = mdParse.detectSessionHeadingLevel(normalizedText);

  const sessionTldrRows = [];
  const openThreadRows = [];
  const durableRows = [];
  const nextStepRows = [];

  const otherHeadings = [];
  const sessionShapedUnparsedHeadings = [];
  const nextSessionVariantHeadings = [];
  const carryoverHeadingVariants = [];
  const flaggedTableRows = [];
  const orphanTableRows = [];
  let tablesParsedCount = 0;
  let nextSeq = 0;

  const statusClassCounts = { closed: 0, open: 0, unknown: 0 };
  const dualSignalStatusCells = [];
  const MAX_DUAL_SIGNAL_EXAMPLES = 20;

  for (const section of sections) {
    // "### Open carry-overs" tables can appear inside ANY section's body
    // (active preamble OR an archived session block) — extracted uniformly
    // regardless of the enclosing section's type (H-4/base-point-3).
    const carryoverResult = mdParse.findOpenCarryoverTables(section.bodyText, section.bodyStartLine);
    for (const table of carryoverResult.tables) {
      tablesParsedCount += 1;
      for (const row of table.rows) {
        openThreadRows.push({
          subject: intentKey(row.itemRaw),
          object: row.notesRaw,
          statusRaw: row.statusRaw,
          statusClass: row.statusClass,
          sourceLineNo: row.lineNo,
        });
        statusClassCounts[row.statusClass] = (statusClassCounts[row.statusClass] || 0) + 1;
        if (row.statusDualSignal && dualSignalStatusCells.length < MAX_DUAL_SIGNAL_EXAMPLES) {
          dualSignalStatusCells.push({ raw: row.statusRaw, lineNo: row.lineNo, enclosingHeadingLineNo: section.headingLineNo });
        }
      }
      for (const flagged of table.flaggedRows) {
        flaggedTableRows.push({ ...flagged, enclosingHeadingLineNo: section.headingLineNo });
      }
      for (const orphan of table.orphanRows) {
        orphanTableRows.push({ ...orphan, enclosingHeadingLineNo: section.headingLineNo });
      }
    }
    // cm#222 follow-up: a "### Open carry-overs"-shaped heading that isn't
    // the canonical form (e.g. a trailing "(snapshot at S68 close ...)"
    // parenthetical this exact real-file case was found with) — reported,
    // never silently un-extracted.
    for (const variant of carryoverResult.carryoverHeadingVariants) {
      carryoverHeadingVariants.push({ ...variant, enclosingHeadingLineNo: section.headingLineNo });
    }

    if (SESSION_TYPES.has(section.type)) {
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
        sessionHeadingType: section.type,
      });
    } else if (section.type === 'session_shaped_unparsed') {
      // cm#222 F-3: never silently merged into the generic "other" list —
      // its own line-numbered bucket, always surfaced.
      sessionShapedUnparsedHeadings.push({ headingLine: section.headingLine, headingLineNo: section.headingLineNo });
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
          subject: intentKey(itemText),
          object: itemText,
          seq: nextSeq,
          headingLineNo: section.headingLineNo,
        });
      }
    } else if (section.type === 'next_session_variant') {
      // cm#222 F-5/A5: reported distinctly, never absorbed as a fuzzy
      // synonym match — no items are extracted from a variant heading.
      nextSessionVariantHeadings.push({ headingLine: section.headingLine, headingLineNo: section.headingLineNo });
    } else if (section.type === 'other') {
      otherHeadings.push({ headingLine: section.headingLine, headingLineNo: section.headingLineNo });
    }
  }

  // H-12: per-block body-length-delta heuristic, computed over this FILE's
  // own session blocks only (numbered + dated together — same-file-
  // relative, see handoff-markdown-parse.js's computeBodyLengthDeltaFlags
  // header comment).
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

  const nextSessionState = computeNextSessionState(sections);

  const sectionTypeCounts = countByType(sections);

  // cm#222 follow-up: surface normalizeMarkdown()'s flags in the report
  // itself (previously console-only for unrecognized-dash, and the
  // mid-document BOM case wasn't tracked anywhere at all).
  const allFlags = normalizeFlags || [];
  const unrecognizedDashFlags = allFlags.filter((f) => f.type === 'unrecognized-dash');
  const bomMidfileFlags = allFlags.filter((f) => f.type === 'bom-midfile');

  return {
    sessionTldrRows,
    openThreadRows,
    durableRows,
    nextStepRows,
    report: {
      fileKind,
      sectionsFound: sections.length,
      sectionTypeCounts,
      sessionHeadingLevelDetected: sessionHeadingLevel,
      otherHeadings,
      sessionShapedUnparsedHeadings,
      nextSessionVariantHeadings,
      carryoverHeadingVariants,
      nextSessionState,
      flaggedTableRows,
      orphanTableRows,
      tablesParsedCount,
      statusClassCounts,
      dualSignalStatusCells,
      bodyLengthDeltaFlags,
      unrecognizedDashFlags,
      bomMidfileFlags,
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

/**
 * findCrossFileCollisions — H-6 cross-file collision detection
 * (independent-review fix, PR #172 blocker 2).
 *
 * @param {Array} activeRows
 * @param {Array} historyRows
 * @param {(row: object) => string} keyFn
 * @returns {Array<{key:string, activeCount:number, historyCount:number}>}
 */
function findCrossFileCollisions(activeRows, historyRows, keyFn) {
  const activeCounts = new Map();
  for (const r of activeRows || []) {
    const k = keyFn(r);
    activeCounts.set(k, (activeCounts.get(k) || 0) + 1);
  }
  const historyCounts = new Map();
  for (const r of historyRows || []) {
    const k = keyFn(r);
    historyCounts.set(k, (historyCounts.get(k) || 0) + 1);
  }
  const collisions = [];
  for (const [k, activeCount] of activeCounts) {
    if (historyCounts.has(k)) {
      collisions.push({ key: k, activeCount, historyCount: historyCounts.get(k) });
    }
  }
  return collisions;
}

const COLLISION_KEY_FNS = {
  session_tldr_archived: (r) => r.subject,
  open_thread: (r) => r.subject,
  durable: (r) => `${r.predicate}::${r.subject}`,
  next_step: (r) => r.subject,
};

/**
 * computeCrossFileCollisions — runs findCrossFileCollisions() over all
 * four categories between the active-file and history-file parse
 * results. Returns null when either file was absent.
 */
function computeCrossFileCollisions(activeParsed, historyParsed) {
  if (!activeParsed || !historyParsed) return null;
  return {
    session_tldr_archived: findCrossFileCollisions(activeParsed.sessionTldrRows, historyParsed.sessionTldrRows, COLLISION_KEY_FNS.session_tldr_archived),
    open_thread: findCrossFileCollisions(activeParsed.openThreadRows, historyParsed.openThreadRows, COLLISION_KEY_FNS.open_thread),
    durable: findCrossFileCollisions(activeParsed.durableRows, historyParsed.durableRows, COLLISION_KEY_FNS.durable),
    next_step: findCrossFileCollisions(activeParsed.nextStepRows, historyParsed.nextStepRows, COLLISION_KEY_FNS.next_step),
  };
}

// ─── CONTENT FINGERPRINT (T1 convention, mirrors migrate-02) ─────────────

function computeContentFingerprint(rowsOrderedForHash) {
  const concatenated = rowsOrderedForHash.map((r) => shared.rowHash(LOAD_BEARING_COLS, r)).join('');
  return crypto.createHash('md5').update(concatenated).digest('hex');
}

// ─── WHOLE-PROJECT WRITE (H-6) ─────────────────────────────────────────────

/**
 * writeProjectMigration — the H-6 whole-project delete-and-reinsert.
 *
 * @param {Array<{sourceDb, sourceTable, rows}>} slices
 */
async function writeProjectMigration(tgtClient, { projectId, authoringMode, slices }) {
  await tgtClient.query('BEGIN');
  let totalWritten = 0;
  try {
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

// ─── SCHEMA PRECONDITION CHECKS (shared by MIGRATE and cm#222 --dry-run) ──

/**
 * checkSchemaPreconditions — the two read-only SELECTs both MIGRATE mode
 * and --dry-run mode (with --db) run: the "assertions" table exists, and
 * it carries source_model + carryover_status. Never mutates anything.
 *
 * @returns {{assertionsTable:'pass'|'fail', requiredColumns:'pass'|'fail'|'not_checked'}}
 */
async function checkSchemaPreconditions(tgtClient) {
  const { rows: tblRows } = await tgtClient.query(
    `SELECT 1 FROM information_schema.tables WHERE table_schema = current_schema() AND table_name = 'assertions' AND table_type = 'BASE TABLE'`
  );
  if (tblRows.length === 0) {
    return { assertionsTable: 'fail', requiredColumns: 'not_checked' };
  }
  const { rows: reqCols } = await tgtClient.query(
    `SELECT column_name FROM information_schema.columns WHERE table_name='assertions' AND column_name IN ('source_model','carryover_status')`
  );
  return { assertionsTable: 'pass', requiredColumns: reqCols.length >= 2 ? 'pass' : 'fail' };
}

// ─── HUMAN-READABLE SUMMARY (cm#222 A1: dry-run emits this + the JSON) ────

function printHumanSummary({ parsed, activeParsed, historyParsed, preconditionChecks }) {
  console.log('--- handoff-markdown parse summary ---');
  console.log(`  mode: ${parsed.dryRun ? 'DRY-RUN' : (parsed.rollback ? 'ROLLBACK' : 'MIGRATE')}`);
  if (preconditionChecks) {
    console.log(`  schema preconditions: assertions_table=${preconditionChecks.assertionsTable} required_columns=${preconditionChecks.requiredColumns}`);
  } else {
    console.log('  schema preconditions: not_checked (no --db)');
  }
  for (const [label, p] of [['active (--file)', activeParsed], ['history (--history-file)', historyParsed]]) {
    if (!p) { console.log(`  ${label}: not provided`); continue; }
    const r = p.report;
    console.log(`  ${label}: sections=${r.sectionsFound} types=${JSON.stringify(r.sectionTypeCounts)} sessionHeadingLevel=${r.sessionHeadingLevelDetected}`);
    console.log(`    session_shaped_unparsed=${r.sessionShapedUnparsedHeadings.length} other=${r.otherHeadings.length} next_session_variant=${r.nextSessionVariantHeadings.length}`);
    console.log(`    next_session_state=${r.nextSessionState.state} (items=${r.nextSessionState.itemCount})`);
    console.log(`    tables_parsed=${r.tablesParsedCount} flagged_rows=${r.flaggedTableRows.length} orphan_rows=${r.orphanTableRows.length} carryover_heading_variant=${r.carryoverHeadingVariants.length}`);
    console.log(`    status_classes=${JSON.stringify(r.statusClassCounts)} dual_signal_examples=${r.dualSignalStatusCells.length}`);
    console.log(`    unrecognized_dash=${r.unrecognizedDashFlags.length} bom_midfile=${r.bomMidfileFlags.length}`);
  }
  console.log('--- end summary ---');
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
  if (parsed.dryRun && parsed.rollback) {
    console.error('Refused: --dry-run and --rollback are mutually exclusive (ambiguous scope).');
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

  // ── cm#222 A1: TRUE dry-run — parse + report, zero DDL/writes. ─────────
  if (parsed.dryRun) {
    let preconditionChecks = null;
    if (parsed.db) {
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
      console.log(`migrate-08-handoff-markdown: DRY-RUN target="${target}" (resolved from ${targetSource}) — read-only precondition checks only, zero writes`);
      const tgtClient = new Client(migrateOne.pgConfig(target));
      try {
        await tgtClient.connect();
        preconditionChecks = await checkSchemaPreconditions(tgtClient);
      } catch (err) {
        console.error(`Could not connect to target database "${target}" for read-only precondition checks: ${err.message}`);
        process.exit(1);
      } finally {
        await tgtClient.end();
      }
    } else {
      console.log('migrate-08-handoff-markdown: DRY-RUN (no --db) — schema preconditions not checked, parse-only');
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
      console.error('Refused: neither --file nor --history-file could be read. Nothing to report.');
      process.exit(1);
    }

    for (const flag of [...(activeFile.normalized ? activeFile.normalized.flags : []), ...(historyFile.normalized ? historyFile.normalized.flags : [])]) {
      logNormalizeFlag(flag);
    }

    const activeParsed = activeFile.present ? parseFileIntoRows(activeFile.normalized.text, headingsConfig.headings, 'active', activeFile.normalized.flags) : null;
    const historyParsed = historyFile.present ? parseFileIntoRows(historyFile.normalized.text, headingsConfig.headings, 'history', historyFile.normalized.flags) : null;
    const crossFileCollisions = computeCrossFileCollisions(activeParsed, historyParsed);

    printHumanSummary({ parsed, activeParsed, historyParsed, preconditionChecks });

    const report = buildReport({ parsed, activeParsed, historyParsed, totalWritten: 0, crossFileCollisions, preconditionChecks, mode: 'dry_run' });
    const reportPath = writeReport(parsed.reportDir, parsed.projectId, report);
    console.log(`  [REPORT] ${reportPath}`);

    const preconditionsFailed = preconditionChecks
      && (preconditionChecks.assertionsTable === 'fail' || preconditionChecks.requiredColumns === 'fail');
    if (preconditionsFailed) {
      console.error('DRY_RUN_RESULT: FAIL (schema preconditions not met on target — see report)');
      process.exitCode = 1;
      return;
    }
    console.log(`DRY_RUN_RESULT: PASS (project_id="${parsed.projectId}", zero writes performed)`);
    process.exitCode = 0;
    return;
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
    const preconditionChecks = await checkSchemaPreconditions(tgtClient);
    if (preconditionChecks.assertionsTable === 'fail') {
      console.error(`Refused: target "${target}" is missing the "assertions" table.`);
      console.error('Run migrate-01-canonical-db.js against this target first. Nothing was applied.');
      process.exitCode = 1;
      return;
    }
    if (preconditionChecks.requiredColumns === 'fail') {
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
      logNormalizeFlag(flag);
    }

    const activeParsed = activeFile.present
      ? parseFileIntoRows(activeFile.normalized.text, headingsConfig.headings, 'active', activeFile.normalized.flags)
      : null;
    const historyParsed = historyFile.present
      ? parseFileIntoRows(historyFile.normalized.text, headingsConfig.headings, 'history', historyFile.normalized.flags)
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
      slices.push({ sourceDb: historySourceDb, sourceTable: SLICE_NAMES.HISTORY_DURABLE_SECTIONS, rows: toDurableAssertionRows(historyParsed.durableRows) });
      slices.push({ sourceDb: historySourceDb, sourceTable: SLICE_NAMES.HISTORY_NEXT_SESSION_ITEMS, rows: toNextStepAssertionRows(historyParsed.nextStepRows) });
    }

    const { totalWritten } = await writeProjectMigration(tgtClient, {
      projectId: parsed.projectId, authoringMode: parsed.authoringMode, slices,
    });
    for (const slice of slices) {
      console.log(`  [OK] slice source_db="${slice.sourceDb}" source_table="${slice.sourceTable}": ${slice.rows.length} row(s)`);
    }

    for (const [fileLabel, filesParsed] of [['active', activeParsed], ['history', historyParsed]]) {
      if (!filesParsed) continue;
      for (const [category, list] of Object.entries(filesParsed.report.collisions)) {
        for (const c of list) {
          console.log(`  [SUBJECT-COLLISION] file=${fileLabel} category="${category}" key=${JSON.stringify(c.key)}: ${c.count} row(s) share this subject within one file`);
        }
      }
      if (filesParsed.report.sessionShapedUnparsedHeadings.length) {
        console.log(`  [SESSION-SHAPED-UNPARSED] file=${fileLabel}: ${filesParsed.report.sessionShapedUnparsedHeadings.length} heading(s) contained "session" but matched no known shape — see report`);
      }
      if (filesParsed.report.orphanTableRows.length) {
        console.log(`  [ORPHAN-ROWS] file=${fileLabel}: ${filesParsed.report.orphanTableRows.length} pipe-shaped line(s) after a table's blank-line end were not silently dropped — see report`);
      }
    }
    const crossFileCollisions = computeCrossFileCollisions(activeParsed, historyParsed);
    if (crossFileCollisions) {
      for (const [category, list] of Object.entries(crossFileCollisions)) {
        for (const c of list) {
          console.log(`  [CROSS-FILE-SUBJECT-COLLISION] category="${category}" key=${JSON.stringify(c.key)}: ${c.activeCount} row(s) in --file + ${c.historyCount} row(s) in --history-file — both survive as separate rows under this one subject key (documented H-6 outcome, not an accident)`);
        }
      }
    }

    const report = buildReport({ parsed, activeParsed, historyParsed, totalWritten, crossFileCollisions, preconditionChecks, mode: 'migrate' });
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

// ─── REPORT (base spec point 5, fail-soft; cm#222 A6 extension) ──────────

function buildReport({ parsed, activeParsed, historyParsed, totalWritten, crossFileCollisions, preconditionChecks, mode }) {
  return {
    mode: mode || (parsed.dryRun ? 'dry_run' : (parsed.rollback ? 'rollback' : 'migrate')),
    project_id: parsed.projectId,
    generated_at: new Date().toISOString(),
    file: parsed.file || null,
    history_file: parsed.historyFile || null,
    authoring_mode: parsed.authoringMode,
    total_assertions_written: totalWritten,
    precondition_checks: preconditionChecks
      ? { assertions_table: preconditionChecks.assertionsTable, required_columns: preconditionChecks.requiredColumns }
      : { assertions_table: 'not_checked', required_columns: 'not_checked' },
    active: activeParsed ? activeParsed.report : null,
    history: historyParsed ? historyParsed.report : null,
    // H-6 cross-file collision events — null when either file was absent.
    cross_file_collisions: crossFileCollisions,
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
  computeNextSessionState,
  findCollisions,
  findCrossFileCollisions,
  computeCrossFileCollisions,
  computeContentFingerprint,
  writeProjectMigration,
  runRollback,
  checkSchemaPreconditions,
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
