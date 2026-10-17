# Nova — Build Spec Bundle

**Working title:** Nova (rename freely; branding is configuration, not code).
**Goal:** Build one customizable, multi-device application that unifies conversational AI,
long-running work agents, always-on agents, and an autonomous coding agent into a single,
coherent workspace, using a hub-and-spoke architecture that targets local models first and
cloud models optionally.

Capability areas in scope:

| Area | What we build |
| --- | --- |
| Collaboration & chat | Conversation UX, artifacts, long-running agentic work, plugins/skills, connectors |
| Coding agent | Repo-aware coding, parallel agents, cloud/local environments, diff review, PR flow |
| Always-on agents | Persistent agents with their own computer, proactive research, schedulers, approvals, multi-channel reach |
| Hub & multi-device | A hub that hosts the app/UI and coordinates compute nodes, clients, sync, and remote access |

This directory is **not the application**. It is the *complete, self-contained specification*
that another autonomous coding agent can execute continuously, milestone by milestone,
without further human intervention.

**Status (2026-10-17):** the Phase 0 reconciliation of external findings is complete
([`docs/external/RECONCILIATION.md`](docs/external/RECONCILIATION.md): 141 capabilities
classified). The spec defines `FR-001`…`FR-233` and decisions `ADR-001`…`ADR-091`; every FR is
placed in exactly one milestone and has a row in [`tests/manifest.md`](tests/manifest.md). The
build has completed M0 (Hub and web shell), M1 (chat MVP), M2 (providers, presets and
routing, compute nodes, projects and sources, memory, branches and search), M3 (tools, MCP,
the policy engine and approvals, audit, notifications) and M4 (plugins and skills, hooks, MCP
Apps, Nova's own MCP server, bundles, panes and terminal, profile, usage and import); M5 is
next. Demo
scripts are in [`docs/demos/`](docs/demos/). Progress is tracked in [`LEDGER.md`](LEDGER.md).

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
| 01 | [`01-reverse-engineering-method.md`](docs/01-reverse-engineering-method.md) | REA methodology, clean-room rules, evidence format, coverage matrix |
| 02 | [`02-feature-inventory.md`](docs/02-feature-inventory.md) | Inventory of target capabilities, translated into requirements |
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
| 21 | [`21-hub-and-device-model.md`](docs/21-hub-and-device-model.md) | Hub/spoke roles, routing, offline, failover |
| 22 | [`22-networking-transports-relay.md`](docs/22-networking-transports-relay.md) | Transports (LAN/Mesh/Relay), Add Device, trust, WoL |
| 23 | [`23-device-agent.md`](docs/23-device-agent.md) | Device agent `novad`: modules, capabilities, boot, BIOS/OOB |
| 24 | [`24-ambient-memory.md`](docs/24-ambient-memory.md) | Opt-in screen/audio capture, OCR/STT, searchable timeline |
| 25 | [`25-automation-and-smart-home.md`](docs/25-automation-and-smart-home.md) | Automation engine + smart-home integrations |
| 26 | [`26-extensions-and-community.md`](docs/26-extensions-and-community.md) | Community marketplace: MCP, connectors, plugins, skills |
| 27 | [`27-learning-and-self-improvement.md`](docs/27-learning-and-self-improvement.md) | Learning levels, self-modification guardrails, eval gates |
| 28 | [`28-glossary.md`](docs/28-glossary.md) | Canonical terms and naming rules |
| 29 | [`29-task-breakdown.md`](docs/29-task-breakdown.md) | Starter task list per milestone |
| — | [`contracts/`](contracts/README.md) | Hub API, IPC, events, REST API, JSON schemas |
| — | [`docs/adr/`](docs/adr/README.md) | One file per decision that supersedes or amends an entry in `docs/20` |
| — | [`docs/external/RECONCILIATION.md`](docs/external/RECONCILIATION.md) | Phase 0: keep / modify / add / replace / reject for every external finding, with the resulting FRs and ADRs |
| — | [`docs/external/`](docs/external/README.md) | Evidence inputs (findings by opaque ID); exempt from the name check |
| — | [`tests/manifest.md`](tests/manifest.md) | One test row per `FR-*` |

## Repository conventions

The spec lives at the repository root. The application is built under `apps/`, `packages/`,
and `services/` (see [`docs/05-system-architecture.md`](docs/05-system-architecture.md)).
`build/` is scratch/output space and is git-ignored.

## Validating the spec

Run `node scripts/check-spec.mjs` (or `npm run check:spec`) from the repository root. It checks
that every `FR-*` in `docs/03` appears exactly once in the milestone index of `docs/17` and
once in `tests/manifest.md`, that every JSON schema in `contracts/schemas` parses, that internal
Markdown links resolve, and that no reference-app name appears outside `docs/external/`
(ADR-056). CI runs it on every push (`docs/16` §9).

## Legal note

This project is a **clean-room reimplementation of functionality and user experience**,
informed by publicly documented product behavior and lawful analysis. It must not copy
proprietary source code, assets, trademarks, or trade dress. See
[`docs/19-legal-and-ethics.md`](docs/19-legal-and-ethics.md). Nova is not affiliated with any
third-party product. Reference products are identified only by opaque IDs (ADR-056); the
integration targets and model providers named in the spec are named because Nova talks to
them.
