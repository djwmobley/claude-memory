"use strict";
// sync-hooks.js
// Deterministic deploy script: copies every hooks/*.js file (excluding *.test.js)
// from the repo's hooks/ directory into ~/.claude/hooks/.
//
// Usage:  node scripts/sync-hooks.js
//
// - Idempotent: safe to run repeatedly; does not delete anything in the target dir.
// - Exits non-zero if any copy fails.
// - Does NOT auto-run; this is a manual operator step after editing hook sources.

const fs   = require("fs");
const path = require("path");
const os   = require("os");

const REPO_ROOT   = path.resolve(__dirname, "..");
const HOOKS_SRC   = path.join(REPO_ROOT, "hooks");
const HOOKS_DEST  = path.join(os.homedir(), ".claude", "hooks");

// Ensure the destination directory exists (it should already; created by Claude Code).
if (!fs.existsSync(HOOKS_DEST)) {
  console.error(`ERROR: destination directory does not exist: ${HOOKS_DEST}`);
  console.error("Create it manually or verify your Claude Code installation.");
  process.exit(1);
}

// Enumerate all *.js files in hooks/ that are NOT test files.
let entries;
try {
  entries = fs.readdirSync(HOOKS_SRC);
} catch (err) {
  console.error(`ERROR: could not read hooks directory ${HOOKS_SRC}: ${err.message}`);
  process.exit(1);
}

const hookFiles = entries.filter(
  (f) => f.endsWith(".js") && !f.endsWith(".test.js")
);

if (hookFiles.length === 0) {
  console.log("No hook files found to copy.");
  process.exit(0);
}

let anyFailed = false;

for (const file of hookFiles) {
  const src  = path.join(HOOKS_SRC, file);
  const dest = path.join(HOOKS_DEST, file);
  try {
    fs.copyFileSync(src, dest);
    console.log(`Copied: ${src} → ${dest}`);
  } catch (err) {
    console.error(`ERROR: failed to copy ${src} → ${dest}: ${err.message}`);
    anyFailed = true;
  }
}

if (anyFailed) {
  process.exit(1);
}

console.log(`Done. ${hookFiles.length} hook(s) deployed to ${HOOKS_DEST}`);
console.log("Restart Claude Code to pick up the updated hook(s).");
