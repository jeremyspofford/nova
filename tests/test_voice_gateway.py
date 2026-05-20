"""Integration tests for voice-gateway — requires voice-gateway at localhost:8003.

Audio tests are skipped unless openai_api_key is configured in agent-core secrets.
"""
import httpx
import pytest

BASE = "http://localhost:8003"


def _has_openai_key() -> bool:
    try:
        r = httpx.get(f"{BASE}/providers", timeout=5.0)
        providers = r.json()
        # Flat list: [{name, type, status}, ...]
        return any(
            p.get("name") == "openai-whisper" and p.get("status") == "available"
            for p in providers
        )
    except Exception:
        return False


def test_providers_endpoint():
    r = httpx.get(f"{BASE}/providers")
    assert r.status_code == 200
    data = r.json()
    # v2: flat list of provider objects
    assert isinstance(data, list)
    types = {p["type"] for p in data}
    assert "stt" in types
    assert "tts" in types


def test_stt_stream_empty_audio_returns_400():
    """Empty audio body is a client error — gateway returns 400, not 500."""
    r = httpx.post(
        f"{BASE}/stt/stream",
        content=b"",
        headers={"Content-Type": "audio/webm"},
        timeout=10.0,
    )
    assert r.status_code == 400


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


def test_tts_stream_503_when_no_key():
    """503 before streaming starts when openai_api_key is not configured."""
    if _has_openai_key():
        pytest.skip("openai_api_key is configured — 503 path not reachable")

    r = httpx.post(
        f"{BASE}/tts/stream",
        json={"text": "Hello.", "voice": "nova"},
        timeout=5.0,
    )
    assert r.status_code == 503
