# How Memory Works

This page explains what's happening behind the scenes when you use this project. You don't need any of this to use it — QUICKSTART.md is enough — but if you're curious why we did things this way, here's the story.

---

## The core analogy: a journal and a librarian

Think of claude-memory as a journal that also comes with a personal librarian.

At the end of each work session, Claude writes journal entries — what you decided, what you tried, what broke, what worked. Each entry is a short note about one specific thing. "We switched from SQLite to Postgres." "The auth bug turned out to be a stale token." "Jordan is the project lead now." Over time, the journal fills up with dozens or hundreds of these notes across many sessions.

The problem with a regular journal is that you'd have to read the whole thing every time you open it. That gets slow. More importantly, most of it isn't relevant to what you're doing *today*. If you're fixing a CSS bug, you don't need to re-read six months of notes about the database schema.

That's where the librarian comes in. Before Claude does anything in a new session, the librarian wakes up, opens the journal, and picks the 30 or so entries that matter most for right now. Recent entries get priority. Entries about this specific project get priority. Entries that match the theme of today's work get priority.

The librarian doesn't just keyword-search. She's read every entry and understands what each one is *about*. If you say "do you have anything about that login bug?", she can pull up an entry called "OAuth token refresh fails" even though neither word in your question appears in that entry title. They're about the same thing, and she knows it.

She also makes sure the journal doesn't grow stale. Old entries that nobody has touched in months get quietly moved toward the back of the shelf. They're not thrown away — you might come back to that project someday, and then you'll want them — but they stop crowding the front of the line.

And if you *do* come back to an old project after months away, the librarian notices. She sees what you're working on, goes to the back shelf, and pulls the dormant entries for that project back to the front. They become relevant again, so they get treated as relevant again.

That's the whole system. A journal that grows with your work, and a librarian who makes sure Claude only sees the parts that matter today.

---

## Walk-through: one full session

Here's what that looks like in practice, from the moment you open Claude Code to the moment you close it.

A note on timing: the journal and the librarian work in the background. You don't have to do anything special to trigger them except run `/handoff:close` at the end of a session. The session-start loading happens automatically, before your first message. The database queries are fast — typically under a second. You won't notice them.

### Session starts

You open Claude Code. Before Claude reads your first message, a background script runs automatically. This is the "loader hook" — it's the librarian arriving for work.

The librarian opens the journal (the database), runs a few searches, and selects roughly 30 entries. She picks them based on what's recent, what's high-confidence, and what's thematically close to this project. Then she hands those 30 entries to Claude as part of its starting context.

Claude begins the session already knowing things like "last week we decided to switch to Postgres because SQLite was too slow" or "the project lead as of two sessions ago is Jordan." Claude didn't need you to repeat any of that.

There is one exception. If your last session was more than seven days ago, the loader pauses before auto-injecting old context. It warns Claude that the journal might be stale and holds off on loading automatically. The journal is still there — nothing was lost — but you may want to explicitly run `/handoff:resume` to confirm you want the old context loaded. This prevents a months-old session from silently flooding a new project with irrelevant context.

### You work

The session runs normally. You ask questions, Claude writes code, you review it, you make decisions. Claude is drawing on those 30 loaded entries the whole time, the same way you'd draw on notes you made before a meeting.

This is why Claude can say "oh right, last time we decided not to use caching here because of the race condition" — even though you never mentioned that in today's session. It was in a journal entry from three weeks ago, and the librarian pulled it because it was relevant.

If something comes up that the librarian *didn't* pull — maybe you ask about a decision from eight months ago — Claude can ask her to check the back shelves. She runs a vector search: she compares the meaning of your question to everything in the journal and brings back whatever matches, regardless of age.

### You wrap up

When you're done, you type `/handoff:close`. This is the moment Claude sits down and writes today's journal entries.

Claude reads back over the session and figures out what's worth keeping. It writes 5 to 15 new entries. A decision you made and why. A bug you fixed and what caused it. A preference you expressed. A fact that changed — like a new project lead or a revised deadline. Each note goes into the database with a timestamp and a confidence score.

Not everything makes it in. Casual back-and-forth doesn't get written down. What gets written are the durable things — the kind of stuff that you'd want to brief a teammate on if they were taking over this project tomorrow.

### Session ends

The journal is saved. The librarian goes to sleep. The session is over.

Next time you open Claude Code, the librarian wakes up and runs those searches again. Some of the entries she pulls will be ones you just wrote — they're fresh, and fresh beats old, all else being equal. The cycle starts over.

---

## Confidence scores: how certain is Claude about what it wrote?

Not all journal entries are created equal.

Some entries come straight from something you said out loud: "I want you to always use TypeScript." That's a direct statement. Claude can be very confident about it. It gets a high score — an 8 or 9 out of 10.

Other entries are inferences. Claude sees that you keep running tests before committing and writes "the user appears to prefer test-first development." That might be right. But Claude didn't hear you say it. So it gets a lower score — maybe a 4 or 5.

Confidence matters for two reasons. First, high-confidence entries are more likely to make it into the 30 the librarian loads at session start. Low-confidence entries have to be more relevant or more recent to compete. Second, only entries with very high confidence get promoted to `CLAUDE.md` — the permanent briefing sheet. You don't want guesses in there.

If Claude got an inference wrong, you can correct it. The old entry gets superseded. The new one — which is a direct statement from you — gets a higher confidence score.

---

## How the librarian decides what to show

The librarian uses four mechanisms to pick which entries to load. Each one solves a specific problem.

### Recency

Fresh entries get priority. If you wrote a note yesterday, it floats toward the top of the pile. A note from six months ago that nobody has looked at since drifts toward the back.

This is just common sense. What happened last week is usually more relevant than what happened last year — unless last year's note is still the ground truth.

Recency alone isn't enough, though. A note written yesterday about an unrelated project shouldn't beat a note written three months ago about the specific bug you're debugging today. That's why recency works together with the other three mechanisms — it's one signal, not the only signal.

### Decay

Old, never-touched entries fade. Not disappear — fade. Their score drops slowly over time. If you haven't opened a project in six months, the entries from that project get quieter and quieter. They stop competing with notes from projects you're actively working on.

The key word is *quietly*. The entries are still there. If you come back to that project, they can be found. They just don't shout anymore.

Why not just delete them? Because you might come back. And when you do, stale notes are better than no notes. Decay is a volume knob, not a delete button.

### Vector search

This is the part that feels a little like magic.

Every journal entry has a meaning fingerprint — a list of numbers that captures what the entry is *about*, not just the words it uses. The fingerprint for "OAuth token refresh fails" sits numerically close to the fingerprint for "login is broken." They're about the same kind of problem. When the librarian searches for relevant entries, she compares fingerprints, not words.

This is what makes "find me anything about the auth bug" work even when the original note never used the word "auth." The librarian isn't hunting for the phrase — she's hunting for notes that sit in the same part of meaning-space.

The glossary calls this **vector search**. The key thing to know is that it's a search by meaning, not by text. The original notes don't have to use the same words as your question. They just have to be *about* a similar thing.

### Resurrect

Decay is good, but there's a problem: what if you come back to an old project after months away? All those entries that faded — you need them again, and you need them fast.

The librarian handles this with a "resurrect" check. At session start, she looks at what project you're in and what you seem to be working on. If she has dormant notes about the current topic — ones that had decayed to the back shelves — she pulls them forward and gives them a freshness bump.

Think of it like a librarian who watches you walk in, sees you're wearing a lab coat and carrying chemistry textbooks, and goes to pull the chemistry section before you even ask. She doesn't wait for you to describe what you need. She reads the situation.

This way, decay doesn't mean "forgotten forever." It means "quiet until relevant again." The entries go dormant, and they come back when they're needed.

If the automatic resurrect at session start didn't surface a subject you know is in the journal, you can target it directly with `/handoff:resurrect` — the manual, on-demand counterpart to this automatic pass. Unlike the automatic check, which bumps freshness across a broad topic inferred from context, the command takes a specific seed topic and can go further: with `--revive`, it can fully un-suppress rows that were downgraded to probationary status, not just bring them to the front of the queue.

---

## Why supersession (and what that word means)

Sometimes Claude writes a new fact that contradicts an old one.

Last month the note said "the project lead is Alice." This week it should say "the project lead is now Bob." What happens to the old entry?

We don't delete it. We mark it as **superseded**.

The old entry stays in the journal with a label that says "true until [date], replaced by [new entry]." From that point on:

- Claude never sees the old entry during normal retrieval. It's excluded from the current truth.
- The history is preserved. You can ask "when did this change?" and get a real answer.
- If the new entry turns out to be wrong, the old one is still there.

Think of it like crossing something out in a notebook rather than erasing it. The crossed-out version is still readable. You know it used to be true. You know when it changed. If you crossed it out by mistake, you can uncross it.

Erasing would be simpler. But erasing loses information you might want later. When did the decision change? Was it before or after the big refactor? Did Alice hand off the project or was she removed? With supersession, those questions have answers. With erasure, they don't.

This is especially important for high-stakes facts — project status, ownership, architectural decisions. You want a record of how things evolved, not just a snapshot of where they are now.

---

## The slash commands, in plain English

These are the commands you type to interact with the journal. Each one is a short recipe that tells Claude what to do.

- `/handoff:init` — Set up the journal for a new project. Creates the database tables and the starter files. Run this once per project. Pass an optional project name (`/handoff:init "my-project"`) and `-y` to skip the interactive DB-creation prompt.
- `/handoff:status` — Quick check on how the journal is doing. Shows your project name, database connection, and how many entries exist. Add `--json` for structured output, `--breakdown` for per-tier counts, or `--stale-pointers` to count code pointers that no longer resolve.
- `/handoff:close` — Wrap up the session and write today's entries. Run this at the end of your work session. Pass `--json` to supply the extraction payload via stdin; add `--dry-run` to validate and preview the write without touching the database. Code pointers (`file:line`) in the served output are validated against the live file tree at close time: stale line numbers are auto-corrected, and pointers whose anchor can no longer be located are flagged in the Reconciliation section.
- `/handoff:checkpoint` — Write entries mid-session without ending the session. Useful for long sessions where you want to save progress partway through. Pass `--json` for a full payload via stdin, or `--note "<text>"` to capture a single line without composing a full payload.
- `/handoff:resume` — Force the librarian to load context, even if it's been a long time. Normally the loader skips auto-injection if your last session was more than a week ago — this overrides that. Code pointers are validated against the live file tree on resume as well; stale line numbers are corrected in the served output, but corrections are not persisted (close is the mutation point).
- `/handoff:drop` — Archive the current journal and start fresh. The old entries are kept but set aside. Use this when a project phase is truly over and you want a clean slate.
- `/handoff:purge` — Delete everything. No undo. Use with care. Pass `--dry-run` to see row counts before committing, or `--yes` to skip the confirmation prompt.
- `/handoff:promote` — Bump a journal entry up to `CLAUDE.md`. Promoted entries are always loaded, not just "when relevant." Pass an assertion ID (`/handoff:promote 42`) or use `--subject`/`--predicate`/`--object` to find the entry by content. To reverse a prior promotion, use `--demote <id>`.
- `/handoff:resurrect` — Pull specific dormant notes back to the surface by topic. Use this when you return to a project after a long gap and want to bring back decayed entries on a particular subject — for example, "resurrect notes about the auth bug." By default it is a dry-run (shows what would come back without changing anything); pass `--revive` (or `-r`) to actually un-suppress the matched rows. Use `--limit=N` to cap the candidate set size, or `--json` for structured output.

---

## Where the journal lives

The journal has three parts, and they serve different purposes.

**The database.** The bulk of the journal — all the entries, scores, timestamps, history, and embeddings — lives in Postgres. Postgres is a separate program that stores your data durably, even if Node stops running or your laptop restarts. It's also what makes vector search possible: the meaning fingerprints for every entry are stored here, and the librarian queries them to find relevant notes. When the librarian picks your 30 entries at session start, she's running queries against this database.

**Session intent rows.** The three most session-critical items — the TL;DR, open threads, and quick references — are persisted as queryable Postgres rows, not just as prose in a file. Three dedicated predicates handle this: `session_tldr`, `open_thread`, and `quick_reference`. These rows are written at `/handoff:close`. Because they live in the database, they can be decay-ranked, queried by topic, and resurrected on demand just like any other journal entry. On resume, the loader surfaces them in a `### Session intent` section, ordered by relevance (decay-adjusted confidence).

**The handoff file (`handoff.md`).** A thin pointer lives at `~/.claude/projects/<project_id>/handoff.md` by default. This file no longer holds prose TL;DR, open threads, or quick references — those live in Postgres as queryable rows (see above). The file carries only the project metadata header (project ID, last close timestamp, contract name, session summary counts) and refers the reader to Postgres for session-driving content. You do not edit this file by hand. `/handoff:close` renders it; the loader reads the contract name from it at session start.

**CLAUDE.md.** The `CLAUDE.md` file at the root of your project is special. Claude reads it automatically at the start of *every* session, before any search or hook runs. It's not filtered or scored — everything in it lands in Claude's context unconditionally. Running `/handoff:promote` moves a journal entry here when you decide a fact is so fundamental that Claude should never work without it. Standing preferences, non-negotiable decisions, critical constraints. Think of `CLAUDE.md` as Claude's permanent briefing sheet. The database is the full archive behind it.

**Configuring these paths for a non-Claude-Code MCP client.** The three names above are Claude Code's defaults, not hard requirements — the engine is designed to run under any MCP-speaking client:

- **Project marker filename** — the file at the project root that identifies a project by a stable UUID is named `.memory-engine`. A project created before this became configurable may instead carry the legacy name `.claude-memory`, which is still recognized as a permanent read-fallback (no automatic rewrite; both names are never dual-written).
- **`HANDOFF_BASE_DIR`** — overrides the base directory for `handoff.md` (default: `~/.claude`, i.e. `os.homedir()/.claude`). Must be an absolute path in the current platform's native form — a drive-letter-rooted path on Windows (`C:\Users\you\.claude`), not an MSYS/Git-Bash-style `/c/Users/you/.claude` (that form passes a naive "is this absolute" check but resolves drive-relative to Windows APIs, which is rejected with an explanatory error).
- **`HANDOFF_PROMOTION_FILE`** — overrides the durable-facts promotion filename (default: `CLAUDE.md`). Must be a bare filename relative to the project root (no path separators, no `..` segment, not absolute) and cannot collide with the marker filename or `handoff.md`.

---

## A word on what the hooks are doing

The QUICKSTART mentions "hooks" — session hooks that run at start and stop. A hook is just a script that fires automatically at a specific moment. You don't need to understand the internals, but here's the plain-English version of what each one does.

**SessionStart hook.** Runs before Claude reads your first message. It connects to the database, runs the retrieval queries (recency, confidence, vector search, resurrect check — the resurrect path uses semantic embedding via vLLM with a pg_trgm fuzzy fallback), and writes the selected entries into the session context. The librarian arriving for work, in other words.

**Stop hook.** Runs when the session ends or Claude stops. It writes a brief status record. This is not the same as `/handoff:close` — the stop hook is lightweight housekeeping. The full session summary (the 5-15 new journal entries) only gets written when you explicitly run `/handoff:close`.

This distinction matters. If you close the window without running `/handoff:close`, the session's decisions and findings don't get saved to the journal. The stop hook catches the session ended, but it doesn't extract what happened. Run `/handoff:close` before you're done.

---

## Serve-time reality re-probe

At close time, `handoff.js` runs an L3 verify pass that probes every live assertion whose predicate has a `mode:'verify'` entry in the L3 reality-check registry. Each row gets a `reality_check` tag: `verified`, `mismatch`, or `unverifiable`.

The problem is that these tags freeze at close time. If an assertion is tagged `verified` at the end of one session, and the real-world state changes before the next session starts — a branch gets deleted, a PR gets merged, a file gets moved — the tag stays `verified` even though the ground truth has shifted.

The serve-time reality re-probe addresses this. Every time assertions are served to a session (via `/handoff:resume`, the SessionStart hook, or the resurrect path), the loader re-runs the same probes against current ground truth. For any row whose live probe result now differs from its asserted object, the served line is annotated:

```
- [model_extracted|conf=9] feat/my-feature branch_exists exists [STALE: now "<absent>"]
```

A `[verified✓]` suffix appears on rows that still match. Rows whose probe cannot run (git unavailable, `gh` offline) get `[unverifiable]` and are left unannotated to keep output clean.

The `reality_check` column is also refreshed in the database (fail-soft UPDATE — only `reality_check` is written; confidence, source, tier, and object are never touched). This means the L2 consolidation gate's quality-plug check (`hasQualityCorroborator`) sees fresh values at the next close — a stale frozen `verified` on a row whose probe now mismatches cannot grant unearned trust to an incoming cross-session corroborator.

**Feature gate.** The serve-time re-probe is enabled by default (`serve_time_reality_check = 'enabled'`). It can be disabled per-project:

```sql
INSERT INTO project_settings (project_id, key, value)
VALUES ('<your-project-id>', 'serve_time_reality_check', 'disabled')
ON CONFLICT (project_id, key) DO UPDATE SET value = 'disabled';
```

With the gate disabled, served output is byte-identical to pre-feature output.

**Volatile predicates.** Only predicates with a `mode:'verify'` entry in the registry are probed. The current set: `in_file`, `branch_exists`, `commit_merged`, `pr_state`, and `open_thread`. Historical then-state predicates (`is_at_commit`, `shipped_at`) are deliberately excluded — they record fixed historical points and must not be re-verified against now-state.

**open_thread staleness gate.** `open_thread` rows are now reality-checked at serve time against local git merge state. The probe looks for any PR numbers cited in the thread text (e.g. `#106`) and checks whether they appear in `git log` as squash-merged commit subjects of the form `(#NNN)`. If any cited PR is found merged, the served line is annotated `[STALE: now "merged: #NNN — verify thread is still open"]`. This is an informational nudge, not a claim that the thread is resolved — a merged base PR may have follow-up work still pending.

Because `open_thread` objects are freeform prose with no stable comparable value, the `open_thread` registry entry uses `annotateOnly: true`. This means `open_thread` rows are **excluded from both close-time passes**: the pre-write reconcile pass does not auto-suppress them, and the post-write L3 verify pass does not create degraded-close alarms for them. The annotation fires only at serve time.

**Close-time reconciliation.** When the close-path L3 verify pass (which runs before `writeExtraction`) detects a mismatch on a pre-existing row, it does not simply flag the row and write a degraded-close record. It **reconciles** the stale row to reality:

- **1:1 predicates** (`branch_exists`, `commit_merged`, `pr_state`): `writeAssertionWithSupersession` suppresses the stale row and inserts a reality-correct successor. The next close will find agreement and tag the successor `verified`.
- **1:N predicates** (`in_file`): the stale row is suppressed directly with `suppression_kind='reality_reconciled'`. No successor is inserted.

Reconciliation is close-path only — the serve path annotates and re-tags, but never suppresses or supersedes. The §7 no-backfill invariant holds: confidence, source, tier, and object of the stale row are never modified. See the glossary entry for **reality reconciliation** for full details.

---

## What this system is — and what it isn't

**The relay-baton model.** claude-memory is a session seam — a relay baton handed off between sessions. Its job is to carry continuity across session boundaries: capture the durable state at the end of one session, serve it leanly at the start of the next. The baton carries forward only what the next runner needs, not the full transcript of the race.

It is not a verbatim transcript, a running log, or always-on surveillance of every utterance. It is a relay, not a stenographer. The Limitations section below covers the practical consequences of that distinction.

For the full design-goals framing behind this model — the three things the system has to get right and the premise underneath them — see [docs/case-study.md](case-study.md#the-north-star).

---

## Limitations

**This is not a court stenographer.** claude-memory does not capture every utterance, every back-and-forth, or every intermediate thought in a session. It is not a verbatim transcript. "Lossless" means lossless *across the seam* — the information that matters is preserved as it crosses a session boundary.

**Capture happens at seams.** Extraction runs when you explicitly run `/handoff:close` or `/handoff:checkpoint`. What you produce *during* a session is not automatically recorded as it happens — it is recorded when you close or checkpoint.

**Mid-session insights that never reach a seam can be lost.** If you have a durable insight mid-session — a decision, a finding, a change of direction — and you close the window without running `/handoff:close`, that insight is not in the journal. The stop hook records the session ended; it does not extract what happened.

**Compaction is a real risk.** Claude Code's context compaction mechanism can summarize and compress early parts of a long session before `/handoff:close` runs. If a key insight arose early in the session and was compacted away before close, the extractor never sees it. Checkpointing mid-session (via `/handoff:checkpoint`) is the mitigation. This is the contract of a relay: hand off in the zone, not whenever you feel like it.

This is the relay-baton design, not a defect. The baton carries what you hand it. Hand it the important things.

### Project isolation and shared databases

**Isolation is logical, not physical — the blast radius is the whole database.** All projects share a single Postgres schema and the same tables (`entities`, `assertions`, `edges`, `retrieval_contract`, `project_settings`, and so on). There is no table-per-project, schema-per-project, or database-per-project. Every query filters on a `project_id` column, so cross-project leakage does not occur under normal operation, but that `WHERE` clause is the only thing standing between projects. A bad migration, a destructive query that omits the filter, or a schema corruption event affects all projects at once.

**`project_id` is the finest isolation grain — there is no per-user or per-author dimension.** A `session_id` column exists on some rows, but the retrieval path (including the semantic/vector cosine search) does not filter on it. Within a single project, every semantic search returns the full project history regardless of which person or session created the rows.

**On a shared Postgres, two developers on the same project see each other's memory.** The project marker file (`.memory-engine`; a project created before #135 may instead have the legacy `.claude-memory` name, which is still recognized as a read-fallback) holding the project UUID is committed to the repo by default, so every clone inherits the same `project_id`. If two developers point at a shared or team-hosted Postgres instance, one developer's retrieval — semantic search included — will surface the other's assertions, with nothing in the data model preventing it. The default local-per-machine database already isolates developers by the machine boundary even when they share a `project_id`; the exposure only materializes when a shared remote Postgres is introduced.

**Several mitigation levers exist, each with trade-offs.** The simplest is the default: keep Postgres local to each developer's machine, which provides isolation without any configuration. Gitignoring the marker file (`.memory-engine`, or `.claude-memory` on older projects) causes each clone to mint its own UUID, isolating per-clone even on a shared database — but if no marker file is present the system falls back to `encodeCwd(<absolute path>)`, which can collide if two developers use the same absolute project path. For hard multi-tenant isolation on a shared database, escalate to a Postgres schema-per-project (via `search_path`) or a database-per-project; either approach prevents the logical-only failure mode, at the cost of fanning every migration out across all tenants.

---

## What's NOT in this page

There's a lot more going on under the hood — drift hardening, predicate registries, confidence-decay math, two-tier durability gates. Those exist because the maintainer hit specific failures and built specific fixes.

The short version: every one of those features started as a bug report. The decay math got tuned because entries were disappearing when they shouldn't. The resurrect ring was built because decay was too aggressive for long-running projects. The supersession model was chosen because erasure kept losing history at inconvenient moments.

If you want to read about any of that, see [docs/deep/](deep/). For most users, you don't need any of it. The journal and the librarian are doing their job quietly, and you don't have to think about how the back rooms are organized.

---

## Next steps

Start with QUICKSTART.md if you haven't already — it gets you set up in about ten minutes. Then come back here if you want to understand why things work the way they do.

- [docs/case-study.md](case-study.md) — see one of those "specific failures and specific fixes" in detail (the decay-vs-don't-forget story).
- [docs/glossary.md](glossary.md) — definitions for anything that was still unclear after reading this page.
- [docs/troubleshooting.md](troubleshooting.md) — if something isn't working.
