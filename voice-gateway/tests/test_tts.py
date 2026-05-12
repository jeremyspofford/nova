import pytest
from httpx import AsyncClient, ASGITransport
from unittest.mock import patch, AsyncMock
from app.main import create_app


@pytest.fixture
async def client():
    app = create_app()
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        yield c


@pytest.mark.asyncio
async def test_tts_stream_returns_audio_chunks(client):
    fake_audio = b"\xff\xfb\x00" * 100

    async def fake_synthesize(text, voice="nova"):
        yield fake_audio[:150]
        yield fake_audio[150:]

    with patch("app.secrets_client._cache", {"openai_api_key": "sk-test"}):
        with patch("app.tts.synthesize_stream", fake_synthesize):
            resp = await client.post(
                "/tts/stream",
                json={"text": "Hello world", "voice": "alloy"},
            )

    assert resp.status_code == 200
    assert resp.content  # some bytes were returned


@pytest.mark.asyncio
async def test_tts_stream_empty_text_returns_400(client):
    resp = await client.post("/tts/stream", json={"text": "", "voice": "alloy"})
    assert resp.status_code == 400


@pytest.mark.asyncio
async def test_tts_stream_no_key_returns_503(client):
    with patch("app.secrets_client._cache", {}):
        with patch("app.secrets_client.resolve", new=AsyncMock(return_value=None)):
            resp = await client.post("/tts/stream", json={"text": "Hello", "voice": "alloy"})
    assert resp.status_code == 503
