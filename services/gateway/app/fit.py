"""Fit verdicts: does a model actually load on THIS host, right now.

Pure — no I/O. admin.py owns reading hardware.json (the host's total VRAM),
ollama's live /api/ps (what's currently resident, to get FREE VRAM — ruling
S2e-R2: never installed-sum, never a static per-tier floor alone), and the
`probes` table (a measured VRAM reading from a real POST /admin/probe run).
This module only ever turns three numbers and a source into a verdict, so
the boundaries are testable with plain floats.

## Precedence (ruling S2e-R2)
`needed_gb_for()` prefers a probe row's measured `vram_mb` — badge
`verified` — over the curated catalog's `min_vram_gb` estimate — badge
`estimated`. A probe row with no VRAM reading (a remote/cloud backend probe
succeeded but admin.py's `_footprint_vram_mb` bracket never runs for it,
kind != 'ollama') falls back to the estimate exactly as if there were no
probe row at all.

## Resolving the S2 nvidia_smi anomaly (docs/plans/rebuild/slice-02-carries.md)
S2's two-model measurement (tests/e2e/measurements/s2-two-model.json)
recorded the 27B's nvidia_smi delta (23670-13671 MiB ~= 9999 MiB) sitting
beside ollama's own /api/ps size_vram for that load (16594 MiB) with no
explanation for why they disagree. They were never going to reconcile by
subtraction, because they measure different things:

  - nvidia_smi's "used" counter is the WHOLE card at one instant: the
    desktop compositor, any other resident model ollama's keep_alive
    window had not yet evicted, and ollama's own scratch/activation
    buffers while a request is actively generating.
  - /api/ps's size_vram is ollama's own count of ONE model's weights + KV
    cache — not the transient compute buffers a live generation needs on
    top of that. (The 8B was very plausibly still partially resident at
    the "before" sample the JSON records, which is exactly the kind of
    concurrent-process noise a raw nvidia_smi delta cannot attribute to
    one model — see the JSON's own `notes` field.)

So: admin.py reads /api/ps's size_vram (ollama's own, per-model,
attributable number) to know WHAT is resident. It deliberately never reads
or reconciles a raw, undirected nvidia_smi snapshot for that purpose — that
number conflates concurrent processes and cannot be attributed to a single
model on its own.

That gap in what /api/ps alone can see is exactly why "fits by any positive
margin" is not "comfortable" below: TIGHT_HEADROOM_FRACTION leaves room for
compute-buffer overhead this module's inputs cannot see. A model that
consumes the last quarter of free VRAM is "tight," not "comfortable," even
though it technically fits.

## Eviction-aware free VRAM (ruling S2f-R2 — "the 8B won't fit" bug)
The 2026-08-29 walk found free-VRAM math above computed as
`total - sum(resident)` reads a switch as impossible the instant ANYTHING
is resident: with a 17.4GB model loaded, free_gb=7.8, so even a 9.3GB
8B model (a card that fits it standalone with room to spare) read
`wont_fit`. That math was answering "is there room for this ALONGSIDE what
is running now" when the real question a model picker asks is "will this
fit AFTER I switch to it" — and on this host, switching to a different
local model EVICTS whatever ollama currently holds resident (confirmed
live: loading the 27B, then switching to the 8B, returned the 27B's VRAM to
/api/ps within the same session). `free_vram_gb_for_switch` below answers
the second question: a resident entry on the SAME switchable engine is
given back to `total_gb` in full, not subtracted. Nothing in this system
produces a resident entry that ISN'T evictable this way today — there is no
pinned/non-swappable local model and no second concurrent GPU consumer this
module can see — but the function still sums over an explicit per-entry
`swappable` flag rather than short-circuiting straight to `total_gb`, so a
future non-reclaimable case (a pinned model, a second engine sharing the
card) has an obvious place to subtract instead of being silently modeled
away.

## needed_gb is a WHOLE-CARD figure (ruling S2f-R3 — the 17-vs-22 bug, and
the delta-by-construction landmine review caught in the first fix)
/api/ps's size_vram is ollama's own count of a model's WEIGHTS (+ its own
KV cache accounting) — not the full total footprint (baseline non-model
GPU usage + weights + KV at the serving context + ollama's transient
compute buffers) that actually has to fit in VRAM. This host always
carries a real, non-zero baseline (Xwayland/WSL2, ~2.6GB) even with no
model loaded at all — nvidia-smi's "used" counter includes it, and so does
what the operator sees when they check. The 2026-08-29 walk measured
qwen3.8:27b at size_vram=17.4GB while nvidia-smi showed 22369/24576 MiB
(~21.8GB) actually in use with it resident — the gap this ruling exists to
close. curated_models.json's min_vram_gb for it is re-anchored to 22
(rounded up from that 21.8GB measurement, not down): a WHOLE-CARD figure,
baseline included, because that is the number that genuinely has to fit
under `total_gb`.

admin.py's POST /admin/probe now measures the SAME whole-card quantity: a
SINGLE nvidia-smi used-MiB reading taken immediately AFTER the request
that loads the model answers — never a before/after delta. A first version
of this fix bracketed before/after and recorded the DIFFERENCE, and review
caught two compounding bugs in that shape: (1) eviction-contaminated — a
switch EVICTS whatever was resident before (`free_vram_gb_for_switch`'s
own premise, above), so probing model B while model A was resident would
have recorded (baseline+B) - (baseline+A) = B-A, wildly understating B
whenever A != B — chatting on the 8B, then probing the 27B, would have
stored roughly 10GB as "verified" and made the 27B read `comfortable`,
reintroducing the exact bug this whole slice exists to kill, one layer
down; and (2) even probing the SAME model twice, a delta EXCLUDES the
~2.6GB baseline the curated whole-card figure INCLUDES, so probed and
curated `needed_gb` lived in two different frames that could never agree.
A single AFTER reading fixes both: it is eviction-IMMUNE (whatever the
completion just answered from IS what's resident at that instant,
regardless of what came before), and it lands in the same whole-card frame
as the curated catalog. See admin.py's `_footprint_vram_mb` for the full
reasoning and the non-positive-reading guard.

## THE FRAME, STATED ONCE, SO THE TWO SIDES CANNOT DRIFT AGAIN
`needed_gb` — curated estimate OR probed measurement, `needed_gb_for`
below makes no distinction — is ALWAYS a whole-card figure: baseline
non-model usage + weights + KV + buffers, the number that has to fit under
`total_gb`. `free_gb`/`total_gb` (`free_vram_gb_for_switch` above) are
therefore the card's FULL capacity, never total-minus-baseline: the
baseline already lives on the NEEDED side of every comparison this module
makes, so subtracting it from FREE too would double-count it — which is
also why Fix B's "nothing resident today is non-swappable, so free equals
total" is correct in this frame, not despite it. Whoever adds a new source
of `needed_gb` (a different probe strategy, a smarter estimate) must keep
it in this same whole-card frame, or the two sides silently stop meaning
the same thing again.
"""
from __future__ import annotations

VERDICT_COMFORTABLE = "comfortable"
VERDICT_TIGHT = "tight"
VERDICT_WONT_FIT = "wont_fit"
VERDICT_UNKNOWN = "unknown"

SOURCE_VERIFIED = "verified"
SOURCE_ESTIMATED = "estimated"

# A model that leaves only a thin sliver of free VRAM after loading is
# "tight," not "comfortable" — the sliver is where ollama's own compute
# buffers live during generation (see the module docstring), and neither
# size_vram (verified) nor min_vram_gb (estimated) accounts for them.
TIGHT_HEADROOM_FRACTION = 0.25

DEFAULT_UNKNOWN_REASON = "free VRAM could not be determined"


def compute_fit(
    needed_gb: float | None,
    free_gb: float | None,
    total_gb: float | None,
    *,
    source: str,
    reason: str | None = None,
) -> dict:
    """One model's fit verdict.

    Any of the three numbers being unknown (no GPU detected, the active
    backend isn't ollama, ollama's /api/ps was unreachable, or the model has
    no estimate and no probe) is answered honestly as 'unknown' with the
    stated reason. Whichever numbers ARE known are still reported —
    `needed_gb` unknown does not erase a perfectly real `free_gb`/`total_gb`
    (or vice versa); only the field that is actually undetermined renders
    as None. Never a guess dressed up as a measurement either way.
    """
    if needed_gb is None or free_gb is None or total_gb is None:
        return {
            "verdict": VERDICT_UNKNOWN,
            "needed_gb": round(needed_gb, 1) if needed_gb is not None else None,
            "free_gb": round(free_gb, 1) if free_gb is not None else None,
            "total_gb": round(total_gb, 1) if total_gb is not None else None,
            "source": source,
            "reason": reason or DEFAULT_UNKNOWN_REASON,
        }

    if needed_gb > free_gb:
        verdict = VERDICT_WONT_FIT
    else:
        headroom_gb = free_gb - needed_gb
        headroom_fraction = (headroom_gb / free_gb) if free_gb > 0 else 0.0
        verdict = (
            VERDICT_COMFORTABLE
            if headroom_fraction > TIGHT_HEADROOM_FRACTION
            else VERDICT_TIGHT
        )

    return {
        "verdict": verdict,
        "needed_gb": round(needed_gb, 1),
        "free_gb": round(free_gb, 1),
        "total_gb": round(total_gb, 1),
        "source": source,
        "reason": None,
    }


def free_vram_gb_for_switch(total_gb: float, resident: list[dict]) -> float:
    """VRAM available to a candidate model AFTER a switch — not right now.

    Ruling S2f-R2 (see module docstring): loading a different local model on
    this same ollama engine evicts everything it currently holds resident,
    so a resident entry here is not a competitor for a switch candidate's
    fit UNLESS it is explicitly marked `swappable: False` (defaults to True
    — nothing in this system produces a non-swappable entry today, see the
    docstring, but the flag is real so a future one has somewhere to land).
    `resident` is admin.py's own per-model reading of ollama's live /api/ps,
    each entry at minimum `{"vram_mb": float}`.
    """
    non_reclaimable_mb = sum(
        entry.get("vram_mb") or 0 for entry in resident if not entry.get("swappable", True)
    )
    return total_gb - non_reclaimable_mb / 1024


def needed_gb_for(model: dict, probe_row: dict | None) -> tuple[float, str]:
    """(needed_gb, source) for one curated model entry.

    A probe row's measured `vram_mb` wins when present; a probe row that
    exists but carries no VRAM reading (kind != 'ollama') falls back to the
    curated estimate exactly as if there were no row at all.
    """
    if probe_row is not None:
        vram_mb = probe_row.get("vram_mb")
        if vram_mb is not None:
            return vram_mb / 1024, SOURCE_VERIFIED
    return model["min_vram_gb"], SOURCE_ESTIMATED
