"""Hardware detection -- GPU, CPU, RAM, disk."""
import json
import json as _json
import logging
import os
import shutil
import subprocess
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from app.redis_client import read_system, write_system

logger = logging.getLogger(__name__)

HARDWARE_JSON_PATH = Path("/app/data/hardware.json")
RECOMMENDED_MODELS_PATH = Path("/app/data/recommended_models.json")


async def detect_hardware() -> dict[str, Any]:
    """Detect GPU, CPU, RAM, and disk -- returns hardware info dict."""
    gpus = _detect_gpus()
    gpu_runtime = _detect_docker_gpu_runtime()

    info = {
        "gpus": gpus,
        "docker_gpu_runtime": gpu_runtime,
        "cpu_cores": os.cpu_count() or 1,
        "ram_gb": _get_ram_gb(),
        "disk_free_gb": _get_disk_free_gb(),
        "detected_at": datetime.now(timezone.utc).isoformat(),
    }

    await write_system("hardware", info)
    # Note: nvidia-smi/rocm-smi are NOT installed in the recovery container
    # (python:3.12-slim). GPU detection only works when called from the host
    # (via detect_hardware.sh -> data/hardware.json). Live detection inside
    # the container will only get CPU/RAM/disk info. This is by design --
    # the two-phase approach from the spec.
    logger.info("Hardware detection complete: %d GPU(s), %d cores, %dGB RAM, %dGB disk free",
                len(gpus), info["cpu_cores"], info["ram_gb"], info["disk_free_gb"])
    return info


async def get_hardware() -> dict[str, Any]:
    """Get cached hardware info from Redis, or detect if not cached."""
    cached = await read_system("hardware")
    if cached:
        return cached
    return await sync_hardware_from_file()


async def sync_hardware_from_file() -> dict[str, Any]:
    """Read data/hardware.json (written by setup.sh) and sync to Redis."""
    if HARDWARE_JSON_PATH.exists():
        try:
            data = json.loads(HARDWARE_JSON_PATH.read_text())
            await write_system("hardware", data)
            logger.info("Synced hardware info from %s", HARDWARE_JSON_PATH)
            return data
        except (json.JSONDecodeError, OSError) as e:
            logger.warning("Failed to read %s: %s", HARDWARE_JSON_PATH, e)

    # No file -- run live detection
    return await detect_hardware()


def get_backend_recommendation(hardware: dict[str, Any]) -> str:
    """Recommend a backend based on detected hardware."""
    gpus = hardware.get("gpus", [])
    if not gpus:
        return "ollama"  # CPU-only -> Ollama

    total_vram = sum(g.get("vram_gb", 0) for g in gpus)
    if total_vram >= 8:
        return "vllm"

    return "ollama"


async def get_full_recommendation(hardware: dict | None = None) -> dict:
    """Return recommended backend + model based on hardware."""
    if hardware is None:
        hardware = await get_hardware()

    backend = get_backend_recommendation(hardware)
    gpus = hardware.get("gpus", [])
    total_vram = sum(g.get("vram_gb", 0) for g in gpus)

    try:
        models = _json.loads(RECOMMENDED_MODELS_PATH.read_text())
    except (FileNotFoundError, _json.JSONDecodeError):
        models = []

    candidates = [
        m for m in models
        if backend in m.get("backends", [])
        and m.get("category") != "embedding"
        and (total_vram == 0 or m.get("min_vram_gb", 0) <= total_vram)
    ]
    candidates.sort(key=lambda m: m.get("min_vram_gb", 0), reverse=True)
    model = candidates[0] if candidates else None

    model_id = ""
    if model:
        model_id = model.get("ollama_id", model["id"]) if backend == "ollama" else model["id"]

    reason = f"{'GPU detected (' + str(total_vram) + ' GB VRAM)' if total_vram > 0 else 'No GPU detected'}"
    if model:
        reason += f". {model['name']} fits your hardware."

    return {"backend": backend, "model": model_id, "reason": reason}


def _detect_gpus() -> list[dict]:
    """Detect GPUs using nvidia-smi or rocm-smi."""
    gpus = _detect_nvidia_gpus()
    if gpus:
        return gpus
    return _detect_amd_gpus()


def _detect_nvidia_gpus() -> list[dict]:
    """Detect NVIDIA GPUs via nvidia-smi."""
    try:
        result = subprocess.run(
            ["nvidia-smi", "--query-gpu=index,name,memory.total", "--format=csv,noheader,nounits"],
            capture_output=True, text=True, timeout=10
        )
        if result.returncode != 0:
            return []
        gpus = []
        for line in result.stdout.strip().split("\n"):
            if not line.strip():
                continue
            parts = [p.strip() for p in line.split(",")]
            if len(parts) >= 3:
                try:
                    gpus.append({
                        "vendor": "nvidia",
                        "model": parts[1],
                        "vram_gb": round(int(parts[2]) / 1024, 1),
                        "index": int(parts[0]),
                    })
                except ValueError:
                    continue
        return gpus
    except (FileNotFoundError, subprocess.TimeoutExpired):
        return []


def _detect_amd_gpus() -> list[dict]:
    """Detect AMD GPUs via rocm-smi."""
    try:
        result = subprocess.run(
            ["rocm-smi", "--showproductname", "--showmeminfo", "vram", "--json"],
            capture_output=True, text=True, timeout=10
        )
        if result.returncode != 0:
            return []
        data = json.loads(result.stdout)
        gpus = []
        for key, val in data.items():
            if not key.startswith("card"):
                continue
            try:
                idx = int(key.replace("card", ""))
                name = val.get("Card Series", "AMD GPU")
                vram_bytes = int(val.get("VRAM Total Memory (B)", 0))
                gpus.append({
                    "vendor": "amd",
                    "model": name,
                    "vram_gb": round(vram_bytes / (1024 ** 3), 1),
                    "index": idx,
                })
            except ValueError:
                continue
        return gpus
    except (FileNotFoundError, subprocess.TimeoutExpired, json.JSONDecodeError):
        return []


def _detect_docker_gpu_runtime() -> str:
    """Check if Docker has a GPU runtime available."""
    try:
        result = subprocess.run(
            ["docker", "info"], capture_output=True, text=True, timeout=10
        )
        output = result.stdout.lower()
        if "nvidia" in output:
            return "nvidia"
        if "rocm" in output or "amd" in output:
            return "rocm"
    except (FileNotFoundError, subprocess.TimeoutExpired):
        pass
    return ""


def _get_ram_gb() -> int:
    """Get total RAM in GB."""
    try:
        with open("/proc/meminfo") as f:
            for line in f:
                if line.startswith("MemTotal:"):
                    kb = int(line.split()[1])
                    return kb // (1024 * 1024)
    except OSError:
        pass
    return 0


def _get_disk_free_gb() -> int:
    """Get free disk space in GB for the root filesystem."""
    usage = shutil.disk_usage("/")
    return int(usage.free / (1024 ** 3))
