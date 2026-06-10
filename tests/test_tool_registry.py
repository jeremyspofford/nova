"""Unit tests for tool registry — no running services needed."""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "../agent-core"))

import pytest


def test_tool_decorator_registers():
    from app.tools.context import ToolContext
    from app.tools.registry import Tier, lookup, tool

    @tool(tier=Tier.READ)
    async def my_test_read(path: str, *, ctx: ToolContext) -> dict:
        """Read a path."""
        return {}

    td = lookup("my_test_read")
    assert td.tier == Tier.READ
    assert "Read a path" in td.description
    assert td.reversible is False


def test_tool_requires_tier():
    from app.tools.registry import tool
    with pytest.raises(TypeError):
        @tool()  # missing required kwarg: tier
        async def bad(path: str, *, ctx) -> dict:
            return {}


def test_tool_custom_name():
    from app.tools.context import ToolContext
    from app.tools.registry import Tier, lookup, tool

    @tool(tier=Tier.MUTATE, name="custom.tool")
    async def _impl(x: str, *, ctx: ToolContext) -> dict:
        return {}

    assert lookup("custom.tool").name == "custom.tool"


def test_to_openai_tools_format():
    from app.tools.context import ToolContext
    from app.tools.registry import Tier, to_openai_tools, tool

    @tool(tier=Tier.READ)
    async def sample_read(query: str, *, ctx: ToolContext) -> dict:
        """Sample for format test."""
        return {}

    tools = to_openai_tools()
    assert len(tools) >= 1
    for t in tools:
        assert t["type"] == "function"
        assert "name" in t["function"]
        assert "parameters" in t["function"]
