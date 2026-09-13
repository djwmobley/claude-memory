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
 *       (disk now including malformed values — NaN/fractional/string/
 *       negative/Infinity, not just null/undefined) maps to exactly one
 *       branch (cross-checked against an independently written reference
 *       classifier) and classifyEpochDrift never throws.
 *   T8b non-serializable healDetail (a top-level BigInt field, a circular
 *       object) never throws and still returns a string message; malformed
 *       disk epochs re-checked in isolation for both a pre-heal
 *       (annotate_only) and post-heal (heal_failed, never proceed) call.
 *   T9  readDiskSchemaEpoch: missing file, invalid JSON, non-integer/
 *       fractional/zero/negative schema_epoch -> ok:false; valid -> ok:true.
 *   T10 readDiskSchemaEpoch has no memoization — a rewrite between two calls
 *       is reflected on the very next call.
 *   T11 engine_checkout_inconsistent (loaded 6, disk 5).
 *   T12 a healDetail object naming "init"/"resume" — in its value, in a KEY
 *       name (including a key that IS exactly "init"), split across an
 *       escaped newline or a REAL form-feed/vertical-tab/NBSP character, in
 *       a toJSON() return value (not just the object's own raw properties),
 *       or nested inside a child object — is redacted to the bare
 *       `{redacted:true}` stub (no key list, no fragment of the original
 *       content survives a match) before it reaches the heal_failed message.
 *   T13 live stdio MCP regression: a real handoff-mcp.mjs process, running
 *       from a throwaway copy of the engine whose on-disk schema-manifest.json
 *       is bumped AFTER the server starts (so the server's in-memory
 *       SCHEMA_EPOCH is frozen "stale" relative to its own checkout on
 *       disk), rejects a tool call with the stale_engine message — never
 *       spawns a child, never touches a database (proven by pointing the
 *       call's projectRoot at a fixture whose own .claude/pipeline.yml
 *       targets an unreachable host:port, then asserting the response
 *       carries no pg-connection-error vocabulary). The child's own env is
 *       built explicitly with CLAUDE_PLUGIN_ROOT/HANDOFF_MCP_ENGINE_PATH
 *       stripped, so this test process's own ambient overrides (if any)
 *       can never point the guard at a checkout other than the scratch copy
 *       this test just built and is about to bump. Requires the repo's own
 *       scripts/node_modules to exist (see "Install dependencies" in
 *       .github/workflows/test.yml, working-directory: scripts); SKIPs with
 *       a clear reason if that directory is absent.
 *   T13b same stale-engine scratch setup as T13, but calls a DIRECT-PG (§8
 *       withProjectDb) tool, assertion_read, instead of a spawn-based one —
 *       T13 alone never proved withProjectDb's own call-site-1 guard runs,
 *       since handoff_status never calls withProjectDb/connectForRoot.
 *   T13c a HANDOFF_MCP_ENGINE_PATH override whose schema-manifest.json
 *       matches the server's own loaded epoch (what the pre-fix check only
 *       ever compared) but whose OWN scripts/handoff.js declares a
 *       DIFFERENT SCHEMA_EPOCH literal (a half-updated override) is
 *       rejected before handoff_status's spawn call site runs — proven by
 *       the override's sentinel handoff.js, which writes a marker file the
 *       instant it is actually executed, never having written it.
 *   T14 main() CLI dispatch, loader-hook: an inconsistent scratch engine now
 *       WARNS on stderr ("handoff: WARNING engine checkout is internally
 *       inconsistent ...") and still exits 0, with stdout byte-identical to
 *       a consistent scratch engine's run (loader-hook's stdout is injected
 *       into session context by the host and must stay clean).
 *   T15 main() CLI dispatch, loader-stop: same warn-not-fail shape as T14,
 *       distinct subcommand.
 *   T16 main() CLI dispatch, status (a non-exempt subcommand): the SAME
 *       inconsistent scratch engine still hard-fails (non-zero exit, the
 *       existing "handoff: engine checkout is internally inconsistent"
 *       text, no "WARNING") — proves the downgrade is scoped to
 *       loader-hook/loader-stop only. T14-T16 share T13's SKIP-if-absent
 *       scripts/node_modules gate.
 *   T17 main() CLI dispatch, status --help / resume -h: the REMOVED
 *       --help/-h exemption on the same self-consistency check — a
 *       subcommand invoked WITH --help/-h now hard-fails on an inconsistent
 *       engine exactly like the bare subcommand does.
 *   T18 readDiskSchemaEpoch: a manifest whose schema_epoch is a valid-JSON
 *       array nested 20,000 levels deep -> ok:false, never throws (the
 *       fixed implementation never calls JSON.stringify on an untrusted
 *       parsed value).
 *
 * No live Postgres required — every test here is pure or filesystem-only
 * (T13/T13b/T13c spawn a real process but never open a database connection,
 * since the guard rejects before withProjectDb/runNode's DB-touching paths
 * run). Exit 0 = all run tests passed.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

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
 * shipped implementation matches the spec's rule order, not just itself.
 * Codex review P2a (2026-09-13) fix: a manifest-unreadable/malformed disk
 * value is annotate_only ONLY when no heal has run yet (reason ===
 * undefined) — the earlier reference classifier unconditionally returned
 * annotate_only for a missing disk epoch, including post-heal calls, which
 * is exactly the bug T8 was supposed to catch and did not. */
function isPosIntRef(n) {
  return Number.isSafeInteger(n) && n >= 1;
}
function referenceBranch({ loaded, disk, reason, db }) {
  if (!isPosIntRef(loaded)) return 'heal_failed';
  if (!isPosIntRef(disk)) return reason === undefined ? 'annotate_only' : 'heal_failed';
  if (loaded < disk) return 'stale_engine';
  if (loaded > disk) return 'engine_checkout_inconsistent';
  if (reason === 'current' || reason === 'applied' || reason === 'degraded' || reason === undefined) return 'proceed';
  if (reason === 'ahead') {
    if (isPosIntRef(db) && disk < db) return 'engine_behind_db';
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
  // Codex review P2a/P2c (2026-09-13): malformed on-disk values (NaN,
  // fractional, string, negative, Infinity) now included alongside
  // null/undefined-shaped unreadability — classifyEpochDrift's own
  // isPositiveSafeInteger gate must treat every one of these the same way
  // a genuinely unreadable manifest is treated (annotate_only pre-heal,
  // heal_failed post-heal), never falling through to the loaded/disk
  // numeric comparisons below.
  const diskValues = [null, 4, 5, NaN, 5.5, '5', -1, Infinity];
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

// ── T8b: non-serializable healDetail never throws (Codex review P2c) ──────

function testT8b_NonSerializableDetailNeverThrows() {
  const label = 'T8b: non-serializable healDetail (BigInt, circular) never throws; correct branch';
  try {
    // A top-level BigInt field: JSON.stringify throws TypeError on this.
    const bigintDetail = { value: 1n };
    const r1 = classifyEpochDrift({ loadedEpoch: 5, diskEpoch: 5, healReason: 'apply_failed', healDetail: bigintDetail });
    assertEqual(r1.branch, 'heal_failed');
    assertTrue(typeof r1.message === 'string', 'BigInt detail must still produce a string message');
    assertNoMatch(r1.message, NAMES_A_SUBCOMMAND);

    // A circular object: JSON.stringify throws "Converting circular structure to JSON".
    const circular = { note: 'boom' };
    circular.self = circular;
    const r2 = classifyEpochDrift({ loadedEpoch: 5, diskEpoch: 5, healReason: 'apply_failed', healDetail: circular });
    assertEqual(r2.branch, 'heal_failed');
    assertTrue(typeof r2.message === 'string', 'circular detail must still produce a string message');
    assertNoMatch(r2.message, NAMES_A_SUBCOMMAND);

    // Malformed disk epochs directly, cross-checked one more time in
    // isolation (not just buried inside T8's matrix) — never throws,
    // correct branch for both a pre-heal (annotate_only) and post-heal
    // (heal_failed) call.
    for (const disk of [NaN, Infinity, '5', -1, 5.5]) {
      const pre = classifyEpochDrift({ loadedEpoch: 5, diskEpoch: disk });
      assertEqual(pre.branch, 'annotate_only', `disk=${JSON.stringify(disk)} pre-heal must be annotate_only`);
      const post = classifyEpochDrift({ loadedEpoch: 5, diskEpoch: disk, healReason: 'current' });
      assertEqual(post.branch, 'heal_failed', `disk=${JSON.stringify(disk)} post-heal (reason:'current') must be heal_failed, not proceed`);
    }
    pass(label);
  } catch (err) { fail(label, err.message); }
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

// ── T18: readDiskSchemaEpoch — pathologically nested manifest value ───────

function testT18_NestedArrayManifestNeverThrows() {
  const label = 'T18: readDiskSchemaEpoch — schema_epoch as a 20,000-deep nested array -> ok:false, never throws';
  try {
    withScratchManifestDir((dir, manifestPath) => {
      // Codex review r2 finding 4 (2026-09-13): a valid-JSON manifest whose
      // schema_epoch is an array nested 20,000 levels deep parses
      // successfully, then previously threw "Maximum call stack size
      // exceeded" (RangeError) inside the OLD implementation's
      // JSON.stringify(epoch) call — used only to render the error string
      // for an already-known-malformed value. Written as raw text (never
      // via JSON.stringify/nested JS array construction) so building the
      // FIXTURE itself cannot also blow this test's own stack.
      const depth = 20000;
      const manifestText = `{"schema_epoch": ${'['.repeat(depth)}${']'.repeat(depth)}}`;
      fs.writeFileSync(manifestPath, manifestText, 'utf8');
      let result;
      let thrown = null;
      try {
        result = readDiskSchemaEpoch(dir);
      } catch (err) {
        thrown = err;
      }
      assertTrue(thrown === null, `readDiskSchemaEpoch must never throw; threw: ${thrown && thrown.message}`);
      assertEqual(result.ok, false, 'a nested-array schema_epoch must be ok:false');
      assertTrue(typeof result.error === 'string' && result.error.length > 0, 'ok:false must carry a string error');
    });
    pass(label);
  } catch (err) { fail(label, err.message); }
}

// ── T12: detail redaction ────────────────────────────────────────────────

function testT12_DetailRedaction() {
  const label = 'T12: healDetail naming "init"/"resume" is fully redacted (no key list, no remedy text survives)';
  try {
    const detail = { message: 'try node scripts/handoff.js init to fix this', code: 'X1' };
    const { message } = classifyEpochDrift({ loadedEpoch: 5, diskEpoch: 5, healReason: 'apply_failed', healDetail: detail });
    // Codex review P2b (2026-09-13): the old `{redacted:true, keys:[...]}`
    // shape copied the ORIGINAL unsanitized key names into the replacement
    // — no key list survives a match now, only the bare stub.
    assertMatch(message, /"redacted":true/);
    assertNoMatch(message, /"keys"/);
    assertNoMatch(message, /try node scripts\/handoff\.js init/);
    assertNoMatch(message, /"message"/);
    assertNoMatch(message, /"code"/);

    // A key NAME (not the value) containing "init" must also be redacted —
    // the prior `keys:[...]` shape would have echoed this key verbatim.
    const keyNamedDetail = { 'run handoff.js init': 'unrelated value', code: 'X1b' };
    const keyMsg = healFailedMessage('apply_failed', keyNamedDetail);
    assertMatch(keyMsg, /"redacted":true/);
    assertNoMatch(keyMsg, /run handoff\.js init/);
    assertNoMatch(keyMsg, /"keys"/);

    // Codex review P2b: a value containing a remedy word split across an
    // ESCAPED newline (JSON.stringify renders a real "\n" as the two
    // literal characters backslash+n, so a naive \binit\b test against the
    // raw serialized string sees "...run\ninit..." with no word boundary
    // between the escape's "n" and "init"'s "i" — this must still match).
    const escapedNewlineDetail = { message: 'Fix: run\ninit' };
    const escapedMsg = healFailedMessage('apply_failed', escapedNewlineDetail);
    assertMatch(escapedMsg, /"redacted":true/);
    assertNoMatch(escapedMsg, /Fix: run/);

    // A NESTED object containing "resume" must be caught too — the
    // whole-string scan covers arbitrary nesting depth since
    // JSON.stringify recurses through the whole structure.
    const nestedDetail = { code: 'X3', inner: { hint: 'try handoff.js resume next' } };
    const nestedMsg = healFailedMessage('apply_failed', nestedDetail);
    assertMatch(nestedMsg, /"redacted":true/);
    assertNoMatch(nestedMsg, /handoff\.js resume/);
    assertNoMatch(nestedMsg, /"inner"/);

    // Also exercise healFailedMessage directly (the same function
    // classifyEpochDrift uses internally — no second implementation).
    const direct = healFailedMessage('apply_failed', detail);
    assertMatch(direct, /"redacted":true/);
    assertNoMatch(direct, /try node scripts\/handoff\.js init/);
    // A detail that does NOT name init/resume passes through unredacted.
    const cleanDetail = { message: 'ddl failed', code: 'X2' };
    const cleanMsg = healFailedMessage('apply_failed', cleanDetail);
    assertMatch(cleanMsg, /"message":"ddl failed"/);

    // Codex review r2 finding 3 (2026-09-13): a remedy word split across a
    // REAL (not escaped) form-feed character. JSON.stringify would render
    // this as the two literal characters backslash+f in the OLD
    // implementation's serialize-then-regex approach, but the new
    // raw-structure walk sees the actual 0x0C byte directly and must
    // normalize it to a real word boundary before the \binit\b test.
    const formFeedDetail = { message: 'run\finit' };
    const formFeedMsg = healFailedMessage('apply_failed', formFeedDetail);
    assertMatch(formFeedMsg, /"redacted":true/);
    assertNoMatch(formFeedMsg, /run/);

    // Same, with a real vertical-tab character (0x0B).
    const vtabDetail = { message: 'run\vinit' };
    const vtabMsg = healFailedMessage('apply_failed', vtabDetail);
    assertMatch(vtabMsg, /"redacted":true/);
    assertNoMatch(vtabMsg, /run/);

    // Same, with a real non-breaking space (U+00A0) — not covered by \s in
    // some regex engines/flags, which is exactly why this normalizer lists
    // it explicitly rather than relying on \s alone.
    const nbspDetail = { message: 'run init' };
    const nbspMsg = healFailedMessage('apply_failed', nbspDetail);
    assertMatch(nbspMsg, /"redacted":true/);
    assertNoMatch(nbspMsg, /run/);

    // A key literally named "init" (the whole key, not a phrase containing
    // it) must also be redacted — exercises the exact-word key scan, not
    // just a key that happens to contain "init" inside a longer phrase.
    const bareKeyDetail = { init: 'this value on its own says nothing' };
    const bareKeyMsg = healFailedMessage('apply_failed', bareKeyDetail);
    assertMatch(bareKeyMsg, /"redacted":true/);
    assertNoMatch(bareKeyMsg, /"init"/);
    assertNoMatch(bareKeyMsg, /this value on its own/);

    // Codex review r2 finding 3's THIRD escape (the one the raw-structure
    // walk alone cannot see, by design — it deliberately ignores toJSON):
    // an object whose real own properties name nothing, but whose toJSON()
    // OUTPUT contains "resume". The walk finds no match; the single
    // safe-stringify-once call (which DOES invoke toJSON, exactly once)
    // must catch this from that one result before it is ever emitted.
    const toJsonDetail = { toJSON() { return 'contains the word resume in here'; } };
    const toJsonMsg = healFailedMessage('apply_failed', toJsonDetail);
    assertMatch(toJsonMsg, /"redacted":true/);
    assertNoMatch(toJsonMsg, /contains the word resume/);

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

// Codex review T13 finding (2026-09-13): a fixture project root with its OWN
// .claude/pipeline.yml pointing `knowledge.host`/`port` at an address
// nothing listens on. If checkEngineEpochOrThrow ever failed to run BEFORE
// withProjectDb's connectForRoot (a regression this test must catch), the
// tool call would instead surface a pg connection failure (ECONNREFUSED /
// timeout) — a message shape entirely distinct from the guard's own
// "stale engine build" text — making "did the DB layer get touched at all"
// directly observable from the tool's error text, not just inferred.
// 127.0.0.1:1 (tcpmux) is loopback-only and essentially never bound,
// so a real connection attempt refuses immediately rather than hanging.
function buildUnreachableDbProjectRoot() {
  const root = path.join(os.tmpdir(), `epoch-guard-t13-project-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  fs.mkdirSync(path.join(root, '.claude'), { recursive: true });
  fs.writeFileSync(
    path.join(root, '.claude', 'pipeline.yml'),
    [
      'project:',
      '  name: epoch-guard-t13-unreachable',
      '',
      'knowledge:',
      '  tier: "postgres"',
      '  host: "127.0.0.1"',
      '  port: 1',
      '  database: "epoch_guard_t13_unreachable"',
      '  user: "postgres"',
      '',
    ].join('\n'),
    'utf8'
  );
  return root;
}

async function connectMcp(serverPath, childEnv) {
  const { Client: SdkClient } = require(
    path.join(PROJECT_ROOT, 'scripts', 'node_modules', '@modelcontextprotocol', 'sdk', 'dist', 'cjs', 'client', 'index.js')
  );
  const { StdioClientTransport } = require(
    path.join(PROJECT_ROOT, 'scripts', 'node_modules', '@modelcontextprotocol', 'sdk', 'dist', 'cjs', 'client', 'stdio.js')
  );
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverPath],
    env: childEnv,
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
  let unreachableProjectRoot = null;
  let client = null;
  try {
    scratch = buildScratchEngineCopy();
    unreachableProjectRoot = buildUnreachableDbProjectRoot();

    // Codex review T13 finding: build the child's env EXPLICITLY and strip
    // CLAUDE_PLUGIN_ROOT/HANDOFF_MCP_ENGINE_PATH rather than spreading
    // process.env verbatim — this test's OWN process could be running
    // under either (e.g. as a Claude Code plugin, or with a developer's
    // local override set), and either one would let the guard read a
    // checkout OTHER than the throwaway scratch copy this test just built
    // and is about to bump, silently defeating the manifest-bump below.
    const childEnv = { ...process.env };
    delete childEnv.CLAUDE_PLUGIN_ROOT;
    delete childEnv.HANDOFF_MCP_ENGINE_PATH;

    client = await connectMcp(path.join(scratch.scratchScripts, 'handoff-mcp.mjs'), childEnv);

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
      // projectRoot points at the unreachable-DB fixture, NOT PROJECT_ROOT —
      // if checkEngineEpochOrThrow's pre-connect placement ever regressed,
      // connectForRoot would attempt a real TCP connect to 127.0.0.1:1 and
      // this test would see a connection-refused error instead of the
      // guard's own message (asserted below).
      arguments: { projectRoot: unreachableProjectRoot },
    });
    if (!res.isError) {
      fail(label, `expected an isError tool result, got success: ${JSON.stringify(res).slice(0, 300)}`);
      return;
    }
    const text = res.content && res.content[0] && res.content[0].text;
    assertMatch(text, /stale engine build/i);
    assertMatch(text, new RegExp(`loaded schema epoch ${loadedEpoch}`));
    assertMatch(text, new RegExp(`on disk ${loadedEpoch + 1}`));
    // The distinguishing proof: no sign of a database connection attempt
    // (pg's own error vocabulary for a refused/unreachable TCP connect)
    // anywhere in the tool's error text — the rejection happened before
    // connectForRoot ever ran, not merely before the query printed here.
    assertNoMatch(text, /ECONNREFUSED|ETIMEDOUT|ENOTFOUND|connect ECONNREFUSED|Connection terminated|client password/i);
    pass(label);
  } catch (err) {
    fail(label, err.message);
  } finally {
    if (client) { try { await client.close(); } catch (_err) { /* best-effort */ } }
    if (scratch) { try { fs.rmSync(scratch.scratchRoot, { recursive: true, force: true }); } catch (_err) { /* best-effort */ } }
    if (unreachableProjectRoot) { try { fs.rmSync(unreachableProjectRoot, { recursive: true, force: true }); } catch (_err) { /* best-effort */ } }
  }
}

// Codex review r2 finding 5 (2026-09-13): T13 above only ever exercised
// handoff_status, a SPAWN-based (runNode) tool — it never calls
// withProjectDb/connectForRoot at all, so it could not prove the DIRECT-PG
// call-site-1 guard (withProjectDb's own checkEngineEpochOrThrow, called
// BEFORE connectForRoot) actually runs for the §8 direct-PG tool surface
// (assertion_read, memory_search, ...). This is the same stale-engine
// scratch setup as T13, but calls assertion_read instead — same
// unreachable-DB distinguishing proof (no pg-connection-error vocabulary
// anywhere in the response) applies identically.
async function testT13b_LiveStdioDirectPgToolStaleEngine() {
  const label = 'T13b: live stdio MCP — direct-PG tool (assertion_read) also rejects stale engine before connecting';
  const nodeModulesDir = path.join(PROJECT_ROOT, 'scripts', 'node_modules');
  if (!fs.existsSync(nodeModulesDir)) {
    skip(label, 'scripts/node_modules absent — run `pnpm install --frozen-lockfile` in scripts/ first (see .github/workflows/test.yml\'s "Install dependencies" step)');
    return;
  }
  let scratch = null;
  let unreachableProjectRoot = null;
  let client = null;
  try {
    scratch = buildScratchEngineCopy();
    unreachableProjectRoot = buildUnreachableDbProjectRoot();

    const childEnv = { ...process.env };
    delete childEnv.CLAUDE_PLUGIN_ROOT;
    delete childEnv.HANDOFF_MCP_ENGINE_PATH;

    client = await connectMcp(path.join(scratch.scratchScripts, 'handoff-mcp.mjs'), childEnv);

    const manifest = JSON.parse(fs.readFileSync(scratch.manifestPath, 'utf8'));
    const loadedEpoch = manifest.schema_epoch;
    manifest.schema_epoch = loadedEpoch + 1;
    fs.writeFileSync(scratch.manifestPath, JSON.stringify(manifest, null, 2), 'utf8');

    const res = await client.callTool({
      name: 'assertion_read',
      arguments: { projectRoot: unreachableProjectRoot },
    });
    if (!res.isError) {
      fail(label, `expected an isError tool result, got success: ${JSON.stringify(res).slice(0, 300)}`);
      return;
    }
    const text = res.content && res.content[0] && res.content[0].text;
    assertMatch(text, /stale engine build/i);
    assertMatch(text, new RegExp(`loaded schema epoch ${loadedEpoch}`));
    assertMatch(text, new RegExp(`on disk ${loadedEpoch + 1}`));
    assertNoMatch(text, /ECONNREFUSED|ETIMEDOUT|ENOTFOUND|connect ECONNREFUSED|Connection terminated|client password/i);
    pass(label);
  } catch (err) {
    fail(label, err.message);
  } finally {
    if (client) { try { await client.close(); } catch (_err) { /* best-effort */ } }
    if (scratch) { try { fs.rmSync(scratch.scratchRoot, { recursive: true, force: true }); } catch (_err) { /* best-effort */ } }
    if (unreachableProjectRoot) { try { fs.rmSync(unreachableProjectRoot, { recursive: true, force: true }); } catch (_err) { /* best-effort */ } }
  }
}

/**
 * Builds a throwaway "override" engine checkout for the
 * HANDOFF_MCP_ENGINE_PATH sentinel test below: its schema-manifest.json
 * declares `matchingEpoch` (matching the scratch SERVER's own loaded
 * epoch — exactly what the OLD, pre-fix checkSpawnEngineEpochOrThrow only
 * ever checked, and would therefore have ACCEPTED), but its scripts/
 * handoff.js sentinel script declares a DIFFERENT SCHEMA_EPOCH literal —
 * reproducing the Codex review r2 finding 1 counterexample (a half-updated
 * override: manifest bumped to match, handoff.js not) that the NEW
 * literal-extraction check must catch. The sentinel script itself writes
 * markerPath the instant it is actually executed, then exits immediately —
 * proving (by the marker's absence) that the rejected call never reached
 * the spawn call site at all.
 */
function buildSentinelOverrideEngine(matchingEpoch) {
  const sentinelRoot = path.join(os.tmpdir(), `epoch-guard-sentinel-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  const sentinelScripts = path.join(sentinelRoot, 'scripts');
  fs.mkdirSync(path.join(sentinelScripts, 'sql'), { recursive: true });
  fs.writeFileSync(
    path.join(sentinelScripts, 'sql', 'schema-manifest.json'),
    JSON.stringify({ schema_epoch: matchingEpoch }, null, 2),
    'utf8'
  );
  const markerPath = path.join(sentinelRoot, 'executed.marker');
  const mismatchedLiteral = matchingEpoch + 1;
  const sentinelHandoffJs = [
    "'use strict';",
    `const SCHEMA_EPOCH = ${mismatchedLiteral};`,
    "const fs = require('fs');",
    `fs.writeFileSync(${JSON.stringify(markerPath)}, 'executed\\n');`,
    'process.exit(0);',
    '',
  ].join('\n');
  const sentinelHandoffPath = path.join(sentinelScripts, 'handoff.js');
  fs.writeFileSync(sentinelHandoffPath, sentinelHandoffJs, 'utf8');
  return { sentinelRoot, sentinelHandoffPath, markerPath, mismatchedLiteral };
}

// Codex review r2 finding 1 (2026-09-13): proves checkSpawnEngineEpochOrThrow
// rejects a HANDOFF_MCP_ENGINE_PATH override whose manifest matches the
// server but whose own scripts/handoff.js literal does not — BEFORE the
// spawn call site ever runs. Uses a CONSISTENT scratch server (no manifest
// bump on the server's own checkout) so checkEngineEpochOrThrow (the
// _ENGINE_ROOT check) passes cleanly and only checkSpawnEngineEpochOrThrow
// (the override check) is under test.
async function testT13c_SpawnToolSentinelOverrideRejected() {
  const label = 'T13c: live stdio MCP — HANDOFF_MCP_ENGINE_PATH override with a mismatched handoff.js literal is rejected before spawn';
  const nodeModulesDir = path.join(PROJECT_ROOT, 'scripts', 'node_modules');
  if (!fs.existsSync(nodeModulesDir)) {
    skip(label, 'scripts/node_modules absent — run `pnpm install --frozen-lockfile` in scripts/ first (see .github/workflows/test.yml\'s "Install dependencies" step)');
    return;
  }
  let scratch = null;
  let sentinel = null;
  let client = null;
  try {
    scratch = buildScratchEngineCopy();
    const scratchManifest = JSON.parse(fs.readFileSync(scratch.manifestPath, 'utf8'));
    sentinel = buildSentinelOverrideEngine(scratchManifest.schema_epoch);

    const childEnv = { ...process.env };
    delete childEnv.CLAUDE_PLUGIN_ROOT;
    // The override under test — set BEFORE the server starts, exactly like
    // a real deployment would set it in the MCP server's own launch config.
    childEnv.HANDOFF_MCP_ENGINE_PATH = sentinel.sentinelHandoffPath;

    client = await connectMcp(path.join(scratch.scratchScripts, 'handoff-mcp.mjs'), childEnv);

    const res = await client.callTool({
      name: 'handoff_status',
      arguments: { projectRoot: PROJECT_ROOT },
    });
    if (!res.isError) {
      fail(label, `expected an isError tool result, got success: ${JSON.stringify(res).slice(0, 300)}`);
      return;
    }
    const text = res.content && res.content[0] && res.content[0].text;
    assertMatch(text, /HANDOFF_MCP_ENGINE_PATH/);
    assertMatch(text, new RegExp(`SCHEMA_EPOCH ${sentinel.mismatchedLiteral}`));
    assertMatch(text, new RegExp(`schema-manifest\\.json epoch ${scratchManifest.schema_epoch}`));

    // The distinguishing proof: the sentinel's own marker file must be
    // ABSENT — if checkSpawnEngineEpochOrThrow's rejection had somehow run
    // AFTER the spawn call site (or not at all), the sentinel script would
    // have actually executed and written this file.
    assertTrue(!fs.existsSync(sentinel.markerPath), 'sentinel override script must never have been spawned');

    pass(label);
  } catch (err) {
    fail(label, err.message);
  } finally {
    if (client) { try { await client.close(); } catch (_err) { /* best-effort */ } }
    if (scratch) { try { fs.rmSync(scratch.scratchRoot, { recursive: true, force: true }); } catch (_err) { /* best-effort */ } }
    if (sentinel) { try { fs.rmSync(sentinel.sentinelRoot, { recursive: true, force: true }); } catch (_err) { /* best-effort */ } }
  }
}

// ── T14-T16: main() CLI dispatch — warn-vs-fail split ─────────────────────
//
// fix/mcp-stale-engine-gate follow-up: loader-hook/loader-stop no longer
// SKIP the self-consistency check entirely — they still run it, but an
// inconsistent checkout is downgraded to a single stderr WARNING line
// (never stdout — loader-hook's stdout is injected into session context by
// the host) instead of process.exit(1). Every other subcommand keeps the
// existing hard-fail. These three tests share buildScratchEngineCopy() /
// the manifest-bump trick from T13, applied to the CLI (handoff.js) rather
// than the MCP server (handoff-mcp.mjs).

function runScratchCli(scratchScripts, args, projectDir) {
  const childEnv = { ...process.env };
  // Same rationale as T13: never let this test process's own ambient
  // CLAUDE_PLUGIN_ROOT/HANDOFF_MCP_ENGINE_PATH point the child at a
  // checkout other than the scratch copy this test just built and bumped.
  delete childEnv.CLAUDE_PLUGIN_ROOT;
  delete childEnv.HANDOFF_MCP_ENGINE_PATH;
  childEnv.PROJECT_ROOT = projectDir;
  return spawnSync(
    process.execPath,
    [path.join(scratchScripts, 'handoff.js'), ...args],
    { env: childEnv, cwd: projectDir, timeout: 10000 }
  );
}

function testT14_LoaderHookWarnsNotFails() {
  const label = 'T14: loader-hook — inconsistent engine warns on stderr, exits 0, stdout unchanged';
  const nodeModulesDir = path.join(PROJECT_ROOT, 'scripts', 'node_modules');
  if (!fs.existsSync(nodeModulesDir)) {
    skip(label, 'scripts/node_modules absent — run `pnpm install --frozen-lockfile` in scripts/ first (see .github/workflows/test.yml\'s "Install dependencies" step)');
    return;
  }
  let scratch = null;
  let emptyProjectDir = null;
  try {
    scratch = buildScratchEngineCopy();
    emptyProjectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'epoch-guard-t14-project-'));

    // Baseline: consistent engine (manifest epoch untouched) — no warning.
    const consistentResult = runScratchCli(scratch.scratchScripts, ['loader-hook'], emptyProjectDir);
    assertEqual(consistentResult.status, 0, `consistent loader-hook should exit 0; stderr: ${consistentResult.stderr?.toString()}`);
    assertNoMatch(consistentResult.stderr?.toString() ?? '', /WARNING engine checkout is internally inconsistent/);

    // Bump the on-disk manifest epoch so the copied handoff.js (its
    // SCHEMA_EPOCH constant frozen at whatever the real repo declares)
    // disagrees with its own checkout's schema-manifest.json.
    const manifest = JSON.parse(fs.readFileSync(scratch.manifestPath, 'utf8'));
    const loadedEpoch = manifest.schema_epoch;
    manifest.schema_epoch = loadedEpoch + 1;
    fs.writeFileSync(scratch.manifestPath, JSON.stringify(manifest, null, 2), 'utf8');

    const mismatchResult = runScratchCli(scratch.scratchScripts, ['loader-hook'], emptyProjectDir);
    assertEqual(mismatchResult.status, 0, `mismatched loader-hook must still exit 0 (warn, not fail); stderr: ${mismatchResult.stderr?.toString()}`);
    const mismatchStderr = mismatchResult.stderr?.toString() ?? '';
    assertMatch(mismatchStderr, /handoff: WARNING engine checkout is internally inconsistent/);
    assertMatch(mismatchStderr, new RegExp(`declares schema epoch ${loadedEpoch}`));
    assertMatch(mismatchStderr, new RegExp(`declares ${loadedEpoch + 1}`));

    // stdout is byte-identical to the consistent run — both are the inert
    // no-marker fast path; the warning must never leak onto stdout.
    const mismatchStdout = mismatchResult.stdout?.toString() ?? '';
    const consistentStdout = consistentResult.stdout?.toString() ?? '';
    assertEqual(mismatchStdout, consistentStdout, 'loader-hook stdout must be unchanged by the warning path');
    assertEqual(mismatchStdout, '', 'loader-hook stdout must stay empty (no marker)');

    pass(label);
  } catch (err) {
    fail(label, err.message);
  } finally {
    if (scratch) { try { fs.rmSync(scratch.scratchRoot, { recursive: true, force: true }); } catch (_err) { /* best-effort */ } }
    if (emptyProjectDir) { try { fs.rmSync(emptyProjectDir, { recursive: true, force: true }); } catch (_err) { /* best-effort */ } }
  }
}

function testT15_LoaderStopWarnsNotFails() {
  const label = 'T15: loader-stop — inconsistent engine warns on stderr, exits 0';
  const nodeModulesDir = path.join(PROJECT_ROOT, 'scripts', 'node_modules');
  if (!fs.existsSync(nodeModulesDir)) {
    skip(label, 'scripts/node_modules absent — run `pnpm install --frozen-lockfile` in scripts/ first (see .github/workflows/test.yml\'s "Install dependencies" step)');
    return;
  }
  let scratch = null;
  let emptyProjectDir = null;
  try {
    scratch = buildScratchEngineCopy();
    emptyProjectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'epoch-guard-t15-project-'));

    const manifest = JSON.parse(fs.readFileSync(scratch.manifestPath, 'utf8'));
    const loadedEpoch = manifest.schema_epoch;
    manifest.schema_epoch = loadedEpoch + 1;
    fs.writeFileSync(scratch.manifestPath, JSON.stringify(manifest, null, 2), 'utf8');

    const result = runScratchCli(scratch.scratchScripts, ['loader-stop'], emptyProjectDir);
    assertEqual(result.status, 0, `mismatched loader-stop must exit 0 (warn, not fail); stderr: ${result.stderr?.toString()}`);
    const stderr = result.stderr?.toString() ?? '';
    assertMatch(stderr, /handoff: WARNING engine checkout is internally inconsistent/);
    assertMatch(stderr, new RegExp(`declares schema epoch ${loadedEpoch}`));
    assertMatch(stderr, new RegExp(`declares ${loadedEpoch + 1}`));

    pass(label);
  } catch (err) {
    fail(label, err.message);
  } finally {
    if (scratch) { try { fs.rmSync(scratch.scratchRoot, { recursive: true, force: true }); } catch (_err) { /* best-effort */ } }
    if (emptyProjectDir) { try { fs.rmSync(emptyProjectDir, { recursive: true, force: true }); } catch (_err) { /* best-effort */ } }
  }
}

function testT16_StatusStillHardFails() {
  const label = 'T16: status (non-exempt) — same inconsistent engine still hard-fails';
  const nodeModulesDir = path.join(PROJECT_ROOT, 'scripts', 'node_modules');
  if (!fs.existsSync(nodeModulesDir)) {
    skip(label, 'scripts/node_modules absent — run `pnpm install --frozen-lockfile` in scripts/ first (see .github/workflows/test.yml\'s "Install dependencies" step)');
    return;
  }
  let scratch = null;
  let emptyProjectDir = null;
  try {
    scratch = buildScratchEngineCopy();
    emptyProjectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'epoch-guard-t16-project-'));

    const manifest = JSON.parse(fs.readFileSync(scratch.manifestPath, 'utf8'));
    const loadedEpoch = manifest.schema_epoch;
    manifest.schema_epoch = loadedEpoch + 1;
    fs.writeFileSync(scratch.manifestPath, JSON.stringify(manifest, null, 2), 'utf8');

    const result = runScratchCli(scratch.scratchScripts, ['status'], emptyProjectDir);
    assertTrue(result.status !== 0, `status must hard-fail on an inconsistent engine; got exit ${result.status}`);
    const stderr = result.stderr?.toString() ?? '';
    assertMatch(stderr, /handoff: engine checkout is internally inconsistent/);
    assertNoMatch(stderr, /WARNING/);

    pass(label);
  } catch (err) {
    fail(label, err.message);
  } finally {
    if (scratch) { try { fs.rmSync(scratch.scratchRoot, { recursive: true, force: true }); } catch (_err) { /* best-effort */ } }
    if (emptyProjectDir) { try { fs.rmSync(emptyProjectDir, { recursive: true, force: true }); } catch (_err) { /* best-effort */ } }
  }
}

// Codex review r2 finding 2 (2026-09-13): the PRIOR --help/-h exemption on
// this same self-consistency check let e.g. `status --help` skip the check
// entirely and fall through into cmdStatus's real handler against a broken
// checkout. That exemption is now REMOVED — this proves a subcommand
// invoked WITH --help hard-fails exactly like the bare subcommand does.
function testT17_SubcommandHelpFlagStillChecked() {
  const label = 'T17: status --help — inconsistent engine still hard-fails (no --help exemption)';
  const nodeModulesDir = path.join(PROJECT_ROOT, 'scripts', 'node_modules');
  if (!fs.existsSync(nodeModulesDir)) {
    skip(label, 'scripts/node_modules absent — run `pnpm install --frozen-lockfile` in scripts/ first (see .github/workflows/test.yml\'s "Install dependencies" step)');
    return;
  }
  let scratch = null;
  let emptyProjectDir = null;
  try {
    scratch = buildScratchEngineCopy();
    emptyProjectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'epoch-guard-t17-project-'));

    const manifest = JSON.parse(fs.readFileSync(scratch.manifestPath, 'utf8'));
    const loadedEpoch = manifest.schema_epoch;
    manifest.schema_epoch = loadedEpoch + 1;
    fs.writeFileSync(scratch.manifestPath, JSON.stringify(manifest, null, 2), 'utf8');

    const result = runScratchCli(scratch.scratchScripts, ['status', '--help'], emptyProjectDir);
    assertTrue(result.status !== 0, `status --help must hard-fail on an inconsistent engine; got exit ${result.status}`);
    const stderr = result.stderr?.toString() ?? '';
    assertMatch(stderr, /handoff: engine checkout is internally inconsistent/);
    assertNoMatch(stderr, /WARNING/);

    // A bare -h on a different subcommand, same shape.
    const resultDashH = runScratchCli(scratch.scratchScripts, ['resume', '-h'], emptyProjectDir);
    assertTrue(resultDashH.status !== 0, `resume -h must hard-fail on an inconsistent engine; got exit ${resultDashH.status}`);
    assertMatch(resultDashH.stderr?.toString() ?? '', /handoff: engine checkout is internally inconsistent/);

    pass(label);
  } catch (err) {
    fail(label, err.message);
  } finally {
    if (scratch) { try { fs.rmSync(scratch.scratchRoot, { recursive: true, force: true }); } catch (_err) { /* best-effort */ } }
    if (emptyProjectDir) { try { fs.rmSync(emptyProjectDir, { recursive: true, force: true }); } catch (_err) { /* best-effort */ } }
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
  testT8b_NonSerializableDetailNeverThrows();
  testT9_ReadDiskSchemaEpoch();
  testT10_NoMemoization();
  testT11_EngineCheckoutInconsistent();
  testT12_DetailRedaction();
  await testT13_LiveStdioStaleEngine();
  await testT13b_LiveStdioDirectPgToolStaleEngine();
  await testT13c_SpawnToolSentinelOverrideRejected();
  testT14_LoaderHookWarnsNotFails();
  testT15_LoaderStopWarnsNotFails();
  testT16_StatusStillHardFails();
  testT17_SubcommandHelpFlagStillChecked();
  testT18_NestedArrayManifestNeverThrows();

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
