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
succeeded but admin.py's `_ollama_reported_vram` never runs for it) falls
back to the estimate exactly as if there were no probe row at all.

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

So: the free-VRAM math in admin.py uses ONLY /api/ps's size_vram (ollama's
own, per-model, attributable number), summed across every model /api/ps
reports resident, subtracted from the host total. It deliberately never
reads or reconciles a raw nvidia_smi delta at request time — that number
conflates concurrent processes and cannot be attributed to a single model.

That choice under-counts the transient compute-buffer overhead the S2
nvidia_smi delta hints at, which is exactly why "fits by any positive
margin" is not "comfortable" below: TIGHT_HEADROOM_FRACTION leaves room for
the overhead this module's inputs cannot see. A model that consumes the
last quarter of free VRAM is "tight," not "comfortable," even though it
technically fits.
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
