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
    """Text an agent reported can carry a newline this format never writes; the
    line it breaks cannot be confirmed whole, so it fails closed even when the
    whole listing was shown."""
    broken = {**WINDOWS, "os": {**WINDOWS["os"], "version": "Windows 11\nPro"}}
    listing = _listing(_view("pc-one", "windows", broken))
    assert "\nPro; agent 0.2.0): connected now" in listing
    assert not machines_tool.device_line_shown("pc-one", listing, len(listing))
