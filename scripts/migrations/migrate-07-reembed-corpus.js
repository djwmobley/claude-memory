'use strict';

/**
 * migrate-07-reembed-corpus.js
 *
 * CONSOLIDATION-RUNBOOK.md §6.1(g) + its G-1..G-14 spec-adversary amendment
 * (G-R1..G-R14, 2026-08-18, memory-manager#11(g)): batches every embeddable
 * row on the target through the embedding_providers-resolved default
 * provider, writing embedding + provenance, idempotently, with a rollback
 * mode and a completeness gate.
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHAT THIS SCRIPT DOES (mapped to the amended spec's G-R items)
 * ══════════════════════════════════════════════════════════════════════
 *
 *   TABLE ENUMERATION IS DDL-DERIVED (G-R1). discoverEmbeddableTables()
 *   scans pg_attribute/pg_type/pg_class for every base table with a
 *   vector/halfvec column -- never a hand-listed table array. On live
 *   staging today this finds 18 tables: the 13 §5.3 seam tables + sessions
 *   + agent_exchange + assertions + memory_entries + memory_entry_chunks.
 *
 *   CONTENT EXPRESSION RESOLUTION -- ONE DEVIATION FROM A LITERAL READING
 *   OF G-R1, DELIBERATE AND DOCUMENTED: the amended spec frames
 *   source-table-roster.json's `contentCol` as the hint source for
 *   "single-column" tables, with a per-table COALESCE "declared once in
 *   migrate-07 itself" for the multi-column Bucket C tables. This script
 *   instead declares a content expression for EVERY table it knows about
 *   (CONTENT_EXPRESSIONS below, all 18 present-day embeddable tables) and
 *   treats the roster purely as a VALIDATION overlay: any roster row
 *   naming a `contentCol` for a table this script recognizes is checked
 *   against information_schema.columns (G-R1's hint-validation requirement,
 *   still honored) but the actual embedding-input text always comes from
 *   CONTENT_EXPRESSIONS. Reason: source-table-roster.json is real,
 *   gitignored, private-estate data (see scripts/migrations/
 *   source-table-roster.example.json's own header) -- it does not exist in
 *   CI or in a fresh checkout, and every other migrate-NN-*.js script in
 *   this repo that depends on private config (db-triage.json, pipeline-db-
 *   project-map.json, ...) accepts an override path rather than hard-
 *   requiring the real file. Making migrate-07 hard-depend on the roster
 *   for its CORE embedding-input construction would make it unable to run
 *   at all in the one environment (CI, a fresh DB, no GPU) G-R13 explicitly
 *   requires it to be tested in. A table this script does NOT recognize
 *   (declared expression absent) still REQUIRES a valid roster contentCol
 *   hint or refuses loud as unclassifiable (see resolveTableContentSpec) --
 *   so the total-classification guarantee ("every embeddable table lands
 *   somewhere, unclassified is a loud FAIL") holds regardless of which
 *   source supplied the expression.
 *
 *   STALENESS GATE IS A SINGLE UNIVERSAL RULE (G-R3): re-reading the
 *   amendment's own bucket definitions, Bucket A/B/C all resolve to the
 *   IDENTICAL runtime gate `embedding IS NULL` -- Bucket A's content_hash
 *   compare branch is explicitly "retained but documented as defensively
 *   dead." The bucket label this script computes and logs per table (A =
 *   has content_hash, B = no hash + roster-hinted content, C = no hash +
 *   declared content) is therefore a REPORTING/audit classification only,
 *   never a branch in the candidate-selection SQL itself.
 *
 *   THE ALTER SUB-STEP (G-R2) runs FIRST, before table discovery, so a
 *   freshly-ALTERed memory_entries/memory_entry_chunks is correctly
 *   discovered as halfvec(4000) rather than legacy vector(1024) by the
 *   DDL-derived scan that follows it.
 *
 *   MANIFEST EXCLUSIONS (G-R7): batch selection for a table excludes rows
 *   whose project_id was recorded excluded (excluded_reason IS NOT NULL,
 *   project_id_or_null IS NOT NULL) in migration_manifest under EITHER the
 *   target table's own name (covers migrate-verify-own-graph.js's
 *   `assertions`-labeled 231-row eval-junk exclusion directly, with zero
 *   roster dependency) OR any roster source_table label that maps to this
 *   targetTable (covers a table absorbed under a distinct manifest label,
 *   e.g. migrate-05's `memory_entries_db_absorb`). NULL-scoped (whole-slice)
 *   exclusions are deliberately NOT filtered here: a NULL-scoped exclusion
 *   means the entire source slice was never migrated into the target at
 *   all (T2 expects row_count=0 target rows for that slice) -- there are no
 *   target rows to filter out.
 *
 *   PROVENANCE (G-R5) / ROLLBACK IDENTITY (G-R4) / LOCKING (G-R10) /
 *   FAILURE POSTURE (G-R8) / DIM ASSERTION (G-R9): see embedTable() and
 *   runRollback() below -- one advisory-locked, single-row transaction per
 *   embedded row (UPDATE + embedding_write_log insert together), immediate
 *   hard stop on the first provider error (never skip-and-continue, never
 *   silently fall back to a different embedder), vector length checked
 *   against the resolved provider's stored_dims before every write.
 *
 *   COMPLETENESS GATE (G-R6): runCompletenessGate() classifies every
 *   residual NULL-embedding row into exactly one of embeddable-pending
 *   (FAILS the gate) / exempt-empty-content / exempt-suppressed-AND-empty /
 *   exempt-overlength / the corpus_files structural-disposition open
 *   question (a report-level flag layered ON TOP of, never instead of, its
 *   exempt-empty-content count -- see STRUCTURAL_DISPOSITION_TABLES below).
 *
 *   OVER-LENGTH EMBED INPUT (OL-1..OL-11, 2026-08-18, mm#11(g) follow-up):
 *   the staging run hard-stopped on a 89,394-char memory_entries row --
 *   vLLM's 8192-token max_model_len rejected it. Every row's embed text is
 *   now pre-capped at EMBED_TEXT_CAP_CHARS (24,000) before the provider
 *   call, for every table generically. If a matched context-length 400
 *   (isContextLengthError -- structural: VllmHttpError, statusCode 400,
 *   parsed rawBody's error.param==='input_tokens'; NEVER a regex on
 *   `.message`) survives the cap, embedWithHalvingRetry() halves the text
 *   up to HALVING_MAX_ATTEMPTS times (floored at HALVING_FLOOR_CHARS,
 *   ~HALVING_DELAY_MS paced between attempts) before giving up and
 *   bucketing the row exempt-overlength. Every other error class (5xx,
 *   connection errors, non-length 400s, dim mismatches) keeps G-R8's
 *   immediate-hard-stop discipline completely untouched. A truncated row's
 *   final embedded length is recorded in embedding_write_log.
 *   truncated_to_chars (NULL = untruncated). evaluateCardinalityAlarm()
 *   fails the whole migration if exempt-overlength count exceeds
 *   CARDINALITY_TOTAL_MAX (20) total or CARDINALITY_TABLE_RATIO_MAX (5%) of
 *   any single table's candidates -- a total provider outage must not
 *   masquerade as a big named exemption bucket.
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHAT THIS SCRIPT DELIBERATELY DOES NOT DO
 * ══════════════════════════════════════════════════════════════════════
 *   - Never calls a live embedding endpoint from its own test suite (see
 *     test/migrations/test-migrate-07-reembed-corpus.js -- injectable
 *     transport, deterministic fixtures, no vLLM, no GPU required).
 *   - Never writes migration_manifest rows (G-R12 -- target-side only; its
 *     own lineage tables are registered sourceless via the net-new:
 *     convention in the roster, not via a manifest row).
 *   - Never re-embeds a row whose embedded_by_provider_id points at a
 *     non-default provider automatically -- flagged for owner review only
 *     (G-R5).
 *   - Never falls back to a second embedding backend on provider failure
 *     (house rule: vLLM or stop).
 *
 * Usage:
 *   node scripts/migrations/migrate-07-reembed-corpus.js [--db <target>]
 *     [--roster <path>] [--dry-run] [--rollback <run_id>]
 *
 * Exit codes: 0 = PASS, 1 = refused / precondition failure / apply failure /
 * completeness-gate failure, 2 = bad CLI usage.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Client } = require('pg');

const migrateOne = require('./migrate-01-canonical-db');               // reused by reference
const shared = require('./lib/verify15-shared');                        // reused by reference: resolveRosterPath, resolveAndClassifyTargetDb-equivalent pieces
const t9 = require('./verify-15-t9-negative');                          // reused by reference: checkExclusion (G-R11 preflight)
const embeddingProvider = require('../lib/embedding-provider');         // reused by reference
const { VllmHttpError } = require('../lib/embed');                      // reused by reference (OL-1/OL-2 matcher)

const MIGRATIONS_DIR = __dirname;
const SQL_FILE = path.join(MIGRATIONS_DIR, 'sql', 'migrate-07-ddl-addenda.sql');
const LOCK_NAMESPACE = 44; // 42/43 are taken by scripts/lib/db-seam.js (G-R10)

// ─── OVER-LENGTH EMBED INPUT HANDLING (OL-1..OL-11, 2026-08-18, mm#11(g) ──
// follow-up spec-adversary pass, live-probed against the real vLLM
// endpoint and the real row content that hard-stopped the staging run at
// memory_entries id=88, 89,394 chars). See this script's own report/gate
// section (runCompletenessGate / evaluateCardinalityAlarm) and
// embedWithHalvingRetry below for how these constants are used.

// (OL-3) Every row's constructed embed text is capped at this many chars
// BEFORE the provider call, for every table (generic, never memory_entries-
// special-cased). Live-verified 2026-08-18: the real row-88 content (89,394
// chars) embeds successfully once capped to 24,000 chars; even 33,000
// chars of dense English succeeds against this vLLM build's 8192-token
// max_model_len. The cap alone resolves every known long row in today's
// corpus -- the halving retry below is DORMANT DEFENSE for content shapes
// not present in today's corpus (denser tokenization, non-English text,
// etc.), not the primary mechanism.
const EMBED_TEXT_CAP_CHARS = 24000;

// (OL-4) Halving retry policy for a MATCHED context-length-exceeded 400
// (see isContextLengthError below) that survives the pre-cap. vLLM's error
// body reports only "at least N input tokens" -- no exact excess -- so
// proportional trimming is impossible; blind halving is the only viable
// strategy. HALVING_MAX_ATTEMPTS successive halvings, floored at
// HALVING_FLOOR_CHARS (never trimmed below this), ~HALVING_DELAY_MS between
// attempts on the SAME row -- pacing, not swallowing: the adversary pass
// observed alternating 400/ECONNRESET flakiness under unpaced back-to-back
// large POSTs against this endpoint, and pacing is the fix for that
// flakiness. This delay is NOT part of the context-length matcher; a
// simulated ECONNRESET (or any non-matched error) still hard-stops
// immediately, exactly as before this change.
const HALVING_MAX_ATTEMPTS = 4;
const HALVING_FLOOR_CHARS = 1000;
const HALVING_DELAY_MS = 300;

// (OL-7) Cardinality alarm, pinned numbers: exceeding EITHER threshold
// fails the completeness gate outright (nonzero exit), never
// passes-with-exemption -- a total provider outage must not masquerade as
// a big named "exempt-overlength" bucket. See evaluateCardinalityAlarm.
const CARDINALITY_TOTAL_MAX = 20;
const CARDINALITY_TABLE_RATIO_MAX = 0.05;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * OL-2 matcher, PINNED -- never a regex on `.message`. The context-length
 * class is exactly: a VllmHttpError, statusCode===400, and a rawBody that
 * parses as JSON with error.param === 'input_tokens'. A JSON parse failure
 * or ANY other param value is NOT this class -- it falls through to the
 * existing immediate-stop path untouched, same as a connection error, a
 * 5xx, or a dim mismatch. This is deliberately narrow: it is pinned to
 * THIS vLLM build's error-JSON shape (see this PR's blind-spot section).
 */
function isContextLengthError(err) {
  if (!(err instanceof VllmHttpError) || err.statusCode !== 400) return false;
  try {
    const parsed = JSON.parse(err.rawBody);
    return !!(parsed && parsed.error && parsed.error.param === 'input_tokens');
  } catch (_parseErr) {
    return false;
  }
}

/**
 * (OL-3/OL-4) Embed `text` (already pre-capped by the caller) against
 * `provider`, halving on a matched context-length 400 up to
 * HALVING_MAX_ATTEMPTS times, floored at HALVING_FLOOR_CHARS. Every
 * halving progressively halves the PREVIOUS attempt's text (not the
 * original each time). Any non-matched error (OL-2) propagates immediately
 * -- this function is not a general retry wrapper, only a context-length
 * one.
 *
 * @returns {Promise<{ok:true, result:object, halvings:number, finalLength:number}
 *                   |{ok:false, halvings:number}>}
 *   ok:false means the floor was exhausted and every attempt still matched
 *   the context-length class -- caller buckets this row exempt-overlength.
 */
async function embedWithHalvingRetry(provider, text, log, ctxLabel, halvingDelayMs = HALVING_DELAY_MS) {
  let attemptText = text;
  for (let halvings = 0; halvings <= HALVING_MAX_ATTEMPTS; halvings++) {
    if (halvings > 0) {
      const nextLen = Math.max(HALVING_FLOOR_CHARS, Math.floor(attemptText.length / 2));
      attemptText = attemptText.slice(0, nextLen);
      log(`  [HALVING] ${ctxLabel}: context-length 400 matched -- retry ${halvings}/${HALVING_MAX_ATTEMPTS}, new length=${attemptText.length}.`);
      await sleep(halvingDelayMs);
    }
    try {
      const result = await provider.embed(attemptText);
      return { ok: true, result, halvings, finalLength: attemptText.length };
    } catch (err) {
      if (!isContextLengthError(err)) throw err; // OL-2: not the matched class -> immediate hard stop (G-R8 untouched).
      if (halvings === HALVING_MAX_ATTEMPTS) {
        return { ok: false, halvings };
      }
      // else: matched class, floor not yet exhausted -- loop halves again.
    }
  }
  /* istanbul ignore next -- loop always returns from within the body above */
  throw new Error('embedWithHalvingRetry: unreachable');
}

/**
 * (OL-7) Cardinality alarm. Runs AFTER the embed loop, over the per-table
 * report the embed loop already produced. Exceeding either pinned
 * threshold fails the whole migration regardless of what
 * runCompletenessGate() concluded (that gate treats a SMALL
 * exempt-overlength count as a legitimate exemption bucket -- this alarm
 * is what keeps a LARGE one, e.g. a total provider outage, from silently
 * passing under that same exemption umbrella).
 */
function evaluateCardinalityAlarm(report, log) {
  let pass = true;
  const totalExemptOverlength = report.reduce((sum, r) => sum + (r.exemptOverlength || 0), 0);
  const perTable = [];
  for (const r of report) {
    const exemptOverlength = r.exemptOverlength || 0;
    const candidates = r.candidates || 0;
    const ratio = candidates > 0 ? exemptOverlength / candidates : 0;
    const tableFail = candidates > 0 && exemptOverlength > 0 && ratio > CARDINALITY_TABLE_RATIO_MAX;
    perTable.push({ table: r.table, exemptOverlength, candidates, ratio, tableFail });
    if (tableFail) {
      pass = false;
      log(`  [CARDINALITY-ALARM] ${r.table}: exempt-overlength=${exemptOverlength}/${candidates} candidate row(s) (${(ratio * 100).toFixed(1)}%) exceeds the ${(CARDINALITY_TABLE_RATIO_MAX * 100).toFixed(0)}% per-table threshold -- completeness gate FAILS.`);
    }
  }
  if (totalExemptOverlength > CARDINALITY_TOTAL_MAX) {
    pass = false;
    log(`  [CARDINALITY-ALARM] total exempt-overlength=${totalExemptOverlength} exceeds ${CARDINALITY_TOTAL_MAX} -- completeness gate FAILS.`);
  }
  if (pass && totalExemptOverlength > 0) {
    log(`  [CARDINALITY-ALARM] OK: total exempt-overlength=${totalExemptOverlength} (<= ${CARDINALITY_TOTAL_MAX} and every table <= ${(CARDINALITY_TABLE_RATIO_MAX * 100).toFixed(0)}%) -- within the accepted exemption threshold.`);
  }
  return { pass, totalExemptOverlength, perTable };
}

// Tables genuinely at legacy vector(1024) on live staging today (G-R2). Both
// carry ZERO live embedding values (live-verified) -- USING NULL never
// discards a real vector.
const LEGACY_VECTOR_TABLES = ['memory_entries', 'memory_entry_chunks'];

// TABLE-LEVEL structural-disposition candidates (G-R6). NOT an allow-list
// that exempts anything silently -- rows under these tables are still
// counted under exempt-empty-content exactly like any other table's empty
// rows; this list ONLY controls whether an additional [OPEN-QUESTION]
// report line is printed. corpus_files is the live-verified case (269/504
// empty summary -- a path/sha256 metadata index, not prose).
const STRUCTURAL_DISPOSITION_TABLES = ['corpus_files'];

// Composite/non-`id` primary keys (G-R4's row-identity encoding). Every
// other embeddable table's PK is a bare `id` SERIAL.
const PK_OVERRIDES = {
  findings: ['project_id', 'id'],
};

// Declared content expressions -- see header comment "CONTENT EXPRESSION
// RESOLUTION" for why this covers every table this script recognizes
// rather than only the amendment's literal Bucket C list. Every expression
// mirrors that table's OWN fts_vec GENERATED-column formula where one
// exists (an already-reviewed, already-shipped choice of "this table's
// content", reused for consistency rather than re-litigated) -- see
// scripts/migrations/sql/migrate-14-seam-tables.sql / migrate-04-seam-ddl-
// addenda.sql / scripts/setup.sql / scripts/sql/handoff-core-schema.sql for
// each table's own fts_vec definition.
const CONTENT_EXPRESSIONS = {
  memory_entries: "coalesce(body,'')",
  memory_entry_chunks: "coalesce(content,'')",
  policy_sections: "coalesce(content,'')",
  session_chunks: "coalesce(content,'')",
  corpus_files: "coalesce(summary,'')",
  code_index: "coalesce(description,'')",
  checklist_items: "coalesce(title,'') || ' ' || coalesce(description,'') || ' ' || coalesce(verification_step,'')",
  decisions: "coalesce(topic,'') || ' ' || coalesce(decision,'') || ' ' || coalesce(reason,'')",
  gotchas: "coalesce(issue,'') || ' ' || coalesce(rule,'')",
  findings: "coalesce(description,'') || ' ' || coalesce(impact,'') || ' ' || coalesce(remediation,'')",
  incidents: "coalesce(title,'') || ' ' || coalesce(what_happened,'') || ' ' || coalesce(what_we_did,'') || ' ' || coalesce(watch_for,'')",
  workflow_discovery: "coalesce(title,'') || ' ' || coalesce(detail,'')",
  agent_rewrites: "coalesce(agent_name,'') || ' ' || coalesce(as_is,'') || ' ' || coalesce(to_be,'') || ' ' || coalesce(gap,'')",
  research: "coalesce(title,'') || ' ' || coalesce(body,'')",
  tasks: "coalesce(title,'')",
  sessions: "coalesce(summary,'')",
  assertions: "coalesce(subject,'') || ' ' || coalesce(predicate,'') || ' ' || coalesce(object,'')",
  agent_exchange: "coalesce(body_caveman,'')",
};

// ─── CLI ARGS ─────────────────────────────────────────────────────────────

class UsageError extends Error {}

function parseArgs(argv) {
  const parsed = {
    db: null,
    rosterPath: null,
    dryRun: false,
    rollback: null,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--db') parsed.db = argv[++i];
    else if (a.startsWith('--db=')) parsed.db = a.slice('--db='.length);
    else if (a === '--roster') parsed.rosterPath = argv[++i];
    else if (a.startsWith('--roster=')) parsed.rosterPath = a.slice('--roster='.length);
    else if (a === '--dry-run') parsed.dryRun = true;
    else if (a === '--rollback') parsed.rollback = argv[++i];
    else if (a.startsWith('--rollback=')) parsed.rollback = a.slice('--rollback='.length);
    else if (a === '--help' || a === '-h') parsed.help = true;
    else throw new UsageError(`Unknown argument: ${a}`);
  }
  return parsed;
}

function printUsage() {
  console.log([
    'Usage: node scripts/migrations/migrate-07-reembed-corpus.js [--db <target>]',
    '         [--roster <path>] [--dry-run] [--rollback <run_id>]',
    '',
    '  --db <name>       Target database (else MIGRATE_TARGET_DB env, else',
    '                    memory_manager_staging). Never reads HANDOFF_DB.',
    '  --roster <path>   Path to source-table-roster.json (real roster --',
    '                    private estate data, gitignored). OPTIONAL: absent',
    '                    entirely degrades gracefully -- see this script\'s',
    '                    header comment ("CONTENT EXPRESSION RESOLUTION").',
    '  --dry-run         Classify + enumerate candidates + REPORT what the G-R2',
    '                    legacy-vector ALTER sub-step would do; performs NO',
    '                    embedding writes and NO destructive DDL (never runs',
    '                    ALTER COLUMN ... TYPE halfvec(4000) USING NULL). Still',
    '                    applies additive/idempotent DDL: the 2 lineage tables',
    '                    and embedded_by_provider_id columns (ADD COLUMN IF NOT',
    '                    EXISTS, same as every other migrate-NN-*.js script\'s',
    '                    DDL preamble -- see the script header for why this is',
    '                    a deliberately different category from the ALTER).',
    '  --rollback <id>   NULL out embedding+embedded_by_provider_id for every',
    '                    row this script wrote under run_id <id>. Scoped by',
    '                    embedding_write_log; never touches another run\'s rows.',
    '                    Never runs the G-R2 ALTER sub-step. Never probes/',
    '                    resolves a provider -- zero provider I/O (cm#202).',
    '',
    'PREFLIGHT PROBE (cm#202): MIGRATE and DRY-RUN both resolve the default',
    'embedding_providers row and issue ONE probe embed call against it before',
    'any classification/DDL/write work starts -- a wire-config mismatch',
    '(wrong port, wrong served-model id, unreachable host) fails loud in',
    'seconds, naming the resolved endpoint/model, instead of surfacing on the',
    'first real row after setup has already run. --rollback never probes.',
  ].join('\n'));
}

// ─── SMALL SCHEMA-INTROSPECTION HELPERS ────────────────────────────────────

async function hasColumn(client, table, col) {
  const { rows } = await client.query(
    `SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = $1 AND column_name = $2`,
    [table, col]
  );
  return rows.length > 0;
}

async function getFormatType(client, table, col) {
  const { rows } = await client.query(
    `SELECT format_type(a.atttypid, a.atttypmod) AS t
       FROM pg_attribute a
       JOIN pg_class c ON a.attrelid = c.oid
       JOIN pg_namespace n ON c.relnamespace = n.oid
      WHERE n.nspname = current_schema() AND c.relname = $1 AND a.attname = $2
        AND a.attnum > 0 AND NOT a.attisdropped`,
    [table, col]
  );
  return rows.length ? rows[0].t : null;
}

/**
 * DDL-derived embeddable-table enumeration (G-R1). Never a hand-listed
 * table array -- a pg_attribute/pg_type/pg_class scan for every base table
 * carrying a vector/halfvec column. A table with MORE than one such column
 * is a shape this script was never written for and refuses loud rather
 * than silently picking one (total classification, never a silent choice).
 */
async function discoverEmbeddableTables(client) {
  const { rows } = await client.query(`
    SELECT c.relname AS table_name, a.attname AS column_name, format_type(a.atttypid, a.atttypmod) AS coltype
      FROM pg_attribute a
      JOIN pg_class c ON a.attrelid = c.oid
      JOIN pg_namespace n ON c.relnamespace = n.oid
      JOIN pg_type t ON a.atttypid = t.oid
     WHERE n.nspname = current_schema()
       AND c.relkind = 'r'
       AND a.attnum > 0 AND NOT a.attisdropped
       AND t.typname IN ('vector', 'halfvec')
     ORDER BY c.relname, a.attname
  `);
  const byTable = new Map();
  for (const r of rows) {
    if (!byTable.has(r.table_name)) byTable.set(r.table_name, []);
    byTable.get(r.table_name).push(r);
  }
  const tables = [];
  const multiColumn = [];
  for (const [table, cols] of byTable) {
    if (cols.length > 1) { multiColumn.push({ table, cols: cols.map((c) => c.column_name) }); continue; }
    tables.push({ table, embeddingCol: cols[0].column_name, coltype: cols[0].coltype });
  }
  if (multiColumn.length > 0) {
    throw new Error(`discoverEmbeddableTables: table(s) with more than one vector/halfvec column -- this script assumes exactly one embedding column per table, never silently picks one: ${JSON.stringify(multiColumn)}`);
  }
  return tables;
}

async function ensureProvenanceColumn(client, table, log) {
  await client.query(`ALTER TABLE "${table}" ADD COLUMN IF NOT EXISTS embedded_by_provider_id INTEGER REFERENCES embedding_providers(id)`);
  log(`  [DDL] ${table}.embedded_by_provider_id ensured (idempotent).`);
}

// ─── ROSTER (soft-loaded -- see header comment) ────────────────────────────

function tryLoadRoster(rosterPathArg, log) {
  const rosterPath = rosterPathArg || shared.resolveRosterPath();
  if (!fs.existsSync(rosterPath)) {
    log(`  [ROSTER] no roster file at "${rosterPath}" -- content-expression resolution is fully self-contained via this script's own CONTENT_EXPRESSIONS for every table it recognizes; manifest-exclusion scoping (G-R7) still checks the target table's own name directly. This is the expected/supported CI posture (roster is gitignored, private estate data).`);
    return [];
  }
  const raw = fs.readFileSync(rosterPath, 'utf8');
  const roster = JSON.parse(raw);
  if (!Array.isArray(roster)) throw new Error(`roster at "${rosterPath}" must be a JSON array`);
  log(`  [ROSTER] loaded ${roster.length} entries from "${rosterPath}".`);
  return roster;
}

/**
 * Resolve + validate this table's content expression (G-R1). Declared
 * expression wins when present (see header comment); otherwise a roster
 * contentCol hint, validated against information_schema.columns, is used;
 * otherwise this table is UNCLASSIFIABLE and this function throws loud.
 * Every roster hint found for this table is validated regardless of
 * whether it ends up being used (a bad hint on a table this script already
 * has a declared expression for is STILL a bad roster row worth a loud
 * FATAL, not a silently-ignored one).
 */
async function resolveTableContentSpec(client, table, roster, log) {
  const rosterEntries = roster.filter((e) => e.targetTable === table && e.contentCol);
  for (const entry of rosterEntries) {
    const exists = await hasColumn(client, table, entry.contentCol);
    if (!exists) {
      throw new Error(
        `FATAL roster contentCol hint: source_db="${entry.source_db}" source_table="${entry.source_table}" ` +
        `targetTable="${table}" contentCol="${entry.contentCol}" -- column does not exist on "${table}". Fix the roster row.`
      );
    }
  }
  const declared = CONTENT_EXPRESSIONS[table];
  if (declared) {
    return { expr: declared, source: 'declared' };
  }
  if (rosterEntries.length > 0) {
    const hinted = rosterEntries[0];
    log(`  [CLASSIFY] ${table}: no declared CONTENT_EXPRESSIONS entry -- using validated roster contentCol="${hinted.contentCol}".`);
    return { expr: `coalesce(${hinted.contentCol},'')`, source: 'roster', contentCol: hinted.contentCol };
  }
  throw new Error(
    `UNCLASSIFIABLE: table "${table}" has an embedding column but no declared CONTENT_EXPRESSIONS entry and no ` +
    `roster contentCol hint -- refusing (total classification: every embeddable table must resolve to exactly one ` +
    `content source; unclassified is a loud FAIL, never a silent skip).`
  );
}

/**
 * Every roster source_table label that maps to this targetTable, PLUS the
 * target table's own name (covers manifest rows written under the bare
 * target-table name directly, e.g. migrate-verify-own-graph.js's
 * assertions-labeled eval-junk exclusion -- works with ZERO roster
 * dependency). Used by getManifestExcludedProjectIds (G-R7).
 */
function manifestLabelsForTable(roster, table) {
  const labels = new Set([table]);
  for (const entry of roster) {
    if (entry.targetTable === table) labels.add(entry.source_table);
  }
  return [...labels];
}

async function getManifestExcludedProjectIds(client, roster, table) {
  const labels = manifestLabelsForTable(roster, table);
  // cm#197 (2026-08-18): retired_at IS NULL -- a RETIRED manifest row (a
  // leaked test-fixture artifact, cured via
  // cure-migration-manifest-retirement.js rather than excluded_reason,
  // precisely so a leaked row for a target/project bucket that also
  // carries hundreds of LEGITIMATE live rows never poisons this
  // embedding-exclusion set) must never be treated as a real exclusion here
  // -- excluding a live project's real rows from re-embedding because a
  // disposed-of bookkeeping row happened to name the same project_id would
  // be exactly the collision retirement (over excluded_reason) exists to
  // avoid.
  const { rows } = await client.query(
    `SELECT DISTINCT project_id_or_null FROM migration_manifest
      WHERE source_table = ANY($1::text[]) AND excluded_reason IS NOT NULL AND project_id_or_null IS NOT NULL AND retired_at IS NULL`,
    [labels]
  );
  return new Set(rows.map((r) => r.project_id_or_null));
}

// ─── PK IDENTITY ENCODING (G-R4) ───────────────────────────────────────────

function getPkSpec(table) {
  return { cols: PK_OVERRIDES[table] || ['id'] };
}

function encodePk(pkSpec, row) {
  return {
    colStr: pkSpec.cols.join(','),
    valStr: JSON.stringify(pkSpec.cols.map((c) => row[c])),
  };
}

function decodePk(colStr, valStr) {
  const cols = colStr.split(',');
  const vals = JSON.parse(valStr);
  return cols.map((c, i) => ({ col: c, val: vals[i] }));
}

function pkWhereClause(cols, offset) {
  return cols.map((c, i) => `"${c}"=$${offset + i + 1}`).join(' AND ');
}

// ─── G-R11 PREFLIGHT (reuses verify-15-t9-negative.checkExclusion by reference) ─

async function runPreflight(client, roster, log) {
  // cm#197: retired_at IS NULL -- a retired (cured) exclusion-recording row
  // is disposed-of bookkeeping and must never be re-verified here forever.
  const { rows: exclusions } = await client.query(
    `SELECT DISTINCT source_db, excluded_reason, source_table, project_id_or_null FROM migration_manifest WHERE excluded_reason IS NOT NULL AND retired_at IS NULL`
  );
  if (exclusions.length === 0) {
    log('  [PREFLIGHT] OK: zero excluded_reason slices present in migration_manifest -- nothing to verify (T9-equivalent trivial pass).');
    return { ok: true, checked: 0 };
  }
  let failed = false;
  for (const exclusion of exclusions) {
    const label = `source_db="${exclusion.source_db}" / ${exclusion.source_table} / project_id_or_null=${exclusion.project_id_or_null ?? '(NULL-scoped)'} / excluded_reason="${exclusion.excluded_reason}"`;
    const result = await t9.checkExclusion(client, roster, exclusion, exclusion.source_db);
    if (!result.ok) {
      failed = true;
      const reason = result.reason || (result.liveCount > 0
        ? `excluded but ${result.liveCount} row(s) present in ${result.targetTable}`
        : result.provenanceDetail);
      log(`  [PREFLIGHT] FAIL: ${label}: ${reason}`);
    } else {
      log(`  [PREFLIGHT] OK: ${label}`);
    }
  }
  return { ok: !failed, checked: exclusions.length };
}

// ─── G-R2: ALTER SUB-STEP (legacy vector(1024) -> halfvec(4000)) ──────────

/**
 * pg_depend: which views (if any) depend SPECIFICALLY on this column (not
 * merely on the table)? Live-verified: only v_memory_hits, only on
 * memory_entry_chunks.embedding. Read-only -- safe to call with or without
 * an open transaction/lock.
 */
async function getDependentViews(client, table) {
  const { rows } = await client.query(
    `SELECT DISTINCT dv.relname AS view_name
       FROM pg_depend d
       JOIN pg_rewrite r ON d.objid = r.oid
       JOIN pg_class dv ON r.ev_class = dv.oid
       JOIN pg_attribute a ON a.attrelid = d.refobjid AND a.attnum = d.refobjsubid
       JOIN pg_class tc ON tc.oid = d.refobjid
      WHERE tc.relname = $1 AND a.attname = 'embedding' AND dv.relkind = 'v'`,
    [table]
  );
  return rows.map((r) => r.view_name);
}

/** The wrong-opclass (vector_cosine_ops, non-partial) legacy HNSW index names on `table`. Read-only. */
async function getLegacyIndexes(client, table) {
  const { rows } = await client.query(
    `SELECT indexname FROM pg_indexes WHERE schemaname = current_schema() AND tablename = $1
       AND indexdef ILIKE '%vector_cosine_ops%' AND indexdef NOT ILIKE '%WHERE%'`,
    [table]
  );
  return rows.map((r) => r.indexname);
}

/**
 * FIELD-FOUND FIX (independent review, PR #195, 2026-08-18): this function
 * used to run its destructive `ALTER COLUMN ... USING NULL` unconditionally,
 * trusting an out-of-band, comment-only fact ("both in-scope tables carry
 * zero live embedding values on staging today") rather than checking it at
 * run time, and with no `dryRun` awareness at all -- `--dry-run` therefore
 * discarded any populated column's values and then reported "no writes
 * performed" (reproduced live by the reviewer). First fix round added a
 * runtime guard + dry-run reporting, but the guard's `SELECT COUNT(*)` ran
 * BEFORE `BEGIN` -- a second, self-found gap: a concurrent writer could
 * insert/update a non-NULL embedding in the window between the guard
 * passing and the `ALTER` acquiring its lock, and that row would be
 * silently discarded anyway (TOCTOU race).
 *
 * SECOND FIX ROUND (categorical, closes the TOCTOU window entirely): the
 * guard and the ALTER now run inside ONE transaction, in this exact order:
 *   BEGIN;
 *   LOCK TABLE <t> IN ACCESS EXCLUSIVE MODE;   -- blocks every concurrent
 *                                                  writer AND reader for the
 *                                                  rest of this transaction
 *   SELECT COUNT(*) WHERE embedding IS NOT NULL; -- nonzero -> ROLLBACK + throw
 *   <DROP VIEW / DROP INDEX / ALTER / CREATE INDEX / CREATE VIEW>;
 *   COMMIT;
 * Because the ACCESS EXCLUSIVE lock is held continuously from immediately
 * before the count through the ALTER and the COMMIT, nothing can write a
 * new non-NULL embedding into the window the count and the ALTER used to
 * leave open -- the check and the use are now the same atomic unit.
 * `dryRun` mode NEVER takes this lock and NEVER opens this transaction (it
 * is a plain read-only report, exactly as before) -- see the `dryRun`
 * branch below, which runs entirely outside of any BEGIN/LOCK.
 */
async function runAlterLegacyVectorColumn(client, table, log, dryRun = false) {
  const coltype = await getFormatType(client, table, 'embedding');
  if (coltype === null) {
    log(`  [ALTER-SKIP] ${table}.embedding does not exist (pgvector likely not installed on this target) -- skipping.`);
    return { applied: false, reason: 'column-absent' };
  }
  if (coltype === 'halfvec(4000)') {
    log(`  [ALTER-SKIP] ${table}.embedding is already halfvec(4000) -- idempotent no-op.`);
    return { applied: false, reason: 'already-halfvec' };
  }
  if (!coltype.startsWith('vector')) {
    log(`  [ALTER-SKIP] ${table}.embedding has unexpected type "${coltype}" (neither vector(...) nor halfvec(4000)) -- refusing to touch a shape this migration was not written for.`);
    return { applied: false, reason: 'unexpected-type' };
  }

  if (dryRun) {
    // Report-only: deliberately NO lock, NO transaction. A dry run must
    // never hold a lock against a real target -- these are plain,
    // independent, autocommitted reads.
    const { rows: populatedRows } = await client.query(`SELECT COUNT(*) AS n FROM "${table}" WHERE embedding IS NOT NULL`);
    const populatedCount = Number(populatedRows[0].n);
    const dependentViews = await getDependentViews(client, table);
    const legacyIndexes = await getLegacyIndexes(client, table);
    log(
      `  [DRY-RUN][ALTER] ${table}.embedding: current=${coltype} target=halfvec(4000) populated_rows=${populatedCount} ` +
      `dependent_views=${JSON.stringify(dependentViews)} legacy_indexes=${JSON.stringify(legacyIndexes)} -- REPORT ONLY, no DDL performed, no lock taken.`
    );
    if (populatedCount > 0) {
      log(`  [DRY-RUN][ALTER] REFUSAL-WOULD-FIRE: ${table}.embedding has ${populatedCount} populated row(s) -- a real (non-dry-run) invocation would refuse rather than discard them.`);
    }
    return { applied: false, reason: 'dry-run', dryRun: true, populatedCount, dependentViews, legacyIndexes };
  }

  await client.query('BEGIN');
  try {
    // ACCESS EXCLUSIVE, taken FIRST, before the guard count -- closes the
    // TOCTOU window: no concurrent transaction can insert/update this
    // table's rows (or even read them under certain isolation levels, but
    // that is incidental here -- the write-exclusion is what matters) from
    // this point until COMMIT/ROLLBACK.
    await client.query(`LOCK TABLE "${table}" IN ACCESS EXCLUSIVE MODE`);

    const { rows: populatedRows } = await client.query(`SELECT COUNT(*) AS n FROM "${table}" WHERE embedding IS NOT NULL`);
    const populatedCount = Number(populatedRows[0].n);
    if (populatedCount > 0) {
      throw new Error(
        `G-R2 SAFETY GUARD: refusing to ALTER "${table}".embedding from ${coltype} to halfvec(4000) -- ${populatedCount} row(s) ` +
        `currently have a non-NULL embedding. "USING NULL" would discard them irrecoverably (no lineage table records a legacy-vector ` +
        `value -- rollback has no path back). Nothing was altered. If these rows are genuinely safe to clear (e.g. a deliberate ` +
        `re-embed), NULL them out explicitly first and re-run.`
      );
    }

    const dependentViews = await getDependentViews(client, table);
    const legacyIndexes = await getLegacyIndexes(client, table);

    const viewDefs = [];
    for (const viewName of dependentViews) {
      const { rows: defRows } = await client.query(`SELECT pg_get_viewdef($1::regclass, true) AS def`, [viewName]);
      // FIELD-FOUND FIX (independent review, PR #195, non-blocking item (c)):
      // pg_get_viewdef captures the view's SELECT body only, never its
      // COMMENT ON VIEW -- a plain DROP VIEW/CREATE VIEW round-trip silently
      // lost any comment. Captured here (obj_description over pg_class,
      // NULL when no comment exists) and re-applied after recreation below.
      const { rows: commentRows } = await client.query(`SELECT obj_description($1::regclass, 'pg_class') AS c`, [viewName]);
      viewDefs.push({ viewName, def: defRows[0].def, comment: commentRows[0] ? commentRows[0].c : null });
      await client.query(`DROP VIEW "${viewName}"`);
      log(`  [ALTER] dropped view "${viewName}" (depends on ${table}.embedding) -- captured its live pg_get_viewdef + comment for recreation.`);
    }

    for (const indexname of legacyIndexes) {
      await client.query(`DROP INDEX "${indexname}"`);
      log(`  [ALTER] dropped legacy index "${indexname}" (vector_cosine_ops, non-partial) on ${table}.embedding.`);
    }

    // USING NULL, NEVER a cast -- dims differ (1024 vs 4000). Safe here
    // because the guard above (inside THIS SAME transaction, under the
    // ACCESS EXCLUSIVE lock taken before the count) already refused loud on
    // any populated row; by construction, every row's embedding is already
    // NULL and cannot have changed since the count.
    await client.query(`ALTER TABLE "${table}" ALTER COLUMN embedding TYPE halfvec(4000) USING NULL`);
    log(`  [ALTER] ${table}.embedding TYPE ${coltype} -> halfvec(4000) (USING NULL; guard confirmed 0 populated rows under an ACCESS EXCLUSIVE lock held continuously since).`);

    const newIndexName = `${table}_embedding_hnsw_idx`;
    await client.query(
      `CREATE INDEX IF NOT EXISTS "${newIndexName}" ON "${table}" USING hnsw (embedding halfvec_cosine_ops) WITH (m='16', ef_construction='64') WHERE embedding IS NOT NULL`
    );
    log(`  [ALTER] created "${newIndexName}" USING hnsw (embedding halfvec_cosine_ops) WHERE embedding IS NOT NULL.`);

    for (const { viewName, def, comment } of viewDefs) {
      await client.query(`CREATE VIEW "${viewName}" AS ${def}`);
      log(`  [ALTER] recreated view "${viewName}" from its captured pg_get_viewdef.`);
      if (comment) {
        // FIELD-FOUND FIX (independent re-review, PR #195, 2026-08-18):
        // `COMMENT ON VIEW ... IS $1` is a syntax error -- PostgreSQL does
        // not accept bind parameters in utility statements (only in
        // plannable DML: SELECT/INSERT/UPDATE/DELETE). This unconditionally
        // failed on any target whose dependent view actually carries a
        // comment -- which the real target (scripts/sql/v_memory_hits.sql)
        // does, aborting the whole G-R2 transaction every time. Fixed by
        // interpolating a SAFELY ESCAPED SQL literal via the pg Client's
        // own `escapeLiteral` (doubles embedded single quotes, wraps in
        // single quotes; a raw newline inside the resulting literal is
        // valid SQL and requires no extra handling) -- NEVER a bind
        // parameter in a utility statement, and NEVER raw, unescaped string
        // concatenation of comment content.
        await client.query(`COMMENT ON VIEW "${viewName}" IS ${client.escapeLiteral(comment)}`);
        log(`  [ALTER] restored COMMENT ON VIEW "${viewName}".`);
      }
    }

    await client.query('COMMIT');
    return { applied: true, populatedCount: 0 };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  }
}

// ─── EMBED LOOP (G-R3/G-R4/G-R5/G-R7/G-R8/G-R9/G-R10) ──────────────────────

async function embedTable(client, table, spec, provider, providerId, runId, excludedProjectIds, log, dryRun, halvingDelayMs = HALVING_DELAY_MS) {
  const pkSpec = getPkSpec(table);
  const selectColsList = [...new Set([...pkSpec.cols, 'project_id'])];
  const selectCols = selectColsList.map((c) => `"${c}"`).join(', ');
  // FIELD-FOUND FIX (independent review, PR #195, non-blocking item (b)):
  // emptiness used to be checked with JavaScript's String.prototype.trim()
  // here but with SQL trim() in runCompletenessGate() -- JS trim() also
  // strips tabs/newlines/other Unicode whitespace that SQL trim() does not,
  // so newline-only content was skipped as empty by this loop but counted
  // as embeddable-pending by the gate: a real run could wedge forever (the
  // gate fails on a row this loop will never touch). Unified onto ONE
  // definition -- SQL `length(trim(coalesce(expr,''))) > 0`, computed once
  // in the SELECT itself (__has_content) -- so both call sites agree by
  // construction, not by convention.
  let sql = `SELECT ${selectCols}, (${spec.expr}) AS __content_text, ` +
    `length(trim(coalesce((${spec.expr}), ''))) > 0 AS __has_content ` +
    `FROM "${table}" WHERE embedding IS NULL`;
  const params = [];
  if (excludedProjectIds.size > 0) {
    params.push([...excludedProjectIds]);
    sql += ` AND (project_id IS NULL OR project_id <> ALL($${params.length}::text[]))`;
  }
  sql += ` ORDER BY ${pkSpec.cols.map((c) => `"${c}"`).join(', ')}`;
  const { rows } = await client.query(sql, params);

  const counts = { candidates: rows.length, embedded: 0, exemptEmptyContent: 0, exemptOverlength: 0 };
  const truncatedRows = [];       // (OL-6) {table, pk, originalLength, finalLength, halvings}
  const exemptOverlengthRows = []; // (OL-6) {table, pk, originalLength, halvings}

  if (dryRun) {
    for (const row of rows) {
      if (!row.__has_content) { counts.exemptEmptyContent++; continue; }
      log(`  [DRY-RUN] would embed ${table} pk=${encodePk(pkSpec, row).valStr}`);
    }
    return { ...counts, truncatedRows, exemptOverlengthRows };
  }

  const storedDims = provider.storedDims();
  let batchId = null;

  for (const row of rows) {
    if (!row.__has_content) {
      counts.exemptEmptyContent++;
      log(`  [EXEMPT-EMPTY-CONTENT] ${table} pk=${encodePk(pkSpec, row).valStr}: declared content expression trims to '' -- never embedded.`);
      continue;
    }
    // __has_content (SQL trim(), matching the gate) already proved this is
    // non-empty; JS .trim() here is pure value normalization for the text
    // handed to the provider, never the emptiness decision.
    const originalText = (row.__content_text || '').trim();
    // (OL-3) Pre-cap BEFORE the provider call, every table, generic.
    const cappedText = originalText.length > EMBED_TEXT_CAP_CHARS
      ? originalText.slice(0, EMBED_TEXT_CAP_CHARS)
      : originalText;
    const wasPreCapped = cappedText.length < originalText.length;

    if (batchId === null) {
      // NON-BLOCKING (independent review, PR #195, item (d)): this INSERT is
      // deliberately OUTSIDE the per-row transaction below -- G-R4 only
      // requires the row UPDATE + embedding_write_log insert to share a
      // transaction, not the batch row itself. Consequence, documented
      // rather than engineered around: if the very first candidate row's
      // embed attempt fails (provider error, dim mismatch), this batch row
      // is left with zero corresponding write_log rows. This is HARMLESS --
      // runRollback() keys exclusively on embedding_write_log via batch_id,
      // never on embedding_migration_batches row COUNT or presence alone --
      // but it does mean a batch row is not a reliable proxy for "this
      // table had work attempted"; only its child write_log rows are.
      const { rows: br } = await client.query(
        `INSERT INTO embedding_migration_batches (table_name, run_id) VALUES ($1,$2) RETURNING id`,
        [table, runId]
      );
      batchId = br[0].id;
    }

    const pkVals = pkSpec.cols.map((c) => row[c]);

    await client.query('BEGIN');
    try {
      // G-R10: per single-row transaction advisory lock, namespace 44.
      await client.query(`SELECT pg_advisory_xact_lock(hashtext($1), $2)`, [`migrate-07:${table}`, LOCK_NAMESPACE]);

      // Race guard: re-check under the lock before spending a provider call.
      const { rows: recheck } = await client.query(
        `SELECT embedding FROM "${table}" WHERE ${pkWhereClause(pkSpec.cols, 0)}`,
        pkVals
      );
      if (recheck.length === 0 || recheck[0].embedding !== null) {
        await client.query('ROLLBACK');
        continue;
      }

      const pkLabelForLog = encodePk(pkSpec, row).valStr;

      // G-R8 / OL-2: first NON-context-length provider error is an
      // immediate hard stop -- never caught-and-continued here; propagates
      // out of this function. A matched context-length 400 (OL-2) is
      // handled INSIDE embedWithHalvingRetry via the halving policy
      // (OL-4) and does NOT itself hard-stop unless the halving floor is
      // exhausted, in which case this row is bucketed exempt-overlength
      // (OL-4) rather than thrown.
      const halvingResult = await embedWithHalvingRetry(
        provider, cappedText, log, `${table} pk=${pkLabelForLog}`, halvingDelayMs
      );

      if (!halvingResult.ok) {
        // (OL-4) Floor exhausted, still context-length-exceeded -- bucket
        // exempt-overlength. Never a hard stop, never silently dropped:
        // rolled back (no writes for this row) and counted/listed (OL-6),
        // subject to the cardinality alarm (OL-7).
        await client.query('ROLLBACK');
        counts.exemptOverlength++;
        exemptOverlengthRows.push({
          table, pk: pkLabelForLog, originalLength: originalText.length, halvings: halvingResult.halvings,
        });
        log(`  [EXEMPT-OVERLENGTH] ${table} pk=${pkLabelForLog}: original_length=${originalText.length} halvings=${halvingResult.halvings} -- halving floor (${HALVING_FLOOR_CHARS} chars) exhausted, still context-length-exceeded. Never embedded.`);
        continue;
      }

      const result = halvingResult.result;

      // G-R9: dim assertion before every write.
      if (!Array.isArray(result.vector) || result.vector.length !== storedDims) {
        throw new Error(
          `DIM-MISMATCH: table="${table}" pk=${JSON.stringify(pkVals)} provider returned ` +
          `${result.vector ? result.vector.length : 'no'} dims, expected storedDims=${storedDims}.`
        );
      }

      // (OL-5/OL-6) truncated_to_chars is set when EITHER the pre-cap
      // alone shortened the text OR a halving retry was needed (or both --
      // halvings always implies pre-cap already fired, since halving only
      // ever operates on the already-capped text). NULL means untouched.
      const truncated = wasPreCapped || halvingResult.halvings > 0;
      const truncatedToChars = truncated ? halvingResult.finalLength : null;

      const vectorLiteral = JSON.stringify(result.vector);
      await client.query(
        `UPDATE "${table}" SET embedding=$1::halfvec, embedded_by_provider_id=$2 WHERE ${pkWhereClause(pkSpec.cols, 2)}`,
        [vectorLiteral, providerId, ...pkVals]
      );
      const { colStr, valStr } = encodePk(pkSpec, row);
      await client.query(
        `INSERT INTO embedding_write_log (batch_id, table_name, row_pk_col, row_pk_value, truncated_to_chars) VALUES ($1,$2,$3,$4,$5)`,
        [batchId, table, colStr, valStr, truncatedToChars]
      );
      await client.query('COMMIT');
      counts.embedded++;
      if (truncated) {
        truncatedRows.push({
          table, pk: pkLabelForLog, originalLength: originalText.length,
          finalLength: truncatedToChars, halvings: halvingResult.halvings,
        });
        log(`  [EMBEDDED-TRUNCATED] ${table} pk=${pkLabelForLog}: original_length=${originalText.length} final_length=${truncatedToChars} halvings=${halvingResult.halvings} (${halvingResult.halvings === 0 ? 'pre-cap-only' : 'halving-triggered'}).`);
      }
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err; // G-R8: hard stop, no skip-and-continue, no fallback embedder.
    }
  }
  return { ...counts, truncatedRows, exemptOverlengthRows };
}

// ─── G-R5 PROVENANCE VERIFICATION ──────────────────────────────────────────

async function runProvenanceVerification(client, tables, log) {
  let ok = true;
  for (const table of tables) {
    const { rows: gapRows } = await client.query(
      `SELECT COUNT(*) AS n FROM "${table}" WHERE embedding IS NOT NULL AND embedded_by_provider_id IS NULL`
    );
    const gap = Number(gapRows[0].n);
    if (gap > 0) {
      ok = false;
      log(`  [PROVENANCE-FAIL] ${table}: ${gap} row(s) have embedding IS NOT NULL but embedded_by_provider_id IS NULL.`);
    }
    // cm#201 §7: the INVERSE direction, so the sharpened invariant is
    // CHECKED, not assumed. A row with embedding IS NULL but
    // embedded_by_provider_id IS NOT NULL is exactly the shape a writer
    // that assigns embedding=NULL without ALSO NULLing
    // embedded_by_provider_id in the same statement would leave behind
    // (e.g. a legacy re-embed-trigger UPDATE that only nulls the vector) --
    // a stale, misleading "this was embedded by provider X" claim on a row
    // that currently has no embedding at all.
    const { rows: inverseGapRows } = await client.query(
      `SELECT COUNT(*) AS n FROM "${table}" WHERE embedding IS NULL AND embedded_by_provider_id IS NOT NULL`
    );
    const inverseGap = Number(inverseGapRows[0].n);
    if (inverseGap > 0) {
      ok = false;
      log(`  [PROVENANCE-FAIL] ${table}: ${inverseGap} row(s) have embedding IS NULL but embedded_by_provider_id IS NOT NULL (stale provenance on an unembedded row).`);
    }
    const { rows: nonDefaultRows } = await client.query(
      `SELECT COUNT(*) AS n FROM "${table}" t JOIN embedding_providers p ON p.id = t.embedded_by_provider_id WHERE p.is_default = false`
    );
    const nd = Number(nonDefaultRows[0].n);
    if (nd > 0) {
      log(`  [PROVENANCE-FLAG] ${table}: ${nd} row(s) were embedded by a non-default provider -- flagged for owner review, never auto-re-embedded.`);
    }
  }
  return ok;
}

// ─── G-R6 COMPLETENESS GATE ─────────────────────────────────────────────────

async function runCompletenessGate(client, tableSpecs, log) {
  let pass = true;
  const report = [];
  for (const { table, spec, hasSuppressed, exemptOverlength } of tableSpecs) {
    const suppressedExpr = hasSuppressed ? '"suppressed"' : 'false';
    const { rows } = await client.query(
      `SELECT
         COUNT(*) FILTER (WHERE length(trim(coalesce((${spec.expr}), ''))) > 0) AS pending,
         COUNT(*) FILTER (WHERE length(trim(coalesce((${spec.expr}), ''))) = 0 AND NOT (${suppressedExpr})) AS exempt_empty,
         COUNT(*) FILTER (WHERE length(trim(coalesce((${spec.expr}), ''))) = 0 AND (${suppressedExpr})) AS exempt_suppressed_empty
       FROM "${table}" WHERE embedding IS NULL`
    );
    const r = rows[0];
    // (OL-3/OL-4/OL-6) exempt-overlength rows are, by construction, a
    // subset of the raw SQL "pending" count above: they have non-empty
    // content (they passed __has_content in the embed loop) and their
    // embedding is still NULL (the halving floor exhausted before any
    // write happened). Subtracting the KNOWN exempt-overlength count
    // (computed by embedTable() during THIS SAME run, never re-derived
    // from an SQL heuristic) reclassifies exactly those rows out of
    // "pending" and into their own bucket -- never a silent drop, always
    // still subject to the cardinality alarm (OL-7) below in main().
    // `exemptOverlength` defaults to 0 for direct callers (e.g. this
    // suite's GATE-1/2/3 tests) that never ran the embed loop at all.
    const exemptOverlengthCount = exemptOverlength || 0;
    const rawPending = Number(r.pending);
    const pending = Math.max(0, rawPending - exemptOverlengthCount);
    const exemptEmpty = Number(r.exempt_empty);
    const exemptSuppressedEmpty = Number(r.exempt_suppressed_empty);
    if (pending > 0) pass = false;
    report.push({ table, pending, exemptEmpty, exemptSuppressedEmpty, exemptOverlength: exemptOverlengthCount });
    log(`  [COMPLETENESS] ${table}: embeddable-pending=${pending} exempt-empty-content=${exemptEmpty} exempt-suppressed-and-empty=${exemptSuppressedEmpty} exempt-overlength=${exemptOverlengthCount}${pending > 0 ? ' [FAIL]' : ''}`);
    if (STRUCTURAL_DISPOSITION_TABLES.includes(table) && exemptEmpty > 0) {
      log(`  [OPEN-QUESTION] ${table}: ${exemptEmpty} row(s) have structurally empty declared content -- whether this table belongs in the embeddable set at all (vs. a richer content expression, vs. exempt-structurally-non-content-bearing) is an OWNER decision, not auto-resolved here. See PR body.`);
    }
  }
  return { pass, report };
}

// ─── G-R4 ROLLBACK ───────────────────────────────────────────────────────

async function runRollback(client, runId, log) {
  const { rows: batches } = await client.query(
    `SELECT id, table_name FROM embedding_migration_batches WHERE run_id = $1`,
    [runId]
  );
  if (batches.length === 0) {
    log(`  [ROLLBACK] no embedding_migration_batches rows for run_id="${runId}" -- nothing to roll back.`);
    return { rolledBack: 0 };
  }
  let rolledBack = 0;
  for (const batch of batches) {
    const { rows: logRows } = await client.query(
      `SELECT row_pk_col, row_pk_value FROM embedding_write_log WHERE batch_id = $1`,
      [batch.id]
    );
    for (const { row_pk_col: rowPkCol, row_pk_value: rowPkValue } of logRows) {
      const pk = decodePk(rowPkCol, rowPkValue);
      const where = pk.map((p, i) => `"${p.col}"=$${i + 1}`).join(' AND ');
      const vals = pk.map((p) => p.val);
      await client.query(`UPDATE "${batch.table_name}" SET embedding=NULL, embedded_by_provider_id=NULL WHERE ${where}`, vals);
      rolledBack++;
    }
    log(`  [ROLLBACK] ${batch.table_name} (batch_id=${batch.id}): NULLed ${logRows.length} row(s).`);
  }
  return { rolledBack };
}

// ─── MAIN ───────────────────────────────────────────────────────────────────

async function main(runtimeOpts = {}) {
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

  const { name: target, source: targetSource } = migrateOne.resolveTargetDb({ db: parsed.db });
  if (!migrateOne.DB_NAME_RE.test(target)) {
    console.error(`Invalid database name "${target}" (from ${targetSource}) — must match /^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/.`);
    return false;
  }
  const classification = await migrateOne.classifyTarget({ dbName: target });
  if (!classification.allowed) {
    console.error(`Refused: ${classification.reason}`);
    console.error(`(resolved from ${targetSource} — no database connection was opened.)`);
    return false;
  }

  console.log(`migrate-07-reembed-corpus: target="${target}" (resolved from ${targetSource}) mode=${parsed.rollback ? 'ROLLBACK' : parsed.dryRun ? 'DRY-RUN' : 'MIGRATE'}`);

  const client = new Client(migrateOne.pgConfig(target));
  await client.connect();

  try {
    // ── cm#202 S-B.4: provider resolution + preflight probe move to
    // IMMEDIATELY after target classification/connect and BEFORE
    // applySqlFile/preflight/discovery/the G-R2 ALTER (previously this
    // resolved ~line 1135, after all of that setup work had already run --
    // the whole point of the probe is failing loud in seconds, not after
    // setup). Mode classification (total, S-B.3):
    //   MIGRATE   -> probe
    //   DRY-RUN   -> probe (probe failure fails the dry run loudly)
    //   ROLLBACK  -> NO probe (rollback does zero provider I/O and must not
    //                require a live endpoint) -- provider is never even
    //                resolved in this mode, since rollback's own UPDATE
    //                only NULLs embedding/embedded_by_provider_id and needs
    //                no provider object at all.
    const mode = parsed.rollback ? 'ROLLBACK' : (parsed.dryRun ? 'DRY-RUN' : 'MIGRATE');
    let providerRow = null;
    let provider = null;
    if (mode !== 'ROLLBACK') {
      providerRow = runtimeOpts.providerRow || await embeddingProvider.resolveDefaultProvider(client);
      provider = embeddingProvider.createProviderFromRow(providerRow, { transport: runtimeOpts.transport });
      console.log(`  [PROVIDER] resolved default provider "${providerRow.name}" (native_dims=${providerRow.native_dims}, stored_dims=${providerRow.stored_dims}).`);

      // cm#202 S-B.5: mandatory wire into migrate-07 for MIGRATE and
      // DRY-RUN. Goes through provider's own (possibly test-injected)
      // transport -- preserves the existing test-suite transport-injection
      // convention so CI stays hermetic (no live vLLM required to exercise
      // this suite). NOT wired: a probe-once-per-process cache (deliberately
      // NOT built -- this PR's scope is one probe per migrate-07 invocation,
      // not a long-lived process) and per-write probing in exchange-log.js/
      // write-time-embed.js (their first wire call IS the embed itself; a
      // probe there would only add latency with zero earlier detection).
      // Both negative decisions recorded here and in the PR body.
      await embeddingProvider.probeProvider(provider, { timeoutMs: runtimeOpts.probeTimeoutMs });
      console.log(`  [PROBE] OK: provider "${providerRow.name}" @ "${providerRow.endpoint}" reachable; native_dims=${providerRow.native_dims} stored_dims=${providerRow.stored_dims} verified.`);
    } else {
      console.log('  [PROBE] SKIPPED: ROLLBACK mode performs zero provider I/O (cm#202 S-B.3) -- no live endpoint required, no provider resolved.');
    }

    await migrateOne.applySqlFile(client, SQL_FILE); // embedding_migration_batches + embedding_write_log

    const roster = tryLoadRoster(parsed.rosterPath, console.log);

    // ── G-R11 preflight ──────────────────────────────────────────────────
    const preflight = await runPreflight(client, roster, console.log);
    if (!preflight.ok) {
      console.error('Refused: G-R11 preflight failed -- phase (e)/(f) manifest-exclusion coverage is not intact. Nothing was embedded.');
      return false;
    }

    // ── G-R1 table discovery + provenance column ───────────────────────────
    // Additive/idempotent DDL only (ADD COLUMN IF NOT EXISTS) -- safe to run
    // unconditionally, including under --rollback (rollback's own UPDATE
    // needs embedded_by_provider_id to exist) and under --dry-run (this is
    // exactly the class of DDL migrate-05's own precedent already runs
    // unconditionally; see this script's header "CONTENT EXPRESSION
    // RESOLUTION" note and the independent review that drew this line).
    // discoverEmbeddableTables() matches BOTH vector and halfvec typnames,
    // so running discovery before the (still-conditional) ALTER sub-step
    // below finds the same table set either way.
    const discovered = await discoverEmbeddableTables(client);
    for (const { table } of discovered) {
      await ensureProvenanceColumn(client, table, console.log);
    }

    if (parsed.rollback) {
      // FIELD-FOUND FIX (independent review, PR #195): the G-R2 ALTER
      // sub-step (destructive forward DDL) used to run ABOVE this branch,
      // so invoking --rollback also performed a forward schema conversion
      // on its way to rolling back. The ALTER loop now runs ONLY below this
      // early return -- --rollback never reaches it.
      const result = await runRollback(client, parsed.rollback, console.log);
      console.log(`ROLLBACK_RESULT: PASS (rolled_back=${result.rolledBack})`);
      return true;
    }

    // ── G-R2 ALTER sub-step (destructive; dry-run-aware; guarded) ──────────
    // FIELD-FOUND FIX (independent review, PR #195): moved below the
    // rollback early-return (above) and now threads parsed.dryRun through --
    // see runAlterLegacyVectorColumn's own header comment for the full
    // blocking-defect writeup. A dry run REPORTS what this step would do
    // (current type, target type, populated-row count, dependent views/
    // indexes) and performs zero DDL; a populated column is a loud runtime
    // refusal in BOTH modes (reported in dry-run, thrown as a hard stop
    // otherwise), never a silent `USING NULL` discard.
    for (const t of LEGACY_VECTOR_TABLES) {
      await runAlterLegacyVectorColumn(client, t, console.log, parsed.dryRun);
    }

    // ── classify every discovered table ────────────────────────────────
    const tableSpecs = [];
    for (const { table } of discovered) {
      const spec = await resolveTableContentSpec(client, table, roster, console.log);
      const hasHash = await hasColumn(client, table, 'content_hash');
      const hasSuppressed = await hasColumn(client, table, 'suppressed');
      // FIELD-FOUND FIX (independent review, PR #195, non-blocking item (a)):
      // embedTable() unconditionally selects project_id; every one of the
      // 18 present-day embeddable tables carries it, but a future table
      // that doesn't would previously surface as a raw Postgres "column
      // does not exist" error instead of this script's own classified
      // refusal vocabulary. Checked here, alongside hasHash/hasSuppressed,
      // and refused with the SAME UNCLASSIFIABLE discipline
      // resolveTableContentSpec already uses for a missing content source.
      const hasProjectId = await hasColumn(client, table, 'project_id');
      if (!hasProjectId) {
        throw new Error(
          `UNCLASSIFIABLE: table "${table}" has an embedding column but no project_id column -- this script's batch-selection, ` +
          `G-R7 exclusion-scoping, and lineage encoding all assume project_id exists. Refusing (total classification: every ` +
          `embeddable table must resolve to a processable shape; an unrecognized shape is a loud FAIL, never a raw driver error).`
        );
      }
      const bucket = hasHash ? 'A' : (spec.source === 'roster' ? 'B' : 'C');
      tableSpecs.push({ table, spec, hasHash, hasSuppressed, bucket });
      console.log(`  [CLASSIFY] ${table}: bucket=${bucket} content-source=${spec.source} expr="${spec.expr}"`);
    }

    // providerRow/provider were already resolved (+ probed) immediately
    // after connect, above -- see the cm#202 S-B.4 block near the top of
    // this function for why the resolution moved here from its pre-cm#202
    // location.
    const runId = runtimeOpts.runId || crypto.randomUUID();
    console.log(`RUN_ID: ${runId}`);

    // (in-process-only injection point, same convention as transport/
    // providerRow/runId below -- never expressible via argv; production
    // default is HALVING_DELAY_MS, tests may override to avoid a slow
    // real-time sleep when constructing many exempt-overlength rows.)
    const halvingDelayMs = runtimeOpts.halvingDelayMs !== undefined ? runtimeOpts.halvingDelayMs : HALVING_DELAY_MS;

    const report = [];
    for (const ts of tableSpecs) {
      const excludedProjectIds = await getManifestExcludedProjectIds(client, roster, ts.table);
      const counts = await embedTable(client, ts.table, ts.spec, provider, providerRow.id, runId, excludedProjectIds, console.log, parsed.dryRun, halvingDelayMs);
      // (OL-6/OL-7) attach this table's exempt-overlength count onto its
      // tableSpec entry so runCompletenessGate() (reclassification) and
      // evaluateCardinalityAlarm() (threshold check) both read it -- computed
      // ONCE here, by the embed loop that actually ran, never re-derived.
      ts.exemptOverlength = counts.exemptOverlength;
      report.push({ table: ts.table, ...counts, excludedByManifest: excludedProjectIds.size });
      console.log(`  [EMBED] ${ts.table}: candidates=${counts.candidates} embedded=${counts.embedded} exempt-empty-content=${counts.exemptEmptyContent} exempt-overlength=${counts.exemptOverlength} excluded-project-ids=${excludedProjectIds.size}`);
    }

    if (parsed.dryRun) {
      console.log(
        'DRY_RUN_RESULT: PASS (no embedding writes, no destructive DDL performed -- see [DRY-RUN][ALTER] lines above for the ' +
        'G-R2 legacy-vector report; additive/idempotent DDL -- the 2 lineage tables + embedded_by_provider_id columns -- WAS applied, matching this script\'s CLI help text)'
      );
      return true;
    }

    const provOk = await runProvenanceVerification(client, discovered.map((d) => d.table), console.log);
    const gate = await runCompletenessGate(client, tableSpecs, console.log);
    const cardinality = evaluateCardinalityAlarm(report, console.log);

    const pass = provOk && gate.pass && cardinality.pass;
    console.log(JSON.stringify({ target, runId, report, completeness: gate.report, cardinality }, null, 2));
    console.log(`MIGRATION_RESULT: ${pass ? 'PASS' : 'FAIL'} (provenance_ok=${provOk}, completeness_gate_pass=${gate.pass}, cardinality_alarm_pass=${cardinality.pass}, total_exempt_overlength=${cardinality.totalExemptOverlength})`);
    return pass;
  } finally {
    await client.end();
  }
}

if (require.main === module) {
  main()
    .then((ok) => { process.exitCode = ok ? 0 : 1; })
    .catch((err) => {
      console.error(err && err.stack ? err.stack : err);
      process.exitCode = 1;
    });
}

/**
 * T8-idempotency-compatible entry point (mirrors migrate-05's run()).
 * `opts.transport`/`opts.providerRow`/`opts.runId`/`opts.halvingDelayMs`/
 * `opts.probeTimeoutMs` are in-process-only injection points (never
 * expressible via argv) -- this is how the test suite exercises the embed
 * loop AND the cm#202 preflight probe deterministically without a live
 * vLLM endpoint (G-R13), and without waiting out the real HALVING_DELAY_MS
 * pacing when a fixture needs many halving/exempt-overlength rows.
 */
async function run(targetDbName, opts = {}) {
  const argv = ['--db', targetDbName];
  if (opts.rosterPath) argv.push('--roster', opts.rosterPath);
  if (opts.rollback) argv.push('--rollback', opts.rollback);
  if (opts.dryRun) argv.push('--dry-run');
  process.argv = [process.argv[0], process.argv[1] || __filename, ...argv];
  return main({ transport: opts.transport, providerRow: opts.providerRow, runId: opts.runId, halvingDelayMs: opts.halvingDelayMs, probeTimeoutMs: opts.probeTimeoutMs });
}

module.exports = {
  parseArgs,
  UsageError,
  printUsage,
  main,
  run,
  hasColumn,
  getFormatType,
  discoverEmbeddableTables,
  ensureProvenanceColumn,
  tryLoadRoster,
  resolveTableContentSpec,
  manifestLabelsForTable,
  getManifestExcludedProjectIds,
  getPkSpec,
  encodePk,
  decodePk,
  pkWhereClause,
  runPreflight,
  runAlterLegacyVectorColumn,
  embedTable,
  runProvenanceVerification,
  runCompletenessGate,
  runRollback,
  isContextLengthError,
  embedWithHalvingRetry,
  evaluateCardinalityAlarm,
  CONTENT_EXPRESSIONS,
  LEGACY_VECTOR_TABLES,
  STRUCTURAL_DISPOSITION_TABLES,
  PK_OVERRIDES,
  LOCK_NAMESPACE,
  EMBED_TEXT_CAP_CHARS,
  HALVING_MAX_ATTEMPTS,
  HALVING_FLOOR_CHARS,
  HALVING_DELAY_MS,
  CARDINALITY_TOTAL_MAX,
  CARDINALITY_TABLE_RATIO_MAX,
  SQL_FILE,
};
