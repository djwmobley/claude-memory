'use strict';

/**
 * entity-graph-crud.js — §8 granular entity/assertion/edge CRUD
 * (CONSOLIDATION-RUNBOOK.md §8's "Entity/assertion/edge CRUD" bullet +
 * M-4/M-5/M-6/M-12/M-13, memory-manager#18).
 *
 * Exposes the graph-core write path OUTSIDE the checkpoint/close
 * batch-payload flow — single-row create/read/update/suppress operations
 * for callers (e.g. an A2A message handler) that want to assert one fact
 * without staging a full close payload.
 *
 * REQUIRES the §8 schema-addenda migration (migrate-15-mcp-addenda.js):
 *   - entities.suppressed / edges.suppressed BOOLEAN NOT NULL DEFAULT false
 *     (M-4)
 *   - entities_audit trigger (M-4, §5.8.1 wired-set 16 -> 17)
 *   - entities_name_trgm_idx (pg_trgm GIN index, supports M-12/M-13's
 *     fuzzy-match query at scale — pg_trgm extension itself is a
 *     prerequisite, already present on the staging target)
 *
 * NON-DESTRUCTIVE SUPERSESSION (assertions only, §5.1's bi-temporal
 * pattern): assertionUpdate suppresses the old row (suppressed=true,
 * invalid_at=now()) and inserts a new one, in ONE transaction, guarded by
 * an optimistic row-count check (M-5) — mirrors exchange-log.js's proven
 * UPDATE ... WHERE id=$1 AND <expected-current-state> RETURNING pattern,
 * never a second, independent implementation of that guard shape.
 *
 * entities/edges do NOT share assertions' bi-temporal (valid_at/invalid_at)
 * design — the runbook's supersession language (§5.1) is scoped to
 * assertions specifically. entityUpdate/edgeUpdate are therefore plain
 * in-place UPDATEs (forensically visible via the entities_audit/edges_audit
 * triggers this same PR wires/already wires) — a unilaterally-resolved
 * design choice, flagged in the authoring PR body, not silently assumed.
 */

const { normalizeForCompare } = require('./normalize-text.js');
const { cardinalityOf } = require('./predicate-registry.js');

class EntityGraphCrudError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'EntityGraphCrudError';
    this.code = code;
    this.details = details || null;
  }
}

function requireNonEmptyString(value, name) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new EntityGraphCrudError('validation', `entity-graph-crud: "${name}" is required and must be a non-empty string`);
  }
  return value;
}

// ─────────────────────────────────────────────────────────────────────────
// M-12/M-13: near-match surfacing on entity create.
//   - ALWAYS the exact normalizeForCompare-equal check first.
//   - PLUS trigram fuzzy at similarity >= 0.4.
//   - Candidates < 4 chars normalized get EXACT-ONLY (flood guard, mirrors
//     §7.8's MIN_MENTION_NAME_LEN precedent).
//   - Explicit AND project_id = $1 on every query.
//   - Warnings returned, NEVER auto-merged.
// ─────────────────────────────────────────────────────────────────────────

const FUZZY_MIN_NORMALIZED_LEN = 4;
const FUZZY_SIMILARITY_THRESHOLD = 0.4;

/**
 * findNearMatchEntities — read-only. Returns { exact: [...], fuzzy: [...] }
 * (each row: { id, name, suppressed }), project-scoped, excluding NOTHING
 * by suppressed-state here (both live and suppressed rows are surfaced —
 * entityCreate's caller decides what to do with a suppressed exact match;
 * see the revival branch below).
 */
async function findNearMatchEntities(client, projectId, name) {
  requireNonEmptyString(projectId, 'projectId');
  requireNonEmptyString(name, 'name');

  const normalized = normalizeForCompare(name);

  const { rows: exactRows } = await client.query(
    `SELECT id, name, suppressed FROM entities
      WHERE project_id = $1 AND lower(trim(name)) = lower(trim($2))`,
    [projectId, name]
  );
  const exact = exactRows.filter((r) => normalizeForCompare(r.name) === normalized);

  let fuzzy = [];
  if (normalized.length >= FUZZY_MIN_NORMALIZED_LEN) {
    const { rows: fuzzyRows } = await client.query(
      `SELECT id, name, suppressed, similarity(name, $2) AS sim
         FROM entities
        WHERE project_id = $1 AND similarity(name, $2) >= $3
        ORDER BY sim DESC`,
      [projectId, name, FUZZY_SIMILARITY_THRESHOLD]
    );
    const exactIds = new Set(exact.map((r) => r.id));
    fuzzy = fuzzyRows.filter((r) => !exactIds.has(r.id));
  }

  return { exact, fuzzy };
}

/**
 * entityCreate — M-4 revival semantics + M-12/M-13 near-match surfacing.
 *
 * @returns {Promise<{ row: object, revived: boolean, warnings: object }>}
 *   warnings = { exact: [...], fuzzy: [...] } — near-match rows OTHER than
 *   the one actually written/revived (never auto-merged).
 */
async function entityCreate(client, { projectId, name, entityType, description, sourceModel, agentId }) {
  requireNonEmptyString(projectId, 'projectId');
  requireNonEmptyString(name, 'name');
  requireNonEmptyString(entityType, 'entityType');

  const { exact, fuzzy } = await findNearMatchEntities(client, projectId, name);
  const suppressedExact = exact.find((r) => r.suppressed === true);

  if (suppressedExact) {
    // M-4: revival — un-suppress + update, never a second insert.
    const { rows } = await client.query(
      `UPDATE entities SET suppressed = false, entity_type = $1, description = $2
        WHERE id = $3 AND project_id = $4
        RETURNING *`,
      [entityType, description || null, suppressedExact.id, projectId]
    );
    return {
      row: rows[0],
      revived: true,
      warnings: {
        exact: exact.filter((r) => r.id !== suppressedExact.id),
        fuzzy,
      },
    };
  }

  const { rows } = await client.query(
    `INSERT INTO entities (project_id, name, entity_type, description, source_model, agent_id)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING *`,
    [projectId, name, entityType, description || null, sourceModel || null, agentId || null]
  );
  return { row: rows[0], revived: false, warnings: { exact, fuzzy } };
}

async function entityRead(client, { projectId, id, name }) {
  requireNonEmptyString(projectId, 'projectId');
  if (id === undefined && name === undefined) {
    throw new EntityGraphCrudError('validation', 'entity-graph-crud: entityRead requires either id or name');
  }
  const { rows } = await client.query(
    `SELECT * FROM entities WHERE project_id = $1 AND ($2::integer IS NULL OR id = $2) AND ($3::text IS NULL OR name = $3)`,
    [projectId, id ?? null, name ?? null]
  );
  return rows;
}

async function entityUpdate(client, { projectId, id, entityType, description }) {
  requireNonEmptyString(projectId, 'projectId');
  if (!Number.isInteger(id)) {
    throw new EntityGraphCrudError('validation', 'entity-graph-crud: entityUpdate requires an integer id');
  }
  const { rows } = await client.query(
    `UPDATE entities SET
       entity_type = COALESCE($1, entity_type),
       description = COALESCE($2, description)
     WHERE id = $3 AND project_id = $4
     RETURNING *`,
    [entityType || null, description ?? null, id, projectId]
  );
  if (rows.length === 0) {
    throw new EntityGraphCrudError('notFound', `entity-graph-crud: entityUpdate found no row with id=${id} project_id=${projectId}`);
  }
  return rows[0];
}

async function entitySuppress(client, { projectId, id }) {
  requireNonEmptyString(projectId, 'projectId');
  if (!Number.isInteger(id)) {
    throw new EntityGraphCrudError('validation', 'entity-graph-crud: entitySuppress requires an integer id');
  }
  const { rows } = await client.query(
    `UPDATE entities SET suppressed = true WHERE id = $1 AND project_id = $2 RETURNING *`,
    [id, projectId]
  );
  if (rows.length === 0) {
    throw new EntityGraphCrudError('notFound', `entity-graph-crud: entitySuppress found no row with id=${id} project_id=${projectId}`);
  }
  return rows[0];
}

// ─────────────────────────────────────────────────────────────────────────
// Assertions — create/read/update(supersede)/suppress. M-5/M-6.
// ─────────────────────────────────────────────────────────────────────────

/**
 * assertionCreate — cm#231: routes the actual write through
 * writeAssertionWithSupersession (handoff.js), the SAME write engine the
 * seed/close path uses, so tier/valid_at/session_id/last_reinforced are set
 * with the SAME defaults on both paths instead of a second, independently-
 * duplicated INSERT here.
 *
 * BEHAVIOR CHANGE from the pre-cm#231 plain INSERT (documented, not hidden):
 * this call now (a) canonicalizes subject the same way the close path does,
 * (b) SUPERSEDES a prior live row for the same (subject, predicate) [1:1] or
 * exact (subject, predicate, object) duplicate [1:N] rather than leaving it
 * live alongside a second row, and (c) short-circuits to a last_reinforced-
 * only "touch" (no new row) on an exact same-session repeat. This tool was
 * previously "append-only" (see the tool's own former description) purely
 * because the raw INSERT never checked for a prior live row — NOT because
 * append-only was a deliberate design goal; the two other assertion write
 * paths (seed/close, and this same engine) have always superseded. The
 * ingest-time contradiction check below is UNCHANGED and still runs first,
 * against the pre-write live state, so a genuinely conflicting (different-
 * object, 1:N) prior row is still surfaced as contradictionWarning even
 * when cardinality means it is not auto-superseded.
 */
async function assertionCreate(client, { projectId, subject, predicate, object, confidence, source, sourceModel, agentId, sessionId }) {
  requireNonEmptyString(projectId, 'projectId');
  requireNonEmptyString(subject, 'subject');
  requireNonEmptyString(predicate, 'predicate');
  requireNonEmptyString(object, 'object');
  if (!Number.isInteger(confidence) || confidence < 1 || confidence > 10) {
    throw new EntityGraphCrudError('validation', 'entity-graph-crud: assertionCreate requires an integer confidence 1-10');
  }
  requireNonEmptyString(source, 'source');

  const { findContradictingAssertion } = require('./memory-upsert.js');
  const conflict = await findContradictingAssertion(client, projectId, subject, predicate, object);

  const handoffLib = require('../handoff.js');
  const registryMode = await handoffLib.getSetting(client, projectId, 'predicate_registry_mode', 'permissive');
  const resolvedSessionId = (typeof sessionId === 'string' && sessionId.length > 0)
    ? sessionId
    : await handoffLib.resolveSessionId(client, projectId, {});

  const result = await handoffLib.writeAssertionWithSupersession(
    client, projectId,
    { subject, predicate, object, confidence, source },
    resolvedSessionId, registryMode, { returnRow: true }
  );

  if (result.skipped) {
    // Predicate registry rejected this predicate under 'strict' mode. The close/
    // seed batch path swallows this (logs + continues the batch); assertionCreate
    // is a single-call API surface, so it surfaces the rejection as a hard error
    // instead of silently no-op-ing (M-6's "never guess/never swallow" posture).
    throw new EntityGraphCrudError(
      'validation',
      `entity-graph-crud: assertionCreate rejected — predicate "${predicate}" is not registered and predicate_registry_mode is "strict" (${result.reason})`
    );
  }

  let row = result.row;
  // writeAssertionWithSupersession's INSERT (shared with the seed/close path,
  // which has no source_model/agent_id concept) does not set these §8
  // attribution columns. Backfill them with a follow-up UPDATE so
  // assertionCreate's existing attribution contract is preserved. This is a
  // SEPARATE statement, outside writeAssertionWithSupersession's own already-
  // committed transaction (see PR body's Blind spots: a narrow window exists
  // between the two writes where a concurrent reader could see the row before
  // attribution lands).
  if (row && (sourceModel || agentId)) {
    const { rows: updated } = await client.query(
      `UPDATE assertions SET source_model = COALESCE($1, source_model), agent_id = COALESCE($2, agent_id)
        WHERE id = $3
        RETURNING *`,
      [sourceModel || null, agentId || null, row.id]
    );
    row = updated[0] || row;
  }

  return { row, contradictionWarning: conflict, touchOnly: !!result.touchOnly };
}

async function assertionRead(client, { projectId, id, subject, predicate }) {
  requireNonEmptyString(projectId, 'projectId');
  const { rows } = await client.query(
    `SELECT * FROM assertions
      WHERE project_id = $1
        AND ($2::integer IS NULL OR id = $2)
        AND ($3::text IS NULL OR subject = $3)
        AND ($4::text IS NULL OR predicate = $4)
        AND suppressed = false AND invalid_at IS NULL`,
    [projectId, id ?? null, subject ?? null, predicate ?? null]
  );
  return rows;
}

/**
 * resolveAssertionUpdateTargetId — M-6's total classification: explicit id
 * always wins; when omitted, a 1:1-cardinality predicate resolves its
 * target via (project_id, subject, predicate); a 1:N or unregistered
 * predicate with no explicit id is a HARD ERROR naming the predicate
 * ("omitted = hard error, never guess").
 */
async function resolveAssertionUpdateTargetId(client, { projectId, id, subject, predicate }) {
  if (Number.isInteger(id)) return id;

  const cardinality = cardinalityOf(predicate);
  if (cardinality !== '1:1') {
    throw new EntityGraphCrudError(
      'targetRequired',
      `entity-graph-crud: assertionUpdate on predicate "${predicate}" (cardinality=${cardinality ?? 'unregistered'}) requires an explicit target row id — omitted, and this predicate is not 1:1, so the target cannot be inferred (M-6: never guess).`
    );
  }
  const { rows } = await client.query(
    `SELECT id FROM assertions
      WHERE project_id = $1 AND subject = $2 AND predicate = $3
        AND suppressed = false AND invalid_at IS NULL`,
    [projectId, subject, predicate]
  );
  if (rows.length === 0) {
    throw new EntityGraphCrudError(
      'targetRequired',
      `entity-graph-crud: assertionUpdate found no live 1:1 row for (subject=${JSON.stringify(subject)}, predicate=${JSON.stringify(predicate)}) to infer a target id from.`
    );
  }
  if (rows.length > 1) {
    throw new EntityGraphCrudError(
      'ambiguousTarget',
      `entity-graph-crud: assertionUpdate found ${rows.length} live rows for a 1:1 predicate (subject=${JSON.stringify(subject)}, predicate=${JSON.stringify(predicate)}) — the 1:1 index should make this impossible; refusing to guess.`
    );
  }
  return rows[0].id;
}

/**
 * assertionUpdate — M-5: supersede = suppress-old THEN insert-new, ONE
 * transaction, optimistic guard (mirrors exchange-log.js's UPDATE ... WHERE
 * <expected-state> RETURNING pattern — by reference, not reimplemented from
 * scratch: same shape, same "rowCount !== 1 => rollback + named error"
 * posture).
 *
 * @param {object} args
 * @param {string} args.projectId
 * @param {number} [args.id] — explicit target row id (M-6)
 * @param {string} [args.subject] — used to infer id for a 1:1 predicate
 *   when args.id is omitted
 * @param {string} args.predicate
 * @param {string} args.newObject
 * @param {number} [args.confidence]
 * @param {string} [args.source]
 * @param {string} [args.sourceModel]
 * @param {string} [args.agentId]
 * @param {string} [args.sessionId] — explicit session override; defaults to
 *   handoff.js's own resolveSessionId (env var / DB marker), cm#231.
 *
 * cm#231: the new row born from this supersession now carries the SAME
 * tier/valid_at/session_id/last_reinforced defaults the seed/close path
 * applies — previously all four were left NULL/unset here. tier is
 * deliberately ALWAYS 'probationary' on the new row (never routed through
 * the L0/L2 corroboration gate — see PR body's "Semantics matched"): the
 * gate's candidate-scan is keyed by canonical subject and would need to
 * re-derive cross-session corroboration for THIS specific id-targeted
 * update, which is a different matching shape than writeAssertionWithSupersession's
 * subject/predicate[/object]-keyed scan (that scan cannot honor an explicit
 * id target for a 1:N predicate the way M-6 requires). Defaulting to
 * 'probationary' here is also the SAFE choice on its own terms: it preserves
 * the L0 anti-forge invariant (a single explicit write, with no independently-
 * verified cross-session evidence, must never mint 'consolidated') rather
 * than inventing a new path that could.
 */
async function assertionUpdate(client, args) {
  const { projectId, subject, predicate, newObject, confidence, source, sourceModel, agentId, sessionId } = args || {};
  requireNonEmptyString(projectId, 'projectId');
  requireNonEmptyString(predicate, 'predicate');
  requireNonEmptyString(newObject, 'newObject');

  const targetId = await resolveAssertionUpdateTargetId(client, { projectId, id: args.id, subject, predicate });

  const handoffLib = require('../handoff.js');
  const resolvedSessionId = (typeof sessionId === 'string' && sessionId.length > 0)
    ? sessionId
    : await handoffLib.resolveSessionId(client, projectId, {});

  await client.query('BEGIN');
  try {
    // Optimistic guard: only supersede a row that is STILL live at the
    // moment of the guard — a concurrent supersede/suppress between the
    // target-resolution read above and this UPDATE is caught here, never
    // silently double-superseded.
    // cm#231: suppression_kind = 'superseded' added — matches
    // db-seam.js's buildSupersessionUpdate (the seed/close path's own
    // supersession UPDATE), which the pre-cm#231 version of this guard
    // omitted.
    const guardRes = await client.query(
      `UPDATE assertions SET suppressed = true, invalid_at = now(), suppression_kind = 'superseded'
        WHERE id = $1 AND project_id = $2 AND suppressed = false AND invalid_at IS NULL
        RETURNING subject, predicate, confidence, source, source_model, agent_id`,
      [targetId, projectId]
    );
    if (guardRes.rowCount !== 1) {
      throw new EntityGraphCrudError(
        'staleTarget',
        `entity-graph-crud: assertionUpdate expected 1 live row at id=${targetId}; got ${guardRes.rowCount} (concurrent supersede/suppress, or the target was already superseded). Rolling back.`
      );
    }
    const old = guardRes.rows[0];

    const insertRes = await client.query(
      `INSERT INTO assertions
         (project_id, subject, predicate, object, confidence, source, source_model, agent_id,
          session_id, last_reinforced, valid_at, tier)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now(), now(), $10)
       RETURNING *`,
      [
        projectId, old.subject, old.predicate, newObject,
        Number.isInteger(confidence) ? confidence : old.confidence,
        source || old.source,
        sourceModel || old.source_model,
        agentId || old.agent_id,
        resolvedSessionId,
        handoffLib.ASSERTION_TIER_PROBATIONARY,
      ]
    );

    await client.query('COMMIT');
    return { oldId: targetId, newRow: insertRes.rows[0] };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  }
}

/**
 * assertionSuppress — cm#231: now sets invalid_at=now() and
 * suppression_kind='retired' alongside suppressed=true, matching the seed/
 * close path's own operator-retirement vocabulary (cmdRetire / L5's
 * buildRetirementUpdate — 'retired': "operator-retired ... non-destructive",
 * handoff-core-schema.sql's suppression_kind CHECK comment). Previously this
 * set suppressed=true only, leaving invalid_at NULL and suppression_kind
 * NULL on a row that is otherwise indistinguishable, at read time, from a
 * live row for any query that (correctly) also checks invalid_at IS NULL.
 */
async function assertionSuppress(client, { projectId, id }) {
  requireNonEmptyString(projectId, 'projectId');
  if (!Number.isInteger(id)) {
    throw new EntityGraphCrudError('validation', 'entity-graph-crud: assertionSuppress requires an integer id');
  }
  const { rows } = await client.query(
    `UPDATE assertions SET suppressed = true, invalid_at = now(), suppression_kind = 'retired'
      WHERE id = $1 AND project_id = $2 RETURNING *`,
    [id, projectId]
  );
  if (rows.length === 0) {
    throw new EntityGraphCrudError('notFound', `entity-graph-crud: assertionSuppress found no row with id=${id} project_id=${projectId}`);
  }
  return rows[0];
}

// ─────────────────────────────────────────────────────────────────────────
// Edges — no bi-temporal design (§5.1 scoped to assertions); plain
// create/read/in-place-update/suppress, forensically visible via
// edges_audit (already wired).
// ─────────────────────────────────────────────────────────────────────────

async function edgeCreate(client, { projectId, fromEntity, edgeType, toEntity, weight, sourceModel, agentId }) {
  requireNonEmptyString(projectId, 'projectId');
  requireNonEmptyString(fromEntity, 'fromEntity');
  requireNonEmptyString(edgeType, 'edgeType');
  requireNonEmptyString(toEntity, 'toEntity');
  const { rows } = await client.query(
    `INSERT INTO edges (project_id, from_entity, edge_type, to_entity, weight, source_model, agent_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING *`,
    [projectId, fromEntity, edgeType, toEntity, weight ?? null, sourceModel || null, agentId || null]
  );
  return rows[0];
}

async function edgeRead(client, { projectId, id, fromEntity, toEntity }) {
  requireNonEmptyString(projectId, 'projectId');
  const { rows } = await client.query(
    `SELECT * FROM edges
      WHERE project_id = $1
        AND ($2::integer IS NULL OR id = $2)
        AND ($3::text IS NULL OR from_entity = $3)
        AND ($4::text IS NULL OR to_entity = $4)
        AND (suppressed = false)`,
    [projectId, id ?? null, fromEntity ?? null, toEntity ?? null]
  );
  return rows;
}

async function edgeUpdate(client, { projectId, id, edgeType, weight }) {
  requireNonEmptyString(projectId, 'projectId');
  if (!Number.isInteger(id)) {
    throw new EntityGraphCrudError('validation', 'entity-graph-crud: edgeUpdate requires an integer id');
  }
  const { rows } = await client.query(
    `UPDATE edges SET
       edge_type = COALESCE($1, edge_type),
       weight = COALESCE($2, weight)
     WHERE id = $3 AND project_id = $4
     RETURNING *`,
    [edgeType || null, weight ?? null, id, projectId]
  );
  if (rows.length === 0) {
    throw new EntityGraphCrudError('notFound', `entity-graph-crud: edgeUpdate found no row with id=${id} project_id=${projectId}`);
  }
  return rows[0];
}

async function edgeSuppress(client, { projectId, id }) {
  requireNonEmptyString(projectId, 'projectId');
  if (!Number.isInteger(id)) {
    throw new EntityGraphCrudError('validation', 'entity-graph-crud: edgeSuppress requires an integer id');
  }
  const { rows } = await client.query(
    `UPDATE edges SET suppressed = true WHERE id = $1 AND project_id = $2 RETURNING *`,
    [id, projectId]
  );
  if (rows.length === 0) {
    throw new EntityGraphCrudError('notFound', `entity-graph-crud: edgeSuppress found no row with id=${id} project_id=${projectId}`);
  }
  return rows[0];
}

module.exports = {
  EntityGraphCrudError,
  FUZZY_MIN_NORMALIZED_LEN,
  FUZZY_SIMILARITY_THRESHOLD,
  findNearMatchEntities,
  entityCreate,
  entityRead,
  entityUpdate,
  entitySuppress,
  assertionCreate,
  assertionRead,
  resolveAssertionUpdateTargetId,
  assertionUpdate,
  assertionSuppress,
  edgeCreate,
  edgeRead,
  edgeUpdate,
  edgeSuppress,
};
