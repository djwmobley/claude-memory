# Package and installer spec

Status: DRAFT, no code exists yet. Governs the distributable zip and
installer for the public engine repo (see Blind spots on the
`memory-manager` vs `claude-memory` naming question). Supersedes
CONSOLIDATION-RUNBOOK.md §19's docker-compose `handoff-mcp` streamable-http
service — owner ruling: **stdio MCP only, no http service, no
`handoff-mcp` container.** The MCP server always launches as a stdio
subprocess of the host CLI (`codex mcp add …` / Claude hook+settings
wiring), exactly as `scripts/install.js` and `scripts/lib/codex-install.js`
already do.

Revision note: §3, §6 and §7 below were rewritten after an adversary pass
(findings A1-G2) found several allow-list-shaped and positional-assumption
gaps in the original draft. See each subsection for the specific finding it
closes.

Round-2 revision note: an independent implementation review of PR #309
(the §3 code) found 6 further blockers (labeled H1-H4 below; H4 covers two
of the six, both in the pgvector probe). See each subsection for the
specific finding it closes.

## 1. Zip contents

```
memory-manager-<version>.zip
  VERSION                     # single line, matches scripts/package.json version
  SHA256SUMS.txt              # sha256 of every other file, generated at build
  install.cmd / install.sh    # entry points
  LICENSE, README.md, QUICKSTART.md, PREREQS.md, CHANGELOG.md
  docker-compose.yml, .env.example
  commands/handoff/*.md
  docs/**                     # hosts/*, mcp-tools.md, how-memory-works.md, troubleshooting.md, glossary.md
  templates/**                # handoff.md.tpl, project-*-md.tpl, codex-skills/*
  scripts/
    install.js, handoff.js, handoff-mcp.mjs, handoff-mcp-selftest.mjs, init-config.js
    lib/**, sql/** (schema-manifest.json + every unit it enumerates), migrations/**
    package.json, package-lock.json, pnpm-lock.yaml
```

Excluded always: `test/`, `.github/`, `docs/notes/`, the private runbook
files (per this repo's own CLAUDE.md), `.bak-*`, `node_modules/`.

`node_modules/` ships only in a separate `-offline` zip variant (`pnpm
install --frozen-lockfile --prod`). The default zip runs `npm ci` /
`pnpm install --frozen-lockfile` as its first install step — dependency
resolution only; **the zip is never published to npm.**

## 2. Installer entry points

`install.cmd`/`install.sh` locate Node and exec `node
scripts/install-manager.js <args>` — a new orchestrator that calls the
existing `scripts/install.js` unmodified as its host-wiring step
(`--host claude|codex`). Flags:

- `--host claude|codex|both` — `both` runs each host path independently.
- `--check-only [--no-embedder]` — run §3; exit 0 only if every REQUIRED
  row lands `PRESENT_OK` (`gh` is optional and never gates;
  `AMBIGUOUS_PG`, `UNKNOWN`, and `ABSENT_BUT_AVAILABLE` all count as a
  failing, non-zero-exit row — never silently treated as OK). Writes
  nothing (read-only by construction — see H4 in §3 for the pgvector
  probe specifically). `--no-embedder` records an explicit decline of the
  embedder prerequisite (degraded FTS-only).
- `--upgrade` — §6. `--uninstall [--purge-data]` — §7.
- `--offline` — skip dependency download; requires the offline zip, fails loudly otherwise.
- `--yes` — accepts §3 ASSIST prompts and §5-§7 confirmations non-interactively;
  never silences a REFUSE, and per §3's B1 rule never covers an elevated
  installer action.

## 3. Prerequisite check — total classification

Every prerequisite row lands in exactly one of six outcomes — this set is
closed and every row in the table below (and the `postgres`/`pgvector` rows
specifically) must land in one of them, with no other exit:

- **`PRESENT_OK`** — probed, parsed, meets the minimum.
- **`PRESENT_TOO_OLD`** — probed, parsed, below the minimum. Names both the
  found and required versions and gets the same ASSIST path as `ABSENT`.
- **`ABSENT`** — a confirmed spawn-level "not found" (the OS could not
  resolve the executable at all, e.g. `ENOENT`). This is the *only* path to
  `ABSENT` — see A2/H2 below for why a process that DID spawn, or a spawn
  that failed for a reason OTHER than a confirmed `ENOENT` (`EACCES`,
  `EPERM`, or any other spawn-error code), never lands here.
- **`UNKNOWN`** — the probe ran but produced something the checker cannot
  confidently interpret (timeout, unparseable output, an ambiguous nonzero
  exit, a launcher-stub signature, a spawn error that isn't a confirmed
  `ENOENT` — H2). **Routed identically to `ABSENT` for gating** (never
  treated as OK, never silently retried as pass) but kept as a distinct,
  separately-reported outcome because its remediation differs from a plain
  "go install this" (see A2/A3/A4/H2).
- **`AMBIGUOUS_PG`** — the `postgres` row only (B2 below): two valid
  resolutions are simultaneously available and neither may be silently
  auto-picked.
- **`ABSENT_BUT_AVAILABLE`** — the `pgvector` row only (H4 below): the
  extension is installable on the connected Postgres server (it appears in
  `pg_available_extensions`) but is not yet installed in the current
  database. Gates as failing, exactly like `ABSENT`/`UNKNOWN`, but carries
  distinct remediation text (`CREATE EXTENSION vector;`, run by a human, not
  the checker) rather than an OS-level install command.

`--check-only` always runs every row; one row landing in a failing outcome
never suppresses or short-circuits the rest.

### Version parsing (A1/G1)

Every version probe is parsed with the strict, total regex
`^v?\d+\.\d+\.\d+$`, applied to each whitespace-delimited token of the
probe's stdout (not the whole line — `codex --version` prints
`codex-cli 0.153.4`, `node --version` prints `v22.9.0` alone). The first
token that matches **in full** is the version; every other shape —
two-part (`22.9`), a bare major (`22`), a range, a prerelease/build suffix
(`22.9.0-beta.1`, `22.9.0rc1`), or no matching token at all — is `UNKNOWN`,
never coerced into "close enough" or silently treated as passing the
minimum. This is a total classification, not an allow-list of accepted
formats: anything that isn't the one recognized shape is UNKNOWN by
construction, not by an enumerated reject-list.

**Per-family version rule (B3):** the strict three-part rule above is the
default and applies to `node`/`git`/`gh`/`codex`/`claude`, but it is wrong
for PostgreSQL-family binaries — PostgreSQL 10+ reports a two-part version
(`postgres (PostgreSQL) 16.2`, `pg_dump (PostgreSQL) 18.0`), while versions
before 10 reported three-part (`9.6.24`). A Postgres-family row (`pg_dump`
today; any future `postgres`/`psql`/`pg_isready`/`SHOW server_version` row)
instead parses each whitespace token against `^\d+\.\d+(\.\d+)?$` — no `v`
prefix, two- or three-part only, still no prerelease/build suffix — so it
correctly reads the numeral out of the tool's own `(PostgreSQL) X.Y`
banner. A dev/beta build (`17devel`, `18beta2`) has no `.` in that token
and is still `UNKNOWN` by construction, never coerced. This is a second
total classification selected per prerequisite, not a loosening of the
rule above for everyone: `node`/`gh`/`codex`/`claude` keep the strict
three-part rule unchanged.

**git-family version rule (H1):** the strict three-part rule is also wrong
for `git` — real `git --version` output carries a platform-specific
packaging suffix the strict rule rejects outright:
`git version 2.49.0.windows.1` (Windows Git; `.windows.N`) and, less
commonly, an `.msysgit` suffix on older MSYS builds. macOS
(`git version 2.39.3 (Apple Git-146)`) and Linux (`git version 2.43.0`)
already have no such suffix on the token itself and already pass the
strict rule unchanged. The `git` row instead parses each token against a
three-part numeric PREFIX match that requires whatever immediately follows
the numeral to be either end-of-token or a literal `.` — real packaging
suffixes are accepted and ignored, while a merged-garbage or
prerelease/build shape (`2.49.0-rc1`, `2.49.0abc`) has no character
satisfying that boundary and still has no matching token, so it is
`UNKNOWN` by construction, exactly like every other family's rule. This is
a THIRD total classification selected per prerequisite (alongside the
default strict rule and the postgres-family rule above) — every family's
rule is a named, documented entry, and an unrecognized/omitted family name
falls back to the strict default, never silently matches everything.

### Empty/garbage output and launcher stubs (A2)

A process that spawns successfully but returns exit code `9009` (Windows
"not recognized" surfacing through a shell-wrapper spawn), empty stdout on
exit 0, or an otherwise-nonzero exit is **`UNKNOWN`, not `ABSENT`** — all
three are signs that *something* is sitting on `PATH` at that name
(a broken shim, a Windows Store app-execution alias, a stale wrapper
script) without being a confident "nothing is installed here" signal.
Treating these as `ABSENT` would print a plain install command that does
not fix the actual problem and might install a second, conflicting copy.
The remediation text for this outcome explicitly names **PATH alias
shadowing** as the likely cause and directs the user to run `where <cmd>`
(Windows) / `which -a <cmd>` (POSIX) to find and remove the shadowing
entry, rather than an install command. The checker never auto-installs
over an `UNKNOWN` row under `--yes`.

**Spawn-level errors: ENOENT vs. everything else (H2):** a spawn that fails
outright (the process never ran at all) is `ABSENT` **only** when the
error is a confirmed `ENOENT` — nothing resolves at that name. Any OTHER
spawn-error code (`EACCES`, `EPERM`, a broken interpreter shebang, an
antivirus block, or any other OS-level spawn failure) means something IS
sitting at that name but could not be launched — an ambiguous result,
never a confident "nothing is installed here." These classify `UNKNOWN`
with the error code embedded in the reason (`spawn_error_<code>`), routed
through the same non-gating-but-distinct treatment as every other
`UNKNOWN` above — never silently coerced to `ABSENT`'s confident absence,
and never auto-installed over under `--yes`.

### Host CLI probe — version AND functional (A3/A4)

The host CLI row is not satisfied by version parsing alone:

- **`codex`**: after the version token parses and meets the minimum, the
  checker resolves the directory of the binary that actually answered the
  probe and requires it to contain a `codex-code-mode-host*` sibling file
  (per `docs/hosts/codex.md` and the verified finding in
  `reference_codex_cli_working_binary_for_exec`: `~/.codex/.sandbox-bin`'s
  copy answers `--version` correctly but has no code-mode host, and every
  real MCP tool call then fails with "failed to spawn code-mode host").
  Missing the sibling binary is `UNKNOWN` (reason
  `missing_code_mode_host`), with remediation pointing at
  `HANDOFF_CODEX_BIN` and `docs/hosts/codex.md`, never `PRESENT_OK`. The
  sibling match requires the matching directory entry to be a regular FILE
  (`fs.statSync(...).isFile()`, which follows symlinks — a symlink
  resolving to a regular file still counts) — H3: a directory-entry NAME
  match alone is not sufficient, so a directory that happens to be named
  `codex-code-mode-host` never satisfies the check.
  Because a `--check-only` run and the later host-wiring step (§5 step 4)
  are two separate points in time, **PATH resolution is re-run at wiring
  time** rather than trusting the `--check-only` result (TOCTOU: PATH, or
  the binary at that path, can change between the two). `--check-only`
  resolves the binary directory via the SAME resolver
  `scripts/lib/codex-install.js`'s real `--host codex` install path uses
  (`discoverCodex` — the `HANDOFF_CODEX_BIN`-override-or-PATH/PATHEXT walk,
  confirmed by a `--version` probe) — never a second, invented resolver.
- **`claude`**: `claude --version` must parse per the version rule above,
  **and** the resolved binary must not be a desktop-app launcher stub. The
  functional check requires the CLI's own signature text
  (`Claude Code` / `(Claude Code)`) to appear in the probe's stdout
  alongside the version; a bare version number with no such marker is
  `UNKNOWN` (reason `desktop_launcher_suspected`), never `PRESENT_OK`.
- Under `--host both`, each host is classified independently — a missing or
  functionally-failing one never narrows or blocks the other's row.

### Docker/Postgres pair (A5/B2)

The Docker path is not satisfied by `docker compose version` alone — it
additionally probes `docker info` with a **15-second timeout at check
time** (A5: `docker compose version` can succeed against a CLI plugin with
no running daemon behind it; `docker info` is what actually confirms the
daemon answers). A `docker info` timeout or nonzero exit routes that path
to "unknown/unavailable", never a false `PRESENT_OK`.

Because Docker+compose and an external Postgres on port 5432 are
independently viable, and either or both may resolve, the `postgres` row
uses the closed five-outcome set from the top of this section rather than
a simple pass/fail:

| Docker path | External Postgres (5432) | User wants compose | Outcome |
|---|---|---|---|
| unresolvable | unresolvable | — | `ABSENT` |
| resolves | resolves | **yes** | **`AMBIGUOUS_PG`** — never silently pick one |
| resolves | resolves | no | `PRESENT_OK` (external wins by stated preference) |
| resolves | unresolvable | — | `PRESENT_OK` (compose) |
| unresolvable | resolves | — | `PRESENT_OK` (external) |
| either probe timed out / ambiguous | | | `UNKNOWN` |

`AMBIGUOUS_PG` forces an explicit choice (interactive prompt, or a required
`--pg-source docker|external` flag under `--yes`) before proceeding — it is
never resolved by a default preference.

### pgvector extension: read-only, total classification (H4)

`--check-only` is documented (§2) as writing nothing — the probe below is
READ-ONLY by construction, never `CREATE EXTENSION`, which would modify the
connected database. It runs at most two read-only queries:

1. `SELECT 1 FROM pg_extension WHERE extname='vector'` — is the extension
   already installed in the current database? A returned row is
   `PRESENT_OK`.
2. Only when query 1 returns no row:
   `SELECT * FROM pg_available_extensions WHERE name='vector'` — is it
   installable at all? A returned row is `ABSENT_BUT_AVAILABLE` (see §3's
   outcome list); no row is `ABSENT`.

Either query timing out, erroring (including a confirmed `ENOENT` — no
`psql` on `PATH`, which is UNKNOWN here, not ABSENT: this row classifies
the vector extension's state, not `psql`'s own presence), or returning a
nonzero exit is `UNKNOWN`, never a false `PRESENT_OK`/`ABSENT`. The Docker
path (`pgvector/pgvector:pg16` image) skips this probe entirely with an
explicit `docker_image_ships_vector` note — never silently marked pass with
no note, and never run against a Docker-provisioned Postgres that isn't up
yet. `ABSENT_BUT_AVAILABLE`'s remediation names the exact
`CREATE EXTENSION vector;` statement for a human (a database superuser) to
run — the checker itself never runs it, under `--yes` or otherwise (an
elevated-prerequisite action per B1).

### Embedder reachable or declined

HTTP probe to the configured vLLM/Ollama URL; 2xx is `PRESENT_OK`. Not
configured is `ABSENT`. The user may explicitly decline (degraded
FTS-only, per `docs/hosts/codex.md`) via `--no-embedder` — an explicit
decline is recorded and reported as `PRESENT_OK` with reason
`declined_degraded_fts_only`; it is never assumed from silence or from a
probe failure. When not declined, `--check-only` resolves the URL through
the SAME resolver the engine's own embed path uses
(`scripts/lib/embed.js`'s `resolveEmbedUrl`, itself a thin wrapper over
`scripts/lib/embedding-provider.js`'s tier 0 explicit / tier 1 this
project's `pipeline.yml` `knowledge:` section / tier 2 `VLLM_EMBED_URL` env
/ tier 3 user-scope default resolver) against this project's root
(`scripts/lib/shared.js`'s `findProjectRoot`) — never a second, invented
resolver.

### git

`git --version`; the same version-parsing rule applies. Any parseable
version satisfies the row (no stated minimum beyond "present and
functional").

### gh (optional) (G2)

`gh --version`. Absent (confirmed `ENOENT`) is `[SKIP]`, never a failure —
`gh` never gates `--check-only`'s exit code. A **nonzero exit that is not a
confirmed `ENOENT`** (`gh` present but erroring for some other reason —
auth prompt, corrupted install) is `UNKNOWN`, not `ABSENT`: since this row
never gates, the only consequence of getting this classification "wrong"
is a misleading status line, so the checker defaults to the more honest
`UNKNOWN` rather than asserting a confident absence it cannot back up.

### pg_dump (E1)

`pg_dump --version`, minimum matching the target Postgres major (16),
parsed with the Postgres-family per-family rule above (B3) — real
`pg_dump --version` output is `pg_dump (PostgreSQL) 18.0`, a two-part
version on PostgreSQL 10+. This is a full §3 row, required — not optional,
and not folded into the `postgres` row above, because §6's upgrade path
needs it independently of which Postgres source (Docker or external) was
chosen. `--upgrade` (§6) refuses outright if this row is `ABSENT` or
`UNKNOWN`.

## 4. Compose file

Two services only:

- **`postgres`** — `pgvector/pgvector:pg16`, named volume `pgdata`, bound to
  `127.0.0.1` only (never `0.0.0.0`). `POSTGRES_PASSWORD` is generated on
  first run as a **32+ character alphanumeric-only string** (no symbols —
  avoids `.env`/shell/connection-string quoting hazards) written into a
  `.gitignore`d `.env` — never a hardcoded default, never in
  `SHA256SUMS.txt`. That same first-run write also sets
  `MM_PG_PROVISIONED=compose` in `.env` — the provenance marker §7's
  `--purge-data` guard reads (F1).
- **`embedder`** (compose profile, off by default) — vLLM with a
  `deploy.resources.reservations.devices` GPU stanza; simply unactivated
  without a capable host GPU.

No `handoff-mcp` service (see header).

## 5. Init sequence

1. `docker compose up -d postgres` (skipped, with a note, if an external
   Postgres was resolved instead — including the resolution the user made
   explicitly after an `AMBIGUOUS_PG` prompt, §3).
2. Connection test (`psql -c "SELECT 1"`); refuse forward on failure,
   printing the attempted connection string, password redacted.
   - **Pre-existing `.env` (C2):** if `.env` already exists at this point
     (external-Postgres path, or a re-run), it is **never overwritten**.
     Its credentials are used for this connection test; if the test
     passes, that `.env` is reused as-is. If the test fails, the installer
     refuses forward with the failing connection string (password
     redacted) and instructs the user to fix or delete `.env` by hand —
     it does not regenerate a new password over a file that might be
     protecting a real, populated database.
3. `node scripts/handoff.js init` — existing interactive Q&A (QUICKSTART.md
   step 4); no silent defaults added by this layer.
4. Host wiring: `install.js --host claude` (hooks + slash commands) and/or
   `install.js --host codex` (MCP registration + hooks.json + skills),
   printing the `approval_mode` `tools.*` hand-add caveat from
   `docs/hosts/codex.md` whenever `--host codex` runs. Per A3/A4, the
   `codex`/`claude` binary is re-resolved here (not reused from the
   `--check-only` run) — this is the TOCTOU-safe wiring point.
5. Smoke test: `handoff_status` called through the host's own MCP path
   (`claude mcp` / `codex mcp`), not a bare script call.
6. Print next steps: quickstart link, `/handoff:status` or the `handoff`
   skill, `.env`/backup locations.

### Idempotent re-run (D1/D2)

Every per-host write in step 4 (and the `.env`/compose steps above)
re-detects its own prior state **before** writing, the same way `mergeHooks`/
`isOurs` already do for Claude-path hooks: running the full init sequence a
second time against an already-installed target is a no-op — no duplicate
hook entries, no duplicate MCP registration, no second password generation
over an existing `.env`. This is asserted as a test (§ below), not left as
an assumed property of "just re-run the same steps."

## 6. Upgrade

Requires the §3 `pg_dump` row to be `PRESENT_OK` — `--upgrade` refuses
outright (naming the failing row) if `pg_dump` is `ABSENT` or `UNKNOWN`
(E1): an upgrade with no working backup tool available is refused before
touching anything.

Compares the zip's `schema-manifest.json` `schema_epoch` to the DB's stored
`project_settings.schema_fingerprint` (`<epoch>:<hash>`). Same epoch: apply
in place. Higher epoch: `pg_dump` checkpoint first, then require an
`--epoch-ack=<n>` flag whose `<n>` **must equal the printed target epoch
exactly** (E2) — a mismatched or stale `<n>` (e.g. copy-pasted from a prior
run, or the target epoch changed between print and ack) refuses with both
epochs named, the same as omitting the flag entirely. **Never downgrades**
— a lower zip epoch is a hard refuse, no override exists.

## 7. Uninstall

Removes: Claude-path hook entries (via `install.js`'s own `mergeHooks`/
`isOurs` identity match — no other tool's hooks touched), the Codex MCP
registration and `hooks.json` entries, copied slash commands, and
marker-carrying skill files.

- **Hand-edited hook entry (F2):** if a hook entry that matches our
  command shape has been hand-edited (e.g. `isOurs`'s identity match still
  fires but the command string, timeout, or a sibling field was altered
  from what this installer would have written), uninstall **reports it and
  leaves it in place** — it is never silently deleted. A hand-edit is a
  signal someone is relying on the modified behavior; deleting on top of
  that is a real command that removes real information for exactly the
  scenario the identity match exists to avoid.

Data (Postgres DB, `pgdata` volume, `~/.claude/projects/<uuid>/handoff.md`)
is kept by default. `--purge-data` drops it behind two separate typed
confirmations, stated as irreversible before the first prompt, **and**
refuses outright unless `.env` records `MM_PG_PROVISIONED=compose` (F1) —
i.e. unless this installer's own compose step provisioned the Postgres
instance being purged. An external Postgres (no matter how it was
resolved at init) is never dropped by `--purge-data`; the flag has no
override for this refusal.

## 8. Non-goals

No HTTP/streamable MCP service; no `handoff-mcp` container; no npm publish
of the package; no engine/schema rearchitecting (packages existing
behavior only); no SQLite install path (Postgres-only; SQLite stays a
source-repo seam-test arm, never packaged).

## Blind spots

Cannot detect: actual GPU driver/CUDA state in-container (only the compose
reservation stanza is checked); corporate proxy/TLS interception breaking
Docker/npm/pgvector downloads silently; the live Postgres auth method
(peer/trust/scram) beyond "can connect and create an extension" — unusual
`pg_hba.conf` rules can still fail undiagnosed; a host CLI installed
outside `PATH`/`PATHEXT` (reports `ABSENT` even if present elsewhere,
same as before — re-resolving at wiring time per A3/A4 closes the TOCTOU
gap but not this one); whether a `codex-code-mode-host*` sibling that
exists but is itself broken/incompatible actually works (existence-only
check, not an invocation check); real per-OS package-manager elevation
prompts (B1's "never auto-run elevated" rule is enforced by never
attempting the elevated command under `--yes`, not by detecting elevation
at runtime).
Unverified while drafting: whether "public `memory-manager` repo" means a
still-planned repo split (CONSOLIDATION-RUNBOOK.md §11.6/V10) or this
current `claude-memory` repo — project CLAUDE.md and user MEMORY.md both
now say claude-memory is itself the public engine repo, so this spec
targets claude-memory's actual layout; the `SHA256SUMS.txt`/`VERSION`
convention proposed here is not confirmed against any existing
release-tooling (none was found in this repo).
