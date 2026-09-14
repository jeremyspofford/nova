"""Fit verdicts: does a model actually load on THIS host, right now.

Pure — no I/O. admin.py owns reading the card (app/devices_vram.py, one
live `nvidia-smi` call), ollama's live /api/ps (what is currently resident,
the one per-model attributable number on this host), and the `probes` table
(a measured VRAM reading from a real POST /admin/probe run). This module
only ever turns three numbers and a source into a verdict, so the
boundaries are testable with plain floats.

## THE FRAME, STATED ONCE, SO THE TWO SIDES CANNOT DRIFT (rewritten S22)
Every number here is the MODEL'S OWN VRAM, and every number is live.

  - `total_gb` / `free_gb` come from the card at the moment of the
    question. `free_gb` therefore already has the desktop baseline, and any
    other process on the machine, subtracted by the driver — nothing on
    this side has to model them.
  - `needed_gb` is what the MODEL costs: weights plus its KV cache, not the
    machine's baseline. The baseline lives on the FREE side only. It is
    never counted twice, because it is never counted here at all.

This replaces the S2f-R3 "whole-card" frame, and the reason it had to go is
worth keeping. That frame defined `needed_gb` as the figure nvidia-smi's
`used` counter shows while the model serves — baseline included — which
forced `free_gb` to stay the card's FULL capacity so the baseline would not
be subtracted twice. "Free equals total, always" was a correct consequence
of that frame and a catastrophic property in practice: on 2026-09-12 a
video game held ~7 GB of this card for six hours and free VRAM read 24 GB
the entire time. A free number that cannot move cannot warn anybody. Once
free is read from the card, the baseline is already gone from it, so the
needed side must stop carrying it.

## Precedence for `needed_gb` (S22, extending ruling S2e-R2)
`needed_gb_for()` takes the first of these that exists:

  1. A probe row's measured `vram_mb` — badge `verified`. Since S22 that
     figure is ollama's own /api/ps `size_vram` for the model that just
     answered: per-model, attributable, weights + KV at the serving
     context. A probe row with no VRAM reading (a remote/cloud backend
     probe succeeded, so nothing was resident to read) falls through
     exactly as if there were no row at all.
  2. The registry's own `size_bytes` — badge `estimated`. The download's
     real byte count, a FACT from the source ollama pulls from, beating a
     hand-written integer. It states weights and not the KV cache, so it
     runs slightly optimistic; see TIGHT_HEADROOM_FRACTION below, which is
     what that gap is for.
  3. curated_models.json's `min_vram_gb` — badge `estimated`. The last
     resort, and the only one in the old whole-card frame: these integers
     were re-anchored in S2f-R3 to include the ~2.6 GB desktop baseline, so
     in THIS frame they read high. An upper bound errs toward `tight` and
     `wont_fit`, which is the safe direction for an estimate nobody
     measured; a probe or a byte count always wins over one.

## Why "fits by a positive margin" is still not "comfortable"
Neither a probe's `size_vram` nor a registry byte count accounts for
ollama's transient compute/activation buffers during generation, and the
free reading is a single instant that says nothing about the next one.
TIGHT_HEADROOM_FRACTION is the room left for both: a model that consumes
the last quarter of free VRAM is `tight`, not `comfortable`, even though it
technically fits.

## Eviction-aware free VRAM (ruling S2f-R2, kept — the "8B won't fit" bug)
The 2026-08-29 walk found that free VRAM computed as what is unused RIGHT
NOW reads a switch as impossible the instant anything is resident: with a
17.4 GB model loaded on a 24 GB card, a 9.3 GB model that fits standalone
with room to spare read `wont_fit`. That math answers "is there room for
this ALONGSIDE what is running" when a model picker is asking "will this
fit AFTER I switch to it" — and switching local models on this host EVICTS
whatever ollama holds (confirmed live: loading the 27B, then the 8B,
returned the 27B's VRAM to /api/ps in the same session).
`free_gb_after_switch` below answers the second question: the card's live
free memory, PLUS everything ollama currently holds and would give back.

The `swappable` flag the old version summed over is DELETED. Its own
docstring conceded nothing in this system ever produced an entry that had
it, which made the subtraction a no-op dressed as a computation — a
function pretending to compute something. If a non-reclaimable consumer
ever appears it will show up where it actually belongs: in the card's live
`used` reading, which every number here now comes from.
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
# buffers live during generation (see the module docstring), and none of
# the three `needed_gb` sources accounts for them.
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

    Any of the three numbers being unknown (the card could not be read, the
    active backend isn't ollama, ollama's /api/ps was unreachable, or the
    model has no estimate and no probe) is answered honestly as 'unknown'
    with the stated reason. Whichever numbers ARE known are still reported —
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
            VERDICT_COMFORTABLE if headroom_fraction > TIGHT_HEADROOM_FRACTION else VERDICT_TIGHT
        )

    return {
        "verdict": verdict,
        "needed_gb": round(needed_gb, 1),
        "free_gb": round(free_gb, 1),
        "total_gb": round(total_gb, 1),
        "source": source,
        "reason": None,
    }


def free_gb_after_switch(free_mb: float, resident: list[dict]) -> float:
    """VRAM available to a candidate model AFTER a switch — not right now.

    The card's live free memory plus everything ollama currently holds,
    because loading a different local model on this engine evicts all of it
    (ruling S2f-R2, see the module docstring). `free_mb` is the driver's own
    figure, so every consumer this container cannot even enumerate — the
    compositor, a Windows-side game — is already subtracted from it.
    `resident` is admin.py's per-model reading of ollama's live /api/ps,
    each entry at minimum `{"vram_mb": float}`.
    """
    reclaimable_mb = sum(entry.get("vram_mb") or 0 for entry in resident)
    return (free_mb + reclaimable_mb) / 1024


def needed_gb_for(
    model: dict, probe_row: dict | None, size_bytes: int | None = None
) -> tuple[float | None, str]:
    """(needed_gb, source) for one model — see the precedence in the module
    docstring: a measured probe, then the registry's byte count, then the
    curated integer.

    Returns `(None, SOURCE_ESTIMATED)` when the model has none of the three,
    which `compute_fit` renders as an honest `unknown` rather than a zero.
    """
    if probe_row is not None:
        vram_mb = probe_row.get("vram_mb")
        if vram_mb is not None:
            return vram_mb / 1024, SOURCE_VERIFIED
    if size_bytes:
        return size_bytes / (1024**3), SOURCE_ESTIMATED
    return model.get("min_vram_gb"), SOURCE_ESTIMATED
