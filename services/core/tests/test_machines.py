"""app/machines.py — core's one reader of the gateway's engines (S40).

Which providers are engines is the gateway's to say: nothing here names one.
Every failure to ask is a stated PlantUnavailable, never an empty list that
reads as "no machines"."""

from __future__ import annotations

import inspect
import json
import re
from pathlib import Path

import httpx
import pytest

from app import machines
from app.checks import stack
from app.evals.cases import FixtureMachine
from app.main import app as core_app
from app.tools import machines as machine_tools
from tests import fakes
from tests.fakes import FakeGateway

# The gateway pins its EngineView dataclass to this file
# (services/gateway/tests/test_engines.py); core pins its own mirrors here, so
# the contract is held from both sides (S40 fix wave B9).
CONTRACT = Path(__file__).resolve().parents[3] / "docs" / "contracts" / "engine_view.json"

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


# -- S40 T6: the switch, read back, and the eval world ----------------------


async def test_the_switch_is_set_and_what_comes_back_is_the_read_back(mount_peers):
    gateway = FakeGateway(engines=[fakes.engine_view()])
    mount_peers(gateway=gateway)
    back = await machines.plant().set_serving(core_app, "hub", False)
    assert back["serving"] is False and back["state"] == "switched_off"
    assert gateway.seen[-2:] == [
        ("/admin/engines/hub", {"serving": False}),
        ("/admin/engines/hub", None),
    ]


async def test_a_switch_that_did_not_stick_comes_back_as_it_reads(mount_peers):
    mount_peers(gateway=FakeGateway(engines=[fakes.engine_view()], engine_put_sticks=False))
    back = await machines.plant().set_serving(core_app, "hub", False)
    assert back["serving"] is True  # the read-back, never the value sent


async def test_an_unknown_machine_cannot_be_switched(mount_peers):
    mount_peers(gateway=FakeGateway(engines=[fakes.engine_view()]))
    with pytest.raises(machines.UnknownMachine, match="no engine named 'dell'"):
        await machines.plant().set_serving(core_app, "dell", False)


async def test_a_switch_the_gateway_cannot_be_asked_to_set_is_stated(mount_peers):
    mount_peers(gateway=FakeGateway(engines=[]))
    core_app.state.peer_transports[fakes.GATEWAY_URL] = _Dead()
    with pytest.raises(machines.PlantUnavailable, match="could not be reached — ConnectError"):
        await machines.plant().set_serving(core_app, "hub", False)


async def test_the_eval_world_overlays_only_eval_names_and_never_writes_a_real_one(mount_peers):
    """Ruling C8: reads delegate and overlay; a WRITE to a name without the
    eval_ prefix is refused before any HTTP — a live eval in which the model
    reaches for `hub` must never switch off the owner's real engine."""
    gateway = FakeGateway(engines=[fakes.engine_view()])
    mount_peers(gateway=gateway)
    token = machines.PLANT.set(
        machines.FixturePlant(
            {"eval_box": {"compute": "cpu:eval|4c|16g", "tags": {"qwen3:4b": 2_497_293_444}}}
        )
    )
    try:
        views = await machines.plant().engines(core_app, live=True)
        assert [view["name"] for view in views] == ["hub", "eval_box"]
        assert views[1]["state"] == "ready" and views[1]["observed_at"]
        back = await machines.plant().set_serving(core_app, "eval_box", False)
        assert back["serving"] is False and back["state"] == "switched_off"
        assert "/admin/engines/eval_box" not in [path for path, _ in gateway.seen]
        with pytest.raises(machines.PlantUnavailable, match="cannot"):
            await machines.plant().set_serving(core_app, "hub", False)
        assert not any(path.startswith("/admin/engines/hub") for path, _ in gateway.seen)
        with pytest.raises(machines.UnknownMachine):
            await machines.plant().set_serving(core_app, "eval_other", True)
        # A read of a real machine is still the gateway's own.
        assert (await machines.plant().engine(core_app, "hub"))["name"] == "hub"
    finally:
        machines.PLANT.reset(token)
    assert type(machines.plant()) is machines.GatewayPlant


async def test_the_refusal_names_the_machine_and_why_in_words(mount_peers):
    mount_peers(gateway=FakeGateway(engines=[fakes.engine_view()]))
    token = machines.PLANT.set(machines.FixturePlant({"eval_box": {}}))
    try:
        with pytest.raises(machines.PlantUnavailable) as caught:
            await machines.plant().set_serving(core_app, "hub", True)
    finally:
        machines.PLANT.reset(token)
    # Moved (S40 fix wave B3): the refusal reaches the model inside a scored
    # eval turn (machine_configure relays it), so it says what is true without
    # saying "eval" — that explanation stays in the log.
    assert str(caught.value) == "cannot: 'hub' is not one of the machines that can be switched here"


async def test_nothing_the_fixture_plant_says_to_a_tool_mentions_evals(mount_peers, caplog):
    """(S40 fix wave B3) No test-awareness leakage: every string the plant
    produces that can reach a tool result — the write refusal, a declared
    machine's card reason — reads the same as a real hub's words would, and
    names nothing eval but the declared machine itself."""
    mount_peers(gateway=FakeGateway(engines=[fakes.engine_view()]))
    plant = machines.FixturePlant({"eval_box": {}})
    card = await plant.engine(core_app, "eval_box")
    with caplog.at_level("INFO", logger="core"):
        with pytest.raises(machines.PlantUnavailable) as caught:
            await plant.set_serving(core_app, "hub", False)
    said = [card["vram"]["reason"], str(caught.value)]
    assert said[0] == "no card reading for eval_box"
    for text in said:
        assert "eval" not in text.replace("eval_box", "").lower(), text
    # The eval-specific reason is kept where a person reads it, not the model.
    assert any("an eval never changes a real machine" in r.getMessage() for r in caplog.records)


async def test_a_fixture_machine_derives_its_state_from_its_switch(mount_peers):
    """Ruling C8 / T7 CONTRACT PROBLEM 2: the gateway's own rule — a machine
    switched off reads `switched_off` — holds for a declared one too, when it
    is declared and again after every write."""
    mount_peers(gateway=FakeGateway(engines=[]))
    token = machines.PLANT.set(
        machines.FixturePlant(
            {
                "eval_off": {"serving": False},
                "eval_down": {"state": "unreachable", "reason": "ConnectError: refused"},
            }
        )
    )
    try:
        views = {
            view["name"]: view for view in await machines.plant().engines(core_app, live=False)
        }
        assert views["eval_off"]["state"] == "switched_off"
        assert views["eval_down"]["state"] == "unreachable"
        down = await machines.plant().set_serving(core_app, "eval_down", False)
        assert down["state"] == "switched_off"
        back = await machines.plant().set_serving(core_app, "eval_down", True)
        assert back["state"] == "unreachable"  # its declared state, not a guessed "ready"
        on = await machines.plant().set_serving(core_app, "eval_off", True)
        assert on["serving"] is True and on["state"] == "ready"
    finally:
        machines.PLANT.reset(token)


async def test_a_machine_declared_switched_off_reads_ready_once_switched_on(mount_peers):
    """T7's FixtureMachine(serving=False).as_row() declares state
    `switched_off` beside serving false. Switched on, it must never read
    serving true AND switched off — the declared off-state is the switch's,
    not the machine's."""
    mount_peers(gateway=FakeGateway(engines=[]))
    token = machines.PLANT.set(
        machines.FixturePlant({"eval_box": {"serving": False, "state": "switched_off"}})
    )
    try:
        on = await machines.plant().set_serving(core_app, "eval_box", True)
        assert (on["serving"], on["state"]) == (True, "ready")
    finally:
        machines.PLANT.reset(token)


def test_a_fixture_machine_must_carry_the_eval_prefix():
    with pytest.raises(ValueError, match="eval_"):
        machines.FixturePlant({"box": {}})


def test_the_web_shape_lists_models_by_name_with_their_size_or_none():
    view = fakes.engine_view(tags={"qwen3:8b": 5_225_388_164, "nomic-embed-text:latest": None})
    assert machines.machine_json(view) == {
        "name": "hub",
        "lifecycle": "always_on",
        "serving": True,
        "state": "ready",
        "reason": None,
        "observed_at": fakes.ENGINE_AT,
        "compute": fakes.ENGINE_GPU,
        "runtime": "container",
        "models": [
            {"name": "nomic-embed-text:latest", "size_bytes": None},
            {"name": "qwen3:8b", "size_bytes": 5_225_388_164},
        ],
    }
    assert machines.machine_json(fakes.engine_view(tags=None))["models"] == []


# -- the EngineView contract, from core's side (S40 fix wave B9) -------------


def test_cores_mirrors_of_the_engine_view_are_the_contract():
    """Every place core writes an EngineView by hand — the tests' fake, the
    eval plant's defaults, a declared eval machine's row — carries exactly
    the contract's fields. A field the gateway adds or renames without core
    moving is red here, never a silent None in a reader."""
    contract = json.loads(CONTRACT.read_text())
    fields = contract["fields"]
    assert list(fakes.engine_view()) == fields
    assert set(machines._FIXTURE_DEFAULTS) | {"name"} == set(fields)
    assert "name" not in machines._FIXTURE_DEFAULTS  # the plant sets it from the key
    assert set(FixtureMachine(name="eval_box").as_row()) == set(fields)
    plant = machines.FixturePlant({"eval_box": {}})
    assert set(plant._views["eval_box"]) == set(fields)


def test_every_state_core_writes_or_reads_is_one_the_gateway_can_state():
    """The states core emits (the fake's, the plant's) and the ones its
    readers branch on are all in the contract's `states`: a reader keyed on a
    word the gateway never says is a branch that never runs."""
    states = set(json.loads(CONTRACT.read_text())["states"])
    emitted = {
        fakes.engine_view()["state"],
        machines._fixture_state({}, True),
        machines._fixture_state({}, False),
        FixtureMachine(name="eval_box").as_row()["state"],
        FixtureMachine(name="eval_box", serving=False).as_row()["state"],
    }
    assert emitted <= states
    read: set[str] = set()
    for module in (machine_tools, stack, machines):
        source = inspect.getsource(module)
        # `.get("state") == "x"`, `state == "x"` and `.get("state") in ("x", "y")`.
        read |= set(re.findall(r'state"\)\s*(?:==|!=)\s*"(\w+)"', source))
        read |= set(re.findall(r'state\s*(?:==|!=)\s*"(\w+)"', source))
        for group in re.findall(r'state"\)\s*(?:not\s+)?in\s*\(([^)]*)\)', source):
            read |= set(re.findall(r'"(\w+)"', group))
    # Not vacuous: the readers do branch on the gateway's words.
    assert {"ready", "unreachable", "switched_off", "unobserved"} <= read
    assert read <= states, read - states
