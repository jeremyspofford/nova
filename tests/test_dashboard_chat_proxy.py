"""Integration tests for dashboard → backend proxy wiring.

Verifies that the nginx-served dashboard (port 3000) correctly proxies:
  - /api/*  → agent-core (port 8000)
  - /ws     → chat-surface (port 8004)

Tests are written against the PRODUCTION path (port 3000) so they exercise
the nginx config that ships in the Docker image. Run `./start` before running.
"""
from __future__ import annotations

import asyncio
import json
import os
import uuid

import httpx
import pytest
import websockets
from dotenv import dotenv_values

DASHBOARD = "http://localhost:3000"
WS_URL = "ws://localhost:3000/ws"

# Load from the project .env so tests work regardless of host shell exports.
_env = dotenv_values(os.path.join(os.path.dirname(__file__), "..", ".env"))
ADMIN_SECRET = _env.get("NOVA_ADMIN_SECRET") or os.getenv("NOVA_ADMIN_SECRET", "nova-dev-secret")


class TestDashboardApiProxy:
    def test_api_proxied_through_dashboard(self):
        """GET /api/v1/mcp/servers through nginx should reach agent-core, not the SPA."""
        r = httpx.get(
            f"{DASHBOARD}/api/v1/mcp/servers",
            headers={"x-admin-secret": ADMIN_SECRET},
            timeout=5.0,
        )
        assert r.status_code == 200, (
            f"Expected 200 from /api proxy, got {r.status_code}. "
            "nginx.conf is likely missing the /api proxy_pass block."
        )
        # nginx try_files fallback returns text/html (the SPA) for unknown paths;
        # a working proxy must return JSON from agent-core.
        ct = r.headers.get("content-type", "")
        assert ct.startswith("application/json"), (
            f"Expected application/json from agent-core, got '{ct}'. "
            "nginx is serving the SPA fallback instead of proxying to agent-core."
        )


class TestDashboardWebSocketProxy:
    async def test_websocket_connects_through_dashboard(self):
        """WebSocket /ws through nginx should reach chat-surface."""
        try:
            async with websockets.connect(
                f"{WS_URL}?secret={ADMIN_SECRET}",
                open_timeout=10,
            ) as ws:
                await ws.send(json.dumps({"type": "connect"}))
                raw = await asyncio.wait_for(ws.recv(), timeout=10)
                msg = json.loads(raw)
                assert msg.get("type") == "connected", (
                    f"Expected 'connected' ack from chat-surface, got: {msg}. "
                    "nginx.conf is likely missing the /ws proxy_pass block."
                )
                assert "task_id" in msg
        except (ConnectionRefusedError, OSError, websockets.exceptions.WebSocketException) as exc:
            pytest.fail(
                f"WebSocket connection to {WS_URL} failed: {exc}. "
                "nginx.conf is likely missing the WebSocket proxy block."
            )

    async def test_chat_message_produces_response(self):
        """Sending a message through the full proxy path should stream a response."""
        task_id = str(uuid.uuid4())
        chunks: list[str] = []

        try:
            async with websockets.connect(
                f"{WS_URL}?secret={ADMIN_SECRET}",
                open_timeout=10,
            ) as ws:
                await ws.send(json.dumps({"type": "connect", "resume_task_id": task_id}))
                connected = json.loads(await asyncio.wait_for(ws.recv(), timeout=10))
                assert connected["type"] == "connected"

                await ws.send(json.dumps({
                    "type": "message",
                    "task_id": task_id,
                    "text": "Reply with exactly one word: hello",
                }))

                # Collect events until response_final or timeout
                deadline = asyncio.get_event_loop().time() + 30
                while asyncio.get_event_loop().time() < deadline:
                    try:
                        raw = await asyncio.wait_for(ws.recv(), timeout=5)
                    except asyncio.TimeoutError:
                        break
                    evt = json.loads(raw)
                    if evt.get("type") == "response_chunk":
                        chunks.append(evt.get("text", ""))
                    elif evt.get("type") == "response_final":
                        break

        except (ConnectionRefusedError, OSError, websockets.exceptions.WebSocketException) as exc:
            pytest.fail(f"WebSocket connection failed: {exc}")

        assert len(chunks) > 0, "No response_chunk events received — LLM response did not stream through"
        full_response = "".join(chunks)
        assert len(full_response) > 0, "Received response_chunk events but all were empty"
