'use strict';

/**
 * render-handoff-card.js — §7.6 fat-card renderer (CONSOLIDATION-
 * RUNBOOK.md §5.9/§7.6, memory-manager#17).
 *
 * Queries v_handoff_card_inputs (§5.9, created by migrate-14-seam-tables.sql
 * — carries the S-14 defense-in-depth predicate
 * `AND (carryover_status IS NULL OR carryover_status <> 'resolved')`
 * directly in the view, so this file does not need to re-filter for it) +
 * `decisions`/`gotchas`/`findings` for the "Durable platform facts"
 * section, and assembles the section shape pwa-etl's own HANDOFF.md
 * verified: NEXT SESSION / Session N — date — title / Done / Ceiling /
 * Open carry-overs table.
 *
 * This is the render HALF of Owner-Veto V3 (§7.6's own framing) — built
 * regardless of which way V3 resolves, since even an "authored-in-repo"
 * model benefits from a render-and-diff preview. This file does NOT write
 * anything — pure read + assemble.
 *
 * next_step ORDERING (S-15): v_handoff_card_inputs's own ORDER BY
 * `project_id, predicate, created_at DESC` is a FETCH-order convenience
 * only, per the view's own amendment comment — this file explicitly
 * RE-SORTS next_step rows created_at ASC before assembling the numbered
 * list, exactly as S-15 requires. Do not assume the view's fetch order is
 * the render order.
 */

const { renderCarryoverTable } = require('./carryover-render.js');

/**
 * fetchHandoffCardInputs — one query against v_handoff_card_inputs, grouped
 * by predicate for the caller's convenience.
 *
 * @param {object} client
 * @param {string} projectId
 * @returns {Promise<{
 *   openThreads: Array<{subject:string, object:string, created_at:Date}>,
 *   nextSteps:   Array<{subject:string, object:string, created_at:Date}>,
 *   sessionTldr: {subject:string, object:string, created_at:Date}|null,
 *   quickReferences: Array<{subject:string, object:string}>,
 *   runCommands: Array<{subject:string, object:string}>,
 *   criticalOperationalNotes: Array<{subject:string, object:string}>,
 *   keyPaths: Array<{subject:string, object:string}>,
 * }>}
 */
async function fetchHandoffCardInputs(client, projectId) {
  const { rows } = await client.query(
    `SELECT project_id, predicate, subject, object, carryover_status, pinned, created_at, confidence
       FROM v_handoff_card_inputs
      WHERE project_id = $1`,
    [projectId]
  );

  const byPredicate = (pred) => rows.filter((r) => r.predicate === pred);

  const openThreads = byPredicate('open_thread');
  // S-15: re-sort next_step created_at ASC — the view's own DESC order is a
  // fetch-order convenience only, never the render order.
  const nextSteps = byPredicate('next_step').slice().sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
  const sessionTldrRows = byPredicate('session_tldr');
  const sessionTldr = sessionTldrRows.length > 0 ? sessionTldrRows[0] : null; // most-recent (view fetch order is created_at DESC)

  return {
    openThreads,
    nextSteps,
    sessionTldr,
    quickReferences: byPredicate('quick_reference'),
    runCommands: byPredicate('run_commands'),
    criticalOperationalNotes: byPredicate('critical_operational_notes'),
    keyPaths: byPredicate('key_paths'),
  };
}

/**
 * fetchDurablePlatformFacts — decisions/gotchas/findings join for the
 * "Durable platform facts" section (§7.6: "v_handoff_card_inputs-equivalent
 * joins against decisions/gotchas/findings where relevant"). Bounded to the
 * most-recent N rows per table so the card stays a summary, not a dump.
 *
 * @param {object} client
 * @param {string} projectId
 * @param {number} [limitPerTable=5]
 */
async function fetchDurablePlatformFacts(client, projectId, limitPerTable = 5) {
  // Sequential (not Promise.all) — a plain pg Client does not support
  // overlapping concurrent queries on one connection.
  const decisions = await client.query(
    `SELECT id, topic, decision, reason, created_at FROM decisions
      WHERE project_id = $1 ORDER BY created_at DESC LIMIT $2`,
    [projectId, limitPerTable]
  );
  const gotchas = await client.query(
    `SELECT id, issue, rule, created_at FROM gotchas
      WHERE project_id = $1 AND active = true ORDER BY created_at DESC LIMIT $2`,
    [projectId, limitPerTable]
  );
  const findings = await client.query(
    `SELECT id, description, status, created_at FROM findings
      WHERE project_id = $1 AND status <> 'fixed' ORDER BY created_at DESC LIMIT $2`,
    [projectId, limitPerTable]
  );
  return {
    decisions: decisions.rows,
    gotchas: gotchas.rows,
    findings: findings.rows,
  };
}

/**
 * renderHandoffCard — assembles the exact section shape: NEXT SESSION /
 * Session N — date — title / Done / Ceiling / Open carry-overs table.
 *
 * @param {object} params
 * @param {number} params.sessionNum
 * @param {string} params.title
 * @param {string} [params.date] - ISO date string; defaults to today (UTC)
 * @param {string[]} [params.done] - caveman bullet lines, "what shipped"
 * @param {string[]} [params.ceiling] - caveman bullet lines, "what's blocked/next-limit"
 * @param {ReturnType<typeof fetchHandoffCardInputs> extends Promise<infer T> ? T : never} params.cardInputs
 * @param {ReturnType<typeof fetchDurablePlatformFacts> extends Promise<infer T> ? T : never} [params.platformFacts]
 * @returns {string} markdown
 */
function renderHandoffCard(params) {
  const {
    sessionNum, title, date, done = [], ceiling = [],
    cardInputs, platformFacts,
  } = params;

  const isoDate = date || new Date().toISOString().slice(0, 10);
  const lines = [];

  lines.push('## NEXT SESSION');
  lines.push('');
  if (cardInputs.nextSteps.length === 0) {
    lines.push('_(no queued next steps)_');
  } else {
    cardInputs.nextSteps.forEach((row, i) => {
      lines.push(`${i + 1}. ${row.object}`);
    });
  }
  lines.push('');

  lines.push(`## Session ${sessionNum} — ${isoDate} — ${title}`);
  lines.push('');

  lines.push('### Done');
  lines.push('');
  if (done.length === 0) {
    lines.push('_(none recorded)_');
  } else {
    for (const line of done) lines.push(`- ${line}`);
  }
  lines.push('');

  lines.push('### Ceiling');
  lines.push('');
  if (ceiling.length === 0) {
    lines.push('_(none recorded)_');
  } else {
    for (const line of ceiling) lines.push(`- ${line}`);
  }
  lines.push('');

  lines.push('### Open carry-overs');
  lines.push('');
  lines.push(renderCarryoverTable(cardInputs.openThreads.map((r) => ({ subject: r.subject, object: r.object }))));
  lines.push('');

  if (platformFacts && (platformFacts.decisions.length || platformFacts.gotchas.length || platformFacts.findings.length)) {
    lines.push('### Durable platform facts');
    lines.push('');
    for (const d of platformFacts.decisions) lines.push(`- decision: ${d.topic} -> ${d.decision}`);
    for (const g of platformFacts.gotchas) lines.push(`- gotcha: ${g.issue} -> ${g.rule}`);
    for (const f of platformFacts.findings) lines.push(`- finding (${f.status}): ${f.description}`);
    lines.push('');
  }

  return lines.join('\n').trimEnd() + '\n';
}

module.exports = {
  fetchHandoffCardInputs,
  fetchDurablePlatformFacts,
  renderHandoffCard,
};
