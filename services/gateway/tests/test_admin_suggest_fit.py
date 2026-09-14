"""GET /admin/suggest's fit verdicts: the FREE-VRAM calc (ruling S2e-R2)
wired through the real route — the CARD (S22: one live nvidia-smi read),
ollama's live /api/ps, and the probes table all have to agree with what
app/fit.py computes.

Every test here fakes the card explicitly. That is not only for
determinism: before S22 these tests wrote a hardware.json fixture and the
route read it, and the moment the route started reading the real GPU
instead, several of them kept passing by accident on a developer machine
that happens to have a 24GB card. A test that passes because of the
hardware under the desk is not measuring the code.
"""

from __future__ import annotations

from app import backends, devices_vram
from app import curated as curated_mod
from tests.conftest import requires_db
from tests.fakes import FakeOllama

pytestmark = requires_db

# The desktop baseline this host always carries (Xwayland/WSL2, ~2.6GB).
# In the S22 frame it lives ONLY on the free side — the driver has already
# subtracted it — so a 24GB card idles at ~21.4GB free.
IDLE_FREE_MB = 21914.0


def _card(monkeypatch, total_mb: float, free_mb: float) -> None:
    """Fake the one live nvidia-smi read the whole fit path now shares."""

    async def _read():
        return devices_vram.Vram(total_mb=total_mb, used_mb=total_mb - free_mb, free_mb=free_mb)

    monkeypatch.setattr(devices_vram, "read_vram", _read)


def _no_card(monkeypatch, reason: str) -> None:
    async def _read():
        return devices_vram.Vram(reason=reason)

    monkeypatch.setattr(devices_vram, "read_vram", _read)


def _fit_for(body: dict, slug: str) -> dict:
    return next(m for m in body["models"] if m["slug"] == slug)["fit"]


async def test_nothing_resident_free_is_what_the_card_actually_reports(
    client, pool, monkeypatch, tmp_path, mount_backend
):
    # 24GB card, ollama up but nothing currently loaded. Free is NOT total:
    # the desktop's own ~2.6GB is already gone from the driver's figure, so
    # an idle card reports 21.4GB free. Before S22 this read 24.0 forever.
    _card(monkeypatch, 24576, IDLE_FREE_MB)
    monkeypatch.setenv("OLLAMA_URL", "http://ollama.test")
    fake = FakeOllama(ps_models=[])
    mount_backend("http://ollama.test", fake.app)
    await backends.save_config(pool, {"kind": "ollama"})

    resp = await client.get("/admin/suggest")

    assert resp.status_code == 200
    body = resp.json()
    # S22 re-anchored the 27B's curated estimate from 22 to 18. Ruling
    # S2f-R3 had raised it to 22 because `needed_gb` then meant the whole
    # card's used counter, baseline included; in the S22 frame it means the
    # model's own VRAM, and the walk's own measurement of that is the 17.4GB
    # size_vram, rounded up. Both numbers describe the same 2026-08-29
    # measurement — they differ by the baseline, which moved sides.
    #
    # 3.4GB of headroom on 21.4 free is 15.9%: under the 25% line, so still
    # `tight`, which remains the honest verdict for this model on this card.
    top_fit = _fit_for(body, "qwen3.8:27b")
    assert top_fit == {
        "verdict": "tight",
        "needed_gb": 18.0,
        "free_gb": 21.4,
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
    resident, so the card itself reports only ~4GB free. Taking that
    instantaneous figure would read every model >=4GB (including the 8B) as
    `wont_fit` — the exact bug this ruling exists to fix. Adding back what
    the switch evicts returns the idle 21.4GB.
    """
    _card(monkeypatch, 24576, IDLE_FREE_MB - 17.4 * 1024)
    monkeypatch.setenv("OLLAMA_URL", "http://ollama.test")
    fake = FakeOllama(
        ps_models=[{"name": "qwen3.8:27b", "size_vram": int(17.4 * 1024 * 1024 * 1024)}]
    )
    mount_backend("http://ollama.test", fake.app)
    await backends.save_config(pool, {"kind": "ollama"})

    resp = await client.get("/admin/suggest")

    body = resp.json()
    # qwen3:8b is installed, so its needed_gb is the download's own byte
    # count from /api/tags (4.9GB here) rather than the curated 10 — a fact
    # about this host's copy beating a hand-written integer. Eviction-aware
    # free is 21.4GB, so the headroom is comfortably over the 25% line.
    eight_b_fit = _fit_for(body, "qwen3:8b")
    assert eight_b_fit["verdict"] == "comfortable"
    assert eight_b_fit["free_gb"] == 21.4
    assert eight_b_fit["needed_gb"] == 4.9
    assert eight_b_fit["source"] == "estimated"


async def test_a_model_bigger_than_the_whole_card_still_wont_fit_even_after_eviction(
    client, pool, monkeypatch, tmp_path, mount_backend
):
    """Eviction-aware free never invents headroom a switch cannot actually
    produce: giving back what ollama holds is all it does."""
    _card(monkeypatch, 24576, IDLE_FREE_MB - 17.4 * 1024)
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
            "note": "test-only fixture",
            "use_cases": ["chat"],
            "use_cases_verified_at": "2026-09-06",
            "verify_at_walk": False,
            "verified_at": "2026-08-29",
            "verified_url": "https://ollama.com/library/huge/tags",
        }
    ]
    monkeypatch.setattr(curated_mod, "load_curated", lambda *a, **k: curated)

    resp = await client.get("/admin/suggest")

    fit = _fit_for(resp.json(), "huge:70b")
    assert fit["verdict"] == "wont_fit"
    assert fit["free_gb"] == 21.4
    assert fit["needed_gb"] == 30.0


async def test_a_probe_row_is_preferred_over_the_curated_estimate(
    client, pool, monkeypatch, tmp_path, mount_backend
):
    _card(monkeypatch, 24576, IDLE_FREE_MB)
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
    _card(monkeypatch, 24576, IDLE_FREE_MB)
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


async def test_the_card_being_unreadable_is_unknown_for_every_model(
    client, pool, monkeypatch, tmp_path
):
    """No GPU passthrough, no driver, a wedged card — whatever nvidia-smi
    said, its own words are what every model's fit reports. Not a guess,
    and not a silent zero."""
    _no_card(monkeypatch, "nvidia-smi could not be run — [Errno 2] No such file or directory")

    resp = await client.get("/admin/suggest")

    body = resp.json()
    assert body["models"], "the 3-4B tier still offers a model with no GPU"
    for model in body["models"]:
        assert model["fit"]["verdict"] == "unknown"
        assert model["fit"]["free_gb"] is None
        assert model["fit"]["total_gb"] is None
        assert "nvidia-smi could not be run" in model["fit"]["reason"]


async def test_non_ollama_backend_is_unknown_but_states_why(client, pool, monkeypatch, tmp_path):
    _card(monkeypatch, 24576, IDLE_FREE_MB)
    await backends.save_config(pool, {"kind": "remote", "url": "http://remote.test"})

    resp = await client.get("/admin/suggest")

    fit = _fit_for(resp.json(), "qwen3.8:27b")
    assert fit["verdict"] == "unknown"
    # The card's capacity IS known the moment nvidia-smi answers; only free
    # VRAM needs ollama, so only free VRAM degrades.
    assert fit["total_gb"] == 24.0
    assert fit["free_gb"] is None
    assert "remote" in fit["reason"]


async def test_ollama_url_unset_is_unknown_but_states_why(client, pool, monkeypatch, tmp_path):
    _card(monkeypatch, 24576, IDLE_FREE_MB)
    monkeypatch.delenv("OLLAMA_URL", raising=False)
    await backends.save_config(pool, {"kind": "ollama"})

    resp = await client.get("/admin/suggest")

    fit = _fit_for(resp.json(), "qwen3.8:27b")
    assert fit["verdict"] == "unknown"
    assert "OLLAMA_URL" in fit["reason"]


async def test_ollama_unreachable_is_unknown_but_states_why(client, pool, monkeypatch, tmp_path):
    _card(monkeypatch, 24576, IDLE_FREE_MB)
    monkeypatch.setenv("OLLAMA_URL", "http://127.0.0.1:1")
    await backends.save_config(pool, {"kind": "ollama"})

    resp = await client.get("/admin/suggest")

    fit = _fit_for(resp.json(), "qwen3.8:27b")
    assert fit["verdict"] == "unknown"
    assert fit["reason"]
