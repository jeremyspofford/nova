"""Keep the chat model warm — pins main's local model in Ollama memory.

Ollama unloads idle models after ~5 minutes, so the first chat turn after a
pause pays a multi-second reload. When inference.keep_chat_model_warm is on
and main's effective model is local, this loop pins it with keep_alive=-1
(via the native /api/generate — the OpenAI-compat endpoint has no
keep_alive), re-pins automatically after Ollama restarts, and unpins when
the setting turns off or main moves to another model. Honest limit:
Ollama's scheduler still has the last word — a pinned model can be swapped
out under heavy memory pressure from a bigger competing model.
"""

import asyncio
import logging
from typing import Optional

import httpx

from app import local_context, settings_store
from app.agents import registry as agent_registry
from app.llm.router import effective_model

log = logging.getLogger(__name__)

INTERVAL_SECONDS = 60
# bare ollama model name currently pinned (no provider prefix); read by the
# budget math to mark the pinned segment
state: dict = {"pinned": None}


def _base() -> str:
    return str(settings_store.get("inference.ollama_url")).rstrip("/")


async def _ping(name: str, keep_alive, num_ctx: Optional[int] = None) -> None:
    """Empty /api/generate just (re)loads the model with the given TTL.

    `num_ctx` has to match what the chat call will send. A load is per
    (model, window): warming at ollama's server default and then chatting at
    `local_context.resolve`'s answer loads the model twice and throws the
    first KV cache away — the whole point of warming, spent on a runner
    nothing will use. None is passed through rather than defaulted, because
    None is exactly what the chat path sends when nothing could be measured
    (`router.py`: `num_ctx or None`), and matching it is the point.
    """
    body: dict = {"model": name, "keep_alive": keep_alive}
    if num_ctx:
        body["options"] = {"num_ctx": int(num_ctx)}
    async with httpx.AsyncClient(timeout=300.0) as client:  # big models load slowly
        resp = await client.post(f"{_base()}/api/generate", json=body)
        resp.raise_for_status()


async def _loaded() -> set[str]:
    async with httpx.AsyncClient(timeout=5.0) as client:
        resp = await client.get(f"{_base()}/api/ps")
        resp.raise_for_status()
    return {m["name"] for m in resp.json().get("models", [])}


async def _tick() -> None:
    target = None
    if settings_store.get("inference.keep_chat_model_warm"):
        main = await agent_registry.get_agent_by_name("main")
        model = effective_model(main["model"]) if main else ""
        if model.startswith("ollama:"):
            target = model.split(":", 1)[1]

    if state["pinned"] and state["pinned"] != target:
        try:
            prev = state["pinned"]
            # same window it was pinned at, so unpinning re-times the runner
            # already in memory instead of loading a second one to evict it
            await _ping(prev, "5m", await local_context.resolve(f"ollama:{prev}"))
            log.info("model warmer: unpinned %s", prev)
        except Exception as e:
            log.warning("model warmer: unpin of %s failed: %s", state["pinned"], e)
        state["pinned"] = None

    if target:
        try:
            if target not in await _loaded() or state["pinned"] != target:
                num_ctx = await local_context.resolve(f"ollama:{target}")
                await _ping(target, -1, num_ctx)
                state["pinned"] = target
                log.info("model warmer: pinned %s at num_ctx=%s (keep_alive=-1)",
                         target, num_ctx or "ollama's choice")
        except Exception as e:
            log.warning("model warmer: cannot pin %s: %s", target, e)


async def loop() -> None:
    while True:
        try:
            await _tick()
        except Exception:
            log.exception("model warmer tick failed")
        await asyncio.sleep(INTERVAL_SECONDS)
