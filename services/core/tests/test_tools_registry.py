"""The tool registry and its single dispatch point.

Dispatch is the only path a tool is ever called through, so these tests
pin the two properties everything downstream leans on: a call whose
arguments do not match the schema executes NOTHING, and an executor can
never throw — every failure comes back as a stated Error result the model
can read and retry from.
"""

from __future__ import annotations

import json
import uuid
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
    #
    # Deliberate snapshot update (slice 9, T2, 2026-09-07): the three timer
    # tools (tools/timers.py — create_timer, list_timers, cancel_timer) joined
    # the registry, so this pinned set moved from seventeen to TWENTY. Same
    # funnel, no row anywhere to run; her reminders are a capability the moment
    # the module is in REGISTRY.
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
        # S10a-3 (2026-09-07): her model tools — the catalogue search and the
        # pull into the bundled ollama (tools/models.py). SEVENTEEN -> NINETEEN.
        "model_catalog_search",
        "model_pull",
        # The follow-ups (2026-09-07): an update check and a verified remove.
        # NINETEEN -> TWENTY-ONE.
        "model_check_update",
        "model_remove",
        # S9 (2026-09-07, merged 09-08): the timer tools. TWENTY-ONE -> TWENTY-FOUR.
        # S10 (2026-09-08): the spend report. TWENTY-FOUR -> TWENTY-FIVE.
        "spend_report",
        # S10-2 (2026-09-08): the routing walk in words. TWENTY-FIVE -> TWENTY-SIX.
        "route_explain",
        "create_timer",
        "list_timers",
        "cancel_timer",
        # S12-3 (2026-09-08): her agent tools (tools/agents.py) — a delegation
        # that runs an agent's turn to completion inside hers, and the four
        # over the page's one writer (create/update/delete/list). TWENTY-SIX
        # -> THIRTY-ONE. Same funnel, no row anywhere to run: an agent is hers
        # to make and to hand work to the moment the module is in REGISTRY.
        "delegate_to_agent",
        "create_agent",
        "update_agent",
        "delete_agent",
        "list_agents",
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


async def test_an_executor_returning_nothing_useful_is_still_a_stated_result(monkeypatch, tmp_path):
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


def test_the_tools_package_imports_on_its_own():
    """tools/models.py once imported models_catalog at module top, which
    pulls chat, which pulls tools — fine when chat is imported first (the
    app, the tests), a circular-import crash when `app.tools` is imported
    first (a script, a shell). Import the package cold in a subprocess."""
    import subprocess
    import sys

    proc = subprocess.run(
        [sys.executable, "-c", "from app import tools; print(len(tools.REGISTRY))"],
        capture_output=True,
        text=True,
        cwd=str(Path(__file__).resolve().parent.parent),
    )
    assert proc.returncode == 0, proc.stderr
    assert proc.stdout.strip() == str(len(tools.REGISTRY))


# -- S12: an agent's subset, an agent's folder (2026-09-08) ----------------
#
# Both are SCOPE handed in at the two places a turn already touches the
# registry — what is advertised, and what root the context carries — never a
# field on Tool or ToolContext (test_no_approvals pins both field sets) and
# never a check inside dispatch (its single await is pinned too). These tests
# pin that the no-argument forms are byte-for-byte what they were, so Nova's
# own turns and the scheduler's cannot drift when an agent's do not.


def _owner():
    from app.identity import Person

    return Person(id=uuid.uuid4(), name="jeremy", role="owner")


def test_advertised_tools_with_no_argument_is_the_whole_registry_in_order():
    """The zero-arg call is what every non-agent turn makes (and what
    test_chat_model_failure monkeypatches with a zero-arg stand-in), so it
    must keep working with no argument and keep producing the same bytes."""
    whole = tools.advertised_tools()
    assert [entry["function"]["name"] for entry in whole] == tools.tool_names()
    assert tools.advertised_tools(None) == whole
    assert tools.advertised_tools(tools.tool_names()) == whole


def test_advertised_tools_with_names_advertises_only_the_registered_ones():
    """An unknown name is skipped, not raised on and not invented: the
    caller holding the agent's list is where "[tool nope: no longer
    exists]" gets said, in the prompt the model reads."""
    subset = tools.advertised_tools(["workspace_read_file", "nope"])
    assert [entry["function"]["name"] for entry in subset] == ["workspace_read_file"]
    assert subset[0] == next(
        entry
        for entry in tools.advertised_tools()
        if entry["function"]["name"] == "workspace_read_file"
    )


def test_advertised_tools_orders_a_subset_by_registry_not_by_caller():
    """Two agents naming the same tools in a different order send the same
    `tools` array, so a prompt-cache prefix is not lost to list order."""
    a = tools.advertised_tools(["memory_save", "workspace_read_file", "get_time"])
    b = tools.advertised_tools(["get_time", "memory_save", "workspace_read_file"])
    assert a == b
    assert [entry["function"]["name"] for entry in a] == [
        "get_time",
        "memory_save",
        "workspace_read_file",
    ]


def test_advertised_tools_with_an_empty_subset_advertises_nothing():
    assert tools.advertised_tools([]) == []


def test_context_for_defaults_the_root_to_the_environment(monkeypatch, tmp_path):
    from app.tools import workspace

    monkeypatch.setenv(workspace.WORKSPACE_ROOT_ENV, str(tmp_path / "nova"))
    ctx = tools.context_for(None, _owner())
    assert ctx.workspace_root == workspace.root_from_env() == tmp_path / "nova"


def test_context_for_uses_a_given_root_as_is(monkeypatch, tmp_path):
    """An agent's folder is a different root on the same containment: the
    workspace tools resolve every path against ctx.workspace_root, so the
    root handed in here IS the boundary for that turn."""
    from app.tools import workspace

    monkeypatch.setenv(workspace.WORKSPACE_ROOT_ENV, str(tmp_path / "nova"))
    folder = tmp_path / "nova" / "agents" / "coder"
    ctx = tools.context_for(None, _owner(), workspace_root=folder)
    assert ctx.workspace_root == folder
    assert ctx.workspace_root != workspace.root_from_env()
    # The rest of the context is what it always was.
    assert ctx.app is None and ctx.facts_sink is None and ctx.progress is None


async def test_a_given_root_is_the_boundary_the_workspace_tools_enforce(monkeypatch, tmp_path):
    """Not a unit pin on a field — the actual tool, through dispatch, with a
    root that is a subfolder of the env root: a path that climbs out of the
    folder is refused even though it would still be inside the env root."""
    from app.tools import workspace

    monkeypatch.setenv(workspace.WORKSPACE_ROOT_ENV, str(tmp_path / "nova"))
    folder = tmp_path / "nova" / "agents" / "coder"
    (tmp_path / "nova").mkdir()
    (tmp_path / "nova" / "secret.md").write_text("owner's file", encoding="utf-8")
    ctx = tools.context_for(None, _owner(), workspace_root=folder)

    result, ok = await tools.dispatch("workspace_read_file", {"path": "../../secret.md"}, ctx)
    assert ok is False
    assert result.startswith("Error: ")
    assert "outside the workspace" in result

    result, ok = await tools.dispatch(
        "workspace_write_file", {"path": "notes.md", "content": "hi"}, ctx
    )
    assert ok is True, result
    assert (folder / "notes.md").read_text(encoding="utf-8") == "hi"


def test_context_for_still_refuses_no_person_before_looking_at_the_root(tmp_path):
    """A root does not stand in for an identity: the memory tools scope to
    ctx.person, and a None there is a caller bug however the root was chosen."""
    with pytest.raises(ValueError, match="person"):
        tools.context_for(None, None)
    with pytest.raises(ValueError, match="person"):
        tools.context_for(None, None, workspace_root=tmp_path)


def test_progress_accepts_a_detail_line_or_a_structured_report():
    """The channel widened to `str | dict` so a delegation can relay an
    agent's steps as structured keys chat allow-lists; the str path a model
    pull uses is unchanged. The FIELD SET is pinned in test_no_approvals —
    this is only the annotation, the one thing that changed."""
    annotation = ToolContext.__dataclass_fields__["progress"].type
    assert "str | dict" in str(annotation), annotation
    seen: list = []
    ctx = ToolContext(app=None, person=None, workspace_root=Path("/x"), progress=seen.append)
    assert ctx.progress is not None
    ctx.progress("pulling — 42%")
    ctx.progress({"detail": "coder is working…", "agent": "coder", "step": "get_time"})
    assert seen == [
        "pulling — 42%",
        {"detail": "coder is working…", "agent": "coder", "step": "get_time"},
    ]


# -- what changes the world, and what only looks (S14, 2026-09-10) -----------


def test_the_tools_that_change_nothing_are_pinned_by_name():
    """A tripwire, not a list to maintain for its own sake.

    `reads_only` decides what the BACKEND may run when nobody asked it to — a
    distilled note carries the call that answers it now, and something that
    changes the world must never run unasked. So a tool added tomorrow must
    say which side it is on, and this reddens until someone decides rather
    than inheriting a default.

    NECESSARY, NOT SUFFICIENT: fetch_url and web_search change nothing and are
    true here, but they reach an address the caller chose, so the code that
    picks the auto-run set narrows this further. One concept per flag.
    """
    reads = {name for name, tool in tools.REGISTRY.items() if tool.reads_only}
    assert reads == {
        "device_info",
        "device_list",
        "device_list_apps",
        "device_list_files",
        "device_read_file",
        "fetch_url",
        "get_time",
        "list_agents",
        "list_timers",
        "memory_search",
        "model_catalog_search",
        "model_check_update",
        "route_explain",
        "spend_report",
        "web_search",
        "workspace_list_files",
        "workspace_read_file",
    }


def test_every_tool_that_writes_says_it_changes_something():
    """The half that would be silent if it were wrong. A writer, a launcher, a
    notifier or a command runner marked reads_only could be run by the backend
    with nobody asking — so name them here rather than trusting the flag."""
    changes = {name for name, tool in tools.REGISTRY.items() if not tool.reads_only}
    for name in (
        "workspace_write_file",
        "memory_save",
        "device_run",
        "device_write_file",
        "device_launch_app",
        "device_notify",
        "model_pull",
        "model_remove",
        "create_timer",
        "cancel_timer",
        "create_agent",
        "update_agent",
        "delete_agent",
        "delegate_to_agent",
    ):
        assert name in changes, f"{name} changes something and must not be reads_only"
