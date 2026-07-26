"use strict";
// agent-adversary-floor.js
// PreToolUse hook — floor requirement that a delegation to a write-capable
// subagent (via the Agent tool, and via SendMessage where interception is
// possible — see "SendMessage coverage" below) carries either a completeness/
// blind-spot framing clause or an explicit exemption marker.
//
// ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
// An orchestrator repeatedly under-specified validation logic (matchers,
// parsers, extension allow-lists, contiguity assumptions) with under-specified
// prompts, then relied on post-hoc review to catch its own design errors. A
// spec-adversary analysis concluded: a prompt-text hook can only ever be a
// FLOOR against total omission of completeness framing — it cannot verify
// genuine adversarial thought. This hook IS that floor, and is built and
// documented knowing that is all it is. The heavier fix (a mandatory
// adversary-before-authoring phase, run against the spec, not the code) is
// out of scope for a prompt-text hook and belongs to the operator's own
// process/documentation, not to this file.
//
// ── WHAT THIS HOOK ENFORCES ─────────────────────────────────────────────────
// For any Agent-tool spawn of a subagent type NOT in the structural exempt
// set (i.e. any type that is write-capable by default), the `prompt` text
// must contain either:
//   (a) at least one blind-spot/completeness pattern (see BLIND_SPOT_PATTERNS
//       below — "blind spot", "cannot detect", "pass but should",
//       "adversar*", etc.), OR
//   (b) at least one literal exemption marker `[adversary-exempt: <reason>]`
//       with a non-empty, non-whitespace reason, AND no OTHER exemption
//       marker present with an empty/whitespace-only reason (see "MARKER
//       VALIDATION IS GLOBAL" below).
// If neither is present, the spawn is BLOCKED with a message naming the gap.
//
// ── MARKER VALIDATION IS GLOBAL (fixed defect — read before touching) ───────
// EVERY `[adversary-exempt: ...]` occurrence in the text is found and
// validated, not just the first. If ANY marker present has an empty or
// whitespace-only reason, that is treated as a malformed exemption attempt
// and the call is BLOCKED — even if a blind-spot pattern or a separate
// well-formed marker is also present elsewhere in the same text. An
// attempted-but-broken exemption must fail loudly; it must never be silently
// ignored or allowed to pass on other grounds. A prior version of this hook
// stripped only the FIRST marker occurrence before scanning for blind-spot
// patterns, which meant a second, malformed marker was never stripped (so it
// could spuriously satisfy the `adversar` stem pattern) and never validated
// (so it could silently sit there while the call passed on the strength of a
// different valid marker or an unrelated blind-spot phrase). That defect
// also affected the single-marker case whenever a blind-spot pattern happened
// to appear elsewhere in the same prompt: the pattern check ran BEFORE the
// marker was validated, so a lone malformed marker could be masked by
// incidental pattern text. Both are closed by validating every marker before
// any pattern match is allowed to short-circuit the result.
//
// ── WHAT THIS HOOK CANNOT ENFORCE (be honest about this) ───────────────────
//   - That the orchestrator actually thought adversarially. A boilerplate
//     sentence ("Report what this canNOT detect.") pasted into every prompt
//     with zero thought behind it satisfies this hook completely. This hook
//     checks for the PRESENCE of framing text, not its quality, not whether
//     the subagent's answer was read, and not whether the orchestrator acted
//     on it.
//   - That the subagent actually answered the blind-spot question, or that
//     any answer given was true.
//   - Content routed around the scanned fields entirely — e.g. a prompt that
//     says "see spec.md" with the actual validation spec (and any adversary
//     framing or its absence) living in a file the hook never reads.
//   - Under-specification that lives in the orchestrator's own reasoning
//     between calls (a plan formed with an allow-list mindset, then handed
//     to a subagent with technically-compliant boilerplate tacked on).
//   - Multi-turn SendMessage resumes of an agent that was spawned compliant
//     but is later steered off-spec in a follow-up message (only the
//     FIRST-turn work-assignment message is checked at all, and only if
//     SendMessage interception is real — see below).
//
// ── FAIL-OPEN POLICY (deliberate house policy) ──────────────────────────────
// On ANY parse error, missing/malformed field, or internal exception:
// ALLOW, and append a line to the debug log so decay/gaps are auditable.
// This hook gates the Agent tool itself. A fail-closed bug here would
// deadlock a session that depends on delegation to get work done. Fail-open
// trades a rare false ALLOW for never bricking the only channel through which
// work can get done. This mirrors the fail-open rationale used by other
// PreToolUse guards in this hooks directory.
//
// ── EXEMPT-SET FAILURE DIRECTION (must be structural, not keyword) ─────────
// EXEMPT_TYPES below is a closed, explicit allow-list of agent types that are
// read-only BY TOOL GRANT (Explore, Plan, claude-code-guide,
// plugin-dev:plugin-validator, plugin-dev:skill-reviewer). Any type NOT in
// this list — INCLUDING unknown/future agent types never seen before — is
// treated as write-capable and subject to the requirement. This is
// intentional and must never be inverted:
//   - An OMISSION from EXEMPT_TYPES (a genuinely read-only type this list
//     doesn't yet know about) produces FRICTION: a false BLOCK. Friction is
//     visible immediately (the spawn fails, loudly, with a reason) and is
//     trivially correctable (add the type to the list, or use the exemption
//     marker for that one call).
//   - EXEMPT_TYPES can NEVER produce a silent escape for a write-capable
//     type, because membership is closed and explicit — nothing defaults
//     INTO the exempt set; everything defaults OUT of it (i.e. is treated as
//     write-capable) unless positively listed.
// That is the correct default: a false block is visible friction; a false
// allow is the exact failure mode this hook exists to prevent.
//
// ── SENDMESSAGE COVERAGE — determination and its basis ──────────────────────
// The Claude Code hook-development documentation describes PreToolUse as
// firing "before any tool runs" and describes the `matcher` field as a plain
// regex tested against `tool_name` — not restricted to a fixed, enumerated
// tool list. Nothing in that documentation carves out an exception for
// SendMessage, and SendMessage is invoked through the same tool-call
// mechanism as Agent, Write, Bash, etc. On that basis this hook DOES
// implement SendMessage coverage (see step 6 in main()), intended to be
// registered via matcher "Agent|SendMessage" (see hooks/README.md in this
// repo for the wiring pattern). This is an INFERENCE from the documented
// general contract, not something empirically confirmed by observing a live
// PreToolUse:SendMessage event — if in practice a given harness build does
// not route SendMessage through PreToolUse, this branch is simply dead code:
// it is never invoked, so it can never falsely block. The Agent-tool
// coverage above is unaffected either way.
//
// Note also: SendMessage carries no `subagent_type` field (it addresses a
// recipient by name, not by declared type), so the structural exempt-set
// classification used for Agent spawns does NOT apply to SendMessage calls —
// there is no type to classify. Step 6 instead applies the same total
// completeness-clause-or-exemption-marker rule directly to any non-empty
// `message` field, with no attempt at semantic work-assignment
// classification beyond "the field is a non-empty string" (per spec: do not
// attempt semantic classification).
//
// No process.platform branching anywhere in this file — capability
// detection only (agent-type membership, field shape), never OS branching.
// Node only, no dependencies.

const fs   = require("fs");
const path = require("path");

// ── Paths ──────────────────────────────────────────────────────────────────
// The debug log lives next to wherever this file itself is actually running
// from (__dirname) — not a hardcoded personal path, and not an os.homedir()
// guess about install location. That means it resolves correctly whether the
// hook is run from this repo's hooks/ directory (during development/tests)
// or from its deployed copy at ~/.claude/hooks/ (scripts/sync-hooks.js copies
// this file there). Matches the convention already used by pr-independence.js
// in this same directory.
const HOOKS_DIR = __dirname;
const DEBUG_LOG = path.join(HOOKS_DIR, "agent-adversary-floor-debug.log");

// ── Helpers ────────────────────────────────────────────────────────────────

function appendDebug(obj) {
  try {
    fs.appendFileSync(DEBUG_LOG, JSON.stringify(obj) + "\n", "utf8");
  } catch (_) {
    // Never crash on debug log failure.
  }
}

// ── Structural exempt set (read-only by tool grant) ─────────────────────────
// Closed, explicit list. See "EXEMPT-SET FAILURE DIRECTION" header comment.
const EXEMPT_TYPES = [
  "Explore",
  "Plan",
  "claude-code-guide",
  "plugin-dev:plugin-validator",
  "plugin-dev:skill-reviewer",
];

function isExemptType(subagentType) {
  return EXEMPT_TYPES.indexOf(subagentType) !== -1;
}

// ── Blind-spot / completeness pattern classes (case-insensitive) ───────────
// This is a floor, not a semantic gate: presence anywhere in the text
// satisfies it. No code-block stripping, no positional/contiguity logic —
// per spec, over-cleverness here adds failure modes without adding
// enforcement.
const BLIND_SPOT_PATTERNS = [
  { re: /blind[\s-]+spot/i,                    label: "blind spot / blind-spot" },
  { re: /\bcan(?:\s?not|'t)\s+detect\b/i,       label: "cannot / can not / can't detect" },
  { re: /pass(?:es)?[\s-]but[\s-]should/i,      label: "pass(es) but should / pass-but-should" },
  { re: /what\s+can\s+this\s+not\b/i,           label: "what can this NOT" },
  { re: /fails\s+to\s+fire/i,                   label: "fails to fire" },
  { re: /construct\s+inputs?\s+that\b/i,        label: "construct input(s) that" },
  { re: /adversar/i,                            label: "adversar* stem" },
];

// Explicit exemption marker: [adversary-exempt: <reason>] — reason must be
// non-empty after trimming. An empty or whitespace-only reason does NOT
// satisfy it (matches, but fails the trim-length check). Used both as a
// single-shot form (for constructing a fresh global-flag copy per call, see
// hasCompletenessSignal) and re-exported for unit-test isolation.
const EXEMPTION_MARKER_RE = /\[adversary-exempt:\s*([^\]]*)\]/i;

/**
 * Returns { ok: boolean, via: "pattern"|"marker"|null, detail: string|null }
 * describing whether `text` satisfies the completeness-clause-or-exemption
 * requirement.
 */
function hasCompletenessSignal(text) {
  if (typeof text !== "string") {
    return { ok: false, via: null, detail: null };
  }

  // Find and strip ALL exemption-marker occurrences (global match) before
  // running the blind-spot pattern scan, and collect the reason text of
  // EVERY marker found — not just the first. See header comment "MARKER
  // VALIDATION IS GLOBAL" for why a non-global, first-match-only strip is
  // unsafe: it leaves later markers both unstripped (able to spuriously trip
  // the `adversar` stem pattern) and unvalidated (able to silently carry an
  // empty reason).
  const markerRe = new RegExp(EXEMPTION_MARKER_RE.source, "gi");
  const reasons = [];
  let scanText = "";
  let lastIndex = 0;
  let m;
  while ((m = markerRe.exec(text)) !== null) {
    reasons.push(m[1] || "");
    scanText += text.slice(lastIndex, m.index);
    lastIndex = m.index + m[0].length;
  }
  scanText += text.slice(lastIndex);

  // Any marker with an empty/whitespace-only reason is a malformed
  // exemption attempt. Per spec this BLOCKS the call outright — even if a
  // blind-spot pattern or a separate, well-formed marker is also present —
  // so this check runs BEFORE the pattern scan below, not after it.
  const hasMalformedMarker = reasons.some((r) => r.trim().length === 0);
  if (hasMalformedMarker) {
    return { ok: false, via: null, detail: "empty-reason-marker" };
  }

  for (const pat of BLIND_SPOT_PATTERNS) {
    const pm = pat.re.exec(scanText);
    if (pm) {
      return { ok: true, via: "pattern", detail: pat.label };
    }
  }

  if (reasons.length > 0) {
    // All markers already confirmed well-formed above (no malformed found).
    return { ok: true, via: "marker", detail: reasons[0].trim() };
  }

  return { ok: false, via: null, detail: null };
}

/**
 * Build the block message for a failing write-capable spawn.
 */
function buildBlockMessage(kind, subagentType, field) {
  return (
    `agent-adversary-floor: BLOCKED — this ${kind} spawn` +
    (subagentType ? ` (subagent_type: ${subagentType})` : "") +
    ` is write-capable but its \`${field}\` field has no completeness/blind-spot` +
    ` requirement and no exemption marker.\n` +
    `Add either:\n` +
    `  (a) a clause requiring the subagent to report what its work canNOT` +
    ` detect / construct at least one input that passes but shouldn't, OR\n` +
    `  (b) the literal marker [adversary-exempt: <reason>] with a non-empty reason.\n` +
    `Example compliant clause: "Report what this check canNOT detect, and` +
    ` construct at least one input that passes but shouldn't."\n`
  );
}

// Export pure functions for unit-test isolation.
module.exports = {
  EXEMPT_TYPES,
  BLIND_SPOT_PATTERNS,
  EXEMPTION_MARKER_RE,
  isExemptType,
  hasCompletenessSignal,
  buildBlockMessage,
};

// ── Main ───────────────────────────────────────────────────────────────────

function main() {
  // Read all of stdin (fd 0) — works on Windows with Node.
  let raw;
  try {
    raw = fs.readFileSync(0, "utf8");
  } catch (_) {
    appendDebug({ ts: new Date().toISOString(), event: "fail_open", reason: "stdin_read_error" });
    process.exit(0);
  }

  // JSON.parse — on failure, fail-open + log.
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (_) {
    appendDebug({ ts: new Date().toISOString(), event: "fail_open", reason: "json_parse_error" });
    process.exit(0);
  }

  if (!parsed || typeof parsed !== "object") {
    appendDebug({ ts: new Date().toISOString(), event: "fail_open", reason: "parsed_not_object" });
    process.exit(0);
  }

  const tool_name = typeof parsed.tool_name === "string" ? parsed.tool_name : "";
  if (!tool_name) {
    appendDebug({ ts: new Date().toISOString(), event: "fail_open", reason: "missing_tool_name" });
    process.exit(0);
  }

  const tool_input = (parsed.tool_input && typeof parsed.tool_input === "object")
    ? parsed.tool_input
    : {};

  // Step 2 / non-target dispatch: only Agent (and SendMessage — see header
  // comment "SENDMESSAGE COVERAGE") are in scope. Everything else: allow,
  // untouched, no special logging needed beyond the fail-open convention
  // above (this is a normal no-op path, not a fail-open occurrence).
  if (tool_name !== "Agent" && tool_name !== "SendMessage") {
    process.exit(0);
  }

  try {
    if (tool_name === "Agent") {
      // Step 3: extract subagent_type (absent -> general-purpose) and prompt.
      const subagentType = (typeof tool_input.subagent_type === "string" && tool_input.subagent_type)
        ? tool_input.subagent_type
        : "general-purpose";

      // Step 4: structural capability classification.
      if (isExemptType(subagentType)) {
        appendDebug({
          ts: new Date().toISOString(), event: "allow_exempt_type",
          tool_name, subagent_type: subagentType,
        });
        process.exit(0);
      }

      const prompt = tool_input.prompt;
      if (typeof prompt !== "string") {
        // Missing/non-string prompt field -> fail-open per house policy
        // (cannot evaluate a field that isn't there / isn't text).
        appendDebug({
          ts: new Date().toISOString(), event: "fail_open",
          reason: "prompt_missing_or_non_string", tool_name, subagent_type: subagentType,
        });
        process.exit(0);
      }

      const signal = hasCompletenessSignal(prompt);
      appendDebug({
        ts: new Date().toISOString(), event: signal.ok ? "allow" : "block",
        tool_name, subagent_type: subagentType, via: signal.via, detail: signal.detail,
      });

      if (signal.ok) {
        process.exit(0);
      }

      process.stderr.write(buildBlockMessage("Agent", subagentType, "prompt"));
      process.exit(2);
    }

    if (tool_name === "SendMessage") {
      // Step 6: SendMessage has no subagent_type — apply the total rule
      // directly to `message`, only when it is plausibly a work-assignment
      // (non-empty string). No semantic classification beyond that.
      const message = tool_input.message;
      if (typeof message !== "string" || message.trim().length === 0) {
        appendDebug({
          ts: new Date().toISOString(), event: "allow_sendmessage_not_workassignment",
          tool_name,
        });
        process.exit(0);
      }

      const signal = hasCompletenessSignal(message);
      appendDebug({
        ts: new Date().toISOString(), event: signal.ok ? "allow" : "block",
        tool_name, via: signal.via, detail: signal.detail,
      });

      if (signal.ok) {
        process.exit(0);
      }

      process.stderr.write(buildBlockMessage("SendMessage", null, "message"));
      process.exit(2);
    }

    // Unreachable (dispatch guard above), but fail-open defensively.
    process.exit(0);
  } catch (internalErr) {
    // Any internal exception during classification -> fail-open + log.
    appendDebug({
      ts: new Date().toISOString(), event: "fail_open",
      reason: "internal_exception", message: String(internalErr && internalErr.message || internalErr),
    });
    process.exit(0);
  }
}

// Top-level guard: if main() throws unexpectedly, fail-open (exit 0) so a
// bug in this hook can never deadlock delegation. See "FAIL-OPEN POLICY"
// header comment for why this is deliberate, not an oversight.
if (require.main === module) {
  try {
    main();
  } catch (topErr) {
    try {
      appendDebug({
        ts: new Date().toISOString(), event: "fail_open",
        reason: "top_level_exception", message: String(topErr && topErr.message || topErr),
      });
    } catch (_) {}
    process.exit(0);
  }
}
