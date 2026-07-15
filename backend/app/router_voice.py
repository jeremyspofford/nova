"""Voice API — phase 1: spoken replies (TTS only).

Plan: docs/plans/voice.md. The frontend sentence-buffers the chat SSE
deltas and calls /tts per sentence; later phases add the mic WebSocket.

    POST /api/v1/voice/tts    {"text": ..., "voice"?: ..., "speed"?: ...}
                              -> audio/wav (24 kHz mono s16le)
    GET  /api/v1/voice/health -> kokoro status + voice list (Settings UI)
"""

import logging

import httpx
from fastapi import APIRouter, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel

from app import settings_store
from app.config import settings

log = logging.getLogger(__name__)

router = APIRouter()

_UNREACHABLE = (
    "TTS engine unreachable at {url} — is the voice profile running? "
    "(docker compose --profile voice up -d kokoro)"
)


class TTSRequest(BaseModel):
    text: str
    voice: str | None = None
    speed: float | None = None


@router.get("/api/v1/voice/health")
async def voice_health():
    try:
        async with httpx.AsyncClient(timeout=3) as client:
            r = await client.get(f"{settings.kokoro_url}/health")
            return r.json()
    except httpx.HTTPError as e:
        return {"status": "unreachable",
                "detail": _UNREACHABLE.format(url=settings.kokoro_url),
                "error": str(e), "voices": []}


@router.post("/api/v1/voice/tts")
async def tts(req: TTSRequest):
    text = req.text.strip()
    if not text:
        raise HTTPException(status_code=400, detail="text is empty")
    payload = {
        "text": text[:2000],
        "voice": req.voice or settings_store.get("voice.tts_voice"),
        "speed": req.speed or settings_store.get("voice.tts_speed"),
    }
    try:
        # sentence-sized texts synthesize in well under a second on CPU;
        # the generous timeout covers first-call model warmup
        async with httpx.AsyncClient(timeout=60) as client:
            r = await client.post(f"{settings.kokoro_url}/tts", json=payload)
    except httpx.HTTPError as e:
        raise HTTPException(
            status_code=503,
            detail=_UNREACHABLE.format(url=settings.kokoro_url) + f" ({e})")
    if r.status_code != 200:
        detail = r.text[:300]
        log.warning("kokoro /tts %s: %s", r.status_code, detail)
        raise HTTPException(status_code=r.status_code, detail=f"TTS engine: {detail}")
    return Response(content=r.content, media_type="audio/wav")
