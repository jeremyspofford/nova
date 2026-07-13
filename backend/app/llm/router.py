"""LLM routing - delegates to OpenRouter or Ollama."""

import logging
from typing import AsyncIterator
from app.llm.openrouter_client import OpenRouterClient
from app.llm.ollama_client import OllamaClient
from app.config import settings

log = logging.getLogger(__name__)


async def stream_chat(messages: list, model: str, tools: list | None = None) -> AsyncIterator[dict]:
    """Stream chat response from the specified model.

    Model format: "openrouter:model-name" or "ollama:model-name"
    """
    if model.startswith("openrouter:"):
        client = OpenRouterClient(settings.openrouter_api_key)
        model_name = model.split(":", 1)[1]
        async for chunk in client.stream(messages, model_name, tools):
            yield chunk
    elif model.startswith("ollama:"):
        client = OllamaClient(settings.ollama_base_url)
        model_name = model.split(":", 1)[1]
        async for chunk in client.stream(messages, model_name, tools):
            yield chunk
    else:
        raise ValueError(f"Unknown model format: {model}")
