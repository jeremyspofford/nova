"""Wake-word training clips — the audio the wake word learns from (phase 5a).

The premise of ROADMAP #11b is that Nova gets better because you USE her, not
because you sit down and record a training session. The wake model shipped
here was trained on synthetic adult TTS; a child saying "hey nova" is not in
its training set, which is why it takes three tries. Asking a seven-year-old
to record forty clean samples is not a fix.

So clips arrive as a by-product of ordinary use, and only ever LABELLED ones —
audio with no label teaches nothing:

    positive    the wake word fired and a real turn followed. Ground truth
                for "this is the phrase, said by this person, in this room".
    false_fire  it fired and nothing was said. The negatives that matter are
                the ones this house actually produces, not a generic corpus.
    near_miss   it did NOT fire, but scored in the shadow band, and within a
                few seconds you fired it again or gave up and tapped the mic.
                That pattern IS "I had to say it three times".

This is biometric-adjacent audio of a household including children, so the
rules are strict and not configurable:

  * OFF by default. Nothing is written unless voice.wake_learning is on, and
    the server re-checks that on every write — a stale browser tab must not
    be able to keep recording after the operator turns it off.
  * Local disk only, under ./data/wake-training/, next to ./data/memory/ and
    gitignored the same way. It is never uploaded anywhere.
  * Browsable and deletable from Settings -> Voice: every clip can be played
    and deleted, and "delete all" means all.
  * Bounded. A per-label ring keeps the most recent clips and drops the
    oldest, so leaving it on for a month cannot fill a disk.

Each clip is a WAV plus a JSON sidecar with the label, the score, the
threshold at the time, the mic-processing mode and the matched speaker if
there was one. tools/wake-training consumes the directory directly.
"""

from __future__ import annotations

import json
import logging
import re
import time
import uuid
from pathlib import Path

from app.config import settings

log = logging.getLogger(__name__)

LABELS = ("positive", "false_fire", "near_miss")

# clip ids are generated as "<epoch-ms>-<hex8>"; nothing else is accepted back
_ID_OK = re.compile(r"[0-9]+-[0-9a-f]{8}")

# Per-label ring. Positives are the scarce, valuable ones; false fires repeat
# themselves and a few dozen characterise a room. tools/wake-training wants
# roughly 70 real clips per speaker to shift a model trained on 828 synthetic
# positives, so 300 is comfortably more than a retrain needs.
_CAPS = {"positive": 300, "false_fire": 150, "near_miss": 150}

# a wake clip is ~3 s of 16 kHz mono s16 (~96 KB); this bounds the directory
# at a few tens of MB even before the per-label caps bite
MAX_CLIP_BYTES = 2 * 1024 * 1024


def _root() -> Path:
    return Path(settings.wake_training_dir)


def _dir(label: str) -> Path:
    d = _root() / label
    d.mkdir(parents=True, exist_ok=True)
    return d


def _meta_path(wav: Path) -> Path:
    return wav.with_suffix(".json")


def store(label: str, audio: bytes, meta: dict) -> dict:
    """Write one labelled clip. Returns its record."""
    if label not in LABELS:
        raise ValueError(f"unknown label {label!r}")
    if not audio:
        raise ValueError("no audio")
    if len(audio) > MAX_CLIP_BYTES:
        raise ValueError("clip too large")

    clip_id = f"{int(time.time() * 1000)}-{uuid.uuid4().hex[:8]}"
    wav = _dir(label) / f"{clip_id}.wav"
    wav.write_bytes(audio)
    record = {
        "id": clip_id,
        "label": label,
        "at": time.time(),
        "bytes": len(audio),
        **{k: v for k, v in meta.items() if k in
           ("score", "threshold", "phrase", "speaker", "mic", "secs")},
    }
    _meta_path(wav).write_text(json.dumps(record, indent=2))
    _prune(label)
    return record


def _prune(label: str) -> None:
    """Keep the most recent clips for a label; drop the oldest beyond the cap.
    A ring, not a hard stop: the operator should never have to clear the
    directory by hand to keep learning, and recent evidence is the evidence
    that matters."""
    cap = _CAPS.get(label, 200)
    clips = sorted(_dir(label).glob("*.wav"))
    excess = len(clips) - cap
    if excess <= 0:
        return
    for wav in clips[:excess]:
        _delete_file(wav)
    log.info("wake-training: pruned %d old %s clips (cap %d)", excess, label, cap)


def _delete_file(wav: Path) -> None:
    for p in (wav, _meta_path(wav)):
        try:
            p.unlink()
        except FileNotFoundError:
            pass


def _read(wav: Path) -> dict:
    try:
        rec = json.loads(_meta_path(wav).read_text())
    except (OSError, ValueError):
        # a clip whose sidecar is gone is still a clip — do not hide it, or
        # "delete all" would leave files the operator cannot see
        rec = {"id": wav.stem, "label": wav.parent.name}
    rec.setdefault("at", wav.stat().st_mtime)
    rec.setdefault("bytes", wav.stat().st_size)
    return rec


def listing(limit: int = 100) -> dict:
    """Counts per label plus the most recent clips, newest first."""
    counts = {label: 0 for label in LABELS}
    total_bytes = 0
    clips: list[dict] = []
    root = _root()
    if root.exists():
        for label in LABELS:
            d = root / label
            if not d.is_dir():
                continue
            for wav in d.glob("*.wav"):
                counts[label] += 1
                rec = _read(wav)
                total_bytes += rec.get("bytes", 0)
                clips.append(rec)
    clips.sort(key=lambda r: r.get("at", 0), reverse=True)
    return {"counts": counts, "bytes": total_bytes,
            "total": sum(counts.values()), "clips": clips[:limit]}


def find(clip_id: str) -> Path | None:
    # the id reaches this from a URL and becomes a filename — anything that
    # is not the shape we generate is refused rather than resolved
    if not clip_id or not _ID_OK.fullmatch(clip_id):
        return None
    for label in LABELS:
        wav = _root() / label / f"{clip_id}.wav"
        if wav.is_file():
            return wav
    return None


def delete(clip_id: str) -> bool:
    wav = find(clip_id)
    if wav is None:
        return False
    _delete_file(wav)
    return True


def delete_all() -> int:
    root = _root()
    if not root.exists():
        return 0
    n = 0
    for label in LABELS:
        d = root / label
        if not d.is_dir():
            continue
        for wav in d.glob("*.wav"):
            _delete_file(wav)
            n += 1
    return n
