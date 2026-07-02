"""Browser-worker HTTP API — session-scoped, orchestrator-only."""

from __future__ import annotations

import logging
import uuid

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from app.browser import manager

log = logging.getLogger(__name__)

router = APIRouter(prefix="/api/v1/browser", tags=["browser"])


class OpenRequest(BaseModel):
    url: str = ""
    session_id: str | None = None


class NavigateRequest(BaseModel):
    url: str


class SnapshotRequest(BaseModel):
    include_screenshot: bool = False


class ActRequest(BaseModel):
    ref: int
    action: str  # click | type | select | press
    value: str = ""


@router.post("/sessions")
async def open_session(req: OpenRequest):
    session_id = req.session_id or str(uuid.uuid4())
    try:
        sess = await manager.open_session(req.url, session_id)
    except Exception as e:
        log.warning("open_session failed: %s", e)
        raise HTTPException(502, f"Failed to open browser session: {e}")
    return {"session_id": sess.id, "domain": sess.domain, "url": sess.page.url}


@router.post("/sessions/{session_id}/navigate")
async def navigate(session_id: str, req: NavigateRequest):
    try:
        return await manager.navigate(session_id, req.url)
    except KeyError:
        raise HTTPException(404, f"session {session_id} not found")
    except Exception as e:
        raise HTTPException(502, f"navigate failed: {e}")


@router.post("/sessions/{session_id}/snapshot")
async def snapshot(session_id: str, req: SnapshotRequest):
    try:
        return await manager.snapshot(session_id, req.include_screenshot)
    except KeyError:
        raise HTTPException(404, f"session {session_id} not found")
    except Exception as e:
        raise HTTPException(502, f"snapshot failed: {e}")


@router.post("/sessions/{session_id}/act")
async def act(session_id: str, req: ActRequest):
    try:
        return await manager.act(session_id, req.ref, req.action, req.value)
    except KeyError:
        raise HTTPException(404, f"session {session_id} not found")
    except ValueError as e:
        raise HTTPException(400, str(e))
    except Exception as e:
        raise HTTPException(502, f"act failed: {e}")


@router.delete("/sessions/{session_id}")
async def close_session(session_id: str):
    closed = await manager.close_session(session_id)
    if not closed:
        raise HTTPException(404, f"session {session_id} not found")
    return {"status": "closed"}


@router.get("/sessions")
async def list_sessions():
    return {"active": manager.session_count()}
