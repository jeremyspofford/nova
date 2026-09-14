"""Is the card actually available — measured, not assumed.

One family, one check: `inference_degraded`. It fires when a model's recent
throughput has collapsed against what this machine's own history says is
normal for that model, and it carries BOTH numbers plus the card's live free
VRAM.

## What it is for
On 2026-09-12 the owner played a video game on this machine. It held ~7 GB
of VRAM and pinned the shader cores at 347 W for about six hours. Two of his
chat turns timed out at the gateway's 300 s read limit, an eval suite scored
zero of twenty-three cases, and nothing in Nova noticed. Ollama's own timing
lines put generation at 0.25 tokens per second; with the game closed the
same model, same context, measured 67.5.

This check is the sentence that was missing, and it is the machine's own
numbers rather than an adjective: "qwen3.8:27b is generating at 0.3 tok/s;
its usual here is 67." A reader can act on that. "Inference is slow" is a
feeling.

## It states, it never decides (owner ruling 2026-09-03)
Nothing here refuses a turn, falls back to a smaller model, or pauses a run.
Routing around a contended card is a decision on the owner's behalf and S10's
mode switch is where that conversation belongs if he ever wants it. A check
may state that a call cannot run; it may never decide that it may not.

## Why it cannot cry wolf
- The baseline is the model's OWN history on THIS machine
  (app/model_speed.py), so a model that has always been slow here has a slow
  baseline and is never reported as degraded.
- Both windows use medians, so one 300 s timeout among twenty healthy rounds
  moves nothing.
- Both sides need enough rounds to be a measurement at all; too few is
  CannotCheck ("nothing to compare"), never a finding.
- The fingerprint is over the DERIVED facts — the model, and the ratio
  rounded to a bucket — never the live figure, so a rate that drifts from
  0.3 to 0.4 is the same news and folds instead of raising a second notice.
  (v3 hashed a model's own sentence and one re-wording became fourteen phone
  pushes in eight hours.)
"""

from __future__ import annotations

import httpx

from app import model_speed, peers, settings_store
from app.checks import CannotCheck, Check, Finding

# The gateway's live card reading. Core has no route to the GPU of its own —
# the gateway is the only thing that can run nvidia-smi — so free VRAM here
# is the same fact the Models page shows.
VRAM_PATH = "/admin/vram"
VRAM_TIMEOUT = httpx.Timeout(connect=5.0, read=15.0, write=5.0, pool=5.0)

DEGRADED_FACTOR_KEY = "inference.degraded_factor"


def _bucket(ratio: float) -> int:
    """The ratio as a coarse bucket, for the fingerprint only.

    A finding's facts are what MAKE the condition true, and the live rate is
    not one of them — it moves every round, and a figure that moves inside a
    fingerprint raises a fresh notice every beat. The bucket changes when the
    situation changes materially (a 5x slowdown becoming a 50x one) and not
    when the same slowdown is measured again.
    """
    if ratio >= 100:
        return 100
    if ratio >= 50:
        return 50
    if ratio >= 20:
        return 20
    if ratio >= 10:
        return 10
    return 5


async def _free_vram_gb(app) -> tuple[float | None, str | None]:
    """(free GB after a switch, reason-if-unknown) from the gateway.

    Never fatal to the check. The throughput collapse IS the finding; the
    free VRAM is context for it — the first question the owner will have is
    what took the card — so a gateway that cannot answer costs the finding a
    fact, not its existence.
    """
    try:
        async with peers.client(app, peers.GATEWAY, VRAM_TIMEOUT) as client:
            resp = await client.get(VRAM_PATH)
            resp.raise_for_status()
    except (httpx.HTTPError, peers.PeerUnconfigured) as exc:
        return None, f"the gateway could not be asked about the card — {peers.reason(exc)}"
    body = resp.json()
    free = body.get("free_after_switch_gb")
    if free is None:
        free = body.get("free_gb")
    if free is None:
        return None, body.get("reason") or body.get("resident_reason") or "the card is unreadable"
    return float(free), None


async def degraded(app, pool) -> list[Finding]:
    """Every model generating materially slower than its own normal."""
    factor = await settings_store.read_value(pool, DEGRADED_FACTOR_KEY)
    speeds = await model_speed.speeds(pool)
    comparable = [s for s in speeds.values() if s.ratio is not None]
    if not comparable:
        raise CannotCheck(
            "no model has both recent rounds and enough history to compare them against — "
            f"nothing to measure (needs {model_speed.MIN_ROUNDS_RECENT} rounds in the last "
            f"{model_speed.RECENT_HOURS} h and {model_speed.MIN_ROUNDS_BASELINE} in the last "
            f"{model_speed.BASELINE_HOURS // 24} days)"
        )

    slow = [s for s in comparable if s.ratio >= factor]
    if not slow:
        return []

    free_gb, vram_reason = await _free_vram_gb(app)
    findings = []
    for speed in sorted(slow, key=lambda s: -s.ratio):
        facts: dict = {
            "model": speed.model,
            # The bucket, not the rate — see `_bucket`.
            "slowdown_bucket": _bucket(speed.ratio),
        }
        facts["recent_tok_per_s"] = speed.recent
        facts["baseline_tok_per_s"] = speed.baseline
        facts["recent_rounds"] = speed.recent_rounds
        facts["baseline_rounds"] = speed.baseline_rounds
        if free_gb is not None:
            facts["free_vram_gb"] = round(free_gb, 1)
        else:
            facts["free_vram_reason"] = vram_reason
        findings.append(
            Finding(
                key=f"inference_degraded:{speed.model}",
                title=_title(speed, free_gb, vram_reason),
                facts=facts,
            )
        )
    return findings


def _title(speed: model_speed.Speed, free_gb: float | None, vram_reason: str | None) -> str:
    """The sentence, composed in code from the two numbers.

    Never the word "slow" on its own. `0.3 tok/s against a usual 67` is
    something an owner can act on; an adjective is something he has to come
    and check for himself, which is what he had to do on the 12th.
    """
    line = (
        f"{speed.model} is generating at {speed.recent:g} tok/s; "
        f"its usual here is {speed.baseline:g} ({speed.ratio:g}x slower)"
    )
    if free_gb is not None:
        return f"{line}. The card has {free_gb:.1f} GB free"
    return f"{line}. Free VRAM is unknown — {vram_reason}"


CHECKS: tuple[Check, ...] = (
    Check(
        name="inference_degraded",
        describe=(
            "A model is generating far slower than this machine's own history for it — "
            "usually something else is holding the GPU."
        ),
        urgent=False,
        run=degraded,
    ),
)

NAMES: tuple[str, ...] = tuple(check.name for check in CHECKS)
