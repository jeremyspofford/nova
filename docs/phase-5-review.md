# Phase 5: experience review

Phase 5 lets Nova hand work off and shows you what it's doing.

- **Helpers.** Nova can give a long piece of work (research, comparing
  options, going through files) to a helper, and keep talking with you. The
  helper starts fresh with a brief and the files Nova passes. Its report
  comes back to the conversation that asked, like a schedule's report does.
- **Activity.** One calm page shows what Nova is doing now and what it did
  each day: every reply, scheduled run and helper, with its steps, what it
  asked you and what you said. It's read from the conversation logs, and
  keeps nothing of its own.

Evidence:

- `npm run shots`: 109 of 109 checks pass
  ([results](screenshots/results.json)).
- `npm run check`: 124 tests pass, plus the token lint and theme contract.
- The real `claude -p` delegated a research task with a self-contained brief
  and the right file, and its helper reported back on its own (see Real
  model, below).

## Helpers

- **How one starts.** Nova calls `delegate` with a title, a brief, and up to
  five files from your Nova folder. It needs no OK, since a helper can do
  less than Nova can. In the conversation you see "Asked a helper: “Compare
  e-bikes”" with **Follow it in Activity**, then Nova carries on with you
  ([hand-off and report](screenshots/paper-helper-report.png)).
- **What a helper sees.** Only its brief, who you are (AGENTS, SOUL, IDENTITY
  and USER files), the skills, and the passed files. It doesn't see the
  conversation, your memory, your day notes or your schedules, and it keeps
  nothing in memory. The walkthrough checks that a helper's log has no trace
  of the conversation or memory, and that it used the notes it was handed.
- **It acts on its own.** A helper can't ask you anything, so it takes the
  steps that would ask in a conversation (drafts, Gmail changes, commands,
  going online after reading mail) by itself, as `permissions.md` allows.
  See "Acting while you're away" below. It can't start helpers of its own or
  set schedules.
- **How many.** Up to three run at once; more wait their turn ("Waiting its
  turn" in Activity).
- **The report** arrives in the conversation that asked, with a caption that
  says "Compare e-bikes · a helper · 9:00 PM" and links to it in Activity.
  It's set in the reading face, the same size as a reply, so it doesn't read
  like a headline.
- **Its own log** opens like a conversation, without the composer, and says
  where it came from: "This is a helper's work on “Compare e-bikes”, asked
  for in … It worked on its own, so there's nothing to reply to here. Read
  its report." ([helper log](screenshots/paper-helper-log.png))
- **Stop and Try again.** Stop is in Activity while a helper works or waits.
  A stopped helper says so where its report would go: "You stopped this
  helper before it finished." with Try again, which reruns the same brief
  and files ([stopped](screenshots/paper-helper-stopped.png)).
- **If Nova stops mid-helper**, then on the next start the conversation gets
  "Compare e-bikes didn't finish: Nova stopped before it was done." with Try
  again.

## Activity

[Activity](screenshots/paper-activity.png) is in the sidebar under
Schedules. It shows a pulsing dot while Nova works, and "1 waiting" in the
accent color when something needs your OK.

- **Now** lists what's working, waiting for you, or waiting its turn.
  Anything waiting on you has **Go to it** and the one line of what it
  wants: "Waiting to run git status --short --branch".
- **Each day** has its date and one sentence for the day: "Six replies, the
  morning digest and two helpers. You were asked twice and said yes once.
  One thing went into memory."
- **Each entry** shows:
  - the time;
  - what it was: your words for a reply, the name of a schedule, or
    "Helper: Compare e-bikes";
  - where it happened, how long it took, and links to **Read the report**
    and **Every step**;
  - its steps, one line each, in the same words as the conversation:
    "Searched the web for …", "Read `notes.md`", **Declined** "Didn't run …",
    "Kept two things in memory". After three steps, the rest fold under
    "… and N more".
- **Tool output never shows here.** It stays in the logs, one click away
  under Every step.
- **Earlier weeks.** Activity shows a week at a time; "Show the week before"
  adds the previous one.

## Every state designed

| State | What you see | Evidence |
| --- | --- | --- |
| Nothing yet | "Nothing yet this week. When you talk with Nova, or a schedule or helper runs, each step shows up here." | style reference |
| Working | Pulsing dot, "Working", Stop for a helper; the sidebar dot pulses | [paper-activity](screenshots/paper-activity.png) |
| Waiting for you | "Waiting for you", Go to it, the request in a line; "1 waiting" in the sidebar | [paper-activity](screenshots/paper-activity.png) |
| Waiting its turn | "Waiting its turn", Stop takes it out of the queue | style reference |
| Done | Duration, Read the report, Every step | [paper-activity](screenshots/paper-activity.png) |
| Stopped | Muted title, "Stopped", Try again; the conversation says so | [paper-helper-stopped](screenshots/paper-helper-stopped.png) |
| Didn't finish | "Didn't finish" in the warning color, the reason in the step list | [aurora-activity](screenshots/aurora-activity.png) |
| Interrupted (Nova quit mid-reply) | "Interrupted" in the warning color | not pictured |
| Missed schedule | "Missed", "Nova wasn't running then" | style reference |
| Earlier week, empty | "Nothing happened that week." | not pictured |
| Server unreachable | "Activity couldn't be shown." with Try again | not pictured |
| Mobile, themes | One column, no sideways scroll; every theme | [mobile-activity](screenshots/mobile-activity.png), `*-activity.png` |

## Acting while you're away

You chose full autonomy. Scheduled runs and helpers now take every step that
would ask you in a conversation, without asking, and nothing is declined.

- **`~/Nova/permissions.md`** lists the five kinds of step, all set to
  "yes": write Gmail drafts, tidy Gmail, set up schedules, go online after
  reading mail, and run commands. To pull one back, change its "yes" to
  "ask". A step set to "ask" isn't taken while you're away; Nova suggests it
  in the report instead.
- **Nova can't grant itself anything.** `write_file` refuses
  `permissions.md`. A command could still change it, which the file says
  next to "commands".
- **In a conversation, Nova still asks.** The cards stay, because you're
  right there.
- **Every step shows.** A step taken this way is stamped **On its own** in
  the run's log and in Activity, and the day's sentence counts them: "While
  you were away, Nova took one step that would ask you in a conversation."
  ([Activity](screenshots/paper-activity.png))
- **What full autonomy risks.** Nova has no code to send or delete email,
  whatever the file says. Going online after reading mail is the risky one:
  an email could carry instructions telling Nova to post your mail to a
  website, and nothing now stops a run from doing it. Set `online: ask` if
  that worries you.

## Safety
- **Scoped context is also a privacy line.** Memory never reaches a helper,
  so a helper's search queries can't carry what Nova remembers about you.
  Only the files Nova chooses to pass are shared, and only from inside your
  Nova folder (not `sessions/` or `connectors/`).
- **No nesting, no schedules.** `delegate`, `schedule_set` and
  `schedule_remove` aren't offered to a helper.
- **A failed page is a failed step.** The real-model run showed `web_fetch`
  returning a 429 page as if it were a page to read. It now fails with "The
  page answered HTTP 429", so Activity and the transcript tell the truth.

## Real model

| Run | Steps | Time |
| --- | --- | --- |
| "Could you have a helper look into commuter e-bikes for me while we talk? My notes are in workspace/bikes.md. Meanwhile: how do I plan a week of meals?" | Nova answered the meals question, called `delegate` with a long, self-contained brief and `workspace/bikes.md`, and said the helper was working | (not timed) |
| The helper | Worked from the passed notes, made three searches, then four page fetches (rate-limited or 404 from the build container's network); 7 steps | report 42.5 s after the first message |

The helper's report was honest. It said the search and pages gave it
nothing, listed the needs from the notes (9 miles, a 6% hill, under $2,000,
rack and fenders), and offered unverified leads, labeled as such. It didn't
invent prices. The stand-in search only knows hiking socks, so a real result
needs a real search backend, which is Jeremy's machine.

## Motion

- No new animations.
- The Activity dot uses the existing working pulse. Under reduced motion it
  holds still.
- Opening an entry from a link lands with the `found` wash, as in Schedules.
- Activity enters with the same view crossfade as Memory, Skills and
  Schedules.
- A helper's report arrives with the existing reply fade.

## Typography and spacing

- Token lint is clean.
- Entries use a 72 px time column on desktop; on a phone the time sits
  above the entry.
- Titles use `--t-body` at 600, meta lines use `--t-callout`, the day
  sentence uses the dateline's italic.
- Steps are one line each, in `--text-2`, with the Allowed and Declined tags
  from approvals.
- A helper's brief is set in the reading face, so it reads as words
  written to the helper.

## Keyboard

| Key | Does |
| --- | --- |
| ↑ / ↓ | Previous / next entry |
| Enter | Open or close an entry's steps |
| Tab | Into an entry's links and its Stop or Try again |

## Budgets

| Budget | Measured |
| --- | --- |
| Cold start | 142 ms server + 165 ms page |
| Send → visible feedback | 6 ms |
| Scrolling: Nova's work per frame | p95 3.9 ms (budget: p95 ≤ 8 ms) |
| Activity, walkthrough data (18 logs) | 4 ms |
| Activity, a very busy week (300 conversations, 6,000 replies) | 134 ms first load, 44 ms after |

Making a date formatter per entry cost 480 ms in the busy-week test. It's
now made once.

## Copy

- Intro: "What Nova is doing and has done: each reply, scheduled run and
  helper, with the steps it took and what it asked you. It's read from the
  conversation logs in your Nova folder."
- Hand-off in the conversation: "Asked a helper: “Compare e-bikes”" and
  "Follow it in Activity".
- Toasts:
  - "Stopped. The conversation that asked will say so."
  - "Compare e-bikes is starting again. Its report comes back to the same
    conversation."
- The system prompt tells Nova when to delegate (long or multi-step work),
  to write the brief for someone who has never seen the conversation, to say
  in a sentence what it started, and never to guess what the report will say.

## One more thing

The day's sentence. Activity doesn't open with a list of steps. Each day
opens with one line, such as "Six replies, the morning digest and two
helpers. You were asked twice and said yes once." That one line tells you
whether Nova did anything while you weren't watching. When a scheduled run
couldn't ask, it says so: "One step needed your OK while you were away, so
it was suggested instead."

## Phase 4 decisions, applied as recommended

You said Phase 4 worked and to continue, so its open decisions went with the
recommended defaults. Any of them can change:

1. "/" is the main conversation, the front page. You confirmed this.
2. Schedules run only while Nova is running, with a six-hour catch-up.
3. ~~Unattended runs decline anything that needs approval.~~ You changed
   this: runs and helpers act on their own (above).
4. The digest has no weather, calendar or news yet.
5. Run logs were hidden until now. Activity's Every step now opens them.

## Decisions for you

1. **A helper's report arrives as it is.** Nova doesn't reply to it on its
   own. The other choice is for Nova to read each report and add a line,
   which costs a model call per report and puts words between you and the
   work.
2. **At most three at once.** This keeps a burst of delegation from using up
   your rate limit. It's one number in `src/helpers.js`.
3. **Helpers get no memory.** Memory is what makes Nova yours, and a helper
   that searches the web shouldn't carry it out. If a helper needs a fact,
   Nova writes it into the brief.
4. **Activity is derived, a week at a time.** Nothing new is stored. A very
   busy week (6,000 replies) still loads in under 150 ms, though the page
   would be long to scroll.

## Known limits

- A very busy week renders every entry at once. If that ever happens,
  collapsing older days is the next step.
- The helper was only checked against the stand-in search, and the build
  container's network rate-limited real pages.
- This is the last planned phase. MCP connectors were agreed as a later
  extra and haven't started.
