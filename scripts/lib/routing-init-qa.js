'use strict';

/**
 * scripts/lib/routing-init-qa.js — §17.1.2 init-time routing configuration
 * Q&A (CONSOLIDATION-RUNBOOK.md §17.1.2, owner decision 2026-09-06).
 *
 * Closes the gap docs/notes/2026-09-06-s17-routing-gap-audit.md's row 38
 * flagged: `resolveRequiredTier`'s hard-error hint told an operator to
 * "run routing init Q&A" — a flow that did not exist anywhere in the
 * codebase. This module IS that flow. It is a pure, injectable-`ask`
 * driver: no readline, no process.stdin, no process.exit anywhere in this
 * file — every prompt/answer round-trips through the caller-supplied `ask`
 * function, so the entire Q&A sequence (including every re-ask/EOF/
 * idempotency branch) is unit-testable without a real terminal. The CLI
 * wiring (a real readline-backed `ask`) lives in scripts/handoff.js's
 * cmdInit (step 9.5) and its `--routing` / `--routing-reconfigure`
 * standalone path.
 *
 * `ask` CONTRACT: `(promptText: string) => Promise<string|null>`. A
 * non-null string is the raw, UNTRIMMED answer (this module trims where
 * trimming is meaningful and treats a literal empty string, `''`, as a
 * distinct sentinel BEFORE any trimming — see Q1 below). `null` means
 * EOF/stream-close mid-question (e.g. Ctrl+D) — this is NEVER treated as
 * "declined"; it aborts the entire sequence with zero writes (item 5,
 * all-or-nothing).
 *
 * ALL-OR-NOTHING (item 5): every answer is buffered in memory
 * (`roleTiers`, `models`) across the whole Q0→Q1→Q2×N→Q3 sequence. The
 * only writes this module performs are the final `routingProfileSet` /
 * `modelRegistrySet` calls after the FULL sequence completes without an
 * EOF. A `null` from `ask` at ANY point — including Q0 itself — aborts
 * with the exact message `routing configuration incomplete — no changes
 * written` and writes zero rows. The caller (cmdInit) still exits 0 in
 * this case: an incomplete OPTIONAL Q&A is never a fatal `init` failure.
 *
 * GATE / PRECONDITION (items 2/3) are both enforced INSIDE this module
 * (not left to the caller to re-implement) so every branch is exercised by
 * calling `runRoutingInitQA` directly in tests:
 *   - `interactive:false` (computed by the caller as
 *     `process.stdin.isTTY && !autoCreate`) → NOTE + skip, zero rows.
 *   - `routing_profiles` / `model_registry` tables absent (probed via
 *     `db.schemaObjectsExist`) → NOTE + skip, zero rows, NEVER fatal.
 *
 * IDEMPOTENCY (item 6): `routingProfileGet(db, {projectId})` (role
 * omitted → every active profile for the project) is fetched ONCE before
 * Q2 starts. A role already carrying an active row is REMOVED FROM THE
 * PROMPT SET entirely (never asked, not asked-then-discarded) unless
 * `reconfigure:true` — "provenance-blind by construction": this module
 * has no way to know (and does not ask) who set an existing active row or
 * why; `--routing-reconfigure` re-asks it unconditionally.
 *
 * `modelId` IS INTENTIONALLY NEVER COLLECTED by this Q&A (out of scope for
 * the §17.1.2 prompt fields: label/provider/tier/cost only — see item 4).
 * `modelRegistrySet`'s own F-2/F-3 re-pointing/duplicate-`modelId`
 * force-protection (routing-write-surface.js) therefore can never fire via
 * this path, since `fields.model_id.touched` is always false here — see
 * the BLIND SPOTS note in the PR description. `configuredBy` is always
 * stamped `'handoff-init'` on every model_registry_set call this module
 * makes, per item 5.
 *
 * LABEL NEAR-MATCH (item 4, Q3): checked against the UNION of every label
 * already in `model_registry` at Q&A start AND every label already
 * buffered THIS session (not just the DB) — a deliberate widening beyond
 * the literal spec text ("existing model_registry label"), so two
 * case-near-duplicate labels typed back-to-back in the SAME Q&A session
 * are caught too, not only ones already committed from a prior session.
 */

const routingIdentity = require('./routing-identity.js');
const { VALID_TIERS } = require('./route-resolve.js');
const routingProfileLib = require('./routing-profile.js');
const routingWriteSurfaceLib = require('./routing-write-surface.js');
const { MAX_NUMERIC_10_4 } = routingWriteSurfaceLib;

// §17.1.1's role→tier suggestion table (prose-only per route-resolve.js's
// own header — reproduced here ONLY as a display-time suggestion for Q2,
// never applied automatically; blank/non-member answers still re-ask).
const DEFAULT_ROLES = Object.freeze([
  'orchestrate', 'spec', 'draft', 'write', 'read', 'index', 'bookkeep', 'review',
]);

const SUGGESTED_TIER_BY_ROLE = Object.freeze({
  orchestrate: 'high',
  spec: 'high',
  draft: 'mid',
  write: 'mid',
  read: 'low',
  index: 'low',
  bookkeep: 'low',
  review: 'high',
});
// Any role outside the default set (a custom role the operator typed at
// Q1) gets this neutral, display-only suggestion — never a hidden default.
const FALLBACK_SUGGESTED_TIER = 'mid';

const NOTE_NON_INTERACTIVE = '  [NOTE]  routing Q&A skipped (non-interactive) — run: handoff init --routing';
const NOTE_TABLES_ABSENT = '  [NOTE]  routing tables not provisioned — run scripts/migrations/migrate-schema-addenda.js';
const NOTE_DECLINED = '  [NOTE]  routing Q&A skipped (declined)';
const NOTE_INCOMPLETE = '  [NOTE]  routing configuration incomplete — no changes written';

const PROMPT_Q0 = 'Configure model routing now? [y/N]: ';

function promptQ1(defaultRoles) {
  return `Roles to configure (comma-separated) [default: ${defaultRoles.join(',')}] — Enter for default: `;
}

function promptQ2(role, suggestedTier) {
  return `Capability tier for '${role}' (high|mid|low) [suggested: ${suggestedTier}]: `;
}

function promptModelLabel(isFirst) {
  return isFirst
    ? `Model label to register (blank to skip adding models): `
    : `Model label to register (blank to finish adding models): `;
}

function promptProvider(label) {
  return `Provider for '${label}': `;
}

function promptModelTier(label) {
  return `Capability tier for model '${label}' (high|mid|low): `;
}

function promptCostIn(label) {
  return `Cost in per Mtok (USD) for '${label}': `;
}

function promptCostOut(label) {
  return `Cost out per Mtok (USD) for '${label}': `;
}

const PROMPT_ADD_ANOTHER_MODEL = 'Add another model? [y/N]: ';

function isYes(raw) {
  return /^y(es)?$/i.test((raw || '').trim());
}

// ── Pure validators (exported for direct unit testing — item 9's "validator
// totality for every re-ask case") ──────────────────────────────────────────

/**
 * Q1 total classification:
 *   - raw === '' (BEFORE any trim — the literal empty string) -> the
 *     default-set sentinel, returned as-is, no further validation.
 *   - split on ',', each token normRole'd: any token normalizing to ''
 *     (whitespace-only token, stray/trailing comma) -> reject.
 *   - duplicate tokens AFTER normRole (case preserved) -> reject.
 *   - a token matching a default role case-INsensitively but not exactly
 *     -> reject, naming the canonical default-role spelling.
 *   - otherwise -> accept, roles = the normalized token list.
 */
function validateRolesAnswer(raw, defaultRoles = DEFAULT_ROLES) {
  if (raw === '') {
    return { ok: true, value: [...defaultRoles] };
  }
  const tokens = raw.split(',').map((t) => routingIdentity.normRole(t));

  if (tokens.some((t) => t === '')) {
    return {
      ok: false,
      reason: 'role list contains an empty entry (check for a stray comma or a whitespace-only token)',
    };
  }

  const seen = new Set();
  for (const t of tokens) {
    if (seen.has(t)) {
      return { ok: false, reason: `duplicate role after normalization: "${t}"` };
    }
    seen.add(t);
  }

  for (const t of tokens) {
    const canonical = defaultRoles.find((d) => d.toLowerCase() === t.toLowerCase() && d !== t);
    if (canonical) {
      return {
        ok: false,
        reason: `"${t}" is close to the default role "${canonical}" but differs only in case — ` +
          `role names are never case-folded; enter it exactly as "${canonical}" or choose a distinct custom role name`,
      };
    }
  }

  return { ok: true, value: tokens };
}

/** Q2/Q3 tier: exact (case-sensitive) membership in VALID_TIERS; blank or non-member re-asks. */
function validateTierAnswer(raw) {
  const trimmed = (raw || '').trim();
  if (!VALID_TIERS.includes(trimmed)) {
    return {
      ok: false,
      reason: `capability tier must be exactly one of ${JSON.stringify(VALID_TIERS)} (got ${JSON.stringify(raw)})`,
    };
  }
  return { ok: true, value: trimmed };
}

/**
 * Q3 cost fields: `Number(trimmed)` — never regex-pre-validated into a
 * different parse than what is actually stored. Total classification:
 * empty -> reject; non-finite (NaN/Infinity, incl. unparseable strings
 * like "1,000" or "NaN") -> reject; negative -> reject; > MAX_NUMERIC_10_4
 * -> reject; more than 4 fractional digits in the TRIMMED SOURCE STRING
 * (never on the parsed float, which can misrepresent precision) -> reject,
 * NEVER silently rounded (NUMERIC(10,4) would otherwise round silently).
 * Scientific notation (e.g. "1e3") with no literal decimal point is exempt
 * from the fractional-digit check by design — see BLIND SPOTS.
 */
function validateCostAnswer(raw) {
  const trimmed = (raw || '').trim();
  if (trimmed === '') {
    return { ok: false, reason: 'cost is required (enter a non-negative number, e.g. 3.50)' };
  }
  const n = Number(trimmed);
  if (!Number.isFinite(n)) {
    return { ok: false, reason: `"${trimmed}" is not a finite number` };
  }
  if (n < 0) {
    return { ok: false, reason: `cost must be non-negative (got ${n})` };
  }
  if (n > MAX_NUMERIC_10_4) {
    return { ok: false, reason: `cost exceeds the maximum storable value ${MAX_NUMERIC_10_4} (got ${n})` };
  }
  const fracMatch = trimmed.match(/\.(\d+)$/);
  if (fracMatch && fracMatch[1].length > 4) {
    return {
      ok: false,
      reason: `cost has more than 4 fractional digits (${fracMatch[1].length}) — NUMERIC(10,4) would ` +
        'silently round this; re-enter with at most 4 decimal places (never silently rounded here)',
    };
  }
  return { ok: true, value: n };
}

function validateNonEmptyAnswer(raw, name = 'value') {
  const trimmed = (raw || '').trim();
  if (trimmed === '') {
    return { ok: false, reason: `${name} is required (non-empty)` };
  }
  return { ok: true, value: trimmed };
}

/**
 * Q3 label. `raw === ''` is the "done adding models" sentinel (`blank:true`),
 * distinct from a validation failure — it ends the model loop, never
 * re-asks. Otherwise: normLabel non-empty (whitespace-only rejected); if
 * the normalized label matches an already-known label (DB + this session,
 * see `labelIndex`) case-insensitively but not exactly, reject naming the
 * canonical existing spelling. An EXACT match to an existing label is
 * accepted (a legitimate model_registry upsert-on-label update).
 */
function validateLabelAnswer(raw, labelIndex) {
  if (raw === '') {
    return { ok: true, blank: true };
  }
  const norm = routingIdentity.normLabel(raw);
  if (norm === '') {
    return { ok: false, reason: 'label must be a non-empty string after normalization (whitespace-only input is rejected)' };
  }
  const lower = norm.toLowerCase();
  const existingCanonical = labelIndex.get(lower);
  if (existingCanonical !== undefined && existingCanonical !== norm) {
    return {
      ok: false,
      reason: `"${norm}" is close to the already-registered label "${existingCanonical}" but differs only ` +
        `in case — model_registry labels are case-sensitive and never folded; enter it exactly as ` +
        `"${existingCanonical}" to update that model, or choose a distinct label`,
    };
  }
  return { ok: true, value: norm };
}

/** Builds a lowercase->canonical-exact-spelling index for label near-match checks. */
function buildLabelIndex(existingLabels) {
  const index = new Map();
  for (const label of existingLabels) {
    index.set(label.toLowerCase(), label);
  }
  return index;
}

// ── ask-until-valid loop ─────────────────────────────────────────────────

/**
 * Repeats `ask(promptText)` until `validate` accepts the answer or `ask`
 * returns null (EOF). A validator may return `{ok:true, blank:true}` as a
 * distinct "sentinel accepted, stop asking, no value" outcome (used only
 * by the Q3 label prompt) — that is NOT the same as a re-ask.
 */
async function askUntilValid(ask, promptText, validate) {
  for (;;) {
    const raw = await ask(promptText);
    if (raw === null) {
      return { eof: true };
    }
    const result = validate(raw);
    if (result.ok) {
      return { eof: false, blank: Boolean(result.blank), value: result.value };
    }
    console.log(`  [NOTE]  ${result.reason} — please try again.`);
  }
}

// ── Q3 model loop ────────────────────────────────────────────────────────

async function runModelLoop(ask, labelIndex) {
  const models = [];
  for (;;) {
    const labelRes = await askUntilValid(
      ask,
      promptModelLabel(models.length === 0),
      (raw) => validateLabelAnswer(raw, labelIndex)
    );
    if (labelRes.eof) return { eof: true };
    if (labelRes.blank) break;
    const label = labelRes.value;

    const providerRes = await askUntilValid(ask, promptProvider(label), (raw) => validateNonEmptyAnswer(raw, 'provider'));
    if (providerRes.eof) return { eof: true };

    const tierRes = await askUntilValid(ask, promptModelTier(label), validateTierAnswer);
    if (tierRes.eof) return { eof: true };

    const costInRes = await askUntilValid(ask, promptCostIn(label), validateCostAnswer);
    if (costInRes.eof) return { eof: true };

    const costOutRes = await askUntilValid(ask, promptCostOut(label), validateCostAnswer);
    if (costOutRes.eof) return { eof: true };

    // Registered in the label index immediately so a SECOND model entered
    // later this same session is checked against it too (item 4's Q3 note).
    labelIndex.set(label.toLowerCase(), label);

    models.push({
      label,
      provider: providerRes.value,
      tier: tierRes.value,
      costIn: costInRes.value,
      costOut: costOutRes.value,
    });

    const moreRaw = await ask(PROMPT_ADD_ANOTHER_MODEL);
    if (moreRaw === null) return { eof: true };
    if (!isYes(moreRaw)) break;
  }
  return { eof: false, models };
}

// ── Driver ───────────────────────────────────────────────────────────────

/**
 * @param {object} db — StoragePort adapter (same `.query`/`.schemaObjectsExist`
 *   shape used throughout scripts/handoff.js; routingProfileSet/
 *   modelRegistrySet issue their own BEGIN/COMMIT on it).
 * @param {object} args
 * @param {string} args.projectId
 * @param {boolean} args.interactive — computed by the caller as
 *   `process.stdin.isTTY && !autoCreate` (item 2's gate). `false` skips
 *   with zero DB access beyond nothing at all.
 * @param {boolean} [args.reconfigure=false] — `--routing-reconfigure`:
 *   re-ask roles that already carry an active routing_profiles row.
 * @param {(promptText: string) => Promise<string|null>} args.ask — injectable
 *   prompt function; null signals EOF/stream-close.
 * @returns {Promise<{skipped:boolean, reason?:string, rolesWritten:string[], modelsWritten:string[], rolesSkipped?:string[]}>}
 */
async function runRoutingInitQA(db, { projectId, interactive, reconfigure = false, ask } = {}) {
  if (typeof projectId !== 'string' || !projectId) {
    throw new Error('routing-init-qa: "projectId" is required and must be a non-empty string');
  }
  if (typeof ask !== 'function') {
    throw new Error('routing-init-qa: "ask" must be an injectable function (promptText) => Promise<string|null>');
  }

  if (!interactive) {
    console.log(NOTE_NON_INTERACTIVE);
    return { skipped: true, reason: 'non-interactive', rolesWritten: [], modelsWritten: [] };
  }

  // Item 3: precondition probe. Absent -> NOTE + skip, never fatal.
  const tableProbe = await db.schemaObjectsExist({ tables: ['routing_profiles', 'model_registry'] });
  if (!tableProbe.ok) {
    console.log(NOTE_TABLES_ABSENT);
    return { skipped: true, reason: 'tables-absent', rolesWritten: [], modelsWritten: [] };
  }

  // Q0
  const q0Raw = await ask(PROMPT_Q0);
  if (q0Raw === null) {
    console.log(NOTE_INCOMPLETE);
    return { skipped: true, reason: 'incomplete', rolesWritten: [], modelsWritten: [] };
  }
  if (!isYes(q0Raw)) {
    console.log(NOTE_DECLINED);
    return { skipped: true, reason: 'declined', rolesWritten: [], modelsWritten: [] };
  }

  // Q1 — role set
  const rolesRes = await askUntilValid(ask, promptQ1(DEFAULT_ROLES), (raw) => validateRolesAnswer(raw, DEFAULT_ROLES));
  if (rolesRes.eof) {
    console.log(NOTE_INCOMPLETE);
    return { skipped: true, reason: 'incomplete', rolesWritten: [], modelsWritten: [] };
  }
  const roles = rolesRes.value;

  // Item 6: idempotency — active-row roles are removed from the prompt set
  // entirely unless reconfigure:true.
  const existingActiveProfiles = await routingProfileLib.routingProfileGet(db, { projectId });
  const existingRoleSet = new Set(existingActiveProfiles.map((r) => r.role));
  const rolesToAsk = [];
  const rolesSkipped = [];
  for (const role of roles) {
    if (existingRoleSet.has(role) && !reconfigure) {
      rolesSkipped.push(role);
    } else {
      rolesToAsk.push(role);
    }
  }
  if (rolesSkipped.length > 0) {
    console.log(`  [NOTE]  role(s) already configured, skipped (use --routing-reconfigure to re-ask): ${rolesSkipped.join(', ')}`);
  }

  // Q2 — per-role tier
  const roleTiers = [];
  for (const role of rolesToAsk) {
    const suggested = SUGGESTED_TIER_BY_ROLE[role] || FALLBACK_SUGGESTED_TIER;
    const tierRes = await askUntilValid(ask, promptQ2(role, suggested), validateTierAnswer);
    if (tierRes.eof) {
      console.log(NOTE_INCOMPLETE);
      return { skipped: true, reason: 'incomplete', rolesWritten: [], modelsWritten: [] };
    }
    roleTiers.push({ role, tier: tierRes.value });
  }

  // Q3 — model loop
  const existingModelsRes = await db.query('SELECT label FROM model_registry');
  const labelIndex = buildLabelIndex(existingModelsRes.rows.map((r) => r.label));
  const modelLoopRes = await runModelLoop(ask, labelIndex);
  if (modelLoopRes.eof) {
    console.log(NOTE_INCOMPLETE);
    return { skipped: true, reason: 'incomplete', rolesWritten: [], modelsWritten: [] };
  }
  const models = modelLoopRes.models;

  // ── All-or-nothing write phase (item 5) — reached ONLY when the full
  // sequence completed without an EOF. ─────────────────────────────────────
  const rolesWritten = [];
  for (const { role, tier } of roleTiers) {
    await routingProfileLib.routingProfileSet(db, { projectId, role, capabilityTier: tier, agentId: 'handoff-init' });
    rolesWritten.push(role);
  }
  const modelsWritten = [];
  for (const m of models) {
    await routingWriteSurfaceLib.modelRegistrySet(db, {
      label: m.label,
      provider: m.provider,
      capabilityTier: m.tier,
      costInPerMtok: m.costIn,
      costOutPerMtok: m.costOut,
      configuredBy: 'handoff-init',
    });
    modelsWritten.push(m.label);
  }

  console.log(`  [OK]    routing Q&A complete: ${rolesWritten.length} role(s) configured, ${modelsWritten.length} model(s) registered`);
  return { skipped: false, rolesWritten, modelsWritten, rolesSkipped };
}

module.exports = {
  runRoutingInitQA,
  // Exported test seams / constants.
  DEFAULT_ROLES,
  SUGGESTED_TIER_BY_ROLE,
  FALLBACK_SUGGESTED_TIER,
  validateRolesAnswer,
  validateTierAnswer,
  validateCostAnswer,
  validateNonEmptyAnswer,
  validateLabelAnswer,
  buildLabelIndex,
  askUntilValid,
  runModelLoop,
  NOTE_NON_INTERACTIVE,
  NOTE_TABLES_ABSENT,
  NOTE_DECLINED,
  NOTE_INCOMPLETE,
  PROMPT_Q0,
  promptQ1,
  promptQ2,
  PROMPT_ADD_ANOTHER_MODEL,
};
