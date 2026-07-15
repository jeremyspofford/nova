"""Voice API — spoken replies (TTS) + push-to-talk transcription (STT).

Plan: docs/plans/voice.md. Phase 1: the frontend sentence-buffers the chat
SSE deltas and calls /tts per sentence. Phase 2: a recorded push-to-talk
utterance is POSTed to /transcribe, proxied to whisper.

    POST /api/v1/voice/tts        {"text": ..., "voice"?, "speed"?}
                                  -> audio/wav (24 kHz mono s16le)
    GET  /api/v1/voice/health     -> kokoro status + voice list (Settings UI)
    POST /api/v1/voice/transcribe (raw audio body) -> {"text", "language"}
"""

import logging

import httpx
from fastapi import APIRouter, HTTPException, Request
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
_STT_UNREACHABLE = (
    "STT engine unreachable at {url} — is the voice profile running? "
    "(docker compose --profile voice up -d whisper)"
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


@router.post("/api/v1/voice/transcribe")
async def transcribe(request: Request):
    """Proxy a recorded push-to-talk utterance to whisper. The browser sends
    the raw MediaRecorder blob (webm/opus, mp4, …); whisper's PyAV decodes it."""
    audio = await request.body()
    if not audio:
        raise HTTPException(status_code=400, detail="no audio")
    content_type = request.headers.get("content-type", "application/octet-stream")
    try:
        # generous timeout covers first-call model download/warmup
        async with httpx.AsyncClient(timeout=120) as client:
            r = await client.post(f"{settings.whisper_url}/transcribe",
                                  content=audio,
                                  headers={"content-type": content_type})
    except httpx.HTTPError as e:
        raise HTTPException(
            status_code=503,
            detail=_STT_UNREACHABLE.format(url=settings.whisper_url) + f" ({e})")
    if r.status_code != 200:
        detail = r.text[:300]
        log.warning("whisper /transcribe %s: %s", r.status_code, detail)
        raise HTTPException(status_code=r.status_code, detail=f"STT engine: {detail}")
    return r.json()
