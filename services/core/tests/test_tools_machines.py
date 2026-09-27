"""S40 — her machines: where models run, and the one switch on each.

Both tools read and write through app/machines.py against the fake gateway's
/admin/engines — the same fixture the Settings tile's API is pinned on, so
what she says and what the page shows cannot come from two readings."""

from __future__ import annotations

import inspect
import uuid
from datetime import UTC, datetime

import httpx
import pytest

from app import chat, device_facts, machines, tools
from app.identity import Person
from app.main import app as core_app
from app.tools.base import ToolFailure
from tests import fakes
from tests.fakes import FakeGateway

AT = datetime(2026, 9, 26, 10, 0, tzinfo=UTC)
WINDOWS = {
    "v": 2,
    "agent": {"version": "0.2.0", "mode": "foreground", "session_interactive": True},
    "os": {
        "goos": "windows",
        "arch": "amd64",
        "version": "Windows 11 Pro 24H2 (build 26100)",
        "wsl": None,
    },
    "hostname": "PC-ONE",
    "machine_uid": "a" * 64,
}
WSL = {
    **WINDOWS,
    "agent": {**WINDOWS["agent"], "mode": "systemd-user"},
    "os": {
        "goos": "linux",
        "arch": "amd64",
        "version": "Ubuntu 26.04 LTS",
        "wsl": {"distro": "Ubuntu-26.04"},
    },
    "machine_uid": "b" * 64,
}


def _view(name, platform, facts, *, connected=True, hostname="PC-ONE"):
    return device_facts.agent_view(
        name=name,
        platform=platform,
        hostname=hostname,
        connected=connected,
        last_seen=AT,
        facts=facts,
        facts_at=AT if facts else None,
    )


class _AgentsPlant(machines.GatewayPlant):
    """The real gateway reader, with Nova's agents answered from a list — so
    these DB-free tests never open a database for the agents half."""

    def __init__(self, agents=None, error: Exception | None = None) -> None:
        self._agents, self._error = list(agents or []), error

    async def agents(self, app):
        if self._error is not None:
            raise self._error
        return [dict(a) for a in self._agents]


@pytest.fixture(autouse=True)
def _plant():
    """Every test here runs with no agents paired unless it installs its own."""
    token = machines.PLANT.set(_AgentsPlant())
    yield lambda **kw: machines.PLANT.set(_AgentsPlant(**kw))
    machines.PLANT.reset(token)


def _owner() -> Person:
    return Person(id=uuid.uuid4(), name="jeremy", role="owner")


class _Dead(httpx.AsyncBaseTransport):
    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("connection refused", request=request)


async def _call(name: str, args: dict, sink: list | None = None) -> str:
    ctx = tools.context_for(core_app, _owner(), facts_sink=sink)
    return await tools.REGISTRY[name].executor(args, ctx)


async def test_status_reads_every_machine_live_and_leaves_a_fact_for_each(mount_peers):
    gateway = FakeGateway(
        engines=[fakes.engine_view(tags={"qwen3.8:27b": 17_817_600_000, "qwen3:8b": 5_225_388_164})]
    )
    mount_peers(gateway=gateway)
    sink: list[dict] = []
    said = await _call("machine_status", {}, sink)
    assert gateway.queries[-1] == b"live=true"
    assert f"hub: answering (checked now, {fakes.ENGINE_AT})" in said
    assert "serving is on" in said and "always on" in said
    assert f"computes on {fakes.ENGINE_GPU}" in said and "runtime container" in said
    assert "qwen3.8:27b (16.6 GB)" in said and "qwen3:8b (4.9 GB)" in said
    # (S40 fix wave B4) The header states the true rule, never the false one
    # — and the {first}:<model> example follows the QUALIFIED clause it
    # illustrates, never the bare-id clause, so a filtered machine's header
    # never reads as though it were the default (S40 fix wave: example
    # placement).
    assert HEADER_RULE in said.replace("A model id", "a model id")
    assert FALSE_RULE not in said
    assert sink == [
        {"machine": "hub", "answering": True, "checked_now": True, "at": fakes.ENGINE_AT}
    ]


async def test_status_header_names_no_real_model_as_its_id_rule_example(mount_peers):
    """(S40 text fix, 2026-09-19) A real installed model's name used as the
    ID-rule example reads as a fact, not an illustration — the local 8B
    model told the owner 'qwen3.8:27b (Current model in use)' from this
    header alone (turn b851aa91). This fixture's engine lists only qwen3:8b
    (fakes.engine_view's default), so 'qwen3.8:27b' surfacing in the header
    could only be the example text, never read data — and it must not."""
    gateway = FakeGateway(engines=[fakes.engine_view()])
    mount_peers(gateway=gateway)
    said = await _call("machine_status", {})
    assert "qwen3.8:27b" not in said


async def test_a_machine_that_did_not_answer_is_said_in_the_gateways_words(mount_peers):
    view = fakes.engine_view(
        state="unreachable", reason="ConnectError: connection refused", tags=None
    )
    mount_peers(gateway=FakeGateway(engines=[view]))
    sink: list[dict] = []
    said = await _call("machine_status", {}, sink)
    assert "hub: NOT answering" in said and "ConnectError: connection refused" in said
    assert "what is installed could not be read" in said
    assert sink[0]["answering"] is False and sink[0]["checked_now"] is True


async def test_a_switched_off_machine_says_routing_skips_it(mount_peers):
    view = fakes.engine_view(serving=False, state="switched_off")
    mount_peers(gateway=FakeGateway(engines=[view]))
    sink: list[dict] = []
    said = await _call("machine_status", {}, sink)
    assert "hub: switched off for models, so routing skips it" in said
    assert "serving is off" in said
    assert sink[0]["answering"] is True  # its installed list came back


async def test_a_machine_the_gateway_did_not_contact_is_never_called_answering(mount_peers):
    view = fakes.engine_view(
        "dell",
        lifecycle="wake_on_lan",
        state="unobserved",
        observed_at=None,
        tags=None,
        reason="dell sleeps until woken — not contacted",
    )
    mount_peers(gateway=FakeGateway(engines=[view]))
    sink: list[dict] = []
    said = await _call("machine_status", {}, sink)
    assert "dell: not checked now — dell sleeps until woken — not contacted" in said
    assert "lifecycle wake_on_lan" in said
    assert sink[0]["machine"] == "dell"
    assert sink[0]["answering"] is None and sink[0]["checked_now"] is False


async def test_one_machine_by_name_and_an_unlisted_name_is_a_stated_failure(mount_peers):
    mount_peers(gateway=FakeGateway(engines=[fakes.engine_view(), fakes.engine_view("box")]))
    said = await _call("machine_status", {"machine": "box"})
    assert "box: answering" in said and "hub: answering" not in said
    # S42a: the refusal now also states Nova's agents (none, in this test's
    # DB-free autouse plant) beside the gateway's engines.
    with pytest.raises(
        ToolFailure,
        match="no machine named 'dell' runs models or Nova's agent — the gateway lists: "
        "hub, box; Nova's agents: none",
    ):
        await _call("machine_status", {"machine": "dell"})


async def test_a_gateway_that_cannot_be_asked_is_a_failure_never_no_machines(mount_peers):
    mount_peers(gateway=FakeGateway(engines=[]))
    core_app.state.peer_transports[fakes.GATEWAY_URL] = _Dead()
    sink: list[dict] = []
    with pytest.raises(
        ToolFailure,
        match="could not ask the gateway where models run — the gateway could not be reached",
    ):
        await _call("machine_status", {}, sink)
    assert sink == []  # nothing was established, so nothing is recorded


async def test_configure_switches_off_and_says_the_value_it_read_back(mount_peers):
    gateway = FakeGateway(engines=[fakes.engine_view()])
    mount_peers(gateway=gateway)
    said = await _call("machine_configure", {"machine": "hub", "serving": False})
    assert said.startswith(
        "hub is switched off for models: serving read back as false (state switched_off)"
    )
    assert gateway.seen[-2:] == [
        ("/admin/engines/hub", {"serving": False}),
        ("/admin/engines/hub", None),
    ]
    back_on = await _call("machine_configure", {"machine": "hub", "serving": True})
    assert back_on.startswith("hub is switched on for models: serving read back as true")


async def test_a_switch_that_does_not_read_back_is_a_failure_nothing_called_changed(
    mount_peers,
):
    mount_peers(gateway=FakeGateway(engines=[fakes.engine_view()], engine_put_sticks=False))
    with pytest.raises(
        ToolFailure,
        match=r"did not read back as off \(it reads True\) — nothing is confirmed changed",
    ):
        await _call("machine_configure", {"machine": "hub", "serving": False})


async def test_an_unknown_machine_is_refused_in_the_gateways_words(mount_peers):
    mount_peers(gateway=FakeGateway(engines=[fakes.engine_view()]))
    with pytest.raises(
        ToolFailure, match="no machine named 'dell' runs models — no engine named 'dell'"
    ):
        await _call("machine_configure", {"machine": "dell", "serving": False})


async def test_a_call_that_does_not_fit_the_schema_moves_nothing(mount_peers):
    gateway = FakeGateway(engines=[fakes.engine_view()])
    mount_peers(gateway=gateway)
    ctx = tools.context_for(core_app, _owner())
    result, ok = await tools.dispatch("machine_configure", '{"machine": "hub"}', ctx)
    assert not ok and result.startswith("Error: ")
    result, ok = await tools.dispatch(
        "machine_configure", '{"machine": "hub", "serving": "no"}', ctx
    )
    assert not ok
    assert gateway.seen == []


def test_the_tools_say_which_side_they_are_on():
    status, configure = tools.REGISTRY["machine_status"], tools.REGISTRY["machine_configure"]
    assert status.reads_only is True and status.ephemeral is True
    assert status.result_kind == tools.RESULT_KIND_LISTING
    assert configure.reads_only is False and configure.ephemeral is False
    assert configure.parameters["required"] == ["machine", "serving"]
    assert configure.parameters["properties"]["serving"]["type"] == "boolean"


async def test_an_eval_machine_is_switched_in_the_fixture_never_at_the_gateway(mount_peers):
    gateway = FakeGateway(engines=[fakes.engine_view()])
    mount_peers(gateway=gateway)
    token = machines.PLANT.set(machines.FixturePlant({"eval_box": {}}))
    try:
        sink: list[dict] = []
        said = await _call("machine_status", {}, sink)
        assert "hub: answering" in said and "eval_box: answering" in said
        assert [fact["machine"] for fact in sink] == ["hub", "eval_box"]
        back = await _call("machine_configure", {"machine": "eval_box", "serving": False})
        assert "serving read back as false" in back
        # Ruling C8: a real machine is never written from inside an eval.
        with pytest.raises(machines.PlantUnavailable, match="cannot"):
            await machines.plant().set_serving(core_app, "hub", False)
        with pytest.raises(
            ToolFailure,
            match="hub's switch is not confirmed set — cannot: 'hub' is not one of the "
            "machines that can be switched here",
        ):
            await _call("machine_configure", {"machine": "hub", "serving": False})
        assert not any(path.startswith("/admin/engines/") for path, _ in gateway.seen)
    finally:
        machines.PLANT.reset(token)


# The TRUE rule (S40 fix wave B4): "a model id names its machine before its
# first colon" was false for a bare id, whose first colon is its tag's own
# (the live chat.vision_model qwen3.8:27b names no machine called qwen3.8).
# The qualified form names its machine; a bare one means the default machine.
TRUE_RULE = (
    "a model id qualified with a machine's name (machine:model) names that machine; "
    "a bare id, whose own colon is its tag (<name>:<tag>), means the default machine"
)
FALSE_RULE = "names its machine before its first colon"

# The live machine_status header interleaves the {first}:<model> example
# INTO the true rule, after the clause it illustrates ("names that machine")
# rather than after the unrelated bare-id clause — so filtering on one
# machine never reads as though that machine were the default (S40 fix wave:
# example placement, following a mismatch between the fixed no-machine case
# above and a `machine="dell"` filtered call).
HEADER_RULE = (
    "a model id qualified with a machine's name (machine:model) names that machine "
    "(hub:<model> runs on hub); a bare id, whose own colon is its tag (<name>:<tag>), "
    "means the default machine"
)


def test_the_prompt_says_where_models_run_from_the_tools_own_names():
    prompt = chat.stable_system_prompt("m", tools.tool_names())
    assert TRUE_RULE in prompt.replace("A model id", "a model id")
    assert FALSE_RULE not in prompt
    assert "qwen3.8:27b" not in prompt  # no real model as the ID-rule example
    assert "only from machine_status" in prompt
    assert "only with machine_configure, reporting the value it read back" in prompt
    assert "names that machine" not in chat.stable_system_prompt("m", ("get_time",))
    only_status = chat.stable_system_prompt("m", ("machine_status",))
    assert "only from machine_status" in only_status and "machine_configure" not in only_status
    source = inspect.getsource(chat.stable_system_prompt)
    assert '"machine_status"' not in source and '"machine_configure"' not in source


def test_machine_status_describes_the_true_rule_for_ids():
    """(S40 fix wave B4) Her tool's own description is read on every turn."""
    description = tools.REGISTRY["machine_status"].description
    assert TRUE_RULE in description.replace("A model id", "a model id")
    assert FALSE_RULE not in description


# -- S42a: Nova's agents, grouped by machine, alongside the gateway's engines --


async def test_status_lists_nova_agents_grouped_by_machine_with_a_fact_each(mount_peers, _plant):
    mount_peers(gateway=FakeGateway(engines=[fakes.engine_view()]))
    _plant(agents=[_view("PC-ONE", "windows", WINDOWS), _view("pc-wsl", "linux", WSL)])
    sink: list[dict] = []
    said = await _call("machine_status", {}, sink)
    assert "Nova's agents, by machine — 2 machine(s)" in said
    assert "agent PC-ONE (Windows 11 Pro 24H2 (build 26100); agent 0.2.0): connected now" in said
    assert "hands: available (connected now)" in said
    assert "agent pc-wsl (Ubuntu 26.04 LTS, inside WSL Ubuntu-26.04; agent 0.2.0)" in said
    assert "hands: cannot: this machine's Windows agent owns it" in said
    assert {"device": "PC-ONE", "connected": True} in sink
    assert {"device": "pc-wsl", "connected": True} in sink


async def test_two_agents_reporting_one_machine_are_said_to_be_one_too_many(mount_peers, _plant):
    mount_peers(gateway=FakeGateway(engines=[fakes.engine_view()]))
    _plant(agents=[_view("pc-a", "windows", WINDOWS), _view("pc-b", "windows", WINDOWS)])
    said = await _call("machine_status", {})
    assert "2 Nova agents report this one machine (pc-a, pc-b)" in said


async def test_status_lists_an_agent_that_sends_no_facts(mount_peers, _plant):
    mount_peers(gateway=FakeGateway(engines=[fakes.engine_view()]))
    _plant(agents=[_view("old-wsl", "linux", None)])
    said = await _call("machine_status", {})
    assert "agent old-wsl (linux): connected now; hands: available (connected now)" in said
    assert "facts: unknown — this agent sends no facts — it predates S42a" in said


async def test_agents_that_cannot_be_read_are_said_and_the_engines_still_answer(
    mount_peers, _plant
):
    mount_peers(gateway=FakeGateway(engines=[fakes.engine_view()]))
    _plant(error=RuntimeError("the database is gone"))
    sink: list[dict] = []
    said = await _call("machine_status", {}, sink)
    assert "hub: answering" in said
    assert "Nova's agents could not be read — RuntimeError: the database is gone." in said
    assert not any("device" in fact for fact in sink)  # nothing claims a device was checked


async def test_a_machine_filter_matches_an_agent_by_name_or_hostname(mount_peers, _plant):
    mount_peers(gateway=FakeGateway(engines=[fakes.engine_view()]))
    _plant(agents=[_view("PC-ONE", "windows", WINDOWS)])
    said = await _call("machine_status", {"machine": "pc-one"})
    assert "agent PC-ONE" in said and "hub:" not in said
    with pytest.raises(ToolFailure) as exc:
        await _call("machine_status", {"machine": "nope"})
    assert "Nova's agents: PC-ONE" in str(exc.value)


async def test_no_agent_paired_is_said(mount_peers):
    mount_peers(gateway=FakeGateway(engines=[fakes.engine_view()]))
    said = await _call("machine_status", {})
    assert "No Nova agent is paired to any machine." in said
