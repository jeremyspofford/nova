---
title: "Roadmap"
description: "Nova's development roadmap -- completed phases and upcoming work."
---

Nova is under active development. This page summarizes the major phases of the project. For the full internal roadmap with implementation details, see the [docs/roadmap.md](https://github.com/jeremyspofford/nova/blob/main/docs/roadmap.md) file in the repository.

## Vision

A self-directed autonomous AI platform. You define a goal. Nova breaks it into subtasks, executes them through a coordinated pipeline of specialized agents with built-in safety rails, evaluates its own progress, re-plans as needed, and completes the goal -- with minimal human intervention except when it genuinely needs a decision.

## Autonomy levels

| Level | Description | Status |
|-------|-------------|--------|
| **1 -- Pipeline autonomy** | Quartet runs all agents without human input; escalates only on critical flags | Implemented |
| **2 -- Async execution** | Tasks run in the background; submit and come back | Implemented |
| **3 -- Triggered execution** | Tasks start from external events -- git push, cron, webhook, Slack | Planned |
| **4 -- Self-directed** | Nova breaks goals into subtasks, executes, evaluates, re-plans, loops to completion | Planned |

## Completed phases

### Phase 1 -- Core Platform

The foundation: containerized microservices communicating over HTTP. Multi-turn agent loop with tool use, streaming responses via SSE and WebSocket, pluggable tool system, and 39+ registered model IDs.

### Phase 2 -- Auth, Billing & IDE Integration

API key authentication (SHA-256 hashed, `sk-nova-*` format), per-key rate limiting via Redis, admin-only endpoints, PostgreSQL storage for keys and usage events, token counting and cost tracking, and OpenAI-compatible endpoints for IDE integration (Continue.dev, Cursor, Aider).

### Phase 3 -- Code & Terminal Tools

Workspace-scoped file I/O (`list_dir`, `read_file`, `write_file`), shell execution with timeout and denylist, ripgrep code search, git operations, path traversal protection, and Docker workspace volume mounting. Includes sandbox tier design (isolated/nova/workspace/host).

### Phase 4 -- Quartet Pipeline & Async Queue

The 5-stage agent pipeline (Context, Task, Guardrail, Code Review, Decision), Redis BRPOP task queue with heartbeat and stale reaper, 11-state task state machine, human-in-the-loop review, clarification requests, pod and agent configuration (per-agent model, tools, system prompt, run conditions), and subscription-based LLM providers (ChatGPT Plus) for zero-cost operation.

### Phase 5 -- Dashboard

React admin UI with Overview, Chat, Usage, Keys, Models, Tasks, Pods, MCP, Memory Inspector, Agent Endpoints, Settings, Recovery, and Remote Access pages. Built with Vite, Tailwind CSS, TanStack Query, and Recharts.

### Phase 5.5 -- Hardening

Operational maturity improvements: fixed MCP tool visibility for agents, test foundation (pytest), streaming token count fixes, reaper race condition fix, structured JSON logging across all services, 3-tier embedding cache, and working memory cleanup.

### Phase 6 -- Memory Overhaul

Three-tier memory architecture (semantic, procedural, episodic) with hybrid retrieval (70% cosine similarity + 30% ts_rank), ACT-R confidence decay, fact upserts, embedding fallback chain, and Memory Inspector dashboard page. Upcoming: auto fact extraction from conversations, "what do I know about X?" knowledge queries, cross-session consolidation, and persistent task history with full reasoning traces.

## Current and upcoming

### Phase 5c -- Skills & Rules (planned)

Reusable prompt templates (skills) shared across agents/pods, and declarative behavior constraints (rules) with soft (LLM-based) and hard (pre-execution regex) enforcement. See [Skills & Rules](/nova/docs/skills-rules/) for details.

### Phase 6c -- SDK, CLI/TUI & Documentation (planned)

Typed Python SDK (`nova-sdk`), CLI with Typer + Rich (`nova-cli`), interactive TUI with Textual, auto-generated TypeScript types from Pydantic contracts, and a comprehensive documentation system.

### Phase 7 -- Self-Directed Autonomy (planned)

Planning Agent that decomposes goals into subtask DAGs, executes them through the pipeline, evaluates results, and re-plans. This is the core of Nova's autonomous operation.

### Phase 8b -- MCP Integrations Hub (planned)

One-click integrations connecting Nova to your self-hosted services and developer tools via MCP servers. Browse, enable, and configure integrations from the dashboard with minimal setup.

**Homelab:** Home Assistant (device control), n8n (workflow orchestration), Nextcloud (files/calendar), Paperless-ngx (documents), Immich (photos), Gitea (local git), Uptime Kuma (monitoring), Portainer (containers).

**Developer:** GitHub (repos/PRs/issues), Linear (project tracking), Notion (knowledge base), Slack/Discord (messaging).

**System:** Filesystem (host file access), Docker (container management), Cloudflare (DNS, tunnels, custom domain deployment), SSH (remote execution), Prometheus/Grafana (metrics).

**Knowledge:** Brave Search (web search), Playwright (browser automation), external vector DBs, arbitrary SQL databases.

Each integration ships as a Docker Compose profile or connects to an existing service via URL + API key. Dashboard provides an Integrations page with enable/disable toggles, config modals, connection testing, and real-time health status.

**Devices & Infrastructure:** A dashboard page showing all physical machines connected to Nova -- real-time status (online/sleeping/offline), hardware specs, running services, installed models, resource utilization, and Wake-on-LAN controls. Nova uses device awareness for smart inference routing (auto-wake GPU box when needed, fall back to cloud when offline).

**Custom Domain Self-Deployment:** With the Cloudflare MCP integration, Nova can deploy itself at a user's custom domain (e.g., `nova.mydomain.com`). Nova creates the Cloudflare Tunnel, DNS record, and SSL configuration automatically -- zero manual DNS setup required.

### Phase 9 -- Triggered Execution (planned)

External event triggers: git webhooks, cron schedules, Slack commands, and custom webhook endpoints that automatically submit tasks to the pipeline.

### Phase 9b -- Integrated Web IDE (planned)

Browser-based code editor with git workspace management, integrated with Nova's agent pipeline for AI-assisted development.

### Remote Access + Multi-Device Gateway (planned)

Nova as a distributed personal AI network. Each device (mini-PC, desktop, laptop) runs its own Nova gateway with different LLM backends, sharing one memory service. Chat through the same PWA from your phone regardless of which gateway you're hitting. Per-device routing: cloud-only on low-power devices, local Ollama on GPU boxes, hybrid elsewhere.

### Domain Restructuring (planned)

Migration from `nova.arialabs.ai` (docs site) to a split architecture: `arialabs.ai` becomes the Aria Labs company site with Nova docs at `arialabs.ai/nova/docs/`, while `nova.arialabs.ai` becomes a live private Nova instance accessible from any device via Cloudflare Tunnel + Access. When SaaS launches, the personal instance moves to a personal subdomain and `nova.arialabs.ai` becomes the SaaS endpoint.

### Phase 10 -- Edge Computing (planned)

Edge deployment capabilities for running Nova agents closer to data sources and event triggers.

### Phase 11 -- Multi-Cloud (planned)

Multi-cloud deployment support for distributing Nova across cloud providers.

### Phase 12 -- Inference Backends (planned)

Multiple local inference backends (Ollama, vLLM, llama.cpp, SGLang) for concurrent serving, GPU upgrade path, and optimized multi-user performance.

### Phase 13 -- Multi-Tenancy (planned)

User isolation for multi-person deployments: separate chat histories, memory spaces, API keys, preferences, and usage tracking. Includes authentication, role-based access, and per-user data scoping.

### Phase 14 -- SaaS & Hosted Offering (planned)

Nova Cloud at `nova.arialabs.ai` -- a hosted version where users sign up and use Nova without self-hosting. Three tiers (Free, Pro, Enterprise), Stripe billing, Kubernetes infrastructure, and full data portability between SaaS and self-hosted. Builds on Phase 12 (concurrent inference) and Phase 13 (multi-tenancy).

### Phase 15 -- Desktop Control Panel (optional, planned)

A ~15MB native tray app (Tauri) that wraps Nova's Docker Compose lifecycle and embeds the existing dashboard -- turning `./install` + `./start` + `make logs` + a browser tab into "install an app." It does not reimplement the dashboard; the embedded webview IS the dashboard. The brain (cortex, memory, pipeline, scheduled goals) stays in Docker on your machine (or a remote box you point it at).

The first-run wizard replaces `./install` (Docker + GPU detect, mode selection, model pull, `.env` generation). Tray icon color reflects stack health. Start/stop/restart, log tail, one-click backup/restore via the recovery service, auto-start on login, and a "connect to remote Nova" setting so the same app drives a cloud-hosted brain. OS-native notifications complement the existing ntfy push channel (tray for local lifecycle events, ntfy for phone push).

**Why optional / why now:** self-hosting friction is the #1 adoption barrier, but the existing PWA + ntfy push already covers mobile and installable-desktop use. This item targets the install/runtime gap specifically -- small surface, high ROI, no autonomy impact. Effort: ~2-3 weeks for v1.

### Phase 16 -- Bundled "Install Like An App" Nova (optional, exploratory)

A single-download desktop app that runs Nova with **no Docker and no terminal** -- install it like any desktop app, get a working local AI assistant. This is a different product from server-hosted autonomous Nova: a desktop-app brain sleeps when the laptop sleeps, so scheduled goals, nightly memory curation, and the cortex idle loop won't fire reliably. It trades autonomy for zero-setup convenience.

Three architecture paths are on the table (decision needed before scoping): (A) bundle a hidden container runtime inside the Tauri installer -- reuses the stack but ~500MB+; (B) single-binary Nova with Postgres→SQLite and Redis→in-process -- true single binary, but a large refactor; (C) bundle Ollama + a local model and use a hosted Nova brain (Phase 14 SaaS) for everything else -- small download, real autonomy, local inference privacy. Option C is the most coherent with the roadmap; Option B is the most ambitious.

Adds beyond the tray app: bundled local model (zero cloud keys to start), OS keychain integration for the credential vault with biometric unlock, system-tray quick-chat, native file watchers, and offline-capable chat with cloud sync. Prerequisites: Phase 14 (SaaS) for Option C; bundled-inference maturity (shipped 2026-07-03) for all options. Effort: Option C ~4-6 weeks post-SaaS; Option B ~3-4 months; Option A ~2 weeks.

## Contributing

Nova is open source. Check the full [roadmap](https://github.com/jeremyspofford/nova/blob/main/docs/roadmap.md) for detailed implementation plans, or dive into the codebase to start contributing.
