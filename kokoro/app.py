"""Kokoro TTS service — Nova's batteries-included local voice.

Phase 1 of docs/plans/voice.md. Stateless sentence-level synthesis:

    GET  /health -> {"status": "downloading|loading|ready|error",
                     "detail": ..., "voices": [...]}
    POST /tts    {"text": ..., "voice": "af_heart", "speed": 1.0}
                 -> audio/wav, 24 kHz mono s16le

Model files (~340 MB) download to the kokoro_models volume on first start
with logged progress — startup never blocks silently; /tts answers 503
with the current status until ready.
"""

import asyncio
import io
import logging
import os
import urllib.request
import wave
from pathlib import Path

import numpy as np
from fastapi import FastAPI, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("kokoro")

MODEL_DIR = Path(os.environ.get("KOKORO_MODEL_DIR", "/models"))
FILES = {
    "kokoro-v1.0.onnx":
        "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/kokoro-v1.0.onnx",
    "voices-v1.0.bin":
        "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/voices-v1.0.bin",
}

state: dict = {"status": "starting", "detail": None}
engine = None
voices: list[str] = []
# synthesis is CPU-bound and the model is not thread-safe — serialize
synth_lock = asyncio.Lock()

app = FastAPI(title="nova-kokoro")


def _download(name: str, url: str) -> None:
    dest = MODEL_DIR / name
    if dest.exists() and dest.stat().st_size > 0:
        log.info("%s already present (%.1f MB)", name, dest.stat().st_size / 1e6)
        return
    tmp = dest.with_suffix(".part")
    log.info("downloading %s ...", url)

    last_pct = -10

    def report(blocks, block_size, total):
        nonlocal last_pct
        if total <= 0:
            return
        pct = int(blocks * block_size * 100 / total)
        if pct >= last_pct + 10:
            last_pct = pct
            log.info("  %s: %d%%", name, min(pct, 100))

    urllib.request.urlretrieve(url, tmp, reporthook=report)
    tmp.rename(dest)
    log.info("%s done (%.1f MB)", name, dest.stat().st_size / 1e6)


def _load() -> None:
    global engine, voices
    MODEL_DIR.mkdir(parents=True, exist_ok=True)
    state["status"] = "downloading"
    for name, url in FILES.items():
        _download(name, url)
    state["status"] = "loading"
    from kokoro_onnx import Kokoro
    engine = Kokoro(str(MODEL_DIR / "kokoro-v1.0.onnx"),
                    str(MODEL_DIR / "voices-v1.0.bin"))
    voices = sorted(engine.get_voices())
    state["status"] = "ready"
    log.info("ready — %d voices", len(voices))


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
    return {"status": state["status"], "detail": state["detail"], "voices": voices}


class TTSRequest(BaseModel):
    text: str
    voice: str = "af_heart"
    speed: float = 1.0


@app.post("/tts")
async def tts(req: TTSRequest):
    if state["status"] != "ready":
        raise HTTPException(503, f"kokoro not ready: {state['status']} {state['detail'] or ''}")
    text = req.text.strip()
    if not text:
        raise HTTPException(400, "text is empty")
    if len(text) > 2000:
        raise HTTPException(413, "text too long for one synthesis call (2000 chars)")
    if req.voice not in voices:
        raise HTTPException(400, f"unknown voice {req.voice!r}")

    async with synth_lock:
        samples, sample_rate = await asyncio.to_thread(
            engine.create, text, voice=req.voice,
            speed=max(0.5, min(req.speed, 2.0)), lang="en-us")

    pcm = (np.clip(samples, -1.0, 1.0) * 32767).astype(np.int16)
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sample_rate)
        w.writeframes(pcm.tobytes())
    return Response(content=buf.getvalue(), media_type="audio/wav")
