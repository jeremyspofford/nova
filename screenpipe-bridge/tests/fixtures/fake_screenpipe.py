"""Minimal Starlette server that mimics screenpipe's /ws/events and /search.

Tests construct a `FakeScreenpipe`, push events via .emit_*(), and the bridge
under test connects to it as if it were a real screenpipe daemon.

Field names mirror screenpipe-engine routes/websocket.rs and routes/search.rs:
- WebSocket events: Event { name: String, data: Value }
- OCR search results: OCRContent { frame_id, text, timestamp, file_path,
  offset_index, app_name, window_name, tags, frame, frame_name, browser_url,
  focused, device_name }
- Search response: SearchResponse { data: Vec<ContentItem>, pagination: PaginationInfo }
"""

import asyncio
import json
import uuid
from datetime import datetime, timezone
from typing import Any

import uvicorn
from starlette.applications import Starlette
from starlette.requests import Request
from starlette.responses import JSONResponse
from starlette.routing import Route, WebSocketRoute
from starlette.websockets import WebSocket, WebSocketDisconnect


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


class FakeScreenpipe:
    def __init__(self, host: str = "127.0.0.1", port: int = 13030):
        self.host = host
        self.port = port
        self._events: list[dict[str, Any]] = []
        self._connections: list[WebSocket] = []
        self._auth_required: str | None = None
        self._server: uvicorn.Server | None = None
        self._task: asyncio.Task | None = None
        self._app = Starlette(
            routes=[
                WebSocketRoute("/ws/events", self._dispatch_ws),
                Route("/search", self._search_handler, methods=["GET"]),
            ]
        )

    @property
    def url(self) -> str:
        return f"http://{self.host}:{self.port}"

    @property
    def ws_url(self) -> str:
        return f"ws://{self.host}:{self.port}/ws/events"

    def require_auth(self, api_key: str) -> None:
        """Configure the fake to reject connections without a matching Bearer token."""
        self._auth_required = api_key

    async def start(self) -> None:
        config = uvicorn.Config(
            self._app, host=self.host, port=self.port,
            log_level="warning", lifespan="off"
        )
        self._server = uvicorn.Server(config)
        self._task = asyncio.create_task(self._server.serve())
        # Wait until ready
        for _ in range(50):
            await asyncio.sleep(0.05)
            if self._server.started:
                return
        raise RuntimeError("FakeScreenpipe failed to start")

    async def stop(self) -> None:
        if self._server:
            self._server.should_exit = True
        if self._task:
            try:
                await asyncio.wait_for(self._task, timeout=2.0)
            except (asyncio.TimeoutError, asyncio.CancelledError):
                pass

    async def emit_ocr(
        self,
        *,
        app_name: str,
        window_name: str,
        text: str,
        browser_url: str | None = None,
        timestamp: str | None = None,
    ) -> None:
        """Emit an ocr_result event over the WebSocket and add it to the search store.

        Field names match screenpipe-engine routes/websocket.rs (Event<Value>) and
        routes/content.rs (OCRContent): frame_id, app_name, window_name,
        browser_url, text, timestamp, focused.
        """
        event = {
            "name": "ocr_result",
            "data": {
                "frame_id": str(uuid.uuid4()),
                "app_name": app_name,
                "window_name": window_name,
                "browser_url": browser_url,
                "text": text,
                "timestamp": timestamp or _now_iso(),
                "focused": True,
            },
        }
        self._events.append(event)
        await self._broadcast(event)

    async def _dispatch_ws(self, websocket: WebSocket) -> None:
        """Indirection so tests can monkey-patch self._ws_handler at runtime."""
        await self._ws_handler(websocket)

    async def disconnect_all(self) -> None:
        """Force-close all active WebSocket connections."""
        for ws in list(self._connections):
            await ws.close()
        self._connections.clear()

    async def _broadcast(self, event: dict[str, Any]) -> None:
        for ws in list(self._connections):
            try:
                await ws.send_text(json.dumps(event))
            except Exception:
                pass

    async def _ws_handler(self, websocket: WebSocket) -> None:
        if self._auth_required:
            auth = websocket.headers.get("authorization", "")
            if auth != f"Bearer {self._auth_required}":
                await websocket.close(code=1008)
                return
        await websocket.accept()
        self._connections.append(websocket)
        try:
            while True:
                await websocket.receive_text()  # ignore client messages
        except WebSocketDisconnect:
            pass
        finally:
            if websocket in self._connections:
                self._connections.remove(websocket)

    async def _search_handler(self, request: Request) -> JSONResponse:
        if self._auth_required:
            auth = request.headers.get("authorization", "")
            if auth != f"Bearer {self._auth_required}":
                return JSONResponse({"error": "unauthorized"}, status_code=401)
        # Mirror screenpipe SearchResponse: { data: Vec<ContentItem>, pagination: PaginationInfo }
        # Each item uses the OCR ContentItem envelope: { type: "OCR", content: OCRContent }
        items = [
            {"type": "OCR", "content": e["data"]}
            for e in self._events
            if e.get("name") == "ocr_result"
        ]
        return JSONResponse({
            "data": items,
            "pagination": {
                "limit": 20,
                "offset": 0,
                "total": len(items),
            },
        })
