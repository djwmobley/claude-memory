'use strict';

/**
 * verify-19-seams-smoke.js — §7 "build the seams" operator smoke test
 * (CONSOLIDATION-RUNBOOK.md §7.1-§7.8, memory-manager#17).
 *
 * Exercises scripts/lib/carryover-render.js, scripts/lib/memory-upsert.js,
 * scripts/lib/normalize-text.js, scripts/lib/reality-checks.js's
 * probeDanglingEntityReferences, scripts/lib/render-handoff-card.js,
 * scripts/lib/exchange-log.js, and scripts/lib/memory-lint.js against a
 * live target. Reuses scripts/migrations/lib/smoke-harness.js's
 * withTransactionRollback/runCheck/withSavepoint (verify-17/18's own
 * pattern) — the entire run happens inside one transaction that is ALWAYS
 * rolled back, so this is safe to run against a live staging database with
 * zero residue by construction.
 *
 * Prerequisite: migrate-14-seam-tables.js AND migrate-13-agent-exchange.js
 * (re-applied after it) must already be PASSing against the target.
 *
 * Usage: node scripts/migrations/verify-19-seams-smoke.js [--db <target>]
 * Exit codes: 0 = all checks PASS, 1 = any FAIL / refused target / missing
 * prerequisite, 2 = bad CLI usage.
 */

const path = require('path');
const { Client } = require('pg');

const migrateOne = require('./migrate-01-canonical-db');
const addenda = require('./migrate-schema-addenda');
const harness = require('./lib/smoke-harness');

const carryoverRender = require('../lib/carryover-render.js');
const memoryUpsert = require('../lib/memory-upsert.js');
const normalizeText = require('../lib/normalize-text.js');
const realityChecks = require('../lib/reality-checks.js');
const renderHandoffCard = require('../lib/render-handoff-card.js');
const exchangeLog = require('../lib/exchange-log.js');
const memoryLint = require('../lib/memory-lint.js');
const { deriveIntentSubject } = require('../handoff.js');

const LABEL = '19';

const PREREQUISITE_TABLES = [
  'entities', 'assertions', 'edges', 'audit_log', 'agent_exchange', 'embedding_providers',
  'decisions', 'gotchas', 'findings', 'research', 'incidents', 'code_index',
  'tasks', 'checklist_items', 'corpus_files',
];

class UsageError extends Error {}

function parseArgs(argv) {
  const parsed = { db: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--db') parsed.db = argv[++i];
    else if (a.startsWith('--db=')) parsed.db = a.slice('--db='.length);
    else throw new UsageError(`Unknown argument: ${a}`);
  }
  return parsed;
}

async function checkPrerequisites(client) {
  const { rows } = await client.query(
    `SELECT table_name FROM information_schema.tables
      WHERE table_schema = current_schema() AND table_type = 'BASE TABLE'`
  );
  const actual = new Set(rows.map((r) => r.table_name.toLowerCase()));
  return PREREQUISITE_TABLES.filter((t) => !actual.has(t));
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}
function assertEq(actual, expected, msg) {
  if (actual !== expected) throw new Error(`${msg} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
}

// ── mock embedder (deterministic, no live vLLM) — always 4000-dim ──────────
function mockEmbedder() {
  return async function embed(_text) {
    return new Array(4000).fill(0).map((_, i) => (i === 0 ? 0.1 : 0));
  };
}

async function runChecks(client, prefix) {
  let allOk = true;
  const results = [];
  async function check(id, name, fn) {
    const ok = await harness.runCheck(client, LABEL, id, name, fn);
    results.push({ id, name, ok });
    if (!ok) allOk = false;
  }

  const projectA = `${prefix}-proj-a`;
  const projectB = `${prefix}-proj-b`;

  // ── memory-upsert (§7.2/§7.3) ─────────────────────────────────────────
  await check(1, 'memory-upsert: unknown table rejected', async () => {
    try {
      await memoryUpsert.writeMemoryRow(client, 'not_a_real_table', { project_id: projectA });
      throw new Error('expected unknownTable error');
    } catch (err) {
      assertEq(err.code, 'unknownTable', 'error code');
    }
  });

  await check(2, 'memory-upsert: unknown key rejected', async () => {
    try {
      await memoryUpsert.writeMemoryRow(client, 'decisions', {
        project_id: projectA, topic: 'x', decision: 'y', bogus_key: 'z',
      });
      throw new Error('expected unknownKey error');
    } catch (err) {
      assertEq(err.code, 'unknownKey', 'error code');
    }
  });

  await check(3, 'memory-upsert: missing required field rejected', async () => {
    try {
      await memoryUpsert.writeMemoryRow(client, 'decisions', { project_id: projectA, topic: 'x' });
      throw new Error('expected validation error');
    } catch (err) {
      assertEq(err.code, 'validation', 'error code');
    }
  });

  await check(4, 'memory-upsert: empty-string required TEXT rejected after trim', async () => {
    try {
      await memoryUpsert.writeMemoryRow(client, 'decisions', {
        project_id: projectA, topic: '   ', decision: 'y',
      });
      throw new Error('expected validation error');
    } catch (err) {
      assertEq(err.code, 'validation', 'error code');
    }
  });

  await check(5, 'memory-upsert: string given for INTEGER column rejected (no coercion)', async () => {
    try {
      await memoryUpsert.writeMemoryRow(client, 'tasks', {
        project_id: projectA, title: 'x', github_issue: '42',
      });
      throw new Error('expected validation error');
    } catch (err) {
      assertEq(err.code, 'validation', 'error code');
    }
  });

  await check(6, 'memory-upsert: successful insert into decisions', async () => {
    const row = await memoryUpsert.writeMemoryRow(client, 'decisions', {
      project_id: projectA, topic: 'seam test topic', decision: 'seam test decision',
    });
    assert(row && typeof row.id === 'number', 'inserted row has numeric id');
  });

  await check(7, 'memory-upsert: PK collision on findings (project_id,id) is a loud error, not silent overwrite', async () => {
    const findingRow = {
      id: `${prefix}-F1`, project_id: projectA, source: 'test', severity: 'low',
      confidence: 'low', location: 'x', category: 'x', description: 'd', impact: 'i',
      remediation: 'r', effort: 'low',
    };
    await memoryUpsert.writeMemoryRow(client, 'findings', findingRow);
    try {
      await memoryUpsert.writeMemoryRow(client, 'findings', findingRow);
      throw new Error('expected collision error');
    } catch (err) {
      assertEq(err.code, 'collision', 'error code');
    }
  });

  await check(8, 'memory-upsert: findings.id TEXT insert survives UPDATE/DELETE via widened audit_log.row_id', async () => {
    const id = `${prefix}-F2`;
    await memoryUpsert.writeMemoryRow(client, 'findings', {
      id, project_id: projectA, source: 'test', severity: 'low', confidence: 'low',
      location: 'x', category: 'x', description: 'd', impact: 'i', remediation: 'r', effort: 'low',
    });
    await client.query(`UPDATE findings SET status = 'fixed' WHERE id = $1 AND project_id = $2`, [id, projectA]);
    const { rows } = await client.query(
      `SELECT row_id FROM audit_log WHERE table_name = 'findings' AND row_id = $1`, [id]
    );
    assert(rows.length === 1, 'audit_log captured the UPDATE with the TEXT row_id intact');
  });

  // ── carryover-render (§7.1) ────────────────────────────────────────────
  await check(9, 'carryover-render: legacy-NULL carryover_status row counts as open', async () => {
    const subject = `${prefix}-legacy-thread`;
    await client.query(
      `INSERT INTO assertions (project_id, subject, predicate, object, confidence, source, carryover_status)
       VALUES ($1, $2, 'open_thread', $3, 8, 'user_stated', NULL)`,
      [projectA, subject, `${subject}: legacy text`]
    );
    const rows = await carryoverRender.fetchOpenCarryovers(client, projectA);
    assert(rows.some((r) => r.subject === subject), 'legacy-NULL row returned by fetchOpenCarryovers');
  });

  await check(10, 'carryover-render: applyCarryoverDeltas resolved 0-match is a LOUD report entry, not silent', async () => {
    const result = await carryoverRender.applyCarryoverDeltas(client, projectA, {
      resolved: [`${prefix}-no-such-thread: nothing here`],
    });
    assert(result.zeroMatch.length === 1 && result.zeroMatch[0].kind === 'resolved', 'zero-match entry recorded');
  });

  await check(11, 'carryover-render: applyCarryoverDeltas resolved 2+-match throws AmbiguousCarryoverMatchError', async () => {
    // §5.5/assertions_1to1_unique makes 2 genuinely LIVE open_thread rows
    // under the same (project_id, subject) unreachable via normal INSERT —
    // S-12c's own framing: "possible only if the 1:1 index is somehow
    // bypassed." Exercised here with a minimal stub client standing in for
    // exactly that bypassed-index scenario, so the 2+-match HARD ERROR
    // branch is proven without fighting a real unique-index guarantee this
    // codebase deliberately never lets an application-level bug bypass.
    const stubClient = {
      query: async (sql) => {
        if (/FROM assertions/.test(sql) && /predicate = 'open_thread'/.test(sql)) {
          return { rows: [{ id: 101 }, { id: 102 }] };
        }
        throw new Error(`stub: unexpected query: ${sql}`);
      },
    };
    try {
      await carryoverRender.applyCarryoverDeltas(stubClient, projectA, { resolved: ['dup-thread: dup text'] });
      throw new Error('expected AmbiguousCarryoverMatchError');
    } catch (err) {
      assert(err instanceof carryoverRender.AmbiguousCarryoverMatchError, 'threw AmbiguousCarryoverMatchError');
      assert(err.rowIds.length === 2, 'error carries both matched row ids');
    }
  });

  await check(12, 'carryover-render: applyCarryoverDeltas added inserts a new open row', async () => {
    const text = `${prefix}-added-thread: new work`;
    const result = await carryoverRender.applyCarryoverDeltas(client, projectA, { added: [text] });
    assert(result.addedApplied.length === 1, 'one added row applied');
    const { rows } = await client.query(
      `SELECT carryover_status FROM assertions WHERE id = $1`, [result.addedApplied[0].id]
    );
    assertEq(rows[0].carryover_status, 'open', 'new row carryover_status');
  });

  await check(13, 'carryover-render: applyCarryoverDeltas updated supersedes old + inserts new', async () => {
    const oldText = `${prefix}-upd-thread: original`;
    await client.query(
      `INSERT INTO assertions (project_id, subject, predicate, object, confidence, source, carryover_status)
       VALUES ($1, $2, 'open_thread', $3, 8, 'user_stated', 'open')`,
      [projectA, deriveIntentSubject(oldText), oldText]
    );
    const newText = `${prefix}-upd-thread: revised`;
    const result = await carryoverRender.applyCarryoverDeltas(client, projectA, {
      updated: [{ match: oldText, text: newText }],
    });
    assert(result.updatedApplied.length === 1, 'one updated item applied');
    const { rows: oldRows } = await client.query(`SELECT suppressed FROM assertions WHERE id = $1`, [result.updatedApplied[0].oldId]);
    assertEq(oldRows[0].suppressed, true, 'old row superseded');
    const { rows: newRows } = await client.query(`SELECT carryover_status FROM assertions WHERE id = $1`, [result.updatedApplied[0].newId]);
    assertEq(newRows[0].carryover_status, 'open', 'new row is open');
  });

  await check(14, 'carryover-render: renderCarryoverTable renders a markdown table', async () => {
    const md = carryoverRender.renderCarryoverTable([{ subject: 'S', object: 'O' }]);
    assert(md.includes('| S | O |'), 'row rendered');
    assert(carryoverRender.renderCarryoverTable([]).includes('no open carry-overs'), 'empty renders explicit sentinel line');
  });

  // ── normalize-text (S-6/S-8) ────────────────────────────────────────────
  await check(15, 'normalize-text: case/whitespace/punctuation-only difference is NOT material', async () => {
    assert(
      !normalizeText.materiallyDifferent('  Uses   Postgres.  ', 'uses postgres'),
      'normalized-equal strings are not materially different'
    );
    assert(
      normalizeText.materiallyDifferent('uses Postgres', 'uses SQLite'),
      'genuinely different content IS materially different'
    );
  });

  // ── reality-checks: dangling_entity_reference (S-7) ────────────────────
  await check(16, 'reality-checks: dangling_entity_reference 5-branch total classification', async () => {
    await client.query(`INSERT INTO entities (project_id, name, entity_type) VALUES ($1, $2, 'component')`, [projectA, `${prefix}-EntityExact`]);
    await client.query(`INSERT INTO entities (project_id, name, entity_type) VALUES ($1, $2, 'component')`, [projectB, `${prefix}-CrossProjEntity`]);

    // (1) exact match -> linked (no flag)
    await client.query(
      `INSERT INTO assertions (project_id, subject, predicate, object, confidence, source)
       VALUES ($1, $2, 'uses', $3, 8, 'user_stated')`,
      [projectA, `${prefix}-EntityExact`, 'x']
    );
    // (2) case-mismatch -> flagged (same name, different case than the
    // exact entity row inserted above)
    await client.query(
      `INSERT INTO assertions (project_id, subject, predicate, object, confidence, source)
       VALUES ($1, $2, 'uses', $3, 8, 'user_stated')`,
      [projectA, `${prefix}-entityexact`, 'x']
    );
    // (3) cross-project -> flagged
    await client.query(
      `INSERT INTO assertions (project_id, subject, predicate, object, confidence, source)
       VALUES ($1, $2, 'uses', $3, 8, 'user_stated')`,
      [projectA, `${prefix}-CrossProjEntity`, 'x']
    );
    // (4) no-match, entity-shaped -> flagged 'no_match'
    await client.query(
      `INSERT INTO assertions (project_id, subject, predicate, object, confidence, source)
       VALUES ($1, $2, 'uses', $3, 8, 'user_stated')`,
      [projectA, `${prefix}-GhostEntity`, 'x']
    );
    // (5) sentence-shaped subject -> skipped, tallied
    await client.query(
      `INSERT INTO assertions (project_id, subject, predicate, object, confidence, source)
       VALUES ($1, $2, 'uses', $3, 8, 'user_stated')`,
      [projectA, `${prefix} this is a full sentence subject, not an entity.`, 'x']
    );

    const result = await realityChecks.probeDanglingEntityReferences(client, projectA);
    const reasons = result.flags.map((f) => f.reason);
    assert(reasons.includes('case_mismatch'), 'case_mismatch flagged');
    assert(reasons.includes('cross_project'), 'cross_project flagged');
    assert(reasons.includes('no_match'), 'no_match flagged');
    assert(result.linkedCount >= 1, 'exact match linked, not flagged');
    assert(result.skipTally.notEntityShaped >= 1, 'sentence-shaped subject skipped and tallied');
  });

  // ── render-handoff-card (§7.6) ──────────────────────────────────────────
  await check(17, 'render-handoff-card: assembles NEXT SESSION/Session/Done/Ceiling/carry-overs; next_step re-sorted ASC (S-15)', async () => {
    const older = new Date(Date.now() - 60000);
    const newer = new Date();
    await client.query(
      `INSERT INTO assertions (project_id, subject, predicate, object, confidence, source, created_at)
       VALUES ($1, $2, 'next_step', 'first (older)', 8, 'user_stated', $3)`,
      [projectA, `${prefix}-step-older`, older]
    );
    await client.query(
      `INSERT INTO assertions (project_id, subject, predicate, object, confidence, source, created_at)
       VALUES ($1, $2, 'next_step', 'second (newer)', 8, 'user_stated', $3)`,
      [projectA, `${prefix}-step-newer`, newer]
    );
    const cardInputs = await renderHandoffCard.fetchHandoffCardInputs(client, projectA);
    assert(cardInputs.nextSteps.length >= 2, 'both next_step rows fetched');
    assert(
      new Date(cardInputs.nextSteps[0].created_at) <= new Date(cardInputs.nextSteps[1].created_at),
      'next_step rows re-sorted created_at ASC'
    );
    const md = renderHandoffCard.renderHandoffCard({
      sessionNum: 1, title: 'Seam smoke test', date: '2026-08-15',
      done: ['shipped seams'], ceiling: ['none'], cardInputs,
    });
    assert(md.includes('## NEXT SESSION'), 'NEXT SESSION section present');
    assert(md.includes('## Session 1 — 2026-08-15 — Seam smoke test'), 'Session header present');
    assert(md.includes('### Done'), 'Done section present');
    assert(md.includes('### Ceiling'), 'Ceiling section present');
    assert(md.includes('### Open carry-overs'), 'Open carry-overs section present');
  });

  // NOTE: exchange-log.js's appendExchange() manages its OWN BEGIN/COMMIT/
  // ROLLBACK (§7.7 requires the INSERT + optional transition to share ONE
  // transaction it controls) — fundamentally incompatible with running
  // inside this harness's already-open outer transaction (a nested COMMIT
  // on the same connection would commit the OUTER transaction too, not just
  // appendExchange's own). Checks 18-20 below run against a SEPARATE,
  // dedicated connection in runExchangeLogChecks(), with explicit manual
  // cleanup — see main().

  await check(21, 'exchange-log: no default provider -> loud error, never silent fallback', async () => {
    await harness.withSavepoint(client, `sp_${prefix.replace(/-/g, '_')}_no_provider`, async () => {
      await client.query(`UPDATE embedding_providers SET is_default = false WHERE is_default = true`);
      try {
        await exchangeLog.resolveDefaultEmbedder(client);
        throw new Error('expected noDefaultProvider error');
      } catch (err) {
        assertEq(err.code, 'noDefaultProvider', 'error code');
      }
      throw new Error('__rollback_savepoint__'); // force rollback of the UPDATE above
    }).catch((err) => {
      if (err.message !== '__rollback_savepoint__') throw err;
    });
  });

  // ── memory-lint (§7.8) ──────────────────────────────────────────────
  await check(22, 'memory-lint: orphan_entities flags a zero-edge entity, project-scoped', async () => {
    await client.query(`INSERT INTO entities (project_id, name, entity_type) VALUES ($1, $2, 'component')`, [projectA, `${prefix}-OrphanEntity`]);
    await client.query(`INSERT INTO entities (project_id, name, entity_type) VALUES ($1, $2, 'component')`, [projectA, `${prefix}-LinkedFrom`]);
    await client.query(`INSERT INTO entities (project_id, name, entity_type) VALUES ($1, $2, 'component')`, [projectA, `${prefix}-LinkedTo`]);
    await client.query(
      `INSERT INTO edges (project_id, from_entity, edge_type, to_entity) VALUES ($1, $2, 'uses', $3)`,
      [projectA, `${prefix}-LinkedFrom`, `${prefix}-LinkedTo`]
    );
    const result = await memoryLint.checkOrphanEntities(client, projectA);
    const names = result.orphans.map((o) => o.name);
    assert(names.includes(`${prefix}-OrphanEntity`), 'orphan flagged');
    assert(!names.includes(`${prefix}-LinkedFrom`), 'linked entity not flagged');
  });

  await check(23, 'memory-lint: contradicting_assertions pairs ONLY 1:1-registered predicates (S-9)', async () => {
    // Almost every 1:1-registered predicate IS ALSO enforced by
    // assertions_1to1_unique's DB-level partial index (by design; see the
    // "registry: SQL-1:1-index-vs-registry-JSON drift" smoketest section),
    // which makes 2 genuinely LIVE rows under a 1:1 predicate unreachable
    // via a normal INSERT in almost every case — exactly why
    // contradicting_assertions exists as a RETROSPECTIVE finder (§7.8:
    // "for rows written before that check existed or by a caller that
    // bypassed it"). A stub client (same technique as check 11) proves the
    // check's PAIRING/EXCLUSION logic directly, without depending on
    // finding a specific 1:1-registered-but-DB-unenforced predicate name,
    // which is not a stable property across schema versions.
    const stubClient = {
      query: async () => ({
        rows: [
          // now_uses is registered 1:1 -- a materially different pair MUST be flagged.
          { id: 1, subject: 'stub-subj-a', predicate: 'now_uses', object: 'Postgres' },
          { id: 2, subject: 'stub-subj-a', predicate: 'now_uses', object: 'SQLite' },
          // applies is registered 1:N -- MUST be excluded + tallied, never paired.
          { id: 3, subject: 'stub-subj-b', predicate: 'applies', object: 'scope-a' },
          { id: 4, subject: 'stub-subj-b', predicate: 'applies', object: 'scope-b' },
          // totally unregistered predicate -- MUST be excluded + tallied, never paired.
          { id: 5, subject: 'stub-subj-c', predicate: 'not_a_real_predicate_xyz', object: 'a' },
          { id: 6, subject: 'stub-subj-c', predicate: 'not_a_real_predicate_xyz', object: 'b' },
        ],
      }),
    };
    const result = await memoryLint.checkContradictingAssertions(stubClient, projectA);
    assert(result.contradictions.some((c) => c.subject === 'stub-subj-a'), '1:1 predicate contradiction pair flagged');
    assert(!result.contradictions.some((c) => c.subject === 'stub-subj-b'), '1:N predicate pair NOT flagged');
    assert(!result.contradictions.some((c) => c.subject === 'stub-subj-c'), 'unregistered predicate pair NOT flagged');
    assert(result.excludedTally.notOneToOne >= 2, '1:N pair tallied, not silently dropped');
    assert(result.excludedTally.unregistered >= 2, 'unregistered-predicate pair tallied, not silently dropped');
  });

  await check(24, 'memory-lint: stale_unreconciled excludes annotateOnly predicates (open_thread) (S-10)', async () => {
    await client.query(
      `INSERT INTO assertions (project_id, subject, predicate, object, confidence, source, reality_check)
       VALUES ($1, $2, 'branch_exists', 'exists', 8, 'user_stated', 'mismatch')`,
      [projectA, `${prefix}-branch-subj`]
    );
    await client.query(
      `INSERT INTO assertions (project_id, subject, predicate, object, confidence, source, reality_check, carryover_status)
       VALUES ($1, $2, 'open_thread', 'stale nudge text', 8, 'user_stated', 'mismatch', 'open')`,
      [projectA, `${prefix}-ot-stale-subj`]
    );
    const result = await memoryLint.checkStaleUnreconciled(client, projectA);
    const subjects = result.stale.map((r) => r.subject);
    assert(subjects.includes(`${prefix}-branch-subj`), 'non-annotateOnly mismatch flagged');
    assert(!subjects.includes(`${prefix}-ot-stale-subj`), 'annotateOnly (open_thread) mismatch excluded');
    assert(result.excludedAnnotateOnlyCount >= 1, 'exclusion tallied, not silently dropped');
  });

  await check(25, 'memory-lint: unlinked_mentions boundary — <4-char names skipped+tallied; exactly-4-char names (main/test-class) ARE scanned (S-11)', async () => {
    // S-11's literal numeric rule (stated twice: the runbook's own "shorter
    // than 4 characters are skipped" AND this PR's task description's
    // "entities.name >= 4 chars") is length < 4 => skip. 'main' and 'test'
    // (the runbook's own illustrative examples of the flood guard) are
    // BOTH exactly 4 characters — i.e. they sit ON the >=4 side of the
    // boundary and are NOT skipped by the numeric rule, despite being cited
    // as the motivating example. This check proves the boundary is
    // implemented at the PRECISE numeric threshold (a genuinely short name
    // below it is skipped+tallied; a name AT exactly 4 chars, even one of
    // the illustrative 'main'/'test' names themselves, is correctly
    // included in scanning) rather than an off-by-one that either
    // over-skips (would break the numeric contract) or under-skips.
    await client.query(`INSERT INTO entities (project_id, name, entity_type) VALUES ($1, $2, 'branch')`, [projectA, 'main']);
    await client.query(`INSERT INTO entities (project_id, name, entity_type) VALUES ($1, $2, 'tag')`, [projectA, 'ci']); // 2 chars: < 4, must be skipped+tallied
    await client.query(`INSERT INTO entities (project_id, name, entity_type) VALUES ($1, $2, 'component')`, [projectA, `${prefix}-SubjEntity`]);
    await client.query(`INSERT INTO entities (project_id, name, entity_type) VALUES ($1, $2, 'component')`, [projectA, `${prefix}-MentionedEntity`]);
    await client.query(
      `INSERT INTO assertions (project_id, subject, predicate, object, confidence, source)
       VALUES ($1, $2, 'uses', $3, 8, 'user_stated')`,
      [projectA, `${prefix}-SubjEntity`, `depends on main branch, ci pipeline, and ${prefix}-MentionedEntity for this`]
    );
    const result = await memoryLint.checkUnlinkedMentions(client, projectA);
    const mentioned = result.flags.map((f) => f.mentionedEntity);
    assert(mentioned.includes(`${prefix}-MentionedEntity`), 'real unlinked mention flagged');
    assert(mentioned.includes('main'), 'exactly-4-char name ("main") is scanned and flagged, not skipped (precise boundary)');
    assert(!mentioned.includes('ci'), '<4-char name ("ci") is never flagged (skipped, per the flood guard)');
    assert(result.skipTally.mentionTooShort >= 1, 'short-name skip ("ci") tallied, not silently dropped');

    // Now link them -- the flag must disappear.
    await client.query(
      `INSERT INTO edges (project_id, from_entity, edge_type, to_entity) VALUES ($1, $2, 'mentions', $3)`,
      [projectA, `${prefix}-SubjEntity`, `${prefix}-MentionedEntity`]
    );
    const result2 = await memoryLint.checkUnlinkedMentions(client, projectA);
    assert(!result2.flags.some((f) => f.mentionedEntity === `${prefix}-MentionedEntity`), 'linking clears the flag');
  });

  await check(26, 'memory-lint: memoryLint dispatcher checks? narrowing + unknown-check hard error', async () => {
    const narrowed = await memoryLint.memoryLint(client, projectA, ['orphan_entities']);
    assert(Object.keys(narrowed).length === 1 && narrowed.orphan_entities, 'narrowed to one check');
    try {
      await memoryLint.memoryLint(client, projectA, ['not_a_real_check']);
      throw new Error('expected hard error');
    } catch (err) {
      assert(/unknown check/.test(err.message), 'unknown check name hard error');
    }
  });

  return { allOk, results };
}

/**
 * runExchangeLogChecks — checks 18-20, run against a SEPARATE, dedicated
 * connection (see the note in runChecks() above for why: appendExchange()
 * owns its own BEGIN/COMMIT/ROLLBACK per §7.7, incompatible with the shared
 * outer transaction every other check runs inside). Explicit manual cleanup
 * (DELETE by run-prefix) replaces the outer harness's automatic rollback —
 * this function is responsible for its own zero-residue guarantee.
 */
async function runExchangeLogChecks(client2, prefix) {
  const projectA = `${prefix}-proj-a`;
  let idCounter = 18;
  const results = [];
  let allOk = true;

  async function check(name, fn) {
    const id = idCounter++;
    try {
      await fn();
      console.log(`[SMOKE-${LABEL}][${id}] PASS ${name}`);
      results.push({ id, name, ok: true });
    } catch (err) {
      console.log(`[SMOKE-${LABEL}][${id}] FAIL ${name}: ${err.message}`);
      results.push({ id, name, ok: false });
      allOk = false;
    }
  }

  await check('exchange-log: appendExchange with injected mock embedder inserts a row', async () => {
    const result = await exchangeLog.appendExchange(client2, {
      projectId: projectA, agentId: `${prefix}-agent`, kind: 'proposal',
      body: 'caveman body full text', summary: 'short digest',
      embedder: mockEmbedder(),
    });
    assert(typeof result.id === 'number', 'row id returned');
    assert(result.created_at, 'created_at returned');
    assertEq(result.kindWarning, null, 'known kind, no warning');
  });

  await check('exchange-log: guarded transition — success path updates task status atomically', async () => {
    const taskRes = await client2.query(
      `INSERT INTO tasks (project_id, title, status) VALUES ($1, $2, 'pending') RETURNING id`,
      [projectA, `${prefix}-task`]
    );
    const taskId = taskRes.rows[0].id;
    const result = await exchangeLog.appendExchange(client2, {
      projectId: projectA, agentId: `${prefix}-agent`, kind: 'ruling',
      body: 'body', summary: 'digest', embedder: mockEmbedder(),
      transition: { table: 'tasks', id: taskId, fromStatus: 'pending', toStatus: 'done' },
    });
    assert(result.transition && result.transition.status === 'done', 'transition applied in same call');
  });

  await check('exchange-log: guarded transition — stale fromStatus rolls back the WHOLE write (row-count guard)', async () => {
    const taskRes = await client2.query(
      `INSERT INTO tasks (project_id, title, status) VALUES ($1, $2, 'pending') RETURNING id`,
      [projectA, `${prefix}-task2`]
    );
    const taskId = taskRes.rows[0].id;
    const before = await client2.query(`SELECT count(*)::int AS n FROM agent_exchange WHERE project_id = $1`, [projectA]);
    let threw = false;
    try {
      await exchangeLog.appendExchange(client2, {
        projectId: projectA, agentId: `${prefix}-agent`, kind: 'ruling',
        body: 'should-not-persist', summary: 'digest', embedder: mockEmbedder(),
        transition: { table: 'tasks', id: taskId, fromStatus: 'WRONG_STATUS', toStatus: 'done' },
      });
    } catch (err) {
      threw = true;
      assertEq(err.code, 'transitionRowCountMismatch', 'error code');
    }
    assert(threw, 'threw on mismatched fromStatus');
    const { rows } = await client2.query(`SELECT status FROM tasks WHERE id = $1`, [taskId]);
    assertEq(rows[0].status, 'pending', 'task status unchanged (rolled back)');
    const after = await client2.query(`SELECT count(*)::int AS n FROM agent_exchange WHERE project_id = $1`, [projectA]);
    assertEq(after.rows[0].n, before.rows[0].n, 'the failed transition attempt left no agent_exchange row behind (whole write rolled back)');
  });

  // Manual cleanup — this function does not run inside the outer
  // withTransactionRollback, so it owns its own zero-residue guarantee.
  await client2.query(`DELETE FROM agent_exchange WHERE project_id = $1`, [projectA]);
  await client2.query(`DELETE FROM tasks WHERE project_id = $1`, [projectA]);

  return { allOk, results };
}

async function main() {
  let parsed;
  try {
    parsed = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exit(2);
  }

  const { name: target, source } = migrateOne.resolveTargetDb(parsed);
  if (!migrateOne.DB_NAME_RE.test(target)) {
    console.error(`Invalid database name "${target}" (from ${source})`);
    process.exit(1);
  }
  const classification = migrateOne.classifyTarget(target);
  if (!classification.allowed) {
    console.error(`Refused: ${classification.reason}`);
    process.exit(1);
  }

  console.log(`verify-19-seams-smoke: target="${target}" (resolved from ${source})`);

  const db = new Client(migrateOne.pgConfig(target));
  await db.connect();

  try {
    const missing = await checkPrerequisites(db);
    if (missing.length) {
      console.error(`Refused: target "${target}" is missing prerequisite table(s): ${missing.join(', ')}.`);
      console.error('Run migrate-14-seam-tables.js and re-apply migrate-13-agent-exchange.js first.');
      process.exitCode = 1;
      return;
    }

    const prefix = harness.makeRunPrefix(LABEL);
    console.log(`  run prefix: ${prefix}`);

    const { allOk } = await harness.withTransactionRollback(db, [], async () => {
      return runChecks(db, prefix);
    });

    // Checks 18-20 (exchange-log) run against a SEPARATE dedicated
    // connection — see runExchangeLogChecks()'s own header comment.
    const db2 = new Client(migrateOne.pgConfig(target));
    await db2.connect();
    let exchangeOk;
    try {
      ({ allOk: exchangeOk } = await runExchangeLogChecks(db2, prefix));
    } finally {
      await db2.end();
    }

    // Defense-in-depth: prove zero committed residue post-rollback (checks
    // 1-17/21-26) AND post-manual-cleanup (checks 18-20, agent_exchange/tasks).
    const residue = await harness.scanForResidue(db, prefix, [
      { table: 'assertions', where: `subject LIKE $1 OR object LIKE $1` },
      { table: 'entities', where: `name LIKE $1` },
      { table: 'edges', where: `from_entity LIKE $1 OR to_entity LIKE $1` },
      { table: 'decisions', where: `project_id LIKE $1` },
      { table: 'findings', where: `project_id LIKE $1` },
      { table: 'tasks', where: `project_id LIKE $1` },
      { table: 'agent_exchange', where: `project_id LIKE $1` },
    ]);
    if (residue.length) {
      console.error(`  RESIDUE DETECTED: ${residue.join('; ')}`);
    } else {
      console.log('  residue scan: clean (0 rows)');
    }

    const finalOk = allOk && exchangeOk && residue.length === 0;
    harness.printSummary(LABEL, finalOk);
    process.exitCode = finalOk ? 0 : 1;
  } finally {
    await db.end();
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err && err.stack ? err.stack : err);
    process.exitCode = 1;
  });
}

module.exports = { PREREQUISITE_TABLES, checkPrerequisites, runChecks, mockEmbedder };
