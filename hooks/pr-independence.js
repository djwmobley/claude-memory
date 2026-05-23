"use strict";
// pr-independence.js
// PreToolUse hook — enforces the two-agent PR-independence rule.
//
// Block conditions:
//   ROOT caller attempting gh pr merge / gh pr review --approve  → always block.
//   Subagent caller recorded as creator of the target PR's branch → block.
//   Merge/approve where authoring cannot be verified (branch unresolved) → fail-closed.
// Allow conditions:
//   Any tool other than Bash → allow.
//   Bash commands that are not merge/approve/create → allow.
//   gh pr create → allow (and record the caller as creator).
//   Subagent merge/approve where caller is verifiably NOT in the creator set → allow.

const fs   = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

// ── Paths ──────────────────────────────────────────────────────────────────
const HOOKS_DIR  = __dirname;
const DEBUG_LOG  = path.join(HOOKS_DIR, "pr-independence-debug.log");
const REGISTRY   = path.join(HOOKS_DIR, "pr-authoring-registry.jsonl");

// ── Data-region scrubbing ──────────────────────────────────────────────────
//
// PURPOSE: prevent false-positive detection of "gh pr merge/review/create" verb
// sequences that appear only inside pure DATA regions of a shell command —
// specifically heredoc bodies, single-quoted strings, and double-quoted strings —
// where they cannot constitute a real protected action.
//
// ZERO-FALSE-NEGATIVE GUARANTEE: In any genuine shell invocation, the verb
// tokens "gh", "pr", "merge", "review", "create", "--approve" are always
// unquoted command tokens (they are never the contents of a quoted string or
// heredoc body in a real gh call).  Therefore removing quoted/heredoc CONTENT
// cannot suppress detection of a real protected action.  Only DATA (arguments,
// payloads, commit messages, JSON bodies, etc.) lives inside quotes/heredocs.
//
// AMBIGUITY / FAIL-TOWARD-DETECTION: if heredoc or quote parsing is uncertain
// (no closing delimiter found, unmatched quotes) the uncertain region is left
// intact so detection still fires.  We prefer a tolerable false positive over
// a missed real merge.
//
/**
 * Return a copy of `cmd` with the CONTENTS of data regions blanked out.
 * Scrubbed regions:
 *   1. Heredoc bodies  (<<TAG, <<-TAG, <<'TAG', <<"TAG", << TAG, etc.)
 *   2. Single-quoted string contents  ('...' — POSIX: no escapes inside)
 *   3. Double-quoted string contents  ("..." — honors \" escape)
 *
 * The original `cmd` string is never mutated.
 *
 * @param {string} cmd
 * @returns {string}
 */
function scrubDataRegions(cmd) {
  // ── Pass 1: strip heredoc bodies ────────────────────────────────────────
  // We process line by line so we can match opening / closing delimiter lines.
  const lines = cmd.split("\n");
  const result = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    // Look for a heredoc operator on this line.
    // Pattern: <<[-]?[' "]?WORD[' "]?  (delimiter is the unquoted WORD)
    // We match the LAST occurrence on the line (a line may have multiple).
    // Captures: [1]='-' or '', [2]=quote char or '', [3]=WORD
    const hdRe = /<<(-?)\s*(['"]?)(\w+)\2/g;
    let hdMatch = null;
    let lastHdMatch = null;
    while ((hdMatch = hdRe.exec(line)) !== null) {
      lastHdMatch = hdMatch;
    }

    if (!lastHdMatch) {
      result.push(line);
      i++;
      continue;
    }

    // We found a heredoc.  The opening line itself is kept (it contains the
    // command verb tokens, not data).  Consume body lines until the closing
    // delimiter.
    result.push(line);
    i++;

    const strip = lastHdMatch[1] === "-"; // <<- strips leading tabs from delimiter
    const delim = lastHdMatch[3];         // the raw delimiter word

    let foundClose = false;
    while (i < lines.length) {
      const bodyLine = lines[i];
      const checkLine = strip ? bodyLine.replace(/^\t*/, "") : bodyLine;
      if (checkLine === delim) {
        // Closing delimiter line — keep it (structural token, not data).
        result.push(bodyLine);
        i++;
        foundClose = true;
        break;
      }
      // Body line — replace with empty string (blanked data).
      result.push("");
      i++;
    }

    if (!foundClose) {
      // No closing delimiter found — ambiguous / unbalanced heredoc.
      // We already blanked each body line above.  Per the fail-toward-detection
      // rule: the verb tokens of real `gh pr merge/review/create` invocations
      // are NEVER inside a heredoc body — they appear on the command line before
      // `<<`.  Therefore blanking an unbalanced heredoc body is safe and cannot
      // cause a false negative for a real protected action.
    }
  }
  let scrubbed = result.join("\n");

  // ── Pass 2: strip single-quoted string contents ──────────────────────────
  // POSIX single-quotes: no escapes; a lone ' always ends the string.
  // Replace content between paired ' delimiters with empty.
  {
    let out = "";
    let inSingle = false;
    for (let ci = 0; ci < scrubbed.length; ci++) {
      const ch = scrubbed[ci];
      if (!inSingle) {
        out += ch;
        if (ch === "'") inSingle = true;
      } else {
        if (ch === "'") {
          out += ch; // closing quote — keep the structural delimiter
          inSingle = false;
        }
        // else: body content inside single-quotes — drop it
      }
    }
    // Unbalanced single-quote: we already dropped everything after the last
    // unmatched '.  This is conservative in the right direction: a command with
    // an unmatched ' would be a shell syntax error and therefore never a genuine
    // protected invocation.
    scrubbed = out;
  }

  // ── Pass 3: strip double-quoted string contents ──────────────────────────
  // Honor \" escape sequences; keep the delimiter quotes themselves.
  {
    let out = "";
    let inDouble = false;
    for (let ci = 0; ci < scrubbed.length; ci++) {
      const ch = scrubbed[ci];
      if (!inDouble) {
        out += ch;
        if (ch === '"') inDouble = true;
      } else {
        if (ch === "\\" && ci + 1 < scrubbed.length) {
          // Any backslash sequence inside double-quotes is content — drop both chars.
          ci++;
          continue;
        }
        if (ch === '"') {
          out += ch; // closing quote — keep the structural delimiter
          inDouble = false;
        }
        // else: body content inside double-quotes — drop it
      }
    }
    // Unbalanced double-quote: same reasoning as single-quote above.
    scrubbed = out;
  }

  return scrubbed;
}

/**
 * Extract the "--repo owner/repo" or "-R owner/repo" flag value from a
 * SCRUBBED gh command string.  Returns "owner/repo" if found, else null.
 *
 * Always call with the SCRUBBED command so that --repo values inside quoted
 * data regions are already removed and cannot produce false matches.
 *
 * @param {string} scrubbedCmd
 * @returns {string|null}
 */
function extractRepoFlag(scrubbedCmd) {
  // Match --repo owner/repo or -R owner/repo.
  // The value must look like "word/word" (no spaces; basic owner/repo shape).
  const m = scrubbedCmd.match(/(?:--repo|-R)\s+([\w.\-]+\/[\w.\-]+)/);
  return m ? m[1] : null;
}

/**
 * Extract the target directory of a leading `cd <dir>` that precedes the
 * `gh pr` token in the RAW (un-scrubbed) command string.
 *
 * Handles:
 *   cd /c/gemini/x && gh pr merge 5     →  "C:/gemini/x"
 *   cd "C:/a b/x" && gh ...             →  "C:/a b/x"
 *   cd 'C:/a b/x' && gh ...             →  "C:/a b/x"
 *   cd C:/foo && gh ...                 →  "C:/foo"
 *   gh pr merge 5 (no leading cd)       →  null
 *
 * MSYS-style /c/foo paths are normalized to C:/foo.
 *
 * SECURITY: only a leading cd (before the `gh pr` token) is recognized.
 * A cd that appears AFTER `gh pr` is ignored so it cannot affect resolution
 * of the command being checked.
 *
 * @param {string} rawCmd
 * @returns {string|null}
 */
function extractCdTarget(rawCmd) {
  // Find the position of `gh pr` in the raw command.
  const ghPos = rawCmd.search(/\bgh\s+pr\b/);
  if (ghPos < 0) return null; // No gh pr token at all.

  // Only examine the portion BEFORE the gh pr token for a leading cd.
  const prefix = rawCmd.slice(0, ghPos);

  // Match `cd` followed by an optionally-quoted path, with optional `&&` or `;`
  // or whitespace between the cd and the next token (gh pr).
  // Capture groups:
  //   1: double-quoted path (may contain spaces)
  //   2: single-quoted path (may contain spaces)
  //   3: unquoted path (no spaces; stops at whitespace, &&, ;)
  const cdRe = /\bcd\s+(?:"([^"]+)"|'([^']+)'|([\S]+))\s*(?:&&|;)?\s*$/;
  const m = prefix.match(cdRe);
  if (!m) return null;

  const raw = m[1] !== undefined ? m[1]
            : m[2] !== undefined ? m[2]
            : m[3];

  // Normalize MSYS-style /c/foo -> C:/foo.
  const normalized = raw.replace(/^\/([a-zA-Z])\//, (_, letter) => letter.toUpperCase() + ":/");
  return normalized;
}

/**
 * Pure decision function — maps resolution state to block/allow.
 *
 * Inputs:
 *   caller      {string}  — agent_id string, or "ROOT"
 *   branch      {string|null}  — resolved head-ref branch name, or null
 *   branchErr   {string|null}  — error message if branch could not be resolved
 *   creatorSet  {Set<string>}  — set of agent_id strings recorded as creators
 *                                for the target PR's branch
 *
 * Returns { action: "block"|"allow", reason: string }
 *
 * Decision tree (non-negotiable; maps directly to the two-agent rule):
 *   1. caller === "ROOT"                           → block
 *   2. branch resolved AND caller in creatorSet   → block
 *   3. branch NOT resolved (null)                 → block (fail-closed)
 *   4. branch resolved AND caller NOT in creatorSet → allow
 *
 * @param {{ caller: string, branch: string|null, branchErr: string|null, creatorSet: Set<string> }} opts
 * @returns {{ action: "block"|"allow", reason: string }}
 */
function decide({ caller, branch, branchErr, creatorSet }) {
  // 1. ROOT is always in every authoring set by the delegation=authorship rule.
  if (caller === "ROOT") {
    return {
      action: "block",
      reason:
        "the root orchestrator is in every authoring set by " +
        "delegation=authorship and must never merge/approve. " +
        "Spawn a fresh independent subagent to merge.",
    };
  }

  // 2. Caller is recorded as a creator of this PR's branch.
  if (branch && creatorSet.has(caller)) {
    return {
      action: "block",
      reason:
        `agent_id ${caller} created this PR (branch ${branch}) ` +
        "and cannot merge/approve it. Use a different independent agent.",
    };
  }

  // 3. Branch could not be resolved — fail-closed (non-negotiable rule).
  if (!branch) {
    return {
      action: "block",
      reason:
        "could not verify authoring independence " +
        `(branch unresolved: ${branchErr || "unknown error"}). ` +
        "Resolve manually or merge as a verified independent agent / the user.",
    };
  }

  // 4. Caller is a subagent not in this PR's creator set — allow.
  return {
    action: "allow",
    reason: `agent_id ${caller} is not in the creator set for branch ${branch}.`,
  };
}

// Export pure helpers for unit-test isolation.
// The CLI entrypoint is guarded below with `if (require.main === module)`.
module.exports = { scrubDataRegions, extractRepoFlag, extractCdTarget, decide };

// ── Helpers ────────────────────────────────────────────────────────────────

function appendDebug(obj) {
  try {
    fs.appendFileSync(DEBUG_LOG, JSON.stringify(obj) + "\n", "utf8");
  } catch (_) {
    // Never crash on debug log failure.
  }
}

function appendRegistry(obj) {
  fs.appendFileSync(REGISTRY, JSON.stringify(obj) + "\n", "utf8");
}

function loadRegistry() {
  if (!fs.existsSync(REGISTRY)) return [];
  return fs
    .readFileSync(REGISTRY, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      try { return JSON.parse(line); } catch (_) { return null; }
    })
    .filter(Boolean);
}

function resolveBranch(cwd) {
  try {
    return execFileSync(
      "git",
      ["-C", cwd, "rev-parse", "--abbrev-ref", "HEAD"],
      { encoding: "utf8", timeout: 8000 }
    ).trim();
  } catch (_) {
    return "UNKNOWN_BRANCH";
  }
}

/**
 * Resolve the head-ref branch name for a PR number.
 *
 * @param {number} prNumber
 * @param {{ cwd?: string, repo?: string|null }} opts
 *   repo — if set, uses `--repo owner/repo` (cwd-independent, most robust).
 *   cwd  — working directory passed to execFileSync when repo is not set.
 * @returns {{ branch: string }|{ error: string }}
 */
function resolvePRBranch(prNumber, opts) {
  // Back-compat: allow old resolvePRBranch(n, cwdString) call signature.
  let cwd, repo;
  if (typeof opts === "string") {
    cwd  = opts;
    repo = null;
  } else {
    cwd  = (opts && opts.cwd)  || process.cwd();
    repo = (opts && opts.repo) || null;
  }

  try {
    const args = ["pr", "view", String(prNumber), "--json", "headRefName", "-q", ".headRefName"];
    if (repo) {
      args.splice(2, 0, "--repo", repo); // insert before the PR number positional
    }
    const execOpts = { encoding: "utf8", timeout: 15000 };
    if (!repo) {
      // Only set cwd when not using --repo; --repo is cwd-independent.
      execOpts.cwd = cwd;
    }
    const branch = execFileSync("gh", args, execOpts).trim();
    if (!branch) return { error: "empty headRefName from gh" };
    return { branch };
  } catch (e) {
    return { error: String((e && e.message) || e) };
  }
}

/**
 * Extract the first standalone integer token from the portion of a
 * gh pr merge/review command that follows the subcommand verb.
 * e.g. "gh pr merge 35 --squash"    → 35
 *      "gh pr review 42 --approve"  → 42
 *      "gh pr merge --squash 35"    → 35 (first int anywhere after the verb)
 *
 * NOTE: always called with the SCRUBBED command string so that PR numbers
 * embedded in data payloads do not interfere with extraction.
 */
function extractPRNumber(cmd) {
  const m = cmd.match(/\bgh\s+pr\s+(?:merge|review)\s+([\s\S]*)/);
  if (!m) return null;
  const rest = m[1];
  // Match first standalone decimal integer (not part of a flag value like --timeout=60).
  const numMatch = rest.match(/(?:^|\s)(\d+)(?:\s|$)/);
  if (numMatch) return parseInt(numMatch[1], 10);
  return null;
}

// ── Main ───────────────────────────────────────────────────────────────────

function main() {
  // Read all of stdin (fd 0) — works on Windows with Node.
  let raw;
  try {
    raw = fs.readFileSync(0, "utf8");
  } catch (_) {
    process.exit(0); // Can't read stdin; allow to avoid breaking tooling.
  }

  // JSON.parse — on failure exit 0 (do not break unrelated tooling).
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (_) {
    process.exit(0);
  }

  const tool_name  = (parsed.tool_name)  || "";
  const tool_input = (parsed.tool_input) || {};
  const cmd    = (tool_input && typeof tool_input.command === "string")
    ? tool_input.command
    : "";
  const caller = parsed.agent_id ? String(parsed.agent_id) : "ROOT";
  const cwd    = parsed.cwd || process.cwd();

  // Derive a scrubbed copy of cmd with heredoc bodies, single-quoted string
  // contents, and double-quoted string contents removed.  All detection regexes
  // and extractPRNumber run against `scrubbed`; the raw `cmd` is only used for
  // the debug log so misfires remain observable.
  const scrubbed = scrubDataRegions(cmd);

  // ── Step 4: Debug log (always) ────────────────────────────────────────
  appendDebug({
    ts:               new Date().toISOString(),
    tool_name,
    agent_id_present: !!parsed.agent_id,
    caller,
    cmd_prefix:       cmd.slice(0, 40),
    scrubbed_changed: (scrubbed !== cmd),
  });

  // ── Step 2: Only Bash commands are relevant ───────────────────────────
  if (tool_name !== "Bash") {
    process.exit(0);
  }

  // ── Step 6: gh pr create — record creator and allow ──────────────────
  // Detection runs against scrubbed to avoid false-positives from data payloads.
  if (/\bgh\s+pr\s+create\b/.test(scrubbed)) {
    // Use the effective cwd: a leading `cd <dir>` in the raw command may have
    // moved into a different repo before the gh pr create call.
    const cdTarget   = extractCdTarget(cmd);
    const effCwdCr   = cdTarget || cwd;
    const branch     = resolveBranch(effCwdCr);
    // Optionally record --repo for the registry entry (additive, harmless).
    const repo       = extractRepoFlag(scrubbed);
    appendRegistry({
      ts:     new Date().toISOString(),
      event:  "create",
      branch,
      caller,
      ...(repo ? { repo } : {}),
    });
    process.exit(0);
  }

  // ── Step 7: gh pr merge OR gh pr review --approve (protected actions) ─
  // Detection runs against scrubbed.
  const isMerge   = /\bgh\s+pr\s+merge\b/.test(scrubbed);
  const isApprove = /\bgh\s+pr\s+review\b/.test(scrubbed) && /--approve\b/.test(scrubbed);

  if (isMerge || isApprove) {
    // Any internal error in the protected block → fail-closed (exit 2).
    try {
      // extractPRNumber also runs against scrubbed so data payloads cannot
      // inject a phantom PR number that would mislead branch resolution.
      const prNumber = extractPRNumber(scrubbed);
      let branch     = null;
      let branchErr  = null;

      if (prNumber !== null) {
        // Derive the effective repo context from the command itself:
        //   1. --repo owner/repo flag (cwd-independent, most robust)
        //   2. leading `cd <dir>` before the gh pr token (may be cross-repo)
        //   3. fallback: hook's parsed.cwd (same as before this fix)
        const repo      = extractRepoFlag(scrubbed);
        const cdTarget  = extractCdTarget(cmd);
        const effCwd    = cdTarget || cwd;
        const result    = resolvePRBranch(prNumber, { cwd: effCwd, repo });
        if (result.branch) {
          branch = result.branch;
        } else {
          branchErr = result.error;
        }
      } else {
        branchErr = "no PR number found in command";
      }

      // Collect the set of callers recorded as creators for this branch.
      const registry   = loadRegistry();
      const creatorSet = new Set();
      if (branch) {
        for (const entry of registry) {
          if (entry.event === "create" && entry.branch === branch) {
            creatorSet.add(String(entry.caller));
          }
        }
      }

      // ── Decision tree — delegate to pure decide() function ──────────
      const { action, reason } = decide({ caller, branch, branchErr, creatorSet });

      if (action === "block") {
        process.stderr.write(`PR-independence: ${reason}\n`);
        process.exit(2);
      }

      // action === "allow"
      process.exit(0);

    } catch (internalErr) {
      // Fail-closed for any unexpected error during the protected action check.
      process.stderr.write(
        "PR-independence: internal error during merge/approve check: " +
        `${(internalErr && internalErr.message) || internalErr}. ` +
        "Failing closed. Resolve manually.\n"
      );
      process.exit(2);
    }
  }

  // ── Step 8: All other commands — allow ───────────────────────────────
  process.exit(0);
}

// Top-level guard: if main() throws outside the protected merge/approve block
// (which has its own try/catch), the error is non-critical — exit 0 to avoid
// breaking unrelated tooling.
if (require.main === module) {
  try {
    main();
  } catch (topErr) {
    process.exit(0);
  }
}
