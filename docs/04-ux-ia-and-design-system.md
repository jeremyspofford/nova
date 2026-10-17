# 04 — UX, Information Architecture & Design System

## 1. Information architecture

```
┌──────────────────────────────────────────────────────────────────────────────┐
│  Title bar:  [⌘K command]   [mode tabs: Chat · Work · Code · Agents]   [acct]  │
├───────────────┬──────────────────────────────────────────────┬───────────────┤
│  Sidebar      │  Main workspace                              │  Inspector    │
│               │                                              │  (context)    │
│  + New        │   ┌────────────────────────────────────┐     │               │
│  Search…      │   │  Thread / Session / Agent / Run      │     │  Artifacts    │
│  ─ Projects   │   │  …messages, tool cards, diffs…     │     │  Files        │
│  ─ Chats      │   │                                    │     │  Sources      │
│  ─ Work runs  │   └────────────────────────────────────┘     │  Activity     │
│  ─ Code       │   ┌────────────────────────────────────┐     │  Permissions  │
│  ─ Agents       │   │  Composer (model, tools, attach)   │     │  Memory       │
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
4. **Work** — runs (active, scheduled, completed)
5. **Code** — sessions (active, archived), grouped by project
6. **Agents** — always-on agents
7. **Projects** — cross-cutting containers
8. **Library** — artifacts/files/images
9. **Activity** — global audit/notification stream
10. **Marketplace** — plugins, skills, themes
11. **Settings**

### Mode definitions

| Mode | Purpose | Primary objects | Key affordances |
| --- | --- | --- | --- |
| **Chat** | Talk, explore, create | Thread | Streaming, attachments, artifacts, voice, memory |
| **Work** | Delegate multi-step tasks | Run | Plan, tools, sub-agents, schedules, approvals, activity |
| **Code** | Software engineering | Session | Env, permission mode, diffs, terminal, browser, PRs |
| **Agents** | Always-on agents | Agent | Computer, channels, rules, proactive research, background threads |

## 2. Key user flows

### 2.1 First run (FR-014)

1. Welcome → choose providers (cards for Anthropic, OpenAI, Google, OpenRouter, Local).
2. Authenticate via OAuth (if supported) or paste API key (stored in keychain).
3. Pick default model; set name/avatar.
4. Optional: connect one tool (GitHub/Slack/Drive/local folder).
5. Sample task pre-filled with a Run this button.
6. Land in Chat with a success toast. Everything skippable; state stored so it resumes.

### 2.2 Send a message (FR-017/018/019)

1. Type; the composer expands, shows model + reasoning + tool chips.
2. Send → optimistic user bubble → assistant bubble streams.
3. While streaming: Stop, Steer (message queues/steers per setting), and "branch".
4. Tool use renders as a collapsible card with status, args, and result.
5. On completion: actions bar (copy/regenerate/branch/like), citations, artifact cards.

### 2.3 Delegate a Work run (FR-051…057)

1. New Run → describe outcome + attach sources + choose autonomy level.
2. Agent produces a **plan card** (editable steps) → Approve plan or auto-proceed.
3. Steps execute; the run card shows live progress, child threads, and approvals inline.
4. Consequential action → **Approval card** (what/who/why/scope) with Allow once / Always
   / Deny / Hand off.
5. Result card: summary, artifacts, evidence links, "Open in Code" when applicable.
6. Run remains in Activity; can be paused, resumed, duplicated, or scheduled to repeat.

### 2.4 Code session (FR-061…070)

1. New Session → choose Environment (Local/Cloud/SSH/WSL), folder/repo, model, permission
   mode.
2. Agent explores (read/search), proposes a plan (Plan mode) or edits directly.
3. Every change surfaces in the **Diff** pane with `+x −y`; per-line comments; accept/reject.
4. Agent runs tests in the **Terminal**; **Browser** pane previews/verifies.
5. `/review` produces a findings card; apply fixes.
6. Commit/branch/PR from the session header; CI status streams in.
7. Panes can be arranged; layout is remembered per session and per project.

### 2.5 Agent setup and operation (FR-079…090)

1. Create Agent → name, avatar, responsibility, connect plugins.
2. Agent introduces itself; proposes a first task from available context.
3. Connect the user's computer (optional) or rely on the cloud computer.
4. Custom Rules configured under Settings → Personalization → Permissions.
5. Agent works in background; the **Activity** tab shows all work; approvals appear inline and
   as notifications.
6. Message the Agent from in-app or a channel; context is shared.

### 2.6 Approve an action (FR-058/100)

```
┌─────────────────────────────────────────────────────────────┐
│ ⚠ Approval needed                                            │
│ Action: Send email to 3 external recipients                  │
│ Why:    Completing "Send the invoice" (Run #128)             │
│ Scope:  This message only                                    │
│ Rules:  Custom rule "Ask before sending to customers"        │
│ [Allow once] [Always allow for this customer] [Deny] [Hand off]│
└─────────────────────────────────────────────────────────────┘
```

## 3. Composer specification

- Multiline, auto-growing, Enter sends (configurable), Shift+Enter newline.
- Left cluster: attach (+), `@`mention, slash-command, tools toggle, voice.
- Right cluster: model picker, reasoning level, autonomy/permission mode (Code/Work/Agents),
  send/stop.
- Drag-drop files; paste images; `@` menu is fuzzy and grouped.
- Shows token/cost estimate on hover (opt-in).
- Visible state for: recording, tool approval pending, run in progress, offline.

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
ArtifactFrame, BrowserPane, TerminalPane, EditorPane, EmptyState, CommandPalette,
SearchInput, VirtualList, Pet.

Every component: typed props, keyboard support, ARIA, dark/light, RTL-aware, and a Storybook
entry (or equivalent) with variants and a screenshot test.

### 4.3 Layout & responsiveness

- Minimum window 960×640; sidebar collapses below 1100px; Inspector collapses below 1280px.
- Panes use a persisted layout tree; layouts are saveable as "workspaces".
- Full-screen modes for focus; distraction-free composer.

### 4.4 Accessibility

- Focus order logical; focus-visible rings; full keyboard operation of palette, menus,
  diffs, terminal, and browser panes.
- Screen-reader announcements for streaming (throttled), tool status, and approvals.
- Contrast ≥ 4.5:1 body, ≥ 3:1 large text; tested in high-contrast theme.
- Reduced motion, reduced transparency, and font-scaling support.

## 5. Keyboard map (defaults; all remappable)

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

## 6. States & feedback

Every surface must handle: **empty**, **loading** (skeleton), **streaming/partial**,
**error** (actionable, with retry/diagnostics), **offline/queued**, **permission-denied**,
**rate-limited/over-budget**, and **degraded** (provider down). Errors never lose user input.

## 7. Content & voice

- Clear, specific, non-anthropomorphic copy. Agents are "agents", not people.
- Always show *what* an agent will do and *why* before a consequential action.
- Never fake progress; show real tool activity.
- Accessibility: avoid color-only status; pair with icon + text.

## 8. Onboarding content requirements

- Provider setup help per provider (where to get a key, OAuth flow).
- A 3-step "your first run" tutorial that actually executes a harmless task (e.g., summarize
  a bundled sample doc) and ends with a visible artifact.
- A safety primer: what approval cards look like, how to stop an agent, where the audit log is.
