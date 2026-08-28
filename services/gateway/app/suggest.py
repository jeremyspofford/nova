"""Pure hardware -> model-tier suggestion. No I/O in this file at all —
GET /admin/suggest (in admin.py) reads hardware.json and the curated file
and hands both to `suggest()` here, so the tier logic is testable with
plain dicts.

Tier boundaries are keyed on the largest SINGLE GPU's VRAM. ollama does
not shard a model across multiple cards, so summing VRAM across GPUs would
suggest a model that never actually fits on the one card that runs it.
"""
from __future__ import annotations

TIER_27B = "27B-class"
TIER_14B = "14B-class"
TIER_8B = "8-12B"
TIER_4B = "4-8B"
TIER_3B = "3-4B"

# Which curated "family" values populate each tier's model list. 27b shows
# up twice: as the primary pick at its own tier, and — one tier down — as
# a flagged, tight-VRAM-fit quantized alternative (roadmap's "14B-class or
# 27B-quantized-with-tight-fit-warning").
_TIER_FAMILIES: dict[str, tuple[str, ...]] = {
    TIER_27B: ("27b",),
    TIER_14B: ("14b", "27b"),
    TIER_8B: ("8b",),
    TIER_4B: ("4b",),
    TIER_3B: ("2b",),
}

_TIGHT_FIT_NOTE = "quantized; tight VRAM fit at this tier"


def largest_single_gpu_vram_gb(hardware: dict) -> float | None:
    """The biggest single GPU's VRAM, in GB — never the sum across cards."""
    gpus = hardware.get("gpus") or []
    values = [g["vram_mb"] for g in gpus if isinstance(g, dict) and g.get("vram_mb")]
    if not values:
        return None
    return max(values) / 1024


def tier_for_vram_gb(vram_gb: float | None) -> str:
    if vram_gb is None:
        return TIER_3B
    if vram_gb >= 24:
        return TIER_27B
    if vram_gb >= 16:
        return TIER_14B
    if vram_gb >= 10:
        return TIER_8B
    if vram_gb >= 6:
        return TIER_4B
    return TIER_3B


def _rationale(tier: str, vram_gb: float | None) -> str:
    if vram_gb is None:
        return (
            "no GPU detected on this host — a small local model can still run "
            "on CPU, but consider remote/cloud for usable latency."
        )
    if tier == TIER_3B:
        return (
            f"largest single GPU reports {vram_gb:g}GB VRAM, too little for the "
            f"higher tiers — consider remote/cloud if local latency disappoints."
        )
    return f"largest single GPU reports {vram_gb:g}GB VRAM, which fits the {tier} tier."


def models_for_tier(tier: str, curated: list[dict]) -> list[dict]:
    """The curated entries for `tier`, projected to the pinned response shape."""
    out: list[dict] = []
    for family in _TIER_FAMILIES[tier]:
        for entry in curated:
            if entry.get("family") != family:
                continue
            note = entry.get("note", "")
            if tier == TIER_14B and family == "27b":
                note = f"{note} ({_TIGHT_FIT_NOTE})" if note else _TIGHT_FIT_NOTE
            out.append(
                {
                    "slug": entry["slug"],
                    "label": entry["label"],
                    "params_b": entry["params_b"],
                    "min_vram_gb": entry["min_vram_gb"],
                    "note": note,
                }
            )
    return out


def suggest(hardware: dict, curated: list[dict]) -> dict:
    """{tier, engine_suggestion, models, rationale} — the whole /admin/suggest
    answer, pure function of the hardware facts and the curated catalog."""
    vram_gb = largest_single_gpu_vram_gb(hardware)
    tier = tier_for_vram_gb(vram_gb)
    return {
        "tier": tier,
        # S1 dogfoods bundled ollama unconditionally (roadmap: "the wizard's
        # bundled path is dogfooded from day one"); remote/cloud are choices
        # the wizard's engine step offers, never an auto-switch here — the
        # bottom tier's rationale says to consider them instead of this
        # field silently picking for the operator.
        "engine_suggestion": "ollama",
        "models": models_for_tier(tier, curated),
        "rationale": _rationale(tier, vram_gb),
    }
