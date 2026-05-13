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


def _classify_restart(restart_count: int, window_start: datetime, now: datetime) -> str:
    """Return 'restart' or 'disable'.

    Allow up to _MAX_RESTARTS_IN_WINDOW restarts within the window; return
    'disable' on the 4th crash in the same window.  A crash outside the
    window always returns 'restart' (counter resets in handle_crash).
    """
    elapsed = (now - window_start).total_seconds()

    if elapsed > _RESTART_WINDOW_SECONDS:
        # Window has expired — allow restart (caller will reset counter).
        return "restart"

    if restart_count >= _MAX_RESTARTS_IN_WINDOW:
        return "disable"

    return "restart"


class MCPManager:
    """Singleton that owns the lifecycle of all running MCP stdio processes."""

    def __init__(self) -> None:
        self._processes: dict[str, MCPProcess] = {}   # keyed by server_name
        self._server_ids: dict[str, str] = {}          # server_name -> server_id
        self._server_meta: dict[str, dict] = {}         # server_name -> {command,args,env,cwd}
        self._pool = None
        self._lock = asyncio.Lock()  # serializes ensure_running / handle_crash

    def set_pool(self, pool) -> None:
        self._pool = pool

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    async def ensure_running(self, server_id: str, server_name: str) -> MCPProcess:
        """Return the MCPProcess for *server_name*, spawning if not already alive.

        This method does NOT contain crash-recovery logic — call handle_crash()
        first when recovering from an error, then call ensure_running() again.

        Serialized through self._lock so two concurrent callers cannot both
        observe a dead process and both spawn a new subprocess.
        """
        async with self._lock:
            proc = self._processes.get(server_name)
            if proc is not None and proc.is_alive():
                return proc

            # Register meta from DB lookup if not already known (best-effort).
            if server_name not in self._server_meta:
                raise RuntimeError(f"MCPManager: unknown server {server_name!r} (id={server_id})")

            # Spawn a fresh process.
            meta = self._server_meta[server_name]
            new_proc = await self._spawn(
                server_id=server_id,
                command=meta["command"],
                args=meta["args"],
                raw_env=meta["env"],
                cwd=meta.get("cwd"),
            )

            if proc is not None:
                # Preserve restart accounting from the dead MCPProcess.
                new_proc.restart_count = proc.restart_count
                new_proc.restart_window_start = proc.restart_window_start

            self._processes[server_name] = new_proc

            # Update last_started in DB if we have a pool.
            if self._pool is not None:
                try:
                    async with self._pool.acquire() as conn:
                        await conn.execute(
                            "UPDATE mcp_servers SET last_started = now(), last_error = NULL "
                            "WHERE id = $1::uuid",
                            server_id,
                        )
                except Exception as exc:
                    logger.warning("ensure_running: could not update last_started for %s: %s", server_id[:8], exc)

            return new_proc

    async def handle_crash(self, server_id: str, server_name: str, error: str) -> bool:
        """Record a crash and decide whether to restart or disable the server.

        Returns True if the server was restarted (caller should retry the
        operation), False if the server has been disabled (caller should raise).

        Side effects:
          - Updates last_error in DB.
          - If restarting: updates last_started, increments restart_count on proc.
          - If disabling: sets enabled=false in DB.

        Serialized through self._lock to prevent concurrent callers from both
        deciding to restart and spawning duplicate subprocesses.
        """
        async with self._lock:
            return await self._handle_crash_locked(server_id, server_name, error)

    async def _handle_crash_locked(self, server_id: str, server_name: str, error: str) -> bool:
        """Inner implementation of handle_crash; must be called under self._lock."""
        proc = self._processes.get(server_name)
        now = datetime.now(timezone.utc)

        # Record the error in DB (best-effort).
        if self._pool is not None:
            try:
                async with self._pool.acquire() as conn:
                    await conn.execute(
                        "UPDATE mcp_servers SET last_error = $2 WHERE id = $1::uuid",
                        server_id, error,
                    )
            except Exception as exc:
                logger.warning("handle_crash: could not write last_error for %s: %s", server_id[:8], exc)

        if proc is None:
            # No tracked process — treat as first crash, attempt restart.
            logger.warning("MCP server %r crashed (no tracked proc): %s", server_name, error)
            return True

        # Determine current accounting, resetting window if expired.
        elapsed = (now - proc.restart_window_start).total_seconds()
        if elapsed > _RESTART_WINDOW_SECONDS:
            proc.restart_count = 0
            proc.restart_window_start = now

        action = _classify_restart(proc.restart_count, proc.restart_window_start, now)

        if action == "disable":
            logger.error(
                "MCP server %r disabled after %d crashes in window — error: %s",
                server_name, proc.restart_count, error,
            )
            if self._pool is not None:
                try:
                    async with self._pool.acquire() as conn:
                        await conn.execute(
                            "UPDATE mcp_servers SET enabled = false WHERE id = $1::uuid",
                            server_id,
                        )
                except Exception as exc:
                    logger.warning("handle_crash: could not disable server %s: %s", server_id[:8], exc)
            return False

        # Increment restart counter and attempt respawn.
        proc.restart_count += 1
        logger.warning(
            "MCP server %r crashed (restart %d/%d): %s — respawning",
            server_name, proc.restart_count, _MAX_RESTARTS_IN_WINDOW, error,
        )

        meta = self._server_meta.get(server_name)
        if meta is None:
            logger.error("handle_crash: no meta for %r, cannot restart", server_name)
            return False

        try:
            new_proc = await self._spawn(
                server_id=server_id,
                command=meta["command"],
                args=meta["args"],
                raw_env=meta["env"],
                cwd=meta.get("cwd"),
            )
            new_proc.restart_count = proc.restart_count
            new_proc.restart_window_start = proc.restart_window_start
            self._processes[server_name] = new_proc
        except Exception as spawn_exc:
            logger.error("handle_crash: respawn of %r failed: %s", server_name, spawn_exc)
            return False

        if self._pool is not None:
            try:
                async with self._pool.acquire() as conn:
                    await conn.execute(
                        "UPDATE mcp_servers SET last_started = now() WHERE id = $1::uuid",
                        server_id,
                    )
            except Exception as exc:
                logger.warning("handle_crash: could not update last_started for %s: %s", server_id[:8], exc)

        return True

    def get_process(self, server_name: str) -> "MCPProcess | None":
        """Return the tracked MCPProcess for *server_name*, or None if unknown."""
        return self._processes.get(server_name)

    def register_server_meta(
        self,
        server_name: str,
        server_id: str,
        command: str,
        args: list[str],
        raw_env: dict,
        cwd: str | None,
    ) -> None:
        """Register server metadata so ensure_running can look it up without a DB call.

        Call this whenever a new server is created or restarted from the router,
        before calling ensure_running.  Keeps router code from reaching into
        private dicts directly.
        """
        self._server_ids[server_name] = server_id
        self._server_meta[server_name] = {
            "command": command,
            "args": args,
            "env": raw_env,
            "cwd": cwd,
        }

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
        self.register_server_meta(server_name, server_id, command, args, raw_env, cwd)
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
