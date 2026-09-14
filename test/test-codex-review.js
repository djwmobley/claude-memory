'use strict';

/**
 * test-codex-review.js — regression suite for scripts/codex-review.js
 * (docs/specs/codex-review-contract.md).
 *
 * Round 3 (2026-09-13) rewrites this suite for the amended spec that fixed
 * the 4 round-2 blockers that survived the round cap:
 *   (a) post-run ledger re-check before posting APPROVE
 *   (b) owner-anchored HALT/HALT_CLEAR markers (first-content, round+sha)
 *   (c) structured ```codex-verdict``` block, replacing free-text findings
 *   (d) fence built from local `git diff --name-status -M -z`, never
 *       `gh pr view --json files`
 *
 * Pure-function tests only: no `gh`, no `codex`, no network, no DB.
 *
 * Usage: node test/test-codex-review.js
 * Exit 0 = all pass; nonzero = any failure.
 */

const path = require('path');
const {
  normalizePath,
  buildFence,
  parseNameStatusZ,
  computeFence,
  stripQuotedAndFencedBlocks,
  classifyStructuredVerdict,
  classify,
  preconditionBucket,
  recognizeAnchoredMarker,
  renderLedgerComment,
  renderHaltComment,
  parseLedger,
  sha256,
  reclassifyLedgerBeforePosting,
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
const OTHER_SHA = 'b'.repeat(40);
const FENCE_FILES = ['scripts/codex-review.js', 'test/test-codex-review.js', 'docs/specs/codex-review-contract.md'];
const IN_FENCE_FILE = FENCE_FILES[0];

function makeFence(paths, platform) {
  return buildFence(
    paths.map((p) => (typeof p === 'string' ? { path: p } : p)),
    platform
  );
}
const FENCE_OK = { ok: true, fence: makeFence(FENCE_FILES) };

function baseLedger() {
  return { entries: [], halted: false, haltCleared: false, haltReason: null, expectedRound: 1 };
}

function approveStdout({ scopeRequest = 'none', findings = 0, prose = '' } = {}) {
  const parts = [];
  if (prose) parts.push(prose);
  parts.push('```codex-verdict', 'verdict: APPROVE', `scope_request: ${scopeRequest}`, `findings: ${findings}`, '```');
  return parts.join('\n');
}
function blockStdout({ findings = 1, prose = '' } = {}) {
  const parts = [];
  if (prose) parts.push(prose);
  parts.push('```codex-verdict', 'verdict: BLOCK', 'scope_request: none', `findings: ${findings}`, '```');
  return parts.join('\n');
}

function baseCtx(overrides = {}) {
  const stdout = overrides.stdout !== undefined ? overrides.stdout : approveStdout();
  return {
    exitCode: overrides.exitCode !== undefined ? overrides.exitCode : 0,
    stdout,
    fenceResult: overrides.fenceResult !== undefined ? overrides.fenceResult : FENCE_OK,
    headSha: overrides.headSha !== undefined ? overrides.headSha : HEAD_SHA,
    round: overrides.round !== undefined ? overrides.round : 1,
    ledger: overrides.ledger !== undefined ? overrides.ledger : baseLedger(),
    isDraft: overrides.isDraft !== undefined ? overrides.isDraft : false,
  };
}

// normalized {author:{login}} shape, for direct parseLedger/recognizeAnchoredMarker tests
function nc(body, login, id) {
  return { id: id !== undefined ? id : Math.random(), body, author: login !== undefined ? { login } : undefined };
}
// raw REST {user:{login}} shape, for fakeRunners fixtures consumed via fetchAllPrComments
function rc(body, login, id) {
  return { id, body, user: login !== undefined ? { login } : undefined };
}

// ── normalizePath / buildFence (B5/B7/B6) ────────────────────────────────

test('B5: leading ./ and doubled slashes normalize away', () => {
  assertEqual(normalizePath('./a//b/c', 'linux'), 'a/b/c');
});
test('B7: win32 comparison is case-insensitive', () => {
  assertEqual(normalizePath('Scripts/Foo.JS', 'win32'), normalizePath('scripts/foo.js', 'win32'));
});
test('B7: non-win32 comparison is case-sensitive', () => {
  assert(normalizePath('Scripts/Foo.JS', 'linux') !== normalizePath('scripts/foo.js', 'linux'));
});
test('B6: renamed file contributes both previous and current path to fence', () => {
  const fence = makeFence([{ path: 'new/name.js', previousPath: 'old/name.js' }]);
  assert(fence.has('old/name.js'));
  assert(fence.has('new/name.js'));
});

// ── item d: fence built from `git diff --name-status -M -z` ─────────────

test('parseNameStatusZ: simple A/M/D records', () => {
  const raw = `A\0new.js\0M\0changed.js\0D\0gone.js\0`;
  const r = parseNameStatusZ(raw);
  assert(r.ok);
  assertEqual(r.files.length, 3);
  assertEqual(r.files[0].path, 'new.js');
  assertEqual(r.files[1].path, 'changed.js');
  assertEqual(r.files[2].path, 'gone.js');
});

test('parseNameStatusZ: no changes -> ok, zero files', () => {
  const r = parseNameStatusZ('');
  assert(r.ok);
  assertEqual(r.files.length, 0);
});

test("required: rename R087 with a space in the path parsed via -z -> both paths fenced", () => {
  const raw = `R087\0old dir/old name.js\0new dir/new name.js\0`;
  const r = parseNameStatusZ(raw);
  assert(r.ok, r.reason);
  assertEqual(r.files.length, 1);
  assertEqual(r.files[0].path, 'new dir/new name.js');
  assertEqual(r.files[0].previousPath, 'old dir/old name.js');
  const fence = buildFence(r.files);
  assert(fence.has('old dir/old name.js'));
  assert(fence.has('new dir/new name.js'));
});

test('parseNameStatusZ: unknown status letter -> UNKNOWN_STATUS, not silently skipped', () => {
  const raw = `U\0conflicted.js\0`;
  const r = parseNameStatusZ(raw);
  assertEqual(r.ok, false);
  assertEqual(r.reason, 'UNKNOWN_STATUS_U');
});

test('parseNameStatusZ: short record (status with no following path) -> SHORT_RECORD', () => {
  const r = parseNameStatusZ('M\0');
  assertEqual(r.ok, false);
  assertEqual(r.reason, 'SHORT_RECORD');
});

test('parseNameStatusZ: short rename record (missing new path) -> SHORT_RECORD', () => {
  const r = parseNameStatusZ('R100\0old.js\0');
  assertEqual(r.ok, false);
  assertEqual(r.reason, 'SHORT_RECORD');
});

test('computeFence: git diff failure -> ok:false DIFF_COMMAND_FAILED', () => {
  const runners = { git: () => ({ status: 128, stdout: '', stderr: 'fatal: bad revision' }) };
  const r = computeFence({ baseRefOid: OTHER_SHA, headSha: HEAD_SHA, repoRoot: '/repo', runners });
  assertEqual(r.ok, false);
  assertEqual(r.reason, 'DIFF_COMMAND_FAILED');
});

test('required: git failure -> NEEDS_OWNER (via preconditionBucket)', () => {
  const fenceResult = { ok: false, reason: 'DIFF_COMMAND_FAILED' };
  const pc = preconditionBucket({ fenceResult, isDraft: false, ledger: baseLedger(), round: 1, headSha: HEAD_SHA });
  assertEqual(pc.bucket, 'NEEDS_OWNER');
  assert(/FENCE_UNKNOWN_DIFF_COMMAND_FAILED/.test(pc.reason));
});

test('computeFence: unknown status letter propagates as NEEDS_OWNER upstream', () => {
  const runners = { git: () => ({ status: 0, stdout: 'X\0weird.js\0', stderr: '' }) };
  const r = computeFence({ baseRefOid: OTHER_SHA, headSha: HEAD_SHA, repoRoot: '/repo', runners });
  assertEqual(r.ok, false);
  assertEqual(r.reason, 'UNKNOWN_STATUS_X');
});

// ── item b: marker anchoring (first non-whitespace content, owner-only,
// round+sha, never inside a fence/quote/indented block, never co-mingled
// with a ledger marker) ───────────────────────────────────────────────────

test('marker anchoring: well-formed owner halt marker is recognized as first content', () => {
  const body = `<!-- codex-review-halt round:1 sha:${HEAD_SHA} -->\nsome text`;
  const r = recognizeAnchoredMarker(nc(body, 'owner'), 'owner', /^<!--\s*codex-review-halt\s+round:(\d+)\s+sha:([0-9a-f]{40})\s*-->/);
  assert(r);
  assertEqual(r.round, 1);
  assertEqual(r.headSha, HEAD_SHA);
});

test('required: marker inside a ~~~ fence -> not recognized', () => {
  const body = `~~~\n<!-- codex-review-halt-cleared round:1 sha:${HEAD_SHA} -->\n~~~`;
  const clearRe = /^<!--\s*codex-review-halt-cleared\s+round:(\d+)\s+sha:([0-9a-f]{40})\s*-->/;
  const r = recognizeAnchoredMarker(nc(body, 'owner'), 'owner', clearRe);
  assertEqual(r, null);
});

test('required: marker inside an indented (4-space) code block -> not recognized', () => {
  const body = `    <!-- codex-review-halt-cleared round:1 sha:${HEAD_SHA} -->`;
  const clearRe = /^<!--\s*codex-review-halt-cleared\s+round:(\d+)\s+sha:([0-9a-f]{40})\s*-->/;
  const r = recognizeAnchoredMarker(nc(body, 'owner'), 'owner', clearRe);
  assertEqual(r, null);
});

test('marker anchoring: marker not the FIRST content (preceded by prose) -> not recognized', () => {
  const body = `Note:\n<!-- codex-review-halt-cleared round:1 sha:${HEAD_SHA} -->`;
  const clearRe = /^<!--\s*codex-review-halt-cleared\s+round:(\d+)\s+sha:([0-9a-f]{40})\s*-->/;
  const r = recognizeAnchoredMarker(nc(body, 'owner'), 'owner', clearRe);
  assertEqual(r, null);
});

test('marker anchoring: non-owner author -> not recognized (applies to HALT too, not just CLEAR)', () => {
  const body = `<!-- codex-review-halt round:1 sha:${HEAD_SHA} -->`;
  const haltRe = /^<!--\s*codex-review-halt\s+round:(\d+)\s+sha:([0-9a-f]{40})\s*-->/;
  const r = recognizeAnchoredMarker(nc(body, 'impersonator'), 'owner', haltRe);
  assertEqual(r, null);
});

test('required: a clear body that also contains a ledger outcome marker -> not a clear', () => {
  const ledgerLine = `<!-- codex-review-round:1 sha:${HEAD_SHA} hash:deadbeef -->`;
  const body = `${ledgerLine}\n<!-- codex-review-halt-cleared round:1 sha:${HEAD_SHA} -->`;
  const clearRe = /^<!--\s*codex-review-halt-cleared\s+round:(\d+)\s+sha:([0-9a-f]{40})\s*-->/;
  const r = recognizeAnchoredMarker(nc(body, 'owner'), 'owner', clearRe);
  assertEqual(r, null);
});

// ── parseLedger: hash tamper detection, halt/clear order-awareness ──────

test('parseLedger: unedited ledger comment hash matches -> not tampered', () => {
  const body = renderLedgerComment({ round: 1, headSha: HEAD_SHA, bucket: 'VALID_APPROVE', verdictText: approveStdout() });
  const ledger = parseLedger([nc(body, 'owner')]);
  assertEqual(ledger.halted, false);
});

test('parseLedger: edited ledger comment body (hash mismatch) halts', () => {
  const verdictText = approveStdout();
  const body = renderLedgerComment({ round: 1, headSha: HEAD_SHA, bucket: 'VALID_APPROVE', verdictText });
  const tampered = body.replace(verdictText, verdictText.replace('APPROVE', 'BLOCK'));
  const ledger = parseLedger([nc(tampered, 'owner')]);
  assertEqual(ledger.halted, true);
  assertEqual(ledger.haltReason, 'LEDGER_TAMPERED');
});

test('parseLedger: ledger comment whose verdict text itself contains a ```codex-verdict``` fence hashes correctly (sentinel wrap, not backtick counting)', () => {
  const verdictText = approveStdout({ prose: 'Looks fine.' });
  const body = renderLedgerComment({ round: 1, headSha: HEAD_SHA, bucket: 'VALID_APPROVE', verdictText });
  const ledger = parseLedger([nc(body, 'owner')]);
  assertEqual(ledger.halted, false);
  assertEqual(ledger.entries[0].verdictText, verdictText.trim());
});

test('halt -> matching-key clear (owner, round+sha match) -> lifted', () => {
  const halt = renderHaltComment({ prNumber: 1, round: 1, headSha: HEAD_SHA, condition: 'X' });
  const clear = `<!-- codex-review-halt-cleared round:1 sha:${HEAD_SHA} -->`;
  const ledger = parseLedger([nc(halt, 'owner'), nc(clear, 'owner')], { ownerLogin: 'owner' });
  assertEqual(ledger.halted, false);
});

test('required: round/sha mismatch on clear -> HALT stays', () => {
  const halt = renderHaltComment({ prNumber: 1, round: 1, headSha: HEAD_SHA, condition: 'X' });
  const wrongClear = `<!-- codex-review-halt-cleared round:2 sha:${HEAD_SHA} -->`; // round mismatch
  const ledger = parseLedger([nc(halt, 'owner'), nc(wrongClear, 'owner')], { ownerLogin: 'owner' });
  assertEqual(ledger.halted, true);
});

test('halt -> clear from non-owner login -> stays active', () => {
  const halt = renderHaltComment({ prNumber: 1, round: 1, headSha: HEAD_SHA, condition: 'X' });
  const clear = `<!-- codex-review-halt-cleared round:1 sha:${HEAD_SHA} -->`;
  const ledger = parseLedger([nc(halt, 'owner'), nc(clear, 'impersonator')], { ownerLogin: 'owner' });
  assertEqual(ledger.halted, true);
});

test('halt -> clear with no author info -> stays active', () => {
  const halt = renderHaltComment({ prNumber: 1, round: 1, headSha: HEAD_SHA, condition: 'X' });
  const clear = `<!-- codex-review-halt-cleared round:1 sha:${HEAD_SHA} -->`;
  const ledger = parseLedger([nc(halt, 'owner'), nc(clear)], { ownerLogin: 'owner' });
  assertEqual(ledger.halted, true);
});

test('halt -> clear -> halt (same round+sha) re-activates (order-aware)', () => {
  const halt1 = renderHaltComment({ prNumber: 1, round: 1, headSha: HEAD_SHA, condition: 'X' });
  const clear = `<!-- codex-review-halt-cleared round:1 sha:${HEAD_SHA} -->`;
  const halt2 = renderHaltComment({ prNumber: 1, round: 1, headSha: HEAD_SHA, condition: 'Y' });
  const ledger = parseLedger([nc(halt1, 'owner'), nc(clear, 'owner'), nc(halt2, 'owner')], { ownerLogin: 'owner' });
  assertEqual(ledger.halted, true);
});

test('required: an owner-authored ledger comment quoting the halt-clear marker -> not a clear', () => {
  const outstandingHalt = renderHaltComment({ prNumber: 1, round: 1, headSha: HEAD_SHA, condition: 'X' });
  const ledgerCommentQuotingClear = renderLedgerComment({
    round: 1,
    headSha: HEAD_SHA,
    bucket: 'VALID_BLOCK',
    verdictText: `A finding mentions: <!-- codex-review-halt-cleared round:1 sha:${HEAD_SHA} -->`,
  });
  const ledger = parseLedger([nc(outstandingHalt, 'owner'), nc(ledgerCommentQuotingClear, 'owner')], { ownerLogin: 'owner' });
  assertEqual(ledger.halted, true, 'the quoted marker inside a ledger comment must never clear the halt');
});

// ── item c: structured ```codex-verdict``` classification ───────────────

test('structured: clean APPROVE -> STRUCTURED_APPROVE', () => {
  const r = classifyStructuredVerdict(approveStdout());
  assertEqual(r.bucket, 'STRUCTURED_APPROVE');
});

test('structured: clean BLOCK -> STRUCTURED_BLOCK', () => {
  const r = classifyStructuredVerdict(blockStdout());
  assertEqual(r.bucket, 'STRUCTURED_BLOCK');
});

test('structured: missing verdict block -> NEEDS_OWNER', () => {
  const r = classifyStructuredVerdict('no block here at all');
  assertEqual(r.bucket, 'NEEDS_OWNER');
  assertEqual(r.reason, 'VERDICT_BLOCK_MISSING');
});

test('required: verdict block echoed inside a quoted fence plus a different real answer -> NEEDS_OWNER', () => {
  const echoed = '> ```codex-verdict\n> verdict: APPROVE\n> scope_request: none\n> findings: 0\n> ```';
  const real = approveStdout();
  const stdout = `${echoed}\n${real}`;
  const r = classifyStructuredVerdict(stdout);
  assertEqual(r.bucket, 'NEEDS_OWNER');
  assertEqual(r.reason, 'VERDICT_BLOCK_DUPLICATED');
});

test('required: "Approve" (wrong case) value -> NEEDS_OWNER', () => {
  const stdout = ['```codex-verdict', 'verdict: Approve', 'scope_request: none', 'findings: 0', '```'].join('\n');
  const r = classifyStructuredVerdict(stdout);
  assertEqual(r.bucket, 'NEEDS_OWNER');
  assertEqual(r.reason, 'VERDICT_UNKNOWN_VALUE');
});

test('required: zero-width character in a value -> NEEDS_OWNER', () => {
  const stdout = ['```codex-verdict', 'verdict: APPROVE​', 'scope_request: none', 'findings: 0', '```'].join('\n');
  const r = classifyStructuredVerdict(stdout);
  assertEqual(r.bucket, 'NEEDS_OWNER');
  assert(/FIELD_NON_ASCII|VERDICT_UNKNOWN_VALUE|UNRECOGNIZED_LINE/.test(r.reason));
});

test('required: APPROVE block with "security blocker" prose outside the block -> NEEDS_OWNER', () => {
  const stdout = `I found a security blocker but fixed it inline.\n${approveStdout()}`;
  const r = classifyStructuredVerdict(stdout);
  assertEqual(r.bucket, 'NEEDS_OWNER');
  assertEqual(r.reason, 'SEVERITY_WORD_IN_PROSE');
});

test('structured: APPROVE with scope_request=widen -> NEEDS_OWNER', () => {
  const r = classifyStructuredVerdict(approveStdout({ scopeRequest: 'widen' }));
  assertEqual(r.bucket, 'NEEDS_OWNER');
  assertEqual(r.reason, 'SCOPE_REQUEST_NOT_NONE');
});

test('structured: APPROVE with findings>0 -> NEEDS_OWNER', () => {
  const r = classifyStructuredVerdict(approveStdout({ findings: 1 }));
  assertEqual(r.bucket, 'NEEDS_OWNER');
  assertEqual(r.reason, 'APPROVE_WITH_FINDINGS');
});

test('structured: APPROVE with widening prose ("please run a third pass") -> NEEDS_OWNER', () => {
  const stdout = `Looks fine, but please run a third pass before merging.\n${approveStdout()}`;
  const r = classifyStructuredVerdict(stdout);
  assertEqual(r.bucket, 'NEEDS_OWNER');
  assertEqual(r.reason, 'WIDENING_TEXT_IN_PROSE');
});

test('structured: APPROVE with widening prose ("widen the scope of this review") -> NEEDS_OWNER', () => {
  const stdout = `Please widen the scope of this review.\n${approveStdout()}`;
  const r = classifyStructuredVerdict(stdout);
  assertEqual(r.bucket, 'NEEDS_OWNER');
  assertEqual(r.reason, 'WIDENING_TEXT_IN_PROSE');
});

test('structured: BLOCK verdict short-circuits regardless of extra severity prose', () => {
  const stdout = `This has a security vulnerability.\n${blockStdout()}`;
  const r = classifyStructuredVerdict(stdout);
  assertEqual(r.bucket, 'STRUCTURED_BLOCK');
});

test('structured: duplicated field in block -> NEEDS_OWNER', () => {
  const stdout = ['```codex-verdict', 'verdict: APPROVE', 'verdict: APPROVE', 'scope_request: none', 'findings: 0', '```'].join('\n');
  const r = classifyStructuredVerdict(stdout);
  assertEqual(r.bucket, 'NEEDS_OWNER');
  assert(/DUPLICATE_FIELD/.test(r.reason));
});

test('structured: unrecognized line inside block -> NEEDS_OWNER', () => {
  const stdout = ['```codex-verdict', 'verdict: APPROVE', 'scope_request: none', 'findings: 0', 'extra: nonsense', '```'].join('\n');
  const r = classifyStructuredVerdict(stdout);
  assertEqual(r.bucket, 'NEEDS_OWNER');
  assertEqual(r.reason, 'UNRECOGNIZED_LINE_IN_VERDICT_BLOCK');
});

test('structured: non-integer findings -> NEEDS_OWNER', () => {
  const stdout = ['```codex-verdict', 'verdict: BLOCK', 'scope_request: none', 'findings: many', '```'].join('\n');
  const r = classifyStructuredVerdict(stdout);
  // BLOCK short-circuits before findings value is even checked for content
  // meaning -- but the block parse itself fails first since "many" is not
  // a valid integer, so this must be NEEDS_OWNER regardless of verdict kind.
  assertEqual(r.bucket, 'NEEDS_OWNER');
  assertEqual(r.reason, 'FINDINGS_NOT_INTEGER');
});

// small structured totality table
let structuredGenerated = 0;
for (const verdict of ['APPROVE', 'BLOCK']) {
  for (const scopeRequest of ['none', 'widen', 'another_pass']) {
    for (const findings of [0, 1, 2]) {
      structuredGenerated++;
      const label = `structured-totality[${structuredGenerated}]: verdict=${verdict} scope=${scopeRequest} findings=${findings}`;
      test(label, () => {
        const stdout = ['```codex-verdict', `verdict: ${verdict}`, `scope_request: ${scopeRequest}`, `findings: ${findings}`, '```'].join('\n');
        const r = classifyStructuredVerdict(stdout);
        if (verdict === 'BLOCK') {
          assertEqual(r.bucket, 'STRUCTURED_BLOCK', label);
        } else if (scopeRequest !== 'none' || findings !== 0) {
          assertEqual(r.bucket, 'NEEDS_OWNER', label);
        } else {
          assertEqual(r.bucket, 'STRUCTURED_APPROVE', label);
        }
      });
    }
  }
}

// ── preconditionBucket / classify: fixed priority order ─────────────────

test('D12: HALTED outranks DRAFT_PR', () => {
  const ledger = { entries: [], halted: true, haltReason: 'PRIOR_HALT', expectedRound: 1 };
  const pc = preconditionBucket({ fenceResult: FENCE_OK, isDraft: true, ledger, round: 1, headSha: HEAD_SHA });
  assertEqual(pc.bucket, 'HALTED');
});

test('D14: draft PR -> DRAFT_PR, outranks fence-unknown', () => {
  const pc = preconditionBucket({ fenceResult: { ok: false, reason: 'X' }, isDraft: true, ledger: baseLedger(), round: 1, headSha: HEAD_SHA });
  assertEqual(pc.bucket, 'DRAFT_PR');
});

test('fence-unknown outranks EMPTY_FENCE (they are mutually exclusive states anyway)', () => {
  const pc = preconditionBucket({ fenceResult: { ok: false, reason: 'DIFF_COMMAND_FAILED' }, isDraft: false, ledger: baseLedger(), round: 1, headSha: HEAD_SHA });
  assertEqual(pc.bucket, 'NEEDS_OWNER');
});

test('D13: zero changed files (fence ok, empty) -> EMPTY_FENCE', () => {
  const pc = preconditionBucket({ fenceResult: { ok: true, fence: makeFence([]) }, isDraft: false, ledger: baseLedger(), round: 1, headSha: HEAD_SHA });
  assertEqual(pc.bucket, 'EMPTY_FENCE');
});

test('C8/C9: existing marker for same (round, headSha) -> ROUND_EXCEEDED', () => {
  const ledger = { entries: [{ round: 1, headSha: HEAD_SHA }], halted: false, expectedRound: 2 };
  const pc = preconditionBucket({ fenceResult: FENCE_OK, isDraft: false, ledger, round: 1, headSha: HEAD_SHA });
  assertEqual(pc.bucket, 'ROUND_EXCEEDED');
  assertEqual(pc.reason, 'ROUND_ALREADY_RECORDED');
});

test('R3: round 0 -> INVALID_SHAPE (ROUND_OUT_OF_RANGE)', () => {
  const pc = preconditionBucket({ fenceResult: FENCE_OK, isDraft: false, ledger: baseLedger(), round: 0, headSha: HEAD_SHA });
  assertEqual(pc.bucket, 'INVALID_SHAPE');
  assertEqual(pc.reason, 'ROUND_OUT_OF_RANGE');
});

test('C11: caller round disagrees with ledger-computed next round -> refused', () => {
  const ledger = { entries: [{ round: 1, headSha: OTHER_SHA }], halted: false, expectedRound: 2 };
  const pc = preconditionBucket({ fenceResult: FENCE_OK, isDraft: false, ledger, round: 1, headSha: HEAD_SHA });
  assertEqual(pc.bucket, 'INVALID_SHAPE');
  assertEqual(pc.reason, 'ROUND_DISAGREES_WITH_LEDGER');
});

test('classify: CODEX_ERROR (nonzero exit) takes priority over an otherwise-valid verdict', () => {
  const r = classify(baseCtx({ exitCode: 1, stdout: approveStdout() }));
  assertEqual(r.bucket, 'CODEX_ERROR');
});

test('classify: empty stdout with exit 0 is also CODEX_ERROR', () => {
  const r = classify(baseCtx({ exitCode: 0, stdout: '' }));
  assertEqual(r.bucket, 'CODEX_ERROR');
  assertEqual(r.reason, 'EMPTY_STDOUT');
});

test('classify: happy path -> STRUCTURED_APPROVE (pending, final VALID_APPROVE decided post-recheck)', () => {
  const r = classify(baseCtx());
  assertEqual(r.bucket, 'STRUCTURED_APPROVE');
});

test('classify: happy path BLOCK -> STRUCTURED_BLOCK', () => {
  const r = classify(baseCtx({ stdout: blockStdout() }));
  assertEqual(r.bucket, 'STRUCTURED_BLOCK');
});

// ── item a: post-run ledger re-check before posting ──────────────────────

function reclassifyRunners({ commentsSequence, countSequence }) {
  const commentsQueue = commentsSequence.slice();
  const countQueue = countSequence ? countSequence.slice() : null;
  let commentsIdx = 0;
  let countIdx = 0;
  let lastLen = 0;
  const gh = (args) => {
    if (args[0] === 'api' && args[1] === '--paginate') {
      const idx = Math.min(commentsIdx, commentsQueue.length - 1);
      commentsIdx++;
      const list = commentsQueue[idx];
      lastLen = list.length;
      return { status: 0, stdout: JSON.stringify(list), stderr: '' };
    }
    if (args[0] === 'api') {
      let count;
      if (countQueue) {
        const idx = Math.min(countIdx, countQueue.length - 1);
        countIdx++;
        count = countQueue[idx];
      } else {
        count = lastLen;
      }
      return { status: 0, stdout: JSON.stringify({ comments: count }), stderr: '' };
    }
    throw new Error(`unhandled gh args ${JSON.stringify(args)}`);
  };
  return { gh };
}

test('required: paginated read count mismatch -> UNKNOWN_LEDGER_STATE', () => {
  const comments = [rc('hi', 'someone', 1)];
  const runners = reclassifyRunners({ commentsSequence: [comments], countSequence: [comments.length + 1] });
  const r = reclassifyLedgerBeforePosting({
    owner: 'o', repo: 'r', prNumber: 305, round: 1, headSha: HEAD_SHA, ownerLogin: 'owner',
    snapshotIds: new Set(), runners, repoRoot: '/repo',
  });
  assertEqual(r.bucket, 'UNKNOWN_LEDGER_STATE');
  assertEqual(r.reason, 'LEDGER_COUNT_MISMATCH');
});

test('required: pre-existing uncleared HALT -> HALTED', () => {
  const halt = renderHaltComment({ prNumber: 305, round: 1, headSha: HEAD_SHA, condition: 'X' });
  const comments = [rc(halt, 'owner', 1)];
  const runners = reclassifyRunners({ commentsSequence: [comments] });
  const r = reclassifyLedgerBeforePosting({
    owner: 'o', repo: 'r', prNumber: 305, round: 1, headSha: HEAD_SHA, ownerLogin: 'owner',
    snapshotIds: new Set([1]), runners, repoRoot: '/repo',
  });
  assertEqual(r.bucket, 'HALTED');
});

test('required: legitimate round re-run after force-push (old-SHA entry older than snapshot) -> NO_CHANGE, not STALE_SHA', () => {
  const oldEntry = renderLedgerComment({ round: 1, headSha: OTHER_SHA, bucket: 'VALID_APPROVE', verdictText: approveStdout() });
  const comments = [rc(oldEntry, 'owner', 1)];
  // The old-SHA entry was already present in the snapshot (id 1 is known) --
  // it is NOT new, so it must not be classified at all.
  const runners = reclassifyRunners({ commentsSequence: [comments] });
  const r = reclassifyLedgerBeforePosting({
    owner: 'o', repo: 'r', prNumber: 305, round: 1, headSha: HEAD_SHA, ownerLogin: 'owner',
    snapshotIds: new Set([1]), runners, repoRoot: '/repo',
  });
  assertEqual(r.bucket, 'NO_CHANGE');
});

test('required: new different-SHA entry (appeared after snapshot) -> STALE_SHA', () => {
  const staleEntry = renderLedgerComment({ round: 1, headSha: OTHER_SHA, bucket: 'VALID_APPROVE', verdictText: approveStdout() });
  const comments = [rc(staleEntry, 'owner', 2)]; // id 2, not in snapshot
  const runners = reclassifyRunners({ commentsSequence: [comments] });
  const r = reclassifyLedgerBeforePosting({
    owner: 'o', repo: 'r', prNumber: 305, round: 1, headSha: HEAD_SHA, ownerLogin: 'owner',
    snapshotIds: new Set([1]), runners, repoRoot: '/repo',
  });
  assertEqual(r.bucket, 'STALE_SHA');
});

test('a new entry with our exact round+headSha -> DUPLICATE', () => {
  const dupEntry = renderLedgerComment({ round: 1, headSha: HEAD_SHA, bucket: 'VALID_APPROVE', verdictText: approveStdout() });
  const comments = [rc(dupEntry, 'owner', 2)];
  const runners = reclassifyRunners({ commentsSequence: [comments] });
  const r = reclassifyLedgerBeforePosting({
    owner: 'o', repo: 'r', prNumber: 305, round: 1, headSha: HEAD_SHA, ownerLogin: 'owner',
    snapshotIds: new Set([1]), runners, repoRoot: '/repo',
  });
  assertEqual(r.bucket, 'DUPLICATE');
});

test('required: a human "nice work" comment mid-run -> NO_CHANGE', () => {
  const comments = [rc('nice work team!', 'someone-else', 2)];
  const runners = reclassifyRunners({ commentsSequence: [comments] });
  const r = reclassifyLedgerBeforePosting({
    owner: 'o', repo: 'r', prNumber: 305, round: 1, headSha: HEAD_SHA, ownerLogin: 'owner',
    snapshotIds: new Set([1]), runners, repoRoot: '/repo',
  });
  assertEqual(r.bucket, 'NO_CHANGE');
});

test('a new comment carrying a wrapper marker prefix that fails to parse -> UNKNOWN_LEDGER_STATE', () => {
  const malformed = '<!-- codex-review-round:not-a-number sha:x hash:y -->';
  const comments = [rc(malformed, 'owner', 2)];
  const runners = reclassifyRunners({ commentsSequence: [comments] });
  const r = reclassifyLedgerBeforePosting({
    owner: 'o', repo: 'r', prNumber: 305, round: 1, headSha: HEAD_SHA, ownerLogin: 'owner',
    snapshotIds: new Set([1]), runners, repoRoot: '/repo',
  });
  // ROUND_MARKER_RE requires \d+ for round -- "not-a-number" fails that
  // regex entirely, so this falls through to the generic wrapper-prefix
  // catch-all rather than the round-marker branch.
  assertEqual(r.bucket, 'UNKNOWN_LEDGER_STATE');
});

test('STALE_SHA outranks DUPLICATE when both appear among new comments (fixed precedence)', () => {
  const dupEntry = renderLedgerComment({ round: 1, headSha: HEAD_SHA, bucket: 'VALID_APPROVE', verdictText: approveStdout() });
  const staleEntry = renderLedgerComment({ round: 1, headSha: OTHER_SHA, bucket: 'VALID_APPROVE', verdictText: approveStdout() });
  // dup appears first chronologically, stale second -- precedence must still favor STALE_SHA.
  const comments = [rc(dupEntry, 'owner', 2), rc(staleEntry, 'owner', 3)];
  const runners = reclassifyRunners({ commentsSequence: [comments] });
  const r = reclassifyLedgerBeforePosting({
    owner: 'o', repo: 'r', prNumber: 305, round: 1, headSha: HEAD_SHA, ownerLogin: 'owner',
    snapshotIds: new Set([1]), runners, repoRoot: '/repo',
  });
  assertEqual(r.bucket, 'STALE_SHA');
});

// ── isHaltTrigger / exitCodeFor / parseStrictRound ───────────────────────

test('exit codes: VALID_APPROVE=0, VALID_BLOCK=2, everything else=3', () => {
  assertEqual(exitCodeFor('VALID_APPROVE'), 0);
  assertEqual(exitCodeFor('VALID_BLOCK'), 2);
  for (const b of ['HALTED', 'DRAFT_PR', 'EMPTY_FENCE', 'ROUND_EXCEEDED', 'INVALID_SHAPE', 'CODEX_ERROR', 'NEEDS_OWNER', 'STALE_SHA', 'DUPLICATE', 'UNKNOWN_LEDGER_STATE']) {
    assertEqual(exitCodeFor(b), 3, `bucket ${b}`);
  }
});

test('isHaltTrigger: NEEDS_OWNER, STALE_SHA, UNKNOWN_LEDGER_STATE all halt; DUPLICATE does not', () => {
  assert(isHaltTrigger('NEEDS_OWNER'));
  assert(isHaltTrigger('STALE_SHA'));
  assert(isHaltTrigger('UNKNOWN_LEDGER_STATE'));
  assert(!isHaltTrigger('DUPLICATE'));
});

test('isHaltTrigger: a caller round-3 request halts', () => {
  assert(isHaltTrigger('INVALID_SHAPE', 'ROUND_OUT_OF_RANGE', 3));
  assert(!isHaltTrigger('INVALID_SHAPE', 'ROUND_OUT_OF_RANGE', 0));
});

test('parseStrictRound rejects 0 at the string level only where non-numeric; downstream range check catches numeric-but-invalid', () => {
  assertEqual(parseStrictRound('0'), 0);
  assert(Number.isNaN(parseStrictRound('1.5')));
  assertEqual(parseStrictRound('1'), 1);
  assertEqual(parseStrictRound('2'), 2);
  assert(Number.isNaN(parseStrictRound('abc')));
  assert(Number.isNaN(parseStrictRound('-1')));
});

// ── runReview: end-to-end orchestration ──────────────────────────────────

function fakeRunners(opts) {
  opts = opts || {};
  const commentsQueue = (opts.commentsSequence || [[]]).slice();
  const countQueue = opts.countSequence ? opts.countSequence.slice() : null;
  const calls = { gh: [], git: [], codex: [] };
  let commentsIdx = 0;
  let countIdx = 0;
  let lastLen = 0;

  const gh = (args) => {
    calls.gh.push(args);
    if (args[0] === 'pr' && args[1] === 'view') {
      return { status: 0, stdout: JSON.stringify(opts.prView || {}), stderr: '' };
    }
    if (args[0] === 'repo' && args[1] === 'view') {
      return { status: 0, stdout: JSON.stringify({ owner: opts.owner || { login: 'owner' }, name: opts.repoName || 'claude-memory' }), stderr: '' };
    }
    if (args[0] === 'api' && args[1] === '--paginate') {
      const idx = Math.min(commentsIdx, commentsQueue.length - 1);
      commentsIdx++;
      const list = commentsQueue[idx];
      lastLen = list.length;
      return { status: 0, stdout: JSON.stringify(list), stderr: '' };
    }
    if (args[0] === 'api') {
      let count;
      if (countQueue) {
        const idx = Math.min(countIdx, countQueue.length - 1);
        countIdx++;
        count = countQueue[idx];
      } else {
        count = lastLen;
      }
      return { status: 0, stdout: JSON.stringify({ comments: count }), stderr: '' };
    }
    if (args[0] === 'pr' && args[1] === 'comment') {
      const pr = opts.postResult || { status: 0, stderr: '' };
      return { status: pr.status, stdout: '', stderr: pr.stderr || '' };
    }
    throw new Error(`fakeRunners.gh: unhandled args ${JSON.stringify(args)}`);
  };
  const git = (args) => {
    calls.git.push(args);
    if (args[0] === 'diff' && args.includes('--name-status')) {
      return opts.nameStatusResult || { status: 0, stdout: `M\0${IN_FENCE_FILE}\0`, stderr: '' };
    }
    return opts.diffResult || { status: 0, stdout: 'diff --git a/x b/x\n+1', stderr: '' };
  };
  const codex = (exe, args, runOpts) => {
    calls.codex.push([exe, ...args]);
    return opts.codexResult || { status: 0, stdout: approveStdout(), stderr: '' };
  };
  return { runners: { gh, git, codex }, calls };
}

const BASE_PR_VIEW = {
  body: 'test PR',
  headRefOid: HEAD_SHA,
  isDraft: false,
  baseRefOid: OTHER_SHA,
};

test('end-to-end: clean APPROVE run posts a ledger comment and exits 0', () => {
  const { runners, calls } = fakeRunners({ prView: BASE_PR_VIEW, commentsSequence: [[], []] });
  const r = runReview({ pr: 305, round: 1, repoRoot: '/repo', dryRun: false }, runners);
  assertEqual(r.bucket, 'VALID_APPROVE', `expected VALID_APPROVE, got ${r.bucket} (${r.reason})`);
  assertEqual(r.exitCode, 0);
  assertEqual(calls.gh.filter((a) => a[0] === 'pr' && a[1] === 'comment').length, 1);
  const nameStatusCall = calls.git.find((a) => a.includes('--name-status'));
  assert(nameStatusCall, 'git diff --name-status must be called for the fence');
  assertEqual(nameStatusCall[nameStatusCall.length - 1], `${OTHER_SHA}...${HEAD_SHA}`);
});

test('end-to-end: clean BLOCK run posts a ledger comment and exits 2', () => {
  const { runners, calls } = fakeRunners({ prView: BASE_PR_VIEW, commentsSequence: [[]], codexResult: { status: 0, stdout: blockStdout(), stderr: '' } });
  const r = runReview({ pr: 305, round: 1, repoRoot: '/repo', dryRun: false }, runners);
  assertEqual(r.bucket, 'VALID_BLOCK');
  assertEqual(r.exitCode, 2);
  assertEqual(calls.gh.filter((a) => a[0] === 'pr' && a[1] === 'comment').length, 1);
});

test('end-to-end: NEEDS_OWNER (ambiguous verdict) halts and posts a halt marker', () => {
  const { runners, calls } = fakeRunners({
    prView: BASE_PR_VIEW,
    commentsSequence: [[], []],
    codexResult: { status: 0, stdout: 'no verdict block at all', stderr: '' },
  });
  const r = runReview({ pr: 305, round: 1, repoRoot: '/repo', dryRun: false }, runners);
  assertEqual(r.bucket, 'NEEDS_OWNER');
  assertEqual(r.exitCode, 3);
  assertEqual(calls.gh.filter((a) => a[0] === 'pr' && a[1] === 'comment').length, 1);
});

test('required (end-to-end): git diff --name-status failure -> NEEDS_OWNER, Codex never invoked', () => {
  const { runners, calls } = fakeRunners({
    prView: BASE_PR_VIEW,
    commentsSequence: [[]],
    nameStatusResult: { status: 128, stdout: '', stderr: 'fatal: bad revision' },
  });
  const r = runReview({ pr: 305, round: 1, repoRoot: '/repo', dryRun: false }, runners);
  assertEqual(r.bucket, 'NEEDS_OWNER');
  assert(/FENCE_UNKNOWN_DIFF_COMMAND_FAILED/.test(r.reason));
  assertEqual(calls.codex.length, 0);
});

test('end-to-end: a rename with a space in the path survives gh-free fence resolution to VALID_BLOCK when cited by its pre-rename path', () => {
  const { runners } = fakeRunners({
    prView: BASE_PR_VIEW,
    commentsSequence: [[]],
    nameStatusResult: { status: 0, stdout: `R087\0old dir/old name.js\0new dir/new name.js\0`, stderr: '' },
    codexResult: { status: 0, stdout: blockStdout(), stderr: '' },
  });
  const r = runReview({ pr: 305, round: 1, repoRoot: '/repo', dryRun: false }, runners);
  assertEqual(r.bucket, 'VALID_BLOCK', `expected VALID_BLOCK, got ${r.bucket} (${r.reason})`);
});

test('end-to-end: an empty diff never reaches Codex -> EMPTY_FENCE', () => {
  const { runners, calls } = fakeRunners({
    prView: BASE_PR_VIEW,
    commentsSequence: [[]],
    diffResult: { status: 0, stdout: '   \n', stderr: '' },
  });
  const r = runReview({ pr: 305, round: 1, repoRoot: '/repo', dryRun: false }, runners);
  assertEqual(r.bucket, 'EMPTY_FENCE');
  assertEqual(calls.codex.length, 0);
});

test('end-to-end: draft PR halts before any git/codex call', () => {
  const { runners, calls } = fakeRunners({ prView: Object.assign({}, BASE_PR_VIEW, { isDraft: true }), commentsSequence: [[]] });
  const r = runReview({ pr: 305, round: 1, repoRoot: '/repo', dryRun: false }, runners);
  assertEqual(r.bucket, 'DRAFT_PR');
  assertEqual(calls.codex.length, 0);
  assertEqual(calls.gh.filter((a) => a[0] === 'pr' && a[1] === 'comment').length, 1);
});

test('end-to-end: round 2 embeds the round-1 raw response verbatim in the prompt', () => {
  const priorBody = renderLedgerComment({ round: 1, headSha: HEAD_SHA, bucket: 'VALID_BLOCK', verdictText: blockStdout({ prose: 'fix the thing please' }) });
  let capturedPrompt = null;
  const { runners } = fakeRunners({
    prView: BASE_PR_VIEW,
    commentsSequence: [[rc(priorBody, 'owner', 1)], [rc(priorBody, 'owner', 1)]],
    codexResult: { status: 0, stdout: approveStdout(), stderr: '' },
  });
  const origCodex = runners.codex;
  runners.codex = (exe, args, opts) => {
    capturedPrompt = opts.input;
    return origCodex(exe, args, opts);
  };
  const r = runReview({ pr: 305, round: 2, repoRoot: '/repo', dryRun: false }, runners);
  assertEqual(r.bucket, 'VALID_APPROVE', `expected VALID_APPROVE, got ${r.bucket} (${r.reason})`);
  assert(capturedPrompt && capturedPrompt.includes('fix the thing please'), 'round-1 response missing from round-2 prompt');
});

test('end-to-end: round 2 with no round-1 ledger entry -> refused (ledger disagrees on round)', () => {
  const { runners } = fakeRunners({ prView: BASE_PR_VIEW, commentsSequence: [[]] });
  const r = runReview({ pr: 305, round: 2, repoRoot: '/repo', dryRun: false }, runners);
  assertEqual(r.bucket, 'INVALID_SHAPE');
  assertEqual(r.reason, 'ROUND_DISAGREES_WITH_LEDGER');
});

test('end-to-end: a caller round-3 request halts and posts the marker', () => {
  const { runners, calls } = fakeRunners({ prView: BASE_PR_VIEW, commentsSequence: [[]] });
  const r = runReview({ pr: 305, round: 3, repoRoot: '/repo', dryRun: false }, runners);
  assertEqual(r.bucket, 'INVALID_SHAPE');
  assertEqual(r.reason, 'ROUND_OUT_OF_RANGE');
  assertEqual(calls.gh.filter((a) => a[0] === 'pr' && a[1] === 'comment').length, 1);
});

test('end-to-end: a failed ledger-comment post demotes VALID_APPROVE to a CODEX_ERROR gate error', () => {
  const { runners } = fakeRunners({
    prView: BASE_PR_VIEW,
    commentsSequence: [[], []],
    postResult: { status: 1, stderr: 'gh: rate limited' },
  });
  const r = runReview({ pr: 305, round: 1, repoRoot: '/repo', dryRun: false }, runners);
  assertEqual(r.bucket, 'CODEX_ERROR');
  assert(/LEDGER_POST_FAILED/.test(r.reason));
});

test('end-to-end: a nonzero-exit Codex process -> CODEX_ERROR, no post', () => {
  const { runners, calls } = fakeRunners({
    prView: BASE_PR_VIEW,
    commentsSequence: [[]],
    codexResult: { status: 1, stdout: '', stderr: 'boom' },
  });
  const r = runReview({ pr: 305, round: 1, repoRoot: '/repo', dryRun: false }, runners);
  assertEqual(r.bucket, 'CODEX_ERROR');
  assertEqual(calls.gh.filter((a) => a[0] === 'pr' && a[1] === 'comment').length, 0);
});

test('end-to-end: the final stdout line is single-line JSON carrying outcome/round/sha/reason', () => {
  const { runners } = fakeRunners({ prView: BASE_PR_VIEW, commentsSequence: [[], []] });
  const r = runReview({ pr: 305, round: 1, repoRoot: '/repo', dryRun: false }, runners);
  const lastLine = r.lines[r.lines.length - 1];
  const parsed = JSON.parse(lastLine);
  assertEqual(parsed.outcome, 'VALID_APPROVE');
  assertEqual(parsed.round, 1);
  assertEqual(parsed.sha, HEAD_SHA);
  assertEqual(r.exitCode, 0);
});

test('end-to-end (item a): a same-round different-SHA entry posted mid-run demotes an otherwise-clean APPROVE to STALE_SHA and halts', () => {
  const staleEntry = renderLedgerComment({ round: 1, headSha: OTHER_SHA, bucket: 'VALID_APPROVE', verdictText: approveStdout() });
  const { runners, calls } = fakeRunners({
    prView: BASE_PR_VIEW,
    // First read (pre-run snapshot): empty. Post-run re-read: a same-round,
    // different-SHA entry has appeared (simulating a force-push mid-run).
    commentsSequence: [[], [rc(staleEntry, 'owner', 99)]],
  });
  const r = runReview({ pr: 305, round: 1, repoRoot: '/repo', dryRun: false }, runners);
  assertEqual(r.bucket, 'STALE_SHA');
  assertEqual(calls.gh.filter((a) => a[0] === 'pr' && a[1] === 'comment').length, 1, 'a halt marker must still be posted');
});

test('end-to-end (item a): a duplicate entry appearing mid-run aborts silently -- no post', () => {
  const dupEntry = renderLedgerComment({ round: 1, headSha: HEAD_SHA, bucket: 'VALID_APPROVE', verdictText: approveStdout() });
  const { runners, calls } = fakeRunners({
    prView: BASE_PR_VIEW,
    commentsSequence: [[], [rc(dupEntry, 'owner', 99)]],
  });
  const r = runReview({ pr: 305, round: 1, repoRoot: '/repo', dryRun: false }, runners);
  assertEqual(r.bucket, 'DUPLICATE');
  assertEqual(calls.gh.filter((a) => a[0] === 'pr' && a[1] === 'comment').length, 0, 'must not post on a mid-run duplicate');
});

test('end-to-end (item a): a paginated-vs-count mismatch on the post-run re-read halts as UNKNOWN_LEDGER_STATE', () => {
  const { runners, calls } = fakeRunners({
    prView: BASE_PR_VIEW,
    commentsSequence: [[], []],
    countSequence: [5], // the one count-endpoint call (post-run) disagrees with the re-read list length (0)
  });
  const r = runReview({ pr: 305, round: 1, repoRoot: '/repo', dryRun: false }, runners);
  assertEqual(r.bucket, 'UNKNOWN_LEDGER_STATE');
  assertEqual(calls.gh.filter((a) => a[0] === 'pr' && a[1] === 'comment').length, 1);
});

// ── Report ──────────────────────────────────────────────────────────────

console.log(`\ncodex-review tests: ${passed} passed, ${failed} failed (structured totality: ${structuredGenerated})`);
if (failed > 0) {
  console.error(`\n${failed} failure(s):`);
  for (const f of failures) console.error(`  - ${f.label}: ${f.err.message}`);
  process.exit(1);
}
process.exit(0);
