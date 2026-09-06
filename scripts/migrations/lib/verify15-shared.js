'use strict';

/**
 * verify15-shared.js
 *
 * Shared helpers for the scripts/migrations/verify-15-*.js acceptance
 * battery (§15 of the consolidation runbook, local planning doc). Every
 * verify-15-*.js script imports from here rather than re-implementing:
 *   - pg connection config + connect() (same env-var convention as
 *     migrate-01-canonical-db.js: PGHOST/PGPORT/PGUSER/PGPASSWORD)
 *   - target-DB resolution + refusal classification (reuses migrate-01's
 *     classifyTarget/DB_NAME_RE directly — never a second classifier)
 *   - roster loading + total-classification shape validation (T0's
 *     source-table-roster.json)
 *   - row hashing (T3's reference-implementation algorithm: NULL sentinel,
 *     no .trim(), JSON.stringify of the value array, md5) — reused by T1
 *     (source snapshot), T3/T3b (live comparison), and test fixtures
 *   - DDL: CREATE TABLE IF NOT EXISTS for every shared table this battery
 *     (or a migrate-NN-*.js script) reads/writes (migration_manifest,
 *     migration_manifest_row_hashes, memory_manager_staging_row_hashes,
 *     dual_write_shim_window, old_store_row_hashes, containment_evidence,
 *     promotion_conflict_log, own_graph_migration_ids) — registered here,
 *     never as a private DDL block inside an individual script, so T0's
 *     live-table classification (verify-15-t0-roster.js) recognizes every
 *     one of them as battery/engine infrastructure via
 *     getBatteryInfraTables() below
 *   - containment_evidence row writer (T4/F1-F4 evidence, §15.2.1)
 *
 * NEVER connects to claude_memory_eval_test, claude_policy_framework, any
 * pipeline_* DB, or the live memory_manager_staging in TEST code — that
 * refusal posture is enforced by the caller (test/migrations/test-verify-15.js
 * always passes an explicit scratch _staging-suffixed name) and by
 * resolveAndClassifyTargetDb() below refusing anything migrate-01's own
 * classifyTarget refuses, in every script, before any connection is opened.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Client } = require('pg');

const MIGRATIONS_DIR = path.resolve(__dirname, '..');

// migrate-01-canonical-db.js already exports a total-classification target
// resolver (allow: memory_manager / memory_manager_staging / *_staging;
// refuse everything else, including claude_memory_eval_test, pipeline_*,
// claude_policy_framework, and any unrecognized name — default branch is
// REFUSE). Reused verbatim rather than re-implemented (closes the "second
// hand-maintained classifier" hazard this canon forbids).
const migrateOne = require('../migrate-01-canonical-db');

// ─── PG CONNECTION CONFIG (same convention as migrate-01-canonical-db.js) ────

function pgConfig(database) {
  return {
    host: process.env.PGHOST || 'localhost',
    port: parseInt(process.env.PGPORT || '5432', 10),
    user: process.env.PGUSER || 'postgres',
    password: process.env.PGPASSWORD || 'postgres',
    database,
  };
}

async function connect(database) {
  const client = new Client(pgConfig(database));
  await client.connect();
  return client;
}

// ─── TARGET RESOLUTION (shared across every verify-15-*.js script) ──────────

/**
 * Minimal CLI arg parser shared by the battery scripts: only --db is common
 * to all of them (some add their own flags on top — see each script). Not a
 * full parser; each script slices its own extra args out of argv first if it
 * needs to.
 */
function parseDbFlag(argv) {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--db') return argv[i + 1];
    if (argv[i].startsWith('--db=')) return argv[i].slice('--db='.length);
  }
  return null;
}

/**
 * Resolve + classify the target (staging) database, refusing BEFORE any
 * connection is opened — identical posture to migrate-01-canonical-db.js.
 * Exits the process with a clear refusal message on a disallowed name;
 * returns { name, source } on success.
 */
async function resolveAndClassifyTargetDb(argv) {
  const dbFlag = parseDbFlag(argv);
  const { name, source } = migrateOne.resolveTargetDb({ db: dbFlag });
  if (!migrateOne.DB_NAME_RE.test(name)) {
    console.error(`Invalid database name "${name}" (from ${source}) — must match /^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/.`);
    process.exit(1);
  }
  // The verify-15-*.js battery only ever targets CANON/STAGING (it has no
  // --project-id flag) — projectId is deliberately left undefined.
  const classification = await migrateOne.classifyTarget({ dbName: name, projectId: undefined });
  if (!classification.allowed) {
    console.error(`Refused: ${classification.reason}`);
    console.error(
      classification.connectionOpened
        ? '(read-only probe opened and closed.)'
        : `(resolved from ${source} — no database connection was opened.)`
    );
    process.exit(1);
  }
  return { name, source };
}

/**
 * Resolve an arbitrary SOURCE database name (--source-db flag or SOURCE_DB
 * env) through the SAME classifier — a source connection is exactly as
 * dangerous to get wrong as a target connection, so it gets the same
 * refuse-by-default posture. Unlike the target resolver, there is no
 * built-in default: a source must be named explicitly.
 */
function resolveAndClassifySourceDb(argv) {
  let name = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--source-db') { name = argv[i + 1]; break; }
    if (argv[i].startsWith('--source-db=')) { name = argv[i].slice('--source-db='.length); break; }
  }
  if (!name) name = process.env.SOURCE_DB || null;
  if (!name) return null;
  if (!migrateOne.DB_NAME_RE.test(name)) {
    console.error(`Invalid source database name "${name}" — must match /^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/.`);
    process.exit(1);
  }
  return name;
}

// ─── ROSTER LOADING (T0's total classification, read by T0/T3/T5/T6) ────────

const ROSTER_ENV_VAR = 'SOURCE_TABLE_ROSTER';
const ROSTER_EXAMPLE_FILE = 'source-table-roster.example.json';
const REQUIRED_ROSTER_FIELDS = [
  'source_db', 'source_table', 'targetTable', 'loadBearingCols',
  'hasContentBearingText', 'requires_project_id_scope',
];

function resolveRosterPath() {
  return process.env[ROSTER_ENV_VAR] || path.join(MIGRATIONS_DIR, 'source-table-roster.json');
}

/**
 * Validate the roster's SHAPE (every entry carries the fields every
 * verify-15-*.js script depends on) — not its CONTENT against the schema
 * sections (that is verify-15-t0-roster-completeness.js's separate job, per
 * spec: roster shape and roster completeness are deliberately two different
 * checks so a shape bug and a completeness gap fail with distinct, legible
 * messages instead of one script silently covering both).
 */
function validateRosterShape(roster, rosterPath) {
  const errors = [];
  roster.forEach((entry, i) => {
    for (const field of REQUIRED_ROSTER_FIELDS) {
      if (!(field in entry)) {
        errors.push(`entry ${i} (source_table=${entry.source_table || '?'}) missing required field "${field}"`);
      }
    }
  });
  if (errors.length) {
    console.error(`FATAL: source table roster at "${rosterPath}" failed shape validation:`);
    for (const e of errors) console.error(`  - ${e}`);
    process.exit(1);
  }
}

const NET_NEW_PREFIX = 'net-new:';

/**
 * Total classification of a roster entry's `source_db` SHAPE:
 *   - `net-new:<non-empty store name>` → SOURCELESS. These are §9/§17/§18
 *     tables (agent_exchange, audit_log, model_registry,
 *     embedding_providers, routing_profiles, routing_session_overrides,
 *     turn_usage, session_usage, …) that MUST have a roster entry — for
 *     T0-completeness's bidirectional match against inventory-manifest.json
 *     and for T5/T6's roster-driven target-side enumeration — but have NO
 *     migration source: nothing is ever migrated INTO them from an old
 *     store, so T1 will never snapshot one and no migration_manifest row
 *     will ever exist for one. (Snapshotting them with a row_count=0
 *     manifest row would be WRONG in the other direction: it would make T2
 *     expect exactly 0 target rows forever, spuriously failing the moment
 *     the live harness writes real routing/telemetry/exchange data.)
 *   - everything else (a plain database name, or a `filesystem:<path>`
 *     markdown source) → SOURCED — the DEFAULT, STRICT branch. An
 *     unrecognized `source_db` shape lands here, not in a silent
 *     "unknown → skip" bucket: the failure mode for a shape this
 *     classifier doesn't recognize is FRICTION (an ordinary
 *     migration_manifest requirement it then fails, which an operator
 *     investigates), never a silent escape from coverage.
 * A malformed `net-new:` value (empty store-name suffix) is a LOUD FATAL,
 * not silently folded into either branch — see loadRoster's call to this
 * for every entry at load time.
 *
 * @param {string} sourceDb
 * @param {string} [contextLabel] — extra context for the fatal-error message
 * @returns {{ isSourceless: boolean, storeName: string|null }}
 */
function classifyRosterSourceDb(sourceDb, contextLabel) {
  if (typeof sourceDb === 'string' && sourceDb.startsWith(NET_NEW_PREFIX)) {
    const storeName = sourceDb.slice(NET_NEW_PREFIX.length);
    if (!storeName) {
      console.error(
        `FATAL: malformed net-new source_db "${sourceDb}"${contextLabel ? ` (${contextLabel})` : ''} — ` +
        `the "${NET_NEW_PREFIX}" prefix requires a non-empty store name, e.g. "${NET_NEW_PREFIX}memory_manager".`
      );
      process.exit(1);
    }
    return { isSourceless: true, storeName };
  }
  return { isSourceless: false, storeName: null };
}

/**
 * Partition a roster into SOURCED entries (ordinary migration_manifest
 * coverage requirement applies) and SOURCELESS entries (net-new:-prefixed,
 * no migration source — see classifyRosterSourceDb). The single function
 * every verify-15-*.js script should call rather than re-implementing the
 * `source_db.startsWith('net-new:')` check inline.
 */
function partitionRoster(roster) {
  const sourced = [];
  const sourceless = [];
  for (const entry of roster) {
    const { isSourceless } = classifyRosterSourceDb(entry.source_db, `roster entry targetTable=${entry.targetTable}`);
    if (isSourceless) sourceless.push(entry);
    else sourced.push(entry);
  }
  return { sourced, sourceless };
}

/**
 * Validate every roster entry's source_db SHAPE (fatal on a malformed
 * `net-new:` value) at load time — a shape bug in the roster surfaces
 * immediately, at the loader, not later inside whichever check happens to
 * touch that entry first.
 */
function validateRosterSourceDbShapes(roster, rosterPath) {
  roster.forEach((entry) => {
    classifyRosterSourceDb(entry.source_db, `roster entry targetTable=${entry.targetTable}, from ${rosterPath}`);
  });
}

/**
 * Validate that the SOURCED and SOURCELESS partitions' targetTable sets
 * are DISJOINT — a categorical fix (final-review finding, PR #152), not a
 * per-consumer patch. Without this, a targetTable claimed by BOTH a
 * sourced entry (a real migration source) and a sourceless entry (a
 * net-new:-classified "no source exists" claim) is a self-contradictory
 * roster state: T3b's two checks would handle it inconsistently
 * (reverseContainment would over-exclude it via sourcelessTargetTables;
 * totalRowcountReconciliation would under-exclude it, since `sourced`
 * still includes the table's OTHER, sourced entries). Making the
 * inconsistent state UNREPRESENTABLE at load time — rather than patching
 * every downstream consumer to reason about a table that is simultaneously
 * "definitely has no source" and "definitely has a source" — is the
 * categorical fix: a genuinely net-new table cannot also have a legacy
 * source, and a table with any real source must be sourced EVERYWHERE it
 * appears in the roster, never partially.
 */
function validateRosterPartitionDisjoint(roster, rosterPath) {
  const { sourced, sourceless } = partitionRoster(roster);
  const sourcedByTable = new Map(); // targetTable -> [entries]
  for (const entry of sourced) {
    if (!sourcedByTable.has(entry.targetTable)) sourcedByTable.set(entry.targetTable, []);
    sourcedByTable.get(entry.targetTable).push(entry);
  }
  const overlaps = [];
  for (const entry of sourceless) {
    if (sourcedByTable.has(entry.targetTable)) {
      overlaps.push({ targetTable: entry.targetTable, sourcelessEntry: entry, sourcedEntries: sourcedByTable.get(entry.targetTable) });
    }
  }
  if (overlaps.length) {
    console.error(`FATAL: roster at "${rosterPath}" has ${overlaps.length} targetTable(s) claimed by BOTH a sourced AND a sourceless entry:`);
    for (const o of overlaps) {
      console.error(`  - targetTable="${o.targetTable}":`);
      console.error(`      SOURCELESS claim: source_db="${o.sourcelessEntry.source_db}" source_table="${o.sourcelessEntry.source_table}"`);
      for (const s of o.sourcedEntries) {
        console.error(`      SOURCED claim:    source_db="${s.source_db}" source_table="${s.source_table}"`);
      }
    }
    console.error('  A table cannot be genuinely net-new AND have a legacy source. If this table now has a real');
    console.error('  migration source, remove its net-new: entry entirely and keep only the sourced entry (or entries).');
    process.exit(1);
  }
}

// ─── LINEAGE-MAPPED COLUMNS (cm#198 fix: T3 branch (b) — translated-id path) ─
//
// A roster entry whose load-bearing columns are SURROGATE ids renumbered at
// migration time (own_graph_migration_ids' own reason for existing — see
// migrate-verify-own-graph.js) cannot be forward-hashed by RAW VALUE at all:
// the source id space and the target id space are structurally disjoint, so
// T3's branch-(a) algorithm (hash raw column values on both sides) produces
// a guaranteed 0-match total mismatch no matter how healthy the migration
// actually is — this was cm#198's root cause for retrieval_event_assertions.
// An entry OPTS IN to branch (b) by declaring BOTH lineageMappedCols AND
// lineageMembership; an entry with neither field takes branch (a), UNCHANGED
// (this is a strict opt-in, never an inferred behavior change for any
// existing roster entry).

const LINEAGE_TABLE_VOCAB = new Set(['own_graph_migration_ids', 'pipeline_migration_row_ids']);

/**
 * Per-targetTable membership-key codecs. Registration is DELIBERATELY
 * per-table (never a generic ':'-splitter): 139 project_settings keys also
 * contain ':' (its own natural key is (project_id, key), and `key` values
 * routinely contain colons) — a decoder that treated ANY colon-bearing
 * source_row_id the same way would silently misinterpret them the moment a
 * lineage-mapped declaration existed anywhere else in the roster. A table
 * with a lineageMembership declaration but no codec registered here (or
 * whose declared source_row_id_encoding does not match the registered
 * codec's own encoding string, verbatim) is a LOUD FATAL at roster-load
 * time (validateLineageDeclarations below) — never a silent fallback to a
 * generic split.
 */
const MEMBERSHIP_CODECS = {
  retrieval_event_assertions: {
    encoding: 'event_id:assertion_id',
    encode(row) {
      if (row.event_id === null || row.event_id === undefined) return null;
      if (row.assertion_id === null || row.assertion_id === undefined) return null;
      return `${row.event_id}:${row.assertion_id}`;
    },
    // Exact-2-part ':' split, both parts /^\d+$/ — a key that doesn't match
    // this shape (extra/missing colon, non-numeric part) decodes to null,
    // never a best-effort partial parse.
    decode(key) {
      if (typeof key !== 'string') return null;
      const parts = key.split(':');
      if (parts.length !== 2) return null;
      if (!/^\d+$/.test(parts[0]) || !/^\d+$/.test(parts[1])) return null;
      return { event_id: Number(parts[0]), assertion_id: Number(parts[1]) };
    },
  },
};

/**
 * Resolve the registered codec for a lineage-declared entry, or null if
 * none is registered for this entry's (targetTable, declared encoding)
 * pair. Callers must treat null as "cannot proceed" (a load-time FATAL via
 * validateLineageDeclarations, never a silent generic decode).
 */
function getMembershipCodec(entry) {
  if (!entry || !entry.lineageMembership) return null;
  const codec = MEMBERSHIP_CODECS[entry.targetTable];
  if (!codec) return null;
  if (entry.lineageMembership.source_row_id_encoding !== codec.encoding) return null;
  return codec;
}

/**
 * Load-time validation of the OPTIONAL lineageMappedCols/lineageMembership
 * declaration pair. An entry with NEITHER field is untouched (branch (a)).
 * An entry with exactly one of the two, or a malformed combination, is a
 * LOUD FATAL before any hashing starts — a half-declared entry is a roster
 * bug, never silently treated as "no lineage declared."
 */
function validateLineageDeclarations(roster, rosterPath) {
  const errors = [];
  for (const entry of roster) {
    const hasMapped = !!entry.lineageMappedCols;
    const hasMembership = !!entry.lineageMembership;
    if (!hasMapped && !hasMembership) continue; // branch (a), untouched
    const label = `targetTable="${entry.targetTable}"`;
    if (hasMapped !== hasMembership) {
      errors.push(`${label}: declares only one of lineageMappedCols/lineageMembership -- both or neither are required.`);
      continue;
    }
    const { isSourceless } = classifyRosterSourceDb(entry.source_db, label);
    const isFilesystem = typeof entry.source_db === 'string' && entry.source_db.startsWith('filesystem:');
    if (isSourceless || isFilesystem) {
      errors.push(`${label}: lineageMappedCols/lineageMembership declared on a non-SQL-sourced entry (source_db="${entry.source_db}") -- lineage translation requires a real SQL source.`);
      continue;
    }
    if (entry.requires_project_id_scope === true) {
      errors.push(`${label}: requires_project_id_scope=true combined with lineageMappedCols -- combination not implemented (no entry needs both today; silent single-path selection is forbidden, so this is a loud refusal instead).`);
      continue;
    }
    const vocabViolations = [];
    if (!LINEAGE_TABLE_VOCAB.has(entry.lineageMembership.lineage_table)) {
      vocabViolations.push(`lineageMembership.lineage_table="${entry.lineageMembership.lineage_table}"`);
    }
    for (const [col, mapping] of Object.entries(entry.lineageMappedCols)) {
      if (!mapping || !LINEAGE_TABLE_VOCAB.has(mapping.lineage_table)) {
        vocabViolations.push(`lineageMappedCols.${col}.lineage_table="${mapping && mapping.lineage_table}"`);
      }
      if (!entry.loadBearingCols.includes(col)) {
        errors.push(`${label}: lineageMappedCols key "${col}" does not appear in loadBearingCols.`);
      }
    }
    if (vocabViolations.length) {
      errors.push(`${label}: unrecognized lineage_table name(s) outside the closed vocabulary {${[...LINEAGE_TABLE_VOCAB].join(', ')}}: ${vocabViolations.join(', ')}.`);
    }
    if (!getMembershipCodec(entry)) {
      errors.push(`${label}: no registered membership-key codec for source_row_id_encoding="${entry.lineageMembership && entry.lineageMembership.source_row_id_encoding}" on this targetTable -- decode is defined ONLY per-entry, never generically.`);
    }
  }
  if (errors.length) {
    console.error(`FATAL: roster at "${rosterPath}" failed lineage-declaration validation:`);
    for (const e of errors) console.error(`  - ${e}`);
    process.exit(1);
  }
}

/**
 * Count rows in a (validated-vocabulary) lineage table for a
 * (source_db, source_table) pair. `lineageTable` MUST already be validated
 * against LINEAGE_TABLE_VOCAB by the caller (validateLineageDeclarations
 * runs at roster-load time, before any script reaches this) — never called
 * with an unvalidated/user-controlled table name.
 */
async function countLineageRows(tgtClient, lineageTable, sourceDb, sourceTable) {
  const { rows } = await tgtClient.query(
    `SELECT COUNT(*)::int AS n FROM ${lineageTable} WHERE source_db=$1 AND source_table=$2`,
    [sourceDb, sourceTable]
  );
  return rows[0].n;
}

/**
 * Load every lineage row for (source_db, source_table) into a
 * Map<source_row_id, target_row_id> — scoped by BOTH source_db AND
 * source_table on every call (spec item 2(h): "all lineage joins carry
 * source_db = entry.source_db"), never a blanket scan of the shared lineage
 * table.
 */
async function loadLineageMap(tgtClient, lineageTable, sourceDb, sourceTable) {
  const { rows } = await tgtClient.query(
    `SELECT source_row_id, target_row_id FROM ${lineageTable} WHERE source_db=$1 AND source_table=$2`,
    [sourceDb, sourceTable]
  );
  const map = new Map();
  for (const r of rows) map.set(r.source_row_id, r.target_row_id);
  return map;
}

/**
 * FATAL if a lineage declaration's (source_db, table) pair has zero rows in
 * the lineage table while live source rows exist for that table (a
 * migration that silently never ran, or whose lineage was wiped, must never
 * be misread as "nothing to check"). Zero source rows AND zero lineage rows
 * is legitimate (an empty table) but is logged explicitly as VACUOUS, never
 * silently passed through.
 */
async function checkLineagePopulationOrFatal(tgtClient, lineageTable, sourceDb, sourceTable, sourceRowCount, label) {
  const lineageCount = await countLineageRows(tgtClient, lineageTable, sourceDb, sourceTable);
  if (lineageCount === 0 && sourceRowCount > 0) {
    console.error(`[T3] FATAL: lineage declaration for ${label} (source_db="${sourceDb}" source_table="${sourceTable}", lineage_table="${lineageTable}") has ZERO rows, but ${sourceRowCount} live source row(s) exist -- lineage translation cannot proceed.`);
    process.exit(1);
  }
  if (lineageCount === 0 && sourceRowCount === 0) {
    console.log(`[T3] VACUOUS (source_count=0): ${label} (source_db="${sourceDb}" source_table="${sourceTable}") has no source rows and no lineage rows -- nothing to check, not silently skipped.`);
  }
  return lineageCount;
}

// ─── LABEL-DUPLICATE DECLARATIONS (cm#210 Gap 1: absorb-label roster entries) ─
//
// manifest_label_duplicate_of already existed (cm#196/cm#197 T2 Branch A
// rewrite) as a fact about a source_table LABEL's manifest bookkeeping
// (T2 verifies the duplicate's row-count sum against its declared primary's
// sum, within a slice). cm#210's spec-adversary pass (A-1) found the field
// was UNVALIDATED at load time -- five malformed shapes (self-reference,
// chains, an absent primary pair, a targetTable mismatch, and a contradictory
// combination with lineageMappedCols/lineageMembership/sourceProjectExclusions)
// all previously surfaced as confusing runtime failures deep inside whichever
// check touched the entry first, instead of a clear load-time FATAL. This
// section closes that gap AND is what lets T3 (verify-15-t3-content-hash.js)
// total-classify a label-duplicate entry into its own branch (c)
// LABEL-DUPLICATE-SKIP, rather than interpolating the LABEL as a physical
// relation name and crashing with "relation does not exist" (A-1's root
// cause: the label and the physical table name are deliberately different by
// migrate-05's own design -- see that script's header comment point 1).

/**
 * Every declaration field that SELECTS a T3 branch for a roster entry.
 * mutually exclusive per cm#210 spec 2.1.3 point 6 / 2.2.1: an entry may
 * declare at most ONE of these, ever -- a combination is a roster
 * contradiction (which branch would even run?), never resolved by picking
 * one silently.
 */
function branchSelectionFlags(entry) {
  const flags = [];
  if (entry.manifest_label_duplicate_of) flags.push('manifest_label_duplicate_of');
  if (entry.lineageMappedCols || entry.lineageMembership) flags.push('lineageMappedCols/lineageMembership');
  if (entry.sourceProjectExclusions) flags.push('sourceProjectExclusions');
  return flags;
}

/**
 * Load-time FATAL if any roster entry declares more than one of
 * {manifest_label_duplicate_of, lineageMappedCols+lineageMembership,
 * sourceProjectExclusions} -- these are the three T3 branch-selecting
 * declarations (branch (c), branch (b), branch (a2) respectively) and a
 * single entry can only take ONE branch. Run BEFORE validateManifestLabelDuplicates
 * and validateSourceProjectExclusionDeclarations so both of those can assume
 * the field they're validating is the entry's ONLY branch-selecting
 * declaration.
 */
function validateDeclarationMutualExclusion(roster, rosterPath) {
  const errors = [];
  for (const entry of roster) {
    const flags = branchSelectionFlags(entry);
    if (flags.length > 1) {
      errors.push(`source_db="${entry.source_db}" source_table="${entry.source_table}" (targetTable="${entry.targetTable}") declares ${flags.length} mutually-exclusive branch-selecting fields: ${flags.join(', ')} -- an entry may declare at most ONE.`);
    }
  }
  if (errors.length) {
    console.error(`FATAL: roster at "${rosterPath}" has entries declaring more than one mutually-exclusive branch-selection field:`);
    for (const e of errors) console.error(`  - ${e}`);
    process.exit(1);
  }
}

/**
 * Load-time validation of the OPTIONAL manifest_label_duplicate_of
 * declaration (cm#210 spec 2.1.3, closes A-1/A-10). An entry without the
 * field is untouched. An entry that declares it is checked against every
 * one of the five malformed shapes the spec-adversary pass found; each
 * violation is a collected error, FATAL at the end (T2's own message style
 * -- a bulleted list under one FATAL header, never one exit() per error).
 */
function validateManifestLabelDuplicates(roster, rosterPath) {
  const errors = [];
  const rosterPairSet = buildRosterPairSet(roster);
  const bySourceDbTable = new Map(); // JSON.stringify([source_db, source_table]) -> entry
  for (const e of roster) {
    bySourceDbTable.set(JSON.stringify([e.source_db, e.source_table]), e);
  }
  for (const entry of roster) {
    const dupOf = entry.manifest_label_duplicate_of;
    if (dupOf === undefined || dupOf === null) continue;
    const label = `source_db="${entry.source_db}" source_table="${entry.source_table}" (targetTable="${entry.targetTable}")`;

    if (typeof dupOf !== 'string' || !SAFE_IDENTIFIER_RE.test(dupOf)) {
      errors.push(`${label}: manifest_label_duplicate_of=${JSON.stringify(dupOf)} is not a safe SQL identifier (must match ${SAFE_IDENTIFIER_RE}, no schema qualifier, no quoting).`);
      continue; // unsafe value -- do not use it in any further lookup below
    }
    if (dupOf === entry.source_table) {
      errors.push(`${label}: manifest_label_duplicate_of="${dupOf}" is a self-reference (equals its own source_table).`);
      continue;
    }
    const pairKey = JSON.stringify([entry.source_db, dupOf]);
    if (!rosterPairSet.has(pairKey)) {
      errors.push(`${label}: manifest_label_duplicate_of="${dupOf}" has no matching roster entry for (source_db="${entry.source_db}", source_table="${dupOf}") -- the declared primary pair is absent from the roster.`);
      continue;
    }
    const primary = bySourceDbTable.get(pairKey);
    if (primary.manifest_label_duplicate_of) {
      errors.push(`${label}: primary entry (source_table="${dupOf}") itself declares manifest_label_duplicate_of="${primary.manifest_label_duplicate_of}" -- chained duplicate-of declarations are not allowed (must resolve to a real, non-duplicate primary in one hop).`);
    }
    const { isSourceless } = classifyRosterSourceDb(primary.source_db, label);
    const isFilesystem = typeof primary.source_db === 'string' && primary.source_db.startsWith('filesystem:');
    if (isSourceless || isFilesystem) {
      errors.push(`${label}: primary entry (source_table="${dupOf}") is ${isSourceless ? 'a SOURCELESS (net-new:) entry' : 'a filesystem:-sourced entry'} -- a duplicate label must resolve to a real SQL-sourced primary.`);
    }
    if (primary.targetTable !== entry.targetTable) {
      errors.push(`${label}: targetTable="${entry.targetTable}" does not byte-exact match primary entry's targetTable="${primary.targetTable}".`);
    }
  }
  if (errors.length) {
    console.error(`FATAL: roster at "${rosterPath}" failed manifest_label_duplicate_of validation:`);
    for (const e of errors) console.error(`  - ${e}`);
    process.exit(1);
  }
}

// ─── SOURCE-PROJECT EXCLUSIONS DECLARATION (cm#210 Gap 2: lineage-based) ─────
//
// New OPTIONAL roster field for a source table with project-scoped
// migration_manifest exclusions but NO project_id column of its own (the
// second half of cm#210's issue: claude_context.decisions). Chosen semantic
// is LINEAGE-BASED exclusion (spec 2.2, rejects "target-side-only scoping
// with a count allowance" -- A-5 -- and a bare "no source project column"
// skip marker, both of which convert a checkable exclusion into an
// unchecked one). An excluded row is precisely a live source row with no
// row in the declared lineage table.

/**
 * Load-time validation of the OPTIONAL sourceProjectExclusions declaration
 * (cm#210 spec 2.2.1). `mode` is a closed vocabulary of exactly one value
 * today ("lineage") -- an unrecognized mode is the default/unknown branch,
 * FATAL, never silently treated as "lineage" or silently ignored.
 */
function validateSourceProjectExclusionDeclarations(roster, rosterPath) {
  const errors = [];
  for (const entry of roster) {
    const decl = entry.sourceProjectExclusions;
    if (decl === undefined || decl === null) continue;
    const label = `source_db="${entry.source_db}" source_table="${entry.source_table}" (targetTable="${entry.targetTable}")`;

    if (typeof decl !== 'object' || Array.isArray(decl)) {
      errors.push(`${label}: sourceProjectExclusions must be an object, got ${JSON.stringify(decl)}.`);
      continue;
    }
    if (decl.mode !== 'lineage') {
      errors.push(`${label}: sourceProjectExclusions.mode=${JSON.stringify(decl.mode)} is not a recognized mode -- only "lineage" is defined today (closed vocabulary; an unrecognized mode is refused, never silently treated as "lineage").`);
    }
    if (!LINEAGE_TABLE_VOCAB.has(decl.lineage_table)) {
      errors.push(`${label}: sourceProjectExclusions.lineage_table=${JSON.stringify(decl.lineage_table)} is outside the closed vocabulary {${[...LINEAGE_TABLE_VOCAB].join(', ')}}.`);
    }
    if (typeof decl.source_id_col !== 'string' || !SAFE_IDENTIFIER_RE.test(decl.source_id_col)) {
      errors.push(`${label}: sourceProjectExclusions.source_id_col=${JSON.stringify(decl.source_id_col)} is not a safe SQL identifier (must match ${SAFE_IDENTIFIER_RE}).`);
    }
    const { isSourceless } = classifyRosterSourceDb(entry.source_db, label);
    const isFilesystem = typeof entry.source_db === 'string' && entry.source_db.startsWith('filesystem:');
    if (isSourceless || isFilesystem) {
      errors.push(`${label}: sourceProjectExclusions declared on a non-SQL-sourced entry (source_db="${entry.source_db}") -- lineage-based exclusion requires a real SQL source to read live rows from.`);
    }
  }
  if (errors.length) {
    console.error(`FATAL: roster at "${rosterPath}" failed sourceProjectExclusions validation:`);
    for (const e of errors) console.error(`  - ${e}`);
    process.exit(1);
  }
}

/**
 * Load every lineage row for (source_db, source_table) into a
 * Map<source_row_id, {target_row_id, project_id}> -- the SAME scoping
 * discipline as loadLineageMap (both source_db AND source_table on every
 * call), but ALSO carrying each lineage row's own project_id, which T3's
 * branch (a2) needs to detect the migrated-AND-excluded contradiction (A-6):
 * a lineage row recorded under a project id that is ALSO in this pair's
 * excluded set is a data contradiction, not ordinary drift. `lineageTable`
 * MUST already be validated against LINEAGE_TABLE_VOCAB by the caller
 * (validateSourceProjectExclusionDeclarations runs at roster-load time,
 * before any script reaches this) -- same precondition as loadLineageMap.
 */
async function loadLineageMapWithProjectId(tgtClient, lineageTable, sourceDb, sourceTable) {
  const { rows } = await tgtClient.query(
    `SELECT source_row_id, target_row_id, project_id FROM ${lineageTable} WHERE source_db=$1 AND source_table=$2`,
    [sourceDb, sourceTable]
  );
  const map = new Map();
  for (const r of rows) map.set(r.source_row_id, { target_row_id: r.target_row_id, project_id: r.project_id });
  return map;
}

/**
 * Load + shape-validate the real source-table-roster.json. Loud fatal, never
 * a silent empty-array fallback, when the real roster is missing — names
 * both the env var and the example file so the operator knows exactly what
 * to do next.
 */
function loadRoster() {
  const rosterPath = resolveRosterPath();
  if (!fs.existsSync(rosterPath)) {
    console.error(`FATAL: source table roster not found at "${rosterPath}".`);
    console.error(`  Set ${ROSTER_ENV_VAR} to point at the real roster, or create`);
    console.error(`  scripts/migrations/source-table-roster.json (real roster — carries`);
    console.error(`  private estate data, gitignored, never committed).`);
    console.error(`  See scripts/migrations/${ROSTER_EXAMPLE_FILE} for the required shape`);
    console.error(`  (synthetic example only).`);
    process.exit(1);
  }
  let raw;
  try {
    raw = fs.readFileSync(rosterPath, 'utf8');
  } catch (err) {
    console.error(`FATAL: could not read roster at "${rosterPath}": ${err.message}`);
    process.exit(1);
  }
  let roster;
  try {
    roster = JSON.parse(raw);
  } catch (err) {
    console.error(`FATAL: roster at "${rosterPath}" is not valid JSON: ${err.message}`);
    process.exit(1);
  }
  if (!Array.isArray(roster) || roster.length === 0) {
    console.error(`FATAL: roster at "${rosterPath}" must be a non-empty JSON array.`);
    process.exit(1);
  }
  validateRosterShape(roster, rosterPath);
  validateRosterSourceDbShapes(roster, rosterPath);
  validateRosterPartitionDisjoint(roster, rosterPath);
  validateLineageDeclarations(roster, rosterPath);
  validateDeclarationMutualExclusion(roster, rosterPath);
  validateManifestLabelDuplicates(roster, rosterPath);
  validateSourceProjectExclusionDeclarations(roster, rosterPath);
  return roster;
}

// ─── IDENTIFIER SAFETY (T5 rewrite, cm#194) ──────────────────────────────────

const SAFE_IDENTIFIER_RE = /^[a-z_][a-z0-9_]*$/;

/**
 * Every raw-SQL-interpolated identifier (table name, column name) this
 * battery builds from roster/live-catalog data is byte-exact-validated
 * against this pattern before interpolation — never trusted as-is. A
 * targetTable/contentCol/embeddingCol value that fails this is refused loud
 * (FATAL, naming the value and its source) rather than interpolated, which
 * would otherwise be an identifier-injection hazard AND (independently) the
 * exact shape that lets a table literally named "toString"/"constructor"
 * resolve via JS's Object.prototype instead of an own property (see T5's
 * CONTENT_EXPRESSIONS lookup, which pairs this with Object.hasOwn).
 */
function assertSafeIdentifier(name, label) {
  if (typeof name !== 'string' || !SAFE_IDENTIFIER_RE.test(name)) {
    console.error(`FATAL: ${label} "${name}" is not a safe SQL identifier (must match ${SAFE_IDENTIFIER_RE}).`);
    process.exit(1);
  }
}

// ─── targetTable RESOLUTION KEYED ON (source_db, source_table) (cm#196/#197) ─

/**
 * Build a Map<string, targetTable> (key = JSON.stringify([source_db, source_table])) from the roster —
 * the single resolution authority every consumer that needs "what targetTable
 * does this (source_db, source_table) pair migrate to" should use, replacing
 * the source_table-ALONE `roster.find(e => e.source_table === sourceTable)`
 * matcher bug (T2/T9's pre-existing targetTableFor): two different source_dbs
 * legitimately reuse the same source_table name (e.g. "decisions" from three
 * different pipeline databases) mapping to the SAME targetTable today, but a
 * source_table-alone lookup would silently resolve every one of them via
 * whichever roster entry happens to be FIRST in array order — correct only by
 * coincidence when every same-named source_table maps to the same
 * targetTable, and silently wrong the day one doesn't.
 *
 * Load-time FATAL (never silently first-entry-wins) if the SAME
 * (source_db, source_table) pair appears more than once in the roster
 * mapping to DIFFERENT targetTable values — a genuine roster contradiction,
 * not a legitimate multi-source shape (the legitimate multi-source shape is
 * DIFFERENT source_tables, e.g. "memory_entries" and
 * "memory_entries_db_absorb", both under the same source_db, mapping to the
 * same targetTable — that is normal and unaffected by this check).
 */
function buildTargetTableByPairMap(roster, rosterPath) {
  const map = new Map();
  const seenTargets = new Map(); // pairKey -> Set<targetTable>
  for (const entry of roster) {
    const key = JSON.stringify([entry.source_db, entry.source_table]);
    if (!seenTargets.has(key)) seenTargets.set(key, new Set());
    seenTargets.get(key).add(entry.targetTable);
    map.set(key, entry.targetTable); // last-write is fine once we've FATALed on any real conflict below
  }
  const conflicts = [...seenTargets.entries()].filter(([, targets]) => targets.size > 1);
  if (conflicts.length) {
    console.error(`FATAL: roster at "${rosterPath || resolveRosterPath()}" has ${conflicts.length} (source_db, source_table) pair(s) mapping to CONFLICTING targetTable values:`);
    for (const [key, targets] of conflicts) {
      const [sourceDb, sourceTable] = JSON.parse(key);
      console.error(`  - source_db="${sourceDb}" source_table="${sourceTable}": targetTable candidates = ${[...targets].map((t) => `"${t}"`).join(', ')}`);
    }
    process.exit(1);
  }
  return map;
}

/** Resolve targetTable for one (source_db, source_table) pair via the map above. */
function resolveTargetTableForPair(pairMap, sourceDb, sourceTable) {
  return pairMap.get(JSON.stringify([sourceDb, sourceTable])) || null;
}

/**
 * Exact (source_db, source_table) pairs present in the roster — used by
 * classifyManifestRow (Phase 1) to answer "is this manifest row's exact pair
 * roster-paired" (byte-exact, never a source_table-alone match, for the same
 * reason buildTargetTableByPairMap above exists).
 */
function buildRosterPairSet(roster) {
  const set = new Set();
  for (const entry of roster) set.add(JSON.stringify([entry.source_db, entry.source_table]));
  return set;
}

function isRosterPaired(rosterPairSet, sourceDb, sourceTable) {
  return rosterPairSet.has(JSON.stringify([sourceDb, sourceTable]));
}

// ─── db-triage.json (READ-SIDE, NON-FATAL-ON-ABSENCE) LOADER (cm#197) ───────
//
// This is a SEPARATE loader from migrate-04/05's own loadDbTriage(): those
// scripts are WRITE-side migrators that must refuse to run at all against an
// unclassified live database (FATAL on a missing file is correct there — see
// migrate-04-absorb-pipeline-tables.js's loadDbTriage). T0/T2/T4/T9 are
// READ-side audits of migration_manifest rows that may ALREADY exist from a
// run where no db-triage.json was ever present (T2's own CI fixtures are
// roster-paired and carry no triage file at all, by design — see
// classifyManifestRow's UNTRIAGED branch) — an audit script FATALing on a
// missing triage file would make the whole battery unable to run in that
// legitimate configuration. Absence is therefore its own total-classification
// OUTCOME (every row's db lands in the UNTRIAGED branch), never a refusal.
// An estate file with an INVALID class VALUE inside it, by contrast, is a
// config bug regardless of which rows reference it -- still a load-time
// FATAL, mirroring migrate-04/05's own validation exactly.

const DB_TRIAGE_ENV_VAR = 'DB_TRIAGE_PATH';
const DB_TRIAGE_EXAMPLE_FILE = 'db-triage.example.json';
const DB_TRIAGE_VALID_CLASSES = new Set(['REAL-MIGRATE', 'EPHEMERAL-DROP', 'OWNER-REVIEW', 'ENGINE-INFRA']);

/** --triage <path> / --triage=<path>, mirroring parseDbFlag's own shape. */
function parseTriageFlag(argv) {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--triage') return argv[i + 1];
    if (argv[i].startsWith('--triage=')) return argv[i].slice('--triage='.length);
  }
  return null;
}

function resolveDbTriagePath(argv) {
  return parseTriageFlag(argv || []) || process.env[DB_TRIAGE_ENV_VAR] || path.join(MIGRATIONS_DIR, 'db-triage.json');
}

/**
 * Load db-triage.json for READ-side (audit) consumers. Returns
 * { path, databases: Map<dbName,class>|null } — `databases` is `null` when
 * the file is absent (a legitimate, expected CI/no-triage-file posture, NOT
 * an error); every db then classifies UNTRIAGED in classifyManifestRow.
 * A PRESENT file with a malformed shape or an invalid class value is still a
 * loud, run-blocking FATAL (a config bug, not an absence).
 */
function loadDbTriageForAudit(argv) {
  const p = resolveDbTriagePath(argv);
  if (!fs.existsSync(p)) {
    return { path: p, databases: null };
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
  const databases = new Map(Object.entries(parsed.databases));
  return { path: p, databases };
}

// ─── PHASE 1: PER-ROW migration_manifest TOTAL CLASSIFICATION (cm#196/#197) ──
//
// ONE shared classifier, consumed by T0/T2/T4/T9 (never a per-script copy —
// two normalization engines is exactly the class of bug this whole battery
// exists to close). Classifies ONE migration_manifest row into EXACTLY one
// named branch — see this PR's body for the full decision-tree rationale.
// Every branch is named on the `branch` field; `retain` says whether the
// caller's own reconciliation/audit logic should still consider this row;
// `fatal`/`warn`/`info` say whether (and how loud) the caller should log it.
// Callers own PRESENTATION (their own [T0]/[T2]/[T4]/[T9] prefixed log
// lines) and the DECISION of what to do with a fail/warn (e.g. T2 removes
// an EXCLUDE-BY-TRIAGE row from its working set entirely; T0 treats
// `retain: false` as "does not count as manifest coverage for either
// direction of its roster cross-check") — only the CLASSIFICATION itself is
// shared.
//
// FAIL, NEVER FATAL (deliberate, load-bearing distinction): every non-RETAIN
// branch below is a per-row "loud FAIL" — collected, reported, and folded
// into the caller's own exit-1 decision, but it NEVER halts classification
// of the OTHER rows in the same run. A single row with undecided provenance
// (OWNER-REVIEW, an untriaged-and-unpaired source, …) is exactly that: a
// problem with THAT row, not a reason to stop reporting on every other row
// this run would otherwise have told the operator about. The only thing
// that halts THIS run before it finishes is a malformed db-triage.json FILE
// itself (validated at load time, by loadDbTriageForAudit, before any row
// is classified at all) — a config bug is categorically different from a
// per-row provenance question.

const NETNEW_SOURCE_DB_PREFIX = 'net-new:';
const FILESYSTEM_SOURCE_DB_PREFIX = 'filesystem:';

/**
 * @param {object} row - a migration_manifest row: {source_db, source_table,
 *   project_id_or_null, excluded_reason, retired_at, id?}. `id` is optional
 *   (used only for FAIL/WARN message context when present).
 * @param {object} ctx
 * @param {Map<string,string>|null} ctx.dbTriage - from loadDbTriageForAudit's
 *   `databases` (null = no triage file present at all -> every plain-db-name
 *   row is UNTRIAGED).
 * @param {Set<string>} ctx.rosterPairSet - from buildRosterPairSet(roster).
 * @returns {{branch:string, retain:boolean, fail?:boolean, warn?:boolean,
 *   info?:boolean, reason?:string}}
 */
function classifyManifestRow(row, ctx) {
  const { dbTriage, rosterPairSet } = ctx;
  const label = `source_db="${row.source_db}" source_table="${row.source_table}" project_id_or_null=${row.project_id_or_null ?? 'NULL'}${row.id !== undefined ? ` (manifest id=${row.id})` : ''}`;

  // Retirement is checked FIRST, before any other classification -- a
  // retired row is disposed-of bookkeeping, full stop, regardless of what
  // its source_db shape or triage class would otherwise say.
  if (row.retired_at !== null && row.retired_at !== undefined) {
    return { branch: 'RETIRED-SKIP', retain: false, info: true, reason: `${label}: retired (skipped)` };
  }

  const paired = isRosterPaired(rosterPairSet, row.source_db, row.source_table);

  if (typeof row.source_db === 'string' && row.source_db.startsWith(NETNEW_SOURCE_DB_PREFIX)) {
    // Sourceless (net-new:) roster entries never get a migration_manifest
    // row by construction (T1 never snapshots one) -- a manifest row
    // actually carrying this shape is a data-integrity bug, not a normal
    // outcome, and is refused loud rather than silently reconciled.
    return {
      branch: 'NETNEW-IN-MANIFEST-FAIL', retain: false, fail: true,
      reason: `${label}: source_db has the sourceless "net-new:" shape, but a real migration_manifest row exists for it -- sourceless tables never get manifest rows (nothing is ever migrated INTO them). This manifest row should not exist; investigate what wrote it.`,
    };
  }

  if (typeof row.source_db === 'string' && row.source_db.startsWith(FILESYSTEM_SOURCE_DB_PREFIX)) {
    if (paired) {
      return { branch: 'FILESYSTEM-PAIRED-RETAIN', retain: true };
    }
    return {
      branch: 'FILESYSTEM-UNPAIRED-FAIL', retain: false, fail: true,
      reason: `${label}: filesystem: source with NO matching roster (source_db, source_table) entry -- markdown-sourced manifest rows must be roster-registered.`,
    };
  }

  // Plain database name -- the only shape that reaches db-triage lookup.
  const triageClass = dbTriage && dbTriage.has(row.source_db) ? dbTriage.get(row.source_db) : undefined;

  if (triageClass === undefined) {
    // UNTRIAGED: no triage file present at all, OR the file is present but
    // doesn't mention this db.
    if (paired) {
      return { branch: 'UNTRIAGED-PAIRED-RETAIN', retain: true, warn: true, reason: `${label}: source_db is UNTRIAGED (no db-triage.json entry) but roster-paired -- retained with a warning.` };
    }
    return {
      branch: 'UNTRIAGED-UNPAIRED-FAIL', retain: false, fail: true,
      reason: `${label}: source_db is UNTRIAGED (no db-triage.json entry) AND has no matching roster (source_db, source_table) entry -- cannot account for this row.`,
    };
  }

  if (triageClass === 'REAL-MIGRATE') {
    return { branch: 'REAL-MIGRATE-RETAIN', retain: true };
  }

  if (triageClass === 'EPHEMERAL-DROP' || triageClass === 'ENGINE-INFRA') {
    if (paired) {
      return { branch: 'TRIAGE-EXCLUDED-PAIRED-RETAIN', retain: true, info: true, reason: `${label}: source_db is triage-classified "${triageClass}" but roster-paired (a legitimate own-graph/engine-infra source) -- retained.` };
    }
    return {
      branch: 'EXCLUDE-BY-TRIAGE', retain: false, info: true,
      reason: `${label}: source_db is triage-classified "${triageClass}" and NOT roster-paired -- excluded from this audit as known-disposable bookkeeping (row_count=${row.row_count ?? '?'}).`,
    };
  }

  if (triageClass === 'OWNER-REVIEW') {
    return {
      branch: 'OWNER-REVIEW-FAIL', retain: false, fail: true,
      reason: `${label}: source_db is triage-classified "OWNER-REVIEW" -- provenance undecided, cannot audit until reviewed.`,
    };
  }

  // Defensive: loadDbTriageForAudit already validates every class value
  // against DB_TRIAGE_VALID_CLASSES at load time, so this branch should be
  // unreachable in practice -- kept as the explicit default branch anyway
  // (never an implicit fall-through) per this project's total-classification
  // canon.
  return {
    branch: 'UNKNOWN-TRIAGE-VALUE-FAIL', retain: false, fail: true,
    reason: `${label}: source_db is triage-classified "${triageClass}", which is not one of ${[...DB_TRIAGE_VALID_CLASSES].join(', ')}.`,
  };
}

// ─── PROJECT_ID COLUMN TOTAL CLASSIFICATION (BF-1/BF-5/BF-R1, cm#187/#188) ───

/**
 * Does `table` (on `client`'s connection) carry a column named `column`?
 * The single implementation every verify-15-*.js script and this shared lib
 * use to total-classify a table's shape before building SQL against it —
 * moved here from verify-15-t1-snapshot.js (which introduced the pattern
 * first, for the SOURCE side) so every consumer on both the source and
 * target side shares one implementation, never a second hand-written copy
 * (T1 re-exports this same function for backward compatibility).
 */
async function tableHasColumn(client, table, column) {
  const { rows } = await client.query(
    `SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = $1 AND column_name = $2`,
    [table, column]
  );
  return rows.length > 0;
}

/**
 * BF-1/BF-5 (cm#187 spec-adversary pass, 2026-08-18): migration_manifest's
 * project_id_or_null nullness is NOT a proxy for whether a TARGET table
 * physically carries a project_id column — a table can get a NON-NULL
 * project-scoped manifest row (migrate-verify-own-graph.js's
 * migrateRetrievalEventAssertions, live proof: manifest id=2548,
 * project_id='90394596-...', row_count=2930 for retrieval_event_assertions,
 * a table with NO project_id column at all) purely because the SOURCE side
 * happened to iterate one project at a time — the column question can only
 * be answered by asking the TARGET table's live schema, never inferred from
 * manifest shape.
 *
 * This is the single total-classification pass every verify-15-*.js script
 * that reconciles against target tables must run BEFORE any reconciliation:
 * for every roster entry, tableHasColumn(client, entry.targetTable,
 * 'project_id') MUST agree with that entry's own requires_project_id_scope
 * flag. A disagreement between these two authorities is a LOUD FATAL — never
 * silently trusted to either side alone (closes BF-5: "two authorities must
 * never silently diverge").
 *
 * Returns a Map<targetTable, boolean> (hasProjectId) for reuse by the
 * caller's own reconciliation loop — never re-queried table-by-table when a
 * cached answer already exists for that targetTable in the SAME run.
 */
async function crossCheckProjectIdScope(client, roster) {
  const cache = new Map();
  const mismatches = [];
  for (const entry of roster) {
    const t = entry.targetTable;
    if (!cache.has(t)) {
      cache.set(t, await tableHasColumn(client, t, 'project_id'));
    }
    const hasColumn = cache.get(t);
    if (hasColumn !== entry.requires_project_id_scope) {
      mismatches.push({
        targetTable: t,
        sourceTable: entry.source_table,
        hasColumn,
        requiresProjectIdScope: entry.requires_project_id_scope,
      });
    }
  }
  if (mismatches.length > 0) {
    console.error(`FATAL: roster requires_project_id_scope disagrees with live schema for ${mismatches.length} entr${mismatches.length === 1 ? 'y' : 'ies'} — refusing to reconcile until the roster or the schema is fixed:`);
    for (const m of mismatches) {
      console.error(`  - targetTable="${m.targetTable}" (source_table="${m.sourceTable}"): roster says requires_project_id_scope=${m.requiresProjectIdScope}, live schema ${m.hasColumn ? 'HAS' : 'does NOT have'} a project_id column.`);
    }
    process.exit(1);
  }
  return cache;
}

/**
 * BF-R1/BF-R4: reconcile a target table with NO project_id column against
 * migration_manifest, ONCE for the whole (source_db, source_table) pair —
 * never once per manifest slice row (that was the original T2 bug: issuing
 * the SAME live-count query, unconditionally assuming a project_id column,
 * for every manifest row individually). Every non-excluded manifest row for
 * this (source_db, source_table) pair is SUMMED (irrespective of
 * project_id_or_null — a no-column table has no notion of "slice" at all)
 * and compared against ONE bare COUNT(*) over the target table.
 *
 * A manifest row for a no-column table carrying excluded_reason IS NOT NULL
 * is a LOUD FATAL, never silently ignored or mis-reconciled: a bare
 * COUNT(*) structurally cannot subtract an excluded project's rows (there is
 * no project_id column to filter by), so this reconciliation shape is
 * provably wrong the instant an exclusion exists for a no-column table.
 *
 * @returns {Promise<{fatal:true,reason:string}|{fatal:false,ok:boolean,expected:number,liveCount:number,manifestRowsConsidered:number}>}
 */
async function reconcileNoColumnTable(client, targetTable, sourceDb, sourceTable) {
  const { rows: manifestRows } = await client.query(
    `SELECT row_count, excluded_reason FROM migration_manifest WHERE source_db = $1 AND source_table = $2 AND retired_at IS NULL`,
    [sourceDb, sourceTable]
  );
  const excludedRows = manifestRows.filter((r) => r.excluded_reason !== null);
  if (excludedRows.length > 0) {
    return {
      fatal: true,
      reason: `targetTable="${targetTable}" (source_db="${sourceDb}" source_table="${sourceTable}") has no project_id column, but ${excludedRows.length} migration_manifest row(s) carry excluded_reason. A bare COUNT(*) over this table cannot subtract an excluded project's rows — this table cannot be safely reconciled this way. Fix: give this table a project_id column, or resolve the exclusion some other way before re-running.`,
    };
  }
  const expected = manifestRows.reduce((sum, r) => sum + Number(r.row_count), 0);
  const { rows: cntRows } = await client.query(`SELECT COUNT(*) AS n FROM ${targetTable}`);
  const liveCount = Number(cntRows[0].n);
  return {
    fatal: false,
    ok: liveCount === expected,
    expected,
    liveCount,
    manifestRowsConsidered: manifestRows.length,
  };
}

// ─── ROW HASHING (T3's reference implementation, §15.3 — reused everywhere) ─

// A value no real column value can equal by construction. Written as source
// text (never a literal NUL byte in this file, per canon) — this is a
// 10-character sentinel STRING, not a NUL byte; it distinguishes NULL/absent
// from an empty string without ever coalescing them to the same value.
const NULL_SENTINEL = ' __NULL__ ';

/**
 * Hash one row's load-bearing column values. No .trim() (whitespace is not
 * documented anywhere as never-load-bearing). NULL/undefined mapped to the
 * sentinel, never coalesced with ''. JSON.stringify of the VALUE ARRAY (not
 * a delimiter-joined string) so no value's own content can forge a
 * tuple-boundary collision.
 */
function rowHash(cols, row) {
  const values = cols.map((c) => (row[c] === null || row[c] === undefined) ? NULL_SENTINEL : row[c]);
  const s = JSON.stringify(values);
  return crypto.createHash('md5').update(s).digest('hex');
}

/**
 * BF-R3 (cm#187, T3/hashTableMultiset): resolve the REAL idCol/projectCol
 * for `table` on THIS `client` connection — never assume 'id'/'project_id'
 * exist just because they're the common case. Source and target sides are
 * resolved INDEPENDENTLY (this is called once per side, each with its own
 * `client`) because their column shapes can diverge independently (T1's
 * source-side tableHasColumn check already established this for
 * project_id; retrieval_event_assertions additionally has no `id` column
 * at all — BF-8).
 *
 * `opts.idCol`/`opts.projectCol`, when supplied (the roster-level `idCol`
 * override convention, mirroring the existing embeddingCol/contentCol
 * override fields), are still VALIDATED against this connection's live
 * schema via tableHasColumn before use — an override intended for one
 * table shape must never be blindly trusted against a different one, or
 * against the side that doesn't actually have it. An override (or the
 * 'id'/'project_id' default) that doesn't resolve to a real column yields
 * `null` for that slot — never a crash, never a guess.
 */
async function resolveHashCols(client, table, opts = {}) {
  const idCandidate = opts.idCol || 'id';
  const projectCandidate = opts.projectCol || 'project_id';
  const idCol = (await tableHasColumn(client, table, idCandidate)) ? idCandidate : null;
  const projectCol = (await tableHasColumn(client, table, projectCandidate)) ? projectCandidate : null;
  return { idCol, projectCol };
}

/**
 * Hash every row of `table` (via `client`) over `cols`, returning a
 * MULTISET: Map<hash, {count, sample}> — never a Set. Two identical-content
 * rows must count as 2, not collapse to 1 (closes A-8).
 *
 * idCol/projectCol are resolved via resolveHashCols (BF-R3) — a table with
 * neither column (e.g. retrieval_event_assertions: event_id/assertion_id
 * only) hashes and counts correctly; only per-row SAMPLE logging (id/
 * project_id, used solely for FAIL diagnostics — never part of the hash
 * itself, which is computed over `cols` only) is omitted, with an explicit
 * log line, never a silent gap and never a crash.
 */
async function hashTableMultiset(client, table, cols, opts = {}) {
  const { idCol, projectCol } = await resolveHashCols(client, table, opts);
  if (!idCol) {
    console.log(`  [INFO] ${table}: no resolvable id column (checked "${opts.idCol || 'id'}") — per-row sample logging omitted for this table's hash multiset; the hash itself (over loadBearingCols) is unaffected.`);
  }
  const selectCols = [idCol, projectCol, ...cols].filter((c) => c !== null).filter((c, i, a) => a.indexOf(c) === i);
  const { rows } = await client.query(`SELECT ${selectCols.map((c) => `"${c}"`).join(', ')} FROM ${table}`);
  const counts = new Map();
  for (const r of rows) {
    const h = rowHash(cols, r);
    const entry = counts.get(h) || { count: 0, sample: [] };
    entry.count += 1;
    if (entry.sample.length < 3) entry.sample.push({ id: idCol ? r[idCol] : undefined, project_id: projectCol ? r[projectCol] : undefined });
    counts.set(h, entry);
  }
  return counts;
}

/**
 * Same as hashTableMultiset, but excludes rows whose project_id is in
 * `excludedProjectIds` — used by T3's forward-containment scan to keep
 * DELIBERATELY-EXCLUDED source rows (T9's exclusion scenario) out of the
 * source-side multiset, since those rows correctly never migrate and would
 * otherwise spuriously fail T3's "every source row survived" proof.
 *
 * NOT EXISTS against unnest($1::text[]), never NOT IN (closes the
 * finding raised in PR #152 review — this repo's canon forbids NOT IN
 * (subquery) in any authored SQL, and this is exactly that shape if written
 * naively). Passing an empty array is equivalent to hashTableMultiset with
 * no filter (the WHERE clause is omitted entirely in that case, not run
 * with an empty unnest — cheaper and avoids a degenerate-array edge case).
 */
async function hashTableMultisetExcludingProjects(client, table, cols, excludedProjectIds, opts = {}) {
  const { idCol, projectCol } = await resolveHashCols(client, table, opts);
  if (excludedProjectIds && excludedProjectIds.length > 0 && !projectCol) {
    // A project-scoped exclusion can only exist for a project_id-scoped
    // table by construction (project_id_or_null must be non-null to be
    // "project-scoped" at all) — reaching this with a genuinely no-column
    // table would mean the manifest and the live schema have already
    // diverged (BF-5's job to catch upstream). Loud, not a silent no-op.
    throw new Error(`hashTableMultisetExcludingProjects: table "${table}" has no resolvable project_id column, but ${excludedProjectIds.length} excluded project id(s) were supplied — cannot scope the exclusion filter. If this source table structurally has no project column, declare sourceProjectExclusions on the roster entry (see source-table-roster.example.json) so T3 uses the lineage-based exclusion branch instead.`);
  }
  const selectCols = [idCol, projectCol, ...cols].filter((c) => c !== null).filter((c, i, a) => a.indexOf(c) === i);
  let sql = `SELECT ${selectCols.map((c) => `"${c}"`).join(', ')} FROM ${table}`;
  const params = [];
  if (excludedProjectIds && excludedProjectIds.length > 0) {
    sql += ` t WHERE NOT EXISTS (SELECT 1 FROM unnest($1::text[]) AS ex(pid) WHERE ex.pid = t."${projectCol}")`;
    params.push(excludedProjectIds);
  }
  const { rows } = await client.query(sql, params);
  const counts = new Map();
  for (const r of rows) {
    const h = rowHash(cols, r);
    const entry = counts.get(h) || { count: 0, sample: [] };
    entry.count += 1;
    if (entry.sample.length < 3) entry.sample.push({ id: idCol ? r[idCol] : undefined, project_id: projectCol ? r[projectCol] : undefined });
    counts.set(h, entry);
  }
  return counts;
}

/**
 * Load T1-recorded exclusions for one (source_db, source_table) pair from
 * migration_manifest, split into the NULL-scoped (whole-DB/whole-table)
 * exclusion, if any, and the list of project-scoped exclusions. Used by T3
 * to scope its forward-containment source-side multiset to non-excluded
 * rows only (closes the PR #152 review finding: T3 previously never
 * consulted excluded_reason at all).
 *
 * @returns {Promise<{ nullScoped: object|null, projectScoped: object[] }>}
 */
async function loadExclusionsFor(tgtClient, sourceDb, sourceTable) {
  const { rows } = await tgtClient.query(
    `SELECT project_id_or_null, row_count, excluded_reason
     FROM migration_manifest
     WHERE source_db = $1 AND source_table = $2 AND excluded_reason IS NOT NULL AND retired_at IS NULL`,
    [sourceDb, sourceTable]
  );
  const nullScoped = rows.find((r) => r.project_id_or_null === null) || null;
  const projectScoped = rows.filter((r) => r.project_id_or_null !== null);
  return { nullScoped, projectScoped };
}

/**
 * Build the roster-derived load-bearing-columns map (targetTable ->
 * loadBearingCols). Fatal on any roster entry missing a mapping — never a
 * silent partial map (closes A-2).
 */
function buildLoadBearingColsFromRoster(roster) {
  const map = {};
  for (const entry of roster) {
    if (!entry.loadBearingCols || !entry.loadBearingCols.length) {
      console.error(`FATAL: roster entry "${entry.targetTable}" has no loadBearingCols mapping — refusing to run with a partial map.`);
      process.exit(1);
    }
    map[entry.targetTable] = entry.loadBearingCols;
  }
  return map;
}

/**
 * Compute + persist per-row target_hash values into
 * memory_manager_staging_row_hashes for every row currently in `table`.
 *
 * WHO CALLS THIS IN PRODUCTION (documented gap, see PR blind-spots): today,
 * nothing does — the actual migrate-NN-*.js data-migration scripts
 * (migrate-03 through migrate-13) that would write real rows into staging
 * and hash them at write time are OUT OF THIS TASK'S SCOPE (only
 * migrate-01-canonical-db.js, the schema-standup script, exists in this
 * repo so far). This helper is what those future scripts should call at
 * write time; until they exist, it is exercised only by
 * test/migrations/test-verify-15.js's synthetic fixtures, which call it
 * directly to populate memory_manager_staging_row_hashes for T3b's
 * proof-of-firing tests.
 */
async function hashAndStoreStagingRows(client, targetTable, cols, opts = {}) {
  const multiset = await hashTableMultiset(client, targetTable, cols, opts);
  const { rows } = await client.query(
    `SELECT ${['id', 'project_id', ...cols].filter((c, i, a) => a.indexOf(c) === i).map((c) => `"${c}"`).join(', ')} FROM ${targetTable}`
  );
  let n = 0;
  for (const r of rows) {
    const h = rowHash(cols, r);
    await client.query(
      `INSERT INTO memory_manager_staging_row_hashes (target_table, project_id, target_row_id, target_hash)
       VALUES ($1,$2,$3,$4)`,
      [targetTable, r.project_id ?? null, String(r.id), h]
    );
    n += 1;
  }
  return { rowsHashed: n, distinctHashes: multiset.size };
}

// ─── DDL (shared tables this battery reads/writes) ───────────────────────────

const DDL_SQL = `
CREATE TABLE IF NOT EXISTS migration_manifest (
  id                  SERIAL PRIMARY KEY,
  source_db           TEXT NOT NULL,
  source_table        TEXT NOT NULL,
  project_id_or_null  TEXT,
  row_count           BIGINT NOT NULL,
  content_fingerprint TEXT NOT NULL,
  captured_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  excluded_reason     TEXT
);
CREATE INDEX IF NOT EXISTS migration_manifest_source_idx ON migration_manifest (source_db, source_table);
CREATE INDEX IF NOT EXISTS migration_manifest_excl_idx   ON migration_manifest (excluded_reason);

-- RETIREMENT (cm#194/cm#196/cm#197/cm#199, 2026-08-18): a SEPARATE mechanism
-- from excluded_reason -- see cure-migration-manifest-retirement.js's header
-- comment for the full rationale. excluded_reason means "this slice was
-- deliberately never migrated" (T9 then POSITIVELY asserts zero live target
-- rows for it); retired_at means "this manifest/row-hash BOOKKEEPING ROW
-- itself is disposed of" (a leaked test-fixture artifact, a stale duplicate
-- capture, or a superseded snapshot) -- the underlying live target data, if
-- any, is untouched and may legitimately still exist under a DIFFERENT,
-- correctly-recorded manifest row. Applying excluded_reason to a leaked row
-- instead would poison every consumer that treats excluded_reason as "prove
-- zero live rows" (T9) or as an embedding-exclusion set (migrate-07 G-R7)
-- for a project that in fact has hundreds of legitimate live rows under the
-- SAME target/project bucket -- retirement avoids that collision entirely by
-- removing the row from consideration everywhere, rather than asserting a
-- false claim about live data. ADDITIVE ALTER (not part of the CREATE TABLE
-- literal above) so an already-existing migration_manifest table on a
-- previously-provisioned staging DB picks up these columns via applyDdl() on
-- next touch, mirroring the PR #204 canon-class pattern (a column defined
-- only inside a CREATE TABLE IF NOT EXISTS body is invisible to a table that
-- already exists; an ALTER TABLE ADD COLUMN IF NOT EXISTS reaches it).
ALTER TABLE migration_manifest ADD COLUMN IF NOT EXISTS retired_at  TIMESTAMPTZ;
ALTER TABLE migration_manifest ADD COLUMN IF NOT EXISTS retired_note TEXT;
CREATE INDEX IF NOT EXISTS migration_manifest_retired_idx ON migration_manifest (retired_at);

CREATE TABLE IF NOT EXISTS migration_manifest_row_hashes (
  id                  SERIAL PRIMARY KEY,
  source_db           TEXT NOT NULL,
  source_table        TEXT NOT NULL,
  project_id_or_null  TEXT,
  source_row_id       TEXT,
  source_hash         TEXT NOT NULL,
  captured_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS migration_manifest_row_hashes_hash_idx ON migration_manifest_row_hashes (source_hash);
CREATE INDEX IF NOT EXISTS migration_manifest_row_hashes_src_idx  ON migration_manifest_row_hashes (source_db, source_table);

-- Same retirement mechanism, same rationale, applied to the per-row hash
-- table (cm#199 comment: the 2 orphan row-hash rows for excluded slice
-- 1642's project carry no excluded_reason column at all on THIS table --
-- retired_at is the disposition mechanism here too, for consistency: one
-- mechanism for every cure this PR ships, never a second ad hoc column).
ALTER TABLE migration_manifest_row_hashes ADD COLUMN IF NOT EXISTS retired_at   TIMESTAMPTZ;
ALTER TABLE migration_manifest_row_hashes ADD COLUMN IF NOT EXISTS retired_note TEXT;

CREATE TABLE IF NOT EXISTS memory_manager_staging_row_hashes (
  id            SERIAL PRIMARY KEY,
  target_table  TEXT NOT NULL,
  project_id    TEXT,
  target_row_id TEXT,
  target_hash   TEXT NOT NULL,
  captured_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS memory_manager_staging_row_hashes_hash_idx ON memory_manager_staging_row_hashes (target_hash);
CREATE INDEX IF NOT EXISTS memory_manager_staging_row_hashes_tbl_idx  ON memory_manager_staging_row_hashes (target_table);

CREATE TABLE IF NOT EXISTS dual_write_shim_window (
  id           SERIAL PRIMARY KEY,
  enabled_at   TIMESTAMPTZ NOT NULL,
  disabled_at  TIMESTAMPTZ,
  enabled_by   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS old_store_row_hashes (
  id          SERIAL PRIMARY KEY,
  project_id  TEXT,
  old_hash    TEXT NOT NULL,
  written_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS old_store_row_hashes_hash_idx ON old_store_row_hashes (old_hash);

CREATE TABLE IF NOT EXISTS containment_evidence (
  id           SERIAL PRIMARY KEY,
  check_id     TEXT NOT NULL CHECK (check_id IN ('T4','F1','F2','F3','F4')),
  query_text   TEXT NOT NULL,
  result       TEXT NOT NULL,
  captured_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  recorded_by  TEXT NOT NULL,
  project_id   TEXT
);
CREATE INDEX IF NOT EXISTS containment_evidence_check_idx ON containment_evidence (check_id);

CREATE TABLE IF NOT EXISTS promotion_conflict_log (
  id                   SERIAL PRIMARY KEY,
  promoted_project_id  TEXT NOT NULL,
  target_table         TEXT NOT NULL,
  row_id               TEXT NOT NULL,
  staging_hash         TEXT NOT NULL,
  canonical_hash       TEXT NOT NULL,
  reviewed             BOOLEAN NOT NULL DEFAULT false,
  reviewed_by          TEXT,
  logged_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- own_graph_migration_ids: migrate-verify-own-graph.js's (§6.1(c)) own
-- source-id -> target-id lineage table. Registered HERE (not as a private
-- DDL constant inside that script) so T0's live-table total classification
-- (verify-15-t0-roster.js, category (b) "battery-infra", derived from THIS
-- FILE's own DDL_SQL text via getBatteryInfraTables() below) recognizes it
-- as battery/engine infrastructure rather than FAILing it as an
-- unclassified table present in the target -- mirrors how migration_manifest
-- itself is registered (a script-agnostic, shared infra table, never a
-- per-script private DDL block). Every in-scope table but project_settings
-- has a real SERIAL id; project_settings' PK is (project_id, key), so its
-- lineage rows carry the key as source_row_id and a dummy sentinel (1) in
-- target_row_id (INTEGER NOT NULL, cannot hold text) -- see that script's
-- header comment.
CREATE TABLE IF NOT EXISTS own_graph_migration_ids (
  id            SERIAL PRIMARY KEY,
  source_db     TEXT NOT NULL,
  source_table  TEXT NOT NULL,
  source_row_id TEXT NOT NULL,
  project_id    TEXT,
  target_table  TEXT NOT NULL,
  target_row_id INTEGER NOT NULL,
  migrated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (source_db, source_table, source_row_id)
);
CREATE INDEX IF NOT EXISTS own_graph_migration_ids_slice_idx
  ON own_graph_migration_ids (source_db, source_table, project_id);

-- pipeline_migration_row_ids: migrate-04-absorb-pipeline-tables.js's (§6.1(e)
-- amendment E-6, mm#11(e)) own source-id -> target-id lineage table, mirroring
-- own_graph_migration_ids above verbatim in shape and in the reason for being
-- registered HERE rather than as a private DDL block inside that script (same
-- T0 live-table-classification argument). source_row_id is TEXT so one column
-- serves every in-scope table regardless of source PK shape (findings.id is
-- already TEXT; every other in-scope table's source PK is an integer SERIAL,
-- cast to TEXT at write time). target_row_id is INTEGER for every table with
-- a real target SERIAL id; findings' target identity is its composite PK
-- (project_id, id) — a TEXT id it verbatim-preserves from the source, not a
-- SERIAL — so findings' lineage rows carry that id string in source_row_id
-- and a dummy sentinel (1) in target_row_id (INTEGER NOT NULL, cannot hold
-- text), exactly mirroring own_graph_migration_ids' project_settings
-- precedent: deletes/lookups for findings are scoped by (project_id, id)
-- directly, never by target_row_id (see migrate-04-absorb-pipeline-tables.js
-- header comment, E-6 resolution).
CREATE TABLE IF NOT EXISTS pipeline_migration_row_ids (
  id            SERIAL PRIMARY KEY,
  source_db     TEXT NOT NULL,
  source_table  TEXT NOT NULL,
  source_row_id TEXT NOT NULL,
  project_id    TEXT NOT NULL,
  target_table  TEXT NOT NULL,
  target_row_id INTEGER NOT NULL,
  migrated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (source_db, source_table, source_row_id)
);
CREATE INDEX IF NOT EXISTS pipeline_migration_row_ids_slice_idx
  ON pipeline_migration_row_ids (source_db, source_table, project_id);
`.trim();

async function applyDdl(client) {
  await client.query(DDL_SQL);
}

// Table names this battery's OWN DDL creates, DERIVED FROM DDL_SQL's own
// text (never a hand-maintained second list — same "no hand-enumerated
// table lists" posture as migrate-01-canonical-db.js's deriveExpectedObjects,
// which this regex is deliberately styled after). Used by T0's live-table
// total classification (final-review finding, PR #152) to recognize this
// battery's own infrastructure tables (migration_manifest,
// containment_evidence, …) as a distinct class from engine-core or
// roster/inventory-declared tables.
const DDL_TABLE_RE = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?"?([a-zA-Z_][a-zA-Z0-9_]*)"?/gi;

function getBatteryInfraTables() {
  const tables = new Set();
  let m;
  DDL_TABLE_RE.lastIndex = 0;
  while ((m = DDL_TABLE_RE.exec(DDL_SQL))) tables.add(m[1].toLowerCase());
  return tables;
}

/**
 * The engine-core table/view set, derived at RUNTIME by reusing
 * migrate-01-canonical-db.js's OWN deriveExpectedObjects() over its OWN
 * four SCHEMA_FILES — never a duplicated parser or a second hand-maintained
 * list (final-review finding, PR #152: "import it; if not exported, export
 * it — do not duplicate the parser." It was already exported.)
 *
 * @returns {{ tables: Set<string>, views: Set<string> }}
 */
function getEngineCoreObjects() {
  return migrateOne.deriveExpectedObjects(migrateOne.SCHEMA_FILES);
}

// ─── containment_evidence WRITER (T4/F1-F4, §15.2.1) ─────────────────────────

async function writeContainmentEvidence(client, { checkId, queryText, result, recordedBy, projectId = null }) {
  if (!['T4', 'F1', 'F2', 'F3', 'F4'].includes(checkId)) {
    throw new Error(`writeContainmentEvidence: invalid checkId "${checkId}"`);
  }
  const { rows } = await client.query(
    `INSERT INTO containment_evidence (check_id, query_text, result, recorded_by, project_id)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [checkId, queryText, result, recordedBy, projectId]
  );
  return rows[0].id;
}

// ─── AUTHORSHIP (T10's independence cross-check, §15.2 V-6) ─────────────────

function loadHarnessAuthorship() {
  const p = path.join(MIGRATIONS_DIR, 'harness-authorship.json');
  const raw = fs.readFileSync(p, 'utf8');
  const data = JSON.parse(raw);
  // Strip the _comment documentation key — every OTHER key is a script
  // filename mapping to { AUTHORED_BY }. Filtering here (once, centrally)
  // means every caller (T10's independence cross-check, tests) gets a clean
  // script-name -> {AUTHORED_BY} map without re-implementing the filter.
  const clean = {};
  for (const [key, value] of Object.entries(data)) {
    if (key.startsWith('_')) continue;
    clean[key] = value;
  }
  return clean;
}

module.exports = {
  MIGRATIONS_DIR,
  pgConfig,
  connect,
  parseDbFlag,
  resolveAndClassifyTargetDb,
  resolveAndClassifySourceDb,
  ROSTER_ENV_VAR,
  ROSTER_EXAMPLE_FILE,
  REQUIRED_ROSTER_FIELDS,
  resolveRosterPath,
  validateRosterShape,
  NET_NEW_PREFIX,
  classifyRosterSourceDb,
  partitionRoster,
  validateRosterSourceDbShapes,
  validateRosterPartitionDisjoint,
  loadRoster,
  LINEAGE_TABLE_VOCAB,
  MEMBERSHIP_CODECS,
  getMembershipCodec,
  validateLineageDeclarations,
  countLineageRows,
  loadLineageMap,
  loadLineageMapWithProjectId,
  checkLineagePopulationOrFatal,
  branchSelectionFlags,
  validateDeclarationMutualExclusion,
  validateManifestLabelDuplicates,
  validateSourceProjectExclusionDeclarations,
  assertSafeIdentifier,
  SAFE_IDENTIFIER_RE,
  buildTargetTableByPairMap,
  resolveTargetTableForPair,
  buildRosterPairSet,
  isRosterPaired,
  DB_TRIAGE_ENV_VAR,
  DB_TRIAGE_EXAMPLE_FILE,
  DB_TRIAGE_VALID_CLASSES,
  parseTriageFlag,
  resolveDbTriagePath,
  loadDbTriageForAudit,
  classifyManifestRow,
  NETNEW_SOURCE_DB_PREFIX,
  FILESYSTEM_SOURCE_DB_PREFIX,
  tableHasColumn,
  crossCheckProjectIdScope,
  reconcileNoColumnTable,
  NULL_SENTINEL,
  rowHash,
  resolveHashCols,
  hashTableMultiset,
  hashTableMultisetExcludingProjects,
  loadExclusionsFor,
  hashAndStoreStagingRows,
  buildLoadBearingColsFromRoster,
  DDL_SQL,
  applyDdl,
  getBatteryInfraTables,
  getEngineCoreObjects,
  writeContainmentEvidence,
  loadHarnessAuthorship,
};
