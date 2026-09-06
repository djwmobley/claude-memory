'use strict';

const AUTHORED_BY = 'sonnet-t-battery-author-2026-07-27';

/**
 * verify-15-acceptance.js — T10, acceptance gate (go/no-go), §15.2.
 *
 * Runs every verify-15-t*.js / verify-15-freeze-precondition.js check as a
 * CHILD PROCESS (node, spawn WITHOUT shell:true — this is the ONE script in
 * this battery permitted to use child_process, per this repo's
 * os-portability convention; every other verify-15-*.js script is pure
 * pg-client, in-process only), aggregates their exit codes, and prints the
 * REVISED T10 go/no-go checklist (§15.2) verbatim in structure — including
 * the sub-lines (T1 freeze precondition, T2/T3 final-pre-promotion-re-run
 * lines, T2.5's N/A branch, T4's evidence sub-line, F1-F4).
 *
 * T1 itself is NOT spawned here as "run the snapshot" — verify-15-t1-
 * snapshot.js requires a --source-db argument this aggregator has no single
 * correct value for (T1 runs once per source, not once per acceptance
 * pass). Per §15.3's own script list, the aggregator instead performs a
 * lightweight T1 PRESENCE check in-process: migration_manifest has >=1 row.
 * This is weaker than "T0-verified, not self-referential" (T0, run
 * separately, IS that verification) — documented, not silently substituted.
 *
 * Independence cross-check (§15.2, V-6): every containment_evidence row's
 * recorded_by is compared against harness-authorship.json's AUTHORED_BY
 * values. recorded_by equal to ANY script's AUTHORED_BY constant is a T10
 * FAILURE for that line — sign-off independence is machine-checked here,
 * not merely trusted to a human's memory.
 *
 * F1-F4 (§15.2.1's 4-part functional acceptance test) are NOT implemented
 * by this battery — they require live multi-model/multi-provider harness
 * pieces (§9.5's headless-CLI adapter, §17/§18's routing+telemetry, the
 * fat-card renderer) that are out of THIS task's scope. Their T10 lines are
 * printed explicitly as "NOT RUN — out of this T-battery's scope", never
 * silently omitted (an omitted line and a forgotten one look identical on
 * the page, per §15.2's own framing).
 *
 * Usage:
 *   node scripts/migrations/verify-15-acceptance.js --db <target> --recorded-by <id> [--t8-rerun-module <path>]
 * Exit codes: 0 = every implemented check PASS (or legitimate N/A), and the
 * recorded_by independence cross-check found no violation; 1 = any FAIL.
 */

const path = require('path');
const { spawn } = require('child_process');
const shared = require('./lib/verify15-shared');

const MIGRATIONS_DIR = shared.MIGRATIONS_DIR;

function spawnCheck(scriptFile, args) {
  return new Promise((resolve) => {
    const scriptPath = path.join(MIGRATIONS_DIR, scriptFile);
    const child = spawn(process.execPath, [scriptPath, ...args], { shell: false });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; process.stdout.write(d); });
    child.stderr.on('data', (d) => { stderr += d; process.stderr.write(d); });
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

function parseFlags(argv) {
  const parsed = { recordedBy: null, t8RerunModule: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--recorded-by') parsed.recordedBy = argv[++i];
    else if (argv[i].startsWith('--recorded-by=')) parsed.recordedBy = argv[i].slice('--recorded-by='.length);
    else if (argv[i] === '--t8-rerun-module') parsed.t8RerunModule = argv[++i];
    else if (argv[i].startsWith('--t8-rerun-module=')) parsed.t8RerunModule = argv[i].slice('--t8-rerun-module='.length);
  }
  return parsed;
}

async function checkT1Presence(target) {
  const client = await shared.connect(target);
  try {
    await shared.applyDdl(client);
    const { rows } = await client.query('SELECT COUNT(*) AS n FROM migration_manifest');
    const n = Number(rows[0].n);
    return { pass: n > 0, count: n };
  } finally {
    await client.end();
  }
}

async function checkRecordedByIndependence(target) {
  const authorship = shared.loadHarnessAuthorship();
  const authoredByValues = new Set(Object.values(authorship).map((v) => v.AUTHORED_BY));
  const client = await shared.connect(target);
  try {
    const { rows } = await client.query(`SELECT id, check_id, recorded_by FROM containment_evidence ORDER BY id`);
    const violations = rows.filter((r) => authoredByValues.has(r.recorded_by));
    return { pass: violations.length === 0, violations, totalEvidenceRows: rows.length };
  } finally {
    await client.end();
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const { name: target, source } = await shared.resolveAndClassifyTargetDb(argv);
  const { recordedBy, t8RerunModule } = parseFlags(argv);
  console.log(`verify-15-acceptance: target="${target}" (resolved from ${source})`);

  const results = {};

  results.t0 = await spawnCheck('verify-15-t0-roster.js', ['--db', target]);
  results.rosterCompleteness = await spawnCheck('verify-15-t0-roster-completeness.js', []);
  results.freezePrecondition = await spawnCheck('verify-15-freeze-precondition.js', []);

  let t1Presence;
  try {
    t1Presence = await checkT1Presence(target);
  } catch (err) {
    t1Presence = { pass: false, error: err.message };
  }

  results.t2 = await spawnCheck('verify-15-t2-rowcount.js', ['--db', target]);
  results.t25 = await spawnCheck('verify-15-t2-5-dualwrite.js', ['--db', target]);
  results.t3 = await spawnCheck('verify-15-t3-content-hash.js', ['--db', target]);
  results.t3b = await spawnCheck('verify-15-t3b-reverse-containment.js', ['--db', target]);

  const t4Args = ['--db', target];
  if (recordedBy) t4Args.push('--recorded-by', recordedBy);
  results.t4 = await spawnCheck('verify-15-t4-recall-equivalence.js', t4Args);

  results.t5 = await spawnCheck('verify-15-t5-embedding-coverage.js', ['--db', target]);
  results.t6 = await spawnCheck('verify-15-t6-referential-integrity.js', ['--db', target]);
  results.t7 = await spawnCheck('verify-15-t7-caveman-economy.js', ['--db', target]);

  const t8Args = ['--db', target];
  if (t8RerunModule) t8Args.push('--rerun-module', t8RerunModule);
  results.t8 = await spawnCheck('verify-15-t8-idempotency.js', t8Args);

  results.t9 = await spawnCheck('verify-15-t9-negative.js', ['--db', target]);

  let independence;
  try {
    independence = await checkRecordedByIndependence(target);
  } catch (err) {
    independence = { pass: false, error: err.message };
  }

  // ── T10 checklist (§15.2, printed verbatim in structure) ───────────────

  const t25Na = /\[T2\.5\] N\/A/.test(results.t25.stdout);
  const p = (r) => r.status === 0;

  const lines = [];
  const mark = (ok) => (ok ? '[x]' : '[ ]');

  lines.push(`## §15.2 acceptance checklist — scope: staging (${target})`);
  lines.push(`- ${mark(p(results.t0))} T0    roster totality: every source-table-roster.json (source_db, source_table) pair has ≥1 migration_manifest row`);
  lines.push(`- ${mark(p(results.rosterCompleteness))} T0-completeness roster vs inventory-manifest.json cross-reference (both directions)`);
  lines.push(`- ${mark(t1Presence.pass)} T1    migration_manifest populated for every in-scope source table (T0-verified, not self-referential — presence check only; see header note)`);
  lines.push(`- ${mark(p(results.freezePrecondition))}   T1 precondition — freeze enforcement verified (REVOKE / default_transaction_read_only probe rejected a live write attempt, §15.1)`);
  lines.push(`- ${mark(p(results.t2))} T2    row-count reconciliation: zero diff (expected_exclusions computed from row_count, not manifest-row COUNT(*))`);
  lines.push(`- [ ]   T2 final pre-promotion re-run: NOT RUN by this invocation — run verify-15-t2-rowcount.js again immediately before promotion (§15.1)`);
  lines.push(`- ${mark(t25Na || p(results.t25))} T2.5  dual-write shim reconciliation — MANDATORY iff dual_write_shim_window has any row; else marked N/A explicitly`);
  lines.push(`- ${mark(p(results.t3))} T3    content-hash reconciliation (forward, source⊆target): zero-row set-difference`);
  lines.push(`- [ ]   T3 final pre-promotion re-run: NOT RUN by this invocation — run verify-15-t3-content-hash.js again immediately before promotion (§15.1)`);
  lines.push(`- ${mark(p(results.t3b))} T3b   reverse containment (target⊆source) + total-rowcount across ALL target project_ids: zero-row set-difference`);
  lines.push(`- ${mark(p(results.t4))} T4    recall-equivalence: 100% load-bearing-fact match; fixture coverage traceable; cross-project isolation holds`);
  lines.push(`- ${mark(p(results.t4) && independence.pass)}   T4 evidence — fixture-coverage precondition backed by ≥1 referenced containment_evidence row (check_id='T4'), recorded_by independence verified`);
  lines.push(`- ${mark(p(results.t5))} T5    embedding coverage: 100%; table list GENERATED from roster; zero legacy vector(1024) rows remain`);
  lines.push(`- ${mark(p(results.t6))} T6    referential integrity: zero orphans; project_id NOT NULL holds on every roster-scoped table, INCLUDING tables missing the column entirely`);
  lines.push(`- ${mark(p(results.t7))} T7    caveman-economy gate: pass (see header note — prerequisite §3.5 store-wide gate not yet built in this repo; T7 FAILs loud until it lands)`);
  lines.push(`- ${mark(p(results.t8))} T8    idempotency: zero net change on re-run; T6 re-run clean as part of T8's own pass`);
  lines.push(`- ${mark(p(results.t9))} T9    negative tests: zero leakage, looped over EVERY distinct excluded_reason × every table with manifest rows in that scope`);
  lines.push(`- [ ] F1-F4  §15.2.1's 4-part functional acceptance test — NOT RUN: out of this T-battery's scope (requires live multi-provider/routing/telemetry harness pieces not built by this task)`);

  console.log('\n' + lines.join('\n') + '\n');

  if (!independence.pass) {
    console.error(`[T10] INDEPENDENCE VIOLATION: ${independence.violations.length} containment_evidence row(s) have recorded_by equal to a harness-authoring agent_id:`);
    for (const v of independence.violations) console.error(`  - id=${v.id} check_id=${v.check_id} recorded_by=${v.recorded_by}`);
  } else if (independence.error) {
    console.error(`[T10] independence cross-check errored: ${independence.error}`);
  } else {
    console.log(`[T10] independence cross-check OK: ${independence.totalEvidenceRows} containment_evidence row(s) checked, zero violations.`);
  }

  const implementedChecks = [
    results.t0, results.rosterCompleteness, results.freezePrecondition,
    results.t2, results.t3, results.t3b, results.t4, results.t5, results.t6,
    results.t7, results.t8, results.t9,
  ];
  const t25Ok = t25Na || p(results.t25);
  const allPass = implementedChecks.every(p) && t1Presence.pass && t25Ok && independence.pass;

  console.log(`\nACCEPTANCE_RESULT: ${allPass ? 'GREEN (implemented checks only — F1-F4 and final pre-promotion re-runs NOT covered by a single invocation)' : 'RED'}`);
  process.exit(allPass ? 0 : 1);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err && err.stack ? err.stack : err);
    process.exit(1);
  });
}

module.exports = { AUTHORED_BY, spawnCheck, checkT1Presence, checkRecordedByIndependence };
