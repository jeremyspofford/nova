"""Whisper STT service — Nova's ears.

Phase 2 of docs/plans/voice.md. A complete push-to-talk utterance is POSTed
as recorded audio (webm/opus, mp4, wav — PyAV decodes them); faster-whisper
transcribes it in one shot with silero VAD filtering (trims silence, heads
off hallucination on quiet input).

    GET  /health     -> {"status": "loading|ready|error", "model": ...}
    POST /transcribe  (raw audio body) -> {"text": ..., "language": ...}

Model files download to the whisper_models volume on first start. CPU +
int8 by default — sub-second for short utterances; GPU is a later add.
"""

import asyncio
import logging
import os
from io import BytesIO

from fastapi import FastAPI, HTTPException, Request

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("whisper")

MODEL_SIZE = os.environ.get("WHISPER_MODEL", "base")
DEVICE = os.environ.get("WHISPER_DEVICE", "cpu")
COMPUTE = os.environ.get("WHISPER_COMPUTE", "int8")
MODEL_DIR = os.environ.get("WHISPER_MODEL_DIR", "/models")

state: dict = {"status": "starting", "detail": None}
model = None
# ctranslate2 is not safe to call concurrently from many threads — serialize
transcribe_lock = asyncio.Lock()

app = FastAPI(title="nova-whisper")


def _load() -> None:
    global model
    from faster_whisper import WhisperModel
    state["status"] = "loading"
    log.info("loading faster-whisper %s (%s/%s) ...", MODEL_SIZE, DEVICE, COMPUTE)
    model = WhisperModel(MODEL_SIZE, device=DEVICE, compute_type=COMPUTE,
                         download_root=MODEL_DIR)
    state["status"] = "ready"
    log.info("ready — model %s", MODEL_SIZE)


@app.on_event("startup")
async def startup():
    async def boot():
        try:
            await asyncio.to_thread(_load)
        except Exception as e:  # surface in /health, never die silently
            state["status"] = "error"
            state["detail"] = str(e)
            log.exception("startup failed")
    asyncio.create_task(boot())


@app.get("/health")
async def health():
    return {"status": state["status"], "detail": state["detail"], "model": MODEL_SIZE}


@app.post("/transcribe")
async def transcribe(request: Request):
    if state["status"] != "ready":
        raise HTTPException(503, f"whisper not ready: {state['status']} {state['detail'] or ''}")
    audio = await request.body()
    if not audio:
        raise HTTPException(400, "empty audio body")

    def run():
        # vad_filter drops silence/noise so a half-second of nothing doesn't
        # hallucinate a phantom sentence
        segments, info = model.transcribe(
            BytesIO(audio), beam_size=5, vad_filter=True,
            vad_parameters={"min_silence_duration_ms": 500})
        text = " ".join(s.text.strip() for s in segments).strip()
        return text, info.language, info.language_probability

    async with transcribe_lock:
        text, lang, prob = await asyncio.to_thread(run)
    log.info("transcribed %d bytes -> %r (%s %.2f)", len(audio), text[:80], lang, prob)
    return {"text": text, "language": lang, "language_probability": prob}
