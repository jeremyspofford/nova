# 03 — Functional Requirements

Every requirement has an ID, priority (**P0** = v1 must-have, **P1** = v1 important,
**P2** = post-v1), a milestone (**M0–M10**, see `docs/17`), and a trace to the inventory in
`docs/02-feature-inventory.md`. Acceptance statements are testable and are the basis for
tests in `docs/16`.

---

## A. Application shell & navigation

| ID | Pri | Ms | Requirement / Acceptance |
| --- | --- | --- | --- |
| FR-001 | P0 | M1 | The app opens to a single window with a persistent left sidebar and a main content area. A11y: sidebar is keyboard navigable. |
| FR-002 | P0 | M1 | Top-level modes **Chat**, **Work**, **Code**, **Agents** are switchable via sidebar and `Ctrl/Cmd+1..4`. Switching preserves per-mode state. |
| FR-003 | P0 | M1 | A command palette (`Ctrl/Cmd+K` and `Ctrl/Cmd+Shift+P`) lists all registered commands; fuzzy search; shows shortcuts; executes on Enter. |
| FR-004 | P0 | M1 | A global shortcut registry supports defaults and user remapping, persisted per OS, with keystroke-based lookup. |
| FR-005 | P1 | M4 | The workspace supports multi-pane layouts (chat, diff, browser, terminal, editor, preview) that can be resized, reordered, maximized, and reset. |
| FR-006 | P1 | M4 | Code mode has a collapsible bottom panel and integrated terminal (`Ctrl/Cmd+J`, `` Ctrl+` ``). |
| FR-007 | P1 | M2 | Deep links `nova://settings`, `nova://chat/<id>`, `nova://code/<id>`, `nova://agent/<id>` open the app and route correctly on all platforms. |
| FR-008 | P2 | M7 | System tray/menu-bar icon with quick chat, new task, and quit. Global hotkey opens/focuses the app. |
| FR-009 | P2 | M7 | Multiple windows are supported; any thread/panel can be detached. |
| FR-010 | P0 | M1 | Appearance settings: base theme (light/dark/system), accent, background, foreground, UI font, code font, font size. Persisted and applied live. |
| FR-011 | P1 | M4 | Themes can be exported/imported as JSON and shared via a `nova://theme?data=` link. |
| FR-012 | P2 | M6 | Optional animated companions ("pets") can be enabled/disabled and themed; they never block input and respect reduced-motion. |
| FR-013 | P0 | M3 | Notification center for run completion, approvals, and attention; per-category toggles and OS notification permission handling. |
| FR-014 | P0 | M1 | First-run onboarding: choose provider(s), connect auth, set name/avatar, optionally connect a tool, run a sample task. Skippable, resumable. |
| FR-015 | P0 | M1 | Accessibility baseline: all interactive elements reachable by keyboard, visible focus rings, ARIA labels, `prefers-reduced-motion` honored, WCAG 2.2 AA contrast. |
| FR-016 | P1 | M8 | UI strings are externalized for localization; layout supports RTL. |

## B. Conversation (Chat mode)

| ID | Pri | Ms | Requirement / Acceptance |
| --- | --- | --- | --- |
| FR-017 | P0 | M1 | Create, rename, pin, archive, delete, and search chats. New chat shortcut works. |
| FR-018 | P0 | M1 | Responses stream token-by-token; a Stop control cancels; partial output is retained and marked incomplete. |
| FR-019 | P0 | M2 | Sending a message while a run is active either steers the current run or queues for the next, per a setting. Steering is applied at the next safe step. |
| FR-020 | P0 | M2 | Message actions: edit, regenerate, copy, branch-from-here, quote, and delete. Editing forks history without mutating prior turns. |
| FR-021 | P0 | M2 | Attachments: images, PDF, plain text, Markdown, JSON, code files; drag-drop and paste; size/type limits enforced with clear errors. |
| FR-022 | P1 | M3 | `@`-mentions resolve files, folders, connectors, and skills into context items; mention chips are removable. |
| FR-023 | P0 | M2 | Inline model picker lists configured models; model can change mid-thread; each assistant turn stores the model + reasoning level used. |
| FR-024 | P0 | M2 | A reasoning-level selector (`off`…`max`) is available for models that support it and is persisted per thread. |
| FR-025 | P1 | M2 | Find-in-chat with next/previous; cross-chat full-text search returns snippets and jumps to the match. |
| FR-026 | P1 | M3 | Side chat: ask a question using the current context without adding turns to the main thread. |
| FR-027 | P1 | M3 | Temporary chats are excluded from memory, search, and sync; visually marked; deleted on close or after TTL. |
| FR-028 | P2 | M4 | Suggested follow-up prompts appear in an empty composer; Tab/Right accepts; suggestions can be disabled. |
| FR-029 | P0 | M3 | Web search tool returns answers with inline citations linking to sources; citations are stored with the turn. |
| FR-030 | P1 | M5 | Image generation/editing from the composer; generated images are saved as artifacts with metadata. |
| FR-031 | P1 | M5 | Realtime voice conversation in any mode: push-to-talk and hands-free, streaming transcription, barge-in, and voice selection. |
| FR-032 | P0 | M3 | Memory: the app extracts durable facts, shows them in a reviewable list, allows edit/delete/pin, supports per-chat opt-out, and can import from a provided export. |
| FR-033 | P1 | M3 | Branch visualization for forked threads (parent/child tree) with side-by-side compare. |

## C. Projects, Space & Library

| ID | Pri | Ms | Requirement / Acceptance |
| --- | --- | --- | --- |
| FR-034 | P0 | M2 | Projects group chats + sources + instructions; instructions apply to every chat in the project. |
| FR-035 | P1 | M4 | Local projects bind to one or more on-disk folders; the app indexes them and exposes files as tools/sources. |
| FR-036 | P2 | M6 | Space: pages that the user and agent co-edit, with version history and comments. |
| FR-037 | P2 | M6 | Sites: generate, preview, connect data, publish to a chosen target, and manage versions. Publishing is explicit and reversible. |
| FR-038 | P0 | M3 | Artifacts: structured outputs render in a dedicated pane (Markdown, code with syntax highlight, HTML sandbox, images, charts, PDF). Live-updating artifacts re-render on change. |
| FR-039 | P1 | M4 | File browser + editor + preview for local files with save/undo; binary types open in an appropriate viewer. |
| FR-040 | P1 | M3 | Sources can be uploaded, connected, re-indexed, and removed; indexing status is visible. |
| FR-041 | P1 | M4 | Library view aggregates artifacts, files, images, and generated outputs across the account with filters and search. |

## D. Tools, MCP, plugins, skills

| ID | Pri | Ms | Requirement / Acceptance |
| --- | --- | --- | --- |
| FR-042 | P0 | M3 | MCP client: add/remove/enable MCP servers (stdio, SSE, streamable HTTP); list tools/resources/prompts; invoke with timeout, cancellation, and error surfacing. |
| FR-043 | P0 | M3 | MCP server health: connection status, restart, logs, and per-server enable toggle in a diagnostics view. |
| FR-044 | P1 | M4 | Nova exposes its own MCP server so external agents can read projects/threads and run allowed tools, gated by explicit user consent. |
| FR-045 | P0 | M4 | Plugins bundle skills + MCP servers + optional declarative UI; install from marketplace or local path; version + update + uninstall. |
| FR-046 | P0 | M4 | Skills are reusable instruction bundles with optional scripts/templates; invocable via slash command and auto-selectable by the model. |
| FR-047 | P1 | M4 | Connectors authenticate via OAuth2/PKCE or API key, store tokens in the keychain, refresh automatically, and expose revoke. |
| FR-048 | P0 | M3 | Per-tool permission defaults (allow/ask/deny) are configurable; per-plugin overrides take precedence; effective policy is previewable. |
| FR-049 | P2 | M6 | Marketplace: browse, search, install, and rate plugins/skills/themes; supports a local/offline catalog and a remote catalog with signature verification. |
| FR-050 | P1 | M5 | "Build a plugin/skill" flow: from a conversation, generate a manifest + files, validate, and install locally. |

## E. Work mode (delegated agentic tasks)

| ID | Pri | Ms | Requirement / Acceptance |
| --- | --- | --- | --- |
| FR-051 | P0 | M5 | A Work run accepts a task, produces a visible plan, executes tool calls, and reports a structured result (summary + artifacts + evidence). |
| FR-052 | P0 | M5 | Runs continue when the app window is closed (if configured) and resume after restart; state persists in the DB. |
| FR-053 | P0 | M5 | Background sub-agents run concurrently up to a configurable limit; the coordinator aggregates and reports. |
| FR-054 | P1 | M5 | Child threads for parallel work appear in the sidebar; the user can open, steer, or cancel each. |
| FR-055 | P0 | M5 | Scheduled tasks: cron/interval with timezone + optional end date; specify what to check/update, notification conditions, and delivery target; list/edit/cancel. |
| FR-056 | P1 | M6 | Event triggers: watch a connected resource (Slack channel, webhook, file change, email label) and start a run on matching events with dedupe. |
| FR-057 | P0 | M5 | Activity view per run: ordered steps, tool calls with inputs/outputs, file diffs, approvals, and final result; replayable. |
| FR-058 | P0 | M5 | Approvals: gated actions present a clear request (what/who/why/scope) with Allow once / Always allow / Deny / Hand off. |
| FR-059 | P1 | M6 | Delegation to Code mode: a Work run can open a code session with repo context; results flow back. |
| FR-060 | P1 | M6 | Notification routing rules: choose which events notify on OS, in-app, or a channel; quiet hours. |

## F. Code mode (software engineering agent)

| ID | Pri | Ms | Requirement / Acceptance |
| --- | --- | --- | --- |
| FR-061 | P0 | M5 | A Code session binds to an environment + folder/repo + model + permission mode; sessions run in parallel and are independently listed. |
| FR-062 | P1 | M6 | Environments: **Local**, **Cloud**, **SSH**, **WSL**; each is configurable, health-checked, and selectable per session. |
| FR-063 | P0 | M5 | Permission modes: **Manual**, **Accept edits**, **Plan**, **Auto**, **Bypass**; selectable mid-session; mode is remembered per folder; Plan is per-session. Managed policy can restrict modes. |
| FR-064 | P0 | M5 | Agent can read/search files, apply edits, create/delete files, and run commands. Every file change is captured as a diff. |
| FR-065 | P0 | M5 | Diff viewer: per-file list, unified/split view, per-line comments, accept/reject individual hunks, apply all. |
| FR-066 | P0 | M5 | Integrated terminal runs commands in the session environment with streamed output; user commands and agent commands are visually distinguished. |
| FR-067 | P1 | M6 | Browser pane runs local dev servers, previews the app, and lets the agent verify changes (screenshot, DOM inspect, click, fill). Dev servers can be started/stopped/stopped-all. |
| FR-068 | P1 | M6 | Auto-verify: after edits, the agent runs configured checks (build/test) and reports pass/fail with logs; configurable per project. |
| FR-069 | P0 | M6 | Code review: `/review` produces findings grouped by file with severity, suggested fixes, and "apply" actions. |
| FR-070 | P1 | M6 | Create commits/branches and open PRs via a connected Git host; show CI status and update on completion. |
| FR-071 | P2 | M7 | Cloud code environments support multiple repositories and reusable setup scripts; cloud runs continue when the laptop is offline. |
| FR-072 | P1 | M6 | Agent can inspect and manage other sessions (list, message, archive) and answer side questions using session context. |
| FR-073 | P1 | M6 | Parallel agents: run independent tasks in separate git worktrees and merge results safely, surfacing conflicts. |
| FR-074 | P1 | M5 | Repository indexing: symbols, references, and semantic search; incremental on file change. |
| FR-075 | P2 | M6 | Appshots: capture an application window/state as an artifact for debugging. |
| FR-076 | P2 | M6 | Visualizations: render interactive explanations (charts, diagrams, notebooks) as artifacts. |
| FR-077 | P2 | M7 | Mobile dispatch: start or approve a code task from a phone via the relay, then review on desktop. |
| FR-078 | P1 | M6 | SSH sessions keep running while the app is disconnected, subject to credential validity; reattach shows buffered output. |

## G. Agents (always-on agents)

| ID | Pri | Ms | Requirement / Acceptance |
| --- | --- | --- | --- |
| FR-079 | P0 | M6 | Create a Agent with name, avatar, instructions, and one or more responsibilities; edit later. Multiple responsibilities are tracked separately. |
| FR-080 | P0 | M6 | A Agent has a persistent cloud computer (files, installed software, browser sessions) that survives restarts of the app. |
| FR-081 | P1 | M6 | The user can connect their own computer (one at a time) to give the Agent access to local files/code/apps; connection is explicit and revocable. |
| FR-082 | P0 | M6 | Proactive research: using only read-only tools, the Agent surfaces helpful findings; any resulting action goes through policy. |
| FR-083 | P0 | M6 | Background agents + cloud threads: a Agent can fan out work and keep conversing; threads appear in the sidebar. |
| FR-084 | P0 | M6 | Custom rules with scopes: *take action without asking*, *take action when you say so*, *ask before taking action*, *hand off to you*. Rules are editable/deletable and previewable. |
| FR-085 | P0 | M6 | Auto-review evaluates each consequential action against instructions, rules, and safety, deciding proceed / ask / hand-off. Sensitive actions always hand off. |
| FR-086 | P1 | M6 | Private sign-in: a secure form (never into model context) collects credentials for a site; optional "save to passwords"; sessions vs saved logins are distinct. |
| FR-087 | P0 | M6 | Inspect the Agent's computer; take over keyboard/mouse; return control. Takeover is logged. |
| FR-088 | P1 | M6 | Channels: message a Agent from in-app, Slack, and Teams (and webhooks/email); conversation context is shared across channels. |
| FR-089 | P1 | M6 | Agent memory: durable notes plus conversation memory, both user-visible and editable; user can forget items. |
| FR-090 | P0 | M6 | Activity view for a Agent, including background work; user can redirect or stop work at any time; safety monitoring can auto-pause. |
| FR-091 | P2 | M7 | Specialist/team agents: an admin can provision an agent with its own identity and scoped credentials and assign responsibilities. |

## H. Computer & browser automation

| ID | Pri | Ms | Requirement / Acceptance |
| --- | --- | --- | --- |
| FR-092 | P0 | M6 | Browser tool: navigate, read DOM/text, click, type, scroll, wait, screenshot, download/upload; returns structured results to the agent. |
| FR-093 | P0 | M6 | Computer-use tool: observe screen, move/click/type, and read windows on a controlled desktop; requires explicit enablement. |
| FR-094 | P0 | M6 | Domain allowlist/blocklist and per-site approvals; actions on new sites prompt with Allow once / Always allow / Deny. |
| FR-095 | P1 | M6 | Safety classifier reviews write actions on external pages in every mode; flagged actions always prompt. |
| FR-096 | P1 | M6 | Browser profiles: a clean agent profile separate from the user's; optional extension bridge for the user's logged-in sessions with explicit consent. |
| FR-097 | P1 | M6 | Local dev server manager: detect, start, stop, and stop-all; expose URLs to the browser pane. |
| FR-098 | P0 | M6 | Every browser/computer action is recorded in the Activity trace with before/after screenshots. |

## I. Permissions, security, privacy

| ID | Pri | Ms | Requirement / Acceptance |
| --- | --- | --- | --- |
| FR-099 | P0 | M3 | Central Policy Engine evaluates every tool call against: built-in safety, workspace policy, custom rules, per-tool defaults, and scope → returns allow / ask / handoff / deny with a reason. |
| FR-100 | P0 | M3 | Approvals are presented consistently (card + notification) and support Allow once / Always (scoped) / Deny / Hand off; decisions are remembered per scope. |
| FR-101 | P0 | M3 | Secrets are stored in the OS keychain (or encrypted vault fallback); secrets are redacted from logs, traces, and model context; a secret-scanning check runs in CI. |
| FR-102 | P0 | M6 | Egress control: agents can only reach approved network destinations (configurable per mode/tool); all other egress is blocked and logged. |
| FR-103 | P0 | M6 | Prompt-injection defense: tool outputs are labeled untrusted; the policy engine treats tool-originated instructions as data, never as user authority; suspicious content is quarantined. |
| FR-104 | P0 | M5 | Audit log: append-only record of actions (actor, tool, inputs hash, decision, result, timestamp) exportable as JSONL. |
| FR-105 | P1 | M8 | Data controls: telemetry off by default; training opt-out is always on (we never train); per-item retention settings; export/delete-all with confirmation. |
| FR-106 | P1 | M8 | Managed settings: an admin policy file can restrict permission modes, disable tools/plugins, set egress allowlists, and lock appearance. |
| FR-107 | P0 | M6 | Execution sandboxes: local agent runs use an OS sandbox (Linux bubblewrap/container, macOS seatbelt, Windows AppContainer) with filesystem/network scoping. |

## J. Sync, cloud, channels, multi-device

| ID | Pri | Ms | Requirement / Acceptance |
| --- | --- | --- | --- |
| FR-108 | P1 | M7 | Cloud runner: submit a task that executes on a managed environment and returns artifacts; user can watch live and cancel. |
| FR-109 | P1 | M7 | Optional sync: end-to-end encrypted replication of threads/projects/settings across the user's devices; conflict resolution is last-writer-wins per field with a merge log. |
| FR-110 | P1 | M7 | Channel bridge: Slack/Teams/Telegram/email/webhook adapters map messages to threads and approvals, preserving context. |
| FR-111 | P2 | M7 | Mobile dispatch via relay: send a task and receive approvals/notifications; deep links open the desktop app or a web view. |
| FR-112 | P1 | M7 | Offline behavior: local features work offline; outbound operations queue with visible status and retry with backoff. |

## K. Account, profile, usage

| ID | Pri | Ms | Requirement / Acceptance |
| --- | --- | --- | --- |
| FR-113 | P1 | M4 | Profile: display name, username, avatar, optional public profile card; local account by default; optional OIDC sign-in. |
| FR-114 | P1 | M4 | Usage insights: tokens by provider/model, cost estimate, active days/streak, longest task, per-project breakdown; local-only. |
| FR-115 | P0 | M4 | Multiple provider accounts supported; a single active account per provider with quick switching; entitlements/limits surfaced. |
| FR-116 | P2 | M8 | Spend caps and warnings per provider; hard stop when cap reached (configurable). |

## L. Extensibility, diagnostics, quality

| ID | Pri | Ms | Requirement / Acceptance |
| --- | --- | --- | --- |
| FR-117 | P1 | M8 | Extension SDK: typed API for commands, panels, tools, theme tokens, and event hooks; loaded in a sandbox with declared permissions. |
| FR-118 | P0 | M3 | Structured logging with levels and a viewer; redaction enforced; log export for bug reports. |
| FR-119 | P1 | M5 | Diagnostics page: provider connectivity, MCP servers, sandboxes, storage, and update status, each with a "test" action. |
| FR-120 | P0 | M10 | Auto-update with channels (stable/beta) and rollback; update signature verified. |
| FR-121 | P1 | M8 | Crash reporting (opt-in) with local crash dumps and a privacy-preserving report preview. |
| FR-122 | P0 | M9 | Performance budgets enforced in CI per `AGENTS.md` §9. |
| FR-123 | P0 | M9 | Security test suite: policy bypass attempts, secret leakage, injection payloads, sandbox escape — all must fail safely. |

## M. Hub, devices & networking

| ID | Pri | Ms | Requirement / Acceptance |
| --- | --- | --- | --- |
| FR-124 | P0 | M0 | A **Hub** service is the canonical store and runtime host: it holds the database, runs the agent runtime/scheduler/policy, and serves the web UI. It runs on the supported minimum hardware (N100/N150-class, 8–16 GB). |
| FR-125 | P0 | M1 | **Clients are thin**: the Hub serves the UI over HTTPS to authenticated devices; native shells wrap the same UI and add local capabilities. No client holds canonical state. |
| FR-126 | P0 | M2 | **Compute nodes** register a signed capability document and accept only Hub-authorized work; they never initiate connections to clients. |
| FR-127 | P0 | M2 | **Routing** selects a node by the default order: same device/LAN → required model+capability → least-loaded → lowest cost/energy → cloud (only if allowed). Order is configurable. |
| FR-128 | P1 | M7 | **Local fallback**: when the Hub is unreachable, a capable device runs local models/agents via `novad` and queues actions; it never silently drops work. |
| FR-129 | P1 | M7 | **Capability-gated offline replica**: a client keeps an encrypted local replica only if the Hub grants that capability to that device. |
| FR-130 | P2 | post-v1 | **Hub failover**: another candidate node can take over as Hub with lease-based leadership and client redirection. Deferred until after v1. |
| FR-131 | P0 | M5 | Nova is **reactive** (responds to requests and events) **and proactive** (schedules, watches, and initiates) subject to policy and approvals. |
| FR-132 | P0 | M6.5 | **Add a Device** via QR code or short code, with per-device bootstrap (PWA / native shell / headless command) and a required Hub-side approval. |
| FR-133 | P0 | M6.5 | The Hub serves **signed** `novad` builds and a one-line bootstrap command; installs verify signature, checksum, and Hub identity. |
| FR-134 | P0 | M6.5 | **Trust paths** selectable in Hub settings: Core-generated local CA, Lattice certificates, or native-shell pinning. |
| FR-135 | P0 | M6.5 | **Pluggable transports** (LAN, Lattice, Relay, optional direct public) with ordered fallback and per-endpoint health checks. |
| FR-136 | P0 | M6.5 | **Network Setup assistant** detects state and can install/configure a Lattice (Headscale/Tailscale/NetBird/WireGuard), tags/ACLs, MagicDNS, subnet routes, certs, and firewall — with one-time consent, reachability tests, and rollback. |
| FR-137 | P0 | M7 | **Relay**: content-blind, end-to-end-encrypted forwarding; self-hostable; provides off-LAN reach and push (APNs/FCM); per-platform reachability strategy. |
| FR-138 | P1 | M6.5 | **Wake Helper** role: an always-on LAN device may send WoL magic packets for wakeable devices; wakes are rate-limited and audited. |
| FR-139 | P0 | M6.5 | **Network diagnostics** panel with active transports, latency, certificate status, ACL summary, Relay status, per-device reachability, and one-click rollback. |
| FR-140 | P0 | M6.5 | **Device management** UI: list devices and compute nodes, show capabilities/health/reachability, edit scopes, wake, and revoke. |

## N. Device agent & firmware

| ID | Pri | Ms | Requirement / Acceptance |
| --- | --- | --- | --- |
| FR-141 | P0 | M6 | **`novad` supervisor + modules**: a small elevated supervisor spawns signed, sandboxed, independently updatable modules (management/compute/browser/screen/storage). Installs as a system service. |
| FR-142 | P0 | M6 | **Capability declaration** with defaults + Advanced overrides (model storage paths, GPU sharing, VRAM reserve, concurrency limits, quiet hours, routing weight, egress limits). |
| FR-143 | P1 | M7.5 | **Low-level boot** (PXE/iPXE, bootloader entries) is opt-in; boot profiles use a watchdog that reverts on failed boot. |
| FR-144 | P0 | M6 | **Power & WoL**: report wakeability, enable WoL where supported, and support power-on-after-power-loss. |
| FR-145 | P0 | M6 | **Service management**: start/stop/restart compute and other managed services on a device. |
| FR-146 | P1 | M7.5 | **BIOS/firmware management** (allowlisted settings, dry-run diff, snapshot, explicit approval, rollback, audit). Global toggle **off by default**; never proactive. |
| FR-147 | P2 | M7.5 | **Out-of-band management** (IPMI/Redfish/Intel AMT/vPro) for power/settings without an OS. Off by default; admin-only; credentials in the keychain. |
| FR-148 | P0 | M6 | **`novad` updates**: signed bundles, staged, health-checked, with automatic rollback; channels stable/beta/nightly. |
| FR-149 | P0 | M3 | **Hub trusted, external paths E2E**: data encrypted at rest on the Hub, TLS in transit, and end-to-end encryption for everything leaving the Hub (Relay, cloud, device sync). Optional sealed mode keeps keys in the OS secure enclave. |
| FR-150 | P1 | M6 | **Per-device policy overrides** for routing eligibility, allowed modules, resource caps, and quiet hours. |

---

## Requirement traceability

- Inventory → requirements is many-to-many; each `INV-*` is covered by ≥1 `FR-*`.
- Every `FR-*` appears in exactly one milestone in `docs/17`.
- Acceptance tests for each `FR-*` are defined in `docs/16` and referenced by ID.
- The `LEDGER.md` tasks reference `FR-*` IDs directly.
