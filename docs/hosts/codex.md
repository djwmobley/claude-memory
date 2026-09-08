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

## Verified against docs, not the binary

No `codex` binary was installed on the machine this integration was authored
on. Everything above is implemented against the documented CLI/hooks/AGENTS.md
shapes, not verified against a real `codex` process. Treat the following as
unverified until someone runs it against a real install:

- The exact stdout/exit-code shape of `codex mcp get <name>` for an
  already-registered vs. absent server (this integration assumes: nonzero
  exit → absent, zero exit + `<name>` present in stdout as a whole word →
  registered — this is a reasonable but unverified reading of the CLI, since
  `codex mcp get` isn't documented in the sources this integration was built
  from).
- The real SessionStart/SessionEnd hook payload's exact field set and
  behavior on a live Codex session (the shapes here come from
  learn.chatgpt.com/docs/hooks, not from capturing a real payload).
- Windows PATH/PATHEXT resolution order for a real Codex install (the
  installer's discovery walks `PATH` + `PATHEXT` and confirms with a
  synchronous `codex --version` probe, but was only exercised against a
  hand-written stub binary, never a real `codex.exe`/`codex.cmd`).
- Hook-invocation shell quoting on a real Codex host process (validated
  against Node's own `spawnSync`/`cmd.exe` behavior in this repo's test
  suite, not against however Codex itself launches hook commands).

Sources: https://learn.chatgpt.com/docs/extend/mcp,
https://learn.chatgpt.com/docs/hooks,
https://learn.chatgpt.com/docs/agent-configuration/agents-md.
