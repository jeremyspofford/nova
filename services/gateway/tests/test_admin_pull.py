"""POST /admin/pull — ollama-only, a preflight free-space line always
first, then the real ollama progress stream verbatim."""
from __future__ import annotations

import json

from app import backends
from tests.conftest import requires_db
from tests.fakes import FakeOllama

pytestmark = requires_db


def _lines(body: bytes) -> list[dict]:
    return [json.loads(line) for line in body.decode().splitlines() if line]


async def test_pull_is_refused_for_a_non_ollama_backend(client, pool):
    await backends.save_config(
        pool, {"kind": "cloud", "url": "https://x", "api_key": "sk-x", "model": "m"}
    )

    resp = await client.post("/admin/pull", json={"model": "qwen3:8b"})

    assert resp.status_code == 400
    assert "ollama" in resp.json()["error"].lower()


async def test_pull_streams_ollamas_progress_lines_through_after_a_preflight_line(
    client, pool, monkeypatch, mount_backend
):
    monkeypatch.setenv("OLLAMA_URL", "http://ollama.test")
    fake = FakeOllama(pull_lines=('{"status":"pulling","completed":1}', '{"status":"success"}'))
    mount_backend("http://ollama.test", fake.app)
    await backends.save_config(pool, {"kind": "ollama"})

    resp = await client.post("/admin/pull", json={"model": "qwen3:8b"})

    assert resp.status_code == 200
    lines = _lines(resp.content)
    assert lines[0]["status"] == "preflight"
    assert lines[1:] == [
        {"status": "pulling", "completed": 1},
        {"status": "success"},
    ]
    assert fake.seen[-1] == ("/api/pull", {"model": "qwen3:8b"})


async def test_pull_preflight_states_the_free_space_check_for_a_known_size(
    client, pool, monkeypatch, mount_backend, tmp_path
):
    from app import admin

    monkeypatch.setattr(admin, "MODELS_DIR", tmp_path)
    monkeypatch.setenv("OLLAMA_URL", "http://ollama.test")
    mount_backend("http://ollama.test", FakeOllama().app)
    await backends.save_config(pool, {"kind": "ollama"})

    resp = await client.post("/admin/pull", json={"model": "qwen3:8b"})  # curated, size known

    lines = _lines(resp.content)
    assert lines[0]["status"] == "preflight"
    assert "required_gb" in lines[0]
    assert "free_gb" in lines[0]
    assert "ok" in lines[0]


async def test_pull_preflight_says_so_when_the_size_is_unknown(
    client, pool, monkeypatch, mount_backend
):
    monkeypatch.setenv("OLLAMA_URL", "http://ollama.test")
    mount_backend("http://ollama.test", FakeOllama().app)
    await backends.save_config(pool, {"kind": "ollama"})

    resp = await client.post("/admin/pull", json={"model": "totally-unknown-model"})

    lines = _lines(resp.content)
    assert lines[0]["status"] == "preflight"
    assert "unknown" in lines[0]["note"]
    assert "required_gb" not in lines[0]


async def test_pull_unreachable_ollama_is_a_stated_502(client, pool, monkeypatch):
    monkeypatch.setenv("OLLAMA_URL", "http://127.0.0.1:1")
    await backends.save_config(pool, {"kind": "ollama"})

    resp = await client.post("/admin/pull", json={"model": "qwen3:8b"})

    assert resp.status_code == 502
    assert "error" in resp.json()


async def test_pull_ollama_refusal_is_passed_through(client, pool, monkeypatch, mount_backend):
    monkeypatch.setenv("OLLAMA_URL", "http://ollama.test")
    mount_backend("http://ollama.test", FakeOllama(pull_status=404).app)
    await backends.save_config(pool, {"kind": "ollama"})

    resp = await client.post("/admin/pull", json={"model": "does-not-exist"})

    assert resp.status_code == 404
