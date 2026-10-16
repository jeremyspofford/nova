# Unison Desktop — Build Spec Bundle

**Working title:** Unison (rename freely; branding is configuration, not code).
**Goal:** Build one customizable, cross-platform desktop application that unifies the
best capabilities of four AI products into a single, coherent workspace:

| Source product | What we take |
| --- | --- |
| **Claude Desktop** (Chat / Cowork / Code tabs) | Chat + artifacts, long-running agentic "Cowork"/Work mode, Code sessions with diff review, browser pane, permission modes, skills, connectors, plugins, scheduled tasks, computer use, cloud/SSH/WSL environments |
| **OpenAI ChatGPT Desktop** | Conversation UX, projects, memory, voice, image generation, plugins/skills, "Work" delegated tasks, sites/artifacts viewer, command palette, pets, themable appearance, usage/profile insights |
| **OpenAI Codex** | Coding agent (cloud + local + IDE/CLI parity), parallel agents, cloud environments, PR review, code review, plugins, browser/computer tools, appshots, visualizations, scheduled tasks, long-running work |
| **OpenAI Dots** | Always-on personal agents with their own cloud computer + browser, proactive research, background delegation, schedulers/event triggers, custom rules, activity view, approvals, multi-channel messaging (Slack/Teams/…), specialist agents |

This directory is **not the application**. It is the *complete, self-contained specification*
that another autonomous coding agent can execute continuously, milestone by milestone,
without further human intervention.

---

## How to use this bundle

1. Hand the build agent the single kickoff prompt in [`PROMPT.md`](PROMPT.md).
2. The agent must follow the operating rules in [`AGENTS.md`](AGENTS.md).
3. The agent implements milestones in [`docs/17-roadmap-and-milestones.md`](docs/17-roadmap-and-milestones.md),
   satisfying the acceptance criteria in [`docs/18-acceptance-criteria.md`](docs/18-acceptance-criteria.md)
   and the interface contracts in [`contracts/`](contracts/README.md).

The spec is intentionally **decision-complete**: where a choice was needed, a default has
already been chosen (see [`docs/20-decisions-and-defaults.md`](docs/20-decisions-and-defaults.md)).
The agent should not stop to ask questions for anything already decided; it should record
new decisions in an ADR and continue.

## Document index

| # | Document | Contents |
| --- | --- | --- |
| 00 | [`00-product-brief.md`](docs/00-product-brief.md) | Vision, personas, principles, non-goals, success metrics |
| 01 | [`01-reverse-engineering-method.md`](docs/01-reverse-engineering-method.md) | REA methodology, clean-room rules, evidence format |
| 02 | [`02-feature-inventory.md`](docs/02-feature-inventory.md) | Feature inventory extracted from all four products |
| 03 | [`03-functional-requirements.md`](docs/03-functional-requirements.md) | Numbered, testable requirements (FR-*) |
| 04 | [`04-ux-ia-and-design-system.md`](docs/04-ux-ia-and-design-system.md) | Information architecture, navigation, design system |
| 05 | [`05-system-architecture.md`](docs/05-system-architecture.md) | Processes, stack, monorepo layout, IPC, sandboxing |
| 06 | [`06-domain-data-model.md`](docs/06-domain-data-model.md) | Entities, schemas, storage, migrations |
| 07 | [`07-model-provider-layer.md`](docs/07-model-provider-layer.md) | Provider abstraction, auth, streaming, routing |
| 08 | [`08-tools-mcp-plugins-skills.md`](docs/08-tools-mcp-plugins-skills.md) | Tool runtime, MCP, plugins, skills |
| 09 | [`09-agent-runtime-scheduler.md`](docs/09-agent-runtime-scheduler.md) | Agent loop, tasks, scheduling, memory, activity |
| 10 | [`10-coding-agent.md`](docs/10-coding-agent.md) | Code mode, worktrees, diff/review, PR, multi-agent |
| 11 | [`11-computers-browser-automation.md`](docs/11-computers-browser-automation.md) | Cloud/local computers, browser automation, takeover |
| 12 | [`12-permissions-security-privacy.md`](docs/12-permissions-security-privacy.md) | Threat model, policy engine, secrets, data controls |
| 13 | [`13-sync-cloud-channels.md`](docs/13-sync-cloud-channels.md) | Sync, E2E encryption, channels, mobile dispatch |
| 14 | [`14-settings-theming-extensibility.md`](docs/14-settings-theming-extensibility.md) | Settings, theming, pets, keybindings, extension SDK |
| 15 | [`15-packaging-distribution-updates.md`](docs/15-packaging-distribution-updates.md) | Installers, signing, auto-update, release |
| 16 | [`16-observability-and-testing.md`](docs/16-observability-and-testing.md) | Logging, tracing, test pyramid, CI, perf budgets |
| 17 | [`17-roadmap-and-milestones.md`](docs/17-roadmap-and-milestones.md) | M0–M10 milestones with deliverables + exit criteria |
| 18 | [`18-acceptance-criteria.md`](docs/18-acceptance-criteria.md) | Global definition of done, release checklist, demos |
| 19 | [`19-legal-and-ethics.md`](docs/19-legal-and-ethics.md) | Clean-room, IP, ToS, privacy, licensing |
| 20 | [`20-decisions-and-defaults.md`](docs/20-decisions-and-defaults.md) | ADR log + resolved defaults |
| — | [`contracts/`](contracts/README.md) | IPC channels, events, REST API, JSON schemas |

## Repository conventions

The spec lives at the repository root. The application is built under `apps/`, `packages/`,
and `services/` (see [`docs/05-system-architecture.md`](docs/05-system-architecture.md)).
`build/` is scratch/output space and is git-ignored.

## Legal note

This project is a **clean-room reimplementation of functionality and user experience**,
informed by publicly documented product behavior and lawful analysis. It must not copy
proprietary source code, assets, trademarks, or trade dress. See
[`docs/19-legal-and-ethics.md`](docs/19-legal-and-ethics.md). Product names above are used
only to identify the sources of inspiration.
