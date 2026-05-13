"""Approval flow endpoints under /api/v1/approvals."""
import json
import logging

from fastapi import APIRouter, Depends, Header, HTTPException, status

from nova_contracts import ApprovalDecision

from .config import settings
from .db import get_pool
from .tools import capability

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/v1/approvals", tags=["approvals"])


def _require_admin(x_admin_secret: str | None = Header(default=None)) -> None:
    if not x_admin_secret:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Missing admin secret")
    if x_admin_secret != settings.admin_secret:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid admin secret")


@router.get("")
async def list_approvals(_: None = Depends(_require_admin)) -> dict:
    pool = await get_pool()
    async with pool.acquire() as conn:
        rows = await conn.fetch(
            "SELECT id, task_id, tool_name, scope, args, tier, status, created_at "
            "FROM approvals WHERE status = 'pending' ORDER BY created_at"
        )
    out = []
    for row in rows:
        try:
            args = json.loads(row["args"]) if isinstance(row["args"], str) else row["args"]
        except Exception:
            args = {}
        out.append({
            "id": str(row["id"]),
            "task_id": str(row["task_id"]),
            "tool_name": row["tool_name"],
            "scope": row["scope"],
            "args": args or {},
            "tier": row["tier"],
            "status": row["status"],
            "created_at": row["created_at"].isoformat() if row["created_at"] else "",
        })
    return {"approvals": out}


@router.post("/{approval_id}/grant")
async def grant(approval_id: str, body: ApprovalDecision, _: None = Depends(_require_admin)) -> dict:
    pool = await get_pool()
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            "SELECT id, tool_name, scope, status FROM approvals WHERE id = $1",
            approval_id,
        )
        if row is None:
            raise HTTPException(status_code=404, detail="Approval not found")
        if row["status"] != "pending":
            raise HTTPException(status_code=409, detail=f"Approval already {row['status']}")
        await conn.execute(
            "UPDATE approvals SET status = 'granted', resolved_at = now() WHERE id = $1",
            approval_id,
        )
    if body.remember:
        capability.cache_consent(row["tool_name"], row["scope"], body.remember_ttl)
    capability.resolve_approval(approval_id, granted=True)
    return {"id": approval_id, "status": "granted"}


@router.post("/{approval_id}/deny")
async def deny(approval_id: str, _: None = Depends(_require_admin)) -> dict:
    pool = await get_pool()
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            "SELECT id, status FROM approvals WHERE id = $1",
            approval_id,
        )
        if row is None:
            raise HTTPException(status_code=404, detail="Approval not found")
        if row["status"] != "pending":
            raise HTTPException(status_code=409, detail=f"Approval already {row['status']}")
        await conn.execute(
            "UPDATE approvals SET status = 'denied', resolved_at = now() WHERE id = $1",
            approval_id,
        )
    capability.resolve_approval(approval_id, granted=False)
    return {"id": approval_id, "status": "denied"}
