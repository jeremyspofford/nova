"""POST /admin/probe — one real 1-token round-trip, persisted either way.
A failed probe is still a 200: the probe itself worked, it just learned
the backend is down.

Ruling S2f-R3 (the 17-vs-22 bug, corrected after review): `vram_mb` is a
SINGLE nvidia-smi used-MiB reading taken immediately after the completion
request that loads the model answers — never ollama's own /api/ps
size_vram (weights only), and, since the review's fix round, never a
before/after DELTA either. A delta is eviction-contaminated: Fix B's own
premise is that a switch evicts whatever was resident before, so probing
model B while model A was resident would have recorded
(baseline+B) - (baseline+A) = B-A, wildly understating B whenever A != B.
The single AFTER reading is eviction-IMMUNE (whatever the completion just
answered from IS what's resident at that instant, regardless of what came
before) and lands in the same WHOLE-CARD frame (baseline included) as the
curated catalog's figures — see app/admin.py's `_footprint_vram_mb` and
app/fit.py's module docstring for the full reasoning. `admin.
_nvidia_smi_used_mb` is the seam these tests fake: a real host either has
it (GPU device passthrough, see deploy/docker-compose.gpu.yml) or it
degrades to `(None, reason)`, exercised below too.
"""
from __future__ import annotations

from app import admin, backends
from tests.conftest import requires_db
from tests.fakes import FakeOllama, FakeOpenAICompat

pytestmark = requires_db


def _fake_nvidia_smi(mb: float | None, reason: str | None = None):
    """An `admin._nvidia_smi_used_mb` replacement returning one fixed
    reading. The probe now takes exactly ONE nvidia-smi snapshot (after a
    successful load) — no `before`, so no sequence is needed."""

    async def _fake():
        return mb, reason

    return _fake


def _counting_fake_nvidia_smi(mb: float):
    """Same as `_fake_nvidia_smi`, but records how many times it was
    called — used to prove the probe reads nvidia-smi exactly once, never
    a before/after pair."""
    calls: list[int] = []

    async def _fake():
        calls.append(1)
        return mb, None

    return _fake, calls


async def test_probe_success_is_persisted_and_returned(client, pool, monkeypatch, mount_backend):
    monkeypatch.setenv("OLLAMA_URL", "http://ollama.test")
    fake = FakeOllama(probe_model_name="qwen3:8b")
    mount_backend("http://ollama.test", fake.app)
    await backends.save_config(pool, {"kind": "ollama"})
    # A single whole-card reading taken AFTER the load succeeds: the ~2.6GB
    # non-model baseline (Xwayland/WSL2) this host always carries, plus the
    # 8B's real footprint — the same frame curated_models.json's whole-card
    # figures use (ruling S2f-R3's "whole-card frame").
    monkeypatch.setattr(admin, "_nvidia_smi_used_mb", _fake_nvidia_smi(12162.0))

    resp = await client.post("/admin/probe", json={"model": "qwen3:8b"})

    assert resp.status_code == 200
    body = resp.json()
    assert body["ok"] is True
    assert body["model"] == "qwen3:8b"
    assert body["kind"] == "ollama"
    assert body["latency_ms"] >= 0
    assert body["vram_mb"] == 12162  # the AFTER reading itself, never a delta
    assert body["error"] is None

    row = await pool.fetchrow("SELECT * FROM probes WHERE id = $1", body["id"])
    assert row["ok"] is True
    assert row["model"] == "qwen3:8b"


async def test_probe_vram_is_the_nvidia_smi_reading_never_apips_size_vram(
    client, pool, monkeypatch, mount_backend
):
    """The exact bug ruling S2f-R3 exists to fix: even when /api/ps reports
    a (deliberately different) size_vram figure, the probe's vram_mb must
    come from nvidia-smi, not that number."""
    monkeypatch.setenv("OLLAMA_URL", "http://ollama.test")
    fake = FakeOllama(vram_bytes=17_400_000_000, probe_model_name="qwen3.8:27b")
    mount_backend("http://ollama.test", fake.app)
    await backends.save_config(pool, {"kind": "ollama"})
    # The walk's own real nvidia-smi reading with the 27B resident.
    monkeypatch.setattr(admin, "_nvidia_smi_used_mb", _fake_nvidia_smi(22369.0))

    resp = await client.post("/admin/probe", json={"model": "qwen3.8:27b"})

    body = resp.json()
    assert body["ok"] is True
    assert body["vram_mb"] == 22369  # NOT ~16593 (17_400_000_000 // 1024**2)


async def test_probe_reading_is_correct_when_a_different_larger_model_was_resident(
    client, pool, monkeypatch, mount_backend
):
    """The critical bug review caught: probing model B while a DIFFERENT
    model A (here, the much bigger 27B) was resident must still record B's
    own whole-card footprint, not something derived from A's. A switch
    EVICTS A (Fix B's own premise), so by the time this completion answers
    the 27B is gone and the 8B is what's actually resident — nvidia-smi
    reads baseline+8B regardless of what was there a moment ago. The old
    (wrong) before/after-delta design would have subtracted the 27B's much
    larger footprint from this reading and produced a small or negative
    number; the fix calls nvidia-smi exactly ONCE, after the load, so there
    is no 'before' value left in the calculation to contaminate it.
    """
    monkeypatch.setenv("OLLAMA_URL", "http://ollama.test")
    fake = FakeOllama(probe_model_name="qwen3:8b")
    mount_backend("http://ollama.test", fake.app)
    await backends.save_config(pool, {"kind": "ollama"})
    # Whatever nvidia-smi reads AFTER this load succeeds is baseline+8B —
    # a small, correct number — even though a much bigger model (27B,
    # ~22369 MiB) was resident just before this probe started.
    fake_smi, calls = _counting_fake_nvidia_smi(12162.0)
    monkeypatch.setattr(admin, "_nvidia_smi_used_mb", fake_smi)

    resp = await client.post("/admin/probe", json={"model": "qwen3:8b"})

    body = resp.json()
    assert body["ok"] is True
    assert body["vram_mb"] == 12162
    # Exactly one nvidia-smi call: no 'before' snapshot exists to have been
    # contaminated by the 27B's much larger footprint in the first place.
    assert calls == [1]


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
    monkeypatch.setattr(
        admin,
        "_nvidia_smi_used_mb",
        _fake_nvidia_smi(None, "nvidia-smi could not be run — [Errno 2] No such file or directory"),
    )

    resp = await client.post("/admin/probe", json={"model": "qwen3:8b"})

    body = resp.json()
    assert body["ok"] is True
    assert body["vram_mb"] is None


async def test_probe_a_non_positive_reading_is_unreliable_not_a_measurement(
    client, pool, monkeypatch, mount_backend
):
    """A card with anything resident always uses SOME VRAM greater than
    zero — a zero or negative nvidia-smi reading means the tool itself is
    unreliable right now, and storing it anyway would poison a 'verified'
    badge with a number that measured nothing."""
    monkeypatch.setenv("OLLAMA_URL", "http://ollama.test")
    fake = FakeOllama(probe_model_name="qwen3:8b")
    mount_backend("http://ollama.test", fake.app)
    await backends.save_config(pool, {"kind": "ollama"})
    monkeypatch.setattr(admin, "_nvidia_smi_used_mb", _fake_nvidia_smi(0.0))

    resp = await client.post("/admin/probe", json={"model": "qwen3:8b"})

    body = resp.json()
    assert body["ok"] is True
    assert body["vram_mb"] is None


async def test_probe_against_a_remote_backend_never_shells_out_to_nvidia_smi(
    client, pool, mount_backend, monkeypatch
):
    """Only a local ollama backend consumes THIS host's GPU — a remote/cloud
    probe must never even attempt to read nvidia-smi."""
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
