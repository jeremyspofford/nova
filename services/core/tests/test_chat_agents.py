"""S12: chat._run_turn(persona=…) — one funnel, whose turn it is decided by data.

What these pin, and why each is a pin and not a wish:
  * persona=None is Nova exactly as before: the first system message and the
    advertised list are byte-identical to the bare stable_system_prompt /
    advertised_tools calls (a regression here would silently change every
    turn Nova has ever run);
  * the three functions that judge a reply against a toolset contain ZERO bare
    registry reads — tools.tool_names() or tools.tool_names_by_result_kind(…)
    (AST) — a persona site that was missed cannot feed a guard the whole
    registry;
  * an agent's turn advertises exactly its subset and carries its block after
    the shared preamble; its honest "I can't browse the web" is NOT corrected
    (it has no fetch_url) while the same words from Nova are;
  * a call outside the subset RUNS and the span says so (scope, not a gate);
    a call to a name NO tool has is answered from the subset the agent was
    shown, never from the whole registry (Nova keeps dispatch's sentence);
  * the agent's rounds — its tool rounds AND its redirect/judge rounds — walk
    its own routing role; the row's round budget wins over the argument; a
    turn opened as one identity is never run as another (stated, not run
    through); a roster that cannot be read leaves an `agent_roster` span and
    nothing else does; recall asks one partition or two under ONE span; a
    delegation-style turn never ingests; DOING is set while the turn runs
    (redirect rounds included) and cleared after; the meta frame names the
    agent; the delegation sentence is keyed on agents.DELEGATE_TOOL.
"""

from __future__ import annotations

import ast
import dataclasses
import inspect
import json
import uuid
from pathlib import Path

import pytest
from starlette.applications import Starlette
from starlette.responses import JSONResponse
from starlette.routing import Route

from app import agents, chat, conversations, guards, scheduler, tools, traces
from app.agents import Agent, AgentSpec
from app.identity import Person
from app.main import app
from tests import fakes
from tests.conftest import requires_db
from tests.fakes import FakeGateway, FakeMemory, ScriptedGateway
from tests.test_chat import _say, _set_model
from tests.test_chat_presented_listing import FABRICATED
from tests.test_chat_tools import text, whole_call

pytestmark = requires_db

MODEL = "qwen3:8b"
CHAT_PY = Path(chat.__file__)
SUBSET = ("get_time", "workspace_read_file")


@pytest.fixture
def root(monkeypatch, tmp_path) -> Path:
    root = tmp_path / "ws"
    monkeypatch.setenv("WORKSPACE_ROOT", str(root))
    return root


async def _owner(pool) -> Person:
    pid = await pool.fetchval(
        "INSERT INTO people (name, role) VALUES ('jeremy', 'owner') RETURNING id"
    )
    return Person(id=pid, name="jeremy", role="owner")


def _explain(role: str = "agent_coder") -> dict:
    return {
        "role": role,
        "chain": [{"link": 1, "id": "ollama:qwen3:8b", "verdict": "runnable", "reason": None}],
        "would_serve": {
            "role": role,
            "link": 1,
            "reason": None,
            "served_by": "ollama:qwen3:8b",
            "standby": False,
        },
        "reason": None,
    }


async def _create(pool, mount_peers, **over) -> Agent:
    """An agents row through the one writer, against a gateway that echoes
    the route PUT the way the real one does."""
    name = over.pop("name", "coder")
    mount_peers(
        gateway=FakeGateway(
            admin_body={"role": f"agent_{name}", "chain": []}, explain_body=_explain()
        )
    )
    spec = AgentSpec(
        name=name,
        purpose=over.pop("purpose", "writes code"),
        instructions=over.pop("instructions", "Write small, tested changes."),
        tools=over.pop("tools", SUBSET),
        **over,
    )
    result = await agents.create(
        pool, app, spec, created_via="page", created_turn_id=None, actor="jeremy"
    )
    return result.agent


async def _open_agent_turn(pool, agent: Agent, owner: Person, *, kind: str = "agent"):
    """The turn a delegation (kind 'agent') or an @mention (kind 'chat')
    opens: the owner's money, the agent's id and role, its log conversation."""
    return await traces.open_turn(
        pool,
        kind=kind,
        conversation_id=agent.log_conversation_id,
        model=MODEL,
        person_id=owner.id,
        agent_id=agent.id,
        role=agent.role,
    )


async def _agent_turn(
    pool,
    agent: Agent,
    owner: Person,
    message: str = "do the task",
    *,
    ingest: bool = False,
    turn: traces.Turn | None = None,
    max_tool_rounds: int | None = None,
    persona: agents.Persona | None = None,
) -> tuple[traces.Turn, list]:
    """Run one agent turn through the funnel exactly as delegation / a mention
    will: the agent's Person VALUE, its log conversation, its persona (the
    shared scope DERIVED from the row and the owner's id), its rounds; settle
    the detached close before returning. `max_tool_rounds` is the ARGUMENT a
    caller hands the funnel (default: the row's own); `persona` overrides
    the one derived from `agent` — for the test that runs a turn as the
    wrong identity."""
    if turn is None:
        turn = await _open_agent_turn(pool, agent, owner)
    if persona is None:
        persona = agents.persona_for(agent, owner_id=owner.id)
    frames: list = []
    before = set(chat._BACKGROUND)
    await chat._run_turn(
        app,
        pool,
        turn,
        agent.person(),
        agent.log_conversation_id,
        message,
        [],
        MODEL,
        agent.max_tool_rounds if max_tool_rounds is None else max_tool_rounds,
        frames.append,
        ingest=ingest,
        persona=persona,
    )
    await chat.settle_detached(before)
    return turn, frames


async def _nova_turn(
    pool, owner: Person, message: str = "hello", *, turn: traces.Turn | None = None
) -> tuple[traces.Turn, list]:
    """A plain owner turn with NO persona kwarg — the path every caller that
    has no agent takes. `turn` (S12-3b) is a turn the test opened itself,
    so spans can be filed on it before it runs."""
    conversation = await conversations.active_conversation(pool, owner)
    if turn is None:
        turn = await traces.open_turn(
            pool, conversation_id=conversation["id"], model=MODEL, person_id=owner.id
        )
    frames: list = []
    before = set(chat._BACKGROUND)
    await chat._run_turn(
        app, pool, turn, owner, conversation["id"], message, [], MODEL, 3, frames.append
    )
    await chat.settle_detached(before)
    return turn, frames


def _parsed(frames: list) -> list:
    out = []
    for frame in frames:
        if frame is None:
            continue
        payload = frame[len("data: ") :].strip()
        out.append(payload if payload == "[DONE]" else json.loads(payload))
    return out


async def _spans(pool, turn_id) -> list:
    return await pool.fetch(
        "SELECT kind, name, meta FROM turn_spans WHERE turn_id = $1 ORDER BY started_at",
        turn_id,
    )


async def _reply(pool, turn_id) -> str | None:
    return await pool.fetchval(
        "SELECT content FROM messages WHERE turn_id = $1 AND role = 'assistant'", turn_id
    )


def _calls(*specs: tuple[str, str, dict]) -> dict:
    """One completion chunk asking for several tools at once."""
    return {
        "choices": [
            {
                "message": {
                    "role": "assistant",
                    "content": None,
                    "tool_calls": [
                        {
                            "id": call_id,
                            "type": "function",
                            "function": {"name": name, "arguments": json.dumps(arguments)},
                        }
                        for call_id, name, arguments in specs
                    ],
                },
                "finish_reason": "tool_calls",
            }
        ]
    }


# ── the None path is Nova, byte for byte ───────────────────────────────────


async def test_persona_none_is_byte_identical_to_the_bare_calls(pool, mount_peers, root):
    owner = await _owner(pool)
    gateway = ScriptedGateway(rounds=((text("hi"),),))
    mount_peers(gateway=gateway, memory=FakeMemory())

    turn, frames = await _nova_turn(pool, owner, "hello")

    payload = gateway.payloads[0]
    # No agents exist: no roster line, and the stable prompt is untouched. The
    # volatile message is now present even with no notes, because S13 makes
    # recall SAY that it looked and found nothing — an absent block and an
    # empty-handed search used to read identically to the model.
    assert payload["messages"][0] == {
        "role": "system",
        "content": chat.stable_system_prompt(MODEL, tools.tool_names()),
    }
    assert payload["messages"][1]["content"].startswith(
        "Her memory was searched for this turn and returned nothing:"
    )
    assert payload["messages"][2] == {"role": "user", "content": "hello"}
    assert payload["tools"] == tools.advertised_tools()
    assert chat.stable_system_prompt(MODEL, tools.tool_names(), agent_block=None) == (
        chat.stable_system_prompt(MODEL, tools.tool_names())
    )
    empty = chat.Recalled()
    assert chat.base_messages(MODEL, empty, [], "hello") == chat.base_messages(
        MODEL, empty, [], "hello", None, roster=None
    )
    # A Recalled that knows NOTHING — not even that a search happened — still
    # produces no volatile message at all.
    assert chat.volatile_system_prompt(empty) is None
    assert chat.volatile_system_prompt(empty, None) is None
    note = chat.volatile_system_prompt(chat.Recalled(notes=("a note",)))
    assert note is not None
    assert note.startswith(f"{chat.NOTES_HEADER}\n- a note\n\nCurrent time: ")
    meta = _parsed(frames)[0]["meta"]
    assert set(meta) == {"conversation_id", "model", "turn_id", "agent"} and meta["agent"] is None
    assert await _reply(pool, turn.id) == "hi"
    row = await pool.fetchrow("SELECT status, agent_id, role FROM turns WHERE id = $1", turn.id)
    assert (row["status"], row["agent_id"], row["role"]) == ("ok", None, None)


def _is_bare_registry_read(node: ast.AST) -> bool:
    """A call that reads the WHOLE registry rather than the persona: a bare
    `tools.tool_names()` or any `tools.tool_names_by_result_kind(…)` — the
    listing-tools read has its own persona field (Persona.listing_tools) for
    exactly the same reason the toolset does."""
    if not (
        isinstance(node, ast.Call)
        and isinstance(node.func, ast.Attribute)
        and isinstance(node.func.value, ast.Name)
        and node.func.value.id == "tools"
    ):
        return False
    if node.func.attr == "tool_names_by_result_kind":
        return True
    return node.func.attr == "tool_names" and not node.args and not node.keywords


def test_no_bare_registry_read_in_the_three_persona_functions():
    """The AST pin: `_run_turn`, `_deferral_redirect` and `_regen_rejected_by`
    judge replies against a toolset, and every one of their reads goes
    through the persona. A future site written as `tools.tool_names()` — or
    `tools.tool_names_by_result_kind(…)`, the listing guard's read — would
    feed a guard the whole registry for an agent — and "correct" its honest
    denial into a lie — so it fails here, by name and line."""
    tree = ast.parse(CHAT_PY.read_text(encoding="utf-8"))
    wanted = {"_run_turn", "_deferral_redirect", "_regen_rejected_by"}
    found = {
        node.name: node
        for node in ast.walk(tree)
        if isinstance(node, ast.FunctionDef | ast.AsyncFunctionDef) and node.name in wanted
    }
    assert set(found) == wanted
    for name, fn in found.items():
        bare = [node.lineno for node in ast.walk(fn) if _is_bare_registry_read(node)]
        assert bare == [], f"{name} reads the whole registry at line(s) {bare}"
    # The matcher itself sees both shapes (a pin that matches nothing pins
    # nothing).
    assert _is_bare_registry_read(ast.parse("tools.tool_names()").body[0].value)
    assert _is_bare_registry_read(
        ast.parse("tools.tool_names_by_result_kind(tools.RESULT_KIND_LISTING)").body[0].value
    )
    assert not _is_bare_registry_read(ast.parse("tools.tool_names(persona)").body[0].value)
    assert not _is_bare_registry_read(ast.parse("persona.listing_tools").body[0].value)


def test_the_delegation_sentence_is_keyed_on_the_module_constant():
    """The prompt's delegation paragraph belongs to whoever holds the
    delegation tool, by NAME — agents.DELEGATE_TOOL, never a string literal
    in chat.py, so a rename of the tool moves the sentence with it instead of
    silently dropping it from every prompt."""
    assert agents.DELEGATE_TOOL == "delegate_to_agent"
    with_tool = chat.stable_system_prompt(MODEL, ("get_time", agents.DELEGATE_TOOL))
    without = chat.stable_system_prompt(MODEL, ("get_time",))
    assert f" {agents.DELEGATE_TOOL} runs an agent to completion" in with_tool
    assert agents.DELEGATE_TOOL not in without
    assert '"delegate_to_agent"' not in inspect.getsource(chat.stable_system_prompt)
    assert "'delegate_to_agent'" not in inspect.getsource(chat.stable_system_prompt)


def test_the_settle_helper_has_one_implementation():
    """The scheduler's private copy is gone; it calls the lifted one, so
    delegation and a scheduled firing can never disagree about 'settled'."""
    assert not hasattr(scheduler, "_settle_detached")
    assert inspect.getsource(scheduler).count("chat.settle_detached(") == 1
    assert "asyncio.gather(" in inspect.getsource(chat._recall)  # the scopes run concurrently


# ── an agent's turn ────────────────────────────────────────────────────────


async def test_an_agent_turn_advertises_its_subset_and_carries_its_block(pool, mount_peers, root):
    owner = await _owner(pool)
    agent = await _create(pool, mount_peers)
    gateway = ScriptedGateway(rounds=((text("done"),),))
    mount_peers(gateway=gateway, memory=FakeMemory())

    turn, frames = await _agent_turn(pool, agent, owner, "write hello.py")

    payload = gateway.payloads[0]
    assert [t["function"]["name"] for t in payload["tools"]] == list(SUBSET)
    assert payload["tools"] == tools.advertised_tools(agent.tools)
    system = payload["messages"][0]["content"]
    # The shared preamble — the rails the guards enforce — then the block.
    assert system.startswith("You are Nova, a self-hosted assistant")
    assert "You can call these tools: get_time, workspace_read_file." in system
    assert system.endswith("\n\n" + agents.persona_for(agent, owner_id=owner.id).instructions_block)
    assert "You are coder, an agent working for the household" in system
    assert "Purpose: writes code" in system and "Write small, tested changes." in system
    assert "Your workspace folder is agents/coder/" in system
    assert f"You have {agent.max_tool_rounds} tool rounds per task." in system
    assert "delegate_to_agent" not in system and "Agents you can delegate to" not in system
    assert payload["messages"][-1] == {"role": "user", "content": "write hello.py"}

    assert await _reply(pool, turn.id) == "done"
    row = await pool.fetchrow(
        "SELECT status, agent_id, role, conversation_id, person_id FROM turns WHERE id = $1",
        turn.id,
    )
    assert row["status"] == "ok" and row["agent_id"] == agent.id and row["role"] == "agent_coder"
    assert row["conversation_id"] == agent.log_conversation_id and row["person_id"] == owner.id
    assert _parsed(frames)[0]["meta"]["agent"] == "coder"
    assert _parsed(frames)[-1] == "[DONE]"


async def test_the_agents_folder_is_the_workspace_boundary(pool, mount_peers, root):
    """The tool context is rooted at agents/<name>/: a write lands there and
    a read that climbs out of it is refused by the same gate Nova has."""
    owner = await _owner(pool)
    agent = await _create(pool, mount_peers, tools=("workspace_write_file", "workspace_read_file"))
    (root / "secret.md").write_text("owner's", encoding="utf-8")
    gateway = ScriptedGateway(
        rounds=(
            (
                _calls(
                    ("c1", "workspace_write_file", {"path": "notes.md", "content": "mine\n"}),
                    ("c2", "workspace_read_file", {"path": "../../secret.md"}),
                ),
            ),
            (text("wrote notes.md"),),
        )
    )
    mount_peers(gateway=gateway, memory=FakeMemory())

    turn, _ = await _agent_turn(pool, agent, owner)

    assert (root / "agents" / "coder" / "notes.md").read_text(encoding="utf-8") == "mine\n"
    spans = [s for s in await _spans(pool, turn.id) if s["kind"] == "tool"]
    assert [(s["name"], s["meta"]["ok"]) for s in spans] == [
        ("workspace_write_file", True),
        ("workspace_read_file", False),
    ]
    assert "outside the workspace" in spans[1]["meta"]["error"]
    assert "outside_subset" not in spans[0]["meta"] and "outside_subset" not in spans[1]["meta"]


async def test_an_honest_denial_outside_the_subset_is_not_corrected(pool, mount_peers, root):
    """The capability guard is fed the persona's toolset: an agent that was
    given no fetch_url and says so is telling the truth, and the same words
    from Nova (who holds it) are the T7 lie the guard exists for."""
    owner = await _owner(pool)
    agent = await _create(pool, mount_peers)  # SUBSET has no fetch_url
    reply = "I can't browse the web."
    mount_peers(gateway=ScriptedGateway(rounds=((text(reply),),)), memory=FakeMemory())

    turn, frames = await _agent_turn(pool, agent, owner, "what is on example.com?")

    assert [s["name"] for s in await _spans(pool, turn.id) if s["kind"] == "guard"] == []
    assert await _reply(pool, turn.id) == reply
    assert [f for f in _parsed(frames) if isinstance(f, dict) and "correction" in f] == []
    assert await pool.fetchval("SELECT status FROM turns WHERE id = $1", turn.id) == "ok"

    mount_peers(gateway=ScriptedGateway(rounds=((text(reply),),)), memory=FakeMemory())
    nova_turn, nova_frames = await _nova_turn(pool, owner, "what is on example.com?")

    guards_fired = [s for s in await _spans(pool, nova_turn.id) if s["kind"] == "guard"]
    assert [s["name"] for s in guards_fired] == ["capability_claim"]
    assert guards_fired[0]["meta"]["capabilities"][0]["tool"] == "fetch_url"
    corrections = [f for f in _parsed(nova_frames) if isinstance(f, dict) and "correction" in f]
    assert len(corrections) == 1 and await _reply(pool, nova_turn.id) != reply


async def test_a_call_outside_the_subset_runs_and_its_span_says_so(pool, mount_peers, root):
    """Scope, not permission: the model reached for a tool it was not shown,
    the call ran (the result reached the next round), and the trace says the
    specialism was crossed. A call inside the subset — or any of Nova's — has
    no such mark."""
    owner = await _owner(pool)
    agent = await _create(pool, mount_peers, tools=("workspace_read_file",))
    gateway = ScriptedGateway(
        rounds=(
            (
                _calls(
                    ("c1", "get_time", {}),
                    ("c2", "workspace_read_file", {"path": "missing.md"}),
                ),
            ),
            (text("it is now"),),
        )
    )
    mount_peers(gateway=gateway, memory=FakeMemory())

    turn, frames = await _agent_turn(pool, agent, owner, "what time is it")

    spans = [s for s in await _spans(pool, turn.id) if s["kind"] == "tool"]
    assert [(s["name"], s["meta"]["ok"], s["meta"].get("outside_subset")) for s in spans] == [
        ("get_time", True, True),
        ("workspace_read_file", False, None),
    ]
    tool_messages = [m for m in gateway.payloads[1]["messages"] if m["role"] == "tool"]
    assert [m["tool_call_id"] for m in tool_messages] == ["c1", "c2"]
    assert [
        (f["activity"]["tool"], f["activity"]["status"])
        for f in _parsed(frames)
        if isinstance(f, dict) and "activity" in f
    ] == [
        ("get_time", "start"),
        ("get_time", "ok"),
        ("workspace_read_file", "start"),
        ("workspace_read_file", "error"),
    ]
    assert await _reply(pool, turn.id) == "it is now"

    mount_peers(
        gateway=ScriptedGateway(rounds=((whole_call("c1", "get_time", {}),), (text("now"),))),
        memory=FakeMemory(),
    )
    nova_turn, _ = await _nova_turn(pool, owner, "what time is it")
    (nova_span,) = [s for s in await _spans(pool, nova_turn.id) if s["kind"] == "tool"]
    assert nova_span["meta"]["ok"] is True and "outside_subset" not in nova_span["meta"]


async def test_an_agents_rounds_walk_its_own_role(pool, mount_peers, root):
    owner = await _owner(pool)
    agent = await _create(pool, mount_peers)
    gateway = FakeGateway(deltas=("ok",))
    mount_peers(gateway=gateway, memory=FakeMemory())

    turn, _ = await _agent_turn(pool, agent, owner)

    (headers,) = [
        h
        for (path, _), h in zip(gateway.seen, gateway.seen_headers, strict=True)
        if path == "/v1/chat/completions"
    ]
    assert headers["x-nova-role"] == "agent_coder"
    assert headers["x-nova-purpose"] == "agent"
    assert headers["x-nova-turn-id"] == str(turn.id)
    assert headers["x-nova-person"] == str(owner.id)  # his money, not a phantom's

    mention_turn = await _open_agent_turn(pool, agent, owner, kind="chat")
    gateway = FakeGateway(deltas=("ok",))
    mount_peers(gateway=gateway, memory=FakeMemory())
    await _agent_turn(pool, agent, owner, turn=mention_turn)
    assert gateway.seen_headers[-1]["x-nova-role"] == "agent_coder"  # the role, not the kind

    gateway = FakeGateway(deltas=("ok",))
    mount_peers(gateway=gateway, memory=FakeMemory())
    await _nova_turn(pool, owner)
    assert gateway.seen_headers[-1]["x-nova-role"] == "chat"


# ── memory scopes ──────────────────────────────────────────────────────────


class _SplitMemory:
    """A /recall that answers for every partition but one — so a test can
    prove one failing scope never costs the other its notes."""

    def __init__(self, *, fail_for: str, results: tuple[dict, ...]) -> None:
        self.fail_for = fail_for
        self.results = results
        self.recalls: list[dict] = []
        self.app = Starlette(routes=[Route("/recall", self._recall, methods=["POST"])])

    async def _recall(self, request):
        body = await request.json()
        self.recalls.append(body)
        if body["person_id"] == self.fail_for:
            return JSONResponse({"error": "index unavailable"}, status_code=503)
        return JSONResponse({"results": list(self.results)})


async def test_recall_asks_one_partition_or_two_under_one_span(pool, mount_peers, root):
    owner = await _owner(pool)
    note = {"title": "Kitchen", "snippet": "the kettle is new"}

    agent = await _create(pool, mount_peers)  # read_shared_memory False
    memory = FakeMemory(results=(note,))
    gateway = ScriptedGateway(rounds=((text("ok"),),))
    mount_peers(gateway=gateway, memory=memory)
    turn, _ = await _agent_turn(pool, agent, owner)
    assert memory.recalls == [{"query": "do the task", "person_id": str(agent.id), "k": 5}]
    (recall,) = [s for s in await _spans(pool, turn.id) if s["kind"] == "memory_recall"]
    assert recall["meta"] == {"k": 5, "hits": 1}
    volatile = gateway.payloads[0]["messages"][1]["content"]
    assert "- Kitchen: the kettle is new" in volatile and "(shared)" not in volatile

    reader = await _create(pool, mount_peers, name="reader", read_shared_memory=True)
    memory = FakeMemory(results=(note,))
    gateway = ScriptedGateway(rounds=((text("ok"),),))
    mount_peers(gateway=gateway, memory=memory)
    turn, _ = await _agent_turn(pool, reader, owner)
    assert [r["person_id"] for r in memory.recalls] == [str(reader.id), str(owner.id)]
    assert {r["query"] for r in memory.recalls} == {"do the task"}
    (recall,) = [s for s in await _spans(pool, turn.id) if s["kind"] == "memory_recall"]
    assert recall["meta"] == {"k": 5, "scopes": {"own": 1, "shared": 1}, "hits": 2}
    volatile = gateway.payloads[0]["messages"][1]["content"]
    assert volatile.startswith(
        f"{chat.NOTES_HEADER}\n- Kitchen: the kettle is new"
        "\n- (shared) Kitchen: the kettle is new\n"
    )


async def test_one_failing_scope_never_loses_the_others_notes(pool, mount_peers, root):
    owner = await _owner(pool)
    reader = await _create(pool, mount_peers, name="reader", read_shared_memory=True)
    note = {"title": "Kitchen", "snippet": "the kettle is new"}

    memory = _SplitMemory(fail_for=str(owner.id), results=(note,))
    gateway = ScriptedGateway(rounds=((text("ok"),),))
    mount_peers(gateway=gateway, memory=memory)
    turn, _ = await _agent_turn(pool, reader, owner)
    (recall,) = [s for s in await _spans(pool, turn.id) if s["kind"] == "memory_recall"]
    assert recall["meta"]["scopes"] == {"own": 1, "shared": 0} and recall["meta"]["hits"] == 1
    assert set(recall["meta"]["errors"]) == {"shared"}
    assert recall["meta"]["errors"]["shared"].startswith("HTTPStatusError")
    volatile = gateway.payloads[0]["messages"][1]["content"]
    assert "- Kitchen: the kettle is new" in volatile and "(shared)" not in volatile

    memory = _SplitMemory(fail_for=str(reader.id), results=(note,))
    gateway = ScriptedGateway(rounds=((text("ok"),),))
    mount_peers(gateway=gateway, memory=memory)
    turn, _ = await _agent_turn(pool, reader, owner)
    (recall,) = [s for s in await _spans(pool, turn.id) if s["kind"] == "memory_recall"]
    assert recall["meta"]["scopes"] == {"own": 0, "shared": 1} and recall["meta"]["hits"] == 1
    assert set(recall["meta"]["errors"]) == {"own"}
    assert "- (shared) Kitchen: the kettle is new" in gateway.payloads[0]["messages"][1]["content"]


async def test_an_agent_turn_ingests_only_when_asked_and_only_its_own_scope(
    pool, mount_peers, root
):
    owner = await _owner(pool)
    agent = await _create(pool, mount_peers)

    memory = FakeMemory()
    mount_peers(gateway=ScriptedGateway(rounds=((text("report"),),)), memory=memory)
    turn, _ = await _agent_turn(pool, agent, owner, ingest=False)  # a delegation's brief
    await chat.drain_background()
    assert memory.ingests == []
    assert [s["kind"] for s in await _spans(pool, turn.id) if s["kind"] == "memory_ingest"] == []

    memory = FakeMemory()
    mount_peers(gateway=ScriptedGateway(rounds=((text("report"),),)), memory=memory)
    turn, _ = await _agent_turn(pool, agent, owner, "hi coder", ingest=True)  # an @mention
    await chat.drain_background()
    assert memory.ingests == [
        {
            "person_id": str(agent.id),
            "conversation_id": str(agent.log_conversation_id),
            "exchange": {"user": "hi coder", "assistant": "report"},
        }
    ]


# ── the roster ─────────────────────────────────────────────────────────────


async def test_novas_volatile_prompt_carries_the_roster_only_when_agents_exist(
    pool, mount_peers, root
):
    owner = await _owner(pool)
    await _create(pool, mount_peers)
    roster = (
        "Agents you can delegate to: coder — writes code (tools: get_time, workspace_read_file)"
    )

    gateway = ScriptedGateway(rounds=((text("hi"),),))
    mount_peers(gateway=gateway, memory=FakeMemory())
    turn, _ = await _nova_turn(pool, owner)
    messages = gateway.payloads[0]["messages"]
    assert [m["role"] for m in messages] == ["system", "system", "user"]
    # Memory's empty-handed statement, then the roster (S13 always says which
    # of "nothing matched" and "could not be read" happened; before it, a turn
    # with no notes carried the roster line alone).
    assert messages[1]["content"].startswith(
        "Her memory was searched for this turn and returned nothing:"
    )
    assert f"\n\n{roster}\n\nCurrent time: " in messages[1]["content"]
    # A roster that was read leaves no span: the span exists ONLY on failure.
    assert [s["kind"] for s in await _spans(pool, turn.id) if s["kind"] == "agent_roster"] == []

    gateway = ScriptedGateway(rounds=((text("hi"),),))
    mount_peers(
        gateway=gateway, memory=FakeMemory(results=({"title": "Kitchen", "snippet": "kettle"},))
    )
    await _nova_turn(pool, owner)
    assert gateway.payloads[0]["messages"][1]["content"].startswith(
        f"{chat.NOTES_HEADER}\n- Kitchen: kettle\n\n{roster}\n\nCurrent time: "
    )


# ── liveness and the progress channel ──────────────────────────────────────


async def test_doing_tracks_the_turn_and_is_cleared_after(pool, mount_peers, root, monkeypatch):
    """traces.DOING, observed from INSIDE the turn: 'starting' when memory is
    asked, 'thinking' when the gateway is, the tool's name while it runs —
    and nothing once the turn has closed."""
    seen: list[tuple[str, str | None]] = []
    turn_id: dict = {}

    async def spy(args: dict, ctx) -> str:
        seen.append(("tool", traces.doing(turn_id["id"])))
        return "spied"

    monkeypatch.setitem(
        tools.REGISTRY,
        "spy",
        tools.Tool(
            name="spy",
            description="records what the turn is doing",
            parameters={"type": "object", "properties": {}, "additionalProperties": False},
            executor=spy,
        ),
    )
    owner = await _owner(pool)
    agent = await _create(pool, mount_peers, tools=("spy",))
    gateway = ScriptedGateway(rounds=((whole_call("c1", "spy", {}),), (text("done"),)))
    memory = FakeMemory()
    mount_peers(gateway=gateway, memory=memory)

    def probing(inner, label: str):
        async def asgi(scope, receive, send):
            if scope["type"] == "http":
                seen.append((label, traces.doing(turn_id["id"])))
            await inner(scope, receive, send)

        return asgi

    app.state.peer_transports[fakes.GATEWAY_URL] = fakes.StreamingASGITransport(
        probing(gateway.app, "gateway")
    )
    app.state.peer_transports[fakes.MEMORY_URL] = fakes.StreamingASGITransport(
        probing(memory.app, "memory")
    )
    turn = await _open_agent_turn(pool, agent, owner)
    turn_id["id"] = turn.id
    assert traces.doing(turn.id) is None

    await _agent_turn(pool, agent, owner, turn=turn)

    assert seen == [
        ("memory", "starting"),
        ("gateway", "thinking"),
        ("tool", "spy"),
        ("gateway", "thinking"),
    ]
    assert traces.doing(turn.id) is None and turn.id not in traces.DOING


def test_a_dict_progress_report_contributes_only_the_allow_listed_keys():
    def activity(frame: str) -> dict:
        return json.loads(frame[len("data: ") :])["activity"]

    report = {
        "detail": "  coder is working  ",
        "agent": "coder",
        "agent_turn_id": str(uuid.UUID(int=1)),
        "step": "get_time",
        "step_status": "ok",
        # What a tool must never be able to write onto the frame.
        "tool": "forged",
        "status": "forged",
        "reason": "forged",
        "number": 3,
    }
    assert activity(chat._activity_frame("delegate_to_agent", "progress", detail=report)) == {
        "tool": "delegate_to_agent",
        "status": "progress",
        "detail": "coder is working",
        "agent": "coder",
        "agent_turn_id": str(uuid.UUID(int=1)),
        "step": "get_time",
        "step_status": "ok",
    }
    # A str report and the equivalent dict produce the same bytes.
    assert chat._activity_frame("model_pull", "progress", detail=" 42% ") == (
        chat._activity_frame("model_pull", "progress", detail={"detail": " 42% "})
    )
    assert activity(chat._activity_frame("model_pull", "progress", detail=" 42% ")) == {
        "tool": "model_pull",
        "status": "progress",
        "detail": "42%",
    }
    assert (
        activity(chat._activity_frame("x", "progress", detail={"detail": "y" * 500}))["detail"]
        == "y" * chat.ACTIVITY_REASON_LIMIT
    )
    # An empty or non-string value is not copied; a report on any other
    # status contributes nothing, as before.
    assert activity(chat._activity_frame("x", "progress", detail={"detail": "", "agent": 1})) == {
        "tool": "x",
        "status": "progress",
    }
    assert activity(chat._activity_frame("x", "ok", detail={"agent": "coder"})) == {
        "tool": "x",
        "status": "ok",
    }


def test_a_progress_report_may_carry_a_percent_and_nothing_else_numeric():
    """S15: a bar needs a NUMBER, and the words cannot be parsed for one.

    `percent` is the one numeric key a tool may put on a frame, so the chat
    can draw a determinate bar for any long call that knows its own fraction
    — not a pull-shaped special case. It is clamped here rather than trusted,
    and every other numeric key stays uncopyable.
    """

    def activity(frame: str) -> dict:
        return json.loads(frame[len("data: ") :])["activity"]

    assert activity(
        chat._activity_frame("model_pull", "progress", detail={"detail": "42%", "percent": 42})
    ) == {"tool": "model_pull", "status": "progress", "detail": "42%", "percent": 42}

    def percent_of(value) -> int:
        return activity(chat._activity_frame("x", "progress", detail={"percent": value}))["percent"]

    # Clamped, not trusted: a tool's arithmetic is not the frame's contract.
    assert percent_of(142) == 100
    assert percent_of(-5) == 0
    # A fraction of a point is not a percent anyone can see; it rides as an int.
    assert percent_of(42.7) == 42
    # Anything that is not a real number is dropped, exactly like a non-string
    # `detail` — including a bool, which Python would otherwise count as an int.
    for bad in ("42", True, None, [42], {"n": 42}, float("nan"), float("inf"), float("-inf")):
        assert activity(chat._activity_frame("x", "progress", detail={"percent": bad})) == {
            "tool": "x",
            "status": "progress",
        }
    # Still only on progress, like every other report key.
    assert activity(chat._activity_frame("x", "ok", detail={"percent": 42})) == {
        "tool": "x",
        "status": "ok",
    }


async def test_a_tools_progress_reports_reach_the_stream_str_or_dict(
    pool, mount_peers, root, monkeypatch
):
    async def reporter(args: dict, ctx) -> str:
        ctx.progress("pulling 42%")
        ctx.progress({"detail": "coder is working", "agent": "coder", "step": "get_time"})
        return "reported"

    monkeypatch.setitem(
        tools.REGISTRY,
        "reporter",
        tools.Tool(
            name="reporter",
            description="reports progress both ways",
            parameters={"type": "object", "properties": {}, "additionalProperties": False},
            executor=reporter,
        ),
    )
    owner = await _owner(pool)
    agent = await _create(pool, mount_peers, tools=("reporter",))
    mount_peers(
        gateway=ScriptedGateway(rounds=((whole_call("c1", "reporter", {}),), (text("ok"),))),
        memory=FakeMemory(),
    )

    _, frames = await _agent_turn(pool, agent, owner)

    activities = [f["activity"] for f in _parsed(frames) if isinstance(f, dict) and "activity" in f]
    assert activities == [
        {"tool": "reporter", "status": "start"},
        {"tool": "reporter", "status": "progress", "detail": "pulling 42%"},
        {
            "tool": "reporter",
            "status": "progress",
            "detail": "coder is working",
            "agent": "coder",
            "step": "get_time",
        },
        {"tool": "reporter", "status": "ok"},
    ]


# ── the review's findings on the spine ─────────────────────────────────────


async def test_a_call_to_no_tool_is_answered_from_the_subset(pool, mount_peers, root):
    """An agent that names a tool NO one has is told which tools it was GIVEN
    — its subset, in order — never the whole registry. tools.dispatch's own
    sentence lists all of it as "the tools you have", which for an agent is
    a lie about its hands and a map of everything it was not shown. No
    registered tool ran; the span records the call and why it did not; the
    refusal is synchronous (test_no_approvals pins the await list). Nova
    (subset None) keeps dispatch's sentence: the whole registry IS hers."""
    owner = await _owner(pool)
    agent = await _create(pool, mount_peers)  # SUBSET
    gateway = ScriptedGateway(
        rounds=(
            (whole_call("c1", "workspace_read", {"path": "x.md"}),),
            (text("that tool does not exist"),),
        )
    )
    mount_peers(gateway=gateway, memory=FakeMemory())

    turn, frames = await _agent_turn(pool, agent, owner, "read x.md")

    refusal = (
        "Error: there is no tool named 'workspace_read' — the tools you were given are: "
        "get_time, workspace_read_file"
    )
    assert chat.unknown_tool_refusal("workspace_read", SUBSET) == refusal
    spans = [s for s in await _spans(pool, turn.id) if s["kind"] == "tool"]
    assert [(s["name"], s["meta"]["ok"], s["meta"]["reason"]) for s in spans] == [
        ("workspace_read", False, "unknown_tool")
    ]
    assert spans[0]["meta"]["args_redacted"] == {"path": "x.md"}
    assert spans[0]["meta"]["error"] == refusal
    assert [m for m in gateway.payloads[1]["messages"] if m["role"] == "tool"] == [
        {"role": "tool", "tool_call_id": "c1", "content": refusal}
    ]
    assert [
        (f["activity"]["tool"], f["activity"]["status"])
        for f in _parsed(frames)
        if isinstance(f, dict) and "activity" in f
    ] == [("workspace_read", "start"), ("workspace_read", "error")]
    assert await _reply(pool, turn.id) == "that tool does not exist"
    assert await pool.fetchval("SELECT status FROM turns WHERE id = $1", turn.id) == "ok"

    gateway = ScriptedGateway(
        rounds=((whole_call("c1", "workspace_read", {"path": "x.md"}),), (text("no"),))
    )
    mount_peers(gateway=gateway, memory=FakeMemory())
    nova_turn, _ = await _nova_turn(pool, owner, "read x.md")
    (span,) = [s for s in await _spans(pool, nova_turn.id) if s["kind"] == "tool"]
    assert span["meta"]["ok"] is False and "reason" not in span["meta"]
    (msg,) = [m for m in gateway.payloads[1]["messages"] if m["role"] == "tool"]
    assert msg["content"] == (
        "Error: there is no tool named 'workspace_read' — the tools you have are: "
        f"{', '.join(tools.tool_names())} — re-issue the call"
    )


async def test_the_rows_round_budget_wins_over_the_argument(pool, mount_peers, root):
    """Rounds are ONE fact — the agent's own row, the number its prompt
    states. A caller handing the funnel a different number (the global
    setting, say) does not get it: with max_tool_rounds=1 on the row and 5
    as the argument, a gateway scripted for two tool rounds is stopped after
    one, through the ordinary out-of-rounds path."""
    owner = await _owner(pool)
    agent = await _create(pool, mount_peers, max_tool_rounds=1)
    gateway = ScriptedGateway(
        rounds=(
            (whole_call("c1", "get_time", {}),),
            (whole_call("c2", "get_time", {}),),
            (text("late"),),
        )
    )
    mount_peers(gateway=gateway, memory=FakeMemory())

    turn, _ = await _agent_turn(pool, agent, owner, "what time is it", max_tool_rounds=5)

    assert "You have 1 tool rounds per task." in gateway.payloads[0]["messages"][0]["content"]
    assert gateway.calls == 2  # the one tool round, then the closing narration round
    spans = [s for s in await _spans(pool, turn.id) if s["kind"] == "tool"]
    assert [
        (s["name"], s["meta"]["ok"], s["meta"].get("refused_out_of_rounds")) for s in spans
    ] == [("get_time", False, True)]
    assert await _reply(pool, turn.id) == "[stopped after 1 tool rounds without finishing]"
    assert await pool.fetchval("SELECT status FROM turns WHERE id = $1", turn.id) == "ok"


async def test_redirect_and_judge_rounds_walk_the_turns_own_role(pool, mount_peers, root):
    """_collect_completion (the judge and every redirect) stamps the TURN's
    role when it has one — an agent's redirect rounds walk ITS chain and
    count against ITS cap — and `judge` otherwise, as before. And it is a
    gateway round like any other: DOING says `thinking` while it runs."""
    owner = await _owner(pool)
    agent = await _create(pool, mount_peers)
    gateway = FakeGateway(deltas=("ok",))
    mount_peers(gateway=gateway, memory=FakeMemory())
    seen_doing: list[str | None] = []
    probed: dict = {}

    async def probing(scope, receive, send):
        if scope["type"] == "http":
            seen_doing.append(traces.doing(probed["id"]))
        await gateway.app(scope, receive, send)

    app.state.peer_transports[fakes.GATEWAY_URL] = fakes.StreamingASGITransport(probing)
    ask = [{"role": "user", "content": "hi"}]

    turn = await _open_agent_turn(pool, agent, owner)
    probed["id"] = turn.id
    try:
        got = await chat._collect_completion(app, turn, MODEL, ask, purpose="redirect")
    finally:
        traces.clear_doing(turn.id)
    assert got == "ok"
    assert gateway.seen_headers[-1]["x-nova-role"] == "agent_coder"
    assert gateway.seen_headers[-1]["x-nova-purpose"] == "redirect"
    assert seen_doing == ["thinking"]

    conversation = await conversations.active_conversation(pool, owner)
    plain = await traces.open_turn(
        pool, conversation_id=conversation["id"], model=MODEL, person_id=owner.id
    )
    probed["id"] = plain.id
    try:
        await chat._collect_completion(app, plain, MODEL, ask, purpose="judge")
    finally:
        traces.clear_doing(plain.id)
    assert gateway.seen_headers[-1]["x-nova-role"] == "judge"
    assert seen_doing == ["thinking", "thinking"]


async def test_a_turn_opened_as_one_identity_is_never_run_as_another(pool, mount_peers, root):
    """The turn row says who did the work; the persona says whose tools,
    folder and cap it runs under. Two answers is a programming error in the
    caller: it is STATED — the failure persisted as the assistant row, the
    error frame, status 'error', the turn closed — and never run through,
    because running through would bill one identity for another's work."""
    owner = await _owner(pool)
    agent = await _create(pool, mount_peers)
    gateway = FakeGateway(deltas=("must never stream",))
    memory = FakeMemory()
    mount_peers(gateway=gateway, memory=memory)
    conversation = await conversations.active_conversation(pool, owner)
    nova_turn = await traces.open_turn(
        pool, conversation_id=conversation["id"], model=MODEL, person_id=owner.id
    )

    turn, frames = await _agent_turn(pool, agent, owner, turn=nova_turn)

    reason = (
        f"the turn failed — ValueError: turn {turn.id} was opened as nova but is being run as "
        "agent_coder"
    )
    assert _parsed(frames) == [{"error": reason}, "[DONE]"]
    assert await _reply(pool, turn.id) == chat.turn_failure_statement(reason, [])
    assert await pool.fetchval("SELECT status FROM turns WHERE id = $1", turn.id) == "error"
    assert gateway.seen == [] and memory.recalls == [] and memory.ingests == []
    assert traces.doing(turn.id) is None and turn.id not in traces.INFLIGHT

    writer = await _create(pool, mount_peers, name="writer")
    mount_peers(gateway=FakeGateway(deltas=("no",)), memory=FakeMemory())
    coder_turn = await _open_agent_turn(pool, agent, owner)
    _, frames = await _agent_turn(
        pool, agent, owner, turn=coder_turn, persona=agents.persona_for(writer, owner_id=owner.id)
    )
    assert _parsed(frames)[0] == {
        "error": (
            f"the turn failed — ValueError: turn {coder_turn.id} was opened as agent_coder but "
            "is being run as agent_writer"
        )
    }
    assert await pool.fetchval("SELECT status FROM turns WHERE id = $1", coder_turn.id) == "error"


async def test_a_roster_that_cannot_be_read_leaves_a_span(pool, mount_peers, root, monkeypatch):
    """Fail-open, never quiet: a roster read that raises costs the prompt its
    roster line (the turn runs as if no agents existed) and files an
    `agent_roster` span saying why — the span that a turn whose roster WAS
    read never has (pinned in the roster test above)."""
    owner = await _owner(pool)
    await _create(pool, mount_peers)

    async def broken(pool):
        raise RuntimeError("agents table gone")

    monkeypatch.setattr(agents, "roster_line", broken)
    gateway = ScriptedGateway(rounds=((text("hi"),),))
    mount_peers(gateway=gateway, memory=FakeMemory())

    turn, _ = await _nova_turn(pool, owner)

    assert await _reply(pool, turn.id) == "hi"
    assert await pool.fetchval("SELECT status FROM turns WHERE id = $1", turn.id) == "ok"
    (span,) = [s for s in await _spans(pool, turn.id) if s["kind"] == "agent_roster"]
    assert span["meta"] == {"error": "RuntimeError: agents table gone"}
    # The volatile message is memory's empty-handed statement and nothing else:
    # the roster line is what the failed read cost this turn.
    messages = gateway.payloads[0]["messages"]
    assert [m["role"] for m in messages] == ["system", "system", "user"]
    assert messages[1]["content"].startswith(
        "Her memory was searched for this turn and returned nothing:"
    )
    assert "delegate to" not in messages[1]["content"]


async def test_the_listing_guard_judges_an_agent_by_its_own_listing_tools(pool, mount_peers, root):
    """The presented-listing sites read Persona.listing_tools — the registry's
    listing tools narrowed to the persona's subset, derived once when the
    persona is built — so an agent is judged by the listing tools it was
    GIVEN (the span names exactly those), and Nova by every one registered."""
    owner = await _owner(pool)
    agent = await _create(pool, mount_peers, tools=("get_time", "workspace_list_files"))
    persona = agents.persona_for(agent, owner_id=owner.id)
    assert persona.listing_tools == ("workspace_list_files",)
    assert agents.nova_persona().listing_tools == tuple(
        tools.tool_names_by_result_kind(tools.RESULT_KIND_LISTING)
    )
    # The measured reply, then a redirect that presents the same unbacked
    # listing again — so the regen is refused by the same guard, over the
    # same listing tools, and the turn still ends 'ok' with the correction.
    gateway = ScriptedGateway(rounds=((text(FABRICATED),), (text(FABRICATED),)))
    mount_peers(gateway=gateway, memory=FakeMemory())

    turn, _ = await _agent_turn(pool, agent, owner, "list the workspace")

    (guard,) = [s for s in await _spans(pool, turn.id) if s["kind"] == "guard"]
    assert guard["name"] == "presented_listing"
    assert guard["meta"]["listing_tools"] == ["workspace_list_files"]
    assert guard["meta"]["redirected"] is False
    assert await pool.fetchval("SELECT status FROM turns WHERE id = $1", turn.id) == "ok"


# ── the delegation-claim guard, wired (S12-3b) ─────────────────────────────
#
# guards.delegation_claim_check is pinned on its own in test_guards.py; what
# these pin is the WIRING in chat._run_turn's closer: the roster is read
# LIVE once per turn (agents.names), the check runs right after narration,
# a fired one files the `delegation_claim` guard span {agent, phrase,
# backing}, ships a {correction} frame, APPENDS the correction to the
# durable reply (narration's class — the prose beside the claim may be
# real), and marks the turn plumbing (never ingested); a backed claim is
# left alone; a claim backed only by a FAILED run says "did not finish";
# an agent's turn is checked the same way about OTHER agents (in the agent's
# own words — it cannot delegate) and about itself by narration's rule; the
# redirect vetting refuses a regeneration by the same guard; a roster read
# that fails silences the guard and files an `agent_names` span, which a turn
# whose roster WAS read never has. The names the guard is given are the
# roster MINUS whoever this conversation already has on record (see the
# section at the end of this file).
# The delegate_to_agent tool itself is not what is under test here, so its
# span is filed by hand exactly as chat._run_tool records one.

CLAIM = "coder built the kitchen list."


def _run_facts(agent: str, *, status: str) -> dict:
    """The facts entry agents.delegate really appends for a run that HAPPENED,
    built from the dataclass that writes it (RunFacts.as_facts) rather than
    typed out here — so this suite's hand-filed spans cannot drift from the
    real tool's. `agent_turn_id` is the key that matters (2026-09-08): it is
    present exactly when a child turn actually opened, which is how a failed
    RUN is told from a call refused before anything ran."""
    # Every field named by the dataclass itself, so a field ADDED to RunFacts
    # never breaks this double; only the four as_facts actually reads are
    # given values.
    fields = {f.name: None for f in dataclasses.fields(agents.RunFacts)}
    fields.update(agent=agent, turn_id=uuid.uuid4(), status=status, files=())
    return agents.RunFacts(**fields).as_facts()


def _delegate_span(turn: traces.Turn, agent: str, *, ok: bool) -> None:
    """A delegate_to_agent tool span as chat._run_tool records one — the
    executor's facts on success AND failure, the call's own argument
    redacted — filed on the turn before it runs, so the closer reads it off
    turn.spans exactly as it would the real tool's."""
    with turn.span("tool", agents.DELEGATE_TOOL) as span:
        span.meta.update(
            ok=ok,
            args_redacted={"agent": agent, "task": "the kitchen list"},
            facts=[_run_facts(agent, status="ok" if ok else "error")],
        )


def _refused_delegate_span(turn: traces.Turn, agent: str, reason: str) -> None:
    """The span a delegation REFUSED before any turn opened leaves (2026-09-08):
    agents.delegate pushes {agent, status: 'refused', reason} onto the facts
    sink before raising, so the trace says a delegation was refused rather
    than nothing at all. No `agent_turn_id`: nothing ran, so a claim about
    that agent is unbacked, never "did not finish"."""
    with turn.span("tool", agents.DELEGATE_TOOL) as span:
        span.meta.update(
            ok=False,
            args_redacted={"agent": agent, "task": "the kitchen list"},
            facts=[{"agent": agent, "status": "refused", "reason": reason}],
        )


async def _open_nova_turn(pool, owner: Person) -> traces.Turn:
    conversation = await conversations.active_conversation(pool, owner)
    return await traces.open_turn(
        pool, conversation_id=conversation["id"], model=MODEL, person_id=owner.id
    )


def _guard_spans(spans: list) -> list[tuple[str, dict]]:
    return [(s["name"], s["meta"]) for s in spans if s["kind"] == "guard"]


def _corrections(frames: list) -> list[str]:
    return [f["correction"] for f in _parsed(frames) if isinstance(f, dict) and "correction" in f]


async def _status(pool, turn_id) -> str | None:
    return await pool.fetchval("SELECT status FROM turns WHERE id = $1", turn_id)


async def test_an_unbacked_agent_claim_is_corrected_appended_and_not_ingested(
    pool, mount_peers, root
):
    owner = await _owner(pool)
    await _create(pool, mount_peers)
    memory = FakeMemory()
    mount_peers(gateway=ScriptedGateway(rounds=((text(CLAIM),),)), memory=memory)

    turn, frames = await _nova_turn(pool, owner, "is the kitchen list done?")

    correction = guards.DELEGATION_UNBACKED_CORRECTION.format(agent="coder")
    spans = await _spans(pool, turn.id)
    assert _guard_spans(spans) == [
        ("delegation_claim", {"agent": "coder", "phrase": CLAIM, "backing": "none"})
    ]
    # The roster WAS read: no agent_names span (it exists only on failure).
    assert [s for s in spans if s["kind"] == "agent_names"] == []
    # The correction ships on its own frame, after the prose it contradicts.
    parsed = _parsed(frames)
    assert _corrections(frames) == [correction]
    assert parsed.index({"t": CLAIM}) < parsed.index({"correction": correction})
    assert parsed[-1] == "[DONE]"
    # APPENDED, never replaced: the durable record is what she said AND the
    # contradiction — and the turn still closes ok (a correction is not a
    # failure).
    assert await _reply(pool, turn.id) == f"{CLAIM}\n\n{correction}"
    assert await _status(pool, turn.id) == "ok"
    # Plumbing: not ingested, and the trace says no ingest was even queued.
    await chat.drain_background()
    assert memory.ingests == []
    assert [s for s in spans if s["kind"] == "memory_ingest"] == []


async def test_a_backed_agent_claim_stands_and_is_ingested(pool, mount_peers, root):
    owner = await _owner(pool)
    await _create(pool, mount_peers)
    memory = FakeMemory()
    mount_peers(gateway=ScriptedGateway(rounds=((text(CLAIM),),)), memory=memory)
    turn = await _open_nova_turn(pool, owner)
    _delegate_span(turn, "coder", ok=True)

    turn, frames = await _nova_turn(pool, owner, "is the kitchen list done?", turn=turn)

    spans = await _spans(pool, turn.id)
    assert _guard_spans(spans) == []
    assert _corrections(frames) == []
    assert await _reply(pool, turn.id) == CLAIM
    assert await _status(pool, turn.id) == "ok"
    await chat.drain_background()
    assert [i["exchange"]["assistant"] for i in memory.ingests] == [CLAIM]


async def test_a_claim_backed_only_by_a_failed_run_says_did_not_finish(pool, mount_peers, root):
    owner = await _owner(pool)
    await _create(pool, mount_peers)
    memory = FakeMemory()
    mount_peers(gateway=ScriptedGateway(rounds=((text(CLAIM),),)), memory=memory)
    turn = await _open_nova_turn(pool, owner)
    _delegate_span(turn, "coder", ok=False)

    turn, frames = await _nova_turn(pool, owner, "is the kitchen list done?", turn=turn)

    correction = guards.DELEGATION_FAILED_CORRECTION.format(agent="coder")
    assert _guard_spans(await _spans(pool, turn.id)) == [
        ("delegation_claim", {"agent": "coder", "phrase": CLAIM, "backing": "failed"})
    ]
    assert _corrections(frames) == [correction]
    assert await _reply(pool, turn.id) == f"{CLAIM}\n\n{correction}"
    assert await _status(pool, turn.id) == "ok"
    await chat.drain_background()
    assert memory.ingests == []


async def test_an_agents_turn_about_another_agent_gets_the_agent_correction(
    pool, mount_peers, root
):
    """An agent crediting ANOTHER agent with work is the same fabrication as
    Nova doing it, and is corrected on its own turn — even an @mention turn
    that would otherwise ingest. The TEXT is the agent variant (pin moved
    2026-09-08): Nova's "Tell me again and I'll delegate it" would be a
    promise delegate_to_agent refuses an agent outright, so what coder is
    made to say instead is what is true for it — it cannot delegate, so Nova
    has to."""
    owner = await _owner(pool)
    coder = await _create(pool, mount_peers)
    await _create(pool, mount_peers, name="writer")
    about_writer = "writer finished the draft."
    memory = FakeMemory()
    mount_peers(gateway=ScriptedGateway(rounds=((text(about_writer),),)), memory=memory)

    turn, frames = await _agent_turn(pool, coder, owner, "how is the draft?", ingest=True)

    correction = guards.DELEGATION_UNBACKED_CORRECTION_AGENT.format(agent="writer")
    # Not Nova's text, and carrying none of its promise: an agent that says
    # "tell me again and I'll delegate it" is promising a call the tool
    # refuses it (tools/agents.AGENT_CANNOT_DELEGATE).
    assert correction != guards.DELEGATION_UNBACKED_CORRECTION.format(agent="writer")
    assert "I'll delegate it" not in correction and "I’ll delegate it" not in correction
    assert _guard_spans(await _spans(pool, turn.id)) == [
        ("delegation_claim", {"agent": "writer", "phrase": about_writer, "backing": "none"})
    ]
    assert _corrections(frames) == [correction]
    assert await _reply(pool, turn.id) == f"{about_writer}\n\n{correction}"
    await chat.drain_background()
    assert memory.ingests == []


async def test_an_agents_turn_about_itself_is_judged_by_narrations_rule(pool, mount_peers, root):
    """An agent writing its OWN name is not a delegation claim — it cannot
    delegate, and "I did not hand anything to coder" written by coder would
    be the lie. It is narration with the pronoun changed, so it is judged by
    narration's fact: did ANY tool run this turn (pin moved 2026-09-08 —
    this used to pass unchecked, which let "coder finished the tests" from a
    turn that ran nothing stand as a record).

    Unbacked it earns the self correction, in the first person, and the turn
    is plumbing. With a tool actually run behind it, nothing fires and the
    exchange is ingested like any other."""
    owner = await _owner(pool)
    coder = await _create(pool, mount_peers)
    about_itself = "coder finished the tests."

    memory = FakeMemory()
    mount_peers(gateway=ScriptedGateway(rounds=((text(about_itself),),)), memory=memory)
    turn, frames = await _agent_turn(pool, coder, owner, "how are the tests?", ingest=True)

    assert _guard_spans(await _spans(pool, turn.id)) == [
        ("delegation_claim", {"agent": "coder", "phrase": about_itself, "backing": "none"})
    ]
    assert _corrections(frames) == [guards.DELEGATION_SELF_CORRECTION]
    assert await _reply(pool, turn.id) == f"{about_itself}\n\n{guards.DELEGATION_SELF_CORRECTION}"
    await chat.drain_background()
    assert memory.ingests == []

    memory = FakeMemory()
    mount_peers(
        gateway=ScriptedGateway(
            rounds=((whole_call("c1", "get_time", {}),), (text(about_itself),))
        ),
        memory=memory,
    )
    turn, frames = await _agent_turn(pool, coder, owner, "how are the tests?", ingest=True)

    # A tool really ran this turn — narration's fact, and so this guard's.
    assert [
        (s["name"], s["meta"]["ok"]) for s in await _spans(pool, turn.id) if s["kind"] == "tool"
    ] == [("get_time", True)]
    assert _guard_spans(await _spans(pool, turn.id)) == []
    assert _corrections(frames) == []
    assert await _reply(pool, turn.id) == about_itself
    await chat.drain_background()
    assert [i["exchange"]["assistant"] for i in memory.ingests] == [about_itself]


async def test_a_roster_that_cannot_be_read_silences_the_guard_and_says_so(
    pool, mount_peers, root, monkeypatch
):
    """Fail-open, never quiet: a names read that raises costs the turn its
    delegation check (no names, no claim — precision-first) and files an
    `agent_names` span saying why. The reply ships uncorrected and the turn
    closes ok."""
    owner = await _owner(pool)
    await _create(pool, mount_peers)

    async def broken(pool):
        raise RuntimeError("agents table gone")

    monkeypatch.setattr(agents, "names", broken)
    mount_peers(gateway=ScriptedGateway(rounds=((text(CLAIM),),)), memory=FakeMemory())

    turn, frames = await _nova_turn(pool, owner, "is the kitchen list done?")

    spans = await _spans(pool, turn.id)
    assert _guard_spans(spans) == []
    (span,) = [s for s in spans if s["kind"] == "agent_names"]
    assert span["meta"] == {"error": "RuntimeError: agents table gone"}
    assert _corrections(frames) == []
    assert await _reply(pool, turn.id) == CLAIM
    assert await _status(pool, turn.id) == "ok"


async def test_the_redirect_vetting_refuses_a_regeneration_that_credits_an_agent(pool, root):
    """_regen_rejected_by carries the same check, fed the same live names,
    right after narration and before the capability check — a lie about a
    helper is no better for having been written on the second try; with no
    roster there is no claim; a backed one passes."""
    owner = await _owner(pool)
    turn = await _open_nova_turn(pool, owner)
    tool_ctx = tools.context_for(app, owner, facts_sink=[])
    args = (CLAIM, turn, tool_ctx, [], "is it done?", agents.nova_persona())

    assert chat._regen_rejected_by(*args, agent_names=["coder"]) == "delegation_claim"
    assert chat._regen_rejected_by(*args, agent_names=[]) is None
    _delegate_span(turn, "coder", ok=True)
    assert chat._regen_rejected_by(*args, agent_names=["coder"]) is None

    source = inspect.getsource(chat._regen_rejected_by)
    assert (
        source.index('"narration"')
        < source.index('"delegation_claim"')
        < source.index('"capability_claim"')
    )


# ── what this conversation already has on record (2026-09-08) ──────────────
#
# The review's finding on the guard's wiring: its fact is a successful
# delegate_to_agent span of THIS turn, which made "coder wrote hello.py" a
# fabrication the turn AFTER coder really wrote it — @coder in turn 1, Nova
# reporting it in turn 2 — and the correction ("I did not hand anything to
# coder this turn") was then itself the lie, about work the owner watched
# happen. So chat._agent_names now hands the guard the roster MINUS the
# agents this conversation already has on record before this turn: one that
# wrote an assistant row here, and one an earlier turn of this conversation
# successfully delegated to. Precision-first, the family rule.
#
# These run through the real POST /api/v1/chat/stream — the exemption is a
# fact about a CONVERSATION across turns, and a helper that calls _run_turn
# directly cannot show it.


async def _last_chat_turn(pool):
    return await pool.fetchval(
        "SELECT id FROM turns WHERE kind = 'chat' ORDER BY started_at DESC LIMIT 1"
    )


async def test_an_agent_that_answered_here_backs_a_later_claim_about_it(
    owner_client, pool, mount_peers, root
):
    """Turn 1: @coder writes hello.py for real, in the owner's conversation.
    Turn 2: Nova reports it. Nothing was delegated in turn 2 — and nothing
    needed to be: coder answered here, in front of him. No guard span, the
    reply stands verbatim, and the turn is knowledge (ingested), not
    plumbing."""
    await _create(pool, mount_peers, tools=("workspace_write_file",))
    await _set_model(owner_client)
    mount_peers(
        gateway=ScriptedGateway(
            rounds=(
                (whole_call("c1", "workspace_write_file", {"path": "hello.py", "content": "x\n"}),),
                (text("hello.py is in my folder now"),),
            )
        ),
        memory=FakeMemory(),
    )
    assert (await _say(owner_client, "@coder write hello.py"))[0] == 200
    assert (root / "agents" / "coder" / "hello.py").read_text(encoding="utf-8") == "x\n"

    claim = "coder wrote hello.py in its folder."
    memory = FakeMemory()
    mount_peers(gateway=ScriptedGateway(rounds=((text(claim),),)), memory=memory)
    assert (await _say(owner_client, "is hello.py done?"))[0] == 200

    turn_id = await _last_chat_turn(pool)
    assert _guard_spans(await _spans(pool, turn_id)) == []
    assert await _reply(pool, turn_id) == claim
    assert await _status(pool, turn_id) == "ok"
    await chat.drain_background()
    assert [i["exchange"]["assistant"] for i in memory.ingests] == [claim]


async def test_a_delegation_in_an_earlier_turn_backs_a_later_claim_about_it(
    owner_client, pool, mount_peers, root
):
    """The same fact by the other route: turn 1 really delegates (the child's
    turn runs in the AGENT's log conversation, so it leaves no assistant row
    HERE — the successful delegate span of the earlier turn is what says it
    happened). Turn 2's report of it is not corrected."""
    await _create(pool, mount_peers)
    await _set_model(owner_client)
    mount_peers(
        gateway=ScriptedGateway(
            rounds=(
                (whole_call("n1", agents.DELEGATE_TOOL, {"agent": "coder", "task": "a haiku"}),),
                (text("done"),),  # the child's own turn, in its log conversation
                (text("coder has finished it."),),  # backed by the span of THIS turn
            )
        ),
        memory=FakeMemory(),
    )
    assert (await _say(owner_client, "ask coder to write a haiku"))[0] == 200
    first = await _last_chat_turn(pool)
    (delegated,) = [
        s for s in await _spans(pool, first) if s["kind"] == "tool" and s["meta"]["ok"] is True
    ]
    assert delegated["name"] == agents.DELEGATE_TOOL
    assert _guard_spans(await _spans(pool, first)) == []

    claim = "coder wrote haiku.md for you."
    memory = FakeMemory()
    mount_peers(gateway=ScriptedGateway(rounds=((text(claim),),)), memory=memory)
    assert (await _say(owner_client, "did coder do it?"))[0] == 200

    turn_id = await _last_chat_turn(pool)
    assert turn_id != first
    assert _guard_spans(await _spans(pool, turn_id)) == []
    assert await _reply(pool, turn_id) == claim
    assert await _status(pool, turn_id) == "ok"
    await chat.drain_background()
    assert [i["exchange"]["assistant"] for i in memory.ingests] == [claim]


async def test_a_claim_about_an_agent_that_never_appeared_here_is_still_corrected(
    owner_client, pool, mount_peers, root
):
    """The exemption is per AGENT, not per conversation: in the very reply
    where coder (which answered here) is left alone, writer — a name this
    conversation has never seen run — is contradicted."""
    await _create(pool, mount_peers)
    await _create(pool, mount_peers, name="writer")
    await _set_model(owner_client)
    mount_peers(gateway=FakeGateway(deltas=("hello",)), memory=FakeMemory())
    assert (await _say(owner_client, "@coder hi"))[0] == 200

    claim = "coder read the notes. Writer finished the draft."
    memory = FakeMemory()
    mount_peers(gateway=ScriptedGateway(rounds=((text(claim),),)), memory=memory)
    assert (await _say(owner_client, "how is the draft?"))[0] == 200

    turn_id = await _last_chat_turn(pool)
    ((name, meta),) = _guard_spans(await _spans(pool, turn_id))
    assert name == "delegation_claim"
    assert (meta["agent"], meta["backing"]) == ("writer", "none")
    assert meta["phrase"] in claim
    correction = guards.DELEGATION_UNBACKED_CORRECTION.format(agent="writer")
    assert await _reply(pool, turn_id) == f"{claim}\n\n{correction}"
    await chat.drain_background()
    assert memory.ingests == []


async def test_a_delegation_refused_before_it_ran_is_not_a_run_that_failed(pool, mount_peers, root):
    """ "Did not finish" says a child turn ran and ended badly. A delegation
    refused BEFORE anything ran — an unknown agent, an empty task, an agent
    trying to delegate — is not that: its facts entry carries no
    `agent_turn_id`, so the claim is unbacked and gets the unbacked
    correction. The trace still says a delegation was refused (the span is
    there, ok False), which is why the wiring has to tell the two apart."""
    owner = await _owner(pool)
    await _create(pool, mount_peers)
    memory = FakeMemory()
    mount_peers(gateway=ScriptedGateway(rounds=((text(CLAIM),),)), memory=memory)
    turn = await _open_nova_turn(pool, owner)
    _refused_delegate_span(turn, "coder", "task is empty — say what coder should do")

    turn, frames = await _nova_turn(pool, owner, "is the kitchen list done?", turn=turn)

    correction = guards.DELEGATION_UNBACKED_CORRECTION.format(agent="coder")
    assert _guard_spans(await _spans(pool, turn.id)) == [
        ("delegation_claim", {"agent": "coder", "phrase": CLAIM, "backing": "none"})
    ]
    assert _corrections(frames) == [correction]
    assert await _reply(pool, turn.id) == f"{CLAIM}\n\n{correction}"
    await chat.drain_background()
    assert memory.ingests == []
