"""Turn captured wake clips (data/wake-training/) into training clips.

Phase 5a captures labelled audio from ordinary use: it fired and you spoke
(positive), it fired and nobody did (false_fire), it nearly fired and you had
to try again (near_miss). This script is the bridge from that pile to
`tools/wake-training/data/{pos,neg}` — and it exists because copying the files
across is WRONG in three specific ways that would quietly poison a retrain.

  1. WHERE THE PHRASE IS.  featurize.py labels `windows[-2:]` as positive,
     because a clean TTS clip ends the moment the phrase does. A captured
     clip does not: a near-miss is snapshotted several hundred ms after the
     score fell back, and a VAD clip ends with the 1100 ms redemption tail.
     Training on those last two windows teaches "silence after speech means
     wake", which is worse than not training at all. So the phrase is LOCATED
     here — with the real wake head, by peak score — and the clip is trimmed
     so that the phrase ends where featurize.py expects it.

  2. NEAR MISSES ARE POSITIVES.  They are the phrase, said by the person the
     model does not know, and ignored. They are the most valuable clips in
     the set; they are also the ones most likely to be mislocated, which is
     why (1) comes first.

  3. WEIGHT.  data/pos ships 828 synthetic clips. Forty real ones is 4.6% of
     the set and will not move a decision boundary. Real clips are duplicated
     (with augmentation applied downstream at featurize time, so the copies
     are not identical) until they hold --share of the positive set. That is
     a blunt instrument and it is stated in the output rather than hidden.

Usage:
    python ingest_captured.py [--src ../../data/wake-training]
                              [--share 0.23] [--dry-run]

Nothing is deleted from the source: this copies. Run featurize.py + train.py
afterwards, then follow README.md to ship the model.
"""

from __future__ import annotations

import argparse
import json
import wave
from pathlib import Path

import numpy as np
import onnxruntime as ort

from featurize import SR, Pipeline, load_wav_16k

HERE = Path(__file__).resolve().parent
DEFAULT_SRC = HERE.parents[1] / "data" / "wake-training"
POS = HERE / "data" / "pos"
NEG = HERE / "data" / "neg"

# how much clip to keep around the located phrase
LEAD_S = 1.1        # room for the wake pipeline's context window
TAIL_S = 0.15       # a touch of trailing silence, like the TTS clips have


def write_wav(path: Path, x: np.ndarray) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    pcm = np.clip(x, -1.0, 1.0)
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes((pcm * 32767).astype("<i2").tobytes())


def locate_phrase(pipe: Pipeline, head: ort.InferenceSession,
                  x: np.ndarray) -> tuple[int, float]:
    """(sample index where the phrase completes, peak score).

    Streams the clip through the real head and finds the chunk whose score
    peaks. That chunk is where the phrase finished — which is exactly the
    alignment featurize.py assumes, and the only reliable way to find it in
    audio that was captured rather than generated."""
    name = head.get_inputs()[0].name
    best_i, best = -1, -1.0
    for i, win in enumerate(pipe.stream(x)):
        s = float(head.run(None, {name: win[None]})[0].reshape(-1)[0])
        if s > best:
            best, best_i = s, i
    if best_i < 0:
        return len(x), 0.0
    # window i was produced after (i+1) chunks of 1280 samples were consumed
    return min(len(x), (best_i + 1) * 1280), best


def trim(x: np.ndarray, end: int) -> np.ndarray:
    start = max(0, end - int(LEAD_S * SR))
    stop = min(len(x), end + int(TAIL_S * SR))
    return x[start:stop]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", type=Path, default=DEFAULT_SRC)
    ap.add_argument("--share", type=float, default=0.23,
                    help="target share of the positive set held by real clips")
    ap.add_argument("--model", type=Path, default=HERE / "hey_nova_v0.2.onnx")
    ap.add_argument("--min-score", type=float, default=0.02,
                    help="skip clips whose peak is pure noise floor — the "
                         "phrase is not in them and they would only add mush")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    if not args.src.is_dir():
        print(f"no captured clips at {args.src} — turn on Settings → Voice → "
              f"'Learn the wake word from use' and use her for a few days")
        return 1

    pipe = Pipeline()
    head = ort.InferenceSession(str(args.model), providers=["CPUExecutionProvider"])

    existing_pos = len(list(POS.glob("*.wav")))
    kept: list[tuple[str, np.ndarray, dict]] = []
    skipped = 0

    for label in ("positive", "near_miss", "false_fire"):
        for wav in sorted((args.src / label).glob("*.wav")):
            meta = {}
            side = wav.with_suffix(".json")
            if side.exists():
                try:
                    meta = json.loads(side.read_text())
                except ValueError:
                    pass
            x = load_wav_16k(wav)
            if label == "false_fire":
                # a negative is used whole — there is no phrase to align to,
                # and the whole point is what the room actually sounds like
                kept.append(("neg", x, {**meta, "src": wav.name}))
                continue
            end, peak = locate_phrase(pipe, head, x)
            if peak < args.min_score:
                skipped += 1
                continue
            kept.append(("pos", trim(x, end), {**meta, "src": wav.name, "peak": peak}))

    real_pos = [k for k in kept if k[0] == "pos"]
    real_neg = [k for k in kept if k[0] == "neg"]
    if not real_pos and not real_neg:
        print(f"nothing usable found in {args.src} ({skipped} below --min-score)")
        return 1

    # weighting: how many copies of each real positive to reach --share
    copies = 1
    if real_pos and 0 < args.share < 1:
        # want: n*copies / (existing + n*copies) >= share
        need = args.share * existing_pos / (1 - args.share)
        copies = max(1, int(round(need / len(real_pos))))

    print(f"captured: {len(real_pos)} positive-side, {len(real_neg)} negative "
          f"({skipped} skipped below --min-score)")
    print(f"existing synthetic positives: {existing_pos}")
    print(f"duplicating each real positive {copies}x -> "
          f"{len(real_pos) * copies} clips "
          f"({len(real_pos) * copies / max(1, existing_pos + len(real_pos) * copies):.0%} "
          f"of the positive set)")
    if copies > 12:
        print("  NOTE: that is a lot of duplication. Capture more real clips "
              "before retraining, or lower --share — the same 40 clips "
              "repeated 20 times is 40 clips' worth of information.")
    if args.dry_run:
        for kind, x, meta in kept[:10]:
            print(f"  {kind:3s} {meta.get('src')} {len(x) / SR:.2f}s "
                  f"peak={meta.get('peak', float('nan')):.3f}")
        return 0

    for _, x, meta in real_neg:
        write_wav(NEG / f"real-{meta['src']}", x)
    for _, x, meta in real_pos:
        for c in range(copies):
            write_wav(POS / f"real-{c:02d}-{meta['src']}", x)
    print(f"wrote {len(real_pos) * copies} positives to {POS} and "
          f"{len(real_neg)} negatives to {NEG}")
    print("next: python featurize.py && python train.py")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
