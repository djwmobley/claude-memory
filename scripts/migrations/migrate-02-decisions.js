'use strict';

/**
 * migrate-02-decisions.js
 *
 * CONSOLIDATION-RUNBOOK.md §6.1(b) + its D-1..D-12 spec-adversary amendment
 * (2026-08-15, memory-manager#11(b)): migrates `claude_policy_framework
 * .decisions` (a single, multi-project, topic-prefix-keyed table) into the
 * structured `decisions` table on a memory-manager consolidation target
 * (default `memory_manager_staging`, per §15.1's staging-first path) —
 * NOT the lossy prose-blob approach `phase0-decisions-backfill.js` used.
 * project_id is derived per row from `topic`'s prefix via an ordered
 * classifier read from scripts/migrations/topic-prefix-to-project.json
 * (§16.2's routing table, formalized).
 *
 * WHAT THIS SCRIPT DOES (normal / MIGRATE mode):
 *   1. Resolves + validates the TARGET database exactly like migrate-01/
 *      migrate-13/migrate-14 (--db flag, then MIGRATE_TARGET_DB env, then
 *      memory_manager_staging), via migrate-01's classifyTarget (async,
 *      reused by reference) called with projectId left undefined -- this
 *      script has no --project-id flag and only ever targets CANON
 *      (memory_manager) or STAGING (*_staging); the classification result's
 *      branch is asserted to be one of those two, so a name that resolves
 *      to PER_PROJECT_ENGINE, SOURCE_ONLY, or UNKNOWN (claude_memory_eval_
 *      test, pipeline_*, claude_policy_framework itself, or any other
 *      unrecognized/unmarked name) is refused. Never reads HANDOFF_DB.
 *   2. Resolves the SOURCE database (--source-db flag, else SOURCE_DB env,
 *      else "claude_policy_framework"). The source connection is used
 *      SELECT-only -- every query issued against it is guarded by
 *      sourceSelect(), which throws on anything that is not a leading
 *      SELECT. This script never issues DDL/DML against the source; the
 *      source is READ-ONLY infrastructure to this script by construction,
 *      not merely by convention.
 *   3. Confirms the target already has a `decisions` table (migrate-14-
 *      seam-tables.js's job) -- a hard, up-front refusal naming that script
 *      if missing, nothing applied.
 *   4. Loads + validates scripts/migrations/topic-prefix-to-project.json
 *      (D-12): every rule's `target` must appear in the file's own
 *      known_project_ids array, UNLESS the target is one of the six
 *      hardcoded "unmatched-*" owner-review buckets (D-2) -- those are
 *      deliberately never real project_ids. A malformed or under-specified
 *      routing map is a loud FATAL before any DB connection past target/
 *      source resolution is used for real work.
 *   5. BACKUP (read-only): dumps every row of the source `decisions` table
 *      (id, session_num, topic, decision, reason, created_at) to a
 *      timestamped JSON file under scripts/migrations/backups/ (gitignored
 *      -- real backup content is private, cross-project prose). Printed
 *      before anything else happens.
 *   6. PRECONDITIONS (loud FAIL before ANY INSERT, D-3/D-4):
 *        - every source topic satisfies `topic = lower(trim(topic))` --
 *          checked via the exact SQL predicate against the live source
 *          (never JS-side re-implemented casing/trim logic, which can
 *          diverge from Postgres's own lower()/trim() on non-ASCII input --
 *          see this script's blind-spot note in the PR body). Any violation
 *          is printed (id + topic) and the script exits 1 with NOTHING
 *          inserted. No silent normalization is ever applied.
 *        - zero duplicate topics: `GROUP BY topic HAVING COUNT(*) > 1`
 *          against the live source. Any violation is printed and the
 *          script exits 1 with NOTHING inserted.
 *   7. Bundles the idempotent DDL migrate-schema-addenda's concurrent mm#18
 *      PR also bundles verbatim (same statement, same name -- no ordering
 *      dependency, D-4/M-1):
 *        CREATE UNIQUE INDEX IF NOT EXISTS decisions_project_topic_unique
 *          ON decisions(project_id, topic);
 *   8. Fetches every source row, classifies each row's topic via the
 *      ordered LITERAL/WILDCARD routing rules (first-match-wins;
 *      zero-match falls to `unmatched-<first-dash-token>`, D-1/D-10), and
 *      groups rows into per-derived-project-id slices.
 *   9. Per slice, in ONE transaction (D-5/D-11):
 *        - RECONCILIATION (review-round-1 fix, post-D-12; review-round-2
 *          fix: source_model-guarded): deletes any `decisions` row whose
 *          `topic` is in this slice, whose `project_id` is NOT this
 *          slice's project_id, AND whose `source_model` is this script's
 *          own SOURCE_MODEL_TAG -- a topic re-classified to a different
 *          project_id since a prior run of THIS script (the documented
 *          D-2 owner-review workflow: fix an `unmatched-*` bucket's rule,
 *          re-run -- or the inverse, a rule removal dropping a topic back
 *          to `unmatched-*`). Topics are globally unique WITHIN this
 *          migration's own source (D-4), but NOT across the whole
 *          `decisions` table -- other writers (a live memory_upsert/
 *          persist_decisions path, hand-run SQL, a future second
 *          migration) can legitimately share a topic string under a
 *          DIFFERENT project_id, which the table's own (project_id,
 *          topic) unique constraint explicitly supports. The
 *          source_model guard (round 2 -- an independent reviewer
 *          reproduced the unscoped version silently deleting live,
 *          non-migration data) is what makes this DELETE precise; without
 *          it, "topic re-classified by a prior run of this script" and
 *          "topic happens to collide with someone else's unrelated row"
 *          are indistinguishable. Each removed row is logged
 *          (`[RECLASSIFY]`) -- the `decisions_audit` trigger, once wired,
 *          preserves it in `audit_log`; never a silent drop.
 *        - upserts every row into `decisions` via
 *          `ON CONFLICT (project_id, topic) DO UPDATE` (idempotent re-run
 *          key, mirrors the source table's own upsert-by-topic semantics).
 *          Field mapping: topic/decision/reason/session_num straight copy;
 *          project_id from the classifier; source_project_hint = the
 *          matched prefix or fallback first-dash-token (audit trail);
 *          source_model = 'unknown-pre-migration'; authoring_mode =
 *          'verbose' (grandfather, INSERT-time only, D-6 -- never
 *          retroactively rewritten); agent_id and embedding are left NULL
 *          (D-6 -- embedding backfill is phase (g)'s job).
 *        - delete-and-reinserts this slice's migration_manifest row +
 *          migration_manifest_row_hashes rows, in the SAME transaction as
 *          the decisions upsert batch (D-5/D-11) -- re-run idempotent on
 *          both tables together, never one without the other.
 *  10. ORPHANED-SLICE RECONCILIATION (review-round-1 fix), its own
 *      transaction, after every per-slice transaction has committed:
 *      deletes any `migration_manifest` (+ `migration_manifest_row_hashes`)
 *      slice for this `(source_db, source_table)` whose `project_id_or_null`
 *      is NOT in the CURRENT classification's slice set -- a project_id
 *      that zero source topics route to this run (the case step 9's
 *      per-topic delete can't reach, because no current slice ever visits
 *      it: e.g. `unmatched-cache-warmup` disappearing entirely once its
 *      one topic gets a real rule). Logged (`[RECONCILE]`).
 *  11. RECONCILIATION GATE (review-round-1 fix; review-round-2 fix:
 *      source_model-guarded duplicate check): after all of the above,
 *      asserts (a) no current source topic maps to more than one live
 *      `decisions` row tagged this script's own `source_model` (NOT a
 *      claim that the topic is unique across the whole table -- a
 *      legitimate unrelated row sharing that topic under a different
 *      project_id must not fail this gate), and (b) the live
 *      `migration_manifest` slice set for this source equals the current
 *      classification's slice set exactly. Either failing is a loud
 *      `Refused (reconciliation gate)` and demotes `MIGRATION_RESULT` to
 *      FAIL even if step 12's row-count gate passed -- this is the check
 *      that makes re-classification drift visible instead of silently
 *      passing (the round-1 bug: both runs of that reproduction printed
 *      `MIGRATION_RESULT: PASS` with a duplicated, orphaned row left
 *      behind). NOTE: this gate runs AFTER step 9's DELETE has already
 *      committed, so it can only catch inconsistency that SURVIVES the
 *      delete -- it is not a substitute for that DELETE's own
 *      source_model guard (round 2), which is what prevents an
 *      over-broad delete from happening in the first place.
 *  12. Prints a per-slice report: live count next to an OPTIONAL
 *      documentary (stale) baseline carried on the routing map itself
 *      (D-9 -- diagnostic display only, NEVER read by any pass/fail
 *      branch in this script); flags every "unmatched-*" bucket by name.
 *      MIGRATION_RESULT: PASS iff migrated-row total == live source total
 *      AND step 11's reconciliation gate is clean.
 *
 * ROLLBACK MODE (--rollback, D-7/D-8, topic-scoped as of review round 1):
 * reads the CURRENT source content's topic set (not a saved list from the
 * original run, and NOT a re-derived hint set -- see below -- this makes
 * rollback a standalone, replayable invocation), then in ONE transaction:
 * deletes every `decisions` row tagged source_model='unknown-pre-migration'
 * AND topic IN that set, plus this source_db/source_table's
 * migration_manifest and migration_manifest_row_hashes rows. Prints the
 * expected audit_log append-note (D-8): the decisions_audit trigger, once
 * wired, fires once per deleted row -- that is EXPECTED, CORRECT, and never
 * itself reverted (the append-only ledger IS the record a migration-then-
 * rollback occurred). Topic identity (not source_project_hint re-derived by
 * re-classifying through whatever routing map happens to be loaded right
 * now) is the scoping key as of review round 1: hint-based scoping was
 * drift-vulnerable to the exact same routing-map-edited-since-the-original-
 * run scenario the reconciliation fix addresses -- see REQUIRED BLIND SPOTS
 * for the residual limit once a second source shares this table.
 *
 * WHAT THIS SCRIPT DELIBERATELY DOES NOT DO (out of scope):
 *   - No embedding backfill (phase (g)/D-6).
 *   - No caveman-rewrite of decision/reason text (§7's "no UPDATE/DELETE
 *     of existing data" pattern -- these rows inherit authoring_mode=
 *     'verbose' once, at INSERT time, never mutated later).
 *   - No owner-review auto-routing for the six "unmatched-*" singleton
 *     prefixes (D-2) -- §16.2's "best-effort inference" column is
 *     commentary only; this script never reads it.
 *   - It never reads HANDOFF_DB, and it never creates the target database
 *     (run migrate-01-canonical-db.js + migrate-14-seam-tables.js first).
 *
 * Usage:
 *   node scripts/migrations/migrate-02-decisions.js [--db <target>]
 *     [--source-db <name>] [--rollback]
 *     [--routing-map <path>] [--backup-dir <path>]
 *
 * Exit codes: 0 = PASS (migrate: migrated total == source total; rollback:
 * completed), 1 = refused / precondition failure / apply failure / count
 * mismatch, 2 = bad CLI usage.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Client } = require('pg');

const migrateOne = require('./migrate-01-canonical-db'); // reused by reference, never forked
const shared = require('./lib/verify15-shared'); // reused by reference: connect config, rowHash, applyDdl

// ─── PATHS / CONSTANTS ────────────────────────────────────────────────────

const MIGRATIONS_DIR = __dirname;
const ROUTING_MAP_PATH = path.join(MIGRATIONS_DIR, 'topic-prefix-to-project.json');
const BACKUP_DIR = path.join(MIGRATIONS_DIR, 'backups');

const SOURCE_TABLE = 'decisions';
const DEFAULT_SOURCE_DB = 'claude_policy_framework';
// Matches the real roster's loadBearingCols for this source_table (source-
// table-roster.json) -- same columns T3/T3b would hash if a generic T1 run
// ever touched this table, kept in lockstep deliberately.
const LOAD_BEARING_COLS = ['topic', 'decision', 'reason'];
// D-4/M-1: EXACTLY this statement and name -- a concurrent mm#18 PR bundles
// the identical statement; this script must never diverge from it.
const UNIQUE_INDEX_SQL = 'CREATE UNIQUE INDEX IF NOT EXISTS decisions_project_topic_unique ON decisions(project_id, topic)';
const SOURCE_MODEL_TAG = 'unknown-pre-migration';
const AUTHORING_MODE_TAG = 'verbose';

// D-9: diagnostic-only documentary baseline from CONSOLIDATION-RUNBOOK.md
// §16.2's table, keyed by MATCHED HINT (not resulting project_id, since
// several hints fold into one project). NEVER read by any pass/fail branch
// in this script -- printed purely so a reader can see the stale figure
// next to the live-derived count. §16.2 itself is a private planning
// document (gitignored, not distributed with this public repo), so its
// per-hint stale counts are private instance data too -- they live as
// OPTIONAL fields on the routing map (documentary_baseline_by_hint,
// documentary_total), the same gitignored-real / committed-synthetic-
// example split as the routing rules themselves
// (topic-prefix-to-project.json vs .example.json). A hint absent from the
// loaded map's documentary_baseline_by_hint means no clean single number is
// available for it (a composite bucket, an unlisted singleton, or simply no
// map supplied one) -- reported as "n/a (undocumented)", never fabricated.

// ─── CLI ARGS ─────────────────────────────────────────────────────────────

class UsageError extends Error {}

function parseArgs(argv) {
  const parsed = {
    db: null, sourceDb: null, rollback: false,
    routingMapPath: ROUTING_MAP_PATH, backupDir: BACKUP_DIR, help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--db') parsed.db = argv[++i];
    else if (a.startsWith('--db=')) parsed.db = a.slice('--db='.length);
    else if (a === '--source-db') parsed.sourceDb = argv[++i];
    else if (a.startsWith('--source-db=')) parsed.sourceDb = a.slice('--source-db='.length);
    else if (a === '--rollback') parsed.rollback = true;
    else if (a === '--routing-map') parsed.routingMapPath = argv[++i];
    else if (a.startsWith('--routing-map=')) parsed.routingMapPath = a.slice('--routing-map='.length);
    else if (a === '--backup-dir') parsed.backupDir = argv[++i];
    else if (a.startsWith('--backup-dir=')) parsed.backupDir = a.slice('--backup-dir='.length);
    else if (a === '--help' || a === '-h') parsed.help = true;
    else throw new UsageError(`Unknown argument: ${a}`);
  }
  if (!parsed.sourceDb) parsed.sourceDb = DEFAULT_SOURCE_DB;
  return parsed;
}

function printUsage() {
  console.log([
    'Usage: node scripts/migrations/migrate-02-decisions.js [--db <target>] [--source-db <name>]',
    '                                                        [--rollback] [--routing-map <path>] [--backup-dir <path>]',
    '',
    '  --db <name>          Target database (else MIGRATE_TARGET_DB env, else memory_manager_staging).',
    '                       Never reads HANDOFF_DB. Must already carry the decisions table',
    '                       (run migrate-14-seam-tables.js first).',
    '  --source-db <name>   Source database (default: claude_policy_framework). SELECT-only --',
    '                       this script never issues DDL/DML against it.',
    "  --rollback           Delete this source's migrated decisions + manifest rows instead of migrating.",
    '  --routing-map <path> Path to topic-prefix-to-project.json (default: alongside this script).',
    '  --backup-dir <path>  Directory for the timestamped source backup (default: scripts/migrations/backups).',
  ].join('\n'));
}

// ─── ROUTING MAP (D-1/D-2/D-10/D-12) ──────────────────────────────────────

function loadRoutingMap(routingMapPath) {
  if (!fs.existsSync(routingMapPath)) {
    console.error(`FATAL: routing map not found at "${routingMapPath}".`);
    console.error('This file carries private instance routing data and is gitignored, never committed.');
    console.error('See scripts/migrations/topic-prefix-to-project.example.json for the required shape,');
    console.error('or pass --routing-map <path> to point at a different file.');
    process.exit(1);
  }
  let raw;
  try {
    raw = fs.readFileSync(routingMapPath, 'utf8');
  } catch (err) {
    console.error(`FATAL: could not read routing map at "${routingMapPath}": ${err.message}`);
    process.exit(1);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    console.error(`FATAL: routing map at "${routingMapPath}" is not valid JSON: ${err.message}`);
    process.exit(1);
  }
  if (!Array.isArray(parsed.known_project_ids) || parsed.known_project_ids.length === 0) {
    console.error(`FATAL: routing map at "${routingMapPath}" must carry a non-empty known_project_ids array.`);
    process.exit(1);
  }
  if (!Array.isArray(parsed.rules) || parsed.rules.length === 0) {
    console.error(`FATAL: routing map at "${routingMapPath}" must carry a non-empty rules array.`);
    process.exit(1);
  }
  const knownSet = new Set(parsed.known_project_ids);
  const badRules = [];
  parsed.rules.forEach((rule, i) => {
    if (!rule || (rule.type !== 'LITERAL' && rule.type !== 'WILDCARD')) {
      badRules.push(`rule ${i}: type must be "LITERAL" or "WILDCARD", got ${JSON.stringify(rule && rule.type)}`);
      return;
    }
    if (typeof rule.prefix !== 'string' || !rule.prefix) {
      badRules.push(`rule ${i}: prefix must be a non-empty string`);
    }
    if (typeof rule.target !== 'string' || !rule.target) {
      badRules.push(`rule ${i}: target must be a non-empty string`);
      return;
    }
    // D-12: every rule target must be in known_project_ids, EXCEPT the six
    // "unmatched-*" owner-review buckets (D-2) -- those are deliberately
    // never real project_ids.
    if (!rule.target.startsWith('unmatched-') && !knownSet.has(rule.target)) {
      badRules.push(`rule ${i} (prefix="${rule.prefix}"): target "${rule.target}" is not in known_project_ids and is not an "unmatched-*" bucket`);
    }
  });
  if (badRules.length) {
    console.error(`FATAL: routing map at "${routingMapPath}" failed validation (D-12):`);
    for (const b of badRules) console.error(`  - ${b}`);
    process.exit(1);
  }
  return parsed;
}

/**
 * D-1/D-10: the formal classifier. LITERAL rules match on the topic's first
 * TWO dash-tokens (exact string equality); WILDCARD rules match on the
 * first dash-token only. First-match-wins, in the routing map's own array
 * order. Zero matches falls to `unmatched-<first-dash-token>` (never
 * guessed, never silently dropped -- flagged by the caller).
 *
 * source_project_hint is the exact token(s) the classifier actually keyed
 * on: rule.prefix for a matched rule, the bare first-dash-token for a
 * fallback -- an honest audit trail for EVERY row, not only the
 * successfully-routed ones.
 */
function classifyTopic(topic, routingMap) {
  const tokens = topic.split('-');
  const firstToken = tokens[0];
  const firstTwoTokens = tokens.slice(0, 2).join('-');
  for (const rule of routingMap.rules) {
    if (rule.type === 'LITERAL' && firstTwoTokens === rule.prefix) {
      return { projectId: rule.target, sourceProjectHint: rule.prefix };
    }
    if (rule.type === 'WILDCARD' && firstToken === rule.prefix) {
      return { projectId: rule.target, sourceProjectHint: rule.prefix };
    }
  }
  return { projectId: `unmatched-${firstToken}`, sourceProjectHint: firstToken };
}

// ─── SOURCE READ-ONLY GUARD ────────────────────────────────────────────────

/**
 * The source database is read-only infrastructure to this script -- SELECT
 * only, never DDL/DML. Enforced structurally, not merely by convention:
 * every query issued against the source client goes through this guard.
 */
async function sourceSelect(client, sql, params) {
  if (!/^\s*SELECT\b/i.test(sql)) {
    throw new Error(`Refusing non-SELECT query against the read-only source connection: ${sql.slice(0, 120)}`);
  }
  return client.query(sql, params);
}

// ─── BACKUP (read-only, timestamped) ──────────────────────────────────────

function timestampForFilename(d = new Date()) {
  return d.toISOString().replace(/[:.]/g, '-');
}

async function backupSourceTable(srcClient, sourceDb, backupDir) {
  const { rows } = await sourceSelect(
    srcClient,
    `SELECT id, session_num, topic, decision, reason, created_at FROM ${SOURCE_TABLE} ORDER BY id`
  );
  fs.mkdirSync(backupDir, { recursive: true });
  const fileName = `${sourceDb}-${SOURCE_TABLE}-backup-${timestampForFilename()}.json`;
  const filePath = path.join(backupDir, fileName);
  const payload = {
    source_db: sourceDb,
    source_table: SOURCE_TABLE,
    captured_at: new Date().toISOString(),
    row_count: rows.length,
    rows,
  };
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), 'utf8');
  return { filePath, rowCount: rows.length };
}

// ─── PRECONDITIONS (D-3/D-4) ───────────────────────────────────────────────

/** D-3: rows failing `topic = lower(trim(topic))`. Empty result = PASS. */
async function checkTopicNormalization(srcClient) {
  const { rows } = await sourceSelect(
    srcClient,
    `SELECT id, topic FROM ${SOURCE_TABLE} WHERE topic <> lower(trim(topic)) ORDER BY id`
  );
  return rows;
}

/** D-4/M-1: duplicate topics in the source. Empty result = PASS. */
async function checkDuplicateTopics(srcClient) {
  const { rows } = await sourceSelect(
    srcClient,
    `SELECT topic, COUNT(*) AS n FROM ${SOURCE_TABLE} GROUP BY topic HAVING COUNT(*) > 1 ORDER BY topic`
  );
  return rows;
}

// ─── CONTENT FINGERPRINT (T1 convention) ──────────────────────────────────

/**
 * md5(concat(per-row rowHash ordered by source row id)) -- the SAME formula
 * verify-15-t1-snapshot.js uses (T1's own documented convention: an order-
 * DEPENDENT aggregate, T8-idempotency-only, never a source-vs-target
 * comparison field). Reuses shared.rowHash (NULL sentinel, JSON.stringify
 * of the value array, no .trim()) so a future T8 run over this slice's
 * manifest row is comparing apples to apples.
 */
function computeContentFingerprint(sliceRowsOrderedById) {
  const concatenated = sliceRowsOrderedById.map((r) => shared.rowHash(LOAD_BEARING_COLS, r)).join('');
  return crypto.createHash('md5').update(concatenated).digest('hex');
}

// ─── PER-SLICE UPSERT + MANIFEST (D-5/D-11) ───────────────────────────────

/**
 * Upsert one derived-project slice's decisions rows AND delete-and-reinsert
 * its migration_manifest + migration_manifest_row_hashes rows, all inside
 * ONE transaction (D-5/D-11) -- re-run idempotent on both tables together.
 */
async function upsertSlice(tgtClient, sourceDb, projectId, sliceRows) {
  await tgtClient.query('BEGIN');
  try {
    // Review-round-1 fix: a topic in THIS slice may already exist in
    // `decisions` under a DIFFERENT project_id from a prior run whose
    // routing map classified it differently (D-2's documented owner-review
    // workflow, either direction: unmatched-* -> real rule, or a rule
    // removed -> unmatched-*). Topics are globally unique WITHIN this
    // migration's own source (D-4) -- they are NOT globally unique across
    // the whole `decisions` table, which other writers (a live
    // memory_upsert/persist_decisions path, hand-run SQL, a future second
    // migration) can and do also populate. Review-round-2 fix: this DELETE
    // MUST be scoped by `source_model = SOURCE_MODEL_TAG` -- the same
    // pattern runRollback() already used correctly -- so it can only ever
    // touch a row THIS SCRIPT wrote under a prior classification, never a
    // legitimate, unrelated row that merely happens to share a topic
    // string with a currently-migrating one under a different project_id
    // (an explicitly supported case per the table's own (project_id,
    // topic) unique constraint, not a degenerate one). An independent
    // reviewer reproduced the unscoped version silently deleting live,
    // non-migration data -- this guard is the fix, not an enhancement.
    // Logged, never silent; decisions_audit (once wired) preserves the
    // removed row in audit_log.
    const sliceTopics = sliceRows.map((r) => r.topic);
    if (sliceTopics.length > 0) {
      const { rows: reclassified } = await tgtClient.query(
        `DELETE FROM decisions WHERE topic = ANY($1::text[]) AND project_id <> $2 AND source_model = $3 RETURNING topic, project_id`,
        [sliceTopics, projectId, SOURCE_MODEL_TAG]
      );
      for (const r of reclassified) {
        console.log(`  [RECLASSIFY] topic="${r.topic}": removed stale row under project_id="${r.project_id}" (now project_id="${projectId}")`);
      }
    }

    for (const row of sliceRows) {
      await tgtClient.query(
        `INSERT INTO decisions
           (project_id, session_num, topic, decision, reason, source_project_hint, source_model, authoring_mode)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (project_id, topic) DO UPDATE SET
           session_num         = EXCLUDED.session_num,
           decision             = EXCLUDED.decision,
           reason               = EXCLUDED.reason,
           source_project_hint  = EXCLUDED.source_project_hint,
           source_model         = EXCLUDED.source_model,
           authoring_mode       = EXCLUDED.authoring_mode`,
        [projectId, row.session_num, row.topic, row.decision, row.reason, row.sourceProjectHint, SOURCE_MODEL_TAG, AUTHORING_MODE_TAG]
      );
    }

    await tgtClient.query(
      `DELETE FROM migration_manifest WHERE source_db=$1 AND source_table=$2 AND project_id_or_null=$3`,
      [sourceDb, SOURCE_TABLE, projectId]
    );
    await tgtClient.query(
      `DELETE FROM migration_manifest_row_hashes WHERE source_db=$1 AND source_table=$2 AND project_id_or_null=$3`,
      [sourceDb, SOURCE_TABLE, projectId]
    );

    const orderedById = [...sliceRows].sort((a, b) => a.id - b.id);
    const fingerprint = computeContentFingerprint(orderedById);
    await tgtClient.query(
      `INSERT INTO migration_manifest (source_db, source_table, project_id_or_null, row_count, content_fingerprint, excluded_reason)
       VALUES ($1,$2,$3,$4,$5,NULL)`,
      [sourceDb, SOURCE_TABLE, projectId, sliceRows.length, fingerprint]
    );
    for (const row of orderedById) {
      const h = shared.rowHash(LOAD_BEARING_COLS, row);
      await tgtClient.query(
        `INSERT INTO migration_manifest_row_hashes (source_db, source_table, project_id_or_null, source_row_id, source_hash)
         VALUES ($1,$2,$3,$4,$5)`,
        [sourceDb, SOURCE_TABLE, projectId, String(row.id), h]
      );
    }

    await tgtClient.query('COMMIT');
  } catch (err) {
    await tgtClient.query('ROLLBACK');
    throw err;
  }
}

// ─── ORPHANED-SLICE RECONCILIATION (review-round-1 fix) ───────────────────

/**
 * A migration_manifest slice (+ its row_hashes) for this (source_db,
 * source_table) whose project_id_or_null is NOT in the CURRENT
 * classification's slice set means zero source topics route there THIS
 * run -- the per-slice upsertSlice() loop never visits it (there is no
 * slice to iterate), so its own topic-scoped delete inside upsertSlice()
 * can never reach it either. Example: `unmatched-cache-warmup` had exactly
 * one topic, which just got a real routing rule -- the OLD slice is now
 * fully vacated, not merely shrunk. This runs in its OWN transaction,
 * deliberately separate from any per-slice transaction (D-5/D-11's
 * atomicity guarantee is scoped to "this slice's decisions upsert + this
 * slice's manifest row together" -- a vacated slice has no decisions
 * upsert to pair with). Idempotent: re-running with an unchanged
 * currentProjectIds set deletes nothing.
 */
async function reconcileOrphanedManifestSlices(tgtClient, sourceDb, currentProjectIds) {
  await tgtClient.query('BEGIN');
  let deletedManifestSlices = 0;
  let deletedHashRows = 0;
  let orphanedProjectIds = [];
  try {
    const delHashes = await tgtClient.query(
      `DELETE FROM migration_manifest_row_hashes WHERE source_db=$1 AND source_table=$2 AND project_id_or_null <> ALL($3::text[])`,
      [sourceDb, SOURCE_TABLE, currentProjectIds]
    );
    deletedHashRows = delHashes.rowCount;
    const delManifest = await tgtClient.query(
      `DELETE FROM migration_manifest WHERE source_db=$1 AND source_table=$2 AND project_id_or_null <> ALL($3::text[]) RETURNING project_id_or_null`,
      [sourceDb, SOURCE_TABLE, currentProjectIds]
    );
    deletedManifestSlices = delManifest.rowCount;
    orphanedProjectIds = [...new Set(delManifest.rows.map((r) => r.project_id_or_null))];
    await tgtClient.query('COMMIT');
  } catch (err) {
    await tgtClient.query('ROLLBACK');
    throw err;
  }
  for (const pid of orphanedProjectIds) {
    console.log(`  [RECONCILE] removed orphaned migration_manifest slice project_id="${pid}" (no source topic currently classifies to it)`);
  }
  return { deletedManifestSlices, deletedHashRows, orphanedProjectIds };
}

// ─── RECONCILIATION GATE (review-round-1 fix) ─────────────────────────────

/**
 * Post-run self-check, independent of the per-slice/orphan-cleanup logic
 * above: proves the end state is actually consistent rather than trusting
 * that the operations above did their job. (a) no current source topic
 * maps to more than one live decisions row THIS MIGRATION OWNS (source_
 * model = SOURCE_MODEL_TAG, review-round-2 fix -- see the scoping note in
 * the function body for what this claims and deliberately does NOT
 * claim); (b) the live manifest slice set for this source equals the
 * current classification's slice set exactly (no missing, no extra/
 * orphaned). Returns an array of human-readable problem strings; empty =
 * clean. This is the check that makes re-classification drift VISIBLE --
 * the round-1 independent-reviewer-found bug was that MIGRATION_RESULT:
 * PASS could not see a stale duplicate/orphaned slice left behind by a
 * prior run. NOTE (round 2): this gate runs AFTER upsertSlice()'s
 * reconciliation DELETE has already committed -- it can only detect
 * inconsistency that SURVIVES the delete, not an over-broad delete that
 * already ran. The DELETE's own source_model guard (upsertSlice()) is
 * what prevents the over-broad delete in the first place; this gate is a
 * second, independent check, not a substitute for that guard.
 */
async function verifyReconciliation(tgtClient, sourceDb, sourceTopics, currentProjectIds) {
  const problems = [];
  // Review-round-2 fix: this duplicate-topic check MUST be scoped to
  // source_model = SOURCE_MODEL_TAG, matching the DELETE guard in
  // upsertSlice() above. What this gate claims: "no topic this migration
  // classified has more than one row THIS MIGRATION OWNS." What it
  // deliberately does NOT claim, and cannot: that a source topic is
  // unique across the WHOLE decisions table -- a legitimate, unrelated
  // row (a live memory_upsert/persist_decisions write, hand-run SQL, or a
  // future second migration's own tag) sharing that topic string under a
  // different project_id is an explicitly supported case (the table's
  // unique constraint is (project_id, topic), not (topic) alone) and must
  // neither fail this gate nor be touched by it. Unscoped, this check
  // would false-positive the very first time a live writer's topic
  // happened to collide with a currently-migrating one.
  if (sourceTopics.length > 0) {
    const { rows: dupTopics } = await tgtClient.query(
      `SELECT topic, COUNT(*) AS n FROM decisions WHERE topic = ANY($1::text[]) AND source_model = $2 GROUP BY topic HAVING COUNT(*) > 1`,
      [sourceTopics, SOURCE_MODEL_TAG]
    );
    for (const r of dupTopics) {
      problems.push(`topic=${JSON.stringify(r.topic)} maps to ${r.n} live decisions row(s) tagged source_model='${SOURCE_MODEL_TAG}' (expected exactly 1)`);
    }
  }
  const { rows: manifestRows } = await tgtClient.query(
    `SELECT project_id_or_null FROM migration_manifest WHERE source_db=$1 AND source_table=$2`,
    [sourceDb, SOURCE_TABLE]
  );
  const liveSliceSet = new Set(manifestRows.map((r) => r.project_id_or_null));
  const expectedSliceSet = new Set(currentProjectIds);
  const missing = [...expectedSliceSet].filter((p) => !liveSliceSet.has(p));
  const extra = [...liveSliceSet].filter((p) => !expectedSliceSet.has(p));
  if (missing.length) problems.push(`migration_manifest is missing slice(s) for: ${missing.join(', ')}`);
  if (extra.length) problems.push(`migration_manifest carries orphaned/unexpected slice(s) for: ${extra.join(', ')}`);
  return problems;
}

// ─── REPORT (D-9) ──────────────────────────────────────────────────────────

function printReport(slices, sourceTotal, routingMap) {
  // D-9: the documentary baseline is OPTIONAL data carried on the routing
  // map itself (documentary_baseline_by_hint / documentary_total) -- absent
  // entirely for the committed synthetic example, present only on whichever
  // real, gitignored routing map file the caller points --routing-map at.
  const baselineByHint = (routingMap && routingMap.documentary_baseline_by_hint) || {};
  const baselineTotal = routingMap && routingMap.documentary_total;
  console.log('Per-slice report (documentary baseline is an optional STALE count carried on the routing map, diagnostic only, never a gate -- D-9):');
  let migratedTotal = 0;
  const unmatchedSlices = [];
  for (const [projectId, rows] of slices) {
    migratedTotal += rows.length;
    if (projectId.startsWith('unmatched-')) unmatchedSlices.push(projectId);
    const hintCounts = new Map();
    for (const r of rows) hintCounts.set(r.sourceProjectHint, (hintCounts.get(r.sourceProjectHint) || 0) + 1);
    console.log(`  - project_id="${projectId}": live=${rows.length}`);
    for (const [hint, n] of hintCounts) {
      const baseline = baselineByHint[hint];
      const baselineStr = baseline === undefined ? 'n/a (undocumented)' : String(baseline);
      console.log(`      hint="${hint}": documentary baseline (stale) vs live: ${baselineStr} vs ${n}`);
    }
  }
  const baselineTotalStr = baselineTotal === undefined ? 'n/a (undocumented)' : String(baselineTotal);
  console.log(`  TOTAL: documentary baseline (stale) vs live: ${baselineTotalStr} vs ${sourceTotal}`);
  console.log(`  migrated total = ${migratedTotal} (must equal live source total = ${sourceTotal})`);
  if (unmatchedSlices.length) {
    console.log(`  [FLAG] ${unmatchedSlices.length} unmatched bucket(s) -- owner review required before real routing: ${unmatchedSlices.join(', ')}`);
  }
  return migratedTotal;
}

// ─── ROLLBACK MODE (D-7/D-8) ───────────────────────────────────────────────

async function runRollback(srcClient, tgtClient, sourceDb) {
  // Review-round-1 fix: scope the decisions deletion by the CURRENT
  // source's TOPIC set, not by re-deriving source_project_hint through
  // whatever routing map happens to be loaded right now. Topics are
  // globally unique (D-4) and require no map at all to identify -- hint-
  // based scoping was drift-vulnerable to the exact scenario the
  // reconciliation fix (upsertSlice/reconcileOrphanedManifestSlices)
  // addresses: if the routing map has been edited since the original run
  // (D-2's documented owner-review workflow), the recomputed hint set
  // would not match the source_project_hint values actually persisted on
  // rows classified under the OLD map, and rollback could miss them.
  // source_model='unknown-pre-migration' ALONE is not source-specific (a
  // future pipeline_pipeline-sourced migration into the SAME decisions
  // table would tag its rows identically) -- see this script's blind-spot
  // note in the PR body for the residual limit once that migration exists.
  const { rows: sourceRows } = await sourceSelect(srcClient, `SELECT topic FROM ${SOURCE_TABLE}`);
  const topics = sourceRows.map((r) => r.topic);
  console.log(`  [ROLLBACK] scoping decisions deletion by source_model='${SOURCE_MODEL_TAG}' AND topic IN (${topics.length} topic(s) from current source content)`);

  await tgtClient.query('BEGIN');
  let deletedDecisions = 0;
  let deletedManifest = 0;
  let deletedHashes = 0;
  try {
    const delRes = await tgtClient.query(
      `DELETE FROM decisions WHERE source_model = $1 AND topic = ANY($2::text[])`,
      [SOURCE_MODEL_TAG, topics]
    );
    deletedDecisions = delRes.rowCount;
    const delManifest = await tgtClient.query(
      `DELETE FROM migration_manifest WHERE source_db=$1 AND source_table=$2`,
      [sourceDb, SOURCE_TABLE]
    );
    deletedManifest = delManifest.rowCount;
    const delHashes = await tgtClient.query(
      `DELETE FROM migration_manifest_row_hashes WHERE source_db=$1 AND source_table=$2`,
      [sourceDb, SOURCE_TABLE]
    );
    deletedHashes = delHashes.rowCount;
    await tgtClient.query('COMMIT');
  } catch (err) {
    await tgtClient.query('ROLLBACK');
    throw err;
  }

  console.log(`  [OK] deleted ${deletedDecisions} decisions row(s), ${deletedManifest} migration_manifest row(s), ${deletedHashes} migration_manifest_row_hashes row(s)`);
  // D-8: expected audit_log append note.
  console.log(`  [NOTE] (D-8) if decisions_audit is wired (migrate-13-agent-exchange.js), ${deletedDecisions} audit_log row(s) were just appended recording these deletes -- EXPECTED and CORRECT, never itself reverted; the append-only ledger IS the record that a migration-then-rollback occurred.`);
  console.log(`ROLLBACK_RESULT: PASS (deleted ${deletedDecisions} decisions row(s))`);
  return { deletedDecisions, deletedManifest, deletedHashes };
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

  const { name: target, source: targetSource } = migrateOne.resolveTargetDb({ db: parsed.db });
  if (!migrateOne.DB_NAME_RE.test(target)) {
    console.error(`Invalid database name "${target}" (from ${targetSource}) — must match /^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/.`);
    process.exit(1);
  }
  // migrate-02 only ever targets CANON/STAGING (memory_manager or a
  // *_staging name) — it has no --project-id flag and never will, so
  // projectId is deliberately left undefined. A PER_PROJECT_ENGINE result
  // here would mean this script's target resolution regressed into naming
  // something that isn't CANON/STAGING, which is a bug, not a valid mode.
  const classification = await migrateOne.classifyTarget({ dbName: target, projectId: undefined });
  if (!classification.allowed) {
    console.error(`Refused: ${classification.reason}`);
    console.error(
      classification.connectionOpened
        ? '(read-only probe opened and closed.)'
        : `(resolved from ${targetSource} — no database connection was opened.)`
    );
    process.exit(1);
  }
  if (classification.branch !== 'CANON' && classification.branch !== 'STAGING') {
    console.error(
      `Refused: migrate-02 only targets CANON/STAGING databases, got branch=${classification.branch} ` +
      `for "${target}" (resolved from ${targetSource}).`
    );
    process.exit(1);
  }
  if (!migrateOne.DB_NAME_RE.test(parsed.sourceDb)) {
    console.error(`Invalid source database name "${parsed.sourceDb}" — must match /^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/.`);
    process.exit(1);
  }
  if (parsed.sourceDb === target) {
    console.error('Refused: --source-db and the target database must not be the same.');
    process.exit(1);
  }

  const routingMap = loadRoutingMap(parsed.routingMapPath);

  console.log(`migrate-02-decisions: source="${parsed.sourceDb}" target="${target}" (resolved from ${targetSource}) mode=${parsed.rollback ? 'ROLLBACK' : 'MIGRATE'}`);

  const srcClient = new Client(migrateOne.pgConfig(parsed.sourceDb));
  const tgtClient = new Client(migrateOne.pgConfig(target));
  try {
    await srcClient.connect();
  } catch (err) {
    console.error(`Could not connect to source database "${parsed.sourceDb}": ${err.message}`);
    process.exit(1);
  }
  try {
    await tgtClient.connect();
  } catch (err) {
    console.error(`Could not connect to target database "${target}": ${err.message}`);
    await srcClient.end();
    process.exit(1);
  }

  let exitCode = 0;
  try {
    const { rows: tblRows } = await tgtClient.query(
      `SELECT 1 FROM information_schema.tables WHERE table_schema = current_schema() AND table_name = 'decisions' AND table_type = 'BASE TABLE'`
    );
    if (tblRows.length === 0) {
      console.error(`Refused: target "${target}" is missing the "decisions" table.`);
      console.error('Run migrate-14-seam-tables.js against this target first, then re-run this script. Nothing was applied.');
      process.exitCode = 1;
      return;
    }

    await shared.applyDdl(tgtClient); // migration_manifest + migration_manifest_row_hashes + siblings, idempotent

    if (parsed.rollback) {
      await runRollback(srcClient, tgtClient, parsed.sourceDb);
      exitCode = 0;
      return;
    }

    // ── Backup (read-only, step 1) ──────────────────────────────────────
    const backup = await backupSourceTable(srcClient, parsed.sourceDb, parsed.backupDir);
    console.log(`  [BACKUP] ${backup.rowCount} row(s) -> ${backup.filePath}`);

    // ── Preconditions (D-3/D-4) -- loud FAIL before ANY insert ──────────
    const badTopics = await checkTopicNormalization(srcClient);
    if (badTopics.length) {
      console.error(`Refused (D-3): ${badTopics.length} topic(s) fail "topic = lower(trim(topic))":`);
      for (const r of badTopics.slice(0, 20)) console.error(`  - id=${r.id} topic=${JSON.stringify(r.topic)}`);
      if (badTopics.length > 20) console.error(`  ... and ${badTopics.length - 20} more`);
      console.error('No silent normalization is ever applied. Nothing was inserted.');
      process.exitCode = 1;
      return;
    }

    const dupes = await checkDuplicateTopics(srcClient);
    if (dupes.length) {
      console.error(`Refused (D-4/M-1): ${dupes.length} duplicate topic(s) in source:`);
      for (const r of dupes) console.error(`  - topic=${JSON.stringify(r.topic)} count=${r.n}`);
      console.error('Nothing was inserted.');
      process.exitCode = 1;
      return;
    }

    // ── Bundled idempotent DDL (D-4/M-1) ─────────────────────────────────
    await tgtClient.query(UNIQUE_INDEX_SQL);
    console.log(`  [OK] ${UNIQUE_INDEX_SQL}`);

    // ── Fetch + classify ──────────────────────────────────────────────
    const { rows: sourceRows } = await sourceSelect(
      srcClient,
      `SELECT id, session_num, topic, decision, reason FROM ${SOURCE_TABLE} ORDER BY id`
    );

    const slices = new Map(); // project_id -> row[]
    for (const row of sourceRows) {
      const { projectId, sourceProjectHint } = classifyTopic(row.topic, routingMap);
      const enriched = { ...row, sourceProjectHint };
      if (!slices.has(projectId)) slices.set(projectId, []);
      slices.get(projectId).push(enriched);
    }

    // ── Upsert + manifest, one transaction PER SLICE (D-5/D-11) ─────────
    // Each slice's own transaction also reconciles any stale row for this
    // slice's topics left behind under a DIFFERENT project_id by a prior
    // run's classification (review-round-1 fix, see upsertSlice()).
    for (const [projectId, rows] of slices) {
      await upsertSlice(tgtClient, parsed.sourceDb, projectId, rows);
      console.log(`  [OK] project_id="${projectId}": upserted ${rows.length} row(s) + manifest slice`);
    }

    // ── Orphaned-slice reconciliation (review-round-1 fix) ───────────────
    // A project_id that ZERO current topics route to (e.g. an
    // unmatched-* bucket fully vacated by a new rule) has no slice in
    // `slices` for the loop above to ever visit -- clean it up separately.
    const currentProjectIds = [...slices.keys()];
    const orphanCleanup = await reconcileOrphanedManifestSlices(tgtClient, parsed.sourceDb, currentProjectIds);
    if (orphanCleanup.deletedManifestSlices > 0) {
      console.log(`  [OK] reconciliation: removed ${orphanCleanup.deletedManifestSlices} orphaned migration_manifest slice(s), ${orphanCleanup.deletedHashRows} row_hashes row(s)`);
    }

    // ── Report ────────────────────────────────────────────────────────
    const migratedTotal = printReport(slices, sourceRows.length, routingMap);
    const rowCountPass = migratedTotal === sourceRows.length;

    // ── Reconciliation gate (review-round-1 fix) ─────────────────────────
    // Independent self-check: proves the end state is actually consistent
    // rather than trusting the operations above did their job. This is
    // the check that makes re-classification drift VISIBLE -- previously
    // MIGRATION_RESULT: PASS could not see a stale duplicate/orphaned
    // slice left behind by a prior run (both runs of the independent
    // reviewer's reproduction printed PASS).
    const sourceTopics = sourceRows.map((r) => r.topic);
    const reconciliationProblems = await verifyReconciliation(tgtClient, parsed.sourceDb, sourceTopics, currentProjectIds);
    if (reconciliationProblems.length) {
      console.error(`Refused (reconciliation gate): the post-run state is inconsistent (${reconciliationProblems.length} problem(s)):`);
      for (const p of reconciliationProblems) console.error(`  - ${p}`);
    }

    const pass = rowCountPass && reconciliationProblems.length === 0;
    console.log(`MIGRATION_RESULT: ${pass ? 'PASS' : 'FAIL'} (source=${sourceRows.length}, migrated=${migratedTotal}, reconciliation_problems=${reconciliationProblems.length})`);
    exitCode = pass ? 0 : 1;
  } finally {
    await srcClient.end();
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
  loadRoutingMap,
  classifyTopic,
  sourceSelect,
  timestampForFilename,
  backupSourceTable,
  checkTopicNormalization,
  checkDuplicateTopics,
  computeContentFingerprint,
  upsertSlice,
  reconcileOrphanedManifestSlices,
  verifyReconciliation,
  printReport,
  runRollback,
  ROUTING_MAP_PATH,
  BACKUP_DIR,
  SOURCE_TABLE,
  DEFAULT_SOURCE_DB,
  LOAD_BEARING_COLS,
  UNIQUE_INDEX_SQL,
  SOURCE_MODEL_TAG,
  AUTHORING_MODE_TAG,
};
