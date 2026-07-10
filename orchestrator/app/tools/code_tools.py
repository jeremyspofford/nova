"""
Code & Terminal Tools — filesystem and shell access for Nova agents.

Access scope is controlled by the sandbox tier:
  workspace — paths scoped to /workspace (default)
  home      — paths scoped to user's home directory
  (root tier removed 2026-04-17 / SEC-001 — see app/tools/sandbox.py)
  isolated  — no filesystem or shell access

Tools provided:
  list_dir          — directory listing
  read_file         — read a file's contents
  write_file        — create or overwrite a file
  run_shell         — execute a shell command with timeout
  search_codebase   — ripgrep search
"""
from __future__ import annotations

import asyncio
import logging
import os
from pathlib import Path
from typing import TYPE_CHECKING

from nova_contracts import BlastRadius, ToolDefinition

if TYPE_CHECKING:
    from app.tools.sandbox import SandboxTier

log = logging.getLogger(__name__)


def display_path(path: Path | str) -> str:
    """Convert internal container path to user-facing path.

    With the root tier removed (SEC-001), there's no longer a /host-root
    prefix to strip — paths are either /workspace or the real home dir.
    """
    return str(path)

# ─── Tool definitions (what the LLM sees) ────────────────────────────────────

CODE_TOOLS: list[ToolDefinition] = [
    ToolDefinition(
        name="list_dir",
        description=(
            "List files and directories at a given path inside the Nova workspace. "
            "Path is relative to the workspace root. Use '.' for the root itself."
        ),
        parameters={
            "type": "object",
            "properties": {
                "path": {
                    "type": "string",
                    "description": "Relative path to list, e.g. '.' or 'src/app'",
                },
                "recursive": {
                    "type": "boolean",
                    "description": "If true, list all files recursively (default: false)",
                },
            },
            "required": ["path"],
        },
        blast_radius=BlastRadius.READ,
    ),
    ToolDefinition(
        name="read_file",
        description=(
            "Read the contents of a file in the Nova workspace. "
            "Returns raw text. Large files are truncated at 8000 characters."
        ),
        parameters={
            "type": "object",
            "properties": {
                "path": {
                    "type": "string",
                    "description": "Relative path to the file, e.g. 'src/main.py'",
                },
            },
            "required": ["path"],
        },
        blast_radius=BlastRadius.READ,
    ),
    ToolDefinition(
        name="write_file",
        description=(
            "Write or overwrite a file in the Nova workspace. "
            "Creates parent directories automatically. "
            "Use this to create new files or apply code changes."
        ),
        parameters={
            "type": "object",
            "properties": {
                "path": {
                    "type": "string",
                    "description": "Relative path to the file, e.g. 'src/main.py'",
                },
                "content": {
                    "type": "string",
                    "description": "Full file content to write",
                },
            },
            "required": ["path", "content"],
        },
        blast_radius=BlastRadius.MUTATE,
        reversible=False,
    ),
    ToolDefinition(
        name="run_shell",
        description=(
            "Run a shell command inside the Nova workspace and return stdout + stderr. "
            "Commands run in a subprocess with a hard timeout. "
            "Use this to run tests, build steps, linters, or any CLI tool. "
            "Working directory defaults to workspace root unless working_dir is set."
        ),
        parameters={
            "type": "object",
            "properties": {
                "command": {
                    "type": "string",
                    "description": "Shell command to run, e.g. 'pytest tests/' or 'npm run build'",
                },
                "working_dir": {
                    "type": "string",
                    "description": (
                        "Relative path within the workspace to use as cwd "
                        "(default: workspace root)"
                    ),
                },
            },
            "required": ["command"],
        },
        blast_radius=BlastRadius.MUTATE,
        reversible=False,
    ),
    ToolDefinition(
        name="search_codebase",
        description=(
            "Search for a pattern across files in the Nova workspace using ripgrep. "
            "Returns matching lines with file paths and line numbers. "
            "Use this to find function definitions, usages, TODO comments, etc."
        ),
        parameters={
            "type": "object",
            "properties": {
                "pattern": {
                    "type": "string",
                    "description": "Regex or literal string to search for",
                },
                "path": {
                    "type": "string",
                    "description": "Relative path to search within (default: entire workspace)",
                },
                "file_glob": {
                    "type": "string",
                    "description": "Optional glob to restrict file types, e.g. '*.py' or '*.ts'",
                },
                "case_sensitive": {
                    "type": "boolean",
                    "description": "Default false (case-insensitive search)",
                },
            },
            "required": ["pattern"],
        },
        blast_radius=BlastRadius.READ,
    ),
]

# Name-based lookup for stable parameter reuse across tiers
_CODE_PARAMS = {t.name: t.parameters for t in CODE_TOOLS}


def get_code_tools(tier: "SandboxTier") -> list[ToolDefinition]:
    """Generate tool definitions with tier-appropriate descriptions."""
    from app.tools.sandbox import SandboxTier

    if tier == SandboxTier.home:
        return [
            ToolDefinition(
                name="list_dir",
                description=(
                    "List files and directories at a path in your home directory. "
                    "Use absolute paths (e.g., '/home/user/project/src') or relative paths from home."
                ),
                parameters=_CODE_PARAMS["list_dir"],
                blast_radius=BlastRadius.READ,
            ),
            ToolDefinition(
                name="read_file",
                description=(
                    "Read the contents of a file in your home directory. "
                    "Use absolute paths (e.g., '/home/user/project/main.py') or relative. "
                    "Large files are truncated at 8000 characters."
                ),
                parameters=_CODE_PARAMS["read_file"],
                blast_radius=BlastRadius.READ,
            ),
            ToolDefinition(
                name="write_file",
                description=(
                    "Write or overwrite a file in your home directory. "
                    "Use absolute paths or relative. Creates parent directories automatically."
                ),
                parameters=_CODE_PARAMS["write_file"],
                blast_radius=BlastRadius.MUTATE,
                reversible=False,
            ),
            ToolDefinition(
                name="run_shell",
                description=(
                    "Run a shell command with cwd in your home directory. "
                    "Commands run in a subprocess with a hard timeout. "
                    "Blocks sudo, curl|sh, and privilege escalation."
                ),
                parameters=_CODE_PARAMS["run_shell"],
                blast_radius=BlastRadius.MUTATE,
                reversible=False,
            ),
            ToolDefinition(
                name="search_codebase",
                description=(
                    "Search for a pattern across files in your home directory using ripgrep. "
                    "Returns matching lines with file paths and line numbers."
                ),
                parameters=_CODE_PARAMS["search_codebase"],
                blast_radius=BlastRadius.READ,
            ),
        ]

    # workspace / isolated — return defaults
    return list(CODE_TOOLS)


# ─── Path helpers ─────────────────────────────────────────────────────────────

def _is_within(candidate: Path, root: Path) -> bool:
    """True if `candidate` is `root` itself or a descendant of it.

    Path-containment check, NOT a string prefix: `str(p).startswith(str(root))`
    would accept a sibling like `/workspace-backup` as inside `/workspace`
    (NEW-01). `root in candidate.parents` compares path components, closing that.
    """
    return candidate == root or root in candidate.parents


def _resolve_path(relative: str) -> Path:
    """Resolve a path within the current sandbox tier's root.

    - workspace: relative paths only, scoped to /workspace
    - home: absolute or relative, scoped to $HOME
    - isolated: raises PermissionError
    """
    from app.tools.sandbox import SandboxTier, get_root, get_sandbox

    tier = get_sandbox()

    if tier == SandboxTier.isolated:
        get_root()  # raises PermissionError

    root = get_root()

    if tier == SandboxTier.home:
        if relative.startswith("/"):
            candidate = Path(relative).resolve()
        else:
            candidate = (root / relative).resolve()
        if not _is_within(candidate, root):
            raise ValueError(
                f"Path '{relative}' resolves outside home directory '{root}'. "
                "Access denied in home sandbox tier."
            )
        return candidate

    # Workspace tier (default)
    candidate = (root / relative).resolve()
    if not _is_within(candidate, root):
        # Check self-modification overlay: allow /nova paths
        from app.tools.sandbox import NOVA_SOURCE_ROOT, is_self_modification_enabled
        if is_self_modification_enabled():
            if relative.startswith("/nova") or relative.startswith("nova"):
                nova_candidate = Path(relative if relative.startswith("/") else f"/nova/{relative.removeprefix('nova/')}").resolve()
                if _is_within(nova_candidate, NOVA_SOURCE_ROOT):
                    return nova_candidate
        raise ValueError(
            f"Path '{relative}' resolves outside sandbox root '{root}'. "
            "Directory traversal is not permitted."
        )
    return candidate


# ─── Tool execution ───────────────────────────────────────────────────────────

async def execute_tool(name: str, arguments: dict) -> str:
    log.info("Executing code tool: %s  args=%s", name, arguments)
    try:
        if name == "list_dir":
            return _execute_list_dir(
                path=arguments.get("path", "."),
                recursive=arguments.get("recursive", False),
            )
        elif name == "read_file":
            return _execute_read_file(arguments["path"])
        elif name == "write_file":
            return _execute_write_file(arguments["path"], arguments["content"])
        elif name == "run_shell":
            return await _execute_run_shell(
                command=arguments["command"],
                working_dir=arguments.get("working_dir"),
            )
        elif name == "search_codebase":
            return await _execute_search_codebase(
                pattern=arguments["pattern"],
                path=arguments.get("path", "."),
                file_glob=arguments.get("file_glob"),
                case_sensitive=arguments.get("case_sensitive", False),
            )
        else:
            return f"Unknown code tool '{name}'"
    except ValueError as e:
        return f"Error: {e}"
    except Exception as e:
        log.error("Code tool %s failed: %s", name, e, exc_info=True)
        return f"Tool '{name}' failed: {e}"


def _execute_list_dir(path: str, recursive: bool) -> str:
    target = _resolve_path(path)
    if not target.exists():
        return f"Path '{path}' does not exist."
    if not target.is_dir():
        return f"'{path}' is a file, not a directory."

    if recursive:
        entries = sorted(target.rglob("*"))
    else:
        entries = sorted(target.iterdir())

    if not entries:
        return f"Directory '{path}' is empty."

    lines = [f"Contents of {path}:"]
    for e in entries:
        try:
            rel = e.relative_to(target)
        except ValueError:
            rel = display_path(e)
        kind = "/" if e.is_dir() else ""
        lines.append(f"  {rel}{kind}")
    return "\n".join(lines)


def _execute_read_file(path: str) -> str:
    target = _resolve_path(path)
    if not target.exists():
        return f"File '{path}' does not exist."
    if not target.is_file():
        return f"'{path}' is a directory, not a file."

    MAX_CHARS = 8000
    text = target.read_text(encoding="utf-8", errors="replace")
    if len(text) > MAX_CHARS:
        truncated = len(text) - MAX_CHARS
        text = text[:MAX_CHARS] + f"\n\n[... {truncated} characters truncated ...]"
    return f"File: {display_path(target)}\n```\n{text}\n```"


def _execute_write_file(path: str, content: str) -> str:
    target = _resolve_path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    existed = target.exists()
    target.write_text(content, encoding="utf-8")
    action = "Updated" if existed else "Created"
    byte_count = len(content.encode())
    return f"{action} '{display_path(target)}' ({byte_count} bytes, {content.count(chr(10)) + 1} lines)."


async def _execute_run_shell(command: str, working_dir: str | None) -> str:
    from app.config import settings
    from app.tools.sandbox import SandboxTier, get_sandbox

    tier = get_sandbox()

    # Isolated tier blocks shell entirely
    if tier == SandboxTier.isolated:
        return "Command blocked: shell access is disabled in isolated sandbox tier."

    # Resolve working directory
    try:
        cwd = _resolve_path(working_dir) if working_dir else _resolve_path(".")
    except PermissionError as e:
        return f"Command blocked: {e}"
    if not cwd.exists():
        return f"Working directory '{working_dir}' does not exist."

    # No command denylist: substring-matching is theater against any competent
    # LLM (see SEC-002 in docs/audits/2026-04-16-phase0/). The real boundary is
    # the sandbox tier — workspace bind-mount isolates the agent from the host.
    # Destructive-command WARNING is kept (non-blocking, surfaces risk to the
    # LLM so it can flag to the user).
    warned, warning_msg = _is_command_warned(command)

    # Set HOME correctly per tier
    if tier == SandboxTier.home:
        shell_home = settings.home_root
    else:
        shell_home = str(cwd)

    try:
        proc = await asyncio.create_subprocess_shell(
            command,
            cwd=str(cwd),
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            env={**os.environ, "HOME": shell_home, "TERM": "dumb"},
        )
        stdout, stderr = await asyncio.wait_for(
            proc.communicate(),
            timeout=settings.shell_timeout_seconds,
        )
    except asyncio.TimeoutError:
        proc.kill()
        return (
            f"Command timed out after {settings.shell_timeout_seconds}s.\n"
            f"Command: {command}"
        )

    out = stdout.decode(errors="replace").strip()
    err = stderr.decode(errors="replace").strip()

    parts = []
    if warned:
        parts.append(f"WARNING: {warning_msg}. The command ran — verify the result.")
    parts.extend([f"$ {command}", f"exit code: {proc.returncode}"])
    if out:
        parts.append(f"stdout:\n{out}")
    if err:
        parts.append(f"stderr:\n{err}")
    return "\n".join(parts)


# ─── Destructive command warnings (non-blocking) ─────────────────────────────
# These commands are legitimate but dangerous. The warning is prepended to the
# tool result so the LLM sees it and can flag it to the user.

_WARN_PATTERNS: list[tuple[str, str]] = [
    ("git push --force",    "Force-push rewrites remote history"),
    ("git push -f",         "Force-push rewrites remote history"),
    ("git reset --hard",    "Discards all uncommitted changes permanently"),
    ("git clean -f",        "Deletes untracked files permanently"),
    ("drop table",          "Destructive SQL — drops table permanently"),
    ("drop database",       "Destructive SQL — drops database permanently"),
    ("truncate ",           "Destructive SQL — removes all rows"),
    ("docker system prune", "Removes unused Docker resources"),
    ("docker volume rm",    "Removes Docker volume data permanently"),
    ("chmod 777",           "World-writable permissions — security risk"),
]


def _is_command_warned(command: str) -> tuple[bool, str]:
    """
    Return (True, warning) for dangerous-but-legitimate commands.
    Unlike _is_command_blocked, this does NOT prevent execution.
    """
    cmd_lower = command.lower().strip()
    for fragment, warning in _WARN_PATTERNS:
        if fragment in cmd_lower:
            return True, warning
    return False, ""


async def _execute_search_codebase(
    pattern: str,
    path: str,
    file_glob: str | None,
    case_sensitive: bool,
) -> str:
    target = _resolve_path(path)
    if not target.exists():
        return f"Search path '{path}' does not exist in workspace."

    args = ["rg", "--line-number", "--with-filename", "--max-count=5"]
    if not case_sensitive:
        args.append("--ignore-case")
    if file_glob:
        args.extend(["--glob", file_glob])
    args.extend(["--", pattern, str(target)])

    try:
        proc = await asyncio.create_subprocess_exec(
            *args,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=15)
    except FileNotFoundError:
        # rg not available — fall back to Python grep
        return _python_search(pattern, target, file_glob, case_sensitive)
    except asyncio.TimeoutError:
        return "Search timed out (>15s). Try a more specific pattern or path."

    out = stdout.decode(errors="replace").strip()
    err = stderr.decode(errors="replace").strip()

    if proc.returncode == 1 and not out:
        return f"No matches found for '{pattern}' in '{path}'."
    if err:
        log.warning("rg stderr: %s", err)
    return out or f"No matches found for '{pattern}' in '{path}'."


def _python_search(
    pattern: str,
    root: Path,
    file_glob: str | None,
    case_sensitive: bool,
) -> str:
    """Fallback search when ripgrep is not installed."""
    import re
    flags = 0 if case_sensitive else re.IGNORECASE
    try:
        rx = re.compile(pattern, flags)
    except re.error as e:
        return f"Invalid pattern '{pattern}': {e}"

    glob = file_glob or "*"
    matches: list[str] = []
    for fpath in sorted(root.rglob(glob)):
        if not fpath.is_file():
            continue
        try:
            for i, line in enumerate(fpath.read_text(errors="replace").splitlines(), 1):
                if rx.search(line):
                    matches.append(f"{fpath}:{i}: {line}")
                    if len(matches) >= 50:
                        matches.append("[truncated at 50 matches]")
                        return "\n".join(matches)
        except OSError:
            continue
    return "\n".join(matches) if matches else f"No matches found for '{pattern}'."
