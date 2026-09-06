'use strict';

/**
 * migrate-12-feature-usage.js
 *
 * §18.3 owner decision item F (2026-09-06). One-time data migration:
 * pipeline_pipeline.feature_token_usage (7 live rows, per-feature/per-PR
 * token+cost provenance) -> the consolidation target's feature_usage table
 * (scripts/migrations/sql/migrate-12-feature-usage.sql, applied by
 * migrate-schema-addenda.js). This script does NO schema work of its own —
 * it refuses outright if the target table is absent (see PRECONDITION
 * below) rather than creating it.
 *
 * SAFE-BY-DEFAULT POSTURE (deliberately the OPPOSITE default from this
 * repo's earlier migrate-0N scripts, which default to writing and require
 * --dry-run to opt OUT of writing): this script defaults to DRY-RUN.
 * Nothing is ever written unless --write is passed explicitly. --dry-run
 * may also be passed explicitly (documents intent identically to the
 * default; refused together with --write, since that is a self-
 * contradicting request) and is REFUSED together with --rollback (a
 * rollback is inherently a write — "dry-run rollback" is not a coherent
 * combination worth silently interpreting either way).
 *
 * TARGET CLASSIFICATION: `const cls = await migrateOne.classifyTarget({ dbName: target })`
 * — classifyTarget is async and object-argument-shaped as of PR #251 (this
 * script was authored expecting exactly that landing; the call below is
 * written against the shipped contract, not a defensive dual-shape guess).
 * It always returns `{ branch, allowed, reason, connectionOpened }`, branch
 * one of `CANON`/`STAGING`/`PER_PROJECT_ENGINE`/`SOURCE_ONLY`/`UNKNOWN`.
 * This script deliberately NEVER passes a `projectId` to classifyTarget —
 * per PR #251's own contract, `PER_PROJECT_ENGINE` (a live per-project
 * engine database allowed as a target because its marker row corroborates
 * a caller-supplied `--project-id`) is structurally UNREACHABLE without
 * one, so omitting it keeps a per-project engine DB categorically out of
 * reach for this script's own `--project-id` (a same-named but SEMANTICALLY
 * UNRELATED flag — this script's row-mapping default/fallback project,
 * never a marker-probe input) rather than relying on a branch check alone
 * to catch an accidental pass-through. Accepted iff `cls.allowed === true`
 * AND `cls.branch` is `CANON` or `STAGING` — `PER_PROJECT_ENGINE` is
 * refused even on the (unreachable, given the above) chance it appeared
 * with `allowed: true`.
 *
 * SOURCE is never run through classifyTarget — pipeline_pipeline is a
 * pipeline_-prefixed database, which classifyTarget refuses BY DESIGN for
 * consolidation targets absent a corroborating `--project-id` (which this
 * script never supplies); applying that same classifier to the read-only
 * source would make every real invocation fail. --source-db is validated
 * only against migrateOne.DB_NAME_RE (a safe-identifier shape check), never
 * against classifyTarget.
 *
 * PRECONDITION (bidirectional column-shape check, mirrors migrate-04's
 * checkColumnShapePrecondition): the LIVE information_schema.columns of the
 * source table must equal EXPECTED_SOURCE_COLUMNS exactly — an unknown live
 * column (schema drift the private DDL added after this script was
 * authored) OR a missing expected column both refuse the WHOLE run before
 * any row is read; a declared-type mismatch on any expected column also
 * refuses. The target feature_usage table's presence is checked
 * separately, before this. Both checks run before any row-level work in
 * every non-rollback invocation, including --dry-run.
 *
 * PROJECT MAPPING: --project-id is REQUIRED. When --project-map is
 * OMITTED, every source row maps to that single --project-id (the common
 * case — 7 live rows, one project). When --project-map IS given
 * ({branch_prefixes:[{prefix,project_id}], default?}), each row's raw
 * (UNTRIMMED) branch string is matched against every prefix via a plain
 * startsWith; the LONGEST matching prefix wins, ties broken by earliest
 * array position; --project-id plays NO role in this per-row resolution
 * (it remains required for CLI-contract consistency and report metadata
 * only) — see the PR body's design-decision note for why the spec's two
 * "required"/"optional-with-its-own-default" flags do not compose into a
 * three-tier fallback. Zero matching prefixes AND no map-level "default"
 * -> verdict `unmapped-branch-<raw branch>` (never guessed, never silently
 * dropped — friction over silent escape). If the raw branch has leading/
 * trailing whitespace and TRIMMING it would have matched a prefix (or
 * would have hit a configured default), the unmapped row's `hint` field is
 * `possible-trim-collision` — a diagnostic for the operator, never an
 * auto-correction.
 *
 * PER-ROW VERDICTS: insert | update-identical | refuse-conflict |
 * unmapped-branch-<raw>. "Identical" compares every non-generated column
 * (excludes id/created_at/source_db/source_feature_token_usage_id; notes
 * IS included) with exact semantics: NULL, '{}', and 0 are three distinct
 * values, never coalesced; BIGINT/NUMERIC/TIMESTAMPTZ columns are compared
 * as text (never `Number()` — see COMPARISON STRATEGY below); JSONB
 * (tool_calls) is deep-equal, object-key-order-insensitive; TEXT[]
 * (session_ids) is compared element-wise, IN ORDER, with NULL/[] kept
 * distinct. A conflicting existing row refuses that ROW only (never the
 * whole run) unless --allow-update-on-conflict is given, in which case the
 * verdict is `update` and the old->new diff is recorded in the report.
 *
 * COMPARISON STRATEGY: every BIGINT/NUMERIC/TIMESTAMPTZ column is read via
 * an explicit ::text (or to_char(... AT TIME ZONE 'UTC' ...) for
 * timestamps) cast on BOTH the source and target SELECTs, then compared
 * with plain `===` on the resulting strings — this repo's raw driver
 * value, never coerced through `Number()`, which is how a BIGINT above
 * 2^53 stays exact. model_breakdown's two embedded token counts are
 * compared the same way, bridged via `String()` on the JSONB-decoded
 * number (a one-directional, precision-safe bridge — see
 * modelBreakdownMatches — never `Number()` on a string).
 *
 * MAPPING (source -> target): model -> model_id; model_breakdown is
 * DERIVED, built entirely in SQL via jsonb_build_object with explicit
 * ::bigint/::int casts on the parameterized token/turn values (never
 * assembled by JS-side Number() coercion) as
 * `{[model]: {tokens_in, tokens_out, turns: assistant_msgs}}`, or SQL NULL
 * when model is NULL; input_tokens/output_tokens -> tokens_in/tokens_out
 * (passed through as the driver's own raw string, cast ::bigint by
 * Postgres itself); cost_usd is ALWAYS NULL (this migration never prices a
 * feature); session_ids is copied verbatim (NULL stays NULL, '{}' stays
 * '{}', duplicates kept); notes copied verbatim; source_db is the
 * `--source-db` value; source_feature_token_usage_id is the source row's
 * `id`. Every other target column (branch, pr_number, github_issue,
 * started_at, completed_at, assistant_msgs, cache_creation_5m_tokens,
 * cache_creation_1h_tokens, cache_read_tokens, cache_hit_pct, tool_calls,
 * created_at) is a same-name direct copy — created_at is copied from the
 * SOURCE row's own created_at (historical fidelity — the north-star
 * lossless-fidelity tenet), never re-stamped via the DDL's `DEFAULT NOW()`
 * (which would only apply if this column were omitted from the INSERT).
 *
 * ROLLBACK (--rollback <report.json>): deletes ONLY the rows whose
 * (source_db, source_feature_token_usage_id) pairs appear, with
 * written:true, in the given prior run's report — a plain
 * `DELETE ... WHERE source_db = $1 AND source_feature_token_usage_id = $2`
 * per pair, NEVER scoped by project_id (a project-scoped delete could
 * reach a row this run never touched, if the same source row was ever
 * re-mapped to a different project_id across two runs). A dry-run report
 * has zero written:true rows by construction, so rolling one back is a
 * documented no-op (0 rows deleted), not a refusal.
 *
 * Usage:
 *   node scripts/migrations/migrate-12-feature-usage.js --source-db <name>
 *     --project-id <id> [--db <name>] [--project-map <path>]
 *     [--write] [--dry-run] [--report-dir <path>] [--allow-update-on-conflict]
 *   node scripts/migrations/migrate-12-feature-usage.js --rollback <report.json>
 *     [--db <name>]
 *
 * Exit codes: 0 = success (including a dry-run or a per-row refusal that
 * does not block the run), 1 = refused / precondition failed / DB error,
 * 2 = bad CLI usage.
 */

const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

const migrateOne = require('./migrate-01-canonical-db');

const SOURCE_TABLE = 'feature_token_usage';
const DEFAULT_REPORT_DIR = path.join(process.cwd(), 'reports');

// Exact expected live shape of pipeline_pipeline.feature_token_usage (the
// private source DDL, read this session — only column names + declared
// types are reproduced here, never the DDL text itself). The bidirectional
// precondition below refuses the whole run on ANY unknown live column,
// missing expected column, or type mismatch.
const EXPECTED_SOURCE_COLUMNS = Object.freeze({
  id: 'integer',
  branch: 'text',
  pr_number: 'integer',
  github_issue: 'integer',
  started_at: 'timestamp with time zone',
  completed_at: 'timestamp with time zone',
  model: 'text',
  assistant_msgs: 'integer',
  input_tokens: 'bigint',
  output_tokens: 'bigint',
  cache_creation_5m_tokens: 'bigint',
  cache_creation_1h_tokens: 'bigint',
  cache_read_tokens: 'bigint',
  cache_hit_pct: 'numeric',
  tool_calls: 'jsonb',
  session_ids: 'ARRAY',
  notes: 'text',
  created_at: 'timestamp with time zone',
});

// ─── CLI ARGS ───────────────────────────────────────────────────────────────

class UsageError extends Error {}
class RefusedTargetError extends Error {}

function parseArgs(argv) {
  const parsed = {
    db: null, sourceDb: null, projectId: null, projectMap: null,
    dryRun: false, write: false, reportDir: DEFAULT_REPORT_DIR,
    rollback: null, allowUpdateOnConflict: false, help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--db') parsed.db = argv[++i];
    else if (a.startsWith('--db=')) parsed.db = a.slice('--db='.length);
    else if (a === '--source-db') parsed.sourceDb = argv[++i];
    else if (a.startsWith('--source-db=')) parsed.sourceDb = a.slice('--source-db='.length);
    else if (a === '--project-id') parsed.projectId = argv[++i];
    else if (a.startsWith('--project-id=')) parsed.projectId = a.slice('--project-id='.length);
    else if (a === '--project-map') parsed.projectMap = argv[++i];
    else if (a.startsWith('--project-map=')) parsed.projectMap = a.slice('--project-map='.length);
    else if (a === '--dry-run') parsed.dryRun = true;
    else if (a === '--write') parsed.write = true;
    else if (a === '--report-dir') parsed.reportDir = argv[++i];
    else if (a.startsWith('--report-dir=')) parsed.reportDir = a.slice('--report-dir='.length);
    else if (a === '--rollback') parsed.rollback = argv[++i];
    else if (a.startsWith('--rollback=')) parsed.rollback = a.slice('--rollback='.length);
    else if (a === '--allow-update-on-conflict') parsed.allowUpdateOnConflict = true;
    else if (a === '--help' || a === '-h') parsed.help = true;
    else throw new UsageError(`Unknown argument: ${a}`);
  }

  if (parsed.help) return parsed;

  if (parsed.rollback) {
    if (parsed.dryRun) {
      throw new UsageError('--dry-run and --rollback are mutually exclusive (a rollback is inherently a write).');
    }
  } else {
    if (!parsed.sourceDb) throw new UsageError('--source-db is required (unless --rollback is given).');
    if (!parsed.projectId) throw new UsageError('--project-id is required (unless --rollback is given).');
    if (parsed.dryRun && parsed.write) {
      throw new UsageError('--dry-run and --write are mutually exclusive.');
    }
  }
  return parsed;
}

function printUsage() {
  console.log([
    'Usage:',
    '  node scripts/migrations/migrate-12-feature-usage.js --source-db <name> --project-id <id>',
    '         [--db <name>] [--project-map <path>] [--write] [--dry-run]',
    '         [--report-dir <path>] [--allow-update-on-conflict]',
    '  node scripts/migrations/migrate-12-feature-usage.js --rollback <report.json> [--db <name>]',
    '',
    '  --db <name>          Target database (else MIGRATE_TARGET_DB env, else',
    '                       memory_manager_staging). Must already carry the',
    '                       feature_usage table (migrate-schema-addenda.js).',
    '  --source-db <name>   Source database (e.g. pipeline_pipeline). Required',
    '                       unless --rollback. Never run through classifyTarget.',
    '  --project-id <id>    Required unless --rollback. Used for every row when',
    '                       --project-map is omitted; see the header comment for',
    '                       its (non-)role when --project-map is given.',
    '  --project-map <path> Optional JSON {branch_prefixes:[{prefix,project_id}],',
    '                       default?}. See feature-usage-project-map.example.json.',
    '  --write              Perform writes. Without this flag, the run is a',
    '                       dry-run (the default) — verdicts computed, nothing written.',
    '  --dry-run            Explicit dry-run (same effect as omitting --write).',
    '                       Mutually exclusive with --write and with --rollback.',
    '  --report-dir <path>  Directory for the JSON run report (default: ./reports).',
    '  --allow-update-on-conflict',
    '                       A pre-existing provenance row that differs from the',
    "                       source is UPDATEd (verdict 'update') instead of",
    "                       refused (verdict 'refuse-conflict').",
    '  --rollback <path>    Delete every (source_db, source_feature_token_usage_id)',
    '                       pair recorded written:true in the given prior report.',
    '                       Never scoped by project_id. Refused together with --dry-run.',
  ].join('\n'));
}

// ─── PROJECT MAP ────────────────────────────────────────────────────────────

function loadProjectMap(filePath) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    throw new UsageError(`--project-map "${filePath}" could not be read: ${err.message}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new UsageError(`--project-map "${filePath}" is not valid JSON: ${err.message}`);
  }
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.branch_prefixes)) {
    throw new UsageError(`--project-map "${filePath}" must be an object with a "branch_prefixes" array.`);
  }
  const seen = new Set();
  for (const [i, entry] of parsed.branch_prefixes.entries()) {
    if (!entry || typeof entry.prefix !== 'string' || entry.prefix.length === 0 ||
        typeof entry.project_id !== 'string' || entry.project_id.length === 0) {
      throw new UsageError(`--project-map "${filePath}", branch_prefixes[${i}] must be {prefix:<non-empty string>, project_id:<non-empty string>}.`);
    }
    if (seen.has(entry.prefix)) {
      throw new UsageError(`--project-map "${filePath}" declares a duplicate prefix "${entry.prefix}" in branch_prefixes — fix the map before running (a duplicate makes "first in array" ambiguous to a human reader even though the code itself would resolve it deterministically).`);
    }
    seen.add(entry.prefix);
  }
  if (parsed.default !== undefined && (typeof parsed.default !== 'string' || parsed.default.length === 0)) {
    throw new UsageError(`--project-map "${filePath}": "default" must be a non-empty string when present.`);
  }
  return parsed;
}

/**
 * Longest-prefix-wins (ties -> first in array), raw UNTRIMMED branch string,
 * map-level "default" applies only when zero prefixes match, else
 * unmapped-branch-<raw> with an optional possible-trim-collision hint.
 */
function resolveProjectId(branch, projectMap, cliProjectId) {
  if (!projectMap) {
    return { projectId: cliProjectId, verdict: null, hint: null };
  }
  const prefixes = projectMap.branch_prefixes || [];
  let best = null;
  for (const entry of prefixes) {
    if (branch.startsWith(entry.prefix) && (!best || entry.prefix.length > best.prefix.length)) {
      best = entry;
    }
  }
  if (best) return { projectId: best.project_id, verdict: null, hint: null };
  if (projectMap.default) return { projectId: projectMap.default, verdict: null, hint: null };

  const trimmed = branch.trim();
  const wouldHaveMatched = trimmed !== branch && prefixes.some((e) => trimmed.startsWith(e.prefix));
  return { projectId: null, verdict: `unmapped-branch-${branch}`, hint: wouldHaveMatched ? 'possible-trim-collision' : null };
}

// ─── TARGET CLASSIFICATION ──────────────────────────────────────────────────

/**
 * classifyTarget (PR #251) always returns { branch, allowed, reason,
 * connectionOpened }, branch one of CANON/STAGING/PER_PROJECT_ENGINE/
 * SOURCE_ONLY/UNKNOWN. `projectId` is deliberately never passed (see the
 * header comment's TARGET CLASSIFICATION section) -- this keeps
 * PER_PROJECT_ENGINE structurally unreachable, so the branch !== CANON/
 * STAGING check below is a belt-and-braces second guard, never the sole
 * line of defense against a per-project engine DB.
 */
async function assertTargetAllowed(target) {
  const cls = await migrateOne.classifyTarget({ dbName: target });
  if (!cls.allowed) throw new RefusedTargetError(cls.reason);
  if (!['CANON', 'STAGING'].includes(cls.branch)) {
    throw new RefusedTargetError(
      `target branch "${cls.branch}" is neither CANON nor STAGING — never a per-project engine DB.`
    );
  }
}

// ─── PRECONDITION (bidirectional column-shape check) ───────────────────────

async function checkSourcePrecondition(srcClient) {
  const { rows } = await srcClient.query(
    `SELECT column_name, data_type FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1`,
    [SOURCE_TABLE]
  );
  if (rows.length === 0) {
    return { ok: false, missing: Object.keys(EXPECTED_SOURCE_COLUMNS), unknown: [], typeMismatches: [], notFound: true };
  }
  const live = new Map(rows.map((r) => [r.column_name, r.data_type]));
  const expectedNames = Object.keys(EXPECTED_SOURCE_COLUMNS);
  const missing = expectedNames.filter((c) => !live.has(c));
  const unknown = [...live.keys()].filter((c) => !EXPECTED_SOURCE_COLUMNS[c]);
  const typeMismatches = [];
  for (const col of expectedNames) {
    if (live.has(col) && live.get(col) !== EXPECTED_SOURCE_COLUMNS[col]) {
      typeMismatches.push({ column: col, expected: EXPECTED_SOURCE_COLUMNS[col], actual: live.get(col) });
    }
  }
  return { ok: missing.length === 0 && unknown.length === 0 && typeMismatches.length === 0, missing, unknown, typeMismatches, notFound: false };
}

async function checkTargetTableExists(tgtClient) {
  const { rows } = await tgtClient.query(
    `SELECT 1 FROM information_schema.tables WHERE table_schema = current_schema() AND table_name = 'feature_usage'`
  );
  return rows.length > 0;
}

// ─── JSONB / ARRAY COMPARISON HELPERS ───────────────────────────────────────

/** TEXT[] element-wise, IN ORDER; NULL and [] kept distinct. */
function arraysEqualOrdered(a, b) {
  if (a === null || a === undefined) return b === null || b === undefined;
  if (b === null || b === undefined) return false;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** Generic JSONB deep-equal, object-key-order-insensitive, array-order-sensitive. */
function deepEqualJsonb(a, b) {
  if (a === b) return true;
  if (a === null || b === null || a === undefined || b === undefined) return a === b;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    if (a.length !== b.length) return false;
    return a.every((v, i) => deepEqualJsonb(v, b[i]));
  }
  if (typeof a === 'object' && typeof b === 'object') {
    const ak = Object.keys(a).sort();
    const bk = Object.keys(b).sort();
    if (JSON.stringify(ak) !== JSON.stringify(bk)) return false;
    return ak.every((k) => deepEqualJsonb(a[k], b[k]));
  }
  return false;
}

/**
 * model_breakdown's two embedded token counts are JSONB numbers (Postgres/
 * node-postgres decode JSONB numerics as JS numbers — there is no way to
 * read them back as text short of not using JSONB at all). Bridged via
 * String() on the ALREADY-a-number decoded value — never Number() on the
 * incoming raw string — so this never re-introduces the >2^53 precision
 * risk the top-level BIGINT columns are guarded against.
 */
function modelBreakdownMatches(existing, model, tokensInTxt, tokensOutTxt, assistantMsgs) {
  if (model === null) return existing === null || existing === undefined;
  if (!existing || typeof existing !== 'object' || Array.isArray(existing)) return false;
  const keys = Object.keys(existing);
  if (keys.length !== 1 || keys[0] !== model) return false;
  const entry = existing[model];
  if (!entry || typeof entry !== 'object') return false;
  const entryKeys = Object.keys(entry).sort();
  if (JSON.stringify(entryKeys) !== JSON.stringify(['tokens_in', 'tokens_out', 'turns'])) return false;
  return String(entry.tokens_in) === String(tokensInTxt) &&
    String(entry.tokens_out) === String(tokensOutTxt) &&
    entry.turns === assistantMsgs;
}

// ─── ROW COMPARISON ─────────────────────────────────────────────────────────

function compareRow(src, existing) {
  const diffs = [];
  const scalarCols = [
    ['branch', src.branch, existing.branch],
    ['pr_number', src.pr_number, existing.pr_number],
    ['github_issue', src.github_issue, existing.github_issue],
    ['started_at', src.started_at_txt, existing.started_at_txt],
    ['completed_at', src.completed_at_txt, existing.completed_at_txt],
    ['model_id', src.model, existing.model_id],
    ['assistant_msgs', src.assistant_msgs, existing.assistant_msgs],
    ['tokens_in', src.input_tokens_txt, existing.tokens_in_txt],
    ['tokens_out', src.output_tokens_txt, existing.tokens_out_txt],
    ['cache_creation_5m_tokens', src.cache_creation_5m_tokens_txt, existing.cache_creation_5m_tokens_txt],
    ['cache_creation_1h_tokens', src.cache_creation_1h_tokens_txt, existing.cache_creation_1h_tokens_txt],
    ['cache_read_tokens', src.cache_read_tokens_txt, existing.cache_read_tokens_txt],
    ['cache_hit_pct', src.cache_hit_pct_txt, existing.cache_hit_pct_txt],
    ['cost_usd', null, existing.cost_usd_txt], // this migration always maps cost_usd to NULL
    ['notes', src.notes, existing.notes],
  ];
  for (const [column, incoming, existingVal] of scalarCols) {
    if (incoming !== existingVal) diffs.push({ column, existing: existingVal, incoming });
  }
  if (!arraysEqualOrdered(src.session_ids, existing.session_ids)) {
    diffs.push({ column: 'session_ids', existing: existing.session_ids, incoming: src.session_ids });
  }
  if (!deepEqualJsonb(src.tool_calls, existing.tool_calls)) {
    diffs.push({ column: 'tool_calls', existing: existing.tool_calls, incoming: src.tool_calls });
  }
  if (!modelBreakdownMatches(existing.model_breakdown, src.model, src.input_tokens_txt, src.output_tokens_txt, src.assistant_msgs)) {
    diffs.push({ column: 'model_breakdown', existing: existing.model_breakdown, incoming: '<derived from model/tokens_in/tokens_out/assistant_msgs>' });
  }
  return { identical: diffs.length === 0, diffs };
}

// ─── DB READ/WRITE ──────────────────────────────────────────────────────────

// TIMESTAMP HANDLING: started_at/completed_at/created_at are read ONLY as
// microsecond-exact UTC ISO-8601 text with an explicit "Z" offset marker
// (to_char(... AT TIME ZONE 'UTC' ...) plus a literal Z) — NEVER as a raw
// JS Date object. A JS Date has only MILLISECOND resolution; binding one as
// an INSERT/UPDATE parameter for a microsecond-precision TIMESTAMPTZ column
// silently truncates the sub-millisecond remainder, which then falsely
// diverges from the source on every subsequent re-run's identical-check
// (a real defect this script's own author found authoring it — a fixture
// with a .123456-microsecond started_at reproduced it exactly). The "Z"
// suffix makes the text parse as UTC regardless of the connection's session
// TimeZone setting, so the very same string is used for BOTH the actual
// write AND the identical-check comparison — one representation, not two.
const TS_TO_TEXT = `'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'`;

const SOURCE_SELECT_SQL = `
  SELECT
    id, branch, pr_number, github_issue, model,
    assistant_msgs, tool_calls, session_ids, notes,
    input_tokens::text  AS input_tokens_txt,
    output_tokens::text AS output_tokens_txt,
    cache_creation_5m_tokens::text AS cache_creation_5m_tokens_txt,
    cache_creation_1h_tokens::text AS cache_creation_1h_tokens_txt,
    cache_read_tokens::text        AS cache_read_tokens_txt,
    cache_hit_pct::text            AS cache_hit_pct_txt,
    to_char(started_at AT TIME ZONE 'UTC', ${TS_TO_TEXT}) AS started_at_txt,
    CASE WHEN completed_at IS NULL THEN NULL
         ELSE to_char(completed_at AT TIME ZONE 'UTC', ${TS_TO_TEXT}) END AS completed_at_txt,
    to_char(created_at AT TIME ZONE 'UTC', ${TS_TO_TEXT}) AS created_at_txt
  FROM ${SOURCE_TABLE}
  ORDER BY id
`;

async function fetchSourceRows(srcClient) {
  const { rows } = await srcClient.query(SOURCE_SELECT_SQL);
  return rows;
}

async function fetchExistingTargetRow(tgtClient, projectId, sourceDb, sourceId) {
  const { rows } = await tgtClient.query(
    `SELECT
       id, branch, pr_number, github_issue, model_id, model_breakdown, assistant_msgs,
       tool_calls, session_ids, notes,
       tokens_in::text AS tokens_in_txt,
       tokens_out::text AS tokens_out_txt,
       cache_creation_5m_tokens::text AS cache_creation_5m_tokens_txt,
       cache_creation_1h_tokens::text AS cache_creation_1h_tokens_txt,
       cache_read_tokens::text        AS cache_read_tokens_txt,
       cache_hit_pct::text            AS cache_hit_pct_txt,
       cost_usd::text                 AS cost_usd_txt,
       to_char(started_at AT TIME ZONE 'UTC', ${TS_TO_TEXT}) AS started_at_txt,
       CASE WHEN completed_at IS NULL THEN NULL
            ELSE to_char(completed_at AT TIME ZONE 'UTC', ${TS_TO_TEXT}) END AS completed_at_txt
     FROM feature_usage
     WHERE project_id = $1 AND source_db = $2 AND source_feature_token_usage_id = $3`,
    [projectId, sourceDb, sourceId]
  );
  return rows[0] || null;
}

// model_breakdown is built ENTIRELY in SQL (jsonb_build_object with explicit
// ::bigint/::int casts on parameterized values) — never assembled by JS-side
// Number() coercion of a BIGINT-shaped string.
// NOTE ON PLACEHOLDER NUMBERING: $N indices below correspond EXACTLY to the
// 1-based position of that value in insertParams()/updateParams()'s
// returned array -- NOT to the column's position in the INSERT's column
// list (model_breakdown has no VALUES-list placeholder of its own; it is a
// computed expression referencing $6/$7/$8/$9 or $7/$8/$9/$10, the SAME
// param slots as model_id/assistant_msgs/tokens_in/tokens_out). Keeping
// these two things (array order vs. $N number) in exact 1:1 correspondence
// is the one invariant that matters here — a mismatch silently binds the
// wrong column, which is exactly why the two are laid out in the same
// column order in both the SQL text and insertParams()/updateParams() below.
const INSERT_SQL = `
  INSERT INTO feature_usage (
    project_id, branch, pr_number, github_issue, started_at, completed_at,
    model_id, model_breakdown, assistant_msgs, tokens_in, tokens_out,
    cache_creation_5m_tokens, cache_creation_1h_tokens, cache_read_tokens,
    cache_hit_pct, cost_usd, tool_calls, session_ids, notes,
    source_feature_token_usage_id, source_db, created_at
  ) VALUES (
    $1, $2, $3, $4, $5, $6,
    $7,
    CASE WHEN $7::text IS NULL THEN NULL
         ELSE jsonb_build_object($7::text, jsonb_build_object('tokens_in', $9::bigint, 'tokens_out', $10::bigint, 'turns', $8::int)) END,
    $8, $9, $10,
    $11, $12, $13,
    $14, NULL, $15, $16, $17,
    $18, $19, $20
  )
  RETURNING id
`;

// node-postgres's own prepareValue() checks Array.isArray() BEFORE its
// plain-object JSON.stringify branch, so a JS array bound as a query
// parameter is ALWAYS rendered as a Postgres array literal ("{a,b,c}"),
// never as JSON — correct for session_ids (TEXT[]) but wrong for tool_calls
// (JSONB) whenever the source value happens to be a JSON array (e.g. a list
// of tool-call records), which would otherwise corrupt-or-fail the write.
// tool_calls is therefore explicitly JSON.stringify()'d before binding
// (NULL preserved as JS null, never the string "null").
function toJsonbParam(v) {
  return v === null || v === undefined ? null : JSON.stringify(v);
}

function insertParams({ projectId, sourceDb, src }) {
  return [
    projectId, src.branch, src.pr_number, src.github_issue, src.started_at_txt, src.completed_at_txt, // $1-$6
    src.model,                                                                                 // $7
    src.assistant_msgs, src.input_tokens_txt, src.output_tokens_txt,                           // $8-$10
    src.cache_creation_5m_tokens_txt, src.cache_creation_1h_tokens_txt, src.cache_read_tokens_txt, // $11-$13
    src.cache_hit_pct_txt, toJsonbParam(src.tool_calls), src.session_ids, src.notes,            // $14-$17
    src.id, sourceDb, src.created_at_txt,                                                       // $18-$20
  ];
}

const UPDATE_SQL = `
  UPDATE feature_usage SET
    branch = $1, pr_number = $2, github_issue = $3, started_at = $4, completed_at = $5,
    model_id = $6,
    model_breakdown = CASE WHEN $6::text IS NULL THEN NULL
      ELSE jsonb_build_object($6::text, jsonb_build_object('tokens_in', $8::bigint, 'tokens_out', $9::bigint, 'turns', $7::int)) END,
    assistant_msgs = $7, tokens_in = $8, tokens_out = $9,
    cache_creation_5m_tokens = $10, cache_creation_1h_tokens = $11, cache_read_tokens = $12,
    cache_hit_pct = $13, cost_usd = NULL, tool_calls = $14, session_ids = $15, notes = $16
  WHERE id = $17
`;

function updateParams({ src, existingId }) {
  return [
    src.branch, src.pr_number, src.github_issue, src.started_at_txt, src.completed_at_txt, // $1-$5
    src.model, src.assistant_msgs, src.input_tokens_txt, src.output_tokens_txt,    // $6-$9
    src.cache_creation_5m_tokens_txt, src.cache_creation_1h_tokens_txt, src.cache_read_tokens_txt, // $10-$12
    src.cache_hit_pct_txt, toJsonbParam(src.tool_calls), src.session_ids, src.notes, // $13-$16
    existingId,                                                                    // $17
  ];
}

// ─── REPORT ─────────────────────────────────────────────────────────────────

function writeReport(reportDir, report) {
  fs.mkdirSync(reportDir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const filePath = path.join(reportDir, `migrate-12-feature-usage-${report.mode}-${ts}.json`);
  fs.writeFileSync(filePath, JSON.stringify(report, null, 2), 'utf8');
  return filePath;
}

// ─── MAIN ───────────────────────────────────────────────────────────────────

async function runMigration(parsed) {
  const { name: target, source: targetSource } = migrateOne.resolveTargetDb(parsed);
  if (!migrateOne.DB_NAME_RE.test(target)) {
    throw new RefusedTargetError(`Invalid target database name "${target}" (from ${targetSource}).`);
  }
  await assertTargetAllowed(target);

  if (!migrateOne.DB_NAME_RE.test(parsed.sourceDb)) {
    throw new UsageError(`Invalid --source-db name "${parsed.sourceDb}".`);
  }

  const projectMap = parsed.projectMap ? loadProjectMap(parsed.projectMap) : null;

  console.log(`migrate-12-feature-usage: target="${target}" (resolved from ${targetSource}) source-db="${parsed.sourceDb}" mode=${parsed.write ? 'WRITE' : 'DRY-RUN'}`);

  const srcClient = new Client(migrateOne.pgConfig(parsed.sourceDb));
  const tgtClient = new Client(migrateOne.pgConfig(target));
  await srcClient.connect();
  try {
    await tgtClient.connect();
  } catch (err) {
    await srcClient.end();
    throw err;
  }

  try {
    const srcPrecondition = await checkSourcePrecondition(srcClient);
    if (!srcPrecondition.ok) {
      const lines = [];
      if (srcPrecondition.notFound) lines.push(`source table "${SOURCE_TABLE}" not found in "${parsed.sourceDb}".`);
      if (srcPrecondition.missing.length) lines.push(`missing expected column(s): ${srcPrecondition.missing.join(', ')}`);
      if (srcPrecondition.unknown.length) lines.push(`unknown live column(s) not in the expected set: ${srcPrecondition.unknown.join(', ')}`);
      if (srcPrecondition.typeMismatches.length) {
        lines.push(`type mismatch(es): ${srcPrecondition.typeMismatches.map((m) => `${m.column} expected=${m.expected} actual=${m.actual}`).join('; ')}`);
      }
      throw new RefusedTargetError(`source column-shape precondition failed — refusing the whole run:\n  ${lines.join('\n  ')}`);
    }

    const targetExists = await checkTargetTableExists(tgtClient);
    if (!targetExists) {
      throw new RefusedTargetError(
        `target "${target}" is missing the feature_usage table. Run migrate-schema-addenda.js against this target first, then re-run this script.`
      );
    }

    const sourceRows = await fetchSourceRows(srcClient);
    const results = [];
    const counts = { insert: 0, 'update-identical': 0, 'refuse-conflict': 0, update: 0, unmapped: 0 };

    for (const src of sourceRows) {
      const mapping = resolveProjectId(src.branch, projectMap, parsed.projectId);

      if (mapping.projectId === null) {
        counts.unmapped++;
        results.push({ sourceId: src.id, branch: src.branch, verdict: mapping.verdict, hint: mapping.hint, projectId: null, written: false });
        continue;
      }

      const existing = await fetchExistingTargetRow(tgtClient, mapping.projectId, parsed.sourceDb, src.id);
      let verdict;
      let diffs;
      if (!existing) {
        verdict = 'insert';
      } else {
        const cmp = compareRow(src, existing);
        diffs = cmp.diffs;
        if (cmp.identical) verdict = 'update-identical';
        else if (parsed.allowUpdateOnConflict) verdict = 'update';
        else verdict = 'refuse-conflict';
      }
      counts[verdict] = (counts[verdict] || 0) + 1;

      const row = { sourceId: src.id, branch: src.branch, projectId: mapping.projectId, verdict, written: false };
      if (diffs && diffs.length) row.diffs = diffs;

      if (parsed.write) {
        if (verdict === 'insert') {
          const { rows } = await tgtClient.query(INSERT_SQL, insertParams({ projectId: mapping.projectId, sourceDb: parsed.sourceDb, src }));
          row.targetId = rows[0].id;
          row.written = true;
        } else if (verdict === 'update') {
          await tgtClient.query(UPDATE_SQL, updateParams({ src, existingId: existing.id }));
          row.targetId = existing.id;
          row.written = true;
        } else if (existing) {
          row.targetId = existing.id;
        }
      }
      results.push(row);
    }

    const report = {
      mode: parsed.write ? 'write' : 'dry-run',
      target,
      sourceDb: parsed.sourceDb,
      projectId: parsed.projectId,
      projectMapPath: parsed.projectMap,
      generatedAt: new Date().toISOString(),
      counts,
      results,
    };
    const reportPath = writeReport(parsed.reportDir, report);

    console.log(`  rows: ${sourceRows.length}  insert=${counts.insert || 0} update-identical=${counts['update-identical'] || 0} update=${counts.update || 0} refuse-conflict=${counts['refuse-conflict'] || 0} unmapped=${counts.unmapped || 0}`);
    console.log(`  report: ${reportPath}`);
    console.log(`MIGRATION_RESULT: ${parsed.write ? 'WRITE-COMPLETE' : 'DRY-RUN-COMPLETE'}`);
    return { report, reportPath };
  } finally {
    await srcClient.end();
    await tgtClient.end();
  }
}

async function runRollback(parsed) {
  const { name: target, source: targetSource } = migrateOne.resolveTargetDb(parsed);
  if (!migrateOne.DB_NAME_RE.test(target)) {
    throw new RefusedTargetError(`Invalid target database name "${target}" (from ${targetSource}).`);
  }
  await assertTargetAllowed(target);

  let report;
  try {
    report = JSON.parse(fs.readFileSync(parsed.rollback, 'utf8'));
  } catch (err) {
    throw new UsageError(`--rollback report "${parsed.rollback}" could not be read/parsed: ${err.message}`);
  }
  if (!Array.isArray(report.results)) {
    throw new UsageError(`--rollback report "${parsed.rollback}" does not look like a migrate-12-feature-usage.js report (no "results" array).`);
  }

  // Never scoped by project_id — only by the (source_db, source_feature_
  // token_usage_id) pairs this specific prior run actually wrote.
  const pairs = report.results
    .filter((r) => r.written === true)
    .map((r) => ({ sourceDb: report.sourceDb, sourceId: r.sourceId }));

  console.log(`migrate-12-feature-usage --rollback: target="${target}" (resolved from ${targetSource}) report="${parsed.rollback}" pairs=${pairs.length}`);

  if (pairs.length === 0) {
    console.log('  nothing to roll back (report carries zero written:true rows — e.g. a dry-run report).');
    console.log('ROLLBACK_RESULT: NOOP');
    return { deleted: 0 };
  }

  const tgtClient = new Client(migrateOne.pgConfig(target));
  await tgtClient.connect();
  try {
    let deleted = 0;
    for (const { sourceDb, sourceId } of pairs) {
      const { rowCount } = await tgtClient.query(
        `DELETE FROM feature_usage WHERE source_db = $1 AND source_feature_token_usage_id = $2`,
        [sourceDb, sourceId]
      );
      deleted += rowCount;
    }
    console.log(`  deleted ${deleted} row(s).`);
    console.log('ROLLBACK_RESULT: DONE');
    return { deleted };
  } finally {
    await tgtClient.end();
  }
}

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

  try {
    if (parsed.rollback) {
      await runRollback(parsed);
    } else {
      await runMigration(parsed);
    }
  } catch (err) {
    if (err instanceof RefusedTargetError || err instanceof UsageError) {
      console.error(`Refused: ${err.message}`);
      process.exitCode = 1;
      return;
    }
    throw err;
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err && err.stack ? err.stack : err);
    process.exitCode = 1;
  });
}

module.exports = {
  parseArgs,
  printUsage,
  UsageError,
  RefusedTargetError,
  SOURCE_TABLE,
  EXPECTED_SOURCE_COLUMNS,
  loadProjectMap,
  resolveProjectId,
  assertTargetAllowed,
  checkSourcePrecondition,
  checkTargetTableExists,
  arraysEqualOrdered,
  deepEqualJsonb,
  modelBreakdownMatches,
  compareRow,
  fetchSourceRows,
  fetchExistingTargetRow,
  insertParams,
  updateParams,
  toJsonbParam,
  INSERT_SQL,
  UPDATE_SQL,
  writeReport,
  runMigration,
  runRollback,
};
