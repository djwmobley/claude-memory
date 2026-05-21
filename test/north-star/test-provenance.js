'use strict';

/**
 * test-provenance.js — North-star INVARIANT 7: PROVENANCE ON SESSION-DRIVING INTENT.
 *
 * North star (verbatim):
 *   (1) lossless fidelity; (2) lean, decay-ranked default resume;
 *   (3) resurrection on demand.
 *   Load-bearing premise: information that drives the next session MUST live in
 *   Postgres as queryable rows, NOT in markdown prose. The handoff markdown is a
 *   thin pointer.
 *
 * THE GAP THESE TESTS DEFEND (why they are RED today):
 *   At /handoff:close, payload.tldr / open_threads / quick_references are rendered
 *   ONLY into the handoff.md body (handoff.js ~4569-4624 → writeHandoffMd). They are
 *   NEVER converted into assertion rows. Verified: handoff.js touches open_threads at
 *   exactly four call sites (3642 / 3676 / 3948 / 4570) and EVERY one is a
 *   `(payload.open_threads || []).map(...).join('\n')` feeding the markdown template —
 *   there is no INSERT INTO assertions for intent, and no `open_thread` / `next_action`
 *   predicate exists anywhere in scripts/ or the predicate registry.
 *
 *   Consequence: the load-bearing intent that should steer the next session carries
 *   NONE of the provenance the assertions table is built to express —
 *     confidence, source, tier (probationary/consolidated),
 *     suppressed/suppression_kind (superseded, downvoted_terminal, downvoted_probation, retired),
 *     valid_at/invalid_at (bitemporal), pinned, reality_check, corroboration_count.
 *   Superseded intent just sits in a stale MD as an authority trap: no supersession
 *   edge, no suppression, no invalidation. Prose cannot express trust at all.
 *
 * WHAT TURNS THESE GREEN (the TARGET state encoded here):
 *   /handoff:close persists each open-thread (and any other load-bearing intent) as a
 *   queryable assertion row under a dedicated predicate (predicate='open_thread'),
 *   routed through the SAME write path that already exists for payload.assertions
 *   (writeAssertionWithSupersession, handoff.js:3023) so it inherits provenance:
 *     - confidence (1-10), source (user_stated/model_extracted/doc_quoted/retrieved_from_prior),
 *       tier (probationary by default; consolidated via the L0/L2 gate or operator pin),
 *       valid_at=now() & invalid_at=NULL on birth,
 *     - cross-session contradiction supersedes the prior intent row
 *       (suppressed=true, suppression_kind='superseded', invalid_at=now()), so the OLD
 *       intent stops surfacing on resume and the NEW one is live,
 *     - a repeatedly-reinforced user-stated fact (or an operator pin) can reach
 *       tier='consolidated' or pinned=true and is durably surfaced.
 *
 * TDD CONTRACT: each test calls preflight({needVllm:false}) FIRST (it MUST PASS), then
 * fails RED for the load-bearing reason above — NOT a bug/typo/missing table — and will
 * pass GREEN unmodified once intent is persisted as provenance-bearing PG rows. No
 * assert(false), no placeholders. CommonJS, US English.
 *
 * Running (worktrees lack scripts/node_modules):
 *   NODE_PATH="<repo>/scripts/node_modules" node test/north-star/test-provenance.js
 *
 * Exit codes (via H.run): 0 all-pass, 1 any-fail (expected RED today), 2 infra error.
 */

const assert = require('assert');
const H = require('./lib/ns-harness.js');

// The dedicated predicate the GREEN target uses to persist a session-driving
// open-thread as a queryable assertion row. It is INTENTIONALLY a predicate that
// does not exist in scripts/ today (verified: zero matches in handoff.js or the
// predicate registry) so that a row with this predicate can ONLY appear once the
// close path is taught to persist intent. It is registry-unrecognized today, which
// means the existing write path treats it as cardinality 1:N in permissive mode —
// the GREEN target may register it as 1:1 (one live thread per thread-key) without
// changing these tests, since they query by predicate and assert on per-row provenance.
const INTENT_PREDICATE = 'open_thread';

// The valid provenance vocabularies the assertions schema enforces / the suite cares about.
const VALID_SOURCES = ['user_stated', 'model_extracted', 'doc_quoted', 'retrieved_from_prior'];
const VALID_TIERS    = ['probationary', 'consolidated'];

/**
 * Assert that a single persisted-intent row carries coherent, valid provenance.
 * This is the heart of P1: the row must look like a first-class assertion, not a
 * provenance-less prose fragment that happened to land in a column.
 */
function assertRowProvenance(row, ctx) {
  // confidence — non-null, numeric, within the schema CHECK range [1,10].
  assert.ok(
    row.confidence != null,
    `${ctx}: intent row has NULL confidence — prose-derived intent carries no confidence; ` +
    `north-star: session-driving intent must be a provenance-bearing PG row.`
  );
  const conf = Number(row.confidence);
  assert.ok(
    Number.isFinite(conf) && conf >= 1 && conf <= 10,
    `${ctx}: intent row confidence ${row.confidence} is outside the valid [1,10] range.`
  );

  // source — non-null and one of the schema's allowed provenance origins.
  assert.ok(
    row.source != null,
    `${ctx}: intent row has NULL source — there is no provenance origin recorded.`
  );
  assert.ok(
    VALID_SOURCES.includes(row.source),
    `${ctx}: intent row source "${row.source}" is not one of ${JSON.stringify(VALID_SOURCES)}.`
  );

  // tier — non-null and a valid durability tier. (Grandfathered NULL is for rows
  // that predate the tier migration; freshly-persisted intent must be tagged.)
  assert.ok(
    row.tier != null,
    `${ctx}: intent row has NULL tier — freshly-persisted intent must enter a durability ` +
    `tier (probationary by default). NULL tier is reserved for pre-migration grandfathered rows.`
  );
  assert.ok(
    VALID_TIERS.includes(row.tier),
    `${ctx}: intent row tier "${row.tier}" is not one of ${JSON.stringify(VALID_TIERS)}.`
  );
}

H.run(async () => {
  // ── PREFLIGHT (must PASS on a healthy box; gates the whole file) ────────────────
  const pf = await H.preflight({ needVllm: false });
  if (pf.skip) {
    // P1-P4 do not need vLLM, so a skip here would only ever be an env issue. Honor
    // the SKIP contract regardless: print and return so run() exits 0.
    console.log(`SKIP  test-provenance — ${pf.reason}`);
    return;
  }
  console.log('PASS  preflight (DB reachable, schemas applied)');

  // ──────────────────────────────────────────────────────────────────────────────
  // P1 — PROVENANCE ON PERSISTED INTENT
  //
  // After a close carrying open_threads, the load-bearing intent must exist as
  // queryable assertion rows (predicate='open_thread'), and EACH row must carry
  // non-null, valid confidence / source / tier.
  //
  // RED today: zero rows with predicate='open_thread' exist — open_threads only ever
  // hit the markdown body (handoff.js:4570 → writeHandoffMd). assertHasQueryablePredicate
  // throws "no live assertion row with predicate open_thread".
  //
  // GREEN flip: close persists each open-thread as an assertion row through
  // writeAssertionWithSupersession, so the rows exist and inherit conf/source/tier.
  // ──────────────────────────────────────────────────────────────────────────────
  await H.test('P1 persisted intent carries provenance (confidence/source/tier)', async () => {
    const { db, fakeRoot, projectId, cleanup } = await H.setupNs({ namespace: 'provenance' });
    try {
      const fx = H.loadFixture('single-session');
      H.runClose(fakeRoot, fx);

      // The session-driving intent must be queryable as PG rows, not just prose.
      await H.assertHasQueryablePredicate(
        db, projectId, INTENT_PREDICATE,
        'P1: open_threads from the close payload must be persisted as queryable ' +
        `"${INTENT_PREDICATE}" assertion rows`
      );

      const rows = await H.queryAssertions(db, projectId, { predicate: INTENT_PREDICATE });

      // Fidelity: one queryable row per open-thread carried in the payload.
      assert.strictEqual(
        rows.length, fx.open_threads.length,
        `P1: expected ${fx.open_threads.length} "${INTENT_PREDICATE}" rows (one per open-thread), ` +
        `found ${rows.length} — every load-bearing thread must become a queryable row.`
      );

      // Provenance: each row must carry valid confidence / source / tier.
      for (const row of rows) {
        assertRowProvenance(row, `P1 row[id=${row.id}] (object="${row.object}")`);
      }

      // The thread text itself must be recoverable from the rows (lossless fidelity):
      // each fixture thread string is contained in some persisted row's object.
      const objects = rows.map((r) => String(r.object));
      for (const thread of fx.open_threads) {
        const found = objects.some((o) => o.includes(thread) || thread.includes(o));
        assert.ok(
          found,
          `P1: open-thread text not recoverable from any persisted intent row: "${thread}".`
        );
      }
    } finally {
      try { await db.end(); } catch (_) {}
      await cleanup();
    }
  });

  // ──────────────────────────────────────────────────────────────────────────────
  // P2 — SUPERSESSION ACROSS SESSIONS
  //
  // Session 1 opens a thread; session 2 resolves/replaces it with a contradictory
  // updated thread on the SAME thread-subject. The OLD intent row must be marked
  // suppressed with suppression_kind='superseded' (and excluded from default resume),
  // while the NEW intent row is live and surfaces.
  //
  // RED today: intent is not rows at all, so there is no supersession trail. The
  // markdown body is simply overwritten by the session-2 close; the session-1 intent
  // either vanishes (no row to find) or, where prose lingers, lingers as an authority
  // trap with no suppression. assertHasQueryablePredicate for the live NEW intent
  // throws first (no rows exist), so this fails RED for the load-bearing reason.
  //
  // GREEN flip: close persists intent as rows keyed by a stable thread-subject; a
  // contradictory thread on the same subject is routed through the existing 1:1
  // supersession path (buildSupersessionUpdate sets suppressed=true,
  // suppression_kind='superseded', invalid_at=now()).
  // ──────────────────────────────────────────────────────────────────────────────
  await H.test('P2 contradictory intent supersedes the prior intent across sessions', async () => {
    const { db, fakeRoot, projectId, cleanup } = await H.setupNs({ namespace: 'provenance' });
    try {
      // A stable thread-subject that both closes reference. We carry the subject inside
      // the thread text so that, however the GREEN target derives the row subject
      // (explicit key or extracted), the two closes collide on the same intent.
      const THREAD_KEY = 'SHIP-DECISION';
      const OLD_INTENT = `${THREAD_KEY}: ship the L1 patient-adversary defense THIS cycle`;
      const NEW_INTENT = `${THREAD_KEY}: DEFER the L1 patient-adversary defense to next cycle`;

      // Session 1 — open the thread.
      H.runClose(fakeRoot, {
        session_id: 'ns-provenance-p2-session-1',
        tldr: 'P2 session 1: decided to ship L1 this cycle.',
        open_threads: [OLD_INTENT],
        quick_references: '(none)',
      });

      // Session 2 — contradictory replacement on the same thread.
      H.runClose(fakeRoot, {
        session_id: 'ns-provenance-p2-session-2',
        tldr: 'P2 session 2: reversed course — L1 defers to next cycle.',
        open_threads: [NEW_INTENT],
        quick_references: '(none)',
      });

      // The NEW intent must be a LIVE queryable row.
      await H.assertHasQueryablePredicate(
        db, projectId, INTENT_PREDICATE,
        'P2: the replacement intent must be persisted as a live queryable row'
      );
      const liveRows = await H.queryAssertions(db, projectId, { predicate: INTENT_PREDICATE });
      const liveObjects = liveRows.map((r) => String(r.object));
      assert.ok(
        liveObjects.some((o) => o.includes(NEW_INTENT) || NEW_INTENT.includes(o)),
        `P2: the NEW intent ("${NEW_INTENT}") is not present as a live intent row.`
      );

      // The OLD intent must NOT be live (it was superseded).
      assert.ok(
        !liveObjects.some((o) => o.includes(OLD_INTENT) || OLD_INTENT.includes(o)),
        `P2: the OLD intent ("${OLD_INTENT}") is still LIVE after a contradictory ` +
        `replacement — it must be superseded, not lingering as an authority trap.`
      );

      // The OLD intent must exist among the SUPPRESSED rows with suppression_kind='superseded'.
      const allRows = await H.queryAssertions(
        db, projectId, { predicate: INTENT_PREDICATE, includeSuppressed: true }
      );
      const oldRow = allRows.find(
        (r) => String(r.object).includes(OLD_INTENT) || OLD_INTENT.includes(String(r.object))
      );
      assert.ok(
        oldRow,
        `P2: no persisted row carries the OLD intent ("${OLD_INTENT}") — superseded intent ` +
        `must remain a recoverable suppressed row, not be silently overwritten in prose.`
      );
      assert.strictEqual(
        oldRow.suppressed, true,
        `P2: the OLD intent row is not suppressed (suppressed=${oldRow.suppressed}) — a ` +
        `cross-session contradiction must mark the prior intent suppressed.`
      );
      assert.strictEqual(
        oldRow.suppression_kind, 'superseded',
        `P2: the OLD intent row suppression_kind is "${oldRow.suppression_kind}", expected ` +
        `"superseded" — the supersession trail must record WHY it was suppressed.`
      );

      // The OLD intent must NOT surface in the default resume; the NEW one MUST.
      const resumeOut = H.runResume(fakeRoot);
      H.assertNotSurfaced(
        resumeOut, OLD_INTENT,
        'P2: superseded intent must NOT surface in default resume'
      );
      H.assertSurfaced(
        resumeOut, NEW_INTENT,
        'P2: the live replacement intent MUST surface in default resume'
      );
    } finally {
      try { await db.end(); } catch (_) {}
      await cleanup();
    }
  });

  // ──────────────────────────────────────────────────────────────────────────────
  // P3 — BITEMPORAL VALIDITY
  //
  // Persisted intent must carry coherent bitemporal validity:
  //   - a LIVE thread has valid_at set and invalid_at NULL;
  //   - a SUPERSEDED thread has invalid_at set (and a valid_at <= invalid_at).
  //
  // RED today: intent isn't rows, so there are no valid_at/invalid_at to inspect —
  // assertHasQueryablePredicate throws first (no live intent row exists).
  //
  // GREEN flip: the INSERT sets valid_at=now() on birth (handoff.js:3357) and
  // buildSupersessionUpdate sets invalid_at=now() on supersession.
  // ──────────────────────────────────────────────────────────────────────────────
  await H.test('P3 persisted intent has coherent bitemporal valid_at/invalid_at', async () => {
    const { db, fakeRoot, projectId, cleanup } = await H.setupNs({ namespace: 'provenance' });
    try {
      const THREAD_KEY = 'BACKFILL-PLAN';
      const OLD_INTENT = `${THREAD_KEY}: backfill embeddings with the placeholder vectors`;
      const NEW_INTENT = `${THREAD_KEY}: backfill embeddings with the REAL vLLM vectors`;

      H.runClose(fakeRoot, {
        session_id: 'ns-provenance-p3-session-1',
        tldr: 'P3 session 1.',
        open_threads: [OLD_INTENT],
        quick_references: '(none)',
      });
      H.runClose(fakeRoot, {
        session_id: 'ns-provenance-p3-session-2',
        tldr: 'P3 session 2 — corrected the backfill plan.',
        open_threads: [NEW_INTENT],
        quick_references: '(none)',
      });

      // LIVE intent: valid_at set, invalid_at NULL.
      await H.assertHasQueryablePredicate(
        db, projectId, INTENT_PREDICATE,
        'P3: a live intent row must exist to inspect its bitemporal validity'
      );
      const liveRows = await H.queryAssertions(db, projectId, { predicate: INTENT_PREDICATE });
      for (const row of liveRows) {
        assert.ok(
          row.valid_at != null,
          `P3: live intent row[id=${row.id}] has NULL valid_at — a live assertion must record ` +
          `when it became valid.`
        );
        assert.strictEqual(
          row.invalid_at, null,
          `P3: live intent row[id=${row.id}] has a non-null invalid_at (${row.invalid_at}) — ` +
          `a live row must not be invalidated.`
        );
      }

      // SUPERSEDED intent: invalid_at set, and valid_at <= invalid_at (coherent interval).
      const allRows = await H.queryAssertions(
        db, projectId, { predicate: INTENT_PREDICATE, includeSuppressed: true }
      );
      const oldRow = allRows.find(
        (r) => String(r.object).includes(OLD_INTENT) || OLD_INTENT.includes(String(r.object))
      );
      assert.ok(
        oldRow,
        `P3: the superseded intent row for "${OLD_INTENT}" was not found — superseded intent ` +
        `must remain a recoverable bitemporal row.`
      );
      assert.ok(
        oldRow.invalid_at != null,
        `P3: the superseded intent row[id=${oldRow.id}] has NULL invalid_at — supersession must ` +
        `close the validity interval by stamping invalid_at.`
      );
      if (oldRow.valid_at != null) {
        assert.ok(
          new Date(oldRow.valid_at).getTime() <= new Date(oldRow.invalid_at).getTime(),
          `P3: superseded intent row[id=${oldRow.id}] has valid_at (${oldRow.valid_at}) AFTER ` +
          `invalid_at (${oldRow.invalid_at}) — the bitemporal interval is incoherent.`
        );
      }
    } finally {
      try { await db.end(); } catch (_) {}
      await cleanup();
    }
  });

  // ──────────────────────────────────────────────────────────────────────────────
  // P4 — CONSOLIDATION / PIN
  //
  // A user-stated, repeatedly-reinforced load-bearing fact must be able to reach
  // tier='consolidated' OR pinned=true and be durably surfaced — a level of trust
  // that prose cannot express at all.
  //
  // Realistic engine expectations (verified against handoff.js:3268-3360 + operator-pin.js):
  //   The L2 consolidation gate defaults to 'enforce'. Under enforce, source/confidence
  //   are model-controlled and CANNOT by themselves graduate a row to consolidated; the
  //   row needs arm (b) a quality cross-session corroborator OR arm (c) operator pin.
  //   So this test reinforces the SAME user-stated load-bearing fact across two distinct
  //   sessions (cross-session corroboration) AND asserts the disjunction
  //   (tier='consolidated' OR pinned=true) so EITHER the corroboration path or an
  //   operator-pin path satisfies it. Prose has no field to carry either signal.
  //
  // RED today: the fact is only prose in the MD body — no queryable row, hence no tier
  // and no pinned to read. assertHasQueryablePredicate throws first.
  //
  // GREEN flip: intent persists as rows; reinforcing the identical user-stated fact
  // across sessions (or pinning it) lets it reach consolidated/pinned, and the resume
  // path surfaces it durably.
  // ──────────────────────────────────────────────────────────────────────────────
  await H.test('P4 reinforced user-stated intent can reach consolidated/pinned and is durably surfaced', async () => {
    const { db, fakeRoot, projectId, cleanup } = await H.setupNs({ namespace: 'provenance' });
    try {
      // The identical load-bearing fact, restated user_stated across two sessions.
      const DURABLE_INTENT =
        'DURABLE-CANON: Postgres is the only production default; SQLite is seam-test-only';

      // Close 1 — user states the fact (session 1).
      H.runClose(fakeRoot, {
        session_id: 'ns-provenance-p4-session-1',
        tldr: 'P4 session 1 — affirmed the Postgres-default canon.',
        open_threads: [DURABLE_INTENT],
        quick_references: '(none)',
      });

      // Close 2 — the user re-affirms the SAME fact (session 2): cross-session
      // corroboration of an identical user_stated intent.
      H.runClose(fakeRoot, {
        session_id: 'ns-provenance-p4-session-2',
        tldr: 'P4 session 2 — re-affirmed the same canon.',
        open_threads: [DURABLE_INTENT],
        quick_references: '(none)',
      });

      // The fact must be a queryable intent row at all.
      await H.assertHasQueryablePredicate(
        db, projectId, INTENT_PREDICATE,
        'P4: the load-bearing fact must be a queryable intent row before its trust ' +
        'tier can mean anything'
      );

      const rows = await H.queryAssertions(
        db, projectId, { predicate: INTENT_PREDICATE, includeSuppressed: true }
      );
      const factRow = rows.find(
        (r) => String(r.object).includes(DURABLE_INTENT) || DURABLE_INTENT.includes(String(r.object))
      );
      assert.ok(
        factRow,
        `P4: no persisted intent row carries the durable fact "${DURABLE_INTENT}".`
      );

      // Trust: the reinforced fact must be expressible as durable trust — either it
      // graduated to tier='consolidated', or it is pinned=true. Prose can express neither.
      const isConsolidated = factRow.tier === 'consolidated';
      const isPinned       = factRow.pinned === true || factRow.pinned === 1;
      assert.ok(
        isConsolidated || isPinned,
        `P4: the reinforced user-stated fact reached neither tier='consolidated' nor pinned=true ` +
        `(tier=${factRow.tier}, pinned=${factRow.pinned}) — a repeatedly-reinforced load-bearing ` +
        `fact must be expressible as durable trust, which prose cannot encode at all.`
      );

      // Durability: the consolidated/pinned fact must surface in the default resume.
      const resumeOut = H.runResume(fakeRoot);
      H.assertSurfaced(
        resumeOut, DURABLE_INTENT,
        'P4: a consolidated/pinned load-bearing fact must be durably surfaced on resume'
      );
    } finally {
      try { await db.end(); } catch (_) {}
      await cleanup();
    }
  });
});
