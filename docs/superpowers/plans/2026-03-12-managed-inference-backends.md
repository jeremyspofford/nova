# Managed Inference Backends — Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enable Nova to manage local inference backends (starting with vLLM) with hardware auto-detection, container lifecycle management, and dashboard UI configuration.

**Architecture:** New `OpenAICompatibleProvider` base class in the LLM gateway wraps vLLM (and future SGLang/remote endpoints). A `LocalInferenceProvider` wrapper replaces the hardcoded Ollama routing, delegating to whichever backend is active. The recovery service gains an inference management module for hardware detection and container lifecycle (start/stop/health) via Docker Compose profiles. All configuration flows through the dashboard Settings UI → orchestrator platform_config → Redis.

**Tech Stack:** Python 3.9+ (FastAPI, asyncpg, httpx, aioredis), React/TypeScript (TanStack Query, Tailwind), Docker Compose profiles, `nvidia-smi` CLI for GPU detection.

**Spec:** `docs/superpowers/specs/2026-03-12-managed-inference-backends-design.md`

---

## File Structure

### Files to Create

| File | Responsibility |
|------|---------------|
| `llm-gateway/app/providers/openai_compatible_provider.py` | Base `ModelProvider` for any OpenAI-compatible server (vLLM, SGLang, remote) |
| `llm-gateway/app/providers/vllm_provider.py` | Thin vLLM wrapper — just sets name/capabilities, delegates to base |
| `llm-gateway/app/providers/local_inference_provider.py` | Wrapper that reads active backend config from Redis, delegates to correct provider |
| `recovery-service/app/inference/__init__.py` | Inference management module init |
| `recovery-service/app/inference/hardware.py` | GPU/CPU/disk detection, `data/hardware.json` read, Redis sync |
| `recovery-service/app/inference/controller.py` | Backend lifecycle: start/stop containers, health monitoring, switching protocol |
| `recovery-service/app/inference/routes.py` | FastAPI router for inference management endpoints |
| `dashboard/src/pages/settings/LocalInferenceSection.tsx` | Settings UI section for backend selection, status, remote config |
| `scripts/detect_hardware.sh` | Standalone hardware detection script (called by `setup.sh`, writes `data/hardware.json`) |
| `tests/test_inference_backends.py` | Integration tests for inference backend management |

### Files to Modify

| File | Changes |
|------|---------|
| `docker-compose.yml` | Add `nova-vllm` service with profile, add Redis env to recovery |
| `docker-compose.gpu.yml` | Add vLLM GPU device reservation |
| `llm-gateway/app/providers/__init__.py` | Export new providers |
| `llm-gateway/app/registry.py` | Replace `_is_ollama_model()` with dynamic local model set, wire `LocalInferenceProvider` into routing |
| `llm-gateway/app/health.py` | Add `GET /health/inflight` endpoint |
| `llm-gateway/app/discovery.py` | Add `_discover_local_backend()` coroutine |
| `llm-gateway/app/config.py` | Add inference backend config keys |
| `recovery-service/app/config.py` | Add `redis_url` setting |
| `recovery-service/app/main.py` | Mount inference routes, start hardware sync + health monitor on startup |
| `recovery-service/app/docker_client.py` | Add `nova-vllm` to `OPTIONAL_SERVICES` |
| `orchestrator/app/config_sync.py` | Add `inference.*` keys to Redis sync |
| `dashboard/src/pages/Settings.tsx` | Add `LocalInferenceSection` to ai category |
| `scripts/setup.sh` | Call `detect_hardware.sh` during setup |

---

## Chunk 1: Infrastructure — Docker Compose + Recovery Redis

### Task 1: Add vLLM Service to Docker Compose

**Files:**
- Modify: `docker-compose.yml` (after ollama service, ~line 85)
- Modify: `docker-compose.gpu.yml` (add vllm GPU section)

- [ ] **Step 1: Add nova-vllm service definition to docker-compose.yml**

Add after the existing `ollama` service block (~line 85). Follows the same pattern as the ollama service — profiled, with volume, resource limits:

```yaml
  nova-vllm:
    <<: *nova-common
    image: vllm/vllm-openai:v0.8.5
    container_name: nova-vllm
    profiles: ["local-vllm"]
    volumes:
      - nova-vllm-cache:/root/.cache/huggingface
    environment:
      - VLLM_MODEL=${VLLM_MODEL:-meta-llama/Llama-3.2-3B-Instruct}
      - VLLM_GPU_MEMORY_UTILIZATION=${VLLM_GPU_MEMORY_UTILIZATION:-0.9}
    entrypoint: ["/bin/sh", "-c"]
    command:
      - >
        python -m vllm.entrypoints.openai.api_server
        --model "$VLLM_MODEL"
        --gpu-memory-utilization "$VLLM_GPU_MEMORY_UTILIZATION"
        --host 0.0.0.0
        --port 8000
    deploy:
      resources:
        limits:
          cpus: "8"
          memory: 16G
    healthcheck:
      test: ["CMD", "curl", "-sf", "http://localhost:8000/health"]
      interval: 15s
      timeout: 5s
      retries: 5
      start_period: 120s
```

Note: Uses `<<: *nova-common` anchor (includes `nova-internal` network, restart policy, logging config — matches all other services). No host port mapping needed — the gateway communicates via the Docker internal network (`http://nova-vllm:8000`). Uses `entrypoint: ["/bin/sh", "-c"]` so environment variables are expanded in the command.

Also add to the `volumes:` section at the bottom:

```yaml
  nova-vllm-cache:
```

- [ ] **Step 2: Add vLLM GPU config to docker-compose.gpu.yml**

Add a `nova-vllm` section to `docker-compose.gpu.yml` following the same pattern as the ollama GPU override:

```yaml
  nova-vllm:
    environment:
      - NVIDIA_VISIBLE_DEVICES=all
      - NVIDIA_DRIVER_CAPABILITIES=compute,utility
    deploy:
      resources:
        reservations:
          devices:
            - driver: nvidia
              count: all
              capabilities: [gpu]
```

- [ ] **Step 3: Verify compose file validity**

Run: `cd /home/jeremy/workspace/nova && docker compose config --profiles local-vllm > /dev/null 2>&1 && echo "valid" || echo "invalid"`
Expected: `valid`

- [ ] **Step 4: Commit**

```bash
git add docker-compose.yml docker-compose.gpu.yml
git commit -m "infra: add nova-vllm service with Docker Compose profile"
```

---

### Task 2: Add Redis to Recovery Service

**Files:**
- Modify: `recovery-service/app/config.py` (~line 1-30)
- Modify: `docker-compose.yml` (recovery service block, ~line 336)

- [ ] **Step 1: Add redis_url to recovery config**

In `recovery-service/app/config.py`, add Redis URL config. The existing class is `Settings` (not `Config`) and uses class-level attributes with `os.getenv()` (not `__init__`). The singleton is exported as `settings`. Add:

```python
# Add to Settings class (class-level attribute, same pattern as other fields)
redis_url: str = os.getenv("REDIS_URL", "redis://redis:6379/7")
```

Note: recovery uses db7 (db6 is taken by neural-router-trainer).

- [ ] **Step 2: Add REDIS_URL env to recovery in docker-compose.yml**

In the `recovery` service block (~line 336), add to the `environment:` list:

```yaml
      - REDIS_URL=redis://redis:6379/7
```

Also add `redis` to the `depends_on:` for recovery (currently only depends on postgres):

```yaml
    depends_on:
      postgres:
        condition: service_healthy
      redis:
        condition: service_healthy
```

Also add a volume mount for the `data/` directory so recovery can read `hardware.json` written by `setup.sh`:

```yaml
    volumes:
      # ... existing mounts (docker.sock, .env, docker-compose.yml) ...
      - ./data:/app/data:ro
```

- [ ] **Step 3: Create Redis client utility in recovery service**

Create a simple async Redis client helper in `recovery-service/app/redis_client.py`. The recovery service doesn't currently have any Redis code, so this establishes the pattern:

```python
import json
import logging
from typing import Optional

import redis.asyncio as aioredis

from app.config import settings

logger = logging.getLogger(__name__)

_redis: Optional[aioredis.Redis] = None
_config_redis: Optional[aioredis.Redis] = None


async def get_redis() -> aioredis.Redis:
    """Recovery service's own Redis connection (db7) — for nova:system:* data."""
    global _redis
    if _redis is None:
        _redis = aioredis.from_url(settings.redis_url, decode_responses=True)
    return _redis


async def get_config_redis() -> aioredis.Redis:
    """Cross-db connection to db1 — reads nova:config:inference.* written by orchestrator."""
    global _config_redis
    if _config_redis is None:
        base = settings.redis_url.rsplit("/", 1)[0]
        _config_redis = aioredis.from_url(f"{base}/1", decode_responses=True)
    return _config_redis


async def read_config(key: str, default: str = "") -> str:
    """Read a nova:config:* key from the gateway's Redis db (db1)."""
    r = await get_config_redis()
    val = await r.get(f"nova:config:{key}")
    return val if val is not None else default


async def write_system(key: str, data: dict) -> None:
    """Write a nova:system:* key to recovery's own Redis db (db7)."""
    r = await get_redis()
    await r.set(f"nova:system:{key}", json.dumps(data))


async def read_system(key: str) -> Optional[dict]:
    """Read a nova:system:* key from recovery's own Redis db (db7)."""
    r = await get_redis()
    val = await r.get(f"nova:system:{key}")
    return json.loads(val) if val else None


async def write_config_state(key: str, value: str) -> None:
    """Write inference state to db1 (gateway reads this for routing decisions)."""
    r = await get_config_redis()
    await r.set(f"nova:config:{key}", value)


async def close_redis() -> None:
    global _redis, _config_redis
    if _redis:
        await _redis.aclose()
        _redis = None
    if _config_redis:
        await _config_redis.aclose()
        _config_redis = None
```

- [ ] **Step 4: Add redis dependency to recovery-service/requirements.txt or pyproject.toml**

Check which dependency file the recovery service uses. Add `redis[hiredis]>=5.0.0` to it (same version pattern as other Nova services).

- [ ] **Step 5: Verify recovery service still starts**

Run: `cd /home/jeremy/workspace/nova && docker compose up -d recovery && docker compose logs recovery --tail 20`
Expected: recovery starts without errors, connects to Redis on db7.

- [ ] **Step 6: Commit**

```bash
git add recovery-service/app/config.py recovery-service/app/redis_client.py docker-compose.yml recovery-service/pyproject.toml
git commit -m "infra: add Redis access to recovery service (db7)"
```

---

## Chunk 2: Hardware Detection

### Task 3: Hardware Detection Script

**Files:**
- Create: `scripts/detect_hardware.sh`

- [ ] **Step 1: Write the hardware detection script**

This is called by `setup.sh` and writes `data/hardware.json`. It runs before containers are up (no Redis), so it outputs to a file.

```bash
#!/usr/bin/env bash
set -euo pipefail

OUTPUT="${1:-data/hardware.json}"
mkdir -p "$(dirname "$OUTPUT")"

# --- GPU Detection ---
GPUS="[]"
GPU_RUNTIME=""

if command -v nvidia-smi &>/dev/null; then
    # Parse nvidia-smi for GPU info
    GPU_JSON=$(nvidia-smi --query-gpu=index,name,memory.total --format=csv,noheader,nounits 2>/dev/null | \
        awk -F', ' '{
            printf "{\"vendor\":\"nvidia\",\"model\":\"%s\",\"vram_gb\":%.1f,\"index\":%d}", $2, $3/1024, $1
        }' | paste -sd',' -)
    if [ -n "$GPU_JSON" ]; then
        GPUS="[$GPU_JSON]"
        GPU_RUNTIME="nvidia"
    fi
elif [ -d "/dev/kfd" ] && command -v rocm-smi &>/dev/null; then
    # AMD ROCm detection
    GPU_JSON=$(rocm-smi --showproductname --showmeminfo vram --json 2>/dev/null | \
        python3 -c "
import sys, json
data = json.load(sys.stdin)
gpus = []
for k, v in data.items():
    if k.startswith('card'):
        idx = int(k.replace('card',''))
        name = v.get('Card Series', 'AMD GPU')
        vram = int(v.get('VRAM Total Memory (B)', 0)) / (1024**3)
        gpus.append(json.dumps({'vendor':'amd','model':name,'vram_gb':round(vram,1),'index':idx}))
print('[' + ','.join(gpus) + ']')
" 2>/dev/null || echo "[]")
    GPUS="$GPU_JSON"
    GPU_RUNTIME="rocm"
fi

# Check for Docker GPU runtime
if [ -z "$GPU_RUNTIME" ]; then
    if docker info 2>/dev/null | grep -q "nvidia"; then
        GPU_RUNTIME="nvidia"
    elif docker info 2>/dev/null | grep -q "rocm\|amd"; then
        GPU_RUNTIME="rocm"
    fi
fi

# --- CPU / RAM / Disk ---
CPU_CORES=$(nproc 2>/dev/null || sysctl -n hw.ncpu 2>/dev/null || echo 1)
RAM_GB=$(free -g 2>/dev/null | awk '/Mem:/{print $2}' || echo 0)
DISK_FREE_GB=$(df -BG --output=avail "$(pwd)" 2>/dev/null | tail -1 | tr -d ' G' || echo 0)
DETECTED_AT=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

# --- Write JSON ---
cat > "$OUTPUT" <<ENDJSON
{
  "gpus": $GPUS,
  "docker_gpu_runtime": "$GPU_RUNTIME",
  "cpu_cores": $CPU_CORES,
  "ram_gb": $RAM_GB,
  "disk_free_gb": $DISK_FREE_GB,
  "detected_at": "$DETECTED_AT"
}
ENDJSON

echo "Hardware detection complete: $OUTPUT"
cat "$OUTPUT"
```

- [ ] **Step 2: Make it executable**

Run: `chmod +x scripts/detect_hardware.sh`

- [ ] **Step 3: Test it locally**

Run: `cd /home/jeremy/workspace/nova && ./scripts/detect_hardware.sh data/hardware.json && cat data/hardware.json`
Expected: Valid JSON with gpu/cpu/ram/disk info. On a host with NVIDIA GPU, `gpus` should be populated. On a CPU-only host, `gpus` should be `[]`.

- [ ] **Step 4: Add data/ to .gitignore**

`data/hardware.json` is machine-specific and should not be committed. Add this line to `.gitignore`:

```
data/
```

- [ ] **Step 5: Commit**

```bash
git add scripts/detect_hardware.sh
git commit -m "feat: add hardware detection script for GPU/CPU/disk"
```

---

### Task 4: Recovery Service Hardware Module

**Files:**
- Create: `recovery-service/app/inference/__init__.py`
- Create: `recovery-service/app/inference/hardware.py`
- Test: `tests/test_inference_backends.py`

- [ ] **Step 1: Write the failing test**

Create `tests/test_inference_backends.py`:

```python
"""Integration tests for managed inference backends."""
import pytest
import httpx

BASE = "http://localhost:8888"
HEADERS = {}  # Will be set in conftest or fixture


@pytest.fixture(autouse=True)
def auth_headers():
    """Set up admin auth headers for recovery service."""
    import os
    secret = os.environ.get("ADMIN_SECRET", "")
    global HEADERS
    HEADERS = {"X-Admin-Secret": secret} if secret else {}


class TestHardwareDetection:
    """Tests for the hardware detection endpoint."""

    @pytest.mark.asyncio
    async def test_get_hardware_info(self):
        """Recovery service should return detected hardware info."""
        async with httpx.AsyncClient() as client:
            r = await client.get(f"{BASE}/api/v1/recovery/inference/hardware", headers=HEADERS)
            assert r.status_code == 200
            data = r.json()
            assert "gpus" in data
            assert "cpu_cores" in data
            assert "ram_gb" in data
            assert "disk_free_gb" in data
            assert isinstance(data["gpus"], list)
            assert data["cpu_cores"] > 0

    @pytest.mark.asyncio
    async def test_hardware_redetect(self):
        """Re-detection should refresh hardware info."""
        async with httpx.AsyncClient() as client:
            r = await client.post(f"{BASE}/api/v1/recovery/inference/hardware/detect", headers=HEADERS)
            assert r.status_code == 200
            data = r.json()
            assert "detected_at" in data
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /home/jeremy/workspace/nova && python -m pytest tests/test_inference_backends.py::TestHardwareDetection -v`
Expected: FAIL — 404, endpoints don't exist yet.

- [ ] **Step 3: Create the inference module**

Create `recovery-service/app/inference/__init__.py`:

```python
"""Inference backend management module."""
```

Create `recovery-service/app/inference/hardware.py`:

```python
"""Hardware detection — GPU, CPU, RAM, disk."""
import json
import logging
import os
import platform
import shutil
import subprocess
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from app.redis_client import write_system, read_system

logger = logging.getLogger(__name__)

HARDWARE_JSON_PATH = Path("/app/data/hardware.json")


async def detect_hardware() -> dict[str, Any]:
    """Detect GPU, CPU, RAM, and disk — returns hardware info dict."""
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
    # (via detect_hardware.sh → data/hardware.json). Live detection inside
    # the container will only get CPU/RAM/disk info. This is by design —
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

    # No file — run live detection
    return await detect_hardware()


def get_backend_recommendation(hardware: dict[str, Any]) -> str:
    """Recommend a backend based on detected hardware."""
    gpus = hardware.get("gpus", [])
    if not gpus:
        return "ollama"  # CPU-only → Ollama

    total_vram = sum(g.get("vram_gb", 0) for g in gpus)
    if total_vram >= 8:
        return "vllm"

    return "ollama"


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
                gpus.append({
                    "vendor": "nvidia",
                    "model": parts[1],
                    "vram_gb": round(int(parts[2]) / 1024, 1),
                    "index": int(parts[0]),
                })
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
            idx = int(key.replace("card", ""))
            name = val.get("Card Series", "AMD GPU")
            vram_bytes = int(val.get("VRAM Total Memory (B)", 0))
            gpus.append({
                "vendor": "amd",
                "model": name,
                "vram_gb": round(vram_bytes / (1024 ** 3), 1),
                "index": idx,
            })
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
    """Get free disk space in GB for the current working directory."""
    usage = shutil.disk_usage("/")
    return int(usage.free / (1024 ** 3))
```

- [ ] **Step 4: Create the inference routes**

Create `recovery-service/app/inference/routes.py`:

```python
"""API routes for inference backend management."""
import logging
from fastapi import APIRouter, Depends

from app.inference.hardware import get_hardware, detect_hardware, get_backend_recommendation

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/v1/recovery/inference", tags=["inference"])


@router.get("/hardware")
async def get_hardware_info():
    """Return detected hardware info (GPU, CPU, RAM, disk)."""
    hw = await get_hardware()
    recommendation = get_backend_recommendation(hw)
    return {**hw, "recommended_backend": recommendation}


@router.post("/hardware/detect")
async def redetect_hardware():
    """Force re-detection of hardware."""
    hw = await detect_hardware()
    recommendation = get_backend_recommendation(hw)
    return {**hw, "recommended_backend": recommendation}
```

- [ ] **Step 5: Mount inference routes in recovery main.py**

In `recovery-service/app/main.py`, add:

```python
from app.inference.routes import router as inference_router
# ... in the app setup:
app.include_router(inference_router)
```

Also add hardware sync to the startup lifespan:

```python
from app.inference.hardware import sync_hardware_from_file
from app.redis_client import close_redis

# In the lifespan function (or @app.on_event("startup")):
await sync_hardware_from_file()

# In shutdown:
await close_redis()
```

- [ ] **Step 6: Run test to verify it passes**

Run: `cd /home/jeremy/workspace/nova && docker compose up -d --build recovery && sleep 5 && python -m pytest tests/test_inference_backends.py::TestHardwareDetection -v`
Expected: PASS — both tests green.

- [ ] **Step 7: Commit**

```bash
git add recovery-service/app/inference/ tests/test_inference_backends.py
git commit -m "feat: add hardware detection module to recovery service"
```

---

## Chunk 3: LLM Gateway Providers

### Task 5: OpenAICompatibleProvider Base Class

**Files:**
- Create: `llm-gateway/app/providers/openai_compatible_provider.py`
- Test: `tests/test_inference_backends.py`

- [ ] **Step 1: Write the failing test**

Add to `tests/test_inference_backends.py`:

```python
class TestOpenAICompatibleProvider:
    """Tests for the OpenAI-compatible provider base class (unit-style, no running vLLM needed)."""

    @pytest.mark.asyncio
    async def test_provider_has_correct_capabilities(self):
        """OpenAI-compatible providers should declare chat, streaming, and embeddings."""
        # Import from the gateway's package
        from llm_gateway_test_helpers import create_openai_compatible_provider
        provider = create_openai_compatible_provider("http://fake:8000", "test")
        assert provider.name == "test"
        # Should support chat, streaming, embeddings at minimum
        caps = provider.capabilities
        assert "chat" in str(caps) or len(caps) >= 2
```

Note: Since these are integration tests that hit real services, and we can't import gateway code directly in the test runner, skip this as a unit test. Instead, test via the gateway's provider catalog endpoint:

```python
class TestVLLMProviderRegistration:
    """Test that vLLM provider appears in the gateway's provider catalog."""

    @pytest.mark.asyncio
    async def test_vllm_in_provider_catalog(self):
        """LLM gateway should list vllm as a known provider."""
        async with httpx.AsyncClient() as client:
            r = await client.get("http://localhost:8001/health/providers")
            assert r.status_code == 200
            providers = r.json()
            slugs = [p["slug"] for p in providers]
            assert "vllm" in slugs

    @pytest.mark.asyncio
    async def test_vllm_provider_unavailable_when_not_running(self):
        """vLLM provider should show as unavailable when container isn't running."""
        async with httpx.AsyncClient() as client:
            r = await client.get("http://localhost:8001/health/providers")
            assert r.status_code == 200
            providers = r.json()
            vllm = next((p for p in providers if p["slug"] == "vllm"), None)
            assert vllm is not None
            # vLLM container not running in test env, so should be unavailable
            assert vllm["available"] is False
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /home/jeremy/workspace/nova && python -m pytest tests/test_inference_backends.py::TestVLLMProviderRegistration -v`
Expected: FAIL — `vllm` not in provider catalog yet.

- [ ] **Step 3: Create the OpenAICompatibleProvider**

Create `llm-gateway/app/providers/openai_compatible_provider.py`:

```python
"""Base provider for any server exposing an OpenAI-compatible API (vLLM, SGLang, etc.)."""
import json
import logging
import time
from typing import AsyncIterator, Optional, Set

import httpx

from nova_contracts.llm import (
    CompleteRequest, CompleteResponse, StreamChunk,
    EmbedRequest, EmbedResponse, ModelCapability,
)
from .base import ModelProvider

logger = logging.getLogger(__name__)


class OpenAICompatibleProvider(ModelProvider):
    """
    Generic provider for OpenAI-compatible inference servers.

    Handles /v1/chat/completions and /v1/embeddings endpoints.
    Subclasses (VLLMProvider, SGLangProvider) just set name/capabilities.
    """

    def __init__(
        self,
        base_url: str,
        provider_name: str,
        capabilities: Optional[Set[ModelCapability]] = None,
        timeout: float = 120.0,
    ):
        self._base_url = base_url.rstrip("/")
        self._name = provider_name
        self._capabilities = capabilities or {
            ModelCapability.chat,
            ModelCapability.streaming,
            ModelCapability.embeddings,
        }
        self._timeout = timeout
        # Start optimistic (True) like OllamaProvider — check_health() will correct
        self._healthy: bool = True
        self._health_check_interval = 15.0
        self._last_health_check = 0.0

    @property
    def name(self) -> str:
        return self._name

    @property
    def capabilities(self) -> Set[ModelCapability]:
        return self._capabilities

    @property
    def is_available(self) -> bool:
        return self._healthy

    async def check_health(self) -> bool:
        """Quick health check against the server."""
        now = time.monotonic()
        if (now - self._last_health_check) < self._health_check_interval:
            return self._healthy

        try:
            async with httpx.AsyncClient(timeout=3.0) as client:
                r = await client.get(f"{self._base_url}/health")
                self._healthy = r.status_code == 200
        except (httpx.HTTPError, httpx.TimeoutException):
            self._healthy = False

        self._last_health_check = now
        return self._healthy

    async def complete(self, request: CompleteRequest) -> CompleteResponse:
        """Send a chat completion request."""
        await self.check_health()
        self._assert_available()
        payload = self._build_chat_payload(request, stream=False)

        async with httpx.AsyncClient(timeout=self._timeout) as client:
            r = await client.post(f"{self._base_url}/v1/chat/completions", json=payload)
            r.raise_for_status()
            data = r.json()

        choice = data["choices"][0]
        usage = data.get("usage", {})
        return CompleteResponse(
            content=choice["message"]["content"],
            model=data.get("model", request.model),
            input_tokens=usage.get("prompt_tokens", 0),
            output_tokens=usage.get("completion_tokens", 0),
            finish_reason=choice.get("finish_reason", "stop"),
        )

    async def stream(self, request: CompleteRequest) -> AsyncIterator[StreamChunk]:
        """Stream a chat completion response."""
        await self.check_health()
        self._assert_available()
        payload = self._build_chat_payload(request, stream=True)

        async with httpx.AsyncClient(timeout=self._timeout) as client:
            async with client.stream(
                "POST", f"{self._base_url}/v1/chat/completions", json=payload
            ) as response:
                response.raise_for_status()
                async for line in response.aiter_lines():
                    if not line.startswith("data: "):
                        continue
                    data_str = line[6:]
                    if data_str.strip() == "[DONE]":
                        break

                    data = json.loads(data_str)
                    choice = data.get("choices", [{}])[0]
                    delta = choice.get("delta", {})
                    content = delta.get("content", "")

                    if content:
                        yield StreamChunk(
                            delta=content,
                            finish_reason=choice.get("finish_reason"),
                        )

    async def embed(self, request: EmbedRequest) -> EmbedResponse:
        """Generate embeddings."""
        await self.check_health()
        self._assert_available()
        payload = {
            "input": request.texts,
            "model": request.model or "default",
        }

        async with httpx.AsyncClient(timeout=self._timeout) as client:
            r = await client.post(f"{self._base_url}/v1/embeddings", json=payload)
            r.raise_for_status()
            data = r.json()

        embeddings = [item["embedding"] for item in data["data"]]
        return EmbedResponse(
            embeddings=embeddings,
            model=data.get("model", request.model or "default"),
            input_tokens=data.get("usage", {}).get("prompt_tokens", 0),
        )

    def _build_chat_payload(self, request: CompleteRequest, stream: bool) -> dict:
        """Build an OpenAI-format chat completion payload."""
        # System messages are part of request.messages (no separate system field)
        messages = []
        for msg in (request.messages or []):
            messages.append({"role": msg.role, "content": msg.content})

        payload = {
            "model": request.model,
            "messages": messages,
            "stream": stream,
        }

        if request.temperature is not None:
            payload["temperature"] = request.temperature
        if request.max_tokens is not None:
            payload["max_tokens"] = request.max_tokens

        return payload

Note: `ModelCapability` enum values are **lowercase** (`chat`, `streaming`, `embeddings`, not `CHAT`). `CompleteResponse` uses top-level `input_tokens`/`output_tokens` (not a nested `usage` dict). `StreamChunk` uses `delta` (not `content`). There is no `provider` field on any response model, and no `system` field on `CompleteRequest`. The provider starts with `_healthy = True` (optimistic, like OllamaProvider) so it's available until the first health check proves otherwise.
```

- [ ] **Step 4: Commit**

```bash
git add llm-gateway/app/providers/openai_compatible_provider.py
git commit -m "feat: add OpenAICompatibleProvider base class for vLLM/SGLang"
```

---

### Task 6: VLLMProvider + Registration

**Files:**
- Create: `llm-gateway/app/providers/vllm_provider.py`
- Modify: `llm-gateway/app/providers/__init__.py`
- Modify: `llm-gateway/app/registry.py` (~lines 93-116 for provider instances, ~line 461 for catalog)

- [ ] **Step 1: Create VLLMProvider**

Create `llm-gateway/app/providers/vllm_provider.py`:

```python
"""vLLM inference provider — thin wrapper over OpenAICompatibleProvider."""
from nova_contracts.llm import ModelCapability
from .openai_compatible_provider import OpenAICompatibleProvider


class VLLMProvider(OpenAICompatibleProvider):
    """Provider for vLLM OpenAI-compatible server."""

    def __init__(self, base_url: str = "http://nova-vllm:8000"):
        super().__init__(
            base_url=base_url,
            provider_name="vllm",
            capabilities={
                ModelCapability.chat,
                ModelCapability.streaming,
                ModelCapability.embeddings,
                ModelCapability.function_calling,
                ModelCapability.structured_output,
            },
        )
```

- [ ] **Step 2: Export new providers from __init__.py**

In `llm-gateway/app/providers/__init__.py`, add:

```python
from .openai_compatible_provider import OpenAICompatibleProvider
from .vllm_provider import VLLMProvider
```

- [ ] **Step 3: Register vLLM provider instance in registry.py**

In `llm-gateway/app/registry.py`, add a provider instance after the existing ones (~line 116):

```python
_vllm = VLLMProvider()
```

Add the import at the top:

```python
from .providers import VLLMProvider
```

Add vLLM to `get_provider_catalog()` (~line 461). Follow the existing pattern — add a dict entry for vllm:

```python
{
    "slug": "vllm",
    "name": "vLLM",
    "type": "local",
    "available": _vllm.is_available,
    "models": [],  # Populated by discovery
},
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /home/jeremy/workspace/nova && docker compose up -d --build llm-gateway && sleep 5 && python -m pytest tests/test_inference_backends.py::TestVLLMProviderRegistration -v`
Expected: PASS — vLLM appears in catalog, marked as unavailable (no container running).

- [ ] **Step 5: Commit**

```bash
git add llm-gateway/app/providers/vllm_provider.py llm-gateway/app/providers/__init__.py llm-gateway/app/registry.py
git commit -m "feat: add VLLMProvider and register in gateway catalog"
```

---

### Task 7: Gateway /health/inflight Endpoint

**Files:**
- Modify: `llm-gateway/app/health.py`
- Modify: `llm-gateway/app/router.py` (add request counter)
- Test: `tests/test_inference_backends.py`

- [ ] **Step 1: Write the failing test**

Add to `tests/test_inference_backends.py`:

```python
class TestGatewayInflight:
    """Tests for the new /health/inflight endpoint."""

    @pytest.mark.asyncio
    async def test_inflight_endpoint_exists(self):
        """Gateway should expose /health/inflight with a count."""
        async with httpx.AsyncClient() as client:
            r = await client.get("http://localhost:8001/health/inflight")
            assert r.status_code == 200
            data = r.json()
            assert "local_inflight" in data
            assert isinstance(data["local_inflight"], int)
            assert data["local_inflight"] >= 0
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /home/jeremy/workspace/nova && python -m pytest tests/test_inference_backends.py::TestGatewayInflight -v`
Expected: FAIL — 404, endpoint doesn't exist.

- [ ] **Step 3: Add inflight request counter to gateway**

In `llm-gateway/app/router.py`, add a counter for local backend requests. In asyncio's single-threaded model, simple integer operations are atomic between await points, so no lock is needed. Add at module level:

```python
_local_inflight = 0
_LOCAL_PROVIDER_NAMES = {"ollama", "vllm", "sglang", "local"}


def get_local_inflight() -> int:
    return _local_inflight
```

Then in the `complete` and `stream` endpoint handlers, wrap the provider call with the counter. Find the point where the provider is resolved and the request is dispatched. For example, in the `complete` handler:

```python
provider = await get_provider(request.model)
is_local = provider.name in _LOCAL_PROVIDER_NAMES

global _local_inflight
if is_local:
    _local_inflight += 1
try:
    response = await provider.complete(request)
finally:
    if is_local:
        _local_inflight -= 1
```

Apply the same pattern to the `stream` handler (increment before, decrement in finally).

- [ ] **Step 4: Add /health/inflight endpoint**

In `llm-gateway/app/health.py`, add:

```python
from app.router import get_local_inflight

@router.get("/health/inflight")
async def health_inflight():
    """Return count of in-flight requests to local inference backends."""
    return {"local_inflight": get_local_inflight()}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd /home/jeremy/workspace/nova && docker compose up -d --build llm-gateway && sleep 5 && python -m pytest tests/test_inference_backends.py::TestGatewayInflight -v`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add llm-gateway/app/router.py llm-gateway/app/health.py tests/test_inference_backends.py
git commit -m "feat: add /health/inflight endpoint for local request tracking"
```

---

### Task 8: LocalInferenceProvider + Registry Refactor

**Files:**
- Create: `llm-gateway/app/providers/local_inference_provider.py`
- Modify: `llm-gateway/app/registry.py` (replace `_is_ollama_model`, rewire routing)
- Modify: `llm-gateway/app/config.py` (add inference config keys)
- Test: `tests/test_inference_backends.py`

- [ ] **Step 1: Write the failing test**

Add to `tests/test_inference_backends.py`:

```python
class TestLocalInferenceRouting:
    """Tests for the LocalInferenceProvider routing wrapper."""

    @pytest.mark.asyncio
    async def test_routing_strategy_still_works(self):
        """Routing strategy should still apply to local models after refactor."""
        async with httpx.AsyncClient() as client:
            # The routing strategy endpoint should still return valid strategies
            r = await client.get("http://localhost:8001/health/providers")
            assert r.status_code == 200
            # Existing cloud providers should still be listed
            providers = r.json()
            slugs = [p["slug"] for p in providers]
            # At minimum, cloud providers should still exist
            assert any(s in slugs for s in ["groq", "anthropic", "openai", "gemini"])
```

- [ ] **Step 2: Run test to verify current state passes (regression guard)**

Run: `cd /home/jeremy/workspace/nova && python -m pytest tests/test_inference_backends.py::TestLocalInferenceRouting -v`
Expected: PASS — this verifies the existing behavior before we refactor.

- [ ] **Step 3: Add inference config keys to gateway config**

In `llm-gateway/app/config.py`, add to the Settings class:

```python
# Inference backend config (read from Redis nova:config:inference.*)
inference_backend: str = "ollama"  # ollama, vllm, sglang, none
inference_state: str = "ready"  # ready, draining, starting, error
inference_url: str = ""  # Override URL (empty = use default for backend)
```

- [ ] **Step 4: Create LocalInferenceProvider**

Create `llm-gateway/app/providers/local_inference_provider.py`:

```python
"""Wrapper provider that delegates to whichever local backend is active."""
import logging
import time
from typing import AsyncIterator, Optional, Set

from nova_contracts.llm import (
    CompleteRequest, CompleteResponse, StreamChunk,
    EmbedRequest, EmbedResponse, ModelCapability,
)
from .base import ModelProvider
from .ollama_provider import OllamaProvider
from .vllm_provider import VLLMProvider

logger = logging.getLogger(__name__)

# Default URLs per backend (Docker Compose service names)
DEFAULT_URLS = {
    "ollama": "http://ollama:11434",
    "vllm": "http://nova-vllm:8000",
    "sglang": "http://nova-sglang:8000",
}

# Valid states where local routing is allowed
READY_STATES = {"ready"}


class LocalInferenceProvider(ModelProvider):
    """
    Wrapper that reads active backend config from Redis and delegates.

    Config keys (in Redis nova:config:*):
    - inference.backend: "ollama" | "vllm" | "sglang" | "none"
    - inference.state: "ready" | "draining" | "starting" | "error"
    - inference.url: override URL (empty = default for backend)
    """

    def __init__(self):
        self._current_backend: Optional[str] = None
        self._delegate: Optional[ModelProvider] = None
        self._local_models: Set[str] = set()
        self._config_cache_time = 0.0
        self._config_ttl = 5.0  # seconds

    @property
    def name(self) -> str:
        return "local"

    @property
    def capabilities(self) -> Set[ModelCapability]:
        if self._delegate:
            return self._delegate.capabilities
        return set()

    @property
    def is_available(self) -> bool:
        return self._delegate is not None and self._delegate.is_available

    def is_local_model(self, model: str) -> bool:
        """Check if a model name belongs to the active local backend."""
        return model in self._local_models

    def update_local_models(self, models: Set[str]) -> None:
        """Update the set of known local models (called by discovery)."""
        self._local_models = models

    async def refresh_config(self) -> None:
        """Read backend config from Redis and swap delegate if changed."""
        now = time.monotonic()
        if (now - self._config_cache_time) < self._config_ttl:
            return

        self._config_cache_time = now

        try:
            from app.registry import _get_redis_config
            backend = await _get_redis_config("inference.backend", "ollama")
            state = await _get_redis_config("inference.state", "ready")
            url_override = await _get_redis_config("inference.url", "")
        except Exception:
            logger.debug("Failed to read inference config from Redis, keeping current state")
            return

        # If state isn't ready, make delegate unavailable
        if state not in READY_STATES:
            if self._delegate and hasattr(self._delegate, '_healthy'):
                self._delegate._healthy = False
            return

        # If backend changed, recreate the delegate
        if backend != self._current_backend:
            self._current_backend = backend
            self._delegate = self._create_delegate(backend, url_override)
            self._local_models.clear()
            logger.info("Local inference backend changed to: %s", backend)

    def _create_delegate(self, backend: str, url_override: str) -> Optional[ModelProvider]:
        """Create a new provider instance for the given backend."""
        if backend == "none":
            return None

        url = url_override or DEFAULT_URLS.get(backend, "")
        if not url:
            logger.warning("No URL for backend %s", backend)
            return None

        if backend == "ollama":
            return OllamaProvider(base_url=url)
        elif backend == "vllm":
            return VLLMProvider(base_url=url)
        # sglang — Phase 3
        else:
            logger.warning("Unknown backend: %s", backend)
            return None

    async def complete(self, request: CompleteRequest) -> CompleteResponse:
        await self.refresh_config()
        self._assert_available()
        return await self._delegate.complete(request)

    async def stream(self, request: CompleteRequest) -> AsyncIterator[StreamChunk]:
        await self.refresh_config()
        self._assert_available()
        async for chunk in self._delegate.stream(request):
            yield chunk

    async def embed(self, request: EmbedRequest) -> EmbedResponse:
        await self.refresh_config()
        self._assert_available()
        return await self._delegate.embed(request)
```

- [ ] **Step 5: Refactor registry.py to use LocalInferenceProvider**

This is the key change. In `llm-gateway/app/registry.py`:

1. Import `LocalInferenceProvider`:
   ```python
   from .providers import LocalInferenceProvider
   ```

2. Create instance (~line 116, after other providers):
   ```python
   _local = LocalInferenceProvider()
   ```

3. Replace `_is_ollama_model(model)` (line 307-309) — change it to delegate to `_local.is_local_model(model)`:
   ```python
   def _is_local_model(model: str) -> bool:
       """Check if a model belongs to the active local inference backend."""
       return model in _OLLAMA_MODELS or _local.is_local_model(model)
   ```

   Keep `_OLLAMA_MODELS` as a fallback for now — it ensures Ollama models still route correctly even before discovery has run.

4. In `get_provider(model)` (~line 515), replace references to `_is_ollama_model` with `_is_local_model`. Replace direct `_ollama` references in strategy routing with `_local`:

   - `local-only`: route to `_local` instead of `_ollama`
   - `local-first`: use `_local` as primary, cloud as fallback
   - `cloud-first`: cloud primary, `_local` as fallback
   - `cloud-only`: no change (skips local)

5. Add `_local` to `get_provider_catalog()` as the "local" provider entry.

6. Call `await _local.refresh_config()` at the start of `get_provider()`.

- [ ] **Step 6: Run tests to verify refactor didn't break routing**

Run: `cd /home/jeremy/workspace/nova && docker compose up -d --build llm-gateway && sleep 5 && python -m pytest tests/test_inference_backends.py::TestLocalInferenceRouting tests/test_llm_gateway.py -v`
Expected: PASS — routing still works, existing LLM gateway tests still pass.

- [ ] **Step 7: Commit**

```bash
git add llm-gateway/app/providers/local_inference_provider.py llm-gateway/app/config.py llm-gateway/app/registry.py
git commit -m "feat: add LocalInferenceProvider wrapper, refactor routing to support multiple local backends"
```

---

## Chunk 4: Backend Lifecycle + Discovery

### Task 9: Backend Controller in Recovery Service

**Files:**
- Create: `recovery-service/app/inference/controller.py`
- Modify: `recovery-service/app/inference/routes.py` (add lifecycle endpoints)
- Modify: `recovery-service/app/docker_client.py` (add nova-vllm to OPTIONAL_SERVICES)
- Test: `tests/test_inference_backends.py`

- [ ] **Step 1: Write the failing test**

Add to `tests/test_inference_backends.py`:

```python
class TestBackendLifecycle:
    """Tests for backend lifecycle management via recovery service."""

    @pytest.mark.asyncio
    async def test_get_backend_status(self):
        """Recovery should report current backend status."""
        async with httpx.AsyncClient() as client:
            r = await client.get(f"{BASE}/api/v1/recovery/inference/backend", headers=HEADERS)
            assert r.status_code == 200
            data = r.json()
            assert "backend" in data
            assert "state" in data
            assert data["state"] in ["ready", "stopped", "draining", "starting", "error"]

    @pytest.mark.asyncio
    async def test_list_available_backends(self):
        """Recovery should list all available backends with their status."""
        async with httpx.AsyncClient() as client:
            r = await client.get(f"{BASE}/api/v1/recovery/inference/backends", headers=HEADERS)
            assert r.status_code == 200
            data = r.json()
            assert isinstance(data, list)
            names = [b["name"] for b in data]
            assert "ollama" in names
            assert "vllm" in names
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /home/jeremy/workspace/nova && python -m pytest tests/test_inference_backends.py::TestBackendLifecycle -v`
Expected: FAIL — 404.

- [ ] **Step 3: Add nova-vllm to docker_client.py OPTIONAL_SERVICES**

In `recovery-service/app/docker_client.py`, add to `OPTIONAL_SERVICES` dict (~line 22):

```python
"nova-vllm": "local-vllm",
```

- [ ] **Step 4: Create the backend controller**

Create `recovery-service/app/inference/controller.py`:

```python
"""Backend lifecycle controller — start/stop/switch inference containers."""
import asyncio
import logging
from typing import Optional

from app.compose_client import start_profiled_service, stop_profiled_service
from app.docker_client import check_container_status
from app.redis_client import read_config, write_config_state

logger = logging.getLogger(__name__)

# Backend → Docker Compose mapping
BACKENDS = {
    "ollama": {"profile": "local-ollama", "service": "ollama", "container": "nova-ollama"},
    "vllm": {"profile": "local-vllm", "service": "nova-vllm", "container": "nova-vllm"},
}

# Health check state
_health_task: Optional[asyncio.Task] = None
_health_failures: int = 0
_health_backoff: float = 30.0


async def get_backend_status() -> dict:
    """Get current backend status."""
    backend = await read_config("inference.backend", "ollama")
    state = await read_config("inference.state", "stopped")

    container_status = None
    if backend in BACKENDS:
        info = BACKENDS[backend]
        container_status = check_container_status(info["container"])

    return {
        "backend": backend,
        "state": state,
        "container_status": container_status,
    }


async def list_backends() -> list[dict]:
    """List all available backends with their container status."""
    results = []
    for name, info in BACKENDS.items():
        status = check_container_status(info["container"])
        results.append({
            "name": name,
            "profile": info["profile"],
            "service": info["service"],
            "container_running": status is not None and status.get("status") == "running" if isinstance(status, dict) else False,
        })
    return results


async def start_backend(backend: str) -> dict:
    """Start an inference backend container."""
    if backend not in BACKENDS:
        raise ValueError(f"Unknown backend: {backend}. Valid: {list(BACKENDS.keys())}")

    info = BACKENDS[backend]
    current = await read_config("inference.backend", "")

    # If switching from another backend, run the switching protocol
    if current and current != backend and current != "none":
        await _stop_backend(current)

    await write_config_state("inference.state", "starting")
    await write_config_state("inference.backend", backend)

    try:
        await start_profiled_service(info["profile"], info["service"])
        await _wait_for_healthy(info["container"], timeout=120)
        await write_config_state("inference.state", "ready")
        logger.info("Backend %s started successfully", backend)
    except Exception as e:
        await write_config_state("inference.state", "error")
        logger.error("Failed to start backend %s: %s", backend, e)
        raise

    # Start health monitoring
    _start_health_monitor(backend)

    return await get_backend_status()


async def stop_backend(backend: Optional[str] = None) -> dict:
    """Stop the active inference backend."""
    if backend is None:
        backend = await read_config("inference.backend", "")
    if not backend or backend == "none":
        return {"backend": "none", "state": "stopped"}

    await _stop_backend(backend)
    await write_config_state("inference.backend", "none")
    await write_config_state("inference.state", "stopped")
    return await get_backend_status()


async def switch_backend(new_backend: str) -> dict:
    """Switch from current backend to a new one (with drain protocol)."""
    return await start_backend(new_backend)


async def _stop_backend(backend: str) -> None:
    """Stop a backend with drain protocol."""
    if backend not in BACKENDS:
        return

    info = BACKENDS[backend]

    # Signal draining
    await write_config_state("inference.state", "draining")
    logger.info("Draining backend %s...", backend)

    # Wait for in-flight requests (poll gateway)
    await _drain_requests(timeout=15)

    # Stop the container
    _stop_health_monitor()
    try:
        await stop_profiled_service(info["profile"], info["service"])
    except Exception as e:
        logger.warning("Error stopping %s: %s", backend, e)


async def _drain_requests(timeout: float = 15.0) -> None:
    """Wait for in-flight local requests to complete."""
    import httpx

    deadline = asyncio.get_event_loop().time() + timeout
    while asyncio.get_event_loop().time() < deadline:
        try:
            async with httpx.AsyncClient(timeout=3.0) as client:
                r = await client.get("http://llm-gateway:8001/health/inflight")
                if r.status_code == 200:
                    count = r.json().get("local_inflight", 0)
                    if count == 0:
                        logger.info("Drain complete — no in-flight requests")
                        return
                    logger.info("Draining: %d requests in-flight", count)
        except Exception:
            break  # Gateway unreachable, proceed with shutdown
        await asyncio.sleep(1)

    logger.warning("Drain timeout after %.0fs, proceeding with shutdown", timeout)


async def _wait_for_healthy(container_name: str, timeout: float = 120.0) -> None:
    """Wait for a container to become healthy."""
    import httpx

    deadline = asyncio.get_event_loop().time() + timeout
    while asyncio.get_event_loop().time() < deadline:
        status = check_container_status(container_name)
        if isinstance(status, dict) and status.get("status") == "running":
            # Also check if the HTTP server is responding
            backend = await read_config("inference.backend", "")
            if backend == "vllm":
                try:
                    async with httpx.AsyncClient(timeout=3.0) as client:
                        r = await client.get("http://nova-vllm:8000/health")
                        if r.status_code == 200:
                            return
                except Exception:
                    pass
            elif backend == "ollama":
                try:
                    async with httpx.AsyncClient(timeout=3.0) as client:
                        r = await client.get("http://ollama:11434/api/tags")
                        if r.status_code == 200:
                            return
                except Exception:
                    pass
            else:
                return  # Unknown backend, just check container is running
        await asyncio.sleep(5)

    raise TimeoutError(f"Container {container_name} did not become healthy within {timeout}s")


def _start_health_monitor(backend: str) -> None:
    """Start background health monitoring for the active backend."""
    global _health_task, _health_failures, _health_backoff
    _stop_health_monitor()
    _health_failures = 0
    _health_backoff = 30.0
    _health_task = asyncio.create_task(_health_monitor_loop(backend))


def _stop_health_monitor() -> None:
    """Stop background health monitoring."""
    global _health_task
    if _health_task and not _health_task.done():
        _health_task.cancel()
        _health_task = None


async def _health_monitor_loop(backend: str) -> None:
    """Periodically check backend container health."""
    global _health_failures, _health_backoff

    while True:
        await asyncio.sleep(_health_backoff)

        try:
            info = BACKENDS.get(backend, {})
            container_name = info.get("container", "")
            cs = check_container_status(container_name) if container_name else {}
            is_running = isinstance(cs, dict) and cs.get("status") == "running"

            if not is_running:
                _health_failures += 1
                logger.warning("Backend %s health check failed (%d/3)", backend, _health_failures)

                if _health_failures >= 3:
                    logger.error("Backend %s: 3 consecutive failures, attempting restart", backend)
                    try:
                        # Restart container directly (don't call start_backend
                        # which would create another health monitor)
                        await start_profiled_service(info["profile"], info["service"])
                        _health_failures = 0
                        _health_backoff = 30.0
                        await write_config_state("inference.state", "ready")
                    except Exception as e:
                        logger.error("Failed to restart %s: %s", backend, e)
                        _health_backoff = min(_health_backoff * 2, 120.0)
                        await write_config_state("inference.state", "error")
            else:
                _health_failures = 0
                _health_backoff = 30.0
        except asyncio.CancelledError:
            break
        except Exception as e:
            logger.error("Health monitor error: %s", e)
```

- [ ] **Step 5: Add lifecycle endpoints to inference routes**

In `recovery-service/app/inference/routes.py`, add:

```python
from app.inference.controller import (
    get_backend_status, list_backends, start_backend, stop_backend, switch_backend,
)

@router.get("/backend")
async def get_inference_backend():
    """Get current inference backend status."""
    return await get_backend_status()


@router.get("/backends")
async def list_inference_backends():
    """List all available inference backends."""
    return await list_backends()


@router.post("/backend/{backend_name}/start")
async def start_inference_backend(backend_name: str):
    """Start (or switch to) an inference backend."""
    try:
        return await start_backend(backend_name)
    except ValueError as e:
        from fastapi import HTTPException
        raise HTTPException(status_code=400, detail=str(e))
    except TimeoutError as e:
        from fastapi import HTTPException
        raise HTTPException(status_code=504, detail=str(e))


@router.post("/backend/stop")
async def stop_inference_backend():
    """Stop the active inference backend."""
    return await stop_backend()
```

- [ ] **Step 6: Run test to verify it passes**

Run: `cd /home/jeremy/workspace/nova && docker compose up -d --build recovery && sleep 5 && python -m pytest tests/test_inference_backends.py::TestBackendLifecycle -v`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add recovery-service/app/inference/controller.py recovery-service/app/inference/routes.py recovery-service/app/docker_client.py
git commit -m "feat: add backend lifecycle controller with drain protocol and health monitoring"
```

---

### Task 10: vLLM Model Discovery in Gateway

**Files:**
- Modify: `llm-gateway/app/discovery.py` (add `_discover_vllm()`)
- Test: `tests/test_inference_backends.py`

- [ ] **Step 1: Write the failing test**

Add to `tests/test_inference_backends.py`:

```python
class TestVLLMDiscovery:
    """Tests for vLLM model discovery."""

    @pytest.mark.asyncio
    async def test_discover_includes_vllm_provider(self):
        """Model discovery should include vLLM as a provider (even if unavailable)."""
        async with httpx.AsyncClient(timeout=30) as client:
            r = await client.get("http://localhost:8001/v1/models/discover")
            assert r.status_code == 200
            data = r.json()
            slugs = [p["slug"] for p in data]
            assert "vllm" in slugs
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /home/jeremy/workspace/nova && python -m pytest tests/test_inference_backends.py::TestVLLMDiscovery -v`
Expected: FAIL — vLLM not in discovery results.

- [ ] **Step 3: Add _discover_vllm() to discovery.py**

In `llm-gateway/app/discovery.py`, add a discovery coroutine for vLLM, following the same pattern as `_discover_ollama()`:

```python
async def _discover_vllm() -> list[DiscoveredModel]:
    """Discover models from a running vLLM server."""
    models = []

    try:
        # Read URL from config (default to Docker Compose service name)
        url = await _get_redis_config("inference.url", "") or "http://nova-vllm:8000"
        backend = await _get_redis_config("inference.backend", "ollama")

        if backend != "vllm":
            return []  # vLLM not the active backend

        async with httpx.AsyncClient(timeout=5.0) as client:
            r = await client.get(f"{url}/v1/models")
            if r.status_code == 200:
                data = r.json()
                for m in data.get("data", []):
                    model_id = m.get("id", "")
                    if model_id:
                        registered = model_id in MODEL_REGISTRY
                        models.append(DiscoveredModel(id=model_id, registered=registered))
    except Exception as e:
        logger.debug("vLLM discovery failed: %s", e)

    return models
```

This returns `list[DiscoveredModel]` (matching all other discovery functions like `_discover_ollama`). The `discover_all()` function wraps these into `ProviderModelList` objects.

Additionally, add vLLM to `_PROVIDER_META` (the list of provider metadata used by `discover_all()`) and `_is_provider_available()`:

```python
# Add to _PROVIDER_META list:
{"slug": "vllm", "name": "vLLM", "type": "local"},

# Add to _is_provider_available():
if slug == "vllm":
    backend = await _get_redis_config("inference.backend", "ollama")
    return backend == "vllm"
```

Add `_discover_vllm` to `_DISCOVERY_FNS` dict (maps slug → coroutine):
```python
"vllm": _discover_vllm,
```

Also import `_get_redis_config` from registry if not already available, or duplicate the Redis config read pattern (the existing `_discover_ollama` already does this via direct Redis reads).

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /home/jeremy/workspace/nova && docker compose up -d --build llm-gateway && sleep 5 && python -m pytest tests/test_inference_backends.py::TestVLLMDiscovery -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add llm-gateway/app/discovery.py
git commit -m "feat: add vLLM model discovery to gateway"
```

---

## Chunk 5: Config Sync + Setup Script

### Task 11: Orchestrator Config Sync for Inference Keys

**Files:**
- Modify: `orchestrator/app/config_sync.py`

- [ ] **Step 1: Add inference.* keys to config sync**

In `orchestrator/app/config_sync.py`, the `sync_llm_config_to_redis()` function syncs all `llm.*` keys. Add a similar sync for `inference.*` keys. Add to the sync function or create a new one:

```python
async def sync_inference_config_to_redis() -> None:
    """Sync inference.* platform config keys to Redis for the LLM gateway."""
    try:
        rows = await db.fetch("SELECT key, value FROM platform_config WHERE key LIKE 'inference.%'")
        for row in rows:
            await push_config_to_redis(row["key"], row["value"])
    except Exception as e:
        logger.warning("Failed to sync inference config: %s", e)
```

Call this from the same startup hook that calls `sync_llm_config_to_redis()`.

Also, in `orchestrator/app/router.py`, find the `update_platform_config` endpoint (the `PATCH /api/v1/config/{key}` handler, ~line 561). There's an existing block that pushes `llm.*` keys to Redis on update:

```python
if key.startswith("llm."):
    try:
        from app.config_sync import push_config_to_redis
        await push_config_to_redis(key, req.value)
    except Exception as e:
        log.warning("Failed to publish config %s to Redis: %s", key, e)
```

Add the same block for `inference.*` keys immediately after:

```python
if key.startswith("inference."):
    try:
        from app.config_sync import push_config_to_redis
        await push_config_to_redis(key, req.value)
    except Exception as e:
        log.warning("Failed to publish config %s to Redis: %s", key, e)
```

This is the critical real-time path: when the user changes the backend in the dashboard, the config must reach the gateway immediately (not just on restart).

- [ ] **Step 2: Verify orchestrator starts cleanly**

Run: `cd /home/jeremy/workspace/nova && docker compose up -d --build orchestrator && docker compose logs orchestrator --tail 10`
Expected: No errors related to inference config (keys don't exist yet, which is fine — the function handles empty results).

- [ ] **Step 3: Commit**

```bash
git add orchestrator/app/config_sync.py
git commit -m "feat: sync inference.* config keys to Redis for gateway"
```

---

### Task 12: Update setup.sh

**Files:**
- Modify: `scripts/setup.sh`

- [ ] **Step 1: Add hardware detection call to setup.sh**

In `scripts/setup.sh`, after the existing GPU detection block (~line 55) and before service startup, add:

```bash
# --- Hardware Detection ---
echo ""
echo "Detecting hardware..."
./scripts/detect_hardware.sh data/hardware.json
echo ""
```

The existing GPU detection in setup.sh (which sets compose file overlays) remains — `detect_hardware.sh` is complementary (it writes detailed JSON for the recovery service).

- [ ] **Step 2: Commit**

```bash
git add scripts/setup.sh
git commit -m "feat: run hardware detection during setup"
```

---

## Chunk 6: Dashboard UI

### Task 13: LocalInferenceSection Settings Component

**Files:**
- Create: `dashboard/src/pages/settings/LocalInferenceSection.tsx`
- Modify: `dashboard/src/pages/Settings.tsx` (add to ai category)
- Test: `cd dashboard && npm run build` (TypeScript compilation check)

- [ ] **Step 1: Create the LocalInferenceSection component**

Create `dashboard/src/pages/settings/LocalInferenceSection.tsx`. Follow the existing pattern from `LLMRoutingSection.tsx` — uses `Section`, `ConfigField`, `useConfigValue` from `shared.tsx`:

```tsx
import { useState, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Cpu, Play, Square, RefreshCw, Wifi, AlertCircle } from "lucide-react";
import { Section, ConfigField, useConfigValue, type ConfigSectionProps } from "./shared";
import { recoveryFetch } from "../../api-recovery";

interface HardwareInfo {
  gpus: Array<{ vendor: string; model: string; vram_gb: number; index: number }>;
  docker_gpu_runtime: string;
  cpu_cores: number;
  ram_gb: number;
  disk_free_gb: number;
  detected_at: string;
  recommended_backend: string;
}

interface BackendStatus {
  backend: string;
  state: string;
  container_status: unknown;
}

const BACKENDS = [
  { value: "vllm", label: "vLLM", description: "Production GPU inference (NVIDIA/AMD)" },
  { value: "ollama", label: "Ollama", description: "Easy mode / CPU fallback" },
  { value: "none", label: "None", description: "Cloud providers only" },
] as const;

const STATE_LABELS: Record<string, { label: string; color: string }> = {
  ready: { label: "Running", color: "text-emerald-400" },
  stopped: { label: "Stopped", color: "text-neutral-500 dark:text-neutral-500" },
  starting: { label: "Starting...", color: "text-amber-400" },
  draining: { label: "Draining...", color: "text-amber-400" },
  error: { label: "Error", color: "text-red-400" },
};

export function LocalInferenceSection({ entries, onSave, saving }: ConfigSectionProps) {
  const queryClient = useQueryClient();
  const [selectedBackend, setSelectedBackend] = useState<string>("");
  const [showRemote, setShowRemote] = useState(false);

  // Extract all hook calls at top level (Rules of Hooks — never call hooks conditionally)
  const configBackend = useConfigValue(entries, "inference.backend", "ollama");
  const remoteUrl = useConfigValue(entries, "inference.url", "");
  const wolMac = useConfigValue(entries, "llm.wol_mac", "");

  // Fetch hardware info from recovery service
  const { data: hardware } = useQuery<HardwareInfo>({
    queryKey: ["inference-hardware"],
    queryFn: () => recoveryFetch<HardwareInfo>("/api/v1/recovery/inference/hardware"),
    staleTime: 60_000,
    retry: 1,
  });

  // Fetch backend status from recovery service
  const { data: status, refetch: refetchStatus } = useQuery<BackendStatus>({
    queryKey: ["inference-backend-status"],
    queryFn: () => recoveryFetch<BackendStatus>("/api/v1/recovery/inference/backend"),
    staleTime: 5_000,
    refetchInterval: (query) => {
      const state = query.state.data?.state;
      return state === "starting" || state === "draining" ? 2_000 : 10_000;
    },
    retry: 1,
  });

  // Start/switch backend mutation
  const startBackend = useMutation({
    mutationFn: (backend: string) =>
      recoveryFetch(`/api/v1/recovery/inference/backend/${backend}/start`, {
        method: "POST",
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["inference-backend-status"] });
    },
  });

  // Stop backend mutation
  const stopBackend = useMutation({
    mutationFn: () =>
      recoveryFetch("/api/v1/recovery/inference/backend/stop", {
        method: "POST",
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["inference-backend-status"] });
    },
  });

  useEffect(() => {
    if (configBackend && !selectedBackend) {
      setSelectedBackend(configBackend);
    }
  }, [configBackend]);

  const currentState = status?.state || "stopped";
  const stateInfo = STATE_LABELS[currentState] || STATE_LABELS.stopped;
  const isTransitioning = currentState === "starting" || currentState === "draining";

  const hasGpu = hardware?.gpus && hardware.gpus.length > 0;
  const primaryGpu = hardware?.gpus?.[0];

  return (
    <Section id="local-inference" icon={Cpu} title="Local Inference" description="Manage your local AI inference backend">
      {/* Hardware Info */}
      {hardware && (
        <div className="mb-4 p-3 bg-neutral-50 dark:bg-neutral-800/50 rounded-lg text-sm">
          {hasGpu ? (
            <div className="flex items-center gap-2">
              <span className="text-emerald-600 dark:text-emerald-400">GPU Detected:</span>
              <span className="text-neutral-700 dark:text-neutral-300">
                {primaryGpu?.model} ({primaryGpu?.vram_gb}GB VRAM)
                {hardware.gpus.length > 1 && ` + ${hardware.gpus.length - 1} more`}
              </span>
            </div>
          ) : (
            <div className="flex items-center gap-2 text-neutral-500 dark:text-neutral-400">
              <AlertCircle className="w-4 h-4" />
              <span>No GPU detected. Ollama (CPU) or cloud providers recommended.</span>
            </div>
          )}
          {hardware.recommended_backend && (
            <div className="mt-1 text-neutral-500">
              Recommended: <span className="text-accent-600 dark:text-accent-400">{hardware.recommended_backend}</span>
            </div>
          )}
        </div>
      )}

      {/* Backend Selector */}
      <div className="space-y-3">
        <label className="block text-sm font-medium text-neutral-700 dark:text-neutral-300">Backend</label>
        <div className="flex gap-2">
          {BACKENDS.map((b) => (
            <button
              key={b.value}
              onClick={() => {
                setSelectedBackend(b.value);
                onSave("inference.backend", b.value);
              }}
              disabled={isTransitioning}
              className={`px-4 py-2 rounded-lg text-sm transition-colors ${
                (status?.backend || configBackend) === b.value
                  ? "bg-accent-600 text-white"
                  : "bg-neutral-100 dark:bg-neutral-700 text-neutral-700 dark:text-neutral-300 hover:bg-neutral-200 dark:hover:bg-neutral-600"
              } ${isTransitioning ? "opacity-50 cursor-not-allowed" : ""}`}
            >
              {b.label}
            </button>
          ))}
        </div>
      </div>

      {/* Status */}
      {status && status.backend !== "none" && (
        <div className="mt-4 p-3 bg-neutral-50 dark:bg-neutral-800/50 rounded-lg">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className={`text-sm font-medium ${stateInfo.color}`}>
                {stateInfo.label}
              </span>
              <span className="text-xs text-neutral-500">{status.backend}</span>
            </div>
            <div className="flex gap-2">
              {currentState === "ready" ? (
                <button
                  onClick={() => stopBackend.mutate()}
                  disabled={stopBackend.isPending}
                  className="p-1.5 rounded hover:bg-neutral-200 dark:hover:bg-neutral-700 text-neutral-500 dark:text-neutral-400"
                  title="Stop backend"
                >
                  <Square className="w-4 h-4" />
                </button>
              ) : currentState === "stopped" || currentState === "error" ? (
                <button
                  onClick={() => startBackend.mutate(status.backend)}
                  disabled={startBackend.isPending}
                  className="p-1.5 rounded hover:bg-neutral-200 dark:hover:bg-neutral-700 text-neutral-500 dark:text-neutral-400"
                  title="Start backend"
                >
                  <Play className="w-4 h-4" />
                </button>
              ) : null}
              <button
                onClick={() => refetchStatus()}
                className="p-1.5 rounded hover:bg-neutral-200 dark:hover:bg-neutral-700 text-neutral-500 dark:text-neutral-400"
                title="Refresh status"
              >
                <RefreshCw className="w-4 h-4" />
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Remote Backend Toggle */}
      <div className="mt-4 pt-4 border-t border-neutral-200 dark:border-neutral-700/50">
        <label className="flex items-center gap-2 text-sm text-neutral-500 dark:text-neutral-400 cursor-pointer">
          <input
            type="checkbox"
            checked={showRemote}
            onChange={(e) => setShowRemote(e.target.checked)}
            className="rounded bg-neutral-100 dark:bg-neutral-700 border-neutral-300 dark:border-neutral-600"
          />
          <Wifi className="w-4 h-4" />
          Use remote inference server
        </label>

        {showRemote && (
          <div className="mt-3 space-y-3">
            <ConfigField
              label="Remote URL"
              configKey="inference.url"
              value={remoteUrl}
              onSave={onSave}
              saving={saving}
              placeholder="http://192.168.1.50:8000"
              description="URL of remote vLLM/Ollama/SGLang server"
            />
            <ConfigField
              label="WoL MAC Address"
              configKey="llm.wol_mac"
              value={wolMac}
              onSave={onSave}
              saving={saving}
              placeholder="aa:bb:cc:dd:ee:ff"
              description="Send Wake-on-LAN to start remote GPU machine"
            />
          </div>
        )}
      </div>

      {/* No GPU + No Remote guidance */}
      {!hasGpu && !showRemote && status?.backend !== "ollama" && (
        <div className="mt-3 p-3 bg-neutral-50 dark:bg-neutral-800/30 rounded text-sm text-neutral-500">
          No GPU detected and no remote server configured. Consider using Ollama (CPU) or configure cloud providers below.
        </div>
      )}
    </Section>
  );
}
```

Note: Uses `recoveryFetch` from `api-recovery.ts` (not `apiFetch` — matches existing pattern for recovery service calls). All `useConfigValue` hooks are called at the top of the component (Rules of Hooks — never inside conditional JSX). Uses semantic color tokens (`neutral-*`, `accent-*`) with `dark:` variants instead of raw `stone-*`/`teal-*` classes (matches the dashboard's Tailwind theme). The `id="local-inference"` prop enables IntersectionObserver scroll targeting.

- [ ] **Step 2: Add LocalInferenceSection to Settings.tsx**

In `dashboard/src/pages/Settings.tsx`, import and add to the `ai` category sections. It should be the **first** section in the ai tab (before LLM Routing):

```tsx
import { LocalInferenceSection } from "./settings/LocalInferenceSection";
```

In the ai category render block, add before `<LLMRoutingSection>`:

```tsx
<LocalInferenceSection entries={entries} onSave={handleSave} saving={saving} />
```

- [ ] **Step 3: Verify TypeScript compilation**

Run: `cd /home/jeremy/workspace/nova/dashboard && npm run build`
Expected: Compiles without errors.

- [ ] **Step 4: Commit**

```bash
git add dashboard/src/pages/settings/LocalInferenceSection.tsx dashboard/src/pages/Settings.tsx
git commit -m "feat: add Local Inference settings section to dashboard"
```

---

## Chunk 7: Integration Tests + Final Verification

### Task 14: Complete Integration Test Suite

**Files:**
- Modify: `tests/test_inference_backends.py`

- [ ] **Step 1: Add end-to-end config flow test**

Add to `tests/test_inference_backends.py`:

```python
class TestInferenceConfigFlow:
    """End-to-end test: config change flows from orchestrator to gateway."""

    @pytest.mark.asyncio
    async def test_set_inference_backend_via_orchestrator(self, orchestrator, llm_gateway):
        """Setting inference.backend via orchestrator should reach the gateway.

        Uses orchestrator and llm_gateway fixtures from conftest.py (httpx.AsyncClient
        instances with correct base URLs and auth headers).
        """
        try:
            # Set config via orchestrator — PATCH /api/v1/config/{key}
            r = await orchestrator.patch(
                "/api/v1/config/inference.backend",
                json={"value": '"vllm"'},
            )
            assert r.status_code == 200

            # Wait for sync (config cache TTL is 5s)
            import asyncio
            await asyncio.sleep(6)

            # Verify gateway sees the change via provider catalog
            r = await llm_gateway.get("/health/providers")
            assert r.status_code == 200
        finally:
            # Always reset to ollama, even if assertions fail
            await orchestrator.patch(
                "/api/v1/config/inference.backend",
                json={"value": '"ollama"'},
            )
```

Note: Uses `orchestrator` and `llm_gateway` fixtures from `conftest.py` (not raw `httpx.AsyncClient`). The config endpoint is `PATCH /api/v1/config/{key}` with body `{"value": "<json-string>"}` (not `PATCH /api/v1/settings`). Cleanup is in a `try/finally` to ensure reset even on assertion failure.

- [ ] **Step 2: Run the complete test suite**

Run: `cd /home/jeremy/workspace/nova && python -m pytest tests/test_inference_backends.py -v`
Expected: All tests pass.

- [ ] **Step 3: Run the existing test suite to verify no regressions**

Run: `cd /home/jeremy/workspace/nova && python -m pytest tests/test_health.py tests/test_llm_gateway.py tests/test_recovery.py -v`
Expected: All existing tests still pass.

- [ ] **Step 4: Commit**

```bash
git add tests/test_inference_backends.py
git commit -m "test: add integration tests for managed inference backends"
```

---

### Task 15: Final Verification + CLAUDE.md Update

**Files:**
- Modify: `CLAUDE.md` (update Redis DB allocation comment)

- [ ] **Step 1: Update Redis DB allocation in CLAUDE.md**

In CLAUDE.md, update the Redis DB allocation line to include recovery:

```
**Redis DB allocation:** orchestrator=db2, llm-gateway=db1, chat-api=db3, memory-service=db0, chat-bridge=db4, cortex=db5, recovery=db7.
```

- [ ] **Step 2: Run the full test suite**

Run: `cd /home/jeremy/workspace/nova && make test`
Expected: All tests pass, including the new inference backend tests.

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: update Redis DB allocation with recovery=db7"
```

---

## Dependency Graph

```
Task 1 (Docker Compose vLLM) ──────────────────────────────┐
Task 2 (Recovery Redis) ──────────┐                         │
Task 3 (Hardware Script) ─────────┤                         │
Task 4 (Hardware Module) ◄────────┤                         │
                                  │                         │
Task 5 (OpenAICompatProvider) ────┤                         │
Task 6 (VLLMProvider) ◄───────────┤                         │
Task 7 (Health/Inflight) ─────────┤                         │
Task 8 (LocalInference + Registry)◄───┤                    │
                                      │                     │
Task 9 (Backend Controller) ◄─────────┼─────────────────────┘
Task 10 (vLLM Discovery) ◄────────────┤
Task 11 (Config Sync) ────────────────┤
Task 12 (Setup Script) ───────────────┤
Task 13 (Dashboard UI) ◄──────────────┤
Task 14 (Integration Tests) ◄─────────┘
Task 15 (Final Verification)  ◄────────┘
```

**Parallelizable groups:**
- Tasks 1, 2, 3 can run in parallel (no interdependencies)
- Tasks 5, 7 can run in parallel (both gateway, no shared code)
- Tasks 11, 12 can run in parallel (orchestrator + setup script)
