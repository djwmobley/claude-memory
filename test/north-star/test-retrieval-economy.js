'use strict';

/**
 * test-retrieval-economy.js — North-star suite: THE RETRIEVAL ECONOMIST.
 *
 * Defends north-star goals (2) and the load-bearing premise:
 *   (2) lean, decay-ranked default resume that minimizes bootstrap token spend;
 *   premise: the information that DRIVES the next session must live in Postgres
 *            as queryable, decay-ranked rows — NOT in the handoff.md prose body.
 *            The handoff.md file is meant to be a THIN POINTER.
 *
 * ── Why these tests are RED today (the architecture gap) ──────────────────────
 *
 * At close (handoff.js ~4569-4624) payload.tldr / open_threads / quick_references
 * are interpolated ONLY into the handoff.md body via writeHandoffMd(...). They are
 * NEVER persisted as queryable assertion rows. The loader (cmdLoaderLoad,
 * handoff.js:2732-2756) then serves that whole MD body verbatim as the LEAD
 * "=== Handoff context ===" block, and only AFTER it appends the decay-ranked
 * "### Assertions" PG lines (handoff.js:2351-2415, ORDER BY
 * confidence*exp(-decay_rate*age_days)[+outcome_bias] DESC, tier-aware).
 *
 * Consequence:
 *   • The session-DRIVING intent (the open threads) is undifferentiated prose
 *     that is NOT decay-ranked and NOT bounded per-item — it can never appear
 *     among the ranked PG lines because it was never written as a row.
 *   • The MD body grows with every close, so the served default resume's token
 *     count grows without bound. There is no decay-bury for the prose tail.
 *
 * ── The TARGET state these tests encode (when they go GREEN, unmodified) ──────
 *
 *   • Each open-thread becomes a queryable assertion row (predicate
 *     PREDICATE_OPEN_THREAD) so it is decay-ranked alongside every other
 *     assertion, tier-aware, by the SAME ORDER BY the loader already uses.
 *   • The handoff.md body becomes a thin pointer (a few hundred bytes at most),
 *     so the served default resume stays within loader_token_budget and stays
 *     roughly stable across many closes — decay buries the stale tail.
 *
 * Run (worktrees lack scripts/node_modules — point NODE_PATH at the real one):
 *   NODE_PATH="C:\Users\djwmo\dev\claude-memory\scripts\node_modules" \
 *     node test/north-star/test-retrieval-economy.js
 *
 * Exit codes (from the shared harness run()): 0 all-pass, 1 any-fail, 2 infra.
 * US English, CommonJS. namespace 'economy'.
 */

const H = require('./lib/ns-harness.js');

// The predicate the TARGET-state close must use to persist an open-thread as a
// queryable, decay-rankable row. Today no close writes this predicate — that is
// precisely the load-bearing gap the RED tests prove. When the fix lands, close
// will emit one assertion per open-thread under this predicate.
const PREDICATE_OPEN_THREAD = 'open_thread';

// A `kind:'assertion'` query exercises the loader's FULL decay-ranking ORDER BY
// (confidence * exp(-decay_rate * age_days) [+ outcome_bias] DESC, tier-aware) —
// handoff.js:2373-2395. We install it as the project's default contract so the
// decay-ranked PG surface is part of the DEFAULT resume (the default contract
// ships with queries:[] — handoff.js:1769 — so without this no PG lines are
// served at all, which would make the test RED for the wrong, trivial reason).
const ASSERTION_CONTRACT = { queries: [{ kind: 'assertion' }] };

// ── helpers local to this file ────────────────────────────────────────────────

/**
 * Read the live loader_token_budget for a project (default 4000). We read it
 * rather than hardcode so the test tracks any project_settings override.
 */
async function loaderBudget(db, projectId) {
  const { rows } = await db.query(
    `SELECT value FROM project_settings WHERE project_id = $1 AND key = 'loader_token_budget'`,
    [projectId]
  );
  if (rows.length && rows[0].value != null) {
    const n = parseInt(rows[0].value, 10);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return 4000;
}

/**
 * Force a single open-thread assertion row to a controlled (confidence,
 * last_reinforced) so the decay score is deterministic for the ordering check.
 * Affects 0 rows today (the row does not exist) — which is exactly why the
 * ordering assertion that depends on it is RED. After the fix the row exists and
 * this pins its rank.
 *
 * @returns {Promise<number>} number of rows updated (0 today, 1 after the fix).
 */
async function pinDecay(db, projectId, object, { confidence, ageDays }) {
  const res = await db.query(
    `UPDATE assertions
        SET confidence = $3,
            last_reinforced = now() - ($4 || ' days')::interval,
            suppressed = false,
            invalid_at = NULL
      WHERE project_id = $1
        AND predicate = $2
        AND object = $5`,
    [projectId, PREDICATE_OPEN_THREAD, confidence, String(ageDays), object]
  );
  return res.rowCount || 0;
}

/**
 * Extract the "### Assertions" block lines from a resume stdout (the decay-ranked
 * PG-sourced lines, rendered `- [<source>|conf=<c>] <subject> <predicate>
 * <object>` — handoff.js:2398-2400). Returns [] if the section is absent.
 */
function assertionLines(stdout) {
  const text = String(stdout || '');
  const idx = text.indexOf('### Assertions');
  if (idx < 0) return [];
  const after = text.slice(idx + '### Assertions'.length);
  const lines = [];
  for (const raw of after.split('\n')) {
    const line = raw.trim();
    if (line.startsWith('- ')) { lines.push(line); continue; }
    if (line.startsWith('### ') || line.startsWith('=== ')) break; // next section
    if (line === '' && lines.length === 0) continue;               // leading blank
    if (line === '') continue;
  }
  return lines;
}

/** Index of the first decay-ranked assertion line whose text contains `needle`. */
function rankOf(stdout, needle) {
  const lines = assertionLines(stdout);
  return lines.findIndex((l) => l.includes(needle));
}

// ── tests ───────────────────────────────────────────────────────────────────

(async function main() {
  // Preflight FIRST. MUST pass on a healthy box; a failure here is infra (exit 2),
  // never a RED-by-construction signal.
  const pf = await H.preflight({ needVllm: false });
  if (pf.skip) {
    console.log(`SKIP — ${pf.reason}`);
    process.exit(0);
  }
  console.log('preflight OK — DB reachable, schemas applied.');

  await H.run(async () => {

    // ── INVARIANT 4 — DECAY-RANKED DEFAULT ───────────────────────────────────
    //
    // Close two open-thread intents across two sessions, pin one fresh+high and
    // one stale+low, run the default resume, and assert the load-bearing intent
    // is served as decay-RANKED PG lines in decay order (fresher/higher outranks
    // stale), tier-aware. RED today: the open-thread intent is MD prose, never a
    // ranked PG row.
    await H.test(
      'INV4 decay-ranked default: open-thread intent surfaces as decay-ordered PG rows (fresh > stale)',
      async () => {
        const { db, fakeRoot, projectId, cleanup } = await H.setupNs({ namespace: 'economy' });
        try {
          // Unique, identifiable thread bodies (substring-matchable in stdout).
          const FRESH = 'OPEN-THREAD-ALPHA finish the decay-rank backfill migration';
          const STALE = 'OPEN-THREAD-BRAVO revisit the abandoned reranker spike';

          // Session 1 — the STALE thread closed first, plus the assertion contract
          // so the decay-ranked PG path is live in the default resume.
          H.runClose(fakeRoot, {
            session_id:   'sess-stale',
            tldr:         'session one',
            open_threads: [STALE],
            contract:     ASSERTION_CONTRACT,
          });

          // Session 2 — the FRESH thread closed second.
          H.runClose(fakeRoot, {
            session_id:   'sess-fresh',
            tldr:         'session two',
            open_threads: [FRESH],
          });

          // (A) Load-bearing premise: each open-thread must exist as a queryable,
          // live assertion row. RED today — close writes none.
          await H.assertHasQueryablePredicate(
            db, projectId, PREDICATE_OPEN_THREAD,
            'INV4(A) open-thread intent must be a queryable PG row, not MD prose'
          );

          // Pin deterministic decay scores on those rows:
          //   FRESH: high confidence (9), reinforced today  → high decayed score.
          //   STALE: low confidence (3), reinforced 60d ago → low decayed score.
          // Today both updates touch 0 rows (the rows do not exist); after the fix
          // each pins exactly one row.
          const pinnedFresh = await pinDecay(db, projectId, FRESH, { confidence: 9, ageDays: 0 });
          const pinnedStale = await pinDecay(db, projectId, STALE, { confidence: 3, ageDays: 60 });
          const A = require('assert');
          A.ok(
            pinnedFresh === 1 && pinnedStale === 1,
            `INV4: expected exactly one open-thread row per thread to pin decay on ` +
            `(fresh pinned=${pinnedFresh}, stale pinned=${pinnedStale}) — ` +
            `north-star premise: the session-driving open-thread intent must live as ` +
            `queryable PG rows, so each must be pinnable. RED today: close persists ` +
            `the open threads only into the handoff.md prose body, never as rows.`
          );

          // Blank the MD prose body so the ONLY way these threads can surface is
          // as PG rows — isolates the load-bearing channel from the prose channel.
          H.blankHandoffMdBody(projectId);

          const out = H.runResume(fakeRoot);

          // (B) Both intents must surface as decay-ranked "### Assertions" PG lines.
          const fresh = rankOf(out, 'OPEN-THREAD-ALPHA');
          const stale = rankOf(out, 'OPEN-THREAD-BRAVO');
          A.ok(
            fresh >= 0 && stale >= 0,
            `INV4(B): both open-thread intents must appear among the decay-ranked ` +
            `### Assertions PG lines (fresh idx=${fresh}, stale idx=${stale}) — ` +
            `north-star (2): the default surface is the decay-ranked PG rows, not ` +
            `undifferentiated prose. RED today: the intent is MD prose, never a ranked row.`
          );

          // (C) Decay ORDER: the fresh/high-confidence thread must outrank the
          // stale/low-confidence one in the served surface.
          A.ok(
            fresh < stale,
            `INV4(C): fresher/higher-confidence open-thread (idx ${fresh}) must outrank ` +
            `the stale/low-confidence one (idx ${stale}) in the served decay-ranked ` +
            `surface — confidence*exp(-decay_rate*age_days). RED today.`
          );
        } finally {
          try { await db.end(); } catch (_) {}
          await cleanup();
        }
      }
    );

    // ── INVARIANT 5a — TOKEN-BOUNDED DEFAULT (single close within budget) ─────
    //
    // A normal close's default resume must stay within loader_token_budget, and
    // the handoff.md body must already be a thin pointer (not a growing
    // narrative). The thin-pointer assertion is RED today: a single ordinary
    // close writes a multi-hundred-byte prose body.
    await H.test(
      'INV5a token-bounded default: single-close resume within budget AND md is a thin pointer',
      async () => {
        const { db, fakeRoot, projectId, cleanup } = await H.setupNs({ namespace: 'economy' });
        try {
          H.runClose(fakeRoot, {
            session_id:       'sess-bounded',
            tldr:             'Wired the decay-rank backfill; verified live ordering against the eval DB.',
            open_threads:     [
              'Backfill the remaining legacy rows that predate the last_reinforced default.',
              'Confirm the tier-aware prefix survives the node:sqlite rewrite path.',
            ],
            quick_references: 'handoff.js:2373 decay ORDER BY; sql/handoff-core-schema.sql:75 last_reinforced.',
            contract:         ASSERTION_CONTRACT,
          });

          const budget = await loaderBudget(db, projectId);
          const out = H.runResume(fakeRoot);

          // Budget check — should already hold for a single small close.
          H.assertWithinBudget(out, budget, 'INV5a default resume must be lean');

          // Thin-pointer check — RED today: the prose body is the payload, not a pointer.
          H.assertMdThinPointer(
            projectId, 512,
            'INV5a handoff.md must be a thin pointer (session-driving payload lives in PG rows)'
          );
        } finally {
          try { await db.end(); } catch (_) {}
          await cleanup();
        }
      }
    );

    // ── INVARIANT 5b — TOKEN-BOUNDED DEFAULT under a large session payload ────
    //
    // A close can carry an arbitrarily large open-threads/tldr/quick_references
    // payload — the session-driving intent. Because that payload is written ONLY
    // into the handoff.md body and the loader serves that body verbatim as the
    // LEAD surface, the served default resume's TRUE size grows without bound with
    // the size of the payload.
    //
    // Worse, the engine's own "tokens used: ~N" line does NOT count the served MD
    // body at all (handoff.js:2754-2755 push the body to output; tokensUsed is
    // only ever incremented for the PG-retrieved `### ...` sections — :2345/:2402/
    // etc.). So the reported lean-budget guarantee is a FICTION: a single large
    // close produces a served payload that blows the budget while `tokens used`
    // reports a tiny number and the within-budget check passes vacuously.
    //
    // RED today on TWO independent counts:
    //   (A) the TRUE served size exceeds loader_token_budget;
    //   (C) the handoff.md body is a multi-KB narrative, not a thin pointer.
    // GREEN after the fix: the open-thread intent becomes decay-ranked PG rows
    //   (counted against the budget, bounded by LIMIT and decay-bury), and the MD
    //   body collapses to a thin pointer — so the TRUE served size ≈ the reported
    //   `tokens used` and both stay within budget.
    await H.test(
      'INV5b token-bounded default: a large session payload does not blow the TRUE served budget',
      async () => {
        const { db, fakeRoot, projectId, cleanup } = await H.setupNs({ namespace: 'economy' });
        try {
          const budget = await loaderBudget(db, projectId);
          const A = require('assert');

          // A large but realistic session: many open threads + a long tldr + long
          // quick_references. All session-driving intent — all prose today.
          const threads = [];
          for (let i = 0; i < 40; i++) {
            threads.push(`open thread ${i}: ` + 'y'.repeat(400));
          }
          H.runClose(fakeRoot, {
            session_id:       'big-payload',
            tldr:             'big tldr ' + 'z'.repeat(800),
            open_threads:     threads,
            quick_references: 'refs ' + 'w'.repeat(800),
            contract:         ASSERTION_CONTRACT,
          });

          const out = H.runResume(fakeRoot);

          // The engine claims a budget — read what it reports it used.
          const reported = H.parseTokensUsed(out);
          A.notStrictEqual(
            reported, null,
            'INV5b: resume must report a "tokens used: ~N" line'
          );

          // (A) The TRUE served size (same Math.ceil(len/4) convention the engine
          // uses) must be within budget. RED today: the served MD body is the bulk
          // of the payload and is excluded from `tokens used`, so the true served
          // size blows the budget while the reported number stays tiny.
          const trueServedTokens = H.estimateTokens(out);
          A.ok(
            trueServedTokens <= budget,
            `INV5b(A): the TRUE served default-resume size is ~${trueServedTokens} tokens ` +
            `(> budget ${budget}) while the engine reported only ~${reported} — the served ` +
            `handoff.md prose body is not counted against the budget (handoff.js:2754-2755). ` +
            `north-star (2): the default resume must be genuinely lean; the session-driving ` +
            `intent must be decay-ranked PG rows that are counted and bounded, not unbounded ` +
            `prose served outside the budget.`
          );

          // (C) The MD body must be a thin pointer — RED today (multi-KB body).
          H.assertMdThinPointer(
            projectId, 512,
            'INV5b handoff.md must be a thin pointer even for a large session payload'
          );
        } finally {
          try { await db.end(); } catch (_) {}
          await cleanup();
        }
      }
    );
  });
})().catch((err) => {
  // A throw out here (e.g. preflight infra error) is an infrastructure failure.
  console.error(`\nInfrastructure error: ${err.message}`);
  if (process.env.DEBUG) console.error(err.stack);
  process.exit(2);
});
