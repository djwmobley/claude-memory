# Troubleshooting

Hit an error? Search this page for the exact text you saw — if it's in here, the fix is right under it. Use Ctrl+F (or Cmd+F on Mac) and paste the key words. If your error isn't listed, please open an issue with the full error and what you were doing.

---

## Section 1: Install-time errors

These come up during steps 1–4 of the QUICKSTART — cloning the repo, creating the database, running `init-config.js`, and running `handoff.js init`.

---

### `connection refused` when running `createdb` or `node scripts/handoff.js init`

**What it means:** Postgres is installed but the server isn't running yet.

**Fix:**

On **Mac** (Homebrew):
```sh
brew services start postgresql@16
```

On **Linux** (systemd):
```sh
sudo systemctl start postgresql
```

On **Windows**:
```powershell
# Open Services (Win+R → services.msc) and start "postgresql-x64-16",
# or run from an elevated PowerShell:
Start-Service postgresql*
```

Then retry your command.

**Why it happened:** The database server process has to be running before any client (including `createdb` and Node) can connect to it.

---

### `role "yourusername" does not exist`

**What it means:** Postgres doesn't have a user that matches your system login name.

**Fix:**

1. Connect as the default superuser:
   ```sh
   psql -U postgres
   ```
2. Create a role for your username (replace `yourusername`):
   ```sql
   CREATE ROLE yourusername WITH LOGIN;
   ```
3. Type `\q` to exit, then retry.

Alternatively, set `PGUSER=postgres` in your shell so all `psql`/`createdb` calls use `postgres` instead of your login name:
```sh
export PGUSER=postgres   # Mac/Linux
$env:PGUSER = 'postgres' # PowerShell
```

---

### `database "claude_memory" does not exist`

**What it means:** The database hasn't been created yet — or you skipped QUICKSTART step 2.

**Fix:**
```sh
createdb claude_memory
```

If you get a `connection refused` error when you run that, start Postgres first (see above), then run it again.

---

### `Invalid database name "..." (from ...) — must match /^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/`

**What it means:** The database name in your `HANDOFF_DB` environment variable (or in `.claude/pipeline.yml`) isn't a valid Postgres identifier.

**Fix:**

A valid name starts with a letter or underscore, contains only letters, digits, and underscores, and is 63 characters or shorter. No hyphens, no spaces, no dots.

- Good: `claude_memory`, `my_project_db`
- Bad: `my-project`, `claude memory`, `123db`

If you set `HANDOFF_DB` manually, clear it or correct it:
```sh
unset HANDOFF_DB          # Mac/Linux
Remove-Item Env:HANDOFF_DB # PowerShell
```

Then re-run `node scripts/init-config.js` and enter a valid name when prompted.

---

### `extension "vector" is not available` (or `could not open extension control file`)

**What it means:** The pgvector extension isn't installed in your Postgres instance.

**Fix:**

On **Mac** (Homebrew):
```sh
brew install pgvector
```

On **Ubuntu/Debian**:
```sh
sudo apt install postgresql-16-pgvector
```
Replace `16` with your Postgres major version (`psql --version` shows it).

On **Windows**: download the pre-built `.zip` from https://github.com/pgvector/pgvector/releases, copy `vector.dll` into your Postgres `lib/` folder and `vector.control` + `vector--*.sql` into the `extension/` folder. Restart Postgres after copying.

After installing, run `node scripts/handoff.js init` again — it will create the extension automatically.

---

### `Cannot find module 'pg'` (or `Cannot find module` for any other package)

**What it means:** The Node packages haven't been installed yet.

**Fix:**
```sh
cd scripts && npm install
```

Run this from the repo root. A `node_modules` folder will appear inside `scripts/`. Then retry your command.

**Why it happened:** npm packages live locally per project. They don't install automatically on clone.

---

## Section 2: First-session errors

These come up the first time you use Claude Code after finishing the QUICKSTART.

---

### Hooks not firing — `/handoff:status` runs but nothing loads at session start

**What it means:** The hook wiring in `.claude/settings.local.json` isn't being picked up.

**Fix:**

1. Open `.claude/settings.local.json` (in your project root, not your home directory).
2. Check that the path to `handoff.js` is **absolute** — it must start with `/` on Mac/Linux or a drive letter on Windows (`C:\...`). A relative path like `./scripts/handoff.js` won't work.
3. Check that the file is valid JSON. A trailing comma or missing brace will silently prevent hooks from loading.
4. **Restart Claude Code completely** — hooks are read once at startup, not live-reloaded.

Correct example (Mac/Linux):
```json
{
  "hooks": {
    "SessionStart": [
      { "command": "node /absolute/path/to/claude-memory/scripts/handoff.js loader-hook" }
    ],
    "Stop": [
      { "command": "node /absolute/path/to/claude-memory/scripts/handoff.js loader-stop" }
    ]
  }
}
```

---

### Windows: values in `pipeline.yml` look garbled, or connection settings don't match what you typed

**What it means:** Your editor saved `pipeline.yml` with Windows CRLF line endings (`\r\n`) and something upstream didn't strip the `\r` from parsed values.

**Fix:**

1. Open `pipeline.yml` in VS Code.
2. Click `CRLF` in the bottom-right status bar and switch it to `LF`.
3. Save the file.

To verify from a terminal:
```sh
node -e "const s=require('fs').readFileSync('.claude/pipeline.yml','utf8'); console.log(s.includes('\r') ? 'CRLF found' : 'LF only')"
```

If it prints `CRLF found`, switch the line endings as described above and save again.

**Why it happened:** Git on Windows sometimes converts line endings to CRLF on checkout. The parser handles this in recent versions, but older installs or manual edits can reintroduce it.

---

### `/handoff:status` shows `0 entities, 0 assertions` forever

**What it means:** You've set everything up correctly, but no session data has been extracted yet — because you haven't run `/handoff:close` at the end of a session.

**Fix:**

At the end of any Claude Code session where you want the notes saved, run:
```
/handoff:close
```

That's the command that reads the conversation, extracts entities and assertions, and writes them to the database. The count stays at zero until you've closed at least one session.

After your first `/handoff:close`, run `/handoff:status` again and you'll see non-zero counts.

---

### `relation "entities" does not exist` (or `relation "assertions" does not exist`)

**What it means:** The script is talking to a database that hasn't been initialized, or you're pointed at the wrong database.

**Fix:**

Run the init command:
```sh
node scripts/handoff.js init
```

This creates all the required tables. It's safe to run more than once — it won't overwrite existing data. If it succeeds, retry whatever you were doing.

If you recently changed the database name in `.claude/pipeline.yml`, the new database also needs to be initialized.

---

### `[handoff] C2 feedback: no session id resolvable — skipping bias update`

**What it means:** The retrieval-feedback subsystem couldn't find an active session ID when the session closed. This is almost always harmless.

**Fix:** No action needed in most cases. This warning appears when:

- The `SessionStart` loader hook didn't fire (most common reason), so no session was registered.
- You ran `/handoff:close` manually without `/handoff:resume` being called first.

**When to investigate:** If you used `/handoff:resume` manually at the start of the session AND this warning still appears every single time, check that your `SessionStart` hook is wired correctly (see the "Hooks not firing" entry above). Once the hook fires reliably, this warning will go away.

---

## Section 3: "Nothing happened, no error"

### You ran `node scripts/handoff.js init` and got no output at all

The script writes output to stdout. If your terminal swallowed it, try:
```sh
node scripts/handoff.js init 2>&1
```

Also confirm you're running from the repo root, not from inside `scripts/`:
```sh
# Right:
node scripts/handoff.js init

# Wrong (run from inside scripts/):
node handoff.js init
```

---

### `/handoff:resume` ran but Claude doesn't seem to have any context

Two things to check:

1. **Did you ever run `/handoff:close`?** If not, there's nothing in the database to load. Run a session, close it with `/handoff:close`, then try `/handoff:resume` in a new session.
2. **Is the staleness gate blocking?** If your last close was more than 7 days ago, the auto-loader skips injection and tells you. Run `/handoff:resume` manually to load anyway, or `/handoff:drop` to start fresh.

---

### Hooks fire during development but not in a different project directory

The `.claude/settings.local.json` file is **per project**. Each project directory needs its own copy. If you set up hooks in one project, they won't carry over to others automatically.

---

## Didn't find your issue?

Open an issue at https://github.com/djwmobley/claude-memory/issues with:
- The full error text (copy-paste, don't retype)
- Your operating system
- Which QUICKSTART step you were on (or what command you ran)
