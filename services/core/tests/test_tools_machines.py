"""S40 — her machines: where models run, and the one switch on each.

Both tools read and write through app/machines.py against the fake gateway's
/admin/engines — the same fixture the Settings tile's API is pinned on, so
what she says and what the page shows cannot come from two readings."""

from __future__ import annotations

import inspect
import uuid

import httpx
import pytest

from app import chat, machines, tools
from app.identity import Person
from app.main import app as core_app
from app.tools.base import ToolFailure
from tests import fakes
from tests.fakes import FakeGateway


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
    assert "hub:<model> runs on hub" in said
    assert sink == [
        {"machine": "hub", "answering": True, "checked_now": True, "at": fakes.ENGINE_AT}
    ]


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
    with pytest.raises(
        ToolFailure, match="no machine named 'dell' runs models — the gateway lists: hub, box"
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
            match="hub's switch is not confirmed set — cannot: 'hub' is not one of this "
            "case's declared machines",
        ):
            await _call("machine_configure", {"machine": "hub", "serving": False})
        assert not any(path.startswith("/admin/engines/") for path, _ in gateway.seen)
    finally:
        machines.PLANT.reset(token)


def test_the_prompt_says_where_models_run_from_the_tools_own_names():
    prompt = chat.stable_system_prompt("m", tools.tool_names())
    assert "a model id names its machine before its first colon" in prompt
    assert "only from machine_status" in prompt
    assert "only with machine_configure, reporting the value it read back" in prompt
    assert "names its machine" not in chat.stable_system_prompt("m", ("get_time",))
    only_status = chat.stable_system_prompt("m", ("machine_status",))
    assert "only from machine_status" in only_status and "machine_configure" not in only_status
    source = inspect.getsource(chat.stable_system_prompt)
    assert '"machine_status"' not in source and '"machine_configure"' not in source
