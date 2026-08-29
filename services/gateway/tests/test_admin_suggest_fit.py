"""GET /admin/suggest's fit verdicts: the FREE-VRAM calc (ruling S2e-R2)
wired through the real route — hardware.json, ollama's live /api/ps, and
the probes table all have to agree with what app/fit.py computes.
"""
from __future__ import annotations

from app import admin, backends
from app import curated as curated_mod
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
    # Ruling S2f-R1 REVERSES the S2e 24->17 change: 17 was ollama's
    # size_vram (WEIGHTS only). The 2026-08-29 walk measured the REAL total
    # footprint (weights + KV@32K + compute buffers) at nvidia-smi
    # ~22369/24576 MiB resident == ~22GB, so the curated estimate is
    # re-anchored to 22. 2GB of headroom on 24 free is 8.3% — under the 25%
    # tight line, which is the honest verdict: this model is a tight fit on
    # a 24GB card even with nothing else running, not "comfortable".
    top_fit = _fit_for(body, "qwen3.8:27b")
    assert top_fit == {
        "verdict": "tight",
        "needed_gb": 22.0,
        "free_gb": 24.0,
        "total_gb": 24.0,
        "source": "estimated",
        "reason": None,
    }


async def test_a_resident_model_does_not_reduce_free_vram_for_a_switch_candidate(
    client, pool, monkeypatch, tmp_path, mount_backend
):
    """Ruling S2f-R2 ("the 8B won't fit" bug), reversing this test's old
    premise: a switch EVICTS whatever is resident, so a resident model no
    longer reduces `free_gb` for a candidate — free is the whole card.

    24GB card, the 27B (17.4GB, the walk's own size_vram figure) already
    resident: instantaneous free would have been 24 - 17.4 = 6.6GB, which
    read every model >=8GB (including the 8B) as `wont_fit` — the exact bug
    this ruling exists to fix.
    """
    _write_hardware(monkeypatch, tmp_path, 24576)
    monkeypatch.setenv("OLLAMA_URL", "http://ollama.test")
    fake = FakeOllama(
        ps_models=[{"name": "qwen3.8:27b", "size_vram": int(17.4 * 1024 * 1024 * 1024)}]
    )
    mount_backend("http://ollama.test", fake.app)
    await backends.save_config(pool, {"kind": "ollama"})

    resp = await client.get("/admin/suggest")

    body = resp.json()
    # qwen3:8b's curated estimate is 10GB; eviction-aware free is the full
    # 24GB, so 14GB headroom (58.3%) is comfortably over the 25% line.
    eight_b_fit = _fit_for(body, "qwen3:8b")
    assert eight_b_fit["verdict"] == "comfortable"
    assert eight_b_fit["free_gb"] == 24.0
    assert eight_b_fit["needed_gb"] == 10.0
    assert eight_b_fit["source"] == "estimated"


async def test_a_model_bigger_than_the_whole_card_still_wont_fit_even_after_eviction(
    client, pool, monkeypatch, tmp_path, mount_backend
):
    """Eviction-aware free is still bounded by the card's real total — it
    never invents headroom a switch cannot actually produce."""
    _write_hardware(monkeypatch, tmp_path, 24576)
    monkeypatch.setenv("OLLAMA_URL", "http://ollama.test")
    fake = FakeOllama(
        ps_models=[{"name": "qwen3.8:27b", "size_vram": int(17.4 * 1024 * 1024 * 1024)}]
    )
    mount_backend("http://ollama.test", fake.app)
    await backends.save_config(pool, {"kind": "ollama"})
    # A hypothetical 30GB model — bigger than the 24GB card has, period.
    await pool.execute(
        "INSERT INTO probes (model, kind, ok, latency_ms, vram_mb, error) "
        "VALUES ('huge:70b', 'ollama', true, 100, 30720, NULL)"
    )
    curated = curated_mod.load_curated() + [
        {
            "slug": "huge:70b",
            "label": "Huge 70B",
            "family": "27b",
            "params_b": 70,
            "min_vram_gb": 40,
            "size_gb": 40.0,
            "note": "test-only fixture",
            "verify_at_walk": False,
            "verified_at": "2026-08-29",
            "verified_url": "https://ollama.com/library/huge/tags",
        }
    ]
    monkeypatch.setattr(curated_mod, "load_curated", lambda *a, **k: curated)

    resp = await client.get("/admin/suggest")

    fit = _fit_for(resp.json(), "huge:70b")
    assert fit["verdict"] == "wont_fit"
    assert fit["free_gb"] == 24.0
    assert fit["needed_gb"] == 30.0


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
