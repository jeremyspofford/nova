"""The tool registry and its single dispatch point.

Dispatch is the only path a tool is ever called through, so these tests
pin the two properties everything downstream leans on: a call whose
arguments do not match the schema executes NOTHING, and an executor can
never throw — every failure comes back as a stated Error result the model
can read and retry from.
"""
from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path

import pytest

from app import tools
from app.tools.base import Tool, ToolContext, ToolFailure


def _ctx(tmp_path: Path) -> ToolContext:
    return ToolContext(app=None, person=None, workspace_root=tmp_path)


@dataclass
class Spy:
    """An executor that records every call it is actually given."""

    calls: list = field(default_factory=list)
    result: str = "did the thing"
    raises: BaseException | None = None

    async def __call__(self, args: dict, ctx: ToolContext) -> str:
        self.calls.append(args)
        if self.raises is not None:
            raise self.raises
        return self.result


SPY_SCHEMA = {
    "type": "object",
    "properties": {
        "path": {"type": "string"},
        "count": {"type": "integer", "minimum": 1, "maximum": 10},
    },
    "required": ["path"],
    "additionalProperties": False,
}


@pytest.fixture
def spy(monkeypatch) -> Spy:
    executor = Spy()
    monkeypatch.setitem(
        tools.REGISTRY,
        "spy_tool",
        Tool(
            name="spy_tool",
            description="a tool that only records",
            parameters=SPY_SCHEMA,
            executor=executor,
        ),
    )
    return executor


# -- advertisement ---------------------------------------------------------


def test_the_registered_tools_are_exactly_this_set_by_name():
    # Deliberate snapshot update (migration 009): web_search joined the registry,
    # so this pinned set moved from seven to eight. A tool appearing or vanishing
    # here without this line moving is a mistake the test is meant to catch.
    #
    # Deliberate snapshot update (slice 5, T2): the nine device tools
    # (tools/devices.py) joined the registry, so this pinned set moved from
    # eight to SEVENTEEN. Each rides the same dispatch funnel as every other
    # tool, and (no approvals, 2026-09-03) needs no row anywhere to run: a tool
    # is in this set because a module declares it, and that is the whole test.
    assert set(tools.REGISTRY) == {
        "workspace_write_file",
        "workspace_read_file",
        "workspace_list_files",
        "memory_search",
        "memory_save",
        "get_time",
        "fetch_url",
        "web_search",
        "device_list",
        "device_info",
        "device_list_files",
        "device_read_file",
        "device_list_apps",
        "device_notify",
        "device_run",
        "device_write_file",
        "device_launch_app",
    }


def test_advertised_tools_are_openai_shaped_and_cover_the_registry():
    advertised = tools.advertised_tools()
    assert {entry["function"]["name"] for entry in advertised} == set(tools.REGISTRY)
    for entry in advertised:
        assert entry["type"] == "function"
        function = entry["function"]
        assert set(function) == {"name", "description", "parameters"}
        assert function["description"]
        assert function["parameters"]["type"] == "object"
        # JSON-serialisable, because it goes on the wire verbatim.
        json.dumps(entry)


# -- the happy path --------------------------------------------------------


async def test_a_valid_call_reaches_the_executor_with_parsed_arguments(spy, tmp_path):
    result, ok = await tools.dispatch("spy_tool", '{"path": "notes.md"}', _ctx(tmp_path))
    assert ok is True
    assert result == "did the thing"
    assert spy.calls == [{"path": "notes.md"}]


async def test_arguments_already_parsed_by_the_backend_are_accepted(spy, tmp_path):
    result, ok = await tools.dispatch("spy_tool", {"path": "notes.md"}, _ctx(tmp_path))
    assert ok is True
    assert spy.calls == [{"path": "notes.md"}]


async def test_an_empty_argument_string_means_no_arguments(monkeypatch, tmp_path):
    executor = Spy()
    monkeypatch.setitem(
        tools.REGISTRY,
        "no_args",
        Tool(
            name="no_args",
            description="takes nothing",
            parameters={"type": "object", "properties": {}, "additionalProperties": False},
            executor=executor,
        ),
    )
    result, ok = await tools.dispatch("no_args", "", _ctx(tmp_path))
    assert ok is True
    assert executor.calls == [{}]


# -- schema validation: nothing executes ----------------------------------


async def test_malformed_json_arguments_execute_nothing(spy, tmp_path):
    result, ok = await tools.dispatch("spy_tool", '{"path": ', _ctx(tmp_path))
    assert ok is False
    assert result.startswith("Error: ")
    assert "JSON" in result
    assert result.endswith("re-issue the call")
    assert spy.calls == []


async def test_a_missing_required_argument_executes_nothing(spy, tmp_path):
    result, ok = await tools.dispatch("spy_tool", "{}", _ctx(tmp_path))
    assert ok is False
    assert "path" in result
    assert "required" in result
    assert result.endswith("re-issue the call")
    assert spy.calls == []


async def test_a_wrong_typed_argument_executes_nothing(spy, tmp_path):
    result, ok = await tools.dispatch("spy_tool", '{"path": 7}', _ctx(tmp_path))
    assert ok is False
    assert "path" in result and "string" in result
    assert spy.calls == []


async def test_a_boolean_is_not_an_integer(spy, tmp_path):
    result, ok = await tools.dispatch("spy_tool", '{"path": "a", "count": true}', _ctx(tmp_path))
    assert ok is False
    assert "count" in result and "integer" in result
    assert spy.calls == []


async def test_an_unknown_extra_argument_executes_nothing(spy, tmp_path):
    result, ok = await tools.dispatch(
        "spy_tool", '{"path": "a", "recursive": true}', _ctx(tmp_path)
    )
    assert ok is False
    assert "recursive" in result
    assert spy.calls == []


@pytest.mark.parametrize("count", [0, 11])
async def test_an_out_of_range_integer_executes_nothing(spy, tmp_path, count):
    result, ok = await tools.dispatch(
        "spy_tool", json.dumps({"path": "a", "count": count}), _ctx(tmp_path)
    )
    assert ok is False
    assert "count" in result
    assert spy.calls == []


async def test_arguments_that_are_not_an_object_execute_nothing(spy, tmp_path):
    result, ok = await tools.dispatch("spy_tool", "[1, 2]", _ctx(tmp_path))
    assert ok is False
    assert "object" in result
    assert spy.calls == []


async def test_an_unknown_tool_name_is_refused_and_names_what_exists(tmp_path):
    result, ok = await tools.dispatch("workspace_delete_everything", "{}", _ctx(tmp_path))
    assert ok is False
    assert "workspace_delete_everything" in result
    assert "workspace_write_file" in result  # the list of what does exist
    assert result.endswith("re-issue the call")


# -- executors never throw -------------------------------------------------


async def test_a_stated_refusal_comes_back_as_an_error_result(monkeypatch, tmp_path):
    executor = Spy(raises=ToolFailure("the path is outside the workspace"))
    monkeypatch.setitem(
        tools.REGISTRY,
        "spy_tool",
        Tool(name="spy_tool", description="d", parameters=SPY_SCHEMA, executor=executor),
    )
    result, ok = await tools.dispatch("spy_tool", '{"path": "x"}', _ctx(tmp_path))
    assert ok is False
    assert result == "Error: the path is outside the workspace"


async def test_an_unexpected_exception_is_wrapped_not_raised(monkeypatch, tmp_path, caplog):
    executor = Spy(raises=RuntimeError("disk on fire"))
    monkeypatch.setitem(
        tools.REGISTRY,
        "spy_tool",
        Tool(name="spy_tool", description="d", parameters=SPY_SCHEMA, executor=executor),
    )
    with caplog.at_level("ERROR"):
        result, ok = await tools.dispatch("spy_tool", '{"path": "x"}', _ctx(tmp_path))
    assert ok is False
    assert result.startswith("Error: ")
    assert "disk on fire" in result
    assert "RuntimeError" in result
    # An unplanned failure is still reported to the log, never only to the model.
    assert any("spy_tool" in record.message for record in caplog.records)


async def test_an_executor_returning_nothing_useful_is_still_a_stated_result(
    monkeypatch, tmp_path
):
    """A tool that answers with an empty string tells the model nothing —
    an empty tool result reads as success with no evidence."""
    executor = Spy(result="")
    monkeypatch.setitem(
        tools.REGISTRY,
        "spy_tool",
        Tool(name="spy_tool", description="d", parameters=SPY_SCHEMA, executor=executor),
    )
    result, ok = await tools.dispatch("spy_tool", '{"path": "x"}', _ctx(tmp_path))
    assert ok is False
    assert result.startswith("Error: ")
    assert "spy_tool" in result
