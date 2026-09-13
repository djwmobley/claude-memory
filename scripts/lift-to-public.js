#!/usr/bin/env node
'use strict';

/**
 * lift-to-public.js — lifts the LIFT-classified paths in PUBLIC-MANIFEST.json
 * out of claude-memory (private) into a fresh target directory that becomes
 * the memory-manager (public) repo's initial import commit.
 *
 * See docs/specs/public-sanitize-gate.md ("Lift procedure") for the full
 * spec this implements. Summary:
 *
 *   1. Read PUBLIC-MANIFEST.json. NEVER write to it (see the "no write path
 *      to the manifest" invariant, enforced structurally below and covered
 *      by a static grep test in test/test-lift-to-public.js).
 *   2. For every LIFT entry, read the source blob at --base-commit from
 *      --source-root's git history and verify its live sha256 against the
 *      manifest's source_sha256. Any mismatch aborts with FAIL_HASH_DRIFT
 *      before anything is written.
 *   3. Apply the entry's transform (if any) and verify the transformed
 *      bytes' sha256 against target_sha256. Mismatch aborts the same way.
 *   4. Copy every verified LIFT file into --target-dir, plus the
 *      public-repo templates (templates/public-repo/**) and a copy of the
 *      manifest itself.
 *   5. Run scripts/sanitize-gate.js (from --source-root) against the copied
 *      tree. Only on outcome PASS does the resulting commit stand as the
 *      "Initial import (lifted from claude-memory @ <sha>)" commit, made
 *      with the explicit --identity. On any other outcome, the script exits
 *      non-zero and the target-dir's local, unpushed commit must be treated
 *      as invalid — never pushed anywhere.
 *
 * This script NEVER pushes to any remote. Pushing the resulting target-dir
 * to djwmobley/memory-manager is a separate, owner-approved step.
 *
 * Usage:
 *   node scripts/lift-to-public.js --manifest <path> --source-root <dir>
 *     --target-dir <dir> --base-commit <sha> --identity "<name> <email>"
 *     [--dry-run]
 *
 * Env:
 *   SANITIZE_PRIVATE_TERMS_FILE — passed straight through to sanitize-gate.js
 *     as its --terms path. Required (non-dry-run only).
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

class LiftError extends Error {}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const args = { dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--manifest') args.manifest = argv[++i];
    else if (a === '--source-root') args.sourceRoot = argv[++i];
    else if (a === '--target-dir') args.targetDir = argv[++i];
    else if (a === '--base-commit') args.baseCommit = argv[++i];
    else if (a === '--identity') args.identity = argv[++i];
    else if (a === '--dry-run') args.dryRun = true;
  }
  return args;
}

function splitIdentity(identity) {
  const m = /^(.*)<([^<>]+)>\s*$/.exec(String(identity || '').trim());
  if (!m || !m[1].trim() || !m[2].trim()) {
    throw new LiftError(`--identity must be in "Name <email>" form, got: ${JSON.stringify(identity)}`);
  }
  return { name: m[1].trim(), email: m[2].trim() };
}

// ---------------------------------------------------------------------------
// Manifest — read-only. No function in this file ever opens the manifest
// path (or the variable holding it) for writing; see
// test/test-lift-to-public.js's static grep check.
// ---------------------------------------------------------------------------
function readManifest(manifestPath) {
  let raw;
  try {
    raw = fs.readFileSync(manifestPath, 'utf8');
  } catch (e) {
    throw new LiftError(`manifest unreadable at ${manifestPath}: ${e.message}`);
  }
  let manifest;
  try {
    manifest = JSON.parse(raw);
  } catch (e) {
    throw new LiftError(`manifest is not valid JSON: ${e.message}`);
  }
  if (!manifest || !Array.isArray(manifest.entries)) {
    throw new LiftError('manifest.entries missing or not an array');
  }
  return manifest;
}

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

// ---------------------------------------------------------------------------
// Transform — the only transform shape this manifest currently uses is a
// literal JSON-string-value replacement (e.g. "pipeline-scripts" ->
// "memory-manager" in scripts/package.json / scripts/package-lock.json).
// ---------------------------------------------------------------------------
function applyTransform(buf, transform, entryPath) {
  if (!transform || typeof transform.from !== 'string' || typeof transform.to !== 'string') {
    throw new LiftError(`${entryPath}: malformed transform ${JSON.stringify(transform)}`);
  }
  const text = buf.toString('utf8');
  const fromLit = `"${transform.from}"`;
  const toLit = `"${transform.to}"`;
  if (!text.includes(fromLit)) {
    throw new LiftError(`${entryPath}: transform.from ${JSON.stringify(fromLit)} not found in source bytes — transform would be a no-op, refusing`);
  }
  return Buffer.from(text.split(fromLit).join(toLit), 'utf8');
}

function gitCatFile(sourceRoot, commit, relPath) {
  const env = Object.assign({}, process.env, { MSYS_NO_PATHCONV: '1' });
  try {
    return execFileSync('git', ['cat-file', '-p', `${commit}:${relPath}`], {
      cwd: sourceRoot,
      maxBuffer: 1024 * 1024 * 256,
      env,
    });
  } catch (e) {
    throw new LiftError(`FAIL_HASH_DRIFT: unable to read source blob for ${relPath} at ${commit}: ${e.message}`);
  }
}

// ---------------------------------------------------------------------------
// verifyAndCollectLift — pure verification pass over every manifest entry.
// Throws LiftError (FAIL_HASH_DRIFT-prefixed message) on the first mismatch.
// Returns the list of { path, targetBuf } to actually write.
// ---------------------------------------------------------------------------
// Paths injected into the target tree by writeTemplates()/writeManifestCopy()
// rather than copied from claude-memory's own tree at --base-commit. Their
// manifest entries (LIFT, source_sha256 = the injected bytes' own hash) exist
// so the GATE's post-copy scan of the target tree classifies them instead of
// hitting FAIL_UNCLASSIFIED_PATH — but there is no claude-memory blob at
// these paths to verify against here, so they are skipped by this
// source-tree verification pass and trusted to the gate's own independent
// hash-drift check against the live target-dir bytes.
const INJECTED_TARGET_PATHS = new Set([
  '.github/workflows/sanitize.yml',
  'hooks/pre-push',
]);

function verifyAndCollectLift(manifest, sourceRoot, baseCommit) {
  const lift = [];
  const seen = new Set();
  for (const e of manifest.entries) {
    if (!e || typeof e.path !== 'string' || !e.path) {
      throw new LiftError(`malformed manifest entry: ${JSON.stringify(e)}`);
    }
    if (seen.has(e.path)) {
      throw new LiftError(`duplicate manifest entry for path: ${e.path}`);
    }
    seen.add(e.path);

    if (e.class === 'LEAVE') {
      if (!e.reason) throw new LiftError(`LEAVE entry ${e.path}: missing reason`);
      continue;
    }
    if (e.class !== 'LIFT') {
      throw new LiftError(`entry ${e.path}: class must be LIFT or LEAVE, got ${JSON.stringify(e.class)}`);
    }
    if (!e.source_sha256) {
      throw new LiftError(`LIFT entry ${e.path}: missing source_sha256`);
    }
    const hasTransform = e.transform !== null && e.transform !== undefined;
    if (hasTransform && !e.target_sha256) {
      throw new LiftError(`LIFT entry ${e.path}: has transform but missing target_sha256`);
    }
    if (!hasTransform && e.target_sha256) {
      throw new LiftError(`LIFT entry ${e.path}: has target_sha256 but no transform`);
    }
    if (INJECTED_TARGET_PATHS.has(e.path)) {
      continue; // written by writeTemplates(); not sourced from claude-memory's tree.
    }

    const sourceBuf = gitCatFile(sourceRoot, baseCommit, e.path);
    const liveSourceSha = sha256(sourceBuf);
    if (liveSourceSha !== e.source_sha256) {
      throw new LiftError(
        `FAIL_HASH_DRIFT: ${e.path} source_sha256 mismatch (manifest=${e.source_sha256} live=${liveSourceSha})`
      );
    }

    let targetBuf = sourceBuf;
    if (hasTransform) {
      targetBuf = applyTransform(sourceBuf, e.transform, e.path);
      const liveTargetSha = sha256(targetBuf);
      if (liveTargetSha !== e.target_sha256) {
        throw new LiftError(
          `FAIL_HASH_DRIFT: ${e.path} target_sha256 mismatch after transform (manifest=${e.target_sha256} live=${liveTargetSha})`
        );
      }
    }

    lift.push({ path: e.path, targetBuf });
  }
  return lift;
}

function writeLiftedFiles(lift, targetDir) {
  for (const item of lift) {
    const dest = path.join(targetDir, item.path);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, item.targetBuf);
  }
}

// ---------------------------------------------------------------------------
// Public-repo templates — copied verbatim from source-root's
// templates/public-repo/ tree (added by PR #306) into the target tree.
// ---------------------------------------------------------------------------
const PUBLIC_REPO_TEMPLATES = [
  ['templates/public-repo/.github/workflows/sanitize.yml', '.github/workflows/sanitize.yml'],
  ['templates/public-repo/hooks/pre-push', 'hooks/pre-push'],
];

function writeTemplates(sourceRoot, targetDir) {
  for (const [rel, destRel] of PUBLIC_REPO_TEMPLATES) {
    const abs = path.join(sourceRoot, rel);
    if (!fs.existsSync(abs)) {
      throw new LiftError(
        `required public-repo template missing at source: ${rel} (from PR #306 — is it merged into --source-root's checkout?)`
      );
    }
    const buf = fs.readFileSync(abs);
    const dest = path.join(targetDir, destRel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, buf);
  }
}

function writeManifestCopy(manifestPath, targetDir) {
  // Copies FROM manifestPath (read) TO a new path under targetDir. This is
  // never a write to manifestPath itself — see the class-level comment.
  const dest = path.join(targetDir, 'PUBLIC-MANIFEST.json');
  fs.copyFileSync(manifestPath, dest);
}

// ---------------------------------------------------------------------------
// runSanitizeGate — stages the copied tree as a local git commit (the gate's
// own git-ls-tree-based discovery needs a commit-ish to scan) using the
// FINAL import message + the configured identity, then runs
// scripts/sanitize-gate.js against it.
//
// KNOWN LIMIT (see PR body "leads"): the spec's step 4/5 phrasing implies
// scanning happens BEFORE any commit exists ("Gate FAIL aborts before any
// commit"), but sanitize-gate.js's discovery is git-ls-tree-based and
// requires a real commit-ish. This script resolves the tension by always
// making the commit locally first and treating a FAIL outcome as "this
// target-dir (with its one local, unpushed commit) is invalid and must be
// discarded, never pushed" rather than literally never creating the commit
// object. Nothing is ever pushed by this script either way.
// ---------------------------------------------------------------------------
function runSanitizeGate(sourceRoot, targetDir, identity, baseCommit) {
  const gatePath = path.join(sourceRoot, 'scripts', 'sanitize-gate.js');
  if (!fs.existsSync(gatePath)) {
    throw new LiftError(
      `scripts/sanitize-gate.js not found at source-root (${gatePath}) — PR #306 must be merged into --source-root's checkout before an actual lift run`
    );
  }
  const termsFile = process.env.SANITIZE_PRIVATE_TERMS_FILE;
  if (!termsFile) {
    throw new LiftError('SANITIZE_PRIVATE_TERMS_FILE env var is not set (required to run the gate)');
  }

  const { name, email } = splitIdentity(identity);
  const gitEnv = Object.assign({}, process.env, {
    GIT_AUTHOR_NAME: name,
    GIT_AUTHOR_EMAIL: email,
    GIT_COMMITTER_NAME: name,
    GIT_COMMITTER_EMAIL: email,
  });

  execFileSync('git', ['init', '-q'], { cwd: targetDir });
  execFileSync('git', ['add', '-A'], { cwd: targetDir });
  const commitMessage = `Initial import (lifted from claude-memory @ ${baseCommit})`;
  execFileSync('git', ['commit', '-q', '-m', commitMessage], { cwd: targetDir, env: gitEnv });
  const commitSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: targetDir, encoding: 'utf8' }).trim();

  const gateArgs = [
    gatePath,
    '--manifest', path.join(targetDir, 'PUBLIC-MANIFEST.json'),
    '--root', targetDir,
    '--commit', commitSha,
    '--terms', termsFile,
    '--json',
  ];
  const gateEnv = Object.assign({}, process.env, { SANITIZE_LIFT_COMMIT_IDENTITY: identity });

  let stdout = '';
  try {
    stdout = execFileSync('node', gateArgs, { cwd: targetDir, env: gateEnv, encoding: 'utf8' });
  } catch (e) {
    stdout = (e.stdout && e.stdout.toString()) || '';
  }
  const lastLine = stdout.trim().split(/\r?\n/).filter(Boolean).pop();
  let payload;
  try {
    payload = JSON.parse(lastLine);
  } catch (e) {
    throw new LiftError(`sanitize-gate produced no parseable final JSON line — treated as a failure, not a pass (${e.message})`);
  }
  return { payload, commitSha };
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
function run(argv) {
  const args = parseArgs(argv);
  if (!args.manifest || !args.sourceRoot || !args.targetDir || !args.baseCommit || !args.identity) {
    process.stderr.write(
      'Usage: lift-to-public.js --manifest <path> --source-root <dir> --target-dir <dir> --base-commit <sha> --identity "<name> <email>" [--dry-run]\n'
    );
    return { outcome: 'FAIL_USAGE', exitCode: 1 };
  }

  const manifest = readManifest(args.manifest);
  if (manifest.source_sha && manifest.source_sha !== args.baseCommit) {
    throw new LiftError(
      `--base-commit ${args.baseCommit} does not match manifest.source_sha ${manifest.source_sha}`
    );
  }

  process.stderr.write(`[lift] verifying ${manifest.entries.length} manifest entries against ${args.baseCommit}...\n`);
  const lift = verifyAndCollectLift(manifest, args.sourceRoot, args.baseCommit);
  process.stderr.write(`[lift] ${lift.length} LIFT files verified (sha256 match; transforms re-hashed).\n`);

  if (args.dryRun) {
    process.stderr.write('[lift] --dry-run: no files written, no git operations performed.\n');
    return { outcome: 'DRY_RUN_OK', exitCode: 0, liftCount: lift.length };
  }

  fs.mkdirSync(args.targetDir, { recursive: true });
  writeLiftedFiles(lift, args.targetDir);
  writeTemplates(args.sourceRoot, args.targetDir);
  writeManifestCopy(args.manifest, args.targetDir);

  const { payload, commitSha } = runSanitizeGate(args.sourceRoot, args.targetDir, args.identity, args.baseCommit);

  if (payload.outcome !== 'PASS') {
    process.stderr.write(`[lift] sanitize-gate FAILED: ${payload.outcome}\n`);
    process.stderr.write(JSON.stringify(payload.findings || [], null, 2) + '\n');
    process.stderr.write(
      `[lift] ${args.targetDir} carries a local-only, UNPUSHED commit ${commitSha}. Do not push it. Fix the flagged content in claude-memory (or PUBLIC-MANIFEST.json's classification) and re-run.\n`
    );
    return { outcome: payload.outcome, exitCode: payload.exitCode || 2, commitSha };
  }

  process.stderr.write(`[lift] sanitize-gate PASS. Import commit ${commitSha} created locally in ${args.targetDir} (not pushed).\n`);
  return { outcome: 'PASS', exitCode: 0, commitSha, liftCount: lift.length };
}

function main() {
  try {
    const result = run(process.argv.slice(2));
    process.stdout.write(JSON.stringify(result) + '\n');
    process.exitCode = result.exitCode;
  } catch (e) {
    process.stderr.write(`[lift] FAILED: ${e.message}\n`);
    process.stdout.write(JSON.stringify({ outcome: 'FAIL', error: e.message, exitCode: 3 }) + '\n');
    process.exitCode = 3;
  }
}

module.exports = {
  parseArgs,
  splitIdentity,
  readManifest,
  applyTransform,
  verifyAndCollectLift,
  writeLiftedFiles,
  writeTemplates,
  writeManifestCopy,
  runSanitizeGate,
  run,
  LiftError,
  PUBLIC_REPO_TEMPLATES,
};

if (require.main === module) {
  main();
}
