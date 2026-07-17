"""Turn WAV clips into openWakeWord embedding windows ([16,96] float32).

This replicates frontend/src/voice/wake.ts's streaming pipeline LINE FOR LINE
(chunking, the raw-buffer cap, the /10+2 mel transform, the ones/silence
buffer prime) — that port was verified numerically against openWakeWord's
Python reference, so matching it here means train-time features are exactly
what the browser computes at inference time.

Modes:
  featurize (default): data/{pos,neg}/*.wav → features.npz
    - positives: the LAST 2 windows of each clip (score peaks once the
      phrase completes); earlier windows are discarded as ambiguous
    - negatives: every 2nd window of each clip, plus synthetic noise and
      silence streams (no TTS needed for those)
    - waveform augmentation: random gain, white noise at random SNR,
      random leading/trailing silence — 2 variants per clip
  --score MODEL.onnx WAV [WAV...]: stream clips through mel → embedding →
    the given wake head and print each clip's max per-chunk score. This is
    the evaluation harness AND a cross-check tool (e.g. prove the hey_nova
    head does not fire on a hey_jarvis clip).
"""

import argparse
import sys
import wave
from pathlib import Path

import numpy as np
import onnxruntime as ort
from scipy.signal import lfilter, resample_poly

SR = 16000
CHUNK = 1280        # 80 ms — one wake step
RAW_MAX = 1760      # chunk + 480-sample lead-in
BINS = 32
MEL_WIN = 76
EMB_WIN = 16
MEL_MAX = 200

WAKE_DIR = Path(__file__).resolve().parents[2] / "frontend" / "public" / "wake"
rng = np.random.default_rng(1337)


def load_wav_16k(path: Path) -> np.ndarray:
    """WAV → float32 mono in [-1,1] at 16 kHz."""
    with wave.open(str(path), "rb") as w:
        assert w.getsampwidth() == 2, f"{path}: expected 16-bit PCM"
        frames = np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16)
        if w.getnchannels() > 1:
            frames = frames.reshape(-1, w.getnchannels()).mean(axis=1)
        rate = w.getframerate()
    x = frames.astype(np.float32) / 32768.0
    if rate != SR:
        x = resample_poly(x, SR, rate).astype(np.float32)
    return x


class Pipeline:
    """melspec + embedding (the frozen front-end) with wake.ts's exact
    streaming state machine."""

    def __init__(self):
        opt = ort.SessionOptions()
        opt.log_severity_level = 3
        self.mel = ort.InferenceSession(WAKE_DIR / "melspectrogram.onnx", opt)
        self.emb = ort.InferenceSession(WAKE_DIR / "embedding_model.onnx", opt)
        self.mel_in = self.mel.get_inputs()[0].name
        self.emb_in = self.emb.get_inputs()[0].name

    def melspec(self, int16_valued: np.ndarray) -> np.ndarray:
        t = int16_valued.astype(np.float32)[None, :]
        out = self.mel.run(None, {self.mel_in: t})[0]
        frames = out.reshape(-1, BINS)
        return frames / 10.0 + 2.0                      # the owW transform

    def embed(self, mel_win: np.ndarray) -> np.ndarray:
        t = mel_win.astype(np.float32).reshape(1, MEL_WIN, BINS, 1)
        return self.emb.run(None, {self.emb_in: t})[0].reshape(-1)

    def stream(self, audio_16k: np.ndarray):
        """Yield one [16,96] window per 80 ms chunk, exactly as wake.ts."""
        # prime: ones mel-buffer + silence embeddings
        mel_buf = [np.ones(BINS, dtype=np.float32) for _ in range(MEL_WIN)]
        sil_frame = self.melspec(np.zeros(RAW_MAX, dtype=np.float32))[0]
        sil_emb = self.embed(np.stack([sil_frame] * MEL_WIN))
        emb_buf = [sil_emb.copy() for _ in range(EMB_WIN)]

        samples = audio_16k * 32767.0                   # int16-valued floats
        raw: list[np.ndarray] = []
        raw_len = 0
        n_chunks = len(samples) // CHUNK
        for c in range(n_chunks):
            chunk = samples[c * CHUNK:(c + 1) * CHUNK]
            raw.append(chunk)
            raw_len += len(chunk)
            while raw_len > RAW_MAX:                    # keep last <=1760
                excess = raw_len - RAW_MAX
                if len(raw[0]) <= excess:
                    raw_len -= len(raw[0]); raw.pop(0)
                else:
                    raw[0] = raw[0][excess:]; raw_len -= excess
            for f in self.melspec(np.concatenate(raw)):
                mel_buf.append(f.astype(np.float32))
            if len(mel_buf) > MEL_MAX:
                mel_buf = mel_buf[-MEL_MAX:]
            if len(mel_buf) >= MEL_WIN:
                emb_buf.append(self.embed(np.stack(mel_buf[-MEL_WIN:])))
                if len(emb_buf) > EMB_WIN:
                    emb_buf = emb_buf[-EMB_WIN:]
            yield np.stack(emb_buf).astype(np.float32)  # [16, 96]


def augment(x: np.ndarray, hard: bool = False) -> np.ndarray:
    """Waveform augmentation toward REAL-MIC conditions. v0.1 trained on
    clean TTS and missed real voices; hey_jarvis survives browsers because it
    trained through reverb/noise/EQ — so v0.2 simulates: room reverb
    (exp-decay noise kernel), spectral tilt (browser mic processing colors
    the spectrum), rate perturbation (pitch+tempo), and wider noise SNRs."""
    # rate perturbation: resample by ±10% — shifts pitch and tempo together
    if rng.random() < 0.7:
        rate = rng.uniform(0.9, 1.1)
        x = resample_poly(x, int(1000 * rate), 1000).astype(np.float32)
    # synthetic room reverb: convolve with a decaying-noise RIR
    if hard or rng.random() < 0.5:
        rt = rng.uniform(0.08, 0.35)                           # tail seconds
        kernel = (rng.normal(0, 1, int(rt * SR)).astype(np.float32)
                  * np.exp(-6 * np.arange(int(rt * SR)) / (rt * SR), dtype=np.float32))
        kernel[0] = 1.0                                        # direct path
        wet = np.convolve(x, kernel * rng.uniform(0.15, 0.5))[:len(x)]
        x = (x + wet.astype(np.float32)) / 2.0
    # spectral tilt: one-pole filter, randomly darkening or brightening
    if hard or rng.random() < 0.5:
        a = rng.uniform(-0.4, 0.4)
        y = lfilter([1.0], [1.0, -a], x)                       # y[n]=x[n]+a*y[n-1]
        x = (y / max(1e-6, np.abs(y).max()) * np.abs(x).max()).astype(np.float32)
    x = x * rng.uniform(0.25, 1.0)                             # gain
    snr_db = rng.uniform(5 if hard else 10, 25)                # noise
    p_sig = float(np.mean(x ** 2)) or 1e-9
    noise = rng.normal(0, np.sqrt(p_sig / (10 ** (snr_db / 10))), len(x))
    x = x + noise.astype(np.float32)
    lead = np.zeros(int(rng.uniform(0.1, 0.8) * SR), dtype=np.float32)
    tail = np.zeros(int(rng.uniform(0.2, 0.5) * SR), dtype=np.float32)
    return np.clip(np.concatenate([lead, x, tail]), -1.0, 1.0)


def featurize(data_dir: Path):
    pipe = Pipeline()
    X, y, clip_ids = [], [], []

    def add_clip(path: Path, label: int, clip_id: str):
        base = load_wav_16k(path)
        for variant in range(3):        # clean / moderate room / hard room
            audio = (np.concatenate([np.zeros(int(0.3 * SR), np.float32), base,
                                     np.zeros(int(0.35 * SR), np.float32)])
                     if variant == 0 else augment(base, hard=(variant == 2)))
            windows = list(pipe.stream(audio))
            if not windows:
                continue
            if label == 1:
                for w in windows[-2:]:                  # phrase just completed
                    X.append(w); y.append(1); clip_ids.append(clip_id)
            else:
                for w in windows[::2]:
                    X.append(w); y.append(0); clip_ids.append(clip_id)

    pos = sorted((data_dir / "pos").glob("*.wav"))
    neg = sorted((data_dir / "neg").glob("*.wav"))
    print(f"featurizing {len(pos)} positive / {len(neg)} negative clips...")
    for i, p in enumerate(pos):
        add_clip(p, 1, p.stem)
        if (i + 1) % 50 == 0:
            print(f"  pos {i + 1}/{len(pos)}")
    for i, p in enumerate(neg):
        add_clip(p, 0, p.stem)
        if (i + 1) % 50 == 0:
            print(f"  neg {i + 1}/{len(neg)}")

    # pure noise + silence streams — cheap negatives the mic hears constantly
    for i in range(60):
        dur = rng.uniform(1.5, 3.0)
        kind = i % 3
        if kind == 0:
            audio = np.zeros(int(dur * SR), dtype=np.float32)
        elif kind == 1:
            audio = rng.normal(0, rng.uniform(0.005, 0.05), int(dur * SR)).astype(np.float32)
        else:                                           # crude hum/rumble
            t = np.arange(int(dur * SR)) / SR
            f = rng.uniform(60, 300)
            audio = (0.05 * np.sin(2 * np.pi * f * t)
                     + rng.normal(0, 0.01, len(t))).astype(np.float32)
        for w in list(pipe.stream(audio))[::2]:
            X.append(w); y.append(0); clip_ids.append(f"synthetic_{kind}_{i}")

    Xa = np.stack(X); ya = np.array(y, dtype=np.float32)
    out = data_dir / "features.npz"
    np.savez_compressed(out, X=Xa, y=ya, clip_ids=np.array(clip_ids))
    print(f"{out}: X{Xa.shape}, positives {int(ya.sum())}, negatives {int((1 - ya).sum())}")


def score(model_path: Path, wavs: list[Path]):
    pipe = Pipeline()
    opt = ort.SessionOptions()
    opt.log_severity_level = 3
    head = ort.InferenceSession(model_path, opt)
    head_in = head.get_inputs()[0].name
    for w in wavs:
        audio = load_wav_16k(w)
        # small trailing pad so the full phrase lands inside the last windows
        audio = np.concatenate([audio, np.zeros(int(0.4 * SR), np.float32)])
        best = 0.0
        for win in pipe.stream(audio):
            s = float(head.run(None, {head_in: win[None]})[0].reshape(-1)[0])
            best = max(best, s)
        print(f"  {best:.3f}  {w.name}")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", default="data")
    ap.add_argument("--score", nargs="+", metavar=("MODEL", "WAV"))
    args = ap.parse_args()
    if args.score:
        score(Path(args.score[0]), [Path(p) for p in args.score[1:]])
    else:
        featurize(Path(args.data))
