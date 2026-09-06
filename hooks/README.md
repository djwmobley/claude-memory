# hooks/

This directory is the **source of truth** for Claude Code hooks used in this
project. The live deploy target is `~/.claude/hooks/`.

claude-memory ships **memory-contract hooks only** — hooks that wire the
`/handoff:*` session-seam lifecycle (loader-hook on `SessionStart`, and any
future `SessionEnd`/session-lifecycle wiring). Agent-dispatch guards and
independence rules (blind-spot/adversary floors, PR-authorship independence,
and the judge docket) now live in the public
[djwmobley/judge](https://github.com/djwmobley/judge) repo, installed there
by that repo's install-guards script. See that repo for setup and behavior.

---

## Files

| File | Description |
|---|---|
| `hooks.json` | Plugin-manifest hook registration. Currently wires `SessionStart` to `scripts/handoff.js loader-hook`. |

---

## Editing workflow

1. Edit the hook source here in `hooks/`.
2. Run the sync script to deploy to the live hooks dir:
   `node scripts/sync-hooks.js`
3. Restart Claude Code so the updated hook is picked up.

Do **not** edit `~/.claude/hooks/` directly. Changes there are untracked and will
be overwritten by the next `sync-hooks` run.

---

## Why copy instead of symlink?

Windows symlink creation requires elevated privileges or Developer Mode. Using
`fs.copyFileSync` in `scripts/sync-hooks.js` is reliable across all Windows
configurations without special permissions.

---

## Out-of-scope hooks

`bash-powershell-guard.js` is also deployed to `~/.claude/hooks/` but has no
test suite. It is intentionally excluded from this directory until a test suite
exists. `scripts/sync-hooks.js` is written generically (copies all
`hooks/*.js` except `*.test.js`) so adding it later is drop-in.
