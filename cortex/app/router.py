"""Cortex control endpoints — status, pause, resume, drives, journal."""
from __future__ import annotations

import logging
from uuid import UUID

from fastapi import APIRouter, HTTPException, Query

from .budget import get_budget_status
from .clients import get_orchestrator
from .config import settings
from .db import get_pool
from .drives import improve, learn, maintain, reflect, serve
from .journal import read_recent

log = logging.getLogger(__name__)

cortex_router = APIRouter(prefix="/api/v1/cortex", tags=["cortex"])

ALL_DRIVES = [serve, maintain, improve, learn, reflect]


@cortex_router.get("/status")
async def get_status():
    """Current Cortex state — running/paused, cycle count, active drive."""
    pool = get_pool()
    async with pool.acquire() as conn:
        row = await conn.fetchrow("SELECT * FROM cortex_state WHERE id = true")
    if not row:
        return {"status": "uninitialized"}
    return {
        "status": row["status"],
        "current_drive": row["current_drive"],
        "cycle_count": row["cycle_count"],
        "last_cycle_at": row["last_cycle_at"].isoformat() if row["last_cycle_at"] else None,
        "last_checkpoint": row["last_checkpoint"],
    }


@cortex_router.post("/pause")
async def pause():
    """Pause autonomous operation."""
    pool = get_pool()
    async with pool.acquire() as conn:
        await conn.execute(
            "UPDATE cortex_state SET status = 'paused', updated_at = NOW() WHERE id = true"
        )
    log.info("Cortex paused")
    return {"status": "paused"}


@cortex_router.post("/resume")
async def resume():
    """Resume autonomous operation."""
    pool = get_pool()
    async with pool.acquire() as conn:
        await conn.execute(
            "UPDATE cortex_state SET status = 'running', updated_at = NOW() WHERE id = true"
        )
    log.info("Cortex resumed")
    return {"status": "running"}


@cortex_router.post("/trigger/{goal_id}")
async def trigger_goal(goal_id: UUID):
    """Directly dispatch a pipeline task for a goal, bypassing drive evaluation."""
    pool = get_pool()
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            "SELECT id, title, description FROM goals WHERE id = $1 AND status = 'active'",
            goal_id,
        )
    if not row:
        raise HTTPException(status_code=404, detail="Goal not found or not active")

    # Dispatch task directly to orchestrator
    try:
        orch = get_orchestrator()
        resp = await orch.post(
            "/api/v1/pipeline/tasks",
            json={
                "user_input": f"[Cortex goal work] Goal: {row['title']}."
                              + (f" Description: {row['description']}" if row["description"] else "")
                              + " Analyze the goal and take the next meaningful step toward completion.",
                "goal_id": str(goal_id),
                "metadata": {"source": "cortex", "trigger": "manual", "drive": "serve"},
            },
            headers={"Authorization": f"Bearer {settings.cortex_api_key}"},
        )
        if resp.status_code not in (200, 201, 202):
            raise HTTPException(status_code=502, detail=f"Orchestrator returned {resp.status_code}")
        task_id = resp.json().get("task_id", "unknown")
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Failed to dispatch: {e}")

    # Only update after successful dispatch
    async with pool.acquire() as conn:
        await conn.execute(
            "UPDATE goals SET last_checked_at = NOW(), iteration = iteration + 1, updated_at = NOW() WHERE id = $1",
            goal_id,
        )

    log.info("Manual trigger for goal %s → task %s", goal_id, task_id)
    return {"status": "dispatched", "task_id": task_id, "goal_id": str(goal_id)}


@cortex_router.get("/drives")
async def get_drives():
    """Live drive urgency scores — calls each drive's assess() method."""
    results = []
    for drive_module in ALL_DRIVES:
        try:
            r = await drive_module.assess()
            results.append({
                "name": r.name,
                "priority": r.priority,
                "urgency": r.urgency,
                "description": r.description,
                "proposed_action": r.proposed_action,
                "context": r.context,
            })
        except Exception as e:
            log.warning("Drive %s.assess() failed: %s", drive_module.__name__, e)
            results.append({
                "name": drive_module.__name__.split(".")[-1],
                "priority": 0,
                "urgency": 0.0,
                "description": f"Error: {e}",
                "proposed_action": None,
            })
    return {"drives": results}


@cortex_router.get("/budget")
async def budget():
    """Current budget state — daily spend, remaining, tier."""
    return await get_budget_status()


@cortex_router.get("/journal")
async def journal(limit: int = Query(default=20, le=100)):
    """Recent journal entries from the Cortex conversation."""
    entries = await read_recent(limit)
    return {"entries": entries}


@cortex_router.get("/reflections/{goal_id}")
async def get_reflections(goal_id: UUID, limit: int = Query(default=20, le=100)):
    """Reflections (experience log) for a specific goal."""
    from .reflections import query_reflections
    refs = await query_reflections(str(goal_id), limit=limit)
    return {"reflections": refs, "count": len(refs)}


@cortex_router.post("/__test/run-verify-chain")
async def run_verify_chain_for_test():
    """Run the maintain drive's `_run_verify_chain` synchronously.

    For integration tests only — requires CORTEX_TEST_MODE=true. This
    bypasses the BRPOP loop's variable cadence so tests can deterministically
    trigger the audit-chain sweep and assert against its output.

    Returns the same dict that `_run_verify_chain` returns:
      ``{"status": "ok"|"error", "checked": n, "broken": n, "broken_tenants": [...]}``.
    """
    import os
    if os.getenv("CORTEX_TEST_MODE", "").lower() not in ("1", "true"):
        raise HTTPException(status_code=403, detail="CORTEX_TEST_MODE is not enabled")

    from .drives.maintain import _run_verify_chain
    return await _run_verify_chain(None)


@cortex_router.post("/__test/ping-webhooks")
async def ping_webhooks_for_test(body: dict | None = None):
    """Run the maintain drive's `_ping_webhooks` synchronously.

    For integration tests only — requires CORTEX_TEST_MODE=true. Mirrors the
    T2-03 ``__test/run-verify-chain`` pattern: bypasses the BRPOP cadence so
    seam tests can deterministically trigger the webhook-health sweep and
    assert against its result.

    Optional body: ``{"api_base": "<override>"}`` — admin-only seam that
    points the orchestrator's ping-all call at fake-github
    (host.docker.internal:{port}) instead of the real GitHub API.

    Returns the same dict that `_ping_webhooks` returns:
      ``{"status": "ok"|"error", "pinged": n, "failed": [...]}``.
    """
    import os
    if os.getenv("CORTEX_TEST_MODE", "").lower() not in ("1", "true"):
        raise HTTPException(status_code=403, detail="CORTEX_TEST_MODE is not enabled")

    from .drives.maintain import _ping_webhooks
    api_base = (body or {}).get("api_base")
    return await _ping_webhooks(None, api_base=api_base)


@cortex_router.post("/__test/drain-stimuli")
async def drain_stimuli_for_test(max_count: int = Query(default=10, le=50)):
    """Drain pending stimuli synchronously and process them via ci_triage.

    For integration tests only — requires CORTEX_TEST_MODE=true.
    This endpoint lets tests bypass the background BRPOP loop timing
    and verify stimulus→goal dispatch deterministically.

    Only handles ci.workflow_run.failure stimuli; other types are re-queued.
    """
    import os
    if os.getenv("CORTEX_TEST_MODE", "").lower() not in ("1", "true"):
        raise HTTPException(status_code=403, detail="CORTEX_TEST_MODE is not enabled")

    from .drives.ci_triage import handle_stimulus
    from .stimulus import STIMULUS_KEY, get_redis

    r = await get_redis()
    processed: list[dict] = []
    requeued: int = 0

    import json as _json
    for _ in range(max_count):
        raw = await r.rpop(STIMULUS_KEY)
        if raw is None:
            break
        try:
            s = _json.loads(raw)
        except Exception:
            continue
        if s.get("type") == "ci.workflow_run.failure":
            result = await handle_stimulus(s)
            processed.append({"stimulus_type": s["type"], "result": result})
        else:
            # Re-queue non-CI stimuli so the background loop can handle them
            await r.lpush(STIMULUS_KEY, raw)
            requeued += 1

    return {"processed": processed, "requeued": requeued, "count": len(processed)}
