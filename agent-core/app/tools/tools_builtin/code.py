"""code.execute — run Python / JavaScript / Bash inside the sandbox."""
import base64
import shlex

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
    encoded = base64.b64encode(code.encode()).decode()
    # Use base64 to avoid heredoc injection — no delimiter can appear in encoded content
    run_cmd = f"echo {shlex.quote(encoded)} | base64 -d > {tmp} && {runner} {tmp}"
    return await run_in_sandbox(str(ctx.task_id), run_cmd, "code")
