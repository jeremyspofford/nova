"""
Git Tools — repository operations for Nova agents.

All commands run via subprocess (not a git library) so the output is
exactly what a developer would see in their terminal. Agents get clean,
readable text they can reason about and quote back to users.

Tools provided:
  git_status   — working tree status
  git_diff     — unstaged or staged changes
  git_log      — recent commit history
  git_commit   — stage files and create a commit
"""
from __future__ import annotations

import asyncio
import logging
from pathlib import Path
from typing import TYPE_CHECKING

from nova_contracts import BlastRadius, ToolDefinition

if TYPE_CHECKING:
    from app.tools.sandbox import SandboxTier

log = logging.getLogger(__name__)

# ─── Tool definitions ─────────────────────────────────────────────────────────

GIT_TOOLS: list[ToolDefinition] = [
    ToolDefinition(
        name="git_status",
        description=(
            "Show the working tree status of a git repository in the workspace. "
            "Returns staged, unstaged, and untracked file lists."
        ),
        parameters={
            "type": "object",
            "properties": {
                "repo_path": {
                    "type": "string",
                    "description": "Relative path to the git repo root (default: workspace root)",
                },
            },
            "required": [],
        },
        blast_radius=BlastRadius.READ,
    ),
    ToolDefinition(
        name="git_diff",
        description=(
            "Show unstaged changes in the workspace, or staged changes if staged=true. "
            "Optionally restrict to a specific file."
        ),
        parameters={
            "type": "object",
            "properties": {
                "repo_path": {
                    "type": "string",
                    "description": "Relative path to the git repo root (default: workspace root)",
                },
                "file_path": {
                    "type": "string",
                    "description": "Restrict diff to this relative file path (optional)",
                },
                "staged": {
                    "type": "boolean",
                    "description": "Show staged (--cached) changes instead of unstaged (default: false)",
                },
            },
            "required": [],
        },
        blast_radius=BlastRadius.READ,
    ),
    ToolDefinition(
        name="git_log",
        description="Show recent git commit history with author, date, and message.",
        parameters={
            "type": "object",
            "properties": {
                "repo_path": {
                    "type": "string",
                    "description": "Relative path to the git repo root (default: workspace root)",
                },
                "n": {
                    "type": "integer",
                    "description": "Number of commits to show (default: 10)",
                },
            },
            "required": [],
        },
        blast_radius=BlastRadius.READ,
    ),
    ToolDefinition(
        name="git_commit",
        description=(
            "Stage one or more files and create a git commit with the given message. "
            "Pass files=['.')] to stage all changes. "
            "Returns the new commit hash on success."
        ),
        parameters={
            "type": "object",
            "properties": {
                "message": {
                    "type": "string",
                    "description": "Commit message",
                },
                "files": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": "List of relative file paths to stage, or ['.'] for all changes",
                },
                "repo_path": {
                    "type": "string",
                    "description": "Relative path to the git repo root (default: workspace root)",
                },
            },
            "required": ["message", "files"],
        },
        blast_radius=BlastRadius.MUTATE,
    ),
]

# Name-based lookup for stable parameter reuse across tiers
_GIT_PARAMS = {t.name: t.parameters for t in GIT_TOOLS}


def get_git_tools(tier: "SandboxTier") -> list[ToolDefinition]:
    """Generate git tool definitions with tier-appropriate descriptions."""
    from app.tools.sandbox import SandboxTier

    if tier == SandboxTier.home:
        scope = "home directory"
        return [
            ToolDefinition(
                name="git_status",
                description=(
                    f"Show the working tree status of any git repository on the {scope}. "
                    "Returns staged, unstaged, and untracked file lists."
                ),
                parameters=_GIT_PARAMS["git_status"],
                blast_radius=BlastRadius.READ,
            ),
            ToolDefinition(
                name="git_diff",
                description=(
                    f"Show unstaged or staged changes in any git repository on the {scope}."
                ),
                parameters=_GIT_PARAMS["git_diff"],
                blast_radius=BlastRadius.READ,
            ),
            ToolDefinition(
                name="git_log",
                description=f"Show recent git commit history for any repo on the {scope}.",
                parameters=_GIT_PARAMS["git_log"],
                blast_radius=BlastRadius.READ,
            ),
            ToolDefinition(
                name="git_commit",
                description=(
                    f"Stage files and commit in any git repository on the {scope}."
                ),
                parameters=_GIT_PARAMS["git_commit"],
                blast_radius=BlastRadius.MUTATE,
            ),
        ]

    return list(GIT_TOOLS)


# ─── Helpers ──────────────────────────────────────────────────────────────────

def _resolve_repo(repo_path: str | None) -> Path:
    """Resolve repo_path inside the current sandbox root, defaulting to sandbox root."""
    from app.tools.code_tools import _resolve_path
    return _resolve_path(repo_path or ".")


async def _git(args: list[str], cwd: Path) -> tuple[int, str, str]:
    """Run a git command and return (returncode, stdout, stderr)."""
    proc = await asyncio.create_subprocess_exec(
        "git", *args,
        cwd=str(cwd),
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    try:
        stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=30)
    except asyncio.TimeoutError:
        proc.kill()
        return -1, "", "git command timed out after 30s"
    return (
        proc.returncode,
        stdout.decode(errors="replace").strip(),
        stderr.decode(errors="replace").strip(),
    )


# ─── Tool execution ───────────────────────────────────────────────────────────

async def execute_tool(name: str, arguments: dict) -> str:
    log.info("Executing git tool: %s  args=%s", name, arguments)
    try:
        if name == "git_status":
            return await _execute_git_status(arguments.get("repo_path"))
        elif name == "git_diff":
            return await _execute_git_diff(
                repo_path=arguments.get("repo_path"),
                file_path=arguments.get("file_path"),
                staged=arguments.get("staged", False),
            )
        elif name == "git_log":
            return await _execute_git_log(
                repo_path=arguments.get("repo_path"),
                n=arguments.get("n", 10),
            )
        elif name == "git_commit":
            return await _execute_git_commit(
                message=arguments["message"],
                files=arguments["files"],
                repo_path=arguments.get("repo_path"),
            )
        else:
            return f"Unknown git tool '{name}'"
    except ValueError as e:
        return f"Error: {e}"
    except Exception as e:
        log.error("Git tool %s failed: %s", name, e, exc_info=True)
        return f"Tool '{name}' failed: {e}"


async def _execute_git_status(repo_path: str | None) -> str:
    cwd = _resolve_repo(repo_path)
    rc, out, err = await _git(["status", "--short", "--branch"], cwd)
    if rc != 0:
        return f"git status failed (exit {rc}):\n{err or out}"
    return out or "Working tree clean."


async def _execute_git_diff(
    repo_path: str | None,
    file_path: str | None,
    staged: bool,
) -> str:
    cwd = _resolve_repo(repo_path)
    args = ["diff"]
    if staged:
        args.append("--cached")
    # Limit diff output to keep it within LLM context budget
    args.extend(["--stat", "--patch", "--unified=3"])
    if file_path:
        args.extend(["--", file_path])

    rc, out, err = await _git(args, cwd)
    if rc != 0:
        return f"git diff failed (exit {rc}):\n{err or out}"

    if not out:
        label = "staged" if staged else "unstaged"
        return f"No {label} changes."

    # Truncate very large diffs
    MAX_CHARS = 6000
    if len(out) > MAX_CHARS:
        out = out[:MAX_CHARS] + f"\n\n[... diff truncated at {MAX_CHARS} chars ...]"
    return out


async def _execute_git_log(repo_path: str | None, n: int) -> str:
    cwd = _resolve_repo(repo_path)
    fmt = "%C(auto)%h  %ad  %an  %s"
    rc, out, err = await _git(
        ["log", f"-{min(n, 50)}", "--date=short", f"--format={fmt}"],
        cwd,
    )
    if rc != 0:
        return f"git log failed (exit {rc}):\n{err or out}"
    return out or "No commits yet."


async def _execute_git_commit(
    message: str,
    files: list[str],
    repo_path: str | None,
) -> str:
    cwd = _resolve_repo(repo_path)

    if not message.strip():
        return "Error: commit message cannot be empty."

    # Stage files
    add_rc, add_out, add_err = await _git(["add", "--"] + files, cwd)
    if add_rc != 0:
        return f"git add failed (exit {add_rc}):\n{add_err or add_out}"

    # Commit
    commit_rc, commit_out, commit_err = await _git(
        ["commit", "-m", message],
        cwd,
    )
    if commit_rc != 0:
        return f"git commit failed (exit {commit_rc}):\n{commit_err or commit_out}"

    return commit_out
