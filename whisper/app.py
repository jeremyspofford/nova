"""Whisper STT service — Nova's ears.

A complete utterance is POSTed as recorded audio (webm/opus, mp4, wav — PyAV
decodes them); faster-whisper transcribes it in one shot with silero VAD
filtering + anti-hallucination guards.

    GET  /health      -> {status, model, device, loaded, ...}
    POST /transcribe   (raw audio body) -> {text, language, ...}
    POST /unload       -> free the model from (V)RAM now (reloads on next use)

Runs on CPU (device=cpu/int8) or GPU (device=cuda/float16) from the SAME image;
falls back to CPU if the GPU can't be used. To keep the GPU free for other work
(e.g. a big coding model) when you're not talking, the model is UNLOADED after
WHISPER_IDLE_UNLOAD_S of inactivity and lazily reloaded on the next request.
Model files download to the whisper_models volume on first start.
"""

import asyncio
import gc
import logging
import os
import time
from io import BytesIO

from fastapi import FastAPI, HTTPException, Request

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("whisper")

MODEL_SIZE = os.environ.get("WHISPER_MODEL", "small")
DEVICE = os.environ.get("WHISPER_DEVICE", "cpu")
COMPUTE = os.environ.get("WHISPER_COMPUTE", "int8")
MODEL_DIR = os.environ.get("WHISPER_MODEL_DIR", "/models")
# Free the model from (V)RAM after this many idle seconds; reloads on the next
# request. On GPU this hands the VRAM back for other work whenever you're not
# talking. 0 = never unload (stay warm).
IDLE_UNLOAD_S = int(os.environ.get("WHISPER_IDLE_UNLOAD_S", "300"))

state: dict = {"status": "starting", "detail": None, "model": MODEL_SIZE,
               "device": DEVICE, "loaded": False}
model = None
active_device = DEVICE
last_used = 0.0
# ctranslate2 isn't safe to call concurrently, and load/unload must not race a
# transcribe — one lock serialises all three.
lock = asyncio.Lock()

app = FastAPI(title="nova-whisper")


def _build() -> None:
    """Create the model, falling back to CPU if the GPU can't be used — a busy
    or missing GPU degrades to slow, never to dead. Runs in a worker thread."""
    global model, active_device
    from faster_whisper import WhisperModel
    candidates = [(DEVICE, COMPUTE)]
    if DEVICE != "cpu":
        candidates.append(("cpu", "int8"))
    last_err = None
    for dev, comp in candidates:
        try:
            log.info("loading faster-whisper %s (%s/%s) ...", MODEL_SIZE, dev, comp)
            model = WhisperModel(MODEL_SIZE, device=dev, compute_type=comp,
                                 download_root=MODEL_DIR)
            active_device = dev
            state.update(status="ready", loaded=True, device=dev,
                         detail=None if dev == DEVICE
                         else f"{DEVICE} unavailable — running on cpu")
            log.info("ready — %s on %s", MODEL_SIZE, dev)
            return
        except Exception as e:
            last_err = e
            log.warning("load on %s failed: %s", dev, e)
    raise last_err


def _unload() -> None:
    """Drop the model so its (V)RAM is reclaimed. Caller holds the lock."""
    global model
    if model is None:
        return
    model = None
    gc.collect()
    state.update(loaded=False)
    log.info("unloaded %s from %s — (V)RAM freed", MODEL_SIZE, active_device)


async def _idle_watcher() -> None:
    if IDLE_UNLOAD_S <= 0:
        return
    while True:
        await asyncio.sleep(15)
        if model is not None and (time.monotonic() - last_used) > IDLE_UNLOAD_S:
            async with lock:
                if model is not None and (time.monotonic() - last_used) > IDLE_UNLOAD_S:
                    _unload()


@app.on_event("startup")
async def startup():
    async def boot():
        try:
            async with lock:
                await asyncio.to_thread(_build)   # warm on start
            global last_used
            last_used = time.monotonic()
        except Exception as e:  # surface in /health, never die silently
            state.update(status="error", detail=str(e))
            log.exception("startup failed")
    asyncio.create_task(boot())
    asyncio.create_task(_idle_watcher())


@app.get("/health")
async def health():
    return {**state, "idle_unload_s": IDLE_UNLOAD_S}


@app.post("/unload")
async def unload():
    """Free the model now (e.g. to reclaim VRAM for another task). It reloads
    automatically on the next transcribe."""
    async with lock:
        _unload()
    return {"loaded": False}


@app.post("/transcribe")
async def transcribe(request: Request):
    if state["status"] == "error":
        raise HTTPException(503, f"whisper failed to start: {state['detail']}")
    audio = await request.body()
    if not audio:
        raise HTTPException(400, "empty audio body")

    def run():
        # vad_filter drops silence/noise so a half-second of nothing doesn't
        # hallucinate a phantom sentence.
        segments, info = model.transcribe(
            BytesIO(audio), beam_size=5, vad_filter=True,
            vad_parameters={"min_silence_duration_ms": 500},
            # anti-hallucination: don't let prior context invent a phantom
            # sentence, and drop segments the model itself flags as non-speech
            # or very low-confidence (this is where "Thank you." came from on
            # unclear audio — high no_speech_prob, low avg_logprob)
            condition_on_previous_text=False)
        kept = [s.text.strip() for s in segments
                if s.no_speech_prob < 0.8 and s.avg_logprob > -1.2]
        text = " ".join(kept).strip()
        return text, info.language, info.language_probability

    global last_used
    async with lock:                          # load (if idle-unloaded) + run, atomically
        if model is None:
            await asyncio.to_thread(_build)
        last_used = time.monotonic()
        text, lang, prob = await asyncio.to_thread(run)
    log.info("transcribed %d bytes -> %r (%s %.2f, %s)",
             len(audio), text[:80], lang, prob, active_device)
    return {"text": text, "language": lang, "language_probability": prob}
