# Wake-word training (openWakeWord-compatible)

Mints a custom wake-phrase model for Nova's in-browser detector
(`frontend/src/voice/wake.ts`). The browser pipeline is frozen — melspec +
speech embedding (self-hosted in `frontend/public/wake/`) — so "training a
wake word" means training only a tiny classifier head on `[16,96]` embedding
windows and exporting it to ONNX. Anything with that input/output contract
drops into `wakeCatalog.ts` with no other code change.

## Pipeline

```
generate_samples.py   Kokoro TTS (the bundled voice stack) speaks the phrase
                      across ~34 voices x 3 texts x 3 speeds, plus hard
                      negatives (near-collisions, aboutness sentences,
                      everyday commands). Two voices are HELD OUT entirely
                      for evaluation.
featurize.py          exact Python port of wake.ts's streaming featurizer
                      (validated: the shipped hey_jarvis head scores 0.999
                      on its phrase / 0.000 on a control through this port).
                      Adds waveform augmentation (gain, noise SNR 10-30 dB,
                      random lead/tail silence) + pure noise/silence
                      negatives -> features.npz
train.py              tiny torch head (~200k params), split BY CLIP (no
                      window leakage), class-weighted BCE, early stopping,
                      ONNX export with torch-parity check + threshold sweep
featurize.py --score  end-to-end scorer: stream any WAV through
                      mel -> embedding -> a wake head, print max score.
                      Use it for eval clips and cross-model checks.
```

## Run

```bash
cd tools/wake-training
uv venv .venv
uv pip install -p .venv/bin/python numpy scipy onnxruntime httpx
uv pip install -p .venv/bin/python torch --index-url https://download.pytorch.org/whl/cpu
.venv/bin/python generate_samples.py      # needs the stack up (Kokoro via backend)
.venv/bin/python featurize.py
.venv/bin/python train.py                 # -> hey_nova_v0.1.onnx
# evaluate on held-out voices:
.venv/bin/python featurize.py --score hey_nova_v0.1.onnx data/eval/*.wav
```

Ship: copy the ONNX to `frontend/public/wake/`, add an entry to
`frontend/src/voice/wakeCatalog.ts`, and add the key to the
`voice.wake_word` options in `backend/app/settings_store.py`.

## v0.2 results (hey_nova, trained 2026-07-16 — current)

v0.1 (clean-TTS training) missed Jeremy's real voice while hey_jarvis
worked: the gap was REAL-MIC ACOUSTICS (room reverb, mic coloring, browser
echo-cancel/noise-suppress/AGC), not accents — v0.1 scored 1.000 on six
never-trained non-English voices but dropped to 0.314 on a reverb-simulated
clip. v0.2 trains through simulated acoustics (exp-decay-noise reverb,
spectral tilt, ±10% rate perturbation, SNR 5-25 dB) across ALL 54 voices +
a pause-prosody text ("hey... nova").

- corpus: 517 positives / 825 TTS negatives / noise+silence, augmented x3
  (clean / moderate / hard room) -> 58,903 windows (4,968 pos)
- val (split by clip, on the HARD augmented set): recall 0.991 /
  false-accept 1.2% at threshold 0.5; 0.978 / 0.44% at 0.9
- held-out voices: positives all 1.000, negatives <=0.003 (incl. the
  aboutness sentence); OOD accents all 1.000; hey_jarvis exclusion 0.000
- room-sim (fresh seed, held-out clips): v0.1 dropped to 0.314 on one
  clip (a missed wake at threshold 0.5); v0.2 holds >=0.997 on all six
- live in-browser: fires on the harsh-room clip v0.1 missed

Threshold tuning against YOUR voice: set
`localStorage.setItem('nova.wakeDebug','1')`, open devtools, enable wake
mode — the console prints the rolling 1 s max score. Speak the phrase,
read your scores, set `voice.wake_threshold` a bit below them.

## Honest limits

- **Synthetic-only training.** Kokoro voices are diverse but they are not
  your voice. Expect to tune `voice.wake_threshold` by actually speaking to
  it; real-voice accuracy will trail the official openWakeWord models, which
  train on massive real-speech negative corpora (ACAV100M-scale).
- The negative set here is a few hundred TTS phrases + noise — false-accept
  rates on arbitrary household audio are NOT characterized. Treat v0.1 as a
  working prototype; if it false-fires in practice, raise the threshold
  first, then grow the negative corpus and retrain.
- CPU is enough at this corpus size. The 3090 buys nothing until the corpus
  grows ~100x toward the full openWakeWord recipe.
