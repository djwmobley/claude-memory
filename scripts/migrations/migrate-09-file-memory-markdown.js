'use strict';

/**
 * migrate-09-file-memory-markdown.js
 *
 * CONSOLIDATION-RUNBOOK.md §6.1(i): parses file-memory MEMORY.md index +
 * topic files, STRUCTURALLY (distinct from step (f)'s raw corpus sync,
 * migrate-05-sync-file-memory.js, which syncs each topic file's RAW BODY
 * into memory_manager.memory_entries — an unstructured corpus row proving
 * "the text survived"). This script parses the SAME filesystem source a
 * second time, proving "the STRUCTURE survived": frontmatter `type` ->
 * `entities.entity_type`, one `entities` row per topic file (keyed
 * (project_id, name), name = the filename stem ALWAYS), and one `edges`
 * row per resolved [[wiki-link]] (`edge_type='references'`). Both scripts
 * run against the same filesystem source; no ordering dependency between
 * them, though they naturally run together (§6.2 phase-order table).
 *
 * Authored against this PR's own I-1..I-15 requirements (§6.1(i)'s own
 * I-pass amendment block is ABSENT from CONSOLIDATION-RUNBOOK.md as of this
 * PR — the requirements below are the authoritative amendment source, per
 * the authoring brief; see PR body for the explicit confirmation of that
 * absence).
 *
 * WHAT THIS SCRIPT DOES (normal / MIGRATE mode):
 *   1. Resolves + validates the TARGET database exactly like migrate-01/
 *      migrate-02/migrate-13/migrate-14 (--db flag, then MIGRATE_TARGET_DB
 *      env, then memory_manager_staging; refuses anything migrate-01's
 *      classifyTarget refuses). Never reads HANDOFF_DB.
 *   2. Confirms the target already has `entities`/`edges` tables
 *      (migrate-01-canonical-db.js's job, via handoff-core-schema.sql) — a
 *      hard, up-front refusal naming that script if missing, nothing
 *      applied.
 *   3. Applies this script's OWN additive schema file,
 *      sql/migrate-09-file-memory-schema.sql: a plain (non-unique) lookup
 *      index `edges_project_from_type_to_idx` on
 *      `edges(project_id, from_entity, edge_type, to_entity)`, plus
 *      `entities.entity_type DROP NOT NULL` (required so I-8's
 *      "unmatched-type" branch can write entity_type=NULL instead of
 *      either failing or fabricating a type). Applied via migrate-01's own
 *      applySqlFile — registered the SAME way migrate-13/migrate-14
 *      register their own SQL_FILE(s): a script-owned file + a script-owned
 *      apply step, never appended to migrate-schema-addenda.js's shared
 *      SQL_FILES array (avoids any collision with a concurrent sibling PR
 *      also touching that array).
 *
 *      SUPERSESSION (I-10, field finding 2026-08-16, first real staging
 *      run): I-10 originally specified a UNIQUE index on this same 4-tuple
 *      so the edges write could be a plain `ON CONFLICT ... DO UPDATE`
 *      upsert. That UNIQUE index cannot coexist with this runbook's
 *      lossless-migration guarantee — staging's real `edges` table (phase
 *      (c)'s migrate-verify-own-graph.js output) holds 12 duplicate
 *      4-tuples faithfully migrated with their full multiplicity intact
 *      from a source graph that predates any uniqueness constraint on this
 *      tuple; deduping them to satisfy a UNIQUE index would break T3's
 *      content-hash MULTISET reconciliation against the source (which
 *      counts occurrences, not distinct values). The plain index keeps
 *      I-10's lookup-performance goal; idempotency for THIS script's own
 *      writes is now enforced in application code instead of the database
 *      schema — see `edgeAlreadyWrittenByThisScript()`/`upsertEdge()`
 *      below and the SQL file's own header comment for the full
 *      supersession writeup and the deterministic upgrade path (a target
 *      where the old UNIQUE index previously succeeded has it dropped and
 *      replaced with the plain one, so every environment converges to the
 *      same constraint shape).
 *   4. Loads scripts/migrations/file-memory-project-enrollment.json (I-1;
 *      gitignored, private instance data — see .example.json for shape),
 *      then enumerates every directory directly under --projects-root
 *      (default `~/.claude/projects`) that itself contains a `memory`
 *      subdirectory ("memory/-bearing dir") — NEVER a blind glob over
 *      `**\/*.md`. Every memory/-bearing dir is TOTAL-classified into
 *      exactly one of three named branches (classifyProjectDir): ENROLLED
 *      (dir_name matches an enrolled_dirs entry -> that project_id),
 *      TEST-ARTIFACT-EXCLUDED (dir_name matches a test_artifact_patterns
 *      regex — the eval-harness/scratch-fixture temp naming convention —
 *      loud named report line, never enrolled), or UNMATCHED-FLAGGED (the
 *      default branch — loud named report line, owner-review line-item,
 *      never silently enrolled and never silently skipped; this is also
 *      how a deliberately-withheld private project directory surfaces
 *      every run, without this script ever hardcoding that project's name
 *      — I-15).
 *   5. Per ENROLLED project dir, walks its `memory/` directory's direct
 *      children (no recursion) with file-walk boundary
 *      `path.extname(f).toLowerCase() === '.md'` (I-9 — a naive
 *      `.endsWith('.md')`/substring check would misclassify a name like
 *      `topic-file.md.bak-20260101` as a topic file; extname()'s
 *      last-dot-only boundary correctly treats its true extension as
 *      `.bak-20260101` and excludes it — this exact shape is a named
 *      fixture in the test suite), excluding `MEMORY.md` by exact name,
 *      case-insensitive (I-7).
 *   6. Per remaining topic file: `entities.name` = the filename stem
 *      ALWAYS (I-4, never the frontmatter title). Entity type resolution
 *      (I-3/I-8) checks `frontmatter.type`, THEN `frontmatter.metadata?.
 *      type` ONLY if `frontmatter.type` contributed no candidate at all;
 *      whichever field contributes the first non-empty candidate is
 *      validated against the exact 4-value enum (`user|feedback|project|
 *      reference`) — a non-empty value outside that enum (e.g. `banana`)
 *      is a TERMINAL "invalid-enum-value" result: entity_type is written
 *      NULL and a loud unmatched-type report line is logged, and
 *      resolution NEVER falls through to filename-prefix inference (an
 *      explicit-but-wrong author claim must not be silently "corrected"
 *      by a heuristic guess) nor to the other frontmatter field. Only
 *      when NEITHER field contributes any candidate does resolution fall
 *      back to filename-prefix inference (`feedback_`/`project_`/
 *      `reference_`/`user_`, in that fixed order) — a LOGGED fallback,
 *      never silent; if that also fails, entity_type is written as NULL
 *      ("unmatched-type", also logged) — the row is still written, never
 *      dropped.
 *      Description is primarily sourced from MEMORY.md's own hand-curated
 *      index line (`- [Title](stem.md) — description`) for that stem, per
 *      §6.1(i) point 3; frontmatter/title text is never used to derive it.
 *   7. Wiki-link scan (I-5/I-6): fenced code blocks (```...```) and inline
 *      code (`...`) are stripped from the body BEFORE `[[...]]` matching —
 *      the named regression case is a fenced shell snippet containing a
 *      bash `[[ -f file ]]` conditional, which would otherwise false-
 *      positive as a wiki-link. `|alias` and `#anchor` are stripped from
 *      each match before resolution. A link resolves only on an EXACT
 *      (case-sensitive) stem match among that project's OTHER processed
 *      topic files; anything else (empty target after stripping, a target
 *      naming a file that doesn't exist, a case-only mismatch) is
 *      UNRESOLVED-LOGGED — logged, never silently dropped, never a hard
 *      failure.
 *   8. Idempotent upsert (I-11/I-12): `entities` upsert column list is
 *      EXACTLY `description, entity_type, source_model, agent_id` — never
 *      `suppressed` (a column this script never touches). Precedence: if
 *      an existing row's `source_model` is neither NULL nor this script's
 *      own tag (`markdown-migration-i`), the write is ADDITIVE-ONLY — it
 *      may fill `entity_type` if currently NULL, but never touches
 *      `description`/`source_model`/`agent_id` (a live writer, e.g.
 *      `/handoff:close`, owns that row's prose; this migration never
 *      clobbers it). `edges` writes are existence-guarded, NOT an
 *      `ON CONFLICT` upsert (I-10 supersession, see step 3 above): insert
 *      a `(project_id, from_entity, edge_type, to_entity)` row only if no
 *      row with that exact 4-tuple AND `source_model='markdown-migration-
 *      i'` already exists. The guard is scoped to THIS SCRIPT'S OWN tag —
 *      a pre-existing duplicate from another writer (a live write path,
 *      or the source graph's own historical duplicates migrated by phase
 *      (c)) never blocks this script's write, and this script's own
 *      re-runs stay exactly-once regardless of how many un-tagged
 *      duplicates already share that tuple.
 *   9. Manifest rows (T1/T3-style, scoped to the DERIVED structure, not the
 *      raw text which (f) already covers): one `migration_manifest` +
 *      `migration_manifest_row_hashes` slice per (project, source_table)
 *      pair, `source_table` values `file_memory_entities` /
 *      `file_memory_edges` (matching the runbook's own §15.2 markdown-
 *      coverage note), `source_db = 'filesystem:<project's memory dir,
 *      normalized>'` via `scripts/lib/fs-path-normalize.js`'s
 *      `filesystemSourceDb()` — the ONE shared H-14/I-14 normalizer,
 *      authored by §6.1(h)'s `migrate-08-handoff-markdown.js` (merged to
 *      main first) and imported here by reference, never forked. (An
 *      earlier revision of this script shipped its own equivalent
 *      `scripts/lib/fs-source-path.js`, authored before (h) had merged;
 *      that module's own header comment anticipated exactly this
 *      collision and named its own deletion as the correct resolution —
 *      done, in the reconciliation commit on this branch.)
 *  10. Report: per-project live file/entity/edge counts, diagnostic-only
 *      comparison against the documentary ~116-file baseline (I-2 — NEVER
 *      a gate), every unmatched-type / filename-prefix-fallback /
 *      unresolved-link event named, every TEST-ARTIFACT-EXCLUDED and
 *      UNMATCHED-FLAGGED project dir named. MIGRATION_RESULT: PASS iff
 *      every processed file produced exactly one entities row and every
 *      resolved wiki-link produced exactly one edges row (verified by
 *      live re-query, not merely trusted from the write path).
 *
 * ROLLBACK MODE (--rollback, I-13): for every project dir this run's
 * enumeration classifies ENROLLED (same enumeration/classification as
 * MIGRATE mode — a standalone, replayable invocation, never a saved list
 * from some prior run), in one transaction per project: (a) DELETE FROM
 * edges WHERE source_model = 'markdown-migration-i' AND project_id = ...;
 * (b) DELETE FROM entities WHERE source_model = 'markdown-migration-i' AND
 * project_id = ... AND NOT EXISTS (SELECT 1 FROM edges WHERE project_id =
 * entities.project_id AND (from_entity = entities.name OR to_entity =
 * entities.name)) — reference-count-gated: an entity this script created
 * is left in place if ANY edge (from any writer, any edge_type) still
 * references it by name, even after this same transaction's own edges
 * delete already ran. See "Blind spots" in the PR body for what this
 * reference-count check does NOT cover (assertions.subject/object string
 * references, which carry no FK to entities at all).
 *
 * WHAT THIS SCRIPT DELIBERATELY DOES NOT DO (out of scope):
 *   - No raw-body corpus sync (step (f)'s job, migrate-05-sync-file-
 *     memory.js — already shipped, unrelated write path/table).
 *   - No embedding backfill (phase (g)'s job).
 *   - No rewrite of topic-file prose, frontmatter, or MEMORY.md itself —
 *     read-only against the filesystem source, exactly like every other
 *     markdown-sourced migration in this runbook.
 *   - No owner-review auto-routing for UNMATCHED-FLAGGED project dirs —
 *     enrollment is manual, one line per project, in the gitignored real
 *     file-memory-project-enrollment.json.
 *   - It never reads HANDOFF_DB, and it never creates the target database.
 *
 * DRY-RUN MODE (--dry-run): a read-only preview of the MIGRATE-mode plan,
 * added because this script's first real run previously doubled as its own
 * preview (every other writing migrate-NN script in this repo has a
 * --dry-run; see migrate-05-sync-file-memory.js). The target DB is opened
 * through a read-only guard (makeReadOnlyClient below) that throws on any
 * write statement (INSERT/UPDATE/DELETE/CREATE/ALTER/DROP/TRUNCATE/BEGIN/
 * COMMIT/ROLLBACK/GRANT/REVOKE) — the SQL schema file is never applied,
 * migration_manifest DDL is never applied, and no entities/edges/manifest
 * rows are written. Enrolled dirs are walked exactly as MIGRATE mode walks
 * them (same enumeration, same classification, same per-file parsing), and
 * the plan is computed by READING the target's current entities/edges rows
 * and re-deriving the exact insert/update/unchanged verdict MIGRATE mode's
 * own upsertEntity/upsertEdge precedence rules would produce — this is a
 * real comparison against live state, never skipped or stubbed (see
 * buildDryRunPlan/classifyEntityPlan/computeEntityPlanCounts/
 * computeEdgePlanCounts below). The report prints, per project_id: file
 * count; entity insert/update/unchanged counts; entity_type source
 * breakdown (frontmatter.type / frontmatter.metadata.type /
 * filename-prefix-fallback / NULL); edges that would be created vs. are
 * already present (this script's own tag); every `[[link]]` that would NOT
 * resolve (capped at 50 printed lines, total count always shown); and any
 * file skipped (e.g. unreadable) with its reason. Ends with
 * `MIGRATION_RESULT: DRY_RUN` and exit 0, or a non-zero exit with whatever
 * precheck failure (bad db name, refused target, missing prerequisite
 * table/column, bad enrollment config) would also refuse MIGRATE mode —
 * those checks run identically in both modes, before the mode branch.
 * Mutually exclusive with --rollback (rejected as a usage error).
 *
 * Usage:
 *   node scripts/migrations/migrate-09-file-memory-markdown.js [--db <target>]
 *     [--projects-root <path>] [--enrollment-config <path>] [--rollback]
 *     [--dry-run]
 *
 * Exit codes: 0 = PASS (migrate: every processed file/link accounted for;
 * rollback: completed; dry-run: plan computed, zero writes), 1 = refused /
 * precondition failure / apply failure / verification mismatch, 2 = bad
 * CLI usage.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Client } = require('pg');

const migrateOne = require('./migrate-01-canonical-db'); // reused by reference, never forked
const shared = require('./lib/verify15-shared');          // reused by reference: rowHash, applyDdl
const { filesystemSourceDb } = require('../lib/fs-path-normalize'); // reused by reference — the
                                                             // ONE shared H-14/I-14 normalizer
                                                             // (authored by the merged §6.1(h)
                                                             // migrate-08-handoff-markdown.js;
                                                             // never a second hand-rolled copy)
const { resolveBaseDir } = require('../lib/handoff-paths'); // reused by reference — single source of
                                                             // truth for the .claude base dir; honors
                                                             // HANDOFF_BASE_DIR. Never hand-roll
                                                             // os.homedir()+'.claude' locally (enforced
                                                             // repo-wide by test-host-agnostic-naming.js's
                                                             // S1 sweep).

// ─── PATHS / CONSTANTS ────────────────────────────────────────────────────

const MIGRATIONS_DIR = __dirname;
const SQL_DIR = path.join(MIGRATIONS_DIR, 'sql');
const SQL_FILE = path.join(SQL_DIR, 'migrate-09-file-memory-schema.sql');
const SQL_FILES = [SQL_FILE];

const ENROLLMENT_CONFIG_PATH = path.join(MIGRATIONS_DIR, 'file-memory-project-enrollment.json');
// Routed through handoff-paths.js's resolveBaseDir() (single source of truth
// for the .claude base dir; honors the HANDOFF_BASE_DIR override with its
// own MSYS-trap + '..'-traversal validation) — NEVER a hand-rolled
// os.homedir()+'.claude' duplicate, which would silently ignore that
// override for this script alone.
const DEFAULT_PROJECTS_ROOT = path.join(resolveBaseDir(), 'projects');

const PREREQUISITE_TABLES = ['entities', 'edges'];
// entities.source_model/agent_id + edges.source_model/agent_id are added by
// migrate-schema-addenda.js's attribution-columns.sql, NOT by migrate-01
// itself -- this script's upserts write source_model on every row, so this
// is a genuine prerequisite, checked up front alongside PREREQUISITE_TABLES
// rather than surfacing as an opaque "column does not exist" mid-run.
const PREREQUISITE_COLUMNS = [
  { table: 'entities', column: 'source_model' },
  { table: 'entities', column: 'agent_id' },
  { table: 'edges', column: 'source_model' },
  { table: 'edges', column: 'agent_id' },
];

const SOURCE_TABLE_ENTITIES = 'file_memory_entities';
const SOURCE_TABLE_EDGES = 'file_memory_edges';
const SOURCE_MODEL_TAG = 'markdown-migration-i';
const EDGE_TYPE = 'references';

// I-3/I-8: fixed check order. Also drives the I-3 filename-prefix fallback.
const FILENAME_PREFIX_TYPES = ['feedback', 'project', 'reference', 'user'];
// I-3: the exact 4-value enum a resolved frontmatter.type/metadata.type
// string must belong to. A non-empty value that does NOT match this set
// (e.g. "banana") is an explicit-but-invalid author claim, not an absent
// one -- see resolveEntityType's "invalid-enum-value" branch below.
const VALID_ENTITY_TYPES = new Set(FILENAME_PREFIX_TYPES);

// I-2: documentary ~116 baseline (§6.1(f)'s own known count). Diagnostic
// display only — NEVER read by any pass/fail branch in this script.
const DOCUMENTARY_BASELINE_TOTAL = 116;

const MEMORY_INDEX_FILENAME = 'MEMORY.md';

// ─── CLI ARGS ─────────────────────────────────────────────────────────────

class UsageError extends Error {}

function parseArgs(argv) {
  const parsed = {
    db: null,
    projectsRoot: DEFAULT_PROJECTS_ROOT,
    enrollmentConfigPath: ENROLLMENT_CONFIG_PATH,
    rollback: false,
    dryRun: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--db') parsed.db = argv[++i];
    else if (a.startsWith('--db=')) parsed.db = a.slice('--db='.length);
    else if (a === '--projects-root') parsed.projectsRoot = argv[++i];
    else if (a.startsWith('--projects-root=')) parsed.projectsRoot = a.slice('--projects-root='.length);
    else if (a === '--enrollment-config') parsed.enrollmentConfigPath = argv[++i];
    else if (a.startsWith('--enrollment-config=')) parsed.enrollmentConfigPath = a.slice('--enrollment-config='.length);
    else if (a === '--rollback') parsed.rollback = true;
    else if (a === '--dry-run') parsed.dryRun = true;
    else if (a === '--help' || a === '-h') parsed.help = true;
    else throw new UsageError(`Unknown argument: ${a}`);
  }
  return parsed;
}

function printUsage() {
  console.log([
    'Usage: node scripts/migrations/migrate-09-file-memory-markdown.js [--db <target>]',
    '         [--projects-root <path>] [--enrollment-config <path>] [--rollback]',
    '         [--dry-run]',
    '',
    '  --db <name>               Target database (else MIGRATE_TARGET_DB env, else',
    '                            memory_manager_staging). Never reads HANDOFF_DB.',
    '  --projects-root <path>    Directory to enumerate for memory/-bearing project',
    '                            dirs (default: ~/.claude/projects).',
    '  --enrollment-config <path> Path to file-memory-project-enrollment.json',
    '                            (default: alongside this script).',
    '  --rollback                Delete this script\'s tagged edges/entities instead',
    '                            of migrating (reference-count-gated, see header).',
    '  --dry-run                 Read-only plan preview: walks enrolled dirs, computes',
    '                            insert/update/unchanged counts against the target\'s',
    '                            live rows, prints unresolved [[links]] and skipped',
    '                            files. No DDL, no upserts, no manifest rows. Mutually',
    '                            exclusive with --rollback.',
  ].join('\n'));
}

// ─── ENROLLMENT CONFIG (I-1) ───────────────────────────────────────────────

function loadEnrollmentConfig(configPath) {
  if (!fs.existsSync(configPath)) {
    console.error(`FATAL: enrollment config not found at "${configPath}".`);
    console.error('This file carries private instance routing data and is gitignored, never committed.');
    console.error('See scripts/migrations/file-memory-project-enrollment.example.json for the required shape,');
    console.error('or pass --enrollment-config <path> to point at a different file.');
    process.exit(1);
  }
  let raw;
  try {
    raw = fs.readFileSync(configPath, 'utf8');
  } catch (err) {
    console.error(`FATAL: could not read enrollment config at "${configPath}": ${err.message}`);
    process.exit(1);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    console.error(`FATAL: enrollment config at "${configPath}" is not valid JSON: ${err.message}`);
    process.exit(1);
  }
  if (!Array.isArray(parsed.enrolled_dirs)) {
    console.error(`FATAL: enrollment config at "${configPath}" must carry an enrolled_dirs array (may be empty).`);
    process.exit(1);
  }
  if (!Array.isArray(parsed.test_artifact_patterns)) {
    console.error(`FATAL: enrollment config at "${configPath}" must carry a test_artifact_patterns array (may be empty).`);
    process.exit(1);
  }
  const badEntries = [];
  parsed.enrolled_dirs.forEach((e, i) => {
    if (!e || typeof e.dir_name !== 'string' || !e.dir_name) badEntries.push(`enrolled_dirs[${i}]: dir_name must be a non-empty string`);
    if (!e || typeof e.project_id !== 'string' || !e.project_id) badEntries.push(`enrolled_dirs[${i}]: project_id must be a non-empty string`);
  });
  const compiledPatterns = [];
  parsed.test_artifact_patterns.forEach((p, i) => {
    if (typeof p !== 'string' || !p) {
      badEntries.push(`test_artifact_patterns[${i}]: must be a non-empty string`);
      return;
    }
    try {
      compiledPatterns.push(new RegExp(p));
    } catch (err) {
      badEntries.push(`test_artifact_patterns[${i}] ("${p}"): invalid regex: ${err.message}`);
    }
  });
  if (badEntries.length) {
    console.error(`FATAL: enrollment config at "${configPath}" failed validation:`);
    for (const b of badEntries) console.error(`  - ${b}`);
    process.exit(1);
  }
  return { enrolledDirs: parsed.enrolled_dirs, testArtifactPatterns: compiledPatterns };
}

/**
 * I-1: total classification of one memory/-bearing project directory NAME
 * into exactly one branch. Checked in this fixed order: ENROLLED (explicit
 * intent wins) -> TEST-ARTIFACT-EXCLUDED -> UNMATCHED-FLAGGED (default).
 */
function classifyProjectDir(dirName, enrollmentConfig) {
  const enrolled = enrollmentConfig.enrolledDirs.find((e) => e.dir_name === dirName);
  if (enrolled) return { bucket: 'enrolled', projectId: enrolled.project_id };
  for (const re of enrollmentConfig.testArtifactPatterns) {
    if (re.test(dirName)) return { bucket: 'test-artifact-excluded', matchedPattern: re.source };
  }
  return { bucket: 'unmatched-flagged' };
}

/**
 * Enumerate every directory directly under `projectsRoot` that itself
 * contains a `memory` subdirectory — NEVER a blind glob over `**\/*.md`.
 * Non-memory-bearing dirs (session-scratch dirs with no memory/ subfolder)
 * are outside this script's classification domain entirely; they are not
 * a bucket in classifyProjectDir, they are simply never visited.
 */
function enumerateMemoryBearingDirs(projectsRoot) {
  if (!fs.existsSync(projectsRoot)) {
    return [];
  }
  const entries = fs.readdirSync(projectsRoot, { withFileTypes: true });
  const result = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dirPath = path.join(projectsRoot, entry.name);
    const memoryDirPath = path.join(dirPath, 'memory');
    let isMemoryDir = false;
    try {
      isMemoryDir = fs.statSync(memoryDirPath).isDirectory();
    } catch (_) { /* no memory/ subdir */ }
    if (isMemoryDir) {
      result.push({ dirName: entry.name, dirPath, memoryDirPath });
    }
  }
  return result;
}

// ─── FRONTMATTER (hand-rolled, mirrors handoff.js's readHandoffFrontmatter) ─

/**
 * Splits a topic file's leading `---\n...\n---` frontmatter block from its
 * body. Top-level scalar keys are extracted per-line; a nested `metadata:`
 * sub-block (indented key: value lines) is extracted into
 * frontmatter.metadata, mirroring handoff.js's session_summary sub-key
 * parsing. Not a general YAML parser — deliberately scoped to the exact
 * shapes real topic-file frontmatter uses (see PR body's blind-spot note).
 */
function parseFrontmatterAndBody(text) {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!match) return { frontmatter: {}, body: text };
  const fmBlock = match[1];
  const body = text.slice(match[0].length);
  const frontmatter = {};
  for (const line of fmBlock.split(/\r?\n/)) {
    const kv = line.match(/^(\w[\w-]*):\s*(.*)$/);
    if (!kv) continue;
    frontmatter[kv[1]] = stripQuotes(kv[2].trim());
  }
  const metaMatch = fmBlock.match(/^metadata:[ \t]*\r?\n((?:[ \t]+.*\r?\n?)*)/m);
  if (metaMatch) {
    const meta = {};
    for (const line of metaMatch[1].split(/\r?\n/)) {
      const kv = line.match(/^\s+(\w[\w-]*):\s*(.*)$/);
      if (kv) meta[kv[1]] = stripQuotes(kv[2].trim());
    }
    frontmatter.metadata = meta;
  }
  return { frontmatter, body };
}

function stripQuotes(v) {
  if (v.length >= 2 && ((v[0] === '"' && v[v.length - 1] === '"') || (v[0] === "'" && v[v.length - 1] === "'"))) {
    return v.slice(1, -1);
  }
  return v;
}

/**
 * I-3/I-8: entity_type resolution, total classification over five branches.
 *
 * Order: frontmatter.type is checked first; frontmatter.metadata.type is
 * checked ONLY when frontmatter.type contributes no candidate at all
 * (absent, non-string, or blank after trim) — NOT as a retry when
 * frontmatter.type contributed a candidate that failed enum validation.
 * Whichever field contributes the first non-empty candidate is validated
 * against the exact 4-value enum (VALID_ENTITY_TYPES):
 *   - valid            -> that value, method names the winning field.
 *   - invalid           -> 'invalid-enum-value': entity_type NULL, logged.
 *     An explicit-but-wrong author claim is a TERMINAL result — it never
 *     falls through to filename-prefix inference (a heuristic guess must
 *     never silently "correct" a stated-but-wrong value) and never falls
 *     through to checking the other frontmatter field either (that would
 *     let a lucky valid value elsewhere mask the fact that the field the
 *     author actually set was wrong).
 *   - no candidate from either field -> filename-prefix inference (logged
 *     fallback) -> 'unmatched-type' (entity_type NULL, logged) if that
 *     also fails to match.
 */
function resolveEntityType(frontmatter, stem) {
  let candidate = null;
  let candidateMethod = null;
  if (typeof frontmatter.type === 'string' && frontmatter.type.trim()) {
    candidate = frontmatter.type.trim();
    candidateMethod = 'frontmatter.type';
  } else if (frontmatter.metadata && typeof frontmatter.metadata.type === 'string' && frontmatter.metadata.type.trim()) {
    candidate = frontmatter.metadata.type.trim();
    candidateMethod = 'frontmatter.metadata.type';
  }

  if (candidate !== null) {
    if (VALID_ENTITY_TYPES.has(candidate)) {
      return { entityType: candidate, method: candidateMethod };
    }
    return { entityType: null, method: 'invalid-enum-value', invalidValue: candidate, invalidSource: candidateMethod };
  }

  for (const prefix of FILENAME_PREFIX_TYPES) {
    if (stem.startsWith(`${prefix}_`)) {
      return { entityType: prefix, method: 'filename-prefix-fallback' };
    }
  }
  return { entityType: null, method: 'unmatched-type' };
}

// ─── WIKI-LINK SCANNING (I-5/I-6) ──────────────────────────────────────────

/** I-5: strip fenced code blocks, then inline code, BEFORE [[ ]] matching. */
function stripCodeForLinkScan(body) {
  let s = body.replace(/```[\s\S]*?```/g, '');
  s = s.replace(/`[^`\n]*`/g, '');
  return s;
}

const WIKI_LINK_RE = /\[\[([^[\]]*)\]\]/g;

/**
 * I-6: strip `|alias` and `#anchor` before resolution. Returns one entry
 * per [[...]] match found in the CODE-STRIPPED text, each total-classified
 * malformed (empty target after stripping) or not — resolution against
 * known stems happens separately in the caller (total classification:
 * resolved vs unresolved-logged, malformed is a subtype of the latter).
 */
function extractWikiLinks(body) {
  const scanText = stripCodeForLinkScan(body);
  const links = [];
  let m;
  WIKI_LINK_RE.lastIndex = 0;
  while ((m = WIKI_LINK_RE.exec(scanText))) {
    let target = m[1];
    let alias = null;
    const pipeIdx = target.indexOf('|');
    if (pipeIdx !== -1) {
      alias = target.slice(pipeIdx + 1).trim();
      target = target.slice(0, pipeIdx);
    }
    let anchor = null;
    const hashIdx = target.indexOf('#');
    if (hashIdx !== -1) {
      anchor = target.slice(hashIdx + 1).trim();
      target = target.slice(0, hashIdx);
    }
    target = target.trim();
    links.push({ raw: m[1], target, alias, anchor, malformed: target.length === 0 });
  }
  return links;
}

// ─── MEMORY.md INDEX PARSING (§6.1(i) point 3) ────────────────────────────

const MEMORY_INDEX_LINE_RE = /^-\s*\[([^\]]*)\]\(([^)]+)\)\s*[—\-–]\s*(.*)$/;

function parseMemoryIndex(text) {
  const descByStem = new Map();
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(MEMORY_INDEX_LINE_RE);
    if (!m) continue;
    const linkPath = m[2].trim();
    const desc = m[3].trim();
    const stem = path.basename(linkPath, path.extname(linkPath));
    if (stem) descByStem.set(stem, desc);
  }
  return descByStem;
}

// ─── CONTENT FINGERPRINT (T1 convention, generalized cols) ─────────────────

function computeContentFingerprint(cols, orderedRows) {
  const concatenated = orderedRows.map((r) => shared.rowHash(cols, r)).join('');
  return crypto.createHash('md5').update(concatenated).digest('hex');
}

// ─── PER-FILE PROCESSING ──────────────────────────────────────────────────

/**
 * I-9: file-walk boundary. `path.extname()` is a strict last-dot boundary
 * check (never a substring/`.endsWith('.md')` check) — a sibling file named
 * `topic-file.md.bak-20260101` has extname `.bak-20260101`, not `.md`, and
 * is correctly excluded by this check alone.
 */
function listTopicFiles(memoryDirPath) {
  const entries = fs.readdirSync(memoryDirPath, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (path.extname(entry.name).toLowerCase() !== '.md') continue;
    if (entry.name.toLowerCase() === MEMORY_INDEX_FILENAME.toLowerCase()) continue; // I-7
    files.push(entry.name);
  }
  return files;
}

/**
 * Parses every topic file in one enrolled project's memory/ dir, resolving
 * entity_type + description per file and every wiki-link's resolution,
 * WITHOUT touching the database — pure function over the filesystem, so it
 * is independently testable and reused by both migrate and (indirectly, via
 * re-enumeration) rollback.
 */
function parseProjectMemoryDir(memoryDirPath) {
  const fileNames = listTopicFiles(memoryDirPath);
  const stems = fileNames.map((f) => path.basename(f, path.extname(f)));
  const stemSet = new Set(stems);

  let memoryIndex = new Map();
  const memoryIndexPath = path.join(memoryDirPath, MEMORY_INDEX_FILENAME);
  if (fs.existsSync(memoryIndexPath)) {
    memoryIndex = parseMemoryIndex(fs.readFileSync(memoryIndexPath, 'utf8'));
  }

  const entities = [];
  const edgesByKey = new Map(); // dedupe within one file's own repeated links
  const events = []; // { kind, ...detail } — logged, non-fatal diagnostics

  for (const fileName of fileNames) {
    const stem = path.basename(fileName, path.extname(fileName));
    const filePath = path.join(memoryDirPath, fileName);
    const text = fs.readFileSync(filePath, 'utf8');
    const { frontmatter, body } = parseFrontmatterAndBody(text);

    const resolved = resolveEntityType(frontmatter, stem);
    const { entityType, method } = resolved;
    if (method === 'filename-prefix-fallback') {
      events.push({ kind: 'filename-prefix-fallback', stem, entityType });
    } else if (method === 'invalid-enum-value') {
      // I-3: frontmatter present-but-invalid -- reported as its own named
      // reason under the SAME 'unmatched-type' report kind (loud
      // unmatched-type report line), never silently accepted verbatim and
      // never masked by falling through to prefix inference.
      events.push({ kind: 'unmatched-type', stem, reason: 'invalid-enum-value', invalidValue: resolved.invalidValue, invalidSource: resolved.invalidSource });
    } else if (method === 'unmatched-type') {
      events.push({ kind: 'unmatched-type', stem, reason: 'no-frontmatter-type-no-prefix-match' });
    }

    let description = null;
    if (memoryIndex.has(stem)) {
      description = memoryIndex.get(stem);
    } else {
      events.push({ kind: 'no-memory-index-entry', stem });
    }

    entities.push({ name: stem, entityType, description });

    const links = extractWikiLinks(body);
    for (const link of links) {
      if (link.malformed) {
        events.push({ kind: 'unresolved-link', fromStem: stem, raw: link.raw, reason: 'malformed-empty-target' });
        continue;
      }
      if (link.target === stem) {
        // Self-link: not a structural edge to another entity; logged, not written.
        events.push({ kind: 'unresolved-link', fromStem: stem, raw: link.raw, reason: 'self-link' });
        continue;
      }
      if (!stemSet.has(link.target)) {
        events.push({ kind: 'unresolved-link', fromStem: stem, raw: link.raw, reason: 'not-found', target: link.target });
        continue;
      }
      const key = `${stem}::${EDGE_TYPE}::${link.target}`;
      edgesByKey.set(key, { fromEntity: stem, edgeType: EDGE_TYPE, toEntity: link.target });
    }
  }

  return { entities, edges: [...edgesByKey.values()], events, fileCount: fileNames.length };
}

// ─── DRY-RUN PLAN (read-only — no writes reach the target) ─────────────────

// Write-statement gate: the ONE choke point every dry-run DB call passes
// through. TOTAL classification via an ALLOW rule, not a denylist: a
// statement is permitted only if, after stripping leading whitespace and
// leading comments, it (1) starts with SELECT, SHOW, EXPLAIN, or VALUES;
// (2) contains no `INTO` clause outside a string literal (blocks
// `SELECT ... INTO`, a write hiding in a read-shaped statement); and (3) is
// a single statement — no `;` outside a string literal, which would let an
// unchecked second statement ride along after the first. Every other shape
// — WITH (may wrap a data-modifying CTE, e.g. `WITH x AS (INSERT ...)
// SELECT ...`), COPY, DO, CALL, INSERT/UPDATE/DELETE/DDL/transaction
// control, a leading-comment-then-write, an empty string, or anything
// unrecognized — falls through to the same default-refused branch. Nothing
// here is a name this gate has to specifically recognize in order to
// block it; failure/unknown IS the refused branch.
const READ_ONLY_LEADING_KEYWORD_RE = /^(SELECT|SHOW|EXPLAIN|VALUES)\b/i;

/**
 * Strips leading whitespace and leading line (`--`) or block (`/`+`*` ...
 * `*`+`/`) comments, repeatedly, so a comment-then-keyword shape (e.g.
 * `-- hi\nINSERT ...`) can't hide a write behind a leading comment and slip
 * past the leading-keyword check below.
 */
function stripLeadingWhitespaceAndComments(sql) {
  let s = String(sql);
  for (;;) {
    const stripped = s.replace(/^\s+/, '');
    if (stripped !== s) { s = stripped; continue; }
    if (s.startsWith('--')) {
      const nl = s.indexOf('\n');
      s = nl === -1 ? '' : s.slice(nl + 1);
      continue;
    }
    if (s.startsWith('/*')) {
      const end = s.indexOf('*/');
      s = end === -1 ? '' : s.slice(end + 2);
      continue;
    }
    return s;
  }
}

/**
 * Blanks out the CONTENTS of single-quoted string literals (SQL's `''`
 * escaped-quote convention honored) so the `;`/`INTO` checks below never
 * false-trip on those two substrings when they legitimately appear inside
 * a quoted value rather than as real SQL syntax.
 */
function blankStringLiterals(sql) {
  const s = String(sql);
  let out = '';
  let i = 0;
  while (i < s.length) {
    if (s[i] === "'") {
      out += ' ';
      i++;
      while (i < s.length) {
        if (s[i] === "'" && s[i + 1] === "'") { out += '  '; i += 2; continue; }
        if (s[i] === "'") { out += ' '; i++; break; }
        out += ' ';
        i++;
      }
      continue;
    }
    out += s[i];
    i++;
  }
  return out;
}

/** The gate's total classification, exposed standalone so it is directly testable. */
function isReadOnlyStatement(sql) {
  const body = stripLeadingWhitespaceAndComments(sql);
  if (!READ_ONLY_LEADING_KEYWORD_RE.test(body)) return false; // default branch: refused
  const withoutLiterals = blankStringLiterals(body);
  if (/;/.test(withoutLiterals)) return false; // must be a single statement
  if (/\bINTO\b/i.test(withoutLiterals)) return false; // SELECT ... INTO writes a new table
  return true;
}

function assertReadOnlyStatement(sql) {
  if (!isReadOnlyStatement(sql)) {
    throw new Error(`INTERNAL: --dry-run attempted a non-read-only statement (only a single bare SELECT/SHOW/EXPLAIN/VALUES statement, with no INTO clause, is ever allowed) — refused: ${String(sql).trim().slice(0, 160)}`);
  }
}

/**
 * Wraps a pg Client so every `.query()` call is checked by
 * assertReadOnlyStatement() before reaching the real client — the read-only
 * guarantee for --dry-run (I: "opens the DB read-only"). Used for EVERY
 * client.query() call made while parsed.dryRun is true, including the
 * prerequisite-table/column checks (SELECT-only, so unaffected) — there is
 * no code path in dry-run mode that talks to the DB through the unwrapped
 * client. Deliberately a thin object, not a Proxy, so a test can pass a
 * bare mock ({ query: (sql) => {...} }) and assert on exactly what reached
 * it.
 */
function makeReadOnlyClient(client) {
  return {
    query: (textOrConfig, values) => {
      const sql = typeof textOrConfig === 'string' ? textOrConfig : (textOrConfig && textOrConfig.text) || '';
      assertReadOnlyStatement(sql);
      return client.query(textOrConfig, values);
    },
  };
}

/**
 * Read-only counterpart to parseProjectMemoryDir: same per-file parsing
 * (frontmatter, entity-type resolution, wiki-link scan) but with per-file
 * read errors caught and reported as a named skip instead of throwing and
 * aborting the whole plan. Kept as its own function (rather than adding a
 * try/catch to parseProjectMemoryDir, which MIGRATE mode and migrate-05
 * both call by reference and whose exact throw-on-unreadable-file behavior
 * is unchanged here) — see PR body blind-spots for the duplication this
 * implies.
 */
function buildDryRunPlan(memoryDirPath) {
  const fileNames = listTopicFiles(memoryDirPath);
  const skippedFiles = [];
  const readableFiles = [];
  const textByFile = new Map();
  for (const fileName of fileNames) {
    try {
      textByFile.set(fileName, fs.readFileSync(path.join(memoryDirPath, fileName), 'utf8'));
      readableFiles.push(fileName);
    } catch (err) {
      skippedFiles.push({ fileName, reason: err.message });
    }
  }
  const stemSet = new Set(readableFiles.map((f) => path.basename(f, path.extname(f))));

  let memoryIndex = new Map();
  const memoryIndexPath = path.join(memoryDirPath, MEMORY_INDEX_FILENAME);
  if (fs.existsSync(memoryIndexPath)) {
    try {
      memoryIndex = parseMemoryIndex(fs.readFileSync(memoryIndexPath, 'utf8'));
    } catch (err) {
      skippedFiles.push({ fileName: MEMORY_INDEX_FILENAME, reason: err.message });
    }
  }

  const entities = [];
  const edgesByKey = new Map();
  const events = [];

  for (const fileName of readableFiles) {
    const stem = path.basename(fileName, path.extname(fileName));
    const { frontmatter, body } = parseFrontmatterAndBody(textByFile.get(fileName));

    const resolved = resolveEntityType(frontmatter, stem);
    const { entityType, method } = resolved;
    if (method === 'filename-prefix-fallback') {
      events.push({ kind: 'filename-prefix-fallback', stem, entityType });
    } else if (method === 'invalid-enum-value') {
      events.push({ kind: 'unmatched-type', stem, reason: 'invalid-enum-value', invalidValue: resolved.invalidValue, invalidSource: resolved.invalidSource });
    } else if (method === 'unmatched-type') {
      events.push({ kind: 'unmatched-type', stem, reason: 'no-frontmatter-type-no-prefix-match' });
    }

    let description = null;
    if (memoryIndex.has(stem)) {
      description = memoryIndex.get(stem);
    } else {
      events.push({ kind: 'no-memory-index-entry', stem });
    }

    entities.push({ name: stem, entityType, method, description });

    const links = extractWikiLinks(body);
    for (const link of links) {
      if (link.malformed) {
        events.push({ kind: 'unresolved-link', fromStem: stem, raw: link.raw, reason: 'malformed-empty-target' });
        continue;
      }
      if (link.target === stem) {
        events.push({ kind: 'unresolved-link', fromStem: stem, raw: link.raw, reason: 'self-link' });
        continue;
      }
      if (!stemSet.has(link.target)) {
        events.push({ kind: 'unresolved-link', fromStem: stem, raw: link.raw, reason: 'not-found', target: link.target });
        continue;
      }
      const key = `${stem}::${EDGE_TYPE}::${link.target}`;
      edgesByKey.set(key, { fromEntity: stem, edgeType: EDGE_TYPE, toEntity: link.target });
    }
  }

  return { entities, edges: [...edgesByKey.values()], events, fileCount: readableFiles.length, skippedFiles };
}

/**
 * Re-derives, WITHOUT writing, the exact verdict upsertEntity()'s CASE
 * expressions would produce for one entity against its current DB row (or
 * absence of one): 'insert' (no existing row), 'update' (a write would
 * change entity_type/description/source_model under this script's own
 * precedence — see upsertEntity's header comment), or 'unchanged'.
 */
function classifyEntityPlan(existingRow, entity) {
  if (!existingRow) return 'insert';
  const ownedByUs = existingRow.source_model === null || existingRow.source_model === SOURCE_MODEL_TAG;
  if (ownedByUs) {
    const changed = existingRow.entity_type !== entity.entityType
      || existingRow.description !== entity.description
      || existingRow.source_model !== SOURCE_MODEL_TAG;
    return changed ? 'update' : 'unchanged';
  }
  // I-12 additive-only precedence: a foreign-owned row can only ever gain a
  // currently-NULL entity_type from this script; description/source_model
  // are never candidates for change under this branch.
  const changed = existingRow.entity_type === null && entity.entityType !== null;
  return changed ? 'update' : 'unchanged';
}

/**
 * I-1 allows MANY enrolled dir_names to share ONE project_id. MIGRATE mode
 * processes enrolledProjects SEQUENTIALLY, one dir per transaction,
 * committed before the next dir is even parsed — so if dir A and dir B
 * share a project_id and both contain a topic file with the same stem, by
 * the time dir B's upsert runs, dir A's row already exists live: dir B's
 * write is an update/unchanged, never a second insert. A dry-run that
 * queries the pre-run DB state independently per dir would see NO existing
 * row for either A's or B's copy of that stem and report TWO inserts —
 * double-counting a single real row. This overlay carries every dry-run
 * tentative write forward across the per-project loop, keyed EXACTLY like
 * the real upsert identity, so a later dir sees the earlier dir's tentative
 * result instead of the stale pre-run DB snapshot.
 */
function makeDryRunOverlay() {
  return {
    entities: new Map(), // `${projectId}::${name}` -> { entity_type, description, source_model }
    edges: new Set(),    // `${projectId}::${fromEntity}::${edgeType}::${toEntity}` (this script's own tag only)
  };
}

function overlayEntityKey(projectId, name) { return `${projectId}::${name}`; }
function overlayEdgeKey(projectId, edge) { return `${projectId}::${edge.fromEntity}::${edge.edgeType}::${edge.toEntity}`; }

/**
 * Mirrors upsertEntity()'s CASE-expression precedence, WITHOUT writing:
 * returns the row shape the overlay should hold AFTER this tentative write
 * — exactly the row a later dir sharing this project_id would find live if
 * MIGRATE mode had actually run dir A's transaction first.
 */
function simulateEntityWrite(existingRow, entity) {
  if (!existingRow) {
    return { entity_type: entity.entityType, description: entity.description, source_model: SOURCE_MODEL_TAG };
  }
  const ownedByUs = existingRow.source_model === null || existingRow.source_model === SOURCE_MODEL_TAG;
  if (ownedByUs) {
    return { entity_type: entity.entityType, description: entity.description, source_model: SOURCE_MODEL_TAG };
  }
  // I-12 additive-only precedence: a foreign-owned row only ever gains a
  // currently-NULL entity_type; description/source_model never change.
  return {
    entity_type: existingRow.entity_type === null ? entity.entityType : existingRow.entity_type,
    description: existingRow.description,
    source_model: existingRow.source_model,
  };
}

/**
 * Batched read-only lookup + classification for one project's entity list.
 * `overlay`, when supplied, takes precedence over the DB-queried row for a
 * given (project_id, name) — it reflects a tentative write already
 * simulated earlier in THIS dry-run's own per-project loop, which the live
 * DB does not (and, being --dry-run, never will) reflect. Every classified
 * entity's resulting row is folded back into the overlay before returning,
 * so the NEXT project dir processed (same loop, possibly sharing this
 * project_id) sees it.
 */
async function computeEntityPlanCounts(dbClient, projectId, entities, overlay) {
  const names = entities.map((e) => e.name);
  let existingByName = new Map();
  if (names.length) {
    const { rows } = await dbClient.query(
      `SELECT name, entity_type, description, source_model FROM entities WHERE project_id=$1 AND name = ANY($2::text[])`,
      [projectId, names]
    );
    existingByName = new Map(rows.map((r) => [r.name, r]));
  }
  const counts = { insert: 0, update: 0, unchanged: 0 };
  for (const e of entities) {
    const key = overlayEntityKey(projectId, e.name);
    const existing = (overlay && overlay.entities.has(key)) ? overlay.entities.get(key) : (existingByName.get(e.name) || null);
    counts[classifyEntityPlan(existing, e)]++;
    if (overlay) overlay.entities.set(key, simulateEntityWrite(existing, e));
  }
  return { counts };
}

/**
 * Batched read-only lookup for one project's resolved-edge list. An edge
 * "would be created" unless a row with this exact tuple ALREADY carries
 * this script's own source_model tag (the same existence guard
 * edgeAlreadyWrittenByThisScript() checks at write time — edges have no
 * "update" verdict, only insert-or-already-present). `overlay`, when
 * supplied, is checked ALONGSIDE the DB-queried set (an edge already
 * tentatively created earlier in this same dry-run run, for a project_id
 * shared across enrolled dirs, must report unchanged here too) and is
 * updated with every edge this call classifies as "would create", so a
 * later dir sharing this project_id sees it.
 */
async function computeEdgePlanCounts(dbClient, projectId, edges, overlay) {
  let existingSet = new Set();
  if (edges.length) {
    const { rows } = await dbClient.query(
      `SELECT from_entity, to_entity FROM edges WHERE project_id=$1 AND edge_type=$2 AND source_model=$3`,
      [projectId, EDGE_TYPE, SOURCE_MODEL_TAG]
    );
    existingSet = new Set(rows.map((r) => `${r.from_entity}::${r.to_entity}`));
  }
  const counts = { wouldCreate: 0, unchanged: 0 };
  for (const edge of edges) {
    const dbKey = `${edge.fromEntity}::${edge.toEntity}`;
    const overlayKey = overlayEdgeKey(projectId, edge);
    const alreadyExists = (overlay && overlay.edges.has(overlayKey)) || existingSet.has(dbKey);
    if (alreadyExists) counts.unchanged++;
    else counts.wouldCreate++;
    if (overlay) overlay.edges.add(overlayKey);
  }
  return { counts };
}

/**
 * Reports (never fails) every project_id claimed by more than one enrolled
 * dir_name. This is a legitimate enrollment shape (I-1 allows many
 * dir_names -> one project_id) — but the dry-run plan for it is only
 * correct BECAUSE of the sequential overlay above; surfaced loudly in the
 * plan header so an operator can see which project_ids are affected,
 * rather than reconstructing it from the counts alone.
 */
function findDuplicateEnrolledProjectIds(enrolledProjects) {
  const dirNamesByProjectId = new Map();
  for (const p of enrolledProjects) {
    if (!dirNamesByProjectId.has(p.projectId)) dirNamesByProjectId.set(p.projectId, []);
    dirNamesByProjectId.get(p.projectId).push(p.dirName);
  }
  const duplicates = [];
  for (const [projectId, dirNames] of dirNamesByProjectId) {
    if (dirNames.length > 1) duplicates.push({ projectId, dirNames });
  }
  return duplicates;
}

// ─── DB WRITES ──────────────────────────────────────────────────────────────

/**
 * I-11/I-12: single-statement UPSERT with precedence baked into CASE
 * expressions (avoids a separate SELECT-then-branch race). Upsert column
 * list is EXACTLY description/entity_type/source_model/agent_id.
 */
async function upsertEntity(client, projectId, entity) {
  await client.query(
    `INSERT INTO entities (project_id, name, entity_type, description, source_model, agent_id)
     VALUES ($1,$2,$3,$4,$5,NULL)
     ON CONFLICT (project_id, name) DO UPDATE SET
       entity_type = CASE
         WHEN entities.source_model IS NULL OR entities.source_model = $5 THEN EXCLUDED.entity_type
         ELSE COALESCE(entities.entity_type, EXCLUDED.entity_type)
       END,
       description = CASE
         WHEN entities.source_model IS NULL OR entities.source_model = $5 THEN EXCLUDED.description
         ELSE entities.description
       END,
       source_model = CASE
         WHEN entities.source_model IS NULL OR entities.source_model = $5 THEN EXCLUDED.source_model
         ELSE entities.source_model
       END`,
    [projectId, entity.name, entity.entityType, entity.description, SOURCE_MODEL_TAG]
  );
}

/**
 * I-10 supersession (field finding 2026-08-16): the original mechanism was
 * a UNIQUE index on (project_id, from_entity, edge_type, to_entity) plus a
 * plain `ON CONFLICT ... DO UPDATE` upsert. That UNIQUE index cannot
 * coexist with this runbook's lossless-migration guarantee — the real
 * `edges` table can legitimately carry duplicate 4-tuples migrated with
 * their full multiplicity from a source graph that predates any
 * uniqueness constraint (see sql/migrate-09-file-memory-schema.sql's
 * header comment for the full writeup). Returns true if a row with this
 * exact 4-tuple, tagged THIS SCRIPT'S OWN source_model, already exists —
 * scoped to the tag specifically so a pre-existing duplicate written by
 * ANY OTHER writer (a live write path, or the source graph's own
 * historical duplicates) is invisible to this check and never blocks this
 * script's write.
 */
async function edgeAlreadyWrittenByThisScript(client, projectId, edge) {
  const { rows } = await client.query(
    `SELECT 1 FROM edges
     WHERE project_id=$1 AND from_entity=$2 AND edge_type=$3 AND to_entity=$4 AND source_model=$5
     LIMIT 1`,
    [projectId, edge.fromEntity, edge.edgeType, edge.toEntity, SOURCE_MODEL_TAG]
  );
  return rows.length > 0;
}

/**
 * Existence-guarded insert, NOT an `ON CONFLICT` upsert (I-10 supersession
 * — see edgeAlreadyWrittenByThisScript() above). Within a single run this
 * is race-free: processProject() wraps one project's whole file/edge batch
 * in ONE transaction on ONE client, so the guard SELECT and the INSERT
 * below execute sequentially against the same session with no interleaved
 * writer. This does NOT protect against two SEPARATE, concurrently-running
 * invocations of this script racing the SAME (project, edge) tuple — that
 * is out of scope for an operator-run migration script (same posture as
 * every other migrate-*.js in this repo; see PR body's blind-spot note).
 */
async function upsertEdge(client, projectId, edge) {
  const alreadyWritten = await edgeAlreadyWrittenByThisScript(client, projectId, edge);
  if (alreadyWritten) return { inserted: false };
  await client.query(
    `INSERT INTO edges (project_id, from_entity, edge_type, to_entity, source_model, agent_id)
     VALUES ($1,$2,$3,$4,$5,NULL)`,
    [projectId, edge.fromEntity, edge.edgeType, edge.toEntity, SOURCE_MODEL_TAG]
  );
  return { inserted: true };
}

/** Delete-and-reinsert one (source_table, project) manifest slice, in the caller's transaction. */
async function writeManifestSlice(client, sourceDb, sourceTable, projectId, cols, orderedRows, rowIdOf) {
  await client.query(
    `DELETE FROM migration_manifest WHERE source_db=$1 AND source_table=$2 AND project_id_or_null=$3`,
    [sourceDb, sourceTable, projectId]
  );
  await client.query(
    `DELETE FROM migration_manifest_row_hashes WHERE source_db=$1 AND source_table=$2 AND project_id_or_null=$3`,
    [sourceDb, sourceTable, projectId]
  );
  const fingerprint = computeContentFingerprint(cols, orderedRows);
  await client.query(
    `INSERT INTO migration_manifest (source_db, source_table, project_id_or_null, row_count, content_fingerprint, excluded_reason)
     VALUES ($1,$2,$3,$4,$5,NULL)`,
    [sourceDb, sourceTable, projectId, orderedRows.length, fingerprint]
  );
  for (const row of orderedRows) {
    const h = shared.rowHash(cols, row);
    await client.query(
      `INSERT INTO migration_manifest_row_hashes (source_db, source_table, project_id_or_null, source_row_id, source_hash)
       VALUES ($1,$2,$3,$4,$5)`,
      [sourceDb, sourceTable, projectId, rowIdOf(row), h]
    );
  }
}

/**
 * Processes ONE enrolled project dir end-to-end in ONE transaction: parses
 * its memory/ dir, upserts every entity + resolved edge, writes both
 * manifest slices. Returns counts for the report + verification gate.
 */
async function processProject(client, projectId, memoryDirPath) {
  const parsed = parseProjectMemoryDir(memoryDirPath);
  const sourceDb = filesystemSourceDb(memoryDirPath);

  await client.query('BEGIN');
  try {
    for (const entity of parsed.entities) {
      await upsertEntity(client, projectId, entity);
    }
    for (const edge of parsed.edges) {
      await upsertEdge(client, projectId, edge);
    }

    const entitiesOrdered = [...parsed.entities].sort((a, b) => a.name.localeCompare(b.name));
    await writeManifestSlice(
      client, sourceDb, SOURCE_TABLE_ENTITIES, projectId,
      ['entity_type'], entitiesOrdered, (r) => r.name
    );

    const edgesOrdered = [...parsed.edges].sort((a, b) =>
      `${a.fromEntity}::${a.toEntity}`.localeCompare(`${b.fromEntity}::${b.toEntity}`));
    await writeManifestSlice(
      client, sourceDb, SOURCE_TABLE_EDGES, projectId,
      ['fromEntity', 'edgeType', 'toEntity'], edgesOrdered,
      (r) => `${r.fromEntity}::${r.edgeType}::${r.toEntity}`
    );

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  }

  return { events: parsed.events, entityCount: parsed.entities.length, edgeCount: parsed.edges.length, fileCount: parsed.fileCount };
}

/**
 * I-13: reference-count-gated rollback for ONE project. Edges tagged this
 * script's own source_model are deleted unconditionally. An entity tagged
 * this script's own source_model is deleted ONLY if no edge (any writer,
 * any edge_type, checked AFTER this same transaction's own edges delete
 * already ran) still names it as from_entity or to_entity — see the
 * header's "Blind spots" note for what this reference check does not (and
 * structurally cannot) cover.
 */
async function rollbackProject(client, projectId) {
  await client.query('BEGIN');
  let deletedEdges = 0;
  let deletedEntities = 0;
  try {
    const delEdges = await client.query(
      `DELETE FROM edges WHERE source_model = $1 AND project_id = $2`,
      [SOURCE_MODEL_TAG, projectId]
    );
    deletedEdges = delEdges.rowCount;

    const delEntities = await client.query(
      `DELETE FROM entities e
       WHERE e.source_model = $1 AND e.project_id = $2
         AND NOT EXISTS (
           SELECT 1 FROM edges g
           WHERE g.project_id = e.project_id
             AND (g.from_entity = e.name OR g.to_entity = e.name)
         )`,
      [SOURCE_MODEL_TAG, projectId]
    );
    deletedEntities = delEntities.rowCount;

    await client.query(
      `DELETE FROM migration_manifest WHERE source_table IN ($1,$2) AND project_id_or_null=$3`,
      [SOURCE_TABLE_ENTITIES, SOURCE_TABLE_EDGES, projectId]
    );
    await client.query(
      `DELETE FROM migration_manifest_row_hashes WHERE source_table IN ($1,$2) AND project_id_or_null=$3`,
      [SOURCE_TABLE_ENTITIES, SOURCE_TABLE_EDGES, projectId]
    );

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  }
  return { deletedEdges, deletedEntities };
}

// ─── VERIFICATION GATE ─────────────────────────────────────────────────────

/**
 * Re-queries the live DB (never trusts the write path alone) to confirm
 * every processed entity/edge for a project actually landed exactly once.
 */
async function verifyProject(client, projectId, parsed) {
  const problems = [];
  for (const entity of parsed.entities) {
    const { rows } = await client.query(
      `SELECT 1 FROM entities WHERE project_id=$1 AND name=$2`,
      [projectId, entity.name]
    );
    if (rows.length !== 1) problems.push(`entity name=${JSON.stringify(entity.name)} project_id=${JSON.stringify(projectId)}: expected 1 live row, found ${rows.length}`);
  }
  for (const edge of parsed.edges) {
    // I-10 supersession: scoped to THIS SCRIPT'S OWN tag, exactly like the
    // write-path guard (edgeAlreadyWrittenByThisScript). The real `edges`
    // table can legitimately carry OTHER writers' rows sharing this exact
    // 4-tuple (a live write path, or the source graph's own pre-existing
    // duplicates) -- an un-scoped count would false-positive on those,
    // exactly the failure mode this fix exists to avoid.
    const { rows } = await client.query(
      `SELECT 1 FROM edges WHERE project_id=$1 AND from_entity=$2 AND edge_type=$3 AND to_entity=$4 AND source_model=$5`,
      [projectId, edge.fromEntity, edge.edgeType, edge.toEntity, SOURCE_MODEL_TAG]
    );
    if (rows.length !== 1) problems.push(`edge ${edge.fromEntity}->${edge.toEntity} (${edge.edgeType}) project_id=${JSON.stringify(projectId)}: expected exactly 1 live row tagged source_model='${SOURCE_MODEL_TAG}', found ${rows.length}`);
  }
  return problems;
}

// ─── REPORT ─────────────────────────────────────────────────────────────────

function printEvents(projectId, events) {
  for (const ev of events) {
    if (ev.kind === 'filename-prefix-fallback') {
      console.log(`  [FALLBACK] project_id="${projectId}" stem="${ev.stem}": no frontmatter type; filename-prefix inference -> entity_type="${ev.entityType}"`);
    } else if (ev.kind === 'unmatched-type' && ev.reason === 'invalid-enum-value') {
      console.log(`  [UNMATCHED-TYPE] project_id="${projectId}" stem="${ev.stem}": ${ev.invalidSource}="${ev.invalidValue}" is not one of the 4 valid entity types (user|feedback|project|reference); entity_type written NULL (never falls through to filename-prefix inference)`);
    } else if (ev.kind === 'unmatched-type') {
      console.log(`  [UNMATCHED-TYPE] project_id="${projectId}" stem="${ev.stem}": no frontmatter type and no recognized filename prefix; entity_type written NULL`);
    } else if (ev.kind === 'no-memory-index-entry') {
      console.log(`  [DIAG] project_id="${projectId}" stem="${ev.stem}": no MEMORY.md index entry; description written NULL`);
    } else if (ev.kind === 'unresolved-link') {
      console.log(`  [UNRESOLVED-LINK] project_id="${projectId}" from="${ev.fromStem}" raw="[[${ev.raw}]]" reason="${ev.reason}"${ev.target ? ` target="${ev.target}"` : ''}`);
    }
  }
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
  if (parsed.dryRun && parsed.rollback) {
    console.error('Error: --dry-run and --rollback are mutually exclusive.');
    printUsage();
    process.exit(2);
  }

  const { name: target, source: targetSource } = migrateOne.resolveTargetDb({ db: parsed.db });
  if (!migrateOne.DB_NAME_RE.test(target)) {
    console.error(`Invalid database name "${target}" (from ${targetSource}) — must match /^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/.`);
    process.exit(1);
  }
  const classification = await migrateOne.classifyTarget({ dbName: target });
  if (!classification.allowed) {
    console.error(`Refused: ${classification.reason}`);
    console.error(`(resolved from ${targetSource} — no database connection was opened.)`);
    process.exit(1);
  }

  const enrollmentConfig = loadEnrollmentConfig(parsed.enrollmentConfigPath);

  console.log(`migrate-09-file-memory-markdown: target="${target}" (resolved from ${targetSource}) projects-root="${parsed.projectsRoot}" mode=${parsed.rollback ? 'ROLLBACK' : parsed.dryRun ? 'DRY-RUN' : 'MIGRATE'}`);

  const memoryBearingDirs = enumerateMemoryBearingDirs(parsed.projectsRoot);
  const enrolledProjects = []; // { projectId, dirName, memoryDirPath }
  let testArtifactCount = 0;
  let unmatchedCount = 0;
  for (const dir of memoryBearingDirs) {
    const cls = classifyProjectDir(dir.dirName, enrollmentConfig);
    if (cls.bucket === 'enrolled') {
      enrolledProjects.push({ projectId: cls.projectId, dirName: dir.dirName, memoryDirPath: dir.memoryDirPath });
    } else if (cls.bucket === 'test-artifact-excluded') {
      testArtifactCount++;
      console.log(`  [TEST-ARTIFACT-EXCLUDED] dir_name="${dir.dirName}" (matched pattern /${cls.matchedPattern}/) — never enrolled`);
    } else {
      unmatchedCount++;
      console.log(`  [UNMATCHED-FLAGGED] dir_name="${dir.dirName}" — memory/-bearing but not in enrolled_dirs and not a recognized test artifact; owner-review line-item, never silently enrolled or skipped`);
    }
  }
  console.log(`Enumeration: ${memoryBearingDirs.length} memory/-bearing dir(s) -> ${enrolledProjects.length} enrolled, ${testArtifactCount} test-artifact-excluded, ${unmatchedCount} unmatched-flagged`);

  const client = new Client(migrateOne.pgConfig(target));
  let exitCode = 0;
  try {
    await client.connect();
  } catch (err) {
    console.error(`Could not connect to target database "${target}": ${err.message}`);
    process.exit(1);
  }

  // I: dry-run opens the target read-only — every client.query() call made
  // while parsed.dryRun is true (including these prerequisite checks) goes
  // through the write-gated wrapper, never the raw client.
  const dbClient = parsed.dryRun ? makeReadOnlyClient(client) : client;

  try {
    const { rows: tblRows } = await dbClient.query(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = current_schema() AND table_name = ANY($1::text[]) AND table_type = 'BASE TABLE'`,
      [PREREQUISITE_TABLES]
    );
    const found = new Set(tblRows.map((r) => r.table_name));
    const missing = PREREQUISITE_TABLES.filter((t) => !found.has(t));
    if (missing.length) {
      console.error(`Refused: target "${target}" is missing table(s): ${missing.join(', ')}.`);
      console.error('Run migrate-01-canonical-db.js against this target first, then re-run this script. Nothing was applied.');
      process.exitCode = 1;
      return;
    }

    const { rows: colRows } = await dbClient.query(
      `SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = current_schema()`
    );
    const colSet = new Set(colRows.map((r) => `${r.table_name}.${r.column_name}`));
    const missingCols = PREREQUISITE_COLUMNS.filter((c) => !colSet.has(`${c.table}.${c.column}`));
    if (missingCols.length) {
      console.error(`Refused: target "${target}" is missing column(s): ${missingCols.map((c) => `${c.table}.${c.column}`).join(', ')}.`);
      console.error('Run migrate-schema-addenda.js against this target first (attribution-columns.sql), then re-run this script. Nothing was applied.');
      process.exitCode = 1;
      return;
    }

    if (parsed.dryRun) {
      console.log(`  [DRY-RUN] read-only mode: no schema DDL will be applied; no entities/edges/manifest rows will be written.`);

      const duplicateProjectIds = findDuplicateEnrolledProjectIds(enrolledProjects);
      for (const d of duplicateProjectIds) {
        console.log(`  [DUPLICATE-PROJECT-ID] project_id="${d.projectId}" claimed by ${d.dirNames.length} enrolled dirs: ${d.dirNames.map((n) => `"${n}"`).join(', ')} — processed sequentially in enrollment order; plan counts below reflect that sequential precedence, matching a real MIGRATE run`);
      }

      let totalFiles = 0;
      const entityCounts = { insert: 0, update: 0, unchanged: 0 };
      const edgeCounts = { wouldCreate: 0, unchanged: 0 };
      const typeBreakdown = { 'frontmatter.type': 0, 'frontmatter.metadata.type': 0, 'filename-prefix-fallback': 0, NULL: 0 };
      const unresolvedLinks = [];
      const skippedFiles = [];
      // Carries tentative writes across this loop's own iterations so two
      // enrolled dirs sharing one project_id are classified exactly as
      // MIGRATE mode's sequential per-project transactions would produce
      // (see makeDryRunOverlay's header comment).
      const overlay = makeDryRunOverlay();

      for (const proj of enrolledProjects) {
        const plan = buildDryRunPlan(proj.memoryDirPath);
        const entityResult = await computeEntityPlanCounts(dbClient, proj.projectId, plan.entities, overlay);
        const edgeResult = await computeEdgePlanCounts(dbClient, proj.projectId, plan.edges, overlay);

        entityCounts.insert += entityResult.counts.insert;
        entityCounts.update += entityResult.counts.update;
        entityCounts.unchanged += entityResult.counts.unchanged;
        edgeCounts.wouldCreate += edgeResult.counts.wouldCreate;
        edgeCounts.unchanged += edgeResult.counts.unchanged;
        totalFiles += plan.fileCount;

        for (const e of plan.entities) {
          if (e.method === 'frontmatter.type') typeBreakdown['frontmatter.type']++;
          else if (e.method === 'frontmatter.metadata.type') typeBreakdown['frontmatter.metadata.type']++;
          else if (e.method === 'filename-prefix-fallback') typeBreakdown['filename-prefix-fallback']++;
          else typeBreakdown.NULL++; // unmatched-type / invalid-enum-value -> NULL entity_type
        }
        for (const ev of plan.events) {
          // Parity with MIGRATE mode's own printEvents(), which reports
          // EVERY unresolved-link event regardless of reason (self-link
          // included, under its own reason="self-link" label) — dry-run
          // must not silently drop the one reason MIGRATE mode still logs.
          if (ev.kind === 'unresolved-link') {
            unresolvedLinks.push(`project_id="${proj.projectId}" from="${ev.fromStem}" raw="[[${ev.raw}]]" reason="${ev.reason}"${ev.target ? ` target="${ev.target}"` : ''}`);
          }
        }
        for (const sf of plan.skippedFiles) {
          skippedFiles.push(`project_id="${proj.projectId}" file="${sf.fileName}" reason="${sf.reason}"`);
        }

        printEvents(proj.projectId, plan.events.filter((e) => e.kind !== 'unresolved-link'));
        console.log(`  [DRY-RUN] project_id="${proj.projectId}": ${plan.fileCount} file(s) -> entities{insert=${entityResult.counts.insert} update=${entityResult.counts.update} unchanged=${entityResult.counts.unchanged}} edges{would_create=${edgeResult.counts.wouldCreate} unchanged=${edgeResult.counts.unchanged}}`);
      }

      console.log(`Plan: files=${totalFiles} entities{insert=${entityCounts.insert} update=${entityCounts.update} unchanged=${entityCounts.unchanged}} edges{would_create=${edgeCounts.wouldCreate} unchanged=${edgeCounts.unchanged}}`);
      console.log(`Plan: entity_type source breakdown: frontmatter.type=${typeBreakdown['frontmatter.type']} frontmatter.metadata.type=${typeBreakdown['frontmatter.metadata.type']} filename-prefix-fallback=${typeBreakdown['filename-prefix-fallback']} NULL=${typeBreakdown.NULL}`);

      const cappedLinks = unresolvedLinks.slice(0, 50);
      console.log(`Plan: ${unresolvedLinks.length} [[link]] target(s) would NOT resolve${unresolvedLinks.length > 50 ? ' (showing first 50)' : ''}:`);
      for (const line of cappedLinks) console.log(`  [UNRESOLVED-LINK] ${line}`);

      if (skippedFiles.length) {
        console.log(`Plan: ${skippedFiles.length} file(s) skipped:`);
        for (const line of skippedFiles) console.log(`  [SKIPPED] ${line}`);
      }

      console.log(`MIGRATION_RESULT: DRY_RUN (projects=${enrolledProjects.length}, files=${totalFiles}, entities_insert=${entityCounts.insert}, entities_update=${entityCounts.update}, entities_unchanged=${entityCounts.unchanged}, edges_would_create=${edgeCounts.wouldCreate}, edges_unchanged=${edgeCounts.unchanged}, unresolved_links=${unresolvedLinks.length}, skipped_files=${skippedFiles.length})`);
      exitCode = 0;
      return;
    }

    await migrateOne.applySqlFile(client, SQL_FILE);
    console.log(`  [OK] applied ${path.relative(path.join(MIGRATIONS_DIR, '..'), SQL_FILE)}`);

    await shared.applyDdl(client); // migration_manifest + migration_manifest_row_hashes, idempotent

    if (parsed.rollback) {
      let totalDeletedEdges = 0;
      let totalDeletedEntities = 0;
      for (const proj of enrolledProjects) {
        const r = await rollbackProject(client, proj.projectId);
        totalDeletedEdges += r.deletedEdges;
        totalDeletedEntities += r.deletedEntities;
        console.log(`  [ROLLBACK] project_id="${proj.projectId}": deleted ${r.deletedEdges} edge(s), ${r.deletedEntities} entity(ies) (reference-count-gated)`);
      }
      console.log(`ROLLBACK_RESULT: PASS (edges=${totalDeletedEdges}, entities=${totalDeletedEntities})`);
      exitCode = 0;
      return;
    }

    let totalFiles = 0;
    let totalEntities = 0;
    let totalEdges = 0;
    let allProblems = [];
    for (const proj of enrolledProjects) {
      const parsedDir = parseProjectMemoryDir(proj.memoryDirPath);
      const result = await processProject(client, proj.projectId, proj.memoryDirPath);
      printEvents(proj.projectId, result.events);
      const problems = await verifyProject(client, proj.projectId, parsedDir);
      allProblems = allProblems.concat(problems);
      totalFiles += result.fileCount;
      totalEntities += result.entityCount;
      totalEdges += result.edgeCount;
      console.log(`  [OK] project_id="${proj.projectId}": ${result.fileCount} file(s) -> ${result.entityCount} entit(y/ies), ${result.edgeCount} resolved edge(s)`);
    }

    console.log(`Report: live total files=${totalFiles} (documentary baseline, diagnostic only, never a gate: ${DOCUMENTARY_BASELINE_TOTAL})`);
    console.log(`Report: live total entities=${totalEntities}, live total edges=${totalEdges}`);

    for (const p of allProblems) console.error(`  [VERIFY-FAIL] ${p}`);
    const pass = allProblems.length === 0;
    console.log(`MIGRATION_RESULT: ${pass ? 'PASS' : 'FAIL'} (projects=${enrolledProjects.length}, files=${totalFiles}, entities=${totalEntities}, edges=${totalEdges}, verify_problems=${allProblems.length})`);
    exitCode = pass ? 0 : 1;
  } finally {
    await client.end();
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
  loadEnrollmentConfig,
  classifyProjectDir,
  enumerateMemoryBearingDirs,
  parseFrontmatterAndBody,
  resolveEntityType,
  stripCodeForLinkScan,
  extractWikiLinks,
  parseMemoryIndex,
  listTopicFiles,
  parseProjectMemoryDir,
  upsertEntity,
  upsertEdge,
  edgeAlreadyWrittenByThisScript,
  writeManifestSlice,
  processProject,
  rollbackProject,
  verifyProject,
  computeContentFingerprint,
  isReadOnlyStatement,
  assertReadOnlyStatement,
  makeReadOnlyClient,
  buildDryRunPlan,
  classifyEntityPlan,
  computeEntityPlanCounts,
  computeEdgePlanCounts,
  makeDryRunOverlay,
  simulateEntityWrite,
  findDuplicateEnrolledProjectIds,
  SQL_FILE,
  SQL_FILES,
  SOURCE_TABLE_ENTITIES,
  SOURCE_TABLE_EDGES,
  SOURCE_MODEL_TAG,
  EDGE_TYPE,
  FILENAME_PREFIX_TYPES,
  VALID_ENTITY_TYPES,
  DOCUMENTARY_BASELINE_TOTAL,
  MEMORY_INDEX_FILENAME,
  ENROLLMENT_CONFIG_PATH,
  DEFAULT_PROJECTS_ROOT,
  PREREQUISITE_TABLES,
};
