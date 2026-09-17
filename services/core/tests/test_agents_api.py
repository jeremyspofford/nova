"""/api/v1/agents — the Agents page's surface (app/agents_api.py).

What these pin, and why each is a pin and not a wish:
  * every route needs an identity, like every other API here;
  * a create/update/delete is ONE store call whose sentence, route outcome
    and refusal reach the page verbatim (the same words Nova's tools get);
  * an unknown name is a 404 in words; a bad spec is a 400 QUOTING the
    store's reason — never a bare status the page has to guess at;
  * deleting an agent pauses the timers bound to it and NAMES them;
  * the log route is the log conversation's rows, [] when there is none;
  * /tools is the live registry and /skills the live directory;
  * `state` is DERIVED from traces.DOING plus an open turns row — a closed
    row, or an open row no process is running, is idle — and the table
    holds no flag that could say otherwise;
  * `spent_month_usd` comes from ONE ledger read shared by every row, and
    an unreadable ledger is null WITH the reason, never 0.
"""

from __future__ import annotations

import uuid
from pathlib import Path

import pytest

from app import agents, timers, tools, traces
from app.agents_api import IDLE
from app.identity import Person
from app.tools.base import RESULT_KIND_LISTING
from tests.conftest import requires_db
from tests.fakes import FakeGateway

pytestmark = requires_db

NY = "America/New_York"
SPEC_TOOLS = ["get_time", "workspace_read_file", "workspace_write_file"]
AGENT_KEYS = {
    "id",
    "name",
    "purpose",
    "instructions",
    "tools",
    "skills",
    "unknown_tools",
    "monthly_cap_usd",
    "max_tool_rounds",
    "read_shared_memory",
    "role",
    "folder",
    "log_conversation_id",
    "created_via",
    "created_at",
    "updated_at",
    "bound_timers",
    "spent_month_usd",
    "spend_note",
    "last_active",
    "state",
}
# The transcript route's row keys (conversations.get_messages); the log
# route renders rows the same way, so at least these are on every row.
MESSAGE_KEYS = {"id", "role", "content", "created_at", "served_by", "turn_kind"}


@pytest.fixture
def root(monkeypatch, tmp_path) -> Path:
    root = tmp_path / "ws"
    monkeypatch.setenv("WORKSPACE_ROOT", str(root))
    return root


@pytest.fixture(autouse=True)
def _clean_doing():
    # DOING is process-global by design (one household, one process); a
    # test that sets it must not leave the next test's agent "working".
    traces.DOING.clear()
    yield
    traces.DOING.clear()


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


def _spend(*rows: dict) -> dict:
    return {"window": "month", "timezone": "UTC", "totals": {"usd": 0}, "by_role": list(rows)}


def _gateway(**over) -> FakeGateway:
    """A gateway that echoes a route PUT the way the real one does ({role,
    chain}), explains the role as served by the local model, and serves an
    empty month on the ledger."""
    fields = dict(
        admin_body={"role": "agent_coder", "chain": []},
        explain_body=_explain(),
        spend_body=_spend(),
    )
    fields.update(over)
    return FakeGateway(**fields)


def _body(**over) -> dict:
    fields = dict(
        name="coder",
        purpose="writes code",
        instructions="Write small, tested changes.",
        tools=SPEC_TOOLS,
    )
    fields.update(over)
    return fields


async def _owner(pool) -> Person:
    """The person owner_client registered."""
    row = await pool.fetchrow("SELECT id, name, role FROM people WHERE role = 'owner'")
    return Person(id=row["id"], name=row["name"], role=row["role"])


async def _create(client, **over) -> dict:
    resp = await client.post("/api/v1/agents", json=_body(**over))
    assert resp.status_code == 201, resp.text
    return resp.json()


async def _agent_turn(pool, agent: dict, *, status: str | None = None, offset_secs: int = 0):
    """An agent turn row, started `offset_secs` after now so order is explicit;
    open (status NULL) unless a status is given."""
    turn = await traces.open_turn(
        pool,
        kind="agent",
        conversation_id=uuid.UUID(agent["log_conversation_id"]),
        agent_id=uuid.UUID(agent["id"]),
        role=agent["role"],
    )
    await pool.execute(
        "UPDATE turns SET started_at = now() + make_interval(secs => $2), status = $3, "
        "ended_at = CASE WHEN $3::text IS NULL THEN NULL ELSE now() END WHERE id = $1",
        turn.id,
        offset_secs,
        status,
    )
    return turn


# ── auth ───────────────────────────────────────────────────────────────────


async def test_every_route_needs_an_identity(client):
    assert (await client.get("/api/v1/agents")).status_code == 401
    assert (await client.post("/api/v1/agents", json=_body())).status_code == 401
    assert (await client.get("/api/v1/agents/coder")).status_code == 401
    assert (await client.put("/api/v1/agents/coder", json={})).status_code == 401
    assert (await client.delete("/api/v1/agents/coder")).status_code == 401
    assert (await client.get("/api/v1/agents/coder/log")).status_code == 401
    assert (await client.get("/api/v1/tools")).status_code == 401
    assert (await client.get("/api/v1/skills")).status_code == 401


# ── the round trip ─────────────────────────────────────────────────────────


async def test_create_read_update_delete_round_trip(owner_client, pool, mount_peers, root):
    gateway = _gateway()
    mount_peers(gateway=gateway)

    created = await _create(owner_client, monthly_cap_usd=20)

    assert set(created) == AGENT_KEYS | {"text", "route"}
    assert created["name"] == "coder" and created["role"] == "agent_coder"
    assert created["folder"] == "agents/coder/" and (root / "agents" / "coder").is_dir()
    assert created["tools"] == SPEC_TOOLS and created["unknown_tools"] == []
    assert created["skills"] == []
    assert created["monthly_cap_usd"] == 20.0
    assert created["max_tool_rounds"] == 6  # the agents.max_tool_rounds default, COPIED
    assert created["read_shared_memory"] is False
    assert created["created_via"] == "page"
    assert created["log_conversation_id"] is not None
    assert created["bound_timers"] == []
    assert created["spent_month_usd"] == 0.0 and created["spend_note"] is None
    assert created["last_active"] is None
    assert created["state"] == IDLE
    # The gateway was told the role and its chain, and the outcome is its answer.
    assert ("/admin/routes/agent_coder", {"chain": []}) in gateway.seen
    assert created["route"] == {
        "registered": True,
        "detail": (
            "route agent_coder registered, chain [] — would be served by ollama:qwen3:8b "
            "(the chat chain)"
        ),
    }
    # The sentence is the store's, composed from what it read back.
    assert created["text"].startswith("created agent coder — purpose: writes code; ")
    assert "folder agents/coder/ exists" in created["text"]
    assert created["route"]["detail"] in created["text"]
    assert "cap $20.00/month" in created["text"]
    # The ledger names the caller (owner_client's registered owner).
    event = await pool.fetchrow(
        "SELECT actor, subject_ref FROM governance_events WHERE kind = 'agent.created'"
    )
    assert event["actor"] == "jeremy" and str(event["subject_ref"]) == created["id"]

    row = {k: v for k, v in created.items() if k not in ("text", "route")}
    listed = await owner_client.get("/api/v1/agents")
    assert listed.status_code == 200 and listed.json() == [row]
    one = await owner_client.get("/api/v1/agents/coder")
    assert one.status_code == 200 and one.json() == row

    updated = await owner_client.put(
        "/api/v1/agents/coder", json={"purpose": "reviews code", "max_tool_rounds": 3}
    )
    assert updated.status_code == 200, updated.text
    body = updated.json()
    assert set(body) == AGENT_KEYS | {"text", "route"}
    assert body["purpose"] == "reviews code" and body["max_tool_rounds"] == 3
    assert body["updated_at"] >= body["created_at"]
    assert body["text"].startswith("updated agent coder — purpose: reviews code; ")
    # No chain in the change: the route is left alone and said to be.
    assert body["route"]["registered"] is False
    assert body["route"]["detail"].startswith("route agent_coder unchanged — ")
    assert len([p for p, _ in gateway.seen if p == "/admin/routes/agent_coder"]) == 1

    chained = await owner_client.put(
        "/api/v1/agents/coder", json={"model_chain": ["ollama:qwen3:8b"]}
    )
    assert chained.status_code == 200, chained.text
    assert chained.json()["route"]["registered"] is True
    assert ("/admin/routes/agent_coder", {"chain": ["ollama:qwen3:8b"]}) in gateway.seen

    deleted = await owner_client.delete("/api/v1/agents/coder")
    assert deleted.status_code == 200, deleted.text
    assert deleted.json() == {
        "deleted": "coder",
        "paused_timers": [],
        "route": {"registered": True, "detail": "route agent_coder removed"},
        "remains": (
            "its folder agents/coder/, its memory notes and its log conversation were left in place"
        ),
        "text": deleted.json()["text"],
    }
    assert deleted.json()["text"].startswith("deleted agent coder — no timers were bound to it")
    assert (await owner_client.get("/api/v1/agents")).json() == []
    assert (await owner_client.get("/api/v1/agents/coder")).status_code == 404
    assert await agents.by_name(pool, "coder") is None


async def test_the_roster_is_ordered_by_name(owner_client, mount_peers, root):
    mount_peers(gateway=_gateway())
    for name in ("writer", "coder", "reviewer"):
        await _create(owner_client, name=name)
    listed = await owner_client.get("/api/v1/agents")
    assert [a["name"] for a in listed.json()] == ["coder", "reviewer", "writer"]


# ── refusals ───────────────────────────────────────────────────────────────


async def test_an_unknown_name_is_a_404_in_words(owner_client, mount_peers, root):
    mount_peers(gateway=_gateway())
    for call in (
        owner_client.get("/api/v1/agents/ghost"),
        owner_client.put("/api/v1/agents/ghost", json={"purpose": "haunts"}),
        owner_client.delete("/api/v1/agents/ghost"),
        owner_client.get("/api/v1/agents/ghost/log"),
    ):
        resp = await call
        assert resp.status_code == 404, resp.text
        assert resp.json() == {"error": "no agent named ghost"}


async def test_a_bad_spec_is_a_400_quoting_the_reason(owner_client, mount_peers, root):
    mount_peers(gateway=_gateway())

    async def refused(body: dict) -> str:
        resp = await owner_client.post("/api/v1/agents", json=body)
        assert resp.status_code == 400, resp.text
        assert set(resp.json()) == {"error"}
        return resp.json()["error"]

    # The store's own words, verbatim.
    assert (await refused(_body(tools=["nope"]))).startswith(
        "no tool named 'nope' — the tools that exist: "
    )
    assert "must match ^[a-z][a-z_]{0,25}$" in await refused(_body(name="Bad Name"))
    assert "'nova' is reserved" in await refused(_body(name="nova"))
    assert (await refused(_body(tools=["delegate_to_agent"]))).startswith(
        "delegate_to_agent cannot be in an agent's tools"
    )
    assert "no skill named 'missing'" in await refused(_body(skills=["missing"]))
    assert "max_tool_rounds must be between 1 and 50" in await refused(_body(max_tool_rounds=99))
    assert "monthly_cap_usd must be 0 or more" in await refused(_body(monthly_cap_usd=-1))
    # The shapes the router itself refuses, each naming what was wrong.
    assert await refused({"name": "coder", "tools": SPEC_TOOLS}) == (
        "an agent needs purpose, instructions — none was sent"
    )
    assert (await refused(_body(colour="blue"))).startswith("an agent has no field(s) colour — ")
    assert await refused(_body(read_shared_memory="yes")) == (
        "read_shared_memory must be true or false"
    )
    assert await refused(_body(tools="get_time")) == "tools must be a list of names"
    assert await refused(_body(tools={"get_time": True})) == "tools must be a list of names"

    await _create(owner_client)
    assert "an agent named coder already exists" in await refused(_body())

    async def refused_put(body: dict) -> str:
        resp = await owner_client.put("/api/v1/agents/coder", json=body)
        assert resp.status_code == 400, resp.text
        return resp.json()["error"]

    assert (await refused_put({"name": "hacker"})).startswith("an agent cannot be renamed — ")
    assert (await refused_put({"colour": "blue"})).startswith("an agent has no field(s) colour")
    assert (
        await refused_put({"read_shared_memory": 1}) == "read_shared_memory must be true or false"
    )
    assert (await refused_put({"tools": ["nope"]})).startswith("no tool named 'nope'")
    # The row is untouched by a refused update.
    assert (await owner_client.get("/api/v1/agents/coder")).json()["tools"] == SPEC_TOOLS


async def test_a_refused_create_leaves_no_row_behind(owner_client, pool, mount_peers, root):
    mount_peers(gateway=_gateway())
    resp = await owner_client.post("/api/v1/agents", json=_body(tools=["nope"]))
    assert resp.status_code == 400
    assert await agents.list_all(pool) == []
    assert await pool.fetchval("SELECT count(*) FROM conversations") == 0
    assert not (root / "agents").exists()


# ── delete and the timers bound to it ──────────────────────────────────────


async def test_delete_pauses_a_bound_timer_and_names_it(owner_client, pool, mount_peers, root):
    mount_peers(gateway=_gateway())
    created = await _create(owner_client)
    owner = await _owner(pool)
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
        tz=NY,
        conversation_id=conversation,
        created_via="chat",
    )
    await pool.execute("UPDATE timers SET agent_id = $1 WHERE id = $2", created["id"], timer["id"])

    shown = (await owner_client.get("/api/v1/agents/coder")).json()
    assert shown["bound_timers"] == [{"id": str(timer["id"]), "title": "nightly review"}]
    # The page's batched read and the store's single read agree.
    assert shown["bound_timers"] == await agents.bound_timers(pool, uuid.UUID(created["id"]))

    deleted = await owner_client.delete("/api/v1/agents/coder")
    assert deleted.status_code == 200, deleted.text
    body = deleted.json()
    assert body["deleted"] == "coder"
    assert body["paused_timers"] == [
        {"id": str(timer["id"]), "title": "nightly review", "already_paused": None}
    ]
    assert "paused 1 timer: nightly review" in body["text"]
    row = await pool.fetchrow(
        "SELECT paused_at, paused_reason, agent_id FROM timers WHERE id = $1", timer["id"]
    )
    assert row["paused_at"] is not None and row["agent_id"] is None
    assert row["paused_reason"] == "paused: agent coder was deleted"


# ── the log ────────────────────────────────────────────────────────────────


async def test_log_is_the_log_conversations_rows_and_empty_without_one(
    owner_client, pool, mount_peers, root
):
    mount_peers(gateway=_gateway())
    created = await _create(owner_client)
    log_id = uuid.UUID(created["log_conversation_id"])
    await pool.execute(
        "INSERT INTO messages (conversation_id, role, content, created_at) VALUES "
        "($1, 'user', 'Task: write hello.py', now() - interval '2 minutes'), "
        "($1, 'assistant', 'I wrote hello.py', now() - interval '1 minute')",
        log_id,
    )

    resp = await owner_client.get("/api/v1/agents/coder/log")
    assert resp.status_code == 200, resp.text
    rows = resp.json()
    assert [(r["role"], r["content"]) for r in rows] == [
        ("user", "Task: write hello.py"),
        ("assistant", "I wrote hello.py"),
    ]
    assert all(MESSAGE_KEYS <= set(r) for r in rows)

    # The column goes NULL when the conversation is deleted (ON DELETE SET
    # NULL); until a delegation recreates it there is nothing to show.
    await pool.execute("DELETE FROM conversations WHERE id = $1", log_id)
    assert (await agents.by_name(pool, "coder")).log_conversation_id is None
    resp = await owner_client.get("/api/v1/agents/coder/log")
    assert resp.status_code == 200 and resp.json() == []


# ── the lists the form is built from ───────────────────────────────────────


async def test_tools_is_the_live_registry(owner_client):
    resp = await owner_client.get("/api/v1/tools")
    assert resp.status_code == 200
    listed = resp.json()
    assert [t["name"] for t in listed] == tools.tool_names()
    for entry in listed:
        assert set(entry) == {"name", "description", "result_kind", "ephemeral"}
        tool = tools.REGISTRY[entry["name"]]
        assert entry["description"] == tool.description
        assert entry["result_kind"] == tool.result_kind
        assert entry["ephemeral"] is tool.ephemeral
    listing = {t["name"] for t in listed if t["result_kind"] == RESULT_KIND_LISTING}
    assert listing == set(tools.tool_names_by_result_kind(RESULT_KIND_LISTING))
    assert listing  # the registry has listing tools; an empty set would mean the field was lost


async def test_skills_is_the_directory_and_a_missing_file_is_flagged(
    owner_client, mount_peers, root
):
    mount_peers(gateway=_gateway())
    assert (await owner_client.get("/api/v1/skills")).json() == []

    skills = root / "skills"
    skills.mkdir(parents=True)
    (skills / "review.md").write_text("# Review\nRead the diff first.\n")
    (skills / "notes.txt").write_text("not a skill")
    (skills / "Bad Name.md").write_text("not a usable name")

    resp = await owner_client.get("/api/v1/skills")
    assert resp.status_code == 200
    (only,) = resp.json()
    assert only["name"] == "review"
    assert only["size"] == (skills / "review.md").stat().st_size
    assert only["modified"] == agents.list_skills()[0]["modified"]

    created = await _create(owner_client, skills=["review"])
    assert created["skills"] == [{"name": "review", "present": True}]
    assert "skills: review" in created["text"]
    (skills / "review.md").unlink()
    shown = (await owner_client.get("/api/v1/agents/coder")).json()
    assert shown["skills"] == [{"name": "review", "present": False}]  # flagged, never dropped


# ── state, derived ─────────────────────────────────────────────────────────


async def test_state_is_derived_from_doing_and_an_open_row(owner_client, pool, mount_peers, root):
    mount_peers(gateway=_gateway())
    created = await _create(owner_client)

    async def shown() -> dict:
        return (await owner_client.get("/api/v1/agents/coder")).json()

    # An open row alone is not "working": nothing in this process runs it.
    orphan = await _agent_turn(pool, created, offset_secs=0)
    row = await shown()
    assert row["state"] == IDLE
    assert (
        row["last_active"]
        == (
            await pool.fetchval("SELECT started_at FROM turns WHERE id = $1", orphan.id)
        ).isoformat()
    )

    # A closed row in DOING is not working either: status IS NULL is required.
    closed = await _agent_turn(pool, created, status="ok", offset_secs=5)
    traces.set_doing(closed.id, "thinking")
    assert (await shown())["state"] == IDLE
    traces.clear_doing(closed.id)

    # An open row this process IS running: working, on what, since when.
    live = await _agent_turn(pool, created, offset_secs=-10)  # older than the orphan
    traces.set_doing(live.id, "workspace_write_file")
    row = await shown()
    assert row["state"] == {
        "working": True,
        "doing": "workspace_write_file",
        "since": (
            await pool.fetchval("SELECT started_at FROM turns WHERE id = $1", live.id)
        ).isoformat(),
        "turn_id": str(live.id),
    }
    # last_active is the latest start regardless of which one is live.
    assert (
        row["last_active"]
        == (
            await pool.fetchval("SELECT started_at FROM turns WHERE id = $1", closed.id)
        ).isoformat()
    )
    traces.set_doing(live.id, "thinking")
    assert (await shown())["state"]["doing"] == "thinking"
    # The roster carries the same derivation.
    (listed,) = (await owner_client.get("/api/v1/agents")).json()
    assert listed["state"]["working"] is True and listed["state"]["turn_id"] == str(live.id)

    # Forgotten by the process: idle, however the row reads.
    traces.clear_doing(live.id)
    assert (await shown())["state"] == IDLE

    # And there is no column a dead process could leave saying otherwise.
    columns = {
        r["column_name"]
        for r in await pool.fetch(
            "SELECT column_name FROM information_schema.columns WHERE table_name = 'agents'"
        )
    }
    assert not columns & {"state", "working", "doing", "busy", "last_active"}


# ── spend, from the one ledger ─────────────────────────────────────────────


async def test_spend_is_the_ledgers_by_role_read_once_and_unreadable_is_said(
    owner_client, mount_peers, monkeypatch, root
):
    gateway = _gateway(
        spend_body=_spend(
            {"key": "agent_coder", "local": False, "usd": 3.5, "calls": 3},
            {"key": "chat", "local": False, "usd": 99.0, "calls": 40},
            {"key": None, "local": True, "usd": 1.0, "calls": 1},
        )
    )
    mount_peers(gateway=gateway)
    await _create(owner_client, name="coder")
    await _create(owner_client, name="writer")
    spend_calls = lambda: len([p for p, _ in gateway.seen if p == "/admin/spend"])  # noqa: E731
    before = spend_calls()

    listed = (await owner_client.get("/api/v1/agents")).json()
    assert spend_calls() == before + 1  # ONE report for the whole roster
    by_name = {a["name"]: a for a in listed}
    assert by_name["coder"]["spent_month_usd"] == 3.5 and by_name["coder"]["spend_note"] is None
    # No row for the role: a real 0 — the agent ran nothing this month.
    assert by_name["writer"]["spent_month_usd"] == 0.0 and by_name["writer"]["spend_note"] is None

    # The gateway answers the ledger with an error: null, and why.
    gateway.spend_body = None
    gateway.admin_status, gateway.admin_body = 500, {"error": "ledger db down"}
    listed = (await owner_client.get("/api/v1/agents")).json()
    for row in listed:
        assert row["spent_month_usd"] is None
        assert row["spend_note"] == "ledger unreadable — ledger db down"

    # A report with no by_role rollup is not a 0 either.
    gateway.admin_status, gateway.admin_body = 200, {"window": "month", "totals": {"usd": 0}}
    one = (await owner_client.get("/api/v1/agents/coder")).json()
    assert one["spent_month_usd"] is None
    assert one["spend_note"] == "ledger unreadable — the gateway's report carries no by_role rollup"

    # No gateway at all: the same null, with the reach failure.
    monkeypatch.delenv("GATEWAY_URL", raising=False)
    one = (await owner_client.get("/api/v1/agents/coder")).json()
    assert one["spent_month_usd"] is None
    assert one["spend_note"].startswith("ledger unreadable — could not reach the gateway")
