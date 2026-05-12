"""Sandboxed code execution: python | javascript | bash."""
from ..registry import tool, Tier
from ..context import ToolContext
from ..sandbox.manager import run_in_sandbox

_RUNNERS = {"python": "python3", "javascript": "node", "bash": "bash"}


@tool(tier=Tier.MUTATE, cap_scope="code:{language}", timeout_s=120, name="code.execute")
async def code_execute(language: str, code: str, *, ctx: ToolContext) -> dict:
    """Execute code in the sandbox. language: python | javascript | bash."""
    if language not in _RUNNERS:
        return {"error": f"Unsupported language {language!r}. Use: python, javascript, bash"}
    runner = _RUNNERS[language]
    tmp = f"/tmp/nova_{ctx.idempotency_key[:8]}.script"
    write_cmd = f"cat > {tmp} << 'NOVA_SCRIPT_EOF'\n{code}\nNOVA_SCRIPT_EOF"
    run_cmd = f"{runner} {tmp}"
    return await run_in_sandbox(str(ctx.task_id), f"{write_cmd} && {run_cmd}", "code")
