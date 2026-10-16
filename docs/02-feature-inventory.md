# 02 — Feature Inventory (Extracted from Source Products)

This inventory captures the functional surface observed/documented in the four source
products, translated into vendor-neutral capability statements. Each item is a candidate
requirement refined in `docs/03-functional-requirements.md`.

Legend: `[C]` Claude Desktop · `[G]` ChatGPT Desktop · `[X]` Codex · `[D]` Dots.

---

## A. Application shell & navigation

| ID | Capability | Source |
| --- | --- | --- |
| INV-A01 | Tabbed top-level modes (Chat / Work-Cowork / Code) within one window | C, G |
| INV-A02 | Sidebar listing threads/sessions, grouped by project, with search, pin, archive, unread | C, G, X |
| INV-A03 | Command palette (`Cmd/Ctrl+K`) with fuzzy actions and navigation | G, X |
| INV-A04 | Keyboard shortcut system with remapping and keystroke search | G, X |
| INV-A05 | Multi-pane workspace (chat, diff, browser, terminal, editor, preview) with resizable/arrangeable panes | C, X |
| INV-A06 | Tabs: close/reopen, close others, next/previous, navigate back/forward | G |
| INV-A07 | Bottom panel + integrated terminal (Code mode) | C, X |
| INV-A08 | Deep links (`app://settings`, `app://chat/<id>`, OS URL scheme) | G |
| INV-A09 | System tray / menu-bar presence, quick chat, global hotkey | G |
| INV-A10 | Multiple windows and detached panes | G |
| INV-A11 | Theming: base theme, accent/background/foreground colors, UI + code fonts, share/import theme | G, X |
| INV-A12 | Optional animated companions ("pets") and status customization | G, X |
| INV-A13 | Font size increase/decrease/reset; full-screen; zoom | G |
| INV-A14 | Notifications for completion, attention, approvals; per-event toggles | G, X, D |
| INV-A15 | Onboarding wizard: provider connect, name/avatar, tool connection, first task | C, G, D |

## B. Conversation (Chat mode)

| ID | Capability | Source |
| --- | --- | --- |
| INV-B01 | New chat, standalone chat, quick chat, temporary/incognito chat | G |
| INV-B02 | Streaming responses with stop/continue and mid-run redirection | C, G, X |
| INV-B03 | Message actions: edit, regenerate, branch, copy, quote, like/dislike, delete | G |
| INV-B04 | Attachments: images, PDFs, docs, code, drag-and-drop, paste | C, G |
| INV-B05 | `@`-mentions of files/folders/connectors in the composer | C, X |
| INV-B06 | Model picker inline; change model mid-conversation; reasoning-level selector | C, G, X |
| INV-B07 | Search within chat (find/next/prev); search across chats | G |
| INV-B08 | Branched threads / side chat / side questions without derailing main thread | C, G, X |
| INV-B09 | Temporary chats excluded from memory and history | G |
| INV-B10 | Suggested follow-up prompts (Tab to accept) | C |
| INV-B11 | Follow-up behavior setting: steer current run vs queue next run | G, X |
| INV-B12 | Voice conversations (realtime) inside Chat/Work/Code | G, X |
| INV-B13 | Image generation and editing from the composer | G, X |
| INV-B14 | Web search with citations | G, X |
| INV-B15 | Memory: user-editable, per-chat toggles, import from other assistants | G, D |

## C. Projects, Spaces & Library

| ID | Capability | Source |
| --- | --- | --- |
| INV-C01 | Projects containing chats + sources + shared instructions | G, C |
| INV-C02 | Local projects bound to one or more folders on disk | G, X |
| INV-C03 | Space/Pages: collaborative documents developed with the agent | G |
| INV-C04 | Sites: build, connect data, publish, share, manage versions/analytics | G, X |
| INV-C05 | Artifacts viewer for documents, code, previews; live reload | C, G, X |
| INV-C06 | File browser + editor + preview (HTML/PDF/image/video) | C, X |
| INV-C07 | Source management: upload, connect, re-index, remove | G |
| INV-C08 | Project-level instructions and memory scope | G, C |

## D. Tools, MCP, plugins, skills

| ID | Capability | Source |
| --- | --- | --- |
| INV-D01 | MCP client: register/launch local + remote MCP servers; tools/resources/prompts | all |
| INV-D02 | MCP server: expose Unison capabilities to external agents | C |
| INV-D03 | Plugins bundling skills + MCP servers + optional UI; marketplace install | all |
| INV-D04 | Skills: reusable instruction bundles, slash-invoked or auto-selected | C, G |
| INV-D05 | Connectors: OAuth/API-key integrations (GitHub, Slack, Linear, Google, …) | C, G |
| INV-D06 | Per-tool and per-plugin permission controls | C, G, D |
| INV-D07 | "Sign in with" delegation so external apps can use the user's plan | G |
| INV-D08 | Plugin browser in CLI and GUI; install/update/uninstall | G, X |
| INV-D09 | Skill authoring from conversation ("build a plugin") | G, X |
| INV-D10 | Desktop-only plugins gated by app capability flags | G |

## E. Work mode (delegated agentic tasks)

| ID | Capability | Source |
| --- | --- | --- |
| INV-E01 | Delegate a multi-step task; agent plans, acts, reports | C, G |
| INV-E02 | Long-running work continues while the user steps away | C, G, X |
| INV-E03 | Background sub-agents run in parallel and report to a coordinator | G, X, D |
| INV-E04 | Visible child threads for parallel work; open and steer them | G, D |
| INV-E05 | Scheduled recurring tasks with timezone, end date, delivery target | C, G, X |
| INV-E06 | Event-triggered work (e.g., new Slack message/bug report) | D, X |
| INV-E07 | Activity view: progress, files, results, requests for input | D, G |
| INV-E08 | Approvals and hand-offs for consequential actions | C, D |
| INV-E09 | Delegation to coding agent (Codex) and vice versa | G, D, X |
| INV-E10 | Notifications routing (chat, OS, channel) based on rules | G, D |

## F. Code mode (software engineering agent)

| ID | Capability | Source |
| --- | --- | --- |
| INV-F01 | Sessions bound to an environment + project folder; run in parallel | C, X |
| INV-F02 | Environments: Local, Cloud, SSH, WSL | C |
| INV-F03 | Permission modes: Manual, Accept edits, Plan, Auto, Bypass | C |
| INV-F04 | Diff view with per-line comments; apply/reject; multi-file review | C, X |
| INV-F05 | Browser pane to run/preview/dev-server and verify changes | C, X |
| INV-F06 | Built-in terminal, run commands, stream output | C, X |
| INV-F07 | Auto-verify after edits (screenshots, DOM inspect, click/fill) | C |
| INV-F08 | Code review command/card grouped by file; act on findings | C, X |
| INV-F09 | PR creation and CI status monitoring | C, X |
| INV-F10 | Multiple repositories in cloud sessions | C |
| INV-F11 | Check on/message/archive other sessions | C |
| INV-F12 | Worktrees / parallel agents on the same repo | X |
| INV-F13 | Repo index / semantic search; symbols and references | X |
| INV-F14 | Appshots: capture app state for debugging | X |
| INV-F15 | Visualizations: turn data/ideas into interactive explanations | X |
| INV-F16 | Mobile: start/approve/review coding tasks | X |
| INV-F17 | SSH session persists while disconnected (subject to auth) | C |
| INV-F18 | iOS simulator pane (macOS only) | C |

## G. Dots / always-on agents

| ID | Capability | Source |
| --- | --- | --- |
| INV-G01 | Create/named/personalized always-on agent; multiple responsibilities | D |
| INV-G02 | Own cloud computer + browser, persistent state, works while devices off | D |
| INV-G03 | Connect the user's computer (one at a time); access local files/code/apps | D |
| INV-G04 | Proactive research from read-only connected tools | D |
| INV-G05 | Background agents + cloud threads; keep talking while they run | D |
| INV-G06 | Custom rules: allow / allow-on-request / ask / hand-off; scopes | D |
| INV-G07 | Auto-review of actions vs instructions/rules/safety | D |
| INV-G08 | Private sign-in flow; save to passwords; sessions vs saved logins | D |
| INV-G09 | Inspect computer; takeover / return control | D |
| INV-G10 | Channels: ChatGPT app, Slack, Teams, (texting); context carries across | D |
| INV-G11 | Specialist/enterprise agents with own identity, credentials, access | D |
| INV-G12 | Notes-to-self and memory between sessions; user controls | D |
| INV-G13 | Activity view incl. background work; redirect | D, G |
| INV-G14 | Pause/stop work; monitoring can pause for safety | D |

## H. Computer & browser automation

| ID | Capability | Source |
| --- | --- | --- |
| INV-H01 | Agent controls a browser (navigate, read DOM, click, type, fill) | C, G, X, D |
| INV-H02 | Agent controls apps via visual interface (computer use) | G, X, C |
| INV-H03 | Domain allow/block lists; per-site approvals | C, G |
| INV-H04 | Safety classifiers for write actions on external pages | C |
| INV-H05 | Screenshots / visual state capture | C, X |
| INV-H06 | Separate clean browser profile vs user's logged-in profile | C |
| INV-H07 | Chrome/Edge/Brave/Opera/Vivaldi extension support | G |
| INV-H08 | Local dev server management (start/stop/stop-all) | C |

## I. Permissions, security, privacy

| ID | Capability | Source |
| --- | --- | --- |
| INV-I01 | Per-tool allow/ask/deny; per-folder session modes | C, D |
| INV-I02 | OS keychain for credentials; secrets never shown to model | D, all |
| INV-I03 | Egress control / network allowlists for agents | C, D |
| INV-I04 | Prompt-injection defense (taint tracking, instruction separation) | D, all |
| INV-I05 | Audit log of every action with inputs/outputs | D |
| INV-I06 | Data controls: training opt-outs, retention, delete/export | D, G |
| INV-I07 | Workspace/admin policy overrides (managed settings) | C, D |
| INV-I08 | Sandboxing of execution environments | C |

## J. Sync, cloud, channels, multi-device

| ID | Capability | Source |
| --- | --- | --- |
| INV-J01 | Cloud execution environments (reusable per repo) | C, X, D |
| INV-J02 | Cross-device continuity (desktop/web/mobile) | G, D |
| INV-J03 | Message the agent from Slack/Teams; context shared | D |
| INV-J04 | Mobile dispatch of tasks (send from phone) | C, X |
| INV-J05 | Push notifications and deep links to a task | D |
| INV-J06 | Offline queue and graceful degradation | (derived) |
| INV-J07 | Opt-in E2E-encrypted sync (derived requirement) | (derived) |

## K. Account, profile, usage

| ID | Capability | Source |
| --- | --- | --- |
| INV-K01 | Profile with avatar/name/username; profile card sharing | G, X |
| INV-K02 | Usage insights: tokens, peak, streaks, longest task | G, X |
| INV-K03 | Plan/entitlement awareness; feature gating | G, X |
| INV-K04 | Invites/referrals | X |
| INV-K05 | Multiple accounts / providers, switch profile | (derived) |

## L. Accessibility, i18n, quality

| ID | Capability | Source |
| --- | --- | --- |
| INV-L01 | Full keyboard navigation, focus management, screen reader labels | (derived, best practice) |
| INV-L02 | High-contrast and reduced-motion support | (derived) |
| INV-L03 | Localization-ready strings; RTL layout support | (derived) |
| INV-L04 | Crash reporting (opt-in), error surfaces, troubleshooting page | G, X |
| INV-L05 | Diagnostics/health view for provider, MCP, and sandbox status | (derived) |

---

## Vendor-neutral synthesis

The four products share a common spine that becomes Unison's core:

1. **A conversation engine** with streaming, tools, and artifacts.
2. **A context layer** (projects, memory, files, connectors).
3. **A tool/agent runtime** that can run once (Work), continuously (Dots), or on code (Code).
4. **A policy/permission layer** governing every action.
5. **A computer/browser substrate** for autonomous work.
6. **A shell** that makes it all fast, themable, and keyboard-driven.

All `FR-*` requirements in the next document trace back to items above.
