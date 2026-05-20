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

**What just happened:** The script created the database tables. It wrote a `CLAUDE.md` to your repo root (Claude reads this at startup) — commit that file to git. It also created a `handoff.md` in a private folder outside the repo where session notes will live.

---

### 5. Install the slash commands

These are small recipe files that give Claude the `/handoff:close`, `/handoff:resume`, and other commands it needs to manage its notes. Copying them to `~/.claude/commands/` makes them available in every Claude Code session.

```sh
cp commands/handoff/*.md ~/.claude/commands/handoff/
```

**You should see:** No output. That's fine.

---

### 6. Wire the session hooks

A hook is a script that runs automatically at a specific moment — in this case, when a Claude session starts and when it ends. Without this step, Claude won't automatically load prior notes or save new ones.

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

**You should see:** Nothing yet — the hooks fire the next time you open a Claude session.

---

## Test it worked

Start a new Claude Code session in your project and run:

```
/handoff:status
```

**You should see:** A short report showing your project name, the database it's connected to, and counts that say "0 entities, 0 assertions" (because you haven't closed a session yet).

That means Claude can read from and write to the database. You're set up.

---

## What's next

- [docs/how-memory-works.md](docs/how-memory-works.md) — how Claude decides what to save and how it finds things later
- [commands/handoff/](commands/handoff/) — the full list of `/handoff:` commands and what each one does
- [docs/troubleshooting.md](docs/troubleshooting.md) — common problems and how to fix them

---

## If something broke

See [docs/troubleshooting.md](docs/troubleshooting.md).
