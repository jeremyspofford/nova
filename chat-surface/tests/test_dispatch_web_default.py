"""web_search forwarding: always explicit in the agent-core request body.

agent-core defaults web_search to true, so chat-surface must never omit the
key — omitting it for a user who toggled web off would silently re-enable it.
"""
from contextlib import asynccontextmanager
from unittest.mock import AsyncMock

import pytest
from app.ws.router import _dispatch_text_turn
from app.ws.session import WebSocketSession


class StreamCapture:
    def __init__(self):
        self.bodies: list[dict] = []

    @asynccontextmanager
    async def stream(self, method, url, json=None):
        self.bodies.append(json)

        class _Resp:
            def raise_for_status(self):
                pass

            async def aiter_lines(self):
                return
                yield  # pragma: no cover

        yield _Resp()


def _fixtures():
    ws = AsyncMock()
    session = WebSocketSession(ws=ws, session_id="s1")
    sessions = AsyncMock()
    redis = AsyncMock()
    return session, redis, sessions


@pytest.mark.asyncio
async def test_web_search_defaults_on_and_is_explicit(monkeypatch):
    monkeypatch.setattr("app.ws.router.buffer_event", AsyncMock())
    session, redis, sessions = _fixtures()
    agent = StreamCapture()

    await _dispatch_text_turn(session, "t1", "hi", agent, redis, sessions)
    assert agent.bodies[0]["web_search"] is True


@pytest.mark.asyncio
async def test_web_search_off_is_sent_not_omitted(monkeypatch):
    monkeypatch.setattr("app.ws.router.buffer_event", AsyncMock())
    session, redis, sessions = _fixtures()
    agent = StreamCapture()

    await _dispatch_text_turn(
        session, "t1", "hi", agent, redis, sessions, web_search=False
    )
    assert agent.bodies[0]["web_search"] is False
