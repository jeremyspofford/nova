# Stub — replaced in Task 5
from __future__ import annotations
import logging
from .session import WebSocketSession

logger = logging.getLogger(__name__)


class SessionManager:
    def __init__(self):
        self._sessions: dict[str, WebSocketSession] = {}

    def add(self, session: WebSocketSession) -> None:
        self._sessions[session.session_id] = session

    def remove(self, session_id: str) -> None:
        self._sessions.pop(session_id, None)

    async def broadcast_to_task(self, task_id: str, message: dict, exclude_sid: str | None = None) -> None:
        for sid, session in list(self._sessions.items()):
            if session.task_id == task_id and sid != exclude_sid:
                await session.send_json(message)

    async def send_audio_to_owner(self, task_id: str, data: bytes) -> None:
        for session in self._sessions.values():
            if session.task_id == task_id and session.is_audio_owner and not session.tts_cancelled:
                await session.send_bytes(data)
                return

    def claim_audio(self, session_id: str, task_id: str) -> None:
        for session in self._sessions.values():
            if session.task_id == task_id:
                session.is_audio_owner = (session.session_id == session_id)
