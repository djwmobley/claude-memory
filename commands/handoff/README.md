# Slash commands

The eight `/handoff:*` slash commands give you and Claude handles on the memory layer.
Most of the time you'll only use two of them — `/handoff:close` at the end of a session,
and `/handoff:checkpoint` when you reach an important midpoint. The rest exist for setup,
debugging, and recovery.

---

## The two you'll use most

### /handoff:close

Run this at the end of a working session. Claude reads back over the conversation, pulls
out decisions, facts, and context worth keeping, and writes them to the database. It also
rewrites the `handoff.md` summary file so the next session can find what matters quickly.
If you skip it, the Stop hook does an automatic save — but the explicit close lets Claude
write a richer, better-organized summary. See [docs/how-memory-works.md](../../docs/how-memory-works.md)
for what gets saved and how.

### /handoff:checkpoint

Same extraction as `/handoff:close`, but the session stays open so you can keep working.
Use it whenever you hit a natural decision point in a long session and want to make sure
that progress is captured before you continue. Run `/handoff:close` when you're actually
done for the day.

---

## Setup commands

### /handoff:init

One-time setup for a new project. Creates the database tables, registers a default
retrieval contract, and writes a project-level `CLAUDE.md` if one doesn't exist yet.
Safe to re-run — it won't overwrite anything that's already there.

### /handoff:status

Read-only health check. Shows when the last session closed, how many entities and
assertions are in the database for this project, and whether a session is currently
in progress. Makes no writes — safe to run any time you want a quick reality check.

---

## Recovery and admin

### /handoff:resume

Force-loads context from the last session into the current conversation. The SessionStart
hook does this automatically when you open a new Claude session, but it skips loading if
the last session was more than seven days ago (to avoid flooding you with stale context).
Run `/handoff:resume` to override that and load anyway.

### /handoff:promote

Bumps a specific assertion to `CLAUDE.md` so it loads at every session start — not just
when retrieval decides it's relevant, but every single time. Use this for facts that
Claude should always know: "the repo lives at X," "we use Python 3.12," "never use
SQLite in production." You can find assertion IDs by running `/handoff:status` or
querying the database directly.

### /handoff:drop

Archives this project's notes and starts fresh. All existing assertions are suppressed
in retrieval (their confidence scores are set so low they never surface), and
`handoff.md` is archived with a datestamp. Nothing is permanently deleted — a developer
can recover rows via SQL if needed. Use this when a project phase is truly over and you
want a clean slate without losing the history entirely.

### /handoff:purge

Permanently deletes all memory for this project — entities, assertions, edges, retrieval
contracts, project settings, and `handoff.md`. **There is no undo.** The command will
ask for explicit confirmation before running. If you want to archive instead of delete,
use `/handoff:drop` instead.

---

## See also

- [docs/how-memory-works.md](../../docs/how-memory-works.md) — how the system uses what
  these commands write, and how retrieval decides what to surface
- [docs/troubleshooting.md](../../docs/troubleshooting.md) — if a command doesn't behave
  as expected
- Each command also has its own detail page in this directory — those pages double as the
  instructions Claude reads when you run the command, so they're more technical than this
  overview
