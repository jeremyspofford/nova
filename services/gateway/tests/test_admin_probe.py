"""POST /admin/probe — one real 1-token round-trip, persisted either way.
A failed probe is still a 200: the probe itself worked, it just learned
the backend is down.

S22 moved `vram_mb` to ollama's own /api/ps `size_vram` for the model that
just answered, read AFTER the completion so the model is certainly
resident. The frame it lives in is stated once in app/fit.py: `needed_gb`
is what the MODEL costs, never the machine's whole-card usage, because the
desktop baseline now lives on the FREE side where the driver has already
subtracted it.

Ruling S2f-R3's whole-card nvidia-smi reading is gone, and the reason it
had to go is the same failure this whole slice exists for. On 2026-09-12 a
video game held ~7 GB of this card for six hours. An undirected used-MiB
reading taken during it would have recorded 7 GB of somebody else's texture
memory as the model's own footprint and stored it as `verified` — and under
WSL2 nothing in this container could even have named the process. /api/ps
is the one per-model figure on this host that is genuinely attributable.

What S2f-R3 got right is kept: the reading is taken AFTER the load, never
as a before/after delta, so it is eviction-immune by construction —
whatever just served the request is what /api/ps names, regardless of what
was loaded a moment earlier.
"""

from __future__ import annotations

from app import admin, backends, compute_id, devices_vram, engines
from tests.conftest import requires_db
from tests.fakes import FakeOllama, FakeOpenAICompat
from tests.test_admin_suggest_fit import CARD_UUID, COMPUTE, IDLE_FREE_MB, _card, _fit_for

pytestmark = requires_db


async def test_probe_success_is_persisted_and_returned(client, pool, monkeypatch, mount_backend):
    monkeypatch.setenv("OLLAMA_URL", "http://ollama.test")
    # The 8B's own resident footprint — weights plus its KV cache at the
    # serving context, ollama's own count, attributable to this model.
    fake = FakeOllama(probe_model_name="qwen3:8b", vram_bytes=9_970_000_000)
    mount_backend("http://ollama.test", fake.app)
    await backends.save_config(pool, {"kind": "ollama"})

    resp = await client.post("/admin/probe", json={"model": "qwen3:8b"})

    assert resp.status_code == 200
    body = resp.json()
    assert body["ok"] is True
    assert body["model"] == "qwen3:8b"
    assert body["kind"] == "ollama"
    assert body["latency_ms"] >= 0
    assert body["vram_mb"] == int(9_970_000_000 / (1024 * 1024))
    assert body["error"] is None

    row = await pool.fetchrow("SELECT * FROM probes WHERE id = $1", body["id"])
    assert row["ok"] is True
    assert row["model"] == "qwen3:8b"


async def test_probe_records_only_the_model_that_answered_not_the_whole_card(
    client, pool, monkeypatch, mount_backend
):
    """THE 2026-09-12 CASE. A second, much larger model is resident on the
    same card — stand-in for any consumer an undirected reading would have
    swept into the figure, including the video game that actually did it.
    The probe must record the 8B's own 9.9 GB, never the 27 GB the card is
    holding in total."""
    monkeypatch.setenv("OLLAMA_URL", "http://ollama.test")
    fake = FakeOllama(
        probe_model_name="qwen3:8b",
        ps_models=[
            {"name": "qwen3:8b", "size_vram": 9_970_000_000},
            {"name": "qwen3.8:27b", "size_vram": 17_400_000_000},
        ],
    )
    mount_backend("http://ollama.test", fake.app)
    await backends.save_config(pool, {"kind": "ollama"})

    resp = await client.post("/admin/probe", json={"model": "qwen3:8b"})

    body = resp.json()
    assert body["ok"] is True
    assert body["vram_mb"] == int(9_970_000_000 / (1024 * 1024))


async def test_probe_reading_is_correct_when_a_different_larger_model_was_resident(
    client, pool, monkeypatch, mount_backend
):
    """Eviction immunity, kept from ruling S2f-R3's fix round: probing model
    B after a much bigger model A was resident must record B's own
    footprint, not something derived from A's. The read happens AFTER the
    completion answers, by which point the switch has evicted A, so there is
    no 'before' value anywhere in the calculation to contaminate."""
    monkeypatch.setenv("OLLAMA_URL", "http://ollama.test")
    fake = FakeOllama(probe_model_name="qwen3:8b", vram_bytes=9_970_000_000)
    mount_backend("http://ollama.test", fake.app)
    await backends.save_config(pool, {"kind": "ollama"})

    resp = await client.post("/admin/probe", json={"model": "qwen3:8b"})

    body = resp.json()
    assert body["ok"] is True
    assert body["vram_mb"] == int(9_970_000_000 / (1024 * 1024))


async def test_probe_still_succeeds_when_the_model_is_not_in_the_resident_table(
    client, pool, monkeypatch, mount_backend
):
    """An engine that reports no size_vram, or a model evicted between the
    answer and the read, leaves the footprint UNKNOWN — vram_mb is None and
    the probe is still a success, degrading exactly as a remote backend's
    probe already does. Never a zero: a zero would read `comfortable` on
    any card."""
    monkeypatch.setenv("OLLAMA_URL", "http://ollama.test")
    fake = FakeOllama(probe_model_name="qwen3:8b", ps_models=[])
    mount_backend("http://ollama.test", fake.app)
    await backends.save_config(pool, {"kind": "ollama"})

    resp = await client.post("/admin/probe", json={"model": "qwen3:8b"})

    body = resp.json()
    assert body["ok"] is True
    assert body["vram_mb"] is None


async def test_probe_a_non_positive_reading_is_unreliable_not_a_measurement(
    client, pool, monkeypatch, mount_backend
):
    """A resident model always occupies SOME VRAM — a zero means the
    engine's own accounting is unreliable right now, and storing it anyway
    would poison a 'verified' badge with a number that measured nothing."""
    monkeypatch.setenv("OLLAMA_URL", "http://ollama.test")
    fake = FakeOllama(probe_model_name="qwen3:8b", ps_models=[{"name": "qwen3:8b", "size_vram": 0}])
    mount_backend("http://ollama.test", fake.app)
    await backends.save_config(pool, {"kind": "ollama"})

    resp = await client.post("/admin/probe", json={"model": "qwen3:8b"})

    body = resp.json()
    assert body["ok"] is True
    assert body["vram_mb"] is None


async def test_probe_against_a_remote_backend_never_reads_this_hosts_gpu(
    client, pool, mount_backend, monkeypatch
):
    """Only a local ollama backend consumes THIS host's GPU — a remote/cloud
    probe must never even attempt a footprint read."""
    calls: list[int] = []

    # S40: one /api/ps read yields both the VRAM figure and the D10 stamp's
    # size/size_vram, so the seam is `_footprint(app, engine_row, model)`.
    async def _spy(app, row, model):
        calls.append(1)
        return {"vram_mb": 1234, "size": None, "size_vram": None}

    monkeypatch.setattr(admin, "_footprint", _spy)
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


async def test_probe_against_a_remote_backend_has_no_vram_reading(client, pool, mount_backend):
    fake = FakeOpenAICompat()
    mount_backend("http://remote.test", fake.app)
    await backends.save_config(pool, {"kind": "remote", "url": "http://remote.test"})

    resp = await client.post("/admin/probe", json={"model": "some-model"})

    assert resp.status_code == 200
    body = resp.json()
    assert body["ok"] is True
    assert body["vram_mb"] is None


GIB = 1024**3
# A CPU the D10 grammar accepts, for the stamps that need one.
CPU = "cpu:amd-ryzen-9-5950x|32c|64g"


def _bundled(monkeypatch, accelerators, cpu):
    async def _devices():
        return accelerators, cpu

    monkeypatch.setattr(engines, "bundled_devices", _devices)


async def _hub_probe(client, pool, monkeypatch, mount_backend, ps_models):
    monkeypatch.setenv("OLLAMA_URL", "http://ollama.test")
    fake = FakeOllama(probe_model_name="qwen3:8b", ps_models=ps_models)
    mount_backend("http://ollama.test", fake.app)
    await backends.save_config(pool, {"kind": "ollama"})
    resp = await client.post("/admin/probe", json={"model": "hub:qwen3:8b"})
    assert resp.status_code == 200, resp.text
    return resp.json(), fake


async def test_a_probe_row_says_where_it_ran(client, pool, monkeypatch, mount_backend):
    """The DoD's own row (D10): provider hub, compute the card's CUDA uuid,
    runtime container, path internal. The 8B sits wholly on the card
    (size_vram == size), so the stamp is that one device and nothing else —
    and the probe's ledger row carries the same served_on."""
    _card(monkeypatch, 24576, IDLE_FREE_MB)
    full = [{"name": "qwen3:8b", "size": 9_970_000_000, "size_vram": 9_970_000_000}]

    body, _fake = await _hub_probe(client, pool, monkeypatch, mount_backend, full)

    assert body["ok"] is True
    expected = {
        "provider": "hub",
        "compute": f"gpu:cuda:{CARD_UUID}",
        "runtime": "container",
        "path": "internal",
    }
    assert {k: body[k] for k in expected} == expected
    stored = await pool.fetchrow(
        "SELECT provider, compute, runtime, path FROM probes WHERE id = $1", body["id"]
    )
    assert dict(stored) == expected
    ledger = await pool.fetchval("SELECT served_on FROM usage_events WHERE purpose = 'probe'")
    assert ledger == f"gpu:cuda:{CARD_UUID}"


async def test_a_probe_taken_now_is_what_fit_reads(client, pool, monkeypatch, mount_backend):
    _card(monkeypatch, 24576, IDLE_FREE_MB)
    full = [{"name": "qwen3:8b", "size": 9_970_000_000, "size_vram": 9_970_000_000}]
    await _hub_probe(client, pool, monkeypatch, mount_backend, full)

    fit = _fit_for((await client.get("/admin/suggest")).json(), "qwen3:8b")

    assert fit["source"] == "verified" and fit["needed_gb"] == 9.3


async def test_a_model_partly_in_system_memory_is_stamped_with_both_and_fit_skips_it(
    client, pool, monkeypatch, mount_backend
):
    """size_vram < size: part of the model runs on the CPU. The stamp names
    both devices, sorted (D10), and fit does not read it — its size_vram
    understates what the model needs on this card."""
    compute_id.parse(CPU)  # the fixture itself obeys the grammar
    _card(monkeypatch, 24576, IDLE_FREE_MB)
    _bundled(monkeypatch, [COMPUTE], CPU)
    partial = [{"name": "qwen3:8b", "size": 10 * GIB, "size_vram": 6 * GIB}]

    body, _fake = await _hub_probe(client, pool, monkeypatch, mount_backend, partial)

    assert body["compute"] == f"{CPU}+{COMPUTE}"
    assert body["vram_mb"] == 6 * 1024
    fit = _fit_for((await client.get("/admin/suggest")).json(), "qwen3:8b")
    assert fit["source"] == "estimated"


async def test_a_model_wholly_on_the_cpu_is_stamped_with_the_cpu(
    client, pool, monkeypatch, mount_backend
):
    _bundled(monkeypatch, [COMPUTE], CPU)
    cpu_only = [{"name": "qwen3:8b", "size": 5 * GIB, "size_vram": 0}]

    body, _fake = await _hub_probe(client, pool, monkeypatch, mount_backend, cpu_only)

    assert body["compute"] == CPU and body["vram_mb"] is None


async def test_a_model_not_resident_leaves_compute_unstated(
    client, pool, monkeypatch, mount_backend
):
    _bundled(monkeypatch, [COMPUTE], CPU)

    body, _fake = await _hub_probe(client, pool, monkeypatch, mount_backend, [])

    assert body["compute"] is None
    assert (body["provider"], body["runtime"], body["path"]) == ("hub", "container", "internal")


async def test_probing_the_hub_reads_its_own_ps_whatever_the_default(
    client, pool, monkeypatch, mount_backend
):
    """Before S40 the footprint was read at the DEFAULT backend's address, so
    with a cloud default a hub probe asked the cloud for /api/ps and stored no
    reading. A probe of hub:x is a question about the hub."""
    _card(monkeypatch, 24576, IDLE_FREE_MB)
    monkeypatch.setenv("OLLAMA_URL", "http://ollama.test")
    fake = FakeOllama(
        probe_model_name="qwen3:8b",
        ps_models=[{"name": "qwen3:8b", "size": 9_970_000_000, "size_vram": 9_970_000_000}],
    )
    mount_backend("http://ollama.test", fake.app)
    await backends.save_config(pool, {"kind": "remote", "url": "http://remote.test"})

    body = (await client.post("/admin/probe", json={"model": "hub:qwen3:8b"})).json()

    assert body["vram_mb"] == int(9_970_000_000 / (1024 * 1024))
    assert ("/api/ps", None) in fake.seen


async def test_a_cloud_probe_names_its_provider_and_nothing_it_cannot_know(
    client, pool, monkeypatch, mount_backend
):
    reads: list[int] = []

    async def _spy():
        reads.append(1)
        return [], None

    monkeypatch.setattr(engines, "bundled_devices", _spy)
    mount_backend("http://remote.test", FakeOpenAICompat().app)
    await backends.save_config(pool, {"kind": "remote", "url": "http://remote.test"})

    body = (await client.post("/admin/probe", json={"model": "some-model"})).json()

    assert (body["provider"], body["compute"], body["runtime"], body["path"]) == (
        "remote",
        None,
        None,
        None,
    )
    assert reads == [], "a cloud call ran on no device of this host"


async def test_a_probe_on_another_machine_never_reads_this_hubs_card(
    client, pool, monkeypatch, second_engine
):
    """dell's reading comes from dell's own /api/ps. Its compute and runtime
    come from its agent (S44): absent here, never the hub's card."""
    reads: list[int] = []

    async def _read():
        reads.append(1)
        return devices_vram.Vram(
            total_mb=24576.0,
            used_mb=0.0,
            free_mb=24576.0,
            uuid=CARD_UUID,
            uuids=(CARD_UUID,),
            cards=1,
        )

    monkeypatch.setattr(devices_vram, "read_vram", _read)
    second_engine.probe_model_name = "qwen3.8:27b"
    second_engine.ps_models = [{"name": "qwen3.8:27b", "size": 17 * GIB, "size_vram": 17 * GIB}]

    body = (await client.post("/admin/probe", json={"model": "dell:qwen3.8:27b"})).json()

    assert body["ok"] is True and body["vram_mb"] == 17 * 1024
    assert (body["provider"], body["compute"], body["runtime"], body["path"]) == (
        "dell",
        None,
        None,
        None,
    )
    assert reads == []
