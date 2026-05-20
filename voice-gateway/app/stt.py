"""STT via OpenAI Whisper.

Buffers all incoming chunks and sends one transcription request.
True streaming STT (Deepgram) is post-MVP.
"""
import logging

import httpx

from .secrets_client import resolve

logger = logging.getLogger(__name__)

OPENAI_TRANSCRIBE_URL = "https://api.openai.com/v1/audio/transcriptions"


async def transcribe(audio_bytes: bytes) -> str:
    """Send buffered audio to OpenAI Whisper. Returns transcript text."""
    api_key = await resolve("openai_api_key")
    if not api_key:
        raise RuntimeError("openai_api_key not configured — STT unavailable")
    if len(audio_bytes) < 100:
        raise ValueError("Audio too short to transcribe")

    async with httpx.AsyncClient(timeout=60.0) as client:
        r = await client.post(
            OPENAI_TRANSCRIBE_URL,
            headers={"Authorization": f"Bearer {api_key}"},
            files={"file": ("audio.webm", audio_bytes, "audio/webm")},
            data={"model": "whisper-1", "language": "en"},
        )
        r.raise_for_status()
        return r.json()["text"]
