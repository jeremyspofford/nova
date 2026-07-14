"""LLM routing — resolves 'openrouter:<model>' / 'ollama:<model>' to a client."""

import logging
from typing import AsyncIterator, Optional

from app.config import settings
from app.llm.openai_compat import OpenAICompatClient

log = logging.getLogger(__name__)

_OPENROUTER_HEADERS = {
    "HTTP-Referer": "http://localhost:5173",
    "X-Title": "Nova",
}


def effective_model(model: str) -> str:
    """Swap openrouter: models to the local fallback when no real key is configured."""
    if model.startswith("openrouter:") and not settings.has_openrouter():
        from app import settings_store
        fallback = f"ollama:{settings_store.get('inference.local_fallback_model')}"
        log.info("OpenRouter not configured; %s -> %s", model, fallback)
        return fallback
    return model


def _resolve(model: str) -> tuple[OpenAICompatClient, str]:
    if model.startswith("openrouter:"):
        client = OpenAICompatClient(settings.openrouter_base_url,
                                    settings.openrouter_api_key,
                                    extra_headers=_OPENROUTER_HEADERS)
        return client, model.split(":", 1)[1]
    if model.startswith("ollama:"):
        from app import settings_store
        base = str(settings_store.get("inference.ollama_url")).rstrip("/")
        client = OpenAICompatClient(f"{base}/v1", "ollama")
        return client, model.split(":", 1)[1]
    raise ValueError(f"Unknown model format: {model!r} (expected 'openrouter:...' or 'ollama:...')")


async def stream_chat(messages: list, model: str,
                      tools: Optional[list] = None) -> AsyncIterator[dict]:
    client, model_name = _resolve(effective_model(model))
    async for event in client.stream(messages, model_name, tools):
        yield event
