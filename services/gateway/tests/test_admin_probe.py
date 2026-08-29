"""POST /admin/probe — one real 1-token round-trip, persisted either way.
A failed probe is still a 200: the probe itself worked, it just learned
the backend is down.

Ruling S2f-R3 (the 17-vs-22 bug): `vram_mb` now comes from an nvidia-smi
used-MiB delta bracketing the load — a snapshot taken immediately before
the completion request that loads the model, and another immediately
after it answers — never ollama's own /api/ps size_vram (weights only).
`admin._nvidia_smi_used_mb` is the seam these tests fake: a real host
either has it (GPU device passthrough, see deploy/docker-compose.gpu.yml)
or it degrades to `(None, reason)`, exercised below too.
"""
from __future__ import annotations

from app import admin, backends
from tests.conftest import requires_db
from tests.fakes import FakeOllama, FakeOpenAICompat

pytestmark = requires_db


def _fake_nvidia_smi_sequence(*readings: tuple[float, str | None]):
    """An `admin._nvidia_smi_used_mb` replacement that returns each of
    `readings` in order — one call per bracket edge (before, then after)."""
    it = iter(readings)

    async def _fake():
        return next(it)

    return _fake


async def test_probe_success_is_persisted_and_returned(client, pool, monkeypatch, mount_backend):
    monkeypatch.setenv("OLLAMA_URL", "http://ollama.test")
    fake = FakeOllama(probe_model_name="qwen3:8b")
    mount_backend("http://ollama.test", fake.app)
    await backends.save_config(pool, {"kind": "ollama"})
    # 13671 -> 23300 MiB is a realistic bracket for an 8B-class total
    # footprint (weights + KV + buffers), the real quantity needed_gb must
    # represent (see app/fit.py's module docstring, ruling S2f-R3).
    monkeypatch.setattr(
        admin, "_nvidia_smi_used_mb", _fake_nvidia_smi_sequence((13671.0, None), (23300.0, None))
    )

    resp = await client.post("/admin/probe", json={"model": "qwen3:8b"})

    assert resp.status_code == 200
    body = resp.json()
    assert body["ok"] is True
    assert body["model"] == "qwen3:8b"
    assert body["kind"] == "ollama"
    assert body["latency_ms"] >= 0
    assert body["vram_mb"] == 9629  # 23300 - 13671, the bracketed delta
    assert body["error"] is None

    row = await pool.fetchrow("SELECT * FROM probes WHERE id = $1", body["id"])
    assert row["ok"] is True
    assert row["model"] == "qwen3:8b"


async def test_probe_vram_is_the_nvidia_smi_delta_never_apips_size_vram(
    client, pool, monkeypatch, mount_backend
):
    """The exact bug ruling S2f-R3 exists to fix: even when /api/ps reports
    a (deliberately different) size_vram figure, the probe's vram_mb must
    come from the nvidia-smi bracket, not that number."""
    monkeypatch.setenv("OLLAMA_URL", "http://ollama.test")
    fake = FakeOllama(vram_bytes=17_400_000_000, probe_model_name="qwen3.8:27b")
    mount_backend("http://ollama.test", fake.app)
    await backends.save_config(pool, {"kind": "ollama"})
    monkeypatch.setattr(
        admin, "_nvidia_smi_used_mb", _fake_nvidia_smi_sequence((1000.0, None), (23369.0, None))
    )

    resp = await client.post("/admin/probe", json={"model": "qwen3.8:27b"})

    body = resp.json()
    assert body["ok"] is True
    assert body["vram_mb"] == 22369  # NOT ~16593 (17_400_000_000 // 1024**2)


async def test_probe_still_succeeds_when_nvidia_smi_is_unavailable(
    client, pool, monkeypatch, mount_backend
):
    """A gateway container without GPU device passthrough yet (or a host
    with no NVIDIA driver at all) must not fail an otherwise-successful
    probe — it degrades exactly like a remote backend's probe already
    does: ok=True, vram_mb=None, never a crash."""
    monkeypatch.setenv("OLLAMA_URL", "http://ollama.test")
    fake = FakeOllama(probe_model_name="qwen3:8b")
    mount_backend("http://ollama.test", fake.app)
    await backends.save_config(pool, {"kind": "ollama"})

    async def _unavailable():
        return None, "nvidia-smi could not be run — [Errno 2] No such file or directory"

    monkeypatch.setattr(admin, "_nvidia_smi_used_mb", _unavailable)

    resp = await client.post("/admin/probe", json={"model": "qwen3:8b"})

    body = resp.json()
    assert body["ok"] is True
    assert body["vram_mb"] is None


async def test_probe_a_non_positive_delta_is_unreliable_not_a_measurement(
    client, pool, monkeypatch, mount_backend
):
    """A model that just loaded must use SOME positive VRAM. A zero or
    negative delta means the bracket was contaminated — most likely the
    model was already resident before the 'before' snapshot (a warm, not
    cold, probe) — and storing it anyway would poison a 'verified' badge
    with a number that is not a real measurement of this load."""
    monkeypatch.setenv("OLLAMA_URL", "http://ollama.test")
    fake = FakeOllama(probe_model_name="qwen3:8b")
    mount_backend("http://ollama.test", fake.app)
    await backends.save_config(pool, {"kind": "ollama"})
    monkeypatch.setattr(
        admin, "_nvidia_smi_used_mb", _fake_nvidia_smi_sequence((20000.0, None), (19500.0, None))
    )

    resp = await client.post("/admin/probe", json={"model": "qwen3:8b"})

    body = resp.json()
    assert body["ok"] is True
    assert body["vram_mb"] is None


async def test_probe_against_a_remote_backend_never_shells_out_to_nvidia_smi(
    client, pool, mount_backend, monkeypatch
):
    """Only a local ollama backend consumes THIS host's GPU — a remote/cloud
    probe must never even attempt the bracket."""
    calls: list[int] = []

    async def _spy():
        calls.append(1)
        return 1234.0, None

    monkeypatch.setattr(admin, "_nvidia_smi_used_mb", _spy)
    fake = FakeOpenAICompat()
    mount_backend("http://remote.test", fake.app)
    await backends.save_config(pool, {"kind": "remote", "url": "http://remote.test"})

    resp = await client.post("/admin/probe", json={"model": "some-model"})

    assert resp.json()["vram_mb"] is None
    assert calls == []


def test_probe_timeout_gives_a_cold_large_model_a_real_load_window():
    """The 2026-08-29 walk's own probe of qwen3.8:27b timed out at 30060ms
    against the old flat 30s httpx.Timeout(30.0) — a cold ~18GB-weights
    load routinely exceeds that. Bounded (a probe that can hang forever is
    not useful either — the brief's own "or a longer bounded timeout"), but
    long enough for a real cold load to actually finish; connect stays
    short since that phase was never what timed out."""
    assert admin.PROBE_TIMEOUT.connect <= 10.0
    assert admin.PROBE_TIMEOUT.read >= 120.0


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
