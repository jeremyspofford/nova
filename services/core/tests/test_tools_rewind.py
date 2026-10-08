"""Remaining inverses (chat-rewind epic, T3).

memory_save, create_timer, create_agent, update_agent and set_chat_model each
append ONE JSON-serialisable undo payload to ctx.undo_sink on success, and
each declares a Tool.revert that performs the inverse and VERIFIES it from a
fresh read before saying so. A revert that cannot act or cannot verify raises
ToolFailure with the reason and claims nothing.

Payload contract (pinned here so T4 reads one shape):
  memory_save    -> {"path": the path memory confirmed}
  create_timer   -> {"timer_id": str uuid}
  create_agent   -> {"name": str, "agent_id": str uuid}
  update_agent   -> {"name": str, "prior": {field: value before},
                     "landed": {field: value after}}  (keys = changed fields)
  set_chat_model -> {"prior_model": str, "prior_chain": [str],
                     "landed_model": str}
Refusal words: already gone -> /gone/, changed since -> /changed/, an inverse
that does not read back -> /verif/ (memory: /verif|confirm/).
"""

from __future__ import annotations

import dataclasses
import json
import types
import uuid

import pytest
from starlette.responses import JSONResponse

from app import agents, settings_store, timers, tools
from app.identity import Person
from app.main import app
from app.tools.base import ToolContext, ToolFailure
from tests import fakes
from tests.conftest import requires_db
from tests.fakes import FakeGateway, FakeMemory, ScriptedGateway

REVERTIBLE = {
    "workspace_write_file",
    "workspace_delete",
    "memory_save",
    "create_timer",
    "create_agent",
    "update_agent",
    "set_chat_model",
}

GEMINI = "openrouter:google/gemini-3.8-flash"
GLM = "openrouter:z-ai/glm-5.3-flash"
DELL = "dell:qwen3:8b"


def _revert(name: str):
    fn = tools.REGISTRY[name].revert
    assert fn is not None, f"{name} declares no Tool.revert"
    return fn


def _one(sink: list) -> dict:
    assert len(sink) == 1, f"expected exactly one undo payload, got {sink!r}"
    payload = sink[0]
    assert isinstance(payload, dict)
    json.dumps(payload)  # JSON-serialisable, or this raises
    return payload


# -- the registry pin -------------------------------------------------------------


def test_the_revertible_set_is_derived_from_the_live_registry():
    revertible = {name for name, tool in tools.REGISTRY.items() if tool.revert is not None}
    assert revertible == REVERTIBLE
    # ...and no reads_only tool is in it: a read has nothing to put back.
    assert not {name for name in revertible if tools.REGISTRY[name].reads_only}
    for name, tool in tools.REGISTRY.items():
        if tool.reads_only:
            assert tool.revert is None, name


# -- memory_save ------------------------------------------------------------------

PERSON = Person(id=uuid.uuid4(), name="jeremy", role="owner")


@pytest.fixture
def memory_ctx(monkeypatch, tmp_path):
    def _mount(memory: FakeMemory, sink: list | None = None) -> ToolContext:
        monkeypatch.setenv("MEMORY_URL", fakes.MEMORY_URL)
        monkeypatch.setenv("CORE_MEMORY_TOKEN", fakes.MEMORY_TOKEN)
        app.state.peer_transports = {fakes.MEMORY_URL: fakes.StreamingASGITransport(memory.app)}
        return ToolContext(app=app, person=PERSON, workspace_root=tmp_path, undo_sink=sink)

    yield _mount
    app.state.peer_transports = {}


async def _save(ctx):
    return await tools.dispatch("memory_save", {"title": "Coffee order", "content": "flat"}, ctx)


async def test_memory_save_appends_the_confirmed_path(memory_ctx):
    sink: list = []
    result, ok = await _save(memory_ctx(FakeMemory(), sink))
    assert ok, result
    assert _one(sink) == {"path": "people/x/topics/coffee-order.md"}


async def test_a_refused_memory_save_appends_nothing(memory_ctx):
    sink: list = []
    await _save(memory_ctx(FakeMemory(), sink))
    _one(sink)  # a save that lands appends one...
    result, ok = await _save(memory_ctx(FakeMemory(save_status=500), sink))
    assert ok is False
    assert len(sink) == 1  # ...and a refused one appends nothing more


async def test_memory_save_with_no_sink_behaves_as_before(memory_ctx):
    result, ok = await _save(memory_ctx(FakeMemory(), None))
    assert ok, result
    sink: list = []
    again, ok_again = await _save(memory_ctx(FakeMemory(), sink))
    assert ok_again and again == result  # the sink changes nothing she reads
    _one(sink)


async def test_reverting_a_memory_save_forgets_that_path_and_says_so(memory_ctx):
    memory = FakeMemory()
    sink: list = []
    ctx = memory_ctx(memory, sink)
    await _save(ctx)
    payload = _one(sink)
    memory.journal_paths.add(payload["path"])  # the fake forgets only what it holds

    line = await _revert("memory_save")(payload, ctx)

    assert payload["path"] in line
    assert memory.forget_results[-1]["path"] == payload["path"]
    assert memory.forget_results[-1]["status"] == 200
    assert memory.forget_results[-1]["person_id"] == str(PERSON.id)


async def test_reverting_a_memory_save_whose_note_is_gone_is_refused(memory_ctx):
    memory = FakeMemory(forget_status=404)
    ctx = memory_ctx(memory)
    with pytest.raises(ToolFailure, match="gone"):
        await _revert("memory_save")({"path": "people/x/topics/coffee-order.md"}, ctx)


async def test_a_forget_memory_did_not_confirm_is_not_a_revert(memory_ctx):
    memory = FakeMemory(forget_status=200, forget_body={"path": "people/x/topics/a.md"})
    ctx = memory_ctx(memory)
    with pytest.raises(ToolFailure, match="verif|confirm"):
        await _revert("memory_save")({"path": "people/x/topics/a.md"}, ctx)


# -- create_timer -----------------------------------------------------------------


async def _person(pool, name: str = "jeremy") -> Person:
    pid = await pool.fetchval(
        "INSERT INTO people (name, role) VALUES ($1, 'owner') RETURNING id", name
    )
    await pool.execute("INSERT INTO conversations (person_id) VALUES ($1)", pid)
    return Person(id=pid, name=name, role="owner")


def _tctx(person: Person, tmp_path, sink: list | None = None) -> ToolContext:
    return ToolContext(app=app, person=person, workspace_root=tmp_path, undo_sink=sink)


@requires_db
async def test_create_timer_appends_the_timer_id(pool, tmp_path):
    person = await _person(pool)
    sink: list = []
    result, ok = await tools.dispatch(
        "create_timer", {"text": "stretch", "in_minutes": 5}, _tctx(person, tmp_path, sink)
    )
    assert ok, result
    row_id = await pool.fetchval("SELECT id FROM timers WHERE person_id = $1", person.id)
    assert _one(sink) == {"timer_id": str(row_id)}


@requires_db
async def test_a_refused_create_timer_appends_nothing(pool, tmp_path):
    person = await _person(pool)
    sink: list = []
    ctx = _tctx(person, tmp_path, sink)
    await tools.dispatch("create_timer", {"text": "stretch", "in_minutes": 5}, ctx)
    _one(sink)
    result, ok = await tools.dispatch("create_timer", {"text": "stretch", "at": "not a time"}, ctx)
    assert ok is False, result
    assert len(sink) == 1


@requires_db
async def test_create_timer_with_no_sink_behaves_as_before(pool, tmp_path):
    person = await _person(pool)
    result, ok = await tools.dispatch(
        "create_timer", {"text": "stretch", "in_minutes": 5}, _tctx(person, tmp_path)
    )
    assert ok, result
    assert result.startswith("Reminder set (id ")
    sink: list = []
    again, ok_again = await tools.dispatch(
        "create_timer", {"text": "stretch", "in_minutes": 5}, _tctx(person, tmp_path, sink)
    )
    assert ok_again and again.startswith("Reminder set (id ")
    _one(sink)


@requires_db
async def test_reverting_a_create_timer_removes_the_row(pool, tmp_path):
    person = await _person(pool)
    sink: list = []
    ctx = _tctx(person, tmp_path, sink)
    await tools.dispatch("create_timer", {"text": "stretch", "in_minutes": 5}, ctx)
    payload = _one(sink)

    line = await _revert("create_timer")(payload, ctx)

    assert await timers.get(pool, uuid.UUID(payload["timer_id"])) is None
    assert "stretch" in line or payload["timer_id"][:8] in line


@requires_db
async def test_reverting_a_timer_already_gone_is_refused(pool, tmp_path):
    person = await _person(pool)
    sink: list = []
    ctx = _tctx(person, tmp_path, sink)
    await tools.dispatch("create_timer", {"text": "stretch", "in_minutes": 5}, ctx)
    payload = _one(sink)
    await timers.delete(pool, uuid.UUID(payload["timer_id"]))

    with pytest.raises(ToolFailure, match="gone"):
        await _revert("create_timer")(payload, ctx)


@requires_db
async def test_a_timer_revert_that_does_not_read_back_fails(pool, tmp_path, monkeypatch):
    person = await _person(pool)
    sink: list = []
    ctx = _tctx(person, tmp_path, sink)
    await tools.dispatch("create_timer", {"text": "stretch", "in_minutes": 5}, ctx)
    payload = _one(sink)

    async def no_delete(pool, timer_id):
        return None

    monkeypatch.setattr(timers, "delete", no_delete)
    with pytest.raises(ToolFailure, match="verif"):
        await _revert("create_timer")(payload, ctx)
    assert await timers.get(pool, uuid.UUID(payload["timer_id"])) is not None


# -- create_agent / update_agent --------------------------------------------------


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


@pytest.fixture
def ws(monkeypatch, tmp_path):
    root = tmp_path / "ws"
    monkeypatch.setenv("WORKSPACE_ROOT", str(root))
    return root


def _actx(person: Person, sink: list | None = None) -> ToolContext:
    ctx = tools.context_for(app, person, facts_sink=[])
    return dataclasses.replace(ctx, undo_sink=sink)


async def _create_agent(ctx, name: str = "coder"):
    return await tools.dispatch(
        "create_agent",
        {
            "name": name,
            "purpose": "writes code",
            "instructions": "Write small, tested changes.",
            "tools": ["workspace_read_file"],
        },
        ctx,
    )


def _agent_gateway(mount_peers):
    mount_peers(
        gateway=FakeGateway(
            admin_body={"role": "agent_coder", "chain": []}, explain_body=_explain()
        )
    )


@requires_db
async def test_create_agent_appends_its_name_and_id(pool, mount_peers, ws):
    _agent_gateway(mount_peers)
    owner = await _person(pool)
    sink: list = []
    result, ok = await _create_agent(_actx(owner, sink))
    assert ok, result
    row = await agents.by_name(pool, "coder")
    assert _one(sink) == {"name": "coder", "agent_id": str(row.id)}


@requires_db
async def test_a_refused_create_agent_appends_nothing(pool, mount_peers, ws):
    _agent_gateway(mount_peers)
    owner = await _person(pool)
    sink: list = []
    await _create_agent(_actx(owner, sink))
    _one(sink)
    result, ok = await _create_agent(_actx(owner, sink), name="nova")
    assert ok is False, result
    assert len(sink) == 1


@requires_db
async def test_create_agent_with_no_sink_behaves_as_before(pool, mount_peers, ws):
    _agent_gateway(mount_peers)
    owner = await _person(pool)
    result, ok = await _create_agent(_actx(owner, None))
    assert ok, result
    assert result.startswith("created agent coder")
    sink: list = []
    _agent_gateway(mount_peers)
    again, ok_again = await _create_agent(_actx(owner, sink), name="scout")
    assert ok_again and again.startswith("created agent scout")
    _one(sink)


@requires_db
async def test_reverting_a_create_agent_deletes_it_and_says_the_folder_was_kept(
    pool, mount_peers, ws
):
    _agent_gateway(mount_peers)
    owner = await _person(pool)
    sink: list = []
    ctx = _actx(owner, sink)
    await _create_agent(ctx)
    payload = _one(sink)

    line = await _revert("create_agent")(payload, ctx)

    assert await agents.by_name(pool, "coder") is None
    assert "coder" in line and "folder" in line
    assert (ws / "agents" / "coder").is_dir()


@requires_db
async def test_reverting_a_create_agent_already_gone_is_refused(pool, mount_peers, ws):
    _agent_gateway(mount_peers)
    owner = await _person(pool)
    sink: list = []
    ctx = _actx(owner, sink)
    await _create_agent(ctx)
    payload = _one(sink)
    await agents.delete(pool, app, "coder", actor="jeremy")

    with pytest.raises(ToolFailure, match="gone"):
        await _revert("create_agent")(payload, ctx)


@requires_db
async def test_reverting_a_create_agent_updated_since_is_refused(pool, mount_peers, ws):
    _agent_gateway(mount_peers)
    owner = await _person(pool)
    sink: list = []
    ctx = _actx(owner, sink)
    await _create_agent(ctx)
    payload = _one(sink)
    result, ok = await tools.dispatch(
        "update_agent", {"name": "coder", "purpose": "reviews code"}, _actx(owner)
    )
    assert ok, result

    with pytest.raises(ToolFailure, match="changed"):
        await _revert("create_agent")(payload, ctx)
    assert await agents.by_name(pool, "coder") is not None


@requires_db
async def test_a_create_agent_revert_that_does_not_read_back_fails(
    pool, mount_peers, ws, monkeypatch
):
    _agent_gateway(mount_peers)
    owner = await _person(pool)
    sink: list = []
    ctx = _actx(owner, sink)
    await _create_agent(ctx)
    payload = _one(sink)

    async def no_delete(pool, app, name, *, actor):
        return types.SimpleNamespace(
            name=name, paused_timers=[], route=None, remains="", text=f"deleted agent {name}"
        )

    monkeypatch.setattr(agents, "delete", no_delete)
    with pytest.raises(ToolFailure, match="verif"):
        await _revert("create_agent")(payload, ctx)


async def _created(pool, mount_peers, owner):
    _agent_gateway(mount_peers)
    result, ok = await _create_agent(_actx(owner))
    assert ok, result


@requires_db
async def test_update_agent_appends_the_changed_fields_before_and_after(pool, mount_peers, ws):
    owner = await _person(pool)
    await _created(pool, mount_peers, owner)
    sink: list = []
    result, ok = await tools.dispatch(
        "update_agent",
        {"name": "coder", "purpose": "reviews code", "instructions": "Review carefully."},
        _actx(owner, sink),
    )
    assert ok, result
    payload = _one(sink)
    assert payload["name"] == "coder"
    # PIN MOVED (no-ceiling T6): the second field was max_tool_rounds (4); an agent
    # has no rounds, so the pin uses another column field.
    assert set(payload["prior"]) == {"purpose", "instructions"}
    assert set(payload["landed"]) == {"purpose", "instructions"}
    assert payload["prior"]["purpose"] == "writes code"
    assert payload["landed"]["purpose"] == "reviews code"
    assert payload["landed"]["instructions"] == "Review carefully."


@requires_db
async def test_update_agent_with_a_cap_is_still_json(pool, mount_peers, ws):
    owner = await _person(pool)
    await _created(pool, mount_peers, owner)
    sink: list = []
    result, ok = await tools.dispatch(
        "update_agent", {"name": "coder", "monthly_cap_usd": 5}, _actx(owner, sink)
    )
    assert ok, result
    payload = _one(sink)
    assert payload["prior"] == {"monthly_cap_usd": None}


@requires_db
async def test_a_refused_update_agent_appends_nothing(pool, mount_peers, ws):
    owner = await _person(pool)
    await _created(pool, mount_peers, owner)
    sink: list = []
    await tools.dispatch("update_agent", {"name": "coder", "purpose": "y"}, _actx(owner, sink))
    _one(sink)
    result, ok = await tools.dispatch(
        "update_agent", {"name": "nobody", "purpose": "x"}, _actx(owner, sink)
    )
    assert ok is False, result
    assert len(sink) == 1


@requires_db
async def test_update_agent_with_no_sink_behaves_as_before(pool, mount_peers, ws):
    owner = await _person(pool)
    await _created(pool, mount_peers, owner)
    result, ok = await tools.dispatch(
        "update_agent", {"name": "coder", "purpose": "reviews code"}, _actx(owner)
    )
    assert ok, result
    assert result.startswith("updated agent coder — purpose: reviews code;")
    sink: list = []
    again, ok_again = await tools.dispatch(
        "update_agent", {"name": "coder", "purpose": "plans work"}, _actx(owner, sink)
    )
    assert ok_again and again.startswith("updated agent coder — purpose: plans work;")
    _one(sink)


@requires_db
async def test_reverting_an_update_agent_restores_the_prior_fields(pool, mount_peers, ws):
    owner = await _person(pool)
    await _created(pool, mount_peers, owner)
    sink: list = []
    ctx = _actx(owner, sink)
    await tools.dispatch(
        "update_agent", {"name": "coder", "purpose": "reviews code", "monthly_cap_usd": 5}, ctx
    )
    payload = _one(sink)

    line = await _revert("update_agent")(payload, ctx)

    fresh = await agents.by_name(pool, "coder")
    assert fresh.purpose == "writes code"
    assert fresh.monthly_cap_usd is None
    assert "coder" in line


@requires_db
async def test_reverting_an_update_agent_changed_since_is_refused(pool, mount_peers, ws):
    owner = await _person(pool)
    await _created(pool, mount_peers, owner)
    sink: list = []
    ctx = _actx(owner, sink)
    await tools.dispatch("update_agent", {"name": "coder", "purpose": "reviews code"}, ctx)
    payload = _one(sink)
    await tools.dispatch("update_agent", {"name": "coder", "purpose": "plans work"}, _actx(owner))

    with pytest.raises(ToolFailure, match="changed"):
        await _revert("update_agent")(payload, ctx)
    assert (await agents.by_name(pool, "coder")).purpose == "plans work"


@requires_db
async def test_reverting_a_recorded_update_naming_rounds_is_refused_in_words(pool, mount_peers, ws):
    """no-ceiling T6: an undo payload recorded before per-agent rounds went
    names max_tool_rounds. It cannot be put back (the field is gone), so the
    revert refuses in words and writes nothing — never a silent partial."""
    owner = await _person(pool)
    await _created(pool, mount_peers, owner)
    sink: list = []
    ctx = _actx(owner, sink)
    await tools.dispatch("update_agent", {"name": "coder", "purpose": "reviews code"}, ctx)
    before = await agents.by_name(pool, "coder")
    stale = {
        "name": "coder",
        "prior": {"purpose": "writes code", "max_tool_rounds": 8},
        "landed": {"purpose": "reviews code", "max_tool_rounds": 4},
    }

    with pytest.raises(
        ToolFailure,
        match=r"the recorded agent update names fields it cannot put back: \['max_tool_rounds'\]",
    ):
        await _revert("update_agent")(stale, ctx)
    assert await agents.by_name(pool, "coder") == before


@requires_db
async def test_reverting_an_update_agent_whose_agent_is_gone_is_refused(pool, mount_peers, ws):
    owner = await _person(pool)
    await _created(pool, mount_peers, owner)
    sink: list = []
    ctx = _actx(owner, sink)
    await tools.dispatch("update_agent", {"name": "coder", "purpose": "reviews code"}, ctx)
    payload = _one(sink)
    await agents.delete(pool, app, "coder", actor="jeremy")

    with pytest.raises(ToolFailure, match="gone"):
        await _revert("update_agent")(payload, ctx)


@requires_db
async def test_an_update_agent_revert_that_does_not_read_back_fails(
    pool, mount_peers, ws, monkeypatch
):
    owner = await _person(pool)
    await _created(pool, mount_peers, owner)
    sink: list = []
    ctx = _actx(owner, sink)
    await tools.dispatch("update_agent", {"name": "coder", "purpose": "reviews code"}, ctx)
    payload = _one(sink)

    async def no_update(pool, app, name, changes, *, actor):
        current = await agents.by_name(pool, name)
        return types.SimpleNamespace(
            agent=current, folder=None, route=None, text=f"updated agent {name}"
        )

    monkeypatch.setattr(agents, "update", no_update)
    with pytest.raises(ToolFailure, match="verif"):
        await _revert("update_agent")(payload, ctx)


@requires_db
async def test_reverting_a_create_agent_whose_name_was_reused_is_refused(pool, mount_peers, ws):
    # The payload names the row by id: a later agent that reused the name is
    # not this call's to delete, so the revert reads it as already gone.
    _agent_gateway(mount_peers)
    owner = await _person(pool)
    sink: list = []
    ctx = _actx(owner, sink)
    await _create_agent(ctx)
    payload = _one(sink)
    await agents.delete(pool, app, "coder", actor="jeremy")
    _agent_gateway(mount_peers)
    result, ok = await _create_agent(_actx(owner))
    assert ok, result
    reused = await agents.by_name(pool, "coder")
    assert str(reused.id) != payload["agent_id"]

    with pytest.raises(ToolFailure, match="gone"):
        await _revert("create_agent")(payload, ctx)
    assert (await agents.by_name(pool, "coder")).id == reused.id


@requires_db
async def test_an_update_agent_carrying_a_model_chain_records_no_undo(pool, mount_peers, ws):
    # The chain is the gateway route, not a column: its prior is unread, so the
    # call records NO payload and a rewind lists it not undone rather than
    # restoring the columns and claiming the call put back.
    owner = await _person(pool)
    await _created(pool, mount_peers, owner)
    mount_peers(
        gateway=FakeGateway(
            admin_body={"role": "agent_coder", "chain": ["ollama:qwen3:8b"]},
            explain_body=_explain(),
        )
    )
    sink: list = []
    result, ok = await tools.dispatch(
        "update_agent",
        {"name": "coder", "purpose": "reviews code", "model_chain": ["ollama:qwen3:8b"]},
        _actx(owner, sink),
    )
    assert ok, result
    assert (await agents.by_name(pool, "coder")).purpose == "reviews code"
    assert sink == []


# -- set_chat_model ---------------------------------------------------------------


async def _chat_model_is(pool, value: str) -> None:
    await pool.execute(
        "INSERT INTO settings (key, value) VALUES ('chat.model', to_jsonb($1::text)) "
        "ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value",
        value,
    )


def _pctx(tmp_path, sink: list | None = None) -> ToolContext:
    return ToolContext(app=app, person=None, workspace_root=tmp_path, undo_sink=sink)


async def _picked(pool, mount_peers, tmp_path, sink):
    from tests.test_proxies import RoutesGateway

    gateway = RoutesGateway([GLM])
    mount_peers(gateway=gateway)
    await _chat_model_is(pool, GEMINI)
    result, ok = await tools.dispatch("set_chat_model", {"model": DELL}, _pctx(tmp_path, sink))
    assert ok, result
    return gateway


@requires_db
async def test_set_chat_model_appends_the_prior_pair_and_the_landed_model(
    pool, mount_peers, tmp_path
):
    sink: list = []
    gateway = await _picked(pool, mount_peers, tmp_path, sink)
    assert gateway.chain == [GEMINI, GLM]
    assert _one(sink) == {"prior_model": GEMINI, "prior_chain": [GLM], "landed_model": DELL}


@requires_db
async def test_a_refused_set_chat_model_appends_nothing(pool, mount_peers, tmp_path):
    sink: list = []
    gateway = await _picked(pool, mount_peers, tmp_path, sink)
    _one(sink)
    gateway.router_when_stated = {"on": True, "kept": GLM}
    result, ok = await tools.dispatch("set_chat_model", {"model": GLM}, _pctx(tmp_path, sink))
    assert ok is False, result
    assert len(sink) == 1


@requires_db
async def test_set_chat_model_with_no_sink_behaves_as_before(pool, mount_peers, tmp_path):
    from tests.test_proxies import RoutesGateway

    mount_peers(gateway=RoutesGateway([GLM]))
    await _chat_model_is(pool, GEMINI)
    result, ok = await tools.dispatch("set_chat_model", {"model": DELL}, _pctx(tmp_path))
    assert ok, result
    assert result.startswith(f"Answer: chat now answers with {DELL} first")
    sink: list = []
    again, ok_again = await tools.dispatch("set_chat_model", {"model": GLM}, _pctx(tmp_path, sink))
    assert ok_again and again.startswith(f"Answer: chat now answers with {GLM} first")
    assert _one(sink)["prior_model"] == DELL


@requires_db
async def test_reverting_set_chat_model_restores_the_model_and_the_chain(
    pool, mount_peers, tmp_path
):
    sink: list = []
    gateway = await _picked(pool, mount_peers, tmp_path, sink)
    payload = _one(sink)

    line = await _revert("set_chat_model")(payload, _pctx(tmp_path))

    assert await settings_store.read_value(pool, "chat.model") == GEMINI
    assert gateway.chain == [GLM]
    assert GEMINI in line


@requires_db
async def test_reverting_set_chat_model_changed_since_is_refused(pool, mount_peers, tmp_path):
    sink: list = []
    gateway = await _picked(pool, mount_peers, tmp_path, sink)
    payload = _one(sink)
    await _chat_model_is(pool, "hub:qwen3:8b")

    with pytest.raises(ToolFailure, match="changed"):
        await _revert("set_chat_model")(payload, _pctx(tmp_path))
    assert await settings_store.read_value(pool, "chat.model") == "hub:qwen3:8b"
    assert gateway.chain == [GEMINI, GLM]


@requires_db
async def test_reverting_set_chat_model_while_jev_router_holds_chat_is_refused(
    pool, mount_peers, tmp_path
):
    sink: list = []
    gateway = await _picked(pool, mount_peers, tmp_path, sink)
    payload = _one(sink)
    gateway.router_when_stated = {"on": True, "kept": GLM}

    with pytest.raises(ToolFailure, match="Jev Router"):
        await _revert("set_chat_model")(payload, _pctx(tmp_path))
    assert await settings_store.read_value(pool, "chat.model") == DELL


@requires_db
async def test_a_set_chat_model_revert_that_does_not_read_back_fails(
    pool, mount_peers, tmp_path, monkeypatch
):
    sink: list = []
    await _picked(pool, mount_peers, tmp_path, sink)
    payload = _one(sink)

    async def no_write(*args, **kwargs):
        return None

    monkeypatch.setattr(settings_store, "write_setting", no_write)
    with pytest.raises(ToolFailure, match="verif"):
        await _revert("set_chat_model")(payload, _pctx(tmp_path))


@requires_db
async def test_a_set_chat_model_revert_whose_chain_does_not_read_back_fails(
    pool, mount_peers, tmp_path
):
    from tests.test_proxies import RoutesGateway

    class EchoesTheOldChain(RoutesGateway):
        # Answers the PUT 200 with the chain it already held: the write did
        # not land, and only the read-back of the answer can tell.
        async def _put(self, request):
            await request.json()
            return JSONResponse({"role": "chat", "chain": self.chain})

    sink: list = []
    await _picked(pool, mount_peers, tmp_path, sink)
    payload = _one(sink)
    stuck = EchoesTheOldChain([GEMINI, GLM])
    mount_peers(gateway=stuck)

    with pytest.raises(ToolFailure, match="verif"):
        await _revert("set_chat_model")(payload, _pctx(tmp_path))


# -- end to end through the ledger ------------------------------------------------


def _tool_call(call_id: str, name: str, arguments: dict) -> dict:
    return {
        "choices": [
            {
                "delta": {
                    "tool_calls": [
                        {
                            "index": 0,
                            "id": call_id,
                            "type": "function",
                            "function": {"name": name, "arguments": json.dumps(arguments)},
                        }
                    ]
                }
            }
        ]
    }


@requires_db
async def test_a_chat_create_timer_lands_a_ledger_row_whose_undo_reverts_it(
    owner_client, pool, mount_peers, tmp_path
):
    gateway = ScriptedGateway(
        rounds=(
            (_tool_call("c1", "create_timer", {"text": "stretch", "in_minutes": 5}),),
            ({"choices": [{"delta": {"content": "done"}}]},),
        )
    )
    mount_peers(gateway=gateway, memory=FakeMemory())
    resp = await owner_client.post("/api/v1/chat/stream", json={"message": "remind me"})
    assert resp.status_code == 200, resp.text
    timer_id = await pool.fetchval("SELECT id FROM timers")
    assert timer_id is not None

    rows = await pool.fetch("SELECT tool, ok, undo FROM turn_actions ORDER BY seq")
    assert len(rows) == 1
    assert rows[0]["tool"] == "create_timer" and rows[0]["ok"] is True
    undo = rows[0]["undo"]
    undo = json.loads(undo) if isinstance(undo, str) else undo
    assert undo == {"timer_id": str(timer_id)}

    owner = await pool.fetchrow("SELECT id, name, role FROM people LIMIT 1")
    person = Person(id=owner["id"], name=owner["name"], role=owner["role"])
    await _revert("create_timer")(undo, _tctx(person, tmp_path))
    assert await timers.get(pool, timer_id) is None
