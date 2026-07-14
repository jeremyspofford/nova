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

from app import db, settings_store
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


def _platform() -> str:
    """Where this container actually lives — containers share the host
    kernel, so /proc/version names the VM flavor."""
    try:
        with open("/proc/version") as f:
            v = f.read().lower()
        if "microsoft" in v:
            return "wsl2"
        if "linuxkit" in v:
            return "docker-desktop"
    except OSError:
        pass
    return "linux"


_MEMORY_NOTES = {
    "wsl2": ("RAM is the WSL2 VM's allocation (defaults to ~50% of the "
             "host's) — the real ceiling for the bundled Ollama. Raise it in "
             ".wslconfig ([wsl2] memory=...) + `wsl --shutdown` if the host "
             "has more."),
    "docker-desktop": ("RAM is the Docker Desktop VM's allocation, NOT the "
                       "host's. If models run in a host Ollama (e.g. macOS "
                       "unified memory), set the memory override below so "
                       "sizing uses the machine's real memory."),
}


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


async def _probe_observations() -> dict:
    """What probes have actually seen: the largest VRAM footprint (a lower
    bound, never an estimate) and whether any GPU-active run has happened —
    on a machine with no NVIDIA runtime that means a unified-memory GPU
    (e.g. Apple Metal via a host-run Ollama)."""
    async with db.acquire() as conn:
        row = await conn.fetchrow(
            """SELECT max((last_probe->>'vram_gb')::float) AS vram,
                      bool_or((last_probe->>'gpu_active')::bool) AS gpu_seen
               FROM curated_models WHERE last_probe IS NOT NULL""")
    return {"vram_observed_gb": round(row["vram"], 1) if row and row["vram"] else None,
            "gpu_seen": bool(row and row["gpu_seen"])}


async def detect() -> dict:
    nvidia = await _nvidia_runtime()
    details = await _gpu_details() if nvidia else \
        {"gpu_name": None, "vram_total_gb": None}
    obs = await _probe_observations()
    platform = _platform()
    ram = _ram_gb()
    override = settings_store.get("inference.memory_gb_override") or 0
    return {
        "ram_gb": ram,
        "cpu_cores": os.cpu_count(),
        "platform": platform,
        "memory_note": _MEMORY_NOTES.get(platform),
        "memory_override_gb": override or None,
        # what fit checks size against: the operator override wins because
        # it exists precisely for setups where the VM hides the real memory
        "sizing_ram_gb": override or ram,
        "nvidia_runtime": nvidia,
        **details,
        "vram_observed_gb": obs["vram_observed_gb"],
        # GPU-active probes without an NVIDIA runtime = unified memory
        "unified_gpu": bool(obs["gpu_seen"] and not nvidia),
        "detected_at": datetime.now(timezone.utc).isoformat(),
    }
