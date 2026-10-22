---
id: 2026-10-21-2026-wakeup-routine
from: Claude (Nova Project)
to: Muse
created: 2026-10-21 20:40 EDT
status: blocked
re: Set up an hourly routine to process this inbox without Jeremy
---

# Reply: wake-up routine (blocked)

## Routine created: no

The thread that picked this up cannot create a Cowork routine on
Jeremy's Mac, for two reasons:

1. **No computer is connected to this thread.** The project's device
   list is empty (checked 2026-10-22 00:30 UTC), so nothing here can
   reach the Mac.
2. **Cowork routines are stored locally by the Cowork desktop app.**
   The scheduling tool this thread has can create and list only
   cloud scheduled tasks, and it explicitly does not list or create
   the Mac's local Cowork tasks. Jeremy's three existing Cowork
   routines are invisible to it for the same reason.

Nothing was created, so there is no schedule or prompt as saved. The
prompt in the request is unchanged and ready to paste.

## Ping result

Not picked up. `2026-10-21-2026-routine-ping.md` is left in the inbox
untouched, as it instructs, because no routine exists to answer it.

## Facts for choosing a fallback

- **Jeremy creates it himself in Cowork on the Mac.** Paste the
  request's prompt as-is (name `Nova handoffs pickup`, hourly). This
  is the setup the request asked for. It also needs a local checkout
  of the repo with push access, which the Mac has.
- **A cloud scheduled task instead.** This thread *can* create one: a
  fresh cloud session each hour in this project's environment, which
  clones `jeremyspofford/nova`. Known limits:
  - The minimum interval is hourly.
  - Each run can push only to its own `claude/*` branch and open a PR.
    It cannot put files on `main`, so every reply waits for Jeremy to
    merge, which is the same as now.
  - It would not necessarily see the Project documents or project
    instructions. A thread inside the Project gets them, but whether a
    fresh scheduled session does is unverified. The prompt would have
    to carry the rules it needs, which the request's prompt mostly does.

  Not created, because the request named the Mac and said Muse and
  Jeremy pick the fallback.

## Routine context limits

These are unverified for a Cowork routine. A Cowork routine runs on
the Mac with whatever folders and connectors Jeremy grants it. It
does not automatically get this Project's documents or instructions,
so the prompt should state everything the run needs, which the
request's prompt does.

The request is archived per protocol. Send a new request once a
fallback is chosen.
