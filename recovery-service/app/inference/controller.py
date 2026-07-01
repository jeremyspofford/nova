"""Inference backend selection + status.

Nova does NOT run or manage any inference server. Every backend is an external,
user-run server (Ollama, LM Studio, vLLM, SGLang, or any OpenAI-compatible
endpoint). This module therefore only:
  * records which backend is selected (Redis inference.backend / inference.state)
  * reports live status by delegating to the gateway (the recovery container has
    no host.docker.internal, so it can't probe host-run servers directly)

There is no container lifecycle here — no start/stop/switch/health-monitor. The
user starts and stops their own inference server and loads their own models.
"""
import logging

import httpx

from app.redis_client import read_config, write_config_state

logger = logging.getLogger(__name__)

# Backends the gateway can report live status for (via /health/providers/*/status).
# Everything else is reported from the recorded Redis state only.
GATEWAY_STATUS_BACKENDS = {"ollama", "lmstudio"}

GATEWAY_STATUS_URL = "http://llm-gateway:8001/health/providers/{backend}/status"


async def get_backend_status() -> dict:
    """Return the selected backend and its live reachability.

    Status comes from the gateway (which holds the host.docker.internal route
    and the actual provider connection). For backends the gateway doesn't have a
    dedicated status probe for, we return the recorded Redis state.
    """
    backend = await read_config("inference.backend", "none")
    state = await read_config("inference.state", "stopped")

    if backend in GATEWAY_STATUS_BACKENDS:
        return await _gateway_backend_status(backend)

    result: dict = {"backend": backend, "state": state, "container_status": None}
    if state == "error":
        error = await read_config("inference.error", "")
        if error:
            result["error"] = error
    return result


async def _gateway_backend_status(backend: str) -> dict:
    """Probe a backend's reachability + loaded models through the gateway.

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
                "error": f"gateway probe failed: {e}"}

    result: dict = {
        "backend": backend,
        "state": "ready" if data.get("healthy") else "stopped",
        "container_status": None,
    }
    if data.get("active_model"):
        result["active_model"] = data["active_model"]
    if data.get("models") is not None:
        result["loaded_models"] = data["models"]
    if data.get("base_url"):
        result["base_url"] = data["base_url"]
    return result


async def select_backend(backend: str) -> dict:
    """Record the selected inference backend. No container is started — the user
    runs the server themselves; the gateway routes to it by URL."""
    await write_config_state("inference.backend", backend)
    await write_config_state("inference.error", "")
    await write_config_state("inference.state", "ready" if backend != "none" else "stopped")
    logger.info("Inference backend selected: %s", backend)
    return await get_backend_status()


async def clear_backend() -> dict:
    """Deselect local inference (fall back to cloud/none)."""
    await write_config_state("inference.backend", "none")
    await write_config_state("inference.state", "stopped")
    await write_config_state("inference.error", "")
    return {"backend": "none", "state": "stopped"}
