# Slice 11 — The proactive engine: she notices, she acts, she tells you once

Branch `slice/s11`, cut from `rebuild/v4` at 82c3858a (the S12 merge).
Status: BUILT, DEPLOYED and WALKED 2026-09-08.

Nova only ever speaks when spoken to. Everything she could notice — a
scheduled task that has failed five nights running, an agent sitting over
its cap, backups that quietly stopped, a promise you made in chat three
weeks ago — is visible in the database and invisible to you. S9 gave her a
scheduler and S12 gave her hands. This slice gives her attention.

## Decisions with Jeremy (2026-09-08)

Asked four questions; his answers, verbatim in effect:

1. **What may she do about what she finds?** "Act on anything her tools
   allow." The same freedom the agents got: no permission gate, spend caps
   are the only ceiling, and everything she does is traced and stated
   afterwards.
2. **What does she watch?** All four: the stack's own health; the work you
   gave her; money; and the things you said you'd do.
3. **How does she reach you?** "Chat, and push only when it matters."
4. **How do we stop it becoming noise?** "One digest a day, unless it's
   urgent."

Four more, asked once the shape was on paper:

5. **What may interrupt the digest?** The stack being down — and nothing
   else. Not money, not her own broken work, not the fact that she changed
   something. **The urgent list has exactly one entry.**
6. **May it reach him at night?** Yes, any hour, because only that one
   family can do it.
7. **How often does she look?** Hourly.
8. **Where does the digest land?** A chat message, plus an Inbox page with
   mute and open-the-trace.

Everything below follows from those four, plus the house rules: no
approval gates ever (the 2026-09-03 ruling), mechanical over prompts,
derived never hardcoded, never report success unchecked, no silent
fallback.

## The one hard problem, and the answer

"Unless it's urgent" cannot be a judgement she makes in the moment. A
model asked "is this urgent?" will talk itself into yes, and the digest
stops holding on the first bad night. So **urgency is a property of the
CHECK, declared in code, never a word in a reply.** Nothing she writes can
promote a finding.

Jeremy set the list, and it has ONE entry: **the stack being down.** A
service unreachable, the database refusing, the chat model gone. Money
over a cap waits for the digest. A scheduled task that paused itself waits
for the digest. Her having changed something waits for the digest. Because
that list is one item and is verified from a socket rather than a
sentence, an urgent push may arrive at any hour — the volume is bounded by
the list, not by a clock. A test asserts that exactly the stack family
declares `urgent`, so adding a second one is a deliberate act with his
name on it.

The same rule settles the harder half. v3 shipped this engine and its
noise half failed for one measured reason: the dedupe key was a hash of
the model's own text, so it re-worded two findings into fourteen phone
pushes in eight hours. **A fingerprint is computed from the derived facts
a check returns, never from the sentence about them.** A finding can only
speak again when the world changes.

## Two kinds of check, split by what can be verified

**Fact checks** are CODE. Each is a function returning zero or more
`Finding(key, facts: dict, urgent: bool)`; the fingerprint is a hash of
`facts`; the key is stable and author-written (`timer_failing:<id>`,
`agent_over_cap:<name>`). They can be urgent because their evidence is a
row, not a claim. They cover three of Jeremy's four areas:

- *The stack*: core, gateway, memory and ollama reachable; the chat model
  actually installed; disk headroom on the workspace volume.
- *The work you gave her*: a timer paused with a reason nobody has read; a
  timer at 4 of its 5 consecutive failures; a delegation that closed error;
  an agent whose bound timer went unbound by a delete.
- *Money*: spend against each cap; a provider walled by the gateway; a day
  costing more than the trailing week's mean by a stated multiple.

**Review checks** are a MODEL turn over a bounded window — the fourth
area, "things you said you'd do", which no query can compute. Their
findings are claims, so: they may never be urgent, they are guarded (see
below), and each finding must cite the message or memory id it came from.
A review check that cites nothing produces nothing.

That split is the honest line: mechanically verified findings may wake
you; a model's reading of your chat history may not.

## Architecture

### The beat is a timer kind, not a new loop

Migration 022 relaxes 019's `kind` CHECK to include `'beat'`. A beat row
is an ordinary timer, so it inherits — free and already tested — the
`FOR UPDATE SKIP LOCKED` claim that makes firing exactly-once, the
pause-after-5-consecutive-failures ceiling with its reason on the row, the
firings history with per-channel delivery receipts, retention, and "Run
now" on the Schedules page. `scheduler._run_firing` gains one branch.

Two beats are seeded (the `timers.JOBS` one-row-per-handler idiom): a
`watch` beat, **hourly**, that runs the checks and acts; and a `digest`
beat, daily at an hour you set, that composes the one message. Hourly is
cheap because the fact checks are database and socket reads with no model
call — the model is only asked when there is something to say. Both are ordinary
rows you can pause, retime or delete.

**A job handler cannot do this** — `_fire_job` calls `handler(pool)` with
no `app`, so it has no gateway, no memory, no tools. That is why a beat is
a timer kind rather than a job.

### Where a beat's turn lands: the quiet path

`chat._run_turn` is pinned as the only writer of an assistant message and
it always writes one, so every scheduled firing today puts a bubble in
your chat. A beat must be able to find nothing and say nothing. It gets
its own INACTIVE conversation — exactly the trick S12 uses for an agent's
log — so the turn is whole, traced, and under every honesty guard, but the
reply lands where your chat never picks it up. The digest is what reaches
you, and it is written on purpose.

`turns.kind = 'beat'` needs no DDL (no CHECK on that column), but two
things must move with it in the same commit: `chat._ROLE_BY_KIND`, or the
gateway gets no `X-Nova-Role`, serves the explicit model with no chain and
no fallback, and meters the spend under a NULL role; and the web's
`TURN_KIND_LABEL`, which deliberately shows nothing for a kind it has not
met.

### The notice: recorded before it is delivered

Migration 022 adds `notices`: `id`, `turn_id`, `firing_id`, `check` (the
check's name), `fingerprint`, `title`, `body`, `facts jsonb`, `urgent`,
`acted` + `acted_turn_id`, `repeats`, `first_seen_at`, `last_seen_at`,
`state` CHECK in `('raised','delivered','failed','seen','muted')`, and
CHECKs that demand evidence for each state (delivered carries a time,
failed carries a reason). The row is written BEFORE any delivery is
attempted, and the delivery outcome is written back onto it, so a channel
that is disabled, unconfigured or broken leaves an honest record instead
of silence.

Repeat folding: a finding whose `fingerprint` already has an unmuted row
increments `repeats` and `last_seen_at` and delivers nothing. Suppression
is countable, never silent — the firing's record says "folded onto notice
X (3rd time)". A repeat of a notice that never actually landed is not a
repeat.

### Delivery: the ladder, and what "delivered" means

The digest always writes a chat row and an Inbox row — that rung is
guaranteed and is what marks the firing ok. An urgent notice (the stack
family only) also calls `device_notify` on every connected paired device,
at whatever hour it happens. Each rung reports separately with the vocabulary
the Schedules page already renders: `ok` only from the channel's own
result frame, `failed` with the stated reason, and `stated` for "no paired
device was connected". A beat that reached nobody at all is a FAILED beat.
`device_notify` needs a live websocket and has no queue, so "your phone
was asleep" is a stated fact, never a silent drop.

### Acting

Jeremy chose: she may act on anything her tools allow. The watch beat's
turn carries her full toolset, so a finding and its fix happen in one
traced turn; the notice records `acted` with the turn id, and the digest
says what she did, not what she might do. There is no approval, no
proposal state, no button — the record is the account, and the Inbox's
only controls are seen, mute and open-the-trace.

The implication, stated plainly because it is a real change: she can fix
something at 3am and tell you at breakfast. That is what these two answers
mean together.

### Which line of code refuses when she is wrong

Five new mechanical checks, three of them guards in the existing family:

1. **Quiet is computed, never claimed.** A beat is quiet only when every
   check RAN and none flagged. A check whose probe did not run makes the
   beat `incomplete` with the reason — never "all clear". This is the v3
   incident in reverse: there, a beat pushed the harness's own "this turn
   produced no reply" text to the phone as news and recorded success.
2. **`observation_check(reply, spans, findings)`** — a beat may assert a
   finding only about a check that actually produced one this turn. An
   unbacked "I noticed the backups haven't run" is corrected and the beat
   is recorded failed. Derived from the live findings, not a phrase list.
3. **`delivery_claim_check(reply, person)`** — the first guard whose fact
   source is outside this turn: "I already told you" / "I sent you a
   notification" is contradicted unless a notice for this person is in
   state `delivered` or `seen`. One explicit query, failing open on a read
   error with the failure recorded.
4. **Novelty is checkable in the same stroke** — "this is new" is
   contradicted when the fingerprint is already stored.
5. **The harness-prose detector**: when a turn's `llm_call` spans all
   report zero completion characters, the text was written by the backend,
   not the model; that beat records `unable` and delivers nothing. No spans
   at all is indeterminate and must NOT suppress a real report.

### Settings and surfaces

`SETTING_DEFS` gains `proactive.enabled` (bool, default **false** — this
ships off and you turn it on), `proactive.digest_at` (str `HH:MM`, with a
validator that returns the problem in words), and
`proactive.max_notices_per_day` (int) as a backstop under the digest. The
zone comes from `tools/timers.household_timezone`, which distinguishes
"stored UTC" from "never answered" and raises on a broken zone —
`scheduler._owner_timezone` swallows failures into UTC and would silently
put your digest in the wrong place.

`/inbox` in the System group **after** `/agents`, so the MobileNav
adjacency pin stays green. Each row: what she found, what she did (with a
link to the trace), when, how many times it has recurred. Buttons: seen,
mute, open the trace. A count badge fed by a server-derived unseen count,
never a client guess. Muting is a noise preference and must survive
retention — v3 deleted mutes and re-armed a nag forever.

## Sub-slices

- **S11-1 the beat spine.** Migration 022 (`kind` CHECK, `notices`);
  `beat` kind through `_run_firing` with its own inactive conversation;
  `_ROLE_BY_KIND` and the web label; `asyncio.wait_for` around a firing
  with the timeout recorded as an error (the S9 carry, taken now because a
  recurring beat is exactly what hangs and delays every reminder behind
  it). GATE: a beat fires, opens a turn, writes nowhere the owner sees, and
  shows in Activity.
- **S11-2 fact checks + notices.** The check registry and the three
  mechanical families; `Finding`; fingerprint over facts; the notices store
  with folding and the countable suppression record. GATE: a seeded failing
  timer produces exactly one notice, and a second beat folds onto it with
  `repeats = 2`.
- **S11-3 the digest and the ladder.** The digest beat; urgent bypass; the
  chat rung and the device rung with three verdicts; delivery written back
  onto the notice. GATE: two findings in a day produce ONE chat message; an
  urgent one arrives immediately and says which check made it urgent.
- **S11-4 the guards.** Quiet computed; `observation_check`;
  `delivery_claim_check`; novelty; harness-prose. One eval-corpus case
  (suite_version 7 → 8, count pin moves with its reason). GATE: a scripted
  beat claiming an unbacked finding is corrected and recorded failed.
- **S11-5 review checks.** The bounded window over chat and memory, each
  finding citing an id, never urgent, guarded. GATE: a promise made in an
  earlier turn is surfaced with its citation; an uncited claim produces
  nothing.
- **S11-6 the Inbox and settings.** `/inbox`, the badge, seen/mute/trace,
  the three settings, docs and carries. GATE: a real click walk, and the
  whole thing turned on for one live day.

## Verification

The walk is the point of this slice and it cannot be faked: turn it on,
break something real (pause the gateway container, or lower an agent's cap
below its spend), and confirm she notices within one beat, acts if she
can, folds the repeat rather than repeating it, and tells you once at your
digest hour — with the trace for every claim. Then leave it running for a
day and count how many times it spoke.


## The live walk (2026-09-08)

Deployed from the branch; migration 022 applied and both beats seeded at
startup. Turned on from the API the Settings page uses, then:

- Setting the digest hour re-timed the digest beat and said so ("next Wed 9
  Sep 07:30 EDT"); "half past seven" was refused in core's own words.
- A healthy pass: 11 of 13 checks ran and it did NOT call itself quiet —
  two checks stated exactly why they could not look, and one real finding
  came out of it: the timer that paused when an agent was deleted during
  the S12 walk had been sitting unread.
- Stopped the memory container. The pass found it, marked it urgent, and
  pushed immediately into his chat with a sentence composed in code naming
  the check that made it urgent. The beat's own line stayed in the hidden
  conversation. The review check refused to run rather than read a narrower
  window, and said so.
- Fired again with memory still down: folded, pushed nothing.
- Restarted memory: the next pass CLEARED it, and it left the live set.
- The digest then REFUSED to deliver, because ollama had walled itself and
  the model wrote nothing — it recorded that reason instead of pushing the
  backend's own placeholder as news. That is the v3 incident, prevented.
- With the wall cleared it wrote one message covering both standing
  findings with how often each had recurred, that she had taken no action
  on either, the memory error that had since cleared, and the two checks
  that could not complete — ending "so neither check is an all-clear".
- The Inbox shows all three with their badges, sighting counts, derived
  facts and per-channel delivery, and its only buttons are seen and mute.

Two defects the walk caught are recorded in `slice-11-carries.md`, both
fixed there and then.
