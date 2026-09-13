# Install

Fresh-machine setup for claude-memory under Claude Code and/or the Codex
CLI, on Windows, macOS, or Linux. This page covers the zip/compose install
path (`docker-compose.yml`, `install.cmd`/`install.sh`); if you're
developing this repo itself, use [QUICKSTART.md](../QUICKSTART.md) instead.

Using OpenAI Codex? [docs/hosts/codex-quickstart.md](hosts/codex-quickstart.md)
is a guided first run; this page still applies for the Postgres/compose
half of the setup.

---

## 1. Prerequisites

Check [PREREQS.md](../PREREQS.md)'s "Quick check" table before you start —
it lists the exact command to run for each requirement (Node.js v22+,
Postgres 13+ or Docker, pgvector, git) and what a passing result looks
like.

> **Planned, not yet shipped:** the package-and-installer design (docs/specs/
> package-and-installer.md section 3, in progress in a parallel PR) describes
> a `--check-only` preflight flag that runs every prerequisite probe as a
> single total classification
> (`PRESENT_OK`/`PRESENT_TOO_OLD`/`ABSENT`/`UNKNOWN`) and exits non-zero on
> any failure. `scripts/install.js` does not implement this flag yet — use
> PREREQS.md's manual checklist for now.

You need one of:

- **Docker + Docker Compose** (recommended — this page assumes it), or
- **An existing Postgres 16+ with the `vector` extension**, reachable from
  this machine (skip step 2 below and point `.claude/pipeline.yml` /
  `deploy/.env` at it instead).

---

## 2. Start Postgres via compose

From the repo root (or your extracted zip):

```sh
cp deploy/.env.example deploy/.env
```

Edit `deploy/.env` and set `POSTGRES_PASSWORD` to a random, alphanumeric-only
string of at least 32 characters (no hardcoded/default password is ever
committed or shipped — see the comments in
[deploy/.env.example](../deploy/.env.example)). Then:

```sh
docker compose -f deploy/docker-compose.yml --env-file deploy/.env up -d postgres
```

**You should see** the `postgres` container start and, within a few
seconds, its healthcheck (`pg_isready`) report healthy:

```sh
docker compose -f deploy/docker-compose.yml ps
```

Postgres is bound to `127.0.0.1` only — it is never reachable from another
machine on your network. The `embedder` service (vLLM) is defined in the
same compose file but is **off by default**; only start it if you have a
local GPU and want on-machine embeddings:

```sh
docker compose -f deploy/docker-compose.yml --profile embedder up -d embedder
```

Without an embedder, search degrades to full-text-search-only ranking —
nothing breaks, you just lose semantic/vector matching. See
[docs/hosts/codex.md](hosts/codex.md)'s degraded-modes note.

**Port already in use?** See [Troubleshooting](#troubleshooting) below.

---

## 3. Install script dependencies

The zip you downloaded (or this repo checkout) does **not** ship
`scripts/node_modules` unless you built or requested the `--offline`
variant (see [package-and-installer.md](specs/package-and-installer.md)
section 1) — the default zip expects `npm` to fetch dependencies itself:

```sh
cd scripts && npm install && cd ..
```

This installs `pg`, `@modelcontextprotocol/sdk`, and `zod` from
`scripts/package.json`/`scripts/package-lock.json`. Skip this step only if
you built an `--offline` zip (its `scripts/node_modules` is already
staged) — running it again there is harmless.

---

## 4. Configure the project and run `handoff init`

Point this project at the database compose just started, then create its
schema:

```sh
node scripts/init-config.js
node scripts/handoff.js init
```

`init-config.js` writes `.claude/pipeline.yml` (project name, DB
name/host/port/user — never a password; see
[PREREQS.md](../PREREQS.md#postgres-password) for how credentials are
resolved). `handoff.js init` then applies the schema and walks you through
a short interactive Q&A. Full step-by-step detail:
[QUICKSTART.md](../QUICKSTART.md) steps 3–4.

---

## 5. Host wiring

Run the installer for whichever host(s) you use. `install.cmd` (Windows)
and `install.sh` (macOS/Linux) are thin wrappers that just locate Node and
hand off to `scripts/install.js "$@"` — every flag below is
`scripts/install.js`'s own; see `node scripts/install.js --help`.

**Claude Code:**

```sh
./install.sh --host claude        # macOS/Linux
install.cmd --host claude         # Windows
```

Copies the `/handoff:*` slash commands to `~/.claude/commands/handoff/` and
wires `SessionStart`/`SessionEnd` hooks into your Claude Code settings file
— existing hooks are preserved.

**Codex CLI:**

```sh
./install.sh --host codex
install.cmd --host codex
```

Registers the `handoff` MCP server with `codex mcp add`, wires
`SessionStart`/`SessionEnd` hooks into `~/.codex/hooks.json`, and installs 8
skill files into `~/.agents/skills/`. Full detail, including the
`config.toml` clobber risk and registration-state table:
[docs/hosts/codex.md](hosts/codex.md).

**Both hosts:** there is no single `--host both` flag yet (the
package-and-installer design's section 2 describes a planned orchestrator
for this). Run the installer twice, once per host:

```sh
./install.sh --host claude
./install.sh --host codex
```

Each run only touches its own host's files and is idempotent — re-running
either one is safe.

**Codex only — one extra manual step.** `codex mcp add` cannot write a
per-tool `approval_mode` sub-table, so under a non-interactive `codex exec`
approval policy the `usage_query`/`usage_record` MCP tools need a hand-added
`config.toml` stanza. See
[docs/hosts/codex.md § Non-interactive approval for MCP tools](hosts/codex.md#non-interactive-approval-for-mcp-tools).

---

## 6. Smoke test

Verify the MCP server actually answers, through the **host's own** MCP
path (not a bare script call):

**Claude Code:** start a session in this project directory and run
`/handoff:status`, or ask Claude to call the `handoff_status` MCP tool
directly.

**Codex CLI:**

```sh
codex mcp get handoff --json
```

confirms registration, then start a Codex session in this project
directory and call `handoff_status` (via the `handoff` skill, or directly)
— it should report the current project's entity/assertion counts and host
as `codex`.

**You should see** a status summary, not a connection error. If you get a
connection error, re-check step 2 (`docker compose ps` shows `postgres`
healthy) and step 4 (`.claude/pipeline.yml` points at the right
host/port/db).

---

## 7. Upgrade

```sh
git pull   # or: extract a newer memory-manager-<version>.zip over this checkout
./install.sh --host claude   # and/or --host codex
node scripts/handoff.js init  # re-applies schema; heal-on-touch, idempotent
```

> **Planned, not yet shipped:** the package-and-installer design's section 6
> describes a schema-epoch comparison (`--upgrade` refusing to cross a
> schema-epoch boundary without `--epoch-ack`, taking a `pg_dump` checkpoint
> first). That gate is not implemented yet — `handoff.js init`'s existing
> heal-on-touch schema application is what currently keeps an upgraded
> checkout's database current. Back up your database yourself before a
> major-version upgrade until that gate lands (see
> `docs/troubleshooting.md` for `pg_dump` guidance).

---

## 8. Uninstall

There is no `--uninstall` flag yet (the package-and-installer design's
section 7 describes the planned flow, including `--purge-data`'s two typed
confirmations). To remove a host's wiring by hand:

**Claude Code:** delete the `loader-hook`/`loader-stop` entries from your
Claude Code settings file (`~/.claude/settings.json` or
`.claude/settings.local.json` — `install.cmd --dry-run` / `install.sh
--dry-run --host claude` shows you exactly which entries are "ours" before
you touch anything by hand), and delete
`~/.claude/commands/handoff/`.

**Codex CLI:** see
[docs/hosts/codex.md § Uninstall / repair](hosts/codex.md#uninstall--repair)
— edit `config.toml` and `hooks.json` directly; that section spells out
exactly which stanzas are this project's.

**Data:** removing host wiring never touches your Postgres database or
`~/.claude/projects/<uuid>/handoff.md` — that data is host-agnostic and
survives switching hosts or reinstalling. To remove it too:

```sh
docker compose -f deploy/docker-compose.yml down -v   # drops the mm_pgdata volume
```

Only do this if compose provisioned your Postgres (check `MM_PG_PROVISIONED`
in `deploy/.env`) — never run this against an external Postgres instance
you pointed the project at instead.

---

## Troubleshooting

**Port 5432 already in use.** Another Postgres (local install or another
project's compose) is already bound to it. Set `MM_PG_PORT` in
`deploy/.env` to a free port (e.g. `MM_PG_PORT=5433`), update
`.claude/pipeline.yml`'s port to match, and re-run `docker compose up -d
postgres`.

**Codex: MCP tool call rejected under `codex exec` / a scripted run.** This
is the `tools.*` sub-table caveat: `codex mcp add` never writes a per-tool
`approval_mode` entry, so a non-interactive approval policy of `never`
rejects tools like `usage_query`/`usage_record` unless you hand-add the
stanza. Never re-run `codex mcp add` after hand-adding it — that command
rewrites the whole `[mcp_servers.handoff]` block and silently deletes your
addition. Full detail:
[docs/hosts/codex.md § Non-interactive approval for MCP tools](hosts/codex.md#non-interactive-approval-for-mcp-tools).

**`pgvector` extension missing.** The `pgvector/pgvector:pg16` compose
image ships it, but each database still needs `CREATE EXTENSION IF NOT
EXISTS vector;` run against it individually — `handoff.js init` does this
for you on a compose-provisioned DB. If you're on an external Postgres,
run that command yourself first.

**More:** [docs/troubleshooting.md](troubleshooting.md) covers additional
setup and runtime issues (hook wiring diffs, embedding endpoint resolution,
degraded-mode search behavior).
