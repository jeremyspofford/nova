"""GET /admin/suggest's fit verdicts: the FREE-VRAM calc (ruling S2e-R2)
wired through the real route — hardware.json, ollama's live /api/ps, and
the probes table all have to agree with what app/fit.py computes.
"""
from __future__ import annotations

from app import admin, backends
from tests.conftest import requires_db
from tests.fakes import FakeOllama

pytestmark = requires_db


def _write_hardware(monkeypatch, tmp_path, vram_mb: int) -> None:
    hw_file = tmp_path / "hardware.json"
    hw_file.write_text(f'{{"gpus": [{{"name": "gpu", "vram_mb": {vram_mb}}}]}}')
    monkeypatch.setattr(admin, "HARDWARE_PATH", hw_file)


def _fit_for(body: dict, slug: str) -> dict:
    return next(m for m in body["models"] if m["slug"] == slug)["fit"]


async def test_nothing_resident_free_equals_total_and_estimate_is_the_source(
    client, pool, monkeypatch, tmp_path, mount_backend
):
    # 24GB card, ollama up but nothing currently loaded: free == total == 24.
    _write_hardware(monkeypatch, tmp_path, 24576)
    monkeypatch.setenv("OLLAMA_URL", "http://ollama.test")
    fake = FakeOllama(ps_models=[])
    mount_backend("http://ollama.test", fake.app)
    await backends.save_config(pool, {"kind": "ollama"})

    resp = await client.get("/admin/suggest")

    assert resp.status_code == 200
    body = resp.json()
    # The 27B tier's top pick needs (estimate) 17GB out of 24 free: 7GB
    # headroom is 29% of free, over the 25% tight line -> comfortable.
    # (min_vram_gb was 24 — a card-tier floor mis-consumed as a load
    # estimate; the repo's own measurement (tests/e2e/measurements/
    # s2-two-model.json) put actual load at 16.2GB, so 17 is a realistic
    # estimate with margin, still comfortably under measured+headroom.)
    top_fit = _fit_for(body, "qwen3.8:27b")
    assert top_fit == {
        "verdict": "comfortable",
        "needed_gb": 17.0,
        "free_gb": 24.0,
        "total_gb": 24.0,
        "source": "estimated",
        "reason": None,
    }


async def test_a_resident_model_reduces_free_vram_for_everything_else(
    client, pool, monkeypatch, tmp_path, mount_backend
):
    # 24GB card, a 4GB (4096 MiB) model already resident -> 20GB free.
    _write_hardware(monkeypatch, tmp_path, 24576)
    monkeypatch.setenv("OLLAMA_URL", "http://ollama.test")
    fake = FakeOllama(ps_models=[{"name": "other:model", "size_vram": 4096 * 1024 * 1024}])
    mount_backend("http://ollama.test", fake.app)
    await backends.save_config(pool, {"kind": "ollama"})

    resp = await client.get("/admin/suggest")

    body = resp.json()
    # qwen3:8b's estimate is 10GB; 20GB free leaves 10GB headroom (50% of
    # free, comfortably over the 25% line).
    eight_b_fit = _fit_for(body, "qwen3:8b")
    assert eight_b_fit["verdict"] == "comfortable"
    assert eight_b_fit["free_gb"] == 20.0
    assert eight_b_fit["needed_gb"] == 10.0
    assert eight_b_fit["source"] == "estimated"


async def test_a_probe_row_is_preferred_over_the_curated_estimate(
    client, pool, monkeypatch, tmp_path, mount_backend
):
    _write_hardware(monkeypatch, tmp_path, 24576)
    monkeypatch.setenv("OLLAMA_URL", "http://ollama.test")
    fake = FakeOllama(ps_models=[])
    mount_backend("http://ollama.test", fake.app)
    await backends.save_config(pool, {"kind": "ollama"})
    # A real probe of qwen3:8b measured 9508 MiB (the S2 measurement's own
    # figure) — this must win over the curated catalog's 10GB estimate.
    await pool.execute(
        "INSERT INTO probes (model, kind, ok, latency_ms, vram_mb, error) "
        "VALUES ('qwen3:8b', 'ollama', true, 100, 9508, NULL)"
    )

    resp = await client.get("/admin/suggest")

    fit = _fit_for(resp.json(), "qwen3:8b")
    assert fit["source"] == "verified"
    assert fit["needed_gb"] == round(9508 / 1024, 1)


async def test_a_failed_probe_row_never_overrides_the_estimate(
    client, pool, monkeypatch, tmp_path, mount_backend
):
    _write_hardware(monkeypatch, tmp_path, 24576)
    monkeypatch.setenv("OLLAMA_URL", "http://ollama.test")
    fake = FakeOllama(ps_models=[])
    mount_backend("http://ollama.test", fake.app)
    await backends.save_config(pool, {"kind": "ollama"})
    # A probe that failed (ok=false) is not a measurement — must not win.
    await pool.execute(
        "INSERT INTO probes (model, kind, ok, latency_ms, vram_mb, error) "
        "VALUES ('qwen3:8b', 'ollama', false, 100, NULL, 'timed out')"
    )
    # An OLDER successful probe exists too — the newest ok=true row must win
    # over a still-older one, and both must beat the failed one above.
    await pool.execute(
        "INSERT INTO probes (model, kind, ok, latency_ms, vram_mb, error, created_at) "
        "VALUES ('qwen3:8b', 'ollama', true, 100, 8000, NULL, now() - interval '1 day')"
    )
    await pool.execute(
        "INSERT INTO probes (model, kind, ok, latency_ms, vram_mb, error, created_at) "
        "VALUES ('qwen3:8b', 'ollama', true, 100, 9508, NULL, now())"
    )

    resp = await client.get("/admin/suggest")

    fit = _fit_for(resp.json(), "qwen3:8b")
    assert fit["source"] == "verified"
    assert fit["needed_gb"] == round(9508 / 1024, 1)


async def test_no_gpu_detected_is_unknown_for_every_model(
    client, pool, monkeypatch, tmp_path
):
    monkeypatch.setattr(admin, "HARDWARE_PATH", tmp_path / "nonexistent.json")

    resp = await client.get("/admin/suggest")

    body = resp.json()
    assert body["models"], "the 3-4B tier still offers a model with no GPU"
    for model in body["models"]:
        assert model["fit"]["verdict"] == "unknown"
        assert model["fit"]["free_gb"] is None
        assert "no GPU" in model["fit"]["reason"]


async def test_non_ollama_backend_is_unknown_but_states_why(
    client, pool, monkeypatch, tmp_path
):
    _write_hardware(monkeypatch, tmp_path, 24576)
    await backends.save_config(pool, {"kind": "remote", "url": "http://remote.test"})

    resp = await client.get("/admin/suggest")

    fit = _fit_for(resp.json(), "qwen3.8:27b")
    assert fit["verdict"] == "unknown"
    assert fit["total_gb"] == 24.0  # the GPU total IS known — only free VRAM is not
    assert fit["free_gb"] is None
    assert "remote" in fit["reason"]


async def test_ollama_url_unset_is_unknown_but_states_why(
    client, pool, monkeypatch, tmp_path
):
    _write_hardware(monkeypatch, tmp_path, 24576)
    monkeypatch.delenv("OLLAMA_URL", raising=False)
    await backends.save_config(pool, {"kind": "ollama"})

    resp = await client.get("/admin/suggest")

    fit = _fit_for(resp.json(), "qwen3.8:27b")
    assert fit["verdict"] == "unknown"
    assert "OLLAMA_URL" in fit["reason"]


async def test_ollama_unreachable_is_unknown_but_states_why(
    client, pool, monkeypatch, tmp_path
):
    _write_hardware(monkeypatch, tmp_path, 24576)
    monkeypatch.setenv("OLLAMA_URL", "http://127.0.0.1:1")
    await backends.save_config(pool, {"kind": "ollama"})

    resp = await client.get("/admin/suggest")

    fit = _fit_for(resp.json(), "qwen3.8:27b")
    assert fit["verdict"] == "unknown"
    assert fit["reason"]
