"""POST /admin/probe — one real 1-token round-trip, persisted either way.
A failed probe is still a 200: the probe itself worked, it just learned
the backend is down."""
from __future__ import annotations

from app import backends
from tests.conftest import requires_db
from tests.fakes import FakeOllama, FakeOpenAICompat

pytestmark = requires_db


async def test_probe_success_is_persisted_and_returned(client, pool, monkeypatch, mount_backend):
    monkeypatch.setenv("OLLAMA_URL", "http://ollama.test")
    fake = FakeOllama(vram_bytes=6_000_000_000, probe_model_name="qwen3:8b")
    mount_backend("http://ollama.test", fake.app)
    await backends.save_config(pool, {"kind": "ollama"})

    resp = await client.post("/admin/probe", json={"model": "qwen3:8b"})

    assert resp.status_code == 200
    body = resp.json()
    assert body["ok"] is True
    assert body["model"] == "qwen3:8b"
    assert body["kind"] == "ollama"
    assert body["latency_ms"] >= 0
    assert body["vram_mb"] == 6_000_000_000 // (1024 * 1024)
    assert body["error"] is None

    row = await pool.fetchrow("SELECT * FROM probes WHERE id = $1", body["id"])
    assert row["ok"] is True
    assert row["model"] == "qwen3:8b"


async def test_probe_failure_is_persisted_with_ok_false_and_still_200(
    client, pool, monkeypatch, mount_backend
):
    monkeypatch.setenv("OLLAMA_URL", "http://ollama.test")
    fake = FakeOllama(probe_status=500)
    mount_backend("http://ollama.test", fake.app)
    await backends.save_config(pool, {"kind": "ollama"})

    resp = await client.post("/admin/probe", json={"model": "qwen3:8b"})

    assert resp.status_code == 200
    body = resp.json()
    assert body["ok"] is False
    assert body["error"]

    row = await pool.fetchrow("SELECT * FROM probes WHERE id = $1", body["id"])
    assert row["ok"] is False
    assert row["error"] == body["error"]


async def test_probe_unreachable_backend_is_also_a_persisted_failure(client, pool, monkeypatch):
    monkeypatch.setenv("OLLAMA_URL", "http://127.0.0.1:1")
    await backends.save_config(pool, {"kind": "ollama"})

    resp = await client.post("/admin/probe", json={"model": "qwen3:8b"})

    assert resp.status_code == 200
    body = resp.json()
    assert body["ok"] is False
    assert await pool.fetchval("SELECT count(*) FROM probes") == 1


async def test_probe_against_a_remote_backend_has_no_vram_reading(
    client, pool, mount_backend
):
    fake = FakeOpenAICompat()
    mount_backend("http://remote.test", fake.app)
    await backends.save_config(pool, {"kind": "remote", "url": "http://remote.test"})

    resp = await client.post("/admin/probe", json={"model": "some-model"})

    assert resp.status_code == 200
    body = resp.json()
    assert body["ok"] is True
    assert body["vram_mb"] is None
