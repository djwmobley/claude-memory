'use strict';

/**
 * test-lifecycle-roundtrip.js — LIFECYCLE ROUND-TRIP arm of the north-star suite.
 *
 * This file is RED BY CONSTRUCTION. It encodes the TARGET state the system must
 * reach, not the broken state it is in today. It MUST fail now for the
 * load-bearing reason — the session-driving intent (tldr / open_threads /
 * quick_references) is written ONLY into the handoff.md prose body and is NEVER
 * persisted as queryable Postgres rows — and it MUST pass, unmodified, once that
 * intent becomes queryable PG assertions, resume reconstructs from PG alone, and
 * the handoff.md becomes a thin pointer.
 *
 * North star (the three goals this file defends):
 *   (1) lossless fidelity — the plan/work/intent that drives the next session
 *       survives the close→resume round-trip;
 *   (2) lean, decay-ranked default resume — the handoff.md is a thin pointer, not
 *       the narrative store;
 *   (3) resurrection on demand — a since-devalued intent can be pulled back via an
 *       explicit query.
 *
 * The three invariants below map 1:1 onto those goals:
 *   A. CLOSE→RESUME RECONSTRUCTABLE-FROM-PG-ALONE  (goal 1)
 *   B. MD IS A THIN POINTER                        (goal 2)
 *   C. RESURRECTION OF DEVALUED INTENT (vLLM arm)  (goal 3)
 *
 * Why each is RED today (architecture gap, verified against scripts/handoff.js):
 *   - At close, payload.tldr / open_threads / quick_references are interpolated
 *     into the handoff.md body via writeHandoffMd (handoff.js ~4611-4624). They
 *     are NEVER persisted as rows: writeExtraction (handoff.js ~3387-3474) only
 *     writes entities / assertions / edges / contract.
 *   - cmdLoaderLoad serves the handoff.md body verbatim (handoff.js ~2732-2756);
 *     with the body blanked, the intent has no PG home to be served from.
 *   - cmdResurrect → runResurrectQuery (handoff.js ~1956-2167) recovers SUPPRESSED
 *     probationary assertions (suppressed=true, suppression_kind='downvoted_probation')
 *     gated on a trusted anchor for the subject (reality_check='verified' OR
 *     pinned=true). Load-bearing intent is never an assertion, so there is nothing
 *     to suppress and nothing to resurrect.
 *
 * Run (worktrees lack scripts/node_modules — point NODE_PATH at the main checkout):
 *   NODE_PATH="/path/to/claude-memory/scripts/node_modules" \
 *     node test/north-star/test-lifecycle-roundtrip.js
 *
 * Exit codes (from the shared run() epilogue): 0 all-pass, 1 any failure,
 * 2 infrastructure error.
 *
 * CommonJS, US English, matching repo style.
 */

const H = require('./lib/ns-harness.js');

const NAMESPACE = 'roundtrip';

// ── Load-bearing markers the round-trip must preserve ──────────────────────────
//
// These distinctive tokens come straight from fixtures/single-session.json. Each
// is a load-bearing field whose survival (or recovery) the invariants assert. They
// are intentionally unique strings so a substring check on served context cannot
// false-positive on incidental prose.
const FIXTURE_NAME = 'single-session';

// The TL;DR carries the single most load-bearing instruction for the next session.
const TLDR_MARKER = 'NS-TLDR-MARKER';

// Every open thread is a distinct unit of session-driving intent.
const OPEN_THREAD_MARKERS = [
  'NS-THREAD-ALPHA',
  'NS-THREAD-BRAVO',
  'NS-THREAD-CHARLIE',
  'NS-THREAD-DELTA',
];

// Quick references — pointers the next session needs to navigate the codebase.
const QUICK_REF_MARKERS = ['NS-REF-ONE', 'NS-REF-TWO', 'NS-REF-THREE'];

// ── Resurrection arm constants ─────────────────────────────────────────────────
//
// The intent we devalue then resurrect MUST be one that lives ONLY in
// tldr/open_threads/quick_references prose today — NOT one the fixture already
// ships as an explicit `assertions[]` entry (those are persisted today, which
// would let the arm pass for the WRONG reason). Open-thread BRAVO is the clean
// choice: its distinctive token "NS-THREAD-BRAVO" appears in no fixture assertion,
// so today there is no PG row carrying it — close drops it into prose only.
//
// After the fix, close persists BRAVO as a queryable assertion (subject derived by
// the fix author); the resurrect arm devalues that row, anchors its subject for the
// forge-gate, confirms it is gone from the default resume surface, then pulls it
// back via an explicit query.
const RESURRECT_INTENT_MARKER = 'NS-THREAD-BRAVO'; // a prose-only intent today
const RESURRECT_SEED =
  'NS-THREAD-BRAVO wire smoketest-resurrect-real-vllm into the pre-release CI gate';

/**
 * Collect every assertion row for the project (including suppressed / invalidated)
 * and return only the ones whose subject/predicate/object, concatenated, contain
 * the given marker substring. The harness queryAssertions only matches columns
 * exactly; the round-trip needs substring-against-the-row-content semantics because
 * the fix author chooses the exact subject/predicate it derives the intent into —
 * the test must not over-specify that and break a correct fix.
 *
 * @param {import('pg').Client} db
 * @param {string} projectId
 * @param {string} marker - substring to look for across subject|predicate|object.
 * @param {object} [opts]
 * @param {boolean} [opts.includeSuppressed=false]
 * @returns {Promise<object[]>}
 */
async function assertionRowsContaining(db, projectId, marker, opts = {}) {
  const rows = await H.queryAssertions(db, projectId, {
    includeSuppressed: opts.includeSuppressed === true,
  });
  return rows.filter((r) => {
    const hay = `${r.subject || ''}${r.predicate || ''}${r.object || ''}`;
    return hay.includes(marker);
  });
}

H.run(async () => {
  // ───────────────────────────────────────────────────────────────────────────
  // INVARIANT A — CLOSE→RESUME RECONSTRUCTABLE-FROM-PG-ALONE  (north-star goal 1)
  //
  // Close a session carrying tldr + open_threads + quick_references. Then BLANK
  // the handoff.md body so the only place the intent could survive is Postgres.
  // Resume must reconstruct EVERY load-bearing field from PG alone.
  //
  // RED today: the intent was never persisted as PG rows (writeExtraction skips
  // tldr/open_threads/quick_references), and the prose that held it has been
  // blanked, so resume surfaces none of the markers.
  //
  // GREEN after the fix: close persists tldr + each open-thread + each
  // quick-reference as queryable assertions; resume retrieves and serves them, so
  // every marker surfaces even with the MD body empty.
  // ───────────────────────────────────────────────────────────────────────────
  await H.test('A: close→resume reconstructs tldr/open_threads/quick_references from PG alone (MD body blanked)', async () => {
    const pf = await H.preflight({ needVllm: false });
    if (pf.skip) throw new Error(`preflight unexpectedly wants to skip a DB-only arm: ${pf.reason}`);

    const ns = await H.setupNs({ namespace: NAMESPACE });
    try {
      const payload = H.loadFixture(FIXTURE_NAME);

      // 1. Close — writes the handoff.md AND (after the fix) the PG intent rows.
      const closeOut = H.runClose(ns.fakeRoot, payload);
      // Sanity: the close itself must have succeeded — a failed close would make
      // this RED for the WRONG reason (a bug, not the architecture gap).
      if (!/Done: handoff:close/.test(closeOut)) {
        throw new Error(`close did not complete cleanly; stdout was:\n${closeOut}`);
      }

      // 2. Blank the handoff.md body, leaving only the YAML frontmatter. Now the
      //    ONLY place the session-driving intent could live is Postgres.
      const blanked = H.blankHandoffMdBody(ns.projectId);
      if (!blanked) throw new Error('handoff.md was not written by close — cannot blank it');

      // 3. Resume — serves OPERATING_CANON + the (now empty) handoff.md body + any
      //    PG-retrieved sections. Everything load-bearing must come from PG.
      const resumeOut = H.runResume(ns.fakeRoot);

      // 4. Every load-bearing field must reconstruct from PG alone.
      const allMarkers = [TLDR_MARKER, ...OPEN_THREAD_MARKERS, ...QUICK_REF_MARKERS];
      H.assertSurfaced(
        resumeOut,
        allMarkers,
        'A (PG-alone reconstruction): with the handoff.md body blanked, resume must ' +
        'reconstruct the tldr, every open-thread, and every quick-reference from queryable PG rows'
      );
    } finally {
      try { await ns.db.end(); } catch (_) {}
      await ns.cleanup();
    }
  });

  // ───────────────────────────────────────────────────────────────────────────
  // INVARIANT B — MD IS A THIN POINTER  (north-star goal 2)
  //
  // After a close that carries a full payload, the handoff.md BODY (excluding
  // frontmatter) must be small — a thin pointer, not the narrative store.
  //
  // RED today: the body is multi-KB of TL;DR + open-threads + quick-refs prose
  // (writeHandoffMd interpolates all of it).
  //
  // GREEN after the fix: that narrative lives in PG rows; the MD body shrinks to a
  // thin pointer well under the bound.
  // ───────────────────────────────────────────────────────────────────────────
  await H.test('B: handoff.md body is a thin pointer (<= 512 bytes) after a full close', async () => {
    const pf = await H.preflight({ needVllm: false });
    if (pf.skip) throw new Error(`preflight unexpectedly wants to skip a DB-only arm: ${pf.reason}`);

    const ns = await H.setupNs({ namespace: NAMESPACE });
    try {
      const payload = H.loadFixture(FIXTURE_NAME);

      const closeOut = H.runClose(ns.fakeRoot, payload);
      if (!/Done: handoff:close/.test(closeOut)) {
        throw new Error(`close did not complete cleanly; stdout was:\n${closeOut}`);
      }

      // The frontmatter is excluded; only the prose body is measured. A small bound
      // (512 bytes) is a thin pointer — enough for a one-line "see PG" pointer plus
      // structural headings, but far below the multi-KB narrative the body holds today.
      H.assertMdThinPointer(
        ns.projectId,
        512,
        'B (thin pointer): the handoff.md body must point at PG, not store the ' +
        'tldr/open_threads/quick_references narrative'
      );
    } finally {
      try { await ns.db.end(); } catch (_) {}
      await ns.cleanup();
    }
  });

  // ───────────────────────────────────────────────────────────────────────────
  // INVARIANT C — RESURRECTION OF DEVALUED INTENT  (north-star goal 3, vLLM arm)
  //
  // The whole point of resurrection: an intent that has been devalued (decayed to
  // probation, dropped from the default resume surface) can be pulled back on
  // demand via an explicit query. For that to work, the intent must FIRST be a
  // queryable assertion that close persisted.
  //
  // Flow:
  //   1. Close carrying the load-bearing intent.
  //   2. Confirm the intent landed as a queryable PG assertion (RED gate — this is
  //      where today's run dies: the intent is prose, never a row).
  //   3. Devalue that intent assertion: suppressed=true, suppression_kind=
  //      'downvoted_probation'. Provide a trusted anchor for the same subject so
  //      the M2 forge-gate (reality_check='verified' OR pinned=true) admits it.
  //   4. Confirm the devalued intent is ABSENT from the default resume surface.
  //   5. resurrect <seed> — assert the devalued intent is recovered (PG-sourced).
  //
  // RED today: step 2 fails — there is no intent assertion, so there is nothing to
  // devalue and nothing for resurrect to recover.
  //
  // GREEN after the fix: close persists the intent as an assertion; the devaluation
  // + forge-gate anchor make it resurrect-eligible; resurrect pulls it back.
  //
  // vLLM arm: resurrect's primary candidate-resolution path embeds the seed via
  // vLLM. If vLLM is down, preflight returns {skip} and we SKIP cleanly.
  // ───────────────────────────────────────────────────────────────────────────
  const pfV = await H.preflight({ needVllm: true });
  if (pfV.skip) {
    console.log(`SKIP  C: resurrection-of-devalued-intent — ${pfV.reason}`);
  } else {
    await H.test('C: resurrect recovers a devalued load-bearing intent that close persisted as a queryable PG row', async () => {
      const ns = await H.setupNs({ namespace: NAMESPACE });
      try {
        const payload = H.loadFixture(FIXTURE_NAME);

        // 1. Close carrying the intent.
        const closeOut = H.runClose(ns.fakeRoot, payload);
        if (!/Done: handoff:close/.test(closeOut)) {
          throw new Error(`close did not complete cleanly; stdout was:\n${closeOut}`);
        }

        // 2. RED gate: the load-bearing intent must exist as a queryable assertion.
        //    Today close never persists tldr/open_threads/quick_references as rows,
        //    so this finds zero rows and the test fails RED for exactly that reason.
        //    (We look for the intent CONTENT across subject|predicate|object so the
        //    fix author is free to choose the derived predicate name.)
        const intentRows = await assertionRowsContaining(
          ns.db, ns.projectId, RESURRECT_INTENT_MARKER, { includeSuppressed: true }
        );
        if (intentRows.length === 0) {
          throw new Error(
            `no queryable assertion carries the load-bearing intent "${RESURRECT_INTENT_MARKER}" ` +
            `after close — north-star premise: the information that drives the next session must ` +
            `live in Postgres as a queryable row, not only in handoff.md prose. ` +
            `Until close persists tldr/open_threads as assertions, there is nothing to devalue ` +
            `and nothing for resurrect to recover.`
          );
        }

        // 3. Devalue the intent assertion(s) → probation. Also provide a trusted
        //    anchor on the SAME subject so the M2 forge-gate admits the subject.
        //    (handoff.js runResurrectQuery Step 3: a candidate subject is eligible
        //    only if it has a LIVE row with reality_check='verified' OR pinned=true.)
        const subject = intentRows[0].subject;
        await ns.db.query(
          `UPDATE assertions
             SET suppressed = true,
                 suppression_kind = 'downvoted_probation'
           WHERE id = ANY($1::int[])`,
          [intentRows.map((r) => r.id)]
        );

        // Trusted anchor: ensure at least one LIVE, verified row exists for the
        // subject the fix derived for the BRAVO intent. Mark any live row on that
        // subject verified so the M2 forge-gate admits it. If no live row exists for
        // the subject post-devaluation, insert a minimal verified anchor row keyed
        // on the same subject so the forge-gate has a trusted anchor to admit.
        const anchorUpd = await ns.db.query(
          `UPDATE assertions
             SET reality_check = 'verified'
           WHERE project_id = $1
             AND subject = $2
             AND suppressed = false
             AND invalid_at IS NULL`,
          [ns.projectId, subject]
        );
        if (anchorUpd.rowCount === 0) {
          await ns.db.query(
            `INSERT INTO assertions
               (project_id, subject, predicate, object, confidence, source,
                suppressed, reality_check)
             VALUES ($1, $2, 'is_verified_anchor',
                     'trusted anchor for forge-gate eligibility', 9, 'user_stated',
                     false, 'verified')`,
            [ns.projectId, subject]
          );
        }

        // 4. The devalued intent must be ABSENT from the default resume surface.
        //    (Default retrieval excludes suppressed rows; with the prose-store fix,
        //    the intent no longer lives in the MD body either.)
        const resumeOut = H.runResume(ns.fakeRoot);
        H.assertNotSurfaced(
          resumeOut,
          RESURRECT_INTENT_MARKER,
          'C (devalued→absent): a probationary intent must NOT appear in the lean default resume'
        );

        // 5. Resurrect on demand — explicit query pulls the devalued intent back.
        const resurrectOut = H.runResurrect(ns.fakeRoot, RESURRECT_SEED, {});

        // It must actually find something (not the no-match path)...
        if (/No matching probationary rows found/.test(resurrectOut)) {
          throw new Error(
            `resurrect found no probationary rows for seed "${RESURRECT_SEED}" — the devalued ` +
            `intent was not recovered. Expected the forge-gated probationary intent row for ` +
            `subject "${subject}" to be eligible.\nstdout:\n${resurrectOut}`
          );
        }
        // ...and the recovered content must be the load-bearing intent itself,
        // sourced from the PG row (the resurrect preview prints subject/predicate/object).
        H.assertSurfaced(
          resurrectOut,
          RESURRECT_INTENT_MARKER,
          'C (resurrection): the explicit resurrect query must recover the devalued, PG-sourced intent'
        );
        // Sanity: it should be the dry-run preview heading (we did not pass --revive).
        if (!/### Resurrected \(preview — dry-run\)/.test(resurrectOut)) {
          throw new Error(
            `expected the dry-run preview heading from resurrect; stdout:\n${resurrectOut}`
          );
        }
      } finally {
        try { await ns.db.end(); } catch (_) {}
        await ns.cleanup();
      }
    });
  }
});
