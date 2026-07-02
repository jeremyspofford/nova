"""Base provider for any server exposing an OpenAI-compatible API (vLLM, SGLang, etc.)."""
import asyncio
import json
import logging
import time
from typing import AsyncIterator, Optional, Set

import httpx
from nova_contracts.llm import (
    CompleteRequest,
    CompleteResponse,
    EmbedRequest,
    EmbedResponse,
    ModelCapability,
    StreamChunk,
    ToolCall,
)

from .base import ModelProvider
from .utils import extract_text_tool_calls, serialize_messages

logger = logging.getLogger(__name__)


class OpenAICompatibleProvider(ModelProvider):
    """
    Generic provider for OpenAI-compatible inference servers.

    Handles /v1/chat/completions and /v1/embeddings endpoints.
    Subclasses (VLLMProvider, SGLangProvider) just set name/capabilities.
    """

    def __init__(
        self,
        base_url: str,
        provider_name: str,
        capabilities: Optional[Set[ModelCapability]] = None,
        timeout: float = 120.0,
        extra_headers: Optional[dict[str, str]] = None,
    ):
        self._base_url = base_url.rstrip("/")
        self._name = provider_name
        self._capabilities = capabilities or {
            ModelCapability.chat,
            ModelCapability.streaming,
            ModelCapability.embeddings,
        }
        self._timeout = timeout
        self._extra_headers = extra_headers or {}
        # Start pessimistic — check_health() will flip to True when the server
        # is reachable.  This avoids a window where the catalog reports
        # "available" before the first health probe has run.
        self._healthy: bool = False
        self._health_check_interval = 15.0
        self._last_health_check = 0.0
        self._health_lock = asyncio.Lock()

    @property
    def name(self) -> str:
        return self._name

    @property
    def capabilities(self) -> Set[ModelCapability]:
        return self._capabilities

    @property
    def is_available(self) -> bool:
        return self._healthy

    @property
    def is_local(self) -> bool:
        return True

    async def check_health(self) -> bool:
        """Quick health check against the server."""
        now = time.monotonic()
        if (now - self._last_health_check) < self._health_check_interval:
            return self._healthy

        async with self._health_lock:
            # Re-check after acquiring lock (another coroutine may have updated)
            now = time.monotonic()
            if (now - self._last_health_check) < self._health_check_interval:
                return self._healthy

            try:
                async with httpx.AsyncClient(timeout=3.0, headers=self._extra_headers) as client:
                    r = await client.get(f"{self._base_url}/health")
                    self._healthy = r.status_code == 200
            except httpx.HTTPError:
                self._healthy = False

            self._last_health_check = now
            return self._healthy

    async def complete(self, request: CompleteRequest) -> CompleteResponse:
        """Send a chat completion request."""
        await self.check_health()
        self._assert_available()
        payload = self._build_chat_payload(request, stream=False)

        async with httpx.AsyncClient(timeout=self._timeout, headers=self._extra_headers) as client:
            r = await client.post(f"{self._base_url}/v1/chat/completions", json=payload)
            if r.status_code >= 400:
                logger.error("%s complete failed (%d): %s | payload keys: %s",
                             self._name, r.status_code, r.text[:300], list(payload.keys()))
            r.raise_for_status()
            data = r.json()

        choice = data["choices"][0]
        message = choice.get("message", {})
        content = message.get("content") or ""
        usage = data.get("usage", {})
        tool_calls = self._parse_tool_calls(request, message, content)
        return CompleteResponse(
            content=content,
            model=data.get("model", request.model),
            tool_calls=tool_calls,
            input_tokens=usage.get("prompt_tokens", 0),
            output_tokens=usage.get("completion_tokens", 0),
            finish_reason="tool_calls" if tool_calls else choice.get("finish_reason", "stop"),
        )

    async def stream(self, request: CompleteRequest) -> AsyncIterator[StreamChunk]:
        """Stream a chat completion response."""
        await self.check_health()
        self._assert_available()
        payload = self._build_chat_payload(request, stream=True)

        async with httpx.AsyncClient(timeout=self._timeout, headers=self._extra_headers) as client:
            async with client.stream(
                "POST", f"{self._base_url}/v1/chat/completions", json=payload
            ) as response:
                response.raise_for_status()
                async for line in response.aiter_lines():
                    if not line.startswith("data: "):
                        continue
                    data_str = line[6:]
                    if data_str.strip() == "[DONE]":
                        break

                    data = json.loads(data_str)
                    choice = data.get("choices", [{}])[0]
                    delta = choice.get("delta", {})
                    content = delta.get("content", "")

                    finish_reason = choice.get("finish_reason")
                    if content or finish_reason:
                        yield StreamChunk(
                            delta=content,
                            finish_reason=finish_reason,
                        )

    async def embed(self, request: EmbedRequest) -> EmbedResponse:
        """Generate embeddings."""
        await self.check_health()
        self._assert_available()
        payload = {
            "input": request.texts,
            "model": request.model or "default",
        }

        async with httpx.AsyncClient(timeout=self._timeout, headers=self._extra_headers) as client:
            r = await client.post(f"{self._base_url}/v1/embeddings", json=payload)
            r.raise_for_status()
            data = r.json()

        embeddings = [item["embedding"] for item in data["data"]]
        return EmbedResponse(
            embeddings=embeddings,
            model=data.get("model", request.model or "default"),
            input_tokens=data.get("usage", {}).get("prompt_tokens", 0),
        )

    def _build_chat_payload(self, request: CompleteRequest, stream: bool) -> dict:
        """Build an OpenAI-format chat completion payload.

        Uses serialize_messages so tool_calls / tool_call_id survive multi-turn
        tool conversations, and forwards tools via the standard OpenAI `tools`
        parameter that OpenAI-compatible servers (LM Studio, vLLM, SGLang)
        implement — so the model gets a real structured tool mechanism instead
        of being forced to freeform a text tool call.
        """
        payload = {
            "model": request.model,
            "messages": serialize_messages(request.messages or []),
            "stream": stream,
        }

        if request.tools:
            payload["tools"] = [
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

        if request.temperature is not None:
            payload["temperature"] = request.temperature
        if request.max_tokens is not None:
            payload["max_tokens"] = request.max_tokens

        return payload

    def _parse_tool_calls(self, request: CompleteRequest, message: dict, content: str) -> list[ToolCall]:
        """Structured OpenAI tool_calls, with a text-recovery fallback for
        models that ignore the tools param and emit a tool call as text."""
        calls: list[ToolCall] = []
        for tc in (message.get("tool_calls") or []):
            fn = tc.get("function", {})
            try:
                args = json.loads(fn.get("arguments") or "{}")
            except Exception:
                args = {}
            calls.append(ToolCall(
                id=tc.get("id") or "call_0",
                name=fn.get("name", ""),
                arguments=args if isinstance(args, dict) else {},
            ))
        if not calls and content and request.tools:
            recovered = extract_text_tool_calls(content, {t.name for t in request.tools})
            if recovered:
                logger.info("%s: recovered %d text-emitted tool call(s)", self._name, len(recovered))
                calls = recovered
        return calls
