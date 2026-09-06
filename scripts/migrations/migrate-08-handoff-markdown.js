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
 * ENGINE INDEX BRING-FORWARD + INTEGRITY-INDEX GATE (this pass, 2026-09-06 —
 * unblocks item B's pwa-etl HANDOFF-HISTORY write, item B/#251's own
 * successor): a live WRITE against memory_manager_staging failed with
 * "index row size 3552 exceeds btree version 4 maximum 2704 for index
 * assertions_1ton_exact_unique" — this file NEVER called the engine's
 * ensureSchemaCurrent() before INSERTing, so a target whose
 * assertions_1ton_exact_unique index was still the stale pre-cm#227 raw
 * form was never brought forward to the md5(object)-keyed canonical form.
 * checkSchemaPreconditions() only ever probed information_schema.columns,
 * which cannot see an index's DEFINITION (only whether a required column
 * exists). See the "INTEGRITY INDEX CLASSIFICATION" section below
 * (classifyIntegrityIndex and its call sites in main()) for the full S1
 * (bring-forward)/S2 (total classification)/S3 (write gate) design.
 *
 * PER-BRANCH PRECONDITION FIX (prior pass, item B / #251 follow-up — the pwa-etl
 * HANDOFF-HISTORY.md write, #251 having just made pipeline_pwa_etl classify
 * PER_PROJECT_ENGINE instead of being name-refused):
 *   checkSchemaPreconditions() is now BRANCH-AWARE. Every column this
 *   script's INSERT writes into `assertions` falls into exactly one of
 *   three buckets (see ENGINE_CANON_COLUMNS / ADDENDA_ONLY_COLUMNS /
 *   SELF_BOOTSTRAPPED_COLUMNS below for the authoritative lists):
 *     - ENGINE_CANON:      defined in scripts/sql/handoff-core-schema.sql —
 *                          applied to every engine DB (CANON, STAGING, and
 *                          every PER_PROJECT_ENGINE target) by ensureSchemaCurrent.
 *     - ADDENDA_ONLY:      defined only under scripts/migrations/sql/ (here:
 *                          carryover_status, migrate-06-carryover-status.sql)
 *                          — applied by migrate-schema-addenda.js to CANON/
 *                          STAGING consolidation targets ONLY. A per-project
 *                          engine DB (schema = handoff-core-schema.sql alone)
 *                          never carries this column, and never will just by
 *                          running the engine — so requiring it there was a
 *                          precondition bug, not a real prerequisite.
 *     - SELF_BOOTSTRAPPED: seq, authoring_mode — present in NEITHER schema
 *                          root; this script bundles its own idempotent
 *                          `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` for
 *                          both (DDL_PREAMBLE_SQL, below) and runs it before
 *                          every write, on every branch. Never a precondition
 *                          (was not one before this fix either).
 *   CANON/STAGING preconditions are UNCHANGED (require source_model AND
 *   carryover_status, exactly as before this fix — no loosening).
 *   PER_PROJECT_ENGINE now requires exactly the ENGINE_CANON columns this
 *   script writes (not ADDENDA_ONLY) — see requiredColumnsForBranch().
 *   The write path (writeProjectMigration) is likewise branch-aware: on
 *   PER_PROJECT_ENGINE it omits ADDENDA_ONLY columns (carryover_status) from
 *   the INSERT's column list entirely — never written, never NULL-padded —
 *   and both --dry-run and MIGRATE mode report the omission plus the
 *   required-columns set that was actually checked, per branch.
 *   Any classifyTarget() branch other than CANON/STAGING/PER_PROJECT_ENGINE
 *   reaching checkSchemaPreconditions() is a hard internal error (SOURCE_ONLY
 *   and UNKNOWN are already refused upstream, before a connection to run
 *   this check is even opened) — see the throw in requiredColumnsForBranch().
 *
 * cm#222 FIXES (prior pass):
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
 *   1. Resolves + validates the TARGET database (via migrate-01's
 *      classifyTarget, reused by reference — now async; see migrate-01's
 *      header for the full CANON/STAGING/PER_PROJECT_ENGINE/SOURCE_ONLY/
 *      UNKNOWN contract). This is the ONE script in the suite that already
 *      always carries a --project-id (required since H-1), so it is also
 *      the primary real-world caller of the PER_PROJECT_ENGINE branch: a
 *      live pipeline_* (or other) per-project engine database whose
 *      project_settings marker corroborates --project-id is a legitimate
 *      target here, not refused by name alone.
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
const handoffMod = require('../handoff.js'); // reused by reference (H-3/H-7 intentKey, cm#233; S1 ensureSchemaCurrent bring-forward, S2 _extractIntegrityIndexOps)
const { intentKey } = handoffMod;
const { PostgresAdapter } = require('../lib/db-seam.js'); // S1: wraps this file's own pg.Client for ensureSchemaCurrent's db-port contract
const { AUTHORING_MODE_VALUES } = require('../lib/memory-upsert.js'); // reused by reference, never a second Set
const mdParse = require('../lib/handoff-markdown-parse.js');
const { filesystemSourceDb } = require('../lib/fs-path-normalize.js'); // H-14: same normalizer roster entries use
const constraintPreflight = require('./lib/constraint-preflight.js'); // P1-P3 catalog-driven unique-constraint preflight (item B / cm#233 successor)

const MIGRATIONS_DIR = __dirname;
const DEFAULT_HEADINGS_CONFIG_PATH = path.join(MIGRATIONS_DIR, 'handoff-section-headings.json');
const DEFAULT_REPORT_DIR = path.join(MIGRATIONS_DIR, 'reports');
// S2: the canonical schema file whose CREATE UNIQUE INDEX statement for
// assertions_1ton_exact_unique is the ground truth this migration's
// integrity-index classification compares the live catalog against.
const CORE_SCHEMA_SQL_PATH = path.join(MIGRATIONS_DIR, '..', 'sql', 'handoff-core-schema.sql');

const SOURCE_MODEL_TAG = 'markdown-migration-h';
const DEFAULT_CONFIDENCE = 8;
const SOURCE_VALUE = 'doc_quoted'; // valid per assertions' source CHECK: quoted verbatim from a markdown document
const TIER_VALUE = 'consolidated'; // durable/already-established historical record, not fresh probationary extraction
const LOAD_BEARING_COLS = ['subject', 'object']; // hashed as-persisted, matching migrate-02's "mirror the inserted columns" convention

const DDL_PREAMBLE_SQL = [
  'ALTER TABLE assertions ADD COLUMN IF NOT EXISTS seq INTEGER',
  "ALTER TABLE assertions ADD COLUMN IF NOT EXISTS authoring_mode TEXT CHECK (authoring_mode IN ('caveman','verbose'))",
];

// ─── COLUMN CLASSIFICATION (this migration's own INSERT column list) ─────
//
// Every column writeProjectMigration() inserts into `assertions` falls into
// exactly one of these three buckets — see the header comment above for the
// full rationale. This is a closed, hand-verified enumeration (not derived
// by introspection) because it must stay in lockstep with the literal
// column list in writeProjectMigration()'s INSERT statement below; a
// column added there without being added here would silently escape both
// the branch-aware precondition check and the omission logic below —
// test-migrate-08-handoff-markdown.js's PER_PROJECT_ENGINE tests exercise
// the full round trip (precondition pass, write, and re-read) against a
// scratch DB carrying ONLY ENGINE_CANON columns to catch that drift.
//
// ENGINE_CANON — defined in scripts/sql/handoff-core-schema.sql, present on
// every engine DB regardless of branch (CANON, STAGING, PER_PROJECT_ENGINE).
const ENGINE_CANON_COLUMNS = [
  'project_id', 'subject', 'predicate', 'object', 'confidence',
  'source', 'tier', 'pinned', 'source_model', 'created_at',
];
// ADDENDA_ONLY — defined ONLY under scripts/migrations/sql/ (here:
// migrate-06-carryover-status.sql), applied by migrate-schema-addenda.js to
// CANON/STAGING consolidation targets only. Never present on a bare
// PER_PROJECT_ENGINE schema (handoff-core-schema.sql alone).
const ADDENDA_ONLY_COLUMNS = ['carryover_status'];
// SELF_BOOTSTRAPPED — present in NEITHER schema root; this script's own
// DDL_PREAMBLE_SQL (above) idempotently adds both before every write, on
// every branch. Never a schema precondition (unaffected by this fix).
const SELF_BOOTSTRAPPED_COLUMNS = ['seq', 'authoring_mode'];

/**
 * requiredColumnsForBranch — the total classification (spec item 2): every
 * classifyTarget() branch that can reach this function maps to exactly one
 * required-columns list.
 *   - CANON | STAGING        -> ENGINE_CANON ∪ ADDENDA_ONLY's subset this
 *                               script actually checked before this fix
 *                               (source_model, carryover_status) — UNCHANGED,
 *                               never loosened.
 *   - PER_PROJECT_ENGINE     -> exactly the ENGINE_CANON columns this
 *                               migration writes. ADDENDA_ONLY is NOT
 *                               required (carryover_status is a
 *                               consolidation-only column; a per-project
 *                               engine target never gets it just by running
 *                               the engine, so requiring it here was a
 *                               precondition bug, not a real prerequisite).
 *   - anything else          -> hard error. SOURCE_ONLY and UNKNOWN are
 *                               already refused by classifyTarget() before a
 *                               connection is ever opened to run this check
 *                               — reaching this branch here means an
 *                               upstream refusal was skipped, which must
 *                               never happen silently.
 *
 * @param {string} branch
 * @returns {string[]}
 */
function requiredColumnsForBranch(branch) {
  if (branch === 'CANON' || branch === 'STAGING') {
    return ['source_model', 'carryover_status'];
  }
  if (branch === 'PER_PROJECT_ENGINE') {
    return ENGINE_CANON_COLUMNS.slice();
  }
  throw new Error(
    `requiredColumnsForBranch: unreachable branch "${branch}" — SOURCE_ONLY/UNKNOWN ` +
    'are refused by classifyTarget() upstream, before checkSchemaPreconditions() is ever called.'
  );
}

/**
 * omittedColumnsForBranch — the ADDENDA_ONLY columns this migration's write
 * path leaves out of the INSERT column list entirely on PER_PROJECT_ENGINE
 * (never written, never NULL-padded). Empty on CANON/STAGING (unchanged
 * write behavior there).
 *
 * @param {string} branch
 * @returns {string[]}
 */
function omittedColumnsForBranch(branch) {
  return branch === 'PER_PROJECT_ENGINE' ? ADDENDA_ONLY_COLUMNS.slice() : [];
}

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

// P2: --on-duplicate policy values. 'fail' (default) is the conservative
// total classification's floor -- any non-insert bucket refuses the write.
// 'keep-newest' resolves in_batch_duplicate groups by session recency (see
// constraint-preflight.js) but NEVER rescues collides_existing/unclassified.
const ON_DUPLICATE_VALUES = new Set(['fail', 'keep-newest']);
const DEFAULT_ON_DUPLICATE = 'fail';

function parseArgs(argv) {
  const parsed = {
    db: null, projectId: null, file: null, historyFile: null,
    headingsConfig: DEFAULT_HEADINGS_CONFIG_PATH, authoringMode: 'verbose',
    rollback: false, dryRun: false, reportDir: DEFAULT_REPORT_DIR, help: false,
    onDuplicate: DEFAULT_ON_DUPLICATE,
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
    else if (a === '--on-duplicate') parsed.onDuplicate = argv[++i];
    else if (a.startsWith('--on-duplicate=')) parsed.onDuplicate = a.slice('--on-duplicate='.length);
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
    '                         the read-only schema-precondition checks (branch-aware — CANON/STAGING require',
    '                         source_model+carryover_status; PER_PROJECT_ENGINE requires only the ENGINE_CANON',
    '                         columns this script writes, never carryover_status). Mutually exclusive with --rollback.',
    '  --rollback             Delete this project\'s migrated rows + manifest slices instead of migrating.',
    '  --report-dir <path>    Directory for the per-project fail-soft parse report (default: ./reports).',
    '  --on-duplicate <mode>  "fail" (default) or "keep-newest" -- catalog-driven unique-constraint preflight',
    '                         policy (P1/P2). "fail": any collides_existing/in_batch_duplicate/unclassified row',
    '                         refuses the write. "keep-newest": in_batch_duplicate groups keep their newest',
    '                         member live (by parsed session recency, never document position) and suppress the',
    '                         rest (suppression_kind=\'superseded\'); collides_existing/unclassified still ALWAYS fail.',
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
    // item B / constraint-preflight (2026-09-06): the enclosing section's own
    // session identity (sessionNum/date), when this section IS a session
    // block — null for a non-session section (preamble, durable heading,
    // etc.). Threaded onto every row this section produces so
    // constraint-preflight.js's session_rank can order rows by the SECTION
    // HEADING's own parsed identity, never by document position (a real
    // HANDOFF-HISTORY.md is newest-first — position-as-recency would rank
    // backwards).
    const enclosingSession = SESSION_TYPES.has(section.type)
      ? { sessionNum: section.classification.sessionNum || null, date: section.classification.date || null }
      : null;

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
          fileKind,
          enclosingSession,
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
        fileKind,
        enclosingSession,
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
        fileKind,
        enclosingSession: null, // a durable heading is its own top-level section, never nested in a session
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
          fileKind,
          enclosingSession: null, // NEXT SESSION is its own top-level section, never nested in a session
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

// ─── SLICE / BATCH ASSEMBLY (shared by dry-run and write paths) ───────────

/**
 * buildSlices — the same 4-category-per-file slice list dry-run and write
 * mode both need (dry-run needs it to run the constraint preflight for
 * reporting; write mode needs it for both the preflight AND the actual
 * INSERT). Pure (no I/O beyond the already-parsed inputs).
 */
function buildSlices({ activeParsed, historyParsed, filePath, historyFilePath }) {
  const slices = [];
  if (activeParsed) {
    const activeSourceDb = filesystemSourceDb(filePath);
    slices.push({ sourceDb: activeSourceDb, sourceTable: SLICE_NAMES.ACTIVE_SESSION_SUMMARY, rows: toSessionAssertionRows(activeParsed.sessionTldrRows) });
    slices.push({ sourceDb: activeSourceDb, sourceTable: SLICE_NAMES.ACTIVE_OPEN_CARRYOVERS, rows: toOpenThreadAssertionRows(activeParsed.openThreadRows) });
    slices.push({ sourceDb: activeSourceDb, sourceTable: SLICE_NAMES.ACTIVE_DURABLE_SECTIONS, rows: toDurableAssertionRows(activeParsed.durableRows) });
    slices.push({ sourceDb: activeSourceDb, sourceTable: SLICE_NAMES.ACTIVE_NEXT_SESSION_ITEMS, rows: toNextStepAssertionRows(activeParsed.nextStepRows) });
  }
  if (historyParsed) {
    const historySourceDb = filesystemSourceDb(historyFilePath);
    slices.push({ sourceDb: historySourceDb, sourceTable: SLICE_NAMES.HISTORY_SESSION_BLOCKS, rows: toSessionAssertionRows(historyParsed.sessionTldrRows) });
    slices.push({ sourceDb: historySourceDb, sourceTable: SLICE_NAMES.HISTORY_OPEN_CARRYOVERS, rows: toOpenThreadAssertionRows(historyParsed.openThreadRows) });
    slices.push({ sourceDb: historySourceDb, sourceTable: SLICE_NAMES.HISTORY_DURABLE_SECTIONS, rows: toDurableAssertionRows(historyParsed.durableRows) });
    slices.push({ sourceDb: historySourceDb, sourceTable: SLICE_NAMES.HISTORY_NEXT_SESSION_ITEMS, rows: toNextStepAssertionRows(historyParsed.nextStepRows) });
  }
  return slices;
}

/**
 * flattenSlices — every slice's rows, in slice/row order, as ONE flat array.
 * Stamps `row.__batchOrd` (1-indexed, matching array position) directly
 * onto each row object — the SAME object references writeProjectMigration
 * later iterates via `slices`, so a per-row preflight decision keyed by
 * `__batchOrd` can never drift out of alignment with a reordering of one
 * loop but not the other (there is only one loop's worth of ordering,
 * stamped once, read by reference everywhere else).
 */
function flattenSlices(slices) {
  const flat = [];
  for (const slice of slices) {
    for (const row of slice.rows) flat.push(row);
  }
  flat.forEach((row, i) => { row.__batchOrd = i + 1; });
  return flat;
}

/** buildPreflightValues — the exact column/value shape writeProjectMigration
 * would INSERT for this row, as a plain dict keyed by real assertions
 * column names (constraint-preflight.js's temp table reads whichever of
 * these keys the LIVE target's catalog actually has — a column this dict
 * supplies that the target lacks, e.g. carryover_status on a
 * PER_PROJECT_ENGINE target, is simply never selected; no branch-awareness
 * needed here). suppressed:false/suppression_kind:null is the pre-policy
 * "as if inserted live" candidate state the preflight simulates against.
 */
function buildPreflightValues(row, projectId, authoringMode) {
  return {
    project_id: projectId,
    subject: row.subject,
    predicate: row.predicate,
    object: row.object,
    confidence: DEFAULT_CONFIDENCE,
    source: SOURCE_VALUE,
    tier: TIER_VALUE,
    pinned: !!row.pinned,
    carryover_status: row.carryoverStatus || null,
    seq: row.seq ?? null,
    source_model: SOURCE_MODEL_TAG,
    authoring_mode: authoringMode,
    created_at: row.createdAt || null,
    suppressed: false,
    suppression_kind: null,
  };
}

/** runConstraintPreflight — thin adapter from this file's row shape to
 * constraint-preflight.js's runPreflight() input shape. See that module's
 * header comment for the full P1/P2/P3 algorithm.
 */
async function runConstraintPreflight(tgtClient, { projectId, authoringMode, onDuplicate, flatBatchRows }) {
  const rows = flatBatchRows.map((row) => ({
    values: buildPreflightValues(row, projectId, authoringMode),
    fileKind: row.fileKind,
    enclosingSession: row.enclosingSession || null,
    sourceLineNo: row.sourceLineNo ?? null,
    headingLineNo: row.headingLineNo ?? null,
  }));
  return constraintPreflight.runPreflight(tgtClient, { projectId, sourceModelTag: SOURCE_MODEL_TAG, rows, onDuplicate });
}

function printPreflightSummary(result) {
  const b = result.buckets;
  console.log(`  [PREFLIGHT] policy=${result.policy} insert=${b.insert} in_batch_duplicate=${b.in_batch_duplicate} collides_existing=${b.collides_existing} unclassified=${b.unclassified}`);
  if (result.notApplicableIndexes.length) {
    console.log(`  [PREFLIGHT] not_applicable_indexes=${result.notApplicableIndexes.map((i) => `${i.name}(missing:${i.missingColumns.join(',')})`).join(', ')}`);
  }
  if (result.applicableIndexNames.length) {
    console.log(`  [PREFLIGHT] applicable_indexes=${result.applicableIndexNames.join(', ')}`);
  }
  for (const e of result.perIndexErrors) {
    console.log(`  [PREFLIGHT] index_error index=${e.index} error=${e.error}`);
  }
  for (const r of result.recheckGroups) {
    console.log(`  [PREFLIGHT] recheck_violation index=${r.index} groups=${r.groups || 0}${r.error ? ` error=${r.error}` : ''}`);
  }
  for (const g of result.topGroups) {
    console.log(`  [PREFLIGHT] top_group index=${g.index} member_count=${g.memberCount} has_existing=${g.hasExisting}`);
  }
}

/**
 * evaluatePreflightFailure — P3's PASS/FAIL rule, both dry-run and write:
 * collides_existing and unclassified ALWAYS fail regardless of policy;
 * in_batch_duplicate only fails under the (default) 'fail' policy —
 * 'keep-newest' resolves it (or, if the post-policy recheck finds it
 * couldn't, those rows already became 'unclassified' by the time this
 * runs, so the unclassified check above already covers that path).
 *
 * @returns {string|null} a human-readable reason, or null (PASS).
 */
function evaluatePreflightFailure(result) {
  const b = result.buckets;
  if (b.collides_existing > 0) return `collides_existing=${b.collides_existing}`;
  if (b.unclassified > 0) return `unclassified=${b.unclassified}`;
  if (result.policy === 'fail' && b.in_batch_duplicate > 0) return `in_batch_duplicate=${b.in_batch_duplicate} (policy=fail)`;
  return null;
}

/** applyPreflightDecisions — stamps each batch row with the preflight's
 * per-row suppressed/suppression_kind decision (keyed by __batchOrd, see
 * flattenSlices()), for writeProjectMigration to write verbatim.
 */
function applyPreflightDecisions(flatBatchRows, preflightResult) {
  const byOrd = new Map(preflightResult.perRow.map((d) => [d.batchOrd, d]));
  for (const row of flatBatchRows) {
    const d = byOrd.get(row.__batchOrd);
    row.__suppressed = d ? d.suppressed : false;
    row.__suppressionKind = d ? d.suppressionKind : null;
  }
}

function countLive(flatBatchRows) {
  return flatBatchRows.filter((r) => !r.__suppressed).length;
}

// ─── WHOLE-PROJECT WRITE (H-6) ─────────────────────────────────────────────

/**
 * writeProjectMigration — the H-6 whole-project delete-and-reinsert.
 *
 * branch-aware (spec item 3): on PER_PROJECT_ENGINE, ADDENDA_ONLY columns
 * (carryover_status) are omitted from the INSERT's column list entirely —
 * never written, never NULL-padded as a placeholder — because that column
 * does not exist on a bare per-project engine schema. This is the ONLY
 * caller that hard-codes the assertions column list for this migration; it
 * is not routed through any shared writer (writeAssertionWithSupersession
 * in handoff.js is a live runtime writer used by close/checkpoint, never
 * called by this script), so the branch-aware column list lives here, not
 * behind a shared-writer option flag.
 *
 * item B / constraint-preflight (P3): every row is expected to already carry
 * `__suppressed`/`__suppressionKind` (stamped by applyPreflightDecisions()
 * from the SAME preflight result this write's caller already gated on —
 * see main()). Both default to false/null when absent (rollback/legacy
 * caller safety), never fatal on their own — the preflight gate upstream is
 * what refuses a bad batch; this function trusts whatever decision it is
 * handed and verifies the OUTCOME via the post-insert assertion below.
 *
 * @param {Array<{sourceDb, sourceTable, rows}>} slices
 * @param {string} branch - classifyTarget() branch ('CANON'|'STAGING'|'PER_PROJECT_ENGINE')
 * @param {number} [policyLiveCount] - expected count of non-suppressed rows
 *   after this write (P3 post-insert assertion); defaults to the full batch
 *   size when omitted (i.e. "every row is expected live" — the --on-
 *   duplicate=fail default's shape).
 */
async function writeProjectMigration(tgtClient, { projectId, authoringMode, slices, branch, policyLiveCount }) {
  const includeCarryoverStatus = !omittedColumnsForBranch(branch).includes('carryover_status');

  await tgtClient.query('BEGIN');
  let totalWritten = 0;
  try {
    await tgtClient.query(
      `DELETE FROM assertions WHERE project_id = $1 AND source_model = $2`,
      [projectId, SOURCE_MODEL_TAG]
    );

    for (const slice of slices) {
      for (const row of slice.rows) {
        const cols = ['project_id', 'subject', 'predicate', 'object', 'confidence', 'source', 'tier', 'pinned'];
        const vals = [
          projectId, row.subject, row.predicate, row.object, DEFAULT_CONFIDENCE, SOURCE_VALUE, TIER_VALUE, !!row.pinned,
        ];
        if (includeCarryoverStatus) {
          cols.push('carryover_status');
          vals.push(row.carryoverStatus || null);
        }
        cols.push('seq', 'source_model', 'authoring_mode', 'suppressed', 'suppression_kind', 'created_at');
        vals.push(
          row.seq ?? null, SOURCE_MODEL_TAG, authoringMode,
          !!row.__suppressed, row.__suppressionKind || null,
          row.createdAt || null
        );
        // cols[] and vals[] are built in lockstep above, so index i in one is
        // always index i in the other — the last column (created_at) is the
        // one exception, COALESCE'd to now() rather than bound raw.
        const lastIdx = vals.length; // 1-indexed position of created_at's placeholder
        const placeholders = cols.map((c, i) => (c === 'created_at' ? `COALESCE($${lastIdx}, now())` : `$${i + 1}`));
        await tgtClient.query(
          `INSERT INTO assertions (${cols.join(', ')}) VALUES (${placeholders.join(',')})`,
          vals
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

    // ── P3 post-insert assertion ─────────────────────────────────────────
    // Never trust the loop's own totalWritten counter as proof of what
    // actually landed — verify the live catalog directly, inside the same
    // transaction, before COMMIT. A mismatch throws (caught below -> the
    // whole transaction rolls back, exactly like any other failure here).
    const expectedLive = policyLiveCount != null ? policyLiveCount : totalWritten;
    const { rows: countRows } = await tgtClient.query(
      `SELECT
         count(*) FILTER (WHERE true) AS inserted,
         count(*) FILTER (WHERE suppressed = false) AS live
       FROM assertions WHERE project_id = $1 AND source_model = $2`,
      [projectId, SOURCE_MODEL_TAG]
    );
    const actualInserted = Number(countRows[0].inserted);
    const actualLive = Number(countRows[0].live);
    if (actualInserted !== totalWritten) {
      throw new Error(
        `post-insert assertion failed: expected ${totalWritten} inserted row(s) tagged ` +
        `source_model='${SOURCE_MODEL_TAG}', found ${actualInserted}.`
      );
    }
    if (actualLive !== expectedLive) {
      throw new Error(
        `post-insert assertion failed: expected ${expectedLive} live (suppressed=false) row(s) ` +
        `per the constraint-preflight policy decision, found ${actualLive}.`
      );
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
 * and --dry-run mode (with --db) run: the "assertions" table exists, and it
 * carries this branch's required columns (requiredColumnsForBranch(branch)).
 * Never mutates anything.
 *
 * Branch-aware (item B / #251 follow-up, spec item 2): CANON/STAGING keep the
 * original two-column check (source_model, carryover_status) unchanged —
 * never loosened. PER_PROJECT_ENGINE checks the full ENGINE_CANON list this
 * migration writes, and does NOT require carryover_status (an ADDENDA_ONLY
 * column that a bare per-project engine schema never has). Any other branch
 * throws — requiredColumnsForBranch() is the single source of truth for
 * that total classification.
 *
 * @param {object} tgtClient
 * @param {string} branch - classifyTarget() branch
 * @returns {{assertionsTable:'pass'|'fail', requiredColumns:'pass'|'fail'|'not_checked', requiredColumnsList:string[], missingColumns:string[]}}
 */
async function checkSchemaPreconditions(tgtClient, branch) {
  const requiredColumnsList = requiredColumnsForBranch(branch); // throws on an unreachable branch (spec item 2)

  const { rows: tblRows } = await tgtClient.query(
    `SELECT 1 FROM information_schema.tables WHERE table_schema = current_schema() AND table_name = 'assertions' AND table_type = 'BASE TABLE'`
  );
  if (tblRows.length === 0) {
    return { assertionsTable: 'fail', requiredColumns: 'not_checked', requiredColumnsList, missingColumns: requiredColumnsList.slice() };
  }
  const { rows: presentCols } = await tgtClient.query(
    `SELECT column_name FROM information_schema.columns WHERE table_name='assertions' AND column_name = ANY($1::text[])`,
    [requiredColumnsList]
  );
  const presentSet = new Set(presentCols.map((r) => r.column_name));
  const missingColumns = requiredColumnsList.filter((c) => !presentSet.has(c));
  return {
    assertionsTable: 'pass',
    requiredColumns: missingColumns.length === 0 ? 'pass' : 'fail',
    requiredColumnsList,
    missingColumns,
  };
}

// ─── INTEGRITY INDEX CLASSIFICATION (S2/S3 — engine index bring-forward) ──
//
// DEFECT this closes (2026-09-06): a live migrate-08 WRITE against
// memory_manager_staging failed with "index row size 3552 exceeds btree
// version 4 maximum 2704 for index assertions_1ton_exact_unique". Staging's
// live index was still the STALE pre-cm#227 raw form
// `(project_id, subject, predicate, object) WHERE (suppressed = false)`;
// the canonical form is keyed on md5(object) instead (see
// handoff-core-schema.sql's own comment on the index for the full
// rationale). Root cause: this file never called the engine's own
// ensureSchemaCurrent() before INSERTing, so a target whose schema was
// behind (or whose integrity index re-create had once silently failed)
// was never brought forward — checkSchemaPreconditions() only ever probed
// information_schema.columns, which cannot see an index's DEFINITION at
// all (only whether a required COLUMN is present).
//
// S1 (see main(), WRITE mode only) calls ensureSchemaCurrent(db, projectId)
// before checkSchemaPreconditions() and checks its return: any reason
// other than 'current' or 'applied' aborts before any INSERT. A failed
// CREATE for the integrity index leaves the STALE index intact — db-seam.js
// (db.runIntegrityIndexPair) rolls the paired DROP back too when the CREATE
// fails, so the index is never left dropped-and-not-recreated. On a shared
// STAGING/CANON target this bring-forward step is expected to re-run once
// per distinct project_id that touches it (project_settings.schema_
// fingerprint is keyed per (project_id, key)) — each re-run is itself
// idempotent (every unit's own DDL is IF NOT EXISTS / DROP+CREATE-safe).
//
// S2/S3 (classifyIntegrityIndex, below + its call sites in main()): a total,
// independent classification of the LIVE assertions_1ton_exact_unique index
// into exactly one of CURRENT | STALE_RAW_OBJECT | MISSING | UNRECOGNIZED —
// checked AFTER S1 in WRITE mode (S1's own reported success is never taken
// as proof the live catalog object actually matches; this function inspects
// pg_class/pg_index directly, every time). WRITE proceeds only on CURRENT.
// DRY-RUN always reports the class; STALE_RAW_OBJECT/MISSING are
// PASS-with-note ("write mode will bring forward"); UNRECOGNIZED fails the
// dry-run report.
//
//   CURRENT           - live pg_get_indexdef (normalized) text-equals the
//                        canonical definition's pg_get_indexdef (also
//                        normalized), AND indisvalid=true AND
//                        indisunique=true.
//   STALE_RAW_OBJECT   - live pg_get_indexdef (normalized) text-equals the
//                        KNOWN pre-cm#227 raw form's pg_get_indexdef (also
//                        normalized). Requires indisvalid=true — checked
//                        BEFORE any shape comparison, below.
//   MISSING            - no index named assertions_1ton_exact_unique exists
//                        ON THE assertions TABLE specifically (indrelid-
//                        scoped: a same-named index that exists on a
//                        DIFFERENT table does not count as present here —
//                        still MISSING for assertions). Also covers
//                        "assertions itself does not exist yet" (by
//                        definition, no index can exist on an absent
//                        table).
//   UNRECOGNIZED       - the default branch: an INVALID index of ANY form
//                        (checked first, unconditionally — an invalid
//                        index is never CURRENT or STALE_RAW_OBJECT no
//                        matter what its definition text says), or any
//                        VALID index whose definition matches neither
//                        canonical nor the known stale-raw form.
//
// Canonical-definition normalization engine (the ONE rule — S2, no other
// string munging applied anywhere in this classification): inside a
// transaction that is ALWAYS rolled back (never committed — dry-run leaves
// zero persistent objects, and this same code path runs in both dry-run
// and write mode), create a TEMP TABLE literally named "assertions" —
// shadowing the real table via Postgres's own pg_temp-searched-first name
// resolution, so an UNMODIFIED copy of the real CREATE UNIQUE INDEX
// statement (extracted BY INDEX NAME from handoff-core-schema.sql via
// handoff.js's own _extractIntegrityIndexOps — never a second parser) runs
// against it without any rewriting. Read back pg_get_indexdef, then
// ROLLBACK. The SAME 'assertions'::regclass-scoped query used for the LIVE
// probe (_queryLiveIndexInfo) is reused unchanged for this reference
// computation: outside the temp transaction it resolves to the real table;
// inside it, to the shadowing temp table. The two texts are compared only
// after replacing the "ON <optional-schema-qualifier>.assertions" relation
// qualifier on BOTH sides with the bare "ON assertions" — the real table
// may render schema-qualified or not depending on search_path, and the
// temp table always renders qualified with its session-scoped pg_temp_N
// schema name; this qualifier strip is the only textual normalization
// applied, identically, to both sides.

const INTEGRITY_INDEX_NAME = 'assertions_1ton_exact_unique';

// The KNOWN pre-cm#227 raw form (see this section's DEFECT note above and
// cm#227's own comment in handoff-core-schema.sql). Intentionally
// hardcoded here, NOT extracted from any live schema file — this shape no
// longer exists anywhere in this repo's schema roster; it is a fixed
// historical reference point for classification only, never applied to any
// real database by this file.
const STALE_RAW_OBJECT_CREATE_SQL =
  'CREATE UNIQUE INDEX assertions_1ton_exact_unique ' +
  'ON assertions (project_id, subject, predicate, object) ' +
  'WHERE suppressed = false';

/**
 * The ONE normalization rule (S2): strip an optional "<schema>." qualifier
 * immediately before "assertions" in the index definition's "ON ..."
 * clause. Never mutates anything else in the string.
 */
function _normalizeIndexDefForCompare(def) {
  if (typeof def !== 'string') return def;
  return def.replace(/\bON\s+(?:[A-Za-z_][A-Za-z0-9_$]*\.)?assertions\b/i, 'ON assertions');
}

/**
 * Search-path-aware live probe: scoped by indrelid='assertions'::regclass
 * (never a bare relname match), so a same-named index on a DIFFERENT table
 * is correctly invisible here. Reused unchanged, inside a temp-table-
 * shadowing transaction, to compute a reference definition (see the
 * section header comment).
 */
async function _queryLiveIndexInfo(tgtClient, indexName) {
  const { rows } = await tgtClient.query(
    `SELECT c.relname AS indexname, i.indisvalid, i.indisunique,
            pg_get_indexdef(i.indexrelid) AS indexdef
       FROM pg_index i
       JOIN pg_class c ON c.oid = i.indexrelid
      WHERE i.indrelid = 'assertions'::regclass
        AND c.relname = $1`,
    [indexName]
  );
  return rows.length > 0 ? rows[0] : null;
}

/**
 * Extract the canonical CREATE UNIQUE INDEX statement for indexName from
 * handoff-core-schema.sql, reusing handoff.js's own _extractIntegrityIndexOps
 * (never a second SQL parser). Throws on schema-file drift (the index is
 * gone from the file, or renamed) — that is a build-time bug, never a
 * live-DB classification outcome.
 */
function _extractCanonicalCreateSql(indexName) {
  const schemaSql = fs.readFileSync(CORE_SCHEMA_SQL_PATH, 'utf8');
  const { ops } = handoffMod._extractIntegrityIndexOps(schemaSql);
  const op = ops.find((o) => o.name === indexName);
  if (!op) {
    throw new Error(
      `_extractCanonicalCreateSql: no CREATE UNIQUE INDEX "${indexName}" found via ` +
      `_extractIntegrityIndexOps() over ${CORE_SCHEMA_SQL_PATH} -- schema file drift?`
    );
  }
  return op.createSql;
}

/**
 * Compute the pg_get_indexdef() an (unmodified) CREATE UNIQUE INDEX
 * statement would produce, without ever persisting anything — see the
 * section header comment for the full temp-table-shadowing mechanism.
 * Returns null if the statement's index never becomes visible under the
 * expected name (defensive; not expected to occur for either of this
 * file's two reference statements).
 */
async function _computeReferenceIndexDef(tgtClient, indexName, createSql) {
  await tgtClient.query('BEGIN');
  try {
    await tgtClient.query(
      `CREATE TEMP TABLE assertions (
         project_id TEXT, subject TEXT, predicate TEXT, object TEXT, suppressed BOOLEAN
       ) ON COMMIT DROP`
    );
    await tgtClient.query(createSql);
    const info = await _queryLiveIndexInfo(tgtClient, indexName);
    return info ? info.indexdef : null;
  } finally {
    await tgtClient.query('ROLLBACK');
  }
}

/**
 * classifyIntegrityIndex — S2's total classification of the LIVE
 * assertions_1ton_exact_unique index. Never throws for a live-DB shape
 * reason: MISSING covers "assertions itself doesn't exist yet" too (a
 * 42P01 undefined_table from the 'assertions'::regclass cast is caught and
 * folded into MISSING — by definition, no index can exist on an absent
 * table). Only a schema-file-drift error (canonical DDL not found in
 * handoff-core-schema.sql) or a genuine connection error propagates.
 *
 * @param {object} tgtClient - connected pg.Client
 * @returns {Promise<{class: 'CURRENT'|'STALE_RAW_OBJECT'|'MISSING'|'UNRECOGNIZED', indexdef: string|null, indisvalid: boolean|null, indisunique: boolean|null}>}
 */
async function classifyIntegrityIndex(tgtClient) {
  const indexName = INTEGRITY_INDEX_NAME;
  let live;
  try {
    live = await _queryLiveIndexInfo(tgtClient, indexName);
  } catch (err) {
    if (err && err.code === '42P01') {
      return { class: 'MISSING', indexdef: null, indisvalid: null, indisunique: null };
    }
    throw err;
  }
  if (!live) {
    return { class: 'MISSING', indexdef: null, indisvalid: null, indisunique: null };
  }
  if (live.indisvalid !== true) {
    // INVALID of ANY form -> UNRECOGNIZED, checked BEFORE any shape
    // comparison (S2).
    return { class: 'UNRECOGNIZED', indexdef: live.indexdef, indisvalid: live.indisvalid, indisunique: live.indisunique };
  }

  const liveNorm = _normalizeIndexDefForCompare(live.indexdef);

  const canonicalCreateSql = _extractCanonicalCreateSql(indexName);
  const canonicalDef = await _computeReferenceIndexDef(tgtClient, indexName, canonicalCreateSql);
  const canonicalNorm = _normalizeIndexDefForCompare(canonicalDef);
  if (canonicalNorm != null && liveNorm === canonicalNorm && live.indisunique === true) {
    return { class: 'CURRENT', indexdef: live.indexdef, indisvalid: live.indisvalid, indisunique: live.indisunique };
  }

  const staleDef = await _computeReferenceIndexDef(tgtClient, indexName, STALE_RAW_OBJECT_CREATE_SQL);
  const staleNorm = _normalizeIndexDefForCompare(staleDef);
  if (staleNorm != null && liveNorm === staleNorm) {
    return { class: 'STALE_RAW_OBJECT', indexdef: live.indexdef, indisvalid: live.indisvalid, indisunique: live.indisunique };
  }

  return { class: 'UNRECOGNIZED', indexdef: live.indexdef, indisvalid: live.indisvalid, indisunique: live.indisunique };
}

// ─── HUMAN-READABLE SUMMARY (cm#222 A1: dry-run emits this + the JSON) ────

function printHumanSummary({ parsed, activeParsed, historyParsed, preconditionChecks, branch }) {
  console.log('--- handoff-markdown parse summary ---');
  console.log(`  mode: ${parsed.dryRun ? 'DRY-RUN' : (parsed.rollback ? 'ROLLBACK' : 'MIGRATE')}`);
  if (preconditionChecks) {
    console.log(`  schema preconditions: assertions_table=${preconditionChecks.assertionsTable} required_columns=${preconditionChecks.requiredColumns}`);
    console.log(`  required_columns=[${preconditionChecks.requiredColumnsList.join(',')}] (branch=${branch})`);
    if (preconditionChecks.missingColumns.length) {
      console.log(`  missing_columns=[${preconditionChecks.missingColumns.join(',')}]`);
    }
    const omitted = omittedColumnsForBranch(branch);
    if (omitted.length) {
      console.log(`  branch=${branch} omitted_columns=[${omitted.join(',')}]`);
      console.log('  (consolidation-only column(s); carryover rendering is not part of engine canon — omitted from the write on PER_PROJECT_ENGINE targets, never written as NULL)');
    }
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
  if (!ON_DUPLICATE_VALUES.has(parsed.onDuplicate)) {
    console.error(`Invalid --on-duplicate "${parsed.onDuplicate}" — must be "fail" or "keep-newest".`);
    process.exit(2);
  }

  // ── cm#222 A1: TRUE dry-run — parse + report, zero DDL/writes. ─────────
  if (parsed.dryRun) {
    let preconditionChecks = null;
    let dbBranch = null;
    let integrityIndexResult = null;
    let preflightResult = null;

    // Parsing never needs a DB connection — done up front so the constraint
    // preflight (P1, which DOES need one) can run in the SAME connection
    // window as the precondition/integrity-index checks below, rather than
    // opening a second connection.
    const headingsConfigEarly = loadHeadingsConfig(parsed.headingsConfig);
    const activeFileEarly = loadAndNormalizeFile(parsed.file);
    const historyFileEarly = loadAndNormalizeFile(parsed.historyFile);
    if (parsed.file && !activeFileEarly.present) {
      console.log(`  [FAIL-SOFT] could not read --file "${parsed.file}": ${activeFileEarly.readError}`);
    }
    if (parsed.historyFile && !historyFileEarly.present) {
      console.log(`  [FAIL-SOFT] could not read --history-file "${parsed.historyFile}": ${historyFileEarly.readError}`);
    }
    if (!activeFileEarly.present && !historyFileEarly.present) {
      console.error('Refused: neither --file nor --history-file could be read. Nothing to report.');
      process.exit(1);
    }
    for (const flag of [...(activeFileEarly.normalized ? activeFileEarly.normalized.flags : []), ...(historyFileEarly.normalized ? historyFileEarly.normalized.flags : [])]) {
      logNormalizeFlag(flag);
    }
    const activeParsedEarly = activeFileEarly.present ? parseFileIntoRows(activeFileEarly.normalized.text, headingsConfigEarly.headings, 'active', activeFileEarly.normalized.flags) : null;
    const historyParsedEarly = historyFileEarly.present ? parseFileIntoRows(historyFileEarly.normalized.text, headingsConfigEarly.headings, 'history', historyFileEarly.normalized.flags) : null;
    const slicesEarly = buildSlices({ activeParsed: activeParsedEarly, historyParsed: historyParsedEarly, filePath: parsed.file, historyFilePath: parsed.historyFile });
    const flatBatchRowsEarly = flattenSlices(slicesEarly);

    if (parsed.db) {
      const { name: target, source: targetSource } = migrateOne.resolveTargetDb({ db: parsed.db });
      if (!migrateOne.DB_NAME_RE.test(target)) {
        console.error(`Invalid database name "${target}" (from ${targetSource}) — must match /^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/.`);
        process.exit(1);
      }
      const classification = await migrateOne.classifyTarget({ dbName: target, projectId: parsed.projectId });
      if (!classification.allowed) {
        console.error(`Refused: ${classification.reason}`);
        console.error(
          classification.connectionOpened
            ? '(read-only probe opened and closed.)'
            : `(resolved from ${targetSource} — no database connection was opened.)`
        );
        process.exit(1);
      }
      if (classification.branch === 'PER_PROJECT_ENGINE') {
        // Defensive cross-check (spec item 3): the probe already verified the
        // DB's project_id equals --project-id before returning this branch,
        // so this can never actually fire — but the write path below uses
        // parsed.projectId directly, so assert equality rather than trust it.
        const normalizedParsed = migrateOne.normalizeProjectId(parsed.projectId);
        const normalizedProbe = migrateOne.normalizeProjectId(classification.projectId);
        if (normalizedParsed !== normalizedProbe) {
          console.error(
            `Refused: probed project_id "${classification.projectId}" does not match ` +
            `--project-id "${parsed.projectId}" (should be unreachable).`
          );
          process.exit(1);
        }
      }
      dbBranch = classification.branch;
      console.log(`migrate-08-handoff-markdown: DRY-RUN target="${target}" (resolved from ${targetSource}, branch=${classification.branch}) — read-only precondition checks only, zero writes`);
      const tgtClient = new Client(migrateOne.pgConfig(target));
      try {
        await tgtClient.connect();
        preconditionChecks = await checkSchemaPreconditions(tgtClient, dbBranch);
        // S2: total classification of the LIVE integrity index — read-only
        // (temp-table-shadowed, always rolled back — see the section header
        // comment above classifyIntegrityIndex). Runs regardless of the
        // column-precondition result above: independent checks, both
        // reported.
        integrityIndexResult = await classifyIntegrityIndex(tgtClient);
        // P1 (dry-run branch, item B / cm#233 successor): read-only,
        // self-rolled-back constraint preflight — runs regardless of the
        // column-precondition/integrity-index results above (independent
        // checks, all three reported).
        preflightResult = await runConstraintPreflight(tgtClient, {
          projectId: parsed.projectId, authoringMode: parsed.authoringMode,
          onDuplicate: parsed.onDuplicate, flatBatchRows: flatBatchRowsEarly,
        });
      } catch (err) {
        console.error(`Could not complete read-only precondition checks against target "${target}": ${err.message}`);
        process.exit(1);
      } finally {
        await tgtClient.end();
      }
      console.log(`  integrity_index_class=${integrityIndexResult.class} indisvalid=${integrityIndexResult.indisvalid} indisunique=${integrityIndexResult.indisunique}`);
      if (integrityIndexResult.indexdef) {
        console.log(`  live_indexdef=${integrityIndexResult.indexdef}`);
      }
      if (integrityIndexResult.class === 'STALE_RAW_OBJECT' || integrityIndexResult.class === 'MISSING') {
        console.log(`  note: write mode will bring forward (class=${integrityIndexResult.class})`);
      } else if (integrityIndexResult.class === 'UNRECOGNIZED') {
        console.log('  note: UNRECOGNIZED integrity index shape — write mode will refuse (S3); manual investigation required');
      }
      printPreflightSummary(preflightResult);
    } else {
      console.log('migrate-08-handoff-markdown: DRY-RUN (no --db) — schema preconditions not checked, parse-only');
      console.log('  [PREFLIGHT] not_checked (no --db) — constraint preflight requires a live catalog connection');
    }

    const activeParsed = activeParsedEarly;
    const historyParsed = historyParsedEarly;
    const crossFileCollisions = computeCrossFileCollisions(activeParsed, historyParsed);

    printHumanSummary({ parsed, activeParsed, historyParsed, preconditionChecks, branch: dbBranch });

    const report = buildReport({
      parsed, activeParsed, historyParsed, totalWritten: 0, crossFileCollisions,
      preconditionChecks, integrityIndexResult, preflightResult, mode: 'dry_run', branch: dbBranch,
    });
    const reportPath = writeReport(parsed.reportDir, parsed.projectId, report);
    console.log(`  [REPORT] ${reportPath}`);

    const preconditionsFailed = preconditionChecks
      && (preconditionChecks.assertionsTable === 'fail' || preconditionChecks.requiredColumns === 'fail');
    // S3: UNRECOGNIZED makes the dry-run report FAIL — CURRENT/STALE_RAW_OBJECT/
    // MISSING (and 'not checked', no --db) never fail the dry-run on their own.
    const integrityIndexUnrecognized = integrityIndexResult && integrityIndexResult.class === 'UNRECOGNIZED';
    // P3: constraint-preflight failure (collides_existing/unclassified always;
    // in_batch_duplicate under --on-duplicate=fail) also fails the dry-run.
    const preflightFailureReason = preflightResult ? evaluatePreflightFailure(preflightResult) : null;
    if (preconditionsFailed || integrityIndexUnrecognized || preflightFailureReason) {
      if (preflightFailureReason) {
        console.error(`  constraint preflight: FAIL (${preflightFailureReason})`);
      }
      console.error('DRY_RUN_RESULT: FAIL (schema preconditions not met, integrity index class is UNRECOGNIZED, or constraint preflight failed — see report)');
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
  const classification = await migrateOne.classifyTarget({ dbName: target, projectId: parsed.projectId });
  if (!classification.allowed) {
    console.error(`Refused: ${classification.reason}`);
    console.error(
      classification.connectionOpened
        ? '(read-only probe opened and closed.)'
        : `(resolved from ${targetSource} — no database connection was opened.)`
    );
    process.exit(1);
  }
  if (classification.branch === 'PER_PROJECT_ENGINE') {
    // Defensive cross-check (spec item 3) — see the dry-run branch above for
    // the identical rationale; the write path below uses parsed.projectId
    // directly for every INSERT, so this assertion must hold.
    const normalizedParsed = migrateOne.normalizeProjectId(parsed.projectId);
    const normalizedProbe = migrateOne.normalizeProjectId(classification.projectId);
    if (normalizedParsed !== normalizedProbe) {
      console.error(
        `Refused: probed project_id "${classification.projectId}" does not match ` +
        `--project-id "${parsed.projectId}" (should be unreachable).`
      );
      process.exit(1);
    }
  }

  console.log(`migrate-08-handoff-markdown: target="${target}" (resolved from ${targetSource}, branch=${classification.branch}) project_id="${parsed.projectId}" mode=${parsed.rollback ? 'ROLLBACK' : 'MIGRATE'}`);

  const tgtClient = new Client(migrateOne.pgConfig(target));
  try {
    await tgtClient.connect();
  } catch (err) {
    console.error(`Could not connect to target database "${target}": ${err.message}`);
    process.exit(1);
  }

  let exitCode = 0;
  try {
    const branch = classification.branch;

    // ── S1 (bring-forward, WRITE mode only — this is not the --dry-run
    // branch, which returned above and never reaches here): run BEFORE
    // checkSchemaPreconditions() and BEFORE any INSERT/DELETE. A target
    // whose schema is behind (or whose integrity index previously failed to
    // apply) must never reach the write path silently — see this file's
    // "INTEGRITY INDEX CLASSIFICATION" section header comment (above
    // classifyIntegrityIndex) for the full DEFECT/root-cause writeup.
    // Invoked once per (target, projectId) per process — on a shared
    // STAGING/CANON target, a distinct --project-id re-runs this (and its
    // own SCHEMA_EPOCH-gated intent-key migration) again; both are
    // idempotent (project_settings.schema_fingerprint is keyed per
    // (project_id, key), and every unit's own DDL is IF NOT EXISTS /
    // DROP+CREATE-safe).
    const schemaAdapter = new PostgresAdapter(tgtClient);
    const bringForward = await handoffMod.ensureSchemaCurrent(schemaAdapter, parsed.projectId, { silent: false });
    console.log(`  [SCHEMA-BRING-FORWARD] applied=${bringForward.applied} reason=${bringForward.reason}`);
    if (bringForward.reason !== 'current' && bringForward.reason !== 'applied') {
      console.error(`Refused: schema bring-forward for project_id="${parsed.projectId}" on target "${target}" did not succeed (reason=${bringForward.reason}).`);
      console.error(`  detail=${JSON.stringify(bringForward.detail || {})}`);
      console.error(
        '  A failed CREATE for an integrity index leaves the STALE index intact ' +
        '(db-seam.js runIntegrityIndexPair rolls the paired DROP back too when the CREATE ' +
        'fails, so the index is never left dropped-and-not-recreated) — but nothing was ' +
        'brought forward either. Nothing was applied.'
      );
      process.exitCode = 1;
      return;
    }

    // ── S2/S3 (index classification gate, checked AFTER S1, independent of
    // S1's own return value): WRITE proceeds only when the LIVE index is
    // classified CURRENT. S1 reporting success is never trusted as proof
    // the live catalog object actually matches the canonical shape.
    const integrityIndexResult = await classifyIntegrityIndex(tgtClient);
    console.log(`  integrity_index_class=${integrityIndexResult.class} indisvalid=${integrityIndexResult.indisvalid} indisunique=${integrityIndexResult.indisunique}`);
    if (integrityIndexResult.class !== 'CURRENT') {
      console.error(`Refused: assertions_1ton_exact_unique is not CURRENT after schema bring-forward (class=${integrityIndexResult.class}).`);
      console.error(`  live pg_get_indexdef=${integrityIndexResult.indexdef}`);
      console.error(`  indisvalid=${integrityIndexResult.indisvalid}`);
      console.error('  Nothing was applied.');
      process.exitCode = 1;
      return;
    }

    const preconditionChecks = await checkSchemaPreconditions(tgtClient, branch);
    console.log(`  required_columns=[${preconditionChecks.requiredColumnsList.join(',')}] (branch=${branch})`);
    if (preconditionChecks.assertionsTable === 'fail') {
      console.error(`Refused: target "${target}" is missing the "assertions" table.`);
      console.error('Run migrate-01-canonical-db.js against this target first. Nothing was applied.');
      process.exitCode = 1;
      return;
    }
    if (preconditionChecks.requiredColumns === 'fail') {
      console.error(`Refused: target "${target}"'s "assertions" table is missing required column(s): ${preconditionChecks.missingColumns.join(', ')}.`);
      if (branch === 'PER_PROJECT_ENGINE') {
        console.error('Run migrate-01-canonical-db.js (or let the engine\'s own ensureSchemaCurrent run) against this target first to bring the engine schema current. Nothing was applied.');
      } else {
        console.error('Run migrate-schema-addenda.js against this target first (attribution-columns.sql + migrate-06-carryover-status.sql). Nothing was applied.');
      }
      process.exitCode = 1;
      return;
    }

    const omitted = omittedColumnsForBranch(branch);
    if (omitted.length) {
      console.log(`  branch=${branch} omitted_columns=[${omitted.join(',')}]`);
      console.log('  (consolidation-only column(s); carryover rendering is not part of engine canon — omitted from the write on PER_PROJECT_ENGINE targets, never written as NULL)');
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

    const slices = buildSlices({ activeParsed, historyParsed, filePath: parsed.file, historyFilePath: parsed.historyFile });

    // ── constraint preflight (P1/P2/P3, item B / cm#233 successor) ────────
    // Read-only, self-rolled-back (see constraint-preflight.js's own header
    // for the full algorithm). Runs BEFORE any DELETE/INSERT — a
    // collides_existing or unclassified row (or an in_batch_duplicate row
    // under --on-duplicate=fail, the default) refuses the whole write,
    // nothing applied.
    const flatBatchRows = flattenSlices(slices);
    const preflightResult = await runConstraintPreflight(tgtClient, {
      projectId: parsed.projectId, authoringMode: parsed.authoringMode, onDuplicate: parsed.onDuplicate, flatBatchRows,
    });
    printPreflightSummary(preflightResult);
    const preflightFailure = evaluatePreflightFailure(preflightResult);
    if (preflightFailure) {
      console.error(`Refused: constraint preflight failed (${preflightFailure}). Nothing was applied.`);
      process.exitCode = 1;
      return;
    }
    applyPreflightDecisions(flatBatchRows, preflightResult);

    const { totalWritten } = await writeProjectMigration(tgtClient, {
      projectId: parsed.projectId, authoringMode: parsed.authoringMode, slices, branch,
      policyLiveCount: countLive(flatBatchRows),
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

    const report = buildReport({ parsed, activeParsed, historyParsed, totalWritten, crossFileCollisions, preconditionChecks, integrityIndexResult, preflightResult, mode: 'migrate', branch });
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

// item B / constraint-preflight: every shaped row carries fileKind +
// enclosingSession (+ its own line-position field) forward from the parsed
// row — constraint-preflight.js's session_rank computation needs these to
// decide recency (P2); nothing else downstream reads them.
function toSessionAssertionRows(rows) {
  return rows.map((r) => ({
    subject: r.subject, predicate: 'session_tldr_archived', object: r.object,
    pinned: false, carryoverStatus: null, seq: null, createdAt: r.createdAt,
    fileKind: r.fileKind, enclosingSession: r.enclosingSession || null, headingLineNo: r.headingLineNo ?? null,
  }));
}
function toOpenThreadAssertionRows(rows) {
  return rows.map((r) => ({
    subject: r.subject, predicate: 'open_thread', object: r.object,
    pinned: false, carryoverStatus: 'open', seq: null, createdAt: null,
    fileKind: r.fileKind, enclosingSession: r.enclosingSession || null, sourceLineNo: r.sourceLineNo ?? null,
  }));
}
function toDurableAssertionRows(rows) {
  return rows.map((r) => ({
    subject: r.subject, predicate: r.predicate, object: r.object,
    pinned: true, carryoverStatus: null, seq: null, createdAt: null,
    fileKind: r.fileKind, enclosingSession: r.enclosingSession || null, headingLineNo: r.headingLineNo ?? null,
  }));
}
function toNextStepAssertionRows(rows) {
  return rows.map((r) => ({
    subject: r.subject, predicate: 'next_step', object: r.object,
    pinned: false, carryoverStatus: null, seq: r.seq, createdAt: null,
    fileKind: r.fileKind, enclosingSession: r.enclosingSession || null, headingLineNo: r.headingLineNo ?? null,
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

function buildReport({ parsed, activeParsed, historyParsed, totalWritten, crossFileCollisions, preconditionChecks, integrityIndexResult, preflightResult, mode, branch }) {
  return {
    mode: mode || (parsed.dryRun ? 'dry_run' : (parsed.rollback ? 'rollback' : 'migrate')),
    project_id: parsed.projectId,
    generated_at: new Date().toISOString(),
    file: parsed.file || null,
    history_file: parsed.historyFile || null,
    authoring_mode: parsed.authoringMode,
    total_assertions_written: totalWritten,
    branch: branch || null,
    precondition_checks: preconditionChecks
      ? {
        assertions_table: preconditionChecks.assertionsTable,
        required_columns: preconditionChecks.requiredColumns,
        required_columns_list: preconditionChecks.requiredColumnsList,
        missing_columns: preconditionChecks.missingColumns,
      }
      : { assertions_table: 'not_checked', required_columns: 'not_checked', required_columns_list: [], missing_columns: [] },
    // S2/S3: total classification of the live assertions_1ton_exact_unique
    // index. 'not_checked' only when no --db was given in dry-run mode.
    integrity_index_class: integrityIndexResult ? integrityIndexResult.class : 'not_checked',
    integrity_index_detail: integrityIndexResult
      ? {
        indexdef: integrityIndexResult.indexdef,
        indisvalid: integrityIndexResult.indisvalid,
        indisunique: integrityIndexResult.indisunique,
      }
      : null,
    // ADDENDA_ONLY columns this migration's write path omits from the
    // INSERT column list on this branch (empty on CANON/STAGING).
    omitted_columns: branch ? omittedColumnsForBranch(branch) : [],
    // P1-P3: catalog-driven unique-constraint preflight (item B / cm#233
    // successor). 'not_checked' only when no --db was given in dry-run mode.
    preflight: preflightResult
      ? {
        policy: preflightResult.policy,
        buckets: preflightResult.buckets,
        not_applicable_indexes: preflightResult.notApplicableIndexes,
        applicable_indexes: preflightResult.applicableIndexNames,
        top_groups: preflightResult.topGroups,
        per_index_errors: preflightResult.perIndexErrors,
        recheck_groups: preflightResult.recheckGroups,
      }
      : { policy: parsed.onDuplicate, buckets: null, not_applicable_indexes: [], applicable_indexes: [], top_groups: [], per_index_errors: [], recheck_groups: [] },
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
  requiredColumnsForBranch,
  omittedColumnsForBranch,
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
  ENGINE_CANON_COLUMNS,
  ADDENDA_ONLY_COLUMNS,
  SELF_BOOTSTRAPPED_COLUMNS,
  // S1/S2/S3 — engine index bring-forward + total-classified integrity-index
  // gate (exposed for test-migrate-08-handoff-markdown.js; no test-side
  // reimplementation of the classification or the temp-table normalization
  // engine).
  classifyIntegrityIndex,
  _normalizeIndexDefForCompare,
  _extractCanonicalCreateSql,
  _computeReferenceIndexDef,
  _queryLiveIndexInfo,
  INTEGRITY_INDEX_NAME,
  STALE_RAW_OBJECT_CREATE_SQL,
  CORE_SCHEMA_SQL_PATH,
  // P1-P4 — catalog-driven unique-constraint preflight (item B / cm#233
  // successor; exposed for test-migrate-08-handoff-markdown.js).
  buildSlices,
  flattenSlices,
  buildPreflightValues,
  runConstraintPreflight,
  evaluatePreflightFailure,
  applyPreflightDecisions,
  countLive,
  ON_DUPLICATE_VALUES,
  DEFAULT_ON_DUPLICATE,
};
