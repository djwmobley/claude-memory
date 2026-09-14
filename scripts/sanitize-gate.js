#!/usr/bin/env node
'use strict';

/**
 * sanitize-gate.js — public-lift sanitize gate (docs/specs/public-sanitize-gate.md).
 *
 * Total-classification gate that stands between claude-memory (private) and
 * memory-manager (public): every discovered path maps to exactly one class
 * (LIFT/LEAVE/UNCLASSIFIED) per PUBLIC-MANIFEST.json, and every LIFT file's
 * bytes (plus commit messages, PR bodies, commit identity, ref names, and
 * path strings) are scanned for private-instance data. Failure/unknown is
 * always the default branch — see docs/specs/public-sanitize-gate.md.
 *
 * Usage:
 *   node scripts/sanitize-gate.js --manifest <path> --root <dir>
 *     [--commit <sha>] [--base <sha>] [--public-base <ref>] [--ref <name>]
 *     [--source-root <dir>] [--pr-body-file <path>] [--terms <path>] [--json]
 *
 * Ref/base resolution (docs/specs/public-sanitize-gate.md "Base derivation",
 * "Ref resolution"): an omitted/blank `--ref` resolves via `git symbolic-ref
 * --short HEAD` (fails closed under detached HEAD); an omitted/blank `--base`
 * is DERIVED as `git merge-base <ref> <public-base>` (public-base defaults to
 * `origin/main`, override via `--public-base`) — there is no tip-only scan
 * mode; a resolvable base is always required for a PASS.
 *
 * Exit codes: 0 PASS, 2 FAIL_UNCLASSIFIED_PATH|FAIL_HASH_DRIFT|FAIL_CONTENT|
 * FAIL_REF_UNRESOLVED|FAIL_BASE_UNRESOLVED, 3 FAIL_GATE_ERROR.
 *
 * The ONLY authoritative result is the exit code plus the single final JSON
 * line on stdout in --json mode: {"outcome":"...","findings":[...],
 * "exitCode":N}. No other stdout output should be parsed as a result.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

// ---------------------------------------------------------------------------
// Bypass tripwire (E2) — no flag anywhere skips this gate. If any of these
// env vars is set to a non-empty value, that is itself a gate error.
// ---------------------------------------------------------------------------
const BYPASS_ENV_NAMES = [
  'SANITIZE_SKIP',
  'SKIP_SANITIZE',
  'SANITIZE_BYPASS',
  'SANITIZE_DISABLE',
];

function detectBypassEnv(env) {
  return BYPASS_ENV_NAMES.filter((name) => {
    const v = env[name];
    return v !== undefined && v !== null && String(v).trim() !== '';
  });
}

// ---------------------------------------------------------------------------
// normalizePath — canonicalize a discovered path for matching/glob purposes.
// ---------------------------------------------------------------------------
function normalizePath(p) {
  if (typeof p !== 'string') return '';
  return p.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
}

// ---------------------------------------------------------------------------
// Minimal glob matcher — no new deps. "**" matches zero or more WHOLE path
// segments (never crossing into a partial-segment match), "*" matches any
// run of non-slash chars within a single segment. Segment-aware: a literal
// segment is only ever compared against a full path segment, never a
// substring spanning a "/".
// ---------------------------------------------------------------------------
function globToRegExp(glob) {
  const norm = normalizePath(glob);
  const rawSegs = norm.length ? norm.split('/') : [''];

  // Collapse consecutive "**" segments (e.g. "**/**") into one.
  const segs = [];
  for (const s of rawSegs) {
    if (s === '**' && segs[segs.length - 1] === '**') continue;
    segs.push(s);
  }

  function literalSegRe(seg) {
    let r = '';
    for (const c of seg) {
      if (c === '*') r += '[^/]*';
      else if ('.+?^${}()|[]\\'.includes(c)) r += '\\' + c;
      else r += c;
    }
    return r;
  }

  let re = '^';
  let prevWasGlobstar = false;
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i];
    const isFirst = i === 0;
    const isLast = i === segs.length - 1;
    if (seg === '**') {
      if (isFirst && isLast) {
        re += '.*';
      } else if (isFirst) {
        re += '(?:[^/]+/)*';
      } else if (isLast) {
        re += '(?:/[^/]+)*';
      } else {
        // Middle globstar: bake in the leading "/" (from the previous
        // literal segment) so it is never omitted, and match zero-or-more
        // whole trailing segments before the next literal.
        re += '/(?:[^/]+/)*';
      }
      prevWasGlobstar = true;
    } else {
      if (!isFirst && !prevWasGlobstar) re += '/';
      re += literalSegRe(seg);
      prevWasGlobstar = false;
    }
  }
  re += '$';
  return new RegExp(re);
}

function isGlobEntry(entryPath) {
  return typeof entryPath === 'string' && entryPath.includes('*');
}

// ---------------------------------------------------------------------------
// classifyPaths — total classification of every discovered path against the
// manifest. Pure function: no filesystem/git access.
//
// Returns:
//   {
//     classified: Map<path, { entry, matchedBy }>,
//     unclassified: [path...],        // no manifest entry matched (or the
//                                      // only match was an unapproved glob
//                                      // expansion — see below)
//     overlap: [{ path, entries }...] // more than one manifest entry matched
//     shapeErrors: [string...]        // malformed manifest entries
//   }
//
// Glob expansion (spec: "No path-prefix allow-listing"): every glob entry
// must carry a recorded `expansion: [paths...]` array (the approved
// resolved file list at approval time). The live expansion is recomputed
// against the discovered tree and diffed against the recorded one:
//   - a live-matching path NOT in the recorded expansion is treated as if
//     the glob did not match it at all (so it falls through to whatever
//     else matches it, or to UNCLASSIFIED — "new file matched an old glob"
//     never silently rides in on the glob's classification).
//   - a recorded-expansion path that no longer live-matches the glob is a
//     stale/wrong manifest record -> shapeErrors -> FAIL_GATE_ERROR.
// ---------------------------------------------------------------------------
function classifyPaths(treePaths, manifest) {
  const entries = (manifest && Array.isArray(manifest.entries)) ? manifest.entries : null;
  const shapeErrors = [];
  if (!entries) {
    shapeErrors.push('manifest.entries missing or not an array');
    return { classified: new Map(), unclassified: [], overlap: [], shapeErrors };
  }

  for (const e of entries) {
    if (!e || typeof e.path !== 'string' || !e.path) {
      shapeErrors.push(`entry missing path: ${JSON.stringify(e)}`);
      continue;
    }
    if (e.class !== 'LIFT' && e.class !== 'LEAVE') {
      shapeErrors.push(`entry ${e.path}: class must be LIFT or LEAVE, got ${e.class}`);
      continue;
    }
    if (e.class === 'LIFT') {
      if (!e.source_sha256) {
        shapeErrors.push(`LIFT entry ${e.path}: missing source_sha256`);
      }
      const hasTransform = e.transform !== null && e.transform !== undefined;
      if (hasTransform && !e.target_sha256) {
        shapeErrors.push(`LIFT entry ${e.path}: has transform but missing target_sha256`);
      }
      if (!hasTransform && e.target_sha256) {
        shapeErrors.push(`LIFT entry ${e.path}: has target_sha256 but no transform`);
      }
    }
    if (e.class === 'LEAVE' && !e.reason) {
      shapeErrors.push(`LEAVE entry ${e.path}: missing reason`);
    }
    if (isGlobEntry(e.path) && !Array.isArray(e.expansion)) {
      shapeErrors.push(`glob entry ${e.path}: missing expansion array (recorded approved expansion required)`);
    }
  }

  const literalEntries = entries.filter((e) => e && typeof e.path === 'string' && !isGlobEntry(e.path));

  // Duplicate literal-path detection MUST happen before the literalMap is
  // built — a Map silently keeps only the last entry for a repeated key,
  // which would let (e.g.) a LIFT entry followed by a LEAVE entry for the
  // same path collapse to LEAVE and PASS instead of failing. Any class
  // combination for a duplicated normalized path is a manifest error.
  const literalCounts = new Map();
  for (const e of literalEntries) {
    const key = normalizePath(e.path);
    literalCounts.set(key, (literalCounts.get(key) || 0) + 1);
  }
  for (const [key, count] of literalCounts) {
    if (count > 1) {
      shapeErrors.push(`duplicate literal manifest entries for path ${key} (${count} entries)`);
    }
  }

  const globEntries = entries.filter((e) => e && typeof e.path === 'string' && isGlobEntry(e.path))
    .map((e) => ({ entry: e, re: globToRegExp(e.path) }));
  const literalMap = new Map(literalEntries.map((e) => [normalizePath(e.path), e]));

  const normTreePaths = treePaths.map((p) => normalizePath(p));

  // Recompute + diff each glob entry's expansion against the discovered tree.
  for (const g of globEntries) {
    if (!Array.isArray(g.entry.expansion)) continue; // already flagged above
    const recordedSet = new Set(g.entry.expansion.map(normalizePath));
    const liveSet = new Set(normTreePaths.filter((p) => g.re.test(p)));
    g.liveSet = liveSet;
    g.unapproved = new Set();
    for (const p of liveSet) {
      if (!recordedSet.has(p)) g.unapproved.add(p);
    }
    for (const p of recordedSet) {
      if (!liveSet.has(p)) {
        shapeErrors.push(`glob entry ${g.entry.path}: recorded expansion path ${p} no longer matches (stale expansion)`);
      }
    }
  }

  const classified = new Map();
  const unclassified = [];
  const overlap = [];

  for (const rawPath of treePaths) {
    const p = normalizePath(rawPath);
    const matches = [];
    if (literalMap.has(p)) matches.push(literalMap.get(p));
    for (const g of globEntries) {
      if (!g.re.test(p)) continue;
      if (g.unapproved && g.unapproved.has(p)) continue; // unapproved expansion: not a real match
      matches.push(g.entry);
    }
    if (matches.length === 0) {
      unclassified.push(p);
    } else if (matches.length > 1) {
      overlap.push({ path: p, entries: matches });
    } else {
      classified.set(p, { entry: matches[0] });
    }
  }

  return { classified, unclassified, overlap, shapeErrors };
}

// ---------------------------------------------------------------------------
// decodeMaybeUtf16 — detect and decode UTF-16LE/BE via BOM or a null-byte
// interleave heuristic. Returns decoded string, or null if not detected.
// ---------------------------------------------------------------------------
function decodeMaybeUtf16(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 2) return null;
  if (buf[0] === 0xff && buf[1] === 0xfe) {
    return buf.slice(2).toString('utf16le');
  }
  if (buf[0] === 0xfe && buf[1] === 0xff) {
    // UTF-16BE: swap bytes then decode as LE (Node has no native BE decoder)
    const swapped = Buffer.alloc(buf.length - 2);
    for (let i = 2; i + 1 < buf.length; i += 2) {
      swapped[i - 2] = buf[i + 1];
      swapped[i - 1] = buf[i];
    }
    return swapped.toString('utf16le');
  }
  // Null-interleave heuristic over the first 512 bytes: ASCII-range UTF-16LE
  // text has a null byte at every odd offset (or every even offset for BE).
  const sample = buf.slice(0, Math.min(512, buf.length));
  if (sample.length < 8) return null;
  let evenNulls = 0, oddNulls = 0;
  for (let i = 0; i < sample.length; i++) {
    if (sample[i] === 0) {
      if (i % 2 === 0) evenNulls++; else oddNulls++;
    }
  }
  const half = sample.length / 2;
  if (oddNulls >= half * 0.4 && evenNulls < half * 0.1) {
    return buf.toString('utf16le');
  }
  if (evenNulls >= half * 0.4 && oddNulls < half * 0.1) {
    const swapped = Buffer.alloc(buf.length - (buf.length % 2));
    for (let i = 0; i + 1 < swapped.length; i += 2) {
      swapped[i] = buf[i + 1];
      swapped[i + 1] = buf[i];
    }
    return swapped.toString('utf16le');
  }
  return null;
}

// ---------------------------------------------------------------------------
// Scanner pattern table (spec: "Scanners"). Each scanner is
// { label, patterns: RegExp[] } run against a text string.
// ---------------------------------------------------------------------------
const OWNER_EMAIL_PATTERNS = [
  /[A-Za-z0-9_.+-]+@users\.noreply\.github\.com/i,
  /djwmobley@gmail\.com/i,
];

const OWNER_PATH_PATTERNS = [
  /C:\\Users\\[A-Za-z0-9_.\-]+/i,
  /C:\/Users\/[A-Za-z0-9_.\-]+/i,
  /\/home\/[A-Za-z0-9_.\-]+/,
  /\/Users\/[A-Za-z0-9_.\-]+/,
  /%USERPROFILE%/i,
  /~\/[A-Za-z0-9_.\-]{2,}/,
];

const PRIVATE_DB_PATTERNS = [
  /\bclaude_policy_framework\b/i,
  /\bpipeline_[a-z0-9_]+\b/i,
  /\bclaude_context\b/i,
  /\bmemory_manager_staging\b/i,
];

const MARKER_UUID_PATTERNS = [
  /\b[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/i,
];

const SECRET_KEY_PATTERNS = [
  /AKIA[0-9A-Z]{16}/,
  /\bghp_[A-Za-z0-9]{36,}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/,
  /\bsk-ant-[A-Za-z0-9-]{20,}\b/,
  /\bsk-[A-Za-z0-9]{20,}\b/,
  /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
];

const CONN_STRING_PATTERNS = [
  /[a-z][a-z0-9+.\-]*:\/\/[^\s/:@]+:[^\s/:@]+@[^\s/]+/i,
];

function buildTermRegex(term) {
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp('\\b' + escaped + '\\b', 'i');
}

function loadPrivateTerms(termsPath) {
  if (!termsPath) {
    throw new GateError('sanitize-private-terms.txt: no --terms path / SANITIZE_PRIVATE_TERMS_FILE given');
  }
  let raw;
  try {
    raw = fs.readFileSync(termsPath, 'utf8');
  } catch (e) {
    throw new GateError(`sanitize-private-terms.txt unreadable at ${termsPath}: ${e.message}`);
  }
  const terms = raw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith('#'));
  if (terms.length === 0) {
    throw new GateError('sanitize-private-terms.txt is missing usable terms (empty or whitespace/comment-only)');
  }
  return terms;
}

class GateError extends Error {}

// ---------------------------------------------------------------------------
// percentDecodeOnce / percentDecodeFixpoint (spec "Decoded scanning" (a)) —
// decode every valid %XX (case-insensitive hex) and %uXXXX escape found
// ANYWHERE in the string in a single pass; a malformed sequence (bad hex, a
// bare trailing "%") simply does not match the regex and is left literal.
// This is regex-driven, not decodeURIComponent-driven, so it can never
// throw and never needs whitespace-delimited candidate extraction to avoid
// one malformed run poisoning another — the whole string is decoded in
// place, every round.
// ---------------------------------------------------------------------------
const PERCENT_ESCAPE_RE = /%(?:[0-9A-Fa-f]{2}|[uU][0-9A-Fa-f]{4})/g;

function percentDecodeOnce(str) {
  return str.replace(PERCENT_ESCAPE_RE, (m) => {
    const isUnicode = m[1] === 'u' || m[1] === 'U';
    const hex = isUnicode ? m.slice(2) : m.slice(1);
    const code = parseInt(hex, 16);
    return String.fromCharCode(code);
  });
}

// Iterates percentDecodeOnce to a fixpoint, capped at maxRounds (default 5)
// even if a fixpoint has not been reached. Returns one { text, variant:
// 'percent', depth } entry per round that actually changed the text (a
// double-encoded owner path resolves fully only at depth 2, etc).
function percentDecodeFixpoint(str, maxRounds) {
  const cap = typeof maxRounds === 'number' ? maxRounds : 5;
  const out = [];
  let current = str;
  for (let depth = 1; depth <= cap; depth++) {
    let next;
    try {
      next = percentDecodeOnce(current);
    } catch (_e) {
      break; // never throws in practice (regex-driven), but stay fail-safe
    }
    if (next === current) break;
    out.push({ text: next, variant: 'percent', depth });
    current = next;
  }
  return out;
}

// ---------------------------------------------------------------------------
// scanText — run every non-recursive scanner over a text string AND over its
// decoded variants (spec "Decoded scanning" (a)): the raw text, every
// percent-decode fixpoint round (capped at 5), and an unconditional
// plus-as-space variant (no query-string detection — "+" is always treated
// as a possible encoded space). Findings from every variant are unioned;
// each finding records which variant/depth produced it. No whitespace
// tokenization gates any of this — every variant is generated from the
// WHOLE string, never a substring extracted by splitting on whitespace.
//
// ctx: { location, termRegexes: RegExp[], _skipBase64 (internal) }
// Returns findings: [{ label, location, snippet, variant, depth }]
// ---------------------------------------------------------------------------
function runPatternSet(label, patterns, text, location, variant, depth, findings) {
  for (const re of patterns) {
    const m = text.match(re);
    if (m) {
      findings.push({ label, location, snippet: m[0].slice(0, 80), variant, depth });
      break;
    }
  }
}

function scanCoreVariant(text, location, termRegexes, variant, depth, findings) {
  runPatternSet('OWNER_PATH', OWNER_PATH_PATTERNS, text, location, variant, depth, findings);
  runPatternSet('OWNER_EMAIL', OWNER_EMAIL_PATTERNS, text, location, variant, depth, findings);
  runPatternSet('PRIVATE_DB', PRIVATE_DB_PATTERNS, text, location, variant, depth, findings);
  for (const re of termRegexes) {
    const m = text.match(re);
    if (m) {
      findings.push({ label: 'PRIVATE_TERM', location, snippet: m[0].slice(0, 80), variant, depth });
      break;
    }
  }
  runPatternSet('MARKER_UUID', MARKER_UUID_PATTERNS, text, location, variant, depth, findings);
  runPatternSet('SECRET_KEY', SECRET_KEY_PATTERNS, text, location, variant, depth, findings);
  runPatternSet('CONN_STRING', CONN_STRING_PATTERNS, text, location, variant, depth, findings);
}

function scanText(str, ctx) {
  const findings = [];
  const location = (ctx && ctx.location) || 'unknown';
  const termRegexes = (ctx && ctx.termRegexes) || [];

  // Variant set: raw + percent-decode fixpoint rounds + plus-as-space.
  const variants = [{ text: str, variant: 'raw', depth: 0 }];
  variants.push(...percentDecodeFixpoint(str, 5));
  const plusText = str.replace(/\+/g, ' ');
  if (plusText !== str) variants.push({ text: plusText, variant: 'plus', depth: 0 });

  for (const v of variants) {
    scanCoreVariant(v.text, location, termRegexes, v.variant, v.depth, findings);
  }

  // BASE64_DECODE: find base64-looking runs >=64 chars, decode, re-scan
  // (excluding this same base64 step, to avoid unbounded recursion). Also
  // re-run the UTF-16 decode heuristic against the decoded bytes so a
  // base64-wrapped UTF-16LE/BE blob (e.g. with a BOM) is not limited to a
  // direct-UTF-8 interpretation, matching scanBytes' additive behavior.
  if (!ctx || !ctx._skipBase64) {
    const b64re = /[A-Za-z0-9+/]{64,}={0,2}/g;
    let m;
    while ((m = b64re.exec(str))) {
      try {
        const decodedBuf = Buffer.from(m[0], 'base64');
        const decodedStr = decodedBuf.toString('utf8');
        const inner = scanText(decodedStr, { location, termRegexes, _skipBase64: true });
        let inner16 = [];
        const utf16Decoded = decodeMaybeUtf16(decodedBuf);
        if (utf16Decoded !== null) {
          inner16 = scanText(utf16Decoded, { location, termRegexes, _skipBase64: true });
        }
        if (inner.length > 0 || inner16.length > 0) {
          findings.push({ label: 'BASE64_DECODE', location, snippet: m[0].slice(0, 40), variant: 'base64', depth: 0 });
        }
      } catch (_e) {
        // not valid base64/utf8; ignore
      }
    }
  }

  return findings;
}

// ---------------------------------------------------------------------------
// scanBytes — decode-aware wrapper around scanText for raw file bytes.
// Scans the raw bytes as latin1/utf8 text, AND (additively) a UTF-16
// decoding if detected.
// ---------------------------------------------------------------------------
function scanBytes(buf, ctx) {
  const findings = [];
  const asUtf8 = buf.toString('utf8');
  findings.push(...scanText(asUtf8, ctx));

  const utf16Decoded = decodeMaybeUtf16(buf);
  if (utf16Decoded !== null) {
    findings.push(...scanText(utf16Decoded, ctx));
  }
  return findings;
}

// ---------------------------------------------------------------------------
// deriveResultOutcome — total classification of the gate's final result from
// accumulated result buckets. First matching branch wins; unknown internal
// state defaults to FAIL_GATE_ERROR (never silently PASS). `results` itself
// (or any of its expected buckets) being malformed — null, not an object, or
// a bucket present but not an array — is itself unknown state, not a clean
// empty run, and must not resolve to PASS.
//
// (Named distinctly from `classifyOutcome` below, which is a different,
// narrower function per docs/specs/public-sanitize-gate.md "classifyOutcome
// total classification" — it validates the gate's FINAL {outcome, findings,
// exitCode} JSON-line payload against tampering/malformed shape, not the
// internal accumulator buckets this function reads.)
// ---------------------------------------------------------------------------
function deriveResultOutcome(results) {
  if (results === null || typeof results !== 'object' || Array.isArray(results)) {
    return { outcome: 'FAIL_GATE_ERROR', exitCode: 3 };
  }
  const bucketNames = [
    'gateErrors', 'unclassified', 'overlap', 'shapeErrors', 'hashDrift', 'findings',
    'refUnresolved', 'baseUnresolved',
  ];
  for (const name of bucketNames) {
    const v = results[name];
    if (v !== undefined && !Array.isArray(v)) {
      return { outcome: 'FAIL_GATE_ERROR', exitCode: 3 };
    }
  }

  const r = results;
  const gateErrors = r.gateErrors || [];
  const unclassified = r.unclassified || [];
  const overlap = r.overlap || [];
  const shapeErrors = r.shapeErrors || [];
  const hashDrift = r.hashDrift || [];
  const findings = r.findings || [];
  const refUnresolved = r.refUnresolved || [];
  const baseUnresolved = r.baseUnresolved || [];

  // Priority (total and fixed, never configurable per invocation):
  // FAIL_GATE_ERROR > FAIL_REF_UNRESOLVED > FAIL_BASE_UNRESOLVED >
  // FAIL_UNCLASSIFIED_PATH > FAIL_HASH_DRIFT > FAIL_CONTENT > PASS.
  if (gateErrors.length > 0 || shapeErrors.length > 0 || overlap.length > 0) {
    return { outcome: 'FAIL_GATE_ERROR', exitCode: 3 };
  }
  if (refUnresolved.length > 0) {
    return { outcome: 'FAIL_REF_UNRESOLVED', exitCode: 2 };
  }
  if (baseUnresolved.length > 0) {
    return { outcome: 'FAIL_BASE_UNRESOLVED', exitCode: 2 };
  }
  if (unclassified.length > 0) {
    return { outcome: 'FAIL_UNCLASSIFIED_PATH', exitCode: 2 };
  }
  if (hashDrift.length > 0) {
    return { outcome: 'FAIL_HASH_DRIFT', exitCode: 2 };
  }
  if (findings.length > 0) {
    return { outcome: 'FAIL_CONTENT', exitCode: 2 };
  }
  return { outcome: 'PASS', exitCode: 0 };
}

// ---------------------------------------------------------------------------
// classifyOutcome — docs/specs/public-sanitize-gate.md "classifyOutcome
// total classification" (round 3). A defensive, paranoia-hardened validator
// for an ALREADY-COMPUTED summary payload shaped like the gate's own final
// JSON line: { outcome: 'PASS'|'BLOCK'|'ERROR', findings: [...],
// exitCode?: N }. This is the total classification of "is this payload safe
// to trust", not a re-derivation of the gate's specific reason code — see
// `deriveResultOutcome` above for that. Total classification: every input,
// including a hostile/malformed one, maps to exactly one of PASS / BLOCK /
// ERROR; anything not exactly matching the PASS/BLOCK/ERROR shape rules
// below falls to the default BLOCK branch with reason MALFORMED_OUTCOME —
// never PASS on unknown/exceptional state.
//
// Defends against: a non-plain-object input (Array, Date, class instance);
// extra keys beyond the documented {outcome, findings, exitCode} shape; an
// `outcome`/`findings` property implemented as an accessor (getter/setter)
// rather than a plain data property — even a non-throwing getter is
// rejected outright, since its value cannot be trusted as a stable literal
// and a throwing getter must never be invoked to find that out; a Proxy
// trap throwing on ANY of the reflection calls below (prototype lookup,
// own-key enumeration, property-descriptor lookup); a homoglyph or
// whitespace-padded string that merely LOOKS like "PASS"/"BLOCK"/"ERROR"
// (strict `===` never matches those, so they fall through to
// MALFORMED_OUTCOME on their own, no special-casing needed).
// ---------------------------------------------------------------------------
const CLASSIFY_OUTCOME_ALLOWED_KEYS = new Set(['outcome', 'findings', 'exitCode']);

function classifyOutcomeMalformed() {
  return { outcome: 'BLOCK', reason: 'MALFORMED_OUTCOME' };
}

function classifyOutcome(input) {
  try {
    if (input === null || typeof input !== 'object') {
      return classifyOutcomeMalformed();
    }
    const proto = Object.getPrototypeOf(input);
    if (proto !== Object.prototype && proto !== null) {
      return classifyOutcomeMalformed();
    }
    if (Array.isArray(input)) {
      return classifyOutcomeMalformed();
    }

    const ownKeys = Object.getOwnPropertyNames(input);
    for (const k of ownKeys) {
      if (!CLASSIFY_OUTCOME_ALLOWED_KEYS.has(k)) {
        return classifyOutcomeMalformed();
      }
    }

    // Read `outcome` and `findings` ONCE into locals, via their property
    // descriptors so a getter is detected (and rejected) WITHOUT ever being
    // invoked — this is what makes a throwing getter harmless here: we never
    // call it.
    const outcomeDesc = Object.getOwnPropertyDescriptor(input, 'outcome');
    if (!outcomeDesc || typeof outcomeDesc.get === 'function' || typeof outcomeDesc.set === 'function') {
      return classifyOutcomeMalformed();
    }
    const outcomeVal = outcomeDesc.value;

    const findingsDesc = Object.getOwnPropertyDescriptor(input, 'findings');
    if (findingsDesc && (typeof findingsDesc.get === 'function' || typeof findingsDesc.set === 'function')) {
      return classifyOutcomeMalformed();
    }
    const findingsVal = findingsDesc ? findingsDesc.value : undefined;

    const exitCodeDesc = Object.getOwnPropertyDescriptor(input, 'exitCode');
    if (exitCodeDesc && (typeof exitCodeDesc.get === 'function' || typeof exitCodeDesc.set === 'function')) {
      return classifyOutcomeMalformed();
    }

    if (outcomeVal === 'PASS') {
      if (Array.isArray(findingsVal) && findingsVal.length === 0) {
        return { outcome: 'PASS' };
      }
      return classifyOutcomeMalformed();
    }
    if (outcomeVal === 'BLOCK') {
      if (Array.isArray(findingsVal) && findingsVal.length > 0) {
        return { outcome: 'BLOCK' };
      }
      return classifyOutcomeMalformed();
    }
    if (outcomeVal === 'ERROR') {
      return { outcome: 'ERROR' };
    }
    return classifyOutcomeMalformed();
  } catch (_e) {
    // Any exception anywhere above (a Proxy trap throwing on prototype
    // lookup, own-key enumeration, or descriptor lookup) -> malformed, never
    // PASS/BLOCK(real)/ERROR on an exceptional path.
    return classifyOutcomeMalformed();
  }
}

// Maps a `deriveResultOutcome` specific reason code onto the coarse
// PASS/BLOCK/ERROR vocabulary `classifyOutcome` validates. FAIL_GATE_ERROR
// (a gate execution/setup failure) is ERROR; PASS is PASS; every other
// FAIL_* reason (a real classification/content finding) is BLOCK.
function coarseOutcomeName(specificOutcome) {
  if (specificOutcome === 'PASS') return 'PASS';
  if (specificOutcome === 'FAIL_GATE_ERROR') return 'ERROR';
  return 'BLOCK';
}

// ---------------------------------------------------------------------------
// git helpers (CLI-only; not used by pure functions above)
// ---------------------------------------------------------------------------
function gitLsTree(root, commit) {
  const out = execFileSync('git', ['ls-tree', '-r', '--name-only', commit], { cwd: root, encoding: 'utf8' });
  return out.split(/\r?\n/).filter((l) => l.length > 0);
}

// Read a path's bytes AS COMMITTED at `commit` (git blob), never the
// working tree. Reading the working tree would let an uncommitted, unclean
// replacement conceal private bytes in the commit actually being approved
// (and CI checks out the PR head / merge tree, not necessarily what a local
// working tree happens to contain).
function gitShowBlob(root, commit, relPath) {
  return execFileSync('git', ['show', `${commit}:${relPath}`], { cwd: root, maxBuffer: 1024 * 1024 * 256 });
}

function gitCommitIdentity(root, commit) {
  const out = execFileSync(
    'git',
    ['log', '-1', '--format=%an%x00%ae%x00%cn%x00%ce', commit],
    { cwd: root, encoding: 'utf8' }
  ).trim();
  const [an, ae, cn, ce] = out.split('\x00');
  return { authorName: an, authorEmail: ae, committerName: cn, committerEmail: ce };
}

function gitCommitMessage(root, commit) {
  return execFileSync('git', ['log', '-1', '--format=%B', commit], { cwd: root, encoding: 'utf8' });
}

function gitRevList(root, base, commit) {
  const out = execFileSync('git', ['rev-list', `${base}..${commit}`], { cwd: root, encoding: 'utf8' });
  return out.split(/\r?\n/).filter((l) => l.length > 0);
}

// ---------------------------------------------------------------------------
// Ref resolution (spec "Ref resolution" (d)) — total classification: every
// input maps to a resolved ref string or a REF_UNRESOLVED error, never a
// silent empty/`HEAD` fallback. `--ref` explicit-but-blank/whitespace-only
// is treated as omitted, matching `--base`'s same rule.
// ---------------------------------------------------------------------------
const RESERVED_REF_NAMES = new Set(['HEAD', 'FETCH_HEAD', 'ORIG_HEAD']);

function gitCheckRefFormatBranch(name) {
  try {
    execFileSync('git', ['check-ref-format', '--branch', name], { encoding: 'utf8' });
    return true;
  } catch (_e) {
    return false;
  }
}

function gitVerifyCommit(root, ref) {
  try {
    execFileSync('git', ['rev-parse', '--verify', `${ref}^{commit}`], { cwd: root, encoding: 'utf8' });
    return true;
  } catch (_e) {
    return false;
  }
}

function resolveRef(args, root) {
  const explicit = typeof args.ref === 'string' ? args.ref.trim() : '';
  let ref = explicit;
  if (!ref) {
    // Omitted/blank --ref: the caller (CI/hook) always knows the real
    // incoming ref, so this fallback exists only for a plain local
    // invocation. `git symbolic-ref --short HEAD` fails closed under a
    // detached HEAD (exactly the state a CI checkout of a PR/push commit is
    // normally in) instead of silently returning the literal string "HEAD".
    try {
      ref = execFileSync('git', ['symbolic-ref', '--short', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
    } catch (_e) {
      return { ref: null, error: 'REF_UNRESOLVED: HEAD is detached and no --ref was supplied' };
    }
    if (!ref) {
      return { ref: null, error: 'REF_UNRESOLVED: git symbolic-ref returned an empty ref name' };
    }
  }
  if (RESERVED_REF_NAMES.has(ref)) {
    return { ref: null, error: `REF_UNRESOLVED: "${ref}" is a reserved ref name, unsupported by design` };
  }
  if (!gitCheckRefFormatBranch(ref)) {
    return { ref: null, error: `REF_UNRESOLVED: "${ref}" fails "git check-ref-format --branch"` };
  }
  if (!gitVerifyCommit(root, ref)) {
    return { ref: null, error: `REF_UNRESOLVED: "${ref}" does not resolve to a commit` };
  }
  return { ref, error: null };
}

// ---------------------------------------------------------------------------
// Base derivation (spec "Base derivation" (c)). Ref validation (d) has
// already run by the time this is called — `resolveRef`'s result is the
// `ref` argument here. An explicit, non-blank `--base` is used as-is (no
// merge-base derivation, independent of whether ref resolution succeeded).
// An omitted/blank `--base` is DERIVED as `git merge-base <ref>
// <public-base>` (public-base defaults to origin/main); merge-base ERRORING
// (missing public-base ref, no common ancestor, invalid ref) is
// BASE_UNRESOLVED. merge-base succeeding with an output equal to `ref`
// itself is the normal fast-forward case, NOT an error — the derived base is
// simply that value, and an empty `base..commit` range is handled by the
// caller the same way an explicit equal base already is.
// ---------------------------------------------------------------------------
function resolveBase(args, root, ref) {
  const raw = typeof args.base === 'string' ? args.base.trim() : '';
  if (raw) {
    return { base: raw, error: null };
  }
  if (!ref) {
    return { base: null, error: 'BASE_UNRESOLVED: no resolved ref to derive a base from (and no explicit --base)' };
  }
  const publicBase = (typeof args.publicBase === 'string' && args.publicBase.trim()) || 'origin/main';
  let out;
  try {
    out = execFileSync('git', ['merge-base', ref, publicBase], { cwd: root, encoding: 'utf8' }).trim();
  } catch (e) {
    return { base: null, error: `BASE_UNRESOLVED: git merge-base ${ref} ${publicBase} failed: ${e.message}` };
  }
  if (!out) {
    return { base: null, error: `BASE_UNRESOLVED: git merge-base ${ref} ${publicBase} produced no output` };
  }
  return { base: out, error: null };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const args = { json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--manifest') args.manifest = argv[++i];
    else if (a === '--root') args.root = argv[++i];
    else if (a === '--source-root') args.sourceRoot = argv[++i];
    else if (a === '--commit') args.commit = argv[++i];
    else if (a === '--base') args.base = argv[++i];
    else if (a === '--public-base') args.publicBase = argv[++i];
    else if (a === '--ref') args.ref = argv[++i];
    else if (a === '--terms') args.terms = argv[++i];
    else if (a === '--pr-body-file') args.prBodyFile = argv[++i];
    else if (a === '--json') args.json = true;
  }
  return args;
}

function runGate(argv, env) {
  env = env || process.env;
  const results = {
    gateErrors: [], shapeErrors: [], unclassified: [], overlap: [], hashDrift: [], findings: [],
    refUnresolved: [], baseUnresolved: [],
  };

  const bypass = detectBypassEnv(env);
  if (bypass.length > 0) {
    results.gateErrors.push(`bypass env var set: ${bypass.join(', ')}`);
    const outcome = deriveResultOutcome(results);
    return { outcome, results };
  }

  const args = parseArgs(argv);
  if (!args.manifest || !args.root) {
    results.gateErrors.push('missing required --manifest and/or --root');
    return { outcome: deriveResultOutcome(results), results };
  }

  // The gate always evaluates SOME commit under test — an omitted --commit
  // is HEAD, not "no commit". Identity enforcement below applies uniformly
  // to whichever commit is actually under test, never skipped just because
  // --commit wasn't spelled out on the CLI.
  const effectiveCommit = args.commit || 'HEAD';

  const commitIdentityConfigured = env.SANITIZE_LIFT_COMMIT_IDENTITY;
  if (!commitIdentityConfigured) {
    results.gateErrors.push('SANITIZE_LIFT_COMMIT_IDENTITY not set');
  }

  let termRegexes = [];
  try {
    const termsPath = args.terms || env.SANITIZE_PRIVATE_TERMS_FILE;
    const terms = loadPrivateTerms(termsPath);
    termRegexes = terms.map(buildTermRegex);
  } catch (e) {
    results.gateErrors.push(e.message);
  }

  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(args.manifest, 'utf8'));
  } catch (e) {
    results.gateErrors.push(`manifest unreadable/invalid JSON: ${e.message}`);
    return { outcome: deriveResultOutcome(results), results };
  }

  let treePaths;
  try {
    treePaths = gitLsTree(args.root, effectiveCommit);
  } catch (e) {
    results.gateErrors.push(`git ls-tree failed: ${e.message}`);
    return { outcome: deriveResultOutcome(results), results };
  }

  // Ref/base resolution (spec (c)/(d) — ref validation runs first). Always
  // runs, unconditionally: there is no PASS path without a resolved base,
  // and no tip-only scan mode. `resolvedRef`/`resolvedBase` (when non-null)
  // are reused below by ref-name scanning and commit-range scanning so
  // resolution never runs twice or disagrees with itself.
  let resolvedRef = null;
  const refResolution = resolveRef(args, args.root);
  if (refResolution.error) {
    results.refUnresolved.push(refResolution.error);
  } else {
    resolvedRef = refResolution.ref;
  }

  let resolvedBase = null;
  if (resolvedRef) {
    const baseResolution = resolveBase(args, args.root, resolvedRef);
    if (baseResolution.error) {
      results.baseUnresolved.push(baseResolution.error);
    } else {
      resolvedBase = baseResolution.base;
    }
  } else {
    // No resolved ref: derivation (which needs `git merge-base <ref> ...`)
    // is impossible, but an explicit, non-blank --base does not need a ref
    // and can still be honored.
    const explicitBase = typeof args.base === 'string' ? args.base.trim() : '';
    if (explicitBase) {
      resolvedBase = explicitBase;
    } else {
      results.baseUnresolved.push('BASE_UNRESOLVED: cannot derive a base without a resolved ref (and no explicit --base)');
    }
  }

  const cls = classifyPaths(treePaths, manifest);
  results.unclassified.push(...cls.unclassified);
  results.overlap.push(...cls.overlap);
  results.shapeErrors.push(...cls.shapeErrors);

  // Hash-drift + content scan over classified LIFT files. Bytes are read
  // from the commit under test (git blob), never the working tree.
  for (const [p, { entry }] of cls.classified) {
    if (entry.class !== 'LIFT') continue;
    let buf;
    try {
      buf = gitShowBlob(args.root, effectiveCommit, p);
    } catch (e) {
      results.gateErrors.push(`unreadable LIFT blob ${p} @ ${effectiveCommit}: ${e.message}`);
      continue;
    }
    const liveSha = crypto.createHash('sha256').update(buf).digest('hex');
    const hasTransform = entry.transform !== null && entry.transform !== undefined;
    if (hasTransform) {
      // Target-side: the bytes actually committed here (post-transform)
      // must match the approved target_sha256.
      if (entry.target_sha256 && liveSha !== entry.target_sha256) {
        results.hashDrift.push({ path: p, side: 'target', expected: entry.target_sha256, actual: liveSha });
      }
      // Source-side: only verifiable when a pre-transform source tree is
      // supplied (the lift step, run from claude-memory, passes
      // --source-root at the approved source_sha; ordinary public-repo CI
      // runs have no source tree to check against and skip this side).
      if (args.sourceRoot && entry.source_sha256) {
        let srcBuf = null;
        try {
          srcBuf = fs.readFileSync(path.join(args.sourceRoot, p));
        } catch (e) {
          results.gateErrors.push(`unreadable source blob ${p} in --source-root: ${e.message}`);
        }
        if (srcBuf) {
          const srcSha = crypto.createHash('sha256').update(srcBuf).digest('hex');
          if (srcSha !== entry.source_sha256) {
            results.hashDrift.push({ path: p, side: 'source', expected: entry.source_sha256, actual: srcSha });
          }
        }
      }
    } else if (entry.source_sha256 && liveSha !== entry.source_sha256) {
      results.hashDrift.push({ path: p, side: 'source', expected: entry.source_sha256, actual: liveSha });
    }
    const findings = scanBytes(buf, { location: p, termRegexes });
    results.findings.push(...findings);
  }

  // Path-string + ref-name scanning (D2).
  for (const p of treePaths) {
    const findings = scanText(p, { location: `path:${p}`, termRegexes });
    results.findings.push(...findings);
  }
  // Scan the already-resolved ref name (spec (d)) — if ref resolution
  // failed, there is nothing meaningful to scan here; the run already
  // BLOCKs via results.refUnresolved regardless.
  if (resolvedRef) {
    results.findings.push(...scanText(resolvedRef, { location: 'ref', termRegexes }));
  }

  // PR body scanning (spec Inputs: "commit messages, PR bodies, ...").
  if (args.prBodyFile) {
    try {
      const body = fs.readFileSync(args.prBodyFile, 'utf8');
      results.findings.push(...scanText(body, { location: 'pr-body', termRegexes }));
    } catch (e) {
      results.gateErrors.push(`unreadable --pr-body-file ${args.prBodyFile}: ${e.message}`);
    }
  }

  // Commit identity + message scanning. The FULL incoming commit range
  // (resolvedBase..commit) is always evaluated when a base is resolved — not
  // just the tip — so an intermediate commit's message/identity can't ride
  // in unchecked behind a clean final commit. There is no more "no --base ->
  // tip-only" mode (spec (c)): a resolved base is always required for a
  // PASS, and an unresolved base already BLOCKs via results.baseUnresolved
  // independent of what happens here. If base resolution failed, we still
  // check the tip commit's identity so a resolvable-ref/unresolvable-base
  // run doesn't ALSO silently skip identity enforcement on top of that
  // failure.
  if (commitIdentityConfigured) {
    const checkOne = (c) => {
      try {
        const id = gitCommitIdentity(args.root, c);
        const authorStr = `${id.authorName} <${id.authorEmail}>`;
        const committerStr = `${id.committerName} <${id.committerEmail}>`;
        const short = c.slice(0, 12);
        if (authorStr !== commitIdentityConfigured) {
          results.findings.push({ label: 'COMMIT_IDENTITY', location: `commit:${short}:author`, snippet: authorStr });
        }
        if (committerStr !== commitIdentityConfigured) {
          results.findings.push({ label: 'COMMIT_IDENTITY', location: `commit:${short}:committer`, snippet: committerStr });
        }
      } catch (e) {
        results.gateErrors.push(`git log failed for commit identity ${c}: ${e.message}`);
      }
    };

    if (resolvedBase) {
      let commits;
      try {
        commits = gitRevList(args.root, resolvedBase, effectiveCommit);
        if (commits.length === 0) commits = [effectiveCommit];
      } catch (e) {
        results.gateErrors.push(`git rev-list failed for range ${resolvedBase}..${effectiveCommit}: ${e.message}`);
        commits = [];
      }
      for (const c of commits) {
        checkOne(c);
        try {
          const msg = gitCommitMessage(args.root, c);
          results.findings.push(...scanText(msg, { location: `commit-message:${c.slice(0, 12)}`, termRegexes }));
        } catch (e) {
          results.gateErrors.push(`git log failed for commit message ${c}: ${e.message}`);
        }
      }
    } else {
      checkOne(effectiveCommit);
    }
  }

  return { outcome: deriveResultOutcome(results), results };
}

function main() {
  const { outcome, results } = runGate(process.argv.slice(2), process.env);
  const args = parseArgs(process.argv.slice(2));
  const payload = { outcome: outcome.outcome, findings: results.findings || [], exitCode: outcome.exitCode };

  // Self-check (spec "classifyOutcome total classification" (b)): validate
  // the FINAL payload's coarse shape before trusting it enough to print. The
  // check's own findings array must independently reflect why a BLOCK
  // happened (unclassified paths / hash drift / ref / base failures don't
  // otherwise land in `results.findings`, which is content-scan-only) so a
  // real BLOCK is never misclassified as MALFORMED_OUTCOME by this check.
  const coarseFindings = (results.findings || [])
    .concat((results.unclassified || []).map((p) => ({ label: 'UNCLASSIFIED_PATH', location: p, snippet: p })))
    .concat((results.hashDrift || []).map((h) => ({ label: 'HASH_DRIFT', location: h.path, snippet: h.side })))
    .concat((results.refUnresolved || []).map((m) => ({ label: 'REF_UNRESOLVED', location: 'ref', snippet: String(m).slice(0, 80) })))
    .concat((results.baseUnresolved || []).map((m) => ({ label: 'BASE_UNRESOLVED', location: 'base', snippet: String(m).slice(0, 80) })));
  const coarsePayload = { outcome: coarseOutcomeName(outcome.outcome), findings: coarseFindings, exitCode: outcome.exitCode };
  const selfCheck = classifyOutcome(coarsePayload);
  let finalPayload = payload;
  let finalExitCode = outcome.exitCode;
  if (selfCheck.outcome === 'BLOCK' && selfCheck.reason === 'MALFORMED_OUTCOME') {
    // The gate's own derived payload failed its own paranoid self-check —
    // this can only mean an internal bug, never a legitimate PASS. Fail
    // closed rather than emit a payload we can no longer vouch for.
    finalPayload = { outcome: 'FAIL_GATE_ERROR', findings: results.findings || [], exitCode: 3 };
    finalExitCode = 3;
  }

  if (args.json) {
    process.stdout.write(JSON.stringify(finalPayload) + '\n');
  } else {
    process.stderr.write(`sanitize-gate: ${finalPayload.outcome}\n`);
    if (results.refUnresolved && results.refUnresolved.length) {
      for (const r of results.refUnresolved) process.stderr.write(`  ref unresolved: ${r}\n`);
    }
    if (results.baseUnresolved && results.baseUnresolved.length) {
      for (const b of results.baseUnresolved) process.stderr.write(`  base unresolved: ${b}\n`);
    }
    if (results.unclassified && results.unclassified.length) {
      process.stderr.write(`  unclassified: ${results.unclassified.join(', ')}\n`);
    }
    if (results.overlap && results.overlap.length) {
      process.stderr.write(`  overlap: ${results.overlap.map((o) => o.path).join(', ')}\n`);
    }
    if (results.hashDrift && results.hashDrift.length) {
      process.stderr.write(`  hash drift: ${results.hashDrift.map((h) => `${h.path} (${h.side})`).join(', ')}\n`);
    }
    if (results.findings && results.findings.length) {
      for (const f of results.findings) process.stderr.write(`  ${f.label} @ ${f.location}: ${f.snippet}\n`);
    }
    if (results.gateErrors && results.gateErrors.length) {
      for (const g of results.gateErrors) process.stderr.write(`  gate error: ${g}\n`);
    }
    if (results.shapeErrors && results.shapeErrors.length) {
      for (const s of results.shapeErrors) process.stderr.write(`  shape error: ${s}\n`);
    }
    process.stdout.write(JSON.stringify(finalPayload) + '\n');
  }
  process.exitCode = finalExitCode;
}

module.exports = {
  normalizePath,
  classifyPaths,
  scanBytes,
  scanText,
  decodeMaybeUtf16,
  deriveResultOutcome,
  classifyOutcome,
  percentDecodeOnce,
  percentDecodeFixpoint,
  resolveRef,
  resolveBase,
  runGate,
  loadPrivateTerms,
  buildTermRegex,
  detectBypassEnv,
  BYPASS_ENV_NAMES,
  globToRegExp,
  GateError,
};

if (require.main === module) {
  main();
}
