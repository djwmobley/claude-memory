# Prerequisites

Before you run through QUICKSTART.md, make sure you have these five things installed
and working. This page walks through each one — what it is, how to check if you
already have it, and how to install it if you don't. Most people already have Git and
Node; Postgres is the one that usually needs a fresh install.

---

## Quick check — run these first

Paste each command into your terminal. If it prints a version number that meets the
minimum, you're good. If you get "command not found", jump to that tool's section below.

| Tool | Check command | Minimum |
|------|--------------|---------|
| Node.js | `node --version` | v22.0.0 |
| Postgres | `psql --version` | 13 |
| pgvector | `psql -d postgres -c "SELECT extversion FROM pg_available_extensions WHERE name='vector';"` | 0.8.1 |
| npm | `npm --version` | (any) |
| Git | `git --version` | (any) |

---

## Node.js (v22 or higher)

Node.js is the JavaScript runtime that runs all the scripts in this project.

**Check:** `node --version` — you should see `v22.x.x` or higher.

**Install:** [nodejs.org/en/download](https://nodejs.org/en/download/) — grab the LTS
release. macOS with Homebrew: `brew install node`. Windows: download the `.msi` and run it.

**Why:** Every script in this project — setup, session hooks, slash commands — runs on Node.
Node 22 specifically is required for the built-in `node:sqlite` module used by the test suite.

---

## Postgres (version 13 or higher)

Postgres is a database — a separate program that stores your notes even when Node isn't
running.

**Check:** `psql --version` — you should see `psql (PostgreSQL) 13.x` or higher.

**Check it's running:** `pg_isready` — you should see `accepting connections`. If you
see "Connection refused", Postgres is installed but not started yet. See
[docs/troubleshooting.md](docs/troubleshooting.md).

**Install:**
- macOS: `brew install postgresql@16` then `brew services start postgresql@16`
- Linux (Debian/Ubuntu): `sudo apt install postgresql` then `sudo systemctl start postgresql`
- Windows: [postgresql.org/download/windows](https://www.postgresql.org/download/windows/) —
  the installer sets up a Windows service automatically.

**Why:** This is where your session notes, entities, and memory live between Claude sessions.

---

### Postgres password {#postgres-password}

This project never stores your Postgres password in `pipeline.yml` or any other config file checked into the repo. Plain-text passwords in YAML files are a common source of credential leaks; keeping them out is intentional.

There are three ways to provide credentials, in order of how much setup they require:

**Option 1 — Peer or trust auth (no setup needed for many local installs)**

If your Postgres is configured to allow your OS user to connect without a password — which is the default for many macOS Homebrew installs and Linux packages when connecting over a Unix socket — you don't need to do anything. The scripts will connect automatically.

**Option 2 — `PGPASSWORD` environment variable**

Set the variable in your shell before running scripts:

```sh
# Linux / macOS (bash/zsh)
export PGPASSWORD=yourpassword
node scripts/handoff.js init

# Windows PowerShell
$env:PGPASSWORD = "yourpassword"
node scripts/handoff.js init
```

To avoid typing it every time, add the `export` line to your shell profile (`~/.bashrc`, `~/.zshrc`, etc.). Note that the variable is visible in process listings (`ps aux`) while it's set — acceptable for local dev, but not for shared machines.

**Option 3 — `.pgpass` file (recommended for regular use)**

Postgres reads credentials from a local file and never exposes them in the environment:

- **Linux / macOS:** `~/.pgpass`
- **Windows:** `%APPDATA%\postgresql\pgpass.conf`

Format — one line per connection, colon-separated:

```
hostname:port:database:username:password
```

Examples:

```
localhost:5432:claude_memory:postgres:yourpassword
localhost:5432:*:myuser:mypassword
```

Use `*` as a wildcard for any field. On Linux/macOS the file must be readable only by your user — Postgres ignores it otherwise:

```sh
chmod 600 ~/.pgpass
```

Windows doesn't have `chmod`; file permissions are set via Properties → Security in Explorer.

---

## pgvector extension (version 0.8.1 or higher)

pgvector is a Postgres add-on that lets it search by meaning — finding notes that are
conceptually related to a query, not just ones that match the exact words.

> **Optional for QUICKSTART:** pgvector is only needed if you plan to use the vector
> search layer (`scripts/pipeline-embed.js`). The core session-memory system in
> QUICKSTART.md works fine without it. Install it now if you want, or come back later.

**Check:** `psql -d postgres -c "SELECT extversion FROM pg_available_extensions WHERE name='vector';"`
You should see a row with `0.8.1` or higher. If you get `(0 rows)`, pgvector isn't installed.

**Install:** [github.com/pgvector/pgvector#installation](https://github.com/pgvector/pgvector#installation).
macOS Homebrew: `brew install pgvector`. Then enable it: `psql -d postgres -c "CREATE EXTENSION IF NOT EXISTS vector;"`

**Why:** Enables search-by-meaning in the optional vector search layer.

---

## npm (any recent version)

npm is the package manager that comes bundled with Node.js — no separate install needed.

**Check:** `npm --version` — any version number is fine (e.g., `10.x.x`).

QUICKSTART.md uses `npm install` inside the `scripts/` folder. That's all you need.

> **Contributing?** CONTRIBUTING.md uses `pnpm 9+` for the test suite. Install it with
> `npm install -g pnpm` when you're ready.

**Why:** Downloads the JavaScript packages the scripts depend on.

---

## Git

Git is the tool used to clone this repo. You almost certainly already have it.

**Check:** `git --version` — any recent version is fine.

**Install if needed:** [git-scm.com/downloads](https://git-scm.com/downloads).

**Why:** To clone the repository in Step 1 of QUICKSTART.

---

## Test it all works together

Once Postgres is running and pgvector is installed, confirm they're connected:

```sh
psql -d postgres -c "CREATE EXTENSION IF NOT EXISTS vector;"
```

You should see `CREATE EXTENSION`. (If pgvector was already installed you may see
`NOTICE: extension "vector" already exists, skipping` — that's also fine.)

---

## OS-specific notes

**Windows:** PowerShell works fine for everything in QUICKSTART.md. No WSL required for
the basic setup. One gotcha: if you edit `.claude/pipeline.yml` in a Windows editor that
defaults to CRLF line endings, the config parser may silently ignore it. Save `pipeline.yml`
with LF line endings (VS Code shows the mode in the status bar; click it to switch).

**vLLM / embeddings:** The optional vector backend does require WSL on Windows — but that's
separate from QUICKSTART. See [docs/troubleshooting.md](docs/troubleshooting.md) if you hit
any snags.

---

## Next step

When all the checks pass, head to [QUICKSTART.md](QUICKSTART.md).
