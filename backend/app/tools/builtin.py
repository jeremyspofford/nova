"""Builtin tools for agents."""

import json
import logging
from app.agents import registry as agent_registry
from app.memory.memory import memory

log = logging.getLogger(__name__)

# Tool definitions follow this structure:
# {
#   "name": "tool_name",
#   "description": "What it does",
#   "parameters": { JSON Schema },
#   "execute": async function
# }


# ── Memory Tools ──

async def _search_memory(args: dict, ctx: dict) -> str:
    """Execute search_memory tool."""
    query = args.get("query", "")
    if not query:
        return "Error: query parameter required"
    result = await memory.context(query, max_chars=2000)
    return json.dumps(result)


search_memory_tool = {
    "name": "search_memory",
    "description": "Search memory for relevant information given a query",
    "parameters": {
        "type": "object",
        "properties": {
            "query": {"type": "string", "description": "Search query"},
        },
        "required": ["query"],
    },
    "execute": _search_memory,
}


async def _write_memory(args: dict, ctx: dict) -> str:
    """Execute write_memory tool."""
    content = args.get("content", "")
    if not content:
        return "Error: content parameter required"
    result = await memory.write(content, source_type="tool")
    return json.dumps(result)


write_memory_tool = {
    "name": "write_memory",
    "description": "Write content to memory (stores in journal and indexes for retrieval)",
    "parameters": {
        "type": "object",
        "properties": {
            "content": {"type": "string", "description": "Content to write to memory"},
        },
        "required": ["content"],
    },
    "execute": _write_memory,
}


async def _read_memory_item(args: dict, ctx: dict) -> str:
    """Execute read_memory_item tool."""
    item_id = args.get("item_id", "")
    if not item_id:
        return "Error: item_id parameter required"
    result = await memory.provenance(item_id)
    if result:
        return json.dumps(result)
    return "Error: Item not found"


read_memory_item_tool = {
    "name": "read_memory_item",
    "description": "Read a specific memory item by ID",
    "parameters": {
        "type": "object",
        "properties": {
            "item_id": {"type": "string", "description": "Memory item ID"},
        },
        "required": ["item_id"],
    },
    "execute": _read_memory_item,
}


# ── Agent Management Tools ──

async def _list_agents(args: dict, ctx: dict) -> str:
    """Execute list_agents tool."""
    agents = await agent_registry.list_agents(enabled_only=True)
    return json.dumps(agents, default=str)


list_agents_tool = {
    "name": "list_agents",
    "description": "List all available agents and their capabilities",
    "parameters": {
        "type": "object",
        "properties": {},
    },
    "execute": _list_agents,
}


async def _manage_agents(args: dict, ctx: dict) -> str:
    """Execute manage_agents tool for CRUD operations."""
    action = args.get("action", "").lower()

    if action == "create":
        name = args.get("name", "")
        description = args.get("description", "")
        system_prompt = args.get("system_prompt", "")
        model = args.get("model", "openrouter:anthropic/claude-3.5-haiku")
        allowed_tools = args.get("allowed_tools", [])

        if not name or not system_prompt:
            return "Error: name and system_prompt are required"

        agent_id = await agent_registry.create_agent(
            name, description, system_prompt, model, allowed_tools
        )
        return json.dumps({"status": "created", "agent_id": agent_id})

    elif action == "update":
        agent_id = args.get("agent_id", "")
        updates = {k: v for k, v in args.items() if k not in ["action", "agent_id"]}
        success = await agent_registry.update_agent(agent_id, **updates)
        return json.dumps({"status": "updated" if success else "failed"})

    elif action == "disable":
        agent_id = args.get("agent_id", "")
        success = await agent_registry.disable_agent(agent_id)
        return json.dumps({"status": "disabled" if success else "failed"})

    else:
        return f"Error: unknown action '{action}'"


manage_agents_tool = {
    "name": "manage_agents",
    "description": "Create, update, or disable agents",
    "parameters": {
        "type": "object",
        "properties": {
            "action": {"type": "string", "enum": ["create", "update", "disable"]},
            "name": {"type": "string"},
            "description": {"type": "string"},
            "system_prompt": {"type": "string"},
            "model": {"type": "string"},
            "allowed_tools": {"type": "array", "items": {"type": "string"}},
            "agent_id": {"type": "string"},
        },
        "required": ["action"],
    },
    "execute": _manage_agents,
}


# ── Agent Dispatch ──

async def _dispatch_to_agent(args: dict, ctx: dict) -> str:
    """Execute dispatch_to_agent tool."""
    agent_name = args.get("agent_name", "")
    message = args.get("message", "")

    if not agent_name or not message:
        return "Error: agent_name and message are required"

    # Check dispatch depth to prevent infinite loops
    dispatch_depth = ctx.get("dispatch_depth", 0)
    if dispatch_depth >= 1:
        return "Error: Cannot dispatch to another agent from a dispatched agent (depth limit reached)"

    agent = await agent_registry.get_agent_by_name(agent_name)
    if not agent:
        return f"Error: Agent '{agent_name}' not found"

    if not agent.get("enabled"):
        return f"Error: Agent '{agent_name}' is disabled"

    # For Phase 3, we return a special response indicating dispatch
    return json.dumps({
        "type": "dispatch",
        "agent_id": agent["id"],
        "agent_name": agent_name,
        "message": message,
        "system_prompt": agent["system_prompt"],
        "model": agent["model"],
        "allowed_tools": agent.get("allowed_tools", []),
    })


dispatch_to_agent_tool = {
    "name": "dispatch_to_agent",
    "description": "Dispatch a message to another agent for specialized handling",
    "parameters": {
        "type": "object",
        "properties": {
            "agent_name": {"type": "string", "description": "Name of the agent to dispatch to"},
            "message": {"type": "string", "description": "Message/task to send to the agent"},
        },
        "required": ["agent_name", "message"],
    },
    "execute": _dispatch_to_agent,
}


# ── Tool Management ──

async def _manage_tools(args: dict, ctx: dict) -> str:
    """Execute manage_tools tool."""
    action = args.get("action", "").lower()

    if action == "create":
        # For Phase 3, just return success - actual tool storage comes in Phase 4
        name = args.get("name", "")
        description = args.get("description", "")

        if not name:
            return "Error: name is required"

        return json.dumps({
            "status": "created",
            "tool_name": name,
            "message": f"Tool '{name}' created (full implementation in Phase 4)"
        })

    else:
        return f"Error: unknown action '{action}'"


manage_tools_tool = {
    "name": "manage_tools",
    "description": "Create and manage tools for agents",
    "parameters": {
        "type": "object",
        "properties": {
            "action": {"type": "string", "enum": ["create"]},
            "name": {"type": "string"},
            "description": {"type": "string"},
        },
        "required": ["action", "name"],
    },
    "execute": _manage_tools,
}
