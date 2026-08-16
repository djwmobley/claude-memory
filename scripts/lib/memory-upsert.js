'use strict';

/**
 * memory-upsert.js — §7.2/§7.3 typed, INSERT-ONLY write path for the 9
 * §5.3 seam tables that carry a live MCP write surface (CONSOLIDATION-
 * RUNBOOK.md, spec-adversary pass 2026-08-15, S-1..S-6, memory-manager#17).
 *
 * NAMING NOTE (S-2): the tool/function is named "upsert" for §8 naming
 * compatibility ONLY — it does NOT upsert. Every write in Phase 7 is a
 * plain INSERT; there is no in-place UPDATE path. A PK/unique collision is
 * a loud tool error, never a silent overwrite.
 *
 * CAVEMAN MANDATE (§3.4): every caller of writeMemoryRow MUST author
 * text-bearing columns in caveman/telegraphic English (§3.1) unless the
 * row is explicitly tagged authoring_mode='verbose' (§3.3's narrow,
 * tagged exception). This module does NOT enforce that server-side (S-5 —
 * authoring_mode truthfulness is NOT server-validated in Phase 7); the
 * mandate is carried in MEMORY_UPSERT_TOOL_DESCRIPTION below so it is
 * visible to any MCP client at call time, per §3.4's "stated in the tool's
 * description" enforcement pattern (the same pattern already proven by
 * EXTRACTION_PAYLOAD_FIELD_CONTRACT in scripts/handoff.js).
 *
 * SCOPE (S-1): TABLE_COLUMN_MAP below is a CLOSED enum of exactly 9 tables
 * — the total classification, not an allow-list: anything outside these 9
 * names is a hard tool error (unknownTable), never a silent no-op. The
 * OTHER 4 §5.3 seam tables (workflow_discovery, agent_rewrites,
 * policy_sections, session_chunks) have no live MCP write surface in Phase
 * 7 — they are ingest/migration-populated only, per §7.3's own table list.
 *
 * IDENTIFIER SAFETY (S-1): table and column identifiers used in the
 * generated SQL come ONLY from this file's own hardcoded TABLE_COLUMN_MAP
 * (never from caller input). Every VALUE is parameterized ($1, $2, ...).
 * Caller-supplied `row` keys are validated against the map's key set
 * BEFORE being used to build a column list — an unrecognized key is
 * rejected (S-4) before it ever reaches string-building, let alone SQL.
 */

const path = require('path');

// ─── Column contract per table (S-1: hardcoded, never derived from caller
// input; S-3: app-level validation rules per column). type: 'text' | 'int'
// | 'bool'. required: true => must be present and (for text) non-empty
// after trim. authoringModeColumn: true marks the table's authoring_mode
// column, validated against the caveman/verbose enum specifically.
// ────────────────────────────────────────────────────────────────────────

const TABLE_COLUMN_MAP = {
  decisions: {
    columns: {
      project_id:          { type: 'text', required: true },
      session_num:         { type: 'int',  required: false },
      topic:                { type: 'text', required: true },
      decision:             { type: 'text', required: true },
      reason:               { type: 'text', required: false },
      source_project_hint:  { type: 'text', required: false },
      source_model:         { type: 'text', required: false },
      agent_id:             { type: 'text', required: false },
      authoring_mode:       { type: 'text', required: false, authoringModeColumn: true },
    },
  },
  gotchas: {
    columns: {
      project_id:     { type: 'text', required: true },
      issue:           { type: 'text', required: true },
      rule:            { type: 'text', required: true },
      active:          { type: 'bool', required: false },
      source_model:    { type: 'text', required: false },
      agent_id:        { type: 'text', required: false },
      authoring_mode:  { type: 'text', required: false, authoringModeColumn: true },
    },
  },
  findings: {
    // PK is (project_id, id) — id is TEXT and caller-supplied (source-
    // prefixed, e.g. "RT-INJ-001"), so it is a REQUIRED column here, unlike
    // every other table's server-generated SERIAL id.
    columns: {
      id:                    { type: 'text', required: true },
      project_id:            { type: 'text', required: true },
      source:                { type: 'text', required: true },
      severity:              { type: 'text', required: true },
      confidence:            { type: 'text', required: true },
      location:              { type: 'text', required: true },
      category:              { type: 'text', required: true },
      description:           { type: 'text', required: true },
      impact:                { type: 'text', required: true },
      remediation:           { type: 'text', required: true },
      effort:                { type: 'text', required: true },
      verification_domain:   { type: 'text', required: false },
      status:                { type: 'text', required: false },
      github_issue:          { type: 'int',  required: false },
      commit_sha:            { type: 'text', required: false },
      task_id:               { type: 'int',  required: false },
      report_path:           { type: 'text', required: false },
      source_model:          { type: 'text', required: false },
      agent_id:              { type: 'text', required: false },
      authoring_mode:        { type: 'text', required: false, authoringModeColumn: true },
    },
  },
  research: {
    columns: {
      project_id:      { type: 'text', required: true },
      task_id:          { type: 'int',  required: false },
      title:            { type: 'text', required: true },
      body:             { type: 'text', required: true },
      source_model:     { type: 'text', required: false },
      agent_id:         { type: 'text', required: false },
      authoring_mode:   { type: 'text', required: false, authoringModeColumn: true },
    },
  },
  incidents: {
    columns: {
      project_id:      { type: 'text', required: true },
      incident_code:    { type: 'text', required: false },
      title:            { type: 'text', required: true },
      what_happened:    { type: 'text', required: false },
      what_we_did:      { type: 'text', required: false },
      watch_for:        { type: 'text', required: false },
      source_model:     { type: 'text', required: false },
      agent_id:         { type: 'text', required: false },
      authoring_mode:   { type: 'text', required: false, authoringModeColumn: true },
    },
  },
  code_index: {
    columns: {
      project_id:    { type: 'text', required: true },
      path:           { type: 'text', required: true },
      description:    { type: 'text', required: true },
      source_model:   { type: 'text', required: false },
      agent_id:       { type: 'text', required: false },
    },
  },
  tasks: {
    columns: {
      project_id:    { type: 'text', required: true },
      title:          { type: 'text', required: true },
      status:         { type: 'text', required: false },
      phase:          { type: 'text', required: false },
      priority:       { type: 'text', required: false },
      github_issue:   { type: 'int',  required: false },
      readme_label:   { type: 'text', required: false },
      category:       { type: 'text', required: false },
      source_model:   { type: 'text', required: false },
      agent_id:       { type: 'text', required: false },
    },
  },
  checklist_items: {
    columns: {
      project_id:          { type: 'text', required: true },
      checklist_name:       { type: 'text', required: true },
      cadence:              { type: 'text', required: false },
      title:                { type: 'text', required: true },
      description:          { type: 'text', required: false },
      verification_step:    { type: 'text', required: false },
      source_model:         { type: 'text', required: false },
      agent_id:             { type: 'text', required: false },
    },
  },
  corpus_files: {
    columns: {
      project_id:      { type: 'text', required: true },
      path:             { type: 'text', required: true },
      file_type:        { type: 'text', required: false },
      source_domain:    { type: 'text', required: false },
      summary:          { type: 'text', required: false },
      bytes:            { type: 'int',  required: false },
      source_model:     { type: 'text', required: false },
      agent_id:         { type: 'text', required: false },
    },
  },
};

// S-1: closed enum, total classification (anything outside this list is
// unknownTable, a hard error).
const ALLOWED_TABLES = Object.freeze(Object.keys(TABLE_COLUMN_MAP));

const AUTHORING_MODE_VALUES = new Set(['caveman', 'verbose']);

/**
 * §8 M-2: per-table embed-text builder — the concatenation of text columns
 * fed to the embedding provider at write time (mirrors §10.2's
 * v_memory_hits_unified "content" column definitions, so the same text a
 * row would surface under in hybrid recall is the same text it was embedded
 * from). Pure; never touches the DB. Returns '' when the row carries none of
 * the listed columns (caller treats '' as "nothing to embed").
 */
const EMBED_TEXT_BUILDERS = {
  decisions: (row) => [row.topic, row.decision, row.reason].filter(Boolean).join(' '),
  gotchas: (row) => [row.issue, row.rule].filter(Boolean).join(' '),
  findings: (row) => [row.description, row.impact, row.remediation].filter(Boolean).join(' '),
  research: (row) => [row.title, row.body].filter(Boolean).join(' '),
  incidents: (row) => [row.title, row.what_happened, row.what_we_did].filter(Boolean).join(' '),
  code_index: (row) => row.description || '',
  tasks: (row) => row.title || '',
  checklist_items: (row) => [row.title, row.description].filter(Boolean).join(' '),
  corpus_files: (row) => row.summary || row.path || '',
};

function buildEmbedText(table, row) {
  const builder = EMBED_TEXT_BUILDERS[table];
  return builder ? builder(row || {}) : '';
}

/**
 * Tool-description text (§3.4/S-5): stated here so any MCP client wiring
 * this function up to a tool definition can surface the caveman mandate at
 * call time, mirroring EXTRACTION_PAYLOAD_FIELD_CONTRACT's proven pattern
 * in scripts/handoff.js.
 */
const MEMORY_UPSERT_TOOL_DESCRIPTION = [
  'Write ONE typed row to a §5.3 seam table (decisions/gotchas/findings/',
  'research/incidents/code_index/tasks/checklist_items/corpus_files).',
  'INSERT-ONLY: there is no update path; a PK/unique collision is a loud',
  'error, never a silent overwrite.',
  '',
  'CAVEMAN MANDATE (§3.1/§3.4): every text-bearing column MUST be authored',
  'in caveman/telegraphic English — strip articles/copulas/prepositions,',
  'keep every load-bearing token (identifiers, paths, line numbers, PR',
  'numbers, SHAs, names, numbers, decisions, enum values) verbatim. The',
  "ONLY exception is a row explicitly tagged authoring_mode='verbose'",
  '(§3.3) for genuinely long-form or precision-sensitive content (e.g. a',
  'quoted stack trace) — default is authoring_mode=\'caveman\' everywhere',
  'this column exists. authoring_mode truthfulness is NOT server-validated',
  '(§3.4/S-5) — enforcement is this description plus the CI caveman-',
  'economy test gate plus code review, same as everywhere else in this',
  'codebase.',
].join('\n');

class MemoryUpsertError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'MemoryUpsertError';
    this.code = code; // 'unknownTable' | 'unknownKey' | 'validation' | 'collision'
    this.details = details || null;
  }
}

/**
 * validateRow — S-3's app-level, per-column validation. Runs entirely
 * before any SQL is issued. Returns nothing on success; throws
 * MemoryUpsertError('validation', ...) on the FIRST violation found (a
 * clean, named error — never "let Postgres reject it").
 */
function validateRow(table, columnMap, row) {
  // S-4: unknown/extra keys hard-rejected (ALLOWED_KEYS pattern, mirrored
  // from scripts/handoff.js's stdin-validation precedent).
  const allowedKeys = new Set(Object.keys(columnMap));
  for (const k of Object.keys(row)) {
    if (!allowedKeys.has(k)) {
      throw new MemoryUpsertError(
        'unknownKey',
        `memory_upsert: table "${table}" has no column "${k}" (allowed: ${[...allowedKeys].join(', ')})`,
        { table, key: k }
      );
    }
  }

  for (const [col, spec] of Object.entries(columnMap)) {
    const present = Object.prototype.hasOwnProperty.call(row, col) && row[col] !== undefined && row[col] !== null;

    if (!present) {
      if (spec.required) {
        throw new MemoryUpsertError(
          'validation',
          `memory_upsert: table "${table}" column "${col}" is required and was not provided`,
          { table, column: col }
        );
      }
      continue;
    }

    const value = row[col];

    if (spec.type === 'text') {
      if (typeof value !== 'string') {
        throw new MemoryUpsertError(
          'validation',
          `memory_upsert: table "${table}" column "${col}" must be a string (got ${typeof value})`,
          { table, column: col }
        );
      }
      if (spec.required && value.trim().length === 0) {
        throw new MemoryUpsertError(
          'validation',
          `memory_upsert: table "${table}" column "${col}" is required and must be non-empty after trim`,
          { table, column: col }
        );
      }
      // NOTE: no `value.trim().length > 0` guard here (post-review fix,
      // S-3) -- authoring_mode is OPTIONAL (the `present` check above
      // already lets an absent/null value skip straight through), but once
      // a caller explicitly PROVIDES a value -- including an empty string
      // -- it must be validated against the enum. An empty-string guard
      // let `authoring_mode: ''` bypass this app-level check entirely and
      // reach Postgres as a raw 23514 CHECK-constraint violation instead of
      // a clean MemoryUpsertError, which is exactly what S-3 requires this
      // function to prevent ("a clean tool error raised BEFORE any SQL is
      // issued").
      if (spec.authoringModeColumn && !AUTHORING_MODE_VALUES.has(value)) {
        throw new MemoryUpsertError(
          'validation',
          `memory_upsert: table "${table}" column "${col}" must be one of 'caveman'/'verbose' (got ${JSON.stringify(value)})`,
          { table, column: col }
        );
      }
    } else if (spec.type === 'int') {
      if (!Number.isInteger(value)) {
        throw new MemoryUpsertError(
          'validation',
          `memory_upsert: table "${table}" column "${col}" must be an actual integer (no string coercion; got ${JSON.stringify(value)})`,
          { table, column: col }
        );
      }
    } else if (spec.type === 'bool') {
      if (typeof value !== 'boolean') {
        throw new MemoryUpsertError(
          'validation',
          `memory_upsert: table "${table}" column "${col}" must be a boolean (got ${typeof value})`,
          { table, column: col }
        );
      }
    }
  }
}

/**
 * writeMemoryRow — the ONE typed, INSERT-ONLY write path for the 9 §5.3
 * seam tables (§7.2/§7.3).
 *
 * @param {object} client - pg client/pool
 * @param {string} table  - MUST be one of ALLOWED_TABLES (S-1)
 * @param {object} row    - column values; unknown keys are rejected (S-4)
 * @param {object} [opts]
 * @param {string|null} [opts.embeddingVectorLiteral] - §8 M-2: a
 *   server-computed halfvec literal string (e.g. "[0.1,0.2,...]"), added to
 *   the INSERT alongside the validated columns AFTER validateRow succeeds —
 *   this is NEVER caller-supplied via `row` (the embedding column is
 *   deliberately absent from every table's TABLE_COLUMN_MAP, so a raw
 *   client-side embedding can never be smuggled through `row`; only the MCP
 *   tool-orchestration layer populates this opt, from its own
 *   server-computed vector, mirroring exchange_append's "tool ships it"
 *   posture). null/omitted = embedding left NULL (fail-soft path, M-2).
 * @returns {Promise<{id: *}>} the inserted row's primary-key value(s) —
 *   `id` for every table except `findings`, where it echoes back the
 *   caller-supplied (project_id, id) pair as `{id, project_id}`.
 * @throws {MemoryUpsertError} 'unknownTable' | 'unknownKey' | 'validation'
 *   | 'collision'
 */
async function writeMemoryRow(client, table, row, opts) {
  if (!Object.prototype.hasOwnProperty.call(TABLE_COLUMN_MAP, table)) {
    throw new MemoryUpsertError(
      'unknownTable',
      `memory_upsert: unknown table "${table}" (allowed: ${ALLOWED_TABLES.join(', ')})`,
      { table }
    );
  }
  const columnMap = TABLE_COLUMN_MAP[table].columns;

  validateRow(table, columnMap, row || {});

  const cols = Object.keys(columnMap).filter((c) =>
    Object.prototype.hasOwnProperty.call(row, c) && row[c] !== undefined && row[c] !== null
  );
  const values = cols.map((c) => row[c]);

  const embeddingVectorLiteral = opts && opts.embeddingVectorLiteral ? opts.embeddingVectorLiteral : null;
  if (embeddingVectorLiteral !== null) {
    cols.push('embedding');
    values.push(embeddingVectorLiteral);
  }
  const placeholders = values.map((_, i) => `$${i + 1}`);

  // Identifiers (table, cols) come ONLY from TABLE_COLUMN_MAP's own key set
  // above, plus the single hardcoded literal "embedding" — never from caller
  // input directly (S-1). Every value is parameterized.
  const quotedCols = cols.map((c) => `"${c}"`).join(', ');
  const sql = `INSERT INTO "${table}" (${quotedCols}) VALUES (${placeholders.join(', ')}) RETURNING *`;

  try {
    const { rows } = await client.query(sql, values);
    return rows[0];
  } catch (err) {
    // S-2: PK/unique collision is a loud tool error, never a silent
    // overwrite (no ON CONFLICT clause exists anywhere in this path).
    if (err && err.code === '23505') {
      throw new MemoryUpsertError(
        'collision',
        `memory_upsert: table "${table}" INSERT violates a PK/unique constraint (${err.constraint || 'unknown constraint'}) — Phase 7 is INSERT-ONLY, there is no update path`,
        { table, constraint: err.constraint, pgMessage: err.message }
      );
    }
    throw err;
  }
}

/**
 * upsertDecisionRow — §8 M-1's EXPLICIT, NAMED carve-out from S-2's
 * INSERT-ONLY rule: "ON CONFLICT (project_id, topic) DO UPDATE ... No other
 * table gets this carve-out." Backed by decisions_audit (AFTER UPDATE),
 * which preserves the prior value in the append-only audit_log ledger, so
 * the UPDATE is non-destructive in the ledger sense (M-1's own
 * justification). Requires the decisions_project_topic_unique index
 * (scripts/migrations/sql/migrate-15-mcp-addenda.sql) to exist on the
 * target — without it, ON CONFLICT (project_id, topic) has no matching
 * arbiter index and Postgres raises 42P10, surfaced here as a named error
 * rather than a raw driver error.
 *
 * @param {object} client
 * @param {object} row - same shape/validation as TABLE_COLUMN_MAP.decisions
 * @param {object} [opts]
 * @param {string|null} [opts.embeddingVectorLiteral] - §8 M-2, same
 *   contract as writeMemoryRow's opt.
 * @returns {Promise<object>} the post-write row (RETURNING *) plus
 *   `{ inserted: boolean }` (xmax = 0 idiom, same as usage-telemetry.js's
 *   usageRecord — true iff this call's own upsert performed the physical
 *   INSERT rather than the UPDATE branch).
 * @throws {MemoryUpsertError} 'unknownKey' | 'validation'
 */
async function upsertDecisionRow(client, row, opts) {
  const columnMap = TABLE_COLUMN_MAP.decisions.columns;
  validateRow('decisions', columnMap, row || {});

  const cols = Object.keys(columnMap).filter((c) =>
    Object.prototype.hasOwnProperty.call(row, c) && row[c] !== undefined && row[c] !== null
  );
  const values = cols.map((c) => row[c]);

  const embeddingVectorLiteral = opts && opts.embeddingVectorLiteral ? opts.embeddingVectorLiteral : null;
  if (embeddingVectorLiteral !== null) {
    cols.push('embedding');
    values.push(embeddingVectorLiteral);
  }
  const placeholders = values.map((_, i) => `$${i + 1}`);
  const quotedCols = cols.map((c) => `"${c}"`).join(', ');

  // UPDATE SET list: every column this call actually supplied, EXCEPT the
  // conflict-key columns (project_id, topic) themselves — those never
  // change on an update-by-key. embedding (when supplied) IS re-set on
  // conflict, so a topic edit's new embedding replaces the stale one.
  const setCols = cols.filter((c) => c !== 'project_id' && c !== 'topic');
  const setClause = setCols.length
    ? setCols.map((c) => `"${c}" = EXCLUDED."${c}"`).join(', ')
    : null;

  const sql = setClause
    ? `INSERT INTO "decisions" (${quotedCols}) VALUES (${placeholders.join(', ')})
       ON CONFLICT (project_id, topic) DO UPDATE SET ${setClause}
       RETURNING *, (xmax = 0) AS inserted`
    : `INSERT INTO "decisions" (${quotedCols}) VALUES (${placeholders.join(', ')})
       ON CONFLICT (project_id, topic) DO NOTHING
       RETURNING *, (xmax = 0) AS inserted`;

  const { rows } = await client.query(sql, values);
  if (rows.length === 0) {
    // Only reachable via the DO NOTHING branch (no non-key column supplied
    // on a conflicting row) — the existing row is unchanged; re-select it so
    // the caller always gets a row back, never an empty result on a benign
    // no-op conflict.
    const { rows: existing } = await client.query(
      `SELECT *, false AS inserted FROM decisions WHERE project_id = $1 AND topic = $2`,
      [row.project_id, row.topic]
    );
    return existing[0];
  }
  return rows[0];
}

// ─── Ingest-time contradiction flagging — ASSERTION writes ONLY (§7.3/S-6
// scope note: "the §5.3 seam-table rows have no (subject, predicate) pair,
// and contradiction flagging is explicitly NOT DEFINED for them; they get
// none in Phase 7"). writeMemoryRow above NEVER calls this — it is a
// separate, composable helper for whatever assertion-write call site needs
// it (existing or future), reusing normalize-text.js's shared
// materiallyDifferent (S-8) so this comparison can never drift from §7.4's
// probe or §7.8's lint checks. ──────────────────────────────────────────

const { materiallyDifferent } = require(path.join(__dirname, 'normalize-text.js'));

/**
 * findContradictingAssertion — S-6's ingest-time check: is there an
 * existing, un-superseded assertion on the same (project_id, subject,
 * predicate) whose object is MATERIALLY DIFFERENT (S-6 normalization) from
 * the candidate object? Read-only — never writes, never blocks.
 *
 * Subject matching is LOWER(TRIM()) (post-review fix, G1) — an exact
 * `subject = $2` match would make live rows with subjects "Foo" vs "foo"
 * invisible to each other, exactly the same gap memory-lint.js's
 * contradicting_assertions check had before its own G1 fix. This aligns
 * with every other subject-matching call site this PR introduces
 * (carryover-render.js's findLiveOpenThreadRows, mirroring
 * scripts/handoff.js's own resolved_threads auto-retire matcher).
 *
 * @returns {Promise<{id:number, object:string}|null>} the first
 *   conflicting row (id + object), or null if none / no material
 *   difference.
 */
async function findContradictingAssertion(client, projectId, subject, predicate, candidateObject) {
  const { rows } = await client.query(
    `SELECT id, object FROM assertions
      WHERE project_id = $1 AND LOWER(TRIM(subject)) = LOWER(TRIM($2)) AND predicate = $3
        AND suppressed = false AND invalid_at IS NULL
      ORDER BY id ASC`,
    [projectId, subject, predicate]
  );
  for (const row of rows) {
    if (materiallyDifferent(row.object, candidateObject)) {
      return { id: row.id, object: row.object };
    }
  }
  return null;
}

// ─── memory_get — §8's direct lookup-by-natural-key tool ───────────────────
//
// "direct lookup by table + natural key (e.g. `decisions` by
// `(project_id, topic)`, `findings` by `(project_id, id)`)."
//
// `key` is a plain {column: value} object. Column names are validated
// against TABLE_COLUMN_MAP[table]'s own key set PLUS the literal 'id' (an
// implicit lookup key on every table, even the tables whose SERIAL id is
// server-generated and therefore absent from TABLE_COLUMN_MAP's
// caller-writable column set) — never caller-supplied SQL identifiers
// (S-1's identifier-safety rule, reused here).

async function memoryGet(client, table, projectId, key) {
  if (!Object.prototype.hasOwnProperty.call(TABLE_COLUMN_MAP, table)) {
    throw new MemoryUpsertError(
      'unknownTable',
      `memory_get: unknown table "${table}" (allowed: ${ALLOWED_TABLES.join(', ')})`,
      { table }
    );
  }
  if (typeof projectId !== 'string' || !projectId.trim()) {
    throw new MemoryUpsertError('validation', 'memory_get: projectId is required and must be a non-empty string');
  }
  if (typeof key !== 'object' || key === null || Array.isArray(key) || Object.keys(key).length === 0) {
    throw new MemoryUpsertError('validation', 'memory_get: key must be a non-empty plain object of {column: value}');
  }

  const allowedKeys = new Set([...Object.keys(TABLE_COLUMN_MAP[table].columns), 'id']);
  const keyCols = Object.keys(key);
  for (const k of keyCols) {
    if (!allowedKeys.has(k)) {
      throw new MemoryUpsertError(
        'unknownKey',
        `memory_get: table "${table}" has no lookup column "${k}" (allowed: ${[...allowedKeys].join(', ')})`,
        { table, key: k }
      );
    }
  }

  const conditions = ['project_id = $1'];
  const values = [projectId];
  for (const k of keyCols) {
    values.push(key[k]);
    conditions.push(`"${k}" = $${values.length}`);
  }

  const { rows } = await client.query(
    `SELECT * FROM "${table}" WHERE ${conditions.join(' AND ')}`,
    values
  );
  return rows;
}

module.exports = {
  TABLE_COLUMN_MAP,
  ALLOWED_TABLES,
  AUTHORING_MODE_VALUES,
  MEMORY_UPSERT_TOOL_DESCRIPTION,
  MemoryUpsertError,
  validateRow,
  writeMemoryRow,
  upsertDecisionRow,
  findContradictingAssertion,
  EMBED_TEXT_BUILDERS,
  buildEmbedText,
  memoryGet,
};
