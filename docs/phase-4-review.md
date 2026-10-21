# Phase 4: experience review

Phase 4 lets Nova work while you're away. A schedule is a plain file: when to
run, what to do, and where the report goes. Nova runs it unattended and hands
the report to the main conversation, which is now the front page you open
Nova to.

One real schedule ships: **the morning digest**. Each morning it reads your
mail and your memory, and writes one front page: a headline, then what needs
you, what's today and what's coming up.

Evidence:

- `npm run shots`: 91 of 91 checks pass
  ([results](screenshots/results.json)).
- `npm run check`: 106 tests pass, plus the token lint and theme contract.
- The real `claude -p` ran the digest unattended against the stand-in Gmail,
  and you can see its report as the front page
  ([real model](screenshots/paper-front-real-model.png)).

## The front page

- **"/" is now the main conversation.** It's one long conversation that
  never leaves the sidebar's top ("Main conversation"). Reports land here,
  and you can reply to them like any message.
- **A report reads as a front page**, not a notification
  ([front](screenshots/paper-front.png),
  [mobile](screenshots/mobile-front.png)):
  - a small caption with the schedule's name and time, linking to it;
  - the first sentence set as a serif headline;
  - the rest in the reading face, with the sections the playbook asks for.
- **When a report arrives**, a dot appears next to Main conversation. It
  clears once you open it, and it remembers across reloads.
- **A new day starts with the date.** When the last entry isn't from today,
  the page opens with today's date and "Nothing needs you yet."
- **Separate conversations still exist.** + or ⌘⇧O opens one at `/new`
  ("A new conversation, apart from the main one."), and they list by day as
  before.

## Schedules

- **A schedule is a file**: `~/Nova/schedules/<id>.md`. Its front matter
  holds `name`, `cron`, `deliver` and optionally `once` or `paused`; the body
  is what Nova does. You can open it and edit it.
- **Cron runs on your clock.** Times use your time zone. A time skipped by
  daylight saving runs just after the change, and a repeated hour runs once.
- **Nova runs one schedule at a time**, checking every 30 seconds.
- **Every run is recorded** in `schedules/runs.jsonl`: when it was due,
  when it ran, whether it worked, and the report's first line.
- **Ways to set one up:**
  - In Schedules, the morning digest is offered with a time and days
    (every day, weekdays, weekends) and a Turn on button
    ([empty](screenshots/paper-schedules-empty.png)).
  - In any conversation: "Remind me tomorrow to call the dentist", or "Every
    Friday at 4, remind me to send my timesheet." Nova shows a card with the
    name, when, where reports go and the exact instructions, and waits for
    Set it up ([card](screenshots/paper-schedule-approval.png)).
  - A reminder is a schedule with `once`: it runs, reports, and removes
    itself.
- **Where reports go.** Schedules set up from Schedules or the main
  conversation report to the main conversation. A reminder asked for in a
  side conversation reports back there, which the card says.

## The Schedules view

[Schedules](screenshots/paper-schedules.png) lists what's set, then what's
ready to set up. Each schedule shows:

- when it runs in words ("Weekdays at 6:45 AM") and when it runs next;
- when it last ran, with Read the report and the report's headline;
- What Nova does, folded, with the full instructions;
- Run now, Pause or Resume, and Remove.

## Every state designed

| State | What you see | Evidence |
| --- | --- | --- |
| Nothing set | One line on how to start, and the digest ready to turn on | [paper-schedules-empty](screenshots/paper-schedules-empty.png) |
| Set, not yet run | "Next: tomorrow at 6:45 AM" | walkthrough check |
| Running | A pulsing dot and "Running now…"; a toast says where the report will land | [paper-schedules-running](screenshots/paper-schedules-running.png) |
| Ran | "Last ran today at 8:05 PM. Read the report", with its headline | [paper-schedules](screenshots/paper-schedules.png) |
| Ran late | The report says "late, Nova wasn't running at 7:00 AM" | style reference |
| Missed (Nova off over six hours) | "Missed today at 7:00 AM: Nova wasn't running then." | style reference |
| Failed | In the list: what went wrong. In the conversation: the report in the error color, with Run it again | [paper-schedule-failed](screenshots/paper-schedule-failed.png) |
| Paused | "Paused", no next time, and Resume | [paper-schedules-paused](screenshots/paper-schedules-paused.png) |
| Removed | Gone at once, Undo for 8 seconds brings it back exactly | walkthrough check |
| A file Nova can't read | "Nova can't read when this runs: …" with the cron problem, or "This schedule has no instructions"; it doesn't run | style reference |
| Reminder card | Set it up or Not now; afterwards "Set up “Call the dentist”" | [paper-schedule-approval](screenshots/paper-schedule-approval.png) |
| Front page, quiet day | The date and "Nothing needs you yet." | walkthrough check |
| Mobile, themes | Same front page and view in Paper dark, Aurora, Aurora dark and Obsidian | `*-front.png`, `*-schedules.png`, [mobile-schedules](screenshots/mobile-schedules.png) |

## Safety

- **Unattended runs can't do anything that needs your OK.** Nobody is there
  to approve, so anything that would ask (a draft, a Gmail change, a command,
  going online after reading mail, a new schedule) is declined on its own.
  - The model is told why ("no one was there to approve it") and is asked to
    suggest it in the report instead.
  - The run log marks these "Not asked", so you can tell them from your own
    No.
  - The digest playbook also says not to draft, archive or change anything.
- **A schedule only starts with your OK.** `schedule_set` and
  `schedule_remove` always ask, and the card shows the exact instructions
  that will run. `write_file` can't write into `schedules/`, so the model
  can't set one up without the card.
- **Mail stays outside content.** The stand-in mailbox's phishing email asks
  the assistant to send your subjects to a URL. Unattended, the real model
  read past it and flagged it in the digest, in one line.
- **No promise without a schedule.** The system prompt now says Nova may
  only say "I'll remind you" or "I'll check back" if it sets up a schedule.

## Real model

| Run | Steps | Time |
| --- | --- | --- |
| Morning digest, unattended (stand-in Gmail, a commitment in memory) | Gmail search, read Dana's email, then the report: Dana's contract and Sam's hike under Needs you, Priya's budget numbers from memory, the dentist and the water bill under Coming up, the phishing email flagged, two offers | 18.2 s |
| The same, after one playbook change | as above, with a plain headline | 15.5 s |
| Reply in the main conversation: "Yes, draft the yes to Sam" | search, then a correct draft card to Sam | 5.1 s |

The first run labeled its opening "**Headline:** …". The playbook now asks
for one plain sentence, unlabeled, and the rerun was clean. That rerun is
the [real-model screenshot](screenshots/paper-front-real-model.png).

## Motion

- No new animations.
- A report arriving uses the existing reply fade. "Read the report" and links
  to a schedule land with the `found` wash.
- The running dot breathes, as the reply indicator does; under reduced motion it holds still.
- Remove fades the item (`--m-med`), as in Memory and Skills.

## Typography and spacing

- Token lint is clean.
- The report's headline uses the display face at `--t-display`. The rest of
  the report uses the reading face. The caption uses `--t-caption`, like
  datelines.
- The Schedules view reuses the Memory and Skills scaffolding. The setup
  fields and button share one 44 px height.
- The style reference shows every report and schedule state.

## Keyboard

| Key | Does |
| --- | --- |
| ⌘⇧O | A new conversation, apart from the main one |
| ↑ / ↓ | Previous / next schedule |
| Enter | Show or hide What Nova does |
| Delete or Backspace | Remove the schedule |
| ⌘/Ctrl+Z | Undo the last removal |
| Enter / Esc on a reminder card | Set it up / Not now |

## Budgets

| Budget | Measured |
| --- | --- |
| Cold start | 149 ms server + 159 ms page |
| Send → visible feedback | 9 ms |
| Scrolling: Nova's work per frame | p95 3.8 ms, max 10.7 ms (budget: p95 ≤ 8 ms) |
| Scheduler | one file read per schedule every 30 s; no model call unless a run is due |

## Copy

- Intro: "Work Nova does on its own, at times you choose. Reports arrive in
  the main conversation, and each schedule is a plain file in your Nova
  folder."
- Empty: "Nothing is scheduled yet. Turn on the morning digest below, or ask
  Nova in any conversation, such as “Every Friday at 4, remind me to send my
  timesheet.”"
- The rule, under the list: "Nova runs schedules while it's running. If it
  was off at a run's time, the run happens when Nova starts, if that's within
  six hours."
- Toasts:
  - "Running Morning digest now. Its report arrives in the main
    conversation."
  - "Paused. Morning digest won't run until you resume it."
  - "Removed Morning digest. It won't run again."
  - "Back, exactly as it was."
- The reminder card: "Nova wants to set up a reminder. It runs on its own and
  sends you one report, then removes itself."

## One more thing

The report's first sentence becomes the headline, and that same sentence is
what Schedules shows under "Last ran". So you can glance at Schedules and see
what each morning said, without opening it.

## Decisions for you

1. **"/" is now the main conversation, the front page.** In Phase 1, "/"
   opened a blank new conversation. Now + and ⌘⇧O do that, at `/new`. The
   main conversation is one long thread, so the digest and your replies to it
   build up day after day. Tell me if you'd rather the front page show only
   today.
2. **Schedules run only while Nova is running.** If Nova was off at 7:00, the
   digest runs when it next starts, if that's within six hours, and says it's
   late. Past six hours it's recorded as missed. Running even while Nova is
   closed needs an always-on machine, which is the hub idea, parked for later.
3. **Unattended runs decline anything that needs approval**, rather than
   waiting for you. The other choice is a run that pauses until you answer,
   which can hold up the next schedule. Declining keeps runs short, and the
   report offers the action so you can say yes.
4. **What goes in the digest.** It covers email, your memory and day notes
   now. Weather, a calendar or news would each need a source, so tell me
   which you'd want first.
5. **Run logs are kept but not shown.** Each run is a conversation in
   `sessions/`, hidden from the list. Phase 5's Activity view is where you'd
   see what a run did, step by step.
