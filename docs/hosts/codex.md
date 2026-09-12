# Codex CLI host

claude-memory runs under the [OpenAI Codex CLI](https://github.com/openai/codex)
as well as Claude Code. This page is the canonical reference for the Codex
install: exactly what it writes and where, hook wiring and trust, timeouts,
registration states, environment variables, and uninstall/repair. For a
guided first run, start at
[codex-quickstart.md](codex-quickstart.md). For day-to-day usage and known
defects, see [codex-howto.md](codex-howto.md).

Codex has no slash-command surface, so there is no `/handoff:*` equivalent
under Codex — the installer's [Skills](#skills) step gives Codex a
skill-based approximation instead, alongside the MCP tools and hooks
documented throughout this page.

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

Use `--dry-run` first to preview all three steps below (MCP registration,
the hooks.json diff, and the skill-install classification) without writing
anything.

This does three things, none of which touch `~/.claude/`:

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

### 3. Skill install

The installer also writes 8 skill files into `~/.agents/skills`
(`HANDOFF_CODEX_SKILLS_DIR` if set — must be an absolute path) — see
[Skills](#skills) below for the full list, the managed-by marker/hash
scheme, and `--force-skills`.

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

## Non-interactive approval for MCP tools

Observed 2026-09-12, under an approval policy of `never`: a scripted
`codex exec` run rejected `usage_query` ("MCP tool call requires approval,
but approval policy is never") — `usage_query` had no
`[mcp_servers.handoff.tools.usage_query]` sub-table in `config.toml` at that
point — while `handoff_status`, which DOES have an explicit
`approval_mode = "approve"` entry, ran without prompting. That is the full
extent of what was observed: two tools, two outcomes, one config
difference (entry present vs. absent).

**Do not read more into this than the observation supports.** In
particular, this project's own `readOnlyHint` tool annotation (see
`scripts/handoff-mcp.mjs`) is NOT known to be what Codex's approval engine
keys on — no test here has isolated `readOnlyHint` as a variable, and at
the time of this observation `usage_query` and `handoff_status` also
differed in whether they had a `config.toml` entry at all, which is a
confound this project has not controlled for. Codex's own documentation
describes both a server-level default approval behavior and a per-tool
`approval_mode` value of `"writes"` (distinct from `"approve"`) as parts of
its approval model; whether either of those, rather than the tools.\*
entry's mere presence, explains the reject/allow split above has not been
verified against Codex's source or a controlled test in this project.

**What was actually observed, exactly, and nothing more:** `usage_query`
with no `tools.*` entry was rejected under an approval policy of `never`;
`handoff_status` with an `approval_mode = "approve"` entry ran without
prompting. That is the whole experiment — two tools, two configs, two
outcomes. The `usage_query` stanza below is the direct counterfactual for
the exact case that was rejected (same tool, same config difference, other
direction) — it was not, itself, separately run and confirmed to succeed.
The `usage_record` stanza below is weaker still: `usage_record` was not
part of this experiment in either configuration. It is included here
expected by symmetry with `usage_query` and `handoff_status` — both write
paths, both plausibly needing the same `approval_mode = "approve"` entry —
not because it was separately observed to work.

The stanza shape, one sub-table per tool:

```toml
[mcp_servers.handoff.tools.usage_query]
approval_mode = "approve"

[mcp_servers.handoff.tools.usage_record]
approval_mode = "approve"
```

**Add these by editing `config.toml` directly, never via `codex mcp add`.**
`codex mcp add` rewrites the entire `[mcp_servers.handoff]` block from its
own flags and has no flag for a `tools.*` sub-table — running it after
hand-adding these entries silently deletes them (same underlying behavior as
the `config.toml` clobber noted in
[Known real-world defects and quirks](codex-howto.md#known-real-world-defects-and-quirks),
item 4, in the how-to page). If you must re-run `codex mcp add` for another
reason (a changed engine path, say), re-add the `tools.*` sub-tables
afterward.

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

The installer itself writes `"timeout": 3` for this hook (never 30, the
Claude-path convention) so the config file's number matches what Codex
actually enforces — including when it upgrades a legacy entry from an older
install that had written 30.

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
| Zero exit, entry registered via an HTTP/SSE `url` transport | Not something this installer can manage (it only writes a stdio `node` command) | Reported the same way as "registered to a different checkout" — backs up and re-runs `mcp add` |
| Zero exit, `enginePath` matches, but the entry's `HANDOFF_HOST` env var is set to something other than `codex` | Registered but misrouted | Backs up `config.toml`, re-runs `mcp add` to repoint it |

This exact-word / whole-token matching on the server name (`isHandoffToken`)
is intentional: a server named e.g. `handoff-staging` must never be treated
as a match for `handoff`.

**Real `codex mcp get --json` output nests `command`/`args`/`url`/`type`/`env`
under a `transport` object** (e.g. `{"transport":{"type":"stdio","command":
"node","args":[...]}}`), rather than at the entry's top level. The installer
reads `entry.transport` when it's a usable object (carries at least one of
`command`/`args`/`url`/`type` — an empty `transport: {}` is ignored and every
field falls back to the entry's top level); when both `entry.command` and
`transport.command` are present and disagree, `transport`'s value wins. Args
may also arrive as a single whitespace-joined string instead of an array
(both are handled), and a `cmd /c node <enginePath>` shell-wrapper command is
unwrapped before the node/engine-path check runs.

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

`handoff.js init` renders a Codex-flavored `AGENTS.md` from
`templates/project-agents-md.tpl` the first time it writes the promotion
file — project name/description, an MCP tool-call cheatsheet
(`mcp__handoff__*` tool names), the same host-agnostic Key-paths marker
section `CLAUDE.md` carries, and a durable-facts placeholder.

**Host selection:** `HANDOFF_HOST` wins if set (must be exactly `claude` or
`codex` — any other value is a hard error); otherwise the host is inferred
from the promotion filename's basename (`AGENTS.md` -> codex, anything else
-> claude). The Codex adapter always passes `HANDOFF_HOST=codex` on the MCP
server's own environment, so a fresh `handoff_init` call under Codex renders
`AGENTS.md` correctly even if the promotion-filename argument were ever
omitted.

**Regenerating a bad `AGENTS.md`:** if an existing `AGENTS.md` looks like a
hand-made find-and-replace copy of the old Claude template (it contains the
literal text `~/.Codex/` or a `# Codex-memory` heading), `init` prints a
warning suggesting `--force-promotion` but does not overwrite it
automatically. `--force-promotion` backs up the existing file
(`AGENTS.md.bak-<epochMs>-<hrtime>-<pid>`) and unconditionally regenerates it
from the current template — use it for that stale-copy case, or any time you
want a clean re-render regardless of cause.

---

## Environment variables and flags

| Variable / flag | Set by | Effect |
|---|---|---|
| `HANDOFF_PROMOTION_FILE` | Installer, on the MCP server's own env (`HANDOFF_PROMOTION_FILE=AGENTS.md`) | Durable-facts target file for promote/init/close-promotion. Set it yourself if invoking `handoff.js` directly outside the MCP server. |
| `HANDOFF_HOST` | Installer, on the MCP server's own env (`HANDOFF_HOST=codex`) | Selects which promotion-file template `handoff.js init` renders on a fresh write: must be exactly `claude` or `codex` (any other value is a hard error). Unset falls back to inferring the host from the promotion filename's basename. See [AGENTS.md, not CLAUDE.md](#agentsmd-not-claudemd) above. |
| `CODEX_HOME` | You, in your shell | Overrides `~/.codex` as the root for `config.toml` and `hooks.json`. Must be an absolute, writable path or the installer refuses. |
| `HANDOFF_CODEX_BIN` | You, in your shell | Overrides the `codex` binary the installer/engine discover and invoke, instead of searching `PATH`/`PATHEXT`. Use this when `codex` isn't the name of your binary or isn't on `PATH`. |
| `HANDOFF_CODEX_SKILLS_DIR` | You, in your shell | Overrides `~/.agents/skills` as the install target for the Codex skill set. Must be an absolute path — a relative value is refused with a visible error. |
| `CODEX_THREAD_ID` | Codex itself, per session | The session identity the engine resolves against when `CLAUDE_CODE_SESSION_ID` is absent — see [Session identity](codex-howto.md#session-identity) in the how-to. |
| `PROJECT_ROOT` | You / a wrapper script | Overrides project-root detection for a direct `handoff.js` invocation. Not set automatically by Codex hooks — see the note below. |
| `--force-skills` | You, on `node scripts/install.js --host codex --force-skills` | Turns a `skip`/`blocked` skill-install outcome into a force-overwrite, after copying the existing file to a timestamped `.bak-<YYYYMMDDTHHMMSS>-<epochMs>-<pid>` path. Needed to reclaim a hand-edited skill file or to evict a foreign `handoff` dispatcher skill that would otherwise hard-block install. See [Skills](#skills) below. |
| `--force-promotion` | You, on `node scripts/handoff.js init ... --force-promotion` | Unconditionally backs up and regenerates the promotion file (`AGENTS.md` under Codex) from the current template, regardless of its current content. See [AGENTS.md, not CLAUDE.md](#agentsmd-not-claudemd) above. |
| `--dry-run` | You, on `node scripts/install.js --host codex --dry-run` | Previews MCP registration, the hooks.json diff, and skill-install classification without writing anything (the `codex --version` discovery probe still runs for real). |

**No `PROJECT_ROOT` in hook payloads.** Unlike some CI wrappers, Codex does
not inject `PROJECT_ROOT` into the hook's environment — the engine resolves
the project root from the hook process's current working directory instead.
If you invoke `loader-hook`/`loader-stop` from a wrapper that changes `cwd`,
set `PROJECT_ROOT` explicitly to avoid resolving the wrong project.

---

## Skills

`node scripts/install.js --host codex` installs 8 skill files into
`~/.agents/skills/<name>/SKILL.md` (override the target directory with
`HANDOFF_CODEX_SKILLS_DIR`, which must be an absolute path):

| Skill | Purpose |
|---|---|
| `handoff` | Project memory dispatcher: with no argument, shows status and lists the sub-skills below; with an argument, defers to the matching handoff-* sub-skill. Never closes a session on its own. |
| `handoff-status` | Read-only project memory status: last close time, entity/assertion/edge counts, embedding readiness. |
| `handoff-resume` | Force-load prior-session context when it was not loaded automatically. |
| `handoff-checkpoint` | Mid-session save of an extraction payload without ending the session. |
| `handoff-close` | End-of-session extraction: entities, assertions, edges, and a contract update. Ends the session. |
| `handoff-query` | Search project memory (assertions, decisions, and other stored tables) by free-text query. |
| `handoff-init` | First-run provisioning for a project: schema, handoff file, and promotion file. |
| `handoff-promote` | Promote a specific stored assertion to the durable-facts section of the project promotion file. |

Each installed `SKILL.md` carries a managed-by marker line immediately after
the closing frontmatter `---`:

```
<!-- managed-by: claude-memory handoff-skills v1 sha256:<hash> -->
```

`<hash>` is a sha256 digest of the file's LF-normalized, BOM-stripped,
trailing-newline-trimmed body with the marker line itself excluded. On every
install run, the installer classifies each target with `fs.stat`/`fs.lstat`
(never a path-string compare) into exactly one outcome:

- **write** — nothing exists yet at that path.
- **unchanged** — the file exists, carries the marker, and the hash matches — left alone.
- **overwrite** — the file exists, carries the marker, and the hash differs (a newer skill body) — rewritten in place.
- **skip** — the file exists with no marker at all (hand-edited or hand-authored) — left alone; re-run with `--force-skills` to reclaim it.
- **blocked** — the same no-marker case, but specifically for the `handoff` dispatcher name: a foreign `handoff` skill there would keep firing on every bare `handoff` utterance, so this is a hard error rather than a skip, unless `--force-skills` is given.
- **error** — the target path is a symlink/junction, or exists as something other than a directory/regular file — never installed through.

**`--force-skills`** turns a `skip` or `blocked` outcome into a
force-overwrite: it copies the existing file to a timestamped
`.bak-<YYYYMMDDTHHMMSS>-<epochMs>-<pid>` path first, then writes the new
content.

**Dispatcher rule:** a bare `handoff` invocation always runs
`handoff_status` and lists the sub-skills above — it never calls
`handoff_close` on its own, so an accidental bare invocation can't end a
session or lose unsaved work.

**Stale migrated skills:** Codex auto-migrates a user's pre-existing
`~/.claude/commands` into `~/.agents/skills/source-command-handoff-*`
entries the first time it sees them. The installer detects and reports these
(`[WARN] stale pre-adapter skill found: ...`) but never touches, follows (if
a symlink), or deletes them — removing another tool's auto-migrated content
is out of scope. Delete them by hand if they conflict with the skills this
installer manages (see
[Known real-world defects and quirks, item 5](codex-howto.md#known-real-world-defects-and-quirks)
in the how-to).

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
| `HANDOFF_HOST` resolution, `--force-promotion`, `AGENTS.md` template rendering, skill-install classification (write/unchanged/overwrite/skip/blocked/force-overwrite/error) | **Verified** in `scripts/lib/codex-install.js`/`scripts/handoff.js` source and by `test-install-host.js` (101/101) and `test-host-agnostic-naming.js` (45/45) — these are unit/subprocess tests, not exercised against a live `codex` session by this docs PR. |
| The 8 skill files parsing and dispatching correctly under a real Codex skill loader | **Unverified** — no real `codex` binary was run against these files this session; matches the shipping PR's own blind-spot disclosure. |
| Frontmatter tolerance of the managed-by marker line (sits immediately after the closing `---`) | **Unverified** — assumed compatible with YAML-frontmatter parsers generally, not proven against Codex's specific loader. |
| Bare `handoff` utterance dispatching to the `handoff` skill (vs. a slash/prefix trigger) | **Unverified** — the dispatcher's argument-parsing logic is exercised only by unit tests, never a live invocation. |

Sources: https://learn.chatgpt.com/docs/extend/mcp,
https://learn.chatgpt.com/docs/hooks,
https://learn.chatgpt.com/docs/agent-configuration/agents-md,
`HANDOFF-INTEROP-REPORT-2026-09-09.md` and `CODEX-DISCOVERY-2026-09-10.md`
(local, untracked reports from a live Codex session against this repo).
