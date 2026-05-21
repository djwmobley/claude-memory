# Case Study: Building the Memory System That Forgets Gracefully

Two chapters. Each one is about a different design problem in this project, and each one is honest about what got shipped, what got caught, and what the methodology was.

---

# Chapter 1: Letting Old Notes Fade Without Losing Them

This is a worked example of how one design decision in this project got made.
It's the story of trying to let old notes fade without losing them — and the
two overstatements I caught in my own first answer before shipping.
If you're curious about how the rest of this project came together, this is
representative.

---

## The problem

The librarian analogy from [docs/how-memory-works.md](how-memory-works.md) is a
good place to start. Claude keeps a journal. At the end of every session, it
writes entries: decisions made, bugs fixed, facts that changed. The librarian
wakes up at the start of the next session, picks the 30 or so entries that are
most relevant, and hands them to Claude.

That works well when a project is active. But what happens when you step away?

Say you work on a project hard for two months. Hundreds of journal entries
accumulate. Then you get pulled onto something else for six months. When you
come back, all those notes are still there — but most of them are stale. "We
tried approach X and decided against it." "That bug was from a bad config, now
fixed." "Waiting on Jordan's review." None of that is useful anymore. It's
history, not current state.

The librarian can't tell the difference. Without guidance, she'd try to load all
of it — or load the most recent stuff from your *other* project, which is even
worse. The front shelf gets crowded with noise, and the signal gets buried.

So you have two bad options:

**Option A: Delete old notes aggressively.** Keeps the shelves clean. But you
lose real history. When you come back in six months, you have nothing. The
context is gone. You have to reconstruct from scratch what you already figured
out.

**Option B: Keep everything forever, equally.** Preserves history. But
everything competes equally for the librarian's attention. Old, irrelevant
entries crowd out the ones that actually matter today.

Neither is right. The third option is what this case study is about.

---

## The three mechanisms

### 1. Devalue, don't delete

The key insight: the librarian's decision about what to *show* you is different
from the question of whether something is *true*.

When a note gets old and unreinforced, it fades. Its score drops slowly. It
stops competing with fresher notes for the front shelf. But it isn't deleted. It
isn't marked wrong. It's just quieter.

The technical term for this is **bi-temporal invalidation** — every fact has a
`valid_from` and a `valid_to` timestamp. When you explicitly mark something as
no longer true (say, the project lead changed), the old fact gets a `valid_to`
stamp and is excluded from retrieval. But a note that simply went quiet from
decay doesn't get that stamp. It's still true. It's just not shouting anymore.

Decay is a volume knob. Not a delete button.

This matters because it preserves the option to bring notes back. A deleted note
is gone. A quiet note can be turned back up.

For a deeper look at how the timestamps work, see the [original analysis](deep/studies/decay-vs-dont-forget-and-resurrection.md).

### 2. Operator-pin

Some facts should never fade. Not because they're recent — because they're
foundational.

"The database is Postgres 13+." "We never use global state in this module."
"Jordan is the final decision-maker on the API design." These are the kinds of
things where getting it wrong on month seven because the note decayed is a
real problem.

The solution is a pin. The maintainer — that's me — can mark a fact as pinned.
Pinned facts are explicitly excluded from the decay math. They stay on the front
shelf regardless of age. The librarian always loads them.

This is intentionally a manual tool, not an automatic one. The system doesn't
decide what's foundational. The operator does. That's the right division of
labor: automated decay handles the common case; operator-pin handles the
exceptions where human judgment is required.

### 3. Fuzzy resurrection

This is the most interesting mechanism. It's also the most differentiating —
the reason this project handles the "returning to an old project" case better
than a simple decay curve does.

When you start a new session in a project you haven't touched in six months, the
librarian does something special at session start. She looks at what project
you're in. She looks at what you seem to be working on. Then she runs a semantic
search — a search by *meaning*, not by keyword — against the dormant notes for
that project. Any notes that are relevant to today's work get a freshness bump
and come back to the front shelf.

Think of it like a librarian who watches you walk in carrying your old notebooks
from a project you dropped last fall. Before you say a word, she goes to the
back shelf and pulls the chemistry section because she remembers what you were
working on and she sees the same notebooks in your hands.

She doesn't wait for you to describe what you need. She reads the situation.

This matters because when you come back to a dormant project, you often can't
remember exactly what you need to look up. You don't know what you don't know.
Fuzzy resurrection handles that — it brings the relevant notes back before you
ask, based on context, not keywords.

Decay doesn't mean "forgotten forever." It means "quiet until relevant again."

---

## The methodology: running a reflective loop

This is the part that makes this a real case study and not just a feature
description.

Before any of these mechanisms shipped, I ran a series of analysis passes to
understand how well the design actually worked. I wasn't analyzing production
data — I was reasoning through the design and checking whether my own claims
held up. The process was structured: each round ended with two questions.

> Have I asked all the questions of the work — is every failure mode explored?
> Is this my best judgment, or could I do better with another pass?

Running that loop caught two overstatements in my own first draft — before
anything shipped.

**Overstatement 1: denominator conflation.**

My first analysis said the system "forgot" a certain portion of notes after they
aged past a threshold. The number sounded plausible. But when I pushed on it, I
realized I'd been measuring the wrong thing.

The denominator — the "all old notes" bucket — included a lot of notes that
fuzzy resurrection would never be asked to recover anyway, because they were
about topics too distant from whatever the current session was doing. Counting
those as "forgotten" inflated the apparent forgetting rate. The actual
population that resurrection is designed to recover is smaller and more specific.

When I corrected the denominator, the forgetting rate came down. The original
framing had overstated how much the system was losing.

**Overstatement 2: invalid proxy measurement.**

My second early claim was about how often notes got excluded by the trust tier
— the system's mechanism for deprioritizing notes from sources that haven't been
verified yet. I was using tier-exclusion rate as a proxy for "forgotten."

That was wrong. A note can be tier-excluded from the top ranked results and
still appear lower in the set via a minimum floor that the system maintains. The
tier-exclusion rate counted notes as "unreachable" when some of them were still
reachable. The proxy understated how available those notes actually were.

The corrected measurement targeted only notes that failed the top ranked floor
AND failed the trust tier AND would pass the timestamp guard — the actual
population that was unreachable. The real number was different from the proxy.

Both corrections happened before shipping, in self-review. No external reviewer
caught them. The two-question gate is what created the structured pressure to
look again.

The point: the maintainer's first instinct was wrong twice in one document.
Catching it took deliberate reflection, not cleverness.

If you build something like this, expect to be wrong about your own work. Build
the gates that catch it.

---

## Why all three mechanisms shipped together

This is worth calling out explicitly because it wasn't obvious at the start.

Fuzzy resurrection is powerful. It's also dangerous if built carelessly. A naive
implementation lets you bring back not just dormant-but-true notes but also
notes that were deliberately suppressed because they turned out to be wrong. If
an adversary can influence what topics you work on, they could potentially
construct a session that retrieves suppressed (false) notes under the cover of
"resurrection."

The fix is a trust gate. Before any dormant note is resurrected, the system
checks whether the note's subject has at least one trusted anchor — a verified
fact or an operator-pinned fact — in the store. If there's no trusted anchor,
the note stays on the back shelf.

But that trust gate only works if the trust substrate is populated. And the
trust substrate gets populated by the L2 corroboration process — the mechanism
that marks facts as verified when they've been confirmed across multiple
sessions. For foundational facts that were written before that process was in
place, operator-pin bridges the gap.

So the three mechanisms are mutually dependent:

- Fuzzy resurrection without the trust gate is unsafe.
- The trust gate is only useful if the trust substrate is populated.
- Operator-pin populates the trust substrate for foundational facts that haven't
  had time to accrue cross-session corroboration yet.

None of the three is independently safe to expose. All three on `main` together
are. That's why they shipped as one unit.

---

## What shipped

All three mechanisms shipped on `main` in PR #66 (commit `9085fe4`). All three
are live. The two-question reflective loop that caught the overstatements is now
a reusable skill at `~/.claude/skills/reflective-loop-two-gates` — a small tool
that runs the same self-review pattern on any future design analysis.

---

## For nerds

The original analysis lives at
[docs/deep/studies/decay-vs-dont-forget-and-resurrection.md](deep/studies/decay-vs-dont-forget-and-resurrection.md).
It's denser. It has the actual code references, the bi-temporal guard predicate,
the trust gate specifics, and citations to the exact line numbers in
`scripts/handoff.js` where each invariant is enforced.

---

## Related

- [docs/how-memory-works.md](how-memory-works.md) — the broader picture, of which this is one piece
- [docs/glossary.md](glossary.md) — definitions for terms used here
- [README.md](../README.md) — the system as a whole

---

# Chapter 2: Tests That Fail on Purpose

Chapter 1 was about catching my own overstatements with a reflective loop — a
gate that forced a second look before shipping. This chapter is about applying
the same instinct to the architecture itself: writing tests that are wrong by
design, because the architecture hasn't earned them yet.

---

## The north star

Three things this system has to get right, stated plainly:

1. **Lossless fidelity.** Nothing you planned or decided in a prior session
   should be lost across the session boundary. If you said "the next step is X,"
   that needs to survive.

2. **A lean default resume.** When you pick up a project, the context you
   receive should be minimal and ranked by relevance — not a growing prose
   transcript. Older, less-reinforced facts should fade to the back; the
   freshest, most load-bearing ones should come first.

3. **Resurrection on demand.** A fact that has faded can be pulled back
   explicitly when it's relevant again. The system doesn't delete — it quiets.

Those three goals have a load-bearing premise underneath them: the information
that drives the next session must live in Postgres as queryable, decay-rankable
rows — not in a markdown file. If the intent only exists in prose, it can't be
decay-ranked. It can't be queried by topic. It can't be resurrected. And it gets
silently overwritten the moment the next session closes.

At the time the test suite was written, this premise was violated. The
`handoff.md` file was carrying all the session-driving content — the TL;DR,
open threads, quick references — as narrative prose in its body. Postgres got
the structured assertions (`entities`, `assertions`, `edges`) but not the intent
that actually steered the next session. The markdown body was the sole store of
that intent, and it was replaced wholesale on every close.

---

## RED by design

Rather than fix the architecture first and write tests after, a suite was
written that encoded the target state and failed on purpose against the broken
state. This is the methodological heart of the chapter.

Four test files:

- `test/north-star/test-fidelity-dataloss.js` — closes a session, blanks the
  handoff.md body, resumes, and asserts that every open thread still surfaces.
  The logic: if the intent lived only in the markdown prose, blanking the body
  erases it. The test fails RED until the intent lands as a queryable Postgres
  row that resume can serve independently of the markdown body.

- `test/north-star/test-retrieval-economy.js` — asserts that the default resume
  stays within the token budget and that the markdown body is a thin pointer
  (under 512 bytes), not a growing narrative. Also exposes a specific lie the
  engine had been telling: the reported "tokens used" figure excluded the served
  markdown body entirely, so a large session payload could blow the real budget
  while the reported number stayed small.

- `test/north-star/test-lifecycle-roundtrip.js` — covers the full close→resume
  round-trip reconstructed from Postgres alone (MD body blanked), the thin
  pointer assertion, and a vLLM-gated arm that verifies a devalued intent can be
  resurrected via an explicit query once it lives as a real Postgres row.

- `test/north-star/test-provenance.js` — asserts that persisted intent carries
  coherent provenance: confidence, source, tier, bitemporal validity. Prose
  cannot carry any of these fields. A note in the markdown body has no
  confidence score, no trust tier, no supersession trail. The tests prove that
  the fixed architecture gives session-driving intent the same first-class
  treatment as any other assertion.

Together, these files contain 12 structural tests (the vLLM-dependent arm in
`test-lifecycle-roundtrip.js` self-skips in CI environments without vLLM). They
were written before any of the architecture they test was built.

The suite was wired into CI in `.github/workflows/test.yml` under a hard gate:
each north-star step runs with `if: always()` so all four files report their
RED status even after the first failure. GitHub's default fail-fast behavior
would have silently hidden failures after the first; `if: always()` keeps every
file visible. The job fails if any step is non-zero. The comment in the
workflow is explicit: *"These FAIL RED today on purpose: close currently
persists intent only to the markdown body. This is a HARD GATE — CI stays red
until the architecture is rebuilt."*

That committed the project publicly to a broken CI state until the architecture
caught up.

(PR #91, commit `f3ec565`)

---

## The rebuild that turned it green

The fix — called the "north-star inversion" in the commit message — rebuilt
`/handoff:close` to persist the TL;DR, open threads, and quick references as
queryable Postgres assertion rows under three dedicated predicates:
`session_tldr`, `open_thread`, and `quick_reference`. These rows are written
through the same gated write path (`writeAssertionWithSupersession`) used by
all other assertions, which means the L0/L2 consolidation gate applies: a model
restating the same intent across sessions cannot self-promote it to
`consolidated` by repetition alone.

The `handoff.md` file was collapsed to a thin pointer — metadata header only.
The session-driving content that used to live in the prose body now lives in
Postgres, where it can be ranked, queried, and resurrected.

The test suite, unmodified, went green.

(PR #92, commit `0ac852a`)

---

## Serve-time reality re-probe

With the architecture now honest about where intent lives, a second problem came
into focus: facts about volatile now-state.

Some assertions record things that change between sessions — whether a PR is
open or merged, whether a branch still exists, whether a commit has landed on
main. Once a session closes with `pr_state: "open"`, that row sits in Postgres
marked `reality_check: 'verified'`. If the PR merges before the next session,
that frozen fact silently misleads the next session's context.

The serve-time reality re-probe addresses this: at resume time, assertions with
volatile predicates (`pr_state`, `branch_exists`, `commit_merged`, `in_file`)
are re-checked against live reality. If the stored value no longer matches, the
served output is annotated `[STALE: now "..."]` inline. The DB row's
`reality_check` field is updated, but — critically — the object, confidence,
source, and tier are never modified (the §7 no-backfill invariant). History is
preserved; only the freshness annotation changes.

This work also corrected the token-accounting lie exposed by the north-star
suite. The loader had been reporting bootstrap cost based only on the
PG-retrieved sections, excluding the served markdown body. The fix introduced
`trueServedTokens` — the real bootstrap cost including the canon block, the
markdown body, and all retrieved sections — so the lean-resume budget guarantee
is now honest.

(PR #93, commit `bb3e8c2`)

---

## Adversarial permutation harness

The serve-time re-probe introduced new failure modes: what happens when the `gh`
binary is missing? When a probe times out? When JSON from `gh` is malformed?
When two serve passes race to update the same `reality_check` field?

A separate adversarial harness was built to close those holes. It permutes
staleness scenarios across the four probe-able predicates, adversarial failure
conditions (probe binary missing, non-zero exit, timeout, malformed output), a
circuit-breaker test to bound total probe time when many rows need checking, a
concurrency test, and a budget test. Each failure mode must resolve to
`unverifiable` — never to `verified`, never to a hang, never to a crash.

The harness ran 29 tests (verified by counting `await test(` calls in
`test/handoff/test-staleness-permutations.js`). It found and fixed four real
engine holes that the earlier direct tests had not caught.

A sibling fix corrected a specific bug in the `commit_merged` probe: the probe
function was hardcoded to echo an object string that never matched the stored
value, so every `commit_merged` assertion came back as a mismatch regardless of
reality. This was caught by dogfooding the system's own session-close on a
project that had a `commit_merged` assertion — the system flagged its own
assertion as stale when it was actually verified.

(PR #94, commit `0e86af0`; PR #95, commit `a134de4`)

---

## The caveman dogfooding harness

The newest arm of the suite defends a property that has no analogue in the
earlier tests: authoring quality.

Once intent lives in Postgres as prose strings in assertion rows, the question
becomes: how do you write that prose to minimize bootstrap tokens without losing
the load-bearing content? The answer is telegraphic ("caveman") authoring —
strip function words (articles, copulas, most prepositions and conjunctions),
keep every load-bearing token (identifiers, file paths, line references, PR
numbers, commit SHAs, decisions). The engine stores what it receives verbatim;
compression has to happen at authoring time.

A new test file (`test/north-star/test-caveman-economy.js`) proves this with a
dogfooded round-trip. It runs the real `close` and `resume` subprocesses against
two paired fixtures — one with telegraphic prose, one with equivalent full
sentences — and asserts three things:

- **Economy:** the caveman resume costs fewer tokens than the verbose one, at
  both the true bootstrap level and the intent channel (the `### Assertions`
  section alone).

- **Fidelity:** every load-bearing token that surfaces in the verbose resume
  also surfaces in the caveman resume. Economy cannot be bought with loss.

- **Function-word density:** the caveman intent section has a measurably lower
  function-word ratio than the verbose intent section. This is the direct proof
  of telegraphic compression.

The tension worth naming: the fidelity check could not be exact-string survival.
Telegraphic prose is not a verbatim sentence, so character-level equality would
trivially fail. Fidelity had to be redefined as "every load-bearing token
survives while function-word density provably drops" — a harder-to-satisfy
definition, but the right one.

(PR #96, commit `0f07baa`)

---

## The connective thread

Chapter 1 was about building a gate that caught my own overstatements before
shipping. The gate was a structured question I forced myself to ask: *have I
explored every failure mode? Can I do better?*

Chapter 2 is the same instinct applied to architecture. Tests that fail on
purpose encode the target state the code hasn't reached yet. Wiring them into CI
as a hard gate commits the project to a broken state until the architecture
catches up. Adversarial and dogfooding harnesses then lock in the properties
that matter — staleness honesty, token economy, fidelity — so they can't
silently regress.

In both cases the underlying discipline is the same: expect to be wrong about
your own work. Build the gates that catch it before someone else does — or
before you forget what you were trying to guarantee in the first place.

---

## For nerds

The five north-star test files are in `test/north-star/`. The shared scaffold
(`test/north-star/lib/ns-harness.js`) documents the RED-by-construction
contract in its header and provides the `blankHandoffMdBody`, `assertSurfaced`,
`assertMdThinPointer`, and related primitives the sibling files compose.

The adversarial staleness harness is at
`test/handoff/test-staleness-permutations.js`. The serve-time staleness tests
it extends are at `test/handoff/test-serve-time-staleness.js`.

The CI wiring, including the `if: always()` gates and the comments explaining
why each north-star step runs regardless of prior failures, lives in
`.github/workflows/test.yml`.

---

## Related

- [Chapter 1](#chapter-1-letting-old-notes-fade-without-losing-them) — the
  decay / operator-pin / resurrection design
- [docs/how-memory-works.md](how-memory-works.md) — the system's core model,
  including the serve-time reality re-probe
- [docs/glossary.md](glossary.md) — definitions for `open_thread`,
  `session_tldr`, `quick_reference`, `reality_check`, `[STALE:]` annotation
- [README.md](../README.md) — the system as a whole
