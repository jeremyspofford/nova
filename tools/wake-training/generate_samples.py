"""Generate synthetic wake-word training audio via the bundled Kokoro TTS.

Positives: the wake phrase spoken by many voices at several speeds.
Negatives: phonetically-adjacent phrases (the model must NOT fire on these),
"aboutness" sentences that contain the bare name without the trigger, and
everyday commands. Pure noise/silence negatives are added later, in
featurize.py (no TTS needed for those).

Voices ending up in HOLDOUT_VOICES are excluded from training generation and
used only to cut evaluation clips — so eval measures generalization to a
voice the head has never heard, not memorization.

Usage: python generate_samples.py [--out data] [--api http://127.0.0.1:8000]
Token: read from the repo .env (NOVA_AUTH_TOKEN) unless --token is given.
"""

import argparse
import asyncio
import json
import re
from pathlib import Path

import httpx

PHRASE = "hey nova"

POSITIVE_TEXTS = ["hey nova", "hey nova!", "hey, nova.", "hey... nova"]
SPEEDS = [0.8, 1.0, 1.25]

# hard negatives: near-collisions, aboutness (bare name, no trigger), commands
NEGATIVE_TEXTS = [
    "hey nora", "hey noah", "hey nolan", "hey mona", "hey lava",
    "nova scotia is beautiful", "that was a supernova",
    "I was talking about nova yesterday",
    "nova did something cool this morning",
    "a new sofa arrived today", "hey, no thanks",
    "what time is it", "turn off the kitchen lights",
    "is it going to rain tomorrow", "casanova was a legend",
]

# ALL voices: v0.1 proved even non-English phonemizers say the phrase well
# enough to score 1.000 — breadth costs nothing and buys pronunciation range
TRAIN_VOICE_PREFIXES = ("af_", "am_", "bf_", "bm_", "ef_", "em_", "ff_", "hf_",
                        "hm_", "if_", "im_", "jf_", "jm_", "pf_", "pm_", "zf_", "zm_")
HOLDOUT_VOICES = {"af_heart", "bm_george"}   # eval only — never trained on


async def synth(client: httpx.AsyncClient, sem: asyncio.Semaphore, api: str,
                token: str, text: str, voice: str, speed: float, out: Path):
    if out.exists():
        return True
    async with sem:
        try:
            r = await client.post(
                f"{api}/api/v1/voice/tts",
                headers={"Authorization": f"Bearer {token}"},
                json={"text": text, "voice": voice, "speed": speed},
                timeout=60)
            if r.status_code != 200:
                print(f"  skip {out.name}: HTTP {r.status_code}")
                return False
            out.write_bytes(r.content)
            return True
        except httpx.HTTPError as e:
            print(f"  skip {out.name}: {e}")
            return False


def slug(s: str) -> str:
    return re.sub(r"[^a-z0-9]+", "_", s.lower()).strip("_")


async def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="data")
    ap.add_argument("--api", default="http://127.0.0.1:8000")
    ap.add_argument("--token", default=None)
    args = ap.parse_args()

    token = args.token
    if not token:
        env = Path(__file__).resolve().parents[2] / ".env"
        for line in env.read_text().splitlines():
            if line.startswith("NOVA_AUTH_TOKEN="):
                token = line.split("=", 1)[1].strip()
    assert token, "no NOVA_AUTH_TOKEN found; pass --token"

    base = Path(args.out)
    (base / "pos").mkdir(parents=True, exist_ok=True)
    (base / "neg").mkdir(exist_ok=True)
    (base / "eval").mkdir(exist_ok=True)

    async with httpx.AsyncClient() as client:
        r = await client.get(f"{args.api}/api/v1/voice/health",
                             headers={"Authorization": f"Bearer {token}"})
        voices = [v for v in r.json()["voices"]
                  if v.startswith(TRAIN_VOICE_PREFIXES)]
    train_voices = [v for v in voices if v not in HOLDOUT_VOICES]
    print(f"{len(train_voices)} training voices, {len(HOLDOUT_VOICES)} held out")

    sem = asyncio.Semaphore(4)
    jobs = []
    async with httpx.AsyncClient() as client:
        for v in train_voices:
            for i, text in enumerate(POSITIVE_TEXTS):
                for speed in SPEEDS:
                    out = base / "pos" / f"{v}_t{i}_s{int(speed * 100)}.wav"
                    jobs.append(synth(client, sem, args.api, token, text, v, speed, out))
            for j, text in enumerate(NEGATIVE_TEXTS):
                # one speed per (voice, phrase) keeps negatives ~balanced
                speed = SPEEDS[(hash(v) + j) % len(SPEEDS)]
                out = base / "neg" / f"{v}_n{j}_s{int(speed * 100)}.wav"
                jobs.append(synth(client, sem, args.api, token, text, v, speed, out))
        # eval clips: held-out voices, positive + a few negatives each
        for v in sorted(HOLDOUT_VOICES):
            for i, text in enumerate(POSITIVE_TEXTS):
                jobs.append(synth(client, sem, args.api, token, text, v, 1.0,
                                  base / "eval" / f"{v}_pos{i}.wav"))
            for j in (0, 5, 7, 11):   # near-collision, supernova, aboutness, command
                jobs.append(synth(client, sem, args.api, token,
                                  NEGATIVE_TEXTS[j], v, 1.0,
                                  base / "eval" / f"{v}_neg{j}.wav"))
        results = await asyncio.gather(*jobs)

    ok = sum(1 for x in results if x)
    print(f"done: {ok}/{len(jobs)} clips in {base}/")
    (base / "manifest.json").write_text(json.dumps({
        "phrase": PHRASE, "positive_texts": POSITIVE_TEXTS,
        "negative_texts": NEGATIVE_TEXTS, "speeds": SPEEDS,
        "train_voices": train_voices, "holdout_voices": sorted(HOLDOUT_VOICES),
    }, indent=2))


if __name__ == "__main__":
    asyncio.run(main())
