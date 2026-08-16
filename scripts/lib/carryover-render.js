'use strict';

/**
 * carryover-render.js — §7.1 carry-over delta-merge, porting the
 * extractCarryoverTable / applyDeltasToRows / rebuildCarryoverTable PATTERN
 * from a private internal reference implementation (§7.1's own citation),
 * but retargeted from markdown-table parsing to SQL: the "existing rows" are
 * live `open_thread` assertion rows, not a parsed markdown table, and
 * deltas are written back as assertion mutations (supersession), not a
 * rebuilt table string spliced into HANDOFF.md.
 *
 * Amendment history this file implements (CONSOLIDATION-RUNBOOK.md §7.1,
 * spec-adversary pass 2026-08-15, S-12a/S-12b/S-12c, memory-manager#17):
 *   - S-12a: `open_thread` is ALREADY 1:1-enforced (predicate-registry.json
 *     + assertions_1to1_unique already include it) — no schema change
 *     needed here.
 *   - S-12b: handoff_close's `resolved_threads` payload key is a FLAT ARRAY
 *     OF STRINGS, already wired (scripts/handoff.js's persistSessionIntent
 *     auto-retire block, ~line 4189) — this file makes NO payload-shape
 *     change to `resolved_threads`; it is a SEPARATE renderer/writer used
 *     by whatever new call site wires it in (§7.6/§8), not a replacement
 *     for the close-time auto-retire path.
 *   - S-12c: this file's exact deliverable shape (see exports below).
 *
 * MATCHING — reused BY REFERENCE, never reimplemented:
 *   - deriveIntentSubject(text) — imported from scripts/handoff.js (the
 *     SAME function handoff.js's own resolved_threads auto-retire path
 *     uses), so subject derivation can never drift out of sync between the
 *     close-time path and this renderer.
 *   - PINNED_EXCLUSION_SQL — imported from scripts/handoff.js (the SAME SQL
 *     fragment `(pinned = false OR pinned IS NULL)` handoff.js's own
 *     auto-retire query uses), so "does a pinned row ever match" can never
 *     silently diverge between the two call sites.
 *
 * DELTA ITEM SHAPES (this file's own design decision — the origin
 * rotate.js shape was markdown-row-specific ({match, row}: a full rendered
 * markdown row string) and does not carry over cleanly to a SQL write path;
 * §7.1's amendment specifies the RESULT semantics, not exact field names):
 *   resolved: string[]              — raw open-thread text, as originally
 *                                      authored (subject is DERIVED from it
 *                                      via deriveIntentSubject, exactly like
 *                                      handoff.js's own resolved_threads
 *                                      handling — NOT a markdown substring
 *                                      match).
 *   added:    string[]              — raw NEW open-thread text; subject is
 *                                      derived the same way.
 *   updated:  { match: string, text: string }[]
 *                                      — `match` is raw text used to derive
 *                                        the OLD row's subject (find/
 *                                        supersede target); `text` is the
 *                                        NEW raw open-thread text (subject
 *                                        derived from `text`, inserted as a
 *                                        fresh open row).
 */

const path = require('path');
const { deriveIntentSubject, PINNED_EXCLUSION_SQL } = require(path.join('..', 'handoff.js'));

/** Thrown when a delta item matches 2+ live open_thread rows (§7.1/S-12c:
 * "possible only if the 1:1 index is somehow bypassed" — a hard error,
 * never an arbitrary pick). */
class AmbiguousCarryoverMatchError extends Error {
  constructor(kind, matchText, subject, rowIds) {
    super(`carryover-render: ${kind} delta item matched ${rowIds.length} live open_thread rows for subject "${subject}" (from "${matchText}") — expected 0 or 1. Row ids: ${rowIds.join(', ')}.`);
    this.name = 'AmbiguousCarryoverMatchError';
    this.kind = kind;
    this.matchText = matchText;
    this.subject = subject;
    this.rowIds = rowIds;
  }
}

/**
 * fetchOpenCarryovers — live `open_thread` rows for a project.
 *
 * §5.5's legacy-NULL rule: carryover_status='open' OR carryover_status IS
 * NULL both count as "open" for READERS (writers introduced in this file
 * always set an explicit 'open'/'resolved' value — see applyCarryoverDeltas
 * below).
 *
 * @param {object} client  - pg client/pool (or transaction client)
 * @param {string} projectId
 * @returns {Promise<Array<{id:number, subject:string, object:string, carryover_status:string|null, pinned:boolean, created_at:Date, confidence:number}>>}
 */
async function fetchOpenCarryovers(client, projectId) {
  const { rows } = await client.query(
    `SELECT id, subject, object, carryover_status, pinned, created_at, confidence
       FROM assertions
      WHERE project_id = $1
        AND predicate = 'open_thread'
        AND suppressed = false
        AND invalid_at IS NULL
        AND (carryover_status = 'open' OR carryover_status IS NULL)
      ORDER BY created_at ASC`,
    [projectId]
  );
  return rows;
}

/**
 * Find live, non-pinned open_thread rows matching a derived subject.
 * Shared by resolved/updated matching below.
 */
async function findLiveOpenThreadRows(client, projectId, subject) {
  const { rows } = await client.query(
    `SELECT id FROM assertions
      WHERE project_id = $1
        AND predicate = 'open_thread'
        AND LOWER(TRIM(subject)) = LOWER(TRIM($2))
        AND suppressed = false
        AND invalid_at IS NULL
        AND ${PINNED_EXCLUSION_SQL}`,
    [projectId, subject]
  );
  return rows.map((r) => r.id);
}

/**
 * applyCarryoverDeltas — write {resolved, added, updated} back as assertion
 * mutations (§7.1/S-12c). Never destructive: resolved/updated supersede via
 * suppressed+invalid_at, matching the existing bi-temporal pattern
 * elsewhere in this codebase.
 *
 * Non-happy-path branches (both REQUIRED, neither silent, per S-12c):
 *   - 0 live rows matched  -> a LOUD report entry (report.zeroMatch), never
 *     a silent no-op.
 *   - 2+ live rows matched -> AmbiguousCarryoverMatchError is THROWN
 *     immediately (aborts the whole call — callers wrap this in a
 *     transaction so a partial apply never lands).
 *
 * @param {object} client - pg client (caller's responsibility to wrap in a
 *   transaction if atomicity across the whole delta is required)
 * @param {string} projectId
 * @param {{resolved?: string[], added?: string[], updated?: {match:string, text:string}[]}} deltas
 * @returns {Promise<{resolvedApplied: Array, addedApplied: Array, updatedApplied: Array, zeroMatch: Array<{kind:string, matchText:string, subject:string}>}>}
 */
async function applyCarryoverDeltas(client, projectId, deltas) {
  const { resolved = [], added = [], updated = [] } = deltas || {};

  const resolvedApplied = [];
  const addedApplied = [];
  const updatedApplied = [];
  const zeroMatch = [];

  // ── resolved: suppress + invalid_at + carryover_status='resolved' ──────
  for (const text of resolved) {
    const raw = String(text || '').trim();
    if (!raw) continue;
    const subject = deriveIntentSubject(raw);
    const ids = await findLiveOpenThreadRows(client, projectId, subject);
    if (ids.length === 0) {
      zeroMatch.push({ kind: 'resolved', matchText: raw, subject });
      continue;
    }
    if (ids.length > 1) {
      throw new AmbiguousCarryoverMatchError('resolved', raw, subject, ids);
    }
    await client.query(
      `UPDATE assertions
          SET suppressed = true, invalid_at = now(),
              suppression_kind = 'superseded', carryover_status = 'resolved'
        WHERE id = $1`,
      [ids[0]]
    );
    resolvedApplied.push({ id: ids[0], subject });
  }

  // ── added: new open_thread row, carryover_status='open' ────────────────
  for (const text of added) {
    const raw = String(text || '').trim();
    if (!raw) continue;
    const subject = deriveIntentSubject(raw);
    const { rows } = await client.query(
      `INSERT INTO assertions
         (project_id, subject, predicate, object, confidence, source, tier, carryover_status)
       VALUES ($1, $2, 'open_thread', $3, 8, 'user_stated', 'probationary', 'open')
       RETURNING id`,
      [projectId, subject, raw]
    );
    addedApplied.push({ id: rows[0].id, subject });
  }

  // ── updated: supersede-and-reinsert via the existing 1:1 path (S-12a) ──
  for (const item of updated) {
    const matchRaw = String((item && item.match) || '').trim();
    const newRaw = String((item && item.text) || '').trim();
    if (!matchRaw || !newRaw) continue;
    const oldSubject = deriveIntentSubject(matchRaw);
    const ids = await findLiveOpenThreadRows(client, projectId, oldSubject);
    if (ids.length === 0) {
      zeroMatch.push({ kind: 'updated', matchText: matchRaw, subject: oldSubject });
      continue;
    }
    if (ids.length > 1) {
      throw new AmbiguousCarryoverMatchError('updated', matchRaw, oldSubject, ids);
    }
    await client.query(
      `UPDATE assertions
          SET suppressed = true, invalid_at = now(), suppression_kind = 'superseded'
        WHERE id = $1`,
      [ids[0]]
    );
    const newSubject = deriveIntentSubject(newRaw);
    const { rows } = await client.query(
      `INSERT INTO assertions
         (project_id, subject, predicate, object, confidence, source, tier, carryover_status)
       VALUES ($1, $2, 'open_thread', $3, 8, 'user_stated', 'probationary', 'open')
       RETURNING id`,
      [projectId, newSubject, newRaw]
    );
    updatedApplied.push({ oldId: ids[0], newId: rows[0].id, oldSubject, newSubject });
  }

  return { resolvedApplied, addedApplied, updatedApplied, zeroMatch };
}

/**
 * renderCarryoverTable — markdown-table render helper consumed by §7.6's
 * render-handoff-card.js. Design decision (this file's own, per the file
 * header comment): two columns, Subject + Detail, one row per open
 * carryover, in the order the rows are passed in (callers control ordering
 * — fetchOpenCarryovers already returns created_at ASC).
 *
 * @param {Array<{subject:string, object:string}>} rows
 * @returns {string} markdown table, or an explicit "(none)" line if empty
 */
function renderCarryoverTable(rows) {
  if (!rows || rows.length === 0) {
    return '_(no open carry-overs)_';
  }
  const escape = (s) => String(s == null ? '' : s).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
  const header = '| Subject | Detail |\n|---|---|';
  const body = rows
    .map((r) => `| ${escape(r.subject)} | ${escape(r.object)} |`)
    .join('\n');
  return `${header}\n${body}`;
}

module.exports = {
  AmbiguousCarryoverMatchError,
  fetchOpenCarryovers,
  findLiveOpenThreadRows,
  applyCarryoverDeltas,
  renderCarryoverTable,
};
