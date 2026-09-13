'use strict';

/**
 * codex-review.js — directed Codex-as-PR-reviewer wrapper.
 *
 * Spec: docs/specs/codex-review-contract.md (17 adversary findings fixed
 * 2026-09-13 before this file was authored, per this repo's
 * adversary-before-author rule).
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
 * testing without any `gh`/`codex` process — see test/test-codex-review.js.
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

function classify(ctx) {
  ctx = ctx || {};
  const { exitCode, stdout, verdictText, fence, headSha, round, ledger, isDraft } = ctx;

  // 1. Prior halt not cleared, or ledger tamper-evident-invalid.
  if (ledger && ledger.halted && !ledger.haltCleared) {
    return { bucket: 'HALTED', reason: ledger.haltReason || 'PRIOR_HALT_UNCLEARED' };
  }

  // 2. Draft PR.
  if (isDraft) {
    return { bucket: 'DRAFT_PR', reason: 'PR_IS_DRAFT' };
  }

  // 3. Empty fence.
  if (!fence || !Array.isArray(fence.paths) || fence.paths.length === 0) {
    return { bucket: 'EMPTY_FENCE', reason: 'ZERO_CHANGED_FILES' };
  }

  // 4. Idempotent dup-round abort (C8/C9), checked before the disagree check
  //    so a legitimate retry of the same (round, headSha) is recognized.
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

  // 6. Caller round disagrees with ledger-computed next round (C11: force
  //    push does not reset this — expectedRound is keyed by PR, not SHA).
  if (ledger && typeof ledger.expectedRound === 'number' && ledger.expectedRound !== round) {
    return { bucket: 'INVALID_SHAPE', reason: 'ROUND_DISAGREES_WITH_LEDGER' };
  }

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

  // 10. Content-level round widening.
  if (verdict.round > 2) {
    return { bucket: 'ROUND_EXCEEDED', reason: 'VERDICT_ROUND_GT_2' };
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

// ── Ledger (C8-C11) ──────────────────────────────────────────────────────

function sha256(s) {
  return crypto.createHash('sha256').update(String(s), 'utf8').digest('hex');
}

const ROUND_MARKER_RE = /<!--\s*codex-review-round:(\d+)\s+sha:(\S+)\s+hash:(\S+)\s*-->/;
const HALT_MARKER_RE = /<!--\s*codex-review-halt\s*-->/;
const HALT_CLEARED_RE = /<!--\s*codex-review-halt-cleared\s*-->/;

function parseLedger(comments) {
  comments = Array.isArray(comments) ? comments : [];
  const entries = [];
  let halted = false;
  let haltCleared = false;
  let haltReason = null;

  for (const c of comments) {
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
        halted = true;
        haltReason = haltReason || 'LEDGER_TAMPERED';
      }
      entries.push({ round, headSha, storedHash });
    }

    if (HALT_MARKER_RE.test(body)) {
      halted = true;
      haltReason = haltReason || 'PRIOR_HALT';
    }
    if (HALT_CLEARED_RE.test(body)) {
      haltCleared = true;
    }
  }

  const maxRound = entries.reduce((m, e) => Math.max(m, e.round), 0);
  return {
    entries,
    halted,
    haltCleared,
    haltReason,
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
    'Owner approval is required before continuing. To lift this halt, post a',
    'new PR comment whose body is the marker named codex-review-halt-cleared',
    '(as an HTML comment, the same way this halt marker is written above) --',
    'this comment must not itself contain that marker.',
  ].join('\n');
}

// ── Process-level plumbing (not exercised by unit tests) ────────────────

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

function ghJson(args, cwd) {
  const r = spawnSync('gh', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) {
    throw new Error(`gh ${args.join(' ')} failed (exit ${r.status}): ${r.stderr || r.stdout}`);
  }
  return JSON.parse(r.stdout);
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

function main(argv) {
  const args = { round: undefined, pr: undefined, repoRoot: process.cwd(), dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--pr') args.pr = parseInt(argv[++i], 10);
    else if (a === '--round') args.round = parseInt(argv[++i], 10);
    else if (a === '--repo-root') args.repoRoot = argv[++i];
    else if (a === '--dry-run') args.dryRun = true;
    else {
      console.error(`Unrecognized argument: ${a}`);
      process.exit(2);
    }
  }
  if (!args.pr || !args.round) {
    console.error('Usage: codex-review.js --pr <N> --round <1|2> [--repo-root <path>] [--dry-run]');
    process.exit(2);
  }

  const prView = ghJson(['pr', 'view', String(args.pr), '--json', 'files,body,headRefOid,isDraft'], args.repoRoot);
  const files = (prView.files || []).map((f) => ({ path: f.path }));
  const fence = buildFence(files);
  const headSha = prView.headRefOid;
  const isDraft = !!prView.isDraft;

  const commentsRaw = ghJson(['pr', 'view', String(args.pr), '--json', 'comments'], args.repoRoot);
  const ledger = parseLedger(commentsRaw.comments || []);

  // Preconditions that never need to invoke Codex.
  const pre = classify({ fence, isDraft, ledger, round: args.round, headSha });
  if (pre.bucket !== 'VALID_APPROVE' && pre.bucket !== 'VALID_BLOCK') {
    if (['HALTED', 'DRAFT_PR', 'EMPTY_FENCE', 'ROUND_EXCEEDED', 'INVALID_SHAPE'].includes(pre.bucket)) {
      console.log(`Bucket: ${pre.bucket} (${pre.reason})`);
      if (pre.bucket === 'HALTED') console.log('HALT');
      process.exit(pre.bucket === 'ROUND_EXCEEDED' ? 1 : pre.bucket === 'HALTED' ? 1 : 1);
    }
  }

  const diff = spawnSync('git', ['diff', `${prView.baseRefOid || 'HEAD'}...${headSha}`], {
    cwd: args.repoRoot,
    encoding: 'utf8',
  }).stdout;

  const prompt = assemblePrompt({ pr: prView, fence, round: args.round, priorVerdict: null, diff });

  if (args.dryRun) {
    console.log(prompt);
    console.log(`\n[dry-run] would classify against: fence=${fence.paths.length} files, headSha=${headSha}`);
    process.exit(0);
  }

  const tmpFile = path.join(os.tmpdir(), `codex-review-prompt-${Date.now()}.md`);
  fs.writeFileSync(tmpFile, prompt, 'utf8');
  const codexExe = resolveCodexExe();
  const run = spawnSync(codexExe, ['exec', '-', '-s', 'read-only', '-C', args.repoRoot], {
    input: fs.readFileSync(tmpFile, 'utf8'),
    encoding: 'utf8',
  });

  const verdict = parseVerdict(run.stdout);
  const result = classify({
    exitCode: run.status,
    stdout: run.stdout,
    verdict,
    fence,
    headSha,
    round: args.round,
    ledger,
    isDraft,
  });

  console.log(`Bucket: ${result.bucket}${result.reason ? ` (${result.reason})` : ''}`);

  if (result.bucket === 'ROUND_EXCEEDED' || result.bucket === 'HALTED') {
    const haltBody = renderHaltComment({ prNumber: args.pr, round: args.round, condition: result.bucket });
    const tmpHalt = path.join(os.tmpdir(), `codex-review-halt-${Date.now()}.md`);
    fs.writeFileSync(tmpHalt, haltBody, 'utf8');
    spawnSync('gh', ['pr', 'comment', String(args.pr), '--body-file', tmpHalt], { cwd: args.repoRoot });
    console.log('HALT');
    process.exit(1);
  }

  const ledgerBody = renderLedgerComment({
    round: args.round,
    headSha,
    bucket: result.bucket,
    verdictText: run.stdout,
    reason: result.reason,
  });
  const tmpLedger = path.join(os.tmpdir(), `codex-review-ledger-${Date.now()}.md`);
  fs.writeFileSync(tmpLedger, ledgerBody, 'utf8');
  spawnSync('gh', ['pr', 'comment', String(args.pr), '--body-file', tmpLedger], { cwd: args.repoRoot });

  process.exit(result.bucket === 'VALID_APPROVE' || result.bucket === 'VALID_BLOCK' ? 0 : 1);
}

if (require.main === module) {
  main(process.argv.slice(2));
}

module.exports = {
  normalizePath,
  buildFence,
  parseVerdict,
  classify,
  renderLedgerComment,
  renderHaltComment,
  parseLedger,
  sha256,
  assemblePrompt,
  resolveCodexExe,
};
