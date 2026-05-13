import asyncio
import pytest
from unittest.mock import AsyncMock, MagicMock
from app.voice.barge_in import handle_barge_in
from app.ws.session import WebSocketSession


@pytest.mark.asyncio
async def test_barge_in_sends_stop_audio_immediately():
    ws = AsyncMock()
    session = WebSocketSession(ws=ws, session_id="s1")
    session.task_id = "task-001"
    http_agent = AsyncMock()
    http_agent.post = AsyncMock(return_value=MagicMock(status_code=200))
    await handle_barge_in(session, "task-001", http_agent)
    first_call = ws.send_json.call_args_list[0]
    assert first_call.args[0]["type"] == "stop_audio"


@pytest.mark.asyncio
async def test_barge_in_cancels_session_tts():
    ws = AsyncMock()
    session = WebSocketSession(ws=ws, session_id="s2")
    session.task_id = "task-002"
    http_agent = AsyncMock()
    http_agent.post = AsyncMock(return_value=MagicMock(status_code=200))
    await handle_barge_in(session, "task-002", http_agent)
    assert session.tts_cancelled is True


@pytest.mark.asyncio
async def test_barge_in_fires_agent_cancel():
    ws = AsyncMock()
    session = WebSocketSession(ws=ws, session_id="s3")
    http_agent = AsyncMock()
    cancel_called = asyncio.Event()

    async def fake_post(path, **kwargs):
        if "/cancel" in path:
            cancel_called.set()
        return MagicMock(status_code=200)

    http_agent.post = fake_post
    await handle_barge_in(session, "task-003", http_agent)
    await asyncio.sleep(0.01)
    assert cancel_called.is_set()
