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
| FR-008 | P2 | M7 | System tray/menu-bar icon and a quick overlay with quick chat (text or voice), new task, the thread status list (FR-215), and quit. A global hotkey opens or focuses the app. |
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
| FR-019 | P0 | M2 | Sending a message while a run is active either steers the current run or queues it for the next, per a setting. Steering input is applied at the start of the next model step, never inside a running tool call; queued input survives a restart. |
| FR-020 | P0 | M2 | Message actions: edit, regenerate, copy, branch-from-here, quote, and delete. Editing forks history without mutating prior turns. |
| FR-021 | P0 | M2 | Attachments: images, PDF, plain text, Markdown, JSON, code files; drag-drop and paste; size/type limits enforced with clear errors. |
| FR-022 | P1 | M3 | `@`-mentions resolve files, folders, connectors, and skills into context items; mention chips are removable. |
| FR-023 | P0 | M2 | Inline model picker lists configured models and presets (FR-221); the model can change mid-thread; each assistant turn stores the model + reasoning level used. |
| FR-024 | P0 | M2 | A reasoning-level selector (`off`…`max`) is available for models that support it and is persisted per thread. |
| FR-025 | P1 | M2 | Find-in-chat with next/previous; cross-chat full-text search returns snippets and jumps to the match. |
| FR-026 | P1 | M2 | Side chat: ask a question using the current context without adding turns to the main thread. |
| FR-027 | P1 | M2 | Temporary chats are excluded from memory, search, and sync; visually marked; deleted on close or after TTL. |
| FR-028 | P2 | M4 | Suggested follow-up prompts appear in an empty composer; Tab/Right accepts; suggestions can be disabled. |
| FR-029 | P0 | M3 | Web search tool returns answers with inline citations linking to sources; citations are stored with the turn. |
| FR-030 | P1 | M5 | Image generation/editing from the composer; generated images are saved as artifacts with metadata. |
| FR-031 | P1 | M5 | Realtime voice in any mode: push-to-talk and hands-free, streaming transcription, barge-in and voice selection. Voice can start, check and steer runs and sessions. One voice session per user at a time. |
| FR-032 | P0 | M2 | Memory: the app extracts durable facts, shows them in a reviewable list, allows edit/delete/pin, supports per-chat opt-out, and can import from a provided export. Background consolidation per FR-204. |
| FR-033 | P1 | M2 | Branch visualization for forked threads (parent/child tree) with side-by-side compare. |

## C. Projects, Space & Library

| ID | Pri | Ms | Requirement / Acceptance |
| --- | --- | --- | --- |
| FR-034 | P0 | M2 | Projects group chats + sources + instructions; instructions apply to every chat in the project. |
| FR-035 | P1 | M4 | Local projects bind to one or more on-disk folders; the app indexes them and exposes files as tools/sources. |
| FR-036 | P2 | M6 | Space: pages that the user and agent co-edit, with version history and comments. |
| FR-037 | P2 | M6 | Sites: generate, preview, connect data, publish to a chosen target, and manage versions. Publishing is explicit and reversible. |
| FR-038 | P0 | M3 | Artifacts: structured outputs render in a dedicated pane (Markdown, code with syntax highlight, HTML sandbox, images, charts, PDF, and document previews per FR-219). Live-updating artifacts re-render on change. |
| FR-039 | P1 | M4 | File browser + editor + preview for local files with save/undo; binary types open in an appropriate viewer. |
| FR-040 | P1 | M2 | Sources can be uploaded, connected, re-indexed, and removed; indexing status is visible. |
| FR-041 | P1 | M4 | Library view aggregates artifacts, files, images, and generated outputs across the account with filters and search. |

## D. Tools, MCP, plugins, skills

| ID | Pri | Ms | Requirement / Acceptance |
| --- | --- | --- | --- |
| FR-042 | P0 | M3 | MCP client: add/remove/enable MCP servers (stdio, SSE, streamable HTTP; protocol 2025-11-25 or later, advertising the UI and event extensions when supported); list tools/resources/prompts; invoke with timeout, cancellation and error surfacing. |
| FR-043 | P0 | M3 | MCP server health: connection status, restart, logs, and per-server enable toggle in a diagnostics view. |
| FR-044 | P1 | M4 | Nova exposes its own MCP server so external agents can read projects/threads and run allowed tools, gated by explicit user consent. |
| FR-045 | P0 | M4 | Plugins bundle skills, MCP servers, lifecycle hooks (FR-197), sub-agent roles, commands and optional UI (FR-198). Permissions are declared per tool and per action. Install from a catalog, a Git-hosted catalog or a local path; version, update, uninstall. |
| FR-046 | P0 | M4 | Skills are folders containing `SKILL.md` (front-matter: `description` required; `name`, `when_to_use`, `allowed_tools`, `model_hint` optional) plus optional scripts and templates. Only a catalog (name + description) is injected, within 2 % of the context window (max 10,000 tokens); a slash command, mention or auto-selection loads the body. Name collisions resolve managed > project > user > plugin > built-in. |
| FR-047 | P1 | M4 | Connectors and remote MCP servers authenticate via OAuth2/PKCE (client metadata documents or dynamic client registration where the server offers them) or an API key, store tokens in the keychain, refresh automatically, and expose revoke. |
| FR-048 | P0 | M3 | Per-tool permission defaults (allow/ask/deny) are configurable; per-plugin overrides take precedence; effective policy is previewable. |
| FR-049 | P2 | M8 | Marketplace: browse, search, install and rate plugins/skills/themes; supports a local/offline catalog, Git-hosted catalogs and a remote catalog; signatures are verified for every source. |
| FR-050 | P1 | M5 | "Build a plugin/skill" flow: from a conversation, generate a manifest + files, validate, and install locally. |

## E. Work mode (delegated agentic tasks)

| ID | Pri | Ms | Requirement / Acceptance |
| --- | --- | --- | --- |
| FR-051 | P0 | M5 | A Work run accepts a task, produces a visible plan, executes tool calls, and reports a structured result (summary + artifacts + evidence). |
| FR-052 | P0 | M5 | Runs continue when the app window is closed (if configured) and resume after restart; state persists in the DB. |
| FR-053 | P0 | M5 | Background sub-agents run concurrently up to a configurable limit; the coordinator aggregates and reports. |
| FR-054 | P1 | M5 | Child threads for parallel work appear in the sidebar; the user can open, steer, or cancel each. |
| FR-055 | P0 | M5 | Scheduled tasks: cron, RRULE or interval with timezone and optional end date; instructions, notification conditions and delivery targets; list/edit/pause/cancel. Missed fires collapse into one catch-up run that is told the missed window (default lookback 7 days; per schedule `once` or `skip`). |
| FR-056 | P1 | M6 | Event triggers: subscribe to a source that declares events (webhook, connector or MCP event subscription per FR-201, file change, email label) and start a run or wake an agent on matching events, with dedupe. Joining a channel never creates a trigger by itself. |
| FR-057 | P0 | M5 | Activity view per run: ordered steps, tool calls with inputs/outputs, file diffs, approvals, and final result; replayable. |
| FR-058 | P0 | M5 | Approvals: gated actions present a clear request (what/who/why/scope) with Allow once / Always allow / Deny / Hand off. |
| FR-059 | P1 | M6 | Delegation: a chat, Work run or agent can start a Work run or a Code session (in a chosen environment or device) with context, and an agent can create or edit schedules, all within the caller's policy scope; results flow back to the caller. |
| FR-060 | P1 | M6 | Notification routing rules: choose which events notify on OS, in-app, or a channel; quiet hours. |

## F. Code mode (software engineering agent)

| ID | Pri | Ms | Requirement / Acceptance |
| --- | --- | --- | --- |
| FR-061 | P0 | M5 | A Code session binds to an environment + folder/repo + model + permission mode; sessions run in parallel and are independently listed. |
| FR-062 | P1 | M6 | Environments: **Local**, **Cloud**, **SSH**, **WSL**, **Container**, and any registered device running `novad`; each is configurable, saved for reuse, health-checked, and selectable per session. Over SSH, Nova installs the `novad` helper on the remote host and talks to it through a forwarded 0600 socket. |
| FR-063 | P0 | M5 | Permission modes **Manual**, **Accept edits**, **Plan**, **Auto**, **Bypass** are presets over an approval policy and a permission profile (FR-190); selectable mid-session; remembered per folder (Plan is per-session); managed policy can restrict modes; Bypass requires a VM or container substrate. |
| FR-064 | P0 | M5 | Agent can read/search files, apply edits, create/delete files, and run commands. Every file change is captured as a diff. |
| FR-065 | P0 | M5 | Diff viewer: per-file list, unified/split view, per-line comments, accept/reject individual hunks, apply all. |
| FR-066 | P0 | M5 | Integrated terminal runs commands in the session environment with streamed output; user commands and agent commands are visually distinguished. |
| FR-067 | P1 | M6 | Browser pane runs local dev servers, previews the app, and lets the agent verify changes (screenshot, DOM inspect, click, fill). Dev servers can be started/stopped/stopped-all. |
| FR-068 | P1 | M6 | Auto-verify: after edits, the agent runs configured checks (build/test) and reports pass/fail with logs; configurable per project. |
| FR-069 | P0 | M6 | Code review: `/review` produces findings grouped by file with severity, suggested fixes, and "apply" actions. |
| FR-070 | P1 | M6 | Create commits/branches and open PRs via a connected Git host; show CI status and update on completion. |
| FR-071 | P2 | M7 | Cloud code environments support multiple repositories and reusable setup scripts; cloud runs continue when the laptop is offline. |
| FR-072 | P1 | M6 | Agent can inspect and manage other sessions (list, message, archive) and answer side questions using session context. |
| FR-073 | P1 | M6 | Parallel agents run independent tasks in separate git worktrees (`<repo>/.nova/worktrees/<id>`, branch `nova/<slug>`), copy files listed in `.worktreeinclude`, hold a lease in a worktree registry, keep at most 15 worktrees per repo, support handoff between the main checkout and a worktree, and merge results safely, surfacing conflicts. |
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
| FR-081 | P1 | M6 | The user can connect their own computers (running `novad`) to an agent: one active connection per agent, granted from the agent's profile and separate from other device grants, explicit and revocable. The Hub refuses devices below the minimum `novad` version for the requested capabilities. |
| FR-082 | P0 | M6 | Proactive research: when an agent is idle (at most hourly by default), it reads connected sources with read-only tools, records findings in its notes, and brings suggestions to the user; any resulting action goes through policy; can be disabled per agent. |
| FR-083 | P0 | M6 | Background agents + cloud threads: a Agent can fan out work and keep conversing; threads appear in the sidebar. |
| FR-084 | P0 | M6 | Custom rules with scopes: *take action without asking*, *take action when you say so*, *ask before taking action*, *hand off to you*. Rules may include command prefix rules (FR-191). Rules are editable/deletable and previewable and never override built-in safety. |
| FR-085 | P0 | M5 | Auto-review: a reviewer model (read-only sandbox, no inherited allow rules) checks consequential actions against the user's request, standing instructions and rules, returning strict JSON `{outcome: allow|ask|handoff|deny, risk, userAuthorization, rationale}`. It runs after deterministic policy and can only tighten a decision. Timeout (90 s), malformed output or error ends as deny after up to 3 attempts; 3 consecutive denials or 10 in the last 50 reviews interrupt the run; on deny the agent is told to avoid similar actions; a user override is audited. Sensitive actions always hand off. |
| FR-086 | P1 | M6 | Private sign-in: a secure form (never into model context) collects credentials for a site; optional "save to passwords"; sessions vs saved logins are distinct. |
| FR-087 | P0 | M6 | Inspect the Agent's computer; take over keyboard/mouse; return control. Takeover is logged. |
| FR-088 | P1 | M6 | Channels: message an agent from in-app, Slack, Teams, webhooks and email. Each channel binding keeps its own thread while the agent's memory and identity are shared; the owner's private channels can be set to share one thread. Content from a private thread reaches a shared channel only through a policy check. |
| FR-089 | P1 | M6 | Agent memory: durable notes plus conversation memory, both user-visible and editable; the user can forget items; turning memory off for an agent purges notes derived from it. |
| FR-090 | P0 | M6 | Activity view for an agent, including background work; the user can redirect, pause (the agent plus all its child runs and schedules) or stop work at any time; safety monitoring can auto-pause. Deleting an agent is irreversible and does not undo actions already taken; the confirmation says so. |
| FR-091 | P2 | M7 | Specialist/team agents: an admin can provision an agent with its own identity, scoped credentials and responsibilities; team tasks run under that agent's identity, not a person's account. |

## H. Computer & browser automation

| ID | Pri | Ms | Requirement / Acceptance |
| --- | --- | --- | --- |
| FR-092 | P0 | M6 | Browser tool: navigate, read DOM/text, click, type, scroll, wait, screenshot, download/upload; returns structured results to the agent. |
| FR-093 | P0 | M6 | Computer-use tool: observe screen, move/click/type, and read windows on a controlled desktop; requires explicit enablement; control tiers and grants per FR-207. |
| FR-094 | P0 | M6 | Domain allowlist/blocklist and per-site permission levels (Always ask, Auto approve with review, Always allow). New sites prompt with Allow once / Always allow / Deny. Full developer-protocol access is a separate per-site mode that needs explicit approval and can be disabled by policy. |
| FR-095 | P1 | M6 | Safety classifier reviews write actions on external pages in every mode; flagged actions always prompt. |
| FR-096 | P1 | M6 | Browser profiles: a clean agent profile separate from the user's; an optional extension bridge (local native messaging to `novad`, no third-party relay) for the user's logged-in sessions, with per-host grants ("all sites" flagged as elevated risk), per-tab consent, a visible indicator, and history access asked each time. |
| FR-097 | P1 | M6 | Local dev server manager: detect, start, stop, and stop-all; expose URLs to the browser pane. |
| FR-098 | P0 | M6 | Every browser/computer action is recorded in the Activity trace with before/after screenshots. |

## I. Permissions, security, privacy

| ID | Pri | Ms | Requirement / Acceptance |
| --- | --- | --- | --- |
| FR-099 | P0 | M3 | Central Policy Engine evaluates every tool call against: built-in safety, workspace policy, custom rules, per-tool defaults, and scope → returns allow / ask / handoff / deny with a reason. |
| FR-100 | P0 | M3 | Approvals are presented consistently (card + notification) with: Allow once; Allow for this session; Always allow (scoped to the tool, a command prefix rule, or a network host); Deny and continue (reason returned to the agent); Deny and stop; Hand off. A timeout is recorded as its own outcome. Decisions are remembered per scope and revocable; managed policy can disable persistent "Always allow". |
| FR-101 | P0 | M3 | Secrets are stored in the OS keychain (or encrypted vault fallback); secrets are redacted from logs, traces, and model context; a secret-scanning check runs in CI. |
| FR-102 | P0 | M6 | Egress control: agents can only reach approved network destinations (configurable per mode/tool/scope) through the egress proxy (FR-193); all other egress is blocked and logged. |
| FR-103 | P0 | M6 | Prompt-injection defense: tool, page, file, channel and capture outputs are labeled untrusted; only user-typed instructions carry authority (FR-189); the policy engine treats tool-originated instructions as data; suspicious content is surfaced as a finding, not executed. |
| FR-104 | P0 | M5 | Audit log: append-only record of actions (actor, tool, inputs hash, decision, result, timestamp) exportable as JSONL. |
| FR-105 | P1 | M8 | Data controls: telemetry off by default; training opt-out is always on (we never train); per-item retention settings; export/delete-all with confirmation. |
| FR-106 | P1 | M8 | Managed settings: policy from an OS-protected location (root-owned file, machine policy registry, device-management profile) or a signed remote policy can restrict permission modes, tools, plugins, MCP servers, local and SSH sessions, workspace folders, browser domains, egress, telemetry export, model routing, retention, per-agent capabilities and ambient capture, and can lock appearance. |
| FR-107 | P0 | M6 | Execution sandboxes: local agent runs use an OS sandbox (Linux bubblewrap with seccomp; macOS seatbelt; Windows restricted tokens with per-root capability SIDs) or a container/VM substrate, scoped by the permission profile (FR-190). Failure to create a sandbox fails closed. |

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
| FR-127 | P0 | M2 | **Routing** selects a node by the default order: same device/LAN → required model+capability → least-loaded → lowest cost/energy → cloud (only if allowed). Order is configurable. A turn's execution location is fixed for that turn and may change only between turns. |
| FR-128 | P1 | M7 | **Local fallback**: when the Hub is unreachable, a capable device runs local models/agents via `novad` and queues actions; it never silently drops work. |
| FR-129 | P1 | M7 | **Capability-gated offline replica**: a client keeps an encrypted local replica only if the Hub grants that capability to that device. |
| FR-130 | P2 | post-v1 | **Hub failover**: another candidate node can take over as Hub with lease-based leadership and client redirection. Deferred until after v1. |
| FR-131 | P0 | M5 | Nova is **reactive** (responds to requests and events) **and proactive** (schedules, watches, and initiates) subject to policy and approvals. |
| FR-132 | P0 | M6.5 | **Add a Device** via QR code or short code, with per-device bootstrap (PWA / native shell / headless command) and a required Hub-side approval. |
| FR-133 | P0 | M6.5 | The Hub serves **signed** `novad` builds and a one-line bootstrap command; installs verify signature, checksum, and Hub identity. |
| FR-134 | P0 | M6.5 | **Trust paths** selectable in Hub settings: Hub-generated local CA, Mesh certificates, or native-shell pinning. |
| FR-135 | P0 | M6.5 | **Pluggable transports** (LAN, Mesh, Relay, optional direct public) with ordered fallback and per-endpoint health checks. |
| FR-136 | P0 | M6.5 | **Network Setup assistant** detects state and can install/configure a Mesh (Headscale/Tailscale/NetBird/WireGuard), tags/ACLs, MagicDNS, subnet routes, certs, and firewall — with one-time consent, reachability tests, and rollback. |
| FR-137 | P0 | M7 | **Relay**: content-blind, end-to-end-encrypted forwarding of sealed envelopes with client, stream and sequence ids, segmenting of large messages, cumulative acks and keepalive; pairing by QR or code; the Hub lists and revokes paired clients; self-hostable; provides off-LAN reach and push (APNs/FCM). |
| FR-138 | P1 | M6.5 | **Wake Helper** role: an always-on LAN device may send WoL magic packets for wakeable devices; wakes are rate-limited and audited. |
| FR-139 | P0 | M6.5 | **Network diagnostics** panel with active transports, latency, certificate status, ACL summary, Relay status, per-device reachability, and one-click rollback. |
| FR-140 | P0 | M6.5 | **Device management** UI: list devices and compute nodes, show capabilities/health/reachability, edit scopes, wake, and revoke. |

## N. Device agent & firmware

| ID | Pri | Ms | Requirement / Acceptance |
| --- | --- | --- | --- |
| FR-141 | P0 | M6 | **`novad` supervisor + modules**: a small elevated supervisor spawns signed, sandboxed, independently updatable modules (management/compute/browser/screen/storage). Installs as a system service. The supervisor and helpers apply process hardening (no core dumps, not debuggable, loader environment variables stripped). |
| FR-142 | P0 | M6 | **Capability declaration** with defaults + Advanced overrides (model storage paths, GPU sharing, VRAM reserve, concurrency limits, quiet hours, routing weight, egress limits). |
| FR-143 | P1 | M7.5 | **Low-level boot** (PXE/iPXE, bootloader entries) is opt-in; boot profiles use a watchdog that reverts on failed boot. |
| FR-144 | P0 | M6 | **Power & WoL**: report wakeability, enable WoL where supported, and support power-on-after-power-loss. |
| FR-145 | P0 | M6 | **Service management**: start/stop/restart compute and other managed services on a device. |
| FR-146 | P1 | M7.5 | **BIOS/firmware management** (allowlisted settings, dry-run diff, snapshot, explicit approval, rollback, audit). Global toggle **off by default**; never proactive. |
| FR-147 | P2 | M7.5 | **Out-of-band management** (IPMI/Redfish/Intel AMT/vPro) for power/settings without an OS. Off by default; admin-only; credentials in the keychain. |
| FR-148 | P0 | M6 | **`novad` updates**: signed bundles, staged, health-checked, with automatic rollback; channels stable/beta/nightly. The Hub enforces a minimum `novad` version per capability. |
| FR-149 | P0 | M3 | **Hub trusted, external paths E2E**: data encrypted at rest on the Hub, TLS in transit, and end-to-end encryption for everything leaving the Hub (Relay, cloud, device sync). Optional sealed mode keeps keys in the OS secure enclave. |
| FR-150 | P1 | M6 | **Per-device policy overrides** for routing eligibility, allowed modules, resource caps, and quiet hours. |

## O. Ambient Memory (screen & audio) — track N1

| ID | Pri | Ms | Requirement / Acceptance |
| --- | --- | --- | --- |
| FR-151 | P1 | N1 | **Ambient capture**: event-driven (app switch, focus, click, typing pause, scroll stop, visual change, 30 s idle heartbeat), focused window first; independent per-source toggles (screen text, screen pixels, microphone, system audio); **off by default**; global pause and a visible capture indicator. |
| FR-152 | P1 | N1 | **Text extraction**: the accessibility tree first; OCR (platform OCR on macOS/Windows, Tesseract on Linux) only when the tree is empty, thin, a terminal buffer or a canvas surface, on a crop of the focused window and cached by region hash; local speech-to-text with voice-activity detection for audio sources; per-OS permission handling. |
| FR-153 | P1 | N1 | **Searchable timeline**: day view with transcript lanes and thumbnails (when pixels are enabled); full-text search ordered by time by default; filters by app/window/URL/source/person/time. A vector index is used only when enabled after an eval shows a recall gain. |
| FR-154 | P1 | N1 | **Privacy controls**: app/title/URL exclusion and inclusion rules (malformed rules fail closed); built-in exclusions (password managers, keychains, lock and login screens, Nova itself); password fields never read; private-browsing detection; DRM and schedule pauses; per-source retention (text 30 days, pixels 48 h by default); "forget last N minutes"; hard delete. |
| FR-155 | P1 | N1 | **Agent/MCP access** through scoped tools ranked broad to narrow (activity summary, search, element search, frame context). Every result states the time it covered and any gaps. Captures are untrusted input and cannot trigger consequential actions directly. |
| FR-156 | P1 | N1 | **Resource governor**: power profiles (performance on AC; balanced, saver, audio-paused and full-pause as battery falls); background work on one CPU lane (target 30 % of a core); disk guard (stop below 5 GiB free, resume above 10 GiB); pause during full-screen media; gaps recorded, not hidden. |

## P. Automations & Smart Home — track N2

| ID | Pri | Ms | Requirement / Acceptance |
| --- | --- | --- | --- |
| FR-157 | P1 | N2 | **Automation engine**: versioned triggers → conditions → actions executed as a DAG with parallel branches, timeouts, retries, and compensation. |
| FR-158 | P1 | N2 | **Trigger kinds**: time (cron/interval/sun), event (webhook/Slack/email/file/connector), device state, ambient, location (geofence), and manual. |
| FR-159 | P1 | N2 | **Action kinds**: smart home, agent run, tool call, messaging, sandboxed script, notification, webhook. |
| FR-160 | P1 | N2 | **Safety**: dry-run/test, logs, rollback, loop prevention, rate limits, and approval for physical-world/consequential actions. |
| FR-161 | P1 | N2 | **Smart-home integrations**: Home Assistant (primary), MQTT, and at least one vendor connector; local-first with optional cloud bridges. |
| FR-162 | P1 | N2 | **Normalized entity model** (type/state/attributes/area), rooms/scenes, and natural-language device control. |
| FR-163 | P1 | N2 | **Agent ↔ automation interop**: agents can read state, issue commands, and propose automations (proposals require approval). |
| FR-164 | P1 | N2 | **Managed policy** can restrict entity classes, require approval for physical actions, or disable automation. |

## Q. Extensions & Community — track N3

| ID | Pri | Ms | Requirement / Acceptance |
| --- | --- | --- | --- |
| FR-165 | P1 | N3 | **Unified catalog** for MCP servers, connectors, plugins, skills, themes, automation templates, and device integrations, with a self-hostable/offline option. |
| FR-166 | P1 | N3 | **MCP registry import**: discover and install community MCP servers, automatically wrapped with declared permissions. |
| FR-167 | P1 | N3 | **Signed publish/install** with mandatory permission preview and a permission **diff** on update; failed installs roll back. |
| FR-168 | P1 | N3 | **Governance**: automated review + dependency/secret scanning, report/takedown, managed allow/deny, and a fleet-wide kill switch. |

## R. Learning & Self-Improvement — track N4

| ID | Pri | Ms | Requirement / Acceptance |
| --- | --- | --- | --- |
| FR-169 | P1 | N4 | **L0 — memory learning**: extract durable facts/preferences with per-item review, edit, revoke; excludes temporary chats; never trains externally. |
| FR-170 | P1 | N4 | **L1 — skill synthesis**: detect repeated workflows and propose a versioned skill with provenance; user approval to install. |
| FR-171 | P1 | N4 | **L2 — workflow/prompt optimization**: evaluated against a held-out task set on correctness, cost, latency, and safety; proposals require approval and are reversible. |
| FR-172 | P1 | N4 | **L3 — bounded self-tuning**: tune retrieval, routing, cache, and scheduling within declared bounds with drift detection and automatic rollback. |
| FR-173 | P2 | N4 | **L4 — code self-modification**: isolated worktree, tests + security checks + safety eval, mandatory diff/evidence approval, staged deploy with auto-rollback; **must never modify policy/safety/audit/signing/self-improvement gates**. |
| FR-174 | P2 | N4 | **L5 — optional local fine-tuning**: user-approved data only, resource-bounded, evaluated, versioned, deletable; base model never altered. |
| FR-175 | P1 | N4 | **Evaluation harness, transparency, and kill switch**: regression gates with auto-revert; a "What Nova learned" view with provenance/rollback; an instant stop control. |

## S. Follow-ups & bridges — capability tracks

| ID | Pri | Ms | Requirement / Acceptance |
| --- | --- | --- | --- |
| FR-176 | P1 | N2 | **Smart-home bootstrap**: Nova can provision, configure, and supervise a Home Assistant instance on a compute node, **or** operate without it using direct MQTT / Matter / vendor connectors. |
| FR-177 | P1 | N3 | **Catalog endpoints**: serve the catalog from a public custom domain, a mesh/tailnet URL, and/or self-hosted/offline; clients accept several catalog URLs and try them in order; every entry is signature-verified regardless of endpoint. |
| FR-178 | P1 | N4 | **Skill authoring & generation**: users author markdown skills; Nova may generate and refine its own skills from repeated workflows or explicit requests, with provenance, versioning, and approval before use. |
| FR-179 | P2 | N2 | **HomeKit bridge** (local, no cloud) exposing Nova entities as HomeKit accessories; opt-in per entity/area. |
| FR-180 | P2 | N2 | **Matter bridge** exposing Nova entities to Apple/Google/Amazon via Matter; preferred over per-ecosystem cloud skills. Direct Google/Alexa cloud integrations are deferred. |

## T. Reconciliation additions (Phase 0)

Added by `docs/external/RECONCILIATION.md`. Grouped by area; IDs continue the sequence.

### T1. Runtime, budgets & goals

| ID | Pri | Ms | Requirement / Acceptance |
| --- | --- | --- | --- |
| FR-181 | P0 | M5 | **Goals**: a run or agent can hold a goal (objective ≤ 4,000 characters; optional token, time and cost budgets). Statuses: active, paused, blocked, usage_limited, budget_limited, complete. Only the system sets usage_limited and budget_limited; the agent may set blocked only after the same blocker recurs on 3 consecutive goal turns, and paused only on the user's explicit request. While a goal is active and its thread is idle, the runtime starts a continuation turn itself (trigger `goal`) within budget and quiet hours. The goal is visible and editable in the run or agent header. |
| FR-182 | P0 | M5 | **Budgeted execution**: runs are bounded by a time budget, a token budget and a cost budget (run defaults 60 min, 2,000,000 tokens and the provider spend cap) plus a hard backstop of 200 model steps per turn. Reaching any bound pauses the run with a progress summary and an offer to extend; it never continues silently. Budgets and consumption are shown live. |
| FR-183 | P1 | M5 | **Context compaction**: compaction runs before a turn when context exceeds the threshold (default 80 % of the model limit), mid-turn when the limit is reached and more steps are needed, and after a turn above the threshold when no input is queued. The model has `context.remaining` and `context.fresh` tools. Each compaction is recorded as a thread item; the original messages stay retrievable. |
| FR-184 | P1 | M5 | **Interactive exec sessions**: `exec.run` returns output after a yield time (default 10 s) or a session id for a still-running process; `exec.write` sends stdin and `exec.poll` reads new output. Output returned to the model is redacted and capped (default 10,000 tokens). Sessions are killed when the run is cancelled and are listed in the terminal pane. |
| FR-185 | P1 | M5 | **Instruction-file discovery**: from the project root (the nearest `.git` or a configured marker) down to the working directory, each directory contributes at most one instruction file (`AGENTS.md`, `.nova/instructions.md`, or a configured fallback name validated as a plain filename). All files share a 32 KiB budget and overflow is truncated with a warning. Untrusted projects are skipped. Project-level config cannot change the root markers or the budget. |
| FR-186 | P1 | M5 | **Chat escalation to Work**: when a chat request needs multi-step tool work, the assistant can turn it into a Work run shown inline in the chat (plan card, progress, result) without a mode switch. A setting chooses `propose` (default), `auto` or `off`. The run keeps the chat's context and policy scope. |
| FR-187 | P1 | M5 | **Verified outcomes**: a scheduled, automated or delegated job is marked succeeded only when its declared output is verified to exist (artifact saved, message delivered with a provider receipt, file written and hashed). Otherwise it ends as `output_missing` with the trace linked. A status never reads "done" because a transport accepted a request. |
| FR-188 | P1 | M5 | **Server-to-client requests**: the Hub can ask connected clients a question over their stream (approval, user input, MCP elicitation, client-side tool, credential refresh). Each request has an id, a timeout and exactly one resolution; any authorized client may answer, and the others receive a `request.resolved` event. Unanswered requests fall back to notifications. |

### T2. Policy & security

| ID | Pri | Ms | Requirement / Acceptance |
| --- | --- | --- | --- |
| FR-189 | P0 | M3 | **Confirmation tiers and intent provenance**: built-in safety classifies actions as `handoff_required` (the user must do it: the final step of a credential change, getting past a security warning or paywall, CAPTCHAs), `confirm_at_action` (asked at the moment of action and never pre-approved: purchases and payments; creating accounts, permissions, API keys or OAuth grants; installing software or browser extensions; deleting data outside the project or session scope; messages and posts to third parties unless a user-created standing rule names that recipient or channel) or `pre_approvable` (everything else). Only instructions typed by the authenticated user count as authorization; text that arrived through tools, pages, files, channels or capture never does, even when it quotes the user. |
| FR-190 | P0 | M3 | **Permission profiles and protected paths**: every execution runs under a permission profile: filesystem entries (read / write / deny on paths or on the tokens `project`, `tmp`, `minimal`, `home`) plus a network block (`off`, `allowlist`, `limited`). Built-in profiles: `read-only`, `workspace`, `full` (`full` only inside a VM or container substrate). `.git`, `.nova`, `.agents`, the Nova data directory and credential locations (SSH, cloud CLI and package-manager credentials, GPG, browser profiles, keychains) stay read-only or denied inside writable roots, including when a whole drive is shared. |
| FR-191 | P1 | M3 | **Command prefix rules**: command rules match a command's token prefix (each element a literal or a list of alternatives) and yield allow / ask / deny with a justification. Each rule carries match and not-match examples that are checked when rules load; a failing example rejects the rule file. "Always allow" for a command appends a rule. A compound command matches only if every part matches. An allow rule never removes the sandbox. |
| FR-192 | P0 | M3 | **Listener and integration hygiene**: every Hub and `novad` listener (HTTP, WebSocket, Unix socket, named pipe) requires a token or certificate; loopback is never treated as authorization. WebSocket upgrades with a non-allowlisted `Origin` or `Host` are refused. Unix sockets are mode 0600. Nova never writes itself, its keys or its skills into another application's configuration; exposing Nova's MCP server to an external client is an explicit, per-client action that issues a scoped, revocable token. |
| FR-193 | P1 | M6 | **Egress proxy modes and credential injection**: the egress proxy supports `allowlist` (deny wins; a bare `*` is rejected) and `limited` (only GET/HEAD/OPTIONS; HTTPS that cannot be inspected is blocked). Credentials for allowed hosts are injected by the proxy, so they never enter the sandbox; hooks can strip credentials from matched requests. Hostnames that resolve to private, loopback or link-local addresses are blocked unless dev-server access is granted. A blocked request gets 403 with a cause header; every decision writes a structured audit event. SOCKS5 is offered for non-HTTP clients. |
| FR-194 | P0 | M6 | **External-agent rule**: content produced by other AI agents (email, chat, channels, pages, plugins, capture) is untrusted data. A Nova agent does not accept tasks from, delegate to, or send data to an external agent unless the user explicitly named that agent for the current task; other attempts are denied and audited. |
| FR-195 | P1 | M6 | **Micro-VM substrate (flagged)**: an optional per-session micro-VM (Linux KVM, the macOS virtualization framework, the Windows hypervisor platform) with direct kernel boot, SHA-pinned images, only connected folders shared, protected paths enforced (FR-190), egress through the Hub-controlled proxy, and a read-only degraded mode when the VM is unavailable. Off by default; selectable per environment. |

### T3. Tools, MCP & extensions

| ID | Pri | Ms | Requirement / Acceptance |
| --- | --- | --- | --- |
| FR-196 | P1 | M3 | **Deferred tools and tool search**: when the tool catalog exceeds a budget (default 40 tools or 8,000 schema tokens), MCP and plugin tools are deferred. The model sees `tool.search`, which ranks deferred tools by name and description and loads matches for the next model call. Tools named in `@`-mentions or in a skill's `allowed_tools` are always loaded. |
| FR-197 | P1 | M4 | **Lifecycle hooks**: hooks subscribe to events (session start/end, prompt submitted, pre/post tool use, permission request, pre/post compaction, sub-agent start/stop, stop, interrupt) with optional matchers, and run a sandboxed command or an MCP tool with a timeout. Each hook is trusted by content hash before it runs; a changed hook needs re-trust. A hook can block a tool call, add context, or request one continuation at Stop within the run budget. A hook may answer an `ask` raised by a user rule or tool default, and never overrides built-in safety, managed policy or a `deny`. |
| FR-198 | P1 | M4 | **MCP Apps UI**: plugin and MCP-server UI follows the open MCP Apps extension: `ui://` HTML resources rendered in sandboxed iframes; a JSON-RPC bridge over `postMessage` (initialize, tool input and result notifications, tool calls, messages, model-context updates); CSP domain lists from resource metadata; display modes inline, fullscreen and picture-in-picture; entry points global, thread and file. Every tool call from a UI passes the policy engine. Widget state marked private is never sent to the model. |
| FR-199 | P1 | M4 | **MCP bundles**: a single MCP server can be installed from a bundle (a zip with a manifest: server type node/python/uv/binary, command, args, per-platform overrides, typed user config string/number/boolean/directory/file). Sensitive config values go to the keychain. The server is wrapped with declared permissions (network, filesystem). Unsigned bundles need an explicit sideload confirmation and are labelled unverified. |
| FR-200 | P1 | M4 | **Import from other assistants**: import instruction files, skills, plugins, MCP server configs, projects, memories and chat exports from common open formats and folders, with a preview first and SHA-256 dedupe. Commands become skills. Any secret found in imported config moves into the keychain and is replaced by a `secret://` reference. An imported plugin or server stays disabled until its permissions are declared and confirmed. |
| FR-201 | P1 | M6 | **MCP event subscriptions**: for servers that advertise events, a trigger subscribes with a Hub webhook URL and secret, refreshes before expiry and unsubscribes on removal. Deliveries must carry a valid signature and be under 256 KiB; they are deduplicated by id, treated as untrusted input, and start a run or wake an agent per the trigger's configuration. |
| FR-202 | P2 | M7 | **Scripted tool calls (flagged)**: a run may expose `script.run`, in which the model writes a short script (JavaScript in an isolated engine without network or filesystem access) that calls other tools as functions. Each nested call is evaluated by the policy engine and audited as its own tool call. Off by default. |
| FR-203 | P2 | M7 | **External agent adapters**: a Code session can delegate to an external coding agent over an open agent protocol only when the adapter routes every permission request to Nova's policy engine and the agent runs inside a Nova sandbox. Its file changes appear as Nova diffs. Disabled by default and by managed policy. |

### T4. Memory

| ID | Pri | Ms | Requirement / Acceptance |
| --- | --- | --- | --- |
| FR-204 | P1 | M3 | **Memory consolidation**: a background job extracts candidate memories from idle threads (secrets redacted), then consolidates them into categorized items and a summary (≤ 2,500 tokens) that is injected into context. Items are updated as facts age (a plan becomes a past event once its date passes). The Memory page groups items by category with correct, dismiss and "remember more/less about this topic" controls. Consolidation never creates, installs or edits skills. |
| FR-205 | P1 | M3 | **Memory scopes and history reference**: a "reference past chats" toggle controls retrieval over chat history independently of saved memories; turning it off stops use at once and purges derived data within 30 days. Each project chooses `shared` or `project_only` memory at creation; project-only memory is never read outside the project; multi-user shared projects are always project-only. |

### T5. Agents, devices & computer use

| ID | Pri | Ms | Requirement / Acceptance |
| --- | --- | --- | --- |
| FR-206 | P1 | M6 | **Agent self-scheduling**: an agent can set its own next wake-up with `schedule.wake` (minimum interval 5 min, maximum horizon 30 days, at most 24 self-set wakes per day by default). Self-set wakes appear in the Scheduled list, can be edited or cancelled by the user, respect quiet hours, and are audited. |
| FR-207 | P1 | M6 | **Computer-use control tiers**: per application class: browsers view-only (act through the browser tool), terminals and editors click-only, other apps full control. Grants are per app with a default 30-minute TTL. A global kill key (Esc by default) stops control instantly; an indicator and edge highlight show while control is active. Nova hides its own window before acting, guards the clipboard, and fails closed when sensitive-region masking fails. Tool precedence: connectors, then shell, then browser, then computer use. |
| FR-208 | P2 | M6 | **Page-registered tools**: a page loaded in an agent browser may register tools (name, description, input schema) from its top frame only. Each call is policy-gated and reviewed like an external write; results are untrusted. |
| FR-209 | P1 | M6 | **Local browser fallback**: when a site blocks an agent's own browser, an agent with a connected computer may continue on that computer's browser after a per-site user consent (clean profile, or the user's profile through the extension bridge per FR-096). The session is marked and audited. |
| FR-210 | P1 | M6 | **Device operations through `novad`**: Hub sessions reach a device's files only through `novad`: list directories within granted scopes, request access to a new folder (approved on the device or the Hub), and write in two phases (stage, then commit after the diff is shown and policy allows). `novad` can expose the device's local stdio MCP servers to Hub sessions under the device's grants. |

### T6. Code

| ID | Pri | Ms | Requirement / Acceptance |
| --- | --- | --- | --- |
| FR-211 | P1 | M5 | **Hook-free app Git operations**: Git operations Nova runs for its own bookkeeping (status, diff, worktree add/remove, fetch, branch listing) run with repository hooks disabled. Commits and pushes the agent makes on the user's behalf run hooks only inside the session sandbox. |
| FR-212 | P2 | M7 | **Best-of-N attempts**: a Code task can run N attempts (default 2, max 4) in separate worktrees; the user compares diffs and test results side by side and applies one. |

### T7. Multi-device & UX

| ID | Pri | Ms | Requirement / Acceptance |
| --- | --- | --- | --- |
| FR-213 | P1 | M7 | **Session handoff**: a Code session or chat can move to another device or environment with its Git state (branch, uncommitted changes as a patch, worktree) and continue there; the move is recorded in the session history. |
| FR-214 | P1 | M7 | **Attach window**: a global shortcut on a desktop client attaches the frontmost window (a screenshot plus its accessibility text, including text scrolled off screen) to the current or a new chat. Excluded apps and password fields are never captured; redaction runs before attach; the user sees the attachment before sending. |
| FR-215 | P1 | M5 | **Thread status model**: every thread, run, code session and agent shows one status (Running, Needs input, Ready, Blocked) derived from runtime state. The sidebar, tray and notifications use the same states, and "Needs input" items sort first. |
| FR-216 | P1 | M5 | **Dictation**: speech-to-text into the composer with punctuation cleanup and a user dictionary; local engines by default; audio is not stored. |
| FR-217 | P2 | M7 | **Shared threads**: several authenticated users of one Hub can share a thread. Each user's personal memory and private connectors are never injected into it; actions in a shared thread run under the acting user's permissions. |
| FR-218 | P2 | M7 | **Voice-call channel**: users can call an agent (in-app, or through a telephony connector) with streaming speech both ways. Calls started by an agent are out of scope for v1. |

### T8. Outputs & models

| ID | Pri | Ms | Requirement / Acceptance |
| --- | --- | --- | --- |
| FR-219 | P1 | M5 | **Document outputs**: built-in skills generate and read DOCX, PPTX, XLSX and PDF files as artifacts with previews; generation runs in the sandbox without network. |
| FR-220 | P1 | M5 | **Deep research run**: a Work run template that plans sub-questions, gathers sources (web, connectors, project files) through sub-agents, and produces a cited report artifact with a source list; progress is viewable and interruptible. |
| FR-221 | P1 | M2 | **Model presets**: a simple control offers presets from Faster to Smarter, each a virtual model (provider, model, reasoning level, speed). An advanced panel shows and edits the underlying choices. Presets never spawn sub-agents implicitly. |

### T9. Platform & quality

| ID | Pri | Ms | Requirement / Acceptance |
| --- | --- | --- | --- |
| FR-222 | P2 | M8 | **Third-party app authorization**: an external application can request scoped access to the Hub API through an authorization flow the user approves; tokens are per app, scoped, revocable and audited. |
| FR-223 | P1 | M8 | **Opt-in OTLP export**: traces, metrics and logs can be exported over OTLP to a collector the user configures. Off by default; the same redaction applies; no content unless explicitly enabled. |
| FR-224 | P1 | M9 | **Persistence safety evals**: the security suite covers iterative prompt-injection attacks, permission changes mid-task, scope drift across chained tasks (5 and 10 intervening tasks), misleading proactive inputs, behaviour across time budgets, and engagement with external agents. The auto-reviewer is measured by recall per threat category and by denial rate on benign traffic, with regression thresholds. |
| FR-225 | P1 | M10 | **Install robustness**: data directories are resolved explicitly and never depend on per-user filesystem virtualization; a port conflict produces a diagnostic and a fallback port, never a silent exit; official builds are published with signatures and a documented verification procedure linked from the Hub and the docs. |
| FR-226 | P2 | N4 | **Skill from demonstration**: the user records a demonstration (screen actions plus optional narration) and Nova proposes a skill from it through the L1 approval flow. Recordings stay local and are deleted after the proposal unless kept. |

### T10. Ambient capture — track N1

| ID | Pri | Ms | Requirement / Acceptance |
| --- | --- | --- | --- |
| FR-227 | P1 | N1 | **Redaction release gate**: captured text and images are invisible to every reader (UI, tools, MCP, export) until certified by redaction under the current policy. Certification needs a model-based pass; regex alone never certifies. Changing the policy revokes certificates. PII categories are switches (default on: secrets, government IDs, financial and account numbers; default off: names, emails, phones, addresses, dates of birth; secrets cannot be switched off). The Hub refuses records whose stamp covers fewer categories than configured. Image regions are painted with solid boxes; an image whose redacted span has no known position is dropped. Raw values are overwritten once redacted. |
| FR-228 | P1 | N1 | **Capture split**: on each device, a capture helper with no network access, supervised by `novad`, extracts text and metadata and hands them to `novad`, which signs, queues and sends them to the Hub. Recall runs on the Hub while the device sleeps. Pixels, if enabled, are encrypted to a Hub-held key and uploaded to a configured location; the local copy is deleted only after a read-back check of size and SHA-256 at the target. |
| FR-229 | P1 | N1 | **Activity summary**: `ambient.activity_summary` and its view compute, without a model, active minutes per app and window (gaps over 5 min count as idle), key text, documents and URLs touched, and capture status for a time range. |
| FR-230 | P2 | N1 | **Meeting detection**: a meeting is detected when a known meeting app or meeting URL holds the microphone. Meetings get start/end records, transcripts and an optional summary. Detection is evaluated by replaying recorded traces. |
| FR-231 | P2 | N1 | **Speaker identity**: speakers are clustered within a meeting and matched across meetings only above a confidence margin (otherwise left unnamed). The user can name, merge and delete speakers; voiceprints are deletable and never leave the Hub. |
| FR-232 | P1 | N1 | **Capture provenance checks**: a reply that claims something about screen or audio activity in a turn where no ambient tool ran is flagged. A tool call whose arguments copy a long verbatim run of captured text is tagged in the trace, and a notice is appended to the reply. Captured content is wrapped as untrusted and can never satisfy an "act when told" rule. |
| FR-233 | P1 | N1 | **Scoped ambient grants**: any schedule, automation or external client that reads ambient data gets a Hub-enforced grant naming apps, windows, content types and a time window. Requests outside it are denied; each grant limits concurrent queries and per-query time. |

---

## Requirement traceability

- Inventory → requirements is many-to-many; each `INV-*` is covered by ≥1 `FR-*`.
- Every `FR-*` appears in exactly one milestone in `docs/17`.
- Acceptance tests for each `FR-*` are defined in `docs/16` and referenced by ID.
- The `LEDGER.md` tasks reference `FR-*` IDs directly.
