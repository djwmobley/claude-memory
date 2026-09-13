'use strict';

/**
 * test-mcp-epoch-guard.js — fix/mcp-stale-engine-gate.
 *
 * PROBLEM this closes: scripts/handoff-mcp.mjs's withProjectDb emitted the
 * SAME "run `node scripts/handoff.js init` (or `resume`)" remedy for every
 * ensureSchemaCurrent heal failure, including reason 'ahead' (the
 * DATABASE's stored schema epoch newer than what a STALE running server
 * process knows about) — that remedy would have forced a downgrade.
 * scripts/lib/schema-epoch-guard.js replaces the blanket remedy with a
 * total, four-branch classification. See that module's header comment for
 * the full incident writeup and rule set.
 *
 * Coverage map:
 *   T1  stale_engine (loaded 4, disk 5) — message names both epochs.
 *   T2  engine_behind_db (disk 4, db 5, reason 'ahead').
 *   T3  reason 'current' -> proceed (message null).
 *   T4  reason 'apply_failed' -> heal_failed, report-only wording.
 *   T5  stale_engine message names no init/resume subcommand.
 *   T6  engine_behind_db message names no init/resume subcommand.
 *   T7  heal_failed message names no init/resume subcommand.
 *   T8  totality matrix: every combination of loaded/disk/healReason/dbEpoch
 *       maps to exactly one branch (cross-checked against an independently
 *       written reference classifier) and classifyEpochDrift never throws.
 *   T9  readDiskSchemaEpoch: missing file, invalid JSON, non-integer/
 *       fractional/zero/negative schema_epoch -> ok:false; valid -> ok:true.
 *   T10 readDiskSchemaEpoch has no memoization — a rewrite between two calls
 *       is reflected on the very next call.
 *   T11 engine_checkout_inconsistent (loaded 6, disk 5).
 *   T12 a healDetail object naming "init" is redacted (keys preserved, verbs
 *       and remedy text are not) before it reaches the heal_failed message.
 *   T13 live stdio MCP regression: a real handoff-mcp.mjs process, running
 *       from a throwaway copy of the engine whose on-disk schema-manifest.json
 *       is bumped AFTER the server starts (so the server's in-memory
 *       SCHEMA_EPOCH is frozen "stale" relative to its own checkout on
 *       disk), rejects a tool call with the stale_engine message — never
 *       spawns a child, never touches a database. Requires the repo's own
 *       scripts/node_modules to exist (see "Install dependencies" in
 *       .github/workflows/test.yml, working-directory: scripts); SKIPs with
 *       a clear reason if that directory is absent.
 *
 * No live Postgres required — every test here is pure or filesystem-only
 * (T13 spawns a real process but never opens a database connection, since
 * the guard rejects before withProjectDb/runNode's DB-touching paths run).
 * Exit 0 = all run tests passed.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const { readDiskSchemaEpoch, classifyEpochDrift, healFailedMessage } = require(
  path.join(PROJECT_ROOT, 'scripts', 'lib', 'schema-epoch-guard.js')
);
const { copySchemaUnits } = require(path.join(__dirname, 'lib', 'scratch-engine-root.js'));

let passed = 0;
let failed = 0;
let skipped = 0;
const failures = [];
function pass(label) { console.log(`PASS  ${label}`); passed++; }
function fail(label, reason) { console.log(`FAIL  ${label}: ${reason}`); failures.push({ label, reason }); failed++; }
function skip(label, reason) { console.log(`SKIP  ${label} (${reason})`); skipped++; }
function assertEqual(a, b, msg) { if (a !== b) throw new Error(msg || `expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); }
function assertTrue(v, msg) { if (v !== true) throw new Error(msg || `expected true, got ${JSON.stringify(v)}`); }
function assertMatch(str, re, msg) { if (typeof str !== 'string' || !re.test(str)) throw new Error(msg || `expected ${JSON.stringify(str)} to match ${re}`); }
function assertNoMatch(str, re, msg) { if (typeof str === 'string' && re.test(str)) throw new Error(msg || `expected ${JSON.stringify(str)} NOT to match ${re}`); }

// ── T1-T4: named branches on the common shapes ─────────────────────────────

function testT1_StaleEngine() {
  const label = 'T1: stale_engine (loaded 4, disk 5) names both epochs';
  try {
    const result = classifyEpochDrift({ loadedEpoch: 4, diskEpoch: 5 });
    assertEqual(result.branch, 'stale_engine');
    assertMatch(result.message, /loaded schema epoch 4/);
    assertMatch(result.message, /on disk 5/);
    assertMatch(result.message, /restart the mcp server/i);
    pass(label);
  } catch (err) { fail(label, err.message); }
}

function testT2_EngineBehindDb() {
  const label = 'T2: engine_behind_db (disk 4, db 5, reason ahead)';
  try {
    const result = classifyEpochDrift({ loadedEpoch: 4, diskEpoch: 4, healReason: 'ahead', dbEpoch: 5 });
    assertEqual(result.branch, 'engine_behind_db');
    assertMatch(result.message, /engine schema epoch 4/);
    assertMatch(result.message, /database 5/);
    assertMatch(result.message, /refusing to apply a downgrade/i);
    pass(label);
  } catch (err) { fail(label, err.message); }
}

function testT3_ReasonCurrentProceeds() {
  const label = 'T3: reason current -> proceed (message null)';
  try {
    const result = classifyEpochDrift({ loadedEpoch: 5, diskEpoch: 5, healReason: 'current' });
    assertEqual(result.branch, 'proceed');
    assertEqual(result.message, null);
    pass(label);
  } catch (err) { fail(label, err.message); }
}

function testT4_ApplyFailedIsHealFailedReportOnly() {
  const label = 'T4: reason apply_failed -> heal_failed, report-only';
  try {
    const result = classifyEpochDrift({ loadedEpoch: 5, diskEpoch: 5, healReason: 'apply_failed', healDetail: { message: 'ddl boom' } });
    assertEqual(result.branch, 'heal_failed');
    assertMatch(result.message, /reason: apply_failed/);
    assertMatch(result.message, /report-only/i);
    assertMatch(result.message, /needs a maintainer/i);
    pass(label);
  } catch (err) { fail(label, err.message); }
}

// ── T5-T7: no message ever suggests running init/resume ────────────────────
//
// The mandated exact stale_engine message text (see schema-epoch-guard.js's
// header / the PR spec) itself says "...reloads scripts/handoff.js..." —
// naming the FILE being reloaded is correct and expected for that branch,
// so the forbidden pattern here is the SUBCOMMAND verbs "init"/"resume" as
// whole words, not the bare substring "handoff.js" (which would falsely
// flag the mandated stale_engine wording itself). See PR body /
// Deviations-from-spec note for why this is narrower than a literal
// /handoff\.js/ ban would be.
const NAMES_A_SUBCOMMAND = /\b(init|resume)\b/i;

function testT5_StaleEngineNamesNoSubcommand() {
  const label = 'T5: stale_engine message names no init/resume subcommand';
  try {
    const { message } = classifyEpochDrift({ loadedEpoch: 4, diskEpoch: 5 });
    assertNoMatch(message, NAMES_A_SUBCOMMAND);
    pass(label);
  } catch (err) { fail(label, err.message); }
}

function testT6_EngineBehindDbNamesNoSubcommand() {
  const label = 'T6: engine_behind_db message names no init/resume subcommand';
  try {
    const { message } = classifyEpochDrift({ loadedEpoch: 4, diskEpoch: 4, healReason: 'ahead', dbEpoch: 5 });
    assertNoMatch(message, NAMES_A_SUBCOMMAND);
    pass(label);
  } catch (err) { fail(label, err.message); }
}

function testT7_HealFailedNamesNoSubcommand() {
  const label = 'T7: heal_failed message names no init/resume subcommand';
  try {
    const { message } = classifyEpochDrift({ loadedEpoch: 5, diskEpoch: 5, healReason: 'apply_failed', healDetail: { message: 'ddl boom' } });
    assertNoMatch(message, NAMES_A_SUBCOMMAND);
    pass(label);
  } catch (err) { fail(label, err.message); }
}

// ── T8: totality matrix, cross-checked against an independent reference ───

/** Independently re-derived from the SAME ordered rules classifyEpochDrift
 * documents (not a call into that function) — a regression proof that the
 * shipped implementation matches the spec's rule order, not just itself. */
function referenceBranch({ loaded, disk, reason, db }) {
  if (!(Number.isSafeInteger(loaded) && loaded >= 1)) return 'heal_failed';
  if (disk === null || disk === undefined) return 'annotate_only';
  if (loaded < disk) return 'stale_engine';
  if (loaded > disk) return 'engine_checkout_inconsistent';
  if (reason === 'current' || reason === 'applied' || reason === 'degraded' || reason === undefined) return 'proceed';
  if (reason === 'ahead') {
    if (Number.isSafeInteger(db) && db >= 1 && disk < db) return 'engine_behind_db';
    return 'heal_failed';
  }
  return 'heal_failed';
}

const KNOWN_BRANCHES = new Set([
  'stale_engine', 'engine_checkout_inconsistent', 'engine_behind_db',
  'heal_failed', 'proceed', 'annotate_only',
]);
const NULL_MESSAGE_BRANCHES = new Set(['proceed', 'annotate_only']);

function testT8_TotalityMatrix() {
  const label = 'T8: totality matrix (loaded x disk x reason x db) — one branch each, never throws';
  const loadedValues = [null, '5', 5.5, 0, 4, 5, 6];
  const diskValues = [null, 4, 5];
  const reasonValues = [undefined, 'current', 'degraded', 'ahead', 'apply_failed', 'unknown', 'bogus'];
  const dbValues = [null, 5, 6];
  let checked = 0;
  const mismatches = [];
  try {
    for (const loaded of loadedValues) {
      for (const disk of diskValues) {
        for (const reason of reasonValues) {
          for (const db of dbValues) {
            let result;
            try {
              result = classifyEpochDrift({ loadedEpoch: loaded, diskEpoch: disk, healReason: reason, dbEpoch: db, healDetail: { note: 'x' } });
            } catch (err) {
              mismatches.push(`threw for loaded=${JSON.stringify(loaded)} disk=${JSON.stringify(disk)} reason=${JSON.stringify(reason)} db=${JSON.stringify(db)}: ${err.message}`);
              continue;
            }
            checked++;
            if (!KNOWN_BRANCHES.has(result.branch)) {
              mismatches.push(`unknown branch ${result.branch} for loaded=${JSON.stringify(loaded)} disk=${JSON.stringify(disk)} reason=${JSON.stringify(reason)} db=${JSON.stringify(db)}`);
              continue;
            }
            const expected = referenceBranch({ loaded, disk, reason, db });
            if (result.branch !== expected) {
              mismatches.push(`loaded=${JSON.stringify(loaded)} disk=${JSON.stringify(disk)} reason=${JSON.stringify(reason)} db=${JSON.stringify(db)}: got ${result.branch}, expected ${expected}`);
              continue;
            }
            const messageShouldBeNull = NULL_MESSAGE_BRANCHES.has(result.branch);
            if (messageShouldBeNull && result.message !== null) {
              mismatches.push(`${result.branch} should have null message, got ${JSON.stringify(result.message)}`);
            }
            if (!messageShouldBeNull && typeof result.message !== 'string') {
              mismatches.push(`${result.branch} should have a string message, got ${JSON.stringify(result.message)}`);
            }
          }
        }
      }
    }
    if (mismatches.length > 0) {
      fail(label, `${mismatches.length} mismatch(es) of ${checked} checked; first: ${mismatches[0]}`);
      return;
    }
    assertTrue(checked === loadedValues.length * diskValues.length * reasonValues.length * dbValues.length, 'checked every combination');
    pass(`${label} (${checked} combinations)`);
  } catch (err) {
    fail(label, err.message);
  }
}

// ── T9: readDiskSchemaEpoch ──────────────────────────────────────────────

function withScratchManifestDir(fn) {
  const dir = path.join(os.tmpdir(), `epoch-guard-t9-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  fs.mkdirSync(path.join(dir, 'scripts', 'sql'), { recursive: true });
  try {
    return fn(dir, path.join(dir, 'scripts', 'sql', 'schema-manifest.json'));
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_err) { /* best-effort */ }
  }
}

function testT9_ReadDiskSchemaEpoch() {
  const label = 'T9: readDiskSchemaEpoch — missing/invalid/malformed/valid';
  try {
    // Missing file.
    withScratchManifestDir((dir) => {
      const result = readDiskSchemaEpoch(dir);
      assertEqual(result.ok, false, 'missing manifest file must be ok:false');
    });
    // Invalid JSON.
    withScratchManifestDir((dir, manifestPath) => {
      fs.writeFileSync(manifestPath, '{ not json', 'utf8');
      const result = readDiskSchemaEpoch(dir);
      assertEqual(result.ok, false, 'invalid JSON must be ok:false');
    });
    // schema_epoch as a string.
    withScratchManifestDir((dir, manifestPath) => {
      fs.writeFileSync(manifestPath, JSON.stringify({ schema_epoch: '5' }), 'utf8');
      const result = readDiskSchemaEpoch(dir);
      assertEqual(result.ok, false, 'string schema_epoch must be ok:false');
    });
    // schema_epoch fractional.
    withScratchManifestDir((dir, manifestPath) => {
      fs.writeFileSync(manifestPath, JSON.stringify({ schema_epoch: 5.5 }), 'utf8');
      const result = readDiskSchemaEpoch(dir);
      assertEqual(result.ok, false, 'fractional schema_epoch must be ok:false');
    });
    // schema_epoch zero.
    withScratchManifestDir((dir, manifestPath) => {
      fs.writeFileSync(manifestPath, JSON.stringify({ schema_epoch: 0 }), 'utf8');
      const result = readDiskSchemaEpoch(dir);
      assertEqual(result.ok, false, 'zero schema_epoch must be ok:false');
    });
    // schema_epoch negative.
    withScratchManifestDir((dir, manifestPath) => {
      fs.writeFileSync(manifestPath, JSON.stringify({ schema_epoch: -1 }), 'utf8');
      const result = readDiskSchemaEpoch(dir);
      assertEqual(result.ok, false, 'negative schema_epoch must be ok:false');
    });
    // Valid.
    withScratchManifestDir((dir, manifestPath) => {
      fs.writeFileSync(manifestPath, JSON.stringify({ schema_epoch: 5 }), 'utf8');
      const result = readDiskSchemaEpoch(dir);
      assertEqual(result.ok, true, 'valid schema_epoch must be ok:true');
      assertEqual(result.epoch, 5);
      assertTrue(Number.isSafeInteger(result.epoch), 'epoch must be a safe integer');
    });
    pass(label);
  } catch (err) { fail(label, err.message); }
}

function testT10_NoMemoization() {
  const label = 'T10: readDiskSchemaEpoch has no memoization — sees an edit immediately';
  try {
    withScratchManifestDir((dir, manifestPath) => {
      fs.writeFileSync(manifestPath, '{"schema_epoch": 5}', 'utf8');
      const first = readDiskSchemaEpoch(dir);
      assertEqual(first.ok, true);
      assertEqual(first.epoch, 5);
      // Same byte length as the epoch-5 write above (single digit -> single
      // digit) -- proves this isn't passing only because of a size-based
      // staleness heuristic; there IS no such heuristic (no memoization at
      // all), but this keeps the regression proof honest either way.
      const rewritten = '{"schema_epoch": 6}';
      assertEqual(rewritten.length, '{"schema_epoch": 5}'.length, 'test fixture must preserve byte length');
      fs.writeFileSync(manifestPath, rewritten, 'utf8');
      const second = readDiskSchemaEpoch(dir);
      assertEqual(second.ok, true);
      assertEqual(second.epoch, 6, 'must reflect the rewrite on the very next call');
    });
    pass(label);
  } catch (err) { fail(label, err.message); }
}

// ── T11: engine_checkout_inconsistent ───────────────────────────────────

function testT11_EngineCheckoutInconsistent() {
  const label = 'T11: engine_checkout_inconsistent (loaded 6, disk 5)';
  try {
    const result = classifyEpochDrift({ loadedEpoch: 6, diskEpoch: 5 });
    assertEqual(result.branch, 'engine_checkout_inconsistent');
    assertMatch(result.message, /declares schema epoch 6/);
    assertMatch(result.message, /declares 5/);
    assertMatch(result.message, /broken or half-updated/i);
    pass(label);
  } catch (err) { fail(label, err.message); }
}

// ── T12: detail redaction ────────────────────────────────────────────────

function testT12_DetailRedaction() {
  const label = 'T12: healDetail naming "init" is redacted (keys kept, remedy text is not)';
  try {
    const detail = { message: 'try node scripts/handoff.js init to fix this', code: 'X1' };
    const { message } = classifyEpochDrift({ loadedEpoch: 5, diskEpoch: 5, healReason: 'apply_failed', healDetail: detail });
    assertMatch(message, /"redacted":true/);
    assertMatch(message, /"keys":\["message","code"\]/);
    assertNoMatch(message, /try node scripts\/handoff\.js init/);
    // Also exercise healFailedMessage directly (the same function
    // classifyEpochDrift uses internally — no second implementation).
    const direct = healFailedMessage('apply_failed', detail);
    assertMatch(direct, /"redacted":true/);
    assertNoMatch(direct, /try node scripts\/handoff\.js init/);
    // A detail that does NOT name init/resume passes through unredacted.
    const cleanDetail = { message: 'ddl failed', code: 'X2' };
    const cleanMsg = healFailedMessage('apply_failed', cleanDetail);
    assertMatch(cleanMsg, /"message":"ddl failed"/);
    pass(label);
  } catch (err) { fail(label, err.message); }
}

// ── T13: live stdio MCP regression ──────────────────────────────────────

/**
 * Builds a throwaway, fully self-contained copy of the engine (handoff.js,
 * handoff-mcp.mjs, the whole scripts/lib tree, and a scripts/sql tree
 * derived from the real required_roster via copySchemaUnits) under a temp
 * directory, with scripts/node_modules SYMLINKED (junction on Windows, a
 * normal symlink elsewhere — `fs.symlinkSync`'s `type` argument is ignored
 * on non-Windows platforms) back to the real scripts/node_modules rather
 * than copied (fast, and avoids drifting from the real dependency tree).
 * Every relative require() in both files stays inside `./` or `./lib/`
 * (verified by inspection — see the PR body) so this copy is a complete,
 * runnable engine on its own.
 */
function buildScratchEngineCopy() {
  const scratchRoot = path.join(os.tmpdir(), `epoch-guard-t13-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  const scratchScripts = path.join(scratchRoot, 'scripts');
  fs.mkdirSync(scratchScripts, { recursive: true });
  fs.copyFileSync(path.join(PROJECT_ROOT, 'scripts', 'handoff.js'), path.join(scratchScripts, 'handoff.js'));
  fs.copyFileSync(path.join(PROJECT_ROOT, 'scripts', 'handoff-mcp.mjs'), path.join(scratchScripts, 'handoff-mcp.mjs'));
  fs.cpSync(path.join(PROJECT_ROOT, 'scripts', 'lib'), path.join(scratchScripts, 'lib'), { recursive: true });
  copySchemaUnits(PROJECT_ROOT, scratchRoot);
  const nodeModulesSrc = path.join(PROJECT_ROOT, 'scripts', 'node_modules');
  fs.symlinkSync(nodeModulesSrc, path.join(scratchScripts, 'node_modules'), 'junction');
  return { scratchRoot, scratchScripts, manifestPath: path.join(scratchScripts, 'sql', 'schema-manifest.json') };
}

async function connectMcp(serverPath) {
  const { Client: SdkClient } = require(
    path.join(PROJECT_ROOT, 'scripts', 'node_modules', '@modelcontextprotocol', 'sdk', 'dist', 'cjs', 'client', 'index.js')
  );
  const { StdioClientTransport } = require(
    path.join(PROJECT_ROOT, 'scripts', 'node_modules', '@modelcontextprotocol', 'sdk', 'dist', 'cjs', 'client', 'stdio.js')
  );
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverPath],
    env: { ...process.env },
  });
  const client = new SdkClient({ name: 'test-mcp-epoch-guard', version: '0.1.0' }, { capabilities: {} });
  await client.connect(transport);
  return client;
}

async function testT13_LiveStdioStaleEngine() {
  const label = 'T13: live stdio MCP — stale-engine server rejects with stale_engine message';
  const nodeModulesDir = path.join(PROJECT_ROOT, 'scripts', 'node_modules');
  if (!fs.existsSync(nodeModulesDir)) {
    skip(label, 'scripts/node_modules absent — run `pnpm install --frozen-lockfile` in scripts/ first (see .github/workflows/test.yml\'s "Install dependencies" step)');
    return;
  }
  let scratch = null;
  let client = null;
  try {
    scratch = buildScratchEngineCopy();
    client = await connectMcp(path.join(scratch.scratchScripts, 'handoff-mcp.mjs'));

    // The server just required scratch handoff.js — its in-memory
    // SCHEMA_EPOCH is now frozen at whatever the real repo's SCHEMA_EPOCH
    // is (copied verbatim). Bump the ON-DISK copy's schema_epoch by 1 AFTER
    // the server has started, so the running process is now "stale"
    // relative to its OWN checkout on disk — exactly the incident shape.
    const manifest = JSON.parse(fs.readFileSync(scratch.manifestPath, 'utf8'));
    const loadedEpoch = manifest.schema_epoch;
    manifest.schema_epoch = loadedEpoch + 1;
    fs.writeFileSync(scratch.manifestPath, JSON.stringify(manifest, null, 2), 'utf8');

    const res = await client.callTool({
      name: 'handoff_status',
      arguments: { projectRoot: PROJECT_ROOT },
    });
    if (!res.isError) {
      fail(label, `expected an isError tool result, got success: ${JSON.stringify(res).slice(0, 300)}`);
      return;
    }
    const text = res.content && res.content[0] && res.content[0].text;
    assertMatch(text, /stale engine build/i);
    assertMatch(text, new RegExp(`loaded schema epoch ${loadedEpoch}`));
    assertMatch(text, new RegExp(`on disk ${loadedEpoch + 1}`));
    pass(label);
  } catch (err) {
    fail(label, err.message);
  } finally {
    if (client) { try { await client.close(); } catch (_err) { /* best-effort */ } }
    if (scratch) { try { fs.rmSync(scratch.scratchRoot, { recursive: true, force: true }); } catch (_err) { /* best-effort */ } }
  }
}

// ── Main ─────────────────────────────────────────────────────────────────

async function main() {
  console.log('=== test-mcp-epoch-guard.js (fix/mcp-stale-engine-gate) ===');
  testT1_StaleEngine();
  testT2_EngineBehindDb();
  testT3_ReasonCurrentProceeds();
  testT4_ApplyFailedIsHealFailedReportOnly();
  testT5_StaleEngineNamesNoSubcommand();
  testT6_EngineBehindDbNamesNoSubcommand();
  testT7_HealFailedNamesNoSubcommand();
  testT8_TotalityMatrix();
  testT9_ReadDiskSchemaEpoch();
  testT10_NoMemoization();
  testT11_EngineCheckoutInconsistent();
  testT12_DetailRedaction();
  await testT13_LiveStdioStaleEngine();

  console.log('');
  console.log(`Results: ${passed} passed, ${failed} failed, ${skipped} skipped`);
  if (failures.length > 0) {
    console.log('\nFailures:');
    for (const f of failures) console.log(`  FAIL  ${f.label}: ${f.reason}`);
    process.exit(1);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error('Unexpected error:', err.stack || err.message);
  process.exit(1);
});
