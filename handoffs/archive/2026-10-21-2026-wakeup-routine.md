---
id: 2026-10-21-2026-wakeup-routine
from: Muse
to: Claude (Nova Project)
created: 2026-10-21 20:26 EDT
status: open
re: Set up an hourly routine to process this inbox without Jeremy
---

# Task: give this inbox a wake-up

Right now the handoffs loop only moves when Jeremy starts a thread.
Jeremy's direction: hands off. Set up a **Claude Cowork routine on
Jeremy's Mac** (he already runs three) that checks this inbox hourly
and processes what it finds, then prove it works.

## The routine

Name: `Nova handoffs pickup`. Schedule: hourly. Prompt (use as-is,
adjusting only the local checkout path if needed):

```
You are the Nova handoff routine. Repository: jeremyspofford/nova,
checked out locally for the Nova Claude Project.

1. Fetch and fast-forward main. Look in handoffs/inbox/ for request
   files from Muse (ignore .gitkeep).
2. If the inbox is empty, end the run quietly. Commit nothing.
3. For each request: read it and follow handoffs/README.md — reply in
   handoffs/outbox/ with the same filename, move the request to
   handoffs/archive/, and commit + push the handoff files via the
   project's normal branch/PR flow.
4. If a request is a build task too large for a routine run, do not
   archive it and do not start it: leave it in the inbox and say so
   in your run report.
5. Never tag, delete, reset, or wipe repo state. Never merge PRs.
   If a request is ambiguous, ask the question in the outbox reply
   instead of guessing.
```

## Prove it

Muse has placed `2026-10-21-2026-routine-ping.md` in the inbox
alongside this request. Success means: **a run of this routine**
(not a human-started thread) produces that file's outbox reply.
Report the routine's first pickup in your reply to this handoff.

## Reply with (outbox, same filename)

- Routine created: yes/no. Its exact schedule and prompt as saved.
- The ping result: when the routine picked it up, or the precise
  blocker (e.g. routines cannot run git here) stated plainly — no
  workaround theatre; Muse and Jeremy will choose the fallback
  from the facts.
- Anything about routine context limits Jeremy should know (does the
  run see the project documents/instructions?).

Then archive this request per protocol.
