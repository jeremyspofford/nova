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


async def _vram_observed_gb() -> float | None:
    """Largest VRAM footprint any probe has actually seen — a lower bound
    on usable VRAM, never an estimate."""
    async with db.acquire() as conn:
        row = await conn.fetchrow(
            """SELECT max((last_probe->>'vram_gb')::float) AS vram
               FROM curated_models WHERE last_probe->>'vram_gb' IS NOT NULL""")
    return round(row["vram"], 1) if row and row["vram"] else None


async def detect() -> dict:
    return {
        "ram_gb": _ram_gb(),
        "cpu_cores": os.cpu_count(),
        "nvidia_runtime": await _nvidia_runtime(),
        "vram_observed_gb": await _vram_observed_gb(),
        "detected_at": datetime.now(timezone.utc).isoformat(),
    }
