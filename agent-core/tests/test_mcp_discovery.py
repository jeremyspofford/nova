"""Tests for MCP tool discovery — tier heuristic and verb extraction."""
from unittest.mock import AsyncMock, MagicMock

import pytest

# ── classify_tier ────────────────────────────────────────────────────────────

class TestClassifyTier:
    def test_read_verbs(self):
        from app.tools.mcp.discovery import classify_tier
        from app.tools.registry import Tier

        for name in ("get_user", "list_files", "fetch_data", "read_config",
                     "search_docs", "query_db", "describe_table", "show_status",
                     "find_node"):
            assert classify_tier(name) == Tier.READ, f"Expected READ for {name!r}"

    def test_destruct_verbs(self):
        from app.tools.mcp.discovery import classify_tier
        from app.tools.registry import Tier

        for name in ("delete_user", "remove_file", "drop_table", "destroy_env",
                     "purge_cache", "uninstall_pkg"):
            assert classify_tier(name) == Tier.DESTRUCT, f"Expected DESTRUCT for {name!r}"

    def test_mutate_default(self):
        from app.tools.mcp.discovery import classify_tier
        from app.tools.registry import Tier

        for name in ("create_user", "update_config", "write_file", "run_command",
                     "send_message"):
            assert classify_tier(name) == Tier.MUTATE, f"Expected MUTATE for {name!r}"

    def test_dotted_name_uses_last_segment(self):
        from app.tools.mcp.discovery import classify_tier
        from app.tools.registry import Tier

        assert classify_tier("filesystem.list_files") == Tier.READ
        assert classify_tier("db.delete_record") == Tier.DESTRUCT
        assert classify_tier("git.commit") == Tier.MUTATE


# ── extract_tool_verb ────────────────────────────────────────────────────────

class TestExtractToolVerb:
    def test_simple_underscore_name(self):
        from app.tools.mcp.discovery import extract_tool_verb
        assert extract_tool_verb("get_user") == "get"

    def test_dotted_name(self):
        from app.tools.mcp.discovery import extract_tool_verb
        assert extract_tool_verb("filesystem.list_files") == "list"

    def test_single_word(self):
        from app.tools.mcp.discovery import extract_tool_verb
        assert extract_tool_verb("delete") == "delete"

    def test_uppercase_normalised(self):
        from app.tools.mcp.discovery import extract_tool_verb
        assert extract_tool_verb("GET_DATA") == "get"


# ── discover_tools ────────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_discover_tools_applies_heuristic():
    from app.tools.mcp.discovery import discover_tools

    client = MagicMock()
    client.list_tools = AsyncMock(return_value=[
        {"name": "get_user", "description": "fetch user", "inputSchema": {}},
        {"name": "delete_record", "description": "remove record", "inputSchema": {}},
        {"name": "create_item", "description": "add item", "inputSchema": {}},
    ])

    pool = MagicMock()
    pool.acquire = MagicMock()
    # Simulate empty overrides
    conn = AsyncMock()
    conn.fetch = AsyncMock(return_value=[])
    pool.acquire.return_value.__aenter__ = AsyncMock(return_value=conn)
    pool.acquire.return_value.__aexit__ = AsyncMock(return_value=None)

    tools = await discover_tools(client, "srv-abc123", pool)

    assert len(tools) == 3
    by_name = {t["name"]: t for t in tools}
    # auto_tier and effective_tier both reflect heuristic (no overrides)
    assert by_name["get_user"]["auto_tier"] == "READ"
    assert by_name["get_user"]["effective_tier"] == "READ"
    assert by_name["delete_record"]["auto_tier"] == "DESTRUCT"
    assert by_name["create_item"]["auto_tier"] == "MUTATE"


@pytest.mark.asyncio
async def test_discover_tools_applies_db_override():
    from app.tools.mcp.discovery import discover_tools

    client = MagicMock()
    client.list_tools = AsyncMock(return_value=[
        {"name": "run_command", "description": "", "inputSchema": {}},
    ])

    pool = MagicMock()
    pool.acquire = MagicMock()
    conn = AsyncMock()
    # DB override: run_command -> READ
    override_row = MagicMock()
    override_row.__getitem__ = lambda self, k: {"tool_name": "run_command", "tier_override": "READ"}[k]
    conn.fetch = AsyncMock(return_value=[override_row])
    pool.acquire.return_value.__aenter__ = AsyncMock(return_value=conn)
    pool.acquire.return_value.__aexit__ = AsyncMock(return_value=None)

    tools = await discover_tools(client, "srv-abc123", pool)
    # run_command auto-tier is MUTATE; DB override sets effective_tier to READ
    assert tools[0]["auto_tier"] == "MUTATE"
    assert tools[0]["effective_tier"] == "READ"


@pytest.mark.asyncio
async def test_discover_tools_skips_nameless():
    from app.tools.mcp.discovery import discover_tools

    client = MagicMock()
    client.list_tools = AsyncMock(return_value=[
        {"name": "", "description": "no name"},
        {"name": "valid_tool", "description": "ok", "inputSchema": {}},
    ])

    pool = MagicMock()
    pool.acquire = MagicMock()
    conn = AsyncMock()
    conn.fetch = AsyncMock(return_value=[])
    pool.acquire.return_value.__aenter__ = AsyncMock(return_value=conn)
    pool.acquire.return_value.__aexit__ = AsyncMock(return_value=None)

    tools = await discover_tools(client, "srv-abc123", pool)
    assert len(tools) == 1
    assert tools[0]["name"] == "valid_tool"
