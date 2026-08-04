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

# The smallest window worth ASKING FOR — not a floor to fall back to. A
# window too small to hold the system prompt is worse than a slow one,
# because ollama truncates from the HEAD and the agent quietly loses its role
# and its tool contract.
#
# It used to be returned as an answer when nothing fit, which inverted its
# meaning: on 2026-08-04 gemma4:12b and ornith:9b both computed `affordable
# 0` against a busy card and were handed 8,192 anyway — a window VRAM did not
# support, asserted as though it did. The router then refused every prompt
# over 4,192 tokens, and four of six models in that night's tournament were
# never asked a single question. Nothing fitting is now reported as None, and
# None already means "ollama decides": with OLLAMA_CONTEXT_LENGTH unset it
# applies its own VRAM-tier default and `reduceAutoNumCtxForLoadOOM` backoff,
# which is a derived answer where 8,192 was a claim.
_FLOOR = 8192

# nvidia-smi reports MiB. The sidecar divides by 1024 and calls the result
# `mem_total_gb`, so the field is GiB wearing a GB label — and every other
# consumer of it is a dashboard, where 7.3% does not show. This module does
# arithmetic against ollama's byte counts, where it does: the card reports
# 24576 MiB, which is 25.77e9 bytes, and multiplying the "GB" by 1e9 gave
# 24.0e9 — 1.77 GB of a 3090 that existed and was never offered to anybody.
_GIB = 1024 ** 3

# Leave this much VRAM unclaimed. NOT for whisper and kokoro — what they hold
# is now measured directly as `foreign` and subtracted before this, and two
# subtractions for one hazard is how a reserve gets deleted by whoever
# notices the double count. This is headroom for the allocator itself:
# fragmentation, the driver's own working set, and the gap between what
# nvidia-smi reported a moment ago and what is free when llama-server asks.
_RESERVE_GB = 2.0

# DELETED, deliberately: `_DEFAULT_KV_BYTES_PER_TOKEN = 200_000`.
#
# It was the number used when a model did not publish its attention shape,
# and it was invented rather than measured. gemma4:12b publishes
# `attention.head_count_kv: null`, so it was priced at 200,000 B/token while
# a live residency showed it costs about 17,900 — eleven times cheaper. At
# 5.7 GB free that difference is the whole answer: `affordable 0`, the floor,
# and a model that could not be graded at all.
#
# A cost we cannot compute is now MEASURED from an actual residency, and if
# we can do neither we say so and let ollama decide. A pessimistic guess is
# still a guess, and this one was wrong by an order of magnitude in the
# direction that silently disables a model.

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

# Two TTLs, because the answer's shelf life depends on WHY it is what it is.
# When VRAM was not the binding constraint the window is a property of the
# model and this turn's demand, and neither moves in five minutes. When the
# card IS the constraint the answer is a snapshot of somebody else's memory
# and should be re-taken quickly — that is the case where a game exiting, or
# another model being evicted, changes the right answer within a minute.
_TTL_OK_S = 900.0
_TTL_TIGHT_S = 60.0

# How long a spill keeps a model pinned a rung low. It used to be forever:
# `_ceiling` was written once and never cleared, so a single spill under
# transient pressure held a model down until the backend restarted, and there
# was no log line to say why the window never came back.
_SPILL_TTL_S = 1800.0

# How long a demand reading is reused. Long, because it is a 7-day maximum:
# it moves when the conversation shape moves, not turn to turn.
_DEMAND_TTL_S = 900.0

_cache: dict[str, tuple[float, int]] = {}      # model -> (expires_at, num_ctx)
_last_known: dict[str, int] = {}               # model -> the last window sized
_kv_cost: dict[str, float] = {}                # model -> bytes per token
_ceiling: dict[str, tuple[float, int]] = {}    # model -> (expires_at, post-spill cap)
_demand: dict[str, tuple[float, int]] = {}     # model -> (expires_at, tokens)


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


async def _vram() -> Optional[dict]:
    """What is on the card, split into what we can take back and what we cannot.

    WHO IS HOLDING IT IS THE WHOLE QUESTION, and the version this replaces
    never asked. It subtracted every used byte and added back only the
    model being sized, so VRAM held by ANOTHER ollama model counted as gone
    forever — and ollama's scheduler evicts a resident runner to fit the next
    one, which means that memory was always claimable.

    MEASURED, 2026-08-03 15:49. ornith:9b was resident at a 262,144 window
    (5.63 GB weights + 8.59 GB KV ≈ 14.2 GB, keep_alive 5m) when qwen3:8b was
    sized. Three re-derivations minutes apart all logged `affordable 0 ...
    free 5.2GB`, so qwen3:8b was floored at 8,192 and the turn died —
    `error_class: prompt_too_long`, 10,303 tokens against a 4,192 ceiling —
    while the memory it needed belonged to a model ollama would have evicted
    for free. ornith was holding 262,144 tokens of KV against a 30-day peak
    demand of 11,971.

    So: `foreign` (whisper, kokoro, a Windows game — anything that is not
    ollama) is subtracted, and `ollama_held` is not. Every number is real
    bytes; see `_GIB` for why that needed saying.
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
    total = int(sum(float(g.get("mem_total_gb") or 0) for g in gpus) * _GIB)
    used = int(sum(float(g.get("mem_used_gb") or 0) for g in gpus) * _GIB)
    if not total:
        return None
    # Clamped at `used`: /api/ps and nvidia-smi are two instruments read a
    # moment apart, and a model that finished loading between them would
    # otherwise produce a negative `foreign`.
    held = min(sum(int(m.get("size_vram") or 0) for m in await _resident()), used)
    return {"total": total, "used": used, "ollama_held": held,
            "foreign": max(0, used - held)}


def _claimable(vram: dict) -> int:
    """Everything except what somebody outside ollama is using, less headroom."""
    return max(0, vram["total"] - vram["foreign"] - int(_RESERVE_GB * _GIB))


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


async def _observed_kv_bytes(model_name: str) -> Optional[float]:
    """What a LIVE residency says this model costs per token.

    `/api/ps` reports `size_vram` and the `context_length` the runner was
    actually loaded at, so the cost the allocator really paid is arithmetic:
    (VRAM held - weights - runtime overhead) / window. That beats any formula
    for two cases the formula gets wrong, and it gets them wrong in the
    direction that disables a model:

      * an architecture that publishes no `attention.head_count_kv` at all
        (gemma4:12b) had no computable cost;
      * an architecture whose cache is smaller than its block count implies —
        gemma4 bounds most layers at `sliding_window`, and gemma4:e2b shares
        KV across 20 of its 35 blocks — is over-priced by roughly 3x, because
        `_kv_bytes_from_info` reads neither field.

    Returns None unless the model is resident right now with a known window —
    and a model still LOADING reports no `context_length` yet, which reads the
    same as absent and is correct: an observation nobody has finished making
    is not a number. It settles on the next probe.
    """
    for entry in await _resident():
        if entry.get("name") != model_name and entry.get("model") != model_name:
            continue
        window = int(entry.get("context_length") or 0)
        held = int(entry.get("size_vram") or 0)
        total = int(entry.get("size") or 0)
        if window <= 0 or held <= 0:
            return None
        # A SPILLED RESIDENCY IS NOT A CHEAP ONE. When part of the model sits
        # in system RAM, `size_vram` is exactly the part that did NOT need
        # VRAM, so dividing it by the window prices the model below its real
        # cost — and this figure is only ever used to decide it can afford a
        # BIGGER window. Under-pricing here is the one direction that spills
        # again, harder, so a partial offload is no observation at all.
        if total and held < total:
            log.info("local_context: ignoring %s's residency as evidence — "
                     "%.1fGB of %.1fGB is on the GPU, so what it holds there "
                     "understates what it costs", model_name,
                     held / 1e9, total / 1e9)
            return None
        weights = await _weights_bytes(model_name) or 0
        # Subtract the same overhead `resolve` budgets separately, or it is
        # counted twice — once inside the per-token figure and once beside it.
        kv = held - weights - _RUNTIME_OVERHEAD_BYTES
        if kv <= 0:
            return None
        return kv / window
    return None


async def _kv_bytes_per_token(model_name: str) -> Optional[float]:
    """Computed from the model's own metadata, corrected by observation.

    None means nobody knows — neither the file nor a residency has said — and
    `resolve` turns that into "ollama decides" rather than into a guess.

    Cached without expiry: this is a property of the model file and its
    runtime, not of the state it happened to be loaded in.
    """
    if model_name in _kv_cost:
        return _kv_cost[model_name]

    shown = await _get("/api/show", {"model": model_name})
    computed = _kv_bytes_from_info((shown or {}).get("model_info") or {})
    observed = await _observed_kv_bytes(model_name)

    if computed and observed and observed < computed:
        # An observation LOWER than the formula is evidence the formula
        # over-counted for this architecture, which is its only known failure
        # mode — it assumes every block holds a full-window f16 cache, and
        # sliding-window and shared-KV layers do not. An observation HIGHER
        # is not trusted the same way: it may just be a fuller card, and
        # over-claiming capacity is the direction that spills.
        _kv_cost[model_name] = float(observed)
        log.info("local_context: %s costs %d bytes/token (observed live; the "
                 "metadata formula said %d, which over-counts layers whose "
                 "cache does not grow with the window)",
                 model_name, observed, computed)
        return float(observed)

    per = computed or observed
    if not per:
        log.warning("local_context: %s publishes no attention shape and has "
                    "never been observed resident, so its per-token cost is "
                    "unknown — leaving the window to ollama", model_name)
        return None
    _kv_cost[model_name] = float(per)
    log.info("local_context: %s costs %d bytes/token of KV (%s)",
             model_name, per, "computed" if computed else "observed live")
    return float(per)


async def _demand_tokens(model: str) -> int:
    """The largest prompt this model has actually been asked to hold, in a week.

    CAPACITY WAS THE ONLY INPUT until now, so a model took every token that
    fit whether or not anything wanted them: ornith:9b ran at 262,144 against
    a measured peak of 11,971, and the 250,000 tokens of KV cache it held for
    nothing were exactly what starved the next model to load.

    Read from `prompt_tokens_est_fixed`, NOT from `prompt_tokens_est`. The
    difference is the feedback loop, and it is not theoretical:
    `history_budget_for` is 35% of the window, so a bigger window replays
    more history, which inflates `prompt_tokens_est`, which is what this
    would max over — each rung buying the next one until `_HISTORY_MAX` or
    the model's ceiling stopped it. The `_fixed` field excludes replayed
    history for that reason, and the history budget is added back at resolve
    time, where it is a function of the window rather than a memory of it.

    Zero on any failure: no reading means no demand-side opinion, and the
    capacity side still answers.
    """
    now = time.monotonic()
    hit = _demand.get(model)
    if hit and hit[0] > now:
        return hit[1]
    value = 0
    try:
        from app import db
        async with db.acquire() as conn:
            value = int(await conn.fetchval(
                """SELECT max((detail->>'prompt_tokens_est_fixed')::int)
                     FROM turn_spans
                    WHERE kind = 'llm_call' AND name = $1
                      AND detail ? 'prompt_tokens_est_fixed'
                      AND started_at > now() - interval '7 days'""",
                model) or 0)
    except Exception:  # noqa: BLE001 — a missing reading is not a failed turn
        log.debug("local_context: no demand history for %s", model, exc_info=True)
    _demand[model] = (now + _DEMAND_TTL_S, value)
    return value


def _want_rung(demand: int, model_max: int) -> int:
    """The smallest window that holds this model's measured demand.

    Demand rounds UP where capacity rounds DOWN, and the asymmetry is the
    point: rounding demand down sizes a model just under what it is known to
    be asked for, which is the refusal this module exists to avoid.

    A window has to hold more than the demand reading, because the reading
    deliberately excludes replayed history (see `_demand_tokens`) and the
    trimmer will replay some. How much is a fraction OF THE WINDOW — so the
    test is applied to each candidate rung against the history THAT rung
    would allow, and the first rung that passes wins. Deriving it from the
    previous window instead would let each answer justify the next one:
    with nothing cached, `history_budget_for` reads the 60,000-token
    unknown-window default and hands back its 24,000 cap, which alone would
    push a first sizing two rungs past anything measured.

    Zero demand means no reading, which is not the same as a small one: it
    returns the model's ceiling, so capacity decides alone and the behaviour
    is exactly what it was before demand existed.
    """
    if demand <= 0:
        return model_max
    from app.agents import context_trim
    for rung in sorted({*_LADDER, model_max}):
        if rung < _FLOOR:
            continue
        # the trimmer's own arithmetic, applied to this candidate: what a
        # prompt may occupy at `rung`, and what history it would replay there
        usable = max(2000, rung - context_trim._COMPLETION_HEADROOM)
        if usable >= demand + context_trim.history_budget_at(usable):
            return rung
    return model_max


def _spill_pin(name: str) -> Optional[int]:
    """The post-spill cap, if it has not expired — and drop it if it has."""
    pin = _ceiling.get(name)
    if not pin:
        return None
    if pin[0] > time.monotonic():
        return pin[1]
    _ceiling.pop(name, None)
    log.info("local_context: %s's spill ceiling expired; re-deriving its window",
             name)
    return None


def _quantise(chosen: int, model_max: int) -> Optional[int]:
    """The largest rung that still fits, never a number in between.

    A close fit is worthless here: `chosen` moves whenever anything else on
    the GPU moves, and each distinct value is a llama-server restart. The
    rungs are far enough apart that ordinary VRAM drift does not cross one.

    None when NOTHING fits — not `_FLOOR`. Returning the floor there answered
    a question about capacity with a constant, and the constant was wrong
    often enough to matter: it is what turned a busy card into four models
    that could not be graded. The caller's contract already has a word for
    "we cannot size this", and ollama's own backoff is better at it than a
    number we made up.
    """
    rungs = [r for r in (*_LADDER, model_max) if _FLOOR <= r <= chosen]
    return max(rungs) if rungs else None


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
        vram = await _vram()
        if not model_max or not vram:
            return None                     # cannot measure: ollama decides
        per_token = await _kv_bytes_per_token(name)
        if not per_token:
            return None                     # cannot price it: ollama decides
        # The KV cache does not get the whole claimable pool: the weights sit
        # in the same VRAM, and so do the runtime buffers. Dividing free VRAM
        # by the per-token cost — as this did — overcommits by exactly the
        # size of the model, which is several GB for every model here and
        # shows up only as a silent spill. The disk size is the conservative
        # proxy; some of it stays CPU-mapped and never reaches the card.
        weights = await _weights_bytes(name) or 0
        kv_budget = _claimable(vram) - weights - _RUNTIME_OVERHEAD_BYTES
        affordable = int(max(kv_budget, 0) / max(per_token, 1.0))

        # WHAT IS WANTED, rounded up...
        demand = await _demand_tokens(model)
        want_rung = _want_rung(demand, model_max)

        # ...and what fits, rounded down.
        limits = [model_max, affordable]
        pin = _spill_pin(name)
        if pin:
            limits.append(pin)
        # No `max(_FLOOR, ...)`: raising a capacity of nothing up to 8,192 is
        # the same assertion `_quantise` used to make, one line earlier.
        cap_rung = _quantise(min(limits), model_max)
        if cap_rung is None:
            log.warning(
                "local_context: %s does not fit at any window we would ask "
                "for — %d tokens affordable (%d B/token, weights %.1fGB, "
                "%.1fGB claimable, %.1fGB held outside ollama). Leaving the "
                "window to ollama, which will back off on its own rather "
                "than be told a size that does not fit.",
                name, affordable, int(per_token), weights / 1e9,
                _claimable(vram) / 1e9, vram["foreign"] / 1e9)
            return None

        chosen = min(want_rung, cap_rung)
        # Only with a READING. With none, `_want_rung` returns the model's
        # ceiling to mean "no opinion", and comparing that against capacity
        # calls every model starved on a fresh install — a warning that fires
        # when nothing is wrong is one nobody reads when something is.
        starved = bool(demand) and want_rung > cap_rung
        if starved:
            # Not "does not fit" — it fits, at a window smaller than this
            # model is known to be asked for. Naming both sides is the
            # difference between an operator quitting a game and an operator
            # reading a log line about bytes. ollama will not error; it
            # answers, and the router refuses the turns that overflow.
            log.warning(
                "local_context: %s is STARVED — a %d window would hold its "
                "measured demand (%d tokens + headroom), but only %d fits: "
                "%.1fGB claimable, %.1fGB held outside ollama, %.1fGB held by "
                "ollama itself (evictable).",
                name, want_rung, demand, cap_rung, _claimable(vram) / 1e9,
                vram["foreign"] / 1e9, vram["ollama_held"] / 1e9)
        _cache[name] = (now + (_TTL_TIGHT_S if starved else _TTL_OK_S), chosen)
        _last_known[name] = chosen
        log.info("local_context: %s -> num_ctx=%d (model max %d, demand %d, "
                 "affordable %d at %d B/token, weights %.1fGB, claimable "
                 "%.1fGB, foreign %.1fGB)",
                 name, chosen, model_max, demand, affordable, int(per_token),
                 weights / 1e9, _claimable(vram) / 1e9, vram["foreign"] / 1e9)
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


_WARM_INTERVAL_S = 300.0


async def warm_loop() -> None:
    """Keep retrying `warm()` — the boot probe is allowed to fail.

    `cached()` falls through to `_last_known`, which never expires, so it
    returns None only when `resolve()` has NEVER succeeded in this process.
    A single warm at startup therefore had one chance: if ollama was
    restarting, every local model kept the 60,000-token unknown-window
    default for the lifetime of the backend, and the trimmer built prompts
    the router then refused. MEASURED at 34 spans over two days.

    So the point is the RETRY, not the cadence. Five minutes is simply cheap:
    metadata probes only, no model is loaded, and it is silent when ollama is
    not running at all.
    """
    import asyncio
    while True:
        try:
            await warm()
        except asyncio.CancelledError:
            raise
        except Exception:  # noqa: BLE001
            log.debug("local_context warm loop tick failed", exc_info=True)
        await asyncio.sleep(_WARM_INTERVAL_S)


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
            # WITH AN EXPIRY. Written once and never cleared, one spill under
            # transient pressure — a game, another model mid-load — pinned the
            # model a rung low until the backend restarted, and nothing said
            # why the window never came back. The pressure that caused a spill
            # is exactly the kind of thing that goes away.
            _ceiling[name] = (time.monotonic() + _SPILL_TTL_S, lowered)
            _cache.pop(name, None)
            log.warning("local_context: %s SPILLED to system RAM (%.1fGB of "
                        "%.1fGB resident on GPU) — capping it at %d tokens for "
                        "the next %d minutes", name, vram / 1e9, total / 1e9,
                        lowered, int(_SPILL_TTL_S // 60))
        return
