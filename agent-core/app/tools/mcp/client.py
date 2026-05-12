"""Stdio MCP client — speaks JSON-RPC line-framed over a child process."""
import asyncio
import json
import logging
from typing import Any

logger = logging.getLogger(__name__)


class StdioMCPClient:
    """Minimal JSON-RPC client over a child process's stdio."""

    def __init__(self, process: asyncio.subprocess.Process):
        self.process = process
        self._req_id = 0
        self._pending: dict[int, asyncio.Future] = {}
        self._reader_task: asyncio.Task | None = None
        self._lock = asyncio.Lock()

    async def start(self) -> None:
        """Initialize the JSON-RPC channel and reader task."""
        self._reader_task = asyncio.create_task(self._read_loop())
        # Initialize handshake (per MCP spec). Best-effort — if server doesn't
        # implement, list_tools will still work for compliant servers.
        try:
            await self._call("initialize", {
                "protocolVersion": "2024-11-05",
                "capabilities": {},
                "clientInfo": {"name": "nova-agent-core", "version": "2.0.0"},
            })
        except Exception as exc:
            logger.warning("MCP initialize failed (continuing): %s", exc)

    async def list_tools(self) -> list[dict]:
        """Return the server's tool schemas."""
        resp = await self._call("tools/list", {})
        return resp.get("tools", [])

    async def call_tool(self, tool_name: str, arguments: dict) -> Any:
        """Invoke a tool on the remote server."""
        return await self._call("tools/call", {"name": tool_name, "arguments": arguments})

    async def close(self) -> None:
        if self._reader_task and not self._reader_task.done():
            self._reader_task.cancel()
        try:
            self.process.terminate()
            await asyncio.wait_for(self.process.wait(), timeout=5.0)
        except (asyncio.TimeoutError, ProcessLookupError):
            try:
                self.process.kill()
            except ProcessLookupError:
                pass

    async def _call(self, method: str, params: dict) -> Any:
        async with self._lock:
            self._req_id += 1
            req_id = self._req_id

        future: asyncio.Future = asyncio.get_running_loop().create_future()
        self._pending[req_id] = future

        request = {"jsonrpc": "2.0", "id": req_id, "method": method, "params": params}
        if self.process.stdin is None:
            raise RuntimeError("MCP subprocess stdin is None")
        self.process.stdin.write((json.dumps(request) + "\n").encode())
        await self.process.stdin.drain()

        try:
            result = await asyncio.wait_for(future, timeout=60.0)
        except asyncio.TimeoutError:
            self._pending.pop(req_id, None)
            raise

        if "error" in result:
            err = result["error"]
            raise RuntimeError(f"MCP error: {err.get('message', err)}")
        return result.get("result", {})

    async def _read_loop(self) -> None:
        if self.process.stdout is None:
            return
        while True:
            try:
                line = await self.process.stdout.readline()
            except Exception:
                break
            if not line:
                break
            try:
                msg = json.loads(line.decode().strip())
            except Exception as exc:
                logger.warning("MCP unparseable line: %s (%s)", line[:100], exc)
                continue
            rid = msg.get("id")
            if rid is not None and rid in self._pending:
                fut = self._pending.pop(rid)
                if not fut.done():
                    if "error" in msg:
                        fut.set_exception(RuntimeError(str(msg["error"])))
                    else:
                        fut.set_result(msg.get("result"))
        # Subprocess exited — reject all waiting callers immediately
        for fut in list(self._pending.values()):
            if not fut.done():
                fut.set_exception(RuntimeError("MCP subprocess exited"))
        self._pending.clear()


# Module-level registry of active clients keyed by server_id
_clients: dict[str, StdioMCPClient] = {}


def get_client(server_id: str) -> StdioMCPClient | None:
    return _clients.get(server_id)


def set_client(server_id: str, client: StdioMCPClient) -> None:
    _clients[server_id] = client


def remove_client(server_id: str) -> StdioMCPClient | None:
    return _clients.pop(server_id, None)


async def call_tool(server_id: str, tool_name: str, arguments: dict, ctx) -> Any:
    """Module-level dispatcher used by tools.dispatcher._invoke for MCP-sourced tools."""
    client = _clients.get(server_id)
    if client is None:
        raise RuntimeError(f"MCP server {server_id} not connected")
    return await client.call_tool(tool_name, arguments)
