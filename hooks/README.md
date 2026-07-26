# hooks/

This directory is the **source of truth** for Claude Code PreToolUse hooks used in
this project. The live deploy target is `~/.claude/hooks/`.

---

## Files

| File | Description |
|---|---|
| `pr-independence.js` | PreToolUse hook enforcing the two-agent PR-independence rule. Exports `scrubDataRegions` for unit-test isolation. |
| `pr-independence.test.js` | 15-test suite (node:test / node:assert/strict) covering the zero-false-negative scrubbing guarantee and detection logic. |
| `agent-adversary-floor.js` | PreToolUse hook enforcing a blind-spot/completeness-clause-or-exemption-marker floor on subagent spawns. Exports `isExemptType` and `hasCompletenessSignal` for unit-test isolation. |
| `agent-adversary-floor.test.js` | 59-test suite (node:test / node:assert/strict) covering pattern detection, exemption-marker validation, exempt-type handling, and the fail-open contract. |

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
"Bash(node ~/.claude/hooks/pr-independence.js)"
```

The hook reads the tool-use event JSON from stdin and exits 0 (allow) or 2
(block) based on the two-agent PR-independence rule.

---

## Out-of-scope hooks

`bash-powershell-guard.js` is also deployed to `~/.claude/hooks/` but has no
test suite. It is intentionally excluded from this directory until a test suite
exists. `scripts/sync-hooks.js` is written generically (copies all
`hooks/*.js` except `*.test.js`) so adding it later is drop-in.

---

## `agent-adversary-floor.js`

### Purpose

A PreToolUse floor on the `Agent` tool (and, best-effort, `SendMessage` — see
"SendMessage coverage" below): a subagent spawn of a write-capable agent type
must carry either a blind-spot/completeness clause in its prompt (patterns
like "blind spot", "cannot detect", "pass but should", any `adversar*` stem,
etc.) or a literal `[adversary-exempt: <reason>]` marker with a non-empty,
non-whitespace reason. If neither is present, the spawn is BLOCKED with a
message naming the gap.

**All** `[adversary-exempt: ...]` markers in the text are found and validated,
not just the first — if the prompt contains more than one marker and ANY of
them has an empty or whitespace-only reason, that is treated as a malformed
exemption attempt and the call is BLOCKED, even if another marker in the same
text is well-formed or a blind-spot pattern also happens to appear elsewhere.
An attempted-but-broken exemption must fail loudly rather than being silently
absorbed by other grounds for allowing the call.

### What this hook deliberately CANNOT enforce

This is a floor against total omission, not a semantic quality gate:

- Boilerplate text that merely contains a matching phrase (e.g. "Report what
  this cannot detect.") pasted with zero actual adversarial thought behind it
  satisfies this hook completely. It checks for the *presence* of framing
  text, not its quality, not whether the subagent's answer was read, and not
  whether the orchestrator acted on it.
- It cannot confirm the subagent actually answered the blind-spot question,
  or that any answer given was true.
- Content routed around the scanned fields entirely (e.g. a prompt that says
  "see spec.md," with the real validation spec — and any adversary framing or
  its absence — living in a file this hook never reads) is invisible to it.
- A follow-up `SendMessage` that steers an already-compliant agent off-spec
  after its first turn is not re-checked; only the field checked at call time
  is evaluated.

The real control this hook backstops is the human/orchestrator practice of
adversary-before-author review — spending real adversarial effort against a
spec before implementing it, and reading what the subagent reports back. This
hook cannot verify that practice happened; it only makes it hard to forget to
*mention* it.

### Exemption marker

Form: `[adversary-exempt: <reason>]`. The reason must be non-empty after
trimming whitespace; an empty or whitespace-only reason does not satisfy the
requirement. Every marker occurrence in the text is validated (not just the
first) — see "Purpose" above.

### Exempt agent types

A closed, explicit list of agent types that are read-only *by tool grant*:
`Explore`, `Plan`, `claude-code-guide`, `plugin-dev:plugin-validator`,
`plugin-dev:skill-reviewer`. Any type not on this list — including
unknown/future agent types never seen before — defaults to write-capable and
is subject to the requirement. This is the deliberate safe-default direction:
a gap in the exempt set produces visible friction (a false BLOCK, immediately
correctable by adding the type or using the exemption marker), never a silent
bypass for a genuinely write-capable type.

### Fail-open policy

On any internal error (stdin read failure, JSON parse failure, missing/
malformed fields, unexpected exception), the hook ALLOWS the call through —
this hook gates the Agent tool itself, and a fail-closed bug here could
deadlock a session that depends on delegation to get work done. Every
fail-open event is still appended to the hook's own debug log so gaps remain
auditable.

### SendMessage coverage

The hook is written to apply the same rule to `SendMessage` calls (registered
via matcher `Agent|SendMessage`), on the basis that Claude Code's documented
PreToolUse contract does not carve out an exception for any particular tool
name. This has **not** been empirically confirmed to actually fire for
`SendMessage` in a live session — if a given harness build does not route
`SendMessage` through PreToolUse, that branch is simply dead code there: it is
never invoked, so it can never falsely block, and the `Agent`-tool coverage is
unaffected either way.

### Wiring

Like `pr-independence.js`, this hook is not auto-wired by this repo's plugin
manifest (`hooks/hooks.json`) — it is deployed to `~/.claude/hooks/` by
`scripts/sync-hooks.js` and then registered manually by the operator in their
own `~/.claude/settings.json`, e.g.:

```json
{
  "matcher": "Agent|SendMessage",
  "hooks": [
    { "type": "command", "command": "node ~/.claude/hooks/agent-adversary-floor.js" }
  ]
}
```

### Running the tests

```
node hooks/agent-adversary-floor.test.js
```

All tests should pass. The suite requires Node 18+ (uses `node:test` and
`node:assert/strict` built-ins); Node 22 is available in this repo's CI.
