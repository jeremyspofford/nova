"""The MCP roster in her prompt (S37a): each connected server by name with its
tool NAMES — never a server's own descriptions — a count instead of a list for
a big server, the failure when its last call failed, and nothing at all when
nothing is connected."""

from __future__ import annotations

from app.mcp import servers
from tests.conftest import requires_db
from tests.fakes import FakeMemory, ScriptedGateway
from tests.test_chat_agents import _nova_turn, _owner, _spans
from tests.test_chat_tools import text

pytestmark = requires_db


async def _row(pool, name: str, tool_names: list[str], *, title: str = "GitHub") -> None:
    tools = [
        {"name": n, "description": f"describes {n}", "inputSchema": {}, "annotations": {}}
        for n in tool_names
    ]
    await pool.execute(
        "INSERT INTO mcp_servers (name, url, added_by, protocol, title, tools, tools_hash, "
        "tools_fetched_at, tools_ttl_ms) "
        "VALUES ($1, 'https://x.invalid/mcp', 'owner', '2026-07-28', $2, $3, $4, now(), 60000)",
        name,
        title,
        tools,
        servers.tools_hash(tools),
    )


async def _volatile(pool, mount_peers) -> tuple[str, object]:
    owner = await _owner(pool)
    gateway = ScriptedGateway(rounds=((text("hi"),),))
    mount_peers(gateway=gateway, memory=FakeMemory())
    turn, _ = await _nova_turn(pool, owner)
    return gateway.payloads[0]["messages"][1]["content"], turn


async def test_no_server_leaves_the_prompt_exactly_as_it_was(pool, mount_peers):
    volatile, _ = await _volatile(pool, mount_peers)
    assert "MCP servers" not in volatile and "mcp_call" not in volatile


async def test_a_connected_server_is_named_with_its_tools_and_never_their_descriptions(
    pool, mount_peers
):
    """Ruling F3: the roster's own suppression is correct (and so is the test
    it was checked against, once fixed) — a title that is the connection name
    in another case is redundant and left out ("github", title "GitHub");
    a title that differs beyond case is the only time it is shown ("ha",
    title "Home Assistant" -> "ha (Home Assistant)"). Both directions pinned
    together so neither regresses alone."""
    await _row(pool, "github", ["actions_list", "get_job_logs"])
    await _row(pool, "ha", ["turn_on"], title="Home Assistant")
    volatile, _ = await _volatile(pool, mount_peers)
    assert "github: actions_list, get_job_logs" in volatile
    assert "ha (Home Assistant): turn_on" in volatile
    assert "mcp_call(server, tool, arguments)" in volatile
    assert "describes actions_list" not in volatile


async def test_a_server_with_many_tools_is_a_count_not_a_list(pool, mount_peers):
    await _row(pool, "homeassistant", [f"ha_tool_{i}" for i in range(87)], title="Home Assistant")
    volatile, _ = await _volatile(pool, mount_peers)
    assert "homeassistant (Home Assistant): 87 tools — find one with mcp_tools" in volatile
    assert "ha_tool_50" not in volatile


async def test_a_failing_server_says_when_and_why(pool, mount_peers):
    """Interfaces as committed: `record_call` reads `server.url`/`.token`/
    `.headers` off its second argument (servers.py), so it takes the row
    itself — never a bare name string, which the plan text printed."""
    await _row(pool, "github", ["actions_list"])
    row = await servers.get(pool, "github")
    await servers.record_call(pool, row, ok=False, reason="could not reach github — ConnectError")
    volatile, _ = await _volatile(pool, mount_peers)
    assert "its last call failed at" in volatile and "ConnectError" in volatile


async def test_a_roster_that_cannot_be_read_leaves_a_span(pool, mount_peers, monkeypatch):
    await _row(pool, "github", ["actions_list"])

    async def broken(_pool):
        raise RuntimeError("the mcp table is on fire")

    monkeypatch.setattr(servers, "roster_line", broken)
    volatile, turn = await _volatile(pool, mount_peers)
    (span,) = [s for s in await _spans(pool, turn.id) if s["kind"] == "mcp_roster"]
    assert "on fire" in span["meta"]["error"]
    assert "actions_list" not in volatile
