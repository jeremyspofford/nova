"""vLLM inference provider -- thin wrapper over OpenAICompatibleProvider."""
from nova_contracts.llm import ModelCapability

from .openai_compatible_provider import OpenAICompatibleProvider


class VLLMProvider(OpenAICompatibleProvider):
    """Provider for vLLM OpenAI-compatible server."""

    def __init__(self, base_url: str = "http://host.docker.internal:8000"):
        super().__init__(
            base_url=base_url,
            provider_name="vllm",
            capabilities={
                ModelCapability.chat,
                ModelCapability.streaming,
                ModelCapability.embeddings,
                ModelCapability.function_calling,
                ModelCapability.structured_output,
            },
        )
