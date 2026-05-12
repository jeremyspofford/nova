"""Sandboxed shell command tool — runs inside Docker container, never on host."""
from ..registry import tool, Tier
from ..context import ToolContext
from ..sandbox.manager import run_in_sandbox


@tool(tier=Tier.MUTATE, cap_scope="shell:{command}", timeout_s=120, name="shell.exec")
async def shell_run(command: str, *, ctx: ToolContext) -> dict:
    """Run a shell command inside the sandboxed container for this task."""
    return await run_in_sandbox(str(ctx.task_id), command, "shell")
