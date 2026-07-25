"""Wake-training clip store — the rules that make keeping the audio OK.

    docker compose exec backend python tests/test_wake_training.py

This module writes recordings of a household, including children, to disk.
Everything here is a promise made in Settings → Voice, checked mechanically
against a THROWAWAY directory, never the operator's:

  1. Labels are a closed set. A clip that arrives with a made-up label — or
     one shaped like a path — must not create a directory, because the label
     becomes a directory name.
  2. Ids from a URL cannot escape the store. `find()` is what the playback
     and delete routes resolve, so it is where traversal has to die.
  3. It is BOUNDED. Left on for a month it must drop the oldest clips rather
     than fill a disk, and the ring must be per label — false fires are
     plentiful and must not evict the scarce positives.
  4. "Delete all" deletes all — files, not just index entries. The listing
     going empty while the WAVs stay on disk is the failure that would matter
     most, and it is the one a naive implementation makes.
  5. A clip whose sidecar is lost still LISTS, or it becomes undeletable
     from the UI and invisible to the operator who wants it gone.
"""

import json
import sys
import tempfile
import wave
from pathlib import Path

sys.path.insert(0, "/app/backend")

FAILURES: list[str] = []


def check(label, cond, detail=""):
    print(f"  {'PASS' if cond else 'FAIL'}  {label}" + (f"   [{detail}]" if detail else ""))
    if not cond:
        FAILURES.append(label)


def wav_bytes(secs=0.2) -> bytes:
    buf = tempfile.NamedTemporaryFile(suffix=".wav", delete=False)
    with wave.open(buf.name, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(16000)
        w.writeframes(b"\x00\x01" * int(16000 * secs))
    return Path(buf.name).read_bytes()


def main() -> int:
    from app import wake_training
    from app.config import settings

    tmp = tempfile.mkdtemp(prefix="wake-training-test-")
    settings.wake_training_dir = tmp
    root = Path(tmp)
    audio = wav_bytes()

    # 1. closed label set
    for bad in ("../../etc", "positives", "", "pos/../../x"):
        try:
            wake_training.store(bad, audio, {})
            check(f"a made-up label {bad!r} is refused", False)
        except ValueError:
            check(f"a made-up label {bad!r} is refused", True)
    check("no stray directories were created",
          sorted(p.name for p in root.iterdir()) == [] or
          all(p.name in wake_training.LABELS for p in root.iterdir()),
          str(sorted(p.name for p in root.iterdir())))

    rec = wake_training.store("positive", audio, {"score": 0.9, "speaker": "kid",
                                                  "mic": "raw", "secs": 3.0})
    check("a stored clip keeps its label metadata",
          rec["score"] == 0.9 and rec["speaker"] == "kid" and rec["mic"] == "raw",
          json.dumps(rec))
    check("the wav and its sidecar are both on disk",
          (root / "positive" / f"{rec['id']}.wav").is_file()
          and (root / "positive" / f"{rec['id']}.json").is_file())

    # 2. traversal
    for bad in ("../../../etc/passwd", "..", "not-an-id", "1234-zzzzzzzz", ""):
        check(f"find({bad!r}) refuses to resolve", wake_training.find(bad) is None)

    # 3. bounded, per label
    wake_training._CAPS["false_fire"] = 5
    for _ in range(9):
        wake_training.store("false_fire", audio, {})
    listing = wake_training.listing()
    check("the false_fire ring holds at its cap",
          listing["counts"]["false_fire"] == 5, str(listing["counts"]))
    check("pruning one label does not touch another",
          listing["counts"]["positive"] == 1, str(listing["counts"]))

    # 5. a clip with no sidecar still lists
    orphan = wake_training.store("near_miss", audio, {})
    (root / "near_miss" / f"{orphan['id']}.json").unlink()
    listing = wake_training.listing()
    check("a clip whose sidecar is gone still appears",
          any(c["id"] == orphan["id"] for c in listing["clips"]),
          str(listing["counts"]))

    # single delete takes the sidecar with it
    check("delete removes the clip", wake_training.delete(rec["id"]))
    check("…and its sidecar", not (root / "positive" / f"{rec['id']}.json").exists())
    check("deleting a clip that is gone reports it",
          wake_training.delete(rec["id"]) is False)

    # 4. delete all means the files, not the index
    n = wake_training.delete_all()
    left = list(root.rglob("*.wav"))
    check("delete all reports what it deleted", n == 6, str(n))
    check("delete all leaves NO audio on disk", left == [], str(left))
    check("the listing agrees", wake_training.listing()["total"] == 0)

    if FAILURES:
        print(f"FAILED ({len(FAILURES)}): " + "; ".join(FAILURES))
        return 1
    print("all checks passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
