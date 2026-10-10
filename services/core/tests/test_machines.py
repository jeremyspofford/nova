"""app/machines.py — core's one reader of the gateway's engines (S40).

Which providers are engines is the gateway's to say: nothing here names one.
Every failure to ask is a stated PlantUnavailable, never an empty list that
reads as "no machines"."""

from __future__ import annotations

import copy
import hashlib
import inspect
import json
import re
import uuid
from pathlib import Path

import httpx
import pytest

from app import device_facts, devices_ws, machines, tools
from app import devices as device_rows
from app.checks import stack
from app.evals.cases import FixtureDevice, FixtureMachine
from app.main import app as core_app
from app.tools import machines as machine_tools
from app.tools.base import ToolContext
from tests import fakes
from tests.conftest import requires_db
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
    # Moved (S40 fix wave B8): "could not be asked" is not "holds nothing".
    # tags None (the engine did not answer what it holds) used to become [],
    # which the tile drew as "No models listed." — silence read as a
    # measured empty list. It is None now; a real empty listing stays [].
    assert machines.machine_json(fakes.engine_view(tags=None))["models"] is None
    assert machines.machine_json(fakes.engine_view(tags={}))["models"] == []


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


# -- THE card: one selection, by readability (S40 fix wave C3) --------------

NOT_THIS_CARD = {
    "total_mb": None,
    "reason": "dell's card cannot be read from this hub — only the hub's own card is read here",
}


def _pair(name: str, vram: dict) -> tuple[dict, dict]:
    view = fakes.engine_view(name)
    return view, {**view, "vram": vram, "fit_frame": None}


def test_the_card_is_chosen_by_readability_never_by_how_many_machines_answered():
    """The hub reads exactly one card, its own; every other machine's is
    stated unreadable (gateway NOT_THIS_CARD). Counting readings made hub plus
    any always-on node "2 machines report a card", and the panel and the
    inference check lost the hub's card for good."""
    hub, dell = _pair("hub", CARD), _pair("dell", NOT_THIS_CARD)
    assert machines.the_card([hub, dell]) == hub
    assert machines.the_card([dell, hub]) == hub


def test_one_machine_whose_card_failed_is_carried_with_its_own_reason():
    failed = _pair("hub", {"total_mb": None, "reason": "nvidia-smi could not be run"})
    assert machines.the_card([failed]) == failed
    asleep = (fakes.engine_view("dell", lifecycle="wake_on_lan", state="unobserved"), None)
    assert machines.the_card([failed, asleep]) == failed


def test_two_readable_cards_are_never_guessed_between():
    reason = machines.the_card([_pair("hub", CARD), _pair("box", CARD)])
    assert reason == (
        "2 machines report a card that can be read, and which one is meant is not matched here"
    )


def test_no_readable_card_among_several_says_each_ones_reason():
    reason = machines.the_card(
        [
            _pair("hub", {"total_mb": None, "reason": "nvidia-smi failed"}),
            _pair("dell", NOT_THIS_CARD),
        ]
    )
    assert reason == (
        "no machine's card could be read — hub: nvidia-smi failed; dell: " + NOT_THIS_CARD["reason"]
    )


def test_nothing_listed_or_everything_asleep_is_no_card_with_that_reason():
    asleep = (fakes.engine_view("dell", lifecycle="wake_on_lan", state="unobserved"), None)
    for pairs in ([], [asleep]):
        assert machines.the_card(pairs) == "the gateway lists no machine whose card could be read"


def test_both_card_readers_choose_through_the_one_helper():
    from app import resources_api
    from app.checks import inference

    for reader in (inference._card_facts, resources_api._card):
        source = inspect.getsource(reader)
        assert "machines.the_card(" in source
        assert "len(read)" not in source


# -- S42a: the fixture plant overlays declared devices on the real agents ----


async def test_a_replays_agents_are_its_declared_devices_alone(monkeypatch):
    """Pin moved (S42b Task 22, the replay-hermeticity ruling): a replay's
    plant holds only the machines the case declared. It used to list the real
    agents beside them — "real-pc", "eval_pc" — so she could see a real
    machine the replay's own re-pair card then called unpaired. The real
    agents are never even read now."""

    async def real_agents(self, app):
        raise AssertionError("a replay read the real agents")

    monkeypatch.setattr(machines.GatewayPlant, "agents", real_agents)
    plant = machines.FixturePlant(
        {}, devices={"eval_pc": {"name": "eval_pc", "platform": "windows"}}
    )
    names = [a["name"] for a in await plant.agents(None)]
    assert names == ["eval_pc"]
    assert await machines.FixturePlant({}).agents(None) == []


async def test_a_replay_reports_no_knock_and_never_reads_the_real_ones(monkeypatch):
    """device_list's knock section goes through the plant (hermeticity
    ruling): a case can declare no revoked device, so a replay has none to
    report — never the real table's."""
    from app import devices

    async def real_knocks(*_a, **_kw):
        raise AssertionError("a replay read the real knocks")

    monkeypatch.setattr(devices, "revoked_knocks", real_knocks)
    plant = machines.FixturePlant(
        {}, devices={"eval_pc": {"name": "eval_pc", "platform": "windows"}}
    )
    assert await plant.knocks(None) == []


def test_a_fixture_device_must_carry_the_prefix():
    with pytest.raises(ValueError):
        machines.FixturePlant({}, devices={"real-pc": {"name": "real-pc"}})


# -- S42b: the hub's build each agent is compared with (Task 18, ruling F11) --


async def _paired_agent(pool, name: str, version: str) -> None:
    from app import devices

    minted = await devices.mint_pairing_code(pool, created_by=None)
    enrolled = await devices.enroll(
        pool,
        code=minted["code"],
        pubkey=hashlib.sha256(name.encode()).hexdigest(),
        name=name,
        platform="linux",
        hostname=name.upper(),
    )
    await pool.execute(
        "UPDATE devices SET facts = $2, facts_at = now() WHERE id = $1",
        uuid.UUID(enrolled["device_id"]),
        {"v": 2, "agent": {"version": version, "mode": "foreground"}},
    )


@requires_db
async def test_the_real_plant_compares_each_agent_with_the_hubs_build(pool, monkeypatch):
    from app import agent_dist

    async def the_hubs_build() -> str:
        return "aaaaaaaaaaaa"

    monkeypatch.setattr(agent_dist, "version", the_hubs_build)
    await _paired_agent(pool, "on-the-build", "aaaaaaaaaaaa")
    await _paired_agent(pool, "on-another", "0a0a0a0a0a0a")
    builds = {view["name"]: view["build"] for view in await machines.GatewayPlant().agents(None)}
    assert builds == {
        "on-the-build": {"state": "current", "hub_version": "aaaaaaaaaaaa"},
        "on-another": {"state": "behind", "hub_version": "aaaaaaaaaaaa"},
    }


@requires_db
async def test_the_real_plant_carries_each_agents_stored_addresses(pool, monkeypatch):
    """model-machines T3: the addresses machine_status matches a provider URL
    against come from the device row's stored facts, through the real plant."""
    from app import agent_dist

    async def the_hubs_build() -> str:
        return "aaaaaaaaaaaa"

    monkeypatch.setattr(agent_dist, "version", the_hubs_build)
    await _paired_agent(pool, "netted", "aaaaaaaaaaaa")
    await pool.execute(
        "UPDATE devices SET facts = $2 WHERE name = $1",
        "netted",
        {
            "v": 2,
            "agent": {"version": "aaaaaaaaaaaa", "mode": "foreground"},
            "net": {
                "ifaces": [
                    {"name": "lo", "mac": "", "ipv4_cidr": ["127.0.0.1/8"], "up": True},
                    {"name": "Tailscale", "mac": "", "ipv4_cidr": ["100.122.40.93/32"], "up": True},
                ]
            },
        },
    )
    await _paired_agent(pool, "bare", "aaaaaaaaaaaa")
    addresses = {
        view["name"]: view["addresses"] for view in await machines.GatewayPlant().agents(None)
    }
    assert addresses == {"netted": ("100.122.40.93",), "bare": ()}


@requires_db
async def test_a_replay_names_one_hub_build_and_never_reads_the_real_one(pool, monkeypatch):
    """F11: no build is read during an eval. Every agent a replay lists is
    compared with the fixture's hub build, the one FixturePlant.update_agent
    (Task 22) answers too, so one replay never names two hub builds. Pin
    moved (Task 22, the replay-hermeticity ruling): the real row paired here
    is no longer listed beside the declared devices at all."""
    from app import agent_dist

    async def never_in_a_replay() -> str:
        raise AssertionError("a replay read the hub's real build")

    def never_current():
        raise AssertionError("a replay read the hub's real build")

    monkeypatch.setattr(agent_dist, "version", never_in_a_replay)
    monkeypatch.setattr(agent_dist, "read", never_in_a_replay)
    monkeypatch.setattr(agent_dist, "current", never_current)
    await _paired_agent(pool, "real-pc", "0a0a0a0a0a0a")
    plant = machines.FixturePlant(
        {},
        devices={
            # Views as FixtureDevice.as_view() makes them: no hub build known.
            "eval_laptop": {
                "name": "eval_laptop",
                "agent_version": "0a0a0a0a0a0a",
                "build": {"state": "unknown", "hub_version": None},
            },
            "eval_current": {
                "name": "eval_current",
                "agent_version": machines.FIXTURE_HUB_VERSION,
                "build": {"state": "unknown", "hub_version": None},
            },
        },
    )
    builds = {view["name"]: view["build"] for view in await plant.agents(None)}
    fixture = machines.FIXTURE_HUB_VERSION
    assert builds == {
        "eval_laptop": {"state": "behind", "hub_version": fixture},
        "eval_current": {"state": "current", "hub_version": fixture},
    }
    assert {build["hub_version"] for build in builds.values()} == {await plant.hub_version()}
    # The declaration itself is untouched: each listing is computed fresh.
    assert plant._devices["eval_laptop"]["build"] == {"state": "unknown", "hub_version": None}


# -- S42b Task 22: machine_update in a replay acts only on declared machines --


async def test_a_replay_updates_only_a_declared_device_and_never_a_real_one():
    plant = machines.FixturePlant(
        {},
        devices={
            "eval_laptop": {"name": "eval_laptop", "agent_version": "0a0a0a0a0a0a", "hub": False}
        },
        updates={"eval_laptop": "sent"},
    )
    out = await plant.update_agent(None, "eval_laptop", requested_by="nova")
    assert out["outcome"] == "sent" and out["version"] == machines.FIXTURE_HUB_VERSION
    assert out["from_version"] == "0a0a0a0a0a0a"
    with pytest.raises(machines.UnknownMachine) as exc:
        await plant.update_agent(None, "dell", requested_by="nova")
    # The replay's own listing (hermeticity ruling): a real machine's name is
    # simply not a paired machine here, in the words a real hub uses.
    assert str(exc.value) == (
        "cannot: no paired machine named 'dell' — the paired machines are: eval_laptop"
    )


async def test_a_replay_answers_each_declared_outcome_and_sends_nothing(monkeypatch):
    async def never(*_a, **_kw):
        raise AssertionError("a replay reached the real update path")

    from app import agent_updates

    monkeypatch.setattr(agent_updates, "update_now", never)
    plant = machines.FixturePlant(
        {},
        devices={
            "eval_a": {"name": "eval_a", "agent_version": None, "hub": True},
            "eval_b": {"name": "eval_b", "agent_version": "0a0a0a0a0a0a"},
        },
        updates={"eval_a": "confirmed"},
    )
    a = await plant.update_agent(None, "eval_a", requested_by="nova")
    b = await plant.update_agent(None, "eval_b", requested_by="nova")
    assert (a["outcome"], a["hub"], a["from_version"]) == ("confirmed", True, None)
    assert (b["outcome"], b["hub"]) == ("sent", False)  # "sent" when none is declared
    assert a["in_flight"] == b["in_flight"] == 0


async def test_a_replay_refuses_the_engines_name_naming_the_door_machines_it_declared():
    """The door is not identity: 'hub' is the bundled engine's name, and the
    refusal names each machine whose agent came in through the hub machine's
    own door AS that — never as the hub machine."""
    plant = machines.FixturePlant(
        {},
        devices={
            "eval_minipc": {"name": "eval_minipc", "hub": True},
            "eval_laptop": {"name": "eval_laptop", "hub": False},
        },
    )
    for asked in ("hub", " Hub "):
        with pytest.raises(machines.UnknownMachine) as exc:
            await plant.update_agent(None, asked, requested_by="nova")
        said = str(exc.value)
        assert said.startswith("cannot: ")
        assert "is the bundled engine's name" in said
        assert (
            "One paired machine's agent came in through the hub machine's own door: eval_minipc."
            in said
        )
        assert "eval_laptop" not in said


def test_a_replay_declares_updates_only_for_its_devices_and_only_outcomes_it_can_say():
    with pytest.raises(ValueError, match="eval_other"):
        machines.FixturePlant(
            {}, devices={"eval_a": {"name": "eval_a"}}, updates={"eval_other": "sent"}
        )
    with pytest.raises(ValueError, match="'cannot'"):
        machines.FixturePlant(
            {}, devices={"eval_a": {"name": "eval_a"}}, updates={"eval_a": "cannot"}
        )


# -- Task 32, MF5: the said-not-done grouping goes through the plant -----------


def _declared_view(name: str, facts: dict | None) -> dict:
    """A declared device's view, as cases.FixtureDevice.as_view builds one."""
    return device_facts.agent_view(
        name=name,
        platform="windows",
        hostname=name.upper(),
        connected=True,
        last_seen=None,
        facts=None if facts is None else device_facts.validate_auth(facts),
        facts_at=None,
    )


_NATIVE = {
    "v": 2,
    "agent": {"version": "0.2.0", "mode": "run-key", "session_interactive": True},
    "os": {"goos": "windows", "arch": "amd64", "version": "Windows 11 Pro", "wsl": None},
    "hostname": "PC",
    "machine_uid": "c" * 64,
}
_INSIDE_WSL = {
    **_NATIVE,
    "agent": {**_NATIVE["agent"], "mode": "systemd-user"},
    "os": {"goos": "linux", "arch": "amd64", "version": "Ubuntu", "wsl": {"distro": "Ubuntu"}},
}


async def test_a_replays_machine_grouping_is_its_declared_devices_alone(monkeypatch):
    """Each declared device stands alone, with no machine, unless its declared
    facts name one — read by the live rows' own rule (device_facts.machine:
    never inside WSL) — and the real rows are never read."""
    from app import devices

    async def real_rows(*_a, **_kw):
        raise AssertionError("a replay read the real device registry")

    monkeypatch.setattr(devices, "live_machines", real_rows)
    plant = machines.FixturePlant(
        {},
        devices={
            "eval_pc": _declared_view("eval_pc", None),
            "eval_win": _declared_view("eval_win", _NATIVE),
            "eval_wsl": _declared_view("eval_wsl", _INSIDE_WSL),
        },
    )
    assert await plant.machine_groups(None) == {
        "eval_pc": None,
        "eval_win": "c" * 64,
        "eval_wsl": None,
    }
    assert await machines.FixturePlant({}).machine_groups(None) == {}
    for facts in (None, _NATIVE, _INSIDE_WSL):
        clean = None if facts is None else device_facts.validate_auth(facts)
        assert device_facts.view_machine(_declared_view("eval_x", facts)) == (
            device_facts.machine(clean)
        )


# --- T9: GatewayPlant.model_providers reads the gateway's providers and walls ---

_DELL_NOTE = (
    "the last listing was refused (502): could not reach http://100.122.40.93:11435/v1 — "
    "RemoteProtocolError: Server disconnected without sending a response."
)
_PROVIDERS = [
    {"name": "hub", "adapter": "ollama", "base_url": "", "listing": "available"},
    {
        "name": "dell",
        "adapter": "openai-chat",
        "base_url": "http://100.122.40.93:11435/v1",
        "listing": "unknown",
        "listing_note": _DELL_NOTE,
    },
    {
        "name": "openrouter",
        "adapter": "openai-chat",
        "base_url": "https://openrouter.ai/api/v1",
        "listing": "available",
        "listing_note": "312 models listed",
    },
]
_WALLS = [
    {
        "provider": "dell",
        "model": "qwen3:8b",
        "walled_until": "2026-10-06T12:28:00+00:00",
        "reason": "dell:qwen3:8b refused (502): could not reach dell at "
        "http://100.122.40.93:11435/v1 — RemoteProtocolError: Server disconnected",
        "status": 502,
        "strikes": 66,
    }
]


class _Admin(httpx.AsyncBaseTransport):
    """A gateway whose /admin/providers and /admin/routes answer on their own:
    each path maps to (status, body) — body a dict/list (JSON) or bytes — or
    to an exception the transport raises. Records every request."""

    def __init__(self, answers: dict) -> None:
        self.answers = answers
        self.seen: list[tuple[str, str, str | None]] = []

    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        self.seen.append((request.method, request.url.path, request.headers.get("authorization")))
        answer = self.answers.get(request.url.path)
        if answer is None:
            return httpx.Response(404, json={"error": "no such path"})
        if isinstance(answer, Exception):
            raise answer
        status, body = answer
        if isinstance(body, bytes):
            return httpx.Response(status, content=body)
        return httpx.Response(status, json=body)


def _gateway_answers(**over) -> dict:
    answers = {
        "/admin/providers": (200, {"providers": copy.deepcopy(_PROVIDERS)}),
        "/admin/routes": (200, {"routes": [], "walls": copy.deepcopy(_WALLS)}),
    }
    answers.update({f"/admin/{key}": value for key, value in over.items()})
    return answers


def _mount_admin(mount_peers, answers: dict) -> _Admin:
    mount_peers(gateway=FakeGateway())
    transport = _Admin(answers)
    core_app.state.peer_transports[fakes.GATEWAY_URL] = transport
    return transport


async def test_model_providers_are_the_gateways_rows_and_walls_exactly_as_served(mount_peers):
    transport = _mount_admin(mount_peers, _gateway_answers())
    got = await machines.GatewayPlant().model_providers(core_app)
    assert got == (_PROVIDERS, _WALLS)
    assert isinstance(got, tuple) and [p["name"] for p in got[0]] == ["hub", "dell", "openrouter"]
    assert [path for _, path, _ in transport.seen] == ["/admin/providers", "/admin/routes"]
    assert all(method == "GET" for method, _, _ in transport.seen)
    assert all(auth == f"Bearer {fakes.GATEWAY_TOKEN}" for _, _, auth in transport.seen)


async def test_model_providers_reads_through_the_real_gateway_link(mount_peers):
    gateway = FakeGateway()
    gateway.admin_body = {"providers": [], "routes": [], "walls": []}
    mount_peers(gateway=gateway)
    assert await machines.GatewayPlant().model_providers(core_app) == ([], [])
    assert {"/admin/providers", "/admin/routes"} <= {path for path, _ in gateway.seen}


async def test_an_unreachable_or_unconfigured_gateway_is_stated_never_an_empty_pair(
    mount_peers, monkeypatch
):
    mount_peers(gateway=FakeGateway())
    core_app.state.peer_transports[fakes.GATEWAY_URL] = _Dead()
    with pytest.raises(machines.PlantUnavailable, match="could not be reached — ConnectError"):
        await machines.GatewayPlant().model_providers(core_app)
    monkeypatch.delenv("GATEWAY_URL")
    with pytest.raises(machines.PlantUnavailable, match="not configured"):
        await machines.GatewayPlant().model_providers(core_app)


async def test_a_routes_read_that_cannot_reach_the_gateway_is_never_a_partial_answer(mount_peers):
    _mount_admin(mount_peers, _gateway_answers(routes=httpx.ConnectError("connection refused")))
    with pytest.raises(machines.PlantUnavailable, match="could not be reached — ConnectError"):
        await machines.GatewayPlant().model_providers(core_app)


@pytest.mark.parametrize(
    ("status", "body", "words"),
    [(500, {"error": "boom"}, "boom"), (401, {"error": "unauthorized"}, "unauthorized")],
)
@pytest.mark.parametrize("failing", ["providers", "routes"])
async def test_a_refused_read_names_its_path_and_the_gateways_words(
    mount_peers, failing, status, body, words
):
    transport = _mount_admin(mount_peers, _gateway_answers(**{failing: (status, body)}))
    with pytest.raises(machines.PlantUnavailable) as caught:
        await machines.GatewayPlant().model_providers(core_app)
    message = str(caught.value)
    assert f"/admin/{failing}" in message and words in message
    if failing == "providers":
        # One stated reason is enough: routes is not read after providers failed.
        assert "/admin/routes" not in [path for _, path, _ in transport.seen]


@pytest.mark.parametrize("status", [202, 302])
@pytest.mark.parametrize("failing", ["providers", "routes"])
async def test_any_answer_but_200_is_refused_even_with_a_well_shaped_body(
    mount_peers, failing, status
):
    # Only a 200 is an answer: a 2xx/3xx that carries a body of the right
    # shape is still a refusal naming its path, never rows read as served.
    good = _gateway_answers()[f"/admin/{failing}"][1]
    _mount_admin(mount_peers, _gateway_answers(**{failing: (status, good)}))
    with pytest.raises(machines.PlantUnavailable) as caught:
        await machines.GatewayPlant().model_providers(core_app)
    assert f"/admin/{failing}" in str(caught.value)


_BAD_PROVIDERS = {
    "not-json": (200, b"<html>nope</html>"),
    "not-an-object": (200, [{"name": "dell"}]),
    "no-providers-key": (200, {"rows": []}),
    "providers-not-a-list": (200, {"providers": {"name": "dell"}}),
    "providers-null": (200, {"providers": None}),
    "an-entry-not-a-dict": (200, {"providers": [_PROVIDERS[0], "dell"]}),
}
_BAD_ROUTES = {
    "not-json": (200, b"<html>nope</html>"),
    "not-an-object": (200, [{"provider": "dell"}]),
    "no-walls-key": (200, {"routes": []}),
    "walls-not-a-list": (200, {"routes": [], "walls": {"provider": "dell"}}),
    "walls-null": (200, {"routes": [], "walls": None}),
    "an-entry-not-a-dict": (200, {"routes": [], "walls": [_WALLS[0], None]}),
}


@pytest.mark.parametrize("case", sorted(_BAD_PROVIDERS))
async def test_a_providers_answer_of_the_wrong_shape_is_stated_naming_the_providers_read(
    mount_peers, case
):
    _mount_admin(mount_peers, _gateway_answers(providers=_BAD_PROVIDERS[case]))
    with pytest.raises(machines.PlantUnavailable, match="provider"):
        await machines.GatewayPlant().model_providers(core_app)


@pytest.mark.parametrize("case", sorted(_BAD_ROUTES))
async def test_a_routes_answer_of_the_wrong_shape_is_stated_naming_the_walls_read(
    mount_peers, case
):
    _mount_admin(mount_peers, _gateway_answers(routes=_BAD_ROUTES[case]))
    with pytest.raises(machines.PlantUnavailable) as caught:
        await machines.GatewayPlant().model_providers(core_app)
    assert re.search(r"wall|route", str(caught.value))
    assert "provider" not in str(caught.value)


@pytest.mark.parametrize(
    ("providers", "walls"),
    [([], []), (_PROVIDERS, []), ([], _WALLS)],
    ids=["both-empty", "no-walls", "no-providers"],
)
async def test_an_empty_list_is_a_real_answer_not_a_failure(mount_peers, providers, walls):
    _mount_admin(
        mount_peers,
        _gateway_answers(
            providers=(200, {"providers": copy.deepcopy(providers)}),
            routes=(200, {"routes": [], "walls": copy.deepcopy(walls)}),
        ),
    )
    assert await machines.GatewayPlant().model_providers(core_app) == (providers, walls)


async def test_the_fixture_plant_reads_the_real_providers_and_walls_unchanged(mount_peers):
    transport = _mount_admin(mount_peers, _gateway_answers())
    plant = machines.FixturePlant(
        {"eval_box": {"compute": "cpu:eval|4c|16g", "tags": {"qwen3:4b": 2_497_293_444}}}
    )
    assert await plant.model_providers(core_app) == await machines.GatewayPlant().model_providers(
        core_app
    )
    assert await plant.model_providers(core_app) == (_PROVIDERS, _WALLS)
    assert {method for method, _, _ in transport.seen} == {"GET"}
    assert {path for _, path, _ in transport.seen} == {"/admin/providers", "/admin/routes"}


async def test_the_fixture_plant_raises_the_gateways_own_failure(mount_peers):
    _mount_admin(mount_peers, _gateway_answers(routes=(500, {"error": "boom"})))
    plant = machines.FixturePlant({})
    with pytest.raises(machines.PlantUnavailable) as fixture_failure:
        await plant.model_providers(core_app)
    with pytest.raises(machines.PlantUnavailable) as real_failure:
        await machines.GatewayPlant().model_providers(core_app)
    assert str(fixture_failure.value) == str(real_failure.value)


# -- S29b T5: a replay's declared device answers device_run from its case ------
#
# Criteria (S29b T5):
#   C1 LOAD: a case device may declare `run` answers, a list of
#      {"argv": [str, ...], "exit_code": int, "output": str (optional)}; they
#      round-trip through case_from_dict / as_json, and a malformed one (not a
#      list, an entry not an object, an unknown key, an empty or non-text argv,
#      a non-int or bool exit_code, a non-text output, the same argv twice) is
#      a CaseError at LOAD that names `run` (tests/test_eval_corpus.py). The
#      plant refuses run answers for a device the replay did not declare, like
#      `updates` (here).
#   C2 ANSWERED: in a replay whose plant holds a declared device's run answers,
#      device_run on that device with a declared argv returns what a real
#      frame's call returns — "<name> ran <argv> — exit <code>\n<output>",
#      ok True whatever the exit code — and files exactly one run fact
#      {"run": {"exit_code", "device", "argv", "cwd": None}, "target"} plus the
#      connectivity fact {"device": <name>, "connected": True}; the hub
#      (command, is_connected) and the real registry are never touched.
#   C3 UNDECLARED: an argv the case did not declare is a stated CANNOT
#      refusal ("Error: cannot: …", ok False) — never a fake success — files
#      no run fact, touches nothing real, and says nothing about evals,
#      replays, fixtures or declarations (S40 fix wave B3).
#   C4 SCOPE: shell.exec only — every other acting device tool on a
#      run-declaring device still refuses as today ("no command can be sent");
#      a device that declares no run answers still refuses device_run as
#      today; a declared device that is NOT connected refuses device_run in
#      the real not-connected words, files {"connected": False} and no run
#      fact.
#   C5 RUNNER: runner._install_fixture_plant hands each declared device's run
#      answers to the plant, and a whole replay (runner.run_case) through the
#      real turn path stores a device_run span ok with the run fact carrying
#      the declared exit code, the hub never reached
#      (tests/test_eval_runner.py).
#
# Assumptions (design calls, T5 RED 2026-10-09):
#   - The answer's shape is the real result frame's: `output` (one text, what
#     novad's shell.exec returns), not stdout/stderr — a fixture answers in the
#     frame's own words, so device_run's formatting runs unchanged.
#   - Answers are keyed by argv alone (exact list match); a cwd is checked as a
#     real call checks it and carried on the fact, never part of the key.
#   - A declared answer is an ok frame: a nonzero exit is the program's
#     outcome, not a failed frame. A failed frame (ok false + error) is not
#     declarable in T5.
#   - FixturePlant takes `runs={device: [answer dicts as declared]}`; how the
#     plant answers (a paired_device row + a plant command hook at _command,
#     or a plant-side admit) is GREEN's call — tests drive tools.dispatch.
#   - Connectivity in a replay is the declaration's `connected`, never
#     hub.is_connected.

_T5_ARGV = ["pytest", "-q"]
_T5_OUTPUT = "1 failed, 39 passed in 2.10s"
_T5_RUNS = [
    {"argv": _T5_ARGV, "exit_code": 1, "output": _T5_OUTPUT},
    {"argv": ["git", "status"], "exit_code": 0, "output": "nothing to commit"},
]


def _t5_alarms(monkeypatch) -> list[str]:
    """The hub and the real registry, each made an alarm that records it was
    touched and then raises."""
    touched: list[str] = []

    def alarm(what: str, *, is_async: bool):
        def sync(*_a, **_kw):
            touched.append(what)
            raise AssertionError(f"a replay touched {what}")

        async def coroutine(*a, **kw):
            return sync(*a, **kw)

        return coroutine if is_async else sync

    monkeypatch.setattr(devices_ws.Hub, "command", alarm("hub.command", is_async=True))
    monkeypatch.setattr(devices_ws.Hub, "is_connected", alarm("hub.is_connected", is_async=False))
    for name in ("get_live_by_name", "list_devices", "get", "get_live"):
        monkeypatch.setattr(device_rows, name, alarm(f"registry {name}", is_async=True))
    return touched


def _t5_plant(*, connected: bool = True, runs: list[dict] | None = None, **extra_devices):
    laptop = FixtureDevice(
        name="eval_laptop", platform="linux", hostname="EVAL-LAPTOP", connected=connected
    )
    devices = {"eval_laptop": laptop.as_view()}
    for name, device in extra_devices.items():
        devices[name] = device.as_view()
    return machines.FixturePlant(
        {}, devices=devices, runs={"eval_laptop": _T5_RUNS if runs is None else runs}
    )


async def _t5_dispatch(plant, tool: str, args: dict) -> tuple[str, bool, list[dict]]:
    sink: list[dict] = []
    ctx = ToolContext(app=None, person=None, workspace_root=Path("/tmp"), facts_sink=sink)
    token = machines.PLANT.set(plant)
    try:
        result, ok = await tools.dispatch(tool, args, ctx)
    finally:
        machines.PLANT.reset(token)
    return result, ok, sink


def _t5_run_facts(sink: list[dict]) -> list[dict]:
    return [f for f in sink if isinstance(f.get("run"), dict)]


def test_s29b_t5_c1_the_plant_refuses_run_answers_for_an_undeclared_device():
    with pytest.raises(ValueError, match="eval_other"):
        machines.FixturePlant(
            {},
            devices={"eval_laptop": {"name": "eval_laptop"}},
            runs={"eval_other": _T5_RUNS},
        )


@pytest.mark.parametrize(
    "argv,exit_code,output",
    [(_T5_ARGV, 1, _T5_OUTPUT), (["git", "status"], 0, "nothing to commit")],
    ids=["exit-1", "exit-0"],
)
async def test_s29b_t5_c2_a_declared_argv_is_answered_as_a_real_frame_is(
    monkeypatch, argv, exit_code, output
):
    touched = _t5_alarms(monkeypatch)
    result, ok, sink = await _t5_dispatch(
        _t5_plant(), "device_run", {"device": "eval_laptop", "argv": argv}
    )
    assert ok is True, result
    # device_run's own format over the declared frame: a nonzero exit is
    # still a call that ran.
    assert result == f"eval_laptop ran {argv} — exit {exit_code}\n{output}"
    assert _t5_run_facts(sink) == [
        {
            "run": {"exit_code": exit_code, "device": "eval_laptop", "argv": argv, "cwd": None},
            "target": " ".join(argv),
        }
    ]
    assert {"device": "eval_laptop", "connected": True} in [
        {k: f[k] for k in ("device", "connected")} for f in sink if "connected" in f
    ]
    assert touched == []


async def test_s29b_t5_c3_an_undeclared_argv_is_a_stated_cannot_never_a_success(monkeypatch):
    touched = _t5_alarms(monkeypatch)
    result, ok, sink = await _t5_dispatch(
        _t5_plant(), "device_run", {"device": "eval_laptop", "argv": ["rm", "-rf", "/tmp/x"]}
    )
    assert ok is False
    assert result.startswith("Error: cannot"), result
    assert "ran" not in result.split("\n", 1)[0].replace("cannot", ""), result
    assert _t5_run_facts(sink) == []
    assert touched == []
    # Nothing a scored turn reads mentions the harness (S40 fix wave B3).
    said = result.replace("eval_laptop", "").lower()
    for word in ("eval", "replay", "fixture", "declar"):
        assert word not in said, result


async def test_s29b_t5_c3_a_prefix_of_a_declared_argv_is_not_declared(monkeypatch):
    """Exact match: `pytest` alone, or `pytest -q -x`, is not `pytest -q`."""
    _t5_alarms(monkeypatch)
    for argv in (["pytest"], [*_T5_ARGV, "-x"]):
        result, ok, sink = await _t5_dispatch(
            _t5_plant(), "device_run", {"device": "eval_laptop", "argv": argv}
        )
        assert ok is False and result.startswith("Error: cannot"), result
        assert _t5_run_facts(sink) == []


_T5_OTHER_ACTING = [
    ("device_launch_app", {"app": "notepad"}),
    ("device_list_files", {"path": "/tmp"}),
    ("device_read_file", {"path": "/tmp/notes.txt"}),
    ("device_write_file", {"path": "/tmp/notes.txt", "content": "hi"}),
    ("device_notify", {"message": "hi"}),
]


@pytest.mark.parametrize("tool,args", _T5_OTHER_ACTING, ids=[name for name, _ in _T5_OTHER_ACTING])
async def test_s29b_t5_c4_only_device_run_is_answered(monkeypatch, tool, args):
    """A precision pin (passes today, must still pass after GREEN): the seam is
    shell.exec only."""
    touched = _t5_alarms(monkeypatch)
    result, ok, _sink = await _t5_dispatch(_t5_plant(), tool, {"device": "eval_laptop", **args})
    assert ok is False
    assert result.startswith("Error: cannot: no command can be sent to eval_laptop's agent"), result
    assert touched == []


async def test_s29b_t5_c4_a_device_declaring_no_runs_still_refuses_device_run(monkeypatch):
    """A precision pin: a run answer is per device."""
    touched = _t5_alarms(monkeypatch)
    plant = _t5_plant(eval_pc=FixtureDevice(name="eval_pc", platform="linux", hostname="EVAL-PC"))
    result, ok, sink = await _t5_dispatch(
        plant, "device_run", {"device": "eval_pc", "argv": _T5_ARGV}
    )
    assert ok is False
    assert result.startswith("Error: cannot: no command can be sent to eval_pc's agent"), result
    assert sink == [] and touched == []


async def test_s29b_t5_c4_a_declared_device_not_connected_refuses_in_the_real_words(monkeypatch):
    touched = _t5_alarms(monkeypatch)
    result, ok, sink = await _t5_dispatch(
        _t5_plant(connected=False), "device_run", {"device": "eval_laptop", "argv": _T5_ARGV}
    )
    assert ok is False
    assert result.startswith("Error: device 'eval_laptop' is not connected"), result
    assert _t5_run_facts(sink) == []
    assert [f["connected"] for f in sink if f.get("device") == "eval_laptop"] == [False]
    assert touched == []


# -- walk-fixes T2: a machine named by its hostname or a spacing/case variant --
#
# The S30a walk (turn 198796df): machine_update {"machine": "mini pc"} said "no
# paired machine named 'mini pc'" although the device's own row carries
# hostname mini-pc. Every name a tool resolves goes through one resolver,
# derived from the stored rows (name + hostname), never an alias list.


async def _row(pool, name: str, hostname: str) -> None:
    await pool.execute(
        "INSERT INTO devices (name, platform, hostname, pubkey) VALUES ($1, 'linux', $2, $3)",
        name,
        hostname,
        uuid.uuid4().hex * 2,
    )


@requires_db
@pytest.mark.parametrize("asked", ["mini pc", "MINI-PC", "mini_pc", "Mini-PC"])
async def test_t2_a_hostname_variant_resolves_the_device_tools_device(pool, asked):
    await _row(pool, "Beelink Mini S", "mini-pc")
    await _row(pool, "DELL-XPS-8950", "dell")
    row = await machines.GatewayPlant().paired_device(None, asked)
    assert row["name"] == "Beelink Mini S"


@requires_db
async def test_t2_machine_update_resolves_a_hostname_variant(pool, monkeypatch):
    from app import agent_updates

    sent: list[str] = []

    async def update_now(_pool, *, name, **_kw):
        sent.append(name)
        return agent_updates.UpdateOutcome(
            machine=name, outcome="current", version="v", from_version="v"
        )

    monkeypatch.setattr(agent_updates, "update_now", update_now)
    await _row(pool, "Beelink Mini S", "mini-pc")
    await _row(pool, "DELL-XPS-8950", "dell")
    out = await machines.GatewayPlant().update_agent(None, "mini pc", requested_by="nova")
    assert sent == ["Beelink Mini S"] and out["machine"] == "Beelink Mini S"


@requires_db
async def test_t2_a_loose_name_two_devices_match_is_a_cannot_naming_both(pool):
    await _row(pool, "Beelink Mini S", "mini-pc")
    await _row(pool, "Mini PC", "other")
    with pytest.raises(machines.UnknownMachine) as exc:
        await machines.GatewayPlant().paired_device(None, "mini_pc")
    said = str(exc.value)
    assert said.startswith("cannot: ") and "'mini_pc'" in said
    assert "more than one paired" in said
    assert "Beelink Mini S" in said and "Mini PC" in said
    with pytest.raises(machines.UnknownMachine) as exc:
        await machines.GatewayPlant().update_agent(None, "mini_pc", requested_by="nova")
    assert "more than one paired" in str(exc.value)
    assert "Beelink Mini S" in str(exc.value) and "Mini PC" in str(exc.value)


@requires_db
async def test_t2_an_exact_name_wins_over_a_looser_match(pool):
    await _row(pool, "mini-pc", "box")
    await _row(pool, "Beelink Mini S", "Mini-PC")
    assert (await machines.GatewayPlant().paired_device(None, "mini-pc"))["name"] == "mini-pc"
    # An exact hostname wins over a loose name too.
    assert (await machines.GatewayPlant().paired_device(None, "Mini-PC"))[
        "name"
    ] == "Beelink Mini S"


@requires_db
async def test_t2_an_unknown_name_keeps_the_listing_error(pool):
    await _row(pool, "Beelink Mini S", "mini-pc")
    await _row(pool, "DELL-XPS-8950", "dell")
    with pytest.raises(machines.UnknownMachine) as exc:
        await machines.GatewayPlant().update_agent(None, "laptop", requested_by="nova")
    assert str(exc.value) == (
        "cannot: no paired machine named 'laptop' — the paired machines are: "
        "Beelink Mini S, DELL-XPS-8950"
    )
    with pytest.raises(machines.UnknownMachine) as exc:
        await machines.GatewayPlant().paired_device(None, "laptop")
    assert str(exc.value).startswith(
        "cannot: no paired device named 'laptop' — the paired devices are: "
        "Beelink Mini S, DELL-XPS-8950;"
    )


async def test_t2_a_replay_resolves_a_declared_hostname_variant_the_same_way():
    plant = machines.FixturePlant(
        {},
        devices={
            "eval_mini": {"name": "eval_mini", "hostname": "mini-pc", "agent_version": None},
            "eval_dell": {"name": "eval_dell", "hostname": "dell", "agent_version": None},
        },
    )
    out = await plant.update_agent(None, "Mini PC", requested_by="nova")
    assert out["machine"] == "eval_mini"
    with pytest.raises(machines.UnknownMachine) as exc:
        await plant.update_agent(None, "laptop", requested_by="nova")
    assert str(exc.value) == (
        "cannot: no paired machine named 'laptop' — the paired machines are: eval_mini, eval_dell"
    )


@requires_db
async def test_t2_setup_and_timers_resolve_the_same_way(pool):
    from app.tools import setup, timers

    await _row(pool, "Beelink Mini S", "mini-pc")
    assert (await setup._paired_machine(None, "mini pc"))["name"] == "Beelink Mini S"
    assert await timers._paired_device_or_refuse(None, "MINI_PC") == "Beelink Mini S"


# -- walk-fixes T2b: a machine named by one whole token of its name/hostname --
#
# VERIFY T2's note: "dell" / "the dell" resolved to nothing although exactly
# one paired machine, DELL-XPS-8950, carries the token "dell". A LAST tier:
# the name (minus a leading "the ") equals one whole token (split on space,
# hyphen, underscore; casefold) of exactly one machine's name or hostname.

_T2B_LIVE = [("Beelink Mini S", "mini-pc"), ("DELL-XPS-8950", "DELL-XPS-8950")]


@pytest.mark.parametrize("asked", ["dell", "the dell", "Dell", "The Dell", "xps", "8950"])
def test_t2b_one_whole_token_names_the_dell(asked):
    assert machines.resolve_name(asked, _T2B_LIVE) == "DELL-XPS-8950"


@pytest.mark.parametrize("asked", ["beelink", "Beelink", "the beelink", "mini"])
def test_t2b_one_whole_token_names_the_beelink(asked):
    assert machines.resolve_name(asked, _T2B_LIVE) == "Beelink Mini S"


def test_t2b_a_token_two_machines_share_is_a_cannot_naming_both():
    known = [*_T2B_LIVE, ("Dell Laptop", "dell-laptop")]
    with pytest.raises(machines.UnknownMachine) as exc:
        machines.resolve_name("the dell", known)
    said = str(exc.value)
    assert said.startswith("cannot: ") and "more than one paired" in said
    assert "DELL-XPS-8950" in said and "Dell Laptop" in said


@pytest.mark.parametrize("asked", ["del", "dell-x", "pc mini", "the", ""])
def test_t2b_a_part_of_a_token_names_nothing(asked):
    assert machines.resolve_name(asked, _T2B_LIVE) is None


def test_t2b_earlier_tiers_still_win():
    # an exact name "dell" wins over the token of DELL-XPS-8950
    known = [*_T2B_LIVE, ("dell", "box")]
    assert machines.resolve_name("dell", known) == "dell"
    # a loose full match wins over a token match on another machine
    known = [*_T2B_LIVE, ("Dell PC", "dell-pc")]
    assert machines.resolve_name("dell_pc", known) == "Dell PC"


@requires_db
async def test_t2b_the_device_tools_and_machine_update_resolve_the_dell(pool):
    await _row(pool, "Beelink Mini S", "mini-pc")
    await _row(pool, "DELL-XPS-8950", "DELL-XPS-8950")
    assert (await machines.GatewayPlant().paired_device(None, "the dell"))[
        "name"
    ] == "DELL-XPS-8950"
    with pytest.raises(machines.UnknownMachine) as exc:
        await machines.GatewayPlant().paired_device(None, "del")
    assert str(exc.value).startswith(
        "cannot: no paired device named 'del' — the paired devices are: "
        "Beelink Mini S, DELL-XPS-8950;"
    )
