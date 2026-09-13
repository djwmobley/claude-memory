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
 *     [--commit <sha>] [--base <sha>] [--ref <name>] [--source-root <dir>]
 *     [--pr-body-file <path>] [--terms <path>] [--json]
 *
 * Exit codes: 0 PASS, 2 FAIL_UNCLASSIFIED_PATH|FAIL_HASH_DRIFT|FAIL_CONTENT,
 * 3 FAIL_GATE_ERROR.
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
// scanText — run every non-recursive scanner over a text string.
// ctx: { location, termRegexes: RegExp[], _skipBase64 (internal) }
// Returns findings: [{ label, location, snippet }]
// ---------------------------------------------------------------------------
function runPatternSet(label, patterns, text, location, findings) {
  for (const re of patterns) {
    const m = text.match(re);
    if (m) {
      findings.push({ label, location, snippet: m[0].slice(0, 80) });
      break;
    }
  }
}

function scanText(str, ctx) {
  const findings = [];
  const location = (ctx && ctx.location) || 'unknown';
  const termRegexes = (ctx && ctx.termRegexes) || [];

  runPatternSet('OWNER_PATH', OWNER_PATH_PATTERNS, str, location, findings);
  runPatternSet('OWNER_EMAIL', OWNER_EMAIL_PATTERNS, str, location, findings);
  runPatternSet('PRIVATE_DB', PRIVATE_DB_PATTERNS, str, location, findings);
  for (const re of termRegexes) {
    const m = str.match(re);
    if (m) {
      findings.push({ label: 'PRIVATE_TERM', location, snippet: m[0].slice(0, 80) });
      break;
    }
  }
  runPatternSet('MARKER_UUID', MARKER_UUID_PATTERNS, str, location, findings);
  runPatternSet('SECRET_KEY', SECRET_KEY_PATTERNS, str, location, findings);
  runPatternSet('CONN_STRING', CONN_STRING_PATTERNS, str, location, findings);

  // URL-encoded owner-path forms (A1): decode each percent-encoded CANDIDATE
  // substring independently. Whole-string decodeURIComponent() throws on
  // ANY malformed percent sequence anywhere in the string (e.g. a bare "%"
  // from "100% complete"), which would silently suppress a valid encoded
  // owner path elsewhere in the same string. Isolate candidates first so one
  // malformed run never poisons another.
  {
    const candidateRe = /[^\s"'<>]*%[0-9A-Fa-f]{2}[^\s"'<>]*/g;
    const seen = new Set();
    let cm;
    while ((cm = candidateRe.exec(str))) {
      const token = cm[0];
      if (seen.has(token)) continue;
      seen.add(token);
      try {
        const decoded = decodeURIComponent(token);
        if (decoded !== token) {
          runPatternSet('OWNER_PATH', OWNER_PATH_PATTERNS, decoded, location, findings);
        }
      } catch (_e) {
        // this candidate isn't validly percent-encoded; skip only it
      }
    }
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
          findings.push({ label: 'BASE64_DECODE', location, snippet: m[0].slice(0, 40) });
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
// classifyOutcome — total classification of the gate's final result from
// accumulated result buckets. First matching branch wins; unknown internal
// state defaults to FAIL_GATE_ERROR (never silently PASS). `results` itself
// (or any of its expected buckets) being malformed — null, not an object, or
// a bucket present but not an array — is itself unknown state, not a clean
// empty run, and must not resolve to PASS.
// ---------------------------------------------------------------------------
function classifyOutcome(results) {
  if (results === null || typeof results !== 'object' || Array.isArray(results)) {
    return { outcome: 'FAIL_GATE_ERROR', exitCode: 3 };
  }
  const bucketNames = ['gateErrors', 'unclassified', 'overlap', 'shapeErrors', 'hashDrift', 'findings'];
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

  if (gateErrors.length > 0 || shapeErrors.length > 0 || overlap.length > 0) {
    return { outcome: 'FAIL_GATE_ERROR', exitCode: 3 };
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

function gitRefName(root) {
  try {
    return execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  } catch (_e) {
    return '';
  }
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
    else if (a === '--ref') args.ref = argv[++i];
    else if (a === '--terms') args.terms = argv[++i];
    else if (a === '--pr-body-file') args.prBodyFile = argv[++i];
    else if (a === '--json') args.json = true;
  }
  return args;
}

function runGate(argv, env) {
  env = env || process.env;
  const results = { gateErrors: [], shapeErrors: [], unclassified: [], overlap: [], hashDrift: [], findings: [] };

  const bypass = detectBypassEnv(env);
  if (bypass.length > 0) {
    results.gateErrors.push(`bypass env var set: ${bypass.join(', ')}`);
    const outcome = classifyOutcome(results);
    return { outcome, results };
  }

  const args = parseArgs(argv);
  if (!args.manifest || !args.root) {
    results.gateErrors.push('missing required --manifest and/or --root');
    return { outcome: classifyOutcome(results), results };
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
    return { outcome: classifyOutcome(results), results };
  }

  let treePaths;
  try {
    treePaths = gitLsTree(args.root, effectiveCommit);
  } catch (e) {
    results.gateErrors.push(`git ls-tree failed: ${e.message}`);
    return { outcome: classifyOutcome(results), results };
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
  // The ref/branch name under test MUST come from the caller (CI/hook),
  // which always knows the real incoming ref — falling back to the local
  // checkout's current branch is wrong whenever that checkout is in
  // detached HEAD (exactly the state a CI checkout of a PR/push commit is
  // normally in), silently skipping REF_NAME scanning entirely.
  const ref = args.ref || gitRefName(args.root);
  if (ref) {
    results.findings.push(...scanText(ref, { location: 'ref', termRegexes }));
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

  // Commit identity + message scanning. When --base is given, evaluate the
  // FULL incoming commit range (base..commit) — not just the tip — so an
  // intermediate commit's message/identity can't ride in unchecked behind a
  // clean final commit. Without --base, only the commit under test itself
  // is checked (identity + no message scan, matching the single-commit
  // shape the rest of the gate already assumes).
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

    if (args.base) {
      let commits;
      try {
        commits = gitRevList(args.root, args.base, effectiveCommit);
        if (commits.length === 0) commits = [effectiveCommit];
      } catch (e) {
        results.gateErrors.push(`git rev-list failed for range ${args.base}..${effectiveCommit}: ${e.message}`);
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

  return { outcome: classifyOutcome(results), results };
}

function main() {
  const { outcome, results } = runGate(process.argv.slice(2), process.env);
  const args = parseArgs(process.argv.slice(2));
  const payload = { outcome: outcome.outcome, findings: results.findings || [], exitCode: outcome.exitCode };
  if (args.json) {
    process.stdout.write(JSON.stringify(payload) + '\n');
  } else {
    process.stderr.write(`sanitize-gate: ${outcome.outcome}\n`);
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
    process.stdout.write(JSON.stringify(payload) + '\n');
  }
  process.exitCode = outcome.exitCode;
}

module.exports = {
  normalizePath,
  classifyPaths,
  scanBytes,
  scanText,
  decodeMaybeUtf16,
  classifyOutcome,
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
