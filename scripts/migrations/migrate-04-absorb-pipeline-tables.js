'use strict';

/**
 * migrate-04-absorb-pipeline-tables.js
 *
 * CONSOLIDATION-RUNBOOK.md §6.1(e) + its E-1..E-15 spec-adversary amendment
 * (2026-08-16, memory-manager#11(e)): absorbs pipeline's/claude_policy_
 * framework's/claude_context's 14 in-scope memory-nature tables (the 13
 * §5.3 seam tables PLUS `sessions`, the 14th, added by this PR per E-2) into
 * the structured target tables on a memory-manager consolidation target
 * (default `memory_manager_staging`, per §15.1's staging-first path).
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHAT THIS SCRIPT DOES
 * ══════════════════════════════════════════════════════════════════════
 *
 *   0. DB ENUMERATION IS A TOTAL CLASSIFICATION (E-1/E-8). Connects to the
 *      Postgres maintenance db, enumerates every non-template pg_database
 *      entry, classifies EACH ONE via scripts/migrations/db-triage.json
 *      (real, gitignored — see db-triage.example.json for shape) into
 *      REAL-MIGRATE / EPHEMERAL-DROP / OWNER-REVIEW / ENGINE-INFRA. Any db
 *      name absent from that map is UNCLASSIFIED — a loud FATAL that blocks
 *      the ENTIRE run before any source connection is opened (never a
 *      silent skip, never a name-pattern `LIKE 'pipeline_%'` guess — the
 *      exact mechanism E-1 found could never discover `claude_context`, a
 *      real REAL-MIGRATE db with 172 live rows). EPHEMERAL-DROP/
 *      OWNER-REVIEW/ENGINE-INFRA dbs are printed as a named, loud-skip
 *      report line and this script never opens a connection to them (E-8).
 *
 *   1. IN-SCOPE TABLES (14 — the 13 §5.3 seam tables + `sessions`, E-2):
 *      decisions, gotchas, tasks, findings, research, incidents, code_index,
 *      checklist_items, corpus_files, workflow_discovery, agent_rewrites,
 *      policy_sections, session_chunks, sessions. `tasks` is fixed early in
 *      TABLE_ORDER, before `findings`/`research` (their task_id FK remap
 *      dependency, §6.1(e) step 3 / E-10).
 *
 *      `decisions` SCOPE NOTE (E-3): this script covers `decisions` for
 *      every REAL-MIGRATE source EXCEPT `claude_policy_framework` —
 *      `claude_policy_framework.decisions` stays migrate-02-decisions.js's
 *      job (phase (b)), unchanged. Phase ordering is pinned (b) before (e)
 *      into the shared `decisions` table (E-12) — run migrate-02 first.
 *
 *   2. COLUMN-SHAPE PRECONDITION (this script's own finding, beyond E-1..
 *      E-15): live-verified 2026-08-16 that §5.3's claim ("carries forward
 *      its pipeline column shape verbatim... a straight copy, not a
 *      reshape") is FALSE at the column level — `incidents`,
 *      `checklist_items`, `corpus_files`, `policy_sections`,
 *      `session_chunks`, and `tasks` each carry columns in at least one
 *      source db that have NO §5.3 target counterpart at all (e.g.
 *      `claude_policy_framework.tasks.issue_ref` vs.
 *      `pipeline_pipeline.tasks.github_issue` — same concept, different
 *      column name; `claude_context.tasks.notes`/`.blocker` — genuinely
 *      absent from every other source and from §5.3's declared shape
 *      entirely). §6.0's preservation guarantee forbids silently dropping
 *      that data. Fixed two ways: (a) COLUMN_MAPS below declares an exact,
 *      per-(source_db,table) source-column -> target-column map (renames
 *      where names differ, e.g. issue_ref -> github_issue); (b) this
 *      script's own migrate-04-seam-ddl-addenda.sql (bundled DDL preamble,
 *      applied at the top of every run) adds NULLABLE, ADDITIVE target
 *      columns for every source column with no §5.3 counterpart at all
 *      (incidents.status/memory_refs/playbook_refs,
 *      checklist_items.item_num/owner_name/source_file/content_hash,
 *      corpus_files.sha256, policy_sections.last_modified,
 *      session_chunks.content_hash/section_idx, tasks.notes/blocker — see
 *      that SQL file's header comment for full provenance). A PRECONDITION
 *      CHECK (checkColumnShapePrecondition) diffs every in-scope
 *      (source_db,table)'s LIVE columns against COLUMN_MAPS at run time and
 *      REFUSES LOUD, before any insert, if a column exists neither of us
 *      accounted for — never a silent drop if the source schema drifts
 *      again after this PR merges.
 *
 *   3. PROJECT_ID DERIVATION (§6.1(e) step 3 bullet 1, extended per E-11):
 *        - `pipeline_<name>` dbs (`pipeline_pipeline`,
 *          `pipeline_advisicon_ppm_monolith`, `pipeline_crm_mining`): the DB
 *          NAME is the project signal — resolved via
 *          scripts/migrations/pipeline-db-project-map.json (real,
 *          gitignored; mirrors D-12's known_project_ids pattern). A
 *          REAL-MIGRATE db absent from that map (never guessed) routes ALL
 *          its rows to `unmapped-pipeline-db-<dbname>`, flagged in the
 *          report — the SAME D-1/D-10 fallback-bucket discipline
 *          migrate-02-decisions.js already established for decisions
 *          topics, applied here at the whole-db grain.
 *        - `claude_policy_framework`'s NATIVE rows (every in-scope table
 *          this script touches there EXCEPT `decisions`, which is phase
 *          (b)'s job — see scope note above): §16.1's own enrollment-matrix
 *          row states policy-framework is the DB's native host project for
 *          rows "not otherwise prefix-scoped" — resolved via the SAME
 *          pipeline-db-project-map.json, keyed by the db name
 *          `claude_policy_framework` itself.
 *        - `claude_context` (E-11's violating trace: neither a
 *          `pipeline_<name>` db nor `claude_policy_framework`, ZERO
 *          topic-prefix convention, spans multiple real projects with no
 *          per-row project hint on most of its tables): its `decisions`
 *          table alone gets ROW-LEVEL classification via an ordered
 *          CONTAINS-typed classifier read from
 *          scripts/migrations/claude-context-topic-rules.json (real,
 *          gitignored) — acme-widget-portal-shaped topics route to an
 *          EXPLICITLY EXCLUDED `owner-review-acme-widget-portal` bucket
 *          (`excluded_reason` set, zero rows migrated, V6 "leave alone" —
 *          acme-widget-portal is itself a separate OWNER-REVIEW db); every
 *          other topic falls to the classifier's `unmatched-*` bucket
 *          (never silently migrated as real project data through the E-1
 *          side door). `claude_context`'s OTHER tables (gotchas/research/
 *          tasks/code_index/sessions) carry NO per-row project hint column
 *          at ALL (confirmed live) — this script routes them through the
 *          SAME pipeline-db-project-map.json DB-level default as any other
 *          unmapped REAL-MIGRATE db (`unmapped-pipeline-db-claude_context`
 *          unless the operator populates a real mapping), an EXPLICIT,
 *          STATED scope boundary (E-11's own fix text is scoped entirely to
 *          `.decisions` — its violating trace never examined the other
 *          tables), never a silent gap.
 *
 *   4. IDEMPOTENCY = LINEAGE-ROW EXISTENCE, NEVER NATURAL-KEY OR CONTENT
 *      MATCH (E-4/E-5/E-6 — closes the mm#18 binding constraint). A new
 *      `pipeline_migration_row_ids` table (registered in
 *      scripts/migrations/lib/verify15-shared.js's shared DDL_SQL, mirroring
 *      `own_graph_migration_ids`'s registration and the SAME reason: T0's
 *      live-table classification must recognize it as battery infra, not a
 *      private per-script DDL block) records (source_db, source_table,
 *      source_row_id) -> (project_id, target_table, target_row_id) for
 *      EVERY row this script inserts, in the SAME transaction as that row's
 *      insert. Before inserting any source row, this script checks for an
 *      existing lineage row at that (source_db, source_table,
 *      source_row_id) key — present means "already migrated by a prior run
 *      of this exact script," skip (re-run-safe); absent means insert
 *      (unconditionally, regardless of any natural-key or content
 *      collision with a DIFFERENT source row — fixes E-4's `policy_sections`
 *      collision, where 16 real distinct rows shared one natural key, and
 *      E-5's `gotchas` byte-identical-but-distinct-real-rows case
 *      uniformly, for every one of the 14 in-scope tables).
 *
 *      `findings`' target identity is its OWN composite PRIMARY KEY
 *      (project_id, id) — `id` is a source-prefixed TEXT id (e.g.
 *      "RT-INJ-001") preserved VERBATIM per §6.1(e) step 4 ("only the
 *      project-scoping changes, not the natural key"), never renumbered.
 *      E-6 flagged this as an open design point: `pipeline_migration_
 *      row_ids.target_row_id` is INTEGER and cannot hold a composite
 *      (project_id, id) pair. RESOLVED here by reusing
 *      migrate-verify-own-graph.js's `project_settings` precedent
 *      (identical shape of problem — no numeric target id, PK is a text
 *      key) rather than adding a surrogate `id` column §5.3 never
 *      specified: `findings`' lineage rows carry the source's own `id`
 *      string in `source_row_id` and a dummy sentinel value (1) in
 *      `target_row_id` (INTEGER NOT NULL, cannot hold text); rollback and
 *      idempotency lookups for `findings` are scoped by (project_id, id)
 *      directly, never by `target_row_id`. No new DDL, no surrogate
 *      column — `findings`' PK stays exactly as §5.3 declared it.
 *
 *      UNIQUE/PK SUPERSESSION (E-4/E-7): `incidents`, `corpus_files`,
 *      `code_index`, `policy_sections`, `session_chunks` had their §5.3
 *      UNIQUE/PK constraints on the stated natural keys superseded to plain
 *      non-unique indexes by migrate-04-seam-ddl-addenda.sql (the I-10 ->
 *      PR #179 pattern) — idempotency for these 5 comes ENTIRELY from
 *      lineage, never a DB constraint. `decisions` is the ONE exception:
 *      its live `decisions_project_topic_unique` UNIQUE(project_id, topic)
 *      constraint is KEPT (phase (b)'s ON CONFLICT upsert depends on it —
 *      dropping it would break a re-runnable migrate-02-decisions.js). See
 *      point 5 below for how this script's OWN decisions inserts coexist
 *      with that live constraint.
 *
 *   5. THE DECISIONS-UNIQUE COLLISION (E-3/E-12 — "the hardest design point
 *      in the task"): once this script routes `pipeline_pipeline`/
 *      `claude_context` decisions into the SAME shared `decisions` table
 *      migrate-02-decisions.js already writes into, a genuine cross-source
 *      topic collision (a `claude_policy_framework`-sourced row and a
 *      `pipeline_pipeline`/`claude_context`-sourced row for the SAME real
 *      project, under the SAME topic string) hits the live
 *      `decisions_project_topic_unique` constraint. TWO OPTIONS WERE
 *      WEIGHED: (a) keep the unique index, route (e)'s decisions through
 *      lineage-keyed inserts with a topic-suffix disambiguation on
 *      collision (breaks the topic string's own meaning, and permanently
 *      changes a row's natural key based on migration RUN ORDER — an
 *      arbitrary, non-reproducible disambiguation); (b) replace
 *      migrate-02's `ON CONFLICT (project_id, topic)` target entirely
 *      (breaks that script's own re-runnability, a MUCH bigger blast
 *      radius change to an already-shipped, already-reviewed script).
 *      NEITHER was chosen. Instead: `decisions` is the ONE table in this
 *      script's scope that keeps a pre-insert NATURAL-KEY divergence check
 *      (mirrors migrate-verify-own-graph.js's `entities`/
 *      `retrieval_contract`/`project_settings` pattern exactly — the
 *      ONLY §5.3 table where a real, DB-enforced natural key survives
 *      this PR's supersession pass, by design, since it is NOT superseded).
 *      Before inserting a decisions row (once its lineage check has already
 *      confirmed it is not a re-run), this script pre-checks `SELECT *
 *      FROM decisions WHERE project_id=X AND topic=Y`. No existing row:
 *      insert (with `ON CONFLICT (project_id, topic) DO NOTHING` as a
 *      belt-and-suspenders race guard) + record lineage. An existing row
 *      with IDENTICAL decision/reason text: this is almost certainly the
 *      SAME real decision independently logged in two source systems under
 *      the same topic string — skipped, no lineage recorded (so the SAME
 *      check re-runs and reaches the SAME conclusion on every future run —
 *      genuinely idempotent, not merely "skip once"), NOT counted as
 *      migrated. An existing row with DIFFERENT text: logged loud as
 *      `[CONTENT-DIVERGENCE]` (mirrors migrate-verify-own-graph.js's exact
 *      log shape and reasoning), skipped, NEVER overwritten — a genuine
 *      cross-source disagreement about what project X's decision on topic Y
 *      actually was, which is a real data question for a human, not
 *      something this script may resolve by upsert order. BOTH skip cases
 *      reduce this table's migrated count for its slice, which — mirroring
 *      migrate-verify-own-graph.js's STRICT equality philosophy exactly —
 *      makes that slice's own row-count reconciliation FAIL loud rather
 *      than silently pass, forcing operator investigation. Both scripts
 *      stay independently re-runnable: migrate-02's `(project_id, topic)`
 *      upsert target is untouched, and this script never writes to
 *      `decisions` outside its own lineage-or-divergence-checked path.
 *      Live census as of 2026-08-16 found ZERO actual collisions (this is
 *      forward risk-hardening, not an observed defect) — see blind-spots.
 *
 *   6. TASK_ID TOTAL CLASSIFICATION (E-10). `tasks` migrates first per
 *      TABLE_ORDER, building an old-id -> new-id map PER SOURCE DB (task ids
 *      are only unique WITHIN a source db, not globally). Every
 *      `findings.task_id`/`research.task_id` value is then classified: NULL
 *      (passthrough, expected) / valid-remappable (found in this run's own
 *      map, remapped) / dangling-pre-existing (task_id set, but no row in
 *      that db's own `tasks` table classifies it — logged BY NAME in the
 *      report, `task_id` set NULL on insert, tallied as a named bucket,
 *      NEVER silently indistinguishable from a true NULL). Live-verified:
 *      `claude_context.research` carries exactly one such row.
 *
 *   7. GRANDFATHER / CAVEMAN ESCAPE (§6.1(e) step 3 bullet 2, E-9 RESOLVED
 *      owner 2026-08-16). `authoring_mode = 'verbose'` at INSERT time
 *      (never a later UPDATE) for the 6 tables that HAVE the column
 *      (decisions, gotchas, findings, research, incidents, sessions —
 *      `sessions` gains the column via this PR's own DDL, point (1) of the
 *      addenda file). `migrated_legacy = true` at INSERT time for the 5
 *      tables that do NOT (tasks, code_index, checklist_items,
 *      workflow_discovery, agent_rewrites) — this PR's own addenda DDL adds
 *      that escape column and `test-caveman-economy-store-wide.js` (T7's
 *      dependency) is taught to skip `migrated_legacy=true` rows in the
 *      SAME PR. `corpus_files`/`policy_sections`/`session_chunks` need
 *      neither (caveman-columns.json already classifies their narrative-
 *      shaped columns `exempt-not-model-authored` — ingested source text,
 *      never model-authored). `agent_id` = NULL, `embedding` = NULL
 *      (phase (g)'s job) at migration time throughout — same D-6 pattern.
 *
 *   8. VERIFICATION GATE (§6.1(e) step 5, E-13 exclusion-aware fix). Every
 *      (source_db, table, project_id-or-bucket) slice reconciles migrated
 *      count to source count EXACTLY for non-excluded slices (a shortfall —
 *      from a decisions divergence-skip or a rare findings PK-collision
 *      SAVEPOINT catch — FAILS that slice's reconciliation, mirroring
 *      migrate-verify-own-graph.js's strict philosophy: an anomaly is
 *      always loud AND always blocks a clean PASS, never silently
 *      tolerated). Excluded slices (`owner-review-acme-widget-portal`) assert
 *      `excluded_reason` is set and the manifest's `row_count` equals the
 *      LIVE source count for that slice (proving exclusion, not silent
 *      loss — mirrors migrate-verify-own-graph.js's `writeJunkSlice`
 *      exactly). `migration_manifest`/`migration_manifest_row_hashes` rows
 *      are written per slice, in the SAME transaction as that slice's data
 *      inserts + lineage rows (D-5/D-11/C-11 precedent).
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHAT THIS SCRIPT DELIBERATELY DOES NOT DO (out of scope / blind spots
 * — see also this PR's body)
 * ══════════════════════════════════════════════════════════════════════
 *   - No embedding backfill (phase (g)).
 *   - No caveman-rewrite of migrated legacy prose (grandfathered, not
 *     mutated — point 7 above).
 *   - No reclassification-drift reconciliation (migrate-02-decisions.js's
 *     `reconcileOrphanedManifestSlices` has no analogue here): if an
 *     operator edits pipeline-db-project-map.json or
 *     claude-context-topic-rules.json BETWEEN two runs such that a row's
 *     classification changes, this script does NOT move/re-key rows already
 *     migrated under the OLD classification — a stated, honest scope
 *     limitation (no observed need for it against the live census; a
 *     genuine gap if this repo's routing maps are edited post-migration).
 *   - It never reads HANDOFF_DB, and it never creates the target database
 *     (run migrate-01-canonical-db.js + migrate-14-seam-tables.js first).
 *
 * Usage:
 *   node scripts/migrations/migrate-04-absorb-pipeline-tables.js [--db <target>]
 *     [--rollback] [--db-triage <path>] [--pipeline-db-map <path>]
 *     [--claude-context-rules <path>] [--backup-dir <path>]
 *
 * Exit codes: 0 = PASS (migrate: every non-excluded slice reconciles;
 * rollback: completed), 1 = refused / precondition failure / apply failure /
 * reconciliation failure, 2 = bad CLI usage.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Client } = require('pg');

const migrateOne = require('./migrate-01-canonical-db'); // reused by reference, never forked
const shared = require('./lib/verify15-shared'); // reused by reference: connect config, rowHash, applyDdl

// ─── PATHS / CONSTANTS ──────────────────────────────────────────────────────

const MIGRATIONS_DIR = __dirname;
const SQL_ADDENDA_FILE = path.join(MIGRATIONS_DIR, 'sql', 'migrate-04-seam-ddl-addenda.sql');
const DB_TRIAGE_PATH = path.join(MIGRATIONS_DIR, 'db-triage.json');
const PIPELINE_DB_MAP_PATH = path.join(MIGRATIONS_DIR, 'pipeline-db-project-map.json');
const CLAUDE_CONTEXT_RULES_PATH = path.join(MIGRATIONS_DIR, 'claude-context-topic-rules.json');
const BACKUP_DIR = path.join(MIGRATIONS_DIR, 'backups');

const SOURCE_MODEL_TAG = 'unknown-pre-migration';
const AUTHORING_MODE_TAG = 'verbose';
const CLAUDE_CONTEXT_DB = 'claude_context';
const POLICY_FRAMEWORK_DB = 'claude_policy_framework';

const HAS_AUTHORING_MODE_TABLES = new Set(['decisions', 'gotchas', 'findings', 'research', 'incidents', 'sessions']);
const NO_AUTHORING_MODE_TABLES = new Set(['tasks', 'code_index', 'checklist_items', 'workflow_discovery', 'agent_rewrites']);
// corpus_files/policy_sections/session_chunks: neither set -- caveman-columns.json
// already classifies their narrative columns exempt-not-model-authored.

// tasks BEFORE findings/research (E-10 task_id remap dependency).
const TABLE_ORDER = [
  'decisions', 'gotchas', 'tasks', 'findings', 'research', 'incidents',
  'code_index', 'checklist_items', 'corpus_files', 'workflow_discovery',
  'agent_rewrites', 'policy_sections', 'session_chunks', 'sessions',
];

// ─── COLUMN MAPS (source column -> target column), per (source_db, table) ──
// Live-derived 2026-08-16 via information_schema.columns against all three
// REAL-MIGRATE source dbs (point 2 of the header comment). id/created_at/
// updated_at/embedding/fts_vec are handled generically, never listed here.
// A (source_db, table) pair present in this map with >0 live rows but a
// column NOT listed here is a loud precondition FAIL (checkColumnShapePrecondition) --
// never a silent drop.
const COLUMN_MAPS = {
  [POLICY_FRAMEWORK_DB]: {
    gotchas: { issue: 'issue', rule: 'rule', active: 'active' },
    checklist_items: {
      checklist_name: 'checklist_name', cadence: 'cadence', item_num: 'item_num',
      title: 'title', description: 'description', owner: 'owner_name',
      verification_step: 'verification_step', source_file: 'source_file', content_hash: 'content_hash',
    },
    corpus_files: {
      path: 'path', file_type: 'file_type', size_bytes: 'bytes', sha256: 'sha256',
      source_domain: 'source_domain', summary: 'summary', last_indexed: 'ingested_at',
    },
    policy_sections: {
      doc_id: 'doc_id', section_num: 'section_num', section_title: 'section_title',
      content: 'content', source_file: 'source_path', last_modified: 'last_modified',
      chunk_idx: 'chunk_idx', content_hash: 'content_hash',
    },
    session_chunks: {
      session_num: 'session_num', section_idx: 'section_idx', chunk_kind: 'chunk_kind',
      content: 'content', chunk_idx: 'chunk_idx', content_hash: 'content_hash',
    },
    sessions: { num: 'session_num', date: 'session_date', tests: 'tests', summary: 'summary', project: 'source_project_hint' },
    // findings/research/incidents/code_index/tasks/workflow_discovery/agent_rewrites:
    // zero live rows as of the 2026-08-16 census -- no map needed unless data
    // appears (in which case checkColumnShapePrecondition refuses loud, per
    // its own design, rather than silently guessing a mapping).
  },
  pipeline_pipeline: {
    decisions: { session_num: 'session_num', topic: 'topic', decision: 'decision', reason: 'reason' },
    gotchas: { issue: 'issue', rule: 'rule', active: 'active' },
    findings: {
      source: 'source', severity: 'severity', confidence: 'confidence', location: 'location',
      category: 'category', description: 'description', impact: 'impact', remediation: 'remediation',
      effort: 'effort', verification_domain: 'verification_domain', status: 'status',
      github_issue: 'github_issue', commit_sha: 'commit_sha', task_id: 'task_id', report_path: 'report_path',
    },
    code_index: { path: 'path', description: 'description' },
    tasks: {
      title: 'title', status: 'status', phase: 'phase', priority: 'priority',
      github_issue: 'github_issue', readme_label: 'readme_label', category: 'category',
    },
    workflow_discovery: {
      step: 'step', item_type: 'item_type', number: 'number', title: 'title',
      detail: 'detail', status: 'status', persona: 'persona',
    },
    agent_rewrites: {
      agent_name: 'agent_name', skill_path: 'skill_path', as_is: 'as_is', to_be: 'to_be',
      gap: 'gap', effort: 'effort', depends_on: 'depends_on', status: 'status',
    },
    policy_sections: {
      doc_id: 'doc_id', section_num: 'section_num', section_title: 'section_title',
      content: 'content', source_path: 'source_path', chunk_idx: 'chunk_idx', content_hash: 'content_hash',
    },
    session_chunks: {
      session_num: 'session_num', session_id: 'session_id', chunk_idx: 'chunk_idx',
      chunk_kind: 'chunk_kind', content: 'content', source_jsonl: 'source_jsonl', content_hash: 'content_hash',
    },
    sessions: { num: 'session_num', date: 'session_date', tests: 'tests', summary: 'summary', project: 'source_project_hint' },
  },
  [CLAUDE_CONTEXT_DB]: {
    decisions: { session_num: 'session_num', topic: 'topic', decision: 'decision', reason: 'reason' },
    gotchas: { issue: 'issue', rule: 'rule' },
    research: { task_id: 'task_id', title: 'title', body: 'body' },
    code_index: { path: 'path', description: 'description' },
    tasks: { title: 'title', status: 'status', github_issue: 'github_issue', phase: 'phase', notes: 'notes', blocker: 'blocker' },
    sessions: { num: 'session_num', date: 'session_date', summary: 'summary', tests: 'tests' },
  },
};

// Columns generically ignored on the source side (never require a COLUMN_MAPS
// entry, never copied verbatim -- handled by dedicated logic or intentionally
// dropped as non-load-bearing bookkeeping the target regenerates itself).
const GENERIC_IGNORED_SOURCE_COLS = new Set(['id', 'created_at', 'updated_at', 'embedding', 'fts_vec']);

// `code_index` is the ONE in-scope table whose source rows carry NO `id`
// column at all (live-verified across all three source dbs -- its source
// shape is `path`, `description`, `fts_vec`, `embedding` only; `path` was
// its ORIGINAL natural-key identity before this PR's own migrate-14
// deviation added a plain target-side `id`). `path` is this script's
// SOURCE-SIDE row-identity substitute for `code_index` specifically --
// unique within a single source db's `code_index` table by construction
// (it was the sole column of a natural-key UNIQUE/PK in pipeline's own
// schema). Every other in-scope table has a real source `id` column.
const SOURCE_ID_COL = { code_index: 'path' };
function sourceIdCol(table) { return SOURCE_ID_COL[table] || 'id'; }

// ─── CLI ARGS ───────────────────────────────────────────────────────────────

class UsageError extends Error {}

function parseArgs(argv) {
  const parsed = {
    db: null, rollback: false,
    dbTriagePath: DB_TRIAGE_PATH, pipelineDbMapPath: PIPELINE_DB_MAP_PATH,
    claudeContextRulesPath: CLAUDE_CONTEXT_RULES_PATH, backupDir: BACKUP_DIR, help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--db') parsed.db = argv[++i];
    else if (a.startsWith('--db=')) parsed.db = a.slice('--db='.length);
    else if (a === '--rollback') parsed.rollback = true;
    else if (a === '--db-triage') parsed.dbTriagePath = argv[++i];
    else if (a.startsWith('--db-triage=')) parsed.dbTriagePath = a.slice('--db-triage='.length);
    else if (a === '--pipeline-db-map') parsed.pipelineDbMapPath = argv[++i];
    else if (a.startsWith('--pipeline-db-map=')) parsed.pipelineDbMapPath = a.slice('--pipeline-db-map='.length);
    else if (a === '--claude-context-rules') parsed.claudeContextRulesPath = argv[++i];
    else if (a.startsWith('--claude-context-rules=')) parsed.claudeContextRulesPath = a.slice('--claude-context-rules='.length);
    else if (a === '--backup-dir') parsed.backupDir = argv[++i];
    else if (a.startsWith('--backup-dir=')) parsed.backupDir = a.slice('--backup-dir='.length);
    else if (a === '--help' || a === '-h') parsed.help = true;
    else throw new UsageError(`Unknown argument: ${a}`);
  }
  return parsed;
}

function printUsage() {
  console.log([
    'Usage: node scripts/migrations/migrate-04-absorb-pipeline-tables.js [--db <target>]',
    '         [--rollback] [--db-triage <path>] [--pipeline-db-map <path>]',
    '         [--claude-context-rules <path>] [--backup-dir <path>]',
    '',
    '  --db <name>               Target database (else MIGRATE_TARGET_DB env, else memory_manager_staging).',
    '  --rollback                Delete every REAL-MIGRATE source\'s migrated rows via lineage + manifest rows.',
    '  --db-triage <path>        Path to db-triage.json (default: alongside this script).',
    '  --pipeline-db-map <path>  Path to pipeline-db-project-map.json (default: alongside this script).',
    '  --claude-context-rules <path>  Path to claude-context-topic-rules.json (default: alongside this script).',
    '  --backup-dir <path>       Directory for timestamped source backups (default: scripts/migrations/backups).',
  ].join('\n'));
}

// ─── db-triage.json LOADER + TOTAL CLASSIFICATION (E-1/E-8) ────────────────

const DB_TRIAGE_VALID_CLASSES = new Set(['REAL-MIGRATE', 'EPHEMERAL-DROP', 'OWNER-REVIEW', 'ENGINE-INFRA']);

function loadDbTriage(p) {
  if (!fs.existsSync(p)) {
    console.error(`FATAL: db-triage config not found at "${p}".`);
    console.error('This file carries private instance data (real database names) and is gitignored, never committed.');
    console.error('See scripts/migrations/db-triage.example.json for the required shape, or pass --db-triage <path>.');
    process.exit(1);
  }
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (err) {
    console.error(`FATAL: db-triage config at "${p}" is not valid JSON: ${err.message}`);
    process.exit(1);
  }
  if (!parsed.databases || typeof parsed.databases !== 'object') {
    console.error(`FATAL: db-triage config at "${p}" must carry a "databases" object.`);
    process.exit(1);
  }
  const bad = Object.entries(parsed.databases).filter(([, cls]) => !DB_TRIAGE_VALID_CLASSES.has(cls));
  if (bad.length) {
    console.error(`FATAL: db-triage config at "${p}" has ${bad.length} entr(y/ies) with an invalid class:`);
    for (const [db, cls] of bad) console.error(`  - "${db}": "${cls}" (must be one of ${[...DB_TRIAGE_VALID_CLASSES].join(', ')})`);
    process.exit(1);
  }
  return parsed.databases;
}

/** E-1: total classification, default branch = UNCLASSIFIED (loud, blocks the run). */
function classifyDb(dbName, triage) {
  return triage[dbName] || 'UNCLASSIFIED';
}

// ─── pipeline-db-project-map.json LOADER ───────────────────────────────────

function loadPipelineDbProjectMap(p) {
  if (!fs.existsSync(p)) {
    console.error(`FATAL: pipeline-db-project-map config not found at "${p}".`);
    console.error('This file carries private instance data and is gitignored, never committed.');
    console.error('See scripts/migrations/pipeline-db-project-map.example.json for the required shape.');
    process.exit(1);
  }
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (err) {
    console.error(`FATAL: pipeline-db-project-map at "${p}" is not valid JSON: ${err.message}`);
    process.exit(1);
  }
  if (!parsed.map || typeof parsed.map !== 'object') {
    console.error(`FATAL: pipeline-db-project-map at "${p}" must carry a "map" object.`);
    process.exit(1);
  }
  return parsed.map;
}

/** DB-level project_id derivation, with a NEVER-GUESSED unmapped-* fallback. */
function deriveDbLevelProjectId(sourceDb, dbMap) {
  if (dbMap[sourceDb]) return { projectId: dbMap[sourceDb], excluded: false };
  return { projectId: `unmapped-pipeline-db-${sourceDb}`, excluded: false };
}

// ─── claude-context-topic-rules.json LOADER + CLASSIFIER (E-11) ───────────

function loadClaudeContextTopicRules(p) {
  if (!fs.existsSync(p)) {
    console.error(`FATAL: claude-context-topic-rules config not found at "${p}".`);
    console.error('This file carries private instance data and is gitignored, never committed.');
    console.error('See scripts/migrations/claude-context-topic-rules.example.json for the required shape.');
    process.exit(1);
  }
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (err) {
    console.error(`FATAL: claude-context-topic-rules at "${p}" is not valid JSON: ${err.message}`);
    process.exit(1);
  }
  if (!Array.isArray(parsed.rules)) {
    console.error(`FATAL: claude-context-topic-rules at "${p}" must carry a "rules" array.`);
    process.exit(1);
  }
  for (const [i, rule] of parsed.rules.entries()) {
    if (rule.type !== 'CONTAINS' || typeof rule.pattern !== 'string' || !rule.pattern || typeof rule.target !== 'string' || !rule.target) {
      console.error(`FATAL: claude-context-topic-rules at "${p}", rule ${i}: must be {type:"CONTAINS", pattern:<non-empty string>, target:<non-empty string>}.`);
      process.exit(1);
    }
  }
  return parsed.rules;
}

/** E-11: ordered CONTAINS classifier, case-insensitive substring, first-match-wins.
 * Zero matches -> unmatched-<slugified-first-word> (never guessed, never dropped). */
function classifyClaudeContextTopic(topic, rules) {
  const lower = topic.toLowerCase().trim();
  for (const rule of rules) {
    if (lower.includes(rule.pattern.toLowerCase())) {
      return { projectId: rule.target, excluded: !!rule.excluded_reason, excludedReason: rule.excluded_reason || null };
    }
  }
  const firstWord = (lower.split(/\s+/)[0] || 'blank').replace(/[^a-z0-9-]/g, '') || 'blank';
  return { projectId: `unmatched-${firstWord}`, excluded: false, excludedReason: null };
}

// ─── SOURCE READ-ONLY GUARD ─────────────────────────────────────────────────

async function sourceSelect(client, sql, params) {
  if (!/^\s*SELECT\b/i.test(sql)) {
    throw new Error(`Refusing non-SELECT query against the read-only source connection: ${sql.slice(0, 120)}`);
  }
  return client.query(sql, params);
}

// ─── COLUMN-SHAPE PRECONDITION (point 2 of the header comment) ────────────

async function getLiveSourceColumns(client, table) {
  const { rows } = await client.query(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = $1`,
    [table]
  );
  return rows.map((r) => r.column_name);
}

/** Returns an array of unmapped source column names (empty = precondition PASS). */
function checkColumnShapePrecondition(liveCols, columnMap, sourceDb, table) {
  const declared = new Set(Object.keys(columnMap || {}));
  return liveCols.filter((c) => !GENERIC_IGNORED_SOURCE_COLS.has(c) && !declared.has(c));
}

// ─── BACKUP (read-only, timestamped) ───────────────────────────────────────

function timestampForFilename(d = new Date()) {
  return d.toISOString().replace(/[:.]/g, '-');
}

async function backupTable(srcClient, sourceDb, table, backupDir) {
  const { rows } = await sourceSelect(srcClient, `SELECT * FROM ${table}`);
  fs.mkdirSync(backupDir, { recursive: true });
  const fileName = `${sourceDb}-${table}-backup-${timestampForFilename()}.json`;
  const filePath = path.join(backupDir, fileName);
  fs.writeFileSync(filePath, JSON.stringify({
    source_db: sourceDb, source_table: table, captured_at: new Date().toISOString(),
    row_count: rows.length, rows,
  }, null, 2), 'utf8');
  return { filePath, rowCount: rows.length };
}

// ─── LINEAGE HELPERS (pipeline_migration_row_ids, E-6) ─────────────────────

async function getLineageEntry(tgtClient, sourceDb, sourceTable, sourceRowId) {
  const { rows } = await tgtClient.query(
    `SELECT target_row_id FROM pipeline_migration_row_ids
      WHERE source_db=$1 AND source_table=$2 AND source_row_id=$3`,
    [sourceDb, sourceTable, String(sourceRowId)]
  );
  return rows.length > 0 ? rows[0] : null;
}

async function recordLineage(tgtClient, sourceDb, sourceTable, sourceRowId, projectId, targetTable, targetRowId) {
  await tgtClient.query(
    `INSERT INTO pipeline_migration_row_ids (source_db, source_table, source_row_id, project_id, target_table, target_row_id)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (source_db, source_table, source_row_id) DO NOTHING`,
    [sourceDb, sourceTable, String(sourceRowId), projectId, targetTable, targetRowId]
  );
}

// findings has no numeric target id (composite PK project_id+id, source id
// preserved verbatim) -- same dummy-sentinel pattern as own_graph_migration_
// ids' project_settings handling. See header comment point 4.
const FINDINGS_TARGET_ROW_ID_SENTINEL = 1;

// ─── MANIFEST WRITE (mirrors migrate-02/migrate-verify-own-graph shape) ───

function computeContentFingerprint(orderedRows, contentCols) {
  const concatenated = orderedRows.map((r) => shared.rowHash(contentCols, r)).join('');
  return crypto.createHash('md5').update(concatenated).digest('hex');
}

async function writeManifestSlice(tgtClient, sourceDb, sourceTable, projectId, rowsOrderedById, contentCols, excludedReason, idCol) {
  // FIELD-FOUND FIX (migrate-05-sync-file-memory.js staging run, 2026-08-16):
  // `project_id_or_null=$3` is a plain SQL equality -- when projectId is
  // JS `null` (a whole-db/no-natural-project-id slice, e.g. Step B's
  // exclusion writes), the bound parameter is SQL NULL, and `x = NULL` is
  // UNKNOWN, never TRUE, for EVERY row including ones that are ALSO NULL.
  // The DELETE below silently matched zero rows on every re-run for a
  // null-projectId slice, so each re-run INSERTed a fresh duplicate
  // migration_manifest row instead of replacing the prior one -- live-
  // verified against memory_manager_staging: dozens of duplicate slices
  // already accumulated across prior scripts' historical runs before this
  // fix (claude_memory_eval_test/retrieval_contract alone had 282 rows for
  // one slice). `IS NOT DISTINCT FROM` is NULL-safe equality (identical to
  // `=` for two non-null values; matches NULL-to-NULL correctly, unlike
  // `=`) -- this is the general fix (every caller of writeManifestSlice
  // with a null projectId is fixed at once), not a narrow point-patch
  // scoped to migrate-05's own call sites.
  await tgtClient.query(
    `DELETE FROM migration_manifest WHERE source_db=$1 AND source_table=$2 AND project_id_or_null IS NOT DISTINCT FROM $3`,
    [sourceDb, sourceTable, projectId]
  );
  await tgtClient.query(
    `DELETE FROM migration_manifest_row_hashes WHERE source_db=$1 AND source_table=$2 AND project_id_or_null IS NOT DISTINCT FROM $3`,
    [sourceDb, sourceTable, projectId]
  );
  const fingerprint = computeContentFingerprint(rowsOrderedById, contentCols);
  await tgtClient.query(
    `INSERT INTO migration_manifest (source_db, source_table, project_id_or_null, row_count, content_fingerprint, excluded_reason)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [sourceDb, sourceTable, projectId, rowsOrderedById.length, fingerprint, excludedReason]
  );
  for (const row of rowsOrderedById) {
    const h = shared.rowHash(contentCols, row);
    await tgtClient.query(
      `INSERT INTO migration_manifest_row_hashes (source_db, source_table, project_id_or_null, source_row_id, source_hash)
       VALUES ($1,$2,$3,$4,$5)`,
      [sourceDb, sourceTable, projectId, String(row[idCol]), h]
    );
  }
}

// ─── TASK_ID TOTAL CLASSIFICATION (E-10) ───────────────────────────────────

/**
 * @returns {{ value: number|null, bucket: 'null'|'valid-remappable'|'dangling-pre-existing' }}
 */
function classifyTaskId(taskId, taskIdMap) {
  if (taskId === null || taskId === undefined) return { value: null, bucket: 'null' };
  const remapped = taskIdMap.get(String(taskId));
  if (remapped !== undefined) return { value: remapped, bucket: 'valid-remappable' };
  return { value: null, bucket: 'dangling-pre-existing' };
}

// ─── PER-ROW INSERT ─────────────────────────────────────────────────────────

/** Builds the INSERT column/value lists for one row, generic across every table. */
function buildInsertPayload(table, sourceRow, columnMap, projectId, extra) {
  const cols = ['project_id'];
  const vals = [projectId];
  for (const [srcCol, tgtCol] of Object.entries(columnMap)) {
    cols.push(tgtCol);
    vals.push(sourceRow[srcCol] === undefined ? null : sourceRow[srcCol]);
  }
  cols.push('source_model');
  vals.push(SOURCE_MODEL_TAG);
  if (HAS_AUTHORING_MODE_TABLES.has(table)) {
    cols.push('authoring_mode');
    vals.push(AUTHORING_MODE_TAG);
  }
  if (NO_AUTHORING_MODE_TABLES.has(table)) {
    cols.push('migrated_legacy');
    vals.push(true);
  }
  if (extra) {
    for (const [c, v] of Object.entries(extra)) {
      cols.push(c);
      vals.push(v);
    }
  }
  return { cols, vals };
}

/**
 * Straight lineage-gated insert for every in-scope table EXCEPT `decisions`
 * (which has its own natural-key-divergence-checked path, insertDecisionRow
 * below) and `findings` (composite PK sentinel handling, insertFindingsRow
 * below). Returns 'migrated' | 'already-migrated' | 'constraint-conflict'.
 */
async function insertGenericRow(tgtClient, sourceDb, table, sourceRow, projectId, columnMap, log, extra) {
  const srcId = sourceRow[sourceIdCol(table)];
  const prior = await getLineageEntry(tgtClient, sourceDb, table, srcId);
  if (prior) return 'already-migrated';

  const { cols, vals } = buildInsertPayload(table, sourceRow, columnMap, projectId, extra);
  await tgtClient.query('SAVEPOINT row_ins');
  try {
    const placeholders = vals.map((_, i) => `$${i + 1}`).join(', ');
    const { rows } = await tgtClient.query(
      `INSERT INTO ${table} (${cols.map((c) => `"${c}"`).join(', ')}) VALUES (${placeholders}) RETURNING id`,
      vals
    );
    await tgtClient.query('RELEASE SAVEPOINT row_ins');
    await recordLineage(tgtClient, sourceDb, table, srcId, projectId, table, rows[0].id);
    return 'migrated';
  } catch (err) {
    await tgtClient.query('ROLLBACK TO SAVEPOINT row_ins');
    if (err && err.code === '23505') {
      log(`  [CONSTRAINT-CONFLICT] ${table} source_db="${sourceDb}" project_id="${projectId}" source id=${srcId}: unique_violation on insert (${err.constraint || err.message}) -- skipped, NOT counted as migrated.`);
      return 'constraint-conflict';
    }
    throw err;
  }
}

/** findings: composite PK (project_id, id), source id preserved verbatim, lineage sentinel. */
async function insertFindingsRow(tgtClient, sourceDb, sourceRow, projectId, columnMap, taskIdMap, log) {
  const prior = await getLineageEntry(tgtClient, sourceDb, 'findings', sourceRow.id);
  if (prior) return { result: 'already-migrated', taskIdBucket: null };

  const taskIdCls = classifyTaskId(sourceRow.task_id, taskIdMap);
  if (taskIdCls.bucket === 'dangling-pre-existing') {
    log(`  [DANGLING-TASK-ID] findings source_db="${sourceDb}" id=${sourceRow.id}: task_id=${sourceRow.task_id} matches no row in this source db's own tasks table -- nulled, tallied.`);
  }
  const rowForInsert = { ...sourceRow, task_id: taskIdCls.value };
  const { cols, vals } = buildInsertPayload('findings', rowForInsert, columnMap, projectId, null);
  cols.push('id');
  vals.push(sourceRow.id);

  await tgtClient.query('SAVEPOINT row_ins');
  try {
    const placeholders = vals.map((_, i) => `$${i + 1}`).join(', ');
    await tgtClient.query(
      `INSERT INTO findings (${cols.map((c) => `"${c}"`).join(', ')}) VALUES (${placeholders})`,
      vals
    );
    await tgtClient.query('RELEASE SAVEPOINT row_ins');
    await recordLineage(tgtClient, sourceDb, 'findings', sourceRow.id, projectId, 'findings', FINDINGS_TARGET_ROW_ID_SENTINEL);
    return { result: 'migrated', taskIdBucket: taskIdCls.bucket };
  } catch (err) {
    await tgtClient.query('ROLLBACK TO SAVEPOINT row_ins');
    if (err && err.code === '23505') {
      log(`  [CONSTRAINT-CONFLICT] findings source_db="${sourceDb}" project_id="${projectId}" source id=${sourceRow.id}: unique_violation on insert (${err.constraint || err.message}) -- skipped, NOT counted as migrated.`);
      return { result: 'constraint-conflict', taskIdBucket: taskIdCls.bucket };
    }
    throw err;
  }
}

/** research: same shape as findings' task_id remap, but a plain SERIAL target id. */
async function insertResearchRow(tgtClient, sourceDb, sourceRow, projectId, columnMap, taskIdMap, log) {
  const prior = await getLineageEntry(tgtClient, sourceDb, 'research', sourceRow.id);
  if (prior) return { result: 'already-migrated', taskIdBucket: null };

  const taskIdCls = classifyTaskId(sourceRow.task_id, taskIdMap);
  if (taskIdCls.bucket === 'dangling-pre-existing') {
    log(`  [DANGLING-TASK-ID] research source_db="${sourceDb}" id=${sourceRow.id}: task_id=${sourceRow.task_id} matches no row in this source db's own tasks table -- nulled, tallied.`);
  }
  const rowForInsert = { ...sourceRow, task_id: taskIdCls.value };
  const outcome = await insertGenericRow(tgtClient, sourceDb, 'research', rowForInsert, projectId, columnMap, log);
  // insertGenericRow's own lineage check uses sourceRow.id which we didn't
  // mutate (only task_id changed) -- consistent identity throughout.
  return { result: outcome, taskIdBucket: taskIdCls.bucket };
}

/**
 * decisions: E-3/E-12's natural-key-divergence-checked path -- the ONE
 * table whose live UNIQUE(project_id, topic) constraint is KEPT (see header
 * comment point 5). Returns 'migrated' | 'already-migrated' |
 * 'benign-coincidence' | 'content-divergence'.
 */
/**
 * DESIGN NOTE (E-3/E-12, revised after a real staging run -- see this PR's
 * body for the full story; the real topic string involved is intentionally
 * NOT quoted here, per this repo's zero-instance-data-in-public-files
 * canon -- see E-3's fix text for the documented example, in the private
 * runbook). The FIRST cut of this function treated a same-(project_id,
 * topic) collision as a skip-and-log ([CONTENT-DIVERGENCE]) whenever
 * content differed. A real run against `pipeline_pipeline` immediately
 * reproduced the exact failure E-3's own fix text warned about: 13
 * pipeline_pipeline.decisions rows sharing ONE LITERAL topic string WITHIN
 * THE SAME SOURCE (not merely a cross-source collision), each with
 * genuinely distinct decision/reason text. The skip-on-divergence design
 * let exactly ONE of the 13 survive and silently discarded the other 12 as
 * "skipped, not migrated" -- a direct violation of §6.0's lossless-fidelity
 * guarantee, caught only because this script's OWN reconciliation gate
 * (E-13) is strict enough to fail loud on a shortfall rather than pass
 * silently.
 *
 * FIXED: same-(project_id,topic)-different-content is no longer a drop. It
 * is a DETERMINISTIC, REPRODUCIBLE topic disambiguation: the target topic
 * becomes `<original topic> [migrated:<source_db>#<source_row_id>]` --
 * suffixed with the SOURCE ROW'S OWN immutable id, never an insertion-order-
 * dependent counter, so re-running this script (in any order, any number of
 * times) always computes the SAME disambiguated topic for the SAME source
 * row and lands it at the SAME lineage-tracked identity. Only a TRUE
 * same-(project_id,topic)-IDENTICAL-content match is treated as a genuine
 * duplicate and skipped without disambiguation (the same real decision,
 * independently logged twice) -- every genuinely distinct decision gets its
 * own row, always, full stop.
 */
async function insertDecisionRow(tgtClient, sourceDb, sourceRow, projectId, columnMap, log) {
  const prior = await getLineageEntry(tgtClient, sourceDb, 'decisions', sourceRow.id);
  if (prior) return 'already-migrated';

  const { rows: existing } = await tgtClient.query(
    `SELECT decision, reason FROM decisions WHERE project_id=$1 AND topic=$2`,
    [projectId, sourceRow.topic]
  );
  let effectiveTopic = sourceRow.topic;
  if (existing.length > 0) {
    const sameContent = existing[0].decision === sourceRow.decision && existing[0].reason === sourceRow.reason;
    if (sameContent) {
      log(`  [BENIGN-COINCIDENCE] decisions project_id="${projectId}" topic=${JSON.stringify(sourceRow.topic)}: identical content already present (likely the same real decision logged by another source) -- skipped, not duplicated, no lineage recorded.`);
      return 'benign-coincidence';
    }
    effectiveTopic = `${sourceRow.topic} [migrated:${sourceDb}#${sourceRow.id}]`;
    log(`  [TOPIC-DISAMBIGUATED] decisions project_id="${projectId}" topic=${JSON.stringify(sourceRow.topic)}: an existing row at this (project_id, topic) has DIFFERENT content -- a genuinely distinct decision, never dropped. Disambiguated to ${JSON.stringify(effectiveTopic)} (deterministic, keyed on this source row's own immutable id -- stable across re-runs and independent of insertion order).`);
  }

  const rowForInsert = { ...sourceRow, topic: effectiveTopic };
  const { cols, vals } = buildInsertPayload('decisions', rowForInsert, columnMap, projectId, null);
  const placeholders = vals.map((_, i) => `$${i + 1}`).join(', ');
  const { rows } = await tgtClient.query(
    `INSERT INTO decisions (${cols.map((c) => `"${c}"`).join(', ')}) VALUES (${placeholders})
       ON CONFLICT (project_id, topic) DO NOTHING RETURNING id`,
    vals
  );
  if (rows.length === 0) {
    // The disambiguated topic is deterministic per source row, so this can
    // only fire on a genuine concurrent race with another writer inserting
    // the EXACT SAME disambiguated topic at the EXACT SAME instant -- never
    // silently claimed as ours.
    log(`  [CONSTRAINT-CONFLICT] decisions project_id="${projectId}" topic=${JSON.stringify(effectiveTopic)}: ON CONFLICT DO NOTHING fired (race) -- skipped, NOT counted as migrated.`);
    return 'content-divergence';
  }
  await recordLineage(tgtClient, sourceDb, 'decisions', sourceRow.id, projectId, 'decisions', rows[0].id);
  return 'migrated';
}

// ─── PER-SLICE MIGRATION ────────────────────────────────────────────────────

async function migrateTableSlice(tgtClient, sourceDb, table, projectId, sourceRows, columnMap, taskIdMap, log) {
  await tgtClient.query('BEGIN');
  let migrated = 0, alreadyMigrated = 0, skipped = 0;
  const danglingTaskIds = [];
  try {
    for (const row of sourceRows) {
      let outcome;
      if (table === 'decisions') {
        outcome = await insertDecisionRow(tgtClient, sourceDb, row, projectId, columnMap, log);
      } else if (table === 'findings') {
        const r = await insertFindingsRow(tgtClient, sourceDb, row, projectId, columnMap, taskIdMap, log);
        outcome = r.result;
        if (r.taskIdBucket === 'dangling-pre-existing') danglingTaskIds.push(row.id);
      } else if (table === 'research') {
        const r = await insertResearchRow(tgtClient, sourceDb, row, projectId, columnMap, taskIdMap, log);
        outcome = r.result;
        if (r.taskIdBucket === 'dangling-pre-existing') danglingTaskIds.push(row.id);
      } else {
        outcome = await insertGenericRow(tgtClient, sourceDb, table, row, projectId, columnMap, log);
      }
      if (outcome === 'migrated') migrated++;
      else if (outcome === 'already-migrated') alreadyMigrated++;
      else skipped++;
    }

    const idCol = sourceIdCol(table);
    const orderedById = [...sourceRows].sort((a, b) => (a[idCol] < b[idCol] ? -1 : a[idCol] > b[idCol] ? 1 : 0));
    const contentCols = Object.keys(columnMap);
    await writeManifestSlice(tgtClient, sourceDb, table, projectId, orderedById, contentCols, null, idCol);

    await tgtClient.query('COMMIT');
  } catch (err) {
    await tgtClient.query('ROLLBACK');
    throw err;
  }
  return { migrated, alreadyMigrated, skipped, danglingTaskIds, sourceCount: sourceRows.length };
}

async function writeExcludedSlice(tgtClient, sourceDb, table, projectId, sourceRows, columnMap, excludedReason, log) {
  await tgtClient.query('BEGIN');
  try {
    const idCol = sourceIdCol(table);
    const orderedById = [...sourceRows].sort((a, b) => (a[idCol] < b[idCol] ? -1 : a[idCol] > b[idCol] ? 1 : 0));
    const contentCols = Object.keys(columnMap);
    await writeManifestSlice(tgtClient, sourceDb, table, projectId, orderedById, contentCols, excludedReason, idCol);
    await tgtClient.query('COMMIT');
  } catch (err) {
    await tgtClient.query('ROLLBACK');
    throw err;
  }
  log(`  [EXCLUDED] ${table} source_db="${sourceDb}" project_id="${projectId}": ${sourceRows.length} row(s) excluded_reason="${excludedReason}" -- zero rows migrated, proven via manifest row_count.`);
}

// ─── ROLLBACK MODE ──────────────────────────────────────────────────────────

async function runRollback(tgtClient, sourceDbs, log) {
  let totalDeleted = 0;
  for (const sourceDb of sourceDbs) {
    // SAFETY (found during a real rollback test run, 2026-08-16): a bare
    // `source_db = $1` query reaches into OTHER migration scripts'
    // migration_manifest slices for the SAME source db (e.g.
    // migrate-03-corpus-project-id.js also writes manifest rows keyed by
    // source_db='claude_policy_framework' for `memory_entries`/
    // `memory_entry_chunks`, a table this script never touches) --
    // unconditionally deleting THEIR manifest bookkeeping even though this
    // script's own pipeline_migration_row_ids lineage table has zero
    // entries for those slices (so no actual content-row delete happens,
    // but the manifest/row_hashes rows for a DIFFERENT script's slice are
    // destroyed regardless). MUST be scoped to exactly this script's own
    // 14 in-scope tables -- never a bare source_db match.
    const { rows: rawSlices } = await tgtClient.query(
      `SELECT DISTINCT source_table, project_id_or_null FROM migration_manifest
        WHERE source_db = $1 AND excluded_reason IS NULL AND source_table = ANY($2::text[])`,
      [sourceDb, TABLE_ORDER]
    );
    // E-3: (claude_policy_framework, decisions) is explicitly OUT of this
    // script's scope in EVERY mode, forward migration included (see the
    // `continue` in main()'s per-table loop) -- rollback must apply the
    // SAME exclusion. Found the hard way: an earlier cut of this function
    // scoped only by table name, which still matched this pair (TABLE_ORDER
    // includes 'decisions' generically) and deleted migrate-02-decisions.js's
    // OWN manifest row for it during a rollback test run (zero actual
    // decisions-row content was touched, since this script's own
    // pipeline_migration_row_ids lineage has zero entries for that pair --
    // but the manifest bookkeeping row was destroyed regardless).
    const slices = rawSlices.filter(
      (s) => !(sourceDb === POLICY_FRAMEWORK_DB && s.source_table === 'decisions')
    );
    for (const { source_table: table, project_id_or_null: projectId } of slices) {
      await tgtClient.query('BEGIN');
      try {
        const { rows: lineageRows } = await tgtClient.query(
          `SELECT source_row_id, target_row_id FROM pipeline_migration_row_ids
            WHERE source_db=$1 AND source_table=$2 AND project_id=$3`,
          [sourceDb, table, projectId]
        );
        let deleted = 0;
        if (table === 'findings') {
          for (const l of lineageRows) {
            const res = await tgtClient.query(`DELETE FROM findings WHERE project_id=$1 AND id=$2`, [projectId, l.source_row_id]);
            deleted += res.rowCount;
          }
        } else {
          const ids = lineageRows.map((l) => l.target_row_id);
          if (ids.length > 0) {
            const res = await tgtClient.query(`DELETE FROM ${table} WHERE id = ANY($1::int[])`, [ids]);
            deleted = res.rowCount;
          }
        }
        await tgtClient.query(
          `DELETE FROM pipeline_migration_row_ids WHERE source_db=$1 AND source_table=$2 AND project_id=$3`,
          [sourceDb, table, projectId]
        );
        await tgtClient.query(
          `DELETE FROM migration_manifest WHERE source_db=$1 AND source_table=$2 AND project_id_or_null=$3`,
          [sourceDb, table, projectId]
        );
        await tgtClient.query(
          `DELETE FROM migration_manifest_row_hashes WHERE source_db=$1 AND source_table=$2 AND project_id_or_null=$3`,
          [sourceDb, table, projectId]
        );
        await tgtClient.query('COMMIT');
        totalDeleted += deleted;
        log(`  [ROLLBACK] ${table}/${projectId}: deleted ${deleted} row(s) + lineage/manifest`);
      } catch (err) {
        await tgtClient.query('ROLLBACK');
        throw err;
      }
    }
    // Excluded slices also get their manifest rows cleaned up (no data was
    // ever inserted for them, so no target-row delete is needed).
    // migration_manifest_row_hashes has no excluded_reason column of its
    // own -- deleted by (source_db, source_table, project_id_or_null) keyed
    // off the excluded slices actually present in migration_manifest.
    const { rows: excludedSlices } = await tgtClient.query(
      `SELECT source_table, project_id_or_null FROM migration_manifest
        WHERE source_db=$1 AND excluded_reason IS NOT NULL AND source_table = ANY($2::text[])`,
      [sourceDb, TABLE_ORDER]
    );
    for (const es of excludedSlices) {
      await tgtClient.query(
        `DELETE FROM migration_manifest_row_hashes WHERE source_db=$1 AND source_table=$2 AND project_id_or_null=$3`,
        [sourceDb, es.source_table, es.project_id_or_null]
      );
      await tgtClient.query(
        `DELETE FROM migration_manifest WHERE source_db=$1 AND source_table=$2 AND project_id_or_null=$3`,
        [sourceDb, es.source_table, es.project_id_or_null]
      );
    }
  }
  console.log(`ROLLBACK_RESULT: PASS (deleted ${totalDeleted} row(s) total)`);
  return { totalDeleted };
}

// ─── MAIN MIGRATION FLOW ────────────────────────────────────────────────────

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

  const dbTriage = loadDbTriage(parsed.dbTriagePath);
  const pipelineDbMap = loadPipelineDbProjectMap(parsed.pipelineDbMapPath);
  const claudeContextRules = loadClaudeContextTopicRules(parsed.claudeContextRulesPath);

  console.log(`migrate-04-absorb-pipeline-tables: target="${target}" (resolved from ${targetSource}) mode=${parsed.rollback ? 'ROLLBACK' : 'MIGRATE'}`);

  // ── DB enumeration + total classification (E-1/E-8) ──────────────────────
  const sysClient = new Client(migrateOne.pgConfig('postgres'));
  await sysClient.connect();
  let allDbNames;
  try {
    const { rows } = await sysClient.query(`SELECT datname FROM pg_database WHERE datistemplate = false ORDER BY datname`);
    allDbNames = rows.map((r) => r.datname);
  } finally {
    await sysClient.end();
  }

  const unclassified = allDbNames.filter((d) => classifyDb(d, dbTriage) === 'UNCLASSIFIED');
  if (unclassified.length > 0) {
    console.error(`Refused (E-1 total classification): ${unclassified.length} live database(s) are UNCLASSIFIED in db-triage.json:`);
    for (const d of unclassified) console.error(`  - "${d}"`);
    console.error('Total classification: every non-template database must be classified REAL-MIGRATE / EPHEMERAL-DROP / OWNER-REVIEW / ENGINE-INFRA before this script may run. Nothing was touched.');
    process.exit(1);
  }

  const realMigrateDbs = [];
  for (const d of allDbNames) {
    const cls = classifyDb(d, dbTriage);
    if (cls === 'REAL-MIGRATE') realMigrateDbs.push(d);
    else console.log(`  [SKIP-${cls}] "${d}" -- never connected to (E-8).`);
  }
  console.log(`  REAL-MIGRATE databases: ${realMigrateDbs.join(', ')}`);

  const tgtClient = new Client(migrateOne.pgConfig(target));
  await tgtClient.connect();

  let exitCode = 0;
  try {
    for (const table of ['decisions', 'findings']) {
      const { rows: tblRows } = await tgtClient.query(
        `SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name=$1`,
        [table]
      );
      if (tblRows.length === 0) {
        console.error(`Refused: target "${target}" is missing the "${table}" table. Run migrate-14-seam-tables.js first.`);
        process.exitCode = 1;
        return;
      }
    }

    await shared.applyDdl(tgtClient); // migration_manifest + pipeline_migration_row_ids + siblings
    await migrateOne.applySqlFile(tgtClient, SQL_ADDENDA_FILE); // sessions + migrated_legacy + UNIQUE supersession + extra cols

    if (parsed.rollback) {
      await runRollback(tgtClient, realMigrateDbs, console.log);
      exitCode = 0;
      return;
    }

    let grandTotalMigrated = 0, grandTotalSource = 0, grandTotalExcluded = 0;
    const perSliceReport = [];
    const precheckFailures = [];

    for (const sourceDb of realMigrateDbs) {
      const srcClient = new Client(migrateOne.pgConfig(sourceDb));
      await srcClient.connect();
      const taskIdMap = new Map(); // sourceDb-scoped old-task-id -> new-task-id (E-10)

      try {
        for (const table of TABLE_ORDER) {
          if (sourceDb === POLICY_FRAMEWORK_DB && table === 'decisions') continue; // E-3: stays phase (b)'s job

          // Some source dbs lack a given in-scope table ENTIRELY (not just
          // empty -- e.g. claude_context has no findings/incidents/
          // checklist_items/corpus_files/workflow_discovery/agent_rewrites/
          // policy_sections/session_chunks tables at all, confirmed live).
          // Treated identically to a genuinely-empty table: skip, no
          // manifest row, never an error.
          const { rows: existsRows } = await sourceSelect(
            srcClient,
            `SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name=$1`,
            [table]
          );
          if (existsRows.length === 0) continue;

          const { rows: countRows } = await sourceSelect(srcClient, `SELECT COUNT(*)::int AS n FROM ${table}`);
          if (countRows[0].n === 0) continue; // no manifest row for a genuinely-empty slice

          const liveCols = await getLiveSourceColumns(srcClient, table);
          const columnMap = (COLUMN_MAPS[sourceDb] || {})[table];
          if (!columnMap) {
            precheckFailures.push(`(${sourceDb}, ${table}): has ${countRows[0].n} live row(s) but no COLUMN_MAPS entry exists -- refusing to guess a mapping.`);
            continue;
          }
          const unmapped = checkColumnShapePrecondition(liveCols, columnMap, sourceDb, table);
          if (unmapped.length > 0) {
            precheckFailures.push(`(${sourceDb}, ${table}): ${unmapped.length} live column(s) have no COLUMN_MAPS entry: ${unmapped.join(', ')}`);
            continue;
          }

          const backup = await backupTable(srcClient, sourceDb, table, parsed.backupDir);
          console.log(`  [BACKUP] ${sourceDb}.${table}: ${backup.rowCount} row(s) -> ${backup.filePath}`);

          const { rows: sourceRows } = await sourceSelect(srcClient, `SELECT * FROM ${table} ORDER BY ${sourceIdCol(table)}`);

          // ── group into slices by project_id (or excluded bucket) ────────
          const slices = new Map(); // projectId -> { rows, excluded, excludedReason }
          for (const row of sourceRows) {
            let cls;
            if (table === 'decisions' && sourceDb === CLAUDE_CONTEXT_DB) {
              cls = classifyClaudeContextTopic(row.topic, claudeContextRules);
            } else {
              cls = deriveDbLevelProjectId(sourceDb, pipelineDbMap);
            }
            const key = cls.projectId;
            if (!slices.has(key)) slices.set(key, { rows: [], excluded: cls.excluded, excludedReason: cls.excludedReason });
            slices.get(key).rows.push(row);
          }

          for (const [projectId, slice] of slices) {
            if (slice.excluded) {
              await writeExcludedSlice(tgtClient, sourceDb, table, projectId, slice.rows, columnMap, slice.excludedReason, console.log);
              perSliceReport.push({ sourceDb, table, projectId, excluded: true, source: slice.rows.length, migrated: 0 });
              grandTotalExcluded += slice.rows.length;
              continue;
            }
            const result = await migrateTableSlice(tgtClient, sourceDb, table, projectId, slice.rows, columnMap, taskIdMap, console.log);
            perSliceReport.push({
              sourceDb, table, projectId, excluded: false,
              source: result.sourceCount, migrated: result.migrated,
              alreadyMigrated: result.alreadyMigrated, skipped: result.skipped,
              danglingTaskIds: result.danglingTaskIds,
            });
            grandTotalMigrated += result.migrated + result.alreadyMigrated;
            grandTotalSource += result.sourceCount;
            if (table === 'tasks') {
              // Build this sourceDb's old-id -> new-id map from lineage, for
              // findings/research (which come later in TABLE_ORDER) to consume.
              const { rows: lineageRows } = await tgtClient.query(
                `SELECT source_row_id, target_row_id FROM pipeline_migration_row_ids
                  WHERE source_db=$1 AND source_table='tasks' AND project_id=$2`,
                [sourceDb, projectId]
              );
              for (const l of lineageRows) taskIdMap.set(l.source_row_id, l.target_row_id);
            }
          }
        }
      } finally {
        await srcClient.end();
      }
    }

    if (precheckFailures.length > 0) {
      console.error(`Refused (column-shape precondition, point 2 of the header comment): ${precheckFailures.length} table(s) have live data this script cannot safely map:`);
      for (const f of precheckFailures) console.error(`  - ${f}`);
      console.error('Nothing further was processed for these tables this run. Extend COLUMN_MAPS/migrate-04-seam-ddl-addenda.sql before re-running.');
    }

    // ── Report ──────────────────────────────────────────────────────────
    console.log('Per-slice report:');
    let reconciliationFailures = 0;
    for (const s of perSliceReport) {
      if (s.excluded) {
        console.log(`  - ${s.sourceDb}.${s.table} / project_id="${s.projectId}" [EXCLUDED]: source=${s.source} migrated=0`);
        continue;
      }
      const ok = s.migrated + s.alreadyMigrated === s.source;
      if (!ok) reconciliationFailures++;
      console.log(`  - ${s.sourceDb}.${s.table} / project_id="${s.projectId}": source=${s.source} migrated=${s.migrated} already-migrated=${s.alreadyMigrated} skipped=${s.skipped} ${ok ? 'RECONCILED' : '[RECONCILIATION-FAIL]'}`);
      if (s.danglingTaskIds && s.danglingTaskIds.length) {
        console.log(`      dangling-pre-existing task_id on ${s.danglingTaskIds.length} row(s): ${s.danglingTaskIds.join(', ')}`);
      }
    }
    console.log(`  TOTAL: source=${grandTotalSource}, migrated-or-already-migrated=${grandTotalMigrated}, excluded=${grandTotalExcluded}`);

    const pass = precheckFailures.length === 0 && reconciliationFailures === 0;
    console.log(`MIGRATION_RESULT: ${pass ? 'PASS' : 'FAIL'} (reconciliation_failures=${reconciliationFailures}, precheck_failures=${precheckFailures.length})`);
    exitCode = pass ? 0 : 1;
  } finally {
    await tgtClient.end();
  }
  process.exitCode = exitCode;
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
  loadDbTriage,
  classifyDb,
  DB_TRIAGE_VALID_CLASSES,
  loadPipelineDbProjectMap,
  deriveDbLevelProjectId,
  loadClaudeContextTopicRules,
  classifyClaudeContextTopic,
  sourceSelect,
  getLiveSourceColumns,
  checkColumnShapePrecondition,
  timestampForFilename,
  backupTable,
  getLineageEntry,
  recordLineage,
  computeContentFingerprint,
  writeManifestSlice,
  classifyTaskId,
  buildInsertPayload,
  insertGenericRow,
  insertFindingsRow,
  insertResearchRow,
  insertDecisionRow,
  migrateTableSlice,
  writeExcludedSlice,
  runRollback,
  COLUMN_MAPS,
  GENERIC_IGNORED_SOURCE_COLS,
  SOURCE_ID_COL,
  sourceIdCol,
  TABLE_ORDER,
  HAS_AUTHORING_MODE_TABLES,
  NO_AUTHORING_MODE_TABLES,
  SOURCE_MODEL_TAG,
  AUTHORING_MODE_TAG,
  CLAUDE_CONTEXT_DB,
  POLICY_FRAMEWORK_DB,
  FINDINGS_TARGET_ROW_ID_SENTINEL,
  SQL_ADDENDA_FILE,
  DB_TRIAGE_PATH,
  PIPELINE_DB_MAP_PATH,
  CLAUDE_CONTEXT_RULES_PATH,
  BACKUP_DIR,
};
