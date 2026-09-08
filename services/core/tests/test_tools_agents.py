"""S12-3: her agent tools (tools/agents.py) and agents.delegate.

What these pin, and why each is a pin and not a wish:
  * the five tools are registered and shaped as the API is: create/update
    take exactly the POST body's field names (v3 dropped an operator-only
    field from the chat tool silently), delegate and list are listing-kind;
  * importing the tools package cold loads neither app.chat nor app.agents
    (the cycle is real — app.agents imports app.tools at its top), and the
    two modules reach each other only inside functions;
  * create makes the row AND the folder and states the route the gateway
    echoed; update/delete go through the one writer (a delete names the
    timer it paused and what remains);
  * list_agents is the SAME derivation the Agents page reads (working/idle
    from traces.DOING plus an open row; spend from ONE ledger report; an
    unreadable ledger is said, never 0);
  * a delegation opens the agent's own turn (kind agent, its id and role,
    the CALLER's person, its log conversation), puts the code-composed
    brief in the log as a user row, reads the status and the report BACK
    from the database, derives the files from the child's write spans
    (never from its words), appends the facts to the sink before deciding
    ok — so Nova's delegate span carries them on success and on failure —
    and relays the child's steps as progress dicts that reach Nova's stream
    as activity frames under HER call, never as a second meta or [DONE];
  * a child that did not finish is an `Error:` result with the statement
    and the facts; an agent's turn cannot delegate; a name no agent has is
    refused naming the live ones; the Cap line appears only when the ledger
    could not be read.
"""

from __future__ import annotations

import ast
import asyncio
import contextlib
import dataclasses
import inspect
import re
import subprocess
import sys
import uuid
from datetime import UTC, datetime
from decimal import Decimal
from pathlib import Path

import pytest

from app import agents, agents_api, chat, governance, timers, tools, traces
from app.agents import Agent, RunFacts
from app.main import app
from app.tools import agents as agent_tools
from app.tools.base import RESULT_KIND_LISTING
from tests.conftest import requires_db
from tests.fakes import FakeGateway, FakeMemory, Refusal, ScriptedGateway
from tests.test_chat_agents import (
    MODEL,
    _agent_turn,
    _create,
    _explain,
    _nova_turn,
    _owner,
    _parsed,
    _reply,
    _spans,
)
from tests.test_chat_tools import text, whole_call

pytestmark = requires_db

CORE_DIR = Path(__file__).resolve().parent.parent
FIVE = ("delegate_to_agent", "create_agent", "update_agent", "delete_agent", "list_agents")
CANNOT = "Error: an agent cannot delegate — put what you need in your report and Nova will route it"


@pytest.fixture
def root(monkeypatch, tmp_path) -> Path:
    root = tmp_path / "ws"
    monkeypatch.setenv("WORKSPACE_ROOT", str(root))
    return root


@pytest.fixture(autouse=True)
def _clean_doing():
    traces.DOING.clear()
    yield
    traces.DOING.clear()


def _ctx(person, *, progress=None) -> tools.ToolContext:
    """The context a turn hands its tools, with a facts sink (as _run_turn
    builds it) and, when given, a progress channel (as _dispatch_calls binds
    it per call)."""
    ctx = tools.context_for(app, person, facts_sink=[])
    return dataclasses.replace(ctx, progress=progress) if progress is not None else ctx


def _spend(*rows: dict) -> dict:
    return {"window": "month", "timezone": "UTC", "totals": {"usd": 0}, "by_role": list(rows)}


def _agent_value(**over) -> Agent:
    """An Agent VALUE for the pure tests — no row, no database."""
    now = datetime.now(UTC)
    fields = dict(
        id=uuid.uuid4(),
        name="coder",
        purpose="writes code",
        instructions="Write small, tested changes.",
        tools=("workspace_write_file",),
        skills=(),
        monthly_cap_usd=None,
        max_tool_rounds=8,
        read_shared_memory=False,
        log_conversation_id=None,
        created_via="chat",
        created_turn_id=None,
        created_at=now,
        updated_at=now,
    )
    fields.update(over)
    return Agent(**fields)


async def _child(pool):
    (row,) = await pool.fetch(
        "SELECT id, kind, agent_id, role, person_id, conversation_id, status, model FROM turns "
        "WHERE kind = 'agent'"
    )
    return row


# ── registration and shape ─────────────────────────────────────────────────


def test_the_five_tools_are_registered_and_shaped_like_the_api():
    """create/update take EXACTLY the API's POST body field names (one field
    table for both, pinned against agents_api.SPEC_FIELDS), delegate and
    list are listing-kind, and the delegation sentence is in Nova's stable
    prompt by the tool's registration alone."""
    assert all(name in tools.REGISTRY for name in FIVE)
    create = tools.REGISTRY["create_agent"].parameters
    update = tools.REGISTRY["update_agent"].parameters
    assert set(create["properties"]) == agents_api.SPEC_FIELDS
    assert create["required"] == list(agents_api.REQUIRED_FIELDS)
    assert set(update["properties"]) == agents_api.SPEC_FIELDS
    assert update["required"] == ["name"]
    assert create["properties"] == update["properties"]
    assert set(agents.UPDATABLE) == agents_api.SPEC_FIELDS - {"name"}
    # null is a value the page can send for the cap, so the tool's schema
    # declares no JSON type for it (the store's validator is the rule).
    assert "type" not in create["properties"]["monthly_cap_usd"]
    assert set(tools.REGISTRY["delete_agent"].parameters["properties"]) == {"name"}
    assert tools.REGISTRY["list_agents"].parameters["properties"] == {}
    delegate = tools.REGISTRY["delegate_to_agent"].parameters
    assert set(delegate["properties"]) == {"agent", "task", "context", "deliverable"}
    assert delegate["required"] == ["agent", "task"]
    assert tools.REGISTRY["delegate_to_agent"].result_kind == RESULT_KIND_LISTING
    assert tools.REGISTRY["list_agents"].result_kind == RESULT_KIND_LISTING
    for name in ("create_agent", "update_agent", "delete_agent"):
        assert tools.REGISTRY[name].result_kind is None and not tools.REGISTRY[name].ephemeral
    assert agents.DELEGATE_TOOL == "delegate_to_agent"
    assert f" {agents.DELEGATE_TOOL} runs an agent to completion" in chat.stable_system_prompt(
        MODEL, tools.tool_names()
    )
    assert set(FIVE) <= set(agents.nova_persona().tool_names)


def test_the_round_budget_in_the_schema_is_the_stores_own_range():
    """tools/agents.py cannot import app.agents at module level (the cycle
    above), so the round bounds in its schema are literals — and literals
    that drift from agents.MIN_ROUNDS/MAX_ROUNDS advertise a range the one
    validator then refuses in words, or hide one it would accept. There is
    no import that can derive them here, so this pin IS the mechanism that
    keeps the two equal. (2026-09-08)"""
    rounds = agent_tools._FIELDS["max_tool_rounds"]
    assert (rounds["minimum"], rounds["maximum"]) == (agents.MIN_ROUNDS, agents.MAX_ROUNDS)
    # The sentence the model reads says the same range as the schema.
    assert f"{agents.MIN_ROUNDS}..{agents.MAX_ROUNDS}" in rounds["description"]


def test_importing_the_tools_package_cold_loads_neither_chat_nor_agents():
    """The cycle: app.agents imports app.tools at module level, chat imports
    agents. So tools/agents.py reaches app.agents only inside functions and
    app/agents.py reaches chat only inside delegate — a "tidy" hoist of
    either is the models_catalog → chat → tools crash again. Pinned in a
    subprocess (what a script or a shell does) and by the AST."""
    code = (
        "import sys, app.tools; "
        "print(sorted(m for m in ('app.chat', 'app.agents') if m in sys.modules))"
    )
    proc = subprocess.run(
        [sys.executable, "-c", code], capture_output=True, text=True, cwd=str(CORE_DIR)
    )
    assert proc.returncode == 0, proc.stderr
    assert proc.stdout.strip() == "[]"

    def top_level_app_imports(module) -> set[str]:
        tree = ast.parse(Path(module.__file__).read_text(encoding="utf-8"))
        found: set[str] = set()
        for node in tree.body:
            if isinstance(node, ast.ImportFrom) and (node.module or "").startswith("app"):
                found.update(f"{node.module}.{alias.name}" for alias in node.names)
            elif isinstance(node, ast.Import):
                found.update(alias.name for alias in node.names if alias.name.startswith("app"))
        return found

    assert not {"app.agents", "app.chat"} & top_level_app_imports(agent_tools)
    assert "app.chat" not in top_level_app_imports(agents)
    # chat is named inside delegate, and nowhere else in app/agents.py.
    source = inspect.getsource(agents)
    assert source.count("from app import chat") == 1
    assert "from app import chat" in inspect.getsource(agents.delegate)


# ── the brief and the result, word for word ────────────────────────────────


def test_the_brief_is_code_composed_word_for_word():
    agent = _agent_value(max_tool_rounds=8)
    head = (
        "[Task from Nova for agent coder. You work for Jeremy; they are not in this thread and "
        "will read Nova's relay of your report. Your workspace folder is agents/coder/ — every "
        "path you read or write is inside it. You have 8 tool rounds. When you finish, reply "
        "with a report: what you did, what you found, every file you wrote (paths), and "
        "anything you could not do and why.]\n\nTask: write a haiku"
    )
    assert agents.compose_brief(agent, "write a haiku", None, None, owner_name="Jeremy") == head
    assert agents.compose_brief(agent, " write a haiku\n", "  ", "", owner_name="Jeremy") == head
    assert agents.compose_brief(
        agent, "write a haiku", "he likes autumn", "haiku.md", owner_name="Jeremy"
    ) == (head + "\n\nContext from Nova: he likes autumn\n\nDeliverable: haiku.md")


def test_the_result_puts_the_facts_first_and_labels_the_report():
    turn_id = uuid.UUID(int=1)
    full = RunFacts(
        agent="coder",
        turn_id=turn_id,
        status="ok",
        rounds=3,
        calls_ok=3,
        calls_failed=1,
        seconds=41.2,
        cost_usd=0.0032,
        priced_rounds=3,
        files=("notes/plan.md", "src/x.py"),
        unreadable_writes=1,
        failed_calls=("fetch_url — could not reach it",),
        notes=("coder's own turn recorded a narration correction",),
        cap_unreadable="could not reach the gateway",
    )
    assert agents.compose_result(full, "all done") == (
        f"[coder finished: status ok · 3 tool rounds · 4 calls (3 ok, 1 failed) · 41 s · "
        f"$0.0032 · trace {turn_id}]\n"
        "Files written in agents/coder/: notes/plan.md, src/x.py; plus 1 successful write whose "
        "path could not be read from the trace\n"
        "Calls that failed: fetch_url — could not reach it\n"
        "Notes: coder's own turn recorded a narration correction\n"
        "Cap: unchecked this run — the ledger could not be read (could not reach the gateway)\n"
        "--- coder's report (its words; only the facts above are verified) ---\n"
        "all done"
    )
    assert full.as_facts() == {
        "agent": "coder",
        "agent_turn_id": str(turn_id),
        "status": "ok",
        "files": ["notes/plan.md", "src/x.py"],
        "rounds": 3,
        "calls_ok": 3,
        "calls_failed": 1,
    }
    bare = dataclasses.replace(
        full,
        rounds=1,
        calls_ok=0,
        calls_failed=0,
        seconds=0.42,
        cost_usd=None,
        priced_rounds=0,
        files=(),
        unreadable_writes=0,
        failed_calls=(),
        notes=(),
        cap_unreadable=None,
    )
    assert agents.compose_result(bare, "nothing to do") == (
        f"[coder finished: status ok · 1 tool round · 0 calls (0 ok, 0 failed) · 0.4 s · "
        f"unmetered · trace {turn_id}]\n"
        "Files written in agents/coder/: none\n"
        "--- coder's report (its words; only the facts above are verified) ---\n"
        "nothing to do"
    )
    assert bare.line() == (
        f"agent coder · turn {turn_id} · status ok · 1 round · 0 calls (0 ok, 0 failed) · "
        "files: none"
    )
    # A cost that covers only SOME of the rounds says so: the figure is the
    # sum over the rounds the gateway priced, and '$0.0032' alone would read
    # as what the whole run cost. (2026-09-08)
    part = dataclasses.replace(full, rounds=2, priced_rounds=1)
    assert agents.compose_result(part, "all done").splitlines()[0] == (
        f"[coder finished: status ok · 2 tool rounds · 4 calls (3 ok, 1 failed) · 41 s · "
        f"$0.0032 (1 of 2 rounds priced) · trace {turn_id}]"
    )


def test_run_facts_are_derived_from_the_spans_never_the_words():
    """Files = the paths of SUCCESSFUL workspace_write_file spans; a failed
    write is a failed call, not a file; a successful write whose argument
    record was clipped is counted as unreadable, not dropped — whether the
    WHOLE record degraded to a string or just the path was cut to a head; a
    guard span is a note; the cap line only when the ledger read fell open."""
    agent = _agent_value()
    turn = traces.Turn(id=uuid.UUID(int=2), started_at=datetime.now(UTC), agent_id=agent.id)
    now = datetime.now(UTC)
    # The path as the TRACE would hold it, cut by chat's own redactor — not a
    # marker typed out here: agents.CLIP_MARKER is what chat._clip appends,
    # and this is the pin that goes red if the clipper's wording moves.
    clipped_path = chat._redact({"path": "notes/" + "x" * 400 + ".md"})["path"]
    assert agents.CLIP_MARKER in clipped_path and len(clipped_path) > chat.SPAN_ARG_HEAD_CHARS

    def span(kind, name, **meta):
        turn.spans.append(traces.Span(kind, name, now, 1, meta))

    span("agent_cap", None, role="agent_coder", cap_usd=5.0, ledger="unreadable: gateway down")
    span("llm_call", None, metered=False, cost_usd=None)
    span("tool", "workspace_write_file", ok=True, args_redacted={"path": "a.md", "content": "x"})
    span("tool", "workspace_write_file", ok=True, args_redacted={"path": "a.md", "content": "y"})
    span("tool", "workspace_write_file", ok=True, args_redacted="{…clipped…}")
    span("tool", "workspace_write_file", ok=True, args_redacted={"path": clipped_path})
    span(
        "tool",
        "workspace_write_file",
        ok=False,
        args_redacted={"path": "../out.md"},
        error="Error: '../out.md' resolves outside the workspace — every path must stay inside it",
    )
    span("tool", "fetch_url", ok=False, error="Error: could not reach it\nmore detail")
    span("tool", "get_time", ok=True)
    span("guard", "narration", claims=[])
    span("guard", "presented_listing", redirected=True)
    span("llm_call", None, metered=False, cost_usd=None)

    facts = agents.run_facts(
        agent, turn, status="ok", seconds=3.0, usage=chat.turn_usage(turn.spans)
    )
    assert facts.rounds == 2 and facts.cost_usd is None
    assert (facts.calls_ok, facts.calls_failed) == (5, 2)
    # The clipped path is NOT a file: its head names nothing that exists.
    assert facts.files == ("a.md",) and facts.unreadable_writes == 2
    assert facts.failed_calls == (
        "workspace_write_file — '../out.md' resolves outside the workspace — every path must "
        "stay inside it",
        "fetch_url — could not reach it",
    )
    assert facts.notes == (
        "coder's own turn recorded a narration correction",
        "coder's own turn recorded a presented_listing correction (its reply was regenerated)",
    )
    assert facts.cap_unreadable == "gateway down"
    # A ledger that was read, or skipped, adds no cap line.
    turn.spans[0].meta["ledger"] = "read"
    assert agents.run_facts(agent, turn, status="ok", seconds=1, usage=None).cap_unreadable is None


def test_rounds_are_the_span_count_and_a_part_priced_cost_says_so():
    """A metered round and a round that failed before the gateway stated
    anything: TWO gateway calls happened, so rounds is 2. turn_usage counts
    only the rounds that carried usage, so reading its number reported "1
    round" for a turn that made two — the spans are the fact. The cost is the
    sum over the priced rounds, and the line says how much of the run that
    figure covers rather than reading as the whole. (2026-09-08)"""
    agent = _agent_value()
    turn = traces.Turn(id=uuid.UUID(int=3), started_at=datetime.now(UTC), agent_id=agent.id)
    now = datetime.now(UTC)
    turn.spans.append(traces.Span("llm_call", None, now, 1, {"metered": True, "cost_usd": 0.0032}))
    turn.spans.append(traces.Span("llm_call", None, now, 1, {"error": "the gateway said 503"}))

    usage = chat.turn_usage(turn.spans)
    assert usage["rounds"] == 1 and usage["priced_rounds"] == 1  # what usage alone would say
    facts = agents.run_facts(agent, turn, status="error", seconds=2.0, usage=usage)

    assert (facts.rounds, facts.priced_rounds, facts.cost_usd) == (2, 1, 0.0032)
    assert agents.compose_result(facts, "I stopped").splitlines()[0] == (
        "[coder finished: status error · 2 tool rounds · 0 calls (0 ok, 0 failed) · 2.0 s · "
        f"$0.0032 (1 of 2 rounds priced) · trace {turn.id}]"
    )
    # Every round priced: the figure stands alone.
    turn.spans[1].meta.update(metered=True, cost_usd=0.0008)
    whole = agents.run_facts(
        agent, turn, status="ok", seconds=2.0, usage=chat.turn_usage(turn.spans)
    )
    assert (whole.rounds, whole.priced_rounds, whole.cost_usd) == (2, 2, 0.004)
    assert " · $0.0040 · " in agents.compose_result(whole, "done").splitlines()[0]


# ── create / update / delete / list through the tools ──────────────────────


async def test_create_agent_makes_the_row_and_the_folder_and_states_the_route(
    pool, mount_peers, root
):
    owner = await _owner(pool)
    gateway = FakeGateway(
        admin_body={"role": "agent_coder", "chain": ["ollama:qwen3:8b"]}, explain_body=_explain()
    )
    mount_peers(gateway=gateway)

    result, ok = await tools.dispatch(
        "create_agent",
        {
            "name": "coder",
            "purpose": "writes code",
            "instructions": "Write small, tested changes.",
            "tools": ["workspace_write_file", "workspace_read_file"],
            "model_chain": ["ollama:qwen3:8b"],
            "max_tool_rounds": 8,
        },
        _ctx(owner),
    )
    assert ok, result

    row = await agents.by_name(pool, "coder")
    assert row is not None and row.created_via == "chat" and row.created_turn_id is None
    assert row.tools == ("workspace_write_file", "workspace_read_file")
    assert row.max_tool_rounds == 8 and row.monthly_cap_usd is None
    assert (root / "agents" / "coder").is_dir()
    assert ("/admin/routes/agent_coder", {"chain": ["ollama:qwen3:8b"]}) in gateway.seen
    # The sentence is composed from what was READ BACK: the row, the folder,
    # the registry size now, the gateway's echo and its explain walk.
    assert result.startswith(
        f"created agent coder — purpose: writes code; tools: 2 of {len(tools.REGISTRY)} "
        "(workspace_write_file, workspace_read_file); folder agents/coder/ exists; rounds 8; "
        "cap none; memory: own notes only; "
        'route agent_coder registered, chain ["ollama:qwen3:8b"] — would be served by '
        f"ollama:qwen3:8b; log conversation {row.log_conversation_id}"
    )
    event = await pool.fetchrow(
        "SELECT actor, meta FROM governance_events WHERE kind = $1", governance.AGENT_CREATED
    )
    assert event["actor"] == "jeremy" and event["meta"]["created_via"] == "chat"
    # Immediately usable: the roster line names it.
    assert await agents.roster_line(pool) == (
        "Agents you can delegate to: coder — writes code "
        "(tools: workspace_write_file, workspace_read_file)"
    )

    # Refusals are the one validator's words, verbatim.
    async def create(**over) -> tuple[str, bool]:
        body = {"name": "x", "purpose": "p", "instructions": "i", "tools": ["get_time"]}
        body.update(over)
        return await tools.dispatch("create_agent", body, _ctx(owner))

    result, ok = await create(tools=["nope"])
    assert ok is False and result.startswith("Error: no tool named 'nope' — the tools that exist: ")
    result, ok = await create(name="nova")
    assert (result, ok) == ("Error: 'nova' is reserved — it is Nova's own name", False)
    result, ok = await create(tools=[agents.DELEGATE_TOOL])
    assert ok is False and result.startswith(
        "Error: delegate_to_agent cannot be in an agent's tools — agents do not delegate"
    )
    result, ok = await create(name="coder")
    assert (result, ok) == ("Error: an agent named coder already exists", False)
    # A null cap is what the page sends for "no cap"; a boolean is refused.
    result, ok = await create(name="capped", monthly_cap_usd=None)
    assert ok and "cap none" in result
    result, ok = await create(name="third", monthly_cap_usd=True)
    assert (result, ok) == (
        "Error: monthly_cap_usd must be a number of dollars or null, not a boolean",
        False,
    )
    assert await agents.names(pool) == ["capped", "coder"]


async def test_update_and_delete_go_through_the_one_writer(pool, mount_peers, root):
    owner = await _owner(pool)
    coder = await _create(pool, mount_peers)
    ctx = _ctx(owner)

    result, ok = await tools.dispatch(
        "update_agent", {"name": "coder", "purpose": "reviews code", "monthly_cap_usd": 5}, ctx
    )
    assert ok, result
    assert result.startswith("updated agent coder — purpose: reviews code;")
    assert "cap $5.00/month" in result and "route agent_coder unchanged" in result
    fresh = await agents.by_name(pool, "coder")
    assert fresh.purpose == "reviews code" and fresh.monthly_cap_usd == Decimal("5.00")
    # null clears the cap — what the page can do, the tool can do.
    result, ok = await tools.dispatch(
        "update_agent", {"name": "coder", "monthly_cap_usd": None}, ctx
    )
    assert ok and "cap none" in result
    assert (await agents.by_name(pool, "coder")).monthly_cap_usd is None
    result, ok = await tools.dispatch("update_agent", {"name": "coder"}, ctx)
    assert ok is False and result.startswith("Error: nothing to change for agent coder — ")
    result, ok = await tools.dispatch("update_agent", {"name": "nobody", "purpose": "x"}, ctx)
    assert (result, ok) == ("Error: no agent named 'nobody' — the agents are: coder", False)
    (event,) = await pool.fetch(
        "SELECT meta FROM governance_events WHERE kind = $1 AND meta->>'name' = 'coder' "
        "AND meta->'changed' = '[\"monthly_cap_usd\", \"purpose\"]'::jsonb",
        governance.AGENT_UPDATED,
    )
    assert event["meta"]["after"]["purpose"] == "reviews code"

    conversation = await pool.fetchval(
        "INSERT INTO conversations (person_id) VALUES ($1) RETURNING id", owner.id
    )
    timer = await timers.create(
        pool,
        person=owner,
        kind="scheduled",
        title="nightly review",
        payload={"instruction": "review the day's commits"},
        spec={"kind": "day", "at": "07:00"},
        tz="America/New_York",
        conversation_id=conversation,
        created_via="chat",
    )
    await pool.execute("UPDATE timers SET agent_id = $1 WHERE id = $2", coder.id, timer["id"])

    result, ok = await tools.dispatch("delete_agent", {"name": "coder"}, ctx)
    assert ok, result
    assert result == (
        "deleted agent coder — paused 1 timer: nightly review; route agent_coder removed; its "
        "folder agents/coder/, its memory notes and its log conversation were left in place"
    )
    row = await pool.fetchrow(
        "SELECT paused_at, paused_reason, agent_id FROM timers WHERE id = $1", timer["id"]
    )
    assert row["paused_at"] is not None and row["agent_id"] is None
    assert row["paused_reason"] == "paused: agent coder was deleted"
    assert await agents.by_name(pool, "coder") is None
    assert (root / "agents" / "coder").is_dir()  # left in place, as the result said
    assert (
        await pool.fetchval(
            "SELECT count(*) FROM conversations WHERE id = $1", coder.log_conversation_id
        )
        == 1
    )
    result, ok = await tools.dispatch("delete_agent", {"name": "coder"}, ctx)
    assert ok is False and result.startswith("Error: no agent named 'coder' — ")


async def test_list_agents_is_the_pages_derivation(pool, mount_peers, root, monkeypatch):
    """One derivation (agents.rows_with_state): the roster tool and the API
    read the same rows — working/idle from DOING plus an open turns row,
    spend from ONE ledger report, an unreadable ledger said in words."""
    owner = await _owner(pool)
    ctx = _ctx(owner)
    mount_peers(gateway=FakeGateway(spend_body=_spend()))
    assert await tools.dispatch("list_agents", {}, ctx) == ("no agents yet", True)

    coder = await _create(pool, mount_peers, monthly_cap_usd=5, tools=("get_time", "web_search"))
    writer = await _create(pool, mount_peers, name="writer", purpose="drafts   prose\nfor the blog")
    gateway = FakeGateway(
        spend_body=_spend({"key": "agent_coder", "local": False, "usd": 3.5, "calls": 3})
    )
    mount_peers(gateway=gateway)
    live = await traces.open_turn(
        pool,
        kind="agent",
        conversation_id=coder.log_conversation_id,
        person_id=owner.id,
        agent_id=coder.id,
        role=coder.role,
    )
    traces.set_doing(live.id, "web_search")
    since = (await pool.fetchval("SELECT started_at FROM turns WHERE id = $1", live.id)).isoformat()

    result, ok = await tools.dispatch("list_agents", {}, ctx)
    assert ok, result
    assert result.splitlines() == [
        f"coder — writes code · tools: get_time, web_search · rounds {coder.max_tool_rounds} · "
        f"cap $5.00 (spent $3.50 this month) · working: web_search since {since}",
        "writer — drafts prose for the blog · tools: get_time, workspace_read_file · rounds "
        f"{writer.max_tool_rounds} · cap none (spent $0.00 this month) · idle",
    ]
    assert len([p for p, _ in gateway.seen if p == "/admin/spend"]) == 1  # ONE report for all
    traces.clear_doing(live.id)

    # The ledger cannot be read: said on the line, never a 0.
    gateway.spend_body = None
    gateway.admin_status, gateway.admin_body = 500, {"error": "ledger db down"}
    result, ok = await tools.dispatch("list_agents", {}, ctx)
    assert ok
    assert result.splitlines()[0].endswith(
        "· cap $5.00 (ledger unreadable — ledger db down) · idle"
    )
    # A tool that has since vanished is flagged, never dropped.
    monkeypatch.delitem(tools.REGISTRY, "web_search")
    result, _ = await tools.dispatch("list_agents", {}, ctx)
    assert "tools: get_time, web_search (no longer exists)" in result.splitlines()[0]

    # The same rows the page gets, from the same call.
    rows = await agents.list_with_state(pool, app)
    assert [r["name"] for r in rows] == ["coder", "writer"]
    assert rows[0]["spend_note"] == "ledger unreadable — ledger db down"
    assert rows[0]["unknown_tools"] == ["web_search"] and rows[1]["state"] == agents.IDLE
    source = inspect.getsource(agents_api)
    assert "agents.rows_with_state(" in source
    # No second derivation: the API's code reads neither the ledger nor DOING
    # itself (its docstring may still explain them).
    read = {
        node.value.id
        for node in ast.walk(ast.parse(source))
        if isinstance(node, ast.Attribute) and isinstance(node.value, ast.Name)
    }
    assert not read & {"spend_api", "traces"}, read
    assert agents_api.IDLE is agents.IDLE


# ── delegation ─────────────────────────────────────────────────────────────


async def test_delegate_runs_the_agents_turn_and_reads_everything_back(pool, mount_peers, root):
    owner = await _owner(pool)
    coder = await _create(pool, mount_peers, tools=("workspace_write_file", "workspace_read_file"))
    report = "I wrote haiku.md with a haiku about autumn."
    gateway = ScriptedGateway(
        rounds=(
            (
                whole_call(
                    "c1", "workspace_write_file", {"path": "haiku.md", "content": "leaves\n"}
                ),
            ),
            (text(report),),
        )
    )
    memory = FakeMemory()
    mount_peers(gateway=gateway, memory=memory)
    seen: list = []
    ctx = _ctx(owner, progress=seen.append)

    result, ok = await tools.dispatch(
        "delegate_to_agent",
        {
            "agent": "coder",
            "task": "write a haiku to haiku.md",
            "context": "the owner likes autumn",
            "deliverable": "haiku.md",
        },
        ctx,
    )
    assert ok, result

    child = await _child(pool)
    assert child["agent_id"] == coder.id and child["role"] == "agent_coder"
    assert child["person_id"] == owner.id and child["conversation_id"] == coder.log_conversation_id
    assert child["status"] == "ok" and child["model"] == ""
    assert child["id"] not in traces.INFLIGHT and traces.doing(child["id"]) is None
    # The brief is a user row in the log conversation, code-composed; the
    # report is the assistant row the funnel persisted for the child turn.
    brief = agents.compose_brief(
        coder,
        "write a haiku to haiku.md",
        "the owner likes autumn",
        "haiku.md",
        owner_name="jeremy",
    )
    rows = await pool.fetch(
        "SELECT role, content, turn_id FROM messages WHERE conversation_id = $1 "
        "ORDER BY created_at",
        coder.log_conversation_id,
    )
    assert [(r["role"], r["content"], r["turn_id"]) for r in rows] == [
        ("user", brief, None),
        ("assistant", report, child["id"]),
    ]
    assert gateway.payloads[0]["messages"][-1] == {"role": "user", "content": brief}
    assert (
        "You are coder, an agent working for the household"
        in (gateway.payloads[0]["messages"][0]["content"])
    )
    assert "model" not in gateway.payloads[0]  # the agent's chain decides
    assert (root / "agents" / "coder" / "haiku.md").read_text(encoding="utf-8") == "leaves\n"

    lines = result.splitlines()
    assert re.fullmatch(
        r"\[coder finished: status ok · 2 tool rounds · 1 call \(1 ok, 0 failed\) · "
        rf"\d+(\.\d)? s · unmetered · trace {child['id']}\]",
        lines[0],
    ), lines[0]
    assert lines[1:] == [
        "Files written in agents/coder/: haiku.md",
        "--- coder's report (its words; only the facts above are verified) ---",
        report,
    ]
    assert ctx.facts_sink == [
        {
            "agent": "coder",
            "agent_turn_id": str(child["id"]),
            "status": "ok",
            "files": ["haiku.md"],
            "rounds": 2,
            "calls_ok": 1,
            "calls_failed": 0,
        }
    ]
    tid = str(child["id"])
    assert seen == [
        {
            "detail": "coder is working…",
            "agent": "coder",
            "agent_turn_id": tid,
            "step": "start",
            "step_status": "start",
        },
        {
            "detail": "coder · workspace_write_file start",
            "agent": "coder",
            "agent_turn_id": tid,
            "step": "workspace_write_file",
            "step_status": "start",
        },
        {
            "detail": "coder · workspace_write_file ok",
            "agent": "coder",
            "agent_turn_id": tid,
            "step": "workspace_write_file",
            "step_status": "ok",
        },
    ]
    # A brief is not something the owner said: nothing ingested; recall in
    # the agent's own scope.
    await chat.drain_background()
    assert memory.ingests == [] and [r["person_id"] for r in memory.recalls] == [str(coder.id)]


async def test_a_delegation_does_not_wait_on_unrelated_background_work(pool, mount_peers, root):
    """The relay comes back as soon as the child's turn is on record, and
    nothing else is waited for.

    chat._run_turn awaits the child's SHIELDED close_turn in its own finally
    before returning, and ingest=False queues no ingest — so by the time the
    funnel returns, the status and the assistant row the reads below need are
    already written. The settle_detached that used to follow it waited for
    every task spawned into chat._BACKGROUND since a snapshot, and a snapshot
    cannot tell whose work that is: another conversation's chat turn, an eval
    suite job. Nova's relay of this agent's report stalled on work that had
    nothing to do with it. (2026-09-08)"""
    owner = await _owner(pool)
    await _create(pool, mount_peers)
    mount_peers(gateway=ScriptedGateway(rounds=((text("done"),),)), memory=FakeMemory())
    unrelated: list[asyncio.Task] = []

    def spawn_unrelated(_report: dict) -> None:
        # Somebody else's long-running detached work, filed exactly as _spawn
        # files it and started from the CHILD's own frames — i.e. while the
        # delegation is running, which is the only work a snapshot taken
        # before the child turn would have swept up.
        if not unrelated:
            unrelated.append(chat._spawn(asyncio.sleep(20)))

    try:
        result, ok = await asyncio.wait_for(
            tools.dispatch(
                "delegate_to_agent",
                {"agent": "coder", "task": "say done"},
                _ctx(owner, progress=spawn_unrelated),
            ),
            timeout=10,
        )
        assert ok, result
        assert unrelated and not unrelated[0].done()  # returned while it was still pending
        child = await _child(pool)  # and the child's status was already on record
        assert child["status"] == "ok"
        assert await _reply(pool, child["id"]) == "done"
    finally:
        for task in unrelated:
            task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await task


async def test_an_agent_deleted_mid_hand_over_is_refused_and_leaves_no_brief(
    pool, mount_peers, root, monkeypatch
):
    """The row is read, then the child turn is opened — and turns.agent_id is
    a foreign key, so an agent deleted in between is refused by the database
    rather than run. The brief is written only once that turn exists: the
    other order left a task row in the agent's log conversation for a run
    that then never happened, which the Agents page shows as work handed
    over. (2026-09-08)"""
    owner = await _owner(pool)
    coder = await _create(pool, mount_peers)
    mount_peers(gateway=ScriptedGateway(rounds=((text("done"),),)), memory=FakeMemory())
    real_open_turn = traces.open_turn

    async def delete_then_open(*args, **kwargs):
        # The race made deterministic: the row goes away between by_name and
        # the INSERT that references it. The violation below is the real one.
        await pool.execute("DELETE FROM agents WHERE id = $1", coder.id)
        return await real_open_turn(*args, **kwargs)

    monkeypatch.setattr(traces, "open_turn", delete_then_open)
    ctx = _ctx(owner)

    result, ok = await tools.dispatch("delegate_to_agent", {"agent": "coder", "task": "do it"}, ctx)

    assert (result, ok) == (
        "Error: agent coder was deleted while the task was being handed over",
        False,
    )
    assert await pool.fetchval("SELECT count(*) FROM turns") == 0
    assert (
        await pool.fetchval(
            "SELECT count(*) FROM messages WHERE conversation_id = $1", coder.log_conversation_id
        )
        == 0
    )
    assert ctx.facts_sink == [
        {
            "agent": "coder",
            "status": "refused",
            "reason": "agent coder was deleted while the task was being handed over",
        }
    ]


async def test_files_come_from_write_spans_never_from_the_report(pool, mount_peers, root):
    """A report naming a file the child never wrote lists none — and the
    child's own narration guard, which caught the same claim, is a note."""
    owner = await _owner(pool)
    await _create(pool, mount_peers, tools=("workspace_write_file",))
    mount_peers(
        gateway=ScriptedGateway(rounds=((text("I wrote hello.py in my folder."),),)),
        memory=FakeMemory(),
    )
    ctx = _ctx(owner)

    result, ok = await tools.dispatch(
        "delegate_to_agent", {"agent": "coder", "task": "write hello.py"}, ctx
    )
    assert ok, result

    child = await _child(pool)
    lines = result.splitlines()
    assert lines[0].startswith(
        "[coder finished: status ok · 1 tool round · 0 calls (0 ok, 0 failed) ·"
    )
    assert lines[1] == "Files written in agents/coder/: none"
    assert lines[2] == "Notes: coder's own turn recorded a narration correction"
    assert lines[3] == "--- coder's report (its words; only the facts above are verified) ---"
    assert lines[4] == "I wrote hello.py in my folder."
    persisted = await _reply(pool, child["id"])
    assert "\n".join(lines[4:]) == persisted and "Correction:" in persisted
    assert [s["name"] for s in await _spans(pool, child["id"]) if s["kind"] == "guard"] == [
        "narration"
    ]
    assert ctx.facts_sink[0]["files"] == []
    assert not (root / "agents" / "coder" / "hello.py").exists()


async def test_a_delegation_inside_novas_turn(pool, mount_peers, root):
    """Driven through a real Nova turn: her delegate span carries the facts,
    the child's steps reach her stream as activity frames under HER call
    with agent/agent_turn_id/step, and the child's own meta, t, served_by
    and [DONE] never reach her emit."""
    owner = await _owner(pool)
    await _create(pool, mount_peers, tools=("workspace_write_file",))
    relay = "coder wrote haiku.md — it reads: leaves fall."
    gateway = ScriptedGateway(
        rounds=(
            (whole_call("n1", "delegate_to_agent", {"agent": "coder", "task": "write a haiku"}),),
            (
                whole_call(
                    "c1", "workspace_write_file", {"path": "haiku.md", "content": "leaves\n"}
                ),
            ),
            (text("Wrote haiku.md: leaves fall."),),
            (text(relay),),
        )
    )
    memory = FakeMemory()
    mount_peers(gateway=gateway, memory=memory)

    turn, frames = await _nova_turn(pool, owner, "ask coder to write a haiku")

    parsed = _parsed(frames)
    metas = [f["meta"] for f in parsed if isinstance(f, dict) and "meta" in f]
    assert len(metas) == 1 and metas[0]["turn_id"] == str(turn.id) and metas[0]["agent"] is None
    assert parsed.count("[DONE]") == 1 and parsed[-1] == "[DONE]"
    assert "".join(f["t"] for f in parsed if isinstance(f, dict) and "t" in f) == relay
    assert len([f for f in parsed if isinstance(f, dict) and "served_by" in f]) == 1
    assert [f for f in parsed if isinstance(f, dict) and "correction" in f] == []
    child = await _child(pool)
    tid = str(child["id"])
    assert [f["activity"] for f in parsed if isinstance(f, dict) and "activity" in f] == [
        {"tool": "delegate_to_agent", "status": "start"},
        {
            "tool": "delegate_to_agent",
            "status": "progress",
            "detail": "coder is working…",
            "agent": "coder",
            "agent_turn_id": tid,
            "step": "start",
            "step_status": "start",
        },
        {
            "tool": "delegate_to_agent",
            "status": "progress",
            "detail": "coder · workspace_write_file start",
            "agent": "coder",
            "agent_turn_id": tid,
            "step": "workspace_write_file",
            "step_status": "start",
        },
        {
            "tool": "delegate_to_agent",
            "status": "progress",
            "detail": "coder · workspace_write_file ok",
            "agent": "coder",
            "agent_turn_id": tid,
            "step": "workspace_write_file",
            "step_status": "ok",
        },
        {"tool": "delegate_to_agent", "status": "ok"},
    ]
    (span,) = [s for s in await _spans(pool, turn.id) if s["kind"] == "tool"]
    assert span["name"] == "delegate_to_agent" and span["meta"]["ok"] is True
    assert span["meta"]["args_redacted"] == {"agent": "coder", "task": "write a haiku"}
    assert span["meta"]["facts"] == [
        {
            "agent": "coder",
            "agent_turn_id": tid,
            "status": "ok",
            "files": ["haiku.md"],
            "rounds": 2,
            "calls_ok": 1,
            "calls_failed": 0,
        }
    ]
    assert [s["name"] for s in await _spans(pool, turn.id) if s["kind"] == "guard"] == []
    # What her second round read is the composed result, facts first.
    (tool_msg,) = [m for m in gateway.payloads[3]["messages"] if m["role"] == "tool"]
    assert tool_msg["tool_call_id"] == "n1"
    assert tool_msg["content"].startswith(
        "[coder finished: status ok · 2 tool rounds · 1 call (1 ok, 0 failed) · "
    )
    assert "\nFiles written in agents/coder/: haiku.md\n" in tool_msg["content"]
    assert await _reply(pool, turn.id) == relay
    assert await pool.fetchval("SELECT status FROM turns WHERE id = $1", turn.id) == "ok"
    assert child["status"] == "ok" and child["person_id"] == owner.id
    assert traces.doing(turn.id) is None and traces.doing(child["id"]) is None
    # Her turn ingests {message, relay} into HER scope; the child's never does.
    await chat.drain_background()
    assert [i["person_id"] for i in memory.ingests] == [str(owner.id)]
    assert memory.ingests[0]["exchange"] == {
        "user": "ask coder to write a haiku",
        "assistant": relay,
    }


async def test_a_child_that_did_not_finish_is_a_stated_failure(pool, mount_peers, root):
    owner = await _owner(pool)
    await _create(pool, mount_peers)
    refusal = Refusal(503, {"error": {"message": "no backend can serve agent_coder"}})
    mount_peers(gateway=ScriptedGateway(rounds=(refusal,)), memory=FakeMemory())
    ctx = _ctx(owner)

    result, ok = await tools.dispatch("delegate_to_agent", {"agent": "coder", "task": "do it"}, ctx)

    assert ok is False
    child = await _child(pool)
    assert child["status"] == "error"
    statement = await _reply(pool, child["id"])  # the failure statement the funnel persisted
    assert statement is not None and "no backend can serve agent_coder" in statement
    assert result == (
        f"Error: agent coder did not finish — {statement} · agent coder · turn {child['id']} · "
        "status error · 1 round · 0 calls (0 ok, 0 failed) · files: none"
    )
    # The facts are on the sink even though the call failed.
    assert ctx.facts_sink == [
        {
            "agent": "coder",
            "agent_turn_id": str(child["id"]),
            "status": "error",
            "files": [],
            "rounds": 1,
            "calls_ok": 0,
            "calls_failed": 0,
        }
    ]

    # Through Nova's turn: her span says failed AND carries the facts; the
    # activity line closes with the stated reason.
    await pool.execute("DELETE FROM turns WHERE kind = 'agent'")
    gateway = ScriptedGateway(
        rounds=(
            (whole_call("n1", "delegate_to_agent", {"agent": "coder", "task": "do it"}),),
            refusal,
            (text("coder ran but hit an error."),),
        )
    )
    mount_peers(gateway=gateway, memory=FakeMemory())
    turn, frames = await _nova_turn(pool, owner, "ask coder to do it")
    child = await _child(pool)
    (span,) = [s for s in await _spans(pool, turn.id) if s["kind"] == "tool"]
    assert span["meta"]["ok"] is False
    assert span["meta"]["error"].startswith("Error: agent coder did not finish — ")
    assert span["meta"]["facts"][0]["status"] == "error"
    assert span["meta"]["facts"][0]["agent_turn_id"] == str(child["id"])
    last = [f["activity"] for f in _parsed(frames) if isinstance(f, dict) and "activity" in f][-1]
    assert last["tool"] == "delegate_to_agent" and last["status"] == "error"
    assert last["reason"].startswith("agent coder did not finish — ")
    assert await _reply(pool, turn.id) == "coder ran but hit an error."


async def test_an_agent_over_its_cap_does_not_finish_and_spends_nothing(pool, mount_peers, root):
    owner = await _owner(pool)
    await _create(pool, mount_peers, monthly_cap_usd=5)
    gateway = FakeGateway(
        deltas=("must never stream",),
        spend_body=_spend({"key": "agent_coder", "local": False, "usd": 6.0, "calls": 2}),
    )
    mount_peers(gateway=gateway, memory=FakeMemory())

    result, ok = await tools.dispatch(
        "delegate_to_agent", {"agent": "coder", "task": "do it"}, _ctx(owner)
    )

    child = await _child(pool)
    assert ok is False
    assert result == (
        "Error: agent coder did not finish — agent coder is over its monthly cap ($6.00 of $5.00 "
        f"this month) — raise it on the Agents page · agent coder · turn {child['id']} · "
        "status error · 0 rounds · 0 calls (0 ok, 0 failed) · files: none"
    )
    assert [p for p, _ in gateway.seen if p == "/v1/chat/completions"] == []


async def test_the_cap_line_appears_only_when_the_ledger_could_not_be_read(pool, mount_peers, root):
    owner = await _owner(pool)
    await _create(pool, mount_peers, monthly_cap_usd=5)
    # A ScriptedGateway serves no /admin/spend: the ledger is unreadable, the
    # turn runs anyway (fail-open), and the result says so.
    mount_peers(gateway=ScriptedGateway(rounds=((text("done"),),)), memory=FakeMemory())

    result, ok = await tools.dispatch(
        "delegate_to_agent", {"agent": "coder", "task": "say done"}, _ctx(owner)
    )
    assert ok, result
    child = await _child(pool)
    (cap,) = [s for s in await _spans(pool, child["id"]) if s["kind"] == "agent_cap"]
    assert cap["meta"]["cap_usd"] == 5.0 and cap["meta"]["ledger"].startswith("unreadable: ")
    reason = cap["meta"]["ledger"][len("unreadable: ") :]
    assert result.splitlines()[2] == (
        f"Cap: unchecked this run — the ledger could not be read ({reason})"
    )

    await _create(pool, mount_peers, name="free")
    mount_peers(gateway=ScriptedGateway(rounds=((text("done"),),)), memory=FakeMemory())
    result, ok = await tools.dispatch(
        "delegate_to_agent", {"agent": "free", "task": "say done"}, _ctx(owner)
    )
    assert ok and not any(line.startswith("Cap:") for line in result.splitlines())


async def test_an_agent_cannot_delegate(pool, mount_peers, root):
    """The depth-1 bound, stated at the tool: an agent's turn that reaches
    for delegate_to_agent (outside its subset — validate_spec never lets it
    in) gets the refusal, and no child turn is opened."""
    owner = await _owner(pool)
    coder = await _create(pool, mount_peers)
    writer = await _create(pool, mount_peers, name="writer")
    gateway = ScriptedGateway(
        rounds=(
            (whole_call("c1", "delegate_to_agent", {"agent": "writer", "task": "draft it"}),),
            (text("I could not delegate."),),
        )
    )
    mount_peers(gateway=gateway, memory=FakeMemory())

    turn, _ = await _agent_turn(pool, coder, owner, "get writer to draft it")

    (span,) = [s for s in await _spans(pool, turn.id) if s["kind"] == "tool"]
    assert span["name"] == "delegate_to_agent" and span["meta"]["ok"] is False
    assert span["meta"]["outside_subset"] is True and span["meta"]["error"] == CANNOT
    assert await pool.fetchval("SELECT count(*) FROM turns WHERE kind = 'agent'") == 1
    assert (
        await pool.fetchval(
            "SELECT count(*) FROM messages WHERE conversation_id = $1", writer.log_conversation_id
        )
        == 0
    )
    assert await _reply(pool, turn.id) == "I could not delegate."
    # The refusal is filed as a refusal, on the agent's own delegate span:
    # nothing ran, so the trace must not read as a run that failed.
    assert span["meta"]["facts"] == [
        {
            "agent": "writer",
            "status": "refused",
            "reason": agent_tools.AGENT_CANNOT_DELEGATE,
        }
    ]
    # The executor refuses before any lookup: an unknown name is not even read.
    as_agent = dataclasses.replace(_ctx(owner), person=coder.person())
    assert await tools.dispatch(
        "delegate_to_agent", {"agent": "nobody", "task": "x"}, as_agent
    ) == (CANNOT, False)
    assert as_agent.facts_sink == [
        {"agent": "nobody", "status": "refused", "reason": agent_tools.AGENT_CANNOT_DELEGATE}
    ]


async def test_delegating_to_no_agent_is_refused_naming_the_live_ones(pool, mount_peers, root):
    owner = await _owner(pool)
    await _create(pool, mount_peers)
    ctx = _ctx(owner)
    assert await tools.dispatch("delegate_to_agent", {"agent": "nobody", "task": "x"}, ctx) == (
        "Error: no agent named 'nobody' — the agents are: coder",
        False,
    )
    assert await tools.dispatch("delegate_to_agent", {"agent": "coder", "task": "   "}, ctx) == (
        "Error: task is empty — say what coder should do",
        False,
    )
    assert await pool.fetchval("SELECT count(*) FROM turns") == 0
    # A refusal BEFORE any child turn opened is FILED as one: the sink says
    # status 'refused' with the reason, so the span (and the transcript chip
    # that reads facts[0]) says a delegation was refused — never the silence
    # that reads as a child turn which ran and went wrong. (2026-09-08)
    assert ctx.facts_sink == [
        {
            "agent": "nobody",
            "status": "refused",
            "reason": "no agent named 'nobody' — the agents are: coder",
        },
        {
            "agent": "coder",
            "status": "refused",
            "reason": "task is empty — say what coder should do",
        },
    ]

    # Through a real Nova turn: the refused facts land on HER delegate span.
    mount_peers(
        gateway=ScriptedGateway(
            rounds=(
                (whole_call("n1", "delegate_to_agent", {"agent": "nobody", "task": "x"}),),
                (text("There is no agent by that name."),),
            )
        ),
        memory=FakeMemory(),
    )
    turn, _ = await _nova_turn(pool, owner, "hand it to nobody")
    (span,) = [s for s in await _spans(pool, turn.id) if s["kind"] == "tool"]
    assert span["name"] == "delegate_to_agent" and span["meta"]["ok"] is False
    assert span["meta"]["facts"] == [
        {
            "agent": "nobody",
            "status": "refused",
            "reason": "no agent named 'nobody' — the agents are: coder",
        }
    ]
    assert await pool.fetchval("SELECT count(*) FROM turns WHERE kind = 'agent'") == 0
