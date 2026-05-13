from __future__ import annotations

import json
import logging
from typing import AsyncGenerator

import httpx

from app.ws.session import WebSocketSession

logger = logging.getLogger(__name__)


async def _stt_stream(audio_bytes: bytes, http_voice: httpx.AsyncClient) -> AsyncGenerator[dict, None]:
    async with http_voice.stream(
        "POST",
        "/stt/stream",
        content=audio_bytes,
        headers={"Content-Type": "audio/webm"},
    ) as resp:
        resp.raise_for_status()
        async for line in resp.aiter_lines():
            if line.startswith("data: "):
                yield json.loads(line.removeprefix("data: "))


async def _llm_stream(text: str, http_agent: httpx.AsyncClient, task_id: str) -> AsyncGenerator[str, None]:
    async with http_agent.stream(
        "POST",
        f"/api/v1/tasks/{task_id}/message",
        json={"text": text},
    ) as resp:
        resp.raise_for_status()
        async for line in resp.aiter_lines():
            if line:
                try:
                    data = json.loads(line)
                    yield data.get("text", "")
                except json.JSONDecodeError:
                    pass


async def _tts_stream(text: str, http_voice: httpx.AsyncClient) -> AsyncGenerator[bytes, None]:
    async with http_voice.stream(
        "POST",
        "/tts/stream",
        json={"text": text, "voice": "alloy"},
    ) as resp:
        resp.raise_for_status()
        async for chunk in resp.aiter_bytes(chunk_size=4096):
            yield chunk


async def run_voice_turn(
    session: WebSocketSession,
    audio_bytes: bytes,
    http_agent: httpx.AsyncClient,
    http_voice: httpx.AsyncClient,
) -> None:
    task_id = session.task_id

    # Phase 1: STT
    transcript = ""
    async for fragment in _stt_stream(audio_bytes, http_voice):
        if not fragment.get("is_final"):
            await session.send_json({"type": "transcript_partial", "text": fragment["text"]})
        else:
            transcript = fragment["text"]
            await session.send_json({"type": "transcript_final", "text": transcript})

    if not transcript:
        return

    # Phase 2: LLM
    response_text = ""
    async for chunk in _llm_stream(transcript, http_agent, task_id):
        response_text += chunk
        await session.send_json({"type": "response_chunk", "text": chunk, "task_id": task_id})
    await session.send_json({"type": "response_final", "text": response_text, "task_id": task_id})

    # Phase 3: TTS (skip on barge-in or non-audio-owner)
    if session.tts_cancelled or not session.is_audio_owner:
        return

    async for audio_chunk in _tts_stream(response_text, http_voice):
        if session.tts_cancelled:
            break
        await session.send_bytes(audio_chunk)

    if not session.tts_cancelled:
        await session.send_json({"type": "audio_final"})
