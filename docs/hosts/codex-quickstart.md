# Codex quickstart

Zero to first close, in one sitting, for an OpenAI Codex CLI user who has
never touched Claude Code. About 20-30 minutes if Postgres is already
installed.

This page assumes you are using the `codex` CLI only. If you also use Claude
Code, the [Claude Code QUICKSTART.md](../../QUICKSTART.md) is the one to
follow instead — its Postgres/install steps are identical, only the hook
wiring differs.

---

## 1. Clone and install dependencies

```sh
git clone https://github.com/djwmobley/claude-memory.git
cd claude-memory
cd scripts && npm install && cd ..
```

**You should see:** npm finishing without errors and a `node_modules`
folder inside `scripts/`.

---

## 2. Postgres first

claude-memory stores everything in Postgres — entities, assertions, edges,
decisions, sessions. Set this up before touching Codex.

```sh
createdb claude_memory
psql -d postgres -c "CREATE EXTENSION IF NOT EXISTS vector;"
```

**You should see:** no output from `createdb` (that means it worked), and
`CREATE EXTENSION` (or a "already exists, skipping" notice) from the second
command.

If `createdb` says "connection refused," Postgres isn't running yet. See
[docs/troubleshooting.md](../troubleshooting.md). Full prerequisite detail,
including Windows-specific notes, is in [PREREQS.md](../../PREREQS.md).

Embeddings (vLLM) are optional for this walkthrough — skip them for now and
come back to [codex-howto.md § Degraded modes](codex-howto.md#degraded-modes)
later if you want vector search.

---

## 3. Point the project at the database

Follow the environment-variable / connection-string step in
[QUICKSTART.md](../../QUICKSTART.md#3-tell-the-project-which-database-to-use)
— this step is host-agnostic and not repeated here.

---

## 4. Install the Codex host wiring

```sh
node scripts/install.js --host codex --dry-run
```

Read the preview: it shows the exact `codex mcp add …` command it will run
and the `hooks.json` diff it will write to
`${CODEX_HOME:-~/.codex}/hooks.json`. When it looks right, run it for real:

```sh
node scripts/install.js --host codex
```

**You should see:** `[OK]` lines for MCP registration and hook wiring. If
`codex` isn't on `PATH`, the installer prints the exact command to run by
hand once it is — see [codex.md § Install](codex.md#install) for the full
mechanics, backup behavior, and what each state means.

---

## 5. Trust the hooks

Start (or restart) an interactive `codex` session in this directory:

```sh
codex
```

You'll see two separate prompts the first time:

1. A **directory trust** prompt — accept it for this project.
2. A **hooks review** — "Hooks can run outside the sandbox after you trust
   them." Choose **"Trust all and continue."**

Both prompts are one-time per content hash — editing `hooks.json` later
(including re-running the installer with a different engine path) will ask
again. See [codex.md § Trust](codex.md#trust) if you don't see the review at
all, or if you're running `codex exec` instead of the interactive TUI.

---

## 6. Open the project and initialize

With hooks trusted, the SessionStart hook fires automatically on every new
session — but the very first time, there is nothing to load yet. Ask Codex
to initialize:

> Run handoff_init for this project.

Codex should call the `mcp__handoff__handoff_init` tool. **You should see**
a confirmation that the project's identity marker and schema were created
(look for "resolved," "applied," and "verified" in the response — there is
no phantom "schema.sql" file list here; the schema is applied inline).

If the MCP tool isn't visible yet, run `codex mcp list` to confirm `handoff`
is registered, then restart the session.

---

## 7. Resume (confirm the loop works)

> Run handoff_resume for this project.

**You should see** a context block — likely near-empty on a brand-new
project, which is expected. This confirms the read path works end to end.

---

## 8. Do a small piece of work

Anything real: read a file, make an edit, discuss a design decision. This is
just to have something worth remembering.

---

## 9. Close the session

> Run handoff_close for this project. Summarize what we just did: [one or
> two sentences of TL;DR], no open threads yet.

Codex should call `mcp__handoff__handoff_close` with a payload containing at
least a `tldr` field (entities/assertions/edges/decisions can be empty on a
first pass). **You should see** a summary line reporting entities/
assertions/edges written and the embedding state (`READY`, or a note that
embeddings are disabled if you skipped vLLM).

---

## 10. Verify

> Run handoff_status for this project.

**You should see** `last_close` set to just now, live counts matching what
you just wrote, and `session_active: false` (or the marker reflecting this
session's own ID, depending on companion-PR state — see
[codex.md](codex.md#environment-variables)).

---

## You're set up

Next session, just start `codex` in this directory — SessionStart loads
context automatically once hooks are trusted. For everyday use (mid-session
checkpoints, reading the graph back, promoting durable facts to
`AGENTS.md`, and a list of known rough edges), see
[codex-howto.md](codex-howto.md).
