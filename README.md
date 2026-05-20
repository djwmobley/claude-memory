# claude-memory

Claude Code already has memory across sessions — it reads `CLAUDE.md` and
per-project memory files every time it starts. The problem is those files get
stale: notes pile up, old facts stay even after they stop being true, and when
the file gets long enough Claude can't reliably surface what's actually relevant
right now. This project sits on top of that built-in memory and manages it: it
tracks when notes were written, scores them for freshness, lets old facts be
marked as no longer true, and pulls up what's relevant to the current session
rather than dumping everything at once. It does this with no extra LLM calls per
write — the only model invocation is the Claude Code session you're already in.
And if you come back to a project after months away, it can bring the notes that
matter for that project back to the surface — even ones that had gone quiet in
the meantime.

---

## Before you invest time

This is overengineered for the median user. Most people who want cross-session
memory for Claude Code need something simpler, and there are lighter tools worth
looking at first.

Every layer here exists because the maintainer hit a real failure. None of the
complexity is speculative — it has receipts in commits and in
[docs/case-study.md](docs/case-study.md).

This is a hobby project. No SLAs, no support tier, things may break.

---

## Want to get it running?

Start at [QUICKSTART.md](QUICKSTART.md). Takes about 15 minutes if Postgres is
already installed.

---

## What you'll need

Node 22+, Postgres 13+, pgvector 0.8.1+ (for vector search — optional but
recommended). Full list and check commands in [PREREQS.md](PREREQS.md).

---

## How it works (one minute version)

Think of claude-memory as a journal that also comes with a personal librarian.
At the end of each work session, Claude writes journal entries — what you
decided, what you tried, what broke, what worked. Each entry is a short note
about one specific thing. Over time, the journal fills up with dozens or
hundreds of these notes across many sessions.

The librarian wakes up at the start of every new session and picks the 30 or so
entries that matter most for right now — based on recency, confidence, and
meaning (not just keywords). Old entries that nobody has touched in months fade
toward the back of the shelf. They aren't deleted — if you come back to a
dormant project, the librarian notices, and pulls the relevant ones back to the
front. When a fact changes — a new project lead, a revised deadline — the old
entry is marked superseded rather than erased, so the history is preserved.

Full version: [docs/how-memory-works.md](docs/how-memory-works.md).

---

## The slash commands

| Command | What it does | Reference |
|---------|-------------|-----------|
| `/handoff:init` | First-run setup for a new project — creates the database tables and starter files. | [commands/handoff/init.md](commands/handoff/init.md) |
| `/handoff:status` | Quick check: project name, database connection, entry counts. | [commands/handoff/status.md](commands/handoff/status.md) |
| `/handoff:close` | Wrap up the session and write today's journal entries. Run this before you're done. | [commands/handoff/close.md](commands/handoff/close.md) |
| `/handoff:checkpoint` | Write entries mid-session without ending it. Useful for long sessions. | [commands/handoff/checkpoint.md](commands/handoff/checkpoint.md) |
| `/handoff:resume` | Force-load prior context even if it's been a long time since the last session. | [commands/handoff/resume.md](commands/handoff/resume.md) |
| `/handoff:drop` | Archive the current journal and start fresh. Use when a project phase is truly over. | [commands/handoff/drop.md](commands/handoff/drop.md) |
| `/handoff:purge` | Delete everything. No undo. Use with care. | [commands/handoff/purge.md](commands/handoff/purge.md) |
| `/handoff:promote` | Bump a journal entry into `CLAUDE.md` so it's always loaded, not just "when relevant." | [commands/handoff/promote.md](commands/handoff/promote.md) |

---

## Want a real example?

If you want to see how a design decision in this project actually got made —
including the two overstatements the maintainer caught in their own first draft
— read [docs/case-study.md](docs/case-study.md). It's the story of building the
"resurrection" feature: how to let old notes fade without losing them forever.

---

## Help when stuck

- [docs/troubleshooting.md](docs/troubleshooting.md) — common install and use errors
- [docs/glossary.md](docs/glossary.md) — what the jargon means
- [GitHub issues](https://github.com/djwmobley/claude-memory/issues) — open one if you hit something new

---

## For nerds

The system has more layers than most users will care about — drift hardening,
supersession, predicate registries, two-tier durability gates, vector embeddings
via vLLM. Each piece exists because of a specific failure. If you want to read
about all of that, the dense docs live in [docs/deep/](docs/deep/).

- `docs/deep/studies/` — methodology, comparative analyses, the original case study
- `docs/deep/specs/` — design specs (assertion extraction architecture, bundle A substrate, predicate normalization, memory bootstrap collision)
- [SECURITY.md](SECURITY.md) — trust model and CLAUDE.md auto-promotion guards
- [CONTRIBUTING.md](CONTRIBUTING.md) — contributor instructions and test suite docs

---

## License

MIT. Hobby project. No SLAs. Use at your own risk. Contributions welcome but
responses may be slow.
