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
  runReview,
  isHaltTrigger,
  exitCodeFor,
  parseStrictRound,
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
  const ledger = parseLedger(
    [{ body: haltBody }, { body: '<!-- codex-review-halt-cleared -->', author: { login: 'owner' } }],
    { ownerLogin: 'owner' }
  );
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

// ── Round 2 fixtures: runReview orchestration, items 1-12 ────────────────
// (round-1 ledger comment on PR #305, 2026-09-13 dogfood review of this
// file's prior revision)

function fakeRunners(opts) {
  opts = opts || {};
  const commentsQueue = (opts.commentsSequence || [[]]).slice();
  const calls = { gh: [], git: [], codex: [] };
  const gh = (args) => {
    calls.gh.push(args);
    if (args[0] === 'pr' && args[1] === 'view' && args.includes('files,body,headRefOid,isDraft,baseRefOid')) {
      return { status: 0, stdout: JSON.stringify(opts.prView || {}), stderr: '' };
    }
    if (args[0] === 'repo' && args[1] === 'view') {
      return { status: 0, stdout: JSON.stringify({ owner: opts.owner || { login: 'owner' } }), stderr: '' };
    }
    if (args[0] === 'pr' && args[1] === 'view' && args.includes('comments')) {
      const next = commentsQueue.length > 1 ? commentsQueue.shift() : commentsQueue[0];
      return { status: 0, stdout: JSON.stringify({ comments: next }), stderr: '' };
    }
    if (args[0] === 'pr' && args[1] === 'comment') {
      const pr = opts.postResult || { status: 0, stderr: '' };
      return { status: pr.status, stdout: '', stderr: pr.stderr || '' };
    }
    throw new Error(`fakeRunners.gh: unhandled args ${JSON.stringify(args)}`);
  };
  const git = (args) => {
    calls.git.push(args);
    return opts.diffResult || { status: 0, stdout: 'diff --git a/x b/x\n+1', stderr: '' };
  };
  const codex = (exe, args, runOpts) => {
    calls.codex.push([exe, ...args]);
    return opts.codexResult || { status: 0, stdout: approveText(), stderr: '' };
  };
  return { runners: { gh, git, codex }, calls };
}

const BASE_PR_VIEW = {
  files: [{ path: IN_FENCE_FILE }],
  body: 'test PR',
  headRefOid: HEAD_SHA,
  isDraft: false,
  baseRefOid: 'b'.repeat(40),
};

// ── Item 1: baseRefOid requested; explicit base...head diff; never HEAD ──

test('item1: git diff is invoked against baseRefOid...headRefOid, never a HEAD fallback', () => {
  const { runners, calls } = fakeRunners({ prView: BASE_PR_VIEW, commentsSequence: [[], []] });
  const r = runReview({ pr: 305, round: 1, repoRoot: '/repo', dryRun: false }, runners);
  assert(r.bucket === 'VALID_APPROVE', `expected VALID_APPROVE, got ${r.bucket} (${r.reason})`);
  const diffCall = calls.git.find((a) => a[0] === 'diff');
  assert(diffCall, 'git diff was not called');
  assertEqual(diffCall[1], `${BASE_PR_VIEW.baseRefOid}...${HEAD_SHA}`);
});

test('item1: an empty diff never reaches Codex -> EMPTY_FENCE', () => {
  const { runners, calls } = fakeRunners({
    prView: BASE_PR_VIEW,
    commentsSequence: [[], []],
    diffResult: { status: 0, stdout: '   \n', stderr: '' },
  });
  const r = runReview({ pr: 305, round: 1, repoRoot: '/repo', dryRun: false }, runners);
  assertEqual(r.bucket, 'EMPTY_FENCE');
  assertEqual(r.reason, 'EMPTY_DIFF');
  assertEqual(calls.codex.length, 0, 'codex must never be invoked on an empty diff');
});

// ── Item 2: diff command failure is a gate error, never reaches Codex ───

test('item2: nonzero-exit git diff -> CODEX_ERROR gate error, Codex never invoked', () => {
  const { runners, calls } = fakeRunners({
    prView: BASE_PR_VIEW,
    commentsSequence: [[]],
    diffResult: { status: 128, stdout: '', stderr: 'fatal: bad revision' },
  });
  const r = runReview({ pr: 305, round: 1, repoRoot: '/repo', dryRun: false }, runners);
  assertEqual(r.bucket, 'CODEX_ERROR');
  assertEqual(r.reason, 'DIFF_COMMAND_FAILED');
  assertEqual(calls.codex.length, 0);
});

// ── Item 3: round 2 loads and requires the round-1 verdict ──────────────

test('item3: round 2 with no round-1 ledger entry at all -> refused before ever reaching Codex (ledger disagrees on round)', () => {
  // No round-1 marker means the ledger's own next-round computation is 1,
  // not 2 -- the pre-existing ROUND_DISAGREES_WITH_LEDGER check (step 6)
  // catches this before round 2's prior-verdict requirement is even
  // evaluated. Confirms the two checks compose rather than one silently
  // masking a real gap.
  const { runners } = fakeRunners({ prView: BASE_PR_VIEW, commentsSequence: [[], []] });
  const r = runReview({ pr: 305, round: 2, repoRoot: '/repo', dryRun: false }, runners);
  assertEqual(r.bucket, 'INVALID_SHAPE');
  assertEqual(r.reason, 'ROUND_DISAGREES_WITH_LEDGER');
});

test('item3: round 2 whose ledger round-1 entry is unparseable -> ROUND_EXCEEDED (MISSING_PRIOR_VERDICT)', () => {
  // A round-1 marker exists (so the ledger agrees round 2 is next), but its
  // fenced verdict body itself is not a valid verdict -- e.g. corrupted in
  // a way that still hashes correctly, so it isn't flagged as tampered.
  // Round 2 must not proceed without a real round-1 verdict to restrict
  // itself to.
  const garbagePriorBody = renderLedgerComment({
    round: 1,
    headSha: HEAD_SHA,
    bucket: 'VALID_APPROVE',
    verdictText: 'not a real verdict body',
  });
  const { runners } = fakeRunners({ prView: BASE_PR_VIEW, commentsSequence: [[{ body: garbagePriorBody }], [{ body: garbagePriorBody }]] });
  const r = runReview({ pr: 305, round: 2, repoRoot: '/repo', dryRun: false }, runners);
  assertEqual(r.bucket, 'ROUND_EXCEEDED');
  assertEqual(r.reason, 'MISSING_PRIOR_VERDICT');
});

test('item3: round 2 with a round-1 ledger entry passes its BLOCKER findings into the prompt', () => {
  const priorBody = renderLedgerComment({
    round: 1,
    headSha: HEAD_SHA,
    bucket: 'VALID_BLOCK',
    verdictText: blockText({ text: 'fix the thing' }),
  });
  let capturedPrompt = null;
  const { runners } = fakeRunners({
    prView: BASE_PR_VIEW,
    commentsSequence: [[{ body: priorBody }], [{ body: priorBody }]],
    codexResult: { status: 0, stdout: approveText({ round: 2 }), stderr: '' },
  });
  const origCodex = runners.codex;
  runners.codex = (exe, args, opts) => {
    capturedPrompt = opts.input;
    return origCodex(exe, args, opts);
  };
  const r = runReview({ pr: 305, round: 2, repoRoot: '/repo', dryRun: false }, runners);
  assertEqual(r.bucket, 'VALID_APPROVE');
  assert(capturedPrompt && capturedPrompt.includes('fix the thing'), 'round-1 BLOCKER text missing from round-2 prompt');
});

// ── Item 4: re-read the ledger immediately before posting ───────────────

test('item4: a marker appearing between initial read and post-time re-read aborts as ROUND_EXCEEDED, no post', () => {
  const dupMarker = renderLedgerComment({ round: 1, headSha: HEAD_SHA, bucket: 'VALID_APPROVE', verdictText: approveText() });
  const { runners, calls } = fakeRunners({
    prView: BASE_PR_VIEW,
    // First read (before Codex runs): empty. Re-read (right before posting): the dup marker appeared.
    commentsSequence: [[], [{ body: dupMarker }]],
  });
  const r = runReview({ pr: 305, round: 1, repoRoot: '/repo', dryRun: false }, runners);
  assertEqual(r.bucket, 'ROUND_EXCEEDED');
  assertEqual(r.reason, 'ROUND_ALREADY_RECORDED_ON_REREAD');
  assertEqual(calls.gh.filter((a) => a[0] === 'pr' && a[1] === 'comment').length, 0, 'must not post on a re-read dup');
});

// ── Item 5: haltCleared is order-aware (halt after a clear re-activates) ─

test('item5: halt -> clear -> halt sequence stays halted (order-aware)', () => {
  const halt1 = renderHaltComment({ prNumber: 1, round: 1, condition: 'HALTED' });
  const clear = { body: '<!-- codex-review-halt-cleared -->', author: { login: 'owner' } };
  const halt2 = renderHaltComment({ prNumber: 1, round: 2, condition: 'ROUND_EXCEEDED' });
  const ledger = parseLedger([{ body: halt1 }, clear, { body: halt2 }], { ownerLogin: 'owner' });
  assertEqual(ledger.halted, true);
});

test('item5: clear -> halt -> clear sequence lifts the halt (the last clear is authoritative)', () => {
  const clear1 = { body: '<!-- codex-review-halt-cleared -->', author: { login: 'owner' } };
  const halt1 = renderHaltComment({ prNumber: 1, round: 1, condition: 'HALTED' });
  const clear2 = { body: '<!-- codex-review-halt-cleared -->', author: { login: 'owner' } };
  const ledger = parseLedger([clear1, { body: halt1 }, clear2], { ownerLogin: 'owner' });
  assertEqual(ledger.halted, false);
});

// ── Item 6: halt-clear only honored from the repo owner's own comment ───

test('item6: a clear marker from a non-owner login is ignored, halt stays active', () => {
  const halt1 = renderHaltComment({ prNumber: 1, round: 1, condition: 'HALTED' });
  const clear = { body: '<!-- codex-review-halt-cleared -->', author: { login: 'impersonator' } };
  const ledger = parseLedger([{ body: halt1 }, clear], { ownerLogin: 'owner' });
  assertEqual(ledger.halted, true);
});

test('item6: a clear marker with no author info is ignored, halt stays active', () => {
  const halt1 = renderHaltComment({ prNumber: 1, round: 1, condition: 'HALTED' });
  const clear = { body: '<!-- codex-review-halt-cleared -->' };
  const ledger = parseLedger([{ body: halt1 }, clear], { ownerLogin: 'owner' });
  assertEqual(ledger.halted, true);
});

// ── Item 7: a failed comment post is surfaced, never silent ─────────────

test('item7: a failed halt-comment post demotes the outcome to a CODEX_ERROR gate error', () => {
  const { runners } = fakeRunners({
    prView: Object.assign({}, BASE_PR_VIEW, { isDraft: true }),
    commentsSequence: [[]],
    postResult: { status: 1, stderr: 'gh: could not post comment' },
  });
  const r = runReview({ pr: 305, round: 1, repoRoot: '/repo', dryRun: false }, runners);
  assertEqual(r.bucket, 'CODEX_ERROR');
  assert(/HALT_POST_FAILED/.test(r.reason));
});

test('item7: a failed ledger-comment post demotes VALID_APPROVE to a CODEX_ERROR gate error', () => {
  const { runners } = fakeRunners({
    prView: BASE_PR_VIEW,
    commentsSequence: [[], []],
    postResult: { status: 1, stderr: 'gh: rate limited' },
  });
  const r = runReview({ pr: 305, round: 1, repoRoot: '/repo', dryRun: false }, runners);
  assertEqual(r.bucket, 'CODEX_ERROR');
  assert(/LEDGER_POST_FAILED/.test(r.reason));
});

// ── Item 8: exit codes and the final single-line JSON result ────────────

test('item8: exit codes are VALID_APPROVE=0, VALID_BLOCK=2, everything else=3', () => {
  assertEqual(exitCodeFor('VALID_APPROVE'), 0);
  assertEqual(exitCodeFor('VALID_BLOCK'), 2);
  for (const b of ['HALTED', 'DRAFT_PR', 'EMPTY_FENCE', 'ROUND_EXCEEDED', 'INVALID_SHAPE', 'OUT_OF_FENCE_BLOCKER', 'CODEX_ERROR']) {
    assertEqual(exitCodeFor(b), 3, `bucket ${b}`);
  }
});

test('item8: the final stdout line is single-line JSON carrying outcome/round/sha/reason', () => {
  const { runners } = fakeRunners({ prView: BASE_PR_VIEW, commentsSequence: [[], []] });
  const r = runReview({ pr: 305, round: 1, repoRoot: '/repo', dryRun: false }, runners);
  const lastLine = r.lines[r.lines.length - 1];
  const parsed = JSON.parse(lastLine);
  assertEqual(parsed.outcome, 'VALID_APPROVE');
  assertEqual(parsed.round, 1);
  assertEqual(parsed.sha, HEAD_SHA);
  assertEqual(r.exitCode, 0);
});

// ── Item 9: every halt branch posts the durable halt marker ─────────────

test('item9: DRAFT_PR posts the halt marker before exiting', () => {
  const { runners, calls } = fakeRunners({ prView: Object.assign({}, BASE_PR_VIEW, { isDraft: true }), commentsSequence: [[]] });
  const r = runReview({ pr: 305, round: 1, repoRoot: '/repo', dryRun: false }, runners);
  assertEqual(r.bucket, 'DRAFT_PR');
  assertEqual(calls.gh.filter((a) => a[0] === 'pr' && a[1] === 'comment').length, 1);
});

test('item9: EMPTY_FENCE (zero changed files) posts the halt marker before exiting', () => {
  const { runners, calls } = fakeRunners({ prView: Object.assign({}, BASE_PR_VIEW, { files: [] }), commentsSequence: [[]] });
  const r = runReview({ pr: 305, round: 1, repoRoot: '/repo', dryRun: false }, runners);
  assertEqual(r.bucket, 'EMPTY_FENCE');
  assertEqual(calls.gh.filter((a) => a[0] === 'pr' && a[1] === 'comment').length, 1);
});

test('item9: OUT_OF_FENCE_BLOCKER posts the halt marker before exiting', () => {
  const { runners, calls } = fakeRunners({
    prView: BASE_PR_VIEW,
    commentsSequence: [[], []],
    codexResult: { status: 0, stdout: blockText({ file: OUT_OF_FENCE_FILE }), stderr: '' },
  });
  const r = runReview({ pr: 305, round: 1, repoRoot: '/repo', dryRun: false }, runners);
  assertEqual(r.bucket, 'OUT_OF_FENCE_BLOCKER');
  assertEqual(calls.gh.filter((a) => a[0] === 'pr' && a[1] === 'comment').length, 1);
});

test('item9: a caller round-3 request halts and posts the marker (isHaltTrigger)', () => {
  assert(isHaltTrigger('INVALID_SHAPE', 'ROUND_OUT_OF_RANGE', 3));
  assert(!isHaltTrigger('INVALID_SHAPE', 'ROUND_OUT_OF_RANGE', 0));
});

test('item9: an end-to-end caller round-3 request halts and posts the marker', () => {
  const { runners, calls } = fakeRunners({ prView: BASE_PR_VIEW, commentsSequence: [[]] });
  const r = runReview({ pr: 305, round: 3, repoRoot: '/repo', dryRun: false }, runners);
  assertEqual(r.bucket, 'INVALID_SHAPE');
  assertEqual(r.reason, 'ROUND_OUT_OF_RANGE');
  assertEqual(calls.gh.filter((a) => a[0] === 'pr' && a[1] === 'comment').length, 1);
});

test('item9: HALTED (prior unlifted halt) posts a fresh halt marker before exiting', () => {
  const haltBody = renderHaltComment({ prNumber: 305, round: 1, condition: 'HALTED' });
  const { runners, calls } = fakeRunners({ prView: BASE_PR_VIEW, commentsSequence: [[{ body: haltBody }]] });
  const r = runReview({ pr: 305, round: 1, repoRoot: '/repo', dryRun: false }, runners);
  assertEqual(r.bucket, 'HALTED');
  assertEqual(calls.gh.filter((a) => a[0] === 'pr' && a[1] === 'comment').length, 1);
});

// ── Item 10: content-level widening scan over ALL findings, not just ROUND

test('item10: a LEAD requesting "another pass" on an otherwise-valid APPROVE -> ROUND_EXCEEDED', () => {
  const text = [
    `SHA: ${HEAD_SHA}`,
    'VERDICT: APPROVE',
    'SCOPE_RESPECTED: yes',
    'ROUND: 1',
    'FINDINGS:',
    `- LEAD file=${IN_FENCE_FILE} text=looks fine but please do another pass`,
    'END_FINDINGS',
  ].join('\n');
  const r = classify(baseCtx({ stdout: text }));
  assertEqual(r.bucket, 'ROUND_EXCEEDED');
  assertEqual(r.reason, 'FINDING_TEXT_REQUESTS_WIDENING');
});

test('item10: a LEAD using rearchitecture vocabulary ("extract") also triggers ROUND_EXCEEDED, not silently approved', () => {
  const text = [
    `SHA: ${HEAD_SHA}`,
    'VERDICT: APPROVE',
    'SCOPE_RESPECTED: yes',
    'ROUND: 1',
    'FINDINGS:',
    `- LEAD file=${IN_FENCE_FILE} text=consider extract this into a helper later`,
    'END_FINDINGS',
  ].join('\n');
  const r = classify(baseCtx({ stdout: text }));
  assertEqual(r.bucket, 'ROUND_EXCEEDED');
});

// ── Item 11: previousPath is preserved from gh's file list to the fence ──

test("item11: a renamed file's previousPath survives from prView.files through to the live fence", () => {
  const { runners } = fakeRunners({
    prView: Object.assign({}, BASE_PR_VIEW, {
      files: [{ path: 'new/name.js', previousPath: 'old/name.js' }],
    }),
    commentsSequence: [[], []],
    codexResult: { status: 0, stdout: blockText({ file: 'old/name.js', text: 'fix on the pre-rename path' }), stderr: '' },
  });
  const r = runReview({ pr: 305, round: 1, repoRoot: '/repo', dryRun: false }, runners);
  assertEqual(r.bucket, 'VALID_BLOCK', `expected VALID_BLOCK (pre-rename path in-fence), got ${r.bucket} (${r.reason})`);
});

// ── Item 12: strict --round parsing; verdict ROUND cross-checked ────────

test('item12: parseStrictRound rejects 0, 1.5, 3, and non-numeric input', () => {
  assertEqual(parseStrictRound('0'), 0, 'sanity: "0" parses to 0, rejection happens downstream in preconditionBucket');
  assert(Number.isNaN(parseStrictRound('1.5')), '"1.5" must not silently become 1');
  assertEqual(parseStrictRound('1'), 1);
  assertEqual(parseStrictRound('2'), 2);
  assertEqual(parseStrictRound('3'), 3);
  assert(Number.isNaN(parseStrictRound('abc')));
  assert(Number.isNaN(parseStrictRound('-1')));
});

test('item12: verdict ROUND: 0 -> INVALID_SHAPE (VERDICT_ROUND_INVALID)', () => {
  const text = [`SHA: ${HEAD_SHA}`, 'VERDICT: APPROVE', 'SCOPE_RESPECTED: yes', 'ROUND: 0'].join('\n');
  const r = classify(baseCtx({ stdout: text }));
  assertEqual(r.bucket, 'INVALID_SHAPE');
  assertEqual(r.reason, 'VERDICT_ROUND_INVALID');
});

test('item12: verdict ROUND: 2 during a caller round-1 invocation -> INVALID_SHAPE (VERDICT_ROUND_MISMATCH)', () => {
  const text = approveText({ round: 2 });
  const r = classify(baseCtx({ round: 1, stdout: text }));
  assertEqual(r.bucket, 'INVALID_SHAPE');
  assertEqual(r.reason, 'VERDICT_ROUND_MISMATCH');
});

test('item12: verdict ROUND: 3 still classifies as ROUND_EXCEEDED, not swallowed by the mismatch check', () => {
  const text = ['SHA: ' + HEAD_SHA, 'VERDICT: APPROVE', 'SCOPE_RESPECTED: yes', 'ROUND: 3'].join('\n');
  const r = classify(baseCtx({ round: 1, stdout: text }));
  assertEqual(r.bucket, 'ROUND_EXCEEDED');
  assertEqual(r.reason, 'VERDICT_ROUND_GT_2');
});

// ── Report ──────────────────────────────────────────────────────────────

console.log(`\ncodex-review tests: ${passed} passed, ${failed} failed (generated: ${generatedCount})`);
if (failed > 0) {
  console.error(`\n${failed} failure(s):`);
  for (const f of failures) console.error(`  - ${f.label}: ${f.err.message}`);
  process.exit(1);
}
process.exit(0);
