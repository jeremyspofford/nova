"""app/machines.py — core's one reader of the gateway's engines (S40).

Which providers are engines is the gateway's to say: nothing here names one.
Every failure to ask is a stated PlantUnavailable, never an empty list that
reads as "no machines"."""

from __future__ import annotations

import httpx
import pytest

from app import machines
from app.main import app as core_app
from tests import fakes
from tests.fakes import FakeGateway

CARD = {
    "total_mb": 24576.0,
    "used_mb": 2662.0,
    "free_mb": 21914.0,
    "util_pct": 3.0,
    "reason": None,
    "resident": [],
    "resident_reason": None,
    "free_after_switch_gb": 21.4,
}


class _Dead(httpx.AsyncBaseTransport):
    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("connection refused", request=request)


async def test_the_list_is_the_gateways_own_and_says_whether_it_was_read_live(mount_peers):
    gateway = FakeGateway(engines=[fakes.engine_view()])
    mount_peers(gateway=gateway)
    assert await machines.plant().engines(core_app, live=False) == [fakes.engine_view()]
    assert gateway.seen[-1][0] == "/admin/engines" and gateway.queries[-1] == b"live=false"
    await machines.plant().engines(core_app, live=True)
    assert gateway.queries[-1] == b"live=true"


async def test_a_body_that_names_no_engines_is_a_failure_never_an_empty_list(mount_peers):
    mount_peers(gateway=FakeGateway())  # engines=None: the admin echo, {"gpus": []}
    with pytest.raises(machines.PlantUnavailable, match="did not name its engines"):
        await machines.plant().engines(core_app, live=False)


async def test_an_unreachable_or_unconfigured_gateway_is_stated(mount_peers, monkeypatch):
    mount_peers(gateway=FakeGateway(engines=[]))
    core_app.state.peer_transports[fakes.GATEWAY_URL] = _Dead()
    with pytest.raises(machines.PlantUnavailable, match="could not be reached — ConnectError"):
        await machines.plant().engines(core_app, live=False)
    monkeypatch.delenv("GATEWAY_URL")
    with pytest.raises(machines.PlantUnavailable, match="not configured"):
        await machines.plant().engines(core_app, live=False)


async def test_one_engine_in_full_and_an_unknown_name_is_its_own_error(mount_peers):
    gateway = FakeGateway(
        engines=[fakes.engine_view()],
        engine_details={"hub": {"vram": CARD, "fit_frame": "vram"}},
    )
    mount_peers(gateway=gateway)
    detail = await machines.plant().engine(core_app, "hub")
    assert detail["name"] == "hub" and detail["vram"] == CARD and detail["fit_frame"] == "vram"
    with pytest.raises(machines.UnknownMachine, match="no engine named 'dell'"):
        await machines.plant().engine(core_app, "dell")


def test_split_reads_a_machine_only_when_the_gateway_lists_one():
    engines = frozenset({"hub", "dell"})
    assert machines.split("hub:qwen3.8:27b", engines) == ("hub", "qwen3.8:27b")
    assert machines.split("dell:qwen3:8b", engines) == ("dell", "qwen3:8b")
    assert machines.split("qwen3.8:27b", engines) == (None, "qwen3.8:27b")
    assert machines.split("qwen3:8b", engines) == (None, "qwen3:8b")
    assert machines.split("openrouter:openai/gpt-x", engines) == (
        None,
        "openrouter:openai/gpt-x",
    )


async def test_cards_never_wake_a_machine_that_sleeps_to_read_it(mount_peers):
    gateway = FakeGateway(
        engines=[
            fakes.engine_view(),
            fakes.engine_view(
                "dell", lifecycle="wake_on_lan", state="unobserved", observed_at=None
            ),
        ],
        engine_details={"hub": {"vram": CARD, "fit_frame": "vram"}},
    )
    mount_peers(gateway=gateway)
    pairs = await machines.cards(core_app)
    assert [(view["name"], detail is not None) for view, detail in pairs] == [
        ("hub", True),
        ("dell", False),
    ]
    assert pairs[0][1]["vram"] == CARD
    assert "/admin/engines/dell" not in [path for path, _ in gateway.seen]
    assert gateway.queries[0] == b"live=false"


async def test_a_card_one_machine_could_not_give_is_carried_with_its_reason(mount_peers):
    """Listed, then gone before its own read (the gateway's 404): the machine
    stays in the list, its card slot says why it is empty in the gateway's
    own words, and the machine after it is still read."""
    gateway = FakeGateway(
        engines=[fakes.engine_view(), fakes.engine_view("box"), fakes.engine_view("hub2")],
        engine_details={"hub": {"vram": CARD}, "hub2": {"vram": CARD}},
        engine_missing={"box"},
    )
    mount_peers(gateway=gateway)
    pairs = await machines.cards(core_app)
    assert [view["name"] for view, _ in pairs] == ["hub", "box", "hub2"]
    box = pairs[1][1]
    assert box["vram"] == {"total_mb": None, "reason": "no engine named 'box'"}
    assert box["name"] == "box"  # the reading keeps the view it was asked for
    assert pairs[0][1]["vram"] == CARD and pairs[2][1]["vram"] == CARD
