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
    raw: bool = False  # True = plain mp3, no seq-number prefix (dashboard use)


@router.get("/providers")
async def list_providers():
    from .secrets_client import resolve

    has_openai = bool(await resolve("openai_api_key"))
    status = "available" if has_openai else "unconfigured"
    return [
        {"name": "openai-whisper", "type": "stt", "status": status},
        {"name": "openai-tts", "type": "tts", "status": status},
    ]


@router.post("/stt/stream")
async def stt_stream(request: Request):
    """Buffer incoming audio bytes, transcribe, return SSE.

    Returns 400 for empty body. For non-empty bodies always returns 200 + SSE
    — errors are surfaced as SSE events so callers handle them uniformly.
    """
    audio = await request.body()
    if not audio:
        raise HTTPException(status_code=400, detail="Empty audio body")

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
    from .secrets_client import resolve

    # Pre-flight: validate text
    if not body.text or not body.text.strip():
        raise HTTPException(status_code=400, detail="text must not be empty")

    # Pre-flight: validate voice
    if body.voice not in tts.VALID_VOICES:
        raise HTTPException(
            status_code=400,
            detail=f"Invalid voice '{body.voice}'. Valid: {sorted(tts.VALID_VOICES)}",
        )

    # Pre-flight: verify key is available before starting stream
    if not await resolve("openai_api_key"):
        raise HTTPException(status_code=503, detail="openai_api_key not configured — TTS unavailable")

    if body.raw:
        # Dashboard path: clean MP3 stream, no sequence prefix, browser-playable
        async def generate_raw():
            try:
                async for chunk in tts.synthesize_stream(body.text, body.voice, "mp3"):
                    yield chunk
            except Exception as exc:
                logger.warning("TTS failed: %s", exc)

        return StreamingResponse(generate_raw(), media_type="audio/mpeg")

    # WebSocket bridge path: Opus with 4-byte big-endian sequence prefix per chunk
    seq = 0

    async def generate():
        nonlocal seq
        try:
            async for chunk in tts.synthesize_stream(body.text, body.voice, "opus"):
                prefix = struct.pack(">I", seq)
                seq += 1
                yield prefix + chunk
        except Exception as exc:
            logger.warning("TTS failed: %s", exc)
            return

    return StreamingResponse(generate(), media_type="audio/opus")
