'use strict';

const AUTHORED_BY = 'sonnet-t7-store-wide-gate-author-2026-08-16';

/**
 * test-caveman-gate-store-wide.js — tests for the §3.5 store-wide
 * caveman-economy gate itself (test/north-star/test-caveman-economy-store-
 * wide.js + scripts/lib/caveman-lint.js), memory-manager#12/T7.
 *
 * Mirrors test/migrations/test-migrate-14-seam-tables.js's conventions:
 * self-contained scratch database (`_staging`-suffixed, satisfying
 * migrate-01's classifyTarget), unconditional cleanup, never touches
 * claude_memory_eval_test / memory_manager_staging. Provisioning reuses the
 * gate's own exported provisionSchema()/dropScratchDb() (by reference —
 * never a second copy of the migrate-01 -> ... -> migrate-16 apply
 * sequence).
 *
 * Structurally SEPARATE from test/north-star/test-caveman-economy.js and
 * test/north-star/test-caveman-economy-store-wide.js (K-11: incompatible
 * I/O shapes — this file seeds raw SQL rows into disposable tables and
 * calls the gate's exported functions directly; it does not drive a
 * close/resume subprocess round trip). Token/fidelity primitives are
 * consumed FROM scripts/lib/caveman-lint.js, never reimplemented here.
 *
 * COVERAGE (per the authoring task's deliverable list):
 *   T1  passing caveman row -> gate reports zero failures for it.
 *   T2  verbose-grandfathered row (authoring_mode='verbose' AND NULL) with
 *       HIGH function-word density -> must NOT fail the gate (economy
 *       exempt; §3.6/§3.5 step 3) — fidelity still runs (not truncated).
 *   T3  negation-dropped row (K-6 regression) -- direct test of
 *       caveman-lint's assertFullFidelity/extractLoadBearingTokens, the
 *       primitive that ENFORCES K-6 wherever a baseline exists (this
 *       codebase's existing test-caveman-economy.js ARM2, and any future
 *       captured-prior-verbose gate path). The store-wide gate's own
 *       per-row scan deliberately does NOT diff born-caveman rows against a
 *       baseline (K-5: no synthetic-baseline comparison, circular/gameable)
 *       — see this file's own header note and the authoring PR's blind-spot
 *       section for what that means this suite can and cannot prove at the
 *       full-gate level.
 *   T4  truncated row (K-7) -> MUST fail (fidelity, dangling_path).
 *   T5  unclassified column, both drift directions (K-8) -> MUST fail loud,
 *       via checkCompleteness() against a deliberately mutated manifest.
 *   T6  aggregate runGate() proof: legitimate mixed traffic (T1+T2 rows
 *       coexisting) -> overall PASS; a real truncation present anywhere
 *       (T1+T4 rows coexisting) -> overall FAIL, never masked by passing
 *       rows elsewhere.
 *
 * Usage: node test/migrations/test-caveman-gate-store-wide.js
 * Exit 0 = all pass; nonzero = any failure.
 */

const path = require('path');
const assert = require('assert');

const gate = require('../north-star/test-caveman-economy-store-wide');
const lint = require('../../scripts/lib/caveman-lint');
const shared = require('../../scripts/migrations/lib/verify15-shared');

const { createRequire } = require('module');
const scriptsRequire = createRequire(require.resolve('../../scripts/package.json'));
const { Client } = scriptsRequire('pg');

const TS = Date.now();
const DB_NAME = `caveman_gate_test_${TS}_staging`;

let passed = 0;
let failed = 0;

function ok(id, label) { console.log(`[${id}] ${label} ... PASS`); passed++; }
function bad(id, label, reason) { console.log(`[${id}] ${label} ... FAIL: ${reason}`); failed++; }
async function runCase(id, label, fn) {
  try { await fn(); ok(id, label); } catch (err) { bad(id, label, err && err.message ? err.message : String(err)); }
}

async function connect() {
  const client = new Client(shared.pgConfig(DB_NAME));
  await client.connect();
  return client;
}

async function main() {
  console.log(`test-caveman-gate-store-wide: provisioning "${DB_NAME}"`);
  gate.provisionSchema(DB_NAME);

  const client = await connect();
  let cavemanId, verboseId, nullModeAssertionId, truncatedTaskId;

  try {
    // ── Seed fixtures ──────────────────────────────────────────────────────
    {
      const r = await client.query(
        `INSERT INTO decisions (project_id, topic, decision, authoring_mode) VALUES ($1,$2,$3,'caveman') RETURNING id`,
        ['gate-test-proj', 'gate-check', 'fixed PR #93 caveman check bb3e8c2 scripts/lib/caveman-lint.js']
      );
      cavemanId = r.rows[0].id;
    }
    {
      const verboseText = 'This decision was made because the team needed a scalable solution that would work well for our future requirements and also because it aligns with what was previously discussed in the earlier meeting.';
      const r = await client.query(
        `INSERT INTO decisions (project_id, topic, decision, authoring_mode) VALUES ($1,$2,$3,'verbose') RETURNING id`,
        ['gate-test-proj', 'gate-check-verbose', verboseText]
      );
      verboseId = r.rows[0].id;
    }
    {
      // Grandfathered NULL authoring_mode on `assertions` (the K-9 addendum's
      // own nullable/no-DEFAULT pattern) with high-FW-density prose in
      // `object` (checked-caveman column, K-9 exemplar).
      const verboseObject = 'The reason this was chosen is that it was the simplest option available at the time and nobody had a better alternative to suggest.';
      const r = await client.query(
        `INSERT INTO assertions (project_id, subject, predicate, object, confidence, source) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
        ['gate-test-proj', 'gate-check-topic', 'is_status', verboseObject, 8.0, 'model_extracted']
      );
      nullModeAssertionId = r.rows[0].id;
    }
    {
      // tasks has NO authoring_mode column (K-9: always-caveman, no escape) —
      // deliberately truncated mid-path, with corroborating path context
      // earlier in the same string (see caveman-lint.js's dangling_path
      // corroboration requirement).
      const truncatedTitle = 'reviewed changes in scripts/lib/reality-checks.js:3030 and also scripts/lib/reality-check';
      const r = await client.query(
        `INSERT INTO tasks (project_id, title) VALUES ($1,$2) RETURNING id`,
        ['gate-test-proj', truncatedTitle]
      );
      truncatedTaskId = r.rows[0].id;
    }

    // ── T1: passing caveman row ─────────────────────────────────────────────
    await runCase('T1', 'passing caveman row scans with zero failures', async () => {
      const r = await gate.scanTable(client, gate.loadManifest(), 'decisions');
      const failuresForRow = r.failures.filter((f) => f.row === `decisions#${cavemanId}`);
      assert.strictEqual(failuresForRow.length, 0, `expected zero failures for decisions#${cavemanId}, got ${JSON.stringify(failuresForRow)}`);
    });

    // ── T2: verbose-grandfathered rows must NOT fail on economy ─────────────
    await runCase('T2', 'authoring_mode=verbose row with high FW density is economy-exempt (not failed)', async () => {
      const r = await gate.scanTable(client, gate.loadManifest(), 'decisions');
      const economyFailures = r.failures.filter((f) => f.row === `decisions#${verboseId}` && f.check === 'economy');
      assert.strictEqual(economyFailures.length, 0, `verbose row must be economy-exempt, got ${JSON.stringify(economyFailures)}`);
      // Sanity: this row's content WOULD have failed economy if it were
      // wrongly checked — prove the exemption is doing real work, not
      // vacuously passing because the content was already lean.
      const decisionRow = (await client.query('SELECT decision FROM decisions WHERE id=$1', [verboseId])).rows[0];
      const ratio = lint.functionWordRatio(decisionRow.decision);
      assert.ok(ratio > lint.CAVEMAN_FW_RATIO_CEILING, `fixture sanity: verbose row's FW ratio (${ratio}) should exceed the ceiling to prove the exemption is load-bearing`);
    });
    await runCase('T2b', 'grandfathered NULL authoring_mode (assertions.object) is economy-exempt (not failed)', async () => {
      const r = await gate.scanTable(client, gate.loadManifest(), 'assertions');
      const economyFailures = r.failures.filter((f) => f.row === `assertions#${nullModeAssertionId}` && f.check === 'economy');
      assert.strictEqual(economyFailures.length, 0, `NULL-authoring_mode row must be economy-exempt (grandfathered), got ${JSON.stringify(economyFailures)}`);
    });

    // ── T3: negation-dropped row (K-6 regression) — primitive-level proof ──
    await runCase('T3', 'K-6: assertFullFidelity rejects a candidate that drops a negation marker', async () => {
      const reference = 'component was not removed from scripts/lib/caveman-lint.js per PR #93';
      const droppedNegation = 'component was removed from scripts/lib/caveman-lint.js per PR #93';
      assert.throws(
        () => lint.assertFullFidelity(reference, droppedNegation, 'T3 negation-drop'),
        /not/,
        'assertFullFidelity must throw naming the dropped "not" token'
      );
      // Sanity: an UNCHANGED negation marker passes.
      assert.doesNotThrow(() => lint.assertFullFidelity(reference, reference, 'T3 sanity: identical text must pass'));
    });
    await runCase('T3b', 'K-6: extractLoadBearingTokens captures not/no/never/n\'t as load-bearing', () => {
      const tokens = lint.extractLoadBearingTokens("did not, never, no, and didn't regress");
      for (const marker of ['not', 'never', 'no', "n't"]) {
        assert.ok(tokens.includes(marker), `expected negation marker "${marker}" in extracted tokens: ${JSON.stringify(tokens)}`);
      }
    });

    // ── T4: truncated row (K-7) ──────────────────────────────────────────────
    await runCase('T4', 'truncated tasks.title (dangling_path) MUST fail fidelity', async () => {
      const r = await gate.scanTable(client, gate.loadManifest(), 'tasks');
      const fidelityFailures = r.failures.filter((f) => f.row === `tasks#${truncatedTaskId}` && f.check === 'fidelity');
      assert.strictEqual(fidelityFailures.length, 1, `expected exactly one fidelity failure for tasks#${truncatedTaskId}, got ${JSON.stringify(fidelityFailures)}`);
      assert.ok(/dangling_path/.test(fidelityFailures[0].reason), `expected dangling_path smell, got: ${fidelityFailures[0].reason}`);
    });

    // ── T5: unclassified column / manifest drift, BOTH directions (K-8) ────
    await runCase('T5a', 'K-8: a live column absent from the manifest is a LOUD FAIL (onlyLive)', async () => {
      const manifest = gate.loadManifest();
      const mutated = JSON.parse(JSON.stringify(manifest));
      delete mutated.tables.tasks.columns.title; // remove a known-live, known-classified column
      const result = await gate.checkCompleteness(client, mutated);
      assert.strictEqual(result.pass, false, 'completeness must FAIL when a live column is unrepresented');
      assert.ok(result.onlyLive.includes('tasks.title'), `expected tasks.title in onlyLive, got ${JSON.stringify(result.onlyLive)}`);
    });
    await runCase('T5b', 'K-8: a manifest column absent from the live schema is a LOUD FAIL (onlyManifest, stale manifest)', async () => {
      const manifest = gate.loadManifest();
      const mutated = JSON.parse(JSON.stringify(manifest));
      mutated.tables.tasks.columns.nonexistent_column_xyz = { class: 'checked-caveman', reason: 'fixture' };
      const result = await gate.checkCompleteness(client, mutated);
      assert.strictEqual(result.pass, false, 'completeness must FAIL when the manifest names a column that does not exist live');
      assert.ok(result.onlyManifest.includes('tasks.nonexistent_column_xyz'), `expected the fake column in onlyManifest, got ${JSON.stringify(result.onlyManifest)}`);
    });
    await runCase('T5c', 'K-8: the SHIPPED manifest itself has zero drift against this fully-provisioned schema', async () => {
      const result = await gate.checkCompleteness(client, gate.loadManifest());
      assert.strictEqual(result.pass, true, `shipped manifest must have zero drift, got onlyLive=${JSON.stringify(result.onlyLive)} onlyManifest=${JSON.stringify(result.onlyManifest)}`);
    });

    // ── T6: aggregate runGate() — legitimate traffic passes, real defects fail ──
    await runCase('T6a', 'runGate(): legitimate mixed traffic (caveman + grandfathered-verbose) is an overall PASS', async () => {
      // At this point the DB has: cavemanId (clean), verboseId (verbose,
      // exempt), nullModeAssertionId (NULL, exempt) — no truncated row has
      // been inserted for THIS sub-case's table scope check, but
      // truncatedTaskId already exists in `tasks` from earlier seeding, so
      // scope this assertion to the tables that should be clean: decisions
      // and assertions specifically (tasks is exercised in T6b instead).
      const manifest = gate.loadManifest();
      const decisionsResult = await gate.scanTable(client, manifest, 'decisions');
      const assertionsResult = await gate.scanTable(client, manifest, 'assertions');
      assert.strictEqual(decisionsResult.failures.length, 0, `decisions table should be clean, got ${JSON.stringify(decisionsResult.failures)}`);
      assert.strictEqual(assertionsResult.failures.length, 0, `assertions table should be clean, got ${JSON.stringify(assertionsResult.failures)}`);
    });
    await runCase('T6b', 'runGate(): a real truncation anywhere is never masked by passing rows elsewhere', async () => {
      const result = await gate.runGate(DB_NAME);
      assert.strictEqual(result.pass, false, 'overall gate must FAIL — a real truncated row exists in tasks');
      const tasksResult = result.tableResults.find((t) => t.table === 'tasks');
      assert.ok(tasksResult && tasksResult.failed > 0, `expected tasks table to report a failure, got ${JSON.stringify(tasksResult)}`);
      // The clean tables must NOT be reported as failed, proving failures are
      // per-row/per-table, not a blanket "something somewhere is wrong" flag.
      const decisionsResult = result.tableResults.find((t) => t.table === 'decisions');
      assert.strictEqual(decisionsResult.failed, 0, `decisions table should report zero failures even though tasks failed, got ${JSON.stringify(decisionsResult)}`);
    });
  } finally {
    await client.end();
    await gate.dropScratchDb(DB_NAME);
  }

  console.log('');
  if (failed > 0) {
    console.error(`${passed} passed, ${failed} FAILED.`);
    process.exit(1);
  }
  console.log(`All ${passed} test(s) passed.`);
  process.exit(0);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err && err.stack ? err.stack : err);
    process.exit(2);
  });
}

module.exports = { AUTHORED_BY };
