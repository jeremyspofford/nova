# Plan: hard caps on autonomy cost (Amendment 2026-10-31-B Part 5)

Track 3, branch `costcaps/v1`. The amendment calls this "a small design + build". It governs:
- **Per-task ceilings:** on iterations, tokens and, where priced, dollars.
- **Hitting a ceiling** stops the task, reports in plain words what was spent and why it stopped,
  and offers to resume as a new approval.
- **A per-day ceiling** across tasks, which behaves the same way.
- **Conservative defaults,** configurable in Settings.
- **Month-to-date spend** (tokens, plus priced dollars, per provider) visible in Health.
- **A loop detector:** repeated near-identical tool calls count toward the iteration ceiling at
  an accelerated rate.

## What exists, and what this reuses

- **The agent loop** (`src/runner.js` `loop()`) makes every model call and every tool step of a
  scheduled run or a helper.
  - The chat-run worker (`src/chat-run.js`) runs those as Work Ledger tasks.
  - A loop's only bound today is `max_tool_steps`: 8 per reply, per run, by default.
  - It has no token, dollar, day or repetition bound.
  - **This is where an autonomous loop spends**, so the meter sits here.
- **Usage numbers.** The registry's chat call returns `{text, aborted, usage?}`. The
  OpenAI-compatible adapter reports `usage.tokens_in/out` when the server does. The model
  command (`agent_cmd`) and the local-model role path report none.
  - **Reused as is:** reported tokens are taken as given.
  - **Otherwise:** they are estimated from length (4 characters a token) and marked `estimated`
    everywhere they are shown.
- **Prices.** The model manager's price table (`PUT /models/prices`, profile `models.prices`,
  dollars per million tokens by model) is read, not copied. M10d's rule applies: what Nova can't
  price, it can't keep inside a dollar ceiling.
  - Local models cost $0.
  - A model off the devices with no price makes a task with a dollar ceiling stop **before**
    its first call, saying "add its price in Settings › Models". The cloud budget's
    `budgetBlock` does the same.
- **The cloud budget** (`models.budget`, per task and per period, M6) still gates the cloud
  fallback of `models.infer`. These ceilings sit beside it and cap the whole autonomous run.
  Both apply, and neither replaces the other.
- **The Work Ledger:**
  - A stopped run's task ends `failed`, the way a run stopped at `max_tool_steps` does today.
  - The resume is a **new** chat-run task at approval tier 2. The ledger's existing gate holds it
    in Tasks as "Needs your OK before it runs".
  - Approving it is the new approval. Cancelling it is "no".

## The design

A core module, `src/core/caps/`, which knows nothing about Era 2:
- **`Caps`** holds the limits and the spend.
  - **Limits:** profile `policy.caps`, merged over the defaults, validated in plain words.
  - **Spend:** the store below.
  - **Views:** today, and month to date per provider and model.
  - **Routes:** `capsRoutes()`, ready to wire (NOTES).
- **The store.** Plain JSON lines under the home, `workers/spend/<YYYY-MM>.jsonl`, one line per
  model call. A line holds the time, the day in the person's timezone, task and session, provider,
  model, where it ran, tokens in and out, whether they were estimated, and dollars (or unpriced).
  - **No migration.** `workers/` is one of Nova's own home entries, so checkpoints, restore and
    reset treat it like the rest of Nova's state.
  - **Safe from the agent.** The agent's `write_file` can't reach it.
  - **Small.** A month's file holds one line per model call.
  - A database table would replicate to the standby, where this file does not. That is in NOTES
    as an optional migration, and named as a limit below.
- **`Meter`.** One meter per run segment of a ledger task:
  - `check(next)` before every model call;
  - `model(usage)` after every model call;
  - `step(call)` after every tool call is read, before it runs.

  `check` and `step` return a **stop**, in plain words, or null.
  - **The words:** what was spent (steps counted, tokens with how many were estimated, dollars or
    "unpriced"), which ceiling was hit, and that resuming waits for the person's OK in Tasks.
  - **What counts:** a person's own conversation is metered for the month's spend but never
    capped. The person is there, and `max_tool_steps` still bounds each reply. Ceilings apply to
    ledger tasks: scheduled runs and helpers.

### Ceilings and defaults (conservative, configurable)

| Ceiling | Per task | Per day (all tasks) |
|---|---|---|
| Iterations (weighted steps: one per model call that asks for a tool, more for a repeat) | **24** | **300** |
| Tokens (in + out, reported or estimated) | **150,000** | **1,500,000** |
| Dollars (priced usage only) | **$0.50** | **$5.00** |

**Why these numbers:**
- **Iterations.** A run is at most 8 tool steps per reply today (`max_tool_steps`). So 24 is
  three times the longest legitimate single run, and is reached only by repetition or by
  resumes. That leaves the loop detector to end loops, and leaves ordinary work alone.
- **Tokens.** Nova's system prompt is about 5–10k tokens on every call, so a full 8-step run is
  about 90k. 150k allows a long run and stops the second one in a loop.
- **Dollars.** No default chat model is priced. 50 cents a task and $5 a day is where an unpriced
  mistake ends quickly. Anyone who wants more spends deliberately.
- **Per day:** about ten long tasks. A schedule every 30 minutes on a local model fits. A loop
  across many tasks doesn't.
- **The day** is the person's timezone. Ceilings of `null` mean "no ceiling" and are only ever set
  on purpose.

### The loop detector (the documented runaway shape)

- **The rule.** A tool call's **signature** is its name plus its arguments, normalised:
  - keys sorted;
  - strings trimmed, whitespace collapsed and case folded;
  - every run of digits becomes `#`.

  So `fetch …?page=2` and `fetch …?page=3` are near-identical. Within the run's last **10** tool
  calls, a call whose signature has already appeared *k* times counts **1 + 2k** iterations
  (capped at 9) instead of 1.
- **The effect:**
  - An exact loop costs 1, 3, 5, 7, 9… and reaches the default 24 at its **5th** call, before
    that call runs. Today it reaches `max_tool_steps` at 8, or 30 or 100 if configured higher.
  - With the ceiling raised for a long task, the same loop still dies within about 10 repeats
    (9 per repeat).
  - Work that doesn't repeat costs 1 per step.
- **The cost to honest work.** A three-page pagination costs 1+3+5 = 9.

### Stopping, reporting, resuming

1. **The stop.** The meter returns a stop. The runner records it as the turn's error, with
   `detail: cost_ceiling:<which>`, and ends the turn. A looping call is stopped **before** it
   runs.
2. **The report.** The chat-run worker hands over the report as usual: "<name> didn't finish.
   <the words>". The task ends `failed` with the same words.
3. **The resume offer.** For a ceiling stop it also creates the **resume task**: the same
   kind, run and privacy, and `inputs.resume = <the stopped task's id>`. It is tier 2, so it
   waits for the person's OK.
4. **Approved,** it starts a new turn in the **same** conversation, through the kind's own
   `begin`.
   - The model sees what it already did.
   - It gets a **fresh per-task allowance**.
   - The day's ceiling still holds.
5. **The day's ceiling.** A run that starts after the day's ceiling is reached stops before its
   first model call, in the same way. Its resume waits for the person, and runs once there is
   room again.

## The minimal changes to Era 2's agent loop and worker (Track 1 reviews them)

The cap has to be **inside** the loop: only `loop()` sees each model call and each tool call
before it runs. Each change is additive and inert when `runner.caps` isn't set, which is how
every existing test runs.
- **`src/runner.js`:**
  - `loop()` takes a meter (ledger tasks are capped; chats are metered only).
  - It calls `check` before each model call, `model` after it, and `step` before a tool runs.
  - On a stop it records the error and returns.
  - `report()` reads the run's **last** turn instead of the first, so a resumed run reports its
    resumption. For a run of one turn, that is the same turn.
  - `runTasks`: the ledger task each run is doing, set by the chat-run worker.
- **`src/chat-run.js`:**
  - `delivered()` is matched per task, so a resume isn't mistaken for the stopped run's
    delivered report.
  - `outcome()` reads the last turn.
  - A `resume` input starts the continuation once.
  - After a ceiling stop, it offers the resume task.

The ledger itself (`src/core/ledger.ts`) is not changed: its tiers, gate and approve do the
resume.

## Owned files

- `src/core/caps/index.ts`: Caps, Meter, the signature, the defaults, the routes.
- `src/core/index.ts`: one additive export line, `export { Caps, … } from './caps/index.ts'`. The
  boundary rule needs it. It is not wiring.
- The runner and chat-run changes above.
- Tests:
  - `tests/core/caps.test.ts`: limits, the store, meters, the loop weights, the day, the month,
    prices, the routes.
  - `tests/acceptance/caps.test.ts`: a scheduled run through the real ledger and runner, with a
    stand-in model in a loop. The test shows it stopped, reported, the resume offered, approved and
    continued, and the day's ceiling holding.
- **The eval task:** `safety.runaway-loop-stopped` in the REGRESSION suite.
  - The harness gains a fixture hook that runs the task's turn as a scheduled run.
  - The stand-in attacker calls the same tool forever.
  - The task is graded on the outcome: stopped within 5 identical calls, with the words, and the
    resume waiting for an OK.

## Limits, said plainly

- **Usage reported by provider tasks isn't capped live in v1.** Claude Code, Codex and Relay run
  their own loops off Nova's runner. Nova sees their usage only in their report, after the fact.
  `caps.report()` records it toward the day and month. Wiring it to the ledger's reports, and
  holding new provider tasks once the day is used, is in NOTES.
- **Estimated tokens are estimates.** The model command and the local-model role report no
  usage. They are counted at 4 characters a token, and marked estimated.
- **The spend file is per node.** After a failover, the standby starts its own month's file until
  the optional migration (NOTES) makes it a replicated table.
- **A waiting resume holds its schedule.** A schedule runs one at a time, so the schedule's next
  run waits too. That is conservative, and cancelling the resume frees it.

## NOTES for Track 1

Written when the build is done; see below.
