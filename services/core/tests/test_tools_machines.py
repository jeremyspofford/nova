"""S40 — her machines: where models run, and the one switch on each.

Both tools read and write through app/machines.py against the fake gateway's
/admin/engines — the same fixture the Settings tile's API is pinned on, so
what she says and what the page shows cannot come from two readings."""

from __future__ import annotations

import copy
import inspect
import uuid
from datetime import UTC, datetime
from types import SimpleNamespace

import httpx
import pytest

from app import chat, device_facts, guards, live_facts, machines, tools
from app.identity import Person
from app.main import app as core_app
from app.tools import machines as machines_tool
from app.tools.base import ToolFailure
from tests import fakes
from tests.fakes import FakeGateway
from tests.test_live_facts import _Turn

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


async def test_an_eval_machine_is_switched_in_the_fixture_never_at_the_gateway(
    mount_peers, monkeypatch
):
    # Fix round 1 (folded in): this test predates the DB-free `_AgentsPlant`
    # (it builds a real FixturePlant directly), and used to reach
    # GatewayPlant.agents -> db.get_pool() by accident, only "working"
    # because DATABASE_URL happens to be unset for a test that skips the
    # `pool` fixture. Stub the real half explicitly so this stays true
    # regardless of the environment.
    async def no_real_agents(self, app):
        return []

    monkeypatch.setattr(machines.GatewayPlant, "agents", no_real_agents)
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


async def test_an_offline_agent_says_so_and_records_connected_false(mount_peers, _plant):
    """Fix round 1 (folded in): `_view` defaults to connected=True in every
    other test here — exercise the offline branch of _describe_agent and its
    fact explicitly."""
    mount_peers(gateway=FakeGateway(engines=[fakes.engine_view()]))
    _plant(agents=[_view("PC-ONE", "windows", WINDOWS, connected=False)])
    sink: list[dict] = []
    said = await _call("machine_status", {}, sink)
    assert f"offline (last seen {AT.isoformat()})" in said
    assert "hands: cannot: not connected" in said
    assert {"device": "PC-ONE", "connected": False} in sink


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


async def test_a_filtered_status_with_unreadable_agents_never_says_none_or_asserts_absence(
    mount_peers, _plant
):
    """Fix round 1 (Important 1). Demonstrated bug: filtering by a name no
    engine has, with agents unreadable, used to fold the read failure into
    "Nova's agents: none" and "runs models or Nova's agent" — an outage
    silently became "no such agent exists". The read failure must be STATED,
    never turned into evidence of absence."""
    mount_peers(gateway=FakeGateway(engines=[fakes.engine_view()]))
    _plant(error=RuntimeError("the database is gone"))
    sink: list[dict] = []
    with pytest.raises(ToolFailure) as exc:
        await _call("machine_status", {"machine": "pc-one"}, sink)
    message = str(exc.value)
    assert "Nova's agents: none" not in message
    assert "or Nova's agent" not in message
    assert "no machine named 'pc-one' runs models — the gateway lists: hub" in message
    assert "Nova's agents could not be read — RuntimeError: the database is gone" in message
    assert sink == []
    # An engine that DOES match still answers; the read failure is stated
    # beside it, never hidden by the name filter.
    said = await _call("machine_status", {"machine": "hub"})
    assert "hub: answering" in said
    assert "Nova's agents could not be read — RuntimeError: the database is gone." in said


async def test_a_machine_filter_matches_an_agent_by_name_or_hostname(mount_peers, _plant):
    mount_peers(gateway=FakeGateway(engines=[fakes.engine_view()]))
    _plant(agents=[_view("PC-ONE", "windows", WINDOWS)])
    said = await _call("machine_status", {"machine": "pc-one"})
    assert "agent PC-ONE" in said and "hub:" not in said
    with pytest.raises(ToolFailure) as exc:
        await _call("machine_status", {"machine": "nope"})
    assert "Nova's agents: PC-ONE" in str(exc.value)


async def test_a_machine_filter_matches_an_agent_by_hostname_alone(mount_peers, _plant):
    """Fix round 1 (folded in): every other filter test here names an agent
    whose `name` and `hostname` happen to be equal (both "PC-ONE"), so a
    matcher that checked only `name` would pass them too. Give the agent a
    DIFFERENT name and filter on the hostname alone."""
    mount_peers(gateway=FakeGateway(engines=[fakes.engine_view()]))
    _plant(agents=[_view("dell-agent", "windows", WINDOWS, hostname="DESKTOP-7XQ2")])
    said = await _call("machine_status", {"machine": "desktop-7xq2"})
    assert "agent dell-agent" in said


async def test_no_agent_paired_is_said(mount_peers):
    mount_peers(gateway=FakeGateway(engines=[fakes.engine_view()]))
    said = await _call("machine_status", {})
    assert "No Nova agent is paired to any machine." in said


# -- S42a final review I2: a live check backs only the agent lines she was shown --
#
# live_facts hands her the first MAX_RESULT_CHARS of a check's result, but
# machine_status records {"device", "connected"} for EVERY agent it lists, after
# the engines — and the state guard reads any such fact on an ok span as "she
# looked" (guards._checked_a_device). One engine with three models pushed both
# agent lines past the cut: the span said the dell had been read (offline)
# while she was shown no agent line at all, and "The dell is online right now."
# stood uncorrected. A live check now keeps an agent's fact only when that
# agent's whole line was shown (Tool.device_line_shown, live_facts._shown_facts).

LAPTOP = {
    **WINDOWS,
    "agent": {**WINDOWS["agent"], "mode": "systemd-user"},
    "os": {"goos": "linux", "arch": "amd64", "version": "Ubuntu 26.04 LTS", "wsl": None},
    "hostname": "laptop",
    "machine_uid": "c" * 64,
}
THREE_MODELS = {
    "qwen3.8:27b": 17_817_600_000,
    "qwen3:8b": 5_225_388_164,
    "qwen3:4b": 2_600_000_000,
}
HUB_FACT = {"machine": "hub", "answering": True, "checked_now": True, "at": fakes.ENGINE_AT}
AGENT_NAMES = ["dell", "laptop"]


def _dell_and_laptop(_plant, *, laptop_first: bool = False) -> None:
    dell = _view("dell", "windows", WINDOWS, connected=False, hostname="DELL")
    laptop = _view("laptop", "linux", LAPTOP, hostname="laptop")
    _plant(agents=[laptop, dell] if laptop_first else [dell, laptop])


async def _unasked_status() -> tuple[live_facts.Checked, _Turn, list[dict]]:
    """machine_status run the way a recalled note runs it: unasked, by live_facts,
    on a turn's own facts sink."""
    turn, sink = _Turn(), []
    ctx = tools.context_for(core_app, _owner(), facts_sink=sink)
    call = live_facts.LiveCall(tool="machine_status", args={}, note="machines")
    (check,) = await live_facts.run([call], turn, ctx)
    return check, turn, sink


async def test_an_unasked_status_records_no_fact_for_an_agent_line_it_cut_off(mount_peers, _plant):
    """The final review's reproduction, with real code. Every agent line starts
    past the cut, so no agent fact is kept — the engine's is — and the state
    guard fires on a claim that nothing she was shown checked."""
    mount_peers(gateway=FakeGateway(engines=[fakes.engine_view(tags=THREE_MODELS)]))
    _dell_and_laptop(_plant)
    full = (await _call("machine_status", {})).strip()
    # The premise, measured rather than assumed: the first agent line starts
    # past the cut.
    assert full.index("\n  agent ") >= live_facts.MAX_RESULT_CHARS
    check, turn, sink = await _unasked_status()
    assert check.ok
    assert "agent dell" not in check.result and "agent laptop" not in check.result
    (span,) = turn.spans
    assert span.meta["facts"] == [HUB_FACT]
    assert sink == [HUB_FACT]
    claim = guards.state_claim_check("The dell is online right now.", turn.spans, AGENT_NAMES)
    assert claim is not None and "dell" in claim.phrase.lower()


async def test_an_unasked_status_keeps_the_fact_of_an_agent_line_it_showed(
    mount_peers, _plant, monkeypatch
):
    """The laptop's whole line is shown and the dell's is cut just after its
    head: "agent dell (" is in what she read, the dell's state is not. Only the
    laptop's fact is kept, beside the engine's, and it backs her honest report
    of the laptop."""
    mount_peers(gateway=FakeGateway(engines=[fakes.engine_view(tags=THREE_MODELS)]))
    _dell_and_laptop(_plant, laptop_first=True)
    full = (await _call("machine_status", {})).strip()
    cut = full.index("  agent dell (") + len("  agent dell (Windows")
    monkeypatch.setattr(live_facts, "MAX_RESULT_CHARS", cut)
    check, turn, sink = await _unasked_status()
    assert check.ok
    assert "agent laptop (Ubuntu 26.04 LTS; agent 0.2.0): connected now" in check.result
    assert "agent dell (" in check.result and "offline (last seen" not in check.result
    (span,) = turn.spans
    assert span.meta["facts"] == [HUB_FACT, {"device": "laptop", "connected": True}]
    assert sink == span.meta["facts"]
    honest = "The laptop is online right now."
    # Unbacked, it fires; backed by the laptop line she was shown, it does not.
    assert guards.state_claim_check(honest, [], AGENT_NAMES) is not None
    assert guards.state_claim_check(honest, turn.spans, AGENT_NAMES) is None


async def test_an_unasked_status_shown_whole_keeps_every_agent_fact(
    mount_peers, _plant, monkeypatch
):
    """Nothing cut, nothing withheld: the filter reads only a result she was
    not handed whole."""
    mount_peers(gateway=FakeGateway(engines=[fakes.engine_view(tags=THREE_MODELS)]))
    _dell_and_laptop(_plant)
    monkeypatch.setattr(live_facts, "MAX_RESULT_CHARS", 10_000)
    check, turn, _sink = await _unasked_status()
    assert "[…cut off" not in check.result
    (span,) = turn.spans
    assert span.meta["facts"] == [
        HUB_FACT,
        {"device": "dell", "connected": False},
        {"device": "laptop", "connected": True},
    ]


async def test_every_agent_line_the_status_writes_is_read_back_whole(mount_peers, _plant):
    """device_line_shown reads the format _describe_agents writes. If the two
    drift apart, every cut check drops its agent facts without a word (it fails
    closed), so they are pinned together here: each agent's whole line is
    found, shown up to its last character, and not shown one character short."""
    mount_peers(gateway=FakeGateway(engines=[fakes.engine_view(tags=THREE_MODELS)]))
    _plant(
        agents=[
            _view("pc-a", "windows", WINDOWS),
            _view("pc-b", "windows", WINDOWS),
            _view("laptop", "linux", LAPTOP, hostname="laptop"),
            _view("old-wsl", "linux", None, hostname="old"),
        ]
    )
    full = (await _call("machine_status", {})).strip()
    assert "2 Nova agents report this one machine (pc-a, pc-b)" in full
    for name in ("pc-a", "pc-b", "laptop", "old-wsl"):
        start = full.index(f"\n  agent {name} (") + 1
        end = full.find("\n", start)
        end = len(full) if end == -1 else end
        assert machines_tool.device_line_shown(name, full, len(full)), name
        assert machines_tool.device_line_shown(name, full, end), name
        assert not machines_tool.device_line_shown(name, full, end - 1), name


def _listing(*agents: dict) -> str:
    """The agents section exactly as machine_status writes it."""
    ctx = tools.context_for(core_app, _owner())
    return "\n".join(machines_tool._describe_agents(list(agents), None, ctx, filtered=False))


def test_a_device_line_is_read_by_its_format_never_by_the_name_anywhere():
    # Named in a machine's header, its own line cut off: not shown.
    two = _listing(_view("dell", "windows", WINDOWS), _view("laptop", "windows", WINDOWS))
    assert "2 Nova agents report this one machine (dell, laptop)" in two
    laptop_line = two.index("\n  agent laptop (") + 1
    assert machines_tool.device_line_shown("dell", two, laptop_line)
    assert not machines_tool.device_line_shown("laptop", two, laptop_line)
    # Not listed at all: nothing to confirm.
    assert not machines_tool.device_line_shown("pc-nine", two, len(two))


def test_a_line_that_could_be_another_agents_is_not_confirmed_shown():
    """The head of "dell"'s line also begins the line of an agent named "dell
    (old)". While both lines are shown either answer is safe; once one is cut,
    "dell" cannot be told apart from it, so it is not confirmed (fail closed)."""
    both = _listing(
        _view("dell (old)", "windows", WINDOWS, hostname="OLD"),
        _view("dell", "windows", {**WINDOWS, "machine_uid": "d" * 64}, hostname="NEW"),
    )
    assert machines_tool.device_line_shown("dell", both, len(both))
    assert machines_tool.device_line_shown("dell (old)", both, len(both))
    second = both.index("\n  agent dell (Windows") + 1
    assert machines_tool.device_line_shown("dell (old)", both, second)
    assert not machines_tool.device_line_shown("dell", both, second)


def test_a_line_that_runs_on_past_a_newline_is_not_confirmed_shown():
    """A line broken by a newline this format never writes cannot be confirmed
    whole, so it fails closed even when the whole listing was shown. Task 32
    (MF1): agent_view now shows what the agent reported on one line, so the
    newline is put in after it, as device_list's twin of this test does — this
    pins the reader's own rule, the second line of defence."""
    agent = _view("pc-one", "windows", WINDOWS)
    agent["os"] = "Windows 11\nPro"
    listing = _listing(agent)
    assert "\nPro; agent 0.2.0): connected now" in listing
    assert not machines_tool.device_line_shown("pc-one", listing, len(listing))


# -- Task 32, MF1: what an agent reported stays on its own line ---------------
#
# validate_auth holds os.version, the host name, agent.version and the WSL
# distribution to "text, no NUL" — refusing the whole auth frame over one byte
# would cost her every fact on it — so a reported "\n  - machine evil:" reached
# device_list's and machine_status's lines whole and printed a line of its own
# under them. agent_view shows each through device_facts._sanitized_line.

_EVIL = "\n  - machine evil:"
_EVIL_SHOWN = "  - machine evil:"  # the same text with its line break taken out


class _ListingPlant(_AgentsPlant):
    """Agents from a list and no revoked agent knocking: device_list reads
    both, and neither opens a database here."""

    async def knocks(self, app):
        return []


def _reported(field: str, value: str) -> tuple[str, dict]:
    """(platform, auth facts) with `value` in `field`, as validate_auth keeps
    them — it accepts every one: the frame is never refused for it."""
    facts = copy.deepcopy(WSL if field == "distro" else WINDOWS)
    if field == "os.version":
        facts["os"]["version"] = value
    elif field == "agent.version":
        facts["agent"]["version"] = value
    elif field == "distro":
        facts["os"]["wsl"]["distro"] = value
    elif field == "hostname":
        facts["hostname"] = value
    return ("linux" if field == "distro" else "windows"), device_facts.validate_auth(facts)


async def _both_listings(*agents: dict) -> dict[str, str]:
    """device_list's and machine_status's whole results over `agents`."""
    token = machines.PLANT.set(_ListingPlant(agents=list(agents)))
    try:
        return {tool: await _call(tool, {}) for tool in ("device_list", "machine_status")}
    finally:
        machines.PLANT.reset(token)


def _line_with(result: str, head: str) -> str:
    (line,) = [line for line in result.split("\n") if line.startswith(head)]
    return line


@pytest.mark.parametrize("field", ["os.version", "hostname", "agent.version", "distro"])
async def test_a_reported_line_break_never_prints_a_line_of_its_own(field, mount_peers):
    mount_peers(gateway=FakeGateway(engines=[fakes.engine_view()]))
    platform, facts = _reported(field, f"crafted{_EVIL}")
    # The listing's host name is the device row's, which enroll holds to one
    # line since Task 26; a row from before then, or a declared eval device,
    # never was — and the agent's own facts.hostname carries it too.
    hostname = f"PC-ONE{_EVIL}" if field == "hostname" else "PC-ONE"
    results = await _both_listings(_view("pc-one", platform, facts, hostname=hostname))
    for tool, result in results.items():
        assert _EVIL not in result, (tool, result)
        assert not any(line.startswith(_EVIL_SHOWN) for line in result.split("\n")), tool
        # Its whole line reads back, so a check cut after it keeps its fact.
        assert tools.REGISTRY[tool].device_line_shown("pc-one", result, len(result)), tool
    if field == "hostname":
        # device_list writes no host name; machine_status writes it on the
        # machine's own line.
        assert "PC-ONE" not in results["device_list"]
        assert _line_with(results["machine_status"], "- machine PC-ONE") == (
            f"- machine PC-ONE{_EVIL_SHOWN}:"
        )
    else:
        assert f"crafted{_EVIL_SHOWN}" in _line_with(results["device_list"], "- pc-one (")
        assert f"crafted{_EVIL_SHOWN}" in _line_with(results["machine_status"], "  agent pc-one (")


async def test_a_legitimate_reported_value_is_shown_unchanged(mount_peers):
    mount_peers(gateway=FakeGateway(engines=[fakes.engine_view()]))
    windows = copy.deepcopy(WINDOWS)
    windows["os"]["version"] = "Windows 11 Pro 24H2 (build 26100.4061)"
    windows["agent"]["version"] = "0.4.2-dev+abc123"
    wsl = copy.deepcopy(WSL)
    wsl["os"]["wsl"]["distro"] = "Ubuntu-24.04"
    pc = _view("pc-one", "windows", device_facts.validate_auth(windows), hostname="DESKTOP-7XQ2")
    twin = _view("pc-wsl", "linux", device_facts.validate_auth(wsl), hostname="DESKTOP-7XQ2")
    assert (pc["os"], pc["agent_version"], twin["wsl"], pc["hostname"]) == (
        "Windows 11 Pro 24H2 (build 26100.4061)",
        "0.4.2-dev+abc123",
        "Ubuntu-24.04",
        "DESKTOP-7XQ2",
    )
    results = await _both_listings(pc, twin)
    assert _line_with(results["device_list"], "- pc-one (").startswith(
        "- pc-one (Windows 11 Pro 24H2 (build 26100.4061)) — connected"
    )
    assert "; agent 0.4.2-dev+abc123 (" in _line_with(results["device_list"], "- pc-one (")
    assert _line_with(results["device_list"], "- pc-wsl (").startswith(
        "- pc-wsl (Ubuntu 26.04 LTS, inside WSL Ubuntu-24.04) — connected"
    )
    assert _line_with(results["machine_status"], "  agent pc-one (").startswith(
        "  agent pc-one (Windows 11 Pro 24H2 (build 26100.4061); agent 0.4.2-dev+abc123): "
    )
    assert _line_with(results["machine_status"], "  agent pc-wsl (").startswith(
        "  agent pc-wsl (Ubuntu 26.04 LTS, inside WSL Ubuntu-24.04; agent 0.2.0): "
    )
    assert results["machine_status"].count("\n- machine DESKTOP-7XQ2:\n") == 2


# -- S42b: machine_update, and the agent line --------------------------------


def _updating(outcome: str, **extra) -> dict:
    return {
        "machine": "eval_laptop",
        "outcome": outcome,
        "version": "aaaaaaaaaaaa",
        "from_version": "0a0a0a0a0a0a",
        "reason": None,
        "attempt_id": None,
        "at": None,
        "needs_card": False,
        "in_flight": 0,
        "hub": False,
        **extra,
    }


class _UpdatingPlant:
    """Answers machine_update with one outcome, and records what it was asked
    — the facts sink included: the tool threads its facts_sink into
    update_now, so an update that finds the machine offline records that
    fact (the controller's ruling)."""

    def __init__(self, answer: dict | Exception):
        self.answer, self.calls = answer, []

    async def update_agent(self, app, name, *, requested_by, facts_sink=None, progress=None):
        self.calls.append((name, requested_by, facts_sink))
        if isinstance(self.answer, Exception):
            raise self.answer
        return {**self.answer, "machine": name}


@pytest.fixture
def _updating_plant(monkeypatch):
    def install(answer) -> _UpdatingPlant:
        plant = _UpdatingPlant(answer)
        monkeypatch.setattr(machines, "plant", lambda: plant)
        return plant

    return install


async def test_machine_update_says_sent_not_confirmed_until_the_reconnect(_updating_plant):
    """Review Focus 2: a send is not an update."""
    plant = _updating_plant(_updating("sent", in_flight=1))
    sink: list[dict] = []
    said = await _call("machine_update", {"machine": "eval_laptop"}, sink)
    assert plant.calls == [("eval_laptop", "nova", sink)]
    assert (
        "Sent the hub's build aaaaaaaaaaaa to eval_laptop" in said and "Not confirmed yet" in said
    )
    assert '1 command running there ends "cancelled"' in said
    assert "is confirmed" not in said
    assert sink == [
        {
            "machine_update": "eval_laptop",
            "hub": False,
            "outcome": "sent",
            "version": "aaaaaaaaaaaa",
            "confirmed": False,
        }
    ]


async def test_machine_update_says_confirmed_only_when_the_agent_reconnected(_updating_plant):
    _updating_plant(_updating("confirmed"))
    sink: list[dict] = []
    said = await _call("machine_update", {"machine": "eval_laptop"}, sink)
    assert "reconnected on the hub's build aaaaaaaaaaaa" in said and sink[0]["confirmed"] is True


async def test_machine_update_says_a_rollback_with_its_reason(_updating_plant):
    """The brief's "...and what still runs": nothing verifies which build runs
    after a rollback, so the words say what the supervisor put back and why,
    and leave the build it runs now to machine_status."""
    _updating_plant(_updating("rolled_back", reason="the new build did not connect within 2m0s"))
    said = await _call("machine_update", {"machine": "eval_laptop"})
    assert "put 0a0a0a0a0a0a back" in said and "did not connect within 2m0s" in said
    assert "is confirmed" not in said


async def test_machine_update_cannot_is_a_stated_failure_naming_the_one_step(_updating_plant):
    """P12: she names the step; she never sends the card herself from here."""
    reason = (
        "cannot: eval_laptop's agent was started by hand, not by its service, so Nova cannot "
        "restart it — close the window it runs in, then run the command on eval_laptop's setup "
        "card there"
    )
    _updating_plant(_updating("cannot", reason=reason, needs_card=True, version=None))
    sink: list[dict] = []
    with pytest.raises(ToolFailure) as exc:
        await _call("machine_update", {"machine": "eval_laptop"}, sink)
    assert str(exc.value) == reason
    assert sink == [
        {
            "machine_update": "eval_laptop",
            "hub": False,
            "outcome": "cannot",
            "version": None,
            "confirmed": False,
        }
    ]


@pytest.mark.parametrize(
    "outcome,reason,words",
    [
        # Pins moved (fix round 1, folded (3) and (4)): "current" is what the
        # agent last REPORTED, read before any connection was checked — never
        # "already runs"; a machine that could not take the build "cannot take"
        # it, the words the update job and the check use.
        ("current", None, "eval_laptop's agent last reported the hub's build aaaaaaaaaaaa"),
        (
            "refused",
            "the download step failed on eval_laptop (exit 6): could not resolve host",
            "eval_laptop cannot take the hub's build aaaaaaaaaaaa: the download step failed",
        ),
        ("refused", None, "cannot take the hub's build aaaaaaaaaaaa: no reason was given"),
        (
            "not_confirmed",
            "the machine was re-paired before the agent this was sent to reconnected",
            "the update is not confirmed: the machine was re-paired",
        ),
        ("not_confirmed", None, "the update is not confirmed: nothing has confirmed it"),
        ("rolled_back", None, "its supervisor put 0a0a0a0a0a0a back. The update is rolled back"),
    ],
)
async def test_machine_update_says_each_outcome_as_the_ledger_holds_it(
    _updating_plant, outcome, reason, words
):
    """Every outcome the ledger can hold is said as what it is — and only a
    confirmed one says the update is confirmed, or records confirmed: true."""
    _updating_plant(_updating(outcome, reason=reason))
    sink: list[dict] = []
    said = await _call("machine_update", {"machine": "eval_laptop"}, sink)
    assert words in said
    assert "is confirmed" not in said and "None" not in said
    assert sink[0]["confirmed"] is False and sink[0]["outcome"] == outcome


async def test_machine_update_counts_the_commands_its_restart_cancels(_updating_plant):
    """F15: a count — the hub keeps futures, not capability names — said for
    every outcome the update went out with commands running there."""
    _updating_plant(_updating("sent", in_flight=2))
    said = await _call("machine_update", {"machine": "eval_laptop"})
    assert '2 commands running there end "cancelled"' in said
    _updating_plant(_updating("confirmed", in_flight=1))
    said = await _call("machine_update", {"machine": "eval_laptop"})
    assert "1 command was running there when it was sent" in said
    assert 'a restart ends a running command "cancelled"' in said
    _updating_plant(_updating("confirmed"))
    assert "cancelled" not in await _call("machine_update", {"machine": "eval_laptop"})


async def test_machine_update_of_a_name_the_plant_does_not_have_is_its_stated_cannot(
    _updating_plant,
):
    _updating_plant(machines.UnknownMachine("cannot: no paired machine named 'dell' — none"))
    sink: list[dict] = []
    with pytest.raises(ToolFailure, match="cannot: no paired machine named 'dell'"):
        await _call("machine_update", {"machine": "dell"}, sink)
    assert sink == []  # nothing was determined, so nothing is recorded


async def test_machine_update_needs_a_name_and_asks_nothing_without_one(_updating_plant):
    plant = _updating_plant(_updating("sent"))
    with pytest.raises(ToolFailure, match="cannot: machine_update needs a machine's name"):
        await _call("machine_update", {"machine": "  "})
    assert plant.calls == []


def test_machine_update_changes_something_and_says_it_waits_on_the_reconnect():
    tool = tools.REGISTRY["machine_update"]
    assert tool.reads_only is False and tool.ephemeral is False
    assert tool.parameters["required"] == ["machine"]
    assert "confirmed ONLY by the agent's reconnect" in tool.description
    assert "'hub'" in tool.parameters["properties"]["machine"]["description"]


async def test_the_agent_line_says_its_build_how_it_starts_and_its_last_update(mount_peers, _plant):
    mount_peers(gateway=FakeGateway(engines=[fakes.engine_view()]))
    view = _view("PC-ONE", "windows", WINDOWS)
    view.update(
        hub=True,
        build={"state": "behind", "hub_version": "aaaaaaaaaaaa"},
        last_update={
            "version": "aaaaaaaaaaaa",
            "outcome": "sent",
            "at": AT.isoformat(),
            "reason": None,
        },
    )
    _plant(agents=[view])
    said = await _call("machine_status", {})
    lines = said.splitlines()
    at = next(i for i, line in enumerate(lines) if line.startswith("  agent PC-ONE ("))
    line = lines[at]
    # The door is not identity (controller ruling): a relay on the hub comes
    # in through the same loopback door, so the line says the door, never
    # that this IS the hub's own machine.
    assert (
        "; came in through the hub machine's own door; behind the hub's build aaaaaaaaaaaa; "
        "starts by hand" in line
    )
    assert "hub's own machine" not in said
    assert line.endswith(f"last update: aaaaaaaaaaaa sent at {AT.isoformat()}, not confirmed.")
    # Pin moved (fix round 1, folded (2)): what she needs to act on it is
    # written UNDER the agent's line, indented as device_list writes it — a
    # clip that keeps the line that states the connection keeps its fact
    # (Task 16b fix round 1 retired the brief's "predates S42b" wording).
    assert lines[at + 1] == "    how it runs: unknown — this agent has not reported it"
    assert machines_tool.device_line_shown("PC-ONE", said, len(said))


async def test_the_agent_line_says_a_decided_update_in_words_with_its_stored_reason(
    mount_peers, _plant
):
    """The stored reason is one line of at most 300 characters, made so when
    it was written (agent_updates._close) — rendered as stored, never cut
    again; and the ledger's tokens are said as words."""
    mount_peers(gateway=FakeGateway(engines=[fakes.engine_view()]))
    reason = ("the new build did not connect within 2m0s; (exit 75) — " + "x" * 300)[:300]
    view = _view("PC-ONE", "windows", WINDOWS)
    view.update(
        build={"state": "current", "hub_version": "aaaaaaaaaaaa"},
        last_update={
            "version": "aaaaaaaaaaaa",
            "outcome": "rolled_back",
            "at": AT.isoformat(),
            "reason": reason,
        },
    )
    _plant(agents=[view])
    said = await _call("machine_status", {})
    assert f"last update: aaaaaaaaaaaa rolled back at {AT.isoformat()} ({reason})" in said
    assert "; on the hub's build;" in said
    assert "came in through" not in said  # no door said for one that did not


async def test_the_agent_line_says_an_unknown_build_and_start_as_unknown(mount_peers, _plant):
    """Silence is not coverage: an agent with no facts states what is not on
    record, never nothing."""
    mount_peers(gateway=FakeGateway(engines=[fakes.engine_view()]))
    _plant(agents=[_view("old-wsl", "linux", None)])
    said = await _call("machine_status", {})
    assert "agent version unknown (none on record)" in said
    assert "how it starts: unknown — it has reported no facts" in said
    assert "last update" not in said


# -- Task 22 fix round 1 (folded) ----------------------------------------------


async def test_an_unasked_status_of_a_probed_agent_keeps_its_fact_at_the_clip(mount_peers, _plant):
    """Folded (2): with what she needs to act on it joined onto its line, a
    probed Windows agent's line ran ~1,690 characters while "connected now"
    ended at character 78 — the 600-character clip showed her the
    connection, and the check kept no fact of it. Written as indented lines
    under the agent's line, the line that states the connection is whole
    inside the clip, and its fact is kept."""
    from tests.test_device_facts import PROBED

    mount_peers(gateway=FakeGateway(engines=[fakes.engine_view()]))
    probed = {**device_facts.validate_auth(WINDOWS), **device_facts.validate_frame(PROBED)}
    _plant(agents=[_view("PC-ONE", "windows", probed)])
    turn, sink = _Turn(), []
    ctx = tools.context_for(core_app, _owner(), facts_sink=sink)
    call = live_facts.LiveCall(tool="machine_status", args={"machine": "PC-ONE"}, note="the PC")
    (check,) = await live_facts.run([call], turn, ctx)
    assert check.ok
    assert check.result.endswith(f"[…cut off at {live_facts.MAX_RESULT_CHARS} characters]")
    assert (
        "\n  agent PC-ONE (Windows 11 Pro 24H2 (build 26100); agent 0.2.0): connected now; "
        in check.result
    )
    (span,) = turn.spans
    assert span.meta["facts"] == [{"device": "PC-ONE", "connected": True}]
    assert sink == span.meta["facts"]


async def test_the_agent_line_says_a_machine_that_could_not_take_a_build_never_refused(
    mount_peers, _plant
):
    """Folded (4): the ledger's `refused` is a machine that could not take the
    build — the agent said no, or a bootstrap step failed — said in
    machine_update's words, never as the token."""
    mount_peers(gateway=FakeGateway(engines=[fakes.engine_view()]))
    reason = "the download step failed on PC-ONE (exit 6): could not resolve host"
    view = _view("PC-ONE", "windows", WINDOWS)
    view.update(
        last_update={
            "version": "aaaaaaaaaaaa",
            "outcome": "refused",
            "at": AT.isoformat(),
            "reason": reason,
        }
    )
    _plant(agents=[view])
    said = await _call("machine_status", {})
    assert f"last update: aaaaaaaaaaaa at {AT.isoformat()} — cannot take it: {reason}" in said
    assert "refused" not in said


async def test_current_is_said_as_what_the_agent_last_reported(_updating_plant):
    """Folded (3): `current` comes from the agent's stored facts, read before
    any connection was checked — it is what its agent last reported."""
    _updating_plant(_updating("current"))
    said = await _call("machine_update", {"machine": "eval_laptop"})
    assert said == (
        "eval_laptop's agent last reported the hub's build aaaaaaaaaaaa — nothing was sent."
    )


def test_the_descriptions_say_the_agent_lines_and_both_bounds_of_an_update():
    """Folded (1) and (5): machine_status says what an agent's lines now
    carry; machine_update says the send's own bound beside the wait's."""
    status = tools.REGISTRY["machine_status"].description
    for words in ("its agent's build against the hub's", "how it starts", "its last update"):
        assert words in status, words
    update = tools.REGISTRY["machine_update"].description
    assert "the agent has up to 2 minutes to download and stage it" in update
    assert "waits up to 2 minutes more for the agent to reconnect on it" in update


# -- Task 23 fix round 1 (I3): the agent line's ledger row is a fact ------------
#
# The line states the agent's last update as the ledger holds it, and the span
# now records that row beside the connection — {"machine_update", "outcome",
# "version", "confirmed"}, the shape machine_update records — so a true report
# in a later turn, after the job's unasked update, is backed by what she read
# (guards: an update claim reads _UPDATE_TOOLS and the machine read tools).


def _last(outcome: str) -> dict:
    return {"version": "aaaaaaaaaaaa", "outcome": outcome, "at": AT.isoformat(), "reason": None}


async def test_status_records_each_agents_last_update_as_the_ledger_holds_it(mount_peers, _plant):
    mount_peers(gateway=FakeGateway(engines=[fakes.engine_view()]))
    confirmed = _view("PC-ONE", "windows", WINDOWS)
    confirmed.update(last_update=_last("confirmed"))
    sent = _view("pc-wsl", "linux", WSL)
    sent.update(last_update=_last("sent"))
    never = _view("laptop", "linux", LAPTOP, hostname="laptop")
    _plant(agents=[confirmed, sent, never])
    sink: list[dict] = []
    await _call("machine_status", {}, sink)
    agent_facts = [fact for fact in sink if "device" in fact or "machine_update" in fact]
    assert agent_facts == [
        {"device": "PC-ONE", "connected": True},
        {
            "machine_update": "PC-ONE",
            "outcome": "confirmed",
            "version": "aaaaaaaaaaaa",
            "confirmed": True,
        },
        {"device": "pc-wsl", "connected": True},
        {
            "machine_update": "pc-wsl",
            "outcome": "sent",
            "version": "aaaaaaaaaaaa",
            "confirmed": False,
        },
        {"device": "laptop", "connected": True},
    ]
    # The reviewer's later-turn reply, backed by what she read — and only for
    # the agent whose update the ledger confirmed.
    span = SimpleNamespace(kind="tool", name="machine_status", meta={"ok": True, "facts": sink})
    names = ["PC-ONE", "pc-wsl", "laptop"]
    honest = "PC-ONE's agent has been updated — it reconnected on aaaaaaaaaaaa."
    assert guards.narration_check(honest, [span], names) is None
    assert guards.narration_check("pc-wsl's agent has been updated.", [span], names) is not None


async def test_an_unasked_status_keeps_an_agents_last_update_only_with_its_line(
    mount_peers, _plant, monkeypatch
):
    """live_facts withholds the ledger row with the line that states it: the
    laptop's whole line is shown and the dell's is cut just after its head, so
    the dell's confirmed update backs nothing she was not shown."""
    mount_peers(gateway=FakeGateway(engines=[fakes.engine_view(tags=THREE_MODELS)]))
    dell = _view("dell", "windows", WINDOWS, connected=False, hostname="DELL")
    laptop = _view("laptop", "linux", LAPTOP, hostname="laptop")
    for view in (dell, laptop):
        view.update(last_update=_last("confirmed"))
    _plant(agents=[laptop, dell])
    full = (await _call("machine_status", {})).strip()
    cut = full.index("  agent dell (") + len("  agent dell (Windows")
    monkeypatch.setattr(live_facts, "MAX_RESULT_CHARS", cut)
    check, turn, sink = await _unasked_status()
    assert check.ok and "agent dell (" in check.result
    (span,) = turn.spans
    assert span.meta["facts"] == [
        HUB_FACT,
        {"device": "laptop", "connected": True},
        {
            "machine_update": "laptop",
            "outcome": "confirmed",
            "version": "aaaaaaaaaaaa",
            "confirmed": True,
        },
    ]
    assert sink == span.meta["facts"]
    assert (
        guards.narration_check("laptop's agent has been updated.", turn.spans, AGENT_NAMES) is None
    )
    assert (
        guards.narration_check("dell's agent has been updated.", turn.spans, AGENT_NAMES)
        is not None
    )


async def test_an_old_row_the_status_shows_backs_only_a_claim_that_names_its_machine(
    mount_peers, _plant, _updating_plant, monkeypatch
):
    """Task 23 fix round 2 (N1), on both tools' own facts: machine_update sent
    the hub's build to minipc, the hub machine, and answered "sent"; then
    machine_status showed the dell's and the laptop's last rows — confirmed
    updates from weeks ago — and minipc's send. No row backs a claim that
    names no machine; the dell's row still backs a claim that names it."""
    reader = machines.plant
    _updating_plant(_updating("sent", hub=True))
    update_sink: list[dict] = []
    await _call("machine_update", {"machine": "minipc"}, update_sink)
    monkeypatch.setattr(machines, "plant", reader)  # machine_status reads the agents plant
    mount_peers(gateway=FakeGateway(engines=[fakes.engine_view()]))
    dell = _view("dell", "windows", WINDOWS, hostname="DELL")
    laptop = _view("laptop", "linux", LAPTOP, hostname="laptop")
    minipc = _view("minipc", "linux", {**LAPTOP, "machine_uid": "e" * 64}, hostname="minipc")
    for view, outcome in ((dell, "confirmed"), (laptop, "confirmed"), (minipc, "sent")):
        view.update(last_update=_last(outcome))
    _plant(agents=[dell, laptop, minipc])
    status_sink: list[dict] = []
    await _call("machine_status", {}, status_sink)
    spans = [
        SimpleNamespace(kind="tool", name=name, meta={"ok": True, "facts": sink})
        for name, sink in (("machine_update", update_sink), ("machine_status", status_sink))
    ]
    assert any(guards.is_update_fact(f) and f["confirmed"] for f in status_sink)
    names = ["dell", "laptop", "minipc"]
    for reply in (
        "Done — I updated the hub's agent.",
        "I upgraded it to the hub's build.",
        "I updated the agent on the mini PC.",
        "I updated the agent on your behalf.",
    ):
        correction = guards.narration_check(reply, spans, names)
        assert correction is not None and correction.claims[0].target is None, reply
    named = guards.narration_check("I updated minipc's agent.", spans, names)
    assert named is not None and named.claims[0].target == "minipc"
    assert guards.narration_check("The dell's agent has been updated.", spans, names) is None


# -- Task 32 Phase B round 2 ----------------------------------------------------
#
# L497: an agent whose line says it is on the hub's build, with no ledger row —
# paired already on it — or with a row that says otherwise — put on it by hand
# after a failed update — left no fact of that line, so "its agent is updated"
# was corrected beside a true line she had just read. What the line states is
# machine_update's "current": it backs the state, never an update she made.


def _on_build(name, *, hub_version, last=None, hostname="PC-ONE"):
    view = device_facts.agent_view(
        name=name,
        platform="windows",
        hostname=hostname,
        connected=True,
        last_seen=AT,
        facts=WINDOWS,
        facts_at=AT,
        hub_version=hub_version,
        last_update=last,
    )
    return view


async def test_an_agent_on_the_hubs_build_backs_its_state_whatever_its_ledger_holds(
    mount_peers, _plant
):
    mount_peers(gateway=FakeGateway(engines=[fakes.engine_view()]))
    fresh = _on_build("fresh", hub_version="0.2.0")  # WINDOWS reports agent 0.2.0
    by_hand = _on_build("by_hand", hub_version="0.2.0", last=_last("rolled_back"))
    behind = _on_build("behind", hub_version="0.9.9", last=_last("sent"))
    _plant(agents=[fresh, by_hand, behind])
    sink: list[dict] = []
    said = await _call("machine_status", {}, sink)
    assert said.count("; on the hub's build;") == 2
    rows = [fact for fact in sink if guards.is_update_fact(fact)]
    current = {"outcome": "current", "version": "0.2.0", "confirmed": False}
    assert rows == [
        {"machine_update": "fresh", **current},
        {
            "machine_update": "by_hand",
            "outcome": "rolled_back",
            "version": "aaaaaaaaaaaa",
            "confirmed": False,
        },
        {"machine_update": "by_hand", **current},
        {
            "machine_update": "behind",
            "outcome": "sent",
            "version": "aaaaaaaaaaaa",
            "confirmed": False,
        },
    ]
    span = SimpleNamespace(kind="tool", name="machine_status", meta={"ok": True, "facts": sink})
    names = ["fresh", "by_hand", "behind"]
    for machine in ("fresh", "by_hand"):
        assert guards.narration_check(f"{machine}'s agent is updated.", [span], names) is None
        assert guards.narration_check(f"{machine} is on the hub's build.", [span], names) is None
        # It backs the state, never an update she made.
        mine = guards.narration_check(f"I updated {machine}'s agent.", [span], names)
        assert mine is not None and mine.claims[0].target == machine
    behind_said = guards.narration_check("behind's agent is updated.", [span], names)
    assert behind_said is not None and behind_said.claims[0].target == "behind"


async def test_an_unread_build_backs_nothing(mount_peers, _plant):
    """No hub build to compare with is not "current": nothing is recorded."""
    mount_peers(gateway=FakeGateway(engines=[fakes.engine_view()]))
    _plant(agents=[_on_build("unknown", hub_version=None)])
    sink: list[dict] = []
    await _call("machine_status", {}, sink)
    assert not any(guards.is_update_fact(fact) for fact in sink)

