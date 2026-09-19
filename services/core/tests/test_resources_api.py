"""GET /api/v1/system/resources (S40): the card is the machine's own reading,
the throughput is the chat model's speed WHERE it last ran."""

from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta

from tests import fakes
from tests.conftest import requires_db
from tests.fakes import FakeGateway

pytestmark = requires_db

CARD = {
    "total_mb": 24576.0,
    "used_mb": 2662.0,
    "free_mb": 21914.0,
    "util_pct": 7.0,
    "reason": None,
    "total_gb": 24.0,
    "used_gb": 2.6,
    "free_gb": 21.4,
    "resident": [{"model": "qwen3.8:27b", "vram_mb": 1024.0}],
    "resident_reason": None,
    "free_after_switch_gb": 22.4,
}


async def _round(pool, *, rate: float, hours_ago: float, served_on=fakes.ENGINE_GPU) -> None:
    turn_id = uuid.uuid4()
    when = datetime.now(UTC) - timedelta(hours=hours_ago)
    await pool.execute(
        "INSERT INTO turns (id, started_at, status, kind) VALUES ($1, $2, 'ok', 'chat')",
        turn_id,
        when,
    )
    meta: dict = {
        "model": "hub:qwen3.8:27b",
        "served_by": "hub:qwen3.8:27b",
        "served_runtime": "container",
        "tok_per_s": rate,
    }
    if served_on is not None:
        meta["served_on"] = served_on
    await pool.execute(
        "INSERT INTO turn_spans (turn_id, kind, name, started_at, duration_ms, meta) "
        "VALUES ($1, 'llm_call', 'hub:qwen3.8:27b', $2, 1000, $3)",
        turn_id,
        when,
        meta,
    )


async def _chat_model(owner_client) -> None:
    resp = await owner_client.put(
        "/api/v1/settings", json={"key": "chat.model", "value": "hub:qwen3.8:27b"}
    )
    assert resp.status_code == 200


async def test_the_card_is_the_machines_and_the_speed_is_where_the_model_ran(
    owner_client, mount_peers, pool
):
    mount_peers(
        gateway=FakeGateway(
            engines=[fakes.engine_view()],
            engine_details={"hub": {"vram": CARD, "fit_frame": "vram"}},
        )
    )
    await _chat_model(owner_client)
    for _ in range(10):
        await _round(pool, rate=67.5, hours_ago=48)
    for _ in range(3):
        await _round(pool, rate=60.0, hours_ago=0.5)

    body = (await owner_client.get("/api/v1/system/resources")).json()

    assert body["card"] == {
        "machine": "hub",
        "free_gb": 21.4,
        "total_gb": 24.0,
        "used_gb": 2.6,
        "utilisation_pct": 7.0,
        "non_ollama_gb": 1.6,
        "resident": [{"model": "qwen3.8:27b", "vram_gb": 1.0}],
        "reason": None,
    }
    assert body["throughput"] == {
        "model": "qwen3.8:27b",
        "served_on": fakes.ENGINE_GPU,
        "runtime": "container",
        "recent_tok_per_s": 60.0,
        "recent_rounds": 3,
        "baseline_tok_per_s": 67.5,
        "baseline_rounds": 13,
        "ratio": 1.1,
    }


async def test_a_gateway_that_names_no_engines_is_a_stated_blank(owner_client, mount_peers):
    mount_peers(gateway=FakeGateway())
    body = (await owner_client.get("/api/v1/system/resources")).json()
    assert body["card"] == {
        "reason": "the gateway could not be asked — the gateway's engine list did not name "
        "its engines"
    }
    assert body["throughput"] is None


async def test_two_readable_cards_are_not_guessed_between(owner_client, mount_peers):
    mount_peers(
        gateway=FakeGateway(
            engines=[fakes.engine_view(), fakes.engine_view("box")],
            engine_details={"hub": {"vram": CARD}, "box": {"vram": CARD}},
        )
    )
    body = (await owner_client.get("/api/v1/system/resources")).json()
    # Wording moved with the one helper (S40 fix wave C3, machines.the_card).
    assert body["card"] == {
        "reason": "2 machines report a card that can be read, and which one is meant is not "
        "matched here"
    }


async def test_the_panel_shows_the_hubs_card_beside_a_machine_whose_card_is_not_read(
    owner_client, mount_peers
):
    """(S40 fix wave C3) The panel chose by count, so hub plus any always-on
    machine (whose card the hub never reads) showed no card at all."""
    mount_peers(
        gateway=FakeGateway(
            engines=[fakes.engine_view(), fakes.engine_view("dell", builtin=False)],
            engine_details={
                "hub": {"vram": CARD, "fit_frame": "vram"},
                "dell": {"vram": {"total_mb": None, "reason": "not this hub's card"}},
            },
        )
    )
    body = (await owner_client.get("/api/v1/system/resources")).json()
    assert body["card"]["machine"] == "hub" and body["card"]["free_gb"] == 21.4


async def test_a_model_never_placed_on_a_compute_has_no_throughput_not_a_zero(
    owner_client, mount_peers, pool
):
    mount_peers(gateway=FakeGateway(engines=[fakes.engine_view()]))
    await _chat_model(owner_client)
    for _ in range(12):
        await _round(pool, rate=40.0, hours_ago=1, served_on=None)
    assert (await owner_client.get("/api/v1/system/resources")).json()["throughput"] is None
