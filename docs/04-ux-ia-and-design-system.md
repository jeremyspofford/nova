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
│  ─ Library    │   └────────────────────────────────────┘     │               │
│  ─ Activity   │                                              │               │
│  ─ Settings   │                                              │               │
└───────────────┴──────────────────────────────────────────────┴───────────────┘
```

The **Inspector** is a contextual right rail shared across modes. In Code mode the main
workspace can split into multiple panes (chat + diff + browser + terminal + editor).

### Primary navigation (sidebar)

1. **New** (context-aware: new chat / run / session / agent)
2. **Search** (global: chats, runs, files, artifacts, commands)
3. **Chat** — threads, grouped by project/recent
4. **Work** — runs (active, scheduled, completed); the Scheduled list includes agents'
   self-set wakes (FR-206)
5. **Code** — sessions (active, archived), grouped by project
6. **Agents** — always-on agents
7. **Projects** — cross-cutting containers
8. **Library** — artifacts/files/images and installed MCP Apps (§2.9)
9. **Activity** — global audit/notification stream
10. **Marketplace** — plugins, skills, themes
11. **Settings**

Every thread, run, session and agent row carries a status chip (§1.1).

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
4. Tool use renders as a collapsible card with status, args, and result.
5. On completion: actions bar (copy/regenerate/branch/like), citations, artifact cards.

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

### 2.9 MCP Apps (FR-198)

Plugin and MCP-server UI renders in an **App frame**: a sandboxed iframe with a header showing
the app name, its server or plugin, a Verified/Unverified badge, the allowed domains (from the
resource's CSP metadata), mode buttons and Close.

| Display mode | Behavior |
| --- | --- |
| **Inline** | Inside the transcript below its tool card; height-capped and resizable. |
| **Fullscreen** | Fills the main workspace; Esc or Exit returns to the thread. |
| **Picture-in-picture** | Floating, draggable and resizable; stays visible across thread switches; one at a time. On phones it becomes a bottom sheet. |

Entry points: **global** (Library → Apps and "Open app…" in the command palette), **thread**
(the composer's + menu → Apps, or a tool result that declares a UI) and **file** ("Open with…"
on a file in the Library or file browser, for apps registered for that type). Tool calls from
an app go through the policy engine and can raise an approval card. A "Shared with the model"
disclosure lists what the app sent as model context; widget state marked private is never
sent.

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
  re-trusted.
- Hooks that arrive with a plugin appear on its install and update screens and are trusted
  there; a hash change in an update appears in the permission diff (FR-167).
- Settings → Hooks lists every hook with its state (Trusted, Needs re-trust, Disabled), last
  run, and a link to its audit entries.

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
EmptyState, CommandPalette, SearchInput, VirtualList, Pet.

Every component: typed props, keyboard support, ARIA, dark/light, RTL-aware, and a Storybook
entry (or equivalent) with variants and a screenshot test.

### 4.3 Layout & responsiveness

- Minimum window 960×640; sidebar collapses below 1100px; Inspector collapses below 1280px.
- Panes use a persisted layout tree; layouts are saveable as "workspaces".
- Full-screen modes for focus; distraction-free composer.

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
`?compare=<id>` compares two branches), `/chat?temporary=1`, `/projects`, `/projects/<id>`,
`/settings/<section>`, `/onboarding` and `/open?url=<link>`; deep links map onto them (§5.1).
Find in chat is Ctrl+F / ⌘F (Alt+F in a browser tab).

### 5.1 Deep links (FR-007)

| Link (`nova://` or `web+nova://`) | Opens |
| --- | --- |
| `settings`, `settings/<section>` | `/settings/<section>` (unknown section → General) |
| `chat`, `chat/<id>`, `chat/<id>?m=<messageId>` | the chat, at the message when given |
| `projects`, `projects/<id>` (alias `project`) | the project list or one project |
| `code`, `code/<id>` | Code mode (sessions arrive in M5) |
| `agent/<id>`, `agents` | Agents mode (agents arrive in M6) |

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
