"""API routes for inference backend selection, bundled lifecycle, and status.

Backends come in two flavors:
  * bundled — Nova starts/stops an inference container (compose profile)
  * external — a user-run server reached over HTTP at a configured URL

These routes start/stop bundled containers, record which backend the gateway
routes to, report live reachability, and expose host hardware as an advisory.
"""
import json
import logging
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException

from app.inference.controller import (
    bundled_containers_status,
    clear_backend,
    get_backend_status,
    select_backend,
    start_bundled_backend,
    stop_bundled_backend,
)
from app.inference.hardware import (
    detect_hardware,
    get_backend_recommendation,
    get_full_recommendation,
    get_hardware,
)
from app.routes import _check_admin

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/v1/recovery/inference", tags=["inference"])

RECOMMENDED_MODELS_PATH = Path("/app/data/recommended_models.json")

# Supported inference server types, for the Settings UI to offer. `bundled`
# means Nova can also run it as a compose-profile container; every backend can
# alternatively be an external, user-run server reached over HTTP. LM Studio is
# a desktop app and "openai" is a URL to any OpenAI-compatible endpoint — both
# external-only. `gpu_required` gates bundled starts on CPU-only hosts.
SUPPORTED_BACKENDS = [
    {"name": "ollama", "label": "Ollama", "kind": "ollama-api", "default_port": 11434, "bundled": True, "gpu_required": False},
    {"name": "llamacpp", "label": "llama.cpp", "kind": "openai", "default_port": 8080, "bundled": True, "gpu_required": False},
    {"name": "vllm", "label": "vLLM", "kind": "openai", "default_port": 8000, "bundled": True, "gpu_required": True},
    {"name": "sglang", "label": "SGLang", "kind": "openai", "default_port": 30000, "bundled": True, "gpu_required": True},
    {"name": "lmstudio", "label": "LM Studio", "kind": "openai", "default_port": 1234, "bundled": False, "gpu_required": False},
    {"name": "openai", "label": "OpenAI-compatible", "kind": "openai", "default_port": None, "bundled": False, "gpu_required": False},
]


# ── Hardware (host advisory) ──────────────────────────────────────────────────


@router.get("/hardware")
async def get_hardware_info(_: None = Depends(_check_admin)):
    """Return detected host hardware (GPU, CPU, RAM, disk). Advisory only —
    inference runs on an external server, not in a Nova container."""
    hw = await get_hardware()
    recommendation = get_backend_recommendation(hw)
    return {**hw, "recommended_backend": recommendation}


@router.post("/hardware/detect")
async def redetect_hardware(_: None = Depends(_check_admin)):
    """Force re-detection of host hardware."""
    hw = await detect_hardware()
    recommendation = get_backend_recommendation(hw)
    return {**hw, "recommended_backend": recommendation}


@router.get("/recommendation")
async def get_inference_recommendation(_: None = Depends(_check_admin)):
    """Return a hardware-based advisory (what this host could comfortably run)."""
    return await get_full_recommendation()


# ── Backend selection + status ────────────────────────────────────────────────


@router.get("/backend")
async def get_inference_backend(_: None = Depends(_check_admin)):
    """Get the selected inference backend and its live reachability."""
    return await get_backend_status()


@router.get("/backends")
async def list_inference_backends(_: None = Depends(_check_admin)):
    """List the supported inference server types the UI can offer."""
    return SUPPORTED_BACKENDS


@router.post("/backend/stop")
async def stop_inference_backend(_: None = Depends(_check_admin)):
    """Deselect local inference (fall back to cloud/none)."""
    return await clear_backend()


@router.post("/backend/{backend_name}/start", status_code=202)
async def start_inference_backend(backend_name: str, _: None = Depends(_check_admin)):
    """Select which backend the gateway routes to. For external servers this
    just records the choice; a running bundled container is routed to directly."""
    return await select_backend(backend_name)


# ── Bundled container lifecycle ───────────────────────────────────────────────


@router.get("/bundled")
async def list_bundled_containers(_: None = Depends(_check_admin)):
    """Container + health status of every bundled inference backend
    (multiple may be warm at once; `active` marks the one the gateway uses)."""
    return await bundled_containers_status()


@router.post("/bundled/{backend_name}/start", status_code=202)
async def start_bundled_container(backend_name: str, _: None = Depends(_check_admin)):
    """Start a bundled inference container and route the gateway to it.
    Returns 400 on CPU-only hosts for GPU-required backends (vllm/sglang)."""
    result = await start_bundled_backend(backend_name)
    if result.get("ok") is False:
        raise HTTPException(400, result.get("error", "start failed"))
    return result


@router.post("/bundled/{backend_name}/stop")
async def stop_bundled_container(backend_name: str, _: None = Depends(_check_admin)):
    """Stop and remove a bundled inference container; clears its routing URL."""
    result = await stop_bundled_backend(backend_name)
    if result.get("ok") is False:
        raise HTTPException(400, result.get("error", "stop failed"))
    return result


@router.get("/models/recommended")
async def get_recommended_models(
    backend: str | None = None,
    max_vram_gb: float | None = None,
    _: None = Depends(_check_admin),
):
    """Return curated recommended models (advisory — load them on your server)."""
    try:
        models = json.loads(RECOMMENDED_MODELS_PATH.read_text())
    except (FileNotFoundError, json.JSONDecodeError):
        return []

    if backend:
        models = [m for m in models if backend in m.get("backends", [])]
    if max_vram_gb:
        models = [m for m in models if m.get("min_vram_gb", 0) <= max_vram_gb]

    return models
