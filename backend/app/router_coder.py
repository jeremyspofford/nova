"""Coding delegation — the operator's surface.

docs/plans/acp-coding-delegation.md phase 1. Registering a repo and starting a
coding session are OPERATOR actions in this phase, not Nova's: the
`delegate_coding_task` builtin that lets her start one herself is phase 2, and
keeping it that way means the first thing that exists is the surface a human
uses to watch what happens.

Auth is the app-wide middleware in main.py; there is no per-route gate here and
adding one would be a second, weaker authority.
"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from app import coder

router = APIRouter()


class NewWorkspace(BaseModel):
    name: str
    git_url: str
    default_branch: str = "main"
    auth_secret: str | None = None


class NewSession(BaseModel):
    workspace: str
    task: str
    mode: str = "default"
    budget_s: int = 0


@router.get("/api/v1/coder/status")
async def status():
    """Whether delegation is available at all, derived from the credential.

    A stack with no coder sidecar is a supported state, so this answers
    plainly instead of the UI inferring it from a failed call."""
    return {"configured": coder.configured()}


# ── workspaces ────────────────────────────────────────────────────────────

@router.get("/api/v1/coder/workspaces")
async def list_workspaces():
    return {"workspaces": await coder.list_workspaces(include_disabled=True)}


@router.post("/api/v1/coder/workspaces")
async def add_workspace(body: NewWorkspace):
    if not body.name.strip() or not body.git_url.strip():
        raise HTTPException(400, "name and git_url are both required")
    try:
        return await coder.add_workspace(
            body.name, body.git_url, body.default_branch, body.auth_secret)
    except Exception as e:                                   # noqa: BLE001
        raise HTTPException(400, str(e)[:300]) from e


@router.post("/api/v1/coder/workspaces/{name}/enabled")
async def set_enabled(name: str, enabled: bool = True):
    if not await coder.set_workspace_enabled(name, enabled):
        raise HTTPException(404, f"no workspace named '{name}'")
    return {"status": "ok", "name": name, "enabled": enabled}


@router.delete("/api/v1/coder/workspaces/{name}")
async def delete_workspace(name: str):
    if not await coder.delete_workspace(name):
        raise HTTPException(404, f"no workspace named '{name}'")
    return {"status": "deleted", "name": name}


# ── sessions ──────────────────────────────────────────────────────────────

@router.get("/api/v1/coder/sessions")
async def recent_sessions(limit: int = 20):
    return {"sessions": await coder.recent(limit)}


@router.post("/api/v1/coder/sessions")
async def start_session(body: NewSession):
    r = await coder.start(body.workspace, body.task, mode=body.mode,
                          budget_s=body.budget_s, requested_by="operator")
    if r.get("status") == "error":
        raise HTTPException(400, r["detail"])
    return r


@router.get("/api/v1/coder/sessions/{session_id}")
async def get_session(session_id: str):
    r = await coder.refresh(session_id)
    if r.get("status") == "error":
        raise HTTPException(404, r["detail"])
    return r


@router.post("/api/v1/coder/sessions/{session_id}/kill")
async def kill_session(session_id: str):
    r = await coder.kill(session_id)
    if r.get("status") == "error":
        raise HTTPException(404, r["detail"])
    return r
