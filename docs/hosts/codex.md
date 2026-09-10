# Codex CLI host

claude-memory runs under the [OpenAI Codex CLI](https://github.com/openai/codex)
as well as Claude Code. This page is the canonical reference for the Codex
install: exactly what it writes and where, hook wiring and trust, timeouts,
registration states, environment variables, and uninstall/repair. For a
guided first run, start at
[codex-quickstart.md](codex-quickstart.md). For day-to-day usage and known
defects, see [codex-howto.md](codex-howto.md).

Codex has no slash-command surface, so there is no `/handoff:*` equivalent
under Codex — everything below is MCP tools and hooks. (A companion PR adds
`~/.agents/skills` entries that give Codex a skill-based approximation of the
slash commands — see the "Skills (shipping in the companion PR)" section
below.)

Verified against codex-cli 0.153.4 (2026-09-09/2026-09-10) except where noted
in the [Verified vs. unverified](#verified-vs-unverified) table.

---

## Prerequisites

Same substrate as the Claude Code host — Codex adds no new infrastructure
requirement:

- **Node.js** (to run `scripts/install.js` and `scripts/handoff.js`).
- **PostgreSQL** with the `vector` extension, reachable from this machine.
  See [PREREQS.md](../../PREREQS.md).
- **vLLM** (or another embedding provider), optional. Without one, embeddings
  are disabled and the engine still writes and reads all rows — assertions
  and decisions just keep `embedding` NULL, and hybrid search falls back to
  FTS-only ranking for those rows (see
  [codex-howto.md § Degraded modes](codex-howto.md#degraded-modes)).
- **The `codex` CLI itself**, on `PATH`, already authenticated.

## Install

```
node scripts/install.js --host codex
```

Use `--dry-run` first to preview both steps below (MCP registration and the
hooks.json diff) without writing anything.

This does two things, neither of which touches `~/.claude/`:

### 1. MCP server registration

The installer looks for a working `codex` executable on `PATH` (Windows:
`PATH` + `PATHEXT` resolution, confirmed with a synchronous `codex --version`
probe). If found, it runs:

```
codex mcp add handoff --env HANDOFF_PROMOTION_FILE=AGENTS.md -- node <this-checkout>/scripts/handoff-mcp.mjs
```

so Codex can call the `handoff_*` MCP tools directly. `handoff` is the exact,
case-sensitive server name (`MCP_SERVER_NAME` in `scripts/lib/codex-install.js`)
the installer checks for and writes.

**`codex mcp add` rewrites Codex's entire `config.toml`** (key order, array
formatting, and any hand-edited comments are not guaranteed to survive) and
will **silently overwrite** an existing server already registered under the
name `handoff`. To protect against that, the installer backs up
`${CODEX_HOME:-~/.codex}/config.toml` first, whenever one already exists, to:

```
config.toml.bak-<YYYYMMDDTHHMMSS>-<epochMs>-<pid>-<seq>
```

(the trailing sequence number disambiguates two backups requested within the
same process). No backup is written when there is no pre-existing
`config.toml` — there is nothing to protect.

After the `add`, the installer re-verifies registration by calling
`codex mcp get handoff --json` and checking that the returned entry actually
names this checkout's `handoff-mcp.mjs`. If that check is inconclusive (see
[Registration states](#registration-states) below), the installer refuses
rather than reporting a false success.

If `codex` isn't found on `PATH`, the installer prints the exact `codex mcp
add …` command above, plus the equivalent `config.toml` stanza, to run or
paste by hand once `codex` is installed:

```toml
[mcp_servers.handoff]
command = "node"
args = ["<this-checkout>/scripts/handoff-mcp.mjs"]

[mcp_servers.handoff.env]
HANDOFF_PROMOTION_FILE = "AGENTS.md"
```

### 2. Hook wiring

The installer writes two entries into
`${CODEX_HOME:-~/.codex}/hooks.json` (**user scope only** — Codex's
project-scope `.codex/hooks.json` is known-buggy upstream, so the installer
never writes there):

- **SessionStart** (`matcher: "startup|resume"`) →
  `node <engine> loader-hook --host codex`
- **SessionEnd** (no matcher) →
  `node <engine> loader-stop --host codex`

Both entry points accept `--host codex` and validate it (an unrecognized
`--host` value is a refusal, never silently ignored) — the flag itself has no
other effect on their behavior beyond that validation; it exists so the
Codex-scope `hooks.json` and the Claude-scope `settings.json` can each carry
their own entry for the same underlying `handoff.js` without either install
path clobbering the other's. Re-running the installer diffs the existing
`hooks.json` against what it would write and only touches an entry that is
not already ours (see `scripts/install.js`'s anchored identity regex,
`OURS_RE`), so a second run is a no-op, not a duplicate entry.

`CODEX_HOME` is honored if set (must resolve to an absolute, writable path);
otherwise `~/.codex` is used.

---

## Trust

Codex gates hook execution behind two **separate** prompts, in this order:

1. **Directory trust** — the first time you open this project directory in
   Codex, it asks whether to trust the directory at all. This is unrelated to
   hooks and happens regardless of whether `hooks.json` has any entries.
2. **Hooks review** — on TUI startup, if `hooks.json` has content Codex
   hasn't seen before, it shows "Hooks can run outside the sandbox after you
   trust them" and requires "Trust all and continue" before any hook in the
   file executes for that session.

Trust is keyed by a **per-hook content hash**. Editing `hooks.json` (by
hand, or by re-running the installer with a changed engine path) changes the
hash and requires re-trusting — there is no partial-trust or "trust this one
hook" path.

`codex exec` (non-interactive/scripted invocation) never shows the TUI
review, so hooks there require `--dangerously-bypass-hook-trust` or they
silently do not run. There is no CLI or `config.toml` setting that grants
persistent trust outside the interactive review — installing claude-memory
does not itself trust anything; the review still runs on the developer's next
interactive session with fresh eyes.

---

## Timeouts

Codex **clamps SessionEnd hook execution to 3 seconds**, regardless of any
timeout value configured in `hooks.json`. The `loader-stop --host codex` path
this project wires does a small, bounded Postgres transaction (on the order
of half a dozen short statements: mark the session's `session_in_progress`
marker resolved, check for an explicit close already recorded, write the
implicit-close outcome if not) — it is designed to fit inside that budget on
a healthy local Postgres, but it is a real constraint on a slow or remote
database: if the 3-second clamp is hit mid-transaction, treat the implicit
close as unreliable for that session and confirm state with `handoff_status`
before trusting it.

SessionStart has no such clamp in the sources this integration was built
from; treat that difference as intentional, not an oversight.

---

## Registration states

`codex mcp get handoff --json` is the installer's (and your) way to check
current registration state. The installer's classification:

| Observed | Meaning | Installer action |
|---|---|---|
| Nonzero exit | Not registered | Proceeds to `mcp add` |
| Zero exit, `handoff` present, `enginePath` matches this checkout | Already registered, correct | Skips re-add, reports `[OK] … skipping` |
| Zero exit, `handoff` present, `enginePath` points elsewhere | Registered to a different checkout | Backs up `config.toml`, re-runs `mcp add` to repoint it here |
| Zero exit but output doesn't parse, or `get` itself errors ambiguously | Indeterminate | Refuses — never guesses; prints the raw output for you to resolve by hand |

This exact-word / whole-token matching on the server name (`isHandoffToken`)
is intentional: a server named e.g. `handoff-staging` must never be treated
as a match for `handoff`.

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

A companion PR renders a Codex-flavored `AGENTS.md` template (MCP tool hints,
correct key paths) via `--force-promotion`; that template's shape is not
covered here — see that PR's own docs when it lands.

---

## Environment variables

| Variable | Set by | Effect |
|---|---|---|
| `HANDOFF_PROMOTION_FILE` | Installer, on the MCP server's own env (`HANDOFF_PROMOTION_FILE=AGENTS.md`) | Durable-facts target file for promote/init/close-promotion. Set it yourself if invoking `handoff.js` directly outside the MCP server. |
| `HANDOFF_HOST` | Companion PR (skills install), set on the MCP server's env | Declares the host to the engine explicitly. *(shipping in the companion PR)* |
| `CODEX_HOME` | You, in your shell | Overrides `~/.codex` as the root for `config.toml` and `hooks.json`. Must be an absolute, writable path or the installer refuses. |
| `HANDOFF_CODEX_BIN` | You, in your shell | Overrides the `codex` binary the installer/engine discover and invoke, instead of searching `PATH`/`PATHEXT`. Use this when `codex` isn't the name of your binary or isn't on `PATH`. |
| `HANDOFF_CODEX_SKILLS_DIR` | You, in your shell | Overrides `~/.agents/skills` as the install target for the Codex skill set. *(shipping in the companion PR)* |
| `CODEX_THREAD_ID` | Codex itself, per session | The session identity the engine resolves against when `CLAUDE_CODE_SESSION_ID` is absent — see [Session identity](codex-howto.md#session-identity) in the how-to. |
| `PROJECT_ROOT` | You / a wrapper script | Overrides project-root detection for a direct `handoff.js` invocation. Not set automatically by Codex hooks — see the note below. |

**No `PROJECT_ROOT` in hook payloads.** Unlike some CI wrappers, Codex does
not inject `PROJECT_ROOT` into the hook's environment — the engine resolves
the project root from the hook process's current working directory instead.
If you invoke `loader-hook`/`loader-stop` from a wrapper that changes `cwd`,
set `PROJECT_ROOT` explicitly to avoid resolving the wrong project.

---

## Skills (shipping in the companion PR)

A companion PR installs a Codex skill set into `~/.agents/skills` (override
via `HANDOFF_CODEX_SKILLS_DIR`; `--force-skills` to overwrite): a `handoff`
dispatcher (bare invocation runs `handoff_status` and lists sub-skills — it
never closes on its own), plus `handoff-status`, `handoff-resume`,
`handoff-checkpoint`, `handoff-close`, `handoff-query`, `handoff-init`, and
`handoff-promote`. Each managed skill file carries a hash marker so the
installer can tell a managed file from a hand-edited one, and warns about
stale `source-command-handoff-*` skills left over from Codex's own
auto-migration (see
[Known real-world defects and quirks](codex-howto.md#known-real-world-defects-and-quirks)
in the how-to). *(shipping in the companion PR — not present in this repo's
current `main` at the time this page was written.)*

---

## Manual fallback (hooks disabled)

If you run Codex with hooks disabled, trust denied, or just want to drive
the engine by hand, call the MCP tools directly instead of relying on the
hooks:

- `handoff_resume` — load prior context (equivalent of the SessionStart hook,
  run on demand).
- `handoff_checkpoint` — mid-session save without ending the session.
- `handoff_close` — end-of-session extraction (equivalent of the SessionEnd
  hook, run on demand — an implicit close from the hook path only happens
  automatically when the hook itself is wired, trusted, and firing).

See [docs/mcp-tools.md](../mcp-tools.md) for the full MCP tool reference and
[codex-howto.md](codex-howto.md) for a walked-through working day.

---

## Uninstall / repair

There is no dedicated `--uninstall` flag. To remove or repair a Codex
install by hand:

1. **MCP registration** — edit `${CODEX_HOME:-~/.codex}/config.toml` and
   delete the `[mcp_servers.handoff]` and `[mcp_servers.handoff.env]`
   sections, or run `codex mcp add handoff …` again pointed at a different
   checkout to repoint it. Restore a prior `config.toml.bak-*` file to roll
   back a bad registration.
2. **Hooks** — edit `${CODEX_HOME:-~/.codex}/hooks.json` and remove the
   `loader-hook --host codex` / `loader-stop --host codex` entries under
   `SessionStart`/`SessionEnd`. Re-running the installer's `--dry-run` shows
   you exactly which lines it considers "ours" before you touch anything by
   hand.
3. **Re-run to repair** — `node scripts/install.js --host codex` again is
   idempotent: it re-verifies the MCP registration and re-diffs the hooks
   file, only writing what's missing or pointed at the wrong checkout.

Removing the MCP registration and hooks does not touch the Postgres project
database or `~/.claude/projects/<uuid>/handoff.md` — that data is host-
agnostic and survives switching hosts or reinstalling.

---

## Verified vs. unverified

| Claim | Status |
|---|---|
| `codex mcp add` command shape, env var, backup filename pattern | **Verified** in `scripts/lib/codex-install.js` source and against real codex-cli 0.153.4 behavior (2026-09-09/10). |
| Hooks review gate ("Trust all and continue"), directory-trust prompt ordering, per-hook content hash re-trust | **Verified** against real codex-cli 0.153.4. |
| `codex exec` requires `--dangerously-bypass-hook-trust` | **Verified** against real codex-cli 0.153.4. |
| SessionEnd hook 3-second clamp | **Verified** against real codex-cli 0.153.4. |
| `codex mcp get <name> --json` exists and returns parseable JSON | **Verified** against real codex-cli 0.153.4. |
| Hook payload fields (`session_id`, `hook_event_name`, `source`, `model`, `permission_mode`; SessionEnd `reason`) | **Verified** against real codex-cli 0.153.4. |
| `CODEX_THREAD_ID` present, `CLAUDE_CODE_SESSION_ID` absent, in a real Codex session env | **Verified** against real codex-cli 0.153.4. |
| Skills discovery path `~/.agents/skills/<name>/SKILL.md` | **Verified** against real codex-cli 0.153.4. |
| Windows `PATH`/`PATHEXT` resolution order for a real `codex.exe`/`codex.cmd` | **Unverified** — the installer's discovery logic was only exercised against a hand-written stub binary in this repo's test suite, never a real Windows Codex install. |
| Hook-invocation shell quoting on the real Codex host process | **Unverified beyond** Node's own `spawnSync`/`cmd.exe` behavior in this repo's tests — not confirmed against however Codex itself launches hook commands end-to-end. |
| Companion-PR skills/`HANDOFF_HOST`/`AGENTS.md` template behavior | **Not yet shipped on `main`** at the time this page was written — described above for forward reference only. |

Sources: https://learn.chatgpt.com/docs/extend/mcp,
https://learn.chatgpt.com/docs/hooks,
https://learn.chatgpt.com/docs/agent-configuration/agents-md,
`HANDOFF-INTEROP-REPORT-2026-09-09.md` and `CODEX-DISCOVERY-2026-09-10.md`
(local, untracked reports from a live Codex session against this repo).
