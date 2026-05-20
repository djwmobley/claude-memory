# Case Study: Letting Old Notes Fade Without Losing Them

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
