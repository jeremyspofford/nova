"""Task CRUD endpoints under /api/v1/tasks."""
import asyncio
import json
import logging
import uuid

from fastapi import APIRouter, Depends, Header, HTTPException, status

from nova_contracts import TaskCreateRequest

from .config import settings
from .db import get_pool
from .loop.main import run_task

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/v1/tasks", tags=["tasks"])


def _require_admin(x_admin_secret: str | None = Header(default=None)) -> None:
    if not x_admin_secret:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Missing admin secret")
    if x_admin_secret != settings.admin_secret:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid admin secret")


@router.post("")
async def create_task(body: TaskCreateRequest, _: None = Depends(_require_admin)) -> dict:
    task_id = str(uuid.uuid4())
    pool = await get_pool()
    async with pool.acquire() as conn:
        # `prompt` is NOT NULL in v1 schema; mirror goal into it for v2.
        await conn.execute(
            "INSERT INTO tasks (id, prompt, goal, status, created_at) VALUES ($1, $2, $2, 'pending', now())",
            task_id, body.goal,
        )
    # Fire and forget — the loop owns the lifecycle.
    asyncio.create_task(run_task(task_id, body.goal, pool))
    return {"id": task_id, "goal": body.goal, "status": "pending"}


@router.get("/{task_id}")
async def get_task(task_id: str, _: None = Depends(_require_admin)) -> dict:
    pool = await get_pool()
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            "SELECT id, goal, status, result, created_at, started_at, completed_at "
            "FROM tasks WHERE id = $1",
            task_id,
        )
    if row is None:
        raise HTTPException(status_code=404, detail="Task not found")
    return {
        "id": str(row["id"]),
        "goal": row["goal"],
        "status": row["status"],
        "result": row["result"],
        "created_at": row["created_at"].isoformat() if row["created_at"] else None,
        "started_at": row["started_at"].isoformat() if row["started_at"] else None,
        "completed_at": row["completed_at"].isoformat() if row["completed_at"] else None,
    }


@router.get("/{task_id}/events")
async def list_events(task_id: str, _: None = Depends(_require_admin)) -> dict:
    pool = await get_pool()
    async with pool.acquire() as conn:
        rows = await conn.fetch(
            "SELECT id, task_id, event_type, payload, occurred_at, chain_hash "
            "FROM task_events WHERE task_id = $1 AND chain_hash != '' "
            "ORDER BY occurred_at",
            task_id,
        )
    events = []
    for row in rows:
        try:
            payload = json.loads(row["payload"]) if isinstance(row["payload"], str) else row["payload"]
        except Exception:
            payload = {}
        events.append({
            "id": str(row["id"]),
            "task_id": str(row["task_id"]),
            "event_type": row["event_type"],
            "payload": payload or {},
            "occurred_at": row["occurred_at"].isoformat() if row["occurred_at"] else "",
            "chain_hash": row["chain_hash"],
        })
    return {"events": events}
