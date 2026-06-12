"""Inference host hardware profile.

The machine running llm-gateway is not necessarily the machine running inference —
the profile describes whatever LOCAL_INFERENCE_URL points at. Sources, by trust:

- detected: ./install ran detect-hardware on the inference machine and the JSON
  landed in the runtime dir (volume-mounted; GPU tooling doesn't exist in here).
- declared: the user supplied a remote host's specs via PUT /hardware.
- unknown: no file — nothing is gated, the UI prompts for specs.

Observed signals (Ollama /api/ps VRAM-in-use) annotate but never gate.
"""
from __future__ import annotations

import json
import logging
import time
from pathlib import Path
from typing import Any

import httpx

from .config import settings

logger = logging.getLogger(__name__)


def _profile_path() -> Path:
    return Path(settings.runtime_dir) / "hardware.json"


def read_profile() -> dict[str, Any]:
    path = _profile_path()
    try:
        if path.exists():
            data = json.loads(path.read_text())
            if isinstance(data, dict):
                data.setdefault("source", "detected")
                return data
    except Exception as exc:
        logger.warning("hardware profile unreadable: %s", exc)
    return {"source": "unknown", "gpus": [], "ram_gb": None, "cpu_cores": None, "disk_free_gb": None}


def write_declared(profile: dict[str, Any]) -> dict[str, Any]:
    data = {
        "source": "declared",
        "gpus": profile.get("gpus") or [],
        "ram_gb": profile.get("ram_gb"),
        "cpu_cores": profile.get("cpu_cores"),
        "disk_free_gb": profile.get("disk_free_gb"),
        "declared_at": time.time(),
    }
    path = _profile_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=2))
    return data


def total_vram_gb(profile: dict[str, Any]) -> float:
    return sum(float(g.get("vram_gb") or 0) for g in profile.get("gpus") or [])


def shape_loaded_models(models: list[dict]) -> list[dict]:
    """Per-model VRAM offload detail from Ollama /api/ps — the diagnostic core.

    vram_pct 0 = fully on CPU (GPU invisible to Ollama, or no GPU);
    1-99 = partial offload (model too big for the GPU); 100 = fully resident.
    """
    out = []
    for m in models:
        size = m.get("size") or 0
        vram = m.get("size_vram") or 0
        out.append({
            "name": m.get("name"),
            "size_bytes": size,
            "vram_bytes": vram,
            "vram_pct": round(vram / size * 100) if size else None,
        })
    return out


async def observe() -> dict[str, Any]:
    """Live best-effort signals from the inference host. Never raises."""
    out: dict[str, Any] = {
        "gpu_in_use": None,
        "models_loaded": None,
        "loaded": [],
        "checked_at": time.time(),
    }
    if settings.nova_inference_backend not in ("ollama", "ollama-host"):
        return out
    try:
        async with httpx.AsyncClient(timeout=3.0) as client:
            r = await client.get(f"{settings.local_inference_url}/api/ps")
            r.raise_for_status()
            models = r.json().get("models") or []
        out["models_loaded"] = len(models)
        out["loaded"] = shape_loaded_models(models)
        if models:
            out["gpu_in_use"] = any(m["vram_bytes"] > 0 for m in out["loaded"])
    except Exception as exc:
        logger.debug("observe failed: %s", exc)
    return out


def fits(profile: dict[str, Any], min_vram_gb: float, min_ram_gb: float) -> bool | None:
    """True/False against the profile; None when the profile is unknown."""
    if profile.get("source") == "unknown":
        return None
    vram = total_vram_gb(profile)
    if vram > 0:
        return min_vram_gb <= vram
    ram = profile.get("ram_gb")
    if ram:
        return min_ram_gb <= float(ram)
    return None
