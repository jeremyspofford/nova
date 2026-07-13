"""Tool registry and dispatch."""

import logging
from typing import Optional
from app.tools import builtin

log = logging.getLogger(__name__)


# Map of builtin tools
BUILTIN_TOOLS = {
    "list_agents": builtin.list_agents_tool,
    "dispatch_to_agent": builtin.dispatch_to_agent_tool,
    "manage_agents": builtin.manage_agents_tool,
    "search_memory": builtin.search_memory_tool,
    "write_memory": builtin.write_memory_tool,
    "read_memory_item": builtin.read_memory_item_tool,
    "manage_tools": builtin.manage_tools_tool,
}


async def get_agent_tools(agent_id: str, allowed_tools: Optional[list[str]] = None) -> list[dict]:
    """Get tools available to an agent."""
    tools = []

    if not allowed_tools:
        # Agent has access to all tools
        allowed_tools = list(BUILTIN_TOOLS.keys())

    for tool_name in allowed_tools:
        if tool_name in BUILTIN_TOOLS:
            tool_def = BUILTIN_TOOLS[tool_name]
            tools.append({
                "type": "function",
                "function": {
                    "name": tool_def["name"],
                    "description": tool_def["description"],
                    "parameters": tool_def["parameters"],
                }
            })

    return tools


async def execute_tool(tool_name: str, arguments: dict, context: dict) -> str:
    """Execute a tool by name."""
    if tool_name not in BUILTIN_TOOLS:
        return f"Error: Unknown tool '{tool_name}'"

    tool_func = BUILTIN_TOOLS[tool_name]["execute"]
    try:
        result = await tool_func(arguments, context)
        return result
    except Exception as e:
        log.error(f"Tool execution error for {tool_name}: {e}")
        return f"Error executing {tool_name}: {str(e)}"
