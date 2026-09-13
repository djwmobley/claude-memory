'use strict';

/**
 * test-codex-review.js — regression suite for scripts/codex-review.js
 * (docs/specs/codex-review-contract.md, adversary pass 2026-09-13).
 *
 * Pure-function tests only: no `gh`, no `codex`, no network, no DB. Covers
 * one fixture per adversary finding A1-F17, a VALID_APPROVE/VALID_BLOCK
 * happy path, and a 64-row generated totality table.
 *
 * Usage: node test/test-codex-review.js
 * Exit 0 = all pass; nonzero = any failure.
 */

const path = require('path');
const {
  normalizePath,
  buildFence,
  parseVerdict,
  classify,
  renderLedgerComment,
  renderHaltComment,
  parseLedger,
  sha256,
} = require(path.join(__dirname, '..', 'scripts', 'codex-review.js'));

let passed = 0;
let failed = 0;
const failures = [];
function test(label, fn) {
  try {
    fn();
    passed++;
  } catch (err) {
    failed++;
    failures.push({ label, err });
    console.error(`  [FAIL] ${label}: ${err.message}`);
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}
function assertEqual(actual, expected, msg) {
  if (actual !== expected) {
    throw new Error(`${msg || 'mismatch'}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

// ── Fixtures ──────────────────────────────────────────────────────────────

const HEAD_SHA = 'a'.repeat(40);
const WRONG_SHA = 'b'.repeat(40);
const FENCE_FILES = ['scripts/codex-review.js', 'test/test-codex-review.js', 'docs/specs/codex-review-contract.md'];
const IN_FENCE_FILE = FENCE_FILES[0];
const OUT_OF_FENCE_FILE = 'outside/not-in-fence.js';

function makeFence(paths, platform) {
  return buildFence(
    paths.map((p) => (typeof p === 'string' ? { path: p } : p)),
    platform
  );
}
const FENCE = makeFence(FENCE_FILES);

function baseLedger() {
  return { entries: [], halted: false, haltCleared: false, haltReason: null, expectedRound: 1 };
}

function approveText({ sha = HEAD_SHA, round = 1, scope = 'yes' } = {}) {
  return [`SHA: ${sha}`, 'VERDICT: APPROVE', `SCOPE_RESPECTED: ${scope}`, `ROUND: ${round}`].join('\n');
}
function blockText({ sha = HEAD_SHA, round = 1, file = IN_FENCE_FILE, text = 'fix it' } = {}) {
  return [
    `SHA: ${sha}`,
    'VERDICT: BLOCK',
    'SCOPE_RESPECTED: yes',
    `ROUND: ${round}`,
    'FINDINGS:',
    `- BLOCKER file=${file} text=${text}`,
    'END_FINDINGS',
  ].join('\n');
}

function baseCtx(overrides = {}) {
  const stdout = overrides.stdout !== undefined ? overrides.stdout : approveText();
  return {
    exitCode: overrides.exitCode !== undefined ? overrides.exitCode : 0,
    stdout,
    verdictText: stdout,
    fence: overrides.fence !== undefined ? overrides.fence : FENCE,
    headSha: overrides.headSha !== undefined ? overrides.headSha : HEAD_SHA,
    round: overrides.round !== undefined ? overrides.round : 1,
    ledger: overrides.ledger !== undefined ? overrides.ledger : baseLedger(),
    isDraft: overrides.isDraft !== undefined ? overrides.isDraft : false,
  };
}

// ── Happy path ────────────────────────────────────────────────────────────

test('happy path: VALID_APPROVE', () => {
  const r = classify(baseCtx());
  assertEqual(r.bucket, 'VALID_APPROVE');
});

test('happy path: VALID_BLOCK', () => {
  const r = classify(baseCtx({ stdout: blockText() }));
  assertEqual(r.bucket, 'VALID_BLOCK');
});

// ── A1: free text outside enumerated fields ──────────────────────────────

test('A1: stray unrecognized line -> INVALID_SHAPE', () => {
  const text = approveText() + '\nBy the way, this PR also needs a rewrite.';
  const r = classify(baseCtx({ stdout: text }));
  assertEqual(r.bucket, 'INVALID_SHAPE');
});

test('A1: text after END_FINDINGS -> INVALID_SHAPE (TEXT_AFTER_LAST_FIELD)', () => {
  const text = blockText() + '\none more thought';
  const r = classify(baseCtx({ stdout: text }));
  assertEqual(r.bucket, 'INVALID_SHAPE');
  assertEqual(r.reason, 'TEXT_AFTER_LAST_FIELD');
});

// ── A2: required field must occur exactly once ───────────────────────────

test('A2: duplicated VERDICT field -> INVALID_SHAPE', () => {
  const text = approveText() + '\nVERDICT: APPROVE';
  const r = classify(baseCtx({ stdout: text }));
  assertEqual(r.bucket, 'INVALID_SHAPE');
  assertEqual(r.reason, 'FIELD_COUNT_VERDICT');
});

test('A2: missing SHA field -> INVALID_SHAPE', () => {
  const text = ['VERDICT: APPROVE', 'SCOPE_RESPECTED: yes', 'ROUND: 1'].join('\n');
  const r = classify(baseCtx({ stdout: text }));
  assertEqual(r.bucket, 'INVALID_SHAPE');
  assertEqual(r.reason, 'FIELD_COUNT_SHA');
});

// ── A3: verdict SHA independently checked against wrapper-resolved SHA ──

test('A3: verdict SHA mismatch -> INVALID_SHAPE', () => {
  const r = classify(baseCtx({ stdout: approveText({ sha: WRONG_SHA }), headSha: HEAD_SHA }));
  assertEqual(r.bucket, 'INVALID_SHAPE');
  assertEqual(r.reason, 'SHA_MISMATCH');
});

// ── A4: BLOCKER text referencing an out-of-fence path token ─────────────

test('A4: BLOCKER text references out-of-fence path -> OUT_OF_FENCE_BLOCKER', () => {
  const text = blockText({ file: IN_FENCE_FILE, text: `also touch ${OUT_OF_FENCE_FILE}` });
  const r = classify(baseCtx({ stdout: text }));
  assertEqual(r.bucket, 'OUT_OF_FENCE_BLOCKER');
  assertEqual(r.reason, 'BLOCKER_TEXT_REFERENCES_OUT_OF_FENCE_PATH');
});

// ── B5/B7: normalized, platform-aware path equality ──────────────────────

test('B5: backslash path normalizes to match forward-slash fence entry', () => {
  const text = blockText({ file: 'scripts\\codex-review.js' });
  const r = classify(baseCtx({ stdout: text }));
  assertEqual(r.bucket, 'VALID_BLOCK');
});

test('B5: leading ./ and doubled slashes normalize away', () => {
  assertEqual(normalizePath('./a//b/c', 'linux'), 'a/b/c');
});

test('B7: win32 comparison is case-insensitive', () => {
  assertEqual(normalizePath('Scripts/Foo.JS', 'win32'), normalizePath('scripts/foo.js', 'win32'));
});

test('B7: non-win32 comparison is case-sensitive', () => {
  assert(normalizePath('Scripts/Foo.JS', 'linux') !== normalizePath('scripts/foo.js', 'linux'));
});

// ── B6: fence resolved fresh each round; renames cover both paths ───────

test('B6: renamed file contributes both previous and current path to fence', () => {
  const fence = makeFence([{ path: 'new/name.js', previousPath: 'old/name.js' }]);
  assert(fence.has('old/name.js'));
  assert(fence.has('new/name.js'));
});

test('B6: BLOCKER on the pre-rename path is in-fence', () => {
  const fence = makeFence([{ path: 'new/name.js', previousPath: 'old/name.js' }]);
  const r = classify(baseCtx({ fence, stdout: blockText({ file: 'old/name.js' }) }));
  assertEqual(r.bucket, 'VALID_BLOCK');
});

// ── C8/C9: idempotent dup-round abort, re-read before posting ───────────

test('C8/C9: existing marker for same (round, headSha) -> ROUND_EXCEEDED (idempotent)', () => {
  const ledger = { entries: [{ round: 1, headSha: HEAD_SHA }], halted: false, haltCleared: false, expectedRound: 2 };
  const r = classify(baseCtx({ ledger, round: 1 }));
  assertEqual(r.bucket, 'ROUND_EXCEEDED');
  assertEqual(r.reason, 'ROUND_ALREADY_RECORDED');
});

test('C9: parseLedger re-reads comments and reproduces the dup-round condition', () => {
  const priorBody = renderLedgerComment({ round: 1, headSha: HEAD_SHA, bucket: 'VALID_APPROVE', verdictText: approveText() });
  const ledger = parseLedger([{ body: priorBody }]);
  const r = classify(baseCtx({ ledger, round: 1 }));
  assertEqual(r.bucket, 'ROUND_EXCEEDED');
});

// ── C10: ledger comment hash detects post-hoc edits ──────────────────────

test('C10: unedited ledger comment hash matches -> not tampered', () => {
  const body = renderLedgerComment({ round: 1, headSha: HEAD_SHA, bucket: 'VALID_APPROVE', verdictText: approveText() });
  const ledger = parseLedger([{ body }]);
  assertEqual(ledger.halted, false);
});

test('C10: edited ledger comment body (hash mismatch) halts', () => {
  const verdictText = approveText();
  const body = renderLedgerComment({ round: 1, headSha: HEAD_SHA, bucket: 'VALID_APPROVE', verdictText });
  // Tamper only the fenced verdict content (the part the hash covers), not
  // the surrounding "Bucket:" summary line, to prove the hash actually
  // detects a post-hoc edit rather than merely differing text anywhere.
  const tampered = body.replace(verdictText, verdictText.replace('APPROVE', 'BLOCK'));
  const ledger = parseLedger([{ body: tampered }]);
  assertEqual(ledger.halted, true);
  assertEqual(ledger.haltReason, 'LEDGER_TAMPERED');
  const r = classify(baseCtx({ ledger }));
  assertEqual(r.bucket, 'HALTED');
});

// ── C11: force-push does not reset the round counter ─────────────────────

test('C11: force-push new SHA keeps ledger-computed round at 2, not reset to 1', () => {
  const ledger = { entries: [{ round: 1, headSha: WRONG_SHA }], halted: false, haltCleared: false, expectedRound: 2 };
  const newHeadSha = HEAD_SHA;
  const r = classify(baseCtx({ ledger, round: 2, headSha: newHeadSha, stdout: approveText({ sha: newHeadSha, round: 2 }) }));
  assertEqual(r.bucket, 'VALID_APPROVE');
});

test('C11: caller tries to resubmit round 1 after force-push -> refused', () => {
  const ledger = { entries: [{ round: 1, headSha: WRONG_SHA }], halted: false, haltCleared: false, expectedRound: 2 };
  const r = classify(baseCtx({ ledger, round: 1, headSha: HEAD_SHA }));
  assertEqual(r.bucket, 'INVALID_SHAPE');
  assertEqual(r.reason, 'ROUND_DISAGREES_WITH_LEDGER');
});

// ── D12: fixed priority order ─────────────────────────────────────────────

test('D12: CODEX_ERROR takes priority over a simultaneous shape AND fence violation', () => {
  const text = blockText({ file: OUT_OF_FENCE_FILE }) + '\nstray text';
  const r = classify(baseCtx({ exitCode: 1, stdout: text }));
  assertEqual(r.bucket, 'CODEX_ERROR');
});

test('D12: empty stdout with exit 0 is also CODEX_ERROR', () => {
  const r = classify(baseCtx({ exitCode: 0, stdout: '' }));
  assertEqual(r.bucket, 'CODEX_ERROR');
  assertEqual(r.reason, 'EMPTY_STDOUT');
});

// ── D13: empty fence halts ────────────────────────────────────────────────

test('D13: zero changed files -> EMPTY_FENCE', () => {
  const r = classify(baseCtx({ fence: makeFence([]) }));
  assertEqual(r.bucket, 'EMPTY_FENCE');
});

// ── D14: draft PR halts, and outranks EMPTY_FENCE ────────────────────────

test('D14: draft PR -> DRAFT_PR', () => {
  const r = classify(baseCtx({ isDraft: true }));
  assertEqual(r.bucket, 'DRAFT_PR');
});

test('D14: draft PR takes priority over an also-empty fence', () => {
  const r = classify(baseCtx({ isDraft: true, fence: makeFence([]) }));
  assertEqual(r.bucket, 'DRAFT_PR');
});

// ── E15/E16: halt is durable and enforced on later runs ──────────────────

test('E15: rendered halt comment round-trips through parseLedger as halted', () => {
  const body = renderHaltComment({ prNumber: 42, round: 2, condition: 'ROUND_EXCEEDED' });
  const ledger = parseLedger([{ body }]);
  assertEqual(ledger.halted, true);
});

test('E16: HALTED outranks every other condition, including an otherwise-valid input', () => {
  const body = renderHaltComment({ prNumber: 42, round: 2, condition: 'ROUND_EXCEEDED' });
  const ledger = parseLedger([{ body }]);
  const r = classify(baseCtx({ ledger, isDraft: false, fence: FENCE, round: 1 }));
  assertEqual(r.bucket, 'HALTED');
});

test('E16: an owner halt-cleared comment lifts the halt', () => {
  const haltBody = renderHaltComment({ prNumber: 42, round: 2, condition: 'ROUND_EXCEEDED' });
  const ledger = parseLedger([{ body: haltBody }, { body: '<!-- codex-review-halt-cleared -->' }]);
  const r = classify(baseCtx({ ledger }));
  assert(r.bucket !== 'HALTED');
});

// ── F17: rearchitecture remedies are OUT_OF_FENCE_BLOCKER, not LEAD/BLOCK ─

test('F17: "extract" remedy on an in-fence file -> OUT_OF_FENCE_BLOCKER', () => {
  const text = blockText({ file: IN_FENCE_FILE, text: 'extract this into a new module' });
  const r = classify(baseCtx({ stdout: text }));
  assertEqual(r.bucket, 'OUT_OF_FENCE_BLOCKER');
  assertEqual(r.reason, 'REARCHITECTURE_REMEDY');
});

test('F17: "move to" remedy -> OUT_OF_FENCE_BLOCKER', () => {
  const text = blockText({ file: IN_FENCE_FILE, text: 'move to lib/new-home.js' });
  const r = classify(baseCtx({ stdout: text }));
  assertEqual(r.bucket, 'OUT_OF_FENCE_BLOCKER');
});

// ── Content-level round widening (escalation trigger) ─────────────────────

test('escalation: verdict ROUND field > 2 -> ROUND_EXCEEDED', () => {
  // ROUND: 3 in the verdict body itself, independent of the caller's --round.
  const text = ['SHA: ' + HEAD_SHA, 'VERDICT: APPROVE', 'SCOPE_RESPECTED: yes', 'ROUND: 3'].join('\n');
  const r = classify(baseCtx({ stdout: text }));
  assertEqual(r.bucket, 'ROUND_EXCEEDED');
  assertEqual(r.reason, 'VERDICT_ROUND_GT_2');
});

// ── R3: caller round out of {1,2} refused before invoking Codex ─────────

test('R3: round 0 -> INVALID_SHAPE (ROUND_OUT_OF_RANGE)', () => {
  const r = classify(baseCtx({ round: 0, ledger: { entries: [], halted: false, haltCleared: false, expectedRound: 1 } }));
  assertEqual(r.bucket, 'INVALID_SHAPE');
  assertEqual(r.reason, 'ROUND_OUT_OF_RANGE');
});

test('R3: round 3 -> INVALID_SHAPE (ROUND_OUT_OF_RANGE)', () => {
  const r = classify(baseCtx({ round: 3 }));
  assertEqual(r.bucket, 'INVALID_SHAPE');
  assertEqual(r.reason, 'ROUND_OUT_OF_RANGE');
});

// ── Totality table: 64 generated inputs, each asserting exactly one bucket ─

function ledgerForRound(round) {
  if (round === 1) return baseLedger();
  return { entries: [{ round: 1, headSha: 'prior-sha' }], halted: false, haltCleared: false, expectedRound: 2 };
}

function genVerdictText({ round, kind, shaOk, fenceOk, scopeOk }) {
  const sha = shaOk ? HEAD_SHA : WRONG_SHA;
  if (kind === 'APPROVE') return approveText({ sha, round, scope: scopeOk ? 'yes' : 'no' });
  const file = fenceOk ? IN_FENCE_FILE : OUT_OF_FENCE_FILE;
  return blockText({ sha, round, file });
}

function expectedBucketFor({ exitCode, shaOk, kind, fenceOk, scopeOk }) {
  if (exitCode !== 0) return 'CODEX_ERROR';
  if (!shaOk) return 'INVALID_SHAPE';
  if (kind === 'BLOCK') {
    if (!fenceOk) return 'OUT_OF_FENCE_BLOCKER';
    return 'VALID_BLOCK';
  }
  // APPROVE
  if (!scopeOk) return 'INVALID_SHAPE';
  return 'VALID_APPROVE';
}

let generatedCount = 0;
for (const round of [1, 2]) {
  for (const kind of ['APPROVE', 'BLOCK']) {
    for (const shaOk of [true, false]) {
      for (const fenceOk of [true, false]) {
        for (const scopeOk of [true, false]) {
          for (const exitCode of [0, 1]) {
            generatedCount++;
            const dims = { round, kind, shaOk, fenceOk, scopeOk, exitCode };
            const label = `totality[${generatedCount}]: ${JSON.stringify(dims)}`;
            test(label, () => {
              const stdout = genVerdictText(dims);
              const ctx = baseCtx({
                round,
                stdout,
                exitCode,
                ledger: ledgerForRound(round),
              });
              const r = classify(ctx);
              const expected = expectedBucketFor(dims);
              assertEqual(r.bucket, expected, label);
            });
          }
        }
      }
    }
  }
}

// ── parseVerdict / sha256 sanity ──────────────────────────────────────────

test('parseVerdict: well-formed BLOCK verdict parses findings', () => {
  const v = parseVerdict(blockText());
  assert(v.valid);
  assertEqual(v.findings.length, 1);
  assertEqual(v.findings[0].severity, 'BLOCKER');
});

test('sha256 is deterministic', () => {
  assertEqual(sha256('x'), sha256('x'));
  assert(sha256('x') !== sha256('y'));
});

// ── Report ──────────────────────────────────────────────────────────────

console.log(`\ncodex-review tests: ${passed} passed, ${failed} failed (generated: ${generatedCount})`);
if (failed > 0) {
  console.error(`\n${failed} failure(s):`);
  for (const f of failures) console.error(`  - ${f.label}: ${f.err.message}`);
  process.exit(1);
}
process.exit(0);
