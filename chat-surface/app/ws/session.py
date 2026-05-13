from __future__ import annotations
import logging
from fastapi import WebSocket

logger = logging.getLogger(__name__)


class WebSocketSession:
    def __init__(self, ws: WebSocket, session_id: str):
        self.ws = ws
        self.session_id = session_id
        self.task_id: str | None = None
        self.is_audio_owner: bool = False
        self.tts_cancelled: bool = False

    async def send_json(self, data: dict) -> None:
        try:
            await self.ws.send_json(data)
        except Exception as exc:
            logger.debug("send_json failed session=%s: %s", self.session_id, exc)

    async def send_bytes(self, data: bytes) -> None:
        try:
            await self.ws.send_bytes(data)
        except Exception as exc:
            logger.debug("send_bytes failed session=%s: %s", self.session_id, exc)
