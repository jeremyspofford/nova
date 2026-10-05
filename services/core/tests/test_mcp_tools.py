"""Her MCP tools (S37a), through dispatch and the turn's own span recorder.

Plants are context managers used inside each test (a ContextVar token is
reset in the context that set it)."""

from __future__ import annotations

import contextlib
import json
import uuid
from datetime import UTC, datetime

import pytest

from app import chat, tools, traces
from app.identity import Person
from app.main import app
from app.mcp import client, fake, servers
from app.tools import mcp as mcp_module
from app.tools import schema
from app.tools.base import ToolFailure
from tests.conftest import TEST_DSN, requires_db
from tests.fakes import FakeMemory, ScriptedGateway
from tests.test_chat_card import frames, set_chat_model, text, whole_call


@pytest.fixture(scope="module", autouse=True)
def _wipe_mcp_tables_once_the_file_is_done():
    """Fix round 2, ruling C: `pool` truncates fresh at the START of every
    test, so nothing in THIS module ever reads another test's leftovers —
    but nothing truncates again once the LAST test in the module finishes,
    and several tests here write real rows (`servers.connect`, or a real
    chat turn through `owner_client`) that a `pool`-fixture-only cleanup
    never reaches. Left alone, whichever test happens to be collected last
    decides what `mcp_servers`, `governance_events` and `notices` hold for
    whoever reads this scratch database next — an order-dependent flake.
    Plain (sync) on purpose: its teardown opens its OWN short-lived
    connection via `asyncio.run`, never the function-scoped `pool` fixture
    (torn down per test, and not a dependency a module-scoped fixture may
    take), so it has nothing to do with whatever event loop the tests
    themselves ran on."""
    yield
    if not TEST_DSN:
        return
    import asyncio

    import asyncpg

    async def _wipe() -> None:
        conn = await asyncpg.connect(TEST_DSN)
        try:
            await conn.execute(
                "TRUNCATE mcp_servers, governance_events, notices, notice_mutes "
                "RESTART IDENTITY CASCADE"
            )
        finally:
            await conn.close()

    asyncio.run(_wipe())


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
    # M4: the exact 7-key shape, every key, every value — not just a sample
    # of the keys a looser check could miss a regression in.
    assert facts == [
        {
            "mcp_server": "github",
            "tool": "actions_list",
            "origin": ORIGIN,
            "protocol": "2026-07-28",
            "reachable": True,
            "is_error": False,
            "bytes": len(b"run 7 on main: failure"),
        }
    ]
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
    # Ruling T7-E: the server ANSWERED — a tool's own isError is its answer,
    # never a failing server. The row is not marked failing for it.
    assert (await servers.get(pool, "github")).failing is False


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
    # Ruling B: the cut notice's own bytes count toward the cap, so the
    # WHOLE result — notice included — is at or under it, never over.
    assert len(result.encode()) <= mcp_module.RESULT_CAP_BYTES


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


# -- fix round 1: T7-B, validate_foreign never raises and refuses only what it can be sure of ----


@pytest.mark.parametrize(
    ("label", "sch", "args"),
    [
        ("required: true (a draft-03 habit)", {"type": "object", "required": True}, {}),
        ("required: 5", {"type": "object", "required": 5}, {}),
        (
            "required as a bare string",
            {"type": "object", "properties": {"repo": {"type": "string"}}, "required": "repo"},
            {"repo": "nova"},
        ),
        (
            "patternProperties + additionalProperties: false",
            {
                "type": "object",
                "patternProperties": {"^x-": {"type": "string"}},
                "additionalProperties": False,
            },
            {"x-trace": "1"},
        ),
        (
            "integer given 1.0 (valid from JSON Schema draft 6 on)",
            {"type": "object", "properties": {"n": {"type": "integer"}}},
            {"n": 1.0},
        ),
    ],
)
def test_validate_foreign_never_raises_on_a_shape_the_client_already_admits(label, sch, args):
    """Ruling T7-B: every one of these schemas passes the client's own
    `_tool_problem` (so a real server's definition IS accepted and stored),
    and a draft-03 `required`, a bare-string `required`, `patternProperties`
    and a whole-number float used to make `validate_foreign` refuse a call
    the server would have accepted — or, for the first two, raise a
    TypeError the model would have seen as "mcp_call failed unexpectedly"."""
    assert client._tool_problem({"name": "t", "inputSchema": sch}) is None, label
    assert schema.validate_foreign(sch, args) is None, label


def test_validate_foreign_still_refuses_a_bool_as_an_integer():
    """The float-tolerance (T7-B) must not widen into accepting a bool —
    `type(True) is float` is False, so `_foreign_type_matches` never even
    reaches `.is_integer()` for one; this is the regression that would
    silently pass if the check were done by `isinstance` instead."""
    sch = {"type": "object", "properties": {"n": {"type": "integer"}}}
    assert "must be an integer" in schema.validate_foreign(sch, {"n": True})


def test_validate_foreign_never_raises_on_a_schema_shaped_in_a_way_it_cannot_read():
    """The structural half of ruling T7-B: ANY exception reading the schema
    — not only the four probed shapes above — means "not sure", never a
    crash. `required` holding a list of non-hashable, non-string junk is a
    shape no specific branch above anticipates."""
    sch = {"type": "object", "required": [{"not": "a string"}], "properties": {}}
    assert schema.validate_foreign(sch, {}) is None


# -- fix round 1: T7-C, a lone UTF-16 surrogate never fails a finished call -----------------


@requires_db
async def test_a_lone_surrogate_in_a_tools_text_never_fails_a_finished_call(pool):
    """Ruling T7-C: a JS server that slices a response mid-emoji hands back
    a string `json.loads` accepts but UTF-8 cannot encode. Before the fix
    this raised UnicodeEncodeError deep inside `mcp_call` — reported to her
    as "failed unexpectedly", no fact filed, and the row stamped ok anyway
    (three different answers to the one call). It must read as what it is:
    a finished, successful call, with U+FFFD standing in for the broken
    half of the pair."""
    half_emoji = fake.FakeTool("half_emoji", results=({"text": "log tail: build ok \ud83d"},))
    facts: list = []
    with planted(fake.FakeSpec(tools=(half_emoji,))):
        await servers.connect(
            pool, name="github", url=URL, added_by=servers.BY_OWNER, actor="jeremy"
        )
        result, ok = await tools.dispatch(
            "mcp_call", {"server": "github", "tool": "half_emoji"}, _ctx(facts)
        )
    assert ok, result
    assert result == "github · half_emoji:\nlog tail: build ok �"
    assert facts == [
        {
            "mcp_server": "github",
            "tool": "half_emoji",
            "origin": ORIGIN,
            "protocol": "2026-07-28",
            "reachable": True,
            "is_error": False,
            "bytes": len("log tail: build ok �".encode()),
        }
    ]
    row = await servers.get(pool, "github")
    assert row.last_ok_at is not None and row.failing is False


# -- fix round 1: T7-A, the 64 KiB cap covers everything a server sends ---------------------


@requires_db
async def test_a_huge_server_error_message_is_capped(pool):
    big = fake.FakeTool("big_err", results=({"error": {"code": -32603, "message": "E" * 200_000}},))
    with planted(fake.FakeSpec(tools=(big,))):
        await servers.connect(
            pool, name="github", url=URL, added_by=servers.BY_OWNER, actor="jeremy"
        )
        result, ok = await tools.dispatch(
            "mcp_call", {"server": "github", "tool": "big_err"}, _ctx()
        )
    assert not ok
    # Ruling A/T7-A2: dispatch adds its own fixed "Error: " prefix on top of
    # whatever the (now-structurally-capped) ToolFailure reason carries —
    # the only overhead outside this module's own guarantee.
    assert len(result.encode()) <= mcp_module.RESULT_CAP_BYTES + len(tools.ERROR_PREFIX)
    assert "[cut at 64 KiB:" in result


@requires_db
async def test_many_non_object_notes_are_bounded_before_being_composed(pool):
    """A response built of one text block and 20,000 non-object content
    entries used to produce a 1.38M-character result (about 140 MB at the
    client's own 4 MiB bound) — the notes were joined BEFORE the cap ever
    saw them. Bounding the COUNT first means this never even has to lean on
    the byte cap to stay small."""

    class ManyBlocks(fake.FakeServer):
        def _call(self, rid, params, *, modern):
            result = {
                "content": [{"type": "text", "text": "ok"}] + [0] * 20_000,
                "isError": False,
                "resultType": "complete",
            }
            return self._answer(rid, result)

    spec = fake.FakeSpec(tools=(fake.FakeTool("many"),))
    handle = client.plant({ORIGIN: fake.transport(ManyBlocks(spec))})
    try:
        await servers.connect(
            pool, name="github", url=URL, added_by=servers.BY_OWNER, actor="jeremy"
        )
        result, ok = await tools.dispatch("mcp_call", {"server": "github", "tool": "many"}, _ctx())
    finally:
        client.unplant(handle)
    assert ok
    assert len(result.encode()) <= mcp_module.RESULT_CAP_BYTES
    assert "more notes)" in result


@requires_db
async def test_a_long_tool_name_is_clipped_in_mcp_tools_and_the_no_such_tool_refusal(pool):
    long_name = "x" * 500
    weird = fake.FakeTool(long_name, "d")
    with planted(fake.FakeSpec(tools=(weird,))):
        await servers.connect(
            pool, name="github", url=URL, added_by=servers.BY_OWNER, actor="jeremy"
        )
        listed, ok1 = await tools.dispatch("mcp_tools", {"server": "github"}, _ctx())
        refused, ok2 = await tools.dispatch(
            "mcp_call", {"server": "github", "tool": "nope"}, _ctx()
        )
    assert ok1 and long_name not in listed and ("x" * 120 + "…") in listed
    assert not ok2 and long_name not in refused and ("x" * 120 + "…") in refused
    # The instructional suffix must survive the clip, not just the cap.
    assert refused.endswith("re-issue the call")


@requires_db
async def test_mcp_connect_clips_a_long_tool_name_in_its_own_reply(pool):
    long_name = "x" * 500
    weird = fake.FakeTool(long_name, "d")
    with planted(fake.FakeSpec(tools=(weird,))):
        result, ok = await tools.dispatch("mcp_connect", {"name": "github", "url": URL}, _ctx())
    assert ok and long_name not in result and ("x" * 120 + "…") in result


@requires_db
async def test_mcp_connect_clips_a_long_tool_name_in_its_rejected_list_too(pool):
    """Clipped twice over now (fix round 2, ruling T7-A2): `client.
    _tool_problem`'s own caller clips the name at the source before it
    ever reaches `rejected`, and `mcp.py`'s `_clip_name` clips again — so
    the exact boundary is an internal detail of two cooperating defences,
    never pinned tighter than "the full name never appears, a clipped
    prefix does"."""
    long_name = "y" * 500
    broken = fake.FakeTool(long_name, "d", input_schema="not an object")
    with planted(fake.FakeSpec(tools=(broken,))):
        result, ok = await tools.dispatch("mcp_connect", {"name": "github", "url": URL}, _ctx())
    assert ok and long_name not in result and ("y" * 100) in result
    assert "its inputSchema is not an object" in result


# -- fix round 1: M1, mcp_call's refresh-on-a-miss stamps like mcp_tools's does -------------


@requires_db
async def test_mcp_calls_refresh_on_a_missing_tool_files_the_refresh_fact_on_success(pool):
    facts: list = []
    async with github(pool):
        result, ok = await tools.dispatch(
            "mcp_call", {"server": "github", "tool": "nope"}, _ctx(facts)
        )
    assert not ok and "github has no tool named 'nope'" in result
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
async def test_mcp_calls_refresh_on_a_missing_tool_stamps_failing_when_unreachable(pool):
    facts: list = []
    async with github(pool):
        handle = client.plant({ORIGIN: fake.Unreachable()})
        try:
            result, ok = await tools.dispatch(
                "mcp_call", {"server": "github", "tool": "nope"}, _ctx(facts)
            )
        finally:
            client.unplant(handle)
    assert not ok
    assert "has no tool named 'nope'" in result and "its list could not be read again" in result
    assert facts == [
        {
            "mcp_server": "github",
            "tool": None,
            "origin": ORIGIN,
            "protocol": "2026-07-28",
            "reachable": False,
        }
    ]
    assert (await servers.get(pool, "github")).failing is True


# -- fix round 1: M2, the X2-REVISED pin through the real scripted chat loop ----------------


@requires_db
async def test_mcp_connect_through_the_real_chat_loop_leaves_no_secret_in_turn_spans(
    owner_client, pool, mount_peers
):
    """M2: the stored-row pin (test_mcp_connects_token_and_path_never_reach_the_stored_spans
    above) drives chat._run_tool directly. This drives the actual scripted
    model + /api/v1/chat/stream route — ScriptedGateway calls mcp_connect
    exactly as a real backend's tool_calls would — and reads turn_spans by
    the turn id the route itself reports, never the in-memory span."""
    origin = "https://ha.mcp.invalid"
    token = "ghp_scripted_turn_leak_000"
    header_value = "hdr-scripted-turn-leak-000"
    handle = client.plant({origin: fake.transport(fake.FakeServer(fake.FakeSpec(tools=(RUNS,))))})
    try:
        gateway = ScriptedGateway(
            rounds=(
                (
                    whole_call(
                        "call_1",
                        "mcp_connect",
                        {
                            "name": "ha",
                            "url": f"{origin}/private_abc123/mcp",
                            "token": token,
                            "headers": {"X-Api-Key": header_value},
                        },
                    ),
                ),
                (text("Connected to Home Assistant."),),
            )
        )
        mount_peers(gateway=gateway, memory=FakeMemory())
        await set_chat_model(owner_client)
        resp = await owner_client.post("/api/v1/chat/stream", json={"message": "connect ha"})
        assert resp.status_code == 200, resp.text
        sent = frames(resp.text)
    finally:
        client.unplant(handle)
    turn_id = sent[0]["meta"]["turn_id"]
    rows = await pool.fetch("SELECT meta FROM turn_spans WHERE turn_id = $1", turn_id)
    assert rows
    written = json.dumps([row["meta"] for row in rows], default=str) + json.dumps(sent, default=str)
    for secret in (token, header_value, "private_abc123"):
        assert secret not in written


# -- fix round 1: M3, a 401 that echoes credentials never reaches mcp_call's words ----------


@pytest.mark.parametrize("rpc_shaped", [False, True])
@requires_db
async def test_a_401_that_echoes_credentials_never_reaches_mcp_calls_failure_text(pool, rpc_shaped):
    """The Task 5 carry's own named scenario: a 401 body that echoes the
    credentials back (both shapes measured in the wild — a plain `{"error":
    …}` object and a JSON-RPC error envelope) must not reach `mcp_call`'s
    failure text or the row's `last_error`."""
    token = "ghp_401_echo_leak_0000000"
    header_value = "hdr-401-echo-leak-0000000"

    class Echo401(fake.FakeServer):
        def _call(self, rid, params, *, modern):
            said = f"token {token} and X-Api-Key {header_value} are not valid here"
            if rpc_shaped:
                body = {"jsonrpc": "2.0", "id": rid, "error": {"code": -32001, "message": said}}
            else:
                body = {"error": said}
            return 401, {"content-type": "application/json"}, json.dumps(body).encode()

    spec = fake.FakeSpec(tools=(fake.FakeTool("whoami"),))
    handle = client.plant({ORIGIN: fake.transport(Echo401(spec))})
    try:
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
    finally:
        client.unplant(handle)
    row = await servers.get(pool, "echo")
    assert not ok
    assert token not in result and header_value not in result
    assert token not in (row.last_error or "") and header_value not in (row.last_error or "")


# -- fix round 1: M4, pinning the shapes that were already right -----------------------------


@requires_db
async def test_mcp_connects_own_refusal_fact_has_three_keys_for_a_bad_name(pool):
    facts: list = []
    result, ok = await tools.dispatch("mcp_connect", {"name": "Bad Name", "url": URL}, _ctx(facts))
    assert not ok
    assert facts == [{"mcp_server": "Bad Name", "tool": None, "reachable": None}]


@requires_db
async def test_mcp_connects_own_refusal_fact_has_three_keys_for_an_unreachable_server(pool):
    facts: list = []
    handle = client.plant({ORIGIN: fake.Unreachable()})
    try:
        result, ok = await tools.dispatch(
            "mcp_connect", {"name": "github", "url": URL}, _ctx(facts)
        )
    finally:
        client.unplant(handle)
    assert not ok
    assert facts == [{"mcp_server": "github", "tool": None, "reachable": False}]


@requires_db
async def test_mcp_tools_refreshes_a_stale_list_and_files_the_five_key_fact(pool):
    facts: list = []
    with planted(fake.FakeSpec(ttl_ms=0, tools=(RUNS,))):
        await servers.connect(
            pool, name="github", url=URL, added_by=servers.BY_OWNER, actor="jeremy"
        )
        result, ok = await tools.dispatch("mcp_tools", {"server": "github"}, _ctx(facts))
    assert ok and "actions_list" in result
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
async def test_mcp_tools_refresh_failure_stamps_failing_and_notes_the_stale_list(pool):
    facts: list = []
    with planted(fake.FakeSpec(ttl_ms=0, tools=(RUNS,))):
        await servers.connect(
            pool, name="github", url=URL, added_by=servers.BY_OWNER, actor="jeremy"
        )
        handle = client.plant({ORIGIN: fake.Unreachable()})
        try:
            result, ok = await tools.dispatch("mcp_tools", {"server": "github"}, _ctx(facts))
        finally:
            client.unplant(handle)
    assert ok  # the stale list is still shown, with a note it could not be refreshed
    assert "Could not read the list again" in result
    assert facts == [
        {
            "mcp_server": "github",
            "tool": None,
            "origin": ORIGIN,
            "protocol": "2026-07-28",
            "reachable": False,
        }
    ]
    assert (await servers.get(pool, "github")).failing is True


@requires_db
async def test_mcp_tools_maps_a_refresh_servererror_to_a_stated_failure(pool, monkeypatch):
    """Task 5 carry: `refresh_tools` may raise `ServerError` when the row
    changed under it. Simulated by monkeypatching the store's own function
    (a genuine race is not reproducible deterministically through the tool
    layer alone) — `mcp_tools` must map it to a stated ToolFailure, never a
    crash, and record nothing (the row was never actually read from)."""
    with planted(fake.FakeSpec(ttl_ms=0, tools=(RUNS,))):
        await servers.connect(
            pool, name="github", url=URL, added_by=servers.BY_OWNER, actor="jeremy"
        )

        async def changed(pool, server, *, actor):
            raise servers.ServerError(
                f"{server.name} changed while its tools were being read; nothing was recorded"
            )

        monkeypatch.setattr(servers, "refresh_tools", changed)
        result, ok = await tools.dispatch("mcp_tools", {"server": "github"}, _ctx())
    assert not ok and "changed while its tools were being read" in result


@requires_db
async def test_mcp_call_folds_a_refresh_servererror_into_the_no_tool_refusal(pool, monkeypatch):
    async with github(pool):

        async def changed(pool, server, *, actor):
            raise servers.ServerError(
                f"{server.name} changed while its tools were being read; nothing was recorded"
            )

        monkeypatch.setattr(servers, "refresh_tools", changed)
        result, ok = await tools.dispatch("mcp_call", {"server": "github", "tool": "nope"}, _ctx())
    assert not ok
    assert "has no tool named 'nope'" in result
    assert "changed while its tools were being read" in result


@requires_db
async def test_mcp_connect_replacing_a_server_names_only_the_origin_never_the_path(pool):
    old_origin = "http://old.mcp.invalid"
    new_origin = "http://new.mcp.invalid"
    old_handle = client.plant(
        {old_origin: fake.transport(fake.FakeServer(fake.FakeSpec(tools=(fake.FakeTool("a"),))))}
    )
    new_handle = client.plant(
        {new_origin: fake.transport(fake.FakeServer(fake.FakeSpec(tools=(fake.FakeTool("b"),))))}
    )
    try:
        await servers.connect(
            pool,
            name="github",
            url=f"{old_origin}/secret_path/mcp",
            added_by=servers.BY_OWNER,
            actor="jeremy",
        )
        result, ok = await tools.dispatch(
            "mcp_connect", {"name": "github", "url": f"{new_origin}/mcp"}, _ctx()
        )
    finally:
        client.unplant(new_handle)
        client.unplant(old_handle)
    assert ok
    assert f"It replaced the github that the owner had added, at {old_origin}." in result
    assert "secret_path" not in result


# -- fix round 2: ruling T7-A2, the cap is structural -----------------------------------------


@requires_db
async def test_mcp_connects_reply_is_capped_even_for_a_rejected_tools_huge_header_value(
    pool, caplog
):
    """The re-reviewer's own probe: `client._tool_problem` used to embed a
    server's `x-mcp-header` value verbatim, with no length bound — a
    300,000-char value made mcp_connect's reply 300,283 chars, 234,747
    bytes over the cap. Fixed at the source (`_tool_problem` clips what it
    embeds) AND structurally (`_bounded` wraps every executor): either one
    alone would have caught this; both apply. Ruling D rides here too: the
    log line must carry the clipped value, never the raw one."""
    huge_header_name = "A" * 300_000
    broken = fake.FakeTool(
        "weird_tool",
        "d",
        input_schema={
            "type": "object",
            "properties": {
                "h": {"type": "object", "x-mcp-header": huge_header_name, "properties": {}}
            },
        },
    )
    with caplog.at_level("WARNING"):
        with planted(fake.FakeSpec(tools=(broken,))):
            result, ok = await tools.dispatch("mcp_connect", {"name": "github", "url": URL}, _ctx())
    assert ok, result
    assert huge_header_name not in result
    assert len(result.encode()) <= mcp_module.RESULT_CAP_BYTES
    # Ruling D: the warning carries the CLIPPED value, never the raw one.
    warnings = [r.getMessage() for r in caplog.records if r.levelname == "WARNING"]
    assert any("left out tool" in w for w in warnings)
    assert all(huge_header_name not in w for w in warnings)


@requires_db
async def test_mcp_connect_lists_at_most_20_rejected_tools_and_counts_the_rest(pool):
    broken = tuple(
        fake.FakeTool(f"broken_{i}", "d", input_schema="not an object") for i in range(50)
    )
    with planted(fake.FakeSpec(tools=broken)):
        result, ok = await tools.dispatch("mcp_connect", {"name": "github", "url": URL}, _ctx())
    assert ok, result
    assert "50 of its tools were left out" in result
    for i in range(20):
        assert f"broken_{i}:" in result
    for i in range(20, 50):
        assert f"broken_{i}:" not in result
    assert "and 30 more" in result


async def test_the_structural_wrapper_caps_both_a_return_and_a_toolfailure_reason():
    """`_bounded` in isolation, independent of any specific executor's own
    logic — the PUREST proof of the structural guarantee: whatever an
    executor does, neither path can produce more than RESULT_CAP_BYTES."""

    async def huge_return(args: dict, ctx) -> str:
        return "R" * 200_000

    async def huge_failure(args: dict, ctx) -> str:
        raise ToolFailure("E" * 200_000)

    wrapped_return = mcp_module._bounded(huge_return)
    wrapped_failure = mcp_module._bounded(huge_failure)

    result = await wrapped_return({}, _ctx())
    assert len(result.encode()) <= mcp_module.RESULT_CAP_BYTES

    with pytest.raises(ToolFailure) as caught:
        await wrapped_failure({}, _ctx())
    assert len(str(caught.value).encode()) <= mcp_module.RESULT_CAP_BYTES


@pytest.mark.parametrize("name", ["mcp_connect", "mcp_disconnect", "mcp_tools", "mcp_call"])
def test_every_registered_mcp_executor_is_wrapped_by_the_structural_cap(name):
    """Not just that `_bounded` WORKS (the isolated test above) — that all
    FOUR registry entries actually USE it, so a fifth tool added later (or
    one of these four quietly un-wrapped by a future edit) reddens here
    instead of silently reopening the gap a rejected tool's reason fell
    through."""
    bare = {
        "mcp_connect": mcp_module.mcp_connect,
        "mcp_disconnect": mcp_module.mcp_disconnect,
        "mcp_tools": mcp_module.mcp_tools,
        "mcp_call": mcp_module.mcp_call,
    }[name]
    assert tools.REGISTRY[name].executor is not bare
    assert tools.REGISTRY[name].executor.__wrapped__ is bare


# -- fix round 2: ruling B, _capped keeps its own promise --------------------------------------


def test_capped_keeps_its_own_promise_the_whole_result_fits():
    """The cut notice's own bytes used to be appended AFTER the slice, so a
    capped result ran 118 bytes over the cap. `_capped`'s OWN output, on
    its own — not through any executor or wrapper — must fit."""
    result = mcp_module._capped("E" * 200_000)
    assert len(result.encode("utf-8")) <= mcp_module.RESULT_CAP_BYTES
    assert "[cut at 64 KiB:" in result


def test_capped_leaves_short_text_alone():
    assert mcp_module._capped("hello") == "hello"
