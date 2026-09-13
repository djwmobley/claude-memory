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
 *     [--commit <sha>] [--terms <path>] [--json]
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
// Minimal glob matcher — no new deps. Supports "**" (any path segment span)
// and "*" (any run of non-slash chars). Sufficient for manifest globs like
// "scripts/migrations/**".
// ---------------------------------------------------------------------------
function globToRegExp(glob) {
  const norm = normalizePath(glob);
  let out = '^';
  for (let i = 0; i < norm.length; i++) {
    const c = norm[i];
    if (c === '*') {
      if (norm[i + 1] === '*') {
        out += '.*';
        i++;
        // consume an optional following slash so "dir/**" matches "dir" itself
        if (norm[i + 1] === '/') i++;
      } else {
        out += '[^/]*';
      }
    } else if ('.+?^${}()|[]\\'.includes(c)) {
      out += '\\' + c;
    } else {
      out += c;
    }
  }
  out += '$';
  return new RegExp(out);
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
//     unclassified: [path...],        // no manifest entry matched
//     overlap: [{ path, entries }...] // more than one manifest entry matched
//     shapeErrors: [string...]        // malformed manifest entries
//   }
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
  }

  const literalEntries = entries.filter((e) => e && typeof e.path === 'string' && !isGlobEntry(e.path));
  const globEntries = entries.filter((e) => e && typeof e.path === 'string' && isGlobEntry(e.path))
    .map((e) => ({ entry: e, re: globToRegExp(e.path) }));
  const literalMap = new Map(literalEntries.map((e) => [normalizePath(e.path), e]));

  const classified = new Map();
  const unclassified = [];
  const overlap = [];

  for (const rawPath of treePaths) {
    const p = normalizePath(rawPath);
    const matches = [];
    if (literalMap.has(p)) matches.push(literalMap.get(p));
    for (const g of globEntries) {
      if (g.re.test(p)) matches.push(g.entry);
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

  // URL-encoded owner-path forms (A1): decode once and re-scan OWNER_PATH only.
  try {
    const decoded = decodeURIComponent(str);
    if (decoded !== str) {
      runPatternSet('OWNER_PATH', OWNER_PATH_PATTERNS, decoded, location, findings);
    }
  } catch (_e) {
    // not URL-encoded content; ignore
  }

  // BASE64_DECODE: find base64-looking runs >=64 chars, decode, re-scan
  // (excluding this same base64 step, to avoid unbounded recursion).
  if (!ctx || !ctx._skipBase64) {
    const b64re = /[A-Za-z0-9+/]{64,}={0,2}/g;
    let m;
    while ((m = b64re.exec(str))) {
      try {
        const decodedBuf = Buffer.from(m[0], 'base64');
        const decodedStr = decodedBuf.toString('utf8');
        const inner = scanText(decodedStr, { location, termRegexes, _skipBase64: true });
        if (inner.length > 0) {
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
// state defaults to FAIL_GATE_ERROR (never silently PASS).
// ---------------------------------------------------------------------------
function classifyOutcome(results) {
  const r = results || {};
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

function gitCommitIdentity(root, commit) {
  const out = execFileSync(
    'git',
    ['log', '-1', '--format=%an%x00%ae%x00%cn%x00%ce', commit],
    { cwd: root, encoding: 'utf8' }
  ).trim();
  const [an, ae, cn, ce] = out.split('\x00');
  return { authorName: an, authorEmail: ae, committerName: cn, committerEmail: ce };
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
    else if (a === '--commit') args.commit = argv[++i];
    else if (a === '--terms') args.terms = argv[++i];
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

  const commitIdentityConfigured = env.SANITIZE_LIFT_COMMIT_IDENTITY;
  const commit = args.commit;
  if (commit && !commitIdentityConfigured) {
    results.gateErrors.push('SANITIZE_LIFT_COMMIT_IDENTITY not set while --commit was given');
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
    treePaths = commit ? gitLsTree(args.root, commit) : gitLsTree(args.root, 'HEAD');
  } catch (e) {
    results.gateErrors.push(`git ls-tree failed: ${e.message}`);
    return { outcome: classifyOutcome(results), results };
  }

  const cls = classifyPaths(treePaths, manifest);
  results.unclassified.push(...cls.unclassified);
  results.overlap.push(...cls.overlap);
  results.shapeErrors.push(...cls.shapeErrors);

  // Hash-drift + content scan over classified LIFT files.
  for (const [p, { entry }] of cls.classified) {
    if (entry.class !== 'LIFT') continue;
    const abs = path.join(args.root, p);
    let buf;
    try {
      buf = fs.readFileSync(abs);
    } catch (e) {
      results.gateErrors.push(`unreadable LIFT file ${p}: ${e.message}`);
      continue;
    }
    const liveSha = crypto.createHash('sha256').update(buf).digest('hex');
    if (entry.source_sha256 && liveSha !== entry.source_sha256 && !entry.transform) {
      results.hashDrift.push({ path: p, expected: entry.source_sha256, actual: liveSha });
    }
    const findings = scanBytes(buf, { location: p, termRegexes });
    results.findings.push(...findings);
  }

  // Path-string + ref-name scanning (D2).
  for (const p of treePaths) {
    const findings = scanText(p, { location: `path:${p}`, termRegexes });
    results.findings.push(...findings);
  }
  const ref = args.ref || gitRefName(args.root);
  if (ref) {
    results.findings.push(...scanText(ref, { location: 'ref', termRegexes }));
  }

  // Commit identity (D1).
  if (commit && commitIdentityConfigured) {
    try {
      const id = gitCommitIdentity(args.root, commit);
      const authorStr = `${id.authorName} <${id.authorEmail}>`;
      const committerStr = `${id.committerName} <${id.committerEmail}>`;
      if (authorStr !== commitIdentityConfigured) {
        results.findings.push({ label: 'COMMIT_IDENTITY', location: 'commit:author', snippet: authorStr });
      }
      if (committerStr !== commitIdentityConfigured) {
        results.findings.push({ label: 'COMMIT_IDENTITY', location: 'commit:committer', snippet: committerStr });
      }
    } catch (e) {
      results.gateErrors.push(`git log failed for commit identity: ${e.message}`);
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
      process.stderr.write(`  hash drift: ${results.hashDrift.map((h) => h.path).join(', ')}\n`);
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
