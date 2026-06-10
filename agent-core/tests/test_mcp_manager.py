"""Tests for MCPManager — restart windowing logic and spawn delegation."""
import asyncio
from datetime import datetime, timedelta, timezone
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

# ── Helpers ──────────────────────────────────────────────────────────────────

def _dead_client():
    """Simulate a crashed subprocess client."""
    client = MagicMock()
    client.process.returncode = 1   # non-None → dead
    return client


def _alive_client():
    """Simulate a healthy subprocess client."""
    client = MagicMock()
    client.process.returncode = None  # None → alive
    return client


def _make_proc(client, restart_count=0, window_offset_s=0):
    from app.tools.mcp.manager import MCPProcess
    now = datetime.now(timezone.utc) - timedelta(seconds=window_offset_s)
    return MCPProcess(
        client=client,
        lock=asyncio.Lock(),
        restart_count=restart_count,
        restart_window_start=now,
    )


# ── _classify_restart unit tests ──────────────────────────────────────────────

class TestClassifyRestart:
    def test_allows_first_crash(self):
        from app.tools.mcp.manager import _classify_restart
        now = datetime.now(timezone.utc)
        result = _classify_restart(restart_count=0, window_start=now, now=now)
        assert result == "restart"

    def test_allows_up_to_max_restarts(self):
        from app.tools.mcp.manager import _MAX_RESTARTS_IN_WINDOW, _classify_restart
        now = datetime.now(timezone.utc)
        result = _classify_restart(
            restart_count=_MAX_RESTARTS_IN_WINDOW - 1,
            window_start=now,
            now=now,
        )
        assert result == "restart"

    def test_disables_on_4th_crash(self):
        from app.tools.mcp.manager import _MAX_RESTARTS_IN_WINDOW, _classify_restart
        now = datetime.now(timezone.utc)
        result = _classify_restart(
            restart_count=_MAX_RESTARTS_IN_WINDOW,
            window_start=now,
            now=now,
        )
        assert result == "disable"

    def test_allows_restart_after_window_expires(self):
        from app.tools.mcp.manager import (
            _MAX_RESTARTS_IN_WINDOW,
            _RESTART_WINDOW_SECONDS,
            _classify_restart,
        )
        now = datetime.now(timezone.utc)
        # window_start is far in the past — window has expired
        old_start = now - timedelta(seconds=_RESTART_WINDOW_SECONDS + 1)
        result = _classify_restart(
            restart_count=_MAX_RESTARTS_IN_WINDOW,
            window_start=old_start,
            now=now,
        )
        assert result == "restart"


# ── MCPManager.ensure_running ──────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_ensure_running_starts_new_server():
    from app.tools.mcp.manager import MCPManager

    manager = MCPManager()
    alive = _alive_client()

    with patch("app.tools.mcp.manager.start_server", new=AsyncMock()) as mock_start, \
         patch("app.tools.mcp.manager.mcp_client.get_client", return_value=alive), \
         patch("app.tools.mcp.manager.resolve_env", new=AsyncMock(return_value={})):

        await manager.register_server(
            server_id="srv-1",
            server_name="my-server",
            command="node",
            args=["server.js"],
            raw_env={},
            cwd=None,
        )

    mock_start.assert_awaited_once()
    proc = manager._processes["my-server"]
    assert proc.is_alive()


@pytest.mark.asyncio
async def test_ensure_running_returns_alive_without_respawn():
    from app.tools.mcp.manager import MCPManager

    manager = MCPManager()
    alive = _alive_client()

    with patch("app.tools.mcp.manager.start_server", new=AsyncMock()), \
         patch("app.tools.mcp.manager.mcp_client.get_client", return_value=alive), \
         patch("app.tools.mcp.manager.resolve_env", new=AsyncMock(return_value={})):

        await manager.register_server("srv-1", "my-server", "node", [], {}, None)

    with patch("app.tools.mcp.manager.start_server", new=AsyncMock()) as mock_start2, \
         patch("app.tools.mcp.manager.mcp_client.get_client", return_value=alive):
        proc = await manager.ensure_running("srv-1", "my-server")

    mock_start2.assert_not_awaited()
    assert proc.is_alive()


@pytest.mark.asyncio
async def test_ensure_running_respawns_dead_server():
    from app.tools.mcp.manager import MCPManager

    manager = MCPManager()
    dead = _dead_client()
    alive = _alive_client()

    with patch("app.tools.mcp.manager.start_server", new=AsyncMock()), \
         patch("app.tools.mcp.manager.mcp_client.get_client", return_value=dead), \
         patch("app.tools.mcp.manager.resolve_env", new=AsyncMock(return_value={})):

        await manager.register_server("srv-1", "my-server", "node", [], {}, None)

    with patch("app.tools.mcp.manager.start_server", new=AsyncMock()) as mock_restart, \
         patch("app.tools.mcp.manager.mcp_client.get_client", return_value=alive), \
         patch("app.tools.mcp.manager.resolve_env", new=AsyncMock(return_value={})):
        proc = await manager.ensure_running("srv-1", "my-server")

    mock_restart.assert_awaited_once()
    assert proc.client is alive


@pytest.mark.asyncio
async def test_ensure_running_raises_for_unknown_server():
    from app.tools.mcp.manager import MCPManager

    manager = MCPManager()
    with pytest.raises(RuntimeError, match="unknown server"):
        await manager.ensure_running("srv-99", "does-not-exist")


# ── MCPManager.handle_crash ────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_handle_crash_returns_true_and_respawns():
    """First crash within window: handle_crash returns True and spawns new proc."""
    from app.tools.mcp.manager import MCPManager

    manager = MCPManager()
    dead = _dead_client()
    alive = _alive_client()

    with patch("app.tools.mcp.manager.start_server", new=AsyncMock()), \
         patch("app.tools.mcp.manager.mcp_client.get_client", return_value=dead), \
         patch("app.tools.mcp.manager.resolve_env", new=AsyncMock(return_value={})):
        await manager.register_server("srv-1", "my-server", "node", [], {}, None)

    with patch("app.tools.mcp.manager.start_server", new=AsyncMock()), \
         patch("app.tools.mcp.manager.mcp_client.get_client", return_value=alive), \
         patch("app.tools.mcp.manager.resolve_env", new=AsyncMock(return_value={})):
        result = await manager.handle_crash("srv-1", "my-server", "process exited with code 1")

    assert result is True
    assert manager._processes["my-server"].client is alive


@pytest.mark.asyncio
async def test_handle_crash_returns_false_after_too_many_crashes():
    """After exceeding restart limit, handle_crash returns False."""
    from app.tools.mcp.manager import _MAX_RESTARTS_IN_WINDOW, MCPManager

    manager = MCPManager()
    dead = _dead_client()

    # Pre-populate with a dead proc that has exhausted its restart budget.
    proc = _make_proc(dead, restart_count=_MAX_RESTARTS_IN_WINDOW)
    manager._processes["my-server"] = proc
    manager._server_ids["my-server"] = "srv-1"
    manager._server_meta["my-server"] = {"command": "node", "args": [], "env": {}, "cwd": None}

    result = await manager.handle_crash("srv-1", "my-server", "crashed again")
    assert result is False


@pytest.mark.asyncio
async def test_handle_crash_resets_counter_after_window_expires():
    """A crash outside the window resets the counter and returns True."""
    from app.tools.mcp.manager import (
        _MAX_RESTARTS_IN_WINDOW,
        _RESTART_WINDOW_SECONDS,
        MCPManager,
    )

    manager = MCPManager()
    dead = _dead_client()
    alive = _alive_client()

    # Pre-populate with a dead proc that is at the limit but window is expired.
    proc = _make_proc(dead, restart_count=_MAX_RESTARTS_IN_WINDOW, window_offset_s=_RESTART_WINDOW_SECONDS + 1)
    manager._processes["my-server"] = proc
    manager._server_ids["my-server"] = "srv-1"
    manager._server_meta["my-server"] = {"command": "node", "args": [], "env": {}, "cwd": None}

    with patch("app.tools.mcp.manager.start_server", new=AsyncMock()), \
         patch("app.tools.mcp.manager.mcp_client.get_client", return_value=alive), \
         patch("app.tools.mcp.manager.resolve_env", new=AsyncMock(return_value={})):
        result = await manager.handle_crash("srv-1", "my-server", "crash after window")

    assert result is True
    # Counter should have been reset to 0, then incremented to 1.
    assert manager._processes["my-server"].restart_count == 1


# ── MCPManager.shutdown_all ────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_shutdown_all_stops_all_servers():
    from app.tools.mcp.manager import MCPManager

    manager = MCPManager()
    alive = _alive_client()

    with patch("app.tools.mcp.manager.start_server", new=AsyncMock()), \
         patch("app.tools.mcp.manager.mcp_client.get_client", return_value=alive), \
         patch("app.tools.mcp.manager.resolve_env", new=AsyncMock(return_value={})):

        await manager.register_server("srv-1", "srv-a", "node", [], {}, None)
        await manager.register_server("srv-2", "srv-b", "python", [], {}, None)

    with patch("app.tools.mcp.manager.stop_server", new=AsyncMock()) as mock_stop:
        await manager.shutdown_all()

    assert mock_stop.await_count == 2
    assert manager._processes == {}
