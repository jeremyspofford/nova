"""llama.cpp inference provider -- thin wrapper over OpenAICompatibleProvider.

llama.cpp's server (`llama-server`) exposes an OpenAI-compatible API at /v1
including /v1/models, so the generic discovery/completion paths work as-is.
"""
from nova_contracts.llm import ModelCapability

from .openai_compatible_provider import OpenAICompatibleProvider


class LlamaCppProvider(OpenAICompatibleProvider):
    """Provider for the llama.cpp OpenAI-compatible server."""

    def __init__(self, base_url: str = "http://host.docker.internal:8080"):
        super().__init__(
            base_url=base_url,
            provider_name="llamacpp",
            capabilities={
                ModelCapability.chat,
                ModelCapability.streaming,
                ModelCapability.embeddings,
            },
        )
