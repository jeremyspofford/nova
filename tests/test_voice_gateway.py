"""Integration tests for voice-gateway — requires voice-gateway at localhost:8003.

Audio tests are skipped unless openai_api_key is configured in agent-core secrets.
"""
import httpx
import pytest

BASE = "http://localhost:8003"


def _has_openai_key() -> bool:
    try:
        r = httpx.get(f"{BASE}/providers", timeout=5.0)
        data = r.json()
        return any(
            p.get("available") and p.get("name") == "openai-whisper"
            for p in data.get("stt", [])
        )
    except Exception:
        return False


def test_providers_endpoint():
    r = httpx.get(f"{BASE}/providers")
    assert r.status_code == 200
    data = r.json()
    assert "stt" in data
    assert "tts" in data
    assert isinstance(data["stt"], list)
    assert isinstance(data["tts"], list)


def test_stt_stream_empty_audio_returns_sse_error():
    """Empty audio should return a valid SSE response with an error event, not a 500."""
    r = httpx.post(
        f"{BASE}/stt/stream",
        content=b"",
        headers={"Content-Type": "audio/webm"},
        timeout=10.0,
    )
    assert r.status_code == 200
    assert "text/event-stream" in r.headers.get("content-type", "")
    assert "data:" in r.text


def test_tts_stream_requires_text():
    r = httpx.post(f"{BASE}/tts/stream", json={}, timeout=5.0)
    assert r.status_code == 422


def test_tts_stream_returns_audio_when_key_configured():
    if not _has_openai_key():
        pytest.skip("openai_api_key not configured")

    r = httpx.post(
        f"{BASE}/tts/stream",
        json={"text": "Hello, I am Nova.", "voice": "nova"},
        timeout=30.0,
    )
    assert r.status_code == 200
    assert len(r.content) > 0


def test_tts_stream_rejects_invalid_voice():
    r = httpx.post(
        f"{BASE}/tts/stream",
        json={"text": "Hello.", "voice": "not-a-real-voice"},
        timeout=5.0,
    )
    assert r.status_code == 400
