"""Voice API — spoken replies (TTS) + push-to-talk transcription (STT).

Plan: docs/plans/voice.md. Phase 1: the frontend sentence-buffers the chat
SSE deltas and calls /tts per sentence. Phase 2: a recorded push-to-talk
utterance is POSTed to /transcribe, proxied to whisper.

    POST /api/v1/voice/tts        {"text": ..., "voice"?, "speed"?}
                                  -> audio/wav (24 kHz mono s16le)
    GET  /api/v1/voice/health     -> kokoro status + voice list (Settings UI)
    POST /api/v1/voice/transcribe (raw audio body) -> {"text", "language",
                                   "speaker", "speaker_active"}
    POST /api/v1/voice/enroll?profile_id=… (raw audio) -> enrollment clip
    GET/POST /api/v1/profiles, PATCH/DELETE /api/v1/profiles/{id}

Speaker identification (docs/plans/speaker-id.md): transcribe also embeds
the same audio via whisper's /embed and cosine-matches enrolled household
voiceprints. Recognition failure of ANY kind degrades to speaker=null —
never to a failed transcription, and never to widened privileges.
"""

import logging

import httpx
from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import Response
from pydantic import BaseModel

from app import settings_store, voiceprints, wake_training
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
    out = r.json()
    out["speaker"], out["speaker_active"] = await _identify(audio, content_type)
    return out


async def _identify(audio: bytes, content_type: str) -> tuple[dict | None, bool]:
    """(speaker | None, whether recognition was live). Every failure path is
    (None, ...) — the tier can only narrow, so unknown is always safe."""
    try:
        if not settings_store.get("voice.speaker_id"):
            return None, False
        if await voiceprints.enrolled_count() == 0:
            return None, False
        async with httpx.AsyncClient(timeout=30) as client:
            r = await client.post(f"{settings.whisper_url}/embed",
                                  content=audio,
                                  headers={"content-type": content_type})
        if r.status_code != 200:
            log.warning("speaker embed failed: %s %s", r.status_code, r.text[:120])
            return None, True
        embedding = r.json().get("embedding")
        matched = await voiceprints.match(embedding)
        if matched is None:
            # stash for the introduce-yourself path: if Nova learns who this
            # is (remember_speaker), these become their first enrollment
            if embedding:
                voiceprints.remember_pending(embedding)
            return None, True
        # passive training: a decisively confident match keeps the print
        # current as voices drift — the extra bar over the match threshold
        # keeps borderline matches from reinforcing themselves
        if settings_store.get("voice.speaker_autotrain"):
            bar = float(settings_store.get("voice.speaker_threshold") or 0.55) + 0.15
            if matched["confidence"] >= bar:
                await voiceprints.add_enrollment(matched["id"], embedding)
        return ({"profile_id": matched["id"], "name": matched["name"],
                 "role": matched["role"], "confidence": matched["confidence"]},
                True)
    except Exception:
        log.exception("speaker identification failed; treating as unknown")
        return None, True


# ── household profiles + enrollment ─────────────────────────────────────────

class ProfileBody(BaseModel):
    name: str
    role: str = "guest"
    persona_notes: str | None = None


@router.get("/api/v1/profiles")
async def list_profiles_endpoint():
    return {"profiles": await voiceprints.list_profiles()}


@router.post("/api/v1/profiles")
async def create_profile_endpoint(body: ProfileBody):
    if not body.name.strip():
        raise HTTPException(status_code=422, detail="name required")
    try:
        return await voiceprints.create(body.name, body.role, body.persona_notes)
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))


@router.patch("/api/v1/profiles/{profile_id}")
async def update_profile_endpoint(profile_id: str, body: dict):
    try:
        row = await voiceprints.update(profile_id, body)
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))
    if row is None:
        raise HTTPException(status_code=404, detail="profile not found")
    return row


@router.delete("/api/v1/profiles/{profile_id}")
async def delete_profile_endpoint(profile_id: str):
    """Deletes the voiceprint with the profile — the whole biometric record."""
    if not await voiceprints.delete(profile_id):
        raise HTTPException(status_code=404, detail="profile not found")
    return {"deleted": True}


@router.post("/api/v1/voice/enroll")
async def enroll(request: Request, profile_id: str):
    """One enrollment clip: embed, fold into the profile's voiceprint,
    DISCARD the audio (never stored — docs/plans/speaker-id.md stance)."""
    audio = await request.body()
    if not audio:
        raise HTTPException(status_code=400, detail="no audio")
    content_type = request.headers.get("content-type", "application/octet-stream")
    try:
        async with httpx.AsyncClient(timeout=60) as client:
            r = await client.post(f"{settings.whisper_url}/embed",
                                  content=audio,
                                  headers={"content-type": content_type})
    except httpx.HTTPError as e:
        raise HTTPException(status_code=503,
                            detail=_STT_UNREACHABLE.format(url=settings.whisper_url) + f" ({e})")
    if r.status_code != 200:
        raise HTTPException(status_code=r.status_code,
                            detail=f"embedding failed: {r.text[:200]}")
    payload = r.json()
    if not payload.get("embedding"):
        raise HTTPException(status_code=422,
                            detail="clip too short — speak for a few seconds")
    row = await voiceprints.add_enrollment(profile_id, payload["embedding"])
    if row is None:
        raise HTTPException(status_code=404, detail="profile not found")
    return {"profile": row, "clip_secs": payload.get("secs")}


# ── wake-word learning: labelled clips from ordinary use (phase 5a) ─────────
# The gate is re-checked HERE, on every write, not just in the browser. A tab
# left open before the operator turned learning off must not go on recording
# the household because it never reloaded.


@router.post("/api/v1/voice/wake-clip")
async def wake_clip(request: Request, label: str, score: float = 0.0,
                    threshold: float = 0.0, phrase: str = "",
                    speaker: str = "", mic: str = "", secs: float = 0.0):
    """One labelled wake clip (raw WAV body). See app/wake_training.py."""
    if not settings_store.get("voice.wake_learning"):
        raise HTTPException(status_code=403,
                            detail="wake learning is off (Settings → Voice)")
    audio = await request.body()
    try:
        rec = wake_training.store(label, audio, {
            "score": score, "threshold": threshold, "phrase": phrase,
            "speaker": speaker, "mic": mic, "secs": secs,
        })
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))
    return rec


@router.get("/api/v1/voice/wake-clips")
async def list_wake_clips(limit: int = 100):
    out = wake_training.listing(limit=limit)
    out["enabled"] = bool(settings_store.get("voice.wake_learning"))
    return out


@router.get("/api/v1/voice/wake-clips/{clip_id}/audio")
async def wake_clip_audio(clip_id: str):
    """Play a clip back. "Browsable" has to mean you can HEAR what was kept —
    a count alone is not something an operator can consent to."""
    wav = wake_training.find(clip_id)
    if wav is None:
        raise HTTPException(status_code=404, detail="clip not found")
    return Response(content=wav.read_bytes(), media_type="audio/wav")


@router.delete("/api/v1/voice/wake-clips/{clip_id}")
async def delete_wake_clip(clip_id: str):
    if not wake_training.delete(clip_id):
        raise HTTPException(status_code=404, detail="clip not found")
    return {"deleted": 1}


@router.delete("/api/v1/voice/wake-clips")
async def delete_wake_clips():
    return {"deleted": wake_training.delete_all()}
