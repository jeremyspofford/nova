"""The MCP servers table and its rows (S37a). No network here: Task 5's
connect is the only writer of a real row; these insert one by hand."""

from __future__ import annotations

import json

import asyncpg
import pytest

from app.mcp import servers
from tests.conftest import requires_db

TOOLS = [
    {
        "name": "actions_list",
        "description": "List runs",
        "inputSchema": {"type": "object"},
        "annotations": {},
    }
]


async def _insert(pool, name: str = "github", **over) -> None:
    fields = {
        "url": "https://api.example.invalid/mcp/s3cret-path",
        "token": "t0ken",
        "headers": {"X-Api-Key": "hdr-secret"},
        "added_by": "owner",
        "tools": TOOLS,
    }
    fields.update(over)
    await pool.execute(
        "INSERT INTO mcp_servers (name, url, token, headers, added_by, protocol, title, tools, "
        "tools_hash, tools_fetched_at, tools_ttl_ms) "
        "VALUES ($1, $2, $3, $4, $5, '2026-07-28', 'GitHub', $6, $7, now(), 60000)",
        name,
        fields["url"],
        fields["token"],
        fields["headers"],
        fields["added_by"],
        fields["tools"],
        servers.tools_hash(fields["tools"]),
    )


@requires_db
async def test_a_row_round_trips_and_its_view_carries_no_credential(pool):
    await _insert(pool)
    [server] = await servers.list_servers(pool)
    assert server.origin == "https://api.example.invalid"
    assert server.endpoint.token == "t0ken"
    assert dict(server.endpoint.headers) == {"X-Api-Key": "hdr-secret"}
    view = server.view()
    text = json.dumps(view)
    for secret in ("t0ken", "hdr-secret", "s3cret-path"):
        assert secret not in text
    assert view["header_names"] == ["X-Api-Key"] and view["has_token"] is True
    assert view["tools"] == [{"name": "actions_list", "description": "List runs"}]


@requires_db
async def test_the_table_refuses_a_name_the_store_would_refuse(pool):
    with pytest.raises(asyncpg.CheckViolationError):
        await _insert(pool, name="Bad Name")


@requires_db
async def test_failing_is_a_failure_newer_than_the_last_success(pool):
    await _insert(pool)
    await servers.record_call(pool, "github", ok=False, reason="timed out")
    assert (await servers.get(pool, "github")).failing is True
    await servers.record_call(pool, "github", ok=True)
    assert (await servers.get(pool, "github")).failing is False


async def test_record_call_on_a_broken_pool_raises_nothing():
    class Broken:
        async def execute(self, *args):
            raise RuntimeError("the table is on fire")

    await servers.record_call(Broken(), "github", ok=True)


@requires_db
async def test_an_overlay_replaces_the_table_and_never_touches_it(pool):
    await _insert(pool)
    declared = servers.Server(
        name="eval_x", url="http://eval-x.mcp.invalid/mcp", token=None, headers={}, added_by="owner"
    )
    token = servers.OVERLAY.set(servers.Overlay({"eval_x": declared}))
    try:
        assert [s.name for s in await servers.list_servers(None)] == ["eval_x"]
        assert await servers.get(None, "github") is None
        await servers.record_call(None, "eval_x", ok=False, reason="nope")
        assert (await servers.get(None, "eval_x")).failing is True
    finally:
        servers.OVERLAY.reset(token)
    assert [s.name for s in await servers.list_servers(pool)] == ["github"]


def test_tools_hash_ignores_order_and_diff_names_what_moved():
    a = [{"name": "x", "description": "1"}, {"name": "y", "description": "2"}]
    b = [{"name": "y", "description": "2"}, {"name": "x", "description": "1"}]
    assert servers.tools_hash(a) == servers.tools_hash(b)
    c = [{"name": "x", "description": "changed"}, {"name": "z"}]
    assert servers.diff(a, c) == {"added": ["z"], "removed": ["y"], "changed": ["x"]}
