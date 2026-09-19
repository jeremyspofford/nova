"""S40 / D10: a completion an engine answered says WHERE it ran.

`X-Nova-Served-On` is the compute id (the grammar in
docs/contracts/compute_id_vectors.json) read for THIS request: ollama's own
/api/ps `size`/`size_vram` for the model that just answered (engines.resident,
the one /api/ps reader), against the hub's devices as its cached observation
states them (engines.observe(..., live=False): no nvidia-smi per reply).
`X-Nova-Served-Runtime` is how the engine runs. The ledger row keeps
`served_on`. Anything not known is omitted — never guessed, never the last
value seen.

The hub's devices come from the E10 seam (`hub_machine`): a test swaps the
card by assigning a reading, then forgets the cached observation.
"""

from __future__ import annotations

import pytest

from app import backends, devices_vram, engines
from tests.conftest import HUB_CPU, HUB_GPU, HUB_GPU_UUID, requires_db
from tests.fakes import FakeOllama, FakeOpenAICompat

pytestmark = requires_db

OTHER_UUID = "GPU-00000000-1111-2222-3333-444444444444"
CHAT = {"messages": [{"role": "user", "content": "hi"}], "stream": True}

ONE_CARD = devices_vram.parse(f"24576, 1024, 23552, 3, {HUB_GPU_UUID}, NVIDIA GeForce RTX 3090\n")
TWO_CARDS = devices_vram.parse(
    f"24576, 1024, 23552, 3, {HUB_GPU_UUID}, NVIDIA GeForce RTX 3090\n"
    f"12288, 512, 11776, 0, {OTHER_UUID}, NVIDIA GeForce RTX 3060\n"
)
# nvidia-smi is there but gave no reading: a GPU that cannot be named.
NO_READING = devices_vram.Vram(reason="nvidia-smi failed: the test says so")


def _card(hub_machine, reading: devices_vram.Vram) -> None:
    """The hub's card is now `reading`; the cached observation is forgotten,
    so the next stamp reads it (a real card changes only across restarts —
    the 30 s cache is what a reply reads)."""
    hub_machine["reading"] = reading
    engines.clear_cache()


def _resident(size: int, size_vram: int) -> list[dict]:
    return [{"name": "qwen3:8b", "model": "qwen3:8b", "size": size, "size_vram": size_vram}]


@pytest.fixture
async def hub(pool, monkeypatch, mount_backend, hub_machine):
    monkeypatch.setenv("OLLAMA_URL", "http://ollama.test")
    fake = FakeOllama(ps_models=_resident(6_400_000_000, 6_400_000_000))
    mount_backend("http://ollama.test", fake.app)
    await backends.save_config(pool, {"kind": "ollama", "model": "qwen3:8b"})
    _card(hub_machine, ONE_CARD)
    return fake


async def test_an_engine_completion_says_where_it_ran_and_the_ledger_keeps_it(client, pool, hub):
    resp = await client.post("/v1/chat/completions", json=CHAT, headers={"X-Nova-Purpose": "chat"})

    assert resp.status_code == 200
    assert resp.headers["x-nova-served-by"] == "hub:qwen3:8b"
    assert resp.headers["x-nova-served-on"] == HUB_GPU
    assert resp.headers["x-nova-served-runtime"] == "container"
    (row,) = await pool.fetch("SELECT served_on FROM usage_events WHERE kind = 'completion'")
    assert row["served_on"] == HUB_GPU
    paths = [path for path, _ in hub.seen]
    assert paths.index("/api/ps") > paths.index("/v1/chat/completions"), (
        "read after the engine answered — the model is resident by then"
    )


async def test_the_stamp_follows_size_vram_the_vendor_neutral_truth_about_offload(
    client, pool, hub
):
    cases = [
        (6_400_000_000, 6_400_000_000, HUB_GPU),  # all of it on the card
        (9_000_000_000, 6_000_000_000, "+".join(sorted([HUB_CPU, HUB_GPU]))),  # part on the CPU
        (6_400_000_000, 0, HUB_CPU),  # the card never held it
    ]
    for size, size_vram, expected in cases:
        hub.ps_models = _resident(size, size_vram)
        resp = await client.post("/v1/chat/completions", json=CHAT)
        assert resp.status_code == 200
        assert resp.headers["x-nova-served-on"] == expected, (size, size_vram)
    rows = await pool.fetch(
        "SELECT served_on FROM usage_events WHERE kind = 'completion' ORDER BY id"
    )
    assert [r["served_on"] for r in rows] == [expected for _, _, expected in cases]


async def test_a_resident_entry_under_its_latest_name_is_the_model_that_answered(client, pool, hub):
    """ollama lists a bare pull as `name:latest`; the request named it bare."""
    await backends.save_config(pool, {"kind": "ollama", "model": "gemma3"})
    hub.ps_models = [{"name": "gemma3:latest", "size": 3_000_000_000, "size_vram": 0}]
    resp = await client.post("/v1/chat/completions", json=CHAT)
    assert resp.status_code == 200
    assert resp.headers["x-nova-served-on"] == HUB_CPU


async def test_what_is_not_known_is_omitted_never_guessed(client, pool, hub, hub_machine):
    hub.ps_models = []  # /api/ps does not list the model that answered
    resp = await client.post("/v1/chat/completions", json=CHAT)
    assert resp.status_code == 200
    assert "x-nova-served-on" not in resp.headers
    assert resp.headers["x-nova-served-runtime"] == "container"

    # On a card, but this host reads two: which one is not known.
    _card(hub_machine, TWO_CARDS)
    hub.ps_models = _resident(6_400_000_000, 6_400_000_000)
    resp = await client.post("/v1/chat/completions", json=CHAT)
    assert "x-nova-served-on" not in resp.headers

    # On a card, and no card could be read here at all.
    _card(hub_machine, NO_READING)
    resp = await client.post("/v1/chat/completions", json=CHAT)
    assert "x-nova-served-on" not in resp.headers

    # /api/ps states no byte counts for it (or not numbers): nothing filled in.
    _card(hub_machine, ONE_CARD)
    hub.ps_models = [{"name": "qwen3:8b", "size": True, "size_vram": "6400000000"}]
    resp = await client.post("/v1/chat/completions", json=CHAT)
    assert "x-nova-served-on" not in resp.headers

    # /api/ps cannot be read at all: the reply is still served, unstamped.
    hub.ps_models = _resident(6_400_000_000, 6_400_000_000)
    hub.ps_status = 500
    resp = await client.post("/v1/chat/completions", json=CHAT)
    assert resp.status_code == 200
    assert "x-nova-served-on" not in resp.headers

    rows = await pool.fetch("SELECT served_on FROM usage_events WHERE kind = 'completion'")
    assert [r["served_on"] for r in rows] == [None] * 5


async def test_a_refusal_ran_nowhere_and_a_cloud_reply_names_no_hardware(
    client, pool, hub, mount_backend
):
    hub.probe_status = 503
    resp = await client.post("/v1/chat/completions", json={"messages": [], "stream": False})
    assert resp.status_code == 503
    assert "x-nova-served-on" not in resp.headers
    assert "/api/ps" not in [path for path, _ in hub.seen]

    mount_backend("http://cloud.test", FakeOpenAICompat().app)
    await backends.save_config(
        pool, {"kind": "cloud", "url": "http://cloud.test", "api_key": "sk-x", "model": "m"}
    )
    resp = await client.post("/v1/chat/completions", json=CHAT)
    assert resp.status_code == 200
    assert "x-nova-served-on" not in resp.headers
    assert "x-nova-served-runtime" not in resp.headers
    (row,) = await pool.fetch("SELECT served_on FROM usage_events WHERE kind = 'completion'")
    assert row["served_on"] is None


async def test_another_machines_engine_is_never_stamped_with_the_hubs_devices(
    client, pool, hub, mount_backend
):
    """Only the hub's own card and CPU are readable here. A reply another
    machine's engine answered is not stamped from them — even when that
    engine's /api/ps says the model sits wholly in VRAM and the hub has
    exactly one card: which card ran it is that machine's agent's to report
    (S44), never this host's guess."""
    dell = FakeOllama(ps_models=_resident(6_400_000_000, 6_400_000_000))
    mount_backend("http://dell.test", dell.app)
    await pool.execute(
        "INSERT INTO providers (name, adapter, base_url, auth_shape, api_key, local) "
        "VALUES ('dell', 'ollama', 'http://dell.test', 'static-bearer', 'tok', true)"
    )
    await pool.execute("INSERT INTO engines (provider) VALUES ('dell')")

    resp = await client.post("/v1/chat/completions", json={**CHAT, "model": "dell:qwen3:8b"})

    assert resp.status_code == 200
    assert resp.headers["x-nova-served-by"] == "dell:qwen3:8b"
    assert [p for p, _ in dell.seen if p == "/v1/chat/completions"], "dell answered"
    assert "x-nova-served-on" not in resp.headers
    assert "x-nova-served-runtime" not in resp.headers
    (row,) = await pool.fetch("SELECT served_on FROM usage_events WHERE kind = 'completion'")
    assert row["served_on"] is None


async def test_a_stored_device_list_is_never_read_as_this_hosts(client, pool, hub):
    """An engine nobody observed (it wakes on LAN, so nothing asks it) states
    only what it last STORED — and a stored device list is never stamped: a
    database restored onto another machine would carry a card that machine
    does not have. The hub's own card is known and one; the stamp is still
    omitted, never taken from the row."""
    await pool.execute(
        "UPDATE engines SET lifecycle = 'wake_on_lan', last_facts = $1::jsonb, "
        "last_facts_at = now(), last_tags = '{\"qwen3:8b\": 1}'::jsonb, last_tags_at = now() "
        "WHERE provider = 'hub'",
        '{"accelerators": ["gpu:cuda:GPU-99999999-9999-9999-9999-999999999999"], "cpu": null}',
    )
    engines.clear_cache()

    resp = await client.post("/v1/chat/completions", json=CHAT)

    assert resp.status_code == 200
    assert "x-nova-served-on" not in resp.headers
    (row,) = await pool.fetch("SELECT served_on FROM usage_events WHERE kind = 'completion'")
    assert row["served_on"] is None
