"""MCPManager — lazy start, crash recovery with restart windowing, graceful shutdown."""
from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass, field
from datetime import datetime, timezone

from . import client as mcp_client
from .client import StdioMCPClient
from .lifecycle import start_server, stop_server
from .env_resolver import resolve_env

logger = logging.getLogger(__name__)

_RESTART_WINDOW_SECONDS = 300   # 5 minutes
_MAX_RESTARTS_IN_WINDOW = 3     # disable on the 4th crash


@dataclass
class MCPProcess:
    client: StdioMCPClient
    lock: asyncio.Lock
    restart_count: int = 0
    restart_window_start: datetime = field(
        default_factory=lambda: datetime.now(timezone.utc)
    )

    def is_alive(self) -> bool:
        return self.client.process.returncode is None


def _classify_restart(proc: MCPProcess) -> tuple[bool, str]:
    """Return (should_restart, reason).

    Allow up to _MAX_RESTARTS_IN_WINDOW restarts in the window; disable on the
    4th crash within the same window.  A crash outside the window resets the
    counter and always restarts.
    """
    now = datetime.now(timezone.utc)
    elapsed = (now - proc.restart_window_start).total_seconds()

    if elapsed > _RESTART_WINDOW_SECONDS:
        # Window has expired — reset and allow.
        return True, "window_expired"

    if proc.restart_count >= _MAX_RESTARTS_IN_WINDOW:
        return False, f"too_many_restarts ({proc.restart_count} in window)"

    return True, "within_limit"


class MCPManager:
    """Singleton that owns the lifecycle of all running MCP stdio processes."""

    def __init__(self) -> None:
        self._processes: dict[str, MCPProcess] = {}   # keyed by server_name
        self._server_ids: dict[str, str] = {}          # server_name -> server_id
        self._server_meta: dict[str, dict] = {}         # server_name -> {command,args,env,cwd}
        self._pool = None

    def set_pool(self, pool) -> None:
        self._pool = pool

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    async def ensure_running(self, server_name: str) -> MCPProcess:
        """Return the MCPProcess for *server_name*, spawning/restarting as needed."""
        proc = self._processes.get(server_name)
        if proc is not None and proc.is_alive():
            return proc

        meta = self._server_meta.get(server_name)
        if meta is None:
            raise RuntimeError(f"MCPManager: unknown server {server_name!r}")

        server_id = self._server_ids[server_name]

        if proc is not None:
            # Process exists but is dead — check restart policy.
            should, reason = _classify_restart(proc)
            if not should:
                raise RuntimeError(
                    f"MCP server {server_name!r} disabled after repeated crashes: {reason}"
                )
            # Increment counter; reset window if needed.
            now = datetime.now(timezone.utc)
            elapsed = (now - proc.restart_window_start).total_seconds()
            if elapsed > _RESTART_WINDOW_SECONDS:
                proc.restart_count = 0
                proc.restart_window_start = now
            proc.restart_count += 1

            logger.warning(
                "MCP server %r crashed (restart %d/%d), respawning",
                server_name, proc.restart_count, _MAX_RESTARTS_IN_WINDOW,
            )

        new_proc = await self._spawn(
            server_id=server_id,
            command=meta["command"],
            args=meta["args"],
            raw_env=meta["env"],
            cwd=meta.get("cwd"),
        )

        if proc is not None:
            # Preserve restart accounting from the old MCPProcess.
            new_proc.restart_count = proc.restart_count
            new_proc.restart_window_start = proc.restart_window_start

        self._processes[server_name] = new_proc
        return new_proc

    async def register_server(
        self,
        server_id: str,
        server_name: str,
        command: str,
        args: list[str],
        raw_env: dict,
        cwd: str | None,
    ) -> MCPProcess:
        """Register metadata and immediately spawn the server."""
        self._server_ids[server_name] = server_id
        self._server_meta[server_name] = {
            "command": command,
            "args": args,
            "env": raw_env,
            "cwd": cwd,
        }
        proc = await self._spawn(server_id, command, args, raw_env, cwd)
        self._processes[server_name] = proc
        return proc

    async def shutdown_all(self) -> None:
        """Gracefully stop all running MCP servers."""
        names = list(self._processes.keys())
        for name in names:
            server_id = self._server_ids.get(name)
            if server_id:
                try:
                    await stop_server(server_id)
                except Exception as exc:
                    logger.warning("Error stopping MCP server %r: %s", name, exc)
        self._processes.clear()
        self._server_ids.clear()
        self._server_meta.clear()

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    async def _spawn(
        self,
        server_id: str,
        command: str,
        args: list[str],
        raw_env: dict,
        cwd: str | None,
    ) -> MCPProcess:
        """Resolve env, call lifecycle.start_server, wrap in MCPProcess."""
        pool = self._pool
        resolved_env: dict = {}
        if raw_env:
            if pool is not None:
                resolved_env = await resolve_env(raw_env, pool)
            else:
                # No pool yet (unit test or pre-boot context) — skip secret expansion.
                resolved_env = {
                    k: v for k, v in raw_env.items()
                    if not (isinstance(v, str) and v.startswith("${secret:"))
                }

        await start_server(
            server_id=server_id,
            command=command,
            args=args,
            env=resolved_env,
            working_dir=cwd,
        )

        client = mcp_client.get_client(server_id)
        if client is None:
            raise RuntimeError(f"start_server succeeded but client not registered for {server_id}")

        return MCPProcess(client=client, lock=asyncio.Lock())
