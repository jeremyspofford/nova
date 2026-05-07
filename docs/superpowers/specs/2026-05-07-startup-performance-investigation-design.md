---
title: Nova Startup Performance Investigation
date: 2026-05-07
branch: engineer/startup-perf
worktree: .worktrees/engineer-startup-perf
status: investigation
roles: [performance, sre, backend, frontend, cloud]
---

# Nova Startup Performance Investigation — Design

## Problem

`./start` (warm-cache, no `--rebuild`) takes ~3 minutes from invocation until
the dashboard at `http://localhost:3000` is interactive on first open. Two
distinct symptoms inside that window:

1. **Stack spin-up:** time from `./start` invocation until the script prints
   "Nova is running" (orchestrator `/health/ready` returns 200).
2. **URL-open hang:** user-perceived blank/loading time from opening
   `http://localhost:3000` until the dashboard renders its first content.

Goal: identify the top 1–2 bottlenecks in each window with measurements,
then propose targeted fixes — not rewrite the world.

## Pre-investigation hypotheses

From a static read of the code (no measurements yet), the dominant suspects:

- **Orchestrator lifespan is gated by ~16 sequential `await`s**
  (`orchestrator/app/main.py:157-306`):
  - `init_db()` — Postgres pool + idempotent SQL migrations (40+ files).
  - `_bootstrap_platform_secrets_from_env()` — 13 keys × 2 DB queries each,
    serial (`main.py:33-101`).
  - 8 separate `sync_*_to_redis()` calls in serial (`main.py:215-222`).
  - `load_mcp_servers()` — subprocess spawn + connect for each MCP server.
  - Feature-flag cache warm + pubsub subscriber start.
- **Compose `depends_on: condition: service_healthy` chain** with
  `start_period` up to 120s for some services and `interval: 5s`
  healthchecks. Multi-level chain serializes service starts.
- **Dashboard initial render is gated by `OnboardingGate`**
  (`dashboard/src/App.tsx:138`): `if (!checked) return null` until
  `/api/v1/config/onboarding.completed` returns. Combined with `AuthGate`'s
  auth-config fetch, the first paint waits for two serial orchestrator
  round-trips.
- App-shell is *optimistic* (`App.tsx:349`, `useState(true)`) — the blank
  screen on URL open is **not** the explicit StartupScreen; it's the gates'
  serial fetch waterfall over a cold orchestrator.

These are hypotheses, not findings. The investigation tests them.

## Scope

In:
- Warm-path startup (cached images, existing `./data/postgres` and
  `./data/redis` volumes).
- Production-style URL load (port 3000 / nginx) — the URL `./start` prints.
- Orchestrator lifespan as the gating service for `./start`'s wait loop.
- Dashboard initial render path: app shell → auth → onboarding → home redirect → first page.

Out:
- Cold/`--rebuild` path (first install or layer cache invalidation) —
  different problem class; revisit if findings warrant.
- Vite dev path (port 5173) — user is on production path.
- Steady-state perf (request latency under load) — different concern.
- **Code changes during measurement** — measurement only; fixes get a
  separate spec/plan after findings.

## Methodology

Three measurement passes. Each writes raw evidence under
`data/perf-investigation/2026-05-07/`. The directory is gitignored to keep
ephemeral logs out of git history; the synthesized markdown findings are
checked in.

### Pass 1 — Compose-up timing

- Confirm clean state: `docker compose ps` empty + `docker compose down
  --remove-orphans`.
- Start a background per-service `/health/ready` poll (1s granularity, 240s
  budget) that records the first-200 timestamp per service.
- `time docker compose up -d` (run from `/home/jeremy/workspace/nova` main
  checkout, NOT the worktree, so existing data volumes are reused — running
  from the worktree would point at empty `./data/postgres` and produce a
  cold-path measurement).
- After orchestrator ready, capture `docker compose logs <service> --since`
  for per-service lifespan markers.

**Output:** a service-by-service ready-time table; identifies the critical
path through the dependency chain.

### Pass 2 — Orchestrator lifespan profile

- Hypothesis: lifespan is dominated by serial `sync_*_to_redis()` (8 calls),
  platform-secrets bootstrap (13 keys × 2 DB queries), MCP server connects,
  and migration runtime.
- Approach: read orchestrator logs in real time with `LOG_LEVEL=DEBUG`,
  capture log timestamps. If log granularity is insufficient, apply a
  one-shot uncommitted patch to `orchestrator/app/main.py` lifespan that
  logs `time.monotonic()` deltas around each step. The patch is reverted
  before any commit lands.

**Output:** per-step lifespan time table with `file:line` references.

### Pass 3 — Dashboard URL-load waterfall

- Use Playwright MCP to open `http://localhost:3000` cold (fresh browser
  context, cleared cache). Capture network requests with timing,
  Performance API entries (FP, FCP, LCP), and console messages.
- Identify the longest fetch and the longest blocking gap between render
  cycles. Match against the `OnboardingGate` / `AuthGate` hypothesis.

**Output:** waterfall diagram + finding on whether the hang is gate-fetch
serialization vs cold orchestrator response time vs JS bundle parse.

## Deliverables

Under `data/perf-investigation/2026-05-07/`:

- `compose-timing.md` — Pass 1 raw timing + commentary
- `orchestrator-lifespan.md` — Pass 2 per-step lifespan time
- `dashboard-waterfall.md` — Pass 3 Playwright capture analysis
- `findings.md` — synthesis: top 1–2 bottlenecks with evidence, recommended
  fix scope (size, effort, expected improvement)

## Acceptance criteria (role-flavored)

- **performance:** every bottleneck claim has a measurement attached.
  No "probably slow because" without numbers.
- **sre:** orchestrator lifespan time is broken down per step, not as a
  single number.
- **backend:** at least one concrete `file:line` reference for the
  dominant lifespan cost.
- **frontend:** dashboard waterfall identifies whether the hang is in
  app-shell fetches (Auth/OnboardingGate) vs cold orchestrator response
  time vs JS parse.
- **cloud:** Compose `depends_on` chain is mapped; any unnecessary
  serialization is explicitly called out.

## Deliberately NOT in scope

- Writing fixes. Findings recommend fix scope; actual fix is a separate
  spec/plan.
- Tuning steady-state perf.
- Cold-path / `--rebuild` measurement.
- Refactoring the lifespan into a different async architecture.

## Risks

- **~3 min per cycle.** ≥3 cycles required, so ~1h wall-clock minimum.
  Instrument once before re-running.
- **Findings might surprise.** If the dominant cost is host disk I/O on
  WSL2 bind-mounts, the recommendation shifts host-side and nothing in
  `main.py` matters. Findings will say so.
- **Playwright MCP cold-cache fidelity.** First run may need verification
  that we're not measuring a warm browser cache.
