"""Inference backend selection, bundled container lifecycle, and status.

Two ways to run local inference:
  * BUNDLED — Nova starts an inference container from docker-compose.yml
    (ollama / vllm / sglang / llamacpp compose profiles). Start writes the
    in-network URL to Redis inference.url; stop clears it. Multiple bundled
    containers may run at once; inference.backend picks which one the gateway
    routes to.
  * EXTERNAL — a user-run server reached over HTTP (Ollama on the host,
    LM Studio, or any OpenAI-compatible endpoint). Nova only records the
    selection; live status is probed via the gateway (the recovery container
    has no host.docker.internal route).
"""
import asyncio
import logging

import httpx

from app.compose_client import (
    profiled_service_status,
    start_profiled_service,
    stop_profiled_service,
)
from app.env_manager import add_compose_profile, remove_compose_profile
from app.inference.hardware import get_hardware
from app.redis_client import read_config, write_config_state

logger = logging.getLogger(__name__)

# Backends the gateway can report live status for (via /health/providers/*/status).
# Everything else is reported from the recorded Redis state only.
GATEWAY_STATUS_BACKENDS = {"ollama", "lmstudio"}

GATEWAY_STATUS_URL = "http://llm-gateway:8001/health/providers/{backend}/status"

# Bundled backends Nova can run as compose-profile containers. `url` is the
# in-network DNS address written to inference.url on start (and cleared on
# stop — a stale bundled URL after container removal breaks the gateway).
BUNDLED_BACKENDS: dict[str, dict] = {
    "ollama": {
        "profile": "inference-ollama",
        "service": "ollama",
        "url": "http://ollama:11434",
        "health_path": "/api/tags",
        "gpu_required": False,
    },
    "vllm": {
        "profile": "inference-vllm",
        "service": "vllm",
        "url": "http://vllm:8000",
        "health_path": "/v1/models",
        "gpu_required": True,
    },
    "sglang": {
        "profile": "inference-sglang",
        "service": "sglang",
        "url": "http://sglang:30000",
        "health_path": "/v1/models",
        "gpu_required": True,
    },
    "llamacpp": {
        "profile": "inference-llamacpp",
        "service": "llamacpp",
        "url": "http://llamacpp:8080",
        "health_path": "/health",
        "gpu_required": False,
    },
}

_BUNDLED_URLS = {spec["url"] for spec in BUNDLED_BACKENDS.values()}

# How long start waits for the container to answer its health path before
# leaving state at "starting" (model loads can take minutes — the gateway
# flips to it as soon as it responds).
_HEALTH_POLL_SECONDS = 60
_HEALTH_POLL_INTERVAL = 3


async def get_backend_status() -> dict:
    """Return the selected backend and its live reachability."""
    backend = await read_config("inference.backend", "none")
    state = await read_config("inference.state", "stopped")
    url = await read_config("inference.url", "")

    # Bundled container serving the selection: probe it directly (recovery is
    # on the same docker network).
    if backend in BUNDLED_BACKENDS and url == BUNDLED_BACKENDS[backend]["url"]:
        return await _bundled_backend_status(backend)

    if backend in GATEWAY_STATUS_BACKENDS:
        return await _gateway_backend_status(backend)

    result: dict = {"backend": backend, "state": state, "container_status": None}
    if state == "error":
        error = await read_config("inference.error", "")
        if error:
            result["error"] = error
    return result


async def _bundled_backend_status(backend: str) -> dict:
    spec = BUNDLED_BACKENDS[backend]
    container = await profiled_service_status(spec["service"])
    healthy = container == "running" and await _probe_health(spec)
    return {
        "backend": backend,
        "state": "ready" if healthy else ("starting" if container == "running" else "stopped"),
        "container_status": container or None,
        "bundled": True,
        "base_url": spec["url"],
    }


async def _gateway_backend_status(backend: str) -> dict:
    """Probe an external backend's reachability + loaded models via the gateway.

    The recovery container can't reach a host-run inference server (no
    host.docker.internal mapping — only the gateway has it), so it delegates to
    the gateway's per-provider status endpoint.
    """
    endpoint = GATEWAY_STATUS_URL.format(backend=backend)
    try:
        async with httpx.AsyncClient(timeout=6.0) as client:
            r = await client.get(endpoint)
            r.raise_for_status()
            data = r.json()
    except Exception as e:
        logger.warning("Failed to probe %s via gateway: %s", backend, e)
        return {"backend": backend, "state": "error", "container_status": None,
                "external": True, "error": f"gateway probe failed: {e}"}

    result: dict = {
        "backend": backend,
        "state": "ready" if data.get("healthy") else "stopped",
        "container_status": None,
        # not a bundled container — a server the user runs (Windows/LAN/etc.)
        "external": True,
    }
    if data.get("active_model"):
        result["active_model"] = data["active_model"]
    if data.get("models") is not None:
        result["loaded_models"] = data["models"]
    if data.get("base_url"):
        result["base_url"] = data["base_url"]
    return result


async def _probe_health(spec: dict) -> bool:
    try:
        async with httpx.AsyncClient(timeout=4.0) as client:
            r = await client.get(spec["url"] + spec["health_path"])
            return r.status_code == 200
    except Exception:
        return False


# ── Bundled container lifecycle ───────────────────────────────────────────────


async def bundled_containers_status() -> list[dict]:
    """Container + health state for every bundled backend (multi-warm view)."""
    active = await read_config("inference.backend", "none")
    out = []
    for name, spec in BUNDLED_BACKENDS.items():
        container = await profiled_service_status(spec["service"])
        healthy = container == "running" and await _probe_health(spec)
        out.append({
            "backend": name,
            "container_status": container or None,
            "healthy": healthy,
            "base_url": spec["url"],
            "active": active == name,
            "gpu_required": spec["gpu_required"],
        })
    return out


async def start_bundled_backend(name: str) -> dict:
    """Start a bundled inference container and route the gateway to it.

    Persists the compose profile (so ./start relaunches it after reboot),
    starts the container, writes the in-network URL + backend to Redis, and
    polls health until ready (or leaves state=starting for slow model loads).
    """
    spec = BUNDLED_BACKENDS.get(name)
    if spec is None:
        return {"ok": False, "error": f"'{name}' is not a bundled backend"}

    if spec["gpu_required"]:
        hw = await get_hardware()
        if not hw.get("gpus"):
            return {
                "ok": False,
                "error": (
                    f"{name} requires an NVIDIA GPU and none was detected. "
                    f"On CPU-only hosts use ollama or llamacpp instead."
                ),
            }

    add_compose_profile(spec["profile"])
    result = await start_profiled_service(spec["profile"], spec["service"])
    if not result.get("ok"):
        remove_compose_profile(spec["profile"])
        return result

    await write_config_state("inference.backend", name)
    await write_config_state("inference.url", spec["url"])
    await write_config_state("inference.error", "")
    await write_config_state("inference.state", "starting")
    logger.info("Bundled inference '%s' started; routing gateway to %s", name, spec["url"])

    for _ in range(_HEALTH_POLL_SECONDS // _HEALTH_POLL_INTERVAL):
        if await _probe_health(spec):
            await write_config_state("inference.state", "ready")
            return await _bundled_backend_status(name)
        await asyncio.sleep(_HEALTH_POLL_INTERVAL)

    # Not ready yet (large image pull / model load). Leave "starting" — the
    # gateway keeps checking and the UI shows the pending state.
    return await _bundled_backend_status(name)


async def stop_bundled_backend(name: str) -> dict:
    """Stop and remove a bundled inference container.

    Clears inference.url if it points at this container (stale-URL fix) and
    drops the compose profile so ./start won't relaunch it.
    """
    spec = BUNDLED_BACKENDS.get(name)
    if spec is None:
        return {"ok": False, "error": f"'{name}' is not a bundled backend"}

    result = await stop_profiled_service(spec["profile"], spec["service"])
    remove_compose_profile(spec["profile"])

    if await read_config("inference.url", "") == spec["url"]:
        await write_config_state("inference.url", "")
    if await read_config("inference.backend", "none") == name:
        await write_config_state("inference.backend", "none")
        await write_config_state("inference.state", "stopped")
    logger.info("Bundled inference '%s' stopped", name)
    return result


async def select_backend(backend: str) -> dict:
    """Select which backend the gateway routes local inference to.

    If a bundled container for this backend is running, route to it
    (in-network URL). Otherwise this is an external selection — and any stale
    bundled URL left in inference.url is cleared so the gateway falls back to
    the backend's default/user-configured endpoint.
    """
    await write_config_state("inference.backend", backend)
    await write_config_state("inference.error", "")

    spec = BUNDLED_BACKENDS.get(backend)
    if spec and await profiled_service_status(spec["service"]) == "running":
        await write_config_state("inference.url", spec["url"])
    else:
        current_url = await read_config("inference.url", "")
        if current_url in _BUNDLED_URLS:
            await write_config_state("inference.url", "")

    await write_config_state("inference.state", "ready" if backend != "none" else "stopped")
    logger.info("Inference backend selected: %s", backend)
    return await get_backend_status()


async def clear_backend() -> dict:
    """Deselect local inference (fall back to cloud/none)."""
    await write_config_state("inference.backend", "none")
    await write_config_state("inference.state", "stopped")
    await write_config_state("inference.error", "")
    current_url = await read_config("inference.url", "")
    if current_url in _BUNDLED_URLS:
        await write_config_state("inference.url", "")
    return {"backend": "none", "state": "stopped"}
