import json
import logging
import struct

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from . import stt, tts
from .config import settings

logger = logging.getLogger(__name__)
router = APIRouter(tags=["voice"])


class TTSRequest(BaseModel):
    text: str
    voice: str = "nova"


@router.get("/providers")
async def list_providers():
    from .secrets_client import resolve

    has_openai = bool(await resolve("openai_api_key"))
    return {
        "stt": [
            {
                "name": "openai-whisper",
                "available": has_openai,
                "streaming": False,
                "note": "buffers audio then transcribes; true streaming via Deepgram is post-MVP",
            }
        ],
        "tts": [
            {
                "name": "openai-tts",
                "available": has_openai,
                "streaming": True,
                "voices": ["alloy", "echo", "fable", "onyx", "nova", "shimmer"],
            }
        ],
    }


@router.post("/stt/stream")
async def stt_stream(request: Request):
    """Buffer incoming audio bytes, transcribe, return SSE.

    Always returns 200 + SSE — errors are surfaced as SSE events so callers
    handle them uniformly.
    """
    audio = await request.body()

    async def generate():
        try:
            text = await stt.transcribe(audio)
            yield f"data: {json.dumps({'text': text, 'is_final': True})}\n\n"
        except Exception as exc:
            logger.warning("STT failed: %s", exc)
            yield f"data: {json.dumps({'text': '', 'is_final': True, 'error': str(exc)})}\n\n"

    return StreamingResponse(generate(), media_type="text/event-stream")


@router.post("/tts/stream")
async def tts_stream(body: TTSRequest):
    """Stream TTS audio chunks with 4-byte big-endian sequence-number prefix per chunk."""
    if body.voice not in tts.VALID_VOICES:
        raise HTTPException(
            status_code=400,
            detail=f"Invalid voice '{body.voice}'. Valid: {sorted(tts.VALID_VOICES)}",
        )

    seq = 0

    async def generate():
        nonlocal seq
        try:
            async for chunk in tts.synthesize_stream(body.text, body.voice):
                prefix = struct.pack(">I", seq)
                seq += 1
                yield prefix + chunk
        except Exception as exc:
            logger.warning("TTS failed: %s", exc)
            return

    return StreamingResponse(generate(), media_type="audio/opus")
