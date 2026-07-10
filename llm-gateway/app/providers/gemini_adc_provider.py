"""
Gemini ADC (Application Default Credentials) provider.

The ONE case where CLI auth transfers to service use:
  $ gcloud auth application-default login
  # or: gemini auth login (stores to same location)

The google-generativeai SDK automatically picks up credentials from:
  ~/.config/gcloud/application_default_credentials.json

No API key needed. Provides access within your Google account's free quota
(250 req/day on AI Studio free tier as of Feb 2026).

Usage in registry: set GEMINI_USE_ADC=true in .env
"""
from __future__ import annotations

import logging
from typing import AsyncIterator

from app.providers.base import ModelProvider
from nova_contracts import (
    CompleteRequest,
    CompleteResponse,
    EmbedRequest,
    EmbedResponse,
    ModelCapability,
    StreamChunk,
)

log = logging.getLogger(__name__)


class GeminiADCProvider(ModelProvider):
    """
    Google Gemini via Application Default Credentials.
    Authenticated by: gcloud auth application-default login
    Falls back to GEMINI_API_KEY if ADC fails.
    """

    def __init__(self, api_key: str = "", use_adc: bool = True):
        self._api_key = api_key
        self._use_adc = use_adc
        self._client = None

    def rekey(self, api_key: str) -> None:
        """Apply a rotated API key (FU-009). Drops the memoized client so the
        next call re-runs genai.configure with the new key."""
        self._api_key = api_key
        self._client = None

    def _get_client(self):
        if self._client is None:
            try:
                import google.generativeai as genai
                if self._use_adc and not self._api_key:
                    # ADC: SDK automatically finds ~/.config/gcloud/application_default_credentials.json
                    # No configuration needed — just call genai functions directly
                    log.info("Gemini: using Application Default Credentials (gcloud auth)")
                elif self._api_key:
                    genai.configure(api_key=self._api_key)
                    log.info("Gemini: using API key")
                self._client = genai
            except ImportError:
                raise RuntimeError(
                    "google-generativeai not installed. Run: pip install google-generativeai"
                )
        return self._client

    @property
    def name(self) -> str:
        return "gemini-adc" if self._use_adc else "gemini"

    @property
    def capabilities(self) -> set[ModelCapability]:
        return {
            ModelCapability.chat,
            ModelCapability.streaming,
            ModelCapability.vision,
            ModelCapability.embeddings,
        }

    async def complete(self, request: CompleteRequest) -> CompleteResponse:
        import asyncio
        genai = self._get_client()

        # Build Gemini message format from OpenAI-style messages
        system_content, history, last_user = _convert_messages(request.messages)

        model_kwargs: dict = {"model_name": _strip_prefix(request.model)}
        if system_content:
            model_kwargs["system_instruction"] = system_content
        model = genai.GenerativeModel(**model_kwargs)

        chat = model.start_chat(history=history)

        # Run blocking SDK call in thread pool
        response = await asyncio.to_thread(
            chat.send_message,
            last_user,
            generation_config=genai.types.GenerationConfig(
                temperature=request.temperature,
                max_output_tokens=request.max_tokens,
            ),
        )

        text = response.text
        usage = response.usage_metadata
        return CompleteResponse(
            content=text,
            model=request.model,
            tool_calls=[],
            input_tokens=usage.prompt_token_count if usage else 0,
            output_tokens=usage.candidates_token_count if usage else 0,
            cost_usd=None,  # Free tier
            finish_reason="stop",
        )

    async def stream(self, request: CompleteRequest) -> AsyncIterator[StreamChunk]:
        import asyncio
        genai = self._get_client()

        system_content, history, last_user = _convert_messages(request.messages)
        model_kwargs: dict = {"model_name": _strip_prefix(request.model)}
        if system_content:
            model_kwargs["system_instruction"] = system_content
        model = genai.GenerativeModel(**model_kwargs)
        chat = model.start_chat(history=history)

        # Gemini streaming is synchronous — wrap in thread and queue chunks
        import queue
        q: queue.Queue = queue.Queue()

        def _stream_sync():
            try:
                for chunk in chat.send_message(last_user, stream=True):
                    q.put(chunk.text)
                q.put(None)  # sentinel
            except Exception as e:
                q.put(e)

        loop = asyncio.get_event_loop()
        loop.run_in_executor(None, _stream_sync)

        while True:
            item = await asyncio.to_thread(q.get)
            if item is None:
                yield StreamChunk(delta="", finish_reason="stop")
                break
            if isinstance(item, Exception):
                raise item
            yield StreamChunk(delta=item)

    async def embed(self, request: EmbedRequest) -> EmbedResponse:
        import asyncio
        genai = self._get_client()

        # Gemini SDK expects "models/<name>" format
        model_id = request.model
        sdk_model = model_id if model_id.startswith("models/") else f"models/{model_id}"

        embeddings = []
        for text in request.texts:
            kwargs: dict = {"model": sdk_model, "content": text}
            # Truncate to requested dimensions (Matryoshka embedding support)
            if request.dimensions:
                kwargs["output_dimensionality"] = request.dimensions
            result = await asyncio.to_thread(genai.embed_content, **kwargs)
            embeddings.append(result["embedding"])

        return EmbedResponse(
            embeddings=embeddings,
            model=model_id,
            input_tokens=0,
        )


def _strip_prefix(model: str) -> str:
    """Remove 'gemini/' prefix if present — the SDK uses bare model names."""
    return model.removeprefix("gemini/")


def _convert_messages(messages) -> tuple[str, list, str]:
    """Convert OpenAI-style messages to Gemini format."""
    system_parts = []
    history = []
    last_user = ""

    for msg in messages:
        role = msg.role
        content = msg.content

        if role == "system":
            system_parts.append(content)
        elif role == "user":
            last_user = content
            if history or system_parts:
                # Only add to history if there's prior context
                pass
        elif role == "assistant":
            if last_user:
                history.append({"role": "user", "parts": [last_user]})
                history.append({"role": "model", "parts": [content]})
                last_user = ""

    return "\n\n".join(system_parts), history, last_user
