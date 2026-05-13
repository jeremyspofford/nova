import pytest
from unittest.mock import AsyncMock, MagicMock
from app.ws.session import WebSocketSession
from app.ws.manager import SessionManager


@pytest.mark.asyncio
async def test_session_send_json():
    ws = AsyncMock()
    session = WebSocketSession(ws=ws, session_id="s1")
    await session.send_json({"type": "connected", "task_id": "t1"})
    ws.send_json.assert_awaited_once_with({"type": "connected", "task_id": "t1"})


@pytest.mark.asyncio
async def test_manager_broadcast_reaches_all_sessions_for_task():
    manager = SessionManager()
    ws1, ws2 = AsyncMock(), AsyncMock()
    s1 = WebSocketSession(ws=ws1, session_id="s1")
    s2 = WebSocketSession(ws=ws2, session_id="s2")
    s1.task_id = "task-001"
    s2.task_id = "task-001"
    manager.add(s1)
    manager.add(s2)
    await manager.broadcast_to_task("task-001", {"type": "response_chunk", "text": "hi"})
    ws1.send_json.assert_awaited_once()
    ws2.send_json.assert_awaited_once()


@pytest.mark.asyncio
async def test_manager_audio_only_reaches_owner():
    manager = SessionManager()
    ws1, ws2 = AsyncMock(), AsyncMock()
    s1 = WebSocketSession(ws=ws1, session_id="s1")
    s2 = WebSocketSession(ws=ws2, session_id="s2")
    s1.task_id = "task-002"
    s2.task_id = "task-002"
    s1.is_audio_owner = True
    manager.add(s1)
    manager.add(s2)
    await manager.send_audio_to_owner("task-002", b"\xff\xfb")
    ws1.send_bytes.assert_awaited_once_with(b"\xff\xfb")
    ws2.send_bytes.assert_not_awaited()


def test_manager_remove_session():
    manager = SessionManager()
    ws = MagicMock()
    s = WebSocketSession(ws=ws, session_id="s3")
    manager.add(s)
    manager.remove("s3")
    assert "s3" not in manager._sessions
