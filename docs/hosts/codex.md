# Codex CLI host

claude-memory runs under the [OpenAI Codex CLI](https://github.com/openai/codex)
as well as Claude Code. This page covers the Codex-specific install, what it
writes and where, and the manual fallbacks for a setup that has hooks disabled.

Codex has no slash-command surface, so there is no `/handoff:*` equivalent
under Codex — everything below is MCP tools and hooks.

---

## Install

```
node scripts/install.js --host codex
```

This does two things, neither of which touches `~/.claude/`:

1. **Registers the MCP server** with the `codex` CLI (`codex mcp add handoff
   --env HANDOFF_PROMOTION_FILE=AGENTS.md -- node <this-checkout>/scripts/handoff-mcp.mjs`),
   so Codex can call the `handoff_*` MCP tools directly. If `codex` isn't
   found on `PATH`, the installer prints the exact command (and the
   equivalent `config.toml` stanza) to run or paste by hand once it is.
2. **Wires the SessionStart/SessionEnd hooks** into
   `${CODEX_HOME:-~/.codex}/hooks.json` (user scope only — Codex's
   project-scope `.codex/hooks.json` is known-buggy upstream), so context
   auto-loads at the start of a session and an implicit close is recorded at
   the end, the same way it does under Claude Code.

Use `--dry-run` first to preview both steps (MCP registration and the
hooks.json diff) without writing anything. `CODEX_HOME` is honored if set
(must be an absolute, writable path).

---

## AGENTS.md, not CLAUDE.md

Codex's durable-facts file is `AGENTS.md`, not `CLAUDE.md` — the MCP
registration above sets `HANDOFF_PROMOTION_FILE=AGENTS.md` on the server
process, so every `handoff_init` / `handoff_close` (with promotion
confirmed) / `handoff_promote` call under Codex reads from and writes to
`AGENTS.md` instead. Codex reads `AGENTS.md` from the git root down to the
current working directory, capped at `project_doc_max_bytes` (32 KiB by
default) — keep the durable-facts section well under that cap, the same
discipline as `CLAUDE.md` under Claude Code.

If you run `handoff.js` directly (not through the MCP server) and want the
same behavior, set `HANDOFF_PROMOTION_FILE=AGENTS.md` in that process's
environment yourself.

---

## Hook wiring

The hooks.json entries this installer writes:

- **SessionStart** (`matcher: "startup|resume"`) → `node <engine> loader-hook --host codex`
- **SessionEnd** (no matcher) → `node <engine> loader-stop --host codex`

Both entry points accept `--host codex` and validate it (an unrecognized
`--host` value is a refusal, never silently ignored) — the flag itself has no
other effect on their behavior beyond that validation; it exists so the
Codex-scope hooks.json and the Claude-scope settings.json can each carry
their own entry for the same underlying `handoff.js` without either
install path clobbering the other's.

---

## Hook trust (interactive vs. `codex exec`)

Codex gates hook execution behind a one-time trust prompt. In an interactive
session, the first run after hooks.json is written prompts you to trust it;
accept once and every subsequent session honors it automatically.

Non-interactive invocations (`codex exec`, CI, or anything scripted) do
**not** show that prompt — and, verified against a real codex-cli 0.153.4
run, an untrusted hooks.json is silently skipped in that mode rather than
refused or logged. If SessionStart/SessionEnd don't appear to be firing under
`codex exec`, this is the first thing to check: either trust hooks
interactively first, or pass `--dangerously-bypass-hook-trust` to the `codex
exec` invocation. This is not a feature flag — `codex features list` reports
hooks as stable regardless of trust state — it is purely a runtime gate on
whether an already-configured hook fires.

---

## SessionEnd's 3-second timeout clamp

Codex clamps a SessionEnd hook's execution to 3 seconds regardless of the
`timeout` value configured in hooks.json, printing `warning: clamping
SessionEnd hook timeout to 3s` when it does. This is a hard Codex-side limit,
not something this installer can raise.

loader-stop's SessionEnd work is a handful of small local Postgres statements
plus one atomic file write — comfortably inside that budget on a local
database. This is a documented constraint to design around (keep
SessionEnd-path work cheap), not a bug to fix by restructuring loader-stop
into something asynchronous.

---

## `codex mcp add` rewrites the whole config.toml

Verified against a real codex-cli 0.153.4 run: `codex mcp add <name> ...`
always rewrites `${CODEX_HOME:-~/.codex}/config.toml` in its entirety — key
order, array formatting, and even integer-vs-float rendering on entries
unrelated to `<name>` can all shift. It is never a targeted, minimal patch,
and this holds even when `<name>` is already registered (it silently
overwrites the existing entry rather than refusing).

Because of this, the installer backs up config.toml immediately before every
`add` it runs, as `config.toml.bak-<timestamp>-<pid>-<seq>` alongside the
original — skipped (with a printed reason, not silently) only when no
config.toml exists yet to protect. If you ever need to undo an `mcp add`
some other tool performed, restore from the newest matching backup.

---

## No `PROJECT_ROOT` env in hooks — cwd resolution instead

Codex does not inject a `PROJECT_ROOT` (or any project-identifying) variable
into the hook's environment — verified against real SessionStart/SessionEnd
invocations. The engine resolves the project root from the hook process's
current working directory instead, which is the correct and already-working
behavior; no adapter change was needed here, this is just confirming the
assumption held.

Real hook payload field sets, captured from a live session (do not assume
Claude Code's own field set is a superset or subset of these):

```
SessionStart:
{"session_id": "...", "hook_event_name": "SessionStart", "model": "...",
 "permission_mode": "...", "source": "startup", ...}

SessionEnd:
{"session_id": "...", "hook_event_name": "SessionEnd", "reason": "other", ...}
```

---

## MCP registration states

`node scripts/install.js --host codex` classifies the current registration
state (via `codex mcp get handoff --json`, with a plain-text fallback if
`--json` isn't supported by the installed `codex` version) into exactly one
of:

- **REGISTERED** — already points at this checkout; nothing to do.
- **REGISTERED_UNVERIFIED** — found via the plain-text fallback only; the
  command/args path could not be verified structurally, but the name is
  present and not reported as unknown. Treated as done, with a note printed.
- **NEEDS_REPAIR** — registered, but pointing at a different checkout (e.g.
  after moving or re-cloning the repo). The installer backs up config.toml
  and re-runs `codex mcp add` to repoint it, then re-verifies.
- **NOT_REGISTERED** — no entry under this name. The installer registers it.
- **UNKNOWN** — an unrecognized shape (unparseable output, an entry whose own
  `name` field disagrees, or any other output this installer doesn't
  recognize). The installer aborts rather than guessing — `codex mcp add` is
  never run from this state — and prints the raw `codex` output for you to
  diagnose.
- **NOT_INSTALLED** — the `codex mcp get` invocation itself failed to spawn.
  The installer aborts with the manual fallback instructions below.

After a real `mcp add` runs (from NOT_REGISTERED or NEEDS_REPAIR), the
installer always re-checks that it actually landed. If that re-check still
doesn't come back REGISTERED (or REGISTERED_UNVERIFIED), the installer
refuses with exit code 1 and prints the config.toml backup path so you can
compare or restore.

---

## Manual fallback (hooks disabled)

If you run Codex with hooks disabled, or just want to drive the engine by
hand, call the MCP tools directly instead of relying on the hooks:

- `handoff_resume` — load prior context (equivalent of the SessionStart hook,
  run on demand).
- `handoff_checkpoint` — mid-session save without ending the session.
- `handoff_close` — end-of-session extraction (equivalent of the SessionEnd
  hook, run on demand — an implicit close from the hook path only happens
  automatically when the hook itself is wired and firing).

See [docs/mcp-tools.md](../mcp-tools.md) for the full MCP tool reference.

---

## Verification status

This integration was originally authored against docs only, with no `codex`
binary available. As of 2026-09-09 the facts in the sections above (the
`codex mcp get --json` output shape and its registration states, the hook
trust gate, the SessionEnd 3s timeout clamp, `codex mcp add`'s whole-file
config.toml rewrite, the absence of a `PROJECT_ROOT` env var in hooks, and
the real SessionStart/SessionEnd payload field sets) were verified against a
real codex-cli 0.153.4 process. Still unverified — treat as unconfirmed until
exercised against those specific conditions:

- Behavior on a different `codex-cli` version than 0.153.4 — wording, exit
  codes, or JSON field names could still change across releases; the
  `--json`-unsupported plain-text fallback path exists specifically to
  degrade gracefully if a future/older version drops or never had `--json`.
- The interactive hook-trust confirmation flow itself (only the
  non-interactive `codex exec` skip-when-untrusted behavior was exercised
  directly).
- Real-world side effects of `codex mcp add`'s whole-file rewrite on a
  config.toml with a large or unusual set of pre-existing entries beyond
  what this repo's own test fixtures cover.
- Windows PATH/PATHEXT resolution order against a real `codex.exe`/`codex.cmd`
  install (the discovery logic was exercised against a hand-written stub
  binary that mimics the expected shape, not a real Codex installer).

Sources: https://learn.chatgpt.com/docs/extend/mcp,
https://learn.chatgpt.com/docs/hooks,
https://learn.chatgpt.com/docs/agent-configuration/agents-md.
