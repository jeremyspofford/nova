"""How much context a local model actually gets, decided per model.

`inference.ollama_num_ctx` was one number applied to every local model, and
it was wrong in both directions at once: 16,384 starved `ornith:9b`, which
supports 262,144, while being more than a 3B needs — and if an operator
raised it to suit the biggest model, the KV cache for a 14B would not fit in
VRAM, ollama would silently spill to system RAM, and every local turn would
crawl. So the setting could not be right, and getting it wrong was invisible.

Nothing here is predicted. Every input is measured from something that
already reports it:

  * the model's real ceiling            ollama /api/show  model_info
  * the weights' size on disk           ollama /api/tags  size
  * what is resident RIGHT NOW, and     ollama /api/ps    size, size_vram
    whether it SPILLED to system RAM
  * total VRAM on the box               the inference-control sidecar, via
                                        hardware.py, which is already the
                                        only thing that measures it

The KV cost per token is the one number nobody publishes, so it is LEARNED
rather than assumed: a loaded model's resident size minus its weights,
divided by the window it was loaded with. Measured 2026-07-28,
qwen3:14b at 16,384 was 11.8GB resident against 9.3GB of weights — about
160KB per token. That figure is per-model and this derives it per-model.

FAILING SAFE IS THE POINT. Every probe is optional; if any of them cannot
answer, this returns the operator's setting and behaves exactly as before.
And the answer is checked after the fact: `note_spill` reads /api/ps after a
load, and a model that spilled has its ceiling lowered for next time. A wrong
guess costs one slow turn and corrects itself, which is the only version of
this that is safe to turn on by default.
"""

from __future__ import annotations

import logging
import time
from typing import Optional

import httpx

log = logging.getLogger(__name__)

# Never go below this: a window too small to hold the system prompt is worse
# than a slow one, because ollama truncates from the HEAD and the agent
# quietly loses its role and its tool contract.
_FLOOR = 8192

# Leave this much VRAM unclaimed. Whisper, kokoro and a second model share
# this GPU, and a fallback that evicts the speech stack to answer one
# question has not helped anybody.
_RESERVE_GB = 2.0

# Used only until a model has been observed once. Deliberately pessimistic —
# over-reserving costs window, under-reserving costs a spill to system RAM.
_DEFAULT_KV_BYTES_PER_TOKEN = 200_000

_TTL_S = 300.0
_cache: dict[str, tuple[float, int]] = {}      # model -> (expires_at, num_ctx)
_kv_learned: dict[str, float] = {}             # model -> bytes per token
_ceiling: dict[str, int] = {}                  # model -> known-good after a spill


def _base() -> str:
    from app import settings_store
    return str(settings_store.get("inference.ollama_url")).rstrip("/")


async def _get(path: str, payload: Optional[dict] = None) -> Optional[dict]:
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            resp = (await client.post(_base() + path, json=payload) if payload
                    else await client.get(_base() + path))
            resp.raise_for_status()
            return resp.json()
    except Exception as exc:  # noqa: BLE001 — a probe never breaks a turn
        log.debug("ollama %s unavailable: %s", path, exc)
        return None


async def _weights_bytes(name: str) -> Optional[int]:
    tags = await _get("/api/tags")
    for m in (tags or {}).get("models") or []:
        if m.get("name") == name:
            return int(m.get("size") or 0) or None
    return None


async def _resident() -> list[dict]:
    return ((await _get("/api/ps")) or {}).get("models") or []


async def _free_vram_bytes(for_model: Optional[str] = None) -> Optional[int]:
    """VRAM this model could actually claim, right now.

    Read from the WHOLE GPU, not from what ollama holds. The first version
    subtracted only ollama's own footprint and reported 22GB free on a card
    where whisper and kokoro were holding several — sizing a KV cache against
    memory that belongs to the speech stack is how you get the silent spill
    this module exists to prevent.

    If `for_model` is already resident its footprint is added back, because
    changing a model's window makes ollama reload it: the memory it is using
    now is memory the new window gets to reuse.
    """
    from app.config import settings
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            resp = await client.get(f"{settings.inference_control_url}/gpu-stats")
            resp.raise_for_status()
            gpus = resp.json().get("gpus") or []
    except Exception as exc:  # noqa: BLE001
        log.debug("gpu-stats unavailable: %s", exc)
        return None
    if not gpus:
        return None
    total = sum(float(g.get("mem_total_gb") or 0) for g in gpus)
    used = sum(float(g.get("mem_used_gb") or 0) for g in gpus)
    if not total:
        return None
    reclaimable = 0
    if for_model:
        for m in await _resident():
            if m.get("name") == for_model:
                reclaimable = int(m.get("size_vram") or 0)
                break
    free = int((total - used) * 1e9) + reclaimable - int(_RESERVE_GB * 1e9)
    return max(0, free)


async def _explicitly_set(key: str) -> bool:
    """True when the operator has actually chosen this setting.

    A default is not a decision. With dynamic sizing on, an untouched
    `ollama_num_ctx` must not act as a ceiling — otherwise the feature ships
    switched on and clamped to the same 16,384 it exists to replace, which is
    exactly what the first version did.
    """
    from app import db
    try:
        async with db.acquire() as conn:
            return bool(await conn.fetchval(
                "SELECT 1 FROM settings WHERE key = $1", key))
    except Exception:  # noqa: BLE001
        return True      # cannot tell: respect the setting, never exceed it


async def _kv_bytes_per_token(model_name: str) -> float:
    """Learned from a live load, or the pessimistic default until there is one."""
    if model_name in _kv_learned:
        return _kv_learned[model_name]
    for m in await _resident():
        if m.get("name") != model_name:
            continue
        ctx = int((m.get("context_length") or m.get("num_ctx") or 0))
        total, weights = int(m.get("size") or 0), await _weights_bytes(model_name)
        if ctx > 0 and total and weights and total > weights:
            per = (total - weights) / ctx
            _kv_learned[model_name] = per
            log.info("local_context: %s costs ~%.0f bytes/token of KV "
                     "(measured at ctx=%d)", model_name, per, ctx)
            return per
    return _DEFAULT_KV_BYTES_PER_TOKEN


async def resolve(model: str) -> Optional[int]:
    """The num_ctx to send for `model`, or None to let ollama decide.

    `inference.ollama_num_ctx` is honoured as a CEILING rather than a value:
    an operator who has pinned it keeps that guarantee, and one who has not
    gets the largest window that measurably fits.
    """
    from app import settings_store
    if not model.startswith("ollama:"):
        return None
    setting = int(settings_store.get("inference.ollama_num_ctx") or 0)
    if not settings_store.get("inference.dynamic_context"):
        return setting or None

    name = model.split(":", 1)[1]
    now = time.monotonic()
    hit = _cache.get(name)
    if hit and hit[0] > now:
        return hit[1]

    try:
        from app import model_fitness
        caps = await model_fitness.local_capabilities(name)
        model_max = int(caps.get("context_length") or 0)
        free = await _free_vram_bytes(name)
        if not model_max or not free:
            return setting or None          # cannot measure: behave as before
        per_token = await _kv_bytes_per_token(name)
        affordable = int(free / max(per_token, 1.0))
        limits = [model_max, affordable]
        if setting and await _explicitly_set("inference.ollama_num_ctx"):
            limits.append(setting)
        if name in _ceiling:
            limits.append(_ceiling[name])
        chosen = max(_FLOOR, min(limits))
        # round down to a power-of-two-ish step; ollama reallocates the whole
        # KV cache on any change, so jittering by a few tokens per call would
        # thrash the GPU for nothing
        chosen = (chosen // 4096) * 4096 or _FLOOR
        _cache[name] = (now + _TTL_S, chosen)
        log.info("local_context: %s -> num_ctx=%d (model max %d, affordable "
                 "%d, setting %s)", name, chosen, model_max, affordable,
                 setting or "unset")
        return chosen
    except Exception:  # noqa: BLE001 — never let sizing break a call
        log.debug("local_context: falling back to the setting", exc_info=True)
        return setting or None


def cached(model: str) -> Optional[int]:
    """The last window resolved for this model, without probing anything.

    A synchronous reader for `context_trim.model_context`, which is sync and
    called from sync code. Without it the trimmer keeps sizing local models
    from the flat setting while the router hands them something else —
    exactly the disagreement between "what fits" and "what we planned for"
    that made the effective_model bug expensive. Returns None before the
    first resolve, which lands the caller on the setting: the smaller,
    safer number.
    """
    if not model.startswith("ollama:"):
        return None
    hit = _cache.get(model.split(":", 1)[1])
    return hit[1] if hit and hit[0] > time.monotonic() else None


async def note_spill(model: str) -> None:
    """After a load, check whether it spilled — and remember if it did.

    This is what makes the estimate safe to act on. ollama does not fail when
    the KV cache will not fit; it puts part of the model in system RAM and
    runs, slowly and silently. /api/ps reports both numbers, so the spill is
    a fact rather than an inference, and the next resolve() for this model
    comes back lower.
    """
    if not model.startswith("ollama:"):
        return
    name = model.split(":", 1)[1]
    for m in await _resident():
        if m.get("name") != name:
            continue
        total, vram = int(m.get("size") or 0), int(m.get("size_vram") or 0)
        if total and vram and vram < total:
            current = _cache.get(name, (0, 0))[1] or _FLOOR
            lowered = max(_FLOOR, (current * 3 // 4 // 4096) * 4096 or _FLOOR)
            _ceiling[name] = lowered
            _cache.pop(name, None)
            log.warning("local_context: %s SPILLED to system RAM (%.1fGB of "
                        "%.1fGB resident on GPU) — lowering its ceiling to "
                        "%d tokens", name, vram / 1e9, total / 1e9, lowered)
        return
