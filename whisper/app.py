"""Whisper STT service — Nova's ears.

A complete utterance is POSTed as recorded audio (webm/opus, mp4, wav — PyAV
decodes them); faster-whisper transcribes it in one shot with silero VAD
filtering + anti-hallucination guards.

    GET  /health      -> {status, model, device, loaded, ...}
    POST /transcribe   (raw audio body) -> {text, language, ...}
    POST /embed        (raw audio body) -> {embedding, secs} — speaker voiceprint
    POST /unload       -> free the model from (V)RAM now (reloads on next use)

/embed is the speaker-identification half (docs/plans/speaker-id.md): a
sherpa-onnx speaker-embedding model (WeSpeaker voxceleb class, ~28MB ONNX,
auto-downloaded to the models volume) turns an utterance into a vector the
backend cosine-matches against enrolled household voiceprints. CPU-only,
its own lock — an embedding must never queue behind a long transcription,
and a broken embedder must never break STT (callers treat errors as
speaker-unknown).

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

# ── speaker embeddings (voiceprints) ─────────────────────────────────────────
# WeSpeaker English voxceleb CAM++ via sherpa-onnx — small, CPU, keyless.
# (The release tag's "recongition" typo is upstream's, not ours.)
SPEAKER_MODEL_URL = os.environ.get(
    "SPEAKER_MODEL_URL",
    "https://github.com/k2-fsa/sherpa-onnx/releases/download/"
    "speaker-recongition-models/wespeaker_en_voxceleb_CAM%2B%2B.onnx")
SPEAKER_MODEL_PATH = os.path.join(
    MODEL_DIR, "speaker", os.path.basename(SPEAKER_MODEL_URL).replace("%2B", "+"))
# an utterance shorter than this carries too little voice to identify anyone
SPEAKER_MIN_SECS = float(os.environ.get("SPEAKER_MIN_SECS", "1.5"))

spk_extractor = None
spk_state: dict = {"status": "cold", "detail": None}
# deliberately NOT the transcribe lock: embedding is ~10ms on CPU and must
# never wait behind a long transcription or a model (re)load
spk_lock = asyncio.Lock()


def _spk_build() -> None:
    """Download (once, into the models volume) + load the speaker model.
    Runs in a worker thread; caller holds spk_lock."""
    global spk_extractor
    import urllib.request

    import sherpa_onnx
    if not os.path.exists(SPEAKER_MODEL_PATH):
        os.makedirs(os.path.dirname(SPEAKER_MODEL_PATH), exist_ok=True)
        tmp = SPEAKER_MODEL_PATH + ".part"
        log.info("downloading speaker model to %s ...", SPEAKER_MODEL_PATH)
        urllib.request.urlretrieve(SPEAKER_MODEL_URL, tmp)
        os.replace(tmp, SPEAKER_MODEL_PATH)
    cfg = sherpa_onnx.SpeakerEmbeddingExtractorConfig(
        model=SPEAKER_MODEL_PATH, num_threads=2, provider="cpu")
    spk_extractor = sherpa_onnx.SpeakerEmbeddingExtractor(cfg)
    spk_state.update(status="ready", detail=None)
    log.info("speaker embedder ready (%s)", os.path.basename(SPEAKER_MODEL_PATH))


def _decode_16k_mono(data: bytes):
    """Any container/codec PyAV understands -> float32 mono 16 kHz [-1, 1]."""
    import av
    import numpy as np
    pcm = []
    with av.open(BytesIO(data)) as container:
        resampler = av.AudioResampler(format="s16", layout="mono", rate=16000)
        for frame in container.decode(audio=0):
            for out in resampler.resample(frame):
                pcm.append(out.to_ndarray())
        for out in resampler.resample(None):   # flush
            pcm.append(out.to_ndarray())
    if not pcm:
        return np.zeros(0, dtype=np.float32)
    samples = np.concatenate(pcm, axis=1)[0]
    return samples.astype(np.float32) / 32768.0

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
    return {**state, "idle_unload_s": IDLE_UNLOAD_S, "speaker": spk_state}


@app.post("/embed")
async def embed(request: Request):
    """Speaker embedding for one utterance. Returns {embedding: null} for
    too-short audio; raises only on truly broken input — the backend treats
    any failure as speaker-unknown, never as a failed transcription."""
    audio = await request.body()
    if not audio:
        raise HTTPException(400, "empty audio body")
    try:
        samples = await asyncio.to_thread(_decode_16k_mono, audio)
    except Exception as e:
        raise HTTPException(400, f"could not decode audio: {e}")
    secs = round(len(samples) / 16000.0, 2)
    if secs < SPEAKER_MIN_SECS:
        return {"embedding": None, "secs": secs, "reason": "too short"}

    def run():
        stream = spk_extractor.create_stream()
        stream.accept_waveform(sample_rate=16000, waveform=samples)
        stream.input_finished()
        return list(spk_extractor.compute(stream))

    async with spk_lock:
        if spk_extractor is None:
            try:
                await asyncio.to_thread(_spk_build)
            except Exception as e:
                spk_state.update(status="error", detail=str(e)[:200])
                log.exception("speaker model load failed")
                raise HTTPException(503, f"speaker model unavailable: {e}")
        vec = await asyncio.to_thread(run)
    return {"embedding": vec, "secs": secs, "dim": len(vec)}


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
