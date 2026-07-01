"""SGLang inference provider -- thin wrapper over OpenAICompatibleProvider."""
from nova_contracts.llm import ModelCapability

from .openai_compatible_provider import OpenAICompatibleProvider


class SGLangProvider(OpenAICompatibleProvider):
    """Provider for SGLang OpenAI-compatible server."""

    def __init__(self, base_url: str = "http://host.docker.internal:30000"):
        super().__init__(
            base_url=base_url,
            provider_name="sglang",
            capabilities={
                ModelCapability.chat,
                ModelCapability.streaming,
                ModelCapability.embeddings,
                ModelCapability.function_calling,
                ModelCapability.structured_output,
            },
        )
