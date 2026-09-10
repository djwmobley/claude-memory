'use strict';

const path = require('node:path');
const fs   = require('node:fs');
const { execFileSync } = require('node:child_process');
const { resolvePromotionFilePath, defaultPromotionFilenameForHost } = require('./handoff-paths');

/**
 * claude-md-key-paths.js — portable "## Key paths" bullet rendering for the
 * generated project CLAUDE.md (templates/project-claude-md.tpl).
 *
 * Background: the template used to interpolate {{HANDOFF_MD_PATH}} and
 * {{PROJECT_ROOT}}/scripts/handoff.js — both filesystem-absolute paths baked
 * in at `init` time on the machine that ran init. That breaks the moment the
 * repo is cloned onto a second machine/user (different home dir), and it is
 * flatly wrong for the helper-script bullet in plugin mode (CLAUDE_PLUGIN_ROOT
 * set) since the target project is never the engine checkout.
 *
 * renderKeyPathsBullets(env) computes the two SYMBOLIC (never
 * filesystem-absolute) bullet values used by fresh template rendering
 * (cmdInit). The precedence mirrors resolveBaseDir() in
 * scripts/lib/handoff-paths.js exactly, but renders the literal env-var
 * token rather than the expanded value.
 *
 * Scope note: this module intentionally does NOT heal an already-generated
 * CLAUDE.md's Key paths section — that is out of scope for this change (see
 * cm#263 AUTHOR spec). It only governs what a fresh `handoff init` writes.
 */

function _envNonEmpty(env, key) {
  const v = env ? env[key] : undefined;
  return typeof v === 'string' && v.trim() !== '';
}

/**
 * Resolve the SAME precedence resolveBaseDir() (scripts/lib/handoff-paths.js)
 * uses, but rendered as a literal symbolic token — never the expanded value.
 * resolveBaseDir() only recognizes HANDOFF_BASE_DIR (falling back to
 * ~/.claude) — there is no CLAUDE_CONFIG_DIR branch in that function, so
 * this must not invent one.
 */
function resolveBaseSymbol(env) {
  if (_envNonEmpty(env, 'HANDOFF_BASE_DIR')) return '$HANDOFF_BASE_DIR';
  return '~/.claude';
}

/**
 * Resolve the helper-script bullet as a literal symbolic token. Never
 * `<repo-root>/scripts/handoff.js` — the target project is not the engine.
 */
function resolveHelperSymbol(env) {
  if (_envNonEmpty(env, 'CLAUDE_PLUGIN_ROOT')) return '$CLAUDE_PLUGIN_ROOT/scripts/handoff.js';
  return '<engine-root>/scripts/handoff.js';
}

/**
 * Compute the two portable "## Key paths" bullet values for the given env
 * (defaults to process.env). Neither value is ever filesystem-absolute —
 * both are literal symbolic tokens (`$HANDOFF_BASE_DIR`, `~/.claude`,
 * `$CLAUDE_PLUGIN_ROOT`, `<engine-root>`) plus the literal `<project-id>`
 * placeholder, never an interpolated real path.
 */
function renderKeyPathsBullets(env) {
  env = env || process.env;
  const base = resolveBaseSymbol(env);
  return {
    handoffPath: `${base}/projects/<project-id>/handoff.md`,
    helperPath:  resolveHelperSymbol(env),
  };
}

// ─── absolute-path / portable-form classification (test + call-site use) ───

function isAbsolutePath(p) {
  if (typeof p !== 'string' || p.length === 0) return false;
  if (/^[A-Za-z]:[\\/]/.test(p)) return true;   // Windows drive root
  if (/^\\\\/.test(p)) return true;              // UNC
  if (/^\/[a-z]\//.test(p)) return true;         // MSYS (/c/Users/...)
  if (/^\//.test(p)) return true;                // POSIX absolute (any root)
  if (p.includes('%USERPROFILE%')) return true;  // literal Windows env token
  return false;
}

function isPortableForm(p) {
  if (typeof p !== 'string') return false;
  return (
    p.startsWith('~/') ||
    p.startsWith('$HANDOFF_BASE_DIR') ||
    p.startsWith('$CLAUDE_PLUGIN_ROOT') ||
    p.startsWith('<engine-root>')
  );
}

// ─── promotion-file host resolution (B) ─────────────────────────────────────
//
// Total classification of the (HANDOFF_HOST, HANDOFF_PROMOTION_FILE) env pair
// — every combination maps to exactly one branch:
//
//   1. neither set                         -> host 'claude' (default)
//   2. HANDOFF_HOST only                   -> host = env value (validated
//                                              below; unrecognized -> refusal)
//   3. HANDOFF_PROMOTION_FILE only         -> host inferred from the env
//                                              value's basename, compared
//                                              CASE-INSENSITIVELY: 'agents.md'
//                                              (any case) -> 'codex'; anything
//                                              else, including 'claude.md' and
//                                              every basename this function
//                                              has never seen -> 'claude'
//                                              (the historical default; NOT
//                                              an allow-list of known-good
//                                              names).
//   4. both set                            -> host = HANDOFF_HOST (it always
//                                              wins); if the basename-derived
//                                              host disagrees, `warning`
//                                              carries a one-line message
//                                              naming both — the caller
//                                              prints it to stderr exactly
//                                              once and proceeds with
//                                              HANDOFF_HOST regardless.
//
// env.HANDOFF_HOST, when SET AT ALL (any value, including ''), must be
// exactly 'claude' or 'codex' — anything else is a refusal (never coerced to
// a default), matching the same "unset is the only default branch" doctrine
// used by scripts/lib/host-target.js's --host flag.
//
// Case-insensitivity note: only the basename-inference step (rows 3 and the
// mismatch check in row 4) is case-insensitive — this matches Windows/NTFS
// case-insensitive filesystem semantics for HANDOFF_PROMOTION_FILE. The
// on-disk-casing reuse in resolvePromotionFilePath (handoff-paths.js) is
// unaffected and unrelated: that logic reuses whatever casing already exists
// on disk, independent of host inference.

function _inferHostFromPromotionFileBasename(promotionFile) {
  const value = typeof promotionFile === 'string' && promotionFile !== '' ? promotionFile : 'CLAUDE.md';
  const base = path.basename(value).toLowerCase();
  return base === 'agents.md' ? 'codex' : 'claude';
}

function resolvePromotionHost(env) {
  env = env || process.env;
  const rawHost = env.HANDOFF_HOST;
  const rawFile = env.HANDOFF_PROMOTION_FILE;
  const fileIsSet = typeof rawFile === 'string' && rawFile !== '';

  if (rawHost !== undefined) {
    if (rawHost !== 'claude' && rawHost !== 'codex') {
      return { ok: false, reason: `HANDOFF_HOST must be exactly one of: claude, codex (got ${JSON.stringify(rawHost)})` };
    }
    let warning;
    if (fileIsSet) {
      const inferredHost = _inferHostFromPromotionFileBasename(rawFile);
      if (inferredHost !== rawHost) {
        warning = `handoff: HANDOFF_HOST=${rawHost} but HANDOFF_PROMOTION_FILE=${JSON.stringify(rawFile)} implies host '${inferredHost}' by basename — proceeding with HANDOFF_HOST=${rawHost}.`;
      }
    }
    return { ok: true, host: rawHost, warning };
  }

  return { ok: true, host: _inferHostFromPromotionFileBasename(rawFile) };
}

/**
 * resolvePromotionTarget — the ONE shared entry point every caller (cmdInit,
 * cmdClose, cmdPromote) must use to get a mutually-consistent (host,
 * filePath) pair, instead of independently calling resolvePromotionFilePath()
 * with no default (which always resolves to CLAUDE.md regardless of host)
 * and separately calling resolvePromotionHost() for template selection —
 * the split that let `HANDOFF_HOST=codex` with `HANDOFF_PROMOTION_FILE`
 * unset write AGENTS-flavored content into a file literally named CLAUDE.md.
 *
 * Host is always resolved FIRST (from the raw env pair — see
 * resolvePromotionHost above), then the filename default is derived from
 * that host via defaultPromotionFilenameForHost() and handed to
 * resolvePromotionFilePath() as its default — env.HANDOFF_PROMOTION_FILE, if
 * set, still wins over that default exactly as resolvePromotionFilePath()
 * already documents.
 *
 * @param {string} root
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{ok:true, host:'claude'|'codex', filePath:string, filename:string, warning?:string} | {ok:false, reason:string}}
 */
function resolvePromotionTarget(root, env) {
  env = env || process.env;
  const hostResult = resolvePromotionHost(env);
  if (!hostResult.ok) return hostResult;
  const filePath = resolvePromotionFilePath(root, defaultPromotionFilenameForHost(hostResult.host));
  return {
    ok: true,
    host: hostResult.host,
    filePath,
    filename: path.basename(filePath),
    warning: hostResult.warning,
  };
}

// ─── project display name resolution ────────────────────────────────────────
//
// Incident (PR #290): a `handoff promote --regenerate` run from a git
// worktree checkout (e.g. `.claude/worktrees/agent-a0979417bd522838e`) wrote
// `# agent-a0979417bd522838e` as the fresh CLAUDE.md's H1 — cmdInit's
// writeFreshPromotionFile() and cmdPromoteRegenerate() each independently
// fell back to `path.basename(root)` with no shared resolution logic, so the
// worktree's own disposable directory name leaked into the durable-facts
// file. resolveProjectDisplayName() is the ONE shared resolver both callers
// must use instead of restating `path.basename(root)` locally.
//
// TOTAL classification, first hit wins, every branch non-throwing:
//   N0 — an explicit name was given (cmdInit's positional arg; promote
//        --regenerate's --project-name flag), trimmed non-empty.
//   N1 — the FIRST H1 line (`# ...`, not `##`) of an already-existing
//        promotion file's content, after stripping inline markdown/HTML
//        markup and collapsing whitespace — rejected if empty, path-like, a
//        known placeholder, or itself worktree-shaped (an already-broken
//        prior render must not be carried forward into the next one).
//   N2 — root is a git worktree checkout: the main checkout's directory
//        name, resolved via `git rev-parse --git-common-dir` (never the
//        worktree's own disposable basename) and gated on that directory
//        actually looking like a project root.
//   N3 — `path.basename(root)`, or the literal `'project'` when that is
//        empty or a bare Windows drive letter (e.g. root === 'C:\\').
//
// Every branch returns a plain string or falls through — none of them
// throw. A caller-supplied bad explicitName (e.g. whitespace-only) is not an
// error, it just fails N0's non-empty check and falls through to N1.

const PLACEHOLDER_PROJECT_NAMES = new Set(['project', 'claude.md', 'agents.md', 'handoff']);

// Matches the disposable worktree-checkout directory names this engine (and
// Claude Code more generally) mints, e.g. `agent-a0979417bd522838e` — the
// exact shape that leaked into PR #290's CLAUDE.md. Applied to a candidate
// name from ANY branch (not just N2) so an already-broken prior render is
// never carried forward by N1.
const WORKTREE_SHAPED_NAME_RE = /^agent-[0-9a-f]{8,}$/i;

// N2 deliberately does NOT gate on install.js:146's path-shape regex
// (`/^(.*)\/\.claude\/worktrees\/[^/]+\/?$/i`, applied there only to that
// script's own repoRoot). Matching root against a `.claude/worktrees/`
// naming convention would only tell us root LOOKS like a worktree — it
// can't tell us where the main checkout actually lives, and would miss any
// worktree created under a different naming scheme. `git rev-parse
// --git-common-dir` (below) answers both questions authoritatively and
// non-throwing (caught on failure), so it is tried unconditionally
// (excepting the degenerate-root guard just below) rather than gated behind
// a naming heuristic.
//
/**
 * Strip inline markdown/HTML markup from a heading's text: HTML tags
 * (`<...>`) removed first (so `<b>*text*</b>` doesn't leave stray `*`
 * behind from a tag's own attributes), then the literal `*`, `_`, and
 * backtick characters, then trim and collapse internal whitespace runs to a
 * single space.
 *
 * @param {string} s
 * @returns {string}
 */
function _stripInlineMarkup(s) {
  return s
    .replace(/<[^>]*>/g, '')
    .replace(/[*_`]/g, '')
    .trim()
    .replace(/\s+/g, ' ');
}

/**
 * Return the text of the first level-1 heading line (`# ...`, not `##` or
 * deeper) in `text`, or null if none exists. Line-based, not regex-`/m`
 * multiline matching against the whole blob, so CRLF/LF/CR line endings are
 * all handled uniformly via a manual split.
 *
 * @param {string} text
 * @returns {string | null}
 */
function _firstH1Text(text) {
  if (typeof text !== 'string' || text === '') return null;
  for (const rawLine of text.split(/\r\n|\r|\n/)) {
    const trimmed = rawLine.trim();
    const m = trimmed.match(/^#(?!#)\s*(.*)$/);
    if (m) return m[1];
  }
  return null;
}

/**
 * A candidate name is rejected (regardless of which branch produced it) if
 * it is empty, contains a path separator, is a known placeholder
 * (case-insensitive), or is itself worktree-shaped. Shared by N1's
 * heading-extraction result.
 *
 * @param {string} candidate - already stripped/trimmed
 * @returns {boolean}
 */
function _isRejectedCandidateName(candidate) {
  if (candidate === '') return true;
  if (/[\\/]/.test(candidate)) return true;
  if (PLACEHOLDER_PROJECT_NAMES.has(candidate.toLowerCase())) return true;
  if (WORKTREE_SHAPED_NAME_RE.test(candidate)) return true;
  return false;
}

/**
 * N1: extract a usable project name from an already-existing promotion
 * file's content (its first H1), or null if none is usable.
 *
 * @param {string} [existingFileContent]
 * @returns {string | null}
 */
function _resolveFromExistingContent(existingFileContent) {
  const raw = _firstH1Text(existingFileContent);
  if (raw === null) return null;
  const cleaned = _stripInlineMarkup(raw);
  if (_isRejectedCandidateName(cleaned)) return null;
  return cleaned;
}

/**
 * N2: resolve the main checkout's directory name for a `root` that is a git
 * worktree checkout. Authoritative mechanism is `git rev-parse
 * --git-common-dir` (its resolved absolute path's PARENT is the main
 * checkout root for any worktree, regardless of naming convention or
 * nesting depth — unlike parsing WORKTREE_PATH_RE's match, which would only
 * tell us root LOOKS like a worktree, not where the main checkout actually
 * lives). `git` failing (not installed, not a repo, timeout, or a bogus
 * PATH) is caught and treated as "no worktree resolvable" — never thrown.
 *
 * The resolved candidate directory is accepted only if it actually looks
 * like a project root (carries `.memory-engine`, the legacy
 * `.claude-memory` marker, or `.git`) and has a non-empty basename —
 * otherwise this returns null and the caller falls through to N3.
 *
 * @param {string} root
 * @returns {string | null}
 */
function _resolveFromWorktree(root) {
  let candidate = null;
  try {
    const out = execFileSync('git', ['-C', root, 'rev-parse', '--git-common-dir'], {
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (out) {
      const gitCommonDirAbs = path.isAbsolute(out) ? out : path.resolve(root, out);
      const parent = path.dirname(gitCommonDirAbs);
      if (parent !== root) candidate = parent;
    }
  } catch (_) {
    candidate = null; // git absent, not a repo, timeout, bogus PATH — no worktree resolvable.
  }

  if (candidate === null) return null;

  const base = path.basename(candidate);
  if (base === '') return null;

  const hasProjectMarker = ['.memory-engine', '.claude-memory', '.git'].some((name) => {
    try {
      return fs.existsSync(path.join(candidate, name));
    } catch (_) {
      return false;
    }
  });
  if (!hasProjectMarker) return null;

  return base;
}

/**
 * N3: `path.basename(root)`, or the literal `'project'` fallback when that
 * is empty or a bare Windows drive letter (`root === 'C:\\'` basenames to
 * `''`; `root === 'C:'` basenames to `'C:'` itself — both covered).
 *
 * @param {string} root
 * @returns {string}
 */
function _resolveFromBasename(root) {
  const base = path.basename(root).trim();
  if (base === '' || /^[A-Za-z]:$/.test(base)) return 'project';
  return base;
}

/**
 * True when `root` is degenerate enough that N2's git-based worktree lookup
 * must not even be attempted. A bare Windows drive-letter reference (`C:`,
 * with no trailing separator) is drive-RELATIVE, not drive-rooted — passing
 * it to `git -C <root>` resolves relative to the current process's cwd on
 * that drive (a genuine Windows path-resolution quirk, not a git bug),
 * which could silently attribute an unrelated repository to a garbage
 * `root` value. Same emptiness/drive-letter-only shapes N3 already treats
 * as "no real basename" — skip straight to N3 rather than run git against
 * an ambiguous cwd.
 *
 * @param {string} root
 * @returns {boolean}
 */
function _isDegenerateRoot(root) {
  if (typeof root !== 'string') return true;
  const base = path.basename(root).trim();
  return base === '' || /^[A-Za-z]:$/.test(base);
}

/**
 * The ONE shared project-display-name resolver — cmdInit and
 * cmdPromoteRegenerate (scripts/handoff.js) both call this instead of
 * independently falling back to `path.basename(root)`. See the block
 * comment above for the full N0-N3 total classification.
 *
 * @param {object} opts
 * @param {string} opts.root                    - project root.
 * @param {string} [opts.explicitName]           - caller-supplied override
 *   (cmdInit's positional arg; promote --regenerate's --project-name flag).
 * @param {string} [opts.existingFileContent]    - the promotion file's
 *   current content, if it already exists on disk (used for N1's heading
 *   extraction). Omit/undefined when the target is fresh/absent.
 * @returns {{name: string, branch: 'N0'|'N1'|'N2'|'N3'}}
 */
function resolveProjectDisplayName(opts) {
  const { root, explicitName, existingFileContent } = opts || {};

  if (typeof explicitName === 'string' && explicitName.trim() !== '') {
    return { name: explicitName.trim(), branch: 'N0' };
  }

  const fromContent = _resolveFromExistingContent(existingFileContent);
  if (fromContent !== null) {
    return { name: fromContent, branch: 'N1' };
  }

  if (!_isDegenerateRoot(root)) {
    const fromWorktree = _resolveFromWorktree(root);
    if (fromWorktree !== null) {
      return { name: fromWorktree, branch: 'N2' };
    }
  }

  return { name: _resolveFromBasename(root), branch: 'N3' };
}

// ─── find-and-replace-copy detection (B) ────────────────────────────────────
//
// Detects the specific known-bad shape: a hand-made find-and-replace copy of
// a Claude CLAUDE.md that swapped strings but kept wrong paths (the real
// AGENTS.md this PR replaces said "~/.Codex/" — wrong casing, wrong host —
// and "# Codex-memory" as a heading). This is a diagnostic warning only,
// never a gate — regeneration requires the explicit --force-promotion flag.

function looksLikeFindReplaceCopy(text) {
  if (typeof text !== 'string') return false;
  return text.includes('~/.Codex/') || text.includes('# Codex-memory');
}

// ─── healKeyPathsSection — heal an already-generated CLAUDE.md (heal-on-touch) ────
//
// TOTAL classification of every possible "## Key paths" shape a caller's
// existing CLAUDE.md might carry. Every input lands in exactly one branch;
// unrecognized shapes are left untouched (friction via a stderr note, never
// a silent rewrite) — same allow-list-avoidance principle as the rest of
// this engine's validation gates.

const KEY_PATHS_MARKER_RE = /<!--\s*memory-engine:key-paths(?:\s+v\d+)?\s*-->/i;
const FENCE_LINE_RE       = /^\s*(`{3,}|~{3,})/;
const HEADING_LEVEL2_RE   = /^##\s/;

const HANDOFF_BULLET_LINE_RE = /^(\s*[-*]\s*Handoff file:\s*)`?(.+?)`?\s*$/i;
const HELPER_BULLET_LINE_RE  = /^(\s*[-*]\s*Helper script:\s*)`?(.+?)`?\s*$/i;

// Content requirement gating whether a shape-matched bullet counts as a
// recognized "engine bullet" — path must END with the expected filename AND
// contain a projects/<id>/ (or backslash) segment ahead of it (handoff bullet
// only). Backslash and forward slash both accepted (Windows vs POSIX/MSYS).
const HANDOFF_PATH_CONTENT_RE = /projects[\\/][^\\/]+[\\/]handoff\.md$/i;
const HELPER_PATH_CONTENT_RE  = /scripts[\\/]handoff\.js$/i;

// Substrings that reveal a leaked filesystem-absolute path inside prose (used
// only for the 'unrecognized' note — not a gate, just a diagnostic hint).
const ABSOLUTE_LEAK_RES = [
  /[A-Za-z]:[\\/][^\s`]*/,
  /\\\\[^\s`]+/,
  /\/home\/[^\s`]*/,
  /\/Users\/[^\s`]*/,
  /^\/[a-z]\/[^\s`]*/,
  /%USERPROFILE%[^\s`]*/,
];

/** Split text into {content, term} line records preserving exact terminators
 * (so a byte-for-byte reconstruction is always possible), and separately the
 * leading BOM (if any). */
function splitLines(body) {
  const lines = [];
  const re = /\r\n|\r|\n/g;
  let last = 0;
  let m;
  while ((m = re.exec(body))) {
    lines.push({ content: body.slice(last, m.index), term: m[0] });
    last = re.lastIndex;
  }
  lines.push({ content: body.slice(last), term: '' });
  return lines;
}

function joinLines(lines) {
  return lines.map((l) => l.content + l.term).join('');
}

function dominantEol(lines) {
  let crlf = 0, lf = 0;
  for (const l of lines) {
    if (l.term === '\r\n') crlf++;
    else if (l.term === '\n') lf++;
  }
  return crlf > lf ? '\r\n' : '\n';
}

function findLeak(text) {
  for (const re of ABSOLUTE_LEAK_RES) {
    const m = text.match(re);
    if (m) return m[0];
  }
  return null;
}

/**
 * Heal an already-generated CLAUDE.md's "## Key paths" section: if it is
 * engine-shaped (carries the provenance marker, or both the Handoff-file and
 * Helper-script bullets in the expected shape) and at least one bullet is
 * filesystem-absolute, rewrite ONLY the absolute bullet line(s) to the
 * portable symbolic form via renderKeyPathsBullets(env) and insert the
 * provenance marker under the heading if it is missing. Every other line —
 * including non-absolute bullets and any extra user content — is preserved
 * byte-for-byte, including original line endings and any leading BOM.
 *
 * Returns { text, outcome, notes }.
 *   outcome: 'absent' | 'ambiguous' | 'healed' | 'noop' | 'unrecognized'
 *   notes:   human-readable diagnostics for 'ambiguous' and 'unrecognized'
 *            (callers print these to stderr; never thrown).
 */
function healKeyPathsSection(text, env) {
  env = env || process.env;
  const notes = [];

  if (typeof text !== 'string' || text === '') {
    return { text, outcome: 'absent', notes };
  }

  let bom = '';
  let body = text;
  if (body.charCodeAt(0) === 0xFEFF) {
    bom = '﻿';
    body = body.slice(1);
  }

  const lines = splitLines(body);

  // Single pass: track fenced-code parity and collect every level-2 heading
  // whose trimmed text is "## key paths" (case-insensitive), outside a fence.
  let inFence = false;
  const outsideFence = new Array(lines.length);
  const headingIndices = [];
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i].content;
    const trimmed = raw.trim();
    outsideFence[i] = !inFence;
    if (FENCE_LINE_RE.test(raw)) inFence = !inFence;
    if (outsideFence[i] && trimmed.toLowerCase() === '## key paths') {
      headingIndices.push(i);
    }
  }

  if (headingIndices.length === 0) {
    return { text, outcome: 'absent', notes };
  }
  if (headingIndices.length >= 2) {
    notes.push(`Key paths: ${headingIndices.length} "## Key paths" headings found — ambiguous, left unchanged.`);
    return { text, outcome: 'ambiguous', notes };
  }

  const headingIndex = headingIndices[0];
  let sectionEnd = lines.length;
  for (let j = headingIndex + 1; j < lines.length; j++) {
    if (outsideFence[j] && HEADING_LEVEL2_RE.test(lines[j].content.trim())) {
      sectionEnd = j;
      break;
    }
  }

  let markerPresent = false;
  let markerCount = 0;
  let handoffMatch = null; // { index, prefix, path }
  let helperMatch  = null;
  for (let i = headingIndex; i < sectionEnd; i++) {
    const raw = lines[i].content;
    if (KEY_PATHS_MARKER_RE.test(raw)) { markerPresent = true; markerCount++; }
    if (!handoffMatch) {
      const m = raw.match(HANDOFF_BULLET_LINE_RE);
      if (m && HANDOFF_PATH_CONTENT_RE.test(m[2])) {
        handoffMatch = { index: i, prefix: m[1], path: m[2] };
      }
    }
    if (!helperMatch) {
      const m = raw.match(HELPER_BULLET_LINE_RE);
      if (m && HELPER_PATH_CONTENT_RE.test(m[2])) {
        helperMatch = { index: i, prefix: m[1], path: m[2] };
      }
    }
  }

  if (markerCount >= 2) {
    notes.push(`Key paths: ${markerCount} managed-by markers found in one section — malformed/duplicated, left unchanged.`);
    return { text, outcome: 'ambiguous', notes };
  }

  const bothBulletsFound = !!(handoffMatch && helperMatch);
  const engineShaped = markerPresent || bothBulletsFound;

  if (!engineShaped) {
    const sectionText = lines.slice(headingIndex, sectionEnd).map((l) => l.content).join('\n');
    const leak = findLeak(sectionText);
    notes.push(
      leak
        ? `Key paths: section present but not engine-shaped — left unchanged; possible absolute-path leak: "${leak}"`
        : `Key paths: section present but not engine-shaped — left unchanged.`
    );
    return { text, outcome: 'unrecognized', notes };
  }

  const absoluteBullets = [handoffMatch, helperMatch].filter((b) => b && isAbsolutePath(b.path));

  if (absoluteBullets.length === 0) {
    return { text, outcome: 'noop', notes };
  }

  // Heal: rewrite only the absolute bullet line(s); preserve every other
  // line byte-for-byte; insert the marker under the heading if missing.
  const bullets = renderKeyPathsBullets(env);
  const healedLines = lines.slice();
  if (handoffMatch && isAbsolutePath(handoffMatch.path)) {
    healedLines[handoffMatch.index] = {
      content: `${handoffMatch.prefix}\`${bullets.handoffPath}\``,
      term: lines[handoffMatch.index].term,
    };
  }
  if (helperMatch && isAbsolutePath(helperMatch.path)) {
    healedLines[helperMatch.index] = {
      content: `${helperMatch.prefix}\`${bullets.helperPath}\``,
      term: lines[helperMatch.index].term,
    };
  }

  let finalLines = healedLines;
  if (!markerPresent) {
    const eol = dominantEol(lines);
    const headingTerm = healedLines[headingIndex].term || eol;
    finalLines = healedLines.slice(0, headingIndex + 1)
      .concat([{ content: '<!-- memory-engine:key-paths v2 -->', term: headingTerm }])
      .concat(healedLines.slice(headingIndex + 1));
  }

  return { text: bom + joinLines(finalLines), outcome: 'healed', notes };
}

module.exports = {
  renderKeyPathsBullets,
  healKeyPathsSection,
  // exported for tests / callers that need to classify a rendered bullet
  isAbsolutePath,
  isPortableForm,
  // Promotion-file host resolution (B)
  resolvePromotionHost,
  resolvePromotionTarget,
  looksLikeFindReplaceCopy,
  // Project display name resolution — shared by cmdInit and
  // cmdPromoteRegenerate (scripts/handoff.js)
  resolveProjectDisplayName,
};
