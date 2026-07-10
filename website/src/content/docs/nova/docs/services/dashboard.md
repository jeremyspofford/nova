---
title: "Dashboard"
description: "React admin UI for managing Nova. Vite dev server on port 5173, nginx production on port 3000."
---

The Dashboard is Nova's web-based admin interface. Built with React, it provides a comprehensive UI for managing agents, monitoring tasks, configuring models, and controlling every aspect of the platform.

## At a glance

| Property | Value |
|----------|-------|
| **Dev port** | 5173 (Vite) |
| **Prod port** | 3000 (nginx) |
| **Framework** | React + TypeScript + Vite |
| **Styling** | Tailwind CSS (stone/teal/amber/emerald palette) |
| **State management** | TanStack Query (staleTime=5s, retry=1) |
| **Icons** | Lucide React |
| **Source** | `dashboard/` |

## Pages

| Page | Path | Description |
|------|------|-------------|
| **Chat** | `/` | Streaming chat with the primary agent, model switcher (default landing page) |
| **Tasks** | `/tasks` | Pipeline task board -- submit goals, track state machine progress, cancel in-flight |
| **Pods** | `/pods` | Pod management -- create, configure, enable/disable pods; visual pipeline editor |
| **Usage** | `/usage` | Monthly/weekly/daily usage charts by model with sort toggle |
| **Keys** | `/keys` | API key management -- create, revoke, one-time reveal with copy |
| **Models** | `/models` | Backend-aware model management -- Ollama pull/delete, vLLM/SGLang HuggingFace search + model switch, GPU stats, recommendations |
| **MCP** | `/mcp` | MCP server management -- add from catalog, configure, reload |
| **Memory Inspector** | `/memory` | Browse, search, and delete stored memories across all tiers |
| **Agent Endpoints** | `/agent-endpoints` | External agent delegation configuration |
| **Brain** | `/brain` | Live view of the OKF memory bundle — four lenses (Graph, Galaxy, Orrery, Singularity), search (`/`), journal tiering with a hide toggle, the `self/soul.md` identity node at the centre with live drive/goal satellites, retrieval glow streamed over SSE, a resizable chat drawer, click-to-inspect frontmatter with edit/delete |
| **Settings** | `/settings` | Platform configuration (see below) |
| **Recovery** | `/recovery` | Backup/restore, factory reset, service management |
| **Remote Access** | `/remote-access` | Cloudflare Tunnel and Tailscale setup wizards |

## Settings page sections

The Settings page is organized into these sections:

1. **Local Inference** -- backend selector (vLLM, SGLang, Ollama, Custom, None), hardware info, live status, start/stop controls, remote inference toggle, custom endpoint URL/auth config
2. **Nova Identity** -- AI name, greeting message, and persona/soul (configures how the AI presents itself)
3. **Platform Defaults** -- task history retention
4. **LLM Routing** -- routing strategy (local-only, local-first, cloud-only, cloud-first), Ollama URL, intelligent routing
5. **Provider Status** -- API key presence, ping latency, test button per provider
6. **Context Budgets** -- tune the system/tools/memory/history/working percentage split
7. **Admin Secret** -- update the admin authentication secret
8. **Remote Access** -- Cloudflare Tunnel and Tailscale configuration
9. **Recovery & Services** -- backup/restore, factory reset, service management
10. **System Status** -- live status of Queue Worker, Reaper, and MCP Servers
11. **Appearance** -- theme presets and accent color palette
12. **Voice** -- STT/TTS provider, API keys, voice selection, conversation mode settings (silence timeout, barge-in threshold)
13. **Notifications** -- desktop notification preferences
14. **Developer Resources** -- links to API docs and service ports

## Proxy configuration

In development, the Vite dev server proxies API requests to backend services:

| Prefix | Target |
|--------|--------|
| `/api` | Orchestrator (port 8000) |
| `/v1` | LLM Gateway (port 8001) |
| `/recovery-api` | Recovery Service (port 8888) |
| `/cortex-api` | Cortex (port 8100) |

In production, nginx handles the same proxy rules.

## API client

All API calls go through `apiFetch<T>()` in `src/api.ts`, which:

- Adds the `X-Admin-Secret` header from localStorage
- Handles JSON serialization/deserialization
- Provides typed responses via TypeScript generics

## Startup behavior

The Dashboard depends only on the Recovery service at startup. While other services are coming online, it shows a startup screen with service health status. Once the Orchestrator reports healthy, the full UI becomes available.

## Onboarding wizard

First-time users see a 6-step onboarding wizard that walks through inference setup:

1. **Welcome** -- introduction to local AI
2. **Hardware detection** -- GPU, VRAM, CPU, RAM scan
3. **Engine selection** -- backend recommendation based on hardware
4. **Model selection** -- VRAM-aware model suggestions with curated recommendations
5. **Download** -- model pull with progress tracking
6. **Ready** -- setup confirmation

The wizard can be re-launched from Settings at any time. Completion state is persisted so it only appears on first visit.

## Backend-aware Models page

The Models page adapts its UI based on the active inference backend:

- **Ollama** -- pull models from the Ollama registry, delete local models, view download progress
- **vLLM / SGLang** -- search HuggingFace for compatible models, switch the loaded model via drain protocol, view VRAM estimates
- **All backends** -- GPU stats cards (utilization, VRAM, temperature, power) when an NVIDIA GPU is detected, recommendation banner suggesting optimal backend + model for the hardware

Model switching on vLLM/SGLang triggers the drain protocol: in-flight requests complete, the container restarts with the new model, and the UI shows the transition state.

## Build verification

```bash
cd dashboard && npm run build
```

This runs the TypeScript compiler and Vite build. A successful build confirms type safety across all components.

## Implementation notes

- **Functional components only** -- no class components; hooks and TanStack Query for all state
- **TanStack Query** -- server state management with 5-second stale time and 1 retry; provides automatic background refetching
- **Tailwind CSS** -- utility-first styling with a consistent stone/teal/amber/emerald color palette throughout
- **No client-side routing library for auth** -- admin secret is stored in localStorage and sent as a header on every request
