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
