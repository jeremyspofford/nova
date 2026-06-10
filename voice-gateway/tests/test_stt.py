import json
from unittest.mock import patch

import pytest
from app.main import create_app
from httpx import ASGITransport, AsyncClient


@pytest.fixture
async def client():
    app = create_app()
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        yield c


@pytest.mark.asyncio
async def test_stt_stream_returns_sse(client):
    with patch("app.stt.transcribe", return_value="Hello world"):
        resp = await client.post(
            "/stt/stream",
            content=b"\x00" * 1024,
            headers={"Content-Type": "audio/webm"},
        )
    assert resp.status_code == 200
    assert "text/event-stream" in resp.headers["content-type"]
    lines = [ln for ln in resp.text.splitlines() if ln.startswith("data:")]
    assert len(lines) >= 1
    payload = json.loads(lines[-1].removeprefix("data: "))
    assert payload["is_final"] is True
    assert "Hello world" in payload["text"]


@pytest.mark.asyncio
async def test_stt_stream_missing_body_returns_400(client):
    resp = await client.post("/stt/stream", content=b"")
    assert resp.status_code == 400
