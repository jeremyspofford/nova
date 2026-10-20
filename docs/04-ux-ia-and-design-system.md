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
11. **Marketplace** — plugins, skills, themes, pets and MCP servers (in M4 the plugin catalog
    lived in Settings → Plugins & skills, §2.12; M8 makes it a page of its own, §2.14)
12. **Settings**

Every thread, run, session and agent row carries a status chip (§1.1).

**In M6** (ADR-093) the sidebar adds the agents under Agents, and **Spaces**, **Sites**,
**Computers** and **Devices** after Library and Apps; Settings adds **Agents**, **Computer use**,
**Channels**, **Triggers**, **Network** and **Browser**. Network is a Settings section in M6
(egress, credentials, the decision log); the top-level Network surface of §9 is M6.5.

**In M7** (ADR-095) the sidebar adds **Approvals** (`/approvals`, a shield icon) and **Team**
(`/team`) after Network, and the account menu gains the connection item (first, §9) and
**Approvals**. Team holds **Shared chats** (`/team/shared`) and **Team agents** (`/team/agents`):
tabs on desktop; on phones `/team` lists them and each is a full page with a way back. The people
and their invitations stay in Settings → Members. Settings adds **Account** and **Members** (after
General), **Cloud runner** (after Code), **Sync** (after Network) and **Experimental** (before
Diagnostics).

**In M7.5** (ADR-096) the sidebar and the list of Settings sections do not change. Out-of-band
management is a page under Devices (`/devices/oob`), a device page gains the **Firmware**, **Boot**
and **Out-of-band** tabs, Settings → Devices gains **Firmware and boot**, and Settings → Browser
gains **Continue on your computer** and **Your own browser (extension bridge)** (§9).

**In M8** (ADR-097) the sidebar adds **Marketplace** (`/marketplace`, a download icon) after
Apps, and the shell gains a status bar for extension items at the bottom of the main workspace
(§2.14). Settings adds **Extensions** (after Plugins & skills), **Authorized apps** (after Apps &
clients), **Managed policy** (after Permissions), **Data**
(after Import) and **Telemetry export** (before Diagnostics). The consent page an app sends the
owner to is `/authorize` (§2.15); it is a page of its own, and onboarding never redirects away from
it. While a managed policy is in force, every Settings section opens with a banner naming its
sources, and each control it locks says "Managed by your organization" with the source (§2.16).

**Members** (FR-217). Someone the owner invited signs in to an account of their own. For a member
the sidebar hides Code, Library, Devices, Network and (M8) Marketplace, and Settings lists eleven
sections: Account, Members, Profile & usage, Accounts, Memory, Tools & MCP, Notifications,
Channels, Appearance, Keyboard and Managed policy (Appearance, Keyboard and onboarding are the
member's own settings). A hidden surface or section reached by its address shows "Only the owner
of this Hub can change this." with what it is, never a dead control. *As of M8* Tools & MCP,
Notifications and Channels have a member mode: the web app asks `GET /api/v1/team/me/access` which
routes the member is refused (failing closed when it cannot tell) and hides those parts or says
"The owner of this Hub sets…" in their place. A member adds only remote MCP servers ("Running a
command on the Hub is for its owner only."), sees no Hub-wide notification or channel settings,
reads the managed policy without "Check for changes", and keeps their own spend caps (Profile &
usage). Extensions, Authorized apps, Data and Telemetry export stay owner-only, extension
contributions are not shown to members, and the composer's "Find apps in the Marketplace" is
hidden. In a shared chat (M8) each person's message shows their display name ("Someone"
when they have none) and your own say "You"; private chats show no names.

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

**In M7** (ADR-095; `apps/desktop`) the desktop app draws its tray icon in code, with a badge while
something needs input; the tooltip says how many items need input or are blocked. Clicking the
icon opens the overlay. The tray menu has **Quick chat**, **New task**, **Attach window**, up to
six status rows ("Needs input: <title> (<reason or kind>)"; a row opens its place), any global key
another app holds, **Open Nova** and **Quit Nova**. The overlay (Ctrl+Alt+N / ⌃⌥N; pressed again
while the overlay is in front, it brings Nova forward) has the message box ("Ask Nova…"; Enter
sends, Esc closes), **Send to** "A new chat" (the default) or "The chat open in Nova" (the chat in
the last used window; disabled when there is none), the status list (up to 8 rows, from the
statuses the Hub derived; the shell derives none), and **New task** (opens New run,
`/work?new=1`), **Attach window** (§3.2) and **Open Nova**. There is no mic: voice in quick chat
waits for FR-216 and FR-031. Closing every window keeps the app in the tray.

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

**In M7** (ADR-095; `apps/web/src/code/SessionM7.tsx`):

- The session header adds **Hand off…** and **Best of N…**; new tabs **Attempts**, **Merges** and
  **Moves**, plus **Agents** and **Scripts** while their Experimental switches are on. Each M7 tab
  loads when first opened.
- **Hand off…** (FR-213) moves the session with its Git state to "Another environment" (this Hub,
  an SSH host, a device or the cloud, and a folder there) or, for a repository on the Hub, to "A new
  worktree", "The main checkout" or "An existing worktree". "After the move, the changes here":
  **Keep them here too** or **Clean them up here** (only after the target confirmed it has them).
  While a turn runs, **Interrupt the running turn** is offered; otherwise the move waits for it.
  The dialog follows the move to its end and says why a refusal happened; **Moves** keeps the
  history. Moving a chat to another device has no UI yet.
- **Best of N…** (FR-212) runs the task as 2 to 4 attempts, each with its own budget (time, tokens,
  cost) and optional model. The comparison shows each attempt's files, patch, tests, cost and last
  reply. **Apply** (asks first) merges one into the session; a conflict writes nothing and offers
  conflict markers instead. **Discard all** asks first. Best of N needs the folder on the Hub.
- **Merge in…** (FR-073) takes "Another session" (both folders on the Hub) or "A patch" (with an
  optional "Made against commit"), and either "Write nothing and show the conflicts" (each
  conflicting file's base, this session and the incoming side) or "Write conflict markers to
  resolve". With markers: **Mark resolved** (refused while markers remain), **Ask the agent to
  resolve** and **Abort merge** (asks first).
- **Remote sessions** (SSH, WSL, a device, the cloud) now have the diff, review, commits and
  branches. Go to symbol, push, pull requests, dev servers, Best of N and merging another session
  still need the folder on the Hub, and the session's note says so.
- A session on a cloud environment shows its cloud run (usage against the caps) under the budget,
  and its File tab shows the runner's files.
- **Environments** adds **New cloud environment**, **Manage** on cloud rows (Settings → Cloud
  runner, §9) and, on SSH rows, the pinned host key with its SHA256 fingerprint, a mismatch
  explained, and **Replace key** or **Forget key** (both ask first). Settings → Code adds
  **Connect to SSH environments** (asks before turning on), **Handing off sessions** (the default
  for the changes left behind) and the **Best of N** defaults.
- **Agents** and **Scripts** (Settings → Experimental, §9): the Agents tab delegates to an external
  agent, shows its live activity and Stop (asks first); the Scripts tab lists each scripted call's
  nested tool calls with their status and the policy decision.

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
  model. Connecting plugins per agent came in M7: a **Plugins** tab on the agent page offers
  "Every plugin you turned on" (the default) or "Only the plugins chosen here", which limits the
  agent's threads to those plugins' tools (FR-045).
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

**Hub-only cards, as built in M7.5** (ADR-096; `apps/web/src/chat/ApprovalCard.tsx`,
`apps/web/src/firmware/HubOnlyApproval.tsx`, `apps/web/src/oob/HubApproval.tsx`). Firmware and
boot changes (FR-146, FR-143), out-of-band actions (FR-147) and decommissioning a device open a card
with `answerIn: 'hub'`: tier "Asked every time; cannot be pre-approved", risk high, and only
**Allow once** and **Deny**. Only the signed-in owner answers it, in a Nova client.
- The card carries a shield icon and the line "Only you can answer this, in Nova: here or on the
  Approvals page. Chat channels, email links and agents cannot answer it." A channel that relays
  such a card says "This one can only be answered in Nova itself: open the web or desktop app to
  decide." and refuses an answer from there (`hub_only`).
- A card about a device (scope `device:<id>`: firmware, boot, decommission) gains a **Where** row,
  "On <device>", linking to the device page. On these cards and on every Hub-only card, the deny
  button reads **Deny**: no run waits on them, so there is no reason field for an agent.
- Each card is answered where its change is asked for, and waits on the Approvals page too
  (§9). Firmware and boot show a compact card: the title names the change and the device ("Approve
  this firmware change on Desk PC"), the diff sits next to it, focus moves to its heading when the
  owner has just asked for it, and it shows when it expires and **Open in Approvals**; once
  answered it reads "Approval: Allowed once" (or Denied, or "Expired: nobody answered in time")
  with "Answered here." or "Answered in Nova.". Out-of-band and decommission cards show the full
  card above, with "It also waits on the Approvals page." and **Open in Approvals**. The first
  answer wins on any client.
- The cards expire after 24 h (firmware), 30 min (boot), 10 min (out-of-band) and 1 h
  (decommission). Clearing a pending one-shot boot needs no card: the owner's confirmation in the
  Boot tab is the approval.
- On the Approvals page, the line above a Hub-only card still says "Not part of a conversation",
  without a link; the device card's own Where row is the way to the device. An out-of-band card
  links to neither its BMC nor its device.

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
`novad` come with its screen module (not built in M6; ADR-096 moves it to M9 with the capture
work). M7.5 adds the local browser fallback and the extension bridge to these views (§9).

### 2.9 MCP Apps (FR-198)

Plugin, extension and MCP-server UI renders in an **App frame**: a sandboxed iframe with a header
showing the app name, its server or plugin, a Verified/Unverified badge, the allowed domains (from
the resource's CSP metadata), mode buttons and Close. In M4 the header did not list the allowed
domains (ADR-091); *as of M8* it says "Can reach a, b" or "Reaches no outside sites" whenever the
entry point carries its domains (`UiEntryPointView.domains`), which every extension panel does.

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
  Inspector. *As of M8* the main chat's composer has a + menu, **Apps and more**, listing
  "Open <app>" for each of the chat's apps, the extensions' composer items and "Find apps in the
  Marketplace" (hidden for members); "Show the chat's apps" in the command palette opens the
  Inspector's Apps tab. Embedded chats have no + menu.
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

- A plugin installed from a folder or Git here is always **Unverified**, and **Install** stays
  disabled until the sideload box is ticked; the Hub refuses an install without that
  confirmation. *As of M8* a plugin or extension signed by a trusted publisher installs
  **Verified** from the Marketplace (§2.14) or from Settings → Extensions.
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

### 2.14 Marketplace and extensions (FR-049, FR-117)

*As shipped in M8 (ADR-097; `apps/web/src/market`, `apps/web/src/extensions`).* Both are the
owner's; a member reaching them sees the owner-only notice.

- **Marketplace** (`/marketplace/<tab>`): tabs **Plugins** (the default), **Skills**, **Themes**,
  **Pets**, **MCP servers**, **Installed** and **Catalogs**. The five kind tabs have a search
  ("Search by name or description") and cards with the author, version, Verified or Unverified,
  "It can" (the declared permissions in plain words), a screenshot, the installed version,
  **Install**, **Update to <v>**, **Remove…** and **Details**, and your rating. **Details** shows
  screenshots, changelog, what it brings (hooks, sub-agent roles, browser extensions, app
  screens), homepage, catalog and versions, and "Your rating" ("Ratings stay on this Hub. Nothing
  is sent anywhere."). A kind the install rules turn off says "Installing <kinds> is turned off."
- **Install and update** (one dialog): a blocked item says "This cannot be installed." and why
  (managed policy, unverified items off, kind off). An Unverified item lists why, one plain
  sentence per reason, and needs "I trust its source; install it unverified". A Verified item says what
  vouches for it ("Verified: listed in <catalog>, signed with the key this catalog pins", and for a
  bundle "Its bundle is signed by <publisher>, a publisher you trust"). An update lists
  "Permission changes" (New, No longer, Changed) and needs "I accept these permission changes"
  when anything was added or changed. Hooks to trust are ticked one by one; an MCP bundle shows
  its settings form; "Turn it on after installing". The button stays off until the required
  boxes are ticked. **Remove…** asks first (for the pet in use: "If it is your companion, the
  companion turns off.").
- **Catalogs tab**: each catalog with its kind (Built in, Folder on the Hub, Git repository, Web
  address) and its signature; **Add a catalog** (name, location, optional publisher key, "Commit
  (Git only, optional)"; at most 20); removing a catalog takes effect at once. **Trusted
  publishers**: adding one asks "Trust <name>?" (**Trust this publisher**), removing one asks
  "Stop trusting <name>?". **Install rules**: "Allow unverified items" and "What may be
  installed". This tab is the Catalog settings of `docs/14` §7.
- **Settings → Extensions**: the "Run extensions" switch (`sdk.enabled`); each installed extension
  with its status (Running, Starting, Stopped, Off, Error; a stopped one says why: "Managed by your
  organization (<source>)", an unreadable policy, or the SDK switch off), publisher, Verified or
  Unverified and
  its signature in words ("Signed by a publisher you trust", "Not signed by a publisher you
  trust", "Loaded by nova dev from a folder"), "It can" with sensitive lines marked, a "Run
  <name>" switch, its hooks (Trusted, Needs trust, Trust revoked, Disabled) with **Trust…** (the
  dialog shows the new hash if the hook changed while it was open), its secrets (Stored or Not
  set; Set, Replace, Clear after asking; values are never shown), its app screens with **Open**,
  and **Uninstall…** with "Also remove its data (the files it keeps on the Hub)". **Install from
  a file** takes a `.novax` (32 MB) or a path on the Hub and opens the same kind of preview. "For developers" explains `nova dev`,
  `nova validate` and `nova pack` (`docs/26` §9).
- **What extensions add to the shell**: their commands in the command palette under the
  extension's name (bindable in Keyboard), "Open the marketplace" and "Manage extensions"; a
  status bar ("Extension status") whose items with a command are buttons; menu items on a chat's
  row menu, under "More actions from extensions" on a message, in the file preview's "More
  actions for <file>" menu and in the composer's + menu, each described "From <extension>"; their
  themes in Appearance → Themes under "From your extensions" (**Save to your themes**, **Save and
  use**) and their shortcuts in Keyboard under "Suggested by extensions" (**Use this shortcut**).
  Nothing an extension offers is applied until the user picks it.
- **Pets**: installed pets are choices in Appearance → Companion ("Installed from the
  marketplace"); a saved pet that is no longer installed shows as such and the companion is off.
- **Who signed it** (cards, details, install dialogs, catalogs, Settings → Extensions): a publisher
  is named only for a key the owner trusts; a pinned key without a name reads "Signed with a key you
  trust (<fingerprint>)", any other key "Signed with the key <fingerprint>, not trusted", with a
  warning that the name a catalog gives it is not checked. An item with no author shows no "By …".
- **Updates** word each changed permission part by part (a tool's approval, an MCP server's program
  and arguments, hosts, folders, tools), never raw JSON; anything that lets the item do more without
  asking (ask → allow, a new program, more sites, files or tools), or that cannot be worded, is bold
  and marked **Sensitive**.
- **A change of publisher** (an update signed by another key, or unsigned over signed) comes first
  in the extension preview, the marketplace update dialog and the plugin install dialog (from the
  plugin preview's `publisherChange`, before the first Install; an older Hub's refusal still leads
  there): "I accept the new publisher; delete
  its stored secrets and data" must be ticked before Install; the request then carries
  `acceptPublisherChange`.
- **Sidebar**: when extensions place menu items there, a **From extensions** menu sits at the foot
  of the sidebar above Settings and opens upward.

### 2.15 Allow an app (FR-222)

*As shipped in M8 (ADR-097 D6; `apps/web/src/appauth`).* An app that signs in with OAuth sends the
owner's browser to `/authorize?…`:

```
┌──────────────────────────────────────────────────────────────────┐
│ Allow Notes Sync to use your Hub?                                │
│ Apps can only read. The app chose this name itself; Nova cannot  │
│ check it.                                                        │
│ After you answer, your browser goes back to 127.0.0.1:53682      │
│ It asks to                                                       │
│   [x] Read your chats        [x] See your projects               │
│   (untick anything you do not want it to have)                   │
│                                              [Deny]   [Allow]    │
└──────────────────────────────────────────────────────────────────┘
```

- A request the Hub cannot trust (unknown app, a return address it did not register or none) says
  "This sign-in request cannot be answered" and never sends the browser anywhere. Other refusals
  (app access off, managed policy, a malformed request) are explained with "Go back to the app".
  At least one scope stays ticked. The seven scopes read: "See your name and picture", "See your
  projects", "Read your chats", "See your Work runs", "Read what Nova remembers", "See your
  notifications" and "See your usage". Members see "Only the owner of this Hub can allow apps to
  use it."
- **Settings → Authorized apps**: "Let apps ask for access" (`apps.enabled`), "How an app signs in"
  (the `/.well-known/oauth-authorization-server` address), "Apps you allowed" with what each may
  read, where it sends sign-ins back to, how many devices are signed in and when it was last used,
  **Revoke** after asking, and **Registered, not allowed**: every registered app nobody authorizes
  (a revoked one moves here), by name, with what it asks to read, where sign-ins return and when an
  unapproved one lapses (or that it stays until removed), and **Remove** after asking.
- **Settings → Telemetry export**: "Export telemetry" (off, and disabled until a collector is
  saved), "Collector address" (https, or http only to this computer), write-only **Headers**,
  "What to send" (Traces, Metrics, Logs), "Include content" (asks first, naming the collector),
  **Send a test** and the status (exporting now, or why not).

### 2.16 Managed policy, data and usage (FR-106, FR-105, FR-116, FR-121)

*As shipped in M8 (ADR-097 D4-D5; `apps/web/src/managed`, `apps/web/src/datactl`).*

- **Managed policy** (Settings → Managed policy): "How a setting is decided", each source with its
  status (Not present, In force, Ignored, Cannot be read, Refused, Unreachable) and why, the
  restrictions in plain sentences, "Settings it sets" (setting, value, source) and "Not applied"
  (ignored keys with the reason). **Check for changes** is the owner's. The page follows
  `managed.policy.changed`. A locked switch reads "Managed by your organization (policy file)"
  (or "(remote policy)", "(policy file and remote policy)", "(test policy file)"); the
  Marketplace and Extensions pages name the file or address. When the policy fails closed the
  banner says "Your organization's policy could not be read" and that every agent tool is denied
  until it is fixed.
- **Data** (Settings → Data, owner only), in order: what the Hub holds; **Export** with an
  optional passphrase (at least 12 characters, typed twice), downloaded through a one-use ticket;
  **Import** (only into an empty Hub: upload, **Check the file**, what it holds, what to enter
  again, then "Replace this Hub with the export?" → **Import and restart**, and afterwards what
  was turned off); **How long data is kept** (Chats, Work runs, Audit log, Artifacts, Activity
  history: Forever, 7 days, 30 days, 90 days, 6 months, 1 year, 2 years or 5 years; the audit log
  never less than 1 year; keeping less asks first; **Sweep now…** says what it will delete);
  **Crash reports** (sending asks first; **Preview** shows "exactly what is sent, byte for byte"
  and **Send this report** sends that; delete one or all after asking); **Delete all data…**
  ("Type the Hub's name, <name>, to confirm", compared trimmed and ignoring case, then **Delete
  everything and restart**). A sealed export also asks for the Hub's name. Every refusal reads in
  plain words. After an import or delete-all the page waits for the Hub to come back and reloads;
  onboarding's first screen offers **Restore from an export file** (`/settings/data#import`), so a
  fresh or wiped Hub can be restored without finishing setup first.
- **Spend caps** (Profile & usage, `#spend-caps`; members set their own): per provider an amount
  in US dollars, "Each month (UTC)" or "Each day (UTC)", "Warn at" (5 to 99 %, default 80) and
  "Stop at the cap" (default on); the state (Under the cap, Near the cap, Cap reached: calls
  stopped, Cap reached: warning only); **Clear usage data…** asks first. `?cap=<provider>` opens
  that provider's cap. **Accounts** shows each provider's plan, the last limit it reported, this
  month's spend and its cap with a link to set or change it ("Local: no cost and no cap." for a
  local server). A reply a cap stopped shows **Raise the cap**.
- **Channels** (M8 additions): an email mailbox chooses "With a password" or "With OAuth"; OAuth
  shows the redirect URI to register with the provider, **Authorize** (or **Authorize again**),
  the state (Not authorized yet, Authorized, Authorization expired, Sign-in failed) and **Sign
  out** after asking. The message log lists each entry's files with name, size, state ("Kept with
  the chat", Sent, Held back, Not delivered, or "Not kept" for a refused inbound file) and the
  reason in words (not repeated when the entry says it); the old **File** badge remains only for
  entries logged before files were recorded.
- **Members** (owner): "Keep a removed member's data for" N days (0 keeps it until you delete it),
  then per removed member **Export their data** and **Delete now** ("I understand <name>'s data
  cannot be recovered" → **Delete for good**); the removal dialog says how long data is kept.

### 2.17 Spaces and sites (FR-036, FR-037, M8)

*As shipped in M8 (ADR-097; `apps/web/src/spaces`; routes in `contracts/hub-api.md`, "Spaces,
sites & visualizations").*

- **Page order.** Drag a page in the space's list, or use Up and Down and the row menu's **Move
  to…**, **Move to the top** and **Move to the bottom**. Each move sends the whole order in one
  write; if the list went stale, the page says so in plain words and shows the Hub's order.
- **Deleting a page** asks first and says what goes with it: its versions, comment threads and
  replies, open agent proposals (they end rejected) and the sites whose next build leaves it out.
  The toast offers **Undo**, and the space's **Recently deleted pages** list has **Restore**, which
  puts the page back where it was with its history and comments. The page editor uses the same
  dialog.
- **Change source…** on a site builds from the new source without storing anything and lists the
  files added, changed, removed and unchanged against the latest version; **Save** stays off until
  that preview has run.
- **Publishing** asks the Hub for a plan first: where the files go (a folder on the Hub, a zip, or a
  folder on a remote hosting target), which files, what is live and is replaced or taken down,
  whether it can be undone (a zip cannot) and whether the network policy lets Nova reach the target.
  A copy that could not be taken down is named afterwards ("left behind") so it can be removed by
  hand.
- **Publishing targets** (`/sites/targets`, linked from Sites and from the publish dialog; owner only):
  add a WebDAV target with its address, optional public address and a write-only credential (none,
  a user name and password, or a token), **Check** it, rename, change or remove it (not while a site
  is live there), and the **Allow publishing to hosting targets** switch (`sites.remoteTargets`,
  with the managed lock). Members see the owner-only notice there and "Only the owner of this Hub can publish sites"
  instead of Publish buttons.

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
- **In M7** (ADR-095) the composer's left cluster has **Generate an image** (FR-030), shown only
  while the Hub lists `image.generate` (a configured provider can make images; only local ones
  while cloud routing is off) and the chat exists; the answer is cached for 60 s. The dialog takes
  a description (up to 4,000 characters) and a shape (Square 1024 × 1024, Landscape 1536 × 1024,
  Portrait 1024 × 1536). The request passes the policy gate as the user's own action, so an
  approval card appears in the chat when policy asks; the image is saved as an artifact of the
  chat.
- **Attach window as built (M7, ADR-095; `apps/desktop`).** Capture starts only from the desktop
  app: Ctrl+Alt+A / ⌃⌥A, the tray or the overlay; the composer's + menu has no Attach window. The
  shortcut does nothing while a Nova window is in front (a notification says to bring the other
  window forward). The preview window ("Attach window": "Nothing has been sent yet") shows
  **Image** and **Text** as separate parts, each with an "Attach the …" box, a "Message
  (optional)", **Send to** "A new chat" (the default) or "The chat open in Nova", **Discard** and
  **Send**; a draft expires after 15 minutes. Text comes only on Linux (AT-SPI, including text
  scrolled off screen, at most 600 objects, 200,000 characters and 6 s; password fields are never
  read); macOS and Windows say text is not offered yet. The text is redacted before the preview;
  the image is not, and the preview says to check it. Both go to the chat as message attachments.
  Excluded apps come only from `attach.excludedApps` in the app's `shell.json` (empty by default,
  no UI) and are matched by app name, which only the Linux AT-SPI path knows; elsewhere the
  exclusion does not apply. On Wayland the image may be missing.

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

*As audited in M8 (FR-015, ADR-097; `e2e/a11y-sweep.spec.ts`, `e2e/support/a11y-probes.ts`).*

- **The sweep.** axe runs with every WCAG 2.0, 2.1 and 2.2 A and AA rule and fails on any impact,
  with no exclusions, over setup, every onboarding step, every top-level surface (each Marketplace
  tab, Network section and Team tab), every Settings section, the command palette, the account menu,
  the notification center, the delete-chat confirmation, the extension install preview, delete-all,
  the theme import check, the app consent page and Add a provider, in a member's view, at 390×844,
  in forced dark and in both high-contrast themes. It also checks what axe cannot: a keyboard walk
  (skip link, region order, Shift+Tab reverses Tab, no trap) and Escape returning focus to the opener;
  a focus ring of at least 2 px and 3:1 that is never hidden (with the companion on); target size;
  drag alternatives; reduced motion; reflow at 320 px; text spacing; paste and autofill on the
  sign-in and pairing fields; live regions for toasts and streaming; placeholder and field-edge
  contrast; and, with every setting locked by the test policy file, that every lock note names
  "(test policy file)" and is linked to its control. Each check was shown to catch a deliberately
  injected fault.
- **Behaviour that changed with it:**
  - **Toasts**: a toast with an action (such as **Undo**) never times out, and every toast holds
    while hovered or focused (2.2.1).
  - **Tooltips** can be hovered (the pointer may move onto them) and Escape dismisses them wherever
    focus is (1.4.13).
  - **Backdrops** of dialogs and the command palette close only on a press that starts and ends on
    the backdrop (2.5.2); focus returns to the opener even when it was disabled while it worked.
  - **Drag alternatives** (2.5.7): each pane menu has **Make larger** and **Make smaller**, the
    bottom panel's menu **Make taller** and **Make shorter**, and the picture-in-picture **Move**
    button moves the app to the next corner on click.
  - **Lock notes**: every managed lock note names its source ("Managed by your organization (policy
    file)") and is linked to its control (`aria-describedby`): `ManagedLockNotes` (a provider around
    the web app, through `@nova/ui`'s `LockNoteProvider`) gives every locked select, radio group and
    color field its note, switches and text fields take the same note, and a `setting` prop names
    the exact source.
  - **Contrast**: field edges use the derived token `--u-control-border` (3:1 in every theme, 1.4.11)
    and placeholders the muted text color.
  - **Page titles**: each page names the browser tab "<page> - Nova" (2.4.2).
  - Reflow at 320 px (the top bar wraps; grids and fields no longer widen the page; a data table
    wider than the screen scrolls inside its own region, `TableScroll` in packages/ui, which is a
    named keyboard stop only while it overflows, as WCAG 1.4.10 allows for two-dimensional
    tables), a 2 px focus ring on the composer, roles on elements that carried a name screen
    readers ignored (the live screen view is an `application` while you control it), and
    `one-time-code` autocomplete on the setup code.

#### WCAG 2.2 A and AA conformance (M8)

| Level | Criteria |
| --- | --- |
| **Supports** | 1.1.1, 1.3.1, 1.3.2, 1.3.3, 1.3.4, 1.3.5, 1.4.1, 1.4.3 (built-in themes; custom colors are checked and warned about), 1.4.4, 1.4.5, 1.4.11, 1.4.12, 1.4.13, 2.1.1, 2.1.2 (in an empty composer Tab takes the first suggested follow-up once, as documented and announced; a second Tab or Shift+Tab leaves), 2.1.4, 2.2.1 (the pairing code's expiry falls under the security exception), 2.2.2, 2.3.1, 2.4.1, 2.4.2, 2.4.3, 2.4.4, 2.4.5, 2.4.6, 2.4.7, 2.4.11, 2.5.1, 2.5.2, 2.5.3, 2.5.7, 2.5.8, 3.1.1, 3.2.1, 3.2.2 (after a language change focus returns to the chosen option and the change is announced in the new language once the Hub saved it), 3.2.3, 3.2.4, 3.2.6, 3.3.1, 3.3.2, 3.3.3, 3.3.4, 3.3.7, 4.1.2, 4.1.3 |
| **Partially supports** | 1.4.10 Reflow: chat and every Settings section are verified at 320 px; Work, Code, Devices, Network and the Marketplace pass axe at 390 px but are not checked for reflow at 320 px. 3.1.2 Language of parts: in the partial Arabic locale, English fallback strings do not carry `lang="en"`. 3.3.8 Accessible authentication: approving a device means typing the six digits shown on the other device; paste works, but not across devices (a compare-and-confirm alternative needs a security decision). The picture-in-picture corner resize is the browser's own handle; Inline and Full screen are the click alternatives |
| **Not applicable** | 1.2.1-1.2.5 (no recorded media; the live screen view has no audio), 1.4.2, 2.5.4 |

### 4.5 Right-to-left layout (FR-016, M8)

Choosing a right-to-left language (Arabic, or the `ar-XB` pseudo-locale for testing) in
Settings → Appearance → Language (`docs/14` §2.4; the messages are §4.6) sets `<html dir="rtl">` and
the whole interface mirrors:

- **Layout**: every stylesheet and inline style uses logical properties (`margin-inline-start`,
  `inset-inline-end`, `border-inline-start`, `text-align: start`, `float: inline-start`,
  `border-start-end-radius`), so the sidebar sits at the inline start (the right), the inspector
  at the inline end, toasts and menus at the mirrored corners. A unit test
  (`apps/web/test/rtl-css.test.ts`) fails on any physical left or right, except a short allowlist
  with reasons: centring with `left: 50%`, a context menu at the pointer, a free-floating
  picture-in-picture app, chart labels over an unmirrored drawing and a remote screen thumbnail.
- **Icons**: direction-bearing icons (back, forward and the chevrons drawn with them, undo, redo,
  the sidebar and inspector toggles, split right) mirror; all others (send, which points up,
  search, clocks, refresh, the terminal prompt) never do. The list is `MIRRORED_ICONS` in
  `packages/ui`.
- **Left-to-right islands**: code blocks, diffs, the editor, terminals, logs and commands,
  keyboard shortcuts, folder paths, URL and email fields, and tool and model ids (shown as code)
  stay left to right (`dir="ltr"`, isolated inside right-to-left text). User content (messages,
  thread and page titles, the composer and free-text fields) uses `dir="auto"`, so an English
  message reads left to right in an Arabic interface and the other way round.
- **Keys and drags**: Left and Right in tabs, toolbars and other horizontal lists, in trees
  (Left opens a branch) and on splitters follow what the user sees.
- **Checked**: `e2e/rtl-layout.spec.ts` visits the core screens in `ar-XB` and `ar` at desktop and
  phone sizes and fails on a sideways page overflow, anything outside the viewport, text clipped
  without an ellipsis, or two controls overlapping.

### 4.6 Localization (FR-016, M8)

*As built in M8 (ADR-097 D9; `packages/i18n`, `apps/web/src/i18n`; the setting is `docs/14` §2.4).*

- **Messages.** UI text is declared with `defineMessages` from `@nova/i18n` next to the code that
  shows it, one message per sentence or label (never a sentence built from fragments), in an ICU
  MessageFormat subset: `{name}` placeholders, `{n, plural, =0 {…} one {# …} other {# …}}` and
  `{x, select, … other {…}}`. Message ids are `<namespace>.<key>`; namespaces are unique in the
  repository. A message without placeholders reads as a string and one with placeholders is a
  function taking exactly those (checked by the compiler); every read translates in the active
  locale, so text is read at render time, never copied at module load. Sentences with a link, a key
  cap or code inside use `rich(…)` (`richMessage`), which passes strings and numbers through, so a
  plural or select works inside a rich sentence. A message stays one literal when it has
  placeholders (joining literals with `+` loses its typing), and a message key starting with `use`
  trips the React hooks lint rule. Errors the Hub returns are shown through the client's own words
  for their `code` where it has them.
- **Locales.** `en` is the source, in code. `ar` is a partial machine-drafted translation (shell,
  palette and commands, onboarding, layout, settings navigation and Appearance, chat, the language
  picker, the marketplace and extensions, and `packages/ui`); anything missing falls back to
  English, with English plural rules. `en-XA` and `ar-XB` are generated at run time from the source:
  accented, about a third longer and bracketed, and (for `ar-XB`) right to left with every string
  mirrored by bidi controls. Translations are JSON per locale and namespace in
  `apps/web/src/i18n/locales/<locale>/<namespace>.json` (`{key: translation}`), loaded lazily; the
  desktop shell reads the same files. Languages are always listed by their own names. After a
  change the shell remounts and focus returns to the chosen language, which is announced in the new
  language once the Hub has saved it; if the Hub refuses, focus returns to the language in force and
  the error is in that language.
- **Formatting.** Numbers, percentages, sizes ("2 KB"), dates, times, relative times, durations
  ("1 h 1 min") and lists ("LAN, Mesh, and Relay") go through `fmt` in the active locale, never
  `toLocaleString()` without a locale or hand-built English plurals. Key caps stay as printed; their
  spoken names ("Ctrl plus K") are localized.
- **Guards.** `npm run i18n:check` (part of `npm run lint`) collects every `defineMessages` call
  with the TypeScript compiler API and verifies the committed English catalog
  `apps/web/src/i18n/catalog.en.json` (for translators; `npm run i18n:write` regenerates it), and
  fails on duplicate ids, translations of keys that no longer exist and placeholder mismatches; it
  prints each locale's coverage. The ESLint rule `nova-i18n/no-literal-ui-text` (a local plugin)
  forbids JSX text and literal `aria-label`, `title`, `placeholder`, `alt`, `label`, `hint`,
  `description` and similar props (and the same keys in menu, tab and option objects) in the
  folders listed in `I18N_CONVERTED` in `eslint.config.js`, which as of M8 covers `packages/ui`,
  `apps/desktop` and every web area. Each area has a test
  that renders its screens in `en-XA` and fails on any visible text or accessible name that is not
  pseudo-localized (fixture data and Hub-written text are passed as data; addresses that contain
  such data stay recognised), and `ar` tests check the right-to-left shell with Arabic words.
- **Not localized in M8**: text the Hub writes (error and notification messages, statuses and
  details, permission lines, diagnostics, audit fields), catalog and manifest text from extensions
  and plugins, and the content of chats; protocol values (paths, commands, URLs, header and
  environment names) and JSON-RPC error messages to MCP apps stay as written. MCP apps are told the
  browser's `navigator.language`, not the locale chosen in Nova.

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

**M7 routes and commands** (ADR-095). New routes: `/approvals` (`?focus=<id>` puts one approval
first), `/team`, `/team/shared` and `/team/shared/<threadId>`, `/team/agents`, `/team/agents/new`
and `/team/agents/<id>` (`?tab=`); `/sign-in` opens Settings → Account (where a failed identity
link lands with `?oidc_error=`). `/approvals/<id>` opens the chat at that approval, or
`/approvals?focus=<id>` when the approval has no conversation or cannot be read. Two pages render
without a session, like `/add-device`: `/join` (an invitation, `#invite=<token>` or `?token=`) and
`/profile/<handle>` (a public profile card). New Settings sections: `account`, `members`, `cloud`
(Cloud runner; `?env=<id>` and `?run=<id>` open an environment or a run as a page), `sync` and
`experimental`. Inside the desktop app the palette adds **Open this view in a new window**
(`window.openCurrent`, no default key; §9.1).

**M7.5 routes** (ADR-096). Every new path parses as the devices route; the page reads the rest of
the address, so the router and the deep links do not change. A device page takes `?tab=firmware`
and `?tab=boot`, and `/devices/<id>/boot` (where the boot notifications link) opens the Boot tab.
`/devices/<id>/oob` and `/devices/<id>/oob/<endpointId>` (or `?tab=oob`) open its Out-of-band
tab, on one BMC; `/devices/oob` is the out-of-band page and `/devices/oob/<endpointId>` one BMC.
On either BMC path, `?action=power.on`, `power.off`, `power.cycle` or `power.reset` opens that
action's confirmation once; nothing runs until the owner confirms it and approves its card. There
are no new palette commands or Settings sections.

### 5.1 Deep links (FR-007)

| Link (`nova://` or `web+nova://`) | Opens |
| --- | --- |
| `settings`, `settings/<section>` | `/settings/<section>` (unknown section → General) |
| `chat`, `chat/<id>`, `chat/<id>?m=<messageId>` | the chat, at the message when given |
| `projects`, `projects/<id>` (alias `project`) | the project list or one project |
| `code`, `code/<id>` | Code mode or the session (`/code/<id>`) |
| `run/<id>`, `run` (alias `work`) | the Work run (`/work/<id>`) or the Work list (M7) |
| `approval/<id>`, `approval` (alias `approvals`) | `/approvals/<id>`: the chat at that approval card, or `/approvals?focus=<id>` when it belongs to no conversation; `approval` alone opens `/approvals` (M7) |
| `agent/<id>`, `agents` | the agent list or one agent (M6) |
| `computer/<id>`, `computers` | the computer list or one computer (M6) |
| `device/<id>`, `devices` | the device list or one device (M6) |
| `add-device?p=<pairing id>&fp=<hub fingerprint>&r=<relay url>&rp=<relay pairing id>#c=<code>` | `/add-device` (the joining device's page, M6.5, FR-132) with only the fields that validate; the code stays in the fragment. The Hub's QR link opens the same page directly |
| `theme?data=<base64>` | `/settings/appearance?theme=<data>`: the theme import, filled in; nothing is kept until the user saves it (FR-011). The data is at most 44,000 characters |

Ids must be 1–100 characters of letters, digits, `_` and `-` after decoding; anything else,
other schemes and longer paths are refused and the app opens `/chat`. The installed PWA
registers `web+nova` as a protocol handler that opens `/open?url=%s`; the desktop app registers
`nova://` (below).

**In M7** (ADR-095) `nova://run/<id>`, `nova://code/<id>` and `nova://approval/<id>` are what
notifications open. A push notification opens its in-app `path`, else its `nova://run`, `code`,
`approval` or `chat` link, and never another origin.

The desktop app (`apps/desktop/src/deeplinks.ts`) maps the same links itself, with three
differences: `run` and `approval` need an id; `add-device` also takes `h=<Hub address>` (and up to
four `e=` endpoints), so the connect page is filled in and the Hub verified against the pin before
its `/add-device` page opens; and its own route list (`apps/desktop/src/routes.ts`) does not know
the M7 Settings sections or `/team` yet, so `nova://settings/sync` (and the like) opens Settings →
General. A link goes to the window already at that place, else the last used window; a second
launch hands its link to the running app. Only an installed build registers `nova://` with the
OS; a development or test run does not.

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

**In M7** (ADR-095) the desktop app registers the first two keys. Settings → Keyboard →
**Global shortcuts** lists "Open quick chat or focus Nova" and "Attach the frontmost window", each
with its key and state (**Works**, **Taken by another app**, **Used twice**, **Not valid** or
**Off**), and **Change** (press the new keys; Esc cancels), **Remove** and **Reset**. A global key
needs a modifier other than Shift ("A global shortcut needs Ctrl, Alt, Super or Command, not only
Shift."). A key another app holds is reported (also in the tray menu and the overlay), never
forced. In a browser tab the section says that only the desktop app can offer these keys and
lists the defaults. The kill key and the ambient pause key belong to `novad` and are not listed
there.

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
app on this platform; a denial or expiry says so and offers to start again. In M7, when the link
names a Relay (`r`, `rp`: the owner chose to pair through it), the page pairs through the Relay
instead, needs no direct answer from the Hub, and keeps waiting across a reload (FR-137).

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

**In M7** (ADR-095) the web UI adds:

- **Offline** (FR-112, FR-129; `apps/web/src/offline`). While the Hub does not answer, a banner
  above the workspace says "Offline: showing what this device has.", where that comes from (the
  device's offline copy and when it was last updated, or only what the page already loaded), how
  many changes wait to send, **Review** and **Try again**; the Hub is checked again with growing
  pauses (2 s up to 60 s). With an offline copy (a device session with the Offline copy scope)
  chats, messages, projects, spaces (with their names) and pages (with their versions) read from
  the copy, and sending a message, starting a chat, renaming, pinning or archiving a chat,
  renaming a space, editing a page and changing a project's name or instructions queue as
  changes. Without a copy, offline is read-only. Messages with files, deletes, model changes and
  temporary chats are not queued. Once the Hub is back the
  banner says "Sending N changes made while offline." or, for failures, "N changes could not be
  sent." with **Review**. The queue panel (in Settings → Sync) lists each change in order with
  **Waiting to send**, **Sending**, **Not sent** (with the Hub's reason) or **Sent**, when it is
  tried again, **Retry**, **Copy** and **Discard** (asks first). After a queued message reaches the
  Hub, the app asks the Hub to answer it, without a button: only the last waiting message of a
  chat, and not one this computer's model already answered; a refusal is a plain note on the sent
  item ("Newer messages follow it in the chat, so it was not answered on its own."). In the chat,
  such a message carries the badge **Written offline**.
- **Answer on this computer** (FR-128, the desktop app only). While offline, a panel above the
  composer lets a model on this computer (through `novad`, `window.novaShell.localRuntime`) answer
  the messages waiting for the Hub: "Model on this computer", **Answer with this computer's
  model**, the answer streaming as plain text, then kept on the device and queued. It needs an
  offline copy holding the chat and a device the Hub gave Local models; otherwise the panel says
  which is missing (in a browser tab: "…can answer only in the Nova desktop app."). An answer
  carries the badge **Answered offline by a local model** in the chat.
- **Settings → Sync** (FR-109): **This device** (the offline copy: on or off as the Hub's grant
  says, size, what it holds, last synced, **Sync now** and **Load again**, which asks first),
  **Changes waiting to send** (the queue panel), **Devices with an offline copy** (Synced,
  Pending, Offline or Error, with **Load again**) and **History** (the merge log; "Show": Can be
  restored, Restored, Everything; each conflict's two values, which won and which devices set them;
  **Restore the replaced value** asks first; **Show older**).
- **Push** (FR-111; Settings → Notifications). The browser section is now "While Nova is open".
  **Notifications on this device**: **Turn on for this device** (asks the browser's permission and
  subscribes), **Send a test**, **Turn off**, and "Devices that get notifications" with **Remove**
  (asks first). **For every device**: "Send push notifications" (`push.enabled`) and "What a
  notification says" (Nothing; The kind and where, recommended; Titles). The service worker shows
  only the title the payload carries; an approval stays on screen with **Open** and **All
  approvals**. Each kind in the routing table has **Send a test**, which says where it went,
  including quiet hours.
- **Approvals** (`/approvals`, FR-111, FR-077): every approval waiting for you, from every chat,
  run, Code session and agent, oldest first, on a page that works at phone width. Each shows where
  it comes from (with a link) and when it was asked, above the same card and six decisions as in
  its conversation; the first answer from any device counts, and updates are live. **New task**
  (also "Start a task" when nothing waits) opens a sheet that fills the bottom of a phone screen:
  "Work run" or "Code session", a project (a Code session needs one with a folder, then a folder)
  and the instructions, which are the run's objective or the session's first message; **Start**.
- **Connection** (FR-137). The account menu's first item says how this browser reaches the Hub
  ("Connected over LAN", "Connected over Mesh", "Connected through the Relay", "Checking the
  connection…", "Cannot reach the Hub") with the address and latency, and opens Network. A browser
  paired through the Relay falls back to it when the page's own address stops answering, and tries
  the address again every 60 s. Images, attachments shown by address and terminals do not load
  through the Relay yet. **Network → Relay** adds the write-only **Registration token** (set,
  replace, remove after confirming).
- **Settings → Cloud runner** (FR-108, FR-071, FR-116): **Runner** (its state, **Test**, "Use the
  cloud runner", which asks first), **Address and token** (the token is write-only; **Forget
  runner** asks first), **Caps** (CPU time and running time per run, disk per environment, "Warn
  at" a percent of a cap),
  **Network** ("Unrestricted network", asks first; without it new environments get no network),
  **Cloud environments** and **Runs**. An environment page (`?env=`) has **New Work run here…**,
  **New Code session…**, **Rebuild…**, **Delete…**, its facts, **Repositories**, **Setup** with its
  log, **Snapshots**, **Files** and **Runs here**. A run (`?run=`, and on its Work run's page) shows
  live CPU and running time against the caps, a warning near a cap, the capped state, **Raise
  caps…**, **Keep a file…** and **Cancel run…**. The Work list adds **New run in the cloud…**.
- **Settings → Experimental** (FR-202, FR-203; both off by default, turning one on asks first):
  **Scripted tool calls** ("Let the model call tools from a short script", with its time, memory,
  tool-call and console limits) and **External coding agents** ("Let Code sessions delegate to
  external agents", and **Adapters**: add with write-only secrets, check in a chosen session's
  sandbox, turn off, edit, remove). Their tabs in a Code session are in §2.4.
- **Team** (FR-217, FR-091, FR-113). **Settings → Members**: **People** with their roles; for the
  owner **Invite someone** ("Who it is for (optional)", "The link works for" 1, 3, 7 or 30 days;
  the one-use link is shown once with Copy), **Invitations** with **Withdraw**, **Remove** for a
  member (asks first; their sessions end) and **Sign-in providers** (OpenID Connect: name, issuer,
  client id, a write-only client secret shown as Set or Not set, scopes, "Allow signing in with
  it", **Test** on an enabled provider, **Remove**). A member sees People read-only. **Settings →
  Account**: "You on this Hub", **Sign-in identities** (link one at an enabled provider, unlink)
  and **Public profile card** (off by default: "Show my public card", a handle, "Show my avatar", a
  preview of what is public; the owner's "Allow public profile cards on this Hub" asks first). The
  sign-in screen lists the providers above the setup panel. `/join` shows who invited you and when
  the invitation expires, takes "Your name" (**Join**) or **Continue with <provider>**, and opens
  Nova; `/profile/<handle>` shows a card or "No public card here". A chat's menu has **Share with
  people…**: the dialog says what is not shared (anyone's memory, connectors, projects and
  instructions); only a plain chat outside a project can be shared, and sharing turns its memory
  off. **Team → Shared chats** opens one at `/team/shared/<id>`: who wrote each message and who
  asked for each reply, a text-only composer that sends as you, **Stop** for anyone, **Leave**,
  the owner taking people out, and the approvals for your own turns. The normal chat view does not
  show authors. **Team → Team agents**: the owner provisions one (name, responsibilities,
  instructions, autonomy, model); anyone gives it a task; its page has **Tasks** (with the result
  and Cancel) and, for the owner, **Approvals** (Allow once, Allow for this session, the two Deny
  options; checked every 10 s), write-only **Credentials** and **Audit** (**Show older**).
- **Channels** (FR-110, FR-060, FR-055). Telegram setup takes a bot token (or "Same bot as …")
  and "How messages arrive": Polling (default) or Webhook, which needs an https public address;
  Telegram's webhook secret shows as "Made by Nova". Email setup takes the mailbox, login,
  password, IMAP and SMTP servers with TLS (default), STARTTLS or None (only on this machine), and
  "Stay connected (default)" or "Check every few minutes"; email approvals are answered only by
  their signed link. Each channel has a **message log** (newest first, filters by direction and
  "What happened", **Show older**, live). Telegram users can be added under People. A schedule that
  delivers to a webhook shows its **Signing secret** with **Make a new secret** (confirmed inline,
  shown once).
- **Browser** (FR-092, FR-103, FR-094, FR-098). The browser panel adds **What the page logged**:
  **Console** (Every message, Errors and warnings, Errors only) and **Network** ("Address
  contains", "Only failed or blocked"), as text, the latest 300 of each while the browser is open;
  "The browser is not open" otherwise. **Browser site levels** can differ per project or agent
  (Settings → Browser per site, and on a project's page and an agent's Computer tab); the
  narrower scope wins. The trace lists actions newest first with **Show older**, **Retry** when
  a page cannot load, and crash and restart rows.
- **Devices** (FR-126): each device row has a certificate chip (**Certificate verified**, **No
  certificate**, **Certificate refused**), the list has a **Device certificates** section with
  "Require a device certificate over HTTPS" (asks first and names the devices that would be
  refused), and a device page shows its own state.

**In M7.5** (ADR-096; `apps/web/src/devices`, `firmware`, `boot`, `oob`, `browserdevice`) the web
UI adds:

- **A device page** (a device running `novad`). The tabs are now Capabilities, Modules, Power,
  Updates, Policy, Files, Agents, MCP, **Firmware** and **Boot**, then **Out-of-band** when a BMC
  is linked to the device (§5 has the paths). Above the tabs, the page adds:
  - **Management**, a fact next to the M7 Certificate fact (ADR-096 D1): **Mutual TLS** ("The Hub
    and the device check each other's certificates on every call."), **Plain HTTP** ("Calls are not
    encrypted. Add the device again with the Hub's local CA to use mutual TLS."), **No address
    yet**, or **Channel refused** with when and why ("…the device still presents its old
    certificate; it installs the renewed one with its next heartbeat"). A line under it gives the
    certificate's renewal: "Certificate renewal offered; the device switches at its next check-in
    (its old certificate is accepted until …)", "Certificate renewed …; valid until …", or "This
    device has an older kind of certificate; the Hub offers a new one at its next check-in."
  - **Decommission…** (a danger button next to Revoke, ADR-096 D9). The dialog "Decommission
    <device>?" is "For a computer you are giving away, selling or retiring", lists what happens
    after the approval (online: novad stops its modules, deletes its key, credentials and
    certificate and removes its service; offline: it wipes them at its next contact; either way the
    Hub revokes it and its certificate; it cannot be undone), offers **Also delete its Nova data**
    (novad deletes its data folder; the owner's own files are not touched), and needs the device's
    name typed ("Type <device> to confirm") before **Ask to decommission <device>** works. A
    **Decommission** section then shows its state (Waiting for your approval, Decommissioning,
    Decommissioned, Denied, "Expired: nobody answered in time", Withdrawn, Failed), its approval
    card while it waits, and what the device did ("The device wiped its credentials and removed its
    service, then was revoked.", or that it did not answer, refused, or was not told, and was
    revoked anyway).
  - **Browser bridge** (FR-096), collapsed to "Now: N shared tabs, N sites granted" with a chip
    (Connected, Not connected, Turned off) and **Show details**; it opens by itself while a site
    waits for the owner. Open, it shows the browser, extension version, OS user and since when;
    **Shared tabs** ("You shared it" or "Opened by the agent in the Nova tab group"); **Sites**:
    each waiting one ("Waiting for you") with **Confirm** and **Refuse**, each granted one
    ("Granted") with **Revoke**, and "Site to grant" with **Grant** (the Hub's own addresses are
    refused on the field); **All sites**, marked **Elevated risk**, with **Grant all sites…** only
    while Settings allows it; **Show revoked grants**; **Recent activity** from the audit log
    (connected, disconnected, a connection replaced, history searches, browser sessions the Hub
    closed); and the setup steps (the unpacked extension build, `bridge.extensionId` and
    `localRuntime.users` in novad's `config.json`, `novad bridge enable`), open while the bridge is
    not connected. Every grant, confirmation, refusal and revoke asks first in a dialog that names
    the computer and the site.
- **Inside the existing tabs.** Modules adds **Managed services**, the services declared in
  novad's configuration with their state and Status, Start, Stop and Restart (an older novad: "This
  device's novad cannot list its services yet…", and the by-name form still works). Updates adds
  **Available build**: the novad build this Hub serves for the device's platform, compared with
  what it runs; information only ("The Hub does not install it by itself…"). Policy adds **On the
  device** with **Push now**, a chip ("Waiting for the device: change N, it has M" or "The device
  has the latest (change N)") and **In force on the device**, the settings from its last signed
  capability document. Power now says that what happens after a power cut, and Wake-on-LAN in the
  firmware, are changed in the Firmware tab, with a link.
- **Firmware tab** (FR-146; owner only). **Read again**; **Supported** or **Not supported** with
  the plain reason; the **Hardware support matrix** (opened on demand; Linux only); the machine,
  firmware and how it is reached; the **Settings** table of the allowlist (Wake-on-LAN, After a
  power cut, Boot order, Virtualization, Secure Boot, TPM, Fan profile) with "Read-only" and
  "Weakens security when …" marked by an icon and words. With "Allow BIOS/firmware changes" off, a
  note says what the switch does and links to Settings → Devices; reading still works. With it on,
  **Plan a change** (a dry run; choices that weaken security say so, and the boot order moves with
  Up and Down) leads to the **Current change**: its diff (Setting, Before, After, and "Weakens
  security" rows), what was left out and why, then **Ask for approval**, the Hub-only card (§2.6),
  and **Apply…**, whose dialog lists every change and offers "Restart <device> now, with the
  watchdog" ("If <device> does not come back within <the Firmware watchdog setting>, it restores
  the previous settings and restarts once."; hidden on a machine with a BIOS admin password, where
  the dialog says why). The tab names how the device reaches its settings ("Linux firmware
  attributes", "efibootmgr (boot order only)", "Test backend (no real firmware)"), and a method
  this Hub does not know as "unknown (<name>)". **BIOS admin password** is
  write-only (**Store**, **Remove…**). **Firmware updates** lists what fwupd reports: "Nova shows
  them but does not install firmware updates." **History** shows each change with its status
  (Planned, "Waiting for your approval", "Approved, ready to apply", Applied, Rolled back, Failed,
  "Reverted by the watchdog", "Not reverted: check it") and its watchdog outcome; **Roll back…**
  plans restoring the snapshot behind its own approval. A change the watchdog could not revert
  adds an "On the device now" column and says the settings may not be safe; Roll back stays
  offered.
- **Boot tab** (FR-143; owner only). The bootloader (systemd-boot, GRUB, "UEFI boot manager",
  "Test bootloader (fake)" for `novad`'s test backend, "None found", or "unknown (<name>)" for one
  this Hub does not know),
  booted and default entry, the entries, and the last trial; a note with a link while "Allow
  low-level boot changes" is off. **Pending trial** counts down to its deadline and has **Revert…**
  ("Works even with low-level boot changes off."). **Boot profiles** (a name for an entry; "Kernel
  arguments" is labelled "Not supported yet." and anything typed there is refused on the form, not
  sent) with **Try on next boot…** (the watchdog time, 2 to 60 minutes, and "Restart <device> as
  soon as you approve"), **Rename…** and **Delete…**. **Trials** (Trying, Came back, "Back on the
  default", "Did not come back") offer **Make default…** after one came back; an unverified trial
  says so ("Not verified: the device could not tell which entry it booted"), and its dialog needs
  the box "I checked that <device> booted <entry>" ticked before it asks for approval.
  **Requests** show each card with a what-changes table. **Network boot (PXE)**: on or off, "Nova
  runs no DHCP or TFTP server", **Make a boot token** (later **Make a new token…** and **Revoke…**,
  each asking first), the token and the iPXE address each with **Copy** under "Copy it now: it is
  shown only once", and the images in the Hub's boot-images folder.
- **Out-of-band management** (FR-147; owner only). The Devices list ends with an **Out-of-band
  management** section ("On, N BMCs." or "Off.") and **Open out-of-band management**. The page
  `/devices/oob` has **Turn on…** (its dialog lists what it allows: the Hub connects to the BMCs
  you add with their credentials, can power a machine on, off, cycle or reset it, pick its next
  boot device and change its BIOS settings, every change waits for your approval in Nova and never
  from a channel, and everything is audited; **Turn on out-of-band management** sends the consent),
  **Turn off** (also asks; waiting approvals are withdrawn), **Add a BMC** (only while on) and the
  **BMCs** list (kind, last check, address, the device it manages, the certificate pin, missing
  credentials). **Add a BMC** takes a name, the kind (Redfish, IPMI, and Intel AMT shown disabled:
  "Not available in this version."), address and port, the Redfish system id, the device, a user
  name and password (kept in the vault, never shown again) and an optional SHA-256 fingerprint.
  A BMC's page (also the device's Out-of-band tab) shows its facts, then:
  - after a Redfish BMC's first check, "Is this your BMC's certificate?": the Hub read it without
    sending credentials, the full fingerprint is shown to compare with the BMC's own page, and
    **Yes, it is my BMC's…** (then **Confirm the fingerprint**) or **Enter the fingerprint
    instead…**. Until then every other action says why it cannot run;
  - on a pin mismatch, an alert names the pinned fingerprint and says Nova sent the BMC nothing,
    with **Pin the new certificate…** and **Clear the pin…**, each asking first;
  - **Connection** (**Check the connection**), **Waiting for you** (its cards inline, and **Apply at
    the next restart…** for an approved BIOS plan), **Power** (**Read the power state**, then
    **Power on…**, **Power off…**, **Power cycle…** and **Reset…**, whose dialogs say what the
    change does, which device the BMC manages, and that it runs only after approval within 10
    minutes; buttons "Ask to power off" and the like), **Next boot** (once; USB is not offered over
    IPMI), **Sensors**, **BIOS settings** (Redfish only; a plan that weakens security needs "Include
    the change that weakens security" ticked, and its diff marks the rows), and the **Action log**
    ("A read: no approval needed", "With your approval", "From an approved plan").
  A failed boot trial's notification ("<device> did not come back from a boot trial"), when the
  device has a BMC and out-of-band management is on, links to the device's Out-of-band tab with
  the **Power cycle** confirmation open; otherwise it opens the Boot tab.
- **A compute node's page** (FR-126, FR-150). **Compute node** (a chip: "Quiet now: no new jobs",
  "Kept out of routing" or "Takes jobs"; load, last heartbeat, what the node says, and each GPU's
  memory with a meter), **Policy** ("Send model work to this node", quiet hours and their time
  zone; **Save policy**; the node takes it with its next heartbeat) and **Services** (**Job API**
  and, when the node manages one, **Model server**, with Status, Start, Stop and Restart). Settings
  → Devices links each node to it ("Policy and services").
- **Settings → Devices → Firmware and boot** (owner only): **Allow BIOS/firmware changes**, **Allow
  changes that weaken security**, **Allow low-level boot changes**, **Firmware watchdog** (2 to 60
  minutes, 10 by default: "For firmware changes applied with a restart: how long the device has to
  come back before its watchdog restores the previous settings."), **Boot watchdog** (2 to 60
  minutes) and **Network boot (PXE)**, the switches off by default and all lockable by managed
  policy. Turning
  one of the four switches on opens a dialog that says what it allows and why it is off ("Allow
  BIOS and firmware changes on devices?", "Allow firmware changes that weaken security?", "Allow
  low-level boot changes on devices?", "Serve network boot from this Hub?"); only its button
  sends `confirm: true`, which the Hub requires. Turning one off never asks. The out-of-band
  switch is on the out-of-band page, not here.
- **Browser** (FR-209, FR-096). In a conversation, when a site blocks the agent's own browser and
  the agent has a connected computer, a card above the composer asks "Continue <site> on
  <device>?" with why ("Asked because the site showed a block page to the agent's browser"), the
  Hub's question and its choices ("Continue on <device> (clean profile)", "Continue in my own
  browser on <device> (extension)" when the bridge can serve the site, "Not now"), each with a line
  saying what it does, and that a choice to continue is remembered until revoked in Settings →
  Browser. In the computer's browser panel a note says "Working in <device>'s browser on <site>"
  while a session runs, and how the last one ended for 30 minutes after; each trace row recorded
  there carries a badge "On <device>, clean profile" (or "your own browser") and a **Where** line
  in its details. Settings → Browser adds **Continue on your computer** ("Offer to continue on the
  agent's computer", the **Sites you agreed to** with **Revoke**, which asks first and stops a
  running session, and **Show revoked**) and **Your own browser (extension bridge)** ("Let agents
  use your own browser through the extension" and "Allow the 'all sites' grant"; managed policy can
  lock either). These switches turn on without a dialog; the grants on a device page ask.
- **The same rules everywhere.** Every consent and confirmation dialog starts with focus on
  **Cancel** (the forms to add a BMC or pin a new fingerprint start in their first field). The
  "all sites" grant also needs "I understand that agents can then act on any site in tabs I share
  on <device>." ticked, decommission the typed name, and an unverified trial its tickbox. States
  pair an icon with words ("Weakens security", "Elevated risk", "Not reverted: check it"), never
  color alone, and outcomes are announced. A refusal from the Hub is shown in plain words inside
  the dialog, which stays open. A member who reaches any of these gets the owner-only notice
  ("Only the owner of this Hub can change this.").
- **Not in the UI.** Firmware updates (fwupd is listed, never installed), kernel arguments in boot
  profiles, Intel AMT, a DHCP or TFTP server, and any way for an agent or model to plan, approve or
  apply firmware, boot or out-of-band changes. The extension is installed from its unpacked build.
  The Approvals page does not link an out-of-band card to its BMC (§2.6).

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

### 9.1 The desktop app (M7)

**In M7** (ADR-095; `apps/desktop`, `apps/web/src/shellbridge`) the desktop app is a client of the
Hub that shows the Hub's own web UI in native windows. The tray and quick overlay are in §1.1,
attach window in §3.2, global shortcuts in §5 and its `nova://` links in §5.1.

- **First run.** "Connect to your Hub" offers **Add this computer** (paste the Add Device link
  from Devices → Add a device → Client, then **Connect**) or **Enter the address and fingerprint**
  ("Hub address", and "Hub fingerprint": the 43 characters under Network → Trust). The app checks
  the Hub's identity against that pin before it sends anything; a refusal says why and that
  nothing was sent. Plain HTTP is accepted only for a Hub on this computer. The app then joins
  through the Hub's own `/add-device` page as a browser device. The app menu (Nova, or File on
  macOS) has **Quick chat**, **New task**, **New window**, **Change Hub…** and **Quit Nova**. An
  Add Device link for another Hub fills the connect page in, and **Connect** replaces the current
  Hub; the page does not name the Hub it replaces.
- **Offline start.** When the remembered Hub does not answer at start, the window opens anyway:
  the web UI runs from its service-worker copy (the app shell and its assets; API calls are never
  cached), every network request to the Hub is cancelled until a fresh identity check passes,
  and the Hub's identity is checked again every 15 s; once it passes, the windows reload. A Hub with another identity shows the connect page.
  The in-chat local answer (§9) works from this state.
- **Windows** (FR-009). **Open in new window** (an icon button named "Open <name> in a new
  window") sits in the chat header, on a Work run's page, in a Code session's header and on an
  agent's page; the palette adds **Open this view in a new window**, and the app menu's **New
  window** opens the last used window's place. A window already showing that exact place is
  focused instead. Only app routes on the Hub's origin open (chats, Work, Code, Agents, Projects,
  Library, Spaces, Sites, Apps, Devices, Network, Computers, Settings and `/approvals/<id>`);
  anything else says "This view cannot open in a window of its own." The editor and terminal
  panes have no route, so they have no window of their own. In a browser tab neither the button
  nor the command shows.
- **Notifications.** The app shows OS notifications itself for the Hub's notifications marked for
  the OS (the routing rules and quiet hours decide), and a click opens their place; the page's own
  notification permission is denied, so each shows once. Inside the app Settings →
  Notifications shows a **This device** note ("The Nova desktop app shows notifications from your
  operating system…"; turn them off for this computer in the OS settings) in place of "While Nova
  is open" and the push section. Neither these nor push notifications offer **Allow once** or
  **Deny and continue** yet (§1.1); an approval's notification opens its card.
- **Not built:** window text on macOS and Windows, voice in quick chat, and the join page telling
  the Hub it is the desktop app (it joins as a browser). The app's journey tests run on Linux only.
