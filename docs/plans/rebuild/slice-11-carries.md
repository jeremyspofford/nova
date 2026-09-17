# Slice 11 — carries

Open items from S11 (the proactive engine), each a fact about what is NOT
built so a later slice starts from the truth.

## Found in the live walk, fixed there

- **A check's deadline described the cheapest probe.** `review_commitments`
  hands a local 27B model a 6,000-character window and waits for structured
  JSON; the registry's shared 60 s cut it off, so the one check that reads
  his commitments never ran on its first hour. The deadline is now declared
  per check and only that one raises it (pinned).
- **A cadence skip read as a failure to look.** The review check looks every
  six hours, so five hours in six it reported "could not run" — which made
  INCOMPLETE the normal state and would have buried the real outage the
  signal exists for. A check is now either due or not; a not-due check
  leaves no gap (its findings are still standing as notices) and is still
  named, so "not due" never reads as "looked and found nothing".

## The first unattended night (2026-09-09), and what it changed

The engine ran with nobody driving it. His machine slept: core logged
nothing between 02:00 and 11:23 UTC, then every overdue timer fired at
once. The 07:30 digest fired on its own and correctly said NOTHING,
because nothing was outstanding — which is the design working. But it
would have said nothing about not having watched for nine hours either.

That produced the coverage line, and reviewing the coverage line produced
the finding that matters most in this slice: **the engine's own death was
silent.** The digest goes quiet when nothing is outstanding, and coverage
was computed after that early return. So on the day the watch beat stops —
five failures, a hand pause, or the switch — nothing new can become
deliverable, the standing findings are already delivered, and every later
digest writes nothing, forever. `run_all` is called only from the watch
beat, so no check can ever see its own beat die. Fixed: coverage is
computed first and a span with no proven pass breaks the silence.

Proven live on 2026-09-09 by pausing the watch beat by hand: the digest
delivered "you are hearing this because there is nothing to show that
anything was WATCHED either, so today's quiet is not evidence that
anything is fine", with the real 9h 18m overnight gap and the pause reason
off the row.

A watch-gap CHECK was built and then reverted whole: each night's gap is
its own fingerprint, so a nightly-sleeping host would raise a fresh
unmuteable notice every morning and surface each three times. The
unconditional coverage line closes the defect without the nag.

## Open

- **Watching stops when the machine sleeps.** This is a WSL-on-Windows
  host, so the containers freeze with it: nine of twelve hours had no pass
  on the first night. The digest now says so rather than implying cover.
  Watching while the machine is off is a different and much larger
  question — where Nova runs — and is not this slice's to answer.
- **Ollama walls itself under this load.** During the walk ollama took a
  502 ReadTimeout and the gateway walled it for an hour, which is S10
  working as designed — but an hourly beat plus a six-hourly model-reading
  check is new steady load on one local model, and the wall then blocks
  chat too. Worth watching before the cadence is raised.
- **`review_commitments` is the only check that spends money.** Everything
  else is a socket or a row. On a cloud chain it is a metered line item
  every six hours; v3's watchdog burned 6.3M tokens in one night while its
  ledger read $0.
- **The digest brief is unbounded** in the number of standing notices.
  `proactive.max_notices_per_day` holds the overflow (never drops it), but
  the brief itself grows with what is outstanding.
- **Model flicker on review findings.** A pass where the model overlooks a
  commitment it reported before clears that notice, and a later pass
  re-raises it as news. The fingerprint is right and the fold cannot help;
  muting is the owner's lever and the six-hour cadence bounds the cost.
- **No settings UI for the Schedules-side beat controls.** The two beats
  are ordinary timer rows and can be paused or retimed on the Schedules
  page, but nothing explains there what pausing them means.
- **Notices retention.** Nothing prunes cleared notices yet. The `retention`
  job is the right home, age-based, never a row cap — and it must never
  delete a MUTED row, which re-armed a nag forever in v3.

## Deliberately not built

- **Quiet hours.** Jeremy chose one digest a day plus an urgent bypass at
  any hour, and the urgent list is one item verified from a socket, so a
  clock gate would only delay a real outage.
- **A second urgent family.** The urgent set is pinned to the stack family
  two ways over the registry, so adding one is a deliberate act with his
  name on it.
- **Anything approval-shaped.** The Inbox reads and silences: mark seen and
  mute, and a test asserts no button matches approve, deny, reject, dismiss
  or allow. v3's propose-then-approve inbox is explicitly not mined.
