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

## Retraining on real clips (phase 5)

Settings → Voice → "Learn the wake word from use" makes Nova keep the few
seconds around each labelled wake attempt in `data/wake-training/` — it fired
and you spoke (`positive`), it fired and nobody did (`false_fire`), it nearly
fired and you had to try again (`near_miss`). Off by default; every clip is
playable and deletable from the same panel.

```bash
.venv/bin/python ingest_captured.py --dry-run   # look before you copy
.venv/bin/python ingest_captured.py             # -> data/pos, data/neg
.venv/bin/python featurize.py && .venv/bin/python train.py
```

`ingest_captured.py` exists because copying those files into `data/pos` is
wrong in three ways that would quietly poison the retrain:

1. **The phrase is not at the end.** `featurize.py` labels `windows[-2:]` as
   positive because a TTS clip ends exactly when the phrase does. A captured
   clip does not — a near-miss is snapshotted several hundred ms after the
   score fell back, and a VAD clip ends with the 1100 ms redemption tail.
   Those last two windows are silence, and training on them teaches
   "silence after speech means wake". The script locates the phrase by
   streaming the clip through the real head and taking the peak, then trims.
2. **Near misses are positives.** They are the phrase, said by someone the
   model does not know, and ignored — the most valuable clips in the set.
3. **Weight.** `data/pos` ships 828 synthetic clips; forty real ones is 4.6%
   and moves nothing. The script duplicates real clips to `--share` (default
   0.23) and tells you the multiplier — if it prints something like 60x,
   capture more clips rather than believing the number.

**Child augmentation direction.** `augment()`'s rate perturbation resamples,
which shifts pitch and formants together — and the direction is the opposite
of the obvious reading. `resample_poly(x, 1000*rate, 1000)` with `rate > 1`
makes the signal longer, which at a fixed 16 kHz plays back slower and
*lower*: the adult-male direction. A child is `rate < 1`. v0.2 used
`uniform(0.9, 1.1)` — symmetric, and ±10% is about ±160 cents, nowhere near a
child; adult-to-child is roughly 250–370 cents of formant scaling
(ChildAugment, arXiv 2402.15214). It now takes the child branch
(`0.74–0.87`) 40% of the time.

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
