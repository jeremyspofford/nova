"""SPECIAL-tier subagent dispatch tool."""
from ..context import ToolContext
from ..registry import Tier, tool


@tool(tier=Tier.SPECIAL, cap_scope="subagent:{role}", timeout_s=600, name="dispatch_subagent")
async def dispatch_subagent(role: str, capabilities: list, goal: str, *, ctx: ToolContext) -> dict:
    """Spawn a sub-agent with a restricted capability subset. Depth limit = 1."""
    if ctx.caller_role != "main":
        raise PermissionError("Sub-agents cannot dispatch sub-agents (depth limit = 1)")
    from ...loop.main import run_subagent
    return await run_subagent(
        role=role, capabilities=capabilities, goal=goal,
        parent_task_id=ctx.task_id, parent_call_id=ctx.call_id, pool=ctx.pool,
    )
