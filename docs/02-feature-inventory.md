# 02 — Feature Inventory

This inventory captures the target functional surface, translated into vendor-neutral
capability statements. Each item is a candidate requirement refined in
`docs/03-functional-requirements.md`.

Legend: `[C]`, `[G]`, `[X]`, `[D]` are opaque codes for four external reference
applications analyzed for this spec. Their identities are tracked in the private evidence
ledger and are intentionally not named here. Rows added by the Phase 0 reconciliation cite
their source as `R: <table> #<row>`, pointing to a row of
[`docs/external/RECONCILIATION.md`](external/RECONCILIATION.md), where the table is `APP-1`…`APP-4`
(opaque IDs, `docs/19` §1.3) or `AMB` (the ambient-capture findings). Each reconciliation row
names the `FR-*` it maps to.

---

## A. Application shell & navigation

| ID | Capability | Source |
| --- | --- | --- |
| INV-A01 | Tabbed top-level modes (Chat / Work-Work / Code) within one window | C, G |
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
| INV-A16 | One thread status vocabulary (Running / Needs input / Ready / Blocked) across sidebar, tray and notifications (FR-215) | R: APP-1 #10 |
| INV-A17 | Global shortcut that attaches the frontmost window (screenshot + accessibility text) to a chat (FR-214) | R: APP-1 #9; APP-2 #24 |

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
| INV-B16 | Dictation into the composer, local by default, audio not stored (FR-216) | R: APP-1 #11; APP-2 #24 |
| INV-B17 | Simple model preset control from Faster to Smarter with an advanced panel (FR-221) | R: APP-1 #21 |
| INV-B18 | A chat request that needs multi-step work becomes an inline Work run (FR-186) | R: APP-2 #7 |
| INV-B19 | Background memory consolidation into a categorized, steerable summary (FR-204) | R: APP-1 #6; APP-3 #22 |
| INV-B20 | "Reference past chats" toggle separate from saved memories (FR-205) | R: APP-1 #5 |
| INV-B21 | Shared threads for several users of one Hub, personal memory excluded (FR-217) | R: APP-1 #20 |
| INV-B22 | Voice that starts, checks and steers runs; one voice session at a time (FR-031) | R: APP-1 #11 |

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
| INV-C09 | Project-only memory scope, forced for shared projects (FR-205) | R: APP-1 #7 |
| INV-C10 | Document outputs: generate and read DOCX, PPTX, XLSX, PDF with previews (FR-219) | R: APP-2 #27 |

## D. Tools, MCP, plugins, skills

| ID | Capability | Source |
| --- | --- | --- |
| INV-D01 | MCP client: register/launch local + remote MCP servers; tools/resources/prompts | all |
| INV-D02 | MCP server: expose Nova capabilities to external agents | C |
| INV-D03 | Plugins bundling skills + MCP servers + optional UI; marketplace install | all |
| INV-D04 | Skills: reusable instruction bundles, slash-invoked or auto-selected | C, G |
| INV-D05 | Connectors: OAuth/API-key integrations (GitHub, Slack, Linear, Google, …) | C, G |
| INV-D06 | Per-tool and per-plugin permission controls | C, G, D |
| INV-D07 | "Sign in with" delegation so external apps can use the user's plan | G |
| INV-D08 | Plugin browser in CLI and GUI; install/update/uninstall | G, X |
| INV-D09 | Skill authoring from conversation ("build a plugin") | G, X |
| INV-D10 | Desktop-only plugins gated by app capability flags | G |
| INV-D11 | Lifecycle hooks trusted by content hash, tighten-only (FR-197) | R: APP-1 #12; APP-3 #21 |
| INV-D12 | Plugin and MCP-server UI via the open MCP Apps standard (FR-198) | R: APP-1 #13; APP-2 #28 |
| INV-D13 | MCP bundles: one server per zip with typed config and declared permissions (FR-199) | R: APP-2 #29 |
| INV-D14 | MCP event subscriptions as triggers (FR-201) | R: APP-1 #14 |
| INV-D15 | Deferred tools with tool search for large catalogs (FR-196) | R: APP-3 #9 |
| INV-D16 | Import instructions, skills, plugins, MCP servers, projects, memories and chats from other assistants (FR-200) | R: APP-1 #1; APP-3 #24 |
| INV-D17 | Skills as folders with `SKILL.md`; catalog-only injection (FR-046) | R: APP-3 #19 |
| INV-D18 | Scripted tool calls in an isolated engine, every nested call policy-checked (FR-202) | R: APP-3 #8 |
| INV-D19 | External coding agents through a policy-routed adapter (FR-203) | R: AMB #31 |
| INV-D20 | Scoped, revocable Hub API access for third-party apps (FR-222) | R: APP-1 #23 |

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
| INV-E09 | Delegation between the work runtime and the coding agent, in both directions | G, D, X |
| INV-E10 | Notifications routing (chat, OS, channel) based on rules | G, D |
| INV-E11 | Goals with statuses and optional budgets; idle continuation (FR-181) | R: APP-3 #23; APP-1 #19 |
| INV-E12 | Runs bounded by time, token and cost budgets instead of a step cap (FR-182) | R: APP-3 #6; APP-4 #6 |
| INV-E13 | Deep research run with sub-agents and a cited report (FR-220) | R: APP-1 #20 |
| INV-E14 | Jobs succeed only when their output is verified (FR-187) | R: AMB #16 |
| INV-E15 | RRULE schedules and one catch-up run for missed fires (FR-055) | R: APP-2 #19; APP-3 #26 |
| INV-E16 | Approvals and questions answerable from any connected client (FR-188) | R: APP-3 #3 |
| INV-E17 | Context compaction before, during and after a turn (FR-183) | R: APP-3 #7 |
| INV-E18 | Interactive exec sessions with yield time and stdin (FR-184) | R: APP-3 #9 |

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
| INV-F19 | Best-of-N attempts in separate worktrees (FR-212) | R: APP-3 #26 |
| INV-F20 | Hand a session to another device with its Git state (FR-213) | R: APP-1 #4; APP-2 #16 |
| INV-F21 | Worktree include files and leases; hook-free app Git operations (FR-073, FR-211) | R: APP-2 #16 |
| INV-F22 | Instruction-file discovery from root to cwd within a budget (FR-185) | R: APP-3 #18 |
| INV-F23 | Any device running `novad` as an environment, including over SSH (FR-062) | R: APP-2 #15 |

## G. Always-on agents

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
| INV-G10 | Channels: in-app, Slack, Teams, (texting); context carries across | D |
| INV-G11 | Specialist/enterprise agents with own identity, credentials, access | D |
| INV-G12 | Notes-to-self and memory between sessions; user controls | D |
| INV-G13 | Activity view incl. background work; redirect | D, G |
| INV-G14 | Pause/stop work; monitoring can pause for safety | D |
| INV-G15 | Agents schedule their own next wake-up, visibly and within bounds (FR-206) | R: APP-4 #7 |
| INV-G16 | Per-channel threads with shared agent memory (FR-088) | R: APP-4 #9 |
| INV-G17 | Voice-call channel to an agent (FR-218) | R: APP-4 #11 |
| INV-G18 | Local browser fallback on the connected computer (FR-209) | R: APP-4 #3 |
| INV-G19 | Idle-driven read-only proactive research (FR-082) | R: APP-4 #8 |

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
| INV-H09 | Computer-use control tiers per app class, per-app grants with TTL, kill key (FR-207) | R: APP-2 #20; APP-2 #18 |
| INV-H10 | Page-registered tools, top frame only, policy-gated (FR-208) | R: APP-1 #16 |
| INV-H11 | Skill proposals from a recorded demonstration (FR-226) | R: APP-1 #17; APP-2 #21 |
| INV-H12 | Per-site levels (Always ask / Auto approve / Always allow) and per-host extension grants (FR-094, FR-096) | R: APP-1 #15 |

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
| INV-I09 | Confirmation tiers and intent provenance (FR-189) | R: APP-1 #18 |
| INV-I10 | Permission profiles and protected paths (FR-190) | R: APP-3 #13; APP-2 #11 |
| INV-I11 | Command prefix rules with load-time examples (FR-191) | R: APP-3 #15 |
| INV-I12 | Expanded approval decisions (FR-100) | R: APP-3 #14 |
| INV-I13 | Fail-closed model auto-reviewer that only tightens (FR-085) | R: APP-3 #17; APP-4 #14 |
| INV-I14 | Egress proxy modes and credential injection at the proxy (FR-193) | R: APP-2 #12; APP-3 #16 |
| INV-I15 | Windows sandbox with restricted tokens and capability SIDs (FR-107) | R: APP-3 #11; APP-3 #12 |
| INV-I16 | Optional per-session micro-VM substrate (FR-195) | R: APP-2 #10 |
| INV-I17 | Listener and integration hygiene: tokens everywhere, no writes into other apps (FR-192) | R: APP-3 #2; AMB #27; AMB #33 |
| INV-I18 | External-agent rule (FR-194) | R: APP-4 #14 |
| INV-I19 | Persistence safety evals and reviewer metrics (FR-224) | R: APP-4 #16; APP-4 #17; APP-4 #18 |
| INV-I20 | Managed policy from OS-protected channels (FR-106) | R: APP-2 #32 |
| INV-I21 | Opt-in OTLP export to the user's collector (FR-223) | R: APP-2 #3 |

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
| INV-J08 | Relay framing: streams, sequences, segmenting, acks, pairing, revoke, inside E2E envelopes (FR-137) | R: APP-3 #5 |
| INV-J09 | Device operations through `novad`: staged writes, folder-access requests, local MCP pass-through (FR-210) | R: APP-2 #9 |

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
| INV-L06 | Install robustness: explicit data directories, port-conflict fallback, download verification (FR-225) | R: APP-2 #35; AMB #26; APP-4 #20 |
| INV-L07 | Optional MSIX packaging and a stated update-check cadence (`docs/15`) | R: APP-2 #4; APP-2 #5 |

## M. Ambient capture (track N1)

| ID | Capability | Source |
| --- | --- | --- |
| INV-M01 | Event-driven, accessibility-first, text-first screen capture (FR-151, FR-152) | R: AMB #1; AMB #2 |
| INV-M02 | Redaction release gate before any read (FR-227) | R: AMB #7; AMB #36 |
| INV-M03 | Capture split: networkless helper on the device, recall on the Hub (FR-228) | R: AMB owner context |
| INV-M04 | Model-free activity summary (FR-229) | R: AMB #13 |
| INV-M05 | Meeting detection by microphone holder (FR-230) | R: AMB #10 |
| INV-M06 | Speaker identity across meetings with abstention (FR-231) | R: AMB #9 |
| INV-M07 | Capture provenance checks on replies and tool calls (FR-232) | R: AMB owner context |
| INV-M08 | Hub-enforced scoped grants for readers of ambient data (FR-233) | R: AMB #16 |

---

## Vendor-neutral synthesis

The reference products share a common spine that becomes Nova's core:

1. **A conversation engine** with streaming, tools, and artifacts.
2. **A context layer** (projects, memory, files, connectors).
3. **A tool/agent runtime** that can run once (Work), continuously (Agents), or on code (Code).
4. **A policy/permission layer** governing every action.
5. **A computer/browser substrate** for autonomous work.
6. **A shell** that makes it all fast, themable, and keyboard-driven.

All `FR-*` requirements in the next document trace back to items above.
