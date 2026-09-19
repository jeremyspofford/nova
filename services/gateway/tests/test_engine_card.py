"""GET /admin/engines/{name}'s card: what GET /admin/vram answered, per engine.

S40 deleted /admin/vram. It answered about ONE thing — "the active backend",
the default provider — so the moment the default was a cloud provider its
resident table read "the active backend is remote, not local ollama" while the
bundled engine sat holding 17 GB. The card belongs to the machine, not to
whichever provider is the default. The block keeps every key core read off
/admin/vram, so its readers (inference_health, the inference_degraded check,
the resources panel) move by path alone. The card itself is T2's
engines_api._vram (S40 ruling C3); these are /admin/vram's own cases, moved
onto the route that replaced it.
"""

from __future__ import annotations

from app import backends, devices_vram
from tests.conftest import requires_db
from tests.fakes import FakeOllama
from tests.test_admin_suggest_fit import CARD_UUID, IDLE_FREE_MB, _card

pytestmark = requires_db

GIB = 1024**3
VRAM_KEYS = {
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
}


async def test_the_deleted_route_is_gone(client):
    assert (await client.get("/admin/vram")).status_code == 404


async def test_the_hub_card_is_read_whatever_the_default_provider_is(
    client, pool, monkeypatch, mount_backend
):
    _card(monkeypatch, 24576, IDLE_FREE_MB - 17.4 * 1024)
    monkeypatch.setenv("OLLAMA_URL", "http://ollama.test")
    held = int(17.4 * GIB)
    fake = FakeOllama(ps_models=[{"name": "qwen3.8:27b", "size": held, "size_vram": held}])
    mount_backend("http://ollama.test", fake.app)
    await backends.save_config(pool, {"kind": "remote", "url": "http://remote.test"})

    resp = await client.get("/admin/engines/hub")

    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["fit_frame"] == "vram"
    card = body["vram"]
    assert VRAM_KEYS <= set(card)
    assert card["uuid"] == CARD_UUID
    assert card["total_gb"] == 24.0 and card["reason"] is None
    assert [e["model"] for e in card["resident"]] == ["qwen3.8:27b"]
    assert card["resident_reason"] is None
    assert card["free_after_switch_gb"] == 21.4


async def test_an_absent_card_keeps_its_words_and_the_resident_table_still_reads(
    client, pool, monkeypatch, mount_backend
):
    """No nvidia-smi in the container at all (ruling E3: `absent`, what
    read_vram returns for FileNotFoundError) — the RAM frame, the card's own
    words, and what the engine holds still read."""

    async def _read():
        return devices_vram.Vram(
            reason="nvidia-smi could not be run — [Errno 2] No such file or directory",
            absent=True,
        )

    monkeypatch.setattr(devices_vram, "read_vram", _read)
    monkeypatch.setenv("OLLAMA_URL", "http://ollama.test")
    mount_backend("http://ollama.test", FakeOllama(ps_models=[]).app)

    body = (await client.get("/admin/engines/hub")).json()

    assert body["fit_frame"] == "ram"
    assert body["vram"]["total_mb"] is None
    assert "nvidia-smi could not be run" in body["vram"]["reason"]
    assert body["vram"]["resident"] == [] and body["vram"]["free_after_switch_gb"] is None


async def test_an_unreachable_engine_says_so_and_the_card_still_answers(client, pool, monkeypatch):
    _card(monkeypatch, 24576, IDLE_FREE_MB)
    monkeypatch.setenv("OLLAMA_URL", "http://127.0.0.1:1")

    card = (await client.get("/admin/engines/hub")).json()["vram"]

    assert card["total_gb"] == 24.0
    assert card["resident"] is None and card["free_after_switch_gb"] is None
    assert "could not reach hub's /api/ps" in card["resident_reason"]


async def test_another_machines_card_is_never_this_hubs(client, pool, monkeypatch, second_engine):
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
    second_engine.ps_models = [{"name": "qwen3.8:27b", "size": 10 * GIB, "size_vram": 10 * GIB}]

    body = (await client.get("/admin/engines/dell")).json()

    assert reads == [], "the hub's nvidia-smi describes the hub, never dell"
    assert body["fit_frame"] is None
    assert body["vram"]["total_mb"] is None
    assert "dell's card cannot be read from this hub" in body["vram"]["reason"]
    assert [e["model"] for e in body["vram"]["resident"]] == ["qwen3.8:27b"]
