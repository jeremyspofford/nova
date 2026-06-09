"""Integration tests for llm-gateway — requires llm-gateway running at localhost:8001.

Tests gracefully skip when a required provider is unavailable.
"""
import json

import httpx
import pytest

BASE = "http://localhost:8001"


def _available_providers() -> dict:
    r = httpx.get(f"{BASE}/providers", timeout=5.0)
    return r.json() if r.status_code == 200 else {}


def test_providers_endpoint_returns_list():
    r = httpx.get(f"{BASE}/providers")
    assert r.status_code == 200
    data = r.json()
    assert "providers" in data
    assert isinstance(data["providers"], list)


def test_complete_requires_messages():
    r = httpx.post(f"{BASE}/complete", json={})
    assert r.status_code == 422


def test_complete_returns_content():
    providers = _available_providers()
    if not any(p["available"] for p in providers.get("providers", [])):
        pytest.skip("No LLM providers available")

    r = httpx.post(
        f"{BASE}/complete",
        json={"messages": [{"role": "user", "content": "Say 'ok' and nothing else."}],
              "max_tokens": 10},
        timeout=60.0,
    )
    assert r.status_code == 200
    data = r.json()
    assert "content" in data
    assert isinstance(data["content"], str)
    assert len(data["content"]) > 0
    assert "model" in data


def test_stream_returns_sse_chunks():
    providers = _available_providers()
    if not any(p["available"] for p in providers.get("providers", [])):
        pytest.skip("No LLM providers available")

    with httpx.stream(
        "POST",
        f"{BASE}/stream",
        json={"messages": [{"role": "user", "content": "Say 'ok'."}], "max_tokens": 10},
        timeout=120.0,
    ) as response:
        assert response.status_code == 200
        assert "text/event-stream" in response.headers.get("content-type", "")
        chunks = []
        for line in response.iter_lines():
            if line.startswith("data: "):
                data = json.loads(line[6:])
                chunks.append(data)

    assert len(chunks) > 0
    assert chunks[-1]["done"] is True
    assert "error" not in chunks[-1], f"Stream ended with error: {chunks[-1].get('error')}"
    # At least one chunk should have non-empty content
    text_chunks = [c for c in chunks if c.get("chunk")]
    assert len(text_chunks) > 0


def test_embed_requires_input():
    r = httpx.post(f"{BASE}/embed", json={})
    assert r.status_code == 422


def test_embed_returns_vector():
    providers = _available_providers()
    embed_available = any(
        p["available"] and p.get("supports_embed")
        for p in providers.get("providers", [])
    )
    if not embed_available:
        pytest.skip("No embedding providers available")

    r = httpx.post(
        f"{BASE}/embed",
        json={"input": "hello world"},
        timeout=30.0,
    )
    assert r.status_code == 200
    data = r.json()
    assert "embedding" in data
    assert isinstance(data["embedding"], list)
    assert len(data["embedding"]) > 0
    assert "dim" in data
    assert data["dim"] == len(data["embedding"])


def test_providers_shows_active_local_backend():
    """Gateway /providers must describe the configured local backend."""
    r = httpx.get(f"{BASE}/providers", timeout=5.0)
    assert r.status_code == 200
    data = r.json()
    assert "local_backend" in data
    assert "local_inference_url" in data
    assert data["local_backend"] in (
        "ollama-host", "ollama", "llamacpp", "vllm", "sglang", "lmstudio", "none"
    )


def test_local_model_with_tools_stays_conversational():
    """LiteLLM's ollama_chat tool path forces Ollama into JSON mode: local
    models hallucinate tool calls or wrap final answers in JSON envelopes and
    ignore the system persona (observed live: 7B denied knowing the user while
    the profile block sat in its prompt). Through Ollama's native OpenAI
    endpoint, a conversational turn with tools offered must come back as
    prose that uses the persona context."""
    providers = _available_providers().get("providers", [])
    if not any(p.get("local") and p.get("available") for p in providers):
        pytest.skip("no local provider available")

    r = httpx.post(f"{BASE}/complete", json={
        "model": "qwen2.5:1.5b",
        "max_tokens": 60,
        "temperature": 0.0,
        "messages": [
            {"role": "system", "content": "You are Nova, a personal assistant.\n\n"
             "## What Nova knows about the user\n- User's favorite color is teal"},
            {"role": "user", "content": "Hey, what do you know about me? Answer in one sentence."},
        ],
        "tools": [{"type": "function", "function": {
            "name": "web_search",
            "description": "Search the web for current information",
            "parameters": {"type": "object", "properties": {"query": {"type": "string"}},
                           "required": ["query"]},
        }}],
    }, timeout=120.0)
    assert r.status_code == 200, r.text
    data = r.json()

    assert not data.get("tool_calls"), (
        f"hallucinated a tool call for a conversational question: {data['tool_calls']}"
    )
    content = (data.get("content") or "").strip()
    assert content, "empty reply"
    enveloped = False
    try:
        enveloped = isinstance(json.loads(content), (dict, list))
    except ValueError:
        pass
    assert not enveloped, f"JSON envelope instead of prose: {content[:120]}"
    assert "teal" in content.lower(), f"persona/profile ignored: {content[:120]}"
