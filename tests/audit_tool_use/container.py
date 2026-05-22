"""Container exec helpers for the audit.

The agent's /workspace lives inside the agent-core container, not on the host.
fs-related probes (SeedFile / FileExists / DeleteFile) must operate through
`docker exec` to interact with the same filesystem the agent sees.

Uses subprocess.run with argv list (no shell=True), so probe path strings
flow into the container's argv directly — no shell-injection surface from
host-side. The one shell-using path (`sh -c "cat > ..."` for stdin-driven
writes) uses shlex.quote on the file path.
"""
from __future__ import annotations
import os
import shlex
import subprocess
from typing import Optional


AGENT_CORE_CONTAINER = os.getenv("NOVA_AGENT_CORE_CONTAINER", "nova-agent-core-1")


def _exec(
    args: list[str],
    *,
    container: str,
    stdin: Optional[str] = None,
    timeout_s: float = 10.0,
) -> tuple[int, str, str]:
    """Run a command inside the container. argv list, no shell parsing."""
    cmd = ["docker", "exec"]
    if stdin is not None:
        cmd.append("-i")
    cmd.append(container)
    cmd.extend(args)
    try:
        result = subprocess.run(
            cmd, input=stdin, capture_output=True, text=True, timeout=timeout_s, check=False,
        )
        return result.returncode, result.stdout, result.stderr
    except subprocess.TimeoutExpired:
        return -1, "", f"timeout after {timeout_s}s"
    except FileNotFoundError:
        return -2, "", "docker CLI not found on host"


def file_exists_in_container(path: str, *, container: str = AGENT_CORE_CONTAINER) -> bool:
    rc, _, _ = _exec(["test", "-f", path], container=container)
    return rc == 0


def read_file_in_container(path: str, *, container: str = AGENT_CORE_CONTAINER) -> tuple[bool, str]:
    rc, out, err = _exec(["cat", path], container=container)
    if rc != 0:
        return False, err.strip() or f"cat returned {rc}"
    return True, out


def write_file_in_container(
    path: str, content: str, *, container: str = AGENT_CORE_CONTAINER,
) -> tuple[bool, str | None]:
    """Create parent dirs, then write content via stdin-fed `cat > path`."""
    parent = os.path.dirname(path) or "/"
    rc, _, err = _exec(["mkdir", "-p", parent], container=container)
    if rc != 0:
        return False, err.strip() or f"mkdir {parent} returned {rc}"
    rc, _, err = _exec(
        ["sh", "-c", f"cat > {shlex.quote(path)}"],
        container=container,
        stdin=content,
    )
    if rc != 0:
        return False, err.strip() or f"write returned {rc}"
    return True, None


def delete_file_in_container(
    path: str, *, container: str = AGENT_CORE_CONTAINER,
) -> tuple[bool, str | None]:
    """Idempotent — missing file is not a failure (rm -f)."""
    rc, _, err = _exec(["rm", "-f", path], container=container)
    if rc != 0:
        return False, err.strip() or f"rm returned {rc}"
    return True, None
