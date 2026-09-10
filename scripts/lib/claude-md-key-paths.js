'use strict';

const path = require('node:path');

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
// Total classification: env.HANDOFF_HOST, when SET AT ALL (any value,
// including ''), must be exactly 'claude' or 'codex' — anything else is a
// refusal (never coerced to a default), matching the same "unset is the only
// default branch" doctrine used by scripts/lib/host-target.js's --host flag.
// Only when HANDOFF_HOST is genuinely undefined does resolution fall back to
// inferring the host from HANDOFF_PROMOTION_FILE's basename.

function resolvePromotionHost(env) {
  env = env || process.env;
  const rawHost = env.HANDOFF_HOST;

  if (rawHost !== undefined) {
    if (rawHost === 'claude' || rawHost === 'codex') return { ok: true, host: rawHost };
    return { ok: false, reason: `HANDOFF_HOST must be exactly one of: claude, codex (got ${JSON.stringify(rawHost)})` };
  }

  const promotionFile = typeof env.HANDOFF_PROMOTION_FILE === 'string' && env.HANDOFF_PROMOTION_FILE !== ''
    ? env.HANDOFF_PROMOTION_FILE
    : 'CLAUDE.md';
  const base = path.basename(promotionFile);
  return { ok: true, host: base === 'AGENTS.md' ? 'codex' : 'claude' };
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
  looksLikeFindReplaceCopy,
};
