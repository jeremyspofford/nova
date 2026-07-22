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


def _resolve(model: str) -> tuple[OpenAICompatClient, str]:
    if ":" not in model:
        raise ValueError(f"Unknown model format: {model!r} (expected 'slug:model')")
    slug, name = model.split(":", 1)
    if slug == "ollama":
        from app import settings_store
        base = str(settings_store.get("inference.ollama_url")).rstrip("/")
        return OpenAICompatClient(f"{base}/v1", "ollama"), name
    row = providers.get(slug)
    if not row:
        raise ValueError(f"Unknown provider {slug!r} in model {model!r} "
                         f"(add it in Settings → Models → Providers)")
    return (OpenAICompatClient(row["base_url"], providers.resolve_key(row),
                               extra_headers=row["extra_headers"]),
            name)


async def stream_chat(messages: list, model: str,
                      tools: Optional[list] = None) -> AsyncIterator[dict]:
    client, model_name = _resolve(effective_model(model))
    # include_usage: exact token counts in a final usage chunk — feeds the
    # turn ledger; providers that don't support it simply omit the event
    async for event in client.stream(messages, model_name, tools,
                                     include_usage=True):
        yield event
