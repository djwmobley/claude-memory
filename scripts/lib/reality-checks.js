'use strict';

/**
 * reality-checks.js — L3 Generalized Reality-Binding Registry
 *
 * Exports REALITY_CHECKS: an array of reality-check descriptors.  Each entry
 * describes one predicate that can be bound to real-world state at /handoff:close
 * time AND at serve time (resume / resurrect) via the shared runVerifyDispatch
 * helper.
 *
 * Entry shape:
 * {
 *   predicate:     string     — exact predicate name matched against assertions
 *   subjectMatch:  (subject: string, root: string) => boolean
 *                             — true if this entry applies to the given subject
 *   probe:         (root: string, object: string) => string | null
 *                             — synchronous probe that returns the authoritative
 *                               object value, or null if the probe cannot run
 *                               (fail-soft: any thrown error yields null; the
 *                               probe MUST wrap its body in try/catch and return
 *                               null on failure; it MUST NOT throw out of close
 *                               or serve)
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
 *   - is_at_commit / shipped_at are historical then-state predicates and are
 *     deliberately EXCLUDED from verify mode — do not add them here.
 *
 * Serve-time re-probe (runVerifyDispatch):
 *   The shared helper runVerifyDispatch() can be called at both close time AND
 *   serve time (resume / resurrect).  It iterates mode:'verify' entries, runs
 *   each probe LIVE against current ground truth, and returns per-row results.
 *   Callers decide what to do with the results:
 *     - close path: writes reality_check to DB + routes mismatches through L4.
 *     - serve path: annotates served lines + refreshes reality_check column
 *                   (fail-soft DB write; bounded by served-row count).
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

/**
 * Branch-existence probe.
 *
 * Checks whether a named git branch exists locally or on origin.
 *
 * Object format: the asserted object is the branch name.
 * Returns:
 *   'exists'    — if the branch is found locally (refs/heads/...) or remotely
 *   '<absent>'  — if the branch is not found
 *   null        — if git is unavailable, not a repo, timeout, or any error
 *                 (fail-soft → 'unverifiable')
 *
 * Probe is fail-soft: all exceptions → null (never throws out of here).
 * Timeout: 5 seconds (same as gitExec).
 *
 * NOTE: is_at_commit and shipped_at are historical then-state and are EXCLUDED
 * from any verify check.  This probe covers only now-state branch existence.
 *
 * @param {string} root   - absolute project root
 * @param {string} object - asserted branch name
 * @returns {string | null}
 */
function probeBranchExists(root, object) {
  try {
    if (!object || typeof object !== 'string') return null;
    const branchName = object.trim();
    if (!branchName) return null;

    // Try local refs first (fast, no network).
    try {
      gitExec(root, ['show-ref', '--verify', '--quiet', `refs/heads/${branchName}`]);
      return 'exists';
    } catch (_localErr) {
      // Not found locally — try remote refs.
    }
    // Try remote (origin) refs.
    try {
      gitExec(root, ['show-ref', '--verify', '--quiet', `refs/remotes/origin/${branchName}`]);
      return 'exists';
    } catch (_remoteErr) {
      // Not found remotely either.
    }
    return '<absent>';
  } catch (_) {
    return null; // git unavailable, not a repo, timeout, or any unexpected error.
  }
}

/**
 * Commit-merged probe.
 *
 * Checks whether a given commit SHA or ref is reachable from the HEAD of the
 * specified branch (default: HEAD of the current branch).
 *
 * Object format: "<sha>" or "<sha> on <branch>" where branch is optional.
 * Examples:
 *   "abc1234"                — check if abc1234 is an ancestor of HEAD
 *   "abc1234 on main"        — check if abc1234 is an ancestor of main
 *
 * Returns:
 *   'merged'       — the commit is an ancestor of the target ref
 *   '<not-merged>' — the commit exists but is NOT an ancestor of the target ref
 *   null           — git unavailable, commit not found, bad format, timeout, any error
 *                    (fail-soft → 'unverifiable')
 *
 * NOTE: is_at_commit / shipped_at record historical then-state and are EXCLUDED.
 * This probe is only wired to the 'commit_merged' predicate (a now-state check).
 *
 * @param {string} root   - absolute project root
 * @param {string} object - asserted object value
 * @returns {string | null}
 */
function probeCommitMerged(root, object) {
  try {
    if (!object || typeof object !== 'string') return null;

    // Parse "<sha> on <branch>" or just "<sha>".
    const onMatch = object.match(/^([0-9a-fA-F]{6,40})\s+on\s+(\S+)$/);
    let sha, targetRef;
    if (onMatch) {
      sha = onMatch[1];
      targetRef = onMatch[2];
    } else {
      // Plain SHA-like token.
      const shaMatch = object.match(/^([0-9a-fA-F]{6,40})$/);
      if (!shaMatch) return null; // Not a plausible SHA — unverifiable.
      sha = shaMatch[1];
      targetRef = 'HEAD';
    }

    // Use git merge-base --is-ancestor to check reachability.
    // Returns exit 0 if sha is an ancestor of targetRef, exit 1 if not.
    const { execFileSync } = require('child_process');
    try {
      execFileSync(
        'git',
        ['-C', root, 'merge-base', '--is-ancestor', sha, targetRef],
        { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'] }
      );
      return 'merged'; // exit 0 → is ancestor
    } catch (ancestorErr) {
      if (ancestorErr && typeof ancestorErr.status === 'number' && ancestorErr.status === 1) {
        return '<not-merged>'; // exit 1 → not an ancestor
      }
      return null; // timeout, git unavailable, or commit does not exist → unverifiable
    }
  } catch (_) {
    return null;
  }
}

/**
 * PR-state probe.
 *
 * Shells out to `gh pr view <number> --json state` and returns the normalized PR state.
 *
 * Object format: the asserted object should be one of 'open', 'closed', 'merged'.
 * The subject should contain or be the PR number (e.g. "#92", "92", "PR #92", etc.)
 * — we extract the first sequence of digits from the subject as the PR number.
 *
 * Returns:
 *   'open'    — PR is open
 *   'closed'  — PR is closed (not merged)
 *   'merged'  — PR has been merged
 *   null      — gh absent/offline/unauthenticated, no PR number found, timeout,
 *               or any error  (fail-soft → 'unverifiable')
 *
 * Timeout: ~5 seconds hard limit; on timeout → null (unverifiable, never hangs).
 * Fail-soft: any exception → null.
 *
 * NOTE: this probe requires `gh` CLI authenticated and online.  CI / offline
 * environments will consistently get null → 'unverifiable', which is correct
 * behavior — do not hang or throw.
 *
 * @param {string} root    - absolute project root (used as cwd for gh)
 * @param {string} object  - asserted PR state ('open' | 'closed' | 'merged')
 * @param {string} subject - the assertion subject (used to extract PR number)
 * @returns {string | null}
 */
function probePrState(root, object, subject) {
  try {
    if (!subject || typeof subject !== 'string') return null;
    // Extract the first contiguous run of digits from subject as the PR number.
    const numMatch = subject.match(/(\d+)/);
    if (!numMatch) return null;
    const prNum = numMatch[1];

    const { execFileSync } = require('child_process');
    let out;
    try {
      out = execFileSync(
        'gh',
        ['pr', 'view', prNum, '--json', 'state'],
        {
          cwd: root,
          encoding: 'utf8',
          timeout: 5000,
          stdio: ['ignore', 'pipe', 'pipe'],
        }
      );
    } catch (_ghErr) {
      // gh absent, unauthenticated, offline, or PR not found → unverifiable.
      return null;
    }

    let parsed;
    try { parsed = JSON.parse(out); } catch (_) { return null; }
    if (!parsed || typeof parsed.state !== 'string') return null;

    const state = parsed.state.toUpperCase();
    if (state === 'OPEN')   return 'open';
    if (state === 'CLOSED') return 'closed';
    if (state === 'MERGED') return 'merged';
    return null; // unexpected state value — unverifiable
  } catch (_) {
    return null;
  }
}

// ─── Shared verify-dispatch helper (DRY) ────────────────────────────────────

/**
 * runVerifyDispatch — Shared verify-dispatch helper.
 *
 * Runs the mode:'verify' dispatch for the given rows (already fetched from DB).
 * Returns a per-row result array that callers use to write DB tags and/or annotate
 * served output.
 *
 * This is the single shared function called by BOTH:
 *   1. The close-time verify pass (handoff.js ~4264-4338)
 *   2. The serve-time re-probe (cmdLoaderLoad and cmdResurrect)
 *
 * Both callers pass the same inputs (db, projectId, root, rows[]) and get back
 * per-row results.  Close path additionally routes mismatches through L4.
 * Serve path annotates served lines and refreshes the reality_check column.
 *
 * INVARIANT §7 (no-backfill): this function NEVER modifies confidence, source,
 * tier, or object on any row.  The only column a caller may refresh is
 * reality_check — and only the serve path actually performs those DB writes
 * (the close path does its own separate reality_check writes).
 *
 * Fail-soft: any probe error → tag='unverifiable'.  Any per-row DB error is
 * caught and logged.  Function NEVER throws out of a serve path.
 *
 * @param {object} db         - DB adapter (StoragePort)
 * @param {string} projectId  - project UUID
 * @param {string} root       - absolute path to the project root
 * @param {Array<{id: number|string, subject: string, predicate: string, object: string}>} rows
 *                            - assertion rows to probe (must include id/subject/predicate/object)
 * @returns {Promise<Array<{id, subject, object, predicate, tag, probeResult}>>}
 */
async function runVerifyDispatch(db, projectId, root, rows) {
  const results = [];

  for (const row of rows) {
    // Find a matching verify entry in the registry.
    let matched = false;
    for (const check of REALITY_CHECKS) {
      if (check.mode !== 'verify') continue;
      if (check.predicate !== row.predicate) continue;
      if (!check.subjectMatch(row.subject, root)) continue;

      matched = true;
      let probeResult;
      try {
        // Probes accept (root, object, subject) — third arg for PR-state probe.
        probeResult = check.probe(root, row.object, row.subject);
      } catch (_probeErr) {
        probeResult = null; // fail-soft
      }

      let tag;
      if (probeResult === null) {
        tag = 'unverifiable';
      } else if (probeResult === row.object) {
        tag = 'verified';
      } else {
        tag = 'mismatch';
      }

      results.push({
        id:          row.id,
        subject:     row.subject,
        object:      row.object,
        predicate:   row.predicate,
        tag,
        probeResult,
      });
      break; // first matching entry wins per row
    }

    if (!matched) {
      // No registry entry for this predicate — no result pushed.
      // Serve path will leave the line unchanged (correct floor behavior).
    }
  }

  return results;
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
 *                   dispatcher passes (root, object, subject) — probe signature
 *                   may accept a third parameter for subject-dependent probes
 *   mode          — 'authoritative' | 'verify'
 *
 * Volatile now-state predicates (mode:'verify'):
 *   - in_file         — file exists at the asserted path
 *   - branch_exists   — git branch exists locally or on origin
 *   - commit_merged   — commit SHA is merged (ancestor of ref)
 *   - pr_state        — current GitHub PR state (open/closed/merged)
 *
 * Historical then-state predicates (EXCLUDED — never add as 'verify'):
 *   - is_at_commit    — records a specific commit at ship time
 *   - shipped_at      — records a specific tag/ref at ship time
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

  // ── Entry 3: branch_exists (verify) ──────────────────────────────────────
  //
  // Checks whether the asserted branch name still exists locally or on origin.
  // Subject: any (the entity that "has" the branch).
  // Object: the branch name (e.g. 'feat/my-feature', 'main').
  //
  // close.md authoring: use this predicate for any assertion about a branch that
  // is expected to change over time (e.g. a feature branch that will be deleted
  // after merge).  The object MUST be just the branch name, e.g.
  //   { subject: "feat/serve-time-staleness-fix", predicate: "branch_exists",
  //     object: "exists" }   — canonical verified form
  // At close time, probe returns 'exists' if branch is live.
  // At next resume after branch is deleted, probe returns '<absent>' → [STALE:].
  {
    predicate: 'branch_exists',
    subjectMatch: () => true, // applies to any subject (subject holds the branch name)
    probe: (root, object, subject) => {
      // subject IS the branch name in the canonical authoring form.
      // object is the expected state ('exists' or '<absent>').
      // We probe using the subject as the branch name.
      return probeBranchExists(root, subject || object);
    },
    mode: 'verify',
  },

  // ── Entry 4: commit_merged (verify) ──────────────────────────────────────
  //
  // Checks whether a commit SHA is an ancestor of the specified ref (or HEAD).
  // Subject: the entity whose commit status is asserted.
  // Object: canonical 'merged' or '<sha> on <branch>' or just a SHA.
  //
  // close.md authoring: use for tracking "was PR #N squash-merged as <sha>?"
  // assertions where the merge status may need to be re-verified.
  //   { subject: "PR-92", predicate: "commit_merged",
  //     object: "0ac852a on main" }
  // NOTE: is_at_commit and shipped_at are EXCLUDED — they are then-state.
  // commit_merged is a now-state check ("is this commit reachable from main?").
  {
    predicate: 'commit_merged',
    subjectMatch: () => true,
    probe: (root, object) => {
      return probeCommitMerged(root, object);
    },
    mode: 'verify',
  },

  // ── Entry 5: pr_state (verify) ────────────────────────────────────────────
  //
  // Checks the current GitHub PR state via `gh pr view`.
  // Subject: should contain the PR number (e.g. "PR #92", "#92", "92").
  // Object:  expected state — 'open', 'closed', or 'merged'.
  //
  // close.md authoring: when authoring an assertion about the CURRENT state of
  // a PR, use pr_state.  The probe extracts the PR number from the subject.
  //   { subject: "PR #92", predicate: "pr_state", object: "open" }
  //   — at next resume after PR merges, probe returns 'merged' → [STALE:].
  //
  // Fail-soft: gh absent / offline / unauthenticated → null → 'unverifiable'.
  // Timeout: 5 seconds.  NEVER hangs the serve path.
  {
    predicate: 'pr_state',
    subjectMatch: () => true,
    probe: (root, object, subject) => {
      return probePrState(root, object, subject);
    },
    mode: 'verify',
  },
];

module.exports = {
  REALITY_CHECKS,
  runVerifyDispatch,
  probePackagingState,
  probeFileExists,
  probeBranchExists,
  probeCommitMerged,
  probePrState,
};
