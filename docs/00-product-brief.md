# 00 — Product Brief

## 1. Vision

**Nova** is a single, customizable desktop workspace where a person talks to AI,
delegates long-running work, runs an always-on personal agent, and drives a software
coding agent — with any model provider, any tool, and any theme, all on their own machine.

Four capability sets, usually split across separate products, are unified here:

- **Deep collaboration** — chat, artifacts, long agentic work, code sessions, permission
  modes, and a clean browser pane.
- **Everyday ubiquity** — conversation UX, projects, memory, voice, plugins, appearance and
  personalization, usage insights.
- **Autonomous software work** — cloud environments, parallel agents, PR review, and
  computer/browser verification.
- **Delegated, ongoing responsibility** — always-on agents with their own computer, proactive
  research, schedulers, custom rules, and multi-channel presence.

Nova unifies these on one shared core so the user learns one product, keeps one memory, and
connects one set of tools.

## 2. Target users

| Persona | Needs | Primary surfaces |
| --- | --- | --- |
| **Alex — knowledge worker** | Draft, research, summarize; delegate recurring work; keep projects organized | Chat, Work, Agents, Projects, Voice |
| **Priya — software engineer** | Drive an agent across repos, review diffs, run tests, ship PRs, use multiple models | Code, Terminal, Diff, Browser pane |
| **Marcus — power user / tinkerer** | Customize everything: themes, pets, keybindings, plugins, local models, extensions | Settings, Extensibility SDK |
| **Dana — analyst** | Long-running data/doc work in a sandbox, scheduled reports, approvals | Work, Agents, Artifacts, Scheduler |
| **Sam — privacy-conscious user** | Local-first storage, E2E sync, bring-your-own-key, no mandatory cloud | All modes, Security settings |

## 3. Product principles

1. **One workspace, four modes.** Chat, Work, Code, and Agents share one core,
   one memory, one tool registry, and one permissions model.
2. **Provider-agnostic.** Anthropic, OpenAI, Google, Mistral, OpenRouter, and local
   (llama.cpp/Ollama) models are first-class. No lock-in; user brings keys or OAuth.
3. **Local-first, cloud-optional.** Data lives in a local SQLite store; sync and cloud
   execution are opt-in and end-to-end encrypted.
4. **Human in control.** Every consequential action passes a policy engine. Defaults are
   conservative; autonomy is granted explicitly and revocably.
5. **Evidence over vibes.** Agent claims link to the exact tool call, file, diff, browser
   action, or source. The Activity view shows the full trace.
6. **Extensible by design.** MCP servers, plugins, skills, themes, and an extension SDK.
7. **Customizable to taste.** Themes, fonts, accent colors, layout panes, pets, and
   keybindings are all data.
8. **Fast and quiet.** Instant streaming, low idle resource use, no dark patterns.

## 4. Scope

### In scope

- **Hub-and-spoke, multi-device system** (see `docs/21`): a self-hosted **Hub** (minimum: Intel N100/N150-class mini PC) hosts the app and canonical state; **Clients** (browser/PWA, native desktop shells, mobile) present the UI; **Compute Nodes** supply heavy services; **`novad`** runs on capable devices for local execution and management.
- Four modes: **Chat**, **Work**, **Code**, **Agents**, plus shared **Projects**, **Library**,
  **Activity**, **Settings**, and **Marketplace**.
- Multi-provider model layer with streaming, tool calling, reasoning levels, and local models.
- MCP client + server; plugin and skill system.
- Agent runtime with tasks, schedules, event triggers, background sub-agents, memory.
- Coding agent with worktrees, environments (local/cloud/SSH/WSL), diff review, PR flow.
- Cloud/local computer abstraction + browser automation with takeover.
- Permission/policy engine and approvals; audit log.
- Optional E2E-encrypted sync and optional cloud runner.
- Channels: Slack, Microsoft Teams, Telegram, email, and webhooks.
- Voice input/output; image generation/understanding; artifacts/canvas; sites.
- Theming, pets, keybindings, usage/profile insights.
- Extension SDK and signed extension marketplace (local-first).

### Out of scope (v1)

- Building a foundation model or training.
- A public multi-tenant SaaS web app (a minimal companion web/relay is allowed for channels
  and mobile dispatch).
- Native mobile apps (mobile access is via channel bridges + a responsive relay).
- Enterprise SSO/SCIM beyond pluggable OIDC (design for it, ship basic OIDC).
- Training on user data.
- A general-purpose browser (we embed a controlled browser for agents/tasks).

## 5. Success metrics (v1)

| Metric | Target |
| --- | --- |
| Time to first successful chat with any provider | ≤ 3 min from install |
| Crash-free sessions | ≥ 99.5% |
| P95 first token latency (hosted provider, warm) | ≤ 1.2 s |
| Cold start (Linux mid-range) | ≤ 2.5 s |
| % of agent actions that are explainable from Activity view | 100% |
| E2E test suite pass rate in CI | ≥ 99% (with quarantine policy) |
| Accessibility: WCAG 2.2 AA on core flows | pass automated audit |

## 6. Terminology

- **Mode** — top-level product surface: Chat, Work, Code, Agents.
- **Thread** — a conversation; may belong to a Project.
- **Project** — a container of threads, instruction, sources, and (optionally) local folders.
- **Agent** — a configured actor with instructions, tools, permissions, and a runtime.
- **Work run** — a delegated, multi-step agentic task.
- **Code session** — a coding task bound to an environment + folder/repo.
- **Agent** — an always-on agent with its own computer, schedules, channels, and memory.
- **Computer** — an execution environment for agents: cloud sandbox, local container/VM, or
  the user's own machine.
- **Tool** — a callable capability (built-in, MCP, or plugin-provided).
- **Skill** — a reusable instruction bundle invoked via slash command or auto-selection.
- **Plugin** — a packaged bundle of skills + MCP servers + optional UI, installed from the
  marketplace.
- **Connector** — an authenticated integration to an external service (GitHub, Slack, …).
- **Artifact** — a rendered output (document, code, chart, website, image, canvas).
- **Policy rule** — a declarative statement controlling when an action is allowed, asked,
  handed off, or blocked.
- **Approval** — a user decision required before a gated action.

## 7. Constraints

- Must run well on WSL2 Linux with a desktop session; packaging for native Linux too.
- Must not require a cloud account to use local features.
- Must not phone home by default (telemetry opt-in, off by default).
- Must respect OS keychain; never store raw provider keys in SQLite.
- Must degrade gracefully offline; queue sync and cloud tasks.

## 8. Key risks (see also `docs/17` and `LEDGER.md`)

| Risk | Mitigation |
| --- | --- |
| Scope is very large | Strict milestone gating; feature flags; ship vertical slices |
| Provider API churn | Adapter interface in `contracts/`; mocks + contract tests |
| Sandboxing complexity across OSes | Start with Linux (bubblewrap) + container; macOS seatbelt; Windows AppContainer behind a flag |
| Prompt-injection via tools | Egress control, taint tracking, action review, deny-by-default |
| Legal/IP | Clean-room rules, no asset copying, permissive deps only |
| Cloud costs | Local-first defaults; user-supplied keys; spend caps and usage accounting |
