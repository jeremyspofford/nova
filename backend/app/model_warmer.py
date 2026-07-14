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

import httpx

from app import settings_store
from app.agents import registry as agent_registry
from app.llm.router import effective_model

log = logging.getLogger(__name__)

INTERVAL_SECONDS = 60
# bare ollama model name currently pinned (no provider prefix); read by the
# budget math to mark the pinned segment
state: dict = {"pinned": None}


def _base() -> str:
    return str(settings_store.get("inference.ollama_url")).rstrip("/")


async def _ping(name: str, keep_alive) -> None:
    """Empty /api/generate just (re)loads the model with the given TTL."""
    async with httpx.AsyncClient(timeout=300.0) as client:  # big models load slowly
        resp = await client.post(f"{_base()}/api/generate",
                                 json={"model": name, "keep_alive": keep_alive})
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
            await _ping(state["pinned"], "5m")  # hand back to the default TTL
            log.info("model warmer: unpinned %s", state["pinned"])
        except Exception as e:
            log.warning("model warmer: unpin of %s failed: %s", state["pinned"], e)
        state["pinned"] = None

    if target:
        try:
            if target not in await _loaded() or state["pinned"] != target:
                await _ping(target, -1)
                state["pinned"] = target
                log.info("model warmer: pinned %s (keep_alive=-1)", target)
        except Exception as e:
            log.warning("model warmer: cannot pin %s: %s", target, e)


async def loop() -> None:
    while True:
        try:
            await _tick()
        except Exception:
            log.exception("model warmer tick failed")
        await asyncio.sleep(INTERVAL_SECONDS)
