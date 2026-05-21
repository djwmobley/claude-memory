# Glossary

This is a quick-reference for the terms you'll see across the docs in this project. Most entries are one to three sentences — just enough to make the next paragraph make sense. If a term you saw isn't here, please [file an issue](https://github.com/djwmobley/claude-memory/issues).

---

### [STALE: now "…"] annotation

A suffix appended to a served assertion line when the serve-time reality re-probe detects that the asserted value no longer matches live ground truth. Example:

```
- [model_extracted|conf=9] feat/my-feature branch_exists exists [STALE: now "<absent>"]
```

The annotation appears only for predicates registered with `mode:'verify'` in the L3 reality-check registry (`scripts/lib/reality-checks.js`). Rows that still match get `[verified✓]`; rows whose probe cannot run are left unannotated (`unverifiable`). The `reality_check` column is refreshed in the database at the same time (fail-soft; only `reality_check` is written — confidence, source, tier, and object are never modified). See also: **serve-time reality re-probe**, **reality_check**.

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

A markdown file that lives outside your repo (in a private `~/.claude/projects/` folder). After the north-star inversion, this file is a **thin pointer** — it carries only the project metadata header (project ID, last close time, contract name, session summary counts) and refers to Postgres for TL;DR, open threads, and quick references. It is not the prose store of session state. You do not edit it by hand — `/handoff:close` renders it; the loader reads the contract name from it at session start. See also: **north-star inversion**, **North star**, **session intent section**, **session seam**.

### HNSW

The type of index Postgres (via pgvector) uses to make vector search fast. Without it, searching by meaning would mean comparing every note to your query one by one; HNSW makes that comparison much faster as your note collection grows.

### Knowledge graph

The overall structure that stores entities, edges, and assertions together. Rather than a flat list of notes, a knowledge graph lets you navigate relationships — "show me everything connected to the auth subsystem" or "what decisions affect this project?" — instead of just keyword-matching. See also: **entity**, **edge**, **assertion**.

### North star

The three goals this system must satisfy: (1) **lossless fidelity** — nothing planned or decided in a prior session is lost across the session boundary; (2) **a lean default resume** — minimal, decay-ranked context rather than a growing prose transcript; (3) **resurrection on demand** — a faded fact can be pulled back explicitly, because the system quiets rather than deletes. These goals rest on a load-bearing premise: the information that drives the next session must live in Postgres as queryable, decay-rankable rows — not in a markdown file. Prose cannot be decay-ranked, queried by topic, or resurrected; and it is overwritten wholesale on every close. See [docs/case-study.md — "The north star"](case-study.md) for the full narrative. See also: **north-star inversion**, **Handoff.md (thin pointer)**, **relay baton vs. court stenographer**, **decay**, **resurrect**, **session intent section**.

### North-star inversion

The architectural pivot that made the north-star goals achievable. Before the inversion, `/handoff:close` wrote the session TL;DR, open threads, and quick references as narrative prose into the `handoff.md` body — which was replaced wholesale on every close and could not be decay-ranked, queried, or resurrected. The inversion rebuilt `/handoff:close` to persist that intent instead as queryable Postgres assertion rows under three dedicated predicates: `session_tldr`, `open_thread`, and `quick_reference`. These rows go through the same gated write path (`writeAssertionWithSupersession`) as all other assertions, so the L0/L2 consolidation gate applies. As a result, `handoff.md` was demoted to a thin pointer — metadata header only — while the session-driving content moved to Postgres where it can be ranked, queried, and resurrected. The north-star test suite, written RED by design before this rebuild, went green unmodified after the inversion. See [docs/case-study.md — "The rebuild that turned it green"](case-study.md) for the full narrative. See also: **North star**, **Handoff.md (thin pointer)**, **session_tldr**, **open_thread**, **quick_reference**, **session intent section**.

### pgvector

A Postgres add-on (extension) that teaches Postgres how to store and search embeddings. Without it, Postgres only knows how to search for exact words or numbers. With it, Postgres can do vector search — find notes by meaning, not just by text match. See also: **embedding**, **vector search**.

### Predicate

The "verb" part of an assertion — the type of fact being recorded. In the assertion "the project status is active", the predicate is `is_status`. In "the user prefers plain English", it's `prefers`. Predicates are registered in a central list so the system knows whether a given fact type can only ever have one value (like status) or many (like tags). See also: **assertion**, **superseded**.

### Prune

Deliberate hard-delete of selected assertion rows — distinct from **decay** (lowers a score, keeps the row) and **superseded** (replaces a fact, preserves history as a suppressed row). Pruning is a destructive, irreversible removal from the database.

Pruning IS implemented, as an **operator-only engine subcommand** invoked directly against the script:

```
node scripts/handoff.js prune [criteria] [--apply]
```

It is NOT a Claude Code `/handoff:` slash command — there is no `commands/handoff/prune.md`. The subcommand prints `Running: handoff:prune` to stdout when invoked, but you run it via `node scripts/handoff.js prune`, not by typing a slash command in Claude Code. It is never triggered automatically.

**Behavior:** dry-run by default (prints what WOULD be deleted, zero DB changes); `--apply` performs the hard DELETE.

**At least one criterion flag is required** — running with no criteria is refused (that is what `purge` is for). Criteria are AND-combined:

- `--suppressed` — rows where `suppressed = true`
- `--suppression-kind <kind>` — rows where `suppression_kind` matches (`superseded`, `downvoted_terminal`, `downvoted_probation`)
- `--subject <s>` — rows where subject canonicalizes to the given value
- `--older-than <days>` — rows where `last_reinforced` is older than N days

**Scope:** assertions only — entities and edges are out of scope. Always project-scoped (never touches other projects). Pinned rows are never deleted unless `--include-pinned` is given.

Distinct from `/handoff:purge` (hard-deletes ALL project memory for the current project, with confirmation) and `/handoff:drop` (archives prior memory and starts a clean slate).

See also: **decay**, **superseded**, **resurrect**.

### Resurrect

When a note that had gone quiet — low score, not seen in a while — gets pulled back up because the current session looks relevant to it. Think of it like a librarian who notices you're asking about a topic and goes to the back shelf to pull out a folder that hadn't been touched in months. Resurrection is triggered by semantic similarity, not just recency. See also: **decay**, **stale**, **vector search**.

### Retrieval contract

The set of queries Claude runs at session start to decide which notes to load into context. It's stored in the database per project, so you can tune what gets surfaced without editing code. A typical contract asks for recent assertions, high-confidence entities, and anything semantically close to the current project focus. See [docs/deep/retrieval-contract-evolution.md](deep/retrieval-contract-evolution.md) for how the contract has evolved.

### Session

One continuous conversation with Claude Code — from when you open a chat to when you close it or Claude stops responding. Each session gets its own record in the database. Notes written in one session are available in the next one because of the session hooks and the handoff file. See also: **handoff.md**, **slash command**.

### Slash command

A `/foo` command you type into Claude Code. This project adds nine of them — `/handoff:init`, `/handoff:status`, `/handoff:resume`, `/handoff:close`, and a few more. Each one is a short recipe file in `commands/handoff/` that tells Claude what to do. You install them by copying those files to `~/.claude/commands/handoff/`.

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

### branch_exists

A predicate (cardinality 1:1, `mode:'verify'`) that records whether a named git branch currently exists. Subject = the branch name; object = `"exists"` (verified form) or `"<absent>"` (when branch has been deleted). Probed by `probeBranchExists` in the L3 registry (local then remote). At close time, if the probe detects a mismatch, the stale row is **reconciled** (see: **reality reconciliation**) rather than flagged as degraded. At the next resume after a branch is deleted, the served line will show `[STALE: now "<absent>"]`. See also: **[STALE: now "…"] annotation**, **serve-time reality re-probe**, **reality reconciliation**.

### commit_merged

A predicate (cardinality 1:1, `mode:'verify'`) that records whether a given commit SHA has been merged into a target branch. Subject = the entity the commit belongs to; object = the asserted value in the form `"<sha>"` or `"<sha> on <branch>"` (e.g. `"0f07baa on main"`). Probed via `git merge-base --is-ancestor`. On success the probe echoes back the asserted object (not a fixed sentinel) — so `runVerifyDispatch` tags the row `'verified'` only when `probeResult === row.object`. On non-ancestor the probe returns `"<not-merged>"` (mismatch). On any error (git unavailable, commit not found, bad format, timeout) the probe returns `null` (fail-soft → `'unverifiable'`). A row whose object is the bare string `"merged"` is permanently unverifiable because the probe cannot parse `"merged"` as a SHA. See also: **[STALE: now "…"] annotation**, **serve-time reality re-probe**, **reality reconciliation**.

### in_file

A predicate (`mode:'verify'`) that records that something (a function, a constant, a section) lives in a particular file. Object = a relative or absolute file path. Probed by checking file existence on disk — returns the path when the file exists (verified), `'<absent>'` when it does not (mismatch), `null` when the object is not path-like (unverifiable). Used as the deterministic test probe because no network or git required. See also: **[STALE: now "…"] annotation**, **serve-time reality re-probe**.

### pr_state

A predicate (cardinality 1:1, `mode:'verify'`) that records the current GitHub PR state. Subject must contain the PR number (e.g. `"PR #92"`); object is `"open"`, `"closed"`, or `"merged"`. Probed via `gh pr view <number> --json state` with a 5-second timeout. Fails soft to `null` (unverifiable) when `gh` is offline, unauthenticated, or the PR is not found — never hangs the serve path. See also: **[STALE: now "…"] annotation**, **serve-time reality re-probe**.

### reality_check

A column on the `assertions` table that records the most recent probe result for a verify-mode assertion. Values: `'verified'` (probe matched), `'mismatch'` (probe returned a different value), `'unverifiable'` (probe returned null — cannot determine), or NULL (not yet probed). Written by the close-time L3 verify pass and refreshed (fail-soft) by the serve-time reality re-probe. The L2 consolidation gate's `hasQualityCorroborator` check reads this column — a stale `'verified'` on a row whose probe now mismatches cannot grant unearned trust because the pre-write refresh pass refreshes it before `writeExtraction` runs. INVARIANT: only `reality_check` is ever written by the verify/re-probe passes — confidence, source, tier, and object are never modified (see §7 no-backfill). Close-time mismatches on pre-existing rows trigger **reality reconciliation** rather than a degraded-close record. See also: **[STALE: now "…"] annotation**, **serve-time reality re-probe**, **reality reconciliation**.

### serve-time reality re-probe

The mechanism that re-runs `mode:'verify'` probes against live ground truth every time assertions are served (resume, resurrect, SessionStart hook). Addresses the frozen-tag problem: close-time verify tags freeze at the point the close runs; between sessions, real-world state can shift (a branch deleted, a PR merged, a file moved). The re-probe refreshes `reality_check` in the database and annotates mismatched rows with `[STALE: now "…"]` in the served output. Feature-gated via `serve_time_reality_check` project setting (default `'enabled'`). The serve path is read-annotate only — it never suppresses or supersedes rows. Close-time reconciliation (see: **reality reconciliation**) is a separate, write-path-only operation. See also: **[STALE: now "…"] annotation**, **reality_check**, **in_file**, **branch_exists**, **commit_merged**, **pr_state**, **reality reconciliation**.

### reality reconciliation

The close-path mechanism that repairs stale assertions when the L3 verify pass detects a mismatch with a definitive probe result. Runs in the pre-write pass (before `writeExtraction`) so only pre-existing rows — not rows just authored in the current close — are affected. Behavior by predicate cardinality:

- **1:1 predicates** (`branch_exists`, `commit_merged`, `pr_state`): calls `writeAssertionWithSupersession` to suppress the stale row and insert a reality-correct successor (e.g., if a branch was deleted, inserts a new row with `object='<absent>'`). The successor will probe `'verified'` on the next close.
- **1:N predicates** (`in_file`): directly suppresses the stale row with `suppression_kind='reality_reconciled'`. No successor is inserted (the file no longer exists).

§7 no-backfill invariant: confidence, source, tier, and object of the stale row are never modified — only `suppressed`, `invalid_at`, and `suppression_kind` are written. No `degraded_close` record is created for reconciled rows; the perpetual-mismatch alarm loop is broken silently. See also: **reality_check**, **branch_exists**, **in_file**, **serve-time reality re-probe**.

---

## Want to go deeper?

These pages go into the design reasoning behind the concepts above:

- [**docs/deep/studies/decay-vs-dont-forget-and-resurrection.md**](deep/studies/decay-vs-dont-forget-and-resurrection.md) — how decay, devalue-vs-invalidate, and resurrection were designed and why they had to ship together
- [**docs/deep/studies/2026-05-memory-systems-comparison.md**](deep/studies/2026-05-memory-systems-comparison.md) — how this project compares to mem0, Graphiti/Zep, Letta, and others
- [**docs/deep/specs/**](deep/specs/) — detailed design specs for assertion extraction, predicate normalization, and the memory bootstrap
- [**docs/deep/retrieval-contract-evolution.md**](deep/retrieval-contract-evolution.md) — how the retrieval contract schema has changed over time
