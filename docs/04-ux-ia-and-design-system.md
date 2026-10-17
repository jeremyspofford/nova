# 04 — UX, Information Architecture & Design System

## 1. Information architecture

```
┌──────────────────────────────────────────────────────────────────────────────┐
│  Title bar:  [⌘K command]  [mode tabs: Chat · Work · Code · Agents]  [acct]  │
├───────────────┬──────────────────────────────────────────────┬───────────────┤
│  Sidebar      │  Main workspace                              │  Inspector    │
│               │                                              │  (context)    │
│  + New        │   ┌────────────────────────────────────┐     │               │
│  Search…      │   │  Goal & budget header (runs/agents)│     │  Artifacts    │
│  ─ Projects   │   │  Thread / Session / Agent / Run    │     │  Files        │
│  ─ Chats      │   │  …messages, tool cards, diffs…     │     │  Sources      │
│  ─ Work runs  │   └────────────────────────────────────┘     │  Activity     │
│  ─ Code       │   ┌────────────────────────────────────┐     │  Permissions  │
│  ─ Agents     │   │  Composer (preset, tools, attach)  │     │  Memory       │
│  ─ Library    │   └────────────────────────────────────┘     │  Apps         │
│  ─ Apps       │                                              │               │
│  ─ Activity   │                                              │               │
│  ─ Settings   │                                              │               │
└───────────────┴──────────────────────────────────────────────┴───────────────┘
```

The **Inspector** is a contextual right rail shared across modes. The main workspace of every
mode can split into multiple panes (chat + editor + preview + terminal, and from M5 and M6 diff
and browser), with a bottom panel for terminals (§4.3).

### Primary navigation (sidebar)

1. **New** (context-aware: new chat / run / session / agent)
2. **Search** (global: chats, runs, files, artifacts, commands)
3. **Chat** — threads, grouped by project/recent
4. **Work** — runs (active, scheduled, completed); the Scheduled list includes agents'
   self-set wakes (FR-206)
5. **Code** — sessions (active, archived), grouped by project
6. **Agents** — always-on agents
7. **Projects** — cross-cutting containers
8. **Library** — artifacts, files, attachments, images and project sources in one searchable
   list (FR-041)
9. **Apps** — global MCP Apps from plugins and MCP servers (§2.9)
10. **Activity** — global audit/notification stream
11. **Marketplace** — plugins, skills, themes (in M4 the plugin catalog lives in Settings →
    Plugins & skills, §2.12)
12. **Settings**

Every thread, run, session and agent row carries a status chip (§1.1).

**In M6** (ADR-093) the sidebar adds the agents under Agents, and **Spaces**, **Sites**,
**Computers** and **Devices** after Library and Apps; Settings adds **Agents**, **Computer use**,
**Channels**, **Triggers**, **Network** and **Browser**. Network is a Settings section in M6
(egress, credentials, the decision log); the top-level Network surface of §9 is M6.5.

**In M5** (ADR-092) the sidebar's Work entry lists the active runs with live status chips; the
Work list (`/work`) shows every run and **Scheduled** (`/work/scheduled`) the schedules. Code mode
(`/code`) lists the sessions.

### Mode definitions

| Mode | Purpose | Primary objects | Key affordances |
| --- | --- | --- | --- |
| **Chat** | Talk, explore, create | Thread | Streaming, attachments, artifacts, voice, dictation, memory, inline escalation to a run (§2.2.1) |
| **Work** | Delegate multi-step tasks | Run | Goal and budgets, plan, tools, sub-agents, schedules, approvals, activity |
| **Code** | Software engineering | Session | Env, permission mode, budgets, diffs, terminal, browser, PRs |
| **Agents** | Always-on agents | Agent | Goals, computer, per-channel threads, rules, proactive research, background threads |

### 1.1 Thread status (FR-215)

Every thread, run, code session and agent shows exactly one status, derived by the runtime
(`docs/09` §9), never set by model text:

| Status | Shown when | Chip |
| --- | --- | --- |
| **Needs input** | An approval (§2.6), a question or MCP elicitation (FR-188), or a hand-off is pending for it or any child | hand icon + "Needs input" |
| **Blocked** | It cannot continue without a change by the user: goal `blocked`, `budget_limited` or `usage_limited` (FR-181/182); last turn failed; environment or device unavailable; auto-paused by safety monitoring | stop icon + "Blocked" + reason |
| **Running** | A turn is in progress for it or any child | spinner + "Running" |
| **Ready** | Idle with nothing pending | check icon + "Ready" |

- The same four states and chip appear in the sidebar, the Agents list, the tray/menu-bar
  overlay (FR-008), the notification center and OS notifications (FR-013), and on phones.
- Precedence when a parent has children: Needs input > Blocked > Running > Ready. "Needs input"
  items sort first in every list, then Blocked, Running, Ready; most recent first within a
  group.
- Chips always pair icon and text (§7). Badges add detail without changing the status: an
  unread dot, "Paused", "Scheduled 09:00", "Budget reached", "Usage limit".
- **Notifications:** a change to Needs input or Blocked notifies through the routing rules and
  quiet hours (FR-060); a change to Ready notifies only for work that ran in the background.
  OS notifications for `pre_approvable` approvals offer **Allow once** and **Deny and
  continue**; every other decision opens the card (§2.6).
- **In M5** (ADR-092) the Hub's status service derives the chip for chats, runs and Code
  sessions (`ThreadView.derived`, `RunView.derived`), and `thread.status.changed` keeps every chat
  chip in the sidebar live, not only the open chat's. Chat, Work and Code lists sort Needs input,
  Blocked, Running, Ready. A run waiting for Start shows Needs input; a run paused at a budget
  shows Blocked "Budget reached", and one stopped by the review breaker Blocked "Stopped by
  auto-review". **Go to the next item that needs input** (`status.nextNeedsInput`,
  Ctrl/Cmd+Alt+A) cycles through chats and Work runs that wait on the user (§5).

**Quick overlay (FR-008).** The tray/menu-bar overlay holds quick chat (text or voice) and the
same status list:

```
┌──────────────────────────────────────────────────┐
│ Ask Nova…                             [mic] [↵]  │
├──────────────────────────────────────────────────┤
│ Needs input   Send the invoice        Run #128   │
│ Running       Fix flaky test          Code       │
│ Blocked       Nightly digest          Usage limit│
│ Ready         Trip planning           Chat       │
├──────────────────────────────────────────────────┤
│ [New task]    [Attach window]    [Open Nova]     │
└──────────────────────────────────────────────────┘
```

## 2. Key user flows

### 2.1 First run (FR-014)

1. Welcome → choose providers (cards for Anthropic, OpenAI, Google, OpenRouter, Local).
2. Authenticate via OAuth (if supported) or paste API key (stored in keychain).
3. Pick the default model preset (§3.1); set name/avatar.
4. Optional: connect one tool (GitHub/Slack/Drive/local folder).
5. Optional: import from another assistant (§2.11).
6. Sample task pre-filled with a Run this button.
7. Land in Chat with a success toast. Everything skippable; state stored so it resumes.

### 2.2 Send a message (FR-017/018/019)

1. Type or dictate (§3.2); the composer expands, shows preset, tool and attachment chips.
2. Send → optimistic user bubble → assistant bubble streams.
3. While streaming: Stop, Steer (message queues/steers per setting), and "branch".
4. Tool use renders as a collapsible card with status, args, and result. A tool whose
   descriptor declares a UI shows its MCP App inline under the card (§2.9).
5. On completion: actions bar (copy/regenerate/branch/like), citations, artifact cards, and up
   to three suggested follow-ups in the empty composer (§3).

A user message that a stop hook started (FR-197) is labelled **Hook** instead of "You". It
carries provenance `hook`, is never shown as the user's instruction, and authorizes nothing
(FR-189, ADR-091).

In M5 (ADR-092) messages Nova starts are labelled by their author too: **Run objective**,
**Schedule**, **Goal**, **Task** (a sub-agent's task) and **Nova**. A compaction shows as a
collapsed summary just above the turn it was made for; the earlier messages stay visible and
searchable.

#### 2.2.1 Chat escalation to Work (FR-186)

When a chat request needs multi-step tool work, the assistant offers an inline run instead of
a mode switch. Settings → Chat → "Turn multi-step requests into runs": `propose` (default),
`auto`, `off`.

```
┌──────────────────────────────────────────────────────────────────┐
│ This needs several steps. Run it as a Work run?                  │
│ Plan:   1 Find Q3 invoices  2 Reconcile totals  3 Draft a memo   │
│ Budget: 60 min · 2M tokens · provider spend cap   [Edit budget]  │
│ [Start run]   [Just answer]                                      │
├──────────────────────────────────────────────────────────────────┤
│ Running · step 2 of 3 · 12 min · 0.3M tokens                     │
│ [Open in Work]   [Stop]                                          │
└──────────────────────────────────────────────────────────────────┘
```

The run keeps the chat's context and policy scope, its approvals appear inline in the chat,
its result lands in the chat, and it is also listed under Work. In `auto` the card starts at
once with Stop visible.

**In M5** (ADR-092) the setting is Settings → General → **Work runs** → "Turn multi-step chat
requests into runs" (`chat.escalation`). The model calls `work.start`; its tool card becomes a
**run card**: proposed (the plan, the budget, **Start run** and **Dismiss**), running (live
progress and **Stop**) and finished (the summary and **Open in Work**). The run itself works in
its own Work thread, where its approvals appear; the run card links to it. The chat's last 10
messages reach the run as untrusted context, and **Start run** gives the objective the user's
authority. **Edit budget** and **Just answer** are not on the card in M5 (Dismiss leaves the run
unstarted).

A **question card** shows when a run or Code session calls `ask_user` (FR-188): the question,
choice buttons and/or a text box, and after answering the answer itself. "This question was
already answered on another device" (409) and "This question expired before your answer arrived"
(410) replace the controls. A call that waits on an approval, or failed, keeps the normal tool
card.

### 2.3 Delegate a Work run (FR-051…057)

1. New Run → describe outcome + attach sources + choose autonomy level; optionally set a goal
   and budgets (§2.3.1).
2. Agent produces a **plan card** (editable steps) → Approve plan or auto-proceed.
3. Steps execute; the run card shows live progress, budget consumption, child threads, and
   approvals inline.
4. Consequential action → **Approval card** (§2.6).
5. Result card: summary, artifacts, evidence links, "Open in Code" when applicable. A
   scheduled or delegated job that cannot verify its declared output ends as **Output missing**
   with the trace linked, never "done" (FR-187).
6. Run remains in Activity; can be paused, resumed, duplicated, or scheduled to repeat.

Deep research (FR-220) is a run template on the New Run screen: the plan lists sub-questions,
the run card shows sources gathered per sub-agent, and the result is a cited report artifact.

**Work mode as shipped in M5** (ADR-092):

- **Work list** (`/work`). Each run shows its status chip, title, project, last update and budget
  use, Needs input first, with an All / Active filter and live updates. **New run** (also
  `/work?new=1`) takes the objective (with a counter), an optional title, the template (Standard
  run or Deep research), the project, the autonomy (Ask first, Standard, Autonomous), the budgets
  (time in minutes, tokens, a cost limit; blank means the provider spend cap), and an optional goal
  and expected output (an artifact, a delivered message or a file). Defaults come from Settings →
  General → Work runs.
- **Run page** (`/work/<id>`). The header shows the title, the chip and where the run came from
  ("Started by you", "Started from a chat", "Started by a schedule", …), with **Pause**,
  **Resume**, **Redirect…** and **Cancel run** (confirmed). Below it: the budget meters, the goal
  panel, the plan card, the sub-agents with links to their threads, the result card with artifact
  previews and evidence (or **Output missing** linking the trace), the run's conversation
  (read-only, approvals inline; steer it with Redirect) and an **Activity** trace that opens step
  by step and replays without running anything.
- **Plan card.** Under Ask first the run proposes its plan and waits: **Edit plan**, then
  **Approve and start**. A run proposed in a chat can be started here too.
- **Scheduled** (`/work/scheduled`). Each schedule shows its next run, its last run and outcome
  (Done, No news, Output missing, Failed, Skipped) and "Set by agent" when an agent made it.
  **New schedule** (also `/work/scheduled?new=1`) offers daily, weekdays, weekly, every N minutes
  or hours, once, and an advanced cron or RRULE field, in the browser's time zone by default; the
  instructions, the notify condition, where to send results (in-app, OS notification, webhook), the
  expected output, the catch-up policy ("Catch up once" or "Skip them") with its lookback, and the
  project. Each schedule has **Run now**, **Edit**, **Pause** or **Resume**, **History** (fires,
  catch-up windows and skips) and **Delete**. **Schedule it** on a finished run opens the form
  filled in from that run (`?fromRun=<id>`).
- **Not in M5:** "Duplicate run", sources per sub-agent on deep research runs, and attaching
  sources to a new run.

#### 2.3.1 Goal and budget header (FR-181, FR-182)

Runs, Code sessions and agents show a header with the goal, live consumption against each
budget, and the actions the runtime allows (`docs/09` §2.1):

```
┌──────────────────────────────────────────────────────────────────┐
│ Goal: Migrate the billing tests to the new fixtures       [Edit] │
│ Goal status: Active                                      Running │
│ Time    ███████░░░  42 / 60 min    Tokens  ██░░░░░░░░  0.5M / 2M │
│ Cost    ████░░░░░░  $1.80 / $5.00  Steps this turn       37 / 200│
│ Last progress: 14 of 20 files migrated                           │
│ [Pause]   [Extend budget…]   [Mark complete]   [Stop]            │
└──────────────────────────────────────────────────────────────────┘
```

- Goal labels: Active, Paused, Blocked (with the blocker), Usage limit (resumes when the
  provider limit resets), Budget reached, Complete. Resume and Clear appear when they apply.
  The user edits the objective (≤ 4,000 characters, with a counter) and budgets; edits apply
  at the next turn. The agent can only report progress, blockers and the statuses the runtime
  allows it.
- Meters update live from usage events. Time waiting for an approval or input is not counted
  and the meter says so on hover.
- **At a bound** the run pauses and the header turns into a decision; the status is Blocked
  with the badge "Budget reached". It never continues silently:

```
┌──────────────────────────────────────────────────────────────────┐
│ Budget reached: time (60 / 60 min)                       Blocked │
│ Done: 14 of 20 files migrated; 2 tests failing (summary below)   │
│ [Extend 30 min]   [Extend budget…]   [Finish here]               │
└──────────────────────────────────────────────────────────────────┘
```

- **Extend budget…** edits time, token and cost budgets; a cost above the provider spend cap
  needs the cap changed first (FR-116). **Finish here** ends the run with the progress summary
  as its result.
- The 200-step backstop ends the turn, not the run: the header offers **Continue** (a new
  turn); the backstop itself is not editable here.
- Agents show the same header for each responsibility's goal, plus "Next continuation after
  quiet hours (07:00)" when quiet hours defer idle continuation.

**In M5** (ADR-092) the run page shows the meters live from `run.budget.usage`. At a bound the
banner "Budget reached: <bound>" offers **Extend 30 min** (time) or **Extend 1M tokens** (tokens),
and **Extend budget…**; after the 200-step backstop, "Step limit reached" offers **Continue**.
Extending adds to the bound (30 more minutes, 1M more tokens); extending cost does nothing while the
run has no cost cap. The goal panel sets, edits (with a 4,000-character counter), pauses, resumes,
reopens, completes and clears the goal, and shows the blocker and the last progress note. **Finish
here** and the "Steps this turn" meter are not in M5; Code sessions have no budgets or budget header
yet.

### 2.4 Code session (FR-061…070)

1. New Session → choose Environment (Local/Cloud/SSH/WSL/Container or a registered device),
   folder/repo, model preset, permission mode.
2. Agent explores (read/search), proposes a plan (Plan mode) or edits directly.
3. Every change surfaces in the **Diff** pane with `+x −y`; per-line comments; accept/reject.
4. Agent runs tests in the **Terminal**; **Browser** pane previews/verifies.
5. `/review` produces a findings card; apply fixes.
6. Commit/branch/PR from the session header; CI status streams in.
7. Panes can be arranged; layout is remembered per session and per project.

A write to a protected path (`.git`, `.nova`, `.agents`, credential locations) is shown as a
denied tool card naming the path and FR-190; it never raises an approval card, because no
decision can allow it.

**Code mode as shipped in M5** (ADR-092):

```
┌──────────────────────────────────────────────────────────────────────────┐
│ ← Sessions  Fix the parser   Running   ~/src/app · nova/fix-parser*      │
│                                  [Go to symbol]  [Review]  [Commit…]     │
├───────────────────────────────┬──────────────────────────────────────────┤
│ Conversation                  │ [Diff (2)] [Review] [Terminal] [File]    │
│ …messages, tool cards…        │  Changed files · Unified | Split         │
│                               │  + added line                            │
│ [Composer…]  [Mode: Accept ▾] │  − removed line      [Accept] [Reject]   │
└───────────────────────────────┴──────────────────────────────────────────┘
```

- **Sessions** (`/code`). The list shows title, folder, branch (with an uncommitted-changes note),
  mode, status chip and last update, Needs input first. **New session** (also `/code?new=1`)
  takes a project folder or a folder path on the Hub, the environment ("This Hub"), the model, the
  permission mode, an optional title and **Work in a new Git worktree**.
- **Session** (`/code/<id>`). The header shows the folder, the branch, **Go to symbol**, **Review**
  and **Commit…**. The conversation sits beside the session's own tabs, **Diff**, **Review**,
  **Terminal** and **File**, which stay mounted while hidden; they are not layout panes. The mode
  selector is in the composer; an unavailable mode stays listed, disabled, with the reason in its
  label.
- **Diff.** A file list, unified or split, lines marked + and − and spoken "Added" and "Removed",
  changed words highlighted. Accept or reject a hunk, a file or everything (**Reject all** asks
  first). Clicking a line number opens a comment box; comments collect as a batch and
  Ctrl/Cmd+Enter sends them to the agent.
- **Review.** The card groups findings by file with a severity icon and word; **Apply fix** sends
  the fix to the agent. Findings also show in the diff.
- **Commit…** suggests `nova/<slug>` when on the default branch and refuses the default branch
  itself, can accept the pending changes first, shows the sha and branch, and says when the
  repository's hooks did not run (only when it has hooks). There is no push or PR in M5.
- **Terminal.** Session shells and the agent's exec sessions (with an "agent" chip, the call id
  and **Kill**).
- **Not in M5:** the Browser pane, PR and CI status, layouts per session, the `diff` layout pane
  (still a placeholder) and `/review` as a composer command.

**In M6** (ADR-093) Code mode has three tabs, **Sessions**, **Environments**
(`/code/environments`) and **Worktrees** (`/code/worktrees`):

- **New session** picks the environment first (This Hub, a container image, SSH, WSL on a
  Windows device, or a `novad` device, each with its health), then the folder (a path on that
  machine for remote ones), an existing unleased worktree or a new one, and optional budgets.
- **Environments** lists, adds, checks, edits and deletes them; SSH keys and passwords are
  write-only. A remote environment lists its processes; opening one reads the output buffered
  while you were away.
- **Worktrees** groups them by repository with "N of 15", the lease and its expiry, Renew,
  Release (refused while a session works in it) and Remove (warns about uncommitted changes).
- The session header adds **Branch…**, **Push…** (a protected or default branch needs its name
  typed exactly; it is never force-pushed; secret-scan findings block the push and are listed),
  **Pull request…**, the PR link with a CI badge, and a budget bar (time, tokens, cost; at a limit
  it offers Extend). New tabs: **Pull request** (checks and their states), **Checks** (auto-verify
  runs and logs), **Dev servers** (start, stop, stop all; **Open preview** opens it in the agent
  browser of the session thread) and **Sessions** (other sessions: open, message, ask a side
  question with Ctrl/Cmd+Alt+S, archive).
- A session on another machine says plainly that diff, review, commit, Go to symbol, branches,
  push, pull requests and dev servers work only for folders on the Hub; those controls are
  disabled with the reason. Git hosts (connect with a write-only token) and the M6 Code settings
  are in Settings → Code.

### 2.5 Agent setup and operation (FR-079…090)

1. Create Agent → name, avatar, responsibility (with an optional goal), connect plugins.
2. Agent introduces itself; proposes a first task from available context.
3. Connect the user's computer (optional) or rely on the cloud computer.
4. Custom Rules configured under Settings → Personalization → Permissions.
5. Agent works in background; the **Activity** tab shows all work; approvals appear inline and
   as notifications.
6. Message the Agent from in-app or a channel. Each channel binding has its own thread, listed
   under the agent with the channel's icon; the agent's memory is shared across them (FR-088).
7. Self-set wakes (FR-206) appear in the Scheduled list with "Set by agent"; the user can edit
   or cancel them.

**In M6** (ADR-093):

- The sidebar's **Agents** entry lists the agents with their status chips; `/agents` is the full
  list and **New agent** opens `/agents/new`, a page (not a dialog): name, avatar, instructions,
  responsibilities and an optional first goal, autonomy, budgets, proactive research, memory and
  model. Connecting plugins per agent is not built.
- The agent page (`/agents/<id>`, the section in `?tab=`) puts the agent's main thread beside its
  sections: **Activity**, **Responsibilities**, **Goal**, **Rules** (the four effects, scope, an
  optional command prefix, a preview of recent calls it would have matched), **Memory** (edit,
  pin, forget; turning memory off says what it deletes), **Suggestions** (accept only records
  it), **Schedules** (wakes the agent set show their reason and only their time can change there),
  **Background**, **Threads** (channel and research threads open read-only; replies go through the
  channel), **Channels**, **Computer** (its computer, and a computer of yours connected through
  `novad`, FR-081) and **Profile**. Pause, Resume, Stop, Research now and Delete (with the
  delete notice) are in the header; the derived status chip and the agent's own state (Paused,
  Paused for safety, Stopped) show separately.
- The Scheduled list says "Set by <agent>" for a wake the agent set, "Created by <agent>" for a
  schedule it created and "For <agent>" for your schedule of an agent, each linking to the agent.
- Custom Rules live on the agent page; external agents (FR-194) and the agents defaults are in
  Settings → Agents.

### 2.6 Approve an action (FR-058/100)

```
┌────────────────────────────────────────────────────────────────────┐
│ Approval needed                                        Needs input │
│ Action:  Run `npm run migrate -- --env staging`                    │
│ Why:     Completing "Migrate billing schema" (Run #128)            │
│ Asked:   For your message at 10:42                                 │
│ Scope:   This command, in billing-service                          │
│ Tier:    Pre-approvable                                            │
│ Rule:    Tool default for `exec`: ask                              │
│ Review:  Auto-review: ask · risk medium · "touches staging DB"     │
│                                                                    │
│ [Allow once]  [Allow for this session]  [Always allow ▾]           │
│ [Deny and continue…]  [Deny and stop]  [Hand off]                  │
│                                              Expires in 23:59:12   │
└────────────────────────────────────────────────────────────────────┘
  Always allow ▾ ├ this tool (`exec`) in this project
                 ├ commands starting with `npm run migrate` (prefix rule)
                 └ network host staging-db.internal
```

Decisions (FR-100, ADR-060):

| Decision | Effect |
| --- | --- |
| **Allow once** | This call only. |
| **Allow for this session** | The same tool and scope for the rest of this session or run. |
| **Always allow** | A persistent grant scoped to the tool, a command prefix rule (FR-191; the rule and its examples are shown before it is added) or a network host. Listed and revocable in Settings → Permissions. Disabled with a "Managed" badge when managed policy turns persistent grants off. |
| **Deny and continue…** | Denies; an optional reason is returned to the agent as the tool result; the run continues. |
| **Deny and stop** | Denies and stops the run; partial results are kept. |
| **Hand off** | The user does the step; the run waits (Needs input) until the user marks it done or cancels. |

- A **timeout** is recorded as its own outcome (decision `timeout`) when nobody answers before
  the card expires (24 h by default, `docs/20`); the run then pauses (`approval_timeout`,
  `contracts/hub-api.md` §5) until the user resumes or cancels it.
- **Confirmation tiers** (FR-189): a `confirm_at_action` card shows "Asked every time; cannot be
  pre-approved" and offers only Allow once, Deny and continue, Deny and stop and Hand off. A
  `handoff_required` card says "You need to do this step" and offers Hand off (Open, then Done
  when finished), Deny and continue, and Deny and stop.
  These two tiers are answered only from an authenticated Nova client, never from a channel.
- **Intent provenance:** "Asked" links the user message that authorizes the work. Text that came
  from tools, pages, files, channels, other agents or capture is labelled by origin and is
  never shown as the user's instruction.
- **Auto-review** (FR-085): when the reviewer ran, its outcome, risk and rationale appear on the
  card. Overriding a reviewer deny is possible, audited, and the card says so.
- **Any client may answer** (FR-188): the card appears on every connected client; the first
  answer wins and the others show "Answered on <device>".
- Accessibility: focus lands on the card heading, never on an Allow button; Enter does not
  approve; screen readers announce "Approval needed" with the action.

### 2.7 Memory (FR-032, FR-204, FR-205)

Settings → Memory, also reachable from the Inspector:

```
┌──────────────────────────────────────────────────────────────────┐
│ Memory                                                           │
│ Use saved memories        [on]                                   │
│ Reference past chats      [on]   Turning off purges within 30 d  │
├──────────────────────────────────────────────────────────────────┤
│ Summary used in context   1,840 / 2,500 tokens            [View] │
├──────────────────────────────────────────────────────────────────┤
│ Work                                  [Remember more] [less]     │
│   Leads the billing team; prefers terse status updates           │
│   Q3 launch on 2026-11-02     upcoming     [Correct] [Dismiss]   │
│ Travel                                [Remember more] [less]     │
│   Trip to Lisbon, 2026-09-10  past event   [Correct] [Dismiss]   │
└──────────────────────────────────────────────────────────────────┘
```

- Items are grouped by category. Each item shows its source thread, last update and an age
  marker (a plan becomes "past event" once its date passes); Correct, Dismiss and Pin act on
  the item, and "Remember more/less about this topic" steers consolidation for a category or
  an item's topic.
- The summary is derived from the items and is read-only; changing it means correcting items
  (ADR-069).
- The two toggles are independent: saved memories and past-chat retrieval (FR-205).
  Temporary chats never appear here.
- Projects: the New Project dialog asks **Shared with my memory** or **Project only**.
  Multi-user shared projects are locked to Project only, with the reason shown.

### 2.8 Computer use (FR-093, FR-207)

The first time a run needs an app, a grant prompt appears:

```
┌──────────────────────────────────────────────────────────────────┐
│ Allow Nova to control "Spreadsheet"?                             │
│ Level:   Full control (other apps)                               │
│ For:     Run #131 "Fill the expense sheet"                       │
│ Expires: 30 minutes after you allow                              │
│ Stop at any time with Esc or the Stop button.                    │
│ [Allow for 30 min]   [Deny]                                      │
└──────────────────────────────────────────────────────────────────┘
```

- Levels by app class: browsers **View only** (the agent acts through the browser tool),
  terminals and editors **Click only**, other apps **Full control**. Active grants, their
  remaining time and Revoke are under Settings → Permissions → Computer use.
- While control is active, `novad` draws an always-on-top pill ("Nova is controlling
  Spreadsheet · Esc to stop · Stop") and an edge highlight around the controlled window or
  display, and the tray icon changes. Nova's own windows hide before it acts and return after.
- The **kill key** (§5) stops control at once and discards queued input; the run shows Needs
  input, "Control stopped by you", with Resume control, Hand off and Stop run.
- When sensitive-region masking fails, the action is refused and the tool card says why.

**In M6** (ADR-093) the web UI shows computers at `/computers` and `/computers/<id>`: kind,
substrate and state (with the reason when limited), owner agent, limits, snapshots (restore asks
first), the **browser panel** (the agent browser's page, frame, action trace with before/after
screenshots, pending private sign-ins) and the **screen panel** (computer use on/off, which asks
first; grants per app; recorded actions; appshots; **Take over** with a live view over a
WebSocket that sends your clicks, typing and keys; Tab and Esc never go to the remote screen, so
focus can always leave). A global **control indicator** shows while Nova controls any computer,
with Stop; while it shows, the kill key (`screen.killKey`, default Esc) stops control from
anywhere in the app, before any dialog sees the key. Settings → Computer use holds the grant
length, the kill key and tier overrides; Settings → Browser holds site permissions, allow and
block lists, saved logins and the browser settings. The desktop pill and edge highlight drawn by
`novad` come with its screen module (not built in M6).

### 2.9 MCP Apps (FR-198)

Plugin and MCP-server UI renders in an **App frame**: a sandboxed iframe with a header showing
the app name, its server or plugin, a Verified/Unverified badge, the allowed domains (from the
resource's CSP metadata), mode buttons and Close. In M4 the header does not list the allowed
domains yet (ADR-091).

```
┌──────────────────────────────────────────────────────────────────┐
│ Sample panel   Sample plugin   Unverified                        │
│                [Inline] [Full screen] [Picture in picture]   [x] │
├──────────────────────────────────────────────────────────────────┤
│  (the app, in its sandboxed frame)                               │
├──────────────────────────────────────────────────────────────────┤
│ Approval needed: mcp:sample.panel_action          Needs input    │
│ ▸ Shared with the model                                          │
└──────────────────────────────────────────────────────────────────┘
```

| Display mode | Behavior |
| --- | --- |
| **Inline** | Inside the transcript below its tool card, or in the Inspector's Apps tab; the height the app reports, kept between 80 and 600 px. |
| **Fullscreen** | A dialog over the main workspace: focus moves to **Exit full screen**, Tab stays inside, Esc or Exit returns. |
| **Picture-in-picture** | Floating; drag the header, or use **Move** and the arrow keys; resizable; stays visible across thread switches; one at a time (a second one sends the first back inline). On phones it becomes a bottom sheet. |

Entry points:

- **Global:** the sidebar's **Apps** (`/apps` lists them, `/apps/<id>` shows one as a page) and
  **Open app…** in the command palette.
- **Thread:** the Inspector's **Apps** tab (**Open** next to each app), or a tool result whose
  tool declares a UI. A chat's apps keep running while you switch Inspector tabs or close the
  Inspector. The composer's + menu → Apps comes later.
- **File:** **Open with <app>** in the file preview pane (§2.13), for apps registered for that
  extension; file apps are view-only in M4.

Tool calls from an app go through the policy engine and carry no user instruction, so under the
default policy a call that is not read-only raises an approval card. The card renders in Nova's
chrome below the frame, never inside it. A call still waiting after 60 s tells the app to run it
again once you answer. A message an app posts fills that chat's composer and is never sent on
its own; a link it asks to open is shown for you to click. A "Shared with the model" disclosure
lists what the app sent as model context; widget state marked private stays in the browser and
is never sent to the Hub or a model.

### 2.10 Trust a hook (FR-197)

A hook never runs until it is trusted by its content hash:

```
┌──────────────────────────────────────────────────────────────────┐
│ Trust this hook?                                 New · disabled  │
│ From:    Project "billing-service" hook file                     │
│ Event:   Before tool use · matches `exec` "git push*"            │
│ Runs:    ./scripts/check-branch.sh (sandboxed, timeout 30 s)     │
│ Hash:    sha256:9f2c…41ab                                        │
│ Can:     block this tool call, add context, ask once to continue │
│ Cannot:  override built-in safety, managed policy or a deny      │
│ [Trust]   [Keep disabled]   [View file]                          │
└──────────────────────────────────────────────────────────────────┘
```

- A changed hook shows "Changed since you trusted it" with a diff, and stays disabled until
  re-trusted. Changing it back does not trust it again.
- Hooks that arrive with a plugin appear on its install and update screens and are trusted
  there; a hash change in an update appears in the permission diff (FR-167).
- Settings → Hooks lists every hook with its state (Trusted, Needs re-trust, Disabled), last
  run, and a link to its audit entries.

**In M4** (ADR-091) the list is the **Hooks** section of Settings → Plugins & skills (Tools &
MCP links there). Each row shows the hook id (`hook:<origin>.<hookId>`), its state (**Trusted**,
**Needs trust**, **Disabled**, **Trust revoked**), its source, event and matcher, what it runs
with its timeout, a short hash, "Changed since you trusted it" when the content changed after
trust, and its last run and effect. Rows offer **Trust…** or **Untrust**; user hooks also have an
on/off switch, and managed hooks say "Trusted by your organization". The dialog above shows
From, Event, Runs, Hash (in full), Can and Cannot, with **Trust** and **Keep disabled**. If the
hook changed while the dialog was open, the Hub refuses the old hash: the dialog reloads, warns
and shows the new hash, and only that hash can be trusted. **View file**, the diff and the audit
link come later.

### 2.11 Import from another assistant (FR-200)

A four-step wizard, reachable from onboarding, Settings → Import and the command palette:

```
Import                                                    Step 2 of 4
┌──────────────────────────────────────────────────────────────────┐
│ Source: detected config folder · chat-export.zip                 │
│ [x] Instruction files      3                                     │
│ [x] Skills                12   2 already imported                │
│ [x] Commands → skills      5                                     │
│ [ ] Plugins                2   stay disabled until confirmed     │
│ [x] MCP servers            4   2 secrets move to the keychain    │
│ [x] Projects               2                                     │
│ [x] Memories             148                                     │
│ [ ] Chat exports           1 file, 312 chats                     │
│                                         [Back]   [Review →]      │
└──────────────────────────────────────────────────────────────────┘
```

1. **Source** — detected folders and open formats (instruction files, skill folders, MCP server
   configs, chat exports), or a chosen folder, file or archive. Sources are listed by path and
   format.
2. **Choose** — items by type with counts; SHA-256 duplicates are marked "already imported".
3. **Review** — every secret found and the `secret://` reference that will replace it; name
   collisions (rename or skip); plugins and servers that stay disabled until their permissions
   are declared and confirmed.
4. **Import** — progress, then a summary with links. Each item is tagged with the import id so
   it can be filtered ("Imported on …") and reviewed or removed together; the import is
   audited.

**In M4** (ADR-091) the steps are titled "Where to look", "Choose what to import", "Review before
importing" and "Done". Sources are folders or files on the Hub, typed as paths, plus the kinds
to look for; other devices are read through `novad` from M6. Items whose name is already in use
start unticked and are imported under the next free name; duplicates and unsupported items
cannot be ticked. Review lists the secrets that move to the vault (masked, with their
`secret://` reference), the names already in use and what stays off. Nothing is written before
the last step. Below the wizard, **Import records** lists every imported item with its kind,
target and time. Imported memories are saved as items with source "import", which Settings →
Memory lists for review.

### 2.12 Install a plugin (FR-045, FR-049)

Settings → Plugins & skills has four parts: **Installed plugins**, **Catalog**, **Install from a
folder or Git**, then **Skills** and **Hooks** (§2.10). The catalog lists the built-in sample
catalog and the user's own catalog sources (`plugins.catalogs`: a folder on the Hub, an https
URL or a Git URL), with search. **Install** on a catalog entry, or **Preview** on a folder or Git
address, opens the install screen. Nothing is installed before **Install**:

```
┌──────────────────────────────────────────────────────────────────┐
│ Install Sample plugin 1.0.0?                                     │
│ Unverified  com.example.sample                                   │
│ ! This plugin is not signed by a publisher you trust. It stays   │
│   labelled Unverified.                                           │
│   [ ] I trust its source; install it unverified                  │
│ This plugin can                                                  │
│   Reach these hosts on the network: api.example.com · …          │
│ Skills: summarize-notes, greet                                   │
│ MCP servers it adds: sample (command): node                      │
│ Hooks to trust                                                   │
│   Before tool use · matches mcp:sample.fetch_status              │
│   Runs node hooks/check.mjs (sandboxed, timeout 10 s)            │
│   Hash sha256:…                     [ ] Trust check-fetch now    │
│ [x] Turn it on after installing           [Cancel]   [Install]   │
└──────────────────────────────────────────────────────────────────┘
```

- Until publishers are verified (M8) every plugin is **Unverified**, and **Install** stays
  disabled until the sideload box is ticked. The Hub refuses an install without that
  confirmation.
- Permissions are listed in plain words. An update shows "Permission changes" (new and no longer)
  and "Replaces version x".
- Hooks are trusted here only when ticked; unticked hooks stay off until trusted under Hooks.
- Each installed plugin shows its status, Verified or Unverified, its permissions, an on/off
  switch, **Update to x** when a catalog has a newer version, and **Uninstall** with a
  confirmation.
- A plugin's MCP servers appear in Settings → Tools & MCP with "From the plugin <id>; change or
  remove it in Plugins": they have no Edit or Remove and their switches are disabled, because
  they follow the plugin's manifest.
- Skills lists each skill with its source, what shadows it, an on/off switch and its body; user
  and project skills can be created and deleted.

Unsigned MCP bundles use the same pattern: Settings → Tools & MCP → **Install a bundle** shows a
preview with the bundle's tools, a form generated from its settings (sensitive ones are password
fields stored in the vault), the hosts and files it may use, and the sideload box.

### 2.13 Panes, terminal and files (FR-005, FR-006, FR-039)

- **Layout.** The top bar's **Layout** menu splits the active pane right or down, adds an
  editor, preview, terminal, diff or browser pane, maximizes or restores the active pane, closes
  it (never the main pane) and resets the layout. A new pane offers the same kinds. Splitters
  resize with a drag or the arrow keys; panes reorder from the pane menu or by dragging one
  header onto another. A single pane shows no pane header. On phones one pane shows at a time,
  with a pane switcher. Moving panes never reloads a chat, an editor or a terminal. The layout is
  saved per mode and restored on start (§4.3).
- **Bottom panel and terminal.** Ctrl/Cmd+J or the top bar's **Toggle bottom panel** opens the
  panel, starting a terminal if none is open; Ctrl+` focuses the terminal, and pressed again
  inside it closes the panel and returns focus. Each terminal has a tab with **New terminal**
  and Close. A terminal runs in the sandbox; without one the panel says so. While a terminal has
  focus, only the panel toggle, the terminal toggle and Ctrl+Shift+P reach the app; every other
  key goes to the shell. A terminal shown in another pane offers **Show it here**.
- **Files.** The Inspector's **Files** tab browses the chat's and project's folders as a
  keyboard tree. Text files open in the editor (line numbers, its own undo and redo, Ctrl/Cmd+S
  to save); other files open in the preview (Markdown without raw HTML, images, PDFs, highlighted
  code, plain text, or a download), which also offers **Open with <app>**. Saving is the user's
  own action, so it needs no approval card unless a tier floor, a rule or the network allowlist
  asks (ADR-091). If the file changed on disk, the editor offers **Reload and discard my
  changes** or **Save mine anyway**; a save that waits for approval offers **Check again**.
  Unsaved text survives closing the pane.
- **Library** (`/library`) filters by kind (All, Artifacts, Attachments, Sources, Images,
  Files), searches titles and pages with **Show more**; each item links to where it opens.

## 3. Composer specification

- Multiline, auto-growing, Enter sends (configurable), Shift+Enter newline.
- Left cluster: attach (+ menu: files, attach window, Apps), `@`mention, slash-command, tools
  toggle, dictation (mic), voice session (waveform).
- Right cluster: model preset control (§3.1), autonomy/permission mode (Code/Work/Agents),
  send/stop.
- Drag-drop files; paste images; `@` menu is fuzzy and grouped.
- Shows token/cost estimate on hover (opt-in).
- Visible state for: dictating, voice session, tool approval pending, run in progress,
  computer use active, offline.
- **Slash commands** (FR-046): typing `/` at the start of the message opens a list of skills
  and plugin commands, matched by name prefix, then name substring, then description; choosing
  one inserts `/name `. Sending `/name request` loads that skill for the turn.
- **Suggested follow-ups** (FR-028): after a reply, up to three short prompts appear as chips in
  the empty composer. Tab or Right arrow takes the first, a click takes any; a chosen prompt
  fills the composer and is never sent on its own. A chip button, or Settings → General →
  **Suggest follow-ups** (`chat.suggestions`), turns them off.

### 3.1 Model presets (FR-221)

```
Faster  ○────────●────────○  Smarter     [Advanced…]
        Faster   Balanced  Smarter
```

- Default presets Faster, Balanced (selected) and Smarter (`docs/07` §8.1); each is a virtual
  model (provider, model, reasoning level, speed). A preset whose targets are all unavailable
  is disabled with a tooltip.
- **Advanced…** opens a panel that shows and edits each preset's provider, model, reasoning
  level, speed and fallback, and adds custom presets to the scale. The inline model picker
  (FR-023) lists presets first, then individual models; choosing a model directly shows the
  reasoning-level selector (FR-024).
- Presets never spawn sub-agents; the chosen preset and the resolved model are stored per turn.

### 3.2 Dictation and attach window

- **Dictation** (FR-216): tap the mic to toggle, hold for push-to-talk. Interim text appears
  in the composer and is cleaned up (punctuation, user dictionary from Settings → Voice). A
  local engine is the default; audio is not stored. Dictation only fills the composer; the
  waveform button starts a separate voice session (FR-031).
- **Attach window** (FR-214): the global shortcut (§5) or the + menu captures the frontmost
  window (a screenshot plus its accessibility text, including text scrolled off screen) into
  the current chat, or into a new chat from the overlay. Excluded apps and password fields are
  never captured, and redaction runs first. The attachment opens as a preview with separate
  image and text parts that can be removed before sending. Attached content is data, not an
  instruction (FR-189).
- **Not in M5** (ADR-092): dictation (FR-216) and the voice session (FR-031) wait for a local
  speech engine or a realtime audio provider, so the composer has no mic or waveform button yet.
  The composer's **Generate image** entry point waits for a provider with an images call.

## 4. Design system

### 4.1 Foundations

- **Tokens** (CSS variables, overridable by themes): color roles (`bg`, `surface`, `surface-2`,
  `border`, `text`, `text-muted`, `accent`, `accent-contrast`, `success`, `warn`, `danger`,
  `info`), radius (`sm/md/lg/xl`), spacing scale (4px base), typography scale, shadows,
  motion durations/easings, z-index scale.
- **Themes**: JSON files mapping tokens; built-in `light`, `dark`, `system`; high-contrast
  variants; import/export.
- **Typography**: UI font + code font configurable; default UI = system stack; default code =
  JetBrains Mono (bundled, OFL) fallback to system mono.
- **Icons**: original icon set (Lucide, ISC license) — never copy source-app icons.
- **Motion**: 120–240 ms, respects `prefers-reduced-motion`; no blocking animation.

### 4.2 Components (shared library, `packages/ui`)

Button, IconButton, Input, Textarea, Select, Combobox, Checkbox, Radio, Switch, Slider,
Tabs, SegmentedControl, Sidebar, ListItem, Tree, Menu, ContextMenu, Dialog, Drawer, Popover,
Tooltip, Toast, Banner, Card, Badge, Avatar, Progress, Spinner, Skeleton, Divider, Kbd,
CodeBlock, Markdown, Diff, Timeline, Table, ToolCard, ApprovalCard, PlanCard, RunCard,
StatusChip, GoalHeader, BudgetMeter, PresetScale, AppFrame, TrustPrompt, GrantPrompt,
ControlIndicator, ImportWizard, ArtifactFrame, BrowserPane, TerminalPane, EditorPane,
Splitter, PaneGroup, EmptyState, CommandPalette, SearchInput, VirtualList, Pet.

Every component: typed props, keyboard support, ARIA, dark/light, RTL-aware, and a Storybook
entry (or equivalent) with variants and a screenshot test.

### 4.3 Layout & responsiveness

- Minimum window 960×640; sidebar collapses below 1100px; Inspector collapses below 1280px.
- Panes use a persisted layout tree; layouts are saveable as "workspaces".
- Full-screen modes for focus; distraction-free composer.

**The layout tree as shipped (M4, FR-005).** `workspace.layout` holds one layout per mode
(`chat`, `work`, `code`, `agents`). It is read once when the workspace starts and written 300 ms
after a change; a value that does not parse falls back to the default for that mode.

```jsonc
{
  "chat": {
    "root": {                                   // a split or a pane
      "type": "split", "id": "s1", "direction": "row",   // row: side by side; column: stacked
      "children": [
        { "type": "pane", "id": "main", "kind": "main" },
        { "type": "pane", "id": "p2", "kind": "editor",
          "file": { "root": "/var/lib/nova/workspace", "path": "notes.txt" } }
      ],
      "sizes": [0.6, 0.4]                       // one share per child, summing to 1
    },
    "maximized": null,                          // a pane id shown alone, or null
    "active": "main",                           // the pane commands act on, and phones show
    "bottom": { "open": true, "size": 0.3 }     // the bottom panel (share 0.15 to 0.8)
  }
}
```

Pane kinds are `main` (exactly one per mode, never closed), `empty` (a new split until a kind is
chosen), `editor`, `preview`, `terminal`, `diff` and `browser`; `file` applies to editor and
preview panes. A layout holds at most 12 panes, 6 levels deep, and each share is at least 0.1.
Named workspaces and layouts per session or project come later (ADR-091). In M5 the `diff` pane
kind is still a placeholder: a Code session shows its diff in its own Diff tab (§2.4, ADR-092).

### 4.4 Accessibility

- Focus order logical; focus-visible rings; full keyboard operation of palette, menus,
  diffs, terminal, and browser panes.
- Screen-reader announcements for streaming (throttled), tool status, status changes, and
  approvals.
- Contrast ≥ 4.5:1 body, ≥ 3:1 large text; tested in high-contrast theme.
- Reduced motion, reduced transparency, and font-scaling support.

## 5. Keyboard map (defaults; all remappable)

In a browser tab, combinations the browser reserves (for example Ctrl+N and Ctrl+1..4) are shown
and matched with Alt added; the installed PWA and native shells use the keys below (ADR-088).
The web UI's routes are `/chat`, `/chat/<id>` (`?m=<messageId>` jumps to a message,
`?compare=<id>` compares two branches, `?approval=<id>` focuses an approval card),
`/chat?temporary=1`, `/approvals/<id>` (opens the chat at that approval), `/projects`,
`/projects/<id>`, `/library`, `/apps`, `/apps/<id>` (one app as a page), `/settings/<section>`,
`/onboarding` and `/open?url=<link>`; deep links map onto them (§5.1). Settings sections are
`general`, `profile` (Profile & usage), `accounts`, `models`, `memory`, `tools` (Tools & MCP),
`plugins` (Plugins & skills), `clients` (Apps & clients), `permissions`, `notifications`,
`devices`, `appearance`, `keyboard`, `import` and `diagnostics`.
`/settings/appearance?theme=<data>` opens the theme import filled in, and
`/settings/tools?oauth=ok|error` is where an MCP server's OAuth sign-in returns. Find in chat is
Ctrl+F / ⌘F (Alt+F in a browser tab). The Inspector has Artifacts, Files, Sources, Activity, Side
chat, Branches and Apps tabs; the top bar's bell opens the notification center (FR-013), and
the top bar also has **Toggle bottom panel** and the **Layout** menu (§2.13).

M4 adds these commands to the palette (the id is what `keyboard.bindings` remaps):

| Command id | Title | Default key |
| --- | --- | --- |
| `panel.toggle` | Toggle bottom panel | Ctrl+J / ⌘J |
| `terminal.toggle` | Toggle terminal | Ctrl+` / ⌃` |
| `terminal.new` | New terminal | — |
| `pane.splitRight`, `pane.splitDown` | Split pane right / down | — |
| `pane.add.editor`, `pane.add.preview`, `pane.add.terminal` | Add an editor, preview or terminal pane | — |
| `pane.diff`, `pane.browser` | Show the diff pane / the browser pane (placeholders until M5 and M6) | Ctrl+Shift+D / ⌘⇧D, Ctrl+Shift+B / ⌘⇧B |
| `pane.maximize` | Maximize or restore the active pane | — |
| `pane.close` | Close the active pane | — |
| `pane.moveEarlier`, `pane.moveLater` | Move the active pane earlier / later | — |
| `layout.reset` | Reset layout | — |
| `library.open` | Go to Library | — |
| `files.show` | Show files (the Inspector's Files tab) | — |
| `apps.open` | Open app… (pick a global app) | — |
| `import.open` | Import from another assistant | — |
| `plugins.browse` | Browse and install plugins | — |

In a browser tab Ctrl/Cmd+J, Ctrl+`, Ctrl+Shift+B and Ctrl+Shift+D are matched with Alt added,
like the other keys the browser reserves.

**M5 routes and commands** (ADR-092). New routes: `/work` (`?new=1` opens New run),
`/work/<runId>`, `/work/scheduled` (`?new=1` opens New schedule, `?fromRun=<runId>` fills it from a
finished run), `/code` (`?new=1` opens New session) and `/code/<sessionId>`. Settings gains the
`code` section (Code: the default permission mode, the reviewer model and **Allow Bypass mode**),
listed after Tools & MCP; General gains a **Work runs** group (§2.2.1, `docs/14`). New palette
commands:

| Command id | Title | Default key |
| --- | --- | --- |
| `status.nextNeedsInput` | Go to the next item that needs input (chats, then Work runs) | Ctrl+Alt+A / ⌘⌥A |
| `work.newRun` | New run | — |
| `work.newSchedule` | New schedule | — |
| `work.scheduled` | Go to Scheduled | — |

Ctrl/Cmd+Alt+A clashes on Linux and Windows native shells with the global **Attach frontmost
window** key (Ctrl+Alt+A, below). There the global key wins; both can be remapped. On macOS the
two differ (⌘⌥A and ⌃⌥A), and a browser tab has no global keys. "New run/session"
(Ctrl+Shift+N) is not bound per mode yet; use the palette or the New buttons.

### 5.1 Deep links (FR-007)

| Link (`nova://` or `web+nova://`) | Opens |
| --- | --- |
| `settings`, `settings/<section>` | `/settings/<section>` (unknown section → General) |
| `chat`, `chat/<id>`, `chat/<id>?m=<messageId>` | the chat, at the message when given |
| `projects`, `projects/<id>` (alias `project`) | the project list or one project |
| `code`, `code/<id>` | Code mode; in M5 `code/<id>` still opens the session list, not the session, and there is no `work` link yet |
| `agent/<id>`, `agents` | the agent list or one agent (M6) |
| `computer/<id>`, `computers` | the computer list or one computer (M6) |
| `device/<id>`, `devices` | the device list or one device (M6) |
| `add-device?p=<pairing id>&fp=<hub fingerprint>&r=<relay url>&rp=<relay pairing id>#c=<code>` | `/add-device` (the joining device's page, M6.5, FR-132) with only the fields that validate; the code stays in the fragment. The Hub's QR link opens the same page directly |
| `theme?data=<base64>` | `/settings/appearance?theme=<data>`: the theme import, filled in; nothing is kept until the user saves it (FR-011). The data is at most 44,000 characters |

Ids must be 1–100 characters of letters, digits, `_` and `-` after decoding; anything else,
other schemes and longer paths are refused and the app opens `/chat`. The installed PWA
registers `web+nova` as a protocol handler that opens `/open?url=%s`; native shells register
`nova://` (M7).

| Action | Linux/Win | macOS |
| --- | --- | --- |
| Command palette | Ctrl+K / Ctrl+Shift+P | ⌘K / ⌘⇧P |
| Settings | Ctrl+, | ⌘, |
| Modes | Ctrl+1..4 | ⌘1..4 |
| New chat | Ctrl+N | ⌘N |
| New run/session | Ctrl+Shift+N | ⌘⇧N |
| Toggle sidebar | Ctrl+B | ⌘B |
| Toggle terminal | Ctrl+` | ⌃` |
| Toggle bottom panel | Ctrl+J | ⌘J |
| Browser pane | Ctrl+Shift+B | ⌘⇧B |
| Diff pane | Ctrl+Shift+D | ⌘⇧D |
| Find in chat | Ctrl+F | ⌘F |
| Navigate back/forward | Ctrl+[ / Ctrl+] | ⌘[ / ⌘] |
| Next/prev tab | Ctrl+Tab / Ctrl+Shift+Tab | ⌃Tab / ⌃⇧Tab |
| Clear terminal | Ctrl+L | ⌃L |
| Stop generation | Esc | Esc |
| Dictation (tap to toggle, hold to talk) | Ctrl+Shift+Space | ⌘⇧Space |

Global shortcuts work while Nova is in the background. They are registered by the native shell
or `novad`, so a plain browser tab cannot offer them:

| Action | Linux/Win | macOS |
| --- | --- | --- |
| Open quick overlay / focus Nova (FR-008) | Ctrl+Alt+N | ⌃⌥N |
| Attach frontmost window (FR-214) | Ctrl+Alt+A | ⌃⌥A |
| Stop computer use, the kill key (FR-207) | Esc | Esc |
| Pause ambient capture (FR-154, `docs/24` §9.4) | Ctrl+Alt+Shift+P | ⌃⌥⌘P |

- The kill key is active only while Nova controls the screen, and is handled by `novad` before
  any other app sees it. It can be remapped but never left unbound.
- The ambient pause key is registered by `novad` on each capturing device, so it works without
  the shell; the pause takes effect within 1 s.
- In a browser tab, keys the browser reserves (for example Ctrl+N, Ctrl+Tab, Ctrl+W) cannot be
  captured. The web UI shows an alternate binding (the Alt variant) in the palette and in
  Settings → Keyboard; the installed PWA and native shell use the defaults above.
- Conflicts with OS or other global shortcuts are detected at registration and reported in
  Settings → Keyboard (`docs/14` §3).

## 6. States & feedback

Every surface must handle: **empty**, **loading** (skeleton), **streaming/partial**,
**error** (actionable, with retry/diagnostics), **offline/queued**, **permission-denied**,
**rate-limited/over-budget** (paused at a bound, with Extend), **needs input**, **output
missing** (FR-187), **needs re-trust** (hooks), and **degraded** (provider down). Errors never
lose user input.

## 7. Content & voice

- Clear, specific, non-anthropomorphic copy. Agents are "agents", not people.
- Always show *what* an agent will do and *why* before a consequential action.
- Never fake progress; show real tool activity and real budget consumption.
- Accessibility: avoid color-only status; pair with icon + text.
- **Naming:** UI text uses the plain terms in `docs/28`. A themed name, if one is ever
  introduced, is a display-layer alias only and never a code identifier.

## 8. Onboarding content requirements

- Provider setup help per provider (where to get a key, OAuth flow).
- A 3-step "your first run" tutorial that actually executes a harmless task (e.g., summarize
  a bundled sample doc) and ends with a visible artifact.
- A safety primer: what approval cards and their six decisions look like, what budgets do, how
  to stop an agent (Stop, and the kill key for computer use), and where the audit log is.

## 9. Hub-served UI & new surfaces

The UI is a web app served by the Hub; clients are browsers/PWA and native shells. New
top-level surfaces in the sidebar:

| Surface | Purpose |
| --- | --- |
| **Devices** | Devices/compute nodes; capabilities, health, reachability; add/wake/revoke. M2 ships compute nodes under Settings → Devices: an "Add compute node" command line with a one-use token, status, models, load and revoke |
| **Network** | Transports (LAN/Mesh/Relay), trust/certs, paired Relay clients, egress, wake helpers, diagnostics |
| **Ambient** | Capture timeline, activity summary, search, filters, privacy controls |
| **Automations** | Trigger→condition→action editor, dry-run, logs, versions |
| **Smart Home** | Entities by area, scenes, natural-language control |
| **Learning** | "What Nova learned": memory, skills, tuning, code changes, rollback |

**In M6** (ADR-093) **Devices** is `/devices` (and `/devices/add`, `/devices/<id>?tab=`): every
`novad` device with its role, status chip, version, last heartbeat and capabilities; **Add a
device** shows the one-use command line (no QR code yet) and waits for the device to register; a
device page has Capabilities, Modules and services, Power and Wake-on-LAN, Updates, Policy,
Files (granted folders, access requests, staged writes with their diff, Commit and Discard),
Agents (connections) and MCP. Settings → Devices keeps compute nodes and links to it.

**In M6.5** (ADR-094) **Devices** lists every device record, whatever it runs (FR-140): `novad`
devices, compute nodes, browsers and apps added with a code, with their kind, status, scopes,
version and last contact; pending requests appear first under "Waiting for approval". **Add a
device** (`/devices/add`) picks the role (Client, Compute node, Wake helper), scopes (none on by
default; Client: Offline copy, Local models, Files, Browser, Computer use; Compute node: Commands),
an optional name and, when `relay.enabled` is on, whether to pair through the Relay. It then shows
the QR code (drawn in the browser as an SVG, black on white in both themes for scanners), the code
with Copy, a live countdown with New code, the join link, the install commands for headless
devices (or why there are none), and Start over. The request card (`/devices/add?request=<id>`,
where the Hub's notification links) asks the owner to type the six digits the device shows (never
prefilled), then Approve or Deny; a mismatch shows the Hub's refusal, and the success screen shows
role, scopes, what it runs and the platform. `?role=` preselects a role and `?method=command`
keeps the M6 one-use command ("Use a one-use command instead"). A device page adds Scopes with
Edit, Wake ("through <helper>" or "by the Hub", or why no helper can) and Revoke, which says what
revoking does and signs this browser out when it is the device being revoked. Settings → Devices
gains "Adding devices" (`devices.add.enabled`, `devices.add.sessionDays`) and "Add with a code"
for compute nodes.

The joining device's page is `/add-device`, served without a session (`docs/22` §4.4): it takes
the code from the link (or asks for it), checks the Hub, shows the six digits with "On the Hub,
type this code to approve…", waits for approval, then offers **Open Nova** and how to install the
app on this platform; a denial or expiry says so and offers to start again.

**Network** is a top-level sidebar entry (`/network`, `/network/:section`; a setup run is
`/network/setup?run=<id>`). Its sections are tabs on desktop; on phones `/network` lists them and
each is a full page with a link back. **Overview** (FR-135, FR-139): the primary transport, what
clients are told (only endpoints that pass their test are advertised), Test now, problems with
guided fixes (`docs/22` §10), each transport with its endpoints, latency and 24-hour checks and why
one was withdrawn, the change list with "Roll back the last change" (it asks first), the transport
event log in sentences ("LAN failed its check; Mesh is now primary."), per-device reachability,
certificate, mesh, Relay and egress status, and the network settings form (saved through
`PATCH /api/v1/network`, so each save can be rolled back). **Setup** (FR-136): the host-changes
switch (`network.setup.allowSystemChanges`, which asks before turning on and shows as locked under
managed policy), detection, the four mesh choices with help (including the iOS note), options with
write-only keys, the plan, per-step consent showing the exact text, automatic rollback and
`rollback_failed` shown plainly, check, roll back the last step or the whole run, run history and
remembered consents with Revoke; no Apply or Roll back button appears while host changes are off.
**Trust** (FR-134): the three modes, the restart notice, the Hub and CA fingerprints, `ca.crt` and
`ca.pem` downloads with install hints for five platforms, certificate expiry and names, renewal,
problems and issued certificates, a missing identity key and the loopback-only start. **Relay**
(FR-137): on or off (it asks before connecting out), own or hosted Relay, address, state, latency,
Test, and paired clients with Revoke. **Wake helpers** (FR-138): which devices may wake others,
which to use and in what order, and the recent wakes with how each was sent. Updates arrive live
through the event stream.

New flows:

1. **Add a Device** — choose role + scopes, show QR/short code, approve on the Hub, success screen.
2. **Network setup** — detect state, configure a transport, test reachability, rollback.
3. **Ambient timeline** — day view with transcript lanes (and thumbnails when pixels are
   enabled); records not yet certified by redaction show as "Pending redaction" with no content
   (FR-227); search shows the time covered and any gaps (FR-155); pause; forget.
4. **Automation editor** — pick triggers/conditions/actions; test; enable; view logs.
5. **Smart-home control** — areas/scenes, device state, command history.
6. **Learning review** — approve/decline skills and optimizations; rollback; kill switch.

The same UI is responsive: phone/tablet use a bottom nav and single column; desktop uses the
sidebar + inspector layout.
