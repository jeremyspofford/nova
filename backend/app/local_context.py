"""How much context a local model actually gets, decided per model.

THIS IS THE ONLY SOURCE OF TRUTH for a local window. `inference.ollama_num_ctx`
and `inference.dynamic_context` were deleted on 2026-07-31, along with the
`OLLAMA_CONTEXT_LENGTH` pin on the ollama service, because one number applied
to every local model was wrong in both directions at once: 16,384 starved
`ornith:9b`, which supports 262,144, while being more than a 3B needs — and
raising it to suit the biggest model put a 14B's KV cache past the end of
VRAM, where ollama does not fail but spills to system RAM and crawls. So the
setting could not be right, and getting it wrong was invisible.

Keeping it as a CEILING beside the measurement was no better: two sources of
truth for one number, where the stale one wins silently and nothing says
which applied. If a probe cannot answer, this returns None and ollama picks —
an honest absence rather than somebody's months-old guess.

Nothing here is predicted. Every input is measured from something that
already reports it:

  * the model's real ceiling            ollama /api/show  model_info
  * the weights' size on disk           ollama /api/tags  size
  * what is resident RIGHT NOW, and     ollama /api/ps    size, size_vram
    whether it SPILLED to system RAM
  * total VRAM on the box               the inference-control sidecar, via
                                        hardware.py, which is already the
                                        only thing that measures it

The KV cost per token was LEARNED here until 2026-07-31 — resident size minus
weights, divided by the window — and that subtraction is structurally wrong.
Measured on ornith:9b at ctx=16,384 it gave 13,708 bytes/token against a true
32,768, a 2.39x UNDER-estimate, because the compute buffer, the recurrent
state and the weights that stay CPU-mapped all land on the wrong side of it.
Under-estimating the cost over-estimates what fits, so the window ratcheted
to the model's ceiling in a single step — and the figure was cached for the
process lifetime, so the first bad reading was permanent. It is only accurate
once it has already gone to the top.

It is now COMPUTED, exactly, from metadata the model already publishes:

    bytes/token = full_attention_layers x head_count_kv
                  x (key_length + value_length) x 2

Verified against ollama's own `llama_kv_cache: size =` lines for every local
model on this box, to the byte: ornith:9b 8192 MiB at 262,144 cells,
qwen3:8b 5760 MiB at 40,960, qwen3:14b 2560 MiB at 16,384, qwen2.5:3b 576 MiB
at 16,384. Note the 4.5x spread between ornith:9b (32,768/token) and qwen3:8b
(147,456/token) at similar parameter counts — a single constant would be
wrong for every model but one, which is why this is derived per model.

WHAT A WINDOW COSTS IS NOT JUST ITS KV. The weights and the runtime buffers
are in the same VRAM, and this used to hand the entire free pool to the KV
cache as though they were free. On a card holding 11GB of something else that
is the difference between fitting and spilling.

EVERY DISTINCT WINDOW IS A FULL MODEL RELOAD — measured: the same prompt at
num_ctx 12,288 took 4.91s cold and 0.39s repeated, and one step to 16,384 cost
4.95s again. This container logged 372 llama-server launches across 12 window
sizes in seven days, the slowest taking 271s. So the answer is quantised to a
short LADDER rather than rounded to 4096, which permitted ~64 distinct values
and made a reload likely on any change in free VRAM.

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

# Used only when a model does not publish enough metadata to compute the real
# figure. Deliberately pessimistic — it is above every model measured here
# (the largest, qwen3:14b, is 163,840) so an unknown architecture gets a small
# window rather than a spill.
_DEFAULT_KV_BYTES_PER_TOKEN = 200_000

# f16 K and V. ollama's KV quantisation (OLLAMA_KV_CACHE_TYPE) is server-wide
# and unset here; if it were set to q8_0 this would over-state the cost, which
# is the harmless direction — a smaller window, never a spill.
_KV_BYTES_PER_ELEMENT = 2

# The compute buffer and any recurrent state, which live in VRAM alongside the
# weights and the KV cache and are reported by none of the probes. Measured on
# ornith:9b at 262,144: 344 MiB compute + 50 MiB recurrent. Rounded up.
_RUNTIME_OVERHEAD_BYTES = 512 * 1024 * 1024

# The only windows we ever ask for. Changing the window restarts llama-server,
# so the set of reachable values IS the reload budget: few and far apart beats
# a close fit. The model's own ceiling is added as the top rung, because it is
# both a natural value and a stable one.
_LADDER = (8192, 16384, 32768, 65536, 131072)

_TTL_S = 300.0
_cache: dict[str, tuple[float, int]] = {}      # model -> (expires_at, num_ctx)
_last_known: dict[str, int] = {}               # model -> the last window sized
_kv_cost: dict[str, float] = {}                # model -> bytes per token
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


def _kv_bytes_from_info(info: dict) -> Optional[int]:
    """KV bytes per token, computed from the model's own metadata.

    Keys are architecture-prefixed (`qwen3.block_count`), so the prefix is
    read from the file rather than listed here — a new architecture needs no
    edit, which is the difference between derived and maintained.
    """
    arch = str(info.get("general.architecture") or "").strip()
    if not arch:
        return None

    def field(name: str):
        return info.get(f"{arch}.{name}")

    blocks = int(field("block_count") or 0)
    kv_heads = int(field("attention.head_count_kv") or 0)
    if not blocks or not kv_heads:
        return None

    key_len, value_len = field("attention.key_length"), field("attention.value_length")
    if not key_len or not value_len:
        # Not every architecture publishes the head dimensions; where it does
        # not, they are embedding_length / head_count by definition. qwen2 is
        # the local example — 2048/16 = 128, which reproduces its measured
        # 576 MiB at 16,384.
        embedding = int(field("embedding_length") or 0)
        heads = int(field("attention.head_count") or 0)
        if not embedding or not heads:
            return None
        key_len = value_len = embedding // heads

    # Only FULL-ATTENTION layers hold a KV cache. Hybrids interleave layers
    # whose state does NOT grow with the window — ornith:9b declares 32 blocks
    # and caches 8, the other 24 being Gated Delta Net recurrent layers. Read
    # the interval rather than assuming every block caches, or its cost comes
    # out 4x too high and it never gets a usable window at all.
    interval = int(field("full_attention_interval") or 0)
    layers = blocks // interval if interval > 0 else blocks
    if layers <= 0:
        return None
    return layers * kv_heads * (int(key_len) + int(value_len)) * _KV_BYTES_PER_ELEMENT


async def _kv_bytes_per_token(model_name: str) -> float:
    """Exact where the model says enough to compute it, pessimistic otherwise.

    Cached without expiry, unlike the figure it replaced: this is a property
    of the model file, not of the state it happened to be loaded in.
    """
    if model_name in _kv_cost:
        return _kv_cost[model_name]
    shown = await _get("/api/show", {"model": model_name})
    per = _kv_bytes_from_info((shown or {}).get("model_info") or {})
    if not per:
        log.info("local_context: %s does not publish its attention shape; "
                 "assuming %d bytes/token", model_name, _DEFAULT_KV_BYTES_PER_TOKEN)
        return _DEFAULT_KV_BYTES_PER_TOKEN
    _kv_cost[model_name] = float(per)
    log.info("local_context: %s costs %d bytes/token of KV (computed)",
             model_name, per)
    return float(per)


def _quantise(chosen: int, model_max: int) -> int:
    """The largest rung that still fits, never a number in between.

    A close fit is worthless here: `chosen` moves whenever anything else on
    the GPU moves, and each distinct value is a llama-server restart. The
    rungs are far enough apart that ordinary VRAM drift does not cross one.
    """
    rungs = [r for r in (*_LADDER, model_max) if _FLOOR <= r <= chosen]
    return max(rungs) if rungs else _FLOOR


def _next_lower_rung(window: int) -> int:
    rungs = [r for r in _LADDER if r < window]
    return max(rungs) if rungs else _FLOOR


async def resolve(model: str) -> Optional[int]:
    """The num_ctx to send for `model`, or None to let ollama decide.

    THE ONLY THING THAT DECIDES. There is no setting beside this and no
    switch to turn it off: a hand-typed number and a measurement are two
    sources of truth for one value, and when they disagreed the wrong one
    won silently. `None` means every probe failed, and ollama picks — which
    is the honest answer when nothing could be measured, and a smaller
    blast radius than a stale number an operator set months ago.
    """
    if not model.startswith("ollama:"):
        return None

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
            return None                     # cannot measure: ollama decides
        per_token = await _kv_bytes_per_token(name)
        # The KV cache does not get the whole free pool: the weights sit in
        # the same VRAM, and so do the runtime buffers. Dividing free VRAM by
        # the per-token cost — as this did — overcommits by exactly the size
        # of the model, which is several GB for every model here and shows up
        # only as a silent spill. The disk size is the conservative proxy;
        # some of it stays CPU-mapped and never reaches the card.
        weights = await _weights_bytes(name) or 0
        kv_budget = free - weights - _RUNTIME_OVERHEAD_BYTES
        affordable = int(max(kv_budget, 0) / max(per_token, 1.0))
        limits = [model_max, affordable]
        if name in _ceiling:
            limits.append(_ceiling[name])
        chosen = _quantise(max(_FLOOR, min(limits)), model_max)
        needed = chosen * per_token + weights + _RUNTIME_OVERHEAD_BYTES
        if needed > free:
            # The floor won: even the smallest window worth giving does not
            # fit beside the weights. The floor is still right — a window too
            # small to hold the system prompt loses the agent its role — so
            # this says so rather than shrinking further. ollama will not
            # error; it will spill and answer slowly, and this is the moment
            # the reason is still known.
            log.warning("local_context: %s does not fit — %.1fGB needed at a "
                        "%d window, %.1fGB free. It will spill to system RAM "
                        "and run slowly.", name, needed / 1e9, chosen, free / 1e9)
        _cache[name] = (now + _TTL_S, chosen)
        _last_known[name] = chosen
        log.info("local_context: %s -> num_ctx=%d (model max %d, affordable "
                 "%d at %d B/token, weights %.1fGB, free %.1fGB)",
                 name, chosen, model_max, affordable, int(per_token),
                 weights / 1e9, free / 1e9)
        return chosen
    except Exception:  # noqa: BLE001 — never let sizing break a call
        log.debug("local_context: could not size %s; ollama decides", model,
                  exc_info=True)
        return None


async def effective_window(model: str) -> Optional[int]:
    """What this call will ACTUALLY get, for callers that must refuse.

    `resolve()` answers a different question — what we ASK for — and None
    there means "we could not measure it, so ollama chooses". That is a fine
    answer to send, and a useless one to refuse against: the overflow check
    exists because an oversized prompt is truncated from the FRONT, taking
    the system prompt with it, and letting one through on the grounds that we
    do not know the window is the failure it was written to prevent.

    So when we did not choose the window, ask ollama what it loaded. That is
    still a measurement, from the one place that knows. None only when the
    model is not resident either — nothing anywhere has a number then, and
    inventing one would be the second source of truth all over again.
    """
    asked = await resolve(model)
    if asked or not model.startswith("ollama:"):
        return asked
    name = model.split(":", 1)[1]
    for m in await _resident():
        if m.get("name") == name:
            return int(m.get("context_length") or 0) or None
    return None


def cached(model: str) -> Optional[int]:
    """The last window resolved for this model, without probing anything.

    A synchronous reader for `context_trim.model_context`, which is sync and
    called from sync code. Without it the trimmer would size a local model
    differently from what the router hands it — exactly the disagreement
    between "what fits" and "what we planned for" that made the
    effective_model bug expensive.

    Falls back to the LAST window this model was sized to when the 300s cache
    has expired. A slightly stale measurement is the right answer here: the
    alternative is None, which lands the trimmer on the full token budget and
    has it build a prompt the router then refuses. That is what the deleted
    flat setting was quietly doing for this caller, and dropping it without
    this would have made the first turn after every expiry worse, not better.
    None only before this model has ever been sized.
    """
    if not model.startswith("ollama:"):
        return None
    name = model.split(":", 1)[1]
    hit = _cache.get(name)
    if hit and hit[0] > time.monotonic():
        return hit[1]
    return _last_known.get(name)


async def warm() -> None:
    """Size every local model once, so the first turn is sized like the rest.

    `cached()` is synchronous and cannot probe, so until a model has been
    resolved once the trimmer has no window for it and aims at the full token
    budget — building a prompt the router then refuses. The deleted flat
    setting was quietly covering that, so removing it without this would make
    the first turn after every restart worse rather than better.

    Metadata probes only: no model is loaded and nothing is sent to the GPU.
    Silent when ollama is not running, which is the common case for an
    operator on cloud models.
    """
    try:
        tags = await _get("/api/tags")
        for m in (tags or {}).get("models") or []:
            if m.get("name"):
                await resolve(f"ollama:{m['name']}")
    except Exception:  # noqa: BLE001 — warming never breaks a boot
        log.debug("local_context warm-up skipped", exc_info=True)


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
            # Straight to the next rung down, not a fraction of the current
            # window: an off-ladder ceiling would be quantised away on the
            # next resolve anyway, and the reload it costs should buy a
            # window we can actually keep.
            lowered = _next_lower_rung(current)
            _ceiling[name] = lowered
            _cache.pop(name, None)
            log.warning("local_context: %s SPILLED to system RAM (%.1fGB of "
                        "%.1fGB resident on GPU) — lowering its ceiling to "
                        "%d tokens", name, vram / 1e9, total / 1e9, lowered)
        return
