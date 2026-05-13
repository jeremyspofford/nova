"""@tool decorator and in-memory ToolDef registry."""
import inspect
from dataclasses import dataclass
from enum import Enum
from typing import Callable


class Tier(str, Enum):
    READ = "READ"
    PROPOSE = "PROPOSE"
    MUTATE = "MUTATE"
    DESTRUCT = "DESTRUCT"
    SPECIAL = "SPECIAL"     # dispatch_subagent; not exposed to LLM


@dataclass
class ToolDef:
    name: str
    fn: Callable
    tier: Tier
    description: str
    input_schema: dict
    reversible: bool = False
    cap_scope_template: str = ""
    timeout_s: int = 30
    source: str = "builtin"
    server_id: str = ""
    remote_name: str = ""


_registry: dict[str, ToolDef] = {}


def tool(
    *,
    tier: Tier,
    reversible: bool = False,
    cap_scope: str = "",
    timeout_s: int = 30,
    name: str = "",
):
    """Decorator to register a built-in tool."""
    def decorator(fn: Callable) -> Callable:
        tool_name = name or fn.__name__
        props, required = _schema_from_sig(fn)
        _registry[tool_name] = ToolDef(
            name=tool_name,
            fn=fn,
            tier=tier,
            description=(fn.__doc__ or "").strip(),
            input_schema={"type": "object", "properties": props, "required": required},
            reversible=reversible,
            cap_scope_template=cap_scope or tool_name,
            timeout_s=timeout_s,
        )
        return fn
    return decorator


def _schema_from_sig(fn: Callable) -> tuple[dict, list[str]]:
    props: dict = {}
    required: list[str] = []
    for pname, param in inspect.signature(fn).parameters.items():
        if pname in ("ctx", "self"):
            continue
        props[pname] = _ann_to_schema(param.annotation)
        if param.default is inspect.Parameter.empty:
            required.append(pname)
    return props, required


def _ann_to_schema(ann) -> dict:
    if ann is str or ann is inspect.Parameter.empty:
        return {"type": "string"}
    if ann is int:
        return {"type": "integer"}
    if ann is bool:
        return {"type": "boolean"}
    if ann is float:
        return {"type": "number"}
    if ann is list or (hasattr(ann, "__origin__") and ann.__origin__ is list):
        return {"type": "array", "items": {"type": "string"}}
    return {"type": "string"}


def lookup(name: str) -> ToolDef:
    if name not in _registry:
        raise KeyError(f"Unknown tool: {name!r}")
    return _registry[name]


def register_mcp(server_id: str, tool_name: str, remote_name: str, tier: Tier, schema: dict) -> None:
    """Register an MCP-sourced tool."""
    _registry[tool_name] = ToolDef(
        name=tool_name,
        fn=_mcp_stub,
        tier=tier,
        description=schema.get("description", ""),
        input_schema=schema.get("inputSchema", {"type": "object", "properties": {}}),
        reversible=False,
        cap_scope_template=tool_name,
        timeout_s=60,
        source="mcp",
        server_id=server_id,
        remote_name=remote_name,
    )


async def _mcp_stub(**kwargs):
    raise RuntimeError("MCP tools route through dispatcher._invoke")


def unregister_mcp(server_id: str) -> None:
    to_del = [n for n, td in _registry.items() if td.server_id == server_id]
    for n in to_del:
        del _registry[n]


def all_tools() -> list[ToolDef]:
    return list(_registry.values())


def to_openai_tools() -> list[dict]:
    """Return tool definitions in OpenAI function-calling format. SPECIAL tier excluded."""
    return [
        {
            "type": "function",
            "function": {
                "name": td.name,
                "description": td.description,
                "parameters": td.input_schema,
            },
        }
        for td in _registry.values()
        if td.tier != Tier.SPECIAL
    ]
