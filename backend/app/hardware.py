"""Hardware detection — cheap + empirical, on demand, timestamped.

RAM/CPU come from /proc inside the container (on WSL2 that's the VM's
allocation, which is exactly what's available to docker — the honest
number). GPU presence comes from the inference-control sidecar's fixed
/gpu verb (docker nvidia runtime check). VRAM is never guessed: it's
observed from Ollama /api/ps during model probes and read back from the
most recent probe results. No cached hardware.json — the v2 staleness trap.
"""

import logging
import os
from datetime import datetime, timezone

import httpx

from app import db
from app.config import settings

log = logging.getLogger(__name__)


def _ram_gb() -> float | None:
    try:
        with open("/proc/meminfo") as f:
            for line in f:
                if line.startswith("MemTotal:"):
                    kb = int(line.split()[1])
                    return round(kb / 1024 / 1024, 1)
    except (OSError, ValueError, IndexError) as e:
        log.warning("RAM detection failed: %s", e)
    return None


async def _nvidia_runtime() -> bool | None:
    """True/False from the sidecar; None when the sidecar is absent."""
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            resp = await client.get(f"{settings.inference_control_url}/gpu")
            resp.raise_for_status()
            return bool(resp.json().get("nvidia_runtime"))
    except Exception as e:
        log.warning("GPU detection unavailable (sidecar): %s", e)
        return None


async def _gpu_details() -> dict:
    """Measured GPU name + total VRAM from nvidia-smi inside the ollama
    container (sidecar /vram). None when the container is stopped, has no
    GPU access, or there is no NVIDIA GPU — never an estimate."""
    empty = {"gpu_name": None, "vram_total_gb": None}
    try:
        async with httpx.AsyncClient(timeout=25.0) as client:
            resp = await client.get(f"{settings.inference_control_url}/vram")
            resp.raise_for_status()
            gpus = resp.json().get("gpus") or []
    except Exception as e:
        log.warning("VRAM detection unavailable (sidecar): %s", e)
        return empty
    if not gpus:
        return empty
    name = gpus[0]["name"] + (f" ×{len(gpus)}" if len(gpus) > 1 else "")
    return {"gpu_name": name,
            "vram_total_gb": round(sum(g["vram_total_gb"] for g in gpus), 1)}


async def _vram_observed_gb() -> float | None:
    """Largest VRAM footprint any probe has actually seen — a lower bound
    on usable VRAM, never an estimate."""
    async with db.acquire() as conn:
        row = await conn.fetchrow(
            """SELECT max((last_probe->>'vram_gb')::float) AS vram
               FROM curated_models WHERE last_probe->>'vram_gb' IS NOT NULL""")
    return round(row["vram"], 1) if row and row["vram"] else None


async def detect() -> dict:
    nvidia = await _nvidia_runtime()
    details = await _gpu_details() if nvidia else \
        {"gpu_name": None, "vram_total_gb": None}
    return {
        "ram_gb": _ram_gb(),
        "cpu_cores": os.cpu_count(),
        "nvidia_runtime": nvidia,
        **details,
        "vram_observed_gb": await _vram_observed_gb(),
        "detected_at": datetime.now(timezone.utc).isoformat(),
    }
