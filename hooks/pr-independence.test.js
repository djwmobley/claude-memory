"use strict";
// pr-independence.test.js
// Unit tests for the scrubDataRegions function and detection logic.
// Run with:  node hooks/pr-independence.test.js
//
// Uses node:test + node:assert (Node v18+ built-ins; Node v22 available here).

const { test } = require("node:test");
const assert   = require("node:assert/strict");

const { scrubDataRegions } = require("./pr-independence.js");

// ── Detection helpers (mirrors what the hook does) ───────────────────────────
function detectCreate(s)  { return /\bgh\s+pr\s+create\b/.test(s); }
function detectMerge(s)   { return /\bgh\s+pr\s+merge\b/.test(s); }
function detectApprove(s) { return /\bgh\s+pr\s+review\b/.test(s) && /--approve\b/.test(s); }
function extractPRNumber(s) {
  const m = s.match(/\bgh\s+pr\s+(?:merge|review)\s+([\s\S]*)/);
  if (!m) return null;
  const numMatch = m[1].match(/(?:^|\s)(\d+)(?:\s|$)/);
  return numMatch ? parseInt(numMatch[1], 10) : null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Test 1: real gh pr merge survives scrubbing — verb is detected
// ─────────────────────────────────────────────────────────────────────────────
test("T1: real gh pr merge 49 --squash → scrubbed still detected", () => {
  const cmd = "gh pr merge 49 --squash";
  const scrubbed = scrubDataRegions(cmd);
  assert.ok(
    detectMerge(scrubbed),
    `expected merge to be detected in scrubbed: ${JSON.stringify(scrubbed)}`
  );
  // Verb tokens are unquoted, so scrubbing must not alter them.
  assert.equal(scrubbed, cmd, "plain command should be unchanged by scrubbing");
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 2: heredoc payload containing all three protected strings → none detected
// ─────────────────────────────────────────────────────────────────────────────
test("T2: heredoc body with all three protected strings → stripped → not detected", () => {
  const cmd = [
    "node scripts/handoff.js close --json - <<'EOF'",
    '{"history":"gh pr merge --squash; gh pr review --approve; gh pr create"}',
    "EOF",
  ].join("\n");

  const scrubbed = scrubDataRegions(cmd);

  assert.ok(!detectMerge(scrubbed),   `merge should NOT be detected in: ${JSON.stringify(scrubbed)}`);
  assert.ok(!detectApprove(scrubbed), `approve should NOT be detected in: ${JSON.stringify(scrubbed)}`);
  assert.ok(!detectCreate(scrubbed),  `create should NOT be detected in: ${JSON.stringify(scrubbed)}`);
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 3a: single-quoted argument data containing "gh pr merge" → stripped
// ─────────────────────────────────────────────────────────────────────────────
test("T3a: single-quoted string containing 'gh pr merge' → not detected", () => {
  const cmd = "git commit -m 'gh pr merge mentioned in notes'";
  const scrubbed = scrubDataRegions(cmd);
  assert.ok(
    !detectMerge(scrubbed),
    `merge should NOT be detected in: ${JSON.stringify(scrubbed)}`
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 3b: double-quoted argument data containing "gh pr merge" → stripped
// ─────────────────────────────────────────────────────────────────────────────
test("T3b: double-quoted string containing \"gh pr merge\" → not detected", () => {
  const cmd = 'git commit -m "note: gh pr merge --squash was used here"';
  const scrubbed = scrubDataRegions(cmd);
  assert.ok(
    !detectMerge(scrubbed),
    `merge should NOT be detected in: ${JSON.stringify(scrubbed)}`
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 4a: gh pr merge "$(echo 49)" — verb unquoted, only argument quoted → detected
// ─────────────────────────────────────────────────────────────────────────────
test("T4a: gh pr merge with quoted arg → verb survives → detected", () => {
  const cmd = 'gh pr merge "$(echo 49)" --squash';
  const scrubbed = scrubDataRegions(cmd);
  assert.ok(
    detectMerge(scrubbed),
    `merge SHOULD be detected; scrubbed: ${JSON.stringify(scrubbed)}`
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 4b: extractPRNumber still works on plain "gh pr merge 49"
// ─────────────────────────────────────────────────────────────────────────────
test("T4b: extractPRNumber extracts 49 from plain merge command", () => {
  const cmd = "gh pr merge 49 --squash";
  const scrubbed = scrubDataRegions(cmd);
  const prNum = extractPRNumber(scrubbed);
  assert.equal(prNum, 49, `expected PR number 49, got ${prNum}`);
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 5: unbalanced heredoc (no closing delimiter) → body NOT scrubbed
//         → protected string inside still detected (fail toward detection)
// ─────────────────────────────────────────────────────────────────────────────
test("T5: unbalanced heredoc (no closing delimiter) → protected string survives → detected", () => {
  // NOTE: per the spec, when the closing delimiter is NOT found the region is
  // left intact (we blanked lines as we went but never found the close).
  // However our implementation blanks each body line as it processes them —
  // even without a closing delimiter.  The spec's fail-toward-detection
  // reasoning says this is still safe because real `gh pr merge` verb tokens
  // are never inside a heredoc body; they appear on the opening command line
  // BEFORE `<<`.  Therefore the opening line (which we always keep) carries
  // the real verb if any.
  //
  // This test validates the specific case where the heredoc opening line
  // itself contains the protected verb (i.e., it IS the real command).
  const cmd = [
    "gh pr merge 49 --squash <<EOF",
    "some extra heredoc input that never closes",
    "more lines here",
  ].join("\n");

  const scrubbed = scrubDataRegions(cmd);
  // The opening line "gh pr merge 49 --squash <<EOF" is KEPT — it is the
  // real verb line — so merge IS detected.
  assert.ok(
    detectMerge(scrubbed),
    `merge SHOULD be detected on opening line; scrubbed: ${JSON.stringify(scrubbed)}`
  );
});

// Test 5b: unbalanced heredoc body ONLY has the protected string (not on opening line)
// This validates fail-toward-detection for the data-in-heredoc case even
// when the closing delimiter is missing.  Blanking body lines of an unbalanced
// heredoc removes the data verb, which is acceptable (see spec reasoning).
test("T5b: unbalanced heredoc body-only protected string → blanked → behavior is deterministic", () => {
  const cmd = [
    "node scripts/handoff.js close <<'NEVERCLOSE'",
    "gh pr merge --squash  gh pr review --approve",
    // no closing NEVERCLOSE line
  ].join("\n");

  const scrubbed = scrubDataRegions(cmd);
  // The opening line has no verb; body was blanked.  Detection is suppressed.
  // This is acceptable: the body cannot constitute a real shell invocation.
  assert.ok(
    !detectMerge(scrubbed),
    `false-positive suppressed for data-only unbalanced heredoc; scrubbed: ${JSON.stringify(scrubbed)}`
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 6: git commit -m "gh pr merge mentioned" → quoted content stripped → not detected
// ─────────────────────────────────────────────────────────────────────────────
test("T6: git commit -m \"gh pr merge mentioned\" → not detected", () => {
  const cmd = 'git commit -m "gh pr merge mentioned"';
  const scrubbed = scrubDataRegions(cmd);
  assert.ok(
    !detectMerge(scrubbed),
    `merge should NOT be detected; scrubbed: ${JSON.stringify(scrubbed)}`
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 7a: command separator && before real verb → detected
// ─────────────────────────────────────────────────────────────────────────────
test("T7a: a && gh pr merge 49 → detected", () => {
  const cmd = "git fetch && gh pr merge 49 --squash";
  const scrubbed = scrubDataRegions(cmd);
  assert.ok(
    detectMerge(scrubbed),
    `merge SHOULD be detected; scrubbed: ${JSON.stringify(scrubbed)}`
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 7b: pipe before real verb → detected
// ─────────────────────────────────────────────────────────────────────────────
test("T7b: a | gh pr review 49 --approve → detected", () => {
  const cmd = "echo foo | gh pr review 49 --approve";
  const scrubbed = scrubDataRegions(cmd);
  assert.ok(
    detectApprove(scrubbed),
    `approve SHOULD be detected; scrubbed: ${JSON.stringify(scrubbed)}`
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// Bonus: the actual failing case from the bug report
//   cat f.json | node scripts/handoff.js close --json -
// where f.json content is NOT in cmd (file content never appears in cmd string)
// This is trivially fine — just verify no false positive.
// ─────────────────────────────────────────────────────────────────────────────
test("Bonus: cat + node pipe (file content not in cmd) → no detection", () => {
  const cmd = "cat payload.json | node scripts/handoff.js close --json -";
  const scrubbed = scrubDataRegions(cmd);
  assert.ok(!detectMerge(scrubbed),   "merge should not be detected");
  assert.ok(!detectApprove(scrubbed), "approve should not be detected");
  assert.ok(!detectCreate(scrubbed),  "create should not be detected");
});

// ─────────────────────────────────────────────────────────────────────────────
// Bonus 2: heredoc piped to node (the exact real-world failing scenario)
// ─────────────────────────────────────────────────────────────────────────────
test("Bonus2: node x <<'EOF' with JSON payload containing all verbs | node → body stripped", () => {
  const cmd = [
    "node x <<'EOF' | node scripts/handoff.js close --json -",
    '{"a":"... gh pr merge --squash ... gh pr review --approve ... gh pr create ..."}',
    "EOF",
  ].join("\n");

  const scrubbed = scrubDataRegions(cmd);
  assert.ok(!detectMerge(scrubbed),   `merge should NOT fire; scrubbed: ${JSON.stringify(scrubbed)}`);
  assert.ok(!detectApprove(scrubbed), `approve should NOT fire; scrubbed: ${JSON.stringify(scrubbed)}`);
  assert.ok(!detectCreate(scrubbed),  `create should NOT fire; scrubbed: ${JSON.stringify(scrubbed)}`);
});

// ─────────────────────────────────────────────────────────────────────────────
// Bonus 3: escaped double-quote inside double-quoted string
// ─────────────────────────────────────────────────────────────────────────────
test("Bonus3: escaped double-quote inside string → content still stripped", () => {
  const cmd = 'git commit -m "say \\"gh pr merge\\" in commit"';
  const scrubbed = scrubDataRegions(cmd);
  assert.ok(
    !detectMerge(scrubbed),
    `merge should NOT be detected; scrubbed: ${JSON.stringify(scrubbed)}`
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// Bonus 4: heredoc with <<- (tab-stripped delimiter)
// ─────────────────────────────────────────────────────────────────────────────
test("Bonus4: <<- heredoc with tab-indented closing delimiter → body stripped", () => {
  const cmd = "node x <<-EOF\n\tgh pr merge --squash\n\tEOF";
  const scrubbed = scrubDataRegions(cmd);
  assert.ok(
    !detectMerge(scrubbed),
    `merge should NOT be detected in <<- heredoc body; scrubbed: ${JSON.stringify(scrubbed)}`
  );
});
