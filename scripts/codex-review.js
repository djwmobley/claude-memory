'use strict';

/**
 * codex-review.js — directed Codex-as-PR-reviewer wrapper.
 *
 * Spec: docs/specs/codex-review-contract.md (17 adversary findings fixed
 * 2026-09-13 before this file was authored, per this repo's
 * adversary-before-author rule). Round 2 (2026-09-13) fixed 12 in-fence
 * blockers found by an independent Codex-review dogfood pass on round 1.
 * Round 3 (2026-09-13) fixes the 4 round-2 blockers that survived the round
 * cap, per an owner-approved amended spec:
 *
 *   (a) Post-run ledger re-check — before posting an APPROVE, the wrapper
 *       re-reads every PR comment (paginated, cross-checked against the
 *       issue's own comment count) and reclassifies anything NEW since a
 *       pre-run snapshot, so a halt or a same-round different-SHA entry
 *       posted while Codex was running is never silently missed.
 *   (b) Marker anchoring — HALT and HALT_CLEAR markers are recognized only
 *       when owner-authored, carrying round+sha fields, and the FIRST
 *       non-whitespace content of the comment body after stripping fenced/
 *       indented/quoted blocks — so a marker merely quoted inside a fenced
 *       finding (or by a non-owner) can never clear (or fake) a halt.
 *   (c) Structured verdict — Codex now emits exactly one machine-checkable
 *       ```codex-verdict``` block (verdict/scope_request/findings), parsed
 *       byte-exact, instead of free-text findings that a widening-phrase
 *       regex can never fully enumerate.
 *   (d) Fence from local git — the scope fence is built from
 *       `git diff --name-status -M -z <base>...<head>`, NUL-delimited,
 *       never from `gh pr view --json files` (which never emits
 *       previousPath for a rename).
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
 * ({ gh, git, codex }) so it is unit-testable without any real subprocess —
 * see test/test-codex-review.js.
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

// ── Fence (B6, and round-3 item d) ───────────────────────────────────────

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

/**
 * Round 3 fix (item d): parse `git diff --name-status -M -z <base>...<head>`
 * output. NUL-delimited so paths containing spaces or any other byte are
 * handled correctly without quoting ambiguity — this is exactly why `-z`
 * is required, never plain `--name-status` output split on newlines.
 *
 * Record shape per NUL-delimited token stream:
 *   - A/M/D/T status: <STATUS>\0<path>\0
 *   - R<score>/C<score> status (rename/copy): <STATUS>\0<oldPath>\0<newPath>\0
 *
 * Total classification: any status letter other than A/M/D/T/R/C, or a
 * record with a missing/empty path, is a SHORT_RECORD or UNKNOWN_STATUS
 * failure — never silently skipped or guessed at from position, since this
 * reads a stream a human never hand-edits but a git version skew or a
 * future rename-detection flag change could still alter unexpectedly.
 */
function parseNameStatusZ(raw) {
  if (typeof raw !== 'string') return { ok: false, reason: 'NOT_STRING' };
  let parts = raw.split('\0');
  // git -z output ends every record (including the last) with a NUL, which
  // produces exactly one trailing empty string from split(); strip only
  // that one, never more (a genuinely empty intermediate token is a
  // short-record failure, not something to silently absorb).
  if (parts.length > 0 && parts[parts.length - 1] === '') {
    parts = parts.slice(0, -1);
  }
  if (parts.length === 1 && parts[0] === '') {
    return { ok: true, files: [] };
  }

  const files = [];
  let i = 0;
  while (i < parts.length) {
    const statusToken = parts[i];
    if (!statusToken) return { ok: false, reason: 'SHORT_RECORD' };
    const letter = statusToken[0];
    if (letter === 'A' || letter === 'M' || letter === 'D' || letter === 'T') {
      const p = parts[i + 1];
      if (i + 1 >= parts.length || !p) return { ok: false, reason: 'SHORT_RECORD' };
      files.push({ status: letter, path: p });
      i += 2;
    } else if (letter === 'R' || letter === 'C') {
      const oldPath = parts[i + 1];
      const newPath = parts[i + 2];
      if (i + 2 >= parts.length || !oldPath || !newPath) return { ok: false, reason: 'SHORT_RECORD' };
      files.push({ status: letter, path: newPath, previousPath: oldPath });
      i += 3;
    } else {
      return { ok: false, reason: `UNKNOWN_STATUS_${letter}` };
    }
  }
  return { ok: true, files };
}

/**
 * Round 3 fix (item d): the fence is resolved from local git, never from
 * `gh pr view --json files` (which never populates `previousPath` on a
 * rename — round-2 item 11 papered over this with a synthetic test
 * fixture; this closes the real gap).
 */
function computeFence({ baseRefOid, headSha, repoRoot, runners, platform }) {
  if (!baseRefOid || typeof baseRefOid !== 'string') {
    return { ok: false, reason: 'MISSING_BASE_REF_OID' };
  }
  const r = runners.git(['diff', '--name-status', '-M', '-z', `${baseRefOid}...${headSha}`], { cwd: repoRoot });
  if (r.status !== 0) {
    return { ok: false, reason: 'DIFF_COMMAND_FAILED', stderrTail: String(r.stderr || '').slice(-500) };
  }
  const parsed = parseNameStatusZ(r.stdout || '');
  if (!parsed.ok) {
    return { ok: false, reason: parsed.reason };
  }
  return { ok: true, fence: buildFence(parsed.files, platform) };
}

/**
 * The actual diff CONTENT sent to Codex in the prompt — a separate git
 * invocation from computeFence's `--name-status` listing.
 */
function computeDiffContent({ baseRefOid, headSha, repoRoot, runners }) {
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

// ── Block/quote stripping, shared by marker anchoring (b) and the
// structured-verdict prose scan (c) ──────────────────────────────────────

/**
 * Strips ``` fences, ~~~ fences, 4-space/tab-indented code blocks, and
 * blockquote (`>`-prefixed) lines OUT ENTIRELY — the removed content does
 * not collapse into adjacent text, it disappears, so nothing that was only
 * reachable inside one of those constructs can become "the first
 * non-whitespace content" of what remains. Deliberately does NOT strip
 * HTML comments: the wrapper's own markers ARE HTML comments and must
 * remain visible to the anchoring check.
 */
function stripQuotedAndFencedBlocks(body) {
  const lines = String(body || '').split(/\r\n|\r|\n/);
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const leadTrimmed = line.replace(/^[ \t]*/, '');
    const fenceMatch = leadTrimmed.match(/^(`{3,}|~{3,})/);
    if (fenceMatch) {
      const fenceChar = fenceMatch[1][0];
      const fenceLen = fenceMatch[1].length;
      const closeRe = new RegExp(`^${fenceChar === '`' ? '`' : '~'}{${fenceLen},}\\s*$`);
      i++;
      while (i < lines.length) {
        const isClose = closeRe.test(lines[i].replace(/^[ \t]*/, ''));
        i++;
        if (isClose) break;
      }
      continue;
    }
    if (/^( {4}|\t)/.test(line)) {
      i++;
      continue;
    }
    if (/^[ \t]*>/.test(line)) {
      i++;
      continue;
    }
    out.push(line);
    i++;
  }
  return out.join('\n');
}

// ── Structured verdict template parsing (round-3 item c) ────────────────

const CODEX_VERDICT_FENCE_RE = /```codex-verdict\r?\n([\s\S]*?)```/g;
const VERDICT_LINE_RE = {
  verdict: /^verdict: (.*)$/,
  scope_request: /^scope_request: (.*)$/,
  findings: /^findings: (.*)$/,
};
// Round 2's widening phrases (kept as a belt-and-suspenders prose scan);
// the primary fix for round-2 item 3 (widening requests in free text a
// regex can never fully enumerate) is the `scope_request` enum field
// itself, a total classification of intent rather than a phrase list.
const WIDEN_TEXT_RE = /\b(another (pass|round)|one more (pass|round)|second pass|third pass|run (it )?again|do another round|widen the scope|widen this review)\b/i;
const SEVERITY_WORD_RE = /\b(blocker|critical|security|vulnerab)/i;

function findCodexVerdictBlocks(text) {
  const blocks = [];
  const re = new RegExp(CODEX_VERDICT_FENCE_RE.source, 'g');
  let m;
  while ((m = re.exec(text)) !== null) {
    blocks.push(m[1]);
  }
  return blocks;
}

function hasNonAscii(s) {
  for (let i = 0; i < s.length; i++) {
    if (s.codePointAt(i) > 127) return true;
  }
  return false;
}

/**
 * Field values are matched exact-byte, case-sensitive, no surrounding
 * whitespace, no non-ASCII bytes (which also rejects zero-width
 * characters, since those are non-ASCII).
 */
function parseCodexVerdictBlock(blockText) {
  const lines = String(blockText || '')
    .split(/\r\n|\r|\n/)
    .filter((l) => l.length > 0);
  const fields = {};
  for (const line of lines) {
    let matched = false;
    for (const key of Object.keys(VERDICT_LINE_RE)) {
      const m = line.match(VERDICT_LINE_RE[key]);
      if (m) {
        if (fields[key] !== undefined) return { valid: false, reason: `DUPLICATE_FIELD_${key.toUpperCase()}` };
        fields[key] = m[1];
        matched = true;
        break;
      }
    }
    if (!matched) return { valid: false, reason: 'UNRECOGNIZED_LINE_IN_VERDICT_BLOCK' };
  }
  for (const key of Object.keys(VERDICT_LINE_RE)) {
    if (fields[key] === undefined) return { valid: false, reason: `MISSING_FIELD_${key.toUpperCase()}` };
  }
  for (const key of Object.keys(fields)) {
    const v = fields[key];
    if (/^\s|\s$/.test(v)) return { valid: false, reason: `FIELD_WHITESPACE_${key.toUpperCase()}` };
    if (hasNonAscii(v)) return { valid: false, reason: `FIELD_NON_ASCII_${key.toUpperCase()}` };
  }
  if (fields.verdict !== 'APPROVE' && fields.verdict !== 'BLOCK') {
    return { valid: false, reason: 'VERDICT_UNKNOWN_VALUE' };
  }
  if (!['none', 'widen', 'another_pass'].includes(fields.scope_request)) {
    return { valid: false, reason: 'SCOPE_REQUEST_UNKNOWN_VALUE' };
  }
  if (!/^\d+$/.test(fields.findings)) {
    return { valid: false, reason: 'FINDINGS_NOT_INTEGER' };
  }
  return {
    valid: true,
    verdict: fields.verdict,
    scopeRequest: fields.scope_request,
    findings: parseInt(fields.findings, 10),
  };
}

/**
 * Round-3 item c, total classification of the structured verdict:
 *   - block missing / duplicated / malformed / unknown-value -> NEEDS_OWNER
 *   - verdict=BLOCK (once validly parsed) -> STRUCTURED_BLOCK, unconditionally
 *   - verdict=APPROVE -> STRUCTURED_APPROVE only if scope_request=none,
 *     findings=0, no severity word in the remaining prose, and the
 *     widening regex does not fire either; otherwise -> NEEDS_OWNER.
 * The widening/severity scan can only push APPROVE toward NEEDS_OWNER,
 * never move NEEDS_OWNER back to APPROVE.
 */
function classifyStructuredVerdict(stdout) {
  const text = typeof stdout === 'string' ? stdout : '';
  const blocks = findCodexVerdictBlocks(text);
  if (blocks.length === 0) return { bucket: 'NEEDS_OWNER', reason: 'VERDICT_BLOCK_MISSING' };
  if (blocks.length > 1) return { bucket: 'NEEDS_OWNER', reason: 'VERDICT_BLOCK_DUPLICATED' };

  const parsed = parseCodexVerdictBlock(blocks[0]);
  if (!parsed.valid) return { bucket: 'NEEDS_OWNER', reason: parsed.reason };

  if (parsed.verdict === 'BLOCK') {
    return { bucket: 'STRUCTURED_BLOCK', reason: null, verdict: parsed };
  }

  // verdict === 'APPROVE'
  if (parsed.scopeRequest !== 'none') {
    return { bucket: 'NEEDS_OWNER', reason: 'SCOPE_REQUEST_NOT_NONE' };
  }
  if (parsed.findings !== 0) {
    return { bucket: 'NEEDS_OWNER', reason: 'APPROVE_WITH_FINDINGS' };
  }
  const withoutVerdictBlock = text.replace(/```codex-verdict\r?\n[\s\S]*?```/g, '');
  const prose = stripQuotedAndFencedBlocks(withoutVerdictBlock);
  if (SEVERITY_WORD_RE.test(prose)) {
    return { bucket: 'NEEDS_OWNER', reason: 'SEVERITY_WORD_IN_PROSE' };
  }
  if (WIDEN_TEXT_RE.test(prose)) {
    return { bucket: 'NEEDS_OWNER', reason: 'WIDENING_TEXT_IN_PROSE' };
  }
  return { bucket: 'STRUCTURED_APPROVE', reason: null, verdict: parsed };
}

// ── Total classification, preconditions (round-3 items a/b/d retire A1-A4,
// B5-B7's per-BLOCKER checks, C8/C9's shape, F17 -- those all depended on
// per-finding file text that the structured verdict no longer carries) ──

function preconditionBucket({ fenceResult, isDraft, ledger, round, headSha }) {
  // 1. Prior halt not cleared, or ledger tamper-evident-invalid.
  if (ledger && ledger.halted) {
    return { bucket: 'HALTED', reason: ledger.haltReason || 'PRIOR_HALT_UNCLEARED' };
  }

  // 2. Draft PR.
  if (isDraft) {
    return { bucket: 'DRAFT_PR', reason: 'PR_IS_DRAFT' };
  }

  // 3. Fence resolution itself failed (item d) -> escalate, never guess.
  if (!fenceResult || !fenceResult.ok) {
    return { bucket: 'NEEDS_OWNER', reason: `FENCE_UNKNOWN_${(fenceResult && fenceResult.reason) || 'UNKNOWN'}` };
  }

  // 4. Fence resolved but empty (changed-file list is genuinely zero).
  if (!fenceResult.fence || !Array.isArray(fenceResult.fence.paths) || fenceResult.fence.paths.length === 0) {
    return { bucket: 'EMPTY_FENCE', reason: 'ZERO_CHANGED_FILES' };
  }

  // 5. Idempotent dup-round abort (C8/C9) — checked against the ledger as
  // read before Codex ever runs; the post-run re-check (item a) covers the
  // race window Codex's own run takes.
  if (ledger && Array.isArray(ledger.entries)) {
    const dup = ledger.entries.some((e) => e.round === round && e.headSha === headSha);
    if (dup) {
      return { bucket: 'ROUND_EXCEEDED', reason: 'ROUND_ALREADY_RECORDED' };
    }
  }

  // 6. Caller round out of range.
  if (round !== 1 && round !== 2) {
    return { bucket: 'INVALID_SHAPE', reason: 'ROUND_OUT_OF_RANGE' };
  }

  // 7. Caller round disagrees with ledger-computed next round.
  if (ledger && typeof ledger.expectedRound === 'number' && ledger.expectedRound !== round) {
    return { bucket: 'INVALID_SHAPE', reason: 'ROUND_DISAGREES_WITH_LEDGER' };
  }

  return null;
}

/**
 * Pure classification entry point used directly by unit tests as well as
 * by `runReview`. Returns a PENDING bucket of `STRUCTURED_APPROVE` for an
 * otherwise-clean APPROVE — turning that into a final `VALID_APPROVE` (or
 * something else) requires the I/O-bound post-run ledger re-check (item a),
 * which lives in `runReview`/`postOutcome`, not here.
 */
function classify(ctx) {
  ctx = ctx || {};
  const { exitCode, stdout, fenceResult, headSha, round, ledger, isDraft } = ctx;

  const pc = preconditionBucket({ fenceResult, isDraft, ledger, round, headSha });
  if (pc) return pc;

  if (exitCode !== 0 || !stdout || !String(stdout).trim()) {
    return {
      bucket: 'CODEX_ERROR',
      reason: exitCode !== 0 ? `NONZERO_EXIT_${exitCode}` : 'EMPTY_STDOUT',
    };
  }

  return classifyStructuredVerdict(stdout);
}

// ── Ledger (C8-C11; round-3 item b re-anchors HALT/HALT_CLEAR) ──────────

function sha256(s) {
  return crypto.createHash('sha256').update(String(s), 'utf8').digest('hex');
}

const ROUND_MARKER_RE = /<!--\s*codex-review-round:(\d+)\s+sha:(\S+)\s+hash:(\S+)\s*-->/;
const VERDICT_BODY_RE = /<!--\s*codex-review-verdict-begin\s*-->\n([\s\S]*?)\n<!--\s*codex-review-verdict-end\s*-->/;
const HALT_MARKER_ANCHOR_RE = /^<!--\s*codex-review-halt\s+round:(\d+)\s+sha:([0-9a-f]{40})\s*-->/;
const HALT_CLEARED_MARKER_ANCHOR_RE = /^<!--\s*codex-review-halt-cleared\s+round:(\d+)\s+sha:([0-9a-f]{40})\s*-->/;
// Any comment carrying one of the wrapper's marker prefixes ANYWHERE in its
// body, used only to detect a marker-shaped comment that failed full
// recognition (round-3 item a's UNKNOWN_LEDGER_STATE branch) — never used
// on its own to grant recognition.
const WRAPPER_MARKER_PREFIX_RE = /<!--\s*codex-review-(round|halt|halt-cleared)\b/;

/**
 * Round-3 item b: a HALT or HALT_CLEAR marker is recognized only when ALL
 * hold: the comment's author is the repo owner (exact, case-sensitive); the
 * comment's body does NOT also contain a ledger-outcome (`codex-review-
 * round:`) marker anywhere (so a ledger comment can never double as a
 * clear); and, after stripping fenced/indented/quoted blocks entirely, the
 * marker (with its round+sha fields) is the FIRST non-whitespace content
 * of what remains. HTML comments are never stripped by this step — the
 * markers themselves are HTML comments.
 */
function recognizeAnchoredMarker(comment, ownerLogin, anchorRe) {
  if (!comment) return null;
  const body = typeof comment.body === 'string' ? comment.body : '';
  const login = comment.author && comment.author.login;
  if (!ownerLogin || login !== ownerLogin) return null;
  if (ROUND_MARKER_RE.test(body)) return null;
  const stripped = stripQuotedAndFencedBlocks(body).replace(/^\s+/, '');
  const m = stripped.match(anchorRe);
  if (!m) return null;
  return { round: parseInt(m[1], 10), headSha: m[2] };
}

/**
 * @param {Array} comments - PR comments in chronological (creation) order,
 *   each `{ id, body, author?: { login } }`.
 * @param {{ ownerLogin?: string }} [opts] - the repo owner's login; any
 *   marker authored by anyone else is never recognized (round-3 item b
 *   extends this, previously halt-clear-only, to HALT markers too).
 */
function parseLedger(comments, opts) {
  opts = opts || {};
  const ownerLogin = opts.ownerLogin;
  comments = Array.isArray(comments) ? comments : [];
  const entries = [];
  let tampered = false;
  let tamperReason = null;
  // Keyed by `${round}:${headSha}` so a clear only lifts the halt it names
  // exactly (round-3 item b) — a mismatched round/sha on a clear leaves the
  // active halt untouched. `active` re-flips to true on a later halt at the
  // same key (order-aware halt -> clear -> halt re-activation, round-2 item 5).
  const haltState = new Map();

  comments.forEach((c, idx) => {
    const body = c && typeof c.body === 'string' ? c.body : '';

    const m = body.match(ROUND_MARKER_RE);
    if (m) {
      const round = parseInt(m[1], 10);
      const headSha = m[2];
      const storedHash = m[3];
      const fenced = body.match(VERDICT_BODY_RE);
      const bodyForHash = fenced ? fenced[1].trim() : '';
      const recomputed = sha256(bodyForHash);
      if (recomputed !== storedHash) {
        tampered = true;
        tamperReason = tamperReason || 'LEDGER_TAMPERED';
      }
      entries.push({ round, headSha, storedHash, verdictText: bodyForHash });
    }

    const halt = recognizeAnchoredMarker(c, ownerLogin, HALT_MARKER_ANCHOR_RE);
    if (halt) {
      haltState.set(`${halt.round}:${halt.headSha}`, { active: true, postIndex: idx });
    }
    const clear = recognizeAnchoredMarker(c, ownerLogin, HALT_CLEARED_MARKER_ANCHOR_RE);
    if (clear) {
      const key = `${clear.round}:${clear.headSha}`;
      const existing = haltState.get(key);
      if (existing && idx > existing.postIndex) {
        existing.active = false;
      }
    }
  });

  const anyActiveHalt = Array.from(haltState.values()).some((h) => h.active);
  const haltActive = tampered || anyActiveHalt;
  const maxRound = entries.reduce((m, e) => Math.max(m, e.round), 0);
  return {
    entries,
    halted: haltActive,
    haltCleared: !haltActive && haltState.size > 0,
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
  if (bodyForHash) {
    // HTML-comment sentinels, not a ``` fence: the verdict text itself now
    // legitimately contains a ```codex-verdict``` fence (round-3 item c),
    // so a naive ```-counting re-extraction would stop at the wrong
    // closing fence. Sentinel lines can't collide with that.
    lines.push('', '<!-- codex-review-verdict-begin -->', bodyForHash, '<!-- codex-review-verdict-end -->');
  }
  return lines.join('\n');
}

function renderHaltComment({ prNumber, round, headSha, condition }) {
  const marker = `<!-- codex-review-halt round:${round} sha:${headSha} -->`;
  const clearMarker = `<!-- codex-review-halt-cleared round:${round} sha:${headSha} -->`;
  return [
    marker,
    '## Codex review HALTED',
    `PR: #${prNumber}`,
    `Round: ${round}`,
    `SHA: ${headSha}`,
    `Condition: ${condition}`,
    '',
    'Owner approval is required before continuing. To lift this halt, the',
    'repo owner (and only the repo owner) must post a NEW PR comment whose',
    'entire body starts with exactly the following marker as its first',
    'non-whitespace content (nothing before it, not inside a quote or code',
    'block, and the comment must not also contain a codex-review-round',
    'ledger marker):',
    '',
    clearMarker,
  ].join('\n');
}

// ── Total-outcome helpers ─────────────────────────────────────────────────

const HALT_TRIGGER_BUCKETS = new Set([
  'HALTED',
  'DRAFT_PR',
  'EMPTY_FENCE',
  'ROUND_EXCEEDED',
  'NEEDS_OWNER',
  'STALE_SHA',
  'UNKNOWN_LEDGER_STATE',
]);

function isHaltTrigger(bucket, reason, callerRound) {
  if (HALT_TRIGGER_BUCKETS.has(bucket)) return true;
  if (bucket === 'INVALID_SHAPE' && reason === 'ROUND_OUT_OF_RANGE' && callerRound === 3) return true;
  return false;
}

function exitCodeFor(bucket) {
  if (bucket === 'VALID_APPROVE') return 0;
  if (bucket === 'VALID_BLOCK') return 2;
  return 3;
}

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

/**
 * Round-3 helper: fetch the full PR comment list via the paginated REST
 * endpoint (never `gh pr view --json comments`, whose GraphQL-backed IDs
 * are a different shape from the REST IDs the count cross-check and
 * snapshot-diffing rely on). Returns a normalized `{id, body, author:
 * {login}}` shape so the rest of this module never branches on REST vs
 * GraphQL field names.
 */
function fetchAllPrComments({ owner, repo, prNumber, runners, repoRoot }) {
  const r = runners.gh(['api', '--paginate', `repos/${owner}/${repo}/issues/${prNumber}/comments`], { cwd: repoRoot });
  if (r.status !== 0) return { ok: false, reason: 'FETCH_FAILED' };
  let parsed;
  try {
    parsed = JSON.parse(r.stdout);
  } catch (_) {
    return { ok: false, reason: 'FETCH_PARSE_ERROR' };
  }
  if (!Array.isArray(parsed)) return { ok: false, reason: 'FETCH_SHAPE_ERROR' };
  const comments = parsed.map((c) => ({
    id: c && c.id,
    body: c && typeof c.body === 'string' ? c.body : '',
    author: { login: (c && c.user && c.user.login) || null },
  }));
  return { ok: true, comments };
}

/**
 * Round-3 item a: the issue's own `comments` integer, used ONLY to
 * cross-check the paginated fetch's length immediately before posting —
 * never as a source of comment content.
 */
function fetchIssueCommentCount({ owner, repo, prNumber, runners, repoRoot }) {
  const r = runners.gh(['api', `repos/${owner}/${repo}/issues/${prNumber}`], { cwd: repoRoot });
  if (r.status !== 0) return { ok: false, reason: 'FETCH_FAILED' };
  let parsed;
  try {
    parsed = JSON.parse(r.stdout);
  } catch (_) {
    return { ok: false, reason: 'FETCH_PARSE_ERROR' };
  }
  if (!parsed || typeof parsed.comments !== 'number') return { ok: false, reason: 'FETCH_SHAPE_ERROR' };
  return { ok: true, count: parsed.comments };
}

/**
 * Round-3 item a: immediately before posting an APPROVE, re-read ALL PR
 * comments and cross-check the paginated fetch's length against the
 * issue's own `comments` total; any fetch/parse/shape error or a count
 * mismatch is UNKNOWN_LEDGER_STATE (the ambiguous/failure default — never
 * silently treated as clean). Only comments NEWER than the pre-run
 * snapshot (by REST comment id) that carry a recognized wrapper marker are
 * classified; an ordinary human comment, at any point in time, is ignored.
 *
 * Precedence (fixed): HALTED (an uncleared halt considers ALL comments,
 * new or pre-existing) > STALE_SHA (a new ledger entry for our round with
 * a different headSha) > DUPLICATE (a new ledger entry with our exact
 * round+headSha) > UNKNOWN_LEDGER_STATE (a new marker-shaped comment that
 * doesn't parse as either of the above) > NO_CHANGE.
 *
 * Residual TOCTOU: the gap between this re-read and the actual `gh pr
 * comment` post below is not closable client-side. It is not silently
 * unguarded, though — a concurrent poster's entry becomes a pre-existing
 * comment by the time of this wrapper's NEXT invocation, so that
 * invocation's own DUPLICATE branch (or HALTED, if the race was a halt)
 * catches it after the fact.
 */
function reclassifyLedgerBeforePosting({ owner, repo, prNumber, round, headSha, ownerLogin, snapshotIds, runners, repoRoot }) {
  const all = fetchAllPrComments({ owner, repo, prNumber, runners, repoRoot });
  if (!all.ok) return { bucket: 'UNKNOWN_LEDGER_STATE', reason: `LEDGER_REREAD_FAILED_${all.reason}` };

  const countCheck = fetchIssueCommentCount({ owner, repo, prNumber, runners, repoRoot });
  if (!countCheck.ok) return { bucket: 'UNKNOWN_LEDGER_STATE', reason: `LEDGER_COUNT_FETCH_FAILED_${countCheck.reason}` };
  if (all.comments.length !== countCheck.count) {
    return { bucket: 'UNKNOWN_LEDGER_STATE', reason: 'LEDGER_COUNT_MISMATCH' };
  }

  const freshLedger = parseLedger(all.comments, { ownerLogin });
  if (freshLedger.halted) {
    return { bucket: 'HALTED', reason: freshLedger.haltReason || 'PRIOR_HALT_UNCLEARED' };
  }

  const snapshot = snapshotIds instanceof Set ? snapshotIds : new Set(snapshotIds || []);
  const newComments = all.comments.filter((c) => !snapshot.has(c.id));

  let sawStale = false;
  let sawDup = false;
  let sawUnknown = false;
  for (const c of newComments) {
    const m = c.body.match(ROUND_MARKER_RE);
    if (m) {
      const entryRound = parseInt(m[1], 10);
      const entrySha = m[2];
      if (entryRound === round && entrySha === headSha) {
        sawDup = true;
      } else if (entryRound === round && entrySha !== headSha) {
        sawStale = true;
      } else {
        // A well-formed ledger marker for some other round appearing
        // mid-run is outside normal sequential play — default to the
        // ambiguous/failure branch rather than silently ignoring it.
        sawUnknown = true;
      }
      continue;
    }
    if (WRAPPER_MARKER_PREFIX_RE.test(c.body)) {
      sawUnknown = true;
    }
    // else: an ordinary comment (no wrapper marker prefix at all) — ignored.
  }

  if (sawStale) return { bucket: 'STALE_SHA', reason: 'NEW_ENTRY_DIFFERENT_SHA' };
  if (sawDup) return { bucket: 'DUPLICATE', reason: 'ROUND_ALREADY_RECORDED_ON_REREAD' };
  if (sawUnknown) return { bucket: 'UNKNOWN_LEDGER_STATE', reason: 'NEW_MARKER_UNRECOGNIZED' };
  return { bucket: 'NO_CHANGE', reason: null };
}

/**
 * The result of every `gh pr comment` call is checked; a failure is
 * surfaced, never swallowed.
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
    lines.push('Verify ONLY the round-1 response below. No new findings are accepted this round.');
    lines.push('', '## Round-1 response (verbatim)', priorVerdict.raw);
  }
  lines.push('', '# Required verdict template (output ONLY this fenced block; free-form explanation may precede it, but no BLOCKER/CRITICAL/SECURITY/VULNERAB wording and no request to widen scope)');
  lines.push('```codex-verdict', 'verdict: APPROVE|BLOCK', 'scope_request: none|widen|another_pass', 'findings: <integer count of BLOCKER findings>', '```');
  lines.push('', '# Diff', diff);
  return lines.join('\n');
}

/**
 * Dispatches to the elaborate post-run re-check (item a) only for the
 * STRUCTURED_APPROVE-pending path, per the spec's own branching (c):
 * STRUCTURED_BLOCK and NEEDS_OWNER go straight to posting via the simpler
 * idempotent re-read-then-post guard everything else uses.
 */
function postOutcome(args) {
  if (args.bucket === 'STRUCTURED_APPROVE') {
    return postApproveWithRecheck(args);
  }
  return postOutcomeSimple(args);
}

function postApproveWithRecheck({ pr, round, headSha, repoRoot, runners, ownerLogin, owner, repo, snapshotIds, verdictStdout }) {
  const rc = reclassifyLedgerBeforePosting({ owner, repo, prNumber: pr, round, headSha, ownerLogin, snapshotIds, runners, repoRoot });

  if (rc.bucket === 'DUPLICATE') {
    return { bucket: 'DUPLICATE', reason: rc.reason };
  }

  if (rc.bucket !== 'NO_CHANGE') {
    // HALTED / STALE_SHA / UNKNOWN_LEDGER_STATE: all halt-triggering.
    const haltBody = renderHaltComment({ prNumber: pr, round, headSha, condition: rc.bucket });
    const posted = postPrComment({ prNumber: pr, body: haltBody, repoRoot, runners });
    if (!posted.ok) {
      return { bucket: 'CODEX_ERROR', reason: `HALT_POST_FAILED_${posted.status}` };
    }
    return { bucket: rc.bucket, reason: rc.reason };
  }

  const ledgerBody = renderLedgerComment({ round, headSha, bucket: 'VALID_APPROVE', verdictText: verdictStdout });
  const posted = postPrComment({ prNumber: pr, body: ledgerBody, repoRoot, runners });
  if (!posted.ok) {
    return { bucket: 'CODEX_ERROR', reason: `LEDGER_POST_FAILED_${posted.status}` };
  }
  return { bucket: 'VALID_APPROVE', reason: null };
}

function postOutcomeSimple({ bucket, reason, pr, round, headSha, repoRoot, runners, ownerLogin, owner, repo, verdictStdout }) {
  const all = fetchAllPrComments({ owner, repo, prNumber: pr, runners, repoRoot });
  if (!all.ok) {
    return { bucket: 'UNKNOWN_LEDGER_STATE', reason: `LEDGER_REREAD_FAILED_${all.reason}` };
  }
  const freshLedger = parseLedger(all.comments, { ownerLogin });
  const dupNow = freshLedger.entries.some((e) => e.round === round && e.headSha === headSha);
  if (dupNow) {
    return { bucket: 'ROUND_EXCEEDED', reason: 'ROUND_ALREADY_RECORDED_ON_REREAD' };
  }

  if (isHaltTrigger(bucket, reason, round)) {
    const haltBody = renderHaltComment({ prNumber: pr, round, headSha, condition: bucket });
    const posted = postPrComment({ prNumber: pr, body: haltBody, repoRoot, runners });
    if (!posted.ok) {
      return { bucket: 'CODEX_ERROR', reason: `HALT_POST_FAILED_${posted.status}` };
    }
    return { bucket, reason };
  }

  if (bucket === 'VALID_BLOCK') {
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
 * final single-line JSON result.
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
  const finalizeWithPost = (bucket, reason, headSha, postArgs) => {
    if (dryRun) return finalize(bucket, reason, headSha);
    const posted = postOutcome(Object.assign({ bucket, reason, headSha }, postArgs));
    return finalize(posted.bucket, posted.reason, headSha);
  };

  const prView = ghJson(['pr', 'view', String(pr), '--json', 'body,headRefOid,isDraft,baseRefOid'], repoRoot, runners);
  const headSha = prView.headRefOid;
  const isDraft = !!prView.isDraft;

  const repoInfo = ghJson(['repo', 'view', '--json', 'owner,name'], repoRoot, runners);
  const ownerLogin = (repoInfo && repoInfo.owner && repoInfo.owner.login) || null;
  const repoName = (repoInfo && repoInfo.name) || null;

  const initialComments = fetchAllPrComments({ owner: ownerLogin, repo: repoName, prNumber: pr, runners, repoRoot });
  if (!initialComments.ok) {
    return finalize('CODEX_ERROR', `INITIAL_COMMENTS_FETCH_FAILED_${initialComments.reason}`, headSha);
  }
  const ledger = parseLedger(initialComments.comments, { ownerLogin });
  // Round-3 item a: the pre-run snapshot the post-run re-check diffs against.
  const snapshotIds = new Set(initialComments.comments.map((c) => c.id));

  const fenceResult = computeFence({ baseRefOid: prView.baseRefOid, headSha, repoRoot, runners });

  const postArgs = { pr, round, repoRoot, runners, ownerLogin, owner: ownerLogin, repo: repoName, snapshotIds };

  const pre = preconditionBucket({ fenceResult, isDraft, ledger, round, headSha });
  if (pre) {
    return finalizeWithPost(pre.bucket, pre.reason, headSha, postArgs);
  }

  const fence = fenceResult.fence;

  let priorVerdict = null;
  if (round === 2) {
    const priorEntry = ledger.entries.find((e) => e.round === 1);
    if (!priorEntry || !priorEntry.verdictText) {
      return finalizeWithPost('ROUND_EXCEEDED', 'MISSING_PRIOR_VERDICT', headSha, postArgs);
    }
    priorVerdict = { raw: priorEntry.verdictText };
  }

  const diffContentResult = computeDiffContent({ baseRefOid: prView.baseRefOid, headSha, repoRoot, runners });
  if (!diffContentResult.ok) {
    // Diff failure is a gate error before Codex is ever invoked — never
    // routed through postOutcome (nothing to post for a plumbing failure).
    return finalize('CODEX_ERROR', diffContentResult.reason, headSha);
  }
  if (!diffContentResult.diff.trim()) {
    return finalizeWithPost('EMPTY_FENCE', 'EMPTY_DIFF', headSha, postArgs);
  }

  const prompt = assemblePrompt({ pr: prView, fence, round, priorVerdict, diff: diffContentResult.diff });

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

  const result = classify({
    exitCode: run.status,
    stdout: run.stdout,
    fenceResult,
    headSha,
    round,
    ledger,
    isDraft,
  });

  const finalBucket = result.bucket === 'STRUCTURED_BLOCK' ? 'VALID_BLOCK' : result.bucket;
  return finalizeWithPost(finalBucket, result.reason, headSha, Object.assign({ verdictStdout: run.stdout }, postArgs));
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
  parseNameStatusZ,
  computeFence,
  computeDiffContent,
  stripQuotedAndFencedBlocks,
  findCodexVerdictBlocks,
  parseCodexVerdictBlock,
  classifyStructuredVerdict,
  classify,
  preconditionBucket,
  recognizeAnchoredMarker,
  renderLedgerComment,
  renderHaltComment,
  parseLedger,
  sha256,
  assemblePrompt,
  resolveCodexExe,
  isHaltTrigger,
  exitCodeFor,
  parseStrictRound,
  postPrComment,
  postOutcome,
  reclassifyLedgerBeforePosting,
  fetchAllPrComments,
  fetchIssueCommentCount,
  ghJson,
  defaultRunners,
  runReview,
};
