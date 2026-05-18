# hooks/

This directory is the **source of truth** for Claude Code PreToolUse hooks used in
this project. The live deploy target is `~/.claude/hooks/`.

---

## Files

| File | Description |
|---|---|
| `pr-independence.js` | PreToolUse hook enforcing the two-agent PR-independence rule. Exports `scrubDataRegions` for unit-test isolation. |
| `pr-independence.test.js` | 15-test suite (node:test / node:assert/strict) covering the zero-false-negative scrubbing guarantee and detection logic. |

---

## Editing workflow

1. Edit the hook source here in `hooks/`.
2. Run the tests: `node hooks/pr-independence.test.js`
3. Run the sync script to deploy to the live hooks dir:
   `node scripts/sync-hooks.js`
4. Restart Claude Code so the updated hook is picked up.

Do **not** edit `~/.claude/hooks/` directly. Changes there are untracked and will
be overwritten by the next `sync-hooks` run.

---

## Why copy instead of symlink?

Windows symlink creation requires elevated privileges or Developer Mode. Using
`fs.copyFileSync` in `scripts/sync-hooks.js` is reliable across all Windows
configurations without special permissions.

---

## Running the tests

```
node hooks/pr-independence.test.js
```

All 15 tests should pass. The suite requires Node 18+ (uses `node:test` and
`node:assert/strict` built-ins); Node 22 is available in this repo's CI.

---

## Live wiring

The hook is registered in `.claude/settings.local.json` as a PreToolUse Bash
hook. The relevant entry is:

```
"Bash(node C:/Users/djwmo/.claude/hooks/pr-independence.js)"
```

The hook reads the tool-use event JSON from stdin and exits 0 (allow) or 2
(block) based on the two-agent PR-independence rule.

---

## Out-of-scope hooks

`bash-powershell-guard.js` is also deployed to `~/.claude/hooks/` but has no
test suite. It is intentionally excluded from this directory until a test suite
exists. `scripts/sync-hooks.js` is written generically (copies all
`hooks/*.js` except `*.test.js`) so adding it later is drop-in.
