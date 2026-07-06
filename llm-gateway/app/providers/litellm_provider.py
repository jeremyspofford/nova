"""
LiteLLM provider — thin wrapper giving access to 100+ models through one interface.
Trade-off: ~500µs overhead per request, acceptable for <1000 RPS.
"""
from __future__ import annotations

import json
import logging
from typing import AsyncIterator

import litellm
from app.providers.base import ModelProvider
from app.providers.utils import serialize_messages
from nova_contracts import (
    CompleteRequest,
    CompleteResponse,
    EmbedRequest,
    EmbedResponse,
    ModelCapability,
    StreamChunk,
    ToolCall,
)

log = logging.getLogger(__name__)

litellm.drop_params = True    # ignore unsupported params per model instead of erroring
litellm.modify_params = True  # auto-add dummy tool when history has tool_use but tools= is absent


class LiteLLMProvider(ModelProvider):
    """
    Universal cloud provider adapter via LiteLLM.
    Handles Anthropic, OpenAI, Gemini, Cohere, and 100+ others.
    """

    def __init__(self, default_model: str = "claude-sonnet-4-6", label: str | None = None):
        self._default_model = default_model
        # Distinguishes per-credential instances (groq, cerebras, ...) so a
        # credential-rejection cooldown for one key never sidelines siblings
        # that happen to share this adapter class.
        self._label = label

    @property
    def name(self) -> str:
        return f"litellm-{self._label}" if self._label else "litellm"

    @property
    def capabilities(self) -> set[ModelCapability]:
        return {
            ModelCapability.chat,
            ModelCapability.streaming,
            ModelCapability.function_calling,
            ModelCapability.vision,
            ModelCapability.embeddings,
            ModelCapability.structured_output,
        }

    async def complete(self, request: CompleteRequest) -> CompleteResponse:
        messages = serialize_messages(request.messages)
        tools = [
            {
                "type": "function",
                "function": {
                    "name": t.name,
                    "description": t.description,
                    "parameters": t.parameters,
                },
            }
            for t in request.tools
        ]

        kwargs = {
            "model": request.model or self._default_model,
            "messages": messages,
            "temperature": request.temperature,
            "stream": False,
        }
        if tools:
            kwargs["tools"] = tools
        if request.max_tokens:
            kwargs["max_tokens"] = request.max_tokens

        response = await litellm.acompletion(**kwargs)
        choice = response.choices[0]
        message = choice.message

        tool_calls = []
        if hasattr(message, "tool_calls") and message.tool_calls:
            for tc in message.tool_calls:
                tool_calls.append(ToolCall(
                    id=tc.id,
                    name=tc.function.name,
                    arguments=json.loads(tc.function.arguments or "{}"),
                ))

        usage = response.usage
        cost = None
        if usage:
            try:
                cost = litellm.completion_cost(completion_response=response)
            except Exception as e:
                log.warning("cost calc failed for model=%s: %s", response.model, e)

        return CompleteResponse(
            content=message.content or "",
            model=response.model,
            tool_calls=tool_calls,
            input_tokens=usage.prompt_tokens if usage else 0,
            output_tokens=usage.completion_tokens if usage else 0,
            cost_usd=cost,
            finish_reason=choice.finish_reason or "stop",
        )

    async def stream(self, request: CompleteRequest) -> AsyncIterator[StreamChunk]:
        messages = serialize_messages(request.messages)

        response = await litellm.acompletion(
            model=request.model or self._default_model,
            messages=messages,
            temperature=request.temperature,
            max_tokens=request.max_tokens,
            stream=True,
            stream_options={"include_usage": True},
        )

        async for chunk in response:
            choice = chunk.choices[0] if chunk.choices else None
            content = ""
            finish_reason = None
            if choice:
                content = choice.delta.content or ""
                finish_reason = choice.finish_reason

            # Extract usage from final chunk (sent by LiteLLM when include_usage=True)
            input_tokens = None
            output_tokens = None
            cost = None
            usage = getattr(chunk, "usage", None)
            if usage:
                input_tokens = getattr(usage, "prompt_tokens", None)
                output_tokens = getattr(usage, "completion_tokens", None)
                try:
                    cost = litellm.completion_cost(completion_response=chunk)
                except Exception:
                    pass

            yield StreamChunk(
                delta=content,
                finish_reason=finish_reason,
                input_tokens=input_tokens,
                output_tokens=output_tokens,
                cost_usd=cost,
            )

    async def embed(self, request: EmbedRequest) -> EmbedResponse:
        response = await litellm.aembedding(
            model=request.model,
            input=request.texts,
        )
        embeddings = [item["embedding"] for item in response.data]
        return EmbedResponse(
            embeddings=embeddings,
            model=response.model,
            input_tokens=response.usage.prompt_tokens if response.usage else 0,
        )
