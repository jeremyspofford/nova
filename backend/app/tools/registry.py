"""Tool registry — one place that builds agent toolsets and dispatches execution.

An agent's toolset = (builtins ∩ its allowed_tools) + all enabled DB-defined
tools. allowed_tools = NULL means "all builtins". DB tools are data
(execution_type='http_call'), so creating one takes effect immediately.
"""

import json
import logging
from typing import Optional

from app import db
from app.tools import builtin
from app.tools.http_executor import execute_http_tool

log = logging.getLogger(__name__)

BUILTIN_TOOLS = builtin.BUILTIN_TOOLS


async def _load_db_tools() -> dict[str, dict]:
    async with db.acquire() as conn:
        rows = await conn.fetch(
            "SELECT id, name, description, parameters_schema, execution_type, execution_spec "
            "FROM tools WHERE enabled = true")
    out = {}
    for r in rows:
        schema = r["parameters_schema"]
        if isinstance(schema, str):
            schema = json.loads(schema)
        out[r["name"]] = {
            "name": r["name"],
            "description": r["description"],
            "parameters": schema,
            "execution_type": r["execution_type"],
            "execution_spec": r["execution_spec"],
        }
    return out


def _to_llm_def(tool: dict) -> dict:
    return {"type": "function", "function": {
        "name": tool["name"],
        "description": tool["description"],
        "parameters": tool["parameters"],
    }}


async def get_agent_tools(agent: dict, exclude: Optional[set[str]] = None) -> list[dict]:
    """LLM tool definitions for an agent."""
    exclude = exclude or set()
    allowed = agent.get("allowed_tools")  # None => all builtins
    names = list(BUILTIN_TOOLS) if allowed is None else [n for n in allowed
                                                         if n in BUILTIN_TOOLS]
    defs = [_to_llm_def(BUILTIN_TOOLS[n]) for n in names if n not in exclude]

    for name, tool in (await _load_db_tools()).items():
        if name not in exclude and name not in BUILTIN_TOOLS:
            defs.append(_to_llm_def(tool))
    return defs


async def execute_tool(name: str, args: dict, ctx: dict) -> str:
    """Single dispatch point for every tool call (dispatch_to_agent is runner-inlined)."""
    if name in BUILTIN_TOOLS:
        try:
            return await BUILTIN_TOOLS[name]["execute"](args, ctx)
        except Exception as e:
            log.exception("Builtin tool %s failed", name)
            return f"Error executing {name}: {e}"

    db_tools = await _load_db_tools()
    if name in db_tools:
        tool = db_tools[name]
        if tool["execution_type"] == "http_call":
            try:
                return await execute_http_tool(tool, args)
            except Exception as e:
                log.exception("HTTP tool %s failed", name)
                return f"Error executing {name}: {e}"
        return f"Error: tool {name} has unsupported execution_type {tool['execution_type']}"

    return f"Error: unknown tool '{name}'"
