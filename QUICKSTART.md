# Quickstart

Claude already has memory across sessions — it reads `CLAUDE.md` and per-project memory files every time it starts. The problem is those files get stale: notes pile up, old facts stay even after they stop being true, and when the file gets long enough Claude can't reliably surface what's actually relevant right now. This project sits on top of that built-in memory and manages it: it tracks when notes were written, scores them for freshness, lets old facts be marked as no longer true, and pulls up what's relevant to the current session rather than dumping everything at once. And if you come back to a project after months away, it can bring the notes that matter for that project back to the surface — even ones that had gone quiet in the meantime.

> Before you start, check [PREREQS.md](PREREQS.md) to make sure Node.js and Postgres are installed and running.

---

## Steps

### 1. Clone the repo and install dependencies

This pulls down the project and installs the Node packages it needs to run.

```sh
git clone https://github.com/djwmobley/claude-memory.git
cd claude-memory
cd scripts && npm install && cd ..
```

**You should see:** npm finishing without errors. A `node_modules` folder will appear inside `scripts/`.

---

### 2. Create a Postgres database

Postgres is a database — a separate program that stores data even after Node stops running. We use it because it supports a kind of search where you can find notes by *meaning*, not just exact words. (More on that in [docs/how-memory-works.md](docs/how-memory-works.md).)

This step creates an empty database named `claude_memory`:

```sh
createdb claude_memory
```

**You should see:** No output. That means it worked. (If you see an error about "connection refused", Postgres isn't running yet — see [docs/troubleshooting.md](docs/troubleshooting.md).)

---

### 3. Tell the project which database to use

Claude reads `.claude/pipeline.yml` to know which database to talk to. Instead of writing this file by hand, run the bootstrap script — it prompts you for each value and writes the file for you:

```sh
node scripts/init-config.js
```

You'll be asked for:

- **project name** — defaults to the name of the current directory
- **postgres user** — defaults to `postgres`
- **database name** — defaults to `claude_memory`
- **host** — defaults to `localhost`
- **port** — defaults to `5432`

Hit Enter at any prompt to accept the default shown in brackets. The script creates `.claude/` if it doesn't exist yet.

**Note on passwords:** The script doesn't ask for your Postgres password — intentionally. Storing it in `pipeline.yml` as plain text would be unsafe, and prompting on every run would be a hassle. Instead, this project relies on Postgres's standard auth mechanisms: set a `PGPASSWORD` environment variable in your shell, or put your credentials in `~/.pgpass` (Linux/macOS) or `%APPDATA%\postgresql\pgpass.conf` (Windows). See [PREREQS.md](PREREQS.md#postgres-password) for setup details. If you're using peer authentication or the trust auth method (common in local dev setups), you don't need to configure anything — the script will just connect.

**You should see** a summary like this:

```
Wrote .claude/pipeline.yml:
  project name: my-project
  database:     claude_memory@localhost:5432
  user:         postgres

Next: node scripts/handoff.js init
```

If the file already exists, the script will ask before overwriting. Pass `--force` to skip that prompt, or `--non-interactive` to accept all defaults without any prompts (useful in CI).

---

### 4. Run the setup command

This creates the tables Claude will use to store notes.

```sh
node scripts/handoff.js init
```

**You should see:**

```
init complete:
OK    schema migration: phase2-schema.sql
OK    schema migration: phase3b-schema.sql
OK    project_settings defaults inserted (5 keys, idempotent)
OK    created handoff.md: ~/.claude/projects/<your-path>/handoff.md
OK    created CLAUDE.md: <project-root>/CLAUDE.md
OK    retrieval_contract 'default' row ensured

Done: handoff:init — project <your-path> provisioned
```

**What just happened:** The script created the database tables and a `handoff.md` in a private folder outside the repo where session notes will live. If your project didn't already have a `CLAUDE.md` at the repo root, it created one too (Claude reads this at startup — commit it to git). If you already had a `CLAUDE.md`, the script left it alone. The output line will say `OK    created CLAUDE.md: <path>` or `OK    CLAUDE.md already exists — skipped: <path>` accordingly.

---

### 5. Install the slash commands and wire the session hooks

Two things need to happen for Claude to actually use the memory layer: the slash commands (`/handoff:close`, `/handoff:resume`, and the rest) need to live where Claude Code can find them, and the session-start and session-end hooks need to be registered in your project's settings. The installer does both:

```sh
node <path-to-this-repo>/scripts/install.js
```

Replace `<path-to-this-repo>` with the absolute path where you cloned `claude-memory`. The script will:

- Copy the eight `/handoff:*` slash command files to `~/.claude/commands/handoff/`
- Add SessionStart and Stop hooks to `.claude/settings.local.json` in your current project (creating the file if it doesn't exist, or merging with what's already there)

**You should see** a short summary listing what was copied and wired, then "Done. Restart Claude Code or open a fresh session to pick up the changes."

If you'd rather do this by hand — or want to see exactly what's being written before it happens — expand the section below.

<details>
<summary>Manual setup (alternative to the installer)</summary>

**Copy the slash commands:**

```sh
cp commands/handoff/*.md ~/.claude/commands/handoff/
```

No output means it worked.

**Wire the session hooks:**

Add this to `.claude/settings.local.json` in your project (create the file if it doesn't exist), replacing `/full/path/to/claude-memory` with the actual path where you cloned this repo:

```json
{
  "hooks": {
    "SessionStart": [
      {
        "command": "node /full/path/to/claude-memory/scripts/handoff.js loader-hook"
      }
    ],
    "Stop": [
      {
        "command": "node /full/path/to/claude-memory/scripts/handoff.js loader-stop"
      }
    ]
  }
}
```

The hooks fire the next time you open a Claude session.

</details>

---

## Test it worked

Start a new Claude Code session in your project and run:

```
/handoff:status
```

**You should see:** A short report showing your project name, the database it's connected to, and counts that say "0 entities, 0 assertions" (because you haven't closed a session yet).

That means Claude can read from and write to the database. You're set up.

---

## Day-to-day usage

Once the setup steps are done, you'll mainly touch two commands in a normal session:

**`/handoff:close`** — run this at the end of a session. Claude reads back over what happened, pulls out decisions, facts, and context worth keeping, and writes them to the database. If you skip it, the Stop hook will do a quick automatic save when Claude closes, but the explicit close gives Claude more room to write a richer summary.

**`/handoff:checkpoint`** — same as `/handoff:close`, but the session stays open so you can keep working. Use it whenever you hit a natural decision point in a long session and want to make sure that progress is captured before continuing.

Two more you'll use occasionally:

**`/handoff:status`** — shows your project name, the database it's connected to, and a quick count of what's in memory. Good for confirming everything is wired up correctly, and for a gut-check before starting a long session.

**`/handoff:resume`** — loads the most recent session summary back into context. The SessionStart hook does this automatically when you open a new session, so you usually won't need to run it by hand — but it's there if you want to pull in prior context mid-session without closing and reopening.

For the full set of commands and what each one does, see [commands/handoff/README.md](commands/handoff/README.md).

---

## What's next

- [docs/how-memory-works.md](docs/how-memory-works.md) — how Claude decides what to save and how it finds things later
- [commands/handoff/README.md](commands/handoff/README.md) — the full list of `/handoff:` commands and what each one does
- [docs/troubleshooting.md](docs/troubleshooting.md) — common problems and how to fix them

---

## If something broke

See [docs/troubleshooting.md](docs/troubleshooting.md).
