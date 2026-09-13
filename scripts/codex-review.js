'use strict';

/**
 * codex-review.js — directed Codex-as-PR-reviewer wrapper.
 *
 * Spec: docs/specs/codex-review-contract.md (17 adversary findings fixed
 * 2026-09-13 before this file was authored, per this repo's
 * adversary-before-author rule). Round 2 (2026-09-13) fixes 12 in-fence
 * blockers found by an independent Codex-review dogfood pass on round 1 —
 * see the round-1 ledger comment on PR #305 for the original findings.
 *
 * Usage:
 *   node scripts/codex-review.js --pr <N> --round <1|2> [--repo-root <path>] [--dry-run]
 *
 * `--dry-run` prints the assembled prompt and the classification the
 * wrapper WOULD reach from a live `gh`/`codex` run's real outputs, but
 * never invokes `codex exec` and never posts a ledger comment.
 *
 * All pure logic (path normalization, fence building, verdict parsing,
 * total classification, ledger comment render/parse) is exported for
 * testing without any `gh`/`codex` process. The orchestration glue
 * (`runReview`) is also exported and takes an injectable `runners` object
 * ({ gh, git, codex }) so round-2's fixes (base-SHA diffing, re-read-
 * before-post, owner-gated halt clearing, exit-code/JSON contract) are
 * unit-testable without any real subprocess — see test/test-codex-review.js.
 */

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

// ── Path normalization (B5/B7) ──────────────────────────────────────────

function normalizePath(p, platform) {
  platform = platform || process.platform;
  if (typeof p !== 'string') return p;
  let n = p.replace(/\\/g, '/');
  n = n.replace(/^(\.\/)+/, '');
  n = n.replace(/\/{2,}/g, '/');
  if (platform === 'win32') n = n.toLowerCase();
  return n;
}

// ── Fence (B6) ───────────────────────────────────────────────────────────

function buildFence(files, platform) {
  if (!Array.isArray(files)) {
    throw new TypeError('buildFence: files must be an array');
  }
  const set = new Set();
  for (const f of files) {
    if (!f || typeof f.path !== 'string' || !f.path) continue;
    set.add(normalizePath(f.path, platform));
    if (typeof f.previousPath === 'string' && f.previousPath) {
      set.add(normalizePath(f.previousPath, platform));
    }
  }
  const paths = Array.from(set);
  return {
    paths,
    has(p) {
      return set.has(normalizePath(p, platform));
    },
  };
}

// ── Verdict template parsing (A1/A2) ────────────────────────────────────

const FIELD_LINE_RE = {
  SHA: /^SHA:\s*(\S+)\s*$/,
  VERDICT: /^VERDICT:\s*(APPROVE|BLOCK)\s*$/,
  SCOPE_RESPECTED: /^SCOPE_RESPECTED:\s*(yes|no)\s*$/,
  ROUND: /^ROUND:\s*(\d+)\s*$/,
};
const FINDINGS_START_RE = /^FINDINGS:\s*$/;
const FINDINGS_END_RE = /^END_FINDINGS\s*$/;
const FINDING_LINE_RE = /^-\s*(BLOCKER|LEAD)\s+file=(\S+)\s+text=(.*)$/;

function parseVerdict(text) {
  if (typeof text !== 'string' || !text.trim()) {
    return { valid: false, reason: 'EMPTY_VERDICT' };
  }
  const lines = text.split(/\r\n|\r|\n/);
  const fields = { SHA: [], VERDICT: [], SCOPE_RESPECTED: [], ROUND: [] };
  const findings = [];
  let inFindings = false;
  let findingsClosed = false;
  let sawFindingsBlock = false;
  let trailingAfterClose = false;

  for (const raw of lines) {
    const line = raw.trim();
    if (line === '') continue;

    if (findingsClosed) {
      trailingAfterClose = true;
      continue;
    }

    if (inFindings) {
      if (FINDINGS_END_RE.test(line)) {
        inFindings = false;
        findingsClosed = true;
        continue;
      }
      const m = line.match(FINDING_LINE_RE);
      if (m) {
        findings.push({ severity: m[1], file: m[2], text: m[3] });
        continue;
      }
      return { valid: false, reason: 'UNRECOGNIZED_LINE_IN_FINDINGS' };
    }

    if (FINDINGS_START_RE.test(line)) {
      if (sawFindingsBlock) return { valid: false, reason: 'DUPLICATE_FINDINGS_BLOCK' };
      inFindings = true;
      sawFindingsBlock = true;
      continue;
    }

    let matchedField = null;
    for (const key of Object.keys(FIELD_LINE_RE)) {
      const m = line.match(FIELD_LINE_RE[key]);
      if (m) {
        matchedField = key;
        fields[key].push(m[1]);
        break;
      }
    }
    if (!matchedField) {
      return { valid: false, reason: 'UNRECOGNIZED_LINE' };
    }
  }

  if (inFindings) return { valid: false, reason: 'UNCLOSED_FINDINGS_BLOCK' };
  if (trailingAfterClose) return { valid: false, reason: 'TEXT_AFTER_LAST_FIELD' };

  for (const key of Object.keys(fields)) {
    if (fields[key].length !== 1) {
      return { valid: false, reason: `FIELD_COUNT_${key}` };
    }
  }

  return {
    valid: true,
    sha: fields.SHA[0],
    verdict: fields.VERDICT[0],
    scopeRespected: fields.SCOPE_RESPECTED[0] === 'yes',
    round: parseInt(fields.ROUND[0], 10),
    findings,
  };
}

// ── Total classification (D12) ──────────────────────────────────────────

const PATH_TOKEN_RE = /\S+\.(js|mjs|md|json|sql|yml|ps1)\b/g;
const REARCH_RE = /\b(new file|new module|extract|refactor into|move to)\b/i;
// Round 2 fix (item 10): a finding's free text can ask to widen scope in
// words even when it never names an out-of-fence path or matches
// REARCH_RE's rearchitecture vocabulary — e.g. a LEAD asking for "another
// pass". Scanned across ALL findings (BLOCKER and LEAD), not just BLOCKER.
const WIDEN_TEXT_RE = /\b(another (pass|round)|one more (pass|round)|second pass|run (it )?again|do another round)\b/i;

// Round 2 fix (item 12b): the classifier must not accept a verdict whose
// own ROUND field disagrees with the caller's authorized --round.
function preconditionBucket({ fence, isDraft, ledger, round, headSha }) {
  // 1. Prior halt not cleared, or ledger tamper-evident-invalid.
  if (ledger && ledger.halted && !ledger.haltCleared) {
    return { bucket: 'HALTED', reason: ledger.haltReason || 'PRIOR_HALT_UNCLEARED' };
  }

  // 2. Draft PR.
  if (isDraft) {
    return { bucket: 'DRAFT_PR', reason: 'PR_IS_DRAFT' };
  }

  // 3. Empty fence (changed-file list from `gh pr view` is empty).
  if (!fence || !Array.isArray(fence.paths) || fence.paths.length === 0) {
    return { bucket: 'EMPTY_FENCE', reason: 'ZERO_CHANGED_FILES' };
  }

  // 4. Idempotent dup-round abort (C8/C9).
  if (ledger && Array.isArray(ledger.entries)) {
    const dup = ledger.entries.some((e) => e.round === round && e.headSha === headSha);
    if (dup) {
      return { bucket: 'ROUND_EXCEEDED', reason: 'ROUND_ALREADY_RECORDED' };
    }
  }

  // 5. Caller round out of range.
  if (round !== 1 && round !== 2) {
    return { bucket: 'INVALID_SHAPE', reason: 'ROUND_OUT_OF_RANGE' };
  }

  // 6. Caller round disagrees with ledger-computed next round.
  if (ledger && typeof ledger.expectedRound === 'number' && ledger.expectedRound !== round) {
    return { bucket: 'INVALID_SHAPE', reason: 'ROUND_DISAGREES_WITH_LEDGER' };
  }

  return null;
}

function classify(ctx) {
  ctx = ctx || {};
  const { exitCode, stdout, verdictText, fence, headSha, round, ledger, isDraft } = ctx;

  // Steps 1-6: preconditions, shared with the pre-Codex precheck in runReview.
  const pc = preconditionBucket({ fence, isDraft, ledger, round, headSha });
  if (pc) return pc;

  // 7. Process-level failure, before any content parsing.
  if (exitCode !== 0 || !stdout || !String(stdout).trim()) {
    return {
      bucket: 'CODEX_ERROR',
      reason: exitCode !== 0 ? `NONZERO_EXIT_${exitCode}` : 'EMPTY_STDOUT',
    };
  }

  // 8. Shape.
  const verdict = ctx.verdict || parseVerdict(verdictText);
  if (!verdict.valid) {
    return { bucket: 'INVALID_SHAPE', reason: verdict.reason };
  }
  if (verdict.sha !== headSha) {
    return { bucket: 'INVALID_SHAPE', reason: 'SHA_MISMATCH' };
  }
  // Round 2 fix (item 12b): reject a malformed round (e.g. ROUND: 0, which
  // FIELD_LINE_RE's \d+ pattern parses without complaint) and cross-check
  // an in-range verdict ROUND against the caller's authorized round. A
  // verdict round > 2 is deliberately NOT handled here — that is content-
  // level widening (step 10, ROUND_EXCEEDED) regardless of caller round.
  if (verdict.round < 1) {
    return { bucket: 'INVALID_SHAPE', reason: 'VERDICT_ROUND_INVALID' };
  }
  if (verdict.round <= 2 && verdict.round !== round) {
    return { bucket: 'INVALID_SHAPE', reason: 'VERDICT_ROUND_MISMATCH' };
  }
  if (verdict.verdict === 'APPROVE' && verdict.findings.some((f) => f.severity === 'BLOCKER')) {
    return { bucket: 'INVALID_SHAPE', reason: 'APPROVE_WITH_BLOCKERS' };
  }
  if (verdict.verdict === 'BLOCK' && !verdict.findings.some((f) => f.severity === 'BLOCKER')) {
    return { bucket: 'INVALID_SHAPE', reason: 'BLOCK_WITHOUT_BLOCKER_FINDING' };
  }

  // 9. Fence + rearchitecture checks over BLOCKER findings.
  for (const f of verdict.findings) {
    if (f.severity !== 'BLOCKER') continue;
    if (!fence.has(f.file)) {
      return { bucket: 'OUT_OF_FENCE_BLOCKER', reason: 'BLOCKER_FILE_OUTSIDE_FENCE' };
    }
    const tokens = f.text.match(PATH_TOKEN_RE) || [];
    for (const tok of tokens) {
      if (!fence.has(tok)) {
        return { bucket: 'OUT_OF_FENCE_BLOCKER', reason: 'BLOCKER_TEXT_REFERENCES_OUT_OF_FENCE_PATH' };
      }
    }
    if (REARCH_RE.test(f.text)) {
      return { bucket: 'OUT_OF_FENCE_BLOCKER', reason: 'REARCHITECTURE_REMEDY' };
    }
  }

  // 10. Content-level round widening — verdict.ROUND > 2, or ANY finding
  // (BLOCKER or LEAD — round 2 fix, item 10) asks to widen scope/run
  // another pass, in the spec's own rearchitecture vocabulary or the
  // "another pass" phrasing.
  if (verdict.round > 2) {
    return { bucket: 'ROUND_EXCEEDED', reason: 'VERDICT_ROUND_GT_2' };
  }
  for (const f of verdict.findings) {
    if (REARCH_RE.test(f.text) || WIDEN_TEXT_RE.test(f.text)) {
      return { bucket: 'ROUND_EXCEEDED', reason: 'FINDING_TEXT_REQUESTS_WIDENING' };
    }
  }

  // 11/12. Passing buckets.
  if (verdict.verdict === 'APPROVE') {
    if (!verdict.scopeRespected) {
      return { bucket: 'INVALID_SHAPE', reason: 'APPROVE_SCOPE_NOT_RESPECTED' };
    }
    return { bucket: 'VALID_APPROVE' };
  }
  return { bucket: 'VALID_BLOCK' };
}

// ── Ledger (C8-C11, and round-2 items 5/6) ────────────────────────────────

function sha256(s) {
  return crypto.createHash('sha256').update(String(s), 'utf8').digest('hex');
}

const ROUND_MARKER_RE = /<!--\s*codex-review-round:(\d+)\s+sha:(\S+)\s+hash:(\S+)\s*-->/;
const HALT_MARKER_RE = /<!--\s*codex-review-halt\s*-->/;
const HALT_CLEARED_RE = /<!--\s*codex-review-halt-cleared\s*-->/;

/**
 * @param {Array} comments - PR comments in chronological (creation) order,
 *   each `{ body, author?: { login } }`.
 * @param {{ ownerLogin?: string }} [opts] - the repo owner's login (round-2
 *   item 6); a clearing comment whose author does not match is ignored.
 */
function parseLedger(comments, opts) {
  opts = opts || {};
  const ownerLogin = opts.ownerLogin;
  comments = Array.isArray(comments) ? comments : [];
  const entries = [];
  let tampered = false;
  let tamperReason = null;
  // Round 2 fix (item 5): order-aware halt/clear — track the LAST index of
  // each marker type so a halt posted after the latest clear is active
  // again (halt -> clear -> halt stays halted), instead of a clear seen
  // anywhere ever permanently disabling all future halts.
  let lastHaltIndex = -1;
  let lastClearIndex = -1;

  comments.forEach((c, idx) => {
    const body = c && typeof c.body === 'string' ? c.body : '';

    const m = body.match(ROUND_MARKER_RE);
    if (m) {
      const round = parseInt(m[1], 10);
      const headSha = m[2];
      const storedHash = m[3];
      const fenced = body.match(/```([\s\S]*?)```/);
      const bodyForHash = fenced ? fenced[1].trim() : '';
      const recomputed = sha256(bodyForHash);
      if (recomputed !== storedHash) {
        // Round 2 fix (item 5): ledger corruption is independently
        // blocking and is never bypassed by any later clear marker.
        tampered = true;
        tamperReason = tamperReason || 'LEDGER_TAMPERED';
      }
      entries.push({ round, headSha, storedHash, verdictText: bodyForHash });
    }

    if (HALT_MARKER_RE.test(body)) {
      lastHaltIndex = idx;
    }
    if (HALT_CLEARED_RE.test(body)) {
      // Round 2 fix (item 6): only the repo owner's own comment can clear
      // a halt. A clearing marker from anyone else (or with no author
      // info to check against) is ignored entirely — it never advances
      // lastClearIndex, so it cannot lift an active halt.
      const login = c && c.author && c.author.login;
      if (ownerLogin && login === ownerLogin) {
        lastClearIndex = idx;
      }
    }
  });

  const haltActive = tampered || lastHaltIndex > lastClearIndex;
  const maxRound = entries.reduce((m, e) => Math.max(m, e.round), 0);
  return {
    entries,
    halted: haltActive,
    haltCleared: !haltActive && lastHaltIndex >= 0,
    haltReason: tampered ? tamperReason : haltActive ? 'PRIOR_HALT' : null,
    expectedRound: maxRound + 1,
  };
}

function renderLedgerComment({ round, headSha, bucket, verdictText, reason }) {
  const bodyForHash = (verdictText || '').trim();
  const hash = sha256(bodyForHash);
  const marker = `<!-- codex-review-round:${round} sha:${headSha} hash:${hash} -->`;
  const lines = [marker, `## Codex review — round ${round}`, `SHA: ${headSha}`, `Bucket: ${bucket}`];
  if (reason) lines.push(`Reason: ${reason}`);
  if (bodyForHash) lines.push('', '```', bodyForHash, '```');
  return lines.join('\n');
}

function renderHaltComment({ prNumber, round, condition }) {
  const marker = '<!-- codex-review-halt -->';
  // Deliberately do NOT spell out the clear-marker's literal HTML-comment
  // syntax here: this comment's own body is scanned by HALT_CLEARED_RE on
  // every later read, and an example containing the real
  // `<!-- codex-review-halt-cleared -->` string would make the halt
  // self-clear the instant it is posted.
  return [
    marker,
    '## Codex review HALTED',
    `PR: #${prNumber}`,
    `Round count so far: ${round}`,
    `Condition: ${condition}`,
    '',
    'Owner approval is required before continuing. To lift this halt, the',
    'repo owner (and only the repo owner) must post a new PR comment whose',
    'body is the marker named codex-review-halt-cleared (as an HTML',
    'comment, the same way this halt marker is written above) -- this',
    'comment must not itself contain that marker.',
  ].join('\n');
}

// ── Total-outcome helpers (round 2, items 8/9) ───────────────────────────

const HALT_TRIGGER_BUCKETS = new Set(['HALTED', 'DRAFT_PR', 'EMPTY_FENCE', 'ROUND_EXCEEDED', 'OUT_OF_FENCE_BLOCKER']);

/**
 * Round 2 fix (item 9): every halt-triggering outcome — including a caller
 * request for round 3 specifically (INVALID_SHAPE/ROUND_OUT_OF_RANGE with
 * callerRound === 3, per the spec's Escalation section) — must post the
 * durable halt marker before exiting. Other INVALID_SHAPE causes (bad
 * round 0, non-integer round, shape/SHA/round mismatches) are ordinary
 * refusals, not halts.
 */
function isHaltTrigger(bucket, reason, callerRound) {
  if (HALT_TRIGGER_BUCKETS.has(bucket)) return true;
  if (bucket === 'INVALID_SHAPE' && reason === 'ROUND_OUT_OF_RANGE' && callerRound === 3) return true;
  return false;
}

/**
 * Round 2 fix (item 8): VALID_APPROVE exits 0, VALID_BLOCK exits 2, and
 * every halt/precondition/gate-error bucket exits 3.
 */
function exitCodeFor(bucket) {
  if (bucket === 'VALID_APPROVE') return 0;
  if (bucket === 'VALID_BLOCK') return 2;
  return 3;
}

/**
 * Round 2 fix (item 12a): `--round` must be exactly the string "1" or "2";
 * "0", "1.5", "3", "-1", "abc" etc. all fail strict-integer parsing (NaN),
 * which preconditionBucket's ROUND_OUT_OF_RANGE branch then refuses —
 * unlike `parseInt`, which silently truncates "1.5" to 1.
 */
function parseStrictRound(raw) {
  if (typeof raw !== 'string' || !/^\d+$/.test(raw)) return NaN;
  return parseInt(raw, 10);
}

// ── Process-level plumbing (not exercised by pure-logic unit tests) ─────

function resolveCodexExe() {
  if (process.env.CODEX_EXE) return process.env.CODEX_EXE;
  const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  const binDir = path.join(localAppData, 'OpenAI', 'Codex', 'bin');
  try {
    const entries = fs
      .readdirSync(binDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => path.join(binDir, e.name, 'codex.exe'))
      .filter((p) => fs.existsSync(p))
      .map((p) => ({ p, mtime: fs.statSync(p).mtimeMs }));
    if (entries.length > 0) {
      entries.sort((a, b) => b.mtime - a.mtime);
      return entries[0].p;
    }
  } catch (_) {
    // fall through to PATH lookup
  }
  return 'codex';
}

function defaultRunners() {
  return {
    gh: (args, opts) => spawnSync('gh', args, Object.assign({ encoding: 'utf8' }, opts)),
    git: (args, opts) => spawnSync('git', args, Object.assign({ encoding: 'utf8' }, opts)),
    codex: (exe, args, opts) => spawnSync(exe, args, Object.assign({ encoding: 'utf8' }, opts)),
  };
}

function ghJson(args, cwd, runners) {
  const r = runners.gh(args, { cwd });
  if (r.status !== 0) {
    throw new Error(`gh ${args.join(' ')} failed (exit ${r.status}): ${r.stderr || r.stdout}`);
  }
  return JSON.parse(r.stdout);
}

function fetchOwnerLogin({ repoRoot, runners }) {
  const info = ghJson(['repo', 'view', '--json', 'owner'], repoRoot, runners);
  return (info && info.owner && info.owner.login) || null;
}

/**
 * Round 2 fix (items 1/2): resolve and use the PR base SHA explicitly; a
 * missing baseRefOid or a nonzero-exit/errored `git diff` is a gate error,
 * never a silent fallback to `HEAD`. `stderrTail` is capped and carries no
 * caller-supplied env values (repoRoot, session ids) — just the process's
 * own stderr.
 */
function computeDiff({ baseRefOid, headSha, repoRoot, runners }) {
  if (!baseRefOid || typeof baseRefOid !== 'string') {
    return { ok: false, reason: 'MISSING_BASE_REF_OID', diff: null };
  }
  const r = runners.git(['diff', `${baseRefOid}...${headSha}`], { cwd: repoRoot });
  if (r.status !== 0) {
    return {
      ok: false,
      reason: 'DIFF_COMMAND_FAILED',
      diff: null,
      stderrTail: String(r.stderr || '').slice(-500),
    };
  }
  return { ok: true, diff: r.stdout || '' };
}

/**
 * Round 2 fix (item 7): the result of every `gh pr comment` call is
 * checked; a failure is surfaced, never swallowed.
 */
function postPrComment({ prNumber, body, repoRoot, runners }) {
  const tmp = path.join(os.tmpdir(), `codex-review-comment-${crypto.randomBytes(6).toString('hex')}.md`);
  fs.writeFileSync(tmp, body, 'utf8');
  const r = runners.gh(['pr', 'comment', String(prNumber), '--body-file', tmp], { cwd: repoRoot });
  return { ok: r.status === 0, status: r.status, stderrTail: String(r.stderr || '').slice(-500) };
}

function assemblePrompt({ pr, fence, round, priorVerdict, diff }) {
  const lines = [];
  lines.push('# Role');
  lines.push(
    'You are directed to check specific things in this diff. Your own',
    'architecture preferences are out of scope and must not appear as',
    'findings.'
  );
  lines.push('', '# Scope fence (the only files you may cite)');
  for (const p of fence.paths) lines.push(`- ${p}`);
  lines.push('', '# PR purpose (verbatim)', pr.body || '(no body)');
  lines.push('', `# Round ${round}`);
  if (round === 2 && priorVerdict) {
    lines.push('Verify ONLY these round-1 BLOCKER findings. No new findings are accepted this round.');
    for (const f of priorVerdict.findings.filter((x) => x.severity === 'BLOCKER')) {
      lines.push(`- file=${f.file} text=${f.text}`);
    }
  }
  lines.push('', '# Required verdict template (output ONLY this; no other text)');
  lines.push(
    'SHA: <head sha>',
    'VERDICT: APPROVE|BLOCK',
    'SCOPE_RESPECTED: yes|no',
    `ROUND: ${round}`,
    'FINDINGS:',
    '- BLOCKER file=<path> text=<remedy>',
    'END_FINDINGS'
  );
  lines.push('', '# Diff', diff);
  return lines.join('\n');
}

/**
 * Round 2 fix (item 4): immediately before posting anything, re-read the
 * full comment list. If a marker for the same (round, headSha) appeared in
 * the meantime (a concurrent invocation won the race), abort as
 * ROUND_EXCEEDED without posting — never a duplicate.
 *
 * Round 2 fix (items 6/7/9): halt-triggering buckets post the durable halt
 * marker; VALID_APPROVE/VALID_BLOCK post the ledger comment; either post's
 * result is checked, and a failed post demotes the outcome to a CODEX_ERROR
 * gate error rather than exiting as if it had succeeded.
 */
function postOutcome({ bucket, reason, pr, round, headSha, repoRoot, runners, ownerLogin, verdictStdout }) {
  const freshComments = ghJson(['pr', 'view', String(pr), '--json', 'comments'], repoRoot, runners).comments || [];
  const freshLedger = parseLedger(freshComments, { ownerLogin });
  const dupNow = freshLedger.entries.some((e) => e.round === round && e.headSha === headSha);
  if (dupNow) {
    return { bucket: 'ROUND_EXCEEDED', reason: 'ROUND_ALREADY_RECORDED_ON_REREAD' };
  }

  if (isHaltTrigger(bucket, reason, round)) {
    const haltBody = renderHaltComment({ prNumber: pr, round, condition: bucket });
    const posted = postPrComment({ prNumber: pr, body: haltBody, repoRoot, runners });
    if (!posted.ok) {
      return { bucket: 'CODEX_ERROR', reason: `HALT_POST_FAILED_${posted.status}` };
    }
    return { bucket, reason };
  }

  if (bucket === 'VALID_APPROVE' || bucket === 'VALID_BLOCK') {
    const ledgerBody = renderLedgerComment({ round, headSha, bucket, verdictText: verdictStdout, reason });
    const posted = postPrComment({ prNumber: pr, body: ledgerBody, repoRoot, runners });
    if (!posted.ok) {
      return { bucket: 'CODEX_ERROR', reason: `LEDGER_POST_FAILED_${posted.status}` };
    }
    return { bucket, reason };
  }

  // Ordinary non-halting, non-passing refusal (e.g. plain INVALID_SHAPE) —
  // nothing to post.
  return { bucket, reason };
}

/**
 * Full orchestration, injectable via `runners` ({ gh, git, codex }) so it
 * is unit-testable without any real subprocess. Never calls
 * `process.exit` itself; returns `{ bucket, reason, exitCode, lines }`
 * where `lines` is the ordered stdout output including the mandatory
 * final single-line JSON result (round-2 item 8).
 */
function runReview({ pr, round, repoRoot, dryRun }, runners) {
  const lines = [];
  const finalize = (bucket, reason, sha) => {
    const exitCode = exitCodeFor(bucket);
    lines.push(`Bucket: ${bucket}${reason ? ` (${reason})` : ''}`);
    if (isHaltTrigger(bucket, reason, round)) lines.push('HALT');
    lines.push(JSON.stringify({ outcome: bucket, round: Number.isFinite(round) ? round : null, sha: sha || null, reason: reason || null }));
    return { bucket, reason, exitCode, lines };
  };
  const finalizeWithPost = (bucket, reason, headSha, ownerLogin, verdictStdout) => {
    if (dryRun) return finalize(bucket, reason, headSha);
    const posted = postOutcome({ bucket, reason, pr, round, headSha, repoRoot, runners, ownerLogin, verdictStdout });
    return finalize(posted.bucket, posted.reason, headSha);
  };

  const prView = ghJson(['pr', 'view', String(pr), '--json', 'files,body,headRefOid,isDraft,baseRefOid'], repoRoot, runners);
  // Round 2 fix (item 11): keep previousPath through to buildFence so
  // renamed files' pre-rename path is preserved in the live fence, not
  // just in synthetic unit fixtures.
  const files = (prView.files || []).map((f) => ({ path: f.path, previousPath: f.previousPath }));
  const fence = buildFence(files);
  const headSha = prView.headRefOid;
  const isDraft = !!prView.isDraft;

  const ownerLogin = fetchOwnerLogin({ repoRoot, runners });
  const comments = ghJson(['pr', 'view', String(pr), '--json', 'comments'], repoRoot, runners).comments || [];
  const ledger = parseLedger(comments, { ownerLogin });

  const pre = preconditionBucket({ fence, isDraft, ledger, round, headSha });
  if (pre) {
    return finalizeWithPost(pre.bucket, pre.reason, headSha, ownerLogin);
  }

  // Round 2 fix (item 3): round 2 must load and pass the round-1 verdict.
  let priorVerdict = null;
  if (round === 2) {
    const priorEntry = ledger.entries.find((e) => e.round === 1);
    const parsed = priorEntry ? parseVerdict(priorEntry.verdictText) : { valid: false };
    if (!priorEntry || !parsed.valid) {
      return finalizeWithPost('ROUND_EXCEEDED', 'MISSING_PRIOR_VERDICT', headSha, ownerLogin);
    }
    priorVerdict = parsed;
  }

  const diffResult = computeDiff({ baseRefOid: prView.baseRefOid, headSha, repoRoot, runners });
  if (!diffResult.ok) {
    // Diff failure is a gate error before Codex is ever invoked — never
    // routed through postOutcome (nothing to post for a plumbing failure).
    return finalize('CODEX_ERROR', diffResult.reason, headSha);
  }
  if (!diffResult.diff.trim()) {
    return finalizeWithPost('EMPTY_FENCE', 'EMPTY_DIFF', headSha, ownerLogin);
  }

  const prompt = assemblePrompt({ pr: prView, fence, round, priorVerdict, diff: diffResult.diff });

  if (dryRun) {
    lines.push(prompt);
    lines.push(`\n[dry-run] would classify against: fence=${fence.paths.length} files, headSha=${headSha}`);
    lines.push(JSON.stringify({ outcome: 'DRY_RUN', round, sha: headSha, reason: null }));
    return { bucket: 'DRY_RUN', reason: null, exitCode: 0, lines };
  }

  const tmpFile = path.join(os.tmpdir(), `codex-review-prompt-${crypto.randomBytes(6).toString('hex')}.md`);
  fs.writeFileSync(tmpFile, prompt, 'utf8');
  const codexExe = resolveCodexExe();
  const run = runners.codex(codexExe, ['exec', '-', '-s', 'read-only', '-C', repoRoot], {
    input: fs.readFileSync(tmpFile, 'utf8'),
  });

  const verdict = parseVerdict(run.stdout);
  const result = classify({
    exitCode: run.status,
    stdout: run.stdout,
    verdict,
    fence,
    headSha,
    round,
    ledger,
    isDraft,
  });

  return finalizeWithPost(result.bucket, result.reason, headSha, ownerLogin, run.stdout);
}

function main(argv) {
  const args = { round: undefined, rawRound: undefined, pr: undefined, repoRoot: process.cwd(), dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--pr') args.pr = parseInt(argv[++i], 10);
    else if (a === '--round') {
      args.rawRound = argv[++i];
      args.round = parseStrictRound(args.rawRound);
    } else if (a === '--repo-root') args.repoRoot = argv[++i];
    else if (a === '--dry-run') args.dryRun = true;
    else {
      console.error(`Unrecognized argument: ${a}`);
      process.exit(2);
    }
  }
  if (!args.pr || args.rawRound === undefined) {
    console.error('Usage: codex-review.js --pr <N> --round <1|2> [--repo-root <path>] [--dry-run]');
    process.exit(2);
  }

  const result = runReview({ pr: args.pr, round: args.round, repoRoot: args.repoRoot, dryRun: args.dryRun }, defaultRunners());
  for (const line of result.lines) console.log(line);
  process.exit(result.exitCode);
}

if (require.main === module) {
  main(process.argv.slice(2));
}

module.exports = {
  normalizePath,
  buildFence,
  parseVerdict,
  classify,
  preconditionBucket,
  renderLedgerComment,
  renderHaltComment,
  parseLedger,
  sha256,
  assemblePrompt,
  resolveCodexExe,
  isHaltTrigger,
  exitCodeFor,
  parseStrictRound,
  computeDiff,
  postPrComment,
  postOutcome,
  fetchOwnerLogin,
  ghJson,
  defaultRunners,
  runReview,
};
