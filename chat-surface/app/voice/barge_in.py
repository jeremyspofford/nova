from __future__ import annotations

import asyncio
import logging

from app.ws.session import WebSocketSession

logger = logging.getLogger(__name__)


async def handle_barge_in(session: WebSocketSession, task_id: str, http_agent) -> None:
    await session.send_json({"type": "stop_audio"})
    session.tts_cancelled = True

    async def _cancel_agent():
        try:
            await http_agent.post(f"/api/v1/tasks/{task_id}/cancel")
        except Exception as exc:
            logger.debug("agent cancel failed: %s", exc)

    asyncio.create_task(_cancel_agent())
    logger.info("barge_in: session=%s task=%s", session.session_id, task_id)
