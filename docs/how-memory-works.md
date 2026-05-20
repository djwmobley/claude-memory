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

- `/handoff:init` — Set up the journal for a new project. Creates the database tables and the starter files. Run this once per project.
- `/handoff:status` — Quick check on how the journal is doing. Shows your project name, database connection, and how many entries exist.
- `/handoff:close` — Wrap up the session and write today's entries. Run this at the end of your work session. The librarian writes and saves all new notes. Code pointers (`file:line`) in the served output are validated against the live file tree at close time: stale line numbers are auto-corrected, and pointers whose anchor can no longer be located are flagged in the Reconciliation section.
- `/handoff:checkpoint` — Write entries mid-session without ending the session. Useful for long sessions where you want to save progress partway through.
- `/handoff:resume` — Force the librarian to load context, even if it's been a long time. Normally the loader skips auto-injection if your last session was more than a week ago — this overrides that. Code pointers are validated against the live file tree on resume as well; stale line numbers are corrected in the served output, but corrections are not persisted (close is the mutation point).
- `/handoff:drop` — Archive the current journal and start fresh. The old entries are kept but set aside. Use this when a project phase is truly over and you want a clean slate.
- `/handoff:purge` — Delete everything. No undo. Use with care.
- `/handoff:promote` — Bump a journal entry up to `CLAUDE.md`. Promoted entries are always loaded, not just "when relevant." Use this for facts that are so fundamental Claude should never be without them.

---

## Where the journal lives

The journal has three parts, and they serve different purposes.

**The database.** The bulk of the journal — all the entries, scores, timestamps, history, and embeddings — lives in Postgres. Postgres is a separate program that stores your data durably, even if Node stops running or your laptop restarts. It's also what makes vector search possible: the meaning fingerprints for every entry are stored here, and the librarian queries them to find relevant notes. When the librarian picks your 30 entries at session start, she's running queries against this database.

**The handoff file.** A plain text summary lives at `~/.claude/projects/<your-project>/handoff.md`. This is a lightweight snapshot that the loader hook reads at session start — a quick reference that covers the most recent session without having to query the full database first. Think of it as the librarian's notepad from yesterday, sitting on the desk when she arrives this morning. You don't edit this file by hand. `/handoff:close` writes it; `/handoff:resume` reads it explicitly if the session has been quiet for a while.

**CLAUDE.md.** The `CLAUDE.md` file at the root of your project is special. Claude reads it automatically at the start of *every* session, before any search or hook runs. It's not filtered or scored — everything in it lands in Claude's context unconditionally. Running `/handoff:promote` moves a journal entry here when you decide a fact is so fundamental that Claude should never work without it. Standing preferences, non-negotiable decisions, critical constraints. Think of `CLAUDE.md` as Claude's permanent briefing sheet. The database is the full archive behind it.

---

## A word on what the hooks are doing

The QUICKSTART mentions "hooks" — session hooks that run at start and stop. A hook is just a script that fires automatically at a specific moment. You don't need to understand the internals, but here's the plain-English version of what each one does.

**SessionStart hook.** Runs before Claude reads your first message. It connects to the database, runs the retrieval queries (recency, confidence, vector search, resurrect check), and writes the selected entries into the session context. The librarian arriving for work, in other words.

**Stop hook.** Runs when the session ends or Claude stops. It writes a brief status record. This is not the same as `/handoff:close` — the stop hook is lightweight housekeeping. The full session summary (the 5-15 new journal entries) only gets written when you explicitly run `/handoff:close`.

This distinction matters. If you close the window without running `/handoff:close`, the session's decisions and findings don't get saved to the journal. The stop hook catches the session ended, but it doesn't extract what happened. Run `/handoff:close` before you're done.

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
