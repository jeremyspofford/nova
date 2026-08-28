"""POST /v1/chat/completions + GET /v1/models — pure passthrough to the
one active backend. No retries, no fallback: a connect/read failure is a
stated 502, and a failure mid-stream (after we already answered 200) is an
OpenAI-shaped SSE error chunk, then the stream ends."""
from __future__ import annotations

import gzip
import json

from starlette.applications import Starlette
from starlette.responses import Response as StarletteResponse
from starlette.routing import Route

from app import backends
from tests.conftest import requires_db
from tests.fakes import FakeOllama, FakeOpenAICompat

pytestmark = requires_db


def _sse_payloads(body: bytes) -> list:
    out = []
    for block in body.decode().strip().split("\n\n"):
        if not block:
            continue
        assert block.startswith("data:")
        payload = block[len("data:") :].strip()
        out.append(payload if payload == "[DONE]" else json.loads(payload))
    return out


async def test_chat_completions_passthrough_verbatim_with_served_by_header(
    client, pool, monkeypatch, mount_backend
):
    monkeypatch.setenv("OLLAMA_URL", "http://ollama.test")
    fake = FakeOllama(deltas=("Hel", "lo"))
    mount_backend("http://ollama.test", fake.app)
    await backends.save_config(pool, {"kind": "ollama", "model": "qwen3:8b"})

    resp = await client.post(
        "/v1/chat/completions",
        json={"messages": [{"role": "user", "content": "hi"}], "stream": True},
    )

    assert resp.status_code == 200
    assert resp.headers["x-nova-served-by"] == "ollama:qwen3:8b"
    frames = _sse_payloads(resp.content)
    deltas = [f["choices"][0]["delta"]["content"] for f in frames if f != "[DONE]"]
    assert deltas == ["Hel", "lo"]
    # The default model was injected — the fake actually received it.
    assert fake.seen[0][1]["model"] == "qwen3:8b"


async def test_an_explicit_model_overrides_the_configured_default(
    client, pool, monkeypatch, mount_backend
):
    monkeypatch.setenv("OLLAMA_URL", "http://ollama.test")
    fake = FakeOllama(deltas=("ok",))
    mount_backend("http://ollama.test", fake.app)
    await backends.save_config(pool, {"kind": "ollama", "model": "qwen3:8b"})

    resp = await client.post(
        "/v1/chat/completions",
        json={"messages": [], "stream": True, "model": "qwen3:4b"},
    )

    assert resp.status_code == 200
    assert resp.headers["x-nova-served-by"] == "ollama:qwen3:4b"
    assert fake.seen[0][1]["model"] == "qwen3:4b"


async def test_backend_unreachable_is_a_stated_502(client, pool, monkeypatch):
    monkeypatch.setenv("OLLAMA_URL", "http://127.0.0.1:1")
    await backends.save_config(pool, {"kind": "ollama", "model": "qwen3:8b"})

    resp = await client.post(
        "/v1/chat/completions", json={"messages": [], "stream": True}
    )

    assert resp.status_code == 502
    assert "error" in resp.json()


async def test_a_mid_stream_failure_emits_an_openai_shaped_error_chunk_then_ends(
    client, pool, monkeypatch, mount_backend
):
    monkeypatch.setenv("OLLAMA_URL", "http://ollama.test")
    fake = FakeOllama(deltas=("par", "tial"), fail_after=1)
    mount_backend("http://ollama.test", fake.app)
    await backends.save_config(pool, {"kind": "ollama", "model": "qwen3:8b"})

    resp = await client.post(
        "/v1/chat/completions", json={"messages": [], "stream": True}
    )

    assert resp.status_code == 200  # headers were already sent as success
    frames = _sse_payloads(resp.content)
    deltas = [f["choices"][0]["delta"]["content"] for f in frames if "error" not in f]
    assert deltas == ["par"]
    error_frames = [f for f in frames if isinstance(f, dict) and "error" in f]
    assert len(error_frames) == 1
    assert "message" in error_frames[0]["error"]


async def test_backend_immediate_non_200_is_passed_through_verbatim(
    client, pool, monkeypatch, mount_backend
):
    monkeypatch.setenv("OLLAMA_URL", "http://ollama.test")
    fake = FakeOllama(probe_status=404)
    mount_backend("http://ollama.test", fake.app)
    await backends.save_config(pool, {"kind": "ollama", "model": "qwen3:8b"})

    resp = await client.post(
        "/v1/chat/completions", json={"messages": [], "stream": False}
    )

    assert resp.status_code == 404


async def test_models_ollama_shape_is_mapped_to_openai_list(
    client, pool, monkeypatch, mount_backend
):
    monkeypatch.setenv("OLLAMA_URL", "http://ollama.test")
    fake = FakeOllama(tags=("qwen3:8b", "qwen3:4b"))
    mount_backend("http://ollama.test", fake.app)
    await backends.save_config(pool, {"kind": "ollama"})

    resp = await client.get("/v1/models")

    assert resp.status_code == 200
    body = resp.json()
    assert body["object"] == "list"
    assert {m["id"] for m in body["data"]} == {"qwen3:8b", "qwen3:4b"}
    assert all(m["object"] == "model" for m in body["data"])


async def test_models_remote_is_passthrough_verbatim(client, pool, mount_backend):
    fake = FakeOpenAICompat(models_body={"object": "list", "data": [{"id": "gpt-remote"}]})
    mount_backend("http://remote.test", fake.app)
    await backends.save_config(pool, {"kind": "remote", "url": "http://remote.test"})

    resp = await client.get("/v1/models")

    assert resp.status_code == 200
    assert resp.json() == {"object": "list", "data": [{"id": "gpt-remote"}]}
    assert fake.seen_auth == [None]


async def test_models_cloud_sends_the_api_key(client, pool, mount_backend):
    fake = FakeOpenAICompat()
    mount_backend("http://cloud.test", fake.app)
    await backends.save_config(
        pool, {"kind": "cloud", "url": "http://cloud.test", "api_key": "sk-secret", "model": "m"}
    )

    resp = await client.get("/v1/models")

    assert resp.status_code == 200
    assert fake.seen_auth == ["Bearer sk-secret"]


async def test_models_unreachable_is_a_stated_502(client, pool, monkeypatch):
    monkeypatch.setenv("OLLAMA_URL", "http://127.0.0.1:1")
    await backends.save_config(pool, {"kind": "ollama"})

    resp = await client.get("/v1/models")

    assert resp.status_code == 502
    assert "error" in resp.json()


async def test_a_gzipped_backend_response_is_relayed_with_content_encoding_intact(
    client, pool, mount_backend
):
    """aiter_raw() hands us the backend's still-compressed wire bytes — if
    we drop Content-Encoding on the way through (as a CDN-fronted
    remote/cloud backend would send it), the caller has compressed bytes
    and no way to know it. Forwarding the header is what makes them
    decodable again — proven here by httpx's own automatic decompression
    on the client side succeeding."""
    original = {"choices": [{"message": {"content": "compressed ok"}}]}
    compressed = gzip.compress(json.dumps(original).encode())

    async def _completions(request):
        return StarletteResponse(
            content=compressed,
            media_type="application/json",
            headers={"content-encoding": "gzip"},
        )

    gzip_backend = Starlette(
        routes=[Route("/v1/chat/completions", _completions, methods=["POST"])]
    )
    mount_backend("http://gzip.test", gzip_backend)
    await backends.save_config(pool, {"kind": "remote", "url": "http://gzip.test"})

    resp = await client.post("/v1/chat/completions", json={"messages": [], "stream": False})

    assert resp.status_code == 200
    assert resp.headers["content-encoding"] == "gzip"
    # httpx transparently decodes .json()/.content using the Content-Encoding
    # header it received — this only produces the right answer if that
    # header actually made the trip; a dropped header here would leave raw
    # gzip bytes that fail to parse as JSON.
    assert resp.json() == original
