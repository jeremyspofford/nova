"""S30c T8 (2026-10-12): device_run gains `env` and `timeout_s`.

`env` (an object of string values, names ^[A-Za-z_][A-Za-z0-9_]*$) reaches
the agent's shell.exec / box.exec, which run the program with it; its values
never reach a span or a row. `timeout_s` (1..110) is the call's budget on the
agent, and core waits timeout_s + 10 s. An agent that predates them runs the
command WITHOUT them, and the result says so; elevated runs take neither.

Criteria (tracker .epics/s30c.md, ## T8):
  C1 schema + edge refusals before the wire, never quoting an env value.
  C2 on the wire only when given; core waits timeout_s + 10.
  C5 an agent that predates them -> Error naming it, the run fact still filed.
  C6 elevated + env / timeout_s -> Error before the send.
  C7 spans mask every env value; no token byte anywhere in a device_run span.
(C3/C4 are the agent's: apps/novad/internal/caps/shell_env*_test.go.)
"""

from __future__ import annotations

import json

import pytest

from app import chat, tools
from app.tools import devices as device_tools
from app.tools import schema
from tests.conftest import requires_db
from tests.test_device_run_box import (
    ARGV,
    BOX,
    CWD,
    HOST,
    NAME,
    _limits,
    _repo_row,
    _run,
    _runs,
    recorded,  # noqa: F401
)
from tests.test_devices_ws import _clean_hub, _command_frames, _ctx  # noqa: F401
from tests.test_devices_ws import _person as device_tools_person
from tests.test_outside_worktree_flag import _connect_host

pytestmark = requires_db

SECRET = "t8-secret-value-9f3a"
TOKEN = "ghp_" + "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8"
LAPTOP = "laptop"


def _echo(*, output="done", exit_code=0):
    """An agent that ran it and echoed what it was given (S30c T8)."""

    def answer(envelope):
        args = envelope["args"]
        meta = {"env_keys": sorted(args.get("env") or {})}
        if "timeout_s" in args:
            meta["timeout_s"] = args["timeout_s"]
        return {"ok": True, "output": output, "exit_code": exit_code, "meta": meta}

    return answer


def _old_agent(output="done", exit_code=0):
    """An agent from before T8: it ignores env/timeout_s and sends no meta."""
    return lambda envelope: {"ok": True, "output": output, "exit_code": exit_code}


async def _laptop(pool):
    device, conn, _task = await _connect_host(pool, name=LAPTOP, hostname="laptop-host")
    return device, conn


# -- C1: the schema and the edge ------------------------------------------------


def test_c1_the_schema_offers_env_and_timeout_s():
    params = tools.REGISTRY["device_run"].parameters
    env = params["properties"]["env"]
    assert env["type"] == "object"
    assert env["additionalProperties"] == {"type": "string"}
    timeout = params["properties"]["timeout_s"]
    assert timeout["type"] == "integer"
    assert (timeout["minimum"], timeout["maximum"]) == (1, 110)
    assert set(params["required"]) == {"device", "argv"}


@pytest.mark.parametrize("value", [0, 111, -1])
def test_c1_timeout_s_out_of_range_is_refused_by_the_schema(value):
    params = tools.REGISTRY["device_run"].parameters
    problem = schema.validate(params, {"device": "x", "argv": ["true"], "timeout_s": value})
    assert problem is not None and "timeout_s" in problem


@pytest.mark.parametrize(
    "env",
    [
        f"A={SECRET}",
        ["A"],
        {"A": 1},
        {"A": None},
        {"1X": SECRET},
        {"A=B": SECRET},
        {"": SECRET},
        {f"TOKEN {SECRET}": "v"},
    ],
)
async def test_c1_a_bad_env_is_refused_before_the_wire_never_quoting_a_value(pool, env):
    device, conn = await _laptop(pool)
    result, ok, _f, sent, _ = await _run(
        pool, conn, device, {"device": LAPTOP, "argv": ["true"], "env": env}, _echo()
    )
    assert ok is False
    assert "env" in result
    assert sent == []
    assert SECRET not in result


@pytest.mark.parametrize("value", [0, 111, 1.5, "5", True])
async def test_c1_a_bad_timeout_s_is_refused_before_the_wire(pool, value):
    device, conn = await _laptop(pool)
    result, ok, _f, sent, _ = await _run(
        pool, conn, device, {"device": LAPTOP, "argv": ["true"], "timeout_s": value}, _echo()
    )
    assert ok is False
    assert "timeout_s" in result
    assert sent == []


# -- C2: on the wire only when given; core waits timeout_s + 10 -----------------


async def test_c2_env_and_timeout_s_ride_the_shell_exec_args(pool):
    device, conn = await _laptop(pool)
    env = {"GH_TOKEN": TOKEN, "NOVA_MODE": "x"}
    result, ok, _f, sent, _ = await _run(
        pool,
        conn,
        device,
        {"device": LAPTOP, "argv": ["gh", "auth", "status"], "env": env, "timeout_s": 45},
        _echo(),
    )
    assert ok is True, result
    assert [e["capability"] for e in sent] == ["shell.exec"]
    assert sent[0]["args"] == {"argv": ["gh", "auth", "status"], "env": env, "timeout_s": 45}


async def test_c2_without_them_the_frame_is_as_before(pool):
    device, conn = await _laptop(pool)
    _r, ok, _f, sent, _ = await _run(
        pool, conn, device, {"device": LAPTOP, "argv": ["true"]}, _old_agent()
    )
    assert ok is True
    assert sent[0]["args"] == {"argv": ["true"]}


async def test_c2_env_and_timeout_s_ride_the_box_exec_args(pool, recorded):  # noqa: F811
    await _repo_row(pool)
    await _limits(pool)
    device, conn, _task = await _connect_host(pool, name=NAME, hostname=HOST)

    def boxed(envelope):
        fields = _echo()(envelope)
        fields["meta"] = {"ran_in": "box", "box": BOX, "image": "i", **fields["meta"]}
        return fields

    result, ok, _f, sent, _ = await _run(
        pool,
        conn,
        device,
        {"device": NAME, "argv": ARGV, "cwd": CWD, "env": {"NOVA_X": "y"}, "timeout_s": 9},
        boxed,
    )
    assert ok is True, result
    assert [e["capability"] for e in sent] == ["box.exec"]
    assert sent[0]["args"]["env"] == {"NOVA_X": "y"}
    assert sent[0]["args"]["timeout_s"] == 9


@pytest.mark.parametrize(("given", "waited"), [(33, 43), (None, None)])
async def test_c2_core_waits_timeout_s_plus_ten(pool, monkeypatch, given, waited):
    device, conn = await _laptop(pool)
    seen: list[float] = []
    real = device_tools.devices_ws.hub.command

    async def spy(*args, **kwargs):
        seen.append(kwargs["timeout"])
        return await real(*args, **kwargs)

    monkeypatch.setattr(device_tools.devices_ws.hub, "command", spy)
    args = {"device": LAPTOP, "argv": ["true"]}
    if given is not None:
        args["timeout_s"] = given
    _r, ok, _f, _s, _ = await _run(pool, conn, device, args, _echo())
    assert ok is True
    expected = device_tools.COMMAND_TIMEOUT_SECONDS if waited is None else waited
    assert seen == [expected]


# -- C5: an agent that predates them --------------------------------------------


@pytest.mark.parametrize(
    "extra",
    [{"env": {"NOVA_X": "y"}}, {"timeout_s": 20}, {"env": {"NOVA_X": "y"}, "timeout_s": 20}],
)
async def test_c5_an_old_agent_ran_it_without_them_and_is_told_to_update(pool, extra):
    device, conn = await _laptop(pool)
    result, ok, facts, sent, _ = await _run(
        pool,
        conn,
        device,
        {"device": LAPTOP, "argv": ["make", "x"], **extra},
        _old_agent(exit_code=4),
    )
    assert ok is False
    assert len(sent) == 1
    assert result == (
        f"Error: {LAPTOP}'s agent predates env/timeout_s — it ran WITHOUT them (exit 4); "
        "update it with machine_update"
    )
    (run,) = _runs(facts)
    assert run["exit_code"] == 4
    assert run["argv"] == ["make", "x"]


async def test_c5_an_agent_that_echoes_only_env_keys_lacks_timeout_s(pool):
    device, conn = await _laptop(pool)

    def env_only(envelope):
        return {"ok": True, "output": "", "exit_code": 0, "meta": {"env_keys": ["NOVA_X"]}}

    result, ok, _f, _s, _ = await _run(
        pool,
        conn,
        device,
        {"device": LAPTOP, "argv": ["true"], "env": {"NOVA_X": "y"}, "timeout_s": 5},
        env_only,
    )
    assert ok is False
    assert "predates env/timeout_s" in result


async def test_c5_an_agent_that_echoes_them_reads_as_a_plain_run(pool):
    device, conn = await _laptop(pool)
    result, ok, _f, _s, _ = await _run(
        pool,
        conn,
        device,
        {"device": LAPTOP, "argv": ["true"], "env": {"NOVA_X": "y"}, "timeout_s": 5},
        _echo(),
    )
    assert ok is True
    assert result.splitlines()[0] == f"{LAPTOP} ran ['true'] — exit 0"


# -- C6: elevated takes neither -------------------------------------------------


@pytest.mark.parametrize("extra", [{"env": {"NOVA_X": "y"}}, {"timeout_s": 5}])
async def test_c6_elevated_with_env_or_timeout_s_is_refused_before_the_send(pool, extra):
    device, conn = await _laptop(pool)
    result, ok, _f, sent, _ = await _run(
        pool,
        conn,
        device,
        {"device": LAPTOP, "argv": ["true"], "elevated": True, **extra},
        _echo(),
    )
    assert ok is False
    assert sent == []
    assert "elevated" in result
    assert next(iter(extra)) in result


# -- C7: spans --------------------------------------------------------------------


def test_c7_span_record_masks_every_env_value_keeping_the_names():
    raw = json.dumps(
        {"device": "x", "argv": ["true"], "env": {"FOO": "plain-value-123", "GH_TOKEN": TOKEN}}
    )
    recorded_args, scrub = chat._span_record(raw, "device_run")
    assert recorded_args["env"] == {
        "FOO": f"<masked:{len('plain-value-123')} chars>",
        "GH_TOKEN": f"<masked:{len(TOKEN)} chars>",
    }
    assert scrub(f"said plain-value-123 and {TOKEN}") == "said [masked] and [masked]"


def test_c7_an_env_that_is_not_an_object_is_masked_whole():
    recorded_args, _scrub = chat._span_record(
        json.dumps({"device": "x", "argv": ["true"], "env": f"A={SECRET}"}), "device_run"
    )
    assert SECRET not in json.dumps(recorded_args)


@pytest.mark.parametrize("name", ["GH_TOKEN", "NOVA_GH"])
async def test_c7_a_device_run_span_holds_no_token_byte(pool, name):
    """GH_TOKEN is credential-shaped by its name; NOVA_GH is not, and is
    masked all the same: every env value, whatever it is called."""
    device, conn = await _laptop(pool)
    _r, ok, _f, _s, span = await _run(
        pool,
        conn,
        device,
        {"device": LAPTOP, "argv": ["gh", "auth", "status"], "env": {name: TOKEN}},
        _echo(output=f"Logged in with token {TOKEN}"),
        span=True,
    )
    assert ok is True
    dumped = json.dumps(span.meta, default=str)
    assert TOKEN not in dumped
    assert TOKEN[4:20] not in dumped
    assert span.meta["args_redacted"]["env"] == {name: f"<masked:{len(TOKEN)} chars>"}


# -- COVERAGE (2026-10-12) ----------------------------------------------------------


@pytest.mark.parametrize("value", [0, 111, 2.0, True])
async def test_c1_the_executor_refuses_a_bad_timeout_s_without_the_schema(pool, value):
    """The schema refuses these first through dispatch; the executor holds
    the same line on its own (a direct call never sends what the agent would
    refuse)."""
    device, conn = await _laptop(pool)
    person = await device_tools_person(pool)
    with pytest.raises(device_tools.ToolFailure, match="timeout_s"):
        await device_tools.device_run(
            {"device": LAPTOP, "argv": ["true"], "timeout_s": value}, _ctx(person)
        )
    assert _command_frames(conn) == []


def test_c7_an_env_name_that_is_not_a_name_is_recorded_by_position():
    raw = json.dumps({"device": "x", "argv": ["true"], "env": {f"TOKEN {SECRET}": "v", "OK": "w"}})
    recorded_args, scrub = chat._span_record(raw, "device_run")
    assert recorded_args["env"] == {"<key 1>": "<masked:1 chars>", "OK": "<masked:1 chars>"}
    assert SECRET not in json.dumps(recorded_args)
    assert SECRET not in scrub(f"unknown name TOKEN {SECRET}")
