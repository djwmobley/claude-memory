# Codex review contract

Spec for a checked-in wrapper that runs OpenAI Codex CLI as a directed PR
reviewer against this repo. Owner rulings below (2026-09-13) are hard
rules, not defaults to negotiate. This revision closes all 17 findings
from the 2026-09-13 spec-adversary pass (see "Adversary findings" below);
the pass ran before `scripts/codex-review.js` was authored, per this
repo's adversary-before-author rule.

**Round 3 amendment (2026-09-13, owner-approved):** round 2's independent
Codex-review dogfood pass on PR #305 hit the round cap with 4 unresolved
blockers. Rather than patch each one point-wise, the owner approved a
structural amendment closing all 4 at once:

- **(a) Post-run ledger re-check.** Before posting an APPROVE, the wrapper
  re-reads every PR comment (paginated, cross-checked against the issue's
  own comment count) and reclassifies anything new since a pre-run
  snapshot — a halt or a same-round different-SHA entry posted while
  Codex was running is never silently missed (closes round-2 item 4's
  residual gap: reclassifying against a dup check alone, not the full
  ledger).
- **(b) Marker anchoring.** HALT and HALT_CLEAR markers are recognized
  only when owner-authored, carrying `round`/`sha` fields, and the FIRST
  non-whitespace content of the comment body after stripping fenced,
  indented, and quoted blocks — so a marker merely quoted inside a fenced
  finding (round-2 item 6's residual gap) can never clear a halt it
  doesn't own.
- **(c) Structured verdict.** Codex now emits exactly one machine-checkable
  `codex-verdict`-fenced block (`verdict`/`scope_request`/`findings`),
  parsed byte-exact, instead of free-text findings a widening-phrase regex
  can never fully enumerate (closes round-2 item 10's residual gap:
  "please widen the scope" / "run a third pass" phrasings the old regex
  never matched).
- **(d) Fence from local git.** The scope fence is built from
  `git diff --name-status -M -z <base>...<head>`, NUL-delimited, never
  from `gh pr view --json files` — which never populates `previousPath`
  on a rename (closes round-2 item 11's residual gap: a synthetic test
  fixture papered over the real absence of that field in `gh`'s output).

This amendment retires the free-text verdict template (`SHA`/`VERDICT`/
`SCOPE_RESPECTED`/`ROUND`/`FINDINGS`/`END_FINDINGS`) and, with it, the
per-BLOCKER fence/rearchitecture checks (A3, A4, F17) that depended on
per-finding file/text fields the structured verdict no longer carries —
see "Total classification of wrapper outcomes" and "Adversary findings"
below for the disposition of each retired finding.

## Purpose

A scripted, non-interactive way to have Codex review a pull request's diff
and return a machine-checkable verdict, without Codex acting as an
unsupervised approver or widening its own scope. The wrapper directs
Codex; it does not treat Codex's architectural opinions as findings (R1).

## Inputs

- `prNumber` — the PR under review; the wrapper resolves its PR body,
  draft status, head SHA, and base SHA via
  `gh pr view <prNumber> --json body,headRefOid,isDraft,baseRefOid` (or
  equivalent), never by asking Codex to discover them. The changed-file
  list (the scope fence) is resolved separately, from local `git`, never
  from this call (round-3 item d — see "Path fence equality" below).
- `repoRoot` — absolute path to the checkout Codex runs against
  (`-C <repoRoot>` in the invocation below); must be a clean worktree at
  the PR's head SHA.
- `round` — integer, 1 or 2. Any caller-supplied value outside {1,2} is
  refused by the wrapper before invoking Codex at all (R3), bucket
  `INVALID_SHAPE` / `ROUND_OUT_OF_RANGE`.
- Round 2's prior verdict is never a separate caller-supplied input — the
  wrapper loads round 1's raw Codex response verbatim from its own ledger
  comment on the PR (see "Round ledger"), read by its marker, never by
  line position or file path.

Invocation shape (from the working binary reference): the wrapper writes
the assembled prompt to a tempfile and pipes it in —
`Get-Content -Raw <prompt.md> | & "<codex.exe>" exec - -s read-only -C <repoRoot>`
— never an inline `-e`/`-c` string, per this repo's complex-payload rule.
`-s read-only` is non-negotiable: the wrapper never grants Codex a
write-capable sandbox for review.

## Prompt assembly

Built in this fixed order, all from data the wrapper already resolved
(never from anything Codex claims about itself):

1. **Role framing** — Codex is directed to check specific things; its own
   architecture preferences are out of scope and must not appear in
   findings (R1).
2. **Scope fence** — the changed-file list from local
   `git diff --name-status -M -z <base>...<head>` (round-3 item d),
   resolved fresh every round (B6, never cached from round 1), plus the
   PR body's stated purpose, verbatim. This is the reviewable surface
   (R2). A renamed/moved file contributes **both** its previous and
   current path to the fence (B6). Anything else in the repo is
   explicitly out of bounds.
3. **Round context** — round number; on round 2, round 1's raw Codex
   response is included verbatim and Codex is told: verify only what's
   there, no new findings are accepted this round (R3).
4. **Verdict shape instructions** — the exact required output template
   (see Verdict shape below), stated as a strict template Codex must emit
   as a single fenced block; explanatory prose may precede it, but must
   not carry severity words or a request to widen scope (A1, round-3 item
   c).
5. **The diff** — `git diff <base>...<head>` for the PR, scoped to the
   changed-file list from step 2.

## Verdict shape (round-3 item c)

Codex's stdout must contain **exactly one** fenced block labeled
`codex-verdict`:

````
```codex-verdict
verdict: APPROVE|BLOCK
scope_request: none|widen|another_pass
findings: <integer count of BLOCKER findings>
```
````

Parsing rules, all enforced byte-exact:

- Zero such blocks, or more than one (including one that is merely
  quoted/echoed inside a blockquote or another fence elsewhere in the
  output), is a shape failure.
- Field values are matched exact-byte, case-sensitive, with no
  surrounding whitespace and no non-ASCII byte (which also rejects
  zero-width characters) — `Approve`, `APPROVE `, and `APPROVE` followed
  by a zero-width space are all rejected, never coerced.
- `verdict` must be exactly `APPROVE` or `BLOCK`; `scope_request` must be
  exactly `none`, `widen`, or `another_pass`; `findings` must be a
  non-negative integer (ASCII digits only).
- Any other line inside the block (duplicated field, unrecognized key) is
  a shape failure.

Free-form explanatory prose may appear outside the block, but the wrapper
scans it (after stripping fenced/indented/quoted blocks) for the severity
words `BLOCKER`/`CRITICAL`/`SECURITY`/`VULNERAB` and for scope-widening
phrasing ("another pass", "widen the scope", etc.) — either downgrades an
otherwise-clean APPROVE, never the reverse.

## Total classification of wrapper outcomes

Every possible wrapper outcome maps to exactly one bucket; unknown or
ambiguous output is the default branch, `NEEDS_OWNER`. Buckets are
evaluated in this fixed priority order (D12), each check short-circuiting
the ones below it:

1. `HALTED` — a prior halt marker exists on the PR and is not lifted by a
   matching, owner-authored, correctly-anchored clear (round-3 item b;
   E15/E16), or the ledger itself is tamper-evident-invalid (C10). No
   Codex invocation is attempted.
2. `DRAFT_PR` — `gh pr view` reports the PR as a draft (D14). Halts.
3. `NEEDS_OWNER` (fence-unknown case, round-3 item d) — resolving the
   scope fence from local git failed: a nonzero-exit `git diff
   --name-status -M -z`, an unknown status letter, or a short/malformed
   NUL-delimited record. Never guessed at or silently treated as empty.
   Halts.
4. `EMPTY_FENCE` — the fence resolved successfully but is genuinely empty
   (zero changed files) (D13). Halts.
5. `ROUND_EXCEEDED` (idempotent-abort case) — a ledger marker already
   exists for this exact `(round, headSha)` pair, as read **before**
   Codex ever runs (C8/C9); re-posting is refused rather than duplicated.
6. `INVALID_SHAPE` (`ROUND_OUT_OF_RANGE`) — caller `round` not in {1,2}
   (R3).
7. `INVALID_SHAPE` (`ROUND_DISAGREES_WITH_LEDGER`) — caller `round` does
   not equal the ledger-computed next round (max recorded round + 1); a
   force-push that changes `headSha` does **not** reset the round counter
   (C11) — the ledger is keyed by PR number, not by SHA.
8. `CODEX_ERROR` — nonzero exit code, or empty/whitespace-only stdout,
   from the `codex exec` invocation itself (process-level failure, not a
   content problem). Checked before any parsing of the verdict body
   (D12).
9. Structured-verdict classification of the `codex-verdict` block
   (round-3 item c), itself a nested total classification:
   - `STRUCTURED_BLOCK` — the block parses validly and `verdict: BLOCK`.
     Unconditional once parsed — no BLOCK verdict is ever further gated
     on `scope_request`, `findings`, or prose content.
   - `STRUCTURED_APPROVE` — the block parses validly, `verdict: APPROVE`,
     `scope_request: none`, `findings: 0`, and the remaining prose
     carries neither a severity word nor scope-widening phrasing.
   - `NEEDS_OWNER` — every other case: the block missing, duplicated, or
     malformed; an unknown field value; an APPROVE with `scope_request`
     ≠ `none` or `findings` > 0; or a severity/widening word in the
     prose. This is the total-classification default branch — an
     unrecognized shape is never silently approved.
10. `VALID_BLOCK` — `STRUCTURED_BLOCK`, posted directly (round-3 item c
    skips the post-run re-check below for a BLOCK; see "Round ledger").
11. Post-run ledger re-check (round-3 item a), entered only for a pending
    `STRUCTURED_APPROVE` — see "Round ledger" for its own sub-classification
    (`UNKNOWN_LEDGER_STATE` / `HALTED` / `STALE_SHA` / `DUPLICATE` /
    `NO_CHANGE`).
12. `VALID_APPROVE` — reached only when the post-run re-check (11) returns
    `NO_CHANGE`.

Every bucket other than `VALID_APPROVE` is a non-passing result; the
wrapper never defaults a non-passing bucket to approval.

## Wrapper exit codes and final result line

The wrapper's process exit code distinguishes all three outcome classes a
caller (CI step, shell script) might branch on: `VALID_APPROVE` exits `0`;
`VALID_BLOCK` — a real, unresolved BLOCKER verdict — exits `2`; every other
bucket (every halt, every precondition refusal, every gate error such as a
failed `git diff` or a failed `gh pr comment` post) exits `3`. No bucket
other than `VALID_APPROVE`/`VALID_BLOCK` ever exits `0`.

Regardless of bucket, the wrapper's LAST line of stdout is always a
single-line JSON object — `{"outcome": "<bucket>", "round": <int|null>,
"sha": "<headSha>"|null, "reason": "<reason>"|null}` — in addition to the
human-readable `Bucket: <bucket> (<reason>)` line and, for halting
outcomes, the `HALT` line (Escalation, bullet 3). This JSON line is the
authoritative machine-checkable result; the human-readable lines are for
operators reading the log.

## Path fence equality (B5/B7)

Both the fence's paths and any path being tested against it are
normalized before comparison: backslashes become forward slashes, a
leading `./` is stripped, repeated `/` collapse to one, and the result is
lower-cased when the wrapper is running on `win32` and left
case-sensitive on every other platform. This makes fence membership
resilient to `git diff` emitting `/`-separated paths on any platform.

## Round ledger

Round history for a PR is recorded as PR comments, **appended, never
rewritten or deleted**, and is always read via the paginated REST endpoint
(`gh api --paginate repos/<owner>/<repo>/issues/<n>/comments`), never via
`gh pr view --json comments` (round-3 item a keeps one consistent
comment-id space for snapshot/re-read diffing):

- Each round's comment carries a marker line
  `<!-- codex-review-round:<N> sha:<headSha> hash:<sha256 of the verdict
  body> -->` (C10), with the raw verdict body wrapped between
  `<!-- codex-review-verdict-begin -->` / `<!-- codex-review-verdict-end
  -->` sentinel lines — not a ``` fence, since the verdict body itself now
  legitimately contains a `codex-verdict`-fenced block (round-3 item c)
  that would break naive backtick-counting re-extraction.
- **Pre-run snapshot, post-run re-check (round-3 item a).** Before
  invoking Codex, the wrapper takes a snapshot of every existing PR
  comment id. Immediately before posting an APPROVE, it re-reads ALL PR
  comments (paginated) and independently cross-checks that count against
  the issue's own `comments` total (`gh api repos/<owner>/<repo>/issues/
  <n>` → `.comments`); any fetch/parse/shape error or a count mismatch is
  `UNKNOWN_LEDGER_STATE` — never silently treated as clean. It then
  classifies only comments NEWER than the snapshot that carry a
  recognized wrapper marker (an ordinary human comment, at any point in
  time, is ignored), in this fixed precedence:
  `HALTED` (an uncleared halt — the one branch that also considers
  pre-existing entries) > `STALE_SHA` (a new ledger entry for this round
  with a different `headSha` — a force-push raced the review) >
  `DUPLICATE` (a new ledger entry with this exact `round`+`headSha` —
  idempotent, nothing posted) > `UNKNOWN_LEDGER_STATE` (a new
  marker-shaped comment that doesn't parse as either of the above) >
  `NO_CHANGE` (post the approve). This re-check is **not** run for a
  `BLOCK` verdict, which posts directly (see "Total classification" step
  10) — the residual TOCTOU race between this re-check and the actual
  post is not closable client-side; a concurrent poster's entry becomes a
  pre-existing comment by the wrapper's *next* invocation, whose own
  `DUPLICATE`/`HALTED` branch catches it after the fact.
- The wrapper recomputes each existing marker's hash against its verdict
  body on every read. A mismatch (the comment was edited after posting)
  makes the ledger tamper-evident-invalid; the wrapper treats this the
  same as an unlifted halt and refuses to proceed (C10).
- `round` is decided by the wrapper from the ledger's own comment count
  for that PR (max marker round + 1), not from caller say-so alone; a
  caller-supplied `round` that disagrees is a refusal (`INVALID_SHAPE` /
  `ROUND_DISAGREES_WITH_LEDGER`), not an override.
- Force-pushing a new head SHA does **not** reset the round count (C11):
  the ledger is keyed by PR number across all SHAs seen on that PR: round
  2 after a force-push is still round 2, not a fresh round 1.
- Round 2's prompt assembly reads the round-1 comment by its marker and
  embeds its raw verdict text verbatim — never by assuming it is the
  file's last comment or at a fixed offset.

## Escalation / halt (E15/E16; markers re-anchored by round-3 item b)

Any of: a `ROUND_EXCEEDED` classification, a caller request for round 3,
a `HALTED`-ledger read, a fence-resolution failure (`NEEDS_OWNER`), or a
`NEEDS_OWNER`/`STALE_SHA`/`UNKNOWN_LEDGER_STATE` structured-verdict or
post-run-recheck outcome, halts the wrapper immediately — no round 3
prompt is ever assembled automatically (R3). On halt the wrapper:

1. Posts exactly one PR comment whose FIRST non-whitespace content is the
   marker `<!-- codex-review-halt round:<N> sha:<headSha> -->`, stating:
   which condition fired, the PR number, the round and SHA, and that
   owner approval is required before continuing — including the exact
   literal clearing marker the owner must post (safe to spell out
   verbatim: see "Marker anchoring" below for why this can never
   self-clear).
2. Writes durable halt state (the posted comment itself, read back on
   every subsequent invocation via `parseLedger`) — a halt is not only an
   in-process flag.
3. Exits with code `3` (see "Wrapper exit codes and final result line"
   above) and prints a `HALT` line to stdout, so a CI step that only
   checks exit code and a shell script grepping stdout both detect it.

Any later invocation on that PR is classified `HALTED` and performs no
further work — no Codex call, no new ledger comment — **unless** a
correctly-anchored clear for that exact `round`/`headSha` has since been
posted (see "Marker anchoring"). No agent may post that clearing marker
itself; only a human owner action does.

### Marker anchoring (round-3 item b)

A HALT or HALT_CLEAR marker is recognized **only** when ALL of the
following hold — applied identically to both marker kinds, closing the
round-2 gap where only HALT_CLEAR was owner-gated:

- The comment's author login is **exactly** (case-sensitive) the repo
  owner's login. A marker from anyone else is never recognized — this
  also means the wrapper's own halt/ledger comments only work because
  `gh` runs authenticated as the repo owner.
- The comment's body does **not** also contain a ledger-outcome
  (`codex-review-round:`) marker anywhere — a ledger comment (posted by
  the wrapper, always owner-authenticated) can never double as a clear,
  even if a quoted finding inside it happens to contain clear-marker-like
  text.
- After stripping ``` fences, `~~~` fences, 4-space/tab-indented code
  blocks, and blockquote (`>`) lines OUT ENTIRELY (never unwrapped —
  removed), the marker with its `round:<n> sha:<40hex>` fields is the
  FIRST non-whitespace content of what remains. HTML comments are never
  stripped by this step, since the markers themselves are HTML comments.
- A HALT_CLEAR only lifts the HALT whose `round` and `sha` match exactly;
  a mismatched clear leaves the active halt untouched.

Because the marker must be the comment's own first content, and a HALT
comment's first content is always the HALT marker (never the CLEAR one),
the halt comment's owner-instructions text is safe to spell out the exact
literal clear marker verbatim — it can never make the same comment
self-clear.

## Non-goals

Not building: an approve/merge action (separate, independent-agent concern
per this repo's PR-independence rule); a general Codex-as-architect
consultation path (R1); automatic rearchitecting toward Codex's
preferences (R4) — the sole exception, a net improvement for both hosts,
still requires owner approval before authoring, never wrapper-triggered.

## Adversary findings (2026-09-13) — disposition

All 17 round-1 findings below are closed by the sections above. Findings
A3, A4, and F17 depended on per-BLOCKER `file=`/`text=` fields that the
round-3 structured verdict (item c) no longer carries at all — their
fix location is now "retired by design": the class of input they guarded
against can no longer be expressed by Codex's own output shape, so there
is nothing left to check.

| ID | Finding (short) | Fix location |
|---|---|---|
| A1 | Free text outside enumerated fields | Verdict shape (single fenced block, byte-exact fields); classification step 9 |
| A2 | Required field occurring ≠ exactly once | Verdict shape; classification step 9 |
| A3 | Verdict SHA not checked against a wrapper-resolved SHA | Retired by design — the structured verdict carries no SHA field; SHA/round freshness is enforced entirely by the ledger (round ledger, item a) |
| A4 | BLOCKER text references an out-of-fence path outside the `file=` field | Retired by design — `findings` is now an integer count, no per-finding text |
| B5 | Path equality not normalized | Path fence equality section |
| B6 | Fence not resolved fresh per round; renames not covered | Prompt assembly step 2; Path fence equality; item d |
| B7 | Case sensitivity unspecified | Path fence equality section |
| C8 | Ledger dup-round not idempotent | Round ledger |
| C9 | Ledger not re-read before posting | Round ledger; round-3 item a supersedes this with a full reclassification |
| C10 | Ledger comment could be edited post-hoc undetected | Round ledger; classification step 1 |
| C11 | Force-push resets round count | Round ledger; classification step 7 |
| D12 | No fixed priority order across failure classes | Total classification (fixed order) |
| D13 | Zero changed files unhandled | Total classification step 4 |
| D14 | Draft PR unhandled | Total classification step 2 |
| E15 | Halt has no durable state | Escalation, bullets 2-3 |
| E16 | Halt not enforced on subsequent runs | Escalation, final paragraph; Marker anchoring |
| F17 | Rearchitecture BLOCKER not distinguished from in-scope BLOCKER | Retired by design — no per-finding remedy text to pattern-match |

## Round-2 items resurfaced and closed by the round-3 amendment

Round 2 (2026-09-13) fixed 12 in-fence blockers from an independent Codex
dogfood pass on round 1; 4 of those fixes proved incomplete on a further
round-2 dogfood pass and hit the round cap. The round-3 amendment (see the
top of this document) closes all 4 structurally rather than point-wise:

| Round-2 item | Residual gap | Round-3 fix |
|---|---|---|
| 4 | Post-run re-read checked only for an exact-dup marker, not a halt or a same-round different-SHA entry posted during the Codex run | (a) Post-run ledger re-check: full reclassification (`HALTED`/`STALE_SHA`/`DUPLICATE`/`UNKNOWN_LEDGER_STATE`/`NO_CHANGE`), paginated and count-cross-checked |
| 6 | An owner-authored ledger comment quoting the clear marker inside a fenced finding still cleared an active halt | (b) Marker anchoring: first-non-whitespace-content requirement + "must not also contain a ledger marker" rule |
| 10 | Free-text widening phrases ("please widen the scope", "run a third pass") were never fully enumerable by regex | (c) Structured verdict: `scope_request` enum field is a total classification of intent, not a phrase list |
| 11 | `gh pr view --json files` never populates `previousPath` on a rename; a synthetic test fixture papered over the real gap | (d) Fence from local `git diff --name-status -M -z`, which reports rename sources natively |

## Blind spots

What this wrapper cannot detect: Codex silently ignoring an instruction in
the prompt while still emitting a well-formed structured verdict (e.g.
`findings: 0` while its own prose describes an unfixed bug it chose not to
flag as a BLOCKER); scope-fence evasion via a file rename or move whose
*content* (not path) smuggles unrelated changes past a path-only fence
check; any case where Codex's own sandbox or `codex exec` environment
silently truncates the diff or prompt below its stated size limits without
surfacing an error; the exact `gh api --paginate` response shape under
GitHub API rate limiting (a 403/429 is treated as an ordinary
`FETCH_FAILED` → `UNKNOWN_LEDGER_STATE`, but has not been observed live);
a rename whose similarity is below git's own `-M` detection threshold,
which `git diff --name-status -M` will report as a plain delete+add pair
rather than an `R`-status record, silently losing the previousPath link
the fence relies on; and the residual re-read-then-post TOCTOU race
documented in "Round ledger" above, which is inherent to any two-step
check-then-act over a remote API and is caught only after the fact by the
next invocation.
