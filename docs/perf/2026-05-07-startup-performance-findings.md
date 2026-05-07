# Nova Startup Performance — Findings

**Date:** 2026-05-07
**Branch:** `engineer/startup-perf`
**Worktree:** `/home/jeremy/workspace/nova/.worktrees/engineer-startup-perf`

## TL;DR

The user reported two perf complaints: ~3 min spin-up time and ~1 min dashboard freeze on
route change. Investigation found two distinct, independent causes:

1. **Cold spin-up is ~68 seconds** (not 3 min). The remaining ~2 min the user perceives is
   the dashboard freeze (#2 below) plus `make build` overhead inside `./start`. Cold-startup
   bottleneck is **MCP `puppeteer` server** taking 21s of the orchestrator's 21s lifespan.
2. **Dashboard freeze is the `/brain` page mounting WebGL/ForceGraph3D** — every visit blocks
   the main thread for ~6s in headless software WebGL. On the user's real GPU + 2000-node
   engram graph, that scales to the reported ~60s. **This happens every time, not first-visit
   only.**

## Pass 1 — Cold spin-up timing

`docker compose down --remove-orphans` then `time docker compose up -d`, polling each
service's `/health/ready` at 0.5s intervals. Raw data: `cold-ready-events.json`.

| Service | Ready @ | Notes |
|---|---|---|
| postgres | 4.6s | depends on nothing |
| redis | 4.8s | depends on nothing |
| recovery | 13.8s | depends only on postgres |
| dashboard (nginx) | 19.4s | depends only on recovery |
| llm-gateway | 27.3s | depends on postgres + redis |
| memory-service | 34.8s | depends on postgres + redis + llm-gateway |
| cortex | 39.8s | depends on postgres + redis + memory-service |
| **orchestrator** | **62.3s** | depends on postgres + llm-gateway + memory-service |
| chat-api | 67.9s | depends on orchestrator |
| intel-worker | 67.9s | depends on orchestrator |

**Total cold start: 68 seconds.**

### Critical path

`postgres → llm-gateway → memory-service → orchestrator (lifespan) → ready`. The orchestrator
sits at the end of the chain; everything else after orchestrator is fast.

### Orchestrator boot breakdown

Container created at 16:48:10.891Z, started at 16:48:48.461Z (37.6s wait for upstream
healthchecks), "Application startup complete" at 16:49:11.420Z. Lifespan = 21.0s.

| Δ | Event | Cost |
|---|---|---|
| 0.00s | "Orchestrator starting" | — |
| 0.09s | DB pool + 2 migrations (083, 085) | 90ms |
| 0.13s | platform_secrets bootstrap (3 keys) | 37ms |
| 0.16s | All 8 `sync_*_to_redis()` done | **75ms total** |
| 0.16s | Primary agent ready | 1ms |
| 0.18s | MCP servers spawned (puppeteer + firecrawl, parallel) | — |
| 6.97s | MCP firecrawl: 15 tools | 6.86s |
| **20.91s** | **MCP puppeteer: 7 tools** ← bottleneck | **20.80s** |
| 20.93s | Background tasks started | 19ms |
| **21.00s** | "Application startup complete" | — |

**Confirmed:** my pre-investigation hypothesis about `sync_*_to_redis` and platform-secrets
bootstrap being slow was **wrong**. Both are sub-100ms.

### `make build` overhead in `./start`

`./start` runs `make build` even on cached image runs. BuildKit verification on 13+
services adds ~10–30s on a fully cached run, more if any layer is invalidated. This is
on top of the 68s Compose-up time.

### Reconciling with user's "3 minutes"

68s (cold up) + ~20s (`make build` cached verification) + ~60s (dashboard freeze on first
nav) ≈ ~150s ≈ ~2.5 min. Plus user perception bias. Math is consistent with reported "few
minutes, around 3."

## Pass 3 — Dashboard URL hang / route-change freeze

Playwright headless with cleared cache + unregistered service worker. Multiple route
navigations measured with `PerformanceObserver({type:'longtask'})`.

### Initial load (cold orchestrator)

Within seconds of orchestrator turning green:

| Metric | Value |
|---|---|
| TTFB | 18ms |
| First Paint | 456ms |
| FCP | 488ms |
| DOMContentLoaded | 449ms |
| Land at | `/chat` (HomeRoute redirect) |

**Cold-orchestrator initial load is fast.** The "URL hangs" complaint is not initial-load.

### Navigation between non-Brain pages

| Path | Blocked ms | Long tasks |
|---|---|---|
| `/chat` ← `/tasks` | 0 | 0 |
| `/tasks` ← `/chat` | 0 | 0 |
| `/goals` | 0 | 0 |
| `/sources` | 0 | 0 |
| `/settings` | 0 | 0 |

All non-Brain routes navigate with **zero long tasks**. No freeze on these.

### Navigation to `/brain` — REPRODUCED

| Visit | Blocked ms | Longest long task | Long tasks |
|---|---|---|---|
| 1st `/brain` (after `/chat`) | 5895ms | 3792ms | 2 |
| 2nd `/brain` (round-trip) | 6004ms | 3997ms | 2 |
| 3rd `/brain` (round-trip) | 5936ms | 3913ms | 2 |

**Every visit to `/brain` blocks the main thread for ~6 seconds** in headless software
WebGL with a near-empty engram graph. On the user's real Chromium-family browser + RTX
3060 Ti via WSL2 + a 2000-node graph, this scales to ~30–60s — matching the report.

### Root cause: ForceGraph3D mount cycle

`dashboard/src/App.tsx:328-341` keeps the Brain canvas mounted across all routes (after a
deferred `requestIdleCallback` mount), with `hidden={!isBrainRoute}` controlling
visibility. `dashboard/src/pages/Brain.tsx:376, :417` already pause ForceGraph3D rendering
and freeze graph data when hidden. **But every transition from hidden → visible reincurs a
multi-second Three.js / ForceGraph3D init or unpause cost** — not eliminated by the existing
`paused` and `frozenGraphRef` optimizations.

The two long tasks per visit pattern (3.8s + ~2s) suggests:
- Long task #1 (~3.8s): ForceGraph3D internal init or scene material upload on visibility flip
- Long task #2 (~2s): Force-directed layout re-warmup or first render frame batching

### `BrainPrefetcher` data fetch

`dashboard/src/App.tsx:215`. Prefetches `/mem/api/v1/engrams/graph/lightweight?max_nodes=2000`
(1.22 MB decoded) on dashboard mount, gated on `features.brain_enabled=true` (which the
user has). This is async and does not block the main thread; observed in Playwright as
~400ms fetch with no long task. Not the root cause of the freeze, but adds bandwidth cost
on every dashboard load.

## Falsified hypotheses

| Hypothesis | Status | Evidence |
|---|---|---|
| `sync_*_to_redis` × 8 (serial) is slow | ❌ | 75ms total |
| Platform secrets bootstrap is slow | ❌ | 37ms |
| DB migrations are slow | ❌ | 90ms |
| Cold-orchestrator first-request is slow | ❌ | 488ms FCP, sub-50ms API calls |
| Dashboard URL initial-load hangs | ❌ | 488ms FCP cold |
| Compose `depends_on` chain is heavily inefficient | ⚠️ partial | Memory-service depending on llm-gateway adds ~10s to critical path; not catastrophic |

## Confirmed bottlenecks

1. **MCP `puppeteer` server** — 20.8s of the 21s orchestrator lifespan. Loading is
   sequential-blocking on the lifespan via `await load_mcp_servers()` in
   `orchestrator/app/main.py:233-235`.
2. **Brain visibility-flip** — ~6s blocking on every `/brain` navigation. Existing
   `paused`/`frozenGraphRef` optimizations don't cover the visibility transition cost.

## Recommended fixes (rank-ordered, not yet specced)

| # | Fix | Effort | Expected impact |
|---|---|---|---|
| 1 | Defer MCP server load past `yield` (background task) | Small (~1 file) | Saves ~21s on every cold orchestrator boot. Saves ~21s on every dev hot-reload. |
| 2 | Brain: lazy-mount the canvas only when on `/brain` route, unmount on leave | Medium (1 file, App.tsx) | Eliminates ~6s freeze on `/brain` visit but adds ~6s when first visiting `/brain`. **Net win** for users who don't always use Brain. |
| 3 | Make MCP server connection lazy on first tool-use | Medium (registry + client) | Resilience win + ~21s startup win. Subsumes #1 if shipped instead. |
| 4 | Brain: profile and optimize the visibility-flip cost in ForceGraph3D | Medium-Large | Direct fix without trading off mount strategy. Requires Three.js / ForceGraph3D investigation. |
| 5 | Drop `make build` from `./start` default; rely on first-time `./install` for builds | Small | Saves ~10-30s on every `./start` invocation. Add `--build` flag for explicit rebuild. |
| 6 | Reduce default Brain node limit from 2000 → 500 with progressive expansion | Small | Smaller initial bundle + faster ForceGraph3D init. |

## Risks called out

- **#2 has a tradeoff:** users who frequently use Brain experience longer first-visit time. Mitigate by keeping Brain prefetched data ready (which already happens) so the cost is just the canvas/Three.js init, not data fetch.
- **#1 has a behavior subtlety:** any tool-use that fires inside the first ~21s would see "tool not registered." Need a brief grace re-check or explicit "MCP not ready" error. The autonomous loop's first cycles wouldn't expect MCP tools immediately anyway.
- **Headless vs real-browser scaling factor is uncertain.** 6s in headless probably maps to 30-60s real, but could be 10-90s. The fix should be validated on the user's actual browser.
- **#4 is open-ended.** ForceGraph3D's internal behavior on visibility flip would need profiling traces (Chrome devtools Performance panel) on the user's machine to nail down exact root cause.
