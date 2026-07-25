"""LLM routing — resolves 'slug:<model>' to a client via the provider registry.

'ollama:<model>' is the built-in local provider (its URL is a runtime setting);
every other prefix names a row in the provider registry (`llm/providers.py`).
Reads are synchronous off the provider cache, so no caller had to become async.
"""

import logging
from typing import AsyncIterator, Optional

from app.llm import providers
from app.llm.openai_compat import OpenAICompatClient

log = logging.getLogger(__name__)


def effective_model(model: str) -> str:
    """Swap a cloud model to the local fallback when its provider isn't
    configured (no key, or disabled). Local (ollama) models pass through."""
    if ":" not in model:
        return model
    slug = model.split(":", 1)[0]
    if slug == "ollama":
        return model
    if not providers.is_configured(slug):
        from app import settings_store
        fallback = f"ollama:{settings_store.get('inference.local_fallback_model')}"
        log.info("provider '%s' not configured; %s -> %s", slug, model, fallback)
        return fallback
    return model


def is_local(model: str) -> bool:
    return model.split(":", 1)[0] == "ollama"


def _resolve_local(model_name: str) -> tuple["OllamaNativeClient", str]:
    """Local models go through ollama's OWN api, not its OpenAI shim.

    The shim silently drops both controls a local model needs — `think` and
    `options.num_ctx` (measured; see llm/ollama_native.py). Same event
    vocabulary out, so nothing upstream can tell the difference.
    """
    from app import settings_store
    from app.llm.ollama_native import OllamaNativeClient
    base = str(settings_store.get("inference.ollama_url")).rstrip("/")
    timeout = float(settings_store.get("inference.ollama_timeout_s") or 300)
    return OllamaNativeClient(base, timeout=timeout), model_name


def _resolve(model: str) -> tuple[OpenAICompatClient, str]:
    if ":" not in model:
        raise ValueError(f"Unknown model format: {model!r} (expected 'slug:model')")
    slug, name = model.split(":", 1)
    if slug == "ollama":
        from app import settings_store
        base = str(settings_store.get("inference.ollama_url")).rstrip("/")
        # A cold local model can take minutes to load off disk (model_warmer
        # already budgets 300s for exactly this); the blanket 120s fires
        # spuriously on the first call after a swap and reads as a dead
        # server. Applies to reads too — this is a first-byte deadline.
        timeout = float(settings_store.get("inference.ollama_timeout_s") or 300)
        return OpenAICompatClient(f"{base}/v1", "ollama", timeout=timeout), name
    row = providers.get(slug)
    if not row:
        raise ValueError(f"Unknown provider {slug!r} in model {model!r} "
                         f"(add it in Settings → Models → Providers)")
    return (OpenAICompatClient(row["base_url"], providers.resolve_key(row),
                               extra_headers=row["extra_headers"]),
            name)


async def _refuse_local_overflow(model: str, messages: list) -> Optional[dict]:
    """Refuse a local call whose prompt cannot fit, instead of letting the
    server silently drop the front of it.

    Ollama truncates an oversized prompt from the HEAD, which is where the
    system prompt lives — the agent quietly loses its role, its rails and
    its tool contract, and answers anyway. That is the worst failure shape
    there is: no error, no log line, just a worse answer.

    Measured 2026-07-24 on ollama 0.31.2: `options.num_ctx` sent to the
    OpenAI-compatible /v1 endpoint is IGNORED (probe showed n_ctx stayed at
    the server default), so per-call context sizing is not available on this
    path. The server-wide OLLAMA_CONTEXT_LENGTH is the real knob; this
    setting mirrors it so the client can refuse loudly rather than guess.
    """
    from app import settings_store
    from app.agents import context_trim
    limit = int(settings_store.get("inference.ollama_num_ctx") or 0)
    if limit <= 0:
        return None
    # leave the same completion headroom the trimmer reserves
    usable = limit - context_trim._COMPLETION_HEADROOM
    estimate = context_trim.estimate_tokens(messages)
    if estimate <= usable:
        return None
    log.error("local prompt overflow: ~%d tokens vs num_ctx %d for %s",
              estimate, limit, model)
    return {
        "type": "error",
        "error": (f"This prompt is about {estimate:,} tokens, but the local "
                  f"server is configured for {limit:,} (inference."
                  f"ollama_num_ctx). Sending it would silently truncate the "
                  f"system prompt, so the call was refused. Raise "
                  f"OLLAMA_CONTEXT_LENGTH on the ollama service and the "
                  f"matching setting, lower agents.intraturn_budget, or move "
                  f"this agent to a cloud model."),
        "error_class": "prompt_too_long", "status_code": None}


async def resolve_thinking(model: str, preference: str) -> Optional[bool]:
    """Turn an agent's auto/on/off preference into a `think` value, or None
    to send nothing at all.

    Capability comes from the SERVER (llm/capabilities.py), never from the
    model's name — a hardcoded list of which models reason is wrong the day
    a new one is pulled, and wrong silently. Three rules:

      auto            -> None. Send nothing; the model does what it does.
                         This is exactly the behavior that shipped before
                         this setting existed.
      on/off, capable -> the boolean.
      on/off, not capable (or unknown) -> None, with a log line. Asking a
                         model that cannot reason to think is not an error
                         worth failing a turn over.
    """
    if preference not in ("on", "off"):
        return None
    if not is_local(model):
        # `think` is ollama's extension; a cloud provider's reasoning
        # controls are its own and are not wired here yet
        return None
    from app.llm import capabilities
    capable = await capabilities.supports(model, "thinking")
    if capable:
        return preference == "on"
    log.info("thinking=%s ignored for %s (server reports capability: %s)",
             preference, model, capable)
    return None


async def stream_chat(messages: list, model: str,
                      tools: Optional[list] = None,
                      thinking: str = "auto") -> AsyncIterator[dict]:
    target = effective_model(model)
    think = await resolve_thinking(target, thinking)
    if is_local(target):
        refusal = await _refuse_local_overflow(target, messages)
        if refusal:
            yield refusal
            return
    if is_local(target):
        from app import settings_store
        client, model_name = _resolve_local(target.split(":", 1)[1])
        num_ctx = int(settings_store.get("inference.ollama_num_ctx") or 0)
        async for event in client.stream(messages, model_name, tools,
                                         include_usage=True, think=think,
                                         num_ctx=num_ctx or None):
            yield event
        return
    client, model_name = _resolve(target)
    # include_usage: exact token counts in a final usage chunk — feeds the
    # turn ledger; providers that don't support it simply omit the event
    async for event in client.stream(messages, model_name, tools,
                                     include_usage=True):
        yield event
