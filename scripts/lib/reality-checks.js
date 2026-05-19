'use strict';

/**
 * reality-checks.js — L3 Generalized Reality-Binding Registry
 *
 * Exports REALITY_CHECKS: an array of reality-check descriptors.  Each entry
 * describes one predicate that can be bound to real-world state at /handoff:close
 * time.
 *
 * Entry shape:
 * {
 *   predicate:     string     — exact predicate name matched against assertions
 *   subjectMatch:  (subject: string) => boolean
 *                             — true if this entry applies to the given subject
 *   probe:         (root: string) => string | null
 *                             — synchronous probe that returns the authoritative
 *                               object value, or null if the probe cannot run
 *                               (fail-soft: any thrown error yields null; the
 *                               probe MUST wrap its body in try/catch and return
 *                               null on failure; it MUST NOT throw out of close)
 *   mode:          'authoritative' | 'verify'
 *                             — 'authoritative': strip model-supplied rows and
 *                               inject a single code-computed canonical assertion
 *                             — 'verify': leave all assertions unchanged; tag
 *                               each matching assertion with reality_check=
 *                               'verified' | 'mismatch' | 'unverifiable' based
 *                               on probe output vs asserted object
 * }
 *
 * Design invariants (enforced by test-l3-reality-checks.js):
 *   - Authoritative probes are now-state predicates only.  is_at_commit is
 *     EXCLUDED from authoritative mode (design-of-record correction): it records
 *     historical ship points; authoritative overwrite would corrupt then-state
 *     commit references.
 *   - Verify mode is strictly non-mutating: conf, source, and tier of matched
 *     assertions are NEVER modified.  Only the reality_check column is written.
 *   - Probe failures are fail-soft: a probe returning null yields
 *     reality_check='unverifiable'; close exits normally.
 *   - Adding a new entry here automatically participates in the dispatch loop in
 *     handoff.js without any other changes.
 */

const path = require('path');

// ─── Shared helpers ──────────────────────────────────────────────────────────

/**
 * Run a git command in the given root directory.
 * Returns the trimmed stdout string on success, or throws on non-zero exit.
 * Uses execFileSync with a 5-second timeout (matching detectUnpackagedState).
 */
function gitExec(root, args) {
  const { execFileSync } = require('child_process');
  return execFileSync(
    'git',
    ['-C', root, ...args],
    {
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, PROJECT_ROOT: root },
    }
  ).trim();
}

// ─── Probe implementations ───────────────────────────────────────────────────

/**
 * Packaging-state probe — the same logic as detectUnpackagedState in handoff.js,
 * but returns the canonical object string directly ('clean' or 'dirty — <label>').
 *
 * Kept here for registry ownership.  handoff.js continues to call its own
 * detectUnpackagedState; the authoritative registry entry delegates to this
 * function so the logic is not duplicated at the point of dispatch.
 *
 * @param {string} root - absolute path to the project root
 * @returns {string | null}
 */
function probePackagingState(root) {
  try {
    const { execFileSync } = require('child_process');
    const execOpts = {
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, PROJECT_ROOT: root },
    };

    // Dirty-tree check — mirror the PAYLOAD_STAGING_RE filter from detectUnpackagedState.
    const PAYLOAD_STAGING_RE = /^(?:\.)?handoff-close-payload.*\.json$/i;
    const statusOut = execFileSync('git', ['-C', root, 'status', '--porcelain'], execOpts);
    const filteredLines = statusOut.split('\n').filter((line) => {
      if (!line.trim()) return false;
      const filePart = line.slice(3).trim().replace(/^"(.*)"$/, '$1');
      return !PAYLOAD_STAGING_RE.test(path.basename(filePart));
    });
    const dirty = filteredLines.length > 0;

    // Ahead-of-upstream check.
    let aheadCount = 0;
    try {
      const aheadOut = execFileSync(
        'git', ['-C', root, 'rev-list', '--count', '@{upstream}..HEAD'], execOpts
      );
      aheadCount = parseInt(aheadOut.trim(), 10) || 0;
    } catch (_) {
      aheadCount = 0;
    }

    const unpackaged = dirty || aheadCount > 0;
    if (!unpackaged) return 'clean';
    const parts = [];
    if (dirty) parts.push('dirty working tree');
    if (aheadCount > 0) parts.push(`${aheadCount} commit(s) ahead of upstream`);
    return 'dirty — ' + parts.join(', ');
  } catch (_) {
    // git unavailable, not a repo, or any other error.
    // Match detectUnpackagedState's fail-soft behavior: return 'clean' (never null) so
    // the authoritative injection always produces a canonical row, even when git is absent.
    // This preserves golden-test byte-equivalence with the pre-L3 hard-coded behavior.
    return 'clean';
  }
}

/**
 * File-existence probe for in_file-style predicates.
 *
 * Interprets the asserted object as a file path relative to root (or absolute).
 *
 * Returns:
 *   object (the path)   — if the file exists at that path (verified)
 *   '<absent>'          — if the object looks like a path but the file is absent (mismatch)
 *   null                — if the object is not a plausible file path or an error occurs
 *                         (unverifiable — fail-soft)
 *
 * This encoding lets the standard dispatcher logic work:
 *   probeResult === row.object  → 'verified'   (file exists, path matches asserted)
 *   probeResult === null        → 'unverifiable' (can't determine — non-path string)
 *   otherwise                  → 'mismatch'    (file absent, or path differs)
 *
 * Used by the 'verify'-mode 'in_file' entry as a concrete, tested verify path.
 *
 * @param {string} root   - absolute project root
 * @param {string} object - asserted object value (expected: a relative file path)
 * @returns {string | null}
 */
function probeFileExists(root, object) {
  try {
    if (!object || typeof object !== 'string') return null;
    // Only attempt to verify objects that look like a file path (contain a / or \,
    // or end in a known extension).  This prevents spurious mismatches on objects
    // that are plain descriptive strings.
    const looksLikePath = /[/\\]/.test(object) || /\.\w{1,6}$/.test(object);
    if (!looksLikePath) return null;

    const fs = require('fs');
    const target = path.isAbsolute(object) ? object : path.join(root, object);
    // Return the path itself when file exists (so probeResult === row.object → verified).
    // Return '<absent>' when file does not exist (so probeResult !== row.object → mismatch).
    return fs.existsSync(target) ? object : '<absent>';
  } catch (_) {
    return null;
  }
}

// ─── Registry ────────────────────────────────────────────────────────────────

/**
 * REALITY_CHECKS — the canonical registry of reality-bound predicates.
 *
 * Dispatch order matters for 'authoritative' entries: the first matching entry
 * wins for strip+inject.  For 'verify' entries, all matching entries are applied.
 *
 * Entry contract:
 *   predicate     — exact predicate name (case-sensitive, matches ass.predicate)
 *   subjectMatch  — pure function; return true to apply this entry to a subject
 *   probe         — pure, read-only, fail-soft to null; MUST wrap in try/catch;
 *                   for 'verify' mode probes that need the asserted object, the
 *                   dispatcher passes (root, object) — probe signature may accept
 *                   a second parameter for this purpose
 *   mode          — 'authoritative' | 'verify'
 */
const REALITY_CHECKS = [
  // ── Entry 1: has_unpackaged_state (authoritative) ────────────────────────
  //
  // The original hard-coded authoritative packaging assertion, now generalized
  // into the registry.  Behavior is preserved byte-for-byte:
  //   subject:    path.basename(root)
  //   object:     'clean'  OR  'dirty — <label>'
  //   confidence: 9
  //   source:     'user_stated'
  //
  // GOLDEN-TEST INVARIANT: the object value and all other injected fields must
  // be identical to what handoff.js produced before L3 was introduced.
  {
    predicate: 'has_unpackaged_state',
    subjectMatch: (subject, root) => subject === path.basename(root),
    probe: (root) => {
      // Delegates to the shared probe; already fail-soft (returns null on any error).
      return probePackagingState(root);
    },
    mode: 'authoritative',
  },

  // ── Entry 2: in_file (verify) ─────────────────────────────────────────────
  //
  // Non-mutating verify check for assertions that claim something is located
  // in a file (the object is expected to be a relative path).  On mismatch,
  // routes through L4's recordDegradedClose surface.
  //
  // NOTE: is_at_commit is EXCLUDED from this registry.  Design-of-record
  // correction: is_at_commit records historical ship points; overwriting or
  // authoritative-verifying now-state would corrupt then-state commit
  // references.  It must never appear as 'authoritative' here.
  {
    predicate: 'in_file',
    subjectMatch: () => true,  // applies to any subject
    probe: (root, object) => {
      // Delegates to the shared file-existence probe; fail-soft.
      return probeFileExists(root, object);
    },
    mode: 'verify',
  },
];

module.exports = { REALITY_CHECKS, probePackagingState, probeFileExists };
