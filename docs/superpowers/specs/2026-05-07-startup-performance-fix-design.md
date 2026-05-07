---
title: Nova Startup Performance — Fix Design
date: 2026-05-07
branch: engineer/startup-perf
worktree: .worktrees/engineer-startup-perf
status: spec
roles: [backend, frontend, cicd, performance, sre]
references:
  findings: docs/perf/2026-05-07-startup-performance-findings.md
  investigation_spec: docs/superpowers/specs/2026-05-07-startup-performance-investigation-design.md
---

# Nova Startup Performance — Fix Design

## Problem

Investigation (`docs/perf/2026-05-07-startup-performance-findings.md`) confirmed two
distinct, independent bottlenecks:

1. **Orchestrator lifespan = 21s, of which 20.8s is `await load_mcp_servers()`**
   (puppeteer MCP server spawn + tool-discovery handshake). Blocks `/health/ready` from
   responding 200 until MCP loading completes.
2. **`/brain` route navigation blocks the main thread ~6s** in headless software WebGL,
   scaling to ~30–60s on the user's RTX 3060 Ti via WSL2 with a 2000-node engram graph.
   Existing `paused`/`frozenGraphRef` optimizations in `Brain.tsx` don't cover the
   visibility-flip cost. Today the canvas pre-mounts on every dashboard load via
   `requestIdleCallback`, paying the cost even for users who never visit `/brain`.

Plus a workflow opportunity: the user's daily flow runs `make build` every restart,
adding ~30s of redundant BuildKit overhead per cycle. `compose watch` + uvicorn
`--reload` already handle daily Python edits without rebuild, but this isn't surfaced.

## Goals

- Cold orchestrator `/health/ready` ≤ 5s after lifespan start (down from 21s)
- Zero main-thread blocking on dashboard route changes other than `/brain`
- `/brain` mount cost paid only when user navigates there (not pre-rendered)
- Default `/brain` node count tuned for fast first paint, with clear progressive expansion path
- A Make target for the "clean restart, no rebuild" path the user wants daily

## Out of scope

- Compose dependency-chain restructuring (memory-service depending on llm-gateway). Adds ~10s but not catastrophic; revisit if other fixes don't move the needle enough.
- ForceGraph3D internal optimization (Three.js scene tuning). Separate investigation if needed.
- vLLM / SGLang `start_period: 120s` tuning — only relevant if those profiles are active, which they aren't in the user's `.env`.
- Service-worker caching strategy improvements.

## Fix #1 — Defer MCP server load past lifespan yield

**Owner:** backend
**File:** `orchestrator/app/main.py` (around lines 233–235)

### Change

Replace the blocking `await load_mcp_servers()` with a background task. Lifespan yields
immediately; MCP load completes asynchronously and logs the same "MCP servers loaded"
message when done.

```python
# BEFORE (lifespan, lines 233-235)
from app.pipeline.tools import load_mcp_servers
mcp_count = await load_mcp_servers()
log.info("MCP servers loaded: %d connected", mcp_count)

# AFTER
async def _load_mcp_background():
    try:
        mcp_count = await load_mcp_servers()
        log.info("MCP servers loaded: %d connected", mcp_count)
    except Exception:
        log.exception("MCP server load failed (background task)")

_mcp_load_task = asyncio.create_task(_load_mcp_background(), name="mcp-load")
```

Add `_mcp_load_task` to the existing shutdown-cancel block (around lines 320–333).

### Graceful tool-use during the ~21s window

During the post-yield window, MCP-provided tools (puppeteer / firecrawl) are not yet
registered. To handle gracefully:

- **v1 (this fix):** ship the simple defer. If a Quartet pipeline run fires in the first
  21s and tries to call an MCP tool, it sees "tool not registered" and falls back per
  existing tool-not-found behavior. Acceptable because:
  - The autonomous loop's first cycle is at minimum 30s after orchestrator boot (cortex
    has its own startup delay).
  - User-initiated tasks within 21s of orchestrator boot are vanishingly rare.
- **v2 (follow-up if needed):** add an `asyncio.Event` `mcp_ready` set on completion,
  and `await mcp_ready.wait()` (with timeout) at tool-dispatch time when a requested
  MCP tool isn't yet registered. Defer until we observe a real failure in the first
  21s of uptime.

### Acceptance criteria

- `/health/ready` returns 200 within 5s of "Orchestrator starting" (down from 21s).
- "Application startup complete" log appears within 1s of lifespan yield.
- "MCP servers loaded: 2 connected" still appears within ~22s of startup.
- `make test` integration suite passes without regression.
- Graceful shutdown still cancels `_mcp_load_task` without hangs.

## Fix #2 — Lazy-mount Brain canvas only on `/brain` route

**Owner:** frontend
**File:** `dashboard/src/App.tsx` (`RoutedContent`, `BrainPrefetcher`, lines 246–341)

### Change

Today the Brain WebGL canvas mounts in a hidden div across **all** routes after a
`requestIdleCallback`-deferred initial mount. Replace this with a true conditional
render based on `isBrainRoute`. Drop the `brainMounted` state and the
`requestIdleCallback` mount effect entirely. `BrainPrefetcher` moves to fire only on
`/brain` route mount.

```tsx
// AFTER (replaces the brainMounted block at lines 328-341)
{isBrainRoute && brainEnabled && (
  <div className="fixed inset-0 z-[5]">
    <AppLayout fullWidth>
      <ErrorBoundary>
        <Brain hidden={false} />
      </ErrorBoundary>
    </AppLayout>
  </div>
)}
```

`BrainPrefetcher` stays in the tree but its `useEffect` now checks `isBrainRoute` (or
moves inside Brain.tsx itself, since the lazy-mount means Brain renders only when
needed).

### Trade-offs

- First `/brain` visit pays the full mount cost (~6s headless / 30–60s real). Subsequent
  visits in the same session re-mount and pay the same cost.
- Users who never visit `/brain` pay zero cost. (Today, the persistent hidden mount
  consumes a 1665×1949 WebGL context's worth of GPU memory regardless.)
- The `frozenGraphRef` and `paused` optimizations in `Brain.tsx` remain useful for the
  "user is on `/brain` and toggles search/filter" case.

### Acceptance criteria

- Playwright navigation `/chat → /tasks → /goals → /sources → /settings` reports zero
  long-tasks (> 50 ms) attributable to Brain mounting (current pass shows zero already
  — fix protects this baseline against future regression).
- Navigation to `/brain` works: canvas appears, engram graph loads, interactive.
- Navigating away from `/brain` unmounts the canvas: assert
  `document.querySelectorAll('canvas').length === 0` from a non-`/brain` page.
- Brain feature-flag toggle (off → reload → /brain shows the disabled CTA, no canvas).
- No regression in `/brain` feature behavior (search, filters, node selection, settings
  panel).

## Fix #3 — `make restart` + Makefile dev workflow docs

**Owner:** cicd
**File:** `Makefile`

### Change

Add a `restart` target for the "stop the stack, bring it back up, no rebuild" path the
user wants daily. Update `dev` target's help text to surface watch behavior so users
know they don't need `make build` for daily Python edits.

```makefile
# AFTER
restart: ## Stop and start all services without rebuilding (preserves cached images)
	$(COMPOSE) down --remove-orphans
	$(COMPOSE) up -d

dev: ## Start all services + Vite dashboard (Python hot-reload via --reload + compose watch; Vite HMR)
	$(COMPOSE) --profile website up -d --remove-orphans
	cd $(DASHBOARD) && npm run dev
```

Optional polish: add a comment block at the top of the Make targets section explaining
"when do I need `make build`?" — only on `pyproject.toml` / Dockerfile / system-package
changes. Daily Python and React edits hot-reload automatically.

### Acceptance criteria

- `make help` shows the new `restart` entry.
- `make restart` returns 0 against a running stack and the stack remains healthy.
- `make help` for `dev` mentions hot-reload behavior.

## Fix #4 — Brain progressive node expansion

**Owner:** frontend
**File:** `dashboard/src/pages/Brain.tsx`

### Change

Default `nodeLimit` from 2000 → 500 for first paint. Add an in-Brain HUD control
(button or slider) to expand to 1000, 2000, or 5000. Persist user's selection across
sessions via `localStorage`.

The default lower-bound directly cuts ForceGraph3D init cost on first `/brain` visit
(force-layout simulation runtime scales superlinearly with node count). Users with
rich engram graphs can opt up.

### Acceptance criteria

- Default `nodeLimit` is 500 on first-ever visit (no localStorage entry).
- HUD shows a control for selecting node limit (500 / 1000 / 2000 / 5000).
- Selecting a different limit triggers refetch and re-renders the WebGL scene.
- `localStorage` persists the selection across page reloads.
- First-paint to interactive on `/brain` with default 500 nodes ≤ 2s longest long-task
  in Playwright headless (vs. ~4s today with 2000 nodes).

## Sequencing

The four fixes are mostly independent. Recommended order to ship:

1. **Fix #3** first — Makefile change is trivial, immediate user-visible win, no risk.
2. **Fix #1** second — orchestrator MCP defer. Largest single startup-time win.
3. **Fix #2** third — Brain lazy-mount. Largest UX win for users not using Brain.
4. **Fix #4** fourth — depends on Fix #2's cleanup pattern; small follow-up.

All four can ship in the same PR, separated by commits per fix. If any single fix
fails review, the others land independently.

## Acceptance test plan

After all four ship:

1. Cold restart with `make restart` (or `make down && make dev`); time `/health/ready`
   first-200 — expect ≤ 45s (currently 62s).
2. Playwright headless: navigate `/chat → /tasks → /goals` with `PerformanceObserver`
   — expect zero long-tasks.
3. Playwright headless: navigate `/chat → /brain` with default 500 nodes — expect
   longest long-task ≤ 2s.
4. `make restart` returns successfully; stack stays healthy.
5. `./start` (unmodified) still works for the production-style boot path.

## Risks

- **Fix #1:** if a tool-use fires in the first 21s and needs an MCP tool, it falls back
  to "tool not registered." We accept this in v1 because the user-initiated-task-in-21s
  case is rare. If real failures observed, ship v2 with `mcp_ready` Event + grace.
- **Fix #2:** first `/brain` visit pays the full mount cost on click (vs. pre-rendered).
  The user has `brain_enabled=true`, so they DO use Brain. Could feel like a regression
  on first click. Offset: removes the hidden mount's GPU memory + pre-load tax for
  every other user (and for the user when they're not on Brain).
- **Fix #4:** 500 nodes might feel sparse for users with rich engram graphs. Discoverable
  expand control is the mitigation; verify the control is visible without scrolling.
- **General:** Playwright headless × real browser performance ratio is not 1.0. The
  acceptance criteria use Playwright as a *regression* baseline, not as a stand-in for
  real-hardware perf measurement. Real-hardware verification is the user's manual smoke
  test on their RTX 3060 Ti.
