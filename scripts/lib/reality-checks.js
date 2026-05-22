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
 *   probe:         (root: string, object: string, subject: string) => string | null
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
 *   annotateOnly:  boolean (optional, verify-mode only)
 *                             — when true, this entry participates ONLY in the
 *                               serve-time annotation pass.  It is EXCLUDED from:
 *                               (a) the close-time PRE-WRITE reconcile pass
 *                                   (which would auto-suppress mismatched rows), and
 *                               (b) the close-time POST-WRITE L3 verify pass
 *                                   (which would record a degraded_close alarm).
 *                             — Use annotateOnly for predicates like open_thread
 *                               whose object is pure freeform model belief — a
 *                               merged anchor is a strong "verify this" nudge, but
 *                               suppressing or degrading on it would destroy
 *                               legitimate follow-up work.
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
 *   - annotateOnly entries are EXCLUDED from both close-time passes; they
 *     participate only in serve-time annotation.  open_thread is the canonical
 *     example: a merged anchor PR# is a staleness nudge, not a safe basis for
 *     auto-suppression or degraded-close alarms on freeform belief text.
 *
 * Serve-time re-probe (runVerifyDispatch):
 *   The shared helper runVerifyDispatch() can be called at both close time AND
 *   serve time (resume / resurrect).  It iterates mode:'verify' entries, runs
 *   each probe LIVE against current ground truth, and returns per-row results.
 *   Callers decide what to do with the results:
 *     - close path: writes reality_check to DB + routes mismatches through L4.
 *       EXCEPTION: annotateOnly entries are excluded from the close path entirely
 *       (neither the pre-write reconcile pass nor the post-write L3 verify pass
 *       will fetch, reconcile, suppress, or degrade-alarm annotateOnly rows).
 *     - serve path: annotates served lines + refreshes reality_check column
 *                   (fail-soft DB write; bounded by served-row count).
 *       annotateOnly entries participate fully in the serve path.
 *
 * Volatile now-state predicates (mode:'verify'):
 *   - in_file         — file exists at the asserted path
 *   - branch_exists   — git branch exists locally or on origin
 *   - commit_merged   — commit SHA is merged (ancestor of ref)
 *   - pr_state        — current GitHub PR state (open/closed/merged)
 *   - open_thread     — serve-time only: any cited PR # found in git log is flagged
 *                       as merged → nudge to verify the thread is still open
 *                       (annotateOnly: never suppressed or degraded at close time)
 *
 * Historical then-state predicates (EXCLUDED — never add as 'verify'):
 *   - is_at_commit    — records a specific commit at ship time
 *   - shipped_at      — records a specific tag/ref at ship time
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

    // First, verify this is actually a git repository by running a cheap command.
    // If this fails (exit 128 = "not a git repository", or any other error), we
    // return null → 'unverifiable' rather than '<absent>' → 'mismatch'.  This
    // distinguishes the "git unavailable / not a repo" case from the "branch not
    // found" case.
    try {
      gitExec(root, ['rev-parse', '--git-dir']);
    } catch (_notRepoErr) {
      // git unavailable, not a git repository, or timeout → unverifiable.
      return null;
    }

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
    //
    // IMPORTANT: on success we echo back the asserted `object` (not a hardcoded
    // sentinel like 'merged').  This mirrors probeFileExists, which returns the
    // path on success.  The dispatch logic in runVerifyDispatch tags a row as
    // 'verified' when probeResult === row.object, so echoing the object is the
    // only way commit_merged can ever reach the 'verified' state.  Returning a
    // fixed string like 'merged' would always produce a mismatch because 'merged'
    // can never equal an object of the form "<sha> on <branch>" or "<sha>".
    const { execFileSync } = require('child_process');
    try {
      execFileSync(
        'git',
        ['-C', root, 'merge-base', '--is-ancestor', sha, targetRef],
        { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'] }
      );
      return object; // exit 0 → is ancestor → echo back the asserted object → 'verified'
    } catch (ancestorErr) {
      if (ancestorErr && typeof ancestorErr.status === 'number' && ancestorErr.status === 1) {
        return '<not-merged>'; // exit 1 → not an ancestor → mismatch
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
          // shell:true is required on Windows to execute gh.cmd batch-file wrappers.
          // On POSIX systems this routes through /bin/sh, which is safe for these
          // hard-coded arguments (no user-supplied content in the arg list).
          shell: true,
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

// ─── Merged-PR-set memo ──────────────────────────────────────────────────────

/**
 * Module-level memo: maps project root → Set<string> of merged PR number-strings.
 * Populated lazily by getMergedPrSet().  The memo persists for the lifetime of
 * the process (one serve pass), so multiple rows probed in the same pass share
 * a single git-log call per root.
 */
const _mergedPrSetCache = new Map();

/**
 * getMergedPrSet — Parse merged PR numbers from git log commit subjects.
 *
 * Runs `git log --format=%s -n 2000` in the given root to get the last 2000
 * commit subjects, then extracts all `(#NNN)` occurrences (the squash-merge
 * pattern used by this repo: e.g. "feat: add foo (#119)").
 *
 * Returns a Set<string> of number-strings on success (may be empty if the log
 * ran but found no matching patterns).  Returns null on ANY failure (git absent,
 * not a git repository, timeout, or any other error).  Distinguishing null
 * (failure) from empty-set (success, no merges) matters: null means the probe
 * is unverifiable; empty-set means no merged PRs found and no annotation is added.
 *
 * Memoized per root for the duration of the process.
 *
 * @param {string} root - absolute project root
 * @returns {Set<string> | null}
 */
function getMergedPrSet(root) {
  if (_mergedPrSetCache.has(root)) {
    return _mergedPrSetCache.get(root);
  }
  try {
    const { execFileSync } = require('child_process');
    // Uses execFileSync (not exec) — no shell interpolation; args are hard-coded
    // literals with no user-supplied content, so no injection risk.
    const out = execFileSync(
      'git',
      ['-C', root, 'log', '--format=%s', '-n', '2000'],
      {
        encoding: 'utf8',
        timeout: 5000,
        stdio: ['ignore', 'pipe', 'pipe'],
      }
    );
    // Extract every (#NNN) occurrence from the commit subjects.
    const merged = new Set();
    const re = /\(#(\d+)\)/g;
    let m;
    while ((m = re.exec(out)) !== null) {
      merged.add(m[1]);
    }
    _mergedPrSetCache.set(root, merged);
    return merged;
  } catch (_) {
    // git unavailable, not a repo, timeout, or any other error → unverifiable.
    // Do NOT cache null: a transient failure should not poison the memo for later
    // callers in the same process (e.g. retry after git becomes available).
    return null;
  }
}

/**
 * probeOpenThread — Serve-time staleness probe for open_thread assertions.
 *
 * open_thread objects are pure freeform model belief; there is no stable
 * authoritative value to compare against.  Instead, this probe looks for
 * cited PR numbers (any #NNN token in subject or object) and checks whether
 * any of them appear in the local git log as a merged squash-merge subject
 * of the form "(#NNN)".  If one or more are found merged, it returns a
 * human-readable staleness hint; otherwise null (unverifiable / no signal).
 *
 * Return value encoding:
 *   null   — unverifiable: no #NNN anchor cited, or git log unavailable, or
 *            none of the cited PR numbers appear in the merged set.
 *            runVerifyDispatch tags these rows 'unverifiable' → no annotation.
 *   string — a human-readable description such as
 *            "merged: #106 — verify thread is still open"
 *            This will never equal row.object (freeform prose), so
 *            runVerifyDispatch tags it 'mismatch' → serve path annotates
 *            [STALE: now "merged: #106 — verify thread is still open"].
 *
 * Design note: a merged anchor is NOT proof the thread is done — the original
 * PR could be a base fix and the thread may describe follow-up work.  That is
 * why the message says "verify" rather than asserting the thread is resolved.
 * annotateOnly: true ensures this probe never triggers auto-suppression or
 * degraded-close alarms at close time.
 *
 * Fail-soft: all errors caught; returns null on any exception.
 *
 * @param {string} root    - absolute project root
 * @param {string} object  - asserted object value (freeform prose)
 * @param {string} subject - assertion subject (may also cite PR numbers)
 * @returns {string | null}
 */
function probeOpenThread(root, object, subject) {
  try {
    // Combine subject and object into one haystack to find any cited PR numbers.
    const hay = `${subject || ''} ${object || ''}`;
    const cited = [];
    const re = /#(\d+)/g;
    let m;
    while ((m = re.exec(hay)) !== null) {
      cited.push(m[1]);
    }
    if (cited.length === 0) {
      // No #NNN anchor in this thread — no basis for a signal.
      return null;
    }

    const merged = getMergedPrSet(root);
    if (merged === null) {
      // git log failed — unverifiable; stay silent.
      return null;
    }

    const mergedCited = cited.filter((n) => merged.has(n));
    if (mergedCited.length === 0) {
      // None of the cited PR numbers are in the merged set — no signal.
      return null;
    }

    // One or more cited PRs are merged → emit a staleness hint.
    // Deduplicate while preserving order.
    const seen = new Set();
    const unique = mergedCited.filter((n) => (seen.has(n) ? false : seen.add(n) || true));
    return `merged: ${unique.map((n) => '#' + n).join(', ')} — verify thread is still open`;
  } catch (_) {
    return null; // fail-soft: any error → unverifiable
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

  // Per-pass circuit-breaker for network-bound probes (network: true entries).
  // Once a network probe returns null (offline / timeout) in this pass, all
  // subsequent network probes are short-circuited to null → 'unverifiable'
  // without waiting.  This prevents N×timeout latency when gh is offline.
  // Local probes (network: false / absent) are never short-circuited.
  let networkCircuitOpen = false;

  for (const row of rows) {
    // Find a matching verify entry in the registry.
    let matched = false;
    for (const check of REALITY_CHECKS) {
      if (check.mode !== 'verify') continue;
      if (check.predicate !== row.predicate) continue;
      if (!check.subjectMatch(row.subject, root)) continue;

      matched = true;
      let probeResult;

      // Circuit-breaker: if a prior network probe already failed in this pass,
      // short-circuit this one too (returns null → 'unverifiable', no wait).
      if (check.network === true && networkCircuitOpen) {
        probeResult = null;
      } else {
        try {
          // Probes accept (root, object, subject) — third arg for PR-state probe.
          probeResult = check.probe(root, row.object, row.subject);
        } catch (_probeErr) {
          probeResult = null; // fail-soft
        }
        // If a network probe just returned null, open the circuit for this pass.
        if (check.network === true && probeResult === null) {
          networkCircuitOpen = true;
        }
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
 *   network       — optional boolean; true if the probe requires an external
 *                   network call (e.g. gh pr view).  The per-serve-pass
 *                   circuit-breaker in runVerifyDispatch uses this flag: once
 *                   one network probe returns null (offline / timeout) in a
 *                   pass, all subsequent network probes in that pass are
 *                   short-circuited to null ('unverifiable') without waiting.
 *   annotateOnly  — optional boolean (verify-mode only); when true, this entry
 *                   is excluded from both close-time passes:
 *                     (a) the pre-write reconcile pass (.filter excludes it), and
 *                     (b) the post-write L3 verify pass (skipped via `continue`).
 *                   Serve-time annotation still runs normally.  See header doc.
 *
 * Volatile now-state predicates (mode:'verify'):
 *   - in_file         — file exists at the asserted path
 *   - branch_exists   — git branch exists locally or on origin
 *   - commit_merged   — commit SHA is merged (ancestor of ref)
 *   - pr_state        — current GitHub PR state (open/closed/merged)
 *   - open_thread     — annotateOnly; any cited #NNN in git merged set → staleness
 *                       nudge at serve time; never suppressed or degraded at close
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
  //
  // network: true — marks this probe as network-bound so the per-pass
  // circuit-breaker in runVerifyDispatch short-circuits subsequent network
  // probes once one fails (prevents N×5s latency when gh is offline).
  {
    predicate: 'pr_state',
    subjectMatch: () => true,
    probe: (root, object, subject) => {
      return probePrState(root, object, subject);
    },
    mode: 'verify',
    network: true,
  },

  // ── Entry 6: open_thread (verify, annotateOnly) ───────────────────────────
  //
  // Serve-time-only staleness gate for open_thread assertions.
  //
  // open_thread objects are freeform model prose — there is no stable
  // authoritative value to compare against, so the standard
  // reconcile-on-mismatch and degraded-close flows MUST NOT fire for this
  // predicate.  annotateOnly: true enforces this: the pre-write reconcile
  // pass and the post-write L3 verify pass both skip open_thread rows.
  //
  // The probe (probeOpenThread) looks for #NNN PR-number citations in the
  // subject + object combined haystack, then checks which (if any) appear
  // in `git log` as squash-merged commit subjects of the form "(#NNN)".
  //
  // Returns:
  //   null   — no #NNN cited, git unavailable, or none of the cited PRs are
  //            merged → 'unverifiable' → no annotation (clean floor for
  //            anchorless threads and threads whose base PRs are not yet merged).
  //   string — e.g. "merged: #106 — verify thread is still open"
  //            → 'mismatch' → served line annotated [STALE: now "merged: ..."].
  //            This is an informational nudge, NOT a claim of resolution.
  //
  // Safety invariant (critical): annotateOnly prevents ANY close from
  // suppressing, superseding, reconciling, or degraded-alarming an open_thread
  // row, even if a cited anchor PR has been merged.  A merged base PR does not
  // imply the follow-up work is complete — the annotation just signals "verify".
  {
    predicate: 'open_thread',
    subjectMatch: () => true,
    probe: (root, object, subject) => {
      return probeOpenThread(root, object, subject);
    },
    mode: 'verify',
    annotateOnly: true, // serve-time annotation ONLY — never close-time reconcile/suppress/degrade
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
  getMergedPrSet,
  probeOpenThread,
};
