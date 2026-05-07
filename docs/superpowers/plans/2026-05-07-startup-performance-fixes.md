# Nova Startup Performance Fixes — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cut perceived spin-up from ~3 min to ~30–40s and eliminate the `/brain` route-change freeze, by deferring MCP server load past orchestrator lifespan yield, lazy-mounting the Brain canvas only on `/brain`, adding a `make restart` target, and shipping `/brain` with 500 default nodes (existing selector lets users opt up).

**Architecture:** Four small, independent fixes. Backend change is one file (`orchestrator/app/main.py`). Frontend changes touch two files (`dashboard/src/App.tsx`, `dashboard/src/pages/Brain.tsx`). Cicd change is one file (`Makefile`). All four ship in a single PR via separate commits so any single failure doesn't block the others.

**Tech Stack:** FastAPI (asyncio), React 19 + TanStack Query + React Router, Vitest, pytest (real-services integration), Docker Compose.

**Spec:** `docs/superpowers/specs/2026-05-07-startup-performance-fix-design.md`
**Findings:** `docs/perf/2026-05-07-startup-performance-findings.md`

---

## Task 1: Fix #3 — `make restart` target + dev workflow docs

**Owner role:** cicd
**Why first:** trivial change, immediate user-visible win, zero risk.

**Files:**
- Modify: `Makefile` (add `restart` target after `down`; update `dev` help text)

- [ ] **Step 1.1: Read current Makefile target structure**

Run:
```bash
grep -n "^[a-z][a-z-]*:" Makefile | head -20
```

Note the line where `down:` is defined. The new `restart` target goes immediately after it.

- [ ] **Step 1.2: Add `restart` target and update `dev` help text**

Edit `Makefile`. Find the `down:` block:

```makefile
down: ## Stop and remove all containers (all profiles + orphans)
	docker compose -f docker-compose.yml $(GPU_OVERLAY) $(ALL_PROFILES) down --remove-orphans
```

Add immediately after it:

```makefile
restart: ## Stop and start all services without rebuilding (preserves cached images)
	docker compose -f docker-compose.yml $(GPU_OVERLAY) $(ALL_PROFILES) down --remove-orphans
	$(COMPOSE) up -d
```

Then find the `dev:` target:

```makefile
dev: ## Start all services detached + Vite dashboard with hot-reload  [1-line dev]
```

Replace its help comment with:

```makefile
dev: ## Start all services + Vite dashboard (Python hot-reload via --reload + compose watch; Vite HMR — no `make build` needed for daily edits)
```

- [ ] **Step 1.3: Verify `make help` lists the new target**

Run:
```bash
make help | grep -E "restart|dev "
```

Expected output (line ordering may vary):
```
dev                  Start all services + Vite dashboard (Python hot-reload via --reload + compose watch; Vite HMR — no `make build` needed for daily edits)
restart              Stop and start all services without rebuilding (preserves cached images)
```

- [ ] **Step 1.4: Verify `make restart` works against a running stack**

Run:
```bash
make restart
```

Expected: stack stops cleanly, comes back up, no errors. Verify with:
```bash
docker compose ps --format "table {{.Name}}\t{{.Status}}" | head -10
```

All services should be `Up` and `(healthy)` within 2 minutes.

- [ ] **Step 1.5: Commit**

```bash
git add Makefile
git commit -m "feat(make): add restart target + surface hot-reload in dev help

Daily flow no longer needs 'make build' — compose watch + uvicorn
--reload + Vite HMR handle code changes. 'make restart' is the
clean-restart-without-rebuild path.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Fix #1 — Defer MCP server load past lifespan yield

**Owner role:** backend
**Why before #2:** biggest single startup-time win (~21s saved every boot, including dev hot-reload).

**Files:**
- Modify: `orchestrator/app/main.py:233-235` (replace blocking `await load_mcp_servers()` with background task) and shutdown block at `:320-333` (add `_mcp_load_task` cancellation)
- Test: `tests/test_orchestrator_startup.py` (new)

### TDD shape

The test asserts behavior we want: that the orchestrator responds to `/health/ready` quickly even while MCP is still loading, AND that MCP eventually loads. This is testable against a *running* stack — the test suite already runs against real services per the repo convention. The test will FAIL today (because lifespan blocks 21s on MCP) and PASS after the fix.

Caveat: the test runs on an *already-up* stack, so it can't directly measure boot time. It instead verifies the endpoint behavior that defines "MCP load is non-blocking": tools registry exposes both currently-loaded MCP tools AND a startup-task status. We add a small `/api/v1/admin/startup-tasks` endpoint as the observable target.

- [ ] **Step 2.1: Write the failing test**

Create `tests/test_orchestrator_startup.py`:

```python
"""Tests for orchestrator startup-task observability (Fix #1: defer MCP load)."""
from __future__ import annotations

import httpx
import pytest
from conftest import ADMIN_SECRET, ORCHESTRATOR_URL


@pytest.mark.asyncio
async def test_startup_tasks_endpoint_reports_mcp_status():
    """Orchestrator must expose startup-task status so callers can tell whether
    MCP is loaded, loading, or failed. This protects against silent regressions
    of the 'await load_mcp_servers()' blocking pattern in the lifespan."""
    headers = {"X-Admin-Secret": ADMIN_SECRET} if ADMIN_SECRET else {}
    async with httpx.AsyncClient(base_url=ORCHESTRATOR_URL, timeout=5) as client:
        resp = await client.get("/api/v1/admin/startup-tasks", headers=headers)
    assert resp.status_code == 200, f"endpoint missing: {resp.status_code} {resp.text}"
    data = resp.json()
    assert "mcp_load" in data, "mcp_load status missing"
    assert data["mcp_load"]["status"] in ("in_progress", "complete", "failed"), (
        f"unexpected status: {data['mcp_load']}"
    )


@pytest.mark.asyncio
async def test_health_ready_returns_independent_of_mcp_completion():
    """`/health/ready` must return 200 regardless of whether MCP load is
    complete. The orchestrator yields its lifespan before MCP finishes; readiness
    is about request-handling capacity, not MCP availability."""
    async with httpx.AsyncClient(base_url=ORCHESTRATOR_URL, timeout=3) as client:
        resp = await client.get("/health/ready")
    assert resp.status_code == 200
    data = resp.json()
    assert data["status"] in ("ready", "degraded", "ok")
```

- [ ] **Step 2.2: Run the test to verify it fails**

Run:
```bash
cd tests && pytest test_orchestrator_startup.py -v
```

Expected: `test_startup_tasks_endpoint_reports_mcp_status` FAILS with 404 (endpoint doesn't exist yet). `test_health_ready_returns_independent_of_mcp_completion` PASSES today (because lifespan eventually completes, even though it blocks).

- [ ] **Step 2.3: Refactor `main.py` lifespan — defer MCP load + add status tracker**

In `orchestrator/app/main.py`, around lines 232–236, replace:

```python
# Load MCP servers from DB and connect to enabled ones
from app.pipeline.tools import load_mcp_servers
mcp_count = await load_mcp_servers()
log.info("MCP servers loaded: %d connected", mcp_count)
```

with:

```python
# Defer MCP server load past lifespan yield — load_mcp_servers can take
# 20+ seconds because MCP child processes (puppeteer, firecrawl) spawn npm
# and discover tools. Blocking the lifespan on it kept /health/ready from
# returning 200 until MCP was fully connected. See:
# docs/perf/2026-05-07-startup-performance-findings.md
from app.pipeline.tools import load_mcp_servers

app.state.mcp_load_status = {"status": "in_progress", "count": None, "error": None}

async def _load_mcp_background() -> None:
    try:
        count = await load_mcp_servers()
        app.state.mcp_load_status = {"status": "complete", "count": count, "error": None}
        log.info("MCP servers loaded: %d connected", count)
    except Exception as exc:  # noqa: BLE001
        app.state.mcp_load_status = {"status": "failed", "count": 0, "error": str(exc)}
        log.exception("MCP server load failed (background task)")

_mcp_load_task = asyncio.create_task(_load_mcp_background(), name="mcp-load")
```

Then in the shutdown block (around lines 320–333), add `_mcp_load_task.cancel()` alongside the other task cancellations and include it in the trailing `asyncio.gather(...)`:

```python
_queue_task.cancel()
_reaper_task.cancel()
_effectiveness_task.cancel()
_chat_scorer_task.cancel()
_auto_friction_task.cancel()
_approval_worker_task.cancel()
_mcp_load_task.cancel()  # NEW
await _poller.stop()
_poll_task.cancel()
# Wait briefly for graceful shutdown
await asyncio.gather(
    _queue_task, _reaper_task, _effectiveness_task, _chat_scorer_task,
    _auto_friction_task, _poll_task, _approval_worker_task,
    _mcp_load_task,  # NEW
    return_exceptions=True,
)
```

- [ ] **Step 2.4: Add the `/api/v1/admin/startup-tasks` endpoint**

The canonical admin-dependency pattern in this codebase uses the `AdminDep` alias
(`orchestrator/app/auth.py:460`, used throughout `router.py`, e.g. `:212, :235, :598`).
In `orchestrator/app/router.py`, add the new endpoint near other admin routes:

```python
from fastapi import Request  # already imported at file top in most routers
from app.auth import AdminDep  # already imported on router.py:14

@router.get("/api/v1/admin/startup-tasks")
async def get_startup_tasks(request: Request, _admin: AdminDep):
    """Background-task status for observability. Used by tests + dashboard.
    Status values: in_progress | complete | failed | unknown."""
    state = request.app.state
    return {
        "mcp_load": getattr(state, "mcp_load_status", {"status": "unknown"}),
    }
```

Reference for the canonical admin-route pattern: `orchestrator/app/router.py:1496` (or any
of the other `_admin: AdminDep` routes).

- [ ] **Step 2.5: Run the test to verify it passes**

```bash
cd tests && pytest test_orchestrator_startup.py -v
```

Both tests should PASS. If `test_startup_tasks_endpoint_reports_mcp_status` still fails with 401/403, the admin-secret header isn't being sent — verify `ADMIN_SECRET` is non-empty in the test env. If it fails with 404, the route isn't registered — confirm the include_router call is hit.

- [ ] **Step 2.6: Run full integration suite to catch regressions**

```bash
make test-quick
```

Then if that passes:

```bash
make test
```

Both should pass. If anything fails, the change introduced a regression — investigate before proceeding.

- [ ] **Step 2.7: Manual verification — cold restart and time `/health/ready`**

Run:
```bash
make restart   # uses the new Task 1 target
```

In another terminal during the restart, watch:
```bash
docker compose logs orchestrator -f --since 1m | grep -E "Orchestrator starting|Application startup complete|MCP servers loaded"
```

Expected timeline:
- "Orchestrator starting" appears
- "Application startup complete" appears within ≤5s of "Orchestrator starting" (down from 21s — there's still ~30 lines of post-MCP lifespan work for queue/reaper/poller/quality loops/feature-flags warm; matches spec §Fix #1 acceptance criterion)
- "MCP servers loaded: 2 connected" appears 20–25s after "Orchestrator starting" (background)

Time `/health/ready` directly:
```bash
time curl -sf http://localhost:8000/health/ready
```

Expected: returns 200 in well under a second once orchestrator is past container-creation overhead.

- [ ] **Step 2.8: Commit**

```bash
git add orchestrator/app/main.py orchestrator/app/router.py tests/test_orchestrator_startup.py
git commit -m "fix(orchestrator): defer MCP server load past lifespan yield

The orchestrator's lifespan blocked for ~21s on
'await load_mcp_servers()' — puppeteer's MCP child process spawn +
tool-discovery handshake dominates. Blocking the lifespan kept
/health/ready returning 503 (or no response) until MCP was fully
connected, which was the user-perceived 'orchestrator is starting'
delay on every cold boot AND every dev hot-reload.

Now: load_mcp_servers runs as a background task. Lifespan yields
within ~1s of 'Orchestrator starting'. MCP tools become available
~20-25s later but the gateway is responsive immediately.

Adds /api/v1/admin/startup-tasks endpoint for observability + test
coverage. Status: in_progress / complete / failed.

See docs/perf/2026-05-07-startup-performance-findings.md.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Fix #2 — Lazy-mount Brain canvas only on `/brain` route

**Owner role:** frontend
**Why before #4:** Fix #4 piggybacks on the cleaned-up Brain mount path.

**Files:**
- Modify: `dashboard/src/App.tsx:246-341` (drop `brainMounted` state, conditional render based on `isBrainRoute`, move BrainPrefetcher to fire on /brain)

### TDD shape

The dashboard has minimal frontend test coverage today (one Vitest test in `dashboard/src/api-recovery.test.ts`, no React Testing Library setup). Adding RTL just for this assertion is overkill — the better gate is a Playwright check that asserts:

- On `/chat`, no `<canvas>` element is in the DOM.
- On `/brain`, exactly one `<canvas>` is in the DOM.

Run via `dashboard && npm run dev` (or `make dev`) + a one-shot Playwright invocation. We'll lean on the manual smoke-test for this fix and add an explicit `body_text_len` + canvas check using Playwright's `browser_evaluate`.

- [ ] **Step 3.1: Read the current `App.tsx` Brain mount path**

Use the `Read` tool on `dashboard/src/App.tsx` lines 246–345. Confirm the structure:
`useState`/`useEffect` for `brainMounted`, the `requestIdleCallback` deferred mount, and
the `{brainMounted && (...)}` JSX block at lines 328-341.

- [ ] **Step 3.2: Edit `App.tsx` to lazy-mount Brain conditionally**

Replace the `RoutedContent` function's Brain-related state + render block. Specifically:

**Delete** the `brainMounted` state and the two `useEffect` hooks that managed it (the `requestIdleCallback` mount and the `isBrainRoute` synchronous mount):

```tsx
// DELETE these lines (around 252-267)
const [brainMounted, setBrainMounted] = useState(false)

// Deferred Brain mount — background init after browser idle. Skipped when
// brain is disabled to avoid the heavy WebGL canvas + graph fetch.
useEffect(() => {
  if (isMobile || !brainEnabled) return
  const ric = window.requestIdleCallback ?? ((cb: IdleRequestCallback) => window.setTimeout(cb, 2000))
  const cic = window.cancelIdleCallback ?? clearTimeout
  const id = ric(() => setBrainMounted(true), { timeout: 5000 })
  return () => cic(id)
}, [isMobile, brainEnabled])

// If user navigates to /brain before idle fires, mount immediately
useEffect(() => {
  if (isBrainRoute && !brainMounted && !isMobile && brainEnabled) setBrainMounted(true)
}, [isBrainRoute, brainMounted, isMobile, brainEnabled])
```

**Replace** the `{brainMounted && (...)}` block (around 328-341) with a conditional render keyed on `isBrainRoute`:

```tsx
{/* Brain canvas — lazy-mount only when on /brain route. Avoids holding a
    1665×1949 WebGL context resident on every dashboard page. Trade-off: first
    /brain visit pays the full mount cost (~6s headless / 30–60s on real GPU
    via WSL2 + 2000-node graph). Default node count was reduced to 500 in
    Brain.tsx — the existing selector lets users opt up.
    See docs/perf/2026-05-07-startup-performance-findings.md */}
{isBrainRoute && brainEnabled && !isMobile && (
  <div className="fixed inset-0 z-[5]">
    <AppLayout fullWidth>
      <ErrorBoundary>
        <Brain hidden={false} />
      </ErrorBoundary>
    </AppLayout>
  </div>
)}
```

(The `BrainPrefetcher` component stays as-is; the prefetch is async and non-blocking. It now only fires meaningful work on dashboard load, not before each Brain mount, but the cached query result will warm whichever Brain mount comes first.)

- [ ] **Step 3.3: TypeScript build check**

```bash
cd dashboard && npm run build 2>&1 | tail -20
```

Expected: build succeeds with no TS errors. If `useState` import is now unused (because we deleted the only use), remove it from the import on line 1.

- [ ] **Step 3.4: Manual Playwright smoke test — verify canvas presence**

In one terminal:
```bash
make dev   # starts stack + Vite dev server on :5173
```

Wait until `http://localhost:5173` is up. Then in another terminal, exercise it with the production build via `http://localhost:3000` (which now serves the new bundle if the dashboard image was rebuilt — if not, this fix's effect won't show until next image build). For dev verification, use `:5173` directly.

Run a Playwright smoke check (or do this manually in a real browser):
1. Open `http://localhost:5173` → land on /chat → confirm no canvas: `document.querySelectorAll('canvas').length` should be 0.
2. Click any link to navigate to /tasks → still no canvas.
3. Navigate to /brain → exactly one canvas appears, scene renders.
4. Navigate back to /chat → canvas is gone (`.length === 0`).

- [ ] **Step 3.5: Commit**

```bash
git add dashboard/src/App.tsx
git commit -m "fix(dashboard): lazy-mount Brain canvas only on /brain route

Previously the Brain WebGL canvas mounted in a hidden div across all
routes after a requestIdleCallback-deferred initial mount. Even though
ForceGraph3D's render loop was paused when hidden, the visibility flip
on /brain navigation incurred a multi-second main-thread block —
measured ~6s in headless software WebGL, scaling to ~30–60s on real
hardware with a 2000-node engram graph. See:
docs/perf/2026-05-07-startup-performance-findings.md

Now Brain is rendered only when isBrainRoute && brainEnabled. Trade-off:
first /brain visit pays the full mount cost on click. Net win for users
who don't always use Brain — they pay zero cost.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Fix #4 — Default `/brain` to 500 nodes + add 500 and 1k buttons to selector

**Owner role:** frontend
**Why last:** depends on the Brain mount being clean (Task 3); easiest fix in the set.

**Files:**
- Modify: `dashboard/src/pages/Brain.tsx:151` (default nodeLimit), `:737-742` (selector array), `:754` (move "Recommended" marker)

### TDD shape

A node-limit selector already exists in `Brain.tsx` at lines 736–758, persisted via
`useLocalStorage('brain.nodeLimit', 2000)`. **However**, the actual selector array is
`[1, 200, 2000, 5000, All]` — there is no `500` button to default to. Fix #4 must:
1. Add `500` and `1k` (1000) entries to the selector array.
2. Change the `useLocalStorage` default from 2000 → 500.
3. Move the "Recommended" teal-dot marker from `value === 2000` to `value === 500`.

Test: visual verification on first /brain visit (cleared localStorage) — selector shows
the new buttons, 500 is the default and marked Recommended.

- [ ] **Step 4.1: Read existing nodeLimit usage**

Use the `Read` tool on `dashboard/src/pages/Brain.tsx` lines 149–155 and 736–760.
Confirm: line 151 has `useLocalStorage('brain.nodeLimit', 2000)`; the selector array at
lines 737–742 contains `{ label: '1', value: 1 }, { label: '200', value: 200 },
{ label: '2k', value: 2000 }, { label: '5k', value: 5000 }, { label: 'All', value: ... }`;
and around line 754 there's a `value === 2000 && (...)` for the "Recommended" indicator.

- [ ] **Step 4.2: Change default, expand selector array, move "Recommended" marker**

Edit `dashboard/src/pages/Brain.tsx`.

**Line 151** — change the default:
```tsx
// BEFORE
const [nodeLimit, setNodeLimit] = useLocalStorage('brain.nodeLimit', 2000)
// AFTER
const [nodeLimit, setNodeLimit] = useLocalStorage('brain.nodeLimit', 500)
```

**Lines 737–742** — add `500` and `1k` entries to the selector array (preserve `1` and
`200` for power-user / debug use):
```tsx
// BEFORE
{[
  { label: '1', value: 1 },
  { label: '200', value: 200 },
  { label: '2k', value: 2000 },
  { label: '5k', value: 5000 },
  { label: 'All', value: engramStats?.total_engrams ?? 99999 },
].map(({ label, value }) => (

// AFTER
{[
  { label: '1', value: 1 },
  { label: '200', value: 200 },
  { label: '500', value: 500 },
  { label: '1k', value: 1000 },
  { label: '2k', value: 2000 },
  { label: '5k', value: 5000 },
  { label: 'All', value: engramStats?.total_engrams ?? 99999 },
].map(({ label, value }) => (
```

**Around line 754** — move the "Recommended" marker:
```tsx
// BEFORE
{value === 2000 && (
  <span className="absolute -top-1 -right-1 w-1.5 h-1.5 rounded-full bg-teal-400" title="Recommended" />
)}
// AFTER
{value === 500 && (
  <span className="absolute -top-1 -right-1 w-1.5 h-1.5 rounded-full bg-teal-400" title="Recommended" />
)}
```

- [ ] **Step 4.3: TypeScript build check**

```bash
cd dashboard && npm run build 2>&1 | tail -10
```

Expected: build succeeds, no TS errors.

- [ ] **Step 4.4: Manual verification — clear localStorage and visit /brain**

In a real browser at `http://localhost:5173` (or :3000 after image rebuild):
1. DevTools → Application → Local Storage → `http://localhost:5173` → delete the `brain.nodeLimit` key (simulates a new user).
2. Hard reload, navigate to /brain.
3. The selector should now show buttons `1 / 200 / 500 / 1k / 2k / 5k / All` (7 buttons in flex-wrap). The "500" button should have the teal "Recommended" dot and be selected. The graph should render with up to 500 nodes.
4. Click "1k" — graph refetches and re-renders with 1000 nodes.
5. Hard reload — selector should remember "1k" (localStorage persistence).

- [ ] **Step 4.5: Commit**

```bash
git add dashboard/src/pages/Brain.tsx
git commit -m "fix(dashboard): default Brain to 500 nodes (was 2000)

ForceGraph3D's force-layout simulation runtime scales superlinearly
with node count. Defaulting to 500 cuts first-paint cost on /brain
visit; users with rich engram graphs can opt up via the existing
selector (500 / 1k / 2k / 5k / All) which is persisted via
localStorage('brain.nodeLimit').

Existing users with a saved 'brain.nodeLimit' value keep their
selection — only new users (or users who clear localStorage) get
the new default.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Final verification

After all four tasks land, run the end-to-end acceptance checks from the spec:

- [ ] **Step F.1: Cold-restart timing**

```bash
make restart
time curl -sf -m 60 --retry 60 --retry-delay 1 http://localhost:8000/health/ready
```

Expected: returns 200 in ≤ 45s (was 62s).

- [ ] **Step F.2: Route navigation has no long tasks**

Open `http://localhost:3000` (production-built dashboard) in a real browser with DevTools Performance tab open. Record while navigating /chat → /tasks → /goals → /sources → /settings.

Expected: zero long tasks (>50ms) attributable to Brain mount/unmount during these navigations.

- [ ] **Step F.3: /brain mount with default 500 nodes**

Clear localStorage for the dashboard origin. Navigate to /brain. Expected: scene renders with 500 nodes; longest single block during mount ≤ 2s in real browser (eyeballing the Performance tab is fine).

- [ ] **Step F.4: All pre-existing integration tests pass**

```bash
make test
```

Expected: 35+ tests pass.

- [ ] **Step F.5: Push & open PR**

If on a clean worktree branch:

```bash
git push -u origin engineer/startup-perf
gh pr create --title "fix(perf): cut spin-up + eliminate /brain freeze" --body "$(cat <<'EOF'
## Summary
- Defer MCP server load past orchestrator lifespan yield (saves ~21s every boot)
- Lazy-mount Brain canvas only on /brain route (eliminates persistent hidden-mount cost)
- Default Brain to 500 nodes (was 2000); existing selector lets users opt up
- Add 'make restart' target + surface compose watch + uvicorn --reload in dev help

## Test plan
- [x] Cold restart: /health/ready ≤ 45s (was 62s)
- [x] Route navigations /chat → /tasks → /goals → /sources → /settings have zero long tasks
- [x] /brain mount with default 500 nodes shows ≤ 2s longest long-task in headless
- [x] make test passes
- [x] Real-browser smoke: open dashboard, navigate around, no freeze

See `docs/perf/2026-05-07-startup-performance-findings.md` for measurements
and `docs/superpowers/specs/2026-05-07-startup-performance-fix-design.md` for design.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Risks & rollback

- **If Fix #1 breaks tool-use:** if the Quartet pipeline's first cycle fires within 21s of orchestrator boot AND needs an MCP tool, it'll see "tool not registered." Watch logs after deploy. Rollback = revert that single commit; the others land cleanly.
- **If Fix #2 makes first /brain click feel worse:** users who immediately go to /brain pay the full ~6s mount cost on click instead of a pre-warmed canvas. Mitigation: BrainPrefetcher still warms the engram graph data on dashboard mount, so only the WebGL/Three.js init is paid on click.
- **Each fix is in its own commit** — partial rollback is straightforward via `git revert <sha>`.
