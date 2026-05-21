# Glossary

This is a quick-reference for the terms you'll see across the docs in this project. Most entries are one to three sentences — just enough to make the next paragraph make sense. If a term you saw isn't here, please [file an issue](https://github.com/djwmobley/claude-memory/issues).

---

### Assertion

A single fact that Claude wrote down. Think of it like one line in a notebook: "the project name is my-app", "the status is in-progress", "the user prefers plain English". Every assertion has a subject (what it's about), a predicate (the type of fact), and an object (the value). See also: **entity**, **predicate**.

### Bi-temporal

A fancy word for "we track two different timestamps for every fact." The first timestamp is when the fact was written down. The second is when it stopped being true (if it ever did). This lets you ask "what did Claude know on Tuesday?" as well as "what is Claude sure about right now?" — two different questions that would get confused if you only kept one clock.

### CLAUDE.md

A plain text file at the root of your project that Claude reads automatically at the start of every session. It's where standing instructions, preferences, and high-confidence durable facts live. Think of it as the briefing sheet Claude gets every morning before the workday starts. Running `/handoff:init` creates one for you.

### Confidence

A number from 1 to 10 that says how sure Claude is about a particular assertion. A confidence of 9 or 10 means Claude heard this directly from you and has seen it confirmed across multiple sessions. A 3 or 4 means it's a reasonable inference, but not something you said out loud. Confidence feeds into which facts get loaded at session start and which ones get promoted to `CLAUDE.md`.

### Decay

Facts that haven't been touched in a long time get a lower score in retrieval — they don't disappear, but they drift toward the back of the line. This is decay. It prevents a project you haven't touched in six months from flooding a new session with stale context. Facts that keep getting reaffirmed stay near the top. See also: **stale**, **resurrect**.

### Edge

A labeled connection between two entities. Where an assertion says something *about* one entity ("project X has status active"), an edge says something *between* two entities ("project X depends_on library Y"). Edges are how the knowledge graph tracks relationships, not just notes. See also: **knowledge graph**, **entity**.

### Embedding

A list of numbers — hundreds or thousands of them — that represent the *meaning* of a piece of text. Two pieces of text that mean similar things will have similar lists of numbers, even if they use completely different words. That's what makes vector search possible: instead of hunting for the exact phrase "auth bug", you can ask "find me anything related to login problems" and get relevant results back. See also: **vector search**, **pgvector**.

### Entity

A thing Claude is tracking — a project, a person, a decision, a file, a bug, a concept. Think of it like a Wikipedia page: the entity is the *subject*, and assertions are the facts written about it. If Claude knows "the lead developer is Jordan" and "the lead developer is on vacation", "lead developer" is the entity and both statements are assertions about it. See also: **assertion**, **edge**.

### Handoff.md (thin pointer)

A markdown file that lives outside your repo (in a private `~/.claude/projects/` folder). After the north-star inversion, this file is a **thin pointer** — it carries only the project metadata header (project ID, last close time, contract name, session summary counts) and refers to Postgres for TL;DR, open threads, and quick references. It is not the prose store of session state. You do not edit it by hand — `/handoff:close` renders it; the loader reads the contract name from it at session start. See also: **session intent section**, **session seam**.

### HNSW

The type of index Postgres (via pgvector) uses to make vector search fast. Without it, searching by meaning would mean comparing every note to your query one by one; HNSW makes that comparison much faster as your note collection grows.

### Knowledge graph

The overall structure that stores entities, edges, and assertions together. Rather than a flat list of notes, a knowledge graph lets you navigate relationships — "show me everything connected to the auth subsystem" or "what decisions affect this project?" — instead of just keyword-matching. See also: **entity**, **edge**, **assertion**.

### pgvector

A Postgres add-on (extension) that teaches Postgres how to store and search embeddings. Without it, Postgres only knows how to search for exact words or numbers. With it, Postgres can do vector search — find notes by meaning, not just by text match. See also: **embedding**, **vector search**.

### Predicate

The "verb" part of an assertion — the type of fact being recorded. In the assertion "the project status is active", the predicate is `is_status`. In "the user prefers plain English", it's `prefers`. Predicates are registered in a central list so the system knows whether a given fact type can only ever have one value (like status) or many (like tags). See also: **assertion**, **superseded**.

### Prune

Manually deleting assertions that aren't worth keeping. Unlike **decay** (which quietly reduces a note's score) or **superseded** (which replaces an old fact with a new one), pruning is a deliberate hard delete. The `/handoff:prune` command does a dry run by default — it shows you what would be removed before actually removing it.

### Resurrect

When a note that had gone quiet — low score, not seen in a while — gets pulled back up because the current session looks relevant to it. Think of it like a librarian who notices you're asking about a topic and goes to the back shelf to pull out a folder that hadn't been touched in months. Resurrection is triggered by semantic similarity, not just recency. See also: **decay**, **stale**, **vector search**.

### Retrieval contract

The set of queries Claude runs at session start to decide which notes to load into context. It's stored in the database per project, so you can tune what gets surfaced without editing code. A typical contract asks for recent assertions, high-confidence entities, and anything semantically close to the current project focus. See [docs/deep/retrieval-contract-evolution.md](deep/retrieval-contract-evolution.md) for how the contract has evolved.

### Session

One continuous conversation with Claude Code — from when you open a chat to when you close it or Claude stops responding. Each session gets its own record in the database. Notes written in one session are available in the next one because of the session hooks and the handoff file. See also: **handoff.md**, **slash command**.

### Slash command

A `/foo` command you type into Claude Code. This project adds eight of them — `/handoff:init`, `/handoff:status`, `/handoff:resume`, `/handoff:close`, and a few more. Each one is a short recipe file in `commands/handoff/` that tells Claude what to do. You install them by copying those files to `~/.claude/commands/handoff/`.

### Stale

Notes that haven't been touched in a long time. The session hooks check a `staleness_days` threshold (default: 7 days) before automatically injecting prior context. If your last session was more than that many days ago, the loader skips auto-injection and warns you instead — so you can decide whether to force-load with `/handoff:resume`. See also: **decay**, **resurrect**.

### Superseded

An old fact that's been replaced by a newer one. If Claude wrote "the project status is planning" last week and writes "the project status is active" today, the old row is marked superseded — it's kept in history but excluded from current retrieval. Both facts are preserved so you can see what changed and when. See also: **assertion**, **predicate**, **bi-temporal**.

### Vector search

Search by meaning, not exact words. If you ask "find me anything about login failures", vector search can surface a note that says "the OAuth token refresh was broken" — because those two things are semantically close, even though they share no exact words. It works by comparing **embeddings**. See also: **embedding**, **pgvector**, **HNSW**.

### open_thread

A predicate (cardinality 1:1) that persists a session-driving next-action as a queryable Postgres assertion row. One live row exists per thread-key (the subject, derived from the thread text). When a thread changes, the new row supersedes the prior one via the 1:1 uniqueness path. Written at `/handoff:close` through the gated assertion write path. Surfaced on resume in the `### Session intent` section. See also: **session_tldr**, **quick_reference**, **session intent section**.

### quick_reference

A predicate (cardinality 1:1) that persists a session quick-reference pointer block as a queryable Postgres assertion row; one live row per project (subject = project basename), latest supersedes prior. Written at `/handoff:close` through the gated write path. See also: **open_thread**, **session_tldr**, **session intent section**.

### Relay baton vs. court stenographer

The central identity distinction for this system. claude-memory is a **relay baton** — its job is to hand continuity across session boundaries, carrying only what the next runner needs. It is not a **court stenographer** — it does not capture a verbatim transcript of every utterance. "Lossless" is scoped to *across the seam*: everything important that crosses a session boundary is preserved. What never reaches a seam (unsaved mid-session work, compacted early context) is not preserved. This is a design contract, not a limitation to apologize for. See also: **session seam**, **Limitations** in `docs/how-memory-works.md`.

### session_tldr

A predicate (cardinality 1:1) that persists the session TL;DR as a queryable Postgres assertion row; one live row per project (subject = project basename), latest supersedes prior. Written at `/handoff:close` through the gated write path. See also: **open_thread**, **quick_reference**, **session intent section**.

### Session intent section

The `### Session intent` block that the loader surfaces at resume time. It is built by querying the `assertions` table for rows with `predicate IN ('open_thread', 'session_tldr', 'quick_reference')`, ordered by decay-adjusted confidence. It appears only when the retrieval contract does not already include an `assertion` or `recency` query (which would serve those rows via their own blocks). Suppressed and invalidated rows are excluded. See also: **open_thread**, **session_tldr**, **quick_reference**, **handoff.md (thin pointer)**.

### Session seam

The moment of transition between two Claude Code sessions — the point where `/handoff:close` or `/handoff:checkpoint` runs. The session seam is the only point at which session state is captured. Continuity is preserved *across the seam*, not continuously throughout a session. See also: **relay baton vs. court stenographer**, **Limitations** in `docs/how-memory-works.md`.

---

## Want to go deeper?

These pages go into the design reasoning behind the concepts above:

- [**docs/deep/studies/decay-vs-dont-forget-and-resurrection.md**](deep/studies/decay-vs-dont-forget-and-resurrection.md) — how decay, devalue-vs-invalidate, and resurrection were designed and why they had to ship together
- [**docs/deep/studies/2026-05-memory-systems-comparison.md**](deep/studies/2026-05-memory-systems-comparison.md) — how this project compares to mem0, Graphiti/Zep, Letta, and others
- [**docs/deep/specs/**](deep/specs/) — detailed design specs for assertion extraction, predicate normalization, and the memory bootstrap
- [**docs/deep/retrieval-contract-evolution.md**](deep/retrieval-contract-evolution.md) — how the retrieval contract schema has changed over time
