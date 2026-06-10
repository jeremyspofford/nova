"""Git tools: commit, push.

Uses asyncio.create_subprocess_exec (no shell) — args list prevents injection.
"""
import asyncio

from ..context import ToolContext
from ..registry import Tier, tool


async def _git(cwd: str, *args: str) -> tuple[int, str, str]:
    # create_subprocess_exec — no shell, args passed as separate argv entries
    proc = await asyncio.create_subprocess_exec(
        "git", *args, cwd=cwd,
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
    )
    out, err = await proc.communicate()
    return proc.returncode, out.decode(), err.decode()


@tool(tier=Tier.MUTATE, cap_scope="git:commit:{repo}", timeout_s=30, name="git.commit")
async def git_commit(repo: str, message: str, *, ctx: ToolContext) -> dict:
    """Stage all changes in a repo directory and create a commit."""
    rc, _, err = await _git(repo, "add", "-A")
    if rc != 0:
        return {"error": f"git add failed: {err.strip()}"}
    rc, out, err = await _git(repo, "commit", "-m", message)
    if rc != 0:
        return {"error": f"git commit failed: {err.strip()}"}
    return {"committed": True, "output": out.strip()}


@tool(tier=Tier.DESTRUCT, cap_scope="git:push:{remote}:{branch}", timeout_s=60, name="git.push")
async def git_push(repo: str, remote: str = "origin", branch: str = "", *, ctx: ToolContext) -> dict:
    """Push commits to a remote. Irreversible once pushed."""
    args = ["push", remote]
    if branch:
        args.append(branch)
    rc, out, err = await _git(repo, *args)
    if rc != 0:
        return {"error": f"git push failed: {err.strip()}"}
    return {"pushed": True, "output": out.strip()}
