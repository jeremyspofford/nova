"""app/engines.py and /admin/engines (S40): the bundled engine `hub`, observed.

An engine is a provider row with adapter=ollama plus its `engines` row. The
gateway STATES what an engine is doing — ready, unreachable, switched off,
unobserved — and decides nothing with it here. Every reading carries when it
was taken; a cached one carries its ORIGINAL time (app/cache.py's rail).

Every test fakes the card and the CPU (test_admin_suggest_fit's rule): a test
that passes because of the hardware under the desk measures nothing. The
`hub_machine` fixture (conftest) is the hub these tests describe."""

from __future__ import annotations

import dataclasses
import json
from pathlib import Path

import httpx
import pytest

from app import devices_vram, engines, fit, providers
from app.main import app as gateway_app
from tests.conftest import HUB_CPU as CPU
from tests.conftest import HUB_GPU as GPU
from tests.conftest import HUB_GPU_UUID as UUID
from tests.conftest import requires_db
from tests.fakes import FakeOllama

OLLAMA = "http://ollama.test"
OTHER_UUID = "GPU-0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d"
NO_GPU = "nvidia-smi could not be run — [Errno 2] No such file or directory"
CONTRACT = Path(__file__).resolve().parents[3] / "docs" / "contracts" / "engine_view.json"


class _Clock:
    def __init__(self) -> None:
        self.now = 1000.0

    def __call__(self) -> float:
        return self.now


@pytest.fixture
def clock(monkeypatch):
    fake = _Clock()
    monkeypatch.setattr(engines, "_clock", fake)
    return fake


@pytest.fixture
async def hub(pool, monkeypatch, mount_backend, hub_machine, clock):
    monkeypatch.setenv("OLLAMA_URL", OLLAMA)
    fake = FakeOllama(tags=("qwen3:8b", "nomic-embed-text:latest"))
    mount_backend(OLLAMA, fake.app)
    return fake


def _tag_reads(fake) -> int:
    return sum(1 for path, _ in fake.seen if path == "/api/tags")


def _ps_reads(fake) -> int:
    return sum(1 for path, _ in fake.seen if path == "/api/ps")


async def _observe(pool, name="hub", *, live=False) -> engines.EngineView:
    return await engines.observe(gateway_app, pool, await engines.get(pool, name), live=live)


async def _add_cloud(pool) -> None:
    await providers.insert_row(
        pool,
        "openrouter",
        {
            "adapter": "openai-chat",
            "base_url": "https://openrouter.test/v1",
            "auth_shape": "static-bearer",
            "api_key": "sk-1",
        },
    )


async def _add_dell(pool, *, lifecycle: str) -> None:
    """Another machine's engine. S40 creates none (they arrive with the
    agent, S44); the rows are written by hand so the vocabulary core reads is
    pinned now and never changes meaning later."""
    await pool.execute(
        "INSERT INTO providers (name, adapter, base_url, auth_shape, api_key, local) "
        "VALUES ('dell', 'ollama', 'http://dell.test', 'static-bearer', 'tok', true)"
    )
    await pool.execute(
        "INSERT INTO engines (provider, lifecycle, last_tags, last_tags_at) "
        "VALUES ('dell', $1, $2::jsonb, '2026-09-18T03:00:00+00')",
        lifecycle,
        json.dumps({"qwen3.8:27b": 17000000000}),
    )


async def _add_sleeping_dell(pool) -> None:
    await _add_dell(pool, lifecycle="wake_on_lan")


# ── pure: what a reading means ───────────────────────────────────────────

_ABSENT = devices_vram.Vram(reason=NO_GPU, absent=True).as_dict()
_ONE_CARD = devices_vram.parse(
    f"24576, 2662, 21914, 3, {UUID}, NVIDIA GeForce RTX 3090\n"
).as_dict()
_UNREADABLE = devices_vram.Vram(reason="nvidia-smi exited 9: Failed to initialize NVML").as_dict()


def test_compute_of_names_the_one_device_a_fully_resident_model_runs_on():
    """(ruling C4) No GPU passed through is the CPU; one nameable card is that
    card; anything else — two cards, a card nobody can name, a GPU that is
    there but unreadable — is None. A GPU that exists is never read as the CPU."""
    assert engines.compute_of(_ABSENT, [], CPU) == CPU
    assert engines.compute_of(_ABSENT, [], None) is None
    assert engines.compute_of(_ONE_CARD, [GPU], CPU) == GPU
    assert engines.compute_of(_ONE_CARD, [GPU, f"gpu:cuda:{OTHER_UUID}"], CPU) is None
    assert engines.compute_of(_ONE_CARD, [], CPU) is None
    assert engines.compute_of(_UNREADABLE, [], CPU) is None


def test_fit_frame_is_ram_only_when_no_gpu_was_passed_through():
    """(ruling C3) The hub's models are fitted in VRAM whenever a card is
    there — readable or not; RAM only when nvidia-smi is absent. Another
    machine's frame is never guessed from the hub: None."""
    hub_row = {"name": "hub", "builtin": True}
    dell_row = {"name": "dell", "builtin": False}
    assert engines.fit_frame(hub_row, _ONE_CARD) == "vram"
    assert engines.fit_frame(hub_row, _UNREADABLE) == "vram"
    assert engines.fit_frame(hub_row, _ABSENT) == "ram"
    assert engines.fit_frame(hub_row, None) is None
    assert engines.fit_frame(dell_row, _ONE_CARD) is None
    assert engines.fit_frame(dell_row, _ABSENT) is None


def test_switched_off_has_one_wording():
    """(ruling C10) routing's `switched_off` verdict reads this same sentence."""
    reason = engines.switched_off_reason("hub")
    assert reason.startswith("hub is switched off")


def test_the_engine_view_fields_are_the_contract():
    """docs/contracts/engine_view.json names the EngineView fields core reads
    (T5's engine_view, T7's as_row, the web Machine type): a field renamed
    here without the contract moving is a red test, not a silent None there."""
    contract = json.loads(CONTRACT.read_text())
    assert [f.name for f in dataclasses.fields(engines.EngineView)] == contract["fields"]
    assert set(contract["states"]) == set(engines.STATES)


def test_client_is_the_engines_own_address(monkeypatch):
    """(ruling G2) The one way to reach an engine's own API (/api/ps, pull,
    remove): the bundled engine at OLLAMA_URL, another machine at its row."""
    monkeypatch.setenv("OLLAMA_URL", "http://ollama.live:11434/")
    hub_row = {"name": "hub", "adapter": "ollama", "builtin": True, "base_url": ""}
    dell_row = {
        "name": "dell",
        "adapter": "ollama",
        "builtin": False,
        "base_url": "http://dell.test:11435/",
        "auth_shape": "static-bearer",
        "api_key": "tok",
    }
    assert str(engines.client(gateway_app, hub_row, engines.PS_TIMEOUT).base_url) == (
        "http://ollama.live:11434"
    )
    assert str(engines.client(gateway_app, dell_row, engines.PS_TIMEOUT).base_url) == (
        "http://dell.test:11435"
    )


async def test_bundled_devices_is_the_one_live_reader_of_the_hubs_devices(hub_machine):
    """(ruling C1) What the stamp and the probe name the hub's devices with,
    read NOW: never cached, so a card that changes is the next answer."""
    assert await engines.bundled_devices() == ([GPU], CPU)
    hub_machine["reading"] = devices_vram.Vram(reason=NO_GPU, absent=True)
    assert await engines.bundled_devices() == ([], CPU)
    (engines.PROC_DIR / "cpuinfo").write_text("processor\t: 0\n")
    assert await engines.bundled_devices() == ([], None)


async def test_the_suite_never_reads_the_hardware_under_the_desk():
    """(ruling E10) Without `hub_machine`, the hub's card and CPU are stated
    unknown: a test cannot pass because of this machine's GPU."""
    assert await engines.bundled_devices() == ([], None)
    assert (await devices_vram.read_vram()).reason == "the test suite reads no card"


# ── the rows ─────────────────────────────────────────────────────────────


@requires_db
async def test_the_bundled_engine_is_hub_and_only_engines_are_engines(pool):
    [row] = await engines.rows(pool)
    assert row["name"] == engines.BUILTIN == providers.BUILTIN == "hub"
    assert row["builtin"] is True and engines.is_engine(row)
    assert (row["lifecycle"], row["serving"], row["hold_s"]) == ("always_on", True, 600)
    await _add_cloud(pool)
    assert [r["name"] for r in await engines.rows(pool)] == ["hub"]
    assert not engines.is_engine(await providers.get_row(pool, "openrouter"))
    for name in ("openrouter", "nope"):
        with pytest.raises(engines.UnknownEngine):
            await engines.get(pool, name)


# ── observe ──────────────────────────────────────────────────────────────


@requires_db
async def test_a_ready_engine_states_its_models_and_what_it_runs_on(pool, hub):
    view = await _observe(pool)
    assert (view.state, view.reason, view.serving, view.lifecycle) == (
        "ready",
        None,
        True,
        "always_on",
    )
    assert set(view.tags) == {"qwen3:8b", "nomic-embed-text:latest"}
    assert all(isinstance(size, int) and size > 0 for size in view.tags.values())
    assert (view.compute, view.runtime) == (GPU, "container")
    assert view.runtime == engines.BUILTIN_RUNTIME
    assert view.facts["accelerators"] == [GPU] and view.facts["cpu"] == CPU
    assert view.facts["gpu"]["name"] == "NVIDIA GeForce RTX 3090"
    assert view.facts["unreadable"] == []
    assert view.observed_at and view.tags_as_of
    # (S40 fix wave A1) Stated, never left for a reader to infer from tags.
    assert (view.builtin, view.answered) == (True, True)
    stored = await pool.fetchrow(
        "SELECT last_ready_at, last_tags, last_tags_at, last_facts, last_facts_at "
        "FROM engines WHERE provider = 'hub'"
    )
    assert json.loads(stored["last_tags"]) == view.tags
    assert stored["last_ready_at"] == stored["last_tags_at"] == stored["last_facts_at"]
    assert json.loads(stored["last_facts"])["accelerators"] == [GPU]


@requires_db
async def test_a_failure_is_cached_ten_seconds_and_a_ready_reading_thirty(pool, hub, clock):
    """Before S40 a failed listing was never cached (routing.py:293-294 at
    0531b496), so every routed turn waited out the 10 s MODELS_TIMEOUT again."""
    hub.tags_status = 500
    first = await _observe(pool)
    assert first.state == "unreachable" and first.tags is None
    assert first.answered is False
    assert first.reason.startswith("hub could not be asked what is installed")
    hub.tags_status = 200
    clock.now = 1009.5
    again = await _observe(pool)
    assert again.state == "unreachable" and again.observed_at == first.observed_at
    assert _tag_reads(hub) == 1
    clock.now = 1010.0
    ready = await _observe(pool)
    assert ready.state == "ready" and _tag_reads(hub) == 2
    clock.now = 1039.5
    assert (await _observe(pool)).observed_at == ready.observed_at
    assert _tag_reads(hub) == 2
    clock.now = 1040.0
    await _observe(pool)
    assert _tag_reads(hub) == 3
    await _observe(pool, live=True)
    assert _tag_reads(hub) == 4


@requires_db
async def test_a_failed_reading_never_overwrites_the_last_good_one(pool, hub, clock):
    await _observe(pool)
    sql = "SELECT last_ready_at, last_tags FROM engines WHERE provider = 'hub'"
    good = tuple(await pool.fetchrow(sql))
    hub.tags_status = 500
    clock.now += engines.READY_TTL_S
    assert (await _observe(pool)).state == "unreachable"
    assert tuple(await pool.fetchrow(sql)) == good


@requires_db
async def test_switched_off_is_the_owners_word_and_takes_effect_at_once(pool, hub):
    await _observe(pool)
    stored = await engines.set_serving(pool, "hub", False)
    assert stored["serving"] is False
    assert await pool.fetchval("SELECT serving FROM engines WHERE provider = 'hub'") is False
    off = await _observe(pool)
    assert off.state == "switched_off" and off.reason == engines.switched_off_reason("hub")
    assert set(off.tags) == {"qwen3:8b", "nomic-embed-text:latest"}  # installed ≠ used
    assert off.answered is True, "the switch is the owner's word; the engine still answered"
    await engines.set_serving(pool, "hub", True)
    assert (await _observe(pool)).state == "ready"
    assert _tag_reads(hub) == 1, "the switch is read from the row, never waits out a cache"


@requires_db
async def test_a_switched_off_engine_that_cannot_be_asked_says_both(pool, hub):
    hub.tags_status = 500
    await engines.set_serving(pool, "hub", False)
    view = await _observe(pool)
    assert view.state == "switched_off"
    assert view.reason.startswith(engines.switched_off_reason("hub"))
    assert "could not be asked what is installed" in view.reason
    # (S40 fix wave A1) The state is the switch's; whether it answered is its
    # own fact — the embedder can be down while the switch reads off, and a
    # check that reads only `state` would call that no outage.
    assert (view.builtin, view.answered) == (True, False)


@requires_db
async def test_set_serving_refuses_what_is_not_an_engine_or_not_a_bool(pool):
    with pytest.raises(engines.UnknownEngine):
        await engines.set_serving(pool, "nope", False)
    with pytest.raises(ValueError):
        await engines.set_serving(pool, "hub", "no")
    assert await pool.fetchval("SELECT serving FROM engines WHERE provider = 'hub'") is True


@requires_db
async def test_compute_is_derived_from_this_reading_never_from_the_row(pool, hub):
    """A database restored onto another machine carries the old machine's
    facts; the compute a number is stamped with must not."""
    stale = "gpu:cuda:GPU-00000000-0000-4000-8000-000000000000"
    await pool.execute(
        "UPDATE engines SET last_facts = $1::jsonb, last_facts_at = now() WHERE provider = 'hub'",
        json.dumps({"accelerators": [stale]}),
    )
    view = await _observe(pool, live=True)
    assert view.compute == GPU and view.facts["accelerators"] == [GPU]


@requires_db
async def test_no_gpu_passed_through_means_the_engine_runs_on_its_cpu(pool, hub, hub_machine):
    hub_machine["reading"] = devices_vram.Vram(reason=NO_GPU, absent=True)
    view = await _observe(pool, live=True)
    assert view.compute == CPU
    assert view.facts["gpu"] is None and view.facts["accelerators"] == []
    assert view.facts["unreadable"] == []  # no GPU is a fact, not a failed reading


@requires_db
async def test_a_gpu_it_cannot_read_or_single_out_is_omitted_never_guessed(pool, hub, hub_machine):
    hub_machine["reading"] = devices_vram.Vram(
        reason="nvidia-smi exited 9: Failed to initialize NVML"
    )
    broken = await _observe(pool, live=True)
    assert broken.compute is None
    assert [u["item"] for u in broken.facts["unreadable"]] == ["gpu"]
    assert "NVML" in broken.facts["unreadable"][0]["reason"]
    hub_machine["reading"] = devices_vram.parse(
        f"24576, 2662, 21914, 3, {UUID}, NVIDIA GeForce RTX 3090\n"
        f"8192, 100, 8092, 0, {OTHER_UUID}, NVIDIA GeForce RTX 3060 Ti\n"
    )
    two = await _observe(pool, live=True)
    assert two.compute is None and len(two.facts["accelerators"]) == 2
    hub_machine["reading"] = devices_vram.parse("24576, 2662, 21914, 3\n")
    nameless = await _observe(pool, live=True)
    assert nameless.compute is None
    assert [u["item"] for u in nameless.facts["unreadable"]] == ["gpu_identity"]


@requires_db
async def test_a_cpu_it_cannot_name_is_omitted_and_says_why(pool, hub):
    (engines.PROC_DIR / "cpuinfo").write_text("processor\t: 0\n")
    view = await _observe(pool, live=True)
    assert view.facts["cpu"] is None and view.compute == GPU
    assert [u["item"] for u in view.facts["unreadable"]] == ["cpu"]


@requires_db
async def test_installed_sizes_is_the_cached_listing_and_none_when_it_cannot_ask(pool, hub):
    sizes = await engines.installed_sizes(gateway_app, pool, "hub")
    assert set(sizes) == {"qwen3:8b", "nomic-embed-text:latest"}
    assert await engines.installed_sizes(gateway_app, pool, "hub") == sizes
    assert _tag_reads(hub) == 1
    engines.clear_cache()
    hub.tags_status = 500
    assert await engines.installed_sizes(gateway_app, pool, "hub") is None


@requires_db
async def test_forget_drops_one_engines_reading_and_keeps_the_others(pool, hub, mount_backend):
    """(ruling C11) After a connect-phase failure the data plane forgets THAT
    engine, so its next observe asks again — the others keep their readings."""
    dell = FakeOllama(tags=("qwen3.8:27b",))
    mount_backend("http://dell.test", dell.app)
    await _add_dell(pool, lifecycle="always_on")
    await _observe(pool, "hub")
    await _observe(pool, "dell")
    engines.forget("hub")
    await _observe(pool, "hub")
    await _observe(pool, "dell")
    assert (_tag_reads(hub), _tag_reads(dell)) == (2, 1)
    engines.forget("never-was")  # forgetting nothing is not an error


@requires_db
async def test_a_wake_on_lan_engine_is_never_asked_unless_live(pool, hub, mount_backend):
    """S40 creates no such engine (they arrive with the agent); the state is
    pinned now so the vocabulary core reads never changes meaning later."""
    dell = FakeOllama(tags=("qwen3.8:27b",))
    mount_backend("http://dell.test", dell.app)
    await _add_sleeping_dell(pool)
    assert [r["name"] for r in await engines.rows(pool)] == ["hub", "dell"]
    view = await _observe(pool, "dell")
    assert (view.state, view.observed_at, view.compute, view.runtime) == (
        "unobserved",
        None,
        None,
        None,
    )
    assert view.tags == {"qwen3.8:27b": 17000000000}
    assert view.tags_as_of.startswith("2026-09-18T03:00:00")
    # Not asked is neither answering nor silent: null, never a stored list
    # read as a fresh answer (S40 fix wave A1).
    assert (view.builtin, view.answered) == (False, None)
    assert dell.seen == []
    live = await _observe(pool, "dell", live=True)
    assert live.state == "ready" and [path for path, _ in dell.seen] == ["/api/tags"]
    assert (live.builtin, live.answered) == (False, True)


# ── resident: one /api/ps reader (ruling C2) ─────────────────────────────


@requires_db
async def test_resident_is_the_engines_own_ps_in_ollamas_own_keys(pool, hub):
    hub.ps_models = [
        {"name": "qwen3:8b", "size": 6_000_000_000, "size_vram": 5_000_000_000},
        {"name": "no-vram-stated", "size": 1_000},
    ]
    row = await engines.get(pool, "hub")
    resident, reason = await engines.resident(gateway_app, row)
    assert reason is None
    assert resident == [
        {
            "model": "qwen3:8b",
            "vram_mb": 5_000_000_000 / (1024 * 1024),
            "size": 6_000_000_000,
            "size_vram": 5_000_000_000,
        }
    ]


@requires_db
async def test_a_resident_entry_whose_vram_is_not_a_byte_count_is_skipped_never_a_crash(pool, hub):
    """S40 T3: the served-on stamp reads /api/ps after every local reply, so
    an entry that states size_vram as something other than a byte count (a
    string, a bool, a negative) must not take the reply down with a
    TypeError — it is skipped like an entry that states none. Nothing is
    filled in."""
    hub.ps_models = [
        {"name": "as-text", "size": 1_000, "size_vram": "6400000000"},
        {"name": "as-bool", "size": 1_000, "size_vram": True},
        {"name": "negative", "size": 1_000, "size_vram": -1},
        {"name": "qwen3:8b", "size": 6_000_000_000, "size_vram": 0},
    ]
    row = await engines.get(pool, "hub")
    resident, reason = await engines.resident(gateway_app, row)
    assert reason is None
    assert resident == [
        {"model": "qwen3:8b", "vram_mb": 0.0, "size": 6_000_000_000, "size_vram": 0}
    ]


@requires_db
async def test_resident_takes_the_callers_timeout(pool, hub, monkeypatch):
    """The stamp reads /api/ps after every local reply, on a 2 s budget."""
    seen = []
    real = engines.client

    def _spy(app, row, timeout):
        seen.append(timeout)
        return real(app, row, timeout)

    monkeypatch.setattr(engines, "client", _spy)
    row = await engines.get(pool, "hub")
    await engines.resident(gateway_app, row)
    await engines.resident(gateway_app, row, timeout=httpx.Timeout(2.0))
    assert seen == [engines.PS_TIMEOUT, httpx.Timeout(2.0)]


@requires_db
async def test_resident_that_cannot_be_read_says_why_and_is_never_empty(
    pool, hub, monkeypatch, mount_backend
):
    row = await engines.get(pool, "hub")
    monkeypatch.setenv("OLLAMA_URL", "")
    assert await engines.resident(gateway_app, row) == (
        None,
        "OLLAMA_URL is unset — cannot read what is resident on hub",
    )
    monkeypatch.setenv("OLLAMA_URL", "http://127.0.0.1:1")
    resident, reason = await engines.resident(gateway_app, row)
    assert resident is None and reason.startswith("could not reach hub's /api/ps")

    from starlette.applications import Starlette
    from starlette.responses import PlainTextResponse
    from starlette.routing import Route

    async def _html(request):
        return PlainTextResponse("<html>proxy error</html>")

    mount_backend("http://garbled.test", Starlette(routes=[Route("/api/ps", _html)]))
    monkeypatch.setenv("OLLAMA_URL", "http://garbled.test")
    resident, reason = await engines.resident(gateway_app, row)
    assert resident is None and "hub's /api/ps answered with something" in reason


# ── /admin/engines ───────────────────────────────────────────────────────


@requires_db
async def test_get_admin_engines_lists_every_engine_as_its_view(client, hub):
    resp = await client.get("/admin/engines")
    assert resp.status_code == 200
    [view] = resp.json()["engines"]
    assert set(view) == {field.name for field in dataclasses.fields(engines.EngineView)}
    assert (view["name"], view["state"], view["compute"], view["runtime"]) == (
        "hub",
        "ready",
        GPU,
        "container",
    )


@requires_db
async def test_live_1_asks_again_and_live_0_answers_from_the_cache(client, hub, clock):
    await client.get("/admin/engines")
    await client.get("/admin/engines?live=0")
    assert _tag_reads(hub) == 1
    await client.get("/admin/engines?live=1")
    assert _tag_reads(hub) == 2


@requires_db
async def test_one_engine_carries_its_card_in_admin_vrams_own_keys(client, hub, hub_machine):
    hub.ps_models = [{"name": "qwen3:8b", "size": 6_000_000_000, "size_vram": 5_000_000_000}]
    body = (await client.get("/admin/engines/hub")).json()
    assert (body["name"], body["state"], body["fit_frame"]) == ("hub", "ready", "vram")
    vram = body["vram"]
    # The keys the deleted /admin/vram answered: core's readers move by path (T5).
    for key in (
        "total_mb",
        "used_mb",
        "free_mb",
        "util_pct",
        "reason",
        "total_gb",
        "free_gb",
        "used_gb",
        "resident",
        "resident_reason",
        "free_after_switch_gb",
    ):
        assert key in vram, key
    assert (vram["total_mb"], vram["uuid"], vram["cards"]) == (24576, UUID, 1)
    assert vram["resident"] == [
        {
            "model": "qwen3:8b",
            "vram_mb": 5_000_000_000 / (1024 * 1024),
            "size": 6_000_000_000,
            "size_vram": 5_000_000_000,
        }
    ]
    assert vram["free_after_switch_gb"] == round(
        fit.free_gb_after_switch(21914, vram["resident"]), 1
    )
    # A card that is there but cannot be read is still a card (E3): the VRAM
    # frame, with the card's own reason. Only an absent nvidia-smi is RAM.
    hub_machine["reading"] = devices_vram.Vram(reason="nvidia-smi exited 9: NVML")
    unread = (await client.get("/admin/engines/hub")).json()
    assert unread["fit_frame"] == "vram" and "NVML" in unread["vram"]["reason"]
    assert unread["vram"]["free_after_switch_gb"] is None
    hub_machine["reading"] = devices_vram.Vram(reason=NO_GPU, absent=True)
    assert (await client.get("/admin/engines/hub")).json()["fit_frame"] == "ram"


@requires_db
async def test_another_machines_card_is_never_read_from_the_hub(client, pool, hub, mount_backend):
    """(ruling C3) Its card is on another machine: stated unreadable here, its
    fit frame not guessed. What it holds resident is its OWN /api/ps — read
    only when it may be asked: a wake-on-LAN engine nobody asked for live is
    left asleep, the same rule observe keeps."""
    dell = FakeOllama(tags=("qwen3.8:27b",))
    dell.ps_models = [{"name": "qwen3.8:27b", "size": 17_000_000_000, "size_vram": 17_000_000_000}]
    mount_backend("http://dell.test", dell.app)
    await _add_sleeping_dell(pool)

    body = (await client.get("/admin/engines/dell")).json()
    assert body["state"] == "unobserved" and body["fit_frame"] is None
    assert body["vram"]["total_mb"] is None and body["vram"]["uuid"] is None
    assert body["vram"]["reason"] == engines.NOT_THIS_CARD.format(name="dell")
    assert "dell's card cannot be read from this hub" in body["vram"]["reason"]
    assert body["vram"]["resident"] is None and "wakes on LAN" in body["vram"]["resident_reason"]
    assert dell.seen == [], "a sleeping machine was asked"

    live = (await client.get("/admin/engines/dell?live=1")).json()
    assert live["state"] == "ready" and live["fit_frame"] is None
    assert live["vram"]["total_mb"] is None
    assert live["vram"]["resident"] == [
        {
            "model": "qwen3.8:27b",
            "vram_mb": 17_000_000_000 / (1024 * 1024),
            "size": 17_000_000_000,
            "size_vram": 17_000_000_000,
        }
    ]
    assert live["vram"]["free_after_switch_gb"] is None
    assert _ps_reads(hub) == 0, "the hub's /api/ps was read for another machine"


@requires_db
async def test_put_switches_serving_and_answers_with_the_row_read_back(client, pool, hub):
    resp = await client.put("/admin/engines/hub", json={"serving": False})
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert (body["name"], body["serving"], body["builtin"], body["lifecycle"]) == (
        "hub",
        False,
        True,
        "always_on",
    )
    assert "api_key" not in body and "base_url" not in body
    assert await pool.fetchval("SELECT serving FROM engines WHERE provider = 'hub'") is False
    [view] = (await client.get("/admin/engines")).json()["engines"]
    assert view["state"] == "switched_off"
    assert (await client.put("/admin/engines/hub", json={"serving": True})).json()["serving"]


@requires_db
@pytest.mark.parametrize(
    ("body", "words"),
    [
        ({}, "serving"),
        ({"serving": "no"}, "true or false"),
        ({"serving": None}, "true or false"),
        ({"serving": False, "lifecycle": "wake_on_lan"}, "cannot set lifecycle"),
        ([False], "serving"),
    ],
)
async def test_put_refuses_what_it_cannot_set_and_writes_nothing(client, pool, hub, body, words):
    resp = await client.put("/admin/engines/hub", json=body)
    assert resp.status_code == 400 and words in resp.json()["error"]
    assert await pool.fetchval("SELECT serving FROM engines WHERE provider = 'hub'") is True


@requires_db
async def test_put_refuses_a_body_that_is_not_json(client, pool, hub):
    resp = await client.put(
        "/admin/engines/hub", content=b"serving=false", headers={"content-type": "text/plain"}
    )
    assert resp.status_code == 400 and "not valid JSON" in resp.json()["error"]


@requires_db
async def test_a_name_that_is_not_an_engine_is_a_404(client, pool, hub):
    await _add_cloud(pool)
    for name in ("nope", "openrouter"):
        assert (await client.get(f"/admin/engines/{name}")).status_code == 404
        put = await client.put(f"/admin/engines/{name}", json={"serving": False})
        assert put.status_code == 404 and put.json()["error"] == f"no engine named {name!r}"
