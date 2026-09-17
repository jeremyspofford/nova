# Slice 25 — the Inbox: cards that read, act, and can be argued with

Branch `slice/s25`, to be cut from `rebuild/v4` (which now carries S24).

**Answered 2026-09-16.** All five questions at the end are settled; two
changed the design and are folded in below. The answers are recorded at the
end with the reasoning they change.

## Where this came from

Jeremy's complaint, 2026-09-15: cards do not read like something a human
wrote, nothing is actionable, and there is no way to discuss an item.

Reading the code confirmed all three and found more. What follows separates
what is BROKEN (it does not do what its own docstring says) from what is
MISSING (it was never built). They want different kinds of care: a defect
gets a test that fails first, a gap gets a design.

## Part 1 — the defects

### 1.1 Mute is defeated by any check that counts

`checks.fingerprint(finding)` is `sha256({key, facts})`, and the mute holds
the fingerprint: "a muted row still occupies its fingerprint, which IS the
mute" (notices.py). That is exactly right when facts are stable and
completely wrong when they are not.

`work_failing_timers` puts `consecutive_failures` in its facts. Mute it at
two failures; at three the facts differ, so the fingerprint differs, so it
is a **fresh, unmuted row** — and the muted row is never cleared or pruned,
so it sits there forever holding a fingerprint that will never recur.

The condition has not changed. The count has.

**The fix is to mute the CONDITION, not the reading.** A finding already
carries both: `key` says WHICH condition (`timer:<id>`), `facts` say what it
currently reads. Mute belongs on `(check_name, finding_key)`.

    CREATE TABLE notice_mutes (
        check_name text NOT NULL,
        finding_key text NOT NULL,
        muted_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (check_name, finding_key)
    );

Silence then survives a changing count and does NOT survive the condition
going away: the mute is dropped when the notice clears, so if the same timer
starts failing again next month he is told. That is the behaviour the
current design was reaching for; it just keyed on the wrong half.

**What refuses:** a test that mutes a finding, changes a number in its
facts, re-raises it, and asserts silence. It fails today.

### 1.2 The thing he silenced sorts first

A fold bumps `last_seen_at` — including a silent fold onto a muted row — and
the list orders by it. Mute something noisy and it becomes the top card.

**Fix:** the list orders by when he was TOLD (`first_seen_at` for unread,
`delivered_at` where present), and muted rows are not in the default view at
all. A "muted" filter shows them, because a silence you cannot find is a
silence you cannot lift.

### 1.3 "Seen" and "stop telling me" are the same button

`deliverable()` requires `seen_at IS NULL`, so marking a card seen removes
it from the daily digest permanently — while the urgent push path reads
different columns and will still push it. Two paths, two meanings, one
control.

**DECIDED (Q1): seen is a read receipt only.** It stops nothing. The digest
keeps listing a live condition until it clears or is muted, because
`cleared` already means "this stopped being true" and `muted` already means
"stop telling me" — a third meaning in between is where the confusion came
from.

So `deliverable()` drops its `seen_at IS NULL` term. That makes the digest
NOISIER than today for anything he has read and not acted on, which is the
honest trade: the alternative was a card silently leaving the digest forever
because he looked at it.

## Part 2 — what is missing

### 2.1 Prose that reads — and the line I will not cross

A card's sentence is composed **in code**, by the check that found it
(`Finding.title`). That must not change. A model-written card is a claim
nobody checked, and this repo has a standing rule that the trace is the fact
and the sentence is a claim. Cards are the one surface where the sentence
IS the product, so it stays derived.

What is wrong is not that the sentences are generated; it is that they are
written for a log. `the beat 'Distil: turn what was said into facts her
memory can find' is paused since 2026-09-11T14:35:29+00:00 — no beat named
'distil'` is accurate and unreadable.

**So: better composition, same authorship.** Times become "since Thursday
morning" against his timezone; identifiers leave the sentence and become
links (2.2); the check's own reason keeps its words. A shared
`checks/prose.py` gives every check the same vocabulary so this is one
change rather than fifteen.

**Where the model IS allowed to write** is the thread (2.4). There she is
answering a question with tools and a trace behind her, which is a different
epistemic situation from stamping a sentence onto a card he will read as
fact.

### 2.2 Linked subjects, derived

A `timer_id` in the facts should open the timer. The temptation is a
per-check mapping; the rule here is derived, never hardcoded, so:

**A fact whose key ends `_id` and whose name matches a known subject becomes
a link.** One registry of subject → route (`timer` → `/schedules?timer=`,
`agent` → `/agents?name=`, `skill` → `/skills/`, `model` → `/models?id=`,
`device` → `/devices?id=`), and a new check that emits `timer_id` links with
no edit anywhere. A subject with no route renders as text, which is what it
does now.

**What refuses:** a test that walks every check's sample facts and asserts
every `*_id` either resolves to a route or is deliberately listed as
unlinked. A new subject cannot be quietly unlinkable.

### 2.3 A `notices` tool — she reads her own Inbox

Today she writes the daily digest into his conversation and then cannot
answer one question about it. This is the CLAUDE.md principle exactly: the
gap is the task, and the answer is a capability, not another button on a
page.

    notices(state="unread"|"muted"|"cleared"|"all", check=…, limit=…)

Returning the same rows the page shows: title, facts, state, when, and
whether it is cleared.

**DECIDED (Q2): she can mute and mark seen too.** So the tool writes as well
as reads:

    notices(...)                      read
    notice_mute(id, muted=true|false) silence, or lift a silence
    notice_seen(id)                   a read receipt

Neither is an approval — both are noise preferences, and `test_no_approvals`
stays green because nothing waits on him. Two consequences worth building
for rather than discovering:

- **A mute records WHO made it** (`muted_by`: his person id, or null for
  hers). "Nova muted this" and "you muted this" are different facts, and the
  Inbox says which — otherwise a silence he did not ask for is
  indistinguishable from one he did.
- **Muting is not handling.** She may silence a card and must not then say
  she dealt with the condition; that is the capability guard's territory
  already, and the eval corpus should carry the case.

### 2.4 "Talk about this" — S24, wired

S24 built the mechanism and walked it. This slice is its first consumer:
the button opens `/chat?thread=<id>` for the room off the message that
delivered the notice, and the seed already carries the check's own facts.

**The case S24 named and did not solve:** a notice that has NOT been
delivered has no message, so it has no room. The Inbox must say so rather
than offering a dead control — "not delivered yet" beside a disabled action
is the one place a disabled control is honest, because the reason is about
the world rather than about permission.

### 2.5 Wire the skill draft

`POST /api/v1/skills {from_notice: …}` is fully implemented and no UI calls
it. `skills_repeated_procedure` exists precisely to notice a repeated
sequence and offer to write it down. One button, on cards from that check.

## What refuses when this is wrong

- A mute survives a changing fact — the test in 1.1 fails today.
- A muted notice is not in the default list, and is reachable in one filter.
- Every `*_id` fact either links or is listed as unlinked.
- A notice with no delivering message offers no "talk about this", and says
  why.
- `test_no_approvals` stays green: nothing here asks him anything. Mute and
  seen remain preferences, not permissions.
- Card sentences stay code-composed — a test asserts no card text comes
  from a model call.

## Definition of done

Read from the trace, not from how the page looks.

1. Mute a failing-timer card, force another failure, run the watch beat:
   the Inbox stays quiet and the digest does not mention it.
2. Clear the condition, re-raise it: he IS told. Silence did not become
   permanent.
3. A card with a `timer_id` opens the timer in one click.
4. Ask her in chat "what is in my inbox?" and read the `tool` span:
   `notices` ran, and the reply's facts match the rows.
5. "Talk about this" on a delivered card opens its room, with the notice's
   facts in the seed (S24's walk, from the Inbox instead of the chat stub).
6. A card from `skills_repeated_procedure` drafts a skill, and the draft
   names the steps from the notice.
7. All of it at 280px, 393px and 852x393 — `e2e/responsive.sh`.

## Answers (Jeremy, 2026-09-16)

1. **Seen is a read receipt only.** Folded into 1.3.
2. **She can mute and mark seen.** Folded into 2.3 — the tool writes, a mute
   records who made it, and muting is not handling.
3. **A cleared condition clears its mute.** As specced: the mute is about a
   live condition, and one that returns months later is news. This is also
   what makes answer 5 safe.
4. **YES to a digest view** — "what you were told on Tuesday".

   This is nearly free because S24 already built the link: every notice
   records `delivered_message_id`, so a digest IS a group of notices sharing
   one message. The view groups by that message, newest first, and each
   group opens the same room the chat stub opens. A notice not yet delivered
   belongs to no group and appears under "not told yet" — which is the same
   fact 2.4 renders as a disabled action.
5. **Urgent notices and mute** — **YES, mute silences an urgent push too**
   (owner, hedged: "yes, I think so"). Recorded with the consequence,
   because it is the one answer that can cost him something: a muted urgent
   condition stays silent for as long as it stays true, so muting "the
   gateway is down" means not being told the gateway is down.

   What makes that safe rather than reckless is Q3: the mute lifts when the
   condition CLEARS. So the silence lasts exactly as long as the thing he
   already knows about, and a recurrence is news again. If this proves wrong
   in use, the change is one clause and this paragraph is the record of why
   it was chosen.

## Out of scope

- **Per-thread unread state.** Wants its own design.
- **Notification channels beyond chat and devices.** The ladder exists;
  adding rungs is not this slice.
- **Rewriting checks' findings.** This slice changes how a finding is
  PRESENTED, not what any check looks for.

## What is built, and the one place the spec was wrong

### Done

* **1.1 a mute survives the facts changing.** `notice_mutes (check_name,
  finding_key)` (migration 032) is the mute, not the row — the fingerprint
  is a hash of the facts, and `consecutive_failures` is IN the facts, which
  is how a timer muted at two failures came back unmuted at three. A row is
  born muted, a fold onto a muted row does not bump `last_seen_at`, and a
  clear (by hand or by reconcile) deletes the mute key in the SAME
  statement, so a silenced condition can never outlive the condition.
* **1.2 the thing he silenced no longer sorts first.** The Inbox orders by
  when he was TOLD (`COALESCE(delivered_at, first_seen_at)`), not by
  `last_seen_at`, which a fold bumps — the page was sorted by how noisy each
  condition is. Muted rows leave the default view for a `?muted=true`
  filter that carries its own count, because a silence he cannot find is a
  silence he cannot lift.
* **1.3 "seen" and "stop telling me" are no longer the same button.** Q1, and
  it took TWO changes rather than the one the spec named — see below.
* **2.1 prose that reads**, with the same authorship: `checks/prose.py` is
  the shared vocabulary, and two source-walking guards refuse the next card
  that is written for a log (no `isoformat()` and no `!r` in a title, both
  derived from the live source rather than a list).
* **2.2 linked subjects, derived.** `SUBJECT_ROUTES` keys on the FACT, so a
  new check emitting `timer_id` links the day it lands. `/schedules?timer=`
  is real now (it opens that row) — a link to a parameter no page reads is a
  promise the destination does not keep.
* **2.3 the `notices` tool**, plus `notice_mute` and `notice_seen`
  (`app/tools/notices.py`). She wrote the digest and could not answer one
  question about it. A mute SHE makes records `muted_by` null and one HE
  makes records his id — the router was passing null for his, so the two
  were indistinguishable until this slice. Nothing here waits on him, and
  `test_no_approvals` is green beside it.
* **2.4 "talk about this"**, wired to S24: `POST /api/v1/notices/{id}/thread`
  opens the room off the message that delivered it, idempotently. A notice
  with no delivering message gets a DISABLED control whose title names what
  has not happened — and the page reads `delivered_message_id`, not
  `delivered_at`, because a device push delivers with no chat row at all.
* **2.5 the skill draft**, wired: the button appears when the notice's facts
  carry `steps` — the same condition `POST /skills {from_notice}` accepts,
  read off the same facts — and carries the notice to the Skills page, which
  asks only for a name.

### Where the spec was wrong: 1.3 needed a second change

The spec said "`deliverable()` drops its `seen_at IS NULL` term" and that
alone would have left the defect alive. `mark_seen` also moved the row to a
`seen` STATE, and `seen` is not in `DELIVERABLE_STATES` — so opening an
undelivered card in the Inbox would still have dropped it from every future
digest, by the other door.

That state was the "third meaning in between" the spec's own DECIDED
paragraph names. It is gone: `STATES` is `raised | delivered | failed |
muted`, "he read it" is `seen_at`, and the digest does not read it at all.

### Where the spec was wrong: prose cannot say "this morning"

2.1's example was `since Thursday morning`. A title is composed ONCE —
`notices.record` folds a repeat onto the live row and never rewrites
`title` — so a relative phrase frozen on a Tuesday card is simply false by
Friday, and false reads as authoritative.

So the split is: the SENTENCE carries a time that stays true ("since Friday
11 September 2026"), and the moving version he actually wants is rendered by
the CARD from `facts`, at read time, against the clock in front of him
(`factLines` → "3d ago", exact instant on the tooltip). Same shape as the
linked subjects: the fact goes in `facts`, the rendering happens where it
can be correct.

### A third correction, found while reviewing my own work

The muted VIEW first keyed on the `muted_at` stamp on the row. Clearing a
condition forgets its mute and leaves that stamp — it is the row's history —
so a cleared row stayed in the muted list for ever, with an Unmute button
for a silence that was already over and a count beside the tab that only
went up. The view and the count read `notice_mutes` now, and the listing
carries `silenced` (is it quiet NOW) beside `muted_at` (was it ever).

Migration 033 is the other half of 1.3 that a code change could not reach:
every row a live box has ALREADY marked `seen` is in a state the code no
longer produces, and would have stayed invisible to every future digest. It
rewrites those rows by their evidence and then tightens the CHECK so the
state cannot come back.

## The walk, 2026-09-16 — and the two defects it found

All seven steps pass on the deployed stack. Steps 1, 2 and 4 read from the
database and the trace; 3, 5 and 6 are `e2e/inbox-walk.sh`; 7 is
`e2e/responsive.sh`.

Neither defect below was visible to any unit test, and both were found by
doing the thing rather than by reading the code.

**A clear lifted a silence the live row still needed.** The mute keys on the
CONDITION; "clearing forgets the mute" was applied per ROW. One beat does
both halves at once — `record` raises the new facts while `reconcile` clears
the old reading — so muting a timer at four failures and letting a fifth
arrive left `notice_mutes` EMPTY. He was not told (the state is stamped at
insert), but the muted view could not show him the silence, the count said
nothing was muted, and a sixth failure would have come back unmuted. S25.1
survived one fact change instead of none. Both writers of `cleared_at` now
share `_FORGET_THE_MUTE`, which keeps a key any live row still depends on.

**Her `unread` view reported conditions that had stopped being true.**
`VIEWS["unread"]` had no liveness term, so every condition that had ever
cleared and never been opened came back as news. Asked "what is in my
inbox?", she named a memory problem and an agent that had both stopped
weeks earlier — with a real `notices` span on the trace behind the
sentence, which is what makes this the worse of the two. Re-walked after the
fix: `state="unread"` returns exactly the three live rows.

The muted view and its count are LIVE silenced rows now, so the number on
the tab and the list behind it cannot disagree.

### Q4 — what you were told, and when

Built and walked. A third tab on the Inbox: one section per TELLING, newest
first, with what is still standing and uncarried underneath.

A digest is never stored. S24 already records `delivered_message_id` on
every row, so the grouping is derived from it — a digest row beside the
notices would be a second copy of the same truth, free to disagree with
what it claims to contain.

Two things the tests pin that are easy to get wrong: `limit` counts
TELLINGS rather than rows (a row limit cuts the oldest group in half and
presents the remainder as the whole of it — "she told you one thing", when
she told him four), and a notice nobody was told about belongs to NO group
rather than drifting into the newest one. A cleared notice stays in the
telling it was part of: the card says the condition stopped, but a record
of what he was told does not get edited when the world moves.

### Still open

Nothing. The slice is done.
