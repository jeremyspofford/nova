"""Her MCP tools (S37a), through dispatch and the turn's own span recorder.

Plants are context managers used inside each test (a ContextVar token is
reset in the context that set it)."""

from __future__ import annotations

import contextlib
import json
import uuid
from datetime import UTC, datetime

from app import chat, tools, traces
from app.identity import Person
from app.main import app
from app.mcp import client, fake, servers
from app.tools import schema
from tests.conftest import requires_db

URL = "http://gh.mcp.invalid/mcp"
ORIGIN = "http://gh.mcp.invalid"
RUNS = fake.FakeTool(
    "actions_list",
    "List workflow runs for a repository",
    {
        "type": "object",
        "properties": {
            "method": {"type": "string", "enum": ["list_workflow_runs", "list_workflow_jobs"]},
            "repo": {"type": "string"},
        },
        "required": ["method", "repo"],
    },
    ({"text": "run 7 on main: failure"},),
)
LOGS = fake.FakeTool("get_job_logs", "Read a job's log", results=({"text": "x" * (70 * 1024)},))
BOOM = fake.FakeTool(
    "rerun", "Re-run a workflow", results=({"text": "no such run", "is_error": True},)
)


def _ctx(facts: list | None = None):
    person = Person(id=uuid.uuid4(), name="jeremy", role="owner")
    return tools.context_for(app, person, facts_sink=facts if facts is not None else [])


@contextlib.contextmanager
def planted(spec: fake.FakeSpec):
    handle = client.plant({ORIGIN: fake.transport(fake.FakeServer(spec))})
    try:
        yield
    finally:
        client.unplant(handle)


@contextlib.asynccontextmanager
async def github(pool):
    """A fake GitHub planted at ORIGIN and connected by the owner, for the body
    of an `async with`."""
    with planted(fake.FakeSpec(title="GitHub", tools=(RUNS, LOGS, BOOM))):
        await servers.connect(
            pool, name="github", url=URL, token="t0ken", added_by=servers.BY_OWNER, actor="jeremy"
        )
        yield


# -- a stranger's schema ----------------------------------------------------------


def test_validate_foreign_leaves_what_it_cannot_judge_to_the_server():
    stranger = {
        "type": "object",
        "properties": {
            "filter": {"anyOf": [{"type": "string"}, {"type": "object"}]},
            "nested": {"type": "object", "properties": {"deep": {"type": "integer"}}},
        },
        "additionalProperties": True,
    }
    assert (
        schema.validate_foreign(stranger, {"filter": {"a": 1}, "nested": {"deep": "x"}, "extra": 1})
        is None
    )
    assert schema.validate_foreign({}, {"anything": [1, 2]}) is None


def test_validate_foreign_refuses_what_it_can_be_sure_of():
    closed = dict(RUNS.input_schema, additionalProperties=False)
    assert "missing required argument 'repo'" in schema.validate_foreign(
        closed, {"method": "list_workflow_runs"}
    )
    assert "must be one of" in schema.validate_foreign(
        closed, {"method": "delete_everything", "repo": "r"}
    )
    assert "must be a string" in schema.validate_foreign(
        closed, {"method": "list_workflow_runs", "repo": 5}
    )
    extra = {"method": "list_workflow_runs", "repo": "r", "x": 1}
    assert "unknown argument 'x'" in schema.validate_foreign(closed, extra)


def test_a_call_goes_stale_but_is_not_a_reading():
    """Plan P26: a turn that ran mcp_call is not ingested (ephemeral), and a
    call may change something (not reads_only) — device_notify's declaration."""
    call = tools.REGISTRY["mcp_call"]
    assert call.ephemeral and not call.reads_only
    assert "mcp_call" not in tools.live_reading_tool_names()
    assert "mcp_tools" in tools.live_reading_tool_names()


# -- the tools --------------------------------------------------------------------


@requires_db
async def test_mcp_connect_saves_a_server_and_says_what_it_offers(pool):
    facts: list = []
    with planted(fake.FakeSpec(title="GitHub", tools=(RUNS,))):
        result, ok = await tools.dispatch(
            "mcp_connect", {"name": "github", "url": URL}, _ctx(facts)
        )
    assert ok, result
    assert "Connected github at http://gh.mcp.invalid" in result and "actions_list" in result
    assert (await servers.get(pool, "github")).added_by == "nova"
    assert facts == [
        {
            "mcp_server": "github",
            "tool": None,
            "origin": ORIGIN,
            "protocol": "2026-07-28",
            "reachable": True,
        }
    ]


@requires_db
async def test_no_token_bytes_reach_turn_spans(pool):
    turn = traces.Turn(id=uuid.uuid4(), started_at=datetime.now(UTC))
    arguments = {
        "name": "github",
        "url": URL,
        "token": "ghp_do_not_leak",
        "headers": {"X-Api-Key": "hdr-do-not-leak"},
    }
    call = chat.ToolCall(id="c1", name="mcp_connect", arguments=json.dumps(arguments))
    with planted(fake.FakeSpec(tools=(RUNS,))):
        result, ok = await chat._run_tool(turn, _ctx(), call)
    assert ok, result
    written = json.dumps([span.meta for span in turn.spans], default=str) + result
    assert "ghp_do_not_leak" not in written and "hdr-do-not-leak" not in written


@requires_db
async def test_mcp_connects_token_and_path_never_reach_the_stored_spans(pool):
    """Carry from Task 6 (ruling X2-REVISED), end to end through the real
    chat loop: after mcp_connect runs and the turn is CLOSED — written to
    turn_spans, read back from the table, never from the in-memory span —
    its stored rows carry neither the token, the X-Api-Key header value,
    nor the URL's own secret path (ha-mcp authenticates by one)."""
    token = "ghp_e2e_turn_spans_leak_0"
    header_value = "hdr-e2e-turn-spans-leak-0"
    arguments = {
        "name": "github",
        "url": "http://gh.mcp.invalid/private_abc123/mcp",
        "token": token,
        "headers": {"X-Api-Key": header_value},
    }
    turn = await traces.open_turn(pool, kind="chat")
    call = chat.ToolCall(id="c1", name="mcp_connect", arguments=json.dumps(arguments))
    with planted(fake.FakeSpec(tools=(RUNS,))):
        result, ok = await chat._run_tool(turn, _ctx(), call)
    assert ok, result
    await traces.close_turn(pool, turn, "ok")
    rows = await pool.fetch("SELECT meta FROM turn_spans WHERE turn_id = $1", turn.id)
    assert rows
    written = json.dumps([row["meta"] for row in rows], default=str)
    for secret in (token, header_value, "private_abc123"):
        assert secret not in written


@requires_db
async def test_mcp_call_runs_a_tool_and_files_a_fact(pool):
    facts: list = []
    args = {
        "server": "github",
        "tool": "actions_list",
        "arguments": {"method": "list_workflow_runs", "repo": "nova"},
    }
    async with github(pool):
        result, ok = await tools.dispatch("mcp_call", args, _ctx(facts))
    assert ok and result == "github · actions_list:\nrun 7 on main: failure"
    assert facts[-1]["mcp_server"] == "github" and facts[-1]["tool"] == "actions_list"
    assert facts[-1]["reachable"] is True and facts[-1]["is_error"] is False
    assert (await servers.get(pool, "github")).last_ok_at is not None


@requires_db
async def test_an_unknown_server_is_refused_in_the_stores_own_words(pool):
    """Ruling F13: `_server` raises the store's OWN `no_such_server`
    sentence rather than composing a second copy of the same wording — the
    one source `disconnect` already uses (servers.py)."""
    sentence = await servers.no_such_server(pool, "nope")
    for name, args in (
        ("mcp_call", {"server": "nope", "tool": "x"}),
        ("mcp_tools", {"server": "nope"}),
    ):
        result, ok = await tools.dispatch(name, args, _ctx())
        assert not ok and result == f"Error: {sentence}"


@requires_db
async def test_an_unknown_tool_is_refused_with_the_tools_it_has(pool):
    async with github(pool):
        result, ok = await tools.dispatch("mcp_call", {"server": "github", "tool": "nope"}, _ctx())
    assert not ok and "github has no tool named 'nope'" in result and "actions_list" in result


@requires_db
async def test_arguments_that_break_the_schema_are_refused_with_the_schema(pool):
    args = {
        "server": "github",
        "tool": "actions_list",
        "arguments": {"method": "list_workflow_runs"},
    }
    async with github(pool):
        result, ok = await tools.dispatch("mcp_call", args, _ctx())
    assert not ok and "missing required argument 'repo'" in result and '"enum"' in result


@requires_db
async def test_a_tool_error_is_a_failed_call_in_the_servers_words(pool):
    async with github(pool):
        result, ok = await tools.dispatch("mcp_call", {"server": "github", "tool": "rerun"}, _ctx())
    assert not ok and "github · rerun reported an error: no such run" in result


@requires_db
async def test_a_servers_echoed_credentials_never_reach_mcp_calls_own_words(pool):
    """Carry from Task 5 (ruling T5-A): the client already scrubs every
    server-supplied string at its own decode boundary, so mcp_call adds no
    second scrub. One end-to-end proof instead, through the REAL fake
    server and the REAL client: a tool whose success text and a tool whose
    failure text both echo the token and an X-Api-Key header value — as a
    careless real server might (the GitHub review finding Task 5 fixed at
    its source) — and neither value survives into mcp_call's own words,
    success or failure."""
    token = "ghp_e2e_echo_leak_0000"
    header_value = "hdr-e2e-echo-leak-0000"
    echoed = f"saw token {token} via X-Api-Key {header_value}"
    ok_tool = fake.FakeTool("whoami", results=({"text": echoed},))
    boom_tool = fake.FakeTool("whoami_boom", results=({"text": echoed, "is_error": True},))
    with planted(fake.FakeSpec(tools=(ok_tool, boom_tool))):
        await servers.connect(
            pool,
            name="echo",
            url=URL,
            token=token,
            headers={"X-Api-Key": header_value},
            added_by=servers.BY_OWNER,
            actor="jeremy",
        )
        result, ok = await tools.dispatch("mcp_call", {"server": "echo", "tool": "whoami"}, _ctx())
        assert ok and token not in result and header_value not in result
        result, ok = await tools.dispatch(
            "mcp_call", {"server": "echo", "tool": "whoami_boom"}, _ctx()
        )
        assert not ok and token not in result and header_value not in result


@requires_db
async def test_an_unreachable_server_is_a_stated_failure_and_is_stamped(pool):
    facts: list = []
    args = {
        "server": "github",
        "tool": "actions_list",
        "arguments": {"method": "list_workflow_runs", "repo": "n"},
    }
    async with github(pool):
        handle = client.plant({ORIGIN: fake.Unreachable()})
        try:
            result, ok = await tools.dispatch("mcp_call", args, _ctx(facts))
        finally:
            client.unplant(handle)
    assert not ok and "could not reach github" in result
    assert facts[-1]["reachable"] is False
    assert (await servers.get(pool, "github")).failing is True


@requires_db
async def test_a_long_result_is_cut_at_64_kib_with_a_note(pool):
    async with github(pool):
        result, ok = await tools.dispatch(
            "mcp_call", {"server": "github", "tool": "get_job_logs"}, _ctx()
        )
    assert ok and "[cut at 64 KiB:" in result
    assert len(result.encode()) < 66 * 1024


@requires_db
async def test_mcp_tools_filters_by_every_word_of_the_query(pool):
    async with github(pool):
        result, ok = await tools.dispatch(
            "mcp_tools", {"server": "github", "query": "workflow runs"}, _ctx()
        )
    assert ok and "actions_list" in result and "get_job_logs" not in result
    assert '"required":["method","repo"]' in result


@requires_db
async def test_mcp_disconnect_says_who_had_added_it(pool):
    async with github(pool):
        result, ok = await tools.dispatch("mcp_disconnect", {"name": "github"}, _ctx())
    assert ok and "which the owner had added" in result and "Inbox" in result
    assert await servers.list_servers(pool) == []
