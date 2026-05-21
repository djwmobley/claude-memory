'use strict';

/**
 * test-fidelity-dataloss.js — North-star invariant: LOSSLESS FIDELITY.
 *
 * North star (verbatim):
 *   (1) lossless fidelity   — no prior plan/work lost across sessions;
 *   (2) lean, decay-ranked default resume that minimizes bootstrap token spend;
 *   (3) resurrection on demand.
 * Load-bearing premise: the information that drives the next session MUST live
 * in Postgres as queryable rows, NOT in markdown prose. The handoff.md is meant
 * to be a thin pointer.
 *
 * This file is the adversarial DATA-LOSS arm. It proves, by construction, that
 * session-driving intent (payload.tldr / open_threads / quick_references) has NO
 * queryable Postgres home today: it is written ONLY into the handoff.md body
 * (writeHandoffMd, handoff.js:4611-4624) and served verbatim as the
 * "=== Handoff context ===" block on resume (handoff.js:2754-2755). It is never
 * inserted into the `assertions` table — only payload.assertions is. And there
 * is NO predicate in scripts/lib/predicate-registry.json for open-thread /
 * next-action intent. So:
 *   - blank the MD body and the only copy of the intent is gone;
 *   - close again and the new MD body REPLACES (not appends) the old one, so a
 *     prior session's open-threads are silently overwritten.
 *
 * ─── TDD CONTRACT ──────────────────────────────────────────────────────────
 * These tests are RED-BY-CONSTRUCTION today. Each one:
 *   - calls H.preflight({ needVllm:false }) FIRST and REQUIRES it to pass, so a
 *     failure is attributable to the architecture, not the scaffold;
 *   - fails today for the load-bearing reason (intent not in DB / overwritten),
 *     NOT from a bug, typo, or missing table;
 *   - flips GREEN, unmodified, once the engine persists open-thread / next-action
 *     intent as queryable PG assertion rows AND surfaces them on the default
 *     resume contract (i.e. once close stops relying on the MD body as the sole
 *     store of session-driving intent).
 *
 * ─── TARGET PREDICATE SPEC ─────────────────────────────────────────────────
 * Invariant 3 (QUERYABLE HOME) names the predicate the rebuild MUST create. We
 * pick:
 *
 *     predicate = 'open_thread'
 *
 * Spec the rebuild must satisfy: at close, for every string in
 * payload.open_threads, the engine writes a LIVE assertion row
 *     (subject = <project name or 'session'>, predicate = 'open_thread',
 *      object = <the open-thread text>, source = 'model_extracted' or 'user_stated')
 * for the closing project_id. The string content of the open-thread must be
 * recoverable by a predicate query (queryAssertions(db, projectId,
 * { predicate:'open_thread' })) and must surface on the next default resume.
 * A sibling 'next_action' predicate would equally satisfy the north star; this
 * file standardizes on 'open_thread' because the close payload's field is
 * literally `open_threads`. The registry MUST gain an 'open_thread' entry as
 * part of the fix.
 *
 * CommonJS, US English, repo style. Exit codes: 0 all-pass, 1 any failure,
 * 2 infrastructure error (via H.run / H.preflight infra throws).
 */

const H = require('./lib/ns-harness.js');

// Target predicate the rebuild must use as the queryable home for open-threads.
// Documented above; referenced by invariant 3 and reused by invariants 1/2 to
// assert the PG-row half of recoverability.
const OPEN_THREAD_PREDICATE = 'open_thread';

/**
 * Extract the bare open-thread text (without the leading "- " markdown bullet
 * the writer prepends) so substring assertions match either the raw payload
 * string or a PG row object. The fixtures carry distinctive marker tokens
 * (NS-THREAD-ALPHA, NS-S1-THREAD-A, …) — we assert on the whole string so the
 * check is unambiguous and cannot pass by accident.
 *
 * @param {string[]} threads
 * @returns {string[]}
 */
function openThreadStrings(threads) {
  return (threads || []).map((t) => String(t));
}

H.run(async () => {
  // ─── INVARIANT 1 — CORNERSTONE ─────────────────────────────────────────────
  // Close a session carrying tldr + several open_threads + quick_references,
  // then BLANK the handoff.md body (simulating the thin-pointer end state, or
  // simply a lost/rotated MD), then resume. Every load-bearing open-thread /
  // next-action string MUST still surface — from Postgres.
  //
  // RED now: blanking the MD erases the ONLY copy of the open-threads; resume's
  // "=== Handoff context ===" block is empty and no PG rows carry the threads,
  // so assertSurfaced fails listing the missing markers.
  //
  // GREEN after fix: close persisted each open-thread as an 'open_thread'
  // assertion row; resume's default contract surfaces those rows in the
  // "=== Retrieved context ===" block, so the markers appear even with a blank
  // MD body.
  await H.test(
    'CORNERSTONE: open-threads survive a blanked handoff.md body (served from PG on resume)',
    async () => {
      const pf = await H.preflight({ needVllm: false });
      if (pf.skip) throw new Error(`preflight unexpectedly skipped: ${pf.reason}`);

      const { db, fakeRoot, projectId, cleanup } = await H.setupNs({ namespace: 'fidelity' });
      try {
        const fixture = H.loadFixture('single-session');
        const threads = openThreadStrings(fixture.open_threads);

        // Sanity (not the RED): the fixture actually carries the intent we test.
        if (threads.length < 2) {
          throw new Error('fixture single-session must carry several open_threads');
        }

        // 1. Close carrying tldr + open_threads + quick_references.
        H.runClose(fakeRoot, fixture);

        // 2. Blank the MD body — keep only frontmatter. After this the MD is no
        //    longer a store of session-driving intent.
        const blanked = H.blankHandoffMdBody(projectId);
        if (!blanked) throw new Error('blankHandoffMdBody found no handoff.md to blank');

        // 3. Resume — served context must STILL carry every open-thread.
        const served = H.runResume(fakeRoot);

        // The load-bearing assertion: every open-thread string (the
        // next-action intent that drives the next session) must surface from PG.
        H.assertSurfaced(
          served,
          threads,
          'CORNERSTONE: after blanking handoff.md, every open-thread / next-action ' +
          'must still surface on resume because it lives in Postgres'
        );
      } finally {
        try { await db.end(); } catch (_) {}
        await cleanup();
      }
    }
  );

  // ─── INVARIANT 2 — LOSSLESS MULTI-SESSION ──────────────────────────────────
  // Replay the multi-session fixture: 3 successive closes, each with DISTINCT
  // open-threads. Then resume. ALL distinct open-threads from ALL sessions must
  // be recoverable — none silently overwritten or dropped.
  //
  // We assert recoverability TWO ways, both of which the north star requires:
  //   (a) every distinct open-thread surfaces on the final resume; and
  //   (b) every distinct open-thread exists as a live queryable PG assertion row
  //       (so it is recoverable independent of whatever the MD body happens to
  //       hold).
  //
  // RED now: each close re-renders the whole handoff.md body from the template,
  // REPLACING the prior body (writeHandoffMd, handoff.js:250 / 4611). After the
  // 3rd close the MD body holds only session-3's threads; sessions 1 and 2 have
  // no PG home, so they are gone. Both (a) and (b) fail listing the lost markers.
  //
  // GREEN after fix: each close APPENDS its open-threads as 'open_thread' PG rows
  // (additive, never overwriting prior sessions' rows); resume surfaces all live
  // open_thread rows, so every session's threads remain recoverable.
  await H.test(
    'LOSSLESS MULTI-SESSION: open-threads from every prior close remain recoverable',
    async () => {
      const pf = await H.preflight({ needVllm: false });
      if (pf.skip) throw new Error(`preflight unexpectedly skipped: ${pf.reason}`);

      const { db, fakeRoot, projectId, cleanup } = await H.setupNs({ namespace: 'fidelity' });
      try {
        const fixture = H.loadFixture('multi-session');
        const sessions = fixture.sessions || [];
        if (sessions.length < 3) {
          throw new Error('fixture multi-session must carry 3+ sessions with distinct open_threads');
        }

        // All distinct open-threads across every session, in order.
        const allThreads = [];
        for (const s of sessions) {
          for (const t of openThreadStrings(s.open_threads)) allThreads.push(t);
        }

        // Replay the closes in order (3+ successive runClose).
        for (const s of sessions) {
          H.runClose(fakeRoot, s);
        }

        // (a) Final resume must surface EVERY distinct open-thread — including
        //     sessions 1 and 2, not just the last close's.
        const served = H.runResume(fakeRoot);
        H.assertSurfaced(
          served,
          allThreads,
          'LOSSLESS MULTI-SESSION: open-threads from earlier closes must not be ' +
          'overwritten by later closes — every session\'s intent must survive into resume'
        );

        // (b) Every distinct open-thread must also exist as a live queryable PG
        //     assertion row. Query by predicate, collect the objects, and assert
        //     each thread string is present among them.
        const rows = await H.queryAssertions(db, projectId, { predicate: OPEN_THREAD_PREDICATE });
        const objects = rows.map((r) => String(r.object || ''));
        const missing = allThreads.filter(
          (t) => !objects.some((o) => o.includes(t) || t.includes(o))
        );
        if (missing.length !== 0) {
          throw new Error(
            'LOSSLESS MULTI-SESSION: these open-threads have no live queryable ' +
            `"${OPEN_THREAD_PREDICATE}" assertion row (silently overwritten/dropped): ` +
            `${JSON.stringify(missing)} — north-star (1) lossless fidelity requires every ` +
            'prior session\'s intent to persist additively in Postgres, not be replaced in the MD.'
          );
        }
      } finally {
        try { await db.end(); } catch (_) {}
        await cleanup();
      }
    }
  );

  // ─── INVARIANT 3 — QUERYABLE HOME ──────────────────────────────────────────
  // After a single close carrying open_threads, each open-thread must exist as a
  // LIVE queryable PG assertion row under the target predicate. This is the
  // spec-defining test: it declares the queryable home the rebuild must create.
  //
  // RED now: no 'open_thread' predicate exists in the registry and close writes
  // open_threads only to the MD body; queryAssertions(... predicate:'open_thread')
  // returns zero rows, so assertHasQueryablePredicate throws.
  //
  // GREEN after fix: close inserts one 'open_thread' assertion per open-thread;
  // assertHasQueryablePredicate finds them. (We additionally check the COUNT and
  // the actual thread CONTENT so a single placeholder row cannot satisfy the
  // spec — the queryable home must hold the real intent, one row per thread.)
  await H.test(
    `QUERYABLE HOME: each open-thread is a live queryable "${OPEN_THREAD_PREDICATE}" PG assertion row`,
    async () => {
      const pf = await H.preflight({ needVllm: false });
      if (pf.skip) throw new Error(`preflight unexpectedly skipped: ${pf.reason}`);

      const { db, fakeRoot, projectId, cleanup } = await H.setupNs({ namespace: 'fidelity' });
      try {
        const fixture = H.loadFixture('single-session');
        const threads = openThreadStrings(fixture.open_threads);
        if (threads.length < 2) {
          throw new Error('fixture single-session must carry several open_threads');
        }

        // Close carrying the open-threads.
        H.runClose(fakeRoot, fixture);

        // Primary spec assertion: a queryable predicate home exists at all.
        await H.assertHasQueryablePredicate(
          db,
          projectId,
          OPEN_THREAD_PREDICATE,
          `QUERYABLE HOME: close must persist open_threads as live "${OPEN_THREAD_PREDICATE}" ` +
          'assertion rows so session-driving intent has a Postgres home, not just MD prose'
        );

        // Strengthen the spec: every distinct open-thread's CONTENT must be
        // recoverable by a predicate query — not merely one token row.
        const rows = await H.queryAssertions(db, projectId, { predicate: OPEN_THREAD_PREDICATE });
        const objects = rows.map((r) => String(r.object || ''));
        const missing = threads.filter(
          (t) => !objects.some((o) => o.includes(t) || t.includes(o))
        );
        if (missing.length !== 0) {
          throw new Error(
            `QUERYABLE HOME: a "${OPEN_THREAD_PREDICATE}" predicate exists but these open-thread ` +
            `texts are not recoverable as rows: ${JSON.stringify(missing)} — the queryable home ` +
            'must carry the actual intent (one row per open-thread), not a placeholder.'
          );
        }
      } finally {
        try { await db.end(); } catch (_) {}
        await cleanup();
      }
    }
  );
});
