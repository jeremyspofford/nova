"""TTS via OpenAI TTS streaming.

Yields Opus audio chunks. The 4-byte sequence-number prefix is added by
the router — not here — to keep this module testable in isolation.
"""
import logging
from typing import AsyncIterator

import httpx

from .secrets_client import resolve

logger = logging.getLogger(__name__)

OPENAI_TTS_URL = "https://api.openai.com/v1/audio/speech"

VALID_VOICES = {"alloy", "echo", "fable", "onyx", "nova", "shimmer"}


async def synthesize_stream(text: str, voice: str = "nova") -> AsyncIterator[bytes]:
    """Yield audio chunks from OpenAI TTS (response_format=opus)."""
    api_key = await resolve("openai_api_key")
    if not api_key:
        raise RuntimeError("openai_api_key not configured — TTS unavailable")

    if voice not in VALID_VOICES:
        raise ValueError(f"Invalid voice '{voice}'. Valid voices: {sorted(VALID_VOICES)}")

    async with httpx.AsyncClient(timeout=60.0) as client:
        async with client.stream(
            "POST",
            OPENAI_TTS_URL,
            headers={"Authorization": f"Bearer {api_key}"},
            json={
                "model": "tts-1",
                "input": text,
                "voice": voice,
                "response_format": "opus",
            },
        ) as response:
            response.raise_for_status()
            async for chunk in response.aiter_bytes(chunk_size=4096):
                yield chunk
